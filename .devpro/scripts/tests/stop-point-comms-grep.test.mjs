import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const LEAF = ".devpro/agent-rules/stop-point-comms.md";

test("stop-point-comms leaf carries the three handoff elements", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /為什麼停/, "missing state element");
  assert.match(leaf, /要你做什麼/, "missing ask element");
  assert.match(leaf, /回了會怎樣/, "missing next element");
});

test("stop-point-comms leaf mandates numbered options + escape hatch + plain-language gloss", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /選項.*編號|編號（1\/2\/3/, "missing numbered-option rule");
  // Anchor on the load-bearing concept (last option must be an open item), NOT the
  // literal string 逃生口 — the rule was consolidated so `3.其他` can serve as the
  // open item; asserting the bare word would fight that direction and spurious-fail
  // if the remaining negating mentions of 逃生口 are later cleaned up.
  assert.match(leaf, /末項.*開放項|最後一項必須是開放項/, "missing open-last-item (escape-hatch) rule");
  assert.match(leaf, /以上都不是 \/ 我想直接跟你說/, "missing escape-hatch canonical wording");
  assert.match(leaf, /術語.*配白話|不判斷.*新手/, "missing plain-language / no-persona-guess rule");
});

// Extract rule 2 body EXCLUDING its heading line — so assertions test the rule's
// actual prose, not text that merely echoes the heading (cross-review Important:
// the heading itself contains 匹配真實分岔, which would satisfy a naive match).
function rule2Body(leaf) {
  const m = leaf.match(/\*\*2\.\s*問法匹配真實分岔數[^\n]*\n([\s\S]*?)(?=\*\*3\.)/);
  assert.ok(m, "rule 2 (問法匹配真實分岔數) section not found");
  return m[1]; // group 1 = everything AFTER the heading line
}

// The substantive assertions rule 2's body must carry, keyed for reuse by both the
// positive test and the negative (mutation) test below.
function assertRule2Body(body) {
  // Count-match requirement stated in the body prose (not just echoed in heading).
  assert.match(body, /選項數量必須匹配真實分岔|數量必須匹配真實分岔/, "rule 2 body must require option count match the real branch count");
  // 是/否/其他 default for a single confirmed action.
  assert.match(body, /1\.是\s*2\.否\s*3\.其他/, "rule 2 body must state the 1.是 2.否 3.其他 default");
  // Explicit prohibition against inflating a yes/no decision into a menu.
  assert.match(body, /禁止/, "rule 2 body must carry the 禁止 prohibition");
  assert.match(body, /膨脹/, "rule 2 body must prohibit inflating yes/no into a menu (膨脹)");
  // Claimed-count consistency: prose-stated option count must equal the numbered
  // item count (escape hatch included). Catches "兩條路" + 3 options mismatch.
  assert.match(body, /宣稱數一致/, "rule 2 body must require prose-claimed count == numbered item count");
  assert.match(body, /末項開放項也算一項/, "rule 2 must state the open last-item counts as one option in the claimed count");
  // Renderer renumbering: a second ordered list in the same message is shown with
  // continued numbers (options 1/2/3 displayed as 5/6/7), so the user's numeric reply
  // no longer matches what the agent wrote. The rule must name the failure and the fix.
  assert.match(body, /編號不被渲染器接續/, "rule 2 body must carry the renderer-continued-numbering clause");
  assert.match(body, /唯一.{0,12}有序清單|只放\*{0,2}一組\*{0,2}有序清單/, "rule 2 body must require the options to be the ONLY ordered list in the message");
  assert.match(body, /無序符號/, "rule 2 body must send non-option enumerations to unordered bullets");
  // The pre-send scan must not contradict the multi-question form: a single question has
  // exactly one line-start ordered list (the options), a multi-question message has none
  // (its options are inline). One count for both cases would flag the compliant multi-question
  // message as a violation (cross-model round 1, PR #3115).
  assert.match(body, /單題時[^\n]*一組[^\n]*多問題並列時[^\n]*零組/, "rule 2 body must state one ordered list for a single question and zero for multi-question");
  assert.match(body, /單題的行首 `N\.` 有序清單組數不是 1、或多題不是 0/, "the pre-send scan must give separate counts for single- and multi-question messages");
}

test("stop-point-comms rule 2 body requires option count to MATCH the real branch count", () => {
  assertRule2Body(rule2Body(read(LEAF)));
});

// Negative test (in-memory mutation, real file untouched): deleting the body's
// count-match / 禁止膨脹 clauses MUST fail the assertion — proving the assertion
// guards the body prose, not the heading. Addresses cross-review Important #1+#3
// ("負向測試" claimed but previously absent from the file).
test("stop-point-comms rule 2 assertion FAILS when the body clauses are removed (negative)", () => {
  const body = rule2Body(read(LEAF));
  const mutated = body
    .replace(/選項數量必須匹配真實分岔/g, "")
    .replace(/數量必須匹配真實分岔/g, "")
    .replace(/禁止/g, "")
    .replace(/膨脹/g, "");
  assert.throws(() => assertRule2Body(mutated), "removing rule 2's body clauses must break the assertion (else it is a rubber stamp)");
});

test("stop-point-comms rule 2 assertion FAILS when the renderer-numbering clause is removed (negative)", () => {
  const body = rule2Body(read(LEAF));
  for (const anchor of [/編號不被渲染器接續/g, /無序符號/g, /多問題並列時[^\n]*零組/g, /多題不是 0/g]) {
    assert.throws(
      () => assertRule2Body(body.replace(anchor, "")),
      `removing ${anchor} must break the assertion`,
    );
  }
});

test("stop-point-comms multi-question example writes options inline, not as a line-start ordered list", () => {
  const leaf = read(LEAF);
  const m = leaf.match(/\*\*多問題並列\*\*（如 ambiguity）：[^\n]*/);
  assert.ok(m, "multi-question worked example not found");
  assert.match(m[0], /行內/, "multi-question example must say per-question options are written inline");
});

test("stop-point-comms worked examples cover BOTH the 是/否/其他 shape and a real multi-branch shape", () => {
  const leaf = read(LEAF);
  // Single-confirmed-action example (是/否/其他) must exist.
  assert.match(leaf, /單一確定動作 → 1\.是 2\.否 3\.其他/, "missing the 是/否/其他 worked example");
  // Real multi-branch example must show ≥2 DISTINCT real options (not just one) —
  // checking both enforce AND strengthen proves it models real branching.
  assert.match(leaf, /enforce/, "multi-branch example missing option 1 (enforce)");
  assert.match(leaf, /strengthen/, "multi-branch example missing option 2 (strengthen) — must show ≥2 real branches");
});

const ESCAPE_HATCH_CANON = "以上都不是 / 我想直接跟你說";

// Parse a worked-example blockquote line that lists numbered options, return the
// option entries in order: [{ num, text }]. Matches `**1.** ...` / `**4.** ...`
// markers within a single `> **要你做什麼**` line.
function parseNumberedOptions(line) {
  const opts = [];
  const re = /\*\*(\d+)\.\*\*\s*([^*]+?)(?=\s*\*\*\d+\.\*\*|$)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    opts.push({ num: Number(m[1]), text: m[2].trim().replace(/[。\s]+$/, "") });
  }
  return opts;
}

test("stop-point-comms worked example puts the open item (3.其他兼任) as the LAST option", () => {
  const leaf = read(LEAF);
  // Find the verb-whitelist worked example's 要你做什麼 line (the canonical full example).
  // In the new rule, option 3 = "以上都不是 / 我想直接跟你說" IS the open item that serves
  // as the escape hatch — not a separate 4th item. The last option is still the canon string.
  const exampleLine = leaf
    .split("\n")
    .find((l) => l.includes("要你做什麼") && /\*\*1\.\*\*/.test(l) && l.includes("enforce"));
  assert.ok(exampleLine, "worked example with numbered options not found");

  const opts = parseNumberedOptions(exampleLine);
  assert.ok(opts.length >= 2, `expected ≥2 numbered options, got ${opts.length}`);

  // Position rule: the highest-numbered option IS the open item (兼任逃生口), verbatim canon.
  const last = opts.reduce((a, b) => (b.num > a.num ? b : a));
  assert.equal(
    last.text,
    ESCAPE_HATCH_CANON,
    `last option must be the canonical open item "${ESCAPE_HATCH_CANON}", got "${last.text}"`,
  );
  // And no earlier option may already be the canon open item (it belongs last only).
  for (const o of opts) {
    if (o.num !== last.num) {
      assert.notEqual(o.text, ESCAPE_HATCH_CANON, `open item must be last, found at option ${o.num}`);
    }
  }
});

// Extract the body of rule 3 (末項是開放項) only: from its bold heading up to the next
// bold rule heading (**4. ...). Scoping the coupling assertion to this paragraph
// prevents a stray canon match elsewhere in the file from satisfying the rule.
function rule3Body(leaf) {
  const m = leaf.match(/\*\*3\.\s*末項是開放項[^*]*\*\*([\s\S]*?)(?=\*\*4\.)/);
  assert.ok(m, "rule 3 (末項是開放項) section not found");
  return m[1];
}

test("stop-point-comms rule 3 body couples 「末項=開放項」 with the canon — same paragraph", () => {
  const body = rule3Body(read(LEAF));
  // Both the position rule AND the canon must live inside rule 3's own body,
  // not merely somewhere in the file.
  assert.match(body, /最後一項必須是開放項/, "rule 3 must require the last option be the open/escape item");
  assert.match(body, new RegExp(ESCAPE_HATCH_CANON), "rule 3 must state the canonical escape-hatch wording");
  // The fixed thing is the position semantics, stated explicitly to avoid the
  // 'is it wording or semantics' ambiguity flagged in cross-review.
  assert.match(body, /固定的是「末項[＝=]開放出口」/, "rule 3 must clarify the fixed semantics is position, not a fixed line");
});

// Guard the NEW semantic: rule 3 must explicitly state that 3.其他 qualifies as the
// open item and no separate independent 逃生口 item is needed when 3.其他 is present.
// This prevents regression where someone re-adds the "mandatory separate 逃生口" requirement.
test("stop-point-comms rule 3 body explicitly states 3.其他 can serve as the open item (no separate hatch needed)", () => {
  const body = rule3Body(read(LEAF));
  // Must state that 3.其他 (or equivalent) is itself a qualifying open item.
  assert.match(
    body,
    /3\.其他.*開放|不必再額外加一個獨立|不必另起獨立/,
    "rule 3 must explicitly state 3.其他 qualifies as open item so no separate independent 逃生口 is needed",
  );
});

test("stop-point-comms leaf has a Verification section", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /## Verification/, "missing Verification section");
});

// Line-scope the assertion to the §0 Always row itself, not the whole file —
// otherwise the rule text could be deleted from Always while still passing on a
// stray match elsewhere.
function alwaysRow(agents) {
  const lines = agents.split("\n");
  const idx = lines.findIndex((l) => /^###\s+Always/.test(l));
  assert.ok(idx !== -1, "AGENTS.md §0 Always heading not found");
  // The Always rules live on the first non-empty content line after the heading.
  const row = lines.slice(idx + 1).find((l) => l.trim().length > 0);
  assert.ok(row, "AGENTS.md Always row content not found");
  return row;
}

test("AGENTS.md §0 Always row itself carries the stop-handoff rule (line-scoped)", () => {
  const agents = read("AGENTS.md");
  const row = alwaysRow(agents);
  assert.match(row, /停下交回使用者必附交棒/, "Always row missing the stop-handoff rule");
  assert.match(row, /編號/, "Always row must name the numbered-option requirement");
  assert.match(row, /末項.*開放項|開放項/, "Always row must name the open-last-item requirement");
});

test("AGENTS.md trigger index points 停下等使用者／交棒 to the leaf", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /停下等使用者／交棒/, "missing trigger-index scenario label");
  assert.match(agents, /stop-point-comms\.md/, "missing pointer to stop-point-comms leaf");
});

// Layer-ownership guard (Path B+): stop-point-comms.md owns the PRESENTATION layer
// only; the element/content model (五項) is owned by ai-autonomy.md. This guard
// mechanically pins that split so a future edit cannot silently move the element-model
// SSOT into this leaf (which would recreate the dual-owner drift Finding 1 fixed) or
// let the two files diverge with no declared relationship. Deliberately paired with
// post-pr-completion-gate-grep.test.mjs, which pins the element list verbatim inside
// ai-autonomy.md; together they keep exactly one home per layer, cross-linked.
test("stop-point-comms leaf defers the element model to ai-autonomy.md, not owns it", () => {
  const leaf = read(LEAF);
  // MUST point back to the element-model owner section by name.
  assert.match(
    leaf,
    /ai-autonomy\.md[^\n]*Stop-Point Next Step Contract/,
    "presentation leaf must cite ai-autonomy.md §Stop-Point Next Step Contract as the element-model owner",
  );
  // MUST NOT re-declare itself as the authoritative/only home of the element model.
  assert.doesNotMatch(
    leaf,
    /element model 的唯一權威定義|交棒 element model 的唯一/,
    "presentation leaf must NOT claim to be the element-model SSOT (owner is ai-autonomy.md)",
  );
});

test("stop-point-comms leaf has final-response owner self-check", () => {
  const leaf = read(LEAF);

  for (const phrase of [
    "Final-response self-check",
    "本 turn 結束後球在誰手上",
    "AskFirstPending",
    "cross-repo PR 停點",
    "open PR",
    "not merged",
    "agent-facing",
    "不要製造選項",
  ]) {
    assert.match(leaf, new RegExp(phrase));
  }
  assert.doesNotMatch(leaf, /ExternalDisclosureApproval/, "same-repo disclosure is no longer a stop-point class");
  assert.doesNotMatch(leaf, /overlay 收緊|收緊的外送|採用告知|採用即同意|Second-review disclosure/, "the retired disclosure framework and its overlay stop are gone");
  assert.match(
    leaf,
    /cross-repo PR 停點（builder `pr_repository_mismatch`）/,
    "the user-owned stop example is the cross-repo PR that the builder refuses with pr_repository_mismatch",
  );
});

test("stop-point-comms Final-response self-check Matching Ledger exception forbids manufactured options", () => {
  const leaf = read(LEAF);
  const m = leaf.match(/### Final-response self-check\n\n([\s\S]*?)(?=\n### )/);
  assert.ok(m, "Final-response self-check section not found");
  const line = m[1].split("\n").find((l) => /Matching Ledger/.test(l) && /MUST NOT/.test(l));
  assert.ok(line, "self-check missing Matching Ledger exception line");
  assert.match(
    line,
    /Matching Ledger[^\n]*覆蓋[^\n]*MUST NOT[^\n]*編號選項/,
    "self-check must bind Matching Ledger coverage to MUST NOT 編號選項 on one line",
  );
  assert.match(line, /ai-autonomy\.md/, "self-check exception must cite ai-autonomy.md");
});

test("stop-point-comms tests-green 通吃範例 Matching Ledger exception forbids 1.是 2.否 3.其他", () => {
  const leaf = read(LEAF);
  const m = leaf.match(/單一確定動作 → 1\.是 2\.否 3\.其他[\s\S]*?(?=\n\*\*例：規則 5)/);
  assert.ok(m, "tests-green 通吃範例 block not found");
  assert.match(
    m[0],
    /Matching Ledger 例外[^\n]*MUST NOT[^\n]*製造/,
    "通吃範例 must carry Matching Ledger exception against manufacturing numbered options",
  );
});

// Rule 5 (選項呈現契約) — appended after rule 4; MUST NOT renumber 1–4.
function rule5Body(leaf) {
  const m = leaf.match(/\*\*5\.\s*選項呈現契約[^\n]*\n([\s\S]*?)(?=\n### |\n## )/);
  assert.ok(m, "rule 5 (選項呈現契約) section not found");
  return m[1];
}

function assertRule5Body(body) {
  assert.match(body, /提案確認/, "rule 5 must require 提案確認 main path");
  assert.match(body, /作文題主路徑/, "rule 5 must name 作文題主路徑 ban");
  assert.match(body, /選項旁/, "rule 5 must require rationale beside the option (選項旁)");
  assert.match(body, /為什麼有推薦/, "rule 5 must ban empty label 為什麼有推薦");
  assert.match(body, /禁止/, "rule 5 must carry 禁止");
}

test("stop-point-comms rule 5 body carries option-presentation contract anchors", () => {
  assertRule5Body(rule5Body(read(LEAF)));
});

test("stop-point-comms rules 1–4 section markers still present (no renumber)", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /\*\*1\.\s*三要素/, "rule 1 heading missing");
  assert.match(leaf, /\*\*2\.\s*問法匹配真實分岔數/, "rule 2 heading missing");
  assert.match(leaf, /\*\*3\.\s*末項是開放項/, "rule 3 heading missing");
  assert.match(leaf, /\*\*4\.\s*術語配白話/, "rule 4 heading missing");
  // rule 2/3 cutters used by existing tests must still find their end anchors
  assert.ok(rule2Body(leaf).length > 0, "rule 2 body cutter broken");
  assert.ok(rule3Body(leaf).length > 0, "rule 3 body cutter broken");
});

test("stop-point-comms rule 5 assertion FAILS when presentation clauses are removed (negative)", () => {
  const body = rule5Body(read(LEAF));
  const mutated = body
    .replace(/提案確認/g, "")
    .replace(/作文題主路徑/g, "")
    .replace(/選項旁/g, "")
    .replace(/為什麼有推薦/g, "");
  assert.throws(
    () => assertRule5Body(mutated),
    "removing rule 5 presentation clauses must break the assertion",
  );
});

test("stop-point-comms worked example demonstrates rationale beside recommended option", () => {
  const leaf = read(LEAF);
  assert.match(
    leaf,
    /規則 5 提案確認|推薦理由在選項旁/,
    "missing rule 5 worked-example marker",
  );
  assert.match(leaf, /推薦：/, "worked example must show inline 推薦： rationale beside an option");
});

function mergeAskFirstPointerBody(leaf) {
  const m = leaf.match(
    /### Merge Ask First \/ post-PR Ready Response（pointer-only）\n([\s\S]*?)(?=\n### |\n## )/,
  );
  assert.ok(m, "Merge Ask First / post-PR Ready Response pointer section not found");
  return m[1];
}

function assertMergeAskFirstPointerBody(body) {
  const lines = body.split("\n");
  const mustOrder = lines.find((l) =>
    /MUST[^\n]*ChangeContext:[^\n]*然後[^\n]*ManualTest:/.test(l),
  );
  assert.ok(
    mustOrder,
    "pointer body MUST require ChangeContext: then ManualTest: on the same physical line",
  );
  const ssotPointer = lines.find((l) =>
    /post-pr-completion-gate\.md[^\n]*Ready Response Next-Step Contract/.test(l),
  );
  assert.ok(
    ssotPointer,
    "pointer body must cite post-pr-completion-gate.md §Ready Response Next-Step Contract on the same physical line",
  );
  const noCopy = lines.find((l) =>
    /禁止複寫完整 ChangeContext／ManualTest 正文/.test(l),
  );
  assert.ok(
    noCopy,
    "pointer body must forbid copying the full ChangeContext/ManualTest body on the same physical line",
  );
  const notEvery = lines.find((l) =>
    /MUST NOT[^\n]*每一個 stop-point/.test(l),
  );
  assert.ok(
    notEvery,
    "pointer body MUST NOT require ChangeContext/ManualTest on every stop-point (same physical line)",
  );
}

test("stop-point-comms pointers merge Ask First / Ready Response to ChangeContext SSOT", () => {
  assertMergeAskFirstPointerBody(mergeAskFirstPointerBody(read(LEAF)));
});

test("stop-point-comms merge-Ask-First pointer assertion FAILS when polarity clauses are removed (negative)", () => {
  const body = mergeAskFirstPointerBody(read(LEAF));
  const mutated = body
    .replace(/MUST/g, "")
    .replace(/ChangeContext:/g, "")
    .replace(/ManualTest:/g, "")
    .replace(/每一個 stop-point/g, "")
    .replace(/禁止複寫完整 ChangeContext／ManualTest 正文/g, "");
  assert.throws(
    () => assertMergeAskFirstPointerBody(mutated),
    "removing merge-Ask-First pointer polarity clauses must break the assertion",
  );
});

test("stop-point-comms Cross-References cites post-pr-completion-gate ChangeContext SSOT", () => {
  const leaf = read(LEAF);
  const m = leaf.match(/## Cross-References\n([\s\S]*?)(?=\n## |\n*$)/);
  assert.ok(m, "missing Cross-References section");
  const xrefLines = m[1].split("\n");
  const ssotXref = xrefLines.find((l) =>
    /post-pr-completion-gate\.md[^\n]*Ready Response Next-Step Contract/.test(l),
  );
  assert.ok(
    ssotXref,
    "Cross-References must cite post-pr-completion-gate.md §Ready Response Next-Step Contract on the same physical line",
  );
});

test("stop-point-comms MUST NOT copy ChangeContext/ManualTest SSOT body", () => {
  const leaf = read(LEAF);
  assert.doesNotMatch(
    leaf,
    /WARN ≤4 landing/,
    "presentation leaf must not copy Ready Response SSOT body token WARN ≤4 landing",
  );
  assert.doesNotMatch(
    leaf,
    /檔案清單當標題/,
    "presentation leaf must not copy Ready Response SSOT body token 檔案清單當標題",
  );
});
