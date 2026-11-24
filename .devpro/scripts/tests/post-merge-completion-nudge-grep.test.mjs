/**
 * post-merge-completion-nudge-grep.test.mjs
 *
 * Locks the strengthen-session-pending-completion-nudge implementation shape:
 * grep-anchors the reverse-lookup helper export, its wiring into
 * post-merge-check.mjs's session-pending section, and the fail-open contract,
 * so a future refactor can't silently drop the "done → delete" completion
 * feed-forward without a test failing.
 *
 * Companion to hook-post-merge-check.test.mjs (behavioral TC1/TC2 cases) and
 * the post-merge-local-sync-grep / session-pending-claim-and-path-grep series.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";


const utilsPath = path.join(
  REPO_ROOT,
  ".devpro/scripts/hooks/lib/session-pending-utils.mjs"
);
const hookPath = repoPath(".devpro/scripts/hooks/post-merge-check.mjs");

const utilsBody = readFileSync(utilsPath, "utf8");
const hookBody = readFileSync(hookPath, "utf8");

test("session-pending-utils.mjs exports findClaimedChangesForBranch", () => {
  assert.match(
    utilsBody,
    /export function findClaimedChangesForBranch\(/,
    "helper must be exported for post-merge-check.mjs to consume"
  );
});

test("session-pending-utils.mjs findClaimedChangesForBranch scans claimed: lines", () => {
  assert.match(
    utilsBody,
    /claimed:\\s\*/,
    "helper must regex-match the `claimed:` marker line"
  );
});

test("session-pending-utils.mjs findClaimedChangesForBranch is prefix-aware across feature/bugfix/hotfix/chore", () => {
  for (const prefix of ["feature", "bugfix", "hotfix", "chore"]) {
    assert.ok(
      utilsBody.includes(`"${prefix}"`),
      `prefix list must include "${prefix}" (branch prefix-aware match)`
    );
  }
});

test("session-pending-utils.mjs findClaimedChangesForBranch documents fail-open contract", () => {
  assert.match(
    utilsBody,
    /Fail-open: any error[\s\S]*?yields[\s\S]*?empty array/,
    "JSDoc must document fail-open (any error → [])"
  );
});

test("post-merge-check.mjs imports findClaimedChangesForBranch from session-pending-utils.mjs", () => {
  assert.match(
    hookBody,
    /import\s*\{\s*countPendingItems,\s*findClaimedChangesForBranch\s*\}\s*from\s*"\.\/lib\/session-pending-utils\.mjs"/,
    "hook must import the reverse-lookup helper"
  );
});

test("post-merge-check.mjs calls findClaimedChangesForBranch in the session-pending section", () => {
  assert.match(
    hookBody,
    /findClaimedChangesForBranch\(branch\)/,
    "hook must call the reverse-lookup helper with the merged branch"
  );
});

test("post-merge-check.mjs emits full-entry deletion instruction citing session-pending-lifecycle.md", () => {
  assert.match(hookBody, /整條刪除/, "completion nudge must instruct full deletion");
  assert.match(
    hookBody,
    /session-pending-lifecycle\.md/,
    "completion nudge must cite session-pending-lifecycle.md"
  );
});

test("post-merge-check.mjs does not introduce a gh/network probe on the completion-nudge path", () => {
  // The reverse lookup must reuse the merge marker itself as the completion
  // signal (per design-core §8 Hook Runtime Cost Boundary) — no `gh` CLI call
  // anywhere in this file.
  assert.doesNotMatch(
    hookBody,
    /spawnSync\(\s*"gh"/,
    "post-merge-check.mjs must not shell out to gh for the completion nudge"
  );
});

test("post-merge-check.mjs preserves the generic pending-count reminder alongside the completion nudge", () => {
  assert.match(
    hookBody,
    /notes\/session-pending\.md 有 \$\{sessionPendingCount\} 條未處理待辦/,
    "existing generic count reminder text must remain unchanged"
  );
});
