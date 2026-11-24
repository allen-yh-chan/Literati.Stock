import { modelProbeEvidence, modelProbeTestEnv } from "./lib/model-probe-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_EFFORT_STUB_ALLOW_ENV,
  CLAUDE_EFFORT_STUB_ENV,
  assertClaudeEffortSelectionReady,
  buildClaudeEffortMicroProbeArgv,
  classifyFunctionalProbeResult,
  helpListsEffortValue,
  selectClaudeSecondReviewerEffort as actualSelectClaudeSecondReviewerEffort,
} from "../select-claude-second-reviewer-effort.mjs";
import {
  SECOND_REVIEWER_MODEL_OVERRIDE_ENV,
  resolveSecondReviewerModel,
} from "../second-reviewer-cli-recipe-contract.mjs";

const selectClaudeSecondReviewerEffort = (options) => actualSelectClaudeSecondReviewerEffort({...options, env:options.env?.NODE_ENV === "test" ? options.env : modelProbeTestEnv(options.env), modelProbe: () => modelProbeEvidence.claude});

const CLAUDE_BUILT_IN_MODEL = resolveSecondReviewerModel("claude", modelProbeTestEnv()).model;

const selectorModule = await import("../select-claude-second-reviewer-effort.mjs");

const HELP_WITH_XHIGH_MAX = `
Usage: claude -p [options]
  --effort <level>                 Effort: low, medium, high, xhigh, max
  --model <model>                  Model alias: sonnet, opus, haiku
`;

const HELP_WITHOUT_XHIGH = `
Usage: claude -p [options]
  --effort <level>                 Effort: low, medium, high
`;

function rateLimitedProbe(status = 1) {
  return {
    status,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", cwd: "/Users/probe-private/work", session_id: "private-session", model: "fixture-model" }),
      JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit", session_id: "private-session" }),
    ].join("\n"),
    stderr: "",
  };
}

for (const status of [0, 1]) {
  test(`provider assistant rate_limit remains blocked at exit ${status} with a redacted cause`, () => {
    const result = classifyFunctionalProbeResult(rateLimitedProbe(status));
    assert.equal(result.classification, "claude_reviewer_provider_rate_limited");
    assert.match(result.summary, /rate.limit/i);
    assert.doesNotMatch(result.summary, /probe-private|private-session|fixture-model|system.*init/);
    assert.ok(result.summary.length <= 240);
  });
}

test("a rate-limited xhigh probe stops selection before max and never yields a dispatch-ready recipe", () => {
  const efforts = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude", env: modelProbeTestEnv(), effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: (effort) => { efforts.push(effort); return rateLimitedProbe(); },
  });
  assert.equal(selection.classification, "claude_reviewer_provider_rate_limited");
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.deepEqual(efforts, ["xhigh"]);
  assert.throws(() => assertClaudeEffortSelectionReady(selection), /provider_rate_limited/);
  assertNoHighFallback(selection);
});

for (const record of [
  { type: "error", error: { type: "rate_limit_error" } },
  { type: "control", http_status: 429 },
  { type: "error", error: { status_code: "429" } },
  { type: "error", error: { code: "insufficient_quota" } },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
  { type: "rate_limit_event", rate_limit_info: { status: "future-status" } },
  { type: "rate_limit_event", status: "allowed" },
]) {
  test(`typed provider limit blocks: ${JSON.stringify(record)}`, () => {
    const result = classifyFunctionalProbeResult({ status: 1, stdout: JSON.stringify(record), stderr: "" });
    assert.equal(result.classification, "claude_reviewer_provider_rate_limited");
  });
}

test("plain quota diagnostic is redacted and takes precedence over generic incompatibility", () => {
  const result = classifyFunctionalProbeResult({
    status: 1, stdout: "",
    stderr: "You've hit your session limit: /Users/private/path account@example.invalid sk-privatevalue123456",
  });
  assert.equal(result.classification, "claude_reviewer_provider_rate_limited");
  assert.doesNotMatch(result.summary, /private|@|sk-/);
});

test("provider-looking tokens in successful payloads and informational telemetry remain opaque", () => {
  const stdout = [
    { type: "system", subtype: "init", cwd: "/fixtures/rate_limit", http_status: 429 },
    { type: "assistant", message: { content: [{ text: "rate_limit_error insufficient_quota You've hit your session limit" }], error: "rate_limit" } },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
    { type: "result", subtype: "success", is_error: false, structured_output: { ok: true, note: "rate_limit_error" }, result: "quota_exceeded", http_status: 429 },
  ].map(JSON.stringify).join("\n");
  assert.equal(classifyFunctionalProbeResult({ status: 0, stdout, stderr: "" }).classification, "compatible");
});

test("a rate-limited max upgrade also blocks instead of silently keeping xhigh", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude", env: modelProbeTestEnv(), effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: (effort) => effort === "xhigh"
      ? { status: 0, stdout: '{"type":"result"}', stderr: "" } : rateLimitedProbe(),
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.classification, "claude_reviewer_provider_rate_limited");
  assert.equal(selection.selected_effort, null);
});

for (const status of [0, 1]) {
  for (const record of [
    { type: "result", is_error: true, error: { type: "server_error" } },
    { type: "result", is_error: true, error: { type: "billing_error" } },
    { type: "result", subtype: "error_during_execution", result: "provider execution failed" },
  ]) {
    test(`non-compatibility result error remains indeterminate at exit ${status}: ${JSON.stringify(record)}`, () => {
      const classified = classifyFunctionalProbeResult({ status, stdout: JSON.stringify(record), stderr: "" });
      assert.equal(classified.classification, "probe_execution_failed");
      const efforts = [];
      const selection = selectClaudeSecondReviewerEffort({
        reviewer_family: "claude", env: modelProbeTestEnv(), effort_ceiling: "max",
        runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
        runFunctionalProbe: (effort) => {
          efforts.push(effort);
          return effort === "xhigh" ? { status: 0, stdout: '{"type":"result"}', stderr: "" }
            : { status, stdout: JSON.stringify(record), stderr: "" };
        },
      });
      assert.deepEqual(efforts, ["xhigh", "max"]);
      assert.equal(selection.status, "blocked");
      assert.equal(selection.classification, "probe_execution_failed");
      assert.equal(selection.selected_effort, null);
      assert.throws(() => assertClaudeEffortSelectionReady(selection));
    });
  }
}

for (const auth of [{ type: "control", http_status: 401 }, "Not logged in"]) {
  test(`functional-probe auth precedes concurrent rate evidence: ${JSON.stringify(auth)}`, () => {
    const probe = rateLimitedProbe();
    probe.stdout += "\n" + (typeof auth === "string" ? auth : JSON.stringify(auth));
    assert.equal(classifyFunctionalProbeResult(probe).classification, "auth_failure");
  });
}

test("successful parsed completion is not blocked by plain diagnostic path tokens", () => {
  assert.equal(classifyFunctionalProbeResult({
    status: 0, stdout: '{"type":"result","subtype":"success","is_error":false}',
    stderr: "Loaded /fixtures/fix-rate-limit/config.json",
  }).classification, "compatible");
  assert.equal(classifyFunctionalProbeResult({
    status: 0, stdout: 'not-json "type":"result"', stderr: "",
  }).classification, "malformed_stream");
});

function stubEnv(stub, extra = {}) {
  return {
    [CLAUDE_EFFORT_STUB_ALLOW_ENV]: "1",
    [CLAUDE_EFFORT_STUB_ENV]: stub,
    ...extra,
  };
}

function assertNoHighFallback(selection) {
  assert.notEqual(selection.selected_effort, "high");
  for (const candidate of selection.candidates ?? []) {
    assert.notEqual(candidate.effort, "high");
  }
  assert.doesNotMatch(JSON.stringify(selection), /"--effort","high"/);
}

function runWithRecordedProbeTimeouts(options = {}) {
  const calls = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    // D10: these probe-timeout-wiring fixtures assert the ladder reaches a max
    // probe call; the default effort_ceiling (xhigh) would skip that call, so
    // raise the ceiling here rather than letting each call site repeat it.
    effort_ceiling: "max",
    ...options,
    runHelpProbe: (probeOptions) => {
      calls.push({ probe: "help", timeout_ms: probeOptions?.timeout_ms });
      return { ok: true, text: HELP_WITH_XHIGH_MAX };
    },
    runFunctionalProbe: (effort, probeOptions) => {
      calls.push({ probe: effort, timeout_ms: probeOptions?.timeout_ms });
      return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
    },
  });
  return { calls, selection };
}

function deterministicFunctionalProbe(durationMs) {
  return (effort, probeOptions) => {
    if (durationMs > probeOptions?.timeout_ms) {
      return {
        status: null,
        error_code: "ETIMEDOUT",
        timed_out: true,
        stdout: "",
        stderr: `${effort} probe timed out`,
      };
    }
    return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
  };
}

function createRecordingDefaultSpawn(calls) {
  return (command, argv, options) => {
    calls.push({ command, argv: [...argv], options });
    if (argv.length === 2 && argv[0] === "-p" && argv[1] === "--help") {
      return { status: 0, stdout: HELP_WITH_XHIGH_MAX, stderr: "" };
    }
    return { status: 0, stdout: '{"type":"result","ok":true}\n', stderr: "" };
  };
}

function assertProbeConfigError(error, classification) {
  assert.equal(error?.name, "ClaudeEffortSelectionError");
  assert.equal(error?.classification, classification);
  assert.equal(error?.effort_selection?.status, "blocked");
  assert.equal(error?.effort_selection?.selected_effort, null);
  assertNoHighFallback(error?.effort_selection);
  return true;
}

test("selector exports probe timeout ceiling constants for renderer containment guards", () => {
  const expectedExports = {
    HELP_PROBE_TIMEOUT_CEILING_MS: 30000,
    FUNCTIONAL_PROBE_TIMEOUT_CEILING_MS: 90000,
  };
  const missingExports = Object.keys(expectedExports).filter(
    (exportName) => !Object.hasOwn(selectorModule, exportName),
  );

  assert.deepEqual(
    missingExports,
    [],
    `selector must export timeout ceiling constants: ${missingExports.join(", ")}`,
  );
  for (const [exportName, expectedValue] of Object.entries(expectedExports)) {
    assert.equal(
      selectorModule[exportName],
      expectedValue,
      `${exportName} must expose the selector's enforced ceiling`,
    );
  }
});

test("micro-probe argv pins opus, effort candidate, and no-tool/no-write profile", () => {
  const argv = buildClaudeEffortMicroProbeArgv("xhigh", CLAUDE_BUILT_IN_MODEL);
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], "Return only the completion JSON required by --json-schema.");
  assert.equal(argv.includes("--model"), true);
  assert.equal(argv[argv.indexOf("--model") + 1], CLAUDE_BUILT_IN_MODEL);
  assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
  assert.equal(argv.includes("--safe-mode"), true);
  assert.equal(argv.includes("stream-json"), true);
  assert.equal(argv.includes("--json-schema"), true);
  const toolsIndex = argv.indexOf("--tools");
  assert.equal(argv[toolsIndex + 1], "");
  assert.ok(toolsIndex > 1, "positional prompt must precede --tools (variadic)");
  assert.equal(argv[argv.length - 1], "");
  assert.equal(argv[argv.length - 2], "--tools");
  assert.equal(argv.includes("--allowedTools"), false);
  assert.equal(argv.includes("Write"), false);
  assert.equal(argv.includes("Bash"), false);
});

test("stub selects xhigh and max without live Claude", () => {
  for (const effort of ["xhigh", "max"]) {
    const selection = selectClaudeSecondReviewerEffort({
      reviewer_family: "claude",
      env: stubEnv(effort),
      effort_ceiling: "max",
    });
    assert.equal(selection.status, "ok");
    assert.equal(selection.selected_effort, effort);
    assert.equal(selection.requested_model, CLAUDE_BUILT_IN_MODEL);
    assertNoHighFallback(selection);
  }
});

test("probe timeout defaults keep help at 15s and functional probes at 90s", () => {
  const { calls, selection } = runWithRecordedProbeTimeouts();
  assert.deepEqual(calls, [
    { probe: "help", timeout_ms: 15000 },
    { probe: "xhigh", timeout_ms: 90000 },
    { probe: "max", timeout_ms: 90000 },
  ]);
  assert.equal(selection.selected_effort, "max");
});

test("default probe path uses canonical argv and actual 15s/90s spawn timeouts", () => {
  const calls = [];
  const env = { NODE_ENV: "test", PROBE_FIXTURE: "default" };
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    executable: "claude-test-fixture-not-installed",
    env,
    effort_ceiling: "max",
    spawnSyncImpl: createRecordingDefaultSpawn(calls),
  });
  assert.equal(selection.selected_effort, "max");
  assert.deepEqual(calls.map(({ command, argv, options }) => ({
    command,
    argv,
    timeout: options.timeout,
    encoding: options.encoding,
    stdio: options.stdio,
    env: options.env,
  })), [
    {
      command: "claude-test-fixture-not-installed",
      argv: ["-p", "--help"],
      timeout: 15000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
    {
      command: "claude-test-fixture-not-installed",
      argv: buildClaudeEffortMicroProbeArgv("xhigh", CLAUDE_BUILT_IN_MODEL),
      timeout: 90000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
    {
      command: "claude-test-fixture-not-installed",
      argv: buildClaudeEffortMicroProbeArgv("max", CLAUDE_BUILT_IN_MODEL),
      timeout: 90000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  ]);
});

// T2 (design D9): effort compatibility is a property OF a specific model. If an
// operator overrides the reviewer model, the micro-probe MUST actually probe
// that overridden model, never the built-in default — otherwise the probe's
// compatibility verdict would apply to a different model than the one dispatched.
test("Effort probe evaluates the resolved requested model — override via DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE reaches the probe argv", () => {
  const calls = [];
  const overrideModel = "claude-opus-5";
  const env = { NODE_ENV: "test", [SECOND_REVIEWER_MODEL_OVERRIDE_ENV.claude]: overrideModel };
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    executable: "claude-test-fixture-not-installed",
    env,
    effort_ceiling: "max",
    spawnSyncImpl: createRecordingDefaultSpawn(calls),
  });
  assert.equal(selection.selected_effort, "max");
  assert.equal(selection.requested_model, overrideModel);
  assert.notEqual(overrideModel, CLAUDE_BUILT_IN_MODEL);

  const [helpCall, xhighCall, maxCall] = calls;
  assert.deepEqual(helpCall.argv, ["-p", "--help"]);
  assert.deepEqual(xhighCall.argv, buildClaudeEffortMicroProbeArgv("xhigh", overrideModel));
  assert.deepEqual(maxCall.argv, buildClaudeEffortMicroProbeArgv("max", overrideModel));
  for (const call of [xhighCall, maxCall]) {
    assert.equal(call.argv[call.argv.indexOf("--model") + 1], overrideModel);
  }
});

// D3 defense-in-depth: selectClaudeSecondReviewerEffort is a public entry
// point. A shape-invalid override MUST fail closed as
// reviewer_model_override_invalid before any probe subprocess is started —
// matching the renderer rule, and proving the selector does not forward a
// malformed model into --model argv.
test("shape-invalid DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE fails as reviewer_model_override_invalid without spawning", () => {
  for (const invalid of ["", " ", "bad model", "x".repeat(65), "../escape"]) {
    let helpProbeCalls = 0;
    let functionalProbeCalls = 0;
    let spawnCalls = 0;
    assert.throws(
      () => selectClaudeSecondReviewerEffort({
        reviewer_family: "claude",
        env: {
          NODE_ENV: "test",
          [SECOND_REVIEWER_MODEL_OVERRIDE_ENV.claude]: invalid,
        },
        spawnSyncImpl() {
          spawnCalls += 1;
          return { status: 0, stdout: HELP_WITH_XHIGH_MAX, stderr: "" };
        },
        runHelpProbe() {
          helpProbeCalls += 1;
          return { ok: true, text: HELP_WITH_XHIGH_MAX };
        },
        runFunctionalProbe() {
          functionalProbeCalls += 1;
          return { status: 0, stdout: '{"type":"result","ok":true}\n', stderr: "" };
        },
      }),
      (error) => assertProbeConfigError(error, "reviewer_model_override_invalid"),
    );
    assert.equal(spawnCalls, 0, `invalid=${JSON.stringify(invalid)} must not spawn`);
    assert.equal(helpProbeCalls, 0, `invalid=${JSON.stringify(invalid)} must not run help probe`);
    assert.equal(functionalProbeCalls, 0, `invalid=${JSON.stringify(invalid)} must not run functional probe`);
  }
});

test("default probe path applies purpose-specific timeout spread after legacy timeout_ms", () => {
  const calls = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    executable: "claude-test-fixture-not-installed",
    env: { NODE_ENV: "test" },
    timeout_ms: 20000,
    help_timeout_ms: 30000,
    functional_timeout_ms: 90000,
    effort_ceiling: "max",
    spawnSyncImpl: createRecordingDefaultSpawn(calls),
  });
  assert.equal(selection.selected_effort, "max");
  assert.deepEqual(calls.map(({ options }) => options.timeout), [30000, 90000, 90000]);
});

test("purpose-specific probe timeouts take priority over legacy timeout_ms", () => {
  const { calls } = runWithRecordedProbeTimeouts({
    help_timeout_ms: 30000,
    functional_timeout_ms: 90000,
    timeout_ms: 22000,
  });
  assert.deepEqual(calls, [
    { probe: "help", timeout_ms: 30000 },
    { probe: "xhigh", timeout_ms: 90000 },
    { probe: "max", timeout_ms: 90000 },
  ]);
});

test("legacy timeout_ms still overrides both probe purposes when specific values are absent", () => {
  const { calls } = runWithRecordedProbeTimeouts({ timeout_ms: 30000 });
  assert.deepEqual(calls, [
    { probe: "help", timeout_ms: 30000 },
    { probe: "xhigh", timeout_ms: 30000 },
    { probe: "max", timeout_ms: 30000 },
  ]);
});

for (const [optionName, aboveCeiling] of [
  ["help_timeout_ms", 30001],
  ["functional_timeout_ms", 90001],
  ["timeout_ms", 30001],
]) {
  test(`${optionName} rejects an above-ceiling resolved timeout before probing`, () => {
    let helpProbeCalls = 0;
    let functionalProbeCalls = 0;
    assert.throws(
      () => selectClaudeSecondReviewerEffort({
        reviewer_family: "claude",
        env: modelProbeTestEnv(),
        [optionName]: aboveCeiling,
        runHelpProbe() {
          helpProbeCalls += 1;
          return { ok: true, text: HELP_WITH_XHIGH_MAX };
        },
        runFunctionalProbe() {
          functionalProbeCalls += 1;
          return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
        },
      }),
      (error) => assertProbeConfigError(error, "probe_timeout_invalid"),
    );
    assert.equal(helpProbeCalls, 0);
    assert.equal(functionalProbeCalls, 0);
  });
}

for (const [pathName, pathOptions] of [
  ["stub", { env: stubEnv("xhigh") }],
  ["probe", { env: modelProbeTestEnv() }],
]) {
  test(`production spawnSyncImpl injection blocks before the ${pathName} path`, () => {
    let spawnCalls = 0;
    let helpProbeCalls = 0;
    let functionalProbeCalls = 0;
    assert.throws(
      () => selectClaudeSecondReviewerEffort({
        reviewer_family: "claude",
        ...pathOptions,
        spawnSyncImpl() {
          spawnCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
        runHelpProbe() {
          helpProbeCalls += 1;
          return { ok: true, text: HELP_WITH_XHIGH_MAX };
        },
        runFunctionalProbe() {
          functionalProbeCalls += 1;
          return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
        },
      }),
      (error) => assertProbeConfigError(error, "probe_spawn_injection_invalid"),
    );
    assert.equal(spawnCalls, 0);
    assert.equal(helpProbeCalls, 0);
    assert.equal(functionalProbeCalls, 0);
  });
}

for (const [invalidName, invalidValue] of [
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["non-number", "90000"],
]) {
  for (const optionName of ["help_timeout_ms", "functional_timeout_ms", "timeout_ms"]) {
    test(`${optionName} rejects resolved ${invalidName} timeout before probing`, () => {
      let helpProbeCalls = 0;
      let functionalProbeCalls = 0;
      assert.throws(
        () => selectClaudeSecondReviewerEffort({
          reviewer_family: "claude",
          env: modelProbeTestEnv(),
          [optionName]: invalidValue,
          runHelpProbe() {
            helpProbeCalls += 1;
            return { ok: true, text: HELP_WITH_XHIGH_MAX };
          },
          runFunctionalProbe() {
            functionalProbeCalls += 1;
            return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
          },
        }),
        (error) => assertProbeConfigError(error, "probe_timeout_invalid"),
      );
      assert.equal(helpProbeCalls, 0);
      assert.equal(functionalProbeCalls, 0);
    });
  }
}

test("slow functional success within the 90s default remains compatible", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: deterministicFunctionalProbe(60000),
  });
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected_effort, "max");
  assertNoHighFallback(selection);
});

test("functional work beyond the 90s default remains a blocking true timeout", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: deterministicFunctionalProbe(90001),
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.classification, "timeout");
  assert.deepEqual(selection.candidates.map(({ effort }) => effort), ["xhigh"]);
  assertNoHighFallback(selection);
});

test("padded Claude identity is rejected before every effort probe", () => {
  let helpProbeCalls = 0;
  let functionalProbeCalls = 0;
  assert.throws(
    () => selectClaudeSecondReviewerEffort({
      reviewer_family: " claude ",
      env: modelProbeTestEnv(),
      runHelpProbe() {
        helpProbeCalls += 1;
        return { ok: true, text: HELP_WITH_XHIGH_MAX };
      },
      runFunctionalProbe() {
        functionalProbeCalls += 1;
        return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
      },
    }),
    (error) => error?.classification === "reviewer_family_invalid",
  );
  assert.equal(helpProbeCalls, 0);
  assert.equal(functionalProbeCalls, 0);
});

test("missing or null Claude identity is rejected before every effort probe", () => {
  for (const reviewer_family of [undefined, null]) {
    let helpProbeCalls = 0;
    assert.throws(
      () => selectClaudeSecondReviewerEffort({
        ...(reviewer_family === undefined ? {} : { reviewer_family }),
        runHelpProbe() {
          helpProbeCalls += 1;
          return { ok: true, text: HELP_WITH_XHIGH_MAX };
        },
      }),
      (error) => error?.classification === "reviewer_family_invalid",
    );
    assert.equal(helpProbeCalls, 0);
  }
});

test("stub alone without allow is blocked with no selected effort", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: { [CLAUDE_EFFORT_STUB_ENV]: "xhigh" },
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.equal(selection.classification, "recipe_unresolved");
  assert.match(JSON.stringify(selection.candidates), /DEVPRO_ALLOW_CLAUDE_EFFORT_STUB|NODE_ENV=test/);
  assertNoHighFallback(selection);
  assert.throws(() => assertClaudeEffortSelectionReady(selection));
});

test("stub fail blocks dispatch-ready recipe with no high fallback", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: stubEnv("fail"),
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.equal(selection.classification, "recipe_unresolved");
  assertNoHighFallback(selection);
  assert.throws(
    () => assertClaudeEffortSelectionReady(selection),
    /MUST NOT dispatch with --effort high/,
  );
});

test("xhigh+max compatible selects max (upgrade)", () => {
  const probed = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: (effort) => {
      probed.push(effort);
      return { status: 0, stdout: '{"type":"result","ok":true}\n', stderr: "" };
    },
  });
  assert.deepEqual(probed, ["xhigh", "max"]);
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected_effort, "max");
  assertNoHighFallback(selection);
});

test("exit 0 without stream-json result line is malformed_stream", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.equal(selection.classification, "malformed_stream");
  assertNoHighFallback(selection);
});

test("xhigh compatible and max incompatible selects xhigh", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: (effort) => {
      if (effort === "xhigh") {
        return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
      }
      return {
        status: 400,
        stdout: "",
        stderr: "invalid --effort max: unsupported",
      };
    },
  });
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected_effort, "xhigh");
  assertNoHighFallback(selection);
});

test("xhigh incompatible fails closed without trying max or high", () => {
  const probed = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: (effort) => {
      probed.push(effort);
      return {
        status: 400,
        stdout: "",
        stderr: "invalid --effort xhigh: unsupported",
      };
    },
  });
  assert.deepEqual(probed, ["xhigh"]);
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.equal(selection.classification, "reviewer_cli_recipe_incompatible");
  assertNoHighFallback(selection);
});

test("xhigh absent from help fails closed without probing max", () => {
  const probed = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    runHelpProbe: () => ({ ok: true, text: HELP_WITHOUT_XHIGH }),
    runFunctionalProbe: (effort) => {
      probed.push(effort);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(probed, []);
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assertNoHighFallback(selection);
});

// --- D10 effort_ceiling ---

test("default effort_ceiling caps selection at xhigh without probing max", () => {
  const probed = [];
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: (effort) => {
      probed.push(effort);
      return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
    },
  });
  assert.deepEqual(probed, ["xhigh"]);
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected_effort, "xhigh");
  assert.equal(selection.classification, "highest_compatible");
  const maxCandidate = selection.candidates.find((candidate) => candidate.effort === "max");
  assert.ok(maxCandidate, "candidates must record the capped-away max tier");
  assert.equal(maxCandidate.classification, "ceiling_capped");
  assertNoHighFallback(selection);
});

test("effort_ceiling max and probe-compatible selects max", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: () => ({ status: 0, stdout: '{"type":"result"}\n', stderr: "" }),
  });
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected_effort, "max");
  assertNoHighFallback(selection);
});

test("stub max exceeds default xhigh ceiling fails closed as effort_stub_exceeds_ceiling", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: stubEnv("max"),
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.equal(selection.classification, "effort_stub_exceeds_ceiling");
  assertNoHighFallback(selection);
  assert.throws(() => assertClaudeEffortSelectionReady(selection));
});

test("stub max within effort_ceiling max is selected", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: stubEnv("max"),
    effort_ceiling: "max",
  });
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected_effort, "max");
});

test("stub without allow is blocked as recipe_unresolved even above ceiling", () => {
  // Unauthorized-stub fail-closed (recipe_unresolved) MUST take priority over the
  // exceeds-ceiling classification, matching D10's "stub 分支之前驗證" ordering.
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: { [CLAUDE_EFFORT_STUB_ENV]: "max" },
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.classification, "recipe_unresolved");
});

test("effort_ceiling outside {xhigh,max} is rejected before every probe", () => {
  let helpProbeCalls = 0;
  let functionalProbeCalls = 0;
  assert.throws(
    () => selectClaudeSecondReviewerEffort({
      reviewer_family: "claude",
      env: modelProbeTestEnv(),
      effort_ceiling: "high",
      runHelpProbe() {
        helpProbeCalls += 1;
        return { ok: true, text: HELP_WITH_XHIGH_MAX };
      },
      runFunctionalProbe() {
        functionalProbeCalls += 1;
        return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
      },
    }),
    (error) => assertProbeConfigError(error, "effort_ceiling_invalid"),
  );
  assert.equal(helpProbeCalls, 0);
  assert.equal(functionalProbeCalls, 0);
});

test("xhigh incompatible under effort_ceiling max still fails closed (no silent downgrade)", () => {
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    effort_ceiling: "max",
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: () => ({
      status: 400,
      stdout: "",
      stderr: "invalid --effort xhigh: unsupported",
    }),
  });
  assert.equal(selection.status, "blocked");
  assert.equal(selection.selected_effort, null);
  assert.equal(selection.classification, "reviewer_cli_recipe_incompatible");
  assertNoHighFallback(selection);
});

for (const classification of [
  "probe_execution_failed",
  "timeout",
  "auth_failure",
  "network_failure",
  "malformed_stream",
  "spawn_failed",
]) {
  test(`${classification} on xhigh is dispatch-blocking with no high/omit-model fallback`, () => {
    const selection = selectClaudeSecondReviewerEffort({
      reviewer_family: "claude",
      env: modelProbeTestEnv(),
      runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
      runFunctionalProbe: (_effort, probeOptions) => {
        assert.equal(probeOptions?.timeout_ms, 90000);
        return { classification, summary: classification };
      },
    });
    assert.equal(selection.status, "blocked");
    assert.equal(selection.selected_effort, null);
    assert.equal(selection.classification, classification);
    assert.equal(selection.requested_model, CLAUDE_BUILT_IN_MODEL);
    assertNoHighFallback(selection);
    assert.throws(() => assertClaudeEffortSelectionReady(selection));
  });

  test(`${classification} on max upgrade after xhigh ok is dispatch-blocking`, () => {
    const selection = selectClaudeSecondReviewerEffort({
      reviewer_family: "claude",
      env: modelProbeTestEnv(),
      effort_ceiling: "max",
      runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
      runFunctionalProbe: (effort, probeOptions) => {
        assert.equal(probeOptions?.timeout_ms, 90000);
        if (effort === "xhigh") {
          return { status: 0, stdout: '{"type":"result"}\n', stderr: "" };
        }
        return { classification, summary: classification };
      },
    });
    assert.equal(selection.status, "blocked");
    assert.equal(selection.selected_effort, null);
    assert.equal(selection.classification, classification);
    assertNoHighFallback(selection);
  });
}

test("helpListsEffortValue matches enum tokens only", () => {
  assert.equal(helpListsEffortValue(HELP_WITH_XHIGH_MAX, "xhigh"), true);
  assert.equal(helpListsEffortValue(HELP_WITH_XHIGH_MAX, "max"), true);
  assert.equal(helpListsEffortValue(HELP_WITHOUT_XHIGH, "xhigh"), false);
  assert.equal(helpListsEffortValue("maximum effort", "max"), false);
});

test("evidence stays bounded and redacted", () => {
  const secret = `sk-abcdefghijklmnopqrstuvwxyz0123456789 and user@example.com https://evil.example/token`;
  const selection = selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    env: modelProbeTestEnv(),
    runHelpProbe: () => ({ ok: true, text: HELP_WITH_XHIGH_MAX }),
    runFunctionalProbe: () => ({
      status: 1,
      stdout: "",
      stderr: `authentication_failed ${secret}`,
    }),
  });
  const json = JSON.stringify(selection);
  assert.doesNotMatch(json, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(json, /user@example\.com/);
  assert.doesNotMatch(json, /https:\/\/evil\.example/);
  assert.match(json, /redacted/);
});

// --- D4 classifier fixtures (issue #2091 / design D1) ---

test("compatible: result id containing 4011 and 4030 is not auth_failure", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      id: "req-4011-session-4030-ok",
      ok: true,
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "compatible");
});

test("compatible: result payload embedding unauthorized / not logged in / not_logged_in is not auth_failure", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      ok: true,
      note: "fixture mentions unauthorized, not logged in, and not_logged_in without auth failure",
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "compatible");
});

test("compatible: result non-allowlisted status/code 401/403 is not auth_failure", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      ok: true,
      status: 401,
      code: "403",
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "compatible");
});

test("auth_failure: exit-0 error-shaped result with allowlisted http_status 401", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      is_error: true,
      http_status: 401,
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: exit-0 error-shaped result with nested allowlisted 403", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      is_error: true,
      error: { code: "403" },
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: exit-0 error-shaped result with Not logged in phrase", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      is_error: true,
      message: "Not logged in",
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: exit-0 error-shaped result with not_logged_in phrase", () => {
  const classified = classifyFunctionalProbeResult({
    status: 0,
    stdout: `${JSON.stringify({
      type: "result",
      is_error: true,
      subtype: "not_logged_in",
      message: "session expired",
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: error record allowlisted exact numeric 401", () => {
  const classified = classifyFunctionalProbeResult({
    status: 1,
    stdout: `${JSON.stringify({
      type: "error",
      http_status: 401,
      message: "rejected",
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: control record allowlisted exact string 403", () => {
  const classified = classifyFunctionalProbeResult({
    status: 1,
    stdout: `${JSON.stringify({
      type: "control",
      error: { code: "403" },
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: stderr-only plain diagnostic Not logged in", () => {
  const classified = classifyFunctionalProbeResult({
    status: 1,
    stdout: "",
    stderr: "Not logged in. Run claude login.",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: non-result stdout plain authentication_failed", () => {
  const classified = classifyFunctionalProbeResult({
    status: 1,
    stdout: "authentication_failed: token expired\n",
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: non-result stdout login required", () => {
  const classified = classifyFunctionalProbeResult({
    status: 1,
    stdout: "login required before continuing\n",
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("auth_failure: allowlisted error JSON subtype not_logged_in on stdout non-result", () => {
  const classified = classifyFunctionalProbeResult({
    status: 1,
    stdout: `${JSON.stringify({
      type: "error",
      subtype: "not_logged_in",
      message: "session expired",
    })}\n`,
    stderr: "",
  });
  assert.equal(classified.classification, "auth_failure");
});

test("timeout: timed_out flag classifies timeout", () => {
  const classified = classifyFunctionalProbeResult({
    status: null,
    timed_out: true,
    stdout: "",
    stderr: "",
  });
  assert.equal(classified.classification, "timeout");
});

test("timeout: ETIMEDOUT error_code classifies timeout", () => {
  const classified = classifyFunctionalProbeResult({
    status: null,
    error_code: "ETIMEDOUT",
    stdout: "",
    stderr: "",
  });
  assert.equal(classified.classification, "timeout");
});

test("timeout: timed_out with auth phrase still timeout (not auth_failure)", () => {
  const classified = classifyFunctionalProbeResult({
    status: null,
    timed_out: true,
    stdout: "",
    stderr: "Not logged in / unauthorized / login required",
  });
  assert.equal(classified.classification, "timeout");
});

// --- Issue #3185: keyword checks must not read success-shaped stream records ---

function successfulProbeStdout(cwd) {
  return [
    JSON.stringify({ type: "system", subtype: "init", cwd, model: "claude-fable-5-1", slash_commands: ["unknown-thing"], output_style: "default" }),
    JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1", content: [{ type: "text", text: "ok" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
  ].join("\n") + "\n";
}

test("compatible: a successful probe stays compatible when cwd or init fields contain classifier keywords", () => {
  for (const cwd of [
    "/repo/.worktree/add-debit-card-invalid-notice",
    "C:\\repo\\.worktree\\fix-unsupported-effort-timeout",
    "/repo/.worktree/fix-network-parse-unexpected-json",
  ]) {
    const classified = classifyFunctionalProbeResult({ status: 0, stdout: successfulProbeStdout(cwd), stderr: "" });
    assert.equal(classified.classification, "compatible", cwd);
  }
});

test("incompatible/timeout/network evidence on stderr or error-shaped records is still classified", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", cwd: "/repo", model: "claude-fable-5-1" });
  for (const [result, expected] of [
    [{ status: 1, stdout: `${init}\n`, stderr: "error: invalid value for --effort\n" }, "incompatible"],
    [{ status: 0, stdout: `${init}\n${JSON.stringify({ type: "error", message: "model does not support effort: unsupported" })}\n`, stderr: "" }, "incompatible"],
    [{ status: 1, stdout: `${init}\n${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "unknown model" })}\n`, stderr: "" }, "incompatible"],
    [{ status: 1, stdout: "error: unknown option '--effort'\n", stderr: "" }, "incompatible"],
    [{ status: 1, stdout: `${init}\n`, stderr: "request timed out\n" }, "timeout"],
    [{ status: 1, stdout: `${init}\n`, stderr: "fetch failed\n" }, "network_failure"],
  ]) {
    assert.equal(classifyFunctionalProbeResult(result).classification, expected, JSON.stringify(result).slice(0, 160));
  }
});

test("production spawn injection rejects before automatic model discovery", () => {
  let calls=0;
  assert.throws(()=>actualSelectClaudeSecondReviewerEffort({reviewer_family:"claude",env:{},
    modelProbe:()=>{calls++;return modelProbeEvidence.claude;},spawnSyncImpl:()=>{calls++;}}),
    error=>assertProbeConfigError(error,"probe_spawn_injection_invalid"));
  assert.equal(calls,0);
});
