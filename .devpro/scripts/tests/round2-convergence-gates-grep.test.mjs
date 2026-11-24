import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



function sectionBetween(content, startHeading, nextHeadingPattern) {
  const start = content.indexOf(startHeading);
  assert.notEqual(start, -1, `missing section heading: ${startHeading}`);
  const rest = content.slice(start);
  const nextMatch = rest.slice(startHeading.length).match(nextHeadingPattern);
  return nextMatch
    ? rest.slice(0, startHeading.length + nextMatch.index)
    : rest;
}

test("QA Test Scope exit criteria names only fields present in the template", () => {
  const section = sectionBetween(
    read(".devpro/agent-rules/testing-and-qa.md"),
    "## QA Test Scope Template",
    /\n### Usage/
  );
  const exitCriteria = sectionBetween(section, "### Exit Criteria", /\n### /);

  for (const field of [
    "基本資訊",
    "變更範圍摘要",
    "建議 QA 驗測重點",
    "可能受影響模組 / 流程",
    "風險與未覆蓋項目",
    "建議回歸測試清單",
  ]) {
    assert.match(section, new RegExp(`### .*${field}`), `template missing field: ${field}`);
    assert.match(exitCriteria, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `exit criteria missing field: ${field}`);
  }

  assert.doesNotMatch(exitCriteria, /驗收標準/, "exit criteria must not require a field absent from the template");
});

test("dev-flow checklist uses callable devpro: skill names", () => {
  const checklist = read(".devpro/agent-rules/dev-flow-checklist.md");

  assert.match(checklist, /\/devpro:change/);
  assert.match(checklist, /\/devpro:pre-pr/);
  assert.doesNotMatch(checklist, /\/dp:change/);
  assert.doesNotMatch(checklist, /\/dp:pre-pr/);
});

test("devpro:pre-pr worktree cleanup guidance does not claim a nonexistent hook backstop", () => {
  const skill = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  const match = skill.match(/^> \*\*不要自動 remove worktree\*\*：.*$/m);
  assert.ok(match, "missing worktree cleanup paragraph");

  const paragraph = match[0];
  assert.match(paragraph, /git-branch-hygiene\.md/);
  assert.match(paragraph, /prune-merged-local\.mjs/);
  assert.match(paragraph, /沒有 git-native hook backstop/);
  assert.doesNotMatch(paragraph, /Gate 2g/);
  assert.doesNotMatch(paragraph, /機械擋下/);
});
