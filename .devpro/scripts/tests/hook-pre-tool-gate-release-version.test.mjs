import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
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
import {
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  cpSync,
  symlinkSync,
  renameSync,
  openSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
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
  checkLocalTestGateOnMerge,
} from "../hooks/pre-tool-gate.mjs";
import { defaultRepoStateDir } from "../hooks/lib/repo-state-identity.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";
import {
  writeRegressionHeadRecord as writeLocalTestReceipt,
  regressionHeadRecordPath,
} from "../lib/regression-head-record.mjs";
import {
  buildFinalEvidencePayload,
  buildFinalEvidenceRecordFixture,
  buildManifestHeavyRecordFixture,
  writeFinalEvidenceRecordFixture,
} from "./lib/final-evidence-record-fixture.mjs";
import {
  FINAL_EVIDENCE_VERDICT_SCHEMA,
  FINAL_EVIDENCE_VERIFIER_BUDGET,
} from "../hooks/lib/final-evidence-merge-verifier.mjs";
import { markConsumerCheckout, markSourceCheckout, unmarkSourceCheckout } from "./lib/identity-fixtures.mjs";
import { destinationIdentity } from "../hooks/lib/operation-target.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("pre-tool-gate-test-");
const COMMIT_WITH_ATTRIBUTION =
  'git commit -m "subject" -m "Rules: v6.29.10 · Tool: test · Model: gpt-test"';

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

// In-process run() tests that drive a successful merge write markers to the REAL
// default state dirs: postmergeDir() reads process.env per-call (redirectable),
// but recap-pending resolves from a MODULE-LOAD-TIME constant (RECAP_PENDING_DIR
// in recap-utils.mjs) that in-process env override CANNOT redirect. Snapshot
// both default dirs and remove only files added during this file's run (see
// openspec test-governance: "Hook Subprocess Tests Isolate Persistent State
// Marker Directories"). Restored in the file-level after() below.
const defaultPostmergeMarkerDir = defaultRepoStateDir("devpro-postmerge-state", process.cwd());
const defaultPostmergeMarkerSnapshot = snapshotDirFiles(defaultPostmergeMarkerDir);
const defaultRecapPendingDir = defaultRepoStateDir("devpro-recap-pending", process.cwd());
const defaultRecapPendingSnapshot = snapshotDirFiles(defaultRecapPendingDir);

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
  markSourceCheckout(dir);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "");
  writePreflightFixture(dir);
  markSourceCheckout(dir);
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
    markSourceCheckout(dir);
  }
  rememberBranch(dir, branchName);
  return dir;
}

function setupRepoWithProductionTag(tagName = "production-2026-04-01") {
  const dir = path.join(tmpRoot, `repo-prodtag-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  markSourceCheckout(dir);
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
  markSourceCheckout(dir);
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
  markSourceCheckout(wt);
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
        body: "",
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
        body: "",
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

// PAT smoke regression (per Q9 / F-Con-2)
// Branch names sampled from openspec/changes/archive/ slug suffixes should not
// hit any remaining PreToolUse branch-name hygiene parser.
// ─────────────────────────────────────────────────────────────────────────

test("PAT smoke regression: archived feature branches pass without Gate 11 parser", () => {
  // Representative archived branch names from openspec/changes/archive/.
  // Each slug maps to: feature/<slug-after-date> per git-branch-naming-and-anchor.md.
  const archivedBranches = [
    "feature/add-agent-communication-protocol",       // 2026-04-17
    "feature/fix-agent-io-contract-gaps",             // 2026-04-17
    "feature/add-tl-delegation-guardrails",           // 2026-04-21
    "feature/add-anchor-divergence-precheck",            // N2-compliant replacement (#957)
    "feature/strengthen-chore-a-self-alignment-grep", // 2026-05-08
    "bugfix/fix-archive-gate-promote-scope",             // N2-compliant replacement (#966)
    "bugfix/enforce-bump-version-branch-equality",       // N2-compliant replacement (#968)
    "feature/clarify-recap-issue-source-repo-routing", // 2026-05-06
  ];

  const mainRepo = setupRepo("main");
  for (const branch of archivedBranches) {
    const r = run(
      {
        tool_name: "Bash",
        tool_input: { command: `git checkout -b ${branch}` },
      },
      { cwd: mainRepo }
    );
    assert.equal(
      r.json?.decision,
      undefined,
      `archived branch ${branch} should pass without Gate 11 parser; got: ${JSON.stringify(r.json)}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2b: heredoc race regression (prove-it T1)
// ─────────────────────────────────────────────────────────────────────────

const heredocTmpDir = makeTempDir("preflight-");

after(() => {
  try {
    rmSync(heredocTmpDir, { recursive: true, force: true });
  } catch {}
});

const GOOD_FOOTER = "Rules: v6.39.2 · Tool: Claude Code · Model: claude-opus-4-7[1m]";

test("Gate2b heredoc race: race-pass", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.39.2\n");
  const msgFile = path.join(heredocTmpDir, "msg-race-pass.txt");
  const cmd = [
    `cat > ${msgFile} <<'EOF'`,
    "subject",
    "",
    GOOD_FOOTER,
    "EOF",
    `git commit -F ${msgFile}`,
  ].join("\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(
    r.json,
    null,
    `現行 hook fail-closed：期望 pass (null) 但得到 ${JSON.stringify(r.json)}`
  );
});

test("Gate2b heredoc race: reverse-order-fail", () => {
  const repo = setupRepo("feature/foo");
  const msgFile = path.join(heredocTmpDir, "msg-reverse-order.txt");
  const cmd = [
    `git commit -F ${msgFile}`,
    `cat > ${msgFile} <<'EOF'`,
    "subject",
    "",
    GOOD_FOOTER,
    "EOF",
  ].join("\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /read failed/);
});

test("Gate2b heredoc race: map-miss-fall-back", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.39.2\n");
  const msgFile = path.join(heredocTmpDir, "msg-map-miss.txt");
  writeFileSync(msgFile, `subject\n\n${GOOD_FOOTER}\n`);
  const cmd = `git commit -F ${msgFile}`;
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(r.json, null);
});

test("Gate2b heredoc race: map-hit-footer-fail → advisory", () => {
  const repo = setupRepo("feature/foo");
  const msgFile = path.join(heredocTmpDir, "msg-no-footer.txt");
  const cmd = [
    `cat > ${msgFile} <<'EOF'`,
    "subject",
    "",
    "body without footer",
    "EOF",
    `git commit -F ${msgFile}`,
  ].join("\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block");
  assert.match(
    advisoryText(r.json),
    /Rules: footer|完全不含 Rules/,
    `期望走到 footer advisory 但實際輸出不對。got: ${advisoryText(r.json)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2b: extractFlagValues heredoc-body substring FP (prove-it T12)
// ─────────────────────────────────────────────────────────────────────────

test("Gate2b extractFlagValues: heredoc body with -F substring not parsed as flag", () => {
  // Reproduce bug: extractFlagValues runs regex on raw cmd without segment
  // filtering. When heredoc body contains literal "-F somefile" text, the
  // regex matches it as a -F flag, causing statSync("somefile") to throw →
  // readFailed → fail-closed block even though the commit message is valid.
  //
  // Before T13 fix: this test FAILS (block with "read failed" reason).
  // After T13 fix:  this test PASSES (no block, valid heredoc footer passes).
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "版本：6.39.2\n");
  const cmd = [
    "git commit -m \"$(cat <<'EOF'",
    "fix(thing): add support for -F somefile in foo",
    "",
    "When the user passes -F somefile we used to choke. Now we don't.",
    "",
    GOOD_FOOTER,
    "EOF",
    ')\"',
  ].join("\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: cmd } },
    { cwd: repo }
  );
  assert.equal(
    r.json,
    null,
    `expected no block decision; got: ${JSON.stringify(r.json)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// T1: prove-it — commit footer version-equality (release-integrity block)
// ─────────────────────────────────────────────────────────────────────────

// Template cache for setupRepoWithAgentsMd(), keyed by (branchName,
// agentsVersion). Every call site below only reads AGENTS.md/branch/commit
// state via run()'s in-process evaluatePreToolUsePayload() (never mutates
// the repo), and the git -C worktree-regression test builds its own
// worktree off a *copy* returned by this helper — so sharing the base
// template via cpSync is safe.
const agentsMdTemplateByKey = new Map();

function createAgentsMdTemplate(branchName, agentsVersion) {
  const key = `${branchName} ${agentsVersion}`;
  if (agentsMdTemplateByKey.has(key)) return agentsMdTemplateByKey.get(key);

  const dir = path.join(tmpRoot, `template-agentsmd-${agentsMdTemplateByKey.size}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  markSourceCheckout(dir);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "");
  writeFileSync(path.join(dir, "AGENTS.md"), `# AI Agent\n\n版本：${agentsVersion}\n`);
  writePreflightFixture(dir);
  spawnSync("git", ["add", "x", "AGENTS.md"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  markSourceCheckout(dir);
  agentsMdTemplateByKey.set(key, dir);
  return dir;
}

// Helper: create a repo that also has AGENTS.md with a given version
function setupRepoWithAgentsMd(branchName, agentsVersion = "6.62.0") {
  const template = createAgentsMdTemplate(branchName, agentsVersion);
  const dir = path.join(tmpRoot, `repo-agentsmd-${repoCounter++}`);
  cpSync(template, dir, { recursive: true });
  return dir;
}

// T1(b)-prove-it: commit footer version mismatch → BLOCK (release-integrity)
// footer says v6.99.0, AGENTS.md says 6.62.0 → must block
test("T1(b)-prove-it: commit footer Rules: v6.99.0 vs AGENTS.md 6.62.0 → block (release-integrity)", () => {
  const repo = setupRepoWithAgentsMd("feature/foo", "6.62.0");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject\n\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"',
      },
    },
    { cwd: repo }
  );
  // Currently fails (no version check) → prove-it red case
  assert.equal(r.json?.decision, "block", "commit footer version mismatch MUST block");
  assert.match(r.json?.reason || "", /release-integrity/i, "reason must mention release-integrity");
});

// T1(b)-regression: commit footer version MATCH → pass (not blocked)
test("T1(b)-regression: commit footer Rules: v6.62.0 vs AGENTS.md 6.62.0 → pass (match)", () => {
  const repo = setupRepoWithAgentsMd("feature/foo", "6.62.0");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet"',
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json, null, `commit footer version match MUST pass; got: ${JSON.stringify(r.json)}`);
});

test("T1(b)-worktree-regression: git -C worktree commit -F relative file uses worktree AGENTS.md → pass", () => {
  const repo = setupRepoWithAgentsMd("main", "6.62.0");
  const wt = path.join(tmpRoot, `repo-agentsmd-wt-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "-b", "chore/bump-v6.63.0", wt, "HEAD"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(path.join(wt, "AGENTS.md"), "# AI Agent\n\n版本：6.63.0\n");
  writeFileSync(
    path.join(wt, "commit-msg.txt"),
    "chore: bump rules\n\nRules: v6.63.0 · Tool: codex · Model: gpt-5"
  );

  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git -C ${wt} commit -F commit-msg.txt`,
      },
    },
    { cwd: repo }
  );

  assert.equal(
    r.json,
    null,
    `git -C commit MUST read relative -F and AGENTS.md from target worktree; got: ${JSON.stringify(r.json)}`
  );
});

// T1(c)-regression-guard: commit footer PRESENCE MISSING → advisory (NOT block)
// This guards L959 invariant: presence/format absence = normative-debt advisory, not block
test("T1(c)-regression-guard: commit footer missing → advisory (NOT block, L959 invariant)", () => {
  const repo = setupRepoWithAgentsMd("feature/foo", "6.62.0");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject line without any attribution footer"',
      },
    },
    { cwd: repo }
  );
  // Must NOT be block — must be advisory or null
  assert.notEqual(r.json?.decision, "block", "commit footer MISSING must be advisory, not block (L959)");
  assert.match(advisoryText(r.json), /Commit attribution gate/, "must emit advisory about missing footer");
});

// T1-regression-guard: forbidden-attribution → still block (brand-leak gate unchanged)
test("T1-regression-guard: forbidden attribution brand marker → block (brand-leak unchanged)", () => {
  const repo = setupRepoWithAgentsMd("feature/foo", "6.62.0");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject\n\n🤖 Generated with [Claude Code]\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet"',
      },
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", "forbidden attribution brand marker MUST still block");
  assert.match(r.json?.reason || "", /brand marker|attribution gate/i);
});

// T1-fail-open: AGENTS.md missing in repo → commit NOT blocked on version layer
test("T1-fail-open: AGENTS.md missing → commit not blocked on version layer", () => {
  // setupRepo creates no AGENTS.md
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject\n\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"',
      },
    },
    { cwd: repo }
  );
  // No AGENTS.md → version layer fails open → no block. fix-eof-gate-cwd-blind-spot
  // T11 (design.md D5) now surfaces this exact shape as a `version-layer-skipped`
  // advisory instead of total silence — block status is unaffected (still the
  // thing this test's name asserts), so the assertion is loosened from "no
  // advisory at all" to "not blocked" rather than defeating the fixture's own
  // deliberately-missing-AGENTS.md premise by adding one.
  assert.notEqual(r.json?.decision, "block", `AGENTS.md missing MUST fail-open (no block); got: ${JSON.stringify(r.json)}`);
});

// T1-fail-open: AGENTS.md has no version line → commit NOT blocked on version layer
test("T1-fail-open: AGENTS.md unparseable version → commit not blocked on version layer", () => {
  const repo = setupRepo("feature/foo");
  writeFileSync(path.join(repo, "AGENTS.md"), "no version line here\n");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject\n\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"',
      },
    },
    { cwd: repo }
  );
  // fix-eof-gate-cwd-blind-spot T11 (design.md D5): an unparseable AGENTS.md
  // also can't yield an equality result, so this now surfaces
  // `version-layer-skipped` instead of total silence — cannot give this
  // fixture a matching AGENTS.md without destroying the very "unparseable"
  // shape it exists to test, so only the block-status assertion is kept.
  assert.notEqual(r.json?.decision, "block", `unparseable AGENTS.md MUST fail-open (no block); got: ${JSON.stringify(r.json)}`);
});

// fix-eof-gate-cwd-blind-spot T11 prove-it (design.md D5): a footer that
// DECLARES a version, but whose equality check could not run (AGENTS.md
// missing here), must surface `version-layer-skipped` — a declared release
// version that was never actually verified is release-integrity data going
// into commit metadata unchecked (still fail-open: MUST NOT block).
test("T11 prove-it: version-layer-skipped advisory when footer declares a version but AGENTS.md is missing", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git commit -m "subject\n\nRules: v6.99.0 · Tool: claude-code · Model: claude-sonnet"',
      },
    },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `version-layer-skipped MUST fail-open (no block); got: ${JSON.stringify(r.json)}`);
  assert.match(advisoryText(r.json), /version-layer-skipped/);
});

// ─────────────────────────────────────────────────────────────────────────
// T1: prove-it — git tag production-* shape + version equality gate
// ─────────────────────────────────────────────────────────────────────────

// Template cache for setupRepoWithAgentsMdAndTag(), keyed by every param that
// affects the resulting commit/tag state. All current call sites in this file
// pass tagName=null (the tag string only appears inside the *simulated*
// command evaluated by run(), which is in-process/read-only against the repo
// — it never actually creates the tag), so nearly every call collapses onto
// just 3 distinct (agentsVersion, tagName, annotated) keys. Building the
// git init + commit sequence (5-6 real git spawns) once per distinct key and
// reusing it via cpSync (a single fast recursive copy) for every subsequent
// call removes the dominant per-call cost without changing any test's
// observed repo state.
const agentsMdTagTemplateByKey = new Map();

function createAgentsMdTagTemplate(agentsVersion, tagName, annotated) {
  const key = `${agentsVersion} ${tagName} ${annotated}`;
  if (agentsMdTagTemplateByKey.has(key)) return agentsMdTagTemplateByKey.get(key);

  const dir = path.join(tmpRoot, `template-taggate-${agentsMdTagTemplateByKey.size}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  markSourceCheckout(dir);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "");
  if (agentsVersion !== null) {
    writeFileSync(path.join(dir, "AGENTS.md"), `# AI Agent\n\n版本：${agentsVersion}\n`);
    spawnSync("git", ["add", "x", "AGENTS.md"], { cwd: dir });
  } else {
    spawnSync("git", ["add", "x"], { cwd: dir });
  }
  writePreflightFixture(dir);
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  if (tagName) {
    if (annotated) {
      spawnSync("git", ["tag", "-a", tagName, "-m", "annotated tag"], { cwd: dir });
    } else {
      spawnSync("git", ["tag", tagName], { cwd: dir });
    }
  }
  agentsMdTagTemplateByKey.set(key, dir);
  return dir;
}

// Helper: create a repo with AGENTS.md and optionally a git tag
function setupRepoWithAgentsMdAndTag(agentsVersion, tagName, { annotated = false } = {}) {
  const template = createAgentsMdTagTemplate(agentsVersion, tagName, annotated);
  const dir = path.join(tmpRoot, `repo-taggate-${repoCounter++}`);
  cpSync(template, dir, { recursive: true });
  return dir;
}

// T1-N1-prove-it: malformed production-v6.39 (missing patch) → block
test("T1-N1-prove-it: git tag production-v6.39 (missing patch) → block (N1 shape)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-v6.39" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `malformed production-v6.39 MUST block; got: ${JSON.stringify(r.json)}`);
  // reason must list the three valid shapes (template or example form)
  const reason = r.json?.reason || "";
  assert.match(reason, /production-v.*MAJOR|production-v\d+\.\d+\.\d+|production-.*YYYYMMDD/i, "reason must mention valid shapes");
});

// T1-N1-prove-it: prodtypo-x starts with production- prefix but malformed → block
// Note: "prodtypo-x" does NOT start with "production-" so it is NOT intercepted by gate
// Use "production-xyz" which starts with production- but matches no valid shape
test("T1-N1-prove-it: git tag production-xyz (invalid shape) → block (N1 shape)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-xyz" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `malformed production-xyz MUST block; got: ${JSON.stringify(r.json)}`);
  const reason = r.json?.reason || "";
  assert.match(reason, /production-v.*MAJOR|production-v\d+\.\d+\.\d+|production-.*YYYYMMDD/i, "reason must mention valid shapes");
});

// T1-N1-prove-it: production-2026 (date too short, only 4 digits) → block
test("T1-N1-prove-it: git tag production-2026 (too-short date) → block (N1 shape)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-2026" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `malformed production-2026 MUST block; got: ${JSON.stringify(r.json)}`);
});

// T1-N1-accept: production-v6.62.0 (valid semver) → NOT blocked by shape gate
test("T1-N1-accept: git tag production-v6.62.0 (valid semver shape) → not blocked by shape gate", () => {
  // AGENTS.md version matches tag version, so V4 also passes
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-v6.62.0" },
    },
    { cwd: dir }
  );
  // Must not block on shape; might or might not be blocked by V4 (here it matches, so should pass)
  assert.notEqual(r.json?.decision, "block", `valid shape production-v6.62.0 matching version MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

// T1-N1-accept: production-20260607 (valid date shape) → not blocked
test("T1-N1-accept: git tag production-20260607 (valid date shape) → not blocked", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260607" },
    },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `valid date shape production-20260607 MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

// T1-N1-accept: production-20260607-rules (valid rules shape) → not blocked
test("T1-N1-accept: git tag production-20260607-rules (valid rules shape) → not blocked", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260607-rules" },
    },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `valid rules shape production-20260607-rules MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

// T1-N1-accept: production-20260607-2 (valid ordinal date shape) → not blocked by N1 shape gate
// V2 ordinal-branch check also runs here; supply matching release branch via env override.
test("T1-N1-accept: git tag production-20260607-2 (valid ordinal date shape) → not blocked", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260607-2" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20260607-abc1234-2" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `valid ordinal date shape production-20260607-2 MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

// T1-V4-prove-it: version mismatch → block (lightweight tag)
test("T1-V4-prove-it: git tag production-v6.99.0 vs AGENTS.md 6.62.0 → block (release-integrity)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-v6.99.0" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `version mismatch MUST block; got: ${JSON.stringify(r.json)}`);
  const reason = r.json?.reason || "";
  assert.match(reason, /release-integrity/i, "reason must mention release-integrity");
  assert.match(reason, /6\.99\.0/, "reason must contain tag version");
  assert.match(reason, /6\.62\.0/, "reason must contain AGENTS.md version");
});

// T1-V4-prove-it: annotated tag with version mismatch → block
test("T1-V4-prove-it: git tag -a production-v6.99.0 -m x vs AGENTS.md 6.62.0 → block (annotated)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: 'git tag -a production-v6.99.0 -m "release"' },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `annotated tag version mismatch MUST block; got: ${JSON.stringify(r.json)}`);
  const reason = r.json?.reason || "";
  assert.match(reason, /release-integrity/i, "reason must mention release-integrity");
});

test("T1-V4-compound-merge-tag: mismatch reason redirects local production merge to PR-only exact-merge tagging", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.66.9", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'git merge --no-ff release/v6.66.10 -m "Merge release/v6.66.10 into production" && git tag production-v6.66.10',
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `compound merge+tag mismatch MUST block; got: ${JSON.stringify(r.json)}`);
  const reason = r.json?.reason || "";
  assert.match(reason, /release-integrity/i, "reason must mention release-integrity");
  assert.match(reason, /同一 Bash payload/, "reason must identify the compound payload shape");
  assert.match(reason, /PreToolUse.*Bash 執行前檢查/, "reason must explain pre-merge evaluation timing");
  assert.match(reason, /本機 production merge 已禁止/, "reason must prohibit local production merge");
  assert.match(reason, /production 僅可由 PR 更新/, "reason must state the PR-only production contract");
  const orderedRecoveryAnchors = [
    "push `release/v<X.Y.Z>`",
    "base `production`",
    "GitHub merge",
    "exact merged production commit",
    "`MERGE_SHA`",
    "`git tag production-v<X.Y.Z> \"$MERGE_SHA\"`",
    "`git push origin refs/tags/production-v<X.Y.Z>`",
  ];
  let priorIndex = -1;
  for (const anchor of orderedRecoveryAnchors) {
    const index = reason.indexOf(anchor);
    assert.ok(index > priorIndex, `reason must contain ordered PR-only recovery anchor ${anchor}: ${reason}`);
    priorIndex = index;
  }
  assert.doesNotMatch(reason, /請拆成兩個 hook-visible Bash invocation/, "reason must not authorize split local merge/tag reruns");
  assert.doesNotMatch(reason, /git merge --no-ff release\/v<X\.Y\.Z>/, "reason must not instruct a local production merge");
});

// T1-V4-match: tag version matches AGENTS.md → pass
test("T1-V4-match: git tag production-v6.62.0 vs AGENTS.md 6.62.0 → pass (match)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-v6.62.0" },
    },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `matching versions MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

// ── V4 worktree-aware version source (issue: V4 cwd misread) ──────────────
// `git tag production-v<X>` is run in a PRODUCTION WORKTREE whose AGENTS.md is the
// just-bumped version, while the hook payload cwd is the MAIN worktree whose AGENTS.md
// may still be stale (pre-bump). V4 MUST read AGENTS.md from the tag command's EFFECTIVE
// worktree cwd (resolved from a `cd <worktree>` prefix), not the payload-level baseCwd —
// otherwise it blocks a correct release tag on a stale main-worktree version. The two
// worktrees share a git common-dir (linked worktrees), so the repo-scope gate does NOT
// fire. Mirrors gh-footer-gate.mjs's worktree-aware version source + branch-verb-whitelist's
// effectiveCwd. cross-ref: openspec spec.md §"Production Tag Shape And Version Equality".
//
// Helper: a main worktree (AGENTS.md = mainVer) + a linked production worktree
// (AGENTS.md = prodVer). Returns { mainDir, prodDir }.
function setupMainAndProdWorktree(mainVer, prodVer) {
  const mainDir = path.join(tmpRoot, `repo-v4wt-${repoCounter++}`);
  mkdirSync(mainDir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: mainDir });
  markSourceCheckout(mainDir);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: mainDir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: mainDir });
  writeFileSync(path.join(mainDir, "AGENTS.md"), `# AI Agent\n\n版本：${mainVer}\n`);
  writePreflightFixture(mainDir);
  spawnSync("git", ["add", "."], { cwd: mainDir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: mainDir });
  spawnSync("git", ["branch", "production"], { cwd: mainDir });
  const prodDir = path.join(mainDir, "prod-wt");
  spawnSync("git", ["worktree", "add", "-q", prodDir, "production"], { cwd: mainDir });
  // bump AGENTS.md in the production worktree only
  writeFileSync(path.join(prodDir, "AGENTS.md"), `# AI Agent\n\n版本：${prodVer}\n`);
  spawnSync("git", ["add", "AGENTS.md"], { cwd: prodDir });
  spawnSync("git", ["commit", "-q", "-m", "bump"], { cwd: prodDir });
  return { mainDir, prodDir };
}

test("T1-V4-worktree: cd <prod-worktree> && git tag uses worktree's AGENTS.md version (pass)", () => {
  // main worktree stale 6.66.4 (payload cwd); production worktree bumped 6.66.5 (tag target)
  const { mainDir, prodDir } = setupMainAndProdWorktree("6.66.4", "6.66.5");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `cd ${prodDir} && git tag production-v6.66.5` },
    },
    { cwd: mainDir }
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `V4 must read AGENTS.md from the tag's effective worktree (6.66.5), not stale baseCwd (6.66.4); got: ${JSON.stringify(r.json)}`
  );
});

test("T1-V4-worktree-mismatch: cd <prod-worktree> && git tag still blocks on real mismatch", () => {
  // Negative guard: even with worktree resolution, a genuine mismatch (tag 6.99.0 vs
  // worktree AGENTS.md 6.66.5) must still block — the fix must not blanket-skip V4,
  // and the reason must cite the WORKTREE version (6.66.5), not the stale baseCwd (6.66.4).
  const { mainDir, prodDir } = setupMainAndProdWorktree("6.66.4", "6.66.5");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `cd ${prodDir} && git tag production-v6.99.0` },
    },
    { cwd: mainDir }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `genuine mismatch (tag 6.99.0 vs worktree 6.66.5) MUST still block; got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json?.reason || "", /6\.66\.5/, "reason must show the worktree AGENTS.md version (6.66.5), not stale baseCwd");
});

// T1-fail-open: AGENTS.md not readable → V4 layer skipped (no block)
test("T1-fail-open: AGENTS.md missing → V4 version check skipped (no block)", () => {
  // null agentsVersion → no AGENTS.md file written
  const dir = setupRepoWithAgentsMdAndTag(null, null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-v6.99.0" },
    },
    { cwd: dir }
  );
  // N1 shape is valid (production-v6.99.0), V4 should fail-open without AGENTS.md
  assert.notEqual(r.json?.decision, "block", `AGENTS.md missing MUST fail-open (no block); got: ${JSON.stringify(r.json)}`);
});

// T1-fail-open: tag version not extractable (wrong prefix) → no block (V4 skipped)
// production-20260607 is a valid shape but not production-v* so extractVersionFromTag returns null → V4 skip
test("T1-fail-open: non-v production tag → V4 skipped (no block)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260607" },
    },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `non-v production tag V4 MUST fail-open; got: ${JSON.stringify(r.json)}`);
});

// T1-non-production: non-production- prefix tag → gate not triggered at all
test("T1-non-production: git tag v1.0.0 (non production- prefix) → gate not triggered", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag v1.0.0" },
    },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `non-production tag MUST NOT be blocked; got: ${JSON.stringify(r.json)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// T2: prove-it — V2 ordinal-suffix release-branch match gate
// env override: DEVPRO_LOCAL_RELEASE_BRANCHES (comma-separated branch names)
// ─────────────────────────────────────────────────────────────────────────

// T2-V2-rules-block: production-20260608-rules-2 + no matching release branch → block
test("T2-V2-rules-block: git tag production-20260608-rules-2 + no matching release/rules-20260608-2 → block (V2 ordinal)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260608-rules-2" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/rules-20260608-1,release/rules-20260607-2" },
    }
  );
  assert.equal(r.json?.decision, "block", `missing release/rules-20260608-2 MUST block; got: ${JSON.stringify(r.json)}`);
  const reason = r.json?.reason || "";
  assert.match(reason, /release\/rules-20260608-2/, "reason must mention expected release branch");
});

// T2-V2-target-note: both V2 lanes say the branch is only a name pairing and the
// tag still has to sit on origin/production (checked by the pre-push hook).
test("T2-V2-target-note: V2 block on both lanes says the tag must still be on origin/production", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  for (const tag of ["production-20260608-rules-2", "production-20260608-2"]) {
    const r = run(
      { tool_name: "Bash", tool_input: { command: `git tag ${tag}` } },
      { cwd: dir, env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20260607-abc1234-2" } }
    );
    assert.equal(r.json?.decision, "block", `${tag}: ${JSON.stringify(r.json)}`);
    const reason = r.json?.reason || "";
    assert.match(reason, /Ordinal-Branch Match Gate \(V2\)/);
    assert.match(reason, /分支只是命名對應，不代表 tag 可以打在 production 之外/, tag);
    assert.match(reason, /`origin\/production`[^\n]*pre-push hook 會檢查/, tag);
  }
});

// T2-V2-rules-pass: production-20260608-rules-2 + matching release branch present → pass (V2)
test("T2-V2-rules-pass: git tag production-20260608-rules-2 + DEVPRO_LOCAL_RELEASE_BRANCHES has release/rules-20260608-2 → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260608-rules-2" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/rules-20260608-2,release/rules-20260607-3" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `matching release branch present MUST NOT block on V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-same-payload-rules: branch created earlier in the SAME payload → pass (issue #3601)
test("T2-V2-same-payload-rules: git branch release/rules-20260608-2 && git tag production-20260608-rules-2 → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git branch release/rules-20260608-2 && git tag production-20260608-rules-2",
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/rules-20260608-1" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `branch created in the same payload MUST satisfy V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-same-payload-date: date lane, switch -c earlier in the same payload → pass (issue #3601)
test("T2-V2-same-payload-date: git switch -c release/20261113-9977e79-10 && git tag production-20261113-10 → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git switch -c release/20261113-9977e79-10 9977e79 && git tag -a production-20261113-10 -m release",
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20261113-abc1234-9" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `same-payload switch -c MUST satisfy V2 date lane; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-same-payload-worktree: the runbook form `git worktree add <path> -b <branch>` in the same payload → pass
test("T2-V2-same-payload-worktree: git worktree add <path> -b release/20261113-9977e79-10 && git tag production-20261113-10 → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          `git worktree add "${dir}/.worktree/release-20261113" -b release/20261113-9977e79-10 9977e79 && git tag -a production-20261113-10 -m release`,
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20261113-abc1234-9" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `same-payload worktree add -b MUST satisfy V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-same-payload-checkout: checkout -b in the same payload → pass (covers the -b arm)
test("T2-V2-same-payload-checkout: git checkout -b release/20261113-abc1234-10 && git tag production-20261113-10 → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git checkout -b release/20261113-abc1234-10 && git tag production-20261113-10",
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20261113-abc1234-9" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `same-payload checkout -b MUST satisfy V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-same-payload-switch-create: the long --create form in the same payload → pass
test("T2-V2-same-payload-switch-create: git switch --create release/20261113-abc1234-10 && git tag production-20261113-10 → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git switch --create release/20261113-abc1234-10 && git tag production-20261113-10",
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20261113-abc1234-9" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `same-payload switch --create MUST satisfy V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-same-payload-quoted: the branch name only appears as text quoted into another command → still block.
// The assertion matches the V2 reason so the protected-branch gate (which would also block a git commit
// on this fixture) cannot make this test pass for the wrong reason.
test("T2-V2-same-payload-quoted: branch name only quoted into echo text still blocks (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'echo "git branch release/rules-20260608-2" && git tag production-20260608-rules-2',
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/rules-20260608-1" },
    }
  );
  assert.equal(r.json?.decision, "block", `quoted branch text MUST NOT satisfy V2; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /release\/rules-20260608-2/, "the block must come from V2 (expected branch named)");
});

// T2-V2-same-payload-argument-position: an unquoted branch name in echo arguments is not a creation either
test("T2-V2-same-payload-argument-position: echo git branch <name> does not satisfy V2", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "echo git branch release/rules-20260608-2; git tag production-20260608-rules-2",
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/rules-20260608-1" },
    }
  );
  assert.equal(r.json?.decision, "block", `argument-position text MUST NOT satisfy V2; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /release\/rules-20260608-2/, "the block must come from V2 (expected branch named)");
});

// T2-V2-same-payload-delete: a branch delete is not a creation → still block
test("T2-V2-same-payload-delete: git branch -d release/rules-20260608-2 && git tag production-20260608-rules-2 → block (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git branch -d release/rules-20260608-2 && git tag production-20260608-rules-2",
      },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/rules-20260608-1" },
    }
  );
  assert.equal(r.json?.decision, "block", `branch delete MUST NOT satisfy V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-date-block: production-20260608-3 + no matching release/20260608-*-3 → block (V2 date lane)
test("T2-V2-date-block: git tag production-20260608-3 + no release/20260608-<sha>-3 → block (V2 ordinal date lane)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260608-3" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20260608-abc1234-2,release/20260607-def5678-3" },
    }
  );
  assert.equal(r.json?.decision, "block", `missing release/20260608-*-3 MUST block; got: ${JSON.stringify(r.json)}`);
  const reason = r.json?.reason || "";
  assert.match(reason, /20260608/, "reason must mention date");
  assert.match(reason, /-3/, "reason must mention ordinal");
});

// T2-V2-date-pass: production-20260608-3 + release/20260608-abc1234-3 present → pass (V2)
test("T2-V2-date-pass: git tag production-20260608-3 + release/20260608-abc1234-3 in DEVPRO_LOCAL_RELEASE_BRANCHES → pass (V2)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260608-3" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "release/20260608-abc1234-3,release/20260607-xyz9999-2" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `matching release branch present MUST NOT block on V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-skip-first: production-20260608-rules (no ordinal) → V2 not triggered (first release, no verify)
test("T2-V2-skip-first: git tag production-20260608-rules (no ordinal) → V2 skipped (first release)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260608-rules" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "" },
    }
  );
  assert.notEqual(r.json?.decision, "block", `first rules release (no ordinal) MUST NOT be blocked by V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-skip-semver: production-v6.62.0 → V2 not triggered (SemVer lane, no ordinal concept)
test("T2-V2-skip-semver: git tag production-v6.62.0 → V2 skipped (SemVer lane)", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-v6.62.0" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "" },
    }
  );
  // V2 does not apply to SemVer tags; must not block due to V2 (V4 version match passes here)
  assert.notEqual(r.json?.decision, "block", `SemVer tag MUST NOT be blocked by V2; got: ${JSON.stringify(r.json)}`);
});

// T2-V2-target-repo: the tag is created in the repo the command `cd`s into, so its release branches —
// not the session repo's — decide V2. A cross-repo release used to be blocked even though the
// target repo had the matching release branch.
function setupGitRepoWithBranches(name, branches) {
  const dir = path.join(tmpRoot, `${name}-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "fixture"], ...branches.map((b) => ["branch", b])]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  return dir;
}

for (const [label, sessionBranches, targetBranches, blocked] of [
  ["only the target repo has release/20260608-*-3 → pass", [], ["release/20260608-abc1234-3"], false],
  ["only the session repo has release/20260608-*-3 → block", ["release/20260608-abc1234-3"], [], true],
]) {
  test(`T2-V2-target-repo: cd <other repo> && git tag production-20260608-3 — ${label}`, () => {
    const session = setupGitRepoWithBranches("v2-session", sessionBranches);
    const target = setupGitRepoWithBranches("v2-target", targetBranches);
    const r = run(
      {
        tool_name: "Bash",
        tool_input: { command: `cd ${target} && DEVPRO_REPO_SCOPE_APPROVED=${path.basename(target)} git tag production-20260608-3 HEAD` },
      },
      { cwd: session, env: { DEVPRO_LOCAL_RELEASE_BRANCHES: undefined } }
    );
    const v2 = r.json?.decision === "block" && /Ordinal-Branch Match Gate/.test(r.json?.reason || "");
    assert.equal(v2, blocked, JSON.stringify(r.json));
  });
}

// T2-V2-fail-open: DEVPRO_LOCAL_RELEASE_BRANCHES not set → git branch --list path (fail-open if unavailable)
// When env override not set and git branch unavailable, must not block (fail-open)
test("T2-V2-fail-open: DEVPRO_LOCAL_RELEASE_BRANCHES not set → fail-open (no block) for git-unavailable scenario", () => {
  const dir = setupRepoWithAgentsMdAndTag("6.62.0", null);
  // When DEVPRO_LOCAL_RELEASE_BRANCHES is set to special value "__UNAVAILABLE__" → simulate git failure → fail-open
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git tag production-20260608-rules-2" },
    },
    {
      cwd: dir,
      env: { DEVPRO_LOCAL_RELEASE_BRANCHES: "__UNAVAILABLE__" },
    }
  );
  // fail-open: git branch unavailable → no block
  assert.notEqual(r.json?.decision, "block", `V2 MUST fail-open when branch list unavailable; got: ${JSON.stringify(r.json)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// D6-F2: tool-brand sentence ban (prove-it pattern)
// Both the commit attribution path and gh body path share attribution-patterns.mjs.
// Here we test the commit (-F) path; gh body path tested in hook-gh-footer-gate.test.mjs.
// ─────────────────────────────────────────────────────────────────────────

// Block cases: whole-line brand-marker sentences
test("D6-F2-block: commit -F with 'Made with Claude' whole-line brand marker → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-a1.txt");
  writeFileSync(msg, "fix: resolve issue\n\nMade with Claude\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `'Made with Claude' whole-line brand marker MUST block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /attribution|brand marker/i);
});

test("D6-F2-block: commit -F with '🤖 Generated by Cursor' whole-line brand marker → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-a2.txt");
  writeFileSync(msg, "fix: resolve issue\n\n🤖 Generated by Cursor\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `'🤖 Generated by Cursor' whole-line brand marker MUST block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /attribution|brand marker/i);
});

test("D6-F2-block: commit -F with 'Generated by Copilot' whole-line brand marker → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-a3.txt");
  writeFileSync(msg, "fix: resolve issue\n\nGenerated by Copilot\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `'Generated by Copilot' whole-line brand marker MUST block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /attribution|brand marker/i);
});

// Not-block cases: natural prose (regression guard — most critical)
test("D6-F2-not-block(natural prose): commit with 'files generated by the build' in body → NOT banned", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-np1.txt");
  writeFileSync(msg, "fix: handle files generated by the build script\n\nDetailed description.\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `natural prose 'generated by the build' MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

test("D6-F2-not-block(natural prose): commit with 'update generated by codegen' in subject → NOT banned", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-np2.txt");
  writeFileSync(msg, "feat: parser generated by codegen\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `natural prose 'generated by codegen' MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

test("D6-F2-not-block(natural prose): commit with 'made with care for edge cases' → NOT banned (lowercase non-brand)", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-np3.txt");
  writeFileSync(msg, "docs: update readme made with care for edge cases\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.notEqual(r.json?.decision, "block", `natural prose 'made with care' MUST NOT block; got: ${JSON.stringify(r.json)}`);
});

// ── D6-F2-over-block: documented precision tradeoff ──────────────────────────
// ACCEPTED TRADEOFF (per proposal D1/D2): F4/F5 patterns match any whole-line
// capitalized sentence of the form "Made with <CapWord>" or "Generated by
// <CapWord>", regardless of whether <CapWord> is an AI brand or a non-AI tool /
// library name. A sentence like "Made with <a capitalized tool name>" on its own
// whole line IS blocked — this is a known over-block that the proposal explicitly
// accepts because:
//   (a) AI commit messages rarely put such phrases as standalone footer lines, and
//   (b) precision-over-recall is the deliberate design choice (brand marker
//       convention = whole-line capitalized sentence).
// Guaranteed NOT to block: mid-sentence fragments, lowercase openers, or
// "<Verb> by/with" without a following capitalized word.
// If future work narrows the regex, this test MUST be updated consciously.
test("D6-F2-over-block(known tradeoff): commit with 'Made with Hugo' whole-line → block (accepted precision over-block per D1/D2)", () => {
  // hasForbiddenAttribution returns true for this input — documented over-block.
  // "Hugo" is a capitalized non-AI tool name; the F4 pattern cannot distinguish
  // it from an AI brand marker. This is the precision-over-recall tradeoff
  // accepted in proposal D1/D2. The assertion INTENTIONALLY expects block=true.
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-ob1.txt");
  writeFileSync(msg, "docs: add docs\n\nMade with Hugo\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", "KNOWN OVER-BLOCK: 'Made with Hugo' on its own line IS blocked by F4 (accepted tradeoff per D1/D2; update consciously if regex narrows)");
  assert.match(r.json?.reason || "", /attribution|brand marker/i, "blocked with attribution/brand-marker reason (expected over-block behavior)");
});

// ── D6-F2-hyphen: hyphenated/versioned brand name regression (cross-model) ────
// F4/F5 char class now includes hyphen [\w.\s-] to cover `<Tool>-<version>`
// style brand markers that AI naturally emits. These were SLIP cases before fix.
test("D6-F2-hyphen-block: commit -F with 'Generated by GPT-4' whole-line versioned brand marker → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-hyp1.txt");
  writeFileSync(msg, "fix: resolve issue\n\nGenerated by GPT-4\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `'Generated by GPT-4' whole-line versioned brand marker MUST block (F5 + hyphen fix); was SLIP before; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /attribution|brand marker/i);
});

test("D6-F2-hyphen-block: commit -F with 'Made with GPT-4.1' whole-line versioned brand marker → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-hyp2.txt");
  writeFileSync(msg, "feat: update parser\n\nMade with GPT-4.1\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `'Made with GPT-4.1' whole-line versioned brand marker MUST block (F4 + hyphen fix); was SLIP before; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /attribution|brand marker/i);
});

test("D6-F2-hyphen-block: commit -F with 'Generated by Tool-Name' whole-line hyphenated brand marker → block", () => {
  const repo = setupRepo("feature/foo");
  const msg = path.join(repo, "commit-d6f2-hyp3.txt");
  writeFileSync(msg, "chore: housekeeping\n\nGenerated by Tool-Name\n\nRules: v6.62.0 · Tool: claude-code · Model: claude-sonnet\n");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git commit -F ${msg}` } },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", `'Generated by Tool-Name' whole-line hyphenated brand marker MUST block (F5 + hyphen fix); got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /attribution|brand marker/i);
});

// ── N6 (second site): isConsumerSubsetReleaseBranchExempt SHA length = exactly 7 ──
// Canonical SHA length is 7 per `git rev-parse --short=7` (release-sit-uat-pat-prod.md).
// pre-tool-gate.mjs had a second drift copy (`{7,40}`) separate from branch-naming.mjs.
// These tests lock the corrected {7} shape for isConsumerSubsetReleaseBranchExempt.

test("N6-gate-pass-7hex: isConsumerSubsetReleaseBranchExempt('release/20260608-abc1234') → true (7 hex, canonical)", () => {
  assert.equal(
    isConsumerSubsetReleaseBranchExempt("release/20260608-abc1234"),
    true,
    "7-hex SHA must be accepted (canonical --short=7)"
  );
});

test("N6-gate-reject-8hex: isConsumerSubsetReleaseBranchExempt('release/20260608-abc12345') → false (8 hex, drift gap)", () => {
  // PRE-FIX: regex {7,40} accepted 8-hex (silent exemption gap in pre-tool-gate.mjs).
  // POST-FIX: regex {7} must reject 8-hex.
  assert.equal(
    isConsumerSubsetReleaseBranchExempt("release/20260608-abc12345"),
    false,
    "8-hex SHA must be rejected after SHA-length tightening to {7}"
  );
});

test("N6-gate-reject-6hex: isConsumerSubsetReleaseBranchExempt('release/20260608-abc123') → false (6 hex, too short)", () => {
  assert.equal(
    isConsumerSubsetReleaseBranchExempt("release/20260608-abc123"),
    false,
    "6-hex SHA must be rejected (shorter than canonical 7)"
  );
});

test("N6-gate-reject-40hex: isConsumerSubsetReleaseBranchExempt('release/20260608-' + 'a'.repeat(40)) → false (40 hex, drift gap)", () => {
  assert.equal(
    isConsumerSubsetReleaseBranchExempt("release/20260608-" + "a".repeat(40)),
    false,
    "40-hex SHA must be rejected (pre-tool-gate drift gap — accepted by old {7,40})"
  );
});

test("N6-gate-pass-rules-unaffected: isConsumerSubsetReleaseBranchExempt('release/rules-20260608-2') → false (rules lane, different helper)", () => {
  // rules-lane branches are handled by isRulesLaneReleaseBranchExempt, not this helper.
  assert.equal(
    isConsumerSubsetReleaseBranchExempt("release/rules-20260608-2"),
    false,
    "rules-lane branch must not match the consumer-subset helper"
  );
});

test("N6-gate-pass-semver-unaffected: isConsumerSubsetReleaseBranchExempt('release/v6.62.0') → false (semver lane, different helper)", () => {
  // semver-lane branches are handled by isSourceRepoReleaseBranchExempt, not this helper.
  assert.equal(
    isConsumerSubsetReleaseBranchExempt("release/v6.62.0"),
    false,
    "semver-lane branch must not match the consumer-subset helper"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Local-Test Gate Merge Evidence (enforce-local-test-merge-evidence)
// Without receipt + sticky-PASS + code carrier → decision block
// With matching suite_evidence pass/fail0 receipt → not blocked
// Docs-only / consumer / node_modules / diff-error → fail-open / no fire
// Coexistence: sticky-absent still cross-model block
// ─────────────────────────────────────────────────────────────────────────

// Sticky-PASS mock helper: produces CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT JSON
// with a PASS sticky comment whose last_reviewed_sha matches headRefOid, so the
// cross-model block gate (Path F) lets the merge through and local-test evidence
// gate evaluates.
function stickyPassEnv(branch = "feature/foo") {
  const sha = "a".repeat(40);
  return {
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
      comments: [
        {
          body: [
            "<!-- cross-model-second-opinion:sticky -->",
            "verdict: PASS",
            `last_reviewed_sha: ${sha}`,
            "dispatch_id: test-local-gate-pass",
            "reason: Test fixture confirms the reviewed pull request head is approved.",
            "Rules: v1.0.0 · Tool: Claude Code · Model: claude-test",
          ].join("\n"),
          url: "https://example.invalid/sticky",
        },
      ],
      headRefOid: sha,
      headRefName: branch,
      body: "",
    }),
  };
}

// A merge writes the repository in full; these fixtures are the rules source, so it is this one.
const SOURCE_REPO_FLAG = "--repo github.com/devpro-tw/devpro-agent-rules";

const LOCAL_TEST_PASS_SUITE = {
  status: "pass",
  fail: 0,
  digest_sha256: "c".repeat(64),
};

// T2: gh pr merge 123 + code-touching diff + sticky-PASS + no receipt → BLOCK
test("Local-Test Gate: T2 — code-touching PR without receipt → decision block", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          ".devpro/scripts/hooks/pre-tool-gate.mjs\nsome-other.mjs",
      },
    }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `Expected local-test evidence block without receipt, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /\[Local-Test Gate\]/,
    `Expected Local-Test Gate block reason, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /node \.devpro\/scripts\/run-test-suite\.mjs --changed main/,
    `Expected remediation with suite runner, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /record-regression-head\.mjs/,
    `Expected record-regression-head remediation, got: ${JSON.stringify(r.json)}`
  );
});

// T2b: matching suite_evidence pass/fail0 receipt → not blocked
test("Local-Test Gate: T2b — matching pass/fail0 receipt → merge not blocked", () => {
  // withCommit:true so defaultMainCheckoutRoot resolves to this fixture (not a shared template).
  const repo = setupRepo("feature/foo", { withCommit: true });
  const sha = "a".repeat(40);
  const written = writeLocalTestReceipt({
    cwd: repo,
    change: "enforce-local-test-merge-evidence",
    headSha: sha,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          ".devpro/scripts/hooks/pre-tool-gate.mjs\nsome-other.mjs",
      },
    }
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `Expected no block when receipt matches head, got: ${JSON.stringify(r.json)}`
  );
});

// T2c: invalid / missing headRefOid → BLOCK (cannot verify evidence).
// Use chore-A exempt branch so cross-model sticky Path D does not short-circuit
// before local-test (invalid headRefOid would also trip Path D on non-exempt PRs).
test("Local-Test Gate: T2c — invalid headRefOid → decision block", () => {
  const repo = setupRepo("chore/foo", { withCommit: true });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: "chore/foo",
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [],
          headRefOid: "not-a-valid-oid",
          headRefName: "chore/foo",
          body: "",
        }),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          ".devpro/scripts/hooks/pre-tool-gate.mjs",
      },
    }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `Expected block on invalid headRefOid, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /\[Local-Test Gate\]/,
    `Expected Local-Test Gate reason, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /headRefOid/,
    `Expected headRefOid wording, got: ${JSON.stringify(r.json)}`
  );
});

// T3: change-folder docs-only → no local-test fire
test("Local-Test Gate: T3 — change-folder/docs-only PR diff → no local-test block (no wolf-cry)", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          "openspec/changes/enforce-local-test-gate-on-merge/proposal.md",
      },
    }
  );
  assert.notEqual(r.json?.decision, "block", `docs-only must not block; got: ${JSON.stringify(r.json)}`);
  assert.doesNotMatch(
    r.json?.reason || advisoryText(r.json) || "",
    /\[Local-Test Gate\]/,
    `Expected no Local-Test Gate for docs-only diff, got: ${JSON.stringify(r.json)}`
  );
});

// Prove-it (issue #1204): consumer business repo must NOT get local-test gate
test("Local-Test Gate: T7 consumer repo (.gitmodules) — carrier diff → NO local-test block (issue #1204)", () => {
  // A committed checkout with positive consumer evidence: classified first, so a broken consumer branch cannot pass
  // this test by reading as unknown.
  const repo = setupRepo("feature/foo", { withCommit: true });
  writeFileSync(path.join(repo, ".gitmodules"), "[submodule \"x\"]\n  path = .devpro-agent-rules\n");
  markConsumerCheckout(repo);
  // A consumer merges into its own repository, written in full (--repo github.com/example-org/consumer-app) and run
  // from this checkout, whose origin is that repository: the merge gates read this checkout, whose identity (consumer)
  // decides that the source-only local-test gate does not apply.
  spawnSync("git", ["remote", "set-url", "origin", "https://github.com/example-org/consumer-app.git"], { cwd: repo });
  assert.equal(destinationIdentity(repo).identity, "consumer");
  const r = run(
    { tool_name: "Bash", tool_input: { command: "gh pr merge 384 --repo github.com/example-org/consumer-app --merge" } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          "openspec/specs/assessment-annual-export/spec.md",
      },
    }
  );
  assert.notEqual(r.json?.decision, "block", `consumer must not local-test block; got: ${JSON.stringify(r.json)}`);
  assert.doesNotMatch(
    r.json?.reason || advisoryText(r.json) || "",
    /\[Local-Test Gate\]/,
    `consumer repo must NOT get local-test gate; got: ${JSON.stringify(r.json)}`
  );
});

// T7 contrast: SAME carrier diff in SOURCE repo → local-test DOES block without receipt
test("Local-Test Gate: T7 contrast source repo — same spec carrier → local-test blocks without receipt", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 384 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          "openspec/specs/assessment-annual-export/spec.md",
      },
    }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `source repo SHOULD local-test block without receipt; got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json?.reason || "", /\[Local-Test Gate\]/);
});

// T3b: node_modules exclusion
test("Local-Test Gate: T3b node_modules — node_modules/some-pkg/index.mjs in diff → no local-test block", () => {
  const repo = setupRepo("feature/foo");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          "node_modules/some-pkg/index.mjs",
      },
    }
  );
  assert.notEqual(r.json?.decision, "block", `node_modules must not block; got: ${JSON.stringify(r.json)}`);
  assert.doesNotMatch(
    r.json?.reason || "",
    /\[Local-Test Gate\]/,
    `Expected no Local-Test Gate for node_modules/.mjs, got: ${JSON.stringify(r.json)}`
  );
});

test("Local-Test Gate: T3b contrast — .devpro/scripts/foo.mjs in diff → local-test blocks without receipt", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          ".devpro/scripts/foo.mjs",
      },
    }
  );
  assert.equal(r.json?.decision, "block", `carrier must block without receipt; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json?.reason || "", /\[Local-Test Gate\]/);
});

// T6 fail-open — diff fetch error → no local-test block, no throw
test("Local-Test Gate: T6 fail-open — diff fetch error → no local-test block, no throw", () => {
  const repo = setupRepo("feature/foo");
  let r;
  assert.doesNotThrow(() => {
    r = run(
      { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
      {
        cwd: repo,
        env: {
          ...stickyPassEnv("feature/foo"),
          CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "simulated diff error",
        },
      }
    );
  }, "fail-open: gate MUST NOT throw on diff-fetch error");
  assert.doesNotMatch(
    r?.json?.reason || advisoryText(r?.json) || "",
    /\[Local-Test Gate\]/,
    `Expected no Local-Test Gate on diff-fetch error, got: ${JSON.stringify(r?.json)}`
  );
});

// T6 coexistence — sticky-absent → cross-model gate still blocks
test("Local-Test Gate: T6 coexistence — sticky-absent → cross-model block fires", () => {
  const repo = setupRepo("feature/foo");
  const sha = "a".repeat(40);
  const r = run(
    { tool_name: "Bash", tool_input: { command: `gh pr merge 123 ${SOURCE_REPO_FLAG} --merge` } },
    {
      cwd: repo,
      env: {
        CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
          comments: [],
          headRefOid: sha,
          headRefName: "feature/foo",
          body: "",
        }),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          ".devpro/scripts/hooks/pre-tool-gate.mjs\nopenspec/changes/enforce-local-test-gate-on-merge/proposal.md",
      },
    }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `cross-model gate MUST still block when sticky absent; got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason || "",
    /Cross-Model Merge Gate/,
    "sticky-absent MUST surface as cross-model block (registered before local-test)"
  );
});

// T8: a source session merging another repository reads that repository's checkout, which is not the source, so the
// local-test gate does not apply; without the marker and that checkout the cross-repo merge gate blocks first.
test("Local-Test Gate: T8 — --repo other/repo with its own checkout is not local-test gated; without it the merge is blocked", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  spawnSync(
    "git",
    ["remote", "add", "origin", "https://github.com/devpro-tw/devpro-agent-rules.git"],
    { cwd: repo }
  );
  const other = setupRepo("feature/foo", { withCommit: true });
  const configured = spawnSync("git", ["remote", "set-url", "origin", "https://github.com/other-org/other-repo.git"], { cwd: other, encoding: "utf8" });
  assert.equal(configured.status, 0, configured.stderr);
  const trace = path.join(other, "merge-pr-view.jsonl");
  const env = {
    ...stickyPassEnv("feature/foo"),
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: ".devpro/scripts/hooks/pre-tool-gate.mjs\nsome-other.mjs",
    CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: trace,
  };
  const bare = run({ tool_name: "Bash", tool_input: { command: "gh pr merge 123 --repo github.com/other-org/other-repo --merge" } }, { cwd: repo, env });
  assert.equal(bare.json?.decision, "block", JSON.stringify(bare.json));
  assert.match(bare.json.reason, /^Cross-repo PR merge gate: /);
  assert.equal(existsSync(trace), false, "the early checkout gate rejects before looking up the PR");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `DEVPRO_CROSS_REPO_PR=other-org/other-repo DEVPRO_PR_CHECKOUT="${other}" gh pr merge 123 --repo github.com/other-org/other-repo --merge`,
      },
    },
    { cwd: repo, env }
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `cross-repo --repo MUST fail-open for local-test; got: ${JSON.stringify(r.json)}`
  );
  const views = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter(({ helper }) => helper === "_runGhPrView");
  assert.ok(views.length > 0, "the bound merge reaches the downstream PR evidence gates");
  assert.ok(views.every(({ pr, repo: target }) => pr === "123" && target === "github.com/other-org/other-repo"), JSON.stringify(views));
});

// T8b: same-repo explicit --repo matching origin still blocks without receipt
test("Local-Test Gate: T8b — --repo matching origin still blocks without receipt", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  spawnSync(
    "git",
    ["remote", "add", "origin", "https://github.com/devpro-tw/devpro-agent-rules.git"],
    { cwd: repo }
  );
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "gh pr merge 123 --repo github.com/devpro-tw/devpro-agent-rules --merge",
      },
    },
    {
      cwd: repo,
      env: {
        ...stickyPassEnv("feature/foo"),
        CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES:
          ".devpro/scripts/hooks/pre-tool-gate.mjs\nsome-other.mjs",
      },
    }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `same-repo --repo MUST still local-test block; got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json?.reason || "", /\[Local-Test Gate\]/);
});

// T8c: a merge bound to its checkout keeps the receipt check even when a second reading of that checkout's origin
// fails: an ssh URL on port 443 binds github.com/devpro-tw/devpro-agent-rules, while resolveGithubOwnerRepo reads no
// slug from it (PR #3703 r7 W2-F2).
test("Local-Test Gate: T8c — a bound merge is receipt-checked even when the origin is read only by the merge gate", () => {
  const repo = setupRepo("feature/foo", { withCommit: true });
  for (const args of [["remote", "remove", "origin"], ["remote", "add", "origin", "ssh://git@ssh.github.com:443/devpro-tw/devpro-agent-rules.git"]]) {
    spawnSync("git", args, { cwd: repo });
  }
  assert.equal(spawnSync("git", ["config", "--local", "--get", "remote.origin.url"], { cwd: repo, encoding: "utf8" }).stdout.trim(), "ssh://git@ssh.github.com:443/devpro-tw/devpro-agent-rules.git");
  const merge = () => run(
    { tool_name: "Bash", tool_input: { command: "gh pr merge 123 --repo github.com/devpro-tw/devpro-agent-rules --merge" } },
    { cwd: repo, env: { ...stickyPassEnv("feature/foo"), CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: ".devpro/scripts/hooks/pre-tool-gate.mjs\nsome-other.mjs" } },
  );
  // Without a receipt the block is the missing-evidence one for this PR (PR #3703 r8 W7-F1).
  const missing = merge();
  assert.equal(missing.json?.decision, "block", JSON.stringify(missing.json));
  assert.match(missing.json?.reason || "", /^\[Local-Test Gate\] PR #123 diff 命中 code\/規範載體檔案，但三種可接受的本機測試證據皆未成立/, JSON.stringify(missing.json));
  // A receipt for the PR head lets the same bound merge through: the gate read the receipt, not some other failure.
  const written = writeLocalTestReceipt({ cwd: repo, change: "enforce-local-test-merge-evidence", headSha: "a".repeat(40), suiteEvidence: LOCAL_TEST_PASS_SUITE });
  assert.equal(written.status, "written", written.reason);
  const receipted = merge();
  assert.notEqual(receipted.json?.decision, "block", JSON.stringify(receipted.json));
});

// ─────────────────────────────────────────────────────────────────────────
// fix-merge-gate-regression-currency — T1 prove-it (design.md D1/D11)
//
// These are POSITIVE tests: they assert the merge is NOT blocked when form
// (2) (bookkeeping tip-move receipt, S1) or form (3) (head-bound
// FinalEvidenceRecord, S2') evidence is present. checkLocalTestGateOnMerge
// (unfixed, this file's Step 7) implements ONLY form (1) — an exact-head
// receipt via findAcceptableLocalTestReceipt — so BOTH tests below MUST FAIL
// on the unfixed T1-time code (RED): the gate still blocks, and the assertion failure
// message embeds the actual `{ block, reason }`, whose reason names
// `[Local-Test Gate]`, proving the block came from THIS gate (not a
// different gate or a broken fixture). After T2 (core
// verifyHeadBoundFinalEvidence), T3 (evaluateLocalTestTipMoveReceipt), and T4
// (bounded verifier child + Step 7 rewrite) land, these exact tests —
// unmodified — MUST flip to green (no block).
//
// Both tests call the exported `checkLocalTestGateOnMerge(cmd, baseCwd)`
// DIRECTLY rather than through the full hook dispatcher, the same precedent
// `hook-pre-tool-gate-cross-model-default-on.test.mjs` CMX-5 established.
// This sidesteps the cross-model sticky Path D entirely (no `stickyPassEnv`
// needed) — see design.md D11 "避免被上游 gate 冒充 RED／GREEN": going through
// the full dispatcher would require the sticky mock's `last_reviewed_sha` to
// equal the real PR head, or Path D would block first and produce a false RED.
// ─────────────────────────────────────────────────────────────────────────

const PROVE_IT_CHANGE_ID = "fix-merge-gate-regression-currency";

function callLocalTestGateDirect(command, cwd, { headRefOid, headRefName, diffFiles }) {
  const keys = ["CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT", "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES"];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = JSON.stringify({
      comments: [],
      headRefOid,
      headRefName,
    });
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = diffFiles;
    return checkLocalTestGateOnMerge(command, cwd);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Real two-commit git fixture (design.md D11 S1 shape): commit A carries a
// code file; commit B ONLY touches openspec/changes/<change>/** — a
// bookkeeping/archive-shaped tip move ahead of the reviewed+receipted HEAD.
function setupBookkeepingTipMoveRepo(branchName, changeId) {
  const dir = path.join(tmpRoot, `repo-s1-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  markSourceCheckout(dir);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "src.mjs"), "export const x = 1;\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "commit A: code"], { cwd: dir });
  const commitA = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  mkdirSync(path.join(dir, "openspec", "changes", changeId), { recursive: true });
  writeFileSync(path.join(dir, "openspec", "changes", changeId, "tasks.md"), "# tasks\n- [x] done\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "commit B: bookkeeping tip-move"], { cwd: dir });
  const commitB = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  rememberBranch(dir, branchName);
  return { dir, commitA, commitB };
}

test("Local-Test Gate: S1 — bookkeeping tip-move receipt (ancestor-bound; PR head advanced by openspec/changes/** only) → merge not blocked", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupBookkeepingTipMoveRepo(branch, PROVE_IT_CHANGE_ID);
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);

  const result = callLocalTestGateDirect("gh pr merge 4001 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: ".devpro/scripts/hooks/lib/final-evidence-merge-verifier.mjs",
  });

  // prove-it RED (before design.md D1/D3/T3/T4 land): unfixed
  // checkLocalTestGateOnMerge only implements exact-head receipt (7a), so a
  // receipt bound to ancestor commit A while PR head is commit B still
  // blocked at T1 time. The custom message embeds the actual block reason so a RED
  // run's failure output shows `[Local-Test Gate]` (this gate), not some
  // other gate or a broken fixture.
  assert.equal(
    result?.block,
    undefined,
    "S1: a bookkeeping tip-move receipt (form 2 — ancestor-bound receipt, " +
      "PR head advanced only by an openspec/changes/** delta) MUST NOT block " +
      `merge once form (2) is implemented. Got: ${JSON.stringify(result)}`
  );
});

test("Local-Test Gate: S2' — head-bound FinalEvidenceRecord with NO regression-head receipt → merge not blocked", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const repo = setupRepo(branch, { withCommit: true });
  const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  const { targetPath } = writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
  });
  assert.ok(existsSync(targetPath), `fixture FinalEvidenceRecord must be written to ${targetPath}`);

  const result = callLocalTestGateDirect("gh pr merge 4002 --merge", repo, {
    headRefOid: headSha,
    headRefName: branch,
    diffFiles: ".devpro/scripts/hooks/lib/final-evidence-merge-verifier.mjs",
  });

  // prove-it RED (before design.md D1/D4/D5/T2/T4 land): unfixed
  // checkLocalTestGateOnMerge never reads a FinalEvidenceRecord (no 7c), so a
  // head-bound record with no receipt still blocked at T1 time. Once T2/T4 land,
  // this exact test (unmodified, no injected deps) exercises the REAL
  // production verifier child/entry/budget end to end.
  assert.equal(
    result?.block,
    undefined,
    "S2': a head-bound FinalEvidenceRecord (form 3 — real suite ran at PR head) " +
      `MUST NOT block merge once form (3) is implemented. Got: ${JSON.stringify(result)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// fix-merge-gate-regression-currency — T4(b) hook-layer regression lock +
// positive cases (design.md D9/D11, tasks.md T4(b) acceptance list).
//
// Every case below calls the exported `checkLocalTestGateOnMerge` DIRECTLY
// (T1/CMX-5 precedent) — `callLocalTestGateDirect` for form (2)/(3) fixtures,
// `callLocalTestGateDirectWithDeps` when a case needs to inject
// `deps.finalEvidenceVerifier` (`{ entry, budget }`) to force a verifier
// child failure. `deps` is an in-process seam only — never an env variable
// (design D5 "沒有 env 可以換 entry 或放寬 budget").
// ─────────────────────────────────────────────────────────────────────────

const T4B_CODE_DIFF = ".devpro/scripts/hooks/lib/final-evidence-merge-verifier.mjs";

function callLocalTestGateDirectWithDeps(command, cwd, { headRefOid, headRefName, diffFiles }, deps) {
  const keys = ["CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT", "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES"];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = JSON.stringify({
      comments: [],
      headRefOid,
      headRefName,
    });
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = diffFiles;
    return checkLocalTestGateOnMerge(command, cwd, deps);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function t4bRepo(branch = `bugfix/${PROVE_IT_CHANGE_ID}`) {
  return setupRepo(branch, { withCommit: true });
}

function t4bHeadSha(dir) {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

/**
 * Two-commit fixture (design D11 S1 shape, generalized): commit A carries a
 * code file; commit B adds exactly ONE file at `secondCommitPath`. Used for
 * the non-bookkeeping-delta negative cases below (a violating path instead of
 * `openspec/changes/<change>/**`).
 */
function setupTwoCommitRepo(branchName, secondCommitPath, secondCommitContent = "placeholder\n") {
  const dir = path.join(tmpRoot, `repo-t4b-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  markSourceCheckout(dir);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "src.mjs"), "export const x = 1;\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "commit A: code"], { cwd: dir });
  const commitA = t4bHeadSha(dir);
  const secondPath = path.join(dir, secondCommitPath);
  mkdirSync(path.dirname(secondPath), { recursive: true });
  writeFileSync(secondPath, secondCommitContent);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", `commit B: ${secondCommitPath}`], { cwd: dir });
  const commitB = t4bHeadSha(dir);
  rememberBranch(dir, branchName);
  return { dir, commitA, commitB };
}

/** Fake-child Node script (design D11 "假 child…以 entry 注入"), never an env
 * seam — always wired through `deps.finalEvidenceVerifier.entry`. */
function writeFakeChildScript(code) {
  const dir = path.join(tmpRoot, `fake-child-t4b-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, "child.mjs");
  writeFileSync(scriptPath, code);
  return scriptPath;
}

function assertLocalTestGateBlocks(result, pattern, label) {
  assert.equal(result?.block, true, `${label}: expected block, got ${JSON.stringify(result)}`);
  assert.match(
    result?.reason || "",
    /\[Local-Test Gate\]/,
    `${label}: reason must be prefixed [Local-Test Gate]. Got: ${JSON.stringify(result)}`
  );
  if (pattern) {
    assert.match(
      result?.reason || "",
      pattern,
      `${label}: reason must name the unmet evidence form. Got: ${result?.reason}`
    );
  }
}

function assertLocalTestGateAllows(result, label) {
  assert.equal(result?.block, undefined, `${label}: expected no block, got ${JSON.stringify(result)}`);
}

// ── Negative #1-2: FinalEvidenceRecord bound to the wrong change/head ──────

test("Local-Test Gate: T4b-1 — FinalEvidenceRecord present only for a different change → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: "some-other-change",
    headSha,
  });
  const result = callLocalTestGateDirect("gh pr merge 5001 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: head-bound FinalEvidenceRecord is unreadable or unsafe: ENOENT/,
    "T4b-1",
  );
});

test("Local-Test Gate: T4b-2a — FinalEvidenceRecord bound to an unrelated head → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha: "9".repeat(40),
  });
  const result = callLocalTestGateDirect("gh pr merge 5002 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: head-bound FinalEvidenceRecord is unreadable or unsafe: ENOENT/,
    "T4b-2a",
  );
});

test("Local-Test Gate: T4b-2b — FinalEvidenceRecord bound to an ancestor followed by a bookkeeping commit does not tip-move forward → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupBookkeepingTipMoveRepo(branch, PROVE_IT_CHANGE_ID);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(dir, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha: commitA,
  });
  const result = callLocalTestGateDirect("gh pr merge 5003 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: head-bound FinalEvidenceRecord is unreadable or unsafe: ENOENT/,
    "T4b-2b",
  );
});

// ── Negative #3-6: invalid record content ───────────────────────────────

test("Local-Test Gate: T4b-3 — FinalEvidenceRecord result !== pass → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const payload = { ...buildFinalEvidencePayload({ changeId: PROVE_IT_CHANGE_ID, headSha }), result: "fail" };
  const record = buildFinalEvidenceRecordFixture({ overridePayload: payload });
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    record,
  });
  const result = callLocalTestGateDirect("gh pr merge 5004 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: invalid final suite authority/,
    "T4b-3",
  );
});

test("Local-Test Gate: T4b-4 — FinalEvidenceRecord failed !== 0 → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const payload = buildFinalEvidencePayload({ changeId: PROVE_IT_CHANGE_ID, headSha, tests: 2, passed: 1, failed: 1 });
  const record = buildFinalEvidenceRecordFixture({ overridePayload: payload });
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    record,
  });
  const result = callLocalTestGateDirect("gh pr merge 5005 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: final suite counts do not represent a complete pass/,
    "T4b-4",
  );
});

test("Local-Test Gate: T4b-5 — FinalEvidenceRecord record_digest_sha256 mismatch → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    overrideRecordDigestSha256: "0".repeat(64),
  });
  const result = callLocalTestGateDirect("gh pr merge 5006 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: FinalEvidenceRecord digest mismatch/,
    "T4b-5",
  );
});

test("Local-Test Gate: T4b-6 — FinalEvidenceRecord unknown schema → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const validRecord = buildFinalEvidenceRecordFixture({ changeId: PROVE_IT_CHANGE_ID, headSha });
  const record = { ...validRecord, schema: "devpro.review-remediation.final-evidence/v0-wrong" };
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    record,
  });
  const result = callLocalTestGateDirect("gh pr merge 5007 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: unknown FinalEvidenceRecord schema/,
    "T4b-6",
  );
});

// ── Negative #7-8: symlinked notes root / record file ───────────────────

test("Local-Test Gate: T4b-7 — notes root is a symlink → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const elsewhere = path.join(tmpRoot, `t4b-elsewhere-${repoCounter++}`);
  mkdirSync(elsewhere, { recursive: true });
  // A digest-VALID record for the PR head, placed directly in the symlink
  // TARGET (F-r1-2): if notes-root symlink rejection were ever removed, the
  // verifier would find and successfully read this record through the
  // symlink (satisfied: true, no block) instead of failing for an unrelated
  // reason such as a missing file — so ONLY symlink rejection can cause this
  // test to still block.
  writeFinalEvidenceRecordFixture({ notesRoot: elsewhere, changeId: PROVE_IT_CHANGE_ID, headSha });
  symlinkSync(elsewhere, path.join(repo, "notes"));
  const result = callLocalTestGateDirect("gh pr merge 5008 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: derived main notes root cannot be a symlink/,
    "T4b-7",
  );
});

test("Local-Test Gate: T4b-8 — FinalEvidenceRecord file itself is a symlink → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const { targetPath } = writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
  });
  const decoyPath = `${targetPath}.decoy`;
  renameSync(targetPath, decoyPath);
  symlinkSync(decoyPath, targetPath);
  const result = callLocalTestGateDirect("gh pr merge 5009 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: head-bound FinalEvidenceRecord is unreadable or unsafe: target-not-regular-file/,
    "T4b-8",
  );
});

// ── Negative #9-12: tip-move delta outside the R6 bookkeeping allowlist ──

test("Local-Test Gate: T4b-9 — tip-move delta includes openspec/specs/** promotion → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupTwoCommitRepo(
    branch,
    "openspec/specs/example-capability/spec.md",
    "# spec\n"
  );
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5010 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /openspec\/specs\/example-capability\/spec\.md/, "T4b-9");
  // Spec "Tip-move delta outside the bookkeeping allowlist blocks merge" THEN:
  // the reason MUST name the tested sha. Only the form-(2) line carries it
  // (review r5 F-r5-1), so anchor the check there rather than on the whole text.
  const formTwoLine = (result.reason.split("\n").find((line) => line.startsWith("(2) 未滿足：")) || "");
  assert.ok(formTwoLine.includes(commitA), `T4b-9: (2) line must name tested sha ${commitA}. Got: ${formTwoLine}`);
});

test("Local-Test Gate: T4b-10 — tip-move delta includes .devpro/scripts/** → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupTwoCommitRepo(branch, ".devpro/scripts/example.mjs", "export const y = 1;\n");
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5011 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /\.devpro\/scripts\/example\.mjs/, "T4b-10");
});

test("Local-Test Gate: T4b-11 — tip-move delta includes a test file → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupTwoCommitRepo(branch, "src/example.test.mjs", "test('x', () => {});\n");
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5012 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /src\/example\.test\.mjs/, "T4b-11");
});

test("Local-Test Gate: T4b-12 — tip-move delta includes a SKILL.md → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupTwoCommitRepo(
    branch,
    ".devpro/agent-skills/dp-example/SKILL.md",
    "# dp-example\n"
  );
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5013 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /\.devpro\/agent-skills\/dp-example\/SKILL\.md/, "T4b-12");
});

// ── Negative #13-16: receipt/mapping edge cases ─────────────────────────

test("Local-Test Gate: T4b-13 — receipt names a tested sha that is not an ancestor of PR head → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const written = writeLocalTestReceipt({
    cwd: repo,
    change: PROVE_IT_CHANGE_ID,
    headSha: "7".repeat(40),
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5014 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /kind=stale/, "T4b-13");
});

test("Local-Test Gate: T4b-14 — only an ancestor receipt for a DIFFERENT change exists → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const { dir, commitA, commitB } = setupBookkeepingTipMoveRepo(branch, PROVE_IT_CHANGE_ID);
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: "some-other-change",
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5015 --merge", dir, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /kind=missing/, "T4b-14");
});

// T4b-15 pair (review r4 F-r4-2): the fixture carries BOTH a valid ancestor
// bookkeeping tip-move receipt and a valid head-bound FinalEvidenceRecord for
// PROVE_IT_CHANGE_ID, so the spec's "even if a tip-move receipt or a
// FinalEvidenceRecord exists for some change" clause is actually exercised.
// The control proves that evidence is acceptable once the branch maps; the
// unmapped run can then only block because the change-keyed forms fail closed.
function t4b15EvidenceRepo() {
  const { dir, commitA, commitB } = setupBookkeepingTipMoveRepo(`bugfix/${PROVE_IT_CHANGE_ID}`, PROVE_IT_CHANGE_ID);
  const written = writeLocalTestReceipt({
    cwd: dir,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(dir, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha: commitB,
  });
  return { dir, commitB };
}

test("Local-Test Gate: T4b-15 control — the same tip-move receipt and FinalEvidenceRecord pass when the branch maps", () => {
  const { dir, commitB } = t4b15EvidenceRepo();
  const result = callLocalTestGateDirect("gh pr merge 5016 --merge", dir, {
    headRefOid: commitB,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assert.equal(result, null, `T4b-15 control must not block: ${JSON.stringify(result)}`);
});

test("Local-Test Gate: T4b-15 — PR headRefName has no recognized branch prefix → forms (2)/(3) fail closed even with valid evidence → block", () => {
  const { dir, commitB } = t4b15EvidenceRepo();
  const result = callLocalTestGateDirect("gh pr merge 5016 --merge", dir, {
    headRefOid: commitB,
    headRefName: "not-a-branch-with-slash",
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /無法由 headRefName 對應 change/, "T4b-15");
});

test("Local-Test Gate: T4b-16 — mapped change's exact-head receipt lacks suite_evidence; tip-move form does not accept kind: current → block", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const repo = setupRepo(branch, { withCommit: true });
  const headSha = t4bHeadSha(repo);
  const recordPath = regressionHeadRecordPath({ cwd: repo, change: PROVE_IT_CHANGE_ID });
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(
    recordPath,
    `${JSON.stringify(
      { change: PROVE_IT_CHANGE_ID, branch, head_sha: headSha, recorded_at: new Date().toISOString() },
      null,
      2
    )}\n`
  );
  const result = callLocalTestGateDirect("gh pr merge 5017 --merge", repo, {
    headRefOid: headSha,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(result, /kind: current/, "T4b-16");
});

// ── Negative #17: verifier process failure via hook (in-process deps seam) ──

// T4b-17a pair (review r1 F-r1-2 follow-through): the record is a DIGEST-VALID,
// manifest-heavy FinalEvidenceRecord (many parsed objects, ~20 MiB), so the
// only thing that differs between the control and the tiny-heap run is the
// injected heap cap. The control proves the record itself is acceptable; the
// tiny-heap run can then only block because the child process died (heap
// exhaustion surfaces as a signal or a non-zero exit, never as a strict
// rejection verdict naming a record defect).
function t4b17aWriteHeavyRecord(repo, headSha) {
  const { record } = buildManifestHeavyRecordFixture({
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    targetBytes: 20 * 1024 * 1024,
  });
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    record,
  });
}

test("Local-Test Gate: T4b-17a control — the same manifest-heavy valid record passes with the production budget", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  t4b17aWriteHeavyRecord(repo, headSha);
  const result = callLocalTestGateDirect(
    "gh pr merge 5018 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
  );
  assert.equal(result, null, `T4b-17a control must not block: ${JSON.stringify(result)}`);
});

test("Local-Test Gate: T4b-17a — verifier fails via injected tiny heap + manifest-heavy valid record → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  t4b17aWriteHeavyRecord(repo, headSha);
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5018 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { budget: { ...FINAL_EVIDENCE_VERIFIER_BUDGET, heapMiB: 16 } } }
  );
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier process (被訊號終止|以非 0 結束)/,
    "T4b-17a",
  );
});

test("Local-Test Gate: T4b-17b — verifier fails via injected timeoutMs: 1 → block, reason names the timeout", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
  });
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5019 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { budget: { ...FINAL_EVIDENCE_VERIFIER_BUDGET, timeoutMs: 1 } } }
  );
  assertLocalTestGateBlocks(result, /逾時/, "T4b-17b");
});

test("Local-Test Gate: T4b-17c — verifier child exits non-zero without a strict rejection line → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const entry = writeFakeChildScript("process.exitCode = 3;\n");
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5020 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { entry } }
  );
  assertLocalTestGateBlocks(result, /非 0 結束/, "T4b-17c");
});

test("Local-Test Gate: T4b-17d — verifier child prints malformed stdout → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const entry = writeFakeChildScript('process.stdout.write("not json\\n"); process.exitCode = 0;\n');
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5021 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { entry } }
  );
  assertLocalTestGateBlocks(result, /輸出格式不符/, "T4b-17d");
});

test("Local-Test Gate: T4b-17e — verifier child output exceeds the output cap → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const entry = writeFakeChildScript('process.stdout.write("x".repeat(200000) + "\\n");\n');
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5022 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { entry, budget: { ...FINAL_EVIDENCE_VERIFIER_BUDGET, maxOutputBytes: 1024 } } }
  );
  assertLocalTestGateBlocks(result, /輸出超過上限/, "T4b-17e");
});

test("Local-Test Gate: T4b-17f — verifier child is terminated by a signal → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const entry = writeFakeChildScript("process.kill(process.pid, 'SIGKILL');\n");
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5023 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { entry } }
  );
  assertLocalTestGateBlocks(
    result,
    process.platform === "win32" ? /verifier process 以非 0 結束/ : /訊號終止/,
    "T4b-17f",
  );
});

test("Local-Test Gate: T4b-17g — verifier child prints a verdict echoing a different change/head → block", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const entry = writeFakeChildScript(
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({
        schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
        ok: true,
        change_id: "some-other-change",
        head_sha: headSha,
        record_digest_sha256: "a".repeat(64),
      })
    )} + "\\n");\nprocess.exitCode = 0;\n`
  );
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5024 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { entry } }
  );
  assertLocalTestGateBlocks(result, /輸出格式不符/, "T4b-17g");
});

// ── Negative #18: over the verifier byte budget ─────────────────────────

test("Local-Test Gate: T4b-18 — FinalEvidenceRecord exceeds the verifier byte budget → block, reason names the budget and the exact-head remediation", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const notesRoot = path.join(repo, "notes");
  mkdirSync(notesRoot, { recursive: true });
  const targetPath = path.join(notesRoot, `review-${PROVE_IT_CHANGE_ID}-final-evidence-${headSha}.json`);
  const fd = openSync(targetPath, "w");
  ftruncateSync(fd, 2048);
  closeSync(fd);
  const result = callLocalTestGateDirectWithDeps(
    "gh pr merge 5025 --merge",
    repo,
    { headRefOid: headSha, headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`, diffFiles: T4B_CODE_DIFF },
    { finalEvidenceVerifier: { budget: { ...FINAL_EVIDENCE_VERIFIER_BUDGET, maxRecordBytes: 1024 } } }
  );
  assertLocalTestGateBlocks(result, /verifier byte budget/, "T4b-18");
  assert.match(result.reason, /node \.devpro\/scripts\/run-test-suite\.mjs --changed main/, "T4b-18: must name exact-head remediation");
  assert.match(result.reason, /record-regression-head\.mjs/, "T4b-18: must name exact-head remediation");
});

// ── Positive #19-21 ──────────────────────────────────────────────────────

test("Local-Test Gate: T4b-19 — branch cannot be mapped to a change, but an exact-head receipt exists → not blocked", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const written = writeLocalTestReceipt({
    cwd: repo,
    change: PROVE_IT_CHANGE_ID,
    headSha,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);
  const result = callLocalTestGateDirect("gh pr merge 5026 --merge", repo, {
    headRefOid: headSha,
    headRefName: "release/v6.99.0",
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateAllows(result, "T4b-19");
});

test("Local-Test Gate: T4b-20 — hook baseCwd is a linked worktree B; FinalEvidenceRecord lives in the shared main-checkout notes/ → not blocked", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const repo = setupRepo("main", { withCommit: true });
  const wt = path.join(tmpRoot, `wt-t4b-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "-b", branch, wt, "HEAD"], { cwd: repo, stdio: "ignore" });
  const headSha = t4bHeadSha(wt);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
  });
  const result = callLocalTestGateDirect("gh pr merge 5027 --merge", wt, {
    headRefOid: headSha,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateAllows(result, "T4b-20");
});

test("Local-Test Gate: T4b-21 — bookkeeping tip-move receipt written from linked worktree A, hook baseCwd is a separate linked worktree B → not blocked", () => {
  const branch = `bugfix/${PROVE_IT_CHANGE_ID}`;
  const repo = setupRepo("main", { withCommit: true });
  const wtA = path.join(tmpRoot, `wtA-t4b-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "-b", branch, wtA, "HEAD"], { cwd: repo, stdio: "ignore" });

  writeFileSync(path.join(wtA, "src.mjs"), "export const x = 1;\n");
  spawnSync("git", ["add", "-A"], { cwd: wtA });
  spawnSync("git", ["commit", "-q", "-m", "commit A: code"], { cwd: wtA });
  const commitA = t4bHeadSha(wtA);

  mkdirSync(path.join(wtA, "openspec", "changes", PROVE_IT_CHANGE_ID), { recursive: true });
  writeFileSync(path.join(wtA, "openspec", "changes", PROVE_IT_CHANGE_ID, "tasks.md"), "# tasks\n- [x] done\n");
  spawnSync("git", ["add", "-A"], { cwd: wtA });
  spawnSync("git", ["commit", "-q", "-m", "commit B: bookkeeping tip-move"], { cwd: wtA });
  const commitB = t4bHeadSha(wtA);

  const written = writeLocalTestReceipt({
    cwd: wtA,
    change: PROVE_IT_CHANGE_ID,
    headSha: commitA,
    suiteEvidence: LOCAL_TEST_PASS_SUITE,
  });
  assert.equal(written.status, "written", written.reason);

  const wtB = path.join(tmpRoot, `wtB-t4b-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "--detach", wtB, commitB], { cwd: repo, stdio: "ignore" });

  const result = callLocalTestGateDirect("gh pr merge 5028 --merge", wtB, {
    headRefOid: commitB,
    headRefName: branch,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateAllows(result, "T4b-21");
});

// fix-merge-gate-regression-currency remediation F-r1-1 (optional hook-layer
// pin): a digest-valid FinalEvidenceRecord built for a DIFFERENT head, then
// renamed onto the PR head's own filename, must block via the core
// `verifyHeadBoundFinalEvidence` head-mismatch predicate specifically — not
// via a missing-record ENOENT (which a naive "wrong filename" fixture would
// exercise instead).
test("Local-Test Gate: T4b-22 — a digest-valid FinalEvidenceRecord for another head, renamed onto the PR head's filename → block on head mismatch", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const otherHeadSha = "9".repeat(40);
  const record = buildFinalEvidenceRecordFixture({ changeId: PROVE_IT_CHANGE_ID, headSha: otherHeadSha });
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha, // filename keyed on the PR head, payload's own head_sha disagrees
    record,
  });
  const result = callLocalTestGateDirect("gh pr merge 5029 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: head-bound FinalEvidenceRecord head mismatch/,
    "T4b-22",
  );
});

// Scenario: Consumer not-applicable FinalEvidenceRecord does not satisfy the FinalEvidenceRecord form
test("Local-Test Gate: T4b-23 — a valid consumer not-applicable FinalEvidenceRecord does not satisfy form (3) → block on pass-only, no profile determination at merge", () => {
  const repo = t4bRepo();
  const headSha = t4bHeadSha(repo);
  const record = buildFinalEvidenceRecordFixture({
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    result: "not-applicable-consumer-profile",
  });
  assert.equal(record.payload.result, "not-applicable-consumer-profile");
  assert.deepEqual([record.payload.tests, record.payload.passed, record.payload.failed], [null, null, null]);
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo, "notes"),
    changeId: PROVE_IT_CHANGE_ID,
    headSha,
    record,
  });
  const result = callLocalTestGateDirect("gh pr merge 5030 --merge", repo, {
    headRefOid: headSha,
    headRefName: `bugfix/${PROVE_IT_CHANGE_ID}`,
    diffFiles: T4B_CODE_DIFF,
  });
  assertLocalTestGateBlocks(
    result,
    /\(3\) 未滿足：verifier 拒絕該紀錄（record-rejected: head-bound FinalEvidenceRecord suite result is not pass/,
    "T4b-23",
  );
  assert.match(result.reason, /record-rejected/);
  assert.match(result.reason, /suite result is not pass/);
  assert.doesNotMatch(result.reason, /does not match the repository profile determination/);
  assert.doesNotMatch(result.reason, /invalid final suite authority/);
  assert.doesNotMatch(result.reason, /must not carry counts/);
});

// ── Scope change 1 (R18): V4 reads AGENTS.md from the checkout the git tag itself runs in ──
//
// main worktree 6.66.4 (payload cwd), production worktree 6.66.5. The gate runner's first git/gh position and the
// position of `git tag` can differ: `git -C` belongs to the command it is written on, a `cd` moves every later command.
test("Scenario: The production tag gate reads AGENTS.md from the checkout of the tag command (through the hook)", () => {
  const { mainDir, prodDir } = setupMainAndProdWorktree("6.66.4", "6.66.5");
  // [label, command, whether V4 must block]. The session checkout is mainDir (6.66.4).
  const cases = [
    // The tag runs in the session checkout (6.66.4) although the first git command read the production worktree.
    ["git -C into the production worktree does not move the tag; version matches the session checkout", `git -C ${prodDir} status && git tag production-v6.66.4`, false],
    ["git -C into the production worktree does not move the tag; version differs from the session checkout", `git -C ${prodDir} status && git tag production-v6.66.5`, true],
    // The cd comes after the first git command and moves the tag into the production worktree (6.66.5).
    ["a cd after the first git command moves the tag; version matches that worktree", `git fetch && cd ${prodDir} && git tag production-v6.66.5`, false],
    ["a cd after the first git command moves the tag; version differs from that worktree", `git fetch && cd ${prodDir} && git tag production-v6.66.4`, true],
    // A cd target that cannot be resolved statically keeps the previous resolution (effectiveCwd, then baseCwd = 6.66.4).
    ["an unresolvable cd keeps the payload cwd; version matches it", `cd "$SOME_VAR" && git tag production-v6.66.4`, false],
    ["an unresolvable cd keeps the payload cwd; version differs from it", `cd "$SOME_VAR" && git tag production-v6.66.5`, true],
  ];
  for (const [label, command, shouldBlock] of cases) {
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: mainDir });
    const blocked = r.json?.decision === "block" && /Version-Equality Gate \(V4\)/.test(r.json.reason || "");
    assert.equal(
      blocked,
      shouldBlock,
      `${label}: expected ${shouldBlock ? "a V4 block" : "no V4 block"}, got ${JSON.stringify(r.json)}`
    );
  }
});
