import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";

test("rules-flow distinguishes proven consumer N/A from source selection", () => {
  const content = read(".devpro/agent-rules/rules-flow.md");
  const paragraph = content.split("\n").find(line => line.startsWith("consumer rules release validation"));
  assert.match(paragraph, /source repo[^\n]*ownership 無法驗證[^\n]*source tier selection/);
  assert.match(paragraph, /已證實 consumer[^\n]*非 rules tag base[^\n]*`N\/A`[^\n]*不得進入 source tier/);
  assert.doesNotMatch(paragraph, /source repo 或非 rules tag base 仍維持 source tier/);
});
