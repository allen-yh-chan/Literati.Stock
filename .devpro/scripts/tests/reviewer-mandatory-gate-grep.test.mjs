/**
 * reviewer-mandatory-gate-grep.test.mjs
 *
 * Companion to `silent-skip-rule-grep.test.mjs`. Locks the dp-reviewer
 * mandatory-gate behavioral rule in `## 第三步` of pre-pr.md against
 * silent relaxation (e.g. someone trimming "TL 必須拒絕" → "TL 視情況決定"
 * or dropping the "Red Flag" framing).
 *
 * Pattern derived from PR #222 review (issue 4336494482) where Cursor's
 * trim dropped 4 contract phrases from pre-pr.md and a fix-up was
 * required (commit 2edac85). The Red Flag clause survived round 4 but
 * the wording is the kind of behavioral rule that would silently weaken
 * if someone later writes "可降級 light review" → "可酌情跳過 reviewer".
 *
 * REQUIRED: phrases that lock the strong wording.
 * FORBIDDEN: softened/permissive synonyms that would relax the rule
 * without explicit amend-change tracking.
 *
 * Removing or weakening any guarded phrase requires an amend change
 * that updates this list.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const SECTION_HEADING = "### 第三步：Six-Axis Review";

const REQUIRED = [
  "Red Flag",
  "mandatory gate",
  "subagent 不可用 fallback",
  "不得跳過",
  "不可完全跳過",
];

const FORBIDDEN = [
  "可酌情跳過",
  "TL 自決跳過",
  "視情況跳過",
  "可省略 reviewer",
  "reviewer 為選用",
];

// 第三步 spans SKILL.md (spec-named paragraphs) and references/full-review-and-archive.md;
// assert on the full-rigor reading order so both halves stay covered.
const content = readPrePrSkillFullReadingOrder();
const lines = content.split("\n");
const startLine = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
const endLine = lines.findIndex((l, i) => i > startLine && /^### /.test(l));
const section =
  startLine === -1
    ? null
    : lines.slice(startLine, endLine === -1 ? undefined : endLine).join("\n");

test("pre-pr.md 第三步段 存在", () => {
  assert.ok(
    section,
    '找不到「### 第三步：Six-Axis Review」heading — reviewer mandatory-gate scaffold 已被移除',
  );
});

for (const phrase of REQUIRED) {
  test(`第三步段 必含 "${phrase}"`, () => {
    assert.ok(
      section.includes(phrase),
      `reviewer mandatory-gate 規則完整性受損：「${phrase}」 missing — 跳過 reviewer 的禁令可能被同義詞回退（trim 前須走 amend change 並更新本測試 phrase list）`,
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`第三步段 禁含 "${phrase}"`, () => {
    assert.ok(
      !section.includes(phrase),
      `reviewer mandatory-gate 規則退化：「${phrase}」 出現於段內 — 該 phrase 為 reviewer skip 同義詞退化訊號（reviewer mandatory 是 pre-PR hard gate，不容軟化）`,
    );
  });
}
