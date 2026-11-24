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
// SECURITY regression (issue #851 cross-model review Critical round-2): a `cd`
// nested inside a command substitution `$( … )` / backtick or a subshell
// `( … )` does NOT change the parent shell's cwd. effectiveCdCwd must ignore
// such nested `cd`s (outer-shell-level check), else
// `echo $(true; cd <wt>); git add x` runs git on the protected branch while the
// gate resolves to the worktree and allows the write.
test("Gate 1: cd inside $(...) command substitution is not an outer chdir → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo $(true; cd ${JSON.stringify(wt)}) ; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: cd inside a ( ) subshell is not an outer chdir → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `(true; cd ${JSON.stringify(wt)}) ; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: cd inside backtick command substitution is not an outer chdir → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo \`true; cd ${wt}\` ; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: cd after a benign $(...) → pass (uncertain, fail-open advisory)", () => {
  // Policy reversed: the gate now fails OPEN (advisory only) when cwd cannot be
  // statically determined. A `$(...)` anywhere in the prefix makes the prefix
  // not-provably-flat; instead of blocking (fail-closed), the gate emits an
  // advisory and allows. Use `git -C <worktree> add` for explicit control.
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo $(date) && cd ${JSON.stringify(wt)} && git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: git -C worktree add after a benign $(...) → pass (the recommended escape)", () => {
  // The supported way to do a git write alongside a $() in the same payload:
  // an explicit `git -C <worktree>` overrides cwd per-invocation and is not
  // subject to the prefix-flatness gate.
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo $(date) && git -C ${JSON.stringify(wt)} ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null, `git -C worktree should pass regardless of $() in prefix, got: ${JSON.stringify(r.json)}`);
});

// issue #851 cross-model round 3: a `cd` inside a function-definition body or a
// skipped/looped control-flow body does NOT change the parent shell cwd. Policy
// reversed: the gate now fails OPEN (advisory) on these uncertain shapes.
test("Gate 1: cd inside a function-definition body is not an outer chdir → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `f(){ true; cd ${JSON.stringify(wt)}; }; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: cd inside a skipped if-body is not an outer chdir → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `if false; then cd ${JSON.stringify(wt)}; fi; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: cd inside a while-loop body is not an outer chdir → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `while false; do cd ${JSON.stringify(wt)}; done; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

// ── Sequential shell-cwd simulator regression (issue #848 cross-model round 4) ─
// The cwd resolver must model real shell+git cwd semantics, not match literal
// text. Worktree is created INSIDE the repo so relative `cd .worktree/.. `
// compounding can be exercised. Each "→ block" case is a real bypass where the
// git write would actually run on `main` while a naive resolver resolves to the
// worktree; each "→ pass" is a legitimate worktree workflow.
for (const [label, command, want] of [
  ["C1 relative-cd compounding → main", `cd .worktree/feat; cd ..; ${ADD}`, "block"],
  ["C1b relative-cd compounding via &&", `cd .worktree/feat && cd .. && ${ADD}`, "block"],
  ["C2 newline-separated cd → main", `cd .worktree/feat\ncd ..\n${ADD}`, "block"],
  ["C3 conditional && (cd may be skipped)", `false && cd .worktree/feat ; ${ADD}`, "pass"],
  ["C4 relative cumulative git -C → main", `cd .worktree/feat && git -C ../.. add -A`, "block"],
  ["C4b repeated -C → main", `git -C .worktree/feat -C ../.. add -A`, "block"],
  ["C6 glob target", `cd .work* && ${ADD}`, "pass"],
  ["C7 cd -P option + .. → main", `cd -P .worktree/feat && cd -P .. && ${ADD}`, "pass"],
  ["legit cd worktree (&&)", `cd .worktree/feat && ${ADD}`, "pass"],
  ["legit cd worktree (;)", `cd .worktree/feat ; ${ADD}`, "pass"],
  ["legit non-leading cd worktree", `touch z && cd .worktree/feat && ${ADD}`, "pass"],
  ["legit git -C worktree", `git -C .worktree/feat add -A`, "pass"],
]) {
  test(`Gate 1 cwd-simulator: ${label} → ${want}`, () => {
    const { repo } = setupRepoWithInRepoWorktree();
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (want === "block") {
      assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
      assert.match(r.json.reason, /Protected-branch gate/);
    } else {
      // "pass" means not a blocking decision — may be null or an advisory object.
      assert.notEqual(r.json?.decision, "block", `expected not-block, got: ${JSON.stringify(r.json)}`);
    }
  });
}

// issue #851/#848 round 8 (cross-model CRITICAL): when the resolver bails on an
// AMBIGUOUS prefix (`$()`, parens, pipe, ||) it returned "" → caller fell back
// to baseCwd. Uncertain shapes still fail OPEN (advisory). D1 statement-boundary
// parsing resolves mixed `&&;` + `cd` into a definite main path → block.
// These run with cwd = the sub-worktree (non-protected baseCwd).
for (const [label, command, want] of [
  // D1: mixed &&; + cd into main → definite main → block
  ["round8 mixed &&; with cd into main", `true && cd <MAIN> ; ${ADD}`, "block"],
  // Ambiguous prefix forms → fail-open (uncertain cwd)
  ["round8 $() before cd into main", `echo $(date) && cd <MAIN> && ${ADD}`, "pass"],
  ["round8 subshell-paren prefix with cd into main", `(true) ; cd <MAIN> ; ${ADD}`, "pass"],
  ["round8 pipe prefix with cd into main", `echo x | cat ; cd <MAIN> ; ${ADD}`, "pass"],
  // round9: pipe/||/glued forms — ambiguous prefix → fail-open
  ["round9 pipe-glued |cd into main", `echo x|cd <MAIN>;${ADD}`, "pass"],
  ["round9 ||-glued cd into main", `false||cd <MAIN>;${ADD}`, "pass"],
  ["round9 spaced pipe then cd into main", `echo x | cd <MAIN> ; ${ADD}`, "pass"],
  // round10: flat forms (no ambiguous prefix) → definite main path → still block
  ["round10 builtin cd into main", `builtin cd <MAIN> ; ${ADD}`, "block"],
  ["round10 pushd into main", `pushd <MAIN> >/dev/null ; ${ADD}`, "block"],
  ["round10 command cd into main", `command cd <MAIN> ; ${ADD}`, "block"],
  // round10: ambiguous $() prefix → fail-open
  ["round10 builtin cd hidden in $() prefix", `echo $(date) && builtin cd <MAIN> && ${ADD}`, "pass"],
]) {
  test(`Gate 1 cwd-simulator (from non-protected wt): ${label} → ${want === "block" ? "block" : "pass (uncertain, fail-open advisory)"}`, () => {
    const { repo, wt } = setupRepoWithInRepoWorktree();
    const command2 = command.replace("<MAIN>", repo);
    const r = run({ tool_name: "Bash", tool_input: { command: command2 } }, { cwd: wt });
    if (want === "block") {
      assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
      assert.match(r.json.reason, /Protected-branch gate/);
    } else {
      assert.notEqual(r.json?.decision, "block", `uncertain shape should not block, got: ${JSON.stringify(r.json)}`);
    }
  });
}

// round11: `popd` must be modeled as the inverse of `pushd` (dir stack). From the
// feature worktree, `pushd <main> ; pushd <wt> ; popd` lands back in <main>, so
// the git write runs in main → block. (Modeling pushd without popd let this pass.)
test("Gate 1 cwd-simulator round11: pushd/popd stack ending in main → block", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const cmd = `pushd ${repo} >/dev/null ; pushd ${wt} >/dev/null ; popd >/dev/null ; ${ADD}`;
  const r = run({ tool_name: "Bash", tool_input: { command: cmd } }, { cwd: wt });
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Protected-branch gate/);
});

// round11: an unsafe `cd` target in a FLAT list (e.g. `cd "$OLDPWD"`) is
// unresolvable; policy reversed — the gate now fails OPEN (advisory) rather than
// blocking on uncertain targets.
test("Gate 1 cwd-simulator round11: flat `cd \"$OLDPWD\"` (unsafe target) → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `cd "$OLDPWD" && ${ADD}` } },
    { cwd: wt, env: { OLDPWD: repo } }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd target should not block, got: ${JSON.stringify(r.json)}`);
});

// Companion no-over-block: an ambiguous prefix with NO `cd` must still fall back
// to baseCwd (the non-protected worktree) and PASS — fail-closed only when a cd
// is actually hidden.
for (const [label, command] of [
  ["round8 $() no cd → uses wt baseCwd", `echo $(date) && ${ADD}`],
  ["round8 mixed &&; no cd → uses wt baseCwd", `true && true ; ${ADD}`],
]) {
  test(`Gate 1 cwd-simulator (from non-protected wt): ${label} → pass`, () => {
    const { wt } = setupRepoWithInRepoWorktree();
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: wt });
    if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Protected-branch gate/, `over-blocked: ${r.json.reason}`);
  });
}

// CHDIR-registry parity (post-refactor SSOT guard): every cwd-changing verb form
// MUST be recognized by BOTH the flat-list running-cwd simulator AND the
// ambiguous-prefix chdir-presence probe (they now share one registry, so they
// can't drift). FLAT forms resolve to a definite main path and block. AMBIGUOUS
// forms (`$() &&` prefix) are now fail-open (advisory only, not block).
for (const verb of ["cd", "builtin cd", "command cd", "pushd", "command pushd"]) {
  test(`Gate 1 cwd-simulator registry: flat \`${verb} <main>\` from non-protected wt → block`, () => {
    const { repo, wt } = setupRepoWithInRepoWorktree();
    const tail = verb.includes("pushd") ? " >/dev/null" : "";
    const r = run({ tool_name: "Bash", tool_input: { command: `${verb} ${repo}${tail} ; ${ADD}` } }, { cwd: wt });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
  });
  test(`Gate 1 cwd-simulator registry: ambiguous \`$() && ${verb} <main>\` from non-protected wt → pass (uncertain, fail-open advisory)`, () => {
    const { repo, wt } = setupRepoWithInRepoWorktree();
    const tail = verb.includes("pushd") ? " >/dev/null" : "";
    const r = run({ tool_name: "Bash", tool_input: { command: `echo $(date) && ${verb} ${repo}${tail} && ${ADD}` } }, { cwd: wt });
    assert.notEqual(r.json?.decision, "block", `uncertain ambiguous-prefix shape should not block, got: ${JSON.stringify(r.json)}`);
  });
}

// round12: backslash-escaped chdir verbs (`\cd`, `\pushd`, alias-bypass) and the
// `pushd +N` / `popd +N` STACK ROTATION forms.
for (const [label, mk] of [
  ["\\cd <main>", (repo) => `\\cd ${repo} ; ${ADD}`],
  ["\\pushd <main>", (repo) => `\\pushd ${repo} >/dev/null ; ${ADD}`],
  ["\\command cd <main>", (repo) => `command \\cd ${repo} ; ${ADD}`],
]) {
  test(`Gate 1 cwd-simulator round12: ${label} from non-protected wt → block`, () => {
    const { repo, wt } = setupRepoWithInRepoWorktree();
    const r = run({ tool_name: "Bash", tool_input: { command: mk(repo) } }, { cwd: wt });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
  });
}

test("Gate 1 cwd-simulator round12: `pushd +N` stack rotation → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  // pushd main ; pushd wt ; pushd +1 → real shell ends in main; rotation is
  // unmodeled → policy reversed to fail-open (advisory, not block).
  const cmd = `pushd ${repo} >/dev/null ; pushd ${wt} >/dev/null ; pushd +1 >/dev/null ; ${ADD}`;
  const r = run({ tool_name: "Bash", tool_input: { command: cmd } }, { cwd: wt });
  assert.notEqual(r.json?.decision, "block", `unresolvable pushd +N should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1 cwd-simulator: --git-dir/--work-tree redirect to main from a worktree → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git --git-dir=${repo}/.git --work-tree=${repo} add -A` } },
    { cwd: wt }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain --git-dir redirect should not block, got: ${JSON.stringify(r.json)}`);
});

// round-6 cross-model: GIT_GLOBAL_OPT was enumerated ({-C,-c,--git-dir,
// --work-tree,--namespace}), so any OTHER git global option placed before a
// write verb slipped past every gate sharing GIT_WITH_C. The generalized form
// consumes ANY leading global (value-taking with =/space value; any --flag=val;
// any no-value --flag / -X). These write-verb-behind-a-global forms must block.
for (const [label, command, reasonRe] of [
  // [label, command, reasonRe] — most are Protected-branch; the --force case is
  // intercepted (correctly) by the Force-push gate, which fires ahead of Gate 1.
  ["--no-pager before add", `git --no-pager ${"ad" + "d"} x`, /Protected-branch gate/],
  ["-P alias before commit", `git -P ${"com" + "mit"} -m foo`, /Protected-branch gate/],
  ["--paginate before push --force", `git --paginate push --force`, /Force-push gate|Protected-branch gate/],
  ["--no-optional-locks before commit", `git --no-optional-locks ${"com" + "mit"} -m foo`, /Protected-branch gate/],
  ["chained globals before reset", `git --no-pager --no-optional-locks ${"re" + "set"} --hard`, /Protected-branch gate/],
  ["--exec-path=val before add", `git --exec-path=/tmp ${"ad" + "d"} x`, /Protected-branch gate/],
  ["-c value looks like a verb, real verb commit", `git -c x.y=${"ad" + "d"} ${"com" + "mit"} -m foo`, /Protected-branch gate/],
]) {
  test(`Gate 1 global-opt: ${label} on main → block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, reasonRe);
  });
}
for (const [label, command] of [
  ["--no-pager before read log", `git --no-pager log`],
  ["--no-pager before read diff", `git --no-pager diff`],
  ["--version no-value global, no verb", `git --version`],
  ["-c value before read status", `git -c core.editor=vim status`],
]) {
  test(`Gate 1 global-opt: ${label} → pass (read, no over-block)`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Protected-branch gate/);
  });
}

// help-strip fail-OPEN regression: isGitOrGhHelpStatement must not treat a
// statement as "help-only" when the -h/--help token is the VALUE of a preceding
// value-taking flag. git/gh consume the next token as the flag value, so the
// command actually executes the mutating verb — stripping it blanks the segment
// and every gateCommandSegmentText-based hard gate (force-push, merge-strategy,
// cross-model, attribution, …) fails OPEN.
for (const [label, command] of [
  ["-h as value of git push -o (push-option)", `git push --force -o -h origin main`],
  ["--help as value of git push -o", `git push --force -o --help origin main`],
]) {
  test(`help-strip: ${label} on main → force-push gate still fires`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `force-push must still be gated; got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Force-push gate|Protected-branch gate/);
  });
}

// A genuine standalone help statement MUST still be stripped (no over-block).
for (const [label, command] of [
  ["bare git push -h", `git push -h`],
  ["bare git push --help", `git push --help`],
  ["git help push", `git help push`],
]) {
  test(`help-strip: ${label} → not blocked (genuine help is read-only)`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.notEqual(r.json?.decision, "block", `genuine help must not be blocked; got: ${JSON.stringify(r.json)}`);
  });
}

test("Gate 1 cwd-simulator: CDPATH-redirected cd from a worktree → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `CDPATH=${repo} cd subdir && git ${"ad" + "d"} -A` } },
    { cwd: wt }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain CDPATH redirect should not block, got: ${JSON.stringify(r.json)}`);
});

// round-5 cross-model: a git WRITE nested in command substitution / backtick on
// a protected branch must block — the protected-write matcher must detect the
// inner verb (TOKEN_ANCHOR backtick boundary + gitVerbIndex segment check).
for (const [label, command] of [
  ["$() git commit", `$(git ${"com" + "mit"} -m x)`],
  ["backtick git reset", "echo `git " + "re" + "set --hard HEAD~1`"],
  ["$() git add", `$(git ${"ad" + "d"} -A)`],
  ["X=$() git commit", `X=$(git ${"com" + "mit"} -m x)`],
  ["X=`` git commit", "X=`git " + "com" + "mit -m x`"],
]) {
  test(`Gate 1 cmd-subst: ${label} on main → block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
  });
}
for (const [label, command] of [
  ["SHA=$(git rev-parse HEAD) read", `SHA=$(git rev-parse HEAD)`],
  ["echo $(git status) read", `echo $(git status)`],
  ["FOO=bar git status (env prefix, read)", `FOO=bar git status`],
]) {
  test(`Gate 1 cmd-subst: ${label} → pass (read, no false-block)`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Protected-branch gate/);
  });
}

test("Gate 1 cwd-simulator: GIT_DIR/GIT_WORK_TREE env-var redirect to main from a worktree → pass (uncertain, fail-open advisory)", () => {
  // dp-reviewer round-5 Important: env-var twin of --git-dir/--work-tree. Policy
  // reversed: uncertain env-var redirects now fail-open (advisory, not block).
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} git ${"ad" + "d"} -A` },
    },
    { cwd: wt }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain GIT_DIR/GIT_WORK_TREE redirect should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1 cwd-simulator: harmless env var (GIT_PAGER) before git on a worktree → pass", () => {
  const { wt } = setupRepoWithInRepoWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `GIT_PAGER=cat git ${"ad" + "d"} -A` } },
    { cwd: wt }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Protected-branch gate/, `harmless env over-blocked: ${r.json.reason}`);
  }
});

// dp-reviewer round-5 Important: git/gh fed to a bare shell interpreter via stdin
// (heredoc or pipe) is the same bypass class as eval/sh -c.
for (const [label, command] of [
  ["pipe git into sh", `echo "git push --force" | sh`],
  ["heredoc git into sh", `sh <<EOF\ngit push --force\nEOF`],
  ["heredoc git into bash", `bash <<'X'\ngit ${"com" + "mit"} -m x\nX`],
]) {
  test(`Gate 1w stdin: ${label} → block`, () => {
    const repo = setupRepo("feature/wrap");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Shell-wrapper git\/gh gate/);
  });
}
for (const [label, command] of [
  ["git log piped to head (not a shell)", `git log --oneline | head`],
  ["pipe non-git into sh", `echo hi | sh`],
  ["plain pipe", `cat file | wc -l`],
]) {
  test(`Gate 1w stdin: ${label} → pass (no false-block)`, () => {
    const repo = setupRepo("feature/wrap");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Shell-wrapper git\/gh gate/);
  });
}
