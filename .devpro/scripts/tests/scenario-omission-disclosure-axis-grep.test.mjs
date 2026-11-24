import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readDeltaForChange } from "./lib/spec-delta-reader.mjs";

const changeName = "strengthen-scenario-omission-visibility";

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

test("軸 1 carries the Scenario Omission Disclosure sub-check", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  assertIncludes(checklist, [
    "Scenario Omission Disclosure sub-check",
    "spec-delta requirement",
    "有無無聲省略（涵蓋範圍是否明講）",
    "不判客觀完整度",
  ]);
});

test("reviewer sub-check phrase / Important / cooperative-only marker are single-line grep-matchable", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const subCheckLine = checklist
    .split("\n")
    .find((l) => l.includes("Scenario Omission Disclosure sub-check"));
  assert.ok(subCheckLine, "sub-check line not found on a single line");
  assert.ok(subCheckLine.includes("標 **Important**"), "Important grade not on the sub-check line");
  assert.ok(subCheckLine.includes("無 mechanical hook gate"), "cooperative-only marker not on the sub-check line");
  assert.ok(subCheckLine.includes("分級預設 Important"), "分級預設 Important marker not on the sub-check line");
  // cross-model fix: because this repo archives before push/PR, the normal PR shape carries the
  // requirement at the archived-delta path, not the active path. The reviewer bullet MUST name that
  // path and forbid skipping post-archive, else a reviewer reading the literal trigger skips the
  // sub-check on exactly the shape devpro:second-review reviews.
  assert.ok(
    subCheckLine.includes("openspec/changes/archive/"),
    "archived-delta path not on the sub-check line (post-archive PR shape would be uncovered)",
  );
  assert.ok(
    subCheckLine.includes("MUST NOT") && subCheckLine.includes("略過本 sub-check"),
    "post-archive skip guard not on the sub-check line",
  );
});

test("reviewer sub-check is cooperative-only, applies to both reviewers, no Critical escalation", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  const subCheckLine = checklist
    .split("\n")
    .find((l) => l.includes("Scenario Omission Disclosure sub-check"));
  assertIncludes(subCheckLine, [
    "不要求外部工具",
    "純語意判斷",
    "dp-reviewer",
    "devpro:second-review",
    "Critical 仍留給 correctness/security 缺陷",
  ]);
});

test("authoring guidance carries the scenario 涵蓋面宣告 feed-forward", () => {
  const authoring = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  assertIncludes(authoring, [
    "scenario 涵蓋面宣告",
    "涵蓋或明講省略",
    "不驗涵蓋面",
    "Scenario Omission Disclosure sub-check",
  ]);
});

test("capability spec delta carries the requirement (delta-only, non-empty)", () => {
  const delta = readDeltaForChange(changeName, "code-review-checklist", {
    includeArchive: true,
  });
  assert.ok(delta.trim().length > 0, "delta empty");
  assertIncludes(delta, [
    "Scenario Omission Disclosure Sub-check",
    "cooperative-only",
    "no mechanical hook gate enforces it",
    // legacy-skill-names:begin scenario-omission-archived-spec-delta
    "dp-second-review", // archived openspec/changes/archive/2026-07-16-strengthen-scenario-omission-visibility/specs/code-review-checklist/spec.md is never rewritten
    // legacy-skill-names:end scenario-omission-archived-spec-delta
    "SHALL NOT escalate a silent scenario omission to Critical",
    // cross-model fix: the requirement trigger body + a dedicated scenario MUST cover the
    // post-archive shape (archived delta + promoted canonical), not just the active-delta path.
    "openspec/changes/archive/",
    "post-archive PR shape",
  ]);
});
