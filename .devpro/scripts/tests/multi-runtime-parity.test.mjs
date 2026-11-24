/**
 * multi-runtime-parity.test.mjs
 *
 * 驗證 source repo 對多 runtime 的 entry file 一致性，per .devpro/agent-rules/
 * rule-design-principles.md 守則 1（Cross-Runtime Parity — 不把 Claude
 * Code 獨家機制當主路徑）。
 *
 * 驗證項目：
 *   1. Redirect entry files 各以各自 runtime 機制指向 AGENTS.md（內含 AGENTS.md 引用）：
 *      CLAUDE.md（Claude Code 原生 @AGENTS.md import）/ GEMINI.md / .windsurfrules /
 *      .github/copilot-instructions.md（後三者維持自然語言指示，無已驗證等效 import）。
 *      load-bearing invariant：所有 redirect entry 都指向 AGENTS.md。
 *      convenience proxy：四檔 byte-equality；可因 runtime 原生載入能力差異放寬。
 *   2. AGENTS.md 存在且非空
 *   3. 各 runtime 必需目錄存在：
 *      .claude/{agents} / .claude/settings.json /
 *      .cursor/{agents,hooks,rules} / .codex/{agents,hooks} /
 *      .opencode/{agent,plugins} / .devpro/agent-skills / .agents/skills
 *      （OpenCode：load-bearing = shared runner plugin + seven agent projections +
 *       .agents/skills discovery；禁 .opencode/skills／OPENCODE.md convenience 假投影）
 *   4. Cross-platform user-invocable skill discovery symlinks（type "symlink" ＝ `test -L`）：
 *      refactor-agent-skills-entry（design D1/D3）2-entry 拓撲——每個 discovery root 只有一條
 *      `devpro` entry（symlink），指回唯一 catalog root（.devpro/agent-skills/），host 原生命名
 *      空間（`devpro:<name>`）承接 20 支 skill 的可發現性；不再每支 skill 各建一條 discovery
 *      symlink。`.cursor/skills` 已於 remove-cursor-skill-discovery（design D1）退役為 legacy
 *      root——Cursor 改讀 .agents/skills，並持續相容讀 .claude/skills，第三份分發變得多餘。
 *      load-bearing invariant：每個支援 runtime 經至少一個它會讀的 symlink root 抵達唯一 SSOT，
 *      且 discovery 節點必為 symlink（非真材質，防內容重複/漂移）——Claude Code 讀
 *      .claude/skills；Codex／OpenCode 讀 .agents/skills；Cursor 讀 .agents/skills 與
 *      .claude/skills。哪個 root 各有一份 `devpro` symlink 屬 convenience proxy（Parity
 *      invariant impact: 放寬）。詳見 REQUIRED_PATHS 內註解。
 *      OpenCode 不另建 skill discovery symlink 樹（convenience proxy 不擴到 .opencode/skills）。
 *
 * Per GitHub issue #63 sub-item 5。Source repo 內部 parity；不是 consumer
 * sync（後者由 sync-agent-rules.mjs --check 處理）。
 *
 * Re-anchor（add-opencode-runtime-parity V2 scope-change）：OpenCode plugin 由
 * V1 function default export 改 V1＋V2 dual export object（`server()` 承接
 * V1 face、`setup(ctx)` 承接 V2 face）。Parity invariant 增量＝保持——
 * REQUIRED_PATHS（`.opencode/plugins/devpro-hooks.js`＋七 agent 投影）與
 * bridging 斷言集（shared `run-hook.mjs`／`pre-tool-gate`／`--host=opencode`）
 * 不變；本檔只新增 dual-export shape 的存在性斷言（完整 shape prove-it 在
 * opencode-v2-bridge.test.mjs T1）。
 *
 * Uninstall 對稱備註（add-uninstall-mode，invariant 保持）：
 * sync-agent-rules.mjs `--uninstall` 是 install 的鏡像——移除的檔集由同一
 * source-tree 推導（STATIC_FILES + SYNC_DIRS + CLAUDE_SYNC_SUBDIRS），禁
 * rm -rf、保留 consumer extras。它只**移除**檔案，不改任何 redirect→AGENTS.md
 * 機制語意，故上述 load-bearing invariant 在 install/uninstall 雙向對稱守恆。
 * 反向鏡像的 spec-level 宣告見 cross-runtime-parity spec 的 uninstall Scenario；
 * 本檔斷言不需新增/修改（uninstall 不引入新的 parity 面向）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

// 預期 redirect entry files（各以各自 runtime 機制指向 AGENTS.md；不要求 byte-equal）
const REDIRECT_FILES = [
  "CLAUDE.md",
  "GEMINI.md",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

// Policy/action carriers only. Footer-parser fixtures intentionally stay out of
// this list: they may contain historical literals to exercise parsing without
// teaching an active runtime to infer a model minor.
const IDENTITY_TEACHING_CARRIERS = [
  "AGENTS.md",
  ".devpro/agent-rules/preflight-checklist.md",
  ".devpro/agent-rules/platform-adapter-contract.md",
  ".devpro/scripts/hooks/session-start.mjs",
  ".claude/agents/dp-assistant.md",
  ".claude/agents/dp-reviewer.md",
  ".claude/agents/dp-architect.md",
  ".claude/agents/dp-analyst.md",
  ".claude/agents/dp-programmer.md",
];

const HARD_CODED_MODEL_MINOR_EXAMPLE_RE =
  /\b(?:GPT|Claude|Opus|Sonnet|Haiku|Gemini|Grok)[ -]?\d+\.\d+(?:\.\d+)?\b/i;

// 預期存在的 runtime 必需路徑（檔案或目錄）
// .cursor/hooks/ 與 .codex/hooks/ wrapper dirs 在 v6.8.0 refactor-to-devpro-namespace
// 後刪除 — settings.json 與 hooks.json 直接指向 .devpro/scripts/hooks/<x>.mjs
// Parity invariant impact: 收緊（migrate-skill-architecture-to-dp-prefix）。
// `.claude/commands` dir 斷言已移除——`/dp:` 冒號式 command affordance 廢除
// （cross-runtime-parity spec Requirement「Skill Symlink as the Sole
// Cross-Runtime First-Party Workflow Entry Point」sanctioned override），
// `.claude/commands/dp/*` 不再存在，是 convenience proxy 收斂而非 load-bearing
// 降級。load-bearing invariant（skill SSOT 唯一 + 每個支援 runtime 經至少一個它
// 會讀的 symlink root 抵達該 SSOT + AGENTS.md Lifecycle Mapping）不變——所有
// runtime 仍經 skill symlink 指回唯一 SSOT，Claude 用 `/skill-name`、Others 用
// Lifecycle Mapping。（remove-cursor-skill-discovery design D1：`.cursor/skills`
// 退役為 legacy root，Cursor 改讀 .agents/skills，Parity invariant impact: 放寬——
// 僅收斂 convenience proxy 覆蓋面，不動 load-bearing invariant 本身。）
const REQUIRED_PATHS = [
  { path: "AGENTS.md", type: "file" },
  { path: ".claude/agents", type: "dir" },
  { path: ".claude/settings.json", type: "file" },
  { path: ".cursor/agents", type: "dir" },
  { path: ".cursor/rules", type: "dir" },
  { path: ".cursor/hooks.json", type: "file" },
  { path: ".codex/agents", type: "dir" },
  { path: ".codex/hooks.json", type: "file" },
  // OpenCode CLI — load-bearing: auto-discover plugin (.js) + seven role projections.
  // Convenience proxy: host-local byte-equality with Claude/Cursor projections is NOT required.
  // Re-anchor（add-opencode-runtime-parity V2）：plugin 改 V1＋V2 dual export object；
  // 載體路徑（.js 副檔名／七 agent）不變。Parity invariant 增量＝保持。
  { path: ".opencode/plugins/devpro-hooks.js", type: "file" },
  { path: ".opencode/agent", type: "dir" },
  { path: ".opencode/agent/dp-analyst.md", type: "file" },
  { path: ".opencode/agent/dp-architect.md", type: "file" },
  { path: ".opencode/agent/dp-assistant.md", type: "file" },
  { path: ".opencode/agent/dp-explorer.md", type: "file" },
  { path: ".opencode/agent/dp-programmer.md", type: "file" },
  { path: ".opencode/agent/dp-reviewer.md", type: "file" },
  { path: ".opencode/agent/dp-second-reviewer.md", type: "file" },
  { path: ".devpro/scripts/hooks", type: "dir" },
  { path: ".devpro/agent-skills-refs/autonomous-ai-agents/claude-code/SKILL.md", type: "file" },
  { path: ".devpro/agent-skills-refs/autonomous-ai-agents/codex/SKILL.md", type: "file" },
  { path: ".devpro/agent-skills/devpro-workflows/workflows/SKILL.md", type: "file" },
  { path: ".devpro/agent-skills/.claude-plugin/plugin.json", type: "file" },
  // ── Cross-platform user-invocable skill discovery symlinks（refactor-agent-skills-entry
  // design D1/D3, superseding add-first-batch-user-invocable-skills' per-skill topology）──
  // Parity invariant impact: 放寬（discovery symlink root 集合是 convenience proxy，非
  // load-bearing；remove-cursor-skill-discovery design D1 移除 .cursor/skills 這一份，
  // 只放寬 convenience proxy 覆蓋面，不動 load-bearing invariant 本身）。
  // Rationale：20 支 catalog skill 的內容 SSOT 唯一落在 .devpro/agent-skills/<group>/<skill>/；
  // .agents/.claude/skills/devpro 是各 runtime 唯一的 discovery 入口（design D1 的 2-entry
  // 拓撲），必須是 symlink（type "symlink" ＝ `test -L`）指回 catalog root 本身，不得是真材質檔
  // （真檔＝內容重複＝SSOT 漂移，由 lint / agent-skill-governance symlink-required 規範共同
  // 守）。load-bearing invariant 改寫為「每個支援 runtime 經至少一個它會讀的 symlink root 抵達
  // 唯一 SSOT，且 discovery 節點必為 symlink」：Claude Code 讀 .claude/skills；Codex／OpenCode
  // 讀 .agents/skills；Cursor 讀 .agents/skills 與 .claude/skills（`.cursor/skills` 已退役為
  // legacy root，只由 sync-agent-rules.mjs 的 prune／check／uninstall legacy 清單繼續處理殘留，
  // 不再分發）。哪個 root 各有一份 `devpro` symlink 屬 convenience proxy，可隨 runtime
  // discovery 能力增減而放寬。
  // OpenCode：skill discovery 沿用 .agents/skills（load-bearing）；MUST NOT add .opencode/skills
  // or OPENCODE.md (Out / R4) — those are forbidden convenience carriers, not REDIRECT_FILES.
  { path: ".agents/skills/devpro", type: "symlink" },
  { path: ".claude/skills/devpro", type: "symlink" },
];

// Tightened assertion (design D1/D3): source repo MUST NOT retain any of
// the 18 renamed / 2 unchanged-name per-skill discovery links the 2-entry
// topology replaced — a stray old-name entry would mean a discovery dir
// has more than the single permitted `devpro` node.
const RETIRED_PER_SKILL_DISCOVERY_NAMES = [
  "change",
  "clarify",
  "cmux-surface-comms",
  "consumer-doctor",
  "cross-review",
  "init",
  "knowledge-distill",
  "knowledge-ingest",
  "load-plan",
  "openspec-artifact-authoring",
  "pre-pr",
  "recap-writer",
  "release-runbook",
  "rule-governance",
  "second-review",
  "second-review-dogfood",
  "security-scan",
  "setup-ci",
  "sync-rules",
  "workflows",
];

async function readFile(rel) {
  return fs.readFile(repoPath(rel), "utf8");
}

/** Stable substring for majority symlink-typed missing-path diagnostics (#1956). */
export const CORE_SYMLINKS_MISSING_PATH_HINT =
  "Hint: when most missing paths are typed (symlink), check git config core.symlinks (false is common on Windows clones). OS symlink capability (e.g. Windows Developer Mode) does not rewrite an existing clone's core.symlinks; if the OS can create symlinks, set core.symlinks true, then re-run --sync.";

/**
 * Format the "Required runtime config paths 存在" failure message.
 * When missing entries typed `(symlink)` are a strict majority (>50%), append
 * the core.symlinks root-cause hint. Does not change REQUIRED_PATHS.
 *
 * @param {string[]} missing - entries like `${path} (${type})`
 * @returns {string}
 */
export function formatMissingRuntimePathsMessage(missing) {
  const lines = [
    "缺少 runtime 必需路徑：",
    ...missing.map((m) => `  - ${m}`),
    "這些路徑為各 runtime（Claude Code / Cursor / Codex / OpenCode CLI）的 entry point。",
    "若刻意移除，須先確認該 runtime support 是否仍維持。",
  ];
  const symlinkTypedMissCount = missing.filter((m) => /\(symlink\)/.test(m)).length;
  if (missing.length > 0 && symlinkTypedMissCount / missing.length > 0.5) {
    lines.push(CORE_SYMLINKS_MISSING_PATH_HINT);
  }
  return lines.join("\n");
}

async function exists(rel, type) {
  try {
    // type "symlink" 用 lstat（不 follow）＝ `test -L` 等效：cross-platform
    // skill discovery 節點必須是 symlink（真材質 = SSOT 漂移），故不能用會
    // follow 的 fs.stat 判斷。file/dir 沿用 fs.stat（follow 後判型別）。
    if (type === "symlink") {
      const lst = await fs.lstat(repoPath(rel));
      return lst.isSymbolicLink();
    }
    const stat = await fs.stat(repoPath(rel));
    if (type === "file") return stat.isFile();
    if (type === "dir") return stat.isDirectory();
    return false;
  } catch {
    return false;
  }
}

// ── Rules pattern multi-runtime parity ──────────────────────────────────────
//
// Validates that RULES_BRANCH_RE is defined identically in lib/branch-naming.mjs
// (the single source of truth) and not re-implemented inline in any runtime-
// specific hook config or hook script. This prevents runtime-specific regex
// drift (e.g., Cursor/Codex silently using an older pattern without the
// date+sha fallback format).
//
// Strategy: verify each runtime's hook config references pre-tool-gate.mjs
// (not a per-runtime copy), and verify branch-naming.mjs exports RULES_BRANCH_RE
// as the canonical regex.
describe("multi-runtime-parity — rules/ pattern", () => {
  it("RULES_BRANCH_RE is exported from lib/branch-naming.mjs (single source of truth)", () => {
    const branchNamingPath = repoPath(".devpro/scripts/hooks/lib/branch-naming.mjs");
    const src = readFileSync(branchNamingPath, "utf8");
    assert.ok(
      src.includes("export const RULES_BRANCH_RE"),
      "lib/branch-naming.mjs must export RULES_BRANCH_RE as canonical regex"
    );
  });

  it("Claude hook config references pre-tool-gate.mjs (not a rules-specific inline hook)", async () => {
    const claudeSettings = JSON.parse(
      (await fs.readFile(repoPath(".claude/settings.json"), "utf8"))
        .replace(/^\s*\/\/.*$/gm, "")
    );
    const hookCommands = [];
    for (const entries of Object.values(claudeSettings.hooks || {})) {
      const entryList = Array.isArray(entries) ? entries : [entries];
      for (const entry of entryList) {
        const hookList = Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of hookList) {
          if (typeof h.command === "string") hookCommands.push(h.command);
        }
        if (typeof entry.command === "string") hookCommands.push(entry.command);
      }
    }
    const hasPreToolGate = hookCommands.some((c) => c.includes("pre-tool-gate.mjs"));
    assert.ok(
      hasPreToolGate,
      "Claude hook config must reference pre-tool-gate.mjs (RULES_BRANCH_RE lives there via import)"
    );
  });

  it("Codex hook config references pre-tool-gate.mjs (same as Claude — cross-runtime parity)", async () => {
    const codexHooks = JSON.parse(
      (await fs.readFile(repoPath(".codex/hooks.json"), "utf8"))
        .replace(/^\s*\/\/.*$/gm, "")
    );
    const hookCommands = [];
    for (const entries of Object.values(codexHooks.hooks || {})) {
      const entryList = Array.isArray(entries) ? entries : [entries];
      for (const entry of entryList) {
        const hookList = Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of hookList) {
          if (typeof h.command === "string") hookCommands.push(h.command);
        }
        if (typeof entry.command === "string") hookCommands.push(entry.command);
      }
    }
    const hasPreToolGate = hookCommands.some((c) => c.includes("pre-tool-gate.mjs"));
    assert.ok(
      hasPreToolGate,
      "Codex hook config must reference pre-tool-gate.mjs (cross-runtime parity with Claude)"
    );
  });

  it("Cursor hook config references pre-tool-gate.mjs (cross-runtime parity)", async () => {
    const cursorHooks = JSON.parse(
      (await fs.readFile(repoPath(".cursor/hooks.json"), "utf8"))
        .replace(/^\s*\/\/.*$/gm, "")
    );
    const hookCommands = [];
    for (const entries of Object.values(cursorHooks.hooks || {})) {
      const entryList = Array.isArray(entries) ? entries : [entries];
      for (const entry of entryList) {
        const hookList = Array.isArray(entry.hooks) ? entry.hooks : [];
        for (const h of hookList) {
          if (typeof h.command === "string") hookCommands.push(h.command);
        }
        if (typeof entry.command === "string") hookCommands.push(entry.command);
      }
    }
    const hasPreToolGate = hookCommands.some((c) => c.includes("pre-tool-gate.mjs"));
    assert.ok(
      hasPreToolGate,
      "Cursor hook config must reference pre-tool-gate.mjs (cross-runtime parity)"
    );
  });

  it("OpenCode plugin bridges to shared run-hook / pre-tool-gate (cross-runtime parity)", async () => {
    const plugin = await fs.readFile(repoPath(".opencode/plugins/devpro-hooks.js"), "utf8");
    assert.ok(
      plugin.includes("run-hook.mjs") && plugin.includes("pre-tool-gate"),
      "OpenCode plugin must invoke shared run-hook and pre-tool-gate (not a host-local policy engine)"
    );
    assert.ok(
      plugin.includes('host') || plugin.includes("opencode"),
      "OpenCode plugin must mark --host=opencode (or host constant)"
    );
    // Re-anchor（add-opencode-runtime-parity V2）：dual-export shape 存在性斷言
    // （default export 是 object 且含 setup()／server()）。完整 shape prove-it
    // （object 非 function、id 同層、server() 回傳五 V1 hook keys、零第三方
    // import）由 opencode-v2-bridge.test.mjs T1 與 opencode-cli-smoke.test.mjs 承擔；
    // 此處只鎖「V1＋V2 dual export」字面以維持 parity 增量＝保持。
    assert.match(plugin, /export default \{/);
    assert.match(plugin, /async setup\(/);
    assert.match(plugin, /async server\(/);
  });

  it("rules branch regex remains in branch-naming SSOT and is not inlined in pre-tool-gate.mjs", () => {
    const hookSrc = readFileSync(
      repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs"),
      "utf8"
    );
    const branchNamingSrc = readFileSync(
      repoPath(".devpro/scripts/hooks/lib/branch-naming.mjs"),
      "utf8"
    );
    assert.ok(
      branchNamingSrc.includes("RULES_BRANCH_RE"),
      "branch-naming.mjs must remain the RULES_BRANCH_RE SSOT"
    );
    assert.ok(
      !hookSrc.match(/const\s+RULES_BRANCH_RE\s*=/),
      "pre-tool-gate.mjs must not redefine RULES_BRANCH_RE inline"
    );
  });
});

describe("multi-runtime-parity", () => {
  // NOTE: byte-equality assertion removed (chore/enforce-agents-md-import-guard).
  // CLAUDE.md 改用 Claude Code 原生 `@AGENTS.md` import（官方 canonical pattern）；
  // 其餘 runtime 無已驗證等效 import，維持自然語言「讀取根目錄的 AGENTS.md…」。
  // 各檔用各自 runtime 最適機制指向 AGENTS.md，不再要求 byte 一致——
  // 改它的內容不影響其他 platform（CLAUDE.md 本就是 Claude 獨家檔）。
  // load-bearing invariant 由下方「內含 AGENTS.md 引用」承擔；
  // byte-equality 只是 convenience proxy，可因 runtime 原生載入能力差異放寬。

  it("Redirect entry files 內含 AGENTS.md 引用（cross-runtime parity：各檔以各自 runtime 機制指向 AGENTS.md）", async () => {
    for (const file of REDIRECT_FILES) {
      const content = await readFile(file);
      assert.ok(
        content.includes("AGENTS.md"),
        `${file} 不含 AGENTS.md 引用文字（cross-runtime parity 要求所有 redirect 指向 AGENTS.md）`
      );
    }
  });

  it("AGENTS.md 存在且非空", async () => {
    const content = await readFile("AGENTS.md");
    assert.ok(
      content.length > 100,
      `AGENTS.md byte length ${content.length} suspiciously small (sanity check)`
    );
  });

  it("active identity teaching/action carriers do not hard-code a model minor example", async () => {
    const violations = [];
    for (const file of IDENTITY_TEACHING_CARRIERS) {
      const content = await readFile(file);
      const match = content.match(HARD_CODED_MODEL_MINOR_EXAMPLE_RE);
      if (match) violations.push(`${file}: ${match[0]}`);
    }
    assert.deepEqual(
      violations,
      [],
      `hard-coded model minor examples can be mistaken for identity evidence:\n${violations.join("\n")}`
    );
  });

  it("Required runtime config paths 存在", async () => {
    const missing = [];
    for (const { path: p, type } of REQUIRED_PATHS) {
      if (!(await exists(p, type))) {
        missing.push(`${p} (${type})`);
      }
    }
    assert.equal(
      missing.length,
      0,
      formatMissingRuntimePathsMessage(missing)
    );
  });

  // Tightened assertion（design D1/D3）：40 條舊 per-skill discovery link 已由 2 條
  // `devpro` entry 取代；任何殘留的舊名節點都代表 discovery dir 混入了非 devpro entry。
  it("source repo retains no retired per-skill discovery link (superseded by the devpro entry)", async () => {
    const found = [];
    for (const discoveryDir of [".agents/skills", ".claude/skills"]) {
      for (const name of RETIRED_PER_SKILL_DISCOVERY_NAMES) {
        if (await exists(`${discoveryDir}/${name}`, "symlink")) {
          found.push(`${discoveryDir}/${name}`);
        }
      }
    }
    assert.deepEqual(
      found,
      [],
      `retired per-skill discovery link(s) still present (must be replaced by the single 'devpro' entry): ${found.join(", ")}`
    );
  });
});

describe("missing-path core.symlinks hint (majority threshold)", () => {
  it("appends hint when symlink-typed misses are a strict majority", () => {
    const msg = formatMissingRuntimePathsMessage([
      ".agents/skills/devpro (symlink)",
      ".claude/skills/devpro (symlink)",
      "AGENTS.md (file)",
    ]);
    assert.match(msg, /core\.symlinks/);
    assert.ok(msg.includes(CORE_SYMLINKS_MISSING_PATH_HINT));
  });

  it("does not append hint when symlink-typed misses are not a majority", () => {
    const msg = formatMissingRuntimePathsMessage([
      ".agents/skills/devpro (symlink)",
      "AGENTS.md (file)",
      ".claude/agents (dir)",
    ]);
    assert.equal(msg.includes(CORE_SYMLINKS_MISSING_PATH_HINT), false);
    assert.doesNotMatch(msg, /Hint: when most missing paths are typed \(symlink\)/);
  });

  it("does not append hint for empty missing list", () => {
    assert.equal(
      formatMissingRuntimePathsMessage([]).includes(CORE_SYMLINKS_MISSING_PATH_HINT),
      false
    );
  });
});
