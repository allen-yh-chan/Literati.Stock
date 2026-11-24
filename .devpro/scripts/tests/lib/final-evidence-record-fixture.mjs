/**
 * final-evidence-record-fixture.mjs
 *
 * Shared builder for a hand-assembled, schema-valid FinalEvidenceRecord
 * (`devpro.review-remediation.final-evidence/v1`) — the shape
 * `sealFinalEvidenceRecord` (core) produces and `verifyHeadBoundFinalEvidence`
 * (design D4) reads back inside the
 * bounded merge verifier child (design D5).
 *
 * Why hand-assembled rather than driving the real `sealFinalEvidenceRecord`
 * writer: the writer requires a clean whole tree, a converged review receipt,
 * and a real canonical-suite spawn — none of which a hook-layer prove-it test
 * needs or wants to depend on. Instead this module reuses the ONE piece of
 * writer logic a hand-built fixture cannot be allowed to drift from —
 * canonical-JSON-v1 serialization (`canonicalJsonV1`, imported from the
 * production façade `review-remediation-evidence.mjs`, never re-implemented
 * here) — and otherwise builds the exact field shape `validateFinalPayload` /
 * `validateFinalRecord` (core, `.devpro/scripts/lib/review-remediation-evidence-core.mjs`)
 * require, confirmed by direct source read at design time (design.md D11,
 * D4 "Writer/reader 大小契約" and binding-check enumeration):
 *
 *   payload: canonical_owner_id, head_sha, review_coverage,
 *     final_carrier_manifest, command_id, result, tests, passed, failed, log
 *   record:  schema, record_digest_sha256, payload
 *
 * T2/T4 (verifier child / core) tests import the SAME builders here so the
 * merge-verifier test suite and this hook-layer prove-it suite can never grow
 * two independently-drifting FinalEvidenceRecord builders (design D11: "紀錄
 * 由共用 test helper `tests/lib/final-evidence-record-fixture.mjs` 組出").
 *
 * This file intentionally does NOT import `lib/review-remediation-evidence-core.mjs`
 * directly (core-importer lock: only the production façade may do so).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJsonV1, FINAL_EVIDENCE_SCHEMA } from "../../review-remediation-evidence.mjs";

/** Any fixed-shape 40-hex placeholder; `verifyHeadBoundFinalEvidence` (D4) only
 * checks `final_carrier_manifest.head_sha === headSha` and format validity —
 * it does not recompute the manifest against a real `git diff`, so the merge
 * base does not need to name a real ancestor commit. */
const FIXTURE_MERGE_BASE_SHA = "b".repeat(40);

/** The consumer not-applicable `result` literal; counts default to `null` for it. */
const FIXTURE_CONSUMER_NA_RESULT = "not-applicable-consumer-profile";

function sha256Hex(bytesOrText) {
  const bytes = Buffer.isBuffer(bytesOrText) ? bytesOrText : Buffer.from(String(bytesOrText), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

/** `review-<changeId>-final-evidence-<headSha>.json` — mirrors core's
 * (unexported) `finalFileName`; kept in one place here rather than
 * re-derived at each call site. */
export function finalEvidenceFileName(changeId, headSha) {
  return `review-${changeId}-final-evidence-${headSha}.json`;
}

/** `review-<changeId>-receipt-r<round>.json` — mirrors core's (unexported)
 * `receiptFileName`, used only to produce a `terminal_receipt_ref.path` that
 * `parseReceiptCandidateName` (core) accepts as change-owned. */
export function fixtureReceiptFileName(changeId, round = 1) {
  return `review-${changeId}-receipt-r${round}.json`;
}

/**
 * Builds a `final_carrier_manifest` (empty `entries` by default — the merge
 * verifier's binding check only reads `head_sha`, not the entry list).
 */
export function buildFinalCarrierManifestFixture({
  mergeBaseSha = FIXTURE_MERGE_BASE_SHA,
  headSha,
  entries = [],
} = {}) {
  if (!headSha) throw new Error("buildFinalCarrierManifestFixture requires headSha");
  const withoutDigest = { merge_base_sha: mergeBaseSha, head_sha: headSha, entries };
  return { ...withoutDigest, digest_sha256: sha256Hex(canonicalJsonV1(withoutDigest)) };
}

/** Inline suite log (`{ encoding, bytes_base64, byte_length, digest_sha256 }`),
 * mirroring core's (unexported) `inlineLog`. */
export function buildInlineLogFixture(text = "final-evidence-record-fixture log\n") {
  const bytes = Buffer.from(text, "utf8");
  return {
    encoding: "base64",
    bytes_base64: bytes.toString("base64"),
    byte_length: bytes.length,
    digest_sha256: sha256Hex(bytes),
  };
}

/** `review_coverage` in `direct` mode (the simplest legal shape:
 * `archive_transition_ref` MUST be null in this mode). `terminal_receipt_ref`
 * only needs to be recognizable by `parseReceiptCandidateName(changeId, …)`;
 * its `digest_sha256` is never dereferenced against a real receipt file by the
 * merge verifier (design D4 §5 binding-check enumeration). */
export function buildDirectReviewCoverageFixture({ changeId, headSha, receiptRound = 1 } = {}) {
  if (!changeId) throw new Error("buildDirectReviewCoverageFixture requires changeId");
  if (!headSha) throw new Error("buildDirectReviewCoverageFixture requires headSha");
  return {
    mode: "direct",
    terminal_receipt_ref: {
      path: fixtureReceiptFileName(changeId, receiptRound),
      digest_sha256: sha256Hex(`${changeId}-receipt-r${receiptRound}-fixture-ref`),
    },
    reviewed_head_sha: headSha,
    archive_transition_ref: null,
  };
}

/** `review-<changeId>-archive-transition-<headSha>.json` — mirrors core's
 * (unexported) `archiveTransitionFileName`, used only to produce an
 * `archive_transition_ref.path` `verifyHeadBoundFinalEvidence` (core) can
 * compare against its own `archiveTransitionFileName(changeId, headSha)`. */
export function fixtureArchiveTransitionFileName(changeId, headSha) {
  return `review-${changeId}-archive-transition-${headSha}.json`;
}

/** `review_coverage` in `archive_transition` mode (the mode `direct` fixture
 * above cannot exercise: `archive_transition_ref` MUST be a durable ref, not
 * null, and `reviewed_head_sha` MUST differ from the sealed `headSha` — this
 * is the shape `coverageSnapshot` (core) builds when the reviewed head and
 * the current head have diverged, e.g. after an archive transition).
 * `archive_transition_ref.path` is keyed on `headSha` (the record's OWN
 * head), mirroring core's `archiveTransitionFileName(changeId, headSha)`;
 * its `digest_sha256` is never dereferenced against a real transition file
 * by the merge verifier (same rationale as `terminal_receipt_ref` above). */
export function buildArchiveTransitionReviewCoverageFixture({ changeId, headSha, reviewedHeadSha, receiptRound = 1 } = {}) {
  if (!changeId) throw new Error("buildArchiveTransitionReviewCoverageFixture requires changeId");
  if (!headSha) throw new Error("buildArchiveTransitionReviewCoverageFixture requires headSha");
  if (!reviewedHeadSha) throw new Error("buildArchiveTransitionReviewCoverageFixture requires reviewedHeadSha");
  return {
    mode: "archive_transition",
    terminal_receipt_ref: {
      path: fixtureReceiptFileName(changeId, receiptRound),
      digest_sha256: sha256Hex(`${changeId}-receipt-r${receiptRound}-fixture-ref`),
    },
    reviewed_head_sha: reviewedHeadSha,
    archive_transition_ref: {
      path: fixtureArchiveTransitionFileName(changeId, headSha),
      digest_sha256: sha256Hex(`${changeId}-archive-transition-${headSha}-fixture-ref`),
    },
  };
}

/**
 * Builds the full FinalEvidenceRecord `payload` (the object
 * `record_digest_sha256` is computed over).
 */
export function buildFinalEvidencePayload({
  changeId,
  headSha,
  canonicalOwnerId = "final-evidence-record-fixture-owner",
  reviewCoverage,
  finalCarrierManifest,
  result = "pass",
  tests = result === FIXTURE_CONSUMER_NA_RESULT ? null : 1,
  passed = result === FIXTURE_CONSUMER_NA_RESULT ? null : 1,
  failed = result === FIXTURE_CONSUMER_NA_RESULT ? null : 0,
  log,
} = {}) {
  if (!changeId) throw new Error("buildFinalEvidencePayload requires changeId");
  if (!headSha) throw new Error("buildFinalEvidencePayload requires headSha");
  return {
    canonical_owner_id: canonicalOwnerId,
    head_sha: headSha,
    review_coverage: reviewCoverage ?? buildDirectReviewCoverageFixture({ changeId, headSha }),
    final_carrier_manifest: finalCarrierManifest ?? buildFinalCarrierManifestFixture({ headSha }),
    command_id: "source-change-scoped-suite",
    result,
    tests,
    passed,
    failed,
    log: log ?? buildInlineLogFixture(),
  };
}

/**
 * Builds the full `{ schema, record_digest_sha256, payload }` record.
 * `overridePayload`/`overrideRecordDigestSha256` exist ONLY for negative
 * fixtures (e.g. a verifier test that wants a payload whose recomputed digest
 * deliberately mismatches the stored one); prove-it (T1) callers never pass
 * them.
 */
export function buildFinalEvidenceRecordFixture(options = {}) {
  const { overridePayload, overrideRecordDigestSha256, ...payloadOptions } = options;
  const payload = overridePayload ?? buildFinalEvidencePayload(payloadOptions);
  return {
    schema: FINAL_EVIDENCE_SCHEMA,
    record_digest_sha256: overrideRecordDigestSha256 ?? sha256Hex(canonicalJsonV1(payload)),
    payload,
  };
}

/**
 * Writes a fixture record to `<notesRoot>/review-<changeId>-final-evidence-<headSha>.json`
 * using the exact on-disk shape `parseCanonicalJsonV1` (core) requires:
 * `${canonicalJsonV1(record)}\n`, nothing else. `notesRoot` MUST be the same
 * directory `derivedNotesRoot(repoRoot, gitOps)` (core) resolves for the
 * fixture's own `repoRoot` (ordinarily `path.join(repoRoot, "notes")` for a
 * plain, non-worktree git fixture — see `hook-pre-tool-gate-release-version.test.mjs`
 * `setupRepo`), or the reader will report "missing" rather than exercise the
 * fixture at all.
 *
 * Returns `{ record, targetPath, bytes }` so callers can assert on the exact
 * bytes written or reuse `record` to check field values.
 */
export function writeFinalEvidenceRecordFixture({ notesRoot, changeId, headSha, record, ...buildOptions } = {}) {
  if (!notesRoot) throw new Error("writeFinalEvidenceRecordFixture requires notesRoot");
  if (!changeId) throw new Error("writeFinalEvidenceRecordFixture requires changeId");
  if (!headSha) throw new Error("writeFinalEvidenceRecordFixture requires headSha");
  const finalRecord = record ?? buildFinalEvidenceRecordFixture({ changeId, headSha, ...buildOptions });
  mkdirSync(notesRoot, { recursive: true });
  const targetPath = path.join(notesRoot, finalEvidenceFileName(changeId, headSha));
  const bytes = Buffer.from(`${canonicalJsonV1(finalRecord)}\n`, "utf8");
  writeFileSync(targetPath, bytes);
  return { record: finalRecord, targetPath, bytes };
}

/**
 * Builds a digest-valid, manifest-heavy FinalEvidenceRecord whose on-disk
 * canonical-JSON-v1 size (`${canonicalJsonV1(record)}\n`) lands at or just
 * below `targetBytes`. Heap cost of verification is dominated by the NUMBER
 * of parsed objects, not by one long string, so the size is reached with many
 * realistic carrier-manifest entries (design D5/D11 "合成 manifest entries 再以
 * 一筆補齊"; review r1 F-r1-5), and only the last entry's `path` is padded to
 * close the remaining gap. `inlineLogBytes` sets the inline suite log size
 * (the writer caps it at 2 MiB).
 *
 * Returns `{ record, bytes, entryCount }`.
 */
export function buildManifestHeavyRecordFixture({ changeId, headSha, targetBytes, inlineLogBytes = 0 } = {}) {
  if (!changeId) throw new Error("buildManifestHeavyRecordFixture requires changeId");
  if (!headSha) throw new Error("buildManifestHeavyRecordFixture requires headSha");
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("buildManifestHeavyRecordFixture requires a positive integer targetBytes");
  }
  const log = inlineLogBytes > 0 ? buildInlineLogFixture("x".repeat(inlineLogBytes)) : undefined;
  const entry = (index, pad = 0) => ({
    path: `src/generated/module-${String(index).padStart(7, "0")}${"a".repeat(pad)}.mjs`,
    status: "M",
    old_mode: "100644",
    new_mode: "100644",
    old_object_id: "0".repeat(40),
    new_object_id: "1".repeat(40),
  });
  const recordBytes = (record) => Buffer.byteLength(`${canonicalJsonV1(record)}\n`, "utf8");
  const build = (entries) => buildFinalEvidenceRecordFixture({
    overridePayload: buildFinalEvidencePayload({
      changeId,
      headSha,
      finalCarrierManifest: buildFinalCarrierManifestFixture({ headSha, entries }),
      log,
    }),
  });
  const baseBytes = recordBytes(build([entry(0)]));
  const perEntryBytes = recordBytes(build([entry(0), entry(1)])) - baseBytes;
  const entryCount = Math.max(1, Math.floor((targetBytes - baseBytes) / perEntryBytes));
  const entries = Array.from({ length: entryCount }, (_, index) => entry(index));
  const unpadded = recordBytes(build(entries));
  const pad = Math.max(0, targetBytes - unpadded);
  entries[entryCount - 1] = entry(entryCount - 1, pad);
  const record = build(entries);
  return { record, bytes: recordBytes(record), entryCount };
}
