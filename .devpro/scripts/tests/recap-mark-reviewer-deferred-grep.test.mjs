/**
 * recap-mark-reviewer-deferred-grep.test.mjs
 *
 * MAINTENANCE NOTE:
 * This test locks session-recap.md's rule that "subagent review deferred finding
 * is a MUST-mark trigger source" and "deferred ≠ 免發落（not exempt from disposition）".
 *
 * Specifically it guards:
 *   - Rule-improvement source list: 「本 session 是否有可行的規範改進（來源：...）」那行
 *     MUST contain "subagent review deferred finding"
 *   - In-Session Correction Log trigger sentence MUST contain
 *     "subagent review（dp-reviewer / cross-model second-opinion）提出 finding（Suggestion / Important）而 TL 判 deferred / out-of-scope"
 *   - The blockquote "reviewer 標 deferred ≠ TL 免發落" MUST be present as explicit text
 *   - Structural position: subagent-review marker trigger appears AFTER "### In-Session Correction Log" heading
 *   - Regression guards: 規範改進發落 text, [RULE-FEEDBACK] marker format, heading all still present
 *
 * If session-recap.md is refactored (section renamed, wording changed), update this test
 * to match the new literals. Do NOT change the rule file to match the test.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
const recapPath = path.join(
  REPO_ROOT,
  ".devpro/agent-rules/session-recap.md"
);

const recapBody = readFileSync(recapPath, "utf8");

// ── Section slice: In-Session Correction Log ─────────────────────────────────
// Slice from "### In-Session Correction Log" heading to "### 寫入方式" heading.
// Assertions A1–A3 operate on this slice so that deleting the trigger sentence
// from the section causes FAIL even if the same string survives elsewhere in
// the file (e.g., the rule-improvement source line or the Requirement Ledger template).
const CORRECTION_LOG_HEADING = "### In-Session Correction Log";
const CORRECTION_LOG_END_HEADING = "### 寫入方式";

const correctionLogStart = recapBody.indexOf(CORRECTION_LOG_HEADING);
const correctionLogEnd = recapBody.indexOf(
  CORRECTION_LOG_END_HEADING,
  correctionLogStart
);
// Build the section slice (assert headings exist first — done in regression B3).
// If either marker is absent the slice falls back to empty string, which causes
// the content assertions below to fail with a clear message.
const correctionLogSection =
  correctionLogStart !== -1 && correctionLogEnd !== -1
    ? recapBody.slice(correctionLogStart, correctionLogEnd)
    : "";

// ── A. Reviewer-originated deferred finding as MUST-mark trigger ─────────────

// A1. In-Session Correction Log section trigger sentence contains "subagent review",
//     "dp-reviewer", and "cross-model" (reviewer-originated deferred finding
//     is a MUST-mark trigger source).
//     Scoped to the section slice so that removing the trigger sentence from
//     the section causes FAIL even if the same string exists elsewhere in the file.
test("session-recap.md: In-Session Correction Log section contains 'subagent review', 'dp-reviewer', 'cross-model'", () => {
  assert.ok(
    correctionLogSection.length > 0,
    `"${CORRECTION_LOG_HEADING}" … "${CORRECTION_LOG_END_HEADING}" section slice is empty — both headings must be present`
  );
  assert.ok(
    correctionLogSection.includes("subagent review"),
    `expected In-Session Correction Log section to contain "subagent review" (reviewer-originated deferred finding trigger source)`
  );
  assert.ok(
    correctionLogSection.includes("dp-reviewer"),
    `expected In-Session Correction Log section to contain "dp-reviewer" (specific reviewer subagent named in trigger)`
  );
  assert.ok(
    correctionLogSection.includes("cross-model"),
    `expected In-Session Correction Log section to contain "cross-model" (cross-model second-opinion reviewer named in trigger)`
  );
});

// A2. In-Session Correction Log section contains the blockquote
//     "reviewer 標 deferred ≠ TL 免發落" (deferred ≠ exempt from disposition).
//     Scoped to the section slice for the same reason as A1.
test("session-recap.md: In-Session Correction Log section contains 'reviewer 標 deferred ≠ TL 免發落' (deferred ≠ 免發落 明文)", () => {
  assert.ok(
    correctionLogSection.length > 0,
    `"${CORRECTION_LOG_HEADING}" … "${CORRECTION_LOG_END_HEADING}" section slice is empty`
  );
  assert.ok(
    correctionLogSection.includes("reviewer 標 deferred ≠ TL 免發落"),
    `expected In-Session Correction Log section to contain "reviewer 標 deferred ≠ TL 免發落" (explicit deferred ≠ exempt blockquote)`
  );
});

// A3. In-Session Correction Log section trigger sentence contains "deferred"
//     and "out-of-scope" (TL判 deferred / out-of-scope findings are covered).
//     Scoped to section slice: "deferred" also appears in the Requirement Ledger
//     template (disposition counts line) outside this section, so whole-file
//     assert is weaker.
test("session-recap.md: In-Session Correction Log section contains 'deferred' and 'out-of-scope'", () => {
  assert.ok(
    correctionLogSection.length > 0,
    `"${CORRECTION_LOG_HEADING}" … "${CORRECTION_LOG_END_HEADING}" section slice is empty`
  );
  assert.ok(
    correctionLogSection.includes("deferred"),
    `expected In-Session Correction Log section to contain "deferred" (TL判 deferred finding trigger)`
  );
  assert.ok(
    correctionLogSection.includes("out-of-scope"),
    `expected In-Session Correction Log section to contain "out-of-scope" (TL判 out-of-scope finding trigger)`
  );
});

// A4. Rule-improvement source list line contains "subagent review deferred finding"
test("session-recap.md: rule-improvement source line contains 'subagent review deferred finding'", () => {
  const sourceLineStart = recapBody.indexOf("本 session 是否有可行的規範改進（來源");
  assert.ok(
    sourceLineStart !== -1,
    `expected session-recap.md to contain "本 session 是否有可行的規範改進（來源" (rule-improvement source list line not found)`
  );

  // Extract from that position to end-of-line
  const lineEnd = recapBody.indexOf("\n", sourceLineStart);
  const sourceLine = lineEnd !== -1
    ? recapBody.slice(sourceLineStart, lineEnd)
    : recapBody.slice(sourceLineStart);

  assert.ok(
    sourceLine.includes("subagent review deferred finding"),
    `rule-improvement source list line does not contain "subagent review deferred finding"; actual line: ${sourceLine}`
  );
});

// A5. Structural position: "subagent review" marker trigger source appears
//     AFTER "### In-Session Correction Log" heading (indexOf comparison)
test("session-recap.md: 'subagent review' trigger source appears after '### In-Session Correction Log' heading", () => {
  const headingMarker = "### In-Session Correction Log";
  const subagentMarker = "subagent review（dp-reviewer / cross-model second-opinion）";

  const headingIdx = recapBody.indexOf(headingMarker);
  const subagentIdx = recapBody.indexOf(subagentMarker);

  assert.ok(
    headingIdx !== -1,
    `"### In-Session Correction Log" heading not found — regression`
  );
  assert.ok(
    subagentIdx !== -1,
    `"subagent review（dp-reviewer / cross-model second-opinion）" not found`
  );
  assert.ok(
    headingIdx < subagentIdx,
    `"subagent review" trigger (pos=${subagentIdx}) must appear AFTER "### In-Session Correction Log" heading (pos=${headingIdx})`
  );
});

// ── B. Regression guards ──────────────────────────────────────────────────────

// B1. 規範改進發落 text still present
test("session-recap.md regression: 規範改進發落 closure text still present", () => {
  assert.ok(
    recapBody.includes("若 5=是，是否已完成 issue 決策") &&
      recapBody.includes("第 6 點未閉環前禁止回覆完成"),
    `regression: 規範改進發落 closure text missing from session-recap.md`
  );
});

// B2. session-pending follow-up format present (marker 退場，改記 session-pending)
// fix-session-pending-item-parse r1 finding F-SPI-01: session-recap.md is the
// third item-minting carrier, and asserting only the `待追蹤：` token let its
// column-0 `- 待追蹤：` shape stand while the other two carriers moved to `## `
// H2 openers. A record written in the old shape is absorbed by the preceding
// `## ` section — it stops being an independently claimable item — and is
// refused by Gate NS. So lock the opener shape, not just the token.
test("session-recap.md regression: session-pending follow-up format still present", () => {
  assert.ok(
    recapBody.includes("notes/session-pending.md") && recapBody.includes("待追蹤："),
    `regression: session-pending follow-up format missing from session-recap.md`
  );
  assert.ok(
    recapBody.includes("`## 待追蹤："),
    `regression: session-recap.md must state the follow-up opener as a \`## \` H2 heading`
  );
  assert.ok(
    !recapBody.includes("`- 待追蹤："),
    `regression: session-recap.md must not mandate a column-0 \`- 待追蹤：\` opener — such a record is absorbed by the preceding section and refused by Gate NS`
  );
});

// B3. ### In-Session Correction Log heading still present
test("session-recap.md regression: '### In-Session Correction Log' heading still present", () => {
  assert.ok(
    recapBody.includes("### In-Session Correction Log"),
    `regression: "### In-Session Correction Log" heading missing from session-recap.md`
  );
});
