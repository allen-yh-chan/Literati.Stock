/**
 * b-mini-delta-exit-grep.test.mjs
 *
 * Locks the "B-mini 必攜至少一個 capability delta" strict-exit anchors across
 * three surfaces: chore-classification.md（分類規則）、
 * openspec-quality-and-formats.md（Surface Matrix）、
 * validate-openspec-change.mjs（wrapper 的可讀錯誤提示）。
 *
 * 目的：防止未來編輯把「B-mini 必含 delta」的強制語意悄悄退化回「N/A: no
 * capability semantics」可規避 delta 的舊允許語。
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const choreClassificationPath = repoPath(".devpro/agent-rules/chore-classification.md");
const openspecQualityPath = repoPath(".devpro/agent-rules/openspec-quality-and-formats.md");
const validateWrapperPath = repoPath(".devpro/scripts/validate-openspec-change.mjs");

const choreClassificationContent = readFileSync(choreClassificationPath, "utf8");
const openspecQualityContent = readFileSync(openspecQualityPath, "utf8");
const validateWrapperContent = readFileSync(validateWrapperPath, "utf8");

test("chore-classification.md 含「B-mini 必攜 delta」錨點詞", () => {
  assert.ok(
    choreClassificationContent.includes("B-mini 必攜 delta"),
    "chore-classification.md 期望含「B-mini 必攜 delta」錨點詞，未找到 — B-mini delta 強制語意可能被移除或改寫"
  );
});

test("chore-classification.md 含「真無 capability semantics」語意", () => {
  assert.ok(
    choreClassificationContent.includes("真無 capability semantics"),
    "chore-classification.md 期望含「真無 capability semantics」字串（配 chore A doc-only fast-track 語意），未找到"
  );
});

test("chore-classification.md Exit Criteria 段含「含至少一個 `specs/<capability>/spec.md` delta」字串", () => {
  assert.ok(
    choreClassificationContent.includes(
      "含至少一個 `specs/<capability>/spec.md` delta"
    ),
    "chore-classification.md Exit Criteria 段期望含「含至少一個 `specs/<capability>/spec.md` delta」字串，未找到 — B-mini exit criteria 可能被弱化"
  );
});

test("openspec-quality-and-formats.md Surface Matrix 含「僅限」字串", () => {
  assert.ok(
    openspecQualityContent.includes("僅限"),
    "openspec-quality-and-formats.md 期望 Affected capability spec 列含「僅限」字串（限定 N/A 用於 chore A doc-only），未找到"
  );
});

test("openspec-quality-and-formats.md Surface Matrix 含「B-mini strict-exit」字串", () => {
  assert.ok(
    openspecQualityContent.includes("B-mini strict-exit"),
    "openspec-quality-and-formats.md 期望 Affected capability spec 列含「B-mini strict-exit」字串，未找到 — strict-exit 語意可能被移除"
  );
});

test("openspec-quality-and-formats.md 不再含舊字串「rule 行為有 capability semantics 時」（防回退）", () => {
  assert.ok(
    !openspecQualityContent.includes("rule 行為有 capability semantics 時"),
    "openspec-quality-and-formats.md 意外出現舊字串「rule 行為有 capability semantics 時」— Surface Matrix 可能被回退到強化前的寬鬆版本"
  );
});

test("validate-openspec-change.mjs 含 B-mini 缺 delta 的可讀提示錨點", () => {
  assert.ok(
    validateWrapperContent.includes(
      "B-mini 必須攜帶至少一個 capability"
    ),
    "validate-openspec-change.mjs 期望含「B-mini 必須攜帶至少一個 capability」提示錨點，未找到 — wrapper 對缺 delta 失敗的可讀提示可能被移除"
  );
});

test("chore-classification.md Exit Criteria 段已含 delta 必填字串（negative-test 精神：防 N/A 規避語回退）", () => {
  assert.ok(
    choreClassificationContent.includes(
      "B-mini：`proposal-mini.md` 存在（六段，含 `## Why` + `## What Changes` + `## Batch Approval Ledger`）、**含至少一個 `specs/<capability>/spec.md` delta**"
    ),
    "chore-classification.md Exit Criteria 段期望明確要求 B-mini 含至少一個 specs delta（強制、非 N/A 可規避），未找到完整錨點句 — B-mini exit criteria 可能被弱化為允許 N/A 規避 delta"
  );
});


test("B-mini ledger retains a named decisions baseline", () => {
  const anchor = /^B-mini 的 Requirement Ledger[^\n]*\*\*必須\*\*[^\n]*`decisions\.md`[^\n]*`## Requirement Baseline Ledger`/;
  const hits = choreClassificationContent.split("\n").filter(line => anchor.test(line));
  assert.equal(hits.length, 1, "mini baseline must have one operative guidance line");
  assert.doesNotMatch(choreClassificationContent, /產物\*\*不需要\*\*[^\n]*decisions\.md/, "a decisions waiver conflicts with the ledger baseline");
});
