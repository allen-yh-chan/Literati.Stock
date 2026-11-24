import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858: migration-style wording ("no longer", "replaces the old ...") describes a previous state
// that a fresh reader of the rule never saw, and the model reads it as an instruction about a
// history it cannot check. State the current rule directly. The facts stay: half-state revokes no
// authorization by itself, and the two old skill names are only mode aliases of rule-governance.

const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const lineWith = (text, needle) => text.split("\n").filter((line) => line.includes(needle));

test("workflow-cost-controls: half-state is stated as revoking no authorization, without 不再", () => {
  const text = read(".devpro/agent-rules/workflow-cost-controls.md");
  assert.equal(text.includes("不再撤銷"), false, "migration wording 不再撤銷 is back");
  const lines = lineWith(text, "Half-state（`lib/cost-budget.mjs`");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\*\*本身不撤銷任何授權\*\*：它由三個累計量推導，而總量量的是 change 有多大、不是有沒有在浪費。/);
  assert.match(lines[0], /現況用途為 \*\*audit／report only\*\*/);
});

test("rule-governance skill: the old skill names are described as mode aliases without replace narration", () => {
  const text = read(".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md");
  assert.equal(text.includes("取代舊的"), false, "replace-the-old narration is back");
  assert.equal(text.includes("不再是獨立"), false, "no-longer-independent narration is back");
  const lines = lineWith(text, "本 skill 是 rule corpus governance 的單一 user-invocable 入口");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`dp-rule-audit` 與 `dp-convergence-loop` 只是本 skill 的 mode alias（使用者語句出現時對應到對應 mode），不是獨立 skill。$/);
});
