import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



test("PR template carriers include Change Context and Manual Test H2s", () => {
  for (const rel of [
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".devpro/agent-rules/git-pr-template-and-merge.md",
  ]) {
    const body = read(rel);
    assert.match(body, /(?:^|\n)## Change Context\b/, `${rel} missing ## Change Context`);
    assert.match(body, /(?:^|\n)## Manual Test\b/, `${rel} missing ## Manual Test`);
  }
});

test("body lint requires Change Context and Manual Test H2s", () => {
  const lint = read(".devpro/scripts/pre-pr-body-template-check.mjs");
  assert.match(lint, /## Change Context/, "pre-pr-body-template-check missing ## Change Context");
  assert.match(lint, /## Manual Test/, "pre-pr-body-template-check missing ## Manual Test");
});

test("devpro:pre-pr PR section list names Change Context and Manual Test", () => {
  const skill = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  assert.match(
    skill,
    /Change Context[\s\S]{0,120}Manual Test|Manual Test[\s\S]{0,120}Change Context/,
    "devpro:pre-pr must name Change Context and Manual Test in PR description guidance",
  );
});

test("Ready Response skeleton includes ManualTest alongside ChangeContext", () => {
  const gate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  assert.match(
    gate,
    /最小骨架[\s\S]{0,120}ChangeContext:[\s\S]{0,80}ManualTest:/,
    "post-pr-completion-gate.md missing ManualTest in minimal skeleton",
  );
  assert.match(
    gate,
    /ManualTest:[\s\S]{0,200}N\/A/,
    "post-pr-completion-gate.md ManualTest must allow explicit N/A",
  );
  assert.match(
    gate,
    /ManualTest[\s\S]{0,200}(不是|MUST NOT)[\s\S]{0,80}Path F|Path F[\s\S]{0,120}ManualTest/,
    "ManualTest must stay cooperative / not Path F",
  );
});

test("git-workflow-tracking Ready path names ManualTest", () => {
  const tracking = read(".devpro/agent-rules/git-workflow-tracking.md");
  assert.match(
    tracking,
    /Ready success path guard[\s\S]{0,800}ManualTest:/,
    "git-workflow-tracking.md Ready success path must name ManualTest:",
  );
});

test("openspec-flow locks dual-surface handoff scenarios", () => {
  const canonical = read("openspec/specs/openspec-flow/spec.md");
  const changeDir = repoPath("openspec/changes/strengthen-human-handoff-context");
  const archiveRoot = repoPath("openspec/changes/archive");
  let deltaRel = "openspec/changes/strengthen-human-handoff-context/specs/openspec-flow/spec.md";
  try {
    read(deltaRel);
  } catch {
    const archived = readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith("-strengthen-human-handoff-context"))
      .map((entry) => entry.name)
      .sort()
      .at(-1);
    assert.ok(archived, "missing active or archived strengthen-human-handoff-context delta");
    deltaRel = `openspec/changes/archive/${archived}/specs/openspec-flow/spec.md`;
  }
  const delta = read(deltaRel);
  for (const body of [canonical, delta]) {
    assert.match(body, /User-Owned Merge Authorization Includes ManualTest/);
    assert.match(body, /ManualTest N\/A When Human Testing Not Needed/);
  }
  assert.match(delta, /PR Body Carries Change Context And Manual Test/);
  // After archive, ADDED promotes into canonical; accept either active-delta-only or archived+canonical.
  if (!canonical.includes("PR Body Carries Change Context And Manual Test")) {
    assert.match(delta, /## ADDED Requirements/);
  }
  void changeDir;
});
