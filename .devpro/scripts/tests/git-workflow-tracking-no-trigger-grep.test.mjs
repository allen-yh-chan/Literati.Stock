import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoPath } from './lib/repo-root.mjs';
const RULE_PATH = repoPath('.devpro/agent-rules/git-workflow-tracking.md');
const RULE = readFileSync(RULE_PATH, 'utf8');

describe('git-workflow-tracking No-trigger 判定 SOP (issue #351 斷點 4↔5)', () => {
  test('No-trigger 判定 SOP 段標題存在', () => {
    assert.match(RULE, /No-trigger 判定 SOP/, 'git-workflow-tracking.md 缺「No-trigger 判定 SOP」段標題');
  });

  test('trigger schema 分類核心概念存在（4 種分類）', () => {
    // Anchor on key concept "trigger schema"; do NOT lock specific schema names
    // (workflow_dispatch / schedule / paths / paths-ignore — 措辭可調)
    assert.match(RULE, /trigger schema/, '缺 trigger schema 核心概念字串');
  });

  test('PR body 模板字串存在（path-filtered workflows did not trigger）', () => {
    // This string is the SSOT marker AI copies into PR body Test plan section
    // when path-filter miss confirms expected N/A. Locked to prevent drift.
    assert.match(RULE, /path-filtered workflows did not trigger/, '缺 PR body 模板字串「path-filtered workflows did not trigger」');
  });
});
