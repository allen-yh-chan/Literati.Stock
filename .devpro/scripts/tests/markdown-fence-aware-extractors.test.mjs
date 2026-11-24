import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractH2Section } from "../lib/batch-approval-ledger.mjs";
import { countH2Sections, extractSection } from "../lib/clarification-contract.mjs";
import {
  extractExactH2Bodies,
  findExactHeadingSpan,
  neutraliseInertMarkdown as sharedNeutraliseInertMarkdown,
} from "../lib/markdown-fence-aware.mjs";
import {
  exactH2Blocks,
  neutraliseInertMarkdown,
  REQUIREMENT_LEDGER_HEADING,
  BASELINE_LEDGER_HEADING,
} from "../lint-requirement-count-ratchet.mjs";
import {
  findSessionPendingShapeViolations,
  parseBlocks,
} from "../lib/session-pending-blocks.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

describe("markdown fence-aware extractors — prove-it", () => {
  test("R1: fenced H2 does not truncate exactHeadingBlock span", () => {
    const design = [
      "## Decisions",
      "",
      "### D1 Keep fence body",
      "",
      "Example:",
      "```markdown",
      "## Scope-Change Exempt Units",
      "- not a real decision",
      "```",
      "",
      "### D2 After fence",
      "",
      "Still in Decisions.",
      "",
      "## Other",
      "",
      "Next section.",
    ].join("\n");
    const span = findExactHeadingSpan(design, "## Decisions");
    assert.ok(span);
    const block = span.lines.slice(span.start, span.end).join("\n");
    assert.match(block, /### D2 After fence/);
    assert.match(block, /## Scope-Change Exempt Units/);
    assert.doesNotMatch(block, /^## Other$/m);
    const core = readFileSync(join(SCRIPT_DIR, "../lib/review-remediation-evidence-core.mjs"), "utf8");
    assert.match(core, /findExactHeadingSpan/);
    assert.match(core, /function exactHeadingBlock/);
  });

  test("R2: fenced-only Batch Approval Ledger extracts empty", () => {
    const proposal = [
      "# Proposal",
      "",
      "```yaml",
      "## Batch Approval Ledger",
      "covers:",
      "  - merge",
      "```",
      "",
      "## Why",
      "",
      "Real prose.",
    ].join("\n");
    assert.equal(extractH2Section(proposal, "Batch Approval Ledger"), "");
  });

  test("R2: live Batch Approval Ledger still accepts flexible ## whitespace", () => {
    const proposal = [
      "##  Batch Approval Ledger",
      "",
      "kind: same-change-dp-change-batch",
      "covers:",
      "  - worktree",
      "",
      "## Why",
      "",
      "x",
    ].join("\n");
    const section = extractH2Section(proposal, "Batch Approval Ledger");
    assert.match(section, /kind: same-change-dp-change-batch/);
    assert.doesNotMatch(section, /^## Why/m);
  });

  test("R2: fenced-only Clarification State count is 0", () => {
    const md = [
      "# Notes",
      "",
      "```markdown",
      "## Clarification State",
      "- decisions: fake",
      "```",
    ].join("\n");
    assert.equal(countH2Sections(md, "Clarification State"), 0);
    const section = extractSection(md, "Clarification State");
    assert.ok(section == null || section === "");
  });

  test("R3: live H1 closes exactH2Blocks body", () => {
    const src = [
      "## Requirement Ledger",
      "| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |",
      "|---|---|---|---|---|---|",
      "| R1 | a | b | c | implemented | x |",
      "# Other Doc",
      "| R99 | leaked | leaked | leaked | deferred | y |",
    ].join("\n");
    const { count, bodies } = exactH2Blocks(neutraliseInertMarkdown(src), REQUIREMENT_LEDGER_HEADING);
    assert.equal(count, 1);
    assert.doesNotMatch(bodies[0], /R99/);
    assert.match(bodies[0], /R1/);
  });

  test("R3: comment-prefixed heading is not an ATX heading after neutralise", () => {
    const src = "<!-- x --> ## Requirement Baseline Ledger\n| decision_id | trigger | baseline_from | baseline_to |\n";
    const { count } = exactH2Blocks(neutraliseInertMarkdown(src), BASELINE_LEDGER_HEADING);
    assert.equal(count, 0);
  });

  test("R4: fenced preamble bullet does not create phantom block or shape hit", () => {
    const content = [
      "Intro:",
      "```",
      "- trigger: example",
      "- carrier: example",
      "```",
      "",
      "## 1. Real pending",
      "  - 缺輸入: none",
      "  - trigger: now",
      "  - carrier: test",
    ].join("\n");
    const { blocks } = parseBlocks(content);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lines[0], "## 1. Real pending");
    assert.deepEqual(findSessionPendingShapeViolations(content), []);
  });

  test("R4: live column-0 bullet in H2-adopted file is still a violation", () => {
    const content = [
      "## 1. Real pending",
      "  - 缺輸入: none",
      "- trigger: bad",
    ].join("\n");
    assert.deepEqual(findSessionPendingShapeViolations(content), [3]);
  });
});

describe("markdown fence-aware — keepFences blanks comments but keeps fenced content", () => {
  const KEEP = { keepFences: true };

  test("a comment outside a fence is blanked and the fence body is kept verbatim", () => {
    const src = ["<!-- hidden -->visible", "```json", '["<!-- not a comment -->"]', "```", "tail"].join("\n");
    const out = sharedNeutraliseInertMarkdown(src, KEEP).split("\n");
    assert.equal(out[0], `${" ".repeat("<!-- hidden -->".length)}visible`, "the comment is blanked in place, so columns stay aligned");
    assert.deepEqual(out.slice(1, 4), ["```json", '["<!-- not a comment -->"]', "```"]);
    assert.equal(out[4], "tail");
  });

  test("a fence marker inside a comment does not open a fence", () => {
    const src = ["<!--", "```json", "[1]", "```", "-->", "after"].join("\n");
    const out = sharedNeutraliseInertMarkdown(src, KEEP).split("\n");
    assert.equal(out.length, 6);
    assert.ok(out.slice(0, 5).every((line) => line.trim() === ""), "the whole comment is blank, including the fence markers");
    assert.equal(out[5], "after");
  });

  test("a comment wrapping a whole H2 section hides that heading from the H2 extractor", () => {
    const src = ["# Doc", "", "<!--", "## Scope Rulings", "", "```json", "[]", "```", "-->", ""].join("\n");
    assert.equal(extractExactH2Bodies(src, "## Scope Rulings").count, 1, "control: the raw text still shows the heading");
    assert.equal(extractExactH2Bodies(sharedNeutraliseInertMarkdown(src, KEEP), "## Scope Rulings").count, 0);
  });

  test("an unclosed comment blanks everything after it", () => {
    const out = sharedNeutraliseInertMarkdown(["keep", "<!-- never closed", "## Scope Rulings"].join("\n"), KEEP).split("\n");
    assert.equal(out[0], "keep");
    assert.equal(out[1].trim(), "");
    assert.equal(out[2].trim(), "");
  });

  test("without options the existing behaviour is unchanged: fence bodies are blanked", () => {
    const src = ["```json", "[1]", "```", "<!-- c -->x"].join("\n");
    assert.deepEqual(sharedNeutraliseInertMarkdown(src).split("\n").slice(0, 3), ["", "", ""]);
    assert.equal(sharedNeutraliseInertMarkdown(src).split("\n")[3].trim(), "x");
  });
});
