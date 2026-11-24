import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

// Cross-carrier lock (pre-merge cross-model review finding): the mini/full
// design watershed bar MUST agree between the rule leaf
// (.devpro/agent-rules/chore-classification.md) and the promoted canonical
// spec (openspec/specs/openspec-flow/spec.md "One-Sentence Design Mini/Full
// Threshold" requirement). After #2503 the bar is behavior-affecting
// trade-offs only: "one sentence with no behavior-affecting trade-off
// comparison → mini; comparing two or more options that affect external
// behavior, capability contract, or callers → escalate to full-B".
// Test-carrier / naming / file-location options MUST NOT alone escalate.
//
// HARDENED after a cross-model second-opinion WARN: the original version of
// this guard used whole-file `includes()` checks plus historical-form
// negative regexes. That could NOT localize threshold drift — mutating any
// single operative line still passed, because the other operative lines
// (which restate the same tokens elsewhere in the file) kept the whole-file
// `includes()` checks green, and the negative regexes only matched the exact
// historical "≥3 個 alternative" wording. Proven: drifting the mini-bar line
// to "比較少於三個選項（≤2 方案仍走單道）" passed all of the old tests.
//
// This version instead locks each of the FIVE operative statements
// individually (as exact, mutually-distinct substrings of the rule leaf) and
// proves — for a realistic drift at each one — that (a) the drift IS caught,
// and (b) ONLY that one spot is flagged. That makes the guard line-localized
// instead of whole-file, so a single-line mutation anywhere in the watershed
// text cannot slip through.



// The five operative compounds that together carry the mini/full design
// watershed bar in chore-classification.md. Each is an exact, distinctive
// substring of the live file (verified via `grep -F` before landing this
// test) and none is a substring of another, so each independently localizes
// to its own spot in the file.
const OPERATIVE_COMPOUNDS = {
  L30_MINI: "一句話可陳述；無行為相關 trade-off 比較（單一方案）", // 判斷量表 B-mini cell (mini bar)
  L30_FULL: "需 architect 比較兩個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off）", // 判斷量表 B cell (full-B trigger)
  L66: "比較兩個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off）時升 full B", // Rule-feedback B-mini 子路徑 escalation
  L70: "無行為相關 trade-off 比較（單一方案，不比較行為相關選項）", // 一句話設計 § (mini bar)
  L72: "需比較兩個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off），**即升 full B**", // 逃生口 guard (full-B trigger)
};

function missingCompounds(text) {
  return Object.values(OPERATIVE_COMPOUNDS).filter((c) => !text.includes(c));
}

test("chore-classification.md carries all five operative watershed statements intact", () => {
  const rule = read(".devpro/agent-rules/chore-classification.md");
  assert.deepEqual(
    missingCompounds(rule),
    [],
    "every operative watershed statement must be present verbatim in chore-classification.md",
  );
});

// Realistic drift variants: each loosens the threshold either by widening
// "兩個以上" (two or more) to "三個以上" (three or more), or — for the
// no-trade-off mini phrase — by restating it as the historical
// "比較少於三個選項" (fewer than three options) miscount. Each drift MUST
// actually remove its exact compound (guarded below) and, when spliced into
// the real file, MUST be caught — and ONLY at its own spot.
const DRIFT_TABLE = [
  {
    name: "L30_MINI",
    compound: OPERATIVE_COMPOUNDS.L30_MINI,
    drift: "一句話可陳述；比較少於三個選項（單一方案）",
  },
  {
    name: "L30_FULL",
    compound: OPERATIVE_COMPOUNDS.L30_FULL,
    drift: "需 architect 比較三個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off）",
  },
  {
    name: "L66",
    compound: OPERATIVE_COMPOUNDS.L66,
    drift: "比較三個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off）時升 full B",
  },
  {
    name: "L70",
    compound: OPERATIVE_COMPOUNDS.L70,
    drift: "比較少於三個選項（≤2 方案仍走單道）",
  },
  {
    name: "L72",
    compound: OPERATIVE_COMPOUNDS.L72,
    drift: "需比較三個以上會影響外部行為、capability contract 或呼叫方的選項（行為相關 trade-off），**即升 full B**",
  },
];

for (const { name, compound, drift } of DRIFT_TABLE) {
  test(`chore-classification.md drift at ${name} is caught and localized to only ${name}`, () => {
    assert.notEqual(drift, compound, `${name} drift fixture must actually differ from the compound`);
    const rule = read(".devpro/agent-rules/chore-classification.md");
    const mutated = rule.replace(compound, drift);
    assert.notEqual(mutated, rule, `${name} drift must actually change the file content (compound must be present verbatim)`);

    const missing = missingCompounds(mutated);
    assert.ok(missing.includes(compound), `drift at ${name} must be caught (the compound must be reported missing)`);
    assert.deepEqual(missing, [compound], `drift at ${name} must be localized — ONLY ${name} should be flagged, not the whole file`);
  });
}

test("chore-classification.md does NOT flag the unrelated ≥2 capability-spec size clause", () => {
  const rule = read(".devpro/agent-rules/chore-classification.md");
  const sizeClauseMatch = rule.match(/≥\s*2\s*個\s*capability\s*spec/);
  assert.ok(sizeClauseMatch, "sanity check: the ≥2 capability-spec size clause must still be present");
  // The size clause is a distinct axis (capability-spec count) from the
  // design-depth watershed bar — it must not equal or contain any of the
  // five operative compounds above.
  for (const [name, compound] of Object.entries(OPERATIVE_COMPOUNDS)) {
    assert.ok(
      !sizeClauseMatch[0].includes(compound) && sizeClauseMatch[0] !== compound,
      `the ≥2 capability-spec size clause must not overlap with the ${name} design-depth compound`,
    );
  }
});

// Historical-form regression pin, slimmed to the one drift that actually
// triggered this guard. The real drift defense is the localization tests
// above (positive + per-compound mutation); this just pins the specific
// historical wording so it can never silently reappear.
test("chore-classification.md does NOT restate the mini/full design watershed as a ≥3-alternatives bar", () => {
  const rule = read(".devpro/agent-rules/chore-classification.md");
  assert.doesNotMatch(
    rule,
    /≥\s*3\s*個\s*alternative/,
    "chore-classification.md must not contain a ≥3-alternatives watershed bar; the escalation trigger is \"two or more options / any trade-off\", never a ≥3 count",
  );
});

test("chore-classification.md excludes test-carrier/naming/file-location from trade-off escalation alone", () => {
  const rule = read(".devpro/agent-rules/chore-classification.md");
  assert.match(rule, /測試載體選擇、命名、檔案位置/);
  assert.match(rule, /MUST NOT 單獨觸發升 full B/);
});

test("openspec-flow spec's One-Sentence Design Mini/Full Threshold requirement agrees with the rule leaf's bar (bidirectional lock)", () => {
  const spec = read("openspec/specs/openspec-flow/spec.md");
  const headingMarker = "### Requirement: One-Sentence Design Mini/Full Threshold";
  const headingIndex = spec.indexOf(headingMarker);
  assert.ok(headingIndex >= 0, "openspec-flow spec.md must contain the One-Sentence Design Mini/Full Threshold requirement heading");

  // Scope to the requirement block: from this heading to the next "### Requirement:"
  // heading, or end of file if this is the last requirement.
  const nextHeadingIndex = spec.indexOf("### Requirement:", headingIndex + headingMarker.length);
  const requirementBlock = nextHeadingIndex >= 0
    ? spec.slice(headingIndex, nextHeadingIndex)
    : spec.slice(headingIndex);

  assert.ok(
    requirementBlock.includes("two or more options"),
    "One-Sentence Design Mini/Full Threshold requirement block must contain the literal phrase 'two or more options' (full-B escalation trigger)",
  );
  assert.ok(
    requirementBlock.includes("no behavior-affecting trade-off comparison"),
    "One-Sentence Design Mini/Full Threshold requirement block must contain the literal phrase 'no behavior-affecting trade-off comparison' (mini-path bar)",
  );
  assert.ok(
    requirementBlock.includes("test-carrier"),
    "One-Sentence Design Mini/Full Threshold requirement block must exclude test-carrier comparisons from alone escalating",
  );
});
