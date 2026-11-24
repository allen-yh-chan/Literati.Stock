/**
 * pre-implementation-over-design-grep.test.mjs
 *
 * Locks the integrity of `pre-implementation-over-design.md` and its anchors:
 *
 * (a) New leaf contains ### Preparatory Refactoring, Two-Hats keywords, and
 *     Kent Beck "make the change easy" literal.
 * (b) 4 cross-ref leaf names present in the new leaf.
 * (c) Pre-implementation anchor in two places: openspec-step-1-to-9.md and
 *     dp-programmer.md.
 * (d) code-simplification.md extraction completeness: audit table keywords
 *     are 0 residual, and cross-ref to new leaf is present.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readRepoFile as read } from "./lib/read.mjs";



const leaf = read(".devpro/agent-rules/pre-implementation-over-design.md");
const codeSimplification = read(".devpro/agent-rules/code-simplification.md");
const stepDoc = read(".devpro/agent-rules/openspec-step-1-to-9.md");
const programmer = read(".claude/agents/dp-programmer.md");

test("reader load and behavior equivalence govern simplification", () => {
  assert.match(codeSimplification, /追蹤層數[^\n]*隱藏／可變狀態/);
  assert.match(codeSimplification, /MUST 先固定可觀察行為/);
  assert.match(codeSimplification, /MUST 先裁決契約與現況的差異，不得自行把已知缺陷修復夾進純重構/);
  assert.match(codeSimplification, /超出純重構的行為差異 MUST 取得使用者明示決定後才套用/);
  assert.match(codeSimplification, /MUST NOT 僅因 caller 數或重複次數強制拆合/);
  assert.match(leaf, /單一 caller 仍可保留有價值的邊界/);
});

test("historical count-only extraction rules stay rejected while legitimate heuristics remain valid", () => {
  const oldRules = [
    "第三處出現時**必須**抽取",
    "inline 直到 ≥ 2 處重複",
    "inline；等第二個真實用戶出現再抽象",
  ];
  const forbidden = /第三處出現時\*\*必須\*\*抽取|inline 直到 ≥ 2 處重複|inline；等第二個真實用戶出現再抽象/;
  for (const old of oldRules) assert.match(old, forbidden);
  assert.doesNotMatch("第三處出現時仍評估知識 ownership；單一 caller 的授權邊界可保留。", forbidden);
  assert.doesNotMatch(codeSimplification, forbidden);
  assert.doesNotMatch(leaf, forbidden);
});

// ── (a) New leaf section structure and key phrases ────────────────────────────

test("pre-implementation-over-design.md 含 ### Preparatory Refactoring heading", () => {
  assert.ok(
    leaf.includes("### Preparatory Refactoring"),
    "### Preparatory Refactoring heading missing from pre-implementation-over-design.md"
  );
});

test("pre-implementation-over-design.md 含 Two-Hats 關鍵詞「重構帽」和「加功能帽」", () => {
  assert.ok(
    leaf.includes("重構帽"),
    "「重構帽」missing — Two-Hats discipline weakened"
  );
  assert.ok(
    leaf.includes("加功能帽"),
    "「加功能帽」missing — Two-Hats discipline weakened"
  );
});

test("pre-implementation-over-design.md 含 Kent Beck 引言 'make the change easy'", () => {
  assert.ok(
    leaf.includes("make the change easy"),
    "'make the change easy' literal missing — Kent Beck core principle removed"
  );
});

test("pre-implementation-over-design.md 含向前看/向後看界定詞", () => {
  assert.ok(
    leaf.includes("向後看"),
    "「向後看」missing — 向前看 vs 向後看 distinction removed"
  );
  assert.ok(
    leaf.includes("向前看"),
    "「向前看」missing — 向前看 vs 向後看 distinction removed"
  );
});

test("pre-implementation-over-design.md 含兩頂帽子不可同時戴條文", () => {
  assert.ok(
    leaf.includes("兩頂帽子不可同時戴"),
    "「兩頂帽子不可同時戴」missing — Two-Hats core constraint removed"
  );
});

test("pre-implementation-over-design.md 含 Simplicity Ladder 與 Bounded Shortcut Evidence anchors", () => {
  assert.ok(
    leaf.includes("### Simplicity Ladder"),
    "Simplicity Ladder anchor missing"
  );
  assert.ok(
    leaf.includes("### Bounded Shortcut Evidence"),
    "Bounded Shortcut Evidence anchor missing"
  );
  for (const phrase of [
    "標準庫",
    "平台原生",
    "已安裝依賴",
    "upgrade trigger",
    "carrier",
  ]) {
    assert.ok(leaf.includes(phrase), `simplicity guidance missing phrase: ${phrase}`);
  }
});

test("pre-implementation-over-design.md 簡化規則保留安全與正確性 guardrails", () => {
  for (const phrase of [
    "trust-boundary validation",
    "data-loss prevention",
    "security",
    "accessibility",
    "correctness checks",
  ]) {
    assert.ok(leaf.includes(phrase), `guardrail phrase missing: ${phrase}`);
  }
});

// ── (b) 4 cross-ref leaf names ────────────────────────────────────────────────

test("pre-implementation-over-design.md cross-ref 含 testing-and-qa.md", () => {
  assert.ok(
    leaf.includes("testing-and-qa.md"),
    "cross-ref to testing-and-qa.md missing"
  );
});

test("pre-implementation-over-design.md cross-ref 含 ai-autonomy-root-cause.md (Root-Cause First)", () => {
  assert.ok(
    leaf.includes("ai-autonomy-root-cause.md"),
    "cross-ref to ai-autonomy-root-cause.md missing"
  );
  assert.ok(
    leaf.includes("Root-Cause First"),
    "§Root-Cause First reference missing from ai-autonomy-root-cause cross-ref"
  );
});

test("pre-implementation-over-design.md cross-ref 含 preflight-checklist.md", () => {
  assert.ok(
    leaf.includes("preflight-checklist.md"),
    "cross-ref to preflight-checklist.md missing"
  );
});

// ── (c) Pre-implementation anchor in two places ───────────────────────────────

test("openspec-step-1-to-9.md 含 pre-implementation-over-design 開工前錨 (≥1)", () => {
  const count = (stepDoc.match(/pre-implementation-over-design/g) || []).length;
  assert.ok(
    count >= 1,
    `pre-implementation-over-design anchor not found in openspec-step-1-to-9.md (found ${count})`
  );
});

test("openspec-step-1-to-9.md Step 3a 段含 pre-implementation-over-design 錨", () => {
  assert.ok(
    stepDoc.includes("Step 3a") && stepDoc.includes("pre-implementation-over-design"),
    "Step 3a section does not contain pre-implementation-over-design anchor"
  );
  // verify proximity: Step 3a heading and the anchor are both in the file and
  // the anchor appears before Step 4 (i.e., it is in the Step 3a block)
  const step3aIdx = stepDoc.indexOf("#### Step 3a");
  const step4Idx = stepDoc.indexOf("### Step 4");
  const anchorIdx = stepDoc.indexOf("pre-implementation-over-design", step3aIdx);
  assert.ok(
    anchorIdx !== -1 && anchorIdx < step4Idx,
    "pre-implementation-over-design anchor not in Step 3a block (between Step 3a heading and Step 4)"
  );
});

test("openspec-step-1-to-9.md Step 5 段含 pre-implementation-over-design 錨", () => {
  const step5Idx = stepDoc.indexOf("### Step 5");
  const step6Idx = stepDoc.indexOf("### Step 6");
  const anchorIdx = stepDoc.indexOf("pre-implementation-over-design", step5Idx);
  assert.ok(
    step5Idx !== -1 && anchorIdx !== -1 && anchorIdx < step6Idx,
    "pre-implementation-over-design anchor not in Step 5 block (between Step 5 heading and Step 6)"
  );
});

test("dp-programmer.md §開工前環境檢查 含 pre-implementation-over-design 錨 (≥1)", () => {
  assert.ok(
    programmer.includes("pre-implementation-over-design"),
    "pre-implementation-over-design anchor not found in dp-programmer.md"
  );
});

// ── (e) Pre-Ship Contract Dual-Read Ban (strengthen-pre-ship-dual-read-ban) ───

const openspecFlow = read("openspec/specs/openspec-flow/spec.md");
const consequence = read(".devpro/agent-rules/change-consequence-assessment.md");
const ambiguity = read(".devpro/agent-rules/ambiguity-scoring.md");
const rationalizations = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
const dualReadBan = "Pre-Ship Contract Dual-Read Ban";
const holderUnique = "不可丟棄的 durable artifact";

test("pre-implementation-over-design.md 含 Pre-Ship Contract Dual-Read Ban", () => {
  assert.ok(
    leaf.includes(dualReadBan),
    `${dualReadBan} heading missing from pre-implementation-over-design.md`
  );
  assert.ok(
    leaf.includes(holderUnique),
    "holder-test unique durable-artifact wording missing from SSOT leaf"
  );
});

test("pre-implementation-over-design.md Audit／Exit 對齊 eight patterns", () => {
  assert.ok(
    leaf.includes("schema／contract 改版或保留 vN-1") || leaf.includes("schema/contract 改版或保留 vN-1"),
    "Audit 8th-row trigger wording missing"
  );
  assert.ok(
    leaf.includes("Over-Design Audit 8 項") || leaf.includes("eight over-design patterns"),
    "Exit Criteria / eight-pattern anchor missing from over-design leaf"
  );
});

test("openspec-flow Over-Design Audit 為 eight patterns 且保留 duplicate-cache scenario", () => {
  const reqIdx = openspecFlow.indexOf("### Requirement: Pre-Implementation Over-Design Audit");
  assert.ok(reqIdx !== -1, "Pre-Implementation Over-Design Audit requirement missing");
  const nextReq = openspecFlow.indexOf("\n### Requirement:", reqIdx + 1);
  const body = openspecFlow.slice(reqIdx, nextReq === -1 ? undefined : nextReq);
  assert.ok(
    body.includes("eight over-design patterns"),
    "openspec-flow Over-Design Audit must say eight over-design patterns"
  );
  assert.ok(
    !body.includes("seven over-design patterns"),
    "openspec-flow Over-Design Audit must not still say seven over-design patterns"
  );
  assert.ok(
    body.includes("Proposal Contains Two Cache TTLs For Same Data"),
    "duplicate-cache scenario must be preserved"
  );
  assert.ok(
    body.includes("Holder-Negative Schema Bump Forbids Dual-Read"),
    "holder-negative scenario missing"
  );
  assert.ok(
    body.includes("Holder-Positive Allows Compatibility Migration Path"),
    "holder-positive scenario missing"
  );
  assert.ok(
    body.includes("Security Data-Loss Guardrails Not Removable By Dual-Read Simplification"),
    "security/data-loss scenario missing"
  );
});

test("consequence／ambiguity／rationalizations 只 pointer Dual-Read Ban，不重列 holder unique wording", () => {
  assert.ok(
    consequence.includes(dualReadBan),
    "change-consequence-assessment.md missing Dual-Read Ban pointer"
  );
  assert.ok(
    ambiguity.includes(dualReadBan),
    "ambiguity-scoring.md missing Dual-Read Ban pointer"
  );
  assert.ok(
    rationalizations.includes("未上線仍寫舊版相容"),
    "ai-autonomy-rationalizations.md missing pre-ship compat rationalization row"
  );
  assert.ok(
    rationalizations.includes(dualReadBan),
    "ai-autonomy-rationalizations.md missing Dual-Read Ban pointer"
  );
  assert.equal(
    consequence.includes(holderUnique),
    false,
    "consequence must not restate holder unique durable-artifact wording"
  );
  assert.equal(
    ambiguity.includes(holderUnique),
    false,
    "ambiguity must not restate holder unique durable-artifact wording"
  );
  assert.equal(
    rationalizations.includes(holderUnique),
    false,
    "rationalizations must not restate holder unique durable-artifact wording"
  );
  for (const [name, text] of [
    ["consequence", consequence],
    ["ambiguity", ambiguity],
    ["rationalizations", rationalizations],
  ]) {
    const compressedTriad =
      /production/.test(text) && /durable/.test(text) && /明示/.test(text);
    assert.equal(
      compressedTriad,
      false,
      `${name} must not compress-restate holder triad (production+durable+明示)`
    );
  }
});

// ── (d) code-simplification.md extraction completeness ───────────────────────

test("code-simplification.md audit 表關鍵詞「Audit 項」0 殘留（move 完整）", () => {
  assert.ok(
    !codeSimplification.includes("Audit 項"),
    "「Audit 項」still present in code-simplification.md — audit table not fully removed"
  );
});

test("code-simplification.md Dog-food 案例 0 殘留（move 完整）", () => {
  assert.ok(
    !codeSimplification.includes("Dog-food"),
    "「Dog-food」still present in code-simplification.md — dog-food section not fully removed"
  );
});

test("code-simplification.md 反對藉口段 0 殘留（move 完整）", () => {
  assert.ok(
    !codeSimplification.includes("反對藉口"),
    "「反對藉口」still present in code-simplification.md — rationalization section not fully removed"
  );
});

test("code-simplification.md 含 pre-implementation-over-design cross-ref (≥1)", () => {
  assert.ok(
    codeSimplification.includes("pre-implementation-over-design"),
    "cross-ref to pre-implementation-over-design missing from code-simplification.md"
  );
});
