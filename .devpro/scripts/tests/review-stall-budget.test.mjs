/**
 * Prove-it tests for the review stall budget (`fix-zero-value-review-rounds`
 * T1, brd R3/R5; `fix-review-convergence-deadlocks` R2 blocking_ids subset).
 *
 * NFR4: every fixture here is a synthesized literal. These tests MUST NOT
 * read the machine-local gitignored receipt files — that state is not present
 * in CI and is not part of the repo. The S1 sequence below was *derived* from
 * the sealed receipt chain of the `fix-session-pending-item-parse` change
 * (rounds 1-7) and then written down as nested-subset literals; nothing at
 * runtime touches those files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import {
  REVIEW_STALL_ROUND_CAP,
  deriveReviewStallStreak,
  isReviewStallBudgetExhausted,
} from "../lib/review-stall-budget.mjs";

/** Build projection from open/blocking counts as nested subsets of a shared
 * universe so cardinality shrink is also a true-subset clearance. */
function chain(counts, { idPrefix = "F" } = {}) {
  const max = Math.max(0, ...counts);
  const universe = Array.from({ length: max }, (_, i) => `${idPrefix}-${i + 1}`);
  return counts.map((count, index) => ({
    round_number: index + 1,
    blocking_ids: universe.slice(0, count),
    open_finding_ids: universe.slice(0, count),
  }));
}

// The measured open-finding sequence of `fix-session-pending-item-parse`,
// r1 through r7. `## 109.` names this change as its own acceptance case.
const MEASURED_SEQUENCE = [8, 5, 3, 0, 0, 2, 0];

// --- brd S1 / S12: the change item 109 names must NOT trip the breaker ---

test("S1: the measured fix-session-pending-item-parse chain does not exhaust the stall budget", () => {
  assert.equal(isReviewStallBudgetExhausted({ rounds: chain(MEASURED_SEQUENCE) }), false);
});

test("S1: no prefix of the measured chain exhausts the stall budget", () => {
  for (let end = 1; end <= MEASURED_SEQUENCE.length; end += 1) {
    const prefix = MEASURED_SEQUENCE.slice(0, end);
    assert.equal(
      isReviewStallBudgetExhausted({ rounds: chain(prefix) }),
      false,
      `prefix through r${end} (${prefix.join("->")}) must not be exhausted`
    );
  }
});

test("S12: the r6 prefix streak is exactly 1 - the sole discriminator for D5's empty-round halt", () => {
  assert.equal(deriveReviewStallStreak(chain(MEASURED_SEQUENCE.slice(0, 6))), 1);
});

test("the measured chain's own streak is 0 - it ends on an empty round", () => {
  assert.equal(deriveReviewStallStreak(chain(MEASURED_SEQUENCE)), 0);
});

// --- brd S2: genuine stalling must trip it ---

test("S2: a flat non-empty sequence exhausts the stall budget", () => {
  assert.equal(deriveReviewStallStreak(chain([2, 2, 2])), 2);
  assert.equal(isReviewStallBudgetExhausted({ rounds: chain([2, 2, 2]) }), true);
});

test("S2: a rising sequence exhausts the stall budget", () => {
  assert.equal(deriveReviewStallStreak(chain([2, 3, 3])), 2);
  assert.equal(isReviewStallBudgetExhausted({ rounds: chain([2, 3, 3]) }), true);
});

test("D5: same-size churn counts as no progress — closing 2 and opening 2 is the classic spin", () => {
  const rounds = [
    { round_number: 1, blocking_ids: ["A1", "A2"] },
    { round_number: 2, blocking_ids: ["B1", "B2"] },
    { round_number: 3, blocking_ids: ["C1", "C2"] },
  ];
  assert.equal(deriveReviewStallStreak(rounds), 2);
  assert.equal(isReviewStallBudgetExhausted({ rounds }), true);
});

test("R2: blocking_ids swap {A}→{B} counts as stall (not clearance)", () => {
  const rounds = [
    { round_number: 1, blocking_ids: ["A"] },
    { round_number: 2, blocking_ids: ["B"] },
    { round_number: 3, blocking_ids: ["C"] },
  ];
  assert.equal(deriveReviewStallStreak(rounds), 2);
  assert.equal(isReviewStallBudgetExhausted({ rounds }), true);
});

test("R2: true subset shrink of blocking_ids is clearance progress, not stall", () => {
  const rounds = [
    { round_number: 1, blocking_ids: ["A", "B", "C"] },
    { round_number: 2, blocking_ids: ["A", "B"] },
    { round_number: 3, blocking_ids: ["A"] },
  ];
  assert.equal(deriveReviewStallStreak(rounds), 0);
  assert.equal(isReviewStallBudgetExhausted({ rounds }), false);
});

test("R2: cardinality shrink with wholly new ids is NOT subset progress (stall)", () => {
  const rounds = [
    { round_number: 1, blocking_ids: ["A", "B", "C"] },
    { round_number: 2, blocking_ids: ["X", "Y"] },
    { round_number: 3, blocking_ids: ["Z"] },
  ];
  assert.equal(deriveReviewStallStreak(rounds), 2);
  assert.equal(isReviewStallBudgetExhausted({ rounds }), true);
});

// --- D5's individual clauses ---

test("D5: progress is a strict subset shrink, and it halts the walk-back", () => {
  assert.equal(deriveReviewStallStreak(chain([3, 3, 2])), 0);
});

test("D5: round 1 is never counted — it has no predecessor to compare against", () => {
  assert.equal(deriveReviewStallStreak(chain([5])), 0);
  assert.equal(deriveReviewStallStreak(chain([0])), 0);
  assert.equal(deriveReviewStallStreak([]), 0);
});

test("D5: an empty round halts the walk-back rather than continuing through it", () => {
  assert.equal(deriveReviewStallStreak(chain([3, 3, 3, 0])), 0);
  assert.equal(deriveReviewStallStreak(chain([3, 3, 3, 0, 1])), 1);
});

test("D5: the streak is derived from round_number order, not array order", () => {
  const ascending = chain([2, 2, 2]);
  const shuffled = [ascending[2], ascending[0], ascending[1]];
  assert.equal(deriveReviewStallStreak(shuffled), deriveReviewStallStreak(ascending));
});

test("D5: no route, review_mode or full_reopen_reason exemption exists", () => {
  const bare = chain([2, 2, 2]);
  const labelled = bare.map((round, index) => ({
    ...round,
    review_mode: index === 1 ? "full" : "bounded",
    route: index === 1 ? "full" : "bounded",
    full_reopen_reason: index === 1 ? "handback_authorized_bounded" : null,
  }));
  assert.equal(deriveReviewStallStreak(labelled), deriveReviewStallStreak(bare));
  assert.equal(isReviewStallBudgetExhausted({ rounds: labelled }), true);
});

// --- D4: the cap, and the module's structural constraints ---

test("D4: the cap is 2 and the predicate is exactly streak >= cap", () => {
  assert.equal(REVIEW_STALL_ROUND_CAP, 2);
  assert.equal(isReviewStallBudgetExhausted({ rounds: chain([3, 2, 1]) }), false);
  assert.equal(isReviewStallBudgetExhausted({ rounds: chain([3, 3]) }), false); // streak 1
  assert.equal(isReviewStallBudgetExhausted({ rounds: chain([3, 3, 3]) }), true); // streak 2
});

test("D3/D4: the module is pure — no filesystem or subprocess dependency", () => {
  const source = readFileSync(repoPath(".devpro/scripts/lib/review-stall-budget.mjs"), "utf8");
  const imports = [...source.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s+["']([^"']+)["']/gu)].map((m) => m[1]);
  assert.deepEqual(imports, [], "stall budget must stay import-free");
  assert.equal(source.includes("node:fs"), false);
  assert.equal(source.includes("child_process"), false);
});

test("D4: the cap number 2 lives here and is not restated in the threshold table", () => {
  const source = readFileSync(repoPath(".devpro/scripts/lib/review-stall-budget.mjs"), "utf8");
  assert.match(source, /export const REVIEW_STALL_ROUND_CAP = 2;/u);
  const costBudget = readFileSync(repoPath(".devpro/scripts/lib/cost-budget.mjs"), "utf8");
  assert.equal(
    /stalled_rounds[\s\S]{0,200}?limit:\s*2\b/u.test(costBudget),
    false,
    "COST_BUDGET_THRESHOLDS.stalled_rounds must keep limit: null — the cap is not restated in the table (D4)",
  );
});
