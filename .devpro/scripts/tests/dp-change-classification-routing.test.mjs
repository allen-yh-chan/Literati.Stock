import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
import { readChangeSkillFullReadingOrder } from './lib/change-skill.mjs';

// Full-rigor reading order = SKILL.md with the 僅 full pointers expanded from the reference.
const SKILL = readChangeSkillFullReadingOrder();

describe('dp:change change classification routing (第二步)', () => {
  test('第一步 Verb Whitelist Precheck 同時涵蓋 verb whitelist 與 one-scope body', () => {
    assert.match(
      SKILL,
      /第一步：Verb Whitelist Precheck（含 one-scope body）/,
      '/devpro:change skill prompt 第一歩 must preserve the Verb Whitelist Precheck anchor and include one-scope body'
    );
    assert.match(
      SKILL,
      /<name>` scope body[\s\S]*-and-[\s\S]*一動詞一 scope violation/,
      '/devpro:change skill prompt must check branch <name> body for -and- and other one-scope violations before worktree creation'
    );
    assert.match(
      SKILL,
      /branch hook[\s\S]*gh pr create/,
      '/devpro:change skill prompt must not defer one-scope failures to branch hook or gh pr create'
    );
  });

  test('第二步 Change Classification Routing 段標題存在', () => {
    assert.match(SKILL, /第二步：Change Classification Routing/, '/devpro:change skill prompt 缺「第二步：Change Classification Routing」段標題（issue #2503；步驟順序：第一步=Verb Whitelist、第二步=Change Classification）');
  });

  test('cross-ref chore-classification.md', () => {
    assert.match(SKILL, /chore-classification\.md/, '/devpro:change skill prompt 缺 chore-classification.md cross-ref（SSOT 連結）');
  });

  test('四前綴走判斷表，禁止 prefix-only full shortcut', () => {
    assert.match(SKILL, /chore \/ feature \/ bugfix \/ hotfix/, '缺四前綴共用判斷表路由');
    assert.doesNotMatch(
      SKILL,
      /^\s*- \*\*feature \/ bugfix \/ hotfix\*\* → 直接走完整第五步/m,
      '不得保留 feature/bugfix/hotfix 直接走完整第五步的 prefix-only shortcut（#2503）'
    );
    assert.match(SKILL, /\*\*禁止\*\*只因前綴是 feature\/bugfix\/hotfix/, '缺禁止 prefix-only full 的明示句');
  });

  test('三分類關鍵字存在（A / B-mini / B）', () => {
    // Triggers routing decision; do NOT lock Fast-Track path step strings
    assert.match(SKILL, /判定 A \/ B-mini \/ B/, '缺「判定 A / B-mini / B」完整三分類句');
    assert.match(SKILL, /判為 \*\*B（full）\*\*/, '缺 full-B（判斷表 B）適用範圍關鍵字');
    assert.match(SKILL, /A \/ B-mini 跳過 dp-analyst/, '缺 A / B-mini 跳過 dp-analyst 句');
  });

  test('full-B /devpro:clarify 適用範圍含 hotfix（刻意；形狀 full 不分前綴）', () => {
    assert.match(
      SKILL,
      /判為 \*\*B（full）\*\* 的 chore \/ feature \/ bugfix \/ hotfix/,
      'full-B pre-analyst 適用範圍須含 hotfix（#2503 remedia：形狀 full 一律走 /devpro:clarify）'
    );
  });

  // migrate-skill-architecture-to-dp-prefix：`/dp:` 冒號式 command 全面廢除，
  // 不只 .codex/.cursor 未曾有對應檔——連 Claude 側 `.claude/commands/dp/change.md`
  // 本身也已刪除（skill symlink 為唯一跨平台入口）。本測試斷言範圍維持
  // .codex/.cursor 不存在（歷來如此），涵蓋於全面廢除後的狀態，不需再擴大斷言。
  test('Cross-runtime parity scope lock — 無 .codex / .cursor 對應 /dp:change skill', () => {
    const codexPath = repoPath('.codex/commands/dp/change.md');
    const cursorPath = repoPath('.cursor/commands/dp/change.md');
    assert.ok(!existsSync(codexPath), `.codex/commands/dp/change.md 存在 — 若新增 codex 對應檔需同步更新本測試 + skill 內 cross-runtime parity check 段`);
    assert.ok(!existsSync(cursorPath), `.cursor/commands/dp/change.md 存在 — 若新增 cursor 對應檔需同步更新本測試 + skill 內 cross-runtime parity check 段`);
  });
});
