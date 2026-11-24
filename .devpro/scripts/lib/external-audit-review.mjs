import { parseJsonDuplicateAware } from "./json-duplicate-aware.mjs";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { MODEL_FAMILY_PATTERNS } from "../hooks/lib/second-review-sticky-authority.mjs";
import { SECOND_REVIEW_VERDICT_REASON_MAX_BYTES } from "../second-review-material-contract.mjs";
import { GUARANTEE_ASSESSMENT_SCHEMA, guaranteeReviewedTarget, validateReviewGuaranteeAssessment } from "../review-guarantee-assessment.mjs";

export const EXTERNAL_AUDIT_REVIEW_SCHEMA = "devpro-external-audit-review/v1";
export const EXTERNAL_AUDIT_REPORT_BASENAME = "external-audit-review.json";
export const EXTERNAL_AUDIT_REPORT_MAX_BYTES = 64 * 1024;
export const EXTERNAL_AUDIT_PACKET_MARKER = "# Devpro External Audit Evaluator\n";
export const AUDIT_FINDING_SEVERITIES = Object.freeze(["Critical", "Important", "Suggestion"]);
const REPORT_KEYS = [
  "schema", "repository_slug", "head_ref_oid", "attempt_id", "dispatch_id", "review_data_sha256",
  "reviewer_tool", "reviewer_model", "verdict", "reason", "findings", "guarantee_assessment",
];

function fail(message, classification = "external_audit_report_invalid") {
  const error = new Error(message);
  error.classification = classification;
  throw error;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} must contain the exact canonical fields`);
  }
}

const nonblank = (value) => typeof value === "string" && value.trim() !== "" && value === value.trim();

export function externalAuditReviewDataSha256(data) {
  return createHash("sha256").update(JSON.stringify(data), "utf8").digest("hex");
}

/**
 * 驗證已解析的 external audit 報告是否符合 v1 schema、綁定同一張 audit dispatch，且 findings 與 guarantee assessment 一致。
 * 由 parseExternalAuditReview（以及 TL 接受 audit 時）呼叫；不讀檔、不碰 GitHub。
 * fail closed：身分欄位不符拋 external_audit_report_binding_mismatch，工具／模型不符拋 external_audit_provenance_mismatch，
 * dispatch 不是 audit-only 拋 reviewer_dispatch_identity_collision，其餘格式問題拋 external_audit_report_invalid（錯誤帶 classification）。
 * @param {object} report 解析後的報告物件
 * @param {{ dispatch: object, target: string }} options 對應的 dispatch record 與審查標的文字
 * @returns {{ report: object, assessment: object|null }}
 */
export function validateExternalAuditReview(report, { dispatch, target }) {
  exactKeys(report, REPORT_KEYS, "audit report");
  if (report.schema !== EXTERNAL_AUDIT_REVIEW_SCHEMA) fail("audit report schema is unsupported");
  if (dispatch.executor_kind !== "external-evaluator" || dispatch.mode !== "audit-only" || dispatch.pr_number !== "none") {
    fail("audit report requires an external audit dispatch", "reviewer_dispatch_identity_collision");
  }
  for (const field of ["repository_slug", "head_ref_oid", "attempt_id", "dispatch_id", "review_data_sha256"]) {
    if (report[field] !== dispatch[field]) {
      fail(`audit report ${field} does not match its dispatch`, "external_audit_report_binding_mismatch");
    }
  }
  const pattern = MODEL_FAMILY_PATTERNS[dispatch.reviewer_family];
  if (report.reviewer_tool !== dispatch.reviewer_tool || !nonblank(report.reviewer_model)
    || !pattern || !pattern.test(report.reviewer_model)) {
    fail("audit report tool/model does not match its dispatch", "external_audit_provenance_mismatch");
  }
  if (!["PASS", "WARN", "CRITICAL", "UNAVAILABLE"].includes(report.verdict)) fail("audit verdict is unsupported");
  if (!nonblank(report.reason) || /^<.*>$/u.test(report.reason) || Buffer.byteLength(report.reason, "utf8") > SECOND_REVIEW_VERDICT_REASON_MAX_BYTES) {
    fail("audit reason must be nonblank and within the shared reason byte limit");
  }
  if (!Array.isArray(report.findings)) fail("audit findings must be an array");
  const ids = new Set();
  for (const finding of report.findings) {
    exactKeys(finding, ["id", "severity", "carrier", "description"], "audit finding");
    if (!Object.values(finding).every(nonblank) || ids.has(finding.id)
      || !AUDIT_FINDING_SEVERITIES.includes(finding.severity)) fail("audit finding fields or identifiers are invalid");
    if (/^(?:[/\\]|[A-Za-z][A-Za-z0-9+.-]*:)|(?:^|[\\/])\.\.(?:[\\/]|$)|[\u0000-\u001f\u007f]/u.test(finding.carrier)) {
      fail("audit finding carrier must be repo-relative or a section anchor");
    }
    ids.add(finding.id);
  }
  let assessment = null;
  if (report.guarantee_assessment !== null || ["PASS", "WARN"].includes(report.verdict)) {
    try {
      assessment = validateReviewGuaranteeAssessment(report.guarantee_assessment, {
        reviewedTarget: guaranteeReviewedTarget({ head_ref_oid: dispatch.head_ref_oid, target }),
        dispatchId: dispatch.dispatch_id,
        findingIds: [...ids],
      });
    } catch (error) {
      fail(error.message);
    }
    if (["PASS", "WARN"].includes(report.verdict) && assessment.requires_clarification) {
      fail("PASS/WARN audit requires clarification of unresolved guarantee assessments");
    }
  }
  return { report, assessment };
}

/**
 * 把 audit 報告的原始 bytes 解成 JSON（重複 key、非 UTF-8、超過 64 KiB 都拒絕）後交給 validateExternalAuditReview。
 * accept-external-second-review 的 audit 流程讀到報告檔後呼叫；失敗一律拋帶 classification 的錯誤，預設 external_audit_report_invalid。
 * @param {Buffer} bytes 報告檔內容
 * @param {{ dispatch: object, target: string }} options
 * @returns {{ report: object, assessment: object|null }}
 */
export function parseExternalAuditReview(bytes, options) {
  if (!Buffer.isBuffer(bytes) || bytes.length > EXTERNAL_AUDIT_REPORT_MAX_BYTES) {
    fail("audit report exceeds its 64 KiB byte bound");
  }
  let report;
  try {
    report = parseJsonDuplicateAware(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("audit report must be valid UTF-8 JSON");
  }
  return validateExternalAuditReview(report, options);
}

/**
 * 產生 audit 票上給審查者看的報告範例：身分欄位填入本張票的真值，reviewer_model 與 reason 留佔位字串。
 * 只供 renderer 印在票上；佔位字串原樣交回會被 validateExternalAuditReview 拒絕，不能拿來當報告。
 * @returns {object}
 */
export function externalAuditReportExample({ repositorySlug, headRefOid, attemptId, dispatchId, reviewDataSha256, reviewerTool, target }) {
  return {
    schema: EXTERNAL_AUDIT_REVIEW_SCHEMA,
    repository_slug: repositorySlug,
    head_ref_oid: headRefOid,
    attempt_id: attemptId,
    dispatch_id: dispatchId,
    review_data_sha256: reviewDataSha256,
    reviewer_tool: reviewerTool,
    reviewer_model: "<actual-model>",
    verdict: "PASS",
    reason: "<actual-bounded-review-reason>",
    findings: [],
    guarantee_assessment: {
      schema: GUARANTEE_ASSESSMENT_SCHEMA,
      reviewed_target: guaranteeReviewedTarget({ head_ref_oid: headRefOid, target }),
      dispatch_id: dispatchId,
      assessments: [],
    },
  };
}
