/**
 * Review stall budget: the single owner of "how many rounds in a row has
 * remediation failed to make progress" and of the cap that answers it.
 * See `openspec/changes/fix-zero-value-review-rounds/design.md` D3/D4/D5
 * and `openspec/changes/fix-review-convergence-deadlocks/design.md` R2
 * (`blocking_ids` true-subset progress).
 *
 * WHY THIS EXISTS. The pre-existing cost circuit breaker measures cumulative
 * token totals — `output`, `cache_read`, `model_time`. Those are functions of
 * how big a change is, not of whether it is going anywhere. A large change
 * trips them while making steady progress; a small change spinning on the
 * same unfixable finding never trips them at all. This module measures the
 * thing the breaker was actually meant to catch: waste, expressed as rounds
 * elapsed since the blocking finding set last made progress.
 *
 * WHY IT IS PURE. This module imports nothing — not filesystem APIs, not
 * subprocess APIs, not another repo module. Two very different callers
 * consume it: the bounded-rereview gate (which already holds a validated
 * receipt-chain projection) and the `--budget-check` report surface (which
 * loads its own anchor). If the rule could read the filesystem, each caller
 * would grow its own loading path and the two would drift into giving
 * different answers to the same question — the exact failure D9 rejects.
 * Callers hand in the projection; this module only derives.
 *
 * WHY THE CAP LIVES HERE AND NOT IN `COST_BUDGET_THRESHOLDS`. That table
 * self-describes as the sole grep-locked copy of the threshold values, and
 * its grep-lock is enforceable because those limits are distinctive literals
 * (this comment deliberately does not quote one -- that grep-lock counts
 * occurrences anywhere outside its own module, prose included). A bare `2` is
 * not greppable-unique, so putting it there would
 * place an unprovable value inside a table whose whole claim is mechanical
 * uniqueness. The pr-sticky round cap set the precedent for keeping a cap out
 * of that table: it lives in `review-round-budget.mjs`, is not a Cost
 * Circuit Breaker threshold, and (per `fix-second-review-loop-friction` D1)
 * has no key of its own in `COST_BUDGET_THRESHOLDS` at all — unlike
 * `stalled_rounds` (the cap this module owns), which does get a key in that
 * table, with `limit: null` pointing back here.
 */

// D4: the sole copy of this number in the repo. It belongs to the stall lane
// only and MUST NOT be merged with the pr-sticky lane cap (3), the
// design-gate audit-only lane cap (6), or the bounded-rereview count (3).
//
// Why 2, from structural bounds rather than from one observation: a cap of 1
// fires the first time a round fails to close every finding, which is a
// normal outcome — that reproduces the always-same-answer dialog this change
// exists to remove. A cap of 3 or more can never fire earlier than the
// existing `bounded_rereview_count >= 3` observation on the bounded path, so it
// would add nothing there. The open interval (1, 3) contains only 2. The real
// gain is not a lower number: `bounded_rereview_count` only increments when
// `route === "bounded"`, so a run of `route=full` rounds is today subject to
// no cap at all, and the stall streak counts every route alike. Cap hit enters
// convergence recovery (not user handback) on convergent paths; do NOT raise
// this constant as a remediation.
export const REVIEW_STALL_ROUND_CAP = 2;

/** Programming-error guard, deliberately not a policy state. Whether a
 * receipt chain is trustworthy is `walkReceiptAuthorityChain`'s authority,
 * and a chain that fails there becomes `unavailable` and never reaches this
 * function. What is checked here is only that the caller passed the declared
 * shape. Coercing a malformed entry to "zero open findings" instead would
 * make a wiring bug read as a converged review — silently fail-open on the
 * one signal this module exists to raise. */
function normalizeRound(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(
      `review stall projection entry ${index} must be an object, received ${entry === null ? "null" : typeof entry}`
    );
  }
  if (!Number.isSafeInteger(entry.round_number)) {
    throw new TypeError(
      `review stall projection entry ${index} must carry an integer round_number, received ${String(entry.round_number)}`
    );
  }
  // Prefer explicit blocking_ids (Critical/Important open). Fall back to
  // open_finding_ids only for pure unit fixtures that model "all opens are
  // blocking"; production projections from walkReceiptAuthorityChain always
  // emit blocking_ids.
  let blockingIds = entry.blocking_ids;
  if (blockingIds === undefined) {
    if (!Array.isArray(entry.open_finding_ids)) {
      throw new TypeError(
        `review stall projection entry ${index} must carry a blocking_ids or open_finding_ids array, received `
        + `${entry.open_finding_ids === undefined ? "undefined" : typeof entry.open_finding_ids}`
      );
    }
    blockingIds = entry.open_finding_ids;
  } else if (!Array.isArray(blockingIds)) {
    throw new TypeError(
      `review stall projection entry ${index} must carry a blocking_ids array, received ${typeof blockingIds}`
    );
  }
  if (blockingIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError(
      `review stall projection entry ${index} blocking_ids must be non-empty strings`
    );
  }
  if (new Set(blockingIds).size !== blockingIds.length) {
    throw new TypeError(
      `review stall projection entry ${index} blocking_ids must be unique`
    );
  }
  return {
    roundNumber: entry.round_number,
    blockingIds: [...blockingIds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}

/** True iff `current` is a strict subset of `previous` (clearance progress). */
function isStrictBlockingSubset(current, previous) {
  if (current.length >= previous.length) return false;
  const previousSet = new Set(previous);
  return current.every((id) => previousSet.has(id));
}

/**
 * D5 + R2. Given the receipt-chain projection
 * `[{ round_number, blocking_ids? | open_finding_ids }]`, count backwards from
 * the newest round the run of consecutive rounds that made no progress.
 *
 * Progress is a STRICT SUBSET shrink of `blocking_ids` against the previous
 * round (clearance). Three things stop the walk-back, none of which are
 * counted:
 *
 *   1. A round whose blocking set is EMPTY. An empty set is convergence
 *      itself, not stalling. The walk halts (rather than skipping past) so
 *      rounds on the far side of a convergence cannot be recruited into a
 *      later streak.
 *   2. A round that made progress (true subset shrink).
 *   3. The first round, which has no predecessor to compare against.
 *
 * Same-cardinality swap — close A, open B — is NOT a subset and counts as NO
 * progress (stall). Cardinality shrink with wholly new IDs is also NOT a
 * subset and counts as stall: only true clearance of previously open
 * blocking ids counts as progress.
 *
 * Nothing here reads `route`, `review_mode`, or `full_reopen_reason`. Any
 * exemption keyed on those would create a bypass unrelated to intent: push an
 * irrelevant commit, lineage moves, the next round becomes `route=full`, that
 * round goes uncounted, and the streak never accumulates. A gate must not
 * have a "touch a file and it's free" exit.
 */
export function deriveReviewStallStreak(rounds) {
  if (!Array.isArray(rounds)) {
    throw new TypeError(`review stall projection must be an array, received ${typeof rounds}`);
  }
  const ascending = rounds
    .map(normalizeRound)
    .sort((a, b) => a.roundNumber - b.roundNumber);

  let streak = 0;
  for (let index = ascending.length - 1; index >= 1; index -= 1) {
    const current = ascending[index];
    if (current.blockingIds.length === 0) break; // convergence: halt clause 1
    if (isStrictBlockingSubset(current.blockingIds, ascending[index - 1].blockingIds)) {
      break; // progress: halt clause 2
    }
    streak += 1;
  }
  return streak; // index 0 falls out of the loop: halt clause 3
}

/** D4: the cap comparison stays inside the module that owns the number, so
 * consumers get a boolean without importing or re-comparing
 * `REVIEW_STALL_ROUND_CAP` themselves. */
export function isReviewStallBudgetExhausted({ rounds } = {}) {
  return deriveReviewStallStreak(rounds ?? []) >= REVIEW_STALL_ROUND_CAP;
}
