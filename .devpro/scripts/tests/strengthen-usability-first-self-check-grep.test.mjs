/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the Usability-First self-check item in `AGENTS.md` and `ai-autonomy.md`
 * and its handoff-carrier wording.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * strengthen-usability-first-self-check-grep.test.mjs
 *
 * Locks anchor strings for the strengthened Usability-First self-check
 * (十句自檢 #9) in ai-autonomy.md §9 (SSOT) + AGENTS.md §0 entry #9.
 *
 * Background: #9 原本只有「user value 優先；成本只當 tie-break」一句正向宣示，
 * 缺「effort 偽裝成 value」的失效模式命名 + 動手前反問。本 session 反覆出現
 * 「用少改／零改動／省事合理化實則傷 user value 的選擇」被使用者連續攔截，
 * 證明缺失效模式命名 + 反問 gate。本 strengthen 補：失效模式名 + 反問句 +
 * 時機維度（前饋 > 事後 gate）+ ≥4 條本 session 實錄對照例（✗ effort 偽裝
 * value / ✓ 正解）。SSOT anchor 斷言 scoped 到 #9 numbered item（extractItem9），
 * §0 mirror 斷言 scoped 到 AGENTS.md §0 #9 那一行——兩側對稱避免 false-pass。
 *
 * Style reference: enforce-load-efficiency-self-check-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



/**
 * Scope anchor assertions to the #9 numbered item only (not the whole file),
 * so anchors that appear elsewhere in ai-autonomy.md can never false-pass this
 * guard. Mirrors the §0-sync extractor: grab the 動手前十句自檢 block, then the
 * text from item `9.` up to item `10.` (the next numbered item), so a later
 * self-check item never leaks into this item's anchor assertions.
 */
function extractItem9(md) {
  const block = md.match(/### 動手前十句自檢[^\n]*\n\n([\s\S]*?)\n\n十題任一/);
  assert.ok(block, 'ai-autonomy.md: 動手前十句自檢 block 不存在——無法定位 #9');
  const item9 = block[1].match(/(^|\n)9\.\s[\s\S]*?(?=\n10\.\s|$)/);
  assert.ok(item9, 'ai-autonomy.md: 十句自檢缺 numbered item 9');
  return item9[0];
}

/**
 * §0 mirror side: isolate AGENTS.md §0 numbered item 9 (single summary line),
 * so the mirror anchor assertion can never false-pass on a stray match
 * elsewhere in AGENTS.md. Symmetric to extractItem9 on the SSOT side.
 */
function extractAgentsItem9(md) {
  const block = md.match(/### 動手前十句自檢[^\n]*\n\n([\s\S]*?)\n\n十題任一/);
  assert.ok(block, 'AGENTS.md: 動手前十句自檢 block 不存在——無法定位 §0 #9');
  const line9 = block[1].split('\n').find((l) => /^9\.\s+\*\*/.test(l));
  assert.ok(line9, 'AGENTS.md: §0 缺 numbered item 9');
  return line9;
}

const aiAutonomyMd = read('.devpro/agent-rules/ai-autonomy.md');
const agentsMd = read('AGENTS.md');
const item9 = extractItem9(aiAutonomyMd);
const agentsItem9 = extractAgentsItem9(agentsMd);

test('#9 SSOT: §9 item 命名失效模式「effort 偽裝成 value」', () => {
  assert.ok(
    item9.includes('effort 偽裝成 value'),
    'ai-autonomy.md §9 item 缺失效模式命名「effort 偽裝成 value」——此為本 strengthen 的核心，防止拿實作成本冒充 user value'
  );
});

test('#9 SSOT: §9 item 含「反交差」+ 防同錯 + action point 會讀會照做', () => {
  assert.ok(
    item9.includes('反交差檢查') &&
      item9.includes('交差') &&
      item9.includes('code/rule/doc/test') &&
      /防止.*同一錯誤/.test(item9) &&
      /action point/.test(item9) &&
      /會讀、會照做/.test(item9),
    'ai-autonomy.md §9 item 缺反交差檢查：任何 code/rule/doc/test 修正都必須說明如何防止下次同錯，且落在 agent 實際 action point 會讀會照做的位置'
  );
});

test('#9 SSOT: 新創建產物必留下可供接手者遵循的 durable carrier', () => {
  assert.ok(
    item9.includes('創建到接手連續性') &&
      item9.includes('同一 change') &&
      item9.includes('可發現') &&
      item9.includes('下一動作') &&
      item9.includes('owner/context') &&
      item9.includes('verification/guard') &&
      item9.includes('排除邊界') &&
      item9.includes('作者記憶') &&
      item9.includes('cooperative-only'),
    'ai-autonomy.md §9 必須要求新產物留下可發現、可照做、可驗證的接手 carrier，並誠實標示 cooperative-only 限制',
  );
});

test('#9 SSOT: §9 item 含「動手前反問」+ effort 相等反問句', () => {
  assert.ok(
    item9.includes('動手前反問') &&
      /若\s*effort\s*相等/.test(item9) &&
      item9.includes('我還會選這個嗎'),
    'ai-autonomy.md §9 item 缺動手前反問「若 effort 相等…我還會選這個嗎」——這是把正向宣示變成可執行 gate 的關鍵'
  );
});

test('#9 SSOT: §9 item 含「時機」維度（前饋 > 事後 gate）', () => {
  assert.ok(
    item9.includes('時機') && item9.includes('前饋') &&
      /前饋\s*>\s*事後/.test(item9),
    'ai-autonomy.md §9 item 缺「時機」維度——user value 須含「正確做法到達受益者的時機：寫入當下前饋 > 事後 gate」'
  );
});

test('#9 SSOT: §9 item 含 ≥4 條本 session 對照例（✗/✓ 標記齊備）', () => {
  // 對照例以 ✗（effort 偽裝 value）/ ✓（正解）標記，僅限 #9 item 內計數
  const crossMarks = (item9.match(/✗/g) || []).length;
  const checkMarks = (item9.match(/✓/g) || []).length;
  assert.ok(
    crossMarks >= 4 && checkMarks >= 4,
    `ai-autonomy.md §9 對照例不足：需 ≥4 組 ✗/✓（現 ✗=${crossMarks}、✓=${checkMarks}）——對照例是使用者指定的證據錨`
  );
});

test('#9 SSOT: §9 item 四對照例語意詞齊備（preamble / title / fail-open / 前饋）', () => {
  for (const term of ['preamble', 'title', 'fail-open', 'mandatory-load']) {
    assert.ok(
      item9.includes(term),
      `ai-autonomy.md §9 item 對照例缺語意詞「${term}」——四例分別錨 preamble 判準 / archive title / classifier fail-open / 事後 lint vs 前饋 mandatory-load`
    );
  }
});

test('#9 SSOT: §9 item 點明同根「決策當下了結，禁以省事外推」', () => {
  assert.ok(
    item9.includes('決策當下') && item9.includes('省事'),
    'ai-autonomy.md §9 item 須點明與「Ask First 前置濾網」共根：決策當下以 user value 了結、禁以省事外推'
  );
});

test('#9 §0 mirror: AGENTS.md 第 9 句含失效模式錨「effort 偽裝 value」', () => {
  assert.ok(
    /禁\s*effort\/交差\s*偽裝\s*value/.test(agentsItem9),
    'AGENTS.md §0 第 9 句缺失效模式錨「禁 effort/交差 偽裝 value」——§0 摘要須與 ai-autonomy.md SSOT 同步帶失效模式名'
  );
});

test('#9 §0 mirror: AGENTS.md 第 9 句含防同錯與 action point 錨', () => {
  assert.ok(
    agentsItem9.includes('code/rule/doc/test') &&
    agentsItem9.includes('防同錯') &&
      agentsItem9.includes('action point') &&
      agentsItem9.includes('會讀會用'),
    'AGENTS.md §0 第 9 句缺防同錯/action point 摘要錨——每次載入的摘要必須提醒不要做自己不會遵守的修正'
  );
});

test('#9 §0 mirror: AGENTS.md 第 9 句提醒接手者可發現並遵循新建產物', () => {
  assert.ok(
    agentsItem9.includes('新建產物') &&
      agentsItem9.includes('可發現') &&
      agentsItem9.includes('下一動作') &&
      agentsItem9.includes('驗證') &&
      agentsItem9.includes('排除邊界') &&
      agentsItem9.includes('接手者遵循'),
    'AGENTS.md §0 第 9 句缺新建產物的接手 continuity 摘要',
  );
});
