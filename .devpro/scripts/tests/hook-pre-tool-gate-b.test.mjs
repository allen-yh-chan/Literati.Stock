/**
 * hook-pre-tool-gate-b.test.mjs
 *
 * Split companion of hook-pre-tool-gate.test.mjs (file-level parallelism for
 * node --test). Carries the second half of the top-level test() cases; shares
 * an identical, self-contained prelude (imports + helpers + after() cleanup).
 * See hook-pre-tool-gate.test.mjs for the full test-strategy header.
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
import { advisoryText } from "./lib/hook-harness.mjs";

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

test("Gate 1w stdin: heredoc-to-FILE whose body mentions '| sh' and git → no 1w block", () => {
  // The interpreter-sink/git checks must be data-region-aware: `| sh` and `git`
  // appearing inside a `cat`-heredoc body (e.g. a commit message that documents
  // this gate) must NOT trip Gate 1w. Self-discovered: this PR's own commit
  // message body contained those literals.
  const repo = setupRepo("feature/wrap");
  const command =
    "cat > /tmp/m.txt <<'XEOF'\nprose: echo \"git push\" | sh and git add examples\nXEOF";
  const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
  if (r.json?.decision === "block") assert.doesNotMatch(r.json.reason, /Shell-wrapper git\/gh gate/);
});

// round 4 C10: a `cd` AFTER the relevant git verb must not retroactively change
// the branch that branch-parameter gates (upstream pollution, etc.) attribute to
// the verb. `git merge main ; cd <repo>` on a feature worktree is the forbidden
// "merge main into a feature branch"; the trailing cd to the main checkout must
// not mask it (it previously made the gate see "merge main on main = allowed").
test("Gate 2d C10: merge main on a feature worktree + trailing cd to main → block", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const withTrailingCd = run(
    { tool_name: "Bash", tool_input: { command: `git merge main ; cd ${repo}` } },
    { cwd: wt }
  );
  assert.equal(withTrailingCd.json?.decision, "block", `trailing cd must not mask upstream pollution, got: ${JSON.stringify(withTrailingCd.json)}`);
  // sanity: the same merge without the trailing cd also blocks
  const withoutCd = run(
    { tool_name: "Bash", tool_input: { command: `git merge main` } },
    { cwd: wt }
  );
  assert.equal(withoutCd.json?.decision, "block");
});

// issue #851/#848 round 10 (cross-model CRITICAL): the branch for branch-parameter
// gates was derived from the FIRST git/gh token's cwd (payload-level), so a
// LEADING `git status` before a `cd` into a different worktree shifted the
// resolution. The gates now resolve the branch AT THEIR OWN merge/pull verb's
// position. `git status ; cd <feature-wt> ; git merge main` from main → the merge
// runs in the feature wt → upstream pollution → block.
test("Gate 2d round10: `git status ; cd <feature-wt> ; git merge main` from main → block (per-verb branch)", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git status ; cd ${wt} ; git merge main` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Upstream pollution gate/);
});

// round12: the gate must check EVERY merge/pull occurrence — a first merge that
// is ALLOWED (on main) must not mask a later forbidden one (after a cd into a
// feature worktree). First-match-only let this pass.
test("Gate 2d round12: `git merge main ; cd <feature-wt> ; git merge main` from main → block (2nd merge)", () => {
  const { repo, wt } = setupRepoWithInRepoWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git merge main ; cd ${wt} ; git merge main` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Upstream pollution gate/);
});

// ── Gate 1w: shell-wrapper git/gh bypass (round-4 audit B systemic finding) ──
// eval / sh -c / bash -c / xargs put their command in a string argument that the
// segmenter marks as data, so every verb-matching gate misses the wrapped git/gh
// invocation. The wrapper must be blocked when its string argument contains git/gh.
for (const [label, command] of [
  ["eval git commit", `eval "git ${"com" + "mit"} -m nofooter"`],
  ["sh -c git push --force", `sh -c "git push --force origin x"`],
  ["bash -c gh pr merge --squash", `bash -c "gh pr merge 5 --squash"`],
  ["single-quoted eval git rm", `eval 'git rm -rf x'`],
  ["zsh -c git push", `zsh -c "git push --force"`],
  ["xargs git commit", `xargs git ${"com" + "mit"} -m x`],
]) {
  test(`Gate 1w: ${label} → block`, () => {
    const repo = setupRepo("feature/wrap");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Shell-wrapper git\/gh gate/);
  });
}
for (const [label, command] of [
  ["sh -c with no git", `sh -c "echo hello world"`],
  ["echo mentioning git (no wrapper)", `echo "git is a tool"`],
  ["plain git status (read)", `git status`],
  ["bash -c building a non-git pipeline", `bash -c "ls | wc -l"`],
  // round15: `env VAR=val git <verb>` is env-PASSTHROUGH (git runs directly,
  // fully gate-visible), NOT an interpreter wrapper — a natural command that
  // MUST NOT trip Gate 1w (the env false-positive that blocked legitimate
  // `env GIT_AUTHOR_DATE=… git commit` workflows).
  ["env-passthrough git add (non-protected branch)", `env FOO=1 git add -A`],
  ["env-passthrough git push (non-protected branch)", `env A=1 B=2 git push origin x`],
  [
    "env-prefixed claude reviewer allowedTools with Bash(gh/git) declarations",
    `env DEVPRO_CROSS_MODEL_REVIEWER=1 claude -p --safe-mode --allowedTools "Read,Bash(gh pr view:*),Bash(git diff:*)" --output-format stream-json`,
  ],
]) {
  test(`Gate 1w: ${label} → pass (no false-block)`, () => {
    const repo = setupRepo("feature/wrap");
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    // may be null or a non-1w decision; must NOT be the wrapper block
    if (r.json?.decision === "block") {
      assert.doesNotMatch(r.json.reason, /Shell-wrapper git\/gh gate/, `1w false-fired: ${r.json.reason}`);
    }
  });
}

test("Gate 1w: env-passthrough git push uses isolated postmerge marker state", () => {
  const repo = setupRepo("feature/wrap");
  const before = snapshotDirFiles(defaultPostmergeMarkerDir);
  let after = before;
  try {
    const r = run(
      { tool_name: "Bash", tool_input: { command: "env A=1 B=2 git push origin x" } },
      { cwd: repo }
    );
    if (r.json?.decision === "block") {
      assert.doesNotMatch(r.json.reason, /Shell-wrapper git\/gh gate/, `1w false-fired: ${r.json.reason}`);
    }
    after = snapshotDirFiles(defaultPostmergeMarkerDir);
    assert.deepEqual(after, before, "run() must not write to the repo default postmerge marker dir");
  } finally {
    removeFilesAddedSince(defaultPostmergeMarkerDir, before, after);
  }
});

// round15: the env-passthrough fix must NOT open a false-negative — `env VAR=val
// git <write>` on a protected branch must STILL block (now via the protected-
// write gate, which sees through a leading `env` prefix via TOKEN_ANCHOR), and
// `env … sh -c "git…"` (env WRAPPING an interpreter) must still trip Gate 1w.
test("Gate 1w round15: env-passthrough git write on main → block (protected-write, not 1w FP)", () => {
  const repo = setupRepo("main");
  const r = run({ tool_name: "Bash", tool_input: { command: "env FOO=1 git add -A" } }, { cwd: repo });
  assert.equal(r.json?.decision, "block", `env-prefixed write on main must block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Gate 1w round15: env wrapping an interpreter still blocks", () => {
  const repo = setupRepo("feature/wrap");
  const r = run({ tool_name: "Bash", tool_input: { command: `env FOO=1 sh -c "git add -A"` } }, { cwd: repo });
  assert.equal(r.json?.decision, "block", `env+sh -c must block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Shell-wrapper git\/gh gate/);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate D: Worktree Absolute Path positive-default safe variable handling
// ─────────────────────────────────────────────────────────────────────────

test("Gate D: ROOT assigned to literal absolute path + worktree add $ROOT/... → pass", () => {
  const repo = setupRepo("main");
  const cmd = `ROOT=${repo} && git worktree add "$ROOT/.worktree/fix-root-path" -b bugfix/fix-root-path HEAD`;
  const r = run({ tool_name: "Bash", tool_input: { command: cmd } }, { cwd: repo });
  assert.notEqual(r.json?.decision, "block", `safe same-command ROOT assignment should pass, got: ${JSON.stringify(r.json)}`);
});

test("Gate D: ROOT assigned to safe pwd expansion + worktree add ${ROOT}/... → pass", () => {
  const repo = setupRepo("main");
  const cmd = `ROOT=$(pwd) && git worktree add "\${ROOT}/.worktree/fix-root-path" -b bugfix/fix-root-path HEAD`;
  const r = run({ tool_name: "Bash", tool_input: { command: cmd } }, { cwd: repo });
  assert.notEqual(r.json?.decision, "block", `safe pwd ROOT assignment should pass, got: ${JSON.stringify(r.json)}`);
});

test("Gate D: unassigned ROOT worktree path → block", () => {
  const repo = setupRepo("main");
  const cmd = `git worktree add "$ROOT/.worktree/fix-root-path" -b bugfix/fix-root-path HEAD`;
  const r = run({ tool_name: "Bash", tool_input: { command: cmd } }, { cwd: repo });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Absolute Path Gate/);
});

test("Gate 1: git commit on release/v1 → block", () => {
  const repo = setupRepo("release/v1");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 2b: git commit on feature/foo with attribution footer → pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.29.10\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: COMMIT_WITH_ATTRIBUTION } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: git commit on feature/foo without tool/model attribution → advisory", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
  assert.match(advisoryText(r.json), /Commit attribution gate/);
});

test("Gate 2b: git commit -F message file with single-line attribution footer → pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.29.10\n");
  const msg = path.join(repo, "commit-message.txt");
  writeFileSync(msg, "subject\n\nRules: v6.29.10 · Tool: test · Model: gpt-test\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: git commit -F message file with multi-line footer (Rules/Tool/Model 拆三行) → advisory", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-message-multiline.txt");
  writeFileSync(msg, "subject\n\nRules: v6.29.10\nTool: test\nModel: gpt-test\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
  assert.match(advisoryText(r.json), /Commit attribution gate/);
});

test("Gate 2b: git commit --amend --no-edit → pass", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git commit --amend --no-edit" } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: heredoc default EOF marker → pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.33.0\n");
  const cmd = 'git commit -m "$(cat <<\'EOF\'\nsubject\n\nbody\n\nRules: v6.33.0 · Tool: claude-code · Model: claude-opus-4-7\nEOF\n)"';
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: heredoc custom MSG marker → pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.33.0\n");
  const cmd = 'git commit -m "$(cat <<\'MSG\'\nsubject\n\nbody\n\nRules: v6.33.0 · Tool: claude-code · Model: claude-opus-4-7\nMSG\n)"';
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

// F2 audit (task #6): heredoc body containing literal `"` (e.g. backtick-quoted
// shell command `\`grep "x"\``) used to break extractFlagValues simple regex
// `"([^"]*)"` truncating at the first inner `"`; partial value lost the Rules:
// footer → false-negative block. Segment-aware path now reads the full
// quoted-string segment.
test("Gate 2b: heredoc body with embedded `\"` → pass (F2 prove-it)", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.33.0\n");
  const cmd =
    'git commit -m "$(cat <<\'EOF\'\nsubject\n\nbody mentions `grep -nE "(^|[^>/])\\.worktree/" scenarios/` literal quotes inside backticks\n\nRules: v6.33.0 · Tool: claude-code · Model: claude-opus-4-7\nEOF\n)"';
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: heredoc body with embedded `\"` but missing footer → advisory", () => {
  const repo = setupRepo("feature/foo");
  const cmd =
    'git commit -m "$(cat <<\'EOF\'\nsubject\n\nbody mentions `grep "x"` literal quotes\n\nNo footer here\nEOF\n)"';
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
  assert.match(advisoryText(r.json), /Rules:/);
});

test("Gate 2b: commit -F message contains Co-Authored-By: Claude → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-coauthored.txt");
  writeFileSync(msg, "subject\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\nRules: v6.33.0 · Tool: claude-code · Model: claude-opus-4-7\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /brand marker/);
  assert.match(r.json.reason, /attribution/);
});

// ── PTG-A1: 🤖 Generated with [Claude Code] → block ─────────────────────────
test("PTG-A1: commit message contains '🤖 Generated with [Claude Code]' → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a1.txt");
  writeFileSync(msg, "subject\n\n🤖 Generated with [Claude Code]\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /attribution/);
});

// ── PTG-A2: Generated with [Claude Code] (no emoji) → block ──────────────────
test("PTG-A2: commit message contains 'Generated with [Claude Code]' (no emoji) → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a2.txt");
  writeFileSync(msg, "subject\n\nGenerated with [Claude Code]\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /attribution/);
});

// ── PTG-A3: Co-Authored-By: Claude (regression) → block ──────────────────────
test("PTG-A3: regression: commit message contains 'Co-Authored-By: Claude' → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a3.txt");
  writeFileSync(msg, "subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /brand marker/);
});

// ── PTG-A3b: Co-authored-by: Cursor (issue #1913) → block ────────────────────
test("PTG-A3b: commit -F message contains 'Co-authored-by: Cursor <cursoragent@cursor.com>' → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a3b-cursor.txt");
  writeFileSync(msg, "subject\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /brand marker/);
  assert.match(r.json.reason, /attribution/);
});

// ── PTG-A3c: human Co-Authored-By controls (Jane / Devin / Cody) → pass ──────
test("PTG-A3c: commit -F with 'Co-Authored-By: Jane Doe <jane@example.com>' + footer → pass", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a3c-jane.txt");
  writeFileSync(msg, "subject\n\nCo-Authored-By: Jane Doe <jane@example.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
});

test("PTG-A3c: commit -F with 'Co-Authored-By: Devin Smith <devin.smith@example.com>' + footer → pass", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a3c-devin.txt");
  writeFileSync(msg, "subject\n\nCo-Authored-By: Devin Smith <devin.smith@example.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
});

test("PTG-A3c: commit -F with 'Co-Authored-By: Cody Lee <cody.lee@example.com>' + footer → pass", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-ptg-a3c-cody.txt");
  writeFileSync(msg, "subject\n\nCo-Authored-By: Cody Lee <cody.lee@example.com>\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
});

// ── PTG-A4: clean message + valid footer + no forbidden → pass ────────────────
test("PTG-A4: clean commit message with valid footer and no forbidden attribution → pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.39.2\n");
  const msg = path.join(repo, "commit-ptg-a4.txt");
  writeFileSync(msg, "fix: resolve null pointer in auth handler\n\nDetailed explanation of the fix.\n\nRules: v6.39.2 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: false-positive body 結尾全大寫 token + footer in tail → pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.33.0\n");
  const msg = path.join(repo, "commit-false-positive.txt");
  writeFileSync(msg, "subject\n\nbody...\nCloses: TICKET-1234\n\nRules: v6.33.0 · Tool: claude-code · Model: claude-opus-4-7\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 2b: Rules+Model co-occur in message middle (not tail) → advisory + case B reason", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-misplaced-footer.txt");
  // Rules: v6.34.5 · Tool: claude-code · Model: opus is written in the middle, not at end
  writeFileSync(msg, "subject\n\nRules: v6.34.5 · Tool: claude-code · Model: opus\n\nbody continues after footer\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
  assert.match(advisoryText(r.json), /已偵測到 Rules: 字串/);
});

test("Gate 2b: message 完全無 Rules: footer → advisory + case A reason", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-no-footer.txt");
  // subject + body, no Rules: footer at all
  writeFileSync(msg, "subject\n\nbody without any attribution footer\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
  assert.match(advisoryText(r.json), /完全不含 Rules: footer/);
});

test("Gate 1: git checkout -b feature/add-foo on main → pass (recovery action)", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/add-foo" },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: git add / rm / mv / restore / reset / stash / rebase on main → all block", () => {
  const repo = setupRepo("main");
  for (const cmd of [
    "git add .",
    "git rm foo",
    "git mv a b",
    "git restore foo",
    "git reset --hard",
    "git stash",
    "git rebase main",
  ]) {
    const r = run(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { cwd: repo }
    );
    assert.equal(r.json?.decision, "block", `should block: ${cmd}`);
  }
});

test("Gate 1: git -C worktree write command from main hook cwd → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git -C ${JSON.stringify(wt)} ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: top-level cwd worktree write command from stale main hook cwd → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      cwd: wt,
      tool_input: { command: `git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate 1: top-level workdir worktree write command from stale main hook cwd → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  // e2e (spawn): verifies exit code 0 and no block when top-level workdir resolves to worktree — requires real hook process for env PWD resolution
  const r = runSpawn(
    {
      tool_name: "Bash",
      workdir: wt,
      tool_input: { command: `git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 1: tool_input cwd/workdir worktree write command from stale main hook cwd → pass", () => {
  for (const alias of ["cwd", "workdir"]) {
    const { repo, wt } = setupRepoWithWorktree();
    const r = run(
      {
        tool_name: "Bash",
        tool_input: {
          [alias]: wt,
          command: `git ${"ad" + "d"} x`,
        },
      },
      { cwd: repo }
    );
    assert.equal(r.json, null, `should not block for tool_input.${alias}`);
  }
});

test("Gate 1: cwd alias fields resolve worktree branch before hook cwd fallback", () => {
  for (const alias of [
    "working_dir",
    "workingDir",
    "current_working_directory",
    "currentWorkingDirectory",
  ]) {
    const { repo, wt } = setupRepoWithWorktree();
    // e2e (spawn): verifies cwd alias fields resolve worktree branch via real hook process environment
    const r = runSpawn(
      {
        tool_name: "Bash",
        [alias]: wt,
        tool_input: { command: `git ${"ad" + "d"} x` },
      },
      { cwd: repo }
    );
    assert.equal(r.code, 0, `should pass for ${alias}`);
    assert.equal(r.json, null, `should not block for ${alias}`);
  }
});

test("Gate 1: tool_input cwd aliases resolve worktree branch before hook cwd fallback", () => {
  for (const alias of ["working_dir", "workingDir"]) {
    const { repo, wt } = setupRepoWithWorktree();
    const r = run(
      {
        tool_name: "Bash",
        tool_input: {
          [alias]: wt,
          command: `git ${"ad" + "d"} x`,
        },
      },
      { cwd: repo }
    );
    assert.equal(r.json, null, `should not block for tool_input.${alias}`);
  }
});

test("Gate 1: payload cwd protected repo still blocks from worktree hook cwd", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      cwd: repo,
      tool_input: { command: `git ${"ad" + "d"} x` },
    },
    { cwd: wt }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: read-only stash list/show on protected branch → pass", () => {
  const repo = setupRepo("main");
  for (const cmd of [
    "git stash list",
    "git stash show",
    "git stash show --stat",
    "$(git stash list)",
    "(git stash list)",
    "git stash list 2>/dev/null; git worktree list 2>&1",
  ]) {
    const r = run(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { cwd: repo }
    );
    assert.equal(r.json, null, `should not block: ${cmd}`);
  }
});

test("Branch extraction regression: git branch list mode with redirects → pass", () => {
  const repo = setupRepo("main");
  for (const cmd of [
    "git branch 2>&1",
    "git branch 2>/dev/null",
    "git branch > branches.txt",
    "git --no-pager branch 2>&1",
  ]) {
    const r = run(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { cwd: repo }
    );
    assert.equal(r.json, null, `should not block: ${cmd}`);
  }
});

test("Gate 1: destructive stash subcommands on protected branch → block", () => {
  const repo = setupRepo("main");
  for (const cmd of [
    "git stash",
    "git stash push",
    "git stash pop",
    "git stash apply",
    "git stash drop",
    "git stash clear",
    "git stash store",
    "git stash branch temp",
  ]) {
    const r = run(
      { tool_name: "Bash", tool_input: { command: cmd } },
      { cwd: repo }
    );
    assert.equal(r.json?.decision, "block", `should block: ${cmd}`);
    assert.match(r.json.reason, /Protected-branch gate/);
  }
});
