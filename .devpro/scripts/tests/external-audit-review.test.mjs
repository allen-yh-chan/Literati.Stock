import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { withTempDir } from "./lib/tmp.mjs";
import { validateExternalAuditReview, parseExternalAuditReview } from "../lib/external-audit-review.mjs";
import {
  reserveDispatchRecord, writeExternalClosureSlot, writeExternalCompletionReceipt,
  mirrorExternalAuditCompletionReceipt, readDispatchEvidenceStrict,
} from "../hooks/lib/second-review-control-evidence.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const dispatch = {
  schema: "devpro-second-review-dispatch/v1", repository_slug: "devpro/example", pr_number: "none",
  head_ref_oid: "none", attempt_id: "audit-fixture", dispatch_id: "dispatch-audit-fixture", previous_dispatch_id: null,
  packet_sha256: "a".repeat(64), carrier_root_id: "b".repeat(64), executor_kind: "external-evaluator", mode: "audit-only",
  reviewer_family: "openai-codex", primary_family: "claude", reviewer_tool: "Codex", review_data_sha256: "c".repeat(64),
  issued_at: "2026-01-01T00:00:00.000Z",
};
const target = "Bounded design fixture";
function report() {
  return {
    schema: "devpro-external-audit-review/v1", repository_slug: dispatch.repository_slug,
    head_ref_oid: "none", attempt_id: dispatch.attempt_id, dispatch_id: dispatch.dispatch_id,
    review_data_sha256: dispatch.review_data_sha256, reviewer_tool: "Codex", reviewer_model: "gpt-6",
    verdict: "PASS", reason: "The supplied design has one owner and preserves cancellation.", findings: [],
    guarantee_assessment: {
      schema: "devpro.review-guarantee-assessment/v1", reviewed_target: target,
      dispatch_id: dispatch.dispatch_id, assessments: [],
    },
  };
}
const validate = (value) => validateExternalAuditReview(value, { dispatch, target });

test("external audit report accepts bounded non-PR review with a real assessment", () => {
  assert.equal(validate(report()).report.verdict, "PASS");
});

for (const field of ["repository_slug", "head_ref_oid", "attempt_id", "dispatch_id", "review_data_sha256"]) {
  test(`external audit report rejects another ${field}`, () => {
    const value = report(); value[field] = "another";
    assert.throws(() => validate(value), { classification: "external_audit_report_binding_mismatch" });
  });
}
for (const field of ["reviewer_tool", "reviewer_model"]) {
  test(`external audit report rejects incorrect ${field}`, () => {
    const value = report(); value[field] = "Claude";
    assert.throws(() => validate(value), { classification: "external_audit_provenance_mismatch" });
  });
}
test("external audit report rejects sticky fields and an invented process close", () => {
  for (const field of ["sticky_comment_url", "process_close_observed"]) {
    assert.throws(() => validate({ ...report(), [field]: false }), { classification: "external_audit_report_invalid" });
  }
});
test("external audit report assessments must cover exactly its findings", () => {
  const value = report(); value.verdict = "WARN";
  value.findings = [{ id: "F-1-1", severity: "Important", carrier: "design.md#Ownership", description: "Cancellation has no owner." }];
  assert.throws(() => validate(value), /assessment identifiers must match every structured finding/);
  value.guarantee_assessment.assessments = [{ finding_id: "F-1-1", guarantee_ceiling: "Cooperative ownership review.", classification: "within-ceiling", rationale: "The missing owner is within the reviewed design contract." }];
  assert.equal(validate(value).report.findings.length, 1);
});
test("external audit CRITICAL and UNAVAILABLE remain received verdicts rather than PASS", () => {
  for (const verdict of ["CRITICAL", "UNAVAILABLE"]) {
    assert.equal(validate({ ...report(), verdict, guarantee_assessment: null }).report.verdict, verdict);
  }
});
test("external audit parser rejects malformed UTF-8 and over-bound report bytes", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(65_537)]) {
    assert.throws(() => parseExternalAuditReview(bytes, { dispatch, target }), { classification: "external_audit_report_invalid" });
  }
});
test("external audit closure seals a non-sticky receipt and byte-identical carrier mirror without a process claim", async () => {
  await withTempDir(async (dir) => {
    const packetDir = path.join(dir, "packet"); mkdirSync(packetDir);
    const record = { ...dispatch, carrier_root_id: hash(packetDir) };
    const rootDir = path.join(dir, "control");
    await reserveDispatchRecord({ rootDir, record });
    const { packet_sha256: _packet, carrier_root_id: _carrier, executor_kind: _executor, mode: _mode,
      primary_family: _primary, reviewer_family: _family, issued_at: _issued, ...identity } = record;
    const payload = { ...identity, schema: "devpro-second-review-completion/v2", audit_report_sha256: "d".repeat(64),
      audit_verdict: "CRITICAL", reviewer_model: "gpt-6" };
    await writeExternalClosureSlot({ rootDir, dispatchId: record.dispatch_id, kind: "accepted", receiptPayload: payload });
    const result = await writeExternalCompletionReceipt({ rootDir, dispatchId: record.dispatch_id });
    const mirror = mirrorExternalAuditCompletionReceipt({ rootDir, dispatchId: record.dispatch_id, packetDir });
    assert.deepEqual(readFileSync(mirror), readFileSync(result.path));
    const evidence = readDispatchEvidenceStrict({ rootDir, dispatchId: record.dispatch_id });
    assert.equal(evidence.completion.outcome, "external_evaluator_audit_accepted");
    assert.equal(evidence.completion.process_close_observed, false);
    assert.equal(evidence.completion.audit_verdict, "CRITICAL");
    assert.equal(evidence.invocationClaim, null);
    assert.equal(Object.keys(evidence.completion).some((key) => key.startsWith("sticky_")), false);
  });
});

test("external audit parser rejects duplicate keys and template reasons", () => {
  const bytes = Buffer.from(JSON.stringify(report()).replace('"verdict":"PASS"', '"verdict":"CRITICAL","verdict":"PASS"'));
  assert.throws(() => parseExternalAuditReview(bytes, { dispatch, target }), { classification: "external_audit_report_invalid" });
  assert.throws(() => validate({ ...report(), reason: "<actual-bounded-review-reason>" }), /reason/);
});

test("external audit accept and void compete for exactly one closure owner", async () => {
  await withTempDir(async dir => {
    const rootDir = path.join(dir, "control");
    await reserveDispatchRecord({ rootDir, record: dispatch });
    const payload = { schema: "devpro-second-review-completion/v2", repository_slug: dispatch.repository_slug,
      pr_number: "none", head_ref_oid: "none", attempt_id: dispatch.attempt_id, dispatch_id: dispatch.dispatch_id,
      previous_dispatch_id: null, review_data_sha256: dispatch.review_data_sha256,
      audit_report_sha256: "d".repeat(64), audit_verdict: "PASS", reviewer_tool: "Codex", reviewer_model: "gpt-6" };
    const results = await Promise.allSettled([
      writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "accepted", receiptPayload: payload }),
      writeExternalClosureSlot({ rootDir, dispatchId: dispatch.dispatch_id, kind: "voided" }),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.classification, "external_dispatch_closed");
  });
});

test("external audit carrier rejects remote URLs and control characters as nonlocal evidence", () => {
  for (const carrier of ["https://example.test/design", "file:///elsewhere/design", "design.md\n#hidden"] ) {
    const value = { ...report(), verdict: "CRITICAL", guarantee_assessment: null,
      findings: [{ id: "F-1-1", severity: "Critical", carrier, description: "The supplied design violates its contract." }] };
    assert.throws(() => validate(value), { classification: "external_audit_report_invalid" });
  }
});
