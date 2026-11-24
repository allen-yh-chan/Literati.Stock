import assert from 'node:assert/strict';
import test from 'node:test';
import { readRepoFile as read } from './lib/read.mjs';
import { readChangeSpecWithArchiveFallback } from './lib/spec-delta-reader.mjs';

const branchRule = read('.devpro/agent-rules/git-branch-naming-and-anchor.md');
const releaseRule = read('.devpro/agent-rules/release-sit-uat-pat-prod.md');
// T4 de-bundle: step 1-7 conflict-handling content moved to release-step-1-7.md
const releaseStep17 = read('.devpro/agent-rules/release-step-1-7.md');
const changeSpec = readChangeSpecWithArchiveFallback('clarify-feature-conflict-routing', 'specs/openspec-flow/spec.md', 'openspec/specs/openspec-flow/spec.md');
const canonicalSpec = read('openspec/specs/openspec-flow/spec.md');

test('PR-to-main conflict routing is explicit in branch and release rules', () => {
  assert.match(branchRule, /PR 併入 main 衝突分流/);
  assert.match(branchRule, /dependency \/ release-ordering decision point/);
  assert.match(branchRule, /不得 merge 整個 `main`/);
  assert.match(branchRule, /衝突來源不明/);
  // These strings moved to release-step-1-7.md (T4 de-bundle):
  assert.match(releaseStep17, /PR-to-main conflict/);
  assert.match(releaseStep17, /PR 併入 main 衝突分流/);
  assert.match(releaseStep17, /只 merge\/recreate from B 分支，不 merge main/);
  assert.doesNotMatch(releaseRule, /已落 main 的版本/);
  assert.doesNotMatch(releaseRule, /merge 前序.*main/);
});

test('OpenSpec captures PR-to-main conflict decision tree', () => {
  for (const spec of [changeSpec, canonicalSpec]) {
    assert.match(spec, /Requirement: PR-To-Main Conflict Decision Tree/);
    assert.match(spec, /not as permission to merge `main`/);
    assert.match(spec, /another unshipped promotable unit/);
    assert.match(spec, /MUST stop and ask for a dependency\/release-ordering decision/);
  }
});
