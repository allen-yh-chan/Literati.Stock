#!/usr/bin/env node
/**
 * post-pr-completion-check.mjs — Stop hook
 *
 * Hard-block for the host-neutral Post-PR Completion Gate. The marker is
 * written by post-tool-gate.mjs after a successful `gh pr create`.
 *
 * Lifecycle:
 *   - Written: post-tool-gate.mjs on successful gh pr create
 *   - Cleared (self-heal exemption): this hook detects PR is in isCrossModelExempt class
 *   - Cleared (self-heal sticky): this hook detects fresh parseable sticky via gh pr view
 *   - Scope: only this session's creator/subscribed PRs; inventory and foreign state are read-only
 *
 * Hard-block: emits { decision: "block", reason } + exit 2 until cleared.
 */

// R8: this import MUST stay first. Its top level supervises the run (worker process + hard kill) before the rest of the import
// graph below is evaluated; see lib/stop-run-supervisor.mjs.
import { formatDuration, launcherNote, resolveStopRunDeadlineMs, STOP_TIME_BUDGET_REMINDER_KEY } from "./lib/stop-run-supervisor.mjs";
import { spawnSync } from "node:child_process";
import { readGithubCheck } from "./lib/github-check-cache.mjs";
import { probeGhAuthentication, selectGithubRoute } from "../lib/github-tool-routing.mjs";
import { resolveReminderSession, compactReminder } from "./lib/session-reminder.mjs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "../lib/primitives.mjs";
import {
  listOwnedPostPrStopMarkers,
  clearPostPrCompletionMarker,
  markPostPrCompletionReminded,
  postPrCompletionReminderTimestamp,
  postPrMarkerCheckout,
  postPrMarkerRepoName,
} from "./lib/post-pr-completion-state.mjs";
import {
  EXTERNAL_EVALUATOR_EXECUTOR_KIND,
  FAULT_CONSUMPTION_SCHEMA,
  FAULT_SUPERSESSION_SCHEMA,
  controlEvidenceRoot,
  dispatchEvidenceNeverStarted,
  readDispatchEvidence,
  readDispatchEvidenceStrict,
  withDispatchEvidenceSnapshot,
  assertDispatchEvidenceAvailable,
  assertDispatchReviewAuthority,
  writeConsumptionReceipt,
  writeSupersessionReceipt,
} from "./lib/second-review-control-evidence.mjs";
import {
  MODEL_FAMILY_PATTERNS,
  SECOND_REVIEW_STICKY_MARKER,
  SECOND_REVIEW_STICKY_MOCK_PROVENANCE,
  parseSecondReviewStickyAuthorityBody,
  selectExactSecondReviewStickyAuthority,
} from "./lib/second-review-sticky-authority.mjs";
import { evaluateCrossModelWaiverPathW, stickyAllowsCrossModelWaiverPathW } from "./lib/second-review-waiver-authority.mjs";
import { defaultRepoStateDir } from "./lib/repo-state-identity.mjs";
import { prUrlNumber, prUrlRepo, repoKey, repoName } from "./lib/repo-key.mjs";
import { inheritedGitLocation, storedOriginIdentity } from "./lib/git-utils.mjs";
import { isCrossModelExempt } from "./pre-tool-gate.mjs";
import { githubBranchExemptionReason, isChoreAClassExempt } from "./lib/github-merge-exemptions.mjs";
import { toExemptionInput } from "../lib/changed-file-status.mjs";
import { createWorktreeEnumerationMemo } from "./lib/admission-record.mjs";
import { evaluateFreshEquivalent } from "./lib/fresh-equivalent-compare.mjs";
import { clearReviewRoundState } from "./lib/review-round-budget.mjs";
import {
  blockingCostThresholds,
  evaluateOverrideDisclosure,
  evaluatePostPrCostBudget,
  reportedCostThresholds,
} from "./lib/post-pr-cost-circuit-breaker.mjs";
import { COST_BUDGET_THRESHOLDS } from "../lib/cost-budget.mjs";
import { resolveChangeCostUsage } from "../lib/resolve-change-cost-usage.mjs";
import { changeUsageStateDir } from "./lib/change-usage-checkpoint.mjs";
import { resolveCostBudgetOverride } from "../lib/cost-budget-override.mjs";
import { captureTlHostSession } from "../lib/session-usage-manifest.mjs";
import {
  nextDeadlineBoundTimeoutMs,
  probeTimeoutMs,
} from "./lib/post-pr-stop-hotpath-cleanup.mjs";

const REMIND_AFTER_MS = 0;
const CROSS_REPOSITORY_ONLY = process.env.DEVPRO_AGENT_RULES_LEVEL === "off";
const HARD_BLOCK_DEDUP_MS = 30 * 60_000;
// R7: cooperative whole-run deadline (150 s by default; resolveStopRunDeadlineMs lives in lib/stop-run-supervisor.mjs next to the
// hard limit and the launcher timeout it must stay under). run-hook.mjs kills a Stop hook at its launcher limit (180 s) and that
// timeout is fail-open on every host profile, so this hook stops between markers and blocks by itself first, naming the
// unprocessed PRs. Work inside one marker cannot be interrupted from here; the hard limit (R8) covers that.
// A marker is only started while at least 5 s is left, so a PR-number marker's gh window is never shorter than the fixed 5 s.
// A branch-only marker's later gh calls can still be cut short by the remaining time; that lands on the existing "gh returned
// less" paths (null / light snapshot) and never clears a marker without positive evidence.
const STOP_MARKER_MIN_REMAINING_MS = 5_000;
// The cooperative deadline is measured on a monotonic clock (performance.now), so a wall-clock step (NTP, manual change, VM resume)
// can neither lengthen nor shorten it. remainingMs/exhausted deliberately IGNORE the `at` argument: probeTimeoutMs passes the
// wall-clock Date.now() there, and mixing the two clocks would let a backward step extend the budget. Reminder records keep the wall clock.
function createMonotonicRunBudget(limitMs) {
  const startedAt = performance.now();
  // Whole milliseconds: spawnSync rejects a fractional `timeout`, and every gh timeout here is derived from this value.
  const remainingMs = () => Math.max(0, Math.floor(limitMs - (performance.now() - startedAt)));
  return { windowMs: limitMs, remainingMs, exhausted: () => remainingMs() <= 0 };
}
const VALID_SHA_RE = /^[a-f0-9]{40}$/;
const READY_VERDICTS = new Set(["PASS", "WARN"]);
// Probe diff for "is this branch name exempt by pattern alone?": one proposal path with NO status,
// which `isCrossModelExempt` reads as unknown (= proposal evidence), so a diff-shape exemption can never
// answer yes here — only a branch-pattern one can. Do not give this path a status.
const BRANCH_PATTERN_PROBE_FILES = ["openspec/changes/__branch_pattern_probe__/proposal.md"];
const CROSS_MODEL_REVIEWER_ENV = "DEVPRO_CROSS_MODEL_REVIEWER";
// `body` is on the LIGHT field list (not just FULL) because fetchPrSnapshot's
// MERGED/fresh-sticky early-return short-circuits before the FULL fetch ever
// runs (see fetchPrSnapshot below) — exactly the snapshots task 7's S-1
// cross-check most needs prBody for (a round that just concluded PASS, or a
// PR that already merged). Putting it on FULL alone would silently starve
// those cases of PR body content.
// `baseRefName` feeds the zero-diff ancestry repair exemption, which holds only for a main or release/rules-* base.
const GH_PR_LIGHT_FIELDS = "number,url,state,comments,headRefName,headRefOid,baseRefName,body";
// `changedFiles` rides alongside `files` so snapshotFromGhData can tell a
// complete `files` list from one GitHub truncated to the first 100 — see
// "PR Changed-File Lists Are Complete Before Classification".
const GH_PR_FULL_FIELDS = `${GH_PR_LIGHT_FIELDS},files,changedFiles`;
const MAX_DISPATCH_LINEAGE_RECORDS = 256;
const ORCHESTRATION_FAULT_CLASSIFICATIONS = new Set([
  "reviewer_orchestration_permission_denied",
  "reviewer_orchestration_unknown",
]);

function isCrossModelReviewerProcess() {
  return process.env[CROSS_MODEL_REVIEWER_ENV] === "1";
}

function parseStickyVerdict(body) {
  const parsed = parseSecondReviewStickyAuthorityBody(body);
  return parsed.status === "valid"
    ? { found: true, verdict: parsed.verdict }
    : { found: false };
}

function parseStickyLastReviewedSha(body) {
  const parsed = parseSecondReviewStickyAuthorityBody(body);
  return parsed.status === "valid"
    ? { found: true, sha: parsed.last_reviewed_sha }
    : { found: false };
}

function parseStickyDispatchId(body) {
  const parsed = parseSecondReviewStickyAuthorityBody(body);
  return parsed.status === "valid"
    ? { found: true, dispatchId: parsed.dispatch_id }
    : { found: false };
}

let reminderSession = null;

function wasRecentlyHardBlocked(marker, now) {
  const ts = postPrCompletionReminderTimestamp(marker, reminderSession);
  return ts > 0 && now - ts < HARD_BLOCK_DEDUP_MS;
}

/**
 * Freshness gate for a sticky cross-model verdict, Path D′-aware (design.md
 * D2 "post-PR marker 同語意"). The sticky must be parseable with a READY
 * verdict (PASS|WARN) — CRITICAL / UNAVAILABLE / missing all fail closed
 * regardless of any sha relationship, since the fresh-equivalent carve-out
 * only ever waives a stale *sha*, never a non-READY verdict.
 *
 * Given a READY-verdict sticky:
 *   - `parsed.last_reviewed_sha === headRefOid` (exact match) → fresh, and
 *     the "head the sticky has proven coverage of" (`reviewedHeadRefOid`) IS
 *     `headRefOid`.
 *   - otherwise, if both shas are full 40-hex, ask the shared
 *     `evaluateFreshEquivalent` authority (same one pre-tool-gate.mjs's Path D
 *     carve-out uses — MUST NOT re-implement the whitelist here, N2 parity):
 *     a whitelist-only compare between them also counts as fresh, and
 *     `reviewedHeadRefOid` becomes the sticky's `last_reviewed_sha` (the head
 *     the sticky can actually attest to — NOT the live current head, which
 *     may have moved further by non-bookkeeping commits since).
 *   - any other case (non-READY verdict, unparseable, compare unavailable /
 *     non-ancestor / non-whitelist-only) → not fresh, `reviewedHeadRefOid: ""`.
 *
 * This is the fail-closed check; the human-readable gate checklist lives in
 * `.devpro/agent-rules/post-pr-completion-gate.md`.
 *
 * @returns {{ fresh: boolean, reviewedHeadRefOid: string, equivalence: null | { reason: string, files: Array } }}
 */
function resolveStickyFreshness(body, headRefOid, { comparisonRepo, cwd = process.cwd() } = {}) {
  const NOT_FRESH = { fresh: false, reviewedHeadRefOid: "", equivalence: null };
  const rawHeadRefOid = typeof headRefOid === "string" ? headRefOid.trim() : "";
  if (!VALID_SHA_RE.test(rawHeadRefOid)) return NOT_FRESH;
  const parsed = parseSecondReviewStickyAuthorityBody(body);
  if (parsed.status !== "valid" || !READY_VERDICTS.has(parsed.verdict)) return NOT_FRESH;
  if (parsed.last_reviewed_sha === rawHeadRefOid) {
    return { fresh: true, reviewedHeadRefOid: rawHeadRefOid, equivalence: null };
  }
  if (!comparisonRepo) return NOT_FRESH;
  const [host, owner, repo] = comparisonRepo.split("/");
  const freshEquivalent = evaluateFreshEquivalent({
    lastReviewedSha: parsed.last_reviewed_sha,
    headRefOid: rawHeadRefOid,
    repoSlug: `${owner}/${repo}`,
    host,
    cwd,
  });
  if (!freshEquivalent.fresh_equivalent) return NOT_FRESH;
  return {
    fresh: true,
    reviewedHeadRefOid: parsed.last_reviewed_sha,
    equivalence: { reason: freshEquivalent.reason, files: freshEquivalent.files || [] },
  };
}

/**
 * Fetch PR snapshot via gh pr view (combined comments + headRefName + files).
 * Returns { headRefName, headRefOid, files: string[], hasFreshSticky: boolean } or null on error/missing.
 *
 * Test overrides (each is independent):
 *   DEVPRO_POST_PR_GATE_MOCK_STICKY=CSV-of-PR-numbers       → those PRs have sticky
 *   DEVPRO_POST_PR_GATE_MOCK_HEAD_REF=PR#:branch[...]       → headRefName per PR
 *   DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA=PR#:sha[...]          → headRefOid per PR
 *   DEVPRO_POST_PR_GATE_MOCK_FILES=PR#:f1|f2[...]           → files per PR (| separated); a token is
 *                                                              a bare path (status unknown) or
 *                                                              `<status>\t<path>` (#3333)
 *   DEVPRO_POST_PR_GATE_MOCK_FILES_UNAVAILABLE=CSV          → those PRs return a light snapshot
 *                                                              (files: [], filesAvailable: false)
 *   DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT=PR#:PASS[...]   → sticky verdict per PR; "missing" omits
 *   DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA=PR#:sha[...]        → sticky sha per PR; "missing" omits
 *   DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH=PR#:id[...]    → sticky dispatch_id per PR; "missing" omits
 *   DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE=CSV       → those PRs return null snapshot
 *   DEVPRO_POST_PR_GATE_MOCK_BRANCH_PR=branch:PR#[...]      → branch-only marker resolves to PR
 *   DEVPRO_POST_PR_GATE_MOCK_STATE=PR#:MERGED[...]          → PR state per PR; default OPEN
 *   DEVPRO_POST_PR_GATE_MOCK_BODY_B64=PR#:base64[...]       → PR body (base64; body text is
 *                                                              multi-line/contains `:`/`,` so the
 *                                                              plain PR#:value CSV convention
 *                                                              can't carry it raw); default ""
 *
 * When any mock env is set: assume "test mode" — skip real gh call. Mocked PRs
 * default to: hasFreshSticky=false, headRefName="<no mock>" (non-exempt branch),
 * headRefOid=<40-hex mock>, baseRefName="main", files=["<no mock>"] (non-chore-A so not auto-exempt).
 * Tests must explicitly mock STICKY=PR#... or HEAD_REF=PR#:chore/bump-v6.0.0 etc.
 * to opt into those paths.
 *
 * Fail-open on gh error: returns null (caller treats as "unknown, proceed to block").
 */
function hasMockPrSnapshotEnv() {
  const mockSticky = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY;
  const mockHeadRef = process.env.DEVPRO_POST_PR_GATE_MOCK_HEAD_REF;
  const mockHeadSha = process.env.DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA;
  const mockFiles = process.env.DEVPRO_POST_PR_GATE_MOCK_FILES;
  const mockStickyVerdict = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT;
  const mockStickySha = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA;
  const mockStickyDispatch = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH;
  const mockSnapshotUnavailable = process.env.DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE;
  const mockBranchPr = process.env.DEVPRO_POST_PR_GATE_MOCK_BRANCH_PR;
  const mockState = process.env.DEVPRO_POST_PR_GATE_MOCK_STATE;
  const mockBodyB64 = process.env.DEVPRO_POST_PR_GATE_MOCK_BODY_B64;
  const mockFilesUnavailable = process.env.DEVPRO_POST_PR_GATE_MOCK_FILES_UNAVAILABLE;

  return [mockSticky, mockHeadRef, mockHeadSha, mockFiles, mockStickyVerdict, mockStickySha, mockStickyDispatch, mockSnapshotUnavailable, mockBranchPr, mockState, mockBodyB64, mockFilesUnavailable]
    .some((v) => typeof v === "string");
}

function mockPrSnapshot(prNumber, comparisonRepo = "github.com/devpro-tw/devpro-agent-rules") {
  const mockSticky = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY;
  const mockHeadRef = process.env.DEVPRO_POST_PR_GATE_MOCK_HEAD_REF;
  const mockHeadSha = process.env.DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA;
  const mockFiles = process.env.DEVPRO_POST_PR_GATE_MOCK_FILES;
  const mockStickyVerdict = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT;
  const mockStickySha = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA;
  const mockStickyDispatch = process.env.DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH;
  const mockSnapshotUnavailable = process.env.DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE;
  const unavailable = typeof mockSnapshotUnavailable === "string"
    && mockSnapshotUnavailable.split(",").map((s) => s.trim()).filter(Boolean).includes(String(prNumber));
  if (unavailable) return null;
  const hasSticky = typeof mockSticky === "string"
    && mockSticky.split(",").map((s) => s.trim()).filter(Boolean).includes(String(prNumber));
  // Default headRefName to a non-exempt placeholder so tests have to opt into exemption.
  const headRefMap = parseKvCsv(mockHeadRef || "");
  const headRefName = headRefMap[String(prNumber)] || "feature/test-non-exempt";
  const headShaMap = parseKvCsv(mockHeadSha || "");
  const headRefOid = headShaMap[String(prNumber)] || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  // Default files to include a proposal.md path so tests aren't auto-exempt as chore-A.
  const filesMap = parseKvCsv(mockFiles || "");
  const filesRaw = filesMap[String(prNumber)];
  const mockFilesUnavailable = process.env.DEVPRO_POST_PR_GATE_MOCK_FILES_UNAVAILABLE;
  // Mirrors snapshotFromGhData({ filesAvailable: false }): a light-only snapshot
  // carries an empty file list that callers must not read as a diff shape.
  const filesAvailable = !(typeof mockFilesUnavailable === "string"
    && mockFilesUnavailable.split(",").map((s) => s.trim()).filter(Boolean).includes(String(prNumber)));
  const mockTokens = !filesAvailable
    ? []
    : (typeof filesRaw === "string" && filesRaw)
      ? filesRaw.split("|").map((s) => s.trim()).filter(Boolean)
      : ["openspec/changes/test-non-exempt/proposal.md"];
  const { files, statuses: fileStatuses } = toExemptionInput(mockTokens.map((token) => {
    const [first, second] = token.split("\t");
    // A bare path carries no status (unknown), exactly like a snapshot source that omits it.
    return second === undefined ? { path: first, status: undefined } : { path: second, status: first };
  }));
  const verdictMap = parseKvCsv(mockStickyVerdict || "");
  const shaMap = parseKvCsv(mockStickySha || "");
  const dispatchMap = parseKvCsv(mockStickyDispatch || "");
  const stickyBody = buildMockStickyBody({
    verdict: verdictMap[String(prNumber)] || "PASS",
    sha: shaMap[String(prNumber)] || headRefOid,
    dispatchId: dispatchMap[String(prNumber)] || "mock-dispatch",
  });
  const url = `https://${comparisonRepo || "github.com/devpro-tw/devpro-agent-rules"}/pull/${prNumber}`;
  const freshness = resolveStickyFreshness(stickyBody, headRefOid, { comparisonRepo });
  const hasFreshSticky = hasSticky && freshness.fresh;
  // "fresh 才解析" — stickyDispatchId/stickyVerdict only surface when the
  // sticky is fresh (exact or Path D′ equivalent), matching snapshotFromGhData's
  // convention. (Prior to Path D′ this builder unconditionally parsed both
  // regardless of freshness; this is a deliberate unification of the two
  // snapshot builders — see dp-programmer report for this change.)
  const stickyDispatch = hasFreshSticky ? parseStickyDispatchId(stickyBody) : { found: false };
  const stickyVerdict = hasFreshSticky ? parseStickyVerdict(stickyBody) : { found: false };
  // Default OPEN so existing tests (which never set state) keep their semantics;
  // tests opt into MERGED/CLOSED via DEVPRO_POST_PR_GATE_MOCK_STATE.
  const stateMap = parseKvCsv(process.env.DEVPRO_POST_PR_GATE_MOCK_STATE || "");
  const state = (stateMap[String(prNumber)] || "OPEN").toUpperCase();
  const bodyB64Map = parseKvCsv(process.env.DEVPRO_POST_PR_GATE_MOCK_BODY_B64 || "");
  const bodyB64 = bodyB64Map[String(prNumber)];
  const prBody = typeof bodyB64 === "string" && bodyB64
    ? Buffer.from(bodyB64, "base64").toString("utf8")
    : "";
  // design.md D6 Open Question 3: canonical sticky body/identity kept for the
  // external-marker digest/comment-identity comparison — gated on `hasSticky`
  // (candidate present at all), NOT `hasFreshSticky`, since a stale-head sticky
  // still has to be readable for the `retain` diagnosis to distinguish "digest
  // drifted" from "no sticky at all". No new gh call: this reuses the same mock
  // sticky body the freshness check above already built.
  const canonicalStickyCommentId = hasSticky ? 500000000 + (Number(prNumber) || 0) : null;
  const canonicalStickyCommentUrl = hasSticky
    ? `${url}#issuecomment-${canonicalStickyCommentId}`
    : "";
  return {
    number: String(prNumber),
    url,
    state,
    headRefName,
    headRefOid,
    baseRefName: "main",
    files,
    fileStatuses,
    filesAvailable,
    hasFreshSticky,
    hasFreshWaiver: false,
    reviewedHeadRefOid: hasFreshSticky ? freshness.reviewedHeadRefOid : "",
    freshEquivalent: hasFreshSticky ? freshness.equivalence : null,
    stickyDispatchId: stickyDispatch.found ? stickyDispatch.dispatchId : "",
    stickyVerdict: stickyVerdict.found ? stickyVerdict.verdict : "",
    stickyBody: hasSticky ? stickyBody : "",
    stickyCommentId: canonicalStickyCommentId,
    stickyCommentUrl: canonicalStickyCommentUrl,
    prBody,
  };
}

// design.md D6 Open Question 3: `gh pr view --json comments` (GraphQL-backed)
// returns each comment's numeric issue-comment id ONLY inside its `url`
// (`…#issuecomment-<id>`) — the `id`/`node_id` fields are opaque GraphQL node
// ids, never the safe integer the second-form completion receipt's
// `sticky_comment_id` requires. Parse it from the url rather than adding a
// second gh call.
function parseIssueCommentIdFromUrl(url) {
  const match = typeof url === "string" ? url.match(/#issuecomment-([1-9][0-9]*)$/) : null;
  return match ? Number(match[1]) : null;
}

function resolveCanonicalStickyCommentIdentity(authorityComment) {
  if (!authorityComment) return { id: null, url: "" };
  const rawUrl = typeof authorityComment.html_url === "string"
    ? authorityComment.html_url
    : (typeof authorityComment.url === "string" ? authorityComment.url : "");
  const id = Number.isSafeInteger(authorityComment.id) && authorityComment.id > 0
    ? authorityComment.id
    : parseIssueCommentIdFromUrl(rawUrl);
  return { id, url: rawUrl };
}

// Use the PR URL for the compare host and repository. When a marker names a repository, require that the URL agrees.
function snapshotFromGhData(data = {}, { filesAvailable = true, cwd = process.cwd(), expectedComparisonRepo = "" } = {}) {
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const headRefOid = typeof data.headRefOid === "string" ? data.headRefOid.trim() : "";
  const stickyAuthority = selectExactSecondReviewStickyAuthority(comments);
  const authoritativeBody = stickyAuthority.status === "selected"
    ? stickyAuthority.authority.body
    : "";
  // Kept independent of `hasFreshSticky` below (design.md D6): the external
  // marker `retain` diagnosis needs to tell "digest drifted on a still-fresh
  // head" apart from "no canonical sticky at all", which a freshness-gated
  // body would collapse into the same empty value.
  const canonicalStickyIdentity = stickyAuthority.status === "selected"
    ? resolveCanonicalStickyCommentIdentity(stickyAuthority.authority)
    : { id: null, url: "" };
  const returnedRepo = repoName(prUrlRepo(data.url));
  const comparisonRepo = expectedComparisonRepo === "" || returnedRepo === expectedComparisonRepo ? returnedRepo : "";
  const freshness = authoritativeBody !== ""
    ? resolveStickyFreshness(authoritativeBody, headRefOid, { cwd, comparisonRepo })
    : { fresh: false, reviewedHeadRefOid: "", equivalence: null };
  const hasFreshSticky = freshness.fresh;
  // Snapshot stickyDispatchId/stickyVerdict stay fresh-gated so consumers that
  // only check `stickyVerdict === "PASS"` without `hasFreshSticky` cannot clear
  // on a stale PASS leak. Path W evaluation uses a local ungated verdict so
  // stale CRITICAL still blocks and stale UNAVAILABLE may still clear.
  const parsedStickyDispatch = hasFreshSticky
    ? parseStickyDispatchId(authoritativeBody)
    : { found: false };
  const parsedStickyVerdict = hasFreshSticky
    ? parseStickyVerdict(authoritativeBody)
    : { found: false };
  const stickyVerdictForPathW = (() => {
    if (!authoritativeBody) return "";
    const parsed = parseStickyVerdict(authoritativeBody);
    return parsed.found ? parsed.verdict : "";
  })();
  const waiverPathW = evaluateCrossModelWaiverPathW(comments, headRefOid);
  // Path W clears markers only for missing sticky / UNAVAILABLE — never CRITICAL
  // or multi-sticky ambiguous (stickyAllowsCrossModelWaiverPathW fail-closed).
  const hasFreshWaiver = waiverPathW.status === "pass"
    && stickyAllowsCrossModelWaiverPathW({
      status: stickyAuthority.status,
      stickyVerdict: stickyVerdictForPathW,
    });
  const headRefName = typeof data.headRefName === "string" ? data.headRefName : "";
  const baseRefName = typeof data.baseRefName === "string" ? data.baseRefName.trim() : "";
  // `files` is complete only when the caller opted in (filesAvailable) AND
  // `changedFiles` is a safe integer equal to `files.length` — `gh pr view
  // --json files` alone is capped by GitHub at 100 files, so a `files` array
  // that disagrees with (or lacks) the independent `changedFiles` total is
  // truncated, not complete. Any other shape MUST be treated as unavailable
  // (never a partial list) so a caller checking `filesAvailable` cannot be
  // handed a silently-truncated list. Applies to every snapshot source
  // (fetchPrSnapshot's PR-number path and the branch-lookup fallback both
  // funnel through this builder).
  const filesComplete = filesAvailable
    && Array.isArray(data.files)
    && Number.isSafeInteger(data.changedFiles)
    && data.changedFiles === data.files.length;
  // GraphQL `changeType` (ADDED / MODIFIED / DELETED / RENAMED ...) rides along so the chore-A exemption can
  // tell an in-place edit of another change's proposal from an added or removed one (#3333). GraphQL names a
  // renamed file by its new path only, so a proposal renamed AWAY is invisible here (REST, which the merge gate
  // reads, also reports the old name); this side stays the looser of the two, and the merge gate is the stricter.
  const { files, statuses: fileStatuses } = toExemptionInput(
    filesComplete ? data.files.map((f) => ({ path: f?.path, status: f?.changeType })) : []
  );
  const number = data.number ? String(data.number) : "";
  const url = typeof data.url === "string" ? data.url : "";
  const state = typeof data.state === "string" ? data.state.toUpperCase() : "";
  // Named `prBody`, not `body` — this file's existing vocabulary already uses
  // "body" for sticky-comment bodies (authoritativeBody, stickyBody); a bare
  // `body` field on the snapshot would collide with that meaning.
  const prBody = typeof data.body === "string" ? data.body : "";
  return {
    number,
    url,
    state,
    headRefName,
    headRefOid,
    baseRefName,
    files,
    fileStatuses,
    filesAvailable: filesComplete,
    hasFreshSticky,
    hasFreshWaiver,
    reviewedHeadRefOid: hasFreshSticky ? freshness.reviewedHeadRefOid : "",
    freshEquivalent: hasFreshSticky ? freshness.equivalence : null,
    stickyDispatchId: parsedStickyDispatch.found ? parsedStickyDispatch.dispatchId : "",
    stickyVerdict: parsedStickyVerdict.found ? parsedStickyVerdict.verdict : "",
    stickyBody: authoritativeBody,
    stickyCommentId: canonicalStickyIdentity.id,
    stickyCommentUrl: canonicalStickyIdentity.url,
    prBody,
  };
}

// `repositorySlug` is set only for a PR of another repository (see the marker writer); empty
// keeps the lookup on the current checkout's repository.
function fetchGhPrView(prNumber, fields, { timeoutMs = 5000, repository = "" } = {}) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  if (timeout <= 0) return null;
  try {
    const result = spawnSync(
      "gh",
      ["pr", "view", prNumber, ...(repository ? ["-R", repository] : []), "--json", fields],
      { encoding: "utf8", timeout: Math.max(1, Math.floor(timeout)) }
    );
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout || "{}");
  } catch {
    return null;
  }
}

function isPrNumber(value) {
  const number = String(value ?? "");
  return /^[1-9]\d{0,15}$/.test(number) && Number.isSafeInteger(Number(number));
}

function matchesPrLookup(data, repository, { prNumber, branch }) {
  if (!data) return false;
  const number = String(data.number ?? "");
  const returnedRepository = repoName(prUrlRepo(data.url));
  return isPrNumber(number)
    && returnedRepository !== "" && (!repository || returnedRepository === repository)
    && prUrlNumber(data.url) === number
    && (!prNumber || number === String(prNumber))
    && (!branch || data.headRefName === branch);
}

// The window shared by the light and the full call is measured on the monotonic clock: a wall-clock step during the light call must
// not stretch the full call's timeout beyond the time that really remains.
function fetchPrSnapshot(prNumber, {
  timeoutMs = 5000, repository = "", branch = "", fallback = null,
} = {}) {
  if (!prNumber) return null;

  if (hasMockPrSnapshotEnv()) {
    return mockPrSnapshot(prNumber, repository || undefined);
  }

  const cached = repository
    ? readGithubCheck(process.cwd(), repository.slice("github.com/".length), Number(prNumber))
    : null;
  if (matchesPrLookup(cached?.ghPr, repository, { prNumber, branch })
      && selectGithubRoute({ ...probeGhAuthentication(), mcpAvailable: true }).route === "mcp") {
    return snapshotFromGhData(cached.ghPr, {
      filesAvailable: cached.complete?.files === true, expectedComparisonRepo: repository,
    });
  }

  const budgetedTimeout = Math.max(0, Number(timeoutMs) || 0);
  if (budgetedTimeout <= 0) return fallback;
  const deadline = performance.now() + budgetedTimeout;

  const lightTimeout = nextDeadlineBoundTimeoutMs({ deadline, now: performance.now(), minMs: 1 });
  const lightData = fetchGhPrView(prNumber, GH_PR_LIGHT_FIELDS, { timeoutMs: lightTimeout, repository });
  if (!lightData) return fallback;
  if (!matchesPrLookup(lightData, repository, { prNumber, branch })) return null;
  const lightSnapshot = snapshotFromGhData(lightData, { filesAvailable: false, expectedComparisonRepo: repository });
  if (lightSnapshot.state === "MERGED" || lightSnapshot.hasFreshSticky || lightSnapshot.hasFreshWaiver) {
    return lightSnapshot;
  }

  const remainingForFull = nextDeadlineBoundTimeoutMs({ deadline, now: performance.now(), minMs: 50 });
  if (remainingForFull <= 0) return lightSnapshot;
  const verifiedRepository = repository || repoName(prUrlRepo(lightSnapshot.url));
  const fullData = fetchGhPrView(prNumber, GH_PR_FULL_FIELDS, {
    timeoutMs: remainingForFull, repository: verifiedRepository,
  });
  if (!fullData) return lightSnapshot;
  if (!matchesPrLookup(fullData, verifiedRepository, { prNumber, branch })) return null;
  return snapshotFromGhData(fullData, {
    filesAvailable: Array.isArray(fullData.files), expectedComparisonRepo: verifiedRepository,
  });
}

function fetchGhPrListByBranch(branch, { timeoutMs, repository }) {
  if (!(timeoutMs >= 1)) return null;
  try {
    const result = spawnSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1",
        ...(repository ? ["-R", repository] : []), "--json", GH_PR_LIGHT_FIELDS],
      { encoding: "utf8", timeout: Math.floor(timeoutMs) }
    );
    if (result.status !== 0) return null;
    const data = JSON.parse(result.stdout || "[]");
    return Array.isArray(data) ? data[0] : null;
  } catch {
    return null;
  }
}

// `runBudget` (the marker loop's monotonic budget) bounds every gh call here by the time that remains; without it (callers outside
// the loop) each call keeps its fixed 5 s.
function fetchPrSnapshotByBranch(branch, { runBudget, repository = "" } = {}) {
  const rawBranch = typeof branch === "string" ? branch.trim() : "";
  if (!rawBranch) return null;
  const capMs = () => (runBudget ? probeTimeoutMs(runBudget) : 5000);

  if (hasMockPrSnapshotEnv()) {
    const branchPrMap = parseKvCsv(process.env.DEVPRO_POST_PR_GATE_MOCK_BRANCH_PR || "");
    const prNumber = branchPrMap[rawBranch] || "";
    return prNumber ? mockPrSnapshot(prNumber, repository || undefined) : null;
  }

  // --state all (not just open): a branch-only marker whose PR has already
  // MERGED must still resolve so the merged→clear self-heal can fire. With
  // --state open a merged PR returns empty → snapshot null → marker never
  // clears until the 2h stale-expire (the false post-merge hard-block seen
  // when create-output PR-number parsing failed and only branch was known).
  const lightData = fetchGhPrListByBranch(rawBranch, { timeoutMs: capMs(), repository });
  if (!matchesPrLookup(lightData, repository, { branch: rawBranch })) return null;
  const lightSnapshot = snapshotFromGhData(lightData, { filesAvailable: false, expectedComparisonRepo: repository });
  if (lightSnapshot.state === "MERGED" || lightSnapshot.hasFreshSticky || lightSnapshot.hasFreshWaiver) {
    return lightSnapshot;
  }
  return fetchPrSnapshot(lightSnapshot.number, {
    timeoutMs: capMs(), repository: repository || repoName(prUrlRepo(lightSnapshot.url)),
    branch: rawBranch, fallback: lightSnapshot,
  });
}

function buildMockStickyBody({ verdict = "PASS", sha = "", dispatchId = "mock-dispatch" } = {}) {
  const lines = [
    SECOND_REVIEW_STICKY_MARKER,
    "## Cross-Model Review",
  ];
  if (verdict !== "missing") lines.push(`verdict: ${verdict}`);
  if (sha !== "missing") lines.push(`last_reviewed_sha: ${sha}`);
  if (dispatchId !== "missing") lines.push(`dispatch_id: ${dispatchId}`);
  lines.push(
    "reason: The bounded mock review completed for the requested scope.",
    SECOND_REVIEW_STICKY_MOCK_PROVENANCE
  );
  return lines.join("\n");
}

/**
 * Parse "key:value,key:value" CSV into a {key:value} map.
 * Used for mock env vars in tests.
 */
function parseKvCsv(s) {
  const out = {};
  if (!s) return out;
  for (const pair of s.split(",")) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function markerBranch(marker) {
  return String(marker?.headRefName || marker?.branch || "").trim();
}

// How long a resolved change-usage total is reused across Stop turns. The cache falls
// through to a fresh resolve on any failure, so a missing definition does not fail the
// hook; it turns the cache off, and `cachedResolveChangeCostUsage` names it on stderr.
const COST_USAGE_CACHE_TTL_MS = 5 * 60_000;

// The ordinary ways a cache read or write fails: a file system error (no cache file yet,
// unreadable, a directory in its place — every one carries an `E…` code) or a corrupt JSON
// body. Anything else raised there is a bug in this hook — an undeclared name, a wrong type —
// and the fall-through must not hide it: the cache would just stop working, silently.
function isOrdinaryCacheFault(error) {
  return error instanceof SyntaxError || /^E[A-Z]+$/.test(String(error?.code ?? ""));
}

function noteUnexpectedCacheFault(stage, error) {
  if (isOrdinaryCacheFault(error)) return;
  process.stderr.write(
    `post-pr-completion-check: cost usage cache ${stage} failed unexpectedly (${error?.name}: ${error?.message}); falling back to a fresh resolve.\n`,
  );
}

function costUsageCacheDir(cwd) {
  return (
    process.env.DEVPRO_POST_PR_COST_USAGE_CACHE_STATE_DIR ||
    defaultRepoStateDir("devpro-post-pr-cost-usage-cache", cwd)
  );
}

function costStateKey(changeName, repository) {
  // The separator cannot occur in a legacy key. Hash the full name and
  // repository together so neither long names nor sanitization can alias.
  if (repository) return `#${sha256Hex(JSON.stringify([repository, changeName]))}`;
  return String(changeName).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
}

// Deliberately relies on `JSON.stringify` omitting an `undefined`-valued key:
// when `resolveChangeCostUsage` returns `undefined` (unresolvable change_name
// or checkpoint), `{cachedAt, usage: undefined}` serializes without a `usage`
// key at all, and `JSON.parse` back reads `data.usage` as `undefined` again —
// the same "unavailable" value a fresh (uncached) call would have returned.
function cachedResolveChangeCostUsage({ changeName, cwd, env, now, repository, stateCwd, checkpointStateDir }) {
  const dir = costUsageCacheDir(stateCwd);
  const file = path.join(dir, `${costStateKey(changeName, repository)}.json`);
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const ts = Date.parse(String(data?.cachedAt || ""));
    if (Number.isFinite(ts) && now - ts < COST_USAGE_CACHE_TTL_MS) {
      return data.usage;
    }
  } catch (error) {
    // No cache file, unreadable, or corrupt — fall through to a fresh
    // resolve. Fail-open toward MORE reads, never toward reusing bad data.
    noteUnexpectedCacheFault("read", error);
  }
  const usage = resolveChangeCostUsage({ changeName, cwd, env, checkpointStateDir });
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ cachedAt: new Date(now).toISOString(), usage }));
  } catch (error) {
    // Fail-open: if the cache can't be persisted, next turn just re-resolves
    // — never a reason to change this turn's own evaluation result.
    noteUnexpectedCacheFault("write", error);
  }
  return usage;
}

// R4/D10 (task 7): human-readable line for one reported threshold.
// `stalled_rounds` has no numeric value/limit (COST_BUDGET_THRESHOLDS.
// stalled_rounds.limit is `null` by design — the real cap number stays
// inside review-stall-budget.mjs) so it reads as a plain label instead of a
// `value > limit` comparison.
//
// Renamed from `formatExceededThresholdLine` by T12: since D20 a line here can
// describe a threshold that is blocking WITHOUT being exceeded, and a name
// that promised otherwise would mislead the next reader at exactly the branch
// that decides whether the message is true.
function formatCostThresholdLine(key, thresholds) {
  const meta = COST_BUDGET_THRESHOLDS[key];
  const state = thresholds[key];
  // D20: `stalled_rounds` blocks on `unavailable` too — receipts exist but the
  // chain will not load. Rendering that with the same words as a measured
  // streak would report damaged evidence as if it had been read, which is the
  // "看起來在守、實際沒守" shape D20 exists to remove.
  if (state?.state === "unavailable") {
    return `${meta.label}（無法判定：收據存在但收據鏈讀不出或驗不過）`;
  }
  // Keyed on the property, not on the key. A threshold whose `limit` is null
  // does not hold its number in this table — `stalled_rounds`'s cap lives in
  // `review-stall-budget.mjs` — so there is no `value > limit` comparison to
  // render, and the label is written to stand alone for exactly that reason.
  //
  // The measured value still prints when there is one: `stalled_rounds`'s is
  // the streak itself, and it is the difference between "something stalled"
  // and "nothing has closed for 2 rounds" — the only quantity in this whole
  // section the user's next decision actually turns on.
  if (meta.limit === null) {
    return state?.value === null || state?.value === undefined ? meta.label : `${meta.label}：實測 ${state.value}`;
  }
  return `${meta.label}: ${state.value} > ${meta.limit} ${meta.unit}`;
}

// F-0fe5da39 fix: cost/disclosure breaker hits get the same once-per-window
// Stop-hook downgrade as a pending cross-review marker (wasRecentlyHardBlocked
// / markPostPrCompletionReminded below), but keyed by change_name instead of
// a marker file — a breaker hit can fire with stillPending fully empty (cross
// -review already cleared), so there is no marker file to carry a timestamp
// on (own state dir, session-scoped key, fail-open on persistence failure). This only softens THIS turn's Stop-hook response
// shape; it never clears the underlying state — the checkpoint override
// entry and PR-body disclosure section still have to actually change before
// evaluatePostPrCostBudget/evaluateOverrideDisclosure stop reporting a hit,
// and checkCrossModelMergeGate stays fail-closed regardless of which
// response shape a given Stop invocation takes.
function costCircuitBreakerReminderDir(cwd) {
  return (
    process.env.DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR ||
    defaultRepoStateDir("devpro-post-pr-cost-breaker-reminder", cwd)
  );
}

function costCircuitBreakerReminderFile(dir, key) {
  const sessionKey = reminderSession?.key || "no-session";
  return path.join(dir, `${sessionKey}__${key}.json`);
}

function wasCostCircuitBreakerRecentlyReminded(key, cwd, now) {
  try {
    const dir = costCircuitBreakerReminderDir(cwd);
    const data = JSON.parse(readFileSync(costCircuitBreakerReminderFile(dir, key), "utf8"));
    const ts = Date.parse(String(data?.remindedAt || ""));
    return Number.isFinite(ts) && now - ts < HARD_BLOCK_DEDUP_MS;
  } catch {
    // No reminder file, unreadable, or corrupt → treat as "not yet
    // reminded". Fail-open toward MORE hard-blocks, never toward a
    // premature downgrade.
    return false;
  }
}

function markCostCircuitBreakerReminded(key, cwd, now) {
  try {
    const dir = costCircuitBreakerReminderDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      costCircuitBreakerReminderFile(dir, key),
      // The supervisor (R8) hands its run id down; carrying it lets the supervisor tell "written by THIS run" from an earlier
      // reminder without comparing timestamps. Without the variable the record is exactly what it always was.
      JSON.stringify({ remindedAt: new Date(now).toISOString(), ...(process.env.DEVPRO_STOP_RUN_ID ? { runId: process.env.DEVPRO_STOP_RUN_ID } : {}) })
    );
  } catch {
    // Fail-open: if this can't be persisted, the next turn just hard-blocks
    // again instead of downgrading — never a reason to change this turn's
    // own decision.
  }
}

// R4/D10/D12 (task 7 acceptance #1): "命中時 block 並輸出編號停點選項（選項
// 1 ＝ 停、交使用者決定）". This section's numbered options are written to be
// relayed to the human user verbatim (per stop-point-comms.md's "single
// determinate action" shape) — the circuit breaker's whole purpose is that
// the AGENT must never unilaterally pick "continue" on the user's behalf.
// D19 row 3 / D20: which thresholds stop this hook, and in which states, is
// `blockingCostThresholds` in post-pr-cost-circuit-breaker.mjs — the same
// module that produces the evaluation it reads. It moved there with T12 so the
// state matrix is testable directly rather than only through a spawned hook.

// D14/D19, "閘走了、話還在". An overage that no longer blocks is still
// reported, with the same threshold names and numbers the block section
// prints. Two things are deliberately absent: the numbered option block, and
// the once-per-window downgrade. The options would re-create the stop this
// change removed, and the downgrade exists to let an agent escape a *block*
// loop -- there is nothing to escape here, and suppressing the line would
// leave the totals unreported on exactly the turns where nothing else speaks.
function costBudgetSubject({marker, branch, changeName, repository}) {
  const id = marker.prNumber ? `PR #${marker.prNumber}` : "PR (number unknown)";
  const branchLabel = branch ? ` on \`${branch}\`` : "";
  const changeLabel = changeName ? `（change: \`${changeName}\`）` : "";
  return `${id}${branchLabel}${changeLabel}${repository ? ` — ${repository}` : ""}`;
}

function buildCostBudgetAdvisorySection(costBudgetAdvisory) {
  if (costBudgetAdvisory.length === 0) return null;
  const lines = costBudgetAdvisory.flatMap((entry) => {
    const {result, reportedThresholds} = entry;
    // Each line leads with the threshold KEY, then the shared label/number
    // formatter. `model_time`'s label reads "cumulative model time", so a
    // label-only line never spells the key a reader has to type into
    // `DEVPRO_COST_BUDGET_OVERRIDE`. The block section above has the same gap
    // and is deliberately left alone: its wording is what the agent is
    // required to relay verbatim, and restyling it is not this change's job.
    const detail = reportedThresholds.map((key) => `  - \`${key}\` — ${formatCostThresholdLine(key, result.thresholds)}`);
    return [`- ${costBudgetSubject(entry)}：`, ...detail];
  });
  // The heading and closing line MUST stay true of both callers. The ordinary
  // path feeds this the three cumulative advisory thresholds, all `exceeded`.
  // The override-cleared path (D14) feeds it whatever was *reported*, which is
  // `stalled_rounds`, and an overridden `unavailable` stall exceeds nothing at
  // all -- so neither "累積用量" nor "已超過" can be asserted over the whole
  // list. Each rendered row already carries its own state, so the prose names
  // the list and lets the rows speak for their own numbers.
  return [
    "### Cost circuit breaker advisory (not a stop)",
    "",
    "本 change 回報了下列門檻。這是 advisory：**不是停點**，不需使用者裁決，也不得據此宣告 blocked（`workflow-cost-controls.md`）。每列自帶該門檻當下的狀態，出現在這裡不等於超標——被具名 override 清掉的那一輪同樣會列在這裡：",
    "",
    ...lines,
    "",
    "真正擋人的是浪費不是總量：三個累積量一律 advisory，只有 `stalled_rounds`（連續數輪沒收斂，或收據鏈讀不出而無法判定）會停（見 `review-stall-budget.mjs`）。",
  ].join("\n");
}

function buildCostBudgetBlockSection(costBudgetBlocked) {
  if (costBudgetBlocked.length === 0) return null;
  // `branch` here is the evaluated `evalBranch` (snapshot headRefName-first)
  // the caller carried through, not `marker.branch` — a branch-only marker
  // resolved via fetchPrSnapshotByBranch can have a `marker.branch` that
  // differs from the branch change_name was actually derived from.
  const lines = costBudgetBlocked.flatMap((entry) => {
    const {changeName, result, reportedThresholds, override} = entry;
    // Each line leads with the threshold KEY, for the same reason the advisory
    // does: the key is what the user has to type into
    // `DEVPRO_COST_BUDGET_OVERRIDE`, and no label spells it. T4 left this gap
    // alone because restyling was outside its authorization; T12 changes which
    // threshold stops here, so naming it is no longer styling.
    const detail = reportedThresholds.map((key) => `  - \`${key}\` — ${formatCostThresholdLine(key, result.thresholds)}`);
    // An `unavailable` row means this checkout could not judge, not that the
    // change stalled. Name the report that settles it for this change; `ok`
    // there means the read failed here, `exceeded` means a real stall.
    const hasUnavailable = blockingCostThresholds(result).some((key) => result.thresholds[key]?.state === "unavailable");
    const recheckLines = hasUnavailable && changeName
      ? [`  - 重查：到該 change 的 worktree 執行 \`node .devpro/scripts/report-session-token-usage.mjs --since-change ${changeName} --budget-check\`；\`stalled_rounds\` 回 \`ok\` 代表只是這個 checkout 讀不出收據鏈、不是停滯，回 \`exceeded\` 才是真停滯`]
      : [];
    // D5/D12 (fix-second-review-loop-friction): a declared-but-ineffective
    // `DEVPRO_COST_BUDGET_OVERRIDE` (key present, blank included) gets its
    // resolver-named reason surfaced here — the same "silent ineffective
    // override" gap fix-second-review-override-visibility R1/R3 named, now
    // re-anchored to this block (the renderer no longer resolves this env at
    // all since D2). A `hint:` line follows when the reason is
    // `unknown_threshold_key` because of a legacy `round`/`review_round`
    // declaration (D5).
    const overrideLines = override
      ? [
        `  - cost_budget_override_ineffective: ${override.reason}`,
        ...(typeof override.hint === "string" ? [`  - hint: ${override.hint}`] : []),
      ]
      : [];
    return [`- ${costBudgetSubject(entry)}：`, ...detail, ...recheckLines, ...overrideLines];
  });
  // The heading says "exceeded" only when a threshold that stops this turn
  // actually is. The cumulative totals ride along as information and decide
  // nothing here. A stop caused solely by `unavailable` (D20: an unjudgeable
  // stall stops too) measured nothing over a limit, and calling it "exceeded"
  // sent a reader to treat a read failure as a stall.
  const anyExceeded = costBudgetBlocked.some(({ result }) =>
    blockingCostThresholds(result).some((key) => result.thresholds[key]?.state === "exceeded"));
  return [
    anyExceeded ? "### Cost circuit breaker exceeded" : "### Cost circuit breaker blocked（無法判定，不是超標）",
    "",
    anyExceeded
      ? "偵測到本 change 觸發斷路器的停點門檻（cost circuit breaker，見 `workflow-cost-controls.md`）。會停下的是停滯——`stalled_rounds`；同列的累積總量是隨附資訊，本身已不再是停點："
      : "本 change 的斷路器停點門檻 `stalled_rounds` 無法判定（cost circuit breaker，見 `workflow-cost-controls.md`）：收據鏈讀不出或驗不過，並沒有量到超標；無法判定仍會停下，因為看不出是否停滯：",
    "",
    ...lines,
    "",
    "Agent-facing next step（本段落內容 MUST 原樣轉達給使用者；AI 不得代為選擇選項 2）：",
    "1. 是，停下，交由使用者決定下一步（調整範圍／申請具名 override／結束本 change）（Recommended）",
    "2. 否，使用者已確認可承擔後續成本，明確授權繼續",
    "3. 其他",
  ].join("\n");
}

// D11 §S-1 (task 7 S-1 acceptance): PR body override disclosure does not
// match checkpoint overrides[] — same numbered-options framing as the
// cost-budget section above (relay verbatim, AI never self-selects "no
// update needed" on the user's behalf).
function buildOverrideDisclosureBlockSection(disclosureBlocked) {
  if (disclosureBlocked.length === 0) return null;
  // See buildCostBudgetBlockSection's comment: `branch` is the evaluated
  // `evalBranch`, not `marker.branch`.
  // `expectedLines` is the canonical section body derived from the checkpoint
  // (present only for a non-empty overrides[] that can be written canonically).
  // Printing it tells the user what to write, not only what is wrong; the
  // numbered options below still leave the decision to them.
  const lines = disclosureBlocked.flatMap((entry) => {
    const {reason, expectedLines} = entry;
    const head = `- ${costBudgetSubject(entry)}：${reason}`;
    if (!Array.isArray(expectedLines) || expectedLines.length === 0) return [head];
    return [
      head,
      "  依 checkpoint 推出、可逐行貼進該段落的內容：",
      "```",
      ...expectedLines,
      "```",
    ];
  });
  return [
    "### Cost circuit breaker override disclosure mismatch",
    "",
    "PR 描述的 `## Cost Circuit Breaker Overrides` 段落與 checkpoint 記錄的 override 使用不一致（design.md D11 §S-1）：",
    "",
    ...lines,
    "",
    "Agent-facing next step（本段落內容 MUST 原樣轉達給使用者；AI 不得代為選擇選項 2）：",
    "1. 是，停下，交由使用者依 D11 §S-1 格式更新 PR 描述後再繼續（Recommended）",
    "2. 否，使用者已確認目前 PR 描述正確、無需更新",
    "3. 其他",
  ].join("\n");
}

function isStopCrossModelExempt(branch, files, cwd, statuses, headSha, baseRef) {
  if (cwd) return isCrossModelExempt(branch, files, cwd, statuses, headSha, baseRef);
  // The marker lacks a verified checkout of its own. The common branch and
  // diff rules still apply, while checkout-specific evidence needs that repo.
  return Boolean(githubBranchExemptionReason(branch)) || isChoreAClassExempt(branch, files, statuses);
}

function isMarkerBranchPatternExempt(marker, cwd) {
  const branch = typeof marker?.branch === "string" ? marker.branch.trim() : "";
  if (!branch) return false;
  try {
    // Synthetic proposal path prevents an empty changed-files list from being
    // interpreted as chore-A diff-shape exempt. Only branch-pattern exemptions
    // should pass in this pre-gh self-heal path.
    return isStopCrossModelExempt(branch, BRANCH_PATTERN_PROBE_FILES, cwd);
  } catch {
    return false;
  }
}

function markerHasDispatchBinding(marker) {
  return typeof marker?.expected_dispatch_id === "string"
    && marker.expected_dispatch_id.length > 0;
}

function assertDispatchMatchesMarkerBinding(dispatch, marker, snapshot) {
  if (!dispatch) {
    throw new Error("dispatch reservation is missing. Restore the original immutable evidence after confirming the root, then rerun the gate. If unavailable, keep the marker blocked and ask TL to investigate; do not omit ancestors or issue a bypass successor.");
  }
  if (dispatch.repository_slug !== marker.repository_slug
    || dispatch.pr_number !== String(marker.prNumber || snapshot?.number || "")
    || dispatch.head_ref_oid !== marker.head_ref_oid
    || dispatch.dispatch_id !== marker.expected_dispatch_id) {
    throw new Error("dispatch-bound post-PR marker identity mismatch");
  }
}

function assertDispatchMatchesCurrentSnapshot(dispatch, snapshot) {
  // reviewedHeadRefOid (design.md D2 Path D′ parity), not the raw live
  // headRefOid: it equals headRefOid on an exact-match fresh sticky, or the
  // sticky's last_reviewed_sha when a whitelist-only compare proved
  // fresh-equivalence — either way it is "" when the sticky is not fresh at
  // all, so this stays fail-closed exactly as before for every case except
  // the intended carve-out. See resolveStickyFreshness().
  if (!snapshot?.reviewedHeadRefOid || dispatch.head_ref_oid !== snapshot.reviewedHeadRefOid) {
    throw new Error("dispatch-bound post-PR marker is not current for the PR head");
  }
}

async function consumeOrchestrationFault(rootDir, evidence) {
  const durableFault = evidence.capsule ?? evidence.consumption;
  if (!durableFault
    || !ORCHESTRATION_FAULT_CLASSIFICATIONS.has(durableFault.classification)
    || durableFault.responsibility !== "reviewer_invocation_orchestration") {
    throw new Error("fault capsule is outside the post-PR orchestration allowlist");
  }
  if (evidence.consumption) return evidence.consumption;
  const dispatch = evidence.dispatch;
  const consumption = await writeConsumptionReceipt({
    rootDir,
    record: {
      schema: FAULT_CONSUMPTION_SCHEMA,
      repository_slug: dispatch.repository_slug,
      pr_number: dispatch.pr_number,
      head_ref_oid: dispatch.head_ref_oid,
      attempt_id: dispatch.attempt_id,
      dispatch_id: dispatch.dispatch_id,
      previous_dispatch_id: dispatch.previous_dispatch_id,
      outcome: "blocked_orchestration_fault",
      classification: evidence.capsule.classification,
      responsibility: evidence.capsule.responsibility,
      capsule_integrity_id: evidence.capsule.integrity_id,
    },
  });
  return consumption.record;
}

async function consumeCurrentDispatchFault(marker, snapshot) {
  const rootDir = controlEvidenceRoot(process.env);
  const evidence = readDispatchEvidence({
    rootDir,
    dispatchId: marker.expected_dispatch_id,
  });
  // Consumption records that the marker-bound orchestration fault was seen by
  // the post-PR gate. The PR may already have advanced to a new head; this path
  // retains the marker and grants no success, while the renderer separately
  // requires a verified fast-forward before it can bind a successor.
  assertDispatchMatchesMarkerBinding(evidence.dispatch, marker, snapshot);
  if (!evidence.capsule && !evidence.consumption) return false;
  await consumeOrchestrationFault(rootDir, evidence);
  return true;
}

function readDispatchLineage(rootDir, verifiedEvidence) {
  const lineage = [];
  const verified = verifiedEvidence.dispatch;
  const visited = new Set([verified.dispatch_id]);
  let cursor = verified;
  while (cursor.previous_dispatch_id !== null) {
    if (lineage.length + 1 >= MAX_DISPATCH_LINEAGE_RECORDS) {
      throw new Error("dispatch lineage exceeds the post-PR evidence bound");
    }
    if (visited.has(cursor.previous_dispatch_id)) {
      throw new Error("dispatch lineage contains a cycle");
    }
    visited.add(cursor.previous_dispatch_id);
    let predecessor;
    try { predecessor = readDispatchEvidence({ rootDir, dispatchId: cursor.previous_dispatch_id }); }
    catch (error) {
      error.message = `dispatch lineage blocked: current ${verified.dispatch_id}, predecessor ${cursor.previous_dispatch_id}, root ${path.resolve(rootDir)}. ${error.message}`;
      if (error.classification === "reviewer_dispatch_identity_collision") {
        error.message += ". Restore the original immutable evidence after confirming the root, then rerun the gate. If unavailable, keep the marker blocked and ask TL to investigate; do not omit ancestors or issue a bypass successor.";
      }
      throw error;
    }
    if (!predecessor.dispatch) {
      throw new Error(`dispatch lineage blocked: current ${verified.dispatch_id}, missing predecessor ${cursor.previous_dispatch_id}, root ${path.resolve(rootDir)}. Restore the original immutable evidence after confirming the root, then rerun the gate. If unavailable, keep the marker blocked and ask TL to investigate; do not omit ancestors or issue a bypass successor.`);
    }
    for (const field of ["repository_slug", "pr_number"]) {
      if (predecessor.dispatch[field] !== verified[field]) {
        throw new Error(`dispatch lineage ${field} mismatch`);
      }
    }
    if (predecessor.dispatch.head_ref_oid === cursor.head_ref_oid) {
      if (predecessor.dispatch.attempt_id === cursor.attempt_id) {
        throw new Error("same-head dispatch lineage attempt_id must be fresh");
      }
      if (!predecessor.capsule && !predecessor.consumption && !predecessor.completion && !predecessor.terminal && !predecessor.operatorDisposition) {
        throw new Error("same-head dispatch lineage predecessor has no orchestration fault, consumed fault, successful completion, or closed terminal receipt");
      }
    } else {
      if (!predecessor.consumption && !predecessor.completion && !predecessor.terminal && !predecessor.operatorDisposition) {
        throw new Error("cross-head dispatch lineage predecessor has no consumed fault, successful completion, or closed terminal receipt");
      }
    }
    lineage.push(predecessor);
    cursor = predecessor.dispatch;
  }
  return lineage;
}

function isAuthoritativeCurrentHeadPass(marker, snapshot) {
  return snapshot?.hasFreshSticky === true
    && snapshot.stickyVerdict === "PASS"
    && snapshot.stickyDispatchId === marker.expected_dispatch_id
    && snapshot.reviewedHeadRefOid === marker.head_ref_oid;
}

/**
 * MERGED + dispatch-bound + evidence dir never started → unbound-equivalent clear (D6).
 * Incomplete reservation/receipt paths must still verify/retain.
 */
function clearMergedNeverStartedDispatchMarker(marker, snapshot, cwd) {
  // A lineage-clear obligation is discharged only by fresh current-head
  // review evidence. Merge state alone cannot take the ordinary never-started
  // dispatch cleanup shortcut for this stronger marker state.
  if (marker?.lineage_clear_obligation) return null;
  if (!markerHasDispatchBinding(marker)) return null;
  const rootDir = controlEvidenceRoot(process.env);
  if (!dispatchEvidenceNeverStarted({
    rootDir,
    dispatchId: marker.expected_dispatch_id,
  })) {
    return null;
  }
  try {
    const cleared = clearDispatchBoundMarker(marker, snapshot, cwd);
    if (cleared) {
      console.error(
        `post-pr-completion: cleared MERGED dispatch-bound marker for never-started ` +
          `dispatch evidence (${marker.expected_dispatch_id})`
      );
    }
    return Boolean(cleared);
  } catch {
    return false;
  }
}

function dispatchEvidenceBlockedDiagnostic(marker, error) {
  const root = path.resolve(controlEvidenceRoot(process.env));
  let message = String(error?.message ?? error);
  if (!message.includes(marker.expected_dispatch_id) || !message.includes(root)) {
    message = `dispatch evidence blocked: current ${marker.expected_dispatch_id}, root ${root}. ${message}`;
  }
  if (error?.classification === "reviewer_dispatch_identity_collision"
    && !message.includes("Restore the original immutable evidence")) {
    message += ". Restore the original immutable evidence after confirming the root, then rerun the gate. If unavailable, keep the marker blocked and ask TL to investigate; do not omit ancestors or issue a bypass successor.";
  }
  return message;
}

async function verifyDispatchEvidenceAndAppendReceipts(marker, snapshot) {
  if (isAuthoritativeCurrentHeadPass(marker, snapshot)) {
    // The unique canonical sticky is the authority for an exact current-head
    // PASS. Fence retirement before marker CAS; no local orchestration receipt
    // is required, and any fault capsule or missing completion receipt
    // left behind is diagnostic only.
    return clearDispatchBoundMarker(marker, snapshot, process.cwd());
  }
  if (snapshot.stickyDispatchId !== marker.expected_dispatch_id) return false;
  const rootDir = controlEvidenceRoot(process.env);
  let evidenceSnapshot;
  try { evidenceSnapshot = withDispatchEvidenceSnapshot({ rootDir }, () => {
    const verifiedEvidence = readDispatchEvidence({ rootDir, dispatchId: marker.expected_dispatch_id });
    assertDispatchMatchesMarkerBinding(verifiedEvidence.dispatch, marker, snapshot);
    return { verifiedEvidence, lineage: readDispatchLineage(rootDir, verifiedEvidence) };
  }); } catch (error) {
    marker.dispatchEvidenceDiagnostic = dispatchEvidenceBlockedDiagnostic(marker, error);
    throw error;
  }
  const { verifiedEvidence, lineage } = evidenceSnapshot;
  assertDispatchMatchesMarkerBinding(verifiedEvidence.dispatch, marker, snapshot);
  assertDispatchMatchesCurrentSnapshot(verifiedEvidence.dispatch, snapshot);

  // WARN retains the local orchestration-evidence path. A fault on its current
  // dispatch is consumed durably, retains the marker, and requires a genuinely
  // reserved successor.
  if (verifiedEvidence.capsule || verifiedEvidence.consumption) {
    await consumeOrchestrationFault(rootDir, verifiedEvidence);
    return false;
  }

  // A reservation plus invocation claim proves only that a reviewer started.
  // Marker clearance additionally requires the runner's immutable terminal
  // receipt, which binds process closure and the verified sticky to this exact
  // dispatch/head/verdict.
  const completion = verifiedEvidence.completion;
  if (!completion
    || completion.sticky_dispatch_id !== snapshot.stickyDispatchId
    || completion.sticky_verdict !== snapshot.stickyVerdict
    || completion.process_close_observed !== true) {
    return false;
  }
  // Path D′ parity (design.md D2 "post-PR marker 同語意") is resolved upstream
  // in `resolveStickyFreshness`, used by both snapshot builders: it sets
  // `snapshot.reviewedHeadRefOid` to the sticky's `last_reviewed_sha` when a
  // whitelist-only compare proved fresh-equivalence (or to the exact live
  // head on an exact match). This check only verifies the completion
  // receipt's own recorded reviewed sha is still consistent with that already
  // -resolved head — it does not call evaluateFreshEquivalent itself.
  if (completion.sticky_last_reviewed_sha !== snapshot.reviewedHeadRefOid) {
    return false;
  }

  const olderFaults = lineage
    .filter((evidence) => evidence.capsule || evidence.consumption)
    .reverse();
  for (const fault of olderFaults) {
    const consumption = await consumeOrchestrationFault(rootDir, fault);
    const verified = verifiedEvidence.dispatch;
    await writeSupersessionReceipt({
      rootDir,
      faultDispatchId: fault.dispatch.dispatch_id,
      record: {
        schema: FAULT_SUPERSESSION_SCHEMA,
        repository_slug: verified.repository_slug,
        pr_number: verified.pr_number,
        head_ref_oid: verified.head_ref_oid,
        attempt_id: verified.attempt_id,
        dispatch_id: verified.dispatch_id,
        previous_dispatch_id: verified.previous_dispatch_id,
        fault_dispatch_id: fault.dispatch.dispatch_id,
        verified_dispatch_id: verified.dispatch_id,
        outcome: `superseded_by_verified_dispatch:${verified.dispatch_id}`,
        consumption_integrity_id: consumption.integrity_id,
      },
    });
  }
  return clearPostPrCompletionMarker({
    cwd: process.cwd(),
    prNumber: marker.prNumber || snapshot.number || "",
    branch: marker.branch,
    markerFile: marker.file,
    repositorySlug: marker.repository_slug,
    headRefOid: marker.head_ref_oid,
    expectedDispatchId: marker.expected_dispatch_id,
    expectedAuthorityId: marker.authorityId,
    expectedAuthorityCreatedAt: marker.createdAt,
  });
}

function clearDispatchBoundMarker(marker, snapshot, cwd) {
  assertDispatchReviewAuthority({ rootDir: controlEvidenceRoot(process.env, cwd),
    dispatchId: marker.expected_dispatch_id, repositorySlug: marker.repository_slug,
    prNumber: marker.prNumber || snapshot?.number, headRefOid: marker.head_ref_oid });
  // Fence only: exact authoritative PASS does not require a local receipt. Release
  // the capacity snapshot before marker CAS to preserve marker -> capacity order.
  try { assertDispatchEvidenceAvailable({ rootDir: controlEvidenceRoot(process.env), dispatchId: marker.expected_dispatch_id }); }
  catch (error) { marker.dispatchEvidenceDiagnostic = dispatchEvidenceBlockedDiagnostic(marker, error); throw error; }
  return clearPostPrCompletionMarker({
    cwd,
    prNumber: marker.prNumber || snapshot?.number || "",
    branch: marker.branch,
    markerFile: marker.file,
    repositorySlug: marker.repository_slug,
    headRefOid: marker.head_ref_oid,
    expectedDispatchId: marker.expected_dispatch_id,
    expectedAuthorityId: marker.authorityId,
    expectedAuthorityCreatedAt: marker.createdAt,
  });
}

function clearUnboundMarker(marker, clearArgs) {
  try { if (clearPostPrCompletionMarker(clearArgs)) return true; } catch {}
  marker.dispatchEvidenceDiagnostic = `Could not retire ${path.basename(marker.file)}. Inspect the keyed and legacy authorities for this repository and selector before retrying.`;
  return false;
}

// Path W (issue #2499): exact-one current-head user waiver clears the marker
// without sticky PASS / receipt chain. Callers run it before fault consume so
// a documented waiver is not trapped behind orchestration fault retain.
// Returns null when Path W does not apply, else whether the marker cleared.
function clearMarkerOnFreshWaiver(marker, snapshot, clearArgs, cwd) {
  if (!snapshot.hasFreshWaiver || marker.lineage_clear_obligation) return null;
  if (markerHasDispatchBinding(marker)) return Boolean(clearDispatchBoundMarker(marker, snapshot, cwd));
  return clearUnboundMarker(marker, clearArgs);
}

// ── D6: external evaluator marker disposition ──────────────────────────────
// design.md D6 F-3-1: exactly one of `clear_policy` | `clear_verified` |
// `retain` per external marker. This cluster is the SOLE clear/retain
// authority for `executor_kind === "external-evaluator"` markers — every
// existing review-completion clear callsite in the per-marker loop is either unreachable for
// an external marker (branched away via the `continue` at the call site) or
// itself routed through resolveExternalMarkerDisposition. See the callsite
// registry test (hook-post-pr-completion-external-callsite-registry.test.mjs)
// for the exhaustive list. Verified owned CLOSED cancellation precedes this
// review-completion resolver and does not declare review or merge success.

function isExternalMarker(marker) {
  return marker?.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
}

function retainExternalDisposition(reasonCode, actionGroup) {
  return { classification: "retain", cleared: false, reasonCode, actionGroup };
}

// D6 clear_policy: MERGED or cross-model-exempt clears unconditionally, with
// no evidence read at all — same policy shape as the runner's own MERGED/
// exempt self-heal branches this replaces for external markers. Falls back to
// the unbound clear only defensively (an external marker is always dispatch-
// bound by construction; this mirrors the runner loop's own defensive shape).
function clearStopReviewRound(cwd, clearArgs, snapshot) {
  const { prNumber } = clearArgs;
  const repositorySlug = clearArgs.repositorySlug || repoName(prUrlRepo(snapshot?.url));
  if (!repositorySlug && CROSS_REPOSITORY_ONLY) return;
  try {
    clearReviewRoundState({ cwd, prNumber, repositorySlug });
  } catch (error) {
    const reason = error.classification === "review_round_state_identity_conflict"
      ? error.message
      : `Review round state for PR #${prNumber} could not be cleared. Check its sidecar and lock before retrying.`;
    process.stderr.write(`post-pr-completion-check: ${reason}\n`);
  }
}

function finalizeExternalDispositionClear(marker, snapshot, clearArgs, cwd, classification) {
  let cleared;
  try {
    cleared = markerHasDispatchBinding(marker)
      ? clearDispatchBoundMarker(marker, snapshot, cwd)
      : Boolean(clearPostPrCompletionMarker(clearArgs));
  } catch {
    cleared = false;
  }
  if (!cleared) {
    return retainExternalDisposition("external_marker_cas_failed", "d");
  }
  // TC3/R2 parity: the review-round sidecar outlives the marker and is retired
  // only once the PR is MERGED, exactly like the runner loop. Clearing it on
  // clear_verified or an exemption would reset the pr-sticky round cap after
  // every accepted round (post-PR dogfood finding). This is the ONLY place that
  // retires it for an owned external marker.
  if (snapshot?.state === "MERGED") {
    clearStopReviewRound(cwd, clearArgs, snapshot);
  }
  return { classification, cleared: true, reasonCode: null, actionGroup: null };
}

// Raw (non-throwing-on-incomplete) diagnosis of WHY readDispatchEvidenceStrict
// threw `external_closure_incomplete`, so the Blocked message (D6 bullet,
// design audit r2 F-dg-r2-01) can tell "no slot yet / slot accepted but
// receipt missing" (a, accept-fixable) apart from "slot voided but its
// terminal receipt hasn't landed" (c, not accept-fixable — accept would only
// ever get `external_dispatch_closed`).
function classifyExternalClosureIncomplete(rootDir, dispatchId) {
  try {
    const raw = readDispatchEvidence({ rootDir, dispatchId });
    if (raw.externalClosure && raw.externalClosure.kind === "voided") {
      return { reasonCode: "external_dispatch_voided_incomplete", actionGroup: "c" };
    }
    return { reasonCode: "external_closure_pending", actionGroup: "a" };
  } catch {
    return { reasonCode: "external_evidence_unreadable", actionGroup: "d" };
  }
}

// D6 clear_verified eligibility (F-3-1, design audit r1 finding 2): strict
// slot/completion read, then every equality the bullet names — PR head ==
// dispatch head == completion's own bound reviewed sha (already asserted at
// receipt-write time) == the CURRENTLY LIVE sticky's `last_reviewed_sha`; the
// live sticky body's sha256 == the receipt's bound digest; the live sticky's
// comment identity == the receipt's bound comment identity; verdict in
// PASS|WARN; footer Tool/Model against the dispatch record. Any failure
// returns a `retain` reason+action pair — this function itself never clears.
function evaluateExternalVerifiedClosure(marker, snapshot) {
  const rootDir = controlEvidenceRoot(process.env);
  let evidence;
  try {
    evidence = readDispatchEvidenceStrict({ rootDir, dispatchId: marker.expected_dispatch_id });
  } catch (err) {
    if (err?.classification === "external_closure_incomplete") {
      return { eligible: false, ...classifyExternalClosureIncomplete(rootDir, marker.expected_dispatch_id) };
    }
    return { eligible: false, reasonCode: err?.classification || "external_evidence_unreadable", actionGroup: "d" };
  }
  const dispatch = evidence.dispatch;
  if (!dispatch) {
    return { eligible: false, reasonCode: "external_closure_pending", actionGroup: "a" };
  }
  try {
    assertDispatchMatchesMarkerBinding(dispatch, marker, snapshot);
  } catch {
    return { eligible: false, reasonCode: "external_dispatch_identity_mismatch", actionGroup: "d" };
  }
  const slot = evidence.externalClosure;
  if (!slot || slot.kind !== "accepted" || !evidence.completion) {
    if (slot && slot.kind === "voided") {
      return { eligible: false, reasonCode: "external_dispatch_voided", actionGroup: "c" };
    }
    return { eligible: false, reasonCode: "external_closure_pending", actionGroup: "a" };
  }
  const completion = evidence.completion;
  if (!READY_VERDICTS.has(completion.sticky_verdict)) {
    return { eligible: false, reasonCode: "external_verdict_not_ready", actionGroup: "b" };
  }
  const snapshotHead = String(snapshot?.headRefOid || "").trim();
  if (!VALID_SHA_RE.test(snapshotHead) || snapshotHead !== dispatch.head_ref_oid) {
    return { eligible: false, reasonCode: "external_head_drifted", actionGroup: "b" };
  }
  const stickyBody = typeof snapshot?.stickyBody === "string" ? snapshot.stickyBody : "";
  if (!stickyBody) {
    return { eligible: false, reasonCode: "external_sticky_missing", actionGroup: "b" };
  }
  const parsedSticky = parseSecondReviewStickyAuthorityBody(stickyBody);
  if (parsedSticky.status !== "valid") {
    return { eligible: false, reasonCode: "external_sticky_unparseable", actionGroup: "b" };
  }
  if (parsedSticky.last_reviewed_sha !== snapshotHead) {
    return { eligible: false, reasonCode: "external_head_drifted", actionGroup: "b" };
  }
  const bodySha = sha256Hex(stickyBody);
  if (bodySha !== completion.sticky_body_sha256) {
    return { eligible: false, reasonCode: "external_sticky_digest_mismatch", actionGroup: "b" };
  }
  if (!Number.isSafeInteger(snapshot?.stickyCommentId)
    || snapshot.stickyCommentId <= 0
    || completion.sticky_comment_id !== snapshot.stickyCommentId
    || !snapshot.stickyCommentUrl
    || completion.sticky_comment_url !== snapshot.stickyCommentUrl) {
    return { eligible: false, reasonCode: "external_sticky_comment_identity_mismatch", actionGroup: "b" };
  }
  if (parsedSticky.dispatch_id !== dispatch.dispatch_id) {
    return { eligible: false, reasonCode: "external_sticky_dispatch_mismatch", actionGroup: "b" };
  }
  if (parsedSticky.reviewer_tool !== dispatch.reviewer_tool) {
    return { eligible: false, reasonCode: "external_sticky_tool_mismatch", actionGroup: "b" };
  }
  const familyPattern = MODEL_FAMILY_PATTERNS[dispatch.reviewer_family];
  if (!familyPattern || !familyPattern.test(String(parsedSticky.reviewer_model || ""))) {
    return { eligible: false, reasonCode: "external_sticky_model_mismatch", actionGroup: "b" };
  }
  return { eligible: true };
}

// D6 F-4-2/F-3-1: the single disposition entry point. MUST NOT throw — every
// read in this cluster is fail-closed to `retain` so an evidence-layer
// exception here can never fall through to `main().catch` (which would exit 0
// and silently pass the gate).
function resolveExternalMarkerDisposition(marker, snapshot, clearArgs, cwd, exemptionCwd) {
  try {
    if (snapshot && snapshot.state === "MERGED") {
      return finalizeExternalDispositionClear(marker, snapshot, clearArgs, cwd, "clear_policy");
    }
    // Same `filesAvailable` guard as the runner loop's own exemption check
    // (line ~1699 below): an empty `files: []` on a light-only snapshot must
    // not be misread as chore-A diff-shape exemption.
    if (snapshot?.filesAvailable && isStopCrossModelExempt(snapshot.headRefName, snapshot.files, exemptionCwd, snapshot.fileStatuses, snapshot.headRefOid, snapshot.baseRefName)) {
      return finalizeExternalDispositionClear(marker, snapshot, clearArgs, cwd, "clear_policy");
    }
    if (!markerHasDispatchBinding(marker)) {
      return retainExternalDisposition("external_dispatch_unbound", "d");
    }
    if (!snapshot) {
      return retainExternalDisposition("external_pr_snapshot_unavailable", "d");
    }
    const verified = evaluateExternalVerifiedClosure(marker, snapshot);
    if (!verified.eligible) {
      return retainExternalDisposition(verified.reasonCode, verified.actionGroup);
    }
    return finalizeExternalDispositionClear(marker, snapshot, clearArgs, cwd, "clear_verified");
  } catch (err) {
    return retainExternalDisposition(err?.classification || "external_evidence_unreadable", "d");
  }
}

// D6 Blocked-message bullet (design audit r2 F-dg-r2-01): next action MUST
// depend on the retain reason group, and MUST NOT point at accept-external-
// second-review.mjs for a state accept cannot fix (b/c/d). `<packet-dir>` is
// a placeholder token, never a local filesystem path (ai-autonomy.md §Never).
function externalRetainNextAction(actionGroup, marker) {
  const dispatchId = marker?.expected_dispatch_id || "(unknown dispatch)";
  switch (actionGroup) {
    case "a":
      return `待驗收／待補完：\`node .devpro/scripts/accept-external-second-review.mjs <packet-dir for dispatch ${dispatchId}>\``;
    case "b":
      return "已驗收但與當前 sticky 不符（digest 漂移／head 不一致／verdict 非 PASS｜WARN）：重新發行審查單（predecessor 已關閉，lineage 可接續；重跑 accept 只會 already_accepted，不會解除此狀態）。";
    case "c":
      return "審查單已作廢（voided）：重新發行審查單。";
    default:
      return "證據不可讀或屬 strict reader 以外的中斷態：回報 TL 處理，不得執行 accept。";
  }
}

function buildExternalRetainSection(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const lines = entries.map(({ marker, reasonCode, actionGroup }) => {
    const id = marker.prNumber ? `PR #${marker.prNumber}` : "PR (number unknown)";
    const branchLabel = marker.branch ? ` on \`${marker.branch}\`` : "";
    return `- ${id}${branchLabel}（reason: \`${reasonCode}\`）：${externalRetainNextAction(actionGroup, marker)}`;
  });
  return [
    "### External evaluator second-review — still pending",
    "",
    "下列 marker 為 external evaluator 審查單路徑（非 runner spawn）；unblock 條件與 runner cross-review 不同——只認 TL 執行 accept helper 產生的第四形 completion receipt，不接受手寫 sticky 或未經驗收的內容（`post-pr-completion-gate.md`）：",
    "",
    // F-aeesr-r3-05: carried here, not in the all-external boilerplate, so a
    // mixed runner+external turn -- whose runner text keeps its stale-expire and
    // final-defense claims byte-identical -- still tells the truth about these.
    "這些 external marker 不會 stale-expire；merge gate 不驗證 TL 驗收收據，只讀 live sticky（external evaluator session 自寫），accept 前可能已放行（具名殘餘風險）——TL 必須先完成 accept 才可 merge。",
    "",
    ...lines,
  ].join("\n");
}

function buildStopTimeBudgetSection(unprocessed, processedCount) {
  if (!Array.isArray(unprocessed) || unprocessed.length === 0) return "";
  const lines = [...new Set(unprocessed.map((m) => {
    const id = m.prNumber ? `PR #${m.prNumber}` : "PR (number unknown)";
    const branch = m.branch ? ` on \`${m.branch}\`` : "";
    return `- ${id}${branch}`;
  }))];
  return [
    "### Post-PR completion check time budget exhausted",
    "",
    `這一輪檢查用完 ${formatDuration(resolveStopRunDeadlineMs())} 的時間預算（${launcherNote()}，所以本 hook 先自己擋下）：已處理 ${processedCount} 個 PR，下列 ${lines.length} 個沒有檢查到——marker 原樣保留，沒有清除也沒有判定：`,
    ...lines,
    "",
    "Agent-facing next step（本段落內容 MUST 原樣轉達給使用者；AI 不得代為選擇選項 2）：",
    "1. 是，停下，交由使用者決定下一步（清掉已結束的 marker、逐一處理清單上的 PR、或調整範圍）",
    "2. 否，使用者已確認可承擔未檢查的風險，明確授權繼續",
    "3. 其他",
  ].join("\n");
}

// ── Next step for the generic (non-external) pending marker ──
// The next step is one fixed text: it never reads a ledger, a lite scope record or any other approval evidence.
const UNBLOCK_CONDITION_LINE =
  "- Unblock condition: dispatch 未被 operator-disposed，且 exactly one canonical sticky 的 `verdict: PASS`、`last_reviewed_sha == headRefOid`、`dispatch_id == expected_dispatch_id` exact match 即可；`WARN` 則仍須 current dispatch immutable completion receipt、`process_close_observed: true`、無 current fault，且 predecessor completion / gate-consumed fault / terminal receipt lineage 完整可驗證，才可清除 marker。或 exact-one current-head Path W waiver（`<!-- devpro-cross-model-waiver -->` + `waived_head_sha == headRefOid`）。";
const BUILDER_REFUSAL_ROUTING_LINE =
  "- Builder 拒絕分流：`lite_proposal_present` 由 AI 修正後重跑 builder（修 builder 參數），不問使用者；`pr_repository_mismatch`（cross-repo PR）停下問使用者，不派第二審，最後回覆依 `stop-point-comms.md` 呈現層（編號選項、末項開放）；其餘 builder 拒絕同樣由 AI 修正後重跑；`review_material_unavailable`（PR raw diff 超過嵌入上限）改以 `--external-evaluator <tool>` 重跑，走 External Evaluator（`second-review-external-evaluator.md`）；訊息寫明 PR 沒有內容差異（三點 changed-file list 為空）時不要改跑 `--external-evaluator`：零差異 ancestry repair 已豁免（`code-review-cross-model.md` §Zero-diff ancestry repair exemption；閘以本機 git objects 驗證，仍要求第二審時先跑 `git fetch origin pull/<PR#>/head --tags` 再試），其他零差異 PR 交使用者決定 Path W。";
const RUNNER_NEXT_STEP_LINES = [
  "- Owner: TL/reviewer。",
  "- Next action: 直接跑 `/devpro:cross-review <PR#>`（或 `/devpro:pre-pr` Step 5.5 host-equivalent adapter dispatch）。執行前先核對上方每筆的 repo 與 PR 號，處理列出的 Evidence blocked，再到該 repo 執行。",
  UNBLOCK_CONDITION_LINE,
  BUILDER_REFUSAL_ROUTING_LINE,
];

async function main() {
  // Reviewer stdout is its transport, not a TL reminder surface.
  if (isCrossModelReviewerProcess()) process.exit(0);

  const now = Date.now();
  const cwd = process.cwd();
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  reminderSession = resolveReminderSession(payload);
  if (!reminderSession) {
    process.stderr.write("post-pr-completion-check: session identity unavailable; reminders not evaluated.\n");
    process.exit(0);
  }
  // Stop is a session consumer, never a global cleanup owner. Inventory is
  // read-only so stale foreign authorities and evidence remain untouched.
  const all = listOwnedPostPrStopMarkers(cwd, reminderSession, { crossRepositoryOnly: CROSS_REPOSITORY_ONLY })
    .filter((marker) => now - marker.mtimeMs >= REMIND_AFTER_MS);
  if (all.length === 0) process.exit(0);
  const emitReminder = (details, summary) => compactReminder({
    cwd, session: reminderSession, kind: "post-pr-completion", summary,
    action: "Read Details, then perform the scoped gate next action; report blocked while pending.", details,
  });

  // Self-heal: for each marker, check exemption first, then fresh sticky.
  // Exempt PRs never need cross-model review → clear marker, pass.
  // Fresh parseable sticky already present → cross-review already done → clear marker, pass.
  const stillPending = [];
  const markerRepositories = new Map();
  // R4/D11/D12 (task 7): per-marker cost-budget + override-disclosure
  // evaluation, collected independently of stillPending/self-heal. Branch-
  // pattern-exempt markers (handled above, `continue`d before reaching this
  // point) are scoped OUT — that exemption pre-dates this change and covers
  // the whole marker, not just cross-review; task 7's acceptance is framed
  // around "該 PR 的 branch 名稱", which presumes a resolvable PR snapshot.
  const costBudgetBlocked = [];
  const costBudgetAdvisory = [];
  const costBudgetUnavailable = [];
  const disclosureBlocked = [];
  const runBudget = createMonotonicRunBudget(resolveStopRunDeadlineMs());
  // One worktree-member enumeration per hook run, shared by every marker's stall query (R5). It holds the member
  // list only; each marker still resolves its binding and reads its receipt chain fresh.
  const enumerationMemo = createWorktreeEnumerationMemo();
  let checkoutIdentity;
  // Markers the cooperative deadline left untouched (not cleared, not judged, not marked reminded).
  const unprocessed = [];
  for (const marker of all) {
    if (runBudget.remainingMs() < STOP_MARKER_MIN_REMAINING_MS) {
      unprocessed.push(marker);
      continue;
    }
    const markerRepo = postPrMarkerRepoName(marker, { requireSupported: true });
    checkoutIdentity ??= storedOriginIdentity(cwd) || {};
    const checkoutRepo = repoKey(checkoutIdentity.host, checkoutIdentity.slug);
    const targetRepo = markerRepo.name || checkoutRepo;
    let markerProblem = "";
    if (marker.marker_unreadable) markerProblem = "cannot be read or verified";
    else if (markerRepo.conflict) markerProblem = "names conflicting repositories";
    else if (markerRepo.unsupported) markerProblem = "names an unsupported GitHub repository";
    else if (marker.prNumber && !isPrNumber(marker.prNumber)) markerProblem = "has an invalid PR number";
    else if (!targetRepo && (checkoutIdentity.host || process.env.GH_HOST || process.env.GH_REPO || inheritedGitLocation())) {
      markerProblem = "has no verified GitHub.com repository";
    }
    if (markerProblem) {
      stillPending.push({
        ...marker, url: "",
        dispatchEvidenceDiagnostic: `${path.basename(marker.file)} ${markerProblem}. Verify its repository and PR selector before rerunning Stop.`,
      });
      continue;
    }
    markerRepositories.set(marker.file, targetRepo);
    // Only use local checkout evidence when it belongs to the marker's repository.
    const markerCheckout = targetRepo && marker.worktree !== cwd ? postPrMarkerCheckout(marker) : "";
    const exemptionCwd = !CROSS_REPOSITORY_ONLY && !inheritedGitLocation() && (!targetRepo || targetRepo === checkoutRepo)
      ? cwd
      : markerCheckout;
    if (isMarkerBranchPatternExempt(marker, exemptionCwd)) {
      if (markerHasDispatchBinding(marker)) {
        try {
          if (!clearDispatchBoundMarker(marker, null, cwd)) stillPending.push(marker);
        } catch {
          stillPending.push(marker);
        }
      } else {
        const cleared = clearUnboundMarker(marker, { cwd,
          repositorySlug: targetRepo, prNumber: marker.prNumber, branch: marker.branch,
          expectedAuthorityId: marker.authorityId, expectedAuthorityCreatedAt: marker.createdAt });
        if (!cleared) stillPending.push(marker);
      }
      continue;
    }
    if (CROSS_REPOSITORY_ONLY && !marker.prNumber) {
      stillPending.push({ ...marker, dispatchEvidenceDiagnostic: `${targetRepo}: recover the PR number before rerunning Stop.` });
      continue;
    }
    const snapshot = marker.prNumber
      ? fetchPrSnapshot(marker.prNumber, {
          timeoutMs: probeTimeoutMs(runBudget),
          repository: targetRepo,
        })
      : fetchPrSnapshotByBranch(marker.branch, { runBudget, repository: targetRepo });
    if (!snapshot && targetRepo) {
      marker.dispatchEvidenceDiagnostic = "Could not verify the PR in the recorded repository. Check access and confirm its PR number or branch before retrying.";
    }
    const clearArgs = {
      cwd,
      repositorySlug: targetRepo,
      prNumber: marker.prNumber || snapshot?.number || "",
      branch: marker.branch,
      expectedAuthorityId: marker.authorityId,
      expectedAuthorityCreatedAt: marker.createdAt,
    };
    // Evaluated here — BEFORE any self-heal branch below — because clearing
    // a marker deletes its file, the only evidence this Stop-hook has that a
    // post-PR round just happened. A round that is about to self-heal/clear
    // (e.g. a fresh PASS sticky) is exactly a round that "just concluded"
    // and still needs this check; deferring to a pass over `stillPending`
    // after self-heal would silently skip every round that resolved cleanly.
    const evalBranch = snapshot?.headRefName || marker.branch || "";
    const costEntry = {marker, snapshot, branch: evalBranch, repository: targetRepo};
    const foreignCost = Boolean(targetRepo && targetRepo !== checkoutRepo);
    let costCwd = CROSS_REPOSITORY_ONLY ? "" : markerCheckout || exemptionCwd;
    let checkpointStateDir;
    if (costCwd && foreignCost) {
      try {
        // A process-wide checkpoint-dir override belongs to the hub. The
        // foreign checkpoint and its session transitions come from its repo.
        checkpointStateDir = changeUsageStateDir(costCwd, {});
      } catch {
        costCwd = "";
      }
    }
    if (!CROSS_REPOSITORY_ONLY && !costCwd && targetRepo) costBudgetUnavailable.push(costEntry);
    const costEval = costCwd ? evaluatePostPrCostBudget({
      branch: evalBranch,
      cwd: costCwd,
      resolveUsage: ({ changeName, cwd: rcwd, env }) =>
        cachedResolveChangeCostUsage({
          changeName, cwd: rcwd, env, now, repository: targetRepo, stateCwd: cwd, checkpointStateDir,
        }),
      enumerationMemo,
    }) : null;
    const blockingExceeded = blockingCostThresholds(costEval?.result);
    // The keys this marker reports, and — if it blocks — the exact set an
    // override has to declare. `exceeded_thresholds` plus anything blocking in
    // a state that is not `exceeded`; see `reportedCostThresholds` for why the
    // union is the only shape that keeps BOTH an already-declared
    // `output,stalled_rounds` matching and an `unavailable` stall clearable.
    const reportedThresholds = reportedCostThresholds(costEval?.result);
    if (blockingExceeded.length === 0) {
      if (reportedThresholds.length > 0) {
        costBudgetAdvisory.push({ ...costEntry, reportedThresholds, ...costEval });
      }
    } else {
      // The override is still resolved against the FULL reported set below,
      // not `blockingExceeded`. The match is exact-set (D11), so narrowing the
      // input would turn an already-declared `output,stalled_rounds` override
      // into a mismatch and block a user who was previously let through.
      // Demoting a threshold takes away its gate, not the meaning of an
      // existing declaration. Same reasoning, same shape, as the renderer's
      // half used to be before D2 removed it.
      //
      // D11/task 8: exact-set-match + write-gated override consumption — an
      // ineffective override (missing/malformed/mismatched/unknown-key/
      // non-exact-set/write-failed) falls straight through to the pre-existing
      // block below, adding no new failure mode. Since D12 this is also the
      // ONLY surface (besides `--budget-check`) that still resolves
      // `DEVPRO_COST_BUDGET_OVERRIDE` at all (D2 removed the renderer's read
      // of it), so the diagnostic below is this env var's sole remaining
      // "did my declaration do anything" answer.
      const evalHeadRefOid = snapshot?.headRefOid || marker?.head_ref_oid || "";
      const overrideSession = captureTlHostSession(process.env);
      const override = foreignCost ? {
        effective: false,
        reason: "repository_mismatch",
        hint: `Rerun this session's Stop check from the verified checkout for ${targetRepo}. Set DEVPRO_POST_PR_COMPLETION_STATE_DIR to the original marker directory and use the target checkout's own checkpoints. If the PR marker already retired, report the cost result and ask the user to decide.`,
      } : resolveCostBudgetOverride({
        envValue: process.env.DEVPRO_COST_BUDGET_OVERRIDE,
        changeName: costEval.changeName,
        exceededThresholds: reportedThresholds,
        cwd: costCwd,
        sessionId: overrideSession?.session_id,
        headRefOid: evalHeadRefOid,
      });
      // D12: presence is key-existence (blank values included, per D3's own
      // "the key exists, including an empty or whitespace-only value") — an
      // absent key contributes nothing (there was no declaration to honor),
      // exactly the gate the renderer used to apply before D2 removed it.
      const overridePresent = Object.hasOwn(process.env, "DEVPRO_COST_BUDGET_OVERRIDE");
      if (!override.effective) {
        costBudgetBlocked.push({
          ...costEntry,
          reportedThresholds,
          override: overridePresent ? override : null,
          ...costEval,
        });
      } else if (reportedThresholds.length > 0) {
        // Cleared by a named override, so nothing blocks -- but what was
        // measured is still reported (D14). Keyed on the reported set, not the
        // exceeded one: an overridden `unavailable` stall exceeds nothing, and
        // dropping it here would let the one state the user just had to name
        // explicitly go unmentioned on the turn they cleared it.
        costBudgetAdvisory.push({ ...costEntry, reportedThresholds, ...costEval });
      }
    }
    const disclosureEval = costCwd ? evaluateOverrideDisclosure({
      branch: evalBranch, prBody: snapshot?.prBody, cwd: costCwd, checkpointStateDir,
    }) : null;
    if (disclosureEval?.status === "block") {
      disclosureBlocked.push({ ...costEntry, ...disclosureEval });
    }
    // A verified CLOSED PR cancels its own review obligation; it is not a
    // successful merge. Cost/disclosure is already recorded above; ownership
    // was established before any gh probe.
    if (snapshot?.state === "CLOSED") {
      const canceled = clearPostPrCompletionMarker({
        ...clearArgs, markerFile: marker.file, prNumber: marker.prNumber || "",
        repositorySlug: marker.repository_slug, headRefOid: marker.head_ref_oid,
        expectedDispatchId: marker.expected_dispatch_id,
        expectedAuthorityId: marker.authorityId,
      });
      if (canceled) {
        process.stderr.write(`post-pr-completion-check: PR #${clearArgs.prNumber} CLOSED; review obligation canceled, not merge completion.\n`);
        clearStopReviewRound(cwd, clearArgs, snapshot);
      } else stillPending.push(marker);
      continue;
    }
    // D6 F-4-2: single external-marker branch point. Fixed here — AFTER cost
    // budget and override disclosure have already been evaluated/recorded
    // above (so a cost/disclosure blocker on an external marker is still
    // reported), BEFORE every runner self-heal shortcut below (MERGED,
    // cross-model exempt, current-head-PASS shortcut, unbound+fresh-sticky
    // clear, dispatch-bound verifier). `continue` makes every one of those
    // shortcuts unreachable for an external marker — see the callsite
    // registry test for the exhaustive per-shortcut proof.
    if (isExternalMarker(marker)) {
      const disposition = resolveExternalMarkerDisposition(marker, snapshot, clearArgs, cwd, exemptionCwd);
      if (!disposition.cleared) {
        stillPending.push({
          ...marker,
          prNumber: marker.prNumber || snapshot?.number || "",
          url: marker.url || snapshot?.url || "",
          __externalDisposition: { reasonCode: disposition.reasonCode, actionGroup: disposition.actionGroup },
        });
      }
      continue;
    }
    if (snapshot?.hasFreshSticky && ["PASS", "WARN"].includes(snapshot.stickyVerdict)) {
      try {
        assertDispatchReviewAuthority({ rootDir: controlEvidenceRoot(process.env, cwd),
          dispatchId: snapshot.stickyDispatchId, repositorySlug: marker.repository_slug,
          prNumber: marker.prNumber || snapshot.number, headRefOid: snapshot.reviewedHeadRefOid });
      } catch (error) {
        // Do not call a diagnostic builder that resolves the same unavailable
        // root again: authority uncertainty must retain this marker, not throw
        // into the hook's outer advisory fallback.
        marker.dispatchEvidenceDiagnostic = `Review authority blocked: ${error.message}`;
        stillPending.push(marker);
        continue;
      }
    }
    if (snapshot) {
      // A legacy unbound marker may self-heal after merge because the merge gate
      // already verified its sticky. A dispatch-bound marker additionally owns
      // an immutable fault lineage: merge state does not waive consumption and
      // supersession receipts, so verify the complete current sticky/dispatch
      // chain before marker clearance. A Path W waiver is the user's exit from
      // that chain, on a merged PR as on an open one.
      if (snapshot.state === "MERGED") {
        if (markerHasDispatchBinding(marker)) {
          try {
            const settled = clearMergedNeverStartedDispatchMarker(marker, snapshot, cwd)
              ?? clearMarkerOnFreshWaiver(marker, snapshot, clearArgs, cwd);
            if (settled === true) {
              clearStopReviewRound(cwd, clearArgs, snapshot);
            } else if (settled === false) {
              stillPending.push(marker);
            } else if (!(await verifyDispatchEvidenceAndAppendReceipts(marker, snapshot))) {
              stillPending.push(marker);
            } else {
              // TC3/R2: merged self-heal also retires the PR's review-round sidecar.
              clearStopReviewRound(cwd, clearArgs, snapshot);
            }
          } catch {
            stillPending.push(marker);
          }
        } else {
          if (clearUnboundMarker(marker, clearArgs)) clearStopReviewRound(cwd, clearArgs, snapshot);
          else stillPending.push(marker);
        }
        continue;
      }
      // Check exemption via the SAME helper used by merge gate Path A
      if (snapshot.filesAvailable) {
        const exempt = isStopCrossModelExempt(snapshot.headRefName, snapshot.files, exemptionCwd, snapshot.fileStatuses, snapshot.headRefOid, snapshot.baseRefName);
        // A cross-model exemption skips the ordinary review requirement, but
        // it cannot discharge the review created by an approved lineage clear.
        if (exempt && !marker.lineage_clear_obligation) {
          if (markerHasDispatchBinding(marker)) {
            try {
              if (!clearDispatchBoundMarker(marker, snapshot, cwd)) stillPending.push(marker);
            } catch {
              stillPending.push(marker);
            }
          } else {
            if (!clearUnboundMarker(marker, clearArgs)) stillPending.push(marker);
          }
          continue;
        }
      }
      // An exact current-head PASS is authoritative before local orchestration
      // evidence. Attempt its marker CAS before reading a fault or completion
      // receipt; a failed CAS preserves the marker and does not consume local
      // diagnostics for the superseded binding.
      if (markerHasDispatchBinding(marker) && isAuthoritativeCurrentHeadPass(marker, snapshot)) {
        try {
          if (clearDispatchBoundMarker(marker, snapshot, cwd)) continue;
        } catch {
          // Marker CAS is fail closed; preserve the marker.
        }
        stillPending.push({
          ...marker,
          prNumber: marker.prNumber || snapshot.number || "",
          url: marker.url || snapshot.url || "",
        });
        continue;
      }
      try {
        const waived = clearMarkerOnFreshWaiver(marker, snapshot, clearArgs, cwd);
        if (waived === false) stillPending.push(marker);
        if (waived !== null) continue;
      } catch {
        stillPending.push({
          ...marker,
          prNumber: marker.prNumber || snapshot.number || "",
          url: marker.url || snapshot.url || "",
        });
        continue;
      }
      // A dispatch-bound orchestration fault remains authoritative for WARN or
      // when no authoritative fresh PASS exists:
      // consume it even when no fresh sticky exists, then retain the marker.
      // Re-checking inside the fresh-sticky path below closes the race where a
      // fault capsule is published between this read and successor validation.
      if (markerHasDispatchBinding(marker)) {
        try {
          if (await consumeCurrentDispatchFault(marker, snapshot)) {
            stillPending.push({
              ...marker,
              prNumber: marker.prNumber || snapshot.number || "",
              url: marker.url || snapshot.url || "",
            });
            continue;
          }
        } catch (error) {
          marker.dispatchEvidenceDiagnostic = dispatchEvidenceBlockedDiagnostic(marker, error);
          // Dispatch-bound evidence is fail closed; preserve the marker.
          stillPending.push({
            ...marker,
            prNumber: marker.prNumber || snapshot.number || "",
            url: marker.url || snapshot.url || "",
          });
          continue;
        }
      }
      if (snapshot.hasFreshSticky) {
        if (markerHasDispatchBinding(marker)) {
          try {
            if (await verifyDispatchEvidenceAndAppendReceipts(marker, snapshot)) continue;
          } catch {
            // Dispatch-bound evidence is fail closed; preserve the marker.
          }
          stillPending.push({
            ...marker,
            prNumber: marker.prNumber || snapshot.number || "",
            url: marker.url || snapshot.url || "",
          });
        } else {
          if (!clearUnboundMarker(marker, clearArgs)) stillPending.push(marker);
        }
        continue;
      }
    }
    stillPending.push({
      ...marker,
      prNumber: marker.prNumber || snapshot?.number || "",
      url: marker.url || snapshot?.url || "",
    });
  }

  // R4/D11/D12 (task 7): cost circuit breaker hits are computed independently
  // of stillPending/self-heal (see the loop above) and are never cleared by
  // the "nothing pending" early exit below — a real budget overage or an
  // undisclosed override does not resolve with time, only with a user
  // decision (or a matching named override) that actually changes the
  // checkpoint/PR body. What CAN soften with time is only the Stop-hook's
  // per-turn response shape (F-0fe5da39 fix, below): after one hard block,
  // repeated Stop invocations downgrade to a soft reminder — mirroring the
  // pending-marker downgrade — so the agent is never trapped in a forced-
  // continuation loop it cannot exit (DEVPRO_COST_BUDGET_OVERRIDE is a host-
  // process env var the in-session agent cannot set).
  const costBudgetSection = buildCostBudgetBlockSection(costBudgetBlocked);
  const costUnavailableSection = costBudgetUnavailable.length > 0 ? [
    "### Cost circuit breaker unavailable",
    "用量無法判定：找不到該 PR 可驗證的 checkout。請從目標 repo 的 checkout 重查。",
    ...costBudgetUnavailable.map((entry) => `- ${costBudgetSubject(entry)}`),
  ].join("\n") : null;
  const costAdvisorySection = [buildCostBudgetAdvisorySection(costBudgetAdvisory), costUnavailableSection]
    .filter(Boolean).join("\n\n");
  const disclosureSection = buildOverrideDisclosureBlockSection(disclosureBlocked);
  // The advisory is deliberately NOT part of this: it reports, it does not
  // block, and folding it in here would restore the stop through the back door.
  // The time-budget section counts too (R7): a turn whose markers were all cleared or left unprocessed has no pending marker, and
  // must not take the silent no-pending exit 0 below when the deadline cut the run short.
  const timeBudgetSection = buildStopTimeBudgetSection(unprocessed, all.length - unprocessed.length);
  const costCircuitBreakerHit = Boolean(costBudgetSection || disclosureSection || timeBudgetSection);

  if (stillPending.length === 0 && !costCircuitBreakerHit) {
    if (costAdvisorySection) process.stdout.write(JSON.stringify({
      systemMessage: emitReminder(costAdvisorySection, "Post-PR cost advisory requires attention."),
    }));
    process.exit(0);
  }

  // F-0fe5da39 fix: distinct repository/change keys that hit the cost/disclosure
  // breaker this turn (deduped) — the downgrade decision and its reminder-
  // state writes below both use these keys, independent of any
  // marker file. `.every()` on an empty array is vacuously true, so a run
  // with no breaker hits at all falls through to exactly the pending-marker-
  // only decision this condition used to be.
  const costBreakerStateKeys = [
    ...new Set([...costBudgetBlocked, ...disclosureBlocked].map(({changeName, repository}) => costStateKey(changeName, repository))),
    // Reserved key (not a valid change name: CHANGE_NAME_GRAMMAR rejects a leading underscore) so the time budget joins the jointly
    // gated downgrade: the turn hard-blocks until this key has been reminded.
    ...(timeBudgetSection ? [STOP_TIME_BUDGET_REMINDER_KEY] : []),
  ];
  const canDowngrade =
    stillPending.every((m) => wasRecentlyHardBlocked(m, now)) &&
    costBreakerStateKeys.every((key) => wasCostCircuitBreakerRecentlyReminded(key, cwd, now));

  // Hard-block once per pending marker / cost-breaker change_name per
  // session window, then downgrade repeated Stop invocations to a soft
  // reminder so the agent can report "blocked" instead of being trapped in
  // a Stop hook loop. Merge remains fail-closed via checkCrossModelMergeGate
  // and no state (marker, checkpoint, PR body) is cleared by this downgrade
  // — only this turn's Stop-hook response shape changes.
  const lines = [...new Set(stillPending.map((m) => {
    const id = m.prNumber ? `PR #${m.prNumber}` : "PR (number unknown)";
    const branch = m.branch ? ` on \`${m.branch}\`` : "";
    const repository = markerRepositories.get(m.file);
    const url = m.url || repository;
    return `- ${id}${branch}${url ? ` — ${url}` : ""}${m.worktree ? ` — worktree: ${m.worktree}` : ""}`
      + (m.dispatchEvidenceDiagnostic ? `\n  Evidence blocked: ${m.dispatchEvidenceDiagnostic}` : "");
  }))];

  // D6 Blocked-message bullet: the generic runner boilerplate below names a
  // `/devpro:cross-review` dispatch and a hand-written-sticky unblock condition
  // that are both wrong for an external-evaluator marker (D14 trust-anchor:
  // pointing an agent at "write a fresh PASS sticky" here would let it forge
  // gate evidence). Only swapped out when EVERY pending marker this turn is
  // external — a mixed runner+external turn keeps the exact prior text
  // byte-identical, and the per-marker `externalRetainSection` below already
  // carries the correct per-marker next action regardless.
  const externalStillPending = stillPending.filter((m) => m.__externalDisposition);
  const allPendingAreExternal = stillPending.length > 0
    && externalStillPending.length === stillPending.length;
  const externalRetainSection = buildExternalRetainSection(
    externalStillPending.map((m) => ({ marker: m, ...m.__externalDisposition }))
  );

  // Cost/disclosure breaker hit but cross-review itself is fully cleared (no
  // stillPending): the `stillPending.length > 0` branches below already gate
  // whether this boilerplate is spread in at all, so nextStepLines can stay
  // an unconditional array here — the no-pending branches simply never read
  // it, falling back to the breaker sections alone.
  const nextStepLines = [
    "Agent-facing next step (not a user prompt):",
    "- Status: blocked；不得宣告 ready / complete / mergeable。",
    ...(allPendingAreExternal
      ? [
          "- Owner: TL（external evaluator 審查單驗收人）。",
          "- Next action: 見下方 external evaluator 審查單 pending 清單各列的 next action。",
          "- Unblock condition: 只認 TL 執行 accept helper 產生的第四形 completion receipt（`external_evaluator_sticky_accepted`），且 exact-bound 當前 sticky body、verdict∈PASS｜WARN；不接受手寫 sticky 或未經驗收的內容。",
        ]
      : RUNNER_NEXT_STEP_LINES),
  ];

  if (canDowngrade) {
    const msg = stillPending.length > 0
      ? [
          "### Post-PR completion gate still pending",
          "",
          "偵測 `gh pr create` 成功後尚未完成 cross-model second-opinion review。",
          "",
          "Pending PRs:",
          ...lines,
          "",
          "此 pending marker 已在 30 分鐘內 hard-block 過；本次改為 soft reminder，避免 Stop hook loop。",
          ...nextStepLines,
          ...(externalRetainSection ? ["", externalRetainSection] : []),
          ...(costBudgetSection ? ["", costBudgetSection] : []),
          ...(timeBudgetSection ? ["", timeBudgetSection] : []),
          ...(disclosureSection ? ["", disclosureSection] : []),
          ...(costAdvisorySection ? ["", costAdvisorySection] : []),
        ].join("\n")
      : [
          // A time-budget-only turn has nothing an override can lift (DEVPRO_COST_BUDGET_OVERRIDE does not touch the time budget).
          costBudgetSection || disclosureSection
            ? "此成本斷路器狀態已在 30 分鐘內 hard-block 過；本次改為 soft reminder，避免 Stop hook loop。此 soft reminder 不代表狀態已解除——override 或使用者決定前仍持續生效，merge gate 不受影響。"
            : "此時間預算狀態已在 30 分鐘內 hard-block 過；本次改為 soft reminder，避免 Stop hook loop。此 soft reminder 不代表狀態已解除，merge gate 不受影響。",
          costBudgetSection,
          disclosureSection,
          timeBudgetSection,
          costAdvisorySection,
        ].filter(Boolean).join("\n\n");
    process.stdout.write(JSON.stringify({ systemMessage: emitReminder(msg, "Post-PR completion remains blocked; this is a repeat reminder.") }));
    process.exit(0);
  }

  for (const marker of stillPending) {
    if (!wasRecentlyHardBlocked(marker, now) && marker.file) {
      try { markPostPrCompletionReminded(marker.file, reminderSession); } catch {}
    }
  }
  for (const key of costBreakerStateKeys) {
    if (!wasCostCircuitBreakerRecentlyReminded(key, cwd, now)) {
      markCostCircuitBreakerReminded(key, cwd, now);
    }
  }

  const reason = stillPending.length > 0
    ? [
        "### Post-PR completion gate hard-block",
        "",
        "偵測 `gh pr create` 成功後尚未完成 cross-model second-opinion review。",
        "",
        "Pending PRs:",
        ...lines,
        "",
        ...nextStepLines,
        "",
        // D6/D14: the runner `/devpro:cross-review` clearing path is wrong to name
        // as THE clearing path when every pending marker this turn is
        // external — it is exactly the "write a fresh sticky yourself"
        // shortcut D14 exists to keep an agent from reaching for. Mirrors the
        // nextStepLines gate above; unconditional (byte-identical) otherwise.
        // F-aeesr-r2-04 (primary review r2): an external marker always carries
        // expected_dispatch_id, and listPostPrCompletionMarkers only
        // stale-expires markers WITHOUT it — so unlike the runner branch
        // below, this marker never self-clears on its own. checkCrossModelMergeGate
        // also never reads local receipts (decisions.md F-05 residual risk):
        // it only inspects the live sticky, which the external evaluator
        // session itself writes — so it can admit a self-written PASS/WARN
        // sticky BEFORE the TL runs accept. Neither claim from the runner
        // branch is true here; the real constraint lives in
        // buildExternalRetainSection so mixed turns carry it too (r3-05).
        allPendingAreExternal
          ? "完整 gate 清單（workflow / cross-model sticky / Requirement Ledger / Post-PR handoff / session-close）見 `.devpro/agent-rules/post-pr-completion-gate.md`。清除路徑：見下方 external evaluator 審查單清單各列的 next action（依 reason code 分流；只信任 TL 驗收產生的收據，不接受手寫 sticky）；merge gate 殘餘風險見該清單說明。"
          : "完整 gate 清單（workflow / cross-model sticky / Requirement Ledger / Post-PR handoff / session-close）見 `.devpro/agent-rules/post-pr-completion-gate.md`。清除路徑：跑 `/devpro:cross-review <PR#>`（或 `/devpro:pre-pr` Step 5.5），reviewer 寫 sticky 後 marker 自動清除；pending authority 只由 verified PR evidence 清除；merge gate `checkCrossModelMergeGate` 為最終 fail-closed 防線。",
        ...(externalRetainSection ? ["", externalRetainSection] : []),
        ...(costBudgetSection ? ["", costBudgetSection] : []),
        ...(timeBudgetSection ? ["", timeBudgetSection] : []),
        ...(disclosureSection ? ["", disclosureSection] : []),
        ...(costAdvisorySection ? ["", costAdvisorySection] : []),
      ].join("\n")
    : [costBudgetSection, disclosureSection, timeBudgetSection, costAdvisorySection].filter(Boolean).join("\n\n");

  process.stdout.write(JSON.stringify({ decision: "block", reason: emitReminder(reason, "Post-PR completion is pending; keep status blocked.") }));
  process.exit(2);
}

// Guard: only invoke main() when this file is the direct entry point (not when
// imported as a module by tests). Matches pre-tool-gate.mjs import.meta pattern.
export { snapshotFromGhData as __testSnapshotFromGhData, fetchPrSnapshot as __testFetchPrSnapshot };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`post-pr-completion-check hook error: ${err.message}\n`);
    process.exit(0);
  });
}
