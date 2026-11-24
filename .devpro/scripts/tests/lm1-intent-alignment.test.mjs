/**
 * LM-1 Intent Alignment Gate
 *
 * Validates that leaf §subsections claiming to be triggered by a specific user
 * intent are reachable via the AGENTS.md trigger index (§觸發式載入索引).
 *
 * Fills the granularity gap left by agents-md-index-mapping.test.mjs:
 *   - Existing test: verifies every rule *file* has at least one AGENTS index row.
 *   - This test: verifies that a *subsection* which declares a specific user intent
 *     trigger has matching keywords in the AGENTS index row that points to its leaf.
 *
 * Architecture:
 *   validateIntentAlignment(leafContent, indexRows, registry) — pure function, no I/O.
 *   INTENT_CLAIM_REGISTRY — opt-in list; only register §subsections that explicitly
 *     claim to be triggered by a specific user intent (not every ###).
 *     Only register leaves that bear a specific user-intent trigger claim;
 *     not every leaf needs an entry (most are covered by agents-md-index-mapping.test.mjs).
 *
 * Prove-it cases (per testing-and-qa.md Bug 修復 Prove-It Pattern, adapted for feature):
 *   (a) orphan fixture — leaf claims intent but has no AGENTS row → validator failure
 *   (b) aligned fixture — leaf claims intent and has matching row → null (pass)
 *   (c) dogfood case — registry-driven against real repo files, asserts both new
 *       leaves are aligned (prevents this change from being its own LM-1 orphan)
 *
 * Avoid dogfood loop: FORBIDDEN regex patterns (email/path) use RegExp
 * constructor (per Bundle B+C pattern) — no literal FORBIDDEN regex strings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

// ---------------------------------------------------------------------------
// Pure validator — no file I/O
// ---------------------------------------------------------------------------

/**
 * Check whether a leaf §subsection's claimed user intent aligns with the
 * AGENTS.md trigger index.
 *
 * @param {string} _leafContent  - Full text of the leaf file (unused in pure
 *   mode; reserved for future phrase-extraction logic).
 * @param {string[]} indexRows   - Rows from the AGENTS.md trigger index table.
 *   Each row is a raw pipe-delimited markdown table line, e.g.
 *   "|審查/盤點/rationalize rules|`rule-audit-playbook.md`|"
 * @param {RegistryEntry[]} registry - Opt-in declarations (see INTENT_CLAIM_REGISTRY).
 * @returns {string | null}  null = all claims aligned; string = first failure message.
 *
 * @typedef {{ leafFile: string, sectionAnchor: string, claimedIntentKeywords: string[] }} RegistryEntry
 */
export function validateIntentAlignment(_leafContent, indexRows, registry) {
  for (const entry of registry) {
    const { leafFile, sectionAnchor, claimedIntentKeywords } = entry;

    // Find the AGENTS index row(s) that reference this leaf file. Refs may be
    // root leaves (`x.md`) or subdir leaves (`platform-adapters/x.md`).
    const matchingRows = indexRows.filter((row) =>
      [...row.matchAll(/`([^`]+\.md)`/g)].some((match) =>
        match[1].split("/").pop() === leafFile
      )
    );

    if (matchingRows.length === 0) {
      return (
        `LM-1 orphan: §${sectionAnchor} (in ${leafFile}) claims user intent ` +
        `[${claimedIntentKeywords.join(", ")}] but ${leafFile} has no row in ` +
        `AGENTS.md trigger index at all.`
      );
    }

    // Collect all intent/context keywords from the matching rows (first cell).
    const indexKeywords = matchingRows.flatMap((row) => {
      // Extract the first pipe-delimited cell (the "情境" cell).
      const firstCell = row.split("|")[1] ?? "";
      // Split on CJK punctuation, semicolons, slashes, spaces for keyword extraction.
      return firstCell.split(/[；;\/\s　、，,]+/).map((k) => k.trim()).filter(Boolean);
    });

    // EVERY claimed keyword must be reachable in the index (not just any one).
    // Rationale: .some()/any-intersection has a blind spot — if a registry lists
    // ["審查","盤點","rationalize"] but the AGENTS row only carries 審查+rationalize,
    // any-intersection passes green while a user typing "盤點 rules" still misses the
    // router — the exact LM-1/LM-4 orphan class this gate exists to close. Require
    // each declared intent keyword to have a matching index keyword (cross-model
    // PR #1014 finding).
    const unreachable = claimedIntentKeywords.filter((claimed) =>
      !indexKeywords.some((indexed) => indexed.includes(claimed) || claimed.includes(indexed))
    );

    if (unreachable.length > 0) {
      return (
        `LM-1 intent mismatch: §${sectionAnchor} (in ${leafFile}) claims to be ` +
        `triggered by user intent(s) [${unreachable.join(", ")}], but no AGENTS.md row ` +
        `pointing to ${leafFile} contains those keyword(s). ` +
        `Index keywords found: [${indexKeywords.join(", ")}]. ` +
        `Fix: add the missing trigger keyword(s) to the matching AGENTS.md row's 情境 cell, ` +
        `or remove them from the §${sectionAnchor} intent claim.`
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// INTENT_CLAIM_REGISTRY
//
// Opt-in: only register §subsections that explicitly claim to be triggered by
// a specific user intent (i.e., the subsection's purpose is scoped to that intent).
// Do NOT register every ### heading — only those with an intent-trigger claim.
// Most leaves are covered by agents-md-index-mapping.test.mjs at file level;
// this registry adds intent-level granularity for selected high-value leaves.
//
// Format: { leafFile, sectionAnchor, claimedIntentKeywords }
//   leafFile            — basename of the rule leaf (e.g. "rule-audit-playbook.md")
//   sectionAnchor       — heading text used to locate the subsection
//   claimedIntentKeywords — keywords a user would type to trigger this leaf
// ---------------------------------------------------------------------------

/** @type {RegistryEntry[]} */
const INTENT_CLAIM_REGISTRY = [
  // rule-audit-playbook.md — claims: triggered when user says
  // "審查/盤點/rationalize rules / rule corpus 治理".
  // AGENTS.md audit row (added by enforce-rationalization-loadpath) contains
  // those keywords → aligned.
  {
    leafFile: "rule-audit-playbook.md",
    sectionAnchor: "Cadence",
    claimedIntentKeywords: ["審查", "盤點", "rationalize"],
  },
  // rule-ingest-methodology.md — claims: triggered when user says
  // "ingest 外部 reference/業界方法".
  // AGENTS.md ingest row (added by enforce-rationalization-loadpath) contains
  // those keywords → aligned.
  {
    leafFile: "rule-ingest-methodology.md",
    sectionAnchor: "Ingest-Mapping Ledger",
    claimedIntentKeywords: ["ingest", "外部"],
  },
  {
    leafFile: "agent-skill-governance.md",
    sectionAnchor: "When to Use",
    claimedIntentKeywords: ["skill"],
  },
  {
    leafFile: "codex-host-cross-review.md",
    sectionAnchor: "觸發",
    claimedIntentKeywords: ["cross-review"],
  },
  {
    leafFile: "openspec-flow-consumer.md",
    sectionAnchor: "When to Use",
    claimedIntentKeywords: ["consumer", "rules", "Program"],
  },
  {
    leafFile: "openspec-quality-and-formats.md",
    sectionAnchor: "When to Use",
    claimedIntentKeywords: ["OpenSpec", "tasks", "quality"],
  },
  {
    leafFile: "pr-review-evidence-verification.md",
    sectionAnchor: "When to Use",
    claimedIntentKeywords: ["thread", "evidence"],
  },
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Simulated AGENTS.md rows for unit fixtures (pure, no I/O).
const FIXTURE_AUDIT_ROW =
  "|審查/盤點/rationalize rules|`rule-audit-playbook.md`|";
const FIXTURE_INGEST_ROW =
  "|ingest 外部 reference/業界方法|`rule-ingest-methodology.md`|";
const FIXTURE_UNRELATED_ROW =
  "|其他情境|`some-other-leaf.md`|";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateIntentAlignment — pure validator", () => {
  // ─── (b) Aligned fixture → null ─────────────────────────────────────────
  it("(b) returns null when claimed intent keywords match an AGENTS index row (aligned)", () => {
    const registry = [
      {
        leafFile: "rule-audit-playbook.md",
        sectionAnchor: "Cadence",
        claimedIntentKeywords: ["審查", "rationalize"],
      },
    ];

    const result = validateIntentAlignment("", [FIXTURE_AUDIT_ROW], registry);
    assert.strictEqual(result, null, `Expected null (aligned) but got: ${result}`);
  });

  // ─── (a-i) Orphan fixture: leaf has no row at all ───────────────────────
  it("(a-i) returns failure message when leaf has no matching AGENTS row at all (total orphan)", () => {
    const registry = [
      {
        leafFile: "rule-audit-playbook.md",
        sectionAnchor: "Cadence",
        claimedIntentKeywords: ["審查", "rationalize"],
      },
    ];

    const result = validateIntentAlignment("", [FIXTURE_UNRELATED_ROW], registry);
    assert.ok(
      typeof result === "string" && result.length > 0,
      "Expected a failure message string for total orphan"
    );
    assert.ok(
      result.includes("rule-audit-playbook.md"),
      `Failure message should mention the orphan leaf file; got: ${result}`
    );
    assert.ok(
      result.includes("LM-1 orphan"),
      `Failure message should include 'LM-1 orphan'; got: ${result}`
    );
  });

  // ─── (a-ii) Orphan fixture: leaf is indexed but intent keywords absent ───
  it("(a-ii) returns failure message when leaf is indexed but intent keywords are absent (LM-4 mismatch)", () => {
    // Leaf is in index but claimed keywords are not in 情境 cell.
    const wrongRow = "|設計 rule/hook|`rule-audit-playbook.md`|";

    const registry = [
      {
        leafFile: "rule-audit-playbook.md",
        sectionAnchor: "Cadence",
        claimedIntentKeywords: ["審查", "rationalize"],
      },
    ];

    const result = validateIntentAlignment("", [wrongRow], registry);
    assert.ok(
      typeof result === "string" && result.length > 0,
      "Expected a failure message for LM-4 mismatch (indexed but intent keywords missing)"
    );
    assert.ok(
      result.includes("Cadence"),
      `Failure message should mention the mismatched section; got: ${result}`
    );
    assert.ok(
      result.includes("intent mismatch"),
      `Failure message should include 'intent mismatch'; got: ${result}`
    );
  });

  // ─── (b-ingest) Ingest aligned ──────────────────────────────────────────
  it("(b) returns null when ingest leaf claimed keywords match AGENTS row", () => {
    const registry = [
      {
        leafFile: "rule-ingest-methodology.md",
        sectionAnchor: "Ingest-Mapping Ledger",
        claimedIntentKeywords: ["ingest", "外部"],
      },
    ];

    const result = validateIntentAlignment("", [FIXTURE_INGEST_ROW], registry);
    assert.strictEqual(result, null, `Expected null (ingest aligned) but got: ${result}`);
  });

  // ─── Empty registry → null (vacuously true) ─────────────────────────────
  it("returns null for empty registry (vacuously aligned)", () => {
    const result = validateIntentAlignment("", [FIXTURE_AUDIT_ROW], []);
    assert.strictEqual(result, null, "Empty registry should return null");
  });
});

// ---------------------------------------------------------------------------
// Dogfood case (c): registry-driven, reads real repo files
//
// This is the key guard: if the AGENTS.md audit/ingest rows are removed or
// their 情境 keywords are changed to not contain the leaf's claimed intent,
// this test turns red.
// ---------------------------------------------------------------------------

describe("validateIntentAlignment — dogfood (real repo)", () => {
  const AGENTS_PATH = repoPath("AGENTS.md");

  /**
   * Extract trigger index rows from AGENTS.md.
   * Returns pipe-delimited table rows from §觸發式載入索引.
   */
  function extractRealIndexRows() {
    assert.ok(
      existsSync(AGENTS_PATH),
      `AGENTS.md must exist at: ${AGENTS_PATH}`
    );
    const content = readFileSync(AGENTS_PATH, "utf8");
    const section = content.match(/## 觸發式載入索引[\s\S]*?\n---/);
    assert.ok(section, "AGENTS.md must contain 觸發式載入索引 section");

    const directRows = section[0]
      .split("\n")
      .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line))
      .slice(1); // skip header row

    const expandedRows = [...directRows];
    for (const row of directRows) {
      const intentCell = row.split("|")[1] ?? "";
      const refs = [...row.matchAll(/`([^`]+\.md)`/g)].map((match) => match[1]);
      for (const ref of refs) {
        if (ref.includes("*")) continue;
        const relPath = ref.startsWith(".devpro/agent-rules/")
          ? ref.slice(".devpro/agent-rules/".length)
          : ref;
        const leafPath = resolve(REPO_ROOT, ".devpro/agent-rules", relPath);
        if (!existsSync(leafPath)) continue;
        const leafContent = readFileSync(leafPath, "utf8");
        for (const child of leafContent.matchAll(/`([^`]+\.md)`/g)) {
          expandedRows.push(`|${intentCell}|\`${child[1]}\`|`);
        }
      }
    }

    return expandedRows;
  }

  it("(c-audit) rule-audit-playbook.md is reachable via '審查/盤點/rationalize' trigger in real AGENTS.md", () => {
    const indexRows = extractRealIndexRows();

    const registry = [
      {
        leafFile: "rule-audit-playbook.md",
        sectionAnchor: "Cadence",
        claimedIntentKeywords: ["審查", "rationalize"],
      },
    ];

    const result = validateIntentAlignment("", indexRows, registry);
    assert.strictEqual(
      result,
      null,
      `rule-audit-playbook.md is an LM-1 orphan in real AGENTS.md. ` +
        `Add '審查/盤點/rationalize rules' row pointing to rule-audit-playbook.md. ` +
        `Validator says: ${result}`
    );
  });

  it("(c-ingest) rule-ingest-methodology.md is reachable via 'ingest 外部' trigger in real AGENTS.md", () => {
    const indexRows = extractRealIndexRows();

    const registry = [
      {
        leafFile: "rule-ingest-methodology.md",
        sectionAnchor: "Ingest-Mapping Ledger",
        claimedIntentKeywords: ["ingest", "外部"],
      },
    ];

    const result = validateIntentAlignment("", indexRows, registry);
    assert.strictEqual(
      result,
      null,
      `rule-ingest-methodology.md is an LM-1 orphan in real AGENTS.md. ` +
        `Add 'ingest 外部 reference/業界方法' row pointing to rule-ingest-methodology.md. ` +
        `Validator says: ${result}`
    );
  });

  it("(c-registry) full INTENT_CLAIM_REGISTRY is aligned with real AGENTS.md", () => {
    const indexRows = extractRealIndexRows();

    const result = validateIntentAlignment("", indexRows, INTENT_CLAIM_REGISTRY);
    assert.strictEqual(
      result,
      null,
      `INTENT_CLAIM_REGISTRY has misalignment with real AGENTS.md: ${result}`
    );
  });
});
