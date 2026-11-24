/**
 * hook-pre-tool-gate-dev-flow-checklist-nudge.test.mjs
 *
 * Regression lock for the dev-flow-checklist advisory nudge wired into
 * checkAdvisories() in .devpro/scripts/hooks/pre-tool-gate.mjs — the two
 * action points where a completed work unit crosses from local work into a
 * shared PR: `gh pr create` and `git push`.
 *
 * Spec: openspec/changes/wire-dev-flow-checklist-nudge/specs/
 *   pre-tool-mechanical-gates/spec.md — "Dev-Flow-Checklist Advisory Nudge At
 *   PR-Create And Push Action Points".
 *
 * Test strategy mirrors hook-pre-tool-gate-pr-body-template.test.mjs: spawn
 * the real hook process with a PreToolUse Bash payload on stdin (checkAdvisories
 * is not exported, so this is the black-box entry point). No git repo is
 * required for these payloads — checkAdvisories only inspects the raw command
 * text; branch/cwd resolution for hard gates runs earlier in the pipeline and
 * is irrelevant to these advisory-only assertions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

// Runs the hook with cwd in a bare tmp dir (no `.devpro/scripts/pre-pr-archive-gate.mjs`
// present) so checkArchiveBeforePushOrPRCreate() fails open and does not shadow
// the checkAdvisories() dev-flow-checklist nudge under test (both `gh pr create`
// and `git push` are also matched by the archive gate, which runs earlier in
// gate ordering and is first-match-wins across the whole gate chain).
function runHook(payload, extraEnv = {}) {
  const sentinelDir = makeTempDir("sentinel-dfc-nudge-test-");
  const cwd = makeTempDir("dfc-nudge-cwd-");
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd });
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd,
      env: {
        ...process.env,
        CODEX_CI: "",
        CODEX_THREAD_ID: "",
        DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
        ...extraEnv,
      },
    });
    let json = null;
    if (result.stdout && result.stdout.trim()) {
      try { json = JSON.parse(result.stdout); } catch { /* not JSON */ }
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Consumer and unknown checkouts must carry a DEV deploy-verify line; this file tests the nudge, not that gate.
const DEV_BODY = `## Test Evidence\n- DEV deploy-verify: HEAD ${"0".repeat(40)}; N/A: test fixture`;

test("gh pr create emits dev-flow-checklist pre-PR (stage 3) and PR (stage 4) pointer", () => {
  const cmd = `gh pr create --title "chore: x" --base main --body '${DEV_BODY}'`;
  const payload = { tool_name: "Bash", tool_input: { command: cmd } };
  const r = runHook(payload);
  assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
  assert.ok(!r.json || r.json.decision !== "block", `Must not block\njson: ${JSON.stringify(r.json)}`);
  const advisory = advisoryText(r.json);
  assert.match(advisory, /dev-flow-checklist\.md/, `Advisory should reference dev-flow-checklist.md\ncontext: ${advisory}`);
  assert.match(advisory, /archive|階段 3/, `Advisory should point to pre-PR stage 3\ncontext: ${advisory}`);
  assert.match(advisory, /階段 4|PR/, `Advisory should point to PR stage 4\ncontext: ${advisory}`);
});

test("gh pr create without --base/--draft still yields a single advisory (first-match-wins preserved)", () => {
  const cmd = `gh pr create --title "chore: x" --body '${DEV_BODY}'`;
  const payload = { tool_name: "Bash", tool_input: { command: cmd } };
  const r = runHook(payload);
  assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
  assert.ok(!r.json || r.json.decision !== "block", `Must not block\njson: ${JSON.stringify(r.json)}`);
  const advisory = advisoryText(r.json);
  assert.match(advisory, /dev-flow-checklist\.md/, `Advisory should still reference dev-flow-checklist.md\ncontext: ${advisory}`);
  assert.match(advisory, /--base/, `Advisory should still carry the missing --base hint\ncontext: ${advisory}`);
  assert.ok(r.json && typeof advisoryText(r.json) === "string" && advisoryText(r.json).length > 0,
    "Expected exactly one advisory string (first-match-wins)");
});

test("git push emits dev-flow-checklist archive (stage 3.6) and PR (stage 4) pointer", () => {
  const cmd = "git push -u origin chore/some-branch";
  const payload = { tool_name: "Bash", tool_input: { command: cmd } };
  const r = runHook(payload);
  assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
  assert.ok(!r.json || r.json.decision !== "block", `Must not block\njson: ${JSON.stringify(r.json)}`);
  const advisory = advisoryText(r.json);
  assert.match(advisory, /dev-flow-checklist\.md/, `Advisory should reference dev-flow-checklist.md\ncontext: ${advisory}`);
  assert.match(advisory, /archive/, `Advisory should point to the archive-before-push step (stage 3.6)\ncontext: ${advisory}`);
  assert.match(advisory, /階段 4|PR/, `Advisory should point to PR stage 4\ncontext: ${advisory}`);
});

test("git push --dry-run does NOT emit the dev-flow-checklist push advisory", () => {
  const cmd = "git push --dry-run origin chore/some-branch";
  const payload = { tool_name: "Bash", tool_input: { command: cmd } };
  const r = runHook(payload);
  assert.equal(r.code, 0, `Expected exit 0\nstderr: ${r.stderr}`);
  assert.ok(!r.json || r.json.decision !== "block", `Must not block\njson: ${JSON.stringify(r.json)}`);
  const advisory = advisoryText(r.json);
  assert.ok(
    !advisory.includes("dev-flow-checklist.md"),
    `--dry-run push must not trigger the dev-flow-checklist push advisory\ncontext: ${advisory}`
  );
});

test("force-push is hard-blocked (Force-push gate) and never reaches the dev-flow-checklist advisory branch", () => {
  // Scenario: "Advisory nudge never masks a hard block" — a force-push is
  // caught by the pre-existing Force-push hard gate (which runs before
  // checkAdvisories() in gate ordering), so the sole outcome is
  // {decision:"block"} and the dev-flow-checklist push advisory never fires
  // for this invocation.
  const cmd = "git push --force origin chore/some-branch";
  const payload = { tool_name: "Bash", tool_input: { command: cmd } };
  const r = runHook(payload);
  assert.equal(r.code, 0, `Hook always exits 0 (decision carried in JSON)\nstderr: ${r.stderr}`);
  assert.equal(r.json?.decision, "block", `Force-push must hard-block\njson: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Force-push gate/, `Block reason should cite Force-push gate\njson: ${JSON.stringify(r.json)}`);
  // The block response carries `reason`, not `hookSpecificOutput.additionalContext` —
  // so a bare-string check on the raw JSON confirms no advisory text co-exists.
  assert.ok(
    !JSON.stringify(r.json).includes("dev-flow-checklist.md"),
    `Force-push block must not co-emit the dev-flow-checklist advisory\njson: ${JSON.stringify(r.json)}`
  );
});
