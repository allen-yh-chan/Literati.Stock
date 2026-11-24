import './lib/portable-command-shims.cjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, VALID_BRD_FIXTURE } from './lib/tmp.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

// Reused from pre-pr-archive-gate.test.mjs — keeps (c)/(d) green so (i) is
// the only gate under test.
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

const tmpRoot = makeTempDir('archive-gate-i-test-');
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function commitTrackedChangesIfPresent(repo, message) {
  const diff = spawnSync('git', ['diff', '--quiet'], { cwd: repo, encoding: 'utf8' });
  assert.ok([0, 1].includes(diff.status), `git diff --quiet failed: ${diff.stderr}`);
  if (diff.status === 0) return;
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

/**
 * Create a git repo with:
 *   - baseline commit on `main` containing canonical spec with `baselineScenarios`
 *   - second commit modifying the canonical spec to `headScenarios`
 *   - archive folder with proposal (optionally appending a `## Removed Scenarios` section)
 *
 * Gate (i) is invoked with DEVPRO_SCENARIO_DIFF_BASELINE_REF=main. The
 * objective token gate independently uses the fixture's origin/main ref.
 */
function setupScenarioDiffFixture({
  baselineScenarios,
  headScenarios,
  cap = 'cap-x',
  archiveName = '2026-05-18-test-archive',
  removedDeclaration = null, // null | string appended to proposal
  modifySpecOnHead = true,
}) {
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

  writeFileSync(specPath, buildSpec(baselineScenarios));

  // Also create archive folder with a proposal so check (b)/(c)/(d)/(e) pass.
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  mkdirSync(path.join(archivePath, 'specs', cap), { recursive: true });
  writeFileSync(
    path.join(archivePath, 'specs', cap, 'spec.md'),
    `# ${cap} Spec Delta\n## ADDED Requirements\n### Requirement: Sample Requirement\n` +
      headScenarios.map((t) => `#### Scenario: ${t}\nGiven x\nWhen y\nThen z\n`).join('\n')
  );
  let proposalContent = VALID_PROPOSAL_CONTENT;
  if (removedDeclaration) proposalContent += `\n## Removed Scenarios\n\n${removedDeclaration}\n`;
  writeFileSync(path.join(archivePath, 'proposal.md'), proposalContent);
  writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_FIXTURE);

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline: initial spec + archive scaffold');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  // Branch off `main` so HEAD differs from baseline ref after we modify.
  git(dir, 'checkout', '-q', '-b', 'feature');

  if (modifySpecOnHead) {
    writeFileSync(specPath, buildSpec(headScenarios));
    commitTrackedChangesIfPresent(dir, 'archive: promote modified spec');
  }

  return { dir, archiveName, specRel: path.relative(dir, specPath).replaceAll('\\', '/') };
}

function run(fixtureDir, env = {}) {
  return spawnSync('node', [GATE, fixtureDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Scenario-diff cases do not exercise rule-carrier readability.
      DEVPRO_PR_TOUCHED_RULE_FILES: '',
      // Gate (i) scenario baseline remains independently configurable.
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
      ...env,
    },
  });
}

test('case i-1: pure addition (no scenarios removed) → exit 0', () => {
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Existing Foo', 'Existing Bar'],
    headScenarios: ['Existing Foo', 'Existing Bar', 'New Baz'],
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
  });
  assert.equal(r.status, 0, `expected exit 0 (addition only), got ${r.status}: ${r.stderr}`);
});

test('case i-1b: base branch adds scenario after fork → not a branch removal', () => {
  const cap = 'cap-x';
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Existing Before Fork'],
    headScenarios: ['Existing Before Fork', 'Branch Added'],
    cap,
  });

  const specPath = path.join(dir, specRel);
  const buildSpec = (titles) =>
    `# ${cap} Specification\n## Purpose\nx\n## Requirements\n` +
    `### Requirement: Sample Requirement\n` +
    titles.map((t) => `#### Scenario: ${t}\nGiven x\nWhen y\nThen z\n`).join('\n');

  git(dir, 'checkout', '-q', 'main');
  writeFileSync(specPath, buildSpec(['Existing Before Fork', 'Main Added After Fork']));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main: add scenario after feature fork');
  git(dir, 'checkout', '-q', 'feature');

  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
  });
  assert.equal(
    r.status,
    0,
    `expected exit 0 (main-only scenario addition is not a branch removal), got ${r.status}: ${r.stderr}`,
  );
  assert.doesNotMatch(r.stderr, /Main Added After Fork/);
});

test('case i-2: silent scenario removal → exit 1 with (i) message + missing titles', () => {
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Keep Me', 'Drop Me', 'Also Drop Me'],
    headScenarios: ['Keep Me', 'New One'],
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (silent removal), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /Pre-PR archive gate \(i\)/);
  assert.match(r.stderr, /issue #722/);
  assert.match(r.stderr, /"Drop Me"/);
  assert.match(r.stderr, /"Also Drop Me"/);
  assert.match(r.stderr, /Pre-merge Archive Re-do/);
  assert.match(r.stderr, /## Removed Scenarios/);
});

test('case i-3: explicit ## Removed Scenarios declaration → exit 0', () => {
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Keep Me', 'Drop Me', 'Also Drop Me'],
    headScenarios: ['Keep Me'],
    removedDeclaration: '- "Drop Me"\n- "Also Drop Me"',
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
  });
  assert.equal(r.status, 0, `expected exit 0 (declared removal), got ${r.status}: ${r.stderr}`);
});

test('case i-4: no canonical spec changed → check (i) skip → exit 0', () => {
  const { dir, archiveName } = setupScenarioDiffFixture({
    baselineScenarios: ['Foo'],
    headScenarios: ['Foo'],
    modifySpecOnHead: false,
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: '', // empty = nothing to check
  });
  assert.equal(r.status, 0, `expected exit 0 (no spec changes), got ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(i\)/);
});

test('case i-5: partial declaration leaves undeclared removal → exit 1', () => {
  // Author lists one removed scenario but quietly drops a second one.
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Keep', 'Drop Declared', 'Drop Forgotten'],
    headScenarios: ['Keep'],
    removedDeclaration: '- "Drop Declared"',
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (partial declaration), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /"Drop Forgotten"/);
  assert.doesNotMatch(r.stderr, /"Drop Declared"/);
});

test('case i-6: scenario renamed counts as removal unless declared → exit 1', () => {
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Old Name'],
    headScenarios: ['New Name'],
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
  });
  assert.equal(r.status, 1, `expected exit 1 (rename = silent removal), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /"Old Name"/);
});

test('case i-7: env override smuggles non-spec path → filtered out (treated as empty set) → exit 0', () => {
  // Defence-in-depth: even though spawnSync arg-array prevents shell exec,
  // SPEC_PATH_RE filter must reject paths outside the openspec/specs/<cap>/spec.md
  // shape so they never reach git at all.
  const { dir, archiveName } = setupScenarioDiffFixture({
    baselineScenarios: ['Foo'],
    headScenarios: ['Foo'],
  });
  const canaryPath = path.join(dir, 'injection-canary');
  const shellPayload = process.platform === 'win32'
    ? ` & type nul > "${canaryPath}"`
    : `; touch "${canaryPath}"`;
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS:
      `x/spec.md${shellPayload},../../../etc/passwd,openspec/notspecs/foo/spec.md`,
  });
  assert.equal(r.status, 0, `expected exit 0 (all paths filtered out), got ${r.status}: ${r.stderr}`);
  assert.equal(existsSync(canaryPath), false, 'shell-injection canary file MUST NOT exist');
});

test('case i-8: invalid baseline ref shape → exit 1 with explicit error', () => {
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Foo'],
    headScenarios: ['Foo'],
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: '--evil-flag',
  });
  assert.equal(r.status, 1, `expected exit 1 (ref shape invalid), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /DEVPRO_SCENARIO_DIFF_BASELINE_REF shape invalid/);
});

// Whole-file deletion coverage: check (i) carries the `existsSync ? : new Set()`
// branch so a future hoist of check (i) above the latestSpecsDir early exit
// (or a check-(b) refactor) keeps catching the bug. End-to-end coverage of the
// hoist itself is a follow-up — see proposal-mini Follow-ups section.

test('case i-11: baseline ref unresolvable → exit 1 (fail-closed, not bypass)', () => {
  // Regression for PR #724 review: codex showed that with the default
  // `origin/main` baseline missing (CI shallow clone, fresh checkout), a
  // silent removal would slip through. Gate must fail-closed, not skip.
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Drop Me'],
    headScenarios: [],
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'origin/never-fetched',
  });
  assert.equal(r.status, 1, `expected exit 1 (unresolvable baseline must fail-closed), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /baseline ref/);
  assert.match(r.stderr, /does not resolve to a commit/);
  assert.match(r.stderr, /Fail-closed/);
});

test('case i-12: baseline ref unresolvable + would-be silent removal → still exit 1', () => {
  // Belt-and-braces: even when an actual silent removal exists, ref-resolve
  // failure must dominate (no implicit "pass because we cannot check").
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Existing Foo', 'Existing Bar'],
    headScenarios: [], // both dropped on HEAD
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'origin/missing',
  });
  assert.equal(r.status, 1, `expected exit 1 (fail-closed dominates), got ${r.status}: ${r.stderr}`);
  // Message must be the ref-resolve one, not the scenario-removal one
  // (we never reached the diff step, so listing missing scenarios would
  // be misleading).
  assert.match(r.stderr, /does not resolve to a commit/);
  assert.doesNotMatch(r.stderr, /"Existing Foo"/);
});

test('case i-13: baseline ref resolves to HEAD → fail-closed (no degenerate-ref bypass)', () => {
  // Regression for PR #724 round-2 codex finding: HEAD passes shape +
  // rev-parse but `git diff HEAD..HEAD` is empty, silently disabling the
  // gate. Even with a real removal that would otherwise be caught, the
  // gate must refuse to run with baseline == HEAD.
  const { dir, archiveName, specRel } = setupScenarioDiffFixture({
    baselineScenarios: ['Removed By Stealth'],
    headScenarios: [], // real silent removal
  });
  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: archiveName,
    DEVPRO_CHANGED_CAPABILITY_SPECS: specRel,
    DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
  });
  assert.equal(r.status, 1, `expected exit 1 (HEAD baseline rejected), got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /resolves to the current HEAD commit/);
  assert.match(r.stderr, /baseline equal to HEAD/);
  // The original silent-removal message must NOT leak — we never ran the diff.
  assert.doesNotMatch(r.stderr, /"Removed By Stealth"/);
});

test('case i-10: spec was new on this branch (no baseline) → exit 0', () => {
  // Build fixture but skip the baseline commit's spec: write spec only on HEAD.
  const dir = mkdtempSync(path.join(tmpRoot, 'repo-new-spec-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');

  const archivePath = path.join(dir, 'openspec/changes/archive/2026-05-18-new-cap');
  mkdirSync(path.join(archivePath, 'specs', 'cap-new'), { recursive: true });
  writeFileSync(
    path.join(archivePath, 'specs', 'cap-new', 'spec.md'),
    '# cap-new Spec Delta\n## ADDED Requirements\n### Requirement: x\n',
  );
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_FIXTURE);
  // Initial commit has archive folder + canonical spec dir but no canonical spec yet.
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline: no canonical spec yet');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feature');

  // On feature branch, introduce a brand-new canonical spec.
  const newSpecDir = path.join(dir, 'openspec/specs/cap-new');
  mkdirSync(newSpecDir, { recursive: true });
  writeFileSync(
    path.join(newSpecDir, 'spec.md'),
    '# cap-new Specification\n## Requirements\n### Requirement: x\n#### Scenario: First\nGiven x\nWhen y\nThen z\n',
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: introduce new canonical spec');

  const r = run(dir, {
    DEVPRO_RELEVANT_ARCHIVES: '2026-05-18-new-cap',
    DEVPRO_CHANGED_CAPABILITY_SPECS: 'openspec/specs/cap-new/spec.md',
  });
  assert.equal(r.status, 0, `expected exit 0 (new spec, no baseline), got ${r.status}: ${r.stderr}`);
});

// ── Lite: no archive, so the PR body carries the declaration ─────────────

function fakeGh(dir, { body = '', headRefName = 'feature', fail = false } = {}) {
  const binDir = path.join(dir, '.fake-bin');
  mkdirSync(binDir, { recursive: true });
  const payload = JSON.stringify({ body, headRefName });
  writeFileSync(
    path.join(binDir, 'gh'),
    `#!/bin/sh\necho "$@" >> "${path.join(binDir, 'trace')}"\n${fail ? 'exit 1' : `cat <<'JSON'\n${payload}\nJSON`}\n`,
    { mode: 0o755 }
  );
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    readTrace: () => (existsSync(path.join(binDir, 'trace')) ? readFileSync(path.join(binDir, 'trace'), 'utf8') : ''),
  };
}

function runWithPr(dir, env, ...args) {
  return spawnSync('node', [GATE, dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVPRO_PR_TOUCHED_RULE_FILES: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
      DEVPRO_AGENT_RULES_LEVEL: 'lite',
      ...env,
    },
  });
}

const dropOneScenario = () => setupScenarioDiffFixture({
  baselineScenarios: ['Keep Me', 'Drop Me'],
  headScenarios: ['Keep Me'],
});

test('case i-14: lite PR without archive declares the removal in the PR body → exit 0', () => {
  const { dir, specRel } = dropOneScenario();
  const { PATH, readTrace } = fakeGh(dir, { body: '## Summary\n\nx\n\n## Removed Scenarios\n\n- "Drop Me"\n\n## Test Evidence\n\nx\n' });
  const r = runWithPr(dir, { PATH, DEVPRO_CHANGED_CAPABILITY_SPECS: specRel }, '--pr', '7');
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(readTrace(), /pr view 7 /);
});

test('case i-15: lite PR body that does not list the title stays red', () => {
  const { dir, specRel } = dropOneScenario();
  const { PATH } = fakeGh(dir, { body: '## Removed Scenarios\n\n- "Some Other"\n' });
  const r = runWithPr(dir, { PATH, DEVPRO_CHANGED_CAPABILITY_SPECS: specRel }, '--pr', '7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Drop Me/);
  assert.match(r.stderr, /PR 說明/);
});

test('case i-16: lite run without --pr stays red, names the next step and does not call gh', () => {
  const { dir, specRel } = dropOneScenario();
  const { PATH, readTrace } = fakeGh(dir, { body: '## Removed Scenarios\n\n- "Drop Me"\n' });
  const r = runWithPr(dir, { PATH, DEVPRO_CHANGED_CAPABILITY_SPECS: specRel });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--pr <n>/);
  assert.equal(readTrace().includes('--json body'), false, readTrace());
});

test('case i-17: lite PR body that cannot be read stays red and says so', () => {
  const { dir, specRel } = dropOneScenario();
  const { PATH } = fakeGh(dir, { fail: true });
  const r = runWithPr(dir, { PATH, DEVPRO_CHANGED_CAPABILITY_SPECS: specRel }, '--pr', '7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PR #7/);
  assert.match(r.stderr, /讀不到/);
});

test('case i-18: PR number of another branch does not declare for this one', () => {
  const { dir, specRel } = dropOneScenario();
  const { PATH } = fakeGh(dir, { body: '## Removed Scenarios\n\n- "Drop Me"\n', headRefName: 'someone-else' });
  const r = runWithPr(dir, { PATH, DEVPRO_CHANGED_CAPABILITY_SPECS: specRel }, '--pr', '7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /someone-else/);
});

test('case i-19: a PR that carries an archive keeps reading only the archive', () => {
  const { dir, archiveName, specRel } = dropOneScenario();
  const { PATH, readTrace } = fakeGh(dir, { body: '## Removed Scenarios\n\n- "Drop Me"\n' });
  const r = runWithPr(dir, { PATH, DEVPRO_RELEVANT_ARCHIVES: archiveName, DEVPRO_CHANGED_CAPABILITY_SPECS: specRel }, '--pr', '7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Drop Me/);
  assert.equal(readTrace().includes('--json body'), false, readTrace());
});

test('case i-20: full rigor keeps reading only the archive', () => {
  const { dir, specRel } = dropOneScenario();
  const { PATH, readTrace } = fakeGh(dir, { body: '## Removed Scenarios\n\n- "Drop Me"\n' });
  const r = runWithPr(dir, { PATH, DEVPRO_AGENT_RULES_LEVEL: 'full', DEVPRO_CHANGED_CAPABILITY_SPECS: specRel }, '--pr', '7');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Drop Me/);
  assert.equal(readTrace().includes('--json body'), false, readTrace());
});
