/**
 * submodule-drift.mjs — SessionStart cue for a consumer clone whose `.devpro-agent-rules` checkout is not at the pointer HEAD records.
 *
 * `git pull` in a clone that never ran the rules sync (cloud routine, teammate, second machine) does not move a submodule to the new
 * gitlink, so `git submodule status` leads with `+` (checkout differs), `-` (never initialised) or `U` (unmerged); a space means
 * aligned. devpro-doctor reports the same state, but only when somebody runs it, so the stale rules were found by chance (#2904).
 *
 * The cue is pointer-only on purpose: the SessionStart payload has a 1000-byte budget (hook-payload-policy), and the worst fixed
 * composition is the full-level base message (850) + the AGENTS.local.md pointer (50) + this cue (50) = 950, so the cue stays at
 * 50 bytes and does not carry the fix command. The wording of the fix ("git submodule update --init", "do not commit this
 * difference") lives in devpro-doctor.mjs, the single owner.
 *
 * Read-only, local (no network), one bounded git call, and only in a repo that declares the submodule. Every failure is a no-cue.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const RULES_SUBMODULE_PATH = ".devpro-agent-rules";
const STATUS_TIMEOUT_MS = 3000;

// Same declaration test as repo-identity.mjs consumerRootHasPositiveEvidence: `.gitmodules` carries `path = .devpro-agent-rules`.
const DECLARES_RULES_SUBMODULE = /^\s*path\s*=\s*\.devpro-agent-rules\s*$/m;

// Exactly 50 UTF-8 bytes: with the full base message and the AGENTS.local.md pointer the payload is 950 of the 1000-byte budget.
// Do not lengthen without re-measuring the live payload (hook-session-start-submodule-drift.test.mjs asserts the total).
export const SUBMODULE_DRIFT_CUE = "\n---\n.devpro-agent-rules 未對齊：devpro-doctor";

function declaresRulesSubmodule(repoRoot) {
  try {
    const gitmodules = path.join(repoRoot, ".gitmodules");
    return existsSync(gitmodules) && DECLARES_RULES_SUBMODULE.test(readFileSync(gitmodules, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Returns "+", "-" or "U" when the rules submodule is declared and its checkout is not aligned with the recorded pointer, else null
 * (aligned, not declared, or anything that could not be read).
 */
export function readSubmoduleDriftMarker(repoRoot, runner = spawnSync) {
  if (!declaresRulesSubmodule(repoRoot)) return null;
  try {
    const result = runner("git", ["-C", repoRoot, "submodule", "status", RULES_SUBMODULE_PATH], {
      encoding: "utf8",
      timeout: STATUS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return null;
    const marker = String(result.stdout ?? "").charAt(0);
    return marker === "+" || marker === "-" || marker === "U" ? marker : null;
  } catch {
    return null;
  }
}

export function buildSubmoduleDriftSection(repoRoot, runner) {
  return readSubmoduleDriftMarker(repoRoot, runner) === null ? "" : SUBMODULE_DRIFT_CUE;
}
