/**
 * reviewer-process-guard.mjs
 *
 * Output bounds and process-tree cleanup for a reviewer CLI that the ordinary-primary route runs
 * directly (lib/opencode-primary-review.mjs). The second-review runner keeps equivalent private
 * helpers inside run-second-reviewer-projection.mjs; their behaviour is the reference here
 * (a line of at most 64 KiB, excluding its newline, is accepted; one byte more overflows), but
 * they are not importable from that script, so this module carries the small part this route needs.
 *
 * Why it exists: a reviewer child that keeps writing without a newline, or that leaves a
 * descendant holding the stdout/stderr pipes, must not be able to grow the wrapper's memory or to
 * keep the hard timeout from ever settling.
 */

import { spawnSync } from "node:child_process";

export const MAX_REVIEWER_OUTPUT_LINE_BYTES = 64 * 1024;
// `taskkill` is a synchronous call on the cleanup path; without its own deadline a stalled one would defeat the
// bounded cleanup it is part of.
export const TASKKILL_TIMEOUT_MS = 10_000;

/** POSIX runs the reviewer as a process-group leader; Windows has no groups and uses `taskkill /T`. */
export function supportsProcessGroups(platform = process.platform) {
  return platform !== "win32";
}

/**
 * Splits a byte stream into lines. A line may hold at most `maxBytes` bytes (the newline is not
 * counted); the first byte beyond that latches an overflow and the accumulator stops for good.
 */
export function createBoundedLineAccumulator({ onLine, onOverflow, maxBytes = MAX_REVIEWER_OUTPUT_LINE_BYTES }) {
  let chunks = [];
  let byteLength = 0;
  let overflowed = false;

  function append(segment) {
    if (overflowed || segment.length === 0) return;
    if (byteLength + segment.length > maxBytes) {
      chunks = [];
      byteLength = 0;
      overflowed = true;
      onOverflow({ maxBytes });
      return;
    }
    chunks.push(Buffer.from(segment));
    byteLength += segment.length;
  }

  function emit() {
    if (overflowed) return;
    const line = chunks.length === 0 ? "" : Buffer.concat(chunks, byteLength).toString("utf8");
    chunks = [];
    byteLength = 0;
    onLine(line);
  }

  return Object.freeze({
    write(chunk) {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < buffer.length && !overflowed) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline < 0) {
          append(buffer.subarray(start));
          break;
        }
        append(buffer.subarray(start, newline));
        emit();
        start = newline + 1;
      }
    },
    end() {
      if (overflowed) return;
      if (byteLength > 0) emit();
    },
  });
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * True when no process of the group is left (`kill(-pgid, 0)` reports ESRCH). EPERM means a member exists
 * that cannot be signalled at this moment (macOS answers so for a process that is on its way out): the
 * group is not provably empty, which is "not gone", not a failure of the probe.
 */
export function processGroupGone(pgid, { killProcess = process.kill } = {}) {
  if (!validPid(pgid)) return true;
  try {
    killProcess(-pgid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

/**
 * Ends the child and everything it started. POSIX: SIGKILL to the whole group (the child was
 * spawned detached, so its pid is the group id). Windows: `taskkill /T /F`. A child without a
 * usable pid (an injected test double) falls back to `child.kill`. On Windows the outcome carries
 * `unconfirmed: true` unless taskkill ran, finished within its deadline and exited 0, so the caller never
 * takes a tree for gone on anything less.
 */
export function terminateProcessTree(child, {
  platform = process.platform,
  killProcess = process.kill,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!validPid(child?.pid)) {
    try { child?.kill?.("SIGKILL"); } catch { /* already gone */ }
    return { method: "child-kill" };
  }
  if (!supportsProcessGroups(platform)) {
    let unconfirmed = false;
    try {
      const killed = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore", timeout: TASKKILL_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      // Only a clean exit confirms it. An error (timed out, could not start) does not, and neither does a taskkill
      // that ran and failed (1: access denied or the tree could not be ended; no `error` is set for that) or one
      // that found nothing to kill (128): a vanished root says nothing about the descendants it left behind.
      unconfirmed = Boolean(killed?.error) || killed?.status !== 0;
    } catch {
      unconfirmed = true;
    }
    return { method: "taskkill-tree", unconfirmed };
  }
  try {
    killProcess(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  return { method: "process-group-sigkill" };
}

/**
 * After the child is gone: make sure no descendant is left in its group. Resolves to true when
 * the group is empty, false when something survived the SIGKILL for `timeoutMs`.
 * Windows has no group to probe; the tree kill above is all that can be done there.
 */
export async function sweepProcessGroup(child, {
  platform = process.platform,
  killProcess = process.kill,
  timeoutMs = 1000,
  intervalMs = 25,
} = {}) {
  if (!supportsProcessGroups(platform) || !validPid(child?.pid)) return true;
  const deadline = Date.now() + timeoutMs;
  if (processGroupGone(child.pid, { killProcess })) return true;
  try {
    killProcess(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  while (Date.now() < deadline) {
    if (processGroupGone(child.pid, { killProcess })) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return processGroupGone(child.pid, { killProcess });
}

/**
 * `spawnSync` for a tool that must not be able to outlive its deadline or its call. The default kill
 * signal of a timed-out `spawnSync` is SIGTERM, which the tool can ignore (and the call then does not
 * return); the tool also keeps any descendant it started. So: SIGKILL, and on POSIX the tool leads its
 * own process group, which is swept once the call returns. Windows has no group to sweep after the
 * fact; a descendant of an already-dead process cannot be reached from here.
 */
export function spawnSyncBounded(executable, argv, options = {}, {
  platform = process.platform,
  killProcess = process.kill,
  spawnSyncImpl = spawnSync,
} = {}) {
  const grouped = supportsProcessGroups(platform);
  const result = spawnSyncImpl(executable, argv, { ...options, killSignal: "SIGKILL", detached: grouped });
  if (grouped && validPid(result?.pid)) {
    try {
      killProcess(-result.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return result;
}
