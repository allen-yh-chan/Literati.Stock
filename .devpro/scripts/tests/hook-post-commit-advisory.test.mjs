/**
 * hook-post-commit-advisory.test.mjs
 *
 * PostToolUse recovery for commit-time advisories skipped by PreToolUse when
 * static cwd resolution fails (issue #2366).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./lib/tmp.mjs";
import {
  extractCommitHashHintFromOutput,
  isSuccessfulGitCommitCommand,
  resolvePostCommitRepoCwd,
  runPostCommitCommitAdvisories,
} from "../hooks/lib/post-commit-advisory.mjs";
import { markSourceCheckout } from "./lib/identity-fixtures.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const POST_TOOL_HOOK = path.resolve(SCRIPT_DIR, "../hooks/post-tool-gate.mjs");
const PRE_TOOL_HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

const tmpRoot = makeTempDir("post-commit-advisory-test-");
let counter = 0;

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r;
}

function setupFixture({ agentsVersion = "6.82.1" } = {}) {
  const work = path.join(tmpRoot, `fixture-${counter++}`);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@t.com"]);
  git(work, ["config", "user.name", "t"]);
  writeFileSync(path.join(work, "README.md"), "fixture\n");
  writeFileSync(path.join(work, "AGENTS.md"), `版本：${agentsVersion}\n`);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);
  git(work, ["checkout", "-q", "-b", "chore/fixture"]);
  markSourceCheckout(work);
  return work;
}

const CLEAN_COMMIT_MSG =
  "chore: fixture commit\n\nRules: v6.82.1 · Tool: Test Harness · Model: n/a";

function runPostToolHook(command, cwd, { exitCode = 0, stdout = "" } = {}) {
  const payload = {
    tool_name: "Bash",
    tool_input: { command, cwd },
    tool_response: { exit_code: exitCode, stdout },
  };
  return spawnSync("node", [POST_TOOL_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env },
  });
}

function runPreToolHook(command, cwd) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  return spawnSync("node", [PRE_TOOL_HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, PWD: cwd },
  });
}

test("isSuccessfulGitCommitCommand skips --no-edit", () => {
  assert.equal(isSuccessfulGitCommitCommand("git commit --no-edit"), false);
  assert.equal(isSuccessfulGitCommitCommand('git commit -m "x"'), true);
});

test("extractCommitHashHintFromOutput parses bracketed git output", () => {
  assert.equal(
    extractCommitHashHintFromOutput("[chore/fixture deadbeef] chore: msg"),
    "deadbeef"
  );
});

test("resolvePostCommitRepoCwd: linked worktree via trailing cd target", () => {
  const main = setupFixture();
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-fixture", wt, "chore/fixture"]);

  const cmd = `cd ${wt} && git commit -m "${CLEAN_COMMIT_MSG}"`;
  const resolved = resolvePostCommitRepoCwd(cmd, main);
  assert.equal(realpathSync(resolved), realpathSync(wt));
});

test("resolvePostCommitRepoCwd: command cd wins over later worktree enumeration (hashless)", () => {
  const main = setupFixture();
  const wtA = path.join(tmpRoot, `wt-a-${counter++}`);
  const wtB = path.join(tmpRoot, `wt-b-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-a", wtA, "chore/fixture"]);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-b", wtB, "chore/fixture"]);

  const cmd = `cd ${wtB} && git commit -q -m "${CLEAN_COMMIT_MSG}"`;
  const resolved = resolvePostCommitRepoCwd(cmd, main);
  assert.equal(realpathSync(resolved), realpathSync(wtB));
});

test("resolvePostCommitRepoCwd: commitHashHint disambiguates when multiple worktrees share branch", () => {
  const main = setupFixture();
  const wtA = path.join(tmpRoot, `wt-hint-a-${counter++}`);
  const wtB = path.join(tmpRoot, `wt-hint-b-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-hint-a", wtA, "chore/fixture"]);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-hint-b", wtB, "chore/fixture"]);

  git(wtB, ["commit", "-q", "--allow-empty", "-m", CLEAN_COMMIT_MSG]);
  const head = git(wtB, ["rev-parse", "HEAD"]).stdout.trim();

  const cmd = `cd ${wtA} && git commit -q --allow-empty -m "${CLEAN_COMMIT_MSG}"`;
  const resolved = resolvePostCommitRepoCwd(cmd, main, head);
  assert.equal(realpathSync(resolved), realpathSync(wtB));
});

test("runPostCommitCommitAdvisories: version mismatch on HEAD after worktree commit", () => {
  const main = setupFixture({ agentsVersion: "6.90.0" });
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-version", wt, "chore/fixture"]);

  const msg =
    "chore: wrong footer\n\nRules: v6.82.1 · Tool: Test Harness · Model: n/a";
  git(wt, ["commit", "-q", "--allow-empty", "-m", msg]);

  const cmd = `cd ${wt} && git commit --allow-empty -m "${msg}"`;
  const result = runPostCommitCommitAdvisories(cmd, main);

  assert.ok(result?.advisories?.length, "expected post-commit advisories");
  const text = result.advisories.join("\n");
  assert.match(text, /version-mismatch/);
  assert.match(text, /6\.82\.1/);
  assert.match(text, /6\.90\.0/);
});

test("runPostCommitCommitAdvisories: EOF-dirty file committed in linked worktree", () => {
  const main = setupFixture();
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-eof", wt, "chore/fixture"]);
  markSourceCheckout(wt);

  writeFileSync(path.join(wt, "notes.md"), "line one\n\n");
  git(wt, ["add", "notes.md"]);
  git(wt, ["commit", "-q", "-m", CLEAN_COMMIT_MSG]);

  const cmd = `cd ${wt} && git commit -m "${CLEAN_COMMIT_MSG}"`;
  const result = runPostCommitCommitAdvisories(cmd, main, {
    commitHashHint: git(wt, ["rev-parse", "HEAD"]).stdout.trim(),
  });

  assert.ok(result?.advisories?.length, "expected EOF post-commit advisory");
  assert.match(result.advisories.join("\n"), /eof-dirty-committed/);
  assert.match(result.advisories.join("\n"), /notes\.md/);
});

test("post-tool-gate wires post-commit advisories on successful git commit", () => {
  const main = setupFixture({ agentsVersion: "6.90.0" });
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-hook", wt, "chore/fixture"]);

  const msg =
    "chore: wrong footer\n\nRules: v6.82.1 · Tool: Test Harness · Model: n/a";
  git(wt, ["commit", "-q", "--allow-empty", "-m", msg]);
  const head = git(wt, ["rev-parse", "HEAD"]).stdout.trim();

  const cmd = `cd ${wt} && git commit --allow-empty -m "${msg}"`;
  const r = runPostToolHook(cmd, main, {
    stdout: `[chore/wt-hook ${head.slice(0, 7)}] chore: wrong footer`,
  });

  assert.equal(r.status, 0);
  assert.match(r.stderr, /post-tool-gate post-commit advisory:/);
  assert.match(r.stderr, /version-mismatch/);
});

test("post-tool-gate skips post-commit advisories for DEVPRO_HOOK_BYPASS", () => {
  const main = setupFixture({ agentsVersion: "6.90.0" });
  const cmd = `DEVPRO_HOOK_BYPASS=1 git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`;
  const r = runPostToolHook(cmd, main, { stdout: "[main abcdef0] msg" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /post-commit advisory/);
});

test("post-tool-gate skips post-commit advisories for failed git commit", () => {
  const main = setupFixture({ agentsVersion: "6.90.0" });
  const cmd = `git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`;
  const r = runPostToolHook(cmd, main, { exitCode: 1 });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /post-commit advisory/);
});

test("PreToolUse skip + PostToolUse recovery: true UNRESOLVABLE then post-commit version check", () => {
  const main = setupFixture({ agentsVersion: "6.90.0" });
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-recover", wt, "chore/fixture"]);

  const msg =
    "chore: wrong footer\n\nRules: v6.82.1 · Tool: Test Harness · Model: n/a";
  // Pipe makes effectiveCdCwd UNRESOLVABLE → cwd-parse-unresolvable (not path blame).
  const cmd = `cd ${wt} | true; git commit --allow-empty -m "${msg}"`;

  const pre = runPreToolHook(cmd, main);
  let preJson = null;
  try {
    preJson = pre.stdout ? JSON.parse(pre.stdout) : null;
  } catch {}
  const preText =
    preJson?.advisory ||
    preJson?.hookSpecificOutput?.additionalContext ||
    preJson?.systemMessage ||
    "";
  assert.match(preText, /cwd-parse-unresolvable|checked=false/);

  git(wt, ["commit", "-q", "--allow-empty", "-m", msg]);
  const head = git(wt, ["rev-parse", "HEAD"]).stdout.trim();
  const post = runPostToolHook(cmd, main, {
    stdout: `[chore/wt-recover ${head.slice(0, 7)}] chore: wrong footer`,
  });
  assert.match(post.stderr, /version-mismatch/);
});
