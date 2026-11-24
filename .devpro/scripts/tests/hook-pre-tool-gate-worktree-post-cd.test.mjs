/**
 * hook-pre-tool-gate-worktree-post-cd.test.mjs
 *
 * Gate D' — Worktree Post-Creation CD Gate unit tests.
 * Covers: pre-tool-gate.mjs exported sentinel functions:
 *   writePendingCdSentinel, scanPendingCdSentinels, clearPendingCdSentinel
 *   and checkPendingWorktreeCd for integration flow.
 *
 * Per P4 Gate D' spec: pre-tool-gate.mjs §Gate D' (T11)
 * Sentinel lifecycle: written by PostToolUse after git worktree add succeeds;
 * cleared when next Bash command begins with `cd <absWtPath>`.
 * TTL: 1 day (SENTINEL_TTL_MS = 86_400_000 ms).
 *
 * Test strategy:
 *   - Use DEVPRO_SENTINEL_STATE_DIR env override to isolate sentinel state
 *     per-test in a temp dir — prevents cross-test pollution.
 *   - Import sentinel functions directly (pure logic, no I/O side-effects
 *     beyond the isolated sentinel dir).
 *   - (a) writePendingCdSentinel writes file with abs path content
 *   - (b) next cd command clears the sentinel
 *   - (c) non-cd command after sentinel → advisory emitted (warn-only, no block)
 *   - (d) TTL > 1 day → scanPendingCdSentinels deletes expired
 *   - (e) multiple worktree sentinels tracked independently
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

// ─────────────────────────────────────────────────────────────────────────
// We must load pre-tool-gate.mjs with an isolated SENTINEL_STATE_DIR.
// The module reads DEVPRO_SENTINEL_STATE_DIR at import time, so we set the
// env var before dynamic import. Each test creates its own sentinelDir.
// ─────────────────────────────────────────────────────────────────────────

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/pre-tool-gate.mjs'
);

// Create a shared temp root for all sentinel dirs in this test file.
const tmpRoot = makeTempDir('gate-d-prime-test-');

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

/**
 * Create an isolated sentinel dir and import the hook module with that dir.
 * Returns the module exports (sentinel functions) bound to the isolated dir.
 *
 * Note: Node ESM caches modules by specifier, so we cannot reload the module
 * with a different env var. Instead, we directly manipulate files in the
 * sentinel dir and use the exported functions which read SENTINEL_DIR at
 * module-init time.
 *
 * Strategy: Set env BEFORE first import; subsequent tests create fresh
 * sentinel dirs and write files directly to test scanPendingCdSentinels.
 */

// Set env before importing module so SENTINEL_DIR uses our temp dir.
const masterSentinelDir = path.join(tmpRoot, 'sentinel-master');
mkdirSync(masterSentinelDir, { recursive: true });
process.env.DEVPRO_SENTINEL_STATE_DIR = masterSentinelDir;

const {
  writePendingCdSentinel,
  scanPendingCdSentinels,
  clearPendingCdSentinel,
  checkPendingWorktreeCd,
  SENTINEL_TTL_MS,
} = await import(pathToFileURL(HOOK).href);

// ─────────────────────────────────────────────────────────────────────────
// Helper: clean up all sentinel files in masterSentinelDir between tests
// ─────────────────────────────────────────────────────────────────────────
function cleanSentinelDir() {
  try {
    const files = readdirSync(masterSentinelDir).filter(f =>
      f.startsWith('pending-cd-to-worktree-')
    );
    for (const f of files) {
      try { rmSync(path.join(masterSentinelDir, f)); } catch {}
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────
// Test (a): writePendingCdSentinel writes file with abs path + timestamp
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (a): writePendingCdSentinel creates file containing abs path', () => {
  cleanSentinelDir();
  const absWtPath = '/abs/repo/.worktree/my-feature';
  writePendingCdSentinel(absWtPath);

  const basename = path.basename(absWtPath);
  const sentinelFile = path.join(masterSentinelDir, `pending-cd-to-worktree-${basename}`);
  assert.ok(existsSync(sentinelFile), `sentinel file must exist: ${sentinelFile}`);

  const content = readFileSync(sentinelFile, 'utf8').trim();
  const [line1, line2] = content.split('\n');
  assert.equal(line1.trim(), absWtPath, 'first line must be the abs path');
  assert.ok(/^\d+$/.test(line2.trim()), 'second line must be epoch ms (digits only)');

  cleanSentinelDir();
});

// ─────────────────────────────────────────────────────────────────────────
// Test (b): next command is `cd <absWtPath>` → sentinel is cleared
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (b): cd <absWtPath> command clears the sentinel', () => {
  cleanSentinelDir();
  const absWtPath = '/abs/repo/.worktree/clear-test';
  writePendingCdSentinel(absWtPath);

  // Verify sentinel was written
  const basename = path.basename(absWtPath);
  const sentinelFile = path.join(masterSentinelDir, `pending-cd-to-worktree-${basename}`);
  assert.ok(existsSync(sentinelFile), 'sentinel must exist before cd check');

  // Simulate next Bash command = cd <absWtPath>
  const cdCmd = `cd ${absWtPath}`;
  const advisory = checkPendingWorktreeCd(cdCmd);

  // Sentinel should be cleared (matched)
  assert.equal(existsSync(sentinelFile), false, 'sentinel must be cleared after matching cd');
  // No advisory emitted when sentinel is matched
  assert.equal(advisory, null, 'no advisory for matching cd command');

  cleanSentinelDir();
});

// ─────────────────────────────────────────────────────────────────────────
// Test (c): next command is NOT cd → warn advisory emitted (not a block)
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (c): non-cd command after sentinel → advisory (warn-only, no block)', () => {
  cleanSentinelDir();
  const absWtPath = '/abs/repo/.worktree/warn-test';
  writePendingCdSentinel(absWtPath);

  // Simulate next Bash command = git status (not cd)
  const result = checkPendingWorktreeCd('git status');

  // Must emit advisory (warn-only — D8 exception to D2 block policy)
  assert.ok(result !== null, 'must return advisory object when sentinel present and no cd');
  assert.ok('advisory' in result, 'result must have advisory field (not block)');
  assert.ok(
    result.advisory.includes(absWtPath),
    `advisory must mention the worktree path\nadvisory: ${result.advisory}`
  );
  assert.ok(
    !('block' in result),
    'warn-only — result must NOT have block field'
  );

  cleanSentinelDir();
});

// ─────────────────────────────────────────────────────────────────────────
// Test (d): sentinel with TTL > 1 day → scanPendingCdSentinels deletes it
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (d): expired sentinel (TTL > 1 day) is auto-deleted by scanPendingCdSentinels', () => {
  cleanSentinelDir();
  const absWtPath = '/abs/repo/.worktree/expired-test';
  const basename = path.basename(absWtPath);
  const sentinelFile = path.join(masterSentinelDir, `pending-cd-to-worktree-${basename}`);

  // Write sentinel with epoch = now - (TTL + 1 second) to simulate expiry
  const expiredEpoch = Date.now() - SENTINEL_TTL_MS - 1000;
  mkdirSync(masterSentinelDir, { recursive: true });
  writeFileSync(sentinelFile, `${absWtPath}\n${expiredEpoch}`);
  assert.ok(existsSync(sentinelFile), 'expired sentinel must exist before scan');

  // scanPendingCdSentinels should delete expired files and return empty
  const valid = scanPendingCdSentinels();
  assert.equal(valid.length, 0, 'expired sentinel must be removed; valid list must be empty');
  assert.equal(existsSync(sentinelFile), false, 'expired sentinel file must be deleted');

  cleanSentinelDir();
});

// ─────────────────────────────────────────────────────────────────────────
// Test (e): multiple worktree sentinels tracked independently
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (e): multiple sentinel files are tracked independently', () => {
  cleanSentinelDir();
  const paths = [
    '/abs/repo/.worktree/feature-a',
    '/abs/repo/.worktree/feature-b',
    '/abs/repo/.worktree/feature-c',
  ];
  for (const p of paths) {
    writePendingCdSentinel(p);
  }

  const valid = scanPendingCdSentinels();
  assert.equal(valid.length, 3, 'all 3 sentinels must exist and be valid');

  const absPaths = valid.map(s => s.absPath).sort();
  assert.deepEqual(absPaths, paths.sort(), 'each sentinel must track its own abs path');

  // Clear one sentinel and verify others remain
  clearPendingCdSentinel(paths[0]);
  const afterClear = scanPendingCdSentinels();
  assert.equal(afterClear.length, 2, 'clearing one sentinel must leave the other two');

  cleanSentinelDir();
});

// ─────────────────────────────────────────────────────────────────────────
// Regression (f): One-shot semantics — second non-cd command gets NO advisory
// Verifies Bug A fix: unmatched sentinels are cleared after first warn so
// subsequent Bash invocations do not repeat the advisory.
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (f) regression: one-shot semantics — second non-cd Bash gets no advisory', () => {
  cleanSentinelDir();
  const absWtPath = '/abs/repo/.worktree/one-shot-test';
  writePendingCdSentinel(absWtPath);

  // First non-cd command: sentinel present → advisory emitted AND sentinel cleared
  const result1 = checkPendingWorktreeCd('git status');
  assert.ok(result1 !== null, 'first non-cd cmd must return advisory when sentinel exists');
  assert.ok('advisory' in result1, 'first result must have advisory field');
  assert.ok(
    result1.advisory.includes(absWtPath),
    `advisory must mention the worktree path\nadvisory: ${result1.advisory}`
  );

  // Verify sentinel was cleared after the first warn (one-shot)
  const remaining = scanPendingCdSentinels();
  assert.equal(remaining.length, 0, 'sentinel must be cleared after first warn (one-shot)');

  // Second non-cd command: no sentinel → no advisory
  const result2 = checkPendingWorktreeCd('ls -la');
  assert.equal(result2, null, 'second non-cd cmd must return null (no repeated advisory)');

  cleanSentinelDir();
});

// ─────────────────────────────────────────────────────────────────────────
// Regression (g): Test fixture isolation — sentinel in a different dir is
// not visible to checkPendingWorktreeCd which operates on masterSentinelDir.
// Verifies Bug B fix: isolated state dirs prevent cross-test sentinel leakage.
// ─────────────────────────────────────────────────────────────────────────

test('Gate D\' (g) regression: sentinel in isolated dir not visible to hook using different dir', () => {
  cleanSentinelDir();

  // Create a separate "outer" sentinel dir simulating a real worktree state dir
  const outerSentinelDir = makeTempDir('outer-sentinel-');
  try {
    // Write a sentinel directly into the outer dir (bypassing writePendingCdSentinel
    // which uses masterSentinelDir). This simulates a sentinel from a prior session.
    const absWtPath = '/abs/repo/.worktree/outer-worktree';
    const basename = path.basename(absWtPath);
    const outerFile = path.join(outerSentinelDir, `pending-cd-to-worktree-${basename}`);
    mkdirSync(outerSentinelDir, { recursive: true });
    writeFileSync(outerFile, `${absWtPath}\n${Date.now()}`);

    // The outer sentinel exists in outerSentinelDir, but checkPendingWorktreeCd
    // (imported with masterSentinelDir) must NOT see it — different state dirs.
    // masterSentinelDir is empty.
    const result = checkPendingWorktreeCd('git log --oneline');
    assert.equal(
      result,
      null,
      'hook must not see sentinel from a different (outer) state dir — fixture isolation holds'
    );

    // masterSentinelDir still empty
    const masterSentinels = scanPendingCdSentinels();
    assert.equal(masterSentinels.length, 0, 'masterSentinelDir must remain empty');
  } finally {
    try { rmSync(outerSentinelDir, { recursive: true, force: true }); } catch {}
  }

  cleanSentinelDir();
});
