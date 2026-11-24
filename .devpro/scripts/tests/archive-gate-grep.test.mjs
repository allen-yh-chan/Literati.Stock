/**
 * archive-gate-grep.test.mjs
 *
 * Locks the Archive Gate mandatory rule in `## 第三點六步` of the pre-pr
 * full-rigor reference (`references/full-review-and-archive.md`; SKILL.md points there).
 * Companion to silent-skip-rule-grep / reviewer-mandatory-gate-grep series.
 *
 * Archive gate is the highest-stakes "必過" gate — skipping leaves main with
 * unarchived changes blocking subsequent PRs (root cause of issue #170 / PR #93).
 *
 * REQUIRED locks: gate-mandatory wording.
 * FORBIDDEN guards: silent-relaxation synonyms.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
const prePrPath = path.join(
  REPO_ROOT,
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/full-review-and-archive.md",
);

const SECTION_HEADING =
  "### 第三點六步段：Spec Freeze Archive + Archive Gate Check";

const REQUIRED = [
  "必過",
  "pre-pr-archive-gate.mjs",
  "Active change detection",
  "exit 1 block",
  "block PR 建立",
  "Pre-PR Archive Gate Enforcement",
];

const FORBIDDEN = [
  "可跳過 archive",
  "可省略 archive",
  "視情況 archive",
  "archive 為選用",
  "archive 可後補",
];

const content = readFileSync(prePrPath, "utf8");
const lines = content.split("\n");
const startLine = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
const endLine = lines.findIndex((l, i) => i > startLine && /^### /.test(l));
const section =
  startLine === -1
    ? null
    : lines.slice(startLine, endLine === -1 ? undefined : endLine).join("\n");

test("pre-pr.md 第三點六步段 存在", () => {
  assert.ok(
    section,
    '找不到「### 第三點六步段：Spec Freeze Archive + Archive Gate Check」heading — archive gate scaffold 已被移除',
  );
});

for (const phrase of REQUIRED) {
  test(`第三點六步段 必含 "${phrase}"`, () => {
    assert.ok(
      section.includes(phrase),
      `archive gate 規則完整性受損：「${phrase}」 missing — 漏跑 archive 的禁令可能被同義詞回退（trim 前須走 amend change 並更新本測試 phrase list）`,
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`第三點六步段 禁含 "${phrase}"`, () => {
    assert.ok(
      !section.includes(phrase),
      `archive gate 規則退化：「${phrase}」 出現於段內 — 該 phrase 為 archive skip 同義詞退化訊號（issue #170 PR #93 的 6 個月漏 archive root cause 直指此類軟化）`,
    );
  });
}
