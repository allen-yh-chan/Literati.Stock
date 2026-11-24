/**
 * D12 shared change-name resolution for the cost-circuit-breaker's two
 * enforcement carriers: render-second-review-packet.mjs (task 6, handoff-
 * supplied `change_name`) and post-pr-completion-check.mjs (task 7, branch-
 * name-derived `change_name`). design.md D12 (round 5 finding F-5-5, round 6
 * finding F-6-3) requires both callers to apply the identical grammar and
 * existence-check flow ("兩處對稱處理") and to degrade identically —
 * missing / malformed / folder-nonexistent `change_name` all resolve
 * thresholds (a)(b)(c) to `unavailable`, never a block. This module has no
 * opinion on where `change_name` came from; each caller resolves it their
 * own way (handoff field vs. branch-name prefix-strip) and passes the
 * resulting string in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readChangeUsageCheckpoint, readSessionChangeTransitions } from "../hooks/lib/change-usage-checkpoint.mjs";
import { aggregateSinceChangeUsage, collectSessionUsage, resolveRoots, unionCheckpointMeasurementSessions } from "./session-token-usage.mjs";

// D12: single kebab-case segment — byte-identical to git-branch-naming-and-
// anchor.md's branch `<name>` grammar (not a new namespace). Exported so
// task 7's post-PR-check can validate its branch-derived change_name against
// the exact same pattern rather than a second copy.
export const CHANGE_NAME_GRAMMAR = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * D12 F-2-3/F-5-5: `changeName` resolves to a folder iff it is the basename
 * of an active `openspec/changes/<changeName>/` directory, OR the archive
 * glob `openspec/changes/archive/*-<changeName>/` matches EXACTLY one entry
 * (zero or >1 matches — the latter a repo-anomaly case F-2-3 explicitly
 * calls out — both resolve `false`, not a third state; this function only
 * answers "resolvable to exactly one folder or not").
 */
export function changeNameFolderExists({ changeName, cwd = process.cwd() } = {}) {
  const activeDir = path.join(cwd, "openspec", "changes", changeName);
  try {
    if (fs.statSync(activeDir).isDirectory()) return true;
  } catch {
    // ENOENT or not-a-directory — fall through to the archive check.
  }
  const archiveRoot = path.join(cwd, "openspec", "changes", "archive");
  let entries;
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  const suffix = `-${changeName}`;
  const matches = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix));
  return matches.length === 1;
}

/**
 * Resolves `changeName` -> an `aggregateSinceChangeUsage` rollup suitable for
 * `evaluateCostBudget`'s `usage` argument, or `undefined` when `changeName`
 * is missing, fails `CHANGE_NAME_GRAMMAR`, does not resolve via
 * `changeNameFolderExists`, or its checkpoint is unavailable.
 *
 * `undefined` is a deliberate signal, not an error: callers pass it straight
 * through as `evaluateCostBudget`'s `usage` argument, whose own
 * `usage?.totals ?? {}` default plus `evaluateNumericThreshold`'s
 * `Number.isFinite` guard (task 4 fail-open fix) already resolve thresholds
 * (a)(b)(c) to `unavailable` — this function does not duplicate that logic,
 * it only decides whether a resolvable usage rollup exists at all. This
 * function never throws for a resolution failure; a checkpoint or session
 * read failure inside `aggregateSinceChangeUsage`/`readChangeUsageCheckpoint`
 * is their own established `unavailable`-shaped contract (NFR-2), not
 * something this function re-wraps.
 */
export function resolveChangeCostUsage({ changeName, cwd = process.cwd(), env = process.env, checkpointStateDir } = {}) {
  if (typeof changeName !== "string" || changeName.length === 0) return undefined;
  if (!CHANGE_NAME_GRAMMAR.test(changeName)) return undefined;
  if (!changeNameFolderExists({ changeName, cwd })) return undefined;
  const checkpoint = readChangeUsageCheckpoint({ cwd, changeName, stateDir: checkpointStateDir });
  if (checkpoint.status !== "ok") return undefined;
  const homeDir = env.HOME ?? os.homedir();
  const roots = resolveRoots(env, homeDir);
  return aggregateSinceChangeUsage({
    sessions: unionCheckpointMeasurementSessions(checkpoint),
    changeName,
    collectSessionUsage,
    roots,
    env,
    getSessionTransitions: (session_id) => readSessionChangeTransitions({ cwd, session_id, stateDir: checkpointStateDir }),
  });
}
