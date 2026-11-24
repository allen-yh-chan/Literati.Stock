import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import portableCommandShims from "./lib/portable-command-shims.cjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { envWithoutHostMarkers } from "./lib/host-session-env.mjs";
import {
  assertAttemptUnderOwnedRoot,
  clearOwnedCanonicalCache,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";

// End to end: a real rendered deepseek audit-only attempt is run by the real runner against a
// fake `opencode`. The fake only reports what it was given; the runner must still prove model,
// input and report from the exported session before it accepts the completion.
const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const runnerScript = repoPath(".devpro/scripts/run-second-reviewer-projection.mjs");

const auditHandoff = {
  mode: "audit-only",
  attempt: "initial",
  primary_family: "openai-codex",
  reviewer_family: "deepseek",
  target: "local diff",
  head_ref_oid: "none",
  repository_slug: "devpro/example",
  approval_context: "none",
  scope_summary: "bounded opencode runner smoke",
  changed_files_or_touch_list: [".devpro/scripts/run-second-reviewer-projection.mjs"],
  review_material_carrier: "embedded-diff",
  review_material_complete: true,
  review_material: "bounded diff excerpt supplied by TL handoff",
  primary_validation_evidence: "renderer and runner tests passed",
  primary_test_evidence: "targeted local smoke",
  retry_context: { classification: "none", sticky_verification: "not-needed" },
  write_path: "none",
  allowed_tools: "read-only audit mode",
};

function writeFakeOpenCode(binDir) {
  const helperHref = pathToFileURL(repoPath(".devpro/scripts/tests/lib/portable-fake-reviewer-cli.mjs")).href;
  const fake = path.join(binDir, "opencode");
  writeFileSync(fake, `#!/usr/bin/env node\n`
    + `import(${JSON.stringify(helperHref)})\n`
    + `.then((helpers) => helpers.runFakeOpenCode())\n`
    + `.catch((error) => { console.error(error); process.exitCode = 1; });\n`, "utf8");
  chmodSync(fake, 0o755);
  if (process.platform === "win32") {
    // Production discovery needs a PATHEXT-native entry; the test-only spawn shim maps this
    // marker back to the adjacent script fixture (same convention as the claude/codex fakes).
    writeFileSync(`${fake}.exe`, "DevPro Windows test resolver marker\n", "utf8");
  }
  return fake;
}

// Windows runs the fake through the shared spawn shim, preloaded into every node process.
function windowsShimEnv() {
  if (process.platform !== "win32") return {};
  return {
    NODE_OPTIONS: portableCommandShims.appendPreload(
      process.env.NODE_OPTIONS,
      repoPath(".devpro/scripts/tests/lib/portable-command-shims.cjs"),
    ),
  };
}

function withFixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "second-review-opencode-runner-"));
  try {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeOpenCode(binDir);
    return fn({ dir, binDir, stateDir: path.join(dir, "fake-opencode-state") });
  } finally {
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function render({ dir, binDir }) {
  const handoffPath = path.join(dir, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(auditHandoff), "utf8");
  const prepared = prepareOwnedCanonicalRenderer({ fixtureDir: dir, repoRoot: REPO_ROOT, rendererPath: renderer });
  const result = spawnSync(process.execPath, [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...envWithoutHostMarkers(),
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      ...windowsShimEnv(),
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const packetPath = result.stdout.trim();
  assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
  const carrierDir = path.dirname(packetPath);
  const contextPath = path.join(carrierDir, "observability-context.json");
  return { packetPath, carrierDir, contextPath, context: JSON.parse(readFileSync(contextPath, "utf8")) };
}

function completion(context, overrides = {}) {
  return JSON.stringify({
    sticky_comment_url: "none",
    verdict: "PASS",
    last_reviewed_sha: "none",
    reviewer_model: "deepseek/deepseek-v4-pro",
    reason: "No blocking findings.",
    ...overrides,
  });
}

function run(fixture, context, contextPath, extraEnv = {}) {
  const wrongCwd = mkdtempSync(path.join(fixture.dir, "wrong-cwd-"));
  const result = spawnSync(process.execPath, [runnerScript, contextPath], {
    cwd: wrongCwd,
    encoding: "utf8",
    env: {
      ...envWithoutHostMarkers(),
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
      ...windowsShimEnv(),
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: context.control_evidence_root,
      DEVPRO_SECOND_REVIEW_RUNNER_HEARTBEAT_MS: "50",
      DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS: "20000",
      DEVPRO_SECOND_REVIEW_RUNNER_TERMINATION_GRACE_MS: "50",
      DEVPRO_SECOND_REVIEW_RUNNER_FORCE_SETTLE_MS: "100",
      DEVPRO_FAKE_OPENCODE_STATE_DIR: fixture.stateDir,
      DEVPRO_FAKE_OPENCODE_REPORT: completion(context),
      ...extraEnv,
    },
  });
  let output = null;
  try { output = JSON.parse(result.stdout); } catch { /* reported by the caller's assertion */ }
  return { result, output };
}

function activityEvents(context) {
  return readFileSync(context.activity_log_path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function evidence(context, name) {
  const file = path.join(context.control_evidence_root, context.dispatch_id, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function eventNamed(context, name) {
  return activityEvents(context).find((event) => event.event === name) ?? null;
}

test("opencode audit-only: a verified session export completes the review", () => {
  withFixture((fixture) => {
    const invocationLog = path.join(fixture.dir, "opencode-invocations.log");
    const { context, contextPath } = render(fixture);
    const { result, output } = run(fixture, context, contextPath, { DEVPRO_FAKE_OPENCODE_INVOCATION_LOG: invocationLog });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.status, "finished");
    assert.equal(output.classification, "reviewer_cli_completed");

    const verified = eventNamed(context, "projection_opencode_session_verified");
    assert.equal(verified.status, "verified");
    assert.equal(verified.observed_selector, "deepseek/deepseek-v4-pro");
    assert.equal(eventNamed(context, "projection_opencode_session_unverified"), null);

    const record = evidence(context, "reviewer-model-record.json");
    assert.equal(record.reviewer_cli_family, "opencode");
    assert.equal(record.requested_model, "deepseek/deepseek-v4-pro");
    assert.equal(record.observed_model, "deepseek/deepseek-v4-pro");
    assert.equal(record.observed_source, "session-export");
    assert.equal(record.agreement, "exact");
    assert.equal(evidence(context, "completion-receipt.json").classification, "audit_only_verified");
    assert.equal(evidence(context, "terminal-receipt.json"), null);

    // The review window ran in the neutral cwd under the trusted launch file with project
    // config disabled; the throwaway token session ran elsewhere.
    const reviewLine = readFileSync(invocationLog, "utf8").trim().split("\n")
      .find((line) => line.includes(`cwd=`) && path.basename(line.split("\tcwd=")[1].split("\t")[0]) === path.basename(context.neutral_cwd_path));
    assert.ok(reviewLine, "the review window must run in the neutral cwd");
    assert.match(reviewLine, /^run --standalone --format json --agent devpro-review-audit --model deepseek\/deepseek-v4-pro#max\t/u);
    assert.ok(reviewLine.includes(`config=${context.reviewer_opencode.launch_config_path}`));
    assert.ok(reviewLine.includes("project_config_disabled=1"));
    if (process.platform !== "win32") {
      assert.equal(statSync(context.reviewer_opencode.launch_config_path).mode & 0o777, 0o600);
    }
  });
});

// Each case corrupts only what the review window's session export says. The runner never saw
// the model, so a clean-looking process exit and a valid completion JSON must not be enough.
const PROVENANCE_FAILURES = [
  { name: "a different model", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODEL: "deepseek/deepseek-v4-flash" }, why: "opencode_model_provenance_mismatch", agreement: "divergent" },
  { name: "a provider that differs only by case", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODEL: "DeepSeek/deepseek-v4-pro" }, why: "opencode_model_provenance_mismatch", agreement: "divergent" },
  { name: "input bytes that are not what the runner sent", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "wrong-input" }, why: "opencode_input_binding_mismatch", agreement: "exact" },
  { name: "a report that is not what the run printed", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "wrong-report" }, why: "opencode_report_mismatch", agreement: "exact" },
  { name: "an assistant message that never finished", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "unfinished" }, why: "opencode_terminal_evidence_missing", agreement: "exact" },
  // #3624: no JSON in the export means no usable export (stage export), not invalid evidence.
  { name: "export output that is not JSON", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "malformed" }, why: "opencode_export_unavailable", agreement: "unavailable", reason: "export_unavailable" },
  { name: "an export command that fails", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "unavailable" }, why: "opencode_export_unavailable", agreement: "unavailable", reason: "export_unavailable" },
  { name: "export JSON that is not a session", env: { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "bad-schema" }, why: "opencode_export_malformed", agreement: "unavailable", reason: "export_invalid" },
];

for (const failure of PROVENANCE_FAILURES) {
  test(`opencode audit-only: ${failure.name} blocks with a closed provenance classification`, () => {
    withFixture((fixture) => {
      const { context, contextPath } = render(fixture);
      const { result, output } = run(fixture, context, contextPath, failure.env);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(output.status, "blocked");
      assert.equal(output.classification, "reviewer_model_provenance_unverified");
      assert.equal(eventNamed(context, "projection_opencode_session_unverified").classification, failure.why);
      assert.equal(eventNamed(context, "projection_opencode_session_verified"), null);

      const record = evidence(context, "reviewer-model-record.json");
      assert.equal(record.agreement, failure.agreement);
      if (failure.reason) assert.equal(record.observed_unavailable_reason, failure.reason);
      const terminal = evidence(context, "terminal-receipt.json");
      assert.equal(terminal.classification, "reviewer_model_provenance_unverified");
      assert.equal(terminal.outcome_group, "terminal_contract_or_cli_failure");
      assert.equal(terminal.process_spawned, true);
      assert.equal(evidence(context, "completion-receipt.json"), null, "an unverified window must not leave a completion receipt");
    });
  });
}

// #3624: the same session behind a one-line CLI banner must still verify; the banner is
// transport noise, not model evidence, and must not cost the window its provenance.
test("opencode audit-only: a CLI banner ahead of the export keeps the window verified", () => {
  withFixture((fixture) => {
    const { context, contextPath } = render(fixture);
    const { result, output } = run(fixture, context, contextPath, { DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "banner" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.status, "finished");
    const verified = eventNamed(context, "projection_opencode_session_verified");
    assert.equal(verified.status, "verified");
    assert.equal(verified.observed_selector, "deepseek/deepseek-v4-pro");
    assert.equal(evidence(context, "reviewer-model-record.json").agreement, "exact");
  });
});

test("opencode audit-only: a tool call in a no-tool review stops the reviewer", () => {
  withFixture((fixture) => {
    const { context, contextPath } = render(fixture);
    const { result, output } = run(fixture, context, contextPath, { DEVPRO_FAKE_OPENCODE_TOOL_USE: "1" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.status, "blocked");
    assert.equal(output.classification, "reviewer_tool_surface_mismatch");
    const terminal = evidence(context, "terminal-receipt.json");
    assert.equal(terminal.classification, "reviewer_tool_surface_mismatch");
    assert.equal(terminal.outcome_group, "tool_surface_fault");
    assert.equal(evidence(context, "completion-receipt.json"), null);
    assert.equal(evidence(context, "reviewer-model-record.json").agreement, "unavailable");
  });
});

test("opencode audit-only: a readiness probe that cannot prove the model never starts the review", () => {
  withFixture((fixture) => {
    const { context, contextPath } = render(fixture);
    const { result, output } = run(fixture, context, contextPath, {
      DEVPRO_FAKE_OPENCODE_EXPORT_MODEL: "deepseek/deepseek-v4-flash",
      DEVPRO_FAKE_OPENCODE_EXPORT_SCOPE: "all",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(output.classification, "reviewer_host_surface_unverified");
    assert.equal(eventNamed(context, "projection_dispatch_invocation_claimed"), null);
    assert.equal(eventNamed(context, "projection_cli_starting"), null);
    assert.equal(evidence(context, "invocation-claim.json"), null);
    const terminal = evidence(context, "terminal-receipt.json");
    assert.equal(terminal.outcome_group, "spawn_or_probe_failure");
    assert.equal(terminal.process_spawned, false);
  });
});
