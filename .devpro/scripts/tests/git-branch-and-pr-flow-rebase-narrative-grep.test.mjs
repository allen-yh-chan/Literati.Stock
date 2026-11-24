/**
 * git-branch-and-pr-flow-rebase-narrative-grep.test.mjs
 *
 * Locks issue #2133: post-rebase narrative numeric freshness checklist in
 * git-branch-and-pr-flow.md so a future edit cannot silently drop the rebase-
 * absorb grep+sync discipline.
 *
 * ── Guard 強度邊界（設計取捨，非缺陷）──────────────────────────────
 * Grep cannot prove token-preserving semantic reversal. Polarity uses
 * same-physical-line compound regex per rule-anchor-guard-strength. Structural
 * existence (heading / filenames / out-of-scope tokens) uses includes().
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile } from "./lib/read.mjs";

const content = readRepoFile(".devpro/agent-rules/git-branch-and-pr-flow.md");

test("git-branch-and-pr-flow.md has Post-rebase narrative numeric freshness heading", () => {
  assert.ok(
    content.includes("Post-rebase narrative numeric freshness"),
    "期望含 heading「Post-rebase narrative numeric freshness」，未找到 — post-rebase 敘事數字 freshness 節可能被移除"
  );
});

test("git-branch-and-pr-flow.md names 獨立單刀 / 不發明數字 / 參照次數", () => {
  for (const token of ["獨立單刀", "不發明數字", "參照次數"]) {
    assert.ok(
      content.includes(token),
      `期望含 structural token「${token}」，未找到 — 適用範圍或 pass 條件可能被移除`
    );
  }
});

test("MUST grep 同步 下次 review dispatch 同一物理行", () => {
  const mustGrepSyncDispatch =
    /MUST(?!\s+NOT)[^\n]*grep[^\n]*meeting-notes\.md[^\n]*proposal\.md[^\n]*proposal-mini\.md[^\n]*同步[^\n]*下次 review dispatch/;
  assert.ok(
    mustGrepSyncDispatch.test(content),
    "期望 MUST（非 MUST NOT）、grep、三敘事檔名、同步、下次 review dispatch 同一物理行 compound regex，未找到 — polarity 可能被拆行弱化或檔名被無關行代償"
  );
});

test("MUST NOT 機械 lint 同一物理行", () => {
  const mustNotMechanicalLint = /MUST NOT[^\n]*機械 lint/;
  assert.ok(
    mustNotMechanicalLint.test(content),
    "期望 MUST NOT 與「機械 lint」同一物理行，未找到 — 機械 lint 禁令可能被弱化"
  );
});
