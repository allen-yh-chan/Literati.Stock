/**
 * capability-retire-archive-grep.test.mjs
 *
 * Prove-it for #1984 / clarify-capability-retire-archive:
 * locks Capability retirement recipe SSOT + quality/devpro:pre-pr pointers
 * + change delta ADDED requirement (design D6 + D8–D10).
 *
 * REQUIRED: recipe / path B forbid / REMOVED timing / two-row abort triage /
 * abort atomicity / immutable change-base restore / Purpose preamble direct-edit /
 * pointer-only (no full triage-table duplicate in quality or devpro:pre-pr).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readSpecWithDelta } from "./lib/spec-delta-reader.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const changeName = "clarify-capability-retire-archive";
const capability = "openspec-flow";

const ARCHIVE_PRINCIPLES =
  ".devpro/agent-rules/openspec-archive-principles.md";
const QUALITY = ".devpro/agent-rules/openspec-quality-and-formats.md";
const SECTION_HEADING =
  "### 第三點六步段：Spec Freeze Archive + Archive Gate Check";


function prePrStep36Section() {
  // 第三點六步段 lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const content = readPrePrSkillFullReadingOrder();
  const lines = content.split("\n");
  const startLine = lines.findIndex((l) => l.startsWith(SECTION_HEADING));
  if (startLine === -1) return null;
  const endLine = lines.findIndex((l, i) => i > startLine && /^### /.test(l));
  return lines
    .slice(startLine, endLine === -1 ? undefined : endLine)
    .join("\n");
}

/** Full dual-column abort triage table header (SSOT-only; D10). */
function hasFullAbortTriageTable(body) {
  return (
    /\|[^\n]*(?:Abort|症狀)[^\n]*\|[^\n]*(?:修復|recipe)[^\n]*\|/i.test(body) ||
    /\|[^\n]*(?:修復|recipe)[^\n]*\|[^\n]*(?:Abort|症狀)[^\n]*\|/i.test(body)
  );
}

test("openspec-archive-principles.md carries Capability retirement recipe", () => {
  const body = read(ARCHIVE_PRINCIPLES);
  assert.match(
    body,
    /Capability retirement recipe/,
    "missing Capability retirement recipe heading/anchor",
  );
  assert.match(body, /tombstone/, "missing tombstone anchor");
  assert.match(
    body,
    /forbid/i,
    "missing path B forbid anchor (delete-capability / path B context)",
  );
  assert.ok(
    /until archive/i.test(body) ||
      (/remain/i.test(body) && /live/i.test(body)),
    "missing REMOVED timing (until archive OR remain+live)",
  );
  assert.match(
    body,
    /Spec must have at least one requirement/,
    "missing empty-capability abort symptom",
  );
  assert.match(body, /not found/, "missing REMOVED-not-found triage anchor");
  assert.match(
    body,
    /Aborted\. No files were changed\./,
    "missing abort atomicity phrase",
  );
  assert.match(
    body,
    /immutable change-base/,
    "missing immutable change-base restore source",
  );
  assert.match(
    body,
    /origin\/main/,
    "must explicitly forbid origin/main as restore source",
  );
  assert.ok(
    /MUST NOT[\s\S]{0,120}origin\/main|禁[\s\S]{0,80}origin\/main|不得[\s\S]{0,80}origin\/main/i.test(
      body,
    ),
    "origin/main must appear in a forbid/MUST NOT restore context",
  );
  assert.match(body, /Purpose|preamble/, "missing Purpose/preamble anchor");
  assert.ok(
    /preamble[\s\S]{0,80}直改|direct edit[\s\S]{0,80}preamble|preamble-direct-edit|直改[\s\S]{0,80}preamble/i.test(
      body,
    ),
    "missing Purpose preamble direct-edit mechanism",
  );
  assert.ok(
    hasFullAbortTriageTable(body),
    "SSOT must carry the dual-column abort triage table",
  );
});

test("openspec-quality-and-formats.md Writing Spec Deltas pointers to retirement recipe only", () => {
  const body = read(QUALITY);
  const writingIdx = body.indexOf("### Writing Spec Deltas");
  assert.ok(writingIdx !== -1, "### Writing Spec Deltas missing");
  const nextHeading = body.indexOf("\n### ", writingIdx + 1);
  const section =
    nextHeading === -1
      ? body.slice(writingIdx)
      : body.slice(writingIdx, nextHeading);
  assert.match(
    section,
    /openspec-archive-principles/,
    "Writing Spec Deltas must pointer to openspec-archive-principles",
  );
  assert.ok(
    /retire|tombstone|Capability retirement/i.test(section),
    "Writing Spec Deltas pointer must mention retire/tombstone/Capability retirement",
  );
  assert.ok(
    !hasFullAbortTriageTable(section),
    "quality Writing Spec Deltas must NOT duplicate full abort triage table (D10)",
  );
  assert.ok(
    !hasFullAbortTriageTable(body),
    "quality file must NOT duplicate full abort triage table (D10)",
  );
});

test("devpro:pre-pr Step 3.6 has short retire check + pointer (no full triage table)", () => {
  const section = prePrStep36Section();
  assert.ok(section, `missing heading ${SECTION_HEADING}`);
  assert.ok(
    section.includes("tombstone") ||
      section.includes("REMOVED still on live"),
    "Step 3.6 must mention tombstone or REMOVED still on live",
  );
  assert.match(
    section,
    /openspec-archive-principles/,
    "Step 3.6 must pointer to openspec-archive-principles",
  );
  assert.ok(
    !hasFullAbortTriageTable(section),
    "devpro:pre-pr Step 3.6 must NOT duplicate full abort triage table (D10)",
  );
});

test("change delta / promoted contract ADDS Capability Retirement Archive Recipe", () => {
  const body = readSpecWithDelta(capability, { changeName });
  assert.match(
    body,
    /Capability Retirement Archive Recipe/,
    "missing ADDED requirement title Capability Retirement Archive Recipe",
  );
});
