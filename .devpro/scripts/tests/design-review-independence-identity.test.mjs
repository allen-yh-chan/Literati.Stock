/**
 * design-review-independence-identity.test.mjs
 *
 * Behaviour tests for `.devpro/scripts/lib/design-review-independence-identity.mjs`
 * (design.md D2 / D6). Import the helper for parse/evaluate — do not grep its
 * source as a substitute. Source-shape asserts cover heading/next-H2 CRLF
 * literals only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseDesignAuthorIdentity,
  evaluateDesignReviewIndependence,
} from "../lib/design-review-independence-identity.mjs";

const HELPER_SOURCE = readFileSync(
  fileURLToPath(new URL("../lib/design-review-independence-identity.mjs", import.meta.url)),
  "utf8",
);

const RECORDED_AT = "2026-08-18T21:00:00Z";

function authorH2({ identity, provenance, recorded_at = RECORDED_AT }) {
  return [
    "## Design-Author Identity",
    "",
    `- identity: ${identity}`,
    `- provenance: ${provenance}`,
    `- recorded_at: ${recorded_at}`,
    "",
  ].join("\n");
}

function assertTypedFail(fn, classification) {
  assert.throws(
    fn,
    (error) => error?.classification === classification,
    `expected typed fail ${classification}`,
  );
}

test("cross-session H2: parseDesignAuthorIdentity reads ## Design-Author Identity; git Author / Co-authored-by must not replace it", () => {
  const markdown = [
    "Author: Jane Doe",
    "Co-authored-by: Other Agent",
    "",
    authorH2({ identity: "claude", provenance: "family-alias" }),
    "## Audit Findings Ledger",
    "",
    "- round: 1",
  ].join("\n");
  const record = parseDesignAuthorIdentity(markdown);
  assert.deepEqual(record, {
    identity: "claude",
    provenance: "family-alias",
    recorded_at: RECORDED_AT,
  });
});

test("full-CRLF identity section parses the same three fields as LF authorH2", () => {
  const expected = {
    identity: "claude",
    provenance: "family-alias",
    recorded_at: RECORDED_AT,
  };
  const crlfMarkdown = [
    "## Design-Author Identity",
    "",
    "- identity: claude",
    "- provenance: family-alias",
    `- recorded_at: ${RECORDED_AT}`,
    "",
    "## Audit Findings Ledger",
  ].join("\r\n");
  assert.deepEqual(parseDesignAuthorIdentity(crlfMarkdown), expected);
  assert.deepEqual(
    parseDesignAuthorIdentity(authorH2({ identity: "claude", provenance: "family-alias" })),
    expected,
  );
});

test("heading matcher source makes CRLF explicit", () => {
  assert.equal(HELPER_SOURCE.includes("[ \\t]*\\r?$"), true);
});

test("next-H2 boundary source makes CRLF explicit", () => {
  assert.equal(HELPER_SOURCE.includes("\\r?\\n## "), true);
});

test("cross-session H2: git Author / Co-authored-by must not pass the gate when ## Design-Author Identity is missing", () => {
  const markdown = [
    "Author: Jane Doe",
    "Co-authored-by: Other Agent",
    "",
    "## Audit Findings Ledger",
    "",
    "- round: 1",
  ].join("\n");
  assertTypedFail(() => parseDesignAuthorIdentity(markdown), "missing_author_record");
  const gitAsAuthor = evaluateDesignReviewIndependence({
    authorRecord: {
      identity: "Jane Doe",
      provenance: "trusted-session-metadata",
      recorded_at: RECORDED_AT,
    },
    reviewerFamilyFromValidatedPacket: "openai-codex",
  });
  assert.equal(gitAsAuthor.ok, false);
});

test("adapter-final reviewer: evaluateDesignReviewIndependence only accepts reviewerFamilyFromValidatedPacket; packet footer / self-report must not overwrite", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  const pass = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "openai-codex",
    packetFooter: "claude",
    selfReport: "claude",
    reviewer_family: "claude",
    provenance_model_rule: "claude",
  });
  assert.deepEqual(pass, { ok: true });

  const equal = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
    packetFooter: "openai-codex",
    selfReport: "openai-codex",
  });
  assert.equal(equal.ok, false);
  assert.match(String(equal.reason), /equality/i);

  const wrongKey = evaluateDesignReviewIndependence({
    authorRecord,
    reviewer_family: "openai-codex",
    packetFooter: "openai-codex",
  });
  assert.equal(wrongKey.ok, false);
});

test("author Codex-session-specific trusted-session-metadata vs reviewer openai-codex fails closed", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({
      identity: "2f3a4b5c-6d7e-8f90-a1b2-c3d4e5f60718",
      provenance: "trusted-session-metadata",
    }),
  );
  const result = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "openai-codex",
  });
  assert.equal(result.ok, false);
});

test("author family-alias claude vs reviewer openai-codex returns ok true", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord,
      reviewerFamilyFromValidatedPacket: "openai-codex",
    }),
    { ok: true },
  );
});

test("author family-alias openai-codex vs reviewer openai-codex fails closed without unavailability evidence", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "openai-codex", provenance: "family-alias" }),
  );
  const result = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "openai-codex",
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /equality/i);
});

test("same-family reviewer passes only when different-family is objectively unavailable", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "trusted-session-metadata" }),
  );
  const blocked = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
  });
  assert.equal(blocked.ok, false);

  const allowed = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
    differentFamilyUnavailable: {
      reason: "openai-codex quota exhausted until 2026-09-16",
    },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.same_family_fallback, true);
  assert.match(
    allowed.fallback_reason,
    /^same-family fallback: openai-codex quota exhausted until 2026-09-16$/,
  );
});

test("differentFamilyUnavailable reason must meet minimum byte length", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "trusted-session-metadata" }),
  );
  const tooShort = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
    differentFamilyUnavailable: { reason: "quota" },
  });
  assert.equal(tooShort.ok, false);
});

test("parse errors name the failing field", () => {
  const offsetTime = authorH2({ identity: "claude", provenance: "family-alias" })
    .replace(RECORDED_AT, "2026-08-28T02:22:00+08:00");
  assert.throws(
    () => parseDesignAuthorIdentity(offsetTime),
    (error) =>
      error?.classification === "malformed_author_record"
      && /recorded_at must be a UTC instant with Z suffix/.test(error.detail),
  );

  const badProvenance = authorH2({ identity: "claude", provenance: "git-author" });
  assert.throws(
    () => parseDesignAuthorIdentity(badProvenance),
    (error) =>
      error?.classification === "unverifiable_provenance"
      && /provenance must be one of:/.test(error.detail),
  );

  const extraField = [
    "## Design-Author Identity",
    "",
    "- identity: claude",
    "- provenance: family-alias",
    `- recorded_at: ${RECORDED_AT}`,
    "- git_author: Jane Doe",
    "",
  ].join("\n");
  assert.throws(
    () => parseDesignAuthorIdentity(extraField),
    (error) =>
      error?.classification === "malformed_author_record"
      && /exactly 3 non-empty lines/.test(error.detail),
  );
});

test("missing author or unknown reviewer still fails closed", () => {
  assertTypedFail(() => parseDesignAuthorIdentity("## Audit Findings Ledger\n"), "missing_author_record");

  const unknownAuthor = parseDesignAuthorIdentity(
    authorH2({ identity: "unknown", provenance: "unknown" }),
  );
  assert.equal(
    evaluateDesignReviewIndependence({
      authorRecord: unknownAuthor,
      reviewerFamilyFromValidatedPacket: "unknown",
    }).ok,
    false,
  );
  assert.equal(
    evaluateDesignReviewIndependence({
      authorRecord: parseDesignAuthorIdentity(
        authorH2({ identity: "claude", provenance: "family-alias" }),
      ),
    }).ok,
    false,
  );
});

test("host-unproven author with canonical CLI reviewer is execution-independent (not same-family)", () => {
  const unknownAuthor = parseDesignAuthorIdentity(
    authorH2({ identity: "unknown", provenance: "unknown" }),
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord: unknownAuthor,
      reviewerFamilyFromValidatedPacket: "openai-codex",
    }),
    { ok: true, host_primary_unproven: true },
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord: unknownAuthor,
      reviewerFamilyFromValidatedPacket: "claude",
      userPreselectedReviewerFamily: "claude",
    }),
    { ok: true, host_primary_unproven: true },
  );
});

test("duplicate H2, missing fields, and illegal provenance must not turn fail into pass", () => {
  const duplicate = `${authorH2({ identity: "claude", provenance: "family-alias" })}\n${authorH2({ identity: "openai-codex", provenance: "family-alias" })}`;
  assertTypedFail(() => parseDesignAuthorIdentity(duplicate), "duplicate_author_record");

  const missingField = [
    "## Design-Author Identity",
    "",
    "- identity: claude",
    "- provenance: family-alias",
    "",
  ].join("\n");
  assertTypedFail(() => parseDesignAuthorIdentity(missingField), "malformed_author_record");

  const extraField = [
    "## Design-Author Identity",
    "",
    "- identity: claude",
    "- provenance: family-alias",
    "- recorded_at: 2026-08-18T21:00:00Z",
    "- git_author: Jane Doe",
    "",
  ].join("\n");
  assertTypedFail(() => parseDesignAuthorIdentity(extraField), "malformed_author_record");

  assert.throws(
    () => parseDesignAuthorIdentity(authorH2({ identity: "claude", provenance: "git-author" })),
    (error) => error?.classification === "unverifiable_provenance",
  );
});

test("untrusted assertions must not upgrade provenance or turn fail into pass", () => {
  const unknown = parseDesignAuthorIdentity(
    authorH2({ identity: "unknown", provenance: "unknown" }),
  );
  // Host-unproven author + canonical reviewer is execution-independent;
  // untrusted sidecar fields must not invent a comparable family token or same-family path.
  const withUntrusted = evaluateDesignReviewIndependence({
    authorRecord: {
      ...unknown,
      gitAuthor: "Jane Doe",
      userTyped: "claude",
      marketing: "Claude Opus",
      packetSelfReport: "openai-codex",
    },
    reviewerFamilyFromValidatedPacket: "openai-codex",
    packetFooter: "claude",
    selfReport: "claude",
  });
  assert.deepEqual(withUntrusted, { ok: true, host_primary_unproven: true });
  assert.equal(unknown.provenance, "unknown");

  const marketing = evaluateDesignReviewIndependence({
    authorRecord: {
      identity: "Claude Opus",
      provenance: "family-alias",
      recorded_at: RECORDED_AT,
    },
    reviewerFamilyFromValidatedPacket: "openai-codex",
  });
  assert.equal(marketing.ok, false);

  const familyAliasEqual = evaluateDesignReviewIndependence({
    authorRecord: parseDesignAuthorIdentity(
      authorH2({ identity: "claude", provenance: "family-alias" }),
    ),
    reviewerFamilyFromValidatedPacket: "claude",
    userTyped: "openai-codex",
  });
  assert.equal(familyAliasEqual.ok, false);

  const namespaceMismatch = evaluateDesignReviewIndependence({
    authorRecord: parseDesignAuthorIdentity(
      authorH2({
        identity: "sess_01K4QZ7N9EXAMPLETOKEN",
        provenance: "family-alias",
      }),
    ),
    reviewerFamilyFromValidatedPacket: "openai-codex",
  });
  assert.equal(namespaceMismatch.ok, false);
});

test("trusted-session-metadata that is a byte-exact canonical family token is comparable", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "trusted-session-metadata" }),
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord,
      reviewerFamilyFromValidatedPacket: "openai-codex",
    }),
    { ok: true },
  );
  assert.equal(
    evaluateDesignReviewIndependence({
      authorRecord,
      reviewerFamilyFromValidatedPacket: "claude",
    }).ok,
    false,
  );
});

test("user-preselected same-family reviewer is a second legitimate fallback lane", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord,
      reviewerFamilyFromValidatedPacket: "claude",
      userPreselectedReviewerFamily: "claude",
    }),
    {
      ok: true,
      same_family_fallback: true,
      fallback_reason: "same-family fallback: user-preselected: claude",
    },
  );
});

test("same-family dispatch without unavailability evidence or a matching preselection still fails closed", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  const result = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /equality/i);
});

test("userPreselectedReviewerFamily not equal to dispatched reviewer family fails closed", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  const result = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
    userPreselectedReviewerFamily: "codex",
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /equality/i);
});

test("userPreselectedReviewerFamily that is not a canonical family token fails closed", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  const result = evaluateDesignReviewIndependence({
    authorRecord,
    reviewerFamilyFromValidatedPacket: "claude",
    userPreselectedReviewerFamily: "cursor-composer",
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /equality/i);
});

test("userPreselectedReviewerFamily on a different-family dispatch does not change the normal pass", () => {
  const authorRecord = parseDesignAuthorIdentity(
    authorH2({ identity: "claude", provenance: "family-alias" }),
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord,
      reviewerFamilyFromValidatedPacket: "openai-codex",
      userPreselectedReviewerFamily: "openai-codex",
    }),
    { ok: true },
  );
});

test("host-unproven success requires parse-shaped recorded_at (no raw duck-type)", () => {
  const missingRecordedAt = evaluateDesignReviewIndependence({
    authorRecord: { identity: "unknown", provenance: "unknown" },
    reviewerFamilyFromValidatedPacket: "claude",
  });
  assert.equal(missingRecordedAt.ok, false);
  assert.match(String(missingRecordedAt.reason), /unknown_identity/i);

  const badRecordedAt = evaluateDesignReviewIndependence({
    authorRecord: {
      identity: "unknown",
      provenance: "unknown",
      recorded_at: "2026-09-17T07:00:00+08:00",
    },
    reviewerFamilyFromValidatedPacket: "claude",
  });
  assert.equal(badRecordedAt.ok, false);
  assert.match(String(badRecordedAt.reason), /unknown_identity/i);
});

test("mixed identity/provenance unknown pairings fail closed", () => {
  const unknownPlusAlias = evaluateDesignReviewIndependence({
    authorRecord: {
      identity: "unknown",
      provenance: "family-alias",
      recorded_at: "2026-09-17T07:00:00Z",
    },
    reviewerFamilyFromValidatedPacket: "codex",
  });
  assert.equal(unknownPlusAlias.ok, false);
  assert.match(String(unknownPlusAlias.reason), /unknown_identity/i);

  // Reviewer must differ from identity so failure is provenance=unknown, not
  // proven identity-equality with the same family token.
  const claudePlusUnknown = evaluateDesignReviewIndependence({
    authorRecord: {
      identity: "claude",
      provenance: "unknown",
      recorded_at: "2026-09-17T07:00:00Z",
    },
    reviewerFamilyFromValidatedPacket: "codex",
  });
  assert.equal(claudePlusUnknown.ok, false);
  assert.match(String(claudePlusUnknown.reason), /unknown_identity/i);
});

test("host-unproven author ignores differentFamilyUnavailable (stays execution-independent)", () => {
  const unknownAuthor = parseDesignAuthorIdentity(
    authorH2({ identity: "unknown", provenance: "unknown" }),
  );
  assert.deepEqual(
    evaluateDesignReviewIndependence({
      authorRecord: unknownAuthor,
      reviewerFamilyFromValidatedPacket: "claude",
      differentFamilyUnavailable: {
        reason: "codex CLI quota exhausted until next window",
      },
    }),
    { ok: true, host_primary_unproven: true },
  );
});
