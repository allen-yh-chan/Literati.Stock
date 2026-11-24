import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const workflowDir = path.join(REPO_ROOT, ".github", "workflows");

test("source repo does not commit local-test-covered workflows", () => {
  const workflowFiles = existsSync(workflowDir)
    ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/u.test(name)).sort()
    : [];

  assert.deepEqual(workflowFiles, []);
});

test("source workflows remain excluded from consumer sync", () => {
  const sync = read(".devpro/scripts/sync-agent-rules.mjs");
  assert.match(sync, /ignoredRelPaths\.add\("workflows"\)/);
});
