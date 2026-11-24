import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



const workflowTracking = read('.devpro/agent-rules/git-workflow-tracking.md');
const devFlowChecklist = read('.devpro/agent-rules/dev-flow-checklist.md');
const releaseRunbook = read('.devpro/agent-skills/release/release-runbook/SKILL.md');

test('git workflow tracking retires the stale unconditional hot path phrase', () => {
  assert.equal(
    workflowTracking.includes('workflow watch → cross-model review before any merge'),
    false,
    'git-workflow-tracking.md must not imply unconditional cross-model review after workflow watch',
  );
});

test('workflow hot path runs Step 5.5 exemption check before non-exempt review', () => {
  assert.match(
    workflowTracking,
    /workflow watch ∥ Step 5\.5 exemption check[^\n]*非豁免 PR[^\n]*cross-model review before merge/,
    'workflow hot path must route through parallel Step 5.5 exemption check and limit cross-model review to non-exempt PRs',
  );
});

test('dev flow checklist routes Stage 5 through exemption and final head checks before review', () => {
  assert.match(
    devFlowChecklist,
    /Step 5 workflow watch ∥ Step 5\.5 exemption check/,
    'dev-flow-checklist.md must route Stage 5 workflow watch in parallel with the Step 5.5 exemption check',
  );
  assert.match(
    devFlowChecklist,
    /Step 5\.5 exemption check[^\n]*豁免 PR[^\n]*`chore\/bump-v<X\.Y\.Z>`[^\n]*非豁免 PR[^\n]*final base\/mergeability sync[^\n]*cross-model review/,
    'dev-flow-checklist.md must limit cross-model review to non-exempt PRs after exemption evidence and final base sync',
  );
  assert.match(
    devFlowChecklist,
    /Step 5\.5 exemption check[^\n]*lineage-broken stale evidence fail closed/,
    'dev-flow-checklist.md must fail closed when stale sticky evidence is no longer in the current head lineage',
  );
  assert.equal(
    devFlowChecklist.includes('Step 5.5 cross-model review → sticky verdict'),
    false,
    'dev-flow-checklist.md must not imply unconditional Step 5.5 cross-model review',
  );
});

test('release runbook binds bump branch-pattern exemption to no cross-model dispatch', () => {
  assert.match(
    releaseRunbook,
    /`chore\/bump-v<X\.Y\.Z>`[^\n]*branch-pattern exemption[^\n]*不得 dispatch[^\n]*不要求 cross-model review/,
    'release runbook must bind chore/bump-v<X.Y.Z> branch-pattern exemption to no second-review dispatch / cross-model requirement',
  );
});
