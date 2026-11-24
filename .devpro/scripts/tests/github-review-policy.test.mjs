import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSecondReviewEvidence } from "../hooks/lib/github-review-policy.mjs";

const head = "a".repeat(40);
const old = "b".repeat(40);
function snapshot(verdict = "PASS", sha = head) {
  return {
    headRefName: "feature/add-example", headRefOid: head,
    comments: [{ id: "comment1", url: "https://github.com/example/repo/pull/1#issuecomment-1", body: [
      "<!-- cross-model-second-opinion:sticky -->", `verdict: ${verdict}`,
      `last_reviewed_sha: ${sha}`, "dispatch_id: test-github-review-policy",
      "reason: Independently reviewed the requested change.",
      "Rules: v1.0.0 · Tool: Claude Code · Model: claude-test",
    ].join("\n") }],
  };
}
const evaluate = (prData, compare) => evaluateSecondReviewEvidence({ prNumber: 1, prData, compare });

test("matching complete PASS and WARN reviews allow the same head", () => {
  for (const verdict of ["PASS", "WARN"]) assert.equal(evaluate(snapshot(verdict)).block, false);
});
test("missing, ambiguous, unavailable and critical reviews block", () => {
  assert.equal(evaluate({ ...snapshot(), comments: [] }).block, true);
  const duplicate = snapshot(); duplicate.comments.push({ ...duplicate.comments[0], id: "comment2" });
  assert.equal(evaluate(duplicate).block, true);
  for (const verdict of ["CRITICAL", "UNAVAILABLE", "BOGUS"]) assert.equal(evaluate(snapshot(verdict)).block, true);
});
test("stale review requires raw compare evidence and cannot rely on a caller pass flag", () => {
  assert.equal(evaluate(snapshot("PASS", old)).block, true);
  assert.equal(evaluate(snapshot("PASS", old), () => ({ fresh_equivalent: true })).block, true);
  assert.equal(evaluate(snapshot("PASS", old), () => ({ ok: true, body: { status: "ahead", files: [{ filename: "src/code.js" }] } })).block, true);
  assert.equal(evaluate(snapshot("PASS", old), () => ({ ok: true, body: { status: "ahead", files: [{ filename: "notes/review.md" }] } })).block, false);
});
test("critical cannot be cleared by a bookkeeping-only compare", () => {
  assert.equal(evaluate(snapshot("CRITICAL", old), () => ({ ok: true, body: { status: "ahead", files: [] } })).block, true);
});
test("invalid head and malformed provenance block without provider side effects", () => {
  let calls = 0;
  const pr = snapshot(); pr.headRefOid = "invalid";
  assert.equal(evaluate(pr, () => { calls++; }).block, true);
  assert.equal(calls, 0);
  const invalid = snapshot(); invalid.comments[0].body = invalid.comments[0].body.replace(/Rules:.+/, "");
  assert.equal(evaluate(invalid).block, true);
});
