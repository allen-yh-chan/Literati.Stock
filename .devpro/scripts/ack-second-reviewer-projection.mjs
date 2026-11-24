#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCanonicalReviewerCliRecipe } from "./second-reviewer-cli-recipe-contract.mjs";
import {
  assertTrustedSecondReviewAuthorization,
  authorizeSecondReviewPacketFile,
} from "./validate-second-review-packet.mjs";
import { isBlank, nowIso } from "./lib/primitives.mjs";
import { createActivityAppender, writeJson } from "./lib/projection-io.mjs";
import {
  canonicalProjectionRunnerCarriers,
  classifyProjectionRunnerCarrier,
  PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL,
} from "./lib/projection-runner-carrier.mjs";

const bootstrapScript = ".devpro/scripts/ack-second-reviewer-projection.mjs";
const appendActivity = createActivityAppender({
  scriptField: "bootstrap_script",
  scriptValue: bootstrapScript,
});
const runnerScript = PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bootstrapScriptPath = path.join(scriptDir, "ack-second-reviewer-projection.mjs");
const runnerScriptPath = path.join(scriptDir, "run-second-reviewer-projection.mjs");
const tlPreDispatchContract = "tl-must-render-before-runtime-native-projection-spawn";
const requiredReviewerSurface = "host-non-sandbox-required";
const requiredRunnerOwner = "adapter-host-runner";
const requiredSandboxPolicy = "auth-required-reviewer-cli-must-not-run-in-sandbox";
const requiredSpawnPayloadFields = [
  "packet_path",
  "observability_context_path",
  "heartbeat_path",
  "activity_log_path",
  "stdout_log_path",
  "stderr_log_path",
  "cli_probe_result_path",
  "projection_bootstrap_command",
  "projection_runner_command",
];
const commonRequiredActivityEvents = [
  "projection_handoff_validated",
  "projection_cli_probe_started",
  "projection_cli_probe_result",
  "projection_cli_starting",
  "projection_cli_started",
];
const requiredActivityEventsByMode = Object.freeze({
  "audit-only": Object.freeze([
    ...commonRequiredActivityEvents,
    "projection_cli_exited",
    "projection_sticky_verification_skipped",
  ]),
  "pr-sticky": Object.freeze([
    ...commonRequiredActivityEvents,
    "projection_sticky_verification_started",
    "projection_sticky_verified|projection_sticky_verification_failed",
    "projection_cli_exited",
  ]),
});
const durationConditionalActivityEvents = [
  ["projection_cli_liveness_sampled", "child-remains-open-at-60s-sample-boundary"],
  ["projection_cli_status_checkpoint", "child-remains-open-at-15m-status-checkpoint"],
];
const projectionHandoffPreflightStates = new WeakMap();

class ProjectionAckError extends Error {
  constructor(message, classification = "projection_observability_contract_missing") {
    super(message);
    this.name = "ProjectionAckError";
    this.classification = classification;
  }
}

function isExactOrderedArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value);
}

function exactExecutableCarrier(scriptPath, contextPath) {
  return { executable: process.execPath, argv: [scriptPath, path.resolve(contextPath)] };
}

function isExactExecutableCarrier(actual, expected) {
  return actual !== null
    && typeof actual === "object"
    && !Array.isArray(actual)
    && Object.keys(actual).sort().join(",") === "argv,executable"
    && actual.executable === expected.executable
    && isExactOrderedArray(actual.argv, expected.argv);
}

function refreshHeartbeat(context, status, payload = {}) {
  if (!context?.heartbeat_path) return;
  writeJson(context.heartbeat_path, {
    status,
    attempt_id: context.attempt_id,
    generated_at: nowIso(),
    reviewer_surface: context.reviewer_surface,
    runner_owner: context.runner_owner,
    activity_log_path: context.activity_log_path,
    stdout_log_path: context.stdout_log_path,
    stderr_log_path: context.stderr_log_path,
    cli_probe_result_path: context.cli_probe_result_path,
    ...(context.review_scope_probe_result_path
      ? { review_scope_probe_result_path: context.review_scope_probe_result_path }
      : {}),
    ...payload,
  });
}

function requireFields(context, fields, errors) {
  for (const field of fields) {
    if (isBlank(context[field])) {
      errors.push(`observability_context.${field} is required`);
    }
  }
}

function validatePathMatchesArg(context, contextPath, errors) {
  const resolvedArg = path.resolve(contextPath);
  if (context.context_path && path.resolve(context.context_path) !== resolvedArg) {
    errors.push("observability_context.context_path must match the invoked context path");
  }
  if (context.observability_context_path && path.resolve(context.observability_context_path) !== resolvedArg) {
    errors.push("observability_context.observability_context_path must match the invoked context path");
  }
}

function validateRequiredArrays(context, errors) {
  if (!Array.isArray(context.required_spawn_payload_fields)) {
    errors.push("observability_context.required_spawn_payload_fields is required");
  } else {
    for (const field of requiredSpawnPayloadFields) {
      if (!context.required_spawn_payload_fields.includes(field)) {
        errors.push(`observability_context.required_spawn_payload_fields missing ${field}`);
      }
    }
  }
  const expectedRequiredActivityEvents = requiredActivityEventsByMode[context.mode];
  if (!expectedRequiredActivityEvents) {
    errors.push("observability_context.mode must be audit-only or pr-sticky");
  } else if (!isExactOrderedArray(context.required_activity_events, expectedRequiredActivityEvents)) {
    errors.push(`observability_context.required_activity_events must exactly match canonical ${context.mode} activity events`);
  }
  if (!Array.isArray(context.duration_conditional_activity_events)) {
    errors.push("observability_context.duration_conditional_activity_events is required");
  } else if (context.duration_conditional_activity_events.length !== durationConditionalActivityEvents.length) {
    errors.push("observability_context.duration_conditional_activity_events must be the exact renderer-owned list");
  } else {
    for (const [index, [event, requiredWhen]] of durationConditionalActivityEvents.entries()) {
      const entry = context.duration_conditional_activity_events[index];
      if (entry?.event !== event || entry?.required_when !== requiredWhen) {
        errors.push(`observability_context.duration_conditional_activity_events missing ${event} condition ${requiredWhen}`);
      }
    }
  }
}

function validateArtifactFiles(context, errors) {
  const requiredArtifacts = [
    "heartbeat_path",
    "activity_log_path",
    "stdout_log_path",
    "stderr_log_path",
    "cli_probe_result_path",
  ];
  if (context.packet_carrier === "file") {
    requiredArtifacts.unshift("packet_path");
  }
  for (const field of requiredArtifacts) {
    const filePath = context[field];
    if (isBlank(filePath) || !existsSync(filePath)) {
      errors.push(`observability artifact missing: ${field}`);
    }
  }
}

function validateProjectionAckContext(context, contextPath, reviewData) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new ProjectionAckError("observability context must be a JSON object");
  }

  // D7 (R7) — checked before assertCanonicalReviewerCliRecipe (a few lines down), which
  // would otherwise throw on a null reviewer_cli_recipe and misreport an external-evaluator
  // dispatch as a generic invalid context. Any other non-absent executor_kind value falls
  // through to the existing checks below unchanged.
  if (context.executor_kind === "external-evaluator") {
    throw new ProjectionAckError(
      "observability_context.executor_kind external-evaluator dispatches are not runnable; use accept-external-second-review.mjs",
      "external_evaluator_dispatch_not_runnable"
    );
  }

  // Deliberately NOT paired with assertReviewerModelSelection() here (r1
  // finding F-srms-pr-05). design.md D2 "邊界" puts the fail-closed authority
  // for a missing/invalid reviewer_model_selection in the runner's
  // validateRunnerContext(), which runs before any spawn, so a pre-contract
  // sidecar still fails closed as projection_context_invalid on the dispatch
  // path. The visible consequence is only that the two families reach that
  // stop at different points: codex trips the deepEqual here (its argv gained
  // the `-c model="..."` pair), claude passes here because the contract
  // module's convenience fallback resolves the built-in `opus` that the old
  // argv already carried. That asymmetry is the known cost of keeping one
  // fail-closed authority, not a missing check.
  assertCanonicalReviewerCliRecipe(context, { reviewData });

  const errors = [];
  requireFields(context, [
    "attempt_id",
    "mode",
    "packet_carrier",
    "packet_path",
    "tl_pre_dispatch_contract",
    "projection_log_visibility",
    "reviewer_surface",
    "runner_owner",
    "sandbox_policy",
    "context_path",
    "observability_context_path",
    "heartbeat_path",
    "activity_log_path",
    "stdout_log_path",
    "stderr_log_path",
    "cli_probe_result_path",
    "projection_bootstrap_script",
    "projection_bootstrap_command",
    "projection_runner_script",
    "projection_runner_command",
    "reviewer_cli_recipe",
  ], errors);

  validatePathMatchesArg(context, contextPath, errors);
  validateRequiredArrays(context, errors);
  validateArtifactFiles(context, errors);

  if (!["file", "stdout"].includes(context.packet_carrier)) {
    errors.push("observability_context.packet_carrier must be file or stdout");
  }
  if (context.tl_pre_dispatch_contract !== tlPreDispatchContract) {
    errors.push(`observability_context.tl_pre_dispatch_contract must be ${tlPreDispatchContract}`);
  }
  if (context.reviewer_surface !== requiredReviewerSurface) {
    errors.push(`observability_context.reviewer_surface must be ${requiredReviewerSurface}`);
  }
  if (context.runner_owner !== requiredRunnerOwner) {
    errors.push(`observability_context.runner_owner must be ${requiredRunnerOwner}`);
  }
  if (context.sandbox_policy !== requiredSandboxPolicy) {
    errors.push(`observability_context.sandbox_policy must be ${requiredSandboxPolicy}`);
  }
  if (context.projection_bootstrap_script !== bootstrapScript) {
    errors.push(`observability_context.projection_bootstrap_script must be ${bootstrapScript}`);
  }
  if (!isExactExecutableCarrier(
    context.projection_bootstrap_command,
    exactExecutableCarrier(bootstrapScriptPath, context.observability_context_path)
  )) {
    errors.push("observability_context.projection_bootstrap_command must be the exact canonical executable/argv carrier; rerender the packet");
  }
  if (context.projection_runner_script !== runnerScript) {
    errors.push(`observability_context.projection_runner_script must be ${runnerScript}`);
  }
  // D3 (add-second-reviewer-runner-permission): accepts either canonical
  // shape (absolute on every host except Claude Code; repo-root-relative on
  // the Claude Code host per D1/D2) via the single shared classifier, not a
  // hardcoded single shape.
  if (classifyProjectionRunnerCarrier(
    context.projection_runner_command,
    canonicalProjectionRunnerCarriers({
      runnerScriptAbsPath: runnerScriptPath,
      contextPath: context.observability_context_path,
      execPath: process.execPath,
    })
  ) === null) {
    errors.push("observability_context.projection_runner_command must be the exact canonical executable/argv carrier; rerender the packet");
  }
  if (!Number.isFinite(Number(context.heartbeat_interval_seconds))
    || Number(context.heartbeat_interval_seconds) <= 0
    || Number(context.heartbeat_interval_seconds) > 60) {
    errors.push("observability_context.heartbeat_interval_seconds must be > 0 and <= 60");
  }

  if (errors.length > 0) {
    throw new ProjectionAckError(errors.join("\n"));
  }
  return reviewData;
}

function readContext(contextPath) {
  try {
    return JSON.parse(readFileSync(contextPath, "utf8"));
  } catch (error) {
    throw new ProjectionAckError(`Cannot read observability context: ${error.message}`);
  }
}

function writeFault(context, error, contextPath) {
  const classification = error.classification ?? "projection_observability_contract_missing";
  // D7 (R7): external-evaluator rejection MUST NOT append activity or refresh the heartbeat —
  // it is a pre-mutation typed exit, not a runnable-attempt fault worth recording as one.
  if ([
    "reviewer_cli_recipe_invalid",
    "second_review_packet_invalid",
    "external_evaluator_dispatch_not_runnable",
  ].includes(classification)) {
    return;
  }
  const payload = {
    classification,
    observability_context_path: contextPath,
    error: error.message,
  };
  try {
    appendActivity(context, classification, payload);
  } catch {
    // If the activity artifact itself is missing/unwritable, heartbeat/stderr remain the fallback evidence.
  }
  try {
    refreshHeartbeat(context, classification, payload);
  } catch {
    // Preserve the original failure classification on stdout/stderr.
  }
}

export function preflightProjectionHandoff(contextPath, options = {}) {
  let context = null;
  let reviewData;
  let trustedAuthorization = null;
  try {
    if (options.trustedAuthorization !== undefined) {
      trustedAuthorization = assertTrustedSecondReviewAuthorization(
        options.trustedAuthorization,
        contextPath,
      );
      context = trustedAuthorization.context;
      reviewData = trustedAuthorization.data;
    } else {
      trustedAuthorization = authorizeSecondReviewPacketFile({ contextPath });
      context = trustedAuthorization.context;
      reviewData = trustedAuthorization.data;
    }
  } catch (error) {
    return {
      status: "blocked",
      classification: error.classification ?? "second_review_packet_invalid",
      error: error.message,
      context,
    };
  }
  try {
    validateProjectionAckContext(context, contextPath, reviewData);
    const preflight = Object.freeze({
      status: "ok",
      classification: "projection_handoff_preflight_validated",
      context,
      trustedAuthorization,
    });
    projectionHandoffPreflightStates.set(preflight, Object.freeze({
      contextPath: path.resolve(contextPath),
      context,
      trustedAuthorization,
    }));
    return preflight;
  } catch (error) {
    return {
      status: "blocked",
      classification: error.classification ?? "projection_observability_contract_missing",
      error: error.message,
      context,
    };
  }
}

function consumeProjectionHandoffPreflight(contextPath, preflight) {
  const state = projectionHandoffPreflightStates.get(preflight);
  if (state === undefined || state.contextPath !== path.resolve(contextPath)) {
    throw new ProjectionAckError(
      "projection handoff preflight must be a fresh canonical authorization",
      "reviewer_dispatch_identity_collision",
    );
  }
  projectionHandoffPreflightStates.delete(preflight);
  return state;
}

export function acknowledgeProjectionHandoff(contextPath, options = {}) {
  const suppliedPreflight = options.preflight !== undefined;
  const preflight = suppliedPreflight
    ? options.preflight
    : preflightProjectionHandoff(contextPath, options);
  if (preflight.status !== "ok") {
    if (!suppliedPreflight && preflight.context !== null) {
      writeFault(preflight.context, {
        classification: preflight.classification,
        message: preflight.error,
      }, contextPath);
    }
    return preflight;
  }

  let state;
  try {
    state = consumeProjectionHandoffPreflight(contextPath, preflight);
  } catch (error) {
    return {
      status: "blocked",
      classification: error.classification ?? "reviewer_dispatch_identity_collision",
      error: error.message,
      context: null,
    };
  }
  const { context, trustedAuthorization } = state;
  try {
    appendActivity(context, "projection_handoff_validated", {
      observability_context_path: contextPath,
      packet_path: context.packet_path,
      next_action: "projection_cli_probe",
    });
    refreshHeartbeat(context, "projection_handoff_validated", {
      next_action: "projection_cli_probe",
      projection_bootstrap_script: bootstrapScript,
    });
    return {
      status: "ok",
      classification: "projection_handoff_validated",
      context,
      trustedAuthorization,
    };
  } catch (error) {
    writeFault(context, error, contextPath);
    return {
      status: "blocked",
      classification: error.classification ?? "projection_observability_contract_missing",
      error: error.message,
      context,
    };
  }
}

function main() {
  const contextPath = process.argv[2];
  if (!contextPath) {
    console.error("Usage: ack-second-reviewer-projection.mjs <observability-context.json>");
    process.exit(2);
  }

  let result;
  try {
    result = acknowledgeProjectionHandoff(contextPath);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify({
    status: result.status,
    classification: result.classification,
    observability_context_path: path.resolve(contextPath),
    activity_log_path: result.context?.activity_log_path,
    heartbeat_path: result.context?.heartbeat_path,
    error: result.error,
  })}\n`);
  process.exit(result.status === "ok" ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
