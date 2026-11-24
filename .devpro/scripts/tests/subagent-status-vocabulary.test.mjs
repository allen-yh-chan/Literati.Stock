/**
 * subagent-status-vocabulary.test.mjs
 *
 * 防回歸：5 個 subagent + 2 個 dp workflow skill 不含舊 status enum 串列；
 * 5 個 subagent Communication Protocol 段含 canonical 子集詞。
 *
 * migrate-skill-architecture-to-dp-prefix：`.claude/commands/dp/{change,pre-pr}.md`
 * 廢除（`/dp:` 冒號入口移除），COMMAND_FILES 改指對應 devpro:change / devpro:pre-pr skill body
 * （唯一 SSOT 現落 skill，非 command 檔）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SUBAGENT_VOCAB = {
  ".claude/agents/dp-analyst.md": ["finished", "failed", "questions"],
  ".claude/agents/dp-architect.md": ["finished", "failed", "questions"],
  ".claude/agents/dp-reviewer.md": ["finished", "blocked", "partial"],
  ".claude/agents/dp-programmer.md": ["finished", "failed", "partial"],
  ".claude/agents/dp-assistant.md": ["finished", "failed", "partial"],
};

const COMMAND_FILES = [
  ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
];

// 精確 enum 串列形式——不誤抓單獨 PASS / axis verdict
const LEGACY_STATUS_ENUMS = [
  /\bPASS\s*\|\s*FAIL\s*\|\s*QUESTIONS\b/,
  /\bPASS\s*\|\s*QUESTIONS\b/,
  /\bPASS\s*\|\s*BLOCK\b/,
  /\bOK\s*\/\s*FAIL\s*\/\s*PARTIAL\b/,
  /\bOK\s*\|\s*FAIL\s*\|\s*PARTIAL\b/,
  /\[OK\s*\/\s*FAIL\s*\/\s*PARTIAL\]/,
];

const LEGACY_TERMS_EXACT = ["PASS_WITH_IMPORTANT", "PASS WITH IMPORTANT"];

async function readFileOrFail(relPath) {
  try {
    return await fs.readFile(repoPath(relPath), "utf8");
  } catch {
    assert.fail(`找不到檔案：${relPath}`);
  }
}

/**
 * 提取 ## Communication Protocol 到下一個同級 ## 段（或檔尾）。
 * 追蹤 fenced code block，避免誤以模板標題為段落邊界。
 */
function extractCommProtocolSection(content) {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) =>
    /^##\s+Communication Protocol/.test(l)
  );
  if (startIdx === -1) return "";
  let endIdx = lines.length;
  let inFence = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^##\s+/.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

function assertNoLegacy(content, relPath) {
  for (const regex of LEGACY_STATUS_ENUMS) {
    assert.doesNotMatch(content, regex,
      `違規：${relPath} 含舊 status enum 串列 ${regex}。改用 canonical 5 詞集。`);
  }
  for (const term of LEGACY_TERMS_EXACT) {
    assert.ok(!content.includes(term),
      `違規：${relPath} 含舊詞「${term}」。改用 partial。`);
  }
}

describe("subagent-status-vocabulary", () => {
  describe("規則 1：5 個 subagent 不含舊 status enum 串列", () => {
    for (const relPath of Object.keys(SUBAGENT_VOCAB)) {
      it(`${relPath} 不含 LEGACY status enum 串列`, async () => {
        assertNoLegacy(await readFileOrFail(relPath), relPath);
      });
    }
  });

  describe("規則 2：5 個 subagent Communication Protocol 段含 canonical 子集詞", () => {
    for (const [relPath, subset] of Object.entries(SUBAGENT_VOCAB)) {
      it(`${relPath} 含 ${subset.join(" / ")}`, async () => {
        const section = extractCommProtocolSection(await readFileOrFail(relPath));
        assert.ok(section.length > 0, `${relPath} 找不到 ## Communication Protocol 段`);
        for (const word of subset) {
          assert.ok(section.includes(word),
            `違規：${relPath} Communication Protocol 段缺 canonical 詞「${word}」（應含 ${subset.join(" / ")}）。`);
        }
      });
    }
  });

  describe("規則 3：dp workflow skill 不含 status 語境舊 enum 串列", () => {
    for (const relPath of COMMAND_FILES) {
      it(`${relPath} 不含 LEGACY status enum 串列`, async () => {
        assertNoLegacy(await readFileOrFail(relPath), relPath);
      });
    }
  });
});
