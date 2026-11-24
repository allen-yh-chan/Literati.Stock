// Issue #3528: the always-loaded AGENTS.md names the fixed Recap destination,
// so a TL that has not loaded session-recap.md yet does not guess the business
// repo and offer it to the user as a location option.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";

test("AGENTS.md §9 names the fixed Recap Discussion repo and asks no location question", () => {
  const content = read("AGENTS.md");
  const start = content.indexOf("## 9. Session 收尾 Gate");
  assert.notEqual(start, -1);
  const section = content.slice(start);
  assert.match(section, /Recap→`devpro-tw\/devpro-agent-rules` Discussions（位置固定，不列位置選項）/);
});

test("session-recap.md rejects asking the user which repo to post the Recap to", () => {
  const content = read(".devpro/agent-rules/session-recap.md");
  const start = content.indexOf("## Common Rationalizations");
  assert.notEqual(start, -1);
  const table = content.slice(start, content.indexOf("\n## ", start + 5));
  const rows = table.split("\n").filter((line) => line.startsWith("| 「先問使用者要發到哪個 repo」"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /位置固定在 `devpro-tw\/devpro-agent-rules`/);
  assert.match(rows[0], /不得列成選項/);
  assert.match(rows[0], /要問的只有去重與規範改進 issue 的決定/);
});
