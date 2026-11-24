import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const QUALITY_RULE = ".devpro/agent-rules/openspec-quality-and-formats.md";
const STEP_RULE = ".devpro/agent-rules/openspec-step-1-to-9.md";
const ARTIFACT_SKILL = ".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md";

function read(path) {
  return readFileSync(path, "utf8");
}

test("spec delta requirement mode precheck is documented in authoring rules", () => {
  const quality = read(QUALITY_RULE);
  assert.match(quality, /ADDED\/MODIFIED canonical title precheck/);
  assert.match(quality, /lint-delta-requirement-mode\.mjs/);
  assert.match(quality, /加到既有 requirement 仍是 `MODIFIED`，不是 `ADDED`/);
  assert.match(quality, /REMOVED 區塊必須逐字複製 canonical/);

  const step = read(STEP_RULE);
  assert.match(step, /先比對 canonical `### Requirement:` title set/);
  assert.match(step, /加 scenario 到既有 requirement 也是 `MODIFIED`，不是 `ADDED`/);
});

test("spec delta requirement mode lint is in artifact and pre-pr workflows", () => {
  const artifactSkill = read(ARTIFACT_SKILL);
  assert.match(artifactSkill, /Requirement mode precheck/);
  assert.match(artifactSkill, /node \.devpro\/scripts\/lint-delta-requirement-mode\.mjs openspec\/changes\/<name>/);
  assert.match(artifactSkill, /REMOVED 區塊必須逐字複製 canonical requirement 的完整區塊/);

  // Pre-archive lint lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const prePrSkill = readPrePrSkillFullReadingOrder();
  assert.match(prePrSkill, /Pre-archive Requirement Mode Lint/);
  assert.match(prePrSkill, /ADDED` 同名已存在、`MODIFIED` 同名不存在/);
  assert.match(prePrSkill, /另對每個 `## REMOVED Requirements` 區塊檢查 capability 有 canonical spec/);
});
