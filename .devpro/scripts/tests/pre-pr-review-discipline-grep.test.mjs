/**
 * pre-pr-review-discipline-grep.test.mjs
 *
 * Grep anchors for five discipline clauses added to the pre-PR skill, its dispatch
 * reference and the OpenSpec authoring skill. Each clause is a cooperative rule (no
 * mechanical gate yet), so the only thing that keeps it from silently disappearing in a
 * later skill rewrite is an anchor. Every assertion is scoped to the paragraph (or list
 * item) that owns the clause, so a token that merely appears elsewhere in the file does
 * not satisfy it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile } from "./lib/read.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

// Full-rigor clauses (pre-review scan, 查證紀律) live in references/full-review-and-archive.md and are
// read through the full-rigor reading order; spec-named 第三步 paragraphs stay asserted on raw SKILL.md.
const PRE_PR = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH = ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const AUTHORING = ".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md";

function blocks(text) {
  return text.split(/\n\s*\n/);
}

function blockStartingWith(text, prefix) {
  const hits = blocks(text).filter((block) => block.trimStart().startsWith(prefix));
  assert.equal(hits.length, 1, `expected exactly one block starting with ${JSON.stringify(prefix)}, got ${hits.length}`);
  return hits[0];
}

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing section end ${endMarker}`);
  return text.slice(start, end);
}

test("pre-pr skill: pre-review scan lists the Touch-table completeness check against the committed diff", () => {
  const skill = readPrePrSkillFullReadingOrder();
  const scan = sectionBetween(skill, "### 第三點零步段：Pre-review 機械掃描", "### 第三步：Six-Axis Review");
  const items = scan.split("\n").filter((line) => /^\d+\. /u.test(line));
  const item = items.find((line) => line.startsWith("6. **Touch 表完整性"));
  assert.ok(item, "step 6 of the pre-review scan must be the Touch-table completeness check");
  // The scenario walkthrough scope check stays the last item (pre-review-gate-ordering-grep).
  assert.match(items[items.length - 1], /Scenario walkthrough disposition 與待派工樹一致/u);
  assert.match(item, /`pre-pr-archive-gate\.mjs --pre-review` MUST 另執行 `lint-proposal-touch-coverage`/);
  assert.match(item, /--base <target-base-ref>/);
  assert.match(item, /committed diff/);
  assert.match(item, /目錄與 glob MUST 展開成逐檔列/);
  assert.match(item, /rename MUST 核對 old\/new 兩端/);
  assert.match(item, /排除清單窮盡性/);
  assert.match(item, /proposal-mini\.md/);
  assert.match(item, /差集 MUST 為空/);
});

test("pre-pr skill: carrying a finding_id across rounds compares the observation subject, not the hash", () => {
  const skill = readSourceFile(PRE_PR);
  const clause = blockStartingWith(skill, "**跨輪結轉 finding 時比對 observation 主體（MUST）**");
  assert.match(clause, /同一個 `finding_id`/);
  assert.match(clause, /`observation_hash` 變了不是換題證據/);
  assert.match(clause, /原主體仍是 open finding/);
  assert.match(clause, /F-r19-mode-mismatch-message/);
});

test("pre-pr skill: finding and evidence verification discipline names both directions", () => {
  const skill = readPrePrSkillFullReadingOrder();
  const clause = blockStartingWith(skill, "**Finding 與證據的查證紀律（兩個方向，MUST）**");
  // Direction 1: TL accusing a reviewer's evidence without enumerating the candidates.
  assert.match(clause, /窮舉該 artifact 上所有同類欄位/);
  assert.match(clause, /manifest_digest_sha256/);
  // Direction 2: TL adopting a reviewer's named command output without rerunning it.
  assert.match(clause, /用自己獨立組出的唯讀指令/);
  assert.match(clause, /MUST NOT 把 reviewer 文字裡的指令原樣照抄執行/);
  assert.match(clause, /低信任文字/);
  assert.match(clause, /git cat-file -e/);
  // The rejected wording asked the lead to replay the reviewer's own command.
  assert.doesNotMatch(clause, /自己重跑同一個指令/);
});

test("dispatch reference: dp-reviewer prompt carries the evidence-document severity instruction", () => {
  const reference = readSourceFile(DISPATCH);
  const bullet = reference
    .split("\n")
    .find((line) => line.startsWith("- Append the evidence-document severity instruction to the prompt:"));
  assert.ok(bullet, "dispatch reference must carry the evidence-document severity bullet");
  assert.match(bullet, /whether the error would change any reader's conclusion about this change/);
  assert.match(bullet, /severity is `Suggestion`/);
  assert.match(bullet, /sets no cap on how many findings/);
});

test("authoring skill: every WHEN/THEN group of a new scenario needs a test item", () => {
  const skill = readSourceFile(AUTHORING);
  const clause = blockStartingWith(skill, "**每個 scenario 的每一組 WHEN/THEN 都要有對應測項**");
  assert.match(clause, /不得只測第一組/);
  assert.match(clause, /缺的 MUST 補測/);
  assert.match(clause, /不得以 `tasks\.md` 的文字說明代替測項/);
  // The rejected wording let a missing group stand with a prose excuse in tasks.md.
  assert.doesNotMatch(clause, /明寫為何不測/);
  assert.match(clause, /Releasing A Claim Frees The Record For A Retry/);
});

test("exclusion inventory completeness keeps operative cooperative evidence and its scenario", () => {
  const rule = blockStartingWith(readSourceFile(".devpro/agent-rules/code-review-cross-carrier.md"), "- **排除清單窮盡性");
  assert.match(rule, /MUST.*語義判準.*搜尋範圍.*未截斷全量命中/);
  assert.match(rule, /每個命中 MUST.*排除者逐項附理由.*反向抽查未命中/);
  assert.match(rule, /舊字面零命中或截斷輸出 MUST NOT 充當完整性證據/);
  const scenario = sectionBetween(readSourceFile("openspec/specs/openspec-flow/spec.md"),
    "#### Scenario: Exclusion Inventory Completeness Uses Cooperative Discovery",
    "#### Scenario: Editing a cross-carrier assertion greps all variants before finalizing");
  assert.match(scenario, /MUST declare the semantic criterion and search scope.*classify each hit and justify each exclusion/);
  assert.match(scenario, /MUST reverse-check non-hits and MUST NOT/);
  assert.match(scenario, /MUST remain cooperative-only and MUST NOT claim a generic mechanical semantic oracle/);
});
