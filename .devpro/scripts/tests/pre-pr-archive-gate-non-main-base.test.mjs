import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs',
);

const BATCH_APPROVAL_LEDGER_NA_SECTION =
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';

const VALID_PROPOSAL_CONTENT =
  '# Proposal: fixture\n\n' +
  '## Why\n\ntest fixture\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Requirement Ledger\n\n' +
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n' +
  '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
  '## Section 3: Tasks\n\n' +
  'Full task ledger: tasks.md. Scope trace: [Req: R1].\n\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  BATCH_APPROVAL_LEDGER_NA_SECTION;

const VALID_BRD_CONTENT =
  '# BRD — test-change\n\n' +
  '## 1. 問題陳述\n\nx\n\n' +
  '## 2. 業務目標\n\nx\n\n' +
  '## 3. 功能需求\n\nx\n\n' +
  '## 4. 非功能需求\n\nx\n\n' +
  '## 5. 範圍界定（In/Out）\n\nx\n\n' +
  '## 6. 限制與假設\n\nx\n\n' +
  '## 7. 成功標準\n\nx\n\n' +
  '## 8. 風險\n\nx\n\n' +
  '## 9. 現況分析\n\nx\n\n' +
  '## 10. 先前嘗試\n\n無\n\n' +
  '## 11. Pre-flight 驗證結果表\n\n| # | 項目 | 結果 |\n|---|---|---|\n| 1 | test | PASS |\n\n' +
  '## 12. 分支資訊\n\nx\n';

const OWN_TASKS =
  '## Tasks\n\n' +
  '- [x] [Req: R1] prove-it: failing test then fix\n' +
  '  - 驗收: focused non-main baseline test green\n';

const UNRELATED_TASKS =
  '## Tasks\n\n' +
  '- [x] [Req: R1] docs only chore\n' +
  '  - 驗收: documentation update complete\n';

function git(repo, args, accepted = [0]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.ok(
    accepted.includes(result.status),
    `git ${args.join(' ')} → ${result.status}\n${result.stderr}`,
  );
  return result;
}

function writeArchive(repo, name, { tasksContent, cap = 'fixture-cap' }) {
  const root = path.join(repo, 'openspec/changes/archive', name);
  mkdirSync(path.join(root, 'specs', cap), { recursive: true });
  writeFileSync(path.join(root, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(root, 'brd.md'), VALID_BRD_CONTENT);
  writeFileSync(path.join(root, 'tasks.md'), tasksContent);
  writeFileSync(
    path.join(root, 'specs', cap, 'spec.md'),
    `# ${cap}\n## ADDED Requirements\n### Requirement: X\n#### Scenario: Y\n- **WHEN** a\n- **THEN** b\n`,
  );
  const canon = path.join(repo, 'openspec/specs', cap);
  mkdirSync(canon, { recursive: true });
  writeFileSync(
    path.join(canon, 'spec.md'),
    `# ${cap}\n## Purpose\nreal purpose\n## Requirements\n### Requirement: X\n#### Scenario: Y\n- **WHEN** a\n- **THEN** b\n`,
  );
}

function runGate(repo, env = {}, extraArgs = []) {
  return spawnSync('node', [GATE, repo, ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_PR_TOUCHED_RULE_FILES: '',
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
      ...env,
    },
  });
}

test('GH-2546: non-main baseline excludes inherited unrelated archive from prove-it (l)', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-gate-non-main-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(repo, '.keep'), 'main\n');
    mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
    mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main root']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'feature/long-lived']);
    writeArchive(repo, '2026-01-01-unrelated', { tasksContent: UNRELATED_TASKS, cap: 'unrelated-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'feature adds unrelated archive']);
    git(repo, ['update-ref', 'refs/remotes/origin/feature/long-lived', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'bugfix/my-own-fix']);
    writeArchive(repo, '2026-09-15-my-own-fix', { tasksContent: OWN_TASKS, cap: 'own-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'bugfix own archive with prove-it']);

    const red = runGate(repo, {
      DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: 'origin/main',
      DEVPRO_CURRENT_BRANCH: 'bugfix/my-own-fix',
    });
    assert.equal(red.status, 1, `expected false-red on main baseline:\n${red.stderr}`);
    assert.match(red.stderr, /\(l\)/, 'check (l) should fire on inherited unrelated');
    assert.match(red.stderr, /2026-01-01-unrelated/);

    const green = runGate(repo, {
      DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: 'origin/feature/long-lived',
      DEVPRO_CURRENT_BRANCH: 'bugfix/my-own-fix',
    });
    assert.equal(
      green.status,
      0,
      `expected pass with PR-base baseline:\nstdout=${green.stdout}\nstderr=${green.stderr}`,
    );
    assert.match(green.stdout, /archive relevance baseline=origin\/feature\/long-lived/);
    assert.doesNotMatch(green.stderr, /2026-01-01-unrelated/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2546: --baseline-ref matches env for relevance probe', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-gate-cli-base-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(repo, '.keep'), 'main\n');
    mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
    mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main root']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'feature/long-lived']);
    writeArchive(repo, '2026-01-01-unrelated', { tasksContent: UNRELATED_TASKS, cap: 'unrelated-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'feature unrelated']);
    git(repo, ['update-ref', 'refs/remotes/origin/feature/long-lived', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'bugfix/cli-base']);
    writeArchive(repo, '2026-09-15-cli-own', { tasksContent: OWN_TASKS, cap: 'cli-own-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'own']);

    const green = runGate(
      repo,
      { DEVPRO_CURRENT_BRANCH: 'bugfix/cli-base' },
      ['--baseline-ref', 'origin/feature/long-lived'],
    );
    assert.equal(green.status, 0, `cli baseline should pass:\n${green.stderr}`);
    assert.match(green.stdout, /source=cli/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2546: main-base true prove-it violation still reds', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-gate-main-red-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(repo, '.keep'), 'main\n');
    mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
    mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main root']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'bugfix/missing-proveit']);
    writeArchive(repo, '2026-09-15-missing-proveit', {
      tasksContent: UNRELATED_TASKS,
      cap: 'missing-cap',
    });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'missing prove-it']);

    const red = runGate(repo, {
      DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: 'origin/main',
      DEVPRO_CURRENT_BRANCH: 'bugfix/missing-proveit',
    });
    assert.equal(red.status, 1);
    assert.match(red.stderr, /\(l\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2546: Unicode non-main baseline (env + CLI) accepts feature/新大戶', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-gate-unicode-'));
  const unicodeBase = 'feature/新大戶';
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(repo, '.keep'), 'main\n');
    mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
    mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main root']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', unicodeBase]);
    writeArchive(repo, '2026-01-01-unrelated', { tasksContent: UNRELATED_TASKS, cap: 'unrelated-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'feature adds unrelated archive']);
    git(repo, ['update-ref', `refs/remotes/origin/${unicodeBase}`, 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'bugfix/unicode-base']);
    writeArchive(repo, '2026-09-15-unicode-own', { tasksContent: OWN_TASKS, cap: 'unicode-own-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'own']);

    const envGreen = runGate(repo, {
      DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: `origin/${unicodeBase}`,
      DEVPRO_CURRENT_BRANCH: 'bugfix/unicode-base',
    });
    assert.equal(
      envGreen.status,
      0,
      `Unicode env baseline should pass:\nstdout=${envGreen.stdout}\nstderr=${envGreen.stderr}`,
    );
    assert.match(envGreen.stdout, /archive relevance baseline=origin\/feature\/新大戶/);

    const cliGreen = runGate(
      repo,
      { DEVPRO_CURRENT_BRANCH: 'bugfix/unicode-base' },
      ['--baseline-ref', `origin/${unicodeBase}`],
    );
    assert.equal(
      cliGreen.status,
      0,
      `Unicode CLI baseline should pass:\nstdout=${cliGreen.stdout}\nstderr=${cliGreen.stderr}`,
    );
    assert.match(cliGreen.stdout, /source=cli/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2546: DEVPRO_SCENARIO_DIFF_BASELINE_REF alone is not archive-relevance baseline', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-gate-scenario-isolation-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(repo, '.keep'), 'main\n');
    mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
    mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main root']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'feature/long-lived']);
    writeArchive(repo, '2026-01-01-unrelated', { tasksContent: UNRELATED_TASKS, cap: 'unrelated-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'feature unrelated']);
    git(repo, ['update-ref', 'refs/remotes/origin/feature/long-lived', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'bugfix/scenario-isolation']);
    writeArchive(repo, '2026-09-15-scenario-own', { tasksContent: OWN_TASKS, cap: 'scenario-own-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'own']);

    // Only scenario-diff env points at the feature base; archive relevance must NOT follow it.
    const red = spawnSync('node', [GATE, repo], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVPRO_PR_TOUCHED_RULE_FILES: '',
        DEVPRO_CHANGED_CAPABILITY_SPECS: '',
        DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'origin/feature/long-lived',
        DEVPRO_CURRENT_BRANCH: 'bugfix/scenario-isolation',
      },
    });
    assert.equal(red.status, 1, `scenario-diff alone must not hide inherited unrelated:\n${red.stderr}`);
    assert.match(red.stderr, /\(l\)/);
    assert.match(red.stderr, /2026-01-01-unrelated/);
    // Fail path may omit advisory print; still MUST NOT claim feature baseline from scenario-diff env.
    assert.doesNotMatch(red.stdout, /archive relevance baseline=origin\/feature\/long-lived/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2546: unresolved env baseline fail-closed', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-gate-unresolved-'));
  try {
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    git(repo, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(repo, '.keep'), 'main\n');
    mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
    mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'main root']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'bugfix/missing-ref']);
    // Need at least one archive so the gate reaches relevance baseline resolution
    // (empty archive dir exits early with "no archives yet").
    writeArchive(repo, '2026-09-15-placeholder', { tasksContent: OWN_TASKS, cap: 'placeholder-cap' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'placeholder archive']);

    const red = runGate(repo, {
      DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: 'origin/feature/does-not-exist',
      DEVPRO_CURRENT_BRANCH: 'bugfix/missing-ref',
    });
    assert.equal(red.status, 1, `expected fail-closed:\nstderr=${red.stderr}\nstdout=${red.stdout}`);
    assert.match(red.stderr, /does not resolve to a commit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
