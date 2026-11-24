#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReviewRemediationEvidenceCore } from "./lib/review-remediation-evidence-core.mjs";
import { CoreFailure, D30_CODES } from "./lib/review-remediation-evidence-core.mjs";
import {
  decodeStrictUtf8,
  hasExactOrderedKeys,
  isWorktreeEnumerationMemo,
  parseJsonDuplicateAware,
  readBoundedRequestFile,
  StrictJsonError,
} from "./hooks/lib/admission-record.mjs";

const core = createReviewRemediationEvidenceCore();

// Advisory only: seal-receipt and verify-receipt still succeed with unchanged stdout. Naming an unresolved
// guarantee assessment here lets the TL clarify it in the next round instead of first meeting it as
// classify-final latest_receipt_not_converged at archive time.
function writeUnresolvedAssessmentAdvisory(command, result) {
  if (command !== "seal-receipt" && command !== "verify-receipt") return;
  const ids = core.unresolvedAssessmentIds(result?.receipt?.reviewer_payload);
  if (ids.length === 0) return;
  process.stderr.write(`[review-remediation-evidence] ADVISORY: guarantee assessment is unresolved for ${ids.join(",")}; classify-final refuses this receipt as latest_receipt_not_converged until a later round's assessment clarifies it (review-guarantee-ceiling.md Consumer action)\n`);
}

export const REVIEW_RECEIPT_SCHEMA = core.REVIEW_RECEIPT_SCHEMA;
export const REVIEW_RECEIPT_SCHEMA_V1 = core.REVIEW_RECEIPT_SCHEMA_V1;
export const REVIEW_RECEIPT_SCHEMA_V2 = core.REVIEW_RECEIPT_SCHEMA_V2;
export const receiptExecutorAttribution = core.receiptExecutorAttribution;
export const REVIEW_MANIFEST_SCHEMA = core.REVIEW_MANIFEST_SCHEMA;
export const FINAL_EVIDENCE_SCHEMA = core.FINAL_EVIDENCE_SCHEMA;
export const canonicalJsonV1 = core.canonicalJsonV1;
export const parseCanonicalJsonV1 = core.parseCanonicalJsonV1;
export const assertSafeRepoRelativePath = core.assertSafeRepoRelativePath;

const MUTATION_SEAMS = new Set([
  "fsOps",
  "gitImpl",
  "spawnSyncImpl",
  "runnerImpl",
  "testMode",
]);

function assertProductionInput(input, allowed, operation, optional = []) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${operation} input must be a plain object`);
  }
  const keys = Object.keys(input);
  const injected = keys.find((key) => MUTATION_SEAMS.has(key));
  if (injected !== undefined) {
    throw new Error(`production ${operation} rejects ${injected}; injection belongs to internal core only`);
  }
  const unknown = keys.filter((key) => !allowed.includes(key) && !optional.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`production ${operation} has unknown or missing fields: ${[...unknown, ...missing].join(", ")}`);
  }
}

function productionCall(operation, allowed, handler, input, optional = []) {
  assertProductionInput(input, allowed, operation, optional);
  return handler(input);
}

// seal-receipt request has exactly one authority branch: admissionRecordId for
// a normal runtime-agent receipt, attestationRef for closed post-hoc recovery,
// or neither for tl-direct. The CLI transports the exact shape through
// --request <json-file>; mixed refs and caller-supplied mutation seams fail.
export function sealReviewRoundReceipt(input) {
  return productionCall("sealReviewRoundReceipt", ["repoRoot", "changeId", "reviewerPayload"], core.sealReviewRoundReceipt, input, ["admissionRecordId", "attestationRef", "bindingRoot"]);
}

export function captureReviewerOutput(input) {
  return productionCall(
    "captureReviewerOutput",
    ["repoRoot", "changeId", "roundNumber", "dispatchId", "payloadPath"],
    core.captureReviewerOutput,
    input,
  );
}

export function buildReviewRoundReceiptRequest(input) {
  return productionCall(
    "buildReviewRoundReceiptRequest",
    ["repoRoot", "changeId", "rawPayloadRef"],
    core.buildReviewRoundReceiptRequest,
    input,
    ["admissionRecordId", "attestationRef", "bindingRoot"],
  );
}

export function preparePostHocAttestation(input) {
  return productionCall("preparePostHocAttestation", ["repoRoot", "changeId", "attestationId", "reviewedHeadSha", "baseSha", "dispatchId", "responsibilityId", "reviewMode", "roundNumber", "riskShapeDigestSha256", "rawPayloadRef", "verdict", "findings", "openFindingIds", "preparerId", "eligibleReason", "preparedAt"], core.preparePostHocAttestation, input);
}

export function recordPostHocAuthorization(input) {
  return productionCall("recordPostHocAuthorization", ["repoRoot", "changeId", "authorizationId", "preparedRef", "authorizedBy", "authorizationText", "authorizedAt"], core.recordPostHocAuthorization, input);
}

export function sealPostHocAttestation(input) {
  return productionCall("sealPostHocAttestation", ["repoRoot", "changeId", "preparedRef", "authorizationRef", "witnessId", "witnessedAt"], core.sealPostHocAttestation, input);
}

export function verifyPostHocAttestation(input) {
  return productionCall("verifyPostHocAttestation", ["repoRoot", "changeId", "attestationId"], core.verifyPostHocAttestation, input);
}

export function verifyReviewRoundReceipt(input) {
  return productionCall("verifyReviewRoundReceipt", ["repoRoot", "receiptRef"], core.verifyReviewRoundReceipt, input, ["requireIndependence", "changeId", "bindingRoot"]);
}

export function sealCrossCarrierClosure(input) {
  return productionCall(
    "sealCrossCarrierClosure",
    ["repoRoot", "changeId", "sourceReceiptRef", "findings"],
    core.sealCrossCarrierClosure,
    input,
  );
}

export function verifyCrossCarrierClosure(input) {
  return productionCall(
    "verifyCrossCarrierClosure",
    ["repoRoot", "closureRef"],
    core.verifyCrossCarrierClosure,
    input,
  );
}

// In-process query consumed by pre-pr-archive-gate --pre-review. It discovers
// the latest sealed receipt and requires a unique replay-valid closure only
// when that receipt is partial/blocked with open findings.
export function verifyCurrentCrossCarrierClosure(input) {
  return productionCall(
    "verifyCurrentCrossCarrierClosure",
    ["repoRoot", "changeId"],
    core.verifyCurrentCrossCarrierClosure,
    input,
  );
}

export function sealReviewManifest(input) {
  return productionCall(
    "sealReviewManifest",
    ["repoRoot", "changeId", "roundNumber", "manifest"],
    core.sealReviewManifest,
    input,
    ["previousReceiptRef"],
  );
}

export function verifyReviewManifest(input) {
  return productionCall("verifyReviewManifest", ["repoRoot", "manifestRef", "verificationMode"], core.verifyReviewManifest, input);
}

export function sealFinalEvidenceRecord(input) {
  return productionCall("sealFinalEvidenceRecord", ["repoRoot", "changeId", "canonicalOwnerId"], core.sealFinalEvidenceRecord, input);
}

export function verifyFinalEvidenceRecord(input) {
  return productionCall("verifyFinalEvidenceRecord", ["repoRoot", "changeId"], core.verifyFinalEvidenceRecord, input);
}

// design.md D4 (fix-merge-gate-regression-currency): the merge-time, read-only
// counterpart to `verifyFinalEvidenceRecord` that does not require a clean
// tree, an unmoved main, or cwd HEAD to equal the recorded head. Its only
// production caller is the bounded merge verifier child spawned from
// `.devpro/scripts/hooks/lib/final-evidence-merge-verifier.mjs` (design D5),
// which loads this façade with a dynamic `import()` inside its own process,
// never the hook process itself; tests call it directly. Not a CLI command (see `CLI_COMMANDS`
// below): there is no operator step that consumes it directly.
export function verifyHeadBoundFinalEvidence(input) {
  return productionCall("verifyHeadBoundFinalEvidence", ["repoRoot", "changeId", "headSha"], core.verifyHeadBoundFinalEvidence, input, ["maxRecordBytes"]);
}

export function classifyBoundedRereview(input) {
  const required = [
    "repoRoot",
    "changeId",
    "previousReceiptRef",
    "repairDeltaManifestRef",
    "dependencyClosureManifestRef",
    "predecessorMatches",
  ];
  const optional = [
    "contentComparisonManifestRef",
    "contentExceptionDispositions",
    "sameAgentAvailable",
    "postDispatchDiscovery",
    "observationRecorded",
    "budgetState",
    "overrideId",
    "responsibilityId",
    "handbackCause",
    "recoveryDispositions",
  ];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("classifyBoundedRereview input must be a plain object");
  }
  const injected = Object.keys(input).find((key) => MUTATION_SEAMS.has(key));
  if (injected !== undefined) throw new Error(`production classifyBoundedRereview rejects ${injected}`);
  const unknown = Object.keys(input).filter((key) => !required.includes(key) && !optional.includes(key));
  const missing = required.filter((key) => !Object.hasOwn(input, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`production classifyBoundedRereview has unknown or missing fields: ${[...unknown, ...missing].join(", ")}`);
  }
  return core.classifyBoundedRereview(input);
}

export function classifyFinalReadiness(input) {
  return productionCall("classifyFinalReadiness", ["repoRoot", "changeId"], core.classifyFinalReadiness, input);
}

export function classifyTipMoveWhitelist(input) {
  return productionCall(
    "classifyTipMoveWhitelist",
    ["repoRoot", "reviewedSha", "headSha", "changeId"],
    core.classifyTipMoveWhitelist,
    input,
  );
}

// D10 (fix-zero-value-review-rounds): the review-stall observation. It never
// throws on its own account -- its four states ARE the answer, so the only
// failure this wrapper can introduce is `productionCall`'s input guard. That
// guard is exactly the reason it belongs here: it is what refuses a production
// caller the core's mutation seams. Both consumers -- the `--budget-check`
// report surface and the post-PR Stop hook -- enter through this export rather
// than constructing the core themselves, which is what keeps "core authority
// enters production only through the facade" a true statement about the tree
// and not just about one file.
//
// It writes nothing into the repo tree, but it is not side-effect free either:
// the receipt lookup resolves `derivedNotesRoot`, which creates the gitignored
// notes root when that directory is absent. That was a once-per-change edge
// before; the post-PR Stop hook reaches this path every turn now, so it is
// worth stating rather than rounding down to "read-only".
//
// `enumerationMemo` is the post-PR Stop hook's per-run worktree-enumeration handle
// (created only by admission-record.mjs). It caches the worktree MEMBER LIST for one
// hook run, never this observation's result: every call still resolves the binding,
// lists receipts and walks the chain fresh. A value the enumeration module did not
// create is refused HERE, before the core is reached, because the core's first catch
// turns any unknown error into `not-applicable` (a silent "do not block"); thrown out
// here it reaches the Cost Circuit Breaker's catch and becomes `unavailable`, a blocking
// state (D20).
//
// Not a CLI command: there is no request/response artifact to seal or verify,
// and no operator step that consumes it directly.
export function queryReviewStallState(input) {
  if (input !== null && typeof input === "object" && input.enumerationMemo !== undefined
    && !isWorktreeEnumerationMemo(input.enumerationMemo)) {
    throw new Error("enumeration-memo-invalid: production queryReviewStallState accepts only a handle created by the worktree enumeration module");
  }
  return productionCall("queryReviewStallState", ["repoRoot", "changeId"], core.queryReviewStallState, input, ["enumerationMemo"]);
}

const CLI_COMMANDS = new Map([
  ["capture-reviewer-output", captureReviewerOutput],
  ["build-receipt-request", buildReviewRoundReceiptRequest],
  ["prepare-post-hoc-attestation", preparePostHocAttestation],
  ["record-post-hoc-authorization", recordPostHocAuthorization],
  ["seal-post-hoc-attestation", sealPostHocAttestation],
  ["verify-post-hoc-attestation", verifyPostHocAttestation],
  ["seal-receipt", sealReviewRoundReceipt],
  ["verify-receipt", verifyReviewRoundReceipt],
  ["seal-cross-carrier-closure", sealCrossCarrierClosure],
  ["verify-cross-carrier-closure", verifyCrossCarrierClosure],
  ["seal-manifest", sealReviewManifest],
  ["verify-manifest", verifyReviewManifest],
  ["seal-final", sealFinalEvidenceRecord],
  ["verify-final", verifyFinalEvidenceRecord],
  ["classify-bounded", classifyBoundedRereview],
  ["classify-final", classifyFinalReadiness],
]);

// `bindingRoot` is the optional pre-resolution pin (design D7.3); the ordered
// request shapes below append it after the command's own optional keys, so the
// existing shapes stay valid and the pin stays opt-in.
const BUILD_RECEIPT_REQUEST_OPTIONAL_KEYS = Object.freeze(["admissionRecordId", "attestationRef", "bindingRoot"]);
const BUILD_RECEIPT_REQUEST_KEY_SHAPES = Object.freeze(
  Array.from({ length: 2 ** BUILD_RECEIPT_REQUEST_OPTIONAL_KEYS.length }, (_, mask) => [
    "repoRoot", "changeId", "rawPayloadRef",
    ...BUILD_RECEIPT_REQUEST_OPTIONAL_KEYS.filter((_, index) => (mask & (2 ** index)) !== 0),
  ]),
);
const VERIFY_RECEIPT_OPTIONAL_KEYS = Object.freeze(["requireIndependence", "changeId", "bindingRoot"]);
const VERIFY_RECEIPT_KEY_SHAPES = Object.freeze(
  Array.from({ length: 2 ** VERIFY_RECEIPT_OPTIONAL_KEYS.length }, (_, mask) => [
    "repoRoot", "receiptRef",
    ...VERIFY_RECEIPT_OPTIONAL_KEYS.filter((_, index) => (mask & (2 ** index)) !== 0),
  ]),
);

const D30_FILE_COMMAND_KEYS = new Map([
  ["capture-reviewer-output", [["repoRoot", "changeId", "roundNumber", "dispatchId", "payloadPath"]]],
  ["build-receipt-request", BUILD_RECEIPT_REQUEST_KEY_SHAPES],
  ["prepare-post-hoc-attestation", [["repoRoot", "changeId", "attestationId", "reviewedHeadSha", "baseSha", "dispatchId", "responsibilityId", "reviewMode", "roundNumber", "riskShapeDigestSha256", "rawPayloadRef", "verdict", "findings", "openFindingIds", "preparerId", "eligibleReason", "preparedAt"]]],
  ["record-post-hoc-authorization", [["repoRoot", "changeId", "authorizationId", "preparedRef", "authorizedBy", "authorizationText", "authorizedAt"]]],
  ["seal-post-hoc-attestation", [["repoRoot", "changeId", "preparedRef", "authorizationRef", "witnessId", "witnessedAt"]]],
  ["verify-post-hoc-attestation", [["repoRoot", "changeId", "attestationId"]]],
  ["seal-receipt", [
    ["changeId", "repoRoot", "reviewerPayload"],
    ["admissionRecordId", "changeId", "repoRoot", "reviewerPayload"],
    ["attestationRef", "changeId", "repoRoot", "reviewerPayload"],
    ["changeId", "repoRoot", "reviewerPayload", "bindingRoot"],
    ["admissionRecordId", "changeId", "repoRoot", "reviewerPayload", "bindingRoot"],
    ["attestationRef", "changeId", "repoRoot", "reviewerPayload", "bindingRoot"],
  ]],
  ["verify-receipt", VERIFY_RECEIPT_KEY_SHAPES],
]);

const D30_DETAILS = Object.freeze({
  "reviewer-payload-check": "Validate the captured reviewer payload and its dispatch tuple.",
  "post-hoc-record-check": "Verify the prepared, authorized, and witnessed post-hoc evidence.",
  "receipt-evidence-check": "Check receipt bytes, schema, chain, and cross-carrier evidence.",
  "receipt-authority-check": "Check the receipt's repository, dispatch, and reviewer authority.",
  "stored-artifact-check": "Check that the referenced evidence artifact is canonical and safe.",
  "request-input-check": "Check the request file's command-specific shape and required fields.",
  "repository-io-check": "A repository or filesystem operation failed. Check availability and retry.",
});

const assignCodes = (detailKey, codes) => codes.trim().split(/\s+/u).forEach((code) => { D30_CODE_DETAILS[code] = detailKey; });
const D30_CODE_DETAILS = Object.create(null);
assignCodes("request-input-check", `request-size-exceeded request-unparseable request-shape-invalid identifier-invalid sha-invalid digest-invalid timestamp-invalid`);
assignCodes("reviewer-payload-check", `raw-payload-read-failed raw-payload-size-exceeded raw-payload-collision raw-payload-digest-mismatch raw-payload-invalid raw-payload-root-unavailable raw-payload-publication-denied raw-payload-publication-failed raw-payload-publication-partial raw-payload-publication-indeterminate raw-payload-existing-unsafe open-finding-ids-noncanonical verdict-open-set-digest-mismatch cooperative-identity-not-distinct ordinary-review-not-independent predecessor-finding-omitted`);
assignCodes("post-hoc-record-check", `post-hoc-eligible-tuple-mismatch reviewed-head-after-cutoff eligible-reason-invalid authorization-stale authorization-binding-mismatch authorization-consumed authorization-claim-write-failed attestation-binding-mismatch attestation-consumed attestation-claim-write-failed post-hoc-evidence-invalid`);
assignCodes("receipt-evidence-check", `receipt-output-evidence-mismatch receipt-payload-digest-mismatch receipt-ref-digest-mismatch receipt-size-exceeded receipt-unparseable receipt-noncanonical receipt-path-schema-mismatch receipt-path-collision receipt-publish-failed receipt-readback-mismatch receipt-scan-failed receipt-candidate-limit-exceeded receipt-ambiguous receipt-not-committed legacy-receipt-seal-forbidden legacy-receipt-not-independent receipt-evidence-invalid`);
assignCodes("receipt-authority-check", `receipt-authority-missing receipt-authority-mixed receipt-identity-authority-mismatch receipt-authority-changed admission-record-consumed admission-claim-write-failed intent-scan-failed intent-candidate-limit-exceeded binding-root-mismatch change-worktree-required change-worktree-ambiguous git-head-unavailable receipt-path-change-mismatch receipt-authority-invalid`);
assignCodes("stored-artifact-check", `artifact-size-exceeded artifact-unparseable artifact-noncanonical artifact-ref-digest-mismatch artifact-read-failed artifact-write-failed artifact-readback-mismatch artifact-parent-invalid archive-scan-failed archive-candidate-limit-exceeded archive-candidate-invalid archive-entry-case-mismatch proposal-scan-failed proposal-carrier-case-mismatch proposal-carrier-invalid proposal-carrier-ambiguous artifact-class-unknown evidence-artifact-invalid`);
assignCodes("repository-io-check", `unexpected-io-fault`);
Object.freeze(D30_CODE_DETAILS);
if (Object.keys(D30_CODE_DETAILS).length !== D30_CODES.size
  || [...D30_CODES].some((code) => !Object.hasOwn(D30_CODE_DETAILS, code))
  || Object.keys(D30_DETAILS).sort().join("\0") !== [
    "post-hoc-record-check", "receipt-authority-check", "receipt-evidence-check",
    "repository-io-check", "request-input-check", "reviewer-payload-check", "stored-artifact-check",
  ].sort().join("\0")
  || Object.values(D30_CODE_DETAILS).some((detailKey) => !Object.hasOwn(D30_DETAILS, detailKey))) {
  throw new Error(`D30 code/detail catalog is inconsistent: missing=${[...D30_CODES].filter((code) => !Object.hasOwn(D30_CODE_DETAILS, code)).join(",")}; extra=${Object.keys(D30_CODE_DETAILS).filter((code) => !D30_CODES.has(code)).join(",")}`);
}
// fix-merge-gate-regression-currency D15: the seal request carries the required
// carry-forward set (open predecessor findings plus predecessor closed Criticals)
// and the round's own findings, so it grows with those, not with the round count.
// It is read up to the cap every receipt reader uses, and a larger request is refused
// at read with request-size-exceeded. The builder refuses a seal request or a
// receipt above that cap, and the sealer a receipt above it, with
// receipt-size-exceeded. Every other D30 request command keeps the generic
// request cap.
const D30_REQUEST_MAX_BYTES = new Map([
  ["seal-receipt", core.RECEIPT_SCAN_MAX_BYTES],
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOrderedKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length
    && keys.every((key, index) => Object.keys(value)[index] === key);
}

function isString(value) {
  return typeof value === "string";
}

function isDurableRefShape(value) {
  return isPlainObject(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, "path") && Object.hasOwn(value, "digest_sha256")
    && isString(value.path) && isString(value.digest_sha256);
}

function isFindingShape(value) {
  if (!hasOrderedKeys(value, ["finding_id", "state", "disposition", "observation"])
    || !isString(value.finding_id) || !isString(value.state)
    || value.disposition !== null && !isString(value.disposition)
    || !hasOrderedKeys(value.observation, ["axis", "severity", "carrier", "anchor", "detail", "evidence"])) return false;
  const observation = value.observation;
  return [observation.axis, observation.severity, observation.carrier, observation.anchor, observation.detail].every(isString)
    && Array.isArray(observation.evidence) && observation.evidence.every(isString);
}

function d30RequestTypesMatch(command, request) {
  if (!isString(request.repoRoot)) return false;
  if (command !== "verify-receipt" && !isString(request.changeId)) return false;
  if (command === "prepare-post-hoc-attestation") {
    return [request.attestationId, request.reviewedHeadSha, request.baseSha, request.dispatchId,
      request.responsibilityId, request.reviewMode, request.riskShapeDigestSha256, request.verdict,
      request.preparerId, request.eligibleReason, request.preparedAt].every(isString)
      && Number.isSafeInteger(request.roundNumber)
      && isDurableRefShape(request.rawPayloadRef)
      && Array.isArray(request.findings) && request.findings.every(isFindingShape)
      && Array.isArray(request.openFindingIds) && request.openFindingIds.every(isString);
  }
  if (command === "record-post-hoc-authorization") {
    return isString(request.authorizationId) && isDurableRefShape(request.preparedRef)
      && [request.authorizedBy, request.authorizationText, request.authorizedAt].every(isString);
  }
  if (command === "seal-post-hoc-attestation") {
    return isDurableRefShape(request.preparedRef) && isDurableRefShape(request.authorizationRef)
      && isString(request.witnessId) && isString(request.witnessedAt);
  }
  if (command === "verify-post-hoc-attestation") return isString(request.attestationId);
  if (command === "capture-reviewer-output") {
    return Number.isSafeInteger(request.roundNumber) && isString(request.dispatchId) && isString(request.payloadPath);
  }
  if (command === "build-receipt-request") {
    return isDurableRefShape(request.rawPayloadRef)
      && (!Object.hasOwn(request, "admissionRecordId") || isString(request.admissionRecordId))
      && (!Object.hasOwn(request, "attestationRef") || isDurableRefShape(request.attestationRef))
      && (!Object.hasOwn(request, "bindingRoot") || isString(request.bindingRoot));
  }
  if (command === "seal-receipt") {
    return isPlainObject(request.reviewerPayload)
      && (!Object.hasOwn(request, "admissionRecordId") || isString(request.admissionRecordId))
      && (!Object.hasOwn(request, "attestationRef") || isDurableRefShape(request.attestationRef))
      && (!Object.hasOwn(request, "bindingRoot") || isString(request.bindingRoot));
  }
  if (command === "verify-receipt") {
    return isDurableRefShape(request.receiptRef)
      && (!Object.hasOwn(request, "requireIndependence") || typeof request.requireIndependence === "boolean")
      && (!Object.hasOwn(request, "changeId") || isString(request.changeId))
      && (!Object.hasOwn(request, "bindingRoot") || isString(request.bindingRoot));
  }
  return true;
}

function d30RequestProblem(command, request) {
  if (!d30RequestTypesMatch(command, request) || request.repoRoot.length === 0) return "request-shape-invalid";
  if (Object.hasOwn(request, "changeId") && !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(request.changeId)) {
    return "identifier-invalid";
  }
  if (command === "capture-reviewer-output") {
    if (request.roundNumber < 1 || request.payloadPath.length === 0) return "request-shape-invalid";
    if (!/^[0-9a-f]{64}$/u.test(request.dispatchId)) return "digest-invalid";
  }
  return null;
}

function cliHelp() {
  return [
    "Usage: node .devpro/scripts/review-remediation-evidence.mjs <command> --request <json-file>",
    `Commands: ${[...CLI_COMMANDS.keys()].join(" | ")}`,
    "",
    "capture-reviewer-output: source bytes MUST equal canonicalJsonV1(raw v3 payload) plus exactly one LF; validation and tuple mismatch return raw-payload-invalid before immutable publication. Publication distinguishes root-unavailable, denied, failed, partial/indeterminate, existing-unsafe, and true byte collision without exposing local paths. Only the frozen closed historical post-hoc carriers retain a byte-exact exception.",
    "  A successor that omits a required predecessor finding returns predecessor-finding-omitted before the raw carrier is published (nothing is written). Required = every finding_id in the immediate predecessor scope.open_finding_ids plus every predecessor closed Critical except one closed under a TL scope ruling; other closed findings MAY be omitted. A predecessor ref whose receipt does not exist or fails validation returns raw-payload-invalid; any other native I/O fault stays unexpected-io-fault. The predecessor is read under the change binding worktree (the caller root only when the change cannot be located; any other binding failure returns its own binding code). Next step: the reviewer re-produces the payload carrying the required set (continue the same reviewer thread, else dispatch fresh; TL MUST NOT hand-patch the payload), then rerun capture with the same dispatch tuple; retrying the same bytes cannot succeed.",
    "  Produce-side schema (before publication): state=open findings MUST use disposition null (else raw-payload-invalid — open finding disposition must be null); reviewer_identity MUST include executor_kind (else raw-payload-invalid — reviewer_identity.executor_kind is required). TL MUST NOT hand-normalize executor_kind to pass seal.",
    "  requirement_scope (optional observation key, v3 only): in-scope | out-of-requirement | scope-unresolved; a missing key means in-scope and severity is never rewritten. Only an out-of-requirement Critical or Important may close with tracked-follow-up, and a scope-unresolved one only when a TL ruling in the change decisions.md ## Scope Rulings, bound to the finding, its observation hash, the round and the proposal carrier sha256, exists (see code-review-checklist.md R11); defer-with-owner-trigger never closes a Critical or Important.",
    "build-receipt-request: request { repoRoot, changeId, rawPayloadRef, admissionRecordId? | attestationRef?, bindingRoot? }. Derives the exact seal-receipt request and replays every read-only preclaim check without claiming or publishing.",
    "  A successor missing a required predecessor finding (same required set as capture-reviewer-output) returns predecessor-finding-omitted before any claim or write; retrying the same request cannot succeed. If the raw carrier was already published by an older tool: route=full re-runs classify-bounded after a commit for a fresh dispatch_id; a bounded round with a sealed manifest cannot be re-sealed, so hand the round back to the operator. Never overwrite, delete or recycle a published raw carrier.",
    "  runtime-agent MUST pass only admissionRecordId; post-hoc MUST pass only the sealed attestationRef; tl-direct MUST pass neither. Caller-supplied reviewerPayload, authority, evidence, or digest fields are rejected.",
    "  bindingRoot is the optional binding pin: a value that does not realpath-equal the exact-one resolved binding root fails closed with binding-root-mismatch. The consumer locates the change at the explicit changeId, else the admission record change_id, else the cwd fast path revalidated by exact-one — never the caller cwd alone — and substitutes the resolved binding root for the caller root (a removed worktree with the caller root still holding the change directory falls back to that root).",
    "seal-receipt: request is the unchanged canonical stdout of build-receipt-request; a successor missing a required predecessor finding returns predecessor-finding-omitted before any admission claim, post-hoc claim, receipt or marker write (recovery as for build-receipt-request). reviewer_identity.executor_kind is required (runtime-agent | post-hoc-tl-attested-runtime-review | tl-direct).",
    "  A runtime-agent seal MUST carry execution_root_head equal to the admission record head_sha (missing or differing → receipt-authority-changed); bindingRoot? is the same optional binding pin as build-receipt-request (mismatch → binding-root-mismatch).",
    "  runtime-agent MUST pass admissionRecordId (the spawn gate handoff record id); executor_evidence is producer-derived and rejected when caller-supplied.",
    "  post-hoc-tl-attested-runtime-review MUST pass attestationRef; tl-direct MUST NOT pass either authority ref.",
    "  verify-receipt reports executor_attribution: runtime-agent | post-hoc-tl-attested-runtime-review | tl-direct | legacy-unattributed.",
    "D30 request-file failures return canonical { ok: false, code, detail }; detail is fixed operator text from the closed catalog.",
    "  Source-typed fixed detail refinements identify full/non-null manifests, a missing dispatch risk digest algorithm, unsafe evidence parents/targets, and verified-read races; public codes and JSON keys stay unchanged.",
    "D30 native or otherwise-unclassified filesystem/process faults return unexpected-io-fault. Added domain codes: post-hoc-evidence-invalid, receipt-evidence-invalid, receipt-authority-invalid, evidence-artifact-invalid.",
    "  open finding disposition must be null (same produce-side rule as capture); seal-receipt is defense-in-depth, not the first discovery surface.",
    "  Size: seal-receipt reads its request up to the receipt read cap (256 KiB; every other D30 request command keeps 64 KiB), so a larger request fails at read with request-size-exceeded. build-receipt-request and seal-receipt return receipt-size-exceeded before any claim or write when the receipt would exceed that cap (build-receipt-request also when its seal request would); nothing is written. Retrying the same request cannot succeed (the receipt carries only the required carry-forward set, the round's own findings and any voluntarily carried closed findings), so stop and hand the round back to the operator.",
    "verify-receipt: request { repoRoot, receiptRef, requireIndependence?, changeId?, bindingRoot? }. Post-hoc receipts require literal requireIndependence: true.",
    "  Independent judgment accepts bound runtime-agent or post-hoc-tl-attested-runtime-review; tl-direct and legacy receipts fail closed.",
    "  An explicit changeId MUST equal the change id carried by receiptRef (else receipt-path-change-mismatch); bindingRoot is the optional pin (else binding-root-mismatch). Every new runtime-agent seal MUST carry execution_root_head equal to the admission record head_sha (a missing or differing value fails closed with receipt-authority-changed; historical payloads without the key stay readable).",
    "seal-cross-carrier-closure: request { repoRoot, changeId, sourceReceiptRef, findings }. findings exactly classify every open source finding as not-applicable or cross-carrier.",
    "  cross-carrier entries declare one semantic_invariant, bounded fixed search_literals, and every current-HEAD tracked text hit with aligned | historical-rejected | quoted-in-evidence disposition.",
    "verify-cross-carrier-closure: request { repoRoot, closureRef }. Replays declared fixed literals against current HEAD; this proves declared-search-set coverage, not semantic completeness.",
    "",
    "seal-manifest: change_base_sha MUST be merge-base(resolvedMain, HEAD) — the immutable review authority — NOT the moving origin/main tip. Rebase onto main is optional cleanup after main advances; it is not the only legitimate fix.",
    "  seal-manifest also requires the change binding root to be a committed worktree (ignored files excepted); any modified, staged, or deleted tracked file, or an untracked non-ignored file, refuses before durable write with 'seal-manifest requires a committed worktree'. This precondition is seal-manifest's own; the current verification mode below keeps its narrower relevant-paths-only scope.",
    "  When a predecessor sealed receipt exists, surface_base_sha MUST equal that receipt lineage.head_sha before durable write (resolvePredecessorReceiptForSurfaceEquality: explicit previousReceiptRef else latestReceipt). Ancestor-only success is not enough; equality failure is distinct from 'manifest surface base is not an ancestor'.",
    "classify-bounded: repairDeltaManifestRef and dependencyClosureManifestRef are required keys but MAY be null.",
    "  Equivalent forward reanchor may keep bounded only with an unchanged behavior-risk-v1 digest and equal tracked trees except regular non-executable Markdown bookkeeping in the existing Path D′ whitelist (no specs segment); range-diff is human context only. Bind change_base_sha to the new merge-base and surface_base_sha to the exact predecessor HEAD; seal both current-round manifests and obtain a current HEAD review. Unknown or changed review-bearing content still requires full review. Missing recorded Git objects (prune or fresh clone) fail closed: restore the exact referenced objects before retrying verification; range-diff cannot substitute for them.",
    "Seal both manifests before classify-bounded; null refs are not a route probe.",
    "The initial round (previousReceiptRef: null) MUST pass both manifest refs as null.",
    "With the validator trust surface changed and no earlier mandatory reopen (git_lineage_changed, digest_alg_mismatch, or risk_shape_changed outside a stall-exhausted convergence_recovery chain), null refs return full_reopen_required with manifest_refs_absent (not validator_trust_surface_changed) unless the production validator oracle cannot independently verify the change (absent or not executable in the change base, absent at HEAD, or its module graph changed or fails the closed oracle module-graph checks).",
    "Only route=bounded requires non-null sealed manifest refs on a subsequent classify-bounded call.",
    "A classify-bounded call with null refs never returns route=bounded.",
    "Receipt-authority bootstrap (cooperative disposition; not a classify-bounded route key):",
    "  missing_predecessor_seal: when no sealed notes/review-<change>-receipt-r*.json exists, classify-bounded with previousReceiptRef: null returns route=full round 1 with a legitimate dispatch_id (core initial_review path; proven by review-remediation-evidence.test.mjs initial classifier content-addressed dispatch case).",
    "  Mutable notes/review-*.md alone is not a predecessor. MUST NOT invent a dispatch_id. Record disposition receipt_authority_restart: missing_predecessor_seal (devpro:pre-pr Step 3).",
    "  After the restarted round-1 receipt is sealed, classify-final/seal-final evaluate that new sealed lineage only (not the prior mutable-only history).",
    "classify-final only verifies; it never seals. route=full_reopen_required carrying full_reopen_debug_reason=archive_transition_unsealed (diagnosis only) means HEAD is a Git-equivalent archive transition whose sealed record does not exist yet:",
    "  run seal-final (it seals the transition or fails with the specific non-equivalence error), then rerun classify-final. MUST NOT reopen the six axes on that output.",
    "  full_reopen_debug_reason=latest_receipt_not_converged (with open_finding_ids) means the latest receipt is not finished or still has open findings, Suggestions included:",
    "  close the listed ids through a bounded rereview before archive; seal-final refuses the same receipt after archive.",
    "  When it also carries unresolved_assessment_ids, the receipt's guarantee assessment classifies those findings unresolved (open_finding_ids may be empty):",
    "  clarify them so a later round's assessment no longer marks them unresolved. seal-receipt and verify-receipt already name these ids in a stderr ADVISORY line.",
    "  A full_reopen_required without that field is a real reopen cause (invalid lineage, invalid coverage, or a transition that is not equivalent).",
    "",
    "classify-bounded budget audit and handback authorization (D8/D12): optional budgetState (below-half | at-or-above-half | exhausted | unavailable, from --budget-check).",
    "  budgetState is audit/report only and never changes routing or dispatch authorization; its four values are still validated and reported.",
    "  On a convergent path, count>=3 or stalled_rounds issues route=bounded with full_reopen_reason=convergence_recovery (a recovery reason, NOT a full reopen) and a non-null dispatch_id; count or stall alone MUST NOT return handback_required.",
    "  A later classify while the stall/cap gate still holds, without new per-id recoveryDispositions bound to the previous recovery dispatch_id, returns route=recovery_disposition_required (dispatch_ready=false, dispatch_id=null) — not handback, and not a user-override request.",
    "  Explicit handbackCause of requirement_conflict | irreversible_high_risk | reviewer_unrecoverable returns handback_required. Only then may overrideId + responsibilityId authorize one successor:",
    "  Named handback→bounded→final path: supplying overrideId+responsibilityId after that durable handback returns one manifest-bound route=bounded with",
    "  full_reopen_reason=handback_authorized_bounded when no independent mandatory-full condition exists; only an independently proven reopen returns route=full with handback_authorized_full. The same exact-once claim consumes the authorization. Seal a qualified finished receipt on that dispatch, then classify-final may reach final_ready when other final preconditions hold. Without the override the route stays handback_required.",
    "  Wording repair: below the automatic cap, a risk-shape change limited to design ## Decisions text (named by a predecessor-round fix-now Suggestion on design.md) or to proposal safety rows (each named by a fix-now Suggestion on proposal.md whose anchor occurs in that row), when that round raised only Suggestions, returns route=bounded with full_reopen_reason=wording_repair_bounded; the reviewer escalates with postDispatchDiscovery=wording_repair_substantive.",
    "  A bounded receipt above the automatic cap seals and remains chain-valid when either (a) the override ledger contains a consumed claim bound to its exact responsibility_id and dispatch_id, or (b) chain walk proves classify-issued convergence_recovery bound to that dispatch and manifests with a non-handback predecessor. Forged or relabeled recovery labels still require the consumed claim.",
    "When current Git/risk authority and the predecessor receipt validate, recorded postDispatchDiscovery (new_critical, out_of_manifest_carrier, or wording_repair_substantive) with observationRecorded=true returns route=full with a classifier-issued dispatch_id and preserves the current bounded rereview count; observationRecorded=false returns record_observation_required without dispatch authority.",
    "classify-bounded route=full_reopen_required also carries full_reopen_debug_reason, for human diagnosis only.",
    "It MUST NOT be read as a routing signal or dispatch authority. Every route=full_reopen_required result below is non-dispatchable; use the value only for diagnosis and follow its next-step:",
    "  manifest_refs_absent: a required manifest ref is null/undefined -> seal the manifest, then rerun classify-bounded.",
    "  manifest_verification_failed: a manifest ref failed ownership, trust, eligibility, cycle, or content-comparison checks -> repair/re-seal the manifest, then rerun classify-bounded.",
    "  receipt_authority_invalid: the previous receipt failed its authority chain (digest, path ownership, or round progression) -> correct the receipt digest or re-seal the receipt, then rerun classify-bounded.",
    "  bounded_input_invalid: the initial-dispatch guard or predecessor-match set rejected the request -> correct the request JSON, then rerun classify-bounded.",
    "  unclassified_fault: an unexpected classification fault -> stop and diagnose the failed authority check; do not dispatch until classify-bounded returns route=full with a dispatch_id.",
    "",
    "classify-bounded route=risk_shape_unavailable also carries risk_shape_debug_reason, for human diagnosis only.",
    "It MUST NOT be read as a routing signal. Each debug reason selects the operator next-step below. For chore A (both proposal carriers absent by design), route=risk_shape_unavailable alone selects disposition receipt_authority_unavailable: chore_a_no_openspec (debug reason typically change_folder_invalid; other debug reasons do not change that disposition; mutable envelope + PR Review Summary; MUST NOT invent a dispatch_id; does not enter walkReceiptAuthorityChain):",
    "  carrier_not_at_head: a selected change carrier's bytes do not match the candidate HEAD Git object (often an uncommitted edit) -> commit or align the drifted file to HEAD, then rerun classify-bounded.",
    "  section_shape_invalid: a required proposal/design heading or Touch section is missing, duplicated, reordered, or malformed -> fix the proposal/design section, or run validate-openspec-change.mjs <name> --risk-shape-probe to locate exactly which heading, then rerun classify-bounded.",
    "  front_matter_invalid: the proposal's leading YAML front matter (risk_classes/rationale) is missing or malformed -> fix the front matter, then rerun classify-bounded.",
    "  change_folder_invalid: the change folder composition is invalid (proposal.md and proposal-mini.md both present or both absent, a full change is missing design.md, or active and archived authorities both exist, e.g. after undoing an archive commit a leftover archive/<date>-<change>/ shell holding only untracked admission-records: move them back to the active folder, then delete the emptied shell dir) -> fix the change folder composition, then rerun classify-bounded; when both proposal carriers are absent by chore-A design, use the chore_a_no_openspec disposition above (do not invent a dispatch_id).",
    "  capability_delta_invalid: a specs/<capability>/spec.md requirement is outside a delta mode heading or duplicated -> fix the capability spec delta, then rerun classify-bounded.",
    "  carrier_integrity_unsafe: a selected carrier failed a file-safety or identity check (symlink, escaped path, short read, fd identity drift) -> treat this as an environment or security anomaly and stop; do not blindly retry.",
    "  request_or_git_authority_invalid: the request's changeId is not a safe slug, or the repo's git authority (main ref, HEAD, merge-base) could not be resolved -> fix the request JSON's changeId or repair the repo's git state, then rerun classify-bounded.",
    "  unclassified_fault: an unexpected fault with no mapped root cause -> stop and report (fail-closed default).",
  ].join("\n");
}

function parseRequest(text) {
  return core.parseRequestJson(text);
}

function runCli(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${cliHelp()}\n`);
    return;
  }
  const [command, requestFlag, requestPath, ...rest] = argv;
  const handler = CLI_COMMANDS.get(command);
  if (!handler) throw new Error(`unknown command: ${command ?? "<missing>"}`);
  if (requestFlag !== "--request" || typeof requestPath !== "string" || rest.length > 0) {
    throw new Error("command requires exactly --request <json-file>");
  }
  const d30KeyShapes = D30_FILE_COMMAND_KEYS.get(command);
  if (d30KeyShapes !== undefined) {
    let loaded;
    try {
      loaded = readBoundedRequestFile(requestPath, D30_REQUEST_MAX_BYTES.get(command), { propagateNativeFaults: true });
    } catch {
      return writeCliFailure("unexpected-io-fault");
    }
    if (!loaded.ok) return writeCliFailure(loaded.code);
    const { bytes } = loaded;
    let request;
    try {
      request = parseJsonDuplicateAware(decodeStrictUtf8(bytes, "request-unparseable"), "request-unparseable");
    } catch (error) {
      return writeCliFailure(error instanceof StrictJsonError && D30_CODES.has(error.code)
        ? error.code
        : "request-unparseable");
    }
    if (!d30KeyShapes.some((keys) => hasExactOrderedKeys(request, keys))) return writeCliFailure("request-shape-invalid");
    const requestProblem = d30RequestProblem(command, request);
    if (requestProblem !== null) return writeCliFailure(requestProblem);
    let result;
    try {
      result = handler(request);
      process.stdout.write(`${canonicalJsonV1(result)}\n`);
    } catch (error) {
      // Preserve only a source-typed code from the closed D30 catalog. Never
      // derive codes or operator detail from error prose or arbitrary fields.
      const sourceCode = error instanceof CoreFailure && D30_CODES.has(error.code)
        ? error.code
        : "unexpected-io-fault";
      // The raw capture CLI has an established public code for invalid payload
      // bytes. Keep its narrower internal open-ID diagnostic behind that
      // command boundary without changing direct helper callers.
      const code = command === "capture-reviewer-output" && sourceCode === "open-finding-ids-noncanonical"
        ? "raw-payload-invalid"
        : sourceCode;
      return writeCliFailure(code, code === sourceCode ? CoreFailure.safeDetail(error) : null);
    }
    writeUnresolvedAssessmentAdvisory(command, result);
    return;
  }
  const result = handler(parseRequest(readFileSync(requestPath, "utf8")));
  process.stdout.write(`${canonicalJsonV1(result)}\n`);
}

function writeCliFailure(code, safeDetail = null) {
  const selectedCode = D30_CODES.has(code) ? code : "unexpected-io-fault";
  const detailKey = D30_CODE_DETAILS[selectedCode];
  process.stdout.write(`${canonicalJsonV1({ ok: false, code: selectedCode, detail: safeDetail ?? D30_DETAILS[detailKey] })}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
