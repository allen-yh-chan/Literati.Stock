import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";



test("README routes rigor bottom-line details to rules-rigor-level.md", () => {
  const readme = read("README.md");
  const rigor = read(".devpro/agent-rules/rules-rigor-level.md");

  assert.match(readme, /4 條底線、`off` caveat、SQL 拼接 honesty statement/);
  assert.match(readme, /rules-rigor-level\.md.*SSOT/);
  assert.doesNotMatch(readme, /`off` 仍保 4 條底線：禁直推 main/);
  assert.match(rigor, /off 下 SQL 拼接無 hook 防護/);
  assert.match(rigor, /底線檢查（off 也不可 no-op）/);
});

test("README routes exact pre-tool gate inventory to script, spec, and tests", () => {
  const readme = read("README.md");
  const hook = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
  const spec = read("openspec/specs/pre-tool-mechanical-gates/spec.md");
  const hookTest = read(".devpro/scripts/tests/hook-pre-tool-gate.test.mjs");

  assert.match(readme, /exact active\/retired gate inventory/);
  assert.match(readme, /pre-tool-mechanical-gates\/spec\.md/);
  assert.match(readme, /hook-pre-tool-gate\.test\.mjs/);
  assert.doesNotMatch(readme, /Gate groups：\(1\) Protected-branch/);
  assert.match(hook, /const BASH_BLOCKING_GATES = defineGateInventory/);
  assert.match(spec, /executable gate inventory/);
  assert.match(hookTest, /Gate inventory: active blocking gates declare bucket\/evidence\/risk/);
});

test("AGENTS routes Recap and RULE-FEEDBACK lifecycle to canonical leaves", () => {
  const agents = read("AGENTS.md");
  const recap = read(".devpro/agent-rules/session-recap.md");
  const evolution = read(".devpro/agent-rules/rule-self-evolution.md");

  assert.match(agents, /session-recap\.md/);
  assert.match(agents, /rule-self-evolution\.md/);
  assert.match(agents, /session-pending 是待追蹤缺口暫存/);
  assert.doesNotMatch(agents, /G4\/5不重標/);
  assert.match(recap, /session-pending 記錄用途/);
  assert.match(recap, /規範改進發落必須追蹤/);
  assert.match(evolution, /6-Step Flow/);
});
