import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENCODE_PROBE_TOKEN } from "../lib/opencode-reviewer.mjs";
import { canonicalReviewerCliRecipe } from "../second-reviewer-cli-recipe-contract.mjs";
import { evaluateProbeEvidence } from "../probe-second-reviewer-cli-recipe.mjs";
import { buildOpenCodeContext } from "./lib/opencode-context-fixture.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// The probe route is exercised end to end with an injected runCommand: no OpenCode binary,
// no network, no credentials. The fake answers like a v2 CLI whose run/export fixtures were
// captured from a real local smoke, rewritten to carry the probe prompt and token.
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode");
const readFixture = (name) => readFileSync(path.join(fixtureDir, name), "utf8");
const PROBE_PROMPT = `Reply with exactly the single token ${OPENCODE_PROBE_TOKEN} and nothing else. Do not use any tools.\n`;

const RUN_HELP = [
  "USAGE",
  "  opencode run [flags]",
  "FLAGS",
  "  --standalone   run without a server",
  "  --format <fmt>   output format",
  "  --agent <name>   agent to use",
  "  --model <id>   model to use",
  "",
].join("\n");
const EXPORT_HELP = "DESCRIPTION\n  Export session data as JSON\n\nUSAGE\n  opencode session export [flags] [<session>]\n";
const ROOT_HELP = "DESCRIPTION\n  OpenCode command line interface\n\nUSAGE\n  opencode <subcommand> [flags] [<directory>]\n";

function probeRunEvents() {
  return readFixture("v2-run-events.ndjson").replaceAll("STDIN_OK", OPENCODE_PROBE_TOKEN);
}

function probeExport() {
  const exported = JSON.parse(readFixture("v2-session-export.json"));
  exported.messages[0].text = PROBE_PROMPT;
  exported.messages[1].content[0].text = OPENCODE_PROBE_TOKEN;
  return exported;
}

function ok(stdout, stderr = "") {
  return { command: "opencode", args: [], status: 0, signal: null, error: null, error_code: null, stdout, stderr };
}

function failed(stderr, status = 1) {
  return { command: "opencode", args: [], status, signal: null, error: null, error_code: null, stdout: "", stderr };
}

function setup({ version = "2.0.24\n", runResult, exportResult, exportHelp = EXPORT_HELP, mutateExport } = {}) {
  const root = makeTempDir("devpro-opencode-probe-route-");
  const launchPath = path.join(root, "launch", "opencode-launch.json");
  const probeCwdRoot = path.join(root, "probe-cwd");
  mkdirSync(probeCwdRoot, { recursive: true });
  const context = buildOpenCodeContext({ launchConfigPath: launchPath });
  context.reviewer_cli_recipe = canonicalReviewerCliRecipe(context);

  const exported = probeExport();
  for (const message of exported.messages) if (message.model) message.model.variant = "max";
  mutateExport?.(exported);
  const calls = [];
  const runCommand = (command, options = {}) => {
    const argv = command.argv;
    calls.push({ argv, options });
    if (argv.join(" ") === "--version") return ok(version);
    if (argv.join(" ") === "run --help") return ok(RUN_HELP);
    if (argv.join(" ") === "session export --help") return ok(exportHelp);
    if (argv[0] === "run") return runResult ?? ok(probeRunEvents());
    if (argv[0] === "session" && argv[1] === "export") return exportResult ?? ok(JSON.stringify(exported));
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
  return { root, launchPath, probeCwdRoot, context, calls, runCommand };
}

function probe(env, extra = {}) {
  return evaluateProbeEvidence(env.context, {
    runCommand: env.runCommand,
    probeCwdRoot: env.probeCwdRoot,
    env: { PATH: "/usr/bin", HOME: "/home/ignored", OPENCODE_CONFIG: "/ambient/should-be-replaced.json" },
    ...extra,
  });
}

function withCleanup(env, fn) {
  try {
    return fn();
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
}

test("probe route: token, export, exact model and completion all verified", () => {
  const env = setup();
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "ok");
    assert.equal(result.classification, "flags_supported");
    assert.equal(result.auth_preflight.classification, "reviewer_host_capability_verified");
    assert.equal(result.auth_preflight.command_summary.stage, "validate");
    assert.equal(result.auth_preflight.command_summary.error_class, null);

    const runCall = env.calls.find((call) => call.argv[0] === "run" && call.argv[1] !== "--help");
    assert.deepEqual(runCall.argv, [
      "run", "--standalone", "--format", "json",
      "--agent", "devpro-review-audit", "--model", "deepseek/deepseek-v4-pro#max",
    ]);
    assert.equal(runCall.options.input, PROBE_PROMPT);
    assert.equal(runCall.options.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
    assert.equal(runCall.options.env.OPENCODE_CONFIG, env.launchPath);
    assert.ok(runCall.options.cwd.startsWith(env.probeCwdRoot), "token run must use a throwaway cwd");

    const exportCall = env.calls.find((call) => call.argv[0] === "session" && call.argv[1] === "export" && call.argv[2] !== "--help");
    assert.deepEqual(exportCall.argv, ["session", "export", "--standalone", "ses_eb5000658ffeEpZCzkI0yl09SK"]);
    assert.equal(exportCall.options.cwd, runCall.options.cwd);

    // The trusted launch file was materialized privately; the throwaway cwd did not survive.
    // Windows has no POSIX permission bits to compare; there the file only has to exist and be readable.
    if (process.platform === "win32") assert.ok(statSync(env.launchPath).isFile());
    else assert.equal(statSync(env.launchPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(env.probeCwdRoot), []);
  });
});

test("probe route: a different model in the exported session voids the route", () => {
  const env = setup({
    mutateExport(exported) {
      exported.messages[1].model.id = "deepseek-v4-flash";
    },
  });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "reviewer_host_surface_unverified");
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_model_provenance_mismatch");
    assert.equal(result.auth_preflight.command_summary.stage, "validate");
  });
});

test("probe route: provider case differences are not equal", () => {
  const env = setup({
    mutateExport(exported) {
      exported.messages[1].model.providerID = "DeepSeek";
    },
  });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_model_provenance_mismatch");
  });
});

test("probe route: a missing token never reaches the export step", () => {
  const env = setup({ runResult: ok(probeRunEvents().replaceAll(OPENCODE_PROBE_TOKEN, "SOMETHING_ELSE")) });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "blocked");
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_probe_token_missing");
    assert.equal(result.auth_preflight.command_summary.stage, "run");
    assert.ok(!env.calls.some((call) => call.argv[0] === "session" && call.argv[2] !== "--help"));
  });
});

test("probe route: tool use during the token run voids it", () => {
  const toolEvent = JSON.stringify({
    type: "tool_use",
    timestamp: 1792259653000,
    sessionID: "ses_eb5000658ffeEpZCzkI0yl09SK",
    part: { type: "tool", tool: "read", state: { status: "completed" } },
  });
  const env = setup({ runResult: ok(`${probeRunEvents().trimEnd()}\n${toolEvent}\n`) });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_probe_tool_use");
  });
});

test("probe route: a non-zero run is a command failure, not a model verdict", () => {
  const env = setup({ runResult: failed("provider rejected the request") });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "blocked");
    assert.equal(result.auth_preflight.command_summary.error_class, "command_failed");
    assert.equal(result.auth_preflight.command_summary.stage, "run");
  });
});

test("probe route: unparseable export output is unavailable evidence at the export stage", () => {
  const env = setup({ exportResult: ok("this is not json") });
  withCleanup(env, () => {
    const result = probe(env);
    // #3624: no JSON at all means no usable export, so the probe reports unavailable
    // (stage export) instead of claiming invalid evidence it never read.
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_export_unavailable");
    assert.equal(result.auth_preflight.command_summary.stage, "export");
  });
});

test("probe route: an export of another session is rejected", () => {
  const env = setup({
    mutateExport(exported) {
      exported.info.id = "ses_zzzzzzzzzzzzzzzzzzzzzzzzzz";
    },
  });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_session_binding_mismatch");
  });
});

test("probe route: input and report bytes must match what was sent and what was printed", () => {
  const input = setup({
    mutateExport(exported) {
      exported.messages[0].text = "Reply with the single token STDIN_OK.\n";
    },
  });
  withCleanup(input, () => {
    assert.equal(probe(input).auth_preflight.command_summary.error_class, "opencode_input_binding_mismatch");
  });

  const report = setup({
    mutateExport(exported) {
      exported.messages[1].content[0].text = `${OPENCODE_PROBE_TOKEN} extra`;
    },
  });
  withCleanup(report, () => {
    assert.equal(probe(report).auth_preflight.command_summary.error_class, "opencode_report_mismatch");
  });
});

test("probe route: an unfinished assistant message is not terminal evidence", () => {
  const env = setup({
    mutateExport(exported) {
      exported.messages[1].finish = "length";
    },
  });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "blocked");
    assert.equal(result.auth_preflight.command_summary.error_class, "opencode_terminal_evidence_missing");
  });
});

test("probe route: a drifted installed version stops before any model call", () => {
  const env = setup({ version: "2.0.99\n" });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "opencode_version_drift");
    assert.equal(result.auth_preflight.classification, "reviewer_host_capability_not_checked");
    assert.ok(!env.calls.some((call) => call.argv[0] === "run" && call.argv[1] !== "--help"));
  });
});

test("probe route: a different generation than the rendered recipe is drift too", () => {
  const env = setup({ version: "1.18.31\n" });
  withCleanup(env, () => {
    assert.equal(probe(env).classification, "opencode_version_drift");
  });
});

test("probe route: root help is not proof that the export subcommand exists", () => {
  const env = setup({ exportHelp: ROOT_HELP });
  withCleanup(env, () => {
    const result = probe(env);
    assert.equal(result.status, "blocked");
    assert.equal(result.classification, "opencode_export_subcommand_unsupported");
    assert.ok(!env.calls.some((call) => call.argv[0] === "run" && call.argv[1] !== "--help"));
  });
});

test("probe route: raw run and export output is not carried into the result", () => {
  const env = setup();
  withCleanup(env, () => {
    const serialized = JSON.stringify(probe(env));
    assert.ok(!serialized.includes(OPENCODE_PROBE_TOKEN), "probe token output must stay memory-only");
    assert.ok(!serialized.includes("ses_eb5000658ffeEpZCzkI0yl09SK"), "session id must stay memory-only");
  });
});
