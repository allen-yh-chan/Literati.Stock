/**
 * friction-log.mjs — Shared helper for session friction log
 *
 * Both PreToolUse mechanical gates (pre-tool-gate.mjs + gh-footer-gate.mjs)
 * import appendFrictionLog() to record hard-block events to a shared
 * state/session-friction.log file.
 *
 * session-start.mjs imports clearFrictionLog() to reset the log at the
 * start of each session (only current session's blocks are accumulated).
 *
 * Format: each line is `<ISO8601>\t<gate-name>`
 *
 * Env override: DEVPRO_FRICTION_LOG (for tests)
 * State-dir: DEVPRO_SENTINEL_STATE_DIR → co-located state/ (same convention as
 *            pre-tool-gate.mjs defaultSentinelDir / SENTINEL_DIR)
 */

import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function defaultStateDir() {
  // Co-located with hooks: .devpro/scripts/hooks/state/
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "state");
}

/**
 * Path to the friction log file.
 * Override via DEVPRO_FRICTION_LOG env (used in tests).
 */
export const FRICTION_LOG =
  process.env.DEVPRO_FRICTION_LOG ||
  path.join(
    process.env.DEVPRO_SENTINEL_STATE_DIR || defaultStateDir(),
    "session-friction.log"
  );

/**
 * Extract a recognisable gate name from the reason string.
 *
 * reason formats vary across hooks:
 *   - pre-tool-gate: "Protected-branch gate: ...", "Commit attribution gate...",
 *                    "Cross-Model Merge Gate...", "Force-push gate...",
 *                    "Merge strategy gate...", etc.
 *   - gh-footer-gate: "Footer missing: ...", "Footer format mismatch...",
 *                     "Footer gate...", "Footer version mismatch...",
 *                     "Attribution forbidden..."
 *
 * Strategy: take the first sentence (up to first '. ', ':\n', or end of
 * first line), then trim to ≤60 chars — enough to be identifiable but not
 * log-bloating.
 */
function extractGateName(reason) {
  if (!reason || typeof reason !== "string") return "unknown gate";
  // Take first line only
  const firstLine = reason.split(/\r?\n/)[0] || reason;
  // Trim at first colon boundary ("Gate name: detail" / "Gate name：detail").
  // reasons use both ASCII ': ' and fullwidth '：' (e.g. 'Advisory gate：...',
  // 'Cross-Model Merge Gate：...'); split at whichever appears first so the
  // gate label is isolated and any embedded detail (err.message / PR#) is dropped.
  const asciiIdx = firstLine.indexOf(": ");
  const fullwidthIdx = firstLine.indexOf("：");
  const candidates = [asciiIdx, fullwidthIdx].filter((i) => i !== -1);
  const colonIdx = candidates.length ? Math.min(...candidates) : -1;
  const prefix = colonIdx !== -1 ? firstLine.slice(0, colonIdx) : firstLine;
  return prefix.trim().slice(0, 60) || "unknown gate";
}

/**
 * Append one hard-block event to the friction log.
 * Fail-open: any fs error is silently swallowed (must not block the gate flow).
 *
 * @param {string} reason — the reason string passed to emitBlock() / block()
 */
export function appendFrictionLog(reason) {
  try {
    const logPath = FRICTION_LOG;
    mkdirSync(path.dirname(logPath), { recursive: true });
    const gateName = extractGateName(reason);
    const line = `${new Date().toISOString()}\t${gateName}\n`;
    appendFileSync(logPath, line, "utf8");
  } catch {
    // fail-open: log write must not interrupt the gate block path
  }
}

/**
 * Clear (delete) the friction log at session start.
 * Fail-open: any fs error is silently swallowed (must not block session start).
 */
export function clearFrictionLog() {
  try {
    rmSync(FRICTION_LOG, { force: true });
  } catch {
    // fail-open: clear failure must not block session start
  }
}
