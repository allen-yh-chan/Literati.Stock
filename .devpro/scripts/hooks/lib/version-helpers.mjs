/**
 * version-helpers.mjs
 *
 * Canonical SSOT for version string parsing and comparison.
 * Leaf module: does NOT import any sibling lib modules (no circular deps).
 *
 * Used by:
 *   - pre-tool-gate.mjs (replaces inline VERSION_LINE_RE)
 *   - branch-naming.mjs (BUMP_EXEMPTION_RE built from SEMVER_CORE)
 *   - F3 footer equality, V4 production tag equality
 */

// ── Canonical SEMVER pattern source ─────────────────────────────────────
// SSOT for `\d+\.\d+\.\d+`; other modules import this instead of
// re-defining the literal. Composed into regex via `new RegExp(...)`.
export const SEMVER_CORE = String.raw`\d+\.\d+\.\d+`;

// ── Internal patterns (not exported; callers use the helper functions) ──

// Matches `production-vX.Y.Z` exactly (whole string anchor, for extractVersionFromTag).
// Capture group 1: the X.Y.Z part (no `v` prefix).
// Intentionally module-private; shape *validation* (isValidProductionTag) is in tag-shapes.mjs.
// This RE is for *extraction* only — returns null on no match (fail-safe).
const PRODUCTION_VTAG_RE = new RegExp(`^production-v(${SEMVER_CORE})$`);

// Matches `版本：X.Y.Z` in text (no `v` prefix — AGENTS.md line format).
// Anchored with (?:^|[^\d]) ... (?:[^\d]|$) to avoid partial matches on
// surrounding digits is NOT needed because the 版本： prefix is distinctive.
const VERSION_LINE_RE = new RegExp(`版本：(${SEMVER_CORE})`, "g");

// Matches `chore/bump-vX.Y.Z` exactly (whole string anchor).
// Capture group 1: the X.Y.Z part.
const BUMP_BRANCH_RE = new RegExp(`^chore\\/bump-v(${SEMVER_CORE})$`);

// Matches `Rules: vX.Y.Z` in a footer line (with optional spaces after colon).
// Used by extractVersionFromFooter to pull the version from the footer string.
// Capture group 1: the X.Y.Z part (no `v` prefix).
const FOOTER_VERSION_RE = new RegExp(`Rules:\\s*v(${SEMVER_CORE})`, "g");

// ── Public API ───────────────────────────────────────────────────────────

/**
 * extractVersionFromLine(text)
 *
 * Extract the SemVer string from a line or text block containing `版本：X.Y.Z`.
 * Returns the X.Y.Z string (no `v` prefix).
 *
 * Fail-safe:
 *   - no match  → null
 *   - multi-match (more than one `版本：X.Y.Z` in text) → null
 *   - null/undefined input → null
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function extractVersionFromLine(text) {
  if (!text) return null;
  // Reset regex state before use (global regex has lastIndex state)
  VERSION_LINE_RE.lastIndex = 0;
  const matches = [...text.matchAll(VERSION_LINE_RE)];
  if (matches.length !== 1) return null; // 0 or 2+ matches → fail-safe null
  return matches[0][1];
}

/**
 * extractVersionFromBranch(branch)
 *
 * Extract the SemVer string from a `chore/bump-vX.Y.Z` branch name.
 * Returns the X.Y.Z string (no `v` prefix).
 *
 * Fail-safe:
 *   - branch does not match pattern → null
 *   - null/undefined input → null
 *
 * @param {string|null|undefined} branch
 * @returns {string|null}
 */
export function extractVersionFromBranch(branch) {
  if (!branch) return null;
  const m = branch.match(BUMP_BRANCH_RE);
  if (!m) return null;
  return m[1];
}

/**
 * compareVersions(a, b)
 *
 * Full semantic version comparison. Returns:
 *   -1  if a < b
 *    0  if a == b
 *    1  if a > b
 *
 * Each part (major/minor/patch) is compared numerically.
 *
 * Null/undefined inputs are handled without throwing:
 *   - both null → 0 (equal, treated as indeterminate)
 *   - a null, b non-null → -1 (null is "less than" a real version)
 *   - a non-null, b null → 1
 *
 * Reserved for F3/V4 ordering checks. The equality case (`=== 0`) is the
 * primary consumer in V1 (this PR).
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {-1|0|1} // reserved for F3/V4
 */
/**
 * extractVersionFromFooter(text)
 *
 * Extract the SemVer string from a footer line containing `Rules: v<X.Y.Z>`.
 * Returns the X.Y.Z string (no `v` prefix).
 *
 * Fail-safe:
 *   - no match  → null
 *   - multi-match (more than one `Rules: vX.Y.Z` in text) → null
 *   - null/undefined input → null
 *
 * Leaf-pure: no I/O, no sibling imports.
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function extractVersionFromFooter(text) {
  if (!text) return null;
  // Reset regex state before use (global regex has lastIndex state)
  FOOTER_VERSION_RE.lastIndex = 0;
  const matches = [...text.matchAll(FOOTER_VERSION_RE)];
  if (matches.length !== 1) return null; // 0 or 2+ matches → fail-safe null
  return matches[0][1];
}

export function compareVersions(a, b) {
  // Null handling (fail-safe, no throw) — reserved for F3/V4
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (pa < pb) return -1;
    if (pa > pb) return 1;
  }
  return 0;
}

/**
 * extractVersionFromTag(tag)
 *
 * Extract the SemVer string from a `production-v<X.Y.Z>` tag name.
 * Returns the X.Y.Z string (no `v` prefix).
 *
 * This is the V4 extraction helper — mirrors extractVersionFromBranch/extractVersionFromFooter
 * in the version extraction family. Shape *validation* (isValidProductionTag) is separate
 * and lives in tag-shapes.mjs.
 *
 * Fail-safe:
 *   - tag does not match `^production-v<X.Y.Z>$` → null
 *   - null/undefined/non-string input → null
 *   - non-production-v tag (date-style, rules-style) → null
 *
 * Leaf-pure: no file I/O, no sibling imports, no side effects.
 *
 * @param {string|null|undefined} tag
 * @returns {string|null}
 */
export function extractVersionFromTag(tag) {
  if (!tag || typeof tag !== "string") return null;
  const m = tag.match(PRODUCTION_VTAG_RE);
  if (!m) return null;
  return m[1];
}
