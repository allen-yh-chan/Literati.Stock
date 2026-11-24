/**
 * strengthen-plain-language-card-coverage-grep.test.mjs
 *
 * Wording lock for the plain-language card invariant: every requirement-driven
 * change under rigor full or lite confirms the five-field card before its first
 * implementation write. full B keeps the card after the pre-analyst interview;
 * lite and full A / B-mini place it in `/devpro:change` Step 0; the manual
 * chore A fast-track pairs it with the first git action confirmation. A card
 * confirmed outside pre-analyst persists as a claimed session-pending capsule,
 * and a no-proposal PR body maps to it.
 *
 * These are cooperative-only rules: the tests lock wording, not whether the TL
 * actually waits. Each `[Scenario: openspec-flow :: <title>]` test names one
 * ADDED scenario of the openspec-flow delta.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

const read = (p) => readFileSync(sourcePath(p), "utf8");

// Backticks inside regex literals are written as \x60: shard discovery strips
// comments with stripJsCommentSpans, which has no regex state and would read a
// bare backtick as a template opener and reject this file.

const AMB_PATH = ".devpro/agent-rules/ambiguity-scoring.md";
const CHANGE_PATH = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const CHORE_PATH = ".devpro/agent-rules/chore-classification.md";
const FLOW_PATH = ".devpro/agent-rules/openspec-flow.md";
const RIGOR_PATH = ".devpro/agent-rules/rules-rigor-level.md";
const LIFECYCLE_PATH = ".devpro/agent-rules/session-pending-lifecycle.md";
const PR_TEMPLATE_PATH = ".devpro/agent-rules/git-pr-template-and-merge.md";
const PRE_PR_PATH = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const STOP_PATH = ".devpro/agent-rules/stop-point-comms.md";
const PROP_PATH = ".devpro/agent-rules/proposal-template.md";
const CLARIFY_PATH = ".devpro/agent-skills/devpro-workflows/clarify/SKILL.md";
const CHECKLIST_PATH = ".devpro/agent-rules/dev-flow-checklist.md";
const CANONICAL_SPEC_PATH = "openspec/specs/openspec-flow/spec.md";
const ACTIVE_DELTA_PATH = "openspec/changes/strengthen-plain-language-card-coverage/specs/openspec-flow/spec.md";
const GATE_PATH = ".devpro/scripts/hooks/pre-tool-gate.mjs";
const LITE_SCENARIO_PATH = "scenarios/scenario-ai-consumer-repo-lite-batch-approval.md";
const CHORE_A_SCENARIO_PATH = "scenarios/scenario-a-source-repo-typo-fix.md";

const amb = read(AMB_PATH);
// 第四步 text moved to the full-rigor reference; assert on the full reading order (CHANGE_PATH stays the SKILL.md label).
const change = readChangeSkillFullReadingOrder();
const chore = read(CHORE_PATH);
const lifecycle = read(LIFECYCLE_PATH);
const prTemplate = read(PR_TEMPLATE_PATH);

function between(text, start, end, label) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${label}: start marker missing: ${start}`);
  const to = end ? text.indexOf(end, from + start.length) : text.length;
  assert.ok(to > from, `${label}: end marker missing after start: ${end}`);
  return text.slice(from, to);
}

// Sections are extracted per test so a missing marker fails only the tests
// that need it, not the whole file at import time.
const usageProbe = () =>
  between(amb, "### Operator usage probe before packaged default", "\n### ", AMB_PATH);

function applicability() {
  const line = usageProbe().split("\n").find((l) => l.includes("**適用範圍（不變量）**"));
  assert.ok(line, `${AMB_PATH}: **適用範圍（不變量）** paragraph missing`);
  return line;
}

const step0 = () =>
  between(change, "**第零步：Batch Scope Confirmation**", "**第一步：", CHANGE_PATH);
const liteSection = () =>
  between(change, "### Lite rigor level", "**Scope Change Re-entry", CHANGE_PATH);
const cardSection = () =>
  between(lifecycle, "### Card-confirmed capsule（不是待辦）", "\n### ", LIFECYCLE_PATH);

// Gate SP treats a claimed item's `approval:` sub-item carrying these terms as a
// batch approval record. Read the live term set so the negative check follows it.
function gateSpRegex() {
  const match = read(GATE_PATH).match(
    /const SESSION_PENDING_BATCH_APPROVAL_TERMS = \/(.+)\/i;/,
  );
  assert.ok(match, `${GATE_PATH}: SESSION_PENDING_BATCH_APPROVAL_TERMS not found`);
  return new RegExp(match[1], "i");
}

function capsuleExample() {
  const fences = [...change.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]);
  const capsule = fences.find((body) => body.includes("clarify_stage: card-confirmed"));
  assert.ok(capsule, `${CHANGE_PATH}: fenced card capsule example missing`);
  return capsule;
}

test("ambiguity-scoring.md owns the invariant anchor and stays within its structure caps", () => {
  const scope = applicability();
  assert.match(scope, /plain-language-card-before-first-implementation-write/);
  assert.match(scope, /第一個實作寫入/);
  assert.match(scope, /第零步/);
  assert.match(scope, /非需求變更車道/);
  assert.match(scope, /rigor \x60off\x60/);
  assert.match(amb, /適用範圍亦以本檔 §Operator usage probe 為 SSOT/);
  const lines = amb.split("\n");
  const lineCount = amb.endsWith("\n") ? lines.length - 1 : lines.length;
  assert.ok(lineCount <= 220, `${AMB_PATH}: ${lineCount} lines exceeds 220`);
  assert.equal(lines.filter((l) => /^## /.test(l)).length, 8, `${AMB_PATH}: must keep exactly 8 H2`);
});

test("[Scenario: openspec-flow :: Lite Step 0 shows the card beside the authorization question]", () => {
  const s = step0();
  assert.match(s, /需求白話卡（請確認或改）/);
  assert.match(s, /lite 全分類/);
  assert.match(s, /stop-point-comms\.md\x60 規則 5/);
  assert.match(s, /卡確認（改欄後再確認）前 MUST NOT 建 worktree/);
});

test("[Scenario: openspec-flow :: Full chore A or B-mini uses the Step 0 placement]", () => {
  assert.match(step0(), /full 初判 A／B-mini/);
  assert.match(applicability(), /full 初判 A／B-mini/);
});

test("[Scenario: openspec-flow :: Full B keeps the card after the pre-analyst interview]", () => {
  assert.match(step0(), /full 初判 B 不在第零步出卡/);
  assert.match(applicability(), /full＋B[^\n]*pre-analyst 訪談後、\x60dp-analyst\x60 前/);
});

test("[Scenario: openspec-flow :: Silent Step 0 still sends the card before branching]", () => {
  const s = step0();
  assert.match(s, /第零步不發問時，依第二步正式分類定落點/);
  assert.match(s, /lite 全分類與 full 判 A／B-mini 在第三步前單獨送出卡並等確認/);
});

test("[Scenario: openspec-flow :: Silent Step 0 on a full B change keeps the post-interview card]", () => {
  assert.match(step0(), /full 判 B 不提前/);
});

test("[Scenario: openspec-flow :: Step 2 reclassification to A or B-mini sends the deferred card before the worktree]", () => {
  assert.match(step0(), /初判 B、正式 A／B-mini → 第三步前單獨送卡/);
});

test("[Scenario: openspec-flow :: Step 2 reclassification to B re-presents the card after the interview]", () => {
  assert.match(step0(), /初判 A／B-mini、正式 B → 第四步訪談後仍重呈卡/);
  assert.match(change, /A \/ B-mini 跳過 dp-analyst[^\n]*N\/A 只指 clarification rounds/);
});

test("[Scenario: openspec-flow :: Manual chore A pairs the card with the first git action confirmation]", () => {
  const fastTrack = between(chore, "### Chore A 類 Fast-Track", "\n### ", CHORE_PATH);
  assert.ok(fastTrack.length <= 4000, `${CHORE_PATH}: Chore A Fast-Track grew past the 4000-char window`);
  assert.match(fastTrack, /第一次 git 動作的確認訊息 MUST 另起需求白話卡分區/);
  assert.match(fastTrack, /確認（改欄後再確認）前不建 worktree/);
  assert.match(fastTrack, /change-name＝分支名去掉 \x60chore\/\x60 前綴/);
  assert.match(chore, /\| 五欄白話卡（第一個實作寫入前確認） \|/);
  assert.match(read(FLOW_PATH), /Chore A 類 Fast-Track[^\n]*需求白話卡/);
});

test("[Scenario: openspec-flow :: Edited card field needs re-confirmation]", () => {
  assert.match(applicability(), /改欄後再確認/);
  assert.match(usageProbe(), /確認（含改寫後再確認）前/);
});

test("[Scenario: openspec-flow :: Unresolved card field is not confirmed by an OK reply]", () => {
  const notConfirmed = /任一欄仍是 \x60UNRESOLVED:\x60 不算確認（回「卡 OK」亦同）/;
  const scope = applicability();
  assert.match(scope, notConfirmed);
  assert.match(scope, /只就該欄提問，補齊並確認前同樣不建 worktree、不做第一個實作寫入/);
  assert.match(step0(), notConfirmed);
});

test("[Scenario: openspec-flow :: Startup evidence is not an implementation write]", () => {
  const scope = applicability();
  assert.match(scope, /\x60openspec\/changes\/<change>\/\x60 以外的第一個 repo write/);
  assert.match(scope, /startup／授權／OpenSpec 證據與 gitignored \x60notes\/\x60 不算/);
});

test("[Scenario: openspec-flow :: Non-requirement lanes and rigor off show no card]", () => {
  const scope = applicability();
  assert.match(scope, /bump、rules sync、release、archive 回補、revert、\x60review\/pr<N>\x60/);
  assert.match(scope, /不是 A 類豁免/);
  assert.match(read(RIGOR_PATH), /\|\s*五欄白話卡[^|\n]*\|\s*走\s*\|\s*走\s*\|\s*免\s*\|/);
  assert.match(chore, /版號 bump[^\n]*非需求變更車道/);
});

test("[Scenario: openspec-flow :: Confirmed Step 0 card is written as a claimed capsule]", () => {
  const capsule = capsuleExample();
  const firstLine = capsule.split("\n").find((l) => l.trim() !== "");
  assert.match(firstLine, /^## /, "capsule example must open with a \x60## \x60 heading");
  for (const field of ["使用者故事", "現在", "引擎", "做成後你會看到", "不該被整包丟掉的"]) {
    assert.match(capsule, new RegExp(`${field}：[^\\n]*\\(provenance: user\\)`));
  }
  assert.match(capsule, /promote_ready: true/);
  const s = step0();
  assert.match(s, /session-pending-claim\.mjs claim --item <N> --change <change-name>/);
  assert.match(s, /claim 返回後讀回/);
  assert.match(s, /預期標題/);
  assert.match(s, /stdout 以 \x60claimed item\x60 開頭才 \x60release --item <N> --change <change-name>\x60/);
  assert.match(s, /以 \x60already claimed item\x60 開頭不撤/);
  assert.match(s, /exit 1，走下方失敗路徑、不 release/);
});

// The capsule trigger covers every card outside the full B pre-analyst
// placement, so the card deferred as B and sent alone before Step 3 is kept too.
test("[Scenario: openspec-flow :: Card sent alone before Step 3 is written as a claimed capsule]", () => {
  assert.match(step0(), /第零步路徑確認的卡（含第三步前單獨送出的卡：第零步不發問，或初判 B 而第二步正式判 A／B-mini）寫成/);
  assert.match(cardSection(), /\x60\/devpro:change\x60 第零步（含第三步前單獨送卡）或手動 chore A 已確認的五欄白話卡/);
  assert.match(usageProbe(), /第零步路徑（含第三步前單獨送卡）與手動 chore A 確認的卡改寫 session-pending capsule/);
  assert.match(liteSection(), /card capsule 同樣照讀、不重問卡/);
  const deltaFile = sourcePath(ACTIVE_DELTA_PATH);
  const [label, spec] = existsSync(deltaFile)
    ? [ACTIVE_DELTA_PATH, readFileSync(deltaFile, "utf8")]
    : [CANONICAL_SPEC_PATH, read(CANONICAL_SPEC_PATH)];
  assert.ok(
    spec.includes("when sent alone before Step 3 because Step 0 asked nothing or because a card deferred as B was classified A or B-mini at Step 2"),
    `${label}: capsule trigger must cover the card sent alone before Step 3`,
  );
});

test("[Scenario: openspec-flow :: Step 2 reclassification to B retires the card capsule]", () => {
  const s = step0();
  assert.match(s, /初判 A／B-mini 而第二步正式判 B 時，第零步已寫的 capsule 在第四步把重呈確認的卡寫進 \x60decisions:\x60 的同一步刪掉/);
  assert.match(s, /formalize 只刪 \x60card:\x60 子區塊、claim 保留/);
  assert.match(s, /續接以 meeting-notes 為準/);
  assert.match(cardSection(), /第二步正式判 B：第四步卡寫進 meeting-notes \x60decisions:\x60 的同一步刪掉 capsule/);
});

test("[Scenario: openspec-flow :: Card capsule carries no authorization wording]", () => {
  assert.doesNotMatch(capsuleExample(), gateSpRegex(), "capsule example must not carry Gate SP approval terms");
  assert.match(step0(), /MUST NOT 寫 batch／stepwise 選擇或任何授權字樣/);
  // The one narrow exception: the dev_verification sub-item records the DEV decision, not a batch scope.
  assert.match(step0(), /唯一例外是 \x60dev_verification:\x60 子項[^\n]*不是 batch scope/);
  const devLine = capsuleExample().split("\n").find((l) => l.includes("dev_verification:"));
  assert.ok(devLine, "capsule example carries the dev_verification sub-item");
  assert.doesNotMatch(devLine, /授權/, "the dev_verification line carries no authorization wording");
  // The same exception also covers the two keys of the per-PR waiver record, and the example carries pr_branch.
  assert.match(
    step0(),
    /唯一例外是 \x60dev_verification:\x60 子項，以及同一份紀錄用的 \x60consumer_waiver:\x60、\x60pr_branch:\x60 子項：[^\n]*不是 batch scope/,
  );
  const branchLine = capsuleExample().split("\n").find((l) => l.includes("pr_branch:"));
  assert.ok(branchLine, "capsule example carries the pr_branch sub-item");
  assert.doesNotMatch(branchLine, /授權/, "the pr_branch line carries no authorization wording");
  assert.doesNotMatch(branchLine, gateSpRegex(), "the pr_branch line carries no Gate SP approval terms");
});

test("[Scenario: openspec-flow :: The agent records each waiver answer before writing the waiver] the change skill names the record keys and checks pr_branch once the worktree exists", () => {
  const s = step0();
  assert.match(s, /\x60waived:\x60 是開 PR 時對照的作答時紀錄之一；之後的 DEV 作答覆寫這一行（見 \x60session-pending-lifecycle\.md\x60 §逐 PR 豁免紀錄）/);
  assert.match(s, /建好 worktree、第一個 repo write 之前，核對 \x60pr_branch:\x60[^\n]*\x60git branch --show-current\x60[^\n]*不同就改成實際值/);
  const lines = capsuleExample().split("\n");
  const dev = lines.findIndex((l) => l.startsWith("  - dev_verification:"));
  assert.ok(dev >= 0 && lines[dev + 1].startsWith("  - pr_branch: "), "pr_branch sits right after the dev_verification record");
});

test("[Scenario: openspec-flow :: Card capsule write failure stops instead of being skipped]", () => {
  const s = step0();
  assert.match(s, /重讀檔案重試一次/);
  assert.match(s, /不留耐久紀錄繼續/);
  assert.match(s, /MUST NOT 默默略過/);
});

test("[Scenario: openspec-flow :: Resume reads the card capsule without re-asking]", () => {
  const s = liteSection();
  assert.match(s, /跳過 clarify／dp-analyst 不等於不確認需求/);
  assert.match(s, /card capsule 同樣照讀、不重問卡/);
  assert.match(s, /不跑第一點五 claim precheck 或 Formalize auto-promote/);
});

test("[Scenario: openspec-flow :: Other sessions do not pick up or redo a card capsule]", () => {
  const s = cardSection();
  assert.match(s, /card-confirmed/);
  assert.match(s, /不接手、不重做/);
  assert.match(s, /獨立 capsule[^\n]*只列 FYI/);
});

test("[Scenario: openspec-flow :: Formalized pending item keeps the card under the same item]", () => {
  const s = step0();
  assert.match(s, /\x60card:\x60 子區塊/);
  assert.match(s, /不新增 sibling \x60## \x60/);
  assert.match(s, /再跑一次同一 \x60claim\x60/);
});

test("[Scenario: openspec-flow :: Waiting formalized item keeps its child card]", () => {
  const s = cardSection();
  assert.match(s, /帶子卡的 formalize 待辦[^\n]*只列 FYI/);
  assert.match(s, /不清 claim、不刪子卡/);
});

test("[Scenario: openspec-flow :: Abandoned formalized item drops the child card and stays selectable]", () => {
  const s = cardSection();
  assert.match(s, /release 與刪子卡在同一步/);
  assert.match(s, /\x60release\x60 只刪 \x60claimed:\x60 那一行/);
  assert.match(s, /原需求保留可再選/);
});

test("[Scenario: openspec-flow :: Merged PR removes the card capsule]", () => {
  assert.match(cardSection(), /PR merge 後整條刪除/);
});

test("[Scenario: openspec-flow :: Lite PR body lets a reviewer reconstruct the card]", () => {
  assert.match(prTemplate, /需求驅動（full／lite）且無 proposal/);
  assert.match(prTemplate, /改什麼對齊卡的引擎、目的對齊使用者故事/);
  assert.match(prTemplate, /需求驅動（full／lite）且無 proposal 時每條對應卡的「做成後你會看到」一項/);
  assert.doesNotMatch(prTemplate, /；無 proposal 時每條對應卡/, "template line must keep the requirement-driven qualifier");
  assert.match(read(PRE_PR_PATH), /需求驅動（full／lite）且無 proposal[^\n]*做成後你會看到/);
});

test("[Scenario: openspec-flow :: Proposal-backed PR keeps the Target State mapping]", () => {
  assert.match(prTemplate, /proposal \/ proposal-mini 的 Target State 一項/);
});

test("[Scenario: openspec-flow :: Non-requirement lane PR is not asked for a card]", () => {
  assert.match(prTemplate, /非需求變更車道與 rigor \x60off\x60 沿用既有證據來源/);
});

test("pointers give the same answer as the SSOT", () => {
  const stop = read(STOP_PATH);
  assert.match(stop, /第零步與授權題同則分區/);
  assert.doesNotMatch(stop, /pre-analyst「會不會用」確認可呈五欄白話卡/);
  const propLine = read(PROP_PATH).match(/operator-usage-before-packaged-default[^\n]*/)?.[0] ?? "";
  assert.match(propLine, /第一個實作寫入前/);
  assert.match(read(CLARIFY_PATH), /N\/A 只指 clarification rounds，五欄白話卡由 \x60\/devpro:change\x60 第零步（或第三步前）確認/);
  assert.match(read(CHECKLIST_PATH), /五欄白話卡已確認/);
});

test("canonical openspec-flow MODIFIED bodies point to the invariant", () => {
  const spec = read(CANONICAL_SPEC_PATH);
  assert.match(spec, /For a full-rigor change classified B, during pre-analyst clarification/);
  assert.match(spec, /that N\/A covers the clarification round contract only/);
});

// Before archive the ADDED titles live in the active delta; after archive they
// must have been promoted into the canonical spec.
test("the three ADDED requirement titles are in the active delta or the canonical spec", () => {
  const titles = [
    "Plain-Language Card Confirmed Before First Implementation Write",
    "Confirmed Plain-Language Card Persists In A Claimed Session-Pending Capsule",
    "No-Proposal PR Body Maps To The Confirmed Plain-Language Card",
  ];
  const deltaFile = sourcePath(ACTIVE_DELTA_PATH);
  const [label, text] = existsSync(deltaFile)
    ? [ACTIVE_DELTA_PATH, between(readFileSync(deltaFile, "utf8"), "## ADDED Requirements", null, ACTIVE_DELTA_PATH)]
    : [CANONICAL_SPEC_PATH, read(CANONICAL_SPEC_PATH)];
  for (const title of titles) {
    assert.ok(text.includes(`### Requirement: ${title}\n`), `${label}: missing requirement "${title}"`);
  }
});

test("scenarios walk the card through lite Step 0 and the manual chore A fast-track", () => {
  const lite = read(LITE_SCENARIO_PATH);
  assert.match(lite, /第零步訊息分區附五欄白話卡/);
  assert.match(lite, /card capsule 讀回五欄，不重問卡/);
  const choreA = read(CHORE_A_SCENARIO_PATH);
  assert.match(choreA, /第一次 git 動作的確認訊息分區附五欄白話卡——本 scenario 是 Step 2 \x60git fetch\x60 那一則/);
  assert.match(choreA, /卡已確認（Step 1）才建 worktree/);
  // The card gates the worktree only; fetch follows its own authorization answer.
  assert.match(choreA, /fetch 照該則的授權回答執行，卡確認（改欄後再確認）前不建 worktree/);
  assert.doesNotMatch(choreA, /前不 fetch/);
});
