/**
 * Locks clarify-rereview-finding-disposition: bounded rereview 新 finding
 * disposition SSOT (checklist), dispatch prompt pointer, and canonical
 * scenarios must not be silently removed or reworded.
 *
 * Guard strength (rule-anchor-guard-strength.md): polarity clauses use
 * same-physical-line compound regexes; canonical scenario bodies are sliced
 * from the heading to the next heading of the same or higher level; the DRY
 * reverse (absence) axis is pinned by resident positive/negative fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";
const CANONICAL_SPEC = "openspec/specs/code-review-checklist/spec.md";
const DISPATCH_BLOCKS =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";

const TOKEN_TABLE_ROW =
  /^\|\s*`(fix-now|tracked-follow-up|defer-with-owner-trigger|non-issue-with-evidence)`\s*\|/;

function linesOf(path) {
  return readFileSync(repoPath(path), "utf8").split("\n");
}

function exactlyOneLine(lines, needle, path) {
  const hits = lines.filter((line) => line.includes(needle));
  assert.equal(
    hits.length,
    1,
    `expected exactly one line containing "${needle}" in ${path}, found ${hits.length}`,
  );
  return hits[0];
}

// Slice a scenario body from its heading to the next heading of the same or
// higher level (#### or shallower) or EOF; the heading MUST occur exactly once.
function scenarioSection(lines, heading, path) {
  const indexes = lines.flatMap((line, i) => (line === heading ? [i] : []));
  assert.equal(
    indexes.length,
    1,
    `expected exactly one canonical heading line "${heading}" in ${path}, found ${indexes.length} at lines [${indexes.map((i) => i + 1).join(", ")}]`,
  );
  const start = indexes[0] + 1;
  const offset = lines.slice(start).findIndex((line) => /^#{1,4} /.test(line));
  const end = offset === -1 ? lines.length : start + offset;
  return lines.slice(start, end).join("\n");
}

test("Scenario: Bounded Rereview Traceable In-Scope New Findings — checklist SSOT line and canonical scenario body", () => {
  const ssotLine = exactlyOneLine(linesOf(CHECKLIST), "Bounded rereview 新 finding 處置", CHECKLIST);

  assert.match(
    ssotLine,
    /in-scope[\s\S]*fix-now[\s\S]*MUST NOT[\s\S]*tracked-follow-up[\s\S]*#N/,
    "SSOT line must bind in-scope, fix-now, MUST NOT, tracked-follow-up, #N in order on the same physical line",
  );
  assert.match(
    ssotLine,
    /non-issue-with-evidence/,
    "SSOT line must also mention non-issue-with-evidence",
  );
  assert.match(
    ssotLine,
    /MUST NOT[\s\S]*defer-with-owner-trigger/,
    "SSOT line must mention defer-with-owner-trigger after MUST NOT",
  );
  assert.match(
    ssotLine,
    /TL bounded prompt MUST NOT 另給衝突處置/,
    "SSOT line must forbid the TL bounded prompt from giving a conflicting disposition",
  );

  const section = scenarioSection(
    linesOf(CANONICAL_SPEC),
    "#### Scenario: Bounded Rereview Traceable In-Scope New Findings",
    CANONICAL_SPEC,
  );
  assert.match(
    section,
    /trivial-fixable Suggestion MUST be recorded as `state: closed` with `fix-now`/,
    "canonical scenario body must state the trivial-fixable Suggestion disposition rule",
  );
  assert.match(
    section,
    /the TL's bounded rereview prompt MUST NOT instruct a disposition that conflicts with this rule/,
    "canonical scenario body must forbid a conflicting TL bounded rereview prompt",
  );
  assert.match(
    section,
    /the reviewer MUST NOT close such a Suggestion as `tracked-follow-up` or `defer-with-owner-trigger`/,
    "canonical scenario body must forbid closing the Suggestion via tracked-follow-up or defer-with-owner-trigger",
  );

  const bodyLine = exactlyOneLine(
    linesOf(CANONICAL_SPEC),
    "Every finding, including Suggestion, MUST receive exactly one closed disposition token",
    CANONICAL_SPEC,
  );
  assert.match(
    bodyLine,
    /trivial-fixable new Suggestion[^\n]*MUST NOT be closed as `tracked-follow-up` or `defer-with-owner-trigger`/,
    "canonical requirement body must forbid closing a trivial-fixable new Suggestion via tracked-follow-up or defer-with-owner-trigger",
  );
});

test("Scenario: Bounded Rereview Untraceable New Findings Keep Round Scope — canonical scenario body", () => {
  const section = scenarioSection(
    linesOf(CANONICAL_SPEC),
    "#### Scenario: Bounded Rereview Untraceable New Findings Keep Round Scope",
    CANONICAL_SPEC,
  );
  assert.match(
    section,
    /`tracked-follow-up` disposition MUST cite a numbered issue `#N`/,
    "canonical scenario body must require tracked-follow-up to cite a numbered issue",
  );
  assert.match(
    section,
    /Critical or Important finding MUST NOT be closed as `tracked-follow-up` or `defer-with-owner-trigger`/,
    "canonical scenario body must forbid closing Critical/Important via tracked-follow-up or defer-with-owner-trigger",
  );
});

test("devpro:pre-pr dispatch block points bounded rereview new finding disposition at the checklist SSOT", () => {
  const pointerLine = exactlyOneLine(linesOf(DISPATCH_BLOCKS), "本輪新 finding 處置", DISPATCH_BLOCKS);
  assert.match(
    pointerLine,
    /本輪新 finding 處置[\s\S]*code-review-checklist\.md[\s\S]*MUST NOT[\s\S]*#N/,
    "dispatch pointer line must bind 本輪新 finding 處置, code-review-checklist.md, MUST NOT, #N in order on the same physical line",
  );
  assert.match(
    pointerLine,
    /本輪新 finding 處置[^\n]*TL 追加的 bounded prompt MUST NOT 另給衝突處置/,
    "dispatch pointer line must forbid a TL-appended bounded prompt from giving a conflicting disposition",
  );
  assert.match(
    pointerLine,
    /本輪新 finding 處置[^\n]*MUST NOT 以 `tracked-follow-up` 或 defer 關閉/,
    "dispatch pointer line must bind MUST NOT to closing via tracked-follow-up or defer",
  );
});

test("devpro:pre-pr dispatch block does not copy the disposition token definition table (DRY reverse)", () => {
  // Resident fixtures pin the matcher: the positive is a real checklist table
  // row (narrowing the matcher turns this red); the negatives are legitimate
  // lines that must stay allowed (widening the matcher turns this red).
  const positive =
    "| `tracked-follow-up` | 開 issue／有 owner 的 follow-up（擴 scope／需獨立設計 → 建有編號+owner issue，PR body 引裸 `#N`） |";
  const negatives = [
    "本輪新 finding 處置：依 `code-review-checklist.md` §Finding Disposition Discipline「Bounded rereview 新 finding 處置」；追得到 repair delta／dependency closure 且 in-scope 的 trivial-fixable 新 Suggestion 標 closed＋`fix-now` 或 `non-issue-with-evidence`",
    "| Token | 中文語意 |",
  ];
  assert.match(positive, TOKEN_TABLE_ROW, "matcher must catch a copied token definition row");
  for (const line of negatives) {
    assert.doesNotMatch(line, TOKEN_TABLE_ROW, `matcher must allow legitimate line: ${line}`);
  }
  assert.ok(
    linesOf(CHECKLIST).some((line) => TOKEN_TABLE_ROW.test(line)),
    `matcher must recognize the live token definition table in ${CHECKLIST}`,
  );

  const tokenTableRows = linesOf(DISPATCH_BLOCKS).filter((line) => TOKEN_TABLE_ROW.test(line));
  assert.equal(
    tokenTableRows.length,
    0,
    `dispatch block must not copy the disposition token definition table rows; found: ${tokenTableRows.join(" | ")}`,
  );
});

test("Suggestion-only small fixes stay in the same change", () => {
  const line = exactlyOneLine(linesOf(CHECKLIST), "**Suggestion-only 複審範圍**", CHECKLIST);
  assert.match(line, /in-scope[^\n]*trivial-fixable[^\n]*MUST[^\n]*fix-now[^\n]*同一 change[^\n]*MUST NOT[^\n]*另開 change[^\n]*預設 follow-up/);
});

test("bounded review starts at the predecessor and reads only repair hunks with necessary closure", () => {
  const line = exactlyOneLine(linesOf(CHECKLIST), "**複審材料起點**", CHECKLIST);
  assert.match(line, /route=bounded[^\n]*MUST[^\n]*surface_base_sha[^\n]*predecessor[^\n]*candidate_head_sha[^\n]*diff hunks[^\n]*必要上下文[^\n]*dependency closure[^\n]*MUST NOT[^\n]*整份 Touch[^\n]*未改動區塊/);
  assert.match(line, /完整檔案雜湊[^\n]*不變/);
});

test("bounded admission and dispatch distinguish scope from full requirement anchors", () => {
  const line = exactlyOneLine(linesOf(DISPATCH_BLOCKS), 'evidence_scope: <full:', DISPATCH_BLOCKS);
  assert.match(line, /full:[^\n]*touch_list[^\n]*bounded:[^\n]*sealed manifests[^\n]*repair diff hunks[^\n]*必要上下文/);
  const pointer = exactlyOneLine(linesOf(DISPATCH_BLOCKS), '**Bounded material preparation**', DISPATCH_BLOCKS);
  assert.match(pointer, /code-review-checklist\.md[^\n]*小修與 bounded 複審範圍[^\n]*touch_list[^\n]*需求 referent[^\n]*不擴大閱讀範圍/);
});

test("Suggestion-only narrowing retains classifier full-reopen authority", () => {
  const line = exactlyOneLine(linesOf(CHECKLIST), "**範圍升級**", CHECKLIST);
  assert.match(line, /classify-bounded[^\n]*MUST[^\n]*sealed manifests[^\n]*mandatory-full[^\n]*Suggestion[^\n]*MUST NOT[^\n]*手改[^\n]*bounded/);
  const scenario = scenarioSection(linesOf(CANONICAL_SPEC), "#### Scenario: Small Suggestion Does Not Waive Mandatory Full Reopen", CANONICAL_SPEC);
  assert.match(scenario, /WHEN[^\n]*classify-bounded[^\n]*full/);
  assert.match(scenario, /THEN[^\n]*MUST NOT[^\n]*bounded/);
});

test("canonical Suggestion-only fix and bounded reading scenarios are operative", () => {
  const lines = linesOf(CANONICAL_SPEC);
  const fix = scenarioSection(lines, "#### Scenario: Suggestion-Only Fix Stays In The Same Change With Narrow Review", CANONICAL_SPEC);
  assert.match(fix, /GIVEN[^\n]*Suggestion[^\n]*fix-now[^\n]*same change/);
  assert.match(fix, /WHEN[^\n]*sealed manifests[^\n]*route=bounded/);
  assert.match(fix, /THEN[^\n]*MUST[^\n]*predecessor[^\n]*repair diff hunks[^\n]*necessary context[^\n]*dependency closure/);
  const scope = scenarioSection(lines, "#### Scenario: Full Requirement Anchors Do Not Broaden Bounded Reading", CANONICAL_SPEC);
  assert.match(scope, /THEN[^\n]*MUST NOT[^\n]*whole Touch[^\n]*unmodified blocks/);
});

test("cost stop-loss keeps small Suggestions in the existing repair batch", () => {
  const path = "openspec/specs/workflow-cost-controls/spec.md";
  const scenario = scenarioSection(linesOf(path), "#### Scenario: Primary Receipt Freezes Accepted Batch", path);
  assert.match(scenario, /AND[^\n]*trivial-fixable[^\n]*Suggestion[^\n]*MUST[^\n]*fix-now[^\n]*same change/);
  assert.doesNotMatch(scenario, /MUST[^\n]*move to follow-up/);
});

test("cost stop-loss preserves non-fix-now disposition and full-review protection", () => {
  const path = "openspec/specs/workflow-cost-controls/spec.md";
  const scenario = scenarioSection(linesOf(path), "#### Scenario: Primary Receipt Freezes Accepted Batch", path);
  assert.match(scenario, /AND[^\n]*other nonblocking[^\n]*non-trivial Suggestions[^\n]*MAY[^\n]*disposition[^\n]*owner follow-up/);
  assert.match(scenario, /AND[^\n]*MUST NOT alone change behavior-risk digest or trigger full review/);
});
