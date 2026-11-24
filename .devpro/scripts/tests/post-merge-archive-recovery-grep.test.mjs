/**
 * post-merge-archive-recovery-grep.test.mjs
 *
 * Locks the Post-merge Archive Recovery procedure in openspec-step-1-to-9.md.
 * The recovery path must not rely on PR title-only lookup, and the recovery
 * branch must still follow anchor/worktree rules.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
const rulePath = path.join(
  REPO_ROOT,
  ".devpro/agent-rules/openspec-step-1-to-9.md",
);

const SECTION_HEADING = "### Post-merge Archive Recovery";

const REQUIRED = [
  "gh pr list --state merged --head",
  "openspec/changes/<name>/",
  "不得只靠 PR title 判斷",
  "git-branch-naming-and-anchor.md",
  "anchor",
  ".worktree/docs-archive-<name>-recovery",
  "chore/docs-archive-<name>-recovery",
  "分支/change name 一致",
  "不建立第二個 OpenSpec change",
];

const FORBIDDEN = [
  "gh pr list --state merged --search '\"<name>\" in:title'",
  "若查無 merged PR，回主流程",
  "chore/archive-post-merge-<name>",
  ".worktree/archive-post-merge-<name>",
];

const content = readFileSync(rulePath, "utf8");
const lines = content.split("\n");
const startLine = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
// End at next H2 (any ##), not a fixed heading — survives renames / inserts before Exit Criteria.
const endLine = lines.findIndex((l, i) => i > startLine && l.startsWith("## "));
const section =
  startLine === -1
    ? null
    : lines.slice(startLine, endLine === -1 ? undefined : endLine).join("\n");

test("Post-merge Archive Recovery section exists", () => {
  assert.ok(
    section,
    "Post-merge Archive Recovery section is missing from openspec-step-1-to-9.md",
  );
});

for (const phrase of REQUIRED) {
  test(`Post-merge Archive Recovery section requires "${phrase}"`, () => {
    assert.ok(
      section.includes(phrase),
      `Post-merge archive recovery guard missing "${phrase}"`,
    );
  });
}

for (const phrase of FORBIDDEN) {
  test(`Post-merge Archive Recovery section forbids "${phrase}"`, () => {
    assert.ok(
      !section.includes(phrase),
      `Post-merge archive recovery guard found stale unsafe wording "${phrase}"`,
    );
  });
}
