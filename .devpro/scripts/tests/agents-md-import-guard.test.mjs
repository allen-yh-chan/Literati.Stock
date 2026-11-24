/**
 * agents-md-import-guard.test.mjs
 *
 * 為何只鎖 CLAUDE.md：
 *   Claude Code 是唯一原生支援 `@<path>` import 語法的工具（由 Anthropic 定義）。
 *   CLAUDE.md 的唯一合法內容是 `@AGENTS.md`，讓 Claude Code 原生展開 AGENTS.md
 *   而不把 AGENTS.md 的全文直接嵌入 CLAUDE.md，實現雙層 token 節約設計。
 *
 * 為何 GEMINI.md / .windsurfrules 不在此測試範圍：
 *   這兩個檔案目前沒有已驗證等效的 import 語法，維持自然語言描述方式同步。
 *   若未來 Gemini CLI 或 Windsurf 有等效 import，需另建對應測試，不在本檔處理。
 *
 * 本測試鎖死兩條回歸防線：
 *   1. CLAUDE.md trim 後恰等於 `@AGENTS.md`（strict equal，不是 includes）。
 *   2. CLAUDE.md 不含任何 `@<path>` import（行首容許前導空白）指向
 *      `@AGENTS.md` 以外的路徑，確保 leaf 規則檔不會被 @ 遞迴展開。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";

const CLAUDE_MD_PATH = sourcePath("CLAUDE.md");
const EXPECTED_CONTENT = "@AGENTS.md";

// 偵測行首（容許前導空白）的 @ import token，例如 `@foo.md` 或 `  @.devpro/agent-rules/x.md`
const AT_IMPORT_LINE_RE = /^\s*@\S+/m;

describe("CLAUDE.md import guard", () => {
  it("CLAUDE.md trim 後恰等於 '@AGENTS.md'（strict equal）", () => {
    const content = readFileSync(CLAUDE_MD_PATH, "utf8");
    assert.equal(
      content.trim(),
      EXPECTED_CONTENT,
      `CLAUDE.md 必須恰為 '${EXPECTED_CONTENT}'，實際內容: ${JSON.stringify(content)}`
    );
  });

  it("CLAUDE.md 不含任何 '@<path>' import 以外的 @AGENTS.md", () => {
    const content = readFileSync(CLAUDE_MD_PATH, "utf8");

    // 收集所有行首 @ import token（用 module-level AT_IMPORT_LINE_RE，避免 pattern 重複）
    const atImportLines = content
      .split(/\r?\n/)
      .filter((line) => AT_IMPORT_LINE_RE.test(line))
      .map((line) => line.trim());

    // 所有 @ import 行應唯一且只有 @AGENTS.md
    for (const line of atImportLines) {
      assert.equal(
        line,
        EXPECTED_CONTENT,
        `CLAUDE.md 不可含 '@AGENTS.md' 以外的 @ import 行，發現: ${JSON.stringify(line)}`
      );
    }

    // 且必須恰好有一個 @ import 行（不可空白、不可多行）
    assert.equal(
      atImportLines.length,
      1,
      `CLAUDE.md 必須恰好有 1 個 @ import 行，實際有 ${atImportLines.length} 個: ${JSON.stringify(atImportLines)}`
    );
  });

  it("CLAUDE.md 不含任何指向 '.devpro/agent-rules/' 的 @ import", () => {
    const content = readFileSync(CLAUDE_MD_PATH, "utf8");
    const leafImportRe = /^\s*@\.devpro\/agent-rules\//m;
    assert.doesNotMatch(
      content,
      leafImportRe,
      "CLAUDE.md 不可出現 @.devpro/agent-rules/... 的 @ import，leaf 規則檔不應被 @ 遞迴展開"
    );
  });
});
