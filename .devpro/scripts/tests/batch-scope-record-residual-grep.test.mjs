/**
 * batch-scope-record-residual-grep.test.mjs
 *
 * Cross-carrier guard for the named residual `batch-scope-record-residual`
 * (defined only in `design-core.md` §11; change
 * amend-gate-forgery-rule-for-batch-scope-records, design.md D5).
 *
 * Scenario: Full ledger and lite record state the same named residual.
 * Both the full carriers (the proposal ledger) and the lite carriers (the
 * lite-scope.md record) MUST state, in the same three sentences:
 *   (1) the record is written only AFTER the user chose batch approval
 *       (stepwise or unanswered writes `N/A: no batch approval selected`
 *       for full, nothing for lite);
 *   (2) the gates verify only format, change name and branch;
 *   (3) that residual is classified by pointing at the named exception
 *       `batch-scope-record-residual`, never by restating its terms.
 *
 * Carriers:
 *   full: ai-autonomy.md Matching Batch Approval Ledger paragraph,
 *         change SKILL Batch Approval Ledger section,
 *         proposal-template.md `## Batch Approval Ledger` section;
 *   lite: ai-autonomy.md same paragraph, change SKILL Lite section.
 *
 * The full-section wording intentionally differs from the lite
 * `forgedConsentThreeCases` anchor ("相符 ledger" vs "相符紀錄") so that the
 * lite anchor in lite-scope-record-grep.test.mjs keeps matching exactly once.
 *
 * Anchor strength follows `.devpro/agent-rules/rule-anchor-guard-strength.md`:
 * each anchor binds its parts on ONE physical line with a bounded gap and
 * must match exactly once; the mutation audit proves that losing the
 * pointer on any side, or losing the "after the batch choice" fact on the
 * full side, turns the guard red.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepoFile as read, readRepoFileIfExists } from "./lib/read.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const AUTONOMY = ".devpro/agent-rules/ai-autonomy.md";
const TEMPLATE = ".devpro/agent-rules/proposal-template.md";
const ID = "`batch-scope-record-residual`";

function assertPrimaryResidualMapping(text) {
  const section = text.split('### 審查輸出格式')[1]?.split('### Bounded Six-Axis Rereview Cadence')[0] || '';
  const rows = section.split('\n').filter((line) => line.includes(ID));
  assert.equal(rows.length, 1, 'primary output must discover exactly one mapping');
  assert.match(rows[0], /design-core\.md[^\n]*§11[^\n]*primary[^\n]*僅記為非阻擋觀察[^\n]*MUST NOT[^\n]*Suggestion／Important／Critical/);
  assert.match(rows[0], /例外的封閉範圍與自我適用限制仍照 SSOT/);
}

test('primary review maps the accepted residual to an observation, not a finding', () => {
  assertPrimaryResidualMapping(read('.devpro/agent-rules/code-review-checklist.md'));
});

test('primary residual mapping rejects operative deletion and polarity reversal', () => {
  const text = read('.devpro/agent-rules/code-review-checklist.md');
  assertPrimaryResidualMapping(text);
  for (const mutated of [text.replace('僅記為非阻擋觀察', ''), text.replace('**MUST NOT** 列為 Suggestion', '**MUST** 列為 Suggestion')]) {
    assert.notEqual(mutated, text, 'mutation must change the operative mapping');
    assert.throws(() => assertPrimaryResidualMapping(mutated), assert.AssertionError);
  }
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rowAnchor(parts, { gap = 200 } = {}) {
  return new RegExp(parts.map(escapeRegExp).join(`[^\\n]{0,${gap}}`), "g");
}

function count(regex, text) {
  return [...text.matchAll(regex)].length;
}

function assertOnce(label, regex, text) {
  assert.equal(count(regex, text), 1, `anchor ${label} must match exactly once`);
}

function slice(content, startMarker, endMarker, label) {
  const starts = content.split(startMarker).length - 1;
  assert.equal(starts, 1, `${label}: start marker must occur exactly once, found ${starts}: ${startMarker}`);
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: end marker not found after start: ${endMarker}`);
  return content.slice(start, end);
}

function matchingParagraph(autonomy) {
  const marker = "> **Matching Batch Approval Ledger = Ask First already satisfied";
  assert.equal(autonomy.split(marker).length - 1, 1, "ai-autonomy.md: Matching paragraph must occur exactly once");
  const start = autonomy.indexOf(marker);
  const end = autonomy.indexOf("\n", start);
  return autonomy.slice(start, end === -1 ? undefined : end);
}

function skillFullSection(skill) {
  return slice(skill, "**Batch Approval Ledger（proposal / proposal-mini 必寫）**", "\n**Approval scope narrowing prohibition**", "change skill ledger section");
}

function skillLiteSection(skill) {
  return slice(skill, "### Lite rigor level：跳過什麼、batch approval 怎麼取得", "\n**Scope Change Re-entry", "change skill lite section");
}

function templateLedgerSection(template) {
  return slice(template, "\n## Batch Approval Ledger\n", "\n## Requirement Ledger\n", "proposal-template ledger section");
}

function stepwiseBullet(liteSection) {
  const lines = liteSection.split("\n").filter((line) => line.startsWith("- **stepwise 不寫**"));
  assert.equal(lines.length, 1, "change skill lite section: stepwise bullet must occur exactly once");
  return lines[0];
}

// Pointer anchors: the identifier next to its §11 home, one physical line.
const POINTER = rowAnchor(["`design-core.md` §11", ID]);

const AUTONOMY_FULL_AFTER_CHOICE = rowAnchor([
  "full 的 proposal ledger 同理：只在使用者選 batch 之後寫",
  "`N/A: no batch approval selected`",
]);
const AUTONOMY_GATE_FORMAT_ONLY = rowAnchor(["閘同樣只驗格式、change 與 branch", "兩種紀錄的這項殘留皆屬", "`design-core.md` §11", ID]);
const SKILL_FULL_AFTER_CHOICE = rowAnchor(["只在使用者第零步選 batch 之後寫", "`N/A: no batch approval selected`"]);
const SKILL_FULL_GATE_FORMAT_ONLY = rowAnchor(["閘只驗格式、change 與 branch", "這項殘留屬", "`design-core.md` §11", ID]);
const SKILL_FULL_THREE_CASES = rowAnchor(["在 stepwise、尚未回答或自行推斷 batch 時寫出相符 ledger，屬偽造同意證據"]);
const TEMPLATE_AFTER_CHOICE = rowAnchor(["Write the ledger only after the user chooses batch approval", "`N/A: no batch approval selected`"]);
const TEMPLATE_GATE_FORMAT_ONLY = rowAnchor([
  "gates verify only format, change name and branch",
  "cannot prove the user chose batch approval",
  "`design-core.md` §11",
  ID,
]);
// The pointer sentence carries its own antecedent (AI-written record, gate verifies
// only format/change/branch, cannot prove the batch choice) and explicitly excludes
// forgery, so "此殘留" can never be read as "the forged record is the exception".
const LITE_STEPWISE_POINTER = rowAnchor([
  "屬偽造同意證據（與偽造 proposal ledger 同級）；另，紀錄由 AI 代寫",
  "閘只驗紀錄格式、change 與 branch",
  "無法證明使用者選過 batch",
  "這項結構殘留（不含上述偽造）屬 `design-core.md` §11",
  ID,
]);
const LITE_DANGLING_POINTER = "（與偽造 proposal ledger 同級）；此殘留屬";
const LITE_AFTER_CHOICE = rowAnchor(["- **選 batch 之後才寫 `lite-scope.md`**"]);

// Existing lite anchors (lite-scope-record-grep.test.mjs owns them); the
// new pointer MUST NOT displace any of them.
const LITE_EXISTING_AUTONOMY = {
  forgedConsentEvidence: rowAnchor([
    "**lite 紀錄只能在使用者選 batch 之後寫**：stepwise、使用者尚未回答或 AI 自行推斷時寫出相符紀錄，屬偽造同意證據",
  ]),
  sameReplyPasteLine: rowAnchor(["寫入的同一輪回覆 **MUST** 貼出該行原文並點名依據的使用者回答"]),
  cooperativeOnly: rowAnchor(["此條為 cooperative 規則", "Gate R1／SP 只驗紀錄格式、change 與 branch"]),
};
const LITE_EXISTING_SKILL = {
  stepwiseWritesNothing: rowAnchor(["- **stepwise 不寫**：使用者選 stepwise 或尚未回答時 MUST NOT 寫此檔"]),
  forgedConsentThreeCases: rowAnchor(["在 stepwise、尚未回答或自行推斷 batch 時寫出相符紀錄，屬偽造同意證據"]),
};

function assertResidualParity({ autonomy, skill, template }) {
  const matching = matchingParagraph(autonomy);
  const full = skillFullSection(skill);
  const lite = skillLiteSection(skill);
  const ledger = templateLedgerSection(template);

  // ai-autonomy.md: one paragraph carries both the full and lite statements.
  assertOnce("autonomy.fullAfterChoice", AUTONOMY_FULL_AFTER_CHOICE, matching);
  assertOnce("autonomy.gateFormatOnly+pointer", AUTONOMY_GATE_FORMAT_ONLY, matching);
  assert.equal(count(new RegExp(escapeRegExp(ID), "g"), matching), 1, "autonomy: identifier must appear exactly once in the Matching paragraph");

  // change SKILL full ledger section.
  assertOnce("skill.full.afterChoice", SKILL_FULL_AFTER_CHOICE, full);
  assertOnce("skill.full.gateFormatOnly+pointer", SKILL_FULL_GATE_FORMAT_ONLY, full);
  assertOnce("skill.full.threeCases", SKILL_FULL_THREE_CASES, full);
  assert.equal(count(new RegExp(escapeRegExp(ID), "g"), full), 1, "skill full: identifier must appear exactly once");

  // proposal-template ledger section.
  assertOnce("template.afterChoice", TEMPLATE_AFTER_CHOICE, ledger);
  assertOnce("template.gateFormatOnly+pointer", TEMPLATE_GATE_FORMAT_ONLY, ledger);
  assert.equal(count(new RegExp(escapeRegExp(ID), "g"), ledger), 1, "template: identifier must appear exactly once");

  // change SKILL Lite section: pointer on the stepwise bullet, and the
  // "write only after the batch choice" fact on its own bullet.
  assertOnce("skill.lite.afterChoice", LITE_AFTER_CHOICE, lite);
  assertOnce("skill.lite.stepwisePointer", LITE_STEPWISE_POINTER, stepwiseBullet(lite));
  assert.ok(!stepwiseBullet(lite).includes(LITE_DANGLING_POINTER), "skill.lite.noDanglingPointer: the pointer must not directly follow the forgery clause");
  assert.equal(count(new RegExp(escapeRegExp(ID), "g"), lite), 1, "skill lite: identifier must appear exactly once");

  // The full wording must not collide with the lite three-cases anchor.
  assert.equal(count(LITE_EXISTING_SKILL.forgedConsentThreeCases, full), 0, "skill full section must not reuse the lite forgedConsentThreeCases wording");

  // Existing lite anchors survive, once each, in their whole carrier file.
  for (const [name, regex] of Object.entries(LITE_EXISTING_AUTONOMY)) assertOnce(`autonomy.${name}`, regex, autonomy);
  for (const [name, regex] of Object.entries(LITE_EXISTING_SKILL)) assertOnce(`skill.${name}`, regex, skill);
}

function load() {
  return { autonomy: read(AUTONOMY), skill: read(SKILL), template: read(TEMPLATE) };
}

function mutate(content, from, to, label) {
  assert.ok(content.includes(from), `mutation fixture invalid, text not found: ${label}`);
  return content.replace(from, to);
}

test("Full ledger and lite record state the same named residual: full and lite carriers share the pointer and both facts", () => {
  assertResidualParity(load());
});

test("Full ledger and lite record state the same named residual: ai-autonomy pointer loss turns red", () => {
  const carriers = load();
  const autonomy = mutate(carriers.autonomy, ID, "`other-residual`", "autonomy identifier");
  assert.throws(() => assertResidualParity({ ...carriers, autonomy }), /autonomy/);
});

test("Full ledger and lite record state the same named residual: change SKILL full pointer loss turns red", () => {
  const carriers = load();
  const full = skillFullSection(carriers.skill);
  const skill = carriers.skill.replace(full, mutate(full, ID, "`other-residual`", "skill full identifier"));
  assert.throws(() => assertResidualParity({ ...carriers, skill }), /skill\.full/);
});

test("Full ledger and lite record state the same named residual: proposal-template pointer loss turns red", () => {
  const carriers = load();
  const template = mutate(carriers.template, ID, "`other-residual`", "template identifier");
  assert.throws(() => assertResidualParity({ ...carriers, template }), /template/);
});

test("Full ledger and lite record state the same named residual: change SKILL lite pointer loss turns red", () => {
  const carriers = load();
  const lite = skillLiteSection(carriers.skill);
  const skill = carriers.skill.replace(lite, mutate(lite, "這項結構殘留（不含上述偽造）屬 `design-core.md` §11 " + ID, "", "skill lite pointer"));
  assert.throws(() => assertResidualParity({ ...carriers, skill }), /skill\.lite/);
});

test("Full ledger and lite record state the same named residual: change SKILL lite pointer without its own antecedent or forgery exclusion turns red", () => {
  const carriers = load();
  const lite = skillLiteSection(carriers.skill);

  const noAntecedent = carriers.skill.replace(
    lite,
    mutate(lite, "；另，紀錄由 AI 代寫，閘只驗紀錄格式、change 與 branch，無法證明使用者選過 batch，這項結構殘留（不含上述偽造）屬", "；此殘留屬", "skill lite antecedent"),
  );
  assert.throws(() => assertResidualParity({ ...carriers, skill: noAntecedent }), /skill\.lite/);

  const noExclusion = carriers.skill.replace(lite, mutate(lite, "（不含上述偽造）", "", "skill lite forgery exclusion"));
  assert.throws(() => assertResidualParity({ ...carriers, skill: noExclusion }), /skill\.lite\.stepwisePointer/);

  const dangling = carriers.skill.replace(lite, mutate(lite, "`batch-scope-record-residual`。", "`batch-scope-record-residual`。（與偽造 proposal ledger 同級）；此殘留屬 x。", "skill lite dangling"));
  assert.throws(() => assertResidualParity({ ...carriers, skill: dangling }), /skill\.lite\.noDanglingPointer/);
});

test("Full ledger and lite record state the same named residual: losing 'after the batch choice' on the full side turns red", () => {
  const carriers = load();
  const autonomy = mutate(carriers.autonomy, "只在使用者選 batch 之後寫", "寫", "autonomy full after choice");
  assert.throws(() => assertResidualParity({ ...carriers, autonomy }), /autonomy\.fullAfterChoice/);

  const full = skillFullSection(carriers.skill);
  const skill = carriers.skill.replace(full, mutate(full, "只在使用者第零步選 batch 之後寫", "寫", "skill full after choice"));
  assert.throws(() => assertResidualParity({ ...carriers, skill }), /skill\.full\.afterChoice/);

  const template = mutate(carriers.template, "Write the ledger only after the user chooses batch approval", "Write the ledger", "template after choice");
  assert.throws(() => assertResidualParity({ ...carriers, template }), /template\.afterChoice/);
});

test("Full ledger and lite record state the same named residual: losing 'gates verify only format' on the full side turns red", () => {
  const carriers = load();
  const full = skillFullSection(carriers.skill);
  const skill = carriers.skill.replace(full, mutate(full, "閘只驗格式、change 與 branch", "閘會驗證", "skill full gate format"));
  assert.throws(() => assertResidualParity({ ...carriers, skill }), /skill\.full\.gateFormatOnly/);

  const template = mutate(carriers.template, "cannot prove the user chose batch approval", "prove it", "template gate format");
  assert.throws(() => assertResidualParity({ ...carriers, template }), /template\.gateFormatOnly/);
});

test("Full ledger and lite record state the same named residual: dropping a lite anchor or reusing its wording in the full section turns red", () => {
  const carriers = load();
  const skillNoAnchor = mutate(carriers.skill, "- **stepwise 不寫**：使用者選 stepwise 或尚未回答時 MUST NOT 寫此檔", "- **stepwise**：", "lite stepwise anchor");
  assert.throws(() => assertResidualParity({ ...carriers, skill: skillNoAnchor }), /stepwise/);

  const full = skillFullSection(carriers.skill);
  const skillCollide = carriers.skill.replace(full, mutate(full, "寫出相符 ledger，屬偽造同意證據", "寫出相符紀錄，屬偽造同意證據", "full three cases"));
  assert.throws(() => assertResidualParity({ ...carriers, skill: skillCollide }), /skill\.full\.threeCases|forgedConsentThreeCases/);
});

// The scenario's subjects are the two requirements themselves, so the spec text is
// read too: the active delta, or the canonical spec once the change is archived.
const SPEC_DELTA = "openspec/changes/amend-gate-forgery-rule-for-batch-scope-records/specs/openspec-flow/spec.md";
const SPEC_CANONICAL = "openspec/specs/openspec-flow/spec.md";
const FULL_REQUIREMENT = "Batch Approval Ledger Unconditional Recording And Archive-Time Backstop";
const LITE_REQUIREMENT = "Lite Batch Scope Is Recorded In One Untracked Change-Folder Line";

function loadOpenspecFlowSpec() {
  return readRepoFileIfExists(SPEC_DELTA) ?? read(SPEC_CANONICAL);
}

function requirementBody(spec, name) {
  const marker = `### Requirement: ${name}\n`;
  assert.equal(spec.split(marker).length - 1, 1, `openspec-flow spec: requirement must occur exactly once: ${name}`);
  const start = spec.indexOf(marker) + marker.length;
  const next = spec.indexOf("\n### Requirement:", start);
  return spec.slice(start, next === -1 ? undefined : next);
}

const SPEC_FULL_FACTS = {
  "spec.full.afterChoice": rowAnchor(["The full `## Batch Approval Ledger` SHALL be written only after the user chooses batch approval"]),
  "spec.full.gateFormatOnly": rowAnchor(["Gate R1, Gate SP, and archive gate (c) check only the ledger format, change name, and branch", "no gate can prove the user chose batch approval"]),
  "spec.full.pointer": rowAnchor(["named exception", ID, "defined in `design-core.md` §11"]),
};
const SPEC_LITE_FACTS = {
  "spec.lite.afterChoice": rowAnchor(["The record SHALL be written only after the user chooses batch approval"]),
  "spec.lite.gateFormatOnly": rowAnchor(["Gate R1 and Gate SP can verify only its format, change name, and branch", "cannot mechanically prove that the user chose batch approval"]),
  "spec.lite.pointer": rowAnchor(["named exception", ID, "defined in `design-core.md` §11"]),
};

function assertSpecResidualParity(spec) {
  const full = requirementBody(spec, FULL_REQUIREMENT);
  const lite = requirementBody(spec, LITE_REQUIREMENT);
  for (const [label, regex] of Object.entries(SPEC_FULL_FACTS)) assertOnce(label, regex, full);
  for (const [label, regex] of Object.entries(SPEC_LITE_FACTS)) assertOnce(label, regex, lite);
}

test("Full ledger and lite record state the same named residual: both openspec-flow requirements carry the three facts", () => {
  assertSpecResidualParity(loadOpenspecFlowSpec());
});

test("Full ledger and lite record state the same named residual: openspec-flow requirement losing a fact turns red", () => {
  const spec = loadOpenspecFlowSpec();
  const full = requirementBody(spec, FULL_REQUIREMENT);
  const lite = requirementBody(spec, LITE_REQUIREMENT);
  const swap = (body, from, to, label) => spec.replace(body, mutate(body, from, to, label));

  const noFullPointer = swap(full, ID, "`other-residual`", "spec full pointer");
  assert.throws(() => assertSpecResidualParity(noFullPointer), /spec\.full/);
  const noLitePointer = swap(lite, ID, "`other-residual`", "spec lite pointer");
  assert.throws(() => assertSpecResidualParity(noLitePointer), /spec\.lite/);

  const noFullAfterChoice = swap(full, "SHALL be written only after the user chooses batch approval", "SHALL be written", "spec full after choice");
  assert.throws(() => assertSpecResidualParity(noFullAfterChoice), /spec\.full\.afterChoice/);
  const noLiteAfterChoice = swap(lite, "SHALL be written only after the user chooses batch approval", "SHALL be written", "spec lite after choice");
  assert.throws(() => assertSpecResidualParity(noLiteAfterChoice), /spec\.lite\.afterChoice/);

  const noFullFormat = swap(full, "check only the ledger format, change name, and branch", "check the ledger", "spec full format");
  assert.throws(() => assertSpecResidualParity(noFullFormat), /spec\.full\.gateFormatOnly/);
  const noLiteFormat = swap(lite, "can verify only its format, change name, and branch", "can verify it", "spec lite format");
  assert.throws(() => assertSpecResidualParity(noLiteFormat), /spec\.lite\.gateFormatOnly/);

  const noFullCannotProve = swap(full, "so no gate can prove the user chose batch approval", "so the gates are enough", "spec full cannot prove");
  assert.throws(() => assertSpecResidualParity(noFullCannotProve), /spec\.full\.gateFormatOnly/);
  const noLiteCannotProve = swap(lite, "they cannot mechanically prove that the user chose batch approval", "they are enough", "spec lite cannot prove");
  assert.throws(() => assertSpecResidualParity(noLiteCannotProve), /spec\.lite\.gateFormatOnly/);
});
