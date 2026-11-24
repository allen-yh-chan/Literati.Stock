/**
 * MERGED + dispatch-bound + never-started evidence dir → unbound-equivalent clear (D6/T4+T10).
 * Incomplete reservation/receipt still retains.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { readFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";


process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;

const STOP = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const CONTROL_EVIDENCE_HELPER = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");

const tmpRoot = makeTempDir("post-pr-merged-orphan-");
const noGitCwd = tmpRoot;
let counter = 0;

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function makeStateDir() {
  const dir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarkerInStateDir(stateDir, input) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    return writePostPrCompletionMarker(input);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

function runStop(cwd, stateDir, env = {}) {
  return spawnSync("node", [STOP], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_COMPLETION_SESSION_ID: "post-pr-gate-fixture",
      ...env,
    },
    timeout: 30_000,
  });
}

async function loadControlEvidenceHelper() {
  return import(`${pathToFileURL(CONTROL_EVIDENCE_HELPER).href}?orphan=${Date.now()}`);
}

function withCanonicalDispatchBindings(record) {
  return {
    ...record,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
  };
}

test("MERGED + dispatch-bound + missing evidence dir clears (never-started)", () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "missing-control-evidence-orphan");
  const record = {
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "2646",
    head_ref_oid: "cccccccccccccccccccccccccccccccccccccccc",
    dispatch_id: "dispatch-2646-never-started",
  };
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/merged-never-started-dispatch",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  assert.equal(existsSync(evidenceRoot), false, "evidence root must be absent for never-started");

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${record.pr_number}:WARN`,
  });

  assert.equal(result.status, 0, `never-started MERGED must clear; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "never-started dispatch-bound marker must clear");
  assert.doesNotMatch(result.stdout, /"decision":"block"/);
});

test("MERGED + never-started clears without matching sticky dispatch (true orphan)", () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "missing-control-evidence-true-orphan");
  const record = {
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "2652",
    head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dispatch_id: "dispatch-2652-true-orphan",
  };
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/merged-true-orphan",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // No sticky mock, or sticky bound to a different dispatch — never-started clear
  // must not depend on stickyDispatchId === expected_dispatch_id.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:dispatch-other-not-orphan`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${record.pr_number}:WARN`,
  });

  assert.equal(result.status, 0, `true orphan never-started must clear; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "true orphan marker must clear without sticky match");
});

test("MERGED + dispatch-bound + incomplete reservation retains", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence-incomplete");
  const helper = await loadControlEvidenceHelper();
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "2647",
    head_ref_oid: "dddddddddddddddddddddddddddddddddddddddd",
    attempt_id: "second-review-pr-2647-incomplete",
    dispatch_id: "dispatch-2647-incomplete",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/merged-incomplete-dispatch",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${record.pr_number}:WARN`,
  });

  assert.equal(existsSync(markerFile), true, "incomplete receipt path must retain marker");
  // First Stop with still-pending incomplete evidence hard-blocks (exit 2) or
  // soft-reminds (exit 0); either way the marker must remain uncleared.
  assert.ok(
    result.status === 0 || result.status === 2,
    `incomplete retain must not crash; status=${result.status} stderr=${result.stderr}`
  );
  if (result.status === 2) {
    assert.match(result.stdout, /"decision":"block"/);
  }
});

test("dispatchEvidenceNeverStarted distinguishes missing vs reserved", async () => {
  const helper = await loadControlEvidenceHelper();
  assert.equal(
    helper.dispatchEvidenceNeverStarted({
      rootDir: path.join(tmpRoot, "no-such-root"),
      dispatchId: "dispatch-never-existed",
    }),
    true
  );
  const evidenceRoot = path.join(tmpRoot, `evidence-shape-${counter++}`);
  mkdirSync(evidenceRoot, { recursive: true });
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "2648",
    head_ref_oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    attempt_id: "second-review-pr-2648-shape",
    dispatch_id: "dispatch-2648-shape",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  assert.equal(
    helper.dispatchEvidenceNeverStarted({
      rootDir: evidenceRoot,
      dispatchId: record.dispatch_id,
    }),
    false
  );
});

test("dispatchEvidenceNeverStarted is false for staging-only or subdirectory entries", async () => {
  const helper = await loadControlEvidenceHelper();
  const evidenceRoot = path.join(tmpRoot, `evidence-staging-${counter++}`);
  const dispatchId = "dispatch-staging-only";
  const directory = path.join(evidenceRoot, dispatchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, ".staging.tmp"), "in-flight");
  assert.equal(
    helper.dispatchEvidenceNeverStarted({ rootDir: evidenceRoot, dispatchId }),
    false,
    "dot staging must retain (not never-started)"
  );
  const subOnlyRoot = path.join(tmpRoot, `evidence-subdir-${counter++}`);
  const subDispatch = "dispatch-subdir-only";
  const subDir = path.join(subOnlyRoot, subDispatch, "nested");
  mkdirSync(subDir, { recursive: true });
  assert.equal(
    helper.dispatchEvidenceNeverStarted({ rootDir: subOnlyRoot, dispatchId: subDispatch }),
    false,
    "subdirectory alone must retain"
  );
  const emptyRoot = path.join(tmpRoot, `evidence-empty-${counter++}`);
  const emptyDispatch = "dispatch-empty-dir";
  mkdirSync(path.join(emptyRoot, emptyDispatch), { recursive: true });
  assert.equal(
    helper.dispatchEvidenceNeverStarted({ rootDir: emptyRoot, dispatchId: emptyDispatch }),
    true,
    "completely empty directory is never-started"
  );
});
