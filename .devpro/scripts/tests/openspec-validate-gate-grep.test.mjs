/**
 * openspec-validate-gate-grep.test.mjs
 *
 * Locks the OpenSpec validate gate mandatory rule in `## 第三點七步` of the pre-pr
 * full-rigor reference (`references/full-review-and-archive.md`; SKILL.md points there).
 * Companion to silent-skip-rule-grep / reviewer-mandatory-gate-grep /
 * archive-gate-grep series.
 *
 * `openspec validate --strict --specs` is the spec-format hard gate (issue
 * #848: scoped from `--all` to `--specs` so unrelated in-progress active change
 * folders inherited from main do not fail the gate; the current change is
 * already promoted to canonical specs by the Step 3.6 archive). The rule still
 * forbids `--no-strict` as a bypass.
 *
 * REQUIRED locks: gate-mandatory wording + the explicit prohibitions.
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

const SECTION_HEADING = "### 第三點七步段：OpenSpec Validate Gate";

const REQUIRED = [
  "必過",
  "openspec validate --strict --specs",
  "block PR 建立",
  "lint-spec-shall-must.mjs",
  "禁止",
  "--no-strict",
];

const FORBIDDEN = [
  "可酌情 validate",
  "視情況 validate",
  "validate 為選用",
  "可使用 --no-strict",
];

const content = readFileSync(prePrPath, "utf8");
const lines = content.split("\n");
const startLine = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
const endLine = lines.findIndex((l, i) => i > startLine && /^### /.test(l));
const section =
  startLine === -1
    ? null
    : lines.slice(startLine, endLine === -1 ? undefined : endLine).join("\n");

test("pre-pr.md 第三點七步段 存在", () => {
  assert.ok(
    section,
    '找不到「### 第三點七步段：OpenSpec Validate Gate」heading — openspec validate gate scaffold 已被移除',
  );
});

for (const phrase of REQUIRED) {
  test(`第三點七步段 必含 "${phrase}"`, () => {
    assert.ok(
      section.includes(phrase),
      `openspec validate gate 規則完整性受損：「${phrase}」 missing — 旁路 validate 的禁令可能被同義詞回退（trim 前須走 amend change 並更新本測試 phrase list）`,
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`第三點七步段 禁含 "${phrase}"`, () => {
    assert.ok(
      !section.includes(phrase),
      `openspec validate gate 規則退化：「${phrase}」 出現於段內 — 該 phrase 為 validate bypass 同義詞退化訊號（spec format 是 capability contract 的硬保證，不容軟化）`,
    );
  });
}
