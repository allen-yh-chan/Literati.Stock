/**
 * design-cold-read-grep.test.mjs
 *
 * Cross-carrier guard for the design cold read. The gate's behaviour lives in
 * hook-pre-tool-gate-design-cold-read.test.mjs; this file pins the prose that
 * tells an agent what to do, per rule-anchor-guard-strength.md:
 *   - the status vocabulary is a value set, so it is compared both ways and an
 *     extra value turns red;
 *   - polarity anchors bind the polarity word and its object on one physical
 *     line and must match exactly once;
 *   - retired wording has resident fixtures, because a forbidden-text check has
 *     no deletion audit to prove it is not idle.
 *
 * It proves the text exists, not that an agent follows it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

const LEAF = ".devpro/agent-rules/design-reasoning.md";
const SKILL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const SPEC = "openspec/specs/design-reasoning/spec.md";
const GATE = ".devpro/scripts/hooks/pre-tool-gate.mjs";
const RECORD_MODULE = ".devpro/scripts/hooks/lib/design-cold-read-record.mjs";
const HEADING = "### Design Cold Read and Implementation Handoff";
const GATE_ID = "design-cold-read-prewrite";

const RELEASING = ["user-accepted-unverified", "user-confirmed"];
const ALL_STATUSES = ["pending", ...RELEASING].sort();

function leafSection() {
  const text = read(LEAF);
  assert.equal(text.split(`${HEADING}\n`).length - 1, 1, `${LEAF} must hold the heading once`);
  const body = text.slice(text.indexOf(HEADING) + HEADING.length);
  const end = body.indexOf("\n### ");
  assert.ok(end > 0, "section must end at the next heading");
  return body.slice(0, end);
}

function requirementBody() {
  const text = read(SPEC);
  const start = text.indexOf("### Requirement: Independent Design Comprehension And Handoff");
  assert.ok(start >= 0, "requirement must exist");
  const rest = text.slice(start + 1);
  return rest.slice(0, rest.indexOf("\n### Requirement:"));
}

function skillStep() {
  const text = readChangeSkillFullReadingOrder();
  const start = text.indexOf("**Design Cold Read（");
  const end = text.indexOf("**Step 5 前置：委派計畫", start);
  assert.ok(start >= 0 && end > start, "skill step must sit before the delegation plan");
  return text.slice(start, end);
}

function declaredStatuses(text) {
  return [...new Set([...text.matchAll(/status: ([a-z][a-z-]*)/g)].map((match) => match[1]))].sort();
}

function releasingStatuses(source) {
  const block = source.match(/const RELEASING_LINES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "the record module must declare its releasing lines");
  return [...block[1].matchAll(/DESIGN_COLD_READ_[A-Z]+_LINE/g)]
    .map(([name]) => {
      const value = source.match(new RegExp(`${name} = "status: ([^"]+)"`));
      assert.ok(value, `${name} must be declared`);
      return value[1];
    })
    .sort();
}

function assertOneLine(text, pattern, label) {
  const lines = text.split("\n").filter((line) => pattern.test(line));
  assert.equal(lines.length, 1, `${label}: expected one line matching ${pattern}, found ${lines.length}`);
}

test("the status vocabulary is the same closed set in every carrier", () => {
  assert.deepEqual(declaredStatuses(leafSection()), ALL_STATUSES, LEAF);
  assert.deepEqual(declaredStatuses(requirementBody()), ALL_STATUSES, SPEC);
  assert.deepEqual(declaredStatuses(skillStep()), ALL_STATUSES, SKILL);
  assert.deepEqual(releasingStatuses(read(RECORD_MODULE)), RELEASING, RECORD_MODULE);
});

test("the status comparison names an inserted value and turns red", () => {
  const inserted = `${leafSection()}\n| \`status: user-approved\` | 例 |`;
  assert.notDeepEqual(declaredStatuses(inserted), ALL_STATUSES);
  assert.ok(declaredStatuses(inserted).includes("user-approved"));

  const source = read(RECORD_MODULE);
  const withExtra = source.replace(
    "RELEASING_LINES = new Set([",
    "RELEASING_LINES = new Set([DESIGN_COLD_READ_PENDING_LINE, ",
  );
  assert.notEqual(withExtra, source, "the fixture must touch the set");
  assert.notDeepEqual(releasingStatuses(withExtra), RELEASING);
});

test("the leaf keeps each polarity on one line", () => {
  const section = leafSection();
  for (const [label, pattern] of [
    ["timing", /`tasks\.md` 完成後，第一個實作寫入前 MUST 做冷讀/],
    ["shape", /看 change 形狀[^。\n]*不看 hook level/],
    ["separate", /與 `dp-second-reviewer` 分開跑，不佔審查輪數/],
    ["rerun", /只在 scope change re-entry 重跑（第一行改回 `status: pending`）/],
    ["materials", /不給對話背景、ledger、審查重點、作者結論或白話卡/],
    ["reader inputs", /`proposal\.md` 或 `proposal-mini\.md`（B-mini 的任務在內）/],
    ["unwritable field", /寫不出的欄位算 finding/],
    ["comparison", /TL MUST 逐欄對照使用者確認過的白話卡/],
    ["stop", /每次都停，batch approval 不涵蓋/],
    ["self review", /作者自評不算冷讀/],
    ["answer line", /指令在下方加 `user-answer:`（原話）與 `change:` 兩行，不需終端機或簽章/],
    ["forgery", /使用者還沒回答就跑或引用沒說過的話，屬偽造同意證據/],
    ["release check", /只認第一行恰為放行狀態、恰一行非空 `user-answer:`、`change:` 為本 change 的紀錄/],
    ["legacy", /舊版帶 `proof=` 的紀錄不放行，問使用者確認後依原話重跑這行/],
    ["residual", /閘證明不了使用者真的回答或讀過原文，屬 `design-core\.md` §11 `consent-record-residual`，不另立具名例外/],
    ["no waiver", /「冷讀未驗證」不豁免任何既有 gate/],
    ["governance object", /治理對象是 `workflow-and-openspec-state-integrity`/],
    ["pending row", /^\| `status: pending` \| AI 用檔案工具寫，讀者回報後 \|$/],
    ["confirmed row", /^\| `status: user-confirmed` \| 使用者在對話確認後，AI 跑 `node \.devpro\/scripts\/confirm-design-cold-read\.mjs <change> --user-answer "<原話>"` \|$/],
    ["unverified row", /^\| `status: user-accepted-unverified` \| 同上加 `--unverified`：無讀者可用或本規則上線前已開工、標「冷讀未驗證」，使用者決定繼續 \|$/],
    ["record", /紀錄寫 `openspec\/changes\/<change>\/comprehension\.md`（tracked，隨 archive 搬走）/],
  ]) {
    assertOneLine(section, pattern, label);
  }
});

test("the spec keeps each obligation on one line", () => {
  const requirement = requirementBody();
  for (const [label, pattern] of [
    ["separate", /SHALL run separately from dp-second-reviewer and SHALL NOT consume a review round/],
    ["materials", /SHALL NOT receive conversation context, a review ledger, review focus, author conclusions or the plain-language card/],
    ["reader inputs", /brd\.md, proposal\.md or proposal-mini\.md \(which holds B-mini tasks\), design\.md, tasks\.md and the spec deltas/],
    ["stop", /Batch approval SHALL NOT cover this stop/],
    ["after answer", /That line SHALL be released only after the user answers in the conversation, by the AI running \.devpro\/scripts\/confirm-design-cold-read\.mjs with --user-answer quoting the user's words/],
    ["answer line", /The command SHALL write one `user-answer:` line below the first line quoting the user's words, with each run of whitespace \(line breaks included\) turned into one space so the answer fits on that line, and one `change:` line naming the change, and SHALL need no terminal, key or signature/],
    ["forgery", /Running that command before the user answers, or quoting words the user did not say, SHALL be treated as forged consent evidence/],
    ["release check", /until the first line is exactly a releasing status and the record carries exactly one non-empty `user-answer:` line and exactly one `change:` line naming the change resolved from the branch/],
    ["legacy", /A legacy record whose releasing line carries ` proof=` SHALL NOT release; TL SHALL ask the user in the conversation and rerun the command with the answer/],
    ["residual", /that residual SHALL be treated as an instance of the design-core section 11 consent-record-residual clause, not as a separate named exception/],
  ]) {
    assertOneLine(requirement, pattern, label);
  }
});

test("the skill step runs the reader before the stop and the status change after it", () => {
  const step = skillStep();
  assert.match(step, /subagent_type: "dp-explorer"/);
  assert.match(step, /instance_mode: fresh/);
  assertOneLine(step, /evidence_scope: [^\\]*proposal\.md 或 proposal-mini\.md（B-mini 的任務在內）/, "reader inputs");
  assertOneLine(step, /不給對話背景、ledger、審查重點、作者結論或白話卡/, "materials");
  assertOneLine(step, /逐欄對照使用者確認過的白話卡.*不一致或寫不出的欄位記為 finding，寫下處置/, "comparison");
  assertOneLine(step, /停下交給使用者確認，batch approval 不涵蓋此停點/, "stop");
  assertOneLine(step, /選項是 `1\. 確認 2\. 要改（說改哪裡） 3\. 其他`，使用者在對話回答即可，不用自己跑指令/, "stop options");
  assertOneLine(step, /寫三要素：為什麼停（設計還沒經使用者確認，確認前不能開始實作）、要你做什麼、回了會怎樣/, "three parts");
  assertOneLine(step, /在對話向使用者說明紀錄內容（改過就說改了什麼）並問一句是否確認，使用者回答後 AI 依原話重跑同一行，紀錄已有讀者原文與對照就不用重做冷讀/, "legacy or missing answer");
  assertOneLine(step, /內容實質改變或紀錄沒有讀者原文時，把第一行改回 `status: pending`，從第 1 步重跑/, "stale proof reset");
  assertOneLine(step, /Gate CR 回報 `change:` 不是本 change（從別的 change 複製來的紀錄）時，不要重跑確認指令：把第一行改回 `status: pending`，從第 1 步為本 change 重跑冷讀/, "copied record reset");
  assertOneLine(step, /選 1 後 AI 跑 `node \.devpro\/scripts\/confirm-design-cold-read\.mjs <change> --user-answer "<使用者原話>"`、讀回第一行再繼續，選 2 修 artifact 後重跑冷讀，選 3 依使用者回覆處理/, "what happens next");
  assertOneLine(step, /scope change re-entry 時把第一行改回 `status: pending` 再從第 1 步重跑/, "rerun reset");
  assertOneLine(step, /使用者回答確認後，AI 跑上面那行，`--user-answer` 原樣帶入使用者的回答，讀回第一行是 `status: user-confirmed`、下兩行是 `user-answer:` 與本 change 的 `change:` 才繼續。使用者還沒回答前不得跑/, "confirmed");
  assertOneLine(step, /放行後不再改這個檔。/, "no edits after release");
  assertOneLine(step, /`1\. 繼續 2\. 先等讀者 3\. 其他`.*讀回第一行是 `status: user-accepted-unverified`、下兩行是 `user-answer:` 與本 change 的 `change:` 才繼續/, "unverified");
  assertOneLine(step, /繼續代表接受沒有獨立讀者驗證的設計、既有 gate 照舊/, "unverified meaning");
  assertOneLine(step, /為什麼停寫原因與確認前不能開始實作/, "unverified why");
  assertOneLine(step, /選 1 後 AI 跑同一行加 `--unverified`、`--user-answer` 帶入使用者原話，讀回第一行再繼續，選 2 就維持 pending，讀者可用時從第 1 步重跑，選 3 依使用者回覆處理/, "waiting for a reader");
  assert.ok(step.indexOf("status: pending") < step.indexOf("batch approval 不涵蓋此停點"));
  assert.ok(step.indexOf("batch approval 不涵蓋此停點") < step.indexOf("status: user-confirmed"));
});

test("the delegation plan waits for the cold read and its carry-forward does not cover that stop", () => {
  const text = readChangeSkillFullReadingOrder();
  assertOneLine(text, /tasks\.md 建好且設計冷讀放行後、開始實作前，TL \*\*必須\*\*產出委派計畫/, "delegation plan order");
  assertOneLine(text, /FYI＋當輪續跑\*\*（owner=AI；不適用於上方冷讀停點）/, "carry-forward carve-out");
  assertOneLine(text, /已有 `comprehension\.md` 時把第一行改回 `status: pending`，重做 Design Cold Read/, "scope re-entry reset");
});

test("the record stays tracked, unlike the lite scope record", () => {
  assert.doesNotMatch(read(".gitignore"), /comprehension/);
});

test("the gate is registered, cited by its rule, and points at a real heading", () => {
  const gate = read(GATE);
  assert.match(gate, new RegExp(`id: "${GATE_ID}"`));
  assert.ok(gate.includes("§Design Cold Read and Implementation Handoff"), "block reason must cite the section");
  assertOneLine(read(LEAF), new RegExp(`\\| Hard Gate \\| \`${GATE_ID}\``), "leaf metadata");
  assertOneLine(leafSection(), new RegExp(`Gate CR（\`${GATE_ID}\`）`), "leaf body");
  assertOneLine(
    read(".devpro/agent-rules/rules-rigor-level.md"),
    new RegExp(`^\\| \`${GATE_ID}\`（[^|]*\\| fire \\| fire \\| no-op`),
    "rigor matrix",
  );
  assertOneLine(read(".devpro/agent-rules/dev-flow-checklist.md"), /Gate CR：`comprehension\.md` 第一行放行才可寫/, "flow checklist");
  assertOneLine(read(".devpro/agent-rules/openspec-step-1-to-9.md"), /第一個實作寫入前先完成設計冷讀/, "step 5");
});

// The user answers in the conversation and the AI records the answer; there is no
// terminal-only step, signature or shell guard to keep in sync (design-core section 11).
const SIGNING_ERA = /design-cold-read-confirm-bash|design-cold-read-record-residual|自己的終端機|自己跑下面這行|HMAC|own terminal/;

test("the signing-era confirm gate and wording are gone", () => {
  assert.doesNotMatch(read(GATE), /design-cold-read-confirm-bash/);
  assert.doesNotMatch(read(".devpro/agent-rules/rules-rigor-level.md"), /design-cold-read-confirm-bash/);
  for (const file of [LEAF, SPEC]) {
    assert.doesNotMatch(read(file), SIGNING_ERA, file);
  }
  assert.doesNotMatch(readChangeSkillFullReadingOrder(), SIGNING_ERA, SKILL);
});

const RETIRED = /不另加固定 dispatch|no extra fixed dispatch|沿用同一次 audit-only|### 冷讀：|design-cold-read-status-/i;

test("retired wording stays out of the carriers", () => {
  assert.match("由同一次 `dp-second-reviewer audit-only` 做冷讀，不另加固定 dispatch。", RETIRED);
  assert.match("Existing design audit SHALL supply the reader; no extra fixed dispatch SHALL be added.", RETIRED);
  assert.match("設計審查沿用同一次 audit-only reader／completion reason", RETIRED);
  assert.match("### 冷讀：理解缺口", RETIRED);
  assert.match("`design-cold-read-status-write` 擋檔案工具", RETIRED);
  assert.doesNotMatch("冷讀與 `dp-second-reviewer` 分開跑，不佔審查輪數", RETIRED);
  assert.doesNotMatch("### Design Cold Read and Implementation Handoff", RETIRED);

  for (const file of [LEAF, SPEC]) {
    assert.doesNotMatch(read(file), RETIRED, file);
  }
  // The skill is split across SKILL.md and its full-rigor reference; check both via the reading order.
  assert.doesNotMatch(readChangeSkillFullReadingOrder(), RETIRED, SKILL);
});
