import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT_PATH = path.join(REPO_ROOT, ".devpro/scripts/abandon-pr-2927-unstarted-second-review.mjs");
const REPOSITORY = "devpro-tw/devpro-agent-rules";
const SOURCE_BRANCH = "bugfix/fix-post-pr-marker-non-ff-rebind";
const RESERVED_HEAD = "1ca5d65c55dcb15f5395c201d413ce4a164ef327";
const LOCAL_IMPLEMENTATION_COMMIT = "b".repeat(40);
const DISPATCH = "dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602";
const CONFIRMATION = `ABANDON ${DISPATCH} head ${RESERVED_HEAD} runner_not_started`;

async function loadCli() {
  return import(`${pathToFileURL(SCRIPT_PATH).href}?test=${Date.now()}-${Math.random()}`);
}

function withTempDir(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "abandon-pr-2927-test-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function commandResult(stdout = "", status = 0, stderr = "") {
  return { status, stdout, stderr };
}

function fixture(overrides = {}) {
  const calls = [];
  const writes = [];
  const user = { login: "allenchan" };
  const repository = { permissions: { push: true } };
  const pr = {
    number: 2927,
    state: "OPEN",
    mergedAt: null,
    baseRepository: { nameWithOwner: REPOSITORY },
    headRepository: { nameWithOwner: REPOSITORY },
    headRefName: SOURCE_BRANCH,
    headRefOid: RESERVED_HEAD,
  };
  const git = {
    root: REPO_ROOT,
    remote: "git@github.com:devpro-tw/devpro-agent-rules.git",
    branch: SOURCE_BRANCH,
    head: LOCAL_IMPLEMENTATION_COMMIT,
    status: "",
  };
  const values = {
    user,
    repository,
    pr,
    git,
    ...overrides,
  };

  function runCommand(binary, args, cwd) {
    calls.push({ binary, args: [...args], cwd });
    if (binary === "git") {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel") return commandResult(values.git.root);
      if (key === "remote get-url origin") return commandResult(values.git.remote);
      if (key === "branch --show-current") return commandResult(values.git.branch);
      if (key === "rev-parse HEAD") return commandResult(values.git.head);
      if (args[0] === "status" && args.includes("--")) return commandResult(values.git.status);
      return commandResult("", 2, `unexpected git command: ${key}`);
    }
    if (binary === "gh") {
      const key = args.join(" ");
      if (key === "api user") return values.user instanceof Error
        ? commandResult("", 1, values.user.message)
        : commandResult(JSON.stringify(values.user));
      if (key === `api repos/${REPOSITORY}`) return values.repository instanceof Error
        ? commandResult("", 1, values.repository.message)
        : commandResult(JSON.stringify(values.repository));
      if (args[0] === "pr" && args[1] === "view") return values.pr instanceof Error
        ? commandResult("", 1, values.pr.message)
        : commandResult(JSON.stringify(values.pr));
      return commandResult("", 2, `unexpected gh command: ${key}`);
    }
    return commandResult("", 2, `unexpected executable: ${binary}`);
  }

  async function writeClosure(input) {
    writes.push(input);
    return { status: "abandoned-before-invocation", record: { dispatch_id: DISPATCH } };
  }

  return { values, calls, writes, runCommand, writeClosure };
}

function runOptions(root, f, args = ["--confirm", CONFIRMATION]) {
  return {
    argv: args,
    cwd: REPO_ROOT,
    controlEvidenceRootDir: path.join(root, "control-evidence"),
    runCommand: f.runCommand,
    writeClosure: f.writeClosure,
  };
}

// Scenario: Operator Abandonment Is Limited to the Exact Unstarted PR #2927 Dispatch
test("T11 one-shot CLI records exact current GitHub authority and ignores unrelated untracked files", async () => {
  await withTempDir(async (root) => {
    const cli = await loadCli();
    const f = fixture();
    const result = await cli.runAbandonment(runOptions(root, f));

    assert.equal(result.status, "abandoned-before-invocation");
    assert.equal(result.dispatch_id, DISPATCH);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].authorization, {
      operator_login: "allenchan",
      repository_permissions_push: true,
      permission_source: "gh-api-repository",
      target_repository: REPOSITORY,
      pr_number: "2927",
      pr_state: "OPEN",
      pr_merged: false,
      base_repository: REPOSITORY,
      head_repository: REPOSITORY,
      head_ref: SOURCE_BRANCH,
      remote_pr_head: RESERVED_HEAD,
      local_repository: REPOSITORY,
      local_branch: SOURCE_BRANCH,
      local_implementation_commit: LOCAL_IMPLEMENTATION_COMMIT,
      authorization_checked_at: f.writes[0].authorization.authorization_checked_at,
    });
    assert.match(f.writes[0].authorization.authorization_checked_at, /^\d{4}-\d\d-\d\dT/);
    const statusCall = f.calls.find((call) => call.binary === "git" && call.args[0] === "status");
    assert.ok(statusCall, "CLI must check staged, unstaged, and untracked in-scope carriers");
    assert.deepEqual(statusCall.args.slice(1, statusCall.args.indexOf("--")), ["--porcelain", "--untracked-files=all"]);
    assert.equal(statusCall.args.includes("openspec/config.yaml"), false);
    assert.ok(f.calls.some((call) => call.binary === "gh" && call.args.join(" ") === "api user"));
    assert.ok(f.calls.some((call) => call.binary === "gh" && call.args.join(" ") === `api repos/${REPOSITORY}`));
  });
});

// Scenario: Remote PR Head Movement Refuses Recovery Without Writes
// Scenario: Operator Abandonment Rejects GitHub Auth, Permission, PR, and Confirmation Mismatch
test("T11 CLI rejects all GitHub authority and PR tuple mismatches before the evidence writer", async () => {
  await withTempDir(async (root) => {
    const cli = await loadCli();
    const cases = [
      ["gh api user unavailable", { user: new Error("auth unavailable") }],
      ["missing login", { user: {} }],
      ["invalid login", { user: { login: "not a valid login" } }],
      ["repository permission unavailable", { repository: new Error("permission unavailable") }],
      ["push permission false", { repository: { permissions: { push: false } } }],
      ["push permission missing", { repository: { permissions: {} } }],
      ["PR unavailable", { pr: new Error("PR unavailable") }],
      ["PR closed", { pr: { ...fixture().values.pr, state: "CLOSED" } }],
      ["PR merged", { pr: { ...fixture().values.pr, mergedAt: "2026-09-30T00:00:00Z" } }],
      ["wrong target repository", { pr: { ...fixture().values.pr, baseRepository: { nameWithOwner: "other/repo" } } }],
      ["wrong source repository", { pr: { ...fixture().values.pr, headRepository: { nameWithOwner: "other/repo" } } }],
      ["wrong source ref", { pr: { ...fixture().values.pr, headRefName: "feature/other" } }],
      ["remote head moved", { pr: { ...fixture().values.pr, headRefOid: "c".repeat(40) } }],
    ];
    for (const [label, overrides] of cases) {
      const f = fixture(overrides);
      await assert.rejects(
        () => cli.runAbandonment(runOptions(root, f)),
        undefined,
        label,
      );
      assert.equal(f.writes.length, 0, `${label} must fail before any state write`);
    }
  });
});

// Scenario: Operator Abandonment Rejects GitHub Auth, Permission, PR, and Confirmation Mismatch
test("T11 CLI rejects wrong repository, branch, uncommitted implementation, and confirmation without writes", async () => {
  await withTempDir(async (root) => {
    const cli = await loadCli();
    const cases = [
      ["wrong worktree root", { git: { ...fixture().values.git, root: "/tmp/other-repository" } }],
      ["wrong repository remote", { git: { ...fixture().values.git, remote: "https://github.com/other/repo.git" } }],
      ["wrong local branch", { git: { ...fixture().values.git, branch: "feature/other" } }],
      ["uncommitted in-scope carrier", { git: { ...fixture().values.git, status: " M .devpro/scripts/render-second-review-packet.mjs\n" } }],
    ];
    for (const [label, overrides] of cases) {
      const f = fixture(overrides);
      await assert.rejects(() => cli.runAbandonment(runOptions(root, f)), undefined, label);
      assert.equal(f.writes.length, 0, `${label} must fail before any state write`);
    }

    for (const args of [[], ["--confirm", "runner_not_started"], ["--confirm", CONFIRMATION, "--dispatch", "dispatch-other"]]) {
      const f = fixture();
      await assert.rejects(() => cli.runAbandonment(runOptions(root, f, args)), undefined, `args=${args.join(" ")}`);
      assert.equal(f.writes.length, 0, "missing or widened confirmation must not write state");
    }
  });
});

test("in-scope implementation carriers are tracked paths git can see, not paths behind a symlink", async () => {
  const { IN_SCOPE_IMPLEMENTATION_CARRIERS } = await loadCli();
  // `git status -- <path>` reports nothing for a path that goes through a symlinked directory
  // (for example `.agents/skills/devpro`), so a dirty carrier listed that way would pass the
  // clean-tree precheck unseen.
  for (const carrier of IN_SCOPE_IMPLEMENTATION_CARRIERS) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", carrier], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(tracked.status, 0, `${carrier} must be a tracked path, not one behind a symlink`);
  }
  assert.ok(
    IN_SCOPE_IMPLEMENTATION_CARRIERS.includes(".devpro/agent-skills/devpro-reviews/second-review/SKILL.md"),
    "the second-review SKILL.md this recovery changes must be covered by the clean-tree precheck",
  );
});
