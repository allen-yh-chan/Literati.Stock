import "./lib/isolated-control-evidence-state.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveReminderSession } from "../hooks/lib/session-reminder.mjs";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { appendChangeUsageOverride, readChangeUsageCheckpoint } from "../hooks/lib/change-usage-checkpoint.mjs";
import { repoPath } from "./lib/repo-root.mjs";

// The cost section's heading says "exceeded" when a stopping threshold is over its
// limit and "blocked（無法判定，不是超標）" when the stop is an unjudgeable stall.
// Presence/absence of the section is asserted against either heading; the wording of
// each one is pinned where a test is about that distinction.
const COST_BLOCK_HEADING = /### Cost circuit breaker (?:exceeded|blocked)/;

// The line the hook writes to stderr when the usage cache fails for a reason other than the
// ordinary ones (no file yet, unreadable file, corrupt JSON). Anything else in that path is a
// bug in the hook, and the cache falling through must not hide it.
const COST_CACHE_FAULT = /post-pr-completion-check: cost usage cache (?:read|write) failed unexpectedly/;
import { makeTempDir } from "./lib/tmp.mjs";
import { recordReviewRoundDispatch, reviewRoundSidecarPath } from "../hooks/lib/review-round-budget.mjs";
import {
  seedResolvableChangeCostUsage,
  withChangeUsageStateDir,
} from "./lib/change-usage-fixtures.mjs";

// R4/D11/D12 (task 7) integration-level wiring proof. The full evaluation
// matrix (grammar/folder/checkpoint resolution, multiset comparison, `at`
// normalization, etc.) is already exhaustively unit-tested in
// post-pr-cost-circuit-breaker.test.mjs against the pure evaluator functions
// directly — these tests exist only to prove post-pr-completion-check.mjs's
// OWN wiring: branch/prBody extraction from the (mocked) PR snapshot, the
// new mock env var plumbing, and the block-message integration into main()'s
// existing soft-reminder/hard-block machinery. Mirrors task 6's own test-
// scope-narrowing precedent (decisions.md task 6 section).


// These gate fixtures explicitly own their PRs. Existing gate assertions read
// the full scoped diagnostic; the isolation suite asserts the compact transport.
process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;
process.env.DEVPRO_AGENT_RULES_LEVEL = "full";

const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const tmpRoot = makeTempDir("post-pr-completion-ccb-test-");

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let counter = 0;
function makeStateDir() {
  const dir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCwdWithActiveChangeFolder(changeName) {
  const cwd = path.join(tmpRoot, `cwd-${counter++}`);
  mkdirSync(path.join(cwd, "openspec", "changes", changeName), { recursive: true });
  return cwd;
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function writeMarker(stateDir, input) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    return writePostPrCompletionMarker(input);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

// `fix-zero-value-review-rounds` R1/D19 row 3 / `fix-second-review-loop-
// friction` D1/D3: the three cumulative totals no longer block this hook, and
// (since D1) there is no cost-side `round` threshold left to block through
// either — `stalled_rounds` is the ONLY threshold that still blocks. Every
// test below whose subject IS the block machinery (the cache TTL, the
// once-per-window downgrade, override consumption, mixed-state) reaches it
// via `seedUnreadableReceipt` over a real repo cwd (`makeRepoCwd
// WithActiveChangeFolder`, see below) — the same recipe CCB-18/20 use — since
// `stalled_rounds` resolves `not-applicable` (never blocking) outside a repo.
// The cumulative overage stays seeded in each of them on purpose: it must
// still be reported in the block body, and an exact-set override must still
// name it alongside `stalled_rounds`.

// Slices the advisory section out of a merged hook body, so a negative
// assertion about the advisory ("it carries no numbered options") is about the
// advisory and not about whichever sections happen to share the turn with it.
// A whole-body `doesNotMatch` passes trivially on an advisory-only turn and
// says nothing about the case that actually matters: one marker blocking on
// `stalled_rounds` while another is advisory-only, which puts the block's
// option list and the advisory in the same message.
const ADVISORY_HEADING = "### Cost circuit breaker advisory (not a stop)";
function advisorySectionOf(body) {
  const start = body.indexOf(ADVISORY_HEADING);
  if (start === -1) return null;
  const rest = body.slice(start + ADVISORY_HEADING.length);
  const next = rest.indexOf("\n### ");
  return ADVISORY_HEADING + (next === -1 ? rest : rest.slice(0, next));
}

function runStop(cwd, stateDir, extraEnv = {}, hook = STOP_HOOK) {
  return spawnSync("node", [hook], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      ...extraEnv,
    },
  });
}

const HEAD_SHA = "c".repeat(40);

test("owned CLOSED cancellation evaluates cost and override disclosure before retiring the last round", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-closed-last-round";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    appendChangeUsageOverride({cwd, changeName, session_id: "closed-fixture", at: "2026-01-01T00:00:00.000Z", thresholds: ["review_round"], head_ref_oid: HEAD_SHA});
    const markerFile = writeMarker(stateDir, {cwd, prNumber: "9090", branch: `chore/${changeName}`});
    const prior = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
    const reviewTarget = { cwd, prNumber: "9090", repositorySlug: "devpro-tw/devpro-agent-rules" };
    let roundFile;
    try {
      for (let n = 1; n <= 3; n++) recordReviewRoundDispatch({ ...reviewTarget, attempt: "initial", dispatchId: `closed-round-${n}`, headRefOid: HEAD_SHA, reviewScope: "full-pr" });
      roundFile = reviewRoundSidecarPath(reviewTarget);
    } finally {
      if (prior === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
      else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prior;
    }
    assert.equal(JSON.parse(readFileSync(roundFile, "utf8")).round_count, 3);
    const old = new Date(Date.now() - 35_000); utimesSync(markerFile, old, old);
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STATE: "9090:CLOSED",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9090:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9090:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9090:${b64("## Cost Circuit Breaker Overrides\nN/A\n")}`,
      DEVPRO_TEST_CLAUDE_ROOT: path.join(cwd, "empty-claude-root"),
    });
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, COST_BLOCK_HEADING);
    assert.match(output.reason, /stalled_rounds/);
    assert.match(output.reason, /override disclosure mismatch/);
    assert.match(result.stderr, /CLOSED.*obligation canceled/);
    assert.equal(existsSync(markerFile), false);
    assert.equal(existsSync(roundFile), false);
    assert.equal(runStop(cwd, stateDir).stdout, "", "retired PR cannot trigger another reminder");
  });
});

test("CCB-1: cost-budget hit blocks with numbered stop-point options, even though cross-review self-heals (no Pending PRs boilerplate)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-over-threshold";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      outputTokens: 900_000, // clears COST_BUDGET_THRESHOLDS.output (see cost-budget.mjs)
    });
    // `stalled_rounds` is the only threshold that still blocks
    // (fix-second-review-loop-friction D1/D3); an unreadable receipt chain is
    // the cheapest reachable way to put it in a blocking state (CCB-18's
    // recipe).
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9001",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    // F-4ad9250c: a correct N/A body isolates this test to the cost-budget
    // section alone — without it, empty overrides[] + no declared section
    // ALSO trips evaluateOverrideDisclosure's block, unasserted, on the same
    // code path F-c3472c23 fixed (see post-pr-cost-circuit-breaker.test.mjs's
    // dedicated prBody==null tests for the direct pin of that fix).
    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9001", // cross-review already fresh → self-heals/clears
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9001:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9001:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9001:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      HOME: cwd,
    });

    assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    // `output` really is over its limit, but it is advisory: the thing that stops
    // this turn is the unjudgeable stall, so the heading follows the stop, not the
    // accompanying total.
    assert.doesNotMatch(json.reason, /Cost circuit breaker exceeded/);
    assert.match(json.reason, /### Cost circuit breaker blocked（無法判定，不是超標）/);
    assert.match(json.reason, new RegExp(`report-session-token-usage\\.mjs --since-change ${changeName} --budget-check`), "the unavailable row names its re-check command");
    // T6: a threshold whose `limit` is null renders label-only, because there
    // is no number in the table to compare against. This body carries both
    // kinds at once — `stalled_rounds` (limit-null, unavailable) and `output`
    // (numeric) — so it is where the generalized branch is observable
    // end-to-end.
    assert.doesNotMatch(json.reason, /undefined/, "a limit-null threshold must not render a value it does not have");
    assert.doesNotMatch(json.reason, /> null/, "nor a comparison against a limit this table does not hold");
    // Deliberately asserts the SHAPE, not the number: cost-budget.test.mjs
    // grep-locks the three limits to their own module and counts occurrences
    // in prose too, so quoting one here would be the same regression 7e0a120a
    // fixed.
    assert.match(json.reason, /cumulative output tokens since change start: \d+ > \d+ tokens/, "a numeric threshold still renders its real comparison");
    // The block narrowed to `stalled_rounds`; the report did not (D14).
    // `output` is advisory now and still appears verbatim in the body.
    assert.match(json.reason, /output/);
    assert.match(json.reason, /`stalled_rounds`/);
    assert.match(json.reason, /PR #9001/);
    assert.match(json.reason, new RegExp(changeName));
    assert.match(json.reason, /1\. 是/);
    assert.match(json.reason, /2\. 否/);
    assert.match(json.reason, /3\. 其他/);
    assert.doesNotMatch(json.reason, /Pending PRs:/);
    assert.doesNotMatch(json.reason, /override disclosure mismatch/);
  });
});

test("CCB-2: cost-budget not exceeded (usage under threshold) does not add a cost circuit breaker section", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-under-threshold";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      outputTokens: 5,
    });
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9002",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    // seedResolvableChangeCostUsage makes overrides[] genuinely resolvable
    // (empty array, not unavailable) — S-1 is therefore also active for this
    // marker, so the PR body must correctly declare `N/A` to isolate this
    // test to its actual target (the cost-budget section), matching
    // evaluateOverrideDisclosure's own "empty overrides + N/A body -> ok"
    // contract already proven in post-pr-cost-circuit-breaker.test.mjs.
    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "", // no sticky → still-pending cross-review, existing behavior
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9002:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9002:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      HOME: cwd,
    });

    assert.equal(result.status, 2, `expected hard block from existing cross-review gate; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.doesNotMatch(json.reason, COST_BLOCK_HEADING);
    assert.doesNotMatch(json.reason, /override disclosure mismatch/);
  });
});

test("CCB-3: branch-derived change_name unresolvable (no matching folder) does not block on cost, existing cross-review reason unaffected", () => {
  const stateDir = makeStateDir();
  const cwd = makeTempDir("post-pr-completion-ccb-nofolder-");
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9003",
    branch: "chore/no-such-change-anywhere",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "9003:chore/no-such-change-anywhere",
  });

  assert.equal(result.status, 2, `expected hard block from existing cross-review gate; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.doesNotMatch(json.reason, COST_BLOCK_HEADING);
  assert.doesNotMatch(json.reason, /override disclosure mismatch/);
  assert.match(json.reason, /PR #9003/);
});

test("CCB-4: grammar-invalid stripped remainder (uppercase) does not block on cost — independent of folder-not-exist (D12 F-5-5)", () => {
  const stateDir = makeStateDir();
  // Folder exists (matches the malformed name) — proves the short-circuit is
  // on grammar, not merely coincident with a missing folder.
  const changeName = "Has-Uppercase-Remainder";
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9004",
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9004:chore/${changeName}`,
  });

  assert.equal(result.status, 2, `expected hard block from existing cross-review gate; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.doesNotMatch(json.reason, COST_BLOCK_HEADING);
  assert.doesNotMatch(json.reason, /override disclosure mismatch/);
});

test("CCB-5: archive glob matching more than one entry resolves unavailable, not a cost block (repo-anomaly guard)", () => {
  const stateDir = makeStateDir();
  const changeName = "ccb-dup-archive";
  const cwd = path.join(tmpRoot, `cwd-${counter++}`);
  mkdirSync(path.join(cwd, "openspec", "changes", "archive", `2026-01-01-${changeName}`), { recursive: true });
  mkdirSync(path.join(cwd, "openspec", "changes", "archive", `2026-06-01-${changeName}`), { recursive: true });
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9005",
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9005:chore/${changeName}`,
  });

  assert.equal(result.status, 2, `expected hard block from existing cross-review gate; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.doesNotMatch(json.reason, COST_BLOCK_HEADING);
  assert.doesNotMatch(json.reason, /override disclosure mismatch/);
});

test("CCB-6: S-1 override disclosure mismatch blocks with numbered stop-point options, reading PR body via the new mock env var", () => {
  const stateDir = makeStateDir();
  const changeName = "ccb-s1-mismatch";
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  appendChangeUsageOverride({
    cwd,
    changeName,
    session_id: "s1",
    at: "2026-01-01T00:00:00.000Z",
    thresholds: ["output"],
    head_ref_oid: HEAD_SHA,
  });
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9006",
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const prBody = "## Cost Circuit Breaker Overrides\nN/A\n"; // non-empty overrides[] but body says N/A → S-1 mismatch
  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "9006",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9006:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9006:${HEAD_SHA}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9006:${b64(prBody)}`,
  });

  assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, "block");
  assert.match(json.reason, /override disclosure mismatch/);
  assert.match(json.reason, /PR #9006/);
  assert.match(json.reason, /1\. 是/);
  assert.match(json.reason, /2\. 否/);
  assert.match(json.reason, /3\. 其他/);
});

test("CCB-6b: S-1 override disclosure mismatch prints the exact lines the PR body should hold, derived from the checkpoint", () => {
  const stateDir = makeStateDir();
  const changeName = "ccb-s1-expected-lines";
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  appendChangeUsageOverride({
    cwd,
    changeName,
    session_id: "s1",
    at: "2026-01-01T00:00:00.000Z",
    thresholds: ["output"],
    head_ref_oid: HEAD_SHA,
  });
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9061",
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "9061",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9061:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9061:${HEAD_SHA}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9061:${b64(prBody)}`,
  });

  assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /override disclosure mismatch/);
  assert.ok(
    json.reason.includes(`- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_SHA}`),
    `the block must print the canonical line the PR body should hold; got: ${json.reason}`,
  );
  // The numbered options still hand the choice to the user: printing the lines does not pick option 2.
  assert.match(json.reason, /2\. 否/);
});

test("CCB-7: S-1 matching disclosure does not block on override disclosure", () => {
  const stateDir = makeStateDir();
  const changeName = "ccb-s1-match";
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  appendChangeUsageOverride({
    cwd,
    changeName,
    session_id: "s1",
    at: "2026-01-01T00:00:00.000Z",
    thresholds: ["output"],
    head_ref_oid: HEAD_SHA,
  });
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9007",
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const prBody = `## Cost Circuit Breaker Overrides\n- at=2026-01-01T00:00:00Z thresholds=output head_ref_oid=${HEAD_SHA}\n`;
  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "9007",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9007:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9007:${HEAD_SHA}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9007:${b64(prBody)}`,
  });

  assert.equal(result.status, 0, `expected clean self-heal; stdout: ${result.stdout} stderr: ${result.stderr}`);
});

// R4/D10 (task 7 defect fix, found during self-review before commit): pins
// the cost-usage-cache throttle added to post-pr-completion-check.mjs after
// discovering `REMIND_AFTER_MS = 0` means the marker loop — and therefore
// `evaluatePostPrCostBudget` — runs on EVERY Stop-hook turn, not once per
// review round. Without a cache, that re-reads every session transcript in
// the change's checkpoint on every turn (see decisions.md's task 7
// cost-usage-cache finding). A file-mtime/atime-based read-count assertion
// would be unreliable (atime is often disabled on macOS); instead this test
// proves caching BEHAVIORALLY: seed a real transcript, exceed the budget on
// run 1, delete the transcript, then prove run 2 (within the cache TTL)
// still reports the SAME exceeded state — which is only possible if it used
// the cached usage rather than re-reading the now-missing file. CCB-9 is the
// negative control proving that claim: with no cache available, a deleted
// transcript genuinely flips the result to not-exceeded (F-5-3's documented
// under-measurement direction), so CCB-8's "still exceeded" is real evidence
// of caching, not a vacuous assertion true under any implementation.
//
// F-0fe5da39 fix: run 2 also lands within HARD_BLOCK_DEDUP_MS of run 1's
// hard block, so it now downgrades to a soft reminder (exit 0) instead of
// hard-blocking again — that is the fix, not a regression. What still has
// to survive from cache is the exceeded-cost CONTENT: run 2's systemMessage
// must still carry `costBudgetSection` (still says "Cost circuit breaker
// exceeded") rather than silently dropping it, which is exactly what a
// pre-fix version that never downgraded, or a post-fix version that dropped
// the section on the downgrade path, would each fail differently.
test("CCB-8: second runStop within the cache TTL reuses cached cost-budget usage even after the transcript file is deleted", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-cache-reuse";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId,
      outputTokens: 900_000, // clears COST_BUDGET_THRESHOLDS.output
    });
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9008",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const cacheStateDir = makeStateDir();
    // F-4ad9250c: N/A body isolates this test to the cost-budget-cache
    // behavior under test — see CCB-1's comment for why an absent body would
    // otherwise also (unassertedly) trip evaluateOverrideDisclosure.
    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const baseEnv = {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "", // no sticky → still-pending, marker survives both runs
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9008:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9008:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR: cacheStateDir,
      HOME: cwd,
    };

    const run1 = runStop(cwd, stateDir, baseEnv);
    assert.equal(run1.status, 2, `expected hard block on run 1; stderr: ${run1.stderr}`);
    assert.match(JSON.parse(run1.stdout).reason, COST_BLOCK_HEADING);
    assert.doesNotMatch(JSON.parse(run1.stdout).reason, /override disclosure mismatch/);
    assert.doesNotMatch(run1.stderr, COST_CACHE_FAULT, "a missing cache file is the ordinary first-run case, not a fault");

    // The transcript this session's usage was resolved from is now gone.
    rmSync(path.join(claudeRoot, "projects", "proj", `${sessionId}.jsonl`), { force: true });

    const run2 = runStop(cwd, stateDir, baseEnv);
    assert.equal(
      run2.status,
      0,
      `expected run 2 to downgrade to a soft reminder (F-0fe5da39 fix); stderr: ${run2.stderr}`
    );
    assert.match(
      JSON.parse(run2.stdout).systemMessage,
      COST_BLOCK_HEADING,
      "run 2's downgraded systemMessage must still report exceeded from the cached usage, not silently drop the section because the transcript is gone"
    );
    // The heading no longer tells the cached case apart (the stop here is the
    // unjudgeable stall either way), so the cache is pinned by what only it can
    // supply: run 2's transcript is gone, yet the advisory `output` total from run 1
    // is still reported. A cache that never hits (the TTL constant had been deleted
    // while its use stayed, and the ReferenceError was swallowed by the fall-through
    // `catch`) re-resolves to zeros here and drops this row.
    assert.match(
      JSON.parse(run2.stdout).systemMessage,
      /`output` — cumulative output tokens since change start: 900000 > 800000 tokens/,
      "run 2 must report the cached output total, not a fresh resolve of the deleted transcript",
    );
    assert.doesNotMatch(JSON.parse(run2.stdout).systemMessage, /override disclosure mismatch/);
    assert.doesNotMatch(run2.stderr, COST_CACHE_FAULT, "a cache hit is not a fault");
  });
});

test("CCB-9 (negative control for CCB-8): with no cache present, a deleted transcript genuinely resolves not-exceeded", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-cache-control";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId,
      outputTokens: 900_000,
    });
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9009",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    // Transcript deleted BEFORE the only run — no prior cache write exists
    // for this change (fresh cacheStateDir, never populated).
    rmSync(path.join(claudeRoot, "projects", "proj", `${sessionId}.jsonl`), { force: true });

    // F-4ad9250c: N/A body isolates this test to the cache-control behavior
    // under test — see CCB-1's comment.
    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9009:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9009:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR: makeStateDir(),
      HOME: cwd,
    });

    assert.equal(result.status, 2, `expected hard block from existing cross-review gate; stderr: ${result.stderr}`);
    assert.doesNotMatch(JSON.parse(result.stdout).reason, COST_BLOCK_HEADING);
    assert.doesNotMatch(JSON.parse(result.stdout).reason, /override disclosure mismatch/);
  });
});

// R4/D10 (task 7 defect fix): CCB-8/9 pin that a fresh cache entry is
// reused; this pins the other side — a cache entry OLDER than
// COST_USAGE_CACHE_TTL_MS (5 min, see post-pr-completion-check.mjs) MUST NOT
// be trusted forever. A sign/off-by-one bug in the TTL comparison would
// silently make a real budget breach invisible for good, which is exactly
// the failure mode this whole change exists to prevent. The stale cache file
// is hand-written directly (change names here are plain kebab-case, so the
// `<changeName>.json` filename needs no sanitization to predict) — this
// keeps the test independent of post-pr-completion-check.mjs's internal
// cache functions, which are not exported (this file only tests the hook's
// subprocess-level behavior, matching this suite's established scope).
test("CCB-10: a cache entry older than the TTL is treated as stale, not trusted forever", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-cache-ttl-expiry";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      outputTokens: 900_000, // genuinely exceeds — proves a fresh resolve happened
    });
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9010",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const cacheStateDir = makeStateDir();
    mkdirSync(cacheStateDir, { recursive: true });
    const staleCachedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min > 5 min TTL
    writeFileSync(
      path.join(cacheStateDir, `${changeName}.json`),
      JSON.stringify({
        cachedAt: staleCachedAt,
        usage: { coverage: "complete", totals: { output: 0, cache_read: 0, model_time_ms: 0 }, sessions: [] },
      })
    );

    // F-4ad9250c: N/A body isolates this test to the cache-TTL behavior under
    // test — see CCB-1's comment.
    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9010:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9010:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR: cacheStateDir,
      HOME: cwd,
    });

    assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
    assert.match(
      JSON.parse(result.stdout).reason,
      COST_BLOCK_HEADING,
      "a 10-minute-old (stale) cached usage of 0 must be bypassed in favor of a fresh resolve against the real (exceeding) transcript"
    );
    assert.doesNotMatch(JSON.parse(result.stdout).reason, /override disclosure mismatch/);
  });
});

// The CCB-8 setup up to its first Stop run: an over-budget transcript, an unreadable receipt
// chain (so the hook blocks) and a pending marker. `prNumber` and `sessionId` only keep one
// scenario's fixtures apart from the next.
function seedCacheScenario({ changeName, prNumber, sessionId }) {
  const stateDir = makeStateDir();
  const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
  const claudeRoot = path.join(cwd, "claude-root");
  seedResolvableChangeCostUsage({ claudeRoot, changeName, sessionId, outputTokens: 900_000 });
  seedUnreadableReceipt(cwd, changeName);
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber,
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const cacheStateDir = makeStateDir();
  const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
  const env = {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `${prNumber}:${b64(prBody)}`,
    DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
    DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR: cacheStateDir,
    HOME: cwd,
  };
  const cacheFile = path.join(cacheStateDir, `${changeName}.json`);
  return { stateDir, cwd, env, cacheFile };
}

// A copy of the Stop hook with one source edit, written under tmpRoot rather than into the
// source tree. Its relative imports are rewritten to absolute file URLs so it loads the same
// modules the real hook does. The edit must change the source, or the variant is the real hook
// and a test built on it proves nothing.
function writeHookVariant(name, edit) {
  const source = readFileSync(STOP_HOOK, "utf8");
  const edited = edit(source);
  assert.notEqual(edited, source, "the variant edit must change the hook source");
  const hooksDir = path.dirname(STOP_HOOK);
  const rebased = edited.replace(
    /(\bfrom\s+)"(\.{1,2}\/[^"]+)"/g,
    (_match, keyword, specifier) => `${keyword}"${pathToFileURL(path.resolve(hooksDir, specifier)).href}"`,
  );
  // realpath: the hook's entry-point guard compares import.meta.url (real path) with argv[1], and
  // os.tmpdir() is a symlink on macOS — an unresolved path would make the variant exit without running.
  const file = path.join(realpathSync(tmpRoot), name);
  writeFileSync(file, rebased);
  return file;
}

// The bug this guards: the definition of COST_USAGE_CACHE_TTL_MS was deleted while its use stayed.
// The ReferenceError was swallowed by the cache read's fall-through `catch`, so the cache simply
// never hit and every Stop turn re-read the transcripts — with nothing reporting it. CCB-8 only
// sees the symptom (no cache hit); this pins that the cause is named on stderr.
test("CCB-21: a programming error in the usage cache is named on stderr, and the hook still falls through to a fresh resolve", () => {
  withChangeUsageStateDir(() => {
    // A fresh, valid cache entry so the read reaches the TTL comparison.
    const withFreshCache = (changeName, prNumber, sessionId) => {
      const scenario = seedCacheScenario({ changeName, prNumber, sessionId });
      writeFileSync(scenario.cacheFile, JSON.stringify({ cachedAt: new Date().toISOString(), usage: undefined }));
      return scenario;
    };

    const broken = withFreshCache("ccb-cache-fault", "9021", "21212121-2121-2121-2121-212121212121");
    const variant = writeHookVariant("hook-without-ttl-constant.mjs", source =>
      source.replace(/^const COST_USAGE_CACHE_TTL_MS = .*\n/m, ""),
    );
    const faulted = runStop(broken.cwd, broken.stateDir, broken.env, variant);
    assert.match(
      faulted.stderr,
      /post-pr-completion-check: cost usage cache read failed unexpectedly \(ReferenceError: COST_USAGE_CACHE_TTL_MS is not defined\)/,
      "the cause must be named, not swallowed",
    );
    assert.equal(faulted.status, 2, `the fault still falls through to a fresh resolve and the stop is unchanged; stderr: ${faulted.stderr}`);
    assert.match(JSON.parse(faulted.stdout).reason, COST_BLOCK_HEADING);

    // Control: the same kind of cache entry through the real hook is read without a fault.
    const intact = withFreshCache("ccb-cache-fault-control", "9023", "23232323-2323-2323-2323-232323232323");
    const real = runStop(intact.cwd, intact.stateDir, intact.env);
    assert.equal(real.status, 2, `expected hard block; stderr: ${real.stderr}`);
    assert.doesNotMatch(real.stderr, COST_CACHE_FAULT);
  });
});

// The ordinary ways the cache read fails stay quiet: a stray fault line on every Stop turn would
// teach everyone to ignore it, which is the same as not having it.
for (const [label, writeBadCache] of [
  ["a corrupt cache file", file => writeFileSync(file, "{not json")],
  ["a directory where the cache file should be", file => mkdirSync(file)],
]) {
  test(`CCB-22: ${label} falls through to a fresh resolve without a fault line`, () => {
    withChangeUsageStateDir(() => {
      const { stateDir, cwd, env, cacheFile } = seedCacheScenario({
        changeName: "ccb-cache-ordinary-fault",
        prNumber: "9022",
        sessionId: "22222222-2222-2222-2222-222222222222",
      });
      writeBadCache(cacheFile);
      const result = runStop(cwd, stateDir, env);
      assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
      assert.match(JSON.parse(result.stdout).reason, COST_BLOCK_HEADING);
      assert.doesNotMatch(result.stderr, COST_CACHE_FAULT);
    });
  });
}

// D11/task 8 wiring proof at THIS call site. The six negative + one positive
// matrix for resolveCostBudgetOverride itself lives in
// cost-budget-override.test.mjs (module-level, no subprocess spawn needed);
// these two tests only prove post-pr-completion-check.mjs's marker loop
// actually consumes it. DEVPRO_POST_PR_GATE_MOCK_STICKY stays "" (still-
// pending cross-review, same baseline as CCB-2/CCB-3) deliberately, so the
// overall block/no-block outcome is decoupled from self-heal and from S-1
// (whose own contract is already covered by CCB-6/CCB-7) — each test's
// assertion is scoped to the cost-budget section alone, matching this
// suite's established narrow-assertion convention.
test("CCB-11: an exact-set-matching override with a resolvable session unblocks the cost-budget section and records overrides[]", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-override-effective";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      outputTokens: 900_000, // clears COST_BUDGET_THRESHOLDS.output
    });
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9011",
      branch: `chore/${changeName}`,
      sessionId: "11111111-1111-1111-1111-111111111111",
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "", // still-pending cross-review — decouples from self-heal/S-1
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9011:chore/${changeName}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      HOME: cwd,
      // Exact-set (D11) over the FULL exceeded set, advisory members
      // included: narrowing it to the blocking subset would turn an
      // already-declared `output,stalled_rounds` into a mismatch and block a
      // user who was previously let through.
      DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:output,stalled_rounds`,
      // captureTlHostSession requires UUID shape — see the analogous note in
      // render-second-review-packet.test.mjs's cost-budget override test.
      CODEX_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      CLAUDE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
      DEVPRO_POST_PR_COMPLETION_SESSION_ID: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(result.status, 2, `expected block from the pre-existing cross-review gate; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.doesNotMatch(
      json.reason,
      COST_BLOCK_HEADING,
      "an effective override must remove the cost-budget block even though the transcript genuinely exceeds threshold"
    );
    // F-4ad9250c: this test cannot supply a PR body disclosing the override
    // written above — resolveCostBudgetOverride's `at` is the real wall-clock
    // time inside the subprocess (no mock hook exists for it), so a matching
    // `- at=... thresholds=... head_ref_oid=...` line can't be constructed
    // ahead of time. The override IS real and genuinely undisclosed (no
    // DEVPRO_POST_PR_GATE_MOCK_BODY_B64 set), so evaluateOverrideDisclosure
    // correctly, independently blocks too — pinned explicitly here (rather
    // than left unasserted) so this stays a documented, expected side effect
    // instead of silently masking a future regression in that check. S-1's
    // own pass/fail contract is covered by CCB-6/CCB-7.
    assert.match(json.reason, /override disclosure mismatch/);

    // The override cleared the block, but the totals were still measured, so
    // they are still reported (D14). This is the only branch that carries a
    // still-blocking threshold's name into an advisory body, and this turn is
    // also the one where an advisory shares a message with a block -- so the
    // "no numbered options" property is asserted here on the section itself,
    // where it is not vacuous.
    const advisory = advisorySectionOf(json.reason);
    assert.ok(advisory, "an override that clears the block must still report what it cleared");
    // Matched on the rendered ROW, not the bare token. The section's own
    // prose now names `stalled_rounds` when it explains what still blocks, so
    // a bare-token match would be satisfied by the closing line and would
    // assert nothing about what was actually measured.
    assert.match(advisory, /^ {2}- `output` — /mu, "the advisory names the threshold key, not just its label");
    assert.match(json.reason, /^\s*1\. /m, "this turn really does carry a block's option list (S-1's), which is what makes the next assertion non-vacuous");
    assert.doesNotMatch(advisory, /^\s*1\. /m, "an advisory must never present a user decision, block or no block");

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.overrides.length, 1);
    assert.equal(checkpoint.overrides[0].session_id, "11111111-1111-1111-1111-111111111111");
    assert.deepEqual(checkpoint.overrides[0].thresholds, ["output", "stalled_rounds"]);
  });
});

test("CCB-12: a change-name-mismatched override does NOT unblock the cost-budget section (ineffective override falls through to the pre-existing block)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-override-ineffective";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "12121212-1212-1212-1212-121212121212",
      outputTokens: 900_000,
    });
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9012",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    // F-4ad9250c: N/A body isolates this test to the ineffective-override
    // behavior under test — overrides[] stays empty (asserted below), so
    // this is the same empty-overrides[]+N/A shape as CCB-1; see its comment.
    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9012:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9012:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      HOME: cwd,
      DEVPRO_COST_BUDGET_OVERRIDE: "some-other-change:output,stalled_rounds", // does not match changeName
      CLAUDE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
    assert.match(JSON.parse(result.stdout).reason, COST_BLOCK_HEADING);
    assert.doesNotMatch(JSON.parse(result.stdout).reason, /override disclosure mismatch/);

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.overrides.length, 0, "an ineffective override MUST NOT append anything to overrides[]");
  });
});

// F-c3472c23 (round 3 Critical): the live gh-failure scenario the fix
// targets is `fetchPrSnapshot` returning `null` — DEVPRO_POST_PR_GATE_MOCK_
// SNAPSHOT_UNAVAILABLE is the only mock lever that reproduces it (unlike
// CCB-1/8/9/10/11/12 above, whose absent-BODY_B64 default is a fetched,
// genuinely-empty prBody, not a failed fetch — see change-usage-checkpoint's
// evaluateOverrideDisclosure comment and post-pr-cost-circuit-breaker.test.mjs's
// dedicated unit-level prBody==null tests for that distinction). `evalBranch`
// still resolves from `marker.branch` (post-pr-completion-check.mjs's
// existing `snapshot?.headRefName || marker.branch` fallback), so the
// checkpoint is still reachable and a genuine disclosure block would still
// have been possible before the fix — this test proves it no longer is.
test("CCB-13: PR snapshot fetch failure (prBody unavailable) does not block on override disclosure (F-c3472c23)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-snapshot-unavailable";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    seedResolvableChangeCostUsage({
      claudeRoot: path.join(cwd, "claude-root"),
      changeName,
      sessionId: "13131313-1313-1313-1313-131313131313",
      outputTokens: 1, // under threshold — isolates this test to disclosure alone
    });
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9013",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "9013",
      HOME: cwd,
    });

    const json = JSON.parse(result.stdout);
    assert.doesNotMatch(json.reason || "", /override disclosure mismatch/);
    assert.doesNotMatch(json.reason || "", /checkpoint overrides\[\] is empty but/);
  });
});

// F-0fe5da39 (round 4 Critical): before the fix, `costCircuitBreakerHit`
// unconditionally bypassed the once-per-window downgrade for BOTH exit(2)
// sites — the pending-marker one CCB-8 exercises, and this one, where
// `stillPending` is already empty (cross-review cleared/self-healed this
// same turn, e.g. CCB-1's shape) yet the cost/disclosure block still fires.
// That second site has no marker file to key a downgrade off at all, which
// is exactly why the fix adds an independent change_name-keyed reminder
// state (`DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR`, mirroring the
// existing cost-usage-cache override pattern CCB-10 also pre-seeds
// directly). This test pre-seeds that state file — rather than relying on
// two live `runStop` calls in sequence — because the marker this scenario's
// own cost hit is evaluated against gets deleted by self-heal within the
// SAME run that hard-blocks it (verified empirically: a second live
// `runStop` call afterward finds zero markers left and exits 0 silently,
// never re-entering this code path at all), so a two-call reproduction
// would not actually exercise the downgrade branch under test.
test("CCB-14: a cost-breaker hit with no pending marker (stillPending empty) downgrades once its change_name was recently reminded (F-0fe5da39)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-site-a-downgrade";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      outputTokens: 900_000,
    });
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9014",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    // Pre-seed the reminder state as if a prior Stop invocation already hard
    // -blocked this change_name moments ago — the exact shape
    // markCostCircuitBreakerReminded writes, replicated here the same way
    // CCB-10 replicates costUsageCacheFile's shape rather than importing the
    // (unexported, script-private) writer.
    const reminderStateDir = makeStateDir();
    writeFileSync(
      path.join(reminderStateDir, `${resolveReminderSession().key}__${changeName}.json`),
      JSON.stringify({ remindedAt: new Date(Date.now() - 5_000).toISOString() })
    );

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9014", // fresh sticky present -> self-heals, stillPending empty
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9014:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9014:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9014:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: reminderStateDir,
      HOME: cwd,
      CODEX_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      CLAUDE_SESSION_ID: "",
    });

    assert.equal(
      result.status,
      0,
      `expected downgrade to a soft reminder despite stillPending being empty; stderr: ${result.stderr}`
    );
    const json = JSON.parse(result.stdout);
    assert.match(json.systemMessage, COST_BLOCK_HEADING);
    assert.match(json.systemMessage, /^此成本斷路器狀態已在 30 分鐘內 hard-block 過/u, "a cost item is reported, so the cost-circuit-breaker sentence stays");
    assert.doesNotMatch(json.systemMessage, /Pending PRs:/, "no cross-review boilerplate — stillPending was empty");
  });
});

// Negative control for CCB-14: same shape, but with no reminder state pre-
// seeded — proves the hard block on an unreminded change_name is unaffected
// by the fix (CCB-1 already covers this single-run shape; this variant nails
// down that an EMPTY/missing reminder-state dir specifically still hard-
// blocks, not just an absent env var).
test("CCB-15 (negative control for CCB-14): the same stillPending-empty cost hit still hard-blocks when its change_name was never reminded", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-site-a-first-hit";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "12121212-1212-1212-1212-121212121212",
      outputTokens: 900_000,
    });
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9015",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const reminderStateDir = makeStateDir(); // exists but empty — no prior reminder for this change_name

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9015",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9015:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9015:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9015:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: reminderStateDir,
      HOME: cwd,
    });

    assert.equal(result.status, 2, `expected hard block on a never-reminded change_name; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    assert.match(json.reason, COST_BLOCK_HEADING);
    assert.doesNotMatch(json.reason, /Pending PRs:/);
  });
});

// Mixed-state case the `.every()` conjunction in canDowngrade exists to cover:
// one item (a cost-breaker change_name) is individually downgrade-eligible
// while a second, unrelated item (a plain pending marker) is not — the whole
// turn must still hard-block. CCB-14 only exercises the single-item downgrade
// path and CCB-15 only the single-item never-reminded path; neither proves
// the conjunction actually gates on BOTH tracks together.
test("CCB-16: change_name A already downgraded plus a still-unreminded pending marker in the same turn forces the whole turn to hard-block (F-0fe5da39 mixed-state)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-mixed-a";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    // Detach HEAD: `isMarkerRelevantToCurrentTurn` excludes a marker whose
    // branch differs from `currentBranch(cwd)`, and this test needs BOTH
    // markerA (`chore/${changeName}`) and markerB (a different branch) to
    // stay relevant so the mixed-state conjunction under test is actually
    // exercised. `currentBranch()` reads `git branch --show-current`, which
    // is empty in a detached HEAD — the same "no branch evidence" shape a
    // non-repo cwd produced before this file's tests were moved onto real
    // repos to make `stalled_rounds` reachable (fix-second-review-loop-
    // friction D1/D3).
    spawnSync("git", ["-C", cwd, "commit", "--allow-empty", "-q", "-m", "init"]);
    spawnSync("git", ["-C", cwd, "checkout", "-q", "--detach"]);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      outputTokens: 900_000,
    });

    // Marker for change_name A's own cost-budget hit; its PR self-heals via
    // MOCK_STICKY below (mirrors CCB-14) so it contributes only the cost
    // signal, not a second stillPending entry.
    seedUnreadableReceipt(cwd, changeName);
    const markerA = writeMarker(stateDir, {
      cwd,
      prNumber: "9016",
      branch: `chore/${changeName}`,
    });
    const oldA = new Date(Date.now() - 35_000);
    utimesSync(markerA, oldA, oldA);

    // Pre-seed change_name A's reminder state as already hard-blocked moments
    // ago (same shape as CCB-14) — A alone would be downgrade-eligible.
    const reminderStateDir = makeStateDir();
    writeFileSync(
      path.join(reminderStateDir, `${resolveReminderSession().key}__${changeName}.json`),
      JSON.stringify({ remindedAt: new Date(Date.now() - 5_000).toISOString() })
    );

    // A second, unrelated pending marker whose branch resolves to no matching
    // change folder (CCB-3-style unresolvable, so it contributes no cost
    // signal of its own) and is absent from MOCK_STICKY, so it lands in
    // stillPending. It is a brand-new marker that has never gone through
    // markPostPrCompletionReminded, so wasRecentlyHardBlocked is false for it.
    const markerB = writeMarker(stateDir, {
      cwd,
      prNumber: "9017",
      branch: "chore/ccb-mixed-no-such-change",
    });
    const oldB = new Date(Date.now() - 35_000);
    utimesSync(markerB, oldB, oldB);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9016", // only A's PR self-heals; 9017 stays pending
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9016:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9016:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9016:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: reminderStateDir,
      HOME: cwd,
    });

    assert.equal(
      result.status,
      2,
      `expected combined hard-block despite A's own reminder state; stderr: ${result.stderr}`
    );
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    assert.match(json.reason, /Pending PRs:/);
    assert.match(json.reason, /9017/);
    assert.match(json.reason, COST_BLOCK_HEADING);
    assert.match(json.reason, new RegExp(changeName));
    assert.doesNotMatch(
      json.reason,
      /已在 30 分鐘內 hard-block 過；本次改為 soft reminder/,
      "must not downgrade — a not-yet-reminded item forces the whole turn to hard-block"
    );
  });
});

test("CCB-17: all three cumulative thresholds exceeded with no blocking threshold does not block, and still reports every one (brd S9)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-advisory-only";
    const cwd = makeCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      // Each clears its threshold in cost-budget.mjs. The limits themselves are
      // deliberately not restated here — cost-budget.test.mjs grep-locks those
      // literals to their own module, prose included.
      outputTokens: 900_000,
      cacheReadTokens: 300_000_000,
      endTs: "2026-01-01T07:00:00.000Z", // a seven-hour turn clears model_time
    });
    // Deliberately a non-repo cwd (`makeCwdWithActiveChangeFolder`, not
    // `makeRepoCwdWithActiveChangeFolder`): `stalled_rounds` is the one
    // threshold that still blocks, and it resolves `not-applicable` (never
    // blocking) outside a real repo — see CCB-19 below — which is what
    // isolates this test to the three demoted totals.
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9018",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9018", // cross-review self-heals, as in CCB-1
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9018:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9018:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9018:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      HOME: cwd,
    });

    assert.equal(result.status, 0, `expected no block; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, undefined, "an advisory is a systemMessage, never a block decision");
    // D14, "the gate left, the message did not": every demoted threshold is
    // still named, with its number, on a turn that no longer stops.
    assert.match(json.systemMessage, /Cost circuit breaker advisory \(not a stop\)/);
    for (const key of ["output", "cache_read", "model_time"]) {
      assert.match(json.systemMessage, new RegExp(key), `the advisory must still name ${key}`);
    }
    assert.match(json.systemMessage, /PR #9018/);
    assert.match(json.systemMessage, new RegExp(changeName));
    // The two things that would quietly rebuild the stop this change removed.
    // The first is about the whole turn: no block section was built at all.
    assert.doesNotMatch(json.systemMessage, COST_BLOCK_HEADING);
    // The second is a property of the advisory section itself, asserted on the
    // section rather than the body -- see advisorySectionOf. CCB-11 asserts the
    // same property on a turn where the advisory really does share the message
    // with a block.
    assert.doesNotMatch(advisorySectionOf(json.systemMessage), /^\s*1\. /m, "an advisory must never present a user decision");
  });
});

// ---- T12: the stall signal at the hook ------------------------------------
//
// D19 row 3 keeps this Stop hook's stop point and swaps only its signal: the
// three cumulative totals stopped blocking in T4, and `stalled_rounds` is what
// blocks now. The tests below are the wiring proof — the four-state matrix
// itself lives in post-pr-cost-circuit-breaker.test.mjs, and the streak rule in
// review-stall-budget.test.mjs.
//
// The stall observation is read from the receipt chain under the notes root
// `derivedNotesRoot` computes from the repo, so unlike every test above these
// need a cwd that IS a repo. That difference is the subject, not an accident:
// a non-repo cwd resolves `not-applicable` (pinned directly in
// post-pr-cost-circuit-breaker.test.mjs), which is what keeps every other test
// in this file evaluating the same way it did before T12.

function makeRepoCwdWithActiveChangeFolder(changeName, repository) {
  const cwd = makeCwdWithActiveChangeFolder(changeName);
  const run = (args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  // The branch matters, and only in these tests. Every other test in this file
  // runs in a non-repo cwd, where the hook cannot read a current branch and its
  // marker relevance filter passes everything through. Once the cwd IS a repo
  // that filter starts working, and a marker for `chore/<change>` seen from
  // `main` is reported as not-checked and skipped -- exit 0, no evaluation at
  // all, and a test asserting the ABSENCE of a block would have passed for
  // entirely the wrong reason.
  run(["init", "-q", "-b", `chore/${changeName}`]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  if (repository) run(["remote", "add", "origin", `https://github.com/${repository}.git`]);
  return cwd;
}

// A receipt that exists but cannot be parsed: D20's `unavailable`, reached for
// real rather than mocked. Sealing a genuinely stalled chain needs the receipt
// harness in review-remediation-evidence.test.mjs (commits, digests, temporal
// validation); this state is the one that is both reachable in a few lines and
// blocking, so it is what proves the whole path — resolver, threshold, blocking
// set, override input, message — through the real hook.
function seedUnreadableReceipt(cwd, changeName) {
  const notes = path.join(cwd, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, `review-${changeName}-receipt-r1.json`), "this is not a sealed receipt\n");
}

function runRepoCostCheck({hub, target, repo, changeName, prNumber, cacheDir, reminderDir, env = {}}) {
  const stateDir = makeStateDir();
  const branch = `chore/${changeName}`;
  const file = writeMarker(stateDir, {cwd: hub, worktree: target, repositorySlug: repo, prNumber, branch});
  const old = new Date(Date.now() - 35_000);
  utimesSync(file, old, old);
  return runStop(hub, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: prNumber,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:${branch}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${prNumber}:${HEAD_SHA}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `${prNumber}:${b64("## Cost Circuit Breaker Overrides\nN/A\n")}`,
    DEVPRO_CHANGE_USAGE_STATE_DIR: "",
    DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR: cacheDir,
    DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: reminderDir,
    ...env,
  });
}

test("same-name repositories measure their own usage in both cold-cache orders", () => {
  const changeName = "ccb-shared-cost";
  const claudeRoot = makeStateDir();
  const repos = ["fixture/cost-low", "fixture/cost-high"].map((repo, index) => ({
    repo, target: makeRepoCwdWithActiveChangeFolder(changeName, repo), prNumber: String(1910 + index),
  }));
  const prev = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  try {
    for (const [index, current] of repos.entries()) {
      process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = path.join(current.target, "notes", "tmp", "state", "devpro-change-usage");
      seedResolvableChangeCostUsage({
        claudeRoot, changeName, outputTokens: [17, 910_000][index],
        sessionId: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"][index],
      });
    }
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = prev;
  }
  for (const order of [repos, [...repos].reverse()]) {
    const cacheDir = makeStateDir();
    const reminderDir = makeStateDir();
    for (const current of order) {
      const run = runRepoCostCheck({
        ...current, hub: repos[0].target, changeName, cacheDir, reminderDir,
        env: {
          DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
          DEVPRO_CHANGE_USAGE_STATE_DIR: path.join(repos[0].target, "notes", "tmp", "state", "devpro-change-usage"),
        },
      });
      assert.equal(run.status, 0, run.stdout || run.stderr);
      if (current === repos[1]) {
        const body = JSON.parse(run.stdout).systemMessage;
        assert.match(body, /910000/);
        assert.match(body, /github\.com\/fixture\/cost-high/);
      } else {
        assert.doesNotMatch(run.stdout, /Cost circuit breaker advisory/);
      }
    }
    const totals = readdirSync(cacheDir).map((name) =>
      JSON.parse(readFileSync(path.join(cacheDir, name), "utf8")).usage?.totals.output);
    assert.deepEqual(totals.sort((a, b) => a - b), [17, 910_000]);
  }
});

test("cost reminder keys isolate long same-name changes and each repo hard-blocks once", () => {
  const changeName = `ccb-${"x".repeat(96)}`;
  const firstRepo = "fixture/cost-first";
  const secondRepo = `${"q".repeat(39)}/${"z".repeat(99)}`;
  const hub = makeRepoCwdWithActiveChangeFolder(changeName, firstRepo);
  const foreign = makeRepoCwdWithActiveChangeFolder(changeName, secondRepo);
  seedUnreadableReceipt(hub, changeName);
  seedUnreadableReceipt(foreign, changeName);
  const shared = {hub, changeName, cacheDir: makeStateDir(), reminderDir: makeStateDir()};
  const first = {...shared, target: hub, repo: firstRepo, prNumber: "1920"};
  const second = {
    ...shared, target: foreign, repo: secondRepo, prNumber: "1921",
    env: {DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:stalled_rounds`},
  };
  for (const current of [first, second]) {
    const run = runRepoCostCheck(current);
    assert.equal(run.status, 2, run.stdout || run.stderr);
    assert.match(JSON.parse(run.stdout).reason, COST_BLOCK_HEADING);
    if (current === second) {
      assert.match(JSON.parse(run.stdout).reason, /cost_budget_override_ineffective: repository_mismatch/);
    }
  }
  const names = readdirSync(shared.reminderDir);
  assert.equal(names.length, 2);
  assert.ok(names.every((name) => Buffer.byteLength(name) <= 255));
  for (const current of [first, second]) {
    const run = runRepoCostCheck(current);
    assert.equal(run.status, 0, run.stdout || run.stderr);
    assert.match(JSON.parse(run.stdout).systemMessage, /soft reminder/);
  }
});

test("an unverified target checkout reports unavailable without using the hub's stall evidence", () => {
  const changeName = "ccb-unverified-cost";
  const hub = makeRepoCwdWithActiveChangeFolder(changeName, "fixture/cost-hub");
  seedUnreadableReceipt(hub, changeName);
  const cacheDir = makeStateDir();
  const reminderDir = makeStateDir();
  const run = runRepoCostCheck({
    hub, target: hub, repo: "fixture/cost-foreign", changeName,
    prNumber: "1930", cacheDir, reminderDir,
  });
  assert.equal(run.status, 0, run.stdout || run.stderr);
  assert.match(JSON.parse(run.stdout).systemMessage, /Cost circuit breaker unavailable/);
  assert.match(run.stdout, /github\.com\/fixture\/cost-foreign/);
  assert.deepEqual(readdirSync(cacheDir), []);
  assert.deepEqual(readdirSync(reminderDir), []);
});

test("a foreign override can be applied from the target with the original owned marker directory", () => {
  const changeName = "ccb-foreign-override";
  const hub = makeRepoCwdWithActiveChangeFolder(changeName, "fixture/override-hub");
  const target = makeRepoCwdWithActiveChangeFolder(changeName, "fixture/override-target");
  const branch = `chore/${changeName}`;
  const prNumber = "1931";
  const stateDir = makeStateDir();
  const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  seedUnreadableReceipt(target, changeName);
  const marker = writeMarker(stateDir, {cwd: hub, worktree: target, repositorySlug: "fixture/override-target", prNumber, branch, sessionId});
  const options = {
    DEVPRO_CHANGE_USAGE_STATE_DIR: "",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:${branch}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${prNumber}:${HEAD_SHA}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `${prNumber}:${b64("## Cost Circuit Breaker Overrides\nN/A\n")}`,
    DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:stalled_rounds`,
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: sessionId,
    CLAUDE_SESSION_ID: sessionId,
    CODEX_SESSION_ID: "",
    CODEX_THREAD_ID: "",
  };
  const fromHub = runStop(hub, stateDir, options);
  assert.equal(fromHub.status, 2, fromHub.stdout || fromHub.stderr);
  const hint = JSON.parse(fromHub.stdout).reason;
  assert.match(hint, /cost_budget_override_ineffective: repository_mismatch/);
  assert.match(hint, /DEVPRO_POST_PR_COMPLETION_STATE_DIR to the original marker directory/);
  assert.equal(existsSync(marker), true);
  const stateDirOf = (repo) => path.join(repo, "notes", "tmp", "state", "devpro-change-usage");
  assert.equal(readChangeUsageCheckpoint({changeName, stateDir: stateDirOf(target)}).status, "unavailable");

  const retry = runStop(target, stateDir, options);
  assert.equal(retry.status, 2, retry.stdout || retry.stderr);
  const reason = JSON.parse(retry.stdout).reason;
  assert.doesNotMatch(reason, COST_BLOCK_HEADING);
  assert.match(reason, /override disclosure mismatch/);
  const checkpoint = readChangeUsageCheckpoint({changeName, stateDir: stateDirOf(target)});
  assert.deepEqual(checkpoint.overrides.map(({thresholds}) => thresholds), [["stalled_rounds"]]);
  assert.equal(readChangeUsageCheckpoint({changeName, stateDir: stateDirOf(hub)}).status, "unavailable");
});

test("CCB-18: an unreadable receipt chain blocks on `stalled_rounds`, naming the key and why it could not be judged", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-stall-unreadable";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    // No usage seeded and no round cap: `stalled_rounds` is the ONLY thing
    // that can stop this turn, so the block below is attributable to it alone.
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9018",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9018",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9018:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9018:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9018:${b64(prBody)}`,
      HOME: cwd,
    });

    assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    // Nothing was measured over a limit, so the heading must not say "exceeded":
    // an unavailable stall is a read failure the user has to be able to tell apart
    // from a real stall at a glance (the hook once read as "exceeded" for a change
    // whose --budget-check said exceeded=false).
    assert.doesNotMatch(json.reason, /Cost circuit breaker exceeded/);
    assert.match(json.reason, /### Cost circuit breaker blocked（無法判定，不是超標）/);
    // The way to find out which it is: the same report the heading's rule cites,
    // for this change, run where the change's receipts can be verified.
    assert.match(
      json.reason,
      new RegExp(`report-session-token-usage\\.mjs --since-change ${changeName} --budget-check`),
      "an unavailable row names the re-check command for its own change",
    );
    // The key, because it is what the user types into
    // DEVPRO_COST_BUDGET_OVERRIDE, and no label spells it.
    assert.match(json.reason, /`stalled_rounds`/);
    // And the reason, because "damaged evidence" and "a measured streak" must
    // not arrive in the same words (D20).
    assert.match(json.reason, /無法判定：收據存在但收據鏈讀不出或驗不過/);
    assert.doesNotMatch(json.reason, /`output`/, "nothing was measured over, so no total is reported on this turn");
    assert.match(json.reason, /1\. 是/, "the stop is still a user decision, relayed verbatim");
    assert.match(json.reason, /2\. 否/);
    assert.match(json.reason, /3\. 其他/);
  });
});

test("CCB-19: in a real repo, a change that has never sealed a receipt is not stopped — and the totals still do not stop it either", () => {
  // S9's regression, re-run over a real notes root instead of the non-repo
  // shortcut every other test takes. Both halves matter: the stall gate must
  // stay quiet for a change with no review rounds (or it would fire on every
  // change, every day), and T4's demotion of the totals must survive T12.
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-stall-no-receipts";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const claudeRoot = path.join(cwd, "claude-root");
    seedResolvableChangeCostUsage({
      claudeRoot,
      changeName,
      sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      outputTokens: 900_000, // clears COST_BUDGET_THRESHOLDS.output
    });
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9019",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9019",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9019:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9019:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9019:${b64(prBody)}`,
      DEVPRO_TEST_CLAUDE_ROOT: claudeRoot,
      HOME: cwd,
    });

    const body = result.status === 2 ? JSON.parse(result.stdout).reason : JSON.parse(result.stdout).systemMessage;
    assert.doesNotMatch(String(body ?? ""), COST_BLOCK_HEADING);
    const advisory = advisorySectionOf(String(body ?? ""));
    assert.ok(advisory, "the overage is still measured and still reported, it just no longer stops");
    assert.match(advisory, /^ {2}- `output` — /mu);
    assert.doesNotMatch(advisory, /^ {2}- `stalled_rounds` — /mu, "a change with no receipts contributes no stall row at all");
  });
});

test("CCB-20: the block an unavailable stall causes is cleared by the same named override every other threshold uses", () => {
  // D20 promises the exit is "既有的具名 override，不新增 scope、不新增路徑".
  // That promise only holds because the override resolver is handed the
  // REPORTED set: `stalled_rounds` is blocking without being exceeded, and an
  // exact-set match against the exceeded set (empty) could never be satisfied.
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-stall-override";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9020",
      branch: `chore/${changeName}`,
      sessionId: "22222222-2222-2222-2222-222222222222",
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(cwd, stateDir, {
      // Still-pending cross-review, as in CCB-11: it guarantees this turn
      // carries a block from the pre-existing gate, so "the cost section is
      // gone" is asserted against a message that exists.
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9020:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9020:${HEAD_SHA}`,
      HOME: cwd,
      DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:stalled_rounds`,
      CODEX_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      CLAUDE_SESSION_ID: "22222222-2222-2222-2222-222222222222",
      DEVPRO_POST_PR_COMPLETION_SESSION_ID: "22222222-2222-2222-2222-222222222222",
    });

    assert.equal(result.status, 2, `expected the pre-existing cross-review block; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.doesNotMatch(json.reason, COST_BLOCK_HEADING, "the named override cleared the stall block");
    // Cleared, not silenced (D14). This branch is reached only because the
    // advisory is keyed on the reported set: an overridden `unavailable` stall
    // exceeds nothing, so keying it on `exceeded_thresholds` would drop the
    // one key the user had to name on the very turn they named it.
    const advisory = advisorySectionOf(json.reason);
    assert.ok(advisory, "an override that clears a block must still report what it cleared");
    assert.match(advisory, /^ {2}- `stalled_rounds` — /mu);

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.overrides.length, 1, "the exemption is durably auditable, exactly as for every other threshold");
    assert.deepEqual(checkpoint.overrides[0].thresholds, ["stalled_rounds"]);
  });
});

// D12 (fix-second-review-loop-friction, workflow-cost-controls "Cost Override
// Effectiveness Diagnostics Are Named"): re-anchored here from
// render-second-review-packet.test.mjs, which used to be the surface that
// resolved `DEVPRO_COST_BUDGET_OVERRIDE` at the pr-sticky round cap (D2
// removed that resolution entirely — the renderer has no blocking cost
// threshold left). This hook's `stalled_rounds` block is now the only
// post-PR surface (besides `--budget-check`) that still names an
// ineffective override's reason. Both scenario titles are kept verbatim
// (lint-delta-new-scenario-assertion-coverage does a substring search on
// them); only the GIVEN moved.
test("Scenario: Ineffective override names its reason", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-ineffective-mismatch";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9021",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9021", // self-heals, isolates to the cost-budget section (CCB-1 pattern)
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9021:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9021:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9021:${b64(prBody)}`,
      HOME: cwd,
      DEVPRO_COST_BUDGET_OVERRIDE: "some-other-change:stalled_rounds", // declared change token does not match
      CLAUDE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(result.status, 2, `expected the stalled_rounds block to survive; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    assert.match(json.reason, COST_BLOCK_HEADING, "the block must not be lifted by an ineffective override");
    assert.match(json.reason, /cost_budget_override_ineffective: change_mismatch/);
  });
});

test("Scenario: Set-but-blank override names the missing reason", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-ineffective-blank";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9022",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9022",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9022:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9022:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9022:${b64(prBody)}`,
      HOME: cwd,
      DEVPRO_COST_BUDGET_OVERRIDE: "", // key present, blank value
      CLAUDE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    assert.match(json.reason, /cost_budget_override_ineffective: missing/);
  });
});

// F-slf-r1-01 (review r1): the legacy `round`/`review_round` hint
// (`ROUND_EXTENSION_HINT`, cost-budget-override.mjs) attaches when the
// declared, unrecognized threshold key is one of those two legacy tokens.
// This test's GIVEN mirrors "Scenario: Ineffective override names its
// reason" above (same block surface, `stalled_rounds`) but declares `round`
// instead of a change-mismatched token, so the reason resolves
// `unknown_threshold_key` with a `hint:` line rather than `change_mismatch`
// with none. Deleting either the `hint` assignment in
// cost-budget-override.mjs's `unknown_threshold_key` branch, or this hook's
// own `hint:` render line (buildCostBudgetBlockSection,
// post-pr-completion-check.mjs ~:1180), must make this test fail.
test("Scenario: Legacy round declaration names unknown_threshold_key with the round-override hint (F-slf-r1-01)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-legacy-round-hint";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber: "9023",
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const prBody = "## Cost Circuit Breaker Overrides\nN/A\n";
    const result = runStop(cwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9023",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9023:chore/${changeName}`,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9023:${HEAD_SHA}`,
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9023:${b64(prBody)}`,
      HOME: cwd,
      DEVPRO_COST_BUDGET_OVERRIDE: `${changeName}:round`, // legacy token, not a cost threshold
      CLAUDE_SESSION_ID: "11111111-1111-1111-1111-111111111111",
    });

    assert.equal(result.status, 2, `expected the stalled_rounds block to survive; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    assert.match(json.reason, COST_BLOCK_HEADING, "the block must not be lifted by an ineffective override");
    assert.match(json.reason, /cost_budget_override_ineffective: unknown_threshold_key/);
    assert.match(json.reason, /hint: .*DEVPRO_REVIEW_ROUND_OVERRIDE/, "the hint line must point to the round-extension mechanism");
  });
});

// F-slf-r1-02 (review r1): S4a — the hook DOES evaluate the PR-body override
// disclosure cross-check (evaluateOverrideDisclosure, called at
// post-pr-completion-check.mjs ~:2043) against an archive-only change folder
// (changeNameFolderExists resolves via the archive glob, not an active
// openspec/changes/<name>/ dir — resolve-change-cost-usage.mjs). A checkpoint
// override entry declared `thresholds: ["review_round"]` (the disclosure
// checkpoint's own entry-kind label, D7/D8 — never a cost threshold) plus a
// PR body that declares the section empty (`N/A`) is exactly the "non-empty
// overrides[] but body says N/A" mismatch evaluateOverrideDisclosure blocks
// on, proven here through the real hook against an archived, not active,
// change folder.
test("Scenario: S4a archive-only change folder with a review_round checkpoint entry and an N/A PR body blocks on override disclosure (F-slf-r1-02)", () => {
  const stateDir = makeStateDir();
  const changeName = "ccb-s4a-archive-only";
  const cwd = path.join(tmpRoot, `cwd-${counter++}`);
  mkdirSync(path.join(cwd, "openspec", "changes", "archive", `2026-01-01-${changeName}`), { recursive: true });
  appendChangeUsageOverride({
    cwd,
    changeName,
    session_id: "s4a",
    at: "2026-01-01T00:00:00.000Z",
    thresholds: ["review_round"],
    head_ref_oid: HEAD_SHA,
  });
  const markerFile = writeMarker(stateDir, {
    cwd,
    prNumber: "9024",
    branch: `chore/${changeName}`,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const prBody = "## Cost Circuit Breaker Overrides\nN/A\n"; // non-empty overrides[] but body says N/A -> S-1 mismatch
  const result = runStop(cwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "9024",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `9024:chore/${changeName}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `9024:${HEAD_SHA}`,
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: `9024:${b64(prBody)}`,
  });

  assert.equal(result.status, 2, `expected hard block; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, "block");
  assert.match(json.reason, /override disclosure mismatch/);
  assert.match(json.reason, /PR #9024/);
});

// fix-codex-reviewer-intent-candidate-cap (T2d Stop-hook integration, T2e). The hook is a child process, so the
// over-cap and failed-listing fixtures use a child-only `node --import` preload (the cross-platform fake-git pattern
// of recap-utils.test.mjs; no POSIX shim, nothing on the parent's PATH). It wraps child_process.spawnSync("git", ...)
// inside the hook process only: it logs every git argv, optionally fails selected `git worktree list --porcelain -z`
// calls (1-based) or pads that listing with duplicate main-checkout entries up to 129 (a path without a `.worktree/`
// segment, so it counts toward the cap but is never a candidate), and forwards everything else to the real git.
// No production seam, no constant edit.
const GIT_SHIM_PRELOAD = path.join(tmpRoot, "git-shim-preload.mjs");
writeFileSync(GIT_SHIM_PRELOAD, `
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(process.env.DEVPRO_TEST_GIT_SHIM || "{}");
const original = childProcess.spawnSync;
let enumerations = 0;
childProcess.spawnSync = function shimmedSpawnSync(file, args, options) {
  if (file !== "git" || !Array.isArray(args) || !config.log) return original.apply(this, arguments);
  appendFileSync(config.log, JSON.stringify(args) + "\\n");
  const isEnumeration = args[0] === "worktree" && args[1] === "list" && args.includes("-z");
  if (isEnumeration) {
    enumerations += 1;
    if ((config.failListCalls ?? []).includes(enumerations)) {
      return { status: 1, signal: null, stdout: "", stderr: "", output: [null, "", ""], pid: 0, error: undefined };
    }
  }
  const result = original.apply(this, arguments);
  if (isEnumeration && config.padListTo !== undefined && result.status === 0) {
    const raw = String(result.stdout);
    const have = (raw.match(/\\0\\0/g) ?? []).length;
    return { ...result, stdout: raw + ("worktree " + config.padPath + "\\0HEAD " + "a".repeat(40) + "\\0\\0").repeat(Math.max(0, config.padListTo - have)) };
  }
  return result;
};
syncBuiltinESMExports();
`);

let shimRunCounter = 0;
function runStopWithGitShim(cwd, stateDir, extraEnv, shimConfig = {}) {
  const log = path.join(tmpRoot, `git-shim-${shimRunCounter++}.log`);
  const result = runStop(cwd, stateDir, {
    ...extraEnv,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(GIT_SHIM_PRELOAD).href}`].filter(Boolean).join(" "),
    DEVPRO_TEST_GIT_SHIM: JSON.stringify({ log, ...shimConfig }),
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    result,
    calls,
    enumerations: calls.filter((args) => args[0] === "worktree" && args[1] === "list" && args.includes("-z")).length,
  };
}

// K same-branch markers (PR 9100+i) for one change, each with a fresh sticky, the head ref and an N/A override body.
function seedSameBranchMarkers(cwd, stateDir, changeName, count) {
  const prNumbers = Array.from({ length: count }, (_, index) => String(9100 + index));
  for (const prNumber of prNumbers) {
    const markerFile = writeMarker(stateDir, {
      cwd,
      prNumber,
      branch: `chore/${changeName}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);
  }
  const body = b64("## Cost Circuit Breaker Overrides\nN/A\n");
  return {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: prNumbers.join(","),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: prNumbers.map((pr) => `${pr}:chore/${changeName}`).join(","),
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: prNumbers.map((pr) => `${pr}:${HEAD_SHA}`).join(","),
    DEVPRO_POST_PR_GATE_MOCK_BODY_B64: prNumbers.map((pr) => `${pr}:${body}`).join(","),
  };
}

function stopSessionEnv(cwd, reminderStateDir) {
  return {
    HOME: cwd,
    DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: reminderStateDir,
    CODEX_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    CLAUDE_SESSION_ID: "44444444-4444-4444-4444-444444444444",
  };
}

test("Same-Branch Markers Share One Successful Worktree Enumeration: three same-branch markers run git worktree list once and the Stop hook still blocks exactly as before", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-enumeration-shared";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    const env = { ...seedSameBranchMarkers(cwd, stateDir, changeName, 3), ...stopSessionEnv(cwd, makeStateDir()) };
    assert.equal(readdirSync(stateDir).filter((name) => name.endsWith(".json")).length, 3, "fixture: three pending markers before the run");
    const { result, enumerations, calls } = runStopWithGitShim(cwd, stateDir, env);
    assert.equal(calls.length > 0, true, "the preload really observed the hook's git calls");
    assert.equal(result.status, 2, `expected the unreadable-receipt hard block; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.decision, "block");
    assert.match(json.reason, /`stalled_rounds`/, "the shared enumeration does not change what the stall observation blocks on");
    assert.match(json.reason, /無法判定：收據存在但收據鏈讀不出或驗不過/);
    assert.deepEqual(readdirSync(stateDir).filter((name) => name.endsWith(".json")), [], "marker clearing is unchanged: all three self-healed markers are removed (same result as before the shared enumeration)");
    assert.equal(enumerations, 1, "K=3 markers of the same change share one successful worktree enumeration in the run");
  });
});

test("Failed Worktree Enumeration Is Never Reused: a transient listing failure only spoils its own marker; the next one lists again and later markers reuse that success", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-enumeration-transient";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    seedUnreadableReceipt(cwd, changeName);
    const env = { ...seedSameBranchMarkers(cwd, stateDir, changeName, 3), ...stopSessionEnv(cwd, makeStateDir()) };
    const { result, enumerations } = runStopWithGitShim(cwd, stateDir, env, { failListCalls: [1] });
    assert.equal(result.status, 2, `the markers after the failed one still evaluate and block; stderr: ${result.stderr}`);
    assert.match(JSON.parse(result.stdout).reason, /`stalled_rounds`/);
    assert.equal(enumerations, 2, "one failed listing (its marker stays not-applicable) plus one successful listing that later markers reuse");
  });
});

test("Over-Cap Stall Blocks The First Stop And Soft-Reminds Within 30 Minutes: 129 listed worktrees hard-block once and a repeat Stop in the same session downgrades", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-over-cap-stall";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const reminderStateDir = makeStateDir();
    const overCap = { padListTo: 129, padPath: realpathSync(cwd) };

    // Control: inside the cap and with no receipts the same fixture never stops, twice in a row.
    for (const label of ["first", "second"]) {
      const env = { ...seedSameBranchMarkers(cwd, stateDir, changeName, 1), ...stopSessionEnv(cwd, makeStateDir()) };
      const control = runStopWithGitShim(cwd, stateDir, env);
      assert.equal(control.enumerations, 1, `control ${label}: the worktree list was enumerated once`);
      assert.equal(control.result.status, 0, `control ${label} run inside the cap must not stop; stdout: ${control.result.stdout} stderr: ${control.result.stderr}`);
      assert.doesNotMatch(control.result.stdout, /"decision":\s*"block"/u, `control ${label} run has no block`);
    }

    const env = () => ({ ...seedSameBranchMarkers(cwd, stateDir, changeName, 1), ...stopSessionEnv(cwd, reminderStateDir) });
    const first = runStopWithGitShim(cwd, stateDir, env(), overCap);
    assert.equal(first.enumerations, 1, "the 129-entry worktree list was really consumed");
    assert.equal(first.result.status, 2, `the first over-cap Stop hard-blocks; stdout: ${first.result.stdout} stderr: ${first.result.stderr}`);
    const block = JSON.parse(first.result.stdout);
    assert.equal(block.decision, "block");
    assert.match(block.reason, /stalled_rounds/, "the block names the stall threshold");

    const second = runStopWithGitShim(cwd, stateDir, env(), overCap);
    assert.equal(second.result.status, 0, `a repeat Stop within 30 minutes downgrades to a soft reminder; stderr: ${second.result.stderr}`);
    const reminder = JSON.parse(second.result.stdout);
    assert.equal(reminder.decision, undefined, "the downgrade is a systemMessage, not a block");
    assert.match(reminder.systemMessage, /stalled_rounds/);
    assert.match(reminder.systemMessage, /已在 30 分鐘內 hard-block 過/);
  });
});

test("Over-Cap Stall Blocks The First Stop And Soft-Reminds Within 30 Minutes: with three same-branch markers every marker re-judges the cap and the Stop still blocks", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-over-cap-stall-many";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const env = { ...seedSameBranchMarkers(cwd, stateDir, changeName, 3), ...stopSessionEnv(cwd, makeStateDir()) };
    const { result, enumerations } = runStopWithGitShim(cwd, stateDir, env, { padListTo: 129, padPath: realpathSync(cwd) });
    assert.equal(enumerations, 3, "a failed (over-cap) enumeration is never reused: each marker lists again");
    assert.equal(result.status, 2, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.match(JSON.parse(result.stdout).reason, /stalled_rounds/);
  });
});

test("Other Binding Resolution Faults Stay Not-Applicable: a registered but deleted worktree does not make the Stop hook block (characterization)", () => {
  withChangeUsageStateDir(() => {
    const stateDir = makeStateDir();
    const changeName = "ccb-scan-fault-stays-quiet";
    const cwd = makeRepoCwdWithActiveChangeFolder(changeName);
    const git = (args) => {
      const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    };
    git(["commit", "-q", "--allow-empty", "-m", "seed"]);
    const linked = path.join(cwd, ".worktree", changeName);
    mkdirSync(path.dirname(linked), { recursive: true });
    git(["worktree", "add", "-q", "-b", "scan-fault-linked", linked, "HEAD"]);
    rmSync(linked, { recursive: true, force: true });
    const env = { ...seedSameBranchMarkers(cwd, stateDir, changeName, 1), ...stopSessionEnv(cwd, makeStateDir()) };
    const { result, enumerations } = runStopWithGitShim(cwd, stateDir, env);
    assert.equal(enumerations, 1, "the enumeration really ran and hit the incomplete-listing fault");
    assert.equal(result.status, 0, `only the candidate cap became a stall block; stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /"decision":\s*"block"/u);
    assert.doesNotMatch(result.stdout, /stalled_rounds/u);
  });
});
