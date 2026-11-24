import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

const step = read(".devpro/agent-rules/openspec-step-1-to-9.md");
const consumer = read(".devpro/agent-rules/openspec-flow-consumer.md");
const spec = read("openspec/specs/openspec-flow/spec.md");

test("GLOBAL setup must not use interactive openspec config profile", () => {
  assert.doesNotMatch(step, /openspec config profile/);
  assert.doesNotMatch(spec, /openspec config profile/);
});

test("consumer verify must not use openspec list workflows", () => {
  assert.doesNotMatch(consumer, /openspec list workflows/);
});

test("step-1-to-9 must not use openspec list workflows", () => {
  assert.doesNotMatch(step, /openspec list workflows/);
});

test("canonical spec must not use openspec list workflows", () => {
  assert.doesNotMatch(spec, /openspec list workflows/);
});

test("step-1-to-9 documents non-interactive config set profile custom", () => {
  assert.match(step, /openspec config set profile custom/);
});

test("canonical spec documents non-interactive config set profile custom", () => {
  assert.match(spec, /openspec config set profile custom/);
});

test("step-1-to-9 documents JSON-array workflows including onboard", () => {
  assert.match(step, /\["propose","explore","apply","archive","onboard"\]/);
});

test("canonical spec documents JSON-array workflows including onboard", () => {
  assert.match(spec, /\["propose","explore","apply","archive","onboard"\]/);
});

test("step-1-to-9 requires reread and workflows non-enum caveat", () => {
  assert.match(step, /openspec config list|config get workflows/);
  assert.match(step, /不驗 enum|非 enum|not enum-validat|does not enum-validate|no enum validat/i);
});

test("consumer leaf requires reread and workflows non-enum caveat", () => {
  assert.match(consumer, /openspec config list|config get workflows/);
  assert.match(consumer, /不驗 enum|非 enum|not enum-validat|does not enum-validate|no enum validat/i);
});

test("canonical spec requires reread and workflows non-enum caveat", () => {
  assert.match(spec, /openspec config list|config get workflows/);
  assert.match(spec, /does not enum-validate/);
});

test("canonical GLOBAL profile scenario does not pin OpenSpec v1.3.1", () => {
  assert.doesNotMatch(spec, /OpenSpec v1\.3\.1 stores profile/);
});
