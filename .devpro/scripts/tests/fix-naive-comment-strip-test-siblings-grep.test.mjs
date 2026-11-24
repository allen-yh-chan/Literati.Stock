/**
 * Dual-polarity: five deferred siblings of fix-guard-scope-fidelity must use
 * lexical stripJsCommentSpans — not naive /\/\*[\s\S]*?\*\//g block strippers.
 */
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SIBLINGS = [
  ".devpro/scripts/tests/cost-budget.test.mjs",
  ".devpro/scripts/tests/run-test-suite.test.mjs",
  ".devpro/scripts/tests/prune-merged-local.test.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence.test.mjs",
];

// Matches source text `replace(/\/\*[\s\S]*?\*\//` or `replaceAll(/\/\*[\s\S]*?\*\//`
// (the trailing `\/` after `\*` must be present — a prior typo omitted one `\\` and never matched).
const NAIVE_BLOCK = /replace(?:All)?\(\s*\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//;
const IMPORT = /import\s*\{[^}]*\bstripJsCommentSpans\b[^}]*\}\s*from\s*["']\.\.\/lib\/js-comment-spans\.mjs["']/;

const read = (rel) => readFileSync(repoPath(rel), "utf8");

describe("fix-naive-comment-strip-test-siblings: positive anchors", () => {
  test("Scenario: Five deferred siblings import stripJsCommentSpans", () => {
    for (const rel of SIBLINGS) {
      const src = read(rel);
      assert.match(src, IMPORT, `${rel} must import stripJsCommentSpans`);
    }
  });

  test("Scenario: Cost-budget prose-only naming is not a code hit", () => {
    const src = read(".devpro/scripts/tests/cost-budget.test.mjs");
    assert.match(src, /D2 comment-strip teeth/);
    assert.match(src, /prose-only naming of PR_STICKY_REVIEW_ROUND_CAP/);
  });

  test("NAIVE_BLOCK self-proves against a fixture naive stripper string", () => {
    const fixture = 'source.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")';
    assert.equal(NAIVE_BLOCK.test(fixture), true, "NAIVE_BLOCK must hit a real naive stripper fixture");
    assert.equal(NAIVE_BLOCK.test('source.replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, "")'), true);
  });
});

describe("fix-naive-comment-strip-test-siblings: negative anchors", () => {
  test("must not restore naive block-comment replace strippers in the five siblings", () => {
    for (const rel of SIBLINGS) {
      assert.equal(
        NAIVE_BLOCK.test(read(rel)),
        false,
        `${rel} must not contain naive /\\/\\*[\\s\\S]*?\\*\\// replace stripper`,
      );
    }
  });
});
