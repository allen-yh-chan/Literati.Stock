import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile } from "./read.mjs";
import {
  PRE_PR_FULL_REFERENCE,
  PRE_PR_SKILL,
  composePrePrFullReadingOrder,
  readPrePrSkillFullReadingOrder,
} from "./pre-pr-skill.mjs";

const skill = readSourceFile(PRE_PR_SKILL);
const reference = readSourceFile(PRE_PR_FULL_REFERENCE);

test("full reading order rebuilds the split skill without pointer, back-pointer, or trailer lines", () => {
  const composed = readPrePrSkillFullReadingOrder();
  assert.doesNotMatch(composed, /^### 第三點零步段～第三點七步段（僅 full）$/m);
  assert.doesNotMatch(composed, /^> 本處適用 `SKILL\.md`/m);
  assert.doesNotMatch(composed, /第三點七步段完成後，回 `SKILL\.md`/);
  const order = [
    "### 第二點五步段：Scenario Walkthrough",
    "### 第三點零步段：Pre-review 機械掃描",
    "### 第三步：Six-Axis Review",
    "**Receipt-authority named dispositions",
    "**manifest lineage**",
    "### 第三點六步段：Spec Freeze Archive + Archive Gate Check",
    "### 第三點七步段：OpenSpec Validate Gate",
    "### Post-Ledger Final Evidence Gate",
    "### Consumer Pre-PR Checks Gate",
  ].map((needle) => {
    const at = composed.indexOf(needle);
    assert.ok(at >= 0, `full reading order lost ${needle}`);
    assert.equal(composed.indexOf(needle, at + 1), -1, `full reading order duplicates ${needle}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("SKILL.md tells lite readers to skip the full-only reference and full readers to load it", () => {
  assert.match(skill, /rigor 為 full 時，MUST 先讀 `references\/full-review-and-archive\.md`/);
  assert.match(skill, /lite 不執行這些段落，也不必讀該檔/);
});

test("structure drift fails closed", () => {
  const dropKept = skill.replace(/^\*\*manifest lineage\*\*.*$/m, "");
  assert.throws(() => composePrePrFullReadingOrder(dropKept, reference), /manifest lineage/);
  const dropBackPointer = reference.replace(/^> 本處適用 `SKILL\.md` §第三步 的「manifest lineage」段.*$/m, "");
  assert.throws(() => composePrePrFullReadingOrder(skill, dropBackPointer), /back-pointer/);
  const backPointer = reference.match(/^> 本處適用 `SKILL\.md` §第三步 的「manifest lineage」段.*$/m)[0];
  const duplicateBackPointer = reference.replace(backPointer, `${backPointer}\n\n${backPointer}`);
  assert.throws(() => composePrePrFullReadingOrder(skill, duplicateBackPointer), /duplicated/);
  const dropTrailer = reference.replace(/\n> 第三點七步段完成後.*$/m, "");
  assert.throws(() => composePrePrFullReadingOrder(skill, dropTrailer), /exactly one/);
  const dropPointer = skill.replace("### 第三點零步段～第三點七步段（僅 full）", "### removed");
  assert.throws(() => composePrePrFullReadingOrder(dropPointer, reference), /exactly one/);
});
