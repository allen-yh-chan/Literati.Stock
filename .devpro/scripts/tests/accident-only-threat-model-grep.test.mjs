/**
 * accident-only-threat-model-grep.test.mjs
 *
 * Literal-presence guard for the accident-only principle of `design-core.md` section 11
 * (change amend-gate-threat-model-to-accident-only; user ruling 2026-11-09, class two kept
 * adversarial 2026-11-10).
 *
 * What this file locks (each group has its own mutation probe):
 *   1. AGENTS.md line 9 (Core Contract) states the principle and points at section 11.
 *   2. Section 11 principle paragraph: accidental mistakes are guarded, deliberate forgery or
 *      bypass is outside the threat model, class two is the only exception.
 *   3. Residual rule items 1-2: classification by nature, burden on the class-two claimant.
 *   4. F-6 / F-7 / F-9 key phrases (silence, novelty, capability arguments).
 *   5. The general clause `consent-record-residual` (INFO cap, no keys/signatures/terminal-only/
 *      personal steps, not-covered list, self-application, named exceptions as instances).
 *   6. The ai-autonomy-rationalizations row.
 *   7. The packet static duty (reviewer-reachable): principle sentence, class-one accident
 *      criterion, general clause placement, nature-based unlisted-object guard.
 *   8. The new / re-worded canonical spec requirements and scenario titles.
 *   9. Negatives: the retired "unlisted => class two" statements appear in no carrier.
 *
 * Guarantee ceiling (cooperative-only, symmetric with section 11 "guarantee ceiling"): these
 * tests lock verbatim presence and placement only. They do NOT prove that a reviewer follows the
 * principle or classifies a gate correctly; that stays a review judgement, never a CI hard fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readRepoFile as read } from "./lib/read.mjs";
import { secondReviewPacketStaticPrefix } from "../validate-second-review-packet.mjs";

const DESIGN_CORE = ".devpro/agent-rules/design-core.md";
const AGENTS = "AGENTS.md";
const RATIONALIZATIONS = ".devpro/agent-rules/ai-autonomy-rationalizations.md";
const SPEC_DESIGN_CORE = "openspec/specs/design-core/spec.md";
const SPEC_CHECKLIST = "openspec/specs/code-review-checklist/spec.md";
const CARRIERS = [
  DESIGN_CORE,
  AGENTS,
  RATIONALIZATIONS,
  ".devpro/agent-rules/code-review-cross-model.md",
  ".devpro/agent-rules/code-review-checklist.md",
  ".devpro/agent-rules/platform-adapters/cursor.md",
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
  ".devpro/scripts/validate-second-review-packet.mjs",
  SPEC_DESIGN_CORE,
  SPEC_CHECKLIST,
];

function section11() {
  const source = read(DESIGN_CORE);
  const start = source.indexOf("### 11. Mechanical Gate Threat Model");
  assert.notEqual(start, -1, `${DESIGN_CORE}: 找不到 section 11 標題`);
  const rest = source.slice(start + 4);
  const end = rest.indexOf("\n### ");
  return end === -1 ? source.slice(start) : source.slice(start, start + 4 + end);
}

function paragraphWith(text, marker, label) {
  const lines = text.split("\n").filter((line) => line.includes(marker));
  assert.equal(lines.length, 1, `${label}: 含 ${JSON.stringify(marker)} 的段落必須恰 1 個，實際 ${lines.length}`);
  return lines[0];
}

function missingAnchors(text, anchors) {
  return anchors.filter(([, needle]) => !text.includes(needle)).map(([label]) => label);
}

function assertLocked(text, anchors, where) {
  const missing = missingAnchors(text, anchors);
  assert.deepEqual(missing, [], `${where} 缺少錨點：${missing.join("、")}`);
}

// Mutation probe: control passes; removing each anchor is rejected; each extra mutant is rejected.
// `rebuild(mutatedBlock)` puts the mutated block back into the full text the predicate reads.
function probe({ block, anchors, predicate, mutants = [] }) {
  assert.deepEqual(predicate(block), [], "control must satisfy the predicate");
  for (const [label, needle] of anchors) {
    const mutated = block.replace(needle, "");
    assert.notEqual(mutated, block, `probe fixture must change the block (anchor ${label})`);
    assert.notDeepEqual(predicate(mutated), [], `removing anchor「${label}」must be rejected`);
  }
  for (const [name, fn] of mutants) {
    const mutated = fn(block);
    assert.notEqual(mutated, block, `mutant fixture must change the block: ${name}`);
    assert.notDeepEqual(predicate(mutated), [], `mutant must be rejected: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 1. AGENTS.md line 9
// ---------------------------------------------------------------------------
const AGENTS_LINE_9 = "閘只防 AI 不小心、不防故意（產品安全與合規除外）；分類見 `design-core.md` §11";
const AGENTS_ANCHORS = [
  ["只防不小心、不防故意", "閘只防 AI 不小心、不防故意"],
  ["產品安全與合規除外", "（產品安全與合規除外）"],
  ["指向 design-core §11", "分類見 `design-core.md` §11"],
];

test("AGENTS.md line 9 carries the accident-only principle and points at design-core section 11", () => {
  const line9 = read(AGENTS).split("\n")[8];
  assert.equal(line9, AGENTS_LINE_9, "AGENTS.md line 9 must be the accident-only Core Contract line");
  assertLocked(line9, AGENTS_ANCHORS, "AGENTS.md line 9");
});

test("AGENTS.md line 9 mutation probes: every anchor and a class-two widening are rejected", () => {
  const line9 = read(AGENTS).split("\n")[8];
  probe({
    block: line9,
    anchors: AGENTS_ANCHORS,
    predicate: (b) => missingAnchors(b, AGENTS_ANCHORS),
    mutants: [["class-two exception widened away", (b) => b.replace("（產品安全與合規除外）", "（含產品安全與合規）")]],
  });
});

// ---------------------------------------------------------------------------
// 2. Section 11 principle paragraph
// ---------------------------------------------------------------------------
const PRINCIPLE_MARKER = "**原則（使用者裁示；provenance: user）**";
const PRINCIPLE_ANCHORS = [
  ["防的是 AI 正常工作中的不小心", "閘與審查防的是 AI 正常工作中的**不小心**"],
  ["存心偽造或刻意繞過不在威脅模型內", "AI **存心**偽造或刻意繞過不在威脅模型內"],
  ["不加終端機限定、金鑰、簽章、親自操作", "不為它加終端機限定、金鑰、簽章或要使用者親自操作的步驟"],
  ["審查不得以「AI 可能故意」判 WARN 或 Critical", "審查也不得以「AI 可能故意這樣做」為由判 WARN 或 Critical"],
  ["唯一例外是 class two", "唯一例外是下方 class two（產品安全與合規產出）"],
  ["class two 維持 adversarial", "維持 adversarial"],
  ["依據：使用者 2026-11-09 裁示", "使用者 2026-11-09 裁示"],
  ["class two 使用者 2026-11-10 選維持", "使用者 2026-11-10 選維持"],
];

function principleParagraph() {
  return paragraphWith(section11(), PRINCIPLE_MARKER, "§11 principle");
}

test("[Scenario: design-core :: Deliberate forgery on a class-one object is outside the threat model] [WhenThen: 1,2] section 11 states the principle", () => {
  assertLocked(principleParagraph(), PRINCIPLE_ANCHORS, `${DESIGN_CORE} §11 原則段`);
  const spec = read(SPEC_DESIGN_CORE);
  const body = scenarioBody(spec, "Deliberate forgery on a class-one object is outside the threat model");
  for (const needle of ["MUST NOT be raised to WARN or Critical", "MUST NOT demand keys, signatures, terminal-only steps, or personal user operations"]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
});

test("[Scenario: design-core :: Class two stays adversarial under the accident-only principle] [WhenThen: 1,2] section 11 keeps class two as the only exception", () => {
  const paragraph = principleParagraph();
  assert.ok(paragraph.includes("唯一例外是下方 class two"), "principle must name class two as the only exception");
  assert.ok(paragraph.includes("維持 adversarial"), "principle must keep class two adversarial");
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "Class two stays adversarial under the accident-only principle");
  for (const needle of ["MUST remain Critical under the class-two adversarial standard", "MUST NOT be cited to lower it"]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
});

test("[Scenario: design-core :: An accidental wrong record on a class-one object stays Critical] [WhenThen: 1,2] F-9 and the spec keep accidental production Critical", () => {
  const f9 = f9Row();
  assert.ok(f9.includes("會不小心產生而閘沒擋住的仍 **Critical**"), "F-9 must keep an accidentally-producible unblocked record Critical");
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "An accidental wrong record on a class-one object stays Critical");
  for (const needle of ["MUST remain Critical", "written before the answer, for another change or pull request"]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
});

test("section 11 principle mutation probes: each load-bearing edit is rejected", () => {
  probe({
    block: principleParagraph(),
    anchors: PRINCIPLE_ANCHORS,
    predicate: (b) => missingAnchors(b, PRINCIPLE_ANCHORS),
    mutants: [
      ["deliberate forgery pulled back into the threat model", (b) => b.replace("不在威脅模型內", "在威脅模型內")],
      ["class two folded into the accident-only scope", (b) => b.replace("唯一例外是下方 class two", "例外包含下方 class two 以外")],
    ],
  });
});

// ---------------------------------------------------------------------------
// 3. Residual rule items 1-2
// ---------------------------------------------------------------------------
const RESIDUAL_MARKER = "**Residual rule（三段，缺一不可）**";
const RESIDUAL_ANCHORS = [
  ["第 1 段：依治理對象的性質判定", "依治理對象的**性質**判定"],
  [
    "第 1 段：產品安全或合規產出 → class two",
    "治理產品安全或合規產出（PII、憑證／secret、attribution／brand、injection／CodeQL 等產品安全、第三方授權，以及保護上述物件之閘的可見性）→ class two",
  ],
  ["第 1 段：其餘流程遵循 → class one", "其餘治理 AI 自身流程遵循者 → class one"],
  ["第 2 段：舉證責任落在主張 class two 的一方", "落在**主張 class two 的一方**"],
  ["第 2 段：指不出來就是 class one", "指不出來就是 class one"],
  ["第 2 段：故意繞過不構成 class two 理由", "「AI 可能故意繞過或偽造」不構成 class two 的理由"],
  ["第 3 段：修改路徑唯一", "增刪兩表的具名列須走**獨立 change**"],
];

function residualBlock() {
  const s11 = section11();
  const start = s11.indexOf(RESIDUAL_MARKER);
  assert.notEqual(start, -1, `${DESIGN_CORE} §11: 缺 residual rule 標記`);
  const end = s11.indexOf("**軸 B", start);
  assert.ok(end > start, `${DESIGN_CORE} §11: residual rule 後缺軸 B 界標`);
  return s11.slice(start, end);
}

test("[Scenario: design-core :: An unlisted or arguable governance object is classified by its nature] [WhenThen: 1,2,3] residual rule classifies by nature with the burden on the class-two claimant", () => {
  assertLocked(residualBlock(), RESIDUAL_ANCHORS, `${DESIGN_CORE} §11 residual rule`);
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "An unlisted or arguable governance object is classified by its nature");
  for (const needle of ["MUST be classified by its nature", "whoever claims class two, who MUST name the protected product security or compliance output"]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
});

test("residual rule mutation probes: nature rule, burden direction, and the retired default are rejected", () => {
  probe({
    block: residualBlock(),
    anchors: RESIDUAL_ANCHORS,
    predicate: (b) => missingAnchors(b, RESIDUAL_ANCHORS),
    mutants: [
      ["burden flipped to the class-one claimant", (b) => b.replace("落在**主張 class two 的一方**", "落在**主張 class one 的一方**")],
      ["unlisted objects default to class two again", (b) => b.replace("依治理對象的**性質**判定", "一律**適用 class two")],
    ],
  });
});

// ---------------------------------------------------------------------------
// 4. F-6 / F-7 / F-9
// ---------------------------------------------------------------------------
function rowOf(id) {
  const rows = section11().split("\n").filter((line) => line.startsWith(`| ${id} |`));
  assert.equal(rows.length, 1, `§11 必須恰有一列 ${id}，實際 ${rows.length}`);
  return rows[0];
}
const f9Row = () => rowOf("F-9");

const F6_ANCHORS = [
  ["兩表只是具名列", "兩表只是具名列"],
  ["未列者依性質判定", "未列者依 residual 第 1、2 段看治理對象性質"],
  ["主張 class two 須指出產出", "主張 class two 須指出保護的產品安全或合規產出"],
];
const F7_ANCHORS = [
  ["新閘與舊閘同樣依性質判定", "新閘與舊閘同樣依 residual 第 1 段判定"],
  ["不因新舊預設任一類", "不因新舊預設任一類"],
];
const F9_ANCHORS = [
  ["能力論證：寫得出不等於 Critical", "AI 用普通指令就**寫得出**這筆同意紀錄或 sticky"],
  ["看會不會不小心", "class one 物件的嚴重度看 AI 正常工作中**會不會不小心**產生錯誤紀錄"],
  ["不小心的情境清單", "作答前就寫、寫到別的 change／PR、內容與答覆不符、沿用舊紀錄、AI 自行推斷同意"],
  ["不小心產生而閘沒擋住仍 Critical", "會不小心產生而閘沒擋住的仍 **Critical**"],
  ["存心偽造不在威脅模型內", "只有存心才做得到的偽造不在威脅模型內"],
  ["MUST NOT 據以判 WARN 或 Critical", "**MUST NOT** 據以判 WARN 或 Critical"],
  ["不得要求金鑰、簽章、終端機限定、親自操作", "也不得要求金鑰、簽章、終端機限定或使用者親自操作"],
  ["存心混淆最多 Suggestion", "最多 Suggestion"],
  ["class two 含 attribution footer 維持 adversarial", "class two 物件（含 attribution footer）不適用本列，維持 adversarial"],
  ["class two 普通指令偽造仍 Critical", "AI 以**普通指令**（含 repo 推薦的 heredoc、先寫 body 檔再 `--body-file`）就做得到、而閘沒擋住的偽造仍 **Critical**"],
  ["指向通則 consent-record-residual", "通則 `consent-record-residual`"],
  ["既有實例 batch", "既有實例為具名殘留例外 `batch-scope-record-residual`"],
];

test("section 11 F-6, F-7 and F-9 carry the nature rule and the accident-only capability rebuttal", () => {
  assertLocked(rowOf("F-6"), F6_ANCHORS, `${DESIGN_CORE} §11 F-6`);
  assertLocked(rowOf("F-7"), F7_ANCHORS, `${DESIGN_CORE} §11 F-7`);
  assertLocked(f9Row(), F9_ANCHORS, `${DESIGN_CORE} §11 F-9`);
});

test("section 11 F-6, F-7 and F-9 mutation probes: each row loses discrimination when edited", () => {
  probe({
    block: rowOf("F-6"),
    anchors: F6_ANCHORS,
    predicate: (b) => missingAnchors(b, F6_ANCHORS),
    mutants: [["silence argument reverts to unlisted => class two", (b) => b.replace("未列者依 residual 第 1、2 段看治理對象性質", "未列即 class two")]],
  });
  probe({
    block: rowOf("F-7"),
    anchors: F7_ANCHORS,
    predicate: (b) => missingAnchors(b, F7_ANCHORS),
    mutants: [["novelty argument reverts to new gate => class two", (b) => b.replace("新閘與舊閘同樣依 residual 第 1 段判定", "新閘預設 class two")]],
  });
  probe({
    block: f9Row(),
    anchors: F9_ANCHORS,
    predicate: (b) => missingAnchors(b, F9_ANCHORS),
    mutants: [
      ["accidental record downgraded", (b) => b.replace("會不小心產生而閘沒擋住的仍 **Critical**", "會不小心產生而閘沒擋住的最多 Suggestion")],
      ["class two folded into the accident-only row", (b) => b.replace("class two 物件（含 attribution footer）不適用本列，維持 adversarial", "class two 物件（含 attribution footer）同樣適用本列")],
    ],
  });
});

test("[Scenario: design-core :: Compliance evidence is judged by accident on class one and by adversary on class two] [WhenThen: 1,2,3,4] spec and F-9 agree", () => {
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "Compliance evidence is judged by accident on class one and by adversary on class two");
  for (const needle of [
    "ACCIDENTALLY produce the wrong record",
    "MUST NOT be raised to WARN or Critical",
    "at most as a Suggestion",
    "attribution footer included",
  ]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
  assert.ok(f9Row().includes("class two 物件（含 attribution footer）不適用本列"), "F-9 must keep class two out of the accident-only row");
});

// ---------------------------------------------------------------------------
// 5. consent-record-residual
// ---------------------------------------------------------------------------
const CONSENT_MARKER = "**F-9 通則 `consent-record-residual`";
const CONSENT_ANCHORS = [
  ["作答之後代寫", "AI 在使用者於對話中作答**之後**依答覆代寫"],
  ["使用時有閘檢查", "使用時有閘檢查該紀錄（存在、格式、綁定的 change／branch／PR，或與 PR 行對照）"],
  ["沒有閘能證明使用者真的作答過", "沒有閘能證明使用者真的作答過"],
  ["最多 INFO", "這項**結構殘留**最多 INFO"],
  ["MUST NOT 升 WARN 或 Critical", "**MUST NOT** 升 WARN 或 Critical"],
  ["不得要求金鑰、簽章、終端機限定或使用者親自操作的步驟", "不得要求金鑰、簽章、終端機限定或使用者親自操作的步驟"],
  [
    "不涵蓋：作答前／不符／別的 PR／AI 推斷",
    "審查材料顯示沒問過或尚未作答、紀錄寫於作答之前、紀錄與答覆不符、紀錄屬於別的 change 或 PR，或 AI 自行推斷同意，屬不小心產生的錯誤紀錄，依 F-9 判定",
  ],
  ["不涵蓋：使用時無閘檢查", "使用時沒有任何閘檢查的紀錄不適用本通則"],
  ["不涵蓋：class two", "class two 物件不適用"],
  ["新同意紀錄直接適用、不再開具名例外", "新的同意紀錄直接適用本通則，**不再**逐條開具名例外"],
  ["兩個具名例外是既有實例", "下方兩個具名例外是本通則的既有實例"],
  ["具名例外的封閉句只界定自身", "各自的封閉句只界定該例外自身範圍，不限制本通則"],
  ["獨立 change 並經使用者 merge", "增刪改本通則須走獨立 change，並經使用者 merge 才有權威"],
  ["自我適用：diff 新增、移除或改寫本通則條文本身", "審查範圍的 diff 新增、移除或改寫本通則條文本身時"],
  ["自我適用：該次審查沒有效力", "本通則在該次審查沒有效力"],
  ["自我適用：如同本通則不存在", "如同本通則不存在"],
  ["規則同步適用時點", "自該同步 PR 合併後的下一次審查起才有效力"],
  ["只決定 review severity、不改 enforcement", "本通則只決定 review severity，不改任何閘的 enforcement（No-downgrade）"],
  ["不影響軸 B 問 1", "不影響軸 B 問 1"],
  ["reviewer 可達載體", "reviewer 讀得到的載體是 packet static duty"],
];

function consentParagraph() {
  return paragraphWith(read(DESIGN_CORE), CONSENT_MARKER, "consent-record-residual paragraph");
}

test("[Scenario: design-core :: A checked consent record's structural residual is bounded at INFO] [WhenThen: 1,2,3] general clause caps the residual at INFO", () => {
  const paragraph = consentParagraph();
  assertLocked(paragraph, CONSENT_ANCHORS, `${DESIGN_CORE} consent-record-residual 通則`);
  assert.equal(read(DESIGN_CORE).split(CONSENT_MARKER).length - 1, 1, "consent-record-residual is defined exactly once");
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "A checked consent record's structural residual is bounded at INFO");
  for (const needle of ["at most INFO and MUST NOT be raised to WARN or Critical", "MAY name `consent-record-residual` as its basis"]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
});

test("[Scenario: design-core :: A consent record shown wrong is judged by the forgery rebuttal] [WhenThen: 1,2] shown-wrong records stay under F-9", () => {
  const paragraph = consentParagraph();
  assert.ok(paragraph.includes("屬不小心產生的錯誤紀錄，依 F-9 判定"), "shown-wrong records must be judged by F-9");
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "A consent record shown wrong is judged by the forgery rebuttal");
  for (const needle of ["MUST be judged under the forgery rebuttal", "MUST remain Critical"]) {
    assert.ok(body.includes(needle), `scenario body must carry ${JSON.stringify(needle)}`);
  }
});

test("[Scenario: design-core :: The general clause does not cover unchecked records or class two] [WhenThen: 1] clause is closed in scope", () => {
  const paragraph = consentParagraph();
  assert.ok(paragraph.includes("使用時沒有任何閘檢查的紀錄不適用本通則"), "unchecked records must be out of scope");
  assert.ok(paragraph.includes("class two 物件不適用"), "class two must be out of scope");
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "The general clause does not cover unchecked records or class two");
  assert.ok(body.includes("the citation MUST be refused"), "scenario body must refuse the citation");
});

test("[Scenario: design-core :: The general clause has no force in the review of the change that edits it] [WhenThen: 1,2] self-application", () => {
  const paragraph = consentParagraph();
  for (const needle of ["審查範圍的 diff 新增、移除或改寫本通則條文本身時", "本通則在該次審查沒有效力", "如同本通則不存在"]) {
    assert.ok(paragraph.includes(needle), `consent clause must carry ${JSON.stringify(needle)}`);
  }
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "The general clause has no force in the review of the change that edits it");
  assert.ok(body.includes("MUST have no force in that review"), "scenario body must state no force");
});

test("[Scenario: design-core :: New consent records use the general clause directly] [WhenThen: 1,2] no further named exceptions", () => {
  const paragraph = consentParagraph();
  assert.ok(paragraph.includes("新的同意紀錄直接適用本通則，**不再**逐條開具名例外"), "new records must use the clause directly");
  assert.ok(paragraph.includes("下方兩個具名例外是本通則的既有實例"), "the two named exceptions are existing instances");
  const body = scenarioBody(read(SPEC_DESIGN_CORE), "New consent records use the general clause directly");
  assert.ok(body.includes("MUST NOT add a further per-record named exception"), "scenario body must forbid further named exceptions");
});

test("consent-record-residual mutation probes: each load-bearing edit is rejected", () => {
  const instanceMarker = "**F-9 具名殘留例外 `batch-scope-record-residual`";
  const source = read(DESIGN_CORE);
  assert.ok(source.indexOf(CONSENT_MARKER) < source.indexOf(instanceMarker), "the general clause sits before its named instances");
  probe({
    block: consentParagraph(),
    anchors: CONSENT_ANCHORS,
    predicate: (b) => missingAnchors(b, CONSENT_ANCHORS),
    mutants: [
      ["INFO cap raised to WARN", (b) => b.replace("這項**結構殘留**最多 INFO", "這項**結構殘留**最多 WARN")],
      ["keys/signatures demand allowed", (b) => b.replace("不得要求金鑰、簽章、終端機限定或使用者親自操作的步驟", "可要求金鑰或簽章")],
      ["not-covered list deleted", (b) => b.replace("使用時沒有任何閘檢查的紀錄不適用本通則", "")],
      ["class two brought into the clause", (b) => b.replace("class two 物件不適用", "class two 物件亦適用")],
      ["self-application deleted", (b) => b.replace("本通則在該次審查沒有效力", "本通則在每次審查都有效力")],
    ],
  });
});

// ---------------------------------------------------------------------------
// 6. rationalizations row
// ---------------------------------------------------------------------------
const RATIONALIZATION_ANCHORS = [
  ["錯誤論證：AI 可能故意偽造", "「AI 可能故意偽造這筆紀錄／繞過這個閘，所以要加終端機限定、金鑰、簽章，或要使用者親自操作、親自去 GitHub 留言」"],
  ["過度設計", "過度設計"],
  ["閘只防 AI 不小心、不防故意", "閘只防 AI 不小心、不防故意（產品安全與合規除外）"],
  ["指向 §11 原則與 F-9", "見 `design-core.md` §11 原則與 F-9"],
  ["要防的是不小心", "作答前就寫、寫錯 change／PR、沿用舊紀錄這類不小心"],
];

function rationalizationRow() {
  const rows = read(RATIONALIZATIONS).split("\n").filter((line) => line.startsWith("|") && line.includes("AI 可能故意偽造這筆紀錄"));
  assert.equal(rows.length, 1, `${RATIONALIZATIONS}: 必須恰有一列 accident-only 反合理化，實際 ${rows.length}`);
  return rows[0];
}

test("rationalizations table carries the accident-only refusal row", () => {
  assertLocked(rationalizationRow(), RATIONALIZATION_ANCHORS, `${RATIONALIZATIONS} accident-only row`);
});

test("rationalizations accident-only row mutation probes: each anchor and a class-two widening are rejected", () => {
  probe({
    block: rationalizationRow(),
    anchors: RATIONALIZATION_ANCHORS,
    predicate: (b) => missingAnchors(b, RATIONALIZATION_ANCHORS),
    mutants: [["class-two exception dropped", (b) => b.replace("（產品安全與合規除外）", "")]],
  });
});

// ---------------------------------------------------------------------------
// 7. Packet static duty (reviewer-reachable)
// ---------------------------------------------------------------------------
const PACKET_BULLET_ANCHOR = "class-one gate's adversarial bypass narrative is at most a Suggestion";
const PRINCIPLE_SENTENCE =
  "gates and reviews guard against the AI's accidental mistakes in normal work, not deliberate forgery or deliberate bypass (design-core §11 principle), and class-two objects are the only exception and stay adversarial";
const RELAY_SENTENCE = "decided by that gate's own contract, not by this severity rule";
const BATCH_START = "One closed, user-ruled residual exception applies";
const UNLISTED_GUARD =
  "A governance object listed in neither §11 table is classified by its nature: one that protects product security or compliance output is class two and MUST NOT receive this ceiling; any other AI-process-adherence object is class one, and whoever claims class two must name the protected output";
const GENERAL_CLAUSE_START = "A general clause applies (design-core §11 `consent-record-residual`)";

const PACKET_ANCHORS = [
  ["accident-only 原則句", PRINCIPLE_SENTENCE],
  ["class-one 看不小心產生", "for a class-one object, severity follows whether normal work would accidentally produce a wrong record"],
  ["不小心的情境清單", "written before the user answered, for another change or PR, contradicting the answer, carried over from an older record, or inferred by the AI"],
  ["不小心產生而閘沒擋住仍 CRITICAL", "such an accidental wrong record that the gate fails to block remains CRITICAL"],
  [
    "存心偽造不得判 WARN/CRITICAL 且不得要求金鑰等",
    "a forgery only a deliberate act produces is outside the threat model, MUST NOT be raised to WARN or CRITICAL, and a reviewer MUST NOT demand keys, signatures, terminal-only steps, or personal user operations to close it",
  ],
  ["存心混淆最多 Suggestion", "a form reachable only through deliberate obfuscation is at most a Suggestion"],
  ["class two 含 attribution footer 普通指令偽造仍 CRITICAL", "on a class-two object, attribution footer included, a forgery the AI can produce with an ordinary command remains CRITICAL when the gate fails to block it"],
  ["對稱句涵蓋 deliberate-forgery", "to close a deliberate-forgery or deliberate-obfuscation gap"],
  ["通則句：識別字", GENERAL_CLAUSE_START],
  ["通則句：作答後代寫、使用時有閘檢查", "a consent record the AI writes after the user answers in the conversation, checked by a gate when used (presence, format, the bound change, branch, or PR, or a match against a PR line)"],
  ["通則句：沒有閘能證明使用者真的作答", "carries the structural residual that no gate can prove the user really answered"],
  [
    "通則句：最多 INFO、不得升 WARN/CRITICAL、不得要求金鑰等",
    "that residual alone is at most INFO, MUST NOT be raised to WARN or CRITICAL, and a reviewer MUST NOT demand keys, signatures, terminal-only steps, or personal user operations to close it",
  ],
  [
    "通則句：不涵蓋清單",
    "it does not cover a record the review material shows was written before or without the answer, against the answer, for another change or PR, or by AI inference, nor a record no gate checks when used, nor a class-two object",
  ],
  ["通則句：自我適用", "the clause has no effect in a review whose diff adds, removes, or rewrites its own text"],
  ["通則句：具名例外是既有實例", "the named exceptions below are its existing instances"],
  ["unlisted guard 依性質判定", UNLISTED_GUARD],
];

function packetBullet() {
  const prefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky");
  const lines = prefix.split("\n").filter((line) => line.startsWith("- ") && line.includes(PACKET_BULLET_ANCHOR));
  assert.equal(lines.length, 1, `packet 必須恰有一個含 ${JSON.stringify(PACKET_BULLET_ANCHOR)} 的 duty bullet，實際 ${lines.length}`);
  return lines[0];
}

function packetProblems(duty) {
  const problems = missingAnchors(duty, PACKET_ANCHORS);
  if (duty.includes("\n")) problems.push("severity duty must stay a single bullet line");
  const relay = duty.indexOf(RELAY_SENTENCE);
  const general = duty.indexOf(GENERAL_CLAUSE_START);
  const batch = duty.indexOf(BATCH_START);
  const unlisted = duty.indexOf(UNLISTED_GUARD);
  if (!(relay !== -1 && general > relay)) problems.push("通則句須在代發核准歸屬句（A7）之後");
  if (!(batch !== -1 && general !== -1 && general < batch)) problems.push("通則句須在 batch 具名例外句之前");
  if (!(unlisted !== -1 && batch < unlisted)) problems.push("unlisted guard 須在 batch 例外之後");
  const principle = duty.indexOf(PRINCIPLE_SENTENCE);
  if (!(principle !== -1 && principle < relay)) problems.push("accident-only 原則句須在 A7 之前、與 ceiling 同行");
  for (const retired of RETIRED_PHRASES) {
    if (duty.includes(retired)) problems.push(`已退役的字面仍在 packet bullet：${retired}`);
  }
  return problems;
}

test("packet static duty carries the accident-only principle, the class-one accident criterion and the consent-record-residual clause on the ceiling line", () => {
  const problems = packetProblems(packetBullet());
  assert.deepEqual(problems, [], `packet severity bullet：${problems.join("；")}`);
});

test("packet static duty mutation probes: every anchor, placement and the retired default are rejected", () => {
  const duty = packetBullet();
  probe({
    block: duty,
    anchors: PACKET_ANCHORS,
    predicate: packetProblems,
    mutants: [
      ["general clause split onto its own bullet", (d) => d.replace(GENERAL_CLAUSE_START, `\n- ${GENERAL_CLAUSE_START}`)],
      [
        "general clause moved after the batch exception",
        (d) => {
          const start = d.indexOf(GENERAL_CLAUSE_START);
          const batch = d.indexOf(BATCH_START);
          const clause = d.slice(start, batch);
          const unlisted = d.indexOf(UNLISTED_GUARD);
          return d.slice(0, start) + d.slice(batch, unlisted) + clause + d.slice(unlisted);
        },
      ],
      ["unlisted guard reverts to default class two", (d) => d.replace(UNLISTED_GUARD, "A governance object outside §11's closed class-one enumeration defaults to class two and MUST NOT receive this ceiling")],
      ["INFO cap raised to WARN", (d) => d.replace("that residual alone is at most INFO, MUST NOT be raised to WARN or CRITICAL", "that residual alone is at most WARN")],
      ["class two folded into the accident-only principle", (d) => d.replace("class-two objects are the only exception and stay adversarial", "class-two objects follow the same principle")],
    ],
  });
});

test("the packet general-clause sentence is rendered in the static prefix, so a reviewer CLI with --ignore-rules can read it", () => {
  const prefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky");
  assert.ok(prefix.includes(GENERAL_CLAUSE_START), "packet static prefix must carry the general clause");
});

// ---------------------------------------------------------------------------
// 8. Spec requirements and scenario titles
// ---------------------------------------------------------------------------
function scenarioBody(spec, title) {
  const heading = `#### Scenario: ${title}`;
  const at = spec.indexOf(heading);
  assert.notEqual(at, -1, `spec 缺 ${JSON.stringify(heading)}`);
  const rest = spec.slice(at + heading.length);
  const end = rest.search(/\n#{3,4} /);
  return end === -1 ? rest : rest.slice(0, end);
}

function requirementBody(spec, title) {
  const heading = `### Requirement: ${title}`;
  const at = spec.indexOf(heading);
  assert.notEqual(at, -1, `spec 缺 ${JSON.stringify(heading)}`);
  const rest = spec.slice(at + heading.length);
  const end = rest.search(/\n### Requirement: /);
  return end === -1 ? rest : rest.slice(0, end);
}

const SPEC_REQUIREMENTS = [
  "Gate Threat Model Guards Against Accidental Mistakes, Not Deliberate Forgery",
  "Consent Records Carry A General Accident-Only Residual Clause",
];
const SPEC_SCENARIOS = [
  "Deliberate forgery on a class-one object is outside the threat model",
  "Class two stays adversarial under the accident-only principle",
  "An accidental wrong record on a class-one object stays Critical",
  "A checked consent record's structural residual is bounded at INFO",
  "A consent record shown wrong is judged by the forgery rebuttal",
  "The general clause does not cover unchecked records or class two",
  "The general clause has no force in the review of the change that edits it",
  "New consent records use the general clause directly",
  "An unlisted or arguable governance object is classified by its nature",
  "Compliance evidence is judged by accident on class one and by adversary on class two",
];

test("canonical design-core spec carries the two new requirements and every new or re-worded scenario title", () => {
  const spec = read(SPEC_DESIGN_CORE);
  for (const title of SPEC_REQUIREMENTS) {
    assert.ok(spec.includes(`### Requirement: ${title}`), `design-core spec 缺 requirement ${JSON.stringify(title)}`);
  }
  for (const title of SPEC_SCENARIOS) {
    assert.ok(spec.includes(`#### Scenario: ${title}`), `design-core spec 缺 scenario ${JSON.stringify(title)}`);
  }
});

test("canonical design-core spec requirement bodies keep the principle, the clause and the class-two exception", () => {
  const spec = read(SPEC_DESIGN_CORE);
  const principle = requirementBody(spec, SPEC_REQUIREMENTS[0]);
  for (const needle of ["ACCIDENTAL mistakes", "OUTSIDE the threat model", "The sole exception SHALL be class two"]) {
    assert.ok(principle.includes(needle), `principle requirement must carry ${JSON.stringify(needle)}`);
  }
  const clause = requirementBody(spec, SPEC_REQUIREMENTS[1]);
  for (const needle of [
    "`consent-record-residual`",
    "at most INFO",
    "terminal-only steps, or personal user operations",
    "SHALL NOT receive a further per-record named exception",
    "no force and consent records SHALL be judged under the forgery rebuttal",
  ]) {
    assert.ok(clause.includes(needle), `consent clause requirement must carry ${JSON.stringify(needle)}`);
  }
});

test("canonical specs mutation probes: a deleted requirement or a widened clause is rejected", () => {
  const spec = read(SPEC_DESIGN_CORE);
  const fullClause = requirementBody(spec, SPEC_REQUIREMENTS[1]);
  // Requirement prose only: the scenarios below repeat some phrases, which would mask a removal in the prose.
  const clause = fullClause.slice(0, fullClause.indexOf("#### Scenario:"));
  const needles = [
    "at most INFO",
    "terminal-only steps, or personal user operations",
    "SHALL NOT receive a further per-record named exception",
  ].map((n) => [n, n]);
  probe({
    block: clause,
    anchors: needles,
    predicate: (b) => missingAnchors(b, needles),
    mutants: [["INFO raised to WARN", (b) => b.replace("at most INFO", "at most WARN")]],
  });
  const withoutTitle = spec.replace(`### Requirement: ${SPEC_REQUIREMENTS[0]}`, "### Requirement: Something Else");
  assert.equal(withoutTitle.includes(`### Requirement: ${SPEC_REQUIREMENTS[0]}`), false, "title-removal mutant must change the spec");
});

test("code-review-checklist spec aligns the severity requirement with the accident-only packet text", () => {
  const spec = read(SPEC_CHECKLIST);
  const full = requirementBody(spec, "Review Severity Aligns With Gate Threat Model Class");
  // Requirement prose only: scenarios below repeat some phrases, which would mask a removal in the prose.
  const body = full.slice(0, full.indexOf("#### Scenario:"));
  const anchors = [
    ["accident-only 原則", "Gates and reviews guard against the AI's accidental mistakes in normal work, not deliberate forgery or deliberate bypass"],
    ["class-one 看不小心產生", "severity follows whether normal work would accidentally produce a wrong record"],
    ["unlisted 依性質判定", "a governance object listed in neither §11 table is classified by its nature"],
    ["通則 consent-record-residual", "`consent-record-residual`"],
    ["對稱句涵蓋 deliberate-forgery", "deliberate-forgery or deliberate-obfuscation gap"],
    ["class two 含 attribution footer", "On a class-two object, attribution footer included"],
  ];
  assertLocked(body, anchors, `${SPEC_CHECKLIST} Review Severity Aligns With Gate Threat Model Class`);
  probe({
    block: body,
    anchors,
    predicate: (b) => missingAnchors(b, anchors),
    mutants: [["unlisted default reverts to class two", (b) => b.replace("a governance object listed in neither §11 table is classified by its nature", "a governance object outside §11's closed class-one enumeration defaults to class two")]],
  });
});

// ---------------------------------------------------------------------------
// 9. Negatives: the retired statements appear in no carrier
// ---------------------------------------------------------------------------
const RETIRED_PHRASES = ["一律**適用 class two", "未列即 class two", "新閘預設 class two", "defaults to class two"];

test("the retired unlisted-means-class-two statements appear in no carrier", () => {
  const hits = [];
  for (const rel of CARRIERS) {
    const text = read(rel);
    for (const phrase of RETIRED_PHRASES) {
      if (text.includes(phrase)) hits.push(`${rel}: ${phrase}`);
    }
  }
  assert.deepEqual(hits, [], `已退役的 unlisted ⇒ class two 字面仍存在：${hits.join("；")}`);
});

test("retired-phrase negative mutation probe: re-introducing a retired phrase is detected", () => {
  const detect = (text) => RETIRED_PHRASES.filter((phrase) => text.includes(phrase));
  const control = read(DESIGN_CORE);
  assert.deepEqual(detect(control), [], "control must be clean");
  for (const phrase of RETIRED_PHRASES) {
    assert.notDeepEqual(detect(`${control}\n${phrase}`), [], `re-introducing ${JSON.stringify(phrase)} must be detected`);
  }
});

// ---------------------------------------------------------------------------
// 10. Known-nature vs undeterminable (PR #3500 second opinion W1-classification-fallback):
//     an unlisted object whose governance the material shows and for which no protected output can
//     be named is class one; only material that does not show what the object governs or protects
//     leaves the class undetermined, and then the ceiling is not applied. Each carrier states both
//     halves, and the "undetermined" half stays in front of the carrier's no-ceiling guard.
// ---------------------------------------------------------------------------
const KNOWN_NATURE_EN = "an object whose governance the packet shows but for which no protected output can be named is class one";
const UNDETERMINED_EN = "only a packet that does not show what the object governs or protects leaves the class undetermined, in which case the reviewer states that evidence limitation";
const UNDETERMINED_CARRIERS = [
  [".devpro/agent-rules/code-review-cross-model.md", "class 無法由當前 packet 判定時 MUST NOT 套用此 ceiling。"],
  [".devpro/agent-skills/devpro-reviews/second-review/SKILL.md", "class 無法由當前 packet 判定時 MUST NOT 套用此 ceiling。"],
  [".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md", "class 不可由本 packet 判定時不得套用此 ceiling。"],
  [SPEC_CHECKLIST, "when the governance-object class cannot be determined from the packet alone, the ceiling MUST NOT be applied."],
];

function undeterminedOrderErrors(text, guard) {
  const errors = [];
  const known = text.indexOf(KNOWN_NATURE_EN);
  const undetermined = text.indexOf(UNDETERMINED_EN);
  const at = text.indexOf(guard);
  if (known === -1) errors.push("known-nature half missing");
  if (undetermined === -1) errors.push("undetermined half missing");
  if (at === -1) errors.push("no-ceiling guard missing");
  if (errors.length === 0 && !(known < undetermined && undetermined < at)) errors.push("order must be known-nature, undetermined, guard");
  return errors;
}

test("every reviewer carrier separates a known-nature unlisted object from an undeterminable one", () => {
  for (const [rel, guard] of UNDETERMINED_CARRIERS) {
    assert.deepEqual(undeterminedOrderErrors(read(rel), guard), [], `${rel}: known-nature / undetermined split`);
  }
  const packet = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky");
  assert.deepEqual(
    undeterminedOrderErrors(packet, "when the governance-object class is not determinable from this packet the ceiling MUST NOT be applied."),
    [],
    "packet static duty: known-nature / undetermined split"
  );
});

test("design-core section 11 and its canonical spec state that undeterminable material is not class one", () => {
  const sec = section11();
  assert.ok(sec.includes("「指不出」以看得到它管什麼為前提"), "section 11 residual 2 must condition 指不出 on a visible governance object");
  assert.ok(sec.includes("審查材料連它管什麼、保護什麼都看不出時屬證據不足，不算 class one"), "section 11 residual 2 must name the evidence-limitation case");
  const spec = read(SPEC_DESIGN_CORE);
  assert.ok(spec.includes("failing to name one makes it class one when what the object governs is known"), "design-core spec residual rule must condition class one on a known governance object");
  assert.ok(spec.includes("failing to name one MUST make it class one only when what the object governs is known"), "design-core spec scenario must carry the known-nature condition");
});

test("known-nature / undetermined split mutation probe: dropping either half or reordering is rejected", () => {
  const rel = UNDETERMINED_CARRIERS[0][0];
  const guard = UNDETERMINED_CARRIERS[0][1];
  const text = read(rel);
  assert.deepEqual(undeterminedOrderErrors(text, guard), [], "control must pass");
  assert.notDeepEqual(undeterminedOrderErrors(text.replace(KNOWN_NATURE_EN, ""), guard), [], "dropping the known-nature half must be rejected");
  assert.notDeepEqual(undeterminedOrderErrors(text.replace(UNDETERMINED_EN, ""), guard), [], "dropping the undetermined half must be rejected");
  const moved = text.replace(`${UNDETERMINED_EN}; `, "").replace(guard, `${guard} ${UNDETERMINED_EN}.`);
  assert.notDeepEqual(undeterminedOrderErrors(moved, guard), [], "moving the undetermined half after the guard must be rejected");
});
