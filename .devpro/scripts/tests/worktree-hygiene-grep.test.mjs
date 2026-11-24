/**
 * worktree-hygiene-grep.test.mjs
 *
 * Guards the worktree hygiene rules in git-branch-hygiene.md
 * and the corresponding implementation in prune-merged-local.mjs.
 *
 * Locks:
 *   1. git-branch-hygiene.md has a `### Local Worktree Hygiene` section.
 *   2. The section documents the same trigger timing as Local Branch Hygiene.
 *   3. The section requires user confirmation before removing worktrees.
 *   4. prune-merged-local.mjs contains worktree scanning logic.
 *   5. prune-merged-local.mjs contains orphaned-branch secondary check.
 *   6. The documented dry-run mode is no-argument and `--dry-run` stays invalid.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const hygieneDoc = readFileSync(
  repoPath(".devpro/agent-rules/git-branch-hygiene.md"),
  "utf8"
);

const pruneScript = readFileSync(
  repoPath(".devpro/scripts/prune-merged-local.mjs"),
  "utf8"
);

test("git-workflow-tracking.md has Local Worktree Hygiene section", () => {
  assert.ok(
    hygieneDoc.includes("### Local Worktree Hygiene"),
    "Missing ### Local Worktree Hygiene section"
  );
});

test("worktree hygiene trigger timing references release Step 6", () => {
  assert.ok(
    hygieneDoc.includes("Step 6"),
    "Worktree hygiene section must reference release Step 6 as the trigger"
  );
});

test("worktree hygiene trigger timing does not reference pre-create-branch trigger", () => {
  const REMOVED_TRIGGER = ["step ", "2b"].join(""); // build literal at runtime; this file must stay grep-clean
  assert.ok(
    !hygieneDoc.includes(REMOVED_TRIGGER),
    "Worktree hygiene section must NOT reference the old pre-create-branch trigger (unified to release Step 6)"
  );
});

test("worktree hygiene requires user confirmation before remove", () => {
  assert.ok(
    hygieneDoc.includes("詢問使用者確認") && hygieneDoc.includes("worktree remove"),
    "Worktree hygiene section must require user confirmation and mention git worktree remove"
  );
});

test("worktree hygiene prohibits auto-removal", () => {
  assert.ok(
    hygieneDoc.includes("禁止自動移除"),
    "Worktree hygiene section must explicitly prohibit automatic removal"
  );
});

test("prune-merged-local.mjs scans worktrees", () => {
  assert.ok(
    pruneScript.includes("linkedWorktrees") && pruneScript.includes("worktree list --porcelain"),
    "prune-merged-local.mjs must contain linkedWorktrees() scanning git worktree list --porcelain"
  );
});

test("prune-merged-local.mjs has orphaned branch secondary check", () => {
  assert.ok(
    pruneScript.includes("orphaned") && pruneScript.includes("remoteTrackingBranches"),
    "prune-merged-local.mjs must contain orphaned branch detection via remoteTrackingBranches()"
  );
});

test("prune-merged-local.mjs documents squash-merge limitation", () => {
  assert.ok(
    pruneScript.includes("squash") && pruneScript.includes("ancestry"),
    "prune-merged-local.mjs must document that squash merge breaks tip ancestry detection"
  );
});

test("branch hygiene documents no-argument dry-run and invalid --dry-run flag", () => {
  assert.match(
    hygieneDoc,
    /dry-run 是「無參數模式」[\s\S]*`--dry-run` 不是合法旗標/,
    "git-branch-hygiene.md must document no-argument dry-run and reject --dry-run"
  );
  assert.match(
    hygieneDoc,
    /不要加 --dry-run/,
    "verification command must warn not to append --dry-run"
  );
});

test("prune-merged-local.mjs rejects --dry-run with no-arg guidance", () => {
  assert.match(
    pruneScript,
    /Unsupported option: --dry-run/,
    "prune-merged-local.mjs must special-case --dry-run with a clear diagnostic"
  );
  assert.match(
    pruneScript,
    /Dry-run is the default no-argument mode/,
    "prune-merged-local.mjs must point users to no-argument dry-run"
  );
});
