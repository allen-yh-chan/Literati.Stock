/**
 * subagent-prompt-routing.test.mjs
 *
 * TDD RED 測試：驗證 subagent prompt routing 契約。
 *
 * 規則 1：5 個 dp-* subagent definition 不可含「讀取 AGENTS.md」「讀 AGENTS.md」字串。
 *   - regex: /讀(取)?\s*`?AGENTS\.md/
 *   - 發現任一 → fail，訊息明示違規檔名 + 行號
 *
 * 規則 2：change / pre-pr 工作流的委派 prompt schema 段必須含 routing_context 欄。
 *   - 缺任一 → fail，訊息明示違規檔名
 *
 * SSOT 遷移註（add-first-batch-user-invocable-skills；command 廢除見
 * migrate-skill-architecture-to-dp-prefix）：`/dp:*` 委派 prompt 的內容 SSOT
 * 已從 `.claude/commands/dp/*.md` 移至跨平台 skill（`.devpro/agent-skills/`）；
 * 該 command 檔本身已隨 `/dp:` 冒號入口廢除而整檔刪除（非僅瘦身為 thin
 * redirect）。routing_context 欄現落於 skill：devpro:change 在其 `SKILL.md`，
 * devpro:pre-pr 因 dispatch block 已抽出而落於
 * `references/subagent-dispatch-blocks.md`。故 COMMAND_FILES 指向 skill SSOT，
 * 不再掃已刪除的 command 檔。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SUBAGENT_FILES = [
  ".claude/agents/dp-analyst.md",
  ".claude/agents/dp-architect.md",
  ".claude/agents/dp-reviewer.md",
  ".claude/agents/dp-programmer.md",
  ".claude/agents/dp-assistant.md",
];

// routing_context SSOT 現落於 skill（見檔頭 SSOT 遷移註）：devpro:change 在 SKILL.md，
// devpro:pre-pr 在其抽出的 references/subagent-dispatch-blocks.md。
const COMMAND_FILES = [
  ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
];

// regex 對應規格：/讀(取)?\s*`?AGENTS\.md/
const AGENTS_MD_READ_PATTERN = /讀(取)?\s*`?AGENTS\.md/;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 掃描檔案內容，回傳所有符合 pattern 的違規行（含行號）。
 */
function findViolatingLines(content, pattern) {
  const lines = content.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      violations.push({ lineNum: i + 1, text: lines[i].trim() });
    }
  }
  return violations;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("subagent-prompt-routing", () => {
  describe("規則 1：dp-* subagent 不可含讀取 AGENTS.md 指令", () => {
    for (const relPath of SUBAGENT_FILES) {
      it(`${relPath} 不含「讀(取)? AGENTS.md」`, async () => {
        const filePath = repoPath(relPath);
        let content;
        try {
          content = await fs.readFile(filePath, "utf8");
        } catch {
          assert.fail(`找不到檔案：${relPath}`);
        }

        const violations = findViolatingLines(content, AGENTS_MD_READ_PATTERN);

        if (violations.length > 0) {
          const violationList = violations
            .map((v) => `  行 ${v.lineNum}: ${v.text}`)
            .join("\n");
          assert.fail(
            [
              `違規：${relPath} 含有「讀(取)? AGENTS.md」字串。`,
              "subagent 應從委派 prompt 的 routing_context 欄取得路由資訊，不可直接讀取 AGENTS.md。",
              `違規行：\n${violationList}`,
            ].join("\n")
          );
        }
      });
    }
  });

  describe("規則 2：commands 委派 prompt schema 必須含 routing_context 欄", () => {
    for (const relPath of COMMAND_FILES) {
      it(`${relPath} 含「routing_context」欄`, async () => {
        const filePath = repoPath(relPath);
        let content;
        try {
          content = await fs.readFile(filePath, "utf8");
        } catch {
          assert.fail(`找不到檔案：${relPath}`);
        }

        const hasRoutingContext = content.includes("routing_context");

        assert.ok(
          hasRoutingContext,
          [
            `違規：${relPath} 不含「routing_context」欄。`,
            "commands 委派 prompt schema 必須包含 routing_context 欄，供 subagent 取得路由資訊（避免 subagent 直接讀取 AGENTS.md）。",
          ].join("\n")
        );
      });
    }
  });
});
