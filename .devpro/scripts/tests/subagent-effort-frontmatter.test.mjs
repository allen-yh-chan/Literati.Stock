/**
 * subagent-effort-frontmatter.test.mjs
 *
 * Guards: each dp-* subagent in .claude/agents/ must declare `effort:` in its
 * YAML frontmatter, and the value must match the devpro allocation table from
 * claude-code-effort-tiers.md §Sub-agent Effort.
 *
 * Allocation registry (SSOT: claude-code-effort-tiers.md §Sub-agent Effort):
 *   dp-reviewer      → xhigh   (六軸 mandatory gate；與 Codex host 投影同級)
 *   dp-architect     → xhigh   (高風險多方案架構設計；與 Codex host 投影同級)
 *   dp-analyst       → xhigh   (需求分析 / RCA——設計鏈上游，近 architect)
 *   dp-second-reviewer → xhigh  (wrapper orchestration——自身 reasoning，非它 spawn 的 codex CLI；與 Codex host 投影同級)
 *   dp-programmer    → high    (實作需理解設計語意)
 *   dp-assistant     → medium  (rote work，機械為主偶需判斷)
 *   dp-explorer      → low     (唯讀 fan-out spawn，high × 大量 = 成本爆)
 *
 * Note: dp-second-reviewer frontmatter effort (xhigh) 是 wrapper 自身 orchestration；
 *       它 spawn 的 codex CLI 的 model_reasoning_effort 由 cross-review recipe 政策固定 xhigh
 *       （gpt-6 目錄另有 max/ultra 但不採用），見 codex-effort-tiers.md §Switching（兩層不混）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const agentsDir = path.join(REPO_ROOT, ".claude", "agents");
const codexEffortTiersPath = path.join(
  REPO_ROOT,
  ".devpro",
  "agent-rules",
  "platform-adapters",
  "codex-effort-tiers.md"
);

/** Expected effort per agent — single source of truth for this test. */
const EFFORT_REGISTRY = {
  "dp-reviewer": "xhigh",
  "dp-architect": "xhigh",
  "dp-analyst": "xhigh",
  "dp-second-reviewer": "xhigh",
  "dp-programmer": "high",
  "dp-assistant": "medium",
  "dp-explorer": "low",
};

/**
 * Extract the value of `effort:` from YAML frontmatter.
 * Returns null when the field is absent or frontmatter is missing.
 * Only scans inside the opening `---` … `---` block.
 */
function extractEffort(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fmBody = fmMatch[1];
  const effortMatch = fmBody.match(/^effort:\s*(\S+)\s*$/m);
  return effortMatch ? effortMatch[1] : null;
}

describe("subagent-effort-frontmatter", () => {
  describe("每個 dp-* agent frontmatter 含 effort: 欄位", () => {
    for (const [agentName] of Object.entries(EFFORT_REGISTRY)) {
      it(`${agentName}.md 含 effort:`, async () => {
        const filePath = path.join(agentsDir, `${agentName}.md`);
        let content;
        try {
          content = await fs.readFile(filePath, "utf8");
        } catch {
          assert.fail(`找不到檔案：.claude/agents/${agentName}.md`);
        }

        const effort = extractEffort(content);
        assert.ok(
          effort !== null,
          `違規：.claude/agents/${agentName}.md frontmatter 缺 effort: 欄位。` +
            " 所有 dp-* subagent 必須固定 effort 以防隨 TL session 浮動。"
        );
      });
    }
  });

  describe("各 agent effort 值符合 devpro 分配表", () => {
    for (const [agentName, expectedEffort] of Object.entries(EFFORT_REGISTRY)) {
      it(`${agentName}.md effort = ${expectedEffort}`, async () => {
        const filePath = path.join(agentsDir, `${agentName}.md`);
        let content;
        try {
          content = await fs.readFile(filePath, "utf8");
        } catch {
          assert.fail(`找不到檔案：.claude/agents/${agentName}.md`);
        }

        const actual = extractEffort(content);
        assert.equal(
          actual,
          expectedEffort,
          `違規：.claude/agents/${agentName}.md effort=${actual}，` +
            ` 分配表要求 ${expectedEffort}。` +
            " 變更 effort 必須同步更新此 registry（EFFORT_REGISTRY in subagent-effort-frontmatter.test.mjs）。"
        );
      });
    }
  });

  describe("codex-effort-tiers.md cross-review pin recipe 政策 tier", () => {
    it("codex-effort-tiers.md §Switching pins the xhigh recipe policy（不寫死 high）", async () => {
      let content;
      try {
        content = await fs.readFile(codexEffortTiersPath, "utf8");
      } catch {
        assert.fail(
          "找不到 .devpro/agent-rules/platform-adapters/codex-effort-tiers.md"
        );
      }
      const switching = content.split("### Switching")[1]?.split(/\n## /)[0] ?? "";
      assert.ok(
        switching.includes("xhigh") && switching.includes("本 recipe 不採用"),
        "違規：codex-effort-tiers.md §Switching 應 pin cross-review recipe 政策（固定 `xhigh`，並明示 `gpt-6` 目錄另有 max/ultra 但本 recipe 不採用）。" +
          " 舊寫法「Cross-review 預設用 high」與 code-review-cross-model.md 的 Cross-Model 第二意見 SHALL clause 矛盾，請改為 pin recipe 政策 tier。"
      );
    });

    it("codex-effort-tiers.md §Switching 不含舊「預設用 `high`」wording", async () => {
      let content;
      try {
        content = await fs.readFile(codexEffortTiersPath, "utf8");
      } catch {
        assert.fail(
          "找不到 .devpro/agent-rules/platform-adapters/codex-effort-tiers.md"
        );
      }
      assert.ok(
        !content.includes("預設用 `high`"),
        "違規：codex-effort-tiers.md 仍含舊 wording「預設用 `high`」。" +
          " cross-review 應依 recipe 政策固定 tier，不寫死 high（見 code-review-cross-model.md Cross-Model SHALL clause）。"
      );
    });
  });

  // Negative guard: cross-review recipe 政策固定 xhigh；任何 codex adapter 檔出現
  // `model_reasoning_effort="max"` = 誤把 recipe 政策未採用的 max 階梯套 codex（PR #1018
  // bug，fix-codex-tier-no-max 修）。此 guard 防同類遺漏復發——本 bug 的 codex-host-cross-review.md
  // 遺漏即靠人工 grep 才發現，正向 xhigh 斷言抓不到。
  describe("codex adapter 群禁 model_reasoning_effort=max（recipe 政策 pin xhigh）", () => {
    const codexAdapterFiles = [
      ".devpro/agent-rules/platform-adapters/codex-effort-tiers.md",
      ".devpro/agent-rules/platform-adapters/codex.md",
      ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md",
      ".claude/agents/dp-second-reviewer.md",
    ];
    for (const rel of codexAdapterFiles) {
      it(`${rel} 不含 model_reasoning_effort="max"`, () => {
        const content = readFileSync(repoPath(rel), "utf8");
        assert.ok(
          !content.includes('model_reasoning_effort="max"'),
          `違規：${rel} 含 model_reasoning_effort="max"，但 cross-review recipe 政策固定 xhigh。` +
            ` 誤把未採用的 max 階梯套 recipe；改為 "xhigh"（見 codex-effort-tiers.md §Switching）。`
        );
      });
    }
  });
});

it("Codex dp-architect fixed role effort remains xhigh", () => {
  const codexArchitect = readFileSync(repoPath(".codex/agents/dp-architect.toml"), "utf8");
  const codexMapping = readFileSync(codexEffortTiersPath, "utf8");
  assert.match(codexArchitect, /reasoning_effort\s*=\s*"xhigh"/);
  assert.match(codexMapping, /最高努力層 \| proposal 技術設計／架構權衡/);
});
