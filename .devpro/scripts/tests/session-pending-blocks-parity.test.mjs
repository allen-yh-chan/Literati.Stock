/**
 * Parity lock for the two exported session-pending block parsers.
 *
 * `notes/session-pending.md` has exactly three consumers, reaching the shared
 * library through six call sites (verified by grep, no other path exists):
 *
 *   - `session-pending-claim.mjs:214,237,324`       -> parseBlocks
 *   - `hooks/pre-tool-gate.mjs:7014,7293`           -> parseListItemBlocks
 *   - `hooks/session-pending-cleanup-check.mjs:120` -> parseListItemBlocks
 *
 * Recounted at r6. The original header said four sites at :193,216 / :7013,7157,
 * which were the values before T5 added the `release` verb (a third parseBlocks
 * caller) and T3 edited Gate N. The load-bearing claim is unchanged and was
 * re-verified rather than assumed: no consumer bypasses these two functions, and
 * the grep still finds exactly three consumer files and no fourth path. Line
 * numbers here are provenance for that grep, not assertions -- nothing in this
 * file depends on them, which is also why they went stale unnoticed.
 *
 * Because every consumer routes through one of these two functions, agreement
 * between the two is sufficient for the three consumers to agree. The shapes
 * below all co-exist in the live file, which is precisely the case no fixture
 * covered before: `session-pending-claim.test.mjs` had only a pure-legacy
 * fixture and a pure-H2 fixture, so a file mixing them was never exercised and
 * the two parsers could have drifted unnoticed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseBlocks,
  parseListItemBlocks,
} from "../lib/session-pending-blocks.mjs";

/**
 * One fixture carrying every shape that co-exists in the live file:
 *  - a bare top-level bullet BEFORE any heading (ungoverned legacy item)
 *  - a `## ` H2 section whose body is flat field lines (governed, absorbed)
 *  - a `- ` bullet INSIDE that section (governed, absorbed — must NOT count)
 *  - a non-bullet prose line inside the section (must not split it)
 *  - a mid-document `# ` H1 that closes the section
 *  - a bare top-level bullet AFTER the H1 (ungoverned again)
 */
const MIXED = [
  "# Session Pending",
  "",
  "- **【Ungoverned legacy item】**",
  "  - observed gap: one",
  "  - 缺輸入: 無。",
  "",
  "## 1. Governed heading pending",
  "",
  "Body prose that must not split the section.",
  "- [ ] 設計缺口：this is evidence inside the pending, not a pending of its own",
  "缺輸入: 無。",
  "trigger: tests",
  "carrier: new change",
  "",
  "## 2. Second governed pending",
  "",
  "缺輸入: need decision",
  "",
  "# Closing H1",
  "",
  "* **【Ungoverned after H1】**",
  "  - 缺輸入: 無。",
  "",
].join("\n");

function openersFromListItemBlocks(text) {
  return parseListItemBlocks(text).map((block) => block[0]);
}

function openersFromParseBlocks(text) {
  return parseBlocks(text).blocks.map((block) => block.lines[0]);
}

test("both parsers agree on block openers for a mixed-shape file", () => {
  assert.deepEqual(
    openersFromParseBlocks(MIXED),
    openersFromListItemBlocks(MIXED),
    "claim (parseBlocks) and Gate N / cleanup (parseListItemBlocks) must cut the same blocks",
  );
});

test("mixed-shape file resolves to exactly the four real items", () => {
  assert.deepEqual(openersFromListItemBlocks(MIXED), [
    "- **【Ungoverned legacy item】**",
    "## 1. Governed heading pending",
    "## 2. Second governed pending",
    "* **【Ungoverned after H1】**",
  ]);
});

test("a `- ` line governed by a `## ` section is absorbed, never its own block", () => {
  const openers = openersFromListItemBlocks(MIXED);
  assert.equal(
    openers.some((line) => line.startsWith("- [ ] 設計缺口：")),
    false,
    "evidence bullets inside a pending must not be counted as separate items",
  );
  const governed = parseListItemBlocks(MIXED).find(
    (block) => block[0] === "## 1. Governed heading pending",
  );
  assert.ok(
    governed.some((line) => line.startsWith("- [ ] 設計缺口：")),
    "the evidence bullet must live inside its governing section's block",
  );
  assert.ok(
    governed.includes("Body prose that must not split the section."),
    "a non-bullet prose line must not split the section",
  );
});

test("a mid-document `# ` H1 closes the section so the next bullet starts fresh", () => {
  const blocks = parseListItemBlocks(MIXED);
  const last = blocks[blocks.length - 1];
  assert.equal(last[0], "* **【Ungoverned after H1】**");
  assert.equal(
    last.some((line) => line.startsWith("## ")),
    false,
    "the trailing item must not have absorbed the preceding heading section",
  );
});

test("parseBlocks line ranges stay inside the file and do not overlap", () => {
  const { lines, blocks } = parseBlocks(MIXED);
  let previousEnd = 0;
  for (const block of blocks) {
    assert.ok(block.start >= previousEnd, `block at ${block.start} overlaps previous`);
    assert.ok(block.end > block.start, "block end must be after start");
    assert.ok(block.end <= lines.length, "block end must stay within the file");
    previousEnd = block.end;
  }
});
