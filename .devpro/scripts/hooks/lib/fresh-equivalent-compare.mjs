/**
 * fresh-equivalent-compare.mjs
 *
 * Path D′ fresh-equivalent judgement (design.md D2/D12, strengthen-cross-review-
 * loop-termination R3/R4). A single `gh api compare/<last_reviewed_sha>...<headRefOid>`
 * evaluation shared by the two callers that independently decide whether a stale
 * `last_reviewed_sha` can be treated as fresh-equivalent:
 *   - `pre-tool-gate.mjs`'s `checkCrossModelMergeGate` (Path D carve-out)
 *   - `post-pr-completion-check.mjs`'s stale-sticky decision point
 *
 * Both callers MUST call `evaluateFreshEquivalent` — this module is the single
 * authority for the whitelist and the fail-closed judgement table. Callers
 * MUST NOT re-implement the whitelist or re-interpret compare fields (N2 parity).
 *
 * Contract: side-effect-free except for the (mockable) `gh api` subprocess call.
 * No process termination, no stdout/stderr printing — callers own block/reason
 * formatting.
 *
 * Call budget: at most ONE `gh api` invocation per evaluation, zero retry,
 * 10s timeout (spawnSync `timeout` option). Any uncertainty (spawn failure,
 * non-zero exit, non-JSON stdout, timeout, unexpected compare shape, truncated
 * file list) is fail-closed: `{ fresh_equivalent: false, reason: "<typed reason>" }`.
 *
 * Test injection (mirrors the CROSS_MODEL_MERGE_GATE_MOCK_* convention at
 * pre-tool-gate.mjs:1084-1089):
 *   CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT — JSON string standing in for the
 *     `gh api compare/...` stdout body on a successful (exit 0) invocation.
 *   CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_ERROR — non-empty string → simulate any
 *     compare-unavailable failure (gh missing, spawn error, non-zero exit
 *     including 404/422/rate-limit/offline, non-JSON stdout, timeout).
 *
 * Hermetic-test guard: when the process has `CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT`
 * (pre-tool-gate.mjs's `gh pr view` mock) or any `DEVPRO_POST_PR_GATE_MOCK_*`
 * (post-pr-completion-check.mjs's PR-snapshot mock family) env var set, but
 * neither compare-specific mock above is set, this module fails closed
 * (`{ fresh_equivalent: false, reason: "compare-mock-guard" }`) WITHOUT
 * spawning `gh` — a caller-side test harness that mocks the PR-view/snapshot
 * layer but not this module's compare call did not intend a real network
 * call. Tests that want to exercise a real judgement under either mock family
 * must additionally set CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT/_ERROR.
 */

import { spawnSync } from "node:child_process";

// D12: Path D′ whitelist — exactly two prefixes, further narrowed so any
// `specs` path segment under those prefixes is NOT eligible (spec delta /
// Scenario body = behavior-scope; see #2413 F-ea5e4c895069). The whitelist is
// an explicit constant: no consumer file may widen what escapes cross-model
// review.
export const PATH_D_PRIME_WHITELIST = ["openspec/changes/", "notes/"];

const COMPARE_TIMEOUT_MS = 10_000;
// GitHub compare API caps `files` at 300 entries; at/above that we cannot
// prove the diff is whitelist-only (D2 judgement table row #5). NOTE: `gh api`
// exposes no separate "truncated"/pagination flag on this endpoint's plain
// JSON body, so this length check is the only signal available — the D2
// "or 回應標示分頁" alternative condition is not implementable against the
// plain `gh api` response shape and is intentionally not attempted here.
const COMPARE_FILES_MAX = 300;

// Both compare endpoints require full, unambiguous 40-hex shas. The sticky
// parser (second-review-sticky-authority.mjs) accepts abbreviated
// `last_reviewed_sha` values (7-40 hex chars) — a short sha is NOT rejected
// fail-closed here as a security compromise, it is fail-closed as a matter of
// "we cannot build an unambiguous compare URL from attacker-influenceable PR
// comment text otherwise" (comment bodies are not a trusted input surface).
const FULL_SHA_RE = /^[a-f0-9]{40}$/;

function hasSpecsPathSegment(filename) {
  // Path-segment match (not substring): "…/myspecs/…" stays eligible;
  // "…/specs/…" under a whitelist prefix is behavior-scope, not bookkeeping.
  return filename.split("/").includes("specs");
}

// Shared path eligibility only; primary reanchor additionally restricts Git
// object modes and Markdown paths and does not inherit sticky authority.
export function isWhitelistedPath(filename) {
  return typeof filename === "string"
    && filename.length > 0
    && PATH_D_PRIME_WHITELIST.some((prefix) => filename.startsWith(prefix))
    && !hasSpecsPathSegment(filename);
}

// Env-var names/prefixes that mark "this process is running under a test
// harness that mocks a `gh pr view`/PR-snapshot call, but did not necessarily
// intend to also mock this module's `gh api compare` call". When any such var
// is present and neither compare-specific mock is, fail closed WITHOUT
// spawning — this keeps pre-existing tests for both callers
// (pre-tool-gate.mjs's CM-6/CM-6b, post-pr-completion-check.mjs's
// DEVPRO_POST_PR_GATE_MOCK_* suite) hermetic instead of silently making them
// network-dependent once they exercise a code path that now reaches this
// module. `exact: true` entries match the full var name; otherwise the entry
// is a prefix.
const HERMETIC_TEST_GUARD_ENV_MARKERS = [
  { value: "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT", exact: true }, // pre-tool-gate.mjs `gh pr view` mock
  { value: "DEVPRO_POST_PR_GATE_MOCK_", exact: false }, // post-pr-completion-check.mjs PR-snapshot mock family
];

function hermeticTestGuardEnvPresent() {
  const keys = Object.keys(process.env);
  return HERMETIC_TEST_GUARD_ENV_MARKERS.some(({ value, exact }) =>
    keys.some((k) => (exact ? k === value : k.startsWith(value)))
  );
}

/**
 * Run (or mock) the single `gh api compare/...` call.
 * Returns `{ ok: true, body }` on a parseable success, `{ ok: false, reason }`
 * on any failure — `reason` is one of "compare-unavailable" (real `gh api`
 * spawn failure / non-zero exit / non-JSON stdout — D2 judgement table rows
 * #1 and #2 both collapse here, since `gh` maps HTTP 404/422 to a non-zero
 * process exit code, not a distinct signal) or "compare-mock-guard" (see
 * HERMETIC_TEST_GUARD_ENV_MARKERS above).
 */

export function fetchCompareBody({ lastReviewedSha, headRefOid, repoSlug, host, cwd }) {
  if (!FULL_SHA_RE.test(String(lastReviewedSha || "")) || !FULL_SHA_RE.test(String(headRefOid || ""))) {
    return { ok: false, reason: "compare-invalid-sha-shape" };
  }
  const mockError = process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_ERROR;
  if (typeof mockError === "string" && mockError.length > 0) {
    return { ok: false, reason: "compare-unavailable" };
  }

  const mockOutput = process.env.CROSS_MODEL_MERGE_GATE_MOCK_COMPARE_OUTPUT;
  if (typeof mockOutput === "string") {
    try {
      return { ok: true, body: JSON.parse(mockOutput) };
    } catch {
      return { ok: false, reason: "compare-unavailable" };
    }
  }

  // Hermetic-test guard — see HERMETIC_TEST_GUARD_ENV_MARKERS above.
  if (hermeticTestGuardEnvPresent()) {
    return { ok: false, reason: "compare-mock-guard" };
  }

  // owner/repo: reuse the caller-resolved repoSlug (mirrors `_extractRepoFlag`
  // in pre-tool-gate.mjs). When absent, fall back to `gh api`'s own
  // `{owner}/{repo}` placeholder expansion from cwd's git remote — the same
  // cwd-inference contract `_runGhPrView` relies on when no --repo flag is
  // present.
  // A caller that knows the host passes it, and gh is told it with --hostname instead of picking one itself.
  const ownerRepo = (typeof repoSlug === "string" && repoSlug.length > 0)
    ? repoSlug
    : "{owner}/{repo}";
  const hostArgs = typeof host === "string" && host.length > 0 ? ["--hostname", host] : [];
  const url = `repos/${ownerRepo}/compare/${lastReviewedSha}...${headRefOid}`;

  try {
    const spawnOpts = { encoding: "utf8", timeout: COMPARE_TIMEOUT_MS };
    if (typeof cwd === "string" && cwd.length > 0) spawnOpts.cwd = cwd;
    // Zero retry (R4/D2): exactly one spawnSync call, no loop, no re-invocation
    // on failure.
    const result = spawnSync("gh", ["api", ...hostArgs, url], spawnOpts);
    if (result.error) return { ok: false, reason: "compare-unavailable" }; // e.g. gh binary not found
    if (result.signal) return { ok: false, reason: "compare-unavailable" }; // killed — timeout reached
    if (result.status !== 0) return { ok: false, reason: "compare-unavailable" }; // non-zero exit (incl. 404/422/rate-limit/offline)
    const body = JSON.parse(result.stdout || "");
    return { ok: true, body };
  } catch {
    return { ok: false, reason: "compare-unavailable" }; // non-JSON stdout or unexpected spawn exception
  }
}

/**
 * Path D′ fresh-equivalent judgement.
 *
 * @param {{ lastReviewedSha: string, headRefOid: string, repoSlug?: string|null, cwd?: string }} args
 * @returns {{ fresh_equivalent: boolean, reason: string, files?: Array<{filename: string}> }}
 */
export function evaluateFreshEquivalent({ lastReviewedSha, headRefOid, repoSlug, host, cwd } = {}) {
  // Reject non-full-length / non-hex shas unconditionally (applies to mocked
  // calls too — this validates the caller's inputs, not the transport). Both
  // values ultimately compose a `gh api` path segment; `last_reviewed_sha` in
  // particular is parsed out of PR comment text (an attacker-influenceable
  // surface) and the sticky parser accepts 7-40 char abbreviated shas, which
  // would make the compare URL ambiguous. Fail closed rather than guess.
  if (!FULL_SHA_RE.test(String(lastReviewedSha || "")) || !FULL_SHA_RE.test(String(headRefOid || ""))) {
    return { fresh_equivalent: false, reason: "compare-invalid-sha-shape" };
  }

  const fetched = fetchCompareBody({ lastReviewedSha, headRefOid, repoSlug, host, cwd });
  return evaluateFreshEquivalentEvidence({ lastReviewedSha, headRefOid, fetched });
}

/** Same judgement for CLI observations and Broker-fetched GitHub evidence. No I/O. */
export function evaluateFreshEquivalentEvidence({ lastReviewedSha, headRefOid, fetched } = {}) {
  if (!FULL_SHA_RE.test(String(lastReviewedSha || "")) || !FULL_SHA_RE.test(String(headRefOid || ""))) {
    return { fresh_equivalent: false, reason: "compare-invalid-sha-shape" };
  }
  if (!fetched || typeof fetched !== "object") fetched = { ok: false, reason: "compare-unavailable" };
  if (!fetched.ok) {
    // D2 judgement table rows #1 (gh unavailable/spawn fail/exit≠0/non-JSON
    // stdout, incl. offline/rate-limit) and #2 (HTTP 404/422) — both collapse
    // to a real `gh api` non-zero exit or spawn failure (typed "compare-unavailable").
    // "compare-mock-guard" is the hermetic-test-only variant (see
    // HERMETIC_TEST_GUARD_ENV_MARKERS) — same fail-closed outcome, distinct
    // reason so tests/logs can tell "genuinely unavailable" apart from "test
    // harness detected, no compare mock supplied".
    return { fresh_equivalent: false, reason: fetched.reason || "compare-unavailable" };
  }

  const body = fetched.body;
  const status = typeof body?.status === "string" ? body.status : "";
  if (status !== "ahead" && status !== "identical") {
    // Row #3: diverged/behind = not an ancestor relationship / lineage broken.
    return { fresh_equivalent: false, reason: "compare-status-not-ancestor" };
  }

  const files = body?.files;
  const filesShapeValid = Array.isArray(files)
    && files.every((f) => f && typeof f === "object" && typeof f.filename === "string" && f.filename.length > 0);
  if (!filesShapeValid) {
    // Row #4: files missing / non-array / any element missing filename.
    return { fresh_equivalent: false, reason: "compare-files-invalid" };
  }

  if (files.length >= COMPARE_FILES_MAX) {
    // Row #5: truncated — cannot prove whitelist-only.
    return { fresh_equivalent: false, reason: "compare-files-truncated" };
  }

  const allWhitelisted = files.every((f) => isWhitelistedPath(f.filename));
  if (!allWhitelisted) {
    return { fresh_equivalent: false, reason: "path-d-prime-whitelist-miss" };
  }

  return { fresh_equivalent: true, reason: "path-d-prime-whitelist-only", files };
}
