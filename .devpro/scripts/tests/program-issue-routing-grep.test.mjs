import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { sourcePath } from './lib/source-root.mjs';
import { readSourceFile as read } from './lib/read.mjs';
import { readChangeSkillFullReadingOrder } from './lib/change-skill.mjs';



function readIfExists(rel) {
  const file = sourcePath(rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const consumerFlow = read('.devpro/agent-rules/openspec-flow-consumer.md');
const programTrackerMode = read('.devpro/agent-rules/program-tracker-mode.md');
const consumerAdoption = read('.devpro/agent-rules/consumer-adoption.md');
const openspecFlow = read('.devpro/agent-rules/openspec-flow.md');
const openspecSteps = read('.devpro/agent-rules/openspec-step-1-to-9.md');
// Full-rigor reading order: SKILL.md plus the moved 第四步～第六步 / 委派計畫 sections.
const changeCommand = readChangeSkillFullReadingOrder();
const agentsMd = read('AGENTS.md');
const canonicalSpec = read('openspec/specs/openspec-flow/spec.md');
const activeProgramIssueDelta = readIfExists(
  'openspec/changes/strengthen-program-issue-tracking/specs/openspec-flow/spec.md',
);
const programIssueSpecText = `${canonicalSpec}\n${activeProgramIssueDelta}`;

test('program-tracker-mode sibling defines Issue-first Program Tracking anchors', () => {
  for (const phrase of [
    'Issue-first Program Tracking',
    'Program-shaped 觸發條件',
    'label:type:program',
    'label:program:active',
    '## Routing Hints',
    'Aliases',
    'Keywords',
    'Owned Paths',
    'Affected Systems',
    'MUST read parent issue',
    'PR 前 MUST update parent issue',
    'program:completed',
  ]) {
    assert.ok(programTrackerMode.includes(phrase), `program-tracker-mode.md missing ${phrase}`);
  }
  // The concrete `gh issue list` discovery command stays in the entry leaf's
  // Verification block (kept, not moved to the sibling); assert it there.
  assert.ok(
    consumerFlow.includes('gh issue list --label type:program --label program:active --search "<keyword>"'),
    'openspec-flow-consumer.md missing gh issue list discovery command',
  );
});

test('program-tracker-mode sibling defines GitHub Issues list identity for program trackers', () => {
  for (const phrase of [
    'GitHub Issues list identity',
    'Program：<short-title>',
    'Sub-issue：P<N>：<short-title>',
    'program:<program-key>',
    'type:phase',
    'program:phase',
    'is:issue is:open -label:program:phase',
    'label:program:<program-key>',
    'Native sub-issue relation',
    'Phase body MUST NOT 寫 parent number / mention / URL',
    'cross-reference',
    'Parent dashboard',
    'Comments SHOULD 只作必要 audit log',
    'Duplicate timeline recovery',
    'discovery 只會命中新 parent',
    'validation evidence index',
    '完整 phase gate / validation command output 的 SSOT',
    'routine phase completion',
    '只有 blocker、scope/order decision、重要 audit event 才寫 parent comment',
  ]) {
    assert.ok(programTrackerMode.includes(phrase), `program-tracker-mode.md missing ${phrase}`);
  }
});

test('program-tracker-mode sibling keeps parent program evidence as links, not partial gate copies', () => {
  for (const phrase of [
    'validation evidence index',
    'phase sub-issue、PR body、OpenSpec active/archive path',
  ]) {
    assert.ok(programTrackerMode.includes(phrase), `program-tracker-mode.md missing ${phrase}`);
  }
  // The rationalization rebuttal phrasing stays in the entry leaf's Common
  // Rationalizations block (kept, not moved); assert it against the entry.
  assert.ok(
    consumerFlow.includes('完整驗證證據以 phase sub-issue、PR body、OpenSpec archive 為準'),
    'openspec-flow-consumer.md missing parent-evidence-as-links rationalization rebuttal',
  );
});

test('program-tracker-mode sibling forbids AGENTS.md and capability spec as program tracker', () => {
  assert.ok(
    programTrackerMode.includes('不得修改 `AGENTS.md` 承載 repo-specific program 規則'),
    'program-tracker-mode must forbid repo-specific program rules in AGENTS.md',
  );
  assert.ok(
    programTrackerMode.includes('不得要求 consumer repo 只為追蹤 long-running program 建 `openspec/specs/<capability>/spec.md`'),
    'program-tracker-mode must not require capability spec solely for program tracking',
  );
  assert.ok(
    programTrackerMode.includes('Program Issue tracking 取代任何 repo-local markdown live progress tracker'),
    'program-tracker-mode must replace generic repo-local markdown live progress trackers',
  );
});

test('canonical OpenSpec spec records Program Issue scenarios', () => {
  for (const phrase of [
    'Requirement: Consumer Issue-first Program Tracking',
    'Scenario: Program-shaped work triggers discovery',
    'Scenario: Matched active program issue is read before planning',
    'Scenario: Program issue list identity is explicit',
    'Scenario: Native sub-issue relationship avoids duplicate parent timeline references',
    'Scenario: Parent dashboard links validation evidence without copying phase gates',
    'Scenario: Routine phase completion avoids parent comment noise',
    'Scenario: Program state changes are updated before PR',
    'Scenario: Duplicate parent timeline events require supersede decision',
    'Scenario: Completed programs stop matching automatically',
    'Scenario: Repo-specific program rules stay out of AGENTS',
  ]) {
    assert.ok(programIssueSpecText.includes(phrase), `openspec-flow spec missing ${phrase}`);
  }
});

test('main OpenSpec flow and step checklist route to Program Issue tracking', () => {
  assert.ok(
    openspecFlow.includes('Consumer Issue-first Program Tracking'),
    'openspec-flow.md must expose Program Issue routing from the main OpenSpec router',
  );
  assert.ok(
    openspecSteps.includes('Step 4d Consumer Program Issue Routing'),
    'openspec-step-1-to-9.md must include Step 4d pointer',
  );
  assert.ok(
    openspecSteps.includes('Consumer only；source 跳過'),
    'Step 4d must be consumer-only',
  );
  assert.ok(
    openspecSteps.includes('短命 branch / archive / release subset 仍依本檔原則'),
    'Step 4d must preserve archive/short-lived branch principles',
  );
});

test('/dp:change command and AGENTS index make the gate discoverable', () => {
  assert.ok(
    changeCommand.includes('Issue-first Program Tracking'),
    '/dp:change must mention Issue-first Program Tracking before analyst handoff',
  );
  assert.ok(
    changeCommand.includes('label:type:program label:program:active'),
    '/dp:change must include active Program Issue discovery labels',
  );
  assert.ok(
    /consumer.*rules lane.*Program Issue.*consumer-adoption\.md/.test(agentsMd) &&
      /openspec-flow-consumer\.md/.test(consumerAdoption),
    'AGENTS.md index must route consumer/rules lane/Program Issue to consumer-adoption.md, whose Load-chain reaches openspec-flow-consumer.md',
  );
});
