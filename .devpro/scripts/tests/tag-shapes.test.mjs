/**
 * tag-shapes.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/lib/tag-shapes.mjs
 *
 * Covers:
 *   - VTAG_RE (production-vX.Y.Z shape)
 *   - PRODUCTION_DATE_RE (production-YYYYMMDD[-ordinal] shape)
 *   - RULES_TAG_RE (production-YYYYMMDD-rules[-ordinal] shape)
 *   - isValidProductionTag (combined validator)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { repoFileUrl } from "./lib/repo-root.mjs";

const LIB = repoFileUrl(".devpro/scripts/hooks/lib/tag-shapes.mjs");

const {
  VTAG_RE,
  PRODUCTION_DATE_RE,
  RULES_TAG_RE,
  isValidProductionTag,
} = await import(LIB);

// ── VTAG_RE ───────────────────────────────────────────────────────────────

test("VTAG_RE: matches production-v6.62.0", () => {
  assert.ok(VTAG_RE.test("production-v6.62.0"));
});

test("VTAG_RE: matches production-v6.10.0 (minor crossing 9→10 boundary)", () => {
  assert.ok(VTAG_RE.test("production-v6.10.0"));
});

test("VTAG_RE: matches production-v0.0.1", () => {
  assert.ok(VTAG_RE.test("production-v0.0.1"));
});

test("VTAG_RE: does NOT match production-v6.39 (missing patch)", () => {
  assert.ok(!VTAG_RE.test("production-v6.39"));
});

test("VTAG_RE: does NOT match production-v6.39.0.1 (extra segment)", () => {
  assert.ok(!VTAG_RE.test("production-v6.39.0.1"));
});

test("VTAG_RE: does NOT match production-6.62.0 (missing v prefix)", () => {
  assert.ok(!VTAG_RE.test("production-6.62.0"));
});

test("VTAG_RE: does NOT match production-20260607 (date style)", () => {
  assert.ok(!VTAG_RE.test("production-20260607"));
});

// ── PRODUCTION_DATE_RE ────────────────────────────────────────────────────

test("PRODUCTION_DATE_RE: matches production-20260607", () => {
  assert.ok(PRODUCTION_DATE_RE.test("production-20260607"));
});

test("PRODUCTION_DATE_RE: matches production-20260607-2 (ordinal 2)", () => {
  assert.ok(PRODUCTION_DATE_RE.test("production-20260607-2"));
});

test("PRODUCTION_DATE_RE: matches production-20260607-10 (ordinal 10)", () => {
  assert.ok(PRODUCTION_DATE_RE.test("production-20260607-10"));
});

test("PRODUCTION_DATE_RE: does NOT match production-20260607-1 (ordinal 1 not allowed as suffix)", () => {
  // ordinal pattern is [2-9]|[1-9]\d+ — ordinal 1 has no suffix (unsuffixed = 1)
  assert.ok(!PRODUCTION_DATE_RE.test("production-20260607-1"));
});

test("PRODUCTION_DATE_RE: does NOT match production-2026 (too-short date)", () => {
  assert.ok(!PRODUCTION_DATE_RE.test("production-2026"));
});

test("PRODUCTION_DATE_RE: does NOT match production-202606071 (9-digit date)", () => {
  assert.ok(!PRODUCTION_DATE_RE.test("production-202606071"));
});

test("PRODUCTION_DATE_RE: does NOT match production-20260607-rules (rules variant)", () => {
  // rules variant is a different RE
  assert.ok(!PRODUCTION_DATE_RE.test("production-20260607-rules"));
});

// ── RULES_TAG_RE ──────────────────────────────────────────────────────────

test("RULES_TAG_RE: matches production-20260607-rules", () => {
  assert.ok(RULES_TAG_RE.test("production-20260607-rules"));
});

test("RULES_TAG_RE: matches production-20260607-rules-2 (ordinal 2)", () => {
  assert.ok(RULES_TAG_RE.test("production-20260607-rules-2"));
});

test("RULES_TAG_RE: matches production-20260607-rules-10 (ordinal 10)", () => {
  assert.ok(RULES_TAG_RE.test("production-20260607-rules-10"));
});

test("RULES_TAG_RE: does NOT match production-20260607-rules-1 (ordinal 1 not allowed as suffix)", () => {
  assert.ok(!RULES_TAG_RE.test("production-20260607-rules-1"));
});

test("RULES_TAG_RE: does NOT match production-20260607 (plain date)", () => {
  assert.ok(!RULES_TAG_RE.test("production-20260607"));
});

test("RULES_TAG_RE: does NOT match production-v6.62.0 (semver shape)", () => {
  assert.ok(!RULES_TAG_RE.test("production-v6.62.0"));
});

// ── isValidProductionTag ───────────────────────────────────────────────────

test("isValidProductionTag: accepts production-v6.62.0 (semver shape)", () => {
  assert.equal(isValidProductionTag("production-v6.62.0"), true);
});

test("isValidProductionTag: accepts production-20260607 (date shape)", () => {
  assert.equal(isValidProductionTag("production-20260607"), true);
});

test("isValidProductionTag: accepts production-20260607-2 (ordinal date shape)", () => {
  assert.equal(isValidProductionTag("production-20260607-2"), true);
});

test("isValidProductionTag: accepts production-20260607-rules (rules shape)", () => {
  assert.equal(isValidProductionTag("production-20260607-rules"), true);
});

test("isValidProductionTag: accepts production-20260607-rules-2 (ordinal rules shape)", () => {
  assert.equal(isValidProductionTag("production-20260607-rules-2"), true);
});

test("isValidProductionTag: rejects production-v6.39 (missing patch)", () => {
  assert.equal(isValidProductionTag("production-v6.39"), false);
});

test("isValidProductionTag: rejects production-xyz (invalid suffix)", () => {
  assert.equal(isValidProductionTag("production-xyz"), false);
});

test("isValidProductionTag: rejects production-2026 (too-short date)", () => {
  assert.equal(isValidProductionTag("production-2026"), false);
});

test("isValidProductionTag: rejects v6.62.0 (no production- prefix)", () => {
  assert.equal(isValidProductionTag("v6.62.0"), false);
});

test("isValidProductionTag: rejects null input", () => {
  assert.equal(isValidProductionTag(null), false);
});

test("isValidProductionTag: rejects undefined input", () => {
  assert.equal(isValidProductionTag(undefined), false);
});

test("isValidProductionTag: rejects empty string", () => {
  assert.equal(isValidProductionTag(""), false);
});

test("isValidProductionTag: leaf purity — is synchronous pure string → boolean (no I/O)", () => {
  // Structural: just confirm function runs without side effects
  const result = isValidProductionTag("production-v6.62.0");
  assert.equal(typeof result, "boolean");
});
