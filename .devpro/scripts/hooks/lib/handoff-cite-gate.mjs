/**
 * handoff-cite-gate.mjs
 *
 * Gate A — Handoff Cite Gate：偵測 AI 訊息含「特定 handoff keywords」但未
 * 引述 rule file:line → block。
 *
 * 設計原則（per rule-design-principles.md §Token-First / usefulness first）：
 *   - 純 logic library — 無 I/O，無 process.exit，只 export checkHandoffCite
 *   - Silent default：只在同時滿足「有 keyword + 無 cite」才 block
 *   - fail-open：無法判定時（e.g. 空訊息）→ skip
 *
 * Anti-pattern 實例（per Gate A design spec）：
 *   - AI 寫「PR 已建立，待您 merge」（應自己執行，per ai-autonomy.md §Overview）
 *   - AI 寫「release flow 由你決定何時啟動」（規範要求 bump merge 後立即接 Step 2-7）
 *   - AI 寫「cherry-pick 至 release/v6.34.3」（規範要求 git merge 不是 cherry-pick）
 *
 * Keyword detection（任一觸發）：
 *   - release flow
 *   - git merge --no-ff
 *   - production tag
 *   - release/v（後接版本號或任意字元）
 *   - release/<YYYYMMDD>（消費者 repo 樣式）
 *   - hotfix（handoff context，非 commit message context）
 *   - bump→release / bump merge 後
 *   - archive recovery
 *   - rule rationalization
 *   - sync-rules / consumer sync / sync 到 consumer / submodule 鎖
 *     （release pipeline state-transition vocabulary — 補 PR #294 後續
 *      session evidence root cause：AI 主 main merge 後直推 consumer
 *      /devpro:sync-rules，submodule 實鎖 production 看不到變更）
 *
 * Cite check（任一滿足即通過）：
 *   - `<file>:<line>` pattern：[a-zA-Z0-9_./-]+\.(md|mjs|cjs|json|sh):\d+
 *   - `per \`<file>\` §<heading>` cross-ref 樣式（寬鬆 regex）
 *
 * Skip 條件：
 *   - 訊息屬 commit message context（含 `git commit -m` 或 `<commit-msg>` 或
 *     `Co-Authored-By:` footer block）→ skip
 *   - 訊息為空 → skip
 */

// ── Keyword patterns ────────────────────────────────────────────────────────

/**
 * Trigger keywords：任一 match 即要求 cite。
 * 設計注意：
 *   1. release/v 後帶版本號（避免 "release/v" alone 過度寬泛 — 含路徑就應 cite）
 *   2. hotfix 須在「handoff context」——skip 條件已過濾 commit message context
 *   3. bump→release 支援 ASCII 箭頭 / → unicode 箭頭兩種寫法
 */
const HANDOFF_KEYWORD_PATTERNS = [
  /release flow/i,
  /git\s+merge\s+--no-ff\b/i,
  /production tag/i,
  /release\/v\d/i,
  /release\/\d{8}/i,
  /\bhotfix\b/i,
  /bump(?:→|->)+release/i,
  /bump merge 後/i,
  /archive recovery/i,
  /rule rationalization/i,
  // Release pipeline state-transition vocabulary (added per change
  // enforce-post-merge-release-handoff-routing — root cause: AI claimed
  // "next: consumer /devpro:sync-rules" after main merge in source repo without
  // citing AGENTS.md §8 submodule-locked-to-production semantics).
  /sync-rules/i,
  /consumer\s+(?:repo\s+)?sync/i,
  /sync\s*到\s*consumer/i,
  /submodule\s*鎖/i,
];

// ── Cite patterns ────────────────────────────────────────────────────────────

/**
 * cite pattern 1：file:line — `<file>:<line>` 明確 line ref
 * 支援 .md / .mjs / .cjs / .json / .sh 等常見 devpro rule/script 副檔名
 */
const CITE_FILE_LINE_RE =
  /[a-zA-Z0-9_.\/-]+\.(?:md|mjs|cjs|json|sh):\d+/;

/**
 * cite pattern 2：per `<file>` §<heading> cross-ref
 * 寬鬆：接受 per + file ref + § 或 § ... 結構
 */
const CITE_PER_SECTION_RE =
  /per\s+[`']?[a-zA-Z0-9_.\/-]+\.(?:md|mjs|cjs|json|sh)[`']?\s+§/i;

// ── Commit message context skip patterns ─────────────────────────────────────

/**
 * Skip 條件：訊息屬 commit message context。
 * 包含：
 *   - `git commit -m` 命令（shell block 或 inline）
 *   - heredoc `<commit-msg>` / `commit_msg` block 樣式
 *   - Co-Authored-By: footer（commit message 末尾標準 footer）
 * 目的：commit message 本身可合法含 hotfix / release/ 等字眼，不應觸發本 gate。
 */
const COMMIT_MSG_CONTEXT_PATTERNS = [
  /git\s+commit\s+-m\b/i,
  /<commit[-_]msg>/i,
  /Co-Authored-By:/i,
  /^Co-Authored-By:/m,
];

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * 偵測訊息是否屬 commit message context。
 * @param {string} messageText
 * @returns {boolean}
 */
function isCommitMessageContext(messageText) {
  return COMMIT_MSG_CONTEXT_PATTERNS.some((re) => re.test(messageText));
}

/**
 * 偵測訊息含任一 handoff keyword。
 * @param {string} messageText
 * @returns {string|null} 第一個命中的 keyword pattern source，或 null
 */
function detectHandoffKeyword(messageText) {
  for (const re of HANDOFF_KEYWORD_PATTERNS) {
    if (re.test(messageText)) return re.source;
  }
  return null;
}

/**
 * 偵測訊息含有效 cite（file:line 或 per § cross-ref）。
 * @param {string} messageText
 * @returns {boolean}
 */
function hasCite(messageText) {
  return CITE_FILE_LINE_RE.test(messageText) || CITE_PER_SECTION_RE.test(messageText);
}

/**
 * Gate A entry point：偵測 handoff keyword + cite 缺失。
 *
 * @param {{ messageText: string }} options
 * @returns {{ shouldBlock: boolean, message: string }}
 */
export function checkHandoffCite({ messageText }) {
  // Empty message → skip
  if (!messageText || !messageText.trim()) {
    return { shouldBlock: false, message: "" };
  }

  // Commit message context → skip（commit message 有獨立 footer gate）
  if (isCommitMessageContext(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // No handoff keyword → no issue
  const matchedKeyword = detectHandoffKeyword(messageText);
  if (!matchedKeyword) {
    return { shouldBlock: false, message: "" };
  }

  // Has cite → ok
  if (hasCite(messageText)) {
    return { shouldBlock: false, message: "" };
  }

  // Keyword found, no cite → block
  const blockMsg = [
    "### Gate A — Handoff Cite Gate 違規",
    "",
    `AI 訊息含 handoff keyword（pattern: \`${matchedKeyword}\`）但未引述 rule file:line。`,
    "",
    "**Block 原因**：",
    "AI 對 release flow / hotfix / bump→release / archive recovery / rule rationalization",
    "等非標準動作發表 handoff 陳述，必須引述具體 rule 來源（file:line 或 `per <file> §<heading>`），",
    "否則 AI 可能在錯誤引導使用者（如：該自己執行卻 handoff 給使用者；",
    "或引述錯誤操作如 cherry-pick 而非 git merge）。",
    "",
    "**要求**：在訊息中引述 rule 依據，例如：",
    "- `ai-autonomy.md:14` 或",
    "- `per \`release-sit-uat-pat-prod.md\` §Source Repo Specifics`",
    "",
    "Per Gate A spec：handoff-cite-gate.mjs。",
  ].join("\n");

  return { shouldBlock: true, message: blockMsg };
}

// ── Test exports ─────────────────────────────────────────────────────────────
// Named exports for unit tests; not used in production path beyond checkHandoffCite.
export {
  isCommitMessageContext,
  detectHandoffKeyword,
  hasCite,
  HANDOFF_KEYWORD_PATTERNS,
  CITE_FILE_LINE_RE,
  CITE_PER_SECTION_RE,
};
