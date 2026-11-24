import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile } from "./read.mjs";
import {
  CHANGE_FULL_REFERENCE,
  CHANGE_SKILL,
  composeChangeFullReadingOrder,
  readChangeSkillFullReadingOrder,
} from "./change-skill.mjs";

const skill = readSourceFile(CHANGE_SKILL);
const reference = readSourceFile(CHANGE_FULL_REFERENCE);

test("full reading order rebuilds the split skill without pointer or trailer lines", () => {
  const composed = readChangeSkillFullReadingOrder();
  assert.doesNotMatch(composed, /^\*\*第四步～第六步（僅 full）\*\*：/m);
  assert.doesNotMatch(composed, /^\*\*proposal 同步、Design Cold Read 與委派計畫（僅 full）\*\*：/m);
  assert.doesNotMatch(composed, /回 `SKILL\.md`/);
  const order = [
    "**第三步：建 worktree + 環境檢查 + 寫 meeting-notes.md",
    "**Formalize auto-promote",
    "**第四步：Pre-analyst Clarification",
    "**第五步：呼叫 `dp-analyst`",
    "**第六步：呼叫 `dp-architect`",
    "**dp-architect dispatch schema**",
    "**Design.md Second-Review Gate（when-present）**",
    "接著根據參數決定 change 名稱：",
    "**批次同意延伸**",
    "**Architect → proposal.md 同步驗證**",
    "**Design Cold Read（有 `design.md` 時必做",
    "**Step 5 前置：委派計畫（Mandatory Checkpoint）**",
    "**第七步：Matching Ledger Carry-Forward",
  ].map((needle) => {
    const at = composed.indexOf(needle);
    assert.ok(at >= 0, `full reading order lost ${needle}`);
    assert.equal(composed.indexOf(needle, at + 1), -1, `full reading order duplicates ${needle}`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("SKILL.md tells full readers to load the reference and lite readers to skip it", () => {
  assert.match(skill, /^\*\*第四步～第六步（僅 full）\*\*：rigor 為 full 時，MUST 先讀 `references\/full-analysis-and-design\.md`/m);
  assert.match(skill, /^\*\*proposal 同步、Design Cold Read 與委派計畫（僅 full）\*\*：rigor 為 full 時，MUST 先讀 `references\/full-analysis-and-design\.md`/m);
  assert.match(skill, /lite 不執行這些步驟，也不必讀該檔/);
  assert.match(skill, /lite 不執行這些段落，也不必讀該檔，直接到第七步/);
  assert.doesNotMatch(skill, /^\*\*第四步：Pre-analyst Clarification/m);
  assert.doesNotMatch(skill, /^\*\*Design Cold Read（有 `design\.md` 時必做/m);
});

test("structure drift fails closed", () => {
  const dropPointer = skill.replace(/^\*\*第四步～第六步（僅 full）\*\*：.*\n/m, "");
  assert.throws(() => composeChangeFullReadingOrder(dropPointer, reference), /exactly one line starting/);
  const pointer = skill.match(/^\*\*proposal 同步、Design Cold Read 與委派計畫（僅 full）\*\*：.*$/m)[0];
  const duplicatePointer = skill.replace(pointer, `${pointer}\n\n${pointer}`);
  assert.throws(() => composeChangeFullReadingOrder(duplicatePointer, reference), /got 2/);
  const dropHeading = reference.replace("\n## 第四步～第六步\n", "\n## removed\n");
  assert.throws(() => composeChangeFullReadingOrder(skill, dropHeading), /exactly one/);
  const dropTrailer = reference.replace(/\n> 委派計畫完成後.*$/m, "");
  assert.throws(() => composeChangeFullReadingOrder(skill, dropTrailer), /exactly one/);
  const swapped = reference
    .replace("\n## 第四步～第六步\n", "\n## TMP\n")
    .replace("\n## proposal 同步～委派計畫\n", "\n## 第四步～第六步\n")
    .replace("\n## TMP\n", "\n## proposal 同步～委派計畫\n");
  assert.throws(() => composeChangeFullReadingOrder(skill, swapped), /must order|exactly one|empty or out of order/);
});
