/**
 * strengthen-requirements-clarification-contract-grep.test.mjs
 *
 * Cross-leaf contract guards for option presentation (rule 5), material
 * negatives / risk_classes, conditional Initiator/Affected, preflight
 * pointers, and devpro:change skill short pointer.
 *
 * risk_classes for this change: [auth, external-disclosure]
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";
import { readSourceFile as read } from "./lib/read.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";



const STOP = read(".devpro/agent-rules/stop-point-comms.md");
const AMB = read(".devpro/agent-rules/ambiguity-scoring.md");
const QUALITY = read(".devpro/agent-rules/openspec-quality-and-formats.md");
const DOC = read(".devpro/agent-rules/openspec-quality-doc-formats.md");
const PRE = read(".devpro/agent-rules/preflight-checklist.md");
// 第四步 lives in the full-rigor reference; both copies use the full reading order.
const DP_CHANGE = readChangeSkillFullReadingOrder();
const DP_CHANGE_CLAUDE = readChangeSkillFullReadingOrder();

// ---------------------------------------------------------------------------
// R1 — stop-point rule 5 presentation SSOT
// ---------------------------------------------------------------------------

test("R1: stop-point-comms carries 提案確認 / 作文題主路徑 / 選項旁 / 為什麼有推薦", () => {
  assert.match(STOP, /規則 5|選項呈現契約/, "rule 5 heading missing");
  assert.match(STOP, /提案確認/, "提案確認 missing");
  assert.match(STOP, /作文題主路徑/, "作文題主路徑 ban missing");
  assert.match(STOP, /選項旁/, "選項旁 rationale missing");
  assert.match(STOP, /為什麼有推薦/, "為什麼有推薦 empty-label ban missing");
  assert.match(STOP, /\*\*1\.\s*三要素/, "rule 1 must remain");
  assert.match(STOP, /\*\*4\.\s*術語配白話/, "rule 4 must remain");
});

// ---------------------------------------------------------------------------
// R2 — ambiguity pointer-only (no dual-write of full presentation body)
// ---------------------------------------------------------------------------

test("R2: ambiguity-scoring pointers to stop-point rule 5; no full dual-write", () => {
  assert.match(
    AMB,
    /stop-point-comms\.md.*規則 5|規則 5（選項呈現契約）/,
    "clarification presentation must pointer to stop-point rule 5",
  );
  // Full rule-5 body clauses belong in stop-point only — not a second SSOT.
  assert.doesNotMatch(
    AMB,
    /獨立空標籤「為什麼有推薦」/,
    "ambiguity must NOT dual-write the empty-label ban body",
  );
  assert.doesNotMatch(
    AMB,
    /MUST\*\* 走 \*\*提案確認\*\*主路徑/,
    "ambiguity must NOT dual-write the full 提案確認 MUST body",
  );
});

test("R2/R3: ambiguity Non-goals ban-escape short MUST + quality pointer", () => {
  assert.match(
    AMB,
    /MUST NOT.*逃脫.*material negatives|不得.*逃脫 high-risk material negatives/,
    "ambiguity must ban Non-goals escape of material negatives",
  );
  assert.match(
    AMB,
    /改口成 `risk_classes: none`|taxonomy a–d.*risk_classes: none/,
    "ambiguity must forbid reclassifying a–d as none via Non-goals",
  );
  assert.match(
    AMB,
    /openspec-quality-and-formats\.md/,
    "ambiguity must pointer to quality SSOT",
  );
});

// ---------------------------------------------------------------------------
// R3 — quality material-negatives SSOT
// ---------------------------------------------------------------------------

test("R3: quality SSOT has taxonomy + risk_classes + four negatives + Non-goals ban", () => {
  assert.match(QUALITY, /High-risk material negatives|閉集 high-risk taxonomy/, "taxonomy heading missing");
  assert.match(QUALITY, /授權／權限邊界/, "taxonomy (a) auth missing");
  assert.match(QUALITY, /狀態機／不變量/, "taxonomy (b) state missing");
  assert.match(QUALITY, /耐久寫入／原子性/, "taxonomy (c) durable-write missing");
  assert.match(QUALITY, /對外披露/, "taxonomy (d) external-disclosure missing");
  assert.match(QUALITY, /risk_classes:/, "risk_classes recording missing");
  assert.match(QUALITY, /risk_classes: none/, "risk_classes: none form missing");
  assert.match(
    QUALITY,
    /leading YAML front matter/,
    "quality SSOT must require leading YAML front matter carrier",
  );
  assert.match(QUALITY, /未授權拒絕/, "negative: unauthorized reject missing");
  assert.match(QUALITY, /非法狀態／不變量/, "negative: illegal state missing");
  assert.match(QUALITY, /寫入失敗／原子性/, "negative: write-fail missing");
  assert.match(QUALITY, /對外披露不該發生/, "negative: disclosure-deny missing");
  assert.match(
    QUALITY,
    /Non-goals.*不得逃脫|MUST NOT.*逃脫載體/,
    "Non-goals escape ban missing",
  );
  assert.match(QUALITY, /rationale＋owner|rationale\+owner/, "omission rationale+owner missing");
  assert.match(
    QUALITY,
    /lint-risk-classes-record/,
    "quality SSOT must name lint-risk-classes-record carrier",
  );
  assert.ok(
    existsSync(sourcePath(".devpro/scripts/lint-risk-classes-record.mjs")),
    "lint-risk-classes-record.mjs must exist",
  );
});

// ---------------------------------------------------------------------------
// R4 — Initiator/Affected conditional; six-column ledger intact; no BRD-global
// ---------------------------------------------------------------------------

test("R4: doc-formats defines conditional Initiator/Affected; bans BRD-global Actor", () => {
  assert.match(DOC, /Conditional Initiator|Initiator／Affected/, "Initiator/Affected section missing");
  assert.match(DOC, /Initiator=<|Initiator:/, "Initiator token shape missing");
  assert.match(DOC, /Affected=<|Affected:/, "Affected token shape missing");
  assert.match(DOC, /Initiator\/Affected=N\/A/, "scoped N/A shape missing");
  assert.match(DOC, /BRD-global Actor/, "BRD-global Actor ban missing");
  assert.match(
    DOC,
    /\| ID \| Root Requirement \| Parent Requirement \| Current Requirement \| Disposition \| Owner \/ Next Step \|/,
    "six-column ledger header must remain",
  );
  assert.doesNotMatch(
    DOC,
    /\| ID \| Root Requirement \| Parent Requirement \| Current Requirement \| Disposition \| Owner \/ Next Step \| Actor \|/,
    "must NOT add a seventh Actor ledger column",
  );
});

// ---------------------------------------------------------------------------
// R5 — preflight pointer checklist
// ---------------------------------------------------------------------------

test("R5: preflight-checklist has risk_classes / role / negatives pointers", () => {
  assert.match(PRE, /risk_classes/, "preflight risk_classes check missing");
  assert.match(
    PRE,
    /leading YAML front matter/,
    "preflight must pointer to leading YAML front matter contract",
  );
  assert.match(PRE, /Initiator／Affected|角色/, "preflight role check missing");
  assert.match(PRE, /負向|Non-goals 禁逃/, "preflight negatives check missing");
  assert.match(PRE, /openspec-quality-and-formats\.md/, "pointer to quality SSOT missing");
  assert.match(PRE, /openspec-quality-doc-formats\.md/, "pointer to doc-formats SSOT missing");
  assert.match(PRE, /BRD-global Actor/, "preflight BRD-global Actor ban pointer missing");
});

// ---------------------------------------------------------------------------
// R7 — devpro:change discovery projections short pointer
// ---------------------------------------------------------------------------

test("R7: devpro:change skills pointer to stop-point rule 5 (same meaning)", () => {
  for (const [label, body] of [
    ["shared", DP_CHANGE],
    ["claude", DP_CHANGE_CLAUDE],
  ]) {
    assert.match(
      body,
      /規則 5.*選項呈現契約|選項呈現.*規則 5/,
      `${label} devpro:change missing rule 5 option-presentation pointer`,
    );
  }
});

// ---------------------------------------------------------------------------
// R6 / negatives — fixture anti-patterns MUST fail assertions
// ---------------------------------------------------------------------------

test("R6 negative: fixture missing risk_classes / allowing Non-goals escape / BRD-global Actor fails", () => {
  const badFixture = [
    "# fake leaf",
    "## Non-goals 可承載 material negative（逃脫允許）",
    "BRD-global Actor 可替代列宣告",
    // deliberately NO risk_classes:
  ].join("\n");

  assert.throws(() => {
    assert.match(badFixture, /risk_classes:/, "missing risk_classes");
  }, "fixture without risk_classes must fail");

  assert.throws(() => {
    assert.doesNotMatch(
      badFixture,
      /Non-goals 可承載 material negative/,
      "escape wording must not appear",
    );
  }, "fixture allowing Non-goals escape must fail doesNotMatch");

  assert.throws(() => {
    assert.doesNotMatch(
      badFixture,
      /BRD-global Actor 可替代/,
      "BRD-global Actor substitute wording must not appear",
    );
  }, "fixture allowing BRD-global Actor substitute must fail doesNotMatch");
});

test("R6/R8: real leaves MUST NOT carry escape / substitute anti-pattern wording", () => {
  for (const [label, body] of [
    ["quality", QUALITY],
    ["ambiguity", AMB],
    ["doc-formats", DOC],
    ["preflight", PRE],
  ]) {
    assert.doesNotMatch(
      body,
      /Non-goals 可承載 material negative/,
      `${label} must not allow Non-goals escape wording`,
    );
    assert.doesNotMatch(
      body,
      /BRD-global Actor 可替代/,
      `${label} must not allow BRD-global Actor substitute wording`,
    );
  }
  assert.match(QUALITY, /risk_classes:/, "quality SSOT must require risk_classes");
  assert.match(DOC, /MUST NOT[\s\S]{0,80}BRD-global Actor/, "doc-formats must MUST NOT BRD-global Actor");
});

test("R8 Don't-touch: no US/UC/JTBD/OST / G3 / semantic hard CI anchors introduced in new SSOT blocks", () => {
  const materialBlock = QUALITY.match(/High-risk material negatives[\s\S]*?(?=\n### )/);
  assert.ok(materialBlock, "material negatives block missing");
  assert.doesNotMatch(materialBlock[0], /\bUser Story\b|\bJTBD\b|\bOST\b|Use Case/, "must not introduce US/UC/JTBD/OST");
  assert.doesNotMatch(materialBlock[0], /independently-valuable slice|G3 /, "must not introduce G3 slice norm");
  assert.match(materialBlock[0], /禁止.*語意白話 hard CI|review-only/, "must keep semantic quality review-only");
});
