import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const fallback = readFileSync(
  repoPath(".devpro/agent-rules/code-review-checklist-fallback.md"),
  "utf8"
);

test("TL fallback preserves accident-prevention severity caveat", () => {
  for (const phrase of [
    "Scope caveat — accident-prevention",
    "對抗性 shell 等價 bypass",
    "自然指令",
    "security/compliance",
    "accident-prevention 閘門例外",
  ]) {
    assert.match(fallback, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("TL fallback preserves trajectory sanity inputs from primary checklist", () => {
  for (const phrase of [
    "cross-model review",
    "permission/schema fault",
    "budget exhaustion",
    "error_max_turns",
    "user-visible wasted time",
  ]) {
    assert.match(fallback, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("TL fallback preserves NEW named-def corpus-grep tokens from primary", () => {
  for (const phrase of [
    "NEW named",
    "新具名定義",
    "禁 silent small-diff",
    "任何 PR",
    "範圍",
    "disposition",
  ]) {
    assert.match(fallback, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// design-core.md §11 class two floor ids → the Chinese paraphrase the TL fallback uses for each.
// The fallback paraphrases instead of quoting the kebab ids, so the id set itself is bound here:
// adding/removing a floor id in §11 fails this test until the fallback wording and this map agree.
const CLASS_TWO_FLOOR_FALLBACK_PARAPHRASE = Object.freeze({
  "document-and-payload-privacy": "PII",
  "attribution-and-brand-leak-compliance": "attribution 品牌洩漏",
  "credential-and-secret-handling": "憑證機敏",
  "product-security-scanning": "產品安全掃描",
  "licensing-compliance": "授權合規",
  "gate-visibility": "閘可見性",
});

test("TL fallback class two floor stays bound to design-core §11 floor ids", () => {
  const core = readFileSync(repoPath(".devpro/agent-rules/design-core.md"), "utf8");
  const start = core.indexOf("以下為 **floor 而非窮舉**：");
  assert.notEqual(start, -1, "design-core.md §11 floor heading marker missing");
  const end = core.indexOf("**Residual rule", start);
  assert.ok(end > start, "design-core.md §11 floor table end marker missing");
  const ssotIds = [...core.slice(start, end).matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gmu)].map((m) => m[1]).sort();
  assert.deepEqual(
    ssotIds,
    Object.keys(CLASS_TWO_FLOOR_FALLBACK_PARAPHRASE).sort(),
    "§11 class two floor ids changed: update the TL fallback paraphrase and CLASS_TWO_FLOOR_FALLBACK_PARAPHRASE together",
  );
  for (const [id, paraphrase] of Object.entries(CLASS_TWO_FLOOR_FALLBACK_PARAPHRASE)) {
    assert.ok(fallback.includes(paraphrase), `TL fallback must still name the class two floor item ${id} as "${paraphrase}"`);
  }
  assert.ok(fallback.includes("§11 floor 六項"), "TL fallback must still declare the floor as six items from §11");
});


test("fallback permits classified convergence recovery rather than automatic handback", () => {
  const cadence = fallback.split("## Bounded Review Remediation Routing")[1].split("## Process")[0];
  assert.match(cadence, /cap=3／stall 可收斂時由同 thread focused `convergence_recovery` 繼續（非預設 handback）/);
  assert.doesNotMatch(cadence, /cap=3→handback/);
  assert.match(cadence, /^Post-cap bounded receipt 必須[^\n]*consumed override claim[^\n]*或[^\n]*chain walk[^\n]*convergence_recovery[^\n]*dispatch[^\n]*repair[^\n]*closure/m);
});
