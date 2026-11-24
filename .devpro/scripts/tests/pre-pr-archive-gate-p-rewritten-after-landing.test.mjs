/**
 * pre-pr-archive-gate-p-rewritten-after-landing.test.mjs
 *
 * Prove-it for bugfix fix-archive-promotion-check-rewrites: check (p) compares
 * an archive's promoted spec delta against the HEAD canonical spec. When the
 * evaluated range contains both the archive AND a later, already-merged PR
 * that legitimately rewrote that canonical spec (the v7.11.0 release shape:
 * `--baseline-ref <previous production tag>`), every rewritten line was
 * reported as "not promoted" — 29 false findings on v7.11.0.
 *
 * The fix only touches the red path: an assertion missing from HEAD canonical
 * is accepted when (1) the commit that added the archived spec is on
 * origin/main, (2) the canonical spec at the origin/main first-parent commit
 * where that archive landed contained the assertion, and (3) origin/main's
 * canonical no longer contains it either (the rewrite already landed on main,
 * so it is not this branch's own removal).
 *
 * Case (a) is the RED case against pre-fix code. Cases (b)-(e) are boundaries
 * that are green before and after the fix: a never-promoted archive, an
 * archive that is not on origin/main yet, a branch whose own diff removes
 * promoted content, and a history lookup that fails (no canonical spec file
 * at the landing commit, or a failed ancestry query during the landing
 * search) all still fail closed.
 *
 * Fixtures are real git repos (no DEVPRO_RELEVANT_ARCHIVES), so the real
 * relevance probe, carrier narrowing and first-parent history are exercised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs',
);

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
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';

const OWN_TASKS =
  '## Tasks\n\n' +
  '- [x] [Req: R1] prove-it: gate (p) rewritten-after-landing fixture\n' +
  '  - 驗收: focused (p) test green\n';

const CAP = 'gate-p-landing-cap';
const ARCHIVE = '2026-01-01-historical-promotion';
const ARCHIVED_SPEC = `openspec/changes/archive/${ARCHIVE}/specs/${CAP}/spec.md`;

const DELTA =
  `# ${CAP} Spec Delta\n` +
  `## ADDED Requirements\n` +
  `### Requirement: Historical Promotion\n` +
  `The system MUST route old requests through the handler registry.\n` +
  `#### Scenario: Legacy Path\n` +
  `- **WHEN** old request arrives **THEN** system MUST run legacy handler\n`;

const CANONICAL_HEAD =
  `# ${CAP} Specification\n` +
  `## Purpose\nreal purpose\n` +
  `## Requirements\n` +
  `### Requirement: Unrelated Requirement\n` +
  `#### Scenario: Other\n` +
  `- **WHEN** ok **THEN** system MUST proceed\n`;

const CANONICAL_PROMOTED =
  CANONICAL_HEAD +
  `### Requirement: Historical Promotion\n` +
  `The system MUST route old requests through the handler registry.\n` +
  `#### Scenario: Legacy Path\n` +
  `- **WHEN** old request arrives **THEN** system MUST run legacy handler\n`;

// A later PR legitimately rewrites the promoted requirement: the body line and
// the scenario (heading + body) are replaced; the Requirement heading stays.
const CANONICAL_REWRITTEN =
  CANONICAL_HEAD +
  `### Requirement: Historical Promotion\n` +
  `The system MUST route every request through the unified handler.\n` +
  `#### Scenario: Unified Path\n` +
  `- **WHEN** any request arrives **THEN** system MUST run the unified handler\n`;

const LANDING_ADVISORY = /check \(p\): .*present at the origin\/main landing commit/;

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runGate(repo, baselineRef, extraEnv = {}) {
  const childEnv = {
    ...process.env,
    DEVPRO_PR_TOUCHED_RULE_FILES: '',
    DEVPRO_CHANGED_CAPABILITY_SPECS: '',
    DEVPRO_DIFF_ACTIVE_CHANGES: '',
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    DEVPRO_CURRENT_BRANCH: 'feature/fix-archive-promotion-landing-fixture',
    DEVPRO_ARCHIVE_RELEVANCE_BASELINE_REF: baselineRef,
    ...extraEnv,
  };
  delete childEnv.DEVPRO_RELEVANT_ARCHIVES;
  delete childEnv.DEVPRO_ADDED_ARCHIVES;
  delete childEnv.DEVPRO_TOUCHED_ARCHIVE_SPECS;
  return spawnSync('node', [GATE, repo], { encoding: 'utf8', env: childEnv });
}

function writeArchive(repo, specDelta) {
  const root = path.join(repo, 'openspec/changes/archive', ARCHIVE);
  mkdirSync(path.join(root, 'specs', CAP), { recursive: true });
  writeFileSync(path.join(root, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(root, 'brd.md'), VALID_BRD_FIXTURE);
  writeFileSync(path.join(root, 'tasks.md'), OWN_TASKS);
  writeFileSync(path.join(root, 'specs', CAP, 'spec.md'), specDelta);
}

function writeCanonical(repo, content) {
  const dir = path.join(repo, 'openspec/specs', CAP);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), content);
}

function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

/** main with one seed commit (the "previous production" baseline). */
function initRepo({ withCanonical = true } = {}) {
  const repo = makeTempDir('archive-gate-p-landing-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, '.keep'), 'seed\n');
  mkdirSync(path.join(repo, 'openspec/changes/archive'), { recursive: true });
  if (withCanonical) writeCanonical(repo, CANONICAL_HEAD);
  commitAll(repo, 'seed: previous production');
  return { repo, seed: git(repo, 'rev-parse', 'HEAD') };
}

/** Commit `edit` on a topic branch cut from main, then regular-merge it back. */
function landOnMain(repo, branch, edit) {
  git(repo, 'checkout', '-q', '-b', branch, 'main');
  edit();
  commitAll(repo, `${branch}: work`);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, branch);
}

function pinOriginMain(repo) {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

test('case (a): archive promoted completely, later rewritten by another merged PR → release-range (p) is green (RED before fix)', () => {
  // Spec scenario carrier (archive-tooling): "Assertion rewritten after the archive landed on main does not fail".
  const { repo, seed } = initRepo();
  try {
    landOnMain(repo, 'feature/add-historical-promotion', () => {
      writeArchive(repo, DELTA);
      writeCanonical(repo, CANONICAL_PROMOTED);
    });
    landOnMain(repo, 'bugfix/rewrite-historical-promotion', () => {
      writeCanonical(repo, CANONICAL_REWRITTEN);
    });
    pinOriginMain(repo);

    const result = runGate(repo, seed);
    assert.equal(
      result.status,
      0,
      `content present at the archive's main landing commit and rewritten by a later ` +
      `merged PR must not be reported as missing promotion:\n` +
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.doesNotMatch(result.stderr, /Pre-PR archive gate \(p\)/);
    // Green for the right reason: the archive carrier WAS evaluated and the
    // three rewritten assertions were resolved via the landing commit.
    assert.match(result.stdout, /touched archive spec\.md paths=1\./);
    assert.match(result.stdout, LANDING_ADVISORY);
    assert.match(result.stdout, /3 assertion\(s\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('case (b): archive was never fully promoted when it landed on main → (p) still fails', () => {
  // Spec scenario carrier (archive-tooling): "Missing assertion not explained by a rewrite already on main still fails".
  const { repo, seed } = initRepo();
  try {
    landOnMain(repo, 'feature/add-historical-promotion', () => {
      writeArchive(repo, DELTA);
      // canonical left untouched: the promotion never happened
    });
    pinOriginMain(repo);

    const result = runGate(repo, seed);
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /Pre-PR archive gate \(p\)/);
    assert.match(result.stderr, /missing Requirement heading: Requirement: Historical Promotion/);
    assert.doesNotMatch(result.stdout, LANDING_ADVISORY);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('case (c): archive exists only on this branch (not on origin/main) → (p) behaves as before', () => {
  // Spec scenario carrier (archive-tooling): "Missing assertion not explained by a rewrite already on main still fails".
  const { repo } = initRepo();
  try {
    pinOriginMain(repo);
    git(repo, 'checkout', '-q', '-b', 'feature/add-historical-promotion');
    writeArchive(repo, DELTA);
    commitAll(repo, 'archive without promotion');

    const result = runGate(repo, 'origin/main');
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /missing Requirement heading: Requirement: Historical Promotion/);
    assert.doesNotMatch(result.stdout, LANDING_ADVISORY);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('case (d): this branch removes promoted content that origin/main still has → (p) still fails', () => {
  // Spec scenario carrier (archive-tooling): "Missing assertion not explained by a rewrite already on main still fails".
  const { repo } = initRepo();
  try {
    landOnMain(repo, 'feature/add-historical-promotion', () => {
      writeArchive(repo, DELTA);
      writeCanonical(repo, CANONICAL_PROMOTED);
    });
    pinOriginMain(repo);

    git(repo, 'checkout', '-q', '-b', 'feature/drop-legacy-path');
    // Touch the archive spec carrier via a preamble-only title edit (exempt
    // from gate (h)) so (p) evaluates it, and drop the scenario from canonical.
    writeArchive(repo, DELTA.replace(/^(#[^\n]*)\n/, '$1 (title)\n'));
    writeCanonical(repo, CANONICAL_REWRITTEN);
    commitAll(repo, 'drop Legacy Path scenario without declaring it');

    const result = runGate(repo, 'origin/main');
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /missing Scenario heading: Scenario: Legacy Path/);
    assert.doesNotMatch(result.stdout, LANDING_ADVISORY);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('case (e): the landing lookup fails (no canonical spec at the landing commit) → (p) still fails', () => {
  // Spec scenario carrier (archive-tooling): "Missing assertion not explained by a rewrite already on main still fails".
  const { repo, seed } = initRepo({ withCanonical: false });
  try {
    // The archive lands on main without any canonical spec file, so
    // `git show <landing>:openspec/specs/<cap>/spec.md` fails; a later PR
    // creates the canonical spec. A failed lookup must keep the report.
    landOnMain(repo, 'feature/add-historical-promotion', () => {
      writeArchive(repo, DELTA);
    });
    landOnMain(repo, 'bugfix/create-canonical-later', () => {
      writeCanonical(repo, CANONICAL_REWRITTEN);
    });
    pinOriginMain(repo);

    const result = runGate(repo, seed);
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /missing Scenario heading: Scenario: Legacy Path/);
    assert.doesNotMatch(result.stdout, LANDING_ADVISORY);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * PATH shim for git that fails exactly one `merge-base --is-ancestor A B`
 * query with status 128 and records that it fired; every other call is passed
 * to the real git.
 */
function gitShimFailingAncestry(ancestor, descendant) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit, 'real git must be resolvable');
  const dir = makeTempDir('archive-gate-p-git-shim-');
  const marker = path.join(dir, 'injected');
  writeFileSync(
    path.join(dir, 'git'),
    '#!/bin/sh\n' +
    'case " $* " in\n' +
    `  *" merge-base --is-ancestor ${ancestor} ${descendant} "*) : > "${marker}"; echo "fatal: injected ancestry failure" >&2; exit 128 ;;\n` +
    'esac\n' +
    `exec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  return { dir, marker };
}

test('case (f): a failed ancestry query during the landing search voids the evidence → (p) still fails', {
  skip: process.platform === 'win32' && 'POSIX sh git shim',
}, () => {
  // Spec scenario carrier (archive-tooling): "Missing assertion not explained by a rewrite already on main still fails".
  const { repo, seed } = initRepo();
  let shim = null;
  try {
    // M1: archive lands without promotion; M2: a later PR repairs canonical;
    // M3: another PR rewrites it. The real landing (M1) lacks the assertions.
    landOnMain(repo, 'feature/add-historical-promotion', () => {
      writeArchive(repo, DELTA);
    });
    const landing = git(repo, 'rev-parse', 'HEAD');
    landOnMain(repo, 'bugfix/repair-promotion', () => {
      writeCanonical(repo, CANONICAL_PROMOTED);
    });
    landOnMain(repo, 'bugfix/rewrite-historical-promotion', () => {
      writeCanonical(repo, CANONICAL_REWRITTEN);
    });
    pinOriginMain(repo);
    const addSha = git(repo, 'log', '--diff-filter=A', '--format=%H', '-1', 'HEAD', '--', ARCHIVED_SPEC);

    // First-parent chain [seed, M1, M2, M3]: the first midpoint probed is M1.
    // Failing that one query used to read as "not an ancestor", so the search
    // moved on and settled on M2, where the repair made the assertions present.
    shim = gitShimFailingAncestry(addSha, landing);
    const result = runGate(repo, seed, { PATH: `${shim.dir}${path.delimiter}${process.env.PATH}` });
    assert.ok(existsSync(shim.marker), 'the injected ancestry failure must have fired');
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /missing Scenario heading: Scenario: Legacy Path/);
    assert.doesNotMatch(result.stdout, LANDING_ADVISORY);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    if (shim) rmSync(shim.dir, { recursive: true, force: true });
  }
});
