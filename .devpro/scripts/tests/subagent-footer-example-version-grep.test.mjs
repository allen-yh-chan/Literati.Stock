import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858: a hardcoded `Rules: v6.39.2` example next to the `v<AGENTS.md 版號>` template makes a
// subagent copy a stale rules version into its commit or gh body. The subagent footer section keeps
// only the placeholder template. (git-pr-template-and-merge.md keeps its copy-ready sample on purpose:
// #1237 requires it and rule-feedback-issues-grep.test.mjs locks it.)

const agentsDir = path.join(REPO_ROOT, ".claude/agents");
const withFooterSection = readdirSync(agentsDir)
  .filter((name) => /^dp-.*\.md$/.test(name))
  .map((name) => ({ name, text: readFileSync(path.join(agentsDir, name), "utf8") }))
  .filter(({ text }) => text.includes("## Footer 紀律"));

test("the subagents that carry a footer discipline section are the five known ones", () => {
  assert.deepEqual(
    withFooterSection.map(({ name }) => name),
    ["dp-analyst.md", "dp-architect.md", "dp-assistant.md", "dp-programmer.md", "dp-reviewer.md"],
  );
});

for (const { name, text } of withFooterSection) {
  const start = text.indexOf("## Footer 紀律");
  const rest = text.slice(start + "## Footer 紀律".length);
  const next = rest.search(/\n## /);
  const section = next === -1 ? rest : rest.slice(0, next);

  test(`${name}: footer section keeps the version placeholder template`, () => {
    assert.ok(section.includes("`Rules: v<AGENTS.md 版號> · Tool: <工具名稱> · Model: <model 簡稱>`"));
  });

  test(`${name}: footer section has no hardcoded rules version example`, () => {
    assert.doesNotMatch(section, /Rules: v\d+\.\d+\.\d+/);
  });
}
