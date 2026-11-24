import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";
import { listPostPrCompletionMarkers } from "./post-pr-completion-state.mjs";
import { fsyncDirectory } from "../../lib/durable-fs.mjs";
import { assertDispatchId, isValidDispatchId } from "../../lib/control-evidence-dispatch-id.mjs";
import {
  acquireCapacityLock,
  capacityLockOwnerIsAlive,
} from "../../lib/control-evidence-capacity-lock.mjs";
import {
  isUsageManifestAtomicTempFileName,
  USAGE_MANIFEST_FILE,
  USAGE_MANIFEST_SCHEMA,
} from "../../lib/session-usage-manifest-contract.mjs";

export { capacityLockOwnerIsAlive };

export const DISPATCH_SCHEMA = "devpro-second-review-dispatch/v1";
export const LEGACY_COMPLETION_SCHEMA = "devpro-second-review-completion/v1";
export const COMPLETION_SCHEMA = "devpro-second-review-completion/v2";
export const TERMINAL_RECEIPT_SCHEMA = "devpro-second-review-closed-terminal/v1";
export const FAULT_CAPSULE_SCHEMA = "devpro-second-review-fault-capsule/v1";
export const ORCHESTRATION_RESPONSIBILITY = "reviewer_invocation_orchestration";
export const TERMINAL_RECEIPT_RESPONSIBILITY = "reviewer_invocation_lifecycle";
export const FAULT_CONSUMPTION_SCHEMA = "devpro-second-review-fault-consumption/v1";
export const FAULT_SUPERSESSION_SCHEMA = "devpro-second-review-fault-supersession/v1";
// D12 (R5; strengthen-reviewer-model-selection T13): sibling immutable artifact
// carrying the three-part requested/observed/agreement record per dispatch. A
// sibling of completion-receipt.json, not a field on it (OQ-1 selected option 2 —
// zero dual-read, no change to assertCompletionReceipt's exact field set).
export const REVIEWER_MODEL_RECORD_SCHEMA = "devpro-second-review-reviewer-model/v1";
export const LINEAGE_APPROVAL_RECEIPT_SCHEMA = "devpro-second-review-lineage-approval/v1";
export const OPERATOR_ABANDONMENT_SLOT_SCHEMA = "devpro-second-review-operator-abandonment/v1";
export const DISPATCH_LIFECYCLE_SLOT_SCHEMA = "devpro-second-review-dispatch-lifecycle-slot/v1";
export const OPERATOR_DISPOSITION_SCHEMA = "devpro-second-review-operator-disposition/v1";
export const PR_2927_UNSTARTED_DISPATCH = Object.freeze({
  repository_slug: "devpro-tw/devpro-agent-rules",
  pr_number: "2927",
  source_repository: "devpro-tw/devpro-agent-rules",
  source_ref: "bugfix/fix-post-pr-marker-non-ff-rebind",
  head_ref_oid: "1ca5d65c55dcb15f5395c201d413ce4a164ef327",
  attempt_id: "second-review-pr-2927-1ca5d65c55dc-initial-56293eef-eb39-4583-93bc-d20a75e8c846",
  dispatch_id: "dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602",
  previous_dispatch_id: "dispatch-79f1b681-bca6-41c8-bd79-e129b1458be3",
});
export const PR_2927_UNSTARTED_CONFIRMATION =
  "ABANDON dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602 head 1ca5d65c55dcb15f5395c201d413ce4a164ef327 runner_not_started";

export const CAPSULE_REQUIRED_CLASSIFICATIONS = Object.freeze(new Set([
  "reviewer_orchestration_permission_denied",
  "reviewer_orchestration_unknown",
]));

export const TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS = Object.freeze({
  reviewer_blocking_verdict: Object.freeze([
    "reviewer_completion_critical",
    "reviewer_completion_unavailable",
  ]),
  provider_blocked: Object.freeze([
    "claude_reviewer_provider_rate_limited",
    "claude_reviewer_authentication_failed",
  ]),
  confirmed_timeout: Object.freeze([
    "reviewer_cli_timeout",
  ]),
  spawn_or_probe_failure: Object.freeze([
    "tool_discovery_blocked",
    "sticky_write_disposition_blocked",
    "reviewer_cli_spawn_failed",
    "review_material_scope_unresolvable",
    "probe_malformed",
    "probe_evidence_unavailable",
    "probe_capture_suspect",
    "recipe_parser_mismatch",
    "required_flag_absent_in_host_help",
    "reviewer_host_surface_unverified",
    // D6 (R4; tasks.md T23-T24): write-capability preflight failure — a round-trip
    // write/read-back/delete probe against <neutralCwd>/reviewer-tmp did not succeed
    // before the reviewer CLI ever spawned (design.md D5: this is a terminal
    // classification, pre-spawn already determines the final outcome).
    "reviewer_write_surface_unverified",
  ]),
  tool_surface_fault: Object.freeze([
    "reviewer_tool_surface_mismatch",
    "reviewer_tool_surface_evidence_missing",
  ]),
  output_safety_overflow: Object.freeze([
    "reviewer_output_line_overflow",
  ]),
  terminal_contract_or_cli_failure: Object.freeze([
    "reviewer_cli_failed",
    "reviewer_cli_interrupted",
    // OpenCode: the dispatched session's export did not prove the selected model, the
    // exact input/report bytes or a terminal completion. Same fail-closed group as a
    // malformed completion contract; the adapter classification rides in the activity log.
    "reviewer_model_provenance_unverified",
    "reviewer_cli_recipe_incompatible",
    "reviewer_completion_contract_missing",
    // fix-projection-completion-truncation (R1/D3): the named truncation classification
    // splits out of `reviewer_completion_contract_missing`'s missing branch only when the
    // bounded stdout tail proves a truncation shape. Same outcome group, same fail-closed
    // semantics — the exactly-one-outcome-group invariant above is unchanged.
    "reviewer_completion_stream_truncated",
    "reviewer_completion_reason_missing",
    "reviewer_completion_contract_invalid",
    "sticky_verification_input_missing",
    "sticky_verification_read_failed",
    "sticky_verification_parse_failed",
    "sticky_response_shape_invalid",
    "sticky_missing",
    "sticky_authority_ambiguous",
    "sticky_contract_invalid",
    "sticky_sha_mismatch",
    "sticky_dispatch_mismatch",
    "sticky_verdict_not_gate_satisfying",
    "sticky_verification_exception",
  ]),
  // D5 (R5; add-external-evaluator-second-review T2): TL void of an issued external
  // evaluator ticket. Pre-spawn like spawn_or_probe_failure (no process was ever
  // spawned), but a distinct group because it is written by
  // writeExternalVoidTerminalReceipt, not by the runner's pre-spawn classifier.
  external_evaluator_closed: Object.freeze([
    "external_evaluator_voided",
  ]),
  // D5 (R2): one exact human-confirmed reservation may be closed before spawn.
  // Only the operator slot writer may publish this classification.
  operator_abandonment: Object.freeze([
    "operator_abandoned_pre_spawn",
  ]),
  stale_reservation_closure: Object.freeze([
    "stale_reservation_closed_pre_spawn",
  ]),
  diagnostic_scan_closed: Object.freeze([
    "legacy_diagnostic_scan_closed",
  ]),
});

const terminalReceiptOutcomeByClassification = new Map(
  Object.entries(TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS)
    .flatMap(([outcomeGroup, classifications]) => (
      classifications.map((classification) => [classification, outcomeGroup])
    ))
);

const terminalReceiptClassificationCount = Object.values(TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS)
  .reduce((count, classifications) => count + classifications.length, 0);
if (terminalReceiptOutcomeByClassification.size !== terminalReceiptClassificationCount) {
  throw new Error("closed-terminal classifications must belong to exactly one outcome group");
}

export const TERMINAL_RECEIPT_CLASSIFICATIONS = Object.freeze(
  new Set(terminalReceiptOutcomeByClassification.keys())
);

// D5 (R5): external void terminals are pre-spawn for the same reason
// spawn_or_probe_failure classifications are — no process was ever spawned —
// so this set is the union of both groups, not just the runner group.
const PRE_SPAWN_TERMINAL_CLASSIFICATIONS = Object.freeze(
  new Set([
    ...TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS.spawn_or_probe_failure,
    ...TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS.external_evaluator_closed,
    ...TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS.operator_abandonment,
    ...TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS.stale_reservation_closure,
  ])
);

export function terminalReceiptOutcomeGroup(classification) {
  return terminalReceiptOutcomeByClassification.get(classification) ?? null;
}

const DISPATCH_FILE = "dispatch.json";
const INVOCATION_CLAIM_FILE = "invocation-claim.json";
const COMPLETION_RECEIPT_FILE = "completion-receipt.json";
const TERMINAL_RECEIPT_FILE = "terminal-receipt.json";
const FAULT_CAPSULE_FILE = "fault-capsule.json";
const CONSUMPTION_RECEIPT_FILE = "consumption-receipt.json";
const SUPERSESSION_RECEIPT_FILE = "supersession-receipt.json";
// D12 (R5): the 8th named read/write, sibling to completion-receipt.json.
const REVIEWER_MODEL_RECORD_FILE = "reviewer-model-record.json";
const OPERATOR_ABANDONMENT_SLOT_FILE = "operator-abandonment-slot.json";
const DISPATCH_LIFECYCLE_SLOT_FILE = "dispatch-lifecycle-slot.json";
const OPERATOR_DISPOSITION_FILE = "operator-disposition.json";
const MAX_OPERATOR_DISPOSITION_BYTES = 8192;

const MAX_DISPATCH_BYTES = 4096;
const MAX_CAPSULE_BYTES = 16384;
const MAX_REDACTED_EXCERPT_BYTES = 512;
const MAX_DISPATCH_EVIDENCE_BYTES = 32768;
const MAX_EVIDENCE_FILES = 16;
const MAX_IDENTITY_FIELD_BYTES = 256;
const MAX_DISPATCHES_PER_PR_HEAD = 16;
export const MAX_DISPATCHES_PER_PR_LINEAGE = 256;
// Exported (R6) so run-second-reviewer-projection.mjs's ownership-based reviewer-home
// scavenging (D3 step 4) can reuse the same-level scan bound instead of writing a second
// literal 512 (self-check #10: a duplicated capacity fact would silently drift).
export const MAX_DISPATCHES_PER_REPOSITORY = 512;
const MAX_BYTES_PER_PR_HEAD = 524288;
const MAX_BYTES_PER_REPOSITORY = 16777216;
export const COMPLETE_CHAIN_OWNER_TTL_MS = 2 * 60 * 60_000;
// A lineage approval comment is accepted only while it is younger than this, and the dispatch that
// consumed it is kept only until the comment reaches this age. A consumed approval id therefore can
// never become reusable, and the audit dispatches do not pile up toward the repository capacity.
export const LINEAGE_APPROVAL_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Allowlisted companion beside receipt files (Recap token rollup). MUST NOT block TTL reclaim. */
const LINEAGE_APPROVAL_TRANSACTION_FILE = "lineage-approval-transaction.json";
const CONTROL_EVIDENCE_CLEANUP_COMPANION_FILES = Object.freeze(new Set([
  USAGE_MANIFEST_FILE,
  LINEAGE_APPROVAL_TRANSACTION_FILE,
]));
const CLEANUP_SCAN_CURSOR_FILE = ".cleanup-scan-cursor.json";
const USAGE_MANIFEST_RETENTION_DIRECTORY = ".usage-manifest-retention";
const USAGE_MANIFEST_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const USAGE_MANIFEST_RETENTION_MAX_COPIES = 512;

if (MAX_BYTES_PER_PR_HEAD !== MAX_DISPATCH_EVIDENCE_BYTES * MAX_DISPATCHES_PER_PR_HEAD
  || MAX_BYTES_PER_REPOSITORY !== MAX_DISPATCH_EVIDENCE_BYTES * MAX_DISPATCHES_PER_REPOSITORY) {
  throw new Error("second-review control-evidence byte budgets are inconsistent");
}

function collision(message) {
  const error = new Error(message);
  error.classification = "reviewer_dispatch_identity_collision";
  return error;
}

const REAL_PR_NUMBER = /^[1-9][0-9]*$/;
const HEX_SHA_SHAPE = /^[a-fA-F0-9]{40}$/;
const HEX_SHA_CANONICAL = /^[a-f0-9]{40}$/;
const STICKY_COMPLETION_OUTCOME = "reviewer_process_closed_and_sticky_verified";
const STICKY_COMPLETION_CLASSIFICATION = "sticky_verified";
const AUDIT_COMPLETION_OUTCOME = "reviewer_process_closed_audit_only";
const AUDIT_COMPLETION_CLASSIFICATION = "audit_only_verified";
// D4 (R4; add-external-evaluator-second-review T2): the fourth completion form —
// a TL-accepted external evaluator sticky, closed without any runner invocation.
export const EXTERNAL_COMPLETION_OUTCOME = "external_evaluator_sticky_accepted";
export const EXTERNAL_COMPLETION_CLASSIFICATION = "external_evaluator_accepted";
export const EXTERNAL_AUDIT_COMPLETION_OUTCOME = "external_evaluator_audit_accepted";
export const EXTERNAL_AUDIT_COMPLETION_CLASSIFICATION = "external_audit_verified";
export const EXTERNAL_EVALUATOR_EXECUTOR_KIND = "external-evaluator";
const EXTERNAL_VOID_OUTCOME_GROUP = "external_evaluator_closed";
const EXTERNAL_VOID_CLASSIFICATION = "external_evaluator_voided";
export const EXTERNAL_CLOSURE_SLOT_SCHEMA = "devpro-second-review-external-closure/v1";
const EXTERNAL_CLOSURE_SLOT_FILE = "external-closure.json";
const MAX_EXTERNAL_CLOSURE_SLOT_BYTES = 4096;
const MAX_OPERATOR_ABANDONMENT_SLOT_BYTES = 4096;
const MAX_DISPATCH_LIFECYCLE_SLOT_BYTES = 8192;
// Nominal worst-case coexisting set on the fault path: dispatch (an embedded lineage approval
// receipt shares the dispatch bound), lifecycle slot, invocation claim, reviewer-model record,
// consumption, supersession and fault capsule. The control-evidence rule quotes this figure and a
// test fails when the two drift, so recompute both before adding a record or loosening a bound.
export const NOMINAL_FAULT_PATH_EVIDENCE_BYTES = MAX_DISPATCH_BYTES * 5
  + MAX_DISPATCH_LIFECYCLE_SLOT_BYTES
  + MAX_CAPSULE_BYTES;
const EXTERNAL_COMPLETION_VERDICTS = Object.freeze(["PASS", "WARN", "CRITICAL", "UNAVAILABLE"]);
// The slot's receipt_payload holds every content field of the eventual completion
// receipt except the three constants writeExternalCompletionReceipt adds
// (outcome/classification/process_close_observed) and integrity_id (always
// computed at publish time). This is what makes the slot alone sufficient to
// rebuild a byte-identical receipt after a crash, with no live re-read (D4 step 7).
const EXTERNAL_CLOSURE_RECEIPT_PAYLOAD_FIELDS = Object.freeze([
  "schema",
  "repository_slug",
  "pr_number",
  "head_ref_oid",
  "attempt_id",
  "dispatch_id",
  "previous_dispatch_id",
  "sticky_verdict",
  "sticky_last_reviewed_sha",
  "sticky_dispatch_id",
  "sticky_comment_id",
  "sticky_comment_url",
  "sticky_body_sha256",
]);
const EXTERNAL_AUDIT_RECEIPT_PAYLOAD_FIELDS = Object.freeze([
  "schema", "repository_slug", "pr_number", "head_ref_oid", "attempt_id", "dispatch_id", "previous_dispatch_id",
  "review_data_sha256", "audit_report_sha256", "audit_verdict", "reviewer_tool", "reviewer_model",
]);
const AUDIT_COMPLETION_FIELDS = Object.freeze([
  "schema",
  "repository_slug",
  "pr_number",
  "head_ref_oid",
  "attempt_id",
  "dispatch_id",
  "previous_dispatch_id",
  "outcome",
  "classification",
  "process_close_observed",
  "integrity_id",
]);

function isRealPrNumber(value) {
  return REAL_PR_NUMBER.test(String(value ?? ""));
}

function isHexShaShape(value) {
  return HEX_SHA_SHAPE.test(String(value ?? ""));
}

function assertPersistedHeadRefOid(value, label = "head_ref_oid") {
  const text = String(value ?? "");
  if (isHexShaShape(text) && !HEX_SHA_CANONICAL.test(text)) {
    throw collision(`${label} must be canonical lowercase 40-hex`);
  }
}

function prHeadCapacityApplies(record) {
  return isRealPrNumber(record?.pr_number) && isHexShaShape(record?.head_ref_oid);
}

function prHeadBucketKey(record) {
  return `${record.pr_number}\0${String(record.head_ref_oid).toLowerCase()}`;
}

function hasStickyCompletionKeys(record) {
  return Object.keys(record).some((key) => key.startsWith("sticky_"));
}

// Narrow: only the runner-owned outcome/classification pair (legacy v1 and
// current v2 share this pair). Used to select which exact field set a
// completion receipt must match in assertCompletionReceipt.
function isRunnerStickyCompletionOutcome(record) {
  return record.outcome === STICKY_COMPLETION_OUTCOME
    && record.classification === STICKY_COMPLETION_CLASSIFICATION;
}

function isExternalCompletionOutcome(record) {
  return record.outcome === EXTERNAL_COMPLETION_OUTCOME
    && record.classification === EXTERNAL_COMPLETION_CLASSIFICATION;
}

function isExternalAuditCompletionOutcome(record) {
  return record.outcome === EXTERNAL_AUDIT_COMPLETION_OUTCOME
    && record.classification === EXTERNAL_AUDIT_COMPLETION_CLASSIFICATION;
}

function isAnyExternalCompletionOutcome(record) {
  return isExternalCompletionOutcome(record) || isExternalAuditCompletionOutcome(record);
}

// Broad: recognizes the fourth (external) form as a "sticky completion"
// predecessor for lineage purposes (assertDirectPredecessor's real-PR successor
// check) without letting that widened check select the wrong field set in
// assertCompletionReceipt, which always tests the narrow predicate first.
function isStickyCompletionOutcome(record) {
  return isRunnerStickyCompletionOutcome(record) || isExternalCompletionOutcome(record);
}

function isExternalDispatchRecord(record) {
  return record?.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
}

function externalClosureIncompleteError(message) {
  const error = new Error(message);
  error.classification = "external_closure_incomplete";
  return error;
}

// Primary-review F-11: distinct from external_closure_incomplete (missing
// evidence) — this is present-but-drifted evidence, e.g. a completion or
// terminal receipt whose bytes no longer match what the accepted/voided
// slot's own content would rebuild. check.mjs's classifyExternalClosureIncomplete
// only special-cases external_closure_incomplete (routes to group a/c); any
// other classification, including this one, falls through to its generic
// group (d) "report to TL" branch, so a tampered receipt can never be
// accept-fixed or silently treated as verified.
function externalClosureReceiptMismatchError(message) {
  const error = new Error(message);
  error.classification = "external_closure_receipt_mismatch";
  return error;
}

function isAuditCompletionOutcome(record) {
  return record.outcome === AUDIT_COMPLETION_OUTCOME
    && record.classification === AUDIT_COMPLETION_CLASSIFICATION;
}

function capacityError(message) {
  const error = new Error(message);
  error.classification = "reviewer_dispatch_capacity_exceeded";
  return error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw collision(`${label} must be an object`);
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

// r2 finding F-srms-pr2-01: the shape rule assertIdentityField enforces,
// exposed as a predicate so a PRODUCER can degrade an out-of-shape value before
// it reaches a writer. Without it the only way to ask "would this be accepted?"
// is to restate the byte bound and the control-character class at the call
// site, i.e. a second copy of a fact this module owns.
export function isUsableIdentityFieldValue(value) {
  return typeof value === "string" && value.length > 0
    && byteLength(value) <= MAX_IDENTITY_FIELD_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertIdentityField(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!isUsableIdentityFieldValue(value)) throw collision(`${label} is invalid`);
}

function assertDispatchRecord(record) {
  assertPlainObject(record, "dispatch record");
  if (record.schema !== DISPATCH_SCHEMA) throw collision(`dispatch schema must be ${DISPATCH_SCHEMA}`);
  for (const field of [
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
  ]) {
    assertIdentityField(record[field], field);
  }
  assertDispatchId(record.dispatch_id);
  assertIdentityField(record.previous_dispatch_id, "previous_dispatch_id", { nullable: true });
  if (record.previous_dispatch_id === record.dispatch_id) {
    throw collision("dispatch lineage cannot refer to itself");
  }
}

export function assertSecondReviewDispatchRecord(record) {
  assertDispatchRecord(record);
  const baseFields = [
    "schema",
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
    "packet_sha256",
    "carrier_root_id",
  ];
  const v5Fields = [
    "paged_full_material_sha256",
    "paged_full_material_created_at",
    "paged_full_material_expires_at",
  ];
  // D1/D4 (R1, R4): additive external-evaluator dispatch fields. Absent =
  // runner path; runner dispatch bytes must stay exactly the base/v5 field set.
  const externalFields = [
    "executor_kind",
    "reviewer_family",
    "primary_family",
    "reviewer_tool",
    "sticky_write_action",
    "sticky_target_comment_id",
    "sticky_snapshot_digest",
    "issued_at",
  ];
  const lineageApprovalFields = ["lineage_approval_receipt_id", "lineage_approval_receipt"];
  const hasV5Binding = v5Fields.some((field) => Object.hasOwn(record, field));
  const hasExternalBinding = Object.hasOwn(record, "executor_kind");
  const isExternalAudit = hasExternalBinding && record.mode === "audit-only";
  const hasLineageApproval = lineageApprovalFields.some((field) => Object.hasOwn(record, field));
  if (hasV5Binding && hasExternalBinding) {
    // D1: external dispatches never page — page-window fields and external
    // fields are mutually exclusive by construction, not just by convention.
    throw collision("external dispatch record must not carry paged full-material binding");
  }
  const exactFields = hasExternalBinding
    ? [...baseFields, ...(isExternalAudit
      ? ["executor_kind", "mode", "reviewer_family", "primary_family", "reviewer_tool", "review_data_sha256", "issued_at"]
      : externalFields)]
    : hasV5Binding
      ? [...baseFields, ...v5Fields]
      : baseFields;
  if (hasLineageApproval) exactFields.push(...lineageApprovalFields);
  const actualFields = Object.keys(record).sort();
  if (JSON.stringify(actualFields) !== JSON.stringify([...exactFields].sort())) {
    throw collision("dispatch record must contain the exact canonical field set");
  }
  if (!/^[a-f0-9]{64}$/.test(String(record.packet_sha256 ?? ""))) {
    throw collision("packet_sha256 is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(String(record.carrier_root_id ?? ""))) {
    throw collision("carrier_root_id is invalid");
  }
  if (hasV5Binding) {
    if (!/^[a-f0-9]{64}$/.test(String(record.paged_full_material_sha256 ?? ""))) {
      throw collision("paged_full_material_sha256 is invalid");
    }
    const createdAtText = record.paged_full_material_created_at;
    const expiresAtText = record.paged_full_material_expires_at;
    const createdAt = Date.parse(createdAtText);
    const expiresAt = Date.parse(expiresAtText);
    if (!Number.isFinite(createdAt)
      || !Number.isFinite(expiresAt)
      || new Date(createdAt).toISOString() !== createdAtText
      || new Date(expiresAt).toISOString() !== expiresAtText
      || expiresAt - createdAt !== 7_200_000) {
      throw collision("paged full-material lifetime is invalid");
    }
  }
  if (hasExternalBinding) {
    if (record.executor_kind !== EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
      throw collision("executor_kind is invalid");
    }
    assertIdentityField(record.reviewer_family, "reviewer_family");
    assertIdentityField(record.primary_family, "primary_family");
    assertIdentityField(record.reviewer_tool, "reviewer_tool");
    if (isExternalAudit) {
      if (record.pr_number !== "none" || !/^[a-f0-9]{64}$/.test(String(record.review_data_sha256 ?? ""))) {
        throw collision("external audit dispatch requires pr_number none and its material digest");
      }
    } else {
      if (record.sticky_write_action !== "create" && record.sticky_write_action !== "update") {
        throw collision("sticky_write_action is invalid");
      }
      const targetCommentId = record.sticky_target_comment_id;
      if (record.sticky_write_action === "create") {
        if (targetCommentId !== null) {
          throw collision("sticky_target_comment_id must be null for a create disposition");
        }
      } else if (!Number.isSafeInteger(targetCommentId) || targetCommentId <= 0) {
        throw collision("sticky_target_comment_id must be a positive integer for an update disposition");
      }
      if (!/^[a-f0-9]{64}$/.test(String(record.sticky_snapshot_digest ?? ""))) {
        throw collision("sticky_snapshot_digest is invalid");
      }
    }
    const issuedAtText = record.issued_at;
    if (typeof issuedAtText !== "string"
      || Number.isNaN(Date.parse(issuedAtText))
      || new Date(issuedAtText).toISOString() !== issuedAtText) {
      throw collision("issued_at is invalid");
    }
  }
  if (hasLineageApproval) {
    const receipt = record.lineage_approval_receipt;
    const receiptFields = [
      "schema", "repository_slug", "pr_number", "source_state", "old_head_ref_oid", "new_head_ref_oid",
      "old_dispatch_id", "action", "approval_comment_id", "approval_comment_url", "approver_login",
      "author_association", "repository_permission", "created_at", "updated_at", "last_edited_at",
      "user_content_edits_count", "comment_body_sha256",
    ];
    if (typeof record.lineage_approval_receipt_id !== "string"
      || !/^[1-9][0-9]*$/.test(record.lineage_approval_receipt_id)
      || !receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...receiptFields].sort())
      || receipt.schema !== LINEAGE_APPROVAL_RECEIPT_SCHEMA
      || receipt.repository_slug !== record.repository_slug
      || receipt.pr_number !== record.pr_number
      || !new Set(["dispatch-marker", "clear-obligation"]).has(receipt.source_state)
      || receipt.new_head_ref_oid !== record.head_ref_oid
      || !/^[a-f0-9]{40}$/.test(receipt.old_head_ref_oid)
      || !/^[a-f0-9]{40}$/.test(receipt.new_head_ref_oid)
      || receipt.old_head_ref_oid === receipt.new_head_ref_oid
      || receipt.old_dispatch_id !== record.previous_dispatch_id
      || !new Set(["rebind", "clear"]).has(receipt.action)
      || receipt.approval_comment_id !== record.lineage_approval_receipt_id
      || receipt.approval_comment_url !== `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-${receipt.approval_comment_id}`
      || typeof receipt.approver_login !== "string" || receipt.approver_login.length === 0
      || !new Set(["OWNER", "MEMBER", "COLLABORATOR"]).has(receipt.author_association)
      || !new Set(["write", "maintain", "admin"]).has(receipt.repository_permission)
      || typeof receipt.created_at !== "string" || typeof receipt.updated_at !== "string"
      || receipt.created_at !== receipt.updated_at || receipt.last_edited_at !== null
      || !/^[a-f0-9]{64}$/.test(receipt.comment_body_sha256)
      || !Number.isSafeInteger(receipt.user_content_edits_count)
      || receipt.user_content_edits_count !== 0) {
      throw collision("lineage approval receipt does not match the immutable dispatch lineage");
    }
  }
  return record;
}

const IDENTITY_FIELDS = Object.freeze([
  "repository_slug",
  "pr_number",
  "head_ref_oid",
  "attempt_id",
  "dispatch_id",
  "previous_dispatch_id",
]);

function assertRecordIdentity(record, label) {
  for (const field of IDENTITY_FIELDS) {
    assertIdentityField(record[field], `${label}.${field}`, { nullable: field === "previous_dispatch_id" });
  }
  assertDispatchId(record.dispatch_id, `${label}.dispatch_id`);
  if (record.previous_dispatch_id === record.dispatch_id) {
    throw collision(`${label} lineage cannot refer to itself`);
  }
}

function assertExactIdentity(candidate, expected, label) {
  for (const field of IDENTITY_FIELDS) {
    if (candidate[field] !== expected[field]) {
      throw collision(`${label} ${field} binding mismatch`);
    }
  }
}

function canonicalBytes(record, maxBytes) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.length > maxBytes) {
    throw collision(`control evidence exceeds ${maxBytes} canonical bytes`);
  }
  return bytes;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function withIntegrity(record) {
  const { integrity_id: _ignored, ...identity } = record;
  return { ...identity, integrity_id: sha256(Buffer.from(JSON.stringify(identity), "utf8")) };
}

function assertIntegrityRecord(record, label) {
  assertPlainObject(record, label);
  assertRecordIdentity(record, label);
  if (!/^[a-f0-9]{64}$/.test(String(record.integrity_id ?? ""))) {
    throw collision(`${label} integrity_id is invalid`);
  }
  const expected = withIntegrity(record);
  if (JSON.stringify(expected) !== JSON.stringify(record)) {
    throw collision(`${label} integrity verification failed`);
  }
}

function assertInvocationClaim(record) {
  assertIntegrityRecord(record, "invocation claim");
  if (record.schema !== "devpro-second-review-dispatch-invocation/v1"
    || record.outcome !== "reviewer_invocation_claimed") {
    throw collision("invocation claim schema or outcome is invalid");
  }
}

export function canonicalInvocationClaimSha256(record) {
  assertInvocationClaim(record);
  return sha256(canonicalBytes(record, MAX_DISPATCH_BYTES));
}

function assertExactFieldSet(record, expectedFields, label) {
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...expectedFields].sort())) {
    throw collision(`${label} schema or exact canonical field set is invalid`);
  }
}

const RUNNER_STICKY_COMPLETION_BINDING = Object.freeze({
  verdicts: Object.freeze(["PASS", "WARN"]),
  processCloseObserved: true,
});
// D4 step 8 (R4, R13): external round-trip accepts all four verdicts and is
// never itself a `process_close_observed` runner lifecycle closure.
const EXTERNAL_STICKY_COMPLETION_BINDING = Object.freeze({
  verdicts: EXTERNAL_COMPLETION_VERDICTS,
  processCloseObserved: false,
});

// D4 step 8 (R4, R13): parameterized so the runner call site keeps its exact
// existing behavior (PASS|WARN, process_close_observed:true) while the
// external call site accepts all four verdicts and process_close_observed:false.
function assertStickyCompletionBinding(record, { verdicts, processCloseObserved }) {
  if (!verdicts.includes(record.sticky_verdict)
    || record.sticky_last_reviewed_sha !== record.head_ref_oid
    || record.sticky_dispatch_id !== record.dispatch_id
    || record.process_close_observed !== processCloseObserved) {
    throw collision("completion receipt terminal outcome or sticky binding is invalid");
  }
}

function assertStickyCommentIdentity(record) {
  const stickyCommentId = record.sticky_comment_id;
  const expectedStickyCommentUrl = Number.isSafeInteger(stickyCommentId)
    && stickyCommentId > 0
    ? `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-${stickyCommentId}`
    : null;
  if (expectedStickyCommentUrl === null
    || record.sticky_comment_url !== expectedStickyCommentUrl) {
    throw collision("completion receipt terminal outcome or sticky binding is invalid");
  }
}

function assertCompletionReceipt(record) {
  assertIntegrityRecord(record, "completion receipt");
  const legacyFields = [
    "schema",
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
    "outcome",
    "classification",
    "sticky_verdict",
    "sticky_last_reviewed_sha",
    "sticky_dispatch_id",
    "process_close_observed",
    "integrity_id",
  ];
  const stickyCurrentFields = [
    ...legacyFields.slice(0, -2),
    "sticky_comment_id",
    "sticky_comment_url",
    ...legacyFields.slice(-2),
  ];
  // D4 step 7 (R4): "existing stickyCurrentFields + sticky_body_sha256",
  // inserted alongside the other sticky_* content fields.
  const externalCompletionFields = [
    ...stickyCurrentFields.slice(0, -2),
    "sticky_body_sha256",
    ...stickyCurrentFields.slice(-2),
  ];
  if (record.schema === LEGACY_COMPLETION_SCHEMA) {
    assertExactFieldSet(record, legacyFields, "completion receipt");
    if (!isRunnerStickyCompletionOutcome(record)) {
      throw collision("completion receipt terminal outcome or sticky binding is invalid");
    }
    assertStickyCompletionBinding(record, RUNNER_STICKY_COMPLETION_BINDING);
    return;
  }
  if (record.schema === COMPLETION_SCHEMA && isAuditCompletionOutcome(record)) {
    assertExactFieldSet(record, AUDIT_COMPLETION_FIELDS, "completion receipt");
    if (hasStickyCompletionKeys(record)
      || record.pr_number !== "none"
      || record.process_close_observed !== true) {
      throw collision("completion receipt terminal outcome or sticky binding is invalid");
    }
    return;
  }
  if (record.schema === COMPLETION_SCHEMA && isExternalAuditCompletionOutcome(record)) {
    assertExactFieldSet(record, [
      ...EXTERNAL_AUDIT_RECEIPT_PAYLOAD_FIELDS, "outcome", "classification", "process_close_observed", "integrity_id",
    ], "external audit completion receipt");
    assertExternalAuditReceiptPayload(record);
    if (record.process_close_observed !== false) throw collision("external audit does not prove process close");
    return;
  }
  if (record.schema === COMPLETION_SCHEMA && isExternalCompletionOutcome(record)) {
    assertExactFieldSet(record, externalCompletionFields, "completion receipt");
    assertStickyCompletionBinding(record, EXTERNAL_STICKY_COMPLETION_BINDING);
    if (!/^[a-f0-9]{64}$/.test(String(record.sticky_body_sha256 ?? ""))) {
      throw collision("completion receipt terminal outcome or sticky binding is invalid");
    }
    assertStickyCommentIdentity(record);
    return;
  }
  if (record.schema === COMPLETION_SCHEMA && isRunnerStickyCompletionOutcome(record)) {
    assertExactFieldSet(record, stickyCurrentFields, "completion receipt");
    assertStickyCompletionBinding(record, RUNNER_STICKY_COMPLETION_BINDING);
    assertStickyCommentIdentity(record);
    return;
  }
  throw collision("completion receipt schema or exact canonical field set is invalid");
}

function assertTerminalReceipt(record) {
  assertIntegrityRecord(record, "terminal receipt");
  const exactFields = [
    "schema",
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
    "outcome_group",
    "classification",
    "responsibility",
    "created_at",
    "process_spawned",
    "lifecycle_phase",
    "process_close_observed",
    "transport_cleanup_confirmed",
    "invocation_claim_sha256",
    "integrity_id",
  ];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(exactFields.sort())) {
    throw collision("terminal receipt must contain the exact canonical field set");
  }
  const expectedOutcomeGroup = terminalReceiptOutcomeGroup(record.classification);
  const preSpawn = record.lifecycle_phase === "pre_spawn_known_terminal";
  // Both post-close phases describe the same closed lifecycle and carry the
  // same obligations below; they differ only in who observed the cleanup —
  // the runner that owned the spawn, or a later reconciliation of a runner
  // that died before it could.
  const postClose = record.lifecycle_phase === "post_close_transport_cleaned"
    || record.lifecycle_phase === "post_close_transport_reconciled";
  const hasCanonicalCreatedAt = typeof record.created_at === "string"
    && !Number.isNaN(Date.parse(record.created_at))
    && new Date(record.created_at).toISOString() === record.created_at;
  if (record.schema !== TERMINAL_RECEIPT_SCHEMA
    || expectedOutcomeGroup === null
    || record.outcome_group !== expectedOutcomeGroup
    || record.responsibility !== TERMINAL_RECEIPT_RESPONSIBILITY
    || !hasCanonicalCreatedAt
    || (!preSpawn && !postClose)) {
    throw collision("terminal receipt schema, outcome group, responsibility, or created time is invalid");
  }
  if (preSpawn) {
    if (!PRE_SPAWN_TERMINAL_CLASSIFICATIONS.has(record.classification)
      || record.process_spawned !== false
      || record.process_close_observed !== false
      || record.transport_cleanup_confirmed !== true
      || record.invocation_claim_sha256 !== null) {
      throw collision("terminal receipt pre-spawn lifecycle closure is invalid");
    }
    return;
  }
  if (PRE_SPAWN_TERMINAL_CLASSIFICATIONS.has(record.classification)
    || record.process_spawned !== true
    || record.process_close_observed !== true
    || record.transport_cleanup_confirmed !== true
    || !/^[a-f0-9]{64}$/.test(String(record.invocation_claim_sha256 ?? ""))) {
    throw collision("terminal receipt post-spawn lifecycle closure is invalid");
  }
}

function assertTerminalReceiptClaimBinding(record, invocationClaim, invocationClaimBytes = null) {
  if (record.lifecycle_phase === "pre_spawn_known_terminal") return;
  if (!invocationClaim) {
    throw collision("post-spawn terminal receipt requires an invocation claim");
  }
  const claimBytes = invocationClaimBytes
    ?? canonicalBytes(invocationClaim, MAX_DISPATCH_BYTES);
  if (record.invocation_claim_sha256 !== sha256(claimBytes)) {
    throw collision("terminal receipt invocation claim sha256 binding mismatch");
  }
}

function assertFaultCapsule(record) {
  assertIntegrityRecord(record, "fault capsule");
  if (record.schema !== FAULT_CAPSULE_SCHEMA
    || !CAPSULE_REQUIRED_CLASSIFICATIONS.has(record.classification)) {
    throw collision("fault capsule schema or classification is invalid");
  }
  if (record.responsibility !== ORCHESTRATION_RESPONSIBILITY) {
    throw collision("fault capsule responsibility is invalid");
  }
  if (typeof record.created_at !== "string"
    || Number.isNaN(Date.parse(record.created_at))
    || new Date(record.created_at).toISOString() !== record.created_at) {
    throw collision("fault capsule created_at is invalid");
  }
  for (const field of [
    "evidence_provenance",
    "evidence_confidence",
    "matcher_id",
    "denied_action_class",
  ]) {
    assertIdentityField(record[field], `fault capsule.${field}`);
  }
  if (typeof record.redacted_excerpt !== "string"
    || byteLength(record.redacted_excerpt) > MAX_REDACTED_EXCERPT_BYTES) {
    throw collision("fault capsule redacted_excerpt is invalid");
  }
}

function assertConsumptionReceipt(record) {
  assertIntegrityRecord(record, "consumption receipt");
  if (record.schema !== FAULT_CONSUMPTION_SCHEMA
    || record.outcome !== "blocked_orchestration_fault"
    || !CAPSULE_REQUIRED_CLASSIFICATIONS.has(record.classification)
    || record.responsibility !== ORCHESTRATION_RESPONSIBILITY
    || !/^[a-f0-9]{64}$/.test(String(record.capsule_integrity_id ?? ""))) {
    throw collision("consumption receipt schema, outcome, responsibility, or capsule binding is invalid");
  }
}

function assertSupersessionReceipt(record) {
  assertIntegrityRecord(record, "supersession receipt");
  assertDispatchId(record.fault_dispatch_id, "supersession receipt.fault_dispatch_id");
  assertDispatchId(record.verified_dispatch_id, "supersession receipt.verified_dispatch_id");
  if (record.schema !== FAULT_SUPERSESSION_SCHEMA
    || record.dispatch_id !== record.verified_dispatch_id
    || record.fault_dispatch_id === record.verified_dispatch_id
    || record.outcome !== `superseded_by_verified_dispatch:${record.verified_dispatch_id}`
    || !/^[a-f0-9]{64}$/.test(String(record.consumption_integrity_id ?? ""))) {
    throw collision("supersession receipt schema, lineage, outcome, or consumption binding is invalid");
  }
}

// D12/D13 (R5; strengthen-reviewer-model-selection T13/T14b): the reviewer-model-
// record's closed sets. `requested_kind`/`agreement` are validated here only for
// shape/membership — the judgment (which value a given dispatch actually earns)
// is computed once by the caller (D1's resolveSecondReviewerModel / D13's
// agreement derivation), never re-derived from family here (design.md D13:
// "MUST NOT 另起任何 family→kind 的推導").
const REVIEWER_MODEL_REQUESTED_SOURCES = Object.freeze(new Set([
  "built-in-default",
  "env-override",
]));
const REVIEWER_MODEL_REQUESTED_KINDS = Object.freeze(new Set([
  "alias",
  "exact-id",
  "unknown",
]));
const REVIEWER_MODEL_OBSERVED_SOURCES = Object.freeze(new Set([
  "execution-stream",
  "isolated-home-rollout",
  // OpenCode: providerID/modelID read from the dispatched session's own export, never from
  // the CLI name, flags, echoed text or a probe token.
  "session-export",
  "none",
]));
const REVIEWER_MODEL_OBSERVED_UNAVAILABLE_REASONS = Object.freeze(new Set([
  "rollout_not_found",
  "rollout_unparsable",
  "reviewer_home_not_isolated",
  "rollout_scan_budget_exceeded",
  "stream_identity_absent",
  "export_unavailable",
  "export_invalid",
  "none",
]));
const REVIEWER_MODEL_AGREEMENTS = Object.freeze(new Set([
  "exact",
  "divergent",
  "alias-expansion-expected",
  "differs-unverified",
  "unavailable",
]));

// D12: exact field set — 17 fields, order irrelevant to membership (canonical
// byte order is fixed by the writer's object literal, not by this list).
const REVIEWER_MODEL_RECORD_FIELDS = Object.freeze([
  "schema",
  "repository_slug",
  "pr_number",
  "head_ref_oid",
  "attempt_id",
  "dispatch_id",
  "previous_dispatch_id",
  // NOT `reviewer_family`: the dispatch record's field of that name carries the
  // DECLARED family (`openai-codex`, `gemini`, …), while this record needs the
  // CLI recipe family (`claude`/`codex`) that `requestedKindForSelection()`
  // derived `requested_kind` from. Two different value domains under one name in
  // the same dispatch directory is the r3 finding F-srms-pr3-04; the record is
  // write-once immutable, so the name is fixed here before any record exists.
  "reviewer_cli_family",
  "requested_model",
  "requested_source",
  "requested_source_env_var",
  "requested_kind",
  "observed_model",
  "observed_source",
  "observed_unavailable_reason",
  "agreement",
  "integrity_id",
]);

function assertReviewerModelRecord(record) {
  assertIntegrityRecord(record, "reviewer model record");
  assertExactFieldSet(record, REVIEWER_MODEL_RECORD_FIELDS, "reviewer model record");
  if (record.schema !== REVIEWER_MODEL_RECORD_SCHEMA) {
    throw collision("reviewer model record schema is invalid");
  }
  assertIdentityField(record.reviewer_cli_family, "reviewer model record.reviewer_cli_family");
  assertIdentityField(record.requested_model, "reviewer model record.requested_model");
  if (!REVIEWER_MODEL_REQUESTED_SOURCES.has(record.requested_source)) {
    throw collision("reviewer model record requested_source is invalid");
  }
  if (!REVIEWER_MODEL_REQUESTED_KINDS.has(record.requested_kind)) {
    throw collision("reviewer model record requested_kind is invalid");
  }
  // "none" sentinel (D12: same convention as pr_number's "none") for the field
  // that is not applicable when requested_source is built-in-default.
  assertIdentityField(record.requested_source_env_var, "reviewer model record.requested_source_env_var");
  if (record.requested_source === "built-in-default" && record.requested_source_env_var !== "none") {
    throw collision("reviewer model record requested_source_env_var must be \"none\" for a built-in default");
  }
  if (record.requested_source === "env-override" && record.requested_source_env_var === "none") {
    throw collision("reviewer model record requested_source_env_var is required for an env override");
  }
  assertIdentityField(record.observed_model, "reviewer model record.observed_model");
  if (!REVIEWER_MODEL_OBSERVED_SOURCES.has(record.observed_source)) {
    throw collision("reviewer model record observed_source is invalid");
  }
  if (!REVIEWER_MODEL_OBSERVED_UNAVAILABLE_REASONS.has(record.observed_unavailable_reason)) {
    throw collision("reviewer model record observed_unavailable_reason is invalid");
  }
  if (!REVIEWER_MODEL_AGREEMENTS.has(record.agreement)) {
    throw collision("reviewer model record agreement is invalid");
  }
  // D7/D13: observed unavailable and observed available are mutually exclusive
  // binding shapes — MUST NOT let requested/self-report stand in for observed
  // (D7 "MUST NOT 把 requested 或模型自報值寫進 observed 欄位").
  const observedUnavailable = record.observed_source === "none";
  if (observedUnavailable) {
    if (record.observed_model !== "none"
      || record.observed_unavailable_reason === "none"
      || record.agreement !== "unavailable") {
      throw collision("reviewer model record unavailable observed binding is invalid");
    }
  } else if (record.observed_model === "none"
    || record.observed_unavailable_reason !== "none"
    || record.agreement === "unavailable") {
    throw collision("reviewer model record available observed binding is invalid");
  }
}

const OPERATOR_ABANDONMENT_SLOT_FIELDS = Object.freeze([
  "schema",
  ...IDENTITY_FIELDS,
  "operator_login",
  "repository_permissions_push",
  "permission_source",
  "target_repository",
  "pr_state",
  "pr_merged",
  "base_repository",
  "head_repository",
  "head_ref",
  "remote_pr_head",
  "local_repository",
  "local_branch",
  "local_implementation_commit",
  "typed_confirmation",
  "runner_not_started",
  "authorization_checked_at",
  "created_at",
  "integrity_id",
]);
const OPERATOR_ABANDONMENT_STABLE_FIELDS = Object.freeze(
  OPERATOR_ABANDONMENT_SLOT_FIELDS.filter((field) => !new Set([
    "authorization_checked_at",
    "created_at",
    "integrity_id",
  ]).has(field))
);
const OPERATOR_ABANDONMENT_AUTHORIZATION_FIELDS = Object.freeze([
  "operator_login",
  "repository_permissions_push",
  "permission_source",
  "target_repository",
  "pr_number",
  "pr_state",
  "pr_merged",
  "base_repository",
  "head_repository",
  "head_ref",
  "remote_pr_head",
  "local_repository",
  "local_branch",
  "local_implementation_commit",
  "authorization_checked_at",
]);

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw collision(`${label} is invalid`);
  }
}

// This operator decision is deliberately separate from closed-terminal/v1:
// it withdraws review authority without asserting an unobserved process close.
const OPERATOR_DISPOSITION_FIELDS = Object.freeze([
  "schema", ...IDENTITY_FIELDS, "outcome", "dispatch_sha256", "invocation_claim_sha256",
  "lifecycle_slot_sha256", "packet_sha256", "carrier_root_id", "paged_full_material_sha256",
  "activity_prefix_length", "activity_prefix_sha256", "lock_snapshot_sha256",
  "marker_snapshot_sha256", "sticky_snapshot_sha256", "operator_login",
  "repository_permissions_push", "permission_source", "authorization_checked_at",
  "pr_state", "pr_merged", "remote_pr_head", "typed_confirmation", "reason", "created_at",
  "process_spawned", "process_close_observed", "transport_cleanup_confirmed", "scan_complete",
  "review_authority", "successor_policy", "integrity_id",
]);

export function interruptedDispatchConfirmation(dispatch) {
  return `ABANDON interrupted second-review dispatch ${dispatch.repository_slug}#${dispatch.pr_number} head ${dispatch.head_ref_oid} attempt ${dispatch.attempt_id} dispatch ${dispatch.dispatch_id} close_unobserved fresh-full-review-only`;
}

// One wording for every refusal an attempt without close evidence produces.
// The operator CLI still decides eligibility; this only names the way out.
export function interruptedDispatchRecoveryHint(attemptId) {
  return `next_step: once the runner for this attempt has stopped, run node .devpro/scripts/abandon-interrupted-second-review.mjs notes/cross-review/${attemptId}/observability-context.json --dry-run, get the user's explicit decision to abandon this attempt, rerun with the printed --confirm value plus --reason, then render a fresh full-pr review; the runner's --reconcile-* modes and close-stale-second-review-reservation.mjs do not apply to this attempt`;
}

function assertInterruptedDispatchDisposition(record) {
  assertIntegrityRecord(record, "operator disposition");
  assertExactFieldSet(record, OPERATOR_DISPOSITION_FIELDS, "operator disposition");
  if (record.schema !== OPERATOR_DISPOSITION_SCHEMA
    || record.outcome !== "operator_abandoned_interrupted_dispatch"
    || !isRealPrNumber(record.pr_number)
    || !HEX_SHA_CANONICAL.test(String(record.head_ref_oid))
    || typeof record.process_spawned !== "boolean" || record.process_close_observed !== false
    || record.transport_cleanup_confirmed !== false || record.scan_complete !== false
    || record.review_authority !== "none" || record.successor_policy !== "fresh-full-review-only"
    || record.repository_permissions_push !== true || record.permission_source !== "gh-api-repository"
    || record.pr_state !== "OPEN" || record.pr_merged !== false
    || !HEX_SHA_CANONICAL.test(String(record.remote_pr_head))
    || record.typed_confirmation !== interruptedDispatchConfirmation(record)) {
    throw collision("operator disposition does not match the interrupted-dispatch authority contract");
  }
  for (const field of ["dispatch_sha256", "packet_sha256", "carrier_root_id",
    "activity_prefix_sha256", "lock_snapshot_sha256", "marker_snapshot_sha256",
    "sticky_snapshot_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(String(record[field] ?? ""))) {
      throw collision(`operator disposition ${field} is invalid`);
    }
  }
  // A runner that died before claiming started nothing and left no claim or slot to pin.
  for (const field of ["invocation_claim_sha256", "lifecycle_slot_sha256"]) {
    if (record.process_spawned
      ? !/^[a-f0-9]{64}$/.test(String(record[field] ?? ""))
      : record[field] !== null) {
      throw collision(`operator disposition ${field} is invalid`);
    }
  }
  if (record.paged_full_material_sha256 !== null
    && !/^[a-f0-9]{64}$/.test(String(record.paged_full_material_sha256 ?? ""))) {
    throw collision("operator disposition paged_full_material_sha256 is invalid");
  }
  assertIdentityField(record.operator_login, "operator disposition.operator_login");
  if (!record.operator_login || !Number.isSafeInteger(record.activity_prefix_length)
    || record.activity_prefix_length <= 0
    || typeof record.reason !== "string" || !record.reason.trim()
    || Buffer.byteLength(record.reason, "utf8") > 1024) {
    throw collision("operator disposition requires a bounded reason, operator, and activity prefix");
  }
  assertCanonicalTimestamp(record.authorization_checked_at, "operator disposition authorization_checked_at");
  assertCanonicalTimestamp(record.created_at, "operator disposition created_at");
  if (Date.parse(record.authorization_checked_at) > Date.parse(record.created_at)) {
    throw collision("operator disposition predates its authorization check");
  }
}

function assertInterruptedDispositionInventory(directory, hasDisposition, claimed) {
  if (!lstatSync(directory).isDirectory()) throw collision("operator disposition dispatch directory is not a real directory");
  const expected = [DISPATCH_FILE,
    ...(claimed ? [INVOCATION_CLAIM_FILE, DISPATCH_LIFECYCLE_SLOT_FILE] : []),
    ...(hasDisposition ? [OPERATOR_DISPOSITION_FILE] : []),
    ...(lstatIfPresent(path.join(directory, USAGE_MANIFEST_FILE)) ? [USAGE_MANIFEST_FILE] : [])];
  assertOperatorDirectoryInventory(directory, expected);
  for (const name of expected) {
    if (!lstatSync(path.join(directory, name)).isFile()) {
      throw collision("operator disposition requires regular immutable evidence files");
    }
  }
}

function assertInterruptedDispositionBindings(record, evidence) {
  const { dispatch, invocationClaim, lifecycleSlot } = evidence;
  const claimed = record.process_spawned;
  if (!dispatch || isExternalDispatchRecord(dispatch)
    || (claimed
      ? !invocationClaim || lifecycleSlot?.record?.kind !== "runner_claimed"
      : invocationClaim || lifecycleSlot?.present)) {
    throw collision("operator disposition requires the original runner dispatch, with a claim and lifecycle slot exactly when a process was spawned");
  }
  assertExactIdentity(record, dispatch, "operator disposition");
  if (claimed) {
    assertExactIdentity(invocationClaim, dispatch, "operator disposition invocation claim");
    assertDispatchLifecycleSlot(lifecycleSlot.record, dispatch);
  }
  assertInterruptedDispositionInventory(evidence.directory, Boolean(evidence.operatorDisposition), claimed);
  for (const [field, expected] of [
    ["dispatch_sha256", sha256(canonicalBytes(dispatch, MAX_DISPATCH_BYTES))],
    ["invocation_claim_sha256", claimed ? sha256(canonicalBytes(invocationClaim, MAX_DISPATCH_BYTES)) : null],
    ["lifecycle_slot_sha256", claimed ? sha256(lifecycleSlot.bytes) : null],
    ["packet_sha256", dispatch.packet_sha256], ["carrier_root_id", dispatch.carrier_root_id],
    ["paged_full_material_sha256", dispatch.paged_full_material_sha256 ?? null],
  ]) {
    if (record[field] !== expected) throw collision(`operator disposition ${field} binding mismatch`);
  }
}

export async function writeInterruptedDispatchDisposition({ rootDir = controlEvidenceRoot(), record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    assertPlainObject(record, "operator disposition input");
    assertExactFieldSet(record, [...OPERATOR_DISPOSITION_FIELDS.filter((field) => field !== "integrity_id"),
      "activity_prefix_bytes"], "operator disposition input");
    const attempted = withIntegrity(Object.fromEntries(OPERATOR_DISPOSITION_FIELDS
      .filter((field) => field !== "integrity_id").map((field) => [field, record[field]])));
    assertInterruptedDispatchDisposition(attempted);
    if (!Buffer.isBuffer(record.activity_prefix_bytes)
      || record.activity_prefix_bytes.length !== attempted.activity_prefix_length
      || sha256(record.activity_prefix_bytes) !== attempted.activity_prefix_sha256) {
      throw collision("operator disposition activity prefix bytes do not match their pinned digest and length");
    }
    const evidence = readDispatchEvidenceStrict({ rootDir: lockedRoot, dispatchId: record.dispatch_id });
    assertInterruptedDispositionBindings(attempted, evidence);
    const bytes = canonicalBytes(attempted, MAX_OPERATOR_DISPOSITION_BYTES);
    if (evidence.totalBytes - (evidence.operatorDispositionBytes?.length ?? 0) + bytes.length > MAX_DISPATCH_EVIDENCE_BYTES) {
      throw collision("operator disposition exceeds the dispatch aggregate byte budget");
    }
    const status = publishImmutable(evidence.paths.operatorDisposition, bytes, { idempotent: true });
    return { status, path: evidence.paths.operatorDisposition, record: attempted };
  });
}

// A negative fence only: ordinary remote sticky authority does not acquire a
// new positive local-receipt requirement merely because this helper exists.
// Absence takes no lock: the gated writer runs in the reviewer sandbox, where this
// root is read-only, and the lock never spanned the GitHub write that follows.
// publishImmutable makes a disposition appear whole or not at all.
export function assertDispatchReviewAuthority({ rootDir = controlEvidenceRoot(), dispatchId,
  repositorySlug, prNumber, headRefOid }) {
  readRetirementManifest(rootDir);
  if (!lstatIfPresent(path.join(dispatchDir(rootDir, dispatchId), OPERATOR_DISPOSITION_FILE))) return { allowed: true };
  return withDispatchEvidenceSnapshot({ rootDir }, (root) => {
    const directory = dispatchDir(root, dispatchId);
    if (!lstatIfPresent(path.join(directory, OPERATOR_DISPOSITION_FILE))) return { allowed: true };
    const evidence = readDispatchEvidenceStrict({ rootDir: root, dispatchId });
    const disposition = evidence.operatorDisposition;
    if (!disposition || disposition.repository_slug !== repositorySlug
      || disposition.pr_number !== String(prNumber) || disposition.head_ref_oid !== headRefOid) {
      throw collision("operator disposition target identity does not match the review authority request");
    }
    throw collision(`dispatch ${dispatchId} has no review authority after operator disposition`);
  });
}

function assertOperatorAbandonmentSlot(record, dispatch = null) {
  assertIntegrityRecord(record, "operator-abandonment slot");
  assertExactFieldSet(record, OPERATOR_ABANDONMENT_SLOT_FIELDS, "operator-abandonment slot");
  assertIdentityField(record.operator_login, "operator-abandonment slot.operator_login");
  if (record.schema !== OPERATOR_ABANDONMENT_SLOT_SCHEMA
    || record.operator_login === ""
    || record.repository_permissions_push !== true
    || record.permission_source !== "gh-api-repository"
    || record.target_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || record.pr_number !== PR_2927_UNSTARTED_DISPATCH.pr_number
    || record.pr_state !== "OPEN"
    || record.pr_merged !== false
    || record.base_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || record.head_repository !== PR_2927_UNSTARTED_DISPATCH.source_repository
    || record.head_ref !== PR_2927_UNSTARTED_DISPATCH.source_ref
    || record.remote_pr_head !== PR_2927_UNSTARTED_DISPATCH.head_ref_oid
    || record.local_repository !== PR_2927_UNSTARTED_DISPATCH.source_repository
    || record.local_branch !== PR_2927_UNSTARTED_DISPATCH.source_ref
    || !HEX_SHA_CANONICAL.test(String(record.local_implementation_commit ?? ""))
    || record.typed_confirmation !== PR_2927_UNSTARTED_CONFIRMATION
    || record.runner_not_started !== true) {
    throw collision("operator-abandonment slot does not match the exact PR #2927 authority tuple");
  }
  assertCanonicalTimestamp(record.authorization_checked_at, "operator-abandonment slot authorization_checked_at");
  assertCanonicalTimestamp(record.created_at, "operator-abandonment slot created_at");
  if (dispatch) {
    for (const field of IDENTITY_FIELDS) {
      if (record[field] !== dispatch[field]) {
        throw collision(`operator-abandonment slot ${field} binding mismatch`);
      }
    }
  }
  for (const field of [
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
  ]) {
    if (record[field] !== PR_2927_UNSTARTED_DISPATCH[field]) {
      throw collision(`operator-abandonment slot ${field} is outside the one-dispatch allowlist`);
    }
  }
  if (dispatch?.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
    throw collision("external-evaluator dispatches cannot use operator abandonment");
  }
}

function buildOperatorAbandonmentSlot(dispatch, authorization, confirmation, {
  createdAt = new Date().toISOString(),
  authorizationCheckedAt = authorization.authorization_checked_at,
} = {}) {
  return withIntegrity({
    schema: OPERATOR_ABANDONMENT_SLOT_SCHEMA,
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, dispatch[field]])),
    operator_login: authorization.operator_login,
    repository_permissions_push: authorization.repository_permissions_push,
    permission_source: authorization.permission_source,
    target_repository: authorization.target_repository,
    pr_state: authorization.pr_state,
    pr_merged: authorization.pr_merged,
    base_repository: authorization.base_repository,
    head_repository: authorization.head_repository,
    head_ref: authorization.head_ref,
    remote_pr_head: authorization.remote_pr_head,
    local_repository: authorization.local_repository,
    local_branch: authorization.local_branch,
    local_implementation_commit: authorization.local_implementation_commit,
    typed_confirmation: confirmation,
    runner_not_started: true,
    authorization_checked_at: authorizationCheckedAt,
    created_at: createdAt,
  });
}

function operatorAbandonmentTerminal(dispatch, slot) {
  return withIntegrity({
    schema: TERMINAL_RECEIPT_SCHEMA,
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, dispatch[field]])),
    outcome_group: "operator_abandonment",
    classification: "operator_abandoned_pre_spawn",
    responsibility: TERMINAL_RECEIPT_RESPONSIBILITY,
    created_at: slot.created_at,
    process_spawned: false,
    lifecycle_phase: "pre_spawn_known_terminal",
    process_close_observed: false,
    transport_cleanup_confirmed: true,
    invocation_claim_sha256: null,
  });
}

function readOperatorAbandonmentSlot(directory, dispatchId) {
  const filePath = path.join(directory, OPERATOR_ABANDONMENT_SLOT_FILE);
  if (!existsSync(filePath)) {
    return { present: false, unparseable: false, record: null, bytes: null, path: filePath };
  }
  try {
    const size = statSync(filePath).size;
    if (size <= 0 || size > MAX_OPERATOR_ABANDONMENT_SLOT_BYTES) {
      throw collision("operator-abandonment slot exceeds its immutable evidence bound");
    }
    const bytes = readFileSync(filePath);
    const record = JSON.parse(bytes.toString("utf8"));
    assertOperatorAbandonmentSlot(record);
    if (record.dispatch_id !== dispatchId
      || !canonicalBytes(record, MAX_OPERATOR_ABANDONMENT_SLOT_BYTES).equals(bytes)) {
      throw collision("operator-abandonment slot is not canonical for its dispatch directory");
    }
    return { present: true, unparseable: false, record, bytes, path: filePath };
  } catch (error) {
    return { present: true, unparseable: true, record: null, bytes: null, path: filePath, error };
  }
}

const DISPATCH_LIFECYCLE_SLOT_FIELDS = Object.freeze([
  "schema",
  "kind",
  ...IDENTITY_FIELDS,
  "operator_login",
  "repository_permissions_push",
  "permission_source",
  "target_repository",
  "pr_state",
  "pr_merged",
  "base_repository",
  "base_ref",
  "head_repository",
  "head_ref",
  "reserved_head_ref_oid",
  "observed_head_ref_oid",
  "confirmation_source",
  "confirmation_challenge",
  "authorization_checked_at",
  "created_at",
  "integrity_id",
]);

const STALE_RESERVATION_AUTHORIZATION_FIELDS = Object.freeze([
  "operator_login",
  "repository_permissions_push",
  "permission_source",
  "target_repository",
  "pr_number",
  "pr_state",
  "pr_merged",
  "base_repository",
  "base_ref",
  "head_repository",
  "head_ref",
  "reserved_head_ref_oid",
  "observed_head_ref_oid",
  "confirmation_source",
  "authorization_checked_at",
]);

export function staleReservationConfirmationChallenge(dispatch, observedHead) {
  return `CLOSE stale second-review reservation ${dispatch.repository_slug}#${dispatch.pr_number} ${dispatch.dispatch_id} reserved=${dispatch.head_ref_oid} current=${observedHead} action=stale_reservation_closed`;
}

function assertStaleReservationAuthorization(dispatch, authorization, confirmation) {
  assertPlainObject(authorization, "stale-reservation authorization");
  assertExactFieldSet(authorization, STALE_RESERVATION_AUTHORIZATION_FIELDS, "stale-reservation authorization");
  for (const field of ["operator_login", "target_repository", "base_repository", "head_repository", "head_ref", "confirmation_source"]) {
    assertIdentityField(authorization[field], `stale-reservation authorization.${field}`);
  }
  if (authorization.operator_login === ""
    || authorization.repository_permissions_push !== true
    || authorization.permission_source !== "gh-api-repository"
    || authorization.target_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || authorization.pr_number !== PR_2927_UNSTARTED_DISPATCH.pr_number
    || authorization.pr_state !== "OPEN"
    || authorization.pr_merged !== false
    || authorization.base_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || authorization.base_ref !== "main"
    || authorization.head_repository !== PR_2927_UNSTARTED_DISPATCH.source_repository
    || authorization.head_ref !== PR_2927_UNSTARTED_DISPATCH.source_ref
    || authorization.reserved_head_ref_oid !== dispatch.head_ref_oid
    || !HEX_SHA_CANONICAL.test(String(authorization.observed_head_ref_oid ?? ""))
    || authorization.observed_head_ref_oid === dispatch.head_ref_oid
    || authorization.confirmation_source !== "interactive-tty") {
    throw collision("stale-reservation authorization does not match the open PR #2927 stale-head contract");
  }
  assertCanonicalTimestamp(authorization.authorization_checked_at, "stale-reservation authorization_checked_at");
  const expected = staleReservationConfirmationChallenge(dispatch, authorization.observed_head_ref_oid);
  if (confirmation !== expected) {
    throw collision("stale-reservation closure requires the exact operation-specific TTY challenge");
  }
}

function assertDispatchLifecycleSlot(record, dispatch = null) {
  assertIntegrityRecord(record, "dispatch lifecycle slot");
  assertExactFieldSet(record, DISPATCH_LIFECYCLE_SLOT_FIELDS, "dispatch lifecycle slot");
  if (record.schema !== DISPATCH_LIFECYCLE_SLOT_SCHEMA
    || !new Set(["runner_claimed", "stale_reservation_closed"]).has(record.kind)) {
    throw collision("dispatch lifecycle slot schema or kind is invalid");
  }
  assertCanonicalTimestamp(record.created_at, "dispatch lifecycle slot created_at");
  for (const field of IDENTITY_FIELDS) {
    if (dispatch && record[field] !== dispatch[field]) {
      throw collision(`dispatch lifecycle slot ${field} binding mismatch`);
    }
  }
  if (dispatch?.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
    throw collision("external-evaluator dispatches cannot use the runner lifecycle slot");
  }
  if (record.kind === "runner_claimed") {
    if (record.reserved_head_ref_oid !== record.head_ref_oid
      || record.observed_head_ref_oid !== null
      || record.operator_login !== null
      || record.repository_permissions_push !== null
      || record.permission_source !== null
      || record.target_repository !== null
      || record.pr_state !== null
      || record.pr_merged !== null
      || record.base_repository !== null
      || record.base_ref !== null
      || record.head_repository !== null
      || record.head_ref !== null
      || record.confirmation_source !== null
      || record.confirmation_challenge !== null
      || record.authorization_checked_at !== null) {
      throw collision("runner-claimed lifecycle slot contains stale-closure authority fields");
    }
    return;
  }
  assertIdentityField(record.operator_login, "dispatch lifecycle slot.operator_login");
  if (record.operator_login === ""
    || record.repository_permissions_push !== true
    || record.permission_source !== "gh-api-repository"
    || record.target_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || record.pr_number !== PR_2927_UNSTARTED_DISPATCH.pr_number
    || record.pr_state !== "OPEN"
    || record.pr_merged !== false
    || record.base_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || record.base_ref !== "main"
    || record.head_repository !== PR_2927_UNSTARTED_DISPATCH.source_repository
    || record.head_ref !== PR_2927_UNSTARTED_DISPATCH.source_ref
    || record.reserved_head_ref_oid !== record.head_ref_oid
    || !HEX_SHA_CANONICAL.test(String(record.observed_head_ref_oid ?? ""))
    || record.observed_head_ref_oid === record.reserved_head_ref_oid
    || record.confirmation_source !== "interactive-tty"
    || record.confirmation_challenge !== staleReservationConfirmationChallenge(record, record.observed_head_ref_oid)) {
    throw collision("stale-reservation lifecycle slot is outside the exact PR #2927 authority tuple");
  }
  assertCanonicalTimestamp(record.authorization_checked_at, "dispatch lifecycle slot authorization_checked_at");
  if (dispatch && dispatch.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
    throw collision("external-evaluator dispatches cannot be stale-reservation closed");
  }
}

function buildDispatchLifecycleSlot(dispatch, kind, authorization = null, confirmation = null, createdAt = new Date().toISOString()) {
  if (kind === "runner_claimed") {
    return withIntegrity({
      schema: DISPATCH_LIFECYCLE_SLOT_SCHEMA,
      kind,
      ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, dispatch[field]])),
      operator_login: null,
      repository_permissions_push: null,
      permission_source: null,
      target_repository: null,
      pr_state: null,
      pr_merged: null,
      base_repository: null,
      base_ref: null,
      head_repository: null,
      head_ref: null,
      reserved_head_ref_oid: dispatch.head_ref_oid,
      observed_head_ref_oid: null,
      confirmation_source: null,
      confirmation_challenge: null,
      authorization_checked_at: null,
      created_at: createdAt,
    });
  }
  return withIntegrity({
    schema: DISPATCH_LIFECYCLE_SLOT_SCHEMA,
    kind,
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, dispatch[field]])),
    operator_login: authorization.operator_login,
    repository_permissions_push: authorization.repository_permissions_push,
    permission_source: authorization.permission_source,
    target_repository: authorization.target_repository,
    pr_state: authorization.pr_state,
    pr_merged: authorization.pr_merged,
    base_repository: authorization.base_repository,
    base_ref: authorization.base_ref,
    head_repository: authorization.head_repository,
    head_ref: authorization.head_ref,
    reserved_head_ref_oid: authorization.reserved_head_ref_oid,
    observed_head_ref_oid: authorization.observed_head_ref_oid,
    confirmation_source: authorization.confirmation_source,
    confirmation_challenge: confirmation,
    authorization_checked_at: authorization.authorization_checked_at,
    created_at: createdAt,
  });
}

function staleReservationClosedTerminal(dispatch, slot) {
  return withIntegrity({
    schema: TERMINAL_RECEIPT_SCHEMA,
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, dispatch[field]])),
    outcome_group: "stale_reservation_closure",
    classification: "stale_reservation_closed_pre_spawn",
    responsibility: TERMINAL_RECEIPT_RESPONSIBILITY,
    created_at: slot.created_at,
    process_spawned: false,
    lifecycle_phase: "pre_spawn_known_terminal",
    process_close_observed: false,
    transport_cleanup_confirmed: true,
    invocation_claim_sha256: null,
  });
}

function readDispatchLifecycleSlot(directory, dispatchId) {
  const filePath = path.join(directory, DISPATCH_LIFECYCLE_SLOT_FILE);
  if (!existsSync(filePath)) {
    return { present: false, unparseable: false, record: null, bytes: null, path: filePath };
  }
  try {
    const size = statSync(filePath).size;
    if (size <= 0 || size > MAX_DISPATCH_LIFECYCLE_SLOT_BYTES) {
      throw collision("dispatch lifecycle slot exceeds its immutable evidence bound");
    }
    const bytes = readFileSync(filePath);
    const record = JSON.parse(bytes.toString("utf8"));
    assertDispatchLifecycleSlot(record);
    if (record.dispatch_id !== dispatchId
      || !canonicalBytes(record, MAX_DISPATCH_LIFECYCLE_SLOT_BYTES).equals(bytes)) {
      throw collision("dispatch lifecycle slot is not canonical for its dispatch directory");
    }
    return { present: true, unparseable: false, record, bytes, path: filePath };
  } catch (error) {
    return { present: true, unparseable: true, record: null, bytes: null, path: filePath, error };
  }
}

function dispatchDir(rootDir, dispatchId) {
  assertDispatchId(dispatchId);
  return path.join(path.resolve(rootDir), dispatchId);
}

function lstatIfPresent(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Create missing directory segments with best-effort mode intent.
 *
 * Support matrix (win32 paged sticky / private carrier — P1–P3 named alternative):
 * - Publish intent remains mode 0700/0600 on every platform (mkdir/open flags).
 * - On win32, POSIX mode bits cannot materialize as ACL; confidentiality is
 *   P1 same-host principal + P2 trusted parent / carrier_root_id location +
 *   P3 outside reviewer-writable roots — not icacls, not "paged unsupported".
 * - When `trustedParent` is set (P2): fail-fast if `directory` is outside that
 *   root, or if neither the trusted parent nor its immediate parent exists.
 * - Do not fail solely because observed mode bits differ from POSIX intent on win32.
 *
 * @param {string} directory
 * @param {number} [mode=0o700]
 * @param {{ trustedParent?: string|null }} [options]
 */
export function ensureDurableDirectory(directory, mode = 0o700, options = {}) {
  const resolved = path.resolve(directory);
  const trustedParent =
    typeof options?.trustedParent === "string" && options.trustedParent.length > 0
      ? path.resolve(options.trustedParent)
      : null;
  if (trustedParent) {
    const rel = path.relative(trustedParent, resolved);
    const insideOrEqual =
      rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (!insideOrEqual) {
      throw collision(
        "durable directory is outside trusted parent; publish under notes/cross-review " +
          "(renderer-owned carrier root), then re-render"
      );
    }
    const trustedStat = lstatIfPresent(trustedParent);
    if (!trustedStat?.isDirectory()) {
      const notesParent = path.dirname(trustedParent);
      const notesStat = lstatIfPresent(notesParent);
      if (notesParent === trustedParent || !notesStat?.isDirectory()) {
        throw collision(
          "trusted parent missing; create the renderer-owned notes/cross-review parent first, then re-render"
        );
      }
    }
  }
  const missing = [];
  let cursor = resolved;
  let stat = lstatIfPresent(cursor);
  while (stat === null) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw collision(
        "durable directory has no existing ancestor (trusted parent missing); " +
          "create the renderer-owned notes/cross-review parent first, then re-render"
      );
    }
    cursor = parent;
    stat = lstatIfPresent(cursor);
  }
  if (!stat.isDirectory()) throw collision("durable directory ancestor is not a directory");
  for (const target of missing.reverse()) {
    mkdirSync(target, { mode });
    fsyncDirectory(path.dirname(target));
  }
  return resolved;
}

function publishImmutable(finalPath, bytes, { idempotent = true, checkpoint = null } = {}) {
  const directory = path.dirname(finalPath);
  const tempPath = path.join(directory, `.${path.basename(finalPath)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, bytes);
    retirementCheckpoint(checkpoint, "manifest-temp-written", {});
    fsyncSync(fd);
    retirementCheckpoint(checkpoint, "manifest-temp-fsynced", {});
    closeSync(fd);
    fd = undefined;
    try {
      // A same-directory hard link publishes a fully flushed final without an overwrite primitive.
      linkSync(tempPath, finalPath);
      retirementCheckpoint(checkpoint, "manifest-linked", {});
      fsyncDirectory(directory);
      retirementCheckpoint(checkpoint, "manifest-root-fsynced", {});
      return "created";
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readFileSync(finalPath);
      if (idempotent && existing.equals(bytes)) return "idempotent";
      throw collision(`immutable control evidence collision at ${path.basename(finalPath)}`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function sameFieldSet(record, fields) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...fields].sort());
}

function assertExternalAuditReceiptPayload(payload, dispatch = null) {
  if (payload.pr_number !== "none"
    || !/^[a-f0-9]{64}$/.test(String(payload.review_data_sha256 ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(payload.audit_report_sha256 ?? ""))
    || !EXTERNAL_COMPLETION_VERDICTS.includes(payload.audit_verdict)) {
    throw collision("external audit receipt material, report, or verdict is invalid");
  }
  assertIdentityField(payload.reviewer_tool, "external audit reviewer_tool");
  assertIdentityField(payload.reviewer_model, "external audit reviewer_model");
  if (dispatch && (dispatch.mode !== "audit-only"
    || payload.review_data_sha256 !== dispatch.review_data_sha256
    || payload.reviewer_tool !== dispatch.reviewer_tool)) {
    throw collision("external audit receipt does not match its dispatch");
  }
}

function assertExternalClosureReceiptPayloadShape(payload, dispatch) {
  const isAudit = dispatch.mode === "audit-only";
  if (!sameFieldSet(payload, isAudit ? EXTERNAL_AUDIT_RECEIPT_PAYLOAD_FIELDS : EXTERNAL_CLOSURE_RECEIPT_PAYLOAD_FIELDS)) {
    throw collision("external closure receipt payload must contain the exact canonical field set");
  }
  if (payload.schema !== COMPLETION_SCHEMA) {
    throw collision("external closure receipt payload schema is invalid");
  }
  assertExactIdentity(payload, dispatch, "external closure receipt payload");
  if (isAudit) {
    assertExternalAuditReceiptPayload(payload, dispatch);
    return;
  }
  assertStickyCompletionBinding(
    { ...payload, process_close_observed: false },
    EXTERNAL_STICKY_COMPLETION_BINDING
  );
  if (!/^[a-f0-9]{64}$/.test(String(payload.sticky_body_sha256 ?? ""))) {
    throw collision("external closure receipt payload sticky_body_sha256 is invalid");
  }
  assertStickyCommentIdentity(payload);
}

// D4 step 5 (R4, R13): the stable fields two accept-vs-void racers (or two
// same-kind reruns on different clocks) must agree on before either adopts
// the other's slot. `closed_at` is intentionally excluded — it is the slot's
// sole time authority and MUST NOT gate whether a rerun is "the same" closure.
function externalClosureStableFields(record) {
  if (record.kind === "accepted") {
    return {
      schema: record.schema,
      dispatch_id: record.dispatch_id,
      kind: record.kind,
      receipt_payload: record.receipt_payload,
    };
  }
  return {
    schema: record.schema,
    dispatch_id: record.dispatch_id,
    kind: record.kind,
  };
}

// Raw reader: never throws on a missing or unparseable slot. Strictness is
// readDispatchEvidenceStrict's job (D4 step 9); this primitive is shared by
// writers (assertExternalSlotOwnership) that must not be blocked by
// `external_closure_incomplete` while they are still assembling evidence.
function readExternalClosureSlot(directory, dispatchId) {
  const slotPath = path.join(directory, EXTERNAL_CLOSURE_SLOT_FILE);
  if (!existsSync(slotPath)) {
    return { present: false, record: null, bytes: null, unparseable: false, path: slotPath };
  }
  let size;
  try {
    size = statSync(slotPath).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { present: false, record: null, bytes: null, unparseable: false, path: slotPath };
    }
    throw error;
  }
  if (size <= 0 || size > MAX_EXTERNAL_CLOSURE_SLOT_BYTES) {
    return { present: true, record: null, bytes: null, unparseable: true, path: slotPath };
  }
  const bytes = readFileSync(slotPath);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { present: true, record: null, bytes, unparseable: true, path: slotPath };
  }
  const hasCanonicalClosedAt = typeof record?.closed_at === "string"
    && !Number.isNaN(Date.parse(record.closed_at))
    && new Date(record.closed_at).toISOString() === record.closed_at;
  const kindValid = record?.kind === "accepted" || record?.kind === "voided";
  const shapeValid = kindValid && (record.kind === "accepted"
    ? sameFieldSet(record, ["schema", "dispatch_id", "kind", "receipt_payload", "closed_at"])
    : sameFieldSet(record, ["schema", "dispatch_id", "kind", "closed_at"]));
  if (!shapeValid
    || record.schema !== EXTERNAL_CLOSURE_SLOT_SCHEMA
    || record.dispatch_id !== dispatchId
    || !hasCanonicalClosedAt
    || !canonicalBytes(record, MAX_EXTERNAL_CLOSURE_SLOT_BYTES).equals(bytes)) {
    return { present: true, record: null, bytes, unparseable: true, path: slotPath };
  }
  return { present: true, record, bytes, unparseable: false, path: slotPath };
}

/**
 * D4 step 5 / D5 (R4, R5, R13): exclusively publish the closure slot with the
 * same temp `openSync(…,"wx")` + `linkSync(temp, final)` shape as
 * publishImmutable, but with EEXIST reconciliation compared on *stable*
 * fields (excluding closed_at) rather than full byte equality — a same-kind
 * rerun on a different clock must still adopt the already-published
 * `closed_at` and report byte-identical output, and an opposite-kind racer
 * must fail closed as `external_dispatch_closed`, not a generic collision.
 * `renameSync` is deliberately never used here: it would silently overwrite
 * an existing slot instead of exposing the create-exclusive race (D4 step 5,
 * decisions.md D-SLOT-PUBLISH).
 */
function publishExternalClosureSlot({ directory, dispatchId, kind, receiptPayload, closedAt }) {
  const finalPath = path.join(directory, EXTERNAL_CLOSURE_SLOT_FILE);
  const attempt = kind === "accepted"
    ? {
      schema: EXTERNAL_CLOSURE_SLOT_SCHEMA,
      dispatch_id: dispatchId,
      kind,
      receipt_payload: receiptPayload,
      closed_at: closedAt,
    }
    : {
      schema: EXTERNAL_CLOSURE_SLOT_SCHEMA,
      dispatch_id: dispatchId,
      kind,
      closed_at: closedAt,
    };
  const bytes = canonicalBytes(attempt, MAX_EXTERNAL_CLOSURE_SLOT_BYTES);
  const tempPath = path.join(directory, `.${EXTERNAL_CLOSURE_SLOT_FILE}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tempPath, finalPath);
      fsyncDirectory(directory);
      return { status: "created", path: finalPath, record: attempt };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const slot = readExternalClosureSlot(directory, dispatchId);
      if (!slot.present || slot.unparseable || !slot.record) {
        throw externalClosureIncompleteError("external closure slot could not be verified during publication");
      }
      if (slot.record.kind !== kind) {
        const closedError = new Error(
          `external dispatch closure already holds the "${slot.record.kind}" disposition`
        );
        closedError.classification = "external_dispatch_closed";
        throw closedError;
      }
      const attemptedStable = JSON.stringify(externalClosureStableFields(attempt));
      const existingStable = JSON.stringify(externalClosureStableFields(slot.record));
      if (attemptedStable !== existingStable) {
        throw collision("external closure slot collision");
      }
      return { status: "idempotent", path: finalPath, record: slot.record };
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function acquireCapacityLockForTest(rootDir, options = {}) {
  return acquireCapacityLock(rootDir, options);
}

function existingDispatchRecords(rootDir) {
  const records = [];
  const retirement = readRetirementManifest(rootDir);
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const retiringMember = retirement?.members.find((member) => member.dispatch_id === entry.name);
    if (retiringMember) {
      verifyRetirementMember(rootDir, retiringMember);
      // Exact-inventory verification is the only fence bypass. Its identity is
      // used solely for existing capacity buckets, never as acceptable evidence.
      // The pinned reservation attributes original bytes/buckets while this
      // directory remains visible, even after recovery unlinks dispatch.json.
      records.push({ record: retiringMember.reservation, bytes: retiringMember.files.reduce((sum, file) => sum + file.size, 0) });
      continue;
    }
    const recordPath = path.join(rootDir, entry.name, DISPATCH_FILE);
    if (!existsSync(recordPath)) {
      throw capacityError("dispatch capacity scan found an incomplete evidence directory");
    }
    try {
      const evidence = readDispatchEvidence({ rootDir, dispatchId: entry.name });
      records.push({ record: evidence.dispatch, bytes: evidence.totalBytes });
    } catch (error) {
      if (String(error?.classification ?? "").includes("capacity")) throw error;
      records.push(identityOnlyCapacityEntry(rootDir, entry.name));
    }
  }
  return records;
}

// The capacity scan only counts dispatches per repository and PR/head, so it needs a
// dispatch's identity and size, not a fully valid lifecycle. A receipt this reader cannot
// parse (for example one written by a newer tool sharing the root) must not stop every
// other reservation; the dispatch is still counted through its identity file. Strict
// per-dispatch reads stay fail-closed, and an unreadable identity file still stops the scan
// because the dispatch could not be attributed to any repository or PR.
function identityOnlyCapacityEntry(rootDir, dispatchId) {
  let record;
  let bytes;
  try {
    record = readCanonicalDispatchReservation(rootDir, dispatchId);
    const directory = dispatchDir(rootDir, dispatchId);
    bytes = readdirSync(directory, { withFileTypes: true })
      .filter((file) => file.isFile() && !file.name.startsWith("."))
      .reduce((sum, file) => sum + statSync(path.join(directory, file.name)).size, 0);
  } catch {
    throw capacityError("dispatch capacity scan found invalid immutable evidence");
  }
  return { record, bytes };
}

function assertReservationCapacity(rootDir, record) {
  const records = existingDispatchRecords(rootDir);
  const repositoryRecords = records.filter(
    (candidate) => candidate.record.repository_slug === record.repository_slug
  );
  const repositoryBytes = repositoryRecords.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (repositoryRecords.length >= MAX_DISPATCHES_PER_REPOSITORY) {
    throw capacityError(`repository dispatch capacity is ${MAX_DISPATCHES_PER_REPOSITORY}`);
  }
  if (repositoryBytes > MAX_BYTES_PER_REPOSITORY) {
    throw capacityError(`repository evidence byte capacity is ${MAX_BYTES_PER_REPOSITORY}`);
  }
  if (!prHeadCapacityApplies(record)) return;
  const key = prHeadBucketKey(record);
  const prHeadRecords = repositoryRecords.filter(
    (candidate) => prHeadCapacityApplies(candidate.record)
      && prHeadBucketKey(candidate.record) === key
  );
  const prHeadBytes = prHeadRecords.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (prHeadRecords.length >= MAX_DISPATCHES_PER_PR_HEAD) {
    throw capacityError(`PR/head dispatch capacity is ${MAX_DISPATCHES_PER_PR_HEAD}`);
  }
  if (prHeadBytes > MAX_BYTES_PER_PR_HEAD) {
    throw capacityError(`PR/head evidence byte capacity is ${MAX_BYTES_PER_PR_HEAD}`);
  }
}

// Lifecycle writers serialize on the repository capacity lock and strictly re-read the one
// dispatch they change. Ordinary lifecycle reads/writes do not scan unrelated dispatches:
// residue must not stop a different dispatch's claim, terminal, completion or rollback.
// Reservation scans capacity; cleanup scans the complete bounded dependency inventory
// and fails closed on unknown residue before granting directory deletion authority.
// A lock failure is still typed before any artifact write.
// Reentrancy is synchronous and scoped to this process; no promise may escape a snapshot.
const evidenceLockDepth = new Map();
function acquireEvidenceLock(rootDir) {
  const root = path.resolve(rootDir);
  const depth = evidenceLockDepth.get(root) ?? 0;
  const release = depth === 0 ? acquireCapacityLock(root) : null;
  evidenceLockDepth.set(root, depth + 1);
  return () => {
    if (depth === 0) evidenceLockDepth.delete(root);
    else evidenceLockDepth.set(root, depth);
    release?.();
  };
}

export function withDispatchEvidenceSnapshot({ rootDir = controlEvidenceRoot() }, operation) {
  if (typeof operation !== "function" || operation.constructor?.name === "AsyncFunction") {
    throw collision("dispatch evidence snapshot requires a local synchronous callback");
  }
  const root = path.resolve(rootDir);
  // Absent roots contain no authority; avoid creating evidence merely to diagnose it.
  const release = existsSync(root) ? acquireEvidenceLock(root) : () => {};
  try {
    readRetirementManifest(root);
    const result = operation(root);
    if (result && typeof result.then === "function") throw collision("dispatch evidence snapshot callback must not return a promise");
    return result;
  } finally { release(); }
}

export function assertDispatchEvidenceAvailable({ rootDir = controlEvidenceRoot(), dispatchId }) {
  return withDispatchEvidenceSnapshot({ rootDir }, (root) => assertRetirementFence(root, dispatchId));
}

function withLifecycleLock(rootDir, operation) {
  const resolvedRoot = ensureDurableDirectory(rootDir, 0o700);
  const releaseCapacityLock = acquireEvidenceLock(resolvedRoot);
  try {
    return operation(resolvedRoot);
  } finally {
    releaseCapacityLock();
  }
}

function assertNoOperatorAbandonment(evidence, operation) {
  if (evidence?.operatorDisposition) {
    throw collision(`${operation} cannot publish after an interrupted-dispatch operator disposition exists`);
  }
  if (evidence?.operatorAbandonment?.present) {
    throw collision(`${operation} cannot publish after an operator-abandonment slot exists`);
  }
  if (evidence?.lifecycleSlot?.present
    && (evidence.lifecycleSlot.unparseable || !evidence.lifecycleSlot.record)) {
    throw collision(`${operation} cannot publish with a malformed dispatch lifecycle slot`);
  }
  if (evidence?.lifecycleSlot?.record?.kind === "stale_reservation_closed") {
    throw collision(`${operation} cannot publish after a stale-reservation lifecycle slot exists`);
  }
}

function readCanonicalEvidenceRecord({ rootDir, dispatchId, fileName, maxBytes, validate }) {
  const filePath = path.join(dispatchDir(rootDir, dispatchId), fileName);
  if (!existsSync(filePath)) return null;
  const size = statSync(filePath).size;
  if (size <= 0 || size > maxBytes) {
    throw collision(`${fileName} exceeds its immutable evidence bound`);
  }
  const bytes = readFileSync(filePath);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw collision(`${fileName} is not valid JSON`);
  }
  validate(record);
  if (!canonicalBytes(record, maxBytes).equals(bytes)) {
    throw collision(`${fileName} is not canonical immutable evidence`);
  }
  return record;
}

function readDirectPredecessorEvidence(rootDir, record) {
  assertRetirementFence(rootDir, record.previous_dispatch_id);
  const dispatch = readCanonicalDispatchReservation(rootDir, record.previous_dispatch_id);
  const invocationClaim = readCanonicalEvidenceRecord({
    rootDir,
    dispatchId: dispatch.dispatch_id,
    fileName: INVOCATION_CLAIM_FILE,
    maxBytes: MAX_DISPATCH_BYTES,
    validate: assertInvocationClaim,
  });
  const completion = readCanonicalEvidenceRecord({
    rootDir,
    dispatchId: dispatch.dispatch_id,
    fileName: COMPLETION_RECEIPT_FILE,
    maxBytes: MAX_DISPATCH_BYTES,
    validate: assertCompletionReceipt,
  });
  const terminal = readCanonicalEvidenceRecord({
    rootDir,
    dispatchId: dispatch.dispatch_id,
    fileName: TERMINAL_RECEIPT_FILE,
    maxBytes: MAX_DISPATCH_BYTES,
    validate: assertTerminalReceipt,
  });
  const capsule = readCanonicalEvidenceRecord({
    rootDir,
    dispatchId: dispatch.dispatch_id,
    fileName: FAULT_CAPSULE_FILE,
    maxBytes: MAX_CAPSULE_BYTES,
    validate: assertFaultCapsule,
  });
  const consumption = readCanonicalEvidenceRecord({
    rootDir,
    dispatchId: dispatch.dispatch_id,
    fileName: CONSUMPTION_RECEIPT_FILE,
    maxBytes: MAX_DISPATCH_BYTES,
    validate: assertConsumptionReceipt,
  });
  const operatorAbandonment = readOperatorAbandonmentSlot(
    dispatchDir(rootDir, dispatch.dispatch_id),
    dispatch.dispatch_id,
  );
  const lifecycleSlot = readDispatchLifecycleSlot(
    dispatchDir(rootDir, dispatch.dispatch_id),
    dispatch.dispatch_id,
  );
  const dispositionPath = path.join(dispatchDir(rootDir, dispatch.dispatch_id), OPERATOR_DISPOSITION_FILE);
  const dispositionStat = lstatIfPresent(dispositionPath);
  if (dispositionStat && !dispositionStat.isFile()) throw collision("operator disposition must be a regular immutable file");
  const operatorDisposition = readCanonicalEvidenceRecord({
    rootDir, dispatchId: dispatch.dispatch_id, fileName: OPERATOR_DISPOSITION_FILE,
    maxBytes: MAX_OPERATOR_DISPOSITION_BYTES, validate: assertInterruptedDispatchDisposition,
  });
  if (operatorDisposition) {
    assertInterruptedDispositionBindings(operatorDisposition, {
      directory: dispatchDir(rootDir, dispatch.dispatch_id), dispatch, invocationClaim, lifecycleSlot, operatorDisposition,
    });
  }
  if (lifecycleSlot.present && (lifecycleSlot.unparseable || !lifecycleSlot.record)) {
    throw collision("predecessor dispatch lifecycle slot is malformed or unreadable");
  }
  if (lifecycleSlot.record) assertDispatchLifecycleSlot(lifecycleSlot.record, dispatch);
  for (const [label, candidate] of [
    ["invocation claim", invocationClaim],
    ["completion receipt", completion],
    ["terminal receipt", terminal],
    ["fault capsule", capsule],
    ["consumption receipt", consumption],
  ]) {
    if (candidate) assertExactIdentity(candidate, dispatch, label);
  }
  // D4 step 9 (R4, R7, R13; primary-review r2 F-aeesr-r2-07): an
  // external-evaluator predecessor's completion is TL-accepted, not
  // runner-claimed — its closure authority is the closure slot (verified
  // when the receipt itself was written), not an invocation claim. Runner
  // predecessors keep this exact requirement and message. As in
  // readDispatchEvidence above, the exemption requires BOTH the completion's
  // own outcome/classification AND the predecessor dispatch itself to be
  // external.
  const isExternalPredecessor = isExternalDispatchRecord(dispatch);
  if (completion && !invocationClaim && !(isExternalPredecessor && isAnyExternalCompletionOutcome(completion))) {
    throw collision("predecessor completion evidence requires an invocation claim");
  }
  // F-aeesr-r2-07: this reader otherwise never touches the closure slot at
  // all — a hand-authored (or corrupted) completion/terminal receipt filed
  // under an external predecessor must not lineage-chain as if TL had
  // actually accepted/voided it just because the receipt's own shape looks
  // right. Require the slot to exist AND hold the kind that matches which
  // receipt is present.
  if (isExternalPredecessor && (completion || terminal)) {
    const slot = readExternalClosureSlot(dispatchDir(rootDir, dispatch.dispatch_id), dispatch.dispatch_id);
    if (!slot.present || slot.unparseable || !slot.record) {
      throw collision("external predecessor completion or terminal evidence requires its closure slot to exist");
    }
    if (completion && slot.record.kind !== "accepted") {
      throw collision("external predecessor completion evidence requires an accepted closure slot");
    }
    if (terminal && slot.record.kind !== "voided") {
      throw collision("external predecessor terminal evidence requires a voided closure slot");
    }
    assertExternalReceiptsMatchSlot(dispatch, slot.record, completion, terminal);
  }
  if (terminal) assertTerminalReceiptClaimBinding(terminal, invocationClaim);
  if ((completion && (terminal || capsule || consumption))
    || (terminal && (capsule || consumption))) {
    throw collision("predecessor completion, terminal receipt, and fault evidence are mutually exclusive");
  }
  if (capsule && consumption
    && (consumption.capsule_integrity_id !== capsule.integrity_id
      || consumption.classification !== capsule.classification
      || consumption.responsibility !== capsule.responsibility)) {
    throw collision("predecessor consumption is not bound to its immutable fault capsule");
  }
  assertOperatorAbandonmentClosure({
    directory: dispatchDir(rootDir, dispatch.dispatch_id),
    dispatch,
    invocationClaim,
    completion,
    terminal,
    capsule,
    consumption,
    operatorAbandonment,
  });
  assertDispatchLifecycleClosure({
    directory: dispatchDir(rootDir, dispatch.dispatch_id),
    dispatch,
    invocationClaim,
    completion,
    terminal,
    capsule,
    consumption,
    lifecycleSlot,
  });
  return { dispatch, invocationClaim, completion, terminal, capsule, consumption, operatorAbandonment, lifecycleSlot, operatorDisposition };
}

function assertDirectPredecessor(rootDir, record) {
  if (record.previous_dispatch_id === null) return;
  // Read only the immutable records needed to validate this edge. Calling the
  // aggregate reader here would recursively validate a predecessor's
  // supersession receipt, which itself walks this lineage.
  const predecessor = readDirectPredecessorEvidence(rootDir, record);
  for (const field of ["repository_slug", "pr_number"]) {
    if (predecessor.dispatch[field] !== record[field]) {
      throw collision(`direct predecessor ${field} binding mismatch`);
    }
  }
  if (predecessor.dispatch.attempt_id === record.attempt_id) {
    throw collision("direct predecessor attempt_id must be fresh");
  }
  if (isRealPrNumber(record.pr_number) && predecessor.completion
    && !isStickyCompletionOutcome(predecessor.completion)) {
    throw collision("real-PR successor requires sticky completion predecessor");
  }
  if (predecessor.dispatch.head_ref_oid === record.head_ref_oid) {
    return;
  }
  if (!predecessor.consumption && !predecessor.completion && !predecessor.terminal && !predecessor.operatorDisposition) {
    throw collision("cross-head direct predecessor must have a consumed orchestration fault, successful completion receipt, or closed terminal receipt");
  }
}

// Only a new reservation gets this message: the renderer surfaces nothing but
// error.message, and owner cleanup removes whole directories without a
// tombstone, so the message has to name every possible cause and the next
// step. A missing ancestor never grants permission to bypass a pending marker
// or an existing lineage obligation.
function assertPredecessorReservationPresent(rootDir, record) {
  if (record.previous_dispatch_id === null) return;
  const filePath = path.join(dispatchDir(rootDir, record.previous_dispatch_id), DISPATCH_FILE);
  if (existsSync(filePath)) return;
  const ttlHours = COMPLETE_CHAIN_OWNER_TTL_MS / 3_600_000;
  // Same presence test as controlEvidenceRoot's `??`: an empty value is set.
  const envOverride = process.env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR !== undefined ? "set" : "unset";
  throw collision(
    `predecessor_reservation_missing: successor dispatch ${record.dispatch_id}, direct predecessor dispatch ${record.previous_dispatch_id} `
      + `has no reservation under control-evidence root ${rootDir}; it was reclaimed after the `
      + `${ttlHours}h owner TTL, was never reserved (or was rolled back by a failed render), `
      + "or was reserved under a different control-evidence root "
      + `(DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR is ${envOverride}, or a render from another clone); `
      + "previous_dispatch_id names the direct predecessor; next step: confirm the control-evidence root, "
      + "restore exact original immutable predecessor evidence, then rerun. If an ancestor cannot be restored, "
      + "preserve the pending marker and escalate to TL; do not omit a required ancestor. "
      + "Only a new lineage with no pending marker or ancestor obligation may omit previous_dispatch_id."
  );
}

function requireMatchingReservation(rootDir, record) {
  assertSecondReviewDispatchRecord({ ...record, schema: DISPATCH_SCHEMA });
  const evidence = readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
  if (!evidence.dispatch) throw collision("renderer dispatch reservation is missing");
  const expected = canonicalBytes({ ...record, schema: DISPATCH_SCHEMA }, MAX_DISPATCH_BYTES);
  if (!evidence.dispatchBytes.equals(expected)) {
    throw collision("runner dispatch bindings do not exactly match the renderer reservation");
  }
  return evidence;
}

export function verifyDispatchReservation({ rootDir = controlEvidenceRoot(), record }) {
  const evidence = requireMatchingReservation(path.resolve(rootDir), record);
  return {
    status: "verified",
    record: evidence.dispatch,
  };
}

/**
 * Verify the immutable dispatch identity before a trusted packet authorizer reads
 * any renderer-private v5 carrier. The caller can derive the base record from
 * public packet/context bytes, while the persisted reservation remains the sole
 * authority for the renderer-private v5 binding fields.
 */
export function verifySecondReviewDispatchIdentity(input) {
  return withDispatchEvidenceSnapshot({ rootDir: input.rootDir ?? controlEvidenceRoot() }, (rootDir) => verifySecondReviewDispatchIdentityLocked({ ...input, rootDir }));
}

function verifySecondReviewDispatchIdentityLocked({
  rootDir = controlEvidenceRoot(),
  record,
  requirePagedBinding = false,
}) {
  assertSecondReviewDispatchRecord(record);
  const persisted = readCanonicalDispatchReservation(
    path.resolve(rootDir),
    record.dispatch_id,
  );
  const expectedBaseFields = [
    "schema",
    "repository_slug",
    "pr_number",
    "head_ref_oid",
    "attempt_id",
    "dispatch_id",
    "previous_dispatch_id",
    "packet_sha256",
    "carrier_root_id",
  ];
  for (const field of expectedBaseFields) {
    if (persisted[field] !== record[field]) {
      throw collision(`trusted dispatch ${field} binding mismatch`);
    }
  }
  const hasPagedBinding = Object.hasOwn(persisted, "paged_full_material_sha256");
  if (hasPagedBinding !== requirePagedBinding) {
    throw collision("trusted dispatch schema binding mismatch");
  }
  return {
    status: "verified",
    record: persisted,
  };
}

function boundedExcerpt(value) {
  const text = String(value ?? "")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s"']+[\\/])*[^\s"']+/g, "[redacted-path]")
    .replace(/(?:token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_REDACTED_EXCERPT_BYTES) return text;
  return bytes.subarray(0, MAX_REDACTED_EXCERPT_BYTES).toString("utf8").replace(/\uFFFD$/u, "");
}

function boundedUtf8(value, maxBytes, fallback) {
  const text = String(value ?? fallback);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function readCanonicalDispatchReservation(rootDir, dispatchId) {
  assertRetirementFence(rootDir, dispatchId);
  const filePath = path.join(dispatchDir(rootDir, dispatchId), DISPATCH_FILE);
  if (!existsSync(filePath)) {
    throw collision("dispatch lineage reservation is missing");
  }
  const size = statSync(filePath).size;
  if (size <= 0 || size > MAX_DISPATCH_BYTES) {
    throw collision("dispatch lineage reservation exceeds its immutable evidence bound");
  }
  const bytes = readFileSync(filePath);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw collision("dispatch lineage reservation is not valid JSON");
  }
  assertSecondReviewDispatchRecord(record);
  if (record.dispatch_id !== dispatchId) {
    throw collision("dispatch lineage directory identity does not match its reservation");
  }
  if (!canonicalBytes(record, MAX_DISPATCH_BYTES).equals(bytes)) {
    throw collision("dispatch lineage reservation is not canonical immutable evidence");
  }
  return record;
}

function assertDispatchAncestor({ rootDir, successor, ancestorDispatchId }) {
  assertDispatchId(ancestorDispatchId, "ancestor dispatch_id");
  const visited = new Set();
  let current = successor;
  for (let depth = 0; depth < MAX_DISPATCHES_PER_PR_LINEAGE; depth += 1) {
    if (visited.has(current.dispatch_id)) {
      throw collision("dispatch lineage contains a cycle");
    }
    visited.add(current.dispatch_id);
    for (const field of ["repository_slug", "pr_number"]) {
      if (current[field] !== successor[field]) {
        throw collision(`dispatch lineage ${field} binding mismatch`);
      }
    }
    if (current.dispatch_id === ancestorDispatchId) return current;
    if (current.previous_dispatch_id === null) {
      throw collision("fault dispatch is not an ancestor of the verified dispatch");
    }
    assertDirectPredecessor(rootDir, current);
    current = readCanonicalDispatchReservation(rootDir, current.previous_dispatch_id);
  }
  throw collision("dispatch lineage exceeds its bounded ancestor walk");
}

export function controlEvidenceRoot(env = process.env, cwd = process.cwd()) {
  if (
    env.DEVPRO_REQUIRE_ISOLATED_CONTROL_EVIDENCE === "1"
    && !env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR
  ) {
    throw new Error(
      "DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR is required when DEVPRO_REQUIRE_ISOLATED_CONTROL_EVIDENCE=1"
    );
  }
  return path.resolve(
    env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR
      ?? defaultRepoStateDir("devpro-second-review-control-evidence", cwd)
  );
}

export function secondReviewDispatchRecord({ context, packetBytes }) {
  assertPlainObject(context, "observability context");
  const packet = Buffer.isBuffer(packetBytes) ? packetBytes : Buffer.from(packetBytes, "utf8");
  const record = {
    schema: DISPATCH_SCHEMA,
    repository_slug: context.repository_slug,
    pr_number: context.pr_number,
    head_ref_oid: context.head_ref_oid,
    attempt_id: context.attempt_id,
    dispatch_id: context.dispatch_id,
    previous_dispatch_id: context.previous_dispatch_id,
    packet_sha256: sha256(packet),
    // The dispatch record store itself still lives under the reviewer-writable root, so
    // absolute carrier paths recorded here would re-disclose the very location the
    // carrier relocation moved out of reach. The digest keeps the host-side binding —
    // a known root can be verified — without handing the reviewer the path.
    carrier_root_id: sha256(
      Buffer.from(path.dirname(context.observability_context_path), "utf8")
    ),
  };
  if (context.__paged_full_pages_carrier !== undefined) {
    const carrier = context.__paged_full_pages_carrier;
    record.paged_full_material_sha256 = sha256(
      Buffer.from(`${JSON.stringify(carrier)}\n`, "utf8")
    );
    record.paged_full_material_created_at = carrier.created_at;
    record.paged_full_material_expires_at = carrier.expires_at;
  }
  // D1 (R1, R4): additive external fields. Only assigned inside this branch —
  // assigning `undefined` on the runner path would still add an own key and
  // break assertSecondReviewDispatchRecord's exact-field-set check even
  // though JSON.stringify drops it (same pattern as __paged_full_pages_carrier
  // above).
  if (context.executor_kind !== undefined) {
    record.executor_kind = context.executor_kind;
    record.reviewer_family = context.reviewer_family;
    record.primary_family = context.primary_family;
    record.reviewer_tool = context.reviewer_tool;
    if (context.mode === "audit-only") {
      record.mode = "audit-only";
      record.review_data_sha256 = context.review_data_sha256;
    } else {
      record.sticky_write_action = context.sticky_write_action;
      record.sticky_target_comment_id = context.sticky_target_comment_id;
      record.sticky_snapshot_digest = context.sticky_snapshot_digest;
    }
    record.issued_at = context.issued_at;
  }
  if (context.lineage_approval_receipt !== undefined) {
    record.lineage_approval_receipt_id = context.lineage_approval_receipt.approval_comment_id;
    record.lineage_approval_receipt = context.lineage_approval_receipt;
  }
  return record;
}

const SECOND_REVIEW_DISPATCH_BASE_FIELDS = Object.freeze([
  "schema",
  "repository_slug",
  "pr_number",
  "head_ref_oid",
  "attempt_id",
  "dispatch_id",
  "previous_dispatch_id",
  "packet_sha256",
  "carrier_root_id",
]);

export function secondReviewDispatchBaseRecord(record) {
  assertSecondReviewDispatchRecord(record);
  return Object.fromEntries(SECOND_REVIEW_DISPATCH_BASE_FIELDS.map((field) => [field, record[field]]));
}

export async function reserveDispatchRecord({ rootDir = controlEvidenceRoot(), record, predecessorMarker = null }) {
  assertSecondReviewDispatchRecord(record);
  assertPersistedHeadRefOid(record.head_ref_oid);
  const resolvedRoot = ensureDurableDirectory(rootDir, 0o700);
  const directory = dispatchDir(resolvedRoot, record.dispatch_id);
  const finalPath = path.join(directory, DISPATCH_FILE);
  const bytes = canonicalBytes(record, MAX_DISPATCH_BYTES);
  const releaseCapacityLock = acquireEvidenceLock(resolvedRoot);
  try {
    assertRetirementFence(resolvedRoot, record.dispatch_id);
    // Historical reservations retain the existing direct-predecessor contract.
    // A pending plan adds an ancestor membership fence, not a new closure requirement.
    if (readRetirementManifest(resolvedRoot)) assertReservationAncestorsAvailable(resolvedRoot, record);
    assertPredecessorReservationPresent(resolvedRoot, record);
    assertDirectPredecessor(resolvedRoot, record);
    if (existsSync(finalPath)) {
      return {
        status: publishImmutable(finalPath, bytes, { idempotent: true }),
        path: finalPath,
        record,
      };
    }
    if (existsSync(directory)) {
      throw collision("dispatch evidence directory exists without a matching reservation");
    }
    assertCrossHeadMarkerWitness(resolvedRoot, record, predecessorMarker);
    assertReservationCapacity(resolvedRoot, record);

    let directoryCreated = false;
    try {
      mkdirSync(directory, { mode: 0o700 });
      directoryCreated = true;
      fsyncDirectory(resolvedRoot);
      const status = publishImmutable(finalPath, bytes, { idempotent: true });
      return { status, path: finalPath, record };
    } catch (error) {
      if (directoryCreated && !existsSync(finalPath)) {
        rmSync(directory, { recursive: true, force: true });
        fsyncDirectory(resolvedRoot);
      }
      throw error;
    }
  } finally {
    releaseCapacityLock();
  }
}

export function listConsumedLineageApprovalIds({ rootDir = controlEvidenceRoot() } = {}) {
  return withDispatchEvidenceSnapshot({ rootDir }, (root) => listConsumedLineageApprovalIdsLocked(root));
}

function listConsumedLineageApprovalIdsLocked(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  let entries;
  try { entries = readdirSync(resolvedRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  const consumed = new Set();
  const dispatchDirectories = entries.filter((entry) => entry.name.startsWith("dispatch-") && entry.isDirectory());
  if (dispatchDirectories.length > MAX_DISPATCHES_PER_REPOSITORY) {
    throw collision("lineage approval receipt scan exceeds its bound");
  }
  for (const entry of dispatchDirectories) {
    const directory = path.join(resolvedRoot, entry.name);
    const dispatchPath = path.join(directory, DISPATCH_FILE);
    let bytes;
    try { bytes = readFileSync(dispatchPath); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    let record;
    try { record = JSON.parse(bytes.toString("utf8")); } catch {
      throw collision("lineage approval receipt scan encountered malformed dispatch evidence");
    }
    if (record?.lineage_approval_receipt_id !== undefined) {
      if (typeof record.lineage_approval_receipt_id !== "string"
        || !/^[1-9][0-9]*$/.test(record.lineage_approval_receipt_id)) {
        throw collision("lineage approval receipt scan found an invalid consumed id");
      }
      consumed.add(record.lineage_approval_receipt_id);
    }
  }
  return consumed;
}

export function assertLineageApprovalNotConsumed({ rootDir = controlEvidenceRoot(), approvalCommentId }) {
  if (typeof approvalCommentId !== "string" || !/^[1-9][0-9]*$/.test(approvalCommentId)) {
    throw collision("lineage approval comment id is invalid");
  }
  if (listConsumedLineageApprovalIds({ rootDir }).has(approvalCommentId)) {
    throw collision("lineage approval comment id was already consumed by a dispatch reservation");
  }
  return { consumed: false };
}

export function writeLineageApprovalTransactionAbort(input) {
  return withLifecycleLock(input.rootDir ?? controlEvidenceRoot(), (rootDir) => writeLineageApprovalTransactionAbortLocked({ ...input, rootDir }));
}

function writeLineageApprovalTransactionAbortLocked({ rootDir = controlEvidenceRoot(), record, transactionId, reason }) {
  assertSecondReviewDispatchRecord(record);
  const evidence = readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
  if (!record.lineage_approval_receipt_id || !evidence.dispatchBytes
    || !canonicalBytes(record, MAX_DISPATCH_BYTES).equals(evidence.dispatchBytes)
    || evidence.invocationClaim || evidence.completion || evidence.terminal
    || evidence.capsule || evidence.consumption || evidence.supersession) {
    throw collision("lineage approval abort receipt requires the exact unclaimed renderer reservation");
  }
  const receipt = withIntegrity({
    schema: "devpro-second-review-lineage-transaction/v1",
    state: "aborted",
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    source_state: record.lineage_approval_receipt.source_state,
    old_head_ref_oid: record.lineage_approval_receipt.old_head_ref_oid,
    new_head_ref_oid: record.lineage_approval_receipt.new_head_ref_oid,
    old_dispatch_id: record.lineage_approval_receipt.old_dispatch_id,
    action: record.lineage_approval_receipt.action,
    approval_comment_id: record.lineage_approval_receipt_id,
    dispatch_id: record.dispatch_id,
    transaction_id: String(transactionId || ""),
    reason: String(reason || "publication could not be reconciled"),
    created_at: new Date().toISOString(),
  });
  const target = path.join(dispatchDir(path.resolve(rootDir), record.dispatch_id), LINEAGE_APPROVAL_TRANSACTION_FILE);
  if (existsSync(target)) {
    let existing;
    try { existing = JSON.parse(readFileSync(target, "utf8")); } catch {
      throw collision("lineage approval abort receipt already exists but is unreadable");
    }
    if (existing?.schema !== receipt.schema
      || existing.state !== "aborted"
      || existing.approval_comment_id !== receipt.approval_comment_id
      || existing.dispatch_id !== receipt.dispatch_id
      || existing.transaction_id !== receipt.transaction_id
      || existing.repository_slug !== receipt.repository_slug
      || existing.pr_number !== receipt.pr_number) {
      throw collision("lineage approval abort receipt conflicts with this transaction");
    }
    return { status: "already-published", path: target, record: existing };
  }
  const status = publishImmutable(target, canonicalBytes(receipt, MAX_CAPSULE_BYTES), { idempotent: true });
  return { status, path: target, record: receipt };
}

export function rollbackUnclaimedDispatchReservation({
  rootDir = controlEvidenceRoot(),
  record,
  beforeRollback = null,
}) {
  assertSecondReviewDispatchRecord(record);
  const resolvedRoot = path.resolve(rootDir);
  const directory = dispatchDir(resolvedRoot, record.dispatch_id);

  const releaseCapacityLock = acquireEvidenceLock(resolvedRoot);
  try {
    assertRetirementFence(resolvedRoot, record.dispatch_id);
    const directoryStat = lstatIfPresent(directory);
    if (directoryStat === null) {
      if (typeof beforeRollback === "function") beforeRollback({ reservationPresent: false });
      return { status: "already-absent", dispatch_id: record.dispatch_id };
    }
    if (!directoryStat.isDirectory()) {
      throw collision("rollback reservation path is not an exact dispatch directory");
    }
    const evidence = readDispatchEvidence({ rootDir: resolvedRoot, dispatchId: record.dispatch_id });
    const expected = canonicalBytes(record, MAX_DISPATCH_BYTES);
    if (!evidence.dispatchBytes?.equals(expected)) {
      throw collision("rollback reservation does not exactly match the renderer-owned dispatch");
    }
    if (record.lineage_approval_receipt_id !== undefined) {
      throw collision("consumed lineage approval reservation cannot be rolled back automatically");
    }
    if (evidence.invocationClaim
      || evidence.completion
      || evidence.terminal
      || evidence.capsule
      || evidence.consumption
      || evidence.supersession) {
      throw collision("invoked or terminal dispatch evidence cannot be rolled back");
    }
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length !== 1
      || !entries[0].isFile()
      || entries[0].name !== DISPATCH_FILE) {
      throw collision("rollback requires an exact unpublished dispatch-only directory");
    }
    if (typeof beforeRollback === "function") beforeRollback({ reservationPresent: true });
    rmSync(directory, { recursive: true, force: false });
    fsyncDirectory(resolvedRoot);
    return { status: "rolled-back", dispatch_id: record.dispatch_id };
  } finally {
    releaseCapacityLock();
  }
}

export function readDispatchEvidence({ rootDir = controlEvidenceRoot(), dispatchId }) {
  return withDispatchEvidenceSnapshot({ rootDir }, (root) => readDispatchEvidenceLocked({ rootDir: root, dispatchId }));
}

function readDispatchEvidenceLocked({ rootDir, dispatchId }) {
  assertRetirementFence(rootDir, dispatchId);
  const directory = dispatchDir(rootDir, dispatchId);
  const read = (name, maxBytes, validate) => {
    const filePath = path.join(directory, name);
    if (!existsSync(filePath)) return { record: null, bytes: null, path: filePath };
    const size = statSync(filePath).size;
    if (size <= 0 || size > maxBytes) {
      throw collision(`${name} exceeds its immutable evidence bound`);
    }
    const bytes = readFileSync(filePath);
    let record;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw collision(`${name} is not valid JSON`);
    }
    validate(record);
    if (!canonicalBytes(record, maxBytes).equals(bytes)) {
      throw collision(`${name} is not canonical immutable evidence`);
    }
    return { record, bytes, path: filePath };
  };
  const entries = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
    : [];
  const evidenceFiles = entries.filter((entry) => entry.isFile() && !entry.name.startsWith("."));
  if (evidenceFiles.length > MAX_EVIDENCE_FILES) {
    throw collision("dispatch evidence directory contains too many files");
  }
  const dispatch = read(DISPATCH_FILE, MAX_DISPATCH_BYTES, assertDispatchRecord);
  const invocationClaim = read(INVOCATION_CLAIM_FILE, MAX_DISPATCH_BYTES, assertInvocationClaim);
  const completion = read(COMPLETION_RECEIPT_FILE, MAX_DISPATCH_BYTES, assertCompletionReceipt);
  const terminal = read(TERMINAL_RECEIPT_FILE, MAX_DISPATCH_BYTES, assertTerminalReceipt);
  const capsule = read(FAULT_CAPSULE_FILE, MAX_CAPSULE_BYTES, assertFaultCapsule);
  const consumption = read(CONSUMPTION_RECEIPT_FILE, MAX_DISPATCH_BYTES, assertConsumptionReceipt);
  const supersession = read(SUPERSESSION_RECEIPT_FILE, MAX_DISPATCH_BYTES, assertSupersessionReceipt);
  // D12 (R5; strengthen-reviewer-model-selection T13): the 8th named read. Absent
  // file reads back as { record: null, bytes: null, path } exactly like every
  // other named read above — a dispatch directory written before this change
  // (or a pre-spawn terminal that never spawns a process) has no reviewer model
  // record and MUST remain readable (zero dual-read, design.md D12/D11).
  const reviewerModelRecord = read(REVIEWER_MODEL_RECORD_FILE, MAX_DISPATCH_BYTES, assertReviewerModelRecord);
  // D4/D5 (R4, R5, R13): raw slot read. Never throws on a missing/unparseable
  // slot — this reader is on the writer path (existingDispatchRecords/capacity
  // scan, assertExternalSlotOwnership) and must not fail-closed the whole
  // repository the way readDispatchEvidenceStrict is allowed to.
  const externalClosure = readExternalClosureSlot(directory, dispatchId);
  // D5/R2: expose a malformed operator slot to raw callers as incomplete
  // evidence; strict lifecycle readers reject it before it can close a head.
  const operatorAbandonment = readOperatorAbandonmentSlot(directory, dispatchId);
  const lifecycleSlot = readDispatchLifecycleSlot(directory, dispatchId);
  const dispositionStat = lstatIfPresent(path.join(directory, OPERATOR_DISPOSITION_FILE));
  if (dispositionStat && !dispositionStat.isFile()) throw collision("operator disposition must be a regular immutable file");
  const operatorDisposition = read(OPERATOR_DISPOSITION_FILE, MAX_OPERATOR_DISPOSITION_BYTES, assertInterruptedDispatchDisposition);
  if (operatorDisposition.record) {
    assertInterruptedDispositionBindings(operatorDisposition.record, {
      directory, dispatch: dispatch.record, invocationClaim: invocationClaim.record,
      lifecycleSlot, operatorDisposition: operatorDisposition.record,
    });
  }

  if (dispatch.record && dispatch.record.dispatch_id !== dispatchId) {
    throw collision("dispatch directory identity does not match its immutable reservation");
  }
  for (const [label, candidate] of [
    ["invocation claim", invocationClaim.record],
    ["completion receipt", completion.record],
    ["terminal receipt", terminal.record],
    ["fault capsule", capsule.record],
    ["consumption receipt", consumption.record],
    ["reviewer model record", reviewerModelRecord.record],
  ]) {
    if (!candidate) continue;
    if (!dispatch.record) throw collision(`${label} exists without a dispatch reservation`);
    assertExactIdentity(candidate, dispatch.record, label);
  }
  if (externalClosure.present && !dispatch.record) {
    throw collision("external closure slot exists without a dispatch reservation");
  }
  if (externalClosure.record && !isExternalDispatchRecord(dispatch.record)) {
    throw collision("external closure slot exists without an external dispatch reservation");
  }
  if (operatorAbandonment.present && !dispatch.record) {
    throw collision("operator-abandonment slot exists without a dispatch reservation");
  }
  if (lifecycleSlot.present && !dispatch.record) {
    throw collision("dispatch lifecycle slot exists without a dispatch reservation");
  }
  if (operatorAbandonment.record) {
    assertOperatorAbandonmentSlot(operatorAbandonment.record, dispatch.record);
  }
  if (lifecycleSlot.record) {
    assertDispatchLifecycleSlot(lifecycleSlot.record, dispatch.record);
  }
  // D4 step 9 (R4, R13; primary-review r2 F-aeesr-r2-07): external
  // completion/terminal evidence never carries an invocation claim (runner
  // path keeps its exact requirement/message), but it MUST be backed by its
  // closure slot — a receipt without a resolvable slot is not
  // raw-consistent evidence, even for a raw reader. The exemption requires
  // BOTH the completion's own outcome/classification AND the dispatch it is
  // filed under to actually be external — keying off outcome alone would let
  // an external-outcome-shaped completion hand-planted under a runner
  // (non-external) dispatch directory be silently treated as closed.
  if (completion.record
    && !invocationClaim.record
    && !(isExternalDispatchRecord(dispatch.record) && isAnyExternalCompletionOutcome(completion.record))) {
    throw collision("completion receipt requires an invocation claim");
  }
  if (isExternalDispatchRecord(dispatch.record)
    && (completion.record || terminal.record)
    && (!externalClosure.present || externalClosure.unparseable || !externalClosure.record)) {
    throw collision("external completion or terminal evidence requires its closure slot to exist");
  }
  if (terminal.record) {
    assertTerminalReceiptClaimBinding(
      terminal.record,
      invocationClaim.record,
      invocationClaim.bytes
    );
  }
  if ((completion.record && (terminal.record || capsule.record || consumption.record))
    || (terminal.record && (capsule.record || consumption.record))) {
    throw collision("completion, terminal, and fault evidence are mutually exclusive");
  }
  if (consumption.record) {
    if (capsule.record
      && (consumption.record.capsule_integrity_id !== capsule.record.integrity_id
        || consumption.record.classification !== capsule.record.classification
        || consumption.record.responsibility !== capsule.record.responsibility)) {
      throw collision("consumption receipt is not bound to the verified immutable fault capsule");
    }
  }
  if (supersession.record) {
    if (!consumption.record
      || supersession.record.fault_dispatch_id !== dispatchId
      || supersession.record.consumption_integrity_id !== consumption.record.integrity_id) {
      throw collision("supersession receipt is not bound to the verified consumed fault");
    }
    const successor = readCanonicalDispatchReservation(
      rootDir,
      supersession.record.verified_dispatch_id
    );
    assertExactIdentity(supersession.record, successor, "supersession successor");
    assertDispatchAncestor({ rootDir, successor, ancestorDispatchId: dispatchId });
  }
  const totalBytes = [
    dispatch, invocationClaim, completion, terminal, capsule, consumption, supersession, reviewerModelRecord, operatorDisposition,
  ]
    .reduce((sum, item) => sum + (item.bytes?.length ?? 0), 0)
    + (externalClosure.bytes?.length ?? 0)
    + (operatorAbandonment.bytes?.length ?? 0)
    + (lifecycleSlot.bytes?.length ?? 0);
  if (totalBytes > MAX_DISPATCH_EVIDENCE_BYTES) {
    throw collision("dispatch evidence exceeds its aggregate byte budget");
  }
  return {
    directory,
    dispatch: dispatch.record,
    dispatchBytes: dispatch.bytes,
    invocationClaim: invocationClaim.record,
    invocationClaimBytes: invocationClaim.bytes,
    completion: completion.record,
    terminal: terminal.record,
    capsule: capsule.record,
    consumption: consumption.record,
    supersession: supersession.record,
    reviewerModelRecord: reviewerModelRecord.record,
    operatorDisposition: operatorDisposition.record,
    operatorDispositionBytes: operatorDisposition.bytes,
    externalClosure: externalClosure.record,
    operatorAbandonment,
    lifecycleSlot,
    totalBytes,
    paths: {
      dispatch: dispatch.path,
      invocationClaim: invocationClaim.path,
      completion: completion.path,
      terminal: terminal.path,
      capsule: capsule.path,
      consumption: consumption.path,
      supersession: supersession.path,
      reviewerModelRecord: reviewerModelRecord.path,
      externalClosure: externalClosure.path,
      operatorAbandonment: operatorAbandonment.path,
      lifecycleSlot: lifecycleSlot.path,
      operatorDisposition: operatorDisposition.path,
    },
  };
}

export async function claimDispatchInvocation({ rootDir = controlEvidenceRoot(), record }) {
  const resolvedRoot = path.resolve(rootDir);
  return withLifecycleLock(resolvedRoot, (lockedRoot) => {
    const evidence = requireMatchingReservation(lockedRoot, record);
    assertNoOperatorAbandonment(evidence, "invocation claim");
    if (evidence.invocationClaim || evidence.terminal || evidence.capsule || evidence.consumption || evidence.supersession) {
      throw collision("invocation claim cannot be appended after terminal or fault evidence");
    }
    const lifecycleSlot = evidence.lifecycleSlot;
    if (lifecycleSlot.present && (lifecycleSlot.unparseable || !lifecycleSlot.record)) {
      throw collision("invocation claim cannot proceed with a malformed lifecycle slot");
    }
    if (lifecycleSlot.record) {
      assertDispatchLifecycleSlot(lifecycleSlot.record, record);
      if (lifecycleSlot.record.kind !== "runner_claimed") {
        throw collision("invocation claim is blocked by a stale-reservation lifecycle slot");
      }
    } else {
      const slot = buildDispatchLifecycleSlot(record, "runner_claimed");
      assertDispatchLifecycleSlot(slot, record);
      publishImmutable(
        evidence.paths.lifecycleSlot,
        canonicalBytes(slot, MAX_DISPATCH_LIFECYCLE_SLOT_BYTES),
        { idempotent: false },
      );
    }
    const claim = withIntegrity({
      schema: "devpro-second-review-dispatch-invocation/v1",
      repository_slug: record.repository_slug,
      pr_number: record.pr_number,
      head_ref_oid: record.head_ref_oid,
      attempt_id: record.attempt_id,
      dispatch_id: record.dispatch_id,
      previous_dispatch_id: record.previous_dispatch_id,
      outcome: "reviewer_invocation_claimed",
    });
    const finalPath = path.join(dispatchDir(lockedRoot, record.dispatch_id), INVOCATION_CLAIM_FILE);
    const status = publishImmutable(finalPath, canonicalBytes(claim, MAX_DISPATCH_BYTES), { idempotent: false });
    return { status, path: finalPath, record: claim };
  });
}

export async function writeFaultCapsule({ rootDir = controlEvidenceRoot(), record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    assertPlainObject(record, "fault capsule");
    if (record.schema !== FAULT_CAPSULE_SCHEMA) throw collision(`capsule schema must be ${FAULT_CAPSULE_SCHEMA}`);
    if (!CAPSULE_REQUIRED_CLASSIFICATIONS.has(record.classification)) {
      throw collision("fault capsule classification is outside the closed allowlist");
    }
    if (record.responsibility !== undefined
      && record.responsibility !== ORCHESTRATION_RESPONSIBILITY) {
      throw collision("fault capsule responsibility is outside the closed contract");
    }
    const reservation = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: record.dispatch_id });
    assertNoOperatorAbandonment(reservation, "fault capsule");
    if (!reservation.dispatch) throw collision("fault capsule dispatch reservation is missing");
    if (reservation.completion || reservation.terminal) {
      throw collision("fault capsule cannot be appended after terminal evidence");
    }
    for (const field of ["repository_slug", "pr_number", "head_ref_oid", "attempt_id", "dispatch_id", "previous_dispatch_id"]) {
      if (record[field] !== reservation.dispatch[field]) throw collision(`fault capsule ${field} binding mismatch`);
    }
    const capsule = withIntegrity({
      schema: FAULT_CAPSULE_SCHEMA,
      repository_slug: record.repository_slug,
      pr_number: record.pr_number,
      head_ref_oid: record.head_ref_oid,
      attempt_id: record.attempt_id,
      dispatch_id: record.dispatch_id,
      previous_dispatch_id: record.previous_dispatch_id,
      classification: record.classification,
      responsibility: ORCHESTRATION_RESPONSIBILITY,
      created_at: record.created_at ?? reservation.capsule?.created_at ?? new Date().toISOString(),
      evidence_provenance: boundedUtf8(record.evidence_provenance, MAX_IDENTITY_FIELD_BYTES, "unknown"),
      evidence_confidence: boundedUtf8(record.evidence_confidence, MAX_IDENTITY_FIELD_BYTES, "indeterminate"),
      matcher_id: boundedUtf8(record.matcher_id, MAX_IDENTITY_FIELD_BYTES, "none"),
      denied_action_class: boundedUtf8(record.denied_action_class, MAX_IDENTITY_FIELD_BYTES, "unknown"),
      redacted_excerpt: boundedExcerpt(record.redacted_excerpt),
    });
    assertFaultCapsule(capsule);
    const finalPath = reservation.paths.capsule;
    const status = publishImmutable(finalPath, canonicalBytes(capsule, MAX_CAPSULE_BYTES), { idempotent: true });
    return { status, path: finalPath, record: capsule };
  });
}

function writeCompletionReceiptUnlocked({ rootDir, record }) {
  assertPlainObject(record, "completion receipt");
  assertPersistedHeadRefOid(record.head_ref_oid, "completion receipt.head_ref_oid");
  const evidence = readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
  if (!evidence.dispatch || !evidence.invocationClaim
    || evidence.terminal || evidence.capsule || evidence.consumption || evidence.supersession) {
    throw collision("completion receipt requires a claimed dispatch without fault evidence");
  }
  assertExactIdentity(record, evidence.dispatch, "completion receipt");
  let receipt;
  if (isAuditCompletionOutcome(record)) {
    if (hasStickyCompletionKeys(record) || record.pr_number !== "none") {
      throw collision("completion receipt schema or exact canonical field set is invalid");
    }
    receipt = withIntegrity({
      schema: COMPLETION_SCHEMA,
      repository_slug: record.repository_slug,
      pr_number: record.pr_number,
      head_ref_oid: record.head_ref_oid,
      attempt_id: record.attempt_id,
      dispatch_id: record.dispatch_id,
      previous_dispatch_id: record.previous_dispatch_id,
      outcome: record.outcome,
      classification: record.classification,
      process_close_observed: record.process_close_observed,
    });
  } else {
    receipt = withIntegrity({
      schema: COMPLETION_SCHEMA,
      repository_slug: record.repository_slug,
      pr_number: record.pr_number,
      head_ref_oid: record.head_ref_oid,
      attempt_id: record.attempt_id,
      dispatch_id: record.dispatch_id,
      previous_dispatch_id: record.previous_dispatch_id,
      outcome: record.outcome,
      classification: record.classification,
      sticky_verdict: record.sticky_verdict,
      sticky_last_reviewed_sha: record.sticky_last_reviewed_sha,
      sticky_dispatch_id: record.sticky_dispatch_id,
      sticky_comment_id: record.sticky_comment_id,
      sticky_comment_url: record.sticky_comment_url,
      process_close_observed: record.process_close_observed,
    });
  }
  assertCompletionReceipt(receipt);
  const status = publishImmutable(
    evidence.paths.completion,
    canonicalBytes(receipt, MAX_DISPATCH_BYTES),
    { idempotent: true }
  );
  return { status, path: evidence.paths.completion, record: receipt };
}

function writeTerminalReceiptUnlocked({ rootDir, record }) {
  assertPlainObject(record, "terminal receipt");
  const evidence = readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
  if (!evidence.dispatch || evidence.completion || evidence.terminal
    || evidence.capsule || evidence.consumption || evidence.supersession) {
    throw collision("terminal receipt requires a reserved dispatch without other terminal or fault evidence");
  }
  assertExactIdentity(record, evidence.dispatch, "terminal receipt");
  const receipt = withIntegrity({
    schema: TERMINAL_RECEIPT_SCHEMA,
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    outcome_group: record.outcome_group,
    classification: record.classification,
    responsibility: record.responsibility,
    created_at: record.created_at ?? new Date().toISOString(),
    process_spawned: record.process_spawned,
    lifecycle_phase: record.lifecycle_phase,
    process_close_observed: record.process_close_observed,
    transport_cleanup_confirmed: record.transport_cleanup_confirmed,
    invocation_claim_sha256: record.invocation_claim_sha256,
  });
  assertTerminalReceipt(receipt);
  assertTerminalReceiptClaimBinding(
    receipt,
    evidence.invocationClaim,
    evidence.invocationClaimBytes
  );
  const status = publishImmutable(
    evidence.paths.terminal,
    canonicalBytes(receipt, MAX_DISPATCH_BYTES),
    { idempotent: false }
  );
  return { status, path: evidence.paths.terminal, record: receipt };
}

export async function writeCompletionReceipt({ rootDir = controlEvidenceRoot(), record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: record?.dispatch_id });
    assertNoOperatorAbandonment(evidence, "completion receipt");
    return writeCompletionReceiptUnlocked({ rootDir: lockedRoot, record });
  });
}

export async function writeTerminalReceipt({ rootDir = controlEvidenceRoot(), record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    if (record?.classification === "operator_abandoned_pre_spawn"
      || record?.classification === "stale_reservation_closed_pre_spawn") {
      throw collision("generic terminal writing cannot create an operator- or stale-reservation closure classification");
    }
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: record?.dispatch_id });
    assertNoOperatorAbandonment(evidence, "terminal receipt");
    return writeTerminalReceiptUnlocked({ rootDir: lockedRoot, record });
  });
}

function assertOperatorAbandonmentAuthorization(authorization) {
  assertPlainObject(authorization, "operator-abandonment authorization");
  assertExactFieldSet(authorization, OPERATOR_ABANDONMENT_AUTHORIZATION_FIELDS, "operator-abandonment authorization");
  for (const field of ["operator_login", "target_repository", "permission_source", "base_repository", "head_repository", "head_ref", "local_repository", "local_branch"]) {
    assertIdentityField(authorization[field], `operator-abandonment authorization.${field}`);
  }
  if (authorization.repository_permissions_push !== true
    || authorization.permission_source !== "gh-api-repository"
    || authorization.target_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || authorization.pr_number !== PR_2927_UNSTARTED_DISPATCH.pr_number
    || authorization.pr_state !== "OPEN"
    || authorization.pr_merged !== false
    || authorization.base_repository !== PR_2927_UNSTARTED_DISPATCH.repository_slug
    || authorization.head_repository !== PR_2927_UNSTARTED_DISPATCH.source_repository
    || authorization.head_ref !== PR_2927_UNSTARTED_DISPATCH.source_ref
    || authorization.remote_pr_head !== PR_2927_UNSTARTED_DISPATCH.head_ref_oid
    || authorization.local_repository !== PR_2927_UNSTARTED_DISPATCH.source_repository
    || authorization.local_branch !== PR_2927_UNSTARTED_DISPATCH.source_ref
    || !HEX_SHA_CANONICAL.test(String(authorization.local_implementation_commit ?? ""))) {
    throw collision("operator-abandonment authorization does not match the exact PR #2927 tuple");
  }
  assertCanonicalTimestamp(authorization.authorization_checked_at, "operator-abandonment authorization_checked_at");
}

function assertOperatorDirectoryInventory(directory, expectedNames) {
  const actual = readdirSync(directory, { withFileTypes: true }).map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw collision("operator-abandonment dispatch inventory contains an incompatible or unknown artifact");
  }
}

function sameOperatorAbandonmentAuthority(existing, attempted) {
  return OPERATOR_ABANDONMENT_STABLE_FIELDS.every((field) => existing[field] === attempted[field]);
}

export async function writeOperatorAbandonmentClosure({
  rootDir = controlEvidenceRoot(),
  dispatchId,
  authorization,
  confirmation,
}) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    assertDispatchId(dispatchId);
    if (dispatchId !== PR_2927_UNSTARTED_DISPATCH.dispatch_id) {
      throw collision("operator abandonment is allowlisted for one exact PR #2927 dispatch");
    }
    assertOperatorAbandonmentAuthorization(authorization);
    if (confirmation !== PR_2927_UNSTARTED_CONFIRMATION) {
      throw collision("operator abandonment requires the exact typed runner_not_started confirmation");
    }
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId });
    const dispatch = evidence.dispatch;
    if (!dispatch) throw collision("operator abandonment requires the exact immutable dispatch reservation");
    assertSecondReviewDispatchRecord(dispatch);
    for (const field of ["repository_slug", "pr_number", "head_ref_oid", "attempt_id", "dispatch_id", "previous_dispatch_id"]) {
      if (dispatch[field] !== PR_2927_UNSTARTED_DISPATCH[field]) {
        throw collision(`operator abandonment reservation ${field} is outside the one-dispatch allowlist`);
      }
    }
    if (dispatch.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
      throw collision("external-evaluator dispatches cannot use operator abandonment");
    }
    if (evidence.completion || evidence.terminal && evidence.terminal.classification !== "operator_abandoned_pre_spawn"
      || evidence.capsule || evidence.consumption || evidence.supersession || evidence.invocationClaim
      || evidence.reviewerModelRecord || evidence.externalClosure?.present) {
      throw collision("operator abandonment requires an unclaimed reservation without competing lifecycle evidence");
    }

    const directory = dispatchDir(lockedRoot, dispatchId);
    const slotPath = evidence.paths.operatorAbandonment;
    const existingSlot = evidence.operatorAbandonment;
    if (existingSlot.present && (existingSlot.unparseable || !existingSlot.record)) {
      throw collision("existing operator-abandonment slot is malformed or unreadable");
    }
    const resumed = Boolean(existingSlot.present);
    assertOperatorDirectoryInventory(directory, resumed
      ? (evidence.terminal ? [DISPATCH_FILE, OPERATOR_ABANDONMENT_SLOT_FILE, TERMINAL_RECEIPT_FILE]
        : [DISPATCH_FILE, OPERATOR_ABANDONMENT_SLOT_FILE])
      : [DISPATCH_FILE]);

    const slot = buildOperatorAbandonmentSlot(dispatch, authorization, confirmation, {
      createdAt: existingSlot.record?.created_at,
      authorizationCheckedAt: existingSlot.record?.authorization_checked_at,
    });
    assertOperatorAbandonmentSlot(slot, dispatch);
    if (existingSlot.record && !sameOperatorAbandonmentAuthority(existingSlot.record, slot)) {
      throw collision("operator-abandonment retry does not exactly match the immutable slot authority");
    }

    if (evidence.terminal) {
      const closed = readDispatchEvidenceStrict({ rootDir: lockedRoot, dispatchId });
      if (!closed.operatorAbandonment?.record
        || closed.terminal?.classification !== "operator_abandoned_pre_spawn") {
        throw collision("existing operator-abandonment terminal is not a valid slot-derived closure");
      }
      return { status: "already_abandoned", path: closed.paths.terminal, record: closed.terminal, resumed: true };
    }

    if (!existingSlot.record) {
      publishImmutable(slotPath, canonicalBytes(slot, MAX_OPERATOR_ABANDONMENT_SLOT_BYTES), { idempotent: false });
      fsyncDirectory(directory);
    }
    const slotAfterPublish = readOperatorAbandonmentSlot(directory, dispatchId);
    if (slotAfterPublish.unparseable || !slotAfterPublish.record
      || !sameOperatorAbandonmentAuthority(slotAfterPublish.record, slot)) {
      throw collision("operator-abandonment slot could not be revalidated before terminal derivation");
    }
    assertOperatorDirectoryInventory(directory, [DISPATCH_FILE, OPERATOR_ABANDONMENT_SLOT_FILE]);
    const terminal = operatorAbandonmentTerminal(dispatch, slotAfterPublish.record);
    const terminalPath = path.join(directory, TERMINAL_RECEIPT_FILE);
    const status = publishImmutable(terminalPath, canonicalBytes(terminal, MAX_DISPATCH_BYTES), { idempotent: false });
    fsyncDirectory(directory);
    return {
      status: "abandoned-before-invocation",
      path: terminalPath,
      record: terminal,
      resumed,
    };
  });
}

export async function writeStaleReservationClosure({
  rootDir = controlEvidenceRoot(),
  dispatchId,
  authorization,
  confirmation,
}) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    assertDispatchId(dispatchId);
    if (dispatchId !== PR_2927_UNSTARTED_DISPATCH.dispatch_id) {
      throw collision("stale-reservation closure is bounded to the exact PR #2927 predecessor");
    }
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId });
    const dispatch = evidence.dispatch;
    if (!dispatch) throw collision("stale-reservation closure requires the exact immutable dispatch reservation");
    assertSecondReviewDispatchRecord(dispatch);
    for (const field of IDENTITY_FIELDS) {
      if (dispatch[field] !== PR_2927_UNSTARTED_DISPATCH[field]) {
        throw collision(`stale-reservation dispatch ${field} is outside the one-dispatch authority tuple`);
      }
    }
    if (dispatch.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
      throw collision("external-evaluator dispatches cannot be stale-reservation closed");
    }
    const directory = dispatchDir(lockedRoot, dispatchId);
    const lifecycleSlot = evidence.lifecycleSlot;
    if (lifecycleSlot.present && (lifecycleSlot.unparseable || !lifecycleSlot.record)) {
      throw collision("existing dispatch lifecycle slot is malformed or unreadable");
    }
    if (lifecycleSlot.record) assertDispatchLifecycleSlot(lifecycleSlot.record, dispatch);
    if (lifecycleSlot.record?.kind === "runner_claimed") {
      throw collision("stale-reservation closure is blocked by a runner-claimed lifecycle slot");
    }
    if (evidence.operatorAbandonment?.present) {
      throw collision("stale-reservation closure conflicts with the exact operator-abandonment path");
    }
    if (evidence.invocationClaim || evidence.completion || evidence.capsule || evidence.consumption
      || evidence.supersession || evidence.reviewerModelRecord || evidence.externalClosure?.present) {
      throw collision("stale-reservation closure requires an unclaimed dispatch without competing lifecycle evidence");
    }

    const existingSlot = lifecycleSlot.record?.kind === "stale_reservation_closed"
      ? lifecycleSlot.record
      : null;
    if (!existingSlot) {
      if (evidence.terminal) {
        throw collision("a pre-existing terminal cannot be reclassified as a stale-reservation closure");
      }
      assertStaleReservationAuthorization(dispatch, authorization, confirmation);
      assertOperatorDirectoryInventory(directory, [DISPATCH_FILE]);
    } else {
      assertOperatorDirectoryInventory(directory, evidence.terminal
        ? [DISPATCH_FILE, DISPATCH_LIFECYCLE_SLOT_FILE, TERMINAL_RECEIPT_FILE]
        : [DISPATCH_FILE, DISPATCH_LIFECYCLE_SLOT_FILE]);
      if (evidence.terminal) {
        const closed = readDispatchEvidenceStrict({ rootDir: lockedRoot, dispatchId });
        return {
          status: "already-closed-stale-reservation",
          path: closed.paths.terminal,
          record: closed.terminal,
          resumed: true,
        };
      }
    }

    if (!existingSlot) {
      const slot = buildDispatchLifecycleSlot(
        dispatch,
        "stale_reservation_closed",
        authorization,
        confirmation,
      );
      assertDispatchLifecycleSlot(slot, dispatch);
      publishImmutable(
        evidence.paths.lifecycleSlot,
        canonicalBytes(slot, MAX_DISPATCH_LIFECYCLE_SLOT_BYTES),
        { idempotent: false },
      );
      fsyncDirectory(directory);
    }

    const closedSlot = readDispatchLifecycleSlot(directory, dispatchId);
    if (closedSlot.unparseable || !closedSlot.record
      || closedSlot.record.kind !== "stale_reservation_closed") {
      throw collision("stale-reservation lifecycle slot could not be revalidated before terminal derivation");
    }
    assertDispatchLifecycleSlot(closedSlot.record, dispatch);
    assertOperatorDirectoryInventory(directory, [DISPATCH_FILE, DISPATCH_LIFECYCLE_SLOT_FILE]);
    const terminal = staleReservationClosedTerminal(dispatch, closedSlot.record);
    const terminalPath = path.join(directory, TERMINAL_RECEIPT_FILE);
    const status = publishImmutable(terminalPath, canonicalBytes(terminal, MAX_DISPATCH_BYTES), { idempotent: false });
    fsyncDirectory(directory);
    const strict = readDispatchEvidenceStrict({ rootDir: lockedRoot, dispatchId });
    return {
      status: "closed-stale-reservation-before-invocation",
      path: terminalPath,
      record: strict.terminal,
      resumed: Boolean(existingSlot),
    };
  });
}

/**
 * D4 step 6 (R4, R13): raw ownership check for the external closure slot.
 * Deliberately does not go through readDispatchEvidenceStrict — a writer that
 * has just published its own slot (or is resuming after a crash) must not be
 * blocked by `external_closure_incomplete`, which only makes sense from a
 * consumer's point of view (gate/lineage/cleanup).
 *
 * `stableFields.dispatch_id` is required. `stableFields.receipt_payload` is
 * optional: when present (a fresh accept flow confirming what it just
 * published), it MUST exactly match the slot's stored payload; when absent
 * (writeExternalCompletionReceipt resuming from only a dispatch_id after a
 * crash), only presence and `kind` are checked and the caller reads the
 * payload back off the returned slot record instead.
 */
export function assertExternalSlotOwnership(directory, kind, stableFields) {
  const dispatchId = stableFields?.dispatch_id;
  assertDispatchId(dispatchId, "external closure dispatch_id");
  const slot = readExternalClosureSlot(directory, dispatchId);
  if (!slot.present || slot.unparseable || !slot.record) {
    throw collision("external closure slot ownership could not be verified");
  }
  if (slot.record.kind !== kind) {
    const error = new Error(
      `external dispatch closure already holds the "${slot.record.kind}" disposition`
    );
    error.classification = "external_dispatch_closed";
    throw error;
  }
  if (kind === "accepted" && Object.hasOwn(stableFields, "receipt_payload")) {
    if (JSON.stringify(slot.record.receipt_payload) !== JSON.stringify(stableFields.receipt_payload)) {
      throw collision("external closure slot does not match the expected accepted disposition content");
    }
  }
  return slot.record;
}

/**
 * D4 step 5 (R4, R13): exclusively publish the external closure slot for a
 * dispatch that D4 steps 1–4 (accept-external-second-review.mjs, T5) or D5
 * (void argv, T3) have already verified. `kind: "accepted"` requires a
 * `receiptPayload` matching the dispatch's identity and the four-verdict
 * external binding; `kind: "voided"` carries no payload. See
 * publishExternalClosureSlot for the exclusive-create/EEXIST-reconciliation
 * contract (temp `wx` + `linkSync`, never `renameSync`).
 */
function writeExternalClosureSlotUnlocked({
  rootDir = controlEvidenceRoot(),
  dispatchId,
  kind,
  receiptPayload = null,
}) {
  if (kind !== "accepted" && kind !== "voided") {
    throw collision("external closure slot kind must be accepted or voided");
  }
  const resolvedRoot = path.resolve(rootDir);
  const evidence = readDispatchEvidence({ rootDir: resolvedRoot, dispatchId });
  if (!evidence.dispatch || !isExternalDispatchRecord(evidence.dispatch)) {
    throw collision("external closure slot requires an external dispatch reservation");
  }
  if (kind === "accepted") {
    assertExternalClosureReceiptPayloadShape(receiptPayload, evidence.dispatch);
  } else if (receiptPayload !== null) {
    throw collision("voided external closure slot must not carry a receipt payload");
  }
  return publishExternalClosureSlot({
    directory: evidence.directory,
    dispatchId,
    kind,
    receiptPayload: kind === "accepted" ? receiptPayload : undefined,
    closedAt: new Date().toISOString(),
  });
}

export async function writeExternalClosureSlot(input) {
  return withLifecycleLock(input?.rootDir ?? controlEvidenceRoot(), (lockedRoot) => {
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: input?.dispatchId });
    assertNoOperatorAbandonment(evidence, "external closure slot");
    return writeExternalClosureSlotUnlocked({ ...input, rootDir: lockedRoot });
  });
}

// D4 step 7 (R4, R13; primary-review F-11): the fourth completion form's pure
// content builder, shared by the writer (writeExternalCompletionReceipt) and
// the strict reader's own rebuild-and-compare (readDispatchEvidenceStrict) —
// a single definition so the two can never independently drift apart.
function buildExternalCompletionReceipt(payload) {
  if (Object.hasOwn(payload, "audit_verdict")) {
    const receipt = withIntegrity({
      ...payload,
      outcome: EXTERNAL_AUDIT_COMPLETION_OUTCOME,
      classification: EXTERNAL_AUDIT_COMPLETION_CLASSIFICATION,
      process_close_observed: false,
    });
    assertCompletionReceipt(receipt);
    return receipt;
  }
  const receipt = withIntegrity({
    schema: payload.schema,
    repository_slug: payload.repository_slug,
    pr_number: payload.pr_number,
    head_ref_oid: payload.head_ref_oid,
    attempt_id: payload.attempt_id,
    dispatch_id: payload.dispatch_id,
    previous_dispatch_id: payload.previous_dispatch_id,
    outcome: EXTERNAL_COMPLETION_OUTCOME,
    classification: EXTERNAL_COMPLETION_CLASSIFICATION,
    sticky_verdict: payload.sticky_verdict,
    sticky_last_reviewed_sha: payload.sticky_last_reviewed_sha,
    sticky_dispatch_id: payload.sticky_dispatch_id,
    sticky_comment_id: payload.sticky_comment_id,
    sticky_comment_url: payload.sticky_comment_url,
    sticky_body_sha256: payload.sticky_body_sha256,
    process_close_observed: false,
  });
  assertCompletionReceipt(receipt);
  return receipt;
}

/**
 * D4 step 7 (R4, R13): the fourth completion form. Does not require an
 * invocation claim — closure authority is the accepted slot, verified via
 * assertExternalSlotOwnership. The receipt content is read back from the
 * slot's own `receipt_payload`, never from a fresh caller-supplied value or a
 * live re-read: this is what lets a same-kind rerun on a different clock (or
 * a rerun after the sticky was changed/deleted post-slot-publication)
 * reconstruct a byte-identical receipt purely from durable local evidence.
 */
function writeExternalCompletionReceiptUnlocked({ rootDir, dispatchId }) {
  const resolvedRoot = path.resolve(rootDir);
  const evidence = readDispatchEvidence({ rootDir: resolvedRoot, dispatchId });
  if (!evidence.dispatch || !isExternalDispatchRecord(evidence.dispatch)) {
    throw collision("external completion receipt requires an external dispatch reservation");
  }
  const slotRecord = assertExternalSlotOwnership(evidence.directory, "accepted", { dispatch_id: dispatchId });
  const payload = slotRecord.receipt_payload;
  assertExternalClosureReceiptPayloadShape(payload, evidence.dispatch);
  const receipt = buildExternalCompletionReceipt(payload);
  const status = publishImmutable(
    evidence.paths.completion,
    canonicalBytes(receipt, MAX_DISPATCH_BYTES),
    { idempotent: true }
  );
  return { status, path: evidence.paths.completion, record: receipt };
}

export async function writeExternalCompletionReceipt({ rootDir = controlEvidenceRoot(), dispatchId }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId });
    assertNoOperatorAbandonment(evidence, "external completion receipt");
    return writeExternalCompletionReceiptUnlocked({ rootDir: lockedRoot, dispatchId });
  });
}

/**
 * 把已封存的 audit 完成收據原樣鏡像到該票的 carrier 目錄（completion-receipt.json），同內容重寫視為成功。
 * TL 接受 audit 報告、寫完 control evidence 的完成收據之後呼叫。
 * fail closed：dispatch 不是 audit-only、完成收據不是 external_evaluator_audit_accepted、目錄不是該 dispatch 綁定的 carrier
 * 或是 symlink 時，拋 reviewer_dispatch_identity_collision。
 * @param {{ rootDir?: string, dispatchId: string, packetDir: string }} options
 * @returns {string} 鏡像檔路徑
 */
export function mirrorExternalAuditCompletionReceipt({ rootDir = controlEvidenceRoot(), dispatchId, packetDir }) {
  const evidence = readDispatchEvidenceStrict({ rootDir, dispatchId });
  const directory = path.resolve(packetDir);
  if (!evidence.dispatch || evidence.dispatch.mode !== "audit-only"
    || !evidence.completion || !isExternalAuditCompletionOutcome(evidence.completion)
    || sha256(Buffer.from(directory, "utf8")) !== evidence.dispatch.carrier_root_id
    || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw collision("external audit receipt mirror is not bound to its carrier");
  }
  const mirrorPath = path.join(directory, COMPLETION_RECEIPT_FILE);
  publishImmutable(mirrorPath, canonicalBytes(evidence.completion, MAX_DISPATCH_BYTES), { idempotent: true });
  return mirrorPath;
}

// D5 (R5, R13; primary-review F-11): the void terminal's pure content
// builder, shared by the writer (writeExternalVoidTerminalReceipt) and the
// strict reader's own rebuild-and-compare (readDispatchEvidenceStrict).
function buildExternalVoidTerminalReceipt(dispatch, slotRecord) {
  const receipt = withIntegrity({
    schema: TERMINAL_RECEIPT_SCHEMA,
    repository_slug: dispatch.repository_slug,
    pr_number: dispatch.pr_number,
    head_ref_oid: dispatch.head_ref_oid,
    attempt_id: dispatch.attempt_id,
    dispatch_id: dispatch.dispatch_id,
    previous_dispatch_id: dispatch.previous_dispatch_id,
    outcome_group: EXTERNAL_VOID_OUTCOME_GROUP,
    classification: EXTERNAL_VOID_CLASSIFICATION,
    responsibility: TERMINAL_RECEIPT_RESPONSIBILITY,
    created_at: slotRecord.closed_at,
    process_spawned: false,
    lifecycle_phase: "pre_spawn_known_terminal",
    process_close_observed: false,
    transport_cleanup_confirmed: true,
    invocation_claim_sha256: null,
  });
  assertTerminalReceipt(receipt);
  return receipt;
}

/**
 * D5 (R5, R13): external void terminal. Deliberately does not reuse
 * writeTerminalReceipt — that path requires an already-reserved dispatch
 * without other terminal/fault evidence and publishes non-idempotently
 * (`{ idempotent: false }`), which is correct for the runner's single-writer
 * terminal but wrong here: a same-kind void rerun after a crash MUST be
 * idempotent, and `created_at` MUST be the slot's `closed_at` (the sole time
 * authority for external closure, F-5-1), not a fresh `new Date()`.
 */
function writeExternalVoidTerminalReceiptUnlocked({ rootDir, dispatchId }) {
  const resolvedRoot = path.resolve(rootDir);
  const evidence = readDispatchEvidence({ rootDir: resolvedRoot, dispatchId });
  if (!evidence.dispatch || !isExternalDispatchRecord(evidence.dispatch)) {
    throw collision("external void terminal receipt requires an external dispatch reservation");
  }
  const slotRecord = assertExternalSlotOwnership(evidence.directory, "voided", { dispatch_id: dispatchId });
  const receipt = buildExternalVoidTerminalReceipt(evidence.dispatch, slotRecord);
  const status = publishImmutable(
    evidence.paths.terminal,
    canonicalBytes(receipt, MAX_DISPATCH_BYTES),
    { idempotent: true }
  );
  return { status, path: evidence.paths.terminal, record: receipt };
}

export async function writeExternalVoidTerminalReceipt({ rootDir = controlEvidenceRoot(), dispatchId }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId });
    assertNoOperatorAbandonment(evidence, "external terminal receipt");
    return writeExternalVoidTerminalReceiptUnlocked({ rootDir: lockedRoot, dispatchId });
  });
}

/**
 * True when a dispatch evidence directory was never started: missing, or
 * completely empty (zero readdir entries). Any entry — including subdirectories
 * or dot-prefixed staging files — means the dispatch may be in-flight or
 * incomplete and MUST NOT be treated as never-started (R6 retain).
 */
export function dispatchEvidenceNeverStarted({ rootDir = controlEvidenceRoot(), dispatchId }) {
  return withDispatchEvidenceSnapshot({ rootDir }, (root) => dispatchEvidenceNeverStartedLocked({ rootDir: root, dispatchId }));
}

function dispatchEvidenceNeverStartedLocked({ rootDir, dispatchId }) {
  assertRetirementFence(rootDir, dispatchId);
  const directory = dispatchDir(rootDir, dispatchId);
  if (!existsSync(directory)) return true;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.length === 0;
}

/**
 * D4 step 9 (R4, R5, R13; primary-review F-11): strict reader for
 * gate/lineage/cleanup consumers. A runner (non-external) dispatch is
 * unaffected — it is returned exactly as readDispatchEvidence produces it,
 * with no additional slot semantics.
 * An external dispatch fails closed as `external_closure_incomplete` when its
 * slot cannot be resolved, or when it is `accepted` without a completion
 * receipt, or `voided` without a terminal receipt. It fails closed as
 * `external_closure_receipt_mismatch` when a receipt IS present but its
 * bytes do not equal the receipt the same builder the writer uses would
 * rebuild from the slot's own content — mere presence of a schema/integrity-
 * valid receipt is not sufficient; it must actually be what the slot closed
 * on, not independently-tampered evidence with a self-consistent integrity_id.
 */
export function readDispatchEvidenceStrict({ rootDir = controlEvidenceRoot(), dispatchId }) {
  return withDispatchEvidenceSnapshot({ rootDir }, (root) => readDispatchEvidenceStrictLocked({ rootDir: root, dispatchId }));
}

function readDispatchEvidenceStrictLocked({ rootDir, dispatchId }) {
  const resolvedRoot = path.resolve(rootDir);
  const evidence = readDispatchEvidence({ rootDir: resolvedRoot, dispatchId });
  assertOperatorAbandonmentClosure({
    directory: evidence.directory,
    dispatch: evidence.dispatch,
    invocationClaim: evidence.invocationClaim,
    completion: evidence.completion,
    terminal: evidence.terminal,
    capsule: evidence.capsule,
    consumption: evidence.consumption,
    operatorAbandonment: evidence.operatorAbandonment,
  });
  assertDispatchLifecycleClosure({
    directory: evidence.directory,
    dispatch: evidence.dispatch,
    invocationClaim: evidence.invocationClaim,
    completion: evidence.completion,
    terminal: evidence.terminal,
    capsule: evidence.capsule,
    consumption: evidence.consumption,
    lifecycleSlot: evidence.lifecycleSlot,
  });
  if (!evidence.dispatch || !isExternalDispatchRecord(evidence.dispatch)) {
    return evidence;
  }
  const directory = dispatchDir(resolvedRoot, dispatchId);
  const slot = readExternalClosureSlot(directory, dispatchId);
  if (!slot.present || slot.unparseable || !slot.record) {
    throw externalClosureIncompleteError("external dispatch closure slot could not be resolved");
  }
  if (slot.record.kind === "accepted" && !evidence.completion) {
    throw externalClosureIncompleteError("external dispatch is accepted but its completion receipt is missing");
  }
  if (slot.record.kind === "voided" && !evidence.terminal) {
    throw externalClosureIncompleteError("external dispatch is voided but its terminal receipt is missing");
  }
  assertExternalReceiptsMatchSlot(evidence.dispatch, slot.record, evidence.completion, evidence.terminal);
  return evidence;
}

function assertDispatchLifecycleClosure({
  directory,
  dispatch,
  invocationClaim = null,
  completion = null,
  terminal = null,
  capsule = null,
  consumption = null,
  lifecycleSlot = null,
}) {
  const slotPresent = Boolean(lifecycleSlot?.present);
  const staleTerminal = terminal?.classification === "stale_reservation_closed_pre_spawn";
  if (!slotPresent && !staleTerminal) return;
  if (!dispatch) throw collision("dispatch lifecycle evidence has no immutable reservation");
  if (lifecycleSlot?.unparseable || !lifecycleSlot?.record) {
    throw collision("dispatch lifecycle slot is missing, malformed, or unreadable");
  }
  assertDispatchLifecycleSlot(lifecycleSlot.record, dispatch);
  if (lifecycleSlot.record.kind === "runner_claimed") {
    if (!invocationClaim) {
      throw collision("runner lifecycle slot is incomplete until its invocation claim exists");
    }
    if (staleTerminal) {
      throw collision("runner lifecycle slot cannot authorize stale-reservation closure");
    }
    return;
  }
  if (invocationClaim || completion || capsule || consumption) {
    throw collision("stale-reservation closure conflicts with another lifecycle artifact");
  }
  if (!terminal || !staleTerminal) {
    throw collision("stale-reservation lifecycle slot is incomplete until its derived terminal exists");
  }
  const expectedTerminal = staleReservationClosedTerminal(dispatch, lifecycleSlot.record);
  if (JSON.stringify(expectedTerminal) !== JSON.stringify(terminal)) {
    throw collision("stale-reservation terminal does not match its immutable lifecycle slot");
  }
  const names = readdirSync(directory, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const expectedNames = [DISPATCH_FILE, DISPATCH_LIFECYCLE_SLOT_FILE, TERMINAL_RECEIPT_FILE].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw collision("stale-reservation dispatch inventory contains an incompatible or unknown artifact");
  }
}

// Shared by readDispatchEvidenceStrict and readDirectPredecessorEvidence
// (second review r1 finding 1): a present receipt must be canonical-byte-equal
// to the receipt rebuilt from the slot's own content, so an altered receipt
// with a self-consistent integrity_id cannot pass either reader.
function assertExternalReceiptsMatchSlot(dispatch, slotRecord, completion, terminal) {
  if (completion && slotRecord.kind === "accepted") {
    const rebuilt = buildExternalCompletionReceipt(slotRecord.receipt_payload);
    if (JSON.stringify(rebuilt) !== JSON.stringify(completion)) {
      throw externalClosureReceiptMismatchError(
        "external completion receipt does not match the accepted slot's own receipt_payload"
      );
    }
  }
  if (terminal && slotRecord.kind === "voided") {
    const rebuilt = buildExternalVoidTerminalReceipt(dispatch, slotRecord);
    if (JSON.stringify(rebuilt) !== JSON.stringify(terminal)) {
      throw externalClosureReceiptMismatchError(
        "external void terminal receipt does not match what the voided slot would rebuild"
      );
    }
  }
}

function assertOperatorAbandonmentClosure({
  directory,
  dispatch,
  invocationClaim = null,
  completion = null,
  terminal = null,
  capsule = null,
  consumption = null,
  supersession = null,
  reviewerModelRecord = null,
  externalClosure = null,
  operatorAbandonment = null,
}) {
  const slotPresent = Boolean(operatorAbandonment?.present);
  const operatorTerminal = terminal?.classification === "operator_abandoned_pre_spawn";
  if (!slotPresent && !operatorTerminal) return;
  if (!dispatch) throw collision("operator-abandonment evidence has no dispatch reservation");
  if (isExternalDispatchRecord(dispatch)) {
    throw collision("external-evaluator dispatches cannot use operator abandonment");
  }
  if (operatorAbandonment?.unparseable || !operatorAbandonment?.record) {
    throw collision("operator-abandonment slot is missing, malformed, or unreadable");
  }
  assertOperatorAbandonmentSlot(operatorAbandonment.record, dispatch);
  if (!terminal || !operatorTerminal) {
    throw collision("operator-abandonment slot is incomplete until its derived terminal receipt exists");
  }
  if (invocationClaim || completion || capsule || consumption || supersession
    || reviewerModelRecord || externalClosure) {
    throw collision("operator-abandonment closure conflicts with another lifecycle artifact");
  }
  const expectedTerminal = operatorAbandonmentTerminal(dispatch, operatorAbandonment.record);
  if (JSON.stringify(expectedTerminal) !== JSON.stringify(terminal)) {
    throw collision("operator-abandonment terminal does not match its immutable slot");
  }
  const names = readdirSync(directory, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const expectedNames = [DISPATCH_FILE, OPERATOR_ABANDONMENT_SLOT_FILE, TERMINAL_RECEIPT_FILE].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw collision("operator-abandonment dispatch inventory contains an incompatible or unknown artifact");
  }
}

function writeConsumptionReceiptUnlocked({ rootDir, record }) {
  assertPlainObject(record, "consumption receipt");
  if (record.schema !== FAULT_CONSUMPTION_SCHEMA || record.outcome !== "blocked_orchestration_fault") {
    throw collision("consumption receipt identity or outcome is invalid");
  }
  const evidence = readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
  const durableFault = evidence.capsule ?? evidence.consumption;
  const capsuleIntegrityId = evidence.capsule?.integrity_id
    ?? evidence.consumption?.capsule_integrity_id;
  if (!evidence.dispatch || !durableFault
    || capsuleIntegrityId !== record.capsule_integrity_id
    || (record.classification !== undefined
      && record.classification !== durableFault.classification)
    || (record.responsibility !== undefined
      && record.responsibility !== durableFault.responsibility)) {
    throw collision("consumption receipt is not bound to the immutable fault capsule");
  }
  assertExactIdentity(record, evidence.dispatch, "consumption receipt");
  const receipt = withIntegrity({
    schema: FAULT_CONSUMPTION_SCHEMA,
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    outcome: "blocked_orchestration_fault",
    classification: durableFault.classification,
    responsibility: durableFault.responsibility,
    capsule_integrity_id: record.capsule_integrity_id,
  });
  const status = publishImmutable(evidence.paths.consumption, canonicalBytes(receipt, MAX_DISPATCH_BYTES), { idempotent: true });
  return { status, path: evidence.paths.consumption, record: receipt };
}

export async function writeConsumptionReceipt({ rootDir = controlEvidenceRoot(), record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: record?.dispatch_id });
    assertNoOperatorAbandonment(evidence, "consumption receipt");
    return writeConsumptionReceiptUnlocked({ rootDir: lockedRoot, record });
  });
}

function writeSupersessionReceiptUnlocked({ rootDir, faultDispatchId, record }) {
  assertPlainObject(record, "supersession receipt");
  if (record.schema !== FAULT_SUPERSESSION_SCHEMA
    || record.fault_dispatch_id !== faultDispatchId
    || record.verified_dispatch_id !== record.dispatch_id
    || record.fault_dispatch_id === record.verified_dispatch_id
    || record.outcome !== `superseded_by_verified_dispatch:${record.verified_dispatch_id}`) {
    throw collision("supersession lineage or outcome is invalid");
  }
  const fault = readDispatchEvidence({ rootDir, dispatchId: faultDispatchId });
  const successor = readDispatchEvidence({ rootDir, dispatchId: record.verified_dispatch_id });
  if (!fault.dispatch || !fault.consumption || !successor.dispatch || !successor.completion
    || fault.consumption.integrity_id !== record.consumption_integrity_id) {
    throw collision("supersession receipt is not bound to a consumed fault and terminally completed successor");
  }
  assertExactIdentity(record, successor.dispatch, "supersession successor");
  assertDispatchAncestor({ rootDir, successor: successor.dispatch, ancestorDispatchId: faultDispatchId });
  const receipt = withIntegrity({
    schema: FAULT_SUPERSESSION_SCHEMA,
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    fault_dispatch_id: faultDispatchId,
    verified_dispatch_id: record.verified_dispatch_id,
    outcome: record.outcome,
    consumption_integrity_id: record.consumption_integrity_id,
  });
  const status = publishImmutable(fault.paths.supersession, canonicalBytes(receipt, MAX_DISPATCH_BYTES), { idempotent: true });
  return { status, path: fault.paths.supersession, record: receipt };
}

export async function writeSupersessionReceipt({ rootDir = controlEvidenceRoot(), faultDispatchId, record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    const fault = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: faultDispatchId });
    const successor = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: record?.verified_dispatch_id });
    assertNoOperatorAbandonment(fault, "fault supersession receipt");
    assertNoOperatorAbandonment(successor, "fault supersession receipt");
    return writeSupersessionReceiptUnlocked({ rootDir: lockedRoot, faultDispatchId, record });
  });
}

// D12 (R5; strengthen-reviewer-model-selection T13): the sole writer of the
// reviewer-model-record sibling artifact. The runner's single call site (design.md
// D12) MUST invoke this strictly before it seals completion-receipt.json (or any
// terminal receipt) for the same dispatch — that ordering, not "same batch", is
// what makes INV-MR ("a dispatch whose completion receipt this runner sealed for
// a reviewer process it actually spawned has a reviewer model record"; an
// external-evaluator completion never spawns one and is legally record-less)
// hold: publishImmutable hard-links a receipt into permanent existence,
// so a later failure here can never retroactively unpublish it. Rejecting a call
// made after completion/terminal already exists keeps that ordering true even if
// a caller mistakenly invokes this out of turn.
function writeReviewerModelRecordUnlocked({ rootDir, record }) {
  assertPlainObject(record, "reviewer model record");
  assertPersistedHeadRefOid(record.head_ref_oid, "reviewer model record.head_ref_oid");
  const evidence = readDispatchEvidence({ rootDir, dispatchId: record.dispatch_id });
  if (!evidence.dispatch) {
    throw collision("reviewer model record requires an existing dispatch reservation");
  }
  if (evidence.completion || evidence.terminal) {
    throw collision("reviewer model record cannot be appended after terminal evidence");
  }
  assertExactIdentity(record, evidence.dispatch, "reviewer model record");
  const built = withIntegrity({
    schema: REVIEWER_MODEL_RECORD_SCHEMA,
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    attempt_id: record.attempt_id,
    dispatch_id: record.dispatch_id,
    previous_dispatch_id: record.previous_dispatch_id,
    reviewer_cli_family: record.reviewer_cli_family,
    requested_model: record.requested_model,
    requested_source: record.requested_source,
    requested_source_env_var: record.requested_source_env_var,
    requested_kind: record.requested_kind,
    observed_model: record.observed_model,
    observed_source: record.observed_source,
    observed_unavailable_reason: record.observed_unavailable_reason,
    agreement: record.agreement,
  });
  assertReviewerModelRecord(built);
  const status = publishImmutable(
    evidence.paths.reviewerModelRecord,
    canonicalBytes(built, MAX_DISPATCH_BYTES),
    { idempotent: true }
  );
  return { status, path: evidence.paths.reviewerModelRecord, record: built };
}

export async function writeReviewerModelRecord({ rootDir = controlEvidenceRoot(), record }) {
  return withLifecycleLock(rootDir, (lockedRoot) => {
    const evidence = readDispatchEvidence({ rootDir: lockedRoot, dispatchId: record?.dispatch_id });
    assertNoOperatorAbandonment(evidence, "reviewer model record");
    return writeReviewerModelRecordUnlocked({ rootDir: lockedRoot, record });
  });
}

const RETIREMENT_FILE = ".cleanup-retirement.json";
const RETIREMENT_SCHEMA = "devpro-second-review-retirement/v1";
const DIGEST = /^[a-f0-9]{64}$/;
const RETIREMENT_FILES = new Set([
  DISPATCH_FILE, INVOCATION_CLAIM_FILE, COMPLETION_RECEIPT_FILE, TERMINAL_RECEIPT_FILE,
  FAULT_CAPSULE_FILE, CONSUMPTION_RECEIPT_FILE, SUPERSESSION_RECEIPT_FILE,
  REVIEWER_MODEL_RECORD_FILE, EXTERNAL_CLOSURE_SLOT_FILE, OPERATOR_ABANDONMENT_SLOT_FILE,
  DISPATCH_LIFECYCLE_SLOT_FILE, ...CONTROL_EVIDENCE_CLEANUP_COMPANION_FILES,
]);
function retirementFileAllowed(name) {
  return typeof name === "string" && byteLength(name) <= MAX_IDENTITY_FIELD_BYTES && path.basename(name) === name
    && (RETIREMENT_FILES.has(name) || isUsageManifestAtomicTempFileName(name));
}
function retirementError(rootDir, detail) {
  const error = new Error(`retirement_recovery_required: ${detail}; root ${path.resolve(rootDir)}. `
    + "Keep the authority and original files, preserve the pending marker and ask TL to investigate. "
    + "After exact original immutable inventory is restored, rerun cleanupOwnedControlEvidence({ rootDir }) "
    + "from .devpro/scripts/hooks/lib/second-review-control-evidence.mjs; do not omit required ancestors.");
  error.classification = "retirement_recovery_required";
  return error;
}
function readRetirementManifest(rootDir) {
  const file = path.join(rootDir, RETIREMENT_FILE);
  try {
    const stat = lstatIfPresent(file);
    if (stat === null) return null;
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES_PER_REPOSITORY) throw new Error("authority byte/type bound");
    const bytes = readFileSync(file);
    const plan = JSON.parse(bytes.toString("utf8"));
    assertExactFieldSet(plan, ["schema", "plan_id", "root_identity_sha256", "created_at", "members"], "retirement manifest");
    if (plan.schema !== RETIREMENT_SCHEMA
      || typeof plan.plan_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(plan.plan_id)
      || plan.root_identity_sha256 !== sha256(path.resolve(rootDir))
      || !Array.isArray(plan.members) || plan.members.length === 0 || plan.members.length > MAX_DISPATCHES_PER_REPOSITORY) {
      throw new Error("authority identity/member bound");
    }
    assertCanonicalTimestamp(plan.created_at, "retirement created_at");
    let lastId = "";
    for (const member of plan.members) {
      assertExactFieldSet(member, ["dispatch_id", "reservation", "reservation_sha256", "files"], "retirement member");
      assertDispatchId(member.dispatch_id, "retirement dispatch_id");
      assertSecondReviewDispatchRecord(member.reservation);
      const reservationBytes = canonicalBytes(member.reservation, MAX_DISPATCH_BYTES);
      if (member.reservation.dispatch_id !== member.dispatch_id || sha256(reservationBytes) !== member.reservation_sha256) {
        throw new Error("pinned reservation identity/hash mismatch");
      }
      if (member.dispatch_id <= lastId || !DIGEST.test(member.reservation_sha256)
        || !Array.isArray(member.files) || member.files.length === 0 || member.files.length > MAX_EVIDENCE_FILES) throw new Error("member identity/file bound");
      lastId = member.dispatch_id;
      let lastName = "", total = 0, reservationFound = false;
      for (const item of member.files) {
        assertExactFieldSet(item, ["name", "size", "sha256"], "retirement file");
        if (!retirementFileAllowed(item.name) || item.name <= lastName
          || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_DISPATCH_EVIDENCE_BYTES
          || !DIGEST.test(item.sha256)) throw new Error("file identity/byte bound");
        lastName = item.name; total += item.size;
        if (item.name === DISPATCH_FILE) {
          if (item.sha256 !== member.reservation_sha256 || item.size !== reservationBytes.length) throw new Error("reservation hash/length mismatch");
          reservationFound = true;
        }
      }
      if (!reservationFound || total > MAX_DISPATCH_EVIDENCE_BYTES) throw new Error("member reservation/aggregate bound");
    }
    if (!canonicalBytes(plan, MAX_BYTES_PER_REPOSITORY).equals(bytes)) throw new Error("noncanonical authority");
    return plan;
  } catch (error) {
    if (error?.classification === "retirement_recovery_required") throw error;
    throw retirementError(rootDir, String(error?.message ?? error));
  }
}
function assertRetirementFence(rootDir, dispatchId) {
  assertDispatchId(dispatchId, "dispatch_id");
  const plan = readRetirementManifest(rootDir);
  if (plan?.members.some((member) => member.dispatch_id === dispatchId)) {
    const error = new Error(`dispatch_evidence_retiring: dispatch ${dispatchId} in root ${path.resolve(rootDir)} is blocked; `
      + "rerun cleanupOwnedControlEvidence({ rootDir }) from .devpro/scripts/hooks/lib/second-review-control-evidence.mjs "
      + "with the retained retirement authority, then rerun the original operation. Preserve the pending marker and required ancestors; "
      + "if exact original immutable evidence cannot be restored, escalate to TL.");
    error.classification = "dispatch_evidence_retiring";
    throw error;
  }
}
function assertReservationAncestorsAvailable(rootDir, record) {
  const seen = new Set([record.dispatch_id]);
  let cursor = record;
  for (let depth = 0; cursor.previous_dispatch_id !== null; depth += 1) {
    if (depth >= MAX_DISPATCHES_PER_PR_LINEAGE - 1 || seen.has(cursor.previous_dispatch_id)) throw collision("dispatch lineage exceeds its bound or contains a cycle");
    const id = cursor.previous_dispatch_id;
    assertRetirementFence(rootDir, id);
    // Preserve the actionable new-reservation missing-predecessor diagnostic.
    if (!existsSync(path.join(dispatchDir(rootDir, id), DISPATCH_FILE))) {
      assertPredecessorReservationPresent(rootDir, cursor);
    }
    assertDirectPredecessor(rootDir, cursor);
    cursor = readCanonicalDispatchReservation(rootDir, id);
    seen.add(id);
  }
}
function assertCrossHeadMarkerWitness(rootDir, record, witness) {
  if (record.previous_dispatch_id === null) return;
  const prior = readCanonicalDispatchReservation(rootDir, record.previous_dispatch_id);
  if (prior.head_ref_oid === record.head_ref_oid) return;
  const reject = () => { throw collision("new cross-head reservation requires an exact canonical predecessor marker witness"); };
  if (!witness || typeof witness.file !== "string" || !witness.snapshot || !DIGEST.test(witness.sha256)) reject();
  const inventory = listPostPrCompletionMarkers(process.cwd(), Date.now(), { pruneStale: false });
  if (inventory.some((marker) => marker.marker_unreadable)) reject();
  const matches = inventory.filter((marker) => marker.repository_slug === record.repository_slug
    && String(marker.prNumber ?? marker.pr_number) === record.pr_number);
  if (matches.length !== 1) reject();
  const marker = matches[0];
  const stat = lstatIfPresent(marker.file);
  if (!stat?.isFile() || path.resolve(witness.file) !== path.resolve(marker.file)) reject();
  let bytes, snapshot;
  try { bytes = readFileSync(marker.file); snapshot = JSON.parse(bytes.toString("utf8")); } catch { reject(); }
  if (sha256(bytes) !== witness.sha256 || JSON.stringify(snapshot) !== JSON.stringify(witness.snapshot)
    || (marker.authorityId ? marker.authorityId !== witness.snapshot.authorityId : !marker.createdAt)
    || marker.createdAt !== witness.snapshot.createdAt
    || marker.expected_dispatch_id !== prior.dispatch_id || marker.head_ref_oid !== prior.head_ref_oid) reject();
}

// No receipt is returned by recovery: these bytes authorize only exact deletion/capacity accounting.
function verifyRetirementMember(rootDir, member) {
  const directory = dispatchDir(rootDir, member.dispatch_id);
  const stat = lstatIfPresent(directory);
  if (stat === null) return null;
  if (!stat.isDirectory()) throw retirementError(rootDir, `dispatch ${member.dispatch_id} is not a directory`);
  const allowed = new Map(member.files.map((file) => [file.name, file]));
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const pinned = allowed.get(entry.name);
    const file = path.join(directory, entry.name);
    const current = lstatSync(file);
    if (!pinned || !current.isFile() || current.size !== pinned.size || sha256(readFileSync(file)) !== pinned.sha256) {
      throw retirementError(rootDir, `dispatch ${member.dispatch_id} has changed, unknown or nonregular inventory`);
    }
  }
  const reservation = path.join(directory, DISPATCH_FILE);
  if (lstatIfPresent(reservation) !== null) {
    try {
      const record = JSON.parse(readFileSync(reservation, "utf8"));
      assertSecondReviewDispatchRecord(record);
      if (record.dispatch_id !== member.dispatch_id) throw new Error("dispatch ID mismatch");
    } catch (error) { throw retirementError(rootDir, `reservation identity mismatch: ${error.message}`); }
  }
  return directory;
}
function retirementCheckpoint(checkpoint, name, detail) {
  if (typeof checkpoint === "function") checkpoint(name, detail);
}
function resumeRetirement(rootDir, plan, { budgetHit, maxCleanup, checkpoint }, results) {
  const pinnedAuthority = canonicalBytes(plan, MAX_BYTES_PER_REPOSITORY);
  const verifyAuthority = () => {
    const current = readRetirementManifest(rootDir);
    if (!current || !canonicalBytes(current, MAX_BYTES_PER_REPOSITORY).equals(pinnedAuthority)) {
      throw retirementError(rootDir, "committed authority changed during recovery");
    }
  };
  let removed = 0, progressed = false;
  const shouldYield = () => progressed && budgetHit();
  fsyncDirectory(rootDir);
  for (const member of plan.members) {
    verifyAuthority();
    let directory = verifyRetirementMember(rootDir, member);
    if (directory === null) continue;
    for (const file of member.files) {
      if (shouldYield() || (maxCleanup !== null && removed >= maxCleanup)) return false;
      verifyAuthority();
      directory = verifyRetirementMember(rootDir, member);
      const target = path.join(directory, file.name);
      if (lstatIfPresent(target) === null) continue;
      unlinkSync(target);
      retirementCheckpoint(checkpoint, "file-unlinked", { dispatchId: member.dispatch_id, name: file.name });
      fsyncDirectory(directory);
      progressed = true;
      retirementCheckpoint(checkpoint, "member-fsynced", { dispatchId: member.dispatch_id, name: file.name });
    }
    if (shouldYield() || (maxCleanup !== null && removed >= maxCleanup)) return false;
    verifyAuthority();
    verifyRetirementMember(rootDir, member);
    // A resumed empty directory still needs its prior deletions made durable.
    fsyncDirectory(directory);
    rmdirSync(directory);
    retirementCheckpoint(checkpoint, "directory-removed", { dispatchId: member.dispatch_id });
    fsyncDirectory(rootDir);
    retirementCheckpoint(checkpoint, "root-fsynced", { dispatchId: member.dispatch_id });
    results.push({ dispatchId: member.dispatch_id, ...cleanupOutcome({ eligible: true, cleaned: true, reason: "cleaned", scope: "complete-chain-directory" }) });
    removed += 1; progressed = true;
  }
  if (shouldYield()) return false;
  // Every member is absent before the sole authority is removed.
  if (plan.members.some((member) => lstatIfPresent(dispatchDir(rootDir, member.dispatch_id)) !== null)) throw retirementError(rootDir, "member reappeared before authority removal");
  verifyAuthority();
  fsyncDirectory(rootDir);
  unlinkSync(path.join(rootDir, RETIREMENT_FILE));
  retirementCheckpoint(checkpoint, "manifest-unlinked", { planId: plan.plan_id });
  fsyncDirectory(rootDir);
  retirementCheckpoint(checkpoint, "manifest-removal-fsynced", { planId: plan.plan_id });
  return true;
}
function cleanupComponentInventory(rootDir, activeMarkers, now, markerInventory) {
  const entries = readdirSync(rootDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  if (entries.length > MAX_DISPATCHES_PER_REPOSITORY) throw capacityError("cleanup owner scan exceeds the repository dispatch bound");
  const evidence = new Map(), edges = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) throw collision("cleanup inventory has a non-directory dispatch");
    const item = readDispatchEvidenceStrict({ rootDir, dispatchId: entry.name });
    if (!item.dispatch) throw collision("cleanup inventory has incomplete evidence");
    if (!boundedDirectoryCleanupState(item, now)) throw collision("cleanup inventory has unknown or unbounded evidence");
    evidence.set(entry.name, item); edges.set(entry.name, new Set());
  }
  const connect = (from, to) => {
    if (!evidence.has(to)) throw collision("cleanup dependency reservation is missing");
    edges.get(from).add(to); edges.get(to).add(from);
  };
  for (const [id, item] of evidence) {
    assertReservationAncestorsAvailable(rootDir, item.dispatch);
    if (item.dispatch.previous_dispatch_id !== null) connect(id, item.dispatch.previous_dispatch_id);
    if (item.supersession) connect(id, item.supersession.verified_dispatch_id);
    if ((item.capsule || item.consumption) && !item.supersession) {
      for (const [otherId, other] of evidence) {
        if (otherId !== id && (other.completion || other.terminal)
          && sameDispatchScope(item.dispatch, other.dispatch)) connect(id, otherId);
      }
    }
  }
  // Live inventory is always re-read under the same capacity lock; callers can only add protection.
  const protectedIds = cleanupProtectedDispatchIds(rootDir, activeMarkers, now, markerInventory);
  return { evidence, edges, protectedIds };
}
function cleanupProtectedDispatchIds(rootDir, activeMarkers, now, markerInventory) {
  const live = markerInventory ? markerInventory() : listPostPrCompletionMarkers(process.cwd(), now, { pruneStale: false });
  if (!Array.isArray(live)) throw collision("cleanup marker inventory is unreadable");
  const protectedIds = protectedDispatchLineageForMarkers(rootDir, [...live, ...activeMarkers]);
  if (protectedIds === null) throw collision("cleanup marker inventory is unbound or incomplete");
  return protectedIds;
}
function dependencyComponent(inventory, seed) {
  const members = new Set(), queue = [seed];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (members.has(id)) continue;
    members.add(id);
    for (const neighbor of inventory.edges.get(id)) if (!members.has(neighbor)) queue.push(neighbor);
  }
  return [...members].sort();
}
function componentRetentionReason(item, protectedIds, now) {
  if (item.dispatch.lineage_approval_receipt_id !== undefined) {
    const created = Date.parse(item.dispatch.lineage_approval_receipt?.created_at);
    if (!Number.isFinite(created) || now <= created + LINEAGE_APPROVAL_MAX_AGE_MS) return "lineage-approval-audit-retained";
  }
  if (item.operatorAbandonment?.present) return "operator-abandonment-audit-retained";
  if (item.operatorDisposition) return "operator-disposition-audit-retained";
  if (item.lifecycleSlot?.record?.kind === "stale_reservation_closed") return "stale-reservation-audit-retained";
  if (protectedIds.has(item.dispatch.dispatch_id)) return "marker-present";
  if (item.capsule && !item.consumption) return "unconsumed";
  if (item.consumption && !item.supersession) return "retained-fault-dependency";
  const state = boundedDirectoryCleanupState(item, now);
  if (!state) return "incomplete-or-unbounded-directory";
  if (state.age < COMPLETE_CHAIN_OWNER_TTL_MS) return "owner-ttl";
  return null;
}
function createRetirementPlan(rootDir, inventory, members, now, checkpoint = null) {
  const plan = { schema: RETIREMENT_SCHEMA, plan_id: randomUUID(), root_identity_sha256: sha256(path.resolve(rootDir)),
    created_at: new Date(now).toISOString(), members: members.map((id) => {
      const item = inventory.evidence.get(id);
      return { dispatch_id: id, reservation: item.dispatch, reservation_sha256: sha256(item.dispatchBytes),
        files: readdirSync(item.directory).sort().map((name) => {
          const file = path.join(item.directory, name), stat = lstatSync(file);
          if (!stat.isFile() || !retirementFileAllowed(name)) throw retirementError(rootDir, "admission inventory changed");
          const bytes = readFileSync(file);
          return { name, size: bytes.length, sha256: sha256(bytes) };
        }) };
    }) };
  publishImmutable(path.join(rootDir, RETIREMENT_FILE), canonicalBytes(plan, MAX_BYTES_PER_REPOSITORY), { idempotent: false, checkpoint });
  return readRetirementManifest(rootDir);
}

function cleanupOutcome({ eligible = false, cleaned = false, reason, scope }) {
  return { eligible, cleaned, reason, scope };
}

function boundedDirectoryCleanupState(evidence, now) {
  const knownPaths = new Set(Object.values(evidence.paths));
  const entries = readdirSync(evidence.directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(evidence.directory, entry.name);
    if (!entry.isFile()) return null;
    const allowlistedCompanion = CONTROL_EVIDENCE_CLEANUP_COMPANION_FILES.has(entry.name)
      || isUsageManifestAtomicTempFileName(entry.name);
    if (!knownPaths.has(filePath) && !allowlistedCompanion) return null;
    files.push(filePath);
  }
  if (files.length === 0 || files.length > MAX_EVIDENCE_FILES) return null;
  const stats = files.map((filePath) => statSync(filePath));
  const totalBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
  if (totalBytes > MAX_DISPATCH_EVIDENCE_BYTES) return null;
  const newestMtime = Math.max(...stats.map((stat) => stat.mtimeMs));
  return { age: Math.max(0, now - newestMtime) };
}

function sameDispatchScope(left, right) {
  return left.repository_slug === right.repository_slug
    && left.pr_number === right.pr_number
    && left.head_ref_oid === right.head_ref_oid
    && left.attempt_id === right.attempt_id;
}


function markerHasCompleteDispatchBinding(marker) {
  return typeof marker?.repository_slug === "string"
    && marker.repository_slug.length > 0
    && String(marker?.prNumber ?? marker?.pr_number ?? "").length > 0
    && typeof marker?.head_ref_oid === "string"
    && marker.head_ref_oid.length > 0
    && typeof marker?.expected_dispatch_id === "string"
    && marker.expected_dispatch_id.length > 0;
}

function protectedDispatchLineageForMarkers(rootDir, activeMarkers) {
  const protectedDispatchIds = new Set();
  for (const marker of activeMarkers) {
    if (!markerHasCompleteDispatchBinding(marker)) return null;
    const markerPrNumber = String(marker.prNumber ?? marker.pr_number ?? "");
    let cursor = readCanonicalDispatchReservation(rootDir, marker.expected_dispatch_id);
    if (cursor.repository_slug !== marker.repository_slug
      || cursor.pr_number !== markerPrNumber
      || cursor.head_ref_oid !== marker.head_ref_oid
      || cursor.dispatch_id !== marker.expected_dispatch_id) {
      return null;
    }
    const visited = new Set();
    let complete = false;
    for (let depth = 0; depth < MAX_DISPATCHES_PER_PR_LINEAGE; depth += 1) {
      if (visited.has(cursor.dispatch_id)) return null;
      visited.add(cursor.dispatch_id);
      protectedDispatchIds.add(cursor.dispatch_id);
      if (cursor.previous_dispatch_id === null) {
        complete = true;
        break;
      }
      assertDirectPredecessor(rootDir, cursor);
      cursor = readCanonicalDispatchReservation(rootDir, cursor.previous_dispatch_id);
    }
    if (!complete) return null;
  }
  return protectedDispatchIds;
}

function removeConsumedCapsule(evidence) {
  if (!evidence.capsule) {
    return cleanupOutcome({
      reason: "capsule-already-cleaned",
      scope: "capsule-only",
    });
  }
  try {
    unlinkSync(evidence.paths.capsule);
    fsyncDirectory(evidence.directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return cleanupOutcome({
      reason: "capsule-already-cleaned",
      scope: "capsule-only",
    });
  }
  return cleanupOutcome({
    eligible: true,
    cleaned: true,
    reason: "cleaned",
    scope: "capsule-only",
  });
}


export async function cleanupDispatchEvidence({
  rootDir = controlEvidenceRoot(), dispatchId, markerPresent = false, activeMarkers = [],
  markerInventory = null, now = Date.now(),
}) {
  const root = path.resolve(rootDir);
  if (!existsSync(root)) return cleanupOutcome({ reason: "already-cleaned", scope: "complete-chain-directory" });
  return withLifecycleLock(root, () => {
    assertRetirementFence(root, dispatchId);
    if (!existsSync(dispatchDir(root, dispatchId))) return cleanupOutcome({ reason: "already-cleaned", scope: "complete-chain-directory" });
    const item = readDispatchEvidence({ rootDir: root, dispatchId });
    const ownReason = componentRetentionReason(item, new Set(markerPresent ? [dispatchId] : []), now);
    if (ownReason && ["lineage-approval-audit-retained", "operator-abandonment-audit-retained", "operator-disposition-audit-retained", "stale-reservation-audit-retained", "unconsumed"].includes(ownReason)) {
      return cleanupOutcome({ reason: ownReason, scope: ownReason === "unconsumed" ? "capsule-only" : "complete-chain-directory" });
    }
    if (item.consumption && (markerPresent || !item.supersession)) return removeConsumedCapsule(item);
    let inventory;
    try { inventory = cleanupComponentInventory(root, activeMarkers, now, markerInventory); }
    catch (error) {
      if (error?.classification === "retirement_recovery_required") throw error;
      return cleanupOutcome({ reason: "incomplete-evidence", scope: "complete-chain-directory" });
    }
    if (markerPresent) inventory.protectedIds.add(dispatchId);
    const members = dependencyComponent(inventory, dispatchId);
    for (const id of members) {
      const reason = componentRetentionReason(inventory.evidence.get(id), inventory.protectedIds, now);
      if (reason) return cleanupOutcome({ reason, scope: reason === "unconsumed" ? "capsule-only" : "complete-chain-directory" });
    }
    if (members.length > 1) return cleanupOutcome({ reason: "owner-component-cleanup-required", scope: "complete-chain-directory" });
    if (readRetirementManifest(root)) return cleanupOutcome({ reason: "owner-retirement-pending", scope: "complete-chain-directory" });
    try { inventory.protectedIds = cleanupProtectedDispatchIds(root, activeMarkers, now, markerInventory); }
    catch { return cleanupOutcome({ reason: "incomplete-evidence", scope: "complete-chain-directory" }); }
    if (inventory.protectedIds.has(dispatchId)) return cleanupOutcome({ reason: "marker-present", scope: "complete-chain-directory" });
    const plan = createRetirementPlan(root, inventory, members, now);
    const results = [];
    resumeRetirement(root, plan, { budgetHit: () => false, maxCleanup: null }, results);
    const { dispatchId: cleanedId, ...result } = results[0];
    return result;
  });
}

function cleanupRetainedUsageManifests(rootDir, now) {
  // The writer and sweep use this root's capacity lock; the writer holds it
  // from temp creation through rename. Lock recovery also refuses to reclaim a
  // lock while its owner PID is live, regardless of age, so a temp seen here is
  // abandoned rather than an in-flight writer's file.
  const releaseCapacityLock = acquireEvidenceLock(rootDir);
  const result = { scanned: 0, expired: 0, capacityEvicted: 0, errors: [] };
  try {
    const retentionDirectory = path.join(rootDir, USAGE_MANIFEST_RETENTION_DIRECTORY);
    let directoryStat;
    try {
      directoryStat = lstatSync(retentionDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return result;
      throw error;
    }
    if (!directoryStat.isDirectory()) return result;

    const retained = [];
    for (const entry of readdirSync(retentionDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (isUsageManifestAtomicTempFileName(entry.name)) {
        const tempPath = path.join(retentionDirectory, entry.name);
        try {
          const tempStat = lstatSync(tempPath);
          if (tempStat.isFile()) {
            unlinkSync(tempPath);
            fsyncDirectory(retentionDirectory);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            result.errors.push({
              operation: "remove-manifest-temp",
              fileName: entry.name,
              message: String(error?.message ?? error),
            });
          }
        }
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const dispatchId = entry.name.slice(0, -5);
      if (!isValidDispatchId(dispatchId)) continue;
      const filePath = path.join(retentionDirectory, entry.name);
      try {
        const fileStat = lstatSync(filePath);
        if (!fileStat.isFile()) continue;
        const record = JSON.parse(readFileSync(filePath, "utf8"));
        if (!record || typeof record !== "object" || Array.isArray(record)
          || record.schema !== USAGE_MANIFEST_SCHEMA
          || record.dispatch_id !== dispatchId) continue;
        retained.push({ dispatchId, filePath, mtimeMs: fileStat.mtimeMs });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          result.errors.push({ dispatchId, operation: "inspect", message: String(error?.message ?? error) });
        }
      }
    }
    result.scanned = retained.length;

    const remove = (item, category) => {
      try {
        unlinkSync(item.filePath);
        fsyncDirectory(retentionDirectory);
        result[category] += 1;
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        result.errors.push({
          dispatchId: item.dispatchId,
          operation: "remove",
          message: String(error?.message ?? error),
        });
        return false;
      }
    };

    const cutoff = now - USAGE_MANIFEST_RETENTION_MAX_AGE_MS;
    const recent = [];
    for (const item of retained) {
      if (item.mtimeMs < cutoff) remove(item, "expired");
      else recent.push(item);
    }
    recent.sort((left, right) => left.mtimeMs - right.mtimeMs
      || left.dispatchId.localeCompare(right.dispatchId));
    let remaining = recent.length;
    for (const item of recent) {
      if (remaining <= USAGE_MANIFEST_RETENTION_MAX_COPIES) break;
      if (remove(item, "capacityEvicted")) remaining -= 1;
    }
    return result;
  } finally {
    releaseCapacityLock();
  }
}

export async function cleanupOwnedControlEvidence({
  rootDir = controlEvidenceRoot(), activeMarkers = [], now = Date.now(), budgetMs = null,
  maxInspect = null, maxCleanup = null, markerInventory = null, retirementCheckpoint: checkpoint = null,
} = {}) {
  if (!Array.isArray(activeMarkers)) throw collision("active marker set must be an array");
  const root = path.resolve(rootDir);
  const window = budgetMs == null ? null : Math.max(0, Number(budgetMs) || 0);
  const deadline = window === null ? null : Date.now() + window;
  const budgetHit = () => deadline !== null && Date.now() >= deadline;
  const cap = Number.isInteger(maxCleanup) && maxCleanup >= 0 ? maxCleanup : null;
  const inspectCap = Number.isInteger(maxInspect) && maxInspect >= 0 ? maxInspect : null;
  const results = [];
  let completedOutcome;
  const outcome = (scanned = 0, inspected = 0, budgetExhausted = false, extra = {}) => (completedOutcome = { scanned, inspected,
    cleanedCapsules: results.filter((result) => result.cleaned && result.scope === "capsule-only").length,
    cleanedDirectories: results.filter((result) => result.cleaned && result.scope === "complete-chain-directory").length,
    results, budgetExhausted, cleaned_in_run: results.filter((result) => result.cleaned).length, ...extra });
  if (!existsSync(root)) return outcome();
  // Zero budget must not even publish a cursor, sweep retained files or take a writer lock.
  if (window === 0 || cap === 0) {
    results.push({ dispatchId: null, ...cleanupOutcome({ reason: "budget-exhausted", scope: "repository-scan" }) });
    return outcome(0, 0, true);
  }
  return withLifecycleLock(root, () => {
    let primaryError, sweepEnabled = inspectCap !== 0;
    try {
      let plan = readRetirementManifest(root);
      if (plan) {
        sweepEnabled = true;
        const done = resumeRetirement(root, plan, { budgetHit, maxCleanup: cap, checkpoint }, results);
        if (!done || budgetHit() || (cap !== null && results.length >= cap)) return outcome(0, 0, !done);
      }
      if (inspectCap === 0) return outcome(0, 0, true);
      let inventory;
      try { inventory = cleanupComponentInventory(root, activeMarkers, now, markerInventory); }
      catch (error) {
        if (error?.classification === "retirement_recovery_required" || String(error?.classification ?? "").includes("capacity")) throw error;
        results.push({ dispatchId: null, ...cleanupOutcome({ reason: "incomplete-evidence", scope: "repository-scan" }), message: error.message });
        return outcome();
      }
      const ids = [...inventory.evidence.keys()].sort();
      const cursorPath = path.join(root, CLEANUP_SCAN_CURSOR_FILE);
      let start = 0;
      try { const cursor = JSON.parse(readFileSync(cursorPath, "utf8")); if (Number.isInteger(cursor.next_index) && cursor.next_index >= 0 && ids.length) start = cursor.next_index % ids.length; } catch {}
      const rotated = ids.slice(start).concat(ids.slice(0, start));
      const visited = new Set();
      let inspected = 0, exhausted = false, last = null;
      for (const seed of rotated) {
        if (visited.has(seed)) continue;
        const cleanedCount = results.filter((row) => row.cleaned && row.scope === "complete-chain-directory").length;
        if ((inspected > 0 && budgetHit()) || (cap !== null && cleanedCount >= cap) || (inspectCap !== null && inspected >= inspectCap)) { exhausted = true; break; }
        inspected += 1; last = seed;
        const members = dependencyComponent(inventory, seed);
        for (const id of members) visited.add(id);
        let reason = null;
        for (const id of members) {
          reason = componentRetentionReason(inventory.evidence.get(id), inventory.protectedIds, now);
          if (reason) break;
        }
        if (reason) {
          for (const id of members) {
            const item = inventory.evidence.get(id);
            const ownReason = componentRetentionReason(item, inventory.protectedIds, now);
            const auditRetained = ["lineage-approval-audit-retained", "operator-abandonment-audit-retained", "stale-reservation-audit-retained"].includes(ownReason);
            if (!auditRetained && item.consumption && (inventory.protectedIds.has(id) || !item.supersession)) {
              results.push({ dispatchId: id, ...removeConsumedCapsule(item) });
            } else {
              const retainedReason = auditRetained ? ownReason : reason;
              results.push({ dispatchId: id, ...cleanupOutcome({ reason: retainedReason, scope: retainedReason === "unconsumed" ? "capsule-only" : "complete-chain-directory" }) });
            }
          }
          continue;
        }
        // Unbound PR-creation authorities can arrive without reserving a new dispatch.
        // Re-read marker inventory at every commit, without taking the marker lock.
        retirementCheckpoint(checkpoint, "admission-before-marker-read", { dispatchId: seed });
        try { inventory.protectedIds = cleanupProtectedDispatchIds(root, activeMarkers, now, markerInventory); }
        catch (error) {
          results.push({ dispatchId: seed, ...cleanupOutcome({ reason: "incomplete-evidence", scope: "complete-chain-directory" }), message: error.message });
          continue;
        }
        const newlyProtected = members.some((id) => inventory.protectedIds.has(id));
        if (newlyProtected) {
          for (const id of members) results.push({ dispatchId: id, ...cleanupOutcome({ reason: "marker-present", scope: "complete-chain-directory" }) });
          continue;
        }
        // Admission is atomic and uses the complete bounded graph even if only one seed was selected.
        plan = createRetirementPlan(root, inventory, members, now, checkpoint);
        retirementCheckpoint(checkpoint, "manifest-published", { planId: plan.plan_id });
        if (budgetHit()) { exhausted = true; break; }
        if (!resumeRetirement(root, plan, { budgetHit, maxCleanup: cap === null ? null : cap - cleanedCount, checkpoint }, results)) { exhausted = true; break; }
      }
      if (exhausted) results.push({ dispatchId: null, ...cleanupOutcome({ reason: "budget-exhausted", scope: "repository-scan" }) });
      // Persist the completed bounded attempt's next seed even when it spent the budget;
      // otherwise a retained prefix starves later eligible components on every invocation.
      if (ids.length && last !== null && (window !== null || inspectCap !== null || cap !== null)) {
        const next = (ids.indexOf(last) + 1) % ids.length;
        try { writeFileSync(cursorPath, `${JSON.stringify({ next_index: next, updated_at: new Date(now).toISOString() })}\n`, "utf8"); } catch {}
      }
      return outcome(ids.length, inspected, exhausted, { scan_start_index: start, last_cleanup_attempted_id: last });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // Retention is existing owner housekeeping, independent of the component
      // soft deadline. Finish it once, after any available seed bookkeeping.
      if (sweepEnabled) {
        let retentionCleanup;
        try { retentionCleanup = cleanupRetainedUsageManifests(root, now); }
        catch (error) {
          retentionCleanup = { scanned: 0, expired: 0, capacityEvicted: 0,
            errors: [{ operation: "sweep", message: String(error?.message ?? error) }] };
        }
        // Never replace a primary failure, including an immutable Error object.
        try {
          if (completedOutcome) completedOutcome.retentionCleanup = retentionCleanup;
          else if (primaryError && typeof primaryError === "object") primaryError.retentionCleanup = retentionCleanup;
        } catch {}
      }
    }
  });
}
