/**
 * anti-rat-pointer-parity.test.mjs
 *
 * 驗證 AGENTS.md 內對 ai-autonomy-rationalizations.md「§Common Rationalizations」的 pointer
 * 與 ai-autonomy-rationalizations.md 實際 heading 一致（cross-file ref 完整性）。
 *
 * Per PR #93 decisions.md D1：Anti-Rationalization 主源歸 ai-autonomy-rationalizations.md
 * (refactor-ai-autonomy-debundle T4)，AGENTS.md 透過 pointer 引用。
 * 若 ai-autonomy-rationalizations.md 改 heading 或刪段，pointer
 * 失效但無 mechanical guard → 規則 silent break。
 *
 * 驗證項目：
 *   - AGENTS.md 至少含一處 ref `ai-autonomy-rationalizations.md` + `Common Rationalizations`
 *   - ai-autonomy-rationalizations.md 確實含 `## Common Rationalizations` H2 heading
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const agentsMdPath = repoPath("AGENTS.md");
const aiAutonomyRationalizationsPath = path.join(REPO_ROOT, ".devpro", "agent-rules", "ai-autonomy-rationalizations.md");

describe("anti-rat-pointer-parity", () => {
  it("AGENTS.md 含 ai-autonomy-rationalizations.md §Common Rationalizations pointer", async () => {
    const content = await fs.readFile(agentsMdPath, "utf8");

    // pointer 形式範例：`ai-autonomy-rationalizations.md` §Common Rationalizations
    // 同一行內必須同時含「ai-autonomy-rationalizations.md」與「Common Rationalizations」
    const lines = content.split("\n");
    const matched = lines.some(
      (line) =>
        line.includes("ai-autonomy-rationalizations.md") &&
        line.includes("Common Rationalizations")
    );

    assert.ok(
      matched,
      [
        "AGENTS.md 缺少 ai-autonomy-rationalizations.md §Common Rationalizations pointer。",
        "refactor-ai-autonomy-debundle：Anti-Rationalization 主源已移至 ai-autonomy-rationalizations.md，AGENTS.md 必須以 pointer 引用。",
        "若刻意移除，需先在 ai-autonomy-rationalizations.md 與 AGENTS.md 同步重新規劃 Anti-Rat 架構。",
      ].join("\n")
    );
  });

  it("ai-autonomy-rationalizations.md 含 ## Common Rationalizations heading", async () => {
    const content = await fs.readFile(aiAutonomyRationalizationsPath, "utf8");

    const hasHeading = /^## Common Rationalizations\s*$/m.test(content);

    assert.ok(
      hasHeading,
      [
        "ai-autonomy-rationalizations.md 缺少「## Common Rationalizations」H2 heading。",
        "AGENTS.md 透過 pointer 指向此段；缺少會使 pointer 失效（cross-file ref broken）。",
        "若 rename 此段，需同步更新 AGENTS.md 內所有 pointer 文字。",
      ].join("\n")
    );
  });
});
