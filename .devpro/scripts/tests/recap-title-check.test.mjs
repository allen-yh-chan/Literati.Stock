/**
 * recap-title-check.test.mjs
 *
 * Direct tests for .devpro/scripts/recap-title-check.mjs (spawnSync).
 * Covers exit 0 (valid), exit 1 (format violation), exit 2 (missing/empty).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../recap-title-check.mjs'
);

/**
 * Run the script with --title <title>.
 * Pass input:'' to avoid inheriting real stdin when no --title-stdin is used.
 */
function runCheck(title) {
  return spawnSync('node', [SCRIPT, '--title', title], {
    encoding: 'utf8',
    input: '',
  });
}

/**
 * Run the script with no arguments (test missing-title / exit 2 path).
 * Use stdio: 'pipe' + input:'' to prevent blocking on stdin.
 */
function runCheckNoArgs() {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    input: '',
  });
}

// ── exit 0 cases (valid titles) ───────────────────────────────────────────────

test('exit 0: canonical format [devpro-agent-rules] my-change 2026-06-07', () => {
  const r = runCheck('[devpro-agent-rules] my-change 2026-06-07');
  assert.equal(r.status, 0, `Expected exit 0\nstderr: ${r.stderr}`);
  assert.ok(r.stdout.includes('OK'), `Expected OK in stdout\nstdout: ${r.stdout}`);
});

test('exit 0: change name with slash (feature/x) → [some-repo] feature/x 2026-01-01', () => {
  const r = runCheck('[some-repo] feature/x 2026-01-01');
  assert.equal(r.status, 0, `Expected exit 0\nstderr: ${r.stderr}`);
});

// ── exit 1 cases (format violations) ─────────────────────────────────────────

test('exit 1: #946 variant — Session Recap: bugfix/fix-verb-position-gate-gaps (PR #933)', () => {
  const r = runCheck('Session Recap: bugfix/fix-verb-position-gate-gaps (PR #933)');
  assert.equal(r.status, 1, `Expected exit 1\nstderr: ${r.stderr}`);
  assert.ok(r.stderr.length > 0, 'Expected error message on stderr');
});

test('exit 1: missing [repo] prefix — my-change 2026-06-07', () => {
  const r = runCheck('my-change 2026-06-07');
  assert.equal(r.status, 1, `Expected exit 1\nstderr: ${r.stderr}`);
});

test('exit 1: bad date (single-digit month/day) — [repo] x 2026-6-7', () => {
  const r = runCheck('[repo] x 2026-6-7');
  assert.equal(r.status, 1, `Expected exit 1\nstderr: ${r.stderr}`);
});

test('exit 1: missing space after ] — [repo]x 2026-06-06', () => {
  const r = runCheck('[repo]x 2026-06-06');
  assert.equal(r.status, 1, `Expected exit 1\nstderr: ${r.stderr}`);
});

// ── newline boundary cases (TITLE_RE separators must be literal single-space,
//    NOT \s — \s matches \n/\r/\t and would wave through a multi-line title) ──

test('exit 1: newline after ] prefix — [repo]\\nx 2026-06-07 (multi-line rejected)', () => {
  const r = runCheck('[repo]\nx 2026-06-07');
  assert.equal(r.status, 1, `Multi-line title must be rejected\nstderr: ${r.stderr}`);
});

test('exit 1: newline before date — [repo] x\\n2026-06-07 (multi-line rejected)', () => {
  const r = runCheck('[repo] x\n2026-06-07');
  assert.equal(r.status, 1, `Multi-line title must be rejected\nstderr: ${r.stderr}`);
});

test('exit 1: trailing newline + extra line after valid title (rejected)', () => {
  const r = runCheck('[repo] x 2026-06-07\nextra');
  assert.equal(r.status, 1, `Title with trailing extra line must be rejected\nstderr: ${r.stderr}`);
});

test('exit 1: tab separator instead of space — [repo]\\tx\\t2026-06-07 (rejected)', () => {
  const r = runCheck('[repo]\tx\t2026-06-07');
  assert.equal(r.status, 1, `Tab-separated title must be rejected\nstderr: ${r.stderr}`);
});

test('exit 0: multi-word change name keeps inner spaces — [repo] multi word change 2026-06-07', () => {
  const r = runCheck('[repo] multi word change 2026-06-07');
  assert.equal(r.status, 0, `Multi-word change name must still pass\nstderr: ${r.stderr}`);
});

// ── exit 2 cases (missing / empty title) ─────────────────────────────────────

test('exit 2: empty title string — --title ""', () => {
  const r = runCheck('');
  assert.equal(r.status, 2, `Expected exit 2\nstderr: ${r.stderr}`);
  assert.ok(
    r.stderr.includes('empty or missing'),
    `Expected 'empty or missing' in stderr\nstderr: ${r.stderr}`
  );
});

test('exit 2: no --title flag and no stdin', () => {
  const r = runCheckNoArgs();
  assert.equal(r.status, 2, `Expected exit 2\nstderr: ${r.stderr}`);
  assert.ok(
    r.stderr.includes('empty or missing'),
    `Expected 'empty or missing' in stderr\nstderr: ${r.stderr}`
  );
});
