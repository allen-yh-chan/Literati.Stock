// T6 (design.md D6, R6/R13): external-evaluator marker disposition —
// clear_policy | clear_verified | retain, and the Blocked-message next-action
// split (design audit r2 F-dg-r2-01). A companion file
// (hook-post-pr-completion-external-callsite-registry.test.mjs) locks the
// exhaustive per-callsite reachability claim; this file is behavioral.
//
// `writePostPrCompletionMarker` now accepts `executorKind` natively (T3,
// landed in this worktree) — fixtures here call it directly instead of the
// earlier post-write JSON patch. EXT-DISPOSITION-0 below pins that the two
// shapes are byte-identical, so the earlier "patch after write" fixtures this
// change replaces are not silently exercising a different marker shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareAndSwapPostPrCompletionExpectedDispatch,
  compareAndSwapPostPrCompletionHeadBinding,
  writePostPrCompletionMarker,
} from "../hooks/lib/post-pr-completion-state.mjs";
import { reviewRoundSidecarPath } from "../hooks/lib/review-round-budget.mjs";
import { appendChangeUsageOverride } from "../hooks/lib/change-usage-checkpoint.mjs";
import {
  SECOND_REVIEW_STICKY_MARKER,
  SECOND_REVIEW_STICKY_MOCK_PROVENANCE,
} from "../hooks/lib/second-review-sticky-authority.mjs";
import { sha256Hex } from "../lib/primitives.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";


// These gate fixtures explicitly own their PRs. Existing gate assertions read
// the full scoped diagnostic; the isolation suite asserts the compact transport.
process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;
process.env.DEVPRO_AGENT_RULES_LEVEL = "full";

const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const CONTROL_EVIDENCE_HELPER = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");
const tmpRoot = makeTempDir("post-pr-external-disposition-");
const noGitCwd = tmpRoot;
let counter = 0;

function makeStateDir() {
  const dir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runStop(cwd, stateDir, extraEnv = {}) {
  return spawnSync("node", [STOP_HOOK], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
      DEVPRO_POST_PR_SKIPPED_CLEANUP_PROBE_STATE_DIR: path.join(stateDir, "skipped-cleanup-probe"),
      DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR: path.join(stateDir, "cost-usage-cache"),
      DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: path.join(stateDir, "cost-breaker-reminder"),
      ...extraEnv,
    },
  });
}

// Writes a marker via the real production helper's native `executorKind`.
function writeExternalMarker(stateDir, input) {
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  let file;
  try {
    file = writePostPrCompletionMarker({ ...input, executorKind: "external-evaluator" });
  } finally {
    if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(file, old, old);
  return file;
}

// Same helper as writeExternalMarker, but patches `executor_kind` onto the
// marker JSON AFTER a plain (no executorKind) write — the shape this file's
// fixtures used before T3 landed the native parameter.
function writeExternalMarkerByPostPatch(stateDir, input) {
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  let file;
  try {
    file = writePostPrCompletionMarker(input);
  } finally {
    if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.executor_kind = "external-evaluator";
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function loadControlEvidenceHelper() {
  assert.equal(existsSync(CONTROL_EVIDENCE_HELPER), true, "control-evidence helper must exist");
  return import(`${pathToFileURL(CONTROL_EVIDENCE_HELPER).href}?ext-disposition=${Date.now()}`);
}

function withCanonicalDispatchBindings(record) {
  return { ...record, packet_sha256: "a".repeat(64), carrier_root_id: "b".repeat(64) };
}

function externalDispatchRecord({ prNumber, headRefOid, dispatchId, reviewerTool = "Claude Code", reviewerFamily = "claude" }) {
  return withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: String(prNumber),
    head_ref_oid: headRefOid,
    attempt_id: `second-review-pr-${prNumber}-external`,
    dispatch_id: dispatchId,
    previous_dispatch_id: null,
    executor_kind: "external-evaluator",
    reviewer_family: reviewerFamily,
    primary_family: "codex",
    reviewer_tool: reviewerTool,
    sticky_write_action: "create",
    sticky_target_comment_id: null,
    sticky_snapshot_digest: "d".repeat(64),
    issued_at: "2026-08-20T00:00:00.000Z",
  });
}

// Byte-identical to check.mjs's private buildMockStickyBody — reconstructed
// here (via the same exported constants) so the completion receipt's
// sticky_body_sha256 can be computed against exactly what the mock gh path
// under test will present as the "live" sticky.
function mockStickyBodyText({ verdict, sha, dispatchId }) {
  return [
    SECOND_REVIEW_STICKY_MARKER,
    "## Cross-Model Review",
    `verdict: ${verdict}`,
    `last_reviewed_sha: ${sha}`,
    `dispatch_id: ${dispatchId}`,
    "reason: The bounded mock review completed for the requested scope.",
    SECOND_REVIEW_STICKY_MOCK_PROVENANCE,
  ].join("\n");
}

// Byte-identical to check.mjs's mockPrSnapshot comment-identity formula.
function mockStickyCommentId(prNumber) {
  return 500000000 + (Number(prNumber) || 0);
}
function mockStickyCommentUrl(prNumber) {
  return `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}#issuecomment-${mockStickyCommentId(prNumber)}`;
}

async function acceptExternalDispatch(helper, rootDir, dispatch, { verdict, bodySha256Override } = {}) {
  const stickyBody = mockStickyBodyText({ verdict, sha: dispatch.head_ref_oid, dispatchId: dispatch.dispatch_id });
  const payload = {
    schema: "devpro-second-review-completion/v2",
    repository_slug: dispatch.repository_slug,
    pr_number: dispatch.pr_number,
    head_ref_oid: dispatch.head_ref_oid,
    attempt_id: dispatch.attempt_id,
    dispatch_id: dispatch.dispatch_id,
    previous_dispatch_id: dispatch.previous_dispatch_id,
    sticky_verdict: verdict,
    sticky_last_reviewed_sha: dispatch.head_ref_oid,
    sticky_dispatch_id: dispatch.dispatch_id,
    sticky_comment_id: mockStickyCommentId(dispatch.pr_number),
    sticky_comment_url: mockStickyCommentUrl(dispatch.pr_number),
    sticky_body_sha256: bodySha256Override ?? sha256Hex(stickyBody),
  };
  await helper.writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "accepted", receiptPayload: payload });
  await helper.writeExternalCompletionReceipt({ rootDir, dispatchId: dispatch.dispatch_id });
  return { payload, stickyBody };
}

function stickyMockEnv({ prNumber, headRefOid, dispatchId, verdict = "PASS" }) {
  return {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: String(prNumber),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${prNumber}:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${prNumber}:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${prNumber}:${dispatchId}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${prNumber}:${verdict}`,
  };
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\n${result.stderr}`);
  return result.stdout.trim();
}

function makeGitRepo(name) {
  const repo = path.join(tmpRoot, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Devpro Test"]);
  writeFileSync(path.join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

test("EXT-DISPOSITION-0: native executorKind write is byte-identical to the post-write patch (T3 parity)", () => {
  const stateDir = makeStateDir();
  const input = {
    cwd: REPO_ROOT,
    prNumber: "9100",
    branch: "feature/ext-parity",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "1111111111111111111111111111111111111100",
    expectedDispatchId: "dispatch-ext-9100",
    sessionId: "fixed-session-for-parity",
  };
  const nativeFile = writeExternalMarker(stateDir, input);
  const nativeData = JSON.parse(readFileSync(nativeFile, "utf8"));
  rmSync(nativeFile); // remove authority before constructing the independent parity fixture
  const patchedFile = writeExternalMarkerByPostPatch(stateDir, input);
  const patchedData = JSON.parse(readFileSync(patchedFile, "utf8"));

  assert.equal(nativeFile, patchedFile, "same prNumber must resolve to the same marker file path");
  // Each independent creation gets its own timestamp and authority generation.
  delete nativeData.createdAt;
  delete patchedData.createdAt;
  assert.notEqual(nativeData.authorityId, patchedData.authorityId);
  delete nativeData.authorityId;
  delete patchedData.authorityId;
  assert.deepEqual(nativeData, patchedData, "native executorKind write must produce the same fields as the post-write patch");
  assert.equal(nativeData.executor_kind, "external-evaluator");
});

test("EXT-DISPOSITION-1: MERGED clears an external marker unconditionally (clear_policy)", () => {
  const stateDir = makeStateDir();
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9101",
    branch: "feature/ext-merged",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "111111111111111111111111111111111111111a",
    expectedDispatchId: "dispatch-ext-9101",
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STATE: "9101:MERGED",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 0, `MERGED external marker must clear; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "clear_policy must CAS-clear the marker");
});

// EXT-DISPOSITION-2 exercises the pre-fetch `isMarkerBranchPatternExempt`
// early return (branch pattern only, before any snapshot); the resolver's own
// `clear_policy` exemption branch is covered by EXT-DISPOSITION-2b/2c below.
test("EXT-DISPOSITION-2: a branch-pattern-exempt marker clears through the pre-fetch early return, before the resolver", () => {
  const stateDir = makeStateDir();
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9102",
    branch: "chore/bump-v6.0.0",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "222222222222222222222222222222222222222a",
    expectedDispatchId: "dispatch-ext-9102",
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "9102:chore/bump-v6.0.0",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 0, `exempt external marker must clear; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "clear_policy must CAS-clear the marker");
});

test("EXT-DISPOSITION-2b (F-aeesr-r7-03): a chore-A diff shape on a complete file snapshot clears through the resolver's clear_policy without closure evidence", () => {
  const stateDir = makeStateDir();
  // `chore/tidy-external-docs` is not a branch-pattern exemption, so the
  // pre-fetch early return does not fire; only the resolver's
  // `isCrossModelExempt(headRefName, files)` on the full snapshot can clear it.
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9112",
    branch: "chore/tidy-external-docs",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "212121212121212121212121212121212121212a",
    expectedDispatchId: "dispatch-ext-9112",
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "9112:chore/tidy-external-docs",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "9112:212121212121212121212121212121212121212a",
    DEVPRO_POST_PR_GATE_MOCK_FILES: "9112:README.md",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 0, `chore-A external marker must clear via clear_policy; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "clear_policy must CAS-clear the marker");
});

test("EXT-DISPOSITION-2c (F-aeesr-r7-03): a light snapshot without a file list never satisfies the exemption and retains the marker", () => {
  const stateDir = makeStateDir();
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9113",
    branch: "chore/tidy-external-docs",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "313131313131313131313131313131313131313a",
    expectedDispatchId: "dispatch-ext-9113",
  });

  // Same chore/* branch as 2b; the only difference is the snapshot has no
  // complete file list, whose empty `files: []` would otherwise read as a
  // proposal-absent chore-A diff shape.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "9113:chore/tidy-external-docs",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "9113:313131313131313131313131313131313131313a",
    DEVPRO_POST_PR_GATE_MOCK_FILES_UNAVAILABLE: "9113",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 2, "a light snapshot must not clear an external marker through exemption");
  assert.equal(existsSync(markerFile), true, "retain must not clear the marker");
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_closure_pending/, "the resolver must fall through to closure evidence");
});

test("EXT-DISPOSITION-3: accepted PASS receipt matching the live sticky clears the marker (clear_verified)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "333333333333333333333333333333333333333a";
  const dispatch = externalDispatchRecord({ prNumber: "9103", headRefOid, dispatchId: "dispatch-ext-9103" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-verified-pass",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 0, `clear_verified PASS must clear; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(existsSync(markerFile), false, "clear_verified must CAS-clear the marker");
});

test("EXT-DISPOSITION-4: accepted WARN receipt matching the live sticky clears the marker (clear_verified)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "444444444444444444444444444444444444444a";
  const dispatch = externalDispatchRecord({ prNumber: "9104", headRefOid, dispatchId: "dispatch-ext-9104" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "WARN" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-verified-warn",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "WARN" }),
  });

  assert.equal(result.status, 0, `clear_verified WARN must clear (process_close_observed:false is not required for external); stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "clear_verified must CAS-clear the marker");
});

function seedReviewRoundState(stateDir, prNumber, roundCount, repositorySlug = "devpro-tw/devpro-agent-rules") {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    const file = reviewRoundSidecarPath({ prNumber, repositorySlug });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schema_version: 1, pr_number: String(prNumber), repository_slug: repositorySlug, round_count: roundCount, dispatch_lineage: [] }));
    return file;
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

// Post-PR dogfood finding: the review-round sidecar must survive an external
// marker's clear_verified and exemption clears (only MERGED retires it, as in
// the runner loop), otherwise every accepted round resets the round cap.
test("EXT-DISPOSITION-4b: clear_verified and exemption clears keep the review-round sidecar; only MERGED retires it", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "414141414141414141414141414141414141414a";
  const dispatch = externalDispatchRecord({ prNumber: "9124", headRefOid, dispatchId: "dispatch-ext-9124" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "WARN" });
  const verifiedSidecar = seedReviewRoundState(stateDir, dispatch.pr_number, 2, dispatch.repository_slug);
  const verifiedMarker = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-verified-round-state",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });
  const verified = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "WARN" }),
  });
  assert.equal(verified.status, 0, `clear_verified WARN must clear; stderr: ${verified.stderr}`);
  assert.equal(existsSync(verifiedMarker), false, "clear_verified must CAS-clear the marker");
  assert.equal(existsSync(verifiedSidecar), true, "clear_verified must not retire the review-round sidecar");

  const exemptStateDir = makeStateDir();
  const exemptSidecar = seedReviewRoundState(exemptStateDir, "9125", 2);
  const exemptMarker = writeExternalMarker(exemptStateDir, {
    cwd: REPO_ROOT,
    prNumber: "9125",
    branch: "chore/tidy-external-round-state",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "515151515151515151515151515151515151515a",
    expectedDispatchId: "dispatch-ext-9125",
  });
  const exempt = runStop(noGitCwd, exemptStateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(exemptStateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "9125:chore/tidy-external-round-state",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "9125:515151515151515151515151515151515151515a",
    DEVPRO_POST_PR_GATE_MOCK_FILES: "9125:README.md",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(exempt.status, 0, `chore-A external marker must clear via clear_policy; stderr: ${exempt.stderr}`);
  assert.equal(existsSync(exemptMarker), false, "clear_policy must CAS-clear the marker");
  assert.equal(existsSync(exemptSidecar), true, "an exemption clear must not retire the review-round sidecar");

  const mergedStateDir = makeStateDir();
  const mergedSidecar = seedReviewRoundState(mergedStateDir, "9126", 2);
  writeExternalMarker(mergedStateDir, {
    cwd: REPO_ROOT,
    prNumber: "9126",
    branch: "feature/ext-merged-round-state",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "616161616161616161616161616161616161616a",
    expectedDispatchId: "dispatch-ext-9126",
  });
  const merged = runStop(noGitCwd, mergedStateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(mergedStateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STATE: "9126:MERGED",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(merged.status, 0, `MERGED external marker must clear; stderr: ${merged.stderr}`);
  assert.equal(existsSync(mergedSidecar), false, "MERGED must retire the review-round sidecar");
});

test("EXT-DISPOSITION-5: no closure slot yet retains the marker with an accept-helper Blocked message (retain, group a)", () => {
  const stateDir = makeStateDir();
  const prNumber = "9105";
  const dispatchId = "dispatch-ext-9105";
  const headRefOid = "555555555555555555555555555555555555555a";
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber,
    branch: "feature/ext-pending-accept",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid,
    expectedDispatchId: dispatchId,
  });

  // No dispatch reservation, no slot at all: the "current-head PASS with no
  // receipt yet" shape from T6's acceptance list.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    ...stickyMockEnv({ prNumber, headRefOid, dispatchId, verdict: "PASS" }),
  });

  assert.equal(result.status, 2, "an unaccepted external marker must retain and hard-block");
  assert.equal(existsSync(markerFile), true, "retain must not clear the marker");
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_closure_pending/, "reason code must be reported");
  assert.match(
    json.reason,
    /accept-external-second-review\.mjs <packet-dir for dispatch dispatch-ext-9105>/,
    "group (a) must name the accept helper with a placeholder packet-dir, never a local path"
  );
  assert.doesNotMatch(
    json.reason,
    /\/devpro:cross-review <PR#>/,
    "an all-external pending turn must not carry the runner-only /devpro:cross-review next action"
  );
});

test("EXT-DISPOSITION-6: a digest-drifted sticky retains the marker and points to reissue, not accept (retain, group b)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "666666666666666666666666666666666666666a";
  const dispatch = externalDispatchRecord({ prNumber: "9106", headRefOid, dispatchId: "dispatch-ext-9106" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  // Receipt is bound to a DIFFERENT body than what the live sticky will show —
  // simulates the sticky comment being edited after TL accepted it (D14).
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, {
    verdict: "PASS",
    bodySha256Override: sha256Hex("a since-edited sticky body, not what was accepted"),
  });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-digest-drift",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 2, "digest drift must retain and hard-block");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_sticky_digest_mismatch/);
  assert.match(json.reason, /重新發行審查單/, "group (b) must point at reissuing the ticket");
  assert.doesNotMatch(
    json.reason,
    /accept-external-second-review\.mjs/,
    "group (b) MUST NOT point at the accept helper — accept would only ever re-derive already_accepted"
  );
});

test("EXT-DISPOSITION-7: PR head advancing after accept retains the marker (retain, group b, D6 finding 2)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const acceptedHeadRefOid = "777777777777777777777777777777777777777a";
  const advancedHeadRefOid = "777777777777777777777777777777777777777b";
  const dispatch = externalDispatchRecord({ prNumber: "9107", headRefOid: acceptedHeadRefOid, dispatchId: "dispatch-ext-9107" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-head-advanced",
    repositorySlug: dispatch.repository_slug,
    headRefOid: acceptedHeadRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  // Live PR head has moved past what was accepted; the sticky itself is
  // untouched (still describes the accepted head) — this is exactly the case
  // design audit r1 finding 2 exists to catch.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({
      prNumber: dispatch.pr_number,
      headRefOid: acceptedHeadRefOid,
      dispatchId: dispatch.dispatch_id,
      verdict: "PASS",
    }),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${dispatch.pr_number}:${advancedHeadRefOid}`,
  });

  assert.equal(result.status, 2, "a moved head must retain and hard-block");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_head_drifted/);
});

test("EXT-DISPOSITION-8: a footer Tool: mismatch against the dispatch record retains the marker (retain, group b)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "888888888888888888888888888888888888888a";
  // The mock sticky footer always says "Tool: Claude Code" (SECOND_REVIEW_STICKY_MOCK_PROVENANCE);
  // binding the dispatch record to a different reviewer_tool manufactures the mismatch.
  const dispatch = externalDispatchRecord({
    prNumber: "9108",
    headRefOid,
    dispatchId: "dispatch-ext-9108",
    reviewerTool: "Codex",
    reviewerFamily: "codex",
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-tool-mismatch",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 2);
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_sticky_tool_mismatch/);
});

test("EXT-DISPOSITION-9: an accepted CRITICAL receipt retains the marker (retain, group b)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "999999999999999999999999999999999999999a";
  const dispatch = externalDispatchRecord({ prNumber: "9109", headRefOid, dispatchId: "dispatch-ext-9109" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "CRITICAL" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-critical",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "CRITICAL" }),
  });

  assert.equal(result.status, 2, "CRITICAL is a fourth-form-writable verdict but never marker-clearing");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_verdict_not_ready/);
});

test("EXT-DISPOSITION-10: a voided dispatch retains the marker and points to reissue (retain, group c)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1010101010101010101010101010101010101010";
  const dispatch = externalDispatchRecord({ prNumber: "9110", headRefOid, dispatchId: "dispatch-ext-9110" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await helper.writeExternalClosureSlot({ rootDir: evidenceRoot, dispatchId: dispatch.dispatch_id, kind: "voided" });
  await helper.writeExternalVoidTerminalReceipt({ rootDir: evidenceRoot, dispatchId: dispatch.dispatch_id });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-voided",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 2, "a voided dispatch must retain, never accept-fixable");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_dispatch_voided/);
  assert.match(json.reason, /重新發行審查單/);
  assert.doesNotMatch(json.reason, /accept-external-second-review\.mjs/);
});

test("EXT-DISPOSITION-11: a mixed runner+external pending turn keeps the runner boilerplate byte-identical and adds the external section", () => {
  const stateDir = makeStateDir();
  const externalMarkerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9111",
    branch: "feature/ext-mixed-a",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "111111111111111111111111111111111111111c",
    expectedDispatchId: "dispatch-ext-9111",
  });
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  let runnerMarkerFile;
  try {
    runnerMarkerFile = writePostPrCompletionMarker({
      cwd: REPO_ROOT,
      prNumber: "9112",
      branch: "feature/ext-mixed-b",
      url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9112",
    });
  } finally {
    if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(runnerMarkerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 2, `mixed pending must hard-block; stderr: ${result.stderr}`);
  assert.equal(existsSync(externalMarkerFile), true);
  assert.equal(existsSync(runnerMarkerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /PR #9111/);
  assert.match(json.reason, /PR #9112/);
  assert.match(
    json.reason,
    /\/devpro:cross-review <PR#>/,
    "a mixed turn must keep the exact prior runner next-step text"
  );
  assert.match(
    json.reason,
    /External evaluator second-review — still pending/,
    "the external marker still gets its own correct next-action section"
  );
  // F-aeesr-r3-05: the runner boilerplate above still says stale-expire and
  // "merge gate is the final fail-closed defense"; neither holds for the external
  // marker, so the external section itself must carry the residual-risk sentence.
  const externalSection = json.reason.slice(json.reason.indexOf("External evaluator second-review — still pending"));
  assert.match(externalSection, /不會 stale-expire/, "external section must say external markers never stale-expire");
  assert.match(
    externalSection,
    /merge gate 不驗證 TL 驗收收據.*TL 必須先完成 accept 才可 merge/,
    "external section must carry the merge-gate residual-risk sentence in a mixed turn"
  );
});

test("EXT-DISPOSITION-12: cleanupMergedSkippedMarker routes an external marker through the same resolver", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1212121212121212121212121212121212121212";
  const dispatch = externalDispatchRecord({ prNumber: "9113", headRefOid, dispatchId: "dispatch-ext-9113" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "WARN" });

  const repo = makeGitRepo(`repo-ext-skipped-${counter++}`);
  const markerFile = writeExternalMarker(stateDir, {
    cwd: repo,
    prNumber: dispatch.pr_number,
    // A branch that can never equal whatever branch `repo` happens to be on
    // (it was just created on "main") makes this marker "skipped" by
    // isMarkerRelevantToCurrentTurn's branch-mismatch early return, so the
    // ONLY path that can clear it is cleanupMergedSkippedMarker.
    branch: "feature/deleted-external-branch",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${dispatch.pr_number}:MERGED`,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "WARN" }),
  });

  assert.equal(result.status, 0, `merged skipped external marker should self-heal; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "skipped-cleanup must clear via the resolver, not the runner verifier");
});

// ── Coordinator follow-up: remaining T6 acceptance branches ────────────────
// (EXT-DISPOSITION-1's sibling, "current-head PASS with no receipt at all", is
// already covered by EXT-DISPOSITION-5 above — no dispatch reservation exists
// there either, which is the same `!dispatch` early return this item 2 test
// reaches via a DIFFERENT route: a published `accepted` slot with a missing
// completion receipt, i.e. readDispatchEvidenceStrict's own
// `external_closure_incomplete` throw.)

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function makeCwdWithActiveChangeFolder(changeName) {
  const cwd = path.join(tmpRoot, `cwd-${counter++}`);
  mkdirSync(path.join(cwd, "openspec", "changes", changeName), { recursive: true });
  return cwd;
}

// D1/D3 (fix-second-review-loop-friction): `round` is no longer a cost
// threshold, so a PR-sticky round-cap sidecar can no longer be the trigger
// for EXT-DISPOSITION-18's cost-budget block below. `stalled_rounds` is now
// the only surviving cost-budget key that can stop a turn, and — mirroring
// `hook-post-pr-completion-cost-circuit-breaker.test.mjs`'s CCB-18 — the
// cheapest real (non-mocked) way to force it `exceeded` is an unreadable
// receipt chain (D20 `unavailable`), which needs a real repo cwd checked out
// on the marker's own branch (see `makeRepoCwdWithActiveChangeFolder` below;
// every other test in this file stays on the non-repo `makeCwdWithActiveChangeFolder`
// cwd, which resolves `stalled_rounds` as `not-applicable` and is unaffected).
function makeRepoCwdWithActiveChangeFolder(changeName) {
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  const run = (args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  run(["init", "-q", "-b", `chore/${changeName}`]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  run(["remote", "add", "origin", "https://github.com/devpro-tw/devpro-agent-rules.git"]);
  return cwd;
}

// A receipt that exists but cannot be parsed: D20's `unavailable`, reached
// for real rather than mocked (same helper as CCB-18's).
function seedUnreadableReceipt(cwd, changeName) {
  const notes = path.join(cwd, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, `review-${changeName}-receipt-r1.json`), "this is not a sealed receipt\n");
}

test("EXT-DISPOSITION-13: accepted slot with a missing completion receipt retains and points to accept (retain, group a)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1313131313131313131313131313131313131313";
  const dispatch = externalDispatchRecord({ prNumber: "9114", headRefOid, dispatchId: "dispatch-ext-9114" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  const stickyBody = mockStickyBodyText({ verdict: "PASS", sha: headRefOid, dispatchId: dispatch.dispatch_id });
  const payload = {
    schema: "devpro-second-review-completion/v2",
    repository_slug: dispatch.repository_slug,
    pr_number: dispatch.pr_number,
    head_ref_oid: dispatch.head_ref_oid,
    attempt_id: dispatch.attempt_id,
    dispatch_id: dispatch.dispatch_id,
    previous_dispatch_id: dispatch.previous_dispatch_id,
    sticky_verdict: "PASS",
    sticky_last_reviewed_sha: headRefOid,
    sticky_dispatch_id: dispatch.dispatch_id,
    sticky_comment_id: mockStickyCommentId(dispatch.pr_number),
    sticky_comment_url: mockStickyCommentUrl(dispatch.pr_number),
    sticky_body_sha256: sha256Hex(stickyBody),
  };
  // Slot published (simulating a crash right after publish) but
  // writeExternalCompletionReceipt was never called — readDispatchEvidenceStrict
  // must throw external_closure_incomplete, and classifyExternalClosureIncomplete
  // must read it back as group (a), not group (d).
  await helper.writeExternalClosureSlot({ rootDir: evidenceRoot, dispatchId: dispatch.dispatch_id, kind: "accepted", receiptPayload: payload });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-slot-only-crash",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 2, "a slot-only accepted dispatch (crash before the receipt) must retain and hard-block");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_closure_pending/);
  assert.match(json.reason, /accept-external-second-review\.mjs <packet-dir for dispatch dispatch-ext-9114>/);
});

test("EXT-DISPOSITION-14: an accepted UNAVAILABLE receipt retains the marker (retain, group b)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1414141414141414141414141414141414141414";
  const dispatch = externalDispatchRecord({ prNumber: "9115", headRefOid, dispatchId: "dispatch-ext-9115" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "UNAVAILABLE" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-unavailable",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "UNAVAILABLE" }),
  });

  assert.equal(result.status, 2, "UNAVAILABLE is a fourth-form-writable verdict but never marker-clearing");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_verdict_not_ready/);
  assert.match(json.reason, /重新發行審查單/);
  assert.doesNotMatch(json.reason, /accept-external-second-review\.mjs/);
});

test("EXT-DISPOSITION-15: unreadable evidence (corrupt dispatch.json) retains and reports to TL, not accept (retain, group d)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1515151515151515151515151515151515151515";
  const dispatch = externalDispatchRecord({ prNumber: "9116", headRefOid, dispatchId: "dispatch-ext-9116" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  // Corrupt the reserved dispatch record after the fact — not valid JSON.
  const dispatchJsonPath = path.join(evidenceRoot, dispatch.dispatch_id, "dispatch.json");
  writeFileSync(dispatchJsonPath, "{ not valid json");

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-corrupt-evidence",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 2, "corrupt dispatch evidence must fail closed to retain");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /回報 TL/, "group (d) must instruct reporting to TL");
  assert.doesNotMatch(
    json.reason.split("External evaluator second-review")[1] ?? json.reason,
    /accept-external-second-review\.mjs/,
    "group (d) MUST NOT instruct running accept on unreadable evidence"
  );
});

test("EXT-DISPOSITION-16: a receipt with no live canonical sticky body retains the marker (retain, group b)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1616161616161616161616161616161616161616";
  const dispatch = externalDispatchRecord({ prNumber: "9117", headRefOid, dispatchId: "dispatch-ext-9117" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-no-sticky-body",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  // No DEVPRO_POST_PR_GATE_MOCK_STICKY for this PR: the live PR simply has no
  // canonical sticky comment at all, even though a completion receipt exists.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${dispatch.pr_number}:${headRefOid}`,
  });

  assert.equal(result.status, 2, "no canonical sticky body must retain, never clear on receipt alone");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_sticky_missing/);
});

test("EXT-DISPOSITION-17: a footer Model: mismatch against MODEL_FAMILY_PATTERNS[reviewer_family] retains the marker (retain, group b)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "1717171717171717171717171717171717171717";
  // Tool token matches the mock footer ("Claude Code") so the Tool check
  // passes; reviewer_family "gemini" does not match the mock Model text
  // ("claude-test"), isolating the Model-pattern check specifically.
  const dispatch = externalDispatchRecord({
    prNumber: "9118",
    headRefOid,
    dispatchId: "dispatch-ext-9118",
    reviewerTool: "Claude Code",
    reviewerFamily: "gemini",
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-model-mismatch",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 2);
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_sticky_model_mismatch/);
});

test("EXT-DISPOSITION-18: a cost-budget (stalled_rounds) blocker on an external marker is still recorded, alongside its own retain section", () => {
  const stateDir = makeStateDir();
  const changeName = "ext-cost-budget-stalled-rounds";
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  seedUnreadableReceipt(cwd, changeName);
  const prNumber = "9119";
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    worktree: cwd,
    prNumber,
    branch: `chore/${changeName}`,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "1818181818181818181818181818181818181818",
    expectedDispatchId: "dispatch-ext-9119",
  });

  const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
  const result = runStop(cwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `${prNumber}:${b64(prBody)}`,
  });

  assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "an external marker never bypasses the cost-budget blocker");
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /### Cost circuit breaker (?:exceeded|blocked)/, "cost-budget block must still be recorded for an external marker");
  assert.match(json.reason, /PR #9119/);
  assert.match(json.reason, /`stalled_rounds`/);
  assert.match(
    json.reason,
    /External evaluator second-review — still pending/,
    "the marker's own retain disposition must not be dropped by the cost-budget block path"
  );
});

test("EXT-DISPOSITION-19: an S-1 override-disclosure-mismatch blocker on an external marker is still recorded", () => {
  const stateDir = makeStateDir();
  const changeName = "ext-disclosure-mismatch";
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  const prNumber = "9120";
  appendChangeUsageOverride({
    cwd,
    changeName,
    session_id: "ext-s1",
    at: "2026-01-01T00:00:00.000Z",
    thresholds: ["output"],
    head_ref_oid: "1919191919191919191919191919191919191919",
  });
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    worktree: cwd,
    prNumber,
    branch: `chore/${changeName}`,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "1919191919191919191919191919191919191919",
    expectedDispatchId: "dispatch-ext-9120",
  });

  const prBody = "## Cost Circuit Breaker Overrides\nN/A\n"; // non-empty overrides[] but body says N/A → S-1 mismatch
  const result = runStop(cwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `${prNumber}:${b64(prBody)}`,
  });

  assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "an external marker never bypasses the disclosure blocker");
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /override disclosure mismatch/, "disclosure block must still be recorded for an external marker");
  assert.match(json.reason, /PR #9120/);
});

test("EXT-DISPOSITION-20: cleanupMergedSkippedMarker leaves a not-yet-merged external marker untouched (pr_not_merged)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "2020202020202020202020202020202020202020";
  const dispatch = externalDispatchRecord({ prNumber: "9121", headRefOid, dispatchId: "dispatch-ext-9121" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  const probeDir = path.join(stateDir, "skipped-cleanup-probe");
  const repo = makeGitRepo(`repo-ext-not-merged-${counter++}`);
  const markerFile = writeExternalMarker(stateDir, {
    cwd: repo,
    prNumber: dispatch.pr_number,
    sessionId: "foreign-external-session",
    branch: "feature/deleted-external-branch-not-merged",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  // PR state defaults to OPEN (no DEVPRO_POST_PR_GATE_MOCK_STATE override) —
  // cleanupMergedSkippedMarker's `snapshot.state !== "MERGED"` early return
  // fires before ever reaching the external-marker resolver branch.
  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 0, `an unmerged skipped marker must stay advisory-only; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "an unmerged external marker must not be cleared by skipped-cleanup");

  assert.equal(result.stdout, "");
  assert.equal(existsSync(probeDir), false, "foreign external authority gets no cleanup probe");
});

test("EXT-DISPOSITION-21 (F-02a): compareAndSwapPostPrCompletionExpectedDispatch without executorKind clears a previously-bound external marker's executor_kind", async () => {
  const stateDir = makeStateDir();
  const repositorySlug = "devpro-tw/devpro-agent-rules";
  const headRefOid = "2222222222222222222222222222222222222222";
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9122",
    branch: "feature/ext-rebind-same-head",
    repositorySlug,
    headRefOid,
    expectedDispatchId: "dispatch-ext-9122-old",
  });
  const before = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(before.executor_kind, "external-evaluator");

  const result = await compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug,
    prNumber: "9122",
    headRefOid,
    expectedDispatchId: "dispatch-ext-9122-old",
    nextDispatchId: "dispatch-runner-9122-new",
    // executorKind intentionally omitted: this CAS call is a runner reissue
    // over what used to be an external dispatch (e.g. after a void).
  });

  assert.equal(result.status, "updated");
  const after = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(
    Object.hasOwn(after, "executor_kind"),
    false,
    "a runner rebind must delete the stale external executor_kind, not leave it in place"
  );
  assert.equal(after.expected_dispatch_id, "dispatch-runner-9122-new");
});

test("EXT-DISPOSITION-22 (F-02b): compareAndSwapPostPrCompletionHeadBinding without executorKind clears a previously-bound external marker's executor_kind", async () => {
  const stateDir = makeStateDir();
  const repositorySlug = "devpro-tw/devpro-agent-rules";
  const acceptedHeadRefOid = "3333333333333333333333333333333333333330";
  const runnerHeadRefOid = "3333333333333333333333333333333333333331";
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "9123",
    branch: "feature/ext-then-runner",
    repositorySlug,
    headRefOid: acceptedHeadRefOid,
    expectedDispatchId: "dispatch-ext-9123-voided",
  });
  const before = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(before.executor_kind, "external-evaluator");

  const runnerDispatchId = "dispatch-runner-9123";
  const advanced = await compareAndSwapPostPrCompletionHeadBinding({
    markerFile,
    repositorySlug,
    prNumber: "9123",
    expectedHeadRefOid: acceptedHeadRefOid,
    expectedDispatchId: "dispatch-ext-9123-voided",
    nextHeadRefOid: runnerHeadRefOid,
    nextDispatchId: runnerDispatchId,
    // executorKind intentionally omitted: cross-head reissue via the runner.
  });

  assert.equal(advanced.status, "updated");
  const rebound = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(
    Object.hasOwn(rebound, "executor_kind"),
    false,
    "a runner rebind must delete the stale external executor_kind, not leave it in place"
  );
  assert.equal(rebound.head_ref_oid, runnerHeadRefOid);
  assert.equal(rebound.expected_dispatch_id, runnerDispatchId);

  // The Stop hook for this now-runner marker must take the runner PASS-clear
  // path — no external evidence exists for runnerDispatchId at all, so if the
  // hook still routed this through the external resolver it would hard-block
  // on `external_closure_pending`, not clear.
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const runnerRecord = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: repositorySlug,
    pr_number: "9123",
    head_ref_oid: runnerHeadRefOid,
    attempt_id: "second-review-pr-9123-runner",
    dispatch_id: runnerDispatchId,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: runnerRecord });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record: runnerRecord });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "9123",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9123:${runnerHeadRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `9123:${runnerHeadRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `9123:${runnerDispatchId}`,
  });

  assert.equal(
    result.status,
    0,
    `a rebound (now-runner) marker must clear via the runner authoritative-PASS path; stderr: ${result.stderr}; stdout: ${result.stdout}`
  );
  assert.equal(existsSync(markerFile), false, "runner PASS must CAS-clear the rebound marker");
});

test("EXT-DISPOSITION-23 (F-02c): a runner marker that never had executor_kind stays byte-shape-identical after a CAS advance without executorKind", async () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  let markerFile;
  try {
    markerFile = writePostPrCompletionMarker({
      cwd: REPO_ROOT,
      prNumber: "9124",
      branch: "feature/runner-only",
      repositorySlug: "devpro-tw/devpro-agent-rules",
      headRefOid: "4444444444444444444444444444444444444440",
      expectedDispatchId: "dispatch-runner-9124-first",
    });
  } finally {
    if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const before = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(Object.hasOwn(before, "executor_kind"), false);

  const result = await compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "9124",
    headRefOid: "4444444444444444444444444444444444444440",
    expectedDispatchId: "dispatch-runner-9124-first",
    nextDispatchId: "dispatch-runner-9124-second",
  });

  assert.equal(result.status, "updated");
  const after = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(
    Object.hasOwn(after, "executor_kind"),
    false,
    "a runner marker that never had executor_kind must never gain the key"
  );
  assert.deepEqual(
    Object.keys(after),
    Object.keys(before),
    "CAS on a runner marker must not add or reorder keys, only update field values"
  );
});

// ── Primary-review F-11: strict reader must verify receipt content, not just
// presence. A tampered-but-self-consistent completion receipt (valid schema,
// valid integrity_id, but drifted from what the accepted slot's own
// receipt_payload would rebuild) must fail closed instead of being treated as
// a legitimately-accepted PASS.

function withRecomputedIntegrity(record) {
  const { integrity_id: _ignored, ...identity } = record;
  return { ...identity, integrity_id: sha256Hex(JSON.stringify(identity)) };
}

test("EXT-DISPOSITION-24 (F-11): a tampered-but-self-consistent completion receipt retains the marker and reports to TL, not clear_verified (retain, group d)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "2121212121212121212121212121212121212121";
  const dispatch = externalDispatchRecord({ prNumber: "9125", headRefOid, dispatchId: "dispatch-ext-9125" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await acceptExternalDispatch(helper, evidenceRoot, dispatch, { verdict: "PASS" });

  // Tamper the published completion receipt's verdict in place (still a
  // byte-valid receipt with a self-consistent integrity_id, and the live
  // sticky body/verdict/digest are all untouched) so a presence-only check
  // would wrongly clear this as an accepted PASS.
  const receiptPath = path.join(evidenceRoot, dispatch.dispatch_id, "completion-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.sticky_verdict = "WARN";
  writeFileSync(receiptPath, `${JSON.stringify(withRecomputedIntegrity(receipt))}\n`);

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-tampered-receipt",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...stickyMockEnv({ prNumber: dispatch.pr_number, headRefOid, dispatchId: dispatch.dispatch_id, verdict: "PASS" }),
  });

  assert.equal(result.status, 2, "a tampered completion receipt must retain and hard-block, not clear_verified");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_closure_receipt_mismatch/);
  assert.match(json.reason, /回報 TL/, "group (d) must instruct reporting to TL");
  assert.doesNotMatch(
    json.reason.split("External evaluator second-review")[1] ?? json.reason,
    /accept-external-second-review\.mjs/,
    "a receipt/slot mismatch must never instruct running accept again"
  );
});

test("EXT-DISPOSITION-25 (F-11): a tampered-but-self-consistent void terminal receipt retains the marker and reports to TL (retain, group d)", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "2222222222222222222222222222222222222299";
  const dispatch = externalDispatchRecord({ prNumber: "9126", headRefOid, dispatchId: "dispatch-ext-9126" });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: dispatch });
  await helper.writeExternalClosureSlot({ rootDir: evidenceRoot, dispatchId: dispatch.dispatch_id, kind: "voided" });
  await helper.writeExternalVoidTerminalReceipt({ rootDir: evidenceRoot, dispatchId: dispatch.dispatch_id });

  // Tamper the published void terminal receipt's created_at in place — still
  // schema/integrity-valid (assertTerminalReceipt only requires a canonical
  // ISO timestamp, it does not compare against the slot's closed_at), but no
  // longer what writeExternalVoidTerminalReceipt would rebuild from the slot.
  const terminalPath = path.join(evidenceRoot, dispatch.dispatch_id, "terminal-receipt.json");
  const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
  terminal.created_at = new Date(Date.parse(terminal.created_at) + 60_000).toISOString();
  writeFileSync(terminalPath, `${JSON.stringify(withRecomputedIntegrity(terminal))}\n`);

  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber: dispatch.pr_number,
    branch: "feature/ext-tampered-void",
    repositorySlug: dispatch.repository_slug,
    headRefOid,
    expectedDispatchId: dispatch.dispatch_id,
  });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 2, "a tampered void terminal receipt must retain and hard-block");
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /external_closure_receipt_mismatch/);
  assert.match(json.reason, /回報 TL/, "group (d) must instruct reporting to TL");
});

// ── Primary review r2, F-aeesr-r2-04: the all-external hard-block's "完整
// gate 清單" line must not claim stale-expire self-clearing (external markers
// always carry expected_dispatch_id, so listPostPrCompletionMarkers never
// stale-expires them) or that checkCrossModelMergeGate is a final fail-closed
// defense (it never reads local receipts and can admit a self-written PASS/
// WARN sticky before TL accept — decisions.md F-05 residual risk). The runner
// branch keeps both claims verbatim, since they are true there.
test("EXT-DISPOSITION-26 (F-aeesr-r2-04): the all-external hard-block message drops the false stale-expire/final-defense claims and states accept must precede merge", () => {
  const stateDir = makeStateDir();
  const prNumber = "9127";
  const dispatchId = "dispatch-ext-9127";
  const headRefOid = "2727272727272727272727272727272727272727";
  const markerFile = writeExternalMarker(stateDir, {
    cwd: REPO_ROOT,
    prNumber,
    branch: "feature/ext-r2-04-message",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid,
    expectedDispatchId: dispatchId,
  });

  // No dispatch reservation, no slot at all (retain, group a) — the simplest
  // way to reach the all-external hard-block body; the fix is about the
  // shared boilerplate line, not this particular retain reason.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    ...stickyMockEnv({ prNumber, headRefOid, dispatchId, verdict: "PASS" }),
  });

  assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true);
  const json = JSON.parse(result.stdout);
  assert.doesNotMatch(
    json.reason,
    /2 小時後 stale-expire/,
    "an all-external turn must not claim the marker self-clears via stale-expire"
  );
  assert.doesNotMatch(
    json.reason,
    /checkCrossModelMergeGate.*(?:最終|final)/,
    "an all-external turn must not claim the merge gate is a final fail-closed defense"
  );
  assert.match(
    json.reason,
    /merge gate.*(?:不(?:驗證|讀)|does not (?:verify|read)).*accept/,
    "must state the merge gate does not verify the acceptance receipt"
  );
  assert.match(
    json.reason,
    /TL.*(?:先|before).*accept.*merge|accept.*merge.*前/,
    "must state accept MUST complete before merge"
  );
});
