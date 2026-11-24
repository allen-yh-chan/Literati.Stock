import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findH2Section, h2SectionBody } from "../lib/markdown-h2-section.mjs";
import { SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES } from "../second-review-material-contract.mjs";
import { SCOPE_SUMMARY_MAX_BYTES } from "../validate-second-review-packet.mjs";
import {
  PR_CHANGE_CONTEXT_MAX_BYTES,
  PR_EVIDENCE_FIELDS,
  PR_EVIDENCE_SECTION_MAX_BYTES,
  changeContextFindings,
  evidenceFieldFindings,
  extractEvidenceText,
  extractScopeSummary,
  findExactH2Section,
  findUnfilledTemplateText,
  formatEvidenceFinding,
  scopeSummaryOverLimit,
  sectionBody,
} from "../lib/pr-body-evidence-rules.mjs";

// The four banned words are built by joins so this file, and any PR text that cites its test names, never carries them literally.
const BANNED = Object.freeze({
  one: ["TO", "DO"].join(""),
  two: ["TB", "D"].join(""),
  three: ["[fi", "ll"].join(""),
  four: ["place", "holder"].join(""),
});
const TICK = String.fromCharCode(96);
const inline = (text) => `${TICK}${text}${TICK}`;
const fence = (lines, marker = TICK.repeat(3)) => [marker, ...lines, marker].join("\n");

const OPENSPEC_LINE = "- change: " + inline("openspec/changes/example/");
function bodyOf({ changeContext = "Explain the change and its purpose.", openspec = OPENSPEC_LINE, ledger = "Validation passed.", testEvidence = "Tests passed." } = {}) {
  return ["## Change Context", "", changeContext, "", "## OpenSpec", "", openspec, "", "## Requirement Ledger Completion", "", ledger, "", "## Test Evidence", "", testEvidence, ""].join("\n");
}
const bytes = (text) => Buffer.byteLength(text, "utf8");
const evidenceMatches = (text) => findUnfilledTemplateText(text, { profile: "evidence" });
const contextMatches = (text) => findUnfilledTemplateText(text, { profile: "change-context" });

describe("shared limits and field map", () => {
  test("the limits are the contract constants, not a second definition", () => {
    assert.equal(PR_EVIDENCE_SECTION_MAX_BYTES, SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES);
    assert.equal(PR_CHANGE_CONTEXT_MAX_BYTES, SCOPE_SUMMARY_MAX_BYTES);
  });

  test("the evidence fields name the PR sections that feed them", () => {
    assert.deepEqual(PR_EVIDENCE_FIELDS, {
      primary_validation_evidence: ["OpenSpec", "Requirement Ledger Completion"],
      primary_test_evidence: ["Test Evidence"],
    });
  });
});

describe("section extraction", () => {
  test("findExactH2Section needs the exact heading, tolerates trailing blanks and CRLF, and stops at the next H2", () => {
    const body = "## Alpha\r\none\r\n\r\n## Alpha extra\r\ntwo\r\n## Beta  \t\nthree\n";
    assert.equal(findExactH2Section(body, "Alpha")[1], "one\r\n\r\n");
    assert.equal(findExactH2Section(body, "Beta")[1], "three\n");
    assert.equal(findExactH2Section(body, "Alp"), null);
    assert.equal(findExactH2Section(body, "Missing"), null);
  });

  test("findExactH2Section escapes regex characters in the heading", () => {
    assert.equal(findExactH2Section("## A (1)\nx\n", "A (1)")[1], "x\n");
    assert.equal(findExactH2Section("## AB\nx\n", "A.")?.[1], undefined);
  });

  test("sectionBody trims and falls back to the empty string", () => {
    assert.equal(sectionBody("## Alpha\n\n  text  \n\n## Beta\nb\n", "Alpha"), "text");
    assert.equal(sectionBody("## Alpha\n\n## Beta\nb\n", "Alpha"), "");
    assert.equal(sectionBody("no sections", "Alpha"), "");
  });

  test("extractEvidenceText trims each section, drops empty ones and joins with one blank line", () => {
    const body = "## One\n\n a \n\n## Two\n\n\n## Three\n b \n";
    assert.equal(extractEvidenceText(body, ["One", "Two", "Three"]), "a\n\nb");
    assert.equal(extractEvidenceText(body, ["Two"]), "");
  });

  test("extractScopeSummary strips list markers, turns tabs into spaces, drops blank lines and joins with spaces", () => {
    const body = "## Change Context\n\n- first item\n* second\titem\n\n+ third item\nplain line\n\n## Next\n";
    assert.equal(extractScopeSummary(body), "first item second item third item plain line");
    assert.equal(extractScopeSummary("## Other\nx\n"), "");
  });
});

describe("byte limits", () => {
  const limit = PR_EVIDENCE_SECTION_MAX_BYTES;

  test("a Test Evidence section at the limit passes and one more byte is reported with its size", () => {
    assert.deepEqual(evidenceFieldFindings(bodyOf({ testEvidence: "x".repeat(limit) }), "primary_test_evidence"), []);
    const findings = evidenceFieldFindings(bodyOf({ testEvidence: "x".repeat(limit + 1) }), "primary_test_evidence");
    assert.equal(findings.length, 1);
    assert.deepEqual({ ...findings[0], matches: undefined }, {
      section: "## Test Evidence", field: "primary_test_evidence", kind: "over-limit", bytes: limit + 1, limit, matches: undefined, classification: "pr_evidence_invalid",
    });
  });

  test("a CJK character counts three bytes", () => {
    const fits = "漢".repeat(Math.floor(limit / 3));
    const over = "漢".repeat(Math.floor(limit / 3) + 1);
    assert.ok(bytes(fits) <= limit && bytes(over) > limit && over.length < limit);
    assert.deepEqual(evidenceFieldFindings(bodyOf({ testEvidence: fits }), "primary_test_evidence"), []);
    assert.equal(evidenceFieldFindings(bodyOf({ testEvidence: over }), "primary_test_evidence")[0].kind, "over-limit");
  });

  test("the validation field measures the two trimmed sections joined by one blank line", () => {
    const openspecBytes = bytes(OPENSPEC_LINE);
    const ledgerAtLimit = "y".repeat(limit - openspecBytes - 2);
    assert.ok(bytes(ledgerAtLimit) < limit && openspecBytes < limit, "each section alone is under the limit");
    assert.deepEqual(evidenceFieldFindings(bodyOf({ ledger: ledgerAtLimit }), "primary_validation_evidence"), []);
    const findings = evidenceFieldFindings(bodyOf({ ledger: `${ledgerAtLimit}y` }), "primary_validation_evidence");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "over-limit");
    assert.equal(findings[0].bytes, limit + 1);
    assert.equal(findings[0].section, "## OpenSpec + ## Requirement Ledger Completion");
  });

  test("the Change Context limit applies to the normalized scope_summary, not the raw section", () => {
    const contextLimit = PR_CHANGE_CONTEXT_MAX_BYTES;
    assert.deepEqual(changeContextFindings(bodyOf({ changeContext: "a".repeat(contextLimit) })), []);
    const over = changeContextFindings(bodyOf({ changeContext: "a".repeat(contextLimit + 1) }));
    assert.equal(over.length, 1);
    assert.deepEqual({ ...over[0] }, {
      section: "## Change Context", field: "scope_summary", kind: "over-limit", bytes: contextLimit + 1, limit: contextLimit, matches: [], classification: "handoff_limit_exceeded",
    });
    const half = "a".repeat(Math.floor(contextLimit / 2) - 1);
    const raw = `- ${half}\n- ${half}`;
    assert.ok(bytes(raw) > contextLimit, "the raw section is over the limit");
    assert.deepEqual(changeContextFindings(bodyOf({ changeContext: raw })), [], "the normalized text is under it");
    const cjk = Math.floor(contextLimit / 3);
    assert.deepEqual(changeContextFindings(bodyOf({ changeContext: "漢".repeat(cjk) })), []);
    assert.equal(changeContextFindings(bodyOf({ changeContext: "漢".repeat(cjk + 1) }))[0].kind, "over-limit");
  });

  test("scopeSummaryOverLimit reports bytes and limit only when the summary is over", () => {
    assert.equal(scopeSummaryOverLimit("a".repeat(PR_CHANGE_CONTEXT_MAX_BYTES)), null);
    assert.deepEqual(scopeSummaryOverLimit("a".repeat(PR_CHANGE_CONTEXT_MAX_BYTES + 1)), { bytes: PR_CHANGE_CONTEXT_MAX_BYTES + 1, limit: PR_CHANGE_CONTEXT_MAX_BYTES });
  });
});

describe("empty sections and control characters", () => {
  test("an empty evidence field is an empty finding", () => {
    const findings = evidenceFieldFindings(bodyOf({ testEvidence: "" }), "primary_test_evidence");
    assert.deepEqual(findings.map((item) => item.kind), ["empty"]);
    assert.equal(findings[0].classification, "pr_evidence_invalid");
  });

  test("the validation field is empty only when both of its sections are empty", () => {
    assert.deepEqual(evidenceFieldFindings(bodyOf({ ledger: "" }), "primary_validation_evidence"), []);
    assert.deepEqual(evidenceFieldFindings(bodyOf({ ledger: "", openspec: "" }), "primary_validation_evidence").map((item) => item.kind), ["empty"]);
  });

  test("an empty Change Context is an empty finding and a control character is its own finding", () => {
    assert.deepEqual(changeContextFindings(bodyOf({ changeContext: "" })).map((item) => item.kind), ["empty"]);
    for (const control of ["\u0000", "\u0008", "\u000e", "\u001f", "\u007f"]) {
      const findings = changeContextFindings(bodyOf({ changeContext: `Clarify${control}behavior` }));
      assert.deepEqual(findings.map((item) => item.kind), ["control-characters"]);
      assert.equal(findings[0].classification, "pr_evidence_invalid");
    }
    assert.deepEqual(changeContextFindings(bodyOf({ changeContext: "Clarify\tthe\tbehavior" })), []);
  });
});

describe("banned words keep their literal rules in both profiles", () => {
  test("every banned word is reported case-insensitively in the evidence profile", () => {
    for (const word of Object.values(BANNED)) {
      assert.deepEqual(evidenceMatches(`Result: ${word} remains`), [word]);
      assert.deepEqual(evidenceMatches(`Result: ${word.toLowerCase()} remains`), [word.toLowerCase()]);
    }
  });

  test("two banned words carry word boundaries and the other two match inside longer words", () => {
    assert.deepEqual(evidenceMatches(`${BANNED.one}S and ${BANNED.two}S`), []);
    assert.deepEqual(evidenceMatches(`x${BANNED.four}x`), [BANNED.four]);
    assert.deepEqual(evidenceMatches(`x${BANNED.three}x`), [BANNED.three]);
  });

  test("a banned word is reported even inside an inline code span or a fenced block", () => {
    assert.deepEqual(evidenceMatches(`Ran ${inline(`run ${BANNED.one}`)}`), [BANNED.one]);
    assert.deepEqual(evidenceMatches(fence([`step ${BANNED.four}`])), [BANNED.four]);
  });

  test("the Change Context profile reports three of the words and not the bracketed fill marker", () => {
    assert.deepEqual(contextMatches(`Purpose: ${BANNED.one}`), [BANNED.one]);
    assert.deepEqual(contextMatches(`Purpose: ${BANNED.two}`), [BANNED.two]);
    assert.deepEqual(contextMatches(`Purpose: ${BANNED.four}`), [BANNED.four]);
    assert.deepEqual(contextMatches(`Purpose: ${BANNED.three} later`), []);
    assert.deepEqual(evidenceMatches(`Purpose: ${BANNED.three} later`), [BANNED.three]);
  });

  test("unfilled wording becomes an unfilled-template finding with the matches listed", () => {
    const findings = evidenceFieldFindings(bodyOf({ testEvidence: `Result: ${BANNED.one} then ${BANNED.two}` }), "primary_test_evidence");
    assert.deepEqual(findings.map((item) => item.kind), ["unfilled-template"]);
    assert.deepEqual(findings[0].matches, [BANNED.one, BANNED.two]);
    const context = changeContextFindings(bodyOf({ changeContext: `Purpose: ${BANNED.four}` }));
    assert.deepEqual(context.map((item) => item.kind), ["unfilled-template"]);
    assert.equal(context[0].classification, "pr_evidence_invalid");
  });
});

describe("Scenario: Command templates in code pass and template residue is rejected", () => {
  // Frozen from recent merged PR bodies the old builder rule rejected although the text is a legitimate command template.
  const legitimateTemplates = [
    ["#2883", `Ran ${inline("node run.mjs --changed <tested-sha>")} and it passed.`],
    ["#2875", `Set ${inline("DEVPRO_COST_BUDGET_OVERRIDE=<change>:round")} for the run.`],
    ["#2863", `Ran ${inline("... seal-final --request <seal-final-wcsp-00a26a9.json>")} successfully.`],
    ["#2844", `Reasoned about ${inline("<PR#>:<n>")} keys.`],
    ["#2818", `Archived under ${inline("openspec/changes/archive/<name>")} as expected.`],
    ["#2816", `Wrote ${inline("hooks-git/<hook>.local")} for the override.`],
    ["#2741 and #2692", `Release ${inline("<X.Y.Z>")} was tagged.`],
    ["#2731 heading", `Checked ${inline("### D<n> — <title>")} headings.`],
    ["#2731 command", `Ran ${inline("validate-openspec-change.mjs <name> --strict")} with exit 0.`],
  ];

  test("single identifier fields inside an inline code span pass in the evidence profile", () => {
    for (const [source, text] of legitimateTemplates) {
      assert.deepEqual(evidenceMatches(text), [], `${source} must not be reported`);
      assert.deepEqual(evidenceFieldFindings(bodyOf({ testEvidence: text, ledger: text }), "primary_test_evidence"), [], source);
      assert.deepEqual(evidenceFieldFindings(bodyOf({ testEvidence: text, ledger: text }), "primary_validation_evidence"), [], source);
    }
  });

  test("single identifier fields inside a fenced block pass, whatever fence marker is used", () => {
    assert.deepEqual(evidenceMatches(fence(["node run.mjs --changed <tested-sha>", "echo <name>"])), []);
    assert.deepEqual(evidenceMatches(fence(["echo <name>"], "~~~")), []);
    assert.deepEqual(evidenceMatches(["Intro.", fence(["echo <name>"], TICK.repeat(4)), "Outro."].join("\n")), []);
    assert.deepEqual(evidenceMatches(["   " + TICK.repeat(3), "echo <name>", TICK.repeat(3)].join("\n")), [], "an opener indented by up to three spaces counts");
  });

  test("a fence closes only on the same marker with at least the opener length, otherwise it runs to the end of the section", () => {
    const longOpen = [TICK.repeat(4), "echo <a>", TICK.repeat(3), "echo <b>", TICK.repeat(4)].join("\n");
    assert.deepEqual(evidenceMatches(longOpen), [], "a shorter fence line does not close a longer one");
    const afterClose = [fence(["echo <a>"]), "<b>"].join("\n");
    assert.deepEqual(evidenceMatches(afterClose), ["<b>"], "text after the closing fence is outside code");
    const tildeMismatch = [TICK.repeat(3), "echo <a>", "~~~", "echo <b>"].join("\n");
    assert.deepEqual(evidenceMatches(tildeMismatch), [], "a tilde line does not close a backtick fence");
    const unclosed = [TICK.repeat(3), "echo <a>", "echo <b>"].join("\n");
    assert.deepEqual(evidenceMatches(unclosed), [], "an unclosed fence runs to the end of its own section text");
  });

  test("double-backtick spans, multiple spans in one line, and spans next to prose are handled", () => {
    const double = TICK.repeat(2);
    assert.deepEqual(evidenceMatches(`${double}echo <a>${double}`), []);
    assert.deepEqual(evidenceMatches(`${double}has ${TICK} inside <a>${double}`), []);
    assert.deepEqual(evidenceMatches(`${inline("<a>")} and ${inline("<b>")}`), []);
    assert.deepEqual(evidenceMatches(`${inline("keep")} <n>`), ["<n>"], "a field outside the span is still unfilled");
  });

  test("an unmatched backtick does not open a code span", () => {
    assert.deepEqual(evidenceMatches(`${TICK}echo <a> without a closing tick`), ["<a>"]);
    assert.deepEqual(evidenceMatches(`${TICK}echo <a>${TICK.repeat(2)}`), ["<a>"], "a closing run of a different length does not match");
  });

  test("an inline code span does not cross a line break", () => {
    assert.deepEqual(evidenceMatches(`${TICK}start <a>\nmiddle <b>${TICK}`), ["<a>", "<b>"]);
  });

  test("a field that starts inside code and ends outside it is unfilled", () => {
    assert.deepEqual(evidenceMatches(`${inline("start <a")} end>`), ["<a` end>"]);
  });

  test("only a single ASCII identifier is accepted inside code", () => {
    const rejected = [
      "<observed OID>",
      "<a b>",
      "<a,b>",
      "<a..b>",
      "<a...>",
      "<a…>",
      "<中文>",
      "<-x>",
      "<.x>",
      "<a\tb>",
    ];
    for (const token of rejected) {
      assert.deepEqual(evidenceMatches(inline(token)), [token], `${token} stays unfilled`);
    }
    for (const token of ["<a>", "<A1>", "<a.b-c_d>", "<a/b#c:d@e+f>", "<0x1>", "<n>"]) {
      assert.deepEqual(evidenceMatches(inline(token)), [], `${token} is a single identifier`);
    }
  });

  test("the known residue stays pinned: a spaced field inside code is still reported", () => {
    assert.deepEqual(evidenceMatches(`Used ${inline("<observed OID>")} in the walkthrough.`), ["<observed OID>"]);
    assert.deepEqual(evidenceMatches(`Used ${inline("<observed-OID>")} in the walkthrough.`), []);
  });

  test("a field outside code is unfilled even when it is a single identifier", () => {
    assert.deepEqual(evidenceMatches("implemented <n>, partial <n>"), ["<n>", "<n>"]);
    assert.deepEqual(evidenceMatches("Result: passed <n> checks"), ["<n>"]);
  });

  // Frozen from git-pr-template-and-merge.md, left unfilled.
  const templateValidationSections = {
    openspec: [
      "- change: " + inline("openspec/changes/<name>/"),
      "- tasks.md: all checked",
      "- archive: done（" + inline("openspec/specs/<name>/") + "）。Only an urgent repair may fill " + inline("deferred — <原因>，24h 內補齊") + " here.",
    ].join("\n"),
    ledger: [
      "- disposition counts: implemented <n>, partial <n>, deferred <n>, rejected <n>, moved-to-issue <n>",
      "- non-implemented rows: <N/A 或列 R# + disposition + owner/issue/next step>",
      "- coverage: implemented/partial rows have " + inline("[Req: R#]") + " task evidence; unknown " + inline("[Req]") + " refs: none",
    ].join("\n"),
  };
  const templateTestEvidence = [
    "- 指令：" + inline("<dotnet test / npm test / pytest ...>"),
    "- 結果：" + inline("<passed X, failed 0, skipped Y>") + " 或 " + inline("not verified: <reason>"),
    "- 覆蓋：" + inline("<各 gate 輸出的範圍／檢查數；base 不可解填 not verified／base unresolved>"),
    "- QA 範圍：" + inline("openspec/changes/<name>/qa-test-scope.md"),
    "- **驗收證據**：",
    "  - [ ] <驗收條件 1 + 具體證據：測試名／指令輸出／檔案路徑／截圖>",
    "  - [ ] <驗收條件 2 + 具體證據>",
    "  - [ ] <驗收條件 3 + 具體證據>",
  ].join("\n");
  // Frozen from the pull request template shipped in .github, left unfilled.
  const githubTemplateLedger = [
    "- disposition counts: implemented <n>, partial <n>, deferred <n>, rejected <n>, moved-to-issue <n>",
    "- non-implemented rows: N/A / <R# disposition + owner/issue/next step>",
  ].join("\n");
  const githubTemplateTestEvidence = [
    "- 指令：" + inline("node --test .devpro/scripts/tests/"),
    "- 結果：" + inline("passed <n>, failed 0") + " 或 " + inline("not verified: <reason>"),
    "- 覆蓋：" + inline("<各 gate 輸出的範圍／檢查數>"),
    "- **驗收證據**：",
    "  - [ ] <proposal target state evidence>",
    "  - [ ] <regression test or grep evidence>",
  ].join("\n");

  test("the OpenSpec and Requirement Ledger residue of the PR description template is rejected", () => {
    // The single identifier path fields inside code are the known residue; the CJK field is still caught.
    assert.deepEqual(evidenceMatches(templateValidationSections.openspec), ["<原因>"], "a CJK field is unfilled even inside code");
    const ledger = evidenceMatches(templateValidationSections.ledger);
    assert.equal(ledger.filter((value) => value === "<n>").length, 5);
    assert.ok(ledger.includes("<N/A 或列 R# + disposition + owner/issue/next step>"));
    const findings = evidenceFieldFindings(bodyOf({ openspec: templateValidationSections.openspec, ledger: templateValidationSections.ledger }), "primary_validation_evidence");
    assert.deepEqual(findings.map((item) => item.kind), ["unfilled-template"]);
    assert.ok(findings[0].matches.includes("<原因>") && findings[0].matches.includes("<n>"));
  });

  test("the Test Evidence residue of the PR description template is rejected", () => {
    const matches = evidenceMatches(templateTestEvidence);
    for (const expected of [
      "<dotnet test / npm test / pytest ...>",
      "<passed X, failed 0, skipped Y>",
      "<各 gate 輸出的範圍／檢查數；base 不可解填 not verified／base unresolved>",
      "<驗收條件 1 + 具體證據：測試名／指令輸出／檔案路徑／截圖>",
      "<驗收條件 2 + 具體證據>",
      "<驗收條件 3 + 具體證據>",
    ]) assert.ok(matches.includes(expected), `${expected} must be reported`);
    assert.deepEqual(evidenceFieldFindings(bodyOf({ testEvidence: templateTestEvidence }), "primary_test_evidence").map((item) => item.kind), ["unfilled-template"]);
  });

  test("the Test Evidence residue of the repository pull request template is rejected", () => {
    const matches = evidenceMatches(githubTemplateTestEvidence);
    for (const expected of ["<各 gate 輸出的範圍／檢查數>", "<proposal target state evidence>", "<regression test or grep evidence>"]) {
      assert.ok(matches.includes(expected), `${expected} must be reported`);
    }
    // Known residue: a single identifier inside code is accepted, so the code span with the count field is not reported.
    assert.ok(!matches.includes("<n>"));
    const ledger = evidenceMatches(githubTemplateLedger);
    assert.equal(ledger.filter((value) => value === "<n>").length, 5);
    assert.ok(ledger.includes("<R# disposition + owner/issue/next step>"));
  });

  test("the Change Context gets no relaxation: a single identifier in code is still reported", () => {
    assert.deepEqual(contextMatches(`Ran ${inline("<name>")} today`), ["<name>"]);
    assert.deepEqual(contextMatches(fence(["echo <name>"])), ["<name>"]);
    const findings = changeContextFindings(bodyOf({ changeContext: `Ran ${inline("<name>")} today` }));
    assert.deepEqual(findings.map((item) => item.kind), ["unfilled-template"]);
    assert.deepEqual(findings[0].matches, ["<name>"]);
    assert.deepEqual(changeContextFindings(bodyOf({ changeContext: "- 改什麼：<plain language what changed>\n- 目的：<why>" }))[0].matches, ["<plain language what changed>", "<why>"]);
  });
});

describe("code regions are judged per original section", () => {
  test("an unclosed fence in the OpenSpec section does not reach the Requirement Ledger Completion section", () => {
    const openspec = [OPENSPEC_LINE, TICK.repeat(3), "echo <a>"].join("\n");
    const ledger = "- disposition counts: implemented <n>";
    const findings = evidenceFieldFindings(bodyOf({ openspec, ledger }), "primary_validation_evidence");
    assert.deepEqual(findings.map((item) => item.kind), ["unfilled-template"]);
    assert.deepEqual(findings[0].matches, ["<n>"], "only the ledger field is reported; the field inside the fence is not");
    // Joining the two sections first would have swallowed the ledger line into the open fence.
    assert.deepEqual(evidenceMatches(`${openspec}\n\n${ledger}`), [], "a naive joined judgment would miss it");
  });

  test("a field that opens in one section and closes in the next is not one field", () => {
    const findings = evidenceFieldFindings(bodyOf({ openspec: `${OPENSPEC_LINE}\nopens <here`, ledger: "closes here> and <n>" }), "primary_validation_evidence");
    assert.deepEqual(findings[0].matches, ["<n>"]);
  });

  test("findings are collected per section, and every unfilled field of every section is listed once", () => {
    const findings = evidenceFieldFindings(bodyOf({ openspec: `${OPENSPEC_LINE}\nremaining <n>`, ledger: "remaining <n> and <m>" }), "primary_validation_evidence");
    assert.deepEqual(findings[0].matches, ["<n>", "<m>"]);
  });

  test("CRLF line endings are judged like LF line endings", () => {
    const text = ["Intro", TICK.repeat(3), "echo <a>", TICK.repeat(3), "tail <b>"].join("\r\n");
    assert.deepEqual(evidenceMatches(text), ["<b>"]);
    assert.deepEqual(evidenceMatches(`${inline("<a>")}\r\n<b>`), ["<b>"]);
  });
});

describe("finding order and message format", () => {
  test("an over-limit section with unfilled wording reports the unfilled finding first, then the size", () => {
    const text = `${BANNED.one} ${"x".repeat(PR_EVIDENCE_SECTION_MAX_BYTES)}`;
    assert.deepEqual(evidenceFieldFindings(bodyOf({ testEvidence: text }), "primary_test_evidence").map((item) => item.kind), ["unfilled-template", "over-limit"]);
  });

  test("the formatter names the section, the bytes and the limit from the finding", () => {
    const limit = PR_EVIDENCE_SECTION_MAX_BYTES;
    const [single] = evidenceFieldFindings(bodyOf({ testEvidence: "x".repeat(limit + 1) }), "primary_test_evidence");
    assert.equal(formatEvidenceFinding(single), `## Test Evidence: ${limit + 1} UTF-8 bytes; limit ${limit}`);
    const [joined] = evidenceFieldFindings(bodyOf({ ledger: "y".repeat(limit) }), "primary_validation_evidence");
    assert.equal(formatEvidenceFinding(joined), `## OpenSpec + ## Requirement Ledger Completion (joined with one blank line): ${joined.bytes} UTF-8 bytes; limit ${limit}`);
    const contextLimit = PR_CHANGE_CONTEXT_MAX_BYTES;
    const [context] = changeContextFindings(bodyOf({ changeContext: "a".repeat(contextLimit + 1) }));
    assert.equal(formatEvidenceFinding(context), `## Change Context (normalized scope_summary): ${contextLimit + 1} UTF-8 bytes; limit ${contextLimit} (about ${Math.floor(contextLimit / 3)} CJK characters)`);
  });

  test("the formatter quotes unfilled matches without repeating duplicates, and words empty and control findings", () => {
    const [unfilled] = evidenceFieldFindings(bodyOf({ testEvidence: "a <n> b <n> c <m>" }), "primary_test_evidence");
    assert.equal(formatEvidenceFinding(unfilled), '## Test Evidence: unfilled template text "<n>", "<m>"');
    const [empty] = evidenceFieldFindings(bodyOf({ testEvidence: "" }), "primary_test_evidence");
    assert.equal(formatEvidenceFinding(empty), "## Test Evidence: empty or missing");
    const [control] = changeContextFindings(bodyOf({ changeContext: "a\u0000b" }));
    assert.equal(formatEvidenceFinding(control), "## Change Context: contains unsupported control characters");
  });
});

// The disclosure notice line and its evaluator were retired (remove-second-review-disclosure-framework, design D3).
test("the retired disclosure notice exports are gone from the PR body rules", async () => {
  const rules = await import("../lib/pr-body-evidence-rules.mjs");
  const retired = Object.keys(rules).filter((name) => /DISCLOSURE_NOTICE|evaluateSecondReviewDisclosureNotice/.test(name));
  assert.deepEqual(retired, []);
});

test("the H2 section reader is one copy shared by the PR body rules and the builder", () => {
  const body = "intro\n## Review Summary  \n- a\n- b\n\n## Test Evidence\n- c\n## Review Summary Extra\n- d\n";
  assert.equal(h2SectionBody(body, "Review Summary"), "- a\n- b");
  assert.equal(h2SectionBody(body, "Test Evidence"), "- c");
  assert.equal(h2SectionBody(body, "Review Summary Extra"), "- d");
  assert.equal(h2SectionBody(body, "Absent"), "");
  assert.equal(h2SectionBody(undefined, "Review Summary"), "");
  assert.equal(h2SectionBody("## Section 1: Target State (Done When)\n1. x\n", "Section 1: Target State (Done When)"), "1. x", "regex metacharacters in a heading are literal");
  assert.equal(h2SectionBody("## Review Summary\r\n- crlf\r\n## Next\r\n", "Review Summary"), "- crlf");
  const match = findH2Section("## Target State\n1. one\n", "Target State");
  assert.equal(match[1], "1. one\n", "the raw match keeps the section body for callers that parse it themselves");
  assert.equal(findH2Section("no heading", "Target State"), null);
  // The PR body rules module hands out the very same functions under its own names.
  assert.equal(sectionBody, h2SectionBody);
  assert.equal(findExactH2Section, findH2Section);
  // The reader has no imports, and the builder carries no copy of its own.
  const readerSource = readFileSync(new URL("../lib/markdown-h2-section.mjs", import.meta.url), "utf8");
  assert.equal(/^import\b/m.test(readerSource), false);
  const builder = readFileSync(new URL("../build-pr-sticky-handoff.mjs", import.meta.url), "utf8");
  assert.equal(/function (?:findH2Section|findExactH2Section|sectionBody|readPrBodySection|h2SectionBody)\(/.test(builder), false);
  assert.equal(/\b(?:findH2Section|readPrBodySection)\b/.test(builder), false, "the builder reads sections through the rules module only");
});
