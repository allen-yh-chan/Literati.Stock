/**
 * gh-footer-gate-fixes-codespan-warn.test.mjs
 *
 * Tests for the warn-level detection of closing keywords wrapped in code-spans
 * (e.g. `Fixes #N`) in gh-footer-gate.mjs.
 *
 * GitHub's auto-close linker does not parse keywords inside code-spans, so
 * wrapping `Fixes #N` in backticks means the issue won't auto-close on merge
 * (root cause: PR #855 → issue #853 not closed).
 *
 * These tests verify:
 *   - Warn is emitted (to stderr) when a code-span closing keyword is detected
 *   - Warn does NOT block: exit code is still 0 (non-block advisory only)
 *   - Bare `Fixes #N` (without backticks) does NOT trigger warn
 *   - Body with no closing keyword does NOT trigger warn
 *   - Variant keywords (`Closes`, `Resolves`) also trigger warn when in code-span
 *   - Regression: missing footer still exits 1 (warn addition didn't break block)
 *
 * Added by: enforce-fixes-keyword-not-in-code-span change
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

// Case 1: body with `Fixes #853` (code-span) + valid footer → exit 0 (non-block) AND stderr contains warn
test("code-span `Fixes #853` + valid footer → exit 0 (non-block) and stderr contains auto-close warn", () => {
  const body = `fixes the thing\n\n\`Fixes #853\`\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /auto-close/, "Expected warn about auto-close in stderr");
});

// Case 2: bare `Fixes #853` (no backticks) + valid footer → exit 0 and NO warn
test("bare Fixes #853 (no backticks) + valid footer → exit 0 and NO warn", () => {
  const body = `fixes the thing\n\nFixes #853\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /auto-close/, "Expected no warn for bare closing keyword");
});

// Case 3: body with only footer (no closing keyword) → exit 0 and NO warn
test("body with no closing keyword (only footer) → exit 0 and NO warn", () => {
  const body = `Just a description with no issue reference.\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /auto-close/, "Expected no warn when no closing keyword");
});

// Case 4: `Closes #1` variant (code-span) + valid footer → exit 0 and warn triggered
test("code-span `Closes #1` variant + valid footer → exit 0 and warn triggered", () => {
  const body = `closing pr\n\n\`Closes #1\`\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /auto-close/, "Expected warn about auto-close for `Closes #N`");
});

// Case 5: `Resolves #42` variant (code-span) + valid footer → exit 0 and warn triggered
test("code-span `Resolves #42` variant + valid footer → exit 0 and warn triggered", () => {
  const body = `resolving pr\n\n\`Resolves #42\`\n\n${VALID_FOOTER}`;
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 0, `Expected exit 0 but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /auto-close/, "Expected warn about auto-close for `Resolves #N`");
});

// Case 6 (regression): body with no closing keyword AND missing footer → still exits 1
// Confirms warn addition did NOT break existing footer block logic
test("regression: missing footer (no closing keyword) → still exits 1 (footer block not broken)", () => {
  const body = "body without any footer";
  const r = run({
    tool_input: { command: `gh pr create --body "${body}"` },
  });
  assert.equal(r.code, 1, `Expected exit 1 (footer block) but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /Footer missing/, "Expected footer-missing block reason in stderr");
});

test("footer missing guidance prefers notes/tmp main-checkout body files over repo-external /tmp", () => {
  const r = run({
    tool_input: { command: "gh pr create --body 'body without any footer'" },
  });
  assert.equal(r.code, 1, `Expected exit 1 (footer block) but got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /notes\/tmp/);
  assert.match(r.stderr, /main-checkout/);
  assert.match(r.stderr, /[Rr]epo-external \/tmp/);
  assert.doesNotMatch(r.stderr, /勿用 \/tmp 絕對路徑/);
});
