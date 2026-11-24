/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the per-PR waiver record definition (location, keys, write timing,
 * lifecycle) and its residual entry in `design-core.md`.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * pr-waiver-record-grep.test.mjs
 *
 * Per-PR waiver records (fix-pre-pr-dev-verification-trigger, scope change
 * 2026-11-09): when the agent opens a PR, Gate 4c and the MCP `create_pr` policy
 * compare every `skipped per user decision:` part with an answer-time record kept in
 * the claimed session-pending entry of the change. These anchors lock the writer side
 * (where, when and in what form the record is written), the gate contracts (what the
 * comparison is and what stays cooperative-only), and a negative guard: the carriers
 * of this change MUST NOT restate the named residual exception of a sibling change.
 * The guard reads that exception from its source files at run time and holds no
 * literal of it. A positive lock pins the only allowed mention: three writer-side
 * places name the exception's identifier once, pointing back to design-core.md §11,
 * plus one AND of the new requirement.
 *
 * Each `[Scenario: openspec-flow :: <title>]` test names one scenario of the
 * openspec-flow delta of fix-pre-pr-dev-verification-trigger. The gate-side scenarios
 * are covered by the hook, policy and record-match tests.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sourcePath } from "./lib/source-root.mjs";

// Backticks inside regex literals are written as \x60: shard discovery strips
// comments with stripJsCommentSpans, which has no regex state and would read a
// bare backtick as a template opener and reject this file.

const read = (rel) => readFileSync(sourcePath(rel), "utf8");

const LIFECYCLE_REL = ".devpro/agent-rules/session-pending-lifecycle.md";
const LEAF_REL = ".devpro/agent-rules/pre-pr-dev-verification.md";
const CONTRACT_REL = ".devpro/agent-rules/consumer-pre-pr-checks.md";
const LOCAL_RULES_REL = ".devpro/agent-rules/consumer-local-rules.md";
const TEMPLATE_REL = ".devpro/agent-rules/git-pr-template-and-merge.md";
const CHANGE_REL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const PRE_PR_REL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const LIB_REL = ".devpro/scripts/lib/consumer-pre-pr-gate.mjs";
const GATE_REL = ".devpro/scripts/hooks/pre-tool-gate.mjs";
const README_REL = "README.md";
const CANONICAL_SPEC_REL = "openspec/specs/openspec-flow/spec.md";
const CHANGE_NAME = "fix-pre-pr-dev-verification-trigger";
const ARCHIVE_DIR_REL = "openspec/changes/archive";
const DESIGN_CORE_REL = ".devpro/agent-rules/design-core.md";
const CROSS_MODEL_REL = ".devpro/agent-rules/code-review-cross-model.md";

const LIFECYCLE_HEADING = "### 逐 PR 豁免紀錄";
const LIFECYCLE_LEAF_NAME = "session-pending-lifecycle.md";
const OWN_REQUIREMENT_TITLE = "PR Creation Compares Per-PR Waiver Lines With Answer-Time Records";
const STEP6_PREFIX = "6. 使用者每次作答（補問或停點）後";

// The identifier of the sibling change's exception is assembled at run time so that this file never holds it as a literal.
const SIBLING_IDENTIFIER = ["per-pr-waiver-record", "residual"].join("-");
// The one pointer form each writer-side carrier uses: the identifier and a pointer back to design-core.md §11, nothing more.
const SIBLING_POINTER = `\x60${SIBLING_IDENTIFIER}\x60（\x60design-core.md\x60 §11）`;
// Time-point wording that the merge-time and edit-time comparison replaced; none of it may come back.
const STALE_TIMING_PHRASES = ["PR 開出後改描述不對照", "只在開 PR 時對照", "（只在開 PR 時）", "改描述當下不攔"];
// MCP update_issue cannot edit a PR (the MCP backend refuses a PR number, #3496); it must not come back as an edit-time comparison point.
const STALE_EDIT_PATH_PHRASES = ["`gh pr edit`／MCP `update_issue` 改描述時", "與 MCP 對照，merge 前"];
const EDIT_MERGE_METADATA_NEEDLE =
  "`gh pr edit` 改描述時由 `per-pr-waiver-edit-record` 對照，merge 前由 `per-pr-waiver-merge-record` 與 MCP merge 再對照；`gh api` 或網頁改描述不對照，MCP `update_issue` 改不了 PR、不對照";
const countOf = (text, needle) => text.split(needle).length - 1;

function headingLevel(line) {
  const match = /^(#{1,6}) \S/.exec(line);
  return match ? match[1].length : 0;
}

// The body of the one heading that equals `heading` exactly, up to the next heading of the same or a higher level.
function sliceSection(text, heading) {
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) => (line === heading ? [index] : []));
  assert.equal(starts.length, 1, `expected exactly one "${heading}" heading, found ${starts.length}`);
  const level = headingLevel(heading);
  let end = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    const found = headingLevel(lines[index]);
    if (found > 0 && found <= level && !/^\s*```/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(starts[0], end).join("\n");
}

function requireOrdered(haystack, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    assert.ok(index >= 0, `${label}: missing or out of order ${JSON.stringify(needle)}`);
    cursor = index;
  }
}

// The needles must appear in order on one physical line.
function requireLineOrdered(text, needles, label) {
  const hit = text.split("\n").some((line) => {
    let cursor = -1;
    for (const needle of needles) {
      const index = line.indexOf(needle, cursor + 1);
      if (index < 0) return false;
      cursor = index;
    }
    return true;
  });
  assert.ok(hit, `${label}: no single physical line holds ${JSON.stringify(needles)} in order`);
}

function fencedBlocks(text) {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
}

const lifecycleSection = () => sliceSection(read(LIFECYCLE_REL), LIFECYCLE_HEADING);
const leafSection = (heading) => sliceSection(read(LEAF_REL), heading);
const devGate = () => sliceSection(read(PRE_PR_REL), "### Pre-PR DEV Verification Gate");
const consumerGate = () => sliceSection(read(PRE_PR_REL), "### Consumer Pre-PR Checks Gate");

// The Step 0 text of the change skill, from the Step 0 heading to Step 1.
function changeStep0() {
  const text = read(CHANGE_REL);
  const from = text.indexOf("**第零步：Batch Scope Confirmation**");
  const to = text.indexOf("**第一步：", from);
  assert.ok(from >= 0 && to > from, "Step 0 of the change skill is present");
  return text.slice(from, to);
}

function capsuleExample() {
  const capsule = fencedBlocks(changeStep0()).find((body) => body.includes("clarify_stage: card-confirmed"));
  assert.ok(capsule, "the change skill carries the fenced card capsule example");
  return capsule;
}

function contractStrengthBullet() {
  const hits = read(CONTRACT_REL).split("\n").filter((line) => line.startsWith("- **強度**："));
  assert.equal(hits.length, 1, "consumer-pre-pr-checks.md carries exactly one strength bullet");
  return hits[0];
}

function contractStopPointBullet() {
  const hits = read(CONTRACT_REL).split("\n").filter((line) => line.startsWith("- **使用者放行**："));
  assert.equal(hits.length, 1, "consumer-pre-pr-checks.md carries exactly one user-release stop point");
  return hits[0];
}

function devGateStep6() {
  const hits = devGate().split("\n").filter((line) => line.startsWith(STEP6_PREFIX));
  assert.equal(hits.length, 1, "the pre-PR DEV gate carries exactly one step 6");
  return hits[0];
}

// The three writer-side places that point to the sibling exception, each as [file, the named place in it].
function pointerPlaces() {
  return [
    [LEAF_REL, leafSection("### 強度")],
    [CONTRACT_REL, contractStrengthBullet()],
    [PRE_PR_REL, devGateStep6()],
  ];
}

// design-core.md §11, from its "### 11. " heading to the next heading of the same or a higher level.
function designCoreSection11() {
  const heading = read(DESIGN_CORE_REL).split("\n").filter((line) => line.startsWith("### 11. "));
  assert.equal(heading.length, 1, "design-core.md carries exactly one §11 heading");
  return sliceSection(read(DESIGN_CORE_REL), heading[0]);
}

function gateSpRegex() {
  const match = read(GATE_REL).match(/const SESSION_PENDING_BATCH_APPROVAL_TERMS = \/(.+)\/i;/);
  assert.ok(match, `${GATE_REL}: SESSION_PENDING_BATCH_APPROVAL_TERMS not found`);
  return new RegExp(match[1], "i");
}

// --- writer side -------------------------------------------------------------

test("lifecycle leaf defines the per-PR waiver record: location, three keys, write timing, entry creation, lifecycle", () => {
  const section = lifecycleSection();
  requireOrdered(
    section,
    [
      "紀錄＝本 PR 最新的 DEV 作答、各項 Consumer 放行與綁定它們的 `pr_branch:`",
      "main checkout `notes/session-pending.md` 本 change 的 claimed 條目",
      "恰一行 fence 外 `claimed:`",
      "同一 change 不分散兩條",
      "formalize 在 `card:` 內",
    ],
    "the record location is the claimed entry of this change in the main checkout, never split",
  );
  requireOrdered(
    section,
    [
      "`pr_branch:` MUST 恰一行、與第一筆紀錄同寫",
      "第零步先寫將建的 branch，建好後核對、不符才改",
      "`change/SKILL.md`",
      "MUST NOT 為對上既有紀錄而改",
      "其 PR 未 merge → 停下回報",
    ],
    "pr_branch is exactly one line, written with the first record, checked once after the branch exists and never edited to fit",
  );
  requireOrdered(
    section,
    ["`dev_verification:` 恰一行，之後任何 DEV 作答都覆寫，以最新為準", "`consumer_waiver:` 每放行項一行，撤回即刪"],
    "the DEV line is overwritten by every later DEV answer and each Consumer release is one line",
  );
  requireOrdered(
    section,
    ["三鍵非 `approval:`，Gate SP 不讀", "值不含 `授權` 等批次用語、PII、secret、log"],
    "the three keys are not approval lines and carry no batch wording",
  );
  requireOrdered(
    section,
    [
      "作答之後、寫 PR 的 `skipped per user decision:` 之前寫入並讀檔確認",
      "失敗重試一次，仍失敗 MUST 停下、MUST NOT 寫豁免行",
    ],
    "the record is written after the answer and before the waiver, read back, retried once and never replaced by a waiver without a record",
  );
  requireOrdered(
    section,
    [
      "第零步之後任何 DEV 作答或 Consumer 放行都在沒有條目時新建條目",
      "`## <change>：逐 PR 豁免紀錄`",
      "用 claim helper 認領並同寫 `pr_branch:`",
      "續接先讀條目再讀 meeting-notes",
      "PR merge 後整條刪除",
    ],
    "any post-Step-0 DEV answer or Consumer waiver creates the entry when none exists, claims it and writes pr_branch with it, the entry is read before meeting-notes, and it is deleted once the PR is merged",
  );
});

test("lifecycle leaf examples carry the three keys and no Gate SP batch approval wording", () => {
  const section = lifecycleSection();
  const example = fencedBlocks(section).find((body) => body.includes("pr_branch:"));
  assert.ok(example, "the lifecycle section carries a fenced example of the record");
  const lines = example.split("\n").filter((line) => line.trim() !== "");
  assert.deepEqual(
    lines.map((line) => /^ {2}- ([a-z_]+):/.exec(line)?.[1]),
    ["pr_branch", "dev_verification", "consumer_waiver"],
    "the example holds exactly the three keys in order, each indented two spaces like the other evidence lines of an entry",
  );
  assert.match(lines[2], /\(provenance: user\)$/, "the Consumer record ends with the provenance marker");
  for (const line of lines) {
    assert.doesNotMatch(line, gateSpRegex(), `example line must not carry Gate SP approval terms: ${line}`);
    assert.doesNotMatch(line, /授權|batch approval|PR merge/i, `example line must not carry batch wording: ${line}`);
    assert.doesNotMatch(line, /^\s*-\s*approval:/, "example is not an approval line");
  }
});

test("[Scenario: openspec-flow :: The agent records each waiver answer before writing the waiver]", () => {
  // The lifecycle leaf defines the record.
  requireOrdered(
    lifecycleSection(),
    [
      "`pr_branch:`",
      "`dev_verification:` 恰一行，之後任何 DEV 作答都覆寫",
      "`consumer_waiver:`",
      "第零步之後任何 DEV 作答或 Consumer 放行都在沒有條目時新建條目",
      "PR merge 後整條刪除",
    ],
    "the lifecycle leaf defines the location, the pr_branch line, the overwrite, the Consumer line, the created entry and its deletion",
  );
  // Each waiver stop point states record-before-waiver and points to the lifecycle leaf.
  const run = leafSection("### PR 前執行");
  requireOrdered(
    run,
    [
      "使用者回答補問或停點後",
      `先依 \`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄 寫紀錄並讀回`,
      "沒有 claimed 條目就新建，不論是否豁免",
      "才寫 PR 行",
      "MUST NOT 寫豁免行",
    ],
    "the DEV leaf records the answer, creating the entry when none exists, before the PR line",
  );
  requireOrdered(
    leafSection("### 第零步記錄"),
    ["`waived:` 是開 PR 時對照的作答時紀錄之一", "之後任何一次 DEV 作答都覆寫這一行", `\`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄`],
    "the Step 0 record says waived: is compared at PR creation and that later DEV answers overwrite it",
  );
  requireLineOrdered(
    contractStopPointBullet(),
    ["使用者作答後、寫進證據之前", "先為每個放行項寫一行 `consumer_waiver:`", `\`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄`, "撤回就刪"],
    "the Consumer stop point records each release before the evidence line",
  );
  requireOrdered(
    read(CONTRACT_REL).split("\n").find((line) => line.startsWith("- **內容**：")) ?? "",
    ["被放行的項目寫 `skipped per user decision: <原因>`", "每段對應一筆 `consumer_waiver:`"],
    "each released part of the evidence line has a consumer_waiver record",
  );
  requireOrdered(
    consumerGate(),
    ["逐 PR 的使用者放行", "作答後先寫 `consumer_waiver:`", `\`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄`, "才進 Step 4"],
    "the pre-PR Consumer gate records the release before it reaches Step 4",
  );
  requireOrdered(
    devGate(),
    ["先寫紀錄並讀回", `\`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄`, "沒有 claimed 條目就新建，不論是否豁免", "MUST NOT 寫豁免行", "再寫 `## Test Evidence`"],
    "the pre-PR DEV gate records the answer before it writes the evidence line",
  );
  // The change skill names the keys in the capsule exception and the overwrite.
  const step0 = changeStep0();
  requireOrdered(
    step0,
    [
      "唯一例外是 `dev_verification:` 子項，以及同一份紀錄用的 `consumer_waiver:`、`pr_branch:` 子項",
      "不是 batch scope",
      "`pre-pr-dev-verification.md` 的封閉字彙、放行原因或 branch 全名",
    ],
    "the capsule exception names the three record keys",
  );
  requireOrdered(
    step0,
    ["`waived:` 是開 PR 時對照的作答時紀錄之一", "之後的 DEV 作答覆寫這一行", `\`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄`],
    "the change skill says later DEV answers overwrite the dev_verification line",
  );
  assert.ok(
    read(TEMPLATE_REL).split("\n").filter((line) => line.startsWith("- Consumer pre-PR checks:") || line.startsWith("- DEV deploy-verify:")).every((line) => line.includes("；豁免需作答紀錄")),
    "both template field lines say a waiver needs an answer-time record",
  );
});

test("[Scenario: openspec-flow :: A full B Step 0 waiver is copied into the claimed entry without asking again]", () => {
  const copy = ["不再問", "其他三值直接寫對應狀態", "`waived:` 只記在 meeting-notes 時先複製進條目（沒有就新建）並讀回", "才寫豁免行"];
  for (const [label, section] of [["DEV leaf", leafSection("### PR 前執行")], ["pre-PR DEV gate", devGate()]]) {
    const step2 = section.split("\n").filter((line) => line.startsWith("2. 記錄存在"));
    assert.equal(step2.length, 1, `${label} carries exactly one step 2`);
    requireLineOrdered(step2[0], copy, `${label} step 2 copies a meeting-notes waived: record into the entry before the waiver, without asking again`);
    assert.ok(!section.includes("只在 meeting-notes 時先複製"), `${label} no longer ties the copy only to a new answer`);
  }
  requireOrdered(
    lifecycleSection(),
    ["第零步之後任何 DEV 作答或 Consumer 放行都在沒有條目時新建條目", "`## <change>：逐 PR 豁免紀錄`", "用 claim helper 認領並同寫 `pr_branch:`", "（full B 複製 `waived:` 亦同）"],
    "the lifecycle leaf names the full B copy as a case that creates the entry with pr_branch",
  );
});

test("the capsule example carries pr_branch and the write sequence checks it once the worktree exists", () => {
  const capsule = capsuleExample();
  const lines = capsule.split("\n");
  const devIndex = lines.findIndex((line) => line.startsWith("  - dev_verification:"));
  const branchIndex = lines.findIndex((line) => line.startsWith("  - pr_branch:"));
  assert.ok(devIndex >= 0 && branchIndex >= 0, "the capsule example carries dev_verification and pr_branch sub-items");
  assert.equal(branchIndex, devIndex + 1, "pr_branch sits beside the dev_verification record at the same level");
  assert.ok(lines.findIndex((line) => line.startsWith("  - next:")) > branchIndex, "pr_branch sits before next:");
  assert.doesNotMatch(lines[branchIndex], gateSpRegex(), "the pr_branch line carries no Gate SP approval terms");
  assert.doesNotMatch(lines[branchIndex], /授權/, "the pr_branch line carries no authorization wording");
  requireOrdered(
    changeStep0(),
    ["建好 worktree、第一個 repo write 之前", "核對 `pr_branch:`", "`git branch --show-current`", "不同就改成實際值"],
    "the write sequence checks pr_branch against the created branch before the first repository write",
  );
});

// --- gate contracts ----------------------------------------------------------

test("[Scenario: openspec-flow :: The gate contracts state the comparison and what stays cooperative]", () => {
  const strength = leafSection("### 強度");
  requireOrdered(
    strength,
    [
      "`off` 與正面 source 不查",
      "並把每一段 `skipped per user decision:` 拿去對照本 change 的作答時紀錄",
      `\`${LIFECYCLE_LEAF_NAME}\` §逐 PR 豁免紀錄`,
      "紀錄缺少、讀不到、定位不唯一或不相符就擋",
      "開 PR 時、`gh pr edit` 改描述時與 `gh pr merge`／MCP merge 前都對照",
      "改描述與 merge 時不查行格式",
      "`gh api` 或網頁改描述不對照",
      "使用者是否真的作答、紀錄是否寫於作答之後",
      "皆為 `cooperative-only`",
      "`off` 不對照",
    ],
    "the DEV leaf strength section states the comparison, the block conditions, the three comparison points and what stays cooperative",
  );
  const bullet = contractStrengthBullet();
  requireOrdered(
    bullet,
    [
      "Gate 4c",
      "檢查適用性與證據行格式",
      "把每一段 `skipped per user decision:` 拿去對照本 change 的 `consumer_waiver:` 紀錄",
      "紀錄缺少、讀不到、定位不唯一或不相符就擋（開 PR 時、`gh pr edit` 改描述時與 merge 前；`gh api` 或網頁改描述不對照，MCP `update_issue` 改不了 PR）",
      "使用者是否真的作答與結果綁 HEAD 的語意仍為 `cooperative-only`，沒有收據",
      "停點確認不對照",
    ],
    "the Consumer strength bullet states the comparison and what stays cooperative",
  );
  // The old time-point wording and the dropped "not blocked at the edit" wording are gone from the strength section and the bullet.
  for (const [label, text] of Object.entries({ "pre-pr-dev-verification.md strength": strength, "consumer-pre-pr-checks.md strength bullet": bullet })) {
    for (const stale of STALE_TIMING_PHRASES) assert.ok(!text.includes(stale), `${label} no longer holds ${JSON.stringify(stale)}`);
  }
  const metadata = sliceSection(read(LOCAL_RULES_REL), "### Enforcement Metadata");
  requireOrdered(
    metadata,
    ["豁免段對照作答時紀錄（見 `consumer-pre-pr-checks.md`；不證明測試執行）"],
    "the Hard Gate row names the comparison",
  );
  requireOrdered(
    metadata,
    [EDIT_MERGE_METADATA_NEEDLE, "；`gh api` 或網頁改描述不對照"],
    "the Hard Gate row names the edit-time and the merge-time comparison and what is not compared",
  );
  requireOrdered(
    metadata,
    ["`cooperative-only: consumer pre-PR checks execution, whether the user really answered a waiver, and HEAD currency remain human/reviewer judgments; no receipt`"],
    "the Doctrine row labels whether the user really answered as cooperative",
  );
  const comments = read(LIB_REL)
    .split("\n")
    .filter((line) => line.trim().startsWith("//"))
    .map((line) => line.trim().replace(/^\/\/\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
  requireOrdered(
    comments,
    ["perPrWaiverRecordError compares waiver parts with answer-time records", "whether the user really answered", "perPrWaiverRecordError compares waivers with records", "whether the user really answered"],
    "the lib comments name the comparison and keep whether the user really answered cooperative",
  );
  for (const [label, text] of Object.entries({
    "pre-pr-dev-verification.md strength": strength,
    "consumer-pre-pr-checks.md strength bullet": bullet,
    "consumer-local-rules.md Enforcement Metadata": metadata,
    "consumer-pre-pr-gate.mjs": read(LIB_REL),
  })) {
    assert.ok(!text.includes("waiver authority"), `${label} no longer describes waiver authority as cooperative-only`);
  }
  // Each of the three writer-side places names the sibling exception exactly once, on a line that points back to design-core.md §11.
  assert.ok(designCoreSection11().includes(SIBLING_IDENTIFIER), "the pointer target: design-core.md §11 holds the sibling exception");
  for (const [rel, place] of pointerPlaces()) {
    assert.equal(countOf(read(rel), SIBLING_IDENTIFIER), 1, `${rel} names the sibling exception exactly once in the whole file`);
    const lines = place.split("\n").filter((line) => line.includes(SIBLING_IDENTIFIER));
    assert.equal(lines.length, 1, `${rel}: the named place holds the identifier`);
    assert.ok(lines[0].includes(SIBLING_POINTER), `${rel}: the identifier line points back to design-core.md §11`);
  }
});

test("[Scenario: openspec-flow :: The gate contracts state the merge-time comparison] [WhenThen: 1]", () => {
  const strength = leafSection("### 強度");
  requireOrdered(
    strength,
    ["開 PR 時、`gh pr edit` 改描述時與 `gh pr merge`／MCP merge 前都對照", "改描述與 merge 時不查行格式", "`gh api` 或網頁改描述不對照"],
    "the DEV leaf strength section names the three comparison points, that the edit and the merge do not check the line format, and what is not compared",
  );
  const bullet = contractStrengthBullet();
  requireOrdered(
    bullet,
    ["（開 PR 時、`gh pr edit` 改描述時與 merge 前；`gh api` 或網頁改描述不對照，MCP `update_issue` 改不了 PR）"],
    "the Consumer strength bullet names the three comparison points and what is not compared",
  );
  for (const [label, text] of Object.entries({ "pre-pr-dev-verification.md strength": strength, "consumer-pre-pr-checks.md strength bullet": bullet })) {
    for (const stale of STALE_TIMING_PHRASES) assert.ok(!text.includes(stale), `${label} does not say an edit after PR creation is never compared: ${JSON.stringify(stale)}`);
    for (const stale of STALE_EDIT_PATH_PHRASES) assert.ok(!text.includes(stale), `${label} does not name MCP update_issue as an edit-time comparison point: ${JSON.stringify(stale)}`);
  }
  const metadata = sliceSection(read(LOCAL_RULES_REL), "### Enforcement Metadata");
  for (const name of ["`per-pr-waiver-edit-record`", "MCP `update_issue`", "`per-pr-waiver-merge-record`", "MCP merge"]) {
    assert.equal(countOf(metadata, name) >= 1, true, `the Enforcement Metadata names ${name}`);
  }
  requireOrdered(metadata, [EDIT_MERGE_METADATA_NEEDLE], "the Hard Gate row names the edit-time gate before the merge-time gate");
});

test("the rigor matrix rows say Gate 4c also compares waiver records", () => {
  const rows = read(".devpro/agent-rules/rules-rigor-level.md").split("\n");
  const consumerRow = rows.filter((line) => line.startsWith("| Consumer Pre-PR Checks（"));
  const devRow = rows.filter((line) => line.startsWith("| Pre-PR DEV 驗證（"));
  assert.equal(consumerRow.length, 1, "the matrix carries exactly one Consumer Pre-PR Checks row");
  assert.equal(devRow.length, 1, "the matrix carries exactly one Pre-PR DEV row");
  assert.ok(consumerRow[0].includes("Gate 4c 驗適用性與證據格式並對照豁免紀錄"), "the Consumer row names the waiver comparison");
  assert.ok(devRow[0].includes("Gate 4c 驗證據行格式並對照豁免紀錄"), "the DEV row names the waiver comparison");
  for (const row of [consumerRow[0], devRow[0]]) assert.ok(!row.includes("只驗"), "neither row says Gate 4c only checks the format");
});

test("[Scenario: openspec-flow :: Contract distinguishes evidence format enforcement from cooperative execution] the strength bullet keeps its older anchors", () => {
  const bullet = contractStrengthBullet();
  assert.match(bullet, /Gate 4c[^\n]*檢查適用性與證據行格式[^\n]*\x60cooperative-only\x60[^\n]*沒有收據/, "format enforcement and cooperative execution on one line");
  assert.ok(bullet.includes("文字證據不證明測試真的執行"), "text is not execution proof");
});

// --- resume without a capsule ------------------------------------------------

test("[Scenario: openspec-flow :: The latest DEV answer is read back after a resume without a capsule]", () => {
  requireOrdered(
    lifecycleSection(),
    [
      "`dev_verification:` 恰一行，之後任何 DEV 作答都覆寫，以最新為準",
      "第零步之後任何 DEV 作答或 Consumer 放行都在沒有條目時新建條目",
      "續接先讀條目再讀 meeting-notes",
    ],
    "the lifecycle leaf creates the entry for any post-Step-0 DEV answer and the resume reads the entry before meeting-notes",
  );
  requireOrdered(
    leafSection("### PR 前執行"),
    ["讀記錄，先讀條目再讀 meeting-notes", "claimed 條目的 `dev_verification:` 是最新作答", "沒有 claimed 條目就新建，不論是否豁免"],
    "the DEV leaf reads the claimed entry before meeting-notes and creates it for any answer",
  );
  requireOrdered(
    devGate(),
    ["讀記錄，先讀條目再讀 meeting-notes", "claimed 條目的 `dev_verification:` 是最新作答", "沒有才讀 meeting-notes Startup evidence", "沒有 claimed 條目就新建，不論是否豁免"],
    "the pre-PR DEV gate reads the claimed entry first and meeting-notes only when the entry holds no DEV line",
  );
});

// --- README ------------------------------------------------------------------

test("README rows and bullets say the PR create gate compares waivers with records", () => {
  const readme = read(README_REL);
  const rows = readme.split("\n");
  const contractRow = rows.find((line) => line.startsWith("| [`consumer-pre-pr-checks.md`]"));
  const leafRow = rows.find((line) => line.startsWith("| [`pre-pr-dev-verification.md`]"));
  assert.ok(contractRow && leafRow, "README carries both module rows");
  requireOrdered(contractRow, ["Gate 4c 驗證據格式並對照豁免紀錄、執行仍 cooperative-only"], "the contract row says Gate 4c also compares waiver records");
  requireOrdered(leafRow, ["Gate 4c 與 MCP 驗行格式並對照豁免紀錄、執行仍 cooperative-only"], "the DEV leaf row says Gate 4c and MCP also compare waiver records");
  const sentence = "寫 `skipped per user decision:` 前要先記下你對該題的回答，沒有紀錄時 PR create gate 會擋";
  const bullets = rows.filter((line) => line.startsWith("- **`pre-pr-checks.local.md` 靠 AI 照流程執行**") || line.startsWith("- **DEV 驗證不看這個檔是否存在。**"));
  assert.equal(bullets.length, 2, "README carries both description bullets");
  for (const bullet of bullets) assert.ok(bullet.includes(sentence), `README bullet carries the record-first sentence: ${bullet.slice(0, 40)}`);
});

// --- negative guard ----------------------------------------------------------

const SHARED_LITERALS = ["skipped per user decision", "DEV deploy-verify", "Consumer pre-PR checks"];
const STATIC_VOCABULARY = [
  "最多 INFO",
  "INFO 上限",
  "升 WARN",
  "封閉清單",
  "補償控制",
  "殘留例外",
  "自我適用",
  "結構殘留",
  "防疏忽",
  "capped at INFO",
  "INFO cap",
  "compensating control",
  "residual exception",
  "self-appl",
  "closed list",
];

const stripCodeSpans = (text) => text.replace(/`[^`\n]*`/g, " ");
const normalizeText = (text) => text.normalize("NFC").replace(/\s+/g, " ").trim();
const stripShared = (text) => SHARED_LITERALS.reduce((acc, literal) => acc.split(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).join(" "), text);

function splitClauses(text) {
  return stripCodeSpans(text)
    .split(/[，。；：、（）「」,;:()]|\.(?=\s|$)/)
    .map((clause) => normalizeText(stripShared(clause)))
    .filter(Boolean);
}

function isRetainedClause(clause) {
  const cjk = (clause.match(/\p{Script=Han}/gu) ?? []).length;
  return cjk > 0 ? cjk >= 12 : clause.length >= 24;
}

// Source paragraphs: the F-9 named exception paragraph of design-core and the lines of the cross-model rule that name it.
function guardSourceParagraphs() {
  const designCore = read(DESIGN_CORE_REL).split("\n").filter((line) => line.startsWith("**F-9 具名殘留例外"));
  const crossModel = read(CROSS_MODEL_REL).split("\n").filter((line) => line.includes("-record-residual"));
  return [...designCore, ...crossModel];
}

function guardSourceClauses() {
  const seen = new Set();
  for (const paragraph of guardSourceParagraphs()) {
    for (const clause of splitClauses(paragraph)) if (isRetainedClause(clause)) seen.add(clause);
  }
  return [...seen];
}

function requirementBlock(specText, title) {
  const lines = specText.split("\n");
  const start = lines.findIndex((line) => line === `### Requirement: ${title}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^### Requirement: /.test(lines[index]) || /^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function deltaSpecTexts(capability = "openspec-flow") {
  const texts = [];
  const deltaRel = `openspec/changes/${CHANGE_NAME}/specs/${capability}/spec.md`;
  if (existsSync(sourcePath(deltaRel))) texts.push(read(deltaRel));
  const archive = sourcePath(ARCHIVE_DIR_REL);
  if (existsSync(archive)) {
    for (const entry of readdirSync(archive)) {
      if (!entry.includes(CHANGE_NAME)) continue;
      const file = `${ARCHIVE_DIR_REL}/${entry}/specs/${capability}/spec.md`;
      if (existsSync(sourcePath(file))) texts.push(read(file));
    }
  }
  return texts;
}

const OWN_REQUIREMENT_TITLES = [
  "Consumer Pre-PR Checks Gate",
  "Confirmed Plain-Language Card Persists In A Claimed Session-Pending Capsule",
  "Pre-PR DEV Verification Decision Does Not Depend On The Local Checks File",
  OWN_REQUIREMENT_TITLE,
];

// The merge-time and edit-time requirements (round 7): one pair in openspec-flow and one pair in pre-tool-mechanical-gates.
const MERGE_EDIT_REQUIREMENTS = [
  ["openspec-flow", "PR Merge Compares Per-PR Waiver Lines With Answer-Time Records"],
  ["openspec-flow", "PR Description Edit Compares Per-PR Waiver Lines With Answer-Time Records"],
  ["pre-tool-mechanical-gates", "Per-PR Waiver Record Merge Gate"],
  ["pre-tool-mechanical-gates", "Per-PR Waiver Record Edit Gate"],
];

function mergeEditRequirementBlocks() {
  return MERGE_EDIT_REQUIREMENTS.map(([capability, title]) => {
    const canonical = read(`openspec/specs/${capability}/spec.md`);
    const block = requirementBlock(canonical, title) ?? deltaSpecTexts(capability).map((text) => requirementBlock(text, title)).find(Boolean);
    assert.ok(block, `the requirement "${title}" is found in the canonical ${capability} spec or in this change's delta`);
    return [`${capability} requirement: ${title}`, block];
  });
}

function ownRequirementBlocks() {
  const canonical = read(CANONICAL_SPEC_REL);
  const deltas = deltaSpecTexts();
  return OWN_REQUIREMENT_TITLES.map((title) => {
    const block = requirementBlock(canonical, title) ?? deltas.map((text) => requirementBlock(text, title)).find(Boolean);
    assert.ok(block, `the requirement "${title}" is found in the canonical spec or in this change's delta`);
    return [`openspec-flow requirement: ${title}`, block];
  });
}

function changeSkillScope() {
  const text = read(CHANGE_REL);
  const lines = text.split("\n");
  const record = lines.find((line) => line.startsWith("**`dev_verification:` 記錄（綁本 change）**"));
  assert.ok(record, "the change skill carries the dev_verification record paragraph");
  const sentence = lines.flatMap((line) => line.split("。")).find((part) => part.includes("唯一例外是"));
  assert.ok(sentence, "the change skill carries the capsule exception sentence");
  return `${record}\n${sentence}`;
}

function guardScope() {
  return Object.fromEntries([
    [LEAF_REL, read(LEAF_REL)],
    [CONTRACT_REL, read(CONTRACT_REL)],
    [LOCAL_RULES_REL, read(LOCAL_RULES_REL)],
    [LIFECYCLE_REL, read(LIFECYCLE_REL).includes(`\n${LIFECYCLE_HEADING}\n`) ? lifecycleSection() : ""],
    [TEMPLATE_REL, read(TEMPLATE_REL)],
    [PRE_PR_REL, read(PRE_PR_REL)],
    [LIB_REL, read(LIB_REL)],
    [`${CHANGE_REL} (record paragraph and exception sentence)`, changeSkillScope()],
    ...ownRequirementBlocks(),
    ...mergeEditRequirementBlocks(),
  ]);
}

function staticVocabularyHits(scope) {
  const hits = [];
  for (const [label, text] of Object.entries(scope)) {
    const lower = text.toLowerCase();
    for (const word of STATIC_VOCABULARY) if (lower.includes(word.toLowerCase())) hits.push(`${label}: ${word}`);
  }
  return hits;
}

function clauseOverlapHits(scope, clauses) {
  const hits = [];
  for (const [label, text] of Object.entries(scope)) {
    const haystack = normalizeText(stripShared(stripCodeSpans(text)));
    for (const clause of clauses) if (haystack.includes(clause)) hits.push(`${label}: ${clause}`);
  }
  return hits;
}

test("negative guard: the guard sources exist and yield clauses (it cannot pass by reading nothing)", () => {
  const paragraphs = guardSourceParagraphs();
  assert.ok(paragraphs.length >= 2, `at least two source paragraphs of the sibling exceptions are found (found ${paragraphs.length})`);
  assert.ok(paragraphs.some((paragraph) => paragraph.includes(SIBLING_IDENTIFIER)), "the sibling exception itself is one of the source paragraphs");
  assert.ok(guardSourceClauses().length > 0, "the source paragraphs yield at least one retained clause");
});

test("negative guard: the carriers of this change state no part of the sibling exception", () => {
  const scope = guardScope();
  assert.deepEqual(staticVocabularyHits(scope), [], "no static exception vocabulary in the carriers");
  assert.deepEqual(clauseOverlapHits(scope, guardSourceClauses()), [], "no clause of the sibling exception in the carriers");
});

test("negative guard: it reports a source clause or a static word inserted into a carrier (self-proving)", () => {
  const scope = guardScope();
  const clauses = guardSourceClauses();
  assert.ok(clauses.length > 0, "there is a clause to insert");
  const label = LEAF_REL;
  const withClause = { ...scope, [label]: `${scope[label]}\n${clauses[0]}\n` };
  assert.ok(clauseOverlapHits(withClause, clauses).length > 0, "a source clause inserted into a carrier copy is reported");
  const withWord = { ...scope, [label]: `${scope[label]}\nINFO 上限\n` };
  assert.ok(staticVocabularyHits(withWord).length > 0, "the static word INFO 上限 inserted into a carrier copy is reported");
});

test("the sibling exception identifier appears only at the three pointers and in one AND of the new requirement", () => {
  const files = {
    ...guardScope(),
    "this test file": read(".devpro/scripts/tests/pr-waiver-record-grep.test.mjs"),
    "pre-pr-dev-verify-grep.test.mjs": read(".devpro/scripts/tests/pre-pr-dev-verify-grep.test.mjs"),
    "consumer-pre-pr-checks-grep.test.mjs": read(".devpro/scripts/tests/consumer-pre-pr-checks-grep.test.mjs"),
    "strengthen-plain-language-card-coverage-grep.test.mjs": read(".devpro/scripts/tests/strengthen-plain-language-card-coverage-grep.test.mjs"),
    [README_REL]: read(README_REL),
  };
  const ownLabel = `openspec-flow requirement: ${OWN_REQUIREMENT_TITLE}`;
  const expected = new Map([[LEAF_REL, 1], [CONTRACT_REL, 1], [PRE_PR_REL, 1], [ownLabel, 1]]);
  for (const [label, text] of Object.entries(files)) {
    assert.equal(countOf(text, SIBLING_IDENTIFIER), expected.get(label) ?? 0, `${label} holds the sibling exception identifier the expected number of times`);
  }
  const andLines = files[ownLabel].split("\n").filter((line) => line.includes(SIBLING_IDENTIFIER));
  assert.equal(andLines.length, 1, "the new requirement names the identifier on one line");
  assert.ok(andLines[0].startsWith("- **AND** ") && andLines[0].includes("\x60design-core.md\x60 §11"), "that line is an AND that points back to design-core.md §11");
});
