// Zero-diff production ancestry repair: a `bugfix/fix-production-ancestry-<production-tag>` PR that only merges
// the exact production tag and whose three-dot diff against its base is empty carries no content to review, so
// the cross-model gate exempts it. Its base is `main` (git-branch-production-ancestry-repair.md) or a
// `release/rules-*` carrier (release-rules-lane.md §Carrier ancestry repair); any other base is not exempt.
// Every condition is proven from the caller's PR base, complete changed-file list and the local git objects;
// anything unknown is "not exempt", so the PR falls back to an ordinary second review or a Path W decision.
import { spawnSync } from "node:child_process";
import { isRulesLaneReleaseBranchExempt } from "./github-merge-exemptions.mjs";

export const ANCESTRY_REPAIR_BRANCH_RE = /^bugfix\/fix-production-ancestry-[^\s/]+$/;
export const ZERO_DIFF_ANCESTRY_REPAIR_REASON =
  "zero-diff ancestry repair: bugfix/fix-production-ancestry-* 合入 main 或 release/rules-* carrier，三點 diff 為空，head 是 merge 確切 production-* tag 的 merge commit";

const SHA_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 5000;

function gitOut(args, cwd, spawnSyncImpl) {
  const result = spawnSyncImpl("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.error || result.status !== 0 ? null : String(result.stdout ?? "");
}

/**
 * True only when all of these are proven:
 * - `headRefName` is `bugfix/fix-production-ancestry-<tag>`;
 * - `baseRefName` (the PR base branch name, without `origin/`) is `main` or a `release/rules-<YYYYMMDD>[-<n>]`
 *   carrier; a caller that cannot read the base passes nothing;
 * - `changedFiles` is the PR's complete changed-file list and it is empty (callers pass null, never [], when the
 *   list is unknown);
 * - `headSha` is a local merge commit, and one of its parents after the first is the commit a `production-*` tag
 *   points at (the tag is not derived from the branch name, which is only a branch-valid normalization).
 */
export function isZeroDiffAncestryRepair({
  headRefName,
  baseRefName,
  changedFiles,
  headSha,
  cwd = process.cwd(),
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!ANCESTRY_REPAIR_BRANCH_RE.test(typeof headRefName === "string" ? headRefName : "")) return false;
  if (baseRefName !== "main" && !isRulesLaneReleaseBranchExempt(typeof baseRefName === "string" ? baseRefName : "")) return false;
  if (!Array.isArray(changedFiles) || changedFiles.length !== 0) return false;
  if (!SHA_RE.test(typeof headSha === "string" ? headSha : "")) return false;
  const line = gitOut(["rev-list", "--parents", "-n", "1", headSha], cwd, spawnSyncImpl);
  const ids = line === null ? [] : line.trim().split(/\s+/);
  if (ids[0] !== headSha || ids.length < 3 || !ids.every((id) => SHA_RE.test(id))) return false;
  return ids.slice(2).some((parent) => {
    const tags = gitOut(["tag", "--points-at", parent, "--list", "production-*"], cwd, spawnSyncImpl);
    return tags !== null && tags.trim() !== "";
  });
}
