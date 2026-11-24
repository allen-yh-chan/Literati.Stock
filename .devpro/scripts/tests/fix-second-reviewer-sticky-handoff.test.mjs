import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PAGED_REVIEW_MATERIAL_KEYS,
  SECOND_REVIEW_EMBEDDED_MAX_BYTES,
  SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES,
  FINDING_ITEM_KEYS,
  SECOND_REVIEW_VERDICT_REASON_MAX_BYTES,
  FINDING_SEVERITIES,
  appendFindingsWindow,
  authorizeGateSatisfyingSticky,
  emptyCheckpointLedger,
  emptyFindingsLedger,
  findingsPayloadSha256,
  materialSha256,
  normalizePrStickyReviewMaterialData,
  parsePageWindowCompletionObject,
  requiresPageWindowing,
  reviewScopeFingerprintSha256,
  sealCheckpointLedger,
  validatePrStickyReviewMaterialContract,
} from "../second-review-material-contract.mjs";
import {
  __testReviewerClassification,
  __testReviewerOutput,
  bindBlockedStickyWriteDisposition,
  prepareIntermediateCriticalStickyCheckpoint,
  resolveLivePageWindowStickyGate,
} from "../run-second-reviewer-projection.mjs";
import {
  resolveSecondReviewStickyWriteDisposition,
} from "../hooks/lib/second-review-sticky-authority.mjs";
import {
  SAME_FAMILY_FALLBACK_REASON_PREFIX,
  CROSS_MODEL_UNVERIFIED_REASON_TOKEN,
  SECOND_REVIEW_PAGE_WINDOW_FINDINGS_CARRIER_CLASS_RULE,
  SECOND_REVIEW_PAGE_WINDOW_FINDINGS_PAYLOAD_SHA256_RULE,
  SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX,
  SECOND_REVIEW_PACKET_STATIC_SUFFIX,
  SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION,
  PAGE_WINDOW_STICKY_DEFERRED_CLASSIFICATION,
  classificationIndicatesSameFamilyFallback,
  crossModelUnverifiedDisclosure,
  pageWindowCompletionBindingFromReviewMaterial,
  pageWindowIntermediateStickyDisposition,
  primaryFamilyIsUnknown,
  sameFamilyFallbackDisclosure,
  secondReviewPacketStaticPrefix,
  secondReviewPacketStaticSuffix,
  stickyReasonRequiresCrossModelUnverified,
  stickyReasonRequiresSameFamilyFallback,
} from "../validate-second-review-packet.mjs";
import { createHash } from "node:crypto";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

function largeDiff(bytes = SECOND_REVIEW_EMBEDDED_MAX_BYTES + 40_000) {
  const prefix = "diff --git a/x b/x\n";
  return `${prefix}${"a".repeat(bytes - prefix.length)}`;
}

function canonicalPagedSource(material = largeDiff()) {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const reviewScope = {
    kind: "full-pr",
    pull_request_number: 2009,
    head_sha: head,
  };
  return {
    schema_version: "devpro-second-review-data/v4",
    mode: "pr-sticky",
    attempt: "initial",
    dispatch_id: "dispatch-test",
    previous_dispatch_id: null,
    primary_family: "claude",
    reviewer_family: "codex",
    target: "PR #2009",
    head_ref_oid: head,
    approval_context: "none",
    approval_resolution: { status: "not-required" },
    review_scope: reviewScope,
    scope_summary: "paged sticky handoff prove-it",
    changed_files_or_touch_list: ["x"],
    review_material_carrier: "embedded-diff",
    review_material_capability: "scope-bound-embedded-complete-diff-v1",
    review_material_proof: {
      kind: "embedded-complete-diff-v1",
      scope_fingerprint_sha256: reviewScopeFingerprintSha256(reviewScope),
      material_format: "git-unified-diff",
      material_utf8_bytes: Buffer.byteLength(material, "utf8"),
      material_sha256: materialSha256(material),
    },
    review_material: material,
    previous_sticky: "none",
    retry_context: { classification: "none", sticky_verification: "not-needed" },
    linked_issue_context: "none",
    primary_verdict: "none",
    evidence: [{ kind: "validation", narrative: "prove-it" }, { kind: "test", narrative: "prove-it" }],
  };
}

function jsonLineAtExactBytes(buildRow, targetBytes) {
  const empty = JSON.stringify(buildRow(""));
  const payloadBytes = targetBytes - Buffer.byteLength(empty, "utf8");
  assert.ok(payloadBytes >= 0, "target must fit the fixed JSON envelope");
  const line = JSON.stringify(buildRow("x".repeat(payloadBytes)));
  assert.equal(Buffer.byteLength(line, "utf8"), targetBytes);
  return line;
}

function jsonLineAtExactBytesWithSuffix(buildRow, targetBytes, suffix) {
  const empty = JSON.stringify(buildRow(""));
  const payloadBytes = targetBytes
    - Buffer.byteLength(empty, "utf8")
    - Buffer.byteLength(suffix, "utf8");
  assert.ok(payloadBytes >= 0, "target must fit the fixed JSON envelope and suffix");
  const line = JSON.stringify(buildRow(`${"x".repeat(payloadBytes)}${suffix}`));
  assert.equal(Buffer.byteLength(line, "utf8"), targetBytes);
  return line;
}

function signatureDeltaLineAtBytes(targetBytes = 93_638, deltaType = "signature_delta") {
  const contentKey = deltaType === "thinking_delta" ? "thinking" : "signature";
  return jsonLineAtExactBytes((signature) => ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: deltaType, [contentKey]: signature },
    },
    session_id: "session-test",
    parent_tool_use_id: null,
    uuid: "uuid-test",
  }), targetBytes);
}

function observedSignatureDeltaLine() {
  return signatureDeltaLineAtBytes();
}

function observedAssistantThinkingLine() {
  return jsonLineAtExactBytes((thinking) => ({
    type: "assistant",
    message: {
      model: "claude-test",
      id: "message-test",
      type: "message",
      role: "assistant",
      content: [{ type: "thinking", thinking, signature: "signature-test" }],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {},
      input_transformations: [],
      diagnostics: null,
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: "session-test",
    uuid: "uuid-test",
    timestamp: "2026-09-02T00:00:00.000Z",
    request_id: "request-test",
  }), 78_752);
}

function observedAssistantThinkingLineWithUnknownKey() {
  return jsonLineAtExactBytes((thinking) => ({
    type: "assistant",
    message: {
      model: "claude-test",
      id: "message-test",
      type: "message",
      role: "assistant",
      content: [{ type: "thinking", thinking, signature: "signature-test" }],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {},
      input_transformations: [],
      diagnostics: null,
      context_management: null,
      future_unknown_key: null,
    },
    parent_tool_use_id: null,
    session_id: "session-test",
    uuid: "uuid-test",
    timestamp: "2026-09-02T00:00:00.000Z",
    request_id: "request-test",
  }), 78_900);
}

function collectReviewerLineOutcome(line, {
  reviewerFamily = "claude",
  stream = "stdout",
  initialByteOffset = 0,
} = {}) {
  const lines = [];
  const overflows = [];
  const discards = [];
  const discardRanges = [];
  const createRouter = __testReviewerOutput.createReviewerOutputLineRouter
    ?? __testReviewerOutput.createBoundedLineAccumulator;
  const accumulator = createRouter({
    reviewerFamily,
    stream,
    initialByteOffset,
    onLine: (value) => lines.push(value),
    onOverflow: (value) => overflows.push(value),
    onDiscard: (value, range) => {
      discards.push(value);
      discardRanges.push(range);
    },
  });
  const bytes = Buffer.from(`${line}\n`, "utf8");
  accumulator.write(bytes.subarray(0, 60_000));
  accumulator.write(bytes.subarray(60_000));
  accumulator.end();
  return { lines, overflows, discards, discardRanges };
}

function collectClaudeStdoutLineOutcome(line) {
  return collectReviewerLineOutcome(line);
}

test("T1 prove-it: framed v5 pages are an active window, not full 1..N content", () => {
  const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource());
  assert.equal(normalized.schema_version, "devpro-second-review-data/v5");
  assert.deepEqual(Object.keys(normalized.review_material), [...PAGED_REVIEW_MATERIAL_KEYS]);
  const pageCount = normalized.review_material.manifest.page_count;
  assert.ok(pageCount > SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES);
  assert.ok(requiresPageWindowing(pageCount));
  assert.equal(normalized.review_material.pages.length, SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES);
  assert.notEqual(normalized.review_material.pages.length, pageCount);
  assert.equal(normalized.review_material.window_role, "intermediate");
  assert.ok(Array.isArray(normalized.__paged_full_pages));
  assert.equal(normalized.__paged_full_pages.length, pageCount);
});

test("T1 prove-it: material-unavailable UNAVAILABLE must not overwrite prior PASS/WARN sticky", () => {
  assert.equal(
    __testReviewerClassification.shouldBlockUnavailableStickyOverwrite({
      materialAvailable: false,
      priorGateSatisfyingSticky: { verdict: "PASS" },
      proposedVerdict: "UNAVAILABLE",
    }),
    true,
  );
  assert.equal(
    __testReviewerClassification.shouldBlockUnavailableStickyOverwrite({
      materialAvailable: true,
      priorGateSatisfyingSticky: { verdict: "PASS" },
      proposedVerdict: "UNAVAILABLE",
    }),
    false,
  );
});

test("T2 prove-it: findings-lost / missing window / Critical / intermediate UNAVAILABLE block final PASS|WARN", () => {
  const pageCount = 2;
  const covered = sealCheckpointLedger({
    covered_indices: [1, 2],
    page_bindings: [
      { index: 1, sha256: "a".repeat(64) },
      { index: 2, sha256: "b".repeat(64) },
    ],
  });
  assert.equal(
    authorizeGateSatisfyingSticky({
      checkpointLedger: covered,
      findingsLedger: emptyFindingsLedger(),
      pageCount,
      windowMaxPages: 1,
    }).authorized,
    false,
  );

  const withUnavail = __testReviewerClassification.advancePageWindowLedgers({
    reviewMaterial: {
      manifest: {
        page_count: pageCount,
        pages: [
          { index: 1, sha256: materialSha256("page-one") },
          { index: 2, sha256: materialSha256("page-two") },
        ],
      },
      pages: [{ index: 1, content: "page-one" }],
      checkpoint_ledger: emptyCheckpointLedger(),
      findings_ledger: emptyFindingsLedger(),
      window_role: "intermediate",
    },
    completion: {
      status: "blocking-verdict",
      completion: {
        window_index: 1,
        page_indices: [1],
        verdict: "UNAVAILABLE",
        findings: [],
      },
    },
    windowMaxPages: 1,
  });
  const afterSecond = __testReviewerClassification.advancePageWindowLedgers({
    reviewMaterial: {
      manifest: {
        page_count: pageCount,
        pages: [
          { index: 1, sha256: materialSha256("page-one") },
          { index: 2, sha256: materialSha256("page-two") },
        ],
      },
      pages: [{ index: 2, content: "page-two" }],
      checkpoint_ledger: withUnavail.checkpoint_ledger,
      findings_ledger: withUnavail.findings_ledger,
      window_role: "final",
    },
    completion: {
      status: "accepted",
      completion: {
        window_index: 2,
        page_indices: [2],
        verdict: "PASS",
        findings: [],
      },
    },
    windowMaxPages: 1,
  });
  assert.equal(afterSecond.sticky_authorized.authorized, false);
  assert.equal(afterSecond.sticky_authorized.reason, "intermediate_unavailable");

  const withCritical = __testReviewerClassification.advancePageWindowLedgers({
    reviewMaterial: {
      manifest: {
        page_count: 1,
        pages: [{ index: 1, sha256: materialSha256("only") }],
      },
      pages: [{ index: 1, content: "only" }],
      checkpoint_ledger: emptyCheckpointLedger(),
      findings_ledger: emptyFindingsLedger(),
      window_role: "final",
    },
    completion: {
      status: "blocking-verdict",
      completion: {
        window_index: 1,
        page_indices: [1],
        verdict: "CRITICAL",
        findings: [{ severity: "CRITICAL", summary_id: "c1", summary: "blocking" }],
      },
    },
    windowMaxPages: 1,
  });
  assert.equal(withCritical.sticky_authorized.authorized, false);
});

test("T3 prove-it: page-window path rejects five-field completion", () => {
  const parsed = parsePageWindowCompletionObject({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: "a".repeat(40),
    reviewer_model: "test-model",
    reason: "five field only",
  }, {
    headRefOid: "a".repeat(40),
    dispatchId: "dispatch-1",
  });
  assert.equal(parsed.status, "malformed");

  const findings = [];
  const eleven = {
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: "a".repeat(40),
    reviewer_model: "test-model",
    reason: "window complete",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: "a".repeat(40),
    dispatch_id: "dispatch-1",
    findings,
    findings_payload_sha256: findingsPayloadSha256({
      window_index: 1,
      page_indices: [1],
      head_ref_oid: "a".repeat(40),
      dispatch_id: "dispatch-1",
      findings,
    }),
  };
  assert.equal(
    parsePageWindowCompletionObject(eleven, {
      headRefOid: "a".repeat(40),
      dispatchId: "dispatch-1",
      expectedWindowIndex: 1,
      expectedPageIndices: [1],
    }).status,
    "accepted",
  );
});

test("T21 prove-it: page-window completion accepts exact keys in Claude alphabetical order", () => {
  const head = "e".repeat(40);
  const alphabeticallyOrdered = {
    dispatch_id: "dispatch-member-order",
    findings: [],
    findings_payload_sha256: "runner-seal",
    head_ref_oid: head,
    last_reviewed_sha: head,
    page_indices: [1],
    reason: "schema-valid completion with serializer-defined member order",
    reviewer_model: "claude-test",
    sticky_comment_url: "none",
    verdict: "PASS",
    window_index: 1,
  };
  const options = {
    headRefOid: head,
    dispatchId: "dispatch-member-order",
    expectedWindowIndex: 1,
    expectedPageIndices: [1],
  };

  assert.equal(
    parsePageWindowCompletionObject(alphabeticallyOrdered, options).status,
    "accepted",
  );

  const { verdict: _verdict, ...sameCountWrongKey } = alphabeticallyOrdered;
  sameCountWrongKey.verdict_typo = "PASS";
  assert.equal(
    parsePageWindowCompletionObject(sameCountWrongKey, options).status,
    "malformed",
  );
});

test("T3f dogfood: last_reviewed_sha must match verified headRefOid", () => {
  const findings = [];
  const head = "b".repeat(40);
  const other = "c".repeat(40);
  const mismatchedStickySha = parsePageWindowCompletionObject({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: other,
    reviewer_model: "test-model",
    reason: "window complete",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: head,
    dispatch_id: "dispatch-sha",
    findings,
    findings_payload_sha256: "runner-seal",
  }, {
    headRefOid: head,
    dispatchId: "dispatch-sha",
    expectedWindowIndex: 1,
    expectedPageIndices: [1],
  });
  assert.equal(mismatchedStickySha.status, "stale");

  const mismatchedPair = parsePageWindowCompletionObject({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: other,
    reviewer_model: "test-model",
    reason: "window complete",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: other,
    dispatch_id: "dispatch-sha",
    findings,
    findings_payload_sha256: "runner-seal",
  }, {
    headRefOid: head,
    dispatchId: "dispatch-sha",
  });
  assert.equal(mismatchedPair.status, "stale");

  const internalMismatch = parsePageWindowCompletionObject({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: other,
    reviewer_model: "test-model",
    reason: "window complete",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: head,
    dispatch_id: "dispatch-sha",
    findings,
    findings_payload_sha256: "runner-seal",
  });
  assert.equal(internalMismatch.status, "malformed");
});

test("T3g dogfood: page-window reason enforces UTF-8 byte cap at multibyte boundary", () => {
  const head = "d".repeat(40);
  const findings = [];
  const withReason = (reason) => ({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: head,
    reviewer_model: "test-model",
    reason,
    window_index: 1,
    page_indices: [1],
    head_ref_oid: head,
    dispatch_id: "dispatch-reason-cap",
    findings,
    findings_payload_sha256: "runner-seal",
  });
  const options = {
    headRefOid: head,
    dispatchId: "dispatch-reason-cap",
    expectedWindowIndex: 1,
    expectedPageIndices: [1],
  };

  const asciiExact = "a".repeat(SECOND_REVIEW_VERDICT_REASON_MAX_BYTES);
  assert.equal(Buffer.byteLength(asciiExact, "utf8"), SECOND_REVIEW_VERDICT_REASON_MAX_BYTES);
  assert.equal(
    parsePageWindowCompletionObject(withReason(asciiExact), options).status,
    "accepted",
  );

  const asciiOver = `${asciiExact}x`;
  assert.equal(Buffer.byteLength(asciiOver, "utf8"), SECOND_REVIEW_VERDICT_REASON_MAX_BYTES + 1);
  assert.equal(
    parsePageWindowCompletionObject(withReason(asciiOver), options).status,
    "malformed",
  );

  // U+4F60 "你" is 3 UTF-8 bytes; fill to exact cap then one more code point over.
  const cjk = "你";
  const cjkBytes = Buffer.byteLength(cjk, "utf8");
  assert.equal(cjkBytes, 3);
  const cjkCount = Math.floor(SECOND_REVIEW_VERDICT_REASON_MAX_BYTES / cjkBytes);
  const padAscii = "b".repeat(SECOND_REVIEW_VERDICT_REASON_MAX_BYTES - (cjkCount * cjkBytes));
  const multibyteExact = `${cjk.repeat(cjkCount)}${padAscii}`;
  assert.equal(Buffer.byteLength(multibyteExact, "utf8"), SECOND_REVIEW_VERDICT_REASON_MAX_BYTES);
  assert.equal(
    parsePageWindowCompletionObject(withReason(multibyteExact), options).status,
    "accepted",
  );

  const multibyteOver = `${multibyteExact}${cjk}`;
  assert.ok(Buffer.byteLength(multibyteOver, "utf8") > SECOND_REVIEW_VERDICT_REASON_MAX_BYTES);
  assert.equal(
    parsePageWindowCompletionObject(withReason(multibyteOver), options).status,
    "malformed",
  );
});

test("T3b dogfood: wrong reviewer digest is sealed by runner; packet documents runner ownership", () => {
  const findings = [{
    severity: "INFO",
    summary_id: "page-1-reviewed",
    summary: "Reviewed active page 1 of 14; no concrete blocking defect identified in this window.",
  }];
  const findingsOnlyDigest = createHash("sha256")
    .update(JSON.stringify(findings), "utf8")
    .digest("hex");
  const wrong = {
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: "1d150bafca0e38c80d6116492075ac0cca84308c",
    reviewer_model: "gpt-5",
    reason: "Reviewed active page 1 of 14",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: "1d150bafca0e38c80d6116492075ac0cca84308c",
    dispatch_id: "dispatch-c05dbbc2-997e-4997-a91e-affa09c0821a",
    findings,
    findings_payload_sha256: findingsOnlyDigest,
  };
  const parsed = parsePageWindowCompletionObject(wrong, {
    headRefOid: wrong.head_ref_oid,
    dispatchId: wrong.dispatch_id,
    expectedWindowIndex: 1,
    expectedPageIndices: [1],
  });
  assert.equal(parsed.status, "accepted");
  const expectedDigest = findingsPayloadSha256({
    window_index: wrong.window_index,
    page_indices: wrong.page_indices,
    head_ref_oid: wrong.head_ref_oid,
    dispatch_id: wrong.dispatch_id,
    findings,
  });
  assert.equal(parsed.completion.findings_payload_sha256, expectedDigest);
  assert.notEqual(parsed.completion.findings_payload_sha256, findingsOnlyDigest);

  assert.match(
    SECOND_REVIEW_PAGE_WINDOW_FINDINGS_PAYLOAD_SHA256_RULE,
    /Projection runner MUST overwrite/,
  );
  assert.match(
    SECOND_REVIEW_PAGE_WINDOW_FINDINGS_PAYLOAD_SHA256_RULE,
    /MUST NOT gate acceptance/,
  );
  assert.equal(
    secondReviewPacketStaticSuffix(SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION),
    SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX,
  );
  assert.equal(
    SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX.includes(
      SECOND_REVIEW_PAGE_WINDOW_FINDINGS_PAYLOAD_SHA256_RULE,
    ),
    true,
  );
  assert.match(
    SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX,
    /Example for an intermediate window with no sticky \(the full eleven-key shape\): \{[^\n]*"sticky_comment_url":"none"[^\n]*"window_index":[^\n]*"page_indices":[^\n]*"head_ref_oid":[^\n]*"dispatch_id":[^\n]*"findings":[^\n]*"findings_payload_sha256":"runner-seal"\}/,
    "the page-window no-sticky example must keep the eleven-key shape, not the five-key one",
  );
  assert.match(
    SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX,
    /## Completion JSON[\s\S]*findings_payload_sha256_rule:[\s\S]*"findings_payload_sha256":"runner-seal"/,
  );
});

test("Page-window completion: carrier_class is a summary prefix, never an extra finding key", () => {
  // Root cause of reviewer_completion_contract_invalid on PR #2930: the shared duty bullet
  // tells every reviewer to tag each finding with carrier_class, while the page-window
  // completion only accepts the FINDING_ITEM_KEYS object shape. The packet must say where
  // the tag goes, and the contract it names must be the one the parser enforces.
  const rule = SECOND_REVIEW_PAGE_WINDOW_FINDINGS_CARRIER_CLASS_RULE;
  for (const key of FINDING_ITEM_KEYS) assert.ok(rule.includes(key), `rule names the allowed finding key ${key}`);
  assert.match(rule, /leading `carrier_class: <class>; ` of summary/);
  assert.match(rule, /never as an extra JSON key/);
  for (const carrierClass of ["rule", "code", "test", "change-folder-bookkeeping"]) assert.ok(rule.includes(carrierClass));
  const suffix = SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX;
  assert.ok(suffix.includes(rule), "the page-window Completion JSON section carries the rule");
  assert.ok(suffix.indexOf(SECOND_REVIEW_PAGE_WINDOW_FINDINGS_PAYLOAD_SHA256_RULE) < suffix.indexOf(rule), "rule follows the digest rule");
  assert.ok(suffix.indexOf(rule) < suffix.indexOf('"findings_payload_sha256":"runner-seal"'), "rule precedes the JSON example the reviewer copies");
  assert.equal(SECOND_REVIEW_PACKET_STATIC_SUFFIX.includes("finding_carrier_class_rule"), false, "non-paged packets have no JSON findings and stay unchanged");
  const base = {
    sticky_comment_url: "none",
    verdict: "WARN",
    last_reviewed_sha: "1d150bafca0e38c80d6116492075ac0cca84308c",
    reviewer_model: "gpt-5",
    reason: "One concrete finding on page 1",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: "1d150bafca0e38c80d6116492075ac0cca84308c",
    dispatch_id: "dispatch-c05dbbc2-997e-4997-a91e-affa09c0821a",
    findings_payload_sha256: "runner-seal",
  };
  const options = { headRefOid: base.head_ref_oid, dispatchId: base.dispatch_id, expectedWindowIndex: 1, expectedPageIndices: [1] };
  const prefixed = parsePageWindowCompletionObject({ ...base, findings: [{ severity: "WARN", summary_id: "F1", summary: "carrier_class: code; missing null check in parser" }] }, options);
  assert.equal(prefixed.status, "accepted", "carrier_class inside summary is accepted");
  const extraKey = parsePageWindowCompletionObject({ ...base, findings: [{ severity: "WARN", summary_id: "F1", summary: "missing null check in parser", carrier_class: "code" }] }, options);
  assert.equal(extraKey.status, "malformed", "an extra carrier_class key is what the parser rejects");
});

test("T3c dogfood: intermediate page-window disposition hides executable sticky recipe until final", () => {
  const authorized = {
    schema: "devpro-second-review-sticky-write-disposition/v1",
    action: "create",
    repository_slug: "devpro/example",
    pr_number: 2013,
    dispatch_id: "dispatch-final",
    candidate_count: 0,
    snapshot_digest: "a".repeat(64),
  };
  const blocked = pageWindowIntermediateStickyDisposition(authorized);
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.classification, "page_window_sticky_deferred_until_final");
  assert.equal(blocked.repository_slug, authorized.repository_slug);
  assert.equal(blocked.dispatch_id, authorized.dispatch_id);

  const intermediatePrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    authorized.dispatch_id,
    blocked,
    SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION,
    { pageWindowCheckpointHandoff: true },
  );
  assert.match(intermediatePrefix, /sticky_write_action: blocked/);
  assert.doesNotMatch(intermediatePrefix, /sticky_write_exact_recipe:/);
  assert.doesNotMatch(intermediatePrefix, /write-second-review-sticky-gated\.mjs/);

  const finalPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    authorized.dispatch_id,
    authorized,
    SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION,
    { pageWindowCheckpointHandoff: true },
  );
  assert.match(finalPrefix, /sticky_write_action: create/);
  assert.match(finalPrefix, /sticky_write_exact_recipe:/);
  assert.match(finalPrefix, /write-second-review-sticky-gated\.mjs/);

  const runnerSource = readFileSync(
    repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8",
  );
  assert.match(runnerSource, /writePageWindowPacketWithDisposition\(/);
  assert.match(runnerSource, /sticky_write_disposition_authorized/);
  assert.match(runnerSource, /framed\.window_role === \"final\"/);
});

test("T3e dogfood: page-window completion suffix binds active window/page indices", () => {
  assert.equal(
    secondReviewPacketStaticSuffix(SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION),
    SECOND_REVIEW_PAGE_WINDOW_PACKET_STATIC_SUFFIX,
  );
  const windowTwo = secondReviewPacketStaticSuffix(SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION, {
    windowIndex: 2,
    pageIndices: [2],
  });
  assert.match(windowTwo, /"window_index":2/);
  assert.match(windowTwo, /"page_indices":\[2\]/);
  assert.equal(windowTwo.includes('"window_index":1'), false);

  const fromMaterial = pageWindowCompletionBindingFromReviewMaterial({
    pages: [{ index: 2, content: "page-two" }],
  }, 1);
  assert.deepEqual(fromMaterial, { windowIndex: 2, pageIndices: [2] });
  assert.equal(
    secondReviewPacketStaticSuffix(SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION, fromMaterial),
    windowTwo,
  );
});

test("T3d dogfood: deferred blocked packet disposition still passes pre-spawn authority via authorized sidecar", () => {
  const emptySnapshot = {
    repository_slug: "devpro/example",
    pr_number: 2013,
    completeness: { status: "complete", pagination_exhausted: true, pages_fetched: 1 },
    query_error: null,
    comments: [],
  };
  const liveCreate = resolveSecondReviewStickyWriteDisposition(emptySnapshot);
  assert.equal(liveCreate.action, "create");
  const authorized = {
    ...liveCreate,
    dispatch_id: "dispatch-deferred",
  };
  const context = {
    mode: "pr-sticky",
    repository_slug: "devpro/example",
    pr_number: 2013,
    dispatch_id: "dispatch-deferred",
    page_window_checkpoint_handoff: true,
    sticky_write_disposition: pageWindowIntermediateStickyDisposition(authorized),
    sticky_write_disposition_authorized: authorized,
  };
  const verified = __testReviewerClassification.revalidateSecondReviewStickyWriteDisposition(
    context,
    {
      spawnSync(executable, argv, options) {
        assert.equal(executable, "gh");
        assert.deepEqual(argv, [
          "api",
          "--paginate",
          "--slurp",
          "repos/devpro/example/issues/2013/comments?per_page=100",
        ]);
        assert.equal(options.env.GH_REPO, "devpro/example");
        return {
          status: 0,
          stdout: JSON.stringify({
            comments: [],
            completeness: emptySnapshot.completeness,
            query_error: null,
          }),
          stderr: "",
        };
      },
    },
  );
  assert.equal(verified.status, "verified");
  assert.equal(verified.sticky_deferred_until_final, true);
  assert.equal(verified.disposition.action, "create");
  assert.equal(context.sticky_write_disposition.action, "blocked");
  assert.equal(
    context.sticky_write_disposition.classification,
    PAGE_WINDOW_STICKY_DEFERRED_CLASSIFICATION,
  );

  const hardBlocked = __testReviewerClassification.revalidateSecondReviewStickyWriteDisposition({
    mode: "pr-sticky",
    repository_slug: "devpro/example",
    pr_number: 2013,
    dispatch_id: "dispatch-hard-block",
    page_window_checkpoint_handoff: true,
    sticky_write_disposition: {
      schema: "devpro-second-review-sticky-write-disposition/v1",
      action: "blocked",
      repository_slug: "devpro/example",
      pr_number: 2013,
      dispatch_id: "dispatch-hard-block",
      classification: "sticky_authority_multiple_candidates",
      reason: "true authority block",
    },
  });
  assert.equal(hardBlocked.status, "blocked");
});

test("T4 prove-it: handoff docs no longer advertise CRITICAL 清單; missing snapshot identity blocks", () => {
  const skill = readFileSync(
    repoPath(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md"),
    "utf8",
  );
  assert.equal(skill.includes("前次 sticky CRITICAL 清單"), false);
  assert.match(skill, /classification/);
  assert.match(skill, /sticky_verification/);

  const disposition = resolveSecondReviewStickyWriteDisposition({
    schema: "devpro-second-review-sticky-authority-snapshot/v1",
    repository_slug: "devpro/example",
    pr_number: 2008,
    completeness: {
      status: "complete",
      pagination_exhausted: true,
      pages_fetched: 1,
    },
    query_error: null,
    comments: [
      {
        body: "<!-- cross-model-second-opinion:sticky -->\nverdict: PASS\n",
        id: 42,
      },
    ],
  });
  assert.equal(disposition.action, "blocked");
});

test("T14a: lawful page-window v5 validates", () => {
  const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource());
  const { __paged_full_pages: _full, ...framed } = normalized;
  assert.deepEqual(validatePrStickyReviewMaterialContract(framed), []);
  void _full;
});

test("T14b: nonpaged claiming v5 fails closed", () => {
  const row = canonicalPagedSource("diff --git a/x b/x\nshort");
  row.schema_version = "devpro-second-review-data/v5";
  row.review_material_carrier = "embedded-diff";
  const errors = validatePrStickyReviewMaterialContract(row);
  assert.ok(errors.some((message) => /v5|renderer-paged-snapshot|schema_version/i.test(message)));
});

test("T14c: page-window claiming v4 fails closed", () => {
  const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource());
  const { __paged_full_pages: _full, ...framed } = normalized;
  framed.schema_version = "devpro-second-review-data/v4";
  const errors = validatePrStickyReviewMaterialContract(framed);
  assert.ok(errors.some((message) => /v4|renderer-paged-snapshot|schema_version/i.test(message)));
  void _full;
});

test("T14d: lawful nonpaged v4 still validates", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const reviewScope = {
    kind: "full-pr",
    pull_request_number: 2009,
    head_sha: head,
  };
  const material = "diff --git a/x b/x\n+ok\n";
  const row = {
    schema_version: "devpro-second-review-data/v4",
    mode: "pr-sticky",
    attempt: "initial",
    dispatch_id: "dispatch-test",
    previous_dispatch_id: null,
    primary_family: "claude",
    reviewer_family: "claude",
    target: "PR #2009",
    head_ref_oid: head,
    approval_context: "none",
    approval_resolution: { status: "not-required" },
    review_scope: reviewScope,
    scope_summary: "nonpaged",
    changed_files_or_touch_list: ["x"],
    review_material_carrier: "embedded-diff",
    review_material_capability: "scope-bound-embedded-complete-diff-v1",
    review_material_proof: {
      kind: "embedded-complete-diff-v1",
      scope_fingerprint_sha256: reviewScopeFingerprintSha256(reviewScope),
      material_format: "git-unified-diff",
      material_utf8_bytes: Buffer.byteLength(material, "utf8"),
      material_sha256: materialSha256(material),
    },
    review_material: material,
    previous_sticky: "none",
    retry_context: { classification: "none", sticky_verification: "not-needed" },
    linked_issue_context: "none",
    primary_verdict: "none",
    evidence: [{ kind: "validation", narrative: "ok" }, { kind: "test", narrative: "ok" }],
  };
  assert.deepEqual(validatePrStickyReviewMaterialContract(row), []);
});

test("T27 oversized thinking-only transport prove-it accepts observed Claude stdout shapes", () => {
  const signature = collectClaudeStdoutLineOutcome(observedSignatureDeltaLine());
  const assistant = collectClaudeStdoutLineOutcome(observedAssistantThinkingLine());

  assert.deepEqual(signature.lines, []);
  assert.deepEqual(assistant.lines, []);
  assert.deepEqual(signature.overflows, []);
  assert.deepEqual(assistant.overflows, []);
  assert.deepEqual(signature.discards, [{
    event_class: "stream_event_signature_delta",
    byte_length: 93_638,
    hard_cap_bytes: 1024 * 1024,
  }]);
  assert.deepEqual(assistant.discards, [{
    event_class: "assistant_thinking_only",
    byte_length: 78_752,
    hard_cap_bytes: 1024 * 1024,
  }]);
});

// Issue #3234: Claude CLI 2.1.296 adds a root `api_message_id` to stream events.
test("Claude stream api_message_id: the observed optional root key preserves bounded discard for both delta types", () => {
  const signatureRow = { ...JSON.parse(observedSignatureDeltaLine()), api_message_id: "msg_01ExampleExampleExample" };
  const signatureLine = JSON.stringify(signatureRow);
  assert.ok(Buffer.byteLength(signatureLine, "utf8") > 64 * 1024);
  const outcome = collectClaudeStdoutLineOutcome(signatureLine);
  assert.deepEqual(outcome.lines, []);
  assert.deepEqual(outcome.overflows, []);
  assert.deepEqual(outcome.discards, [{
    event_class: "stream_event_signature_delta",
    byte_length: Buffer.byteLength(signatureLine, "utf8"),
    hard_cap_bytes: 1024 * 1024,
  }]);
  const thinkingLine = JSON.stringify({
    ...signatureRow,
    event: { ...signatureRow.event, delta: { type: "thinking_delta", thinking: "t".repeat(70_000) } },
  });
  assert.deepEqual(collectClaudeStdoutLineOutcome(thinkingLine).discards.map((entry) => entry.event_class), ["stream_event_thinking_delta"]);
});

test("Claude stream api_message_id: a malformed value or any other unknown root key still fails closed", () => {
  const row = JSON.parse(observedSignatureDeltaLine());
  for (const unsafe of [
    { ...row, api_message_id: "" },
    { ...row, api_message_id: null },
    { ...row, api_message_id: 1 },
    { ...row, api_message_id: { id: "msg_x" } },
    { ...row, future_unknown_key: "x" },
    { ...row, api_message_id: "msg_x", future_unknown_key: "x" },
  ]) {
    const outcome = collectClaudeStdoutLineOutcome(JSON.stringify(unsafe));
    assert.equal(outcome.overflows.length, 1, `${JSON.stringify(Object.keys(unsafe))} must fail closed`);
    assert.deepEqual(outcome.discards, []);
  }
});

test("Claude thinking duration: observed optional timing metadata preserves bounded discard", () => {
  const row = JSON.parse(observedAssistantThinkingLine());
  row.message.content[0].thinking = "";
  row.message.content[0].signature = "x".repeat(155_628);
  row.thinking_duration_ms = 480_001;
  const line = JSON.stringify(row);
  const outcome = collectClaudeStdoutLineOutcome(line);
  assert.deepEqual(outcome.lines, []);
  assert.deepEqual(outcome.overflows, []);
  assert.deepEqual(outcome.discards, [{
    event_class: "assistant_thinking_only",
    byte_length: Buffer.byteLength(line, "utf8"),
    hard_cap_bytes: 1024 * 1024,
  }]);
  assert.equal(collectClaudeStdoutLineOutcome(JSON.stringify({ ...row, thinking_duration_ms: 0 })).discards.length, 1);

  const atCap = jsonLineAtExactBytes((signature) => ({
    ...row,
    message: { ...row.message, content: [{ type: "thinking", thinking: "", signature }] },
  }), 1024 * 1024);
  assert.equal(collectClaudeStdoutLineOutcome(atCap).discards.length, 1);
  const overCap = atCap.replace('"signature":"', '"signature":"x');
  assert.deepEqual(collectClaudeStdoutLineOutcome(overCap).overflows, [{ maxBytes: 1024 * 1024 }]);
});

test("Claude thinking display: observed updates metadata preserves bounded discard", () => {
  const row = JSON.parse(observedAssistantThinkingLine());
  row.thinking_display = "updates";
  for (const candidate of [row, { ...row, thinking_duration_ms: 480_001 }]) {
    const line = JSON.stringify(candidate);
    const outcome = collectClaudeStdoutLineOutcome(line);
    assert.deepEqual(outcome.lines, []);
    assert.deepEqual(outcome.overflows, []);
    assert.deepEqual(outcome.discards, [{
      event_class: "assistant_thinking_only",
      byte_length: Buffer.byteLength(line),
      hard_cap_bytes: 1024 * 1024,
    }]);
  }
  const atCap = jsonLineAtExactBytes((thinking) => ({
    ...row, message: { ...row.message, content: [{ type: "thinking", thinking, signature: "test" }] },
  }), 1024 * 1024);
  assert.equal(collectClaudeStdoutLineOutcome(atCap).discards.length, 1);
  assert.deepEqual(collectClaudeStdoutLineOutcome(atCap.replace('"thinking":"', '"thinking":"x')).overflows, [{ maxBytes: 1024 * 1024 }]);
});

test("Claude thinking display: invalid modes, extra fields and mixed content fail closed", () => {
  const row = { ...JSON.parse(observedAssistantThinkingLine()), thinking_display: "updates" };
  for (const unsafe of [
    ...[null, true, 1, {}, "", "future_mode"].map((thinking_display) => ({ ...row, thinking_display })),
    { ...row, future_unknown_key: null },
    { ...row, thinking_duration_ms: -1 },
    ...["text", "tool_use"].map((type) => ({
      ...row, message: { ...row.message, content: [...row.message.content, { type }] },
    })),
  ]) {
    const outcome = collectClaudeStdoutLineOutcome(JSON.stringify(unsafe));
    assert.equal(outcome.overflows.length, 1);
    assert.deepEqual(outcome.discards, []);
  }
});

test("Claude thinking duration: malformed timing, unknown fields and mixed content fail closed", () => {
  const row = JSON.parse(observedAssistantThinkingLine());
  row.thinking_duration_ms = 1;
  for (const duration of [null, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const outcome = collectClaudeStdoutLineOutcome(JSON.stringify({ ...row, thinking_duration_ms: duration }));
    assert.equal(outcome.overflows.length, 1, `duration ${JSON.stringify(duration)} must fail closed`);
    assert.deepEqual(outcome.discards, []);
  }
  for (const unsafe of [
    { ...row, future_unknown_key: null },
    { ...row, message: { ...row.message, content: [...row.message.content, { type: "text", text: "visible output" }] } },
    { ...row, message: { ...row.message, content: [...row.message.content, { type: "tool_use", id: "tool-test", name: "Bash", input: {} }] } },
  ]) {
    const outcome = collectClaudeStdoutLineOutcome(JSON.stringify(unsafe));
    assert.equal(outcome.overflows.length, 1);
    assert.deepEqual(outcome.discards, []);
  }
});

test("T29 thinking-line router preserves generic boundaries and fails closed on unsafe candidates", () => {
  const runnerSource = readFileSync(
    repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8"
  );
  assert.match(runnerSource, /stdout: createReviewerOutputLineRouter\(\{/);
  assert.match(runnerSource, /reviewerFamily: tool,[\s\S]*?stream: "stdout"/);
  assert.match(runnerSource, /stderr: createBoundedLineAccumulator\(\{/);
  assert.match(runnerSource, /projection_cli_thinking_line_discarded/);

  const atLimit = collectClaudeStdoutLineOutcome("x".repeat(64 * 1024));
  assert.equal(atLimit.overflows.length, 0);
  assert.equal(atLimit.discards.length, 0);
  assert.equal(Buffer.byteLength(atLimit.lines[0], "utf8"), 64 * 1024);

  const genericOverflow = collectClaudeStdoutLineOutcome("x".repeat((64 * 1024) + 1));
  assert.deepEqual(genericOverflow.lines, []);
  assert.deepEqual(genericOverflow.discards, []);
  assert.deepEqual(genericOverflow.overflows, [{ maxBytes: 64 * 1024 }]);

  const thinkingDelta = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes(93_700, "thinking_delta")
  );
  assert.deepEqual(thinkingDelta.overflows, []);
  assert.deepEqual(thinkingDelta.discards, [{
    event_class: "stream_event_thinking_delta",
    byte_length: 93_700,
    hard_cap_bytes: 1024 * 1024,
  }]);

  const signatureOnStderr = collectReviewerLineOutcome(observedSignatureDeltaLine(), {
    reviewerFamily: "claude",
    stream: "stderr",
  });
  assert.deepEqual(signatureOnStderr.overflows, [{ maxBytes: 64 * 1024 }]);
  assert.deepEqual(signatureOnStderr.discards, []);
  assert.deepEqual(signatureOnStderr.discardRanges, []);

  const signatureFromCodex = collectReviewerLineOutcome(observedSignatureDeltaLine(), {
    reviewerFamily: "codex",
    stream: "stdout",
  });
  assert.deepEqual(signatureFromCodex.overflows, [{ maxBytes: 64 * 1024 }]);
  assert.deepEqual(signatureFromCodex.discards, []);
  assert.deepEqual(signatureFromCodex.discardRanges, []);

  const unknownDelta = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes(93_638, "text_delta")
  );
  assert.deepEqual(unknownDelta.overflows, [{ maxBytes: 64 * 1024 }]);
  assert.deepEqual(unknownDelta.discards, []);

  const resultLine = jsonLineAtExactBytes((result) => ({
    type: "result",
    subtype: "success",
    result,
  }), 70_000);
  const resultOverflow = collectClaudeStdoutLineOutcome(resultLine);
  assert.deepEqual(resultOverflow.overflows, [{ maxBytes: 64 * 1024 }]);
  assert.deepEqual(resultOverflow.discards, []);

  const mixedAssistant = jsonLineAtExactBytes((thinking) => ({
    type: "assistant",
    message: {
      model: "claude-test",
      id: "message-test",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature: "signature-test" },
        { type: "tool_use", id: "tool-test", name: "StructuredOutput", input: {} },
      ],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {},
      input_transformations: [],
      diagnostics: null,
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: "session-test",
    uuid: "uuid-test",
    timestamp: "2026-09-02T00:00:00.000Z",
    request_id: "request-test",
  }), 94_200);
  const mixedOverflow = collectClaudeStdoutLineOutcome(mixedAssistant);
  assert.deepEqual(mixedOverflow.overflows, [{
    maxBytes: 64 * 1024,
    byteLength: 94_200,
    classificationReason: "strict_thinking_shape_rejected",
  }]);
  assert.deepEqual(mixedOverflow.discards, []);

  const malformedCandidate = collectClaudeStdoutLineOutcome(
    observedSignatureDeltaLine().slice(0, -1)
  );
  assert.deepEqual(malformedCandidate.overflows, [{
    maxBytes: 64 * 1024,
    byteLength: Buffer.byteLength(observedSignatureDeltaLine().slice(0, -1), "utf8"),
    classificationReason: "strict_thinking_shape_rejected",
  }]);
  assert.deepEqual(malformedCandidate.discards, []);

  const overThinkingCap = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes((128 * 1024) + 1)
  );
  assert.deepEqual(overThinkingCap.overflows, []);
  assert.deepEqual(overThinkingCap.discards, [{
    event_class: "stream_event_signature_delta",
    byte_length: (128 * 1024) + 1,
    hard_cap_bytes: 1024 * 1024,
  }]);

  const overSignatureCap = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes((1024 * 1024) + 1)
  );
  assert.deepEqual(overSignatureCap.overflows, [{ maxBytes: 1024 * 1024 }]);
  assert.deepEqual(overSignatureCap.discards, []);

  const overThinkingCapMiB = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes((1024 * 1024) + 1, "thinking_delta")
  );
  assert.deepEqual(overThinkingCapMiB.overflows, [{ maxBytes: 1024 * 1024 }]);
  assert.deepEqual(overThinkingCapMiB.discards, []);

  const unknownKeyAssistant = collectClaudeStdoutLineOutcome(
    observedAssistantThinkingLineWithUnknownKey()
  );
  assert.deepEqual(unknownKeyAssistant.overflows, [{
    maxBytes: 64 * 1024,
    byteLength: Buffer.byteLength(observedAssistantThinkingLineWithUnknownKey(), "utf8"),
    classificationReason: "strict_thinking_shape_rejected",
  }]);
  assert.deepEqual(unknownKeyAssistant.discards, []);

  // F-dhdg-r4-02: 11-key legacy assistant shape (pre-container/input_transformations)
  // over the generic boundary fails closed as overflow — strict 13-key set is the
  // current CLI shape; older shapes fail closed (safe direction), never discard.
  const legacyElevenKeyAssistant = collectClaudeStdoutLineOutcome(
    jsonLineAtExactBytes((thinking) => ({
      type: "assistant",
      message: {
        model: "claude-test",
        id: "message-test",
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking, signature: "signature-test" }],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {},
        diagnostics: null,
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: "session-test",
      uuid: "uuid-test",
      timestamp: "2026-09-02T00:00:00.000Z",
      request_id: "request-test",
    }), 78_752)
  );
  assert.deepEqual(legacyElevenKeyAssistant.overflows, [{
    maxBytes: 64 * 1024,
    byteLength: 78_752,
    classificationReason: "strict_thinking_shape_rejected",
  }]);
  assert.deepEqual(legacyElevenKeyAssistant.discards, []);

  // F-dhdg-r4-04: thinking cross-boundary — 131,073B and exactly 1,048,576B both discard
  const thinkingAtOldBoundary = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes(131_073, "thinking_delta")
  );
  assert.deepEqual(thinkingAtOldBoundary.overflows, []);
  assert.deepEqual(thinkingAtOldBoundary.discards, [{
    event_class: "stream_event_thinking_delta",
    byte_length: 131_073,
    hard_cap_bytes: 1024 * 1024,
  }]);

  const thinkingAtNewCap = collectClaudeStdoutLineOutcome(
    signatureDeltaLineAtBytes(1024 * 1024, "thinking_delta")
  );
  assert.deepEqual(thinkingAtNewCap.overflows, []);
  assert.deepEqual(thinkingAtNewCap.discards, [{
    event_class: "stream_event_thinking_delta",
    byte_length: 1024 * 1024,
    hard_cap_bytes: 1024 * 1024,
  }]);

  const allSafeTelemetry = [...thinkingDelta.discards];
  assert.equal(JSON.stringify(allSafeTelemetry).includes("x".repeat(64)), false);
  assert.deepEqual(Object.keys(allSafeTelemetry[0]), [
    "event_class", "byte_length", "hard_cap_bytes",
  ]);

  const initialByteOffset = 4_096;
  const precedingLine = JSON.stringify({ type: "system", subtype: "status" });
  const observedLine = observedSignatureDeltaLine();
  const routedLines = [];
  const routedDiscards = [];
  const routedRanges = [];
  const multiLineRouter = __testReviewerOutput.createReviewerOutputLineRouter({
    reviewerFamily: "claude",
    stream: "stdout",
    initialByteOffset,
    onLine: (value) => routedLines.push(value),
    onOverflow: () => assert.fail("lawful multi-line fixture must not overflow"),
    onDiscard: (metadata, range) => {
      routedDiscards.push(metadata);
      routedRanges.push(range);
    },
  });
  const combined = Buffer.from(`${precedingLine}\n${observedLine}\n`, "utf8");
  for (const boundary of [7, 60_003, combined.length]) {
    const previous = boundary === 7 ? 0 : boundary === 60_003 ? 7 : 60_003;
    multiLineRouter.write(combined.subarray(previous, boundary));
  }
  multiLineRouter.end();
  const observedStart = initialByteOffset + Buffer.byteLength(precedingLine, "utf8") + 1;
  assert.deepEqual(routedLines, [precedingLine]);
  assert.equal(routedDiscards.length, 1);
  assert.deepEqual(routedRanges, [{
    start_byte: observedStart,
    end_byte: observedStart + 93_638,
  }]);

  assert.deepEqual(
    __testReviewerClassification.retainTailRelevantByteRanges([
      { start_byte: 0, end_byte: 100 },
      { start_byte: 100, end_byte: 200 },
      { start_byte: 250, end_byte: 300 },
      { start_byte: -1, end_byte: 999 },
    ], 150),
    [
      { start_byte: 100, end_byte: 200 },
      { start_byte: 250, end_byte: 300 },
    ]
  );

  const safeCliExit = __testReviewerClassification.safeCliExit({
    code: 0,
    signal: null,
    timed_out: false,
    spawn_error: null,
    stdout_bytes: 100,
    stderr_bytes: 0,
    tool_surface_check: { status: "verified" },
    output_safety_check: { status: "verified", classification: "ok" },
    process_spawned: true,
    process_close_observed: true,
    transport_cleanup_confirmed: true,
    discarded_stdout_thinking_ranges: [{ start_byte: 1, end_byte: 2 }],
  });
  assert.equal(Object.hasOwn(safeCliExit, "discarded_stdout_thinking_ranges"), false);
});

test("T29b discarded thinking sidecar partial tail has zero orchestration authority", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devpro-thinking-tail-"));
  try {
    const stdoutPath = path.join(dir, "reviewer-stdout.ndjson");
    const stderrPath = path.join(dir, "reviewer-stderr.log");
    const thinkingLine = jsonLineAtExactBytesWithSuffix((thinking) => ({
      type: "assistant",
      message: {
        model: "claude-test",
        id: "message-test",
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking, signature: "signature-test" }],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {},
        diagnostics: null,
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: "session-test",
      uuid: "uuid-test",
      timestamp: "2026-09-02T00:00:00.000Z",
      request_id: "request-test",
    }), 94_146, " permission denied requires approval ");
    const terminal = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "{}",
    });
    writeFileSync(stdoutPath, `${thinkingLine}\n${terminal}\n`);
    writeFileSync(stderrPath, "");

    const untrustedPartial = __testReviewerClassification.extractBoundedTerminalEvidence({
      stdout_log_path: stdoutPath,
      stderr_log_path: stderrPath,
    });
    assert.match(untrustedPartial.unmatchedCandidateText, /permission denied/);

    const evidence = __testReviewerClassification.extractBoundedTerminalEvidence({
      stdout_log_path: stdoutPath,
      stderr_log_path: stderrPath,
    }, {
      discardedStdoutRanges: [{ start_byte: 0, end_byte: 94_146 }],
    });

    assert.equal(evidence.terminal?.type, "result");
    assert.equal(evidence.unmatchedCandidateText, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T15/T17: Codex pr-sticky toolContract has probe guards and consume-injected-env write_target_source", () => {
  const codexPrefix = secondReviewPacketStaticPrefix("Codex", "pr-sticky", "dispatch-2010");
  assert.match(codexPrefix, /availability_probe:/);
  assert.match(codexPrefix, /no-compound:/);
  assert.match(codexPrefix, /no-shell-env-probe:/);
  assert.match(codexPrefix, /printenv/);
  assert.match(
    codexPrefix,
    /write_target_source: consume the wrapper-injected GH_REPO and DEVPRO_REVIEW_PR_NUMBER environment values directly/,
  );
  assert.match(codexPrefix, /MUST NOT re-verify them via shell printenv, env, set/);
  assert.doesNotMatch(
    codexPrefix,
    /write_target_source: use only the wrapper-injected exact GH_REPO and DEVPRO_REVIEW_PR_NUMBER environment values; MUST NOT infer the repository or PR number from cwd, git remote, or framed Review Data\nreason_scope/,
  );

  const claudePrefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky", "dispatch-2010");
  assert.match(claudePrefix, /availability_probe: if needed, run only exact `command -v gh`/);
});

test("T16/T18: same-family fallback injects provenance; non-fallback reason_scope unchanged", () => {
  const fallbackRetry = {
    classification: "same_family_fallback:codex-cli-unavailable",
    sticky_verification: "preferred different-family CLI unavailable",
  };
  assert.equal(classificationIndicatesSameFamilyFallback(fallbackRetry.classification), true);
  const disclosure = sameFamilyFallbackDisclosure(fallbackRetry);
  assert.match(disclosure, new RegExp(`^${SAME_FAMILY_FALLBACK_REASON_PREFIX} `));
  assert.ok(stickyReasonRequiresSameFamilyFallback(`${disclosure}; findings ok`));

  const fallbackPrefix = secondReviewPacketStaticPrefix(
    "Claude Code",
    "pr-sticky",
    "dispatch-2010b",
    null,
    undefined,
    { retryContext: fallbackRetry },
  );
  assert.match(fallbackPrefix, new RegExp(`reason: ${SAME_FAMILY_FALLBACK_REASON_PREFIX} `));
  assert.match(fallbackPrefix, /same_family_fallback_provenance:/);
  assert.match(fallbackPrefix, /reason_scope: review verdict, bounded findings and required guarantee assessment/);

  const nonFallbackPrefix = secondReviewPacketStaticPrefix(
    "Claude Code",
    "pr-sticky",
    "dispatch-non-fallback",
    null,
    undefined,
    { retryContext: { classification: "none", sticky_verification: "not-needed" } },
  );
  assert.doesNotMatch(nonFallbackPrefix, /same-family fallback:/);
  assert.doesNotMatch(nonFallbackPrefix, /same_family_fallback_provenance:/);
  assert.match(nonFallbackPrefix, /reason_scope: review verdict, bounded findings and required guarantee assessment/);
  assert.match(nonFallbackPrefix, /^reason: <actual-bounded-reason>$/m);
});

test("T16b: primary_family=unknown injects cross-model-unverified; same-family wins precedence", () => {
  assert.equal(primaryFamilyIsUnknown("unknown"), true);
  assert.equal(primaryFamilyIsUnknown("claude"), false);
  assert.equal(crossModelUnverifiedDisclosure("unknown"), CROSS_MODEL_UNVERIFIED_REASON_TOKEN);
  assert.equal(crossModelUnverifiedDisclosure("claude"), null);
  assert.ok(stickyReasonRequiresCrossModelUnverified(
    `${CROSS_MODEL_UNVERIFIED_REASON_TOKEN}; findings ok`,
  ));
  assert.equal(
    stickyReasonRequiresCrossModelUnverified("technical summary only"),
    false,
  );

  const unknownPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    "dispatch-unknown-primary",
    null,
    undefined,
    { primaryFamily: "unknown" },
  );
  assert.match(
    unknownPrefix,
    new RegExp(`^reason: ${CROSS_MODEL_UNVERIFIED_REASON_TOKEN}; <actual-bounded-reason>$`, "m"),
  );
  assert.match(unknownPrefix, /cross_model_unverified_provenance:/);
  assert.match(
    unknownPrefix,
    new RegExp(`reason_value_rule: sticky reason MUST keep renderer-injected \`${CROSS_MODEL_UNVERIFIED_REASON_TOKEN}\``),
  );
  assert.match(unknownPrefix, /reason_scope: review verdict, bounded findings and required guarantee assessment/);
  assert.doesNotMatch(unknownPrefix, /same_family_fallback_provenance:/);

  const knownPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    "dispatch-known-primary",
    null,
    undefined,
    { primaryFamily: "claude" },
  );
  assert.doesNotMatch(knownPrefix, /cross-model-unverified/);
  assert.doesNotMatch(knownPrefix, /cross_model_unverified_provenance:/);
  assert.match(knownPrefix, /^reason: <actual-bounded-reason>$/m);

  const auditUnknownPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "audit-only",
    "dispatch-audit-unknown",
    null,
    undefined,
    { primaryFamily: "unknown" },
  );
  assert.doesNotMatch(auditUnknownPrefix, /cross-model-unverified/);

  const bothApplyPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    "dispatch-both",
    null,
    undefined,
    {
      primaryFamily: "unknown",
      retryContext: {
        classification: "same_family_fallback:unavailable",
        sticky_verification: "cli missing",
      },
    },
  );
  assert.match(bothApplyPrefix, new RegExp(`reason: ${SAME_FAMILY_FALLBACK_REASON_PREFIX} `));
  assert.match(bothApplyPrefix, /same_family_fallback_provenance:/);
  assert.doesNotMatch(bothApplyPrefix, /cross_model_unverified_provenance:/);
});

test("T19 live wire: runProjection source calls page-window sticky helpers", () => {
  const source = readFileSync(
    repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8",
  );
  const runProjectionBody = source.slice(source.indexOf("export async function runProjection"));
  assert.match(runProjectionBody, /resolveLivePageWindowStickyGate\(/);
  assert.match(runProjectionBody, /advancePageWindowPacketAndContext\(/);
  const liveGateFn = source.slice(source.indexOf("export function resolveLivePageWindowStickyGate"));
  assert.match(liveGateFn, /advancePageWindowLedgers\(/);
  assert.match(liveGateFn, /shouldBlockUnavailableStickyOverwrite\(/);
  assert.match(liveGateFn, /authorizeGateSatisfyingSticky|sticky_authorized/);
});

test("T19 live wire: intermediate does not authorize sticky; UNAVAILABLE overwrite blocked on final", () => {
  const pageCount = 2;
  const pageOne = "page-one";
  const pageTwo = "page-two";
  const intermediateMaterial = {
    manifest: {
      page_count: pageCount,
      pages: [
        { index: 1, sha256: materialSha256(pageOne) },
        { index: 2, sha256: materialSha256(pageTwo) },
      ],
    },
    pages: [{ index: 1, content: pageOne }],
    checkpoint_ledger: emptyCheckpointLedger(),
    findings_ledger: emptyFindingsLedger(),
    window_role: "intermediate",
  };
  const intermediateGate = resolveLivePageWindowStickyGate({
    context: { page_window_checkpoint_handoff: true },
    reviewMaterial: intermediateMaterial,
    completion: {
      status: "accepted",
      completion: {
        window_index: 1,
        page_indices: [1],
        verdict: "PASS",
        findings: [],
      },
    },
  });
  assert.equal(intermediateGate.phase, "intermediate");
  assert.equal(intermediateGate.stickyAuthorized, false);
  assert.equal(intermediateGate.continueToNextWindow, true);

  const afterIntermediate = intermediateGate.advanced;
  const finalMaterial = {
    ...intermediateMaterial,
    pages: [{ index: 2, content: pageTwo }],
    checkpoint_ledger: afterIntermediate.checkpoint_ledger,
    findings_ledger: afterIntermediate.findings_ledger,
    window_role: "final",
  };
  const overwriteGate = resolveLivePageWindowStickyGate({
    context: { page_window_checkpoint_handoff: true },
    reviewMaterial: finalMaterial,
    completion: {
      status: "blocking-verdict",
      completion: {
        window_index: 2,
        page_indices: [2],
        verdict: "UNAVAILABLE",
        findings: [],
      },
    },
    priorGateSatisfyingSticky: { verdict: "PASS" },
  });
  assert.equal(overwriteGate.phase, "final");
  assert.equal(overwriteGate.blockUnavailableOverwrite, true);
  assert.equal(overwriteGate.stickyAuthorized, false);
  assert.equal(overwriteGate.classification, "sticky_unavailable_overwrite_blocked");
});

test("D7 Critical: intermediate UNAVAILABLE must not continue to sticky-capable final spawn", () => {
  const pageCount = 2;
  const pageOne = "page-one";
  const pageTwo = "page-two";
  const intermediateMaterial = {
    manifest: {
      page_count: pageCount,
      pages: [
        { index: 1, sha256: materialSha256(pageOne) },
        { index: 2, sha256: materialSha256(pageTwo) },
      ],
    },
    pages: [{ index: 1, content: pageOne }],
    checkpoint_ledger: emptyCheckpointLedger(),
    findings_ledger: emptyFindingsLedger(),
    window_role: "intermediate",
  };
  const unavailableGate = resolveLivePageWindowStickyGate({
    context: {
      page_window_checkpoint_handoff: true,
      mode: "pr-sticky",
      sticky_write_disposition: {
        schema: "devpro-second-review-sticky-write-disposition/v1",
        action: "create",
        repository_slug: "devpro/example",
        pr_number: 2009,
        dispatch_id: "dispatch-d7",
      },
    },
    reviewMaterial: intermediateMaterial,
    completion: {
      status: "blocking-verdict",
      completion: {
        window_index: 1,
        page_indices: [1],
        verdict: "UNAVAILABLE",
        findings: [],
      },
    },
  });
  assert.equal(unavailableGate.phase, "intermediate");
  assert.equal(unavailableGate.stickyAuthorized, false);
  assert.equal(unavailableGate.continueToNextWindow, false);
  assert.equal(unavailableGate.classification, "page_window_intermediate_blocks_aggregation");

  const criticalGate = resolveLivePageWindowStickyGate({
    context: {
      page_window_checkpoint_handoff: true,
      sticky_write_disposition_authorized: {
        schema: "devpro-second-review-sticky-write-disposition/v1",
        action: "update",
        repository_slug: "devpro/example",
        pr_number: 2009,
        dispatch_id: "dispatch-d7",
      },
    },
    reviewMaterial: intermediateMaterial,
    completion: {
      status: "blocking-verdict",
      completion: {
        window_index: 1,
        page_indices: [1],
        verdict: "CRITICAL",
        findings: [{ severity: "CRITICAL", summary_id: "c1", summary: "blocking" }],
      },
    },
    priorGateSatisfyingSticky: { verdict: "PASS" },
  });
  assert.equal(criticalGate.continueToNextWindow, false);
  assert.equal(criticalGate.stickyAuthorized, true);
  assert.equal(criticalGate.phase, "intermediate_critical_sticky");
  assert.equal(
    criticalGate.classification,
    "page_window_intermediate_critical_sticky_authorized",
  );
});

test("D7b: intermediate CRITICAL write checkpoint restores authorized sticky recipe", () => {
  const tmpDir = path.join(REPO_ROOT, "notes", "tmp", `crit-sticky-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const packetPath = path.join(tmpDir, "packet.md");
  writeFileSync(packetPath, "placeholder");
  const authorized = {
    schema: "devpro-second-review-sticky-write-disposition/v1",
    action: "create",
    repository_slug: "devpro/example",
    pr_number: 2013,
    dispatch_id: "dispatch-crit",
    candidate_count: 0,
    snapshot_digest: "a".repeat(64),
    marker: "<!-- cross-model-second-opinion:sticky -->",
  };
  const reviewData = {
    schema_version: SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION,
    retry_context: { classification: "none", sticky_verification: "not-needed" },
    review_material: {
      manifest: {
        page_count: 2,
        pages: [
          { index: 1, sha256: materialSha256("p1") },
          { index: 2, sha256: materialSha256("p2") },
        ],
      },
      pages: [{ index: 1, content: "p1" }],
      checkpoint_ledger: emptyCheckpointLedger(),
      findings_ledger: emptyFindingsLedger(),
      window_role: "intermediate",
    },
  };
  const context = {
    mode: "pr-sticky",
    repository_slug: "devpro/example",
    pr_number: 2013,
    dispatch_id: "dispatch-crit",
    reviewer_family: "openai-codex",
    packet_path: packetPath,
    page_window_checkpoint_handoff: true,
    sticky_write_disposition: pageWindowIntermediateStickyDisposition(authorized),
    sticky_write_disposition_authorized: authorized,
    activity_log_path: path.join(tmpDir, "activity.ndjson"),
  };
  writeFileSync(context.activity_log_path, "");
  const advanced = {
    checkpoint_ledger: emptyCheckpointLedger(),
    findings_ledger: appendFindingsWindow(emptyFindingsLedger(), {
      window_index: 1,
      page_indices: [1],
      window_verdict: "CRITICAL",
      findings: [{ severity: "CRITICAL", summary_id: "c1", summary: "blocking" }],
    }),
  };
  const next = prepareIntermediateCriticalStickyCheckpoint(context, reviewData, advanced);
  assert.equal(context.page_window_critical_sticky_checkpoint, true);
  assert.equal(context.sticky_write_disposition.action, "create");
  assert.match(
    readFileSync(packetPath, "utf8"),
    /intermediate CRITICAL write checkpoint/,
  );
  assert.match(readFileSync(packetPath, "utf8"), /sticky_write_action: create/);
  assert.equal(next.review_material.findings_ledger.windows.length, 1);

  const terminalGate = resolveLivePageWindowStickyGate({
    context,
    reviewMaterial: next.review_material,
    completion: { status: "blocking-verdict", completion: { verdict: "CRITICAL" } },
  });
  assert.equal(terminalGate.phase, "critical_sticky_checkpoint");
  assert.equal(terminalGate.stickyAuthorized, true);
});

test("D7 Critical: runProjection live path binds blocked disposition on intermediate UNAVAIL stop", () => {
  const source = readFileSync(
    repoPath(".devpro/scripts/run-second-reviewer-projection.mjs"),
    "utf8",
  );
  const runProjectionBody = source.slice(source.indexOf("export async function runProjection"));
  assert.match(runProjectionBody, /page_window_intermediate_blocks_aggregation|continueToNextWindow !== true/);
  assert.match(runProjectionBody, /bindBlockedStickyWriteDisposition\(/);
  assert.match(runProjectionBody, /prepareIntermediateCriticalStickyCheckpoint\(/);
  assert.match(runProjectionBody, /page_window_intermediate_critical_sticky_pending_write/);
  assert.match(source, /page_window_intermediate_critical_sticky_authorized/);

  const context = {
    mode: "pr-sticky",
    repository_slug: "devpro/example",
    pr_number: 2009,
    dispatch_id: "dispatch-block",
    sticky_write_disposition: {
      schema: "devpro-second-review-sticky-write-disposition/v1",
      action: "create",
      repository_slug: "devpro/example",
      pr_number: 2009,
      dispatch_id: "dispatch-block",
    },
    sticky_write_exact_recipe: "gh api 'repos/devpro/example/issues/2009/comments' --method POST",
    activity_log: [],
  };
  // appendActivity expects activity path; bindBlocked uses appendActivity — use minimal stub via export
  const blocked = bindBlockedStickyWriteDisposition(context, {
    classification: "page_window_intermediate_blocks_aggregation",
    reason: "intermediate UNAVAILABLE blocks final sticky-capable spawn",
  });
  assert.equal(blocked.action, "blocked");
  assert.equal(context.sticky_write_disposition.action, "blocked");
  assert.equal(context.sticky_write_exact_recipe, null);
  assert.notEqual(context.sticky_write_disposition.action, "create");
});

test("Important: overwrite block rebinds write disposition to blocked", () => {
  const context = {
    mode: "pr-sticky",
    repository_slug: "devpro/example",
    pr_number: 2009,
    dispatch_id: "dispatch-overwrite",
    sticky_write_disposition: {
      schema: "devpro-second-review-sticky-write-disposition/v1",
      action: "update",
      repository_slug: "devpro/example",
      pr_number: 2009,
      dispatch_id: "dispatch-overwrite",
      prior_verdict: "PASS",
      target: {
        id: 4242,
        url: "https://github.com/devpro/example/pull/2009#issuecomment-4242",
        node_id: "IC_kw",
        body_sha256: "a".repeat(64),
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
    sticky_write_exact_recipe: "gh api 'repos/devpro/example/issues/comments/4242' --method PATCH",
    activity_log: [],
  };
  bindBlockedStickyWriteDisposition(context, {
    classification: "sticky_unavailable_overwrite_blocked",
    reason: "material-unavailable must not overwrite prior PASS/WARN sticky",
  });
  assert.equal(context.sticky_write_disposition.action, "blocked");
  assert.equal(context.sticky_write_disposition.prior_verdict, "PASS");
  assert.equal(context.sticky_write_exact_recipe, null);
});

const PAGE_WINDOW_FINDING_HEAD = "a".repeat(40);
const PAGE_WINDOW_FINDING_DISPATCH = "dispatch-finding-severity";

function pageWindowCompletionWithFindingSeverity(severity, {
  verdict = "WARN",
  summaryId = "six-axis-important",
  summary = "Six-axis Important finding from page-window completion.",
} = {}) {
  const findings = [{
    severity,
    summary_id: summaryId,
    summary,
  }];
  return {
    sticky_comment_url: "none",
    verdict,
    last_reviewed_sha: PAGE_WINDOW_FINDING_HEAD,
    reviewer_model: "test-model",
    reason: "page-window finding severity fixture",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: PAGE_WINDOW_FINDING_HEAD,
    dispatch_id: PAGE_WINDOW_FINDING_DISPATCH,
    findings,
    findings_payload_sha256: findingsPayloadSha256({
      window_index: 1,
      page_indices: [1],
      head_ref_oid: PAGE_WINDOW_FINDING_HEAD,
      dispatch_id: PAGE_WINDOW_FINDING_DISPATCH,
      findings,
    }),
  };
}

function pageWindowParseOptions() {
  return {
    headRefOid: PAGE_WINDOW_FINDING_HEAD,
    dispatchId: PAGE_WINDOW_FINDING_DISPATCH,
    expectedWindowIndex: 1,
    expectedPageIndices: [1],
  };
}

function classifyCodexPageWindowCompletion(completion) {
  const agentMessage = {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify(completion),
    },
  };
  return __testReviewerClassification.classifyCliExit(
    {
      mode: "pr-sticky",
      page_window_checkpoint_handoff: true,
      head_ref_oid: completion.head_ref_oid,
      dispatch_id: completion.dispatch_id,
      page_window_index: completion.window_index,
      review_material: {
        window_role: "final",
        pages: completion.page_indices.map((index) => ({
          index,
          content: `page-${index}`,
        })),
      },
      reviewer_cli_recipe: { tool: "codex" },
    },
    {
      code: 0,
      signal: null,
      timed_out: false,
      spawn_error: null,
    },
    {
      structuredEvents: [agentMessage],
      stdoutStructuredEvents: [agentMessage],
      terminal: null,
      unstructuredText: "",
      stderrText: "",
      unmatchedCandidateText: "",
    },
  );
}

test("IMPORTANT finding severity canonicalizes to WARN (prove-it)", () => {
  const inbound = pageWindowCompletionWithFindingSeverity("IMPORTANT");
  const parsed = parsePageWindowCompletionObject(inbound, pageWindowParseOptions());
  assert.notEqual(parsed.status, "malformed");
  assert.equal(parsed.status, "accepted");
  assert.equal(parsed.completion.findings[0].severity, "WARN");
  assert.equal(inbound.findings[0].severity, "IMPORTANT");

  const warnFindings = [{
    severity: "WARN",
    summary_id: inbound.findings[0].summary_id,
    summary: inbound.findings[0].summary,
  }];
  const warnDigest = findingsPayloadSha256({
    window_index: inbound.window_index,
    page_indices: inbound.page_indices,
    head_ref_oid: inbound.head_ref_oid,
    dispatch_id: inbound.dispatch_id,
    findings: warnFindings,
  });
  const importantDigest = findingsPayloadSha256({
    window_index: inbound.window_index,
    page_indices: inbound.page_indices,
    head_ref_oid: inbound.head_ref_oid,
    dispatch_id: inbound.dispatch_id,
    findings: inbound.findings,
  });
  assert.equal(parsed.completion.findings_payload_sha256, warnDigest);
  assert.notEqual(parsed.completion.findings_payload_sha256, importantDigest);
  assert.equal(
    classifyCodexPageWindowCompletion(inbound),
    "reviewer_cli_completed",
  );
});

test("literal page-window finding severities remain themselves", () => {
  for (const severity of FINDING_SEVERITIES) {
    const inbound = pageWindowCompletionWithFindingSeverity(severity, {
      verdict: severity === "CRITICAL" ? "CRITICAL" : "WARN",
      summaryId: `literal-${severity.toLowerCase()}`,
      summary: `Literal ${severity} finding.`,
    });
    const parsed = parsePageWindowCompletionObject(inbound, pageWindowParseOptions());
    if (severity === "CRITICAL") {
      assert.equal(parsed.status, "blocking-verdict");
    } else {
      assert.equal(parsed.status, "accepted");
    }
    assert.equal(parsed.completion.findings[0].severity, severity);
  }
});

test("FINDING_SEVERITIES stays four wire values without IMPORTANT", () => {
  assert.deepEqual([...FINDING_SEVERITIES], ["PASS", "WARN", "CRITICAL", "INFO"]);
  assert.equal(FINDING_SEVERITIES.includes("IMPORTANT"), false);
});

test("stored IMPORTANT findings ledger severity remains invalid", () => {
  const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource());
  const { __paged_full_pages: _full, ...framed } = normalized;
  const findings = [{
    severity: "IMPORTANT",
    summary_id: "stored-important",
    summary: "Persisted IMPORTANT must not become valid via ledger validate.",
  }];
  framed.review_material.findings_ledger = appendFindingsWindow(emptyFindingsLedger(), {
    window_index: 1,
    page_indices: framed.review_material.pages.map((page) => page.index),
    window_verdict: "WARN",
    findings,
  });
  assert.equal(framed.review_material.findings_ledger.windows[0].findings[0].severity, "IMPORTANT");
  const errors = validatePrStickyReviewMaterialContract(framed);
  assert.ok(
    errors.some((error) => error.includes("severity is invalid")),
    `expected stored IMPORTANT severity invalid, got: ${errors.join("; ")}`,
  );
  void _full;
});

const PAGE_WINDOW_IMPORTANT_DUTY =
  "Page-window handoff: findings[].severity MUST use only PASS, WARN, CRITICAL, or INFO. Map six-axis Critical to CRITICAL, Important to WARN, and Suggestion to INFO; never emit Critical, Important, Suggestion, or SUGGESTION as wire severity.";

test("page-window packet duties map six-axis severity and require a string for no sticky", () => {
  const pageWindowPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    "dispatch-finding-severity",
    null,
    SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION,
    { pageWindowCheckpointHandoff: true },
  );
  assert.match(pageWindowPrefix, /Important to WARN/);
  assert.match(pageWindowPrefix, /WARN/);
  assert.equal(pageWindowPrefix.includes(PAGE_WINDOW_IMPORTANT_DUTY), true);
  for (const family of ["Claude", "Codex", "OpenCode"]) {
    const prefix = secondReviewPacketStaticPrefix(family, "pr-sticky", "dispatch-finding-severity", null,
      SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION, { pageWindowCheckpointHandoff: true });
    assert.equal(prefix.includes(PAGE_WINDOW_IMPORTANT_DUTY), true, family);
    assert.match(prefix, /intermediate window with no sticky, sticky_comment_url MUST be the JSON string "none", never null/, family);
  }

  const nonPageWindowPrefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    "dispatch-finding-severity",
  );
  assert.equal(nonPageWindowPrefix.includes(PAGE_WINDOW_IMPORTANT_DUTY), false);
  // fix-second-review-loop-friction D11: the universal R3 duty bullet names
  // "six-axis Important counts as WARN", so the bare substring no longer
  // fingerprints the page-window duty; lock the page-window-only duty family.
  assert.equal(nonPageWindowPrefix.includes("Page-window handoff:"), false);
  assert.equal(nonPageWindowPrefix.includes("six-axis Important MUST be emitted as structured completion"), false);
});

for (const severity of ["SUGGESTION", "Suggestion"]) test(`${severity} finding severity remains malformed`, () => {
  const inbound = pageWindowCompletionWithFindingSeverity(severity);
  const parsed = parsePageWindowCompletionObject(inbound, pageWindowParseOptions());
  assert.equal(parsed.status, "malformed");
  assert.equal(
    classifyCodexPageWindowCompletion(inbound),
    "reviewer_completion_contract_invalid",
  );
});

test("intermediate null sticky URL remains malformed while string none is accepted", () => {
  const inbound = pageWindowCompletionWithFindingSeverity("INFO");
  inbound.sticky_comment_url = null;
  assert.equal(parsePageWindowCompletionObject(inbound, pageWindowParseOptions()).status, "malformed");
  inbound.sticky_comment_url = "none";
  assert.equal(parsePageWindowCompletionObject(inbound, pageWindowParseOptions()).status, "accepted");
});


test("strict thinking rejection reports generic limit and exact UTF-8 bytes through safe telemetry", () => {
  const row = JSON.parse(observedAssistantThinkingLine());
  row.message.content[0].thinking = "字".repeat(24_000);
  row.thinking_duration_ms = 1;
  row.future_unknown_key = null;
  const line = JSON.stringify(row);
  for (const terminated of [false, true]) {
    const overflows = [];
    const router = __testReviewerOutput.createReviewerOutputLineRouter({
      reviewerFamily: "claude", stream: "stdout",
      onLine: () => assert.fail("unsafe candidate must never reach live parsing"),
      onDiscard: () => assert.fail("unsafe candidate must never be discarded"),
      onOverflow: (metadata) => overflows.push(metadata),
    });
    const bytes = Buffer.from(line + (terminated ? "\n" : ""));
    for (let offset = 0; offset < bytes.length; offset += 997) router.write(bytes.subarray(offset, offset + 997));
    router.end();
    assert.deepEqual(overflows, [{ maxBytes: 64 * 1024, byteLength: Buffer.byteLength(line), classificationReason: "strict_thinking_shape_rejected" }]);
  }
  const safe = __testReviewerClassification.safeCliExit({
    output_safety_check: { status: "failed", classification: "reviewer_cli_failed", reason: "reviewer_output_line_too_large", stream: "stdout", max_line_bytes: 64 * 1024, line_bytes: Buffer.byteLength(line), classification_reason: "strict_thinking_shape_rejected" },
  });
  assert.equal(safe.output_safety_check.max_line_bytes, 64 * 1024);
  assert.equal(safe.output_safety_check.line_bytes, Buffer.byteLength(line));
  assert.equal(safe.output_safety_check.classification_reason, "strict_thinking_shape_rejected");
  assert.equal(JSON.stringify(safe).includes("字"), false);
});
