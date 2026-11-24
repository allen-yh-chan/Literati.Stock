/**
 * anti-duplication.test.mjs
 *
 * TDD RED 測試：驗證 hook payload 不含禁止字串（AGENTS.md 長段內容特徵）。
 *
 * hook payload 應只含 AGENTS.md SSOT pointer + dynamic reminders，不含以下 heading/label 形式：
 *   - ### Anti-Rationalization（heading form）
 *   - ## Anti-Rationalization（heading form）
 *   - Common Rationalizations（概念專有名詞）
 *   - ### Always（heading form, line-start）
 *   - ### Ask First（heading form）
 *   - ### Never（heading form, line-start）
 *   - ### Red Flags（heading form）
 *   - ## 7.（section heading）
 *   - ## 8.（section heading）
 *   - ## 9.（section heading）
 *   - Session 收尾 Gate（概念專有名詞）
 *
 * 注意：inline references（如 Intent 表中的「§8：...」）屬合法 routing reference，不禁止。
 *
 * 任一 regex 命中於 hook payload → fail，error message 列出所有違規字串清單。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const hookPath = path.join(REPO_ROOT, ".devpro", "scripts", "hooks", "session-start.mjs");

// 禁止字串清單（heading/label form only；multiline mode）
const FORBIDDEN = [
  {
    label: "### Anti-Rationalization（heading form）",
    pattern: /^### Anti-Rationalization/m,
  },
  {
    label: "## Anti-Rationalization（heading form）",
    pattern: /^## Anti-Rationalization/m,
  },
  {
    label: "Common Rationalizations（概念專有名詞）",
    pattern: /Common Rationalizations/,
  },
  {
    label: "### Always（heading form, line-start）",
    pattern: /^### Always$/m,
  },
  {
    label: "### Ask First（heading form）",
    pattern: /^### Ask First/m,
  },
  {
    label: "### Never（heading form, line-start）",
    pattern: /^### Never$/m,
  },
  {
    label: "### Red Flags（heading form）",
    pattern: /^### Red Flags/m,
  },
  {
    label: "## 7.（section heading）",
    pattern: /^## 7\./m,
  },
  {
    label: "## 8.（section heading）",
    pattern: /^## 8\./m,
  },
  {
    label: "## 9.（section heading）",
    pattern: /^## 9\./m,
  },
  {
    label: "Session 收尾 Gate（概念專有名詞）",
    pattern: /Session 收尾 Gate/,
  },
];

// ── helper ───────────────────────────────────────────────────────────────────

/**
 * 從 hook script 的 msg 陣列中提取 payload 字串。
 */
async function extractHookPayload() {
  const content = await fs.readFile(hookPath, "utf8");
  const msgMatch = content.match(/const msg = \[([\s\S]*?)\]\.join\("\\n"\)/);
  if (!msgMatch) {
    throw new Error("無法從 session-start.mjs 解析 msg 陣列");
  }
  // SECURITY: see hook-payload-sync.test.mjs comment — eval safe only because
  // hook script is source-controlled and regex bounds the substring.
  const arrText = `[${msgMatch[1]}]`;
  // eslint-disable-next-line no-new-func
  const arr = new Function(`return ${arrText}`)();
  return arr.join("\n");
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("anti-duplication", () => {
  it("hook payload 不含禁止字串（只允許 AGENTS.md pointer + dynamic reminders）", async () => {
    const hookPayload = await extractHookPayload();

    const violations = FORBIDDEN.filter(({ pattern }) =>
      pattern.test(hookPayload)
    );

    if (violations.length > 0) {
      const violationList = violations.map((v) => `  - ${v.label}`).join("\n");
      assert.fail(
        [
          "hook payload 含有禁止字串，違反「只允許 AGENTS.md pointer + dynamic reminders」原則。",
          "hook payload 不應複製 AGENTS.md 長段（動手前十句自檢 / Intent 速查 / 輸出紀律）。",
          "完整啟動規範留在 AGENTS.md；hook payload 只提供短 pointer 與 session-pending/recap 等動態提醒。",
          `違規字串清單：\n${violationList}`,
        ].join("\n")
      );
    }
  });
});
