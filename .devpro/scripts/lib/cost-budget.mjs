/**
 * D10 cost-circuit-breaker threshold evaluator. `COST_BUDGET_THRESHOLDS`
 * is the SOLE copy of the threshold values in this repo — grep-locked, see
 * `tests/cost-budget.test.mjs`. See
 * `openspec/changes/add-change-cost-circuit-breaker/design.md` D10/D11/D2/D6.
 *
 * Threshold (c) consumes D6's `model_time_ms` (sum of per-turn `duration_ms`,
 * wired into `aggregateSinceChangeUsage` by `session-token-usage.mjs`) via
 * the caller-supplied `usage` rollup — this module does not read transcripts
 * itself and has no opinion on how `usage` was produced.
 *
 * There is no cost-side `round` threshold. Extending pr-sticky review rounds
 * has exactly one authorization — `DEVPRO_REVIEW_ROUND_OVERRIDE=<PR#>:<n>`,
 * evaluated entirely inside `hooks/lib/review-round-budget.mjs`
 * (`fix-second-review-loop-friction` D1) — so this module never imports or
 * duplicates that cap (brd R-5).
 *
 * Threshold (e) `stalled_rounds` (fix-zero-value-review-rounds R3) measures
 * waste rather than size: how many review rounds have run since the open
 * finding set last shrank. This module does not query for it — the
 * observation is a caller-supplied argument, because the receipt chain it
 * comes from lives behind a filesystem walk and this module MUST stay pure
 * (brd; `cost-budget.mjs` grows no filesystem dependencies). The rule and the
 * cap both live in `review-stall-budget.mjs`.
 */

// D10/D1 (fix-second-review-loop-friction): four threshold keys. The first
// three are byte-exact per D11 point 1 (`output` / `cache_read` /
// `model_time`); `stalled_rounds` is added by fix-zero-value-review-rounds
// R3. Task 8's `DEVPRO_COST_BUDGET_OVERRIDE` exact-set matcher compares its
// declared keys against `Object.keys(COST_BUDGET_THRESHOLDS)` directly; MUST
// NOT introduce a second naming scheme. There is deliberately no `round` key
// here any more — see the module doc comment above.
export const COST_BUDGET_THRESHOLDS = Object.freeze({
  output: Object.freeze({
    limit: 800_000,
    unit: "tokens",
    label: "cumulative output tokens since change start",
  }),
  cache_read: Object.freeze({
    limit: 250_000_000,
    unit: "tokens",
    label: "cumulative cache_read tokens since change start",
  }),
  model_time: Object.freeze({
    limit: 21_600_000,
    unit: "ms",
    label: "cumulative model time since change start (D6: sum of per-turn duration_ms)",
  }),
  // `limit: null` — the table names the threshold, it does not restate the
  // number. This is an integer streak, not a boolean; `limit: null` here does
  // not mean "no cap": the cap is `REVIEW_STALL_ROUND_CAP` in
  // `review-stall-budget.mjs`. Naming the constant instead of quoting its
  // value is also what keeps a second copy of the cap out of this file — the
  // value is a bare small integer, so unlike the three limits above it could
  // never be grep-locked.
  stalled_rounds: Object.freeze({
    limit: null,
    unit: "rounds",
    label: "review rounds since the open finding set last shrank, vs REVIEW_STALL_ROUND_CAP (review-stall-budget.mjs, read-only)",
  }),
});

// A correct caller's `usage.totals.*` is always a real number (0 included —
// `aggregateSinceChangeUsage` initializes and only ever adds to numeric
// accumulators, never leaves a field missing). A non-finite value here means
// the caller handed this evaluator the wrong object shape (e.g. the
// `{ available, since_change, ...rollup }` wrapper instead of `rollup`
// itself). Silently coercing that to 0 would make a malformed call read as
// "ok" — the exact fail-open direction D6 names as dangerous (false
// negatives, not false positives, are what let a real overage run
// unnoticed). `unavailable` is a third state, distinct from both `ok` and
// `exceeded`, and — like threshold (e)'s (`stalled_rounds`) own `unavailable`
// — is excluded from `exceeded_thresholds`.
function evaluateNumericThreshold(rawValue, limit) {
  if (!Number.isFinite(rawValue)) {
    return { value: null, limit, state: "unavailable" };
  }
  return { value: rawValue, limit, state: rawValue > limit ? "exceeded" : "ok" };
}

// D10 (fix-zero-value-review-rounds): `not-applicable` is an invariant, not
// an implementation detail. A caller that supplies no stall observation gets
// it decided HERE, on the first line, before any field of `reviewStall` is
// touched. That is what makes `exceeded_thresholds` and the exit code
// bit-identical for every caller with no receipt-chain concept
// (`post-pr-cost-circuit-breaker.mjs`, `render-second-review-packet.mjs`),
// including every caller at the time this threshold was added: none of them
// pass `reviewStall` yet.
//
// The observation itself is produced by `queryReviewStallState({ changeId })`
// (review-remediation-evidence core) and arrives as
// `{ state, streak }`. Its four states are deliberately distinct:
//   - `not-applicable` — zero receipts. Nothing SHOULD have been read. A
//     change that has never run a review round must not be blocked by a
//     stall signal it structurally cannot have produced.
//   - `unavailable`    — receipts exist but the chain would not load or
//     verify. Something that SHOULD have been read could not be. Never
//     collapses to `ok` or to streak 0; the whole point of this change is to
//     stop shipping gates whose broken input reads as clean.
//   - `ok` / `exhausted` — read and verified.
// `exhausted` is `review-stall-budget.mjs`'s word for "the stall budget is
// used up"; `exceeded` is this table's word for the same fact. Each module
// keeps its own vocabulary and the translation happens once, here.
function evaluateStalledRoundsThreshold(reviewStall) {
  if (reviewStall === null || reviewStall === undefined) {
    return { value: null, limit: null, state: "not-applicable" };
  }
  const streak = Number.isFinite(reviewStall.streak) ? reviewStall.streak : null;
  switch (reviewStall.state) {
    case "not-applicable":
      return { value: null, limit: null, state: "not-applicable" };
    case "exhausted":
      return { value: streak, limit: null, state: "exceeded" };
    case "ok":
      return { value: streak, limit: null, state: "ok" };
    default:
      // Includes the caller's own `unavailable` and anything unrecognized.
      // Same fail-closed direction as `evaluateNumericThreshold`'s non-finite
      // guard: a shape this module does not understand must not read as `ok`.
      return { value: null, limit: null, state: "unavailable" };
  }
}

/**
 * D10/D1 (fix-second-review-loop-friction) four-threshold evaluation. `usage`
 * is the caller's own `aggregateSinceChangeUsage` rollup (`{ totals: {
 * output, cache_read, model_time_ms }, ... }`); this module does not compute
 * it. There is no `prNumber`/`cwd` input any more — this module never reads
 * pr-sticky round state; extending review rounds is entirely
 * `review-round-budget.mjs`'s concern.
 *
 * `reviewStall` is threshold (e)'s observation, and it is a sibling of
 * `usage` rather than a field folded into it for the same reason `usage` is
 * its own argument: `usage` is one specific object with one specific
 * producer (`aggregateSinceChangeUsage`, handed over by
 * `resolve-change-cost-usage.mjs`, whose own doc comment names it as this
 * argument), and a stall observation is not part of that rollup. Threshold
 * inputs that are not usage totals arrive as their own argument. Omit it and
 * (e) is `not-applicable`.
 *
 * F-5-3: partial input coverage is NEVER used to exempt an already-exceeded
 * total — (a)/(b)/(c) compare the caller-supplied totals exactly as given,
 * regardless of `usage.coverage`. A partial rollup whose partial totals
 * already clear a threshold still reports `exceeded`; under-measurement from
 * partial coverage is `aggregateSinceChangeUsage`'s own documented
 * low-estimate direction (D3 R-2), not something this evaluator re-derives
 * or downgrades.
 */
export function evaluateCostBudget({ usage, reviewStall = null } = {}) {
  const totals = usage?.totals ?? {};
  const thresholds = {
    output: evaluateNumericThreshold(totals.output, COST_BUDGET_THRESHOLDS.output.limit),
    cache_read: evaluateNumericThreshold(totals.cache_read, COST_BUDGET_THRESHOLDS.cache_read.limit),
    model_time: evaluateNumericThreshold(totals.model_time_ms, COST_BUDGET_THRESHOLDS.model_time.limit),
    stalled_rounds: evaluateStalledRoundsThreshold(reviewStall),
  };
  // Table-declaration order (output, cache_read, model_time,
  // stalled_rounds), NOT ASCII-ascending. D11 point 2's exact-set match
  // against a declared override is a SET comparison ("key 集合必須...完全相等")
  // — task 8's matcher MUST compare as sets/sorted, not rely on this array's
  // order. Table order is kept here because it is the more useful order for a
  // human-facing `--budget-check` report (task 5): (a)(b)(c)(e) reading
  // order, not an alphabetical shuffle.
  const exceeded_thresholds = Object.keys(thresholds).filter((key) => thresholds[key].state === "exceeded");
  const coverage = normalizeCoverage(usage?.coverage);
  return {
    exceeded: exceeded_thresholds.length > 0,
    exceeded_thresholds,
    thresholds,
    coverage,
    budget_state: deriveBudgetState(thresholds, coverage),
  };
}

// D8 (strengthen-subagent-delegation-strategy): `coverage` is passed through
// from the caller's rollup (`aggregateSinceChangeUsage` emits
// `complete` | `partial`); anything else is `unknown` — never coerced to
// `complete`, since coverage is the (3)-branch gate below.
function normalizeCoverage(value) {
  return value === "complete" || value === "partial" ? value : "unknown";
}

// D8 half-state derivation, literal priority from V3.2 §8. Only the three
// numeric thresholds participate. `stalled_rounds` is excluded, and the list
// below is therefore deliberately shorter than the table — do not "complete"
// it. Half-state answers "how much of a cumulative budget is left", which is
// a ratio to a limit this table holds; the excluded key has none
// (`limit: null`), and adding it would turn every ratio-complete run into
// `unavailable` because its ratio is null.
// `stalled_rounds` is a waste signal whose cap lives in another module, and
// fix-zero-value-review-rounds D11 states as a checked fact that it changes
// neither `budget_state` nor `budget_state_effective`. `exhausted` uses ≥ limit
// (the state names "budget consumed"), while `thresholds.*.state` keeps its
// strict `>` so the `--budget-check` exit-code contract (0/1/2) is untouched.
// This is the same direction as F-5-3 above: partial coverage never exempts a
// value that already crossed a line; it only withholds `below-half`, which
// requires every numeric to be measured AND coverage `complete`.
/**
 * D23/D24 (strengthen-subagent-delegation-strategy): the user's exact-set
 * threshold override (`resolveCostBudgetOverride`, effective only after its
 * durable append) does not rewrite `budget_state`; it excludes the approved
 * thresholds and re-derives the state over what remains, with the same D8
 * priority. Callers print this beside the raw `budget_state`, never instead
 * of it. Unknown keys are ignored (they cannot be part of an exact-set match).
 */
export function deriveEffectiveBudgetState(budget, overriddenThresholds = []) {
  const excluded = new Set(Array.isArray(overriddenThresholds) ? overriddenThresholds : []);
  const thresholds = budget?.thresholds ?? {};
  // Approved thresholds leave the derivation entirely (they were measured and
  // the user accepted them); the D8 priority then runs over what remains, and
  // `below-half` still needs every remaining numeric measured plus complete
  // coverage. Nothing remaining → `unavailable`, never `below-half`.
  const remaining = ["output", "cache_read", "model_time"].filter((key) => !excluded.has(key)).map((key) => thresholds[key] ?? { value: null, limit: null });
  const ratio = (entry) => (Number.isFinite(entry?.value) && Number.isFinite(entry?.limit) && entry.limit > 0 ? entry.value / entry.limit : null);
  const ratios = remaining.map(ratio);
  if (ratios.some((r) => r !== null && r >= 1)) return "exhausted";
  if (ratios.some((r) => r !== null && r >= 0.5)) return "at-or-above-half";
  if (ratios.length > 0 && ratios.every((r) => r !== null) && normalizeCoverage(budget?.coverage) === "complete") return "below-half";
  return "unavailable";
}

// Raw state = the effective derivation with nothing excluded (single D8 ladder).
function deriveBudgetState(thresholds, coverage) {
  return deriveEffectiveBudgetState({ thresholds, coverage }, []);
}
