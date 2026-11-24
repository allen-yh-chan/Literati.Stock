/**
 * hook-pre-tool-gate-worktree-abs.test.mjs
 *
 * Gate D — Worktree Absolute Path Gate unit tests.
 * Covers: pre-tool-gate.mjs `checkWorktreeAbsolutePath` exported function.
 *
 * Per P4 Gate D spec: pre-tool-gate.mjs §Gate D (T10)
 * Block `git worktree add <path>` where path is relative and there is no
 * explicit `cd <abs> &&` prefix that anchors the cwd deterministically.
 *
 * Test strategy:
 *   - Import checkWorktreeAbsolutePath directly (pure function, no I/O)
 *   - Happy: absolute path → pass (null return)
 *   - Adversarial 4 cases: relative path block, dot-prefix block,
 *     chained cd abs prefix pass, semicolon-separated cd edge case
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../hooks/pre-tool-gate.mjs'
);

const { checkWorktreeAbsolutePath, looksAbsoluteAfterExpansion, extractWorktreeAddPath } = await import(pathToFileURL(HOOK).href);

// Minimal baseCwd for tests that need one. This path does NOT exist and is
// NOT a git repo, so `gitCommonDir()` fails → repo-root resolution fails →
// the new `.worktree/` prefix check fail-opens (returns null), preserving
// all existing pass-case assertions in this file unchanged.
const FAKE_BASECWD = '/tmp/test-repo';

for (const quiet of ['--quiet', '-q']) {
  for (const args of [
    `${quiet} -b chore/amend-example /abs/wt production-v1.0.0`,
    `-b chore/amend-example ${quiet} /abs/wt production-v1.0.0`,
    `${quiet} --lock --reason 'two words' '/abs/wt space' production-v1.0.0`,
    `${quiet} "C:/repo/.worktree/wt space" production-v1.0.0`,
  ]) {
    test(`Gate D quiet option preserves literal absolute path: ${args}`, () => {
      const command = `git worktree add ${args}`;
      const expected = args.includes('C:/') ? 'C:/repo/.worktree/wt space' : args.includes('wt space') ? '/abs/wt space' : '/abs/wt';
      assert.equal(extractWorktreeAddPath(command), expected);
      assert.deepEqual(checkWorktreeAbsolutePath(command, FAKE_BASECWD),
        checkWorktreeAbsolutePath('git worktree add ' + args.replace(quiet, '').trim(), FAKE_BASECWD),
        'quiet must preserve the platform-specific baseline verdict');
      if (!args.includes('C:/')) assert.equal(checkWorktreeAbsolutePath(command, FAKE_BASECWD), null);
    });
  }
  for (const unsafe of ['./relative', 'relative', '"/abs/$dynamic"', '"/abs/' + String.fromCharCode(96) + 'pwd' + String.fromCharCode(96) + '"']) {
    test(`Gate D quiet option retains unsafe path block: ${quiet} ${unsafe}`, () => {
      assert.equal(checkWorktreeAbsolutePath(`git worktree add ${quiet} -b chore/amend-example ${unsafe} main`, FAKE_BASECWD)?.block, true);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────

test('Gate D happy: git worktree add /abs/path/to/wt -b name main → pass (null)', () => {
  const cmd = 'git worktree add /abs/path/to/wt -b name main';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'absolute path must pass (return null)');
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (a): relative path → block
// ─────────────────────────────────────────────────────────────────────────

test('Gate D adversarial (a): git worktree add ./relative/path -b name main → block', () => {
  const cmd = 'git worktree add ./relative/path -b name main';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, 'relative path must be blocked (non-null return)');
  assert.equal(result.block, true, 'result.block must be true');
  assert.ok(
    result.reason.includes('Worktree Absolute Path Gate'),
    `reason must mention gate name\nreason: ${result.reason}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (b): dot-prefixed relative path → block
// ─────────────────────────────────────────────────────────────────────────

test('Gate D adversarial (b): git worktree add .worktree/sub -b name main → block', () => {
  const cmd = 'git worktree add .worktree/sub -b name main';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, '.worktree/sub is relative and must be blocked');
  assert.equal(result.block, true);
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (c): chained cd /abs/repo && git worktree add ./relative → pass
//   The cd <abs> && prefix anchors the cwd; relative path becomes deterministic.
// ─────────────────────────────────────────────────────────────────────────

test('Gate D adversarial (c): cd /abs/repo && git worktree add ./worktree/x -b name main → pass', () => {
  const cmd = 'cd /abs/repo && git worktree add ./worktree/x -b name main';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(
    result,
    null,
    'cd /abs && relative path must pass (anchored cwd is deterministic)'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (d): semicolon-separated cd /abs; git worktree add ./relative
//   Gate implementation uses `&&` OR `;` separator for cd prefix detection.
//   Test verifies at least one behaviour is defined (pass or block — document it).
// ─────────────────────────────────────────────────────────────────────────

test('Gate D adversarial (d): cd /abs/repo; git worktree add ./worktree/x (semicolon separator)', () => {
  const cmd = 'cd /abs/repo; git worktree add ./worktree/x -b name main';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  // The implementation accepts both && and ; as cd prefix separators.
  // Assert that we get a defined result (not an unhandled exception).
  assert.ok(
    result === null || (result !== null && typeof result.block === 'boolean'),
    'gate must return null (pass) or { block, reason } (block) — no crash'
  );
  // Document the observed behaviour so regressions are caught:
  // hasExplicitAbsCdPrefix uses /^\s*cd\s+...\s*(?:&&|;)/ — semicolon IS accepted.
  assert.equal(
    result,
    null,
    'semicolon-separated cd /abs; ... should pass (both && and ; accepted per implementation)'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Extra: non-worktree command → pass (null)
// ─────────────────────────────────────────────────────────────────────────

test('Gate D: non-worktree command → pass (null)', () => {
  const cmd = 'git status';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null);
});

// Extra: git worktree add with -b flag before path → still checks path correctly
test('Gate D: git worktree add -b branch /abs/path → pass', () => {
  const cmd = 'git worktree add -b my-feature /abs/path/to/worktree';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'absolute path after -b flag must pass');
});

// ─────────────────────────────────────────────────────────────────────────
// Shell-expansion PASS cases (D-P2 through D-P6) — issue #462 fix
// ─────────────────────────────────────────────────────────────────────────

// D-P2: $(git rev-parse --show-toplevel)/.worktree/foo — unquoted
test('Gate D D-P2: $(git rev-parse --show-toplevel)/.worktree/foo -b bugfix/test ff735f6 → pass', () => {
  const cmd = 'git worktree add $(git rev-parse --show-toplevel)/.worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'safe shell expansion $(git rev-parse --show-toplevel)/... must pass');
});

// D-P3: "$(git rev-parse --show-toplevel)/.worktree/foo" — double-quoted variant
test('Gate D D-P3: "$(git rev-parse --show-toplevel)/.worktree/foo" quoted variant → pass', () => {
  const cmd = 'git worktree add "$(git rev-parse --show-toplevel)/.worktree/foo" -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'quoted safe expansion "$(git rev-parse --show-toplevel)/..." must pass');
});

// D-P4: $(pwd)/.worktree/foo
test('Gate D D-P4: $(pwd)/.worktree/foo → pass', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'safe shell expansion $(pwd)/... must pass');
});

// D-P5: REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.worktree/foo
test('Gate D D-P5: REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.worktree/foo → pass', () => {
  const cmd = 'REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, '$REPO_ROOT/... with safe assignment in same cmd must pass');
});

test('Gate D D-P5 regression: read-only probes before REPO_ROOT assignment still pass', () => {
  const cmd = [
    'git status --short',
    'git rev-parse --abbrev-ref HEAD',
    'REPO_ROOT=$(git rev-parse --show-toplevel)',
    'git worktree add "$REPO_ROOT/.worktree/foo" -b bugfix/test ff735f6',
  ].join(' && ');
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, '$REPO_ROOT safe assignment after read-only probes must pass');
});

// D-P6: REPO_ROOT=$(pwd) && git worktree add ${REPO_ROOT}/.worktree/foo
test('Gate D D-P6: REPO_ROOT=$(pwd) && git worktree add ${REPO_ROOT}/.worktree/foo → pass', () => {
  const cmd = 'REPO_ROOT=$(pwd) && git worktree add ${REPO_ROOT}/.worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, '${REPO_ROOT}/... with $(pwd) assignment in same cmd must pass');
});

// ─────────────────────────────────────────────────────────────────────────
// Shell-expansion BLOCK cases (D-B2, D-B3) — issue #462 fix
// ─────────────────────────────────────────────────────────────────────────

// D-B1 (existing — preserved): bare relative path
test('Gate D D-B1: .worktree/foo bare relative → block', () => {
  const cmd = 'git worktree add .worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, 'bare relative path must be blocked');
  assert.equal(result.block, true);
});

// D-B2: unknown variable $UNKNOWN_VAR/.worktree/foo
test('Gate D D-B2: $UNKNOWN_VAR/.worktree/foo → block (unrecognised var)', () => {
  const cmd = 'git worktree add $UNKNOWN_VAR/.worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, 'unknown variable expansion must be blocked');
  assert.equal(result.block, true, 'result.block must be true for unrecognised var');
});

// D-B3: $REPO_ROOT without assignment in same command
test('Gate D D-B3: $REPO_ROOT/.worktree/foo with no REPO_ROOT assignment → block', () => {
  const cmd = 'git worktree add $REPO_ROOT/.worktree/foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, '$REPO_ROOT without assignment in same cmd must be blocked');
  assert.equal(result.block, true, 'result.block must be true for unassigned REPO_ROOT');
});

test('Gate D D-B3 regression: quoted $REPO_ROOT/.worktree/foo with no assignment → block', () => {
  const cmd = 'git status && git worktree add "$REPO_ROOT/.worktree/foo" -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, 'quoted $REPO_ROOT without assignment in same cmd must be blocked');
  assert.equal(result.block, true, 'result.block must be true for quoted unassigned REPO_ROOT');
});

// ─────────────────────────────────────────────────────────────────────────
// looksAbsoluteAfterExpansion unit tests
// ─────────────────────────────────────────────────────────────────────────

test('looksAbsoluteAfterExpansion: $(git rev-parse --show-toplevel)/sub → true', () => {
  assert.equal(looksAbsoluteAfterExpansion('$(git rev-parse --show-toplevel)/.worktree/foo', ''), true);
});

test('looksAbsoluteAfterExpansion: $(pwd)/sub → true', () => {
  assert.equal(looksAbsoluteAfterExpansion('$(pwd)/.worktree/foo', ''), true);
});

test('looksAbsoluteAfterExpansion: $REPO_ROOT/sub with assignment → true', () => {
  const fullCmd = 'REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.worktree/foo';
  assert.equal(looksAbsoluteAfterExpansion('$REPO_ROOT/.worktree/foo', fullCmd), true);
});

test('looksAbsoluteAfterExpansion: $REPO_ROOT/sub with earlier read-only probes and assignment → true', () => {
  const fullCmd = 'git status && REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add "$REPO_ROOT/.worktree/foo"';
  assert.equal(looksAbsoluteAfterExpansion('$REPO_ROOT/.worktree/foo', fullCmd), true);
});

test('looksAbsoluteAfterExpansion: $REPO_ROOT/sub without assignment → false', () => {
  const fullCmd = 'git worktree add $REPO_ROOT/.worktree/foo';
  assert.equal(looksAbsoluteAfterExpansion('$REPO_ROOT/.worktree/foo', fullCmd), false);
});

test('looksAbsoluteAfterExpansion: $UNKNOWN/sub → false', () => {
  assert.equal(looksAbsoluteAfterExpansion('$UNKNOWN/.worktree/foo', ''), false);
});

test('looksAbsoluteAfterExpansion: /abs/path → false (not a shell expansion)', () => {
  assert.equal(looksAbsoluteAfterExpansion('/abs/path/.worktree/foo', ''), false);
});

// ─────────────────────────────────────────────────────────────────────────
// `.worktree/` prefix invariant (strengthen-pretool-gate-invariants A)
//
// These tests need a REAL git repo cwd so `gitCommonDir()` resolves a
// repo-root — a fake/non-existent cwd (FAKE_BASECWD above) always fail-opens
// via gitCommonDir failure, which is exercised separately below.
// ─────────────────────────────────────────────────────────────────────────

function makeTempGitRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), 'gate-d-worktree-prefix-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.name "Worktree Gate Test"', { cwd: dir });
  execSync('git config user.email worktree-gate@example.invalid', { cwd: dir });
  execSync('git commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

function assertQuotedPathBlocked(cmd, baseCwd, message) {
  const result = checkWorktreeAbsolutePath(cmd, baseCwd);
  assert.ok(result !== null, message);
  assert.equal(result.block, true, `${message}: result.block must be true`);
  assert.ok(
    result.reason.includes('Worktree Absolute Path Gate'),
    `${message}: reason must identify Gate D\nreason: ${result.reason}`
  );
  assert.ok(
    result.reason.includes('<repo-root>/.worktree/<change-name>'),
    `${message}: reason must include actionable .worktree remediation\nreason: ${result.reason}`
  );
  assert.ok(
    !result.reason.includes('__QUOTED__'),
    `${message}: reason must not expose the internal quoted placeholder\nreason: ${result.reason}`
  );
}

test('Gate D quoted literal: double-quoted in-repo absolute path passes', () => {
  const repo = makeTempGitRepo();
  try {
    const shellRepo = repo.replaceAll('\\', '/');
    const cmd = `git worktree add "${shellRepo}/.worktree/double quoted" -b bugfix/double-quoted HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(result, null, 'safe double-quoted literal under repo .worktree must pass');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D quoted literal: single-quoted in-repo absolute path passes with options before path', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `git worktree add -b bugfix/single-quoted '${repo}/.worktree/single quoted' HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(result, null, 'safe single-quoted literal under repo .worktree must pass');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D placeholder boundary: unquoted anchored literal containing marker text still passes', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `cd ${repo} && git worktree add .worktree/literal__QUOTED__name -b bugfix/literal-marker HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(
      result,
      null,
      'only the exact opaque placeholder may enter quoted-path fail-closed handling'
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D quoted literal correlation: fake quoted echo safe path cannot hide real outside path', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `echo "; git worktree add '${repo}/.worktree/fake-safe' -b bugfix/fake HEAD" && ` +
      `git worktree add "${repo}/outside/real-unsafe" -b bugfix/real HEAD`;
    assertQuotedPathBlocked(cmd, repo, 'real quoted outside path must not inherit fake echo trust');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D quoted literal correlation: fake quoted echo outside path cannot block real safe path', () => {
  const repo = makeTempGitRepo();
  try {
    const shellRepo = repo.replaceAll('\\', '/');
    const cmd =
      `echo "; git worktree add '${shellRepo}/outside/fake-unsafe' -b bugfix/fake HEAD" && ` +
      `git worktree add "${shellRepo}/.worktree/real-safe" -b bugfix/real HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(result, null, 'real safe quoted literal must correlate to the sanitized invocation');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D multi-invocation: safe first add cannot hide unsafe second add', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `git worktree add "${repo}/.worktree/first-safe" -b bugfix/first-safe HEAD && ` +
      `git worktree add "${repo}/outside/second-unsafe" -b bugfix/second-unsafe HEAD`;
    assertQuotedPathBlocked(cmd, repo, 'unsafe second real invocation must be blocked');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D multi-invocation: unsafe first add remains blocked before safe second add', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `git worktree add "${repo}/outside/first-unsafe" -b bugfix/first-unsafe HEAD && ` +
      `git worktree add "${repo}/.worktree/second-safe" -b bugfix/second-safe HEAD`;
    assertQuotedPathBlocked(cmd, repo, 'unsafe first real invocation must remain blocked');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D multi-invocation: quoted fake echo is not counted between two safe real adds', () => {
  const repo = makeTempGitRepo();
  try {
    const shellRepo = repo.replaceAll('\\', '/');
    const cmd =
      `git worktree add "${shellRepo}/.worktree/first-safe" -b bugfix/first-safe HEAD && ` +
      `echo "git worktree add '${shellRepo}/outside/fake-unsafe' -b bugfix/fake HEAD" && ` +
      `git worktree add "${shellRepo}/.worktree/second-safe" -b bugfix/second-safe HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(result, null, 'quoted fake echo must not become a real unsafe invocation');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D per-invocation expansion: later unsafe reassignment cannot inherit an earlier safe ROOT proof', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `ROOT=${repo}; ` +
      'git worktree add $ROOT/.worktree/first-safe -b bugfix/first-safe HEAD; ' +
      'ROOT=relative; ' +
      'git worktree add $ROOT/.worktree/second-unsafe -b bugfix/second-unsafe HEAD';
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result?.block, 'latest pre-invocation ROOT assignment is relative, so the second add must block');
    assert.match(result.reason, /Worktree Absolute Path Gate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D per-invocation expansion: reassignment before a trailing comment clears stale safe proof', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `ROOT=${repo}; ROOT=relative # executed reassignment\n` +
      'git worktree add $ROOT/.worktree/unsafe -b bugfix/unsafe HEAD';
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result?.block, 'a commented unsafe reassignment must replace the earlier safe ROOT proof');
    assert.match(result.reason, /Worktree Absolute Path Gate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D per-invocation expansion: skipped conditional assignment is not executable proof', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `false && ROOT=${repo}; ` +
      'git worktree add $ROOT/.worktree/unsafe -b bugfix/unsafe HEAD';
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result?.block, 'an assignment skipped by a prior conditional must not prove a later invocation safe');
    assert.match(result.reason, /Worktree Absolute Path Gate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D per-invocation expansion: assignment after worktree add is not proof for that invocation', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `git worktree add $ROOT/.worktree/unsafe -b bugfix/unsafe HEAD; ROOT=${repo}`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result?.block, 'a later ROOT assignment must not retroactively prove an earlier expansion safe');
    assert.match(result.reason, /Worktree Absolute Path Gate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

for (const [label, fakeAssignment] of [
  ['quoted data', (repo) => `echo "example ROOT=${repo}";`],
  ['comment', (repo) => `# ROOT=${repo}\n`],
  ['heredoc', (repo) => `cat <<'EOF'\nROOT=${repo}\nEOF\n`],
  ['help-only statement', (repo) => `git status --help ROOT=${repo};`],
]) {
  test(`Gate D per-invocation expansion: ${label} assignment text is not executable proof`, () => {
    const repo = makeTempGitRepo();
    try {
      const cmd =
        `${fakeAssignment(repo)} ` +
        'git worktree add $ROOT/.worktree/unsafe -b bugfix/unsafe HEAD';
      const result = checkWorktreeAbsolutePath(cmd, repo);
      assert.ok(result?.block, `${label} ROOT text must not prove the real expansion safe`);
      assert.match(result.reason, /Worktree Absolute Path Gate/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test('Gate D per-invocation expansion: executable earlier same-payload assignment remains allowed', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd =
      `ROOT=${repo} && ` +
      'git worktree add $ROOT/.worktree/safe -b bugfix/safe HEAD';
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(result, null, 'an executable safe assignment before the same invocation must still pass');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D per-invocation cd: a later cd replaces the earlier cwd anchor', () => {
  const repo = makeTempGitRepo();
  try {
    mkdirSync(`${repo}/sub`);
    const cmd =
      `cd ${repo} && ` +
      'git worktree add .worktree/first-safe -b bugfix/first-safe HEAD; ' +
      `cd ${repo}/sub && ` +
      'git worktree add .worktree/second-unsafe -b bugfix/second-unsafe HEAD';
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result?.block, 'second relative add resolves under repo/sub, not repo-root/.worktree');
    assert.ok(
      result.reason.replaceAll('\\', '/').includes(`${repo.replaceAll('\\', '/')}/sub/.worktree/second-unsafe`),
      `reason must name the second cwd anchor; got ${result.reason}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D per-invocation cd: skipped conditional cd is not executable cwd evidence', () => {
  const repo = makeTempGitRepo();
  try {
    mkdirSync(`${repo}/sub`);
    const cmd =
      `false && cd ${repo}; ` +
      'git worktree add .worktree/unsafe -b bugfix/unsafe HEAD';
    const result = checkWorktreeAbsolutePath(cmd, `${repo}/sub`);
    assert.ok(result?.block, 'a cd skipped by a prior conditional must not anchor the later invocation');
    assert.match(result.reason, /Worktree Absolute Path Gate/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D quoted literal: outside absolute path remains blocked', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `git worktree add "${repo}/outside/x" -b bugfix/outside HEAD`;
    assertQuotedPathBlocked(cmd, repo, 'quoted outside absolute path must block');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D quoted literal: repo-prefix lookalike remains blocked', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `git worktree add '${repo}-evil/.worktree/x' -b bugfix/lookalike HEAD`;
    assertQuotedPathBlocked(cmd, repo, 'quoted repo-prefix lookalike must block');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D quoted literal: dot-relative path remains blocked', () => {
  assertQuotedPathBlocked(
    'git worktree add "./relative-path" -b bugfix/relative HEAD',
    FAKE_BASECWD,
    'quoted dot-relative path must block'
  );
});

test('Gate D quoted literal: parent-relative path remains blocked', () => {
  assertQuotedPathBlocked(
    "git worktree add '../sibling' -b bugfix/relative HEAD",
    FAKE_BASECWD,
    'quoted parent-relative path must block'
  );
});

test('Gate D quoted literal: unknown variable is not promoted to a literal', () => {
  assertQuotedPathBlocked(
    'git worktree add "$UNKNOWN_VAR/.worktree/x" -b bugfix/dynamic HEAD',
    FAKE_BASECWD,
    'quoted unknown variable must block'
  );
});

test('Gate D quoted literal: command substitution is not promoted to a literal', () => {
  assertQuotedPathBlocked(
    'git worktree add "$(printf /tmp)/.worktree/x" -b bugfix/dynamic HEAD',
    FAKE_BASECWD,
    'quoted command substitution outside the allowlist must block'
  );
});

test('Gate D quoted literal: backtick substitution is not promoted to a literal', () => {
  assertQuotedPathBlocked(
    'git worktree add "`pwd`/.worktree/x" -b bugfix/dynamic HEAD',
    FAKE_BASECWD,
    'quoted backtick substitution must block'
  );
});

test('Gate D quoted literal: adjacent quoted fragments are not promoted to a literal', () => {
  assertQuotedPathBlocked(
    "git worktree add '/tmp/.worktree/x''-suffix' -b bugfix/concatenated HEAD",
    FAKE_BASECWD,
    'concatenated quoted fragments must block'
  );
});

test('Gate D quoted literal: broken quote fails closed', () => {
  assertQuotedPathBlocked(
    "git worktree add '/tmp/.worktree/x -b bugfix/broken HEAD",
    FAKE_BASECWD,
    'broken quoted path must block'
  );
});

test('Gate D quoted literal: unsupported double-quote escape fails closed', () => {
  assertQuotedPathBlocked(
    'git worktree add "/tmp/.worktree/x\\ y" -b bugfix/escape HEAD',
    FAKE_BASECWD,
    'quoted path requiring escape decoding must block'
  );
});

test('Gate D absolute-non-.worktree/: /abs/repo/.claude/worktrees/x (real repo) → block', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `git worktree add ${repo}/.claude/worktrees/x -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result !== null, 'absolute but non-.worktree/ path must be blocked');
    assert.equal(result.block, true);
    assert.ok(
      result.reason.includes('.worktree/'),
      `reason must point to .worktree/ convention\nreason: ${result.reason}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D absolute-.worktree/: <repo-root>/.worktree/x (real repo) → pass (null)', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `git worktree add ${repo}/.worktree/x -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.equal(result, null, 'absolute .worktree/ subpath must pass');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// #3556 item 1: the session sits in repository A and the command targets repository B without `cd`. The repository
// that receives the worktree is the one `git -C` (or an explicit `cd`) runs in, not the payload cwd.
test('Gate D cross-repo: git -C <B> worktree add <B>/.worktree/x from a session in A → pass', () => {
  const a = makeTempGitRepo();
  const b = makeTempGitRepo();
  try {
    assert.equal(checkWorktreeAbsolutePath(`git -C ${b} worktree add ${b}/.worktree/x -b chore/x HEAD`, a), null);
    assert.equal(checkWorktreeAbsolutePath(`DEVPRO_REPO_SCOPE_APPROVED=b git -C ${b} worktree add ${b}/.worktree/x -b chore/x HEAD`, a), null);
    assert.equal(checkWorktreeAbsolutePath(`cd ${b} && git worktree add ${b}/.worktree/x -b chore/x HEAD`, a), null,
      'an explicit cd anchors the absolute-path check as well');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('Gate D cross-repo: the path must sit under the .worktree/ of the repository git runs in', () => {
  const a = makeTempGitRepo();
  const b = makeTempGitRepo();
  try {
    for (const cmd of [
      `git -C ${b} worktree add ${a}/.worktree/x -b chore/x HEAD`,
      `git -C ${a} worktree add ${b}/.worktree/x -b chore/x HEAD`,
      `git -C ${b} worktree add ${b}/.claude/worktrees/x -b chore/x HEAD`,
      // An unresolvable -C target keeps the payload cwd, so B's path stays outside A's .worktree/.
      `git -C ${b}/missing worktree add ${b}/.worktree/x -b chore/x HEAD`,
    ]) {
      const result = checkWorktreeAbsolutePath(cmd, a);
      assert.equal(result?.block, true, cmd);
      assert.match(result.reason, /Worktree Absolute Path Gate/, cmd);
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('Gate D absolute-non-.worktree/: prefix-string lookalike <repo-root>-evil/.worktree/x must NOT be treated as inside repo-root/.worktree', () => {
  const repo = makeTempGitRepo();
  try {
    // A sibling directory whose name has repo-root as a *string prefix* but
    // is not actually under it (e.g. `<repo>-evil`). Must still block: this
    // exercises the path.sep boundary check, not naive startsWith().
    const lookalike = `${repo}-evil/.worktree/x`;
    const cmd = `git worktree add ${lookalike} -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result !== null, 'string-prefix lookalike must not be treated as repo-root subpath');
    assert.equal(result.block, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D fail-open: unresolvable repo-root (non-git cwd) → absolute non-.worktree/ path still passes', () => {
  const cmd = 'git worktree add /some/abs/.claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'repo-root resolution failure must fail-open (pass)');
});

test('Gate D shell-expansion tightened: $(pwd)/.claude/worktrees/x (non-.worktree/ literal suffix) → block', () => {
  const cmd = 'git worktree add $(pwd)/.claude/worktrees/x -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, 'expansion form with non-.worktree/ literal suffix must be blocked');
  assert.equal(result.block, true);
});

test('Gate D shell-expansion tightened: $REPO_ROOT/.claude/worktrees/x with assignment (non-.worktree/ literal suffix) → block', () => {
  const cmd = 'REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.claude/worktrees/x -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, 'expansion form with non-.worktree/ literal suffix must be blocked even with safe REPO_ROOT assignment');
  assert.equal(result.block, true);
});

// ─────────────────────────────────────────────────────────────────────────
// abs-cd branch + expansion-escape closure (strengthen-pretool-gate-invariants
// Gate D cross-model round — 3 same-root gaps: literal-prefix check without
// realpath resolution left symmetric bypasses in the abs-cd branch and the
// expansion-suffix branch).
// ─────────────────────────────────────────────────────────────────────────

test('Gate D abs-cd bypass (Fix #1): cd <repo-root> && git worktree add .claude/worktrees/x → block (real repo)', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `cd ${repo} && git worktree add .claude/worktrees/x -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
    assert.ok(result !== null, 'abs-cd anchored relative path resolving outside .worktree/ must be blocked');
    assert.equal(result.block, true);
    assert.ok(
      result.reason.replaceAll('\\', '/').includes('.claude/worktrees/x'),
      `reason must include the effective offending absolute path\nreason: ${result.reason}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D abs-cd legitimate (Fix #1): cd <repo-root> && git worktree add .worktree/x → pass (real repo)', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `cd ${repo} && git worktree add .worktree/x -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
    assert.equal(result, null, 'abs-cd anchored relative path resolving under .worktree/ must pass');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D abs-cd fail-open (Fix #1): cd to non-git absolute path → pass (repo-root unresolvable)', () => {
  const cmd = 'cd /some/nonexistent/abs/path && git worktree add .claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, 'repo-root unresolvable from cd anchor must fail-open (pass)');
});

test('Gate D expansion escape (Fix #2): $REPO_ROOT/.worktree/../.claude/worktrees/x → block (real repo)', () => {
  const repo = makeTempGitRepo();
  try {
    const cmd = `REPO_ROOT=${repo} && git worktree add $REPO_ROOT/.worktree/../.claude/worktrees/x -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result !== null, '.worktree/../ escape must be blocked — normalized suffix lands outside .worktree/');
    assert.equal(result.block, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('Gate D expansion escape (Fix #2): $(pwd)/.worktree/../.claude/worktrees/x → block', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/../.claude/worktrees/x -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(result !== null, '.worktree/../ escape via $(pwd) must be blocked');
  assert.equal(result.block, true);
});

test('literalSuffixIsWorktree escape rejection is exercised end-to-end (Fix #2 sanity): legitimate .worktree/./foo still passes', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/./foo -b bugfix/test ff735f6';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(result, null, '.worktree/./foo (harmless dot-segment, no escape) must still pass');
});

// ─────────────────────────────────────────────────────────────────────────
// Gate D expansion escape (Fix #2b) — cross-model round 2: no-trailing-slash
// terminal `.worktree/..` variant. Unlike `.worktree/../foo` (slash-terminated,
// already fixed above), a bare `.worktree/..` immediately followed by a space
// (trailing flags) or EOL does NOT collapse under path.posix.normalize when
// the suffix is read as the ENTIRE remaining command text (subshell/repoRoot
// branches slice raw cmd, not just the path token) — the literal text
// `.worktree/.. -b chore/x HEAD` normalizes to itself unchanged, since `..
// -b` is one odd path segment, not an up-level segment. This let the escape
// slip past `literalSuffixIsWorktree` as a false allow even though the shell
// actually resolves `$(pwd)/.worktree/..` to the repo root (outside
// `.worktree/`). Fix: isolate the suffix to the first shell-token boundary
// (whitespace/quote) before normalizing.
// ─────────────────────────────────────────────────────────────────────────

test('Gate D expansion escape (Fix #2b): $(pwd)/.worktree/.. -b chore/x HEAD (no-trailing-slash terminal ".." via subshell) → block', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/.. -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'no-trailing-slash terminal .worktree/.. escape via $(pwd) must be blocked'
  );
  assert.equal(result.block, true);
});

test('Gate D expansion escape (Fix #2b): REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.worktree/.. -b chore/x HEAD (via $REPO_ROOT) → block', () => {
  const cmd =
    'REPO_ROOT=$(git rev-parse --show-toplevel) && git worktree add $REPO_ROOT/.worktree/.. -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'no-trailing-slash terminal .worktree/.. escape via $REPO_ROOT must be blocked'
  );
  assert.equal(result.block, true);
});

test('Gate D expansion escape (Fix #2b) sanity: $(pwd)/.worktree/foo -b chore/x HEAD (legitimate path + trailing flag) → pass', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/foo -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(
    result,
    null,
    'legitimate .worktree/foo path with a trailing flag must NOT be false-blocked by token isolation'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Gate D expansion escape (Fix #3) — cross-model round 3: shell-metacharacter
// terminated variant. Fix #2b isolated the suffix at the first
// whitespace/quote boundary, but a no-trailing-slash terminal `.worktree/..`
// glued directly to a shell metacharacter (`;`, `&&`, `|`, `>`, `)`, backtick,
// `#`, …) still was NOT collapsed by path.posix.normalize — `.worktree/..;rm`
// is one odd path segment, not an up-level segment — so the escape (which
// the shell actually resolves to the repo root via `$(pwd)/.worktree/..`)
// slipped past literalSuffixIsWorktree as a false allow. Fix: isolate the
// suffix to a whitelisted path-safe character run (alnum + `/._-~@+=:%`)
// instead of splitting on whitespace/quote only — a positive whitelist can't
// be reopened by some other metacharacter nobody thought of yet.
// ─────────────────────────────────────────────────────────────────────────

test('Gate D expansion escape (Fix #3): $(pwd)/.worktree/..;true -b chore/x HEAD (semicolon-terminated terminal "..") → block', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/..;true -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'semicolon-terminated .worktree/.. escape via $(pwd) must be blocked'
  );
  assert.equal(result.block, true);
});

test('Gate D expansion escape (Fix #3): $(pwd)/.worktree/..>x -b chore/x HEAD (redirect-terminated terminal "..") → block', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/..>x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'redirect-terminated .worktree/.. escape via $(pwd) must be blocked'
  );
  assert.equal(result.block, true);
});

test('Gate D expansion escape (Fix #3): $(pwd)/.worktree/..&&true -b chore/x HEAD (&&-terminated terminal "..") → block', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/..&&true -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    '&&-terminated .worktree/.. escape via $(pwd) must be blocked'
  );
  assert.equal(result.block, true);
});

test('Gate D expansion escape (Fix #3): $(pwd)/.worktree/..|true -b chore/x HEAD (pipe-terminated terminal "..") → block', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/..|true -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'pipe-terminated .worktree/.. escape via $(pwd) must be blocked'
  );
  assert.equal(result.block, true);
});

test('Gate D expansion escape (Fix #3) sanity: $(pwd)/.worktree/2026-07-04-foo -b chore/x HEAD (legitimate date-kebab change name) → pass', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/2026-07-04-foo -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(
    result,
    null,
    'legitimate .worktree/<date-kebab-name> path must NOT be false-blocked by the path-charset whitelist'
  );
});

test('Gate D block reason includes literal offending path (Fix #3): absolute non-.worktree/ path', () => {
  const repo = makeTempGitRepo();
  try {
    const offending = `${repo}/.claude/worktrees/x`;
    const cmd = `git worktree add ${offending} -b chore/x HEAD`;
    const result = checkWorktreeAbsolutePath(cmd, repo);
    assert.ok(result !== null);
    assert.ok(
      result.reason.includes(offending),
      `reason must include the literal offending absolute path\nreason: ${result.reason}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Gate D word-continuation — escape-variant round (strengthen-worktree-gate-
// word-continuation, T1 RED). Cross-model Round 3 (PR #1475) non-blocking
// Suggestion, user-deferred then followed up: `literalSuffixIsWorktree`'s
// positive whitelist regex (`/^[A-Za-z0-9/._\-~@+=:%]*/`) stops scanning at
// ANY non-whitelisted character and treats whatever was scanned so far as a
// "successfully terminated" token — but not every non-whitelisted character
// actually terminates a shell word. Quotes (`'`/`"`), backslash (`\`),
// variable sigil (`$`), backtick, and parentheses are WORD-CONTINUATION
// characters: the shell keeps concatenating text across them into the SAME
// word/path argument. `.worktree/foo/..''/../.claude/worktrees/x`, once the
// shell evaluates the empty-string splice, actually resolves to
// `.worktree/foo/../../.claude/worktrees/x` → OUTSIDE `.worktree/` — but
// literalSuffixIsWorktree stops scanning at the first `'`, sees the prefix
// `.worktree/foo/..` (which STARTS WITH `.worktree/`), and — because the
// per-Fix-#2/#2b/#3 `..`-collapse logic never runs on the untruncated tail —
// falsely ALLOWS it. This test group proves (RED, before T2 tightening) that
// all six word-continuation variants below are currently allowed through
// when they should be blocked; a legitimate sanity case establishes the
// SC3 no-regression baseline for T2.
// ─────────────────────────────────────────────────────────────────────────

test('Gate D word-continuation (WC-1): empty single-quote splice escapes .worktree/ via $(pwd) → block', () => {
  const cmd =
    "git worktree add $(pwd)/.worktree/foo/..''/../.claude/worktrees/x -b chore/x HEAD";
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'empty single-quote splice (..\'\'/../.claude/worktrees/x) must be blocked — shell concatenates across the quote, escaping .worktree/'
  );
  assert.equal(result.block, true);
});

test('Gate D word-continuation (WC-2): empty double-quote splice escapes .worktree/ via $(pwd) → block', () => {
  const cmd =
    'git worktree add $(pwd)/.worktree/foo/..""/../.claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'empty double-quote splice (.."" /../.claude/worktrees/x) must be blocked — shell concatenates across the quote, escaping .worktree/'
  );
  assert.equal(result.block, true);
});

test('Gate D word-continuation (WC-3): backslash-continuation splice escapes .worktree/ via $(pwd) → block', () => {
  const cmd =
    'git worktree add $(pwd)/.worktree/foo/..\\z/../.claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'backslash splice (..\\z/../.claude/worktrees/x) must be blocked — backslash does not terminate a shell word'
  );
  assert.equal(result.block, true);
});

test('Gate D word-continuation (WC-4): variable-sigil splice escapes .worktree/ via $(pwd) → block', () => {
  const cmd =
    'git worktree add $(pwd)/.worktree/foo/..$Z/../.claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'variable-sigil splice (..$Z/../.claude/worktrees/x) must be blocked — $ introduces expansion, not a word terminator'
  );
  assert.equal(result.block, true);
});

test('Gate D word-continuation (WC-5): backtick command-substitution splice escapes .worktree/ via $(pwd) → block', () => {
  const cmd =
    'git worktree add $(pwd)/.worktree/foo/..`z`/../.claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'backtick command-substitution splice (..`z`/../.claude/worktrees/x) must be blocked — backtick does not terminate a shell word'
  );
  assert.equal(result.block, true);
});

test('Gate D word-continuation (WC-6): parenthesis splice escapes .worktree/ via $(pwd) → block', () => {
  const cmd =
    'git worktree add $(pwd)/.worktree/foo/..(z)/../.claude/worktrees/x -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.ok(
    result !== null,
    'parenthesis splice (..(z)/../.claude/worktrees/x) must be blocked — parentheses do not terminate a bare shell word'
  );
  assert.equal(result.block, true);
});

test('Gate D word-continuation sanity: $(pwd)/.worktree/foo -b chore/x HEAD (legitimate worktree add, space-terminated) → pass', () => {
  const cmd = 'git worktree add $(pwd)/.worktree/foo -b chore/x HEAD';
  const result = checkWorktreeAbsolutePath(cmd, FAKE_BASECWD);
  assert.equal(
    result,
    null,
    'legitimate .worktree/<change> path terminated by a real word boundary (space before -b) must NOT be false-blocked by tightened word-continuation handling'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Git Bash drive paths on Windows (#2841)
// ─────────────────────────────────────────────────────────────────────────

// `/c/Users/x` is how Git Bash spells `C:\Users\x`. Only Windows has that
// spelling, so the behaviour is asserted there and skipped elsewhere, where
// `/c/...` is an ordinary POSIX path and must NOT be reinterpreted.
function toGitBashDrivePath(nativePath) {
  const parsed = win32.parse(nativePath);
  const drive = parsed.root.slice(0, 1).toLowerCase();
  return `/${drive}/${nativePath.slice(parsed.root.length).replace(/\\/g, '/')}`;
}

test(
  'Gate D (#2841): a Git Bash /c/... spelling is judged against <repo-root>/.worktree/ like C:/..., for literal paths and cd anchors',
  { skip: process.platform !== 'win32' && 'Git Bash drive spellings only exist on win32' },
  () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'gate-d-gitbash-')));
    const repo = join(parent, 'repo');
    try {
      mkdirSync(repo);
      execSync('git init -q', { cwd: repo });
      const win = repo.replace(/\\/g, '/');
      const bash = toGitBashDrivePath(repo);
      assert.match(bash, /^\/[a-z]\//, `precondition: Git Bash spelling of the repo (${bash})`);
      const add = (p) => `git worktree add ${p} -b feature/x origin/main`;
      const verdict = (r) => (r ? `block: ${r.reason.slice(0, 120)}` : 'pass');

      // controls that already held before the fix
      assert.equal(checkWorktreeAbsolutePath(add(`${win}/.worktree/x`), repo), null, 'C:/ literal inside .worktree/ passes');
      assert.equal(checkWorktreeAbsolutePath(add(`${bash}/elsewhere/x`), repo)?.block, true, '/c/ literal outside .worktree/ is blocked');

      // literal spelling: same directory as the C:/ form, so the same verdict
      const literal = checkWorktreeAbsolutePath(add(`${bash}/.worktree/x`), repo);
      assert.equal(literal, null, `/c/ literal inside .worktree/ must pass (${verdict(literal)})`);

      // cd anchor: the effective path must still satisfy the .worktree/ boundary
      const wrongTarget = checkWorktreeAbsolutePath(`cd ${bash} && ${add('.claude/worktrees/x')}`, parent);
      assert.equal(wrongTarget?.block, true, 'cd /c/<repo> && a path outside .worktree/ must be blocked, not fail-open');
      assert.match(wrongTarget.reason, /Worktree Absolute Path Gate/);
      const rightTarget = checkWorktreeAbsolutePath(`cd ${bash} && ${add('.worktree/x')}`, parent);
      assert.equal(rightTarget, null, `cd /c/<repo> && .worktree/x must pass (${verdict(rightTarget)})`);

      // the C:/ spelling of the same cd anchor keeps its existing verdicts
      assert.equal(checkWorktreeAbsolutePath(`cd ${win} && ${add('.claude/worktrees/x')}`, parent)?.block, true);
      assert.equal(checkWorktreeAbsolutePath(`cd ${win} && ${add('.worktree/x')}`, parent), null);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
);

// #3507: every `git worktree add` option before <path> is skipped, including ones
// the gate never listed (`--no-track`), so an aligned command is not read as a
// relative path named after the flag.
for (const flag of ['--no-track', '--no-guess-remote', '--relative-paths', '--no-relative-paths']) {
  test(`[Scenario: pre-tool-mechanical-gates :: Options before the worktree path are not read as the path] ${flag}`, () => {
    const command = `git worktree add ${flag} -b bugfix/fix-x /abs/wt origin/main`;
    assert.equal(extractWorktreeAddPath(command), '/abs/wt');
    assert.equal(checkWorktreeAbsolutePath(command, FAKE_BASECWD), null);
    assert.equal(
      checkWorktreeAbsolutePath(`git worktree add ${flag} -b bugfix/fix-x '/abs/wt space' origin/main`, FAKE_BASECWD),
      null,
      'the raw-word scanner skips the option too, so the quoted literal path is still trusted'
    );
  });
}

test('[Scenario: pre-tool-mechanical-gates :: Options before the worktree path are not read as the path] in a real repo the path, not the flag, is judged', () => {
  const repo = makeTempGitRepo();
  try {
    const shellRepo = repo.replaceAll('\\', '/');
    assert.equal(
      checkWorktreeAbsolutePath(`git worktree add --no-track -b bugfix/fix-x ${shellRepo}/.worktree/fix-x origin/main`, repo),
      null,
      'an aligned add under <repo-root>/.worktree passes with --no-track'
    );
    const misplaced = checkWorktreeAbsolutePath(`git worktree add --no-track -b bugfix/fix-x ${shellRepo}/elsewhere/fix-x origin/main`, repo);
    assert.equal(misplaced?.block, true, 'a path outside .worktree is still blocked');
    assert.ok(misplaced.reason.includes(`${shellRepo}/elsewhere/fix-x`), `the reason names the path, not the flag\nreason: ${misplaced.reason}`);
    assert.ok(!misplaced.reason.includes('--no-track'), `reason: ${misplaced.reason}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

for (const variable of ['$W', '${W}']) {
  test(`[Scenario: pre-tool-mechanical-gates :: A variable worktree path is not reported as a relative path] ${variable}`, () => {
    const result = checkWorktreeAbsolutePath(`W=/abs/.worktree/fix-x; git worktree add -b bugfix/fix-x ${variable} origin/main`, FAKE_BASECWD);
    assert.equal(result?.block, true, 'a bare variable path stays blocked');
    assert.match(result.reason, /含 shell 變數/);
    assert.match(result.reason, /\$REPO_ROOT\/\.worktree\/<change-name>/);
    assert.match(result.reason, /git-branch-naming-and-anchor\.md §Worktree 規範/);
    assert.doesNotMatch(result.reason, /為相對路徑/, 'the reason does not call a variable a relative path');
  });
}
