import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';
import { READABILITY_CAP_GUARDS } from '../lib/rule-token-budget.mjs';

// Derived from the registry so a cap change does not silently strand these fixtures.
const AGENTS_HARD_CAP_BYTES = READABILITY_CAP_GUARDS['AGENTS.md'];

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(TEST_DIR, '../pre-pr-archive-gate.mjs');
const PRODUCTION_POLICY = path.resolve(TEST_DIR, '../lib/rule-token-budget.mjs');

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout.trim();
}

function write(repo, repoPath, body) {
  const target = path.join(repo, repoPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function setupRepo(seed = {}) {
  const repo = makeTempDir('objective-rule-token-gate-');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  write(repo, 'README.md', 'fixture\n');
  for (const [repoPath, body] of Object.entries(seed)) write(repo, repoPath, body);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'baseline');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function runGate(repo, env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.DEVPRO_PR_TOUCHES_RULE_FILE;
  delete cleanEnv.DEVPRO_PR_TOUCHED_RULE_FILES;
  delete cleanEnv.DEVPRO_SCENARIO_DIFF_BASELINE_REF;
  return spawnSync('node', [GATE, repo], {
    encoding: 'utf8',
    env: { ...cleanEnv, ...env },
  });
}

function createFakeGitHarness() {
  const root = makeTempDir('objective-rule-token-fake-git-');
  const log = path.join(root, 'git-probes.jsonl');
  const preload = path.join(root, 'git-probe-preload.mjs');
  writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (executable, args, options) => {
  if (executable !== 'git') return realSpawnSync(executable, args, options);
  const command = args[0] === '-C' ? args.slice(2) : args;
  let label = 'other';
  if (command[0] === 'rev-parse' && command.includes('--is-inside-work-tree')) label = 'worktree';
  else if (command[0] === 'rev-parse') label = 'baseline';
  else if (command[0] === 'ls-files' && command.includes('--others')) label = 'untracked';
  else if (command[0] === 'merge-base') label = 'merge-base';
  else if (command[0] === 'diff' && command.includes('--cached')) label = 'staged';
  else if (command[0] === 'diff' && command.some((value) => value.includes('origin/main...HEAD'))) label = 'committed';
  else if (command[0] === 'diff' && command.some((value) => /^[0-9a-f]{40,64}$/i.test(value))) label = 'net-tracked';
  else if (command[0] === 'diff') label = 'unstaged';
  appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ label, command }) + '\\n');
  if (label === process.env.FAKE_GIT_FAIL_LABEL) return { status: 41, stdout: '', stderr: 'injected Git probe failure' };
  if (label === 'untracked' && process.env.FAKE_GIT_UNTRACKED_PATH) {
    return { status: 0, stdout: process.env.FAKE_GIT_UNTRACKED_PATH + '\\0', stderr: '' };
  }
  return realSpawnSync(executable, args, options);
};
syncBuiltinESMExports();
`);
  return {
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' '),
      FAKE_GIT_LOG: log,
    },
    log,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withRepo(seed, action) {
  const repo = setupRepo(seed);
  try {
    action(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('known-empty scope is deterministic and independent of archive existence', () => {
  withRepo({}, (repo) => {
    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^scope=known-empty; checked=0; verdict=pass$/m);
    assert.match(result.stdout, /no openspec\/changes dir/);
  });
});

test('scenario-diff baseline override cannot change the objective token baseline', () => {
  withRepo({}, (repo) => {
    write(repo, 'AGENTS.md', 'objective bytes\n');
    const result = runGate(repo, {
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: '--not-a-token-baseline',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rule-token-budget path=AGENTS\.md; status=\?; bytes=16;/);
    assert.match(result.stdout, /scope=known-nonempty; checked=1; verdict=pass/);
    assert.doesNotMatch(result.stderr, /baseline ref has invalid shape/);
  });
});

test('authoritative manifest covers committed, staged, unstaged, untracked, and deleted carriers', () => {
  withRepo({
    'AGENTS.md': 'baseline\n',
    '.devpro/agent-rules/unstaged.md': 'baseline\n',
    '.devpro/agent-rules/deleted.md': 'baseline\n',
  }, (repo) => {
    write(repo, 'AGENTS.md', 'committed\n');
    git(repo, 'add', 'AGENTS.md');
    git(repo, 'commit', '-m', 'committed carrier');

    write(repo, '.devpro/agent-rules/staged.md', 'staged\n');
    git(repo, 'add', '.devpro/agent-rules/staged.md');
    write(repo, '.devpro/agent-rules/unstaged.md', 'unstaged\n');
    write(repo, '.devpro/agent-rules/untracked.md', 'untracked\n');
    unlinkSync(path.join(repo, '.devpro/agent-rules/deleted.md'));

    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /path=AGENTS\.md; status=M;/);
    assert.match(result.stdout, /path=\.devpro\/agent-rules\/staged\.md; status=A;/);
    assert.match(result.stdout, /path=\.devpro\/agent-rules\/unstaged\.md; status=M;/);
    assert.match(result.stdout, /path=\.devpro\/agent-rules\/untracked\.md; status=\?;/);
    assert.match(result.stdout, /path=\.devpro\/agent-rules\/deleted\.md; status=D; bytes=deleted; tokens=deleted;/);
    assert.match(result.stdout, /scope=known-nonempty; checked=5; verdict=pass/);
  });
});

test('net manifest measures a committed then unstaged carrier exactly once using final bytes', () => {
  withRepo({ 'AGENTS.md': 'baseline\n' }, (repo) => {
    write(repo, 'AGENTS.md', 'committed\n');
    git(repo, 'add', 'AGENTS.md');
    git(repo, 'commit', '-m', 'committed carrier update');
    write(repo, 'AGENTS.md', 'final worktree bytes\n');

    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    const records = result.stdout.match(/^rule-token-budget path=AGENTS\.md;.*$/gm) ?? [];
    assert.equal(records.length, 1, `expected one final-carrier record\n${result.stdout}`);
    assert.match(records[0], /status=M; bytes=21;/);
    assert.match(result.stdout, /scope=known-nonempty; checked=1; verdict=pass/);
  });
});

test('net manifest coalesces tracked deletion plus same-path untracked recreation into one final modification', () => {
  withRepo({ '.devpro/agent-rules/recreated.md': 'baseline\n' }, (repo) => {
    git(repo, 'rm', '--cached', '.devpro/agent-rules/recreated.md');
    write(repo, '.devpro/agent-rules/recreated.md', 'final recreated bytes\n');

    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    const records = result.stdout.match(/^rule-token-budget path=\.devpro\/agent-rules\/recreated\.md;.*$/gm) ?? [];
    assert.equal(records.length, 1, `expected one composed final record\n${result.stdout}`);
    assert.match(records[0], /status=M; bytes=22;/);
    assert.match(records[0], /reason=none; verdict=pass/);
    assert.match(result.stdout, /scope=known-nonempty; checked=1; verdict=pass/);
  });
});

test('exact carrier assertion is only a bidirectional equality assertion', () => {
  withRepo({}, (repo) => {
    write(repo, '.devpro/agent-rules/touched.md', 'objective bytes\n');
    const pass = runGate(repo, {
      DEVPRO_PR_TOUCHED_RULE_FILES: '.devpro/agent-rules/touched.md',
    });
    assert.equal(pass.status, 0, pass.stderr);

    const mismatch = runGate(repo, {
      DEVPRO_PR_TOUCHED_RULE_FILES: '.devpro/agent-rules/other.md',
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /not bidirectionally equal/);
    assert.match(mismatch.stderr, /missing=.*touched\.md/);
    assert.match(mismatch.stderr, /extra=.*other\.md/);
  });
});

test('exact carrier assertion rejects malformed and duplicate paths', () => {
  withRepo({}, (repo) => {
    write(repo, '.devpro/agent-rules/touched.md', 'objective bytes\n');
    const malformed = runGate(repo, {
      DEVPRO_PR_TOUCHED_RULE_FILES: '/.devpro/agent-rules/touched.md',
    });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /contains invalid exact carrier path/);

    const duplicate = runGate(repo, {
      DEVPRO_PR_TOUCHED_RULE_FILES: '.devpro/agent-rules/touched.md,.devpro/agent-rules/touched.md',
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /repeats \.devpro\/agent-rules\/touched\.md/);
  });
});

test('committed, staged, unstaged, and untracked probes all execute before any one failure returns unknown', () => {
  withRepo({}, (repo) => {
    for (const failedProbe of ['committed', 'staged', 'unstaged', 'untracked']) {
      const harness = createFakeGitHarness();
      try {
        const result = runGate(repo, { ...harness.env, FAKE_GIT_FAIL_LABEL: failedProbe });
        assert.equal(result.status, 1, `${failedProbe} must fail closed`);
        assert.match(result.stderr, new RegExp(`${failedProbe} probe failed`));
        const observed = readFileSync(harness.log, 'utf8')
          .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).label);
        for (const required of ['committed', 'staged', 'unstaged', 'untracked']) {
          assert.ok(observed.includes(required), `${required} was hidden after ${failedProbe} failed: ${observed.join(',')}`);
        }
      } finally {
        harness.cleanup();
      }
    }
  });
});

test('missing non-delete final carrier blocks with exact path and non-sensitive reason code', () => {
  withRepo({}, (repo) => {
    const harness = createFakeGitHarness();
    try {
      const missing = '.devpro/agent-rules/missing-final.md';
      const result = runGate(repo, { ...harness.env, FAKE_GIT_UNTRACKED_PATH: missing });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /path=\.devpro\/agent-rules\/missing-final\.md;/);
      assert.match(result.stdout, /reason=read-error:ENOENT; verdict=block/);
      assert.doesNotMatch(result.stdout, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      harness.cleanup();
    }
  });
});

test('legacy boolean override fails closed', () => {
  withRepo({}, (repo) => {
    const result = runGate(repo, { DEVPRO_PR_TOUCHES_RULE_FILE: '0' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy DEVPRO_PR_TOUCHES_RULE_FILE boolean override is unsupported/);
  });
});

test('unknown Git scope fails closed before any archive pass-through', () => {
  const dir = makeTempDir('objective-rule-token-no-git-');
  try {
    const result = runGate(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /worktree probe failed/);
    assert.doesNotMatch(result.stdout, /Pre-PR archive gate: pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing baseline probe fails closed even when the worktree probe succeeds', () => {
  const repo = makeTempDir('objective-rule-token-no-baseline-');
  try {
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'user.name', 'Fixture');
    write(repo, 'README.md', 'fixture\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    const result = runGate(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /baseline probe failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('actual cap breach soft-warns with cap-pressure=over and exits 0', () => {
  withRepo({}, (repo) => {
    const overCap = AGENTS_HARD_CAP_BYTES + 1;
    write(repo, 'AGENTS.md', 'x'.repeat(overCap));
    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`path=AGENTS.md; status=?; bytes=${overCap};`), result.stdout);
    assert.match(result.stdout, /verdict=pass/);
    assert.match(result.stdout, /reason=none/);
    assert.match(result.stderr, /cap-pressure=over/);
    assert.match(result.stderr, /path="AGENTS\.md"/);
    assert.doesNotMatch(result.stderr, /objective carrier measurement blocked/);
  });
});

test('soft-warn over-cap output is bounded to top-N paths', () => {
  withRepo({}, (repo) => {
    // 12 over-cap unregistered carriers → soft-warn shows at most TOP_N=10 paths.
    for (let i = 0; i < 12; i += 1) {
      write(repo, `.devpro/agent-rules/over-cap-${String(i).padStart(2, '0')}.md`, 'x'.repeat(5251));
    }
    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /soft-warn cap-pressure=over count=12 showing=10 truncated=true omitted=2 bytes=\d+/);
    const pathLines = (result.stderr.match(/^soft-warn cap-pressure=over path=/gm) ?? []).length;
    assert.equal(pathLines, 10);
  });
});

test('>=80% utilization is only semanticReview=required and remains machine-pass', () => {
  withRepo({}, (repo) => {
    write(repo, 'AGENTS.md', 'x'.repeat(AGENTS_HARD_CAP_BYTES * 0.8));
    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /utilization=80; registry=pass; guard=pass; reason=none; verdict=pass; semanticReview=required/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /semantic(?:Verdict| verdict)=/i);
  });
});

test('generic proposal keywords neither trigger carrier scope nor supply measurements', () => {
  withRepo({}, (repo) => {
    write(repo, 'notes/proposal.md',
      'delete merge rationalize Token Budget Check 999999 token Readability Precheck\n');
    const result = runGate(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^scope=known-empty; checked=0; verdict=pass$/m);
    assert.doesNotMatch(result.stdout, /rule-token-budget path=/);
  });
});

test('production policy module is the gate SSOT and never imports test code', () => {
  const gateSource = readFileSync(GATE, 'utf8');
  const policySource = readFileSync(PRODUCTION_POLICY, 'utf8');
  assert.match(gateSource, /from '\.\/lib\/rule-token-budget\.mjs'/);
  assert.doesNotMatch(gateSource, /rule-token-budget\.test\.mjs/);
  assert.doesNotMatch(policySource, /scripts\/tests|\.test\.mjs|spawnSync|execSync/);
  for (const symbol of ['BYTES_PER_TOKEN', 'TIERS', 'PER_FILE_MAX_OVERRIDE', 'READABILITY_CAP_GUARDS']) {
    assert.match(policySource, new RegExp(`export const ${symbol}\\b`));
  }
});
