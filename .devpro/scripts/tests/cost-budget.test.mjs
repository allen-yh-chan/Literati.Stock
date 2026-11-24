import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";
import { COST_BUDGET_THRESHOLDS, deriveEffectiveBudgetState, evaluateCostBudget } from "../lib/cost-budget.mjs";
import { stripJsCommentSpans } from "../lib/js-comment-spans.mjs";
import { reviewRoundSidecarPath } from "../hooks/lib/review-round-budget.mjs";

function usage({ output = 0, cache_read = 0, model_time_ms = 0, coverage = "complete" } = {}) {
  return { coverage, totals: { output, cache_read, model_time_ms } };
}

function tempCwd() {
  return mkdtempSync(path.join(tmpdir(), "cost-budget-test-"));
}

function seedRoundState(cwd, prNumber, roundCount) {
  const file = reviewRoundSidecarPath({ cwd, prNumber });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ schema_version: 1, pr_number: String(prNumber), round_count: roundCount, dispatch_lineage: [] })
  );
}

// --- (a)(b)(c) boundary tests (threshold value ±1; strict `>`, so the exact
// limit itself is still "ok") ---

test("threshold (a) output: limit-1 and limit are ok, limit+1 is exceeded", () => {
  const below = evaluateCostBudget({ usage: usage({ output: 799_999 }), prNumber: "none" });
  const at = evaluateCostBudget({ usage: usage({ output: 800_000 }), prNumber: "none" });
  const over = evaluateCostBudget({ usage: usage({ output: 800_001 }), prNumber: "none" });
  assert.equal(below.thresholds.output.state, "ok");
  assert.equal(at.thresholds.output.state, "ok");
  assert.equal(over.thresholds.output.state, "exceeded");
});

test("threshold (b) cache_read: limit-1 and limit are ok, limit+1 is exceeded", () => {
  const below = evaluateCostBudget({ usage: usage({ cache_read: 249_999_999 }), prNumber: "none" });
  const at = evaluateCostBudget({ usage: usage({ cache_read: 250_000_000 }), prNumber: "none" });
  const over = evaluateCostBudget({ usage: usage({ cache_read: 250_000_001 }), prNumber: "none" });
  assert.equal(below.thresholds.cache_read.state, "ok");
  assert.equal(at.thresholds.cache_read.state, "ok");
  assert.equal(over.thresholds.cache_read.state, "exceeded");
});

test("threshold (c) model_time: limit-1 and limit (6h in ms) are ok, limit+1 is exceeded", () => {
  const below = evaluateCostBudget({ usage: usage({ model_time_ms: 21_599_999 }), prNumber: "none" });
  const at = evaluateCostBudget({ usage: usage({ model_time_ms: 21_600_000 }), prNumber: "none" });
  const over = evaluateCostBudget({ usage: usage({ model_time_ms: 21_600_001 }), prNumber: "none" });
  assert.equal(below.thresholds.model_time.state, "ok");
  assert.equal(at.thresholds.model_time.state, "ok");
  assert.equal(over.thresholds.model_time.state, "exceeded");
});

// fix-second-review-loop-friction T1/R1 prove-it (D13 P5, half 1; design.md
// D1; workflow-cost-controls ADDED "Pr-Sticky Round Extension Has A Single
// Unlock", scenario "Cost evaluation never reports a round threshold"): GREEN
// since R1 (D1) removed the fifth key, `round`, and the mirror predicate it
// used to call. `prNumber`/`cwd` below are vestigial — `evaluateCostBudget`
// no longer accepts them — kept only because the seeded sidecar state (at
// the pr-sticky round cap) is what the scenario's own GIVEN names; passing
// them is harmless (extra destructured properties are simply unused).
test("Scenario: Cost evaluation never reports a round threshold", () => {
  assert.deepEqual(
    Object.keys(COST_BUDGET_THRESHOLDS),
    ["output", "cache_read", "model_time", "stalled_rounds"],
    "COST_BUDGET_THRESHOLDS must contain exactly these four keys; base still has a fifth key, round",
  );
  const cwd = tempCwd();
  seedRoundState(cwd, "123", 3);
  const atCap = evaluateCostBudget({ usage: usage(), prNumber: "123", cwd });
  assert.equal(Object.hasOwn(atCap.thresholds, "round"), false, "thresholds must not contain a round key, even at the cap");
  assert.equal(atCap.exceeded_thresholds.includes("round"), false, "exceeded_thresholds must never contain round");
});

// --- (a)(b)(c) malformed input resolves unavailable, never a silent 0/ok ---

test("threshold (a)/(b)/(c) resolve unavailable (not silently 0/ok) when a total is not a finite number", () => {
  const result = evaluateCostBudget({ usage: { totals: {} }, prNumber: "none" });
  assert.equal(result.thresholds.output.state, "unavailable");
  assert.equal(result.thresholds.output.value, null);
  assert.equal(result.thresholds.cache_read.state, "unavailable");
  assert.equal(result.thresholds.model_time.state, "unavailable");
  assert.equal(result.exceeded, false);
  assert.deepEqual(result.exceeded_thresholds, []);
});

// --- F-5-3: partial coverage must never exempt an already-exceeded total ---

test("F-5-3: coverage partial with already-exceeded partial totals is still judged exceeded", () => {
  const result = evaluateCostBudget({
    usage: usage({ output: 900_000, coverage: "partial" }),
    prNumber: "none",
  });
  assert.equal(result.thresholds.output.state, "exceeded");
  assert.ok(result.exceeded);
  assert.ok(result.exceeded_thresholds.includes("output"));
});

// --- aggregate exceeded / exceeded_thresholds ---

test("exceeded_thresholds names exactly the exceeded keys, others absent", () => {
  const result = evaluateCostBudget({
    usage: usage({ output: 900_000, cache_read: 10 }),
    prNumber: "none",
  });
  assert.deepEqual(result.exceeded_thresholds, ["output"]);
  assert.equal(result.exceeded, true);
});

test("no threshold exceeded resolves exceeded=false and empty exceeded_thresholds", () => {
  const result = evaluateCostBudget({ usage: usage(), prNumber: "none" });
  assert.equal(result.exceeded, false);
  assert.deepEqual(result.exceeded_thresholds, []);
});

// --- D11 point 1: table keys are byte-exact, no second naming scheme ---

test("D10/D1 table keys are byte-exact: output, cache_read, model_time, stalled_rounds (round removed by fix-second-review-loop-friction R1)", () => {
  assert.deepEqual(Object.keys(COST_BUDGET_THRESHOLDS), ["output", "cache_read", "model_time", "stalled_rounds"]);
});

// --- grep-lock: threshold constants have exactly one copy in the repo ---

function walkMjsFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

function standaloneLiteralRegex(literal) {
  return new RegExp(`(?<![0-9_])${literal}(?![0-9_])`);
}

test("grep-lock: 800_000 / 250_000_000 / 21_600_000 threshold literals appear nowhere outside cost-budget.mjs (and its own boundary tests)", () => {
  const scriptsDir = repoPath(".devpro/scripts");
  const exemptBasenames = new Set(["cost-budget.mjs", "cost-budget.test.mjs"]);
  const literals = ["800_000", "250_000_000", "21_600_000"];
  const offenders = [];
  for (const file of walkMjsFiles(scriptsDir)) {
    if (exemptBasenames.has(path.basename(file))) continue;
    const content = readFileSync(file, "utf8");
    for (const literal of literals) {
      if (standaloneLiteralRegex(literal).test(content)) offenders.push(`${file}: ${literal}`);
    }
  }
  assert.deepEqual(offenders, [], `second copy of a cost-budget threshold literal found: ${offenders.join(", ")}`);
});

// --- D2: PR_STICKY_REVIEW_ROUND_CAP never imported/referenced by this change ---

test("cost-budget.mjs never imports or references PR_STICKY_REVIEW_ROUND_CAP as code (D2)", () => {
  const content = readFileSync(repoPath(".devpro/scripts/lib/cost-budget.mjs"), "utf8");
  // Strip comments before asserting: D2's own docblock names the constant in
  // prose to explain why it is deliberately NOT imported — that mention is
  // the documentation of the constraint, not a violation of it. The
  // operative check is that no CODE token (import specifier, identifier
  // reference, re-export) ever names it.
  // Lexical strip (not naive regex): string/template/regex bodies must not
  // swallow or invent tokens. Shared helper from fix-guard-scope-fidelity.
  const codeOnly = stripJsCommentSpans(content);
  assert.doesNotMatch(codeOnly, /PR_STICKY_REVIEW_ROUND_CAP/);
});

test("D2 comment-strip teeth: prose-only naming of PR_STICKY_REVIEW_ROUND_CAP is not a code hit", () => {
  const fixture = [
    "/** doc names PR_STICKY_REVIEW_ROUND_CAP in prose only */",
    "export const ok = 1;",
    "// also PR_STICKY_REVIEW_ROUND_CAP in a line comment",
  ].join("\n");
  assert.doesNotMatch(stripJsCommentSpans(fixture), /PR_STICKY_REVIEW_ROUND_CAP/);
  // Negative control: a real identifier reference must still match after strip.
  const withCode = 'const PR_STICKY_REVIEW_ROUND_CAP = 1;\n';
  assert.match(stripJsCommentSpans(withCode), /PR_STICKY_REVIEW_ROUND_CAP/);
});

// --- D8 (strengthen-subagent-delegation-strategy T13): `budget_state` four
// states + coverage priority, derived on the existing evaluator's return
// object. Priority is literal V3.2 §8 / design D8: (1) any numeric ≥ limit →
// `exhausted` regardless of coverage; (2) else any numeric ≥ 50% of its
// limit → `at-or-above-half` regardless of coverage; (3) else all three
// numerics finite AND coverage `complete` → `below-half`; (4) otherwise
// `unavailable`. `stalled_rounds` is excluded from half-state. Exit code
// semantics of `--budget-check` are untouched (the tests above are the
// regression guard for that). ---

const HALF_OUTPUT = COST_BUDGET_THRESHOLDS.output.limit / 2;
const HALF_CACHE = COST_BUDGET_THRESHOLDS.cache_read.limit / 2;
const HALF_MODEL = COST_BUDGET_THRESHOLDS.model_time.limit / 2;

test("D8 budget_state: coverage × threshold table (six combinations)", () => {
  const cases = [
    // [label, usage, expected budget_state]
    ["complete, all three <50%", usage({ output: HALF_OUTPUT - 1, cache_read: HALF_CACHE - 1, model_time_ms: HALF_MODEL - 1, coverage: "complete" }), "below-half"],
    ["complete, one ≥50%", usage({ output: HALF_OUTPUT, coverage: "complete" }), "at-or-above-half"],
    ["complete, one ≥100%", usage({ cache_read: COST_BUDGET_THRESHOLDS.cache_read.limit, coverage: "complete" }), "exhausted"],
    ["partial, all three <50%", usage({ output: HALF_OUTPUT - 1, cache_read: HALF_CACHE - 1, model_time_ms: HALF_MODEL - 1, coverage: "partial" }), "unavailable"],
    ["partial, one ≥50%", usage({ model_time_ms: HALF_MODEL, coverage: "partial" }), "at-or-above-half"],
    ["partial, one ≥100%", usage({ output: COST_BUDGET_THRESHOLDS.output.limit, coverage: "partial" }), "exhausted"],
  ];
  for (const [label, input, expected] of cases) {
    const result = evaluateCostBudget({ usage: input, prNumber: "none" });
    assert.equal(result.budget_state, expected, label);
    assert.equal(result.coverage, input.coverage, `${label}: coverage passthrough`);
  }
});

test("D8 budget_state: `exhausted` uses ≥ limit (limit itself), while threshold state keeps strict > (limit itself is still ok)", () => {
  const at = evaluateCostBudget({ usage: usage({ output: COST_BUDGET_THRESHOLDS.output.limit }), prNumber: "none" });
  assert.equal(at.budget_state, "exhausted");
  assert.equal(at.thresholds.output.state, "ok");
  assert.equal(at.exceeded, false, "exit-code path (exceeded) is unchanged by budget_state");
});

test("D8 budget_state: non-finite numerics or unknown coverage → unavailable; exhausted still wins over unavailable input", () => {
  const malformed = evaluateCostBudget({ usage: { coverage: "complete", totals: { output: undefined, cache_read: 1, model_time_ms: 1 } }, prNumber: "none" });
  assert.equal(malformed.budget_state, "unavailable");
  const unknownCoverage = evaluateCostBudget({ usage: { totals: { output: 1, cache_read: 1, model_time_ms: 1 } }, prNumber: "none" });
  assert.equal(unknownCoverage.coverage, "unknown");
  assert.equal(unknownCoverage.budget_state, "unavailable");
  const mixed = evaluateCostBudget({ usage: { coverage: "partial", totals: { output: COST_BUDGET_THRESHOLDS.output.limit + 5, cache_read: undefined, model_time_ms: 0 } }, prNumber: "none" });
  assert.equal(mixed.budget_state, "exhausted");
});

// --- D23/D24 (strengthen-subagent-delegation-strategy): the user's exact-set
// threshold override never rewrites budget_state; it excludes the approved
// thresholds and re-derives with the same D8 priority.
test("D24 deriveEffectiveBudgetState: excludes only the approved thresholds and keeps the D8 priority", () => {
  const out = COST_BUDGET_THRESHOLDS.output.limit;
  const cache = COST_BUDGET_THRESHOLDS.cache_read.limit;
  const time = COST_BUDGET_THRESHOLDS.model_time.limit;
  const exhausted = evaluateCostBudget({ usage: { coverage: "complete", totals: { output: out + 1, cache_read: Math.floor(cache * 0.4), model_time_ms: Math.floor(time * 0.6) } }, prNumber: null });
  assert.equal(exhausted.budget_state, "exhausted");
  assert.equal(deriveEffectiveBudgetState(exhausted, ["output"]), "at-or-above-half", "model_time still at or above half");
  assert.equal(deriveEffectiveBudgetState(exhausted, []), "exhausted", "nothing approved → raw state");
  assert.equal(deriveEffectiveBudgetState(exhausted, ["output", "model_time"]), "below-half", "remaining measured value below half with complete coverage");
  assert.equal(deriveEffectiveBudgetState(exhausted, ["output", "cache_read", "model_time"]), "unavailable", "nothing left measured is not below-half");
  assert.equal(deriveEffectiveBudgetState({ ...exhausted, coverage: "partial" }, ["output", "model_time"]), "unavailable", "partial coverage withholds below-half");
  assert.equal(deriveEffectiveBudgetState(exhausted, ["round", "bogus"]), "exhausted", "non-numeric or unknown keys change nothing");
  assert.equal(exhausted.budget_state, "exhausted", "input budget is not mutated");
});

// workflow-cost-controls ADDED "Round Override Consumption Is Recorded For
// Disclosure" (fix-second-review-loop-friction D8): `review_round` is never a
// cost override key or waiver — a checkpoint `overrides[]` entry naming it is
// disclosure-only (D6/D7), and passing "review_round" to
// deriveEffectiveBudgetState's excluded set MUST have no effect at all
// (structurally guaranteed: only `output`/`cache_read`/`model_time` ever
// leave the derivation — see the function's own `remaining` filter, which
// never consults an arbitrary key name beyond that fixed three-item list).
test("Scenario: review_round is never a cost override key or waiver", () => {
  const out = COST_BUDGET_THRESHOLDS.output.limit;
  const exhausted = evaluateCostBudget({
    usage: { coverage: "complete", totals: { output: out + 1, cache_read: 0, model_time_ms: 0 } },
    prNumber: null,
  });
  assert.equal(exhausted.budget_state, "exhausted");
  assert.equal(
    deriveEffectiveBudgetState(exhausted, ["review_round"]),
    "exhausted",
    "review_round MUST NOT enter the exclusion set; the effective state must equal the raw exhausted state",
  );
  assert.deepEqual(
    deriveEffectiveBudgetState(exhausted, ["review_round"]),
    deriveEffectiveBudgetState(exhausted, []),
    "declaring review_round must be identical to declaring no override at all",
  );
});

// --- threshold (e) `stalled_rounds` (fix-zero-value-review-rounds R3) ---
// D10: `not-applicable` is an invariant, not an implementation detail. The
// first test below is the one that lets every existing caller stay untouched.

test("stalled_rounds: omitting the observation is not-applicable, and leaves every other caller bit-identical", () => {
  const cwd = tempCwd();
  const args = { usage: usage({ output: COST_BUDGET_THRESHOLDS.output.limit + 1 }), prNumber: null, cwd };
  const before = evaluateCostBudget(args);
  assert.deepEqual(before.thresholds.stalled_rounds, { value: null, limit: null, state: "not-applicable" });
  // Not-applicable is excluded from exceeded_thresholds, so a caller with no
  // receipt-chain concept sees the same set, the same boolean and the same
  // half-state it saw before this threshold existed.
  assert.deepEqual(before.exceeded_thresholds, ["output"]);
  assert.equal(before.exceeded, true);
  assert.equal(before.budget_state, "exhausted");
  // Explicit null is the same as omitted: `post-pr-cost-circuit-breaker.mjs`
  // and `render-second-review-packet.mjs` pass neither.
  const explicitNull = evaluateCostBudget({ ...args, reviewStall: null });
  assert.deepEqual(explicitNull.thresholds, before.thresholds);
  assert.deepEqual(explicitNull.exceeded_thresholds, before.exceeded_thresholds);
});

test("stalled_rounds: the four observation states map to the four threshold states, exhausted becoming exceeded", () => {
  const cwd = tempCwd();
  const evaluate = (reviewStall) => evaluateCostBudget({ usage: usage(), prNumber: null, reviewStall, cwd });

  // Zero receipts: nothing SHOULD have been read. A change that has never run
  // a review round must not be blocked by a stall it cannot have produced.
  const none = evaluate({ state: "not-applicable", streak: null });
  assert.deepEqual(none.thresholds.stalled_rounds, { value: null, limit: null, state: "not-applicable" });
  assert.deepEqual(none.exceeded_thresholds, []);

  // Read and verified, under cap: the streak itself is the reported value —
  // this threshold's value is an integer, unlike `round`'s boolean.
  const ok = evaluate({ state: "ok", streak: 1 });
  assert.deepEqual(ok.thresholds.stalled_rounds, { value: 1, limit: null, state: "ok" });
  assert.deepEqual(ok.exceeded_thresholds, []);

  // `exhausted` is review-stall-budget.mjs's word; `exceeded` is this table's.
  const exhausted = evaluate({ state: "exhausted", streak: 2 });
  assert.deepEqual(exhausted.thresholds.stalled_rounds, { value: 2, limit: null, state: "exceeded" });
  assert.deepEqual(exhausted.exceeded_thresholds, ["stalled_rounds"]);
  assert.equal(exhausted.exceeded, true);

  // Receipts exist but the chain would not load or verify: something that
  // SHOULD have been read could not be. Excluded from exceeded_thresholds
  // here, and semantically distinct from `not-applicable` above — the whole
  // point of the change is that a broken input must not read as a clean one.
  const unavailable = evaluate({ state: "unavailable", streak: null });
  assert.deepEqual(unavailable.thresholds.stalled_rounds, { value: null, limit: null, state: "unavailable" });
  assert.deepEqual(unavailable.exceeded_thresholds, []);
  assert.equal(unavailable.exceeded, false);
});

test("stalled_rounds: an unrecognized or malformed observation degrades to unavailable, never to ok", () => {
  const cwd = tempCwd();
  const evaluate = (reviewStall) => evaluateCostBudget({ usage: usage(), prNumber: null, reviewStall, cwd }).thresholds.stalled_rounds;
  // Same fail-closed direction as evaluateNumericThreshold's non-finite guard:
  // a shape this module does not understand must not read as "nothing wrong".
  for (const bad of [{}, { state: "OK" }, { state: null }, { state: "exceeded" }, "exhausted", 2]) {
    assert.equal(evaluate(bad).state, "unavailable", `${JSON.stringify(bad)} must not be trusted`);
  }
  // A verified state with a junk streak still reports the state; only the
  // number is withheld, because the state is what gates and the streak is
  // diagnostic.
  assert.deepEqual(evaluate({ state: "exhausted", streak: "2" }), { value: null, limit: null, state: "exceeded" });
});

test("stalled_rounds does not participate in half-state: an exceeded stall changes neither budget_state nor budget_state_effective", () => {
  const cwd = tempCwd();
  // Every numeric below half with complete coverage — the one input shape that
  // can produce `below-half`, and therefore the one that detects a fifth key
  // wrongly added to deriveEffectiveBudgetState's list: its ratio is null, so
  // the "every remaining numeric measured" clause would fail and the state
  // would silently become `unavailable`.
  const totals = {
    output: Math.floor(COST_BUDGET_THRESHOLDS.output.limit * 0.1),
    cache_read: Math.floor(COST_BUDGET_THRESHOLDS.cache_read.limit * 0.1),
    model_time_ms: Math.floor(COST_BUDGET_THRESHOLDS.model_time.limit * 0.1),
  };
  const args = { usage: { coverage: "complete", totals }, prNumber: null, cwd };
  const stalled = evaluateCostBudget({ ...args, reviewStall: { state: "exhausted", streak: 9 } });
  assert.equal(stalled.thresholds.stalled_rounds.state, "exceeded", "the stall really is exceeded in this fixture");
  assert.equal(stalled.budget_state, "below-half", "D11: the stall signal changes no half-state");
  assert.equal(evaluateCostBudget(args).budget_state, "below-half", "and it is the same state the fixture has without any stall");
  assert.equal(deriveEffectiveBudgetState(stalled, []), "below-half");
  assert.equal(deriveEffectiveBudgetState(stalled, ["stalled_rounds"]), "below-half", "approving it changes nothing either");
});
