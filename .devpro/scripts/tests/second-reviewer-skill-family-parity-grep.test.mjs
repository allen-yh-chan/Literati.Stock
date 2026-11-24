/**
 * second-reviewer-skill-family-parity-grep.test.mjs
 *
 * Locks the common `devpro:second-review` skill SSOT's OWN internal consistency:
 * the `primary_family` value set enumerated in the §Reviewer Selection table MUST
 * equal the `primary_family` case set enumerated in the §Cursor And Other Hosts
 * resolution subsection.
 *
 * Root cause: PR #1530 (fix-second-reviewer-projection-ssot) added the `gemini`/`other`
 * row to the reviewer-selection table but the Cursor subsection was momentarily missing
 * that branch — a self-contradiction inside the single SSOT file, caught only by manual
 * cross-review with no mechanical guard. This test is that guard.
 *
 * Companion to second-reviewer-projection-contract.test.mjs — that test locks the cross-
 * projection ROUTE CHAIN anchors (.claude/.codex/.cursor → adapters); this test locks the
 * common skill's INTERNAL table↔subsection family-set equality. Non-overlapping scope.
 *
 * STRENGTH: this is a set-equality guard, not a literal-presence guard. Deleting a
 * `primary_family` case from either surface (or adding one to only one surface) makes the
 * two extracted sets differ and turns the test red. The values-cover assertion additionally
 * pins the canonical family set so silently renaming a case on BOTH surfaces still fails.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";
const SKILL_REL =
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
// Host routes (incl. §Cursor And Other Hosts) live in references/; rebuild the full skill text.
const skill = readSecondReviewSkillWithHostRoutes();

// Canonical primary_family set the SSOT must enumerate on both surfaces.
// `gemini` / `other` share one row/bullet, so they are normalized to a single "gemini/other" token.
const CANONICAL_FAMILIES = ["claude", "openai-codex", "gemini/other", "unknown"];

/**
 * Slice a Markdown section body: from the given heading line up to (but excluding)
 * the next heading of the same-or-higher level. Throws if the heading is absent so a
 * heading rename can never silently degrade this test into a no-op.
 */
function sliceSection(content, headingText) {
  const idx = content.indexOf(headingText);
  assert.notEqual(
    idx,
    -1,
    `${SKILL_REL} missing expected heading/anchor: "${headingText}"`
  );
  const after = content.slice(idx + headingText.length);
  // Next heading line (### or ##) ends the section.
  const nextHeading = after.search(/\n#{2,3} /);
  return nextHeading === -1 ? after : after.slice(0, nextHeading);
}

/** Normalize a raw family token: strip backticks/whitespace, collapse "gemini / other" → "gemini/other". */
function normalizeFamily(raw) {
  return raw
    .replace(/`/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** Extract the Primary family column values from the §Reviewer Selection table. */
function familiesFromTable(content) {
  const section = sliceSection(content, "預設選 different-family reviewer");
  const families = new Set();
  for (const line of section.split("\n")) {
    // Table data rows start with "| `<family>`"; skip header/separator rows.
    const m = line.match(/^\|\s*(`[^|]+`(?:\s*\/\s*`[^|]+`)?)\s*\|/);
    if (!m) continue;
    families.add(normalizeFamily(m[1]));
  }
  return families;
}

/** Extract the primary_family= case values from the §Cursor And Other Hosts subsection. */
function familiesFromCursorSubsection(content) {
  const section = sliceSection(content, "### Cursor And Other Hosts");
  const families = new Set();
  const re = /primary_family=([a-z-]+(?:`?\s*\/\s*`?[a-z-]+)?)/gi;
  let m;
  while ((m = re.exec(section)) !== null) {
    families.add(normalizeFamily(m[1]));
  }
  return families;
}

describe("devpro:second-review common skill SSOT internal family parity", () => {
  it("§Reviewer Selection table enumerates the canonical primary_family set", () => {
    const tableFamilies = familiesFromTable(skill);
    assert.deepEqual(
      [...tableFamilies].sort(),
      [...CANONICAL_FAMILIES].sort(),
      `reviewer-selection table primary_family set drifted from canonical`
    );
  });

  it("§Cursor And Other Hosts subsection enumerates the canonical primary_family set", () => {
    const cursorFamilies = familiesFromCursorSubsection(skill);
    assert.deepEqual(
      [...cursorFamilies].sort(),
      [...CANONICAL_FAMILIES].sort(),
      `Cursor subsection primary_family case set drifted from canonical`
    );
  });

  it("table and Cursor-subsection primary_family sets are equal to each other", () => {
    const tableFamilies = familiesFromTable(skill);
    const cursorFamilies = familiesFromCursorSubsection(skill);
    assert.deepEqual(
      [...tableFamilies].sort(),
      [...cursorFamilies].sort(),
      `SKILL SSOT self-contradiction: reviewer-selection table and Cursor subsection ` +
        `enumerate different primary_family sets (this is exactly the #1530 drift class)`
    );
  });
});
