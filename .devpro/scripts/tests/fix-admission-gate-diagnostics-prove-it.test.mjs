/**
 * Prove-it for fix-admission-gate-diagnostics (pending 54/57/60):
 * per-field limits, oversize≠missing, closed-set diagnostics.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMISSION_FIELD_VALUE_MAX,
  ADMISSION_OBJECTIVES,
  formatAdmissionFieldProblems,
  parseAdmissionFields,
} from "../hooks/lib/admission-record.mjs";

function sixFieldPrompt(overrides = {}) {
  return [
    `objective: ${overrides.objective ?? "context-isolation"}`,
    `responsibility_id: ${overrides.responsibility_id ?? "admission-diagnostics"}`,
    `instance_mode: ${overrides.instance_mode ?? "fresh"}`,
    `evidence_scope: ${overrides.evidence_scope ?? "openspec/changes/fix-admission-gate-diagnostics/proposal-mini.md"}`,
    `return_and_stop: ${overrides.return_and_stop ?? "status JSON; stop"}`,
    `role: ${overrides.role ?? "dp-analyst"}`,
    ...(overrides.extraLines ?? []),
  ].join("\n");
}

test("R1: evidence_scope above 500 and within 2000 is admitted; fork_reason stays at 500", () => {
  assert.equal(ADMISSION_FIELD_VALUE_MAX.evidence_scope, 2000);
  assert.equal(ADMISSION_FIELD_VALUE_MAX.fork_reason, 500);
  const mid = "e".repeat(521);
  const parsed = parseAdmissionFields(sixFieldPrompt({ evidence_scope: mid }));
  assert.equal(parsed.fields.evidence_scope, mid);
  assert.equal(parsed.missing.includes("evidence_scope"), false);
  assert.equal((parsed.oversize ?? []).some((row) => row.field === "evidence_scope"), false);

  const longFork = parseAdmissionFields(sixFieldPrompt({
    extraLines: [`fork_reason: ${"f".repeat(501)}`],
  }));
  assert.ok((longFork.oversize ?? []).some((row) => row.field === "fork_reason" && row.max === 500 && row.length === 501));
});

test("R2: oversized evidence_scope is oversize diagnosis, never missing", () => {
  const tooLong = "p".repeat(2001);
  const parsed = parseAdmissionFields(sixFieldPrompt({ evidence_scope: tooLong }));
  assert.equal(parsed.fields.evidence_scope, undefined);
  assert.equal(parsed.missing.includes("evidence_scope"), false, "oversize must not be classified as missing");
  const over = (parsed.oversize ?? []).find((row) => row.field === "evidence_scope");
  assert.ok(over, "expected oversize row for evidence_scope");
  assert.equal(over.length, 2001);
  assert.equal(over.max, 2000);

  const message = formatAdmissionFieldProblems(parsed);
  assert.match(message, /oversize:.*evidence_scope.*length=2001.*max=2000/);
  assert.doesNotMatch(message, /missing:.*evidence_scope/);
});

test("R3: closed-set invalid enumerates allowed values and drops merged three-cause phrase", () => {
  const parsed = parseAdmissionFields(sixFieldPrompt({ objective: "rewrite the BRD in prose" }));
  assert.deepEqual(parsed.invalid, ["objective"]);
  const message = formatAdmissionFieldProblems(parsed);
  assert.match(message, /objective/);
  for (const allowed of ADMISSION_OBJECTIVES) {
    assert.match(message, new RegExp(allowed));
  }
  assert.doesNotMatch(
    message,
    /a value outside the closed set or over 500 chars/,
    "must not keep the undifferentiated three-cause phrase",
  );
});


test("F1: continue + oversized parent_record_id is oversize, not missing", () => {
  const parsed = parseAdmissionFields(sixFieldPrompt({
    instance_mode: "continue",
    extraLines: [`parent_record_id: ${"a".repeat(501)}`],
  }));
  assert.equal(parsed.missing.includes("parent_record_id"), false);
  assert.ok((parsed.oversize ?? []).some((row) => row.field === "parent_record_id" && row.max === 500));
  const message = formatAdmissionFieldProblems(parsed);
  assert.match(message, /oversize:.*parent_record_id/);
  assert.doesNotMatch(message, /missing:.*parent_record_id/);
});

test("F2/R1: fork_reason length 500 admits; 501 is oversize-only diagnosis", () => {
  const ok = parseAdmissionFields(sixFieldPrompt({
    instance_mode: "fork",
    extraLines: [`fork_reason: ${"r".repeat(500)}`],
  }));
  assert.equal(ok.fields.fork_reason.length, 500);
  assert.equal((ok.oversize ?? []).length, 0);

  const over = parseAdmissionFields(sixFieldPrompt({
    instance_mode: "fork",
    extraLines: [`fork_reason: ${"r".repeat(501)}`],
  }));
  const message = formatAdmissionFieldProblems(over);
  assert.match(message, /oversize:.*fork_reason.*length=501.*max=500/);
  assert.doesNotMatch(message, /requires a non-empty `fork_reason:`/);
});
