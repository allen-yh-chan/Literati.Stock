/**
 * design-review-independence-identity.mjs
 *
 * Pure helper for the /devpro:change Design.md Second-Review Gate:
 * parse the first-persist `## Design-Author Identity` record and compare it
 * with validator-accepted `reviewer_family` in the canonical family-token
 * namespace. Family-token legality reuses `resolveCanonicalReviewerFamily`;
 * this module MUST NOT keep a parallel token table.
 */

import {
  ReviewerFamilyContractError,
  resolveCanonicalReviewerFamily,
} from "../second-review-material-contract.mjs";

export const DESIGN_AUTHOR_IDENTITY_PROVENANCE_VALUES = Object.freeze([
  "trusted-session-metadata",
  "family-alias",
  "unknown",
]);
const PROVENANCE_ENUM = new Set(DESIGN_AUTHOR_IDENTITY_PROVENANCE_VALUES);
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Minimum UTF-8 bytes for `differentFamilyUnavailable.reason` (anti-empty excuse). */
export const DIFFERENT_FAMILY_UNAVAILABLE_REASON_MIN_BYTES = 10;
export const SAME_FAMILY_FALLBACK_REASON_PREFIX = "same-family fallback:";

export class DesignAuthorIdentityError extends Error {
  constructor(classification, detail = "") {
    super(detail ? `${classification}: ${detail}` : classification);
    this.name = "DesignAuthorIdentityError";
    this.classification = classification;
    this.detail = detail;
  }
}

function typedFail(classification, detail = "") {
  throw new DesignAuthorIdentityError(classification, detail);
}

function isCanonicalFamilyToken(value) {
  try {
    resolveCanonicalReviewerFamily(value);
    return true;
  } catch (error) {
    if (error instanceof ReviewerFamilyContractError) return false;
    throw error;
  }
}

function failClosed(reason) {
  return { ok: false, reason };
}

function normalizedUnavailableReason(input) {
  const raw = input?.differentFamilyUnavailable?.reason;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (Buffer.byteLength(trimmed, "utf8") < DIFFERENT_FAMILY_UNAVAILABLE_REASON_MIN_BYTES) {
    return null;
  }
  return trimmed;
}

/**
 * @param {string} decisionsMarkdown
 * @returns {{ identity: string, provenance: string, recorded_at: string }}
 */
export function parseDesignAuthorIdentity(decisionsMarkdown) {
  if (typeof decisionsMarkdown !== "string") {
    typedFail("malformed_author_record", "decisions markdown must be a string");
  }

  const headingRe = /^## Design-Author Identity[ \t]*\r?$/gm;
  const matches = [...decisionsMarkdown.matchAll(headingRe)];
  if (matches.length === 0) typedFail("missing_author_record");
  if (matches.length > 1) typedFail("duplicate_author_record");

  const headingMatch = matches[0];
  const afterHeading = decisionsMarkdown.slice(
    headingMatch.index + headingMatch[0].length,
  );
  const nextHeading = afterHeading.search(/\r?\n## /);
  const section = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading))
    .replace(/^\r?\n/, "");
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");

  if (lines.length !== 3) {
    typedFail(
      "malformed_author_record",
      `## Design-Author Identity must contain exactly 3 non-empty lines (- identity, - provenance, - recorded_at); got ${lines.length}`,
    );
  }

  const identityMatch = lines[0].match(/^- identity:\s*(.*)$/);
  const provenanceMatch = lines[1].match(/^- provenance:\s*(.*)$/);
  const recordedMatch = lines[2].match(/^- recorded_at:\s*(.*)$/);
  if (!identityMatch || !provenanceMatch || !recordedMatch) {
    typedFail(
      "malformed_author_record",
      "lines must be exactly `- identity:`, `- provenance:`, `- recorded_at:` in that order",
    );
  }

  const identity = identityMatch[1].trim();
  const provenance = provenanceMatch[1].trim();
  const recorded_at = recordedMatch[1].trim();
  if (identity === "" || provenance === "" || recorded_at === "") {
    typedFail("malformed_author_record", "identity, provenance, and recorded_at must be non-empty");
  }
  if (!PROVENANCE_ENUM.has(provenance)) {
    typedFail(
      "unverifiable_provenance",
      `provenance must be one of: ${DESIGN_AUTHOR_IDENTITY_PROVENANCE_VALUES.join(", ")}; got "${provenance}"`,
    );
  }
  if (!ISO_8601_RE.test(recorded_at)) {
    typedFail(
      "malformed_author_record",
      "recorded_at must be a UTC instant with Z suffix (e.g. 2026-08-28T02:22:00Z); offset forms like +08:00 are rejected",
    );
  }

  return { identity, provenance, recorded_at };
}

function authorComparableToken(authorRecord) {
  if (
    authorRecord == null
    || typeof authorRecord !== "object"
    || typeof authorRecord.identity !== "string"
    || typeof authorRecord.provenance !== "string"
  ) {
    return { ok: false, reason: "missing_or_malformed_author" };
  }

  const identity = authorRecord.identity.trim();
  const provenance = authorRecord.provenance.trim();

  if (identity === "" || provenance === "") {
    return { ok: false, reason: "missing_or_malformed_author" };
  }
  if (!PROVENANCE_ENUM.has(provenance)) {
    return { ok: false, reason: "unverifiable_provenance" };
  }
  if (provenance === "unknown" || identity === "unknown") {
    return { ok: false, reason: "unknown_identity" };
  }

  if (provenance === "family-alias") {
    if (!isCanonicalFamilyToken(identity)) {
      return { ok: false, reason: "namespace_granularity_mismatch" };
    }
    return { ok: true, token: identity };
  }

  // provenance === trusted-session-metadata
  if (!isCanonicalFamilyToken(identity)) {
    return { ok: false, reason: "namespace_granularity_mismatch" };
  }
  return { ok: true, token: identity };
}

/**
 * Parse-shaped host-unproven author: both identity and provenance are
 * `unknown`, and `recorded_at` is a valid UTC Z instant (same shape as
 * `parseDesignAuthorIdentity` output). Raw `{ identity, provenance }` without
 * a valid `recorded_at` MUST NOT unlock the host-unproven success path.
 */
function isHostUnprovenAuthorRecord(authorRecord) {
  if (
    authorRecord == null
    || typeof authorRecord !== "object"
    || typeof authorRecord.identity !== "string"
    || typeof authorRecord.provenance !== "string"
    || typeof authorRecord.recorded_at !== "string"
  ) {
    return false;
  }
  const identity = authorRecord.identity.trim();
  const provenance = authorRecord.provenance.trim();
  const recorded_at = authorRecord.recorded_at.trim();
  return (
    identity === "unknown"
    && provenance === "unknown"
    && ISO_8601_RE.test(recorded_at)
  );
}

/**
 * @param {{
 *   authorRecord?: { identity: string, provenance: string, recorded_at?: string },
 *     // host-unproven success (`host_primary_unproven`) requires parse-shaped
 *     // `recorded_at` (valid UTC Z). Omitting or invalidating it fails closed.
 *   reviewerFamilyFromValidatedPacket?: unknown,
 *   differentFamilyUnavailable?: { reason: string } | null,
 *   userPreselectedReviewerFamily?: string,
 * }} input
 * @returns {{ ok: true, same_family_fallback?: true, fallback_reason?: string, host_primary_unproven?: true } | { ok: false, reason: string }}
 */
export function evaluateDesignReviewIndependence(input) {
  const authorRecord = input?.authorRecord;
  const reviewerFamilyFromValidatedPacket = input?.reviewerFamilyFromValidatedPacket;

  if (typeof reviewerFamilyFromValidatedPacket !== "string") {
    return failClosed("missing_reviewer_family");
  }
  if (reviewerFamilyFromValidatedPacket === "unknown") {
    return failClosed("unknown_identity");
  }
  if (!isCanonicalFamilyToken(reviewerFamilyFromValidatedPacket)) {
    return failClosed("invalid_reviewer_family");
  }

  // Host-unproven author (Cursor / no-fixed-primary): parse-shaped unknown/
  // unknown + valid recorded_at. Canonical CLI reviewer is execution-
  // independent — NOT same-family. Mixed identity/provenance or missing/
  // invalid recorded_at fall through to fail-closed comparable-token checks.
  if (isHostUnprovenAuthorRecord(authorRecord)) {
    return { ok: true, host_primary_unproven: true };
  }

  const author = authorComparableToken(authorRecord);
  if (!author.ok) return failClosed(author.reason);

  if (author.token === reviewerFamilyFromValidatedPacket) {
    const unavailableReason = normalizedUnavailableReason(input);
    if (unavailableReason) {
      return {
        ok: true,
        same_family_fallback: true,
        fallback_reason: `${SAME_FAMILY_FALLBACK_REASON_PREFIX} ${unavailableReason}`,
      };
    }
    // Second legitimate fallback lane: a user preselection made at devpro:change
    // start (ledger `second_reviewer_family`) that matches the dispatched
    // reviewer family. The two lanes never cross-certify each other.
    const preselected = input?.userPreselectedReviewerFamily;
    if (
      typeof preselected === "string"
      && isCanonicalFamilyToken(preselected)
      && preselected === reviewerFamilyFromValidatedPacket
    ) {
      return {
        ok: true,
        same_family_fallback: true,
        fallback_reason: `${SAME_FAMILY_FALLBACK_REASON_PREFIX} user-preselected: ${preselected}`,
      };
    }
    return failClosed("identity equality");
  }
  return { ok: true };
}
