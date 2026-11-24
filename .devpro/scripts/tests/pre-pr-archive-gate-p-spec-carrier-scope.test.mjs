/**
 * pre-pr-archive-gate-p-spec-carrier-scope.test.mjs
 *
 * Prove-it for defect A (fix-guard-scope-fidelity): check (p) — archive
 * promotion completeness (`pre-pr-archive-gate.mjs` ~:2338-2420) — sources its
 * archive set from `relevantExistingArchives`, which is *archive-folder*
 * granularity: any PR diff touching ANY file inside an archive folder pulls
 * that archive's ENTIRE `specs/<cap>/spec.md` set into the check (p)
 * comparison, even when the diff never touches `specs/**` at all. Real-world
 * hit: PR #2744 trimmed a trailing blank line in an unrelated file inside a
 * historical archive and was blocked by that archive's pre-existing
 * promotion debt.
 *
 * The fix (T2, NOT part of this file) narrows check (p)'s intake to the
 * spec-carrier paths actually touched by the PR diff. This file proves the
 * defect (case a) and pins the two boundaries the fix must not break (cases
 * b, c). Case (a) is written as a normal (non-inverted) "expect exit 0"
 * assertion, i.e. it is the shape a prove-it RED case should have against
 * pre-T2 code.
 *
 * RED → GREEN observed against committed code (not inferred):
 *   - `1c956a5dc~1` (pre-T2): case (a) FAILS, cases (b)/(c) pass.
 *   - `1c956a5dc`   (T2):     all three pass.
 * T1 and T2 were authored concurrently, so this ordering was verified after
 * both landed by checking the pre-T2 gate back out and re-running this file;
 * the two boundary cases (b)/(c) are green in both states, which is what
 * makes them boundaries rather than regressions.
 *
 * Unlike pre-pr-archive-gate-p-removed-scenarios.test.mjs, cases (a)-(c) MUST
 * NOT set DEVPRO_RELEVANT_ARCHIVES — that env directly supplies the archive
 * list and bypasses the real `getRelevantArchives()` git-diff probe
 * (`pre-pr-archive-gate.mjs`:462), which is exactly the code path defect A
 * lives in. Instead, each fixture commits the archive folder + canonical spec
 * as pre-existing history (seed commit, `refs/remotes/origin/main`), then
 * makes a SECOND commit representing the PR's actual diff, so
 * `origin/main...HEAD` only shows what the PR really touched. Case (d)
 * deliberately opts back in to DEVPRO_RELEVANT_ARCHIVES without
 * DEVPRO_TOUCHED_ARCHIVE_SPECS to pin the compat fallback to folder
 * granularity (spec scenario: "Folder-granularity compatibility fallback
 * over-checks rather than under-checks"). Case (e) opts into
 * DEVPRO_TOUCHED_ARCHIVE_SPECS (empty string = empty set; single carrier =
 * paths=1) so the explicit override branch cannot rot without turning red.
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
  '- [x] [Req: R1] prove-it: gate (p) spec-carrier scope fixture\n' +
  '  - 驗收: focused (p) test green\n';

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function runGate(
  repo,
  env = {},
  {
    allowRelevantArchivesOverride = false,
    allowTouchedArchiveSpecsOverride = false,
  } = {},
) {
  const childEnv = {
    ...process.env,
    DEVPRO_PR_TOUCHED_RULE_FILES: '',
    DEVPRO_CHANGED_CAPABILITY_SPECS: '',
    DEVPRO_DIFF_ACTIVE_CHANGES: '',
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    DEVPRO_CURRENT_BRANCH: 'feature/fix-guard-scope-fidelity-t1-fixture',
    // Deterministic + avoids any `gh pr view` probe attempt (GH-2546 order:
    // env → --baseline-ref → gh pr base → origin/main fallback).
    DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: 'origin/main',
    ...env,
  };
  // Both archive-intake env overrides are removed by default so cases (a)-(c)
  // prove the real getRelevantArchives() git-diff path (and stay hermetic
  // against an ambient DEVPRO_TOUCHED_ARCHIVE_SPECS). Case (d) opts back in to
  // DEVPRO_RELEVANT_ARCHIVES only; case (e) opts into DEVPRO_TOUCHED_ARCHIVE_SPECS.
  if (!allowTouchedArchiveSpecsOverride) delete childEnv.DEVPRO_TOUCHED_ARCHIVE_SPECS;
  if (!allowRelevantArchivesOverride) delete childEnv.DEVPRO_RELEVANT_ARCHIVES;
  return spawnSync('node', [GATE, repo], { encoding: 'utf8', env: childEnv });
}

function writeArchive(repo, name, {
  cap = CAP,
  specDelta,
  qaTestScope,
  tasksContent = OWN_TASKS,
}) {
  const root = path.join(repo, 'openspec/changes/archive', name);
  mkdirSync(path.join(root, 'specs', cap), { recursive: true });
  writeFileSync(path.join(root, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(root, 'brd.md'), VALID_BRD_FIXTURE);
  writeFileSync(path.join(root, 'tasks.md'), tasksContent);
  writeFileSync(path.join(root, 'specs', cap, 'spec.md'), specDelta);
  if (qaTestScope !== undefined) {
    writeFileSync(path.join(root, 'qa-test-scope.md'), qaTestScope);
  }
}

function writeCanonical(repo, cap, content) {
  const dir = path.join(repo, 'openspec/specs', cap);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), content);
}

/** Fresh repo with the archive dirs created but nothing committed yet. */
function initSeedRepo() {
  const repo = makeTempDir('archive-gate-p-carrier-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, '.keep'), 'seed\n');
  mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
  mkdirSync(path.join(repo, 'openspec/specs'), { recursive: true });
  return repo;
}

/** Commit the working tree as "pre-existing history" and pin origin/main to it. */
function commitAsPreExistingHistory(repo) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed: pre-existing archive + canonical (pre-PR history)');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

/** Commit the working tree as the PR's own diff (HEAD, ahead of origin/main). */
function commitAsPrDiff(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

const CAP = 'gate-p-cap';
const REQUIREMENT_NAME = 'Historical Promotion';

const MISSING_DELTA =
  `# ${CAP} Spec Delta\n` +
  `## ADDED Requirements\n` +
  `### Requirement: ${REQUIREMENT_NAME}\n` +
  `#### Scenario: Legacy Path\n` +
  `- **WHEN** old request arrives **THEN** system MUST run legacy handler\n`;

const CANONICAL_MISSING_REQUIREMENT =
  `# ${CAP} Specification\n` +
  `## Purpose\nreal purpose\n` +
  `## Requirements\n` +
  `### Requirement: Unrelated Requirement\n` +
  `#### Scenario: Other\n` +
  `- **WHEN** ok **THEN** system MUST proceed\n`;

const PROMOTED_DELTA =
  `# ${CAP} Spec Delta\n` +
  `## ADDED Requirements\n` +
  `### Requirement: ${REQUIREMENT_NAME}\n` +
  `#### Scenario: Legacy Path\n` +
  `- **WHEN** old request arrives **THEN** system MUST run legacy handler\n`;

const CANONICAL_FULLY_PROMOTED =
  `# ${CAP} Specification\n` +
  `## Purpose\nreal purpose\n` +
  `## Requirements\n` +
  `### Requirement: ${REQUIREMENT_NAME}\n` +
  `#### Scenario: Legacy Path\n` +
  `- **WHEN** old request arrives **THEN** system MUST run legacy handler\n`;

test('case (a): PR only touches a non-spec-delta file in an archive carrying pre-existing unpromoted spec debt → gate (p) must be green (defect A)', () => {
  // Spec scenario carrier (archive-tooling): "Archive-internal non-carrier edit does not pull in that archive's spec carriers".
  const repo = initSeedRepo();
  const archiveName = '2026-01-01-historical-debt';
  try {
    writeArchive(repo, archiveName, {
      specDelta: MISSING_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(repo, CAP, CANONICAL_MISSING_REQUIREMENT);
    commitAsPreExistingHistory(repo);

    // PR diff (PR #2744 shape): trims a trailing blank line in a
    // non-spec-delta file. specs/** is never touched by this commit.
    writeFileSync(
      path.join(repo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(repo, 'trim trailing blank line in qa-test-scope.md');

    const result = runGate(repo);
    assert.equal(
      result.status,
      0,
      `defect A: a PR diff that never touches specs/** must not resurface an ` +
      `unrelated archive's pre-existing missing-promotion debt:\n` +
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /Pre-PR archive gate \(p\)/,
      `gate (p) must not fire when the PR diff never touches specs/**:\nstderr=${result.stderr}`,
    );
    // Pin the discriminator, not just the outcome: exit 0 would also hold if
    // check (p) never got a chance to run at all (archive absent from the
    // relevance set). The effective-scope advisory proves the archive WAS in
    // scope and the carrier set it evaluated was empty — i.e. green for the
    // right reason (spec-carrier narrowing), not green by accident.
    assert.match(
      result.stdout,
      /check \(p\) material: spec-carrier granularity; touched archive spec\.md paths=0 \(check \(p\) evaluates zero carriers\)\./,
      `stdout must show spec-carrier granularity evaluated zero carriers:\nstdout=${result.stdout}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Cases (b)/(c) edit only the archive spec.md's title line (line 1, strictly
// before the first `## ` heading on line 2) in the PR commit, NOT a trailing
// blank line. A trailing-newline edit still counts as "archive-only" for gate
// (h)'s SSOT-drift detector (the seed commit already paired archive+canonical
// once, so a later archive-only touch is legitimately flagged by (h) BEFORE
// (p) ever runs — (h) intentionally takes precedence, per its own comment).
// `isPreambleOnlyChange` exempts a preamble-only edit from (h) entirely, which
// is exactly the documented, permitted shape ("archive spec.md 首個 `## `
// heading 之前的 preamble ... 也可直接校正") — so it reaches (p) undisturbed.
function preambleTitleEdit(delta, suffix) {
  return delta.replace(/^(#[^\n]*)\n/, `$1${suffix}\n`);
}

test('case (b, baseline): PR touches the archive spec.md itself with missing promotion → gate (p) red now and after the fix', () => {
  // Spec scenario carrier (archive-tooling): "Touched spec carrier still fails closed on a missing promotion".
  const repo = initSeedRepo();
  const archiveName = '2026-01-01-historical-debt';
  try {
    writeArchive(repo, archiveName, { specDelta: MISSING_DELTA });
    writeCanonical(repo, CAP, CANONICAL_MISSING_REQUIREMENT);
    commitAsPreExistingHistory(repo);

    // PR diff touches specs/<cap>/spec.md itself (preamble-only edit, see
    // preambleTitleEdit above), so this archive's promotion debt is
    // genuinely in scope for check (p).
    writeFileSync(
      path.join(repo, 'openspec/changes/archive', archiveName, 'specs', CAP, 'spec.md'),
      preambleTitleEdit(MISSING_DELTA, ' (reviewed)'),
    );
    commitAsPrDiff(repo, 'touch archive spec.md preamble');

    const result = runGate(repo);
    assert.equal(
      result.status,
      1,
      `a PR diff that genuinely touches the archived spec.md must still enforce ` +
      `promotion completeness:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /Pre-PR archive gate \(p\)/,
      `stderr must identify gate (p):\nstderr=${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes(archiveName),
      `stderr must name the offending archive:\nstderr=${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes(CAP),
      `stderr must name the capability:\nstderr=${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /missing Requirement heading:/,
      `stderr must name the missing assertion kind:\nstderr=${result.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('case (c, positive control): PR touches a fully-promoted archive spec.md → gate (p) stays green now and after the fix', () => {
  const repo = initSeedRepo();
  const archiveName = '2026-02-01-fully-promoted';
  try {
    writeArchive(repo, archiveName, { specDelta: PROMOTED_DELTA });
    writeCanonical(repo, CAP, CANONICAL_FULLY_PROMOTED);
    commitAsPreExistingHistory(repo);

    writeFileSync(
      path.join(repo, 'openspec/changes/archive', archiveName, 'specs', CAP, 'spec.md'),
      preambleTitleEdit(PROMOTED_DELTA, ' (reviewed)'),
    );
    commitAsPrDiff(repo, 'touch archive spec.md preamble');

    const result = runGate(repo);
    assert.equal(
      result.status,
      0,
      `a fully-promoted archive spec.md must pass gate (p):\n` +
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /Pre-PR archive gate \(p\)/,
      `gate (p) must stay silent on full promotion:\nstderr=${result.stderr}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('case (d): DEVPRO_RELEVANT_ARCHIVES without DEVPRO_TOUCHED_ARCHIVE_SPECS falls back to folder granularity and reports it (over-checks, never under-checks)', () => {
  // Spec scenario (archive-tooling): "Folder-granularity compatibility fallback over-checks rather than under-checks" — this is its asserting carrier.
  const archiveName = '2026-01-01-historical-debt';

  // Fixture 1: the fallback must widen the intake to the env-supplied archive's
  // spec carriers, so the same non-spec PR touch as case (a) now fails closed
  // on the archive's pre-existing promotion debt (over-check, not under-check).
  const overCheckRepo = initSeedRepo();
  try {
    writeArchive(overCheckRepo, archiveName, {
      specDelta: MISSING_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(overCheckRepo, CAP, CANONICAL_MISSING_REQUIREMENT);
    commitAsPreExistingHistory(overCheckRepo);

    writeFileSync(
      path.join(overCheckRepo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(overCheckRepo, 'trim trailing blank line in qa-test-scope.md');

    const result = runGate(
      overCheckRepo,
      { DEVPRO_RELEVANT_ARCHIVES: archiveName },
      { allowRelevantArchivesOverride: true },
    );
    assert.equal(
      result.status,
      1,
      `folder-granularity fallback must over-check (fail closed on the archive's ` +
      `pre-existing debt):\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /Pre-PR archive gate \(p\)/,
      `fallback intake must still run check (p):\nstderr=${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /missing Requirement heading:/,
      `fallback intake must still name the missing assertion kind:\nstderr=${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes(archiveName) && result.stderr.includes(CAP),
      `fallback failure must name the archive and capability:\nstderr=${result.stderr}`,
    );
  } finally {
    rmSync(overCheckRepo, { recursive: true, force: true });
  }

  // Fixture 2: fully promoted archive under the same fallback → green, and the
  // pass-path advisory layer must report the fallback granularity rather than
  // hiding it (advisories print only on the pass path, by contract).
  const passingRepo = initSeedRepo();
  try {
    writeArchive(passingRepo, archiveName, {
      specDelta: PROMOTED_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(passingRepo, CAP, CANONICAL_FULLY_PROMOTED);
    commitAsPreExistingHistory(passingRepo);

    writeFileSync(
      path.join(passingRepo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(passingRepo, 'trim trailing blank line in qa-test-scope.md');

    const result = runGate(
      passingRepo,
      { DEVPRO_RELEVANT_ARCHIVES: archiveName },
      { allowRelevantArchivesOverride: true },
    );
    assert.equal(
      result.status,
      0,
      `fully promoted archive under the fallback must stay green:\n` +
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /check \(p\) material: archive-folder granularity \(compat fallback: DEVPRO_RELEVANT_ARCHIVES set without DEVPRO_TOUCHED_ARCHIVE_SPECS\); relevant archives=1\./,
      `stdout must report the compat-fallback granularity, not hide it:\nstdout=${result.stdout}`,
    );
  } finally {
    rmSync(passingRepo, { recursive: true, force: true });
  }
});

test('case (e): DEVPRO_TOUCHED_ARCHIVE_SPECS override — empty string = empty set; single carrier = paths=1', () => {
  // Spec scenarios (archive-tooling):
  // - "Empty DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates zero carriers"
  // - "Single-carrier DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates only that path"
  const archiveName = '2026-01-01-historical-debt';
  const carrierPath =
    `openspec/changes/archive/${archiveName}/specs/${CAP}/spec.md`;

  // (e1) Scenario: Empty DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates zero carriers
  // Empty-string override must keep !== undefined semantics: with
  // DEVPRO_RELEVANT_ARCHIVES set (which alone would folder-over-check), an
  // explicit empty TOUCHED set evaluates zero carriers → green / paths=0.
  // If the production gate ever switches to a truthy check, "" falls through
  // to the folder fallback and this fixture turns red.
  const emptyOverrideRepo = initSeedRepo();
  try {
    writeArchive(emptyOverrideRepo, archiveName, {
      specDelta: MISSING_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(emptyOverrideRepo, CAP, CANONICAL_MISSING_REQUIREMENT);
    commitAsPreExistingHistory(emptyOverrideRepo);

    writeFileSync(
      path.join(emptyOverrideRepo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(emptyOverrideRepo, 'trim trailing blank line in qa-test-scope.md');

    const result = runGate(
      emptyOverrideRepo,
      {
        DEVPRO_RELEVANT_ARCHIVES: archiveName,
        DEVPRO_TOUCHED_ARCHIVE_SPECS: '',
      },
      {
        allowRelevantArchivesOverride: true,
        allowTouchedArchiveSpecsOverride: true,
      },
    );
    assert.equal(
      result.status,
      0,
      `Empty DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates zero carriers — must not folder-fallback:\n` +
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /Pre-PR archive gate \(p\)/,
      `gate (p) must stay silent when the override set is empty:\nstderr=${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /check \(p\) material: spec-carrier granularity; touched archive spec\.md paths=0 \(check \(p\) evaluates zero carriers\)\./,
      `stdout must show paths=0 under explicit empty override:\nstdout=${result.stdout}`,
    );
  } finally {
    rmSync(emptyOverrideRepo, { recursive: true, force: true });
  }

  // (e2) Scenario: Single-carrier DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates only that path
  // Non-spec PR touch + explicit pin of the debted spec.md → check (p) evaluates
  // exactly that carrier and fails.
  const singleCarrierRepo = initSeedRepo();
  try {
    writeArchive(singleCarrierRepo, archiveName, {
      specDelta: MISSING_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(singleCarrierRepo, CAP, CANONICAL_MISSING_REQUIREMENT);
    commitAsPreExistingHistory(singleCarrierRepo);

    writeFileSync(
      path.join(singleCarrierRepo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(singleCarrierRepo, 'trim trailing blank line in qa-test-scope.md');

    const failResult = runGate(
      singleCarrierRepo,
      {
        DEVPRO_RELEVANT_ARCHIVES: archiveName,
        DEVPRO_TOUCHED_ARCHIVE_SPECS: carrierPath,
      },
      {
        allowRelevantArchivesOverride: true,
        allowTouchedArchiveSpecsOverride: true,
      },
    );
    assert.equal(
      failResult.status,
      1,
      `Single-carrier DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates only that path — debted pin must fail:\n` +
      `stdout=${failResult.stdout}\nstderr=${failResult.stderr}`,
    );
    assert.match(
      failResult.stderr,
      /Pre-PR archive gate \(p\)/,
      `override intake must still run check (p):\nstderr=${failResult.stderr}`,
    );
    assert.match(
      failResult.stderr,
      /missing Requirement heading:/,
      `override failure must name the missing assertion kind:\nstderr=${failResult.stderr}`,
    );
    assert.ok(
      failResult.stderr.includes(archiveName) && failResult.stderr.includes(CAP),
      `override failure must name the archive and capability:\nstderr=${failResult.stderr}`,
    );
  } finally {
    rmSync(singleCarrierRepo, { recursive: true, force: true });
  }

  // (e3) Same pin against a fully promoted carrier → green with paths=1.
  const promotedOverrideRepo = initSeedRepo();
  try {
    writeArchive(promotedOverrideRepo, archiveName, {
      specDelta: PROMOTED_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(promotedOverrideRepo, CAP, CANONICAL_FULLY_PROMOTED);
    commitAsPreExistingHistory(promotedOverrideRepo);

    writeFileSync(
      path.join(promotedOverrideRepo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(promotedOverrideRepo, 'trim trailing blank line in qa-test-scope.md');

    const passResult = runGate(
      promotedOverrideRepo,
      {
        DEVPRO_RELEVANT_ARCHIVES: archiveName,
        DEVPRO_TOUCHED_ARCHIVE_SPECS: carrierPath,
      },
      {
        allowRelevantArchivesOverride: true,
        allowTouchedArchiveSpecsOverride: true,
      },
    );
    assert.equal(
      passResult.status,
      0,
      `Single-carrier DEVPRO_TOUCHED_ARCHIVE_SPECS override evaluates only that path — promoted pin must pass:\n` +
      `stdout=${passResult.stdout}\nstderr=${passResult.stderr}`,
    );
    assert.match(
      passResult.stdout,
      /check \(p\) material: spec-carrier granularity; touched archive spec\.md paths=1\./,
      `stdout must report paths=1 under single-carrier override:\nstdout=${passResult.stdout}`,
    );
  } finally {
    rmSync(promotedOverrideRepo, { recursive: true, force: true });
  }
});

test('case (f): Single-carrier override does not widen to a sibling debted capability', () => {
  // Spec scenario (archive-tooling):
  // "Single-carrier override does not widen to a sibling debted capability"
  const archiveName = '2026-01-01-historical-debt';
  const capB = 'gate-p-cap-b';
  const promotedPath =
    `openspec/changes/archive/${archiveName}/specs/${CAP}/spec.md`;
  const debtedDelta = MISSING_DELTA.replaceAll(CAP, capB);
  const debtedCanonical = CANONICAL_MISSING_REQUIREMENT.replaceAll(CAP, capB);

  const repo = initSeedRepo();
  try {
    writeArchive(repo, archiveName, {
      specDelta: PROMOTED_DELTA,
      qaTestScope: '# QA Test Scope\n\nfixture coverage notes.\n\n',
    });
    writeCanonical(repo, CAP, CANONICAL_FULLY_PROMOTED);
    const debtRoot = path.join(repo, 'openspec/changes/archive', archiveName, 'specs', capB);
    mkdirSync(debtRoot, { recursive: true });
    writeFileSync(path.join(debtRoot, 'spec.md'), debtedDelta);
    writeCanonical(repo, capB, debtedCanonical);
    commitAsPreExistingHistory(repo);

    writeFileSync(
      path.join(repo, 'openspec/changes/archive', archiveName, 'qa-test-scope.md'),
      '# QA Test Scope\n\nfixture coverage notes.\n',
    );
    commitAsPrDiff(repo, 'trim trailing blank line in qa-test-scope.md');

    // Control: folder fallback must see the sibling debt (fixture is not vacuous).
    const widened = runGate(
      repo,
      { DEVPRO_RELEVANT_ARCHIVES: archiveName },
      { allowRelevantArchivesOverride: true },
    );
    assert.equal(
      widened.status,
      1,
      `Single-carrier override does not widen to a sibling debted capability — folder fallback control must fail on ${capB}:\n` +
      `stdout=${widened.stdout}\nstderr=${widened.stderr}`,
    );
    assert.ok(
      widened.stderr.includes(capB),
      `folder fallback must name the sibling debted capability:\nstderr=${widened.stderr}`,
    );

    const pinned = runGate(
      repo,
      {
        DEVPRO_RELEVANT_ARCHIVES: archiveName,
        DEVPRO_TOUCHED_ARCHIVE_SPECS: promotedPath,
      },
      {
        allowRelevantArchivesOverride: true,
        allowTouchedArchiveSpecsOverride: true,
      },
    );
    assert.equal(
      pinned.status,
      0,
      `Single-carrier override does not widen to a sibling debted capability — pin of promoted ${CAP} must stay green:\n` +
      `stdout=${pinned.stdout}\nstderr=${pinned.stderr}`,
    );
    assert.doesNotMatch(
      pinned.stderr,
      new RegExp(capB),
      `pinned intake must not evaluate sibling ${capB}:\nstderr=${pinned.stderr}`,
    );
    assert.match(
      pinned.stdout,
      /check \(p\) material: spec-carrier granularity; touched archive spec\.md paths=1\./,
      `stdout must report paths=1 when only the promoted sibling is pinned:\nstdout=${pinned.stdout}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
