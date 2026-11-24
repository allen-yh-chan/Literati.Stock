/**
 * hook-commit-soft-nudge.test.mjs
 *
 * Verifies the commit soft nudge stays non-blocking, silent on rules-sync
 * exemptions, and visible on normal work branches.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/commit-soft-nudge.mjs");
const TMP_ROOT = makeTempDir("commit-soft-nudge-test-");

const PREFLIGHT = `
# preflight

<!-- rules-source-whitelist:start -->
- \`agent-rules\`
<!-- rules-source-whitelist:end -->
`;

after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

let counter = 0;

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}

function setupRepo(branchName) {
  const dir = path.join(TMP_ROOT, `repo-${counter++}`);
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), PREFLIGHT);
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  git(["checkout", "-q", "-b", branchName], dir);
  return dir;
}

function runHook(repo, command = "git commit -m test") {
  return spawnSync(process.execPath, [HOOK], {
    cwd: repo,
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command, cwd: repo },
    }),
    encoding: "utf8",
  });
}

test("rules sync SemVer branch exits silently", () => {
  const repo = setupRepo("rules/agent-rules-v1.2.3");
  const result = runHook(repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("non-exempt branch prints cross-review nudge and exits 0", () => {
  const repo = setupRepo("feature/add-observability");
  const result = runHook(repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /此分支將需 cross-review/);
  assert.match(result.stderr, /\/devpro:cross-review/);
});

test("non-commit bash command stays silent", () => {
  const repo = setupRepo("feature/add-docs");
  const result = runHook(repo, "git status --short");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
