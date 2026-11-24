/**
 * full-change-design-carrier-grep.test.mjs
 *
 * Locks issue #2342 polarity: full OpenSpec changes MUST persist a reviewable
 * design.md (Context + Decisions + D1). B-mini / chore A omit. Authoring
 * carriers MUST NOT keep "optional for any change" / "一句話設計免寫" as a
 * license to skip the file on full changes.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

function read(rel) {
  return readFileSync(repoPath(rel), "utf8");
}

const CARRIERS = {
  template: ".devpro/agent-rules/design-template.md",
  archive: ".devpro/agent-rules/openspec-archive-principles.md",
  steps: ".devpro/agent-rules/openspec-step-1-to-9.md",
  formats: ".devpro/agent-rules/openspec-quality-doc-formats.md",
  skill: ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  architect: ".claude/agents/dp-architect.md",
  cursorArchitect: ".cursor/agents/dp-architect.md",
  codexArchitect: ".codex/agents/dp-architect.toml",
};

function openspecFlowContractText() {
  const candidates = [
    "openspec/changes/amend-full-change-design-carrier/specs/openspec-flow/spec.md",
    "openspec/changes/archive/2026-08-25-amend-full-change-design-carrier/specs/openspec-flow/spec.md",
    "openspec/changes/archive/2026-08-26-amend-full-change-design-carrier/specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  ];
  for (const rel of candidates) {
    if (existsSync(repoPath(rel))) return read(rel);
  }
  throw new Error("openspec-flow contract carrier missing");
}

test("openspec-flow forbids optional-for-any-change watershed wording", () => {
  const delta = openspecFlowContractText();
  assert.doesNotMatch(
    delta,
    /no mechanical gate SHALL require its existence for any change/,
    "active Cooperative Watershed MUST NOT still say optional for any change",
  );
  assert.match(
    delta,
    /Every full OpenSpec change SHALL persist a reviewable `design\.md`/,
    "active delta MUST require full-change design.md persist",
  );
  assert.match(delta, /B-mini and chore A changes SHALL omit `design\.md`/);
  assert.match(delta, /format-when-present/);
  assert.match(delta, /`audit-only` second-review remains when-present/);
  assert.match(delta, /risk_shape_unavailable/);
});

test("authoring carriers require full persist and B-mini omit", () => {
  const template = read(CARRIERS.template);
  const archive = read(CARRIERS.archive);
  const steps = read(CARRIERS.steps);
  const formats = read(CARRIERS.formats);
  // The design-persist sentence sits in text moved to the full-rigor reference; use the full reading order.
  const skill = readChangeSkillFullReadingOrder();
  const architect = read(CARRIERS.architect);
  const cursorArchitect = read(CARRIERS.cursorArchitect);

  for (const [name, body] of [
    ["template", template],
    ["archive", archive],
    ["steps", steps],
    ["formats", formats],
    ["architect", architect],
    ["cursorArchitect", cursorArchitect],
  ]) {
    assert.doesNotMatch(
      body,
      /一句話設計免寫/,
      `${name} MUST NOT license full-change omit via 一句話設計免寫`,
    );
  }

  assert.match(template, /Full OpenSpec change MUST 持久化可審查的 `design\.md`/);
  assert.match(template, /B-mini／chore A 免寫/);
  assert.match(archive, /不得作為 full 免檔授權/);
  assert.match(steps, /full change MUST 持久化 design\.md/);
  assert.match(formats, /full change \*\*強制存在\*\*/);
  assert.match(skill, /full change MUST 已持久化 `design\.md`/);
  assert.match(skill, /B-mini／chore A/);
  assert.match(architect, /full change 的 `design\.md`/);
  assert.match(architect, /B-mini／chore A 免寫/);
  assert.match(cursorArchitect, /一律持久化/);
});

test("devpro:change skill copies stay byte-identical to SSOT", () => {
  const ssot = read(CARRIERS.skill);
  for (const copy of [
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  ]) {
    assert.equal(read(copy), ssot, `${copy} drifted from devpro:change SSOT`);
  }
});

test("all architect projections preserve full persistence and the shared design method", () => {
  for (const rel of [CARRIERS.architect, CARRIERS.cursorArchitect, CARRIERS.codexArchitect, ".opencode/agent/dp-architect.md"]) {
    const text = read(rel);
    assert.match(text, /design-reasoning\.md/, rel);
    assert.match(text, /full change 的[\s\S]{0,90}design\.md[\s\S]{0,90}一律/, rel);
    assert.doesNotMatch(text, /僅設計超一句話、需權衡時才寫，非強制存在/, rel);
    assert.match(text, /B-mini／chore A 免寫/, rel);
  }
});
