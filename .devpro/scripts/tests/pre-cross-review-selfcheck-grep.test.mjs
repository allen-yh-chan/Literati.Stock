import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";

// Extract the 送 Cross-Review 前自驗清單 section body so assertions stay scoped to
// the list, not a stray match elsewhere in the file.
function selfCheckSection(text) {
  const m = text.match(/#### 送 Cross-Review 前自驗清單([\s\S]*?)(?=\n#### |\n### |\n## |$)/);
  assert.ok(m, "送 Cross-Review 前自驗清單 section not found");
  return m[1];
}

// Each item: a display label that must appear AND the SSOT leaf it must point to.
// Keeping the SSOT pointers here (not the rule content) is the whole design:
// the checklist is an index; content lives in each SSOT. (enforce-pre-cross-review-selfcheck R2)
// 選項對齊 NOT here on purpose: it belongs to in-conversation stop-and-ask, not to
// pre-cross-review (which审 the code diff). Its SSOT is stop-point-comms.md + AGENTS
// §0 Always; duplicating it into this list would scatter the SSOT. (user-flagged)
const ITEMS = [
  { label: "內部一致性", ssot: "rules-consistency-checklist.md" },
  { label: "負向測試", ssot: "testing-and-qa.md" },
  { label: "proposal 不 overclaim", ssot: "overclaim" }, // points to in-file 軸 2 sub-check
  { label: "cite 正確", ssot: "pr-review-evidence-verification.md" },
];

test("pre-cross-review self-check list exists with all items", () => {
  const body = selfCheckSection(read(CHECKLIST));
  for (const { label } of ITEMS) {
    assert.ok(body.includes(label), `self-check list missing item: ${label}`);
  }
  // Guard the scoping decision: 選項對齊 must NOT be in this list (its場景 is
  // in-conversation stop-and-ask, not pre-cross-review). Prevents re-scatter.
  assert.ok(!body.includes("選項對齊"), "選項對齊 belongs to stop-point-comms, not the pre-cross-review list");
});

test("each self-check item points to its SSOT (index, not duplicated content)", () => {
  const body = selfCheckSection(read(CHECKLIST));
  for (const { label, ssot } of ITEMS) {
    assert.ok(
      body.includes(ssot),
      `item "${label}" must point to its SSOT (${ssot}) — checklist is an index, not a rewrite`,
    );
  }
});

test("self-check list states cross-review is the LAST gate, not the first error-catch", () => {
  const body = selfCheckSection(read(CHECKLIST));
  assert.match(body, /最後一道確認/, "must frame cross-review as the last confirmation");
  assert.match(body, /索引/, "must declare itself an index (SSOT not duplicated here)");
});

// Negative test (in-memory mutation, real file untouched): removing an item's SSOT
// pointer MUST fail the index assertion — proving it guards the pointers, not just
// that the section exists. (R4)
test("self-check assertion FAILS when an SSOT pointer is removed (negative)", () => {
  const body = selfCheckSection(read(CHECKLIST));
  const mutated = body.replace(/rules-consistency-checklist\.md/g, "");
  assert.throws(() => {
    for (const { label, ssot } of ITEMS) {
      assert.ok(mutated.includes(ssot), `item "${label}" must point to ${ssot}`);
    }
  }, "removing a SSOT pointer must break the index assertion (else it is a rubber stamp)");
});
