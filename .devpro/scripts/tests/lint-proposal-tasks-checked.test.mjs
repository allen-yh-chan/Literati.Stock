import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lintProposalTasksChecked,
  extractTasksSection,
  hasDeferredSection,
  splitTaskBlocks,
  checkEvidenceAnchor,
  detectNearMissTasksHeading,
  findSiblingUncheckedOutsideTasks,
} from '../lint-proposal-tasks-checked.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-proposal-tasks-checked.mjs');

/**
 * Build a change folder under a tmp dir with the given file contents.
 * @param {{proposal?: string, proposalMini?: string, tasks?: string, extraFile?: string}} opts
 * @returns {{root: string, changeFolder: string}}
 */
function buildFixture({ proposal, proposalMini, tasks, extraFile } = {}) {
  const root = join(tmpdir(), `lint-ptc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const changeFolder = join(root, 'openspec', 'changes', 'test-change');
  mkdirSync(changeFolder, { recursive: true });
  if (proposal !== undefined) writeFileSync(join(changeFolder, 'proposal.md'), proposal, 'utf8');
  if (proposalMini !== undefined) writeFileSync(join(changeFolder, 'proposal-mini.md'), proposalMini, 'utf8');
  if (tasks !== undefined) writeFileSync(join(changeFolder, 'tasks.md'), tasks, 'utf8');
  if (extraFile !== undefined) writeFileSync(join(changeFolder, 'README.md'), extraFile, 'utf8');
  return { root, changeFolder };
}

function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function runCli(changeFolder) {
  return spawnSync('node', [SCRIPT, changeFolder], { encoding: 'utf8' });
}

describe('lintProposalTasksChecked — pass paths', () => {
  test('all tasks [x] with [Req] + 驗收 line → pass', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:test 綠\n- [x] Task 2 — bar [Req: R2]\n  - 驗收:file exists\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true, JSON.stringify(r.violations));
      assert.equal(r.violations.length, 0);
    } finally { cleanup(root); }
  });

  test('unchecked task authorized by ## Deferred section → pass', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:later\n## Deferred\n- Task 1 deferred: upstream blocked\n',
    });
    try {
      assert.equal(lintProposalTasksChecked({ changeFolder }).pass, true);
    } finally { cleanup(root); }
  });

  test('no ## Tasks section → graceful pass', () => {
    const { root, changeFolder } = buildFixture({ proposalMini: '# c\n## Why\nnothing\n' });
    try {
      assert.equal(lintProposalTasksChecked({ changeFolder }).pass, true);
    } finally { cleanup(root); }
  });

  test('chore-A style folder (no proposal/tasks file) → graceful pass', () => {
    const { root, changeFolder } = buildFixture({ extraFile: 'placeholder' });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true);
      assert.equal(r.checkedFile, null);
    } finally { cleanup(root); }
  });

  test('falls back to tasks.md when no proposal-mini.md', () => {
    const { root, changeFolder } = buildFixture({
      tasks: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true);
      assert.ok(r.checkedFile.endsWith('tasks.md'));
    } finally { cleanup(root); }
  });

  test('full change proposal pointer + tasks.md canonical ledger → pass', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Section 3: Tasks\nFull task ledger: [tasks.md](./tasks.md).\n',
      tasks: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true, JSON.stringify(r.violations));
      assert.ok(r.checkedFile.endsWith('tasks.md'));
    } finally { cleanup(root); }
  });

  test('checkbox outside proposal Tasks section is not treated as a duplicate ledger', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Checklist Example\n- [ ] illustrative checkbox\n## Section 3: Tasks\nSee tasks.md.\n',
      tasks: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      assert.equal(lintProposalTasksChecked({ changeFolder }).pass, true);
    } finally { cleanup(root); }
  });

  test('proposal-mini.md preferred over tasks.md when both present', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
      tasks: '# c\n## Tasks\n- [ ] Task 1 — unchecked\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true, 'should read proposal-mini (all checked), not tasks.md (unchecked)');
      assert.ok(r.checkedFile.endsWith('proposal-mini.md'));
    } finally { cleanup(root); }
  });
});

describe('lintProposalTasksChecked — fail paths (adversarial)', () => {
  test('full change checked proposal task duplicates tasks.md ledger → fail (duplicate-ledger)', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Section 3: Tasks\n- [x] Duplicate implementation task [Req: R1]\n',
      tasks: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'duplicate-ledger' && v.task.includes('Duplicate implementation task')));
    } finally { cleanup(root); }
  });

  test('full change unchecked proposal task duplicates tasks.md ledger → fail (duplicate-ledger)', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Tasks\n- [ ] Duplicate pending task [Req: R1]\n',
      tasks: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'duplicate-ledger'));
    } finally { cleanup(root); }
  });

  test('## Deferred does not authorize a duplicate proposal ledger', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Tasks\n- [ ] Duplicate deferred task [Req: R1]\n## Deferred\n- duplicate deferred\n',
      tasks: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'duplicate-ledger'));
    } finally { cleanup(root); }
  });

  test('task row within proposal ## Deferred still duplicates tasks.md ledger', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Tasks\nCanonical ledger: tasks.md.\n## Deferred\n- [ ] Duplicate deferred-area task [Req: R1]\n',
      tasks: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'duplicate-ledger' && v.task.includes('Duplicate deferred-area task')));
    } finally { cleanup(root); }
  });

  test('unchecked task without ## Deferred → fail (unchecked)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n- [ ] Task 2 — bar [Req: R2]\n  - 驗收:pending\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'unchecked'));
    } finally { cleanup(root); }
  });

  test('adversarial: flip a [x] to [ ] → fail', () => {
    const good = '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n';
    const bad = good.replace('- [x]', '- [ ]');
    const { root, changeFolder } = buildFixture({ proposalMini: bad });
    try {
      assert.equal(lintProposalTasksChecked({ changeFolder }).pass, false);
    } finally { cleanup(root); }
  });

  test('checked [x] missing [Req: R#] anchor → fail (no-req)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo\n  - 驗收:done\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'no-req'));
    } finally { cleanup(root); }
  });

  test('adversarial: strip the 驗收 evidence line → fail (no-acceptance)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 做什麼:something\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'no-acceptance'));
    } finally { cleanup(root); }
  });

  test('bare [x] with neither anchor → both no-req and no-acceptance', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — bare\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      assert.ok(r.violations.some(v => v.kind === 'no-req'));
      assert.ok(r.violations.some(v => v.kind === 'no-acceptance'));
    } finally { cleanup(root); }
  });
});

describe('lintProposalTasksChecked — CLI exit codes', () => {
  test('CLI exit 0 on pass', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      assert.equal(runCli(changeFolder).status, 0);
    } finally { cleanup(root); }
  });

  test('CLI exit 1 on fail with stderr detail', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /lint-proposal-tasks-checked/);
    } finally { cleanup(root); }
  });

  test('CLI duplicate-ledger error explains the single-ledger remediation', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# c\n## Tasks\n- [x] Duplicate task [Req: R1]\n',
      tasks: '# c\n## Tasks\n- [x] Canonical task [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /duplicate-ledger/);
      assert.match(res.stderr, /proposal\.md is not an executable task ledger/);
      assert.match(res.stderr, /tasks\.md/);
      assert.match(res.stderr, /pointer|summary/);
    } finally { cleanup(root); }
  });

  test('CLI exit 1 on missing change folder', () => {
    const res = runCli(join(tmpdir(), 'does-not-exist-' + Math.random().toString(36).slice(2)));
    assert.equal(res.status, 1);
  });

  test('CLI fails closed when an existing proposal carrier cannot be read for requirement coverage', () => {
    const { root, changeFolder } = buildFixture({
      tasks: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    mkdirSync(join(changeFolder, 'proposal.md'));
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /coverage-read-error/);
      assert.match(res.stderr, /proposal\.md/);
    } finally { cleanup(root); }
  });

  test('CLI fails closed when the resolved task carrier cannot be read for requirement coverage', () => {
    const { root, changeFolder } = buildFixture({
      proposal:
        '# c\n## Requirement Ledger\n' +
        '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
        '|---|---|---|---|---|---|\n' +
        '| R1 | root | root | current | implemented | this PR |\n' +
        '## Tasks\nSee tasks.md.\n',
    });
    mkdirSync(join(changeFolder, 'tasks.md'));
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /coverage-read-error/);
      assert.match(res.stderr, /tasks\.md/);
    } finally { cleanup(root); }
  });

  test('CLI fails closed on an unreadable task carrier even when no proposal carrier exists', () => {
    const { root, changeFolder } = buildFixture();
    mkdirSync(join(changeFolder, 'tasks.md'));
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /coverage-read-error/);
      assert.match(res.stderr, /tasks\.md/);
    } finally { cleanup(root); }
  });

  test('CLI fails closed on an unreadable task carrier even when the proposal has no Requirement Ledger', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# proposal\n\n## Why\n\nbecause\n',
    });
    mkdirSync(join(changeFolder, 'tasks.md'));
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /coverage-read-error/);
      assert.match(res.stderr, /tasks\.md/);
    } finally { cleanup(root); }
  });

  test('CLI fails closed on an unreadable task carrier even when the Requirement Ledger table is malformed', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# proposal\n\n## Requirement Ledger\n\n- R1: implemented\n\n## Next\n\nx\n',
    });
    mkdirSync(join(changeFolder, 'tasks.md'));
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /coverage-read-error/);
      assert.match(res.stderr, /tasks\.md/);
    } finally { cleanup(root); }
  });
});

describe('helper units', () => {
  test('extractTasksSection stops at next ## heading', () => {
    const body = extractTasksSection('# c\n## Tasks\n- [x] a [Req: R1]\n  - 驗收:x\n## Next\nother\n');
    assert.ok(body.includes('- [x] a'));
    assert.ok(!body.includes('other'));
  });

  test('extractTasksSection returns null when no ## Tasks', () => {
    assert.equal(extractTasksSection('# c\n## Why\nx\n'), null);
  });

  test('extractTasksSection tolerates trailing text on heading (## Tasks (6))', () => {
    const body = extractTasksSection('## Tasks (6)\n- [x] a [Req: R1]\n');
    assert.ok(body.includes('- [x] a'));
  });

  test('extractTasksSection matches template-form "## Section 3: Tasks" (D2 root fix)', () => {
    const body = extractTasksSection('## Section 3: Tasks\n- [x] a [Req: R1]\n  - 驗收:x\n');
    assert.ok(body !== null, 'template-form heading must be recognized as canonical, not silently skipped');
    assert.ok(body.includes('- [x] a'));
  });

  test('extractTasksSection matches template-form with trailing text "## Section 3: Tasks (6)"', () => {
    const body = extractTasksSection('## Section 3: Tasks (6)\n- [x] a [Req: R1]\n');
    assert.ok(body !== null);
    assert.ok(body.includes('- [x] a'));
  });

  test('extractTasksSection matches numbered template-form "## 3. Tasks"', () => {
    const body = extractTasksSection('## 3. Tasks\n- [x] a [Req: R1]\n  - 驗收:x\n');
    assert.ok(body !== null);
    assert.ok(body.includes('- [x] a'));
  });

  test('extractTasksSection matches numbered template-form with trailing text "## 3. Tasks (6)"', () => {
    const body = extractTasksSection('## 3. Tasks (6)\n- [x] a [Req: R1]\n  - 驗收:x\n');
    assert.ok(body !== null);
    assert.ok(body.includes('- [x] a'));
  });

  test('extractTasksSection accepts trailing whitespace on canonical Tasks headings', () => {
    assert.ok(extractTasksSection('## Tasks   \n- [x] a [Req: R1]\n  - 驗收:x\n') !== null);
    assert.ok(extractTasksSection('## 3. Tasks   \n- [x] a [Req: R1]\n  - 驗收:x\n') !== null);
    assert.ok(extractTasksSection('## Section 3: Tasks   \n- [x] a [Req: R1]\n  - 驗收:x\n') !== null);
  });

  test('extractTasksSection does not match non-canonical near-miss headings', () => {
    assert.equal(extractTasksSection('### Tasks\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## Sub Tasks\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## Task List\n- [ ] a\n'), null);
  });

  test('extractTasksSection rejects Tasks headings with trailing words or suffixes', () => {
    assert.equal(extractTasksSection('## 3. Tasks and Timeline\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## 3. Tasks (6) and Timeline\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## 3. Tasks2\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## Section 3: Tasks and Timeline\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## Section 3: Tasks (6) and Timeline\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## Section 3: Tasks2\n- [ ] a\n'), null);
  });

  test('hasDeferredSection detects ## Deferred', () => {
    assert.equal(hasDeferredSection('## Tasks\n- [ ] a\n## Deferred\n- x\n'), true);
    assert.equal(hasDeferredSection('## Tasks\n- [ ] a\n'), false);
  });

  test('splitTaskBlocks folds indented sub-bullets into enclosing task, ignores indented checkboxes', () => {
    const blocks = splitTaskBlocks('- [x] Task 1 [Req: R1]\n  - 驗收:x\n  - [x] sub item (not a task)\n- [ ] Task 2\n');
    assert.equal(blocks.length, 2, 'indented checkbox must not count as a top-level task');
    assert.equal(blocks[0].checked, true);
    assert.ok(blocks[0].block.includes('sub item'));
    assert.equal(blocks[1].checked, false);
  });

  test('checkEvidenceAnchor detects [Req: R#] and 驗收', () => {
    assert.deepEqual(checkEvidenceAnchor('- [x] a [Req: R1]\n  - 驗收:x'), { hasReq: true, hasAcceptance: true });
    assert.deepEqual(checkEvidenceAnchor('- [x] a\n  - 驗收:x'), { hasReq: false, hasAcceptance: true });
    assert.deepEqual(checkEvidenceAnchor('- [x] a [Req: R1]\n  - 做什麼:x'), { hasReq: true, hasAcceptance: false });
  });

  test('checkEvidenceAnchor accepts multi-ID [Req: R1, R2] and acceptance alias', () => {
    assert.deepEqual(checkEvidenceAnchor('- [x] a [Req: R1, R2]\n  - acceptance: ok'), { hasReq: true, hasAcceptance: true });
  });

  test('detectNearMissTasksHeading flags genuinely non-canonical headings that mention "tasks"', () => {
    assert.equal(detectNearMissTasksHeading('### Tasks\n'), '### Tasks');
    assert.equal(detectNearMissTasksHeading('#### Sub Tasks\n'), '#### Sub Tasks');
    assert.equal(detectNearMissTasksHeading('## Sub Tasks\n- [x] a\n'), '## Sub Tasks');
  });

  test('detectNearMissTasksHeading does not flag canonical ## Tasks headings', () => {
    assert.equal(detectNearMissTasksHeading('## Tasks\n- [x] a\n'), null);
    assert.equal(detectNearMissTasksHeading('## Tasks (6)\n'), null);
  });

  test('detectNearMissTasksHeading does not flag template-form headings (D2: not a near-miss, it IS canonical)', () => {
    assert.equal(detectNearMissTasksHeading('## Section 3: Tasks\n- [x] a\n'), null);
    assert.equal(detectNearMissTasksHeading('## Section 3: Tasks (6)\n'), null);
    assert.equal(detectNearMissTasksHeading('## 3. Tasks\n- [x] a\n'), null);
  });

  test('detectNearMissTasksHeading flags template-form Tasks headings with trailing words', () => {
    assert.equal(detectNearMissTasksHeading('## 3. Tasks and Timeline\n- [x] a\n'), '## 3. Tasks and Timeline');
    assert.equal(detectNearMissTasksHeading('## 3. Tasks (6) and Timeline\n- [x] a\n'), '## 3. Tasks (6) and Timeline');
    assert.equal(detectNearMissTasksHeading('## Section 3: Tasks and Timeline\n- [x] a\n'), '## Section 3: Tasks and Timeline');
    assert.equal(detectNearMissTasksHeading('## Section 3: Tasks (6) and Timeline\n- [x] a\n'), '## Section 3: Tasks (6) and Timeline');
  });

  test('detectNearMissTasksHeading returns null when no heading mentions tasks', () => {
    assert.equal(detectNearMissTasksHeading('## Why\nx\n'), null);
  });
});

describe('lint-proposal-tasks-checked — template-form Tasks heading now genuinely checked (D2 root fix)', () => {
  test('template-form heading with an unchecked task → CLI fails (blocking, not silently skipped)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Section 3: Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1, 'template-form Tasks section must be genuinely checked, not graceful-passed');
      assert.match(res.stderr, /unchecked/);
    } finally { cleanup(root); }
  });

  test('template-form heading, fully checked with evidence → pass and no WARNING noise', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Section 3: Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 0);
      assert.doesNotMatch(res.stdout, /WARNING/, 'template-form heading is canonical — must not be flagged as near-miss');
    } finally { cleanup(root); }
  });

  test('canonical ## Tasks heading (fully checked, evidenced) → no WARNING noise', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 0);
      assert.doesNotMatch(res.stdout, /WARNING/);
    } finally { cleanup(root); }
  });
});

describe('lint-proposal-tasks-checked — full-width parenthesis canonical heading (T1/T2, R2)', () => {
  test('T1 prove-it: full-width-parenthesis heading "## Tasks（含委派計畫）" with an unchecked task → CLI exit 1', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks（含委派計畫）\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1, 'full-width-parenthesis canonical heading must be genuinely audited, not silently graceful-passed');
    } finally { cleanup(root); }
  });

  test('T2 reverse-lock: full-width-parenthesis heading, fully checked with [Req: R#] + 驗收 evidence → exit 0 ("start auditing", not "always block")', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks（含委派計畫）\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      assert.equal(runCli(changeFolder).status, 0);
    } finally { cleanup(root); }
  });

  test('T2 reverse-lock: "## Tasks and Timeline" (non-canonical, openspec-flow spec case) still NOT canonical', () => {
    assert.equal(extractTasksSection('## Tasks and Timeline\n- [ ] a\n'), null);
    assert.equal(extractTasksSection('## 3. Tasks and Timeline\n- [ ] a\n'), null);
  });
});

describe('lint-proposal-tasks-checked — ledger evidence exists but heading is not canonical (T3/T4, R1)', () => {
  test('(i) CLI: near-miss H1 heading + top-level checkbox, no ## Tasks H2 at all → exit 1', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# Tasks: test-change\n\nSome intro text.\n\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1, 'ledger evidence (a top-level checkbox) exists even though the only heading mentioning "tasks" is a near-miss, not canonical — must hard-fail, not silently pass with only a WARNING');
    } finally { cleanup(root); }
  });

  test('(ii) shared lintProposalTasksChecked() (the function check (o) also consumes): same near-miss shape → pass:false', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# Tasks: test-change\n\nSome intro text.\n\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false, 'shared pass boolean must flip so both the CLI and check (o) hard-fail with zero consumer-side code changes');
    } finally { cleanup(root); }
  });

  test('(iii) Family C: NO heading anywhere mentions "tasks", but a top-level checkbox exists → CLI exit 1, and NO WARNING noise at all', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## 1. RED / prove-it tests\nSome text.\n\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n## 2. Implementation\nmore text\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1, 'Family C shape: detectNearMissTasksHeading() itself returns null (no heading anywhere mentions "tasks"), yet the new violation must still fire — proves the predicate is orthogonal to near-miss detection, not layered on top of it');
      assert.doesNotMatch(res.stdout, /WARNING/, 'no heading mentions "tasks" at all, so there is no near-miss warning to print — this is the opposite of case (i), which still prints the near-miss warning');
    } finally { cleanup(root); }
  });

  test('violation message includes carrier path, actual (near-miss) heading text, and a canonical-shape explanation', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# Tasks: test-change\n\nSome intro text.\n\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      const knownTaskKinds = new Set(['unchecked', 'no-req', 'no-acceptance', 'duplicate-ledger']);
      const v = r.violations.find((x) => !knownTaskKinds.has(x.kind));
      assert.ok(v, 'expected a new violation kind for a non-canonical heading carrying ledger evidence');
      assert.ok((v.task + v.detail).includes(changeFolder) || (v.task + v.detail).includes('proposal-mini.md'), 'message must include the carrier file path');
      assert.match(v.detail, /Tasks: test-change/, 'message must include the actual heading text found');
      assert.match(v.detail, /canonical/i, 'message must include a canonical-shape explanation');
    } finally { cleanup(root); }
  });

  test('Family C violation message says no heading mentions "tasks" and does NOT reuse near-miss wording', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## 1. RED / prove-it tests\nSome text.\n\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n## 2. Implementation\nmore text\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false);
      const knownTaskKinds = new Set(['unchecked', 'no-req', 'no-acceptance', 'duplicate-ledger']);
      const v = r.violations.find((x) => !knownTaskKinds.has(x.kind));
      assert.ok(v);
      assert.match(v.detail, /no heading anywhere mentions .?tasks/i, 'Family C message must explicitly say no heading mentions "tasks"');
      assert.doesNotMatch(v.detail, /near-miss heading found/i, 'must not falsely claim a near-miss heading was found when detectNearMissTasksHeading() returned null');
    } finally { cleanup(root); }
  });
});

describe('lint-proposal-tasks-checked — reverse-lock: must stay green both before AND after the T4 fix', () => {
  test('reverse-lock A: near-miss heading with NO top-level checkbox → exit 0 + stdout carries WARNING: near-miss (unchanged)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# Tasks: test-change\n\nSome intro text, no checkbox at all.\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 0, 'no ledger evidence (no top-level checkbox) — the near-miss advisory path must survive untouched');
      assert.match(res.stdout, /WARNING: near-miss/);
    } finally { cleanup(root); }
  });

  test('reverse-lock B: Family B shape (H1 title + a legitimate ## Tasks H2, fully checked) → exit 0 (unchanged)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n',
    });
    try {
      assert.equal(runCli(changeFolder).status, 0);
    } finally { cleanup(root); }
  });

  test('reverse-lock C: carrier does not exist at all → graceful pass (unchanged)', () => {
    const { root, changeFolder } = buildFixture({ extraFile: 'placeholder' });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true);
      assert.equal(r.checkedFile, null);
    } finally { cleanup(root); }
  });
});

describe('lint-proposal-tasks-checked — genuinely non-canonical Tasks heading (advisory WARNING, D2)', () => {
  // T5 repoint (R1): these two fixtures previously asserted "non-canonical heading
  // must NOT flip exit code (D2: advisory only) → exit 0". Both fixtures ALSO
  // contain a top-level checkbox — which is exactly the ledger-evidence shape
  // R1/T4 now defines as a defect (see the "ledger evidence exists but heading is
  // not canonical" describe block above). Per brd.md §6, "existing tests must
  // stay green" means no unrelated regressions, not "preserve a previously-encoded
  // defective expectation" — so both are repointed from `exit 0` to `exit 1`. The
  // advisory-only (D2) coverage these two used to carry is replaced below by a
  // dedicated near-miss-heading-with-NO-checkbox fixture.
  test('non-canonical heading ("### Tasks") WITH a top-level checkbox → CLI exit 1 (T5: repointed, was exit 0)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n### Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1, 'a top-level checkbox is ledger evidence even under a near-miss heading — must hard-fail (R1)');
    } finally { cleanup(root); }
  });

  test('non-canonical heading ("## Sub Tasks") WITH a top-level checkbox → CLI exit 1 (T5: repointed, was exit 0)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n## Sub Tasks\n- [ ] Task 1 — foo [Req: R1]\n  - 驗收:pending\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 1);
    } finally { cleanup(root); }
  });

  // T5 advisory-only replacement coverage: same near-miss headings, but with NO
  // top-level checkbox — no ledger evidence, so the advisory-only (D2) path this
  // change does not touch must still exit 0 with the WARNING intact.
  test('non-canonical heading ("### Tasks") with NO top-level checkbox → CLI still exits 0, stdout carries WARNING (T5: advisory-only coverage carried forward)', () => {
    const { root, changeFolder } = buildFixture({
      proposalMini: '# c\n### Tasks\nJust prose, no checkbox at all.\n',
    });
    try {
      const res = runCli(changeFolder);
      assert.equal(res.status, 0, 'no ledger evidence (no top-level checkbox) — advisory-only path unaffected by R1');
      assert.match(res.stdout, /WARNING: near-miss/);
    } finally { cleanup(root); }
  });
});

describe('lint-proposal-tasks-checked — sibling unchecked escape (#1893)', () => {
  test('T1 prove-it: canonical Tasks all checked + sibling ## with top-level - [ ] → fail sibling-unchecked', () => {
    const { root, changeFolder } = buildFixture({
      tasks:
        '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n## 2. Validation\n- [ ] stray incomplete sibling work\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, false, 'sibling top-level unchecked must not silent-pass after canonical Tasks');
      assert.ok(
        r.violations.some((v) => v.kind === 'sibling-unchecked'),
        `expected sibling-unchecked, got ${JSON.stringify(r.violations)}`,
      );
    } finally { cleanup(root); }
  });

  test('T3 control: sibling only - [x] → pass', () => {
    const { root, changeFolder } = buildFixture({
      tasks:
        '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n## 2. Validation\n- [x] Done When evidence row\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true, JSON.stringify(r.violations));
      assert.equal(r.violations.some((v) => v.kind === 'sibling-unchecked'), false);
    } finally { cleanup(root); }
  });

  test('T3 control: Deferred body - [ ] with no other sibling unchecked → pass', () => {
    const { root, changeFolder } = buildFixture({
      tasks:
        '# c\n## Tasks\n- [x] Task 1 — foo [Req: R1]\n  - 驗收:done\n## Deferred\n- [ ] authorized deferred incomplete work\n',
    });
    try {
      const r = lintProposalTasksChecked({ changeFolder });
      assert.equal(r.pass, true, JSON.stringify(r.violations));
      assert.equal(r.violations.some((v) => v.kind === 'sibling-unchecked'), false);
    } finally { cleanup(root); }
  });

  test('findSiblingUncheckedOutsideTasks returns hits outside Tasks/Deferred only', () => {
    const content =
      '## Tasks\n- [ ] inside tasks (excluded)\n## Deferred\n- [ ] inside deferred (excluded)\n## Other\n- [ ] sibling hit\n  - [ ] indented ignored\n- [x] checked ignored\n';
    const hits = findSiblingUncheckedOutsideTasks(content);
    assert.equal(hits.length, 1);
    assert.match(hits[0].headingLine, /sibling hit/);
    assert.equal(hits[0].label.includes('sibling hit'), true);
  });
});


// ── Requirement Ledger <-> task coverage, wired at the CLI layer (R7) ────────
//
// fix-zero-value-review-rounds R7 / notes item `## 107.`: this comparison used
// to exist only inside `pre-pr-archive-gate.mjs` gate (m), which reads
// `openspec/changes/archive/<name>/` and therefore cannot run until the archive
// commit exists. These cases prove the same verdict is now available BEFORE
// archive from the active change folder.
//
// Every case asserts the CLI, not the exported function, and one asserts both:
// the exported `lintProposalTasksChecked` MUST stay silent about coverage,
// because archive gate check (o) re-runs it after archive where gate (m)
// already reports the violation (design.md D9). The verdict itself is unit-
// tested in requirement-task-coverage.test.mjs; what is proven here is the
// wiring and the timing.
describe('CLI layer — Requirement Ledger <-> task coverage (R7)', () => {
  const LEDGER_HEADER =
    '| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |\n' +
    '|---|---|---|---|---|---|\n';

  function proposalWith(rows) {
    return (
      '# proposal\n\n## Why\n\nbecause\n\n## Requirement Ledger\n\n' +
      LEDGER_HEADER +
      rows.map((r) => `| ${r.join(' | ')} |`).join('\n') +
      '\n\n## Section 3: Tasks\n\nSee tasks.md.\n'
    );
  }

  for (const [reason, transform] of [
    ['ambiguous-requirement-table', s => s.replace('\n\n## Section 3: Tasks', '\n\n' + LEDGER_HEADER + '| R2 | root | root | second | deferred | later |\n\n## Section 3: Tasks')],
    ['requirement-ledger-inert-only', s => s.replace('## Requirement Ledger', '<!--\n## Requirement Ledger').replace('\n\n## Section 3: Tasks', '\n-->\n\n## Section 3: Tasks')],
    ['malformed-requirement-row', s => s.replace('\n\n## Section 3: Tasks', '\n| R2 | broken row\n\n## Section 3: Tasks')],
  ]) {
    test(`coverage CLI refuses ${reason} from the shared reader`, () => {
      const { root, changeFolder } = buildFixture({
        proposal: transform(proposalWith([['R1', 'root', 'root', 'actual', 'implemented', 'TL']])),
        tasks: '## Tasks\n- [x] Actual [Req: R1]\n  - 驗收: green\n',
      });
      try {
        const r = runCli(changeFolder);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, new RegExp('\\] ' + reason + ':'));
      } finally { cleanup(root); }
    });
  }

  test('fenced example before the formal Ledger does not create uncovered tasks', () => {
    const example = proposalWith([['R9', 'root', 'root', 'example', 'implemented', 'TL']]);
    const actual = proposalWith([['R1', 'root', 'root', 'actual', 'implemented', 'TL']]);
    const { root, changeFolder } = buildFixture({
      proposal: `\`\`\`markdown\n${example}\n\`\`\`\n` + actual,
      tasks: '## Tasks\n- [x] Actual [Req: R1]\n  - 驗收: green\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 0, r.stderr);
    } finally { cleanup(root); }
  });

  test('duplicate formal Ledger headings are a named structural refusal before coverage', () => {
    const actual = proposalWith([['R1', 'root', 'root', 'actual', 'implemented', 'TL']]);
    const { root, changeFolder } = buildFixture({ proposal: actual + actual,
      tasks: '## Tasks\n- [x] Actual [Req: R1]\n  - 驗收: green\n' });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /duplicate-requirement-ledger/);
      assert.doesNotMatch(r.stderr.split('\n')[0], /ledger-row-uncovered|req-unknown-ledger-row/);
    } finally { cleanup(root); }
  });

  test('implemented row nothing claims → CLI exit 1 naming the row; the exported lint alone still passes', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([
        ['R1', 'root', 'root', 'current', 'implemented', 'this PR'],
        ['R2', 'root', 'root', 'current', 'implemented', 'this PR'],
      ]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n',
    });
    try {
      // The checkbox contract is satisfied; only coverage is not.
      assert.equal(lintProposalTasksChecked({ changeFolder }).pass, true);

      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /ledger-row-uncovered/);
      assert.match(r.stderr, /row 2 \(R2\)/, 'the author must be told WHICH row');
      assert.match(r.stderr, /tasks\.md/);
      assert.doesNotMatch(r.stderr, /row 1 \(R1\)/, 'the claimed row must not be reported');
    } finally { cleanup(root); }
  });

  test('a task ref with no ledger row → CLI exit 1', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([['R1', 'root', 'root', 'current', 'implemented', 'this PR']]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1, R9]\n  - 驗收: green\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /req-unknown-ledger-row/);
      assert.match(r.stderr, /\[Req: R9\]/);
    } finally { cleanup(root); }
  });

  test('a range ref → CLI exit 1 with exact-ID guidance', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([
        ['R1', 'root', 'root', 'current', 'implemented', 'this PR'],
        ['R2', 'root', 'root', 'current', 'implemented', 'this PR'],
      ]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1-R2]\n  - 驗收: green\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /req-range-ref/);
      assert.match(r.stderr, /\[Req: R1-R2\]/);
      assert.match(r.stderr, /exact Requirement Ledger IDs/);
    } finally { cleanup(root); }
  });

  // fix-session-pending-residual-gaps: a `partial` Disposition is the in-progress
  // state. Once every top-level task is checked it is stale unless the change
  // declares a `## Deferred` section, and nothing else catches it before review.
  test('a `partial` row left behind after every task is checked → CLI exit 1 naming the row; the exported lint alone stays silent', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([
        ['R1', 'root', 'root', 'current', 'partial', 'this PR'],
        ['R2', 'root', 'root', 'current', 'implemented', 'this PR'],
      ]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1] [Req: R2]\n  - 驗收: green\n',
    });
    try {
      assert.equal(lintProposalTasksChecked({ changeFolder }).pass, true);

      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      // The violation line itself, not the static Fix text that also names the kind.
      assert.match(r.stderr, /\] ledger-row-partial-after-complete: "row 1 \(R1\)"/, 'the author must be told WHICH row');
      assert.doesNotMatch(r.stderr, /ledger-row-partial-after-complete: "row 2/, 'the implemented row must not be reported');
    } finally { cleanup(root); }
  });

  test('a `partial` row is allowed only by a `## Deferred` line naming that exact ID plus a filled Owner / Next Step cell → CLI exit 0', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([['R1', 'root', 'root', 'current', 'partial', 'TL, issue #9']]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n\n## Deferred\n\n- R1 second half: owner TL, tracked in issue #9\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    } finally { cleanup(root); }
  });

  test('a `## Deferred` section that does not name the partial row exempts nothing (empty, or naming another ID) → CLI exit 1', () => {
    for (const deferred of ['\n## Deferred\n\n', '\n## Deferred\n\n- R2 later: owner TL, issue #9\n']) {
      const { root, changeFolder } = buildFixture({
        proposal: proposalWith([
          ['R1', 'root', 'root', 'current', 'partial', 'TL, issue #9'],
          ['R2', 'root', 'root', 'current', 'implemented', 'this PR'],
        ]),
        tasks: `# c\n## Tasks\n- [x] T1 — foo [Req: R1] [Req: R2]\n  - 驗收: green\n${deferred}`,
      });
      try {
        const r = runCli(changeFolder);
        assert.equal(r.status, 1, `expected exit 1 for ${JSON.stringify(deferred)}, got ${r.status}: ${r.stderr}`);
        assert.match(r.stderr, /\] ledger-row-partial-after-complete: "row 1 \(R1\)"[^\n]*no `## Deferred` line names R1/);
        assert.doesNotMatch(r.stderr, /ledger-row-partial-after-complete: "row 2/);
      } finally { cleanup(root); }
    }
  });

  test('a `## Deferred` line naming R10 does not satisfy R1 (whole-token ID match) → CLI exit 1', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([['R1', 'root', 'root', 'current', 'partial', 'TL, issue #9']]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n\n## Deferred\n\n- R10 later: owner TL, issue #9\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /\] ledger-row-partial-after-complete: "row 1 \(R1\)"/);
    } finally { cleanup(root); }
  });

  test('a `## Deferred` line naming the row still fails when the row\'s Owner / Next Step cell is empty → CLI exit 1', () => {
    for (const owner of ['', '—', 'N/A']) {
      const { root, changeFolder } = buildFixture({
        proposal: proposalWith([['R1', 'root', 'root', 'current', 'partial', owner]]),
        tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n\n## Deferred\n\n- R1 second half: tracked in issue #9\n',
      });
      try {
        const r = runCli(changeFolder);
        assert.equal(r.status, 1, `expected exit 1 for owner ${JSON.stringify(owner)}, got ${r.status}: ${r.stderr}`);
        assert.match(r.stderr, /\] ledger-row-partial-after-complete: "row 1 \(R1\)"[^\n]*its `Owner \/ Next Step` cell is empty/);
        assert.doesNotMatch(r.stderr, /no `## Deferred` line names R1/);
      } finally { cleanup(root); }
    }
  });

  test('a `partial` row while a task is still unchecked is not double-reported (the unchecked task is the failure)', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([['R1', 'root', 'root', 'current', 'partial', 'this PR']]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n- [ ] T2 — bar [Req: R1]\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /unchecked/);
      assert.doesNotMatch(r.stderr, /\] ledger-row-partial-after-complete: /);
    } finally { cleanup(root); }
  });

  test('deferred / rejected rows oblige nothing; every implemented row claimed → CLI exit 0', () => {
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([
        ['R1', 'root', 'root', 'current', 'implemented', 'this PR'],
        ['R2', 'root', 'root', 'current', 'deferred', 'issue #1'],
        ['R3', 'root', 'root', 'current', 'rejected', 'out of scope'],
      ]),
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    } finally { cleanup(root); }
  });

  test('implemented row with NO executable task carrier at all → still exit 1 (no inherited early return)', () => {
    // `lintProposalTasksChecked` returns a graceful pass when a change has no
    // task-ledger carrier (chore-A shape). Coverage is a question about the
    // PROPOSAL's ledger, so it must NOT inherit that early return: an
    // `implemented` row with no tasks anywhere is exactly the state to catch.
    // Mirroring gate (m), the proposal body is then the coverage body.
    const { root, changeFolder } = buildFixture({
      proposal: proposalWith([['R1', 'root', 'root', 'current', 'implemented', 'this PR']]),
    });
    try {
      const bare = lintProposalTasksChecked({ changeFolder });
      assert.equal(bare.pass, true);
      assert.equal(bare.checkedFile, null, 'no executable task-ledger carrier exists in this fixture');

      const r = runCli(changeFolder);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /row 1 \(R1\)/);
      assert.match(r.stderr, /proposal\/proposal-mini Tasks/);
    } finally { cleanup(root); }
  });

  test('a proposal claiming its rows inside its own Tasks section passes with no separate carrier', () => {
    const { root, changeFolder } = buildFixture({
      proposal:
        proposalWith([['R1', 'root', 'root', 'current', 'implemented', 'this PR']]).replace(
          'See tasks.md.',
          'Covered by [Req: R1].'
        ),
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    } finally { cleanup(root); }
  });

  test('no ## Requirement Ledger section → coverage stays silent (ledger SHAPE is gate (m)\'s question)', () => {
    // Bounded on purpose: a missing or unparseable ledger is a shape fault whose
    // diagnostics (with the canonical-ledger example) belong to gate (m). This
    // check moves the COVERAGE comparison earlier, not the whole ledger schema.
    const { root, changeFolder } = buildFixture({
      proposal: '# proposal\n\n## Why\n\nbecause\n',
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    } finally { cleanup(root); }
  });

  test('a bullet-list ledger has no parseable table → coverage stays silent, gate (m) still blocks it', () => {
    const { root, changeFolder } = buildFixture({
      proposal: '# proposal\n\n## Requirement Ledger\n\n- R1: implemented\n\n## Next\n\nx\n',
      tasks: '# c\n## Tasks\n- [x] T1 — foo [Req: R1]\n  - 驗收: green\n',
    });
    try {
      const r = runCli(changeFolder);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    } finally { cleanup(root); }
  });
});
