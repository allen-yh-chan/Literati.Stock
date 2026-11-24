import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readSpecWithDelta } from "./lib/spec-delta-reader.mjs";

/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: literal presence and wording of the SQL index-design requirement in
 * `.devpro/agent-rules/database-conventions.md` and the matching spec delta.
 * Does NOT prove: that a created index actually follows the guidance, that a
 * reworded statement carrying the same meaning is judged correctly, or that the
 * carrier has no contradicting passage elsewhere. Review owns that half.
 */
const changeName = "add-sql-index-design-requirement";

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

function assertExcludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(!body.includes(phrase), `unexpected phrase present (regression): ${phrase}`);
  }
}

function assertMatches(body, patterns) {
  for (const pattern of patterns) {
    assert.ok(pattern.test(body), `pattern did not match (mutation hole): ${pattern}`);
  }
}

test("database-conventions.md carries the SQL Index 設計要求", () => {
  const conventions = read(".devpro/agent-rules/database-conventions.md");
  assertIncludes(conventions, [
    "Index 設計要求",
    "correctness-bearing index",
    "程式使用點",
  ]);

  // Structural anchors bound to a single physical line, so a mutation that
  // preserves the individual tokens but breaks how they relate to each other
  // cannot pass (each of these reproduces a real mutation-audit finding).
  assertMatches(conventions, [
    // MUT-B: swapping 被參照端/參照端 (which side needs an existing index vs.
    // gets none) must be caught — bind both halves to the same line.
    /只要求\*\*被參照端\*\*[^\n]*已有既存 unique\/PK index[^\n]*對\*\*參照端\*\*[^\n]*則完全不建 index/,
    // MUT-A: deleting the entire 可追溯 bullet — "程式使用點" alone isn't a
    // unique anchor (it also appears in Exit Criteria), so bind to the
    // bullet's distinguishing clause.
    /\*\*可追溯\*\*：每個 index 對應的程式使用點\*\*必須\*\*寫在 script 檔頭註解或 PR 描述其中之一/,
    // MUT-D: deleting the entire 無需 index 時 bullet had no anchor at all.
    /\*\*無需 index 時\*\*：純寫入或僅按 PK 單筆存取，\*\*必須\*\*在 PR 描述一句交代盤點結論與原因，不得沉默略過/,
  ]);
});

test("code-review-checklist.md carries the SQL Index Coverage sub-check", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  assertIncludes(checklist, [
    "SQL Index Coverage sub-check",
    "database-conventions.md` §Index 設計要求",
    "不要求重新推導 live schema",
    "correctness-bearing index",
  ]);

  assertMatches(checklist, [
    // MUT-C: downgrading the missing-inventory disposition from Important to
    // Suggestion must be caught — "標 **Important**" alone appears 9x in the
    // file, so bind to the specific missing-inventory clause.
    /缺盤點 → 標 \*\*Important\*\*/,
    // I-3: inventory present but NOT self-consistent with the diff must also
    // be Important, not silently unflagged.
    /盤點存在但與 diff 不自洽[^\n]*同樣標 \*\*Important\*\*/,
    // Speculative/preventive index stays Suggestion.
    /預防性 index[^\n]*→ 標 \*\*Suggestion\*\*/,
    // dp-reviewer round-2 Important finding: missing-inventory severity must
    // stay Important even on a hot-path query — no Critical-escalation arm
    // (a prior draft's escalation clause self-contradicted the very next
    // clause and the file's own Critical definition; the fix is to match the
    // same never-escalates formula used by every sibling sub-check in axis 1).
    /\*\*分級預設 Important，不因查詢運行於 hot-path 或高流量路徑就升 Critical\*\*/,
    // I-2 (pre-PR round-3 dp-reviewer): the compressed Load-chain pointer that
    // replaced the FK/correctness-bearing prose must stay bound to its own
    // trigger clause — a bare assertIncludes on the filename alone is already
    // satisfied elsewhere on the same line (the SSOT-citation sentence), so
    // deleting just the pointer clause would leave every other assertion
    // green. Bind the pointer to the 預防性 index clause it qualifies.
    /預防性 index[^\n]*→ 標 \*\*Suggestion\*\*[^\n]*分類判準見[^\n]*database-conventions\.md` §Index 設計要求/,
  ]);
  // Regression guards: neither the removed escalation wording nor its
  // earlier "provably causes" precursor may resurface; nor may the
  // FK/correctness-bearing reasoning that used to duplicate
  // database-conventions.md's own carve-out explanation (pre-pr round-2
  // Suggestion: this sub-check should point at that SSOT, not restate it).
  assertExcludes(checklist, [
    "才升 Critical",
    "provably causes",
    "視為約束本身已隱含使用點，不落入預防性 index 判定",
  ]);
});

test("capability spec delta carries the SQL Index Coverage Sub-check", () => {
  const checklistSpec = readSpecWithDelta("code-review-checklist", { changeName });
  assertIncludes(checklistSpec, ["SQL Index Coverage Sub-check"]);

  // Bound the scenario count to THIS requirement's own section, not the whole
  // union (canonical carries ~290 unrelated scenarios from other requirements;
  // counting against the full union would stay high even if this delta's
  // scenarios were silently deleted — a compensating hole).
  const startMarker = "### Requirement: SQL Index Coverage Sub-check";
  const startIdx = checklistSpec.indexOf(startMarker);
  assert.ok(startIdx !== -1, `missing phrase: ${startMarker}`);
  const rest = checklistSpec.slice(startIdx + startMarker.length);
  const nextReqIdx = rest.indexOf("### Requirement:");
  const section = nextReqIdx === -1 ? rest : rest.slice(0, nextReqIdx);

  // Structural anchors bound to this requirement's own section — the
  // scenario-count floor alone can't catch a deletion that swaps in
  // unrelated filler text of equal scenario count, and a bare-string
  // include() on generic tokens ("Important", "hot path") would match
  // stale wording just as well as the corrected wording.
  assertMatches(section, [
    // I-3: the "present but not self-consistent" scenario must exist with
    // its distinguishing clause — deleting just this scenario while leaving
    // the other 7 intact must be caught (it's the same MUT-D shape: an
    // entire scenario block with no anchor at all).
    /Index inventory present but not self-consistent with the diff is flagged Important/,
    /flag the inconsistency as \*\*Important\*\*/,
    // S-1: Scenario 2's condition must use the aligned wording, not the
    // pre-fix "high-throughput or latency-sensitive hot path".
    /identifies the query as running in a hot path or high-throughput path/,
    // dp-reviewer round-2 Important finding: Scenario 2 must assert the
    // hot-path case stays Important, not escalate to Critical (a prior draft
    // introduced an unauthorized Critical-escalation arm that contradicted
    // the requirement prose's own Critical reservation).
    /SHALL keep the finding at \*\*Important\*\*, not escalate to \*\*Critical\*\*/,
  ]);
  assertExcludes(section, [
    "high-throughput or latency-sensitive hot path",
    "SHALL escalate the finding to **Critical**",
  ]);

  const scenarioCount = section.split("#### Scenario:").length - 1;
  assert.ok(
    scenarioCount >= 8,
    `expected at least 8 "#### Scenario:" occurrences within the SQL Index Coverage Sub-check requirement section, found ${scenarioCount}`,
  );
});
