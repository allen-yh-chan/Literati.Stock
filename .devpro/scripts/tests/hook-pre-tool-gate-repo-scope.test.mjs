/**
 * hook-pre-tool-gate-repo-scope.test.mjs
 *
 * Regression tests for Repo Scope Evidence Gate:
 * - workspace-level read-only inspection remains allowed
 * - write-class operations in a different git common-dir are blocked unless
 *   the command carries a scoped approval marker
 * - same-repo worktree writes remain allowed
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("repo-scope-gate-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;

function setupRepo(branchName = "chore/test-repo-scope") {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  return setupRepoAt(dir, branchName);
}

function setupRepoAt(dir, branchName = "chore/test-repo-scope") {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "initial\n");
  spawnSync("git", ["add", "x"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function setupRepoWithWorktree() {
  const repo = setupRepo("main");
  const wt = path.join(tmpRoot, `same-common-worktree-${counter++}`);
  spawnSync("git", ["worktree", "add", "-q", "-b", "chore/same-common", wt, "HEAD"], {
    cwd: repo,
  });
  writeFileSync(path.join(wt, "x"), "changed\n");
  return { repo, wt };
}

function runHook(payload, { cwd, env = {} } = {}) {
  const r = spawnSync("node", [HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: makeTempDir("repo-scope-sentinel-"),
      PWD: cwd,
      ...env,
    },
  });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function setupSharedHookStateDir() {
  return makeTempDir("repo-scope-state-");
}

test("Repo Scope Evidence Gate: git clone without scoped approval marker → block", () => {
  const repo = setupRepo();
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git clone https://example.test/example/repo.git" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Repo Scope Evidence Gate/);
  assert.match(r.json.reason, /git clone/);
});

test("Repo Scope Evidence Gate: git clone with scoped approval marker → pass", () => {
  const repo = setupRepo();
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: "DEVPRO_REPO_SCOPE_APPROVED=repo git clone https://example.test/example/repo.git",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null, `expected pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: cross-repo git write from inside another repo → block", () => {
  const current = setupRepo("chore/current-scope");
  const other = setupRepo("chore/other-scope");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git -C ${JSON.stringify(other)} add x` } },
    { cwd: current }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Repo Scope Evidence Gate/);
  assert.match(r.json.reason, /cross-repo git write/);
});

// R16 (shared cwd arithmetic): a chdir inside parentheses is unresolvable and the
// repo-scope gate fails open on an unresolvable cwd (its fail-open threat model).
test("Repo Scope Evidence Gate: (cd <other repo> && git write) → pass (R16 unresolvable, fail-open)", () => {
  const current = setupRepo("chore/current-paren");
  const other = setupRepo("chore/other-paren");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `(cd ${JSON.stringify(other)} && git add x)` } },
    { cwd: current }
  );
  assert.notEqual(r.json?.decision, "block", `expected fail-open pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: flat cd <other repo> && git write → still block (resolved cross-repo)", () => {
  const current = setupRepo("chore/current-flat");
  const other = setupRepo("chore/other-flat");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `cd ${JSON.stringify(other)} && git add x` } },
    { cwd: current }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /cross-repo git write/);
});

test("Scenario: Control-flow dependent cwd stays unresolved and the hard-blocking gates fail open (cross-repo write, background &)", () => {
  const current = setupRepo("chore/current-bg");
  const other = setupRepo("chore/other-bg");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `cd ${JSON.stringify(other)} & git add x` } },
    { cwd: current }
  );
  assert.notEqual(r.json?.decision, "block", `expected fail-open pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: cross-repo read-only git inspection → pass", () => {
  const current = setupRepo("chore/current-read");
  const other = setupRepo("chore/other-read");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git -C ${JSON.stringify(other)} status --short` } },
    { cwd: current }
  );
  assert.equal(r.json, null, `expected pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: cross-repo branch read-only inspection → pass", () => {
  const current = setupRepo("chore/current-branch-read");
  const other = setupRepo("chore/other-branch-read");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git -C ${JSON.stringify(other)} branch --show-current` } },
    { cwd: current }
  );
  assert.equal(r.json, null, `expected pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: same-common-dir worktree git write → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git -C ${JSON.stringify(wt)} add x` } },
    { cwd: repo }
  );
  assert.equal(r.json, null, `expected pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: workspace cwd with no active git repo does not block repo writes", () => {
  const target = setupRepo("chore/workspace-target");
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git -C ${JSON.stringify(target)} add x` } },
    { cwd: tmpRoot }
  );
  assert.equal(r.json, null, `expected pass from workspace cwd, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: cross-repo git write with matching scoped marker → pass", () => {
  const current = setupRepo("chore/current-marker");
  const other = setupRepo("chore/other-marker");
  const marker = path.basename(other);
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=${marker} git -C ${JSON.stringify(other)} add x`,
      },
    },
    { cwd: current }
  );
  assert.equal(r.json, null, `expected pass, got ${JSON.stringify(r.json)}`);
});

test("Repo Scope Evidence Gate: Edit into another repo from active repo cwd → block", () => {
  const current = setupRepo("chore/current-edit");
  const other = setupRepo("chore/other-edit");
  const r = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(other, "x"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: current }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Repo Scope Evidence Gate/);
  assert.match(r.json.reason, /cross-repo file write/);
  assert.match(r.json.reason, /Dedicated file tools cannot carry inline Bash env markers/);
  assert.match(r.json.reason, /retry Edit\/Write\/MultiEdit/);
});

test("Repo Scope Evidence Gate: prior scoped Bash approval allows later Edit into target repo", () => {
  const current = setupRepo("chore/current-edit-approved");
  const other = setupRepo("chore/other-edit-approved");
  const stateDir = setupSharedHookStateDir();
  const marker = path.basename(other);

  const approval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=${marker} true`,
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approval.json, null, `expected approval marker pass, got ${JSON.stringify(approval.json)}`);

  const edit = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(other, "x"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(edit.json, null, `expected approved Edit pass, got ${JSON.stringify(edit.json)}`);
});

test("Repo Scope Evidence Gate: prior scoped Bash approval does not allow Edit into another repo", () => {
  const current = setupRepo("chore/current-edit-wrong-approval");
  const approved = setupRepo("chore/approved-edit-wrong-approval");
  const other = setupRepo("chore/other-edit-wrong-approval");
  const stateDir = setupSharedHookStateDir();
  const marker = path.basename(approved);

  const approval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=${marker} true`,
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approval.json, null, `expected approval marker pass, got ${JSON.stringify(approval.json)}`);

  const edit = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(other, "x"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(edit.json?.decision, "block");
  assert.match(edit.json.reason, /Repo Scope Evidence Gate/);
  assert.match(edit.json.reason, /cross-repo file write/);
});

test("Repo Scope Evidence Gate: child directory approval does not allow Edit into target repo", () => {
  const current = setupRepo("chore/current-edit-child-dir-approval");
  const target = setupRepo("chore/target-edit-child-dir-approval");
  const stateDir = setupSharedHookStateDir();
  mkdirSync(path.join(target, "src"), { recursive: true });
  writeFileSync(path.join(target, "src", "file.txt"), "initial\n");

  const childDirApproval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: "DEVPRO_REPO_SCOPE_APPROVED=src true",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(childDirApproval.json, null, `expected child-dir approval marker pass, got ${JSON.stringify(childDirApproval.json)}`);

  const blockedEdit = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(target, "src", "file.txt"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(blockedEdit.json?.decision, "block");
  assert.match(blockedEdit.json.reason, /Repo Scope Evidence Gate/);
  assert.match(blockedEdit.json.reason, /cross-repo file write/);

  const repoApproval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=${path.basename(target)} true`,
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(repoApproval.json, null, `expected repo approval marker pass, got ${JSON.stringify(repoApproval.json)}`);

  const approvedEdit = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(target, "src", "file.txt"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approvedEdit.json, null, `expected repo-approved Edit pass, got ${JSON.stringify(approvedEdit.json)}`);
});

test("Repo Scope Evidence Gate: comment-only scoped Bash marker does not approve later Edit", () => {
  const current = setupRepo("chore/current-edit-comment-approval");
  const other = setupRepo("chore/other-edit-comment-approval");
  const stateDir = setupSharedHookStateDir();
  const marker = path.basename(other);

  const approval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `# DEVPRO_REPO_SCOPE_APPROVED=${marker}\ntrue`,
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approval.json, null, `expected comment-only marker command pass, got ${JSON.stringify(approval.json)}`);

  const edit = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(other, "x"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(edit.json?.decision, "block");
  assert.match(edit.json.reason, /Repo Scope Evidence Gate/);
  assert.match(edit.json.reason, /cross-repo file write/);
});

test("Repo Scope Evidence Gate: approval from one active repo does not allow same-basename target from another active repo", () => {
  const activeA = setupRepo("chore/active-a-same-basename");
  const activeB = setupRepo("chore/active-b-same-basename");
  const targetB = setupRepoAt(
    path.join(tmpRoot, `target-parent-${counter++}`, "target"),
    "chore/target-b-same-basename"
  );
  const stateDir = setupSharedHookStateDir();

  const approval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: "DEVPRO_REPO_SCOPE_APPROVED=target true",
      },
    },
    { cwd: activeA, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approval.json, null, `expected approval marker pass, got ${JSON.stringify(approval.json)}`);

  const edit = runHook(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(targetB, "x"),
        old_string: "initial\n",
        new_string: "changed\n",
      },
    },
    { cwd: activeB, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(edit.json?.decision, "block");
  assert.match(edit.json.reason, /Repo Scope Evidence Gate/);
  assert.match(edit.json.reason, /cross-repo file write/);
});

test("Repo Scope Evidence Gate: prior scoped Bash approval allows later Write into target repo", () => {
  const current = setupRepo("chore/current-write-approved");
  const other = setupRepo("chore/other-write-approved");
  const stateDir = setupSharedHookStateDir();
  const marker = path.basename(other);

  const approval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=${marker} true`,
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approval.json, null, `expected approval marker pass, got ${JSON.stringify(approval.json)}`);

  const write = runHook(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(other, "created.txt"),
        content: "created\n",
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(write.json, null, `expected approved Write pass, got ${JSON.stringify(write.json)}`);
});

test("Repo Scope Evidence Gate: prior scoped Bash approval allows later MultiEdit into target repo", () => {
  const current = setupRepo("chore/current-multiedit-approved");
  const other = setupRepo("chore/other-multiedit-approved");
  const stateDir = setupSharedHookStateDir();
  const marker = path.basename(other);

  const approval = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_REPO_SCOPE_APPROVED=${marker} true`,
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(approval.json, null, `expected approval marker pass, got ${JSON.stringify(approval.json)}`);

  const multiedit = runHook(
    {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: path.join(other, "x"),
        edits: [
          {
            old_string: "initial\n",
            new_string: "changed\n",
          },
        ],
      },
    },
    { cwd: current, env: { DEVPRO_SENTINEL_STATE_DIR: stateDir } }
  );
  assert.equal(multiedit.json, null, `expected approved MultiEdit pass, got ${JSON.stringify(multiedit.json)}`);
});

// #3508: a linked worktree's top level is its own directory (e.g. `.worktree/<change>`),
// so the repository name the user approves must be read from the shared git common dir.
function setupLinkedWorktreeOutside(worktreeName) {
  const repo = setupRepo("main");
  const wt = path.join(tmpRoot, `outside-${counter++}`, ".worktree", worktreeName);
  mkdirSync(path.dirname(wt), { recursive: true });
  spawnSync("git", ["worktree", "add", "-q", "-b", `bugfix/${worktreeName}`, wt, "HEAD"], { cwd: repo });
  return { repo, wt };
}

test("[Scenario: pre-tool-mechanical-gates :: Approval for a repository covers its linked worktrees] Edit into a linked worktree passes after approving the repository name", () => {
  const current = setupRepo("chore/current-linked-edit");
  const { repo: target, wt } = setupLinkedWorktreeOutside("fix-linked-edit");
  const env = { DEVPRO_SENTINEL_STATE_DIR: setupSharedHookStateDir() };
  const edit = () => runHook(
    { tool_name: "Edit", tool_input: { file_path: path.join(wt, "x"), old_string: "initial\n", new_string: "changed\n" } },
    { cwd: current, env }
  );

  const blocked = edit();
  assert.equal(blocked.json?.decision, "block");
  assert.match(blocked.json.reason, new RegExp(`Edit targets ${path.basename(target)}`), "the reason names the repository to approve, not the worktree directory");

  const approval = runHook(
    { tool_name: "Bash", tool_input: { command: `DEVPRO_REPO_SCOPE_APPROVED=${path.basename(target)} true` } },
    { cwd: current, env }
  );
  assert.equal(approval.json, null, `expected approval marker pass, got ${JSON.stringify(approval.json)}`);
  assert.equal(edit().json, null, "approving the repository name covers its linked worktree");
});

test("[Scenario: pre-tool-mechanical-gates :: Approval for a repository covers its linked worktrees] git write into a linked worktree passes only with the repository name marker", () => {
  const current = setupRepo("chore/current-linked-git");
  const { repo: target, wt } = setupLinkedWorktreeOutside("fix-linked-git");
  const write = (marker) => runHook(
    { tool_name: "Bash", tool_input: { command: `DEVPRO_REPO_SCOPE_APPROVED=${marker} git -C ${JSON.stringify(wt)} add x` } },
    { cwd: current }
  );
  assert.equal(write(path.basename(target)).json, null, "the repository name marker covers its linked worktree");
  const other = write("unrelated-repo");
  assert.equal(other.json?.decision, "block", "an unrelated name still blocks");
  assert.match(other.json.reason, new RegExp(`targets ${path.basename(target)}`));
});

// ── Repo scope approval name from the origin remote (add-cross-repo-pr-scope-marker, D7 / D9 #17) ──────────────
// The name a writer approves is the repository name of `origin` (owner/target -> target), the same for the main
// checkout, a linked worktree and a submodule checkout. No fixture directory below is named like the origin repo, so
// a path-derived name alone cannot satisfy these cases. These helpers drop inherited approval and PR-scope values so
// only the marker a test writes is seen.
const ORIGIN_SCOPE_STRIPPED_ENV = ["DEVPRO_REPO_SCOPE_APPROVED", "DEVPRO_CROSS_REPO_PR", "DEVPRO_PR_CHECKOUT", "DEVPRO_HOOK_BYPASS", "GH_REPO", "GH_HOST"];

function gitIn(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runScopeHook(payload, { cwd, env = {} } = {}) {
  const childEnv = { ...process.env, DEVPRO_SENTINEL_STATE_DIR: makeTempDir("repo-scope-sentinel-"), PWD: cwd };
  for (const key of ORIGIN_SCOPE_STRIPPED_ENV) delete childEnv[key];
  const r = spawnSync("node", [HOOK], { cwd, input: JSON.stringify(payload), encoding: "utf8", env: { ...childEnv, ...env } });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const gitWriteAs = (marker, dir, cwd) =>
  runScopeHook(
    { tool_name: "Bash", tool_input: { command: `${marker ? `DEVPRO_REPO_SCOPE_APPROVED=${marker} ` : ""}git -C ${JSON.stringify(dir)} add x` } },
    { cwd }
  );

const editAs = (dir, cwd, env) =>
  runScopeHook(
    { tool_name: "Edit", tool_input: { file_path: path.join(dir, "x"), old_string: "initial\n", new_string: "changed\n" } },
    { cwd, env }
  );

const approveByState = (name, cwd, env) =>
  runScopeHook({ tool_name: "Bash", tool_input: { command: `DEVPRO_REPO_SCOPE_APPROVED=${name} true` } }, { cwd, env });

// owner/target as one repository in four checkout shapes, none of them in a directory named `target`.
function setupOriginShapes() {
  const current = setupRepo("chore/current-origin-name");
  const main = setupRepoAt(path.join(tmpRoot, `origin-main-${counter++}`, "src-main"), "chore/origin-main");
  gitIn(main, ["remote", "add", "origin", "https://github.com/owner/target.git"]);
  const worktree = path.join(tmpRoot, `origin-wt-${counter++}`, "fix-x");
  gitIn(main, ["worktree", "add", "-q", "-b", "fix-x", worktree, "HEAD"]);
  const parent = setupRepo("main");
  const source = setupRepoAt(path.join(tmpRoot, `origin-sub-src-${counter++}`, "src-sub"), "chore/origin-sub-src");
  gitIn(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/sub-checkout"]);
  const submodule = path.join(parent, "vendor", "sub-checkout");
  gitIn(submodule, ["remote", "set-url", "origin", "https://github.com/owner/target.git"]);
  const submoduleWorktree = path.join(tmpRoot, `origin-subwt-${counter++}`, "fix-y");
  gitIn(submodule, ["worktree", "add", "-q", "-b", "fix-y", submoduleWorktree, "HEAD"]);
  return { current, shapes: { main, worktree, submodule, submoduleWorktree } };
}

test("[Scenario: pre-tool-mechanical-gates :: The origin name identifies every checkout shape of one repository] [WhenThen: 1] one origin repository name approves a git write into the main checkout, a linked worktree and a submodule checkout", () => {
  const { current, shapes } = setupOriginShapes();
  for (const [shape, dir] of Object.entries(shapes)) {
    assert.equal(gitWriteAs("target", dir, current).json, null, `${shape}: DEVPRO_REPO_SCOPE_APPROVED=target covers this checkout`);
    const refused = gitWriteAs("unrelated-name", dir, current);
    assert.equal(refused.json?.decision, "block", `${shape}: an unrelated name still blocks`);
    assert.match(refused.json.reason, /Repo Scope Evidence Gate/);
    assert.match(refused.json.reason, /targets target\b/, `${shape}: the block reason names the origin repository name`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: The origin name identifies every checkout shape of one repository] [WhenThen: 1] one origin repository name approves a later file-tool write into every checkout shape", () => {
  const { current, shapes } = setupOriginShapes();
  const env = { DEVPRO_SENTINEL_STATE_DIR: setupSharedHookStateDir() };
  for (const [shape, dir] of Object.entries(shapes)) {
    const blocked = editAs(dir, current, env);
    assert.equal(blocked.json?.decision, "block", `${shape}: no approval yet`);
    assert.match(blocked.json.reason, /Edit targets target\b/, `${shape}: the block reason names the origin repository name`);
  }
  assert.equal(approveByState("target", current, env).json, null, "the approval marker itself passes");
  for (const [shape, dir] of Object.entries(shapes)) {
    assert.equal(editAs(dir, current, env).json, null, `${shape}: the origin name approved by an earlier Bash payload covers this checkout`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: The origin name identifies every checkout shape of one repository] [WhenThen: 1] the path-derived names stay accepted next to the origin name (regression lock)", () => {
  const { current, shapes } = setupOriginShapes();
  // Env marker set: origin name, common-dir basename (src-main), worktree top-level basename (fix-x), target cwd basename.
  assert.equal(gitWriteAs("src-main", shapes.main, current).json, null, "common-dir basename of the main checkout");
  assert.equal(gitWriteAs("src-main", shapes.worktree, current).json, null, "common-dir basename covers its linked worktree");
  assert.equal(gitWriteAs("fix-x", shapes.worktree, current).json, null, "worktree top-level basename");
  assert.equal(gitWriteAs("sub-checkout", shapes.submodule, current).json, null, "submodule top-level basename");
  // State set: origin name, common-dir basename, worktree top-level basename.
  const env = { DEVPRO_SENTINEL_STATE_DIR: setupSharedHookStateDir() };
  assert.equal(approveByState("src-main", current, env).json, null);
  assert.equal(editAs(shapes.worktree, current, env).json, null, "common-dir basename approved by state covers the linked worktree");
});

test("[Scenario: pre-tool-mechanical-gates :: A repository without an origin remote keeps the path-derived names] [WhenThen: 1] without a usable origin the common-dir and worktree basenames are accepted as before (regression lock)", () => {
  const current = setupRepo("chore/current-no-origin-name");
  const origins = [
    ["no remote", null],
    ["local path remote", () => path.join(tmpRoot, `origin-local-path-${counter++}`)],
  ];
  for (const [label, remoteUrl] of origins) {
    const main = setupRepoAt(path.join(tmpRoot, `.worktrees-${counter++}`, ".worktrees", "target"), "chore/no-origin-main");
    if (remoteUrl) gitIn(main, ["remote", "add", "origin", remoteUrl()]);
    const worktree = path.join(tmpRoot, `no-origin-wt-${counter++}`, "fix-x");
    gitIn(main, ["worktree", "add", "-q", "-b", "fix-x", worktree, "HEAD"]);
    assert.equal(gitWriteAs("target", main, current).json, null, `${label}: common-dir basename of the main checkout`);
    assert.equal(gitWriteAs("target", worktree, current).json, null, `${label}: common-dir basename covers the linked worktree`);
    assert.equal(gitWriteAs("fix-x", worktree, current).json, null, `${label}: worktree top-level basename`);
    const refused = gitWriteAs("unrelated-name", worktree, current);
    assert.equal(refused.json?.decision, "block", `${label}: an unrelated name still blocks`);
    assert.match(refused.json.reason, /targets target\b/, `${label}: the block reason keeps the path-derived name`);
    const env = { DEVPRO_SENTINEL_STATE_DIR: setupSharedHookStateDir() };
    assert.equal(approveByState("target", current, env).json, null);
    assert.equal(editAs(worktree, current, env).json, null, `${label}: state approval by the common-dir basename covers the linked worktree`);
  }
});

test("[Scenario: pre-tool-mechanical-gates :: Wildcard repo-scope approval is unchanged] [WhenThen: 1] DEVPRO_REPO_SCOPE_APPROVED=* keeps approving cross-repo git writes and clones, with and without an origin (regression lock)", () => {
  const { current, shapes } = setupOriginShapes();
  const noOrigin = setupRepo("chore/wildcard-no-origin");
  for (const [label, dir] of [["main with origin", shapes.main], ["submodule with origin", shapes.submodule], ["no origin", noOrigin]]) {
    assert.equal(gitWriteAs("*", dir, current).json, null, `${label}: the wildcard approves a cross-repo git write`);
  }
  const clone = runScopeHook(
    { tool_name: "Bash", tool_input: { command: "DEVPRO_REPO_SCOPE_APPROVED=* git clone https://example.test/example/repo.git" } },
    { cwd: current }
  );
  assert.equal(clone.json, null, "the wildcard approves a clone");
  // The wildcard is not a repository name: it writes no approval state, so a later file-tool write still blocks.
  const env = { DEVPRO_SENTINEL_STATE_DIR: setupSharedHookStateDir() };
  assert.equal(approveByState("*", current, env).json, null);
  assert.equal(editAs(shapes.main, current, env).json?.decision, "block", "no state approval comes from the wildcard");
});

test("[Scenario: pre-tool-mechanical-gates :: The origin name identifies every checkout shape of one repository] [WhenThen: 1] names are compared exactly, the origin name included", () => {
  const { current, shapes } = setupOriginShapes();
  // Env marker: the origin name `target` is compared exactly, so a differently cased `Target` does not approve.
  const envCased = gitWriteAs("Target", shapes.main, current);
  assert.equal(envCased.json?.decision, "block", "a differently cased origin name is not approved");
  assert.match(envCased.json.reason, /Repo Scope Evidence Gate/);
  // State marker: an approval an earlier payload wrote with a differently cased name does not cover the target either.
  const env = { DEVPRO_SENTINEL_STATE_DIR: setupSharedHookStateDir() };
  assert.equal(approveByState("Target", current, env).json, null, "the approval marker itself passes");
  assert.equal(editAs(shapes.main, current, env).json?.decision, "block", "a differently cased state approval does not cover it");
});
