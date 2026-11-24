// Guard for `design-core.md` §11 (Mechanical Gate Threat Model).
//
// 保證上限（與 §11 的「保證上限（誠實聲明）」對稱，MUST NOT 誇大）：
//   本 guard 只鎖「條文字面是否存在」——具名 8 條（例示）+ 6 個 floor 的 governance object、
//   residual rule 三段（依性質判定／舉證責任在主張 class two 者／修改路徑唯一）、軸 B 三問與 tie-breaker 與具名非例、軸 C 正交、
//   derived-class 取最強、no-downgrade、以及 F-1…F-10 十條具名反濫用，
//   另含 F-9 內容錨（反濫用核心「恆 in-scope」、普通指令偽造仍 Critical、class-one 存心混淆
//   才做得到者最多 Suggestion、class-one 對稱條款與允許性證據）。
//   它 MUST NOT 被宣稱為「驗證某個閘被正確分類」或「驗證條文被遵守」——
//   那是語意判斷，靠 review 與跨模型第二意見，不進 CI hard fail。
//   D6 集合相等的比對對象＝投影列舉區塊內 `kebab（中文 gloss）` 配對的識別字面，
//   且 MUST 依類分段比對（class one 段／class two floor 段各一次）——只比聯集的話，
//   把字面跨類搬移不改變聯集，改判會保持綠燈。SSOT 側同樣從 §11 兩張表格各自抽列，
//   不以本檔常數為權威（常數只當 sanity floor）。兩段內其餘 kebab 字面須逐一列進
//   對應的 PROSE_VOCABULARY，新字面一律先紅（fail closed）。
//   另鎖 §11 具名殘留例外 `batch-scope-record-residual` 的字面（兩載體、依據、補償控制、封閉句、
//   自我適用句），與 F-9 列尾指向；同樣只鎖字面、不驗遵守。
// 失敗訊息一律指名缺的是哪一條，讓刪條款的人立刻知道踩到什麼。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { repoPath } from "./lib/repo-root.mjs";

const DESIGN_CORE = ".devpro/agent-rules/design-core.md";
// D6 具名例外：dispatch-time inline projection 逐字複製封閉列舉（外部 reviewer CLI
// 不 lazy-load rule leaf），代價是必須由本 guard 鎖住兩邊集合相等，副本才不會無聲過期。
const DISPATCH_PROJECTION =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const source = readFileSync(repoPath(DESIGN_CORE), "utf8");

const CLASS_ONE_OBJECTS = Object.freeze([
  "branch-and-worktree-placement",
  "workflow-and-openspec-state-integrity",
  "release-and-distribution-lane",
  "agent-run-cost-budget",
  "process-hygiene-reminders",
  "repo-scope-consent",
  "destructive-ref-and-history-rewrite",
  "second-review-admission",
]);

const CLASS_TWO_FLOOR = Object.freeze([
  "document-and-payload-privacy",
  "attribution-and-brand-leak-compliance",
  "credential-and-secret-handling",
  "product-security-scanning",
  "licensing-compliance",
  "gate-visibility",
]);

// 集合相等只在投影的列舉區塊內比對——區塊外還有大量與治理對象無關的 kebab 字面
// （pr-sticky、same-change-dp-change-batch…），全檔掃描無法區分，只能靠界標定界。
// 三個界標把區塊切成 class one 段與 class two floor 段，兩段各自比對（見 decisions.md D8）。
const ENUMERATION_BLOCK_START = "Scope（閘威脅模型依治理對象二分；SSOT design-core.md §11）：";
const ENUMERATION_BLOCK_MID = "其 floor 六項為";
const ENUMERATION_BLOCK_END = "——維持 fail-closed + Critical。";
const KEBAB = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;
// 治理對象在副本中一律寫成 `kebab（中文 gloss）`；緊接的全形左括號就是它與敘述用語的分界。
const GLOSSED_KEBAB = /([a-z][a-z0-9]*(?:-[a-z0-9]+)+)（/g;
// §11 兩張表格的首欄字面；SSOT 側以此為權威，本檔常數只當 sanity floor。
const SSOT_TABLE_ROW = /^\| `([a-z][a-z0-9-]*)` \|/gmu;
// amend-gate-threat-model-to-accident-only：class one 8 條由「封閉列舉」改為「具名例示」，標題字面隨之改；
// 兩表仍是各自抽列的 SSOT，未列者改依 residual rule 的「性質」判定。
const SSOT_CLASS_ONE_HEADING = "**具名 8 條**（例示，不是封閉清單；未列者依下方 residual rule 判定）：";
const SSOT_FLOOR_HEADING = "以下為 **floor 而非窮舉**：";
// 兩段內已知的非治理 kebab 敘述用語。新增任何一個都要在此具名，否則對應斷言先紅。
const CLASS_ONE_PROSE_VOCABULARY = Object.freeze([
  "cross-carrier",
  "design-core",
  "git-dir",
  "lazy-load",
  "whack-a-mole",
]);
const FLOOR_PROSE_VOCABULARY = Object.freeze(["fail-closed"]);

function ssotTableObjects(from, to) {
  const start = s11.indexOf(from);
  const end = to === null ? s11.length : s11.indexOf(to);
  assert.ok(
    start !== -1 && end > start,
    `${DESIGN_CORE} §11: 找不到表格界標 ${JSON.stringify(from)}——分類抽取無從進行`
  );
  return [...s11.slice(start, end).matchAll(SSOT_TABLE_ROW)].map((m) => m[1]).sort();
}

function projectionSegment(projection, from, to) {
  const start = projection.indexOf(from);
  const end = projection.indexOf(to);
  assert.ok(
    start !== -1 && end > start,
    `${DISPATCH_PROJECTION}: 找不到列舉區塊界標 ${JSON.stringify(from)} → ${JSON.stringify(to)}——` +
      `D6 副本 MUST 保留這三個界標，否則逐類集合相等無從比對`
  );
  const segment = projection.slice(start, end + to.length);
  const glossed = [...new Set([...segment.matchAll(GLOSSED_KEBAB)].map((m) => m[1]))].sort();
  const prose = [...new Set((segment.match(KEBAB) ?? []).filter((t) => !glossed.includes(t)))].sort();
  return { glossed, prose };
}

function enumerationSegments(projection) {
  return {
    classOne: projectionSegment(projection, ENUMERATION_BLOCK_START, ENUMERATION_BLOCK_MID),
    floor: projectionSegment(projection, ENUMERATION_BLOCK_MID, ENUMERATION_BLOCK_END),
  };
}

// Same four class-by-class comparisons the D6 test asserts, as a predicate so the mutation
// probes below can prove each comparison actually discriminates (a mutant must turn it false).
function enumerationAligned(projection, ssotClassOne, ssotFloor) {
  const { classOne, floor } = enumerationSegments(projection);
  return (
    isDeepStrictEqual(classOne.glossed, ssotClassOne) &&
    isDeepStrictEqual(floor.glossed, ssotFloor) &&
    isDeepStrictEqual(classOne.prose, CLASS_ONE_PROSE_VOCABULARY) &&
    isDeepStrictEqual(floor.prose, FLOOR_PROSE_VOCABULARY)
  );
}

function section11() {
  const start = source.indexOf("### 11. Mechanical Gate Threat Model");
  assert.notEqual(
    start,
    -1,
    `${DESIGN_CORE}: sanity floor failed — 找不到 "### 11. Mechanical Gate Threat Model" 標題`
  );
  const rest = source.slice(start + 4);
  const end = rest.indexOf("\n### ");
  return end === -1 ? source.slice(start) : source.slice(start, start + 4 + end);
}

const s11 = section11();

function requireClause(label, needle) {
  assert.ok(
    s11.includes(needle),
    `${DESIGN_CORE} §11: 缺少「${label}」條款——找不到字面 ${JSON.stringify(needle)}`
  );
}

test("§11 sanity floor: section exists and is non-trivial", () => {
  assert.ok(
    s11.length > 3000,
    `${DESIGN_CORE} §11: sanity floor failed — 區段只有 ${s11.length} bytes，疑似被清空或截斷`
  );
  requireClause("依治理對象二分（不依實作形式）", "不依實作形式");
});

test("§11 axis A: class-one closed enumeration keeps all 8 governance objects", () => {
  for (const object of CLASS_ONE_OBJECTS) {
    requireClause(`class one 封閉列舉 \`${object}\``, `\`${object}\``);
  }
  requireClause("具名 8 條的宣告（例示，非封閉清單）", "具名 8 條");
  requireClause("具名 8 條是例示而非封閉清單", "例示，不是封閉清單");
});

test("§11 axis A: class-two floor keeps all 6 governance objects", () => {
  for (const object of CLASS_TWO_FLOOR) {
    requireClause(`class two floor \`${object}\``, `\`${object}\``);
  }
  requireClause("class two 為 floor 而非窮舉", "floor 而非窮舉");
});

test("§11 residual rule keeps all three segments", () => {
  requireClause("residual 第 1 段（涵蓋面：依治理對象的性質判定）", "依治理對象的**性質**判定");
  requireClause("residual 第 2 段（舉證責任：落在主張 class two 的一方）", "落在**主張 class two 的一方**");
  requireClause("residual 第 3 段（修改路徑唯一）", "獨立 OpenSpec change");
});

test("§11 axis B keeps three questions, tie-breaker, and the named non-example", () => {
  requireClause("軸 B 與軸 A 正交宣告", "與上述分類正交");
  requireClause("軸 B 先命中先適用", "先命中先適用");
  requireClause("軸 B 問 1（書面契約要求存在且可解析 → fail closed）", "書面契約要求它此刻必須存在且可解析");
  requireClause("軸 B 問 2（執行期環境性質 → fail open + advisory）", "執行期環境性質");
  requireClause("軸 B 問 3（皆非 → fail closed 並記待分類缺口）", "待分類缺口");
  requireClause("軸 B tie-breaker（消耗唯一檢查點）", "唯一的檢查點");
  requireClause("軸 B 具名非例（resolver 內部保守 ≠ 閘層 fail closed）", "pre-tool-gate.mjs:5082");
});

test("§11 axis C stays orthogonal to the classification", () => {
  requireClause("軸 C 正交（BASELINE_GATE_IDS 成員資格無關）", "`BASELINE_GATE_IDS`");
  requireClause("軸 C 正交宣告", "與上述兩軸皆無關");
});

test("§11 derived class inherits the strongest, not the most common", () => {
  requireClause("derived class 取最強", "取最強，不是取多數");
  requireClause("derived class scoping（限能證明繞過 class-two 物件）", "class-two 物件");
});

test("§11 no-downgrade prohibits the inference form itself", () => {
  requireClause("no-downgrade：分類不決定 enforcement 強度", "**不決定** enforcement 強度");
  requireClause("no-downgrade：禁的是推論形態本身", "推論形態本身");
  requireClause("no-downgrade：對既有閘零行為 delta", "零行為 delta");
});

test("§11 keeps all ten named anti-abuse rebuttals F-1..F-10 with evidence", () => {
  const rows = s11
    .split("\n")
    .filter((line) => /^\| F-\d+ \|/.test(line));
  const seen = rows.map((line) => line.split("|")[1].trim());
  for (let n = 1; n <= 10; n += 1) {
    const id = `F-${n}`;
    assert.ok(
      seen.includes(id),
      `${DESIGN_CORE} §11: 缺少具名反濫用條款 ${id}——F-1…F-10 十條缺一不可`
    );
  }
  for (const line of rows) {
    const cells = line.split("|").map((cell) => cell.trim());
    // cells: ["", id, 錯誤論證, 反駁, evidence, ""]
    assert.equal(
      cells.length,
      6,
      `${DESIGN_CORE} §11: ${cells[1]} 的欄數不是 4（錯誤論證／反駁／evidence 缺欄）`
    );
    assert.notEqual(
      cells[4],
      "",
      `${DESIGN_CORE} §11: ${cells[1]} 的 evidence 欄為空——具名反駁 MUST 帶可查證據`
    );
  }
});

test("§11 declares its own guarantee ceiling and names this guard", () => {
  requireClause("保證上限誠實聲明", "保證上限（誠實聲明）");
  requireClause("保證上限指名本 guard", "gate-threat-model-classification-grep.test.mjs");
  requireClause("保證上限：禁寫成 CI hard fail", "MUST NOT** 把此語意判斷寫成 CI hard fail");
});

// 只有無法 lazy-load rule leaf 的 dispatch-time inline projection 才准逐字複製；
// 代價就是這道 cross-carrier 斷言。SSOT 擴充而副本未跟上時，這裡先紅。
test("D6 exception: the dispatch-time projection's verbatim copy stays set-equal to the SSOT, class by class", () => {
  // SSOT 側從 §11 兩張表格各自抽列，而不是拿本檔常數當權威——否則 §11 增列一項時，
  // 副本沒跟上仍會綠（round 3 揭露的兩個同族殘留）。常數退為 sanity floor：
  // 有人把某一項從 §11 整個刪掉時，這兩道先具名報出。
  const ssotClassOne = ssotTableObjects(SSOT_CLASS_ONE_HEADING, SSOT_FLOOR_HEADING);
  const ssotFloor = ssotTableObjects(SSOT_FLOOR_HEADING, null);
  assert.deepEqual(
    ssotClassOne,
    [...CLASS_ONE_OBJECTS].sort(),
    `${DESIGN_CORE} §11: class one 表格列與本 guard 的 sanity floor 不符——` +
      `增刪治理對象是規範層變更，MUST 同時更新 CLASS_ONE_OBJECTS 並重新審視副本`
  );
  assert.deepEqual(
    ssotFloor,
    [...CLASS_TWO_FLOOR].sort(),
    `${DESIGN_CORE} §11: class two floor 表格列與本 guard 的 sanity floor 不符——` +
      `增刪 floor 項是規範層變更，MUST 同時更新 CLASS_TWO_FLOOR 並重新審視副本`
  );

  // 副本側依同一組分類切兩段。**MUST NOT 比聯集**：把字面跨類搬移不改變聯集，
  // 卻會讓副本告訴外部 reviewer「credential-and-secret-handling 屬流程遵循類」，
  // 亦即對它的對抗性 finding 最多 Suggestion——正是 §11 No-downgrade 與 F-10 禁止的降級，
  // 且發生在外部 reviewer 唯一讀得到的載體上（round 3 finding F-ef45518d189f54d8）。
  const projection = readFileSync(repoPath(DISPATCH_PROJECTION), "utf8");
  const { classOne, floor } = enumerationSegments(projection);

  assert.deepEqual(
    classOne.glossed,
    ssotClassOne,
    `${DISPATCH_PROJECTION}: 副本的 class one 段與 ${DESIGN_CORE} §11 class one 不是同一個集合——` +
      `少一項＝副本已過期，多一項＝擴充治理對象 MUST 先改 §11 這唯一的 SSOT 列舉區塊，` +
      `兩段各差一項＝把治理對象跨類改判（No-downgrade 禁止）`
  );
  assert.deepEqual(
    floor.glossed,
    ssotFloor,
    `${DISPATCH_PROJECTION}: 副本的 class two floor 段與 ${DESIGN_CORE} §11 floor 不是同一個集合——` +
      `安全合規產出類被改判為流程遵循類會讓外部 reviewer 對它的 finding 最多只到 Suggestion`
  );

  assert.deepEqual(
    classOne.prose,
    CLASS_ONE_PROSE_VOCABULARY,
    `${DISPATCH_PROJECTION}: class one 段出現未歸類的 kebab 字面——` +
      `若它是治理對象，MUST 先改 ${DESIGN_CORE} §11 SSOT 並在此加中文 gloss；` +
      `若它只是敘述用語，MUST 加入 CLASS_ONE_PROSE_VOCABULARY。` +
      `無 gloss 的新識別字面不得藏在敘述裡躲過集合相等斷言`
  );
  assert.deepEqual(
    floor.prose,
    FLOOR_PROSE_VOCABULARY,
    `${DISPATCH_PROJECTION}: floor 段出現未歸類的 kebab 字面——` +
      `若它是治理對象，MUST 先改 ${DESIGN_CORE} §11 SSOT 並在此加中文 gloss；` +
      `若它只是敘述用語，MUST 加入 FLOOR_PROSE_VOCABULARY`
  );
});

// Mutation probes (classification layer): each mutant edits the REAL projection text in one way a
// careless rewrite could, and MUST be caught by the class-by-class comparison. Un-mutated stays
// aligned, so a probe that "passes" only because the comparison is vacuous cannot hide.
test("D6 mutation probes: the class-by-class comparison discriminates every classification mutant", () => {
  const projection = readFileSync(repoPath(DISPATCH_PROJECTION), "utf8");
  const ssotClassOne = ssotTableObjects(SSOT_CLASS_ONE_HEADING, SSOT_FLOOR_HEADING);
  const ssotFloor = ssotTableObjects(SSOT_FLOOR_HEADING, null);
  assert.equal(enumerationAligned(projection, ssotClassOne, ssotFloor), true, "control: un-mutated projection is aligned");

  const clause = (id) => {
    const m = projection.match(new RegExp(`${id}（[^）]*）(?:、)?`));
    assert.ok(m, `probe precondition: glossed clause for ${id} exists in the projection`);
    return m[0];
  };
  const mid = projection.indexOf(ENUMERATION_BLOCK_MID);
  assert.notEqual(mid, -1, "probe precondition: MID marker present");

  // M-cross: move a class-two floor identifier into the class-one segment (union unchanged).
  const credential = clause("credential-and-secret-handling");
  const withoutCredential = projection.replace(credential, "");
  const crossMoved = withoutCredential.replace(
    ENUMERATION_BLOCK_MID.length ? "（第二審查收案）" : "",
    `（第二審查收案）、credential-and-secret-handling（憑證與機敏）`,
  );
  assert.notEqual(crossMoved, projection, "M-cross actually edits the text");
  assert.equal(enumerationAligned(crossMoved, ssotClassOne, ssotFloor), false, "M-cross (floor → class one) must be caught");

  // M-cross-reverse: move a class-one identifier into the floor segment.
  const branch = clause("branch-and-worktree-placement");
  const reverseMoved = projection
    .replace(branch, "")
    .replace("gate-visibility（閘可見性）", `gate-visibility（閘可見性）、${branch.replace(/、$/, "")}`);
  assert.notEqual(reverseMoved, projection, "M-cross-reverse actually edits the text");
  assert.equal(enumerationAligned(reverseMoved, ssotClassOne, ssotFloor), false, "M-cross-reverse (class one → floor) must be caught");

  // M-drop: delete one governance object from the floor segment.
  const dropped = projection.replace(clause("licensing-compliance"), "");
  assert.equal(enumerationAligned(dropped, ssotClassOne, ssotFloor), false, "M-drop must be caught");

  // M-ungloss: keep the identifier but strip its gloss, hiding it as prose.
  const ungloss = projection.replace("gate-visibility（閘可見性）", "gate-visibility");
  assert.notEqual(ungloss, projection, "M-ungloss actually edits the text");
  assert.equal(enumerationAligned(ungloss, ssotClassOne, ssotFloor), false, "M-ungloss must be caught");

  // M-add: a brand-new glossed governance object appears in the class-one segment.
  const added = projection.replace("（第二審查收案）", "（第二審查收案）、brand-new-gate-object（新增）");
  assert.notEqual(added, projection, "M-add actually edits the text");
  assert.equal(enumerationAligned(added, ssotClassOne, ssotFloor), false, "M-add must be caught");

  // M-prose: an un-vocabularied kebab phrase sneaks into the floor segment as narrative.
  const prose = projection.replace(ENUMERATION_BLOCK_END, `；new-narrative-token${ENUMERATION_BLOCK_END}`);
  assert.notEqual(prose, projection, "M-prose actually edits the text");
  assert.equal(enumerationAligned(prose, ssotClassOne, ssotFloor), false, "M-prose must be caught");

  // M-marker: losing a segment marker makes segmentation impossible (fail loudly, never silently pass).
  assert.throws(() => enumerationAligned(projection.replace(ENUMERATION_BLOCK_MID, ""), ssotClassOne, ssotFloor));
});

// strengthen-review-threat-model-severity R4/R5: the dispatch-time projection must carry
// the same class-one severity rule, and it MUST sit AFTER `ENUMERATION_BLOCK_END` so it can
// never silently enter the guarded enumeration block that the set-equality assertions above
// compare against the §11 SSOT.
test("D6 projection carries the class-one severity rule outside the guarded enumeration block", () => {
  const projection = readFileSync(repoPath(DISPATCH_PROJECTION), "utf8");
  const blockEnd = projection.indexOf(ENUMERATION_BLOCK_END);
  assert.notEqual(blockEnd, -1, `${DISPATCH_PROJECTION}: missing enumeration block end marker`);
  const afterBlock = projection.slice(blockEnd + ENUMERATION_BLOCK_END.length);
  for (const phrase of [
    "adversarial bypass narrative",
    "at most a Suggestion",
    "gates and reviews guard against the AI's accidental mistakes in normal work",
    "responsibility_id",
    "a forgery the AI can produce with an ordinary command remains CRITICAL",
    "a form reachable only through deliberate obfuscation is at most a Suggestion",
    "a class-one gate blocking an ordinary command the current rules already allow is equally a defect",
  ]) {
    assert.ok(
      afterBlock.includes(phrase),
      `${DISPATCH_PROJECTION}: severity-alignment phrase ${JSON.stringify(phrase)} must appear AFTER ` +
        `${JSON.stringify(ENUMERATION_BLOCK_END)} so it cannot enter the guarded enumeration block`
    );
  }
});

// R3: §11 keeps a pointer-only reference to the review-surface conclusion. The closed
// enumeration / axes / F-table themselves stay frozen, which the assertions above enforce.
test("§11 keeps a pointer-only reference to the review severity alignment", () => {
  requireClause("review 面應用指向（指向，非分類變更）", "Review 面應用（指向；非分類變更）");
  requireClause("review 面應用指向 cross-model 載體", "code-review-cross-model.md");
});

// R1/R2/R5 (T9): every ADDED `#### Scenario:` title of the code-review-checklist delta is
// named by an asserting carrier (this file), so lint-delta-new-scenario-assertion-coverage
// has a machine fixture hit for each. Falls back to the canonical spec after archive.
test("code-review-checklist severity-alignment delta scenarios stay named and covered", () => {
  const deltaRel =
    "openspec/changes/strengthen-review-threat-model-severity/specs/code-review-checklist/spec.md";
  const spec = existsSync(repoPath(deltaRel))
    ? readFileSync(repoPath(deltaRel), "utf8")
    : readFileSync(repoPath("openspec/specs/code-review-checklist/spec.md"), "utf8");
  for (const title of [
    "Scenario: Class-one adversarial bypass narrative stays at most a Suggestion",
    "Scenario: Forging compliance evidence remains Critical",
    "Scenario: Class-two findings are not downgraded by the class-one ceiling",
    "Scenario: Severity alignment does not relax enforcement",
    "Scenario: Reviewer-reachable static duties carry the rule self-containedly",
    "Scenario: Unlisted governance objects are classified by nature before the ceiling applies",
  ]) {
    assert.ok(spec.includes(title), `code-review-checklist spec must carry ${JSON.stringify(title)}`);
  }
});

// amend-evidence-forgery-scope (T1): the F-9 row keeps the anti-downgrade core AND carries the
// deliberate-obfuscation boundary and the over-blocking clause in ONE row, so the boundary cannot
// be read without the core. The anchors below lock verbatim presence only (cooperative-only):
// whether a given command "would naturally be produced" is a semantic judgement left to review.
//
// amend-gate-threat-model-to-accident-only：F-9 列由「能力論證 → 恆 in-scope、看普通指令寫不寫得出」改為
// 「看正常工作會不會不小心產生；存心偽造不在威脅模型內」。13 個舊內容錨依新列字面重新鎖定（個數不變）：
// 會不小心／仍 Critical／存心偽造不在威脅模型／不得要求金鑰簽章終端機限定／heredoc／--body-file／
// 最多 Suggestion／例示非封閉／限該情境／class two 維持 adversarial／誤擋缺陷／evidence limitation／各閘自身契約。
const F9_ROW_ANCHORS = Object.freeze([
  "會不會不小心",
  "會不小心產生而閘沒擋住的仍 **Critical**",
  "只有存心才做得到的偽造不在威脅模型內",
  "heredoc",
  "`--body-file`",
  "也不得要求金鑰、簽章、終端機限定或使用者親自操作",
  "最多 Suggestion",
  "具名寫法僅為例示、非封閉列舉",
  "限該情境下並非例行做法者",
  "class two 物件（含 attribution footer）不適用本列，維持 adversarial",
  "class one 閘誤擋現行規則本來就允許的普通指令同屬缺陷",
  "未顯示時只記 evidence limitation",
  "由各閘自身契約決定",
  // amend-gate-forgery-rule-for-batch-scope-records：第 14 個錨，指向 §11 具名殘留例外段（只指向，不重述）
  "具名殘留例外 `batch-scope-record-residual`",
]);

function f9Rows(text) {
  return text.split("\n").filter((line) => /^\| F-9 \|/.test(line));
}

function f9RowMissing(text) {
  const rows = f9Rows(text);
  if (rows.length !== 1) return [`exactly one F-9 row (found ${rows.length})`];
  return F9_ROW_ANCHORS.filter((anchor) => !rows[0].includes(anchor));
}

test("§11 F-9 keeps the anti-downgrade core and the deliberate-obfuscation boundary in one row", () => {
  const missing = f9RowMissing(s11);
  assert.deepEqual(
    missing,
    [],
    `${DESIGN_CORE} §11 F-9 列缺少內容錨：${missing.map((anchor) => JSON.stringify(anchor)).join("、")}`
  );
});

test("§11 F-9 row mutation probes: every anchor, the downgrade swap, the class-one limit, and a row split are rejected", () => {
  assert.deepEqual(f9RowMissing(s11), [], "control must satisfy the predicate");
  const row = f9Rows(s11)[0];
  const mutate = (fn) => {
    const mutatedRow = fn(row);
    assert.notEqual(mutatedRow, row, "mutation fixture must change the F-9 row");
    return s11.replace(row, mutatedRow);
  };
  for (const anchor of F9_ROW_ANCHORS) {
    assert.notDeepEqual(
      f9RowMissing(mutate((r) => r.replace(anchor, ""))),
      [],
      `removing ${JSON.stringify(anchor)} must be rejected`
    );
  }
  const mutants = [
    ["accidental wrong record downgraded", (r) => r.replace("仍 **Critical**", "最多 Suggestion")],
    ["over-blocking clause loses its class-one limit", (r) => r.replace("class one 閘誤擋現行規則", "閘誤擋現行規則")],
    ["row split before the symmetric clause", (r) => r.replace("反向同理", "\n反向同理")],
  ];
  for (const [name, fn] of mutants) {
    assert.notDeepEqual(f9RowMissing(mutate(fn)), [], `mutant must be rejected: ${name}`);
  }
});

// Every MODIFIED/new scenario title of the two deltas is named by this asserting carrier, so
// lint-delta-new-scenario-assertion-coverage has a fixture hit for each. After archive the
// canonical specs carry the same titles.
test("amend-evidence-forgery-scope delta scenarios stay named and covered", () => {
  const specFor = (capability) => {
    const deltaRel = `openspec/changes/amend-evidence-forgery-scope/specs/${capability}/spec.md`;
    return existsSync(repoPath(deltaRel))
      ? readFileSync(repoPath(deltaRel), "utf8")
      : readFileSync(repoPath(`openspec/specs/${capability}/spec.md`), "utf8");
  };
  const expectations = [
    [
      "code-review-checklist",
      [
        "Scenario: Forging compliance evidence remains Critical",
        "Scenario: Reviewer-reachable static duties carry the rule self-containedly",
        "Scenario: Deliberately obfuscated forgery on a class-one gate stays at most a Suggestion",
        "Scenario: Blocking an ordinary command the rules already allow is a defect",
      ],
    ],
    [
      "design-core",
      [
        "Scenario: Compliance evidence is judged by accident on class one and by adversary on class two",
        "Scenario: The forgery rebuttal keeps ordinary-command forgery Critical",
      ],
    ],
  ];
  for (const [capability, titles] of expectations) {
    const spec = specFor(capability);
    for (const title of titles) {
      assert.ok(spec.includes(title), `${capability} spec must carry ${JSON.stringify(title)}`);
    }
  }
});

// amend-gate-forgery-rule-for-batch-scope-records (T3): §11 carries ONE named, closed,
// user-accepted residual exception `batch-scope-record-residual` as an independent paragraph
// right after the F-1..F-10 table, and the F-9 row only points at it. Like everything above this
// locks verbatim presence only (cooperative-only): whether a finding was actually lowered
// because of the exception is a semantic judgement left to review, never a CI hard fail.
const EXCEPTION_ID = "batch-scope-record-residual";
const EXCEPTION_MARKER = `**F-9 具名殘留例外 \`${EXCEPTION_ID}\``;
const F9_POINTER_ANCHOR = `具名殘留例外 \`${EXCEPTION_ID}\``;
const GUARANTEE_CEILING_MARKER = "**保證上限（誠實聲明）**";

const EXCEPTION_ANCHORS = Object.freeze([
  ["full 載體", "`## Batch Approval Ledger`"],
  ["lite 載體", "`openspec/changes/<change>/lite-scope.md`"],
  ["殘留內容：沒有閘能證明使用者選過 batch", "沒有閘能證明使用者選過 batch"],
  ["依據：archived change F1", "`remove-second-review-disclosure-approval` decisions F1"],
  ["依據：本 change Clarification decisions", "`amend-gate-forgery-rule-for-batch-scope-records` Clarification decisions"],
  ["依據 provenance", "provenance: user"],
  ["severity 最多 INFO", "review severity 最多 INFO"],
  ["MUST NOT 升 WARN 或 Critical", "**MUST NOT** 升 WARN 或 Critical"],
  ["不得要求金鑰、簽章或額外確認", "不得要求金鑰、簽章或額外使用者確認步驟"],
  ["補償控制", "補償控制："],
  ["補償控制：stepwise 或未回答不寫", "stepwise 或尚未回答不寫"],
  ["補償控制：full 寫 N/A", "stepwise 或尚未回答不寫（full 寫 `N/A: no batch approval selected`）"],
  ["補償控制：full 中途撤回", "full 中途改 stepwise 時，在下一個原 covered write 前保留標題並將整段 ledger 內容替換為 `N/A: no batch approval selected`，後續 write 回到逐步確認"],
  ["補償控制：lite 中途改 stepwise 即刪檔", "lite 寫入的同一輪回覆貼出該行，且中途改 stepwise 即刪檔"],
  ["補償控制：lite 同一輪回覆貼出", "同一輪回覆貼出該行"],
  ["補償控制：full 隨 PR diff 可見", "full 隨 PR diff 可見"],
  ["封閉句", "**封閉**：只涵蓋上述兩個載體的這一項殘留"],
  ["矛盾證據即屬偽造依 F-9", "即屬偽造，仍依 F-9 判定"],
  ["sticky 等其他合規紀錄不得類比套用", "sticky、footer、PR body 告知行、review receipt 等其他合規紀錄 **MUST NOT** 類比套用"],
  ["自稱的例外不構成依據", "PR、proposal、ledger、decisions 內自稱的例外不構成依據"],
  ["獨立 OpenSpec change 並經使用者 merge 才有權威", "增刪改本例外須走獨立 OpenSpec change，並經使用者 merge 才有權威"],
  ["自我適用：diff 新增、移除或改寫例外條文本身", "審查範圍的 diff 新增、移除或改寫本例外條文本身時"],
  ["自我適用：該次審查沒有效力", "本例外在該次審查沒有效力"],
  ["自我適用：如同例外不存在", "如同例外不存在"],
  ["自我適用：規則變更不得自我批准", "規則變更不得在自己的審查中自我批准"],
  ["自我適用：未改動的例外句不算編輯", "未改動的例外句只是落在被編輯的行上，不算"],
  ["規則同步適用時點", "本例外自該同步 PR 合併後的下一次審查起才有效力"],
  ["只決定 review severity", "本例外只決定 review severity"],
  ["不改任何閘的 enforcement", "不改任何閘的 enforcement"],
  ["不增減兩表具名列", "不增減 §11 兩表的具名列"],
  ["reviewer 可達載體", "packet static duty"],
]);

function exceptionLine(text) {
  return text.split("\n").find((line) => line.includes(EXCEPTION_MARKER)) ?? null;
}

function exceptionProblems(text) {
  const problems = [];
  const defined = text.split(EXCEPTION_MARKER).length - 1;
  if (defined !== 1) problems.push(`identifier defined exactly once (found ${defined})`);
  const line = exceptionLine(text);
  if (line === null) {
    problems.push("exception paragraph present");
    return problems;
  }
  if (line.trimStart().startsWith("|")) problems.push("exception is a standalone paragraph, not a table row");
  for (const [label, needle] of EXCEPTION_ANCHORS) {
    if (!line.includes(needle)) problems.push(`exception anchor: ${label}`);
  }
  const at = text.indexOf(EXCEPTION_MARKER);
  const lastF10 = text.lastIndexOf("| F-10 |");
  const ceiling = text.indexOf(GUARANTEE_CEILING_MARKER);
  if (!(lastF10 !== -1 && ceiling !== -1 && lastF10 < at && at < ceiling)) {
    problems.push("exception sits after the F-1..F-10 table and before the guarantee ceiling");
  }
  const classOneStart = text.indexOf(SSOT_CLASS_ONE_HEADING);
  const classOneEnd = text.indexOf(SSOT_FLOOR_HEADING);
  const classOneBlock = classOneStart !== -1 && classOneEnd > classOneStart ? text.slice(classOneStart, classOneEnd) : "";
  const classOneRows = [...classOneBlock.matchAll(SSOT_TABLE_ROW)].length;
  if (classOneRows !== 8) problems.push(`class one table keeps 8 rows (found ${classOneRows})`);
  if (classOneBlock.includes(EXCEPTION_ID)) problems.push("exception is not inside the class one block");
  const f9 = f9Rows(text);
  if (f9.length !== 1 || !f9[0].includes(F9_POINTER_ANCHOR)) problems.push("F-9 row points at the named exception");
  return problems;
}

function exceptionCarriers() {
  const rel = "openspec/changes/amend-gate-forgery-rule-for-batch-scope-records/specs/design-core/spec.md";
  return existsSync(repoPath(rel))
    ? readFileSync(repoPath(rel), "utf8")
    : readFileSync(repoPath("openspec/specs/design-core/spec.md"), "utf8");
}

function assertNoProblems(text, label) {
  const problems = exceptionProblems(text);
  assert.deepEqual(problems, [], `${DESIGN_CORE} §11 ${label}: ${problems.join("；")}`);
}

test("§11 F-9 row is the 14th anchor: it points at the named exception while the 13 existing anchors stay", () => {
  assert.equal(F9_ROW_ANCHORS.length, 14, "F-9 anchors: 13 existing plus the exception pointer");
  assert.ok(F9_ROW_ANCHORS.includes(F9_POINTER_ANCHOR), "F-9 anchor list carries the exception pointer");
  const rows = f9Rows(s11);
  assert.equal(rows.length, 1, "exactly one F-9 row");
  assert.equal(rows[0].split("|").length, 6, "F-9 row keeps 6 cells (no extra pipe from the pointer)");
  assert.ok(rows[0].includes(F9_POINTER_ANCHOR), `F-9 row must point at ${EXCEPTION_ID}`);
});

test("§11 exception paragraph: defined once, two carriers, rationale, compensating controls, closed, self-applying", () => {
  assertNoProblems(s11, "exception paragraph");
});

test("§11 exception paragraph mutation probes: each load-bearing edit is rejected", () => {
  assert.deepEqual(exceptionProblems(s11), [], "control must satisfy the predicate");
  const line = exceptionLine(s11);
  const mutateLine = (fn) => {
    const mutated = fn(line);
    assert.notEqual(mutated, line, "mutation fixture must change the exception paragraph");
    return s11.replace(line, mutated);
  };
  for (const [label, needle] of EXCEPTION_ANCHORS) {
    assert.notDeepEqual(
      exceptionProblems(mutateLine((l) => l.replace(needle, ""))),
      [],
      `removing the exception anchor「${label}」must be rejected`
    );
  }
  const closed = "**封閉**：只涵蓋上述兩個載體的這一項殘留";
  const sticky = "sticky、footer、PR body 告知行、review receipt 等其他合規紀錄 **MUST NOT** 類比套用";
  const mutants = [
    ["closure sentence deleted", mutateLine((l) => l.replace(closed, ""))],
    ["sticky widened to covered", mutateLine((l) => l.replace(sticky, "sticky、footer、PR body 告知行、review receipt 等其他合規紀錄亦涵蓋"))],
    ["rationale deleted", mutateLine((l) => l.replace("（依據：`remove-second-review-disclosure-approval` decisions F1、`amend-gate-forgery-rule-for-batch-scope-records` Clarification decisions；provenance: user）", ""))],
    ["self-application sentence deleted", mutateLine((l) => l.replace("審查範圍的 diff 新增、移除或改寫本例外條文本身時", ""))],
    ["INFO ceiling raised to WARN", mutateLine((l) => l.replace("review severity 最多 INFO", "review severity 最多 WARN"))],
    [
      "exception moved into the class one table",
      (() => {
        const withoutLine = s11.replace(`${line}\n\n`, "");
        assert.notEqual(withoutLine, s11, "mutation fixture must remove the exception paragraph");
        const anchorRow = withoutLine.split("\n").find((l) => l.startsWith("| `second-review-admission` |"));
        assert.ok(anchorRow, "probe precondition: second-review-admission row exists");
        return withoutLine.replace(anchorRow, `${anchorRow}\n| \`${EXCEPTION_ID}\` | ${line.replaceAll("|", "/")} |`);
      })(),
    ],
    [
      "F-9 row loses the pointer",
      (() => {
        const row = f9Rows(s11)[0];
        const stripped = row.replace(F9_POINTER_ANCHOR, "");
        assert.notEqual(stripped, row, "mutation fixture must change the F-9 row");
        return s11.replace(row, stripped);
      })(),
    ],
  ];
  for (const [name, mutated] of mutants) {
    assert.notDeepEqual(exceptionProblems(mutated), [], `mutant must be rejected: ${name}`);
  }
});

// Scenario titles are literal on purpose: lint-delta-new-scenario-assertion-coverage greps
// the test names. Each THEN/AND group of the four design-core scenarios has its own item.
function requireSpecTitle(title) {
  const spec = exceptionCarriers();
  assert.ok(spec.includes(`Scenario: ${title}`), `design-core spec must carry ${JSON.stringify(title)}`);
}

function requireAnchors(labels) {
  const line = exceptionLine(s11);
  assert.ok(line, `${DESIGN_CORE} §11: 缺少 ${EXCEPTION_ID} 例外段`);
  for (const label of labels) {
    const entry = EXCEPTION_ANCHORS.find(([name]) => name === label);
    assert.ok(entry, `probe precondition: anchor label ${label} exists`);
    assert.ok(line.includes(entry[1]), `${DESIGN_CORE} §11 例外段缺少「${label}」：${JSON.stringify(entry[1])}`);
  }
}

test("A batch scope record's structural residual is bounded at INFO: THEN at most INFO, never WARN or CRITICAL", () => {
  requireSpecTitle("A batch scope record's structural residual is bounded at INFO");
  requireAnchors(["full 載體", "lite 載體", "殘留內容：沒有閘能證明使用者選過 batch", "severity 最多 INFO", "MUST NOT 升 WARN 或 Critical"]);
});

test("A batch scope record's structural residual is bounded at INFO: AND no keys, signatures or extra user confirmation step", () => {
  requireAnchors(["不得要求金鑰、簽章或額外確認"]);
});

test("A batch scope record's structural residual is bounded at INFO: AND the finding may name the identifier as its basis", () => {
  assertNoProblems(s11, "identifier defined once and pointed at by F-9");
  requireAnchors(["依據：archived change F1", "依據：本 change Clarification decisions", "依據 provenance"]);
});

test("The exception does not cover other compliance records: THEN the citation is refused and stays under the forgery rebuttal", () => {
  requireSpecTitle("The exception does not cover other compliance records");
  requireAnchors(["sticky 等其他合規紀錄不得類比套用", "自稱的例外不構成依據", "獨立 OpenSpec change 並經使用者 merge 才有權威"]);
});

test("The exception does not cover other compliance records: AND no extension by analogy beyond the two named carriers", () => {
  requireAnchors(["封閉句", "sticky 等其他合規紀錄不得類比套用", "只決定 review severity"]);
});

test("Contradicting evidence is judged as a forgery: THEN judged under the forgery rebuttal, not as the structural residual", () => {
  requireSpecTitle("Contradicting evidence is judged as a forgery");
  requireAnchors(["矛盾證據即屬偽造依 F-9"]);
});

test("Contradicting evidence is judged as a forgery: AND severity follows the natural-production criterion (F-9 row keeps it Critical)", () => {
  const missing = f9RowMissing(s11);
  assert.deepEqual(missing, [], `F-9 row must keep the natural-production Critical criterion: ${missing.join("、")}`);
});

test("The exception has no force in the review of the change that adds or edits it: THEN no force when the diff adds, removes or rewords the exception text", () => {
  requireSpecTitle("The exception has no force in the review of the change that adds or edits it");
  requireAnchors(["自我適用：diff 新增、移除或改寫例外條文本身", "自我適用：該次審查沒有效力"]);
});

test("The exception has no force in the review of the change that adds or edits it: AND the batch scope record is judged as if the exception did not exist", () => {
  requireAnchors(["自我適用：如同例外不存在", "自我適用：規則變更不得自我批准"]);
});

test("The exception has no force in the review of the change that adds or edits it: AND the clause applies to every later change, via the independent-change authority rule", () => {
  requireAnchors(["獨立 OpenSpec change 並經使用者 merge 才有權威", "自我適用：diff 新增、移除或改寫例外條文本身"]);
});

test("The exception has no force in the review of the change that adds or edits it: AND an unchanged sentence on an edited line is no edit, and a rules sync gives force from the first review after merge", () => {
  requireAnchors(["自我適用：未改動的例外句不算編輯", "規則同步適用時點"]);
});

// amend-gate-forgery-rule-for-waiver-records (T2): §11 carries a SECOND named, closed,
// user-accepted residual exception `per-pr-waiver-record-residual` as its own independent
// paragraph right after the `batch-scope-record-residual` paragraph, and the F-9 row only points
// at it a second time. Everything above (14 F-9 anchors, the batch paragraph, EXCEPTION_ANCHORS)
// is left untouched; this block only ADDS guards. Cooperative-only like the rest of this file:
// it locks verbatim presence and placement. Whether the precondition (the open-PR checks compare
// the waiver line with the record made when the user answered) holds in a given review is a
// semantic judgement left to review, never a CI hard fail.
const WAIVER_ID = "per-pr-waiver-record-residual";
const WAIVER_MARKER = `**F-9 具名殘留例外 \`${WAIVER_ID}\``;
// amend-gate-threat-model-to-accident-only：F-9 列尾改為「…既有實例為具名殘留例外 `batch…`（批次範圍紀錄）與
// `per-pr-waiver…`（逐 PR 豁免紀錄，…）」，第二指標片段改以「與 `id`（」起、右括號止。
const WAIVER_F9_POINTER_ANCHOR = `\`${WAIVER_ID}\`（逐 PR 豁免紀錄`;
const WAIVER_F9_FRAGMENT_START = `與 \`${WAIVER_ID}\`（`;
const BATCH_F9_POINTER_ANCHOR = "具名殘留例外 `batch-scope-record-residual`";

const WAIVER_EXCEPTION_ANCHORS = Object.freeze([
  ["紀錄行字面：DEV deploy-verify", "`DEV deploy-verify:`"],
  ["紀錄行字面：Consumer pre-PR checks", "`Consumer pre-PR checks:`"],
  ["紀錄行字面：skipped per user decision", "`skipped per user decision:`"],
  ["殘留內容：沒有閘能證明使用者真的放行", "沒有閘能證明使用者真的放行"],
  ["依據：本 change Clarification decisions 與 Startup evidence", "`amend-gate-forgery-rule-for-waiver-records` Clarification decisions 與 Startup evidence"],
  ["依據 provenance", "provenance: user"],
  ["獨立使用者裁示，不是類比 batch 例外", "是另一項使用者裁示，不是類比 batch 例外"],
  ["前提：開 PR 檢查拿該行對照作答時紀錄", "拿該行對照使用者作答時記下的紀錄，紀錄缺或對不上就擋"],
  ["前提判定來源：審查材料或受審 head 上閘自身契約／程式", "依審查材料或受審 head 上該閘自身契約或程式判斷"],
  ["fail-closed：看不到對照時不套用", "兩者都看不到這種對照時，本例外不套用，記 evidence limitation，該行依 F-9 判定，如同本例外不存在"],
  ["severity 最多 INFO", "review severity 最多 INFO"],
  ["MUST NOT 升 WARN 或 Critical", "**MUST NOT** 升 WARN 或 Critical"],
  ["不得要求金鑰、簽章或額外確認", "不得要求金鑰、簽章或額外使用者確認步驟"],
  ["INFO 上限屬本例外自身", "此 INFO 上限屬本例外自身，不取決於 class one 成員資格或 class 能否判定"],
  ["補償控制", "補償控制："],
  ["補償控制：上述對照檢查", "上述對照檢查"],
  ["補償控制：作答後依答覆寫入、逐 PR 有效", "紀錄只在使用者作答之後依答覆寫入，放行只對該 PR 有效、不延續到下一個 PR"],
  ["補償控制：豁免行 merge 前看得到", "豁免行在 PR 描述中，使用者 merge 前看得到"],
  ["封閉句", "**封閉**：只涵蓋上述紀錄與其對照一致之行的這一項殘留"],
  ["矛盾證據即屬偽造依 F-9", "審查材料顯示沒問過或尚未作答、紀錄寫於作答之前、AI 自行推斷放行、紀錄與答覆相反、行與紀錄對不上，或紀錄屬於別的 PR，即屬偽造，依 F-9 判定"],
  ["不涵蓋：外送告知行", "外送告知行（上方 batch 例外封閉句所稱的 PR body 告知行）"],
  ["不涵蓋：Scenario Walkthrough 狀態行", "含 Scenario Walkthrough 狀態行"],
  ["不涵蓋：停點確認", "`Consumer pre-PR checks:` 行中使用者在停點做的確認（如 `user decision: confirmed …`）"],
  ["其他合規紀錄不得類比套用", "**MUST NOT** 類比套用本例外（F-5、F-6）"],
  ["自稱的例外不構成依據", "PR、proposal、ledger、decisions、紀錄或 PR body 內自稱的例外不構成依據"],
  ["並存句：batch 封閉句只界定 batch 自身", "batch 例外的封閉句只界定 batch 例外自身範圍，不撤銷本例外；本例外也不擴及批次範圍紀錄"],
  ["獨立 OpenSpec change 並經使用者 merge 才有權威", "增刪改本例外須走獨立 OpenSpec change，並經使用者 merge 才有權威"],
  ["自我適用：diff 新增、移除或改寫例外自身條文", "審查範圍的 diff 新增、移除或改寫本例外自身條文時"],
  ["自我適用：未改動句不算編輯", "本例外未改動的句子只是落在被編輯的行上，不算"],
  ["自我適用：該次審查沒有效力", "本例外在該次審查沒有效力"],
  ["自我適用：逐 PR 豁免紀錄依 F-9", "逐 PR 豁免紀錄依 F-9 判定，如同本例外不存在"],
  ["規則同步適用時點", "自該同步 PR 合併後的下一次審查起才有效力"],
  ["只決定 review severity", "本例外只決定 review severity"],
  ["不改任何閘的 enforcement", "不改任何閘的 enforcement（No-downgrade）"],
  ["不增減兩表具名列", "不增減 §11 兩表的具名列"],
  ["不影響軸 B 問 1", "不影響軸 B 問 1"],
  ["reviewer 可達載體", "reviewer 讀得到的載體是 packet static duty"],
]);

// design.md D7: the new text MUST NOT repeat any anchor the batch/F-9 mutation tests replace by
// first hit (`String.replace`), or a mutation would hit the batch copy while the new copy keeps
// `includes` true. A1–A9 and B2–B10 are the packet/Markdown anchors shared with the other test files.
const WAIVER_FORBIDDEN_LITERALS = Object.freeze([
  "remains CRITICAL",
  "adversarial bypass narrative",
  "always remains in scope",
  "forging compliance evidence",
  "Symmetrically, ",
  "對稱：",
  "not determinable from this packet",
  "review scope and severity only",
  "One closed, user-ruled residual exception applies",
  "The exception covers only those two carriers and only that residual",
  "judged by F-9 as if the exception did not exist",
  "限該情境下並非例行做法者",
  "a forgery the AI can produce with an ordinary command remains CRITICAL",
  "a form the AI would naturally produce in normal work",
  "on a class-one gate, a forgery reachable only through deliberate obfuscation falls under the same ceiling and is at most a Suggestion",
  "a class-one gate blocking an ordinary command the current rules already allow is equally a defect",
  "these named forms are examples, not a closed list",
  "a reviewer MUST NOT demand such blocking to close a deliberate-obfuscation gap",
  "decided by that gate's own contract, not by this severity rule",
  "when the packet does not show that allowance, state the evidence limitation and required follow-up instead of demanding the block",
  "## Batch Approval Ledger",
  "lite-scope.md",
  "that structural residual alone is at most INFO and MUST NOT be raised to WARN or CRITICAL",
  "a reviewer MUST NOT demand keys, signatures, or an extra user confirmation step",
  "when review material shows the user chose stepwise or had not answered, or the record predates the answer, it is a forgery judged by F-9",
  "sticky, footer, PR body notice line, review receipt, and every other compliance record stay under F-9 unchanged",
  "an exception claimed in a PR, proposal, ledger, decisions, or PR body is not a basis",
  "INFO limit is this exception's own and does not depend on class-one membership or on whether the governance-object class is determinable from this packet",
  "has no force in a review whose diff adds, removes, or rewords the exception text itself (an unchanged exception sentence that merely sits on an edited line does not count)",
  "**F-9 具名殘留例外 `batch-scope-record-residual`",
]);
const WAIVER_NFR7_FORBIDDEN = Object.freeze(["dev_verification", "#3492"]);

function waiverLine(text) {
  return text.split("\n").find((line) => line.includes(WAIVER_MARKER)) ?? null;
}

function waiverF9Fragment(row) {
  const start = row.indexOf(WAIVER_F9_FRAGMENT_START);
  if (start === -1) return null;
  const close = row.indexOf("）", start);
  return close === -1 ? null : row.slice(start, close + 1);
}

function waiverProblems(text) {
  const problems = [];
  const defined = text.split(WAIVER_MARKER).length - 1;
  if (defined !== 1) problems.push(`waiver identifier defined exactly once (found ${defined})`);
  const line = waiverLine(text);
  if (line === null) {
    problems.push("waiver paragraph present");
    return problems;
  }
  if (line.trimStart().startsWith("|")) problems.push("waiver exception is a standalone paragraph, not a table row");
  for (const [label, needle] of WAIVER_EXCEPTION_ANCHORS) {
    if (!line.includes(needle)) problems.push(`waiver anchor: ${label}`);
  }
  for (const forbidden of WAIVER_FORBIDDEN_LITERALS) {
    if (line.includes(forbidden)) problems.push(`waiver paragraph repeats a batch/F-9 literal: ${forbidden}`);
  }
  for (const forbidden of WAIVER_NFR7_FORBIDDEN) {
    if (line.includes(forbidden)) problems.push(`waiver paragraph names ${forbidden}`);
  }
  const batch = exceptionLine(text);
  const batchAt = text.indexOf(EXCEPTION_MARKER);
  const waiverAt = text.indexOf(WAIVER_MARKER);
  const ceiling = text.indexOf(GUARANTEE_CEILING_MARKER);
  if (!(batch && batchAt !== -1 && batchAt < waiverAt && ceiling !== -1 && waiverAt < ceiling)) {
    problems.push("waiver paragraph sits after the batch paragraph and before the guarantee ceiling");
  }
  if (!(batch && text.includes(`${batch}\n\n${line}\n\n`))) {
    problems.push("waiver paragraph follows the batch paragraph after exactly one blank line and is followed by one blank line");
  }
  const classOneStart = text.indexOf(SSOT_CLASS_ONE_HEADING);
  const classOneEnd = text.indexOf(SSOT_FLOOR_HEADING);
  const classOneBlock = classOneStart !== -1 && classOneEnd > classOneStart ? text.slice(classOneStart, classOneEnd) : "";
  const classOneRows = [...classOneBlock.matchAll(SSOT_TABLE_ROW)].length;
  if (classOneRows !== 8) problems.push(`class one table keeps 8 rows (found ${classOneRows})`);
  if (classOneBlock.includes(WAIVER_ID)) problems.push("waiver exception is not inside the class one block");
  const rows = f9Rows(text);
  if (rows.length !== 1) {
    problems.push("exactly one F-9 row");
  } else {
    const row = rows[0];
    if (row.split("|").length !== 6) problems.push("F-9 row keeps 6 cells");
    const fragment = waiverF9Fragment(row);
    if (fragment === null) {
      problems.push("F-9 row carries the second pointer to the waiver exception");
    } else {
      if (!fragment.includes(WAIVER_F9_POINTER_ANCHOR)) problems.push("F-9 second pointer names the waiver exception");
      if (fragment.includes("|")) problems.push("F-9 second pointer adds no pipe");
      if (fragment.includes("反向同理")) problems.push("F-9 second pointer repeats 反向同理");
      for (const anchor of F9_ROW_ANCHORS) {
        if (fragment.includes(anchor)) problems.push(`F-9 second pointer repeats an existing F-9 anchor: ${anchor}`);
      }
      const batchPointerAt = row.indexOf(BATCH_F9_POINTER_ANCHOR);
      if (!(batchPointerAt !== -1 && batchPointerAt < row.indexOf(WAIVER_F9_FRAGMENT_START))) {
        problems.push("F-9 second pointer comes after the batch pointer");
      }
      if (!row.slice(row.indexOf(fragment) + fragment.length).startsWith(" | ")) {
        problems.push("F-9 second pointer ends the rebuttal cell");
      }
    }
  }
  return problems;
}

function assertNoWaiverProblems(text, label) {
  const problems = waiverProblems(text);
  assert.deepEqual(problems, [], `${DESIGN_CORE} §11 ${label}: ${problems.join("；")}`);
}

test("§11 waiver exception paragraph: defined once, after the batch paragraph, closed, self-applying, F-9 second pointer, no repeated batch literal", () => {
  assertNoWaiverProblems(s11, "waiver exception paragraph");
});

test("§11 F-9 row keeps 14 anchors and 6 cells while carrying the waiver second pointer as a separate constant", () => {
  assert.equal(F9_ROW_ANCHORS.length, 14, "F-9 anchors stay 14; the waiver pointer is asserted by its own constant");
  assert.ok(!F9_ROW_ANCHORS.includes(WAIVER_F9_POINTER_ANCHOR), "the waiver pointer is not folded into F9_ROW_ANCHORS");
  const rows = f9Rows(s11);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].split("|").length, 6, "F-9 row keeps 6 cells");
  assert.ok(rows[0].includes(WAIVER_F9_POINTER_ANCHOR), `F-9 row must point at ${WAIVER_ID}`);
  assert.deepEqual(f9RowMissing(s11), [], "the 14 existing F-9 anchors stay");
});

test("§11 waiver exception paragraph mutation probes: each load-bearing edit is rejected", () => {
  assert.deepEqual(waiverProblems(s11), [], "control must satisfy the predicate");
  const line = waiverLine(s11);
  const mutateLine = (fn) => {
    const mutated = fn(line);
    assert.notEqual(mutated, line, "mutation fixture must change the waiver paragraph");
    return s11.replace(line, mutated);
  };
  const anchor = (label) => WAIVER_EXCEPTION_ANCHORS.find(([name]) => name === label)[1];
  for (const [label, needle] of WAIVER_EXCEPTION_ANCHORS) {
    // replaceAll: some anchors (the two line literals) legitimately occur twice in the paragraph.
    assert.notDeepEqual(waiverProblems(mutateLine((l) => l.replaceAll(needle, ""))), [], `removing the waiver anchor「${label}」must be rejected`);
  }
  const mutants = [
    ["precondition sentence deleted", mutateLine((l) => l.replace(anchor("前提：開 PR 檢查拿該行對照作答時紀錄"), ""))],
    ["fail-closed sentence deleted", mutateLine((l) => l.replace(anchor("fail-closed：看不到對照時不套用"), ""))],
    ["INFO ceiling raised to WARN", mutateLine((l) => l.replace("review severity 最多 INFO", "review severity 最多 WARN"))],
    [
      "notice line widened to covered",
      mutateLine((l) => l.replace(anchor("不涵蓋：外送告知行"), "外送告知行亦涵蓋")),
    ],
    ["Scenario Walkthrough exclusion deleted", mutateLine((l) => l.replace(anchor("不涵蓋：Scenario Walkthrough 狀態行"), ""))],
    ["coexistence sentence deleted", mutateLine((l) => l.replace(anchor("並存句：batch 封閉句只界定 batch 自身"), ""))],
    ["self-application sentence deleted", mutateLine((l) => l.replace(anchor("自我適用：diff 新增、移除或改寫例外自身條文"), ""))],
    ["closure sentence deleted", mutateLine((l) => l.replace(anchor("封閉句"), ""))],
    [
      "F-9 row loses the second pointer",
      (() => {
        const row = f9Rows(s11)[0];
        const stripped = row.replace(waiverF9Fragment(row) ?? "\u0000", "");
        assert.notEqual(stripped, row, "mutation fixture must change the F-9 row");
        return s11.replace(row, stripped);
      })(),
    ],
    [
      "waiver paragraph moved into the class one table",
      (() => {
        const withoutLine = s11.replace(`${line}\n\n`, "");
        assert.notEqual(withoutLine, s11, "mutation fixture must remove the waiver paragraph");
        const anchorRow = withoutLine.split("\n").find((l) => l.startsWith("| `second-review-admission` |"));
        assert.ok(anchorRow, "probe precondition: second-review-admission row exists");
        return withoutLine.replace(anchorRow, `${anchorRow}\n| \`${WAIVER_ID}\` | ${line.replaceAll("|", "/")} |`);
      })(),
    ],
    ["waiver paragraph repeats a batch literal", mutateLine((l) => `${l} remains CRITICAL`)],
    ["waiver paragraph names a sibling PR", mutateLine((l) => `${l} #3492`)],
  ];
  for (const [name, mutated] of mutants) {
    assert.notDeepEqual(waiverProblems(mutated), [], `mutant must be rejected: ${name}`);
  }
});

// design-core ADDED requirement "Per-PR Waiver Records Carry A Named User-Accepted Residual Exception":
// scenario titles are literal because lint-delta-new-scenario-assertion-coverage greps test names.
// Each THEN/AND group has its own item. The active delta is read while the change is open, the
// canonical spec after archive.
function waiverSpecText() {
  const rel = "openspec/changes/amend-gate-forgery-rule-for-waiver-records/specs/design-core/spec.md";
  return existsSync(repoPath(rel)) ? readFileSync(repoPath(rel), "utf8") : readFileSync(repoPath("openspec/specs/design-core/spec.md"), "utf8");
}

function requireWaiverSpecTitle(title) {
  assert.ok(waiverSpecText().includes(`Scenario: ${title}`), `design-core spec must carry ${JSON.stringify(title)}`);
}

function requireWaiverAnchors(labels) {
  const line = waiverLine(s11);
  assert.ok(line, `${DESIGN_CORE} §11: 缺少 ${WAIVER_ID} 例外段`);
  for (const label of labels) {
    const entry = WAIVER_EXCEPTION_ANCHORS.find(([name]) => name === label);
    assert.ok(entry, `probe precondition: anchor label ${label} exists`);
    assert.ok(line.includes(entry[1]), `${DESIGN_CORE} §11 waiver 段缺少「${label}」：${JSON.stringify(entry[1])}`);
  }
}

test("A matched per-PR waiver record's structural residual is bounded at INFO: THEN at most INFO, never WARN or CRITICAL", () => {
  requireWaiverSpecTitle("A matched per-PR waiver record's structural residual is bounded at INFO");
  requireWaiverAnchors(["紀錄行字面：DEV deploy-verify", "紀錄行字面：Consumer pre-PR checks", "紀錄行字面：skipped per user decision", "殘留內容：沒有閘能證明使用者真的放行", "severity 最多 INFO", "MUST NOT 升 WARN 或 Critical"]);
});

test("A matched per-PR waiver record's structural residual is bounded at INFO: AND no keys, signatures or extra user confirmation step", () => {
  requireWaiverAnchors(["不得要求金鑰、簽章或額外確認"]);
});

test("A matched per-PR waiver record's structural residual is bounded at INFO: AND the INFO limit holds whatever the class-one membership or class determinability", () => {
  requireWaiverAnchors(["INFO 上限屬本例外自身"]);
});

test("A matched per-PR waiver record's structural residual is bounded at INFO: AND the finding may name the identifier as its basis", () => {
  assertNoWaiverProblems(s11, "identifier defined once and pointed at by F-9");
  requireWaiverAnchors(["依據：本 change Clarification decisions 與 Startup evidence", "依據 provenance", "前提：開 PR 檢查拿該行對照作答時紀錄"]);
});

test("The waiver exception is not applied when the cross-check is not shown: THEN not applied and judged under the forgery rebuttal as if the exception did not exist", () => {
  requireWaiverSpecTitle("The waiver exception is not applied when the cross-check is not shown");
  requireWaiverAnchors(["前提判定來源：審查材料或受審 head 上閘自身契約／程式", "fail-closed：看不到對照時不套用"]);
});

test("The waiver exception is not applied when the cross-check is not shown: AND the reviewer states the evidence limitation", () => {
  assert.ok(waiverLine(s11)?.includes("記 evidence limitation"), "waiver paragraph must tell the reviewer to record an evidence limitation");
});

test("Contradicting evidence is judged as a forged waiver: THEN judged as forged consent evidence, not as the structural residual", () => {
  requireWaiverSpecTitle("Contradicting evidence is judged as a forged waiver");
  requireWaiverAnchors(["矛盾證據即屬偽造依 F-9"]);
});

test("Contradicting evidence is judged as a forged waiver: AND severity follows the natural-production criterion (F-9 row keeps it Critical)", () => {
  const missing = f9RowMissing(s11);
  assert.deepEqual(missing, [], `F-9 row must keep the natural-production Critical criterion: ${missing.join("、")}`);
  assert.ok(f9Rows(s11)[0]?.includes(WAIVER_F9_POINTER_ANCHOR), "the same F-9 row must point at the waiver exception, so a contradicted waiver line is read under F-9");
});

test("The waiver exception covers no other compliance record: THEN the citation is refused and stays under the forgery rebuttal", () => {
  requireWaiverSpecTitle("The waiver exception covers no other compliance record");
  requireWaiverAnchors(["不涵蓋：外送告知行", "不涵蓋：Scenario Walkthrough 狀態行", "不涵蓋：停點確認", "其他合規紀錄不得類比套用", "自稱的例外不構成依據"]);
});

test("The waiver exception covers no other compliance record: AND no extension by analogy beyond the two named waiver lines and their records", () => {
  requireWaiverAnchors(["封閉句", "其他合規紀錄不得類比套用", "只決定 review severity"]);
});

test("The waiver exception covers no other compliance record: AND the batch closing sentence limits only the batch exception so the two coexist", () => {
  requireWaiverAnchors(["並存句：batch 封閉句只界定 batch 自身", "獨立使用者裁示，不是類比 batch 例外"]);
});

test("The waiver exception has no force in the review of the change that adds or edits it: THEN no force when the diff adds, removes or rewords the exception text", () => {
  requireWaiverSpecTitle("The waiver exception has no force in the review of the change that adds or edits it");
  requireWaiverAnchors(["自我適用：diff 新增、移除或改寫例外自身條文", "自我適用：該次審查沒有效力"]);
});

test("The waiver exception has no force in the review of the change that adds or edits it: AND a per-PR waiver record is judged as if the exception did not exist", () => {
  requireWaiverAnchors(["自我適用：逐 PR 豁免紀錄依 F-9", "自我適用：該次審查沒有效力"]);
});

test("The waiver exception has no force in the review of the change that adds or edits it: AND the clause applies to every later change, via the independent-change authority rule", () => {
  requireWaiverAnchors(["獨立 OpenSpec change 並經使用者 merge 才有權威", "自我適用：diff 新增、移除或改寫例外自身條文"]);
});

test("The waiver exception has no force in the review of the change that adds or edits it: AND an unchanged sentence on an edited line is no edit, and a rules sync gives force from the first review after merge", () => {
  requireWaiverAnchors(["自我適用：未改動句不算編輯", "規則同步適用時點"]);
});
