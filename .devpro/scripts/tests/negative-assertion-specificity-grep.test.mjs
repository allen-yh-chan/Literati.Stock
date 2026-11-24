/**
 * Locks Negative Assertion Specificity anchors in testing-and-qa + checklist §4.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const QA = ".devpro/agent-rules/testing-and-qa.md";
const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";

function sectionAfter(content, heading) {
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `missing ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n### |\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

function lineContaining(slice, token) {
  const line = slice.split("\n").find((entry) => entry.includes(token));
  assert.ok(line, `missing line containing ${token}`);
  return line;
}

test("testing-and-qa defines Negative Assertion Specificity with intended failure class", () => {
  const body = readFileSync(repoPath(QA), "utf8");
  const slice = sectionAfter(body, "### Negative Assertion Specificity");
  assert.match(slice, /intended failure class/);
  assert.match(slice, /change-base/);
  assert.equal(
    (body.match(/^### Negative Assertion Specificity$/gm) || []).length,
    1,
    "exactly one Negative Assertion Specificity heading",
  );
  // Polarity compound: forbid + OR-union on the same physical line (rule-anchor-guard-strength).
  const orUnionLine = lineContaining(slice, "OR-union");
  assert.match(orUnionLine, /禁止/);
  assert.match(orUnionLine, /OR-union/);
});

test("code-review-checklist §4 has Negative Assertion Specificity sub-check", () => {
  const body = readFileSync(repoPath(CHECKLIST), "utf8");
  const slice = sectionAfter(body, "### 4. 測試充分性");
  assert.match(slice, /intended failure class/);
  assert.match(slice, /testing-and-qa\.md/);
  // Severity Important must bind the NAS sub-check line (not adjacent UI-smoke Important).
  const nasLine = lineContaining(slice, "Negative Assertion Specificity sub-check");
  assert.match(nasLine, /Negative Assertion Specificity sub-check/);
  assert.match(nasLine, /\*\*Important\*\*/);
});
