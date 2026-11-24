/**
 * hook-pre-pr-archive-gate-dedup-audit.test.mjs
 *
 * Gate G (check g) — Dedup Audit unit tests.
 * Covers: pre-pr-archive-gate.mjs check (g): when an authoritative bounded
 * source-governance topology triggers, the proposal must contain
 * ## File-Role Ledger + ## Dedup Audit 三步結果 sections.
 *
 * Per BRD R8 pattern: ≥ 1 happy + ≥ 4 adversarial.
 * Introduced by chore enforce-dedup-audit-gate-and-trim-ai-autonomy to prevent
 * PR #396 Commit 1 class of skipping mandatory dedup audit.
 *
 * Test strategy:
 *   - Setup temp dir with archive folder + proposal.md (mkdtempSync + os.tmpdir())
 *   - Run pre-pr-archive-gate.mjs with temp dir as cwd argument
 *   - Verify exit code + stderr message
 *
 * All proposals also include ## Why + ## What Changes (check c),
 * ## Issue Anchor Verification with grep evidence (check d) so that gate does
 * not interfere with check (g) being tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

/**
 * Minimum valid content for sections other than the one being tested.
 * Must pass check (c): ## Why + ## What Changes
 * Must pass check (d): ## Issue Anchor Verification + grep evidence
 * Gate (e) measures the authoritative carrier manifest directly; proposals do
 * not carry token/readability evidence.
 */
const COMMON_PREFIX =
  '## Why\n\ntest fixture for check (g)\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Requirement Ledger\n\n' +
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n' +
  '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
  '## Section 3: Tasks\n\n' +
  '- [x] [Req: R1] fixture task coverage\n\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "anchor" fixture.md` → 1 hit @ fixture.md:1\n\n' +
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n\n';

/**
 * Setup an archive fixture with a specs/ dir + promoted canonical spec.
 * This is required because pre-pr-archive-gate.mjs exits 0 (Chore A pass-through)
 * when latestSpecsDir does NOT exist, skipping check (g).
 * To reach check (g), we need specs/ to exist AND all caps promoted,
 * AND checks (d) and (e) to pass.
 */
function setupArchiveFixture(proposalContent) {
  const dir = makeTempDir('gate-g-dedup-audit-test-');
  const archiveName = '2026-05-01-test-change';
  const archiveDir = path.join(dir, 'openspec/changes/archive', archiveName);
  const capName = 'test-capability';

  // Archive specs/ dir — needed so gate reaches check (g)
  const archiveSpecDir = path.join(archiveDir, 'specs', capName);
  mkdirSync(archiveSpecDir, { recursive: true });
  writeFileSync(path.join(archiveSpecDir, 'spec.md'), '# test-capability Spec Delta\n');

  // Canonical spec — must exist for check (b) to pass
  const canonicalSpecDir = path.join(dir, 'openspec/specs', capName);
  mkdirSync(canonicalSpecDir, { recursive: true });
  writeFileSync(path.join(canonicalSpecDir, 'spec.md'), '# test-capability Specification\n## Purpose\nx\n## Requirements\n');

  writeFileSync(path.join(archiveDir, 'proposal.md'), proposalContent);
  writeFileSync(path.join(archiveDir, 'brd.md'), VALID_BRD_FIXTURE);
  return dir;
}

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function run(dir, { topology = 'source' } = {}) {
  assert.match(topology, /^(?:source|consumer|none)$/);
  if (!existsSync(path.join(dir, '.git'))) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'config', 'user.name', 'Fixture');
    if (topology === 'source') {
      mkdirSync(path.join(dir, '.devpro/scripts'), { recursive: true });
      mkdirSync(path.join(dir, '.devpro/agent-rules'), { recursive: true });
      writeFileSync(path.join(dir, '.devpro/scripts/pre-pr-archive-gate.mjs'), '');
      writeFileSync(path.join(dir, '.devpro/agent-rules/rule-audit-playbook.md'), '# sentinel\n');
      writeFileSync(path.join(dir, '.devpro/agent-rules/deleted-rule.md'), '# removed\n');
      git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');
    }
    if (topology === 'consumer') {
      mkdirSync(path.join(dir, '.devpro-agent-rules/.devpro/scripts'), { recursive: true });
      mkdirSync(path.join(dir, '.devpro/agent-rules'), { recursive: true });
      writeFileSync(path.join(dir, '.devpro-agent-rules/AGENTS.md'), '# installed consumer rules\n');
      writeFileSync(path.join(dir, '.devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs'), '');
      writeFileSync(path.join(dir, '.devpro/agent-rules/deleted-rule.md'), '# removed consumer carrier\n');
      git(dir, 'remote', 'add', 'origin', 'https://example.invalid/consumer.git');
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fixture baseline');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    if (topology !== 'none') rmSync(path.join(dir, '.devpro/agent-rules/deleted-rule.md'));
  }
  // Scope archive-specific checks to the fixture under test.
  return spawnSync('node', [GATE, dir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_RELEVANT_ARCHIVES: '2026-05-01-test-change',
      DEVPRO_PR_TOUCHED_RULE_FILES: topology !== 'none'
        ? '.devpro/agent-rules/deleted-rule.md'
        : '',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// (a) Happy: definite source topology + both valid sections → exit 0
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) happy (a): definite source deletion + valid File-Role Ledger and Dedup Audit → exit 0', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    '| 檔案 | routing trigger / role | split-gate rationale | duplication classification |\n' +
    '|---|---|---|---|\n' +
    '| old-file.md | file merge target | P2 file merge consolidation | true duplication |\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '1. 守則 3「leaf 自含 > DRY」評估：兩檔內容完全重複無分支邏輯差異。\n' +
    '2. 守則 4「token-first」評估：合併後省 200 tokens，符合 token-first 原則。\n' +
    '3. 每 hotspot：token-first violation 確認，合併正當。\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 but got ${r.status}\nstderr: ${r.stderr}`);

    // Proposal token prose was removed; conditional source ledgers remain in-order.
    const templatePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../agent-rules/proposal-template.md'
    );
    const templateBody = readFileSync(templatePath, 'utf8');
    const issueAnchorIdx = templateBody.indexOf('## Issue Anchor Verification');
    const fileLedgerIdx = templateBody.indexOf('## File-Role Ledger');
    assert.ok(
      fileLedgerIdx > issueAnchorIdx,
      `## File-Role Ledger (idx ${fileLedgerIdx}) must appear after ## Issue Anchor Verification (idx ${issueAnchorIdx}) in proposal-template.md`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (b) Adversarial: definite source topology but both sections missing → exit 1
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) adversarial (b): definite source deletion with both required sections missing → exit 1', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    'This proposal intentionally omits the source-governance ledgers.\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}`);
    assert.ok(
      r.stderr.includes('Gate G Dedup Audit'),
      `stderr must reference "Gate G Dedup Audit"\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (c) Adversarial: sections exist but content empty (heading only) → exit 1
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) adversarial (c): sections exist but body empty (heading only) → exit 1', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    '## Dedup Audit 三步結果\n';
  // Both headings present but no content in either section
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('Gate G Dedup Audit'),
      `stderr must reference "Gate G Dedup Audit"\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (d) Definite source topology cannot be waived with N/A, even with evidence.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) definite source deletion rejects File-Role Ledger: N/A even with grep evidence', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    'File-Role Ledger: N/A — 無 file delete/merge\n\n' +
    '`grep -nE "rm |git mv|file merge" proposal-mini.md` → 0 hits\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '守則 3「leaf 自含 > DRY」+ 守則 4「token-first」: 本 PR 無 dedup，跳過。\n\n' +
    'Dedup Audit: N/A — 無 dedup 操作\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /definite source-governance topology/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (e) Definite topology also rejects an unsupported plain N/A.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) definite source deletion rejects File-Role Ledger: N/A without evidence', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    'File-Role Ledger: N/A — 無 file delete/merge\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '守則 3「leaf 自含 > DRY」+ 守則 4「token-first」: 本 PR 無 dedup。\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('Gate G Dedup Audit'),
      `stderr must reference "Gate G Dedup Audit"\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (f) Markdown emphasis does not turn N/A into a valid definite-topology ledger.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) definite source deletion rejects bold **N/A** with grep evidence', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    'File-Role Ledger: **N/A** — 無 file delete/merge\n\n' +
    '`grep -nE "rm |git mv|file merge" proposal.md` → 0 hits\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '守則 3「leaf 自含 > DRY」+ 守則 4「token-first」: 本 PR 無 dedup，跳過。\n\n' +
    'Dedup Audit: N/A — 無 dedup 操作\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 but got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /definite source-governance topology/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) explicit bold N/A cannot pass by mentioning a valid classification phrase', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    'File-Role Ledger: **N/A** — no true duplication applies after review\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '守則 3「leaf 自含 > DRY」與守則 4「token-first」均已完成。\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `explicit N/A must override incidental classification prose\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /File-Role Ledger: N\/A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (h) Definite topology rejects malformed N/A just as it rejects plain N/A.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) definite source deletion rejects malformed *N/A with grep evidence', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    'File-Role Ledger: *N/A — 無 file delete/merge\n\n' +
    '`grep -nE "rm |git mv|file merge" proposal.md` → 0 hits\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '守則 3「leaf 自含 > DRY」+ 守則 4「token-first」: 本 PR 無 dedup，跳過。\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 (malformed single-star must not count as N/A) but got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('Gate G Dedup Audit'),
      `stderr must reference "Gate G Dedup Audit"\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (j) Unclosed bold N/A is likewise not a valid classification ledger.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) definite source deletion rejects unclosed **N/A with grep evidence', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    '## File-Role Ledger\n\n' +
    'File-Role Ledger: **N/A — 無 file delete/merge\n\n' +
    '`grep -nE "rm |git mv|file merge" proposal.md` → 0 hits\n\n' +
    '## Dedup Audit 三步結果\n\n' +
    '守則 3「leaf 自含 > DRY」+ 守則 4「token-first」: 本 PR 無 dedup，跳過。\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir);
    assert.equal(r.status, 1, `expected exit 1 (unclosed bold must not count as N/A) but got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('Gate G Dedup Audit'),
      `stderr must reference "Gate G Dedup Audit"\nstderr: ${r.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (i) A B-mini with no bounded carrier candidate does not need full-proposal
//     source-governance sections.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) B-mini with no bounded candidate requires neither ledger heading nor N/A → exit 0', () => {
  // Build a normal fixture, then convert it to a B-mini archive: replace
  // proposal.md with proposal-mini.md and no source-governance ledger heading.
  const miniBody =
    '# Proposal (mini): some-bmini-change\n\n' +
    '## Why\n\nTighten a mechanical gate.\n\n' +
    '## What Changes\n\n' +
    'Add a test case in `hook-pre-pr-archive-gate-dedup-audit.test.mjs`.\n\n' +
    '## Requirement Ledger\n\n' +
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
    // Task carries a [Req: R#] anchor AND a 驗收 line so check (o) (task-checkbox
    // execution-state gate) passes; this test targets check (g)'s B-mini exemption,
    // and a legitimate B-mini archive always has a complete task ledger.
    '## Tasks\n\n- [x] T1: edit regex [Req: R1]\n  - 驗收: regex unit test green\n\n' +
    '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';
  const dir = setupArchiveFixture('placeholder');
  const archiveDir = path.join(dir, 'openspec/changes/archive', '2026-05-01-test-change');
  rmSync(path.join(archiveDir, 'proposal.md'), { force: true });
  writeFileSync(path.join(archiveDir, 'proposal-mini.md'), miniBody);
  try {
    const r = run(dir, { topology: 'none' });
    assert.equal(r.status, 0, `B-mini archive must be exempt from check (g) but got exit ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (g) A full proposal with no bounded carrier candidate is also outside Gate G.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) no bounded candidate requires neither ledger heading nor N/A → exit 0', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    'This PR adds a new feature without touching existing file structure.\n' +
    'No file removal, no consolidation, purely additive change.\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir, { topology: 'none' });
    assert.equal(r.status, 0, `expected exit 0 but got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (k) A proven consumer remains outside source-governance Gate G even when its
//     authoritative manifest contains a bounded carrier deletion.
// ─────────────────────────────────────────────────────────────────────────

test('Gate G (check g) proven consumer with bounded candidate requires neither ledger heading nor N/A → exit 0', () => {
  const content =
    '# Proposal\n\n' +
    COMMON_PREFIX +
    'This consumer removes a locally installed rule carrier.\n';
  const dir = setupArchiveFixture(content);
  try {
    const r = run(dir, { topology: 'consumer' });
    assert.equal(r.status, 0, `proven consumer must remain outside source-governance Gate G but got exit ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRepoFile(repo, repoPath, content) {
  const fullPath = path.join(repo, repoPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function prepareSourceTopology(dir, { baselineFiles, finalFiles, consumerEvidence = false, stageFinal = false }) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'Fixture');
  writeRepoFile(dir, '.devpro/scripts/pre-pr-archive-gate.mjs', '');
  writeRepoFile(dir, '.devpro/agent-rules/rule-audit-playbook.md', '# source sentinel\n');
  if (consumerEvidence) {
    writeRepoFile(dir, '.devpro-agent-rules/AGENTS.md', '# installed consumer rules\n');
    writeRepoFile(dir, '.devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs', '');
  }
  for (const [repoPath, content] of Object.entries(baselineFiles)) writeRepoFile(dir, repoPath, content);
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'fixture baseline');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  for (const repoPath of Object.keys(baselineFiles)) {
    if (!(repoPath in finalFiles)) rmSync(path.join(dir, repoPath));
  }
  for (const [repoPath, content] of Object.entries(finalFiles)) writeRepoFile(dir, repoPath, content);
  if (stageFinal) git(dir, 'add', '-A');
}

function runTouched(dir, touchedRuleFiles, extraEnv = {}) {
  return spawnSync('node', [GATE, dir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_RELEVANT_ARCHIVES: '2026-05-01-test-change',
      DEVPRO_PR_TOUCHED_RULE_FILES: touchedRuleFiles.join(','),
      ...extraEnv,
    },
  });
}

test('Gate G (check g) conflicting source and consumer evidence is unknown and blocks a bounded candidate', () => {
  const content = '# Proposal\n\n' + COMMON_PREFIX + 'Conflicting identity fixture.\n';
  const dir = setupArchiveFixture(content);
  const deleted = '.devpro/agent-rules/conflicting-identity-rule.md';
  try {
    prepareSourceTopology(dir, {
      baselineFiles: { [deleted]: '# removed carrier\n' },
      finalFiles: {},
      consumerEvidence: true,
    });
    const r = runTouched(dir, [deleted]);
    assert.equal(r.status, 1, `conflicting positive evidence must fail closed but got exit ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /identity unknown \(conflicting source and consumer positive evidence\)/);
    assert.match(r.stderr, /conflicting-identity-rule\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) consumer evidence cannot mask an origin identity probe failure', () => {
  const content = '# Proposal\n\n' + COMMON_PREFIX + 'Failed origin probe fixture.\n';
  const dir = setupArchiveFixture(content);
  const deleted = '.devpro/agent-rules/origin-probe-rule.md';
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    git(dir, 'config', 'user.name', 'Fixture');
    writeRepoFile(dir, '.devpro-agent-rules/AGENTS.md', '# installed consumer rules\n');
    writeRepoFile(dir, '.devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs', '');
    writeRepoFile(dir, deleted, '# removed consumer carrier\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'fixture baseline');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    rmSync(path.join(dir, deleted));

    const r = runTouched(dir, [deleted]);
    assert.equal(r.status, 1, `failed origin probe must remain unknown but got exit ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /identity unknown \(origin probe failed\)/);
    assert.match(r.stderr, /origin-probe-rule\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) a failed superproject probe keeps source identity unknown', () => {
  const content = '# Proposal\n\n' + COMMON_PREFIX + 'Failed superproject probe fixture.\n';
  const dir = setupArchiveFixture(content);
  const deleted = '.devpro/agent-rules/superproject-probe-rule.md';
  try {
    prepareSourceTopology(dir, {
      baselineFiles: { [deleted]: '# removed carrier\n' },
      finalFiles: {},
    });
    const preloadPath = path.join(dir, 'fail-superproject-probe.mjs');
    writeFileSync(preloadPath, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === 'git' && args?.includes('--show-superproject-working-tree')) {
    return { status: 1, stdout: '', stderr: 'injected superproject probe failure' };
  }
  return realSpawnSync(command, args, options);
};
syncBuiltinESMExports();
`, 'utf8');

    const r = runTouched(dir, [deleted], {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preloadPath).href}`].filter(Boolean).join(' '),
    });
    assert.equal(r.status, 1, `failed superproject probe must fail closed\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /identity unknown \(superproject probe failed\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) one deletion plus two additions is a definite split that exact none attestation cannot waive', () => {
  const oldPath = '.devpro/agent-rules/split-old.md';
  const newPathA = '.devpro/agent-rules/split-alpha.md';
  const newPathB = '.devpro/agent-rules/split-beta.md';
  const attestation =
    `Source-Governance-Action: none; carriers=${oldPath},${newPathA},${newPathB}; ` +
    `evidence=D:${oldPath},A:${newPathA},A:${newPathB}\n`;
  const content = '# Proposal\n\n' + COMMON_PREFIX + attestation;
  const dir = setupArchiveFixture(content);
  try {
    prepareSourceTopology(dir, {
      baselineFiles: { [oldPath]: '# Legacy carrier\n\n' + 'legacy-only responsibility\n'.repeat(40) },
      finalFiles: {
        [newPathA]: '# Alpha carrier\n\n' + 'alpha-specific responsibility\n'.repeat(20),
        [newPathB]: '# Beta carrier\n\n' + 'beta-specific responsibility\n'.repeat(20),
      },
      stageFinal: true,
    });
    const r = runTouched(dir, [oldPath, newPathA, newPathB]);
    assert.equal(r.status, 1, `definite split without ledger/audit must fail but got exit ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /authoritative manifest proves a definite source-governance topology/);
    assert.doesNotMatch(r.stderr, /ambiguous source-governance topology/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) ordinary source modification is a definite non-trigger', () => {
  const carrier = '.devpro/agent-rules/ordinary-modification.md';
  const dir = setupArchiveFixture('# Proposal\n\n' + COMMON_PREFIX + 'Ordinary content edit.\n');
  try {
    prepareSourceTopology(dir, {
      baselineFiles: { [carrier]: '# Rule\n\nold wording\n' },
      finalFiles: { [carrier]: '# Rule\n\nnew wording\n' },
      stageFinal: true,
    });
    const r = runTouched(dir, [carrier]);
    assert.equal(r.status, 0, `ordinary M must not require source-governance sections\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) independent source addition is a definite non-trigger', () => {
  const carrier = '.devpro/agent-rules/independent-addition.md';
  const dir = setupArchiveFixture('# Proposal\n\n' + COMMON_PREFIX + 'Independent carrier addition.\n');
  try {
    prepareSourceTopology(dir, {
      baselineFiles: {},
      finalFiles: { [carrier]: '# Independent rule\n\nstandalone responsibility\n' },
      stageFinal: true,
    });
    const r = runTouched(dir, [carrier]);
    assert.equal(r.status, 0, `independent A must not require source-governance sections\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) detected source rename is a definite trigger', () => {
  const oldPath = '.devpro/agent-rules/rename-old.md';
  const newPath = '.devpro/agent-rules/rename-new.md';
  const body = '# Rename fixture\n\n' + 'unchanged responsibility\n'.repeat(40);
  const dir = setupArchiveFixture('# Proposal\n\n' + COMMON_PREFIX + 'Rename without ledgers.\n');
  try {
    prepareSourceTopology(dir, {
      baselineFiles: { [oldPath]: body },
      finalFiles: { [newPath]: body },
      stageFinal: true,
    });
    const r = runTouched(dir, [oldPath, newPath]);
    assert.equal(r.status, 1, `rename without ledger/audit must fail\nstderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`status=R100; bytes=`));
    assert.match(r.stderr, /authoritative manifest proves a definite source-governance topology/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) detected source copy is a definite trigger', () => {
  const sourcePath = '.devpro/agent-rules/copy-source.md';
  const copyPath = '.devpro/agent-rules/copy-target.md';
  const original = '# Copy fixture\n\n' + 'shared responsibility vocabulary\n'.repeat(80);
  const modified = '# Copy fixture revised\n\n' + 'source now has a different responsibility\n'.repeat(80);
  const dir = setupArchiveFixture('# Proposal\n\n' + COMMON_PREFIX + 'Copy without ledgers.\n');
  try {
    prepareSourceTopology(dir, {
      baselineFiles: { [sourcePath]: original },
      finalFiles: { [sourcePath]: modified, [copyPath]: original },
      stageFinal: true,
    });
    const r = runTouched(dir, [sourcePath, copyPath]);
    assert.equal(r.status, 1, `copy without ledger/audit must fail\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`status=C100; bytes=`));
    assert.match(r.stderr, /authoritative manifest proves a definite source-governance topology/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) two deletions plus one dissimilar addition is a definite merge/collapse trigger', () => {
  const oldA = '.devpro/agent-rules/merge-old-alpha.md';
  const oldB = '.devpro/agent-rules/merge-old-beta.md';
  const merged = '.devpro/agent-rules/merge-result.md';
  const dir = setupArchiveFixture('# Proposal\n\n' + COMMON_PREFIX + 'Merge without ledgers.\n');
  try {
    prepareSourceTopology(dir, {
      baselineFiles: {
        [oldA]: '# Old alpha\n\n' + 'legacy alpha only\n'.repeat(40),
        [oldB]: '# Old beta\n\n' + 'legacy beta only\n'.repeat(40),
      },
      finalFiles: { [merged]: '# Consolidated\n\n' + 'new consolidated semantics\n'.repeat(20) },
      stageFinal: true,
    });
    const r = runTouched(dir, [oldA, oldB, merged]);
    assert.equal(r.status, 1, `merge/collapse without ledger/audit must fail\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /authoritative manifest proves a definite source-governance topology/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ambiguousDeleteAddFixture(proposalBody) {
  const oldPath = '.devpro/agent-rules/ambiguous-old.md';
  const newPath = '.devpro/agent-rules/ambiguous-new.md';
  const dir = setupArchiveFixture(proposalBody);
  prepareSourceTopology(dir, {
    baselineFiles: { [oldPath]: '# Legacy\n\n' + 'legacy-only vocabulary\n'.repeat(40) },
    finalFiles: { [newPath]: '# Replacement\n\n' + 'entirely-new vocabulary\n'.repeat(15) },
    stageFinal: true,
  });
  return { dir, oldPath, newPath };
}

test('Gate G (check g) ambiguous delete-plus-add blocks without an exact attestation', () => {
  const { dir, oldPath, newPath } = ambiguousDeleteAddFixture('# Proposal\n\n' + COMMON_PREFIX);
  try {
    const r = runTouched(dir, [oldPath, newPath]);
    assert.equal(r.status, 1, `ambiguous D+A without attestation must fail\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /ambiguous source-governance topology: expected one exact attestation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) exact none attestation resolves an ambiguous delete-plus-add without creating headings', () => {
  const oldPath = '.devpro/agent-rules/ambiguous-old.md';
  const newPath = '.devpro/agent-rules/ambiguous-new.md';
  const attestation =
    `Source-Governance-Action: none; carriers=${oldPath},${newPath}; evidence=D:${oldPath},A:${newPath}\n`;
  const { dir } = ambiguousDeleteAddFixture('# Proposal\n\n' + COMMON_PREFIX + attestation);
  try {
    const r = runTouched(dir, [oldPath, newPath]);
    assert.equal(r.status, 0, `exact none attestation should resolve bounded ambiguity\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) inaccurate ambiguous carrier attestation fails closed', () => {
  const oldPath = '.devpro/agent-rules/ambiguous-old.md';
  const newPath = '.devpro/agent-rules/ambiguous-new.md';
  const attestation =
    `Source-Governance-Action: none; carriers=${oldPath}; evidence=D:${oldPath},A:${newPath}\n`;
  const { dir } = ambiguousDeleteAddFixture('# Proposal\n\n' + COMMON_PREFIX + attestation);
  try {
    const r = runTouched(dir, [oldPath, newPath]);
    assert.equal(r.status, 1, `inaccurate carrier attestation must fail\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /attestation carrier\/status tuples do not equal the authoritative manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ambiguousModifyAddFixture(proposalBody) {
  const modifiedPath = '.devpro/agent-rules/ambiguous-modified.md';
  const addedPath = '.devpro/agent-rules/ambiguous-added.md';
  const dir = setupArchiveFixture(proposalBody);
  prepareSourceTopology(dir, {
    baselineFiles: { [modifiedPath]: '# Existing\n\nold responsibility\n' },
    finalFiles: {
      [modifiedPath]: '# Existing\n\nrevised responsibility\n',
      [addedPath]: '# Independent-looking addition\n\nnew vocabulary\n',
    },
    stageFinal: true,
  });
  return { dir, modifiedPath, addedPath };
}

test('Gate G (check g) exact none attestation resolves an ambiguous modify-plus-add', () => {
  const modifiedPath = '.devpro/agent-rules/ambiguous-modified.md';
  const addedPath = '.devpro/agent-rules/ambiguous-added.md';
  const attestation =
    `Source-Governance-Action: none; carriers=${modifiedPath},${addedPath}; ` +
    `evidence=M:${modifiedPath},A:${addedPath}\n`;
  const { dir } = ambiguousModifyAddFixture('# Proposal\n\n' + COMMON_PREFIX + attestation);
  try {
    const r = runTouched(dir, [modifiedPath, addedPath]);
    assert.equal(r.status, 0, `exact M+A attestation should resolve ambiguity\nstderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate G (check g) inaccurate modify-plus-add status attestation fails closed', () => {
  const modifiedPath = '.devpro/agent-rules/ambiguous-modified.md';
  const addedPath = '.devpro/agent-rules/ambiguous-added.md';
  const attestation =
    `Source-Governance-Action: none; carriers=${modifiedPath},${addedPath}; ` +
    `evidence=D:${modifiedPath},A:${addedPath}\n`;
  const { dir } = ambiguousModifyAddFixture('# Proposal\n\n' + COMMON_PREFIX + attestation);
  try {
    const r = runTouched(dir, [modifiedPath, addedPath]);
    assert.equal(r.status, 1, `inaccurate M+A status must fail\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /attestation carrier\/status tuples do not equal the authoritative manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createCadenceRepo({ consumer = false } = {}) {
  const dir = makeTempDir('gate-f-cadence-test-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'Fixture');
  if (consumer) {
    writeRepoFile(dir, '.devpro-agent-rules/AGENTS.md', '# installed consumer rules\n');
    writeRepoFile(dir, '.devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs', '');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/consumer.git');
  } else {
    writeRepoFile(dir, '.devpro/scripts/pre-pr-archive-gate.mjs', '');
    writeRepoFile(dir, '.devpro/agent-rules/rule-audit-playbook.md', '# source sentinel\n');
    for (let index = 1; index <= 30; index += 1) {
      writeRepoFile(dir, `.devpro/agent-rules/cadence-rule-${index}.md`, `# Cadence ${index}\n`);
    }
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');
  }
  writeRepoFile(dir, 'README.md', '# cadence fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'fixture seed');
  return dir;
}

function commitCadenceArchive(repo, archiveName, { carrierIndex = null, mini = false } = {}) {
  const fileName = mini ? 'proposal-mini.md' : 'proposal.md';
  writeRepoFile(
    repo,
    `openspec/changes/archive/${archiveName}/${fileName}`,
    `# ${mini ? 'Mini Proposal' : 'Proposal'}\n\nCadence history fixture.\n`
  );
  if (carrierIndex !== null) rmSync(path.join(repo, `.devpro/agent-rules/cadence-rule-${carrierIndex}.md`));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `archive ${archiveName}`);
}

function finalizeCadenceRepo(repo) {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

function runCadence(repo) {
  return spawnSync('node', [GATE, repo], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_RELEVANT_ARCHIVES: '',
      DEVPRO_DIFF_ACTIVE_CHANGES: '',
      DEVPRO_PR_TOUCHED_RULE_FILES: '',
    },
  });
}

test('Periodic Rationalization Cadence (f) skips a proven consumer', () => {
  const dir = createCadenceRepo({ consumer: true });
  try {
    commitCadenceArchive(dir, '2026-07-29-consumer-change');
    finalizeCadenceRepo(dir);
    const r = runCadence(dir);
    assert.equal(r.status, 0, `consumer cadence must be advisory-safe\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /Periodic Rationalization Cadence \(f\): skipped \(proven consumer\)/);
    assert.doesNotMatch(r.stderr, /indeterminate|已累積/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Periodic Rationalization Cadence (f) reports zero or multiple migration epochs as indeterminate', () => {
  const zeroDir = createCadenceRepo();
  const multipleDir = createCadenceRepo();
  try {
    commitCadenceArchive(zeroDir, '2026-07-28-unrelated-history');
    finalizeCadenceRepo(zeroDir);
    const zero = runCadence(zeroDir);
    assert.equal(zero.status, 0, `zero epoch remains advisory\nstderr: ${zero.stderr}`);
    assert.match(zero.stderr, /v1 migration epoch expected exactly once, found 0/);
    assert.doesNotMatch(zero.stderr, /已累積/);

    commitCadenceArchive(multipleDir, '2026-07-28-fix-consumer-check-scope');
    commitCadenceArchive(multipleDir, '2026-07-29-fix-consumer-check-scope');
    finalizeCadenceRepo(multipleDir);
    const multiple = runCadence(multipleDir);
    assert.equal(multiple.status, 0, `multiple epochs remain advisory\nstderr: ${multiple.stderr}`);
    assert.match(multiple.stderr, /v1 migration epoch expected exactly once, found 2/);
    assert.doesNotMatch(multiple.stderr, /已累積/);
  } finally {
    rmSync(zeroDir, { recursive: true, force: true });
    rmSync(multipleDir, { recursive: true, force: true });
  }
});

test('Periodic Rationalization Cadence (f) excludes pre-epoch and non-trigger introductions', () => {
  const dir = createCadenceRepo();
  try {
    commitCadenceArchive(dir, '2026-07-27-pre-epoch-governance', { carrierIndex: 1 });
    commitCadenceArchive(dir, '2026-07-28-fix-consumer-check-scope');
    commitCadenceArchive(dir, '2026-07-29-plain-governance-one', { carrierIndex: 2 });
    commitCadenceArchive(dir, '2026-07-30-documentation-only');
    commitCadenceArchive(dir, '2026-07-31-plain-governance-two', { carrierIndex: 3 });
    finalizeCadenceRepo(dir);
    const r = runCadence(dir);
    assert.equal(r.status, 0, `fewer than five post-epoch triggers must pass\nstderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /indeterminate|已累積/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Periodic Rationalization Cadence (f) warns at five topology-proven archives and remains read-only', () => {
  const dir = createCadenceRepo();
  try {
    commitCadenceArchive(dir, '2026-07-28-fix-consumer-check-scope');
    for (let index = 1; index <= 5; index += 1) {
      commitCadenceArchive(dir, `2026-08-0${index}-plain-change-${index}`, { carrierIndex: index });
    }
    finalizeCadenceRepo(dir);
    const before = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout;
    const r = runCadence(dir);
    const after = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout;
    assert.equal(r.status, 0, `cadence warning must not block\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /已累積 5 個 chore B（≥ 5 觸發警告）/);
    assert.equal(after, before, 'cadence audit must not write files or create a change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Periodic Rationalization Cadence (f) resets only on an exact rationalize archive-name boundary', () => {
  const dir = createCadenceRepo();
  try {
    commitCadenceArchive(dir, '2026-07-28-fix-consumer-check-scope');
    for (let index = 1; index <= 5; index += 1) {
      commitCadenceArchive(dir, `2026-08-0${index}-ordinary-${index}`, { carrierIndex: index });
    }
    commitCadenceArchive(dir, '2026-08-06-corpus-rationalize-cycle', { carrierIndex: 6 });
    for (let index = 7; index <= 10; index += 1) {
      commitCadenceArchive(dir, `2026-08-${String(index).padStart(2, '0')}-ordinary-${index}`, { carrierIndex: index });
    }
    finalizeCadenceRepo(dir);
    const r = runCadence(dir);
    assert.equal(r.status, 0, `four triggers after exact reset must not warn\nstderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /indeterminate|已累積/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Periodic Rationalization Cadence (f) treats an uncommitted archive introduction as indeterminate', () => {
  const dir = createCadenceRepo();
  try {
    commitCadenceArchive(dir, '2026-07-28-fix-consumer-check-scope');
    finalizeCadenceRepo(dir);
    writeRepoFile(dir, 'openspec/changes/archive/2026-07-29-uncommitted/proposal.md', '# Proposal\n');
    const r = runCadence(dir);
    assert.equal(r.status, 0, `missing history remains advisory\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /introduction commit missing for 2026-07-29-uncommitted/);
    assert.match(r.stderr, /no count\/reset or below-threshold claim/);
    assert.doesNotMatch(r.stderr, /已累積/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Periodic Rationalization Cadence (f) treats a merge-commit introduction as indeterminate', () => {
  const dir = createCadenceRepo();
  try {
    commitCadenceArchive(dir, '2026-07-28-fix-consumer-check-scope');
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
    const r = runCadence(dir);
    assert.equal(r.status, 0, `multi-parent introduction remains advisory\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /introduction commit is not unique-parent for 2026-07-29-merge-introduction/);
    assert.doesNotMatch(r.stderr, /已累積/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
