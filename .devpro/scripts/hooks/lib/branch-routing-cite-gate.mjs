/**
 * branch-routing-cite-gate.mjs
 *
 * Gate H — Branch Routing Cite Gate：偵測 AI 訊息含「branch creation intent +
 * fix context」但未引述 openspec-branch-routing.md Rule #3-5 → warn（advisory）。
 *
 * 設計原則（per rule-design-principles.md §Token-First / usefulness first）：
 *   - 純 logic library — 無 I/O，無 process.exit，只 export checkBranchRoutingCite
 *   - Silent default：只在同時滿足「有 branch creation keyword + 有 fix context
 *     + 無 routing cite」才 shouldBlock: true（hook 層降為 warn-only advisory）
 *   - fail-open：無法判定時（e.g. 空訊息）→ skip
 *
 * Trigger 條件（兩者並存才觸發）：
 *   1. hasBranchCreationKeyword：/bugfix\/|hotfix\/|新分支|開分支|建分支/
 *   2. hasFixContext：/修\s*bug|\bfix\b|修正|regression/i
 *
 * Cite 要求（任一滿足即 pass）：
 *   - openspec-branch-routing.md 字面引用
 *   - Rule #3 / Rule #4 / Rule #5 條目編號
 *   - tip.*production-* 判定字串（如「tip 未上 PROD」/「tip 已被 production-*」）
 *   - 未上 PROD
 *   - per `openspec-branch-routing.md` cross-ref 樣式
 *
 * Skip 條件：
 *   - commit message context（含 git commit -m / <commit-msg> / Co-Authored-By: / heredoc EOF）
 *   - subagent inter-agent communication output（含 ## 實作結果 / ## 六軸審查 /
 *     Communication Protocol / agentId:）
 *   - 空訊息
 *
 * Enforcement：warn-only（first iteration；lifecycle-level new gate）。
 *   shouldBlock: true → hook 層以 stderr advisory 輸出，不 block exit code。
 *
 * Bypass：env DEVPRO_DISABLE_BRANCH_ROUTING_GATE=1
 */

// ── Commit message context skip patterns ─────────────────────────────────────

/**
 * Skip 條件：訊息屬 commit message context。
 * 包含：
 *   - `git commit -m` 命令
 *   - heredoc `<commit-msg>` / `commit_msg` block 樣式
 *   - Co-Authored-By: footer（commit message 末尾標準 footer）
 *   - heredoc EOF marker（含 EOF 且在 commit 語境中）
 */
const COMMIT_CONTEXT_PATTERNS = [
  /git\s+commit\s+-m\b/i,
  /<commit[-_]msg>/i,
  /Co-Authored-By:/i,
  /^Co-Authored-By:/m,
];

// ── Subagent output skip patterns ─────────────────────────────────────────────

/**
 * Skip 條件：訊息為 subagent inter-agent communication output。
 * 偵測常見 subagent output anchors（dp-programmer / dp-reviewer / dp-analyst 等）。
 */
const SUBAGENT_OUTPUT_PATTERNS = [
  /^##\s*實作結果/m,
  /^##\s*六軸審查/m,
  /Communication Protocol/,
  /\bagentId\s*:/i,
];

// ── Branch creation keyword patterns ─────────────────────────────────────────

/**
 * Branch creation intent keywords。
 * 設計注意：
 *   - bugfix/ 和 hotfix/ 含斜線，偵測具體 branch path 格式（避免概念性討論觸發）
 *   - 新分支 / 開分支 / 建分支：中文動作詞
 */
const BRANCH_CREATION_RE = /bugfix\/|hotfix\/|新分支|開分支|建分支/;

// ── Fix context patterns ──────────────────────────────────────────────────────

/**
 * Fix context：修 bug / fix / 修正 / regression（任一觸發）。
 * 與 branch creation keyword 並存才觸發 Gate H。
 */
const FIX_CONTEXT_RE = /修\s*bug|\bfix\b|修正|regression/i;

// ── Routing cite patterns ─────────────────────────────────────────────────────

/**
 * Routing cite：任一 match 即 pass。
 * 接受：
 *   - openspec-branch-routing.md 明確引用
 *   - Rule #3 / Rule #4 / Rule #5 條目編號（寬鬆：#後接3-5）
 *   - tip.*production-* 判定字串
 *   - 未上 PROD
 */
const ROUTING_CITE_RE =
  /openspec-branch-routing\.md|Rule\s*#[3-5]|tip.*production-\*|未上\s*PROD/;

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * 偵測訊息是否屬 commit message context。
 * @param {string} text
 * @returns {boolean}
 */
export function isCommitContext(text) {
  return COMMIT_CONTEXT_PATTERNS.some((re) => re.test(text));
}

/**
 * 偵測訊息是否為 subagent inter-agent communication output。
 * @param {string} text
 * @returns {boolean}
 */
export function isSubagentOutput(text) {
  return SUBAGENT_OUTPUT_PATTERNS.some((re) => re.test(text));
}

/**
 * 偵測訊息含 branch creation intent keyword。
 * @param {string} text
 * @returns {boolean}
 */
export function hasBranchCreationKeyword(text) {
  return BRANCH_CREATION_RE.test(text);
}

/**
 * 偵測訊息含 fix context keyword。
 * @param {string} text
 * @returns {boolean}
 */
export function hasFixContext(text) {
  return FIX_CONTEXT_RE.test(text);
}

/**
 * 偵測訊息含有效 routing cite。
 * @param {string} text
 * @returns {boolean}
 */
export function hasRoutingCite(text) {
  return ROUTING_CITE_RE.test(text);
}

// ── Gate H entry point ───────────────────────────────────────────────────────

/**
 * Gate H entry point：偵測 branch creation intent + fix context + routing cite 缺失。
 *
 * @param {{ messageText: string }} options
 * @returns {{ shouldBlock: boolean, message: string }}
 *   shouldBlock: true → hook 層以 stderr advisory 輸出（warn-only，不 block）
 */
export function checkBranchRoutingCite({ messageText }) {
  // Empty message → skip (fail-open)
  if (!messageText || !messageText.trim()) {
    return { shouldBlock: false, message: "" };
  }

  // Commit message context → skip
  if (isCommitContext(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // Subagent inter-agent communication → skip
  if (isSubagentOutput(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // No branch creation keyword → no issue
  if (!hasBranchCreationKeyword(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // No fix context → no issue (branch creation without fix context is out of scope)
  if (!hasFixContext(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // Has routing cite → ok
  if (hasRoutingCite(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // Branch creation + fix context found, no routing cite → advisory
  const advisoryMsg = [
    "### Gate H — Branch Routing Cite Gate Advisory（warn-only）",
    "",
    "AI 訊息含 branch creation intent（bugfix/ / hotfix/ / 新分支 / 開分支 / 建分支）",
    "+ fix context（修 bug / fix / 修正 / regression），",
    "但未引述 `openspec-branch-routing.md` Rule #3-5 之 tip-vs-production-tag decision。",
    "",
    "**建議動作**：在訊息中引述 routing decision 依據，例如：",
    "- `per openspec-branch-routing.md Rule #4 — tip 未上 PROD → 在原分支修`",
    "- `per openspec-branch-routing.md Rule #5 — tip 已被 production-* tag 包含 → 新建 bugfix/hotfix`",
    "",
    "Per Rule #4「tip 未上 PROD → 在原分支修；無論該分支是否已 merge 到 main」。",
    "檢查當前可促進單位分支 tip 是否在 latest production-* tag 內，再決定 routing。",
    "",
    "Per Gate H spec：branch-routing-cite-gate.mjs。",
    "",
    "（本 gate 為 warn-only，不中斷工作流程。）",
  ].join("\n");

  return { shouldBlock: true, message: advisoryMsg };
}
