/**
 * Locks #2419 cross-model repeat-finding simplify-first pointer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CROSS = ".devpro/agent-rules/code-review-cross-model.md";
const COST = ".devpro/agent-rules/workflow-cost-controls.md";

test("Round Budget requires simplify-first after ≥2 same-class cross-model hits", () => {
  const content = readFileSync(repoPath(CROSS), "utf8");
  assert.match(content, /同函式同缺陷類 ≥2 輪/);
  assert.match(content, /先刪／簡化/);
  assert.match(content, /code-simplification\.md/);
  assert.match(content, /pre-implementation-over-design\.md/);
  assert.match(content, /trust factor/);
});

test("workflow-cost-controls points to Round Budget simplify-first without forking criteria", () => {
  const content = readFileSync(repoPath(COST), "utf8");
  assert.match(content, /Cross-model repeat-finding simplify-first/);
  assert.match(content, /code-review-cross-model\.md.*Round Budget/s);
  assert.match(content, /code-simplification\.md/);
});
