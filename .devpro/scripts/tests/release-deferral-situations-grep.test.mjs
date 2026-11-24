/**
 * release-deferral-situations-grep.test.mjs
 *
 * Asserts the release deferral situation table added by strengthen-release-deferral-situations
 * (rule-feedback #3331) across its carriers:
 *   - release-step-1-7.md             (T1-T5: Step 6 situation table + cross-repo sentence)
 *   - release-sit-uat-pat-prod.md / git-branch-naming-and-anchor.md / release-step-1-7.md Step 1
 *                                     (T6: pointers back to the table)
 *   - release-step-1-7.md anchors      (T7: referenced Step 2 / Step 3 anchors still exist)
 *   - openspec/specs/openspec-flow/spec.md (T8: requirement and scenario titles)
 *
 * Every table row is asserted as one physical line so deleting or splitting a row goes red.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';

const releaseSteps = read('.devpro/agent-rules/release-step-1-7.md');
const releaseFlow = read('.devpro/agent-rules/release-sit-uat-pat-prod.md');
const branchRule = read('.devpro/agent-rules/git-branch-naming-and-anchor.md');
const openspecFlowSpec = read('openspec/specs/openspec-flow/spec.md');

function lineContaining(text, ...needles) {
  return text.split('\n').find((line) => needles.every((needle) => line.includes(needle))) ?? '';
}

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing end marker: ${endMarker}`);
  return text.slice(start, end);
}

const section = sliceBetween(releaseSteps, '**延期情境**', '**上線前 checklist**');

function row(label) {
  const found = section.split('\n').find((line) => line.startsWith('|') && line.includes(label)) ?? '';
  assert.ok(found, `deferral table missing row: ${label}`);
  return found;
}

test('T1 deferral situation table sits inside Step 6 reschedule, after the ordinal-rename rule', () => {
  const rename = releaseSteps.indexOf('Rename Before Ordinal Tag');
  const table = releaseSteps.indexOf('**延期情境**');
  const checklist = releaseSteps.indexOf('**上線前 checklist**');
  assert.ok(rename >= 0 && table > rename && checklist > table, 'table must sit between the 改期 bullets and the checklist');
  assert.match(
    section,
    /只改 milestone、不因改期改名〔打 ordinal tag 前的改名仍依上方 Rename Before Ordinal Tag〕/,
    'table must restate that deferral changes only the milestone and keeps the ordinal rename exception',
  );
  assert.match(section, /\| 情境 \| milestone \| release 分支 \| 其他 \|/, 'table must keep its four-column header');
});

test('T2 whole-package deferral row: rename the original milestone only with TL approval, else branch by branch', () => {
  const line = row('整包延期');
  assert.match(line, /不存在 → 經 TL 同意 MAY 直接改原標題/, 'row must allow renaming the original milestone with TL approval');
  assert.match(line, /已存在 → 逐分支跑改齊指令/, 'row must fall back to the per-branch assignment procedure when the target exists');
  assert.match(line, /不因改期改名（ordinal 例外見上）/, 'row must not rename for the deferral but keep the ordinal exception');
  assert.doesNotMatch(line, /\| 不改名 \|/, 'row must not state an unconditional no-rename rule that contradicts Rename Before Ordinal Tag');
  assert.match(line, /上線日一併更新/, 'row must update hard-coded go-live dates in documents');
});

test('T3 single-requirement row before release cut: move the whole branch, leave release branches alone', () => {
  const line = row('未進 `release/*`');
  assert.match(line, /未進 `release\/\*`（各 MERGED PR 皆未含入）/, 'row must require that none of the MERGED PRs is in a release');
  assert.match(line, /全部 MERGED＋OPEN PR 以改齊指令改掛後一梯次/, 'row must move every MERGED and OPEN PR with the assignment procedure');
  assert.match(line, /不動/, 'row must leave release branches untouched');
});

test('T4 single-requirement row after release cut: stop and ask the TL, then rebuild on any HEAD or tree change', () => {
  const line = row('已進 `release/*`');
  assert.match(line, /MUST 停下問 TL/, 'row must stop and ask the TL');
  assert.match(line, /優先從 anchor 重開 new assembly/, 'row must prefer a fresh assembly from the anchor');
  assert.match(line, /release-only patch，須 TL 核准/, 'row must treat a revert on the release as an unapproved release-only patch');
  assert.match(line, /release-hotfix-carrier-lane\.md/, 'row must route an already-promoted unit to the hotfix carrier lane');
  assert.match(line, /版本效力[^\n]*重 Build once[^\n]*重驗/, 'row must repeat Build once and SIT/UAT after HEAD or tree changes');
  assert.match(line, /已進 `release\/\*`（任一 MERGED PR 已含入，含只進較早 PR）/, 'row must count a branch as already in a release when any MERGED PR is contained');
  assert.match(
    line,
    /改齊指令末段只查最新 tip，須另逐筆查各 MERGED PR 的 `headRefOid` 是否在 `origin\/release\/\*`/,
    'row must not rely on the recut reminder alone, which checks only the latest tip',
  );
});

test('T5 cross-repo same-version units are deferred as one group', () => {
  assert.match(
    section,
    /跨 repo 同版上線單位延期時 MUST 整組改掛同一梯次，不得只移其中一個 repo/,
    'section must require moving cross-repo same-version units together',
  );
});

test('T6 existing deferral sentences point back at the situation table', () => {
  const ssot = lineContaining(releaseFlow, 'Release bucket milestone');
  assert.ok(ssot.includes('Step 6 改期'), 'release bucket milestone SSOT must point at Step 6 改期');
  for (const literal of ['milestone: <YYYYMMDD>', '最早目標輪', 'unassigned', 'approved subset', 'MUST 只掛一個 milestone']) {
    assert.ok(ssot.includes(literal), `pointer must keep the locked literal on the same line: ${literal}`);
  }
  const naming = lineContaining(branchRule, '目標輪不進分支名', 'MUST NOT 編碼進分支名');
  assert.ok(naming.includes('Step 6 改期'), 'branch naming rule must point at Step 6 改期');
  const contract = lineContaining(releaseSteps, '掛載契約', '延期只改 milestone');
  assert.ok(contract.includes('Step 6 改期'), 'Step 1 mounting contract must point at Step 6 改期');
});

test('T7 the table references anchors and leaves that still exist', () => {
  assert.ok(releaseSteps.includes('**不變式**'), 'Step 2 invariant (release-only patch) anchor must exist');
  assert.ok(releaseSteps.includes('**版本效力**'), 'Step 3 version-effect anchor must exist');
  assert.ok(read('.devpro/agent-rules/release-milestone-assignment.md').includes('Branch-Level Milestone Assignment With Read-Back'));
  assert.ok(read('.devpro/agent-rules/release-hotfix-carrier-lane.md').includes('Hotfix release-carrier lane'));
});

const DEFERRAL_REQUIREMENT = 'Release Deferral Situations Are Classified Before Rescheduling';
const DEFERRAL_SCENARIOS = [
  'Whole-package deferral renames the original milestone when the target does not exist',
  'Whole-package deferral onto an occupied go-live day keeps the ordinal rename',
  'Whole-package deferral with an existing target milestone moves branch by branch',
  'Single-requirement deferral before release cut moves the branch milestone only',
  'Single-requirement deferral after release cut stops for the tech lead',
  'Single-requirement deferral after only an earlier pull request entered a release stops for the tech lead',
  'Cross-repo same-version units are deferred as a group',
];

test('T8 canonical openspec-flow spec defines the deferral requirement and every scenario', () => {
  assert.ok(openspecFlowSpec.includes(`### Requirement: ${DEFERRAL_REQUIREMENT}`), 'spec missing deferral requirement');
  for (const title of DEFERRAL_SCENARIOS) {
    assert.ok(openspecFlowSpec.includes(`#### Scenario: ${title}`), `spec missing scenario: ${title}`);
  }
  const body = sliceBetween(openspecFlowSpec, `### Requirement: ${DEFERRAL_REQUIREMENT}`, '### Requirement: Release Candidate Branch Health Check');
  assert.match(body, /MUST NOT revert, re-cut or rebuild on its own/, 'spec must forbid acting on a released unit without the TL');
  assert.match(body, /SHALL be moved to the same round as one group/, 'spec must require group deferral for cross-repo units');
  assert.match(
    body,
    /SHALL NOT be renamed for the deferral itself, and the rename that Step 6 requires before an ordinal production tag \(`Rename Before Ordinal Tag`\) SHALL stay in force/,
    'spec must keep the ordinal rename exception next to the no-rename rule',
  );
  assert.doesNotMatch(body, /release branch names SHALL NOT change/, 'spec must not carry an unconditional no-rename rule');
  assert.match(
    body,
    /the head of any `MERGED` pull request of that branch, not only the latest unit tip, is already contained in a cut `origin\/release\/\*`/,
    'spec must classify a branch as already released when any MERGED pull request head is contained',
  );
  assert.doesNotMatch(body, /its unit tip is (?:already contained in|in no) /, 'spec must not classify by the latest unit tip alone');
});
