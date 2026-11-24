/**
 * pre-pr-dev-verify-grep.test.mjs
 *
 * Pre-PR DEV verification: a consumer (or unknown) repo decides DEV verification
 * for every PR whether or not `.devpro/pre-pr-checks.local.md` exists. Step 0 of
 * `/devpro:change` asks the DEV question and records it as `dev_verification:`;
 * pre-PR follows the record; Gate 4c and the MCP client policy check the format of
 * the `DEV deploy-verify:` evidence line.
 *
 * These anchors keep the SSOT leaf, the change and pre-PR skills, the checklist,
 * the PR template and the testing/release leaves in step with each other. Each
 * `[Scenario: openspec-flow :: <title>]` test names one scenario of the openspec-flow
 * delta of fix-pre-pr-dev-verification-trigger. The gate and policy scenarios are
 * covered by the hook, policy and evidence-line tests.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceRoot } from "./lib/source-root.mjs";
import { extractDeclaredLoadChainRefs } from "../lib/load-chain-declarations.mjs";
import { consumerDevVerifyEvidenceError } from "../lib/consumer-pre-pr-gate.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolveSourceRoot(path.resolve(path.dirname(THIS_FILE), "../../.."));
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const LEAF_REL = ".devpro/agent-rules/pre-pr-dev-verification.md";
const LEAF_NAME = "pre-pr-dev-verification.md";
const CONTRACT_REL = ".devpro/agent-rules/consumer-pre-pr-checks.md";
const CHANGE_REL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const PRE_PR_REL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const CHECKLIST_REL = ".devpro/agent-rules/dev-flow-checklist.md";
const TEMPLATE_REL = ".devpro/agent-rules/git-pr-template-and-merge.md";
const TESTING_REL = ".devpro/agent-rules/testing-and-qa.md";
const RELEASE_REL = ".devpro/agent-rules/release-sit-uat-pat-prod.md";
const RIGOR_REL = ".devpro/agent-rules/rules-rigor-level.md";
const POST_PR_REL = ".devpro/agent-rules/post-pr-completion-gate.md";
const BUDGET_REL = ".devpro/scripts/lib/rule-token-budget.mjs";
const README_REL = "README.md";
const EVIDENCE_PREFIX = "DEV deploy-verify: HEAD <full-sha>;";

function sliceSection(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  assert.notEqual(start, -1, `section heading exists: ${heading}`);
  let end = lines.length;
  const level = heading.match(/^#+/)[0].length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6}) \S/.exec(lines[index]);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function requireOrdered(haystack, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    assert.ok(index >= 0, `${label}: missing or out of order "${needle}"`);
    cursor = index;
  }
}

function lineStartingWith(text, prefix, label) {
  const hits = text.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(hits.length, 1, `${label}: expected exactly one line starting with ${prefix}, found ${hits.length}`);
  return hits[0];
}

const leaf = () => read(LEAF_REL);
const leafSection = (heading) => sliceSection(leaf(), heading);
// Step 0 of the change skill: from the Step 0 heading to Step 1.
const step0 = () => {
  const text = read(CHANGE_REL);
  const from = text.indexOf("**第零步：Batch Scope Confirmation**");
  const to = text.indexOf("**第一步：", from);
  assert.ok(from >= 0 && to > from, "Step 0 of the change skill is present");
  return text.slice(from, to);
};
const devGate = () => sliceSection(read(PRE_PR_REL), "### Pre-PR DEV Verification Gate");
// Assembled at run time so this file does not hold the retired wording as a literal.
const RETIRED_STATUS_WORDING = ["not ", "verified"].join("");

// --- Step 0 ------------------------------------------------------------------

test("[Scenario: openspec-flow :: Consumer change asks the DEV question at Step 0 beside the batch question]", () => {
  const text = step0();
  const question = lineStartingWith(text, "**條件式 DEV 驗證題（併入第零步同一則訊息）**", "DEV question paragraph");
  requireOrdered(
    question,
    ["consumer", "`lite`／`full` 才問", "source repo 與 `off` 不問", "初判", "理由", "入口查找結果", `\`${LEAF_NAME}\``],
    "DEV question applies to consumer lite/full, carries the initial judgement, reason and search result, and names the leaf",
  );
  requireOrdered(
    question,
    ["main-tip 題之後", "需求白話卡之前"],
    "DEV question sits after the main-tip question and before the plain-language card",
  );
  requireOrdered(
    question,
    ["初判需要", "`1. 開 PR 前部署 DEV 驗證`", "`2. 本 PR 不做 DEV（附原因）`", "`3. 先開 PR，DEV 記 pending:`", "`4. 其他`"],
    "needed: deploy before the PR, no DEV for this PR, open the PR with pending:, other",
  );
  requireOrdered(
    question,
    ["初判不需要", "`1. 同意不需要（N/A: <理由>）`", "`2. 其實需要：開 PR 前部署 DEV 驗證`", "`3. 其他`"],
    "not needed: agree to N/A, actually needed, other",
  );
  requireOrdered(
    text,
    ["為什麼停 → 授權選項 → （條件式）main-tip 題 → （條件式）DEV 驗證題 → 需求白話卡 → 回了會怎樣"],
    "layout puts the DEV question after the main-tip question and before the card",
  );
});

test("[Scenario: openspec-flow :: Silent Step 0 asks the DEV question alone before branching]", () => {
  const question = lineStartingWith(step0(), "**條件式 DEV 驗證題（併入第零步同一則訊息）**", "DEV question paragraph");
  requireOrdered(
    question,
    ["請求已明說 batch／stepwise 而第零步不發問時", "DEV 題在建分支前單獨問", "可與 main-tip 單獨題、單獨送卡併成一則", "回答前不得建分支"],
    "silent Step 0 asks alone before branching and may share a message with the main-tip question and a card sent alone",
  );
});

test("[Scenario: openspec-flow :: The Step 0 DEV answer is recorded for this change only]", () => {
  const record = lineStartingWith(step0(), "**`dev_verification:` 記錄（綁本 change）**", "dev_verification record paragraph");
  requireOrdered(
    record,
    ["deploy-before-pr", "n/a: <理由>", "waived: <理由>", "open-pr-pending: <缺什麼>", "entry:", "(provenance: user)"],
    "the skill defines the dev_verification line with its four values",
  );
  requireOrdered(
    record,
    [
      "lite 全分類與 full 初判 A／B-mini 寫進 card capsule 的 `dev_verification:` 子項",
      "full 初判 B 寫進第三步 `meeting-notes.md` 的 Startup evidence",
    ],
    "capsule sub-item for lite and full A / B-mini, Startup evidence for full B",
  );
  requireOrdered(
    record,
    ["與 capsule 同生同滅", "PR merge 後才整條刪除", "壓縮、重啟或 clear 後照讀、不重問", "重分類為 full B", "meeting-notes Startup evidence"],
    "the line lives as long as the capsule and moves to Startup evidence on reclassification to full B",
  );
  requireOrdered(
    record,
    ["只綁本 named change 與 branch", "scope change re-entry MUST 重問"],
    "binds only the named change and branch; scope change re-entry asks again",
  );
  assert.ok(!record.includes("授權"), "the dev_verification record paragraph carries no authorization wording");
  requireOrdered(
    leafSection("### 第零步記錄"),
    ["dev_verification: <deploy-before-pr | n/a: <理由> | waived: <理由> | open-pr-pending: <缺什麼>>; entry: <入口形狀> (provenance: user)"],
    "the leaf owns the closed vocabulary",
  );
  const text = step0();
  requireOrdered(
    text,
    ["MUST NOT 寫 batch／stepwise 選擇或任何授權字樣", "唯一例外是 `dev_verification:` 子項", "不是 batch scope", `\`${LEAF_NAME}\` 的封閉字彙`],
    "the capsule rule keeps its sentence and adds the narrow dev_verification exception",
  );
  const capsule = [...text.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]).find((body) => body.includes("clarify_stage: card-confirmed"));
  assert.ok(capsule, "capsule example exists");
  const devLine = capsule.split("\n").find((line) => line.includes("dev_verification:"));
  assert.ok(devLine, "the capsule example carries a dev_verification sub-item");
  assert.ok(!devLine.includes("授權"), "the capsule dev_verification line has no authorization wording");
  requireOrdered(capsule, ["- decided:", "dev_verification:", "- next:"], "dev_verification sits after decided: and before next:");
});

// --- pre-PR DEV gate ---------------------------------------------------------

test("[Scenario: openspec-flow :: Pre-PR follows the recorded DEV decision without asking again]", () => {
  const skill = read(PRE_PR_REL);
  const lines = skill.split("\n");
  const indexesOf = (heading) => lines.flatMap((line, index) => (line === heading ? [index] : []));
  const gate = indexesOf("### Pre-PR DEV Verification Gate");
  const consumer = indexesOf("### Consumer Pre-PR Checks Gate");
  const step4 = indexesOf("### Step 4: PR Description");
  assert.equal(gate.length, 1, "exactly one Pre-PR DEV Verification Gate heading");
  assert.equal(consumer.length, 1);
  assert.equal(step4.length, 1);
  assert.ok(consumer[0] < gate[0] && gate[0] < step4[0], "DEV gate sits after the Consumer gate and before Step 4");

  const body = devGate();
  requireOrdered(body, ["其他可執行的驗證", "做完之後", "Step 4 之前"], "the gate runs after the other runnable verification");
  requireOrdered(
    body,
    ["`deploy-before-pr` → 部署當前 PR head build 到 DEV 並驗證，不再問"],
    "a deploy-before-pr record deploys the current PR head build without asking again",
  );
  requireOrdered(body, ["不依賴 `.devpro/pre-pr-checks.local.md` 是否存在"], "the gate does not depend on whether the local checks file exists");
  assert.ok(lines.length <= 500, "pre-pr SKILL.md stays within the 500-line lint limit");
  const processOpener = sliceSection(skill, "## Process");
  assert.match(processOpener, /lite 依矩陣免[^\n]*保留測試[^\n]*Pre-PR DEV Verification Gate/, "lite keep-list names the DEV gate");
});

test("[Scenario: openspec-flow :: A missing record or a diff that contradicts the Step 0 judgement is asked before the PR]", () => {
  const body = devGate();
  requireOrdered(
    body,
    ["沒有記錄", "記錄與 diff 判定不符", "入口與記錄不同", "只有這三種才在 PR 前補問", "選項同第零步"],
    "the three conditions are the only reasons to ask again and the options match Step 0",
  );
});

// --- leaf: judgement, entry search -------------------------------------------

test("[Scenario: openspec-flow :: A deployable change is judged and its deploy entry is searched without the local checks file]", () => {
  requireOrdered(
    leafSection("### 判定"),
    ["runtime", "startup", "config", "DB migration", "外部介接", "→ 需要 DEV 驗證", "判斷不出來 → 當作需要", "`.devpro/pre-pr-checks.local.md` 是否存在無關"],
    "deployable changes need DEV, an unclassifiable change is treated as needing it, and the file does not matter",
  );
  const search = leafSection("### 部署入口查找");
  requireOrdered(
    search,
    ["1. HEAD 的 `.devpro/pre-pr-checks.local.md` 的 `## DEV deploy-verify` 段", "2. 專案驗證入口", "3. 部署 workflow 或腳本", "4. 環境設定位置"],
    "search order: local section, project verification entry, workflow or script, environment settings location",
  );
  requireOrdered(
    search,
    ["第一個能部署當前 PR head build 的來源即為入口", "每個來源（含第 1 步的 local 段）同一判準", "`env-only: <路徑>` 線索並繼續找"],
    "every source passes the same test and a source that only shows an environment is an env-only clue",
  );
  requireOrdered(
    search,
    ["只定位，MUST NOT 讀取或印出內容", "`searched: <清單>; none`"],
    "environment settings are only located and the result has the three closed shapes",
  );
});

test("[Scenario: openspec-flow :: An integration-only deployment workflow is not a PR head deploy entry]", () => {
  const search = leafSection("### 部署入口查找");
  requireOrdered(
    search,
    ["只在 `integration` push 觸發、只部署 `integration` HEAD 的 workflow", "只指向它的 local 段", "一律記為 `env-only: <路徑>` 線索並繼續找"],
    "an integration-only workflow, and a local section pointing only to it, are env-only clues",
  );
  requireOrdered(search, ["MUST NOT 把 PR 分支推到 `integration`"], "the PR branch is never pushed to integration");
  requireOrdered(
    search,
    ["只有 `env-only` 或 none 時", "第零步推薦先開 PR 記 `pending:`", "補 `## DEV deploy-verify`（PR 分支部署指令）"],
    "Step 0 then recommends pending: and offers adding a PR-branch deploy command to the local file",
  );
  requireOrdered(search, ["第一個 `env-only: <路徑>` 線索"], "when every source only shows an environment the result is the first env-only clue");
  requireOrdered(
    search,
    ["PR 前照 §PR 前執行 分流：記錄符合第 2 步時", "`open-pr-pending:`／`waived:`／`n/a:` 直接寫對應狀態", "`deploy-before-pr` 部署不了屬第 4 步環境類", "其餘照第 3 步補問"],
    "W3-F1: with no entry before the PR the section routes through the PR-before-run steps instead of always stopping",
  );
  assert.ok(!search.includes("PR 前仍沒有入口就停下"), "the unconditional stop sentence that contradicted the PR-before-run steps is gone");
});

test("the pre-PR skill states the waiver comparison at PR creation, at an edit and before merge (Consumer gate and DEV gate step 6)", () => {
  const sentence = "豁免段開 PR 時、改描述時與 merge 前對照作答時紀錄";
  const skill = read(PRE_PR_REL);
  assert.ok(!skill.includes("豁免段開 PR 時對照作答時紀錄"), "the creation-only skill wording is gone");
  assert.equal(skill.split(sentence).length - 1, 2, "the sentence appears exactly twice in the pre-PR skill");
  assert.ok(sliceSection(skill, "### Consumer Pre-PR Checks Gate").includes(sentence), "the Consumer gate carries the sentence");
  assert.ok(devGate().includes(sentence), "step 6 of the DEV gate carries the sentence");
});

test("[Scenario: openspec-flow :: A documentation-only change records N/A with a reason]", () => {
  requireOrdered(leafSection("### 判定"), ["純文件、rules、test-only → `N/A: <理由>`"], "a docs-only change records N/A with a reason");
  requireOrdered(leafSection("### 證據行與四種狀態"), ["`N/A: <理由>`", "原因非空"], "an empty reason is rejected by the evidence rule");
});

test("[Scenario: openspec-flow :: Missing environment, settings or consent is recorded as pending]", () => {
  const run = leafSection("### PR 前執行");
  requireOrdered(
    run,
    ["環境類（缺環境、設定或同意範圍外的動作，DEV 主機不可達，部署管道本身壞掉）", "補好後重試", "本 PR 豁免（`skipped per user decision: <原因>`）", "先開 PR 記 `pending: <缺什麼>`", "其他"],
    "the leaf offers fix and retry, waive, open the PR with pending:, or other",
  );
  requireOrdered(run, ["失敗依原因分流，不依發現時點"], "the split is by cause, not by when the problem was found");
  requireOrdered(run, ["其他可執行的驗證", "做完後才做本關"], "the other runnable verification is completed first");
  assert.ok(leaf().includes("`pending:` 表示需要但未完成的 DEV 驗證"), "the leaf says pending: marks needed but unfinished DEV verification");
  assert.ok(!leaf().includes(RETIRED_STATUS_WORDING), "the leaf does not use the retired status wording");
  const gate = devGate();
  requireOrdered(
    gate,
    ["環境類", "補好後重試", "本 PR 豁免（`skipped per user decision: <原因>`）", "先開 PR 記 `pending: <缺什麼>`", "其他"],
    "the pre-PR gate carries the same four options",
  );
  requireOrdered(gate, ["失敗依原因分流，不依發現時點"], "the pre-PR gate splits by cause");
});

test("[Scenario: openspec-flow :: A local DEV section is run only by the DEV gate]", () => {
  const run = leafSection("### PR 前執行");
  requireOrdered(
    run,
    ["Consumer gate 不跑也不等 local.md 的 `## DEV deploy-verify` 段", "從不部署", "`pending:` 不擋它", "該檔其他要求失敗或做不完時它照舊停下、不開 PR"],
    "the Consumer gate neither runs nor waits for the DEV section, pending does not block it, other failures still stop it",
  );
  requireOrdered(
    run,
    ["補好後可在原同意範圍內對同一 HEAD 重新部署並更新證據行", "local.md 的 `## DEV deploy-verify` 段只由本關執行與部署", "同一輪本關對同一 HEAD 不部署兩次"],
    "only the DEV gate deploys, never the same HEAD twice in one run, and a retry after a fix updates the evidence line",
  );
  requireOrdered(
    leafSection("### 部署入口查找"),
    ["`## DEV deploy-verify` 段（只讀 HEAD 版本"],
    "the leaf reads the local section as a deploy entry candidate",
  );
  const gate = devGate();
  requireOrdered(gate, ["`## DEV deploy-verify` 段只由本關讀取與部署"], "the pre-PR DEV gate is the only reader of the DEV section");
});

test("[Scenario: openspec-flow :: A failed DEV verification stops the PR instead of being recorded as N/A or pending]", () => {
  const run = leafSection("### PR 前執行");
  requireOrdered(
    run,
    [
      "產品類（本 PR 程式讓 build 起不來或部署無法完成，或部署成功但核心路徑失敗、bug fix 的問題仍在）",
      "停下回報部署了什麼與結果，不開 PR",
      "MUST NOT 自行記成 `N/A:`、`pending:` 或 `skipped per user decision:`",
      "MUST NOT 重跑沒有改動的步驟求綠",
      "只能修正後重跑，或由使用者逐 PR 豁免（觀察到的失敗原文留在豁免說明旁）",
      "選項：修正後重跑／本 PR 豁免（`skipped per user decision: <原因>`）／其他",
      "環境與產品原因分不出來，比照本項",
    ],
    "a product-cause failure stops the PR, is not self-recorded, names its options, and an undecidable cause is handled the same way",
  );
  requireOrdered(
    devGate(),
    ["產品類", "停下回報部署了什麼與結果、不開 PR", "MUST NOT 自行記成 `N/A:`、`pending:` 或 `skipped per user decision:`", "只能修正後重跑，或由使用者逐 PR 豁免（`skipped per user decision: <原因>`，觀察到的失敗原文留在豁免說明旁", "選項：修正後重跑／本 PR 豁免／其他", "原因分不出來比照本項"],
    "the pre-PR gate carries the same stop and options",
  );
});

test("[Scenario: openspec-flow :: A failed DEV verification stops the PR instead of being recorded as N/A or pending] DEV stop points follow the stop-point contract", () => {
  requireOrdered(
    leafSection("### PR 前執行"),
    ["本關每個停點的訊息依 `stop-point-comms.md`：為何停、編號選項（末項開放）、每個選項回了會怎樣"],
    "the leaf routes every DEV stop message through stop-point-comms.md",
  );
  requireOrdered(
    devGate(),
    ["本關停點訊息依 `stop-point-comms.md`（為何停、編號選項、回了會怎樣）"],
    "the pre-PR DEV gate routes its stop messages through stop-point-comms.md",
  );
  const stepSix = sliceSection(read("scenarios/scenario-m-consumer-repo-pre-pr-flow.md"), "### Step 6.6: Pre-PR DEV Verification Gate（consumer 開 PR 前的 DEV 驗證）");
  requireOrdered(
    stepSix,
    ["下列每個停點的訊息依 `stop-point-comms.md` 說明為何停、給編號選項（末項為開放項）與每個選項回了之後 AI 會做什麼"],
    "scenario-m Step 6.6 expects stop messages that follow stop-point-comms.md",
  );
});

test("[Scenario: openspec-flow :: Pending DEV verification is never reported as passed or ready]", () => {
  const blocked = sliceSection(read(POST_PR_REL), "### Blocked Response Next-Step Contract");
  requireOrdered(
    blocked,
    ["`DEV deploy-verify:`", "`pending:`", "只能回本節 Blocked", "`Blocker:` DEV `pending:`", "`Owner:` user", "`Next step:` 依 `stop-point-comms.md` 給選項：補好後部署並以 `gh pr edit` 更新證據行／逐 PR 豁免／其他", "`Unblock condition:` DEV 驗證結果或使用者逐 PR 豁免", "MUST NOT 發 Ready Response", "`cooperative-only`", LEAF_NAME],
    "post-PR completion: pending: gets only a Blocked Response with its own Blocker, Owner, Next step and Unblock condition",
  );
  requireOrdered(
    sliceSection(read(POST_PR_REL), "### Ready Response Next-Step Contract"),
    ["PR 的 `DEV deploy-verify:` 為 `pending:` 時不發本節，改回上節 Blocked。", "Ready response MUST include:"],
    "the Ready Response section sends a pending: DEV line back to Blocked before listing its fields",
  );
  requireOrdered(
    leafSection("### 證據行與四種狀態"),
    ["`pending:` 表示需要但未完成的 DEV 驗證", "不得標 PASS 或 ready", "只能回 Blocked", "此保留屬 `cooperative-only`"],
    "the leaf says pending: is never PASS or ready and labels the withholding cooperative-only",
  );
});

test("[Scenario: openspec-flow :: DEV deploy-verify evidence line has a fixed prefix and four statuses]", () => {
  const status = leafSection("### 證據行與四種狀態");
  requireOrdered(
    status,
    ["`DEV deploy-verify: HEAD <full-sha>; <狀態>`", "結果摘要", "`N/A: <理由>`", "`pending: <缺什麼>`", "`skipped per user decision: <原因>`"],
    "the leaf defines the fixed prefix with a result summary and three named statuses",
  );
  requireOrdered(
    status,
    ["`skipped per user decision:` 是使用者對本 PR 的豁免，不延續到下一個 PR", "結果綁 HEAD，見 `consumer-pre-pr-checks.md` §結果綁 HEAD"],
    "a user waiver covers one PR only and the result is bound to HEAD",
  );
  requireOrdered(
    sliceSection(leaf(), "## Exit Criteria"),
    ["恰有一行合法 `DEV deploy-verify:` 行", "`N/A` 附理由", "`pending:`", "只回 Blocked"],
    "exit criteria require the line, a reason for N/A, and Blocked for pending",
  );
  const field = lineStartingWith(read(TEMPLATE_REL), "- DEV deploy-verify:", "PR template DEV field");
  requireOrdered(
    field,
    [EVIDENCE_PREFIX, "pending:", "source 刪除", `\`${LEAF_NAME}\``],
    "the template field names pending:, says source deletes it and points to the leaf",
  );
  assert.ok(!field.includes("只在契約宣告時寫"), "the template field no longer depends on a declared contract");
});

test("[Scenario: openspec-flow :: PR create gate requires a DEV deploy-verify line for consumer PRs] the PR template states the Gate 4c polarity", () => {
  const gate = lineStartingWith(read(TEMPLATE_REL), "PreToolUse hook 也會在 `gh pr create` 偵測可抽取的 body file", "PR template Gate 4c paragraph");
  requireOrdered(
    gate,
    ["（Gate 4c early-fail at PR write）", "unreadable body file 在正面 source 維持 fail-open／advisory", "consumer／unknown 在 `lite`／`full` 須讀得到 body 查 DEV 行", `（\`${LEAF_NAME}\`）`, "適用時的 consumer checks 行", "無法抽取／讀取即 block"],
    "the PR template keeps fail-open for a positive source only and blocks an unreadable consumer or unknown body",
  );
  assert.ok(!gate.includes("generic template lint 的 inline"), "the template no longer says inline bodies fail open for every identity");
});

test("[Scenario: openspec-flow :: Automated tests, isolated UI smoke and DEV verification do not substitute for each other]", () => {
  requireOrdered(
    leafSection("### 三種證據分開"),
    ["自動測試", "隔離 UI smoke", "`ui smoke:`", "限本機或臨時 instance", "`DEV deploy-verify:` 行", "彼此不能代填", "在 DEV 上做的檢查只記 DEV 行", "`## Manual Test`", "不算任何一種證據"],
    "the leaf keeps the three evidence kinds apart and excludes Manual Test",
  );
  const testing = read(TESTING_REL);
  const uiSmoke = sliceSection(testing, "### UI smoke（正文 SSOT）");
  requireOrdered(
    uiSmoke,
    ["`ui smoke: done` 限本機或臨時 instance", "在 DEV 上做的檢查只記 `DEV deploy-verify:` 行", LEAF_NAME],
    "testing-and-qa says ui smoke covers only a local or temporary instance",
  );
  const coexistence = read(CONTRACT_REL)
    .split("\n")
    .find((line) => line.startsWith("- **用途與並存**："));
  assert.ok(coexistence, "consumer-pre-pr-checks.md keeps the coexistence bullet");
  requireOrdered(coexistence, ["`ui smoke:`", "`E2E:`", "`DEV deploy-verify:`", "並存", "不能互相取代"], "the coexistence set lists the DEV line");
});

test("[Scenario: openspec-flow :: Source repository and rigor off are out of scope]", () => {
  requireOrdered(
    leafSection("### 適用範圍"),
    ["source repo 不適用", "不問、不寫 DEV 行", "`off` 由工程師自負"],
    "the leaf scopes the rule to consumer and unknown repos at lite and full",
  );
  const question = lineStartingWith(step0(), "**條件式 DEV 驗證題（併入第零步同一則訊息）**", "DEV question paragraph");
  requireOrdered(question, ["source repo 與 `off` 不問 DEV 題"], "the change skill does not ask in the source repository or at off");
  requireOrdered(leafSection("### 強度"), ["`off` 與正面 source 不查"], "the leaf states the gate exemptions");
});

test("[Scenario: openspec-flow :: Release lane pull requests record N/A without deciding again]", () => {
  const status = "N/A: release lane（DEV 判定在原 change／hotfix PR）";
  requireOrdered(
    leafSection("### 適用範圍"),
    [
      "`release/*` 進 `production`",
      "Step 6A 合回 `main`",
      "hotfix carrier 進 `production`",
      "hotfix carrier 合回 `main`",
      "不重新判定也不部署",
      `\`${status}\``,
      "`hotfix/*` 進 carrier 的 PR 照常判定",
    ],
    "the scope names the four release lane PR kinds, keeps them from deciding again, gives their N/A status, and keeps hotfix/* into the carrier decided as usual",
  );
  const body = `## Test Evidence\n- DEV deploy-verify: HEAD ${"a".repeat(40)}; ${status}\n`;
  assert.equal(consumerDevVerifyEvidenceError(body), null, "the release lane N/A line passes the Gate 4c DEV line check");
});

test("[Scenario: openspec-flow :: DEV deployment needs the user's per-change choice and stays inside the DEV lane]", () => {
  const lane = leafSection("### 授權與共用環境");
  requireOrdered(
    lane,
    ["只在使用者對本 change 的 PR 明確選擇時發生", "batch approval 與 `/devpro:pre-pr` 的一次同意都不涵蓋"],
    "DEV deployment needs the per-change choice and no batch approval or one-time consent covers it",
  );
  requireOrdered(
    lane,
    ["MUST NOT 延伸到其他環境、SIT／UAT／PAT／PROD 或其他 change"],
    "the choice does not extend to another environment or change",
  );
  requireOrdered(
    lane,
    ["共用環境部署前先確認沒有別人的窗口", "拿不到或無法確認 → 停下，不自行覆蓋", "證據記窗口起訖與曾部署的 branch／SHA"],
    "a shared environment needs a free window, an unavailable window stops, and the window is recorded",
  );
  requireOrdered(
    lane,
    ["用當前 PR head SHA 建置部署", "跑核心 happy path", "bug fix 另驗修正點已消失"],
    "DEV deploys the current PR head build, runs the core happy path and rechecks a bug fix",
  );
  requireOrdered(
    lane,
    ["SIT／UAT／PAT／PROD 仍只驗 `release/*` 的同一 Build once artifact", "DEV 結果 MUST NOT 當 SIT／UAT 證據"],
    "a DEV result is never SIT or UAT evidence",
  );
  requireOrdered(
    leafSection("### 部署入口查找"),
    ["MUST NOT 把 PR 分支推到 `integration`"],
    "the PR branch is never pushed to integration",
  );
  const releaseBullet = lineStartingWith(read(RELEASE_REL), "- pre-PR 的 DEV branch-build 驗證", "release rule DEV bullet");
  requireOrdered(
    releaseBullet,
    [`\`${LEAF_NAME}\``, "`integration` 仍只收 `main` merge", "不得當 SIT／UAT 證據"],
    "the release rule points at the leaf and keeps the deployment law intact",
  );
  const batchScenario = read("scenarios/scenario-ai-consumer-repo-lite-batch-approval.md");
  requireOrdered(
    batchScenario,
    [
      "除排除項外沒有授權停點（DEV 部署是使用者對本 PR 的選擇，不在 batch 內，見 `pre-pr-dev-verification.md`）",
      "consumer 的第零步訊息另含條件式 DEV 驗證題",
      "DEV 部署是使用者對本 PR 的選擇，batch 不涵蓋",
      "DEV 驗證的 PR 前補問與環境類停點屬 `pre-pr-dev-verification.md` 的使用者 DEV 選擇，不計入授權停點",
    ],
    "the lite batch scenario keeps DEV deployment outside batch approval instead of counting its stops as authorization failures",
  );
});

test("[Scenario: openspec-flow :: Carriers point to the DEV verification SSOT]", () => {
  const carriers = {
    [CONTRACT_REL]: read(CONTRACT_REL),
    [TESTING_REL]: read(TESTING_REL),
    [CHECKLIST_REL]: read(CHECKLIST_REL),
    [TEMPLATE_REL]: read(TEMPLATE_REL),
    [RIGOR_REL]: read(RIGOR_REL),
    [RELEASE_REL]: read(RELEASE_REL),
    [README_REL]: read(README_REL),
    [PRE_PR_REL]: read(PRE_PR_REL),
    [CHANGE_REL]: read(CHANGE_REL),
  };
  for (const [rel, text] of Object.entries(carriers)) {
    assert.ok(text.includes(LEAF_NAME), `${rel} points to ${LEAF_NAME}`);
    assert.ok(!/宣告[了]?\s*\x60## DEV deploy-verify\x60/.test(text), `${rel} does not make DEV depend on declaring ## DEV deploy-verify`);
  }
  assert.ok(!/^#### DEV deploy-verify/m.test(carriers[CONTRACT_REL]), "consumer-pre-pr-checks.md no longer carries a #### DEV deploy-verify heading");
  const contractDescription = carriers[CONTRACT_REL].split("\n").find((line) => line.startsWith("description:")) ?? "";
  assert.ok(contractDescription.includes("寫或審查 PR 描述的 Consumer pre-PR checks 證據行"), "consumer-pre-pr-checks.md still triggers on its own evidence line");
  assert.ok(!contractDescription.includes("DEV deploy-verify 證據行"), "consumer-pre-pr-checks.md no longer claims the DEV deploy-verify evidence line as its trigger");
  const stepZeroDev = carriers[CHANGE_REL].split("\n").find((line) => line.startsWith("**條件式 DEV 驗證題")) ?? "";
  assert.ok(stepZeroDev.includes("與其他題並列時照 `stop-point-comms.md` 規則 2 寫成行內 `Q<n>-<m>.`"), "the Step 0 DEV question uses inline Q<n>-<m>. options beside other questions");

  const testing = carriers[TESTING_REL];
  const loadChain = testing.split("\n").filter((line) => line.startsWith("> Load-chain（DEV 驗證）"));
  assert.equal(loadChain.length, 1, "testing-and-qa.md carries one Load-chain line for DEV verification");
  assert.ok(extractDeclaredLoadChainRefs(testing).includes(LEAF_NAME), "the Load-chain line declares the leaf as a reference");

  const checklist = carriers[CHECKLIST_REL];
  const stage0 = sliceSection(checklist, "### 階段 0 需求討論（進主流程前）");
  assert.ok(stage0.split("\n").some((line) => line.startsWith("- [ ] DEV 決定已記錄") && line.includes(LEAF_NAME)), "checklist stage 0 records the DEV decision");
  const stage3 = sliceSection(checklist, "### 階段 3 pre-PR（`/devpro:pre-pr` Step 1–4）").split("\n");
  const archive = stage3.findIndex((line) => /^- \[ \] 3\.6 spec-freeze/.test(line));
  const devGateLine = stage3.findIndex((line) => line.startsWith("- [ ] Pre-PR DEV Verification Gate"));
  const description = stage3.findIndex((line) => /^- \[ \] 4 PR 描述/.test(line));
  assert.ok(archive >= 0 && devGateLine >= 0 && description >= 0, "stage 3 carries the DEV gate line");
  assert.ok(archive < devGateLine && devGateLine < description, "the DEV gate line sits between 3.6/3.7 and 4");
  assert.ok(stage3[devGateLine].includes(LEAF_NAME), "the DEV gate line points to the leaf");

  const budget = read(BUDGET_REL);
  const nextFiles = /next: Object\.freeze\(\{[\s\S]*?files: Object\.freeze\(\[([^\]]*)\]\)/.exec(budget);
  assert.ok(nextFiles && nextFiles[1].includes(`"${LEAF_NAME}"`), "the leaf is registered in the next token tier");

  const row = carriers[README_REL].split("\n").filter((line) => line.startsWith(`| [\`${LEAF_NAME}\`](${LEAF_REL}) |`));
  assert.equal(row.length, 1, "the README module table carries one row for the leaf");

  const skill = read(PRE_PR_REL);
  const lazyLoad = skill.split("\n").filter((line) => /^\d+\. \x60\.devpro\/agent-rules\//.test(line));
  for (const name of [LEAF_NAME, "project-verification.md", "ci-cd-integration-deployment.md"]) {
    assert.ok(lazyLoad.some((line) => line.includes(name) && line.includes("命中 DEV gate 時")), `the pre-PR lazy-load list names ${name} for the DEV gate`);
  }
});

// --- per-PR waiver records (scope change 2026-11-09) ---------------------------

const LIFECYCLE_NAME = "session-pending-lifecycle.md";

test("[Scenario: openspec-flow :: The agent records each waiver answer before writing the waiver] the DEV carriers and the change skill record the answer first", () => {
  requireOrdered(
    leafSection("### 第零步記錄"),
    ["`waived:` 是開 PR 時對照的作答時紀錄之一", "之後任何一次 DEV 作答都覆寫這一行", `\`${LIFECYCLE_NAME}\` §逐 PR 豁免紀錄`],
    "the Step 0 record says waived: is compared at PR creation and later DEV answers overwrite it",
  );
  requireOrdered(
    leafSection("### PR 前執行"),
    ["使用者回答補問或停點後", `先依 \`${LIFECYCLE_NAME}\` §逐 PR 豁免紀錄 寫紀錄並讀回`, "沒有 claimed 條目就新建，不論是否豁免", "才寫 PR 行", "寫不進去就停下", "MUST NOT 寫豁免行"],
    "the leaf records the answer, creating the entry when none exists, before it writes the PR line",
  );
  requireOrdered(
    devGate(),
    ["先寫紀錄並讀回", `\`${LIFECYCLE_NAME}\` §逐 PR 豁免紀錄`, "沒有 claimed 條目就新建，不論是否豁免", "MUST NOT 寫豁免行", "再寫 `## Test Evidence`"],
    "the pre-PR DEV gate records the answer before it writes the evidence line",
  );
  requireOrdered(
    leafSection("### 證據行與四種狀態"),
    ["`skipped per user decision:` 是使用者對本 PR 的豁免，不延續到下一個 PR", "需要作答時紀錄（見 §強度）"],
    "a skipped-per-user-decision line needs an answer-time record",
  );
  requireOrdered(
    step0(),
    [
      "唯一例外是 `dev_verification:` 子項，以及同一份紀錄用的 `consumer_waiver:`、`pr_branch:` 子項",
      "不是 batch scope",
      `\`${LEAF_NAME}\` 的封閉字彙、放行原因或 branch 全名`,
    ],
    "the capsule exception keeps its dev_verification sentence and adds consumer_waiver: and pr_branch:",
  );
  requireOrdered(
    step0(),
    ["`waived:` 是開 PR 時對照的作答時紀錄之一", "之後的 DEV 作答覆寫這一行", `\`${LIFECYCLE_NAME}\` §逐 PR 豁免紀錄`],
    "the change skill says later DEV answers overwrite the dev_verification line",
  );
  const capsule = [...step0().matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]).find((body) => body.includes("clarify_stage: card-confirmed"));
  assert.ok(capsule, "capsule example exists");
  assert.ok(capsule.split("\n").some((line) => line.startsWith("  - pr_branch: ")), "the capsule example carries a pr_branch sub-item");
  requireOrdered(capsule, ["- decided:", "dev_verification:", "pr_branch:", "- next:"], "pr_branch sits beside dev_verification, after decided: and before next:");
  for (const line of read(TEMPLATE_REL).split("\n").filter((l) => l.startsWith("- DEV deploy-verify:"))) {
    assert.ok(line.includes(`；豁免需作答紀錄；見 \`${LEAF_NAME}\``), "the template DEV line says a waiver needs an answer-time record before its pointer");
  }
});

test("[Scenario: openspec-flow :: The gate contracts state the comparison and what stays cooperative] the DEV leaf strength section and the README row", () => {
  requireOrdered(
    leafSection("### 強度"),
    [
      "`off` 與正面 source 不查",
      "並把每一段 `skipped per user decision:` 拿去對照本 change 的作答時紀錄",
      "紀錄缺少、讀不到、定位不唯一或不相符就擋",
      "開 PR 時、`gh pr edit` 改描述時與 `gh pr merge`／MCP merge 前都對照（改描述與 merge 時不查行格式）；`gh api` 或網頁改描述不對照；MCP `update_issue` 改不了 PR，不對照。",
      "使用者是否真的作答、紀錄是否寫於作答之後",
      "皆為 `cooperative-only`",
      "在 `off` 仍檢查是既有行為，本流程不動；`off` 不對照",
    ],
    "the leaf strength section states the comparison, the three comparison points and what stays cooperative",
  );
  assert.ok(!leafSection("### 強度").includes("只驗 DEV 行的文字格式"), "the strength section no longer says the gates only check the text format");
  for (const stale of ["PR 開出後改描述不對照", "只在開 PR 時對照", "改描述當下不攔"]) {
    assert.ok(!leafSection("### 強度").includes(stale), `the strength section no longer holds ${JSON.stringify(stale)}`);
  }
  const row = read(README_REL).split("\n").find((line) => line.startsWith(`| [\`${LEAF_NAME}\`](${LEAF_REL}) |`));
  assert.ok(row, "the README module table carries the leaf row");
  requireOrdered(row, ["Gate 4c 與 MCP 驗行格式並對照豁免紀錄、執行仍 cooperative-only"], "the README row says the gates also compare waiver records");
});

test("[Scenario: openspec-flow :: The latest DEV answer is read back after a resume without a capsule] the DEV gate reads the claimed entry before meeting-notes", () => {
  requireOrdered(
    leafSection("### PR 前執行"),
    ["讀記錄，先讀條目再讀 meeting-notes", "claimed 條目的 `dev_verification:` 是最新作答", "沒有 claimed 條目就新建，不論是否豁免"],
    "the leaf reads the claimed entry first and creates it for any DEV answer",
  );
  requireOrdered(
    devGate(),
    ["讀記錄，先讀條目再讀 meeting-notes", "claimed 條目的 `dev_verification:` 是最新作答", "沒有才讀 meeting-notes Startup evidence"],
    "the pre-PR DEV gate reads the entry first and meeting-notes only when the entry holds no DEV line",
  );
});
