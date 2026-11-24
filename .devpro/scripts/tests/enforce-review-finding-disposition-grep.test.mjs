/**
 * enforce-review-finding-disposition-grep.test.mjs
 *
 * Locks the Finding Disposition Discipline codified into
 * code-review-checklist.md: every review finding (incl. Suggestion) must have
 * an explicit disposition (fix-in-PR / open-issue / deferred+reason); logging
 * an in-scope low-cost finding in the PR body as a future follow-up (no owner,
 * no issue number) is forbidden as a silent drop.
 *
 * Style reference: enforce-load-efficiency-self-check-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';

const checklist = readFileSync(
  repoPath('.devpro/agent-rules/code-review-checklist.md'),
  'utf8'
);

test('checklist 含「Finding Disposition Discipline」段標題', () => {
  assert.ok(
    /###\s*Finding Disposition Discipline/.test(checklist),
    'code-review-checklist.md 缺少 Finding Disposition Discipline 段'
  );
});

test('disposition 三選一齊備（當場修 / 開 issue / deferred+理由）', () => {
  assert.ok(checklist.includes('當場修'), '缺「當場修」disposition');
  assert.ok(checklist.includes('開 issue'), '缺「開 issue」disposition');
  assert.ok(checklist.includes('deferred+理由'), '缺「deferred+理由」disposition');
});

test('明示含 Suggestion + 禁止 PR body 孤兒 follow-up', () => {
  assert.ok(
    checklist.includes('含 Suggestion'),
    'Finding Disposition Discipline 必須明示涵蓋 Suggestion'
  );
  assert.ok(
    /禁止.*PR body 散文.*follow-up/.test(checklist),
    '必須禁止「PR body 散文待 follow-up」的孤兒 disposition'
  );
  assert.ok(
    checklist.includes('silent drop') || checklist.includes('孤兒'),
    '必須點明無 owner/issue 的 follow-up = silent drop / 孤兒項'
  );
});

test('「不阻擋 merge」≠「可以不修」明示於規範', () => {
  assert.ok(
    checklist.includes('「不阻擋 merge」≠「可以不修」'),
    '必須明示 Suggestion 不因不阻擋而豁免修補預設'
  );
});

test('Exit Criteria 把 finding disposition 納入 gate', () => {
  assert.ok(
    /每條 finding（含 Suggestion）已依 Finding Disposition Discipline/.test(checklist),
    'Exit Criteria 須要求每條 finding 標註 disposition'
  );
});
