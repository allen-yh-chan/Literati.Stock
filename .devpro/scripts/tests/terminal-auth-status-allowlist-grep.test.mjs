import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const read = (rel) => readFileSync(repoPath(rel), "utf8");

const SPEC = "openspec/specs/code-review-checklist/spec.md";
const RUNNER = ".devpro/scripts/run-second-reviewer-projection.mjs";

function runnerAuthStatuses() {
  const match = read(RUNNER).match(/statusValues\.some\(\(status\) => \[([0-9, ]+)\]\.includes\(Number\(status\)\)\)/u);
  assert.ok(match, "runner authentication status allowlist must be locatable");
  return match[1].split(",").map((value) => value.trim());
}

function requirementBlock(title) {
  const spec = read(SPEC);
  const start = spec.indexOf(`### Requirement: ${title}\n`);
  assert.ok(start >= 0, `requirement must exist: ${title}`);
  const end = spec.indexOf("\n### Requirement: ", start + 1);
  return spec.slice(start, end < 0 ? spec.length : end);
}

test("bounded terminal requirement lists the same authentication statuses as the runner", () => {
  const block = requirementBlock("Projection runner SHALL classify bounded terminal control evidence without leaking raw provider output");
  const sentence = block.split("\n").find((line) => line.includes("Explicit authentication evidence from complete bounded stdout or stderr lines SHALL be limited to"));
  assert.ok(sentence, "authentication allowlist sentence must exist");
  const listed = sentence.match(/whose numeric value is ((?:`[0-9]+`(?: or )?)+)/u);
  assert.ok(listed, "allowlist sentence must state the numeric status values");
  assert.deepEqual([...listed[1].matchAll(/`([0-9]+)`/gu)].map((match) => match[1]), runnerAuthStatuses());
});

test("authentication scenario names every status the runner treats as authentication failure", () => {
  const block = requirementBlock("Projection runner SHALL classify bounded terminal control evidence without leaking raw provider output");
  const start = block.indexOf("#### Scenario: Explicit authentication evidence remains authentication failure\n");
  assert.ok(start >= 0, "authentication scenario must exist");
  const scenario = block.slice(start, block.indexOf("\n#### Scenario: ", start + 1));
  const listed = scenario.match(/carries HTTP ((?:`[0-9]+`(?: or )?)+) in an exact top-level or nested provider/u);
  assert.ok(listed, "authentication scenario must state the HTTP status values");
  assert.deepEqual([...listed[1].matchAll(/`([0-9]+)`/gu)].map((match) => match[1]), runnerAuthStatuses());
});
