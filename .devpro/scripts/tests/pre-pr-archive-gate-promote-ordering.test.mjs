import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

// Gate (r): archive/promote commit-ordering precheck.
//
// R2 (strengthen-evidence-reverifiability): running the gate BEFORE the
// archive/promote is committed makes two downstream checks answer on a state
// that does not contain the promote:
//   - check (i) derives `changedSpecs` from `git diff <baseline>..HEAD --
//     openspec/specs/` (two-dot, committed-only). An uncommitted promote is
//     absent from HEAD, so the set is empty and the scenario-removal
//     comparison is silently skipped.
//   - cadence (f) resolves the archive folder's introduction commit via
//     `loadArchiveIntroduction`; an uncommitted archive folder has none, so it
//     reports `indeterminate`.
// Both victims share ONE root cause: the gate ran too early. Gate (r) makes
// that state a named block instead of a green run.
//
// Trigger is scoped to the git-derived basis path. When the caller supplies
// `DEVPRO_CHANGED_CAPABILITY_SPECS` it owns the comparison basis explicitly,
// so the staleness concern does not apply; production never sets that seam, so
// production always takes the git-derived path.

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

// Reused shape from pre-pr-archive-gate-design-format.test.mjs — keeps
// (c)/(d)/(m)/(o) green so (r) is the only gate under test.
const VALID_PROPOSAL_CONTENT =
  '# Proposal: fixture\n\n' +
  '## Why\n\ntest fixture\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Requirement Ledger\n\n' +
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n' +
  '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
  '## Section 3: Tasks\n\n' +
  '- [x] [Req: R1] fixture task coverage\n\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';

const CANONICAL_SPEC = '# cap-x Specification\n## Purpose\nx\n## Requirements\n';

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

/**
 * Build a repo whose relevant archive + promoted canonical spec are committed
 * or left in the working tree, per flags.
 *   commitArchive: archive folder reaches HEAD
 *   commitPromote: openspec/specs/<cap>/spec.md reaches HEAD
 */
function setupFixture({ archiveName, commitArchive = true, commitPromote = true }) {
  const dir = makeTempDir('archive-gate-r-test-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed baseline');

  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  mkdirSync(path.join(archivePath, 'specs/cap-x'), { recursive: true });
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_FIXTURE);
  writeFileSync(path.join(archivePath, 'specs/cap-x/spec.md'), '# cap-x Spec Delta\nv1\n');

  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(path.join(canonicalDir, 'spec.md'), CANONICAL_SPEC);

  if (commitArchive) {
    git(dir, 'add', '--', 'openspec/changes');
    if (commitPromote) git(dir, 'add', '--', 'openspec/specs');
    git(dir, 'commit', '-q', '-m', 'chore: archive change');
  }

  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

// DEVPRO_CHANGED_CAPABILITY_SPECS is deliberately NOT set: gate (r) fires only
// on the git-derived basis path. Baseline is HEAD so check (i)'s ref resolves.
function run(fixtureDir, env = {}) {
  const childEnv = {
    ...process.env,
    DEVPRO_DIFF_ACTIVE_CHANGES: '',
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    ...env,
  };
  delete childEnv.DEVPRO_CHANGED_CAPABILITY_SPECS;
  if (env.DEVPRO_CHANGED_CAPABILITY_SPECS !== undefined) {
    childEnv.DEVPRO_CHANGED_CAPABILITY_SPECS = env.DEVPRO_CHANGED_CAPABILITY_SPECS;
  }
  return spawnSync('node', [GATE, fixtureDir], { encoding: 'utf8', env: childEnv });
}

test('case (r-1): relevant archive folder not in HEAD → exit 1 naming both victims', () => {
  const archiveName = '2026-08-01-r-archive-uncommitted';
  const dir = setupFixture({ archiveName, commitArchive: false, commitPromote: false });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (archive not committed), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(r\)/, 'stderr must identify the gate letter');
    assert.match(r.stderr, /\(i\)/, 'stderr must name victim check (i)');
    assert.match(r.stderr, /\(f\)/, 'stderr must name victim cadence (f)');
    assert.match(r.stderr, /commit/, 'stderr must state the commit-then-rerun fix');
    assert.ok(r.stderr.includes(archiveName), 'stderr must name the offending archive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (r-2): archive committed but promote left uncommitted → exit 1', () => {
  // The archive folder reaches HEAD, so cadence (f) can resolve its
  // introduction — but openspec/specs/ is still dirty, so check (i)'s
  // committed-only diff still cannot see the promote. Probing only the archive
  // folder would close half of R2; this case pins the other half.
  const archiveName = '2026-08-01-r-promote-uncommitted';
  const dir = setupFixture({ archiveName, commitArchive: true, commitPromote: false });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (promote not committed), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(r\)/);
    assert.match(r.stderr, /openspec\/specs/, 'stderr must point at the uncommitted promote path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (r-3, positive control): archive + promote committed → gate (r) silent', () => {
  const archiveName = '2026-08-01-r-fully-committed';
  const dir = setupFixture({ archiveName, commitArchive: true, commitPromote: true });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 on fully committed state, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(r\)/, 'gate (r) must emit nothing when ordering is correct');
    assert.doesNotMatch(r.stdout, /\(r\)/, 'gate (r) must not add stdout noise on the pass path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (r-4): explicit DEVPRO_CHANGED_CAPABILITY_SPECS seam → (r) does not fire', () => {
  // Caller-supplied basis: the caller owns the comparison set, so the
  // committed-only staleness concern does not apply. Production never sets
  // this seam, so this carve-out cannot weaken the production path.
  const archiveName = '2026-08-01-r-explicit-basis';
  const dir = setupFixture({ archiveName, commitArchive: false, commitPromote: false });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
    });
    assert.equal(r.status, 0, `expected exit 0 under explicit basis seam, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(r\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (r-5): not a git repo → (r) degrades to skip, not block', () => {
  const archiveName = '2026-08-01-r-non-git';
  const dir = makeTempDir('archive-gate-r-nongit-');
  try {
    const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
    mkdirSync(path.join(archivePath, 'specs/cap-x'), { recursive: true });
    writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
    writeFileSync(path.join(archivePath, 'specs/cap-x/spec.md'), '# cap-x Spec Delta\nv1\n');
    const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(path.join(canonicalDir, 'spec.md'), CANONICAL_SPEC);

    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.doesNotMatch(r.stderr, /\(r\)/, '(r) must not fire outside a git repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (r-6): promote status probe fails → named indeterminate block, not a silent pass', () => {
  // The archive probe treats `probe.error || probe.status !== 0` as "not in
  // HEAD" and blocks. If the sibling promote probe instead collapsed a failed
  // `git status` into "no dirty promote", an unreadable index would be
  // indistinguishable from a clean promote — a false GREEN produced by the very
  // check that exists to stop false GREENs. This case pins both halves to one
  // disposition.
  const archiveName = '2026-08-01-r-status-probe-failure';
  const dir = setupFixture({ archiveName, commitArchive: true, commitPromote: true });
  try {
    // The failure must be scoped to THIS probe. Blunt forcing (a corrupt
    // .git/index) is caught earlier by gate (e)'s own fail-closed manifest
    // probes, so it never reaches (r) and would assert nothing about (r). A
    // Child-only spawn shim that fails only `status --porcelain -- openspec/specs`
    // and delegates every other invocation to the real git leaves (e) — and (r)'s
    // own HEAD and archive probes — passing, so the promote probe is the single
    // variable under test.
    const preloadPath = path.join(dir, 'fail-promote-status-probe.mjs');
    writeFileSync(preloadPath, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === 'git' && args?.slice(-4).join(' ') === 'status --porcelain -- openspec/specs') {
    return { status: 128, stdout: '', stderr: 'fatal: simulated promote status probe failure' };
  }
  return realSpawnSync(command, args, options);
};
syncBuiltinESMExports();
`, 'utf8');

    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preloadPath).href}`].filter(Boolean).join(' '),
    });
    assert.equal(
      r.status, 1,
      `expected exit 1 when the promote state is unreadable, got ${r.status}: ${r.stderr}`
    );
    assert.match(r.stderr, /\(r\)/, 'stderr must identify the gate letter');
    assert.match(
      r.stderr, /無法判定/,
      'stderr must name the state as indeterminate rather than reporting it clean'
    );
    assert.match(
      r.stderr, /git status --porcelain -- openspec\/specs/,
      'stderr must name the probe that failed so the cause is actionable'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
