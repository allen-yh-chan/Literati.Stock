// TC3 (strengthen-cross-review-loop-termination R2/D3): the pr-sticky
// review-round sidecar deliberately outlives the post-PR completion marker
// Stop closes a round sidecar when a session-owned marker is cleared on a
// MERGED or CLOSED snapshot. Orphan state is outside session ownership.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { readFileSync, existsSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import {
  recordReviewRoundDispatch,
  reviewRoundSidecarPath,
} from "../hooks/lib/review-round-budget.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";


process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;

const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const tmpRoot = makeTempDir("review-round-sidecar-test-");
// Non-git cwd: currentBranch() returns "" so branch-aware marker filtering
// never interferes (same pattern as hook-post-pr-completion.test.mjs).
const noGitCwd = tmpRoot;
let counter = 0;

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function makeStateDir() {
  const dir = path.join(tmpRoot, `state-${counter++}`);
  return dir;
}

function withStateDirEnv(stateDir, fn) {
  const prev = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prev;
  }
}

function seedSidecar(stateDir, prNumber, { ageMs = 6 * 60_000, repositorySlug = "devpro-tw/devpro-agent-rules" } = {}) {
  return withStateDirEnv(stateDir, () => {
    recordReviewRoundDispatch({
      cwd: REPO_ROOT,
      prNumber,
      repositorySlug,
      attempt: "initial",
      dispatchId: "dispatch-tc3",
      headRefOid: "a".repeat(40),
      reviewScope: "full-pr",
    });
    const file = reviewRoundSidecarPath({ cwd: REPO_ROOT, prNumber, repositorySlug });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(file, old, old);
    }
    return file;
  });
}

function runStop(stateDir, extraEnv = {}) {
  return spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      ...extraEnv,
    },
  });
}

test("RRS-1: an orphan sidecar for a MERGED PR is outside Stop ownership", () => {
  const stateDir = makeStateDir();
  const sidecar = seedSidecar(stateDir, "8801");
  const result = runStop(stateDir, { DEVPRO_POST_PR_GATE_MOCK_STATE: "8801:MERGED" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(sidecar), true, "orphan sidecar is outside session Stop ownership");
});

test("RRS-2: an orphan sidecar for a CLOSED PR is outside Stop ownership", () => {
  const stateDir = makeStateDir();
  const sidecar = seedSidecar(stateDir, "8802");
  const result = runStop(stateDir, { DEVPRO_POST_PR_GATE_MOCK_STATE: "8802:CLOSED" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(sidecar), true, "orphan sidecar is outside session Stop ownership");
});

test("RRS-3: an orphan sidecar for an OPEN PR retains its timestamp", () => {
  const stateDir = makeStateDir();
  const sidecar = seedSidecar(stateDir, "8803");
  const beforeMtime = statSync(sidecar).mtimeMs;
  const result = runStop(stateDir, { DEVPRO_POST_PR_GATE_MOCK_STATE: "8803:OPEN" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(sidecar), true, "open PR's sidecar must survive (budget continuity)");
  assert.ok(
    statSync(sidecar).mtimeMs === beforeMtime,
    "Stop leaves an orphan sidecar untouched"
  );
});

test("RRS-4: a fresh orphan sidecar is kept", () => {
  const stateDir = makeStateDir();
  const sidecar = seedSidecar(stateDir, "8804", { ageMs: 0 });
  // An orphan sidecar supplies no session-owned marker for the MERGED mock.
  const result = runStop(stateDir, { DEVPRO_POST_PR_GATE_MOCK_STATE: "8804:MERGED" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    existsSync(sidecar),
    true,
    "Stop preserves the fresh orphan sidecar"
  );
});

test("RRS-5: Stop clears only the sidecar for the repository of a merged or closed PR", () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const stateDir = makeStateDir();
    const sidecar = seedSidecar(stateDir, "8805", { ageMs: 0 });
    const other = seedSidecar(stateDir, "8805", { ageMs: 0, repositorySlug: "fixture/elsewhere" });
    const otherBytes = readFileSync(other);
    assert.notEqual(sidecar, other);
    assert.equal(existsSync(sidecar), true);
    const markerFile = withStateDirEnv(stateDir, () => writePostPrCompletionMarker({
      cwd: REPO_ROOT,
      prNumber: "8805",
      branch: "chore/review-round-sidecar-fixture",
      url: "https://github.com/devpro-tw/devpro-agent-rules/pull/8805",
    }));
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);
    const result = runStop(stateDir, { DEVPRO_POST_PR_GATE_MOCK_STATE: `8805:${state}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(markerFile), false, `${state} PR marker must self-heal`);
    assert.equal(existsSync(sidecar), false, "the closed PR's own sidecar is cleared");
    assert.deepEqual(readFileSync(other), otherBytes);
  }
});

test("RRS-6: Stop preserves an unknown legacy sidecar and reports its filename", () => {
  const stateDir = makeStateDir();
  const markerFile = withStateDirEnv(stateDir, () => writePostPrCompletionMarker({
    cwd: REPO_ROOT, prNumber: "8806", branch: "feature/rounds",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/8806",
  }));
  const legacy = withStateDirEnv(stateDir, () => reviewRoundSidecarPath({ prNumber: "8806" }));
  const bytes = JSON.stringify({ schema_version: 1, pr_number: "8806", round_count: 2, dispatch_lineage: [] });
  writeFileSync(legacy, bytes);
  const result = runStop(stateDir, { DEVPRO_POST_PR_GATE_MOCK_STATE: "8806:MERGED" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(markerFile), false);
  assert.equal(readFileSync(legacy, "utf8"), bytes);
  assert.match(result.stderr, /review-round-8806\.json does not prove its expected repository and PR/);
});
