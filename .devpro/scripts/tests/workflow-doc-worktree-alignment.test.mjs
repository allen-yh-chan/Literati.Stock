import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

// cwd-independent repo root (SSOT in tests/lib/repo-root.mjs): relative rule
// paths resolve from there, not process.cwd() — running from .devpro/scripts/
// otherwise yields ENOENT on bare relative reads.

test("hotfix workflow uses branch segment as worktree basename", () => {
  // The hotfix carrier recipe lives in its own on-demand leaf (moved out of release-step-1-7.md Step 7).
  const releaseStep17 = read(".devpro/agent-rules/release-hotfix-carrier-lane.md");

  assert.match(
    releaseStep17,
    /git worktree add "\$REPO_ROOT\/\.worktree\/<name>" -b hotfix\/<name> <production-\* tag>/
  );
  assert.match(releaseStep17, /source repo hotfix uses latest `production-v<X\.Y\.Z>`/);
  assert.match(releaseStep17, /consumer date lane uses `production-YYYYMMDD\[-n\]`/);
  assert.match(releaseStep17, /cd "\$REPO_ROOT\/\.worktree\/<name>"/);
  assert.doesNotMatch(releaseStep17, /\.worktree\/hotfix-<name>/);
});

test("rules workflow defines REPO_ROOT and routes from inside the new worktree", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const root = "REPO_ROOT=$(git rev-parse --show-toplevel)";
  const add = 'git worktree add "$REPO_ROOT/.worktree/rules-<source>-v<X.Y.Z>" -b rules/<source>-v<X.Y.Z> <base>';
  const cd = 'cd "$REPO_ROOT/.worktree/rules-<source>-v<X.Y.Z>"';
  const route = "git ls-tree -d HEAD .devpro-agent-rules";

  assert.notEqual(rulesFlow.indexOf(root), -1);
  assert.ok(rulesFlow.indexOf(add) > rulesFlow.indexOf(root));
  assert.ok(rulesFlow.indexOf(cd) > rulesFlow.indexOf(add));
  assert.ok(rulesFlow.indexOf(route) > rulesFlow.indexOf(cd));
});
