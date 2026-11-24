/**
 * Shared Stop hot-path cleanup budget + review-round sidecar cursor helpers.
 * Used by post-pr-completion-check.mjs so advisory cleanup phases cannot each
 * reset a full budget window (post-#2561 parity follow-up).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STOP_HOTPATH_CLEANUP_BUDGET_MS = 2500;
export const SIDECAR_CLEANUP_CURSOR_FILE = ".review-round-sidecar-cleanup-cursor.json";

export function createStopHotpathBudget(
  budgetMs = STOP_HOTPATH_CLEANUP_BUDGET_MS,
  now = Date.now(),
) {
  const windowMs = Math.max(0, Number(budgetMs) || 0);
  const deadline = now + windowMs;
  return {
    windowMs,
    deadline,
    remainingMs(at = Date.now()) {
      return Math.max(0, deadline - at);
    },
    exhausted(at = Date.now()) {
      return at >= deadline;
    },
  };
}

/** Cap a single network/subprocess probe by the shared wallet remainder. */
export function probeTimeoutMs(budget, { maxMs = 5000, at = Date.now() } = {}) {
  const max = Math.max(1, Number(maxMs) || 5000);
  if (!budget || typeof budget.remainingMs !== "function") return max;
  const remaining = budget.remainingMs(at);
  if (remaining <= 0) return 0;
  return Math.max(1, Math.min(max, remaining));
}

/** Wall-clock remaining for a deadline-bound multi-step probe (light → full). */
export function remainingMsUntil(deadline, at = Date.now()) {
  return Math.max(0, Number(deadline) - Number(at));
}

/**
 * Timeout for the next subprocess call inside a deadline-bound snapshot fetch.
 * Returns 0 when the remaining slice is below minMs (caller MUST skip).
 */
export function nextDeadlineBoundTimeoutMs({
  deadline,
  now = Date.now(),
  minMs = 50,
} = {}) {
  const remaining = remainingMsUntil(deadline, now);
  if (remaining < Math.max(0, Number(minMs) || 0)) return 0;
  return remaining;
}

export function readSidecarCleanupCursor(cursorDir) {
  const cursorPath = path.join(cursorDir, SIDECAR_CLEANUP_CURSOR_FILE);
  try {
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
    if (Number.isInteger(cursor?.next_index) && cursor.next_index >= 0) {
      return cursor.next_index;
    }
  } catch {
    // missing/corrupt cursor → start at 0
  }
  return 0;
}

export function writeSidecarCleanupCursor(cursorDir, nextIndex, now = Date.now()) {
  const cursorPath = path.join(cursorDir, SIDECAR_CLEANUP_CURSOR_FILE);
  try {
    writeFileSync(
      cursorPath,
      `${JSON.stringify({
        next_index: nextIndex,
        updated_at: new Date(now).toISOString(),
      })}\n`,
      "utf8",
    );
  } catch {
    // Cursor persistence is advisory.
  }
}

/**
 * Stable order for cursor math: numeric PR ascending, then lexical.
 */
export function sortReviewRoundSidecars(sidecars) {
  return [...sidecars].sort((left, right) => {
    const ln = Number(left.prNumber);
    const rn = Number(right.prNumber);
    if (Number.isFinite(ln) && Number.isFinite(rn) && ln !== rn) return ln - rn;
    return String(left.prNumber).localeCompare(String(right.prNumber));
  });
}

export function rotateSidecarList(sidecars, startIndex) {
  if (sidecars.length === 0) return [];
  const start = ((startIndex % sidecars.length) + sidecars.length) % sidecars.length;
  return sidecars.slice(start).concat(sidecars.slice(0, start));
}

export function nextSidecarCursorIndex({
  sidecars,
  lastAttemptedPrNumber = null,
  startIndex = 0,
} = {}) {
  if (!Array.isArray(sidecars) || sidecars.length === 0) return 0;
  if (lastAttemptedPrNumber != null) {
    const attemptedAt = sidecars.findIndex(
      (row) => String(row.prNumber) === String(lastAttemptedPrNumber),
    );
    if (attemptedAt >= 0) return (attemptedAt + 1) % sidecars.length;
  }
  return (startIndex + 1) % sidecars.length;
}

/**
 * Budgeted sidecar orphan probe loop with cursor rotation.
 * `probeSidecar(sidecar)` returns { cleared: boolean } | throws.
 */
export async function runBudgetedReviewRoundSidecarCleanup({
  sidecars,
  markerPrs = new Set(),
  now = Date.now(),
  budget,
  cursorDir,
  orphanSidecarProbeIntervalMs,
  probeSidecar,
} = {}) {
  const ordered = sortReviewRoundSidecars(sidecars ?? []);
  if (ordered.length === 0) {
    return { scanned: 0, attempted: 0, cleared: 0, budgetExhausted: false, nextIndex: 0 };
  }
  const startIndex = cursorDir && existsSync(cursorDir)
    ? readSidecarCleanupCursor(cursorDir) % ordered.length
    : 0;
  const rotated = rotateSidecarList(ordered, startIndex);
  let attempted = 0;
  let cleared = 0;
  let lastAttemptedPrNumber = null;
  let budgetExhausted = false;

  for (const sidecar of rotated) {
    if (budget?.exhausted?.()) {
      budgetExhausted = true;
      break;
    }
    try {
      if (!/^\d+$/.test(sidecar.prNumber)) continue;
      if (markerPrs.has(String(sidecar.prNumber))) continue;
      const intervalMs = typeof orphanSidecarProbeIntervalMs === "function"
        ? orphanSidecarProbeIntervalMs(sidecar.prNumber)
        : 0;
      if (now - sidecar.mtimeMs < intervalMs) continue;

      // Count only due probes against the shared wallet.
      if (budget?.exhausted?.()) {
        budgetExhausted = true;
        break;
      }
      const timeoutMs = probeTimeoutMs(budget);
      if (timeoutMs <= 0) {
        budgetExhausted = true;
        break;
      }
      const result = await probeSidecar(sidecar, { timeoutMs, remainingMs: timeoutMs });
      lastAttemptedPrNumber = sidecar.prNumber;
      attempted += 1;
      if (result?.cleared) cleared += 1;
      if (budget?.exhausted?.()) {
        budgetExhausted = true;
        break;
      }
    } catch {
      lastAttemptedPrNumber = sidecar.prNumber;
      attempted += 1;
    }
  }

  const nextIndex = nextSidecarCursorIndex({
    sidecars: ordered,
    lastAttemptedPrNumber,
    startIndex,
  });
  if (cursorDir) writeSidecarCleanupCursor(cursorDir, nextIndex, now);
  return {
    scanned: ordered.length,
    attempted,
    cleared,
    budgetExhausted,
    startIndex,
    nextIndex,
    lastAttemptedPrNumber,
  };
}
