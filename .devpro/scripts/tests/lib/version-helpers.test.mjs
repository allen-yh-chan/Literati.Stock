/**
 * version-helpers.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/lib/version-helpers.mjs
 *
 * Covers:
 *   - extractVersionFromLine: match `版本：<SemVer>`, multi-match/no-match fail-safe
 *   - extractVersionFromBranch: match `chore/bump-v<SemVer>` capture, fail-safe
 *   - compareVersions: full -1/0/1 semantics, null input handling
 *   - equality (derived from compareVersions)
 *   - malformed inputs (non-semver, partial semver)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractVersionFromLine,
  extractVersionFromBranch,
  compareVersions,
} from "../../hooks/lib/version-helpers.mjs";

// ─────────────────────────────────────────────────────────────────────────
// extractVersionFromLine
// ─────────────────────────────────────────────────────────────────────────

test("extractVersionFromLine: basic match returns version string", () => {
  assert.equal(extractVersionFromLine("版本：6.62.0"), "6.62.0");
});

test("extractVersionFromLine: match within surrounding text", () => {
  assert.equal(
    extractVersionFromLine("  版本：6.30.1  (some text)"),
    "6.30.1"
  );
});

test("extractVersionFromLine: multiline text with single match", () => {
  assert.equal(
    extractVersionFromLine("# AI Agent 規範\n\n版本：6.63.0\n\n...\n"),
    "6.63.0"
  );
});

test("extractVersionFromLine: no match returns null", () => {
  assert.equal(extractVersionFromLine("no version here"), null);
});

test("extractVersionFromLine: empty string returns null", () => {
  assert.equal(extractVersionFromLine(""), null);
});

test("extractVersionFromLine: null input returns null", () => {
  assert.equal(extractVersionFromLine(null), null);
});

test("extractVersionFromLine: multi-match returns null (fail-safe)", () => {
  assert.equal(
    extractVersionFromLine("版本：6.62.0\n版本：6.63.0"),
    null
  );
});

test("extractVersionFromLine: non-semver (only 2 parts) returns null", () => {
  // `版本：6.62` — not a full X.Y.Z semver
  assert.equal(extractVersionFromLine("版本：6.62"), null);
});

test("extractVersionFromLine: with v prefix does not match (no v in pattern)", () => {
  // Branch name uses v prefix but AGENTS.md line does NOT — regression guard for issue #318
  assert.equal(extractVersionFromLine("版本：v6.62.0"), null);
});

// ─────────────────────────────────────────────────────────────────────────
// extractVersionFromBranch
// ─────────────────────────────────────────────────────────────────────────

test("extractVersionFromBranch: chore/bump-v<SemVer> returns X.Y.Z", () => {
  assert.equal(extractVersionFromBranch("chore/bump-v6.63.0"), "6.63.0");
});

test("extractVersionFromBranch: chore/bump-v6.30.0 → 6.30.0", () => {
  assert.equal(extractVersionFromBranch("chore/bump-v6.30.0"), "6.30.0");
});

test("extractVersionFromBranch: non-bump branch returns null", () => {
  assert.equal(extractVersionFromBranch("feature/add-foo"), null);
});

test("extractVersionFromBranch: chore branch without bump-v returns null", () => {
  assert.equal(extractVersionFromBranch("chore/update-readme"), null);
});

test("extractVersionFromBranch: partial version in branch returns null", () => {
  // only 2 parts — not a full semver
  assert.equal(extractVersionFromBranch("chore/bump-v6.63"), null);
});

test("extractVersionFromBranch: null input returns null", () => {
  assert.equal(extractVersionFromBranch(null), null);
});

test("extractVersionFromBranch: empty string returns null", () => {
  assert.equal(extractVersionFromBranch(""), null);
});

test("extractVersionFromBranch: extra suffix after semver returns null", () => {
  // Must be anchored — trailing garbage should not match
  assert.equal(extractVersionFromBranch("chore/bump-v6.63.0-alpha"), null);
});

// ─────────────────────────────────────────────────────────────────────────
// compareVersions
// ─────────────────────────────────────────────────────────────────────────

test("compareVersions: a < b returns -1", () => {
  assert.equal(compareVersions("6.62.0", "6.63.0"), -1);
});

test("compareVersions: a == b returns 0", () => {
  assert.equal(compareVersions("6.63.0", "6.63.0"), 0);
});

test("compareVersions: a > b returns 1", () => {
  assert.equal(compareVersions("6.63.0", "6.62.0"), 1);
});

test("compareVersions: major version difference", () => {
  assert.equal(compareVersions("5.0.0", "6.0.0"), -1);
  assert.equal(compareVersions("7.0.0", "6.99.99"), 1);
});

test("compareVersions: patch version difference", () => {
  assert.equal(compareVersions("6.63.0", "6.63.1"), -1);
  assert.equal(compareVersions("6.63.10", "6.63.9"), 1);
});

test("compareVersions: null a returns explicit value (not throw)", () => {
  assert.doesNotThrow(() => compareVersions(null, "6.63.0"));
});

test("compareVersions: null b returns explicit value (not throw)", () => {
  assert.doesNotThrow(() => compareVersions("6.63.0", null));
});

test("compareVersions: both null returns explicit value (not throw)", () => {
  assert.doesNotThrow(() => compareVersions(null, null));
});

// ─────────────────────────────────────────────────────────────────────────
// Equality (compareVersions == 0)
// ─────────────────────────────────────────────────────────────────────────

test("equality positive: same versions are equal", () => {
  assert.equal(compareVersions("6.63.0", "6.63.0") === 0, true);
});

test("equality negative: different versions are not equal", () => {
  assert.equal(compareVersions("6.62.0", "6.63.0") === 0, false);
});
