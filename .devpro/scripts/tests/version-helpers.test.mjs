/**
 * version-helpers.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/lib/version-helpers.mjs
 *
 * Covers:
 *   - extractVersionFromLine (existing)
 *   - extractVersionFromBranch (existing)
 *   - compareVersions (existing)
 *   - extractVersionFromFooter (T2 new)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { repoFileUrl } from "./lib/repo-root.mjs";

const LIB = repoFileUrl(".devpro/scripts/hooks/lib/version-helpers.mjs");

const {
  extractVersionFromLine,
  extractVersionFromBranch,
  compareVersions,
  extractVersionFromFooter,
  extractVersionFromTag,
} = await import(LIB);

// ── extractVersionFromLine ─────────────────────────────────────────────────

test("extractVersionFromLine: returns version from 版本：X.Y.Z", () => {
  assert.equal(extractVersionFromLine("版本：6.62.0"), "6.62.0");
});

test("extractVersionFromLine: returns null on no match", () => {
  assert.equal(extractVersionFromLine("no version here"), null);
});

test("extractVersionFromLine: returns null on multi-match (fail-safe)", () => {
  assert.equal(extractVersionFromLine("版本：6.62.0\n版本：6.63.0"), null);
});

test("extractVersionFromLine: returns null on null input", () => {
  assert.equal(extractVersionFromLine(null), null);
});

test("extractVersionFromLine: returns null on empty string", () => {
  assert.equal(extractVersionFromLine(""), null);
});

test("extractVersionFromLine: does NOT match v-prefixed form 版本：v6.62.0", () => {
  // AGENTS.md uses no v prefix — v-prefixed must be rejected
  assert.equal(extractVersionFromLine("版本：v6.62.0"), null);
});

// ── extractVersionFromBranch ───────────────────────────────────────────────

test("extractVersionFromBranch: returns version from chore/bump-vX.Y.Z", () => {
  assert.equal(extractVersionFromBranch("chore/bump-v6.63.0"), "6.63.0");
});

test("extractVersionFromBranch: returns null for non-bump branch", () => {
  assert.equal(extractVersionFromBranch("feature/add-foo"), null);
});

test("extractVersionFromBranch: returns null for null input", () => {
  assert.equal(extractVersionFromBranch(null), null);
});

test("extractVersionFromBranch: returns null for partial SemVer (chore/bump-v6.63)", () => {
  assert.equal(extractVersionFromBranch("chore/bump-v6.63"), null);
});

// ── compareVersions ────────────────────────────────────────────────────────

test("compareVersions: returns -1 when a < b", () => {
  assert.equal(compareVersions("6.62.0", "6.63.0"), -1);
});

test("compareVersions: returns 0 when a === b", () => {
  assert.equal(compareVersions("6.62.0", "6.62.0"), 0);
});

test("compareVersions: returns 1 when a > b", () => {
  assert.equal(compareVersions("6.63.0", "6.62.0"), 1);
});

test("compareVersions: handles null inputs without throwing", () => {
  assert.doesNotThrow(() => compareVersions(null, null));
  assert.equal(compareVersions(null, null), 0);
  assert.equal(compareVersions(null, "6.62.0"), -1);
  assert.equal(compareVersions("6.62.0", null), 1);
});

// ── extractVersionFromFooter (T2 new) ────────────────────────────────────

test("T2: extractVersionFromFooter: returns version from 'Rules: v6.62.0 · Tool: x · Model: y'", () => {
  assert.equal(
    extractVersionFromFooter("Rules: v6.62.0 · Tool: claude-code · Model: claude-sonnet"),
    "6.62.0"
  );
});

test("T2: extractVersionFromFooter: returns version from full body tail", () => {
  const body = "some body content\nRules: v6.39.2 · Tool: Claude Code · Model: Opus 4.7";
  assert.equal(extractVersionFromFooter(body), "6.39.2");
});

test("T2: extractVersionFromFooter: returns null on no match", () => {
  assert.equal(extractVersionFromFooter("no footer here"), null);
});

test("T2: extractVersionFromFooter: returns null on multi-match (fail-safe)", () => {
  // Two Rules: v... in the text → ambiguous → null
  const body = "Rules: v6.62.0 · Tool: x\nRules: v6.63.0 · Tool: y";
  assert.equal(extractVersionFromFooter(body), null);
});

test("T2: extractVersionFromFooter: returns null on null input", () => {
  assert.equal(extractVersionFromFooter(null), null);
});

test("T2: extractVersionFromFooter: returns null on empty string", () => {
  assert.equal(extractVersionFromFooter(""), null);
});

test("T2: extractVersionFromFooter: strips v prefix — returns X.Y.Z not vX.Y.Z", () => {
  const result = extractVersionFromFooter("Rules: v6.99.0 · Tool: x · Model: y");
  assert.equal(result, "6.99.0");
  assert.ok(!result.startsWith("v"), "returned value must not start with v");
});

test("T2: extractVersionFromFooter: handles legacy format 'Rules: v6.22.0 · Model: Claude Code / Opus 4.7'", () => {
  assert.equal(
    extractVersionFromFooter("Rules: v6.22.0 · Model: Claude Code / Opus 4.7"),
    "6.22.0"
  );
});

test("T2: leaf purity — extractVersionFromFooter has no file I/O (pure string → string|null)", () => {
  // This is a structural guarantee verified by grep in CI.
  // The function must run synchronously and return without side effects.
  const result = extractVersionFromFooter("Rules: v1.2.3 · Tool: x · Model: y");
  assert.equal(typeof result, "string");
});

// ── extractVersionFromTag (T4 new — V4 production tag equality SSOT) ─────

test("T4: extractVersionFromTag: returns version from production-v6.62.0", () => {
  assert.equal(extractVersionFromTag("production-v6.62.0"), "6.62.0");
});

test("T4: extractVersionFromTag: returns version from production-v6.10.0 (boundary crossing)", () => {
  assert.equal(extractVersionFromTag("production-v6.10.0"), "6.10.0");
});

test("T4: extractVersionFromTag: strips v prefix — returns X.Y.Z not vX.Y.Z", () => {
  const result = extractVersionFromTag("production-v6.99.0");
  assert.equal(result, "6.99.0");
  assert.ok(!result.startsWith("v"), "returned value must not start with v");
});

test("T4: extractVersionFromTag: returns null for production-v6.39 (missing patch)", () => {
  assert.equal(extractVersionFromTag("production-v6.39"), null);
});

test("T4: extractVersionFromTag: returns null for production-20260607 (date-style tag)", () => {
  assert.equal(extractVersionFromTag("production-20260607"), null);
});

test("T4: extractVersionFromTag: returns null for production-20260607-rules (rules tag)", () => {
  assert.equal(extractVersionFromTag("production-20260607-rules"), null);
});

test("T4: extractVersionFromTag: returns null for v6.62.0 (no production- prefix)", () => {
  assert.equal(extractVersionFromTag("v6.62.0"), null);
});

test("T4: extractVersionFromTag: returns null for null input", () => {
  assert.equal(extractVersionFromTag(null), null);
});

test("T4: extractVersionFromTag: returns null for undefined input", () => {
  assert.equal(extractVersionFromTag(undefined), null);
});

test("T4: extractVersionFromTag: returns null for empty string", () => {
  assert.equal(extractVersionFromTag(""), null);
});

test("T4: leaf purity — extractVersionFromTag is synchronous pure string → string|null", () => {
  const result = extractVersionFromTag("production-v6.62.0");
  assert.equal(typeof result, "string");
});
