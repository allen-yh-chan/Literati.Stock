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

import "./lib/git-location-isolated-env.mjs";
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
  checkPostPrLineageApprovalCommentWriteGuard,
} from "../hooks/pre-tool-gate.mjs";
import { defaultRepoStateDir } from "../hooks/lib/repo-state-identity.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";
import { computeSeamsContentFingerprint } from "../lib/clarification-contract.mjs";

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

function writeSessionPendingClaim(repo, changeName, { batchApproval = true } = {}) {
  mkdirSync(path.join(repo, "notes"), { recursive: true });
  writeFileSync(
    path.join(repo, "notes", "session-pending.md"),
    [
      `- Formalize ${changeName}`,
      `  - claimed: ${changeName}`,
      batchApproval
        ? `  - approval: 2026-07-24 user authorized batch approval through PR merge for ${changeName}`
        : "  - trigger: discuss before implementation",
      "",
    ].join("\n")
  );
}

function writeProposalMini(repo, changeName, ledgerSection) {
  const dir = path.join(repo, "openspec", "changes", changeName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "proposal-mini.md"),
    [
      `# Proposal: ${changeName}`,
      "",
      "## Why",
      "",
      "test fixture",
      "",
      "## Batch Approval Ledger",
      "",
      ledgerSection.trim(),
      "",
    ].join("\n")
  );
}

/** Seams-first: proposal*.md writes require confirmed sibling meeting-notes. */
function writeConfirmedSeamsNotes(repo, changeName) {
  const dir = path.join(repo, "openspec", "changes", changeName);
  mkdirSync(dir, { recursive: true });
  const seams = `grep alignment for ${changeName}`;
  writeFileSync(
    path.join(dir, "meeting-notes.md"),
    [
      "## Seams Confirmation",
      `- seams: ${seams}`,
      "- confirmed: true",
      "- provenance: user",
      "- bypass: none",
      "- bypass_reason:",
      `- seams_fingerprint: ${computeSeamsContentFingerprint(seams)}`,
      "- reconfirm_required: false",
      "- invalidation_reason: none",
      "",
    ].join("\n")
  );
}

function validBatchApprovalLedger(changeName, branch) {
  return [
    "kind: same-change-dp-change-batch",
    `named_change: ${changeName}`,
    `branch: ${branch}`,
    "repo_scope: same-repo",
    "covers:",
    "  - first_push",
    "  - pr_create_update",
    "excludes:",
    "  - release",
  ].join("\n");
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

function setupRepoWithWorktree(branchName = "bugfix/hook-cwd") {
  const repo = setupRepo("main", { withCommit: true });
  const wt = path.join(tmpRoot, `wt-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "-b", branchName, wt, "HEAD"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(path.join(wt, "x"), "worktree change\n");
  rememberBranch(wt, branchName);
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
      // Default-on cross-model gate fetches PR metadata before gate decisions.
      // Mock PR data and empty changed files so these other-gate tests do not
      // depend on live PR metadata; dedicated files cover cross-model semantics.
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

test("Gate inventory: active blocking gates declare bucket/evidence/risk and reject raw regex evidence", () => {
  const active = ACTIVE_GATE_INVENTORY;
  assert.ok(active.length >= 10, "expected active PreToolUse gate inventory");

  const blocking = active.filter((gate) => gate.decision === "block");
  assert.ok(blocking.length >= 8, "expected blocking gates to be classified");

  for (const gate of blocking) {
    assert.ok(gate.id, "blocking gate must have id");
    assert.ok(
      gate.bucket === GATE_BUCKETS.HARD ||
        gate.bucket === GATE_BUCKETS.STATE_BACKED,
      `${gate.id} has invalid blocking bucket ${gate.bucket}`
    );
    assert.ok(gate.evidence, `${gate.id} must declare evidence`);
    assert.ok(gate.risk, `${gate.id} must declare risk`);
    assert.notEqual(
      gate.evidence,
      "raw-full-command-regex",
      `${gate.id} must not block from raw full-command regex evidence`
    );
    assert.notEqual(
      gate.evidence,
      "normative-workflow-debt",
      `${gate.id} must not block from normative workflow debt`
    );
  }

  assert.throws(
    () =>
      validateGateInventory([
        {
          id: "bad-raw-regex-block",
          bucket: GATE_BUCKETS.HARD,
          decision: "block",
          evidence: "raw-full-command-regex",
          risk: "workflow",
          runner: () => null,
        },
      ]),
    /raw-full-command-regex/
  );
});

test("Gate inventory: retired parser classes are moved/deleted, not active gates", () => {
  const activeIds = new Set(ACTIVE_GATE_INVENTORY.map((gate) => gate.id));
  for (const id of [
    "legacy-transcript-merge-evidence",
    "cleanup-command-parser",
    "legacy-sync-chore-regex",
  ]) {
    assert.ok(!activeIds.has(id), `${id} must not be active`);
  }

  const retiredById = new Map(RETIRED_PRE_TOOL_GATES.map((gate) => [gate.id, gate]));
  assert.equal(retiredById.get("cleanup-command-parser")?.bucket, GATE_BUCKETS.MOVED);
  assert.equal(retiredById.get("legacy-sync-chore-regex")?.bucket, GATE_BUCKETS.DELETE);
  assert.ok(activeIds.has("branch-verb-whitelist"), "branch-verb-whitelist must be active");
});

test("Gate SP: claimed session-pending batch approval blocks N/A ledger before implementation write", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeSessionPendingClaim(repo, changeName);
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Session Pending Batch Approval Ledger/);
  assert.match(r.json.reason, /notes\/session-pending\.md/);
  assert.match(r.json.reason, /N\/A: no batch approval selected/);
});

test("Gate SP: linked worktree reads main-checkout session-pending claim before implementation write", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const { repo, wt } = setupRepoWithWorktree(branch);
  writeSessionPendingClaim(repo, changeName);
  writeProposalMini(wt, changeName, "N/A: no batch approval selected");

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(wt, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write from linked worktree\n",
      },
    },
    { cwd: wt }
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Session Pending Batch Approval Ledger/);
  assert.match(r.json.reason, /notes\/session-pending\.md/);
  assert.match(r.json.reason, /N\/A: no batch approval selected/);
});

test("Gate SP: claimed session-pending batch approval allows OpenSpec correction write", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeSessionPendingClaim(repo, changeName);
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");
  writeConfirmedSeamsNotes(repo, changeName);

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, "openspec/changes", changeName, "proposal-mini.md"),
        content: [
          `# Proposal: ${changeName}`,
          "",
          "## Batch Approval Ledger",
          "",
          validBatchApprovalLedger(changeName, branch),
          "",
        ].join("\n"),
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

// fix-flow-gate-gaps R1 (case iv): a relative path whose tail merely MATCHES
// the `openspec/changes/<x>/proposal*.md` shape but whose actual directory is
// NOT a change folder must resolve its sibling from the target's own directory
// — not from a cwd-rebuilt `<repo>/openspec/changes/<x>/` path. Accepted
// behavior change: such writes block (no sibling next to the tail-shaped
// target) even when a valid same-name sibling exists in the real change folder.
test("Seams-first relative: tail-shaped path outside any change folder → block (target-relative sibling only)", () => {
  const changeName = "scratch-dir-proposal";
  const repo = setupRepo(`chore/${changeName}`, { withCommit: true });
  // Decoy: valid sibling in the real change folder at the repo root.
  writeConfirmedSeamsNotes(repo, changeName);
  mkdirSync(path.join(repo, "notes", "tmp", "scratch", "openspec", "changes", changeName), {
    recursive: true,
  });

  const rel = `notes/tmp/scratch/openspec/changes/${changeName}/proposal-mini.md`;
  const r = run({ tool_name: "Write", tool_input: { file_path: rel, content: "x" } }, { cwd: repo });

  assert.equal(
    r.json?.decision,
    "block",
    `tail-shaped path outside the change folder must block; got ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.reason, /Seams-first expansion gate/);
  assert.ok(
    r.json.reason.replaceAll("\\", "/").includes(`notes/tmp/scratch/openspec/changes/${changeName}/meeting-notes.md`),
    `reason must name the sibling next to the target; got ${r.json.reason}`
  );
});

test("Gate SP: session-pending maintenance write remains advisory-only", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeSessionPendingClaim(repo, changeName);
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");

  const r = run(
    {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "notes", "session-pending.md"),
        old_string: "",
        new_string: "- missing disposition fields\n",
      },
    },
    { cwd: repo }
  );

  assert.notEqual(r.json?.decision, "block");
  assert.match(advisoryText(r.json), /Gate N/);
});

test("Gate SP: valid batch approval ledger permits implementation write", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeSessionPendingClaim(repo, changeName);
  writeProposalMini(repo, changeName, validBatchApprovalLedger(changeName, branch));

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

test("Gate SP: unclaimed pending item does not block implementation write", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeSessionPendingClaim(repo, "another-change");
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

// Gate SP counts only `approval:` sub-items as approval records; a claimed item
// whose heading or other bullets merely discuss approval terms is topic text.
function gateSpVerdictForPendingItem(changeName, itemLines) {
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  mkdirSync(path.join(repo, "notes"), { recursive: true });
  writeFileSync(path.join(repo, "notes", "session-pending.md"), [...itemLines, ""].join("\n"));
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");
  return run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  ).json;
}

test("Gate SP: claimed item that only discusses approval terms does not block a stepwise implementation write", () => {
  const changeName = "fix-gate-sp-topic-text";
  const verdict = gateSpVerdictForPendingItem(changeName, [
    "## Gate SP 把待辦正文中提到授權的字樣當成批次授權紀錄",
    "",
    "  - 觀察：正文只要命中 batch approval 或整批授權就被當成紀錄",
    "  - 建議：區分授權.*PR merge 這類議題文字與真正紀錄",
    `  - claimed: ${changeName}`,
  ]);
  assert.equal(verdict, null);
});

test("Gate SP: an `approval:` line inside a fenced example is not a record", () => {
  const changeName = "fix-gate-sp-fenced-example";
  const verdict = gateSpVerdictForPendingItem(changeName, [
    "## Example of an approval record",
    "",
    "  ```markdown",
    `  - approval: 2026-07-24 user authorized batch approval through PR merge for ${changeName}`,
    "  ```",
    `  - claimed: ${changeName}`,
  ]);
  assert.equal(verdict, null);
});

test("Gate SP: an `approval:` line without approval terms does not block", () => {
  const changeName = "fix-gate-sp-stepwise-line";
  const verdict = gateSpVerdictForPendingItem(changeName, [
    "## Formalize the stepwise item",
    "",
    "  - approval: user chose stepwise confirmation",
    `  - claimed: ${changeName}`,
  ]);
  assert.equal(verdict, null);
});

test("Gate SP: an `approval:` sub-item under a heading item still blocks the N/A ledger", () => {
  const changeName = "fix-gate-sp-heading-record";
  const verdict = gateSpVerdictForPendingItem(changeName, [
    "## Formalize the diagnosis",
    "",
    `  - approval: 2026-07-24 user authorized batch approval through PR merge for ${changeName}`,
    `  - claimed: ${changeName}`,
  ]);
  assert.equal(verdict?.decision, "block");
  assert.match(verdict.reason, /Session Pending Batch Approval Ledger/);
});

// ─────────────────────────────────────────────────────────────────────────
// Gate R1: General-mode batch approval ledger pre-write (no session-pending
// claim required — fires for any active `<type>/<change>` proposal).
// ─────────────────────────────────────────────────────────────────────────

function writeProposalMiniWithoutLedgerSection(repo, changeName) {
  const dir = path.join(repo, "openspec", "changes", changeName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "proposal-mini.md"),
    [
      `# Proposal: ${changeName}`,
      "",
      "## Why",
      "",
      "test fixture",
      "",
    ].join("\n")
  );
}

test("Gate R1: active proposal missing Batch Approval Ledger heading → block", () => {
  const changeName = "general-mode-r1-missing-heading";
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeProposalMiniWithoutLedgerSection(repo, changeName);

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /General-mode Batch Approval Ledger Prewrite/);
  assert.match(r.json.reason, /missing.*Batch Approval Ledger/);
});

test("Gate R1: N/A ledger passes in general mode (no session-pending claim)", () => {
  const changeName = "general-mode-r1-na-allow";
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

test("Gate R1: fully structured ledger passes in general mode", () => {
  const changeName = "general-mode-r1-structured-allow";
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeProposalMini(repo, changeName, validBatchApprovalLedger(changeName, branch));

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

test("Gate R1: structured ledger with mismatched named_change → block (dp-reviewer I-D regression)", () => {
  // brd.md:236 material negative (iv): a ledger whose fields don't match the
  // active change/branch MUST NOT be treated as valid authorization evidence.
  // Prior coverage was module-level only (batch-approval-ledger.test.mjs);
  // this proves the gate itself blocks on the mismatch end to end.
  const changeName = "general-mode-r1-mismatched-named-change";
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  const ledger = validBatchApprovalLedger(changeName, branch).replace(
    `named_change: ${changeName}`,
    "named_change: some-other-change",
  );
  writeProposalMini(repo, changeName, ledger);

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /General-mode Batch Approval Ledger Prewrite/);
  assert.match(r.json.reason, /missing or mismatched.*named_change/);
});

test("Gate R1: write under openspec/changes/<change>/ is exempt even when ledger is missing", () => {
  const changeName = "general-mode-r1-openspec-write-exempt";
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeProposalMiniWithoutLedgerSection(repo, changeName);

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, "openspec/changes", changeName, "tasks.md"),
        content: "- [ ] T1\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

test("Gate R1: active proposal not yet written is exempt", () => {
  const changeName = "general-mode-r1-no-active-proposal-yet";
  const branch = `feature/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  // No openspec/changes/<changeName>/ directory at all.

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  assert.equal(r.json, null);
});

test("Gate R1 must not invert Gate SP polarity: claimed session-pending batch approval + N/A ledger still blocks", () => {
  const changeName = "strengthen-diagnosis-reentry-prewrite-gate";
  const branch = `chore/${changeName}`;
  const repo = setupRepo(branch, { withCommit: true });
  writeSessionPendingClaim(repo, changeName);
  writeProposalMini(repo, changeName, "N/A: no batch approval selected");

  const r = run(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(repo, ".devpro/scripts/hooks/pre-tool-gate.mjs"),
        content: "implementation write\n",
      },
    },
    { cwd: repo }
  );

  // Gate R1 alone would PASS this (general-mode N/A is legitimate); Gate SP
  // must still independently BLOCK it — the two gates' verdicts are OR'd by
  // runGateInventory (first block wins), so Gate R1's allow must never
  // suppress Gate SP's block.
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Session Pending Batch Approval Ledger/);
});

test("Gate 1: git commit on main → block", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
  assert.match(r.json.reason, /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);
  assert.match(r.json.reason, /git -C <abs-worktree>/);
  assert.doesNotMatch(r.json.reason, /DEVPRO_HOOK_BYPASS/);
});

test("Gate 1: git commit on master → block", () => {
  const repo = setupRepo("master");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

// ─── Gate 1 content-materialize coverage ───────────────────────────────────
// `git checkout <tree-ish> -- <pathspec>` and `git read-tree -u` write an arbitrary
// commit/tree's content into the working tree + index of the current branch — on a
// protected branch this materializes foreign content onto main/master/production
// (the mechanism that polluted main in this session: a sub-worktree's tree checked
// out into the main worktree). The protected-write gate matched `restore` but missed
// these two forms. They MUST block on a protected branch.
for (const [label, command] of [
  ["checkout tree-ish -- .", "git checkout abc1234 -- ."],
  ["checkout tree-ish -- file", "git checkout abc1234 -- file.txt"],
  ["checkout tree-ish -- dirs", "git checkout origin/main -- src/ test/"],
  ["read-tree -u -m", "git read-tree -u -m abc1234"],
  ["read-tree -m -u (flag order)", "git read-tree -m -u abc1234"],
]) {
  test(`Gate 1 content-materialize on main: ${label} → block`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command, cwd: repo } }, { cwd: repo });
    assert.equal(r.json?.decision, "block", `"${command}" on main MUST block (content materialize); got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
    // Distinguishable marker so the NON-target / separator-crossing negatives below are
    // not vacuous (PR #933 cross-model round 6: the generic protected-write reason carries
    // no content/materialize token, so a regressed FP could pass a `doesNotMatch` check).
    assert.match(r.json.reason, /content-materialize/, `"${command}" must block via the content-materialize path; got: ${r.json.reason}`);
  });
}

// Legitimate / non-cross-tree forms MUST NOT be caught by this coverage:
for (const [label, command] of [
  ["checkout -- file (own index restore, no tree-ish)", "git checkout -- file.txt"],
  ["read-tree without -u (index only)", "git read-tree abc1234"],
  ["checkout detached (no pathspec)", "git checkout abc1234"],
  // Separator-crossing guard (PR #933 cross-model rounds 5-6): a plain checkout followed
  // by a SEPARATE command whose argv uses `--` must NOT be glued into a content-materialize
  // match (the content-materialize arm must stay within one shell command segment). Round 5
  // closed `;` `|` `&`; round 6 closed NEWLINE (the inter-token `\s` covered `\n`).
  ["checkout then ; echo -- arg", "git checkout main ; echo -- done"],
  ["checkout then | grep -- arg", "git checkout abc1234 | grep -- foo"],
  ["checkout -b then && log -- file", "git checkout -b feature/x && git log -- file"],
  ["checkout then && diff -- path", "git checkout main && git diff -- src/app.js"],
  ["checkout then NEWLINE diff -- path", "git checkout main\ngit diff -- src/app.js"],
  ["checkout then NEWLINE echo -- arg", "git checkout main\necho -- done"],
]) {
  test(`Gate 1 content-materialize NON-target on main: ${label} → not this gate`, () => {
    const repo = setupRepo("main");
    const r = run({ tool_name: "Bash", tool_input: { command, cwd: repo } }, { cwd: repo });
    // These write no foreign content into the working tree (a plain checkout, then a
    // SEPARATE command that merely uses `--`). The content-materialize path MUST NOT be
    // the block reason. (Another gate — e.g. W1 for `git checkout abc` switching a branch
    // in the main worktree — may legitimately block; only the content-materialize reason
    // is forbidden here. The distinguishable `content-materialize` marker makes this
    // assertion non-vacuous, per round 6.)
    if (r.json?.decision === "block") {
      assert.doesNotMatch(r.json.reason, /content-materialize/, `"${command}" must NOT block via content-materialize; got: ${r.json.reason}`);
    }
  });
}

test("Gate 1: git commit on production → block", () => {
  const repo = setupRepo("production");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
});

test("Gate 1: fallback-only hook cwd on main + plain git add → advisory, not block", () => {
  const { repo } = setupRepoWithWorktree();
  // e2e (spawn): verifies exit code + advisory text emitted by real hook process when branch detection falls back to git -C worktree
  const r = runSpawn(
    { tool_name: "Bash", tool_input: { command: "git add x" } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.notEqual(r.json?.decision, "block", `fallback-only evidence must not block, got: ${JSON.stringify(r.json)}`);
  assert.match(advisoryText(r.json), /fallback-only|git -C|worktree/);
  assert.match(advisoryText(r.json), /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);
  assert.match(advisoryText(r.json), /git -C <abs-worktree>/);
  assert.doesNotMatch(advisoryText(r.json), /DEVPRO_HOOK_BYPASS/);
});

test("Gate 1: fallback-only hook cwd on main + git rebase --continue → advisory, not block", () => {
  const { repo } = setupRepoWithWorktree();
  // e2e (spawn): verifies advisory text shape for fallback-only branch detection on rebase continuation — requires real hook process
  const r = runSpawn(
    { tool_name: "Bash", tool_input: { command: "git rebase --continue" } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.notEqual(r.json?.decision, "block", `fallback-only rebase continuation must not block, got: ${JSON.stringify(r.json)}`);
  assert.match(advisoryText(r.json), /fallback-only|git -C|worktree/);
});

test("Gate 1: payload cwd confirming main + git add → block", () => {
  const { repo } = setupRepoWithWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git add x", cwd: repo } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
  assert.match(r.json.reason, /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);
  assert.match(r.json.reason, /git -C <abs-worktree>/);
  assert.doesNotMatch(r.json.reason, /DEVPRO_HOOK_BYPASS/);
});

test("Gate 1: explicit git -C main add from hook cwd main → block", () => {
  const { repo } = setupRepoWithWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git -C ${repo} add x` } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

test("Gate 1: git -C <worktree> add from hook cwd main → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git -C ${wt} add x` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, undefined, `should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: leading cd <worktree> write command from hook cwd main → pass", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `cd ${JSON.stringify(wt)} && git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null, `should not block after leading cd to worktree, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: chained cd before protected write from hook cwd main → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `cd ${JSON.stringify(wt)} && cd ${JSON.stringify(repo)} && git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

test("Gate 1: variable leading cd before protected write from hook cwd main → pass (uncertain, fail-open advisory)", () => {
  const { repo } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `cd $WT && git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

// Fail-open POLICY (issue #851/#848): an uncertain-cwd git write is NOT blocked
// and SURFACES a non-blocking advisory (additionalContext) instead. This locks
// the accident-prevention threat model: don't false-block (which halts the
// workflow); remind instead.
test("Gate 1: uncertain-cwd git write → non-blocking advisory (not block)", () => {
  const { repo } = setupRepoWithInRepoWorktree();
  const wt = path.join(repo, ".worktree", "feat");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `echo $(date) && cd ${repo} && git ${"ad" + "d"} -A` } },
    { cwd: wt }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain write must not block, got: ${JSON.stringify(r.json)}`);
  assert.ok(
    r.json?.hookSpecificOutput?.additionalContext,
    `expected a non-blocking advisory, got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.hookSpecificOutput.additionalContext, /worktree|git -C|保護分支/);
});

// Anti-over-correction guard: the fail-open reversal MUST NOT weaken DEFINITE
// blocks. A plain protected-branch write and a definite `cd <main> && git add`
// (real existing main checkout) MUST still hard-block.
test("Gate 1: definite protected write still blocks after fail-open reversal", () => {
  const { repo } = setupRepoWithInRepoWorktree();
  const wt = path.join(repo, ".worktree", "feat");
  const onMain = run({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, { cwd: repo });
  assert.equal(onMain.json?.decision, "block", `plain commit on main must block, got: ${JSON.stringify(onMain.json)}`);
  const cdMain = run({ tool_name: "Bash", tool_input: { command: `cd ${repo} && git ${"ad" + "d"} -A` } }, { cwd: wt });
  assert.equal(cdMain.json?.decision, "block", `definite cd <main> && git add must block, got: ${JSON.stringify(cdMain.json)}`);
});

test("Gate 1: command-substitution leading cd before protected write from hook cwd main → pass (uncertain, fail-open advisory)", () => {
  const { repo } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `cd /tmp/$(date) && git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

// issue #851 Gap 1: the cd before the git write need NOT be the first token of
// the payload. A non-cd command preceding `cd <worktree>` (the common
// worktree-workflow shape) must still resolve the git write to the worktree.
test("Gate 1: non-leading cd <worktree> write from hook cwd main → pass (issue #851)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `touch x && cd ${JSON.stringify(wt)} && git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null, `non-leading cd to worktree should not block, got: ${JSON.stringify(r.json)}`);
});

// The last unconditional cd wins: a non-leading cd to a worktree followed by a
// cd back to the protected checkout must STILL block (no trusting an earlier cd
// over a later re-navigation to a protected branch).
test("Gate 1: non-leading cd worktree then cd back to main before write → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `mkdir a && cd ${JSON.stringify(wt)} && cd ${JSON.stringify(repo)} && git ${"ad" + "d"} x`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

// A cd introduced by a conditional (||) operator is ambiguous (depends on
// runtime success); the gate now fails open (advisory only) on uncertain cwd.
test("Gate 1: conditional || cd before protected write → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `cd ${JSON.stringify(wt)} || cd ${JSON.stringify(repo)} && git ${"ad" + "d"} x`,
      },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

test("Gate 1: single-pipe | cd before protected write → pass (uncertain, fail-open advisory)", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `echo hi | cd ${JSON.stringify(wt)} ; git ${"ad" + "d"} x`,
      },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `uncertain cd shape should not block, got: ${JSON.stringify(r.json)}`);
});

// R16 (shared cwd arithmetic): a chdir inside parentheses or backticks is
// unresolvable, so the protected-write gate fails open instead of judging the
// write at the hook cwd. Accepted block -> allow shift: before R16 these
// resolved to the protected main checkout and blocked.
for (const [label, build] of [
  ["(cd <wt> && git add)", (wt) => `(cd ${JSON.stringify(wt)} && git ${"ad" + "d"} x)`],
  ["(cd <wt>; git add)", (wt) => `(cd ${JSON.stringify(wt)}; git ${"ad" + "d"} x)`],
  ["backtick cd <wt> then git add", (wt) => `\`cd ${wt}\` ; git ${"ad" + "d"} x`],
]) {
  test(`Gate 1: ${label} from hook cwd main → pass (R16 unresolvable, fail-open)`, () => {
    const { repo, wt } = setupRepoWithWorktree();
    const r = run({ tool_name: "Bash", tool_input: { command: build(wt) } }, { cwd: repo });
    assert.notEqual(r.json?.decision, "block", `${label} must fail open, got: ${JSON.stringify(r.json)}`);
  });
}

test("Gate 1: parenthesized git write with no cd from hook cwd main → still block (resolves to the hook cwd)", () => {
  const { repo } = setupRepoWithWorktree();
  const r = run(
    { tool_name: "Bash", tool_input: { command: `(git ${"ad" + "d"} x)` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

for (const [label, build] of [
  ["group { cd; }", (wt) => `{ cd ${JSON.stringify(wt)}; }; git ${"ad" + "d"} x`],
  ["background &", (wt) => `cd ${JSON.stringify(wt)} & git ${"ad" + "d"} x`],
  ["shell control keyword", (wt) => `if true; then cd ${JSON.stringify(wt)}; fi; git ${"ad" + "d"} x`],
  ["CDPATH=", (wt) => `CDPATH=/tmp; cd ${JSON.stringify(wt)} && git ${"ad" + "d"} x`],
]) {
  test(`Scenario: Control-flow dependent cwd stays unresolved and the hard-blocking gates fail open (protected-branch write, ${label})`, () => {
    const { repo, wt } = setupRepoWithWorktree();
    const r = run({ tool_name: "Bash", tool_input: { command: build(wt) } }, { cwd: repo });
    assert.notEqual(r.json?.decision, "block", `${label} must fail open, got: ${JSON.stringify(r.json)}`);
  });
}

// SECURITY regression (issue #851 review Critical): a `cd <worktree>` literal
// inside a quoted string / comment / heredoc body is NOT a real chdir. The
// generalized effectiveCdCwd MUST segment the command and ignore such `cd`s,
// otherwise `echo "...cd <wt>..."; git add` would run on the protected branch
// while the gate falsely resolves to the worktree and lets the write through.
test("Gate 1: cd inside double-quoted string is not a real chdir → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo "; cd ${JSON.stringify(wt)}" ; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

test("Gate 1: cd inside single-quoted string is not a real chdir → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo '; cd ${wt}' ; git ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

test("Gate 1: cd inside a comment is not a real chdir → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `echo hi # ; cd ${wt}\ngit ${"ad" + "d"} x` },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

test("Gate 1: cd inside a heredoc body is not a real chdir → block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `cat <<'EOF'\n; cd ${wt}\nEOF\ngit ${"ad" + "d"} x`,
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
  assert.match(r.json.reason, /main/);
});

// #3556 item 3: a body file named through a shell variable cannot be read before the shell runs. The guard still
// refuses, and its reason says that cause instead of only "cannot be read".
test("lineage approval guard names a shell-expanded comment body file", () => {
  const unreadable = { readFileSync: () => { throw new Error("ENOENT"); } };
  for (const command of [
    "F=/abs/notes/tmp/comment-1.md; gh issue comment 5 --repo acme/widget --body-file $F",
    'gh issue comment 5 --repo acme/widget --body-file "$F"',
    'gh pr comment 5 -F "${F}"',
    'gh pr comment 5 --body-file "$(pwd)/comment.md"',
  ]) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, unreadable);
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /Lineage Approval Write Guard/, command);
    assert.match(result.reason, /shell 變數或命令替換/, command);
    assert.match(result.reason, /字面絕對路徑/, command);
  }
  const literal = checkPostPrLineageApprovalCommentWriteGuard("gh issue comment 5 --body-file /abs/missing.md", unreadable);
  assert.equal(literal?.block, true);
  assert.doesNotMatch(literal.reason, /shell 變數或命令替換/, "an unreadable literal path keeps the existing reason");
});

test("lineage approval comments cannot be created or deleted through the pre-tool shell surface", () => {
  const repo = setupRepo("bugfix/marker-guard");
  const approvalMarker = "<!-- devpro-post-pr-lineage-approval -->";
  const blocked = [
    `gh pr comment 2879 --body '${approvalMarker}'`,
    `gh api repos/acme/widget/issues/2879/comments -f body='${approvalMarker}'`,
    `gh api graphql -f query='mutation { addComment(input:{body:"${approvalMarker}"}) { clientMutationId } }'`,
    `gh api graphql -f query='query { wrapper(value:"\\u003c!-- devpro-post-pr-lineage-approval --\\u003e") }'`,
    `gh api graphql -f query='query { wrapper(value:"${approvalMarker}") }'`,
    `gh api graphql -F variables='{"input":{"body":"${approvalMarker}"}}'`,
    `gh api repos/acme/widget/issues/2879/comments --method POST -f body='${approvalMarker}'`,
    "gh pr comment 2879 --delete-last --yes",
    "gh pr comment 2879 --delete-last",
    "gh issue comment 2879 --delete-last --yes",
    "gh issue comment 2879 --delete-last",
    "gh pr comment 2879 --edit-last --body ordinary-reviewer-text",
    "gh api graphql -f query='mutation($b:String!){addComment(input:{body:$b})}' -f b=ordinary",
    "gh api graphql -f query='mutation($b:String!){addComment(input:{body:$b})}' -f 'b=ordinary'",
    "gh api graphql -f query='mutation($b:String!){addComment(input:{body:$b})}' --field \"b=ordinary\"",
    // A named mutation, and one preceded by a comment line, are still comment mutations with a non-body variable.
    "gh api graphql -f query='mutation AddNote($b:String!){addComment(input:{body:$b}){clientMutationId}}' -f b=ordinary",
    "gh api graphql -f query='# add a note\nmutation($b:String!){addComment(input:{body:$b}){clientMutationId}}' -f b=ordinary",
    "gh api repos/acme/widget/issues/comments/9001 -X DELETE",
    "gh api repos/acme/widget/issues/comments/9001 -XDELETE",
    "gh api repos/acme/widget/issues/comments/9001 --method DELETE",
    "gh api repos/acme/widget/issues/comments/9001 --method=DELETE",
    "gh api repos/acme/widget/issues/comments/9001 --method=delete",
    "gh api repos/acme/widget/issues/comments/9001 --method patch -f body=ordinary",
    "gh api repos/acme/widget/issues/comments/9001 -X PATCH -f body=ordinary",
    "gh api /repos/acme/widget/issues/2879/comments -F body='" + approvalMarker + "'",
    "gh api graphql -f query='mutation($b:String!){addComment(input:{subjectId:\"…\",body:$b}){clientMutationId}}' -f b=\"$(printf '\\074!-- devpro-post-pr-lineage-approval --\\076')\"",
    "gh pr comment 2879 --body \"$(printf '\\074!-- devpro-post-pr-lineage-approval --\\076')\"",
    "gh api repos/acme/widget/issues/2879/comments --input -",
    "gh api repos/acme/widget/issues/2879/comments -f body=@-",
    "gh api graphql -f query='mutation($b:String!){addComment(input:{body:$b})}' -f 'b=@-'",
    "gh api graphql -F body=@- -f query='mutation($b:String!){addComment(input:{subjectId:\"x\",body:$b}){clientMutationId}}'",
    "gh api graphql -F body=@/nonexistent/approval.md -f query='mutation($b:String!){addComment(input:{subjectId:\"x\",body:$b}){clientMutationId}}'",
    `curl -X POST --data 'body=${approvalMarker}' https://api.github.com/repos/acme/widget/issues/2879/comments`,
    "curl --request POST --json \"$APPROVAL_BODY\" https://api.github.com/repos/acme/widget/issues/2879/comments",
    "curl -X POST --data 'body=$APPROVAL_BODY' https://api.github.com/repos/acme/widget/issues/2879/comments",
    "curl -X POST --data-binary \"$(cat /tmp/approval.json)\" https://api.github.com/repos/acme/widget/issues/2879/comments",
    "curl -X POST --data-binary \\\n  \"$(cat /tmp/approval.json)\" \\\n  https://api.github.com/repos/acme/widget/issues/2879/comments",
    "curl -X DELETE https://api.github.com/repos/acme/widget/issues/comments/9001",
    "octokit.rest.issues.deleteComment({ owner: 'acme', repo: 'widget', comment_id: 9001 })",
    "IssueComment.delete()",
    // Natural forms an agent types without trying to evade the guard: the short body flag and
    // the repo-recommended same-command heredoc that writes the body file and posts it.
    `gh pr comment 2879 -b '${approvalMarker}'`,
    `cat > /tmp/approve.md <<'EOF'\n${approvalMarker}\nEOF\ngh pr comment 2879 --body-file /tmp/approve.md`,
    // Repo-qualified forms: a worktree session often names the repository explicitly, and gh accepts the
    // repo flag between the command words, so the guard must still recognize the comment write.
    `gh -R acme/widget pr comment 2879 --body '${approvalMarker}'`,
    `gh pr -R acme/widget comment 2879 --body '${approvalMarker}'`,
    `gh --repo acme/widget pr comment 2879 -b '${approvalMarker}'`,
    `cat > /tmp/approve.md <<'EOF'\n${approvalMarker}\nEOF\ngh -R acme/widget pr comment 2879 --body-file /tmp/approve.md`,
    `gh -Racme/widget issue comment 2879 --body '${approvalMarker}'`,
    "gh -R acme/widget pr comment 2879 --delete-last --yes",
    "gh pr -R acme/widget comment 2879 --delete-last",
    "gh -R acme/widget issue comment 2879 --delete-last",
    "gh -R acme/widget pr comment 2879 --edit-last --body ordinary-reviewer-text",
    "gh pr -R acme/widget comment 2879 --edit-last --body ordinary-reviewer-text",
  ];
  for (const command of blocked) {
    const result = run({
      tool_name: "Bash",
      tool_input: { command, cwd: repo },
    }, { cwd: repo });
    assert.equal(result.json?.decision, "block", command);
    assert.match(result.json.reason, /Lineage Approval Write Guard/, command);
  }

  for (const command of [
    "gh api repos/acme/widget/issues/2879/comments -f body=LGTM",
    "gh api graphql -f query='mutation($body:String!){addComment(input:{body:$body})}' -f body=ordinary",
    "gh api graphql -f query='mutation($body:String!){addComment(input:{body:$body})}' -f 'body=ordinary'",
    "gh api repos/acme/widget/issues/2879/comments --field body='ordinary reviewer text'",
    "gh -R acme/widget pr comment 2879 --body 'ordinary reviewer text'",
    "gh pr -R acme/widget comment 2879 -b LGTM",
    "gh --repo acme/widget issue comment 2879 --body 'ordinary reviewer text'",
  ]) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => { throw new Error("literal field value must not be treated as a file path"); },
    });
    assert.equal(result, null, "ordinary literal REST comment body remains allowed");
  }

  for (const command of [
    "gh api graphql -f query='query($o:String!,$n:Int!){repository(owner:$o,name:\"widget\"){pullRequest(number:$n){id}}}' -F o=acme -F n=2879",
    "gh api graphql --paginate -f query='query($endCursor:String){viewer{login}}' -F endCursor=abc",
    // The word "mutation" outside the GraphQL operation (a variable value, or text inside a string
    // literal of a read-only query) does not make the operation a mutation.
    "gh api graphql -f query='query($q:String!){search(query:$q,type:ISSUE,first:5){issueCount}}' -f q=mutation",
    "gh api graphql -f query='query($q:String!){search(query:$q,type:ISSUE,first:5){issueCount}}' -f q='mutation is:issue'",
    "gh api graphql -f query='query{search(query:\"mutation\",type:ISSUE,first:1){issueCount}}'",
    "gh api graphql -f query='query{search(query:\"mutation\",type:ISSUE,first:1){issueCount}}' -F n=2879",
  ]) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => { throw new Error("an inline read-only query declares no body file"); },
    });
    assert.equal(result, null, `read-only GraphQL with variables writes nothing and must not be refused: ${command}`);
  }
  // The strict-variable and dynamic-body rules certify the body of a top-level issue or PR comment.
  // A mutation outside that carrier (Session Recap Discussion, review-thread resolve, or review-thread
  // reply, which creates a review comment) carries ordinary variables and must not be refused, or the
  // mandatory Recap and review-thread steps cannot run.
  for (const command of [
    "gh api graphql -F repoId=R_x -F categoryId=DIC_x -F title=T -F body=@/tmp/recap.md -f query='mutation($repoId:ID!,$categoryId:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repoId,categoryId:$categoryId,title:$title,body:$body}){discussion{url}}}'",
    "gh api graphql -F id=PRRT_x -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}'",
    "gh api graphql -F id=PRRT_x -F body=@/tmp/reply.md -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}'",
    "gh api graphql -F repoId=R_x -F categoryId=DIC_x -F title=T -F body=\"$(cat /tmp/recap.md)\" -f query='mutation($repoId:ID!,$categoryId:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repoId,categoryId:$categoryId,title:$title,body:$body}){discussion{url}}}'",
  ]) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => "ordinary recap or reply text",
    });
    assert.equal(result, null, `a GraphQL mutation outside the issue or PR comment carrier must not be refused: ${command}`);
  }
  // The same holds for a body source the guard cannot read: a stdin body or an unreadable body path on a
  // mutation outside the comment carrier has no comment body to certify.
  for (const command of [
    "gh api graphql -F repoId=R_x -F categoryId=DIC_x -F title=T -F body=@- -f query='mutation($repoId:ID!,$categoryId:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repoId,categoryId:$categoryId,title:$title,body:$body}){discussion{url}}}'",
    "gh api graphql -F repoId=R_x -F categoryId=DIC_x -F title=T -F body=@/nonexistent/recap.md -f query='mutation($repoId:ID!,$categoryId:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repoId,categoryId:$categoryId,title:$title,body:$body}){discussion{url}}}'",
  ]) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => { throw new Error("body source is not readable"); },
    });
    assert.equal(result, null, `an unreadable or stdin body on a non-comment mutation must not be refused: ${command}`);
  }
  // A comment-creating mutation keeps the strict rules even when a non-comment mutation sits beside it.
  for (const command of [
    "gh api graphql -F id=PR_x -F body=ordinary -f query='mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){clientMutationId}}'",
    "gh api graphql -F id=PR_x -f b=ordinary -f query='mutation($id:ID!,$b:String!){a:resolveReviewThread(input:{threadId:$id}){thread{id}} c:addComment(input:{subjectId:$id,body:$b}){clientMutationId}}'",
  ]) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => "ordinary text",
    });
    assert.equal(result?.block, true, `a comment-creating GraphQL mutation keeps the strict variable rule: ${command}`);
  }
  assert.equal(
    checkPostPrLineageApprovalCommentWriteGuard("gh api graphql -F query=@/tmp/readonly.graphql -F o=acme", {
      readFileSync: () => "query($o:String!){repository(owner:$o,name:\"widget\"){id}}",
    }),
    null,
    "a read-only query file without the approval marker is not a comment write"
  );
  assert.equal(
    checkPostPrLineageApprovalCommentWriteGuard("gh api graphql -F query=@missing.graphql -F o=acme", {
      readFileSync: () => { throw new Error("ENOENT"); },
    }),
    null,
    "an unreadable read-only query file is not a declared comment body source"
  );

  const shellExpandedGraphql = "gh api graphql -f query='mutation($b:String!){addComment(input:{subjectId:\"…\",body:$b}){clientMutationId}}' -f b=\"$(printf '\\074!-- devpro-post-pr-lineage-approval --\\076')\"";
  const shellExpandedGraphqlHook = runSpawn({
    tool_name: "Bash",
    tool_input: { command: shellExpandedGraphql, cwd: repo },
  }, { cwd: repo });
  assert.equal(shellExpandedGraphqlHook.json?.decision, "block");
  assert.match(shellExpandedGraphqlHook.json.reason, /Lineage Approval Write Guard/);

  const stdinGhApiHook = runSpawn({
    tool_name: "Bash",
    tool_input: { command: "gh api repos/acme/widget/issues/2879/comments --input -", cwd: repo },
  }, { cwd: repo });
  assert.equal(stdinGhApiHook.json?.decision, "block", "the complete hook rejects stdin-backed gh api comment bodies");
  assert.match(stdinGhApiHook.json.reason, /Lineage Approval Write Guard/);

  const stdinBodyCommands = [
    "printf '\\074!-- devpro-post-pr-lineage-approval --\\076' | curl -X POST --data-binary @/dev/stdin https://api.github.com/repos/acme/widget/issues/2879/comments",
    "printf '\\074!-- devpro-post-pr-lineage-approval --\\076' | curl -X POST --data-binary \\\n  @/dev/stdin https://api.github.com/repos/acme/widget/issues/2879/comments",
    "printf '\\074!-- devpro-post-pr-lineage-approval --\\076' | curl -X POST --data-binary @/dev/fd/0 https://api.github.com/repos/acme/widget/issues/2879/comments",
    "printf '\\074!-- devpro-post-pr-lineage-approval --\\076' | curl -X POST --data-binary @/proc/self/fd/0 https://api.github.com/repos/acme/widget/issues/2879/comments",
    "printf '\\074!-- devpro-post-pr-lineage-approval --\\076' | curl --request POST --json @/dev/stdin https://api.github.com/repos/acme/widget/issues/2879/comments",
    "printf '\\074!-- devpro-post-pr-lineage-approval --\\076' | curl -X POST --data-binary @<(printf '\\074!-- devpro-post-pr-lineage-approval --\\076') https://api.github.com/repos/acme/widget/issues/2879/comments",
  ];
  for (const command of stdinBodyCommands) {
    const result = checkPostPrLineageApprovalCommentWriteGuard(command, { readFileSync: () => "" });
    assert.equal(result?.block, true, `empty/uninspectable curl body source must fail closed: ${command}`);
    assert.match(result.reason, /Lineage Approval Write Guard/, command);
  }
  const stdinHookResult = runSpawn({
    tool_name: "Bash",
    tool_input: { command: stdinBodyCommands[0], cwd: repo },
  }, { cwd: repo });
  assert.equal(stdinHookResult.json?.decision, "block", "the complete hook must also reject a stdin-backed approval body");
  assert.match(stdinHookResult.json.reason, /Lineage Approval Write Guard/);

  const approvalVariables = path.join(tmpRoot, "lineage-approval-variables.json");
  writeFileSync(approvalVariables, JSON.stringify({ input: { body: approvalMarker } }));
  const fileVariables = run({
    tool_name: "Bash",
    tool_input: { command: `gh api graphql --input '${approvalVariables}'`, cwd: repo },
  }, { cwd: repo });
  assert.equal(fileVariables.json?.decision, "block", "file-backed GraphQL variables are inspected");

  const escapedVariables = path.join(tmpRoot, "lineage-approval-escaped-variables.json");
  writeFileSync(escapedVariables, JSON.stringify({ input: { body: "\\u003c!-- devpro-post-pr-lineage-approval --\\u003e" } }));
  const escapedFileVariables = run({
    tool_name: "Bash",
    tool_input: { command: `gh api graphql --input '${escapedVariables}'`, cwd: repo },
  }, { cwd: repo });
  assert.equal(escapedFileVariables.json?.decision, "block", "escaped file-backed JSON variables are normalized before marker checks");

  const graphqlBody = path.join(tmpRoot, "lineage-approval-graphql-body.json");
  writeFileSync(graphqlBody, JSON.stringify({ query: `query { wrapper(value: "${approvalMarker}") }` }));
  const fileGraphqlBody = run({
    tool_name: "Bash",
    tool_input: { command: `gh api graphql --input '${graphqlBody}'`, cwd: repo },
  }, { cwd: repo });
  assert.equal(fileGraphqlBody.json?.decision, "block", "file-backed GraphQL request bodies are inspected");

  const graphqlQueryFile = path.join(tmpRoot, "lineage-approval-graphql-query.graphql");
  writeFileSync(graphqlQueryFile, `mutation { addComment(input:{body:"${approvalMarker}"}) { clientMutationId } }`);
  const fileGraphqlQuery = run({
    tool_name: "Bash",
    tool_input: { command: `gh api graphql -F query=@'${graphqlQueryFile}'`, cwd: repo },
  }, { cwd: repo });
  assert.equal(fileGraphqlQuery.json?.decision, "block", "file-backed GraphQL query sources are inspected");

  const restBody = path.join(tmpRoot, "lineage-approval-body.md");
  writeFileSync(restBody, approvalMarker);
  const fileRestBody = run({
    tool_name: "Bash",
    tool_input: { command: `gh api repos/acme/widget/issues/2879/comments -F body=@'${restBody}'`, cwd: repo },
  }, { cwd: repo });
  assert.equal(fileRestBody.json?.decision, "block", "file-backed REST comment bodies are inspected");

  const dynamicRouteCommands = [
    `gh api repos/acme/widget/issues/$PR/comments -F body='${approvalMarker}'`,
    `gh api repos/acme/widget/issues/\${PR}/comments -F body='${approvalMarker}'`,
    `gh api repos/acme/widget/issues/$(printf '%s' 2879)/comments -F body='${approvalMarker}'`,
    `curl -X POST --data 'body=${approvalMarker}' https://api.github.com/repositories/123/issues/2879/comments`,
  ];
  for (const command of dynamicRouteCommands) {
    const markerBody = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => approvalMarker,
    });
    assert.equal(markerBody?.block, true, `approval marker must block for dynamic REST route: ${command}`);
    assert.match(markerBody.reason, /Lineage Approval Write Guard/, command);
  }

  const unreadableBodyCommands = [
    `gh api repos/acme/widget/issues/$PR/comments -F body=@/missing/approval.json`,
    `gh api repos/acme/widget/issues/\${PR}/comments -F body=@/missing/approval.json`,
    `gh api repos/acme/widget/issues/$(printf '%s' 2879)/comments -F body=@/missing/approval.json`,
    "curl -X POST --data-binary @/missing/approval.json https://api.github.com/repositories/123/issues/2879/comments",
  ];
  for (const command of unreadableBodyCommands) {
    const unreadableBody = checkPostPrLineageApprovalCommentWriteGuard(command, {
      readFileSync: () => { throw new Error("body file is unreadable"); },
    });
    assert.equal(unreadableBody?.block, true, `unreadable body must block for dynamic REST route: ${command}`);
    assert.match(unreadableBody.reason, /Lineage Approval Write Guard/, command);
  }

  const curlBody = path.join(tmpRoot, "lineage-approval-curl-body.json");
  writeFileSync(curlBody, JSON.stringify({ body: approvalMarker }));
  const curlFileBody = run({
    tool_name: "Bash",
    tool_input: { command: `curl -X POST --data-binary @'${curlBody}' https://api.github.com/repos/acme/widget/issues/2879/comments`, cwd: repo },
  }, { cwd: repo });
  assert.equal(curlFileBody.json?.decision, "block", "curl file-backed create requests cannot carry lineage approval comments");

  const curlJsonFileBody = run({
    tool_name: "Bash",
    tool_input: { command: `curl --request POST --json @${curlBody} https://api.github.com/repos/acme/widget/issues/2879/comments`, cwd: repo },
  }, { cwd: repo });
  assert.equal(curlJsonFileBody.json?.decision, "block", "curl --json file-backed create requests cannot carry lineage approval comments");

  const ordinaryBody = path.join(tmpRoot, "ordinary-reviewer-sticky.md");
  writeFileSync(ordinaryBody, "<!-- devpro-second-review-sticky -->\nverdict: WARN\n");
  const allowedSticky = run({
    tool_name: "Bash",
    tool_input: { command: `gh pr comment 2879 --body-file '${ordinaryBody}'`, cwd: repo },
  }, { cwd: repo });
  assert.notEqual(allowedSticky.json?.decision, "block", "ordinary designated sticky body remains allowed");
});

test("cross-model merge gate blocks while a durable clear obligation remains", () => {
  const repo = setupRepo("feature/lineage-obligation-merge");
  // The merge writes its repository in full, and the cross-repo merge gate compares it with this origin.
  spawnSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });
  const stateDir = path.join(tmpRoot, "merge-clear-obligation-state");
  mkdirSync(stateDir, { recursive: true });
  const marker = {
    prNumber: "1658",
    branch: "feature/lineage-obligation-merge",
    headRefName: "feature/lineage-obligation-merge",
    // The merged PR’s repository: only its own obligation stops the merge (fix-post-pr-state-repo-keys).
    repository_slug: "owner/repo",
    head_ref_oid: "a".repeat(40),
    lineage_clear_obligation: {
      schema: "devpro-post-pr-clear-obligation/v1",
      obligation_id: "obligation-1658-1",
      repository_slug: "owner/repo",
      pr_number: "1658",
      obligation_head_ref_oid: "a".repeat(40),
      current_dispatch_id: "dispatch-55555555-5555-4555-8555-555555555555",
      old_dispatch_id: "dispatch-66666666-6666-4666-8666-666666666666",
      approval_receipt_ids: ["9010"],
      first_dispatch_id: "dispatch-55555555-5555-4555-8555-555555555555",
      created_at: "2026-09-28T00:20:00.000Z",
      attempt_history: [],
    },
  };
  writeFileSync(path.join(stateDir, "pending-post-pr-completion-1658.json"), JSON.stringify(marker));
  const merge = run({
    tool_name: "Bash",
    tool_input: { command: "gh pr merge 1658 --repo github.com/owner/repo", cwd: repo },
  }, { cwd: repo, env: { DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir } });
  assert.equal(merge.json?.decision, "block");
  assert.match(merge.json.reason, /durable clear obligation obligation-1658-1/);
  assert.match(merge.json.reason, /Ask First/);
});

// fix-post-pr-state-repo-keys: from a hub checkout, every way of naming another repository's PR finds that
// repository's obligation (the --repo flag, a PR URL, GH_REPO), and the hub's own PR of the same number does not.
test("cross-model merge gate reads the merged PR's repository for local obligations, however the command names it", () => {
  const repo = setupRepo("feature/hub-merge-obligation");
  spawnSync("git", ["remote", "add", "origin", "https://github.com/owner/hub.git"], { cwd: repo });
  const stateDir = path.join(tmpRoot, "merge-obligation-other-repo-state");
  mkdirSync(stateDir, { recursive: true });
  const marker = {
    prNumber: "1659",
    branch: "feature/other-repo-work",
    headRefName: "feature/other-repo-work",
    repository_slug: "owner/other",
    head_ref_oid: "b".repeat(40),
    lineage_clear_obligation: {
      schema: "devpro-post-pr-clear-obligation/v1",
      obligation_id: "obligation-1659-1",
      repository_slug: "owner/other",
      pr_number: "1659",
      obligation_head_ref_oid: "b".repeat(40),
      current_dispatch_id: "dispatch-77777777-7777-4777-8777-777777777777",
      old_dispatch_id: "dispatch-88888888-8888-4888-8888-888888888888",
      approval_receipt_ids: ["9011"],
      first_dispatch_id: "dispatch-77777777-7777-4777-8777-777777777777",
      created_at: "2026-09-28T00:20:00.000Z",
      attempt_history: [],
    },
  };
  // A marker named by the PR number alone, as the writer names it; its content names its repository.
  writeFileSync(path.join(stateDir, "pending-post-pr-completion-1659.json"), JSON.stringify(marker));
  const other = setupRepo("feature/other-repo-work");
  spawnSync("git", ["remote", "add", "origin", "https://github.com/owner/other.git"], { cwd: other });
  const approved = `DEVPRO_CROSS_REPO_PR=github.com/owner/other DEVPRO_PR_CHECKOUT='${other}'`;
  const merge = (command, env = {}) => run({
    tool_name: "Bash",
    tool_input: { command, cwd: repo },
  }, { cwd: repo, env: { DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir, ...env } });
  for (const [label, command, env] of [
    ["--repo", `${approved} gh pr merge 1659 --repo github.com/owner/other`, {}],
    ["PR URL", `${approved} gh pr merge https://github.com/owner/other/pull/1659`, {}],
  ]) {
    const result = merge(command, env);
    assert.equal(result.json?.decision, "block", `${label}: ${JSON.stringify(result.json)}`);
    assert.match(result.json.reason, /durable clear obligation obligation-1659-1/, label);
  }
  // A GH_REPO= prefix, or an approved merge that leaves the target to GH_REPO, is refused before any obligation is read.
  // Each is refused for how it names the repository, never by the obligation it would have found.
  for (const [label, result, reason] of [
    ["GH_REPO prefix", merge(`${approved} GH_REPO=owner/other gh pr merge 1659`), /GH_REPO= changes what gh reads/],
    ["GH_REPO environment", merge(`${approved} gh pr merge 1659`, { GH_REPO: "owner/other" }), /write the repository of gh pr merge in full/],
  ]) {
    assert.equal(result.json?.decision, "block", label);
    assert.match(result.json.reason, reason, label);
    assert.doesNotMatch(result.json.reason, /obligation-1659-1/, label);
  }
  // A merge that leaves its repository to gh is refused too, so no merge falls back to this checkout's repository.
  assert.match(merge("gh pr merge 1659", { GH_REPO: "owner/other" }).json?.reason || "", /write the repository of gh pr merge in full/);
  // The hub's own PR #1659 passes the obligation check and reaches the review check that follows it.
  const own = merge("gh pr merge 1659 --repo github.com/owner/hub");
  assert.doesNotMatch(own.json?.reason || "", /obligation-1659-1/, "the hub's own PR #1659 is not held by another repository's obligation");
  assert.match(own.json?.reason || "", /Path B/, "the own-repository merge got past the local obligation check");
});
