#!/usr/bin/env node
/**
 * session-start.mjs — SessionStart hook
 *
 * 兩段式輸出：
 *   1. AGENTS.md SSOT pointer + session-pending 接續提示（避免重複注入 AGENTS.md 長段）
 *   2. 同 session Recap state 留存於 scoped namespace；啟動不注入 backlog。
 *
 * Recap obligations persist in stable-session state for resume. Reminder
 * evaluators run at actual closeout/user-end boundaries, never at startup.
 *
 * Runtime compat：SessionStart emits
 * `hookSpecificOutput.additionalContext`. Codex rejects the older top-level
 * `additional_context` JSON shape as invalid SessionStart output.
 */

import { readStdin } from "./lib/stdin.mjs";
import { scanPendingCdSentinels } from "./pre-tool-gate.mjs";
import { ensureGitHooksPath, getRepoRoot } from "./lib/git-utils.mjs";
import { resolveRigorSelection } from "./lib/rigor-level.mjs";
import { clearFrictionLog } from "./lib/friction-log.mjs";
import { buildSubmoduleDriftSection } from "./lib/submodule-drift.mjs";
import {
  applySessionStartRuleLoadLedger,
  parseScopedRuleLoadIdSegment,
  RULE_LOAD_LEDGER_STATE_PREFIX,
  sessionRuleLoadIdentity,
  sessionStartSource,
} from "./lib/rule-load-session-ledger.mjs";
import { defaultRepoStateDir } from "./lib/repo-state-identity.mjs";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const msg = [
  "session-pending：待辦/缺口當下處理不了 → 記入 `notes/session-pending.md`（新 session 接續用；compact 隨時來不丟）",
  "",
  "AGENTS.md 是啟動規範 SSOT：若本 session 尚未載入，先讀 AGENTS.md 並輸出載入宣告；若同 session 已載入且未變更，勿因本提醒重讀。",
  "",
  "載入宣告 MUST follow `platform-adapter-contract.md`: trusted exact host/runtime session metadata -> trusted family/config alias -> `unknown`；不得猜測 minor/version/variant。",
  "Footer/attribution/provenance MUST reuse the same resolved identity and MUST NOT become more specific。",
  "",
  "載入後依 AGENTS.md 的動手前自檢、Intent 速查、輸出紀律與觸發式 leaf 索引行動。",
  "",
  "停下/交棒依 AGENTS.md + stop-point-comms.md：結尾含為什麼停／要你做什麼／回了會怎樣；選項編號且末項開放。",
].join("\n");

/**
 * Lite session-start message for level=lite.
 * Announces exemptions AND retained gates so advisory matches enforcement.
 * Must NOT replace or modify `const msg` / `const msgLean` (payload-sync sandbox).
 *
 * full: msg；lite: msgLite；off: msgLean.
 */
const msgLite = [
  "AGENTS.md：Intent SSOT；未載入先讀並宣告。",
  "",
  "session-pending：待辦/缺口當下處理不了 → 記入 `notes/session-pending.md`",
  "",
  "**載入宣告**：已載入 Devpro Agent Rules（level=lite：免 OpenSpec/pre-flight/六軸/simplify/Recap/multi-agent、advisory/nudge、stop-handoff-cite；保留 4 底線、測試綠燈、cooperative含SQL、post-pr-completion、P2 keep/P3 degrade；cross-model-sticky-merge-review 仍 BLOCK）。",
  "",
  "載入宣告 MUST follow `platform-adapter-contract.md`: trusted exact -> trusted family/config alias -> `unknown`。",
  "Footer/attribution/provenance MUST reuse same resolved identity；不得更具體。",
  "保留 Consumer Pre-PR Checks；開 PR 前仍須 /devpro:pre-pr。",
  "B 形狀不等於 full；升 full 先讀 rules-rigor-level.md、說明理由並取得使用者明確同意。",
].join("\n");

/**
 * Lean session-start message for level=off.
 * Contains only the load announcement equivalent and session-pending reminder.
 * Must NOT replace or modify `const msg` (hook-payload-sync test inspects the
 * msg array literal).
 *
 * off: msgLean is used — minimal footprint.
 */
const msgLean = [
  "session-pending：待辦/缺口當下處理不了 → 記入 `notes/session-pending.md`（新 session 接續用；compact 隨時來不丟）",
  "",
  "**載入宣告**：已載入 Devpro Agent Rules（level=off：僅 baseline 安全 gate 與動態提醒）。",
  "",
  "載入宣告 MUST follow `platform-adapter-contract.md`: trusted exact host/runtime session metadata -> trusted family/config alias -> `unknown`；不得猜測 minor/version/variant。",
  "Footer/attribution/provenance MUST reuse the same resolved identity and MUST NOT become more specific。",
].join("\n");

/**
 * Conditional pointer when consumer root `AGENTS.local.md` exists.
 * Pointer-only — never inject overlay body. Keep ≤50B so full msg (850B) /
 * msgLite (≤850B) + this section (+ the 50B submodule-drift cue) stays within hook-payload-policy 1000B.
 * Absent file → "" (no-op).
 */
function buildLocalOverlaySection(repoRoot) {
  if (!existsSync(path.join(repoRoot, "AGENTS.local.md"))) {
    return "";
  }
  // Exact UTF-8 length 50 — do not expand without re-measuring live payload.
  return "\n---\nAGENTS.local.md：additive-only；source wins";
}

function buildSessionStartPayload(output) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: output,
    },
  };
}

// ── Scoped rule-load state house-keeping (T5) ────────────────────────────
// Subagent-scope dispatch (see rule-load-session-ledger.mjs's
// subagentRuleLoadSuffix) fans out both the ledger and diagnostic families
// into per-subagent sibling files:
//   rule-load-session-ledger-<mainId><SCOPED_SUFFIX_DELIMITER><subagentSuffix>.json
//   rule-load-host-diagnostic-<mainId><SCOPED_SUFFIX_DELIMITER><subagentSuffix>.jsonl
// These accumulate over a session's lifetime (one per parallel subagent
// fan-out) and are never otherwise cleaned up. This sweep does two things,
// scanning the shared state dir (both families live under the same
// RULE_LOAD_LEDGER_STATE_PREFIX directory) in a single pass:
//   1. Connected clear: when SessionStart source is "clear"/"startup" (i.e.
//      the main session's own ledger is being reset — see
//      applySessionStartRuleLoadLedger), remove every scoped sibling file
//      derived from the same main session identity, since those subagents'
//      state is no longer relevant to the fresh main context.
//   2. TTL sweep: regardless of source, remove any scoped sibling file
//      (either family, any main id) older than SCOPED_STATE_TTL_MS — orphaned
//      leftovers from subagents whose main session never reached a
//      clear/startup SessionStart (e.g., abandoned/crashed sessions).
// Fail-open throughout: any error here must never block SessionStart's main
// output message (mirrors scanPendingCdSentinels()'s fail-open contract in
// pre-tool-gate.mjs).
//
// Base-vs-scoped disambiguation is STRUCTURAL, not a textual guess: a
// filename's id segment is "scoped" iff it contains
// rule-load-session-ledger.mjs's SCOPED_SUFFIX_DELIMITER ("~sub~"). That
// delimiter uses "~", a character outside safeSessionStateSuffix's sanitize
// alphabet ([A-Za-z0-9_.-], or [0-9a-f] in its hash-fallback branch), so it
// can never appear inside a sanitized base id or subagent suffix — even a
// UUID session id (which is mostly "-") cannot produce a false "scoped"
// match. See parseScopedRuleLoadIdSegment in rule-load-session-ledger.mjs.
const SCOPED_STATE_TTL_MS = 86_400_000; // 1 day — mirrors pre-tool-gate.mjs's SENTINEL_TTL_MS

const SCOPED_FAMILY_PATTERNS = [
  { prefix: "rule-load-session-ledger-", suffix: ".json" },
  { prefix: "rule-load-host-diagnostic-", suffix: ".jsonl" },
];

function scopedStateDir(cwd = process.cwd()) {
  return process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR ||
    defaultRepoStateDir(RULE_LOAD_LEDGER_STATE_PREFIX, cwd);
}

/**
 * Returns the matching { prefix, suffix } pattern for a rule-load-ledger or
 * rule-load-host-diagnostic filename, or null if the filename matches
 * neither family. Callers strip prefix/suffix to get the id segment, then
 * parse it via parseScopedRuleLoadIdSegment to determine base vs scoped.
 */
function scopedFamilyMatch(filename) {
  for (const { prefix, suffix } of SCOPED_FAMILY_PATTERNS) {
    if (filename.startsWith(prefix) && filename.endsWith(suffix)) {
      return { prefix, suffix };
    }
  }
  return null;
}

/**
 * Sweep the shared rule-load state dir for scoped sibling files:
 *   - connected clear: unlink scoped siblings whose baseId equals the
 *     current main session id (only when source is clear/startup)
 *   - TTL sweep: unlink any scoped sibling (either family, any main id)
 *     older than SCOPED_STATE_TTL_MS
 * Base (unscoped) files — id segment contains no SCOPED_SUFFIX_DELIMITER —
 * are never touched by either pass, regardless of how many literal "-"
 * characters their (possibly UUID) session id contains.
 */
function sweepScopedRuleLoadState(payload = {}) {
  try {
    const dir = scopedStateDir();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir doesn't exist yet — nothing to sweep
    }

    const source = sessionStartSource(payload);
    const connectedClear = source === "clear" || source === "startup";
    const mainId = connectedClear ? sessionRuleLoadIdentity(payload) : "";
    const now = Date.now();

    for (const filename of entries) {
      const match = scopedFamilyMatch(filename);
      if (!match) continue;
      const idSegment = filename.slice(match.prefix.length, -match.suffix.length);
      const { baseId, subagentSuffix } = parseScopedRuleLoadIdSegment(idSegment);
      const isScoped = Boolean(subagentSuffix);
      if (!isScoped) continue; // base (unscoped) file — never touched

      const isConnectedSibling = connectedClear && mainId && baseId === mainId;
      let isExpiredSibling = false;
      if (!isConnectedSibling) {
        try {
          const full = path.join(dir, filename);
          const stat = statSync(full);
          isExpiredSibling = now - stat.mtimeMs > SCOPED_STATE_TTL_MS;
        } catch {
          isExpiredSibling = false;
        }
      }

      if (isConnectedSibling || isExpiredSibling) {
        try {
          unlinkSync(path.join(dir, filename));
        } catch {
          // ignore — best-effort cleanup
        }
      }
    }
  } catch {
    // fail-open: sweep failure must never block SessionStart
  }
}

async function readHookPayload() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = (await readStdin()).trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const hookPayload = await readHookPayload();

  // Ensure deletion guard is reachable without disabling consumer hooks:
  // unset／owned → absolute hooks-git; foreign／husky → preserve hooksPath + chain.
  // Idempotent, fail-open (GH-2483-a coexistence).
  ensureGitHooksPath();

  // Gate D' TTL sweep: clean expired pending-cd-to-worktree sentinels on
  // session start (sentinel TTL = 1 day). scanPendingCdSentinels() deletes
  // expired files as a side-effect; we discard the return value here.
  try {
    scanPendingCdSentinels();
  } catch {
    // Sentinel sweep failure must not block session start
  }

  // Clear friction log at session start so only current session's hard-block
  // events accumulate. Fail-open: clear failure must not block session start.
  try {
    clearFrictionLog();
  } catch {
    // fail-open
  }

  // Source-aware rule-load ledger lifecycle. SessionStart is not synonymous
  // with context reset: clear/startup reset, compact advances epoch, resume
  // preserves reliable state, and unknown source disables duplicate blocking.
  // Fail-open: ledger lifecycle must not block session start.
  try {
    applySessionStartRuleLoadLedger(hookPayload);
  } catch {
    // fail-open
  }

  // Subagent-scoped ledger/diagnostic sibling house-keeping (T5): connected
  // clear on main clear/startup + TTL sweep of orphaned scoped siblings.
  // Fail-open: sweep failure must not block session start.
  try {
    sweepScopedRuleLoadState(hookPayload);
  } catch {
    // fail-open
  }

  // Select base message based on rigor level.
  // full → AGENTS.md SSOT pointer；lite → short SSOT + exemptions/retained；off → lean.
  const selection = resolveRigorSelection();
  const level = selection.level;
  let output =
    level === "off" ? msgLean : level === "lite" || !selection.valid ? msgLite : msg;
  if (!selection.valid) output += '\n設定無效：hooks full；修設定，full 未授權。';
  // Stable session state remains on disk for resume; startup never consumes Recap dedup.
  try {
    // full/lite/off 共用：overlay 存在才 append pointer；偵測失敗不阻 session start。
    // Prefer git toplevel so nested cwd still sees consumer-root AGENTS.local.md;
    // non-git / fail-open falls back to process.cwd() (fixture + edge cases).
    const overlayRoot = getRepoRoot(process.cwd()) || process.cwd();
    output += buildLocalOverlaySection(overlayRoot);
  } catch {
    // fail-open: AGENTS.local.md detection must not block SessionStart
  }
  try {
    // full/lite/off 共用：consumer 的 `.devpro-agent-rules` checkout 與 HEAD 記錄的 pointer 不一致（`git pull` 不會移動 submodule）才 append
    // 一行指向 doctor 的提醒（#2904）；修法與措辭歸 devpro-doctor，本處只留 ≤50B 的 pointer（最壞組合 850+50+50=950B）以守 1000B payload 預算。
    output += buildSubmoduleDriftSection(getRepoRoot(process.cwd()) || process.cwd());
  } catch {
    // fail-open: submodule drift detection must not block SessionStart
  }

  process.stdout.write(JSON.stringify(buildSessionStartPayload(output)));
}

main().catch((err) => {
  // Silent fail — 不該因 hook bug 卡 session 啟動
  process.stderr.write(`session-start hook error: ${err.message}\n`);
  // 至少輸出 base msg 維持原行為
  process.stdout.write(JSON.stringify(buildSessionStartPayload(msg)));
});
