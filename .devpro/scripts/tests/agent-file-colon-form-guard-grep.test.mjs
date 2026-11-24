/**
 * agent-file-colon-form-guard-grep.test.mjs
 *
 * 守門測試：三平台 agent 定義檔家族（`.claude/agents/**`、`.cursor/agents/**`、
 * `.codex/agents/**`）不得殘留 colon-form `/dp:` 觸發引用。
 *
 * 背景／SSOT：migrate-skill-architecture-to-dp-prefix 已廢除 `/dp:` 冒號式
 * colon-input 觸發入口；refactor-agent-skills-entry 再把 skill 收進 `devpro:`
 * 命名空間——`devpro:<name>`＝名詞指涉、`/devpro:<name>`（Claude）或
 * `$devpro:<name>`（Codex）＝觸發指示，實際叫用形見 active adapter。canonical
 * 規格見 cross-runtime-parity〈Skill Symlink as the Sole Cross-Runtime
 * First-Party Workflow Entry Point〉。
 *
 * 為何需要獨立守門（先前盲區）：本測試上線前的 3804 綠測試 suite 未涵蓋
 * `.claude/agents/**`、`.cursor/agents/**`、`.codex/agents/**` 這三個目錄家族，
 * 導致遷移時這批 agent 定義檔（15 處）殘留 colon-form 未被攔截，
 * dp-reviewer 已標為測試盲區。本測試專責補上這個缺口：任何 agent 定義檔
 * （.claude/agents/*.md、.cursor/agents/*.md、.codex/agents/*.toml）只要含
 * 字面 `/dp:` 字串即視為違規，需改寫為名詞形 `devpro:<name>` 或觸發指示
 * `/devpro:<name>`。
 *
 * 本測試與 subagent-prompt-routing.test.mjs 職責不同：那支驗證的是
 * 「subagent 不可讀取 AGENTS.md」，本測試專責 colon-form 觸發引用守門，
 * 兩者互不重疊、互不取代。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";


// 掃描目標：三平台 agent 定義檔家族。
const AGENT_DIRS = [
  { relDir: ".claude/agents", ext: ".md" },
  { relDir: ".cursor/agents", ext: ".md" },
  { relDir: ".codex/agents", ext: ".toml" },
];

// colon-form 觸發引用的硬編字面字串。已隨 migrate-skill-architecture-to-dp-prefix
// 廢除，agent 檔內不得殘留。
const COLON_FORM_LITERAL = "/dp:";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 掃描檔案內容，回傳所有含 literal 字串的違規行（含行號）。
 */
function findViolatingLines(content, literal) {
  const lines = content.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(literal)) {
      violations.push({ lineNum: i + 1, text: lines[i].trim() });
    }
  }
  return violations;
}

/**
 * 列出目錄下指定副檔名的檔案（相對 REPO_ROOT 的路徑）。目錄不存在時回傳空陣列。
 */
async function listAgentFiles(relDir, ext) {
  const dirPath = repoPath(relDir);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => path.join(relDir, entry.name));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("agent-file-colon-form-guard", () => {
  describe("三平台 agent 定義檔不得殘留 colon-form 「/dp:」觸發引用", () => {
    for (const { relDir, ext } of AGENT_DIRS) {
      it(`掃描 ${relDir}/*${ext}`, async () => {
        const relPaths = await listAgentFiles(relDir, ext);

        assert.ok(
          relPaths.length > 0,
          `找不到任何檔案：${relDir}/*${ext}（目錄可能不存在或為空，請確認路徑）`
        );

        const allViolations = [];
        for (const relPath of relPaths) {
          const filePath = repoPath(relPath);
          const content = await fs.readFile(filePath, "utf8");
          const violations = findViolatingLines(content, COLON_FORM_LITERAL);
          for (const v of violations) {
            allViolations.push({ relPath, ...v });
          }
        }

        if (allViolations.length > 0) {
          const violationList = allViolations
            .map((v) => `  ${v.relPath}:${v.lineNum}: ${v.text}`)
            .join("\n");
          assert.fail(
            [
              `違規：以下 agent 檔含有 colon-form 「/dp:」觸發引用。`,
              "agent 檔的 workflow/skill 指涉必須用名詞形 `devpro:<name>`" +
                "（或觸發指示 `/devpro:<name>`，Codex 為 `$devpro:<name>`），colon-form `/dp:` 冒號入口" +
                "已隨 migrate-skill-architecture-to-dp-prefix 廢除。",
              `違規行：\n${violationList}`,
            ].join("\n")
          );
        }
      });
    }
  });
});
