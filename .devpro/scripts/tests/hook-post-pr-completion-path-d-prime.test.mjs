/**
 * hook-post-pr-completion-path-d-prime.test.mjs
 *
 * TB4′ functional (spawned Stop hook) proof: post-pr-completion-check.mjs's
 * Path D′ carve-out — resolved via `resolveStickyFreshness` at the snapshot
 * layer, deriving `snapshot.reviewedHeadRefOid`, which
 * `isAuthoritativeCurrentHeadPass` / `assertDispatchMatchesCurrentSnapshot` /
 * the completion-receipt consistency check all compare against instead of
 * the raw live `headRefOid` — is reachable end-to-end for the intended
 * scenario: a dispatch-bound marker/completion-receipt pinned to a reviewed
 * head H1, while the live PR head has since advanced to H2 via a
 * whitelist-only bookkeeping commit (openspec/changes/**, notes/**).
 *
 * Scenario shape (design.md D2, mirrors fixtures/loop-termination/):
 *   dispatch D1 reserved + completed (PASS) at head H1 → marker bound to
 *   (D1, H1) → live PR head advances to H2 → live sticky comment still says
 *   `last_reviewed_sha: H1` (unchanged, correctly — nothing re-reviewed H2) →
 *   Stop hook run must clear the marker WITHOUT a hard block IF AND ONLY IF
 *   a `gh api compare H1...H2` proves the diff is whitelist-only.
 *
 * All SHAs are documented placeholders — see fixtures/loop-termination/README.md.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { readFileSync, existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
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

const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const CONTROL_EVIDENCE_HELPER = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");

const tmpRoot = makeTempDir("post-pr-completion-path-d-prime-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Non-git directory used as Stop hook cwd — see hook-post-pr-completion.test.mjs's
// `noGitCwd` for why (branch-mismatch early-return never fires; legacy/mock
// markers remain relevant regardless of the worktree's actual current branch).
const noGitCwd = tmpRoot;

let counter = 0;
function makeStateDir() {
  const dir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadControlEvidenceHelper() {
  assert.equal(existsSync(CONTROL_EVIDENCE_HELPER), true, "control-evidence helper must exist");
  return import(`${pathToFileURL(CONTROL_EVIDENCE_HELPER).href}?path-d-prime=${Date.now()}`);
}

function withCanonicalDispatchBindings(record) {
  return {
    ...record,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
  };
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

function runStop(cwd, stateDir, extraEnv = {}) {
  return spawnSync("node", [STOP_HOOK], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      ...extraEnv,
    },
  });
}

// ── Fixed scenario constants (placeholders, form-equivalent 40-hex; see
// fixtures/loop-termination/README.md — not real PR #2407 shas) ───────────

const PR_NUMBER = "8888";
const H1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"; // reviewed head (dispatch/completion pinned here)
const H2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"; // live PR head after a whitelist-only bookkeeping commit
const REPO_SLUG = "devpro-tw/devpro-agent-rules";
const DISPATCH_ID = "dispatch-path-d-prime-a-prime";

const WHITELIST_ONLY_COMPARE = JSON.stringify({
  status: "ahead",
  files: [
    { filename: "openspec/changes/archive/2026-08-30-add-web-theme-locale-design-check/decisions.md" },
  ],
});

const OUTSIDE_WHITELIST_COMPARE = JSON.stringify({
  status: "ahead",
  files: [
    { filename: "openspec/changes/archive/2026-08-30-add-web-theme-locale-design-check/decisions.md" },
    { filename: ".devpro/agent-rules/code-review-checklist.md" },
  ],
});

/**
 * Build the standard "D1 reserved+claimed at H1" dispatch record and its
 * matching marker in `stateDir`. Returns { helper, evidenceRoot, record, markerFile }.
 */
async function setupDispatchAndMarker(stateDir, { stickyVerdictOnReceipt = "PASS" } = {}) {
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: REPO_SLUG,
    pr_number: PR_NUMBER,
    head_ref_oid: H1,
    attempt_id: "second-review-pr-8888-path-d-prime",
    dispatch_id: DISPATCH_ID,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record });
  await helper.writeCompletionReceipt({
    rootDir: evidenceRoot,
    record: {
      ...record,
      schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: stickyVerdictOnReceipt,
      // assertStickyCompletionBinding (second-review-control-evidence.mjs)
      // forces this to equal head_ref_oid (H1) at write time — this is the
      // structural invariant that makes the deep completion-consistency check
      // a plain equality against snapshot.reviewedHeadRefOid, not a second
      // evaluateFreshEquivalent call. See post-pr-completion-check.mjs's
      // inline comment at that check.
      sticky_last_reviewed_sha: record.head_ref_oid,
      sticky_dispatch_id: record.dispatch_id,
      sticky_comment_id: 4242,
      sticky_comment_url: `https://github.com/${REPO_SLUG}/pull/${PR_NUMBER}#issuecomment-4242`,
      process_close_observed: true,
    },
  });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: PR_NUMBER,
    branch: "feature/path-d-prime-a-prime",
    repositorySlug: REPO_SLUG,
    headRefOid: H1,
    expectedDispatchId: DISPATCH_ID,
  });
  // Age the marker past REMIND_AFTER_MS (0 in this repo, but keep the
  // pattern the rest of the suite uses for realism/consistency).
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  return { helper, evidenceRoot, record, markerFile };
}

function liveEnv({ headSha = H2, stickySha = H1, verdict = "PASS", extra = {} } = {}) {
  return {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: PR_NUMBER,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${PR_NUMBER}:${headSha}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${PR_NUMBER}:${stickySha}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${PR_NUMBER}:${DISPATCH_ID}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${PR_NUMBER}:${verdict}`,
    ...extra,
  };
}

// ── (a′) positive: whitelist-only compare → clears, no hard block ─────────

test("PDPP-1 (a′): head advanced H1→H2 by a whitelist-only bookkeeping commit, compare proves it → Stop hook clears the marker, no hard block", async () => {
  const stateDir = makeStateDir();
  const { evidenceRoot, markerFile } = await setupDispatchAndMarker(stateDir);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...liveEnv(),
    CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT: WHITELIST_ONLY_COMPARE,
  });

  assert.equal(result.status, 0, `expected clean clear (exit 0), got status=${result.status} stderr=${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "marker must be cleared");
});

// ── negative: compare proves NON-whitelist-only → stays pending, same block shape ──

test("PDPP-2: compare includes a file outside the whitelist → marker stays pending, hard-block unchanged", async () => {
  const stateDir = makeStateDir();
  const { evidenceRoot, markerFile } = await setupDispatchAndMarker(stateDir);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...liveEnv(),
    CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT: OUTSIDE_WHITELIST_COMPARE,
  });

  assert.equal(result.status, 2, `expected hard block (exit 2), got status=${result.status} stdout=${result.stdout}`);
  assert.equal(existsSync(markerFile), true, "marker must remain pending");
  let payload = null;
  try { payload = JSON.parse(result.stdout); } catch { /* fall through to assertion below */ }
  assert.equal(payload?.decision, "block", `expected the standard { decision: "block" } shape, got: ${result.stdout}`);
});

// ── negative: compare unavailable (no compare mock at all) → stays pending ──

test("PDPP-3: compare unavailable (no compare mock — hermetic guard fires) → marker stays pending, fail closed", async () => {
  const stateDir = makeStateDir();
  const { evidenceRoot, markerFile } = await setupDispatchAndMarker(stateDir);

  // Deliberately NOT setting CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT/_ERROR:
  // DEVPRO_POST_PR_GATE_MOCK_* is present (via liveEnv()), so
  // fresh-equivalent-compare.mjs's hermetic guard fires
  // (reason: "compare-mock-guard") without spawning `gh` — same fail-closed
  // outcome a genuinely unavailable compare would produce.
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...liveEnv(),
  });

  assert.equal(result.status, 2, `expected hard block (exit 2), got status=${result.status} stdout=${result.stdout}`);
  assert.equal(existsSync(markerFile), true, "marker must remain pending");
});

// ── negative: CRITICAL verdict + would-be-equivalent compare → still blocks ──

test("PDPP-4: sticky verdict CRITICAL with an otherwise-equivalent compare → still blocks (equivalence only waives READY verdicts)", async () => {
  const stateDir = makeStateDir();
  const { evidenceRoot, markerFile } = await setupDispatchAndMarker(stateDir, { stickyVerdictOnReceipt: "PASS" });

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    ...liveEnv({ verdict: "CRITICAL" }),
    CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT: WHITELIST_ONLY_COMPARE,
  });

  assert.equal(result.status, 2, `CRITICAL must still block even with a whitelist-only compare, got status=${result.status} stdout=${result.stdout}`);
  assert.equal(existsSync(markerFile), true, "marker must remain pending");
});
