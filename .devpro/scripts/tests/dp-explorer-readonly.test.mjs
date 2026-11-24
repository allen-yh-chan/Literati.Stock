import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoPath } from "./lib/repo-root.mjs";

const agentPath = repoPath(".claude/agents/dp-explorer.md");
const content = readFileSync(agentPath, "utf8");
const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);

test("dp-explorer frontmatter exists", () => {
  assert.ok(frontmatter, "dp-explorer.md must start with YAML frontmatter");
});

test("dp-explorer uses haiku model", () => {
  assert.match(frontmatter[1], /^model:\s*haiku$/m);
});

test("dp-explorer tools are read-only", () => {
  const tools = [...frontmatter[1].matchAll(/^\s*-\s*([A-Za-z0-9]+)\s*$/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(tools, ["Read", "Grep", "Glob"]);

  const forbidden = [
    "Bash",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Agent",
    "TaskCreate",
    "TaskUpdate",
  ];
  for (const tool of forbidden) {
    assert.ok(!tools.includes(tool), `dp-explorer tools must not include ${tool}`);
  }
});
