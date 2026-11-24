/**
 * pre-pr-archive-gate-rules-exempt.test.mjs
 *
 * Regression coverage for issue #784: gate (i) silent-scenario-removal
 * detector must NOT fire on `rules/<source>-v<X.Y.Z>` branches.
 *
 * Per rules-flow.md § Dedicated Rules Branch step 4, rules branches base off
 * anchor-sha (last production tag), not origin/main. When main has scenarios
 * added after the anchor, rules branch HEAD spec lags main spec by design —
 * gate (i)'s default baseline=origin/main would falsely flag this as silent
 * removal. Rules commits physically cannot modify openspec/specs/<cap>/spec.md
 * (not in SYNC_DIRS per sync-agent-rules.mjs), so gate-(i) skip on rules
 * branches is safe.
 *
 * Branch detection uses RULES_BRANCH_RE from lib/branch-naming.mjs as SSOT
 * (same regex as cross-model gate exemption + validateRulesBranch — no
 * ad-hoc regex divergence).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
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
  '- [x] [Req: R1] fixture task coverage\n\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';

const tmpRoot = makeTempDir('archive-gate-rules-exempt-');
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Setup a fixture where HEAD spec is MISSING scenarios that exist on main
 * (mimics issue #784: rules branch HEAD lags main by anchor delta).
 * Returns fixture dir on `mainBranchTitles` configuration.
 *
 * @param {string} headBranchName — the branch checked out at HEAD (test
 *   varies this to exercise rules-lane exempt vs non-rules block paths)
 */
function setupSilentRemovalFixture({ headBranchName, archiveName = '2026-05-20-test-archive', cap = 'cap-x' }) {
  const dir = mkdtempSync(path.join(tmpRoot, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(path.join(dir, '.devpro/scripts'), { recursive: true });
  mkdirSync(path.join(dir, '.devpro/agent-rules'), { recursive: true });
  writeFileSync(path.join(dir, '.devpro/scripts/pre-pr-archive-gate.mjs'), '');
  writeFileSync(path.join(dir, '.devpro/agent-rules/rule-audit-playbook.md'), '# source sentinel\n');
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');

  const canonicalDir = path.join(dir, 'openspec/specs', cap);
  mkdirSync(canonicalDir, { recursive: true });
  const specPath = path.join(canonicalDir, 'spec.md');
  const buildSpec = (titles) =>
    `# ${cap} Specification\n## Purpose\nx\n## Requirements\n` +
    `### Requirement: Sample Requirement\n` +
    titles.map((t) => `#### Scenario: ${t}\nGiven x\nWhen y\nThen z\n`).join('\n');

  // main has 3 scenarios; HEAD (the branch we'll test) has only 1 (2 silently removed)
  writeFileSync(specPath, buildSpec(['Existing Foo', 'Drop Me A', 'Drop Me B']));

  // Build minimal archive folder so checks (a/b/c/d/e) pass
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  mkdirSync(path.join(archivePath, 'specs', cap), { recursive: true });
  writeFileSync(
    path.join(archivePath, 'specs', cap, 'spec.md'),
    `# ${cap} Spec Delta\n## ADDED Requirements\n### Requirement: Sample Requirement\n` +
      ['Existing Foo'].map((t) => `#### Scenario: ${t}\nGiven x\nWhen y\nThen z\n`).join('\n')
  );
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_FIXTURE);

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline: main has 3 scenarios + archive scaffold');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  // Create the test branch and drop 2 scenarios on it (silent removal)
  git(dir, 'checkout', '-q', '-b', headBranchName);
  writeFileSync(specPath, buildSpec(['Existing Foo']));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `${headBranchName}: drop scenarios`);

  return { dir, archiveName, specRel: path.relative(dir, specPath).replaceAll('\\', '/') };
}

function run(fixtureDir, env = {}) {
  return spawnSync('node', [GATE, fixtureDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
      ...env,
    },
  });
}

test('issue #784: rules/agent-rules-v6.53.0 branch with silent removal → exit 0 (exempt, SemVer form)', () => {
  const fx = setupSilentRemovalFixture({ headBranchName: 'rules/agent-rules-v6.53.0' });
  const r = run(fx.dir, {
    DEVPRO_RELEVANT_ARCHIVES: fx.archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: fx.specRel,
  });
  assert.equal(r.status, 0, `expected exit 0 (rules branch exempt), got ${r.status}: ${r.stderr}`);
});

test('date+SHA rules branch is retired: rules/agent-rules-20260520-abcdef1 with silent removal → exit 1', () => {
  const fx = setupSilentRemovalFixture({ headBranchName: 'rules/agent-rules-20260520-abcdef1' });
  const r = run(fx.dir, {
    DEVPRO_RELEVANT_ARCHIVES: fx.archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: fx.specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (date+SHA rules branch retired), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /Pre-PR archive gate \(i\)/);
});

test('regression guard: non-rules feature branch with silent removal → exit 1 (block preserved)', () => {
  const fx = setupSilentRemovalFixture({ headBranchName: 'feature/silent-removal' });
  const r = run(fx.dir, {
    DEVPRO_RELEVANT_ARCHIVES: fx.archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: fx.specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (non-rules block preserved), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /Pre-PR archive gate \(i\)/);
  assert.match(r.stderr, /"Drop Me A"/);
  assert.match(r.stderr, /"Drop Me B"/);
});

test('regression guard: bugfix branch with silent removal → exit 1 (rules pattern not over-broad)', () => {
  const fx = setupSilentRemovalFixture({ headBranchName: 'bugfix/some-fix' });
  const r = run(fx.dir, {
    DEVPRO_RELEVANT_ARCHIVES: fx.archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: fx.specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (bugfix not exempt), got ${r.status}: ${r.stderr}`);
});

test('regression guard: malformed rules-like branch (no version suffix) → exit 1 (not exempt)', () => {
  // RULES_BRANCH_RE requires v<X.Y.Z> version suffix.
  // A branch like `rules/agent-rules-foo` lacks a valid version → must NOT be exempted.
  const fx = setupSilentRemovalFixture({ headBranchName: 'rules/agent-rules-foo' });
  const r = run(fx.dir, {
    DEVPRO_RELEVANT_ARCHIVES: fx.archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: fx.specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (malformed rules branch NOT exempt), got ${r.status}: ${r.stderr}`);
});

test('regression guard: chore branch (no rules/ prefix) → exit 1 (not exempt)', () => {
  const fx = setupSilentRemovalFixture({ headBranchName: 'chore/some-task' });
  const r = run(fx.dir, {
    DEVPRO_RELEVANT_ARCHIVES: fx.archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: fx.specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (chore not exempt), got ${r.status}: ${r.stderr}`);
});

test('SSOT drift guard: inline RULES_BRANCH_RE in pre-pr-archive-gate.mjs matches lib/branch-naming.mjs', () => {
  // Codex round-1 Important: ad-hoc regex divergence from SSOT.
  // Resolution: inline a byte-for-byte copy with documented sync requirement
  // (lib import would force fixture isolation to mirror full dep chain).
  // This test locks the two copies together — any drift fails CI loudly.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const gateSrc = readFileSync(path.join(repoRoot, '.devpro/scripts/pre-pr-archive-gate.mjs'), 'utf8');
  const libSrc = readFileSync(path.join(repoRoot, '.devpro/scripts/hooks/lib/branch-naming.mjs'), 'utf8');

  // Extract the RULES_BRANCH_RE definition body from both files.
  const extract = (src, label) => {
    const m = src.match(/RULES_BRANCH_RE\s*=\s*(\/[^\n]+?\/)\s*;/);
    assert.ok(m, `${label}: RULES_BRANCH_RE definition not found`);
    return m[1];
  };
  const gateRegex = extract(gateSrc, 'pre-pr-archive-gate.mjs (inline)');
  const libRegex = extract(libSrc, 'lib/branch-naming.mjs (SSOT)');

  assert.equal(
    gateRegex,
    libRegex,
    `inline RULES_BRANCH_RE in pre-pr-archive-gate.mjs has drifted from lib/branch-naming.mjs SSOT.\n` +
    `Update one to match the other and re-run tests.\n` +
    `gate: ${gateRegex}\nlib:  ${libRegex}`
  );
});
