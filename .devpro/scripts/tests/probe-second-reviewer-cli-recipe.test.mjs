import { test } from "node:test";
import { repoPath } from "./lib/repo-root.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  evaluateProbeEvidence,
  runProbeCommand,
  runProbe,
} from "../probe-second-reviewer-cli-recipe.mjs";
import { classifyAuthSurfaceFault } from "../hooks/lib/host-auth-surface.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const claudeHelp = `
Usage: claude [options] [command] [prompt]

Options:
  -p, --print
  --effort <level>
  --verbose
  --output-format <format>
  --include-partial-messages
  --include-hook-events
  --allowedTools, --allowed-tools <tools...>
`;

const requiredInvocationArgs = [
  "-p",
  "--effort",
  "high",
  "--verbose",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--include-hook-events",
  "--allowedTools",
  `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(node ${repoPath(".devpro/scripts/read-second-review-sticky-comment.mjs")}:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
];

const context = {
  attempt_id: "second-review-pr-1612-test",
  reviewer_surface: "host-non-sandbox-required",
  runner_owner: "adapter-host-runner",
  reviewer_cli_recipe: {
    name: "codex-host-claude-packet-mode",
    tool: "claude",
    probe_script: ".devpro/scripts/probe-second-reviewer-cli-recipe.mjs",
    probe_commands: [
      { executable: "claude", argv: ["--help"] },
      { executable: "claude", argv: ["-p", "--help"] },
    ],
    required_flags: [
      "-p",
      "--effort",
      "--verbose",
      "--output-format",
      "--include-partial-messages",
      "--include-hook-events",
      "--allowedTools",
    ],
    required_invocation_args: requiredInvocationArgs,
    accepted_flag_aliases: {
      "-p": ["-p", "--print"],
      "--allowedTools": ["--allowedTools", "--allowed-tools"],
    },
    auth_preflight: {
      probe_id: "claude-auth-status-json",
      command: { executable: "claude", argv: ["auth", "status", "--json"] },
      success_condition: "json_logged_in_true",
      timeout_ms: 15000,
      max_output_bytes: 65536,
      raw_output_policy: "memory-only-do-not-persist",
    },
    true_unsupported_classification: "required_flag_absent_in_host_help",
  },
};

function fakeRun(stdout, status = 0) {
  return (command) => {
    const authPreflight = command.executable === "claude"
      && JSON.stringify(command.argv) === JSON.stringify(["auth", "status", "--json"]);
    return {
      command: command.executable,
      args: command.argv,
      status,
      signal: null,
      error: null,
      stdout: authPreflight && status === 0 ? '{"loggedIn":true}' : stdout,
      stderr: "",
    };
  };
}

test("probe classifies Claude packet-mode flags as supported from host help evidence", () => {
  const result = evaluateProbeEvidence(context, {
    runCommand: fakeRun(claudeHelp),
  });

  assert.equal(result.classification, "flags_supported");
  assert.deepEqual(result.missing_required_flags, []);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.reviewer_cli_recipe.required_invocation_args, requiredInvocationArgs);
  assert.ok(result.command_summaries.every((summary) => summary.stdout_bytes > 0));
  assert.ok(result.command_summaries.every((summary) => summary.output_sha256.length === 64));
  assert.equal(result.auth_preflight.classification, "reviewer_host_capability_verified");
  assert.equal(result.auth_preflight.command_summary.probe_id, "claude-auth-status-json");
  assert.equal("output_sha256" in result.auth_preflight.command_summary, false);
});

test("auth preflight fails closed without persisting restricted-HOME identity evidence", () => {
  const sensitive = "user@example.test org-secret account-42 token-secret /restricted/home/user";
  const commands = [];
  const result = evaluateProbeEvidence(context, {
    runCommand(command) {
      commands.push(command);
      if (command.argv[0] === "auth") {
        return {
          command: "claude",
          args: ["auth", "status", "--json"],
          status: 1,
          signal: null,
          error: null,
          stdout: "",
          stderr: `Not logged in: ${sensitive}`,
        };
      }
      return fakeRun(claudeHelp)(command);
    },
  });

  assert.deepEqual(commands, [
    { executable: "claude", argv: ["--help"] },
    { executable: "claude", argv: ["-p", "--help"] },
    { executable: "claude", argv: ["auth", "status", "--json"] },
  ]);
  assert.equal(result.classification, "reviewer_host_surface_unverified");
  assert.equal(result.status, "blocked");
  assert.equal(result.auth_preflight.classification, "reviewer_host_surface_unverified");
  assert.equal(result.auth_preflight.surface_classification, "sandbox-surface-fault");
  assert.equal(result.auth_preflight.requires_host_rerun, true);
  assert.equal(result.auth_preflight.may_fallback, false);
  assert.equal(result.auth_preflight.command_summary.stderr_bytes > 0, true);
  assert.equal("output_sha256" in result.auth_preflight.command_summary, false);
  const persisted = JSON.stringify(result);
  assert.equal(persisted.includes(sensitive), false);
  assert.equal(persisted.includes("user@example.test"), false);
  assert.equal(persisted.includes("/restricted/home/user"), false);
  assert.equal(
    persisted.includes(createHash("sha256").update(`\nNot logged in: ${sensitive}`).digest("hex")),
    false
  );
});

test("auth preflight classifies error-code-only EPERM without persisting classifier evidence", () => {
  const result = evaluateProbeEvidence(context, {
    runCommand(command) {
      if (command.argv[0] === "auth") {
        return {
          command: "claude",
          args: ["auth", "status", "--json"],
          status: null,
          signal: null,
          error: "sensitive runtime detail",
          error_code: "EPERM",
          stdout: "",
          stderr: "",
        };
      }
      return fakeRun(claudeHelp)(command);
    },
  });

  assert.equal(result.classification, "reviewer_host_surface_unverified");
  assert.equal(result.auth_preflight.classification, "reviewer_host_surface_unverified");
  assert.equal(result.auth_preflight.surface_classification, "sandbox-surface-fault");
  assert.equal(result.auth_preflight.requires_host_rerun, true);
  assert.equal(result.auth_preflight.may_fallback, false);
  assert.equal(result.auth_preflight.command_summary.error_class, "spawn_failed");
  const persisted = JSON.stringify(result);
  assert.equal(persisted.includes("sensitive runtime detail"), false);
  assert.equal(persisted.includes("reason"), false);
  assert.equal(persisted.includes("EPERM"), false);
});

test("auth preflight treats signal-only null-status termination as an unknown-surface fault", () => {
  const result = evaluateProbeEvidence(context, {
    runCommand(command) {
      if (command.argv[0] === "auth") {
        return {
          command: "claude",
          args: ["auth", "status", "--json"],
          status: null,
          signal: "SIGKILL",
          error: null,
          error_code: null,
          stdout: "",
          stderr: "",
        };
      }
      return fakeRun(claudeHelp)(command);
    },
  });

  assert.equal(result.classification, "reviewer_host_surface_unverified");
  assert.equal(result.auth_preflight.surface_classification, "sandbox-surface-fault");
  assert.equal(result.auth_preflight.requires_host_rerun, true);
  assert.equal(result.auth_preflight.may_fallback, false);
  assert.equal(result.auth_preflight.command_summary.signal, "SIGKILL");
});

test("auth preflight keeps apiKeySource:none neutral inside shared surface diagnostics", () => {
  const result = evaluateProbeEvidence(context, {
    runCommand(command) {
      if (command.argv[0] === "auth") {
        return {
          command: "claude",
          args: ["auth", "status", "--json"],
          status: 0,
          signal: null,
          error: null,
          stdout: '{"loggedIn":true,"apiKeySource":"none"}',
          stderr: "",
        };
      }
      return fakeRun(claudeHelp)(command);
    },
  });

  assert.equal(result.classification, "flags_supported");
  assert.equal(result.auth_preflight.classification, "reviewer_host_capability_verified");
  assert.equal(result.auth_preflight.surface_classification, "ok");
  assert.equal(result.auth_preflight.requires_host_rerun, false);
  assert.equal(result.auth_preflight.may_fallback, false);
  assert.equal(JSON.stringify(result).includes("apiKeySource"), false);
});

test("auth preflight does not accept logged-out, malformed, or forged host-keyword output", () => {
  for (const stdout of [
    '{"loggedIn":false}',
    "not-json",
    '{"loggedIn":false,"surface":"host","marker":"require_escalated host-rerun"}',
  ]) {
    const result = evaluateProbeEvidence(context, {
      runCommand(command) {
        if (command.argv[0] === "auth") {
          return {
            command: "claude",
            args: ["auth", "status", "--json"],
            status: 0,
            signal: null,
            error: null,
            stdout,
            stderr: "",
          };
        }
        return fakeRun(claudeHelp)(command);
      },
    });
    assert.equal(result.classification, "reviewer_host_surface_unverified", stdout);
    assert.equal(result.auth_preflight.classification, "reviewer_host_surface_unverified", stdout);
  }
});

test("quota precondition: only reviewer_host_capability_verified is auth success, never a surface ok/host-fault", () => {
  const authRun = (auth) => (command) => (command.argv[0] === "auth"
    ? { command: "claude", args: ["auth", "status", "--json"], signal: null, error: null, stderr: "", ...auth }
    : fakeRun(claudeHelp)(command));

  // Logged out with exit 0: the surface classifier sees no fault (`ok`), yet
  // authentication is not verified. This divergence is why the quota rule
  // must not read a surface result as auth success.
  const loggedOut = evaluateProbeEvidence(context, { runCommand: authRun({ status: 0, stdout: '{"loggedIn":false}' }) });
  assert.equal(loggedOut.auth_preflight.surface_classification, "ok");
  assert.equal(loggedOut.auth_preflight.classification, "reviewer_host_surface_unverified");

  // Missing exit status with no output: the bare classifier returns `ok`, the
  // probe still refuses to call it verified.
  assert.equal(classifyAuthSurfaceFault(null, "").classification, "ok");
  const noStatus = evaluateProbeEvidence(context, { runCommand: authRun({ status: null, stdout: "" }) });
  assert.equal(noStatus.auth_preflight.classification, "reviewer_host_surface_unverified");

  // A real logout re-run on the host is a `host-fault`, not an authenticated family.
  assert.equal(classifyAuthSurfaceFault(1, "Not logged in", { surface: "host" }).classification, "host-fault");

  // Positive control: exit 0 plus the recipe's success predicate is the only verified shape.
  const loggedIn = evaluateProbeEvidence(context, { runCommand: authRun({ status: 0, stdout: '{"loggedIn":true}' }) });
  assert.equal(loggedIn.auth_preflight.classification, "reviewer_host_capability_verified");
});

test("auth preflight fails closed on timeout and bounded-output overflow without retaining output", () => {
  for (const fault of [
    { error_code: "ETIMEDOUT", stdout: "", timed_out: true, output_overflowed: false },
    { error_code: "ENOBUFS", stdout: "x".repeat(65537), timed_out: false, output_overflowed: true },
  ]) {
    const result = evaluateProbeEvidence(context, {
      runCommand(command) {
        if (command.argv[0] === "auth") {
          return {
            command: "claude",
            args: ["auth", "status", "--json"],
            status: null,
            signal: "SIGTERM",
            error: "sensitive host path must not persist",
            error_code: fault.error_code,
            stdout: fault.stdout,
            stderr: "secret@example.test /restricted/home/user",
          };
        }
        return fakeRun(claudeHelp)(command);
      },
    });

    assert.equal(result.classification, "reviewer_host_surface_unverified");
    assert.equal(result.auth_preflight.command_summary.timed_out, fault.timed_out);
    assert.equal(result.auth_preflight.command_summary.output_overflowed, fault.output_overflowed);
    assert.equal(result.auth_preflight.command_summary.error_class, fault.output_overflowed ? "output_limit" : "timeout");
    const persisted = JSON.stringify(result);
    assert.equal(persisted.includes("secret@example.test"), false);
    assert.equal(persisted.includes("/restricted/home/user"), false);
    assert.equal(persisted.includes("sensitive host path"), false);
  }
});

test("runProbeCommand preserves exact argv when a help script path contains spaces", () => {
  const dir = makeTempDir("second reviewer cli help ");
  const captureRoot = path.join(dir, "capture");
  const toolPath = path.join(dir, "fake-help.mjs");
  const oldShell = process.env.SHELL;
  try {
    writeFileSync(toolPath, `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n" + "x".repeat(9000) + "\\n--verbose\\n");\n`, "utf8");
    process.env.SHELL = path.join(dir, "shell-must-not-run");

    const result = runProbeCommand({
      executable: process.execPath,
      argv: [toolPath, "--help", "literal arg with spaces", "$(not-executed);*"],
    }, {
      timeoutMs: 5000,
      captureRoot,
    });
    assert.equal(result.status, 0);
    assert.equal(result.error, null);
    assert.ok(result.stdout.length > 8192);
    assert.ok(result.stdout.includes("--verbose"));
    assert.ok(result.stdout.startsWith('["--help","literal arg with spaces","$(not-executed);*"]'));
    assert.deepEqual(readdirSync(captureRoot), [], "transient help capture must be removed");
  } finally {
    process.env.SHELL = oldShell;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbeCommand uses transient direct-argv capture for version probes", () => {
  const dir = makeTempDir("second-review-cli-version-");
  const captureRoot = path.join(dir, "capture");
  const toolPath = path.join(dir, "fake-version.mjs");
  try {
    writeFileSync(toolPath, "process.stdout.write('2.1.220\\n');\n", "utf8");
    const result = runProbeCommand({ executable: process.execPath, argv: [toolPath, "--version"] }, {
      captureRoot,
      env: { ...process.env, SHELL: path.join(dir, "missing-shell") },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "2.1.220\n");
    assert.deepEqual(readdirSync(captureRoot), [], "transient version capture must be removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbeCommand bounds and cleans transient help capture on overflow and spawn failure", () => {
  const dir = makeTempDir("second-review-cli-help-fault-");
  const captureRoot = path.join(dir, "capture");
  const toolPath = path.join(dir, "overflow.mjs");
  try {
    writeFileSync(toolPath, `process.stdout.write("x".repeat(1025));\n`, "utf8");
    const overflow = runProbeCommand({ executable: process.execPath, argv: [toolPath, "--help"] }, {
      maxBufferBytes: 1024,
      captureRoot,
    });
    assert.equal(overflow.error_code, "ENOBUFS");
    assert.deepEqual(readdirSync(captureRoot), []);

    const missing = runProbeCommand({
      executable: path.join(dir, "missing cli"),
      argv: ["--help"],
    }, { captureRoot });
    assert.notEqual(missing.error, null);
    assert.equal(missing.error_code, "ENOENT");
    assert.deepEqual(readdirSync(captureRoot), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbeCommand cleans transient captures after non-zero, timeout, and deterministic read failure", () => {
  const dir = makeTempDir("second-review-cli-help-exits-");
  const captureRoot = path.join(dir, "capture");
  const nonZeroPath = path.join(dir, "non-zero.mjs");
  const timeoutPath = path.join(dir, "timeout.mjs");
  const successPath = path.join(dir, "success.mjs");
  try {
    writeFileSync(nonZeroPath, "process.stderr.write('expected failure\\n'); process.exit(7);\n", "utf8");
    writeFileSync(timeoutPath, "setInterval(() => {}, 1000);\n", "utf8");
    writeFileSync(successPath, "process.stdout.write('help output\\n');\n", "utf8");

    const nonZero = runProbeCommand(
      { executable: process.execPath, argv: [nonZeroPath, "--help"] },
      { captureRoot }
    );
    assert.equal(nonZero.status, 7);
    assert.equal(nonZero.error, null);
    assert.equal(nonZero.stderr, "expected failure\n");
    assert.deepEqual(readdirSync(captureRoot), []);

    const timedOut = runProbeCommand(
      { executable: process.execPath, argv: [timeoutPath, "--help"] },
      { captureRoot, timeoutMs: 25 }
    );
    assert.equal(timedOut.status, null);
    assert.equal(timedOut.error_code, "ETIMEDOUT");
    assert.deepEqual(readdirSync(captureRoot), []);

    const readFailed = runProbeCommand(
      { executable: process.execPath, argv: [successPath, "--help"] },
      {
        captureRoot,
        readCapture() {
          const error = new Error("deterministic capture read failure");
          error.code = "EIO";
          throw error;
        },
      }
    );
    assert.equal(readFailed.status, null);
    assert.equal(readFailed.error, "probe capture failed");
    assert.equal(readFailed.error_code, "EIO");
    assert.deepEqual(readdirSync(captureRoot), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe accepts the kebab-case allowed-tools alias without false negative", () => {
  const aliasOnlyHelp = claudeHelp.replace("--allowedTools, ", "");
  const result = evaluateProbeEvidence(context, {
    runCommand: fakeRun(aliasOnlyHelp),
  });

  assert.equal(result.classification, "flags_supported");
  assert.deepEqual(result.missing_required_flags, []);
});

test("probe reports true unsupported only when host help lacks a required flag", () => {
  const missingEffortHelp = claudeHelp.replace("  --effort <level>\n", "");
  const result = evaluateProbeEvidence(context, {
    runCommand: fakeRun(missingEffortHelp),
  });

  assert.equal(result.classification, "required_flag_absent_in_host_help");
  assert.deepEqual(result.missing_required_flags, ["--effort"]);
});

test("probe reports unsupported when host help lacks stream-json verbose requirement", () => {
  const missingVerboseHelp = claudeHelp.replace("  --verbose\n", "");
  const result = evaluateProbeEvidence(context, {
    runCommand: fakeRun(missingVerboseHelp),
  });

  assert.equal(result.classification, "required_flag_absent_in_host_help");
  assert.deepEqual(result.missing_required_flags, ["--verbose"]);
});

test("probe treats exact 8KB help output with missing flags as suspect capture", () => {
  const result = evaluateProbeEvidence(context, {
    runCommand: fakeRun("x".repeat(8192)),
  });

  assert.equal(result.classification, "probe_capture_suspect");
  assert.equal(result.status, "blocked");
  assert.ok(result.missing_required_flags.includes("--verbose"));
});

test("probe rejects invocation flags that are not listed in required_flags", () => {
  const malformedContext = structuredClone(context);
  malformedContext.reviewer_cli_recipe.required_flags =
    malformedContext.reviewer_cli_recipe.required_flags.filter((flag) => flag !== "--verbose");

  assert.throws(
    () => evaluateProbeEvidence(malformedContext, { runCommand: fakeRun(claudeHelp) }),
    /required_invocation_args flags must be listed in required_flags: --verbose/
  );
});

test("probe keeps unavailable probe evidence separate from unsupported flags", () => {
  const result = evaluateProbeEvidence(context, {
    runCommand: fakeRun("", 127),
  });

  assert.equal(result.classification, "probe_evidence_unavailable");
  assert.deepEqual(
    result.missing_required_flags,
    context.reviewer_cli_recipe.required_flags
  );
});

test("runProbe writes bounded result, activity events, and heartbeat", () => {
  const dir = makeTempDir("second-review-probe-");
  try {
    const probeContext = {
      ...context,
      activity_log_path: path.join(dir, "projection-activity.ndjson"),
      heartbeat_path: path.join(dir, "heartbeat.json"),
      cli_probe_result_path: path.join(dir, "cli-probe-result.json"),
    };
    const result = runProbe(probeContext, {
      runCommand: fakeRun(claudeHelp),
    });

    assert.equal(result.classification, "flags_supported");
    const activity = readFileSync(probeContext.activity_log_path, "utf8");
    assert.match(activity, /projection_cli_probe_started/);
    assert.match(activity, /projection_cli_probe_result/);
    const probeResult = JSON.parse(readFileSync(probeContext.cli_probe_result_path, "utf8"));
    assert.equal(probeResult.classification, "flags_supported");
    assert.equal(probeResult.command_summaries[0].stdout_bytes > 0, true);
    assert.equal("stdout" in probeResult.command_summaries[0], false);
    assert.deepEqual(
      Object.keys(probeResult.auth_preflight).sort(),
      [
        "classification",
        "command_summary",
        "may_fallback",
        "requires_host_rerun",
        "surface_classification",
      ]
    );
    assert.deepEqual(
      Object.keys(probeResult.auth_preflight.command_summary).sort(),
      [
        "error_class",
        "output_overflowed",
        "probe_id",
        "signal",
        "status",
        "stderr_bytes",
        "stdout_bytes",
        "timed_out",
      ]
    );
    const persisted = JSON.stringify(probeResult.auth_preflight);
    for (const forbidden of [
      "error_code", "reason", "stdout\"", "stderr\"", "excerpt", "hash",
      "identity", "token", "path",
    ]) {
      assert.equal(persisted.includes(forbidden), false, `must not persist ${forbidden}`);
    }
    const heartbeat = JSON.parse(readFileSync(probeContext.heartbeat_path, "utf8"));
    assert.equal(heartbeat.status, "cli_probe:flags_supported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
