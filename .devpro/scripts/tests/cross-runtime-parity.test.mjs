/**
 * cross-runtime-parity.test.mjs
 *
 * 驗證 AGENTS.md 含跨 runtime 必需的 H2 sections，確保 codex/cursor/gemini
 * /windsurf 等 non-Claude-Code runtime 仍能 routing。
 *
 * Per .devpro/agent-rules/rule-design-principles.md「Hook-Independent Routing」:
 * AGENTS.md 在 hook 失效或 runtime 不支援時仍能 routing。
 *
 * 驗證項目：
 *   - 必含 H2 sections: Intent 速查 / 觸發式載入索引 / §0 自主原則 /
 *     §7 PROD 修復 / §8 同步作業 / §9 Session 收尾 Gate
 *   - Intent 速查表非空（≥ 5 row）
 *   - 觸發式載入索引非空（≥ 10 row）
 *
 * 不檢查 Lifecycle Mapping（已被 PR #99 chore #1 移除，per design-principles
 * leaf-self-contained — slash command 內部步驟屬 leaf 自含範圍）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const agentsMdPath = repoPath("AGENTS.md");
const platformContractPath = repoPath(".devpro/agent-rules/platform-adapter-contract.md");

const IDENTITY_TRUST_LADDER_RE = /trusted exact host\/runtime session metadata[^\n]*(?:->|→|otherwise|否則)[^\n]*trusted family\/config alias[^\n]*(?:->|→|otherwise|否則)[^\n]*`?unknown`?/i;
const UNTRUSTED_IDENTITY_SOURCES_RE = /(?:User assertion|使用者(?:斷言|聲稱))[^\n]*(?:prior assistant self-claim|上一則 assistant 自稱)[^\n]*(?:repository\/example strings|repo(?:sitory)?\s*\/\s*example strings|repo 範例)[^\n]*(?:marketing\/default|marketing\/default model)[^\n]*(?:inferred current version|推測(?:目前|當前)?版本)[^\n]*(?:MUST NOT|不得)[^\n]*(?:raise|increase|提高|提升)[^\n]*(?:specificity|具體度)/i;
const SHARED_RESOLVED_IDENTITY_RE = /(?:loading declaration|載入宣告)[^\n]*(?:footer|attribution|provenance)[^\n]*(?:MUST|必須)[^\n]*(?:reuse|共用|重用)[^\n]*(?:same resolved identity|同一次 resolved identity|相同 resolved identity)[^\n]*(?:footer|attribution)[^\n]*(?:MUST NOT|不得)[^\n]*(?:more specific|更具體)/i;

// 必含 H2 sections（heading text，去掉 "## " 前綴）
const REQUIRED_H2_SECTIONS = [
  "Intent 速查",
  "觸發式載入索引",
  "0. AI 自主行動原則",
  "7. PROD 問題修復",
  "8. 同步作業",
  "9. Session 收尾 Gate",
];

describe("cross-runtime-parity", () => {
  it("AGENTS entry points loading declarations at the identity resolver SSOT", async () => {
    const content = await fs.readFile(agentsMdPath, "utf8");
    assert.match(
      content,
      /載入宣告[^\n]*platform-adapter-contract\.md[^\n]*identity[^\n]*footer[^\n]*(?:共用|reuse)/i
    );
  });

  it("platform adapter contract carries the exact/family/unknown identity trust ladder", async () => {
    const content = await fs.readFile(platformContractPath, "utf8");
    assert.match(content, IDENTITY_TRUST_LADDER_RE);
    assert.match(content, UNTRUSTED_IDENTITY_SOURCES_RE);
    assert.match(content, SHARED_RESOLVED_IDENTITY_RE);
  });

  it("AGENTS.md 含跨 runtime 必需 H2 sections", async () => {
    const content = await fs.readFile(agentsMdPath, "utf8");
    const missing = [];

    for (const section of REQUIRED_H2_SECTIONS) {
      // 找 "## <section>" 前綴匹配（允許 section 後有額外文字如「（永遠生效）」）
      const re = new RegExp(`^## ${section.replace(/[.→]/g, "\\$&")}`, "m");
      if (!re.test(content)) {
        missing.push(section);
      }
    }

    assert.equal(
      missing.length,
      0,
      [
        `AGENTS.md 缺少必需 H2 sections: ${missing.join(", ")}`,
        "這些 sections 是跨 runtime routing 的必要骨架；移除/重命名會破壞 codex/cursor/gemini 等 runtime 的 routing。",
        "若需重構，先確認 cross-runtime equivalent path（per .devpro/agent-rules/rule-design-principles.md 守則 1）。",
      ].join("\n")
    );
  });

  it("Intent 速查表非空（≥ 5 row）", async () => {
    const content = await fs.readFile(agentsMdPath, "utf8");
    // 抓 ## Intent 速查 到下一 H2 或 --- 之間的 table rows
    const sectionMatch = content.match(
      /## Intent 速查\s*\n([\s\S]*?)(?=\n## |\n---)/
    );
    assert.ok(sectionMatch, "AGENTS.md 應含「Intent 速查」段");

    // 計算 table data row（| ... | ... |，排除 header 與 separator）
    const tableLines = sectionMatch[1]
      .split("\n")
      .filter((line) => /^\|.*\|.*\|$/.test(line.trim()))
      .filter((line) => !/^\|[\s\-|]+\|$/.test(line.trim())); // 排除 |---|---|

    // 第一行是 header，剩下才是 data
    const dataRows = tableLines.length > 1 ? tableLines.length - 1 : 0;

    assert.ok(
      dataRows >= 5,
      `Intent 速查表 data row ${dataRows} < 5 (sanity check：表不應幾近空白)`
    );
  });

  it("Intent 速查 uses direct entries and direct Branch Routing file", async () => {
    const content = await fs.readFile(agentsMdPath, "utf8");
    const sectionMatch = content.match(
      /## Intent 速查\s*\n([\s\S]*?)(?=\n## |\n---)/
    );
    assert.ok(sectionMatch, "AGENTS.md 應含「Intent 速查」段");

    const section = sectionMatch[1];
    assert.match(section, /openspec-flow\.md/);
    assert.match(section, /git-branch-and-pr-flow\.md/);
    assert.match(section, /openspec-branch-routing\.md/);
    assert.doesNotMatch(section, /Change workflow/);
    assert.doesNotMatch(
      section,
      /功能變更 \| `\/dp:change`；先過 Branch Routing/
    );
  });

  it("觸發式載入索引非空（≥ 10 row）", async () => {
    const content = await fs.readFile(agentsMdPath, "utf8");
    const sectionMatch = content.match(
      /## 觸發式載入索引\s*\n([\s\S]*?)(?=\n## |\n---)/
    );
    assert.ok(sectionMatch, "AGENTS.md 應含「觸發式載入索引」段");

    const tableLines = sectionMatch[1]
      .split("\n")
      .filter((line) => /^\|.*\|.*\|$/.test(line.trim()))
      .filter((line) => !/^\|[\s\-|]+\|$/.test(line.trim()));
    const dataRows = tableLines.length > 1 ? tableLines.length - 1 : 0;

    assert.ok(
      dataRows >= 10,
      `觸發式載入索引 data row ${dataRows} < 10 (sanity check：索引不應幾近空白)`
    );
  });
});

// ── strengthen-admission-binding-portability: declared-path adapter parity ──
//
// Locks the delta scenarios `Declared Binding Path Is First-Class For Every
// Supported Host` and `Opaque Carrier Declared-Path Limits Stay Cooperative-Only`
// (openspec/changes/strengthen-admission-binding-portability/specs/cross-runtime-parity/spec.md).
// Both are `[cooperative-only, weak enforcement]` wording locks — the spec
// explicitly lets grep fixtures hold the operative wording, so these assert on
// the adapter carriers rather than on hook behavior.

const DECLARED_PATH_HOSTS = [
  {
    name: "Claude Code",
    hot: ".devpro/agent-rules/platform-adapters/claude-code.md",
    surfaces: [".devpro/agent-rules/platform-adapters/claude-code-capabilities.md"],
  },
  {
    name: "Codex",
    hot: ".devpro/agent-rules/platform-adapters/codex.md",
    surfaces: [".devpro/agent-rules/platform-adapters/codex-workflow-capabilities.md"],
  },
  { name: "Cursor", hot: ".devpro/agent-rules/platform-adapters/cursor.md", surfaces: [] },
  { name: "OpenCode", hot: ".devpro/agent-rules/platform-adapters/opencode.md", surfaces: [] },
];

describe("cross-runtime-parity — declared binding path", () => {
  it("Declared Binding Path Is First-Class For Every Supported Host", async () => {
    for (const host of DECLARED_PATH_HOSTS) {
      const hot = await fs.readFile(repoPath(host.hot), "utf8");
      assert.match(hot, /宣告路徑/, `${host.hot} must document the declared binding path`);
      assert.match(hot, /execution_root/, `${host.hot} must carry the declared execution_root contract`);
      assert.match(
        hot,
        /不是[^\n]{0,40}gate 條件|不再(?:是)?要求/,
        `${host.hot} must state the environment ritual is not a gate condition`
      );
      const family = [hot, ...(await Promise.all(host.surfaces.map(async (file) => fs.readFile(repoPath(file), "utf8"))))].join("\n");
      assert.match(family, /一等公民/, `${host.name} adapter surface must document the declared path as first-class`);
      assert.match(family, /同一 resolver/, `${host.name} adapter surface must name the one shared resolver`);
      assert.match(family, /封閉碼群/, `${host.name} adapter surface must name the shared closed fault-code group`);
    }
  });

  it("Opaque Carrier Declared-Path Limits Stay Cooperative-Only", async () => {
    const codex = await fs.readFile(repoPath(".devpro/agent-rules/platform-adapters/codex.md"), "utf8");
    const cold = await fs.readFile(
      repoPath(".devpro/agent-rules/platform-adapters/codex-workflow-capabilities.md"),
      "utf8"
    );
    assert.match(codex, /execution_root/, "the Codex adapter must require execution_root on the declared path");
    assert.match(cold, /opaque/i);
    assert.match(
      cold,
      /execution_root[^\n]*cooperative|cooperative[^\n]*execution_root/i,
      "the opaque carrier must still carry execution_root cooperatively"
    );
    assert.match(cold, /intent tuple/, "the mechanical guarantee must rest on the host-matched intent tuple");
    assert.match(cold, /canonical_worktree_sha256/);
    assert.match(
      cold,
      /MUST NOT 宣稱[^\n]*機械驗證/,
      "the adapter MUST NOT claim an opaque carrier is mechanically verified"
    );
  });
});
