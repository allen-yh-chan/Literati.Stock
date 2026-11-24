/**
 * Gate NS — Session-Pending Column-0 Bullet Shape Gate.
 *
 * Contract: `openspec/changes/fix-session-pending-item-parse/specs/
 * pre-tool-mechanical-gates/spec.md` -> "Session-Pending Column-0 Bullet Shape
 * Gate" (5 scenarios).
 *
 * Namespace imports rather than named imports on purpose: while the gate is
 * unimplemented a named import would be a module link error that fails the
 * whole file at load, which says nothing about which behaviour is missing.
 * Through the namespace each missing piece fails as its own assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as blocks from "../lib/session-pending-blocks.mjs";
import * as gate from "../hooks/pre-tool-gate.mjs";

/** In-scope: has adopted the H2 convention. */
const IN_SCOPE_CLEAN = [
  "# Session Pending",
  "",
  "## 1. A pending",
  "",
  "  - 缺輸入: 無。",
  "  - trigger: tests",
  "  - carrier: new change",
  "",
].join("\n");

/** In-scope, but carrying two column-0 bullets (lines 5 and 8, 1-based). */
const IN_SCOPE_VIOLATING = [
  "# Session Pending", // 1
  "", // 2
  "## 1. A pending", // 3
  "", // 4
  "- [ ] column-0 bullet that should have been indented", // 5
  "  - 缺輸入: 無。", // 6
  "", // 7
  "* another column-0 bullet", // 8
  "", // 9
].join("\n");

/** Out of scope: zero `## ` heading lines anywhere. */
const LEGACY_ONLY = [
  "# Session Pending",
  "",
  "- **【Legacy item】**",
  "  - 缺輸入: 無。",
  "",
  "* **【Another legacy item】**",
  "  - 缺輸入: 無。",
  "",
].join("\n");

const checker = () => blocks.findSessionPendingShapeViolations;
const gateNs = () => gate.checkSessionPendingShape;

test("the shared library exports a whole-file shape checker", () => {
  assert.equal(
    typeof checker(),
    "function",
    "session-pending-blocks.mjs must export findSessionPendingShapeViolations",
  );
});

test("checker reports 1-based line numbers of every column-0 bullet in scope", () => {
  assert.deepEqual(checker()(IN_SCOPE_VIOLATING), [5, 8]);
  assert.deepEqual(checker()(IN_SCOPE_CLEAN), []);
});

test("checker reports nothing when the content carries zero `## ` headings", () => {
  assert.deepEqual(
    checker()(LEGACY_ONLY),
    [],
    "a consumer repo's legacy-only file must never be in scope",
  );
});

test("Gate NS is exported for the hook dispatch", () => {
  assert.equal(
    typeof gateNs(),
    "function",
    "pre-tool-gate.mjs must export checkSessionPendingShape",
  );
});

test("Write introducing a column-0 bullet into an H2-adopted file blocks with line numbers", () => {
  const result = gateNs()({
    toolName: "Write",
    filePath: "notes/session-pending.md",
    toolInput: { content: IN_SCOPE_VIOLATING },
    baseCwd: "/nowhere",
    readFile: () => null,
  });
  assert.ok(result, "an introduced column-0 bullet must block");
  assert.equal(result.block, true);
  assert.match(result.reason, /\b5\b/, "message must name line 5");
  assert.match(result.reason, /\b8\b/, "message must name line 8");
  assert.match(
    result.reason,
    /縮排|indent/,
    "message must name the clearing action (indent)",
  );
  assert.match(
    result.reason,
    /## /,
    "message must name promotion to a `## ` heading as the other clearing action",
  );
});

test("a legacy-only file never makes the gate fire", () => {
  const result = gateNs()({
    toolName: "Write",
    filePath: "notes/session-pending.md",
    toolInput: { content: LEGACY_ONLY },
    baseCwd: "/nowhere",
    readFile: () => null,
  });
  assert.equal(result, null);
});

test("pre-existing violations alone do not block", () => {
  const result = gateNs()({
    toolName: "Edit",
    filePath: "notes/session-pending.md",
    toolInput: {
      old_string: "## 1. A pending",
      new_string: "## 1. A renamed pending",
    },
    baseCwd: "/nowhere",
    // Prior content already carries the two column-0 bullets; the payload
    // introduces none, so the gate must stay silent — blocking here would
    // leave the file editable only through the tool that just blocked it.
    readFile: () => IN_SCOPE_VIOLATING,
  });
  assert.equal(result, null);
});

test("an Edit that introduces a new column-0 bullet does block", () => {
  const result = gateNs()({
    toolName: "Edit",
    filePath: "notes/session-pending.md",
    toolInput: {
      old_string: "  - carrier: new change",
      new_string: "  - carrier: new change\n- [ ] freshly introduced column-0 bullet",
    },
    baseCwd: "/nowhere",
    readFile: () => IN_SCOPE_CLEAN,
  });
  assert.ok(result, "a newly introduced column-0 bullet must block");
  assert.equal(result.block, true);
  // Was /freshly introduced|8|\d/ — the `\d` alternative matched any reason
  // containing a digit, and the reason always names a line number, so the
  // assertion could never fail (r1 finding F-SPI-05). Bind the line number.
  assert.match(result.reason, /\b8\b/);
});

test("writes targeting another file fail open", () => {
  const result = gateNs()({
    toolName: "Write",
    filePath: "notes/other.md",
    toolInput: { content: IN_SCOPE_VIOLATING },
    baseCwd: "/nowhere",
    readFile: () => null,
  });
  assert.equal(result, null);
});

test("unparseable payloads fail open without throwing", () => {
  for (const toolInput of [null, undefined, {}, { content: 42 }, { edits: "nope" }]) {
    let result;
    assert.doesNotThrow(() => {
      result = gateNs()({
        toolName: "Write",
        filePath: "notes/session-pending.md",
        toolInput,
        baseCwd: "/nowhere",
        readFile: () => {
          throw new Error("unreadable");
        },
      });
    }, `payload ${JSON.stringify(toolInput)} must not throw`);
    assert.equal(result, null);
  }
});

/*
 * MultiEdit coverage. Gate NS simulates only the entries carrying an
 * `old_string` baseline; entries without one cannot be placed into prior
 * content, so before r3 finding F-SPI-16 their `new_string` was dropped and a
 * bullet introduced through such an entry passed unseen. Gate N in the same
 * file always scanned them in a second pass. These two lock the mirrored
 * behaviour from both sides: the addition is scanned, and scanning it does not
 * start blocking payloads that introduce nothing.
 */

test("a MultiEdit whose baseline-less entry introduces a column-0 bullet does block", () => {
  const result = gateNs()({
    toolName: "MultiEdit",
    filePath: "notes/session-pending.md",
    toolInput: {
      edits: [
        // Reconstructable: rewrites a heading in place, introduces nothing.
        { old_string: "## 1. A pending", new_string: "## 1. A renamed pending" },
        // No baseline. Its new_string is the only carrier of the violation.
        { old_string: "", new_string: "- [ ] appended column-0 bullet" },
      ],
    },
    baseCwd: "/nowhere",
    readFile: () => IN_SCOPE_CLEAN,
  });
  assert.ok(result, "the baseline-less entry's new_string must still be scanned");
  assert.equal(result.block, true);
  // IN_SCOPE_CLEAN is 8 lines; the appended entry lands on line 9. Bound to
  // that number rather than to any digit, per r1 finding F-SPI-05.
  assert.match(result.reason, /新引入 1 行/);
  assert.match(result.reason, /命中行號[^\n]*：9$/m);
});

test("a MultiEdit whose baseline-less entry introduces no bullet stays silent", () => {
  const result = gateNs()({
    toolName: "MultiEdit",
    filePath: "notes/session-pending.md",
    toolInput: {
      edits: [
        { old_string: "## 1. A pending", new_string: "## 1. A renamed pending" },
        { old_string: "", new_string: "  - trigger: still indented" },
      ],
    },
    baseCwd: "/nowhere",
    readFile: () => IN_SCOPE_CLEAN,
  });
  assert.equal(result, null);
});
