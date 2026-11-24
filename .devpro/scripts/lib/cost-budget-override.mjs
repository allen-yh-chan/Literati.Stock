/**
 * D11 `DEVPRO_COST_BUDGET_OVERRIDE=<change>:<threshold>` named-override
 * consumer (task 8). This module is a bypass judgment layered ON TOP OF
 * `evaluateCostBudget`'s result — it does not evaluate thresholds itself and
 * has no opinion on how `exceeded_thresholds` was produced. See
 * `openspec/changes/add-change-cost-circuit-breaker/design.md` D11.
 *
 * Same authorization SHAPE as change 1's `DEVPRO_REVIEW_ROUND_OVERRIDE=<PR#>:<n>`
 * (`review-round-budget.mjs`'s `parseReviewRoundOverride`) — a named,
 * user-set env var, fail-closed on any parse/match failure — per D11's
 * explicit rejection of an "agent cannot mint this" alternative trust model
 * (finding F-1-1). `parseCostBudgetOverride` mirrors that function's
 * check-only/no-write split.
 *
 * Two behaviors this module adds beyond change 1's precedent, both from D11:
 *   - exact-set matching (point 2): a declared `<threshold>` list must equal
 *     — not merely intersect — the evaluator's current `exceeded_thresholds`,
 *     so an override can never silently cover a threshold the user never saw.
 *   - write-gated effectiveness (F-5-4): an authorized override is NOT
 *     "effective" until `appendChangeUsageOverride`'s durable write actually
 *     succeeds. This is the ONE place in this change where a checkpoint
 *     write failure blocks a caller (opposite of D7/F-4-3's fail-open
 *     default for the sessions[] write) — losing the audit trail for an
 *     already-granted exemption is not an acceptable degradation, per D11's
 *     "授權本身失去可稽核性" framing.
 */
import { COST_BUDGET_THRESHOLDS } from "./cost-budget.mjs";
import { appendChangeUsageOverride } from "../hooks/lib/change-usage-checkpoint.mjs";
import { CHANGE_NAME_GRAMMAR } from "./resolve-change-cost-usage.mjs";

// Overall shape: exactly one `:` separating a change token from a threshold
// token; neither side may be empty or contain whitespace. This is checked
// BEFORE any content-level validation (change grammar, threshold set
// membership) so "no colon at all" and "empty threshold list" both land on
// `malformed`, never on a content-specific reason.
const OVERRIDE_SHAPE_RE = /^(\S+):(\S+)$/;

// A threshold token's shape (lowercase letters/underscores only) is checked
// BEFORE set-membership: a wrongly-shaped token (uppercase, punctuation) is
// `malformed`; a correctly-shaped token absent from `COST_BUDGET_THRESHOLDS`
// is the distinct `unknown_threshold_key` reason (D11 point 1's "與格式不符
// 同一 FAIL CLOSED 路徑" governs the END EFFECT — block — not the diagnostic
// reason code; task 8's acceptance requires these as independent tests).
const THRESHOLD_TOKEN_RE = /^[a-z_]+$/;

// Read-side symmetry (F-e81f9d44): `post-pr-cost-circuit-breaker.mjs`'s
// `OVERRIDE_LINE_RE` demands exactly 40 lowercase hex characters for
// `head_ref_oid=...`. Without this write-side guard, an absent or
// non-canonical `headRefOid` (empty, uppercase, wrong length) would still be
// written to the durable checkpoint, producing an override entry no PR body
// line could ever satisfy — a permanent, unresolvable block. Mirrors the
// existing `sessionId` guard below, not the D7/F-4-3 fail-open default.
const HEAD_REF_OID_RE = /^[0-9a-f]{40}$/;

// D5 (fix-second-review-loop-friction): `round`/`review_round` are the two
// legacy tokens a user might still type out of habit — `round` was a real
// (now-removed, D1) cost threshold key; `review_round` is the disclosure
// checkpoint's own entry-kind label (D7/D8), never a valid override
// declaration. Both resolve `unknown_threshold_key` like any other unrecognized
// token (no special-cased authorization path), but this hint is attached so
// the user is pointed at the mechanism that actually does what they meant:
// extending pr-sticky review rounds, not a cost exemption.
export const ROUND_EXTENSION_HINT =
  "`round`/`review_round` are not cost thresholds; extend pr-sticky review rounds only with DEVPRO_REVIEW_ROUND_OVERRIDE=<PR#>:<n>";
const LEGACY_ROUND_TOKENS = new Set(["round", "review_round"]);

/**
 * CHECK ONLY (no write) — mirrors `parseReviewRoundOverride`'s split. Returns
 * `{ authorized: false, reason }` for every fail-closed path (D11: missing /
 * malformed / change mismatch / unknown key / non-exact-set all resolve
 * here, uniformly, before any write is attempted) or `{ authorized: true,
 * reason: "authorized", declared_thresholds }` when the declared set exactly
 * equals `exceededThresholds` (order-insensitive; duplicates in either input
 * collapse under set comparison — D11 defines "exact set", not "exact
 * multiset", for this comparison).
 */
export function parseCostBudgetOverride(envValue, { changeName, exceededThresholds = [] } = {}) {
  const raw = envValue === undefined || envValue === null ? "" : String(envValue).trim();
  if (raw === "") {
    return { authorized: false, reason: "missing" };
  }
  const shapeMatch = OVERRIDE_SHAPE_RE.exec(raw);
  if (!shapeMatch) {
    return { authorized: false, reason: "malformed" };
  }
  const [, overrideChange, thresholdList] = shapeMatch;
  if (!CHANGE_NAME_GRAMMAR.test(overrideChange)) {
    return { authorized: false, reason: "malformed" };
  }
  const declaredThresholds = thresholdList.split(",");
  if (declaredThresholds.some((token) => !THRESHOLD_TOKEN_RE.test(token))) {
    return { authorized: false, reason: "malformed" };
  }
  if (overrideChange !== String(changeName ?? "")) {
    return { authorized: false, reason: "change_mismatch", override_change: overrideChange, declared_thresholds: declaredThresholds };
  }
  const validKeys = new Set(Object.keys(COST_BUDGET_THRESHOLDS));
  const unknownKeys = declaredThresholds.filter((token) => !validKeys.has(token));
  if (unknownKeys.length > 0) {
    const result = { authorized: false, reason: "unknown_threshold_key", unknown_keys: unknownKeys, declared_thresholds: declaredThresholds };
    if (unknownKeys.some((token) => LEGACY_ROUND_TOKENS.has(token))) result.hint = ROUND_EXTENSION_HINT;
    return result;
  }
  const declaredSet = new Set(declaredThresholds);
  const exceededSet = new Set(exceededThresholds);
  const exactMatch = declaredSet.size === exceededSet.size && [...declaredSet].every((key) => exceededSet.has(key));
  if (!exactMatch) {
    return {
      authorized: false,
      reason: "not_exact_set",
      declared_thresholds: [...declaredSet],
      exceeded_thresholds: [...exceededSet],
    };
  }
  return { authorized: true, reason: "authorized", declared_thresholds: [...declaredSet] };
}

/**
 * CHECK + WRITE. Callers (report-session-token-usage.mjs's `--budget-check`
 * site, post-pr-completion-check.mjs task 7 site) call this ONLY when the
 * evaluator already reported `exceeded` — an unauthorized/ineffective result
 * here means "keep the pre-existing block", never a new failure mode of its
 * own. `sessionId`/`headRefOid` are caller-resolved (not re-derived here),
 * matching `record-change-usage-checkpoint.mjs`'s existing convention of
 * resolving session identity once at the call site via `captureTlHostSession`.
 *
 * F-5-4: `effective` is true ONLY after `appendChangeUsageOverride` returns
 * `{status:"written"}`. A missing/unresolvable `sessionId`, or any append
 * failure, resolves `effective: false` — the caller's original block MUST
 * stand. This is deliberately NOT the same fail-open direction as D7/F-4-3's
 * sessions[] write (see module doc comment).
 */
export function resolveCostBudgetOverride({
  envValue,
  changeName,
  exceededThresholds,
  cwd = process.cwd(),
  sessionId,
  headRefOid,
  now = () => new Date().toISOString(),
  append = appendChangeUsageOverride,
} = {}) {
  const parsed = parseCostBudgetOverride(envValue, { changeName, exceededThresholds });
  if (!parsed.authorized) {
    return { effective: false, ...parsed };
  }
  if (!sessionId) {
    return { effective: false, reason: "session_unresolvable" };
  }
  if (!HEAD_REF_OID_RE.test(String(headRefOid ?? ""))) {
    return { effective: false, reason: "head_ref_oid_unresolvable" };
  }
  const at = now();
  const writeResult = append({
    cwd,
    changeName,
    session_id: sessionId,
    at,
    thresholds: parsed.declared_thresholds,
    head_ref_oid: headRefOid,
  });
  if (writeResult?.status !== "written") {
    return { effective: false, reason: "override_write_failed", write_reason: writeResult?.reason };
  }
  return { effective: true, reason: "authorized", declared_thresholds: parsed.declared_thresholds, at };
}
