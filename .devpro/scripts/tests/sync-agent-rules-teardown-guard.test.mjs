/**
 * sync-agent-rules-teardown-guard.test.mjs
 *
 * Mechanical guard for the release 7.13.0 Build-once flake: `withConsumerRepo`
 * removed its temp tree with a bare recursive `fs.rm`, which fails with
 * ENOTEMPTY when a helper git process is still writing under `.git/objects`
 * (macOS, parallel integration tier, linked-worktree checkout). Every temp-tree
 * teardown in the harness MUST go through `removeTempTree`, which retries.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const harness = readFileSync(
  repoPath(".devpro/scripts/tests/lib/sync-agent-rules-harness.mjs"),
  "utf8",
);

test("Scenario: temp-tree teardown retries instead of failing an otherwise green file", () => {
  assert.match(harness, /export async function removeTempTree\(dir\) \{/);
  assert.match(harness, /maxRetries: TEMP_TREE_REMOVE_RETRIES/);
  assert.match(harness, /retryDelay: TEMP_TREE_REMOVE_RETRY_DELAY_MS/);
  const bareTmpRemovals = harness.match(/fs\.rm\(\s*(ctx|slim)\.(tmpDir|sourceRoot|sourceRepoDir|originDir)/g) || [];
  assert.deepEqual(
    bareTmpRemovals,
    [],
    "every fixture teardown must call removeTempTree, not a bare recursive fs.rm",
  );
  const helperUses = harness.match(/await removeTempTree\(/g) || [];
  assert.ok(helperUses.length >= 5, `expected at least 5 teardown call sites, saw ${helperUses.length}`);
});
