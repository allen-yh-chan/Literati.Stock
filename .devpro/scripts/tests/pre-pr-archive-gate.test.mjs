import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, renameSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './lib/tmp.mjs';

// Perf pattern (e) (test-performance-patterns.md): this file's 120 tests ran
// fully sequentially in one process (~78s real, low internal CPU utilization
// — long-tail serialization, not CPU saturation). node --test only
// parallelizes at file granularity, so shard registration across 3 sibling
// entry files (pre-pr-archive-gate-runner-a/b.test.mjs, thin `await import()`
// wrappers analogous to run-second-reviewer-projection's runner-a/b) lets the
// 3 groups run as 3 OS processes concurrently instead of one serialized file.
const ARCHIVE_GATE_TEST_GROUP = process.env.DEVPRO_PRE_PR_ARCHIVE_GATE_TEST_GROUP ?? 'core';
const ARCHIVE_GATE_TEST_GROUP_RANGES = Object.freeze({
  core: [1, 40],
  runner_a: [41, 80],
  // +10 for the check (c) Batch Approval Ledger shape extension cases
  // (enforce-batch-scope-ledger-presence T4 + dp-reviewer C1/C-C regression
  // cases c-ledger-g/c-ledger-h + round-3 follow-up positive control
  // c-ledger-i + PR #2279 cross-model dispute rename-safety regression
  // c-ledger-j), appended at file end.
  runner_b: [81, 147],
});
const ARCHIVE_GATE_TEST_GROUP_RANGE_END = Math.max(
  ...Object.values(ARCHIVE_GATE_TEST_GROUP_RANGES).map(([, end]) => end),
);
let archiveGateTestIndex = 0;

if (!Object.hasOwn(ARCHIVE_GATE_TEST_GROUP_RANGES, ARCHIVE_GATE_TEST_GROUP)) {
  throw new Error(`unknown pre-pr-archive-gate test group: ${ARCHIVE_GATE_TEST_GROUP}`);
}

function archiveGateTestGroupForIndex(index) {
  for (const [group, [start, end]] of Object.entries(ARCHIVE_GATE_TEST_GROUP_RANGES)) {
    if (index >= start && index <= end) return group;
  }
  throw new Error(`pre-pr-archive-gate test index ${index} has no group`);
}

function test(name, optionsOrFn, maybeFn) {
  archiveGateTestIndex += 1;
  if (archiveGateTestGroupForIndex(archiveGateTestIndex) !== ARCHIVE_GATE_TEST_GROUP) return;
  if (typeof optionsOrFn === 'function') {
    return nodeTest(name, optionsOrFn);
  }
  return nodeTest(name, optionsOrFn, maybeFn);
}

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../pre-pr-archive-gate.mjs'
);

// Valid proposal content for fixtures that are not testing heading checks.
// All archive proposals must have:
//   ## Why + ## What Changes (check c)
//   ## Issue Anchor Verification with grep evidence (check d)
//   ## Requirement Ledger with lineage + disposition table + [Req] task trace (check m)
//   ## Batch Approval Ledger (check c extension, enforce-batch-scope-ledger-presence)
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

const DUPLICATE_LEDGER_PROPOSAL_CONTENT = VALID_PROPOSAL_CONTENT.replace(
  'Full task ledger: tasks.md. Scope trace: [Req: R1].',
  '- [x] [Req: R1] duplicate proposal task\n  - 驗收:duplicated'
);

const DEFERRED_DUPLICATE_LEDGER_PROPOSAL_CONTENT =
  VALID_PROPOSAL_CONTENT +
  '\n## Deferred\n\n' +
  '- [ ] [Req: R1] duplicate deferred-area proposal task\n';

function setupFixture(structure) {
  // structure: {
  //   active: ['name1'],
  //   archives: [{ name, specs: ['cap1'], proposalContent: '...', specContents: { 'cap1': '...' } }],
  //   canonicalSpecs: ['cap1'],
  //   canonicalSpecContents: { 'cap1': '...' },
  // }
  // proposalContent defaults to VALID_PROPOSAL_CONTENT; set explicitly to test check (c)
  const dir = makeTempDir('archive-gate-test-');
  const changesDir = path.join(dir, 'openspec/changes');
  mkdirSync(changesDir, { recursive: true });

  for (const name of (structure.active || [])) {
    mkdirSync(path.join(changesDir, name), { recursive: true });
    writeFileSync(path.join(changesDir, name, 'proposal.md'), '');
  }

  if (structure.archives) {
    const archiveDir = path.join(changesDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    for (const a of structure.archives) {
      const archChange = path.join(archiveDir, a.name);
      mkdirSync(archChange, { recursive: true });
      if (a.proposalContent !== undefined || a.proposalMiniContent === undefined) {
        const proposalContent = a.proposalContent !== undefined ? a.proposalContent : VALID_PROPOSAL_CONTENT;
        writeFileSync(path.join(archChange, 'proposal.md'), proposalContent);
      }
      if (a.tasksContent !== undefined) {
        writeFileSync(path.join(archChange, 'tasks.md'), a.tasksContent);
      }
      if (a.proposalMiniContent !== undefined) {
        writeFileSync(path.join(archChange, 'proposal-mini.md'), a.proposalMiniContent);
      }
      if (a.specs) {
        for (const cap of a.specs) {
          const capDir = path.join(archChange, 'specs', cap);
          mkdirSync(capDir, { recursive: true });
          const specContent = a.specContents && Object.prototype.hasOwnProperty.call(a.specContents, cap)
            ? a.specContents[cap]
            : '# ' + cap + ' Spec Delta\n';
          writeFileSync(path.join(capDir, 'spec.md'), specContent);
        }
      }
    }
  }

  if (structure.canonicalSpecs) {
    for (const cap of structure.canonicalSpecs) {
      const specDir = path.join(dir, 'openspec/specs', cap);
      mkdirSync(specDir, { recursive: true });
      const canonicalContent =
        structure.canonicalSpecContents && Object.prototype.hasOwnProperty.call(structure.canonicalSpecContents, cap)
          ? structure.canonicalSpecContents[cap]
          : '# ' + cap + ' Specification\n## Purpose\nx\n## Requirements\n';
      writeFileSync(path.join(specDir, 'spec.md'), canonicalContent);
    }
  }

  return dir;
}

function gitFixture(repo, args, acceptedStatuses = [0]) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.ok(
    acceptedStatuses.includes(result.status),
    `git ${args.join(' ')} exited ${result.status}\n${result.stderr}`
  );
  return result;
}

function run(fixtureDir, env = {}, { sourceTopology = false } = {}) {
  // Legacy cases exercise other archive gates. A proposal carrier now proves
  // BRD applicability, so supply the canonical valid fixture unless a BRD
  // negative explicitly opts out.
  if (env.DEVPRO_FIXTURE_ALLOW_MISSING_BRD !== '1') {
    const archiveRoot = path.join(fixtureDir, 'openspec/changes/archive');
    if (existsSync(archiveRoot)) {
      for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const changeDir = path.join(archiveRoot, entry.name);
        const carrierCount = ['proposal.md', 'proposal-mini.md']
          .filter((name) => existsSync(path.join(changeDir, name))).length;
        if (carrierCount >= 1 && !existsSync(path.join(changeDir, 'brd.md'))) {
          writeFileSync(path.join(changeDir, 'brd.md'), VALID_BRD_CONTENT);
        }
      }
    }
  }
  // Gate (e) requires real committed/staged/unstaged/untracked probes even
  // when the assertion is empty. Legacy archive fixtures are initialized as a
  // clean repository here so their carrier scope is authoritatively empty.
  if (!existsSync(path.join(fixtureDir, '.git'))) {
    gitFixture(fixtureDir, ['init', '-q', '-b', 'main']);
    gitFixture(fixtureDir, ['config', 'user.email', 'fixture@example.invalid']);
    gitFixture(fixtureDir, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(fixtureDir, '.fixture-baseline'), 'archive-gate fixture\n');
    if (sourceTopology) {
      mkdirSync(path.join(fixtureDir, '.devpro/scripts'), { recursive: true });
      mkdirSync(path.join(fixtureDir, '.devpro/agent-rules'), { recursive: true });
      writeFileSync(path.join(fixtureDir, '.devpro/scripts/pre-pr-archive-gate.mjs'), '');
      writeFileSync(path.join(fixtureDir, '.devpro/agent-rules/rule-audit-playbook.md'), '# sentinel\n');
      writeFileSync(path.join(fixtureDir, '.devpro/agent-rules/deleted-rule.md'), '# removed\n');
      gitFixture(fixtureDir, ['remote', 'add', 'origin', 'https://example.invalid/devpro-agent-rules.git']);
    }
    gitFixture(fixtureDir, ['add', '.']);
    gitFixture(fixtureDir, ['commit', '-q', '-m', 'fixture baseline']);
  }
  const baseline = gitFixture(fixtureDir, ['rev-parse', 'origin/main^{commit}'], [0, 128]);
  if (baseline.status !== 0) {
    gitFixture(fixtureDir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
  if (sourceTopology && existsSync(path.join(fixtureDir, '.devpro/agent-rules/deleted-rule.md'))) {
    rmSync(path.join(fixtureDir, '.devpro/agent-rules/deleted-rule.md'));
  }
  return spawnSync('node', [GATE, fixtureDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Generic archive-gate cases do not exercise rule-carrier readability.
      DEVPRO_PR_TOUCHED_RULE_FILES: sourceTopology ? '.devpro/agent-rules/deleted-rule.md' : '',
      ...env,
    },
  });
}

test('case 1: active change folder (owned by branch) → exit 1', () => {
  const dir = setupFixture({ active: ['feature-x'] });
  try {
    // issue #848 Gap 3: gate (a) is scope-bound — it blocks only on an active
    // change folder this branch OWNS. Mark `feature-x` owned via the diff-active
    // override so this case keeps testing the "own un-archived change → block"
    // path. (A separate test covers inherited/non-owned folders not blocking.)
    const r = run(dir, { DEVPRO_DIFF_ACTIVE_CHANGES: 'feature-x' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Active change folder still exists/);
    assert.match(r.stderr, /feature-x/);
    assert.ok(r.stderr.includes('openspec-step-1-to-9.md'), 'fail message must include SOP filename pointer');
    assert.ok(r.stderr.includes('chore/docs-archive-<name>-recovery'), 'fail message must include canonical rescue branch naming pattern');
    assert.ok(!r.stderr.includes('chore/archive-post-merge-'), 'fail message must not recommend stale branch naming pattern');
    assert.match(r.stderr, /If <name> matches your current branch suffix/, 'must include current-branch case guidance');
    assert.match(r.stderr, /If <name> is leftover from a merged prior PR/, 'must include leftover-recovery case guidance');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 1b (issue #848 Gap 3): inherited active change NOT owned by branch → exit 0', () => {
  // Repos that keep multiple in-progress multi-phase changes on main inherit
  // other PRs' active folders in the working tree. Gate (a) must NOT block on
  // them — only on a folder this branch owns (diff-touched or branch-suffix).
  // Empty diff-active set + no matching branch suffix → none owned → pass.
  const dir = setupFixture({ active: ['someone-elses-wip', 'another-wip'] });
  try {
    const r = run(dir, { DEVPRO_DIFF_ACTIVE_CHANGES: '' });
    assert.equal(r.status, 0, `expected exit 0 (inherited WIP must not block), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Active change folder still exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 2: latest archive 無 specs/ → exit 0 (chore A 合法)', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-04-27-chore-a' }],
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 3: relevant archive 有 specs/cap/ 但 canonical 缺 → exit 1', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-04-27-feat', specs: ['my-cap'] }],
    // canonicalSpecs 故意不含 my-cap
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-04-27-feat' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Capability spec not promoted/);
    assert.match(r.stderr, /my-cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 4: 全 clean → exit 0', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-04-27-feat', specs: ['my-cap'] }],
    canonicalSpecs: ['my-cap'],
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 4c (#1746): clean Git fixture reports an authoritative known-empty carrier scope', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-04-27-feat', specs: ['my-cap'] }],
    canonicalSpecs: ['my-cap'],
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `expected clean pass, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /scope=known-empty; checked=0; verdict=pass/);
    assert.doesNotMatch(r.stdout, /effective-scope advisory/);
    assert.match(r.stdout, /Pre-PR archive gate: pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case 4b: 全 clean → stdout 含 archived-as evidence token (I5)", () => {
  const dir = setupFixture({
    archives: [{ name: '2026-04-27-feat', specs: ['my-cap'] }],
    canonicalSpecs: ['my-cap'],
  });
  // Init a git repo so check(i) git-repo probe passes (otherwise exits 0 early without stdout).
  // Use HEAD as baseline ref + empty DEVPRO_CHANGED_CAPABILITY_SPECS so scenario diff is skipped.
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };
  spawnSync('git', ['-C', dir, 'init'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { encoding: 'utf8', env: gitEnv });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-04-27-feat',
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',  // empty → changedSpecs=[] → skip scenario diff body
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',  // HEAD resolves; body skipped since no changedSpecs
    });
    assert.equal(r.status, 0, 'exit 0 expected on clean pass');
    assert.match(
      r.stdout,
      /archived as ['"][\w-]+['"]/,
      "stdout must contain archived-as evidence for /dp:pre-pr and PR audit trail"
    );
    assert.match(r.stdout, /2026-04-27-feat/, 'stdout must contain latest archive name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CHECK_P_DELTA_SPEC =
  '# cap-p Spec Delta\n\n' +
  '## ADDED Requirements\n\n' +
  '### Requirement: Archive Promotion Completeness\n\n' +
  '#### Scenario: promoted body line retained\n\n' +
  '- THEN the archive gate SHALL verify promoted key phrases.\n';

const CHECK_P_CANONICAL_COMPLETE =
  '# cap-p Specification\n\n' +
  '## Purpose\n\nreal purpose\n\n' +
  '## Requirements\n\n' +
  '### Requirement: Archive Promotion Completeness\n\n' +
  '#### Scenario: promoted body line retained\n\n' +
  '- THEN the archive gate SHALL verify promoted key phrases.\n';

const CHECK_P_CANONICAL_HEADINGS_ONLY =
  '# cap-p Specification\n\n' +
  '## Purpose\n\nreal purpose\n\n' +
  '## Requirements\n\n' +
  '### Requirement: Archive Promotion Completeness\n\n' +
  '#### Scenario: promoted body line retained\n';

test('case 4c (check p): archived delta normative body missing from canonical → exit 1', () => {
  const archiveName = '2026-07-13-check-p-missing-body';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      specs: ['cap-p'],
      specContents: { 'cap-p': CHECK_P_DELTA_SPEC },
    }],
    canonicalSpecs: ['cap-p'],
    canonicalSpecContents: { 'cap-p': CHECK_P_CANONICAL_HEADINGS_ONLY },
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    });
    assert.equal(r.status, 1, `expected exit 1 (check p should block), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(p\)/);
    assert.match(r.stderr, /cap-p/);
    assert.match(r.stderr, /THEN the archive gate SHALL verify promoted key phrases/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 4d (check p): archived delta fully promoted to canonical → exit 0', () => {
  const archiveName = '2026-07-13-check-p-complete';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      specs: ['cap-p'],
      specContents: { 'cap-p': CHECK_P_DELTA_SPEC },
    }],
    canonicalSpecs: ['cap-p'],
    canonicalSpecContents: { 'cap-p': CHECK_P_CANONICAL_COMPLETE },
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    });
    assert.equal(r.status, 0, `expected exit 0 (check p complete), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(p\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 4e (check p): no relevant archive set → skip historical completeness debt', () => {
  const dir = setupFixture({
    archives: [{
      name: '2026-07-13-check-p-historical-debt',
      specs: ['cap-p'],
      specContents: { 'cap-p': CHECK_P_DELTA_SPEC },
    }],
    canonicalSpecs: ['cap-p'],
    canonicalSpecContents: { 'cap-p': CHECK_P_CANONICAL_HEADINGS_ONLY },
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (empty relevant set skips check p), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(p\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 5: 多 archive 取 latest 字母序最大 → exit 0', () => {
  const dir = setupFixture({
    archives: [
      { name: '2026-04-25-old', specs: ['cap-a'] },  // canonical 缺但是 old archive
      { name: '2026-04-27-new', specs: ['cap-b'] },
    ],
    canonicalSpecs: ['cap-b'],  // 只 promote latest 的 cap，old 的不要求
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 5b (#887): pass evidence uses relevant archive, not unrelated lexicographic latest', () => {
  const dir = setupFixture({
    archives: [
      { name: '2026-06-04-fix-cross-model-sticky-allowlist', specs: ['cap-a'] },
      { name: '2026-06-04-strengthen-platform-adapter-bootstrap', specs: ['cap-b'] },
    ],
    canonicalSpecs: ['cap-a', 'cap-b'],
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-04-fix-cross-model-sticky-allowlist',
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /archived as '2026-06-04-fix-cross-model-sticky-allowlist'/);
    assert.doesNotMatch(r.stdout, /archived as '2026-06-04-strengthen-platform-adapter-bootstrap'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 5c (#887): pass evidence detects untracked current archive before first commit', () => {
  const currentArchive = '2026-06-04-fix-open-rule-feedback-issues';
  const unrelatedLatest = '2026-06-04-strengthen-platform-adapter-bootstrap';
  const dir = setupFixture({
    archives: [{ name: unrelatedLatest, specs: ['cap-b'] }],
    canonicalSpecs: ['cap-b'],
  });
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed unrelated archive'], { encoding: 'utf8', env: gitEnv });

  const currentPath = path.join(dir, 'openspec/changes/archive', currentArchive);
  mkdirSync(path.join(currentPath, 'specs/cap-a'), { recursive: true });
  writeFileSync(path.join(currentPath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(currentPath, 'brd.md'), VALID_BRD_CONTENT);
  writeFileSync(path.join(currentPath, 'specs/cap-a/spec.md'), '# cap-a Spec Delta\n');
  const capADir = path.join(dir, 'openspec/specs/cap-a');
  mkdirSync(capADir, { recursive: true });
  writeFileSync(path.join(capADir, 'spec.md'), '# cap-a Specification\n## Purpose\nx\n## Requirements\n');

  try {
    const r = run(dir, {
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
      DEVPRO_FIXTURE_ALLOW_MISSING_BRD: '1',
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`archived as '${currentArchive}'`));
    assert.doesNotMatch(r.stdout, new RegExp(`archived as '${unrelatedLatest}'`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 6: openspec/changes/ 不存在 → exit 0 (no-op pass-through)', () => {
  const dir = makeTempDir('archive-gate-empty-');
  try {
    const r = run(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 7 (check c): archive 含 proposal-mini.md 但缺 ## Why → exit 1 stderr 含 missing required heading', () => {
  // Use setupFixture with proposalContent = '' (no headings) so proposal.md won't pass check (c),
  // then add a separate proposal-mini.md with only ## What Changes
  const dir = setupFixture({
    archives: [{
      name: '2026-05-01-test-change',
      // proposal.md with missing ## Why will trigger check (c)
      proposalContent: '# Proposal-Mini: test-change\n\n## What Changes\n\nsome changes\n',
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-05-01-test-change' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required heading/);
    assert.ok(r.stderr.includes('## Why'), 'stderr 應列出缺少的 heading: ## Why');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 8 (check c): archive 含 proposal.md 含 ## Why 與 ## What Changes → exit 0', () => {
  // Uses default VALID_PROPOSAL_CONTENT which has both headings
  const dir = setupFixture({
    archives: [{ name: '2026-05-01-test-change' }],
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Issue #497 scope-bound (d)(e)(g) regression cases ──────────────────────
// `DEVPRO_RELEVANT_ARCHIVES` env var overrides git diff detection so fixtures
// (which lack git history) can simulate "this PR's diff touches archive X".

test('case 9 (#497 scope-bound): PR diff touches no archive → (d)/(e)/(g) skip even when latest archive has missing sections', () => {
  // Latest archive deliberately missing ## Issue Anchor Verification + ## Token Budget Check
  // (would have blocked under legacy latest-only behavior). With empty
  // DEVPRO_RELEVANT_ARCHIVES, gates (d)/(e)/(g) skip → exit 0.
  const dir = setupFixture({
    archives: [{
      name: '2026-05-09-pre-existing-debt',
      proposalContent: '# Proposal: pre-existing\n\n## Why\n\nx\n\n## What Changes\n\ny\n',
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (out-of-scope debt), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 10 (#497 scope-bound): PR diff DOES touch archive lacking ## Issue Anchor Verification → (d) blocks', () => {
  // specs/ + canonicalSpecs are needed so check (b) passes and the fixture
  // isolates the intended check (d) failure.
  const dir = setupFixture({
    archives: [{
      name: '2026-05-10-this-prs-archive',
      specs: ['cap-x'],
      proposalContent: '# Proposal: this-prs\n\n## Why\n\nx\n\n## What Changes\n\ny\n\n' +
        BATCH_APPROVAL_LEDGER_NA_SECTION,
      // intentionally lacks ## Issue Anchor Verification + ## Token Budget Check
    }],
    canonicalSpecs: ['cap-x'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-05-10-this-prs-archive' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Issue Anchor Verification Gate \(d\)/);
    assert.match(r.stderr, /2026-05-10-this-prs-archive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 11 (#497 scope-bound): definite source deletion lacks Gate G sections → blocks', () => {
  const dir = setupFixture({
    archives: [{
      name: '2026-05-10-dedup-trigger',
      specs: ['cap-y'],
      proposalContent:
        '# Proposal: dedup-trigger\n\n' +
        '## Why\n\nfile merge\n\n' +
        '## What Changes\n\nfile delete some leaf\n\n' +
        '## Issue Anchor Verification\n\n`grep` → 1 hit @ x:1\n\n' +
        BATCH_APPROVAL_LEDGER_NA_SECTION,
      // The authoritative manifest carries the definite source deletion;
      // proposal wording is irrelevant. Missing Gate G ledgers must block.
    }],
    canonicalSpecs: ['cap-y'],
  });
  try {
    const r = run(
      dir,
      { DEVPRO_RELEVANT_ARCHIVES: '2026-05-10-dedup-trigger' },
      { sourceTopology: true }
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Gate G Dedup Audit \(g\)/);
    assert.match(r.stderr, /2026-05-10-dedup-trigger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (h): Archive spec.md drift detection ────────────────────────────
// These tests require a real git repo so that `git log --follow` works.
// We set up a temp git repo, commit the initial archive spec.md (simulating
// the archive commit), then add a second commit modifying that spec.md
// (simulating post-archive drift). The gate should detect commit count > 1.

const tmpGitRoot = makeTempDir('archive-gate-h-test-');
after(() => {
  try {
    rmSync(tmpGitRoot, { recursive: true, force: true });
  } catch {}
});

// Perf pattern (a): the `git init -b main` + repo-level user config prefix is
// identical for every git-backed fixture below and is the dominant per-fixture
// spawn cost (init + 2 config ≈ 3 real git forks × ~a dozen fixtures). Build it
// ONCE lazily as a read-only template, then hand each fixture a fresh copy via
// `cpSync`. The gate under test reads git state read-only (rev-parse/ls-tree/
// show/log/diff/merge-base — never add/commit/checkout against the fixture), and
// each fixture commits only into its OWN cpSync'd copy, so there is no shared-
// live-dir pollution: the template is never committed into after creation.
let emptyGitRepoTemplate = null;
function getEmptyGitRepoTemplate() {
  if (emptyGitRepoTemplate) return emptyGitRepoTemplate;
  const dir = mkdtempSync(path.join(tmpGitRoot, 'git-template-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  emptyGitRepoTemplate = dir;
  return dir;
}

// Return a fresh initialized-git-repo dir (main branch + user config already set)
// by copying the shared template instead of re-running `git init` + config.
// Callers still run their own fixture-specific commits into the returned copy.
function newInitializedGitRepo(parentDir = tmpGitRoot, prefix = 'repo-') {
  const dir = mkdtempSync(path.join(parentDir, prefix));
  cpSync(getEmptyGitRepoTemplate(), dir, { recursive: true });
  return dir;
}

/**
 * Create a minimal git repo with archive structure for check (h) tests.
 * Returns the repo root dir.
 * `withDrift`: if true, add a second commit modifying the spec.md after the first.
 * `withNonSpecFile`: if true, second commit only modifies a non-spec file (brd.md).
 */
function setupGitFixture({ archiveName, withDrift = false, withNonSpecFile = false, noSpecs = false }) {
  // Init git repo (main + user config) via shared template copy (perf pattern a)
  const dir = newInitializedGitRepo();

  // Create openspec/changes/archive structure
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  mkdirSync(path.join(archivePath), { recursive: true });
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);

  if (!noSpecs) {
    const capDir = path.join(archivePath, 'specs/cap-x');
    mkdirSync(capDir, { recursive: true });
    writeFileSync(path.join(capDir, 'spec.md'), '# cap-x Spec Delta\nv1\n');
  }

  // Also create canonical spec so check (b) passes
  if (!noSpecs) {
    const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(path.join(canonicalDir, 'spec.md'), '# cap-x Specification\n## Purpose\nx\n## Requirements\n');
  }

  // Initial commit (simulates "archive commit")
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'archive: add archive folder'], { cwd: dir });

  if (withDrift && !noSpecs) {
    // Second commit modifying spec.md inside archive (simulates post-archive drift)
    const specPath = path.join(archivePath, 'specs/cap-x/spec.md');
    writeFileSync(specPath, '# cap-x Spec Delta\nv2 (drifted)\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'fix: edit archive spec.md directly (drift)'], { cwd: dir });
  }

  if (withNonSpecFile && !noSpecs) {
    // Second commit modifying a non-spec file (brd.md) — should NOT trigger (h).
    // Write a valid brd.md (all 12 required fields) so check (j) does NOT block:
    // the purpose of this fixture is to test check (h) non-spec-file tolerance,
    // not brd.md field completeness.
    writeFileSync(path.join(archivePath, 'brd.md'), VALID_BRD_CONTENT);
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'fix: update brd.md in archive'], { cwd: dir });
  }

  return dir;
}

function setupGitRenameIntoArchiveFixture() {
  const dir = newInitializedGitRepo();
  const changeName = 'feat-normal-archive';
  const archiveName = '2026-05-11-feat-normal-archive';

  const activeCapDir = path.join(dir, 'openspec/changes', changeName, 'specs/cap-x');
  mkdirSync(activeCapDir, { recursive: true });
  writeFileSync(path.join(activeCapDir, 'spec.md'), '# cap-x Spec Delta\nv1\n');

  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(path.join(canonicalDir, 'spec.md'), '# cap-x Specification\n## Purpose\nx\n## Requirements\n');

  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'feat: add active spec delta'], { cwd: dir });

  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const archiveCapDir = path.join(archivePath, 'specs/cap-x');
  mkdirSync(archiveCapDir, { recursive: true });
  renameSync(path.join(activeCapDir, 'spec.md'), path.join(archiveCapDir, 'spec.md'));
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  rmSync(path.join(dir, 'openspec/changes', changeName), { recursive: true, force: true });

  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: archive normal change'], { cwd: dir });

  return dir;
}

/**
 * Simulate the Pre-merge Archive Re-do sequence (issue #848 follow-up): a change
 * is archived (commit 1, promotes canonical + writes archive delta), then
 * `git revert`ed back to active (commit 2, un-promotes canonical + removes
 * archive delta), then re-archived (commit 3, re-promotes canonical + re-writes
 * archive delta). The archived spec.md path thus has 3 commits, but EVERY one
 * also touches the canonical spec — so there is no real drift. The old
 * commit-count>1 heuristic false-positived here (this is what blocked PR #852's
 * push); the both-vs-archive-only classification must let it pass.
 */
function setupGitRedoFixture() {
  const dir = newInitializedGitRepo();
  const changeName = 'feat-redo';
  const archiveName = '2026-06-02-feat-redo';

  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  mkdirSync(canonicalDir, { recursive: true });
  const canonicalSpec = path.join(canonicalDir, 'spec.md');
  writeFileSync(canonicalSpec, '# cap-x Specification\n## Purpose\nx\n## Requirements\n');
  writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'seed: canonical spec exists'], { cwd: dir });

  // commit 1: archive — write archive delta + bump canonical (promote), same commit
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const archiveCapDir = path.join(archivePath, 'specs/cap-x');
  mkdirSync(archiveCapDir, { recursive: true });
  writeFileSync(path.join(archiveCapDir, 'spec.md'), '# cap-x Spec Delta\nv1\n');
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(canonicalSpec, '# cap-x Specification\n## Purpose\nx\n## Requirements\n### Requirement: R\nThe system SHALL x.\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: archive feat-redo'], { cwd: dir });
  const archiveSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();

  // commit 2: git revert the archive commit — removes archive delta + un-promotes
  // canonical, in one commit (touches both paths).
  spawnSync('git', ['revert', '--no-edit', archiveSha], { cwd: dir });

  // commit 3: re-archive — re-write archive delta + re-promote canonical, same commit
  mkdirSync(archiveCapDir, { recursive: true });
  writeFileSync(path.join(archiveCapDir, 'spec.md'), '# cap-x Spec Delta\nv2 (re-archived)\n');
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(canonicalSpec, '# cap-x Specification\n## Purpose\nx\n## Requirements\n### Requirement: R\nThe system SHALL x (v2).\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: re-archive feat-redo'], { cwd: dir });

  return { dir, archiveName };
}

/**
 * Reproduce the real PR #1694 history: canonical behavior already exists, the
 * archived path is introduced in a later archive-only commit, and a subsequent
 * valid repair edits the archive delta and canonical spec together. The path
 * introduction is not post-archive drift and must not combine with the later
 * paired edit to form a false positive.
 */
function setupGitArchiveIntroductionThenPairedEditFixture() {
  const dir = newInitializedGitRepo();
  const archiveName = '2026-07-18-introduction-then-paired-edit';
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const archiveCapDir = path.join(archivePath, 'specs/cap-x');
  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  const archiveSpec = path.join(archiveCapDir, 'spec.md');
  const canonicalSpec = path.join(canonicalDir, 'spec.md');
  const requirementV1 = '### Requirement: Existing behavior\n\nThe system SHALL preserve version one.\n';
  const requirementV2 = '### Requirement: Existing behavior\n\nThe system SHALL preserve version two.\n';
  const renderDelta = (requirement) =>
    `# cap-x Spec Delta\n\n## MODIFIED Requirements\n\n${requirement}`;
  const renderCanonical = (requirement) =>
    `# cap-x Specification\n\n## Purpose\n\nFixture.\n\n## Requirements\n\n${requirement}`;

  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(canonicalSpec, renderCanonical(requirementV1));
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'feat: promote behavior before archive path exists'], { cwd: dir });

  mkdirSync(archiveCapDir, { recursive: true });
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(archiveSpec, renderDelta(requirementV1));
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: introduce archived delta'], { cwd: dir });

  writeFileSync(archiveSpec, renderDelta(requirementV2));
  writeFileSync(canonicalSpec, renderCanonical(requirementV2));
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'fix: update archive and canonical together'], { cwd: dir });

  return { dir, archiveName };
}

function setupGitCanonicalBackfillFixture({ matchingCanonical = true, repairCanonicalAfterBackfill = false } = {}) {
  const dir = newInitializedGitRepo();
  const archiveName = '2026-07-17-canonical-backfill';
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const archiveCapDir = path.join(archivePath, 'specs/cap-x');
  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  mkdirSync(archiveCapDir, { recursive: true });
  mkdirSync(canonicalDir, { recursive: true });

  const requirementA =
    '### Requirement: Existing behavior\n\n' +
    'The system SHALL preserve existing behavior.\n';
  const requirementB =
    '### Requirement: Canonical backfill\n\n' +
    'The system SHALL accept an exact archived backfill.\n';
  const canonicalRequirementB = matchingCanonical
    ? requirementB
    : requirementB.replace('exact archived backfill', 'different canonical behavior');

  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(
    path.join(archiveCapDir, 'spec.md'),
    '# cap-x Spec Delta\n\n## MODIFIED Requirements\n\n' + requirementA
  );
  writeFileSync(
    path.join(canonicalDir, 'spec.md'),
    '# cap-x Specification\n\n## Purpose\n\nFixture.\n\n## Requirements\n\n' +
      requirementA + '\n' + canonicalRequirementB
  );
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: archive fixture'], { cwd: dir });

  // Mechanical repair: append one complete Requirement block that already
  // exists byte-for-byte in the canonical blob at this commit. The canonical
  // path is intentionally untouched by this commit.
  writeFileSync(
    path.join(archiveCapDir, 'spec.md'),
    '# cap-x Spec Delta\n\n## MODIFIED Requirements\n\n' + requirementA + '\n' + requirementB
  );
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'fix: backfill archived canonical requirement'], { cwd: dir });

  if (repairCanonicalAfterBackfill) {
    writeFileSync(
      path.join(canonicalDir, 'spec.md'),
      '# cap-x Specification\n\n## Purpose\n\nFixture.\n\n## Requirements\n\n' +
        requirementA + '\n' + requirementB
    );
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'fix: align canonical after archive edit'], { cwd: dir });
  }

  return { dir, archiveName };
}

function setupGitRejectedBackfillFixture(kind) {
  const dir = newInitializedGitRepo();
  const archiveName = `2026-07-17-rejected-backfill-${kind}`;
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const archiveCapDir = path.join(archivePath, 'specs/cap-x');
  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  const archiveSpec = path.join(archiveCapDir, 'spec.md');
  const canonicalSpec = path.join(canonicalDir, 'spec.md');
  mkdirSync(archiveCapDir, { recursive: true });
  mkdirSync(canonicalDir, { recursive: true });

  const requirementA =
    '### Requirement: Existing behavior\n\n' +
    'The system SHALL preserve existing behavior.\n';
  const requirementAExtended = requirementA + 'The extension MUST NOT be appended without its heading.\n';
  const requirementB =
    '### Requirement: Canonical backfill\n\n' +
    'The system SHALL accept an exact archived backfill.\n';
  const requirementC =
    '### Requirement: Second canonical backfill\n\n' +
    'The system SHALL reject a multi-Requirement repair.\n';
  const deltaPrefix = '# cap-x Spec Delta\n\nRepair description.\n\n## MODIFIED Requirements\n\n';
  const canonicalPrefix = '# cap-x Specification\n\n## Purpose\n\nFixture.\n\n## Requirements\n\n';

  const parentBody = kind === 'parent-duplicate' ? requirementA + '\n' + requirementB : requirementA;
  let canonicalBody = requirementA + '\n' + requirementB;
  if (kind === 'canonical-missing') canonicalBody = requirementA;
  if (kind === 'canonical-duplicate') canonicalBody += '\n' + requirementB;
  if (kind === 'partial-block') canonicalBody = requirementAExtended;
  if (kind === 'two-requirements') canonicalBody += '\n' + requirementC;

  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(archiveSpec, deltaPrefix + parentBody);
  writeFileSync(canonicalSpec, canonicalPrefix + canonicalBody);
  if (kind === 'invalid-utf8') {
    writeFileSync(
      canonicalSpec,
      Buffer.concat([
        Buffer.from(canonicalPrefix + requirementA + '\n### Requirement: Canonical backfill\n\n'),
        Buffer.from([0xff]),
        Buffer.from('The system SHALL reject invalid UTF-8.\n'),
      ])
    );
  }
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: archive rejected-backfill fixture'], { cwd: dir });

  if (kind === 'partial-block') {
    writeFileSync(archiveSpec, deltaPrefix + requirementAExtended);
  } else if (kind === 'two-requirements') {
    writeFileSync(archiveSpec, deltaPrefix + requirementA + '\n' + requirementB + '\n' + requirementC);
  } else if (kind === 'two-hunks') {
    writeFileSync(
      archiveSpec,
      deltaPrefix.replace('Repair description.\n', 'Repair description.\nSecond preamble line.\n') +
        requirementA + '\n' + requirementB
    );
  } else if (kind === 'invalid-utf8') {
    writeFileSync(
      archiveSpec,
      Buffer.concat([
        Buffer.from(deltaPrefix + requirementA + '\n### Requirement: Canonical backfill\n\n'),
        Buffer.from([0xff]),
        Buffer.from('The system SHALL reject invalid UTF-8.\n'),
      ])
    );
  } else {
    writeFileSync(archiveSpec, deltaPrefix + parentBody + '\n' + requirementB);
  }
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', `fix: rejected backfill ${kind}`], { cwd: dir });

  return { dir, archiveName };
}

function setupGitMergeBackfillFixture() {
  const dir = newInitializedGitRepo();
  const archiveName = '2026-07-17-rejected-backfill-merge';
  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const archiveCapDir = path.join(archivePath, 'specs/cap-x');
  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  const archiveSpec = path.join(archiveCapDir, 'spec.md');
  mkdirSync(archiveCapDir, { recursive: true });
  mkdirSync(canonicalDir, { recursive: true });
  const requirementA = '### Requirement: Existing behavior\n\nThe system SHALL preserve existing behavior.\n';
  const requirementB = '### Requirement: Canonical backfill\n\nThe system SHALL accept an exact archived backfill.\n';
  const renderDelta = (description, includeBackfill = false) => (
    `# cap-x Spec Delta\n\n${description}\n\n## MODIFIED Requirements\n\n${requirementA}` +
    (includeBackfill ? `\n${requirementB}` : '')
  );

  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(archiveSpec, renderDelta('Base description.'));
  writeFileSync(
    path.join(canonicalDir, 'spec.md'),
    '# cap-x Specification\n\n## Purpose\n\nFixture.\n\n## Requirements\n\n' + requirementA + '\n' + requirementB
  );
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: archive merge fixture'], { cwd: dir });

  spawnSync('git', ['checkout', '-q', '-b', 'backfill-parent'], { cwd: dir });
  writeFileSync(archiveSpec, renderDelta('Branch description.'));
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'docs: branch preamble'], { cwd: dir });

  spawnSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  writeFileSync(archiveSpec, renderDelta('Main description.'));
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'docs: main preamble'], { cwd: dir });
  spawnSync('git', ['merge', '--no-ff', 'backfill-parent', '-m', 'merge: replay backfill'], { cwd: dir });
  writeFileSync(archiveSpec, renderDelta('Merged description.', true));
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '--no-edit'], { cwd: dir });

  return { dir, archiveName };
}

test('case 12 (check h): post-archive edit of spec.md → block with SSOT drift message', () => {
  const archiveName = '2026-05-11-feat-with-drift';
  const dir = setupGitFixture({
    archiveName,
    withDrift: true,
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (drift detected), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
    assert.match(r.stderr, /SSOT drift/);
    assert.match(r.stderr, /git revert/);
    assert.match(r.stderr, /openspec archive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 13 (check h): archive folder without specs/ (B-type bugfix, no capability delta) → allow', () => {
  const archiveName = '2026-05-11-bugfix-no-caps';
  const dir = setupGitFixture({
    archiveName,
    noSpecs: true,
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CHANGED_CAPABILITY_SPECS: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    });
    assert.equal(r.status, 0, `expected exit 0 (no specs to check), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14 (check h): archive folder spec.md has single commit (no drift) → allow', () => {
  const archiveName = '2026-05-11-feat-clean';
  // withDrift=false → only the initial archive commit → commitCount = 1 → pass
  const dir = setupGitFixture({
    archiveName,
    withDrift: false,
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      // check (h) fixtures git-init with local `main` but no `origin/main`;
      // point check (i)'s baseline at local main so its fail-closed ref-resolve
      // does not interfere with cases that only test check (h) behavior.
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (single commit, no drift), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14b (check h): active spec renamed into archive without post-archive edit → allow', () => {
  const dir = setupGitRenameIntoArchiveFixture();
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-05-11-feat-normal-archive',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (normal archive rename is not drift), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14c (check h, issue #848): Pre-merge Archive Re-do (archive→revert→re-archive) → allow', () => {
  // The archived spec.md path has 3 commits, but every one also touches the
  // canonical spec (promote / un-promote / re-promote), so there is no
  // archive-only commit → no drift. This is the exact false positive that
  // blocked PR #852's push under the old commit-count>1 heuristic.
  const { dir, archiveName } = setupGitRedoFixture();
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (re-do is not drift), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14c2 (check h): archive path introduction plus later paired edit is not drift → allow', () => {
  const { dir, archiveName } = setupGitArchiveIntroductionThenPairedEditFixture();
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected path introduction plus paired edit to pass, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14d (check h): exact complete canonical Requirement backfill → allow', () => {
  const { dir, archiveName } = setupGitCanonicalBackfillFixture();
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exact canonical backfill to pass, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14e (check h): canonical Requirement differs by one body phrase → block', () => {
  const { dir, archiveName } = setupGitCanonicalBackfillFixture({ matchingCanonical: false });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected mismatched canonical body to block, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 14f (check h): later HEAD alignment cannot legalize an earlier mismatched archive commit → block', () => {
  const { dir, archiveName } = setupGitCanonicalBackfillFixture({
    matchingCanonical: false,
    repairCanonicalAfterBackfill: true,
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected commit-time mismatch to remain blocked, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of [
  'canonical-missing',
  'canonical-duplicate',
  'parent-duplicate',
  'partial-block',
  'two-requirements',
  'two-hunks',
  'invalid-utf8',
]) {
  test(`case 14g (check h): unsafe canonical backfill predicate ${kind} → block`, () => {
    const { dir, archiveName } = setupGitRejectedBackfillFixture(kind);
    try {
      const r = run(dir, {
        DEVPRO_RELEVANT_ARCHIVES: archiveName,
        DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
      });
      assert.equal(r.status, 1, `expected ${kind} to remain archive-only, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('case 14h (check h): merge-commit canonical backfill replay → block', () => {
  const { dir, archiveName } = setupGitMergeBackfillFixture();
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected merge replay to remain archive-only, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 15 (check h): post-archive edit of non-spec.md file (brd.md) → allow', () => {
  const archiveName = '2026-05-11-feat-brd-edit';
  // withNonSpecFile=true → second commit touches brd.md, not spec.md → check (h) skips
  const dir = setupGitFixture({
    archiveName,
    withNonSpecFile: true,
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (non-spec file edit, not blocked by (h)), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Fixture for the preamble-only-vs-Requirement-body refinement (fix-verification-
 * false-positives R1a). Builds a spec.md with a delta preamble (title + change-
 * description prose) BEFORE the first `## ` heading, followed by a
 * `## MODIFIED Requirements` section. Commit 1 is a "both" commit (promote:
 * touches archive delta + canonical together). Commit 2 is archive-only
 * (touches only the archived spec.md) and edits either the preamble region
 * (before the first `## `) or the Requirement-body region (at/after the first
 * `## `), per `editRegion`:
 *   - 'preamble' / 'requirement-body': modify a line in-region (add+remove hunk).
 *   - 'delete-preamble' / 'delete-requirement-body': pure-deletion hunk
 *     (`@@ -a +b,0 @@`) removing a line in-region, no addition — regression
 *     coverage for the pure-deletion pre-image line-number path.
 */
function setupGitPreambleFixture({ archiveName, editRegion }) {
  const dir = newInitializedGitRepo();
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };

  const archivePath = path.join(dir, 'openspec/changes/archive', archiveName);
  const capDir = path.join(archivePath, 'specs/cap-x');
  mkdirSync(capDir, { recursive: true });
  const specPath = path.join(capDir, 'spec.md');
  const canonicalDir = path.join(dir, 'openspec/specs/cap-x');
  mkdirSync(canonicalDir, { recursive: true });
  const canonicalSpec = path.join(canonicalDir, 'spec.md');

  // Commit 1 ("both"): archive delta (preamble + MODIFIED Requirements section)
  // + canonical bump, in the same commit — a genuine promote. Preamble carries
  // two prose lines and the Requirement body carries two lines so a pure
  // deletion of one line in either region leaves the file non-empty and does
  // not also delete/shift the heading itself.
  //
  // The 'delete-cross-boundary' region needs a SECOND `## ` heading further
  // down so that a hunk spanning the first heading still leaves the post-image
  // with a `## ` heading (otherwise `isPreambleOnlyChange` hits its "no
  // post-image heading → return false" early guard before ever inspecting the
  // hunk, and the oldEnd-vs-newEnd distinction never runs).
  //
  // The 'replace-cross-boundary' region needs a distinct base: a deletable
  // preamble block (lines 3-7) immediately followed by the first `## `
  // heading (line 8) and its Requirement body, with the surviving `## `
  // heading pushed WELL below (line 16). The gate diffs at `--unified=0`
  // (pre-pr-archive-gate.mjs isPreambleOnlyChange), so a commit-2 that replaces
  // the block spanning the first heading with a single preamble line emits ONE
  // replacement hunk whose `-` span crosses the heading but whose `+` span
  // stays in the preamble — the exact single-hunk geometry the second Critical
  // needs (verified empirically: `@@ -5,6 +5 @@`, oldEnd 10 ≥ preH 8, newEnd 5
  // < postH 10). Padding keeps the surviving heading > 3 lines below the edit
  // so git does NOT coalesce it into the hunk (which would push newEnd past it
  // and mask the bug).
  let commit1Spec;
  if (editRegion === 'delete-cross-boundary') {
    commit1Spec =
      '# cap-x delta — fixture\n\nOriginal change description prose.\nSecond preamble line.\n\n' +
      '## MODIFIED Requirements\n\n' +
      '### Requirement: R\n\nThe system SHALL x.\n\n' +
      '## ADDED Requirements\n\n' +
      '### Requirement: S\n\nThe system SHALL y.\n';
  } else if (editRegion === 'replace-cross-boundary') {
    commit1Spec =
      '# cap-x delta — fixture\n\n' +          // L1-2
      'P3\nP4\nD5\nD6\nD7\n' +                 // L3-7 preamble prose (D5-D7 deletable)
      '## MODIFIED Requirements\n' +           // L8  first heading (pre-image)
      'BODY9\nBODY10\n' +                      // L9-10 Requirement body
      '\n\n\n\n' +                             // L11-14 spacer (>3 lines)
      '## ADDED Requirements\n' +              // L15 surviving heading (pre-image)
      'TAIL\n';                                // L16
  } else {
    commit1Spec =
      '# cap-x delta — fixture\n\nOriginal change description prose.\nSecond preamble line.\n\n' +
      '## MODIFIED Requirements\n\n' +
      '### Requirement: R\n\nThe system SHALL x.\nSecond requirement-body line.\n';
  }
  writeFileSync(specPath, commit1Spec);
  writeFileSync(path.join(archivePath, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(canonicalSpec, '# cap-x Specification\n## Purpose\nx\n## Requirements\n### Requirement: R\nThe system SHALL x.\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'chore: archive fixture (promote)'], { cwd: dir, env: gitEnv });

  // Commit 2 (archive-only): edit only the archived spec.md, NOT the canonical.
  if (editRegion === 'preamble') {
    writeFileSync(
      specPath,
      '# cap-x delta — fixture\n\nCorrected change description prose (preamble-only).\nSecond preamble line.\n\n' +
      '## MODIFIED Requirements\n\n' +
      '### Requirement: R\n\nThe system SHALL x.\nSecond requirement-body line.\n'
    );
  } else if (editRegion === 'requirement-body') {
    writeFileSync(
      specPath,
      '# cap-x delta — fixture\n\nOriginal change description prose.\nSecond preamble line.\n\n' +
      '## MODIFIED Requirements\n\n' +
      '### Requirement: R\n\nThe system SHALL x, drifted directly in archive.\nSecond requirement-body line.\n'
    );
  } else if (editRegion === 'delete-preamble') {
    // Pure deletion: remove "Second preamble line." with no replacement line.
    writeFileSync(
      specPath,
      '# cap-x delta — fixture\n\nOriginal change description prose.\n\n' +
      '## MODIFIED Requirements\n\n' +
      '### Requirement: R\n\nThe system SHALL x.\nSecond requirement-body line.\n'
    );
  } else if (editRegion === 'delete-requirement-body') {
    // Pure deletion: remove "Second requirement-body line." with no replacement.
    writeFileSync(
      specPath,
      '# cap-x delta — fixture\n\nOriginal change description prose.\nSecond preamble line.\n\n' +
      '## MODIFIED Requirements\n\n' +
      '### Requirement: R\n\nThe system SHALL x.\n'
    );
  } else if (editRegion === 'delete-cross-boundary') {
    // Pure deletion whose span STARTS in the preamble (pre-image line 4,
    // "Second preamble line.", before the first `## ` heading at line 6) but
    // REACHES PAST it into the first Requirement's body — removing the blank,
    // the `## MODIFIED Requirements` heading, "### Requirement: R", and
    // "The system SHALL x." in one hunk (`@@ -4,7 +3,0 @@`). oldStart (4) lands
    // in the preamble (< heading line 6) but oldEnd (10) lands well past it, so
    // a start-only classification would mis-allow it as preamble-only even
    // though the span deletes Requirement-body structure. The post-image still
    // retains the `## ADDED Requirements` heading, so `isPreambleOnlyChange`
    // does NOT hit its no-post-heading early guard and actually exercises the
    // oldEnd span check. Must still block. Regression coverage for cross-model
    // review PR #1497 Critical (oldEnd vs oldStart).
    writeFileSync(
      specPath,
      '# cap-x delta — fixture\n\nOriginal change description prose.\n\n' +
      '## ADDED Requirements\n\n' +
      '### Requirement: S\n\nThe system SHALL y.\n'
    );
  } else if (editRegion === 'replace-cross-boundary') {
    // REPLACEMENT hunk (both `-` and `+` sides, newCount > 0) whose DELETION
    // spans past the first `## ` heading but whose ADDITION is preamble-only.
    // Replace pre-image L5..L10 (D5, D6, D7, `## MODIFIED Requirements` @L8,
    // BODY9, BODY10) with a SINGLE new preamble line, leaving `## ADDED
    // Requirements` intact. At `--unified=0` (the gate's diff context) git
    // emits ONE hunk `@@ -5,6 +5 @@`:
    //   oldStart 5, oldCount 6 → oldEnd 10 ≥ pre-image heading L8 (deletes the
    //                            `## MODIFIED` heading + Requirement body = real drift)
    //   newStart 5, newCount 1 → newEnd  5  < post-image heading L10 (preamble-only add)
    // The old `if (newCount > 0) … else …` inspected only newEnd (5 < 10) and
    // mis-classified this preamble-only, letting the deleted Requirement body
    // bypass gate (h). The fix checks BOTH sides per hunk: the `-` side's oldEnd
    // (10 ≥ 8) must still block. Regression coverage for cross-model review
    // PR #1497 SECOND Critical (add/modify branch replacement-hunk bypass).
    // Verified TDD: RED under the old code (exit 0, bypass), GREEN under the fix.
    writeFileSync(
      specPath,
      '# cap-x delta — fixture\n\n' +   // L1-2
      'P3\nP4\nNEWPREAMBLE\n' +         // L3-5 (D5-D7+heading+body collapse to one preamble line)
      '\n\n\n\n' +                      // L6-9 spacer
      '## ADDED Requirements\n' +       // L10 surviving heading (post-image)
      'TAIL\n'                          // L11
    );
  } else {
    throw new Error(`unknown editRegion: ${editRegion}`);
  }
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', `fix: edit archive spec.md directly (${editRegion})`], { cwd: dir, env: gitEnv });

  return dir;
}

test('case 19 (check h, R1a): preamble-only archive-only commit → not drift, allow', () => {
  // Second commit only touches the delta preamble (title + change-description
  // prose, before the first `## ` heading) — no canonical counterpart, so it
  // must be excluded from the archive-only tally and NOT reported as drift.
  const archiveName = '2026-07-05-feat-preamble-only';
  const dir = setupGitPreambleFixture({ archiveName, editRegion: 'preamble' });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (preamble-only edit is not drift), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 20 (check h, R1a): Requirement-body archive-only commit → still drift, block', () => {
  // Second commit edits the Requirement body (at/after the first `## `
  // heading, inside `## MODIFIED Requirements`) without touching canonical —
  // this is a real drift edit and must still be blocked.
  const archiveName = '2026-07-05-feat-requirement-body-drift';
  const dir = setupGitPreambleFixture({ archiveName, editRegion: 'requirement-body' });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected exit 1 (Requirement-body edit is real drift), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
    assert.match(r.stderr, /SSOT drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 21 (check h, R1a pure-deletion): deleting a preamble line → not drift, allow', () => {
  // Archive-only commit is a PURE DELETION (`@@ -a +b,0 @@`, no `+` side) of a
  // preamble line — no post-image counterpart to check against the post-image
  // heading line, so the helper must fall back to the pre-image heading line +
  // the `-` side start. Regression coverage for the edge case where the old
  // "newCount > 0" guard silently skipped pure-deletion hunks.
  const archiveName = '2026-07-05-feat-delete-preamble';
  const dir = setupGitPreambleFixture({ archiveName, editRegion: 'delete-preamble' });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (deleting a preamble line is not drift), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 22 (check h, R1a pure-deletion): deleting a Requirement-body line → still drift, block', () => {
  // Archive-only commit is a PURE DELETION of a Requirement-body line (at/after
  // the first `## ` heading) — must still be classified archive-only and block.
  // This is the case the pre-fix helper mis-classified as preamble-only
  // (silently skipped the 0-count hunk, sawHunk stayed based on other hunks
  // only, or fell through to `return sawHunk` without ever inspecting the
  // deletion's line number).
  const archiveName = '2026-07-05-feat-delete-requirement-body';
  const dir = setupGitPreambleFixture({ archiveName, editRegion: 'delete-requirement-body' });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected exit 1 (deleting a Requirement-body line is real drift), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
    assert.match(r.stderr, /SSOT drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 23 (check h, R1a pure-deletion cross-boundary): deletion starting in preamble but spanning past the heading → still drift, block', () => {
  // Archive-only commit is a PURE DELETION whose hunk STARTS in the preamble
  // (oldStart < pre-image heading line) but whose SPAN reaches at/after the
  // heading, removing the `## MODIFIED Requirements` heading + Requirement body.
  // A start-only classification (`oldStart >= heading`) would mis-allow it as
  // preamble-only, letting real Requirement-body drift bypass gate (h). The
  // helper must use oldEnd = oldStart + oldCount - 1. Regression coverage for
  // cross-model review PR #1497 Critical.
  const archiveName = '2026-07-05-feat-delete-cross-boundary';
  const dir = setupGitPreambleFixture({ archiveName, editRegion: 'delete-cross-boundary' });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected exit 1 (cross-boundary deletion removes Requirement-body structure = real drift), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
    assert.match(r.stderr, /SSOT drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 24 (check h, R1a replacement cross-boundary): replacement hunk deleting past the heading while adding only a preamble line → still drift, block', () => {
  // Archive-only commit is a REPLACEMENT hunk (both `-` and `+` sides,
  // newCount > 0) whose DELETION span reaches past the first `## ` heading
  // (removing the heading + Requirement body) but whose ADDITION is
  // preamble-only (newEnd < post-image heading). The old mutually-exclusive
  // `if (newCount > 0) … else …` checked only the `+` side (newEnd) and
  // mis-allowed this as preamble-only, letting the deleted Requirement body
  // bypass gate (h). The fix validates BOTH sides per hunk, so the `-` side's
  // oldEnd (past the pre-image heading) still blocks. Regression coverage for
  // cross-model review PR #1497 SECOND Critical (add/modify branch bypass).
  const archiveName = '2026-07-05-feat-replace-cross-boundary';
  const dir = setupGitPreambleFixture({ archiveName, editRegion: 'replace-cross-boundary' });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 1, `expected exit 1 (replacement hunk deletes Requirement-body structure = real drift), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(h\)/);
    assert.match(r.stderr, /SSOT drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 16 (check h): unrelated archive drift outside PR touched archives → allow', () => {
  const dir = setupGitFixture({
    archiveName: '2026-05-11-unrelated-drift',
    withDrift: true,
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-05-11-current-pr-archive',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (unrelated drift skipped), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 17 (check h): no PR-touched archives with historical drift → allow', () => {
  const dir = setupGitFixture({
    archiveName: '2026-05-11-no-touched-archives-drift',
    withDrift: true,
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'main',
    });
    assert.equal(r.status, 0, `expected exit 0 (no touched archives, drift skipped), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(h\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── PR #841 I5: early-exit observable output coverage ────────────────────────
// B-class pass-throughs must NOT emit evidence token (no archive context).
// A-class rules/not-git-repo skips MUST emit evidence token (archives exist,
// (a)-(h) already passed, only (i) is being skipped).

test('case 18 (PR #841 I5 B-class): no archive dir → exit 0 + pass message but NO evidence token', () => {
  // Simulates a repo with openspec/changes/ but no archive/ dir yet.
  // This is B-class: no archive context at all, so no token should be emitted.
  const dir = makeTempDir('archive-gate-b-class-');
  try {
    mkdirSync(path.join(dir, 'openspec/changes'), { recursive: true });
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 (B-class no archive dir), got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /Pre-PR archive gate: pass/, 'stdout must contain human-readable pass message');
    assert.doesNotMatch(r.stdout, /archived as/, 'B-class must NOT emit evidence token — no archive context');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 19 (PR #841 I5 A-class): rules branch + promoted archive → exit 0 + evidence token emitted', () => {
  // Simulates a rules/<source>-<version> branch with an already-promoted archive.
  // (a)-(h) all pass; (i) is skipped because RULES_BRANCH_RE matches.
  // This is A-class: archive promote is real, evidence token MUST be emitted.
  const dir = setupFixture({
    archives: [{ name: '2026-04-27-rules-base', specs: ['cap-rules'] }],
    canonicalSpecs: ['cap-rules'],
  });
  // Init git repo and checkout a rules branch so RULES_BRANCH_RE matches.
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };
  spawnSync('git', ['-C', dir, 'init', '-b', 'rules/agent-rules-v6.50.0'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { encoding: 'utf8', env: gitEnv });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-04-27-rules-base' });
    assert.equal(r.status, 0, `expected exit 0 (rules branch A-class), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stdout,
      /archived as ['"][\w-]+['"]/,
      "A-class rules branch exit must emit archived-as evidence for PR audit trail"
    );
    assert.match(r.stdout, /2026-04-27-rules-base/, 'stdout must contain latest archive name');
    assert.match(r.stdout, /Pre-PR archive gate: pass/, 'stdout must also contain pass message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── PR #841 B-class coverage: remaining 3 exits (exit 1/3/4) ─────────────────
// B-class exits print pass message but must NOT emit `archived as` evidence token.
// case 18 already covers exit 2 (no archive dir yet).
// These 3 cases cover exit 1 (no openspec/changes dir), exit 3 (no archives),
// and exit 4 (chore-A / no spec delta) to achieve 4/4 B-class coverage.

test('case 20 (PR #841 B-class exit 1): no openspec/changes dir → exit 0 + pass message + NO evidence token', () => {
  // Fixture: temp dir with NO openspec/changes/ directory at all.
  // Gate hits the catch block at (a) readdir and calls passArchiveGate('no openspec/changes dir — nothing to gate').
  // B-class: no archive context, so 'archived as' token must NOT appear.
  const dir = makeTempDir('archive-gate-b-no-changes-');
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 (B-class no openspec/changes dir), got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /Pre-PR archive gate: pass/, 'stdout must contain human-readable pass message');
    assert.doesNotMatch(r.stdout, /archived as/, 'B-class must NOT emit evidence token — no archive context');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 21 (PR #841 B-class exit 3): archive/ exists but empty → exit 0 + pass message + NO evidence token', () => {
  // Fixture: openspec/changes/archive/ exists as an empty directory (no subdirs).
  // Gate reads archive/ with readdirSync, finds zero subdirectories, and calls
  // passArchiveGate('no archives yet').
  // B-class: archive dir exists but no actual archives, so no token must appear.
  const dir = makeTempDir('archive-gate-b-empty-archive-');
  try {
    mkdirSync(path.join(dir, 'openspec/changes/archive'), { recursive: true });
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 (B-class empty archive dir), got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /Pre-PR archive gate: pass/, 'stdout must contain human-readable pass message');
    assert.doesNotMatch(r.stdout, /archived as/, 'B-class must NOT emit evidence token — no archives exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case 22 (PR #841 B-class exit 4): latest archive has no specs/ subdir → exit 0 + pass message + NO evidence token', () => {
  // Fixture: one archive directory with a valid proposal.md (passes check (c)
  // heading validation) but no specs/ subdirectory (chore-A pattern).
  // Gate passes (c) because proposal.md has ## Why + ## What Changes, records
  // that no capability spec delta exists, and reaches the no-spec terminal
  // path only after the applicable lifecycle and independent checks run.
  // B-class: no capability specs were ever promoted, so no token must appear.
  const dir = setupFixture({
    archives: [{
      name: '2026-06-01-chore-a-no-specs',
      // proposalContent defaults to VALID_PROPOSAL_CONTENT: has ## Why, ## What Changes
      // which satisfies check (c). No `specs` key → no specs/ subdir created.
    }],
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, `expected exit 0 (B-class chore-A no spec delta), got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /Pre-PR archive gate: pass/, 'stdout must contain human-readable pass message');
    assert.doesNotMatch(r.stdout, /archived as/, 'B-class must NOT emit evidence token — chore-A has no spec delta');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Issue #959 scope-bound (b)(c) regression cases ──────────────────────────
// T1 prove-it: write failing tests BEFORE fixing the gate.
// These tests expose the latent regression where (b)/(c) only evaluate the
// lexicographic `latest` archive, ignoring non-latest archives that this PR
// actually touches. The first two cases FAIL before the fix (latest-only gap).
// The third case may already PASS (latest archive lacking heading already fires).

test('case (check c #959): PR diff touches non-latest archive lacking ## Why → (c) blocks', () => {
  // Two archives: latest (lexicographically larger) has valid headings;
  // non-latest (PR-touched) is missing ## Why.
  // With DEVPRO_RELEVANT_ARCHIVES pointing at the non-latest archive,
  // check (c) should fire on the non-latest — but before the fix it only
  // reads the latest and silently skips the violation.
  const dir = setupFixture({
    archives: [
      {
        name: '2026-06-01-pr-change',
        // Missing ## Why — this is the non-latest archive this PR touches
        proposalContent: '# Proposal-Mini: pr-change\n\n## What Changes\n\nsome changes\n\n' +
          '## Issue Anchor Verification\n\n`grep -F "anchor" f.md` → 1 hit @ f.md:1\n\n' +
          '## Token Budget Check\n\n100 tokens / 500\n',
      },
      {
        name: '2026-06-02-latest-ok',
        // Valid headings — this is the latest archive (lexicographically larger)
        // proposalContent defaults to VALID_PROPOSAL_CONTENT
      },
    ],
    canonicalSpecs: [],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-01-pr-change' });
    assert.equal(r.status, 1, `expected exit 1 ((c) should block non-latest archive missing ## Why), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /missing required heading/);
    assert.ok(r.stderr.includes('2026-06-01-pr-change'), `stderr must contain the offending archive name '2026-06-01-pr-change', got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (check b #959): PR diff touches non-latest archive with unpromoted spec → (b) blocks', () => {
  // Two archives: latest has its cap promoted; non-latest (PR-touched) has
  // specs/cap-z/ but canonical openspec/specs/cap-z/spec.md is missing.
  // With DEVPRO_RELEVANT_ARCHIVES pointing at the non-latest archive,
  // check (b) should fire on cap-z — but before the fix it only reads the
  // latest (which is clean) and silently skips the real violation.
  const dir = setupFixture({
    archives: [
      {
        name: '2026-06-01-pr-change',
        specs: ['cap-z'],  // cap-z NOT in canonicalSpecs → unpromoted
        // proposalContent defaults to VALID_PROPOSAL_CONTENT (headings OK for (c))
      },
      {
        name: '2026-06-02-latest-ok',
        specs: ['cap-a'],  // cap-a IS in canonicalSpecs → promoted (latest is clean)
      },
    ],
    canonicalSpecs: ['cap-a'],  // cap-z deliberately absent
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-01-pr-change' });
    assert.equal(r.status, 1, `expected exit 1 ((b) should block non-latest archive with unpromoted cap-z), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Capability spec not promoted/);
    assert.ok(r.stderr.includes('cap-z'), `stderr must contain the unpromoted capability 'cap-z', got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 check c empty scope): unrelated latest malformed proposal is not evaluated', () => {
  // DEVPRO_RELEVANT_ARCHIVES='' means this PR touched no archive. Historical
  // proposal-heading debt in the latest archive is therefore outside the
  // scope of check (c) and must not block this PR.
  const dir = setupFixture({
    archives: [{
      name: '2026-06-01-latest-missing-why',
      proposalContent: '# Proposal: latest-missing-why\n\n## What Changes\n\nsome changes\n',
      // Deliberately missing ## Why, but unrelated to this PR.
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (empty relevant set skips check (c)), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /missing required heading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 check b empty scope): unrelated latest unpromoted spec is not evaluated', () => {
  // The latest archive has an unpromoted capability, but the empty relevant
  // set proves this PR did not touch it. Check (b) must evaluate zero archives.
  const dir = setupFixture({
    archives: [{
      name: '2026-06-01-latest-unpromoted',
      specs: ['historical-cap'],
      // proposalContent defaults to valid headings so only check (b) can fail.
    }],
    canonicalSpecs: [],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (empty relevant set skips check (b)), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Capability spec not promoted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 empty scope): independent check (k) still blocks an unindexed new rule', () => {
  // Checks (b)/(c) evaluate zero archives, but that scope decision must not
  // short-circuit independent gates such as the new-rule index check (k).
  const dir = setupFixture({
    archives: [{
      name: '2026-06-01-unrelated-history',
      specs: ['historical-cap'],
    }],
    canonicalSpecs: [],
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '',
      DEVPRO_NEW_RULE_LEAVES: 'unindexed-new-rule',
    });
    assert.equal(r.status, 1, `expected exit 1 (independent check (k) still runs), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('unindexed-new-rule'), `stderr must name the unindexed rule, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 empty scope): independent check (i) still rejects a baseline equal to HEAD', () => {
  // No relevant archive has a spec delta, but a changed canonical spec still
  // makes scenario-removal guard (i) independently applicable. The no-spec
  // success path must not terminate before this fail-closed baseline check.
  const dir = setupFixture({
    archives: [{ name: '2026-06-01-unrelated-chore-a' }],
    canonicalSpecs: ['archive-tooling'],
  });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  };
  spawnSync('git', ['-C', dir, 'init'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { encoding: 'utf8', env: gitEnv });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '',
      DEVPRO_CHANGED_CAPABILITY_SPECS: 'openspec/specs/archive-tooling/spec.md',
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'HEAD',
    });
    assert.equal(r.status, 1, `expected exit 1 (independent check (i) still runs), got ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /Pre-PR archive gate \(i\)/);
    assert.match(r.stderr, /baseline ref .* resolves to the current HEAD commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 check c multi-relevant): non-latest relevant malformed proposal blocks', () => {
  const dir = setupFixture({
    archives: [
      {
        name: '2026-06-01-relevant-missing-why',
        proposalContent: '# Proposal: relevant-missing-why\n\n## What Changes\n\nsome changes\n',
      },
      { name: '2026-06-02-relevant-valid' },
    ],
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-01-relevant-missing-why,2026-06-02-relevant-valid',
    });
    assert.equal(r.status, 1, `expected exit 1 ((c) checks every relevant archive), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /missing required heading/);
    assert.match(r.stderr, /2026-06-01-relevant-missing-why/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 check b multi-relevant): non-latest relevant unpromoted spec blocks', () => {
  const dir = setupFixture({
    archives: [
      { name: '2026-06-01-relevant-unpromoted', specs: ['missing-cap'] },
      { name: '2026-06-02-relevant-promoted', specs: ['promoted-cap'] },
    ],
    canonicalSpecs: ['promoted-cap'],
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-01-relevant-unpromoted,2026-06-02-relevant-promoted',
    });
    assert.equal(r.status, 1, `expected exit 1 ((b) checks every relevant archive), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Capability spec not promoted/);
    assert.match(r.stderr, /missing-cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (#1847 checks b/c multi-relevant): all relevant archives compliant → exit 0', () => {
  const dir = setupFixture({
    archives: [
      { name: '2026-06-01-relevant-valid', specs: ['cap-a'] },
      { name: '2026-06-02-relevant-valid', specs: ['cap-b'] },
    ],
    canonicalSpecs: ['cap-a', 'cap-b'],
  });
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-01-relevant-valid,2026-06-02-relevant-valid',
    });
    assert.equal(r.status, 0, `expected exit 0 (all relevant archives comply), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (j): BRD required fields ───────────────────────────────────────────

const VALID_BRD_CONTENT =
  '# BRD — test-change\n\n' +
  '## 1. 問題陳述\n\nx\n\n' +
  '## 2. 業務目標\n\nx\n\n' +
  '## 3. 功能需求\n\nx\n\n' +
  '## 4. 非功能需求\n\nx\n\n' +
  '## 5. 範圍界定（In/Out）\n\nx\n\n' +
  '## 6. 限制與假設\n\nx\n\n' +
  '## 7. 成功標準\n\nx\n\n' +
  '## 8. 風險\n\nx\n\n' +
  '## 9. 現況分析\n\nx\n\n' +
  '## 10. 先前嘗試\n\n無\n\n' +
  '## 11. Pre-flight 驗證結果表\n\n| # | 項目 | 結果 |\n|---|---|---|\n| 1 | test | PASS |\n\n' +
  '## 12. 分支資訊\n\nx\n';

// Helper to create a fixture archive that has specs and all required proposal
// headings. Used by j/k/l tests that exercise spec-bearing archive behavior.
function setupSpecFixture(archiveName) {
  return setupFixture({
    archives: [{ name: archiveName, specs: ['cap-test'] }],
    canonicalSpecs: ['cap-test'],
  });
}

test('case (j-1): archive brd.md missing required field → block', () => {
  // brd.md present but missing "先前嘗試", "Pre-flight 驗證結果表", "分支資訊"
  // A spec-bearing archive keeps this case focused on the ordinary B-type
  // lifecycle path while check (j) validates the malformed BRD.
  const brdMissingFields =
    '# BRD — test-change\n\n' +
    '## 1. 問題陳述\n\nx\n\n' +
    '## 2. 業務目標\n\nx\n\n' +
    '## 3. 功能需求\n\nx\n\n' +
    '## 4. 非功能需求\n\nx\n\n' +
    '## 5. 範圍界定（In/Out）\n\nx\n\n' +
    '## 6. 限制與假設\n\nx\n\n' +
    '## 7. 成功標準\n\nx\n\n' +
    '## 8. 風險\n\nx\n\n' +
    '## 9. 現況分析\n\nx\n';
  // missing: 先前嘗試, Pre-flight 驗證結果表, 分支資訊

  const dir = setupSpecFixture('2026-06-08-brd-missing-fields');
  try {
    writeFileSync(
      path.join(dir, 'openspec/changes/archive/2026-06-08-brd-missing-fields/brd.md'),
      brdMissingFields
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-brd-missing-fields' });
    assert.equal(r.status, 1, `expected exit 1 (brd missing fields), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(j\)/);
    assert.ok(r.stderr.includes('先前嘗試'), `stderr must mention 先前嘗試, got: ${r.stderr}`);
    assert.ok(r.stderr.includes('openspec-quality-doc-formats.md §brd.md'), 'stderr must point to SSOT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (j-2): archive brd.md with all 12 required fields → pass', () => {
  const dir = setupSpecFixture('2026-06-08-brd-complete');
  try {
    writeFileSync(
      path.join(dir, 'openspec/changes/archive/2026-06-08-brd-complete/brd.md'),
      VALID_BRD_CONTENT
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-brd-complete' });
    assert.equal(r.status, 0, `expected exit 0 (brd complete), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (j-3): required archive without brd.md fails closed', () => {
  // proposal.md proves this is not chore A, so whole-file absence blocks.
  const dir = setupSpecFixture('2026-06-08-no-brd-with-specs');
  try {
    // Verify brd.md does NOT exist in fixture
    assert.ok(
      !existsSync(path.join(dir, 'openspec/changes/archive/2026-06-08-no-brd-with-specs/brd.md')),
      'fixture must not have brd.md for this test'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-no-brd-with-specs',
      DEVPRO_FIXTURE_ALLOW_MISSING_BRD: '1',
    });
    assert.equal(r.status, 1, `expected exit 1 (required brd missing), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /brd\.md 整檔缺失/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (j-4): no relevant archives → check j skip entirely', () => {
  // With DEVPRO_RELEVANT_ARCHIVES='', check (j) should skip (empty set)
  // even if the latest archive has an incomplete brd.md.
  const dir = setupSpecFixture('2026-06-08-latest-bad-brd');
  try {
    writeFileSync(
      path.join(dir, 'openspec/changes/archive/2026-06-08-latest-bad-brd/brd.md'),
      '# BRD\n\n## 問題陳述\n\nonly one field\n'
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '' });
    // (j) iterates relevantArchives (empty) → skip; (c) fallback evaluates proposal.md not brd.md
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(j\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (k): new rule .md must have AGENTS.md index entry ─────────────────

test('case (k-1): new rule .md added but AGENTS.md has no entry → block', () => {
  // Simulate a newly-added rule leaf via DEVPRO_NEW_RULE_LEAVES env override.
  // The fixture dir has no AGENTS.md, so the leaf won't be found.
  // Archive must have specs so the gate reaches check (k).
  const dir = setupSpecFixture('2026-06-08-new-rule-no-index');
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-new-rule-no-index',
      DEVPRO_NEW_RULE_LEAVES: 'my-new-rule',
    });
    assert.equal(r.status, 1, `expected exit 1 (new rule not in AGENTS.md), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('my-new-rule'), `stderr must mention the missing rule, got: ${r.stderr}`);
    assert.ok(r.stderr.includes('AGENTS.md'), 'stderr must mention AGENTS.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-2): new rule .md added and AGENTS.md has entry in 觸發式載入索引 section → pass', () => {
  const dir = setupSpecFixture('2026-06-08-new-rule-indexed');
  try {
    // Create AGENTS.md with the new rule leaf name inside the 觸發式載入索引 section.
    // The entry must be in the section body (between the section header and the
    // next ## header) for the gate to recognise it as properly indexed.
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|新功能|`my-new-rule.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-new-rule-indexed',
      DEVPRO_NEW_RULE_LEAVES: 'my-new-rule',
    });
    assert.equal(r.status, 0, `expected exit 0 (rule indexed in 觸發式載入索引 section), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(k\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-3): no new rule leaves (DEVPRO_NEW_RULE_LEAVES empty) → check k skip, pass', () => {
  const dir = setupSpecFixture('2026-06-08-no-new-rules');
  try {
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-no-new-rules',
      DEVPRO_NEW_RULE_LEAVES: '',
    });
    assert.equal(r.status, 0, `expected exit 0 (no new rule leaves → skip), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(k\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-4): multiple new rules, one missing from 觸發式載入索引 section → block with specific name', () => {
  const dir = setupSpecFixture('2026-06-08-multi-rules-partial');
  try {
    // AGENTS.md indexes rule-a inside 觸發式載入索引 section but not rule-b.
    // rule-b is absent from the section entirely (not just in prose).
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|x|`rule-a.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-multi-rules-partial',
      DEVPRO_NEW_RULE_LEAVES: 'rule-a,rule-b',
    });
    assert.equal(r.status, 1, `expected exit 1 (rule-b not in 觸發式載入索引 section), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('rule-b'), `stderr must mention rule-b, got: ${r.stderr}`);
    assert.ok(!r.stderr.includes('rule-a'), `stderr must NOT mention indexed rule-a, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-5): leaf mentioned in AGENTS.md prose (outside 觸發式載入索引 section) → block (under-enforce regression)', () => {
  // Regression guard: if a leaf name only appears in prose/comments outside the
  // index section, the gate MUST still block — the leaf is not on-demand-loadable.
  // This was the under-enforce bug: the old code searched the full file so a
  // prose mention would incorrectly satisfy the check.
  const dir = setupSpecFixture('2026-06-08-prose-only-mention');
  try {
    // AGENTS.md has the leaf in prose (outside 觸發式載入索引) but NOT in the section.
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n' +
      '## 介紹\n\n' +
      'Some background text that mentions `prose-rule.md` in passing.\n\n' +
      '## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|既有規則|`other-rule.md`|\n\n' +
      '## 下一段\n\nmore prose mentioning prose-rule.md again\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-prose-only-mention',
      DEVPRO_NEW_RULE_LEAVES: 'prose-rule',
    });
    assert.equal(r.status, 1,
      `expected exit 1 (leaf only in prose, not in 觸發式載入索引 section), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('prose-rule'), `stderr must mention prose-rule, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-6): AGENTS.md has no 觸發式載入索引 section header → fail-safe fallback to full-file search, pass', () => {
  // Fail-safe: if AGENTS.md lacks the section header (structural change),
  // the gate falls back to searching the full file (fail-open direction) so it
  // does not hard-block all new-rule PRs due to a structural mismatch.
  const dir = setupSpecFixture('2026-06-08-no-section-header');
  try {
    // AGENTS.md has no "## 觸發式載入索引" header at all, but the leaf appears in the file.
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n' +
      '|意圖|入口|\n|---|---|\n|新功能|`no-section-rule.md`|\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-no-section-header',
      DEVPRO_NEW_RULE_LEAVES: 'no-section-rule',
    });
    // Fail-open: gate falls back to full-file search and finds the leaf → pass
    assert.equal(r.status, 0,
      `expected exit 0 (fail-safe fallback to full-file search found the leaf), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(k\)：以下新增/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-7): suffix-collision regression — index only has `openspec-flow.md`, new leaf is `flow` → block', () => {
  // Cross-model CRITICAL regression guard (issue #959 follow-up):
  // A simple substring includes() would match `flow.md` inside `openspec-flow.md`,
  // causing the gate to falsely pass for `flow.md` when only `openspec-flow.md`
  // is in the index. The word-boundary regex fix must block this case.
  // Real repo collisions: flow / openspec-flow, consumer / openspec-flow-consumer,
  // routing / openspec-branch-routing, coding / security-coding.
  const dir = setupSpecFixture('2026-06-08-suffix-collision-flow');
  try {
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|openspec flow|`openspec-flow.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-suffix-collision-flow',
      DEVPRO_NEW_RULE_LEAVES: 'flow',
    });
    // `flow.md` must NOT match `openspec-flow.md` — gate must block.
    assert.equal(r.status, 1,
      `expected exit 1 (flow.md must not match openspec-flow.md via suffix), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('flow'), `stderr must mention the missing rule, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-8): prefix-collision regression — index only has `flow-helper.md`, new leaf is `flow` → block', () => {
  // Complement to k-7: word-boundary also prevents a prefix-collision where the
  // new leaf is a prefix of an indexed entry (flow.md must not match flow-helper.md).
  const dir = setupSpecFixture('2026-06-08-prefix-collision-flow');
  try {
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|flow helper|`flow-helper.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-prefix-collision-flow',
      DEVPRO_NEW_RULE_LEAVES: 'flow',
    });
    // `flow.md` must NOT match `flow-helper.md` — gate must block.
    assert.equal(r.status, 1,
      `expected exit 1 (flow.md must not match flow-helper.md via prefix), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('flow'), `stderr must mention the missing rule, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (k) 1-hop reachability tests (issue #1171) ────────────────────────
// These three cases verify the 1-hop expansion added to check (k), which mirrors
// agents-md-index-mapping.test.mjs's 1-hop expansion so the two reachability
// definitions stay aligned.

function runCheckKLoadChainFixture(suffix, entryContent) {
  const archiveName = `2026-07-19-load-chain-${suffix}`;
  const dir = setupSpecFixture(archiveName);
  try {
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|foo 功能|`foo.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    mkdirSync(path.join(dir, '.devpro', 'agent-rules'), { recursive: true });
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'foo.md'),
      `# foo\n\n${entryContent}\n`
    );
    return run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_NEW_RULE_LEAVES: 'foo-sibling',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('case (k-9): ordinary prose mention is not a Load-chain declaration → block', () => {
  // foo-sibling.md is NOT directly in the AGENTS.md index section. foo.md is
  // indexed, but contains only an ordinary prose mention of foo-sibling.md.
  // → (k) must block because incidental prose does not declare 1-hop coverage.
  const dir = setupSpecFixture('2026-06-20-1hop-prose-block');
  try {
    // Write AGENTS.md: index section has `foo.md` but NOT `foo-sibling.md`.
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|foo 功能|`foo.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    // Write the entry leaf with only ordinary prose, not a Load-chain line.
    mkdirSync(path.join(dir, '.devpro', 'agent-rules'), { recursive: true });
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'foo.md'),
      '# foo\n\nSee also `foo-sibling.md` for additional details.\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-20-1hop-prose-block',
      DEVPRO_NEW_RULE_LEAVES: 'foo-sibling',
    });
    assert.equal(r.status, 1,
      `expected exit 1 (ordinary prose is not Load-chain evidence), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.match(r.stderr, /foo-sibling/);
    assert.match(r.stderr, /Load-chain/);
    assert.match(r.stderr, /修法 1：.*AGENTS\.md.*direct entry/s);
    assert.match(r.stderr, /修法 2：.*直接 entry leaf.*Load-chain/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-10): true orphan (not in index, not referenced by any indexed leaf) → block', () => {
  // orphan.md is NOT in the AGENTS.md index section AND not referenced by any
  // indexed entry leaf file. → (k) must block (exit 1, missing non-empty).
  const dir = setupSpecFixture('2026-06-20-true-orphan-block');
  try {
    // AGENTS.md: index section has `foo.md`; foo.md file does NOT mention orphan.md.
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|foo 功能|`foo.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    mkdirSync(path.join(dir, '.devpro', 'agent-rules'), { recursive: true });
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'foo.md'),
      '# foo\n\nThis file has nothing to do with orphan.\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-20-true-orphan-block',
      DEVPRO_NEW_RULE_LEAVES: 'orphan',
    });
    assert.equal(r.status, 1,
      `expected exit 1 (true orphan not reachable by any indexed leaf), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.ok(r.stderr.includes('orphan'), `stderr must mention 'orphan', got: ${r.stderr}`);
    assert.ok(r.stderr.includes('Load-chain'), 'stderr must confirm unreachability via Load-chain message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-11): directly-indexed leaf still passes (regression)', () => {
  // A new leaf whose name IS directly in the AGENTS.md index section → passes.
  // This is the basic direct-index path; 1-hop change must not break it.
  const dir = setupSpecFixture('2026-06-20-direct-index-regression');
  try {
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|直接索引規則|`direct-rule.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-20-direct-index-regression',
      DEVPRO_NEW_RULE_LEAVES: 'direct-rule',
    });
    assert.equal(r.status, 0,
      `expected exit 0 (leaf directly in index section), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(k\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-12): note-line anchor (not in table row) must NOT serve as 1-hop anchor → block', () => {
  // Regression: under-enforce blocked.
  // AGENTS.md index section has `noted-anchor.md` listed ONLY in a `>` note line
  // (not in any `|` table row). noted-anchor.md exists as a file and references
  // `dependent.md`. dependent.md is a new leaf.
  // With the narrowed anchor extraction (table rows only), `noted-anchor` is NOT a
  // valid entry leaf, so dependent.md has no 1-hop coverage → (k) must BLOCK.
  const dir = setupSpecFixture('2026-06-20-note-line-anchor-block');
  try {
    // AGENTS.md: index table has only `real-entry.md`; `noted-anchor.md` appears
    // only in the blockquote note line, NOT in any table row.
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '**preamble text**\n\n' +
      '> On-demand siblings: `noted-anchor.md`\n\n' +
      '|意圖|入口|\n|---|---|\n|real 功能|`real-entry.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    mkdirSync(path.join(dir, '.devpro', 'agent-rules'), { recursive: true });
    // noted-anchor.md exists and references dependent.md — but noted-anchor is
    // not a table-row entry leaf, so it must not be used as a 1-hop anchor.
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'noted-anchor.md'),
      '# noted-anchor\n\nSee `dependent.md` for more details.\n'
    );
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'real-entry.md'),
      '# real-entry\n\nReal entry leaf content, no reference to dependent.\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-20-note-line-anchor-block',
      DEVPRO_NEW_RULE_LEAVES: 'dependent',
    });
    assert.equal(r.status, 1,
      `expected exit 1 (note-line anchor not valid, dependent not 1-hop covered), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/,
      `stderr must mention check (k), got: ${r.stderr}`);
    assert.ok(r.stderr.includes('dependent'),
      `stderr must name 'dependent', got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-13): table-row anchor still serves as 1-hop anchor → pass (regression)', () => {
  // Regression: table-row anchor must still work after narrowing.
  // AGENTS.md index table has `anchor-entry.md` in a `|` row.
  // anchor-entry.md references `new-sibling.md`. new-sibling.md is a new leaf.
  // → (k) must PASS (exit 0).
  const dir = setupSpecFixture('2026-06-20-table-row-anchor-pass');
  try {
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '> Some note line with `some-note-ref.md` that is not in a table row.\n\n' +
      '|意圖|入口|\n|---|---|\n|anchor 功能|`anchor-entry.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    mkdirSync(path.join(dir, '.devpro', 'agent-rules'), { recursive: true });
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'anchor-entry.md'),
      '# anchor-entry\n\nLoad-chain: see `new-sibling.md` for details.\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-20-table-row-anchor-pass',
      DEVPRO_NEW_RULE_LEAVES: 'new-sibling',
    });
    assert.equal(r.status, 0,
      `expected exit 0 (new-sibling 1-hop covered via table-row anchor-entry.md), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(k\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (k-14): supported Load-chain declaration forms all provide 1-hop coverage', () => {
  const cases = [
    ['plain-fullwidth', 'Load-chain：see `foo-sibling.md`'],
    ['blockquote', '> Load-chain：see `foo-sibling.md`'],
    ['bold-label', '**Load-chain**：see `foo-sibling.md`'],
    ['parenthetical-qualifier', '> Load-chain（on-demand siblings）：see `foo-sibling.md`'],
    ['plain-ascii', 'Load-chain: see `foo-sibling.md`'],
  ];

  for (const [name, content] of cases) {
    const r = runCheckKLoadChainFixture(`positive-${name}`, content);
    assert.equal(
      r.status,
      0,
      `${name} must provide declared 1-hop coverage, got ${r.status}: ${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(k\)/);
  }
});

test('case (k-15): non-declaration contexts never provide 1-hop coverage', () => {
  const cases = [
    ['mid-line-label', 'Routing note: Load-chain: see `foo-sibling.md`'],
    ['heading', '### Load-chain: see `foo-sibling.md`'],
    ['isolated-target', 'Example: `foo-sibling.md`'],
    ['next-line-target', 'Load-chain:\nsee `foo-sibling.md`'],
    ['fenced-code-example', '```md\nLoad-chain: see `foo-sibling.md`\n```'],
    ['tilde-fenced-example', '~~~md\nLoad-chain: see `foo-sibling.md`\n~~~'],
    ['short-fence-close', '````md\n```\nLoad-chain: see `foo-sibling.md`\n````'],
    ['html-comment', '<!--\nLoad-chain: see `foo-sibling.md`\n-->'],
  ];

  for (const [name, content] of cases) {
    const r = runCheckKLoadChainFixture(`negative-${name}`, content);
    assert.equal(
      r.status,
      1,
      `${name} must remain uncovered, got ${r.status}: ${r.stderr}`
    );
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.match(r.stderr, /foo-sibling/);
    assert.match(r.stderr, /Load-chain/);
  }
});

test('case (k-16): an indirect leaf never becomes a second-hop Load-chain anchor', () => {
  const archiveName = '2026-07-19-load-chain-second-hop-block';
  const dir = setupSpecFixture(archiveName);
  try {
    writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '# AI Agent 規範\n\n## 觸發式載入索引\n\n' +
      '|意圖|入口|\n|---|---|\n|foo 功能|`foo.md`|\n\n' +
      '## 下一段\n\nsome prose\n'
    );
    mkdirSync(path.join(dir, '.devpro', 'agent-rules'), { recursive: true });
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'foo.md'),
      '# foo\n\nLoad-chain: see `foo-sibling.md`\n'
    );
    writeFileSync(
      path.join(dir, '.devpro', 'agent-rules', 'foo-sibling.md'),
      '# foo sibling\n\nLoad-chain: see `foo-grandchild.md`\n'
    );

    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_NEW_RULE_LEAVES: 'foo-grandchild',
    });

    assert.equal(
      r.status,
      1,
      `expected exit 1 (second-hop leaf must stay uncovered), got ${r.status}: ${r.stderr}`
    );
    assert.match(r.stderr, /Pre-PR archive gate \(k\)/);
    assert.match(r.stderr, /foo-grandchild/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (l): bugfix prove-it task ─────────────────────────────────────────

test('case (l-1): bugfix branch + tasks.md lacks prove-it marker → block', () => {
  // Archive must have specs so the gate reaches check (l).
  const dir = setupSpecFixture('2026-06-08-bugfix-missing-tdd-task');
  try {
    writeFileSync(
      path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-missing-tdd-task/tasks.md'),
      '# Tasks: bugfix-missing-tdd-task\n\n- [ ] T1 — fix the bug\n- [ ] T2 — run tests\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-missing-tdd-task',
      DEVPRO_CURRENT_BRANCH: 'bugfix/some-bug-fix',
    });
    assert.equal(r.status, 1, `expected exit 1 (bugfix without prove-it), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.ok(r.stderr.includes('prove-it'), 'stderr must mention prove-it');
    assert.ok(r.stderr.includes('2026-06-08-bugfix-missing-tdd-task'), 'stderr must name archive folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-2): bugfix branch + tasks.md contains "prove-it" → pass', () => {
  const dir = setupSpecFixture('2026-06-08-bugfix-has-prove-it');
  try {
    writeFileSync(
	      path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-has-prove-it/tasks.md'),
	      // Canonical `## Tasks` heading + checked boxes with 驗收 evidence so this
	      // fixture also clears check (o)'s task checklist backstop (T1-T5
	      // widened check (o) to flag any non-canonical-heading top-level
	      // checkbox), isolating the exit-0 assertion to what check (l) decides.
	      '## Tasks\n\n' +
	      '- [x] [Req: R1] T1 — [prove-it] write failing test reproducing the bug\n' +
	      '  - 驗收:failing test written before fix\n' +
	      '- [x] [Req: R1] T2 — fix the bug\n' +
	      '  - 驗收:fix applied, test passes\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-has-prove-it',
      DEVPRO_CURRENT_BRANCH: 'bugfix/some-bug-fix',
    });
    assert.equal(r.status, 0, `expected exit 0 (prove-it present), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-3): bugfix branch + tasks.md contains "failing test" variant → pass', () => {
  const dir = setupSpecFixture('2026-06-08-bugfix-failing-test-variant');
  try {
    writeFileSync(
	      path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-failing-test-variant/tasks.md'),
	      // Canonical heading + checked/evidence — see l-2 comment above.
	      '## Tasks\n\n' +
	      '- [x] [Req: R1] T1 — write a failing test that reproduces the issue\n' +
	      '  - 驗收:failing test written\n' +
	      '- [x] [Req: R1] T2 — fix\n' +
	      '  - 驗收:fix applied\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-failing-test-variant',
      DEVPRO_CURRENT_BRANCH: 'bugfix/other-bug',
    });
    assert.equal(r.status, 0, `expected exit 0 (failing test variant), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-4): non-bugfix branch → check l skipped entirely', () => {
  // feature/ branch with tasks.md missing prove-it — check (l) must skip
  const dir = setupSpecFixture('2026-06-08-feature-no-prove-it');
  try {
    writeFileSync(
	      path.join(dir, 'openspec/changes/archive/2026-06-08-feature-no-prove-it/tasks.md'),
	      // Canonical heading + checked/evidence — see l-2 comment above.
	      '## Tasks\n\n- [x] [Req: R1] T1 — add feature\n  - 驗收:feature added\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-feature-no-prove-it',
      DEVPRO_CURRENT_BRANCH: 'feature/some-feature',
    });
    assert.equal(r.status, 0, `expected exit 0 (non-bugfix, check l skipped), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-4b): non-bugfix branch + no tasks.md → check l skipped entirely', () => {
  const dir = setupSpecFixture('2026-06-08-feature-no-tasks');
  try {
    assert.ok(
      !existsSync(path.join(dir, 'openspec/changes/archive/2026-06-08-feature-no-tasks/tasks.md')),
      'fixture must not have tasks.md for this test'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-feature-no-tasks',
      DEVPRO_CURRENT_BRANCH: 'feature/some-feature',
    });
    assert.equal(r.status, 0, `expected exit 0 (non-bugfix no tasks.md, check l skipped), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-5): bugfix branch + relevant archive missing tasks.md → block fail-closed', () => {
  // Specs-bearing fixture covers the normal archive lifecycle path.
  const dir = setupSpecFixture('2026-06-08-bugfix-no-tasks');
  try {
    // Verify tasks.md does NOT exist in fixture
    assert.ok(
      !existsSync(path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-no-tasks/tasks.md')),
      'fixture must not have tasks.md for this test'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-no-tasks',
      DEVPRO_CURRENT_BRANCH: 'bugfix/something',
    });
    const portableStderr = r.stderr.replace(/\\/gu, '/');
    assert.equal(r.status, 1, `expected exit 1 (bugfix relevant archive missing tasks.md), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.ok(r.stderr.includes('bugfix/something'), 'stderr must name the bugfix branch');
    assert.ok(
      portableStderr.includes('openspec/changes/archive/2026-06-08-bugfix-no-tasks'),
      'stderr must name archive folder path'
    );
    assert.ok(r.stderr.includes('tasks.md'), 'stderr must mention missing tasks.md');
    assert.ok(
      r.stderr.includes('prove-it / prove it / failing test / 重現…bug'),
      'stderr must list accepted prove-it markers'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-5b): bugfix branch + no-spec/no-proposal relevant archive missing tasks.md → block before pass-through', () => {
  const archiveName = '2026-06-08-bugfix-no-spec-no-proposal-no-tasks';
  const dir = setupFixture({
    archives: [{ name: archiveName }],
  });
  try {
    const archiveRoot = path.join(dir, 'openspec/changes/archive', archiveName);
    rmSync(path.join(archiveRoot, 'proposal.md'), { force: true });
    assert.ok(!existsSync(path.join(archiveRoot, 'specs')), 'fixture must not have specs/ for this test');
    assert.ok(!existsSync(path.join(archiveRoot, 'proposal.md')), 'fixture must not have proposal.md for this test');
    assert.ok(!existsSync(path.join(archiveRoot, 'proposal-mini.md')), 'fixture must not have proposal-mini.md for this test');
    assert.ok(!existsSync(path.join(archiveRoot, 'tasks.md')), 'fixture must not have tasks.md for this test');

    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CURRENT_BRANCH: 'bugfix/no-spec-bypass',
    });
    const portableStderr = r.stderr.replace(/\\/gu, '/');
    assert.equal(r.status, 1, `expected exit 1 before no-spec/no-proposal pass-through, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.ok(r.stderr.includes('bugfix/no-spec-bypass'), 'stderr must name the bugfix branch');
    assert.ok(portableStderr.includes(`openspec/changes/archive/${archiveName}`), 'stderr must name archive folder path');
    assert.ok(r.stderr.includes('tasks.md'), 'stderr must mention missing tasks.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-6): bugfix branch + tasks.md contains "prove it" (with space) → pass', () => {
  const dir = setupSpecFixture('2026-06-08-bugfix-prove-space');
  try {
    writeFileSync(
	      path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-prove-space/tasks.md'),
	      // Canonical heading + checked/evidence — see l-2 comment above.
	      '## Tasks\n\n- [x] [Req: R1] T1 — prove it: write test that reproduces bug first\n  - 驗收:test written reproducing bug first\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-prove-space',
      DEVPRO_CURRENT_BRANCH: 'bugfix/edge-case',
    });
    assert.equal(r.status, 0, `expected exit 0 (prove it with space), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (l) B-mini task-ledger carrier resolution (design.md D6, issue
// gap: check (l) previously looked only at tasks.md, unconditionally blocking
// compliant B-mini bugfix archives whose prove-it task lives inline in
// proposal-mini.md's `## Tasks` section instead of a separate tasks.md) ──────

const BMINI_LEDGER_HEADER =
  '# Proposal (mini): fixture\n\n' +
  '## Why\n\ntest fixture\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Requirement Ledger\n\n' +
  '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
  '|---|---|---|---|---|---|\n' +
  '| R1 | fixture root | same as root | fixture current | implemented | this fixture |\n\n' +
  BATCH_APPROVAL_LEDGER_NA_SECTION + '\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "fixture anchor" proposal-mini.md` → 1 hit @ proposal-mini.md:1\n\n';

// Checked `[x]` with 驗收 evidence lines so this fixture also clears check
// (o)'s task checklist backstop, isolating the pass/block outcome to what
// check (l)'s carrier resolution actually decides.
const BMINI_PROPOSAL_WITH_PROVE_IT_TASKS =
  BMINI_LEDGER_HEADER +
  '## Tasks\n\n' +
  '- [x] [Req: R1] T1 — prove-it: write failing test reproducing the bug\n' +
  '  - 驗收:failing test written before fix\n' +
  '- [x] [Req: R1] T2 — fix the bug\n' +
  '  - 驗收:fix applied, test passes\n';

const BMINI_PROPOSAL_WITHOUT_PROVE_IT_TASKS =
  BMINI_LEDGER_HEADER +
  '## Tasks\n\n' +
  '- [ ] [Req: R1] T1 — fix the bug\n' +
  '- [ ] [Req: R1] T2 — run tests\n';

// Builds a true B-mini archive: proposal-mini.md only, NO tasks.md, NO
// proposal.md (setupFixture always writes proposal.md by default, so it is
// removed here to model the real B-mini carrier shape).
function setupBminiArchiveFixture(archiveName, proposalMiniContent) {
  const dir = setupFixture({ archives: [{ name: archiveName }] });
  const archiveRoot = path.join(dir, 'openspec/changes/archive', archiveName);
  rmSync(path.join(archiveRoot, 'proposal.md'), { force: true });
  writeFileSync(path.join(archiveRoot, 'proposal-mini.md'), proposalMiniContent);
  return { dir, archiveRoot };
}

test('case (l-btask-1) [RED before fix]: bugfix branch + B-mini archive (proposal-mini.md inline ## Tasks with prove-it marker, no tasks.md at all) → pass', () => {
  const archiveName = '2026-06-08-bugfix-bmini-has-prove-it';
  const { dir, archiveRoot } = setupBminiArchiveFixture(archiveName, BMINI_PROPOSAL_WITH_PROVE_IT_TASKS);
  try {
    assert.ok(!existsSync(path.join(archiveRoot, 'tasks.md')), 'fixture must not have tasks.md (true B-mini shape)');
    assert.ok(!existsSync(path.join(archiveRoot, 'proposal.md')), 'fixture must not have proposal.md (true B-mini shape)');
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CURRENT_BRANCH: 'bugfix/bmini-compliant',
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0 (compliant B-mini prove-it task, carrier is proposal-mini.md not tasks.md), got ${r.status}: ${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-btask-2): bugfix branch + B-mini archive whose inline ## Tasks section is missing the prove-it marker → block (fallback must not become a blanket pass)', () => {
  const archiveName = '2026-06-08-bugfix-bmini-missing-prove-it';
  const { dir, archiveRoot } = setupBminiArchiveFixture(archiveName, BMINI_PROPOSAL_WITHOUT_PROVE_IT_TASKS);
  try {
    assert.ok(!existsSync(path.join(archiveRoot, 'tasks.md')), 'fixture must not have tasks.md (true B-mini shape)');
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CURRENT_BRANCH: 'bugfix/bmini-noncompliant',
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1 (B-mini proposal-mini.md carrier resolved but lacks prove-it marker), got ${r.status}: ${r.stderr}`
    );
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.ok(r.stderr.includes(archiveName), 'stderr must name archive folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-btask-3a): full-change archive (has tasks.md) WITH prove-it marker → pass, unaffected by B-mini carrier fix', () => {
  const dir = setupSpecFixture('2026-06-08-bugfix-fullchange-has-prove-it');
  try {
    writeFileSync(
      path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-fullchange-has-prove-it/tasks.md'),
      // Canonical `## Tasks` heading + checked boxes with 驗收 evidence so this
      // fixture also clears check (o)'s task checklist backstop, isolating the
      // exit-0 assertion to what check (l) actually decides.
      '## Tasks\n\n' +
      '- [x] [Req: R1] T1 — prove-it: write failing test reproducing the bug\n' +
      '  - 驗收:failing test written before fix\n' +
      '- [x] [Req: R1] T2 — fix the bug\n' +
      '  - 驗收:fix applied, test passes\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-fullchange-has-prove-it',
      DEVPRO_CURRENT_BRANCH: 'bugfix/fullchange-compliant',
    });
    assert.equal(r.status, 0, `expected exit 0 (full-change tasks.md with prove-it, unaffected), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-btask-3b): full-change archive (has tasks.md) WITHOUT prove-it marker → block, unaffected by B-mini carrier fix', () => {
  const dir = setupSpecFixture('2026-06-08-bugfix-fullchange-missing-prove-it');
  try {
    writeFileSync(
      path.join(dir, 'openspec/changes/archive/2026-06-08-bugfix-fullchange-missing-prove-it/tasks.md'),
      '# Tasks\n\n- [ ] [Req: R1] T1 — fix the bug\n- [ ] [Req: R1] T2 — run tests\n'
    );
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: '2026-06-08-bugfix-fullchange-missing-prove-it',
      DEVPRO_CURRENT_BRANCH: 'bugfix/fullchange-noncompliant',
    });
    assert.equal(r.status, 1, `expected exit 1 (full-change tasks.md missing prove-it, unaffected), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-btask-4): bugfix branch + relevant archive has NEITHER proposal-mini.md NOR tasks.md → block fail-closed (unchanged)', () => {
  const archiveName = '2026-06-08-bugfix-bmini-no-carrier-at-all';
  const dir = setupFixture({ archives: [{ name: archiveName }] });
  try {
    const archiveRoot = path.join(dir, 'openspec/changes/archive', archiveName);
    rmSync(path.join(archiveRoot, 'proposal.md'), { force: true });
    assert.ok(!existsSync(path.join(archiveRoot, 'proposal.md')), 'fixture must not have proposal.md for this test');
    assert.ok(!existsSync(path.join(archiveRoot, 'proposal-mini.md')), 'fixture must not have proposal-mini.md for this test');
    assert.ok(!existsSync(path.join(archiveRoot, 'tasks.md')), 'fixture must not have tasks.md for this test');
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CURRENT_BRANCH: 'bugfix/no-carrier-at-all',
    });
    assert.equal(r.status, 1, `expected exit 1 (fail-closed, no task-ledger carrier at all), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (l) dual-carrier prove-it any-marker (chore B / design D2) ─────────
// Shape aligned with historical `2026-07-15-fix-gate-n-heading-boundary`:
// stale proposal-mini.md (no prove-it marker) + tasks.md (has prove-it).
// Ordered-first-only (l) wrongly blocks; any-marker must pass.

const DUAL_STALE_MINI_NO_PROVE_IT =
  BMINI_LEDGER_HEADER +
  '## Tasks\n\n' +
  '- [x] [Req: R1] T1 — stale mini ledger without reproduction task\n' +
  '  - 驗收:stale mini ledger\n';

const DUAL_TASKS_WITH_PROVE_IT =
  '## Tasks\n\n' +
  '- [x] [Req: R1] T1 — prove-it: write failing test reproducing the bug\n' +
  '  - 驗收:failing test written before fix\n' +
  '- [x] [Req: R1] T2 — fix the bug\n' +
  '  - 驗收:fix applied, test passes\n';

const DUAL_TASKS_WITHOUT_PROVE_IT =
  '## Tasks\n\n' +
  '- [x] [Req: R1] T1 — fix the bug\n' +
  '  - 驗收:fix only\n';

test('case (l-dual-1) [prove-it]: bugfix + dual carriers (stale mini no marker, tasks.md has prove-it) → pass (any-marker)', () => {
  const archiveName = '2026-08-05-bugfix-dual-stale-mini-tasks-prove-it';
  const { dir, archiveRoot } = setupBminiArchiveFixture(archiveName, DUAL_STALE_MINI_NO_PROVE_IT);
  try {
    writeFileSync(path.join(archiveRoot, 'tasks.md'), DUAL_TASKS_WITH_PROVE_IT);
    assert.ok(existsSync(path.join(archiveRoot, 'proposal-mini.md')));
    assert.ok(existsSync(path.join(archiveRoot, 'tasks.md')));
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CURRENT_BRANCH: 'bugfix/dual-carrier-any-marker',
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0 (any-marker: tasks.md has prove-it even though ordered-first mini lacks it), got ${r.status}: ${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(l\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (l-dual-2): bugfix + dual carriers both lacking prove-it marker → block', () => {
  const archiveName = '2026-08-05-bugfix-dual-no-prove-it';
  const { dir, archiveRoot } = setupBminiArchiveFixture(archiveName, DUAL_STALE_MINI_NO_PROVE_IT);
  try {
    writeFileSync(path.join(archiveRoot, 'tasks.md'), DUAL_TASKS_WITHOUT_PROVE_IT);
    const r = run(dir, {
      DEVPRO_RELEVANT_ARCHIVES: archiveName,
      DEVPRO_CURRENT_BRANCH: 'bugfix/dual-carrier-no-marker',
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1 (both carriers lack prove-it marker), got ${r.status}: ${r.stderr}`
    );
    assert.match(r.stderr, /Pre-PR archive gate \(l\)/);
    assert.ok(
      r.stderr.includes('prove-it / prove it / failing test / 重現…bug'),
      'stderr must list accepted prove-it markers'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (m): Requirement Ledger lifecycle ────────────────────────────────

const PROPOSAL_WITHOUT_LEDGER =
  '# Proposal: missing-ledger\n\n' +
  '## Why\n\ntest fixture\n\n' +
  '## What Changes\n\ntest changes\n\n' +
  '## Issue Anchor Verification\n\n' +
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
  '## Token Budget Check\n\n' +
  '| file | tier | tokens / cap | 占用率 |\n' +
  '|---|---|---|---|\n' +
  '| fixture.md | small | 100 / 500 | 20% |\n\n' +
  BATCH_APPROVAL_LEDGER_NA_SECTION;

function proposalWithLedgerTable(tableBody, tasksBody = '- [x] [Req: R1] fixture task coverage') {
  return (
    '# Proposal: ledger-fixture\n\n' +
    '## Why\n\ntest fixture\n\n' +
    '## What Changes\n\ntest changes\n\n' +
    '## Requirement Ledger\n\n' +
    tableBody +
    '\n\n## Section 3: Tasks\n\n' +
    tasksBody +
    '\n\n## Issue Anchor Verification\n\n' +
    '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
    '## Token Budget Check\n\n' +
    '| file | tier | tokens / cap | 占用率 |\n' +
    '|---|---|---|---|\n' +
    '| fixture.md | small | 100 / 500 | 20% |\n\n' +
    BATCH_APPROVAL_LEDGER_NA_SECTION
  );
}

test('case (m-1): relevant archive proposal missing Requirement Ledger → block', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-missing-ledger', specs: ['cap-ledger'], proposalContent: PROPOSAL_WITHOUT_LEDGER }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-missing-ledger' });
    assert.equal(r.status, 1, `expected exit 1 (missing Requirement Ledger), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(m\)/);
    assert.match(r.stderr, /Requirement Ledger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-1b): no-spec relevant archive with proposal missing Requirement Ledger → block', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-no-spec-missing-ledger', proposalContent: PROPOSAL_WITHOUT_LEDGER }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-no-spec-missing-ledger' });
    assert.equal(r.status, 1, `expected exit 1 (no-spec proposal still needs ledger), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(m\)/);
    assert.match(r.stderr, /Requirement Ledger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-2): Requirement Ledger missing lineage column → block', () => {
  const table =
    '| ID | Original Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|\n' +
    '| R1 | old shape | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-missing-lineage', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table) }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-missing-lineage' });
    assert.equal(r.status, 1, `expected exit 1 (missing lineage columns), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Pre-PR archive gate \(m\)/);
    assert.match(r.stderr, /Root Requirement/);
    assert.match(r.stderr, /Parent Requirement/);
    assert.match(r.stderr, /Current Requirement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-3): Requirement Ledger invalid disposition → block', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | done-ish | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-invalid-disposition', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table) }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-invalid-disposition' });
    assert.equal(r.status, 1, `expected exit 1 (invalid disposition), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /implemented, partial, deferred, rejected, moved-to-issue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-4): deferred Requirement Ledger row missing next step → block', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | deferred | TBD |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-deferred-no-next', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table) }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-deferred-no-next' });
    assert.equal(r.status, 1, `expected exit 1 (deferred without next step), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Owner \/ Next Step/);
    assert.match(r.stderr, /non-implemented disposition/);
    // (m-9 extend) rowErrors checkpoint must also emit canonical ledger example
    assert.match(r.stderr, /Root Requirement \| Parent Requirement \| Current Requirement/, 'rowErrors stderr must contain 6-col header from CANONICAL_LEDGER_EXAMPLE');
    assert.match(r.stderr, /\[Req: R1\]/, 'rowErrors stderr must contain [Req: R1] coverage example from CANONICAL_LEDGER_EXAMPLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-5): valid Requirement Ledger with follow-on lineage → pass', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1a | PR #1119 R7: consumer failure playbook | PR #1125 R3 deferred scenarios | Implement gh auth and no-CI recovery entries | implemented | this PR |\n' +
    '| R2 | PR #1119 R7: consumer failure playbook | PR #1125 R4 deferred scenarios | Remaining archive recovery scenario | moved-to-issue | issue #123 owner TL |';
  const dir = setupFixture({
    archives: [{
      name: '2026-06-17-ledger-valid-lineage',
      specs: ['cap-ledger'],
      proposalContent: proposalWithLedgerTable(table, '- [x] [Req: R1a] implement follow-on row'),
    }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-valid-lineage' });
    assert.equal(r.status, 0, `expected exit 0 (valid lineage ledger), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(m\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-5b): hyphenated ledger ID is rejected (hasRequirementId char class excludes "-")', () => {
  // Pins the intentional contract that ledger IDs follow the R<N>/R1a grammar and
  // a hyphen is NOT a valid ID char. Guards against a future re-add of "-" to the
  // hasRequirementId character class (which would also let [Req: R1-alpha] misparse).
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1-alpha | root | parent | current | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-hyphen-id', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table, '- [x] [Req: R1] task') }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-hyphen-id' });
    assert.equal(r.status, 1, `expected exit 1 (hyphenated ID rejected), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ID must look like R1 \/ R2 \/ R1a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-6): implemented Requirement Ledger row without task coverage → block', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-missing-task-coverage', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table, '- [x] implementation task without req tag') }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-missing-task-coverage' });
    assert.equal(r.status, 1, `expected exit 1 (implemented row without task coverage), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\[Req: R1\]/);
    assert.match(r.stderr, /task coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T3 prove-it: check (m) coverage source must follow SSOT ordered-first (mini),
// not the legacy "tasks.md if present else proposalBody" order.
test('case (m-dual-1): dual proposal carriers fail closed before ledger coverage', () => {
  const archiveName = '2026-08-05-ledger-dual-mini-has-req';
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | implemented | this fixture |';
  // proposal.md carries the ledger table; coverage must come from executable
  // carrier (mini), not from sibling tasks.md that omits [Req: R1].
  const proposalBody = proposalWithLedgerTable(table, 'Full task ledger lives in proposal-mini.md / tasks.md.');
  const miniWithReq =
    BMINI_LEDGER_HEADER +
    '## Tasks\n\n' +
    '- [x] [Req: R1] T1 — covered in mini\n' +
    '  - 驗收:mini carries exact ledger ID\n';
  const tasksWithoutReq =
    '## Tasks\n\n' +
    '- [x] T1 — tasks.md has no Req tag\n' +
    '  - 驗收:should not be the coverage source when mini exists\n';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      specs: ['cap-ledger'],
      proposalContent: proposalBody,
      proposalMiniContent: miniWithReq,
      tasksContent: tasksWithoutReq,
    }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected ambiguous carrier exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /proposal-carrier-ambiguous/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-dual-2): tasks.md-only full change coverage behaviour unchanged', () => {
  const archiveName = '2026-08-05-ledger-tasks-only-coverage';
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      specs: ['cap-ledger'],
      proposalContent: proposalWithLedgerTable(table, 'Full task ledger: tasks.md.'),
      tasksContent:
        '## Tasks\n\n' +
        '- [x] [Req: R1] T1 — covered in tasks.md\n' +
        '  - 驗收:tasks-only full change\n',
    }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    assert.ok(
      !existsSync(path.join(dir, 'openspec/changes/archive', archiveName, 'proposal-mini.md')),
      'control fixture must not have proposal-mini.md'
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (tasks.md-only coverage unchanged), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-7): task references unknown Requirement Ledger ID → block', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-unknown-task-ref', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table, '- [x] [Req: R1,R2] task references unknown row') }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-unknown-task-ref' });
    assert.equal(r.status, 1, `expected exit 1 (unknown [Req] reference), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\[Req: R2\]/);
    assert.match(r.stderr, /no matching Requirement Ledger row/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-7b): task references Requirement Ledger ID range → block with exact-ID guidance', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | implemented | this fixture |\n' +
    '| R2 | root | parent | current | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-range-task-ref', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table, '- [x] [Req: R1-R2] task uses range shorthand') }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-range-task-ref' });
    assert.equal(r.status, 1, `expected exit 1 (range [Req] reference), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\[Req: R1-R2\]/);
    assert.match(r.stderr, /is a range/);
    assert.match(r.stderr, /exact Requirement Ledger IDs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-7c): tag mixing a range and a standalone ID flags the range yet still extracts the standalone ID', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root | parent | current | implemented | this fixture |\n' +
    '| R2 | root | parent | current | implemented | this fixture |\n' +
    '| R3 | root | parent | current | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-range-plus-id', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table, '- [x] [Req: R1-R2, R3] mixes a range with a standalone ID') }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-range-plus-id' });
    assert.equal(r.status, 1, `expected exit 1 (range present), got ${r.status}: ${r.stderr}`);
    // The range substring is reported as a range, not mis-read as IDs R1/R2.
    assert.match(r.stderr, /\[Req: R1-R2\] is a range/);
    // R3 sits outside the range and MUST be extracted, so it is NOT reported missing coverage.
    assert.doesNotMatch(r.stderr, /row 3 \(R3\): implemented disposition requires \[Req: R3\]/);
    // R1/R2 live only inside the range; their endpoints are NOT extracted, so their
    // implemented rows correctly surface as missing task coverage.
    assert.match(r.stderr, /row 1 \(R1\): implemented disposition requires \[Req: R1\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-8): template placeholder Requirement Ledger cells → block', () => {
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | <root source + summary> | <parent row> | <this change scope> | implemented | <this PR / owner> |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-ledger-placeholder-cells', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table, '- [x] [Req: R1] task coverage') }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-ledger-placeholder-cells' });
    assert.equal(r.status, 1, `expected exit 1 (placeholder ledger cells), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /empty\/placeholder/);
    assert.match(r.stderr, /Root Requirement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (m-9): canonical ledger example appears in ALL 4 gate (m) checkpoint error messages.
// Tests the missing-heading, missing-table, and missing-columns paths here;
// the rowErrors path is covered by the extended (m-4) assertions above.
test('case (m-9a): missing-heading checkpoint stderr contains canonical ledger example', () => {
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-missing-ledger-canon', specs: ['cap-ledger'], proposalContent: PROPOSAL_WITHOUT_LEDGER }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-missing-ledger-canon' });
    assert.equal(r.status, 1, `expected exit 1 (missing Requirement Ledger), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Root Requirement \| Parent Requirement \| Current Requirement/, 'missing-heading stderr must contain 6-col header from CANONICAL_LEDGER_EXAMPLE');
    assert.match(r.stderr, /\[Req: R1\]/, 'missing-heading stderr must contain [Req: R1] coverage example from CANONICAL_LEDGER_EXAMPLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-9b): missing-table checkpoint stderr contains canonical ledger example', () => {
  // Bullet-list-only ledger: has ## Requirement Ledger heading but no parseable markdown table
  const bulletListLedger =
    '# Proposal: bullet-ledger\n\n' +
    '## Why\n\ntest fixture\n\n' +
    '## What Changes\n\ntest changes\n\n' +
    '## Requirement Ledger\n\n' +
    '- R1: implement the thing | Root: original req | Parent: same | Disposition: implemented\n\n' +
    '## Section 3: Tasks\n\n' +
    '- [x] [Req: R1] task coverage\n\n' +
    '## Issue Anchor Verification\n\n' +
    '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n' +
    '## Token Budget Check\n\n' +
    '| file | tier | tokens / cap | 占用率 |\n' +
    '|---|---|---|---|\n' +
    '| fixture.md | small | 100 / 500 | 20% |\n\n' +
    BATCH_APPROVAL_LEDGER_NA_SECTION;
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-bullet-list-ledger', specs: ['cap-ledger'], proposalContent: bulletListLedger }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-bullet-list-ledger' });
    assert.equal(r.status, 1, `expected exit 1 (bullet-list ledger not parseable), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Root Requirement \| Parent Requirement \| Current Requirement/, 'missing-table stderr must contain 6-col header from CANONICAL_LEDGER_EXAMPLE');
    assert.match(r.stderr, /\[Req: R1\]/, 'missing-table stderr must contain [Req: R1] coverage example from CANONICAL_LEDGER_EXAMPLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-9c): missing-columns checkpoint stderr contains canonical ledger example', () => {
  // Table has wrong column set (missing lineage columns: Root/Parent/Current Requirement)
  const table =
    '| ID | Original Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|\n' +
    '| R1 | old shape | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-06-17-missing-cols-canon', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table) }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-06-17-missing-cols-canon' });
    assert.equal(r.status, 1, `expected exit 1 (missing lineage columns), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Root Requirement \| Parent Requirement \| Current Requirement/, 'missing-columns stderr must contain 6-col header from CANONICAL_LEDGER_EXAMPLE');
    assert.match(r.stderr, /\[Req: R1\]/, 'missing-columns stderr must contain [Req: R1] coverage example from CANONICAL_LEDGER_EXAMPLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (m-10): valid Requirement Ledger row with GFM-escaped pipe in a cell → pass (naive split would false-block)', () => {
  // "current scope A \| fallback" contains a GFM-escaped literal pipe. A naive
  // `.split('|')` (pre-fix splitTableRow) treats the escaped pipe as a column
  // delimiter, shifting every subsequent column by one — so `Disposition`
  // (header index 4) would incorrectly read "fallback" instead of "implemented",
  // which is not an accepted disposition → false block. The escape-aware
  // splitter must parse this as exactly 6 columns with Disposition intact.
  const table =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n' +
    '| R1 | root req | parent req | current scope A \\| fallback | implemented | this fixture |';
  const dir = setupFixture({
    archives: [{ name: '2026-07-18-ledger-escaped-pipe', specs: ['cap-ledger'], proposalContent: proposalWithLedgerTable(table) }],
    canonicalSpecs: ['cap-ledger'],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '2026-07-18-ledger-escaped-pipe' });
    assert.equal(r.status, 0, `expected exit 0 (escaped pipe must not shift columns), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Pre-PR archive gate \(m\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Issue #1031: inherited-archived-residual false positive fix ───────────────
// T1 prove-it: these tests MUST FAIL before the fix is applied (T2/T3).
// Root cause: gate (a) diff-touched ownership treats an inherited active folder
// as "owned" when origin/main already renamed the same change into archive/ —
// the old two-dot PR-scope probe surfaced the active folder as branch-touched
// even though git will resolve it automatically on merge (main-side rename wins).

test('case (fp-1): inherited active folder already archived on origin/main (env override) → exit 0 + informational', () => {
  // Simulate the false-positive: active folder 'inherited-x' is in the working
  // tree AND appears in DEVPRO_DIFF_ACTIVE_CHANGES (root cause: main renamed it
  // into archive/ so the old two-dot PR-scope probe surfaced it as branch-touched).
  // DEVPRO_MAIN_ARCHIVED_NAMES overrides the git ls-tree probe for test isolation.
  // Expected AFTER fix: exit 0 + stdout contains 'will resolve' + no rescue hint.
  const dir = setupFixture({ active: ['inherited-x'] });
  try {
    const r = run(dir, {
      DEVPRO_DIFF_ACTIVE_CHANGES: 'inherited-x',
      DEVPRO_MAIN_ARCHIVED_NAMES: 'inherited-x',
    });
    assert.equal(r.status, 0, `expected exit 0 (inherited residual must not block), got ${r.status}: stderr=${r.stderr}`);
    assert.match(r.stdout, /will resolve/, 'stdout must contain informational "will resolve" message');
    assert.ok(!r.stdout.includes('chore/docs-archive'), `stdout must NOT contain rescue hint 'chore/docs-archive', got: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * T4: git-backed fixture for inherited-archived-residual scenario (issue #1031).
 * Setup:
 *   - "origin" bare repo whose main branch tree contains archive/<date>-inherited-archived-y/
 *   - Feature branch (local) working tree still holds openspec/changes/inherited-archived-y/
 *     (simulating that the feature branch forked before main archived that change)
 *   - Branch-suffix ownership can still mark inherited-archived-y as owned
 *   - No DEVPRO_MAIN_ARCHIVED_NAMES env override — gate must walk the real git ls-tree path
 * Expected: exit 0 + informational stdout (gate sees archive on origin/main → excludes)
 */
function setupMainArchivedResidualGitFixture() {
  const rootDir = mkdtempSync(path.join(tmpGitRoot, 'inherited-archived-'));
  const changeName = 'inherited-archived-y';
  const archiveFolderName = `2026-06-01-${changeName}`;

  // Step 1: create a "bare origin" repo whose main has the archive folder
  const originDir = path.join(rootDir, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', originDir]);

  // Build the initial main tree in a temp work tree (init + config via template copy)
  const seedDir = path.join(rootDir, 'seed');
  cpSync(getEmptyGitRepoTemplate(), seedDir, { recursive: true });

  // main commit 1: feature change is still active on main
  const activeDir = path.join(seedDir, 'openspec/changes', changeName);
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(path.join(activeDir, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  // Need an archive to ensure gate reaches the pass-through (b)/(c) checks
  const archiveSeedDir = path.join(seedDir, 'openspec/changes/archive', archiveFolderName);
  const archiveCapSeedDir = path.join(archiveSeedDir, 'specs/cap-inherited');
  mkdirSync(archiveCapSeedDir, { recursive: true });
  writeFileSync(path.join(archiveSeedDir, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  writeFileSync(path.join(archiveCapSeedDir, 'spec.md'), '# cap-inherited Spec Delta\n');
  const canonicalDir = path.join(seedDir, 'openspec/specs/cap-inherited');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(path.join(canonicalDir, 'spec.md'), '# cap-inherited Specification\n## Purpose\nx\n## Requirements\n');
  spawnSync('git', ['add', '-A'], { cwd: seedDir });
  spawnSync('git', ['commit', '-q', '-m', 'seed: active change + archive'], { cwd: seedDir });

  // main commit 2: archive the active change (simulates what origin/main has done)
  // Remove active folder; archive folder already exists from step above
  rmSync(path.join(seedDir, 'openspec/changes', changeName), { recursive: true, force: true });
  spawnSync('git', ['add', '-A'], { cwd: seedDir });
  spawnSync('git', ['commit', '-q', '-m', `chore: archive ${changeName} on main`], { cwd: seedDir });

  // Push seed to origin
  spawnSync('git', ['remote', 'add', 'origin', originDir], { cwd: seedDir });
  spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: seedDir });

  // Step 2: create the feature repo — simulates a branch that forked BEFORE main archived
  const featureDir = path.join(rootDir, 'feature');
  mkdirSync(featureDir);
  // Clone from origin (gets main at commit 2, without active folder)
  spawnSync('git', ['clone', '-q', originDir, featureDir]);
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: featureDir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: featureDir });

  // Add the active folder back to simulate "feature branch forked at commit 1"
  // (working tree inherited the active folder; it's not in origin/main HEAD tree)
  const featureActiveDir = path.join(featureDir, 'openspec/changes', changeName);
  mkdirSync(featureActiveDir, { recursive: true });
  writeFileSync(path.join(featureActiveDir, 'proposal.md'), VALID_PROPOSAL_CONTENT);
  spawnSync('git', ['checkout', '-q', '-b', `feature/${changeName}`], { cwd: featureDir });
  spawnSync('git', ['add', '-A'], { cwd: featureDir });
  spawnSync('git', ['commit', '-q', '-m', `feat: work on ${changeName}`], { cwd: featureDir });

  return featureDir;
}

test('case (fp-2): inherited active folder already archived on origin/main (git-backed, no env override) → exit 0 + informational', () => {
  // This exercises the REAL git ls-tree origin/main probe path (not env override).
  // The fixture sets up an origin/main tree that contains archive/<date>-inherited-archived-y/
  // while the local feature branch still has openspec/changes/inherited-archived-y/ as a
  // committed file (branch suffix marks it as owned; origin/main archive excludes it).
  const featureDir = setupMainArchivedResidualGitFixture();
  try {
    const r = run(featureDir, {
      // No DEVPRO_MAIN_ARCHIVED_NAMES — must use real git ls-tree probe
      // DEVPRO_DIFF_ACTIVE_CHANGES not set — must use real git diff (or fallback)
      DEVPRO_RELEVANT_ARCHIVES: `2026-06-01-inherited-archived-y`,
      DEVPRO_SCENARIO_DIFF_BASELINE_REF: 'origin/main',
    });
    assert.equal(r.status, 0, `expected exit 0 (git-backed inherited residual must not block), got ${r.status}: stderr=${r.stderr} stdout=${r.stdout}`);
    assert.match(r.stdout, /will resolve/, 'stdout must contain informational "will resolve" via real git probe');
    assert.ok(!r.stdout.includes('chore/docs-archive'), `stdout must NOT contain rescue hint, got: ${r.stdout}`);
  } finally {
    rmSync(path.dirname(featureDir), { recursive: true, force: true });
  }
});

test('case (fp-3): fail-open — own un-archived change + origin/main not resolvable → exit 1 (issue #170 not weakened)', () => {
  // Fail-open scenario: the git ls-tree probe for DEVPRO_MAIN_ARCHIVED_NAMES fails
  // (origin/main not available in this fixture — no git remote). The gate must NOT
  // misclassify a genuinely un-archived own change as an inherited residual.
  // Expected: exit 1 (blockingOwned is non-empty, probe returned []).
  const dir = setupFixture({ active: ['own-unarchived'] });
  try {
    const r = run(dir, {
      DEVPRO_DIFF_ACTIVE_CHANGES: 'own-unarchived',
      // No DEVPRO_MAIN_ARCHIVED_NAMES → falls to git probe
      // No git remote in this setupFixture dir → rev-parse origin/main fails → fail-open → []
      // → mainArchived empty → own-unarchived stays in blockingOwned → exit 1
    });
    assert.equal(r.status, 1, `expected exit 1 (fail-open: probe fails, own change must still block), got ${r.status}: stderr=${r.stderr}`);
    assert.match(r.stderr, /Active change folder still exists/, 'stderr must contain block message');
    assert.match(r.stderr, /own-unarchived/, 'stderr must name the blocking folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (n): Promoted spec archive placeholder gate ────────────────────────
// TDD prove-it: (n-1) must be RED before check (n) is implemented (gate lacks (n)
// → exit 0 when canonical spec has placeholder). (n-2..n-4) must be GREEN in both
// pre- and post-implementation state (skip/pass paths that must never block).

test('case (n-1): canonical spec has TBD-archiving placeholder + archive in relevant set → exit 1 (prove-it RED)', () => {
  // Fixture: archive with specs/cap-test/ + canonical spec containing the
  // exact placeholder phrase. DEVPRO_RELEVANT_ARCHIVES points at the archive.
  // Gate (n) must read canonical openspec/specs/cap-test/spec.md, grep for
  // 'TBD - created by archiving', and exit 1 with:
  //   - stderr mentions check "(n)"
  //   - stderr contains the spec path
  //   - stderr contains fix hint about "回填 Purpose" / "Purpose"
  const archiveName = '2026-06-23-check-n-placeholder';
  const dir = setupSpecFixture(archiveName);
  try {
    // Overwrite the canonical spec with a placeholder ## Purpose line
    const canonicalSpecPath = path.join(dir, 'openspec/specs/cap-test/spec.md');
    writeFileSync(
      canonicalSpecPath,
      '# cap-test Specification\n' +
      '## Purpose\n' +
      `TBD - created by archiving change ${archiveName}. Update Purpose after archive.\n` +
      '## Requirements\n'
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (placeholder in canonical spec), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(n\)/, 'stderr must mention check (n)');
    assert.match(r.stderr, /cap-test/, 'stderr must identify the affected spec');
    assert.match(r.stderr, /Purpose/, 'stderr must include fix hint about Purpose');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (n-2): canonical spec has NO placeholder → pass (no false-positive)', () => {
  // Fixture: same archive + canonical spec WITHOUT placeholder phrase.
  // Gate (n) must not block when canonical spec is clean.
  const archiveName = '2026-06-23-check-n-no-placeholder';
  const dir = setupSpecFixture(archiveName);
  try {
    // setupSpecFixture already writes a clean spec (no placeholder)
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (no placeholder → pass), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(n\)/, 'stderr must not mention check (n)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (n-3): DEVPRO_RELEVANT_ARCHIVES=\'\' (empty set) → check (n) skip even if canonical has placeholder', () => {
  // Scope-bound: when this PR touches no archive, check (n) must skip.
  // This validates fail-open / scope-bound behavior — the 7 existing placeholder
  // specs in the repo must NOT block unrelated PRs.
  const archiveName = '2026-06-23-check-n-skip-empty';
  const dir = setupSpecFixture(archiveName);
  try {
    // Overwrite canonical spec with placeholder to verify the skip is real
    const canonicalSpecPath = path.join(dir, 'openspec/specs/cap-test/spec.md');
    writeFileSync(
      canonicalSpecPath,
      '# cap-test Specification\n' +
      '## Purpose\n' +
      `TBD - created by archiving change ${archiveName}. Update Purpose after archive.\n` +
      '## Requirements\n'
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (empty relevant archives → skip check (n)), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(n\)/, 'stderr must not mention check (n) when scope is empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (n-4): archive has no specs/ dir → check (n) skips that archive (continue)', () => {
  // When archive has no specs/ subdirectory (chore-A pattern), check (n) must
  // skip that archive via continue — it has no caps to check.
  const archiveName = '2026-06-23-check-n-no-specs-dir';
  // Use setupFixture (not setupSpecFixture) — no specs dir for this archive
  const dir = setupFixture({
    archives: [{ name: archiveName }],
    // No canonicalSpecs: archive has no specs/ dir (chore-A pattern)
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (no specs/ dir → skip check (n)), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(n\)/, 'stderr must not mention check (n) when archive lacks specs/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (n-5): placeholder phrase in non-Purpose section only (self-reference) → gate (n) does NOT block', () => {
  // Regression guard: a canonical spec whose ## Purpose is real content but whose
  // non-Purpose section (e.g. a check description or scenario) contains the literal
  // phrase `TBD - created by archiving` (as documentation) must NOT be blocked.
  // This is exactly the self-reference bug that openspec/specs/archive-tooling/spec.md
  // triggers — gate (n) checks (n) description itself contains the phrase.
  const archiveName = '2026-06-23-check-n-self-ref';
  const dir = setupSpecFixture(archiveName);
  try {
    // Write a canonical spec where ## Purpose is real content, but a later section
    // contains the literal placeholder phrase (simulating gate documentation).
    const canonicalSpecPath = path.join(dir, 'openspec/specs/cap-test/spec.md');
    writeFileSync(
      canonicalSpecPath,
      '# cap-test Specification\n' +
      '## Purpose\n' +
      'Real purpose text describing the feature — not a placeholder.\n' +
      '## Requirements\n' +
      '### Requirement: Gate (n) Description\n' +
      '- Check (n): The gate SHALL verify that the spec does NOT contain `TBD - created by archiving` in ## Purpose.\n' +
      '#### Scenario: Placeholder Present\n' +
      '- **WHEN** the canonical spec ## Purpose contains the literal phrase `TBD - created by archiving`\n' +
      '- **THEN** the gate SHALL exit 1\n'
    );
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(
      r.status, 0,
      `expected exit 0 (placeholder only in non-Purpose section → no block), got ${r.status}: ${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /\(n\)/, 'stderr must not mention check (n) for self-reference false-positive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Check (o): Task checkbox execution-state backstop ─────────────────────────
// (o) is the post-archive mirror of lint-proposal-tasks-checked.mjs (pre-archive).
// It runs BEFORE the `if (!anySpecsFound)` chore-A pass-through, so a B-mini
// change (proposal-mini.md, no specs/) — the primary checkbox-miss scenario — is
// still gated. env: DEVPRO_DIFF_ACTIVE_CHANGES='' clears (a); DEVPRO_RELEVANT_ARCHIVES
// scopes to the fixture archive.
const O_ENV = { DEVPRO_DIFF_ACTIVE_CHANGES: '' };

test('case (o-1): B-mini archive with unchecked task (no ## Deferred) → exit 1 (prove-it RED)', () => {
  const archiveName = '2026-07-01-o-unchecked';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalMiniContent: BMINI_LEDGER_HEADER + '## Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (unchecked task in B-mini), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(o\)/);
    assert.match(r.stderr, /unchecked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-2): B-mini archive all [x] with [Req]+驗收 evidence → pass (no false-positive)', () => {
  const archiveName = '2026-07-01-o-clean';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalMiniContent: BMINI_LEDGER_HEADER + '## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (all checked + evidence), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(o\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-3): B-mini archive with empty check-off (bare [x], no acceptance) → exit 1', () => {
  const archiveName = '2026-07-01-o-bare';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      // Include [Req: R1] so check (m) SSOT mini-first coverage clears; (o) still
      // blocks on missing 驗收/acceptance evidence (empty check-off).
      proposalMiniContent: BMINI_LEDGER_HEADER + '## Tasks\n- [x] Task 1 — bare check [Req: R1]\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (bare [x] with no acceptance evidence), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(o\)/);
    assert.match(r.stderr, /no-acceptance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-4): unchecked task authorized by ## Deferred section → pass', () => {
  const archiveName = '2026-07-01-o-deferred';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalMiniContent: BMINI_LEDGER_HEADER + '## Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:later\n## Deferred\n- Task 1 deferred: upstream blocked\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (## Deferred authorizes unchecked), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-5): DEVPRO_RELEVANT_ARCHIVES=\'\' (empty set) → check (o) skip even if archive has unchecked task', () => {
  const archiveName = '2026-07-01-o-empty-set';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalMiniContent: '# c\n## Why\nx\n## What Changes\ny\n## Tasks\n- [ ] Task 1 — foo [Req: R1]\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (empty relevant set → (o) skip, fail-open), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(o\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-6): tasks.md fallback — full-OpenSpec archive with unchecked tasks.md → exit 1', () => {
  const archiveName = '2026-07-01-o-tasksmd';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      // proposal.md defaults to VALID_PROPOSAL_CONTENT (satisfies c/d/e/m);
      // no proposal-mini.md → (o) falls back to tasks.md.
      tasksContent: '# c\n## Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (unchecked tasks.md via fallback), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(o\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-7): relevant full archive with duplicate ledger inside proposal Deferred → exit 1', () => {
  const archiveName = '2026-07-01-o-duplicate-ledger';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: DEFERRED_DUPLICATE_LEDGER_PROPOSAL_CONTENT,
      tasksContent: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (duplicate full ledgers), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /\(o\)/);
    assert.match(r.stderr, /duplicate-ledger/);
    assert.match(r.stderr, /proposal\.md/);
    assert.match(r.stderr, /tasks\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (o-8): unrelated archived duplicate ledger is outside relevant-set scope → pass', () => {
  const archiveName = '2026-07-01-o-unrelated-duplicate-ledger';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: DUPLICATE_LEDGER_PROPOSAL_CONTENT,
      tasksContent: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    }],
  });
  try {
    const r = run(dir, { ...O_ENV, DEVPRO_RELEVANT_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (unrelated duplicate outside relevant set), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\(o\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BRD required-heading canonical set stays consistent across shared validator / quality-formats / dp-analyst', () => {
  // Three SSOT locations must agree on the "12 canonical BRD required headings"
  // set (or a documented subset of it), or BRD validation silently drifts:
  //   (a) gate:            pre-pr-archive-gate.mjs BRD_REQUIRED_HEADINGS array (12, canonical)
  //   (b) quality-formats: openspec-quality-and-formats.md sample grep line (4-field spot-check)
  //   (c) dp-analyst:      dp-analyst.md write-BRD instruction line (must list all 12)
  const scriptsDir = path.dirname(GATE);
  const repoRootForDocs = path.resolve(scriptsDir, '../..');

  // --- (a) Parse the shared executable SSOT used by active and archive paths.
  const validatorSource = readFileSync(path.join(scriptsDir, 'lib/brd-required-headings.mjs'), 'utf8');
  const arrayMatch = validatorSource.match(/BRD_REQUIRED_HEADINGS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(arrayMatch, 'shared validator must define BRD_REQUIRED_HEADINGS as one executable SSOT');
  const gateHeadings = [...arrayMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  assert.equal(gateHeadings.length, 12, `expected 12 canonical BRD headings in gate array, got ${gateHeadings.length}: ${JSON.stringify(gateHeadings)}`);

  // --- (c) dp-analyst.md: find the "寫入 brd.md" instruction line (contains
  // 寫入 + brd.md + 分支資訊) and assert every gate heading is a substring of it.
  const dpAnalystPath = path.join(repoRootForDocs, '.claude/agents/dp-analyst.md');
  const dpAnalystSource = readFileSync(dpAnalystPath, 'utf8');
  const dpAnalystLine = dpAnalystSource
    .split('\n')
    .find((line) => line.includes('寫入') && line.includes('brd.md') && line.includes('分支資訊'));
  assert.ok(dpAnalystLine, 'dp-analyst.md must contain a line with 寫入 + brd.md + 分支資訊 (BRD-write instruction anchor moved?)');
  for (const heading of gateHeadings) {
    assert.ok(
      dpAnalystLine.includes(heading),
      `dp-analyst.md BRD-write instruction line is missing gate heading "${heading}" ` +
        `(SSOT: pre-pr-archive-gate.mjs BRD_REQUIRED_HEADINGS — dp-analyst.md line drifted out of sync)`
    );
  }

  // --- (b) openspec-quality-and-formats.md: find the sample "grep -E" spot-check
  // line and assert every field it lists is a MEMBER of the gate's 12-heading
  // set (the spot-check is intentionally a subset, not full coverage — so we
  // only assert containment, not equality, and never assert count == 12 here).
  const qualityFormatsPath = path.join(repoRootForDocs, '.devpro/agent-rules/openspec-quality-and-formats.md');
  const qualityFormatsSource = readFileSync(qualityFormatsPath, 'utf8');
  const grepLine = qualityFormatsSource
    .split('\n')
    .find((line) => line.trim().startsWith('grep -E') && line.includes('brd.md'));
  assert.ok(grepLine, 'openspec-quality-and-formats.md must contain a `grep -E "...brd.md required headings..." brd.md` spot-check line (anchor moved?)');
  const grepPatternMatch = grepLine.match(/grep -E "([^"]+)"/);
  assert.ok(grepPatternMatch, `could not parse grep -E pattern out of spot-check line: ${grepLine}`);
  const spotCheckFields = grepPatternMatch[1].split('|');
  assert.ok(spotCheckFields.length > 0, 'spot-check grep pattern must list at least one field');
  for (const field of spotCheckFields) {
    assert.ok(
      gateHeadings.includes(field),
      `openspec-quality-and-formats.md spot-check field "${field}" is not a member of gate ` +
        `BRD_REQUIRED_HEADINGS (SSOT: pre-pr-archive-gate.mjs) — spot-check line lists a ghost field ` +
        `not required by the gate`
    );
  }
});

// ── Check (c) extension: Batch Approval Ledger shape gate ──────────────────
// (enforce-batch-scope-ledger-presence T4/T5, design.md D1/D2/D3). Two
// independent failure branches inside the same bcEvalArchives loop:
//   1. `## Batch Approval Ledger` heading absent → merged into the existing
//      `missingHeadings` array; byte-identical message/exit path as
//      `## Why` / `## What Changes`.
//   2. Heading present but `evaluateBatchApprovalLedgerShape(...)` returns
//      `shapeless` → independent `process.stderr.write` + its own `Fix:`
//      line, NOT folded into `missingHeadings`.
// `absent` is treated as case 1; `ok` (N/A sentinel, or every
// identity-independent required field present) passes.

const BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY =
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
  '`grep -F "anchor" file.md` → 1 hit @ file.md:10\n\n';

const BATCH_LEDGER_NA_SECTION =
  '## Batch Approval Ledger\n\nN/A: no batch approval selected\n';

function fullBatchLedgerSection(namedChange, { covers = true } = {}) {
  return (
    '## Batch Approval Ledger\n\n' +
    'kind: same-change-dp-change-batch\n' +
    `named_change: ${namedChange}\n` +
    'branch: chore/fixture-branch\n' +
    'repo_scope: same-repo\n' +
    (covers ? 'covers:\n  - task A\n' : 'covers:\n') +
    'excludes:\n  - task B\n'
  );
}

test('case (c-ledger-a): archive proposal missing ## Batch Approval Ledger heading → exit 1 (merged into missingHeadings)', () => {
  const archiveName = '2026-08-22-batch-ledger-absent';
  const dir = setupFixture({
    archives: [{ name: archiveName, proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (heading absent), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /missing required heading/);
    assert.ok(r.stderr.includes('## Batch Approval Ledger'), `stderr should list the missing heading, got: ${r.stderr}`);
    // dp-reviewer C2 regression: `## Why`/`## What Changes` are present in this
    // fixture, so the fix instructions MUST be ledger-specific, not the stale
    // "add `## Why` and `## What Changes`" line (those headings already exist).
    assert.match(r.stderr, /Fix \(Batch Approval Ledger\):/, `stderr must give ledger-specific fix instructions, got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Fix: add `## Why` and `## What Changes`/, `stderr must not tell the author to add headings that already exist, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-b): heading present with N/A sentinel → exit 0', () => {
  const archiveName = '2026-08-22-batch-ledger-na';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY + BATCH_LEDGER_NA_SECTION,
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (N/A sentinel), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-c) [archiveName date-prefix regression]: full ledger, named_change bare, archive folder carries YYYY-MM-DD- prefix → exit 0', () => {
  // Regression test for design.md D2's 2026-08-23 archiveName fix: the
  // archive folder name is date-prefixed, but `named_change` stores the bare
  // change name. Before the fix, comparing named_change against the literal
  // (date-prefixed) archiveName would always mismatch and misfire `shapeless`.
  const archiveName = '2026-08-22-batch-ledger-date-prefix';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY + fullBatchLedgerSection('batch-ledger-date-prefix'),
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 0, `expected exit 0 (full ledger, bare named_change matches date-prefix-stripped archiveName), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-d) [round-1 CRITICAL regression]: heading present but only `kind:` line (empty shell) → shapeless → exit 1', () => {
  const archiveName = '2026-08-22-batch-ledger-shell';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY + '## Batch Approval Ledger\n\nkind: same-change-dp-change-batch\n',
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (empty-shell ledger is shapeless, not ok), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /missing required heading/, 'shapeless is a distinct failure branch, not merged into missingHeadings');
    assert.match(r.stderr, /Fix:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-e): `covers` empty → shapeless → exit 1', () => {
  const archiveName = '2026-08-22-batch-ledger-empty-covers';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY + fullBatchLedgerSection('batch-ledger-empty-covers', { covers: false }),
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (empty covers is shapeless), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /missing required heading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-f): `named_change` mismatches archive folder bare name → shapeless → exit 1', () => {
  const archiveName = '2026-08-22-batch-ledger-name-mismatch';
  const dir = setupFixture({
    archives: [{
      name: archiveName,
      proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY + fullBatchLedgerSection('totally-different-name'),
    }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName });
    assert.equal(r.status, 1, `expected exit 1 (named_change mismatch is shapeless), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /missing required heading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-g) [dp-reviewer C1 regression]: historical archive merely touched (not newly added) and lacking a ledger → ledger sub-check does not fire', () => {
  // A PR that edits an unrelated file inside a pre-existing archive folder
  // (e.g. a docs backfill) puts that archive in bcEvalArchives/relevantExistingArchives
  // (touched) but NOT in the added-set (it predates this PR). The ledger
  // sub-check MUST be scoped to the added-set only, so this archive's missing
  // `## Batch Approval Ledger` — which it predates and cannot retroactively
  // have — does not block an otherwise-unrelated PR. `## Why`/`## What Changes`
  // are present in the fixture, so absent those two the exit must be 0.
  const archiveName = '2026-08-22-batch-ledger-touched-not-added';
  const dir = setupFixture({
    archives: [{ name: archiveName, proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY }],
  });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: archiveName, DEVPRO_ADDED_ARCHIVES: '' });
    assert.equal(r.status, 0, `expected exit 0 (ledger sub-check scoped to added-set only), got ${r.status}: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-h) [dp-reviewer C-C real-probe regression]: PR backfills an unrelated file into a pre-existing archive (not its proposal) -> real git diff-filter=A probe does not re-trigger the ledger check', () => {
  // Exercises getAddedArchives()'s real git probes end to end (no
  // DEVPRO_ADDED_ARCHIVES/DEVPRO_RELEVANT_ARCHIVES override) — case
  // (c-ledger-g) above only proves the env-override code path, not the
  // production `--diff-filter=A` + proposal-only-pathspec probe itself.
  const archiveName = '2026-01-01-historical-archive-real-probe';
  const dir = setupFixture({
    archives: [{ name: archiveName, proposalContent: BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY }],
  });
  try {
    // Baseline commit: the archive (proposal.md, no ledger) already exists —
    // it predates this "PR" — and becomes origin/main, same as run()'s setup.
    gitFixture(dir, ['init', '-q', '-b', 'main']);
    gitFixture(dir, ['config', 'user.email', 'fixture@example.invalid']);
    gitFixture(dir, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(dir, 'openspec/changes/archive', archiveName, 'brd.md'), VALID_BRD_CONTENT);
    gitFixture(dir, ['add', '.']);
    gitFixture(dir, ['commit', '-q', '-m', 'fixture baseline (archive predates this PR)']);
    gitFixture(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    // This "PR": backfill an unrelated file into the already-archived folder
    // WITHOUT touching its proposal.md (the real historical pattern from
    // decisions.md round-2 finding C-C — e.g. commit 8e1a4b8f backfilling
    // qa-test-scope.md into an archive created weeks earlier).
    const backfillPath = path.join(dir, 'openspec/changes/archive', archiveName, 'qa-test-scope.md');
    writeFileSync(backfillPath, '## QA 測試範圍評估\n');
    gitFixture(dir, ['add', '.']);
    gitFixture(dir, ['commit', '-q', '-m', 'backfill qa-test-scope.md into historical archive']);

    const r = spawnSync('node', [GATE, dir], {
      encoding: 'utf8',
      env: { ...process.env, DEVPRO_PR_TOUCHED_RULE_FILES: '' },
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0 (backfilled file into a pre-existing archive must not re-trigger its missing ledger via the real diff-filter=A probe), got ${r.status}: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-i) [dp-reviewer round-3 verification, positive control for C-C]: brand-new archive left UNTRACKED (as `openspec archive` leaves it before `git add`) with no ledger -> real `ls-files --others` probe still catches it', () => {
  // (c-ledger-h) above is the negative control (a pre-existing archive must
  // NOT be re-flagged). This is the positive control: the actual moment
  // check (c) is supposed to defend — right after this change's own
  // `openspec archive` runs, before anything is `git add`ed — the new
  // archive's proposal is untracked, not committed or staged. If
  // getAddedArchives()'s `ls-files --others --exclude-standard` probe missed
  // this, check (c) would silently skip the ledger check on the very change
  // shipping this defense (highest-risk false negative; see decisions.md
  // "advisor round-3 follow-up" verification note).
  const archiveName = '2026-08-23-brand-new-archive-untracked';
  const dir = setupFixture({});
  try {
    gitFixture(dir, ['init', '-q', '-b', 'main']);
    gitFixture(dir, ['config', 'user.email', 'fixture@example.invalid']);
    gitFixture(dir, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(dir, '.fixture-baseline'), 'archive-gate fixture\n');
    gitFixture(dir, ['add', '.']);
    gitFixture(dir, ['commit', '-q', '-m', 'fixture baseline (no archive exists yet)']);
    gitFixture(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    // Simulate `openspec archive` having just run: the folder and proposal
    // exist on disk but are NOT `git add`ed — genuinely untracked, matching
    // real post-archive, pre-commit state.
    const archChange = path.join(dir, 'openspec/changes/archive', archiveName);
    mkdirSync(archChange, { recursive: true });
    writeFileSync(path.join(archChange, 'proposal.md'), BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY);

    const r = spawnSync('node', [GATE, dir], {
      encoding: 'utf8',
      env: { ...process.env, DEVPRO_PR_TOUCHED_RULE_FILES: '' },
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1 (untracked brand-new archive missing a ledger must still be caught), got ${r.status}: ${r.stderr}`,
    );
    assert.match(r.stderr, /Fix \(Batch Approval Ledger\):/, `stderr must give ledger-specific fix instructions, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case (c-ledger-j) [PR #2279 cross-model dispute, rename-safety regression]: whole-folder `git mv` archive commit (proposal.md classified R100 in the unscoped diff) with no ledger -> real `--diff-filter=A` proposal-pathspec probe still catches it as added', () => {
  // GPT-5 second-opinion review of PR #2279 raised a CRITICAL finding that
  // getAddedArchives()'s --diff-filter=A pathspec probe could be bypassed
  // when a real `openspec archive` move is classified by Git as a rename
  // (R100) rather than an Add, letting the archived proposal's missing
  // ledger silently skip check (c). The existing doc comment above
  // getAddedArchives() already argued this can't happen (pathspec-scoped
  // diffs can't see rename pairs — they only see the post-image path, which
  // git reports as a plain A), and 5 independent scratch-repo experiments
  // confirmed that reasoning empirically. This test pins the same property
  // against the REAL gate (not raw `git diff`), with an actual whole-folder
  // `git mv` in one commit — the exact production archive-move shape — so
  // a future git/Node change to this probe cannot silently regress it.
  const changeName = 'rename-safety-regression';
  const archiveName = '2026-08-23-rename-safety-regression';
  const dir = setupFixture({});
  try {
    gitFixture(dir, ['init', '-q', '-b', 'main']);
    gitFixture(dir, ['config', 'user.email', 'fixture@example.invalid']);
    gitFixture(dir, ['config', 'user.name', 'Fixture']);

    // Baseline commit: active (pre-archive) change folder with several files,
    // so the eventual archive move is a genuine whole-folder rename (not a
    // single-file edge case) — matching the real `openspec archive` shape.
    const activeDir = path.join(dir, 'openspec/changes', changeName);
    mkdirSync(path.join(activeDir, 'specs/cap-x'), { recursive: true });
    writeFileSync(path.join(activeDir, 'proposal.md'), BATCH_LEDGER_PROPOSAL_HEADINGS_ONLY);
    writeFileSync(path.join(activeDir, 'tasks.md'), '- [x] [Req: R1] fixture task\n');
    writeFileSync(path.join(activeDir, 'specs/cap-x/spec.md'), '# cap-x Spec Delta\nv1\n');
    gitFixture(dir, ['add', '.']);
    gitFixture(dir, ['commit', '-q', '-m', 'feat: add active change (pre-archive)']);
    gitFixture(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    // Archive move: whole-folder `git mv` in a single commit, only the
    // PARENT `archive/` dir pre-created (not the exact target dir) so git
    // renames the source dir to exactly the target — matching the real
    // `openspec archive` move and avoiding the double-nesting pitfall of
    // pre-creating the destination itself.
    mkdirSync(path.join(dir, 'openspec/changes/archive'), { recursive: true });
    gitFixture(dir, ['mv', `openspec/changes/${changeName}`, `openspec/changes/archive/${archiveName}`]);
    gitFixture(dir, ['commit', '-q', '-m', 'chore: archive rename-safety-regression']);

    // Sanity: confirm the unscoped full-tree diff really does classify the
    // moved proposal.md as a rename (R100), not a plain Add — otherwise this
    // test would not be exercising the disputed scenario at all.
    const unscopedDiff = spawnSync(
      'git', ['-C', dir, 'diff', '--name-status', '-M', 'origin/main...HEAD'],
      { encoding: 'utf8' },
    );
    assert.match(
      unscopedDiff.stdout,
      new RegExp(`R100\\s+openspec/changes/${changeName}/proposal\\.md\\s+openspec/changes/archive/${archiveName}/proposal\\.md`),
      `expected unscoped diff to classify proposal.md as R100 rename, got: ${unscopedDiff.stdout}`,
    );

    const r = spawnSync('node', [GATE, dir], {
      encoding: 'utf8',
      env: { ...process.env, DEVPRO_PR_TOUCHED_RULE_FILES: '' },
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1 (rename-classified archived proposal missing a ledger must still be caught by the real diff-filter=A probe), got ${r.status}: ${r.stderr}`,
    );
    assert.match(r.stderr, /Fix \(Batch Approval Ledger\):/, `stderr must give ledger-specific fix instructions, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2971: real archive-gate path, not only the shared reader API.
for (const [label, wrap] of [
  ['fenced', s => `\`\`\`markdown\n${s}\n\`\`\`\n`],
  ['commented', s => `<!--\n${s}\n-->\n`],
]) {
  test(`case (m-ledger-${label}): example before formal Ledger does not require example task coverage`, () => {
    const table = '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
      '|---|---|---|---|---|---|\n';
    const actual = proposalWithLedgerTable(table + '| R1 | user request | root | actual | implemented | TL |');
    const example = '## Requirement Ledger\n' + table + '| R9 | user request | root | example | implemented | TL |';
    const name = `2026-10-12-ledger-${label}`;
    const dir = setupFixture({ archives: [{ name, proposalContent: wrap(example) + actual }] });
    try {
      const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: name });
      assert.equal(r.status, 0, `only R1 needs coverage: ${r.stderr}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('case (m-ledger-carrier): shared Ledger selection does not waive artifact-class ambiguity', () => {
  const table = '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n| R1 | user request | root | actual | implemented | TL |';
  const name = '2026-10-12-ledger-carrier';
  const dir = setupFixture({ archives: [{ name, proposalContent: PROPOSAL_WITHOUT_LEDGER }] });
  try {
    writeFileSync(path.join(dir, 'openspec/changes/archive', name, 'proposal-mini.md'), proposalWithLedgerTable(table));
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: name });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Pre-PR archive gate \(j\).*proposal-carrier-ambiguous/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('case (m-ledger-duplicate): two formal headings are refused with the same count-reader failure class', () => {
  const table = '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n| R1 | user request | root | actual | implemented | TL |';
  const name = '2026-10-12-ledger-duplicate';
  const body = proposalWithLedgerTable(table) + '\n## Requirement Ledger\n' + table;
  const dir = setupFixture({ archives: [{ name, proposalContent: body }] });
  try {
    const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: name });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Pre-PR archive gate \(m\).*duplicate-requirement-ledger/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [reason, transform, diagnostic] of [
  ['duplicate-requirement-id', t => t + '\n| R1 | user request | root | duplicate | implemented | TL |', /duplicate Requirement Ledger ID: R1/],
  ['ambiguous-requirement-table', t => t + '\n\n' + t.replace('| R1 |', '| R2 |'), /ambiguous-requirement-table/],
  ['requirement-ledger-inert-only', t => t, /requirement-ledger-inert-only/],
  ['malformed-requirement-row', t => t + '\n| R2 | broken row', /malformed-requirement-row.*R2/],
]) {
  test(`case (m-shared-${reason}): real archive gate reports the shared structural refusal`, () => {
    const table = '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
      '|---|---|---|---|---|---|\n| R1 | user request | root | actual | implemented | TL |';
    let body = proposalWithLedgerTable(transform(table));
    if (reason === 'requirement-ledger-inert-only') {
      body = body.replace('## Requirement Ledger', '<!--\n## Requirement Ledger')
        .replace('\n\n## Section 3: Tasks', '\n-->\n\n## Section 3: Tasks');
      assert.match(body, /<!--\n## Requirement Ledger[\s\S]*\n-->\n\n## Section 3: Tasks/);
    }
    const name = `2026-10-12-ledger-structural-${reason.length}`;
    const dir = setupFixture({ archives: [{ name, proposalContent: body }] });
    try {
      const r = run(dir, { DEVPRO_RELEVANT_ARCHIVES: name });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /Pre-PR archive gate \(m\)/);
      assert.match(r.stderr, new RegExp(': ' + reason + ';'));
      assert.match(r.stderr, diagnostic);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

if (archiveGateTestIndex !== ARCHIVE_GATE_TEST_GROUP_RANGE_END) {
  throw new Error(
    `pre-pr-archive-gate grouped ${archiveGateTestIndex} tests, expected ${ARCHIVE_GATE_TEST_GROUP_RANGE_END}`,
  );
}
