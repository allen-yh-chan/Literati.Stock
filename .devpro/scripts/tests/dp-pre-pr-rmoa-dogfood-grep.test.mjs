/**
 * Locks fix-resolved-main-origin-authority R4/R6/R7 dogfood anchors in devpro:pre-pr:
 * no mandatory local-main mutate, origin/main BASE, independence pre-gate,
 * pre-first-review checklist, Cursor→Codex operator entry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const OPERATOR = ".devpro/scripts/run-codex-primary-review-operator.mjs";

function slice(content, heading, label) {
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `${label} missing ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n### |\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

test("devpro:pre-pr Step 0 does not mandate local-main mutate; BASE prefers origin/main", () => {
  const content = readFileSync(repoPath(SKILL), "utf8");
  const start = content.indexOf("**Stale local main");
  assert.ok(start >= 0, "missing Stale local main item");
  const sliceText = content.slice(start, start + 2200);
  assert.match(sliceText, /MUST NOT[^\n]*git checkout main && git pull --ff-only/);
  assert.match(sliceText, /MUST NOT[^\n]*git update-ref refs\/heads\/main/);
  assert.match(sliceText, /BASE=\$\(git merge-base origin\/main HEAD/);
  assert.match(sliceText, /沒有任何 worktree 正在 checkout `main`/);
  assert.doesNotMatch(
    sliceText,
    /若 `origin\/main` 領先 local main → \*\*MUST\*\* 把 `refs\/heads\/main` 對齊/,
    "must not require local-main alignment as a hard precondition",
  );
});

test("devpro:pre-pr Step 3 has independence pre-gate and pre-first-review checklist", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const step3 = slice(readPrePrSkillFullReadingOrder(), "### 第三步：Six-Axis Review", "skill Step 3");
  assert.match(step3, /Pre-first-review artifact checklist/);
  assert.match(step3, /Independence pre-gate/);
  assert.match(step3, /MUST NOT[^\n]*Cursor Task／`tl-direct`/);
  assert.match(step3, /run-codex-primary-review-operator\.mjs/);
  assert.match(step3, /initial_full_receipt_digest_sha256[^\n]*receiptRef\.digest_sha256/);
  assert.match(step3, /MUST NOT 先 seal／verify `tl-direct` 再改派/);
});

test("Cursor→Codex primary review operator script exists with fail-closed checklist hooks", () => {
  assert.ok(existsSync(repoPath(OPERATOR)), `missing ${OPERATOR}`);
  const src = readFileSync(repoPath(OPERATOR), "utf8");
  assert.match(src, /--check-only/);
  assert.match(src, /--print-exec/);
  assert.match(src, /independence_required/);
  assert.match(src, /posixSingleQuote/);
  assert.match(src, /touch-covers-diff/);
  assert.match(src, /regression-head-currency/);
  assert.match(src, /assert_ok: typeof digest/);
  assert.match(src, /validateUiSmokeFields/);
  assert.match(src, /findPoisonedTlDirectReceipts/);
  assert.match(src, /origin-main-advanced/);
  assert.match(src, /frozen-origin-main-required/);
  assert.doesNotMatch(src, /no-frozen-arg/);
  assert.doesNotMatch(src, /payloadDigest !== digest \|\| true/);
});
