/**
 * pre-pr-archive-gate-p-removed-scenarios.test.mjs
 *
 * GH-2508 prove-it for gate (p): Removed Scenarios exemption + historical
 * archive normative-body skip (getAddedArchives scope).
 *
 * Fixtures MUST set DEVPRO_ADDED_ARCHIVES explicitly — when only
 * DEVPRO_RELEVANT_ARCHIVES is set, getAddedArchives falls back to the same
 * list and historical-body skip is not testable.
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

const OWN_TASKS =
  '## Tasks\n\n' +
  '- [x] [Req: R1] prove-it: gate (p) removed-scenarios fixture\n' +
  '  - 驗收: focused (p) test green\n';

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function runGate(repo, env = {}) {
  return spawnSync('node', [GATE, repo], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_PR_TOUCHED_RULE_FILES: '',
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
      DEVPRO_DIFF_ACTIVE_CHANGES: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
      DEVPRO_CURRENT_BRANCH: 'feature/gh-2508-p-fixture',
      ...env,
    },
  });
}

function writeArchive(repo, name, {
  cap = 'gate-p-cap',
  specDelta,
  proposalExtra = '',
  tasksContent = OWN_TASKS,
}) {
  const root = path.join(repo, 'openspec/changes/archive', name);
  mkdirSync(path.join(root, 'specs', cap), { recursive: true });
  writeFileSync(path.join(root, 'proposal.md'), VALID_PROPOSAL_CONTENT + proposalExtra);
  writeFileSync(path.join(root, 'brd.md'), VALID_BRD_FIXTURE);
  writeFileSync(path.join(root, 'tasks.md'), tasksContent);
  writeFileSync(path.join(root, 'specs', cap, 'spec.md'), specDelta);
}

function writeCanonical(repo, cap, content) {
  const dir = path.join(repo, 'openspec/specs', cap);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), content);
}

function initRepo() {
  const repo = makeTempDir('archive-gate-p-removed-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, '.keep'), 'seed\n');
  mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
  mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function commitArchiveAndCanonical(repo) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'archive + canonical');
}

const CAP = 'gate-p-cap';
const SCENARIO_TITLE = 'Superseded Flow';
const ARCHIVE_BODY = '- **WHEN** old path **THEN** system MUST run legacy handler';
const REWRITTEN_BODY = '- **WHEN** old path **THEN** system MUST run modern handler';

const DELTA_WITH_SCENARIO =
  `# ${CAP} Spec Delta\n` +
  `## ADDED Requirements\n` +
  `### Requirement: Archive Promotion\n` +
  `#### Scenario: ${SCENARIO_TITLE}\n` +
  `${ARCHIVE_BODY}\n`;

const CANONICAL_WITHOUT_SCENARIO =
  `# ${CAP} Specification\n` +
  `## Purpose\nreal purpose\n` +
  `## Requirements\n` +
  `### Requirement: Archive Promotion\n` +
  `#### Scenario: Still Present\n` +
  `- **WHEN** ok **THEN** system MUST proceed\n`;

const CANONICAL_WITH_HEADING_REWRITTEN_BODY =
  `# ${CAP} Specification\n` +
  `## Purpose\nreal purpose\n` +
  `## Requirements\n` +
  `### Requirement: Archive Promotion\n` +
  `#### Scenario: ${SCENARIO_TITLE}\n` +
  `${REWRITTEN_BODY}\n`;

test('GH-2508 (p-1): Removed declared + canonical missing scenario → gate (p) green', () => {
  const repo = initRepo();
  const historical = '2026-01-01-historical-supersede';
  const newer = '2026-09-15-declare-removed';
  try {
    writeArchive(repo, historical, { specDelta: DELTA_WITH_SCENARIO });
    writeArchive(repo, newer, {
      specDelta: `# ${CAP} Spec Delta\n`,
      proposalExtra: `\n## Removed Scenarios\n\n- "${SCENARIO_TITLE}"\n`,
    });
    writeCanonical(repo, CAP, CANONICAL_WITHOUT_SCENARIO);
    commitArchiveAndCanonical(repo);

    const result = runGate(repo, {
      DEVPRO_RELEVANT_ARCHIVES: `${historical},${newer}`,
      DEVPRO_ADDED_ARCHIVES: '',
    });
    assert.equal(
      result.status,
      0,
      `expected green when Removed exempts missing scenario:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.doesNotMatch(result.stderr, /\(p\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2508 (p-2): no Removed + canonical missing scenario → gate (p) red', () => {
  const repo = initRepo();
  const archiveName = '2026-09-15-missing-without-removed';
  try {
    writeArchive(repo, archiveName, { specDelta: DELTA_WITH_SCENARIO });
    writeCanonical(repo, CAP, CANONICAL_WITHOUT_SCENARIO);
    commitArchiveAndCanonical(repo);

    const result = runGate(repo, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_ADDED_ARCHIVES: '',
    });
    assert.equal(result.status, 1, `expected red without Removed:\n${result.stderr}`);
    assert.match(result.stderr, /\(p\)/);
    assert.match(result.stderr, /Scenario heading: Scenario: Superseded Flow/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2508 (p-3): historical archive body rewrite + DEVPRO_ADDED_ARCHIVES="" → gate (p) green', () => {
  const repo = initRepo();
  const historical = '2026-01-01-historical-body';
  try {
    writeArchive(repo, historical, { specDelta: DELTA_WITH_SCENARIO });
    writeCanonical(repo, CAP, CANONICAL_WITH_HEADING_REWRITTEN_BODY);
    commitArchiveAndCanonical(repo);

    const result = runGate(repo, {
      DEVPRO_RELEVANT_ARCHIVES: historical,
      DEVPRO_ADDED_ARCHIVES: '',
    });
    assert.equal(
      result.status,
      0,
      `historical archive should skip body line check:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.doesNotMatch(result.stderr, /\(p\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2508 (p-4): new archive in DEVPRO_ADDED_ARCHIVES missing body promote → gate (p) red', () => {
  const repo = initRepo();
  const newArchive = '2026-09-15-new-archive';
  try {
    writeArchive(repo, newArchive, { specDelta: DELTA_WITH_SCENARIO });
    writeCanonical(repo, CAP, CANONICAL_WITH_HEADING_REWRITTEN_BODY);
    commitArchiveAndCanonical(repo);

    const result = runGate(repo, {
      DEVPRO_RELEVANT_ARCHIVES: newArchive,
      DEVPRO_ADDED_ARCHIVES: newArchive,
    });
    assert.equal(result.status, 1, `new archive must enforce body lines:\n${result.stderr}`);
    assert.match(result.stderr, /\(p\)/);
    assert.match(result.stderr, /normative body line/);
    assert.match(result.stderr, /MUST run legacy handler/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GH-2508 (p-5): new archive Removed-first then retained scenario with identical body → still red when body missing', () => {
  // Codex WARN: dedup by kind+normalized alone would keep only the Removed
  // scenario's body assertion; exemption then drops it and misses retained B.
  const repo = initRepo();
  const newArchive = '2026-09-15-removed-then-retained-same-body';
  const removedTitle = 'Removed First';
  const retainedTitle = 'Retained Second';
  const sharedBody = '- **WHEN** shared path **THEN** system MUST keep this body';
  try {
    const delta =
      `# ${CAP} Spec Delta\n` +
      `## ADDED Requirements\n` +
      `### Requirement: Archive Promotion\n` +
      `#### Scenario: ${removedTitle}\n` +
      `${sharedBody}\n` +
      `#### Scenario: ${retainedTitle}\n` +
      `${sharedBody}\n`;
    writeArchive(repo, newArchive, {
      specDelta: delta,
      proposalExtra: `\n## Removed Scenarios\n\n- "${removedTitle}"\n`,
    });
    // Canonical keeps retained heading but drops the shared body (missed promote for B).
    writeCanonical(
      repo,
      CAP,
      `# ${CAP} Specification\n` +
        `## Purpose\nreal purpose\n` +
        `## Requirements\n` +
        `### Requirement: Archive Promotion\n` +
        `#### Scenario: ${retainedTitle}\n` +
        `- **WHEN** other **THEN** system MUST do something else\n`,
    );
    commitArchiveAndCanonical(repo);

    const result = runGate(repo, {
      DEVPRO_RELEVANT_ARCHIVES: newArchive,
      DEVPRO_ADDED_ARCHIVES: newArchive,
    });
    assert.equal(
      result.status,
      1,
      `retained scenario body must still be checked after Removed exemption:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stderr, /\(p\)/);
    assert.match(result.stderr, /normative body line/);
    assert.match(result.stderr, /MUST keep this body/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
