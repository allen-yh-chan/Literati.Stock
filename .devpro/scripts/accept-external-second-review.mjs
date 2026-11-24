#!/usr/bin/env node
import { guaranteeAssessmentRequired, readReviewGuaranteeAssessment } from "./review-guarantee-assessment.mjs";
/**
 * accept-external-second-review.mjs
 *
 * TL acceptance helper for an external-evaluator second-review ticket
 * (design.md D4). Given the packet-dir the renderer delivered to the
 * external evaluator, this CLI:
 *
 *  1. Reads `<packet-dir>/observability-context.json` and cross-verifies its
 *     identity against the raw dispatch reservation (D4 step 1).
 *  2. Applies the raw closure precheck (D4 step 2): a voided slot fails
 *     closed; an accepted slot with a completion receipt is idempotent
 *     (`already_accepted`); an accepted slot without a completion receipt is
 *     completed directly from the slot's own `receipt_payload` with NO live
 *     re-read (design audit r1 finding 1 — a crash between slot-publish and
 *     receipt-write must not depend on the sticky still being readable).
 *  3. Otherwise performs the live re-read (D4 steps 3-4): PR head, the full
 *     paginated issue-comment snapshot, exact-one sticky-authority
 *     resolution, sticky contract parsing, footer Tool/Model cross-check
 *     against the dispatched reviewer_tool/reviewer_family, and
 *     create/update disposition binding.
 *  4. Publishes the closure slot then the fourth completion form via the
 *     control-evidence helper (T2 API): `writeExternalClosureSlot` +
 *     `writeExternalCompletionReceipt`.
 *
 * Usage: node .devpro/scripts/accept-external-second-review.mjs <packet-dir>
 * Exit 0: accepted or idempotent already-accepted (one JSON line on stdout).
 * Exit 1: typed rejection (one JSON line with a `classification` on stdout).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync, fstatSync, lstatSync, readSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDispatchEvidence,
  mirrorExternalAuditCompletionReceipt,
  writeExternalClosureSlot,
  writeExternalCompletionReceipt,
  COMPLETION_SCHEMA,
} from "./hooks/lib/second-review-control-evidence.mjs";
import {
  MODEL_FAMILY_PATTERNS,
  normalizeSecondReviewStickyCandidate,
  parseSecondReviewStickyAuthorityBody,
  selectExactSecondReviewStickyAuthority,
} from "./hooks/lib/second-review-sticky-authority.mjs";
import { isPlainObject, sha256Hex } from "./lib/primitives.mjs";
import {
  assertStickyBodyCredentialFree,
  credentialGateTelemetry,
  STICKY_CREDENTIAL_LITERAL_DETECTED,
} from "./lib/second-review-sticky-credential-gate.mjs";
import {
  STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
  STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME,
} from "./write-second-review-sticky-gated.mjs";

import { parseCanonicalSecondReviewPacketData, sameFamilyFallbackDisclosure, stickyReasonRequiresSameFamilyFallback } from "./validate-second-review-packet.mjs";
import { EXTERNAL_AUDIT_REPORT_BASENAME, EXTERNAL_AUDIT_REPORT_MAX_BYTES,
  externalAuditReviewDataSha256, parseExternalAuditReview } from "./lib/external-audit-review.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

class TypedError extends Error {
  constructor(classification, message) {
    super(message);
    this.classification = classification;
  }
}

function fail(classification, message) {
  throw new TypedError(classification, message);
}

function readObservabilityContext(packetDir) {
  const resolvedPacketDir = path.resolve(String(packetDir ?? ""));
  const contextPath = path.join(resolvedPacketDir, "observability-context.json");
  if (!existsSync(contextPath)) {
    fail("external_ticket_context_unreadable", `observability-context.json is missing at ${contextPath}`);
  }
  let context;
  try {
    context = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch (error) {
    fail("external_ticket_context_unreadable", `observability-context.json is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(context)) {
    fail("external_ticket_context_unreadable", "observability-context.json must be a JSON object");
  }
  return { context, contextPath, resolvedPacketDir };
}

/**
 * D4 step 1: cross-verify the external ticket's own identity (the sidecar
 * `observability-context.json` the renderer wrote beside the packet) against
 * the raw dispatch reservation. Any mismatch, or a record that is not an
 * external-evaluator dispatch at all, is `reviewer_dispatch_identity_collision`
 * — the same fail-closed bucket the runner path uses for identity drift.
 *
 * Field mapping:
 *   context.dispatch_id / attempt_id / repository_slug / pr_number /
 *     head_ref_oid  <->  record's same-named identity fields
 *   sha256(resolvedPacketDir)  <->  record.carrier_root_id
 *   context.sticky_write_disposition.action  <->  record.sticky_write_action
 *   context.sticky_write_disposition.target?.id ?? null  <->  record.sticky_target_comment_id
 *   context.sticky_write_disposition.snapshot_digest  <->  record.sticky_snapshot_digest
 */
function assertTicketIdentityMatchesRecord(context, record, resolvedPacketDir) {
  if (record.executor_kind !== "external-evaluator") {
    fail("reviewer_dispatch_identity_collision", "dispatch record is not an external-evaluator dispatch");
  }
  if (context.dispatch_id !== record.dispatch_id
    || context.attempt_id !== record.attempt_id
    || context.repository_slug !== record.repository_slug
    || String(context.pr_number) !== String(record.pr_number)
    || context.head_ref_oid !== record.head_ref_oid) {
    fail("reviewer_dispatch_identity_collision", "external ticket identity does not match its dispatch reservation");
  }
  // F-12: recomputed from the resolved packet-dir CLI argument itself, never
  // trusted from the context file's own observability_context_path —
  // otherwise a copied/relocated packet-dir (whose context file still names
  // its original location) could accept a dispatch it was never issued for.
  // Mirrors render-second-review-packet.mjs's voidExternalDispatch (T5/D5)
  // exactly, which never reads observability_context_path for this purpose.
  const carrierRootId = sha256Hex(resolvedPacketDir);
  if (carrierRootId !== record.carrier_root_id) {
    fail("reviewer_dispatch_identity_collision", "external ticket carrier_root_id does not match its dispatch reservation");
  }
  if (record.mode === "audit-only") {
    if (context.mode !== "audit-only" || context.review_data_sha256 !== record.review_data_sha256
      || context.packet_path !== path.join(resolvedPacketDir, "packet.md")
      || context.external_audit_report_path !== path.join(resolvedPacketDir, EXTERNAL_AUDIT_REPORT_BASENAME)) {
      fail("reviewer_dispatch_identity_collision", "audit ticket material or report carrier does not match its dispatch");
    }
    return;
  }
  const disposition = context.sticky_write_disposition;
  const dispositionAction = isPlainObject(disposition) ? disposition.action : null;
  const dispositionTargetId = isPlainObject(disposition) && dispositionAction === "update"
    ? disposition.target?.id ?? null
    : null;
  const dispositionSnapshotDigest = isPlainObject(disposition) ? disposition.snapshot_digest ?? null : null;
  if (dispositionAction !== record.sticky_write_action
    || dispositionTargetId !== record.sticky_target_comment_id
    || dispositionSnapshotDigest !== record.sticky_snapshot_digest) {
    fail("reviewer_dispatch_identity_collision", "external ticket sticky disposition does not match its dispatch reservation");
  }
}

function spawnGh(spawnSyncImpl, args, { env, repositorySlug, maxBuffer = 5 * 1024 * 1024 }) {
  return spawnSyncImpl("gh", args, {
    cwd: repoRoot,
    env: { ...env, GH_REPO: repositorySlug },
    encoding: "utf8",
    maxBuffer,
    timeout: 30000,
  });
}

function liveHeadRefOid(spawnSyncImpl, env, repositorySlug, prNumber) {
  const result = spawnGh(
    spawnSyncImpl,
    ["pr", "view", String(prNumber), "--repo", repositorySlug, "--json", "headRefOid"],
    { env, repositorySlug }
  );
  let payload = null;
  if (result.status === 0) {
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = null;
    }
  }
  if (payload === null || typeof payload.headRefOid !== "string" || payload.headRefOid === "") {
    fail("external_ticket_live_read_failed", "failed to read the live PR head");
  }
  return payload.headRefOid;
}

/** Full, paginated issue-comment snapshot (mirrors the runner's own live-read shape). */
function liveIssueComments(spawnSyncImpl, env, repositorySlug, prNumber) {
  const result = spawnGh(
    spawnSyncImpl,
    ["api", "--paginate", "--slurp", `repos/${repositorySlug}/issues/${prNumber}/comments?per_page=100`],
    { env, repositorySlug, maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    fail("external_ticket_live_read_failed", "failed to read the live PR issue comments");
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    fail("external_ticket_live_read_failed", `live issue-comment response is not valid JSON: ${error.message}`);
  }
  if (Array.isArray(payload) && payload.every((page) => Array.isArray(page))) {
    return payload.flat();
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  fail("external_ticket_live_read_failed", "live issue-comment response has an unexpected shape");
  return [];
}

function loadAcceptCredentialGateMaterials(packetDir, dispatchId) {
  const materialTexts = [];
  const explicitDenyList = [];
  const candidates = [
    path.join(packetDir, STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME),
  ];
  if (typeof dispatchId === "string" && /^[A-Za-z0-9._-]+$/.test(dispatchId)) {
    candidates.push(path.join(repoRoot, "notes", "tmp", `sticky-credential-gate-${dispatchId}.json`));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (!isPlainObject(parsed) || parsed.schema !== STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA) {
        continue;
      }
      if (Array.isArray(parsed.materialTexts)) {
        materialTexts.push(...parsed.materialTexts.filter((t) => typeof t === "string"));
      }
      if (Array.isArray(parsed.explicitDenyList)) {
        explicitDenyList.push(...parsed.explicitDenyList.filter((t) => typeof t === "string"));
      }
    } catch {
      // ignore unreadable sidecars
    }
  }
  return { materialTexts, explicitDenyList };
}

/**
 * D4 steps 3-4: live re-read, exact-one sticky resolution, footer
 * provenance cross-check, and create/update disposition binding. Returns the
 * fully-verified `receipt_payload` (the exact field set
 * assertExternalClosureReceiptPayloadShape requires).
 */
function liveAcceptFlow({ record, spawnSyncImpl, env, packetDir, context }) {
  const repositorySlug = record.repository_slug;
  const prNumber = Number(record.pr_number);

  const liveHead = liveHeadRefOid(spawnSyncImpl, env, repositorySlug, prNumber);
  const comments = liveIssueComments(spawnSyncImpl, env, repositorySlug, prNumber);

  const selection = selectExactSecondReviewStickyAuthority(comments);
  if (selection.status !== "selected") {
    fail(
      "external_sticky_ambiguous",
      `expected exactly one canonical sticky authority candidate, found ${selection.candidate_count}`
    );
  }
  const candidateRaw = selection.authority;
  const normalized = normalizeSecondReviewStickyCandidate(candidateRaw, repositorySlug, prNumber);
  if (normalized.error) {
    fail("external_sticky_ambiguous", `sticky authority candidate is malformed: ${normalized.error}`);
  }
  const target = normalized.target;

  if (liveHead !== record.head_ref_oid) {
    fail("external_head_moved", "the live PR head no longer matches the dispatched head");
  }

  const parsed = parseSecondReviewStickyAuthorityBody(candidateRaw.body, {
    expectedReviewerTool: record.reviewer_tool,
  });
  if (parsed.contract_errors.includes("sticky_reviewer_tool_mismatch")) {
    fail("external_sticky_provenance_mismatch", "sticky footer Tool token does not match the dispatched reviewer_tool");
  }
  if (parsed.status !== "valid") {
    fail("external_sticky_contract_invalid", `sticky authority body failed contract: ${parsed.contract_errors.join(", ")}`);
  }
  const modelPattern = MODEL_FAMILY_PATTERNS[record.reviewer_family];
  if (!modelPattern || !modelPattern.test(String(parsed.reviewer_model ?? ""))) {
    fail("external_sticky_provenance_mismatch", "sticky footer Model does not match the dispatched reviewer_family");
  }
  if (parsed.dispatch_id !== record.dispatch_id) {
    fail("reviewer_dispatch_identity_collision", "sticky dispatch_id does not match the dispatch reservation");
  }
  if (parsed.last_reviewed_sha !== record.head_ref_oid) {
    fail("external_head_moved", "sticky last_reviewed_sha does not match the dispatched head");
  }

  // A same-family fallback dispatch must disclose the weakened guarantee in the
  // sticky reason exactly as the renderer issued it; a missing prefix is not a
  // cross-model verdict.
  // The renderer binds the disclosure on its own sidecar, so acceptance never
  // depends on re-reading the reviewer-visible packet.
  const sameFamilyDisclosure = typeof context.same_family_disclosure === "string" && context.same_family_disclosure.trim() !== ""
    ? context.same_family_disclosure
    : null;
  if (sameFamilyDisclosure !== null && !stickyReasonRequiresSameFamilyFallback(parsed.reason)) {
    fail(
      "external_sticky_contract_invalid",
      "same-family fallback sticky reason must lead with the renderer-issued `same-family fallback: <why>` disclosure",
    );
  }
  if (sameFamilyDisclosure !== null && !String(parsed.reason ?? "").trim().startsWith(sameFamilyDisclosure)) {
    fail(
      "external_sticky_contract_invalid",
      "same-family fallback sticky reason must lead with the exact renderer-issued disclosure",
    );
  }

  try {
    if (guaranteeAssessmentRequired(context)) {
      const assessment = readReviewGuaranteeAssessment(candidateRaw.body, {
        reviewedTarget: record.head_ref_oid, dispatchId: record.dispatch_id,
      });
      if (assessment.requires_clarification) fail("external_guarantee_assessment_invalid", "review guarantee assessment requires clarification");
    }
  } catch (error) {
    fail("external_guarantee_assessment_invalid", error.message);
  }

  const gateMaterials = loadAcceptCredentialGateMaterials(packetDir, record.dispatch_id);
  const credentialGate = assertStickyBodyCredentialFree(candidateRaw.body, {
    materialTexts: gateMaterials.materialTexts,
    explicitDenyList: gateMaterials.explicitDenyList,
    repositorySlug: record.repository_slug,
    classification: STICKY_CREDENTIAL_LITERAL_DETECTED,
  });
  if (!credentialGate.ok) {
    fail(
      STICKY_CREDENTIAL_LITERAL_DETECTED,
      `sticky body failed credential gate (${credentialGateTelemetry(credentialGate).matched_token_kind}/${credentialGateTelemetry(credentialGate).len_bucket})`,
    );
  }

  const issuedAtMs = Date.parse(record.issued_at);
  if (record.sticky_write_action === "update") {
    if (target.id !== record.sticky_target_comment_id) {
      fail("external_sticky_disposition_unbound", "sticky comment id does not match the dispatched update target");
    }
    const updatedAtMs = Date.parse(target.updated_at);
    if (!Number.isFinite(updatedAtMs) || !Number.isFinite(issuedAtMs) || updatedAtMs < issuedAtMs) {
      fail("external_sticky_disposition_unbound", "sticky comment was not updated at or after the ticket was issued");
    }
  } else {
    const createdAtMs = Date.parse(candidateRaw.created_at);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(issuedAtMs) || createdAtMs < issuedAtMs) {
      fail("external_sticky_disposition_unbound", "sticky comment was not created at or after the ticket was issued");
    }
  }

  return {
    schema: COMPLETION_SCHEMA,
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    sticky_verdict: parsed.verdict,
    sticky_last_reviewed_sha: parsed.last_reviewed_sha,
    sticky_dispatch_id: parsed.dispatch_id,
    sticky_comment_id: target.id,
    sticky_comment_url: `https://github.com/${repositorySlug}/pull/${prNumber}#issuecomment-${target.id}`,
    sticky_body_sha256: target.body_sha256,
  };
}

/** Offline acceptance: only immutable dispatch data and the fixed reviewer report are inputs. */
function auditAcceptFlow({ record, context, packetDir }) {
  const packetBytes = readFileSync(context.packet_path);
  if (sha256Hex(packetBytes) !== record.packet_sha256) {
    fail("external_audit_report_binding_mismatch", "audit packet bytes no longer match the dispatch");
  }
  const data = parseCanonicalSecondReviewPacketData(packetBytes);
  if (data.mode !== "audit-only" || data.dispatch_id !== record.dispatch_id
    || data.head_ref_oid !== record.head_ref_oid || externalAuditReviewDataSha256(data) !== record.review_data_sha256) {
    fail("external_audit_report_binding_mismatch", "audit material does not match the dispatch");
  }
  let descriptor;
  let reportBytes;
  try {
    const reportPath = path.join(packetDir, EXTERNAL_AUDIT_REPORT_BASENAME);
    if (!lstatSync(reportPath).isFile()) fail("external_audit_report_invalid", "audit report must be a regular file, not a symlink");
    descriptor = openSync(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > EXTERNAL_AUDIT_REPORT_MAX_BYTES) {
      fail("external_audit_report_invalid", "audit report must be a regular file within 64 KiB");
    }
    // A bounded read also limits a file that grows after fstat.
    const buffer = Buffer.alloc(EXTERNAL_AUDIT_REPORT_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    reportBytes = buffer.subarray(0, length);
  } catch (error) {
    if (error.classification) throw error;
    fail(error.code === "ENOENT" ? "external_audit_report_missing" : "external_audit_report_invalid", "audit reviewer report is missing or unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const { report } = parseExternalAuditReview(reportBytes, { dispatch: record, target: data.target });
  const credentialResult = assertStickyBodyCredentialFree(reportBytes, {
    materialTexts: [data.review_material ?? ""],
    repositorySlug: record.repository_slug,
  });
  if (!credentialResult.ok) fail("external_audit_report_invalid", "audit report contains credential literal material");
  return {
    schema: COMPLETION_SCHEMA, repository_slug: record.repository_slug, pr_number: "none",
    head_ref_oid: record.head_ref_oid, attempt_id: record.attempt_id, dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id, review_data_sha256: record.review_data_sha256,
    audit_report_sha256: sha256Hex(reportBytes), audit_verdict: report.verdict,
    reviewer_tool: report.reviewer_tool, reviewer_model: report.reviewer_model,
  };
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]
 * @param {object} [options.env]
 * @param {Function} [options.spawnSync] injectable gh spawner (tests only)
 * @returns {Promise<{status: string, path: string}>}
 */
export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const spawnSyncImpl = options.spawnSync ?? spawnSync;

  const packetDir = argv[0];
  if (typeof packetDir !== "string" || packetDir === "") {
    fail("external_ticket_context_unreadable", "usage: accept-external-second-review.mjs <packet-dir>");
  }

  const { context, resolvedPacketDir } = readObservabilityContext(packetDir);
  const dispatchId = context.dispatch_id;
  if (typeof dispatchId !== "string" || dispatchId === "") {
    fail("external_ticket_context_unreadable", "observability-context.json is missing dispatch_id");
  }

  // F-12: aligned with voidExternalDispatch (T5/D5), which requires
  // control_evidence_root on the context and never falls back to a
  // process-default root — a missing root is identity evidence this helper
  // cannot trust, not a hole to silently paper over.
  const controlEvidenceRootValue = context.control_evidence_root;
  if (typeof controlEvidenceRootValue !== "string" || controlEvidenceRootValue === "") {
    fail("reviewer_dispatch_identity_collision", "observability context is missing control_evidence_root");
  }
  const rootDir = controlEvidenceRootValue;

  let evidence;
  try {
    evidence = readDispatchEvidence({ rootDir, dispatchId });
  } catch (error) {
    fail(error.classification ?? "reviewer_dispatch_identity_collision", error.message);
  }
  const record = evidence.dispatch;
  if (!record) {
    fail("reviewer_dispatch_identity_collision", "dispatch reservation was not found");
  }

  assertTicketIdentityMatchesRecord(context, record, resolvedPacketDir);

  // A slot file exists on disk but readDispatchEvidence could not resolve it
  // (unparseable / wrong shape) — readDispatchEvidence itself only fails
  // closed here when a completion or terminal receipt already exists, so a
  // bare corrupt slot with no receipts yet would otherwise be silently
  // treated as "no slot" and re-attempt a fresh accept over it.
  if (existsSync(evidence.paths.externalClosure) && evidence.externalClosure === null) {
    fail("external_closure_incomplete", "external closure slot exists but could not be resolved");
  }

  const slot = evidence.externalClosure;
  if (slot?.kind === "voided") {
    fail("external_dispatch_closed", 'external dispatch closure already holds the "voided" disposition');
  }
  if (slot?.kind === "accepted") {
    // D4 step 2 (design audit r1 finding 1): the slot is already published —
    // complete from its own receipt_payload with NO live re-read. This also
    // covers the idempotent-replay case (a completion receipt already
    // exists): writeExternalCompletionReceipt's publishImmutable call is the
    // canonical-bytes comparison against the existing receipt, not mere
    // presence — a tampered receipt whose bytes drift from the slot's own
    // receipt_payload fails closed as reviewer_dispatch_identity_collision
    // instead of being reported as already_accepted.
    const hadCompletion = evidence.completion !== null;
    const written = await writeExternalCompletionReceipt({ rootDir, dispatchId });
    if (record.mode === "audit-only") mirrorExternalAuditCompletionReceipt({ rootDir, dispatchId, packetDir: resolvedPacketDir });
    return { status: hadCompletion ? "already_accepted" : "accepted", path: written.path };
  }

  const receiptPayload = (record.mode === "audit-only" ? auditAcceptFlow : liveAcceptFlow)({
    record,
    context,
    spawnSyncImpl,
    env,
    packetDir: resolvedPacketDir,
  });
  await writeExternalClosureSlot({ rootDir, dispatchId, kind: "accepted", receiptPayload });
  const written = await writeExternalCompletionReceipt({ rootDir, dispatchId });
  if (record.mode === "audit-only") mirrorExternalAuditCompletionReceipt({ rootDir, dispatchId, packetDir: resolvedPacketDir });
  return { status: "accepted", path: written.path };
}

async function run() {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "failed",
        classification: error.classification ?? "external_ticket_unexpected_error",
        message: error.message,
      })}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
