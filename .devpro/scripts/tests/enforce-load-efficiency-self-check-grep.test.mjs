/**
 * enforce-load-efficiency-self-check-grep.test.mjs
 *
 * Locks anchor strings for the load-timing alignment self-check codified
 * into rules-consistency-checklist.md §6.5 (load-efficiency program task C).
 *
 * Background: a全庫載入效率審計 found AGENTS.md 觸發式載入索引 is a
 * keyword-reactive router, not a phase-anchored loader. 階段性紀律 leaf
 * 因此容易變孤兒（規則寫了但該載入時機沒人載入）。本 check 把 4 類載入
 * 錯配 codify 成「改規範時必經自檢」，避免靠事後重審補抓。
 *
 * Style reference: strengthen-openspec-flow-rules-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



const checklistMd = read('.devpro/agent-rules/rules-consistency-checklist.md');

test('§6.5: rules-consistency-checklist.md 含「載入時機對齊自檢」段標題', () => {
  assert.ok(
    /###\s*6\.5\)\s*載入時機對齊自檢/.test(checklistMd),
    'rules-consistency-checklist.md 缺少 §6.5 載入時機對齊自檢段——此段把載入錯配 codify 成前置自檢'
  );
});

test('§6.5: 4 類載入錯配代號 LM-1～LM-4 齊備', () => {
  for (const code of ['LM-1', 'LM-2', 'LM-3', 'LM-4']) {
    assert.ok(
      checklistMd.includes(code),
      `rules-consistency-checklist.md §6.5 缺少 ${code}——4 類載入錯配必須齊備`
    );
  }
});

test('§6.5: 4 類錯配的關鍵語意詞齊備', () => {
  for (const term of [
    '孤兒觸發點',     // LM-1
    '載入鏈斷裂',     // LM-2
    '雙時機耦合',     // LM-3
    '觸發詞-索引不匹配', // LM-4
  ]) {
    assert.ok(
      checklistMd.includes(term),
      `rules-consistency-checklist.md §6.5 缺少語意詞「${term}」`
    );
  }
});

test('§6.5: root-cause 點明 router 為關鍵字反應式而非階段錨定', () => {
  assert.ok(
    checklistMd.includes('關鍵字反應式') && checklistMd.includes('階段錨'),
    'rules-consistency-checklist.md §6.5 root-cause 必須說明 router 是關鍵字反應式、階段性紀律須掛 always-loaded 階段錨'
  );
});

test('§6.5: 是前置 gate 而非事後重審（Common Rationalizations 反駁）', () => {
  assert.ok(
    checklistMd.includes('事後重審'),
    'rules-consistency-checklist.md 須有「事後重審」反駁，明示 §6.5 是改規範時前置 gate'
  );
});

test('§6.5: Exit Criteria 已把載入時機對齊納入第 1-7 節 gate', () => {
  assert.ok(
    /第\s*1-7\s*節（含\s*6\.5\s*載入時機對齊/.test(checklistMd),
    'rules-consistency-checklist.md Exit Criteria 須明示第 1-7 節含 6.5 載入時機對齊'
  );
});
