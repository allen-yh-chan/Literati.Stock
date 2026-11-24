/**
 * pre-pr-archive-gate-cadence-batched.test.mjs
 *
 * fix-hook-gate-server-block (Fix A) prove-it + pinned semantics
 * (design.md D1–D4, D7 of that change):
 *
 *   - prove-it subprocess-count convergence: (f) cadence on an N-archive
 *     fixture repo runs ≤3 cadence-related git subprocesses. Pre-fix the
 *     per-archive fan-out runs ≈4×(N+1) — the assertion is RED until the
 *     batched three-walk index lands.
 *   - pinned unknown strings: merge-commit / uncommitted / root-only
 *     introduction keep the byte-identical `introduction commit is not
 *     unique-parent for <name>` / `introduction commit missing for <name>`
 *     advisory messages.
 *   - F-1-1 whole-commit entries equivalence (`--full-diff` guard): governance
 *     D/M entries in the introduction commit still reach
 *     classifyBoundedTopology; active→archive `git mv` rename introductions
 *     hit the qualifier via newPath-under-dir and classify non-trigger.
 *   - newest-add pin (Decision Boundary 2): a multi-add archive's introduction
 *     is the newest single-parent add commit, not the first-ever commit.
 *   - wall-clock scaled fixture (skip in CI): N≈500 archives pass path <10s.
 *
 * The child-only Git preload logs every Git invocation and forwards to the
 * real Git, so cadence-related subprocess counts remain observable without
 * depending on POSIX executable wrappers on Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(TEST_DIR, '../pre-pr-archive-gate.mjs');

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout.trim();
}

function writeRepoFile(repo, repoPath, body) {
  const target = path.join(repo, repoPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function createCadenceRepo() {
  const dir = makeTempDir('gate-f-cadence-batched-');
  git(dir, 'init', '-q', '-b', 'main');
  // Short-lived fixtures must not race detached maintenance against commits or cleanup.
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'Fixture');
  writeRepoFile(dir, '.devpro/scripts/pre-pr-archive-gate.mjs', '');
  writeRepoFile(dir, '.devpro/agent-rules/rule-audit-playbook.md', '# source sentinel\n');
  for (let index = 1; index <= 30; index += 1) {
    writeRepoFile(dir, `.devpro/agent-rules/cadence-rule-${index}.md`, `# Cadence ${index}\n`);
  }
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');
  writeRepoFile(dir, 'README.md', '# cadence fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'fixture seed');
  return dir;
}

function commitArchiveProposal(repo, archiveName, { carrierIndex = null } = {}) {
  writeRepoFile(
    repo,
    `openspec/changes/archive/${archiveName}/proposal.md`,
    '# Proposal\n\nCadence batched fixture.\n'
  );
  if (carrierIndex !== null) rmSync(path.join(repo, `.devpro/agent-rules/cadence-rule-${carrierIndex}.md`));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `archive ${archiveName}`);
}

function finalizeCadenceRepo(repo) {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

function runGate(repo, env = {}) {
  return spawnSync('node', [GATE, repo], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_RELEVANT_ARCHIVES: '',
      DEVPRO_DIFF_ACTIVE_CHANGES: '',
      DEVPRO_PR_TOUCHED_RULE_FILES: '',
      ...env,
    },
  });
}

function withRepo(fn) {
  const dir = createCadenceRepo();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── fake-git counting harness (token-budget test pattern) ─────────────────

function createFakeGitHarness() {
  const root = makeTempDir('cadence-batched-fake-git-');
  const log = path.join(root, 'git-probes.jsonl');
  const preload = path.join(root, 'git-count-preload.mjs');
  writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === 'git') {
    const gitArgs = args[0] === '-C' ? args.slice(2) : args;
    appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ command: gitArgs }) + '\\n');
  }
  return realSpawnSync(command, args, options);
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

/**
 * Fake-git harness that answers the (f) cadence main walk with a crafted -z
 * stdout (from a temp file — env vars cannot carry NUL bytes) and forwards
 * every other git invocation to the real git. Used by the F-fhgb-r1-03
 * crafted-stream drift test.
 */
function createCraftedLogHarness(craftedLog) {
  const root = makeTempDir('cadence-batched-crafted-log-');
  const craftedFile = path.join(root, 'crafted-log.bin');
  writeFileSync(craftedFile, craftedLog);
  const preload = path.join(root, 'crafted-log-preload.mjs');
  writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === 'git') {
    const gitArgs = args[0] === '-C' ? args.slice(2) : args;
    if (gitArgs[0] === 'log' && gitArgs.includes('--full-history') && gitArgs.includes('--full-diff')) {
      return { status: 0, stdout: readFileSync(process.env.CRAFTED_LOG_FILE, 'utf8'), stderr: '' };
    }
  }
  return realSpawnSync(command, args, options);
};
syncBuiltinESMExports();
`);
  return {
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' '),
      CRAFTED_LOG_FILE: craftedFile,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const SHA_RE = /^[0-9a-f]{40,64}$/i;

/**
 * Count git invocations attributable to the (f) cadence introduction lookup,
 * covering both implementations:
 *   - batched (post-fix): log --full-history main walk, log --full-history
 *     --merges fallback walk, rev-list --parents HEAD graph
 *   - per-archive fan-out (pre-fix): log --reverse history, rev-list
 *     --parents -n 1, diff --name-status parent..sha, merge-base --is-ancestor
 * Other lettered checks use different arg shapes and must not be counted.
 */
function cadenceSubprocessCount(logText) {
  const calls = String(logText)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).command);
  let count = 0;
  for (const command of calls) {
    const [sub, ...rest] = command;
    if (sub === 'log' && rest.includes('--full-history')) count += 1;
    else if (sub === 'log' && rest.includes('--reverse')) count += 1;
    else if (sub === 'rev-list' && rest.includes('--parents') && rest.includes('HEAD') && !rest.includes('-n')) count += 1;
    else if (sub === 'rev-list' && rest.includes('--parents') && rest.includes('-n')) count += 1;
    else if (sub === 'merge-base' && rest.includes('--is-ancestor')) count += 1;
    else if (sub === 'diff' && rest.includes('--name-status') && rest.filter((arg) => SHA_RE.test(arg)).length >= 2) count += 1;
  }
  return count;
}

// ── prove-it: subprocess-count convergence (T1(a), RED pre-fix) ───────────

test('prove-it: (f) cadence runs ≤3 cadence-related git subprocesses for N archives (O(1) fan-out)', () => {
  const dir = createCadenceRepo();
  const harness = createFakeGitHarness();
  try {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    for (let index = 1; index <= 6; index += 1) {
      commitArchiveProposal(dir, `2026-08-0${index}-plain-${index}`);
    }
    finalizeCadenceRepo(dir);
    const result = runGate(dir, harness.env);
    assert.equal(result.status, 0, `gate must pass\nstderr: ${result.stderr}`);
    const count = cadenceSubprocessCount(readFileSync(harness.log, 'utf8'));
    assert.ok(
      count <= 3,
      `(f) cadence must converge to ≤3 git subprocesses (batched index); ran ${count}`
    );
  } finally {
    harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prove-it: N archives with trigger deletions stay O(1) and warn verbatim (F-1-1(a) --full-diff guard)', () => {
  const dir = createCadenceRepo();
  const harness = createFakeGitHarness();
  try {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    for (let index = 1; index <= 5; index += 1) {
      commitArchiveProposal(dir, `2026-08-0${index}-gov-delete-${index}`, { carrierIndex: index });
    }
    finalizeCadenceRepo(dir);
    const result = runGate(dir, harness.env);
    assert.equal(result.status, 0, `cadence warning must not block\nstderr: ${result.stderr}`);
    // Without --full-diff the whole-commit governance D entries would vanish
    // from the classifier input and this warning would never fire.
    assert.match(result.stderr, /已累積 5 個 chore B（≥ 5 觸發警告）/);
    const count = cadenceSubprocessCount(readFileSync(harness.log, 'utf8'));
    assert.ok(count <= 3, `trigger cadence must stay ≤3 git subprocesses; ran ${count}`);
  } finally {
    harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── pinned unknown strings (D4 divergence ledger) ─────────────────────────

test('pinned: merge-commit introduction stays "not unique-parent"', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    git(dir, 'checkout', '-q', '-b', 'side');
    writeRepoFile(dir, 'side.txt', 'side\n');
    git(dir, 'add', 'side.txt');
    git(dir, 'commit', '-q', '-m', 'side commit');
    git(dir, 'checkout', '-q', 'main');
    writeRepoFile(dir, 'main.txt', 'main\n');
    git(dir, 'add', 'main.txt');
    git(dir, 'commit', '-q', '-m', 'main commit');
    git(dir, 'merge', '--no-ff', '--no-commit', 'side');
    writeRepoFile(dir, 'openspec/changes/archive/2026-07-29-merge-introduction/proposal.md', '# Proposal\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'merge with archive introduction');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `multi-parent introduction remains advisory\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /introduction commit is not unique-parent for 2026-07-29-merge-introduction/);
    assert.match(result.stderr, /no count\/reset or below-threshold claim/);
    assert.doesNotMatch(result.stderr, /已累積/);
  });
});

test('pinned: uncommitted archive stays "introduction commit missing"', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    finalizeCadenceRepo(dir);
    writeRepoFile(dir, 'openspec/changes/archive/2026-07-29-uncommitted/proposal.md', '# Proposal\n');
    const result = runGate(dir);
    assert.equal(result.status, 0, `missing history remains advisory\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /introduction commit missing for 2026-07-29-uncommitted/);
    assert.match(result.stderr, /no count\/reset or below-threshold claim/);
    assert.doesNotMatch(result.stderr, /已累積/);
  });
});

test('pinned: root-only introduction stays "not unique-parent"', () => {
  const dir = createCadenceRepo();
  try {
    // The archive folder exists only in the parentless root commit.
    writeRepoFile(dir, 'openspec/changes/archive/2026-07-29-root-only/proposal.md', '# Proposal\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--amend', '-m', 'root with archive folder');
    // A single-parent epoch lands later so cadence proceeds to the lookup.
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `root-only introduction remains advisory\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /introduction commit is not unique-parent for 2026-07-29-root-only/);
    assert.match(result.stderr, /no count\/reset or below-threshold claim/);
    assert.doesNotMatch(result.stderr, /已累積/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── F-fhgb-r1-03: header detection is positional (crafted-stream guard) ────

test('F-fhgb-r1-03: a sha-shaped field where a status is expected fails the batch closed (no silent record re-split)', () => {
  const dir = createCadenceRepo();
  // Crafted -z main-walk stream: the second field group drifts — a 40-hex
  // path ("aaa…") sits where the grammar expects a status. A purely
  // content-based header check would silently re-split it into a fake commit
  // record and misclassify the crafted archive as missing; the positional
  // rule must fail the whole batch closed ("history probe failed") instead.
  const craftedLog = [
    `${'f'.repeat(40)} ${'e'.repeat(40)}`,
    '\nA',
    'openspec/changes/archive/2026-07-28-fix-consumer-check-scope/proposal.md',
    'a'.repeat(40),
    'M',
    'openspec/changes/archive/2026-08-01-crafted/proposal.md',
    '',
  ].join('\0');
  const harness = createCraftedLogHarness(craftedLog);
  try {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    commitArchiveProposal(dir, '2026-08-01-crafted');
    finalizeCadenceRepo(dir);
    const result = runGate(dir, harness.env);
    assert.equal(result.status, 0, `crafted drift stays advisory\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /history probe failed for/);
    assert.doesNotMatch(result.stderr, /introduction commit missing for|not unique-parent/);
  } finally {
    harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F-fhgb-r1-03: a real 40-hex root filename stays a path entry (no false header in a well-formed stream)', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    // Whole-commit entries (--full-diff) include this root-level 40-hex file
    // in the same commit that introduces the archive dir; it must be consumed
    // positionally as a path, never misjudged as a commit header.
    const hexName = 'cd'.repeat(20);
    writeRepoFile(dir, 'openspec/changes/archive/2026-08-01-hexfile/proposal.md', '# Proposal\n');
    writeRepoFile(dir, hexName, 'hex\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'archive with 40-hex root file');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `hex-filename cadence stays advisory\nstderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /not unique-parent|introduction commit missing|history probe failed/);
    assert.doesNotMatch(result.stderr, /已累積/);
  });
});

// ── F-fhgb-r1-04(a): ancestry resolver side-branch pin ─────────────────────

test('pinned: pre-epoch side-branch intros are not epoch descendants (post-order ancestry, no false count)', () => {
  withRepo((dir) => {
    // Side branch forks from the root — BEFORE the epoch lands on main — so
    // the epoch is NOT an ancestor of any side commit.
    git(dir, 'checkout', '-q', '-b', 'side');
    for (let index = 1; index <= 5; index += 1) {
      commitArchiveProposal(dir, `2026-08-0${index}-side-archive-${index}`, { carrierIndex: index });
    }
    git(dir, 'checkout', '-q', 'main');
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    git(dir, 'merge', '--no-ff', '--no-commit', 'side');
    git(dir, 'commit', '-q', '-m', 'merge side chain');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `side-branch cadence stays advisory\nstderr: ${result.stderr}`);
    // All five side archives carry governance deletes (trigger shape), but
    // the epoch is not their ancestor — a naive "memoize every visited node
    // as found" resolver would count all five and fire the warn.
    assert.doesNotMatch(result.stderr, /已累積/);
    assert.doesNotMatch(result.stderr, /not unique-parent|introduction commit missing|indeterminate/);
  });
});

// ── F-fhgb-r1-04(b): merge-introduced dir + later single-parent add ─────────

test('pinned: merge-introduced archive with a later single-parent add resolves to the newest add', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    git(dir, 'checkout', '-q', '-b', 'side');
    writeRepoFile(dir, 'side.txt', 'side\n');
    git(dir, 'add', 'side.txt');
    git(dir, 'commit', '-q', '-m', 'side commit');
    git(dir, 'checkout', '-q', 'main');
    writeRepoFile(dir, 'main.txt', 'main\n');
    git(dir, 'add', 'main.txt');
    git(dir, 'commit', '-q', '-m', 'main commit');
    git(dir, 'merge', '--no-ff', '--no-commit', 'side');
    writeRepoFile(dir, 'openspec/changes/archive/2026-07-29-merge-then-add/proposal.md', '# Proposal\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'merge introduces archive dir');
    writeRepoFile(dir, 'openspec/changes/archive/2026-07-29-merge-then-add/decisions.md', '# Decisions\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'later single-parent add');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `merge-then-add cadence stays advisory\nstderr: ${result.stderr}`);
    // Newest single-parent add wins over the merge introduction (the old flow
    // would report the merge as not unique-parent → indeterminate).
    assert.doesNotMatch(result.stderr, /not unique-parent for 2026-07-29-merge-then-add/);
    assert.doesNotMatch(result.stderr, /introduction commit missing for 2026-07-29-merge-then-add/);
    assert.doesNotMatch(result.stderr, /已累積/);
  });
});

// ── F-1-1 equivalence scenarios (design gate round-1 fix) ─────────────────

test('F-1-1(b): active→archive git mv rename introduction hits the qualifier via newPath-under-dir (non-trigger)', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    writeRepoFile(dir, 'openspec/changes/2026-08-05-movable/proposal.md', '# Proposal\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'active change');
    git(dir, 'mv', 'openspec/changes/2026-08-05-movable', 'openspec/changes/archive/2026-08-05-renamed-into-archive');
    git(dir, 'commit', '-q', '-m', 'archive via rename');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `rename introduction must stay green\nstderr: ${result.stderr}`);
    // R100 newPath-under-dir qualifies; the rename pair is not a bounded
    // governance carrier → non-trigger → no warn, no indeterminate.
    assert.doesNotMatch(result.stderr, /indeterminate|已累積/);
  });
});

test('F-1-1(c): non-archive governance M edit in the introduction commit reaches the classifier (non-trigger, no false warn)', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    writeRepoFile(dir, 'openspec/changes/archive/2026-08-06-m-edit/proposal.md', '# Proposal\n');
    appendFileSync(path.join(dir, '.devpro/agent-rules/cadence-rule-1.md'), 'edited\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'archive with governance M edit');
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `M-edit introduction must stay green\nstderr: ${result.stderr}`);
    // M alone never forms a trigger shape → no warn; the entry must be present
    // (whole-commit --full-diff) so the topology classifies instead of going
    // unknown — absence would surface as indeterminate, which is also pinned
    // here via doesNotMatch.
    assert.doesNotMatch(result.stderr, /indeterminate|已累積/);
  });
});

// ── newest-add pin (Decision Boundary 2) ───────────────────────────────────

test('newest-add pin: multi-add archive introduction = newest single-parent add commit', () => {
  withRepo((dir) => {
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    for (let index = 1; index <= 5; index += 1) {
      // First add: proposal only — the old first-ever-commit semantics would
      // pick this commit as the introduction (non-trigger).
      commitArchiveProposal(dir, `2026-08-0${index}-two-add-${index}`);
      // Second add: extra file + governance delete in the same (newest) commit.
      writeRepoFile(dir, `openspec/changes/archive/2026-08-0${index}-two-add-${index}/decisions.md`, '# Decisions\n');
      rmSync(path.join(dir, `.devpro/agent-rules/cadence-rule-${index}.md`));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', `second add ${index}`);
    }
    finalizeCadenceRepo(dir);
    const result = runGate(dir);
    assert.equal(result.status, 0, `newest-add cadence must stay advisory\nstderr: ${result.stderr}`);
    // The warn fires only when the introduction is the NEWEST add commit (the
    // one carrying the governance D entry) for all five archives.
    assert.match(result.stderr, /已累積 5 個 chore B（≥ 5 觸發警告）/);
  });
});

// ── wall-clock scaled fixture (T5 evidence; skip in CI per design D7) ──────

test('wall-clock: N≈500 archive pass path completes in <10s (skip in CI)', { skip: !!process.env.CI }, () => {
  const dir = createCadenceRepo();
  const harness = createFakeGitHarness();
  try {
    // 500 archives + 1 committed epoch — same order of magnitude as the real
    // repo's 407 fullArchives (design D7 FR-2/FR-5 evidence recipe). The epoch
    // MUST be committed: without it (f) reports "v1 migration epoch expected
    // exactly once" and exits indeterminate BEFORE the batched scan, which
    // would make the <10s assertion measure the wrong path (PR #2580 F1).
    commitArchiveProposal(dir, '2026-07-28-fix-consumer-check-scope');
    for (let index = 1; index <= 500; index += 1) {
      commitArchiveProposal(dir, `2026-08-${String(index).padStart(2, '0')}-scaled-${index}`);
    }
    finalizeCadenceRepo(dir);
    const started = Date.now();
    const result = runGate(dir, harness.env);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, `scaled pass path must stay green\nstderr: ${result.stderr}`);
    // Cadence must actually have run its batched scan: the main walk and the
    // parent graph are observed, no merge fallback is needed (all single-parent
    // introductions), and the scan completes with zero unknowns.
    const cadenceCalls = cadenceSubprocessCount(readFileSync(harness.log, 'utf8'));
    assert.ok(
      cadenceCalls >= 2 && cadenceCalls <= 3,
      `cadence must run its batched walks (main+graph observed); saw ${cadenceCalls} cadence-related git calls`
    );
    assert.doesNotMatch(result.stderr, /indeterminate/);
    assert.doesNotMatch(result.stderr, /已累積/);
    assert.ok(
      elapsed < 10_000,
      `gate pass path took ${elapsed}ms (budget 10s)\nstdout: ${result.stdout}`
    );
  } finally {
    harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
