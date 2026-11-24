import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const openspecFlow = read(".devpro/agent-rules/openspec-flow.md");
const quality = read(".devpro/agent-rules/openspec-quality-and-formats.md");
const chore = read(".devpro/agent-rules/chore-classification.md");
const spec = read("openspec/specs/openspec-flow/spec.md");
const proposal = read(
  "openspec/changes/archive/2026-06-06-strengthen-rule-feedback-openspec-routing/proposal-mini.md",
);

test("openspec-flow defines rule-feedback routing and minimum matrix", () => {
  for (const phrase of [
    "Rule-feedback OpenSpec routing",
    "Rule-feedback Surface Matrix",
    "agent skill `SKILL.md`",
    "cross-runtime-parity",
    "mechanical grep/hook tests",
    "PR dependency wording",
    "opt-out reason",
  ]) {
    assert.match(openspecFlow, new RegExp(phrase));
  }
  assert.match(openspecFlow, /不得\*\*判為 chore A/);
});

test("openspec quality defines rule-feedback surface matrix rows", () => {
  assert.match(quality, /### Rule-feedback Surface Matrix/);
  for (const phrase of [
    "Rule leaf / adapter / hook / command",
    "agent skill `SKILL.md`",
    "Affected capability spec",
    "Cross-runtime parity spec",
    "Mechanical guard",
    "PR dependency wording",
    "N/A: <reason>",
  ]) {
    assert.match(quality, new RegExp(phrase));
  }
});

test("chore classification prevents behavior-changing rule-feedback from chore A", () => {
  assert.match(chore, /Rule-feedback B-mini 子路徑/);
  assert.match(chore, /不得判為 chore A/);
  assert.match(chore, /純 typo、格式、連結修正且不改行為才可維持 chore A/);
});

test("B-mini active validation uses repo-local proposal-mini shim wrapper", () => {
  for (const body of [openspecFlow, chore]) {
    assert.match(body, /validate-openspec-change\.mjs/);
    assert.match(body, /proposal-mini\.md/);
  }
  assert.match(openspecFlow, /shim 成 `proposal\.md`/);
  assert.match(openspecFlow, /unknown\/0 items/);
  assert.match(chore, /upstream `openspec validate <name>` \/ `--changes`/);
});

test("openspec-flow spec captures rule-feedback routing requirement", () => {
  assert.match(spec, /Requirement: Rule Feedback OpenSpec Routing/);
  assert.match(spec, /Rule-feedback Surface Matrix/);
  assert.match(spec, /agent skill `SKILL\.md`/);
  assert.match(spec, /MUST NOT be classified as chore A/);
  assert.match(spec, /explicit opt-out reason/);
});

test("proposal-mini dogfoods the rule-feedback surface matrix", () => {
  assert.match(proposal, /## Rule-feedback Surface Matrix/);
  assert.match(proposal, /issue: #936/);
  for (const phrase of [
    "Rule leaf / adapter / hook / command",
    "Affected capability spec",
    "Cross-runtime parity spec",
    "Mechanical guard",
    "PR dependency wording",
  ]) {
    assert.match(proposal, new RegExp(phrase));
  }
});
