/**
 * gh-footer-gate-rootcause-warn.test.mjs
 *
 * Tests for the warn-level detection of Root Cause / 根因 claims without
 * accompanying Evidence/Verification in gh-footer-gate.mjs.
 *
 * per troubleshooting.md Exact-Case Evidence Ledger: naming root cause requires
 * confirmed evidence (exact-case). Bodies that claim root cause without evidence
 * should receive an advisory warn to stderr but must NOT be blocked (exit 0).
 *
 * These tests verify:
 *   - Warn is emitted when body contains "Root Cause" but lacks Evidence/Verification
 *   - Warn does NOT block: exit code is 0 (non-block advisory only)
 *   - Bodies with "Root Cause" AND "Evidence" do NOT trigger warn
 *   - Chinese 根因 label also triggers warn when missing Evidence/Verification
 *   - Body with no root-cause label does NOT trigger warn
 *   - Regression: missing footer still exits 1 (block not affected by root-cause warn)
 *
 * Added by: enforce-codex-api-latch-and-evidence-gate change
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGhFooterGate } from "../hooks/gh-footer-gate.mjs";

const VALID_FOOTER = "Rules: v6.60.1 · Tool: test · Model: x";

function run(payload, env = {}) {
  let stdout = "";
  let stderr = "";
  const code = evaluateGhFooterGate({
    rawInput: JSON.stringify(payload),
    env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "", ...env },
    writeStdout: (chunk) => { stdout += chunk; },
    writeStderr: (chunk) => { stderr += chunk; },
  });
  let json = null;
  if (stdout.trim()) {
    try {
      json = JSON.parse(stdout);
    } catch {}
  }
  return { code, stderr, stdout, json };
}

// Case 1: body contains "Root Cause" but no Evidence/Verification + valid footer
// → exit 0 (non-block warn) AND stderr contains Evidence Ledger / root cause
test("Root Cause without Evidence + valid footer → exit 0 (non-block) and stderr contains evidence ledger warn", () => {
  const body = `## Summary\nFixed the crash.\n\n## Root Cause\nThe null pointer dereference.\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /Evidence Ledger|root cause/i, "Expected warn about Evidence Ledger or root cause in stderr");
});

// Case 2: body contains "Root Cause" AND has "Evidence" section + valid footer
// → exit 0 and NO warn triggered
test("Root Cause WITH Evidence section + valid footer → exit 0 and NO evidence-ledger warn", () => {
  const body = `## Root Cause\nThe null pointer.\n\n## Evidence\nSee log output at line 42.\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Evidence Ledger/i, "Expected no Evidence Ledger warn when Evidence section present");
});

// Case 3: body contains Chinese 根因 label but no Evidence/Verification + valid footer
// → warn triggered (Chinese root-cause label)
test("Chinese 根因 without Evidence + valid footer → exit 0 and warn triggered", () => {
  const body = `## 問題分析\n\n根因：記憶體未正確釋放導致 leak。\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /Evidence Ledger|root cause/i, "Expected warn for Chinese 根因 label without Evidence");
});

// Case 4: body has no root-cause label + valid footer → no warn
test("body with no root-cause label + valid footer → exit 0 and NO warn", () => {
  const body = `## Summary\nFixed the performance issue.\n\n## Changes\n- Updated query.\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Evidence Ledger/i, "Expected no Evidence Ledger warn when no root-cause label");
});

// Case 5 (regression): body missing footer entirely → still exits 1 (existing block not broken)
// Confirms root-cause warn addition did NOT break existing footer block logic
test("regression: body missing footer → still exits 1 (footer block not broken by root-cause warn)", () => {
  const body = "## Root Cause\nSome root cause here without footer.";
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 1, `Expected exit 1 (footer block) but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /Footer missing/, "Expected footer-missing block reason in stderr");
});
