/**
 * hook-post-tool-gate.test.mjs
 *
 * Tests for .devpro/scripts/hooks/post-tool-gate.mjs sentinel writer.
 *
 * Covers:
 *   PT-P1  absolute path arg → sentinel written at expected abs path
 *   PT-P2  $(git rev-parse --show-toplevel)/.worktree/foo → sentinel
 *          canonicalised to <repo-root>/.worktree/foo (no junk $( in path)
 *   PT-P3  canonicaliseWorktreePath unit: $(pwd)/<sub> → baseCwd + sub
 *   PT-B1  canonicalise exec failure → fail-open, hook exits 0, no throw
 *
 * Test strategy:
 *   - Invoke post-tool-gate.mjs via spawnSync with synthetic PostToolUse JSON
 *     payload on stdin.
 *   - Use DEVPRO_SENTINEL_STATE_DIR to redirect sentinel writes to an isolated
 *     temp dir so tests never pollute the real state dir.
 *   - For PT-P2: run inside a real git repo (mkdtempSync + git init) so
 *     `git rev-parse --show-toplevel` executes successfully.
 *   - For PT-B1: pass a non-existent cwd so the exec subprocess fails.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

const POST_TOOL_HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/post-tool-gate.mjs'
);

const tmpRoot = makeTempDir('post-tool-gate-test-');

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let dirCounter = 0;

/**
 * Create a temporary sentinel dir for isolating sentinel writes per test.
 */
function makeSentinelDir() {
  const d = path.join(tmpRoot, `sentinel-${dirCounter++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Create a minimal git repo in a temp dir. Returns the repo path.
 */
function makeGitRepo() {
  const dir = path.join(tmpRoot, `repo-${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(path.join(dir, 'x'), '');
  spawnSync('git', ['add', 'x'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/**
 * Read all sentinel files from sentinelDir. Returns array of { file, content }.
 */
function readSentinels(sentinelDir) {
  if (!existsSync(sentinelDir)) return [];
  return readdirSync(sentinelDir)
    .filter((f) => f.startsWith('pending-cd-to-worktree-'))
    .map((f) => ({
      file: f,
      content: readFileSync(path.join(sentinelDir, f), 'utf8'),
    }));
}

/**
 * Build a PostToolUse payload for a successful `git worktree add` command.
 */
function makePayload(command, cwd, exitCode = 0) {
  return {
    tool_name: 'Bash',
    tool_input: { command, cwd },
    tool_response: { exit_code: exitCode },
  };
}

/**
 * Run the post-tool-gate hook with the given payload, routing sentinel writes
 * to an isolated sentinelDir.
 */
function run(payload, sentinelDir, extraEnv = {}) {
  const result = spawnSync('node', [POST_TOOL_HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      ...extraEnv,
    },
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// PT-P1: absolute path arg → sentinel written at abs path
// ─────────────────────────────────────────────────────────────────────────

test('PT-P1: git worktree add /abs/path/.worktree/foo → sentinel at /abs/path/.worktree/foo', () => {
  const sentinelDir = makeSentinelDir();
  const payload = makePayload(
    'git worktree add /tmp/some-repo/.worktree/foo -b bugfix/test HEAD',
    '/tmp/some-repo'
  );
  const result = run(payload, sentinelDir);
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);

  const sentinels = readSentinels(sentinelDir);
  assert.equal(sentinels.length, 1, 'exactly one sentinel must be written');
  const [line1] = sentinels[0].content.split('\n');
  assert.equal(line1, '/tmp/some-repo/.worktree/foo', 'sentinel must record exact abs path');
  assert.ok(
    !line1.includes('$('),
    'sentinel path must not contain shell expansion tokens'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// PT-P2: $(git rev-parse --show-toplevel)/.worktree/foo → canonicalised
// ─────────────────────────────────────────────────────────────────────────

test('PT-P2: $(git rev-parse --show-toplevel)/.worktree/foo → sentinel at <repo-root>/.worktree/foo', () => {
  const repoDir = makeGitRepo();
  const sentinelDir = makeSentinelDir();

  // Get the real repo root so we can assert against it
  const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).stdout.trim();
  assert.ok(repoRoot && path.isAbsolute(repoRoot), 'git rev-parse must return abs path');

  const payload = makePayload(
    'git worktree add $(git rev-parse --show-toplevel)/.worktree/foo -b bugfix/test HEAD',
    repoDir
  );
  const result = run(payload, sentinelDir);
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);

  const sentinels = readSentinels(sentinelDir);
  assert.equal(sentinels.length, 1, 'exactly one sentinel must be written');
  const [line1] = sentinels[0].content.split('\n');

  assert.ok(
    !line1.includes('$('),
    `sentinel path must not contain shell expansion tokens; got: ${line1}`
  );
  assert.ok(
    path.isAbsolute(line1),
    `sentinel path must be absolute; got: ${line1}`
  );
  assert.equal(
    line1,
    repoRoot + '/.worktree/foo',
    `sentinel must be <repo-root>/.worktree/foo; got: ${line1}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// PT-P3: $(pwd)/.worktree/foo → baseCwd + /.worktree/foo
// ─────────────────────────────────────────────────────────────────────────

test('PT-P3: $(pwd)/.worktree/foo → sentinel at <cwd>/.worktree/foo', () => {
  const sentinelDir = makeSentinelDir();
  const baseCwd = '/tmp/some-cwd';
  const payload = makePayload(
    'git worktree add $(pwd)/.worktree/foo -b bugfix/test HEAD',
    baseCwd
  );
  const result = run(payload, sentinelDir);
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);

  const sentinels = readSentinels(sentinelDir);
  assert.equal(sentinels.length, 1, 'exactly one sentinel must be written');
  const [line1] = sentinels[0].content.split('\n');

  assert.ok(
    !line1.includes('$('),
    `sentinel path must not contain shell expansion tokens; got: ${line1}`
  );
  assert.ok(
    path.isAbsolute(line1),
    `sentinel path must be absolute; got: ${line1}`
  );
  assert.equal(
    line1,
    baseCwd + '/.worktree/foo',
    `sentinel must be <cwd>/.worktree/foo; got: ${line1}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// PT-P4: $VAR / ${VAR} path → unresolved expansion → NO sentinel (fail-open)
//   canonicaliseWorktreePath* only resolve $() command-substitution; a plain
//   shell variable (e.g. the canonical `git worktree add "$REPO_ROOT/..."` from
//   /dp:change) survives unresolved and path.resolve() yields a bogus nested
//   path. The hook must skip the sentinel rather than emit a false advisory.
// ─────────────────────────────────────────────────────────────────────────

test('PT-P4a: git worktree add "$REPO_ROOT/.worktree/foo" → no sentinel (unresolved $VAR)', () => {
  const sentinelDir = makeSentinelDir();
  const payload = makePayload(
    'git worktree add "$REPO_ROOT/.worktree/foo" -b chore/test main',
    '/tmp/some-repo'
  );
  const result = run(payload, sentinelDir);
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);

  const sentinels = readSentinels(sentinelDir);
  assert.equal(
    sentinels.length,
    0,
    `no sentinel for unresolved $VAR path; got: ${JSON.stringify(sentinels.map((s) => s.content.split('\n')[0]))}`
  );
});

test('PT-P4b: git worktree add ${REPO_ROOT}/.worktree/foo → no sentinel (unresolved ${VAR})', () => {
  const sentinelDir = makeSentinelDir();
  const payload = makePayload(
    'git worktree add ${REPO_ROOT}/.worktree/foo -b chore/test main',
    '/tmp/some-repo'
  );
  const result = run(payload, sentinelDir);
  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);

  const sentinels = readSentinels(sentinelDir);
  assert.equal(
    sentinels.length,
    0,
    `no sentinel for unresolved \${VAR} path; got: ${JSON.stringify(sentinels.map((s) => s.content.split('\n')[0]))}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// PT-B1: canonicalise exec failure → fail-open, hook exits 0, no throw
// ─────────────────────────────────────────────────────────────────────────

test('PT-B1: canonicalise failure (bad cwd) → fail-open, hook exits 0', () => {
  const sentinelDir = makeSentinelDir();
  const nonExistentCwd = '/tmp/does-not-exist-at-all-xyz-12345';

  const payload = makePayload(
    'git worktree add $(git rev-parse --show-toplevel)/.worktree/foo -b bugfix/test HEAD',
    nonExistentCwd
  );
  const result = run(payload, sentinelDir);

  // Hook must never throw / crash; exit code must be 0 (fail-open)
  assert.equal(result.status, 0, `hook must exit 0 even on canonicalise failure; stderr: ${result.stderr}`);

  // The hook may or may not write a sentinel depending on fallback behaviour;
  // what matters is that it does not crash.
  // If a sentinel was written, it should not cause an error.
  const sentinels = readSentinels(sentinelDir);
  for (const s of sentinels) {
    assert.ok(typeof s.content === 'string', 'any written sentinel must have string content');
  }
});
