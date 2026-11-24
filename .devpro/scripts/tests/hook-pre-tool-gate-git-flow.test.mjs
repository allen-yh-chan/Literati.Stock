import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
import "./lib/portable-command-shims.cjs";
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
import { rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, utimesSync, existsSync, cpSync } from "node:fs";
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
  writePostmergeMarker,
} from "../hooks/pre-tool-gate.mjs";
import { defaultRepoStateDir } from "../hooks/lib/repo-state-identity.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("pre-tool-gate-test-");

// Wall-clock fixture setup (macOS only): /usr/bin/git is an xcrun shim that
// re-resolves the active developer directory on EVERY invocation (measured
// ~14ms/spawn shim vs ~7ms direct on the same machine). The hook under test
// spawns git several times per evaluation, so front PATH with the resolved
// developer git dir — the exact binary the shim would exec anyway (same
// version, same semantics; spawn latency only). No-op off-darwin (CI) or when
// xcrun is unavailable.
if (process.platform === "darwin") {
  try {
    const realGit = spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" })
      .stdout?.trim();
    if (realGit && realGit !== "/usr/bin/git" && existsSync(realGit)) {
      process.env.PATH = `${path.dirname(realGit)}:${process.env.PATH}`;
    }
  } catch {}
}
const COMMIT_WITH_ATTRIBUTION =
  'git commit -m "subject" -m "Rules: v6.29.10 · Tool: test · Model: gpt-test"';
const defaultPostmergeMarkerDir = defaultRepoStateDir("devpro-postmerge-state", process.cwd());
const defaultPostmergeMarkerSnapshot = snapshotDirFiles(defaultPostmergeMarkerDir);
// recap-pending dir resolves from a MODULE-LOAD-TIME constant (RECAP_PENDING_DIR
// in recap-utils.mjs), so in-process run() tests CANNOT redirect it via env the
// way spawn tests do (see openspec test-governance: "Hook Subprocess Tests
// Isolate Persistent State Marker Directories"). Any in-process test that drives
// a successful merge writes a recap-pending marker to the REAL default dir; the
// only leak-safe protocol here is file-level snapshot + restore (mirrors the
// postmerge protection above). Restores in the file-level after() below.
const defaultRecapPendingDir = defaultRepoStateDir("devpro-recap-pending", process.cwd());
const defaultRecapPendingSnapshot = snapshotDirFiles(defaultRecapPendingDir);
const CROSS_MODEL_SHA = "a".repeat(40);
const CROSS_MODEL_STICKY_PASS = [
  "<!-- cross-model-second-opinion:sticky -->",
  "verdict: PASS",
  `last_reviewed_sha: ${CROSS_MODEL_SHA}`,
  "dispatch_id: test-git-flow-pass",
  "reason: Test fixture confirms the reviewed pull request head is approved.",
  "Rules: v1.0.0 · Tool: Claude Code · Model: claude-test",
].join("\n");
const CROSS_MODEL_PROPOSAL_DIFF = "openspec/changes/test-change/proposal.md";

function crossModelPassGhOutput(branch) {
  return JSON.stringify({
    comments: [{ body: CROSS_MODEL_STICKY_PASS, url: "https://example.invalid/sticky" }],
    headRefOid: CROSS_MODEL_SHA,
    headRefName: branch,
    body: "",
  });
}

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
  removeFilesAddedSince(defaultRecapPendingDir, defaultRecapPendingSnapshot);
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

// Every fixture checkout is a checkout of this repository, and a merge in it writes the repository in full.
const OWN_REPO = "owner/repo";
const OWN_REPO_FLAG = `--repo github.com/${OWN_REPO}`;

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
  // Each step must succeed: a fixture without its origin would let the cross-repo merge gate judge another repository
  // (PR #3703 r7 W4-F3).
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr || result.error}`);
  };
  git(["init", "-q", "-b", branchName]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  // The cross-repo merge gate compares the repository a merge writes with this origin.
  git(["remote", "add", "origin", `https://github.com/${OWN_REPO}.git`]);
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

// Template cache keyed by tagName: every caller in this file uses the default
// tag, so the expensive git init + 2x commit + tag sequence (6 real git
// spawns) is built once per distinct tagName and reused via cpSync (a single
// fast recursive file copy) for every subsequent call. Callers only read
// branch/tag state (via run()'s in-process evaluatePreToolUsePayload() +
// currentBranch()) or, in one case, add a new branch ref — none of them
// mutate the shared template's own working tree/commits, so a fresh cpSync
// copy per call is a fully isolated per-test repo.
const productionTagTemplateByTagName = new Map();

function createProductionTagTemplate(tagName) {
  if (productionTagTemplateByTagName.has(tagName)) {
    return productionTagTemplateByTagName.get(tagName);
  }
  const dir = path.join(tmpRoot, `template-prodtag-${productionTagTemplateByTagName.size}`);
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
  productionTagTemplateByTagName.set(tagName, dir);
  return dir;
}

function setupRepoWithProductionTag(tagName = "production-2026-04-01") {
  const template = createProductionTagTemplate(tagName);
  const dir = path.join(tmpRoot, `repo-prodtag-${repoCounter++}`);
  cpSync(template, dir, { recursive: true });
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
      // Blank, not hookCwd: the in-process path ALWAYS injects payload.cwd
      // (below), which outranks env-PWD in the hook's toolInputCwd().
      // resolveToolInputCwd() now probes environmentPwdCwd() (which spawns
      // `git rev-parse --git-common-dir`) only when no payload field supplied
      // the cwd, so blanking PWD is decision-neutral here and keeps the
      // in-process path spawn-free. The env-PWD resolution contract itself
      // stays covered by runSpawn() cases, which keep PWD = hookCwd.
      PWD: "",
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: crossModelPassGhOutput(branch),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: CROSS_MODEL_PROPOSAL_DIFF,
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
      // Default-on cross-model gate fetches PR metadata for gh pr merge. Mock a
      // valid PASS sticky so tests for other gates are not blocked by
      // cross-model fail-closed behavior.
      // Tests that explicitly test cross-model behavior use dedicated files.
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: crossModelPassGhOutput(branch),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: CROSS_MODEL_PROPOSAL_DIFF,
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

// ─────────────────────────────────────────────────────────────────────────
// Gate 2e: Hotfix base must originate from production-* tag
// ─────────────────────────────────────────────────────────────────────────

test("Gate 2e: git checkout -b hotfix/fix-foo <production-* tag> → pass", () => {
  const { dir, tagName } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git checkout -b hotfix/fix-foo ${tagName}` },
    },
    { cwd: dir }
  );
  assert.equal(r.json, null);
});

test("Gate 2e: git checkout -b hotfix/fix-foo HEAD (HEAD not on tag) → block", () => {
  const { dir } = setupRepoWithProductionTag();
  // HEAD is the second commit (later.txt), not on the tag
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b hotfix/fix-foo HEAD" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Hotfix base gate/);
  assert.match(r.json.reason, /production-\*/);
});

test("Gate 2e: git checkout -b hotfix/fix-foo (no base, defaults HEAD non-tag) → block", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b hotfix/fix-foo" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Hotfix base gate/);
});

// issue #851/#848 round 7: the hotfix base-gate regexes previously consumed only
// a leading `git -C <dir>`, so `git --no-pager checkout -b hotfix/...` evaded the
// production-tag-base check. Now generalized via the shared GIT_GLOBAL_OPT grammar.
test("Gate 2e: git --no-pager checkout -b hotfix/fix-foo HEAD (global flag, non-tag base) → block", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git --no-pager checkout -b hotfix/fix-foo HEAD" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Hotfix base gate/);
});

test("Gate 2e: git -P switch -c hotfix/fix-foo (global flag, no base) → block", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git -P switch -c hotfix/fix-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Hotfix base gate/);
});

// issue #851/#848 round 9: the round-8 equals-form `(?:\s+|=)` fix only landed on
// W1 (IN_PLACE_BRANCH_CREATE_RE); the HOTFIX/RELEASE_RULES base-gate regexes still
// required whitespace, so the equals form escaped the production-tag-base check
// (inside a sub-worktree where W1 is exempt). Now all 6 create gates use (?:\s+|=).
for (const [label, command] of [
  ["Gate 2e: --create= equals form, no base", "git switch --create=hotfix/fix-foo"],
  ["Gate 2e: -b= equals form, HEAD non-tag base", "git checkout -b=hotfix/fix-foo HEAD"],
  ["Gate 2e: --force-create= equals form", "git switch --force-create=hotfix/fix-foo"],
  ["Gate 2e: -b= behind a global flag", "git --no-pager checkout -b=hotfix/fix-foo HEAD"],
]) {
  test(`${label} → block`, () => {
    const { dir } = setupRepoWithProductionTag();
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Hotfix base gate/);
  });
}

test("Gate 2e: non-hotfix prefix (feature/add-foo) → not fire", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/add-foo HEAD" },
    },
    { cwd: dir }
  );
  // May get other gate result but not Hotfix base
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Hotfix base gate/);
  }
});

test("Gate 2e: git worktree add ... -b hotfix/fix-foo <production-* tag> → pass", () => {
  const { dir, tagName } = setupRepoWithProductionTag();
  // Use absolute path so Gate D (Worktree Absolute Path) does not block.
  const wtAbsPath = path.join(dir, ".worktree", "hotfix-foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git worktree add ${wtAbsPath} -b hotfix/fix-foo ${tagName}`,
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json, null);
});

test("Gate 2e: git worktree add ... -b hotfix/fix-foo HEAD (non-tag) → block", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git worktree add .worktree/hotfix-foo -b hotfix/fix-foo HEAD",
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Hotfix base gate/);
});

// issue #851/#848 round 10 (cross-model CRITICAL): the positional HOTFIX_WORKTREE_RE
// only matched `worktree add <path> -b <branch>` and required whitespace after
// `-b`, so the canonical option-before-path form and the `-b=` form escaped. The
// hotfix base gate now token-parses `worktree add` (robust to option order + `=`).
for (const [label, command] of [
  ["option-before-path: add -b <br> <path> HEAD", "git worktree add -b hotfix/fix-foo .worktree/hotfix-foo HEAD"],
  ["equals form: add -b=<br> <path> HEAD", "git worktree add -b=hotfix/fix-foo .worktree/hotfix-foo HEAD"],
  ["with --detach before -b=", "git worktree add --detach -b=hotfix/fix-foo .worktree/hf HEAD"],
]) {
  test(`Gate 2e worktree round10: ${label} (non-tag base) → block`, () => {
    const { dir } = setupRepoWithProductionTag();
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Hotfix base gate/);
  });
}

// round12: the worktree base gate must check EVERY `worktree add`, not only the
// first — a benign leading add (no -b, or a non-hotfix branch) must not hide a
// later hotfix add whose dir basename would otherwise satisfy name-alignment.
test("Gate 2e worktree round12: benign first add then hotfix add → block (Hotfix base, not name-align)", () => {
  const { dir } = setupRepoWithProductionTag();
  const cmd = `git worktree add --detach /tmp/r12-detach HEAD ; git worktree add .worktree/fix-foo -b hotfix/fix-foo HEAD`;
  const r = run({ tool_name: "Bash", tool_input: { command: cmd } }, { cwd: dir });
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Hotfix base gate/);
});

// round13 regression guard: extractWorktreeAddCreates must anchor on a real
// `git … worktree add`, NOT a bare `worktree add` substring — `echo worktree
// add -b hotfix/x …` is NOT a git worktree add and MUST NOT false-block (the
// r12 per-occurrence change briefly over-blocked it).
for (const command of [
  "echo worktree add -b hotfix/fix-foo . HEAD",
  `echo "worktree add -b hotfix/x . HEAD"`,
  "printf 'git worktree add -b hotfix/x'",
]) {
  test(`Gate 2e round13: non-git \`worktree add\` substring → pass (no false-block): ${command.slice(0, 40)}`, () => {
    const { dir } = setupRepoWithProductionTag();
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Hotfix base gate|Release\/rules base gate/, `false-blocked: ${r.json.reason}`);
  });
}

test("Gate 2e: inline DEVPRO_HOOK_BYPASS=1 bypass → pass", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git checkout -b hotfix/fix-foo HEAD" },
    },
    { cwd: dir }
  );
  assert.equal(r.json, null);
});

test("Gate 2e: git checkout (no -b) hotfix/fix-foo → not fire (switching to existing branch)", () => {
  const { dir } = setupRepoWithProductionTag();
  // Create branch first via direct git
  spawnSync("git", ["branch", "hotfix/fix-foo"], { cwd: dir });
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout hotfix/fix-foo" },
    },
    { cwd: dir }
  );
  // Should not fire Hotfix base gate (no -b, just switching)
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Hotfix base gate/);
  } else {
  }
});

test("Gate 2e: false positive — `git checkout -b hotfix/fix-foo` 在 quoted shell var → pass", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'MSG="git checkout -b hotfix/fix-foo HEAD example"; echo $MSG',
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2d: Upstream Pollution (block merge/pull main/integration)
// ─────────────────────────────────────────────────────────────────────────

test("Gate 2d: git merge main on feature/x → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
  assert.match(r.json.reason, /merge main → feature/);
  assert.match(r.json.reason, /legacy bump recovery allowance/);
  assert.match(r.json.reason, /release branch 組裝完成後/);
  assert.doesNotMatch(r.json.reason, /bump 前 test gate/);
});

test("Gate 2d: git merge origin/main on bugfix/x → block", () => {
  const repo = setupRepo("bugfix/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge origin/main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: git merge origin/main on rules/* → block with rules-lane recovery", () => {
  const repo = setupRepo("rules/agent-rules-v6.45.4");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge origin/main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
  assert.match(r.json.reason, /rules lane PR 補救/);
  assert.match(r.json.reason, /rebase\/recreate 到 `origin\/main`/);
  assert.match(r.json.reason, /--force-with-lease/);
  assert.doesNotMatch(r.json.reason, /DEVPRO_HOOK_BYPASS=1/);
});

test("Gate 2d: git pull origin main on feature → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git pull origin main" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: git pull main on chore/foo → block", () => {
  const repo = setupRepo("chore/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git pull main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: git merge --no-ff main on hotfix → block", () => {
  const repo = setupRepo("hotfix/fix-foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge --no-ff main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 2d: git merge integration on release/v1 → block", () => {
  const repo = setupRepo("release/v1");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge integration" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
  // F12 widening: reason now reads "integration → 任何非 integration 分支" (covers release / feature / bugfix / chore / hotfix per ai-autonomy.md:108).
  assert.match(r.json.reason, /integration → 任何非 integration 分支/);
});

test("Gate 2d: git pull origin integration on release/v1 → block", () => {
  const repo = setupRepo("release/v1");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git pull origin integration" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2f: git merge --no-ff release/v1 on production → block (all local production merges are forbidden)", () => {
  const repo = setupRepo("production");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge --no-ff release/v1" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
  assert.match(r.json.reason, /base `production`/);
  assert.doesNotMatch(r.json.reason, /建議：`git merge --no-ff/);
});

test("Gate 2d: git merge feature/x on integration → pass (integration is downstream)", () => {
  const repo = setupRepo("integration");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git merge feature/foo" },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2d: git fetch origin main:main on feature → pass (fetch ≠ merge/pull)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git fetch origin main:main --tags" },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2d: git pull (no main reference) on feature → pass (default upstream not enforced)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git pull" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2d: git merge main on main → pass (sync from origin/main)", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main" } },
    { cwd: repo }
  );
  // Note: Gate 1 might fire instead since main is protected; check for any block reason
  if (r.json?.decision === "block") {
    // If blocked, must NOT be Upstream pollution (main on main is not pollution)
    assert.doesNotMatch(r.json.reason, /Upstream pollution/);
  }
});

test("Gate 2d: git merge main on chore/bump-v6.30.0 → pass (legacy bump recovery allowance)", () => {
  const repo = setupRepo("chore/bump-v6.30.0");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main --no-edit" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2d: git merge main on release/v6.30.0 → block (source repo release requires explicit subset)", () => {
  const repo = setupRepo("release/v6.30.0");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main --no-edit" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: git switch release/v6.30.0 && git merge main from main → block (chain-effective branch)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git switch release/v6.30.0 && git merge main --no-edit" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
  assert.match(r.json.reason, /release\/v6\.30\.0/);
});

// R16 (shared cwd arithmetic): a chdir inside parentheses is unresolvable, and
// the merge gates fail open on an unresolvable cwd. Accepted block -> allow
// shift: before R16 `(cd <dir> && git merge ...)` resolved to the hook cwd.
test("Gate 2d: (cd <dir> && git merge main) on feature/x → pass (R16 unresolvable, fail-open)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `(cd ${JSON.stringify(repo)} && git merge main)` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `parenthesized cd must fail open, got: ${JSON.stringify(r.json)}`);
});

test("Gate 2d: (git merge main) with no cd on feature/x → still block (resolves to the hook cwd)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "(git merge main)" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: (cd <dir> && git pull origin main) on feature/x → pass (R16 unresolvable, fail-open)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `(cd ${JSON.stringify(repo)} && git pull origin main)` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `parenthesized cd must fail open, got: ${JSON.stringify(r.json)}`);
});

test("Gate 2f: (cd <dir> && git merge --no-ff release/v1) on production → pass (R16 unresolvable, fail-open)", () => {
  const repo = setupRepo("production");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `(cd ${JSON.stringify(repo)} && git merge --no-ff release/v1)` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `parenthesized cd must fail open, got: ${JSON.stringify(r.json)}`);
});

test("Gate 2f: (git merge --no-ff release/v1) with no cd on production → still block (resolves to the hook cwd)", () => {
  const repo = setupRepo("production");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "(git merge --no-ff release/v1)" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production PR-only local merge gate/);
});

for (const [label, buildCmd] of [
  ["merge main", (repo) => `cd ${JSON.stringify(repo)} & git merge main`],
  ["merge main behind a group", (repo) => `{ cd ${JSON.stringify(repo)}; }; git merge main`],
  ["pull origin main behind ||", (repo) => `cd ${JSON.stringify(repo)} || true; git pull origin main`],
]) {
  test(`Scenario: Control-flow dependent cwd stays unresolved and the hard-blocking gates fail open (merge/pull main, ${label})`, () => {
    const repo = setupRepo("feature/foo");
    const r = run(
      { tool_name: "Bash", tool_input: { command: buildCmd(repo) } },
      { cwd: repo }
    );
    assert.notEqual(r.json?.decision, "block", `control-flow cd must fail open, got: ${JSON.stringify(r.json)}`);
  });
}

test("Scenario: Control-flow dependent cwd stays unresolved and the hard-blocking gates fail open (production merge, background &)", () => {
  const repo = setupRepo("production");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `cd ${JSON.stringify(repo)} & git merge --no-ff release/v1` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `control-flow cd must fail open, got: ${JSON.stringify(r.json)}`);
});

test("Gate 2d: git merge main on release/v6.30.0 → block (strict SemVer no suffix, no default full-main)", () => {
  // Per SSOT release-sit-uat-pat-prod.md L18：source repo 簡化版 release/v<X.Y.Z> 無 suffix。
  // Tightened from prior `release/v6.30.0-rc1` test — DRIFT-1 alignment: isSourceRepoReleaseBranch
  // now matches RELEASE_EXEMPTION_RE (no suffix variant)；suffix 變體無實際使用案例且
  // branch-naming library validation rejects it. The valid branch shape still does not grant
  // permission to merge all of main; `full-main` must be explicit release evidence.
  const repo = setupRepo("release/v6.30.0");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: git merge main on release/v6.30.0-rc1 → block (suffix variant rejected, DRIFT-1 alignment)", () => {
  // Negative case codifying DRIFT-1 fix：branch-naming library validation rejects
  // suffix variants；Gate 2d historically accepted suffix here due to permissive
  // `(?:-\S+)?` in isSourceRepoReleaseBranch — now tightened.
  const repo = setupRepo("release/v6.30.0-rc1");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: git merge main on release/20260503-abc1234 → block (consumer subset-style, NOT source-repo)", () => {
  const repo = setupRepo("release/20260503-abc1234");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: regression — git merge main on chore/foo (non-bump) → still block", () => {
  const repo = setupRepo("chore/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git merge main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Upstream pollution gate/);
});

test("Gate 2d: inline DEVPRO_HOOK_BYPASS=1 bypass → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git merge main" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2d: false positive — `git merge main` 在 quoted shell var → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: 'MSG="git merge main is bad"; echo $MSG' },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 5: Version Bump (AGENTS.md `版本：` line on non-bump branch)
// ─────────────────────────────────────────────────────────────────────────

test("Gate 5: Edit AGENTS.md `版本：` line on feature/x → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        old_string: "版本：6.29.10",
        new_string: "版本：6.30.0",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Version bump gate/);
  assert.match(r.json.reason, /沒有 inline Bash bypass/);
});

test("Gate 5: Edit AGENTS.md `版本：` line on chore/bump-v6.30.0 → pass", () => {
  const repo = setupRepo("chore/bump-v6.30.0");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        old_string: "版本：6.29.10",
        new_string: "版本：6.30.0",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 5: Edit AGENTS.md non-version line on feature/x → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        old_string: "## Intent 速查",
        new_string: "## Intent 速查（updated）",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 5: Edit non-AGENTS.md file containing `版本：v...` text on feature → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "other.md"),
        old_string: "版本：v1.0.0",
        new_string: "版本：v1.0.1",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 5: Write AGENTS.md full-file content with `版本：` line on feature → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        content: "# AI Agent 規範\n\n版本：6.30.0\n\n...",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Version bump gate/);
});

test("Gate 5: MultiEdit with one edit touching `版本：` line on feature → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        edits: [
          { old_string: "## Intent 速查", new_string: "## Intent 速查（updated）" },
          { old_string: "版本：6.29.10", new_string: "版本：6.30.0" },
        ],
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Version bump gate/);
});

test("Gate 5: regression #318 — Edit `版本：6.X.Y` (no v prefix) on feature → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        old_string: "版本：6.30.0",
        new_string: "版本：6.30.1",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Version bump gate/);
});

// Gate 5 — bump branch equality: new cases (enforce-bump-version-branch-equality)

test("Gate 5: bump branch chore/bump-v6.63.0 edits AGENTS.md to 版本：6.64.0 → block (mismatch)", () => {
  const repo = setupRepo("chore/bump-v6.63.0");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        old_string: "版本：6.63.0",
        new_string: "版本：6.64.0",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Version bump gate/);
  // Block reason MUST mention the mismatch (branch version vs file version)
  assert.match(r.json.reason, /6\.63\.0/);
  assert.match(r.json.reason, /6\.64\.0/);
});

test("Gate 5: bump branch chore/bump-v6.63.0 edits AGENTS.md to 版本：6.63.0 → pass (equal)", () => {
  const repo = setupRepo("chore/bump-v6.63.0");
  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "AGENTS.md"),
        old_string: "版本：6.62.0",
        new_string: "版本：6.63.0",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2: Force-Push
// ─────────────────────────────────────────────────────────────────────────

test("Gate 2: git push --force → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git push --force origin feature/foo" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Force-push gate/);
});

// ── round-4 audit B: refspec force, branch force-create, body forms ──
for (const [label, command, wantRe] of [
  ["+refspec force push", "git push origin +main", /Force-push gate/],
  ["+src:dst force push", "git push origin +HEAD:main", /Force-push gate/],
  ["+refs/heads force push", "git push origin +refs/heads/feature/foo:refs/heads/main", /Force-push gate/],
  ["clustered -fv force", "git push -fv origin main", /Force-push gate/],
  ["clustered -vf force", "git push -vf origin main", /Force-push gate/],
]) {
  test(`Gate 2: ${label} → block`, () => {
    const repo = setupRepo("feature/foo");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, wantRe);
  });
}
for (const [label, command] of [
  [":refspec delete", "git push origin :feature/foo"],
  [":refs/heads delete", "git push origin :refs/heads/feature/foo"],
]) {
  test(`Cleanup parser removed: ${label} → no force/cleanup gate block`, () => {
    const repo = setupRepo("feature/foo");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.notEqual(r.json?.decision, "block", `expected no cleanup block, got: ${JSON.stringify(r.json)}`);
    assert.doesNotMatch(advisoryText(r.json), /Branch deletion gate|Gate 2g/);
  });
}
for (const [label, command] of [
  ["force-with-lease", "git push --force-with-lease origin feature/foo"],
  ["force-if-includes (safety, not force)", "git push --force-if-includes origin feature/foo"],
  ["plain push", "git push origin feature/foo"],
]) {
  test(`Gate 2: ${label} → pass (no force-block)`, () => {
    const repo = setupRepo("feature/foo");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Force-push gate/);
  });
}
for (const [label, command] of [
  ["checkout -B force-create unknown verb", "git checkout -B feature/zzz-badverb"],
  ["switch -C force-create unknown verb", "git switch -C feature/zzz-badverb"],
  ["switch --create= equals form", "git switch --create=feature/zzz-badverb"],
  ["switch --force-create unknown verb", "git switch --force-create feature/zzz-badverb"],
]) {
  test(`Branch verb whitelist hard gate: ${label} → block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected branch-verb block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Branch Verb Whitelist gate/);
  });
}

// Multi-occurrence masking (issue #899 finding (a), applied to the live Gate 11):
// a benign/whitelisted FIRST branch-create MUST NOT mask a later illegal-verb one.
// The gate now validates EVERY command-position create (extractAllBranchNamesFromCommand).
for (const [label, command] of [
  ["whitelisted-first masks bad-verb create", "git checkout -b feature/fix-thing && git checkout -b zzz/bad-verb"],
  ["whitelisted-first masks bad-verb switch", "git switch -c feature/fix-thing && git switch -c zzz/bad-verb"],
  ["quoted-first masks real bad-verb create", "echo \"git checkout -b feature/x\" && git checkout -b zzz/bad-verb"],
  // no-arg `git branch` (list mode) in a sibling token MUST NOT mask a later illegal
  // create — symmetric with the readonly-flag per-range skip (PR #933 cross-model review).
  ["no-arg git branch masks bad-verb create", "git branch && git checkout -b zzz/bad-verb"],
  ["readonly git branch masks bad-verb create", "git branch --merged && git checkout -b zzz/bad-verb"],
]) {
  test(`Branch verb whitelist hard gate (masking): ${label} → still block later`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected branch-verb block on later occurrence, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Branch Verb Whitelist gate/);
    assert.match(r.json.reason, /zzz/, `block reason should name the illegal-verb branch, got: ${r.json.reason}`);
  });
}

// Negative: two whitelisted-verb creates → no false branch-verb block (every occurrence valid).
test("Branch verb whitelist hard gate: two whitelisted creates → no branch-verb block", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git checkout -b feature/fix-a && git switch -c bugfix/add-b" } },
    { cwd: repo }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Branch Verb Whitelist gate/, `two whitelisted-verb creates must not trip branch-verb gate, got: ${r.json.reason}`);
  }
});

for (const [label, command] of [
  ["integration from main", "git branch integration main"],
  ["production from origin/main", "git branch production origin/main"],
  ["integration tracking remote", "git branch --track integration origin/integration"],
  ["production tracking remote", "git branch --track production origin/production"],
]) {
  test(`Branch verb whitelist hard gate: protected base bootstrap ${label} → no branch-verb block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (r.json?.decision === "block") {
      assert.doesNotMatch(
        r.json.reason,
        /Branch Verb Whitelist gate/,
        `protected base bootstrap must not trip branch-verb gate, got: ${r.json.reason}`
      );
    }
  });
}

for (const [label, command] of [
  ["delete integration", "git branch -d integration"],
  ["force-delete production", "git branch -D production"],
]) {
  test(`Branch verb whitelist hard gate: protected base deletion ${label} → no branch-verb block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (r.json?.decision === "block") {
      assert.doesNotMatch(
        r.json.reason,
        /Branch Verb Whitelist gate/,
        `protected base deletion must not trip branch-verb gate, got: ${r.json.reason}`
      );
    }
  });
}

for (const [label, command] of [
  ["checkout create remains blocked", "git checkout -b integration"],
  ["switch create remains blocked", "git switch -c production"],
  ["wrong start-point remains blocked", "git branch integration feature/foo"],
  ["PR head remains blocked", "gh pr create --head integration --base main --title x --body y"],
]) {
  test(`Branch verb whitelist hard gate: protected base non-bootstrap ${label} → block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected branch-verb block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Branch Verb Whitelist gate/);
  });
}

test("Gate 2: git push -f (short flag) → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git push -f origin feature/foo" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 2: git push --force-with-lease → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git push --force-with-lease origin feature/foo",
      },
    },
    { cwd: repo }
  );
  // --force-with-lease is NOT a hard-blocked force-push; it now reaches
  // checkAdvisories and receives the dev-flow-checklist push nudge. Assert it is
  // NOT hard-blocked, and that the advisory (not a block) is what surfaces.
  assert.notEqual(r.json?.decision, "block");
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /dev-flow-checklist/
  );
});

test("Gate 2: git push --force-with-lease=origin/foo → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          "git push --force-with-lease=origin/foo origin feature/foo",
      },
    },
    { cwd: repo }
  );
  // Same as above: safe push, not hard-blocked; dev-flow-checklist advisory OK.
  assert.notEqual(r.json?.decision, "block");
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /dev-flow-checklist/
  );
});

test("Gate 2: regular git push → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git push origin feature/foo" } },
    { cwd: repo, markerDir: path.join(tmpRoot, "marker-g2-pass") }
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T1: force-push clause scope — false-positive fix
// Bug: `rm -f /tmp/x && git push origin mybranch` was blocked because `rm -f`'s
// `-f` flag landed in the merged segment text that checkForcePush scanned.
// Fix: restrict force detection to the git push clause text only.
// ─────────────────────────────────────────────────────────────────────────

test("[T1-false-positive] rm -f before git push (no force) → NOT blocked by force-push gate", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "rm -f /tmp/x && git push origin feature/foo" },
    },
    { cwd: repo }
  );
  // Must not be blocked by Force-push gate; other gates may fire (e.g. advisory)
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Force-push gate/,
      `[T1-false-positive] rm -f before plain git push MUST NOT trigger Force-push gate; got: ${JSON.stringify(r.json)}`
    );
  }
});

// T1 regressions: real force-push forms must still be blocked
test("[T1-regression] git push --force → still blocked", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git push --force origin feature/foo" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `git push --force must still block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Force-push gate/);
});

test("[T1-regression] git push -f → still blocked", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git push -f origin feature/foo" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `git push -f must still block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Force-push gate/);
});

test("[T1-regression] git push origin +main → still blocked", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git push origin +main" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `git push origin +main must still block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Force-push gate/);
});

test("[T1-regression] git push --force-with-lease → NOT blocked (safe push)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git push --force-with-lease origin feature/foo" } },
    { cwd: repo }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Force-push gate/, `--force-with-lease must not trigger Force-push gate; got: ${JSON.stringify(r.json)}`);
  }
});

// T1 index-space regression: benign push + quoted middle segment + forced push
// Bug: gitPushClauseSlices(cmdText, segs) passes the placeholder-shortened
// cmdText as first arg but segs offsets are in raw-cmd space — the second
// push's match.index (in cmdText space) falls inside a quoted-string range in
// raw segs, so isMatchInCommandSegment returns false and the force push clause
// is silently dropped. Result: pushClauses contains only the benign push,
// scanText has no force flag → NOT blocked. This is a fail-closed breakage.
// Fix: pass raw cmd (not cmdText) to gitPushClauseSlices — aligning with
// gitCommitClauseSlices which always received raw cmd.
test("[T1-regression] benign push + quoted middle + forced push → still blocked (index-space bug)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git push origin feature/a && echo "padding padding padding" && git push -f origin feature/b`,
      },
    },
    { cwd: repo }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `force-push after quoted middle segment MUST still be blocked; got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.reason, /Force-push gate/);
});

test("[T1-regression] multi-push no quoted segment → still blocked", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git push origin feature/a && git push -f origin feature/b" },
    },
    { cwd: repo }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `forced push in multi-push compound MUST be blocked; got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.reason, /Force-push gate/);
});

// T1 false-positive guards: must NOT be narrowed by the fix
test("[T1-false-positive] rm -f before plain push (quoted-segment shape) → NOT blocked by force-push gate", () => {
  // rm -f lives in its own clause; after fix, push clause still has no force flag
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `rm -f /tmp/x && echo "some message" && git push origin feature/foo`,
      },
    },
    { cwd: repo }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Force-push gate/,
      `rm -f before plain push must NOT trigger Force-push gate; got: ${JSON.stringify(r.json)}`
    );
  }
});

test("[T1-false-positive] --force as quoted string data → NOT blocked by force-push gate", () => {
  // --force appears inside a quoted string (echo argument), not as a real flag
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo "use --force" && git push origin feature/foo` },
    },
    { cwd: repo }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Force-push gate/,
      `--force inside quoted string data must NOT trigger Force-push gate; got: ${JSON.stringify(r.json)}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2c: Merge Strategy — HARD BLOCK --squash / --rebase (issue #947 finding 3)
// Restored from advisory to hard block: squash/rebase merge into main destroys the
// promotion-unit boundary the release line depends on (release-integrity violation per
// Evidence-First). The empty exception allowlist = no exception; the only escape is the
// inline DEVPRO_HOOK_BYPASS=1. A cross-model sticky PASS/WARN MUST NOT release it.
// ─────────────────────────────────────────────────────────────────────────

test("Gate 2c: gh pr merge --squash → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "gh pr merge 123 --squash" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `--squash MUST hard-block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Merge strategy gate/);
  assert.match(r.json.reason, /--squash/);
});

test("Gate 2c: gh pr merge --rebase → block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "gh pr merge 123 --rebase" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `--rebase MUST hard-block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Merge strategy gate/);
  assert.match(r.json.reason, /--rebase/);
});

test("Gate 2c: gh pr merge --merge → pass (not blocked; non-silent cross-model exemption advisory)", () => {
  const repo = setupRepo("chore/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 123 ${OWN_REPO_FLAG} --merge` },
    },
    {
      cwd: repo,
      env: {
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [],
          headRefOid: CROSS_MODEL_SHA,
          headRefName: "chore/foo",
          body: "",
        }),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
      },
    }
  );
  // Merge-strategy gate does not block --merge. The run harness mocks an empty
  // diff (no proposal*.md) → chore-A exempt → the cross-model blocking gate is
  // silent, but the cross-model-exemption-notice advisory now fires (non-silent
  // exemption). Assert NOT blocked + the exemption notice is surfaced.
  assert.notEqual(r.json?.decision, "block", `--merge must not block; got: ${JSON.stringify(r.json)}`);
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext ?? "",
    /未經第二模型|cross-model/,
    `exempt merge must emit non-silent cross-model exemption advisory; got: ${JSON.stringify(r.json)}`
  );
});

test("Gate 2c: gh pr merge w/o method flag (defaults to interactive) → pass (non-silent exemption advisory)", () => {
  const repo = setupRepo("chore/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 123 ${OWN_REPO_FLAG}` },
    },
    {
      cwd: repo,
      env: {
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [],
          headRefOid: CROSS_MODEL_SHA,
          headRefName: "chore/foo",
          body: "",
        }),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
      },
    }
  );
  assert.notEqual(r.json?.decision, "block", `must not block; got: ${JSON.stringify(r.json)}`);
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext ?? "",
    /未經第二模型|cross-model/,
    `exempt merge must emit non-silent cross-model exemption advisory; got: ${JSON.stringify(r.json)}`
  );
});

test("Gate 2c: gh pr merge --auto --squash → block (auto-queued squash)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "gh pr merge 123 --auto --squash" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `--auto --squash MUST hard-block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Merge strategy gate/);
});

// A cross-model sticky PASS/WARN must NOT release a squash/rebase merge — Gate 2c is a
// hard release-integrity gate independent of the cross-model merge gate (issue #947
// finding 3: lock that sticky state cannot downgrade the squash/rebase block).
test("Gate 2c: --squash blocks even with a PASS sticky present (sticky cannot release squash)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "gh pr merge 123 --squash" } },
    {
      cwd: repo,
      env: {
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "openspec/changes/x/proposal.md",
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [{
            body: CROSS_MODEL_STICKY_PASS,
            url: "https://example.invalid/sticky",
          }],
          headRefOid: CROSS_MODEL_SHA,
          headRefName: "feature/foo",
        }),
      },
    }
  );
  assert.equal(r.json?.decision, "block", `--squash MUST block regardless of a PASS sticky; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Merge strategy gate/);
});

test("Gate 2c: inline DEVPRO_HOOK_BYPASS=1 bypass → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "DEVPRO_HOOK_BYPASS=1 gh pr merge 123 --squash" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2c: false positive — `gh pr merge --squash` 在 quoted shell var → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: 'MSG="gh pr merge --squash deprecated"; echo $MSG' },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 4: Post-Merge Marker Tracking
// ─────────────────────────────────────────────────────────────────────────

// fix-unknown-push-reminder-repeat: a push writes no post-merge marker; a merge still does (tests below).
test("Gate 4: git push writes no marker", () => {
  const repo = setupRepo("feature/marker-push");
  const markerDir = path.join(tmpRoot, "marker-push");
  // e2e (spawn): a marker write would be a filesystem side-effect that only occurs when the hook runs as a real subprocess
  runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: "git push origin feature/marker-push" },
    },
    { cwd: repo, markerDir }
  );
  const files = existsSync(markerDir) ? readdirSync(markerDir) : [];
  assert.deepEqual(files.filter((f) => f.endsWith(".push")), [], `no push marker expected, got: ${files.join(",")}`);
});

test("Gate 4: git push --dry-run does NOT write marker", () => {
  const repo = setupRepo("feature/marker-dryrun");
  const markerDir = path.join(tmpRoot, "marker-dryrun");
  run(
    {
      tool_name: "Bash",
      tool_input: { command: "git push --dry-run origin feature/marker-dryrun" },
    },
    { cwd: repo, markerDir }
  );
  const files = existsSync(markerDir) ? readdirSync(markerDir) : [];
  assert.equal(files.length, 0);
});

test("Gate 4: gh pr merge writes marker", () => {
  const repo = setupRepo("feature/marker-merge");
  const markerDir = path.join(tmpRoot, "marker-merge");
  // e2e (spawn): marker file write is a filesystem side-effect that only occurs when the hook runs as a real subprocess
  runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 999 ${OWN_REPO_FLAG} --merge` },
    },
    { cwd: repo, markerDir }
  );
  const files = existsSync(markerDir) ? readdirSync(markerDir) : [];
  const markerFile = files.find((f) => f.endsWith(".merge"));
  assert.ok(markerFile, `merge marker expected, got: ${files.join(",")}`);
  const marker = JSON.parse(readFileSync(path.join(markerDir, markerFile), "utf8"));
  assert.equal(marker.branch, "feature/marker-merge");
  assert.equal(marker.kind, "merge");
  assert.equal(marker.prNumber, "999");
});

test("Gate 4: gh pr merge marker records PR head branch, not checkout branch", () => {
  const repo = setupRepo("main");
  const markerDir = path.join(tmpRoot, "marker-merge-head");
  runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 999 ${OWN_REPO_FLAG} --merge` },
    },
    {
      cwd: repo,
      markerDir,
      env: {
        CODEX_THREAD_ID: "session-marker-head",
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [{ body: CROSS_MODEL_STICKY_PASS, url: "https://example.invalid/sticky" }],
          headRefOid: CROSS_MODEL_SHA,
          headRefName: "chore/marker-merge-head",
          baseRefName: "main",
          body: "",
        }),
      },
    }
  );
  const files = existsSync(markerDir) ? readdirSync(markerDir) : [];
  // A merge marker is named by its repository and PR (fix-cross-repo-state-keys), never by the checkout branch.
  assert.deepEqual(files, ["github.com+owner+repo#999.merge"], `repository and PR marker expected, got: ${files.join(",")}`);
  const marker = JSON.parse(readFileSync(path.join(markerDir, "github.com+owner+repo#999.merge"), "utf8"));
  assert.equal(marker.repo, "github.com/owner/repo");
  assert.equal(marker.branch, "chore/marker-merge-head");
  assert.equal(marker.headRefName, "chore/marker-merge-head");
  assert.equal(marker.baseRefName, "main", "the merge target is recorded for the Stop hook's Local Sync reminder");
  assert.equal(marker.prNumber, "999");
  assert.equal(marker.sessionId, "session-marker-head");
  assert.equal(marker.kind, "merge");
});

// PR #3703 r11 W3-F2: when GitHub reports no head branch for the merged PR, the marker keeps its repository and PR and
// records no branch, never the checkout's branch.
test("Gate 4: a merge whose head branch is not reported records no branch, not the checkout branch", () => {
  const repo = setupRepo("main");
  const markerDir = path.join(tmpRoot, "marker-merge-no-head");
  runSpawn(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 997 ${OWN_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      markerDir,
      env: {
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [{ body: CROSS_MODEL_STICKY_PASS, url: "https://example.invalid/sticky" }],
          headRefOid: CROSS_MODEL_SHA,
          baseRefName: "main",
          body: "",
        }),
      },
    }
  );
  const files = existsSync(markerDir) ? readdirSync(markerDir) : [];
  assert.deepEqual(files, ["github.com+owner+repo#997.merge"]);
  const marker = JSON.parse(readFileSync(path.join(markerDir, files[0]), "utf8"));
  assert.equal(marker.branch, "");
  assert.equal(marker.headRefName, "");
  assert.equal(marker.prNumber, "997");
});

test("Gate 4: raw gh reads never consume a post-merge marker before the query runs", () => {
  const repo = setupRepo("main");
  const markerDir = path.join(tmpRoot, "marker-two-forks");
  mkdirSync(markerDir, { recursive: true });
  for (const pr of ["1", "2"]) {
    writeFileSync(path.join(markerDir, `github.com+owner+repo#${pr}.merge`), JSON.stringify({ kind: "merge", branch: "feature/shared", headRefName: "feature/shared", prNumber: pr, repo: "github.com/owner/repo" }));
  }
  writeFileSync(path.join(markerDir, "shared.push"), JSON.stringify({ kind: "push", branch: "feature/shared", repo: "github.com/owner/repo" }));
  for (const command of [`gh pr checks 2 ${OWN_REPO_FLAG}`, `gh run list --branch feature/shared ${OWN_REPO_FLAG}`]) {
    runSpawn({ tool_name: "Bash", tool_input: { command } }, { cwd: repo, markerDir });
    assert.deepEqual(readdirSync(markerDir).sort(), ["github.com+owner+repo#1.merge", "github.com+owner+repo#2.merge", "shared.push"]);
  }
});

test("Gate 4: gh pr merge marker records a non-main merge target as is, and an empty one when gh gave none", () => {
  const repo = setupRepo("main");
  // "develop": any target the cross-model merge gate lets through (a non-release head into production is blocked).
  for (const [tag, ghFields, expected] of [
    ["other", { baseRefName: "develop" }, "develop"],
    ["nobase", {}, ""],
  ]) {
    const markerDir = path.join(tmpRoot, `marker-merge-base-${tag}`);
    runSpawn(
      { tool_name: "Bash", tool_input: { command: `gh pr merge 998 ${OWN_REPO_FLAG} --merge` } },
      {
        cwd: repo,
        markerDir,
        env: {
          CODEX_THREAD_ID: `session-marker-base-${tag}`,
          CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
            comments: [{ body: CROSS_MODEL_STICKY_PASS, url: "https://example.invalid/sticky" }],
            headRefOid: CROSS_MODEL_SHA,
            headRefName: `chore/marker-base-${tag}`,
            body: "",
            ...ghFields,
          }),
        },
      }
    );
    const marker = JSON.parse(readFileSync(path.join(markerDir, "github.com+owner+repo#998.merge"), "utf8"));
    assert.equal(marker.baseRefName, expected, `${tag}: baseRefName`);
  }
});

test("Gate 4: in-process helper without markerDir does not touch default marker state", () => {
  const repo = setupRepo("chore/marker-helper-cleanup");
  const defaultMarkerDir = defaultRepoStateDir("devpro-postmerge-state", process.cwd());
  // The recap-pending default dir this in-process merge writes to is protected at
  // the file level (defaultRecapPendingSnapshot + after() restore), because
  // RECAP_PENDING_DIR is a module-load-time constant that in-process env override
  // cannot redirect — see the file-header note. This test only asserts the
  // postmerge marker contract, so it snapshots/restores just that dir locally.
  const before = snapshotDirFiles(defaultMarkerDir);
  let after = before;
  try {
    const r = run(
      {
        tool_name: "Bash",
        tool_input: { command: `gh pr merge 999 ${OWN_REPO_FLAG} --merge` },
      },
      {
        cwd: repo,
        env: { CODEX_THREAD_ID: "session-helper-cleanup" },
      }
    );
    assert.notEqual(r.json?.decision, "block");
    after = snapshotDirFiles(defaultMarkerDir);
    assert.deepEqual(after, before);
  } finally {
    removeFilesAddedSince(defaultMarkerDir, before, after);
  }
});

test("Gate 4: outgoing gh pr merge does not optimistically record Recap work", () => {
  const repo = setupRepo("feature/recap-pending-A");
  const markerDir = path.join(tmpRoot, "marker-recap-A");
  const recapPendingDir = path.join(tmpRoot, "recap-pending-A");
  const tx = path.join(tmpRoot, "tx-recap-pending-A.txt");
  writeFileSync(tx, "Totals: 14 passed, 0 failed (14 items)");
  // Only successful PostToolUse plus confirmed MERGED state records work.
  runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 100 ${OWN_REPO_FLAG} --merge` },
      transcript_path: tx,
    },
    { cwd: repo, markerDir, recapPendingDir }
  );
  const recapFiles = existsSync(recapPendingDir) ? readdirSync(recapPendingDir) : [];
  assert.deepEqual(recapFiles, [], "outgoing merge is not successful merge evidence");
});

test("Gate 4: raw CI reads keep the merge and Recap markers", () => {
  const repo = setupRepo("feature/recap-pending-B");
  const markerDir = path.join(tmpRoot, "marker-recap-B");
  const recapPendingDir = path.join(tmpRoot, "recap-pending-B");
  const tx = path.join(tmpRoot, "tx-recap-pending-B.txt");
  writeFileSync(tx, "Totals: 14 passed, 0 failed (14 items)");
  // A pre-existing legacy obligation is not owned by this PreToolUse event.
  mkdirSync(recapPendingDir, { recursive: true });
  const legacyFile = path.join(recapPendingDir, encodeURIComponent("feature/recap-pending-B"));
  writeFileSync(legacyFile, "legacy pending work");
  // Merge lifecycle marker remains independent from Recap.
  runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 200 ${OWN_REPO_FLAG} --merge` },
      transcript_path: tx,
    },
    { cwd: repo, markerDir, recapPendingDir }
  );
  // Raw checks keep the merge marker, and Recap has its own lifecycle.
  // e2e (spawn): marker deletion is a filesystem side-effect requiring real hook subprocess execution
  runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr checks 200 ${OWN_REPO_FLAG}` },
    },
    {
      cwd: repo,
      markerDir,
      recapPendingDir,
      env: { CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({ comments: [], headRefOid: CROSS_MODEL_SHA, headRefName: "feature/recap-pending-B" }) },
    }
  );
  const mergeFiles = existsSync(markerDir) ? readdirSync(markerDir) : [];
  const recapFiles = existsSync(recapPendingDir) ? readdirSync(recapPendingDir) : [];
  assert.equal(mergeFiles.length, 1, "raw checks should keep the merge marker");
  assert.ok(
    recapFiles.includes(encodeURIComponent("feature/recap-pending-B")),
    `recap-pending marker should persist after the checks, got: ${recapFiles.join(",")}`
  );
  assert.equal(readFileSync(legacyFile, "utf8"), "legacy pending work");
});

test("Gate 4: gh pr merge on non-work branch does NOT write recap-pending marker", () => {
  const repo = setupRepo("main");
  const markerDir = path.join(tmpRoot, "marker-nonwork");
  const recapPendingDir = path.join(tmpRoot, "recap-pending-nonwork");
  const tx = path.join(tmpRoot, "tx-recap-nonwork.txt");
  writeFileSync(tx, "Totals: 14 passed, 0 failed (14 items)");
  run(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr merge 300 ${OWN_REPO_FLAG} --merge` },
      transcript_path: tx,
    },
    { cwd: repo, markerDir, recapPendingDir }
  );
  // .merge marker still written (post-merge CI tracking applies to all branches)
  // recap-pending should be empty (writeRecapPendingMarker guards on isWorkBranch)
  const recapFiles = existsSync(recapPendingDir) ? readdirSync(recapPendingDir) : [];
  assert.equal(
    recapFiles.length,
    0,
    `recap-pending should be empty for main, got: ${recapFiles.join(",")}`
  );
});

test("Gate 4: push markers of colliding names retain distinct bounded names", () => {
  const markerDir = path.join(tmpRoot, "marker-push-collide");
  mkdirSync(markerDir, { recursive: true });
  const longBranch = `feature/${"b".repeat(200)}`;
  const longRepo = `github.com/${"o".repeat(39)}/${"r".repeat(90)}`;
  const prev = process.env.DEVPRO_POSTMERGE_STATE_DIR;
  process.env.DEVPRO_POSTMERGE_STATE_DIR = markerDir;
  try {
    writePostmergeMarker("api__main", "push", { repo: "github.com/owner/app" });
    writePostmergeMarker("main", "push", { repo: "github.com/owner/app__api" });
    writePostmergeMarker("feature/x", "push", { repo: "github.com/owner/repo" });
    writePostmergeMarker("feature_x", "push", { repo: "github.com/owner/repo" });
    writePostmergeMarker(longBranch, "push", { repo: longRepo });
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_POSTMERGE_STATE_DIR;
    else process.env.DEVPRO_POSTMERGE_STATE_DIR = prev;
  }
  const kept = () => readdirSync(markerDir)
    .map((name) => JSON.parse(readFileSync(path.join(markerDir, name), "utf8")))
    .map((marker) => `${marker.repo} ${marker.branch}`)
    .sort();
  assert.deepEqual(kept(), [
    "github.com/owner/app api__main",
    "github.com/owner/app__api main",
    "github.com/owner/repo feature/x",
    "github.com/owner/repo feature_x",
    `${longRepo} ${longBranch}`,
  ].sort());
  assert.ok(readdirSync(markerDir).every((name) => Buffer.byteLength(name) <= 255), JSON.stringify(readdirSync(markerDir)));
});

// A checkout with the given remotes (name, fetch URL, optional push URL), for the push tests below.
function setupRemoteRepo(branchName, remotes) {
  const repo = setupRepo(branchName, { withCommit: true });
  spawnSync("git", ["-C", repo, "remote", "remove", "origin"], { stdio: "ignore" });
  for (const [name, url, pushUrl] of remotes) {
    spawnSync("git", ["-C", repo, "remote", "add", name, url], { stdio: "ignore" });
    if (pushUrl) spawnSync("git", ["-C", repo, "remote", "set-url", "--push", name, pushUrl], { stdio: "ignore" });
  }
  return repo;
}

// fix-unknown-push-reminder-repeat: which repository and branches a push writes cannot be read before it runs (#3704 r5),
// and a marker of an unknown repository could never be cleared by the CI query it asked for, so no push writes a marker,
// whatever it writes and wherever it runs; tracking CI after a push is left to git-workflow-tracking.md.
test("Gate 4: no push writes a marker, whatever it writes", () => {
  for (const [label, command, remotes] of [
    ["bare", "git push"],
    ["refspecs", "git push origin feature/multi HEAD:refs/heads/release/x"],
    ["all", "git push --all origin"],
    ["tag", "git push origin tag v1"],
    ["two-clauses", "git push origin feature/multi && git push origin other"],
    ["empty-option", "git push $PUSH_OPTS https://fixture-user:fixture-secret@github.com/owner/a.git feature/multi"],
    ["url", "git push --receive-pack x https://fixture-user:fixture-secret@github.com/owner/a.git other"],
    ["remote-change", "git remote set-url origin https://github.com/owner/b.git && git push origin HEAD"],
    ["pushurl", "git push origin feature/multi", [["origin", "https://github.com/owner/a.git", "https://github.com/owner/elsewhere.git"]]],
    ["other-host", "git push ghe feature/multi", [["ghe", "https://ghe.example.com/owner/a.git"]]],
  ]) {
    const repo = setupRemoteRepo("feature/multi", remotes ?? [["origin", "https://github.com/owner/a.git"]]);
    const markerDir = path.join(tmpRoot, `marker-push-none-${label}`);
    // e2e (spawn): a marker write would be a filesystem side-effect of the real hook subprocess
    runSpawn({ tool_name: "Bash", tool_input: { command } }, { cwd: repo, markerDir });
    assert.deepEqual(existsSync(markerDir) ? readdirSync(markerDir) : [], [], command);
  }
});

test("Bypass: inline DEVPRO_HOOK_BYPASS=1 → Bash gates skipped", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git commit -m foo" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Bypass: env builtin prefix DEVPRO_HOOK_BYPASS=1 → Bash gates skipped", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "env DEVPRO_HOOK_BYPASS=1 git commit -m foo" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Bypass: token in later command segment bypasses whole Bash payload", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git commit -m foo && DEVPRO_HOOK_BYPASS=1 printf ok" },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Bypass: DEVPRO_HOOK_BYPASS=1 inside quoted text does not bypass", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: 'echo "DEVPRO_HOOK_BYPASS=1 git commit -m foo" && git commit -m foo' } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate|Commit attribution gate/);
});

test("Bypass: DEVPRO_HOOK_BYPASS=1 inside command substitution does not bypass", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: '$(echo x; DEVPRO_HOOK_BYPASS=1 printf y) && git commit -m foo' } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate|Commit attribution gate/);
});

test("Advisory: git commit --no-verify → additionalContext warning", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.29.10\n");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `${COMMIT_WITH_ATTRIBUTION} --no-verify` },
    },
    { cwd: repo }
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /no-verify/
  );
});

// amend-push-block-attribution R3: behavioral pins for two gaps that ai-autonomy.md §Never
// and its entry-anchor paragraph disclose (no hook blocks or warns on these forms). They pin
// today's behavior, not a desired one: if a gate is added later these turn red, which is the
// cue to update those two paragraphs (pre-push-deletion-guard.test.mjs binds their wording:
// the §Never squash/rebase line, and the entry-anchor paragraph's --no-verify clauses).
test("Advisory gap pin: git push --no-verify gets no --no-verify reminder (only git commit does)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git push origin feature/foo --no-verify" } },
    { cwd: repo }
  );
  assert.doesNotMatch(
    `${advisoryText(r)}\n${r.json?.reason ?? ""}`,
    /no-verify/,
    `no PreToolUse gate mentions --no-verify on git push; got: ${JSON.stringify(r.json)}`
  );
});

test("Gate 2c gap pin: gh pr merge -s / -r are not matched by the merge-strategy gate (long flags only)", () => {
  for (const flag of ["-s", "-r"]) {
    const repo = setupRepo("chore/foo");
    const r = run(
      { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${OWN_REPO_FLAG} ${flag}` } },
      {
        cwd: repo,
        env: {
          CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
            comments: [],
            headRefOid: CROSS_MODEL_SHA,
            headRefName: "chore/foo",
          }),
          CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
        },
      }
    );
    assert.doesNotMatch(
      r.json?.reason ?? "",
      /Merge strategy gate/,
      `gh pr merge ${flag} is not matched by Gate 2c today; got: ${JSON.stringify(r.json)}`
    );
  }
});

// e2e (spawn): asserts the codex-runtime stdout shape (systemMessage), which is
// emitted by emitContext() only in a real hook process — keep on runSpawn.
test("Codex advisory: git commit --no-verify → systemMessage warning", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.29.10\n");
  const r = runSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `${COMMIT_WITH_ATTRIBUTION} --no-verify` },
    },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.equal(r.code, 0);
  assert.match(r.json?.systemMessage || "", /no-verify/);
  assert.equal(r.json?.hookSpecificOutput, undefined);
});

// Consumer and unknown checkouts must carry a DEV deploy-verify line; the tests below cover other gates.
const DEV_BODY = `## Test Evidence\n- DEV deploy-verify: HEAD ${"0".repeat(40)}; N/A: test fixture`;

test("Advisory: gh pr create without --base → additionalContext warning", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr create --title foo --body '${DEV_BODY}'` },
    },
    { cwd: repo }
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /--base/
  );
});

test("Advisory: gh pr create --draft → dev-flow-checklist nudge, no --base hint", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `gh pr create --draft --title foo --body '${DEV_BODY}'` },
    },
    { cwd: repo }
  );
  // The dev-flow-checklist stage-3/4 nudge fires on every gh pr create (draft or
  // not — the checklist stages apply regardless). The conditional --base hint is
  // suppressed because --draft is present.
  const ctx = r.json?.hookSpecificOutput?.additionalContext || "";
  assert.match(ctx, /dev-flow-checklist/);
  assert.doesNotMatch(ctx, /--base/);
});

// ─── Token-frugal advisories ──────────────────────────────────────────────

test("Advisory: bare `git log` → token-frugal warning", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git log" } },
    { cwd: repo }
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /git log/
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /max-count|--oneline|head/
  );
});

test("Advisory: `git log --oneline -30` → no warning (limit present)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -30" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.hookSpecificOutput?.additionalContext, undefined);
});

test("Advisory: `git log | head -50` → no warning (pipe limit)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git log | head -50" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.hookSpecificOutput?.additionalContext, undefined);
});

test("Advisory: bare `git diff` → token-frugal warning", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git diff" } },
    { cwd: repo }
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /git diff/
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /--stat|path filter/
  );
});

test("Advisory: `git diff --stat` → no warning (stat present)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git diff --stat" } },
    { cwd: repo }
  );
  assert.equal(r.json?.hookSpecificOutput?.additionalContext, undefined);
});

test("Advisory: `git diff -- path/to/file` → no warning (path filter)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git diff main..HEAD -- README.md" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.hookSpecificOutput?.additionalContext, undefined);
});

test("Advisory: `gh repo view <repo>` (no --json) → token-frugal warning", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "gh repo view nidhinjs/prompt-master" },
    },
    { cwd: repo }
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /gh repo view/
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /--json/
  );
});

test("Advisory: `gh repo view --json name` → no warning", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "gh repo view foo/bar --json name" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.hookSpecificOutput?.additionalContext, undefined);
});

test("Advisory: `gh api .../readme` (no --jq) → token-frugal warning", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "gh api repos/foo/bar/readme" },
    },
    { cwd: repo }
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /gh api/
  );
  assert.match(
    r.json?.hookSpecificOutput?.additionalContext || "",
    /--jq/
  );
});

test("Advisory: `gh api .../readme --jq '.download_url'` → no warning", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "gh api repos/foo/bar/readme --jq '.download_url'",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.hookSpecificOutput?.additionalContext, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Pass-through cases
// ─────────────────────────────────────────────────────────────────────────

test("Pass-through: Read tool → no inspection", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Read", tool_input: { file_path: "/tmp/x" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Pass-through: empty Bash command → no-op", () => {
  const r = run({ tool_name: "Bash", tool_input: { command: "" } });
  assert.equal(r.json, null);
});

test("Pass-through: malformed JSON payload → exit 0", () => {
  const result = spawnSync("node", [HOOK], {
    input: "not-json",
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Dogfood prove-it cases (T1) — meeting-notes 6 踩雷場景
// D1-D4 should already pass on v6.32.2; D5/D6 are the FP6 main targets.
// After T4 parser integration, all 6 must pass.
// ─────────────────────────────────────────────────────────────────────────

test("Dogfood D1: grep with quoted 'git commit -F' pattern on feature/x → not blocked", () => {
  const repo = setupRepo("feature/x");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: 'grep "git commit -F" file.md' },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

test("Dogfood D2: node -e with quoted '/usr/bin/git commit' JS array on feature/x → not blocked", () => {
  const repo = setupRepo("feature/x");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `node -e "const t = ['/usr/bin/git commit'];"` },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

test("Dogfood D3: git checkout -b release/v6.32.0 on any branch → not blocked (release exemption)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/v6.32.0" },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

test("Dogfood D4: gh pr create --head release/v6.32.0 → not blocked", () => {
  const repo = setupRepo("release/v6.32.0", { withCommit: true });
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `gh pr create --base production --head release/v6.32.0 --title t --body '${DEV_BODY}'`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

test("Dogfood D5: echo with embedded /usr/bin/git commit in double-quoted string on feature/x → not blocked (FP6 main target)", () => {
  const repo = setupRepo("feature/x");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `echo "Test 2: ... embedded /usr/bin/git commit ..."`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

test("Dogfood D6: cat heredoc body containing /usr/bin/git commit on feature/x → not blocked", () => {
  const repo = setupRepo("feature/x");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "cat <<EOF\n/usr/bin/git commit\nEOF",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

// Subshell-promotion contract test (per dp-reviewer PR #366 Suggestion #3):
// shell-context.mjs flattens subshell `$(...)` and backtick content into
// command segments — so a real `git commit` invocation inside `$()` on a
// protected branch MUST still block. Locks the design contract from
// archive/2026-05-04-refactor-pre-tool-gate-shell-aware/decisions.md D2.
test("Subshell-promotion: $(git commit) on main → blocked (subshell flattens to command segment)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "echo $(git commit -m foo)",
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `subshell command should block on main, got: ${JSON.stringify(r.json)}`);
});

// ─────────────────────────────────────────────────────────────────────────
