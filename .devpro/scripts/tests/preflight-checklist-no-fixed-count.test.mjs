import { it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

it("preflight-checklist uses canonical checklist wording, not fixed total count prose", async () => {
  const content = await fs.readFile(
    repoPath(".devpro/agent-rules/preflight-checklist.md"),
    "utf8"
  );

  assert.doesNotMatch(content, /9 點結構性檢查/);
  assert.doesNotMatch(content, /以下 9 點/);
  assert.doesNotMatch(content, /9 點全部通過/);
  assert.match(content, /整份 checklist/);
  assert.match(content, /checklist 全部通過/);
});
