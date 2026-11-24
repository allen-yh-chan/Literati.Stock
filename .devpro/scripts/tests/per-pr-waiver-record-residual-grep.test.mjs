/**
 * per-pr-waiver-record-residual-grep.test.mjs
 *
 * Cross-carrier map entry for the named residual `per-pr-waiver-record-residual`
 * (defined only in `design-core.md` section 11; change
 * amend-gate-forgery-rule-for-waiver-records, design.md D7, D8, D12, D13).
 *
 * What this file owns:
 *   1. D12 sha256 pins: the batch exception text (section 11 paragraph, F-9 row,
 *      packet severity bullet, the four Markdown reviewer copies, the primary batch
 *      mapping line) stays byte-identical to the immutable change base
 *      `production-v7.10.0` once the NEW waiver fragments are stripped out. The pins are
 *      guards, not RED items: they hold before the waiver text exists (the strip is a
 *      no-op) and after. The canonical batch requirement pin is added by the task that
 *      brings main into the branch, not here.
 *   2. The primary six-axis mapping line for the waiver exception (D8):
 *      `primaryMapping.singleLine`, `primaryMapping.wording`,
 *      `primaryMapping.noNewTier`, `primaryMapping.reuseContract`, with mutations.
 *   3. NFR7 negatives: the new waiver text in every carrier names no artifact that does
 *      not exist on main (`dev_verification`) and no sibling PR number.
 *   4. The four ADDED scenarios of `Primary Review Maps Accepted Per-PR Waiver Residual
 *      Without A Finding`, one named test per THEN / AND.
 *
 * The section 11 paragraph, the packet duty and the reviewer copies have their own
 * literal guards in gate-threat-model-classification-grep.test.mjs,
 * validate-second-review-packet.test.mjs and cross-review-cli-skills-grep.test.mjs.
 *
 * Guarantee ceiling (cooperative-only): these tests lock literal presence, placement and
 * hashes. They do NOT prove that a reviewer follows the mapping or classifies a residual
 * correctly; that stays a review judgement, never a CI hard fail.
 *
 * The batch text is deliberately NOT copied here: a test file that repeated the batch
 * exception verbatim would add exception text to the diff. Hashes stand in for it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readRepoFile as read, readRepoFileIfExists } from "./lib/read.mjs";
import { secondReviewPacketStaticPrefix } from "../validate-second-review-packet.mjs";

const DESIGN_CORE = ".devpro/agent-rules/design-core.md";
const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";
const FALLBACK = ".devpro/agent-rules/code-review-checklist-fallback.md";
const DP_REVIEWER = ".claude/agents/dp-reviewer.md";
const CROSS_MODEL = ".devpro/agent-rules/code-review-cross-model.md";
const SECOND_REVIEW_SKILL = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
const DISPATCH_BLOCKS = ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CURSOR = ".devpro/agent-rules/platform-adapters/cursor.md";

const WAIVER_ID = "per-pr-waiver-record-residual";
const SEVERITY_LINE_ANCHOR = "adversarial bypass narrative";
const PACKET_BULLET_ANCHOR = "class-one gate's adversarial bypass narrative is at most a Suggestion";
const W2 = "A second closed, user-ruled residual exception, separate from the batch one and not drawn from it by analogy, applies";
const W15 = "a repository that receives it through a rules sync gets its force from the first review after that sync merges";
const CURSOR_POINTER_START = " Per-PR waiver records:";
// amend-gate-threat-model-to-accident-only: the F-9 row tail is now "…既有實例為具名殘留例外 `batch…`（批次範圍紀錄）
// 與 `per-pr-waiver…`（逐 PR 豁免紀錄，…）"; the second-pointer fragment runs from "與 `id`（" to its closing "）".
const F9_FRAGMENT_START = `與 \`per-pr-waiver-record-residual\`（`;
const BATCH_SECTION_MARKER = "**F-9 具名殘留例外 `batch-scope-record-residual`";
const WAIVER_SECTION_MARKER = "**F-9 具名殘留例外 `per-pr-waiver-record-residual`";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function onlyLine(text, predicate, label) {
  const lines = text.split("\n").filter(predicate);
  assert.equal(lines.length, 1, `${label}: expected exactly one matching line, found ${lines.length}`);
  return lines[0];
}

// Remove the new waiver sentence and its one adjacent separator space from a line. A no-op
// when the sentence is absent, so the pins hold before the waiver text exists.
function stripWaiverSentence(line) {
  const start = line.indexOf(W2);
  if (start === -1) return line;
  const w15 = line.indexOf(W15, start);
  assert.notEqual(w15, -1, "waiver sentence start found but its last anchor is missing");
  const end = w15 + W15.length;
  assert.equal(line[end], ".", "waiver sentence must end with a period right after its last anchor");
  assert.equal(line[end + 1], " ", "waiver sentence must be followed by exactly one separator space");
  return line.slice(0, start) + line.slice(end + 2);
}

function stripCursorPointer(line) {
  const start = line.indexOf(CURSOR_POINTER_START);
  return start === -1 ? line : line.slice(0, start);
}

function stripF9Fragment(row) {
  const start = row.indexOf(F9_FRAGMENT_START);
  if (start === -1) return row;
  const close = row.indexOf("）", start);
  assert.notEqual(close, -1, "F-9 second pointer start found but its closing parenthesis is missing");
  return row.slice(0, start) + row.slice(close + 1);
}

function severityLineOf(rel) {
  return onlyLine(read(rel), (line) => line.includes(SEVERITY_LINE_ANCHOR), rel);
}

function packetBullet() {
  const prefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky");
  return onlyLine(prefix, (line) => line.startsWith("- ") && line.includes(PACKET_BULLET_ANCHOR), "packet severity bullet");
}

// ---------------------------------------------------------------------------
// D12 pins. Recompute (reviewers can run these independently):
//   git show production-v7.10.0:<path>   then apply the extraction rule named per pin.
// Base commit production-v7.10.0 = 30d3a9f38f56a893571a71a9eeaba81b011e6326.
// The packet pin was cross-checked against a live render of the base packet:
//   secondReviewPacketStaticPrefix("Claude Code", "pr-sticky") at the base commit, the single
//   "- " bullet that contains PACKET_BULLET_ANCHOR (4249 characters).
// ---------------------------------------------------------------------------
//
// RE-PIN (amend-gate-threat-model-to-accident-only): the six pins below that cover the F-9 row, the
// packet severity bullet and the four reviewer-copy severity lines were intentionally re-pinned to the
// text of that change (accident-only F-9 wording, `consent-record-residual` general clause, nature-based
// unlisted-object guard, and the known-nature vs undeterminable split added for PR #3500 second opinion
// W1-classification-fallback in the packet bullet and the three reviewer copies). The batch paragraph pin was also re-pinned: its closing clause now reads
// "不增減 §11 兩表的具名列" instead of "不增減封閉列舉", because the class-one table is no longer a closed
// list. Only the primary batch mapping line pin still holds the v7.10.0 base value byte-for-byte.
const PINS = {
  "design-core section 11 batch paragraph (whole line holding the batch marker)":
    "d4e249382021d480cccb4fdfd6a560fb15515ac9cfd6a84a34c192cff09a9d2e",
  "design-core F-9 row minus the second pointer fragment":
    "5cc8ca8883eceb5d99f8b2e3949f55d2ce5e629ed9f71dff12b8fc161c6c4ced",
  "packet severity bullet minus the waiver sentence":
    "700b0cc99700e94fef13b29c442d64e5d8d9cb5fef2ba0c581508741c4388e59",
  "code-review-cross-model.md severity line minus the waiver sentence":
    "0aa7111469e0f51645a00dfb24ebe15b44241dcf1b614072ce5677c70f1941cb",
  "second-review SKILL.md severity line minus the waiver sentence":
    "67776b39bb5431104f2c201bc0b6630550da64e987304c9ff5fe8d4620c16170",
  "subagent-dispatch-blocks.md severity line minus the waiver sentence":
    "33501f3aecc99fae5a072191dbc6203489582f7d1ffee1dbc28c22f1323f471c",
  "cursor.md severity line minus the waiver pointer subset":
    "c36e08ccaa1c73d2f24731726b6c3c226a8ccfe552f66e23d686e63afed34a63",
  "code-review-checklist.md primary batch mapping line":
    "a7ce2a70dc1b7d431c82018e810f41083c12cca2f514d569e9069108a05fb3b1",
};

const PIN_SOURCES = {
  "design-core section 11 batch paragraph (whole line holding the batch marker)": () =>
    onlyLine(read(DESIGN_CORE), (line) => line.includes(BATCH_SECTION_MARKER), "batch section 11 paragraph"),
  "design-core F-9 row minus the second pointer fragment": () =>
    stripF9Fragment(onlyLine(read(DESIGN_CORE), (line) => /^\| F-9 \|/.test(line), "F-9 row")),
  "packet severity bullet minus the waiver sentence": () => stripWaiverSentence(packetBullet()),
  "code-review-cross-model.md severity line minus the waiver sentence": () =>
    stripWaiverSentence(severityLineOf(CROSS_MODEL)),
  "second-review SKILL.md severity line minus the waiver sentence": () =>
    stripWaiverSentence(severityLineOf(SECOND_REVIEW_SKILL)),
  "subagent-dispatch-blocks.md severity line minus the waiver sentence": () =>
    stripWaiverSentence(severityLineOf(DISPATCH_BLOCKS)),
  "cursor.md severity line minus the waiver pointer subset": () => stripCursorPointer(severityLineOf(CURSOR)),
  "code-review-checklist.md primary batch mapping line": () =>
    onlyLine(read(CHECKLIST), (line) => line.includes("`batch-scope-record-residual` 對照"), "primary batch mapping line"),
};

for (const [label, expected] of Object.entries(PINS)) {
  test(`D12 pin: ${label} matches its pinned text`, () => {
    assert.equal(sha256(PIN_SOURCES[label]()), expected, `${label}: sha256 differs from the pinned text`);
  });
}

// D12 canonical pin (design D6, D12). Unlike the eight pins above, this one is NOT a base value:
// the dependency change amend-batch-residual-exception-count (PR #3493, commit e549b328e) changed
// "SHALL carry exactly one named" to "SHALL carry a named" in this requirement. RE-PIN
// (amend-gate-threat-model-to-accident-only): "the closed class-one enumeration" became "the named
// rows of the section 11 class tables"; the count sentence from PR #3493 is unchanged. Extraction: openspec/specs/design-core/spec.md from the heading line below to the
// next "### Requirement: " or "## " line, joined with "\n", trailing whitespace trimmed.
// Recompute: apply the same rule to this change's openspec/specs/design-core/spec.md.
// Cross-check (disclosure only): replacing "SHALL carry a named, closed," with
// "SHALL carry exactly one named, closed," in the block gives the production-v7.10.0 value
// f3dd2995a953e927cebcc3ec89a7201d1347f9fce3c81cf217e56c5031eeb915.
const CANONICAL_DESIGN_CORE_SPEC = "openspec/specs/design-core/spec.md";
const BATCH_REQUIREMENT_HEADING =
  "### Requirement: Batch Scope Records Carry A Named User-Accepted Residual Exception";
const CANONICAL_BATCH_REQUIREMENT_PIN = "cf5b81e55bb0b52cb197e510a1b184e5307c341ca9d76dfc810883ef68289d77";

function canonicalBatchRequirementBlock() {
  const lines = read(CANONICAL_DESIGN_CORE_SPEC).split("\n");
  const start = lines.indexOf(BATCH_REQUIREMENT_HEADING);
  assert.notEqual(start, -1, "canonical batch requirement heading is missing");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### Requirement: ") || lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

test("D12 pin: canonical batch requirement keeps the dependency's count sentence and matches its pinned text", () => {
  const block = canonicalBatchRequirementBlock();
  assert.equal(block.split("SHALL carry a named, closed,").length - 1, 1, "count sentence from the dependency must appear once");
  assert.ok(!block.includes("SHALL carry exactly one named"), "the pre-dependency count wording must be gone");
  assert.equal(sha256(block), CANONICAL_BATCH_REQUIREMENT_PIN, "canonical batch requirement differs from its pinned text");
});

test("D12 pins: each strip rule is a no-op on a base-shaped line and removes exactly the new fragment otherwise", () => {
  // Control for the strip helpers themselves, so a pin cannot pass because a helper mangles text.
  const base = "alpha omega.";
  assert.equal(stripWaiverSentence(base), base);
  assert.equal(stripWaiverSentence(`alpha ${W2} x ${W15}. omega.`), "alpha omega.");
  assert.equal(stripCursorPointer("tail."), "tail.");
  assert.equal(stripCursorPointer(`tail.${CURSOR_POINTER_START} more`), "tail.");
  assert.equal(stripF9Fragment("a；批次 `x` | b"), "a；批次 `x` | b");
  assert.equal(stripF9Fragment(`a；批次 \`x\`（批次範圍紀錄）${F9_FRAGMENT_START}逐 PR 豁免紀錄） | b`), "a；批次 `x`（批次範圍紀錄） | b");
});

// ---------------------------------------------------------------------------
// D8 primary mapping. `primaryMapping.*` names are the test items the design lists.
// ---------------------------------------------------------------------------
const FALLBACK_POINTER = "> **TL 單 context fallback**";
const BATCH_MAPPING_ID = "`batch-scope-record-residual`";
const REVIEW_OUTPUT_HEADING = "### 審查輸出格式";
const REVIEW_OUTPUT_END = "### Bounded Six-Axis Rereview Cadence";

function reviewOutputSection(text) {
  const section = text.split(REVIEW_OUTPUT_HEADING)[1]?.split(REVIEW_OUTPUT_END)[0];
  assert.ok(section, "code-review-checklist.md must keep the 審查輸出格式 section");
  return section;
}

function waiverMappingLines(text) {
  return reviewOutputSection(text).split("\n").filter((line) => line.includes(WAIVER_ID));
}

function assertMappingSingleLine(text) {
  const section = reviewOutputSection(text).split("\n");
  const waiverRows = section.filter((line) => line.includes(WAIVER_ID));
  assert.equal(waiverRows.length, 1, "primaryMapping.singleLine: the output section must discover exactly one waiver mapping line");
  const waiverAt = section.indexOf(waiverRows[0]);
  const batchAt = section.findIndex((line) => line.includes(BATCH_MAPPING_ID));
  const fallbackAt = section.findIndex((line) => line.startsWith(FALLBACK_POINTER));
  assert.ok(batchAt !== -1 && fallbackAt !== -1, "primaryMapping.singleLine: batch mapping line and fallback pointer must stay in the section");
  assert.ok(batchAt < waiverAt, "primaryMapping.singleLine: the waiver mapping must sit after the batch mapping line");
  assert.ok(waiverAt < fallbackAt, "primaryMapping.singleLine: the waiver mapping must sit before the TL fallback pointer");
}

function assertMappingWording(text) {
  const rows = waiverMappingLines(text);
  assert.equal(rows.length, 1, "primaryMapping.wording: exactly one waiver mapping line");
  const line = rows[0];
  assert.match(line, /design-core\.md[^\n]*§11/, "primaryMapping.wording: the line must point at design-core.md section 11");
  assert.ok(line.includes("只記為不阻擋的觀察"), "primaryMapping.wording: the line must say it is only recorded as a non-blocking observation");
  assert.ok(
    line.includes("**MUST NOT** 升為 Suggestion／Important／Critical"),
    "primaryMapping.wording: the line must forbid raising the residual to a finding severity"
  );
  assert.ok(!line.includes(BATCH_MAPPING_ID), "primaryMapping.wording: the waiver line must not repeat the batch identifier");
  assert.ok(
    line.includes("前提不成立、矛盾證據或其他偽造照 F-9，自我適用限制照 SSOT"),
    "primaryMapping.wording: precondition, contradiction and self-application limits must stay with F-9 and the SSOT"
  );
}

function reviewSummaryBullets(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `Review Summary heading not found: ${heading}`);
  const fenceEnd = text.indexOf("```", start);
  assert.ok(fenceEnd > start, "Review Summary block must be closed by a code fence");
  return text
    .slice(start, fenceEnd)
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

function assertNoNewTier(checklist, fallback) {
  for (const [label, bullets] of [
    ["code-review-checklist.md", reviewSummaryBullets(checklist, "## Review Summary")],
    ["code-review-checklist-fallback.md", reviewSummaryBullets(fallback, "### Review Summary")],
  ]) {
    assert.equal(bullets.length, 4, `primaryMapping.noNewTier: ${label} Review Summary must keep exactly 4 bullets`);
    for (const word of ["Critical", "Important", "Suggestion", "已檢查"]) {
      assert.equal(bullets.filter((b) => b.includes(`**${word}**`)).length, 1, `primaryMapping.noNewTier: ${label} keeps one ${word} bullet`);
    }
    for (const bullet of bullets) {
      assert.ok(!bullet.includes("INFO") && !bullet.includes("觀察"), `primaryMapping.noNewTier: ${label} Review Summary adds no INFO or observation tier`);
    }
  }
}

const REUSE_CONTRACT_FRAGMENTS = [
  ["full-text read of the six-axis rules", "`.devpro/agent-rules/code-review-checklist.md`（六軸原則，全文）"],
  ["every non-OK finding enters the finding chain", "每個非OK finding都須以同一stable"],
  ["bounded round emits no placeholder", "MUST NOT emit placeholder or unrelated axis verdict"],
];

function assertReuseContract(reviewer) {
  for (const [label, fragment] of REUSE_CONTRACT_FRAGMENTS) {
    assert.ok(
      reviewer.includes(fragment),
      `primaryMapping.reuseContract: dp-reviewer.md lost "${label}" (${JSON.stringify(fragment)}); re-derive the waiver mapping location before changing it`
    );
  }
}

function assertPrimaryMapping(checklist, fallback, reviewer) {
  assertMappingSingleLine(checklist);
  assertMappingWording(checklist);
  assertNoNewTier(checklist, fallback);
  assertReuseContract(reviewer);
}

const mappingInputs = () => ({ checklist: read(CHECKLIST), fallback: read(FALLBACK), reviewer: read(DP_REVIEWER) });

test("primaryMapping.singleLine: one waiver mapping line, after the batch line and before the TL fallback pointer", () => {
  assertMappingSingleLine(read(CHECKLIST));
});

test("primaryMapping.wording: observation only, no finding severity, no batch identifier, SSOT limits kept", () => {
  assertMappingWording(read(CHECKLIST));
});

test("primaryMapping.noNewTier: both Review Summary blocks keep exactly four bullets and add no INFO or observation tier", () => {
  const { checklist, fallback } = mappingInputs();
  assertNoNewTier(checklist, fallback);
});

test("primaryMapping.reuseContract: dp-reviewer.md keeps the three sentences the mapping location is derived from", () => {
  assertReuseContract(read(DP_REVIEWER));
});

test("primaryMapping mutations: every operative edit of the waiver mapping or its premises turns a guard red", () => {
  const { checklist, fallback, reviewer } = mappingInputs();
  assertPrimaryMapping(checklist, fallback, reviewer);
  const line = onlyLine(
    reviewOutputSection(checklist),
    (l) => l.includes(WAIVER_ID),
    "control: waiver mapping line"
  );
  const mutateLine = (fn) => {
    const mutated = fn(line);
    assert.notEqual(mutated, line, "mutation fixture must change the waiver mapping line");
    return checklist.replace(line, mutated);
  };
  const summaryBlockStart = checklist.indexOf("## Review Summary");
  const mutants = [
    ["observation sentence deleted", { checklist: mutateLine((l) => l.replace("只記為不阻擋的觀察", "")) }],
    ["MUST NOT weakened to MUST", { checklist: mutateLine((l) => l.replace("**MUST NOT** 升為", "**MUST** 升為")) }],
    ["batch identifier added to the line", { checklist: mutateLine((l) => `${l}${BATCH_MAPPING_ID}`) }],
    ["observation turned into a Suggestion", { checklist: mutateLine((l) => l.replace("不阻擋的觀察", "Suggestion")) }],
    [
      "mapping moved after the TL fallback pointer",
      {
        checklist: (() => {
          const without = checklist.replace(`${line}\n\n`, "");
          assert.notEqual(without, checklist, "mutation fixture must remove the mapping line");
          const pointerLine = without.split("\n").find((l) => l.startsWith(FALLBACK_POINTER));
          assert.ok(pointerLine, "probe precondition: the TL fallback pointer line exists");
          return without.replace(pointerLine, `${pointerLine}\n\n${line}`);
        })(),
      },
    ],
    [
      "Review Summary gains an INFO count row",
      {
        checklist: `${checklist.slice(0, summaryBlockStart)}${checklist
          .slice(summaryBlockStart)
          .replace("- **已檢查**", "- **INFO**: 0 件\n- **已檢查**")}`,
      },
    ],
    [
      "dp-reviewer loses its no-placeholder sentence",
      { reviewer: reviewer.split("MUST NOT emit placeholder or unrelated axis verdict").join("may emit a placeholder axis") },
    ],
  ];
  for (const [name, patch] of mutants) {
    assert.throws(
      () => assertPrimaryMapping(patch.checklist ?? checklist, patch.fallback ?? fallback, patch.reviewer ?? reviewer),
      assert.AssertionError,
      `mutant must be rejected: ${name}`
    );
  }
});

// ---------------------------------------------------------------------------
// NFR7: the new waiver text names no artifact that does not exist on main and no sibling PR.
// ---------------------------------------------------------------------------
const NFR7_FORBIDDEN = ["dev_verification", "#3492"];

function waiverSectionLine() {
  return onlyLine(read(DESIGN_CORE), (line) => line.includes(WAIVER_SECTION_MARKER), "design-core section 11 waiver paragraph");
}

function waiverSentenceOf(line, label) {
  const start = line.indexOf(W2);
  assert.notEqual(start, -1, `${label}: the waiver sentence must be present`);
  const w15 = line.indexOf(W15, start);
  assert.notEqual(w15, -1, `${label}: the waiver sentence must reach its last anchor`);
  return line.slice(start, w15 + W15.length + 1);
}

test("NFR7: the design-core section 11 waiver paragraph names no unshipped artifact and no sibling PR number", () => {
  const paragraph = waiverSectionLine();
  for (const forbidden of NFR7_FORBIDDEN) assert.ok(!paragraph.includes(forbidden), `section 11 waiver paragraph must not contain ${forbidden}`);
});

test("NFR7: the packet waiver sentence names no unshipped artifact and no sibling PR number", () => {
  const sentence = waiverSentenceOf(packetBullet(), "packet");
  for (const forbidden of NFR7_FORBIDDEN) assert.ok(!sentence.includes(forbidden), `packet waiver sentence must not contain ${forbidden}`);
});

test("NFR7: the three full Markdown reviewer copies and the cursor subset name no unshipped artifact and no sibling PR number", () => {
  for (const rel of [CROSS_MODEL, SECOND_REVIEW_SKILL, DISPATCH_BLOCKS]) {
    const sentence = waiverSentenceOf(severityLineOf(rel), rel);
    for (const forbidden of NFR7_FORBIDDEN) assert.ok(!sentence.includes(forbidden), `${rel}: waiver sentence must not contain ${forbidden}`);
  }
  const cursorLine = severityLineOf(CURSOR);
  const at = cursorLine.indexOf(CURSOR_POINTER_START);
  assert.notEqual(at, -1, "cursor.md: the waiver pointer subset must be present");
  for (const forbidden of NFR7_FORBIDDEN) assert.ok(!cursorLine.slice(at).includes(forbidden), `cursor.md: waiver pointer must not contain ${forbidden}`);
});

test("NFR7: the primary waiver mapping line names no unshipped artifact and no sibling PR number", () => {
  const rows = waiverMappingLines(read(CHECKLIST));
  assert.equal(rows.length, 1, "the primary waiver mapping line must be present exactly once");
  for (const forbidden of NFR7_FORBIDDEN) assert.ok(!rows[0].includes(forbidden), `primary waiver mapping line must not contain ${forbidden}`);
});

// ---------------------------------------------------------------------------
// ADDED requirement "Primary Review Maps Accepted Per-PR Waiver Residual Without A Finding":
// scenario titles are literal because lint-delta-new-scenario-assertion-coverage greps test names.
// ---------------------------------------------------------------------------
const SPEC_DELTA = "openspec/changes/amend-gate-forgery-rule-for-waiver-records/specs/code-review-checklist/spec.md";
const SPEC_CANONICAL = "openspec/specs/code-review-checklist/spec.md";

function requireChecklistSpecTitle(title) {
  const spec = readRepoFileIfExists(SPEC_DELTA) ?? read(SPEC_CANONICAL);
  assert.ok(spec.includes(`Scenario: ${title}`), `code-review-checklist spec must carry ${JSON.stringify(title)}`);
}

const OBSERVATION_SCENARIO = "An accepted per-PR waiver residual is an observation";
const KEEPS_CONTRACT_SCENARIO = "Unmet precondition, waiver forgery, and waiver self-review keep the existing contract";
const OUTSIDE_CHAIN_SCENARIO = "The waiver observation stays outside the finding chain";
const BOUNDED_SCENARIO = "A bounded round outside the residual's axis emits nothing for it";

test(`Scenario: ${OBSERVATION_SCENARIO} — THEN it records only a non-blocking observation with no remediation finding`, () => {
  requireChecklistSpecTitle(OBSERVATION_SCENARIO);
  assertMappingWording(read(CHECKLIST));
  assertMappingSingleLine(read(CHECKLIST));
});

test(`Scenario: ${KEEPS_CONTRACT_SCENARIO} — THEN the observation mapping does not apply and F-9 plus the SSOT self-application restriction govern`, () => {
  requireChecklistSpecTitle(KEEPS_CONTRACT_SCENARIO);
  const [line] = waiverMappingLines(read(CHECKLIST));
  assert.ok(line, "the primary waiver mapping line must exist");
  assert.ok(line.includes("前提成立時"), "the mapping is conditional on the precondition");
  assert.ok(line.includes("前提不成立、矛盾證據或其他偽造照 F-9，自我適用限制照 SSOT"));
});

test(`Scenario: ${OUTSIDE_CHAIN_SCENARIO} — THEN no finding identifier, no classified list, no receipt finding, no guarantee assessment, no Review Summary count`, () => {
  requireChecklistSpecTitle(OUTSIDE_CHAIN_SCENARIO);
  const { checklist, fallback, reviewer } = mappingInputs();
  assertMappingWording(checklist);
  assertNoNewTier(checklist, fallback);
  assertReuseContract(reviewer);
});

test(`Scenario: ${BOUNDED_SCENARIO} — THEN no observation and no placeholder is emitted for that residual`, () => {
  requireChecklistSpecTitle(BOUNDED_SCENARIO);
  assertMappingSingleLine(read(CHECKLIST));
  assertReuseContract(read(DP_REVIEWER));
  assert.ok(
    read(DP_REVIEWER).includes("輸出 only represented axes；MUST NOT emit placeholder or unrelated axis verdict"),
    "dp-reviewer.md must keep the bounded represented-axes output rule"
  );
});
