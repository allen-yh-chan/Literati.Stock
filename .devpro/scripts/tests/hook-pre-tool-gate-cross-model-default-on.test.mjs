import "./lib/isolated-control-evidence-state.mjs";
/**
 * hook-pre-tool-gate-cross-model-default-on.test.mjs
 *
 * New test cases for the default-on design (T1/T2) of checkCrossModelMergeGate.
 *
 * Background:
 *   After T1, the gate is DEFAULT-ON — all PRs require cross-model review unless
 *   the PR is explicitly exempted via:
 *     1. Branch-pattern: chore/bump-v*, rules/<source>-v*, release/v<X.Y.Z>,
 *        release/<YYYYMMDD>-<sha7+>, release/rules-<YYYYMMDD>[-n]
 *     2. Diff-shape (chore-A class, D1): PR diff contains NO
 *        openspec/changes/<name>/proposal*.md or proposal-mini.md
 *
 * Test groups:
 *   RE — isSourceRepoReleaseBranchExempt (release/v<X.Y.Z> format strictness)
 *   CR — isConsumerSubsetReleaseBranchExempt (release/<YYYYMMDD>-<sha> format)
 *   RL — isRulesLaneReleaseBranchExempt (release/rules-<YYYYMMDD>[-n])
 *   CA — Chore-A class diff-shape exemption (proposal-absent / proposal-present)
 *   CAF — Chore-A with a foreign change's proposal: only an in-place edit keeps the
 *         exemption (#3333); the own change's proposal and any add / remove / rename
 *         / copy / type-change / unknown status never do
 *   HF — hotfix/* intentionally NOT exempt (branch-pattern excluded per design)
 *   EX — Normal feature branch flows (Path B block / Path F pass)
 *
 * Mock strategy: identical to hook-pre-tool-gate-cross-model-merge.test.mjs.
 *   CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT    — JSON for gh pr view
 *   CROSS_MODEL_MERGE_GATE_MOCK_BRANCH       — current branch name
 *   CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES   — newline-separated changed file list
 *
 * All tests use fictitious PR #9999.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCrossModelMergeGate,
  crossModelExemptionReason,
  isChoreAClassExempt,
  isChoreAProposalEvidence,
  isCrossModelExempt,
  checkCrossModelExemptionNotice,
  checkMergeAdvisories,
  checkLocalTestGateOnMerge,
  _resolveGithubOwnerRepo,
} from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { storedOriginIdentity } from "../hooks/lib/git-utils.mjs";
import { markSourceCheckout } from "./lib/identity-fixtures.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

// ── Setup / teardown ──────────────────────────────────────────────────────

const tmpRoot = makeTempDir("cm-default-on-test-");

// Transcript-shaped payload fixture; merge readiness no longer reads transcript text.
const FAKE_TRANSCRIPT_PATH = path.join(tmpRoot, "fake-transcript.txt");
writeFileSync(FAKE_TRANSCRIPT_PATH, "Totals: 42 passed, 0 failed\n");

// Clean up temp dir after all tests finish (best-effort)
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// ── Constants ─────────────────────────────────────────────────────────────

const MAGIC_MARKER = "<!-- cross-model-second-opinion:sticky -->";
const PR_NUMBER = "9999";
const CURRENT_SHA = "abc1234def5678901234567890abcdef01234567";

// A proposal.md path — presence in diff signals "not chore-A exempt"
const PROPOSAL_PATH = "openspec/changes/test-change/proposal.md";
// A plain file with no proposal — signals chore-A exempt
const README_PATH = "README.md";

for (const headRefName of [
  "chore/bump-v6.99.0",
  "rules/agent-rules-v6.99.0",
  "release/v6.99.0",
  "release/20261007-abc1234",
  "release/rules-20261007-2",
]) {
  test(`HOTPATH: ${headRefName} never fetches changed files for its gate or notice`, () => {
    const trace = path.join(tmpRoot, `hotpath-${headRefName.replaceAll("/", "-")}.jsonl`);
    const r = runHook(`gh pr merge ${PR_NUMBER} --repo example/repo --merge`, {
      ghOutput: buildPrJson({ headRefName }),
      diffFiles: PROPOSAL_PATH,
      extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: trace },
    });
    assert.equal(r.json, null);
    assert.match(r.advisory, /branch-pattern:/);
    const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((entry) => entry.helper), ["_runGhPrView", "_runGhPrView"]);
    assert.ok(calls.every((entry) => entry.repo === "example/repo"));

    const unavailableFiles = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput: buildPrJson({ headRefName }),
      extraEnv: { CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "files API unavailable" },
    });
    assert.equal(unavailableFiles.json, null);
    assert.match(unavailableFiles.advisory, /branch-pattern:/);
  });
}

for (const headRefName of ["feature/add-export", "hotfix/fix-routing", "chore/refactor-comments"]) {
  test(`HOTPATH: ${headRefName} still fails closed when changed files are unavailable`, () => {
    const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
      ghOutput: buildPrJson({ headRefName }),
      extraEnv: { CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "files API unavailable" },
    });
    assert.equal(r.json?.decision, "block");
    assert.match(r.json.reason, /unable to fetch PR changed files.*files API unavailable/s);
    assert.equal(r.advisory, null);
  });
}

test("HOTPATH: unreadable local marker blocks before a branch-pattern exemption", () => {
  const stateDir = path.join(tmpRoot, "unreadable-marker");
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, "pending-post-pr-completion-corrupt.json"), "{");
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: "release/v6.99.0" }),
    extraEnv: {
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "files API unavailable",
    },
  });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /unreadable marker/);
});

test("HOTPATH: a durable clear obligation blocks before a branch-pattern exemption", () => {
  const stateDir = path.join(tmpRoot, "clear-obligation");
  mkdirSync(stateDir);
  const dispatch = "dispatch-11111111-1111-1111-1111-111111111111";
  // A marker of this checkout's PR: an obligation always records the PR's repository slug, and the merge below names
  // no repository, so it is checked for this checkout's (fix-post-pr-state-repo-keys).
  const slug = storedOriginIdentity(process.cwd())?.slug || "";
  writeFileSync(path.join(stateDir, "pending-post-pr-completion-obligation.json"), JSON.stringify({
    prNumber: PR_NUMBER,
    repository_slug: slug,
    head_ref_oid: CURRENT_SHA,
    expected_dispatch_id: dispatch,
    lineage_clear_obligation: {
      schema: "devpro-post-pr-clear-obligation/v1",
      repository_slug: slug,
      pr_number: PR_NUMBER,
      obligation_head_ref_oid: CURRENT_SHA,
      current_dispatch_id: dispatch,
      old_dispatch_id: dispatch,
      first_dispatch_id: dispatch,
      approval_receipt_ids: ["123"],
      attempt_history: [],
      obligation_id: "hotpath-clear-obligation",
      created_at: new Date().toISOString(),
    },
  }));
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: "release/v6.99.0" }),
    extraEnv: {
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "files API unavailable",
    },
  });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /durable clear obligation hotpath-clear-obligation/);
});

test("HOTPATH: production-target restriction precedes a bump branch exemption", () => {
  const prData = JSON.parse(buildPrJson({ headRefName: "chore/bump-v6.99.0" }));
  prData.baseRefName = "production";
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: JSON.stringify(prData),
    extraEnv: { CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "files API unavailable" },
  });
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production/);
  assert.doesNotMatch(r.json.reason, /unable to fetch PR changed files/);
});

// ── Fixture builders ──────────────────────────────────────────────────────

function buildPrJson({ headRefName = "", comments = [], headRefOid = CURRENT_SHA } = {}) {
  return JSON.stringify({
    headRefOid,
    headRefName,
    comments: comments.map((c, i) => ({
      id: c.id || `C_${i}`,
      url: c.url || `https://github.com/example/repo/pull/${PR_NUMBER}#issuecomment-${i}`,
      body: c.body,
    })),
  });
}

function buildStickyBody({ verdict = "PASS", lastReviewedSha = CURRENT_SHA } = {}) {
  return [
    MAGIC_MARKER,
    "## Cross-Model Second Opinion Review",
    "",
    "Some review content here.",
    "",
    `verdict: ${verdict}`,
    `last_reviewed_sha: ${lastReviewedSha}`,
    "dispatch_id: test-default-on-pass",
    "reason: Test fixture confirms the reviewed pull request head is approved.",
    "Rules: v1.0.0 · Tool: Claude Code · Model: claude-test",
  ].join("\n");
}

// Env keys the cross-model merge gate reads from process.env. The in-process
// path sets these before calling the gate and restores them afterwards so a
// shared process.env never leaks mocks across tests.
const CM_MOCK_ENV_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
];

/**
 * In-process fast path: set the gate's env mocks, call checkCrossModelMergeGate
 * directly, then restore env. Returns the same shape as the spawn path so test
 * assertions (r.json?.decision / r.json?.reason) are unchanged:
 *   gate returns null            → pass  → { json: null }
 *   gate returns {block, reason} → block → { json: { decision: "block", reason } }
 *
 * Use runHookSpawn() instead when a test must assert the end-to-end hook
 * contract (process exit code, stdout JSON emission).
 */
function runHook(command, {
  ghOutput = null,
  branch = "feature/test",
  diffFiles = PROPOSAL_PATH,
  extraEnv = {},
} = {}) {
  const saved = {};
  for (const k of CM_MOCK_ENV_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(extraEnv)) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = branch;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = diffFiles;
    if (ghOutput !== null) {
      process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
    } else {
      delete process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT;
    }
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const result = checkCrossModelMergeGate(command, process.cwd());
    const json =
      result && result.block
        ? { decision: "block", reason: result.reason }
        : null;
    // The non-silent exemption notice is emitted by the dedicated advisory gate
    // (checkCrossModelExemptionNotice), NOT by the blocking merge gate. Invoke it
    // under the same env mocks so tests can assert the notice fires while the
    // blocking gate stays silent (null) on exempt PRs.
    const noticeResult = checkCrossModelExemptionNotice(command, process.cwd());
    const advisory =
      noticeResult && noticeResult.advisory ? noticeResult.advisory : null;
    return { code: 0, json, advisory };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * Spawn path (end-to-end). Runs the full hook in a child process so a test can
 * assert the hook contract: always exit 0, decision delivered via stdout JSON.
 */
function runHookSpawn(command, {
  ghOutput = null,
  branch = "feature/test",
  diffFiles = PROPOSAL_PATH,
  transcriptPath = FAKE_TRANSCRIPT_PATH,
  extraEnv = {},
} = {}) {
  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-default-on-"),
    DEVPRO_POSTMERGE_STATE_DIR: makeTempDir("postmerge-don-"),
    DEVPRO_RECAP_PENDING_DIR: makeTempDir("recap-pending-don-"),
    DEVPRO_RECAP_STATE_DIR: makeTempDir("recap-state-don-"),
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: diffFiles,
    ...extraEnv,
  };
  if (ghOutput !== null) {
    env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
  }

  const payload = {
    tool_name: "Bash",
    tool_input: { command },
    transcript_path: transcriptPath,
  };

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });

  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // not JSON — hook exited cleanly without output
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// ── RE: isSourceRepoReleaseBranchExempt ──────────────────────────────────

// RE-1: release/v<X.Y.Z> exact format → isSourceRepoReleaseBranchExempt → pass
// Even with proposal.md in diff (not chore-A exempt), branch-pattern exempt fires first.
test("RE-1: release/v6.50.0 + diff has proposal → pass (isSourceRepoReleaseBranchExempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/v6.50.0",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt; branch-pattern exempt fires
    branch: "release/v6.50.0",
  });
  assert.ok(
    r.json?.decision !== "block",
    `RE-1: release/v6.50.0 should be exempt via isSourceRepoReleaseBranchExempt, got: ${JSON.stringify(r.json)}`
  );
});

// RE-2: release/v6.50.0-rc.1 — pre-release suffix not in canonical format → block
// Regex is strict: ^release\/v\d+\.\d+\.\d+$ — no pre-release suffixes allowed.
test("RE-2: release/v6.50.0-rc.1 (pre-release suffix) + diff has proposal → block (regex strictness)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/v6.50.0-rc.1",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt
    branch: "release/v6.50.0-rc.1",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `RE-2: release/v6.50.0-rc.1 must not match source-repo release exemption, got: ${JSON.stringify(r.json)}`
  );
});

// RE-3: release/v6.50 — two-part version (missing patch) → block
// Regex requires exactly three dot-separated numeric components.
test("RE-3: release/v6.50 (missing patch) + diff has proposal → block (regex strictness)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/v6.50",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt
    branch: "release/v6.50",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `RE-3: release/v6.50 (2-part version) must not be exempt, got: ${JSON.stringify(r.json)}`
  );
});

// ── CR: isConsumerSubsetReleaseBranchExempt ───────────────────────────────

// CR-1: release/<YYYYMMDD>-<sha7+> exact format → isConsumerSubsetReleaseBranchExempt → pass
test("CR-1: release/20260518-abc1234 + diff has proposal → pass (isConsumerSubsetReleaseBranchExempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/20260518-abc1234",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present; branch-pattern exempt fires first
    branch: "release/20260518-abc1234",
  });
  assert.ok(
    r.json?.decision !== "block",
    `CR-1: release/20260518-abc1234 should be exempt via isConsumerSubsetReleaseBranchExempt, got: ${JSON.stringify(r.json)}`
  );
});

// CR-2: release/2026-05-18-abc1234 — date with dashes (not 8-digit contiguous) → block
// Regex requires exactly 8 contiguous digits: \d{8}, not dash-separated YYYY-MM-DD.
test("CR-2: release/2026-05-18-abc1234 (dash-separated date) + diff has proposal → block (regex strictness)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/2026-05-18-abc1234",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt
    branch: "release/2026-05-18-abc1234",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CR-2: release/2026-05-18-abc1234 (ISO date with dashes) must not match consumer release exemption, got: ${JSON.stringify(r.json)}`
  );
});

// ── RL: isRulesLaneReleaseBranchExempt ───────────────────────────────────

// RL-1: release/rules-<YYYYMMDD> base form → isRulesLaneReleaseBranchExempt → pass
test("RL-1: release/rules-20260518 + diff has proposal → pass (isRulesLaneReleaseBranchExempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/rules-20260518",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present; branch-pattern exempt fires first
    branch: "release/rules-20260518",
  });
  assert.ok(
    r.json?.decision !== "block",
    `RL-1: release/rules-20260518 should be exempt via isRulesLaneReleaseBranchExempt, got: ${JSON.stringify(r.json)}`
  );
});

// RL-2: release/rules-<YYYYMMDD>-<n> with -n suffix → also exempt
test("RL-2: release/rules-20260518-2 (-n suffix) + diff has proposal → pass (RL exempt -n variant)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/rules-20260518-2",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present; branch-pattern exempt fires first
    branch: "release/rules-20260518-2",
  });
  assert.ok(
    r.json?.decision !== "block",
    `RL-2: release/rules-20260518-2 (-n suffix) should be exempt, got: ${JSON.stringify(r.json)}`
  );
});

// RL-3: release/rules-2026-05-18 — date with dashes (typo, not 8-digit) → block
test("RL-3: release/rules-2026-05-18 (dash-separated date typo) + diff has proposal → block (regex strictness)", () => {
  const ghOutput = buildPrJson({
    headRefName: "release/rules-2026-05-18",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt
    branch: "release/rules-2026-05-18",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `RL-3: release/rules-2026-05-18 (ISO date typo) must not match rules-lane exemption, got: ${JSON.stringify(r.json)}`
  );
});

// ── CA: Chore-A class diff-shape exemption ────────────────────────────────

// CA-1: chore/* branch + diff only has README.md (no proposal) → chore-A exempt → pass
// This is the canonical "mechanical chore, no design work" signal per D1.
test("CA-1: chore/refactor-comments + diff only has README.md (no proposal) → pass (chore-A exempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/refactor-comments",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: README_PATH,  // no proposal.md → chore-A exempt (D1)
    branch: "chore/refactor-comments",
  });
  assert.ok(
    r.json?.decision !== "block",
    `CA-1: diff with no proposal should be chore-A exempt, got: ${JSON.stringify(r.json)}`
  );
});

// CA-2: Same branch + diff contains proposal.md → NOT chore-A exempt → block (no sticky)
// Demonstrates that chore-A requires both a chore/* branch class and proposal absence.
test("CA-2: chore/refactor-comments + diff has proposal.md → block (not chore-A, Path B)", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/refactor-comments",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    // openspec/changes/refactor-comments/proposal.md is present → not chore-A exempt
    diffFiles: `src/lib/helper.ts\nopenspec/changes/refactor-comments/proposal.md`,
    branch: "chore/refactor-comments",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CA-2: diff with proposal.md must not be chore-A exempt → block at Path B, got: ${JSON.stringify(r.json)}`
  );
});

// CA-3: diff contains proposal-mini.md → also not chore-A exempt → block
// isChoreAClassExempt matches both proposal.md and proposal-mini.md patterns.
test("CA-3: chore/something + diff has proposal-mini.md → block (proposal-mini also not chore-A)", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/something",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    // proposal-mini.md also triggers "not chore-A" per isChoreAClassExempt regex
    diffFiles: `openspec/changes/something/proposal-mini.md`,
    branch: "chore/something",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CA-3: diff with proposal-mini.md must not be chore-A exempt → block at Path B, got: ${JSON.stringify(r.json)}`
  );
});

// CA-4: diff contains ARCHIVED proposal.md (post-/dp:pre-pr Step 3.6 shape) → block
// After `openspec archive`, the proposal moves to
// `openspec/changes/archive/<date>-<name>/proposal.md`. The chore-A regex
// MUST cover this archived path; otherwise the dogfood meta-invariant breaks
// (post-archive PR diff would falsely pass chore-A exemption).
test("CA-4: chore/foo + diff has archived proposal.md → block (archived path covered by chore-A regex)", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/foo",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: `openspec/changes/archive/2026-05-19-foo/proposal.md`,
    branch: "chore/foo",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CA-4: archived proposal.md must NOT be chore-A exempt → block at Path B (dogfood invariant), got: ${JSON.stringify(r.json)}`
  );
});

// CA-5: diff contains ARCHIVED proposal-mini.md → also block (mini path covered)
test("CA-5: chore/foo + diff has archived proposal-mini.md → block (archived mini path covered)", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/foo",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: `openspec/changes/archive/2026-05-19-foo/proposal-mini.md`,
    branch: "chore/foo",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CA-5: archived proposal-mini.md must NOT be chore-A exempt → block at Path B, got: ${JSON.stringify(r.json)}`
  );
});

// CA-6: feature/* with no proposal is missing OpenSpec evidence, not chore-A.
test("CA-6: feature/add-export + diff only has README.md (no proposal) → block (missing OpenSpec, non-exempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "feature/add-export",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: README_PATH,
    branch: "feature/add-export",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CA-6: feature/* no-proposal diff must not be chore-A exempt; missing OpenSpec must block, got: ${JSON.stringify(r.json)}`
  );
});

// CA-7: bugfix/* with no proposal is missing OpenSpec evidence, not chore-A.
test("CA-7: bugfix/fix-routing + diff only has README.md (no proposal) → block (missing OpenSpec, non-exempt)", () => {
  const ghOutput = buildPrJson({
    headRefName: "bugfix/fix-routing",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: README_PATH,
    branch: "bugfix/fix-routing",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `CA-7: bugfix/* no-proposal diff must not be chore-A exempt; missing OpenSpec must block, got: ${JSON.stringify(r.json)}`
  );
});

// ── HF: hotfix/* intentionally NOT in branch-pattern exemptions ───────────

// HF-1: hotfix/<name> + diff has proposal → NOT exempt by branch-pattern (hotfix is high-risk PROD repair).
// No sticky → Path B block.
// NOTE: hotfix is intentionally excluded from branch-pattern exemptions per isCrossModelExempt.
test("HF-1: hotfix/critical-bug + diff has proposal → block (hotfix not in branch-pattern exempt, Path B)", () => {
  const ghOutput = buildPrJson({
    headRefName: "hotfix/critical-bug",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt
    branch: "hotfix/critical-bug",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `HF-1: hotfix/critical-bug with proposal must block (hotfix not exempt, no sticky), got: ${JSON.stringify(r.json)}`
  );
});

// HF-2: hotfix/<name> + diff only has README (chore-A-shape) → still blocks.
// Hotfix override prevents diff-shape exemption from accidentally exempting
// PROD repair PRs that happen to touch only documentation.
test("HF-2: hotfix/critical-bug + diff only has README (chore-A-shape) → block (hotfix override beats chore-A)", () => {
  const ghOutput = buildPrJson({
    headRefName: "hotfix/critical-bug",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: "README.md",  // no proposal — would be chore-A exempt for non-hotfix
    branch: "hotfix/critical-bug",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `HF-2: hotfix override must beat chore-A exemption, got: ${JSON.stringify(r.json)}`
  );
});

// ── EX: Normal feature branch flows (Path B block / Path F pass) ──────────

// EX-1: feature/add-export + diff has proposal + sticky PASS → pass (Path F)
// Demonstrates the normal happy-path for a feature PR with approved review.
test("EX-1: feature/add-export + diff has proposal + sticky PASS → pass (Path F)", () => {
  const stickyBody = buildStickyBody({ verdict: "PASS", lastReviewedSha: CURRENT_SHA });
  const ghOutput = buildPrJson({
    headRefName: "feature/add-export",
    comments: [{ body: stickyBody }],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt → enters sticky check
    branch: "feature/add-export",
  });
  assert.ok(
    r.json?.decision !== "block",
    `EX-1: feature PR with PASS verdict and aligned sha should pass (Path F), got: ${JSON.stringify(r.json)}`
  );
});

// EX-2: feature/add-export + diff has proposal + no sticky → block (Path B)
// Demonstrates the normal block path for a feature PR without any review.
test("EX-2: feature/add-export + diff has proposal + no sticky → block (Path B)", () => {
  const ghOutput = buildPrJson({
    headRefName: "feature/add-export",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH,  // proposal present → not chore-A exempt → Path B block
    branch: "feature/add-export",
  });
  assert.strictEqual(
    r.json?.decision,
    "block",
    `EX-2: feature PR with no sticky must block at Path B, got: ${JSON.stringify(r.json)}`
  );
  assert.match(
    r.json?.reason ?? "",
    /cross-review|dp:cross-review|Path B/i,
    `EX-2: block reason should mention cross-review or Path B, got: ${r.json?.reason}`
  );
});

// ───────────────────────────────────────────────────────────────────────────
// CMX — Cross-model exemption NOTICE (non-silent exemption)
//
// A passing exemption must emit a NON-BLOCKING advisory naming the reason, so
// the user is always told the PR skipped cross-model review (was not second-
// model reviewed) instead of a silent pass. This closes the gap that let an
// at-cap normative-rule edit (chore-A diff-shape) merge unreviewed and unnoticed.
// ───────────────────────────────────────────────────────────────────────────

test("CMX-1: chore-A diff-shape exemption emits advisory (not silent) and does NOT block", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/refactor-comments",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: README_PATH, // no proposal.md → chore-A exempt
    branch: "chore/refactor-comments",
  });
  assert.ok(
    r.json?.decision !== "block",
    `CMX-1: chore-A exemption must not block, got: ${JSON.stringify(r.json)}`
  );
  assert.ok(
    r.advisory,
    "CMX-1: chore-A exemption must emit a non-blocking advisory (not a silent null pass)"
  );
  assert.match(
    r.advisory ?? "",
    /未經第二模型|cross-model/i,
    `CMX-1: advisory must state the PR skipped cross-model review, got: ${r.advisory}`
  );
  assert.match(
    r.advisory ?? "",
    /diff-shape|chore-classification A/i,
    `CMX-1: advisory must name the chore-A diff-shape exemption reason, got: ${r.advisory}`
  );
});

test("CMX-2: branch-pattern exemption (chore/bump-v) also emits advisory naming the reason", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/bump-v6.50.0",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput,
    diffFiles: PROPOSAL_PATH, // proposal present; branch-pattern exempt fires first
    branch: "chore/bump-v6.50.0",
  });
  assert.ok(
    r.json?.decision !== "block",
    `CMX-2: branch-pattern exemption must not block, got: ${JSON.stringify(r.json)}`
  );
  assert.ok(r.advisory, "CMX-2: branch-pattern exemption must emit advisory");
  assert.match(
    r.advisory ?? "",
    /branch-pattern|bump-v/i,
    `CMX-2: advisory must name the branch-pattern exemption reason, got: ${r.advisory}`
  );
});

test("CMX-3: crossModelExemptionReason returns stable labels for each exemption class", () => {
  assert.match(
    crossModelExemptionReason("chore/bump-v6.50.0", ["README.md"], process.cwd()) ?? "",
    /bump-v/,
    "bump branch → bump-v label"
  );
  assert.match(
    crossModelExemptionReason("chore/foo", ["README.md"], process.cwd()) ?? "",
    /diff-shape|chore-classification A/,
    "no-proposal diff → chore-A label"
  );
  assert.strictEqual(
    crossModelExemptionReason("feature/x", [PROPOSAL_PATH], process.cwd()),
    null,
    "non-exempt PR (has proposal, plain branch) → null reason"
  );
  assert.strictEqual(
    crossModelExemptionReason("feature/x", ["README.md"], process.cwd()),
    null,
    "proposal-absent feature PR → null reason because missing OpenSpec is non-exempt"
  );
  assert.strictEqual(
    crossModelExemptionReason("bugfix/x", ["README.md"], process.cwd()),
    null,
    "proposal-absent bugfix PR → null reason because missing OpenSpec is non-exempt"
  );
});

test("CMX-4: hotfix is NOT exempt → reason null (mirrors isCrossModelExempt early-false)", () => {
  assert.strictEqual(
    crossModelExemptionReason("hotfix/urgent", ["README.md"], process.cwd()),
    null,
    "hotfix diff with no proposal must NOT be exempt (high PROD risk) → null reason"
  );
});

// Run checkMergeAdvisories (the composite gh-pr-merge advisory gate) under the
// same env mocks runHook uses, so tests exercise the REAL combine path (not the
// notice fn directly) — this is what the inventory actually invokes.
function runMergeAdvisories(command, { branch, diffFiles, ghOutput }) {
  const saved = {};
  for (const k of CM_MOCK_ENV_KEYS) saved[k] = process.env[k];
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = branch;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES = diffFiles;
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
    return checkMergeAdvisories(command, process.cwd());
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("CMX-5: exempt PR that ALSO touches a .mjs carrier keeps exemption notice; local-test is a separate BLOCK", () => {
  // Regression for the cross-model CRITICAL (PR #1281): runGateInventory is
  // first-truthy-wins, so sibling advisory gates mutually suppress. After
  // enforce-local-test-merge-evidence, local-test left the advisory composite
  // and became state-backed BLOCK (`local-test-merge-evidence`). An exempt PR
  // (no proposal → chore-A) whose diff also touches a code carrier (.mjs) must
  // still surface the non-silent cross-model exemption notice from
  // checkMergeAdvisories, AND independently hard-block for missing fail=0
  // local-test receipt — without either signal eating the other.
  const ghOutput = buildPrJson({
    headRefName: "chore/foo",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const command = `gh pr merge ${PR_NUMBER} --merge`;
  const r = runMergeAdvisories(command, {
    branch: "chore/foo",
    diffFiles: ".devpro/scripts/hooks/pre-tool-gate.mjs", // exempt (no proposal) + .mjs carrier
    ghOutput,
  });
  assert.ok(r?.advisory, "CMX-5: composite advisory must fire");
  assert.match(
    r.advisory,
    /未經第二模型|cross-model/,
    `CMX-5: cross-model exemption notice must be present, got: ${r.advisory}`
  );
  assert.doesNotMatch(
    r.advisory,
    /Local-Test Gate/,
    `CMX-5: local-test MUST NOT remain in the advisory composite, got: ${r.advisory}`
  );

  // Hermetic source-repo fixture (positive source identity) so findAcceptableLocalTestReceipt
  // scans this temp notes/ tree — not the live main-checkout notes/.
  const sourceRepo = path.join(tmpRoot, `cmx5-source-${Date.now()}`);
  mkdirSync(sourceRepo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: sourceRepo });
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: sourceRepo });
  markSourceCheckout(sourceRepo);
  mkdirSync(path.join(sourceRepo, "notes"), { recursive: true });

  const saved = {};
  for (const k of CM_MOCK_ENV_KEYS) saved[k] = process.env[k];
  try {
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_BRANCH = "chore/foo";
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES =
      ".devpro/scripts/hooks/pre-tool-gate.mjs";
    process.env.CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT = ghOutput;
    const local = checkLocalTestGateOnMerge(command, sourceRepo);
    assert.equal(local?.block, true, "CMX-5: local-test evidence gate MUST block");
    assert.match(
      local?.reason || "",
      /Local-Test Gate/,
      `CMX-5: block reason must name Local-Test Gate, got: ${local?.reason}`
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("CMX-6: exempt PR with pure-docs diff surfaces ONLY the exemption notice", () => {
  const ghOutput = buildPrJson({
    headRefName: "chore/foo",
    comments: [],
    headRefOid: CURRENT_SHA,
  });
  const r = runMergeAdvisories(`gh pr merge ${PR_NUMBER} --merge`, {
    branch: "chore/foo",
    diffFiles: README_PATH, // exempt + no code carrier → local-test does not fire
    ghOutput,
  });
  assert.ok(r?.advisory, "CMX-6: exemption notice must fire");
  assert.match(r.advisory, /未經第二模型|cross-model/, "CMX-6: exemption notice present");
  assert.doesNotMatch(
    r.advisory,
    /node --test|Local-Test/,
    `CMX-6: local-test advisory must NOT fire for pure-docs diff, got: ${r.advisory}`
  );
});

test("CMX-7: origin slug resolution keeps dots in the repo name (https, ssh, trailing slash, .git)", () => {
  const cases = [
    ["https://github.com/devpro-tw/devpro-agent-rules.git", "devpro-tw/devpro-agent-rules"],
    ["https://github.com/SinoPac/SinoPac.Cards.Web", "SinoPac/SinoPac.Cards.Web"],
    ["https://github.com/SinoPac/SinoPac.Cards.Web.git", "SinoPac/SinoPac.Cards.Web"],
    ["https://github.com/SinoPac/SinoPac.Cards.Web/", "SinoPac/SinoPac.Cards.Web"],
    ["git@github.com:SinoPac/SinoPac.Cards.Web.git", "SinoPac/SinoPac.Cards.Web"],
  ];
  for (const [url, expected] of cases) {
    const dir = makeTempDir("cm-origin-slug-");
    try {
      for (const args of [["init", "-q"], ["remote", "add", "origin", url]]) {
        const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      }
      assert.equal(_resolveGithubOwnerRepo(dir), expected, `slug for ${url}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── CAF: Chore-A exemption with a foreign change's proposal (#3333) ───────────
//
// A `chore/*` PR that only edits one line of ANOTHER change's existing proposal.md is a
// documentation fix, not new design work, so it keeps the chore-A exemption. The same
// path counts as proposal evidence (not exempt) when it belongs to the branch's own change,
// when its status is anything but an in-place `modified`, when the status is unknown, or
// when the caller supplied no statuses at all (fail closed, same as before #3333).

const CAF_BRANCH = "chore/fix-release-date";
const CAF_FOREIGN = "openspec/changes/some-other-change/proposal.md";
const CAF_FOREIGN_MINI = "openspec/changes/some-other-change/proposal-mini.md";
const CAF_FOREIGN_ARCHIVED = "openspec/changes/archive/2026-09-01-some-other-change/proposal.md";
const CAF_OWN_ACTIVE = "openspec/changes/fix-release-date/proposal.md";
const CAF_OWN_MINI = "openspec/changes/fix-release-date/proposal-mini.md";
const CAF_OWN_ARCHIVED = "openspec/changes/archive/2026-10-20-fix-release-date/proposal.md";
const CAF_UNDATED_ARCHIVE = "openspec/changes/archive/some-other-change/proposal.md";

const cafStatuses = (entries) => new Map(entries);

// [label, branch, files, statuses, expectedExempt]
const CAF_CASES = [
  ["foreign proposal modified in place", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "modified"]]), true],
  ["foreign proposal-mini modified in place", CAF_BRANCH, [CAF_FOREIGN_MINI], cafStatuses([[CAF_FOREIGN_MINI, "modified"]]), true],
  ["foreign archived proposal modified in place", CAF_BRANCH, [CAF_FOREIGN_ARCHIVED], cafStatuses([[CAF_FOREIGN_ARCHIVED, "modified"]]), true],
  [
    "foreign proposal modified alongside a plain doc",
    CAF_BRANCH,
    [README_PATH, CAF_FOREIGN],
    cafStatuses([[README_PATH, "modified"], [CAF_FOREIGN, "modified"]]),
    true,
  ],
  ["own active proposal modified", CAF_BRANCH, [CAF_OWN_ACTIVE], cafStatuses([[CAF_OWN_ACTIVE, "modified"]]), false],
  ["own proposal-mini modified", CAF_BRANCH, [CAF_OWN_MINI], cafStatuses([[CAF_OWN_MINI, "modified"]]), false],
  ["own archived proposal modified", CAF_BRANCH, [CAF_OWN_ARCHIVED], cafStatuses([[CAF_OWN_ARCHIVED, "modified"]]), false],
  ["foreign proposal added", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "added"]]), false],
  ["foreign proposal removed", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "removed"]]), false],
  ["foreign proposal renamed into place", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "renamed"]]), false],
  ["foreign proposal copied into place", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "copied"]]), false],
  ["foreign proposal type-changed", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "changed"]]), false],
  ["foreign proposal with an unknown status", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "unknown"]]), false],
  ["foreign proposal with no statuses supplied", CAF_BRANCH, [CAF_FOREIGN], undefined, false],
  ["foreign proposal with a non-Map statuses argument", CAF_BRANCH, [CAF_FOREIGN], { [CAF_FOREIGN]: "modified" }, false],
  ["foreign proposal missing from a supplied Map", CAF_BRANCH, [CAF_FOREIGN], cafStatuses([[README_PATH, "modified"]]), false],
  ["undated archive folder (owner unknown) modified", CAF_BRANCH, [CAF_UNDATED_ARCHIVE], cafStatuses([[CAF_UNDATED_ARCHIVE, "modified"]]), false],
  [
    "foreign modified next to a foreign added",
    CAF_BRANCH,
    [CAF_FOREIGN, CAF_FOREIGN_MINI],
    cafStatuses([[CAF_FOREIGN, "modified"], [CAF_FOREIGN_MINI, "added"]]),
    false,
  ],
  [
    "foreign modified next to the own proposal",
    CAF_BRANCH,
    [CAF_FOREIGN, CAF_OWN_ACTIVE],
    cafStatuses([[CAF_FOREIGN, "modified"], [CAF_OWN_ACTIVE, "modified"]]),
    false,
  ],
  [
    "proposal renamed away to a non-proposal path (source recorded as removed)",
    CAF_BRANCH,
    ["docs/moved.md", CAF_FOREIGN],
    cafStatuses([["docs/moved.md", "renamed"], [CAF_FOREIGN, "removed"]]),
    false,
  ],
  ["no proposal path at all, statuses supplied", CAF_BRANCH, [README_PATH], cafStatuses([[README_PATH, "modified"]]), true],
  ["feature branch ignores a foreign modified proposal", "feature/fix-release-date", [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "modified"]]), false],
  ["bugfix branch ignores a foreign modified proposal", "bugfix/fix-release-date", [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "modified"]]), false],
  ["hotfix branch ignores a foreign modified proposal", "hotfix/fix-release-date", [CAF_FOREIGN], cafStatuses([[CAF_FOREIGN, "modified"]]), false],
];

for (const [label, branch, files, statuses, expected] of CAF_CASES) {
  test(`CAF: ${label} -> isChoreAClassExempt=${expected}`, () => {
    assert.equal(isChoreAClassExempt(branch, files, statuses), expected);
  });
}

for (const [label, branch, files, statuses, expected] of CAF_CASES) {
  test(`CAF: ${label} -> isCrossModelExempt agrees with crossModelExemptionReason`, () => {
    const exempt = isCrossModelExempt(branch, files, process.cwd(), statuses);
    const reason = crossModelExemptionReason(branch, files, process.cwd(), statuses);
    // Hotfix is never exempt; the other branches reduce to the chore-A answer above.
    assert.equal(exempt, branch.startsWith("hotfix/") ? false : expected);
    assert.equal(exempt, reason !== null, "twin exemption functions must not drift");
    if (exempt) {
      assert.match(reason, /chore\/ 前綴車道/);
      assert.match(reason, /本 change proposal/);
    }
  });
}

test("CAF: omitting statuses keeps the exact pre-#3333 answer for a plain proposal path", () => {
  assert.equal(isChoreAClassExempt(CAF_BRANCH, [README_PATH]), true);
  assert.equal(isChoreAClassExempt(CAF_BRANCH, [CAF_FOREIGN]), false);
  assert.equal(isChoreAClassExempt(CAF_BRANCH, [CAF_OWN_ACTIVE]), false);
  assert.equal(isChoreAClassExempt(CAF_BRANCH, "not-an-array"), false);
});

test("CAF: the exemption label names the narrowed rule", () => {
  const reason = crossModelExemptionReason(
    CAF_BRANCH,
    [CAF_FOREIGN],
    process.cwd(),
    cafStatuses([[CAF_FOREIGN, "modified"]])
  );
  assert.match(reason, /他 change 僅 in-place 修改/);
});

test("CAF: isChoreAProposalEvidence decides one path at a time", () => {
  const modified = "modified";
  // Not a proposal path: never evidence, whatever the status.
  assert.equal(isChoreAProposalEvidence(CAF_BRANCH, README_PATH, "added"), false);
  assert.equal(isChoreAProposalEvidence(CAF_BRANCH, README_PATH, undefined), false);
  // Foreign + in-place modified is the only non-evidence proposal shape.
  assert.equal(isChoreAProposalEvidence(CAF_BRANCH, CAF_FOREIGN, modified), false);
  for (const status of ["added", "removed", "renamed", "copied", "changed", "unknown", undefined, null, ""]) {
    assert.equal(isChoreAProposalEvidence(CAF_BRANCH, CAF_FOREIGN, status), true, `foreign ${status}`);
  }
  // The branch's own change is evidence even when only modified, active or archived.
  for (const own of [CAF_OWN_ACTIVE, CAF_OWN_MINI, CAF_OWN_ARCHIVED]) {
    assert.equal(isChoreAProposalEvidence(CAF_BRANCH, own, modified), true, own);
  }
  // Owner unknown (undated archive) is evidence.
  assert.equal(isChoreAProposalEvidence(CAF_BRANCH, CAF_UNDATED_ARCHIVE, modified), true);
});

// Hook-level: the merge gate reads `<status>\t<path>` mock lines and applies the same rule.
test("CAF-H1: merge gate passes a chore PR that only modifies a foreign proposal, with the exemption notice", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: CAF_BRANCH }),
    diffFiles: `modified\t${CAF_FOREIGN}`,
    branch: CAF_BRANCH,
  });
  assert.equal(r.json, null, `CAF-H1: expected no block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.advisory ?? "", /chore\/ 前綴車道/);
});

test("CAF-H2: merge gate blocks a chore PR that adds a foreign proposal", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: CAF_BRANCH }),
    diffFiles: `added\t${CAF_FOREIGN}`,
    branch: CAF_BRANCH,
  });
  assert.equal(r.json?.decision, "block");
});

test("CAF-H3: merge gate blocks a chore PR that modifies its OWN change's proposal", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: CAF_BRANCH }),
    diffFiles: `modified\t${CAF_OWN_ACTIVE}`,
    branch: CAF_BRANCH,
  });
  assert.equal(r.json?.decision, "block");
});

test("CAF-H4: a status-less mock line is unknown, so a foreign proposal still blocks (fail closed)", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: CAF_BRANCH }),
    diffFiles: CAF_FOREIGN,
    branch: CAF_BRANCH,
  });
  assert.equal(r.json?.decision, "block");
});

test("CAF-H5: a renamed proposal blocks even when the new path is not a proposal path", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: CAF_BRANCH }),
    diffFiles: `renamed\tdocs/moved.md\t${CAF_FOREIGN}`,
    branch: CAF_BRANCH,
  });
  assert.equal(r.json?.decision, "block");
});

test("CAF-H6: a hotfix PR that only modifies a foreign proposal is still not exempt", () => {
  const r = runHook(`gh pr merge ${PR_NUMBER} --merge`, {
    ghOutput: buildPrJson({ headRefName: "hotfix/fix-release-date" }),
    diffFiles: `modified\t${CAF_FOREIGN}`,
    branch: "hotfix/fix-release-date",
  });
  assert.equal(r.json?.decision, "block");
});
