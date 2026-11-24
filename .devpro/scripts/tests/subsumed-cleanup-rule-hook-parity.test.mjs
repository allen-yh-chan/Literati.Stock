import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

async function read(relPath) {
  return fs.readFile(repoPath(relPath), "utf8");
}

test("Squash-Source Cleanup anchors stay aligned across rule, script, and spec", async () => {
  const hygieneRule = await read(".devpro/agent-rules/git-branch-hygiene.md");
  const pruneScript = await read(".devpro/scripts/prune-merged-local.mjs");
  const preToolSpec = await read("openspec/specs/pre-tool-mechanical-gates/spec.md");

  for (const token of ["Squash-Source Cleanup", "--include-subsumed", "subsumed-by-squash"]) {
    assert.ok(hygieneRule.includes(token), `git-branch-hygiene.md must include ${token}`);
    assert.ok(pruneScript.includes(token), `prune-merged-local.mjs must include ${token}`);
  }

  const canonicalEntrypoint = "node .devpro/scripts/prune-merged-local.mjs --include-subsumed";
  assert.ok(hygieneRule.includes(canonicalEntrypoint), "rule must name canonical --include-subsumed entrypoint");
  assert.ok(preToolSpec.includes("Cleanup Policy Uses Prune Script Instead Of PreToolUse Parser"));
  assert.ok(preToolSpec.includes("PreToolUse MUST NOT contain an advisory parser"));
  assert.ok(preToolSpec.includes("`prune-merged-local.mjs`"));
  assert.doesNotMatch(preToolSpec, /SHALL allow `git worktree remove <path>` when/);
});
