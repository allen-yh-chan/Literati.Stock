import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function readFirst(relPaths) {
  for (const relPath of relPaths) {
    const fullPath = repoPath(relPath);
    if (existsSync(fullPath)) return readFileSync(fullPath, "utf8");
  }
  throw new Error(`none of the candidate files exist: ${relPaths.join(", ")}`);
}

function scopeChangeEntrySection() {
  const entry = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  const start = entry.indexOf("### Requirement Scope Change");
  const end = entry.indexOf("### Requirement Count Ratchet");
  assert.ok(start >= 0 && end > start, "openspec-quality-and-formats.md must keep a Requirement Scope Change entry section");
  return entry.slice(start, end);
}

test("requirement scope changes re-enter analyst architect flow (pre-merge and post-merge)", () => {
  const coreCarriers = new Map([
    ["openspec-scope-change.md", read(".devpro/agent-rules/openspec-scope-change.md")],
    ["change/SKILL.md", read(".devpro/agent-skills/devpro-workflows/change/SKILL.md")],
    ["openspec-archive-redo-undo.md", read(".devpro/agent-rules/openspec-archive-redo-undo.md")],
    [
      "openspec-flow/spec.md",
      readFirst([
        "openspec/changes/add-per-session-usage-telemetry/specs/openspec-flow/spec.md",
        "openspec/changes/strengthen-second-reviewer-idle-timeout/specs/openspec-flow/spec.md",
        "openspec/specs/openspec-flow/spec.md",
      ]),
    ],
  ]);
  const hubCarriers = new Map([
    ["openspec-flow.md", read(".devpro/agent-rules/openspec-flow.md")],
    ["openspec-step-1-to-9.md", read(".devpro/agent-rules/openspec-step-1-to-9.md")],
    ["openspec-quality-and-formats.md entry section", scopeChangeEntrySection()],
  ]);

  for (const [name, content] of coreCarriers) {
    assert.match(content, /requirement scope change/i, `${name} must name requirement scope change`);
    assert.match(
      content,
      /pre-merge|PR merge 前|merge 前|post-merge|PR merge 後|merge 後|active-missing/i,
      `${name} must cover pre-merge and/or post-merge timing`,
    );
    assert.match(content, /dp-analyst -> dp-architect/, `${name} must rerun analyst then architect`);
    assert.match(content, /scope-change/, `${name} must record decisions trigger`);
    assert.match(content, /micro-tweak/, `${name} must preserve micro-tweak distinction`);
    assert.match(content, /B-mini/, `${name} must say B-mini does not bypass re-entry`);
    assert.match(
      content,
      /same branch\/change\/PR|same named change/i,
      `${name} must keep same branch/change/PR or same named change`,
    );
    assert.match(content, /pre-merge re-archive|active-missing/i, `${name} must require re-archive or active-missing continuation`);
  }

  for (const [name, content] of hubCarriers) {
    assert.match(content, /requirement scope change/i, `${name} must name requirement scope change`);
    assert.match(
      content,
      /pre-merge|post-merge|active-missing|OpenSpec-before-code/i,
      `${name} must point at scope-change hard gate (pre/post-merge)`,
    );
    assert.match(content, /scope-change/, `${name} must record decisions trigger`);
    assert.match(content, /dp-analyst -> dp-architect|openspec-scope-change\.md.*Requirement Scope Change/i, `${name} must route to analyst/architect re-entry`);
  }

  // The micro-tweak baseline is a hand-copied sentence in the entry and the leaf; keep both copies equal.
  const microTweakLine = (text) => text.split("\n").find((line) => line.startsWith("**micro-tweak 基準**"));
  assert.ok(microTweakLine(scopeChangeEntrySection()), "entry must carry the micro-tweak baseline line");
  assert.equal(
    microTweakLine(scopeChangeEntrySection()),
    microTweakLine(coreCarriers.get("openspec-scope-change.md")),
    "micro-tweak baseline must be identical in the entry and openspec-scope-change.md",
  );

  const hardGate = coreCarriers.get("openspec-scope-change.md");
  assert.match(hardGate, /^### OpenSpec-before-code hard gate/m, "openspec-scope-change must define OpenSpec-before-code hard gate");
  assert.match(hardGate, /implementation carrier/i, "openspec-scope-change must name implementation carriers");

  // The entry file is loaded on every artifact-authoring path; it keeps the trigger and a mandatory pointer.
  const entry = scopeChangeEntrySection();
  for (const phrase of [
    "MUST 先讀 `openspec-scope-change.md`",
    "MUST NOT 寫入或擴充 implementation carrier",
    "**micro-tweak 基準**",
    "target behavior、acceptance criteria、gate semantics、workflow state transitions、merge/release obligations",
  ]) {
    assert.ok(entry.includes(phrase), `openspec-quality-and-formats.md Requirement Scope Change entry missing: ${phrase}`);
  }
});

test("stripped scope-change stub must not satisfy hard-gate grep anchors", () => {
  const strippedCarrier = [
    "# Stripped stub",
    "This file intentionally omits requirement scope change routing.",
    "No analyst/architect rerun here.",
    "No pre-code spec gate wording here.",
  ].join("\n");
  assert.doesNotMatch(strippedCarrier, /OpenSpec-before-code hard gate/i);
  assert.doesNotMatch(strippedCarrier, /dp-analyst -> dp-architect/);
  assert.doesNotMatch(strippedCarrier, /post-merge continuation/i);
});
