/**
 * hook-pre-tool-gate-b2.test.mjs
 *
 * Split companion of hook-pre-tool-gate.test.mjs / -b (file-level parallelism
 * for node --test). Carries the fourth quarter of the top-level test() cases;
 * shares an identical, self-contained prelude (imports + helpers + after()
 * cleanup). See hook-pre-tool-gate.test.mjs for the full test-strategy header.
 */
/**
 * hook-pre-tool-gate.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/pre-tool-gate.mjs (4 hard gates +
 * advisories).
 *
 * Test strategy:
 *   - Each test sets up an isolated git repo in /tmp via setupRepo(branchName)
 *     so the hook's `git branch --show-current` returns the expected branch.
 *   - Each test sets DEVPRO_POSTMERGE_STATE_DIR to a per-test temp dir to
 *     avoid cross-test marker pollution.
 *   - Most cases invoke the gate in-process via run() (calls the exported
 *     evaluatePreToolUsePayload), returning {json} for {decision}/{hookSpecificOutput}
 *     assertions. Cases that must assert the hook PROCESS contract (exit code,
 *     real stdout emission, sentinel/marker side effects, env-PWD branch
 *     resolution, codex systemMessage) use runSpawn(), which spawns the full
 *     hook with the PreToolUse JSON payload on stdin.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, readdirSync, utimesSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_GATE_INVENTORY,
  RETIRED_PRE_TOOL_GATES,
  GATE_BUCKETS,
  validateGateInventory,
  evaluatePreToolUsePayload,
  PASS_THROUGH,
  isConsumerSubsetReleaseBranchExempt,
} from "../hooks/pre-tool-gate.mjs";
import { defaultRepoStateDir } from "../hooks/lib/repo-state-identity.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("pre-tool-gate-test-");
const COMMIT_WITH_ATTRIBUTION =
  'git commit -m "subject" -m "Rules: v6.29.10 · Tool: test · Model: gpt-test"';
const defaultPostmergeMarkerDir = defaultRepoStateDir("devpro-postmerge-state", process.cwd());
const defaultPostmergeMarkerSnapshot = snapshotDirFiles(defaultPostmergeMarkerDir);

function snapshotDirFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function removeFilesAddedSince(dir, before, after = snapshotDirFiles(dir)) {
  const beforeSet = new Set(before);
  for (const file of after) {
    if (!beforeSet.has(file)) {
      try { rmSync(path.join(dir, file), { force: true }); } catch {}
    }
  }
}

after(() => {
  removeFilesAddedSince(defaultPostmergeMarkerDir, defaultPostmergeMarkerSnapshot);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// Minimal preflight-checklist.md fixture for branch-naming library helpers and
// rules-source-whitelist consumers that run inside isolated tmp repos.
const PREFLIGHT_FIXTURE = [
  "# preflight",
  "",
  "<!-- branch-verb-whitelist:start -->",
  "- `add` — 新增功能",
  "- `fix` — 修 bug",
  "- `refactor` — 不變行為重整",
  "- `remove` — 移除",
  "- `migrate` — 切換技術棧",
  "- `update` — 同一依賴升新版",
  "- `docs` — 純文件",
  "- `amend` — 修規範既有 requirement",
  "- `strengthen` — 補既有規則漏洞",
  "- `wire` — 啟用既有設計",
  "- `clarify` — 澄清既有規則語意",
  "- `enforce` — 把既有規則上升為強制 gate",
  "<!-- branch-verb-whitelist:end -->",
  "",
  "<!-- rules-source-whitelist:start -->",
  "- `agent-rules` — devpro-agent-rules submodule（規範同步）",
  "<!-- rules-source-whitelist:end -->",
  "",
].join("\n");

function writePreflightFixture(dir) {
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), PREFLIGHT_FIXTURE);
}

let repoCounter = 0;
const branchByCwd = new Map();
const repoTemplateByKey = new Map();

function rememberBranch(cwd, branchName) {
  branchByCwd.set(cwd, branchName);
}

function currentBranch(cwd) {
  if (branchByCwd.has(cwd)) return branchByCwd.get(cwd);
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).stdout?.trim() || "";
  if (branch) branchByCwd.set(cwd, branch);
  return branch;
}

function createRepoTemplate(branchName, { withCommit }) {
  const key = `${withCommit ? "commit" : "branch"}:${branchName}`;
  if (repoTemplateByKey.has(key)) return repoTemplateByKey.get(key);

  const dir = path.join(tmpRoot, `template-${repoTemplateByKey.size}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "");
  writePreflightFixture(dir);
  if (withCommit) {
    spawnSync("git", ["add", "x"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }
  repoTemplateByKey.set(key, dir);
  return dir;
}

function setupRepo(branchName, { withCommit = false } = {}) {
  const dir = path.join(tmpRoot, `repo-${repoCounter++}`);
  const template = createRepoTemplate(branchName, { withCommit });
  if (withCommit) {
    cpSync(template, dir, { recursive: true });
  } else {
    // Branch-only tests only need git to resolve cwd -> branch. They run
    // serially in this file, so sharing the read-only .git template avoids
    // repeated `git init` without sharing mutable working-tree files.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(template, ".git")}\n`);
    writeFileSync(path.join(dir, "x"), "");
    writePreflightFixture(dir);
  }
  rememberBranch(dir, branchName);
  return dir;
}

function setupRepoWithProductionTag(tagName = "production-2026-04-01") {
  const dir = path.join(tmpRoot, `repo-prodtag-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "init.txt"), "");
  writePreflightFixture(dir);
  spawnSync("git", ["add", "init.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // Tag this commit as production-*
  spawnSync("git", ["tag", tagName], { cwd: dir });
  // Add another commit (not on tag)
  writeFileSync(path.join(dir, "later.txt"), "");
  spawnSync("git", ["add", "later.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "later"], { cwd: dir });
  return { dir, tagName };
}

function setupRepoWithWorktree() {
  const repo = setupRepo("main", { withCommit: true });
  const wt = path.join(tmpRoot, `wt-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "-b", "bugfix/hook-cwd", wt, "HEAD"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(path.join(wt, "x"), "worktree change\n");
  rememberBranch(wt, "bugfix/hook-cwd");
  return { repo, wt };
}

// Env keys the in-process path sets; saved/restored around each call so the
// shared process.env never leaks mocks across serially-run tests.
const RUN_MOCK_ENV_KEYS = [
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "DEVPRO_SENTINEL_STATE_DIR",
  "PWD",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR",
  "DEVPRO_POSTMERGE_STATE_DIR",
  "DEVPRO_RECAP_PENDING_DIR",
  "DEVPRO_LOCAL_RELEASE_BRANCHES",
];

// Map a raw evaluatePreToolUsePayload() result to the {decision|hookSpecificOutput}
// JSON shape the hook would have written to stdout, so assertions on r.json are
// identical whether the case ran in-process or via spawn. Mirrors emitBlock()
// / emitContext() in pre-tool-gate.mjs (non-codex runtime).
function gateResultToJson(result) {
  if (!result || result === PASS_THROUGH) return null;
  if (result.block) return { decision: "block", reason: result.reason };
  if (result.advisory) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.advisory,
      },
    };
  }
  return null;
}

// In-process fast path (perf refactor). Injects cwd via the payload (toolInputCwd
// reads payload.cwd, so NO process.chdir — safe for serial test execution), sets
// the gate env mocks, calls evaluatePreToolUsePayload() directly, and restores
// env in a finally. Returns the same {code, json} shape as the spawn path; code
// is always 0 because the hook contract is "always exit 0" (the few tests that
// assert that PROCESS contract use runSpawn()).
function run(payload, { cwd, markerDir, recapPendingDir, sentinelDir, env } = {}) {
  const tempSentinelDir = sentinelDir || makeTempDir("sentinel-test-");
  const tempMarkerDir = markerDir || makeTempDir("postmerge-marker-test-");
  const tempRecapPendingDir = recapPendingDir || makeTempDir("recap-pending-test-");
  const hookCwd = cwd || process.cwd();
  const branch = currentBranch(hookCwd);

  const saved = {};
  for (const k of RUN_MOCK_ENV_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(env || {})) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
  try {
    const apply = {
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
      PWD: hookCwd,
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
        comments: [],
        headRefOid: "a".repeat(40),
        headRefName: branch,
      }),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
      DEVPRO_POSTMERGE_STATE_DIR: tempMarkerDir,
      DEVPRO_RECAP_PENDING_DIR: tempRecapPendingDir,
      ...(env || {}),
    };
    for (const [k, v] of Object.entries(apply)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    // Inject cwd via payload so the gate resolves the right repo without chdir.
    const enriched = { ...payload, cwd: payload.cwd || hookCwd };
    const result = evaluatePreToolUsePayload(enriched);
    // No `code`: the in-process path doesn't run the process, so it cannot
    // assert the hook's exit-code contract. That contract ("always exit 0") is
    // covered by the runSpawn() cases; exposing a hardcoded code:0 here would
    // make any r.code assertion tautological. Tests that need exit code use
    // runSpawn().
    return { json: gateResultToJson(result), _inProcess: true };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!sentinelDir) {
      try { rmSync(tempSentinelDir, { recursive: true, force: true }); } catch {}
    }
    if (!markerDir) {
      try { rmSync(tempMarkerDir, { recursive: true, force: true }); } catch {}
    }
    if (!recapPendingDir) {
      try { rmSync(tempRecapPendingDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// Spawn path (end-to-end). Runs the full hook in a child process — use when a
// test must assert the hook PROCESS contract (exit code, real stdout emission).
function runSpawn(payload, { cwd, markerDir, recapPendingDir, sentinelDir, env } = {}) {
  // Isolate sentinel state per invocation: each runSpawn() call gets a fresh
  // temp dir for DEVPRO_SENTINEL_STATE_DIR so tests never see real worktree
  // sentinels written by a prior git worktree add. This prevents Gate D'
  // advisories from leaking into unrelated test cases.
  const tempSentinelDir = sentinelDir || makeTempDir("sentinel-test-");
  const tempMarkerDir = markerDir || makeTempDir("postmerge-marker-test-");
  const tempRecapPendingDir = recapPendingDir || makeTempDir("recap-pending-test-");
  try {
    const hookCwd = cwd || process.cwd();
    const branch = currentBranch(hookCwd);
    const fullEnv = {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
      PWD: hookCwd,
      // Default-on cross-model gate fetches PR metadata before applying chore-A
      // diff-shape exemption. Mock PR data and no-proposal changed files so
      // these tests for other gates are not blocked by cross-model fail-closed.
      // Tests that explicitly test cross-model behavior use dedicated files.
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
        comments: [],
        headRefOid: "a".repeat(40),
        headRefName: branch,
      }),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
      DEVPRO_POSTMERGE_STATE_DIR: tempMarkerDir,
      DEVPRO_RECAP_PENDING_DIR: tempRecapPendingDir,
      ...(env || {}),
    };
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd: hookCwd,
      env: fullEnv,
    });
    let parsed = null;
    if (result.stdout && result.stdout.trim()) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
    }
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      json: parsed,
    };
  } finally {
    if (!sentinelDir) {
      try { rmSync(tempSentinelDir, { recursive: true, force: true }); } catch {}
    }
    if (!markerDir) {
      try { rmSync(tempMarkerDir, { recursive: true, force: true }); } catch {}
    }
    if (!recapPendingDir) {
      try { rmSync(tempRecapPendingDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Gate 1: Protected-Branch
// ─────────────────────────────────────────────────────────────────────────

function setupRepoWithInRepoWorktree() {
  const repo = setupRepo("main", { withCommit: true });
  const wt = path.join(repo, ".worktree", "feat");
  spawnSync("git", ["worktree", "add", "-b", "feature/feat", wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  mkdirSync(path.join(repo, "subdir"), { recursive: true });
  rememberBranch(wt, "feature/feat");
  return { repo, wt };
}
const ADD = "git " + "ad" + "d -A";

test("Gate 1: env PWD worktree resolves branch when payload cwd is missing", () => {
  const { repo, wt } = setupRepoWithWorktree();
  // e2e (spawn): env PWD is only available in a real subprocess environment — in-process path cannot simulate OS-level PWD propagation
  const r = runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `git ${"ad" + "d"} x` },
    },
    { cwd: repo, env: { PWD: wt } }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 1: env PWD from another repo is ignored and protected hook cwd still blocks", () => {
  const repo = setupRepo("main");
  const otherRepo = setupRepo("feature/other");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git ${"ad" + "d"} x` },
    },
    { cwd: repo, env: { PWD: otherRepo } }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Gate 1: payload cwd worktree keeps unqualified git write on worktree branch", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      cwd: wt,
      tool_input: {
        command: `git -C ${JSON.stringify(wt)} status && git ${"ad" + "d"} x`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate D': payload workdir matching pending worktree clears sentinel without advisory", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const sentinelDir = makeTempDir("sentinel-workdir-match-");
  const sentinelFile = path.join(sentinelDir, `pending-cd-to-worktree-${path.basename(wt)}`);
  writeFileSync(sentinelFile, `${wt}\n${Date.now()}`);

  // e2e (spawn): sentinel file deletion is a filesystem side-effect only observable after the hook process exits
  const r = runSpawn(
    {
      tool_name: "Bash",
      workdir: wt,
      tool_input: { command: "pwd" },
    },
    { cwd: repo, sentinelDir }
  );

  assert.equal(r.code, 0);
  assert.equal(r.json, null, `matching payload workdir should not advise: ${JSON.stringify(r.json)}`);
  assert.equal(existsSync(sentinelFile), false, "matching payload workdir should clear sentinel");
  rmSync(sentinelDir, { recursive: true, force: true });
});

test("Gate D': non-matching payload workdir still warns once and clears sentinel", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const other = makeTempDir("sentinel-other-cwd-");
  const sentinelDir = makeTempDir("sentinel-workdir-miss-");
  const sentinelFile = path.join(sentinelDir, `pending-cd-to-worktree-${path.basename(wt)}`);
  writeFileSync(sentinelFile, `${wt}\n${Date.now()}`);

  // e2e (spawn): sentinel file deletion and advisory emission are side-effects that require the hook to run as a real process
  const r = runSpawn(
    {
      tool_name: "Bash",
      workdir: other,
      tool_input: { command: "pwd" },
    },
    { cwd: repo, sentinelDir }
  );

  assert.equal(r.code, 0);
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /Worktree Post-Creation CD/,
    `non-matching payload workdir should warn once: ${JSON.stringify(r.json)}`
  );
  assert.equal(existsSync(sentinelFile), false, "warn-only path should clear sentinel after first advisory");
  rmSync(other, { recursive: true, force: true });
  rmSync(sentinelDir, { recursive: true, force: true });
});

test("Gate 1: git -C protected repo write command from main hook cwd → block", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git -C ${JSON.stringify(repo)} ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: mixed git -C worktree then protected write from main cwd → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git -C ${JSON.stringify(wt)} status && git ${"ad" + "d"} x`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: every local merge is blocked by Gate 2f while cherry-pick / revert retain their existing production behavior", () => {
  const repo = setupRepo("production");
  const merge = run(
    { tool_name: "Bash", tool_input: { command: "git merge --no-ff release/v6.27.0" } },
    { cwd: repo }
  );
  assert.equal(merge.json?.decision, "block");
  assert.match(merge.json.reason, /production PR-only local merge gate/);

  for (const cmd of ["git cherry-pick abc1234", "git revert HEAD"]) {
    const r = run(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { cwd: repo }
    );
    assert.equal(r.json, null, `should pass without block: ${cmd}`);
  }
});

test("Gate 1: absolute-path /usr/bin/git commit on main → block (anchor handles abs path)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "/usr/bin/git commit -m foo" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: env-prefix `GIT_AUTHOR_NAME=foo git commit` on main → block (anchor handles env)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "GIT_AUTHOR_NAME=foo git commit -m bar" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: Edit on main inside repo → block", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Edit", tool_input: { file_path: path.join(repo, "x") } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Edit/);
  assert.match(r.json.reason, /沒有 inline Bash bypass/);
});

test("Gate 1: Write on main inside repo → block", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Write",
      tool_input: { file_path: path.join(repo, "newfile.md") },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: Write to non-protected worktree path from main hook cwd → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Write",
      tool_input: { file_path: path.join(wt, "newfile.md") },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: MultiEdit on main inside repo → block", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "MultiEdit",
      tool_input: { file_path: path.join(repo, "x") },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: functions.apply_patch on main inside repo → block", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "functions.apply_patch",
      tool_input: {
        patch: [
          "*** Begin Patch",
          "*** Update File: x",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /functions\.apply_patch/);
  assert.match(r.json.reason, /檔案寫入/);
});

test("Gate 1: functions.apply_patch to non-protected worktree absolute path from main hook cwd → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const target = path.join(wt, "newfile.md");
  const r = run(
    {
      tool_name: "functions.apply_patch",
      tool_input: {
        patch: [
          "*** Begin Patch",
          `*** Add File: ${target}`,
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: Edit on main to /tmp (outside repo) → pass", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Edit", tool_input: { file_path: "/tmp/some-scratch.md" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: Write on main to $TMPDIR (outside repo) → pass", () => {
  const repo = setupRepo("main");
  const tmpFile = path.join(tmpRoot, "scratch-outside-repo.txt");
  const r = run(
    { tool_name: "Write", tool_input: { file_path: tmpFile } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: Edit on feature/foo → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Edit", tool_input: { file_path: "/tmp/x" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

// fix-gate-1-grep-false-positive bench cases (canonical FP rejection
// + happy-path regression). Original spike tested 14 cases, fix passed
// 13. Remaining known-limitation: heredoc body containing real
// `/path/git command` text may still FP — accepted as out-of-scope
// (escalation trigger: ≥1 real session report).

test("Gate 1: grep with quoted 'git commit' pattern → no block (FP fix)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: 'grep -n "git commit -F" file.md' },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: node -e with embedded JS string '/usr/bin/git commit' → no block (FP fix)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `node -e "console.log('/usr/bin/git commit')"`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: JS test array with quoted git commit string → no block (FP fix)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "echo \"const tests = ['git commit -F /tmp/msg'];\"",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: real /usr/bin/git commit on protected branch → block (regression)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "/usr/bin/git commit -m foo" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: cd /tmp && git commit from protected hook cwd → no protected-branch block", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "cd /tmp && git commit -m foo" },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `cd /tmp gives no protected repo evidence; got: ${JSON.stringify(r.json)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2f: every local merge into production is forbidden; promotion is PR-only
// ─────────────────────────────────────────────────────────────────────────

test("Scenario: Every Local Production Merge Target Blocks", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git merge release/v6.30.0" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
  assert.match(r.json.reason, /base `production`/);
  assert.match(r.json.reason, /exact merge commit/);
  assert.match(r.json.reason, /只 push tag ref/);
  assert.doesNotMatch(r.json.reason, /建議：`git merge --no-ff/);
});

test("Gate 2f: git merge --no-ff release/v6.30.0 on production → block (merge mode is not an exemption)", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git merge --no-ff release/v6.30.0" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

test("Gate 2f: git merge release/v6.30.0 --no-ff --no-edit on production → block (flag order)", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git merge release/v6.30.0 --no-ff --no-edit" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

// Prove-it: `git merge-base ... release/...` is a read-only ancestry query, NOT a
// release merge — but `\bmerge\b` matched the `merge` inside `merge-base`, so the
// gate false-blocked it on production (hit during release v6.65.0). Fixed by
// `merge(?![\w-])` excluding the hyphenated `merge-base` subcommand.
test("Scenario: Merge-Base Query Remains Read-Only", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git merge-base --is-ancestor release/v6.65.0 HEAD",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null, "merge-base ancestry query must not trip the production PR-only local merge gate");
});

test("Gate 2f: leading `cd <prod> ;` + git merge --no-ff release/X → block", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `cd ${repo} ; git merge --no-ff release/v6.65.0 -m "Merge release/v6.65.0 into production"`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

test("Gate 2f: `echo --no-ff ; git merge release/X` on production → block (no cross-statement --no-ff leak)", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "echo --no-ff ; git merge release/v6.65.0",
      },
    },
    { cwd: repo }
  );
  assert.ok(r.json, "a preceding statement must not hide the production release merge");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

// issue #851/#848 round 8 (cross-model CRITICAL): a leading git global option hid
// the `git -C <production>` from the cwd resolver, so the branch resolved to a
// non-production baseCwd and the production PR-only gate (which fires only when
// branch==production) never tripped → a local release merge into production PASSED.
// The cwd resolver now harvests `-C` even behind a leading global.
test("Gate 2f: git --no-pager -C <production> merge release/X (FF) from a non-prod worktree → block", () => {
  const repo = setupRepo("production");
  const wt = path.join(repo, ".worktree", "feat");
  spawnSync("git", ["worktree", "add", "-b", "bugfix/feat", wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git --no-pager -C ${repo} merge release/v6.30.0` } },
    { cwd: wt }
  );
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

test("Gate 2f: git --no-pager -C <production> merge --no-ff release/X from a non-prod worktree → block", () => {
  const repo = setupRepo("production");
  const wt = path.join(repo, ".worktree", "feat");
  spawnSync("git", ["worktree", "add", "-b", "bugfix/feat", wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git --no-pager -C ${repo} merge --no-ff release/v6.30.0` } },
    { cwd: wt }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

// round9 / D1: mixed `&&;` + `cd <production>` is statement-boundary-resolvable
// → production cwd → PR-only gate fires on the local release merge → block.
test("Gate 2f: `true && cd <production> ; git merge release/X` (FF) from non-prod wt → block", () => {
  const repo = setupRepo("production");
  const wt = path.join(repo, ".worktree", "feat");
  spawnSync("git", ["worktree", "add", "-b", "bugfix/feat", wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `true && cd ${repo} ; git merge release/v6.30.0` } },
    { cwd: wt }
  );
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

test("Gate 2f: same shape WITH --no-ff from non-prod wt → block (no local merge exemption)", () => {
  const repo = setupRepo("production");
  const wt = path.join(repo, ".worktree", "feat");
  spawnSync("git", ["worktree", "add", "-b", "bugfix/feat", wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `true && cd ${repo} ; git merge --no-ff release/v6.30.0` } },
    { cwd: wt }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

// round10 / D1: leading `git status` then mixed `&&;` + `cd <production>` still
// resolves to production → PR-only gate blocks the local release merge.
test("Gate 2f: `git status ; true && cd <production> ; git merge release/X` (FF) from non-prod wt → block", () => {
  const repo = setupRepo("production");
  const wt = path.join(repo, ".worktree", "feat");
  spawnSync("git", ["worktree", "add", "-b", "bugfix/feat", wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git status ; true && cd ${repo} ; git merge release/v6.30.0` } },
    { cwd: wt }
  );
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

// Legacy flag/data shapes remain blocked because no `--no-ff` placement creates
// a local-production-merge exemption.
for (const [label, command] of [
  ["--no-ff inside -m message", `git merge release/v6.30.0 -m "--no-ff"`],
  ["--no-ff inside a comment", `git merge release/v6.30.0 --no-edit # --no-ff`],
  ["--no-ff inside single-quoted message", `git merge release/v6.30.0 -m '--no-ff merge'`],
  // Substitution shapes remain recognized as production release merges.
  ["--no-ff inside $() substitution", `git merge release/v6.30.0 $(true --no-ff)`],
  ["--no-ff inside backtick substitution", "git merge release/v6.30.0 `true --no-ff`"],
]) {
  test(`Gate 2f: ${label} on production → block (no local merge exemption)`, () => {
    const repo = setupRepo("production");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /production PR-only local merge gate/);
  });
}

test("Gate 2f: git merge --ff-only release/v6.30.0 on production → block (ff-only counter to intent)", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git merge --ff-only release/v6.30.0" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

test("Scenario: Release Merge On Another Branch Does Not Trigger This Gate", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git merge release/v6.30.0" },
    },
    { cwd: repo }
  );
  // Gate 1 might attempt to fire (main protected for git write verbs but merge not in list)
  // Verify NOT fired by Gate 2f specifically
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /production PR-only local merge gate/);
  }
});

for (const command of [
  "git merge feature/foo",
  "git merge bugfix/fix-production",
  "git merge hotfix/urgent",
  "git merge abc1234",
]) {
  test(`Gate 2f: ${command} on production → block (all local merges require a PR)`, () => {
    const repo = setupRepo("production");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block");
    assert.match(r.json.reason, /production PR-only local merge gate/);
  });
}

test("Gate 2f: inline DEVPRO_HOOK_BYPASS=1 bypass → pass", () => {
  const repo = setupRepo("production");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git merge release/v6.30.0" },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});
