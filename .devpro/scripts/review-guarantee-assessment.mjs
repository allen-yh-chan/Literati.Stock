#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GUARANTEE_ASSESSMENT_SCHEMA = "devpro.review-guarantee-assessment/v1";
export const GUARANTEE_ASSESSMENT_HEADING = "## Guarantee Assessment";
// Executable transport projection of the canonical code-review-checklist spec.
// Output duties are unconditional, independent of trigger-scoped review criteria.
export function secondReviewGuaranteeOutputContractLines({ external = false, auditArtifact = false } = {}) {
  return [
    "## Guarantee Assessment Output Contract",
    "guarantee_assessment_required: true for this newly rendered dispatch, including reviews unrelated to guarantees.",
    auditArtifact ? "PASS/WARN audit report MUST contain the structured guarantee_assessment object; do not embed a second Markdown assessment in reason." : external ? `PASS/WARN sticky MUST contain one literal ${GUARANTEE_ASSESSMENT_HEADING} heading followed immediately by one json fence; no completion JSON is required on this external route.` : `PASS/WARN completion reason MUST contain one literal ${GUARANTEE_ASSESSMENT_HEADING} heading followed immediately by one json fence. For pr-sticky, copy that section unchanged into the sticky. Audit-only returns the section in completion reason without writing a sticky.`,
    ...(auditArtifact ? [] : [`For PASS/WARN on every pr-sticky route, body order is: one-line reason, optional tracked_follow_up lines, exactly one ${GUARANTEE_ASSESSMENT_HEADING} section, provenance footer.`]),
    `The fenced object has exactly schema, reviewed_target, dispatch_id, assessments; schema is ${GUARANTEE_ASSESSMENT_SCHEMA}. reviewed_target copies framed head_ref_oid when not none, otherwise framed target; dispatch_id copies the current dispatch.`,
    "Every assessment has exactly finding_id, guarantee_ceiling, classification, rationale; all strings are trimmed/nonblank, IDs unique. Name the existing owner and promised mechanical/cooperative checks and limits; classification is within-ceiling, above-ceiling or unresolved. Cover every finding this response reports; when paged, cover exactly the current window's completion findings[].summary_id values, never findings_ledger entries from earlier windows even though the final sticky aggregates them; no findings means assessments: [].",
    "unresolved requires clarification before PASS/WARN; above-ceiling requires a reasoned TL ruling and never automatically downgrades severity or closes a finding. Existing security/compliance, overclaim and spec/code review floor remains.",
    "CRITICAL stays blocking and may report an actual assessment; missing assessment must not replace its existing classification. UNAVAILABLE/fault stays unavailable and does not require or manufacture an assessment.",
    ...(external ? [] : ["The final response remains the existing five/eleven-key Completion JSON; JSON-escape the section inside reason, never add a completion key or an outer Markdown fence."]),
    "",
  ];
}
const classifications = new Map([
  ["within-ceiling", "apply-existing-finding-rules"],
  ["above-ceiling", "tl-ruling-required"],
  ["unresolved", "clarification-required"],
]);
const textValue = value => typeof value === "string" && value.trim() !== "" && value === value.trim();
function fail(message) { throw new Error(`review_guarantee_assessment_invalid: ${message}`); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail(`${label} has invalid fields`);
  }
}

export function guaranteeAssessmentRequired(context) {
  if (Object.hasOwn(context, "guarantee_assessment_required")
    && typeof context.guarantee_assessment_required !== "boolean") fail("activation must be boolean");
  return context.guarantee_assessment_required === true;
}

export function guaranteeReviewedTarget(context) {
  return context.head_ref_oid && context.head_ref_oid !== "none"
    ? context.head_ref_oid : context.target ?? "none";
}

export function readReviewGuaranteeAssessment(text, { reviewedTarget, dispatchId, findingIds } = {}) {
  if (!textValue(reviewedTarget) || !textValue(dispatchId)) fail("consumer target and dispatch are required");
  if (typeof text !== "string") fail("report must be text");
  const normalized = text.replace(/\r\n/g, "\n");
  const headings = [...normalized.matchAll(/^## Guarantee Assessment\n/gm)];
  if (headings.length !== 1) fail("report requires exactly one Guarantee Assessment section");
  const section = normalized.slice(headings[0].index);
  const block = /^## Guarantee Assessment\n```json\n([\s\S]*?)\n```(?:\n|$)/u.exec(section);
  let raw;
  if (block) {
    raw = block[1];
    const tail = section.slice(block[0].length).split(/^## /m)[0];
    if (/^```/m.test(tail)) fail("assessment section has more than one fence");
  } else {
    // 2026-11-02 事故：審查者把 JSON 直接寫在 heading 下、沒有 fence，就被判
    // reviewer_completion_contract_invalid 並中止整條派送。這裡容忍「heading 後只有一段 JSON」
    // 的形狀（schema／target／dispatch 仍照驗），並留一行 advisory 讓 TL 知道格式有瑕疵。
    const after = section.replace(/^## Guarantee Assessment\n/u, "").split(/^## /m)[0].trim();
    if (!after || after.startsWith("```")) fail("section requires one JSON fence immediately after its heading");
    process.stderr.write("guarantee_assessment_unfenced: accepted an assessment section without a json fence (schema still validated)\n");
    raw = after;
  }
  let report;
  try { report = JSON.parse(raw); } catch { fail("assessment JSON is malformed"); }
  return validateReviewGuaranteeAssessment(report, { reviewedTarget, dispatchId, findingIds });
}

export function validateReviewGuaranteeAssessment(report, { reviewedTarget, dispatchId, findingIds } = {}) {
  if (!textValue(reviewedTarget) || !textValue(dispatchId)) fail("consumer target and dispatch are required");
  exactKeys(report, ["schema", "reviewed_target", "dispatch_id", "assessments"], "assessment report");
  if (report.schema !== GUARANTEE_ASSESSMENT_SCHEMA) fail("assessment schema is unsupported");
  if (report.reviewed_target !== reviewedTarget) fail("reviewed target does not match; regenerate for the current target");
  if (report.dispatch_id !== dispatchId) fail("dispatch does not match; use this handoff's dispatch");
  if (!Array.isArray(report.assessments)) fail("assessments must be an array");
  const ids = new Set();
  const nextActions = [];
  for (const assessment of report.assessments) {
    exactKeys(assessment, ["finding_id", "guarantee_ceiling", "classification", "rationale"], "assessment");
    if (Object.values(assessment).some(value => !textValue(value))) fail("assessment values must be nonblank trimmed strings");
    if (ids.has(assessment.finding_id)) fail("assessment repeats a finding_id");
    ids.add(assessment.finding_id);
    if (!classifications.has(assessment.classification)) fail("classification must be within-ceiling, above-ceiling or unresolved");
    nextActions.push({ finding_id: assessment.finding_id, action: classifications.get(assessment.classification) });
  }
  if (findingIds !== undefined) {
    if (!Array.isArray(findingIds) || findingIds.some(id => !textValue(id))
      || new Set(findingIds).size !== findingIds.length) fail("consumer finding identifiers are invalid");
    if (findingIds.length !== ids.size || findingIds.some(id => !ids.has(id))) fail("assessment identifiers must match every structured finding");
  }
  return {
    report,
    next_actions: nextActions,
    requires_clarification: nextActions.some(item => item.action === "clarification-required"),
    requires_tl_ruling: nextActions.some(item => item.action === "tl-ruling-required"),
  };
}

export function runGuaranteeAssessmentCheck(argv) {
  if (argv[0] === "--receipt") {
    if (argv.length !== 2 || !textValue(argv[1])) fail("receipt check requires one receipt path");
    const receipt = JSON.parse(readFileSync(argv[1], "utf8"));
    const payload = receipt.reviewer_payload ?? receipt;
    if (!Array.isArray(payload.findings)) fail("receipt must contain structured findings");
    if (!Object.hasOwn(payload, "guarantee_assessment")) fail("receipt is missing guarantee_assessment; regenerate the fresh review before TL acceptance");
    const result = validateReviewGuaranteeAssessment(payload.guarantee_assessment, {
      reviewedTarget: payload.lineage?.head_sha, dispatchId: payload.dispatch_id,
      findingIds: payload.findings.map(finding => finding.finding_id),
    });
    return assessmentCheckResult(result);
  }
  const [reportPath, ...args] = argv;
  if (!reportPath) fail("usage: review-guarantee-assessment.mjs --receipt <receipt> | <report> --target <target> --dispatch <dispatch> [--finding-id <id>]");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--target", "--dispatch", "--finding-id"].includes(flag) || !textValue(value)) fail("invalid check arguments");
    if (flag === "--finding-id") (options.findingIds ??= []).push(value);
    else {
      if (Object.hasOwn(options, flag)) fail("check argument repeated");
      options[flag] = value;
    }
  }
  const binding = { reviewedTarget: options["--target"], dispatchId: options["--dispatch"], findingIds: options.findingIds };
  const result = readReviewGuaranteeAssessment(readFileSync(reportPath, "utf8"), binding);
  return assessmentCheckResult(result);
}

function assessmentCheckResult(result) {
  return { status: result.requires_clarification ? "clarification-required" : result.requires_tl_ruling ? "tl-ruling-required" : "checked", next_actions: result.next_actions };
}

function directInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (directInvocation()) {
  try {
    const result = runGuaranteeAssessmentCheck(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "clarification-required") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
