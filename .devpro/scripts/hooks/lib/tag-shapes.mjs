/**
 * tag-shapes.mjs
 *
 * SSOT for production tag shape definitions.
 * Consumed by:
 *   - .devpro/scripts/detect-branch-base.mjs  (anchor detection / sorting)
 *   - .devpro/scripts/hooks/pre-tool-gate.mjs (PreToolUse write-time gate)
 *
 * Leaf module: does NOT import any sibling lib modules (no circular deps).
 *
 * Three canonical production-* tag shapes:
 *   1. production-v<MAJOR>.<MINOR>.<PATCH>        — SemVer release (source repo)
 *   2. production-<YYYYMMDD>[-<ordinal≥2>]        — date-style (consumer subset release)
 *   3. production-<YYYYMMDD>-rules[-<ordinal≥2>]  — rules sync (consumer rules lane)
 *
 * Any production-* tag not matching one of these three is considered malformed
 * and MUST be blocked at write time (N1 gate in pre-tool-gate.mjs).
 */

// ── Three canonical RE (byte-for-byte copy from detect-branch-base.mjs) ──

/**
 * Matches `production-vMAJOR.MINOR.PATCH` (whole string anchor).
 * Capture groups: [1]=MAJOR, [2]=MINOR, [3]=PATCH
 */
export const VTAG_RE = /^production-v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Matches `production-YYYYMMDD[-ordinal]` where ordinal is 2–9 or 10+.
 * Capture groups: [1]=YYYYMMDD date, [2]=ordinal (undefined if unsuffixed = 1)
 */
export const PRODUCTION_DATE_RE = /^production-(\d{8})(?:-([2-9]|[1-9]\d+))?$/;

/**
 * Matches `production-YYYYMMDD-rules[-ordinal]` where ordinal is 2–9 or 10+.
 * Capture groups: [1]=YYYYMMDD date, [2]=ordinal (undefined if unsuffixed = 1)
 */
export const RULES_TAG_RE = /^production-(\d{8})-rules(?:-([2-9]|[1-9]\d+))?$/;

// ── Public validation API ─────────────────────────────────────────────────

/**
 * isValidProductionTag(tagName)
 *
 * Returns true if tagName matches any of the three canonical production-* shapes.
 * Returns false for any malformed production-* tag (N1 gate).
 *
 * Fail-safe: null/undefined/non-string input → false.
 *
 * @param {string|null|undefined} tagName
 * @returns {boolean}
 */
export function isValidProductionTag(tagName) {
  if (!tagName || typeof tagName !== "string") return false;
  return VTAG_RE.test(tagName) || PRODUCTION_DATE_RE.test(tagName) || RULES_TAG_RE.test(tagName);
}
