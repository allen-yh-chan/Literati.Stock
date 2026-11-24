/**
 * openspec-skip-specs-1-9-0-grep.test.mjs
 *
 * Prove-it / wording lock for #2238:
 * OpenSpec ≥1.9.0 zero-delta ERROR + skip_specs opt-out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readSourceFile as read } from "./lib/read.mjs";
import { sourcePath } from "./lib/source-root.mjs";

const quality = read(".devpro/agent-rules/openspec-quality-and-formats.md");
const openspecFlow = read(".devpro/agent-rules/openspec-flow.md");
const pitfalls = read(
  ".devpro/agent-skills/openspec/openspec-artifact-authoring/references/spec-delta-pitfalls.md",
);

function readIfExists(rel) {
  const file = sourcePath(rel);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readActiveOrArchivedDelta() {
  const active = readIfExists(
    "openspec/changes/strengthen-openspec-skip-specs-1-9-0/specs/openspec-flow/spec.md",
  );
  if (active.includes("OpenSpec 1.9.0 Zero-Delta")) return active;
  const archiveDir = sourcePath("openspec/changes/archive");
  if (!existsSync(archiveDir)) return "";
  const match = readdirSync(archiveDir)
    .filter((d) => d.endsWith("-strengthen-openspec-skip-specs-1-9-0"))
    .sort()
    .pop();
  if (!match) return "";
  return read(
    `openspec/changes/archive/${match}/specs/openspec-flow/spec.md`,
  );
}

const delta = readActiveOrArchivedDelta();
const canonical = read("openspec/specs/openspec-flow/spec.md");

const CARRIERS = [quality, openspecFlow, pitfalls];

test("quality-formats documents OpenSpec 1.9.0 skip_specs and ERROR semantics", () => {
  for (const phrase of [
    "No-delta / skip_specs（OpenSpec ≥1.9.0）",
    "skip_specs: true",
    "ERROR",
    "cite-only bugfix",
  ]) {
    assert.match(quality, new RegExp(phrase));
  }
  assert.ok(quality.includes("禁止**為過 gate 發明 delta"));
  assert.doesNotMatch(quality, /\*\*No-delta warn\*\*/);
});

test("openspec-flow B-mini path documents zero-delta skip_specs checklist", () => {
  assert.match(openspecFlow, /zero-delta（≥1\.9\.0）/);
  assert.match(openspecFlow, /skip_specs: true/);
  assert.match(openspecFlow, /validate-openspec-change\.mjs/);
  assert.match(openspecFlow, /No-delta \/ skip_specs/);
});

test("spec-delta-pitfalls uses 1.9.0 ERROR + skip_specs remediation", () => {
  assert.match(
    pitfalls,
    /No-delta ERROR without skip_specs \(OpenSpec ≥1\.9\.0\)/,
  );
  assert.match(pitfalls, /skip_specs: true/);
  assert.doesNotMatch(pitfalls, /No-delta warn treated as normal/);
});

test("carriers must not retain unqualified No-delta warn phrasing", () => {
  for (const [label, body] of [
    ["openspec-quality-and-formats.md", quality],
    ["openspec-flow.md", openspecFlow],
    ["spec-delta-pitfalls.md", pitfalls],
  ]) {
    assert.doesNotMatch(body, /\*\*No-delta warn\*\*/);
    assert.doesNotMatch(body, /No-delta warn treated as normal/);
    assert.doesNotMatch(
      body,
      /No deltas found.*warn 僅在|warn 可接受/,
      `${label} still describes No-delta as warn-acceptable`,
    );
  }
});

test("spec delta contains ADDED requirement and delta-only anchor", () => {
  assert.ok(delta.length > 0, "delta must resolve from active or archived path");
  const deltaAnchor =
    "# openspec-flow Delta: OpenSpec 1.9.0 Zero-Delta And Skip Specs Opt-Out";
  assert.match(delta, new RegExp(deltaAnchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(
    !canonical.includes(deltaAnchor),
    "delta-only anchor must not already be in canonical spec",
  );
  assert.match(
    delta,
    /Requirement: OpenSpec 1\.9\.0 Zero-Delta And Skip Specs Opt-Out/,
  );
});
