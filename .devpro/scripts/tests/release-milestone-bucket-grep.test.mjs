/**
 * release-milestone-bucket-grep.test.mjs
 *
 * Asserts the "release bucket milestone" contract introduced by the
 * strengthen-release-milestone-bucket change across its carriers:
 *   - release-sit-uat-pat-prod.md   (T1: SSOT + Overview pointer)
 *   - release-step-1-7.md           (T2/T3: candidate query + unassigned + superset)
 *   - git-branch-naming-and-anchor.md (T4: why the target round stays out of branch names)
 *   - git-pr-template-and-merge.md / .github/PULL_REQUEST_TEMPLATE.md (T5/T6: warn-only field)
 *   - consumer-local-rules.md       (T7: additive overlay allowance)
 *   - ci-setup-components.md        (T8: optional consumer-owned component + trigger scoping)
 *   - program-tracker-mode.md       (T9: pointer from program-shaped milestone view)
 *   - release-runbook/SKILL.md   (T10: Step 1 subset-handoff pointer)
 *
 * It also names every new scenario title so
 * lint-delta-new-scenario-assertion-coverage has an asserting carrier, and
 * binds them to a spec carrier (active delta before archive, canonical spec
 * after archive promotion) rather than asserting nothing.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read, readRepoFileIfExists } from './lib/read.mjs';

const releaseFlow = read('.devpro/agent-rules/release-sit-uat-pat-prod.md');
const releaseSteps = read('.devpro/agent-rules/release-step-1-7.md');
const branchRule = read('.devpro/agent-rules/git-branch-naming-and-anchor.md');
const gitPrFlow = read('.devpro/agent-rules/git-pr-template-and-merge.md');
const prTemplate = read('.github/PULL_REQUEST_TEMPLATE.md');
const consumerLocal = read('.devpro/agent-rules/consumer-local-rules.md');
const ciComponents = read('.devpro/agent-rules/ci-setup-components.md');
const trackerMode = read('.devpro/agent-rules/program-tracker-mode.md');
const runbookSkill = read('.devpro/agent-skills/release/release-runbook/SKILL.md');

function lineContaining(text, ...needles) {
  return text.split('\n').find((line) => needles.every((needle) => line.includes(needle))) ?? '';
}

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const from = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, from) : -1;
  return end >= 0 ? text.slice(start, end) : text.slice(start);
}

// `new RegExp` (not a regex literal) keeps the backtick delimiters inside a
// quoted string: the shard-discovery comment-span scanner does not lex regex
// literals, so a literal here would leave an odd backtick count in code and
// make this file a scanner residual (cf. clarify-asrpadc-done-when-overclaim).
const INLINE_COMMAND_RE = new RegExp('`(gh pr list[^`]*)`');

/**
 * Extract the inline `gh pr list ...` command span from a bullet line.
 *
 * Assertions MUST bind to this span, not to the surrounding prose: the prose
 * also names `--limit` / `no:milestone`, so a prose-level `includes` check
 * would stay green even if the executable command lost the flag.
 */
function inlineCommand(line) {
  const match = line.match(INLINE_COMMAND_RE);
  return match ? match[1] : '';
}

// Active change delta before archive, canonical spec after archive promotion.
const SPEC_CARRIERS = [
  'openspec/specs/openspec-flow/spec.md',
  'openspec/specs/consumer-adoption-tooling/spec.md',
  'openspec/changes/strengthen-release-milestone-bucket/specs/openspec-flow/spec.md',
  'openspec/changes/strengthen-release-milestone-bucket/specs/consumer-adoption-tooling/spec.md',
]
  .map(readRepoFileIfExists)
  .filter(Boolean)
  .join('\n');

const RELEASE_MILESTONE_REQUIREMENTS = [
  'Promotable Unit Release Round Milestone',
  'Release Candidate Query By Milestone',
  'Parallel Release Rounds Superset Ordering',
  'Release Target Human-Readable PR Field',
  'Release Bucket Milestone Is Not Encoded In Branch Names',
  'Consumer Milestone Requirement Is An Additive Overlay',
  'Optional Release Milestone CI Component',
];

const RELEASE_MILESTONE_SCENARIOS = [
  'PR carries the earliest target round milestone',
  'Reschedule changes only the milestone',
  'A unit is never double-labelled across parallel rounds',
  'Current-round candidate list is produced by the milestone query',
  'Unassigned merged PRs are listed separately for TL adjudication',
  'Later round is a superset of the previous round',
  'Release target field is warn-only and sync-preserved',
  'Release target is absent from the branch name',
  'Overlay requiring a milestone is additive and does not relax source gates',
  'Missing milestone fails for promotable PRs into main',
  'Other PR contexts are unaffected',
  'Source repo does not install the workflow',
];

test('T1 release flow carries the release bucket milestone SSOT and an Overview pointer', () => {
  const ssotLine = lineContaining(releaseFlow, 'Release bucket milestone');
  assert.ok(ssotLine, 'release-sit-uat-pat-prod.md missing the Release bucket milestone SSOT paragraph');
  for (const literal of ['milestone: <YYYYMMDD>', '最早目標輪', 'unassigned', 'approved subset']) {
    assert.ok(ssotLine.includes(literal), `milestone SSOT paragraph missing literal: ${literal}`);
  }
  assert.match(
    ssotLine,
    /MUST 只掛一個 milestone/,
    'SSOT paragraph must state a unit carries exactly one (earliest) milestone',
  );
  assert.ok(
    (releaseFlow.match(/milestone:/g) ?? []).length >= 1,
    'release flow must record the milestone: <YYYYMMDD> token at least once',
  );
  const overviewPointer = lineContaining(releaseFlow, '可促進單位的最早目標 release 輪次以 GitHub milestone');
  assert.ok(overviewPointer, 'Overview/Branch-roles region must point readers at the milestone SSOT');
  assert.ok(
    overviewPointer.includes('Subset selection handoff'),
    'Overview pointer must name the §Subset selection handoff SSOT',
  );
});

test('T2 Step 1 exposes a complete (undated) candidate query and an unassigned label', () => {
  // strengthen-release-milestone-branch-consistency (#2807 follow-up): the
  // date-bounded `merged:>=` query was replaced by production-tag ancestry,
  // because a date bound permanently drops units merged before the anchor
  // but not selected into that release.
  const step1 = sliceBetween(releaseSteps, '**Step 1：', '**Step 2：');
  const fenced = [...step1.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidateCmd = fenced.find((b) => b.includes('gh pr list --state all --base main'));
  assert.ok(candidateCmd, 'Step 1 must carry the executable candidate query in a fenced block');
  for (const field of ['headRefName', 'headRefOid', 'mergeCommit', 'milestone', 'number']) {
    assert.ok(candidateCmd.includes(field), `candidate query must return field: ${field}`);
  }
  assert.ok(
    candidateCmd.includes('--limit "$LIMIT"') && candidateCmd.includes('jq length)" -lt "$LIMIT"'),
    'candidate command MUST set --limit and reject a result that reached the limit (silent truncation)',
  );
  for (const block of fenced) {
    // Strip shell comments: the prose-in-comment "不加任何 --search" is allowed; a live flag is not.
    const code = block.replace(/(^|\s)#.*$/gm, '$1');
    assert.ok(!code.includes('merged:>='), 'Step 1 commands MUST NOT be bounded by a merge date');
    assert.ok(!/--search\b/.test(code), 'Step 1 commands MUST NOT narrow the query with --search');
  }
  // strengthen-release-milestone-branch-consistency review r1 (F-rmbc-pr1-01):
  // a unit-tip-only ancestry check misjudges squash/rebase-merged units as
  // forever unreleased. Replaced by unit_released(), which also checks the
  // merge commit; see release-step1-unit-released-fixture.test.mjs.
  assert.ok(
    fenced.some((b) => b.trimStart().startsWith('# unit_released: 已上線判定（Step 1 SSOT）') && b.includes('git merge-base --is-ancestor')),
    'Step 1 must decide "not yet released" via the unit_released function (unit tip OR unit merge commit ancestry against the anchor)',
  );

  const unassignedLine = lineContaining(step1, '`unassigned`', '指派');
  assert.ok(unassignedLine, 'Step 1 must label all-null branches unassigned and gate them on TL assignment');
});

test('T3 Step 2 states the parallel-round superset ordering', () => {
  const step2 = sliceBetween(releaseSteps, '**Step 2：', '**Step 3：');
  const supersetLine = lineContaining(step2, 'superset');
  assert.ok(supersetLine, 'Step 2 must state the parallel-round superset ordering');
  assert.ok(
    supersetLine.includes('只標最早目標輪'),
    'superset line must state a unit is only labelled with its earliest target round',
  );
});

test('T4 branch naming rule explains why the target round is not encoded in branch names', () => {
  const line = lineContaining(branchRule, '目標輪', 'shortSHA', 'change 名');
  assert.ok(line, 'branch naming rule must explain the target-round-excluded-from-branch-name reason');
  assert.match(line, /MUST NOT 編碼進分支名/, 'branch rule must forbid encoding the target round in the branch name');
});

test('T5 PR rule template carries the warn-only Release Target field and its conditional entry', () => {
  const templateLine = lineContaining(gitPrFlow, 'Release Target: <YYYYMMDD>', 'warn-only');
  assert.ok(templateLine, 'PR template block must carry Release Target as a warn-only field');
  const conditionalEntry = lineContaining(gitPrFlow, 'PR 帶 release 目標輪時', 'Release Target');
  assert.ok(conditionalEntry, 'conditional-fields prose must enumerate the Release Target field');
  assert.ok(conditionalEntry.includes('warn-only'), 'conditional entry must document warn-only body lint');
});

test('T6 synced PR template mirrors the warn-only Release Target field', () => {
  const line = lineContaining(prTemplate, 'Release Target', 'warn-only');
  assert.ok(line, '.github/PULL_REQUEST_TEMPLATE.md must carry the warn-only Release Target field');
});

test('T7 consumer-local-rules allows the milestone overlay additively only', () => {
  const line = lineContaining(consumerLocal, 'milestone', 'additive', 'source wins');
  assert.ok(line, 'consumer-local-rules must document the additive milestone overlay');
  assert.ok(
    /MUST NOT 放寬/.test(line),
    'milestone overlay must not relax any source gate',
  );
  assert.ok(/FAIL CLOSED/.test(line), 'ambiguous milestone overlay must fail closed');
});

test('T8 optional release-milestone component is registered, dispatched, and scoped', () => {
  assert.ok(
    lineContaining(ciComponents, '| `release-milestone` |'),
    'component registry must contain a release-milestone row',
  );
  const dispatchSection = sliceBetween(ciComponents, '### 帶參數：`/devpro:setup-ci release-milestone`', '\n### ');
  assert.ok(dispatchSection, 'dispatch rules must document /devpro:setup-ci release-milestone');
  assert.ok(dispatchSection.includes('feature/|bugfix/|chore/'), 'trigger must scope promotable head prefixes');
  assert.ok(dispatchSection.includes('main'), 'trigger must scope the main base branch');
  assert.ok(
    dispatchSection.includes('其他情境不受影響') || dispatchSection.includes('MUST NOT 受影響'),
    'dispatch must state that other PR contexts are unaffected',
  );
  assert.ok(
    dispatchSection.includes('source repo MUST NOT 安裝此 workflow'),
    'source repo MUST NOT install the release-milestone workflow',
  );
});

test('T9 program tracker points general changes at the release-target milestone contract', () => {
  const line = lineContaining(trackerMode, 'release-sit-uat-pat-prod.md', 'milestone');
  assert.ok(line, 'program-tracker-mode must point general changes at the milestone contract');
  assert.ok(line.includes('§Subset selection handoff'), 'pointer must name the SSOT section');
});

test('T10 release runbook SKILL points Step 1 subset handoff at the milestone query contract', () => {
  const step3 = sliceBetween(runbookSkill, '### 3. 執行 step-by-step recipe', '\n### ');
  assert.ok(step3.includes('milestone'), 'runbook Step 3 must reference the milestone query contract');
  // strengthen-release-milestone-branch-consistency review r1 (F-rmbc-pr1-04):
  // "milestone:<YYYYMMDD>" was a --search literal that contradicted the new
  // undated ancestry query; runbook now points at unit_released instead.
  assert.ok(
    step3.includes('無日期') && step3.includes('unit_released') && step3.includes('milestone 只用於四態標籤'),
    'runbook Step 3 must carry the undated-query/unit_released sentence, not the old milestone --search wording',
  );
  assert.ok(!step3.includes('milestone:<YYYYMMDD>'), 'runbook Step 3 MUST NOT carry the superseded --search literal');
  assert.ok(
    step3.includes('Subset selection handoff'),
    'runbook Step 3 must point at the §Subset selection handoff contract',
  );
});

test('spec deltas define every release-milestone requirement and scenario', () => {
  for (const title of RELEASE_MILESTONE_REQUIREMENTS) {
    assert.ok(
      SPEC_CARRIERS.includes(`### Requirement: ${title}`),
      `spec carriers missing requirement: ${title}`,
    );
  }
  for (const title of RELEASE_MILESTONE_SCENARIOS) {
    assert.ok(
      SPEC_CARRIERS.includes(`#### Scenario: ${title}`),
      `spec carriers missing scenario: ${title}`,
    );
  }
});

// Authoring guards: these assert the operative policy, not a live promotion.
test('Non-deployed unit targets production effective date', () => {
  const line = lineContaining(releaseFlow, '**非部署變更**');
  assert.match(line, /MUST.*預計進 `production` 生效日/u);
  assert.match(line, /未知.*`unassigned`.*Step 1/u);
  assert.match(line, /可隨業務同輪.*MUST NOT.*單獨 release/u);
  assert.match(releaseSteps, /ROUND=<YYYYMMDD>.*production.*生效日/u);
});

test('Consumer-owned governance files remain ordinary release units', () => {
  const rules = read('.devpro/agent-rules/release-rules-lane.md');
  const line = lineContaining(rules, '**Consumer 自有檔案**');
  assert.match(line, /`AGENTS\.local\.md`.*MUST.*一般 date lane/u);
  assert.match(line, /MUST NOT.*rules lane/u);
  assert.match(line, /milestone.*release-sit-uat-pat-prod.md/u);
  const flowLine = lineContaining(releaseFlow, '**非部署變更**');
  assert.match(flowLine, /MUST NOT 新增狀態或獨立 milestone 命名空間/u);
});

test('Production-effective milestone scenarios cover date and lane contracts', () => {
  const spec = read('openspec/specs/openspec-flow/spec.md');
  const date = sliceBetween(spec, '#### Scenario: Non-Deployed Unit Uses Production Effective Date', '#### Scenario: Consumer-Owned Governance Uses Ordinary Release Lane');
  assert.match(date, /MUST.*planned production-effective date/u);
  assert.match(date, /MUST remain `unassigned`/u);
  assert.doesNotMatch(date, /four-state|fifth selection state/u);
  assert.match(date, /MAY.*same approved subset.*MUST NOT.*separate release/u);
  const lane = sliceBetween(spec, '#### Scenario: Consumer-Owned Governance Uses Ordinary Release Lane', '### Requirement: Release Candidate Query By Milestone');
  assert.match(lane, /MUST.*ordinary date release lane/u);
  assert.match(lane, /MUST NOT.*rules lane/u);
  assert.match(lane, /MUST NOT.*milestone namespace/u);
  assert.match(lane, /MUST NOT.*any additional selection state/u);
});
