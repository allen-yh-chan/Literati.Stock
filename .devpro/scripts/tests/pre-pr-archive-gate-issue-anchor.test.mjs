/**
 * pre-pr-archive-gate-issue-anchor.test.mjs
 *
 * Gate B (check d) — Issue Anchor Verification check unit tests.
 * Covers: pre-pr-archive-gate.mjs check (d): latest archive proposal must
 * contain ## Issue Anchor Verification heading with grep evidence.
 *
 * Per P4 Gate B spec: pre-pr-archive-gate.mjs §(d)
 * Introduced by chore enforce-hook-backed-rule-system-and-rationalize-ssot
 * to prevent "issue 字面照抄未驗證 current repo state" class of errors.
 *
 * Test strategy:
 *   - Setup temp dir with archive folder + proposal.md
 *   - Run pre-pr-archive-gate.mjs with temp dir as cwd argument
 *   - Verify exit code + stderr message
 *
 * All proposals also include ## Why + ## What Changes (required by check c)
 * so those gates don't interfere with the check (d) being tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

/**
 * Minimum valid content for sections other than the one being tested.
 * Must pass check (c): ## Why + ## What Changes
 */
const COMMON_SUFFIX =
  '## Why\n\ntest fixture for check (d)\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Requirement Ledger\n\n' +
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n' +
  '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
  '## Section 3: Tasks\n\n' +
  '- [x] [Req: R1] fixture task coverage\n\n' +
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n\n';

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

/**
 * Setup an archive fixture with a specs/ dir + promoted canonical spec.
 * This is required because pre-pr-archive-gate.mjs exits 0 (Chore A pass-through)
 * when latestSpecsDir does NOT exist, skipping checks (d) and (e).
 * To reach check (d), we need specs/ to exist AND all caps promoted.
 */
function setupArchiveFixture(proposalContent) {
  const dir = makeTempDir('gate-b-anchor-test-');
  const archiveName = '2026-05-01-test-change';
  const archiveDir = path.join(dir, 'openspec/changes/archive', archiveName);
  const capName = 'test-capability';

  // Archive specs/ dir — needed so gate reaches check (d)
  const archiveSpecDir = path.join(archiveDir, 'specs', capName);
  mkdirSync(archiveSpecDir, { recursive: true });
  writeFileSync(path.join(archiveSpecDir, 'spec.md'), '# test-capability Spec Delta\n');

  // Canonical spec — must exist for check (b) to pass
  const canonicalSpecDir = path.join(dir, 'openspec/specs', capName);
  mkdirSync(canonicalSpecDir, { recursive: true });
  writeFileSync(path.join(canonicalSpecDir, 'spec.md'), '# test-capability Specification\n## Purpose\nx\n## Requirements\n');

  writeFileSync(path.join(archiveDir, 'proposal.md'), proposalContent);
  writeFileSync(path.join(archiveDir, 'brd.md'), VALID_BRD_FIXTURE);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture baseline');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

function run(dir) {
  // Scope the archive-specific checks to the fixture under test.
  return spawnSync('node', [GATE, dir], {
    encoding: 'utf8',
    env: { ...process.env, DEVPRO_RELEVANT_ARCHIVES: '2026-05-01-test-change' },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────

test('Gate B (check d) happy: proposal.md has ## Issue Anchor Verification + grep keyword → exit 0', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_SUFFIX +
    '## Issue Anchor Verification\n\n' +
    '`grep -F "enforce-hook-backed" .devpro/agent-rules/rule-design-principles.md` → 1 hit @ rule-design-principles.md:132\n\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 but got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (a): missing ## Issue Anchor Verification section entirely → exit 1
// ─────────────────────────────────────────────────────────────────────────

test('Gate B (check d) adversarial (a): no ## Issue Anchor Verification section → exit 1', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_SUFFIX;
  // No ## Issue Anchor Verification section at all
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}`);
    assert.ok(
      r.stderr.includes('Issue Anchor Verification') || r.stderr.includes('(d)'),
      `stderr must reference check (d) or "Issue Anchor Verification"\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (b): section exists but content is empty (only heading) → exit 1
// ─────────────────────────────────────────────────────────────────────────

test('Gate B (check d) adversarial (b): ## Issue Anchor Verification section exists but body empty → exit 1', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_SUFFIX +
    '## Issue Anchor Verification\n\n';
  // Section heading present but no content after it
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (c): section has description but no grep keyword and no :N ref → exit 1
// ─────────────────────────────────────────────────────────────────────────

test('Gate B (check d) adversarial (c): section has text but no grep keyword and no :N → exit 1', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_SUFFIX +
    '## Issue Anchor Verification\n\n' +
    'The issue anchor was verified manually by reading the file.\n\n';
  // No "grep" and no ":N" line ref pattern
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial (d): section contains :42 (line ref) but no grep keyword → exit 0
//   The gate accepts either grep keyword OR :N line ref pattern.
// ─────────────────────────────────────────────────────────────────────────

test('Gate B (check d) adversarial (d): section has :42 line ref (no grep keyword) → exit 0', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_SUFFIX +
    '## Issue Anchor Verification\n\n' +
    'Verified anchor at rule-design-principles.md:42 — heading confirmed present.\n\n';
  // Has :N pattern but not "grep" — gate accepts either one
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 but got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
