import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858: the frontend theming / i18n rule carried review-round and finding-ID tags ("round 22／F-page1",
// "F-W10", "round 15/F-W30", ...) on the MUST clauses. They name the review that produced the clause,
// not the mechanism, so a reader cannot tell whether the clause still applies and a model copies the
// tags into new text. The clauses themselves are anchored in web-theme-locale-probe-grep.test.mjs.

const text = readFileSync(path.join(REPO_ROOT, ".devpro/agent-rules/frontend-theming-and-i18n.md"), "utf8");
const lines = text.split("\n");

test("frontend-theming-and-i18n.md carries no review-round or finding-ID tag", () => {
  const hits = lines
    .map((line, i) => ({ n: i + 1, found: line.match(/round ?\d+|F-W\d+|F-page\d+|W1／/g) }))
    .filter(({ found }) => found)
    .map(({ n, found }) => `${n}: ${found.join(", ")}`);
  assert.deepEqual(hits, [], `review-round tags are back: ${hits.join(" | ")}`);
});

test("the read-side clause points at the write-side clause by name, not by a line number", () => {
  const readSide = lines.filter((line) => line.startsWith("**讀取端 fail-closed**："));
  assert.equal(readSide.length, 1);
  assert.equal(/第 \d+ 行/.test(readSide[0]), false, "a line-number cross reference is back");
  assert.match(readSide[0], /（上方「Fail-closed 補充條款」，寫入端）互補、獨立生效的讀取端防線/);
});
