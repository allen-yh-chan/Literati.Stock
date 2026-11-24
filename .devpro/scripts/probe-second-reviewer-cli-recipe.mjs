#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAuthSurfaceFault } from "./hooks/lib/host-auth-surface.mjs";
import { materializeOpenCodeLaunchConfig } from "./lib/opencode-launch.mjs";
import {
  OPENCODE_PROBE_TOKEN,
  OpenCodeReviewerError,
  dispatchedSessionIdFromEvents,
  evaluateOpenCodeProbeRun,
  evaluateOpenCodeSessionExport,
  openCodeExportArgv,
  openCodeReviewerEnv,
  parseOpenCodeRunEvents,
  parseOpenCodeVersion,
  verifyOpenCodeExportHelp,
} from "./lib/opencode-reviewer.mjs";
import { assertOpenCodeReviewerContext } from "./second-reviewer-cli-recipe-contract.mjs";
import { escapeRegExp, nowIso, sha256Hex } from "./lib/primitives.mjs";
import { createActivityAppender, writeJson } from "./lib/projection-io.mjs";
import { sanitizeCmuxDispatchEnv } from "./lib/second-review-env-sanitizer.mjs";

const probeScript = ".devpro/scripts/probe-second-reviewer-cli-recipe.mjs";
const appendActivity = createActivityAppender({
  scriptField: "probe_script",
  scriptValue: probeScript,
});
const defaultAcceptedFlagAliases = {
  "-p": ["-p", "--print"],
  "--allowedTools": ["--allowedTools", "--allowed-tools"],
};
const OPENCODE_AUTH_SUCCESS_CONDITION = "opencode_token_session_export";
const supportedAuthSuccessConditions = new Set([
  "exit_zero",
  "json_logged_in_true",
  OPENCODE_AUTH_SUCCESS_CONDITION,
]);
const authRawOutputPolicy = "memory-only-do-not-persist";

class ProbeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeConfigError";
    this.classification = "probe_malformed";
  }
}

function hasFlagToken(text, flag) {
  const pattern = new RegExp(`(^|[\\s,])${escapeRegExp(flag)}(?=$|[\\s,=<])`);
  return pattern.test(text);
}

function normalizeCommandCarrier(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProbeConfigError(`${fieldName} must be a typed { executable, argv } object`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "argv" || keys[1] !== "executable") {
    throw new ProbeConfigError(`${fieldName} must contain only executable and argv`);
  }
  if (typeof value.executable !== "string" || value.executable.trim() === "") {
    throw new ProbeConfigError(`${fieldName}.executable must be a non-empty string`);
  }
  if (!Array.isArray(value.argv) || !value.argv.every((arg) => typeof arg === "string")) {
    throw new ProbeConfigError(`${fieldName}.argv must be an array of strings`);
  }
  return { executable: value.executable, argv: [...value.argv] };
}

function normalizeRecipe(recipe) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new ProbeConfigError("reviewer_cli_recipe is required");
  }
  if (!Array.isArray(recipe.required_flags) || recipe.required_flags.length === 0) {
    throw new ProbeConfigError("reviewer_cli_recipe.required_flags must be a non-empty array");
  }
  if (!Array.isArray(recipe.required_invocation_args) || recipe.required_invocation_args.length === 0) {
    throw new ProbeConfigError("reviewer_cli_recipe.required_invocation_args must be a non-empty array");
  }
  if (!Array.isArray(recipe.probe_commands) || recipe.probe_commands.length === 0) {
    throw new ProbeConfigError("reviewer_cli_recipe.probe_commands must be a non-empty array");
  }
  const authPreflight = recipe.auth_preflight;
  if (!authPreflight || typeof authPreflight !== "object" || Array.isArray(authPreflight)) {
    throw new ProbeConfigError("reviewer_cli_recipe.auth_preflight is required");
  }
  if (typeof authPreflight.probe_id !== "string" || authPreflight.probe_id.trim() === "") {
    throw new ProbeConfigError("reviewer_cli_recipe.auth_preflight.probe_id must be a non-empty string");
  }
  const authCommand = normalizeCommandCarrier(
    authPreflight.command,
    "reviewer_cli_recipe.auth_preflight.command"
  );
  if (!supportedAuthSuccessConditions.has(authPreflight.success_condition)) {
    throw new ProbeConfigError("reviewer_cli_recipe.auth_preflight.success_condition is unsupported");
  }
  if (!Number.isInteger(authPreflight.timeout_ms) || authPreflight.timeout_ms <= 0) {
    throw new ProbeConfigError("reviewer_cli_recipe.auth_preflight.timeout_ms must be a positive integer");
  }
  if (!Number.isInteger(authPreflight.max_output_bytes) || authPreflight.max_output_bytes <= 0) {
    throw new ProbeConfigError("reviewer_cli_recipe.auth_preflight.max_output_bytes must be a positive integer");
  }
  if (authPreflight.raw_output_policy !== authRawOutputPolicy) {
    throw new ProbeConfigError(
      `reviewer_cli_recipe.auth_preflight.raw_output_policy must be ${authRawOutputPolicy}`
    );
  }
  const requiredFlags = recipe.required_flags.map(String);
  const requiredInvocationArgs = recipe.required_invocation_args.map(String);
  const invocationFlags = requiredInvocationArgs.filter((arg) => /^-{1,2}[A-Za-z0-9]/.test(arg));
  const unlistedInvocationFlags = invocationFlags.filter((flag) => !requiredFlags.includes(flag));
  if (unlistedInvocationFlags.length > 0) {
    throw new ProbeConfigError(
      `reviewer_cli_recipe.required_invocation_args flags must be listed in required_flags: ${unlistedInvocationFlags.join(", ")}`
    );
  }
  return {
    name: recipe.name ?? "second-reviewer-cli-recipe",
    tool: recipe.tool ?? "unknown",
    probe_script: recipe.probe_script ?? probeScript,
    true_unsupported_classification:
      recipe.true_unsupported_classification ?? "required_flag_absent_in_host_help",
    accepted_flag_aliases: {
      ...defaultAcceptedFlagAliases,
      ...(recipe.accepted_flag_aliases ?? {}),
    },
    required_flags: requiredFlags,
    required_invocation_args: requiredInvocationArgs,
    probe_commands: recipe.probe_commands.map((command, index) => normalizeCommandCarrier(
      command,
      `reviewer_cli_recipe.probe_commands[${index}]`
    )),
    auth_preflight: {
      probe_id: authPreflight.probe_id,
      command: authCommand,
      success_condition: authPreflight.success_condition,
      timeout_ms: authPreflight.timeout_ms,
      max_output_bytes: authPreflight.max_output_bytes,
      raw_output_policy: authPreflight.raw_output_policy,
    },
  };
}

function isHelpProbeArgs(args) {
  return args.some((arg) => ["--help", "-help", "-h", "help"].includes(arg));
}

function isVersionProbeArgs(args) {
  return args.some((arg) => ["--version", "-version", "-V", "version"].includes(arg));
}

function usesTransientCapture(args) {
  return isHelpProbeArgs(args) || isVersionProbeArgs(args);
}

function readBoundedCapture(filePath, maxBytes) {
  const size = statSync(filePath).size;
  const bytesToRead = Math.min(size, maxBytes + 1);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    let offset = 0;
    while (offset < bytesToRead) {
      const count = readSync(fd, buffer, offset, bytesToRead - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return { text: buffer.subarray(0, offset).toString("utf8"), overflowed: size > maxBytes };
  } finally {
    closeSync(fd);
  }
}

function runTransientProbeCommand(command, args, options) {
  const captureRoot = path.resolve(options.captureRoot ?? tmpdir());
  let captureDir;
  let stdoutFd;
  let stderrFd;
  let primaryError;
  let response;
  try {
    mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
    captureDir = mkdtempSync(path.join(captureRoot, "devpro-second-review-probe-"));
    chmodSync(captureDir, 0o700);
    const stdoutPath = path.join(captureDir, "stdout.capture");
    const stderrPath = path.join(captureDir, "stderr.capture");
    stdoutFd = openSync(stdoutPath, "w", 0o600);
    stderrFd = openSync(stderrPath, "w", 0o600);
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", stdoutFd, stderrFd],
      timeout: options.timeout,
    });
    const completedStdoutFd = stdoutFd;
    stdoutFd = undefined;
    closeSync(completedStdoutFd);
    const completedStderrFd = stderrFd;
    stderrFd = undefined;
    closeSync(completedStderrFd);
    const readCapture = options.readCapture ?? readBoundedCapture;
    const stdout = readCapture(stdoutPath, options.maxBuffer);
    const stderr = readCapture(stderrPath, options.maxBuffer);
    const overflowed = stdout.overflowed || stderr.overflowed;
    response = {
      command,
      args,
      status: overflowed ? null : result.status,
      signal: result.signal ?? null,
      error: overflowed ? "probe output exceeded capture limit" : (result.error?.message ?? null),
      error_code: overflowed ? "ENOBUFS" : (result.error?.code ?? null),
      stdout: stdout.text,
      stderr: stderr.text,
    };
  } catch (error) {
    primaryError = error;
    response = {
      command,
      args,
      status: null,
      signal: null,
      error: "probe capture failed",
      error_code: error?.code ?? "CAPTURE_FAILED",
      stdout: "",
      stderr: "",
    };
  } finally {
    const cleanupErrors = [];
    for (const fd of [stdoutFd, stderrFd]) {
      if (fd === undefined) continue;
      try {
        closeSync(fd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (captureDir) {
      try {
        rmSync(captureDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      response = {
        command,
        args,
        status: null,
        signal: null,
        error: primaryError
          ? "probe capture and cleanup failed"
          : "probe cleanup failed",
        error_code: primaryError?.code ?? "CAPTURE_CLEANUP_FAILED",
        stdout: "",
        stderr: "",
      };
    }
  }
  return response;
}

function hasSuspiciousTruncatedHelp(commandResults) {
  return commandResults.some((result) => {
    const stdoutBytes = Buffer.byteLength(result.stdout ?? "", "utf8");
    return result.status === 0 && isHelpProbeArgs(result.args ?? []) && stdoutBytes === 8192;
  });
}

function summarizeCommandResult(result) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  return {
    command: [result.command, ...(result.args ?? [])].join(" "),
    status: result.status,
    signal: result.signal ?? null,
    error: result.error ?? null,
    stdout_bytes: Buffer.byteLength(stdout, "utf8"),
    stderr_bytes: Buffer.byteLength(stderr, "utf8"),
    output_sha256: sha256Hex(combined ?? ""),
  };
}

function authErrorClass(result, outputOverflowed) {
  if (outputOverflowed || result.error_code === "ENOBUFS") return "output_limit";
  if (result.error_code === "ETIMEDOUT") return "timeout";
  if (result.error_code || result.error) return "spawn_failed";
  if (result.status !== 0) return "command_failed";
  return null;
}

function allowlistedProcessErrorCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(value)
    ? value
    : "";
}

function evaluateAuthPreflight(recipe, result) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stdoutBytes = Buffer.byteLength(stdout, "utf8");
  const stderrBytes = Buffer.byteLength(stderr, "utf8");
  const outputOverflowed = result.error_code === "ENOBUFS"
    || stdoutBytes > recipe.max_output_bytes
    || stderrBytes > recipe.max_output_bytes
    || stdoutBytes + stderrBytes > recipe.max_output_bytes;
  const timedOut = result.error_code === "ETIMEDOUT";
  let verified = result.status === 0 && !result.error && !timedOut && !outputOverflowed;
  let errorClass = authErrorClass(result, outputOverflowed);

  if (verified && recipe.success_condition === "json_logged_in_true") {
    try {
      const parsed = JSON.parse(stdout);
      verified = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.loggedIn === true);
      if (!verified) errorClass = "capability_not_confirmed";
    } catch {
      verified = false;
      errorClass = "response_invalid";
    }
  }

  const errorCode = allowlistedProcessErrorCode(result.error_code);
  const hasNonSuccessSentinel = result.status !== 0 || Boolean(result.signal);
  const hasProcessFault = Boolean(
    errorCode
    || result.error
    || timedOut
    || outputOverflowed
    || hasNonSuccessSentinel
  );
  const classifierStatus = hasProcessFault
    ? (Number.isInteger(result.status) && result.status !== 0 ? result.status : 1)
    : 0;
  const classifierInput = [errorCode, stdout, stderr]
    .filter(Boolean)
    .join("\n")
    .slice(0, recipe.max_output_bytes);
  const surfaceVerdict = classifyAuthSurfaceFault(
    classifierStatus,
    classifierInput,
    { surface: "unknown" }
  );

  return {
    classification: verified
      ? "reviewer_host_capability_verified"
      : "reviewer_host_surface_unverified",
    surface_classification: surfaceVerdict.classification,
    requires_host_rerun: surfaceVerdict.requiresHostRerun,
    may_fallback: surfaceVerdict.mayFallback,
    command_summary: {
      probe_id: recipe.probe_id,
      status: result.status,
      signal: result.signal ?? null,
      error_class: verified ? null : (errorClass ?? "capability_not_confirmed"),
      timed_out: timedOut,
      output_overflowed: outputOverflowed,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
    },
  };
}

export function runProbeCommand(commandCarrier, options = {}) {
  let carrier;
  try {
    carrier = normalizeCommandCarrier(commandCarrier, "probe command");
  } catch (error) {
    return {
      command: "",
      args: [],
      status: null,
      signal: null,
      error: error.message,
      error_code: "MALFORMED_COMMAND",
      stdout: "",
      stderr: "",
    };
  }
  const command = carrier.executable;
  const args = carrier.argv;
  const timeout = options.timeoutMs ?? 15000;
  const maxBuffer = options.maxBufferBytes ?? 1024 * 1024;
  if (usesTransientCapture(args)) {
    return runTransientProbeCommand(command, args, { ...options, timeout, maxBuffer });
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer,
    timeout,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    error_code: result.error?.code ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// OpenCode capability precheck (runs only after the generic help-flag matrix passed). The
// recipe was rendered for one installed generation; a different installed version means the
// rendered argv no longer describes this host, and root help with exit 0 is not proof that
// the export subcommand exists.
function openCodeCapabilityPrecheck(oc, commandResults) {
  let installed;
  try {
    installed = parseOpenCodeVersion(commandResults[0]?.stdout);
  } catch {
    return "opencode_version_drift";
  }
  if (installed.version !== oc.cli_version || installed.generation !== oc.generation) {
    return "opencode_version_drift";
  }
  const exportHelp = `${commandResults[2]?.stdout ?? ""}\n${commandResults[2]?.stderr ?? ""}`;
  if (!verifyOpenCodeExportHelp(oc.generation, exportHelp)) {
    return "opencode_export_subcommand_unsupported";
  }
  return null;
}

function openCodeAuthResult({ verified, errorClass, stage, runResult, totalStdout, totalStderr, classifierText }) {
  const status = runResult?.status ?? null;
  const hasFault = !verified;
  const classifierStatus = hasFault ? (Number.isInteger(status) && status !== 0 ? status : 1) : 0;
  const surfaceVerdict = classifyAuthSurfaceFault(
    classifierStatus,
    String(classifierText ?? "").slice(0, 262144),
    { surface: "unknown" }
  );
  return {
    classification: verified ? "reviewer_host_capability_verified" : "reviewer_host_surface_unverified",
    surface_classification: surfaceVerdict.classification,
    requires_host_rerun: surfaceVerdict.requiresHostRerun,
    may_fallback: surfaceVerdict.mayFallback,
    command_summary: {
      probe_id: "opencode-token-session-export",
      stage,
      status,
      signal: runResult?.signal ?? null,
      error_class: verified ? null : errorClass,
      timed_out: runResult?.error_code === "ETIMEDOUT",
      output_overflowed: runResult?.error_code === "ENOBUFS",
      stdout_bytes: totalStdout,
      stderr_bytes: totalStderr,
    },
  };
}

// Plan r5 §3 probe order: (1) one isolated no-tool run that must echo the fixed token
// (liveness/auth only); (2) export THAT session; (3) validate exact providerID/modelID,
// terminal completion and input/report binding; only then is the route usable. The probe
// runs in a throwaway cwd with project config disabled, so the candidate tree cannot
// influence it, and raw output is dropped (memory-only-do-not-persist).
function evaluateOpenCodeAuthPreflight(context, recipe, runCommand, options) {
  const oc = assertOpenCodeReviewerContext(context);
  const startedAt = Date.now();
  let probeCwd;
  let totalStdout = 0;
  let totalStderr = 0;
  let lastResult = null;
  const fail = (errorClass, stage, classifierText) => openCodeAuthResult({
    verified: false, errorClass, stage, runResult: lastResult, totalStdout, totalStderr, classifierText,
  });
  try {
    materializeOpenCodeLaunchConfig(context, options.openCodeLaunch ?? {});
    probeCwd = mkdtempSync(path.join(options.probeCwdRoot ?? tmpdir(), "devpro-opencode-probe-"));
    const env = openCodeReviewerEnv({
      baseEnv: options.env ?? process.env,
      launchConfigPath: oc.launch_config_path,
      cwd: probeCwd,
    });
    const prompt = `Reply with exactly the single token ${OPENCODE_PROBE_TOKEN} and nothing else. Do not use any tools.\n`;
    const run = runCommand(recipe.command, {
      purpose: "auth_preflight",
      timeoutMs: recipe.timeout_ms,
      maxBufferBytes: recipe.max_output_bytes,
      cwd: probeCwd,
      env,
      input: prompt,
    });
    lastResult = run;
    totalStdout += Buffer.byteLength(run.stdout ?? "", "utf8");
    totalStderr += Buffer.byteLength(run.stderr ?? "", "utf8");
    const errorClassOfRun = authErrorClass(run, totalStdout + totalStderr > recipe.max_output_bytes);
    if (errorClassOfRun) return fail(errorClassOfRun, "run", `${run.error_code ?? ""}\n${run.stdout ?? ""}\n${run.stderr ?? ""}`);
    const parsed = parseOpenCodeRunEvents(run.stdout);
    const runVerdict = evaluateOpenCodeProbeRun({ exitCode: run.status, parsedEvents: parsed });
    const eventErrors = parsed.errors.map((entry) => `${entry.type} ${entry.message}`).join("\n");
    if (!runVerdict.ok) return fail(runVerdict.classification, "run", `${eventErrors}\n${run.stderr ?? ""}`);
    const sessionId = dispatchedSessionIdFromEvents(parsed);
    const remaining = Math.max(5000, recipe.timeout_ms - (Date.now() - startedAt));
    const exported = runCommand(
      { executable: recipe.command.executable, argv: openCodeExportArgv(oc.generation, sessionId) },
      {
        purpose: "auth_preflight",
        timeoutMs: remaining,
        maxBufferBytes: recipe.max_output_bytes,
        cwd: probeCwd,
        env,
      }
    );
    lastResult = exported;
    totalStdout += Buffer.byteLength(exported.stdout ?? "", "utf8");
    totalStderr += Buffer.byteLength(exported.stderr ?? "", "utf8");
    const errorClassOfExport = authErrorClass(exported, totalStdout + totalStderr > recipe.max_output_bytes);
    if (errorClassOfExport) return fail(errorClassOfExport, "export", `${exported.error_code ?? ""}\n${exported.stderr ?? ""}`);
    const evidence = evaluateOpenCodeSessionExport({
      exportText: exported.stdout,
      generation: oc.generation,
      dispatchedSessionId: sessionId,
      selection: oc.selection,
      inputBytes: Buffer.from(prompt, "utf8"),
      runFinalText: parsed.final_text,
    });
    if (!evidence.ok) {
      // #3624: both "no usable export" and "export JSON is not the session schema" are
      // export-stage failures; "validate" is for an export that was read and judged.
      const exportStage = ["opencode_export_malformed", "opencode_export_unavailable"].includes(evidence.classification);
      return fail(evidence.classification, exportStage ? "export" : "validate", "");
    }
    return openCodeAuthResult({
      verified: true, errorClass: null, stage: "validate", runResult: exported, totalStdout, totalStderr, classifierText: "",
    });
  } catch (error) {
    if (error instanceof OpenCodeReviewerError) return fail(error.classification, "prepare", "");
    return fail("spawn_failed", "prepare", String(error?.code ?? ""));
  } finally {
    if (probeCwd) rmSync(probeCwd, { recursive: true, force: true });
  }
}

export function evaluateProbeEvidence(context, options = {}) {
  const recipe = normalizeRecipe(context?.reviewer_cli_recipe);
  const runCommand = options.runCommand
    ?? ((command, commandOptions = {}) => runProbeCommand(command, { ...options, ...commandOptions }));
  const commandResults = recipe.probe_commands.map((command) => runCommand(command, {
    purpose: "help_probe",
  }));
  const combinedText = commandResults.map((result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`).join("\n");
  const unavailable = commandResults.filter((result) => result.status !== 0);
  const flagMatrix = recipe.required_flags.map((flag) => {
    const aliases = recipe.accepted_flag_aliases[flag] ?? [flag];
    const matchedAliases = aliases.filter((alias) => hasFlagToken(combinedText, alias));
    const rawAliasMentions = aliases.filter((alias) => combinedText.includes(alias));
    return {
      flag,
      aliases,
      supported: matchedAliases.length > 0,
      matched_aliases: matchedAliases,
      raw_alias_mentions: rawAliasMentions,
    };
  });
  const missingRequiredFlags = flagMatrix
    .filter((entry) => !entry.supported)
    .map((entry) => entry.flag);
  const rawMentionedMissingFlags = flagMatrix
    .filter((entry) => !entry.supported && entry.raw_alias_mentions.length > 0)
    .map((entry) => entry.flag);

  let classification = "flags_supported";
  if (unavailable.length > 0) {
    classification = "probe_evidence_unavailable";
  } else if (missingRequiredFlags.length > 0 && hasSuspiciousTruncatedHelp(commandResults)) {
    classification = "probe_capture_suspect";
  } else if (missingRequiredFlags.length > 0 && rawMentionedMissingFlags.length > 0) {
    classification = "recipe_parser_mismatch";
  } else if (missingRequiredFlags.length > 0) {
    classification = recipe.true_unsupported_classification;
  }

  if (classification === "flags_supported" && recipe.tool === "opencode") {
    let oc;
    try {
      oc = assertOpenCodeReviewerContext(context);
    } catch (error) {
      error.classification = "reviewer_cli_recipe_invalid";
      throw error;
    }
    classification = openCodeCapabilityPrecheck(oc, commandResults) ?? classification;
  }

  let authPreflight = {
    classification: "reviewer_host_capability_not_checked",
    command_summary: null,
  };
  if (classification === "flags_supported") {
    authPreflight = recipe.auth_preflight.success_condition === OPENCODE_AUTH_SUCCESS_CONDITION
      ? evaluateOpenCodeAuthPreflight(context, recipe.auth_preflight, runCommand, options)
      : evaluateAuthPreflight(
        recipe.auth_preflight,
        runCommand(recipe.auth_preflight.command, {
          purpose: "auth_preflight",
          timeoutMs: recipe.auth_preflight.timeout_ms,
          maxBufferBytes: recipe.auth_preflight.max_output_bytes,
        })
      );
    if (authPreflight.classification !== "reviewer_host_capability_verified") {
      classification = "reviewer_host_surface_unverified";
    }
  }

  return {
    status: classification === "flags_supported" ? "ok" : "blocked",
    classification,
    generated_at: nowIso(),
    probe_script: probeScript,
    reviewer_cli_recipe: {
      name: recipe.name,
      tool: recipe.tool,
      probe_script: recipe.probe_script,
      probe_commands: recipe.probe_commands,
      auth_preflight: recipe.auth_preflight,
      required_flags: recipe.required_flags,
      required_invocation_args: recipe.required_invocation_args,
      true_unsupported_classification: recipe.true_unsupported_classification,
    },
    command_summaries: commandResults.map(summarizeCommandResult),
    auth_preflight: authPreflight,
    flag_matrix: flagMatrix,
    missing_required_flags: missingRequiredFlags,
  };
}

function refreshHeartbeat(context, result) {
  if (!context?.heartbeat_path) return;
  writeJson(context.heartbeat_path, {
    status: `cli_probe:${result.classification}`,
    attempt_id: context.attempt_id,
    generated_at: nowIso(),
    reviewer_surface: context.reviewer_surface,
    runner_owner: context.runner_owner,
    cli_probe_result_path: context.cli_probe_result_path,
    missing_required_flags: result.missing_required_flags ?? [],
    auth_preflight_classification: result.auth_preflight?.classification ?? null,
  });
}

function malformedResult(context, error) {
  return {
    status: "blocked",
    classification: error.classification ?? "probe_malformed",
    generated_at: nowIso(),
    probe_script: probeScript,
    error: error.message,
    reviewer_cli_recipe: context?.reviewer_cli_recipe ?? null,
    command_summaries: [],
    flag_matrix: [],
    missing_required_flags: [],
    auth_preflight: null,
  };
}

export function runProbe(context, options = {}) {
  appendActivity(context, "projection_cli_probe_started", {
    cli_probe_result_path: context?.cli_probe_result_path,
  });
  let result;
  try {
    result = evaluateProbeEvidence(context, options);
  } catch (error) {
    result = malformedResult(context, error);
  }
  writeJson(context?.cli_probe_result_path, result);
  appendActivity(context, "projection_cli_probe_result", {
    classification: result.classification,
    status: result.status,
    cli_probe_result_path: context?.cli_probe_result_path,
    missing_required_flags: result.missing_required_flags ?? [],
    auth_preflight_classification: result.auth_preflight?.classification ?? null,
  });
  refreshHeartbeat(context, result);
  return result;
}

function main() {
  sanitizeCmuxDispatchEnv(process.env);
  const contextPath = process.argv[2];
  if (!contextPath) {
    console.error("Usage: probe-second-reviewer-cli-recipe.mjs <observability-context.json>");
    process.exit(2);
  }

  let context;
  try {
    context = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch (error) {
    console.error(`Cannot read observability context: ${error.message}`);
    process.exit(2);
  }

  const result = runProbe(context);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    classification: result.classification,
    cli_probe_result_path: context.cli_probe_result_path,
    missing_required_flags: result.missing_required_flags,
  })}\n`);
  process.exit(result.classification === "flags_supported" ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
