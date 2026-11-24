import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OPENCODE_PROBE_TOKEN,
  OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV,
  OpenCodeReviewerError,
  assertOpenCodeSelection,
  composeOpenCodeLaunchConfig,
  dispatchedSessionIdFromEvents,
  evaluateOpenCodeProbeRun,
  normalizeOpenCodeExport,
  OPENCODE_ALLOWED_TOOL_NAMES,
  openCodeAgentNameForPolicy,
  openCodeDisallowedToolUses,
  openCodeExportArgv,
  openCodeReviewerEnv,
  openCodeRunArgv,
  parseOpenCodeModelSelector,
  parseOpenCodeRunEvents,
  parseOpenCodeVersion,
  resolveOpenCodeReviewerSelection,
  serializeOpenCodeModelSelector,
  validateOpenCodeCompletionEvidence,
  verifyOpenCodeExportHelp,
} from "../lib/opencode-reviewer.mjs";

// v2 fixtures are real local smoke captures (opencode v2.0.24, stdin prompt, neutral cwd).
// v1 fixtures follow the exported schema observed on the remote opencode 1.18.31 audit
// (messages[].info providerID/modelID/sessionID/finish/time.completed); the real remote
// smoke is a separate acceptance gate, so these only pin the reader, not the CLI.
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode");
const readFixture = (name) => readFileSync(path.join(fixtureDir, name), "utf8");
const v2Events = () => readFixture("v2-run-events.ndjson");
// The remote v1 CLI runs on Windows and emits CRLF line ends; the fixture is stored with LF so
// git line-end conversion cannot change it, and the CRLF shape is applied here explicitly.
const v1Events = () => readFixture("v1-run-events.ndjson").replace(/\r?\n/g, "\r\n");
const v2Export = () => JSON.parse(readFixture("v2-session-export.json"));
const v1Export = () => JSON.parse(readFixture("v1-session-export.json"));
const V2_INPUT = Buffer.from("Reply with the single token STDIN_OK.\n", "utf8");
const V1_INPUT = Buffer.from("Review packet\n", "utf8");
const selection = () => resolveOpenCodeReviewerSelection({ [OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV]: "deepseek/deepseek-v4-pro" });

function assertCode(fn, classification) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OpenCodeReviewerError, String(error));
    assert.equal(error.classification, classification);
    return true;
  });
}

test("selection: explicit selector has a verified family; no remembered automatic default", () => {
  const chosen = selection();
  assert.deepEqual(
    { providerID: chosen.providerID, modelID: chosen.modelID, selector: chosen.selector },
    { providerID: "deepseek", modelID: "deepseek-v4-pro", selector: "deepseek/deepseek-v4-pro" }
  );
  assert.equal(chosen.family, "deepseek");
  assert.equal(chosen.source, "env-override");
  assert.equal(chosen.env_var, OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV);
  assert.throws(() => resolveOpenCodeReviewerSelection({}), /catalog probe evidence/);
  assert.deepEqual(assertOpenCodeSelection(chosen), chosen);
});

test("selection: env override is parsed at the first slash and keeps the whole modelID", () => {
  const chosen = resolveOpenCodeReviewerSelection({
    [OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV]: "deepseek/vendor/deepseek-v4-pro:beta",
  });
  assert.equal(chosen.providerID, "deepseek");
  assert.equal(chosen.modelID, "vendor/deepseek-v4-pro:beta");
  assert.equal(chosen.selector, "deepseek/vendor/deepseek-v4-pro:beta");
  assert.equal(chosen.source, "env-override");
  assert.equal(chosen.env_var, OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV);
  // F-3-1: serialize(parse(x)) is the identity, so an internal slash survives untouched.
  assert.deepEqual(parseOpenCodeModelSelector(chosen.selector), {
    providerID: "deepseek",
    modelID: "vendor/deepseek-v4-pro:beta",
  });
});

test("selection: rejects shapes the installed CLI would reinterpret", () => {
  for (const bad of [
    "deepseek",
    "/deepseek-v4-pro",
    "deepseek/",
    "deepseek/deepseek-v4-pro#fast",
    " deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-pro ",
    "deepseek/Deep Seek",
    "-deepseek/model",
    "deepseek/a//b",
    "deepseek/a/",
    "",
    42,
  ]) {
    assertCode(() => parseOpenCodeModelSelector(bad), "opencode_model_selector_invalid");
  }
  assertCode(
    () => serializeOpenCodeModelSelector({ providerID: "deep/seek", modelID: "m" }),
    "opencode_model_selector_invalid"
  );
});

test("selection: an unverified provider is not-ready instead of guessed", () => {
  assertCode(
    () => resolveOpenCodeReviewerSelection({ [OPENCODE_REVIEWER_MODEL_OVERRIDE_ENV]: "ollama/qwen2.5:14b" }),
    "opencode_reviewer_family_unverified"
  );
});

test("selection: a carried selection must equal the canonical rebuild", () => {
  const forged = { ...selection(), family: "claude" };
  assertCode(() => assertOpenCodeSelection(forged), "opencode_model_selector_invalid");
  const lowered = { ...selection(), modelID: "DeepSeek-V4-Pro" };
  assertCode(() => assertOpenCodeSelection(lowered), "opencode_model_selector_invalid");
  assertCode(() => assertOpenCodeSelection(null), "opencode_model_selector_invalid");
});

test("generation: versions map to adapters and unknown majors fail closed", () => {
  assert.deepEqual(parseOpenCodeVersion("opencode v2.0.24\n"), {
    version: "2.0.24", major: 2, minor: 0, patch: 24, generation: "v2",
  });
  assert.equal(parseOpenCodeVersion("1.18.31").generation, "v1");
  assertCode(() => parseOpenCodeVersion("3.0.0"), "opencode_version_unsupported");
  assertCode(() => parseOpenCodeVersion("no version"), "opencode_version_unsupported");
});

test("generation: run/export argv differ only where the installed schemas differ", () => {
  const selector = "deepseek/deepseek-v4-pro";
  assert.deepEqual(
    openCodeRunArgv("v2", { agent: "devpro-review-audit", selector }),
    ["run", "--standalone", "--format", "json", "--agent", "devpro-review-audit", "--model", selector]
  );
  assert.deepEqual(
    openCodeRunArgv("v1", { agent: "devpro-review-audit", selector }),
    ["run", "--format", "json", "--agent", "devpro-review-audit", "--model", selector]
  );
  assert.deepEqual(
    openCodeExportArgv("v2", "ses_eb500fd6effemdSxiZ5RXAFTsH"),
    ["session", "export", "--standalone", "ses_eb500fd6effemdSxiZ5RXAFTsH"]
  );
  assert.deepEqual(
    openCodeExportArgv("v1", "ses_eb50fbd13ffeZxVn2BnMSXEizk"),
    ["export", "ses_eb50fbd13ffeZxVn2BnMSXEizk"]
  );
  assertCode(() => openCodeExportArgv("v2", "ses_x;rm -rf"), "opencode_session_binding_mismatch");
  assertCode(() => openCodeRunArgv("v2", { agent: "bad agent", selector }), "opencode_reviewer_invalid");
});

test("generation: root help with exit 0 is not proof that the export subcommand exists", () => {
  const v2RootHelp = "DESCRIPTION\n  OpenCode command line interface\n\nUSAGE\n  opencode <subcommand> [flags] [<directory>]\n";
  const v2ExportHelp = "DESCRIPTION\n  Export session data as JSON\n\nUSAGE\n  opencode session export [flags] [<session>]\n";
  assert.equal(verifyOpenCodeExportHelp("v2", v2ExportHelp), true);
  assert.equal(verifyOpenCodeExportHelp("v2", v2RootHelp), false);
  const v1ExportHelp = "opencode export [sessionID]\n\nexport session data as JSON\n";
  const v1RootHelp = "opencode run [message..]\n\nrun opencode with a message\n\nopencode export [sessionID]\n";
  assert.equal(verifyOpenCodeExportHelp("v1", v1ExportHelp), true);
  assert.equal(verifyOpenCodeExportHelp("v1", v1RootHelp), false);
});

test("env: ambient config is stripped and only the trusted launch config applies", () => {
  const env = openCodeReviewerEnv({
    baseEnv: {
      PATH: "/usr/bin",
      OPENCODE_CONFIG: "/candidate/opencode.json",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_CONFIG_DIR: "/candidate/.opencode",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      DEEPSEEK_API_KEY: "kept-for-provider-auth",
    },
    launchConfigPath: "/trusted/launch.json",
    cwd: "/tmp/neutral",
  });
  assert.equal(env.OPENCODE_CONFIG, "/trusted/launch.json");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.DEEPSEEK_API_KEY, "kept-for-provider-auth");
  assertCode(() => openCodeReviewerEnv({ baseEnv: {}, launchConfigPath: "" }), "opencode_launch_config_missing");
});

test("env: PWD is the spawn cwd, never the caller's inherited working directory", () => {
  // A live OpenCode v2.0.24 run resolved a relative write against an inherited PWD (the caller's worktree), not its cwd.
  const env = openCodeReviewerEnv({ baseEnv: { PWD: "/repo/feature-worktree" }, launchConfigPath: "/trusted/launch.json", cwd: "/tmp/neutral" });
  assert.equal(env.PWD, "/tmp/neutral");
  for (const cwd of [undefined, "", "relative/neutral"]) {
    assertCode(() => openCodeReviewerEnv({ baseEnv: {}, launchConfigPath: "/trusted/launch.json", cwd }), "opencode_launch_config_invalid");
  }
});

test("launch config: v2 uses agents/permissions (the legacy agent/permissions keys do not restrict tools)", () => {
  const none = composeOpenCodeLaunchConfig({
    generation: "v2",
    toolPolicy: "none",
    instructionFiles: ["/trusted/rules/code-review-checklist.md"],
  });
  assert.equal(none.agent, undefined);
  assert.deepEqual(Object.keys(none.agents), ["devpro-review-audit"]);
  assert.deepEqual(none.agents["devpro-review-audit"].permissions, [
    { action: "*", resource: "*", effect: "deny" },
  ]);
  assert.equal(none.agents["devpro-review-audit"].mode, "primary");
  assert.deepEqual(none.instructions, ["/trusted/rules/code-review-checklist.md"]);
});

test("launch config: v2 read-only grants read tools plus external_directory for the named roots only", () => {
  const readOnly = composeOpenCodeLaunchConfig({
    generation: "v2",
    toolPolicy: "read-only",
    readableRoots: ["/work/tree"],
  });
  // The probe agent is always present and stays tool-free.
  assert.deepEqual(readOnly.agents["devpro-review-audit"].permissions, [
    { action: "*", resource: "*", effect: "deny" },
  ]);
  const rules = readOnly.agents["devpro-review-primary"].permissions;
  assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "deny" });
  assert.ok(rules.some((rule) => rule.action === "external_directory" && rule.resource === "/work/tree/*"));
  for (const action of ["read", "glob"]) {
    assert.ok(rules.some((rule) => rule.action === action && rule.effect === "allow"), action);
  }
  // `grep` is matched on its regex, not on a path, so the environment-file denials below could never apply
  // to it: one search inside an allowed root would return protected content. It is withheld, not half-guarded.
  assert.ok(!rules.some((rule) => rule.action === "grep" && rule.effect === "allow"), "grep must not be granted");
  assert.ok(rules.some((rule) => rule.action === "grep" && rule.resource === "*" && rule.effect === "deny"), "grep is denied explicitly");
  assert.ok(!rules.some((rule) => ["edit", "shell"].includes(rule.action) && rule.effect === "allow"));
  // Environment files are denied after the read grant (ordered rules, last match wins), never before it.
  const readGrant = rules.findIndex((rule) => rule.action === "read" && rule.resource === "*" && rule.effect === "allow");
  for (const resource of ["*.env", "*.env.*"]) {
    const denial = rules.findIndex((rule) => rule.action === "read" && rule.resource === resource && rule.effect === "deny");
    assert.ok(denial > readGrant && readGrant > 0, `${resource} must be denied after the read grant`);
  }
  assert.equal(openCodeAgentNameForPolicy("pr-sticky"), "devpro-review-sticky");
});

test("launch config: v2 pr-sticky allows only the body file and the exact helper commands", () => {
  const sticky = composeOpenCodeLaunchConfig({
    generation: "v2",
    toolPolicy: "pr-sticky",
    cwd: "/neutral",
    writablePaths: ["/neutral/cross-model-second-opinion.md"],
    shellCommands: ["node /repo/.devpro/scripts/write-second-review-sticky-gated.mjs"],
  });
  const rules = sticky.agents["devpro-review-sticky"].permissions;
  // A real v2 smoke denied the absolute spelling of this very file and allowed the relative one.
  assert.deepEqual(rules.filter((rule) => rule.effect === "allow"), [
    { action: "edit", resource: "cross-model-second-opinion.md", effect: "allow" },
    { action: "shell", resource: "node /repo/.devpro/scripts/write-second-review-sticky-gated.mjs", effect: "allow" },
    { action: "shell", resource: "node /repo/.devpro/scripts/write-second-review-sticky-gated.mjs *", effect: "allow" },
  ]);
});

test("launch config: shell commands and paths are validated before they reach a permission rule", () => {
  for (const command of ["rm -rf /", "node relative.mjs", "node /a.mjs; rm -rf /", "node /a.mjs && ls", "node /a.mjs $(x)", "node /a/*.mjs"]) {
    assertCode(
      () => composeOpenCodeLaunchConfig({ generation: "v2", toolPolicy: "pr-sticky", shellCommands: [command] }),
      "opencode_launch_config_invalid"
    );
  }
  assertCode(
    () => composeOpenCodeLaunchConfig({ generation: "v2", toolPolicy: "read-only", readableRoots: ["/a/*"] }),
    "opencode_launch_config_invalid"
  );
  assertCode(
    () => composeOpenCodeLaunchConfig({ generation: "v2", toolPolicy: "pr-sticky", writablePaths: ["relative.md"] }),
    "opencode_launch_config_invalid"
  );
  // The relative edit resource is only meaningful for a file inside the neutral cwd.
  for (const [cwd, file] of [
    [undefined, "/neutral/body.md"],
    ["/neutral", "/elsewhere/body.md"],
    ["/neutral", "/neutral/../escape.md"],
    ["/neutral", "/neutral"],
    ["/neutral", "/neutralish/body.md"],
    ["relative-cwd", "relative-cwd/body.md"],
  ]) {
    assertCode(
      () => composeOpenCodeLaunchConfig({ generation: "v2", toolPolicy: "pr-sticky", cwd, writablePaths: [file] }),
      "opencode_launch_config_invalid"
    );
  }
  const nested = composeOpenCodeLaunchConfig({
    generation: "v2",
    toolPolicy: "pr-sticky",
    cwd: "C:\\work\\neutral",
    writablePaths: ["C:\\work\\neutral\\sub\\body.md"],
  });
  assert.equal(nested.agents["devpro-review-sticky"].permissions.find((rule) => rule.action === "edit").resource, "sub/body.md");
});

test("tool policy: the event-name allowlist grows with the policy and rejects everything else", () => {
  assert.deepEqual(OPENCODE_ALLOWED_TOOL_NAMES.none, []);
  assert.ok(!OPENCODE_ALLOWED_TOOL_NAMES["read-only"].includes("write"));
  assert.ok(!OPENCODE_ALLOWED_TOOL_NAMES["read-only"].includes("shell"));
  for (const tool of ["write", "edit", "shell", "bash", "read"]) assert.ok(OPENCODE_ALLOWED_TOOL_NAMES["pr-sticky"].includes(tool), tool);
  assert.ok(!OPENCODE_ALLOWED_TOOL_NAMES["read-only"].includes("edit"));
  for (const policy of ["read-only", "pr-sticky"]) {
    assert.ok(!OPENCODE_ALLOWED_TOOL_NAMES[policy].includes("grep"), `${policy}: a grep call means the profile was left`);
  }
  for (const tool of ["read", "glob", "list"]) assert.ok(OPENCODE_ALLOWED_TOOL_NAMES["read-only"].includes(tool), tool);
  for (const tool of ["webfetch", "task", "patch", "todowrite", "unknown"]) {
    assert.ok(!OPENCODE_ALLOWED_TOOL_NAMES["pr-sticky"].includes(tool), tool);
  }
  const uses = [{ tool: "read", status: "completed" }, { tool: "webfetch", status: "error" }, { tool: "shell", status: "completed" }];
  assert.deepEqual(openCodeDisallowedToolUses("none", uses).map((use) => use.tool), ["read", "webfetch", "shell"]);
  assert.deepEqual(openCodeDisallowedToolUses("read-only", uses).map((use) => use.tool), ["webfetch", "shell"]);
  assert.deepEqual(openCodeDisallowedToolUses("pr-sticky", uses).map((use) => use.tool), ["webfetch"]);
  assertCode(() => openCodeDisallowedToolUses("ordinary-primary", uses), "opencode_reviewer_invalid");
});

test("launch config: v1 is refused for every policy, because its tool table cannot be made deny-by-default", () => {
  // v1 permissions are a finite per-tool table: a tool the table does not name stays enabled, and `edit` cannot be
  // confined to one file. A launch config that cannot be closed is not written, whatever the policy.
  for (const toolPolicy of ["none", "read-only", "pr-sticky"]) {
    assertCode(() => composeOpenCodeLaunchConfig({
      generation: "v1",
      toolPolicy,
      cwd: "/neutral",
      readableRoots: ["/work"],
      writablePaths: toolPolicy === "pr-sticky" ? ["/neutral/cross-model-second-opinion.md"] : [],
      shellCommands: toolPolicy === "pr-sticky" ? ["node /repo/.devpro/scripts/write-second-review-sticky-gated.mjs"] : [],
    }), "opencode_version_unsupported");
  }
  assertCode(
    () => composeOpenCodeLaunchConfig({ generation: "v2", toolPolicy: "none", instructionFiles: ["relative.md"] }),
    "opencode_launch_config_invalid"
  );
  assertCode(() => composeOpenCodeLaunchConfig({ generation: "v3", toolPolicy: "none" }), "opencode_version_unsupported");
});

test("events: v2 stdin smoke yields one session and the literal final text", () => {
  const parsed = parseOpenCodeRunEvents(v2Events());
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.tool_uses, []);
  assert.equal(parsed.final_text, "STDIN_OK");
  assert.equal(dispatchedSessionIdFromEvents(parsed), "ses_eb5000658ffeEpZCzkI0yl09SK");
});

test("events: v1 CRLF stream carries step_finish and one session", () => {
  const parsed = parseOpenCodeRunEvents(v1Events());
  assert.equal(parsed.final_text, "verdict: PASS\nreason: fixture\n");
  assert.equal(parsed.step_finish_reason, "stop");
  assert.equal(parsed.malformed_lines, 0);
  assert.equal(dispatchedSessionIdFromEvents(parsed), "ses_eb50fbd13ffeZxVn2BnMSXEizk");
});

test("events: error and tool events are surfaced, malformed lines are counted not repaired", () => {
  const stream = [
    JSON.stringify({ type: "error", sessionID: "ses_abcdefgh1234", error: { type: "provider.no-route", message: "Model unavailable: deepseek/x" } }),
    JSON.stringify({ type: "tool_use", sessionID: "ses_abcdefgh1234", part: { tool: "read", state: { status: "error" } } }),
    "{not json",
  ].join("\n");
  const parsed = parseOpenCodeRunEvents(stream);
  assert.equal(parsed.errors[0].type, "provider.no-route");
  assert.deepEqual(parsed.tool_uses, [{ tool: "read", status: "error" }]);
  assert.equal(parsed.malformed_lines, 1);
  assert.equal(parsed.final_text, null);
});

test("events: mixed or missing session ids are a binding failure", () => {
  const mixed = [
    JSON.stringify({ type: "step_start", sessionID: "ses_aaaaaaaa1111" }),
    JSON.stringify({ type: "step_start", sessionID: "ses_bbbbbbbb2222" }),
  ].join("\n");
  assertCode(
    () => dispatchedSessionIdFromEvents(parseOpenCodeRunEvents(mixed)),
    "opencode_session_binding_mismatch"
  );
  assertCode(
    () => dispatchedSessionIdFromEvents(parseOpenCodeRunEvents("")),
    "opencode_session_binding_mismatch"
  );
});

function validateV2(mutate = () => {}, overrides = {}) {
  const exported = v2Export();
  mutate(exported);
  const parsed = parseOpenCodeRunEvents(v2Events());
  return validateOpenCodeCompletionEvidence({
    normalized: normalizeOpenCodeExport(exported, "v2"),
    dispatchedSessionId: dispatchedSessionIdFromEvents(parsed),
    selection: selection(),
    inputBytes: V2_INPUT,
    runFinalText: parsed.final_text,
    ...overrides,
  });
}

function validateV1(mutate = () => {}) {
  const exported = v1Export();
  mutate(exported);
  const parsed = parseOpenCodeRunEvents(v1Events());
  return validateOpenCodeCompletionEvidence({
    normalized: normalizeOpenCodeExport(exported, "v1"),
    dispatchedSessionId: dispatchedSessionIdFromEvents(parsed),
    selection: selection(),
    inputBytes: V1_INPUT,
    runFinalText: parsed.final_text,
  });
}

test("evidence: v2 smoke export satisfies session, input, model, terminal and report binding", () => {
  const result = validateV2();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.provider_id, "deepseek");
  assert.equal(result.evidence.model_id, "deepseek-v4-pro");
  assert.equal(result.evidence.finish, "stop");
  assert.equal(result.evidence.cli_generation, "v2");
  assert.equal(result.report_text, "STDIN_OK");
});

test("evidence: v1 documented-shape export satisfies the same binding", () => {
  const result = validateV1();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence.cli_generation, "v1");
  assert.equal(result.evidence.model_id, "deepseek-v4-pro");
});

test("evidence: providerID and modelID are compared exactly, case-sensitively, per field", () => {
  const caseChanged = validateV2((exported) => {
    exported.messages.find((m) => m.type === "assistant").model.id = "DeepSeek-V4-Pro";
  });
  assert.equal(caseChanged.classification, "opencode_model_provenance_mismatch");
  const providerChanged = validateV2((exported) => {
    exported.messages.find((m) => m.type === "assistant").model.providerID = "opencode";
  });
  assert.equal(providerChanged.classification, "opencode_model_provenance_mismatch");
  const joined = validateV2((exported) => {
    const assistant = exported.messages.find((m) => m.type === "assistant");
    assistant.model.providerID = "deepseek/deepseek-v4";
    assistant.model.id = "pro";
  });
  assert.equal(joined.classification, "opencode_model_provenance_mismatch");
  const v1Wrong = validateV1((exported) => {
    exported.messages[1].info.modelID = "deepseek-v4-flash";
  });
  assert.equal(v1Wrong.classification, "opencode_model_provenance_mismatch");
});

test("evidence: a different model on any assistant turn is not-ready, not just the last", () => {
  const result = validateV2((exported) => {
    const first = structuredClone(exported.messages.find((m) => m.type === "assistant"));
    first.id = "msg_first";
    first.finish = "tool-calls";
    first.model.id = "other-model";
    exported.messages.splice(1, 0, first);
  });
  assert.equal(result.classification, "opencode_model_provenance_mismatch");
});

test("evidence: session, input and report bytes must bind exactly", () => {
  assert.equal(
    validateV2((exported) => { exported.info.id = "ses_zzzzzzzz9999"; }).classification,
    "opencode_session_binding_mismatch"
  );
  assert.equal(
    validateV2(() => {}, { inputBytes: Buffer.from("Reply with the single token STDIN_OK.", "utf8") }).classification,
    "opencode_input_binding_mismatch"
  );
  assert.equal(
    validateV2((exported) => {
      exported.messages.push({ id: "msg_extra", time: { created: 1 }, text: "again", files: [], type: "user" });
    }).classification,
    "opencode_input_binding_mismatch"
  );
  assert.equal(
    validateV2(() => {}, { runFinalText: "STDIN_OK " }).classification,
    "opencode_report_mismatch"
  );
});

test("evidence: terminal completion needs finish=stop, a completed timestamp and a succeeded outcome", () => {
  assert.equal(
    validateV2((exported) => {
      exported.messages.find((m) => m.type === "assistant").finish = "length";
    }).classification,
    "opencode_terminal_evidence_missing"
  );
  assert.equal(
    validateV2((exported) => {
      delete exported.messages.find((m) => m.type === "assistant").time.completed;
    }).classification,
    "opencode_terminal_evidence_missing"
  );
  assert.equal(
    validateV2((exported) => {
      exported.messages.find((m) => m.type === "idle").outcome = "failed";
    }).classification,
    "opencode_terminal_evidence_missing"
  );
  assert.equal(
    validateV1((exported) => { delete exported.messages[1].info.time.completed; }).classification,
    "opencode_terminal_evidence_missing"
  );
});

test("evidence: a malformed export is rejected before any field is trusted", () => {
  assertCode(() => normalizeOpenCodeExport({ info: {}, messages: [] }, "v2"), "opencode_export_malformed");
  assertCode(() => normalizeOpenCodeExport(null, "v1"), "opencode_export_malformed");
  assertCode(
    () => normalizeOpenCodeExport({ info: { id: "ses_x" }, messages: [{ role: "assistant" }] }, "v1"),
    "opencode_export_malformed"
  );
});

test("probe: the token proves liveness only and tool use or errors void it", () => {
  const ok = parseOpenCodeRunEvents(JSON.stringify({
    type: "text", sessionID: "ses_aaaaaaaa1111",
    part: { type: "text", messageID: "msg_1", text: OPENCODE_PROBE_TOKEN },
  }));
  assert.deepEqual(evaluateOpenCodeProbeRun({ exitCode: 0, parsedEvents: ok }), { ok: true });
  assert.equal(evaluateOpenCodeProbeRun({ exitCode: 1, parsedEvents: ok }).classification, "opencode_probe_run_failed");
  const empty = parseOpenCodeRunEvents("");
  assert.equal(evaluateOpenCodeProbeRun({ exitCode: 0, parsedEvents: empty }).classification, "opencode_probe_token_missing");
  const withTool = parseOpenCodeRunEvents([
    JSON.stringify({ type: "tool_use", sessionID: "ses_aaaaaaaa1111", part: { tool: "read", state: { status: "completed" } } }),
    JSON.stringify({ type: "text", sessionID: "ses_aaaaaaaa1111", part: { type: "text", messageID: "msg_1", text: OPENCODE_PROBE_TOKEN } }),
  ].join("\n"));
  assert.equal(evaluateOpenCodeProbeRun({ exitCode: 0, parsedEvents: withTool }).classification, "opencode_probe_tool_use");
});

test("runner spawn env: an OpenCode reviewer's PWD is the neutral cwd, not the runner's worktree", async () => {
  const { __testReviewerSpawnEnv } = await import("../run-second-reviewer-projection.mjs");
  const context = {
    neutral_cwd_path: "/tmp/devpro-neutral",
    repository_slug: "example/repo",
    pr_number: "1",
    reviewer_cli_recipe: { tool: "opencode" },
    reviewer_opencode: { launch_config_path: "/tmp/devpro-neutral/opencode.json" },
  };
  const env = __testReviewerSpawnEnv.reviewerSpawnEnv(context, { platform: "darwin", baseEnv: { PWD: "/repo/feature-worktree" } });
  assert.equal(env.PWD, "/tmp/devpro-neutral");
  assert.equal(env.OPENCODE_CONFIG, "/tmp/devpro-neutral/opencode.json");
});
