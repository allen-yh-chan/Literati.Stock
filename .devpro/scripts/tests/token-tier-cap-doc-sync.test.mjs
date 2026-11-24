import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TIERS } from "../lib/rule-token-budget.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// Sync-assertion guard for token tier caps (convergence-loop Round 2 W7-F1).
//
// SSOT for tier caps is the production `TIERS` registry. The registration
// table in rule-file-template.md literal-copies core/next/small numbers, so a
// future policy change could silently drift the authoring guidance. Import the
// production values directly; tests are consumers, never the registry SSOT.

const rulesDir = path.join(REPO_ROOT, ".devpro", "agent-rules");
describe("token tier cap doc sync (W7-F1)", () => {
  it("rule-file-template.md registration table matches the production TIERS caps", async () => {
    const caps = Object.fromEntries(
      ["core", "next", "small"].map((tier) => [tier, TIERS[tier].maxTokens]),
    );

    // Guard against a silent parse degrade: SSOT must actually yield the three tier caps.
    assert.equal(Object.keys(caps).length, 3, "expected core/next/small caps parsed from SSOT");
    for (const tier of ["core", "next", "small"]) {
      assert.ok(Number.isInteger(caps[tier]) && caps[tier] > 0, `SSOT cap for ${tier} must be a positive integer`);
    }
    const docs = {
      "rule-file-template.md": await fs.readFile(path.join(rulesDir, "rule-file-template.md"), "utf8"),
    };

    // The registration doc carries MORE THAN ONE cap table (e.g. a tier-cap table and a
    // tier|cap|body-cap table). In every such table the cap is the FIRST 3-5 digit number
    // AFTER the tier name on the row; later numbers on the same row are derived (body-cap
    // 7050/2550/1050 = cap-450) or per-file overrides (8500). So on each table row that names
    // exactly one tier, we take the first number following that tier token and assert it equals
    // the tier's SSOT cap. Taking the first-after-tier number (not "any known cap value") means
    // a cap corrupted to a non-cap magnitude (e.g. 7500→9999) is still caught, not skipped.
    // Each tier must be asserted by at least one real row per doc (structure-disappeared guard).
    for (const [docName, text] of Object.entries(docs)) {
      const seenPerTier = { core: 0, next: 0, small: 0 };
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("|") || /^\|[\s|:-]+\|?$/.test(line)) continue; // skip non-rows and separator rows
        const namedTiers = ["core", "next", "small"].filter((t) => new RegExp(`\\b${t}\\b`).test(line));
        if (namedTiers.length !== 1) continue; // ambiguous / no tier on this row
        const tier = namedTiers[0];
        const afterTier = line.slice(line.search(new RegExp(`\\b${tier}\\b`)) + tier.length);
        const firstNum = afterTier.match(/\b\d{3,5}\b/); // the cap column
        if (!firstNum) continue; // tier-naming row with no trailing number (e.g. a header) — not a cap row
        assert.equal(
          Number(firstNum[0]),
          caps[tier],
          `${docName}: tier "${tier}" cap column states ${firstNum[0]} but TIERS SSOT is ${caps[tier]} (doc↔gate drift)\n  row: ${line}`,
        );
        seenPerTier[tier] += 1;
      }
      for (const tier of ["core", "next", "small"]) {
        assert.ok(
          seenPerTier[tier] >= 1,
          `${docName}: expected at least one table row asserting the "${tier}" cap (found 0 — did the cap table disappear or restructure?)`,
        );
      }
    }
  });
});
