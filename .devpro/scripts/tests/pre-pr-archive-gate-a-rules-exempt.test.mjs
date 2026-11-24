/**
 * pre-pr-archive-gate-a-rules-exempt.test.mjs
 *
 * Regression coverage for issue #848: gate (a) active-change-folder detector
 * must NOT fire on `rules/<source>-v<X.Y.Z>` branches.
 *
 * Per rules-flow.md § Dedicated Rules Branch, rules branches base off the
 * anchor SHA (last production tag), not origin/main, so the working tree
 * inherits whatever active change folders exist on the anchor base. A rules
 * sync commit physically cannot create or modify openspec/changes/ (not in
 * SYNC_DIRS per sync-agent-rules.mjs), so blocking a rules-lane push on those
 * pre-existing folders is a false positive. issue #784 fixed the analogous
 * case-(i) false positive; this covers case (a).
 *
 * Unlike the gate-(i) exemption test, gate (a) has no env-var override for the
 * branch — it probes `git rev-parse --abbrev-ref HEAD` live. The fixture is a
 * real git repo with the branch actually checked out, so this exercises the
 * real branch-probe integration. Branch detection uses RULES_BRANCH_RE from
 * lib/branch-naming.mjs as SSOT (same regex the gate inlines).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

const tmpRoot = makeTempDir('archive-gate-a-rules-exempt-');
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Build a fixture repo whose `main` carries an active change folder
 * (`openspec/changes/<active>/`), then check out `headBranchName` and add a
 * commit that touches only `.devpro/` (mimicking a rules sync commit, which by
 * SYNC_DIRS cannot touch openspec/changes/). The active change folder remains
 * in the working tree on the head branch because it was inherited from base.
 *
 * When `withPromotedArchive` is set, the base commit also carries a fully
 * promoted archive (`openspec/changes/archive/<name>/specs/<cap>/spec.md` +
 * canonical `openspec/specs/<cap>/spec.md` + valid proposal). This lets a test
 * assert that a rules branch with BOTH an inherited active change AND a real
 * archive flows past the suppressed (a) block all the way to the final
 * token-emitting exit — proving the exemption does not break the cross-model
 * PR #841 I5 evidence-token contract (the failure mode a naive early-exit
 * would introduce).
 *
 * @param {string} headBranchName — branch checked out at HEAD (varies to
 *   exercise rules-lane exempt vs non-rules block paths)
 */
function setupActiveChangeFixture({ headBranchName, activeName = 'some-active-change', withPromotedArchive = false }) {
  const dir = mkdtempSync(path.join(tmpRoot, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git');

  // The objective token gate must prove this is the source repository before
  // it accepts bounded governance candidates.
  const scriptDir = path.join(dir, '.devpro/scripts');
  const ruleDir = path.join(dir, '.devpro/agent-rules');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(ruleDir, { recursive: true });
  writeFileSync(path.join(scriptDir, 'pre-pr-archive-gate.mjs'), '// source sentinel\n');
  writeFileSync(path.join(ruleDir, 'rule-audit-playbook.md'), '# source sentinel\n');

  // main: an active change folder (the thing gate (a) blocks on)
  const activeDir = path.join(dir, 'openspec/changes', activeName);
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(path.join(activeDir, 'proposal.md'), '# active change inherited from base\n');

  if (withPromotedArchive) {
    const cap = 'cap-rules';
    const archiveName = '2026-04-27-rules-base';
    const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
    mkdirSync(path.join(archivePath, 'specs', cap), { recursive: true });
    writeFileSync(
      path.join(archivePath, 'specs', cap, 'spec.md'),
      `# ${cap} Spec Delta\n## ADDED Requirements\n### Requirement: R\n#### Scenario: S\nGiven x\nWhen y\nThen z\n`
    );
    writeFileSync(
      path.join(archivePath, 'proposal.md'),
      '# Proposal: rules-base\n\n## Why\n\nx\n\n## What Changes\n\ny\n\n' +
        '## Requirement Ledger\n\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
        '## Section 3: Tasks\n\n- [x] [Req: R1] fixture task coverage\n\n' +
        '## Issue Anchor Verification\n\n`grep -F "anchor" f.md` → 1 hit @ f.md:1\n\n' +
        '## File-Role Ledger\n\n' +
        '- `.devpro/agent-rules/rule-audit-playbook.md`: 修改 — fixture source rule carrier.\n\n' +
        '## Dedup Audit 三步結果\n\n' +
        '- 守則 3：fixture has one carrier.\n' +
        '- 守則 4：grep confirms no duplicate carrier.\n\n' +
        '## Batch Approval Ledger\n\nN/A: no batch approval selected\n'
    );
    writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_FIXTURE);
    // Promote the canonical capability spec so gate (b) passes.
    mkdirSync(path.join(dir, 'openspec/specs', cap), { recursive: true });
    writeFileSync(
      path.join(dir, 'openspec/specs', cap, 'spec.md'),
      `# ${cap} Specification\n## Purpose\nx\n## Requirements\n### Requirement: R\n#### Scenario: S\nGiven x\nWhen y\nThen z\n`
    );
  }

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main: active change folder (+archive)');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  // head branch: commit touches only .devpro/ (rules-lane shape)
  git(dir, 'checkout', '-q', '-b', headBranchName);
  writeFileSync(path.join(ruleDir, 'rule-audit-playbook.md'), '# source sentinel\nsynced content\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `${headBranchName}: sync .devpro only`);

  return { dir, activeName };
}

function run(fixtureDir, env = {}) {
  return spawnSync('node', [GATE, fixtureDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('issue #848: rules/agent-rules-v6.60.1 branch + main active change → exit 0 (block suppressed, SemVer form)', () => {
  const fx = setupActiveChangeFixture({ headBranchName: 'rules/agent-rules-v6.60.1' });
  const r = run(fx.dir);
  assert.equal(r.status, 0, `expected exit 0 (rules branch exempt), got ${r.status}: ${r.stderr}`);
  // No archive in this fixture → flows past suppressed (a) block to gate (b)
  // B-class pass-through. The key guarantee is that the (a) block did NOT fire.
  assert.doesNotMatch(r.stderr, /Active change folder still exists/);
});

test('date+SHA rules branch is retired: rules/agent-rules-20260520-abcdef1 + main active change → exit 1', () => {
  const fx = setupActiveChangeFixture({ headBranchName: 'rules/agent-rules-20260520-abcdef1' });
  const r = run(fx.dir, { DEVPRO_DIFF_ACTIVE_CHANGES: 'some-active-change' });
  assert.equal(r.status, 1, `expected exit 1 (date+SHA rules branch retired), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /Active change folder still exists/);
});

test('issue #848: rules branch + active change + promoted archive → exit 0 + evidence token (PR #841 I5 contract preserved)', () => {
  // The (a) exemption must SUPPRESS THE BLOCK ONLY, not early-exit the script.
  // A rules branch with a relevant promoted archive must still flow through
  // (b)-(h) and reach the final
  // `passArchiveGate('archived & promoted', evidenceArchive)` that emits the
  // `archived as '<name>'` evidence token for `/dp:pre-pr` / PR audit trails.
  // A naive early-exit at (a) would skip this observable evidence.
  // Mirrors pre-pr-archive-gate.test.mjs case 19, but with an inherited active
  // change folder ALSO present (the #848 scenario).
  const fx = setupActiveChangeFixture({
    headBranchName: 'rules/agent-rules-v6.60.1',
    withPromotedArchive: true,
  });
  const r = run(fx.dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-04-27-rules-base' });
  assert.equal(r.status, 0, `expected exit 0 (rules branch A-class), got ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Active change folder still exists/);
  assert.match(
    r.stdout,
    /archived as ['"][\w-]+['"]/,
    "rules-branch exemption must NOT break the evidence-token contract — block-suppress only, not early-exit"
  );
  assert.match(r.stdout, /2026-04-27-rules-base/, 'stdout must contain relevant archive name');
});

// Note (issue #848 follow-up, Gap 3): gate (a) is now scope-bound — it only
// blocks on an active change folder THIS branch OWNS (diff-touched or matching
// the branch suffix). These non-rules "block preserved" guards therefore mark
// the active change as owned via DEVPRO_DIFF_ACTIVE_CHANGES so they keep
// testing the intended "non-rules branch + its OWN un-archived change → block"
// path (the rules-lane exemption is what's under test here, not the scoping).
const OWN = { DEVPRO_DIFF_ACTIVE_CHANGES: 'some-active-change' };

test('regression guard: feature branch + OWNED active change → exit 1 (block preserved)', () => {
  const fx = setupActiveChangeFixture({ headBranchName: 'feature/some-feature' });
  const r = run(fx.dir, OWN);
  assert.equal(r.status, 1, `expected exit 1 (non-rules block preserved), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /Active change folder still exists: some-active-change/);
  // The canonical recovery-SOP pointers must remain in the block message.
  assert.match(r.stderr, /openspec-step-1-to-9\.md/);
  assert.match(r.stderr, /chore\/docs-archive-<name>-recovery/);
});

test('regression guard: bugfix branch + OWNED active change → exit 1 (rules pattern not over-broad)', () => {
  const fx = setupActiveChangeFixture({ headBranchName: 'bugfix/some-fix' });
  const r = run(fx.dir, OWN);
  assert.equal(r.status, 1, `expected exit 1 (bugfix not exempt), got ${r.status}: ${r.stderr}`);
});

test('regression guard: chore branch + OWNED active change → exit 1 (not exempt)', () => {
  const fx = setupActiveChangeFixture({ headBranchName: 'chore/some-task' });
  const r = run(fx.dir, OWN);
  assert.equal(r.status, 1, `expected exit 1 (chore not exempt), got ${r.status}: ${r.stderr}`);
});

test('regression guard: malformed rules-like branch (no version suffix) + OWNED change → exit 1 (not exempt)', () => {
  // RULES_BRANCH_RE requires v<X.Y.Z> version suffix.
  // `rules/agent-rules-foo` lacks a valid version → must NOT be exempted.
  const fx = setupActiveChangeFixture({ headBranchName: 'rules/agent-rules-foo' });
  const r = run(fx.dir, OWN);
  assert.equal(r.status, 1, `expected exit 1 (malformed rules branch NOT exempt), got ${r.status}: ${r.stderr}`);
});

// issue #848 Gap 3: a non-rules branch whose active change folder is INHERITED
// from main (NOT touched by this branch's diff, NOT matching the branch suffix)
// must NOT block — that folder is another PR's in-progress work.
test('issue #848 Gap 3: feature branch + INHERITED (non-owned) active change → exit 0 (not blocked)', () => {
  const fx = setupActiveChangeFixture({ headBranchName: 'feature/unrelated-work' });
  // No DEVPRO_DIFF_ACTIVE_CHANGES → the fixture's `some-active-change` is not
  // owned (branch suffix is `unrelated-work`); explicit empty set asserts that.
  const r = run(fx.dir, { DEVPRO_DIFF_ACTIVE_CHANGES: '' });
  assert.equal(r.status, 0, `expected exit 0 (inherited WIP must not block), got ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Active change folder still exists/);
});
