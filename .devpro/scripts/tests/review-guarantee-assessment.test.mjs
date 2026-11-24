import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { readReviewGuaranteeAssessment, validateReviewGuaranteeAssessment, guaranteeAssessmentRequired, secondReviewGuaranteeOutputContractLines } from "../review-guarantee-assessment.mjs";
import { SECOND_REVIEW_PACKET_STATIC_SUFFIX, secondReviewPacketStaticPrefix } from "../validate-second-review-packet.mjs";
import { __testReviewerClassification } from "../run-second-reviewer-projection.mjs";

const head = "a".repeat(40);
const context = { mode: "audit-only", head_ref_oid: head, dispatch_id: "dispatch-assessment", guarantee_assessment_required: true };
test("native and external sticky routes receive the same explicit body order", () => {
  for (const external of [false, true]) {
    const contract = secondReviewGuaranteeOutputContractLines({ external }).join("\n");
    assert.match(contract, /For PASS\/WARN on every pr-sticky route, body order is: one-line reason, optional tracked_follow_up lines, exactly one ## Guarantee Assessment section, provenance footer\./);
    assert.doesNotMatch(contract, /review-results area|bare reason/);
  }
});
test("a newly rendered unrelated review has an unconditional assessment output contract", () => {
  const prefix = secondReviewPacketStaticPrefix("Claude Code", "audit-only", context.dispatch_id);
  const from = prefix.indexOf("## Guarantee Assessment Output Contract");
  assert.ok(from >= 0, "output contract must be visible outside trigger-scoped criteria");
  assert.match(prefix.slice(from), /guarantee_assessment_required: true/);
  assert.match(prefix.slice(from), /PASS\/WARN completion reason MUST contain/);
});
function completion(reason = "No issues found.") {
  return JSON.stringify({ sticky_comment_url: "none", verdict: "PASS", last_reviewed_sha: head, reviewer_model: "test-reviewer", reason });
}

test("an unfenced assessment JSON after the heading is accepted with an advisory (2026-11-02 incident shape)", () => {
  // 審查者把 JSON 直接寫在 heading 下、沒有 ```json fence；舊版判 contract_invalid 整條中止。
  const body = `## Guarantee Assessment\n${JSON.stringify(report([]), null, 2)}`;
  const parsed = readReviewGuaranteeAssessment(body, { reviewedTarget: head, dispatchId: context.dispatch_id });
  assert.equal(parsed.report.reviewed_target, head);
  assert.deepEqual(parsed.report.assessments, []);
});

test("new runner refuses a forgotten assessment while historical completion stays readable", () => {
  const legacy = { ...context }; delete legacy.guarantee_assessment_required;
  assert.equal(__testReviewerClassification.parseCompletionObject(legacy, completion()).status, "accepted");
  assert.equal(__testReviewerClassification.parseCompletionObject(context, completion()).status, "malformed");
});

function report(assessments = []) {
  return { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: head, dispatch_id: context.dispatch_id, assessments };
}
function item(classification = "within-ceiling", findingId = "F1") {
  return { finding_id: findingId, guarantee_ceiling: "design-core: cooperative review; mechanical shape checks only", classification, rationale: "The observed omission occurs in the ordinary workflow." };
}
function section(value) {
  return "## Guarantee Assessment\n```json\n" + JSON.stringify(value) + "\n```";
}
const binding = { reviewedTarget: head, dispatchId: context.dispatch_id };

test("fresh single-shot output accepts an empty assessment without adding completion keys", () => {
  const result = __testReviewerClassification.parseCompletionObject(context, completion("No issues found.\n\n" + section(report())));
  assert.equal(result.status, "accepted");
  assert.equal(Object.keys(result.completion).length, 5);
});

test("within, above and unresolved return distinct consumer actions without changing findings", () => {
  const value = report([item(), item("above-ceiling", "F2"), item("unresolved", "F3")]);
  const before = JSON.stringify(value);
  const result = validateReviewGuaranteeAssessment(value, { ...binding, findingIds: ["F3", "F1", "F2"] });
  assert.deepEqual(result.next_actions.map(entry => entry.action), ["apply-existing-finding-rules", "tl-ruling-required", "clarification-required"]);
  assert.equal(result.requires_clarification, true);
  assert.equal(result.requires_tl_ruling, true);
  assert.equal(JSON.stringify(value), before);
  assert.equal(__testReviewerClassification.parseCompletionObject(context, completion(section(value))).status, "malformed");
  value.assessments.pop();
  assert.equal(__testReviewerClassification.parseCompletionObject(context, completion(section(value))).status, "accepted");
});

for (const [name, alter, diagnostic] of [
  ["missing rationale", value => delete value.assessments[0].rationale, /assessment has invalid fields/],
  ["blank rationale", value => { value.assessments[0].rationale = " "; }, /nonblank trimmed strings/],
  ["unsupported classification", value => { value.assessments[0].classification = "unknown"; }, /classification must be within-ceiling/],
  ["duplicate finding ID", value => value.assessments.push(item()), /repeats a finding_id/],
  ["wrong dispatch", value => { value.dispatch_id = "previous-dispatch"; }, /dispatch does not match/],
  ["unknown schema", value => { value.schema = "other/v2"; }, /schema is unsupported/],
  ["extra root key", value => { value.verdict = "PASS"; }, /assessment report has invalid fields/],
  ["non-array assessment", value => { value.assessments = null; }, /assessments must be an array/],
]) {
  test("reader diagnoses " + name, () => {
    const value = report([item()]); alter(value);
    assert.throws(() => readReviewGuaranteeAssessment(section(value), binding), diagnostic);
  });
}

test("reader refuses missing, duplicated and malformed sections; CRLF and footer remain usable", () => {
  const text = section(report());
  for (const bad of ["summary only", text + "\n" + text, "## Guarantee Assessment\n```json\n{\n```", text + "\n```json\n{}\n```"]) {
    assert.throws(() => readReviewGuaranteeAssessment(bad, binding), /review_guarantee_assessment_invalid/);
  }
  assert.equal(readReviewGuaranteeAssessment((text + "\nRules: test footer").replaceAll("\n", "\r\n"), binding).requires_clarification, false);
  assert.throws(() => guaranteeAssessmentRequired({ guarantee_assessment_required: "true" }), /activation must be boolean/);
});

test("structured finding coverage rejects omitted and extraneous IDs", () => {
  for (const findingIds of [[], ["F2"], ["F1", "F2"]]) {
    assert.throws(() => validateReviewGuaranteeAssessment(report([item()]), { ...binding, findingIds }), /match every structured finding/);
  }
});

test("paged eleven-field consumer checks this window's complete finding set", () => {
  const pagedContext = { ...context, page_window_checkpoint_handoff: true, page_window_index: 1, review_material: { pages: [{ index: 1 }] } };
  const value = {
    sticky_comment_url: "none", verdict: "WARN", last_reviewed_sha: head, reviewer_model: "test-reviewer", reason: section(report([item()])),
    window_index: 1, page_indices: [1], head_ref_oid: head, dispatch_id: context.dispatch_id,
    findings: [{ severity: "WARN", summary_id: "F1", summary: "Small omitted check." }], findings_payload_sha256: "opaque",
  };
  assert.equal(__testReviewerClassification.parseCompletionObject(pagedContext, JSON.stringify(value)).status, "accepted");
  value.reason = section(report());
  assert.equal(__testReviewerClassification.parseCompletionObject(pagedContext, JSON.stringify(value)).status, "malformed");
});

test("paged final window assesses only its own findings, not earlier windows' ledger entries", () => {
  // 2026-10-20 OpenCode run: the final window had findings [] but its assessment listed earlier windows' IDs.
  const finalContext = { ...context, page_window_checkpoint_handoff: true, page_window_index: 3, review_material: { window_role: "final", pages: [{ index: 3 }] } };
  const value = {
    sticky_comment_url: "none", verdict: "PASS", last_reviewed_sha: head, reviewer_model: "test-reviewer", reason: section(report([item("within-ceiling", "F1"), item("within-ceiling", "F2")])),
    window_index: 3, page_indices: [3], head_ref_oid: head, dispatch_id: context.dispatch_id,
    findings: [], findings_payload_sha256: "opaque",
  };
  assert.equal(__testReviewerClassification.parseCompletionObject(finalContext, JSON.stringify(value)).status, "malformed");
  value.reason = section(report());
  assert.equal(__testReviewerClassification.parseCompletionObject(finalContext, JSON.stringify(value)).status, "accepted");

  const contract = secondReviewGuaranteeOutputContractLines().join("\n");
  assert.match(contract, /when paged, cover exactly the current window's completion findings\[\]\.summary_id values, never findings_ledger entries from earlier windows/);
  const prefix = secondReviewPacketStaticPrefix("OpenCode", "pr-sticky", context.dispatch_id, null, "devpro-second-review-data/v5", { pageWindowCheckpointHandoff: true });
  assert.match(prefix, /final verdict and sticky MUST aggregate the entire findings_ledger/);
  assert.match(prefix, /its Guarantee Assessment still covers only this window's completion findings, not the ledger/);
});

test("receipt CLI reads actual payload binding and missing metadata never defaults to PASS", () => {
  const dir = makeTempDir("guarantee-receipt-cli-");
  const receiptPath = path.join(dir, "receipt.json");
  const cli = repoPath(".devpro/scripts/review-guarantee-assessment.mjs");
  const payload = { lineage: { head_sha: head }, dispatch_id: context.dispatch_id, findings: [{ finding_id: "F1", observation: { severity: "Important" } }] };
  const run = () => spawnSync(process.execPath, [cli, "--receipt", receiptPath], { encoding: "utf8" });
  try {
    writeFileSync(receiptPath, JSON.stringify({ reviewer_payload: payload }));
    assert.equal(run().status, 2);
    payload.guarantee_assessment = report([item("above-ceiling")]);
    writeFileSync(receiptPath, JSON.stringify({ reviewer_payload: payload }));
    const above = run();
    assert.equal(above.status, 0, above.stderr);
    assert.equal(JSON.parse(above.stdout).status, "tl-ruling-required");
    payload.guarantee_assessment.assessments[0].classification = "unresolved";
    writeFileSync(receiptPath, JSON.stringify({ reviewer_payload: payload }));
    assert.equal(run().status, 1);
    payload.guarantee_assessment.reviewed_target = "b".repeat(40);
    writeFileSync(receiptPath, JSON.stringify({ reviewer_payload: payload }));
    assert.equal(run().status, 2);
    assert.equal(payload.findings[0].observation.severity, "Important");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new runner refuses an assessment accidentally copied from another reviewed head", () => {
  const report = { schema: "devpro.review-guarantee-assessment/v1", reviewed_target: "b".repeat(40), dispatch_id: context.dispatch_id, assessments: [] };
  const reason = `No issues found.\n\n## Guarantee Assessment\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
  assert.equal(__testReviewerClassification.parseCompletionObject(context, completion(reason)).status, "malformed");
});

test("a symlink invocation executes the receipt CLI and reports a missing assessment", () => {
  const dir = makeTempDir("guarantee-cli-symlink-");
  try {
    const alias = path.join(dir, "assessment-alias.mjs");
    symlinkSync(repoPath(".devpro/scripts/review-guarantee-assessment.mjs"), alias, "file");
    const receipt = path.join(dir, "receipt.json");
    writeFileSync(receipt, JSON.stringify({ lineage: { head_sha: head }, dispatch_id: context.dispatch_id, findings: [] }));
    const result = spawnSync(process.execPath, [alias, "--receipt", receipt], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /receipt is missing guarantee_assessment/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("unavailable and critical retain their named blocking classification without assessment", () => {
  for (const verdict of ["UNAVAILABLE", "CRITICAL"]) {
    const output = JSON.parse(completion()); output.verdict = verdict;
    const result = __testReviewerClassification.parseCompletionObject(context, JSON.stringify(output));
    assert.equal(result.status, "blocking-verdict");
    assert.equal(result.completion.verdict, verdict);
  }
});

test("completion guidance names the assessment while the sticky template contains only body fields", () => {
  assert.match(SECOND_REVIEW_PACKET_STATIC_SUFFIX, /reason contains exactly one ## Guarantee Assessment section/);
  const prefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky", context.dispatch_id);
  const start = prefix.indexOf("<!-- cross-model-second-opinion:sticky -->");
  const end = prefix.indexOf("\nRules:", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(prefix.slice(start, end), /For PASS\/WARN|Output Contract section/);
});
