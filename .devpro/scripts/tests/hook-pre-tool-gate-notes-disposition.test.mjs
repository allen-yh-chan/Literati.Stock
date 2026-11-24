// Tests for Gate N (Notes Disposition Advisory) — notes/session-pending.md
// disposition field completeness advisory.
//
// Scope: non-blocking advisory on Edit/Write/MultiEdit targeting
// notes/session-pending.md when any scanned pending block is missing
// one or more of the three required disposition fields:
//   缺輸入: / trigger: / carrier:
//
// Detection unit (heading-aware): a `## ` heading section whose body is a flat
// (non-indented) list of `- ` field lines is ONE pending block — its sibling
// `- ` lines are that pending's fields, not separate entries. A `- ` item NOT
// under such a heading section forms its own top-level block (`- ` line +
// indented continuation lines). Fields count as present only when an exact
// token starts a declaration line after optional horizontal whitespace and at
// most one optional `- ` bullet; prose and compact inline mentions do not count.
//
// Scan scope:
//   Edit/MultiEdit — simulated final file content when old_string is available
//   Edit/MultiEdit fallback — new_string when no old_string baseline is available
//   Write — entire content (conservative; no old baseline)
//
// Fail-open: deletion-only edits, other files, parse failures → silent.

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isSessionPendingPath,
  parseListItemBlocks,
  missingDispositionFields,
  scanDispositionInText,
  checkNotesDisposition,
  DISPOSITION_FIELDS,
  evaluatePreToolUsePayload,
  PASS_THROUGH,
} from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const SESSION_PENDING = "notes/session-pending.md";

function deterministicPriorReader(priorContent) {
  return (resolvedPath) => {
    assert.ok(
      path.normalize(resolvedPath).endsWith(path.normalize(SESSION_PENDING)),
      "fixture reader must receive the resolved session-pending target"
    );
    return priorContent;
  };
}

describe("Gate N — Notes Disposition Advisory", () => {
  describe("isSessionPendingPath", () => {
    it("matches notes/session-pending.md (relative)", () => {
      assert.ok(isSessionPendingPath("notes/session-pending.md"));
    });

    it("matches absolute path ending in notes/session-pending.md", () => {
      assert.ok(isSessionPendingPath("/Users/user/repo/notes/session-pending.md"));
      assert.ok(isSessionPendingPath("/home/user/myrepo/notes/session-pending.md"));
    });

    it("does NOT match notes/other.md", () => {
      assert.ok(!isSessionPendingPath("notes/other.md"));
    });

    it("does NOT match session-pending.md without notes/ prefix", () => {
      assert.ok(!isSessionPendingPath("session-pending.md"));
    });

    it("does NOT match a path that merely contains notes/session-pending.md as a substring (must end with it)", () => {
      // e.g. draft-notes/session-pending.md should not match
      assert.ok(!isSessionPendingPath("draft-notes/session-pending.md"));
    });
  });

  describe("parseListItemBlocks", () => {
    it("parses a single top-level item with no continuation", () => {
      const blocks = parseListItemBlocks("- item one\n");
      assert.equal(blocks.length, 1);
      assert.deepEqual(blocks[0], ["- item one"]);
    });

    it("parses indented continuation lines as part of the same block", () => {
      const text = "- item one\n  continuation line\n  another line\n";
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].length, 3);
      assert.equal(blocks[0][0], "- item one");
      assert.equal(blocks[0][1], "  continuation line");
    });

    it("parses two separate top-level items as two blocks", () => {
      const text = "- item one\n  cont\n- item two\n";
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[0][0], "- item one");
      assert.equal(blocks[1][0], "- item two");
    });

    it("non-indented non-list line closes a block", () => {
      const text = "- item one\n  cont\nsome header\n- item two\n";
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 2);
    });

    it("returns empty array for empty or non-list text", () => {
      assert.deepEqual(parseListItemBlocks(""), []);
      assert.deepEqual(parseListItemBlocks("# heading\n\nsome text\n"), []);
    });

    it("returns empty array for null/undefined", () => {
      assert.deepEqual(parseListItemBlocks(null), []);
      assert.deepEqual(parseListItemBlocks(undefined), []);
    });

    // C1 — blank line between header and indented fields must NOT split block
    it("C1: loose-list blank line between header and indented fields → single block containing all lines", () => {
      const text = "- 標頭\n\n  缺輸入: 無\n  trigger: X\n  carrier: Y";
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 1, "blank line must not split a loose-list entry into two blocks");
      const joined = blocks[0].join("\n");
      assert.ok(joined.includes("缺輸入:"), "block must include 缺輸入:");
      assert.ok(joined.includes("trigger:"), "block must include trigger:");
      assert.ok(joined.includes("carrier:"), "block must include carrier:");
    });

    // C3 — regression guard: two complete entries separated by blank line → 2 blocks
    it("C3: two complete entries separated by blank line → blocks.length === 2", () => {
      const text = [
        "- entry one",
        "  缺輸入: A",
        "  trigger: B",
        "  carrier: C",
        "",
        "- entry two",
        "  缺輸入: D",
        "  trigger: E",
        "  carrier: F",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 2, "two entries separated by blank line must produce two blocks");
      assert.deepEqual(missingDispositionFields(blocks[0]), [], "entry one must have no missing fields");
      assert.deepEqual(missingDispositionFields(blocks[1]), [], "entry two must have no missing fields");
    });

    // C4 — TRUE positive guard: incomplete entry followed by blank line then prose
    it("C4: incomplete entry + blank line + prose → block closed at blank/prose boundary, prose excluded, missing field still reported", () => {
      const text = "- 標頭\n  trigger: X\n  carrier: Y\n\n這是非縮排 prose";
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 1, "must produce exactly one block (prose is not a list item)");
      const joined = blocks[0].join("\n");
      assert.ok(!joined.includes("這是非縮排 prose"), "prose line must NOT be absorbed into the block");
      const missing = missingDispositionFields(blocks[0]);
      assert.ok(missing.includes("缺輸入:"), "缺輸入: must still be reported as missing (TRUE positive)");
    });

    // C5 — EOF guard: complete entry with trailing blank lines → single block, no phantom
    it("C5: complete entry with trailing blank lines → blocks.length === 1, no missing fields", () => {
      const text = [
        "- topic",
        "  缺輸入: data",
        "  trigger: when ready",
        "  carrier: @me",
        "",
        "",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 1, "trailing blank lines must not create phantom blocks");
      assert.deepEqual(missingDispositionFields(blocks[0]), [], "no missing fields for complete entry");
    });

    // C6 — CRLF guard: split("\n") leaves a trailing \r on blank lines; the
    // blank-line branch relies on line.trim()==="" (not line.length===0) to
    // still classify a "\r"-only line as blank. Pin this so a future change
    // back to length===0 fails loudly instead of silently re-splitting.
    it("C6: CRLF loose-list (blank line is \"\\r\") → single block, fields present", () => {
      const text = "- 標頭\r\n\r\n  缺輸入: 無\r\n  trigger: X\r\n  carrier: Y";
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 1, "CRLF blank line (\\r) must not split a loose-list entry");
      assert.deepEqual(missingDispositionFields(blocks[0]), [], "all three fields present across CRLF continuation lines");
    });

    // ── Heading-boundary contract (fix-gate-n-heading-boundary) ──────────────
    // Real session-pending.md structure is `## heading = one pending`, whose
    // body is a FLAT list of non-indented `- 欄位：值` field lines. The legacy
    // parser opened a new block on every `- ` line, so one pending section was
    // wrongly split into N single-field blocks (28-hit false positive). Under a
    // `## ` heading with flat field bullets, the whole section is ONE block.

    // H1 — heading section with flat field bullets → exactly one block
    it("H1: `## ` heading + flat `- ` field bullets → single pending block", () => {
      const text = [
        "# Session Pending",
        "",
        "## 某待追蹤缺口",
        "",
        "- 使用者意圖：修正某行為。",
        "- source／target：source 是本 session。",
        "- 缺輸入: 具名輸入",
        "- trigger: 使用者啟動時",
        "- carrier: TL",
        "- blocker／下一步：先確認方向。",
        "- owner：TL。",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        1,
        "a heading section whose body is flat `- ` field bullets must be ONE block, not one per field line"
      );
      assert.deepEqual(
        missingDispositionFields(blocks[0]),
        [],
        "all three fields present across the section's flat field bullets"
      );
    });

    // H2 — heading section missing one field → still ONE block, reports once
    it("H2: heading section missing a field → one block reporting only the missing field", () => {
      const text = [
        "## 某待追蹤缺口",
        "",
        "- 使用者意圖：修正某行為。",
        "- 缺輸入: 具名輸入",
        "- carrier: TL",
        "- owner：TL。",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 1, "incomplete heading section is still ONE block, not one per field line");
      assert.deepEqual(
        missingDispositionFields(blocks[0]),
        ["trigger:"],
        "only the genuinely missing field is reported, once for the whole section"
      );
    });

    // H3 — two heading sections → two blocks (section boundary is the heading)
    it("H3: two `## ` heading sections → two blocks", () => {
      const text = [
        "## 缺口甲",
        "- 缺輸入: A",
        "- trigger: B",
        "- carrier: C",
        "",
        "## 缺口乙",
        "- 缺輸入: D",
        "- trigger: E",
        "- carrier: F",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(blocks.length, 2, "each `## ` heading section is its own pending block");
      assert.deepEqual(missingDispositionFields(blocks[0]), [], "section 甲 complete");
      assert.deepEqual(missingDispositionFields(blocks[1]), [], "section 乙 complete");
    });

    // H4 — LEGACY GUARD: bare top-level `- ` items with NO heading stay independent
    it("H4: bare top-level `- ` items without a heading remain independent blocks", () => {
      const text = [
        "- 待辦甲",
        "- 待辦乙",
        "- 待辦丙",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        3,
        "bare top-level items with no governing heading must each form their own block (legacy contract)"
      );
    });

    // H5 — a prose line inside a heading section does NOT split the section. A
    // `## ` pending runs until the next `## ` heading (or EOF); an explanatory
    // non-bullet line mid-section is part of that pending, so field bullets after
    // it stay in the SAME block (not each re-splitting into single-field blocks).
    it("H5: prose line inside a heading section keeps it ONE block", () => {
      const text = [
        "## 某待追蹤缺口",
        "",
        "- 使用者意圖：修正某行為。",
        "說明：以下為欄位。",
        "- 缺輸入: 具名輸入",
        "- trigger: 使用者啟動時",
        "- carrier: TL",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        1,
        "a prose line mid-section must not split the heading section; field bullets after it stay in the same block"
      );
      assert.deepEqual(
        missingDispositionFields(blocks[0]),
        [],
        "all three fields still resolve within the single section block despite the prose line"
      );
    });

    // H6 — LEGACY GUARD: with NO governing heading, a prose line is still a block
    // boundary (the loose-list / bare-item contract). This pins that the H5 fix
    // only relaxes prose handling INSIDE a heading section, not for bare items.
    it("H6: prose line without a heading still closes a bare block (legacy)", () => {
      const text = [
        "- 待辦甲",
        "散文行。",
        "- 待辦乙",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        2,
        "with no heading, a prose line closes the current bare block; the next `- ` opens a new one"
      );
    });

    // H7 — a `## ` heading that declares a pending but carries NO field bullets
    // must still form ONE block, so the pending is scanned (and reported as
    // missing all three fields) rather than silently skipped. (Before this, a
    // fieldless heading opened `inHeadingSection` but never created a block, so
    // `## incomplete pending` yielded zero blocks and Gate N stayed silent for a
    // genuinely-undocumented deferral — a false negative.)
    it("H7: heading-only pending (no field bullets) is still ONE block, reported as incomplete", () => {
      const text = "## incomplete pending";
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        1,
        "a `## ` heading with no field bullets must still form one pending block, not be silently skipped"
      );
      assert.deepEqual(
        missingDispositionFields(blocks[0]).sort(),
        ["carrier:", "trigger:", "缺輸入:"].sort(),
        "a fieldless heading pending must report all three disposition fields as missing"
      );
    });

    // H8 — an H1 heading appearing AFTER a section has opened closes that section
    // (resets heading mode), so a `- ` item after the H1 starts a fresh pending
    // instead of merging into the prior complete section. (Before this, only
    // `## `+ closed a section; a mid-document `# New area` left `inHeadingSection`
    // active, so `# New area` was absorbed as prose and the following incomplete
    // item joined the prior COMPLETE block — masking its missing fields.) The
    // document's leading H1 title (before any pending content) still produces
    // nothing, preserving the `# heading\n\nsome text` → [] guard.
    it("H8: a mid-document H1 closes the prior section so a later incomplete item is its own block", () => {
      const text = [
        "## complete section",
        "- 缺輸入: A",
        "- trigger: B",
        "- carrier: C",
        "",
        "# New area",
        "- genuinely incomplete pending",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        2,
        "a mid-document H1 must close the prior complete section so the later item forms its own block"
      );
      assert.deepEqual(
        missingDispositionFields(blocks[0]),
        [],
        "the H2 section before the H1 stays complete"
      );
      assert.deepEqual(
        missingDispositionFields(blocks[1]).sort(),
        ["carrier:", "trigger:", "缺輸入:"].sort(),
        "the incomplete item after the H1 must be scanned independently and report its missing fields"
      );
    });

    // H8b — LEGACY GUARD: the document's leading H1 title with only prose still
    // yields no block. Pins that the H8 fix treats H1 as a section-closer only,
    // never as a pending opener, so a bare title never false-reports.
    it("H8b: leading H1 title with only prose still yields no block (legacy)", () => {
      assert.deepEqual(parseListItemBlocks("# Session Pending\n\nsome intro text\n"), []);
    });

    // H9 — a `### `+ deeper sub-heading INSIDE a `## ` pending section is a
    // structural sub-part (e.g. `### 根因與證據（非獨立條目）`), NOT a separate
    // pending. It must be absorbed into the parent section's block, so the
    // section stays ONE complete block. (Only `## ` H2 opens a pending; matching
    // `### `+ as a section boundary would split the pending into fieldless
    // sub-blocks and false-report the sub-heading as missing all three fields.)
    it("H9: a `### ` sub-heading inside a `## ` section is absorbed, not a new pending", () => {
      const text = [
        "## real pending",
        "- 缺輸入: A",
        "- trigger: B",
        "- carrier: C",
        "",
        "### 根因與證據（供重議時參考，非獨立條目）",
        "- 說明子項",
      ].join("\n");
      const blocks = parseListItemBlocks(text);
      assert.equal(
        blocks.length,
        1,
        "a `### ` sub-heading must be absorbed into the parent `## ` section, not open a new block"
      );
      assert.deepEqual(
        missingDispositionFields(blocks[0]),
        [],
        "the parent section's three fields still resolve; the sub-heading does not false-report as an incomplete pending"
      );
    });
  });

  describe("missingDispositionFields", () => {
    it("returns all three fields when block has none", () => {
      const missing = missingDispositionFields(["- some topic"]);
      assert.deepEqual(missing.sort(), ["carrier:", "trigger:", "缺輸入:"].sort());
    });

    it("returns only missing fields when some canonical declarations are present", () => {
      const missing = missingDispositionFields([
        "- topic",
        "  缺輸入: X mentions trigger: only as value prose",
      ]);
      assert.deepEqual(missing, ["trigger:", "carrier:"]);
    });

    it("does not count three compact inline token mentions as declarations", () => {
      const blockLines = ["- topic 缺輸入: X trigger: Y carrier: Z"];
      assert.deepEqual(
        missingDispositionFields(blockLines).sort(),
        ["carrier:", "trigger:", "缺輸入:"].sort()
      );
    });

    it("returns empty array when fields spread across continuation lines (architect C2)", () => {
      const blockLines = [
        "- topic description",
        "  缺輸入: concrete named input",
        "  trigger: when X happens",
        "  carrier: @owner",
      ];
      assert.deepEqual(missingDispositionFields(blockLines), []);
    });

    it("does not treat prose or another declaration value's token mentions as declarations", () => {
      const blockLines = [
        "## pending whose prose mentions 缺輸入: trigger: carrier:",
        "這段說明只是在討論 trigger: 與 carrier: 的格式。",
        "- 缺輸入: the value also mentions trigger: and carrier:",
      ];

      assert.deepEqual(missingDispositionFields(blockLines), ["trigger:", "carrier:"]);
    });

    it("rejects headings, alternate bullets, second same-line hyphens, and topic prefixes", () => {
      for (const line of [
        "## trigger: heading",
        "* trigger: alternate bullet",
        "+ trigger: alternate bullet",
        "- - trigger: second same-line hyphen bullet",
        "- topic trigger: inline prose",
      ]) {
        assert.ok(
          missingDispositionFields([line]).includes("trigger:"),
          `${line} must not declare trigger:`
        );
      }
    });

    it("accepts horizontal whitespace and one hyphen bullet before an exact token", () => {
      const blockLines = [
        "\t缺輸入: A",
        "  - trigger: B",
        "- carrier: C",
      ];
      assert.deepEqual(missingDispositionFields(blockLines), []);
    });
  });

  describe("checkNotesDisposition — Edit tool", () => {
    it("missing-field Edit new_string → advisory naming the missing fields", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: "- decide on API shape\n",
        },
      });
      assert.ok(result, "expected non-null advisory");
      assert.ok(result.advisory, "expected advisory property");
      assert.ok(!result.block, "must NOT block");
      assert.ok(result.advisory.includes("缺輸入:"), "advisory must name missing field 缺輸入:");
      assert.ok(result.advisory.includes("trigger:"), "advisory must name missing field trigger:");
      assert.ok(result.advisory.includes("carrier:"), "advisory must name missing field carrier:");
      assert.ok(result.advisory.includes("Gate N"), "advisory must cite Gate N");
    });

    it("three compact inline token mentions → advisory", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: "- some topic 缺輸入: X trigger: Y carrier: Z\n",
        },
      });
      assert.ok(result?.advisory, "compact inline mentions are not declarations");
      assert.ok(!result.block, "Gate N remains advisory-only");
    });

    it("all three fields spread across indented continuation lines → silent (architect C2)", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: [
            "- decide whether to add caching layer",
            "  缺輸入: benchmark data from production",
            "  trigger: after perf baseline is collected",
            "  carrier: @backend-team",
            "",
          ].join("\n"),
        },
      });
      assert.equal(result, null, "multi-line entry with all fields on continuation lines must be silent");
    });

    // C2 — loose-list: blank line between header and indented fields must be silent
    it("C2: loose-list blank line between header and indented fields → silent (null)", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: [
            "# Session Pending",
            "",
            "- decide whether to add caching layer",
            "",
            "  缺輸入: benchmark data from production",
            "  trigger: after perf baseline is collected",
            "  carrier: @backend-team",
            "",
          ].join("\n"),
        },
      });
      assert.equal(result, null, "loose-list entry with blank line before indented fields must be silent");
    });

    it("deletion-only Edit (empty new_string) → silent", () => {
      const priorContent = "- old item 缺輸入: X trigger: Y carrier: Z";
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        baseCwd: "/fixture-root",
        readFile: deterministicPriorReader(priorContent),
        toolInput: {
          old_string: priorContent,
          new_string: "",
        },
      });
      assert.equal(result, null, "deletion-only edit (empty new_string) must be silent");
    });

    it("retained header-only Edit slice is silent when final entry has continuation fields", () => {
      const priorContent = [
        "# Session Pending",
        "",
        "- stale resolved item",
        "  缺輸入: none",
        "  trigger: merged PR",
        "  carrier: TL",
        "",
        "- retained follow-up",
        "  缺輸入: concrete missing input",
        "  trigger: after the next release",
        "  carrier: TL",
        "",
      ].join("\n");
      const oldString = [
        "- stale resolved item",
        "  缺輸入: none",
        "  trigger: merged PR",
        "  carrier: TL",
        "",
        "- retained follow-up",
      ].join("\n");
      let readPath = null;
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        baseCwd: "/repo",
        readFile: (absPath) => {
          readPath = absPath;
          return priorContent;
        },
        toolInput: {
          old_string: oldString,
          new_string: "- retained follow-up",
        },
      });
      assert.equal(result, null, "final file content contains all three fields, so Gate N must stay silent");
      assert.ok(readPath?.replaceAll("\\", "/").endsWith("/notes/session-pending.md"), "Edit path should be resolved before reading prior content");
    });

    it("Edit new_string with no `- ` lines (no list items) → silent", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        baseCwd: "/fixture-root",
        readFile: deterministicPriorReader("# heading\n"),
        toolInput: {
          old_string: "# heading",
          new_string: "# updated heading\n",
        },
      });
      assert.equal(result, null, "no list items in new_string must be silent");
    });

    it("reconstructable Edit reader failure → silent (fail-open)", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        baseCwd: "/fixture-root",
        readFile: () => {
          throw new Error("fixture read failure");
        },
        toolInput: {
          old_string: "- retained fixture",
          new_string: "- updated fixture",
        },
      });
      assert.equal(result, null, "reader failure must remain fail-open");
    });

    it("fixture-level reconstruction is invariant across isolated roots", () => {
      const completeRoot = makeTempDir("gate-n-complete-");
      const incompleteRoot = makeTempDir("gate-n-incomplete-");
      const completePrior = [
        "- retained fixture",
        "  缺輸入: deterministic input",
        "  trigger: deterministic trigger",
        "  carrier: deterministic owner",
        "",
      ].join("\n");
      const incompletePrior = "- retained fixture\n";
      const toolInput = {
        old_string: "- retained fixture",
        new_string: "- retained fixture",
      };

      try {
        for (const [root, content] of [
          [completeRoot, completePrior],
          [incompleteRoot, incompletePrior],
        ]) {
          mkdirSync(path.join(root, "notes"), { recursive: true });
          writeFileSync(path.join(root, SESSION_PENDING), content, "utf8");
        }

        const completeResult = checkNotesDisposition({
          toolName: "Edit",
          filePath: SESSION_PENDING,
          baseCwd: completeRoot,
          readFile: deterministicPriorReader(completePrior),
          toolInput,
        });
        const incompleteResult = checkNotesDisposition({
          toolName: "Edit",
          filePath: SESSION_PENDING,
          baseCwd: incompleteRoot,
          readFile: deterministicPriorReader(completePrior),
          toolInput,
        });

        assert.deepEqual(
          incompleteResult,
          completeResult,
          "a fixture-level reconstruction must not vary with an ambient carrier"
        );
      } finally {
        rmSync(completeRoot, { recursive: true, force: true });
        rmSync(incompleteRoot, { recursive: true, force: true });
      }
    });

    it("other file (notes/other.md) → silent", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: "notes/other.md",
        toolInput: {
          old_string: "",
          new_string: "- missing all fields\n",
        },
      });
      assert.equal(result, null, "non-target file must be silent");
    });
  });

  describe("checkNotesDisposition — Write tool", () => {
    it("Write content with one missing-field block → advisory", () => {
      const content = [
        "# Session pending",
        "",
        "- decide on rate-limiting strategy",
        "",
      ].join("\n");
      const result = checkNotesDisposition({
        toolName: "Write",
        filePath: SESSION_PENDING,
        toolInput: { content },
      });
      assert.ok(result?.advisory, "expected advisory for Write with missing fields");
      assert.ok(!result.block, "must NOT block");
      assert.ok(result.advisory.includes("Gate N"));
    });

    it("Write content with all fields present → silent", () => {
      const content = [
        "# Session pending",
        "",
        "- decide on rate-limiting strategy",
        "  缺輸入: load test results",
        "  trigger: after load test completes",
        "  carrier: @platform-team",
        "",
      ].join("\n");
      const result = checkNotesDisposition({
        toolName: "Write",
        filePath: SESSION_PENDING,
        toolInput: { content },
      });
      assert.equal(result, null);
    });

    it("Write to other file even with missing fields → silent", () => {
      const result = checkNotesDisposition({
        toolName: "Write",
        filePath: "notes/scratchpad.md",
        toolInput: { content: "- missing all fields\n" },
      });
      assert.equal(result, null);
    });
  });

  describe("checkNotesDisposition — MultiEdit tool", () => {
    it("MultiEdit with one edit introducing a missing-field block → advisory", () => {
      const priorContent = "# Notes\n";
      const result = checkNotesDisposition({
        toolName: "MultiEdit",
        filePath: SESSION_PENDING,
        baseCwd: "/fixture-root",
        readFile: deterministicPriorReader(priorContent),
        toolInput: {
          edits: [
            {
              old_string: "# Notes\n",
              new_string: "# Session Notes\n",
            },
            {
              old_string: "",
              new_string: "- add retry logic to payment service\n",
            },
          ],
        },
      });
      assert.ok(result?.advisory, "expected advisory when a MultiEdit edit introduces a missing-field block");
      assert.ok(!result.block, "must NOT block");
    });

    it("MultiEdit where all edits have complete fields → silent", () => {
      const result = checkNotesDisposition({
        toolName: "MultiEdit",
        filePath: SESSION_PENDING,
        toolInput: {
          edits: [
            {
              old_string: "",
              new_string: "- topic A\n  缺輸入: X\n  trigger: Y\n  carrier: Z\n",
            },
            {
              old_string: "",
              new_string: "- topic B\n  缺輸入: data\n  trigger: when ready\n  carrier: @me\n",
            },
          ],
        },
      });
      assert.equal(result, null);
    });

    it("retained header-only MultiEdit slice is silent when final entry has continuation fields", () => {
      const priorContent = [
        "# Session Pending",
        "",
        "- stale resolved item",
        "  缺輸入: none",
        "  trigger: merged PR",
        "  carrier: TL",
        "",
        "- retained follow-up",
        "  缺輸入: concrete missing input",
        "  trigger: after the next release",
        "  carrier: TL",
        "",
      ].join("\n");
      const oldString = [
        "- stale resolved item",
        "  缺輸入: none",
        "  trigger: merged PR",
        "  carrier: TL",
        "",
        "- retained follow-up",
      ].join("\n");
      let readPath = null;
      const result = checkNotesDisposition({
        toolName: "MultiEdit",
        filePath: SESSION_PENDING,
        baseCwd: "/repo",
        readFile: (absPath) => {
          readPath = absPath;
          return priorContent;
        },
        toolInput: {
          edits: [
            {
              old_string: oldString,
              new_string: "- retained follow-up",
            },
          ],
        },
      });
      assert.equal(result, null, "final file content contains all three fields, so Gate N must stay silent");
      assert.ok(readPath?.replaceAll("\\", "/").endsWith("/notes/session-pending.md"), "MultiEdit path should be resolved before reading prior content");
    });
  });

  describe("real-file integration — default reader and relative path resolution", () => {
    it("reconstructs complete and incomplete final content from an isolated real carrier", () => {
      const root = makeTempDir("gate-n-real-file-");
      const notesDir = path.join(root, "notes");
      const carrierPath = path.join(root, SESSION_PENDING);

      try {
        mkdirSync(notesDir, { recursive: true });
        writeFileSync(
          carrierPath,
          [
            "## complete pending",
            "- 缺輸入: A",
            "- trigger: B",
            "- carrier: C",
            "",
          ].join("\n"),
          "utf8"
        );

        const completeResult = checkNotesDisposition({
          toolName: "Edit",
          filePath: SESSION_PENDING,
          baseCwd: root,
          toolInput: {
            old_string: "## complete pending",
            new_string: "## renamed complete pending",
          },
        });
        assert.equal(completeResult, null, "default reader should preserve a complete reconstructed file");

        writeFileSync(carrierPath, "## incomplete pending\n", "utf8");
        const incompleteResult = checkNotesDisposition({
          toolName: "Edit",
          filePath: SESSION_PENDING,
          baseCwd: root,
          toolInput: {
            old_string: "## incomplete pending",
            new_string: "## renamed incomplete pending",
          },
        });
        assert.ok(
          incompleteResult?.advisory,
          "default reader should report an incomplete reconstructed file"
        );
        assert.ok(!incompleteResult.block, "real-file coverage must remain advisory-only");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("advisory is non-blocking (exit 0 / no block decision)", () => {
    it("advisory result has no block property", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: "- missing-field entry\n",
        },
      });
      assert.ok(result, "should return advisory");
      assert.ok(result.advisory, "should have advisory property");
      assert.ok(!result.block, "must NOT have block property (non-blocking)");
      assert.strictEqual(result.block, undefined, "block property must be absent");
    });

    it("evaluatePreToolUsePayload returns advisory (not block) for session-pending.md Edit with missing fields", () => {
      // Uses the top-level dispatch seam to confirm non-blocking end-to-end
      const payload = {
        tool_name: "Edit",
        tool_input: {
          file_path: SESSION_PENDING,
          old_string: "",
          new_string: "- decide something without fields\n",
        },
      };
      const result = evaluatePreToolUsePayload(payload);
      // Result could be null (if other gates fire), a block, or an advisory.
      // What we assert is: it is NOT a block result.
      if (result && result !== PASS_THROUGH) {
        assert.ok(!result.block, "evaluatePreToolUsePayload must not block for Gate N advisory payload");
        if (result.advisory) {
          assert.ok(result.advisory.includes("Gate N"), "advisory must cite Gate N");
        }
      }
      // result === null means no gate fired, which is also acceptable (fail-open is correct)
    });
  });

  describe("advisory message shape", () => {
    it("advisory lists missing field names and includes decision-now reminder", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: "- choose database schema\n  缺輸入: final requirements\n",
        },
      });
      // Only trigger: and carrier: are missing
      assert.ok(result?.advisory);
      assert.ok(result.advisory.includes("trigger:"), "should mention trigger:");
      assert.ok(result.advisory.includes("carrier:"), "should mention carrier:");
      // Should NOT list 缺輸入: since it's present
      assert.ok(
        !result.advisory.includes("缺欄：缺輸入:"),
        "should not list 缺輸入: as missing when it is present"
      );
    });

    it("advisory includes three-field template example", () => {
      const result = checkNotesDisposition({
        toolName: "Edit",
        filePath: SESSION_PENDING,
        toolInput: {
          old_string: "",
          new_string: "- some item without any fields\n",
        },
      });
      assert.ok(result?.advisory);
      // Should include the three-field template block
      assert.ok(result.advisory.includes("缺輸入:"), "template must show 缺輸入: field");
      assert.ok(result.advisory.includes("trigger:"), "template must show trigger: field");
      assert.ok(result.advisory.includes("carrier:"), "template must show carrier: field");
      // Fact-first: cite the specific advisory context
      assert.ok(result.advisory.includes("notes/session-pending.md"), "advisory must cite the file path");
    });
  });
});

test("fix-silent-gate-skip R5: fullwidth ： on 缺輸入/trigger/carrier → no missing fields", () => {
  const text = [
    "- 標頭全形",
    "",
    "  缺輸入：無",
    "  trigger：X",
    "  carrier：Y",
  ].join("\n");
  const blocks = parseListItemBlocks(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(missingDispositionFields(blocks[0]), []);
});

test("fix-silent-gate-skip R5: mixed :/： still complete; true missing still reported", () => {
  const complete = [
    "- 混用",
    "  缺輸入: 半形",
    "  trigger：全形",
    "  carrier: 半形",
  ].join("\n");
  assert.deepEqual(missingDispositionFields(parseListItemBlocks(complete)[0]), []);

  const missingTrigger = [
    "- 缺 trigger",
    "  缺輸入：有",
    "  carrier：有",
  ].join("\n");
  assert.deepEqual(missingDispositionFields(parseListItemBlocks(missingTrigger)[0]), ["trigger:"]);
});
