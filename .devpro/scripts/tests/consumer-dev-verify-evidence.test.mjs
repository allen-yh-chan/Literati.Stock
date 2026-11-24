/**
 * consumer-dev-verify-evidence.test.mjs
 *
 * Text-format check of the `DEV deploy-verify:` evidence line in a consumer PR
 * body (`consumerDevVerifyEvidenceError`). Execution, consent and HEAD currency
 * stay cooperative; this only proves the line is present, unique, bound to a
 * full SHA and not an empty shell.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerDevVerifyEvidenceError } from "../lib/consumer-pre-pr-gate.mjs";

const SHA40 = "a".repeat(40);
const SHA64 = "b".repeat(64);
const ERROR_BASE = "require exactly one non-placeholder line outside fenced code in ## Test Evidence: DEV deploy-verify: HEAD <full-sha>; <result summary> | N/A: <reason> | pending: <what is missing> | skipped per user decision: <reason>";
const NOT_VERIFIED_ERROR = `${ERROR_BASE}; write pending: <what is missing> instead`;
const MISSING_BODY_ERROR = "PR body is missing or unreadable; the DEV deploy-verify line is required";

const body = (line, extra = "") => `## Test Evidence\n${line}\n${extra}\n## Manual Test\n- N/A\n`;
const line = (status, sha = SHA40) => `DEV deploy-verify: HEAD ${sha}; ${status}`;

// [Scenario: openspec-flow :: DEV deploy-verify evidence line has a fixed prefix and four statuses]
test("non-string body reports the missing-body error", () => {
  for (const value of [undefined, null, 42, {}, ["x"]]) {
    assert.equal(consumerDevVerifyEvidenceError(value), MISSING_BODY_ERROR);
  }
});

test("missing line, missing section, and two lines are rejected with the shared error", () => {
  assert.equal(consumerDevVerifyEvidenceError("## Test Evidence\nAll tests pass.\n"), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(`## Other\n${line("passed")}\n`), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(""), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(body(line("passed"), line("passed"))), ERROR_BASE);
});

test("a line inside fenced code or an HTML comment does not count", () => {
  assert.equal(consumerDevVerifyEvidenceError(body(`\`\`\`\n${line("passed")}\n\`\`\``)), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(body(`~~~\n${line("passed")}\n~~~`)), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(body(`<!-- ${line("passed")} -->`)), ERROR_BASE);
  // a fenced copy plus one live line is exactly one live line
  assert.equal(consumerDevVerifyEvidenceError(body(line("passed"), `\`\`\`\n${line("passed")}\n\`\`\``)), null);
});

test("list markers are accepted; 40 and 64 hex SHAs pass; short or non-hex SHAs are rejected", () => {
  for (const marker of ["", "- ", "* ", "+ ", "  - "]) {
    assert.equal(consumerDevVerifyEvidenceError(body(`${marker}${line("passed")}`)), null, JSON.stringify(marker));
  }
  assert.equal(consumerDevVerifyEvidenceError(body(line("passed", SHA64))), null);
  for (const sha of ["abcdef0", "a".repeat(39), "a".repeat(41), "g".repeat(40), "<full-sha>"]) {
    assert.equal(consumerDevVerifyEvidenceError(body(line("passed", sha))), ERROR_BASE, sha);
  }
  assert.equal(consumerDevVerifyEvidenceError(body(`DEV deploy-verify: HEAD ${SHA40}`)), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(body(`DEV deploy-verify: HEAD ${SHA40};`)), ERROR_BASE);
  assert.equal(consumerDevVerifyEvidenceError(body(`DEV deploy-verify: HEAD ${SHA40};   `)), ERROR_BASE);
});

test("placeholder, TODO, angle-bracket fields and empty-shell statuses are rejected", () => {
  for (const status of [
    "<result summary>", "<N/A: reason>", "N/A: <reason>", "pending: <what is missing>",
    "TODO", "TBD", "placeholder", "[fill result]",
    "N/A:", "pending:", "skipped per user decision:", "N/A:   ", "PENDING:",
    "N/A", "n/a", "-", "—", "..", "--",
  ]) {
    assert.equal(consumerDevVerifyEvidenceError(body(line(status))), ERROR_BASE, status);
  }
});

test("code-span angle-bracket fields, dash-only reasons and a status keyword without its colon are rejected", () => {
  for (const status of [
    "`<result>`", "`<result summary>`", "N/A: `<reason>`", "pending: `<x>`", "skipped per user decision: `<reason>`",
    "N/A: -", "N/A: —", "pending: ...", "skipped per user decision: --",
    "pending", "pending no PR-branch deploy entry", "PENDING env", "skipped", "skipped per user decision",
    "skipped per user decision no env", "N/A docs only",
  ]) {
    assert.equal(consumerDevVerifyEvidenceError(body(line(status))), ERROR_BASE, status);
  }
});

test("not verified is rejected and the message asks for pending instead", () => {
  for (const status of ["not verified", "Not Verified", "not_verified", "not-verified: no env", "NOT   VERIFIED"]) {
    const error = consumerDevVerifyEvidenceError(body(line(status)));
    assert.equal(error, NOT_VERIFIED_ERROR, status);
    assert.match(error, /write pending:/);
  }
});

test("N/A with a reason, pending, skipped per user decision and a result summary pass", () => {
  for (const status of [
    "N/A: docs only",
    "pending: no PR-branch deploy entry (integration-only workflow)",
    "pending: x",
    "skipped per user decision: y",
    "deployed PR head build to DEV, login timeout path passed",
    "passed",
  ]) {
    assert.equal(consumerDevVerifyEvidenceError(body(line(status))), null, status);
  }
  assert.equal(consumerDevVerifyEvidenceError(body(`- ${line("N/A: docs only")}`)), null);
});

test("error strings stay the single shared SSOT", () => {
  assert.equal(consumerDevVerifyEvidenceError(body("nothing")), ERROR_BASE);
  assert.ok(ERROR_BASE.includes("DEV deploy-verify: HEAD <full-sha>"));
  assert.ok(!ERROR_BASE.includes("write pending"));
});
