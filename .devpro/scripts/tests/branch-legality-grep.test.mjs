/**
 * branch-legality-grep.test.mjs
 *
 * Locks the branch-legality mandatory rule in `## 前置檢查` of pre-pr.md.
 * Companion to silent-skip-rule-grep / reviewer-mandatory-gate-grep /
 * archive-gate-grep / openspec-validate-gate-grep series.
 *
 * 前置檢查 #1 forbids running `/dp:pre-pr` on protected branches and pins
 * the allowed prefix list. Silent removal of any branch from the禁止 list
 * or any prefix from the allowlist is the regression we're guarding.
 *
 * REQUIRED locks: full forbidden-branch enumeration + full prefix allowlist.
 * FORBIDDEN guards: silent-relaxation synonyms.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
const prePrPath = path.join(
  REPO_ROOT,
  ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
);

const SECTION_HEADING = "### 前置檢查";

const REQUIRED = [
  "分支合法性",
  "禁止",
  "main",
  "master",
  "integration",
  "release/",
  "production",
  "前綴必須是",
  "feature/",
  "bugfix/",
  "chore/",
  "hotfix/",
];

const FORBIDDEN = [
  "可在 main 上跑",
  "可在 master 上跑",
  "前綴可選",
  "前綴僅建議",
  "可使用其他前綴",
  "視情況選擇分支",
];

const content = readFileSync(prePrPath, "utf8");
const lines = content.split("\n");
const startLine = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
const endLine = lines.findIndex((l, i) => i > startLine && /^### /.test(l));
const section =
  startLine === -1
    ? null
    : lines.slice(startLine, endLine === -1 ? undefined : endLine).join("\n");

test("pre-pr.md 前置檢查段 存在", () => {
  assert.ok(
    section,
    '找不到「### 前置檢查」heading — branch legality scaffold 已被移除',
  );
});

for (const phrase of REQUIRED) {
  test(`前置檢查段 必含 "${phrase}"`, () => {
    assert.ok(
      section.includes(phrase),
      `branch legality 規則完整性受損：「${phrase}」 missing — 受保護分支或合法前綴清單可能被同義詞回退（trim 前須走 amend change 並更新本測試 phrase list）`,
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`前置檢查段 禁含 "${phrase}"`, () => {
    assert.ok(
      !section.includes(phrase),
      `branch legality 規則退化：「${phrase}」 出現於段內 — 該 phrase 為 branch protection 軟化訊號（不容意外允許 main / master 上跑 /dp:pre-pr）`,
    );
  });
}
