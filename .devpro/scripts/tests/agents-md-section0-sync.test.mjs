import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const agentsPath = repoPath("AGENTS.md");
const aiAutonomyPath = repoPath(".devpro/agent-rules/ai-autonomy.md");

const EXPECTED_TOPICS = [
  /追溯/,
  /複雜/,
  /假設/,
  /委派/,
  /環境/,
  /repo scope/i,
  /bash cwd/i,
  /Think Before Coding/,
  /Usability-First/,
  /一致性掃描|Consistency Sweep/,
];

async function read(filePath) {
  return fs.readFile(filePath, "utf8");
}

function extractChecklist(markdown, fileLabel) {
  const match = markdown.match(/### 動手前十句自檢[^\n]*\n\n([\s\S]*?)\n\n十題任一/);
  assert.ok(match, `${fileLabel}: missing 動手前十句自檢 block`);

  const items = [];
  for (const line of match[1].split("\n")) {
    const item = line.match(/^(\d+)\.\s+\*\*([^*]+)\*\*/);
    if (!item) continue;
    items.push({ number: Number(item[1]), title: item[2].trim(), line });
  }
  return items;
}

function assertTenOrderedTopics(items, fileLabel) {
  assert.equal(items.length, 10, `${fileLabel}: checklist item count must be 10`);
  assert.deepEqual(
    items.map((item) => item.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    `${fileLabel}: checklist numbering must stay contiguous`
  );

  for (const [index, pattern] of EXPECTED_TOPICS.entries()) {
    assert.match(
      items[index].title,
      pattern,
      `${fileLabel}: item ${index + 1} should match ${pattern}`
    );
  }
}

describe("AGENTS.md §0 sync with ai-autonomy.md", () => {
  it("keeps the two self-check lists at 10 items with matching topic order", async () => {
    const [agents, aiAutonomy] = await Promise.all([read(agentsPath), read(aiAutonomyPath)]);
    const agentsItems = extractChecklist(agents, "AGENTS.md");
    const aiAutonomyItems = extractChecklist(aiAutonomy, "ai-autonomy.md");

    assertTenOrderedTopics(agentsItems, "AGENTS.md");
    assertTenOrderedTopics(aiAutonomyItems, "ai-autonomy.md");
    assert.equal(
      agentsItems.length,
      aiAutonomyItems.length,
      "AGENTS.md §0 summary and ai-autonomy.md detail must have the same count"
    );
  });

  it("keeps Think Before Coding as an outward, user-visible action", async () => {
    const [agents, aiAutonomy] = await Promise.all([read(agentsPath), read(aiAutonomyPath)]);

    assert.match(agents, /Think Before Coding/, "AGENTS.md must keep Think Before Coding visible");
    assert.match(aiAutonomy, /向使用者展示/, "ai-autonomy.md must say the action is shown to the user");
    assert.match(aiAutonomy, /外顯/, "ai-autonomy.md must keep the explicit outward-action wording");
  });
});
