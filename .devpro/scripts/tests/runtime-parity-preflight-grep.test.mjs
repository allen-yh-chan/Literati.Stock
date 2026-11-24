import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";
import { readSpecWithDelta } from "./lib/spec-delta-reader.mjs";

const changeName = "strengthen-runtime-parity-preflight";

test("rule-design-principles defines redirect/runtime parity pre-read", () => {
  const rule = read(".devpro/agent-rules/rule-design-principles.md");
  for (const phrase of [
    "Redirect Entry / Runtime Load Pre-Read",
    "redirect entry file",
    "runtime 載入/分發機制",
    "multi-runtime-parity.test.mjs",
    "Parity invariant impact: 保持 / 放寬 / 收緊",
    "load-bearing invariant",
    "convenience proxy",
    "runtime-parity-preflight-grep.test.mjs",
  ]) {
    assert.match(rule, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("preflight checklist carries the same touch-list checkpoint", () => {
  const preflight = read(".devpro/agent-rules/preflight-checklist.md");
  assert.match(preflight, /點 5 延伸：redirect entry \/ runtime load parity pre-read/);
  assert.match(preflight, /Redirect\/runtime parity pre-read captured/);
  assert.match(preflight, /Parity invariant impact/);
});

test("dp change command loads parity evidence before finalizing proposal", () => {
  // Redirect Entry checkpoint moved to the full-rigor reference; use the full reading order.
  const changeCommand = readChangeSkillFullReadingOrder();
  assert.match(changeCommand, /Redirect Entry \/ Runtime Load Parity Checkpoint/);
  assert.match(changeCommand, /finalizing proposal/);
  assert.match(changeCommand, /rule-design-principles\.md` 守則 1/);
  assert.match(changeCommand, /multi-runtime-parity\.test\.mjs/);
  assert.match(changeCommand, /load-bearing invariant 與 convenience proxy/);
});

test("multi-runtime parity test documents invariant versus proxy", () => {
  const parityTest = read(".devpro/scripts/tests/multi-runtime-parity.test.mjs");
  assert.match(parityTest, /load-bearing invariant/);
  assert.match(parityTest, /convenience proxy/);
  assert.match(parityTest, /所有 redirect entry 都指向 AGENTS\.md/);
  assert.match(parityTest, /byte-equality/);
});

test("capability specs capture redirect/runtime parity preflight", () => {
  const openspecFlow = readSpecWithDelta("openspec-flow", { changeName });
  const crossRuntime = readSpecWithDelta("cross-runtime-parity", { changeName });
  assert.match(openspecFlow, /Redirect Entry Runtime Load Parity Pre-Read/);
  assert.match(openspecFlow, /Parity invariant impact/);
  assert.match(crossRuntime, /Redirect Entry Parity Invariant/);
  assert.match(crossRuntime, /load-bearing invariant/);
  assert.match(crossRuntime, /convenience proxy/);
});
