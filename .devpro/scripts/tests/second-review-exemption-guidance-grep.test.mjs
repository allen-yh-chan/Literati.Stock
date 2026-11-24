import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";

test("second-opinion dispatch skips only exempt PRs", () => {
  const content = read(".devpro/agent-rules/model-delegation-delegation-rules.md");
  const rows = content.split("\n").filter(line => line.startsWith("- `devpro:pre-pr` Step 5.5"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /每次；豁免才跳過[^\n]*code-review-cross-model\.md/);
  assert.doesNotMatch(rows[0], /非豁免才跳過/);
});
