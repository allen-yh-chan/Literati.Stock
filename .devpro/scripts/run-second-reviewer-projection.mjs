#!/usr/bin/env node
import { isDeepStrictEqual } from "node:util";
import { guaranteeAssessmentRequired, guaranteeReviewedTarget, readReviewGuaranteeAssessment } from "./review-guarantee-assessment.mjs";
import { spawn } from "node:child_process";
import { reviewGithubSpawnSync as spawnSync, assertReviewGithubTransportContext } from "./lib/second-review-github-transport.mjs";
import { refreshSecondReviewGithubObservation } from "./lib/refresh-second-review-github-observation.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { fsyncDirectory, readNoFollowFile, replaceDurableFile } from "./lib/durable-fs.mjs";
import { isDirectChildOfHostSystemTmpdir } from "./lib/host-system-tmpdir.mjs";
import { isIdentifiableCmuxExecutable, sanitizeCmuxDispatchEnv } from "./lib/second-review-env-sanitizer.mjs";
import { parsePostPrMarkerRecord, postPrCompletionDir, postPrMarkerFilenames, postPrMarkerRepoName } from "./hooks/lib/post-pr-completion-state.mjs";
import { repoName } from "./hooks/lib/repo-key.mjs";
import {
  acknowledgeProjectionHandoff,
  preflightProjectionHandoff,
} from "./ack-second-reviewer-projection.mjs";
import { runProbe, runProbeCommand } from "./probe-second-reviewer-cli-recipe.mjs";
import { materializeOpenCodeLaunchConfig } from "./lib/opencode-launch.mjs";
import {
  OPENCODE_ALLOWED_TOOL_NAMES,
  openCodeDisallowedToolUses,
  openCodeReviewerEnv,
} from "./lib/opencode-reviewer.mjs";
import {
  createOpenCodeEventCollector,
  verifyOpenCodeSessionEvidence,
} from "./lib/opencode-session-evidence.mjs";
import {
  assertCanonicalReviewerCliRecipe,
  assertReviewerModelSelection,
  isPathInside,
  requestedKindForSelection,
} from "./second-reviewer-cli-recipe-contract.mjs";
import {
  SECOND_REVIEW_FRAME_MARKER,
  SECOND_REVIEW_PACKET_MAX_BYTES,
  SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION,
  SECOND_REVIEW_VERDICT_REASON_MAX_BYTES,
  PAGE_WINDOW_STICKY_DEFERRED_CLASSIFICATION,
  classificationIndicatesSameFamilyFallback,
  pageWindowIntermediateStickyDisposition,
  parseCanonicalSecondReviewPacketData,
  pageWindowCompletionBindingFromReviewMaterial,
  primaryFamilyIsUnknown,
  secondReviewPacketStaticPrefix,
  secondReviewPacketStaticSuffix,
  secondReviewRulesVersion,
  secondReviewToolForFamily,
  stickyReasonRequiresCrossModelUnverified,
  classifySameFamilyStickyReason,
  assertTrustedSecondReviewAuthorization,
  authorizeSecondReviewPacketFile,
  resolveCredentialGateSidecarPath,
} from "./validate-second-review-packet.mjs";
import {
  appendCheckpointCoverage,
  appendFindingsWindow,
  collectCriticalFindings,
  authorizeGateSatisfyingSticky,
  framePagedReviewMaterial,
  pageWindowCount,
  pageWindowIndices,
  resolveDeclaredPageWindowMaxPages,
  parsePageWindowCompletionObject,
  validatePrStickyReviewMaterialContract,
  PAGED_FULL_PAGES_CARRIER_BASENAME,
  PAGED_FULL_PAGES_CARRIER_SCHEMA,
  SECOND_REVIEW_PRIVATE_CARRIER_MAX_BYTES,
} from "./second-review-material-contract.mjs";
import {
  COMPLETION_SCHEMA,
  FAULT_CAPSULE_SCHEMA,
  MAX_DISPATCHES_PER_REPOSITORY,
  ORCHESTRATION_RESPONSIBILITY,
  TERMINAL_RECEIPT_CLASSIFICATIONS,
  TERMINAL_RECEIPT_RESPONSIBILITY,
  TERMINAL_RECEIPT_SCHEMA,
  canonicalInvocationClaimSha256,
  capacityLockOwnerIsAlive,
  claimDispatchInvocation,
  controlEvidenceRoot,
  interruptedDispatchRecoveryHint,
  isUsableIdentityFieldValue,
  readDispatchEvidence,
  readDispatchEvidenceStrict,
  secondReviewDispatchBaseRecord,
  secondReviewDispatchRecord,
  terminalReceiptOutcomeGroup,
  writeCompletionReceipt,
  writeFaultCapsule,
  writeReviewerModelRecord,
  writeTerminalReceipt,
} from "./hooks/lib/second-review-control-evidence.mjs";
import {
  normalizeSecondReviewStickyCandidate,
  parseSecondReviewStickyAuthorityBody,
  resolveSecondReviewStickyWriteDisposition,
  rewriteStickyProvenanceModel,
  selectExactSecondReviewStickyAuthority,
} from "./hooks/lib/second-review-sticky-authority.mjs";
import {
  acquireAttemptOwnership,
  attemptLockPath,
  lockOwnerState,
  releaseAttemptOwnership,
} from "./lib/second-review-attempt-lock.mjs";
import { isBlank, isPlainObject, isRepositorySlug, nowIso, sha256Hex } from "./lib/primitives.mjs";
import {
  canonicalProjectionRunnerCarriers,
  classifyProjectionRunnerCarrier,
  PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL,
} from "./lib/projection-runner-carrier.mjs";
import {
  assertStickyBodyCredentialFree,
  credentialGateTelemetry,
  STICKY_CREDENTIAL_LITERAL_BLOCKED,
  STICKY_CREDENTIAL_LITERAL_DETECTED,
} from "./lib/second-review-sticky-credential-gate.mjs";
import {
  STICKY_WRITE_RESULT_BASENAME,
  STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
  STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME,
  stickyWriteResultBasename,
} from "./write-second-review-sticky-gated.mjs";
import { createActivityAppender, writeJson } from "./lib/projection-io.mjs";
import {
  buildUsageManifest,
  extractCodexReviewerSessionCandidate,
  extractReviewerSessionEntry,
  writeUsageManifest,
} from "./lib/session-usage-manifest.mjs";

const runnerScript = PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL;
const appendActivity = createActivityAppender({
  scriptField: "runner_script",
  scriptValue: runnerScript,
});
// The renderer/validator pair admits only canonical devpro-second-review-data/v3
// audit or canonical devpro-second-review-data/v4/v5 pr-sticky packets before this runner
// claims the matching immutable reservation.
const defaultStatusCheckpointMs = 15 * 60 * 1000;
const defaultTotalTimeoutMs = 30 * 60 * 1000;
const defaultTerminationGraceMs = 5 * 1000;
const defaultForceSettleMs = 1 * 1000;
const maxReviewerOutputLineBytes = 64 * 1024;
const maxReviewerThinkingOutputLineBytes = 1024 * 1024;
const maxReviewerSignatureOutputLineBytes = 1024 * 1024;
const maxOrchestrationEvidenceExcerptBytes=512;
const runnerScriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(runnerScriptDir, "../..");
const bootstrapScriptPath = path.join(runnerScriptDir, "ack-second-reviewer-projection.mjs");
const runnerScriptPath = path.join(runnerScriptDir, "run-second-reviewer-projection.mjs");
const terminalReviewerMarker = "DEVPRO_CROSS_MODEL_REVIEWER";
const reviewerPrNumberEnv = "DEVPRO_REVIEW_PR_NUMBER";

function blockedToolDiscovery(reason) {
  return {
    status: "blocked",
    classification: "tool_discovery_blocked",
    reason,
  };
}

function executableCandidates(tool, platform, pathExtValue) {
  if (platform !== "win32") return [{ name: tool, direct: true }];
  const toolExtension = path.win32.extname(tool).toUpperCase();
  if (toolExtension) {
    return [{
      name: tool,
      direct: toolExtension === ".COM" || toolExtension === ".EXE",
    }];
  }
  const extensions = String(pathExtValue ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]{1,16}$/.test(extension));
  return extensions.map((extension) => ({
    name: `${tool}${extension}`,
    direct: [".COM", ".EXE"].includes(extension.toUpperCase()),
  }));
}

function resolveReviewerExecutable(tool, options = {}) {
  const pathValue = options.pathValue ?? options.env?.PATH ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const access = options.accessSyncImpl ?? accessSync;
  const stat = options.statSyncImpl ?? statSync;
  const resolveRealpath = options.realpathSyncImpl ?? realpathSync;
  const pathApi = platform === "win32" ? path.win32 : path;
  const candidates = executableCandidates(
    tool,
    platform,
    options.pathExtValue ?? options.env?.PATHEXT ?? process.env.PATHEXT
  );

  for (const entry of String(pathValue).split(pathApi.delimiter)) {
    const directory = entry === "" ? cwd : entry;
    for (const executableCandidate of candidates) {
      const candidate = pathApi.resolve(directory, executableCandidate.name);
      try {
        access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        if (!stat(candidate).isFile()) continue;
      } catch {
        continue;
      }
      if (!executableCandidate.direct) {
        return blockedToolDiscovery("tool_requires_shell_interpretation");
      }

      let executable;
      try {
        executable = resolveRealpath(candidate);
      } catch {
        return blockedToolDiscovery("tool_realpath_failed");
      }
      if (isIdentifiableCmuxExecutable(candidate, executable)) {
        return blockedToolDiscovery("cmux_wrapper_or_shim_first_hit");
      }
      return { status: "trusted", executable };
    }
  }
  return blockedToolDiscovery("tool_missing_from_path");
}

export const __testReviewerExecutable = Object.freeze({
  resolve: resolveReviewerExecutable,
});

function allowlistedProbeErrorCode(value, fallback = null) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(value)
    ? value
    : fallback;
}

function normalizedBoundProbeResult(carrier, result) {
  const validResult = result && typeof result === "object" && !Array.isArray(result);
  const hasError = !validResult || Boolean(result.error);
  return {
    command: carrier.executable,
    args: [...carrier.argv],
    status: validResult ? (result.status ?? null) : null,
    signal: validResult ? (result.signal ?? null) : null,
    error: hasError ? "probe command failed" : null,
    error_code: allowlistedProbeErrorCode(
      validResult ? result.error_code : null,
      hasError ? "PROBE_EXECUTION_FAILED" : null,
    ),
    stdout: validResult ? (result.stdout ?? "") : "",
    stderr: validResult ? (result.stderr ?? "") : "",
  };
}

function runProbeWithBoundExecutable(context, reviewerExecutable, probeOptions = {}) {
  const { runCommand: injectedRunCommand, ...probeCommandOptions } = probeOptions;
  const underlyingRunCommand = injectedRunCommand ?? ((carrier, commandOptions = {}) => (
    runProbeCommand(carrier, { ...probeCommandOptions, ...commandOptions })
  ));
  return runProbe(context, {
    ...probeOptions,
    runCommand(carrier, commandOptions = {}) {
      let result;
      try {
        result = underlyingRunCommand(
          { ...carrier, executable: reviewerExecutable },
          commandOptions
        );
      } catch (error) {
        result = {
          status: null,
          signal: null,
          error: true,
          error_code: allowlistedProbeErrorCode(error?.code, "PROBE_EXECUTION_FAILED"),
          stdout: "",
          stderr: "",
        };
      }
      return normalizedBoundProbeResult(carrier, result);
    },
  });
}
const structuredOutputTypes = new Set([
  "assistant",
  "error",
  "item.completed",
  "item.started",
  "rate_limit_event",
  "result",
  "stream_event",
  "system",
  "thread.started",
  "turn.completed",
  "turn.failed",
  "turn.started",
  "user",
]);
const structuredOutputSubtypes = new Set([
  "api_error",
  "error",
  "init",
  "success",
]);
const structuredNestedEventTypes = new Set([
  "content_block_delta",
  "content_block_start",
  "content_block_stop",
  "error",
  "message_delta",
  "message_start",
  "message_stop",
  "ping",
]);

// D2 (R1; fix-projection-completion-truncation) — the one allowlist fold answering "which
// structured event was this", shared by the live liveness observer and the end-of-run
// bounded-tail extractor so both describe provider events identically: unrecognized
// (unproven) vocabulary folds to the closed `"unknown"` token, a missing value stays
// `null`, and no provider-controlled string crosses this boundary un-allowlisted.
function foldedStructuredEventMetadata(event) {
  const enumMetadata = (value, allowlist) => {
    if (typeof value !== "string") return null;
    return allowlist.has(value) ? value : "unknown";
  };
  return {
    type: enumMetadata(event?.type, structuredOutputTypes),
    subtype: enumMetadata(event?.subtype, structuredOutputSubtypes),
    event_type: enumMetadata(event?.event?.type, structuredNestedEventTypes),
  };
}

class ProjectionRunnerError extends Error {
  constructor(message, classification = "reviewer_cli_runner_error") {
    super(message);
    this.name = "ProjectionRunnerError";
    this.classification = classification;
  }
}

function prNumberFromTarget(value) {
  return String(value ?? "").match(/^PR #([1-9][0-9]*)$/)?.[1] ?? "none";
}

function validateRunnerContext(context, reviewData) {
  if(context.github_transport!==reviewData?.github_transport)throw new ProjectionRunnerError('GitHub transport differs from sealed Review Data','reviewer_transport_context_mismatch');
  // D7 (R7) — external-evaluator dispatches are not runnable by this script at all: the
  // handoff-declared executor_kind is checked first, before every other shape check below
  // (including the reviewer CLI recipe assertion a few lines down, which would otherwise
  // explode on a null reviewer_cli_recipe and misreport this as a generic invalid context).
  // Any other non-absent executor_kind value is left to fall through to the existing checks
  // below (fail closed via their own classifications) rather than gaining a bespoke branch here.
  if (context.executor_kind === "external-evaluator") {
    throw new ProjectionRunnerError(
      "observability_context.executor_kind external-evaluator dispatches are not runnable; use accept-external-second-review.mjs",
      "external_evaluator_dispatch_not_runnable"
    );
  }
  if (Object.hasOwn(context, "page_window_full_scan")) {
    throw new ProjectionRunnerError(
      "page_window_full_scan has been removed; regenerate the packet for the unified scan",
      "projection_context_invalid"
    );
  }
  // D2/D8 (design.md D2 "邊界"; tasks.md items 5/8): the runner MUST validate
  // reviewer_model_selection BEFORE ever calling into the recipe builder
  // (assertCanonicalReviewerCliRecipe -> canonicalReviewerCliRecipe), on this
  // function's single call site that runs first in the real dispatch flow
  // (runProjection() calls validateRunnerContext() before anything else that
  // could reach the recipe builder — see runReviewScopeProbe()'s own
  // assertCanonicalReviewerCliRecipe call, which only ever runs downstream of
  // this one in the live flow). Otherwise resolveRequestedReviewerModel()'s
  // convenience fallback to the built-in default (meant only for probes/unit
  // tests) would silently make a missing/invalid selection dispatch-reachable.
  // Both families fail closed with the SAME classification here
  // (projection_context_invalid) regardless of which sub-rule tripped — this
  // is the pre-contract-sidecar skew gate (item 8), not the render-period D3
  // shape gate (which already ran once, earlier, at render time, and carries
  // its own reviewer_model_override_invalid classification there).
  try {
    assertReviewerModelSelection(context.reviewer_model_selection, context.reviewer_cli_recipe?.tool);
  } catch (error) {
    throw new ProjectionRunnerError(
      `observability_context.reviewer_model_selection must be a validated {requested, source, env_var} `
      + `selection with automatic probe proof consistent with the resolved reviewer_cli_recipe (${error.message}); rerender the packet`,
      "projection_context_invalid"
    );
  }
  assertCanonicalReviewerCliRecipe(context, { reviewData });
  // D4: projection_bootstrap_command stays the single exact absolute shape on
  // every host, no exception.
  {
    const carrier = context.projection_bootstrap_command;
    const expectedArgv = [bootstrapScriptPath, path.resolve(String(context.observability_context_path ?? ""))];
    if (carrier === null
      || typeof carrier !== "object"
      || Array.isArray(carrier)
      || Object.keys(carrier).sort().join(",") !== "argv,executable"
      || carrier.executable !== process.execPath
      || !Array.isArray(carrier.argv)
      || carrier.argv.length !== expectedArgv.length
      || expectedArgv.some((value, index) => carrier.argv[index] !== value)) {
      throw new ProjectionRunnerError(
        "observability_context.projection_bootstrap_command must be the exact canonical executable/argv carrier; rerender the packet",
        "projection_context_invalid"
      );
    }
  }
  // D3 (add-second-reviewer-runner-permission): projection_runner_command
  // accepts either canonical shape (absolute on every host except Claude
  // Code; repo-root-relative on the Claude Code host per D1/D2) via the
  // single shared classifier, not a hardcoded single shape.
  if (classifyProjectionRunnerCarrier(
    context.projection_runner_command,
    canonicalProjectionRunnerCarriers({
      runnerScriptAbsPath: runnerScriptPath,
      contextPath: context.observability_context_path,
      execPath: process.execPath,
    })
  ) === null) {
    throw new ProjectionRunnerError(
      "observability_context.projection_runner_command must be the exact canonical executable/argv carrier; rerender the packet",
      "projection_context_invalid"
    );
  }
  if (!isRepositorySlug(context.repository_slug)) {
    throw new ProjectionRunnerError(
      "observability_context.repository_slug must use strict owner/name format",
      "projection_context_invalid"
    );
  }
  if (context.mode === "pr-sticky"
    && (!/^[1-9][0-9]*$/.test(String(context.pr_number ?? ""))
      || context.pr_number !== prNumberFromTarget(context.target))) {
    throw new ProjectionRunnerError(
      "observability_context.pr_number must exactly match the canonical positive decimal target PR number for pr-sticky mode",
      "projection_context_invalid"
    );
  }
  if (context.mode === "audit-only" && context.pr_number !== "none") {
    throw new ProjectionRunnerError(
      "observability_context.pr_number must be none for audit-only mode",
      "projection_context_invalid"
    );
  }
  if (!path.isAbsolute(String(context.control_evidence_root ?? ""))) {
    throw new ProjectionRunnerError(
      "observability_context.control_evidence_root must be an absolute renderer-owned path",
      "projection_context_invalid"
    );
  }
  const neutralCwd = path.resolve(String(context.neutral_cwd_path ?? ""));
  if (!path.isAbsolute(String(context.neutral_cwd_path ?? ""))
    || !isDirectChildOfHostSystemTmpdir(neutralCwd)
    || !path.basename(neutralCwd).startsWith("devpro-second-review-neutral-")
    || isPathInside(repoRoot, neutralCwd)) {
    throw new ProjectionRunnerError(
      "observability_context.neutral_cwd_path must be a renderer-owned repo-external direct child of the host temp directory",
      "projection_context_invalid"
    );
  }
  const recipe = context.reviewer_cli_recipe ?? {};
  if (recipe.tool === "claude" && !["audit-only", "pr-sticky"].includes(context.mode)) {
    throw new ProjectionRunnerError(
      "Claude reviewer mode must be audit-only or pr-sticky",
      "claude_reviewer_mode_unsupported"
    );
  }
  if (recipe.tool === "opencode" && !["audit-only", "pr-sticky"].includes(context.mode)) {
    throw new ProjectionRunnerError(
      "OpenCode reviewer mode must be audit-only or pr-sticky",
      "opencode_reviewer_mode_unsupported"
    );
  }
  if (recipe.tool === "codex") {
    const args = Array.isArray(recipe.required_invocation_args) ? recipe.required_invocation_args : [];
    const cwdFlagIndex = args.indexOf("-C");
    if (cwdFlagIndex < 0 || path.resolve(String(args[cwdFlagIndex + 1] ?? "")) !== neutralCwd) {
      throw new ProjectionRunnerError(
        "Codex reviewer CLI -C must match observability_context.neutral_cwd_path",
        "projection_context_invalid"
      );
    }
  }
  return neutralCwd;
}

function attemptHasCloseEvidence(evidence) {
  return Boolean(evidence.completion
    || evidence.terminal
    || evidence.capsule
    || evidence.consumption
    || evidence.supersession
    || evidence.operatorDisposition);
}

// A dead lock does not say whether the attempt finished, and evidence that cannot be read
// proves neither state, so only readable evidence with nothing closing it names the way out.
function deadOwnerRecoveryHint(context, env) {
  try {
    const evidence = readDispatchEvidence({
      rootDir: evidenceRootForContext(context, env),
      dispatchId: context.dispatch_id,
    });
    return attemptHasCloseEvidence(evidence)
      ? null
      : interruptedDispatchRecoveryHint(context.attempt_id);
  } catch {
    return null;
  }
}

function evidenceRootForContext(context, env = process.env) {
  return env.DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR
    ? controlEvidenceRoot(env, repoRoot)
    : path.resolve(context.control_evidence_root);
}

// D5 (add-second-reviewer-runner-permission) — the same 1 MiB trusted-context
// byte cap validate-second-review-packet.mjs's TRUSTED_CONTEXT_MAX_BYTES
// uses, kept as a local literal rather than an import so this bounded,
// read-only pre-authorization probe never has to reach into the trusted
// authorization module before authorizeSecondReviewPacketFile ever runs.
const PROJECTION_RUNNER_SELF_CHECK_CONTEXT_MAX_BYTES = 1_048_576;

// D5 step 3 — the fixed relative suffix a bootstrap carrier's argv[0] must
// end with for a renderer root R to be derivable from it at all
// (argv[0] === path.join(R, ".devpro/scripts/ack-second-reviewer-projection.mjs")).
const rendererRootDerivationSuffix = path.sep + path.join(
  ".devpro", "scripts", "ack-second-reviewer-projection.mjs"
);

function rendererRootFromBootstrapArgv0(argv0) {
  if (typeof argv0 !== "string" || !path.isAbsolute(argv0)) return null;
  if (!argv0.endsWith(rendererRootDerivationSuffix)) return null;
  const candidate = argv0.slice(0, argv0.length - rendererRootDerivationSuffix.length);
  return candidate === "" ? path.sep : candidate;
}

/**
 * D5 — runner self-check. Read-only; runs only when
 * `context.projection_runner_command` classifies as the D3 repo-relative
 * shape (an absolute carrier is never given a cwd precondition, preserving
 * "valid outside the repo/worktree cwd" for every other host). On failure,
 * returns the blocked D5 result BEFORE any activity/heartbeat/lock/control-
 * evidence write — the caller (runProjection) must call this before
 * authorizeSecondReviewPacketFile and before anything else. Returns `null`
 * when the self-check does not apply or passes; the caller falls through to
 * the existing authorization sequence unchanged either way.
 */
function projectionRunnerCwdSelfCheck(contextPath, options = {}) {
  let rawContext;
  try {
    const stat = statSync(contextPath);
    if (!stat.isFile() || stat.size > PROJECTION_RUNNER_SELF_CHECK_CONTEXT_MAX_BYTES) return null;
    rawContext = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch {
    // D5 step 1: a read/parse failure here defers entirely to the existing
    // authorization path's own fail-closed classification.
    return null;
  }
  if (rawContext === null || typeof rawContext !== "object" || Array.isArray(rawContext)) return null;

  const canonical = canonicalProjectionRunnerCarriers({
    runnerScriptAbsPath: runnerScriptPath,
    contextPath: rawContext.observability_context_path ?? contextPath,
    execPath: options.execPath ?? process.execPath,
  });
  if (classifyProjectionRunnerCarrier(rawContext.projection_runner_command, canonical) !== "repo-relative") {
    // D5 step 2: absolute (or unrecognized) carrier skips the self-check entirely.
    return null;
  }

  const cwdInput = options.cwd ?? process.cwd();
  let cwdReal;
  let ownRoot;
  try {
    cwdReal = realpathSync.native(cwdInput);
    ownRoot = realpathSync.native(repoRoot);
  } catch (error) {
    return {
      status: "blocked",
      classification: "projection_observability_contract_missing",
      reason: "projection_runner_cwd_not_repo_root",
      error: `Unable to resolve the runner cwd or its own checkout root (${error.message}); `
        + `relaunch node ${runnerScript} <observability-context.json> from the renderer's own checkout root.`,
    };
  }

  const bootstrap = rawContext.projection_bootstrap_command;
  const bootstrapArgv0 = bootstrap !== null && typeof bootstrap === "object" && Array.isArray(bootstrap.argv)
    ? bootstrap.argv[0]
    : null;
  const rendererRootCandidate = rendererRootFromBootstrapArgv0(bootstrapArgv0);
  let rendererRoot = null;
  if (rendererRootCandidate !== null) {
    try {
      rendererRoot = realpathSync.native(rendererRootCandidate);
    } catch {
      // Unresolvable candidate: leave the bootstrap mismatch to the existing
      // exact carrier check downstream instead of failing here on it.
      rendererRoot = null;
    }
  }

  if (cwdReal !== ownRoot || (rendererRoot !== null && rendererRoot !== ownRoot)) {
    // D5 "失敗輸出": name the RENDERER's repo root to rerun from (the
    // bootstrap-derived rendererRoot when it was derivable — that is the
    // renderer's own checkout, which can differ from this runner file's own
    // checkout in K3 case b'/c'/d — falling back to this runner's own root
    // only when no rendererRoot could be derived at all), plus the current cwd.
    const rerunFromRoot = rendererRootCandidate ?? repoRoot;
    return {
      status: "blocked",
      classification: "projection_observability_contract_missing",
      reason: "projection_runner_cwd_not_repo_root",
      error: `Relaunch node ${runnerScript} <observability-context.json> from the renderer's own `
        + `checkout root (${rerunFromRoot}) as a single command; current cwd was ${cwdInput}.`,
    };
  }

  const bootstrapExecutable = bootstrap !== null && typeof bootstrap === "object" ? bootstrap.executable : undefined;
  if (typeof bootstrapExecutable !== "string" || bootstrapExecutable === "") {
    // A malformed/missing bootstrap.executable is a different failure than a
    // genuine two-real-paths node mismatch; defer to the existing exact-carrier
    // validation downstream instead of misreporting projection_runner_node_mismatch
    // with "(undefined)" in the error text.
    return null;
  }
  const actualExecPath = options.execPath ?? process.execPath;
  if (actualExecPath !== bootstrapExecutable) {
    return {
      status: "blocked",
      classification: "projection_observability_contract_missing",
      reason: "projection_runner_node_mismatch",
      error: `The PATH-resolved node (${actualExecPath}) does not match the renderer's node `
        + `(${bootstrapExecutable}); relaunch node ${runnerScript} <observability-context.json> `
        + `with the same node the renderer used.`,
    };
  }

  return null;
}

// Deliberately narrow test seam for deterministic ownership fault injection.
export const __testAttemptOwnership = Object.freeze({
  deadOwnerRecoveryHint,
  acquire: acquireAttemptOwnership,
  release: releaseAttemptOwnership,
  lockPath: attemptLockPath,
});

// Deliberately narrow test seam for the default runner timing contract.
export const __testRunnerTiming = Object.freeze({
  defaultStatusCheckpointMs,
  defaultTotalTimeoutMsForTool,
});

function supportsReviewerProcessGroups(platform = process.platform) {
  return platform !== "win32";
}

function signalOpenReviewerTransport(child, signal, options = {}) {
  const childOpenBefore = child.exitCode === null && child.signalCode === null;
  const processGroupId = options.processGroupId;
  const useProcessGroup = supportsReviewerProcessGroups(options.platform)
    && Number.isInteger(processGroupId)
    && processGroupId > 0;
  if (!childOpenBefore && !useProcessGroup) {
    return {
      status: "reviewer_transport_already_closed",
      attempted: false,
      accepted: false,
      signal: null,
      child_open_before: false,
    };
  }

  let accepted;
  if (useProcessGroup) {
    try {
      accepted = (options.killProcess ?? process.kill)(-processGroupId, signal) !== false;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return {
        status: "reviewer_transport_process_group_gone",
        attempted: true,
        accepted: false,
        signal,
        child_open_before: childOpenBefore,
        ...(signal === "SIGKILL" ? { process_group: true } : {}),
      };
    }
  } else {
    accepted = child.kill(signal);
  }
  return {
    status: accepted
      ? `reviewer_transport_${signal.toLowerCase()}_requested`
      : `reviewer_transport_${signal.toLowerCase()}_not_accepted`,
    attempted: true,
    accepted,
    signal,
    child_open_before: childOpenBefore,
    ...(signal === "SIGKILL" ? { process_group: useProcessGroup } : {}),
  };
}

function terminateOpenReviewerTransport(child, options = {}) {
  return signalOpenReviewerTransport(child, "SIGTERM", options);
}

function forceKillOpenReviewerTransport(child, options = {}) {
  return signalOpenReviewerTransport(child, "SIGKILL", options);
}

function reviewerTransportCleanupComplete(termination) {
  return termination?.status === "reviewer_transport_process_group_gone"
    || termination?.status === "reviewer_transport_already_closed";
}

function reviewerLifecycleCleanupConfirmed({
  processSpawned,
  processCloseObserved,
  processGroupId,
  platform = process.platform,
  killProcess = process.kill,
}) {
  if (processSpawned !== true) return true;
  if (processCloseObserved !== true) return false;
  if (!supportsReviewerProcessGroups(platform)
    || !Number.isInteger(processGroupId)
    || processGroupId <= 0) {
    return true;
  }
  try {
    killProcess(-processGroupId, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

// The signal-0 probe is inlined rather than delegated to
// `reviewerLifecycleCleanupConfirmed()` because that predicate collapses every
// non-ESRCH signal error into "not confirmed". Convergence has to tell the two
// apart: ESRCH means the group is reaped, while EPERM and friends mean the group
// exists but cannot be signalled, so escalating would be pointless and the run
// must fail closed immediately instead.
function probeReviewerProcessGroup(processGroupId, killProcess) {
  try {
    killProcess(-processGroupId, 0);
    return "alive";
  } catch (error) {
    return error?.code === "ESRCH" ? "gone" : "error";
  }
}

// A successful close used to be observed once and never acted on: a single stray
// group member alive at that instant left cleanup unconfirmed forever, which
// withholds the closed-terminal receipt and deadlocks that PR's review lineage.
// This converges the group instead, within the same bounds hard-cap termination
// already uses, and stops at the first ESRCH.
async function convergeReviewerTransportOnClose(child, {
  processSpawned,
  closeObserved,
  processGroupId,
  platform = process.platform,
  killProcess = process.kill,
  graceMs,
  settleMs,
  sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
} = {}) {
  const eligible = processSpawned === true
    && closeObserved === true
    && supportsReviewerProcessGroups(platform)
    && Number.isInteger(processGroupId)
    && processGroupId > 0;
  if (!eligible) {
    // Hosts without process groups, runs that never spawned, and forced
    // settlements keep exactly the semantics they had before convergence existed.
    return {
      confirmed: reviewerLifecycleCleanupConfirmed({
        processSpawned,
        processCloseObserved: closeObserved === true,
        processGroupId,
        platform,
        killProcess,
      }),
      telemetry: {
        eligible: false,
        outcome: null,
        probes: 0,
        signals: [],
        escalated: false,
        grace_ms: null,
        settle_ms: null,
      },
    };
  }

  const signalOptions = { platform, processGroupId, killProcess };
  const signals = [];
  let probes = 0;
  let escalated = false;
  const settle = (outcome, confirmed) => ({
    confirmed,
    telemetry: {
      eligible: true,
      outcome,
      probes,
      signals: [...signals],
      escalated,
      grace_ms: graceMs ?? null,
      settle_ms: settleMs ?? null,
    },
  });
  const probe = () => {
    probes += 1;
    return probeReviewerProcessGroup(processGroupId, killProcess);
  };

  const beforeSignal = probe();
  if (beforeSignal === "gone") return settle("already_clean", true);
  if (beforeSignal === "error") return settle("signal_error", false);

  let termination;
  try {
    termination = terminateOpenReviewerTransport(child, signalOptions);
  } catch {
    return settle("signal_error", false);
  }
  signals.push("SIGTERM");
  if (reviewerTransportCleanupComplete(termination)) return settle("sigterm_group_gone", true);

  await sleep(graceMs);
  const afterGrace = probe();
  if (afterGrace === "gone") return settle("sigterm_converged", true);
  if (afterGrace === "error") return settle("signal_error", false);

  let forced;
  try {
    forced = forceKillOpenReviewerTransport(child, signalOptions);
  } catch {
    return settle("signal_error", false);
  }
  signals.push("SIGKILL");
  escalated = true;
  if (reviewerTransportCleanupComplete(forced)) return settle("sigkill_group_gone", true);

  await sleep(settleMs);
  const afterSettle = probe();
  if (afterSettle === "gone") return settle("sigkill_converged", true);
  if (afterSettle === "error") return settle("signal_error", false);
  return settle("cleanup_unconfirmed", false);
}

// Deliberately narrow test seam for deterministic transport-termination semantics.
export const __testReviewerTransport = Object.freeze({
  terminateOpen: terminateOpenReviewerTransport,
  forceKillOpen: forceKillOpenReviewerTransport,
  cleanupConfirmed: reviewerLifecycleCleanupConfirmed,
  converge: convergeReviewerTransportOnClose,
  supportsProcessGroups: supportsReviewerProcessGroups,
});

function createBoundedLineAccumulator({ onLine, onOverflow, maxBytes = maxReviewerOutputLineBytes }) {
  let chunks = [];
  let byteLength = 0;
  // `overflowed` is a terminal latch: once set, the
  // accumulator permanently stops accepting bytes and emitting lines.
  let overflowed = false;

  function appendSegment(segment) {
    if (overflowed || segment.length === 0) return;
    if (byteLength + segment.length > maxBytes) {
      chunks = [];
      byteLength = 0;
      overflowed = true;
      onOverflow({ maxBytes });
      return;
    }
    chunks.push(Buffer.from(segment));
    byteLength += segment.length;
  }

  function emitLine() {
    if (overflowed) return;
    const line = chunks.length === 0
      ? ""
      : Buffer.concat(chunks, byteLength).toString("utf8");
    chunks = [];
    byteLength = 0;
    onLine(line);
  }

  return Object.freeze({
    write(chunk) {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < buffer.length && !overflowed) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline < 0) {
          appendSegment(buffer.subarray(start));
          break;
        }
        appendSegment(buffer.subarray(start, newline));
        emitLine();
        start = newline + 1;
      }
    },
    end() {
      if (overflowed) return;
      if (byteLength > 0) emitLine();
    },
  });
}

const claudeThinkingStreamRootKeys = Object.freeze([
  "type", "event", "session_id", "parent_tool_use_id", "uuid",
]);
// Claude CLI 2.1.296 adds this root key to stream events; it stays a closed, typed optional key.
const claudeThinkingStreamMessageIdRootKeys = Object.freeze([
  ...claudeThinkingStreamRootKeys, "api_message_id",
]);
const claudeThinkingStreamEventKeys = Object.freeze(["type", "index", "delta"]);
const claudeAssistantThinkingRootKeys = Object.freeze([
  "type", "message", "parent_tool_use_id", "session_id", "uuid", "timestamp", "request_id",
]);
const claudeAssistantThinkingTimedRootKeys = Object.freeze([
  ...claudeAssistantThinkingRootKeys, "thinking_duration_ms",
]);
const claudeAssistantThinkingMessageKeys = Object.freeze([
  "model", "id", "type", "role", "content", "container", "stop_reason", "stop_sequence",
  "stop_details", "usage", "input_transformations", "diagnostics", "context_management",
]);
const claudeThinkingDeltaTypes = new Set(["thinking_delta", "signature_delta"]);
const jsonStringPattern = '"(?:[^"\\\\]|\\\\.)*"';
const claudeThinkingDeltaPrefixPattern = new RegExp(
  '^\\{"type":"stream_event","event":\\{"type":"content_block_delta",'
  + '"index":(?:0|[1-9][0-9]*),"delta":\\{"type":"thinking_delta","thinking":'
);
const claudeSignatureDeltaPrefixPattern = new RegExp(
  '^\\{"type":"stream_event","event":\\{"type":"content_block_delta",'
  + '"index":(?:0|[1-9][0-9]*),"delta":\\{"type":"signature_delta","signature":'
);
const claudeAssistantThinkingPrefixPattern = new RegExp(
  '^\\{"type":"assistant","message":\\{"model":' + jsonStringPattern
  + ',"id":' + jsonStringPattern
  + ',"type":"message","role":"assistant","content":\\[\\{"type":"thinking","thinking":'
);

function hasExactOwnKeySet(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function classifyClaudeThinkingLinePrefix(prefixBytes) {
  const prefix = Buffer.from(prefixBytes).toString("utf8");
  if (claudeThinkingDeltaPrefixPattern.test(prefix)) return "stream_event_thinking_delta";
  if (claudeSignatureDeltaPrefixPattern.test(prefix)) return "stream_event_signature_delta";
  if (claudeAssistantThinkingPrefixPattern.test(prefix)) return "assistant_thinking_only";
  return null;
}

function validClaudeStreamIdentity(event) {
  return typeof event.session_id === "string"
    && event.session_id.length > 0
    && typeof event.uuid === "string"
    && event.uuid.length > 0
    && (event.parent_tool_use_id === null || typeof event.parent_tool_use_id === "string");
}

function classifyStrictClaudeThinkingLine(line) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }

  if (row?.type === "stream_event") {
    const hasApiMessageId = Object.hasOwn(row, "api_message_id");
    if (!hasExactOwnKeySet(row, hasApiMessageId
      ? claudeThinkingStreamMessageIdRootKeys : claudeThinkingStreamRootKeys)
        || (hasApiMessageId && (typeof row.api_message_id !== "string" || row.api_message_id.length === 0))
        || !validClaudeStreamIdentity(row)
        || !hasExactOwnKeySet(row.event, claudeThinkingStreamEventKeys)
        || row.event.type !== "content_block_delta"
        || !Number.isInteger(row.event.index)
        || row.event.index < 0
        || !isPlainObject(row.event.delta)
        || !claudeThinkingDeltaTypes.has(row.event.delta.type)) {
      return null;
    }
    const contentKey = row.event.delta.type === "thinking_delta" ? "thinking" : "signature";
    if (!hasExactOwnKeySet(row.event.delta, ["type", contentKey])
        || typeof row.event.delta[contentKey] !== "string") {
      return null;
    }
    return `stream_event_${row.event.delta.type}`;
  }

  const hasThinkingDuration = Object.hasOwn(row ?? {}, "thinking_duration_ms");
  const hasThinkingDisplay = Object.hasOwn(row ?? {}, "thinking_display");
  const assistantRootKeys = hasThinkingDuration
    ? claudeAssistantThinkingTimedRootKeys : claudeAssistantThinkingRootKeys;
  if (row?.type !== "assistant"
      || !hasExactOwnKeySet(row, hasThinkingDisplay
        ? [...assistantRootKeys, "thinking_display"] : assistantRootKeys)
      || (hasThinkingDisplay && row.thinking_display !== "updates")
      || (hasThinkingDuration && (!Number.isSafeInteger(row.thinking_duration_ms)
        || row.thinking_duration_ms < 0))
      || !validClaudeStreamIdentity(row)
      || typeof row.timestamp !== "string"
      || typeof row.request_id !== "string"
      || !hasExactOwnKeySet(row.message, claudeAssistantThinkingMessageKeys)
      || typeof row.message.model !== "string"
      || typeof row.message.id !== "string"
      || row.message.type !== "message"
      || row.message.role !== "assistant"
      || row.message.stop_reason !== null
      || row.message.stop_sequence !== null
      || row.message.stop_details !== null
      || !isPlainObject(row.message.usage)
      || row.message.diagnostics !== null
      || row.message.context_management !== null
      || !Array.isArray(row.message.content)
      || row.message.content.length === 0) {
    return null;
  }
  const allThinking = row.message.content.every((block) => (
    hasExactOwnKeySet(block, ["type", "thinking", "signature"])
    && block.type === "thinking"
    && typeof block.thinking === "string"
    && typeof block.signature === "string"
  ));
  return allThinking ? "assistant_thinking_only" : null;
}

function createReviewerOutputLineRouter({
  reviewerFamily,
  stream,
  onLine,
  onOverflow,
  onDiscard = () => {},
  genericMaxBytes = maxReviewerOutputLineBytes,
  thinkingMaxBytes = maxReviewerThinkingOutputLineBytes,
  signatureMaxBytes = maxReviewerSignatureOutputLineBytes,
  initialByteOffset = 0,
}) {
  if (reviewerFamily !== "claude" || stream !== "stdout") {
    return createBoundedLineAccumulator({ onLine, onOverflow, maxBytes: genericMaxBytes });
  }

  let chunks = [];
  let byteLength = 0;
  let thinkingCandidateClass = null;
  let overflowed = false;
  let streamByteOffset = initialByteOffset;
  let lineStartByteOffset = initialByteOffset;

  function latchOverflow(maxBytes, diagnostic = {}) {
    chunks = [];
    byteLength = 0;
    thinkingCandidateClass = null;
    overflowed = true;
    onOverflow({ maxBytes, ...diagnostic });
  }

  function boundedPrefixWith(segment) {
    const remaining = Math.max(0, genericMaxBytes - byteLength);
    const prefixChunks = remaining === 0
      ? chunks
      : [...chunks, segment.subarray(0, remaining)];
    return Buffer.concat(prefixChunks, Math.min(genericMaxBytes, byteLength + segment.length));
  }

  function activeBoundFor(candidateClass) {
    if (candidateClass === null) return genericMaxBytes;
    if (candidateClass === "stream_event_signature_delta") return signatureMaxBytes;
    return thinkingMaxBytes;
  }

  function appendSegment(segment) {
    if (overflowed || segment.length === 0) return;
    const nextByteLength = byteLength + segment.length;
    if (thinkingCandidateClass === null && nextByteLength > genericMaxBytes) {
      thinkingCandidateClass = classifyClaudeThinkingLinePrefix(boundedPrefixWith(segment));
      if (thinkingCandidateClass === null) {
        latchOverflow(genericMaxBytes);
        return;
      }
    }
    const activeMaxBytes = activeBoundFor(thinkingCandidateClass);
    if (nextByteLength > activeMaxBytes) {
      latchOverflow(activeMaxBytes);
      return;
    }
    chunks.push(Buffer.from(segment));
    byteLength = nextByteLength;
  }

  function emitLine(lineEndByteOffset) {
    if (overflowed) return;
    const line = chunks.length === 0
      ? ""
      : Buffer.concat(chunks, byteLength).toString("utf8");
    const completedByteLength = byteLength;
    chunks = [];
    byteLength = 0;
    if (thinkingCandidateClass === null) {
      onLine(line);
      return;
    }
    const eventClass = classifyStrictClaudeThinkingLine(line);
    if (eventClass === null || eventClass !== thinkingCandidateClass) {
      // A prefix candidate gets the larger cap only after strict full-line closure.
      // Rejection revokes that exception; it did not exceed the thinking hard cap.
      latchOverflow(genericMaxBytes, {
        byteLength: completedByteLength,
        classificationReason: "strict_thinking_shape_rejected",
      });
      return;
    }
    thinkingCandidateClass = null;
    onDiscard({
      event_class: eventClass,
      byte_length: completedByteLength,
      hard_cap_bytes: activeBoundFor(eventClass),
    }, {
      start_byte: lineStartByteOffset,
      end_byte: lineEndByteOffset,
    });
  }

  return Object.freeze({
    write(chunk) {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const writeStartByteOffset = streamByteOffset;
      let start = 0;
      while (start < buffer.length && !overflowed) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline < 0) {
          appendSegment(buffer.subarray(start));
          break;
        }
        appendSegment(buffer.subarray(start, newline));
        const lineEndByteOffset = writeStartByteOffset + newline;
        emitLine(lineEndByteOffset);
        lineStartByteOffset = lineEndByteOffset + 1;
        start = newline + 1;
      }
      streamByteOffset += buffer.length;
    },
    end() {
      if (overflowed) return;
      if (byteLength > 0) emitLine(streamByteOffset);
    },
  });
}

// Deliberately narrow test seam for exact byte-boundary and fragmented UTF-8 tests.
export const __testReviewerOutput = Object.freeze({
  createBoundedLineAccumulator,
  createReviewerOutputLineRouter,
  classifyClaudeThinkingLinePrefix,
  classifyStrictClaudeThinkingLine,
  maxLineBytes: maxReviewerOutputLineBytes,
  maxThinkingLineBytes: maxReviewerThinkingOutputLineBytes,
  maxSignatureLineBytes: maxReviewerSignatureOutputLineBytes,
});

// Reviewer-private isolated temp root. The reviewer CLI runs exploratory shell
// (e.g. `find "$TMPDIR"`); on a shared host temp dir that scan can hit thousands of
// unrelated leftover entries and overflow a single bounded telemetry line, killing the
// reviewer with no verdict. Pointing the reviewer's TMPDIR at this fresh empty child of
// the renderer-owned neutral cwd isolates that scan from the shared host temp dir. It is
// removed together with the neutral cwd by the recursive cleanup in runProjection.
function reviewerIsolatedTmpdir(neutralCwdPath) {
  return path.join(neutralCwdPath, "reviewer-tmp");
}

// D7 (R7) — spawn env assembly extracted into a pure, platform-injectable function so a
// contract test can cover both branches without mocking the global `process.platform`
// (shape mirrors `fsyncDirectory(dir, { platform })` / `sanitizeCmuxDispatchEnv(env,
// { platform })`). On win32, TMPDIR/TEMP/TMP are all three overwritten to the isolated
// reviewer tmpdir (TEMP/TMP already exist in a real win32 process.env; this is a value
// override, not a new key). On every other platform the key set and values are exactly
// what the inline spawn() env object produced before this extraction.
function reviewerSpawnEnv(context, { platform = process.platform, baseEnv = process.env } = {}) {
  const isolatedTmpdir = reviewerIsolatedTmpdir(context.neutral_cwd_path);
  const env = {
    ...baseEnv,
    GH_REPO: context.repository_slug,
    [reviewerPrNumberEnv]: context.pr_number,
    [terminalReviewerMarker]: "1",
    TMPDIR: isolatedTmpdir,
  };
  if (platform === "win32") {
    env.TEMP = isolatedTmpdir;
    env.TMP = isolatedTmpdir;
  }
  // D3 steps 1-3/5 (T19-T22): CODEX_HOME is only ever set here — never added by default —
  // and only after context.reviewer_codex_home_path has been populated by a dispatch whose
  // isolated home passed step 3's per-dispatch verification (see
  // applyReviewerHomeCredentialContinuityGate below). A verification that did not pass
  // (step 5 degrade) leaves this field unset, so the key is absent entirely — this is an
  // exact key-set difference, not a value substitution (design.md D3 step 5 point 2).
  if (context.reviewer_cli_recipe?.tool === "codex" && typeof context.reviewer_codex_home_path === "string") {
    env.CODEX_HOME = context.reviewer_codex_home_path;
  }
  // OpenCode never reads project or ambient config: the trusted launch file the runner
  // materialized from the validated context is the only configuration the review uses.
  if (context.reviewer_cli_recipe?.tool === "opencode") {
    return openCodeReviewerEnv({
      baseEnv: env,
      launchConfigPath: context.reviewer_opencode.launch_config_path,
      cwd: context.neutral_cwd_path,
    });
  }
  return env;
}

// Deliberately narrow test seam for the D7 platform-injected spawn env assembly.
export const __testReviewerSpawnEnv = Object.freeze({
  reviewerSpawnEnv,
});

function materializeNeutralCwd(context, reviewData) {
  const neutralCwd = validateRunnerContext(context, reviewData);
  try {
    mkdirSync(neutralCwd, { recursive: false, mode: 0o700 });
    mkdirSync(reviewerIsolatedTmpdir(neutralCwd), { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new ProjectionRunnerError(
      `Cannot materialize neutral reviewer cwd: ${error.message}`,
      "neutral_cwd_unavailable"
    );
  }
  return neutralCwd;
}

// D6 (R4; tasks.md T23-T24) — write-capability preflight. A write / read-back / delete
// round-trip against <neutralCwd>/reviewer-tmp (already created by materializeNeutralCwd
// above, via reviewerIsolatedTmpdir) that falsifies "the environment isn't writable"
// claims before the reviewer CLI ever spawns. Read-back is a byte-exact Buffer comparison,
// not merely "the write call didn't throw" — a filesystem proxy layer could swallow a
// write or misroute it, and a write-only check would pass that silently (design.md D6
// "為何要讀回比對而非只寫"). Any of write / read-back-mismatch / unlink failing is treated
// identically: there is no partial-success branch (design.md D6 "三步任一失敗（含比對不
// 符）即判失敗"). Unlink is always attempted, even after a content mismatch, because a
// leftover probe file would land in the reviewer's own working directory — an
// unacceptable side effect (design.md D6 "清理") — and unlink's own failure is itself a
// probe failure, not merely best-effort cleanup. The probe file name is bound to
// dispatch_id (already filesystem-legal per assertDispatchId's pattern, same precedent the
// committed `.reviewer-home.<pid>.<dispatch_id>` naming relies on) to avoid colliding with
// the reviewer's own files or a concurrent dispatch's probe. The token content is a fresh
// randomUUID() per probe — bounded length, no repo/PR/PII content (NFR-5).
function verifyReviewerWriteSurface({ neutralCwdPath, dispatchId, fsSeam = {} }) {
  const writeFileSyncFn = fsSeam.writeFileSync ?? writeFileSync;
  const readFileSyncFn = fsSeam.readFileSync ?? readFileSync;
  const unlinkSyncFn = fsSeam.unlinkSync ?? unlinkSync;
  const probePath = path.join(
    reviewerIsolatedTmpdir(neutralCwdPath),
    `.write-capability-probe.${dispatchId}`
  );
  const token = Buffer.from(randomUUID(), "utf8");
  let readBack;
  let writeOrReadFailed = false;
  try {
    writeFileSyncFn(probePath, token);
    readBack = readFileSyncFn(probePath);
  } catch {
    writeOrReadFailed = true;
  }
  // Unlink is always attempted, even after a write/read-back failure — matching the
  // module comment above ("Unlink is always attempted"), which a write/read early-return
  // used to silently violate, leaving a probe file behind on that path.
  let unlinkFailed = false;
  try {
    unlinkSyncFn(probePath);
  } catch {
    unlinkFailed = true;
  }
  if (writeOrReadFailed || unlinkFailed) {
    return { verified: false, classification: "reviewer_write_surface_unverified" };
  }
  if (!Buffer.isBuffer(readBack) || !readBack.equals(token)) {
    return { verified: false, classification: "reviewer_write_surface_unverified" };
  }
  return { verified: true, classification: "reviewer_write_surface_verified" };
}

// Deliberately narrow test seam for the D6 write-capability preflight (T23-T24).
export const __testWriteCapabilityProbe = Object.freeze({
  verifyReviewerWriteSurface,
});

// ---------------------------------------------------------------------------
// D3 step 0/4 (R6) — store-agnostic isolated reviewer-home skeleton (the credential
// continuity mechanism this supports clamps the Codex home-directory env var).
//
// This block implements only the store-agnostic mechanics of
// openspec/changes/fix-windows-cross-review-dispatch/design.md D3 steps 0 and 4: the
// path/naming/P-ID invariants, the closed creation-set guard, crash-consistent
// owner.json publication, ownership determination, the teardown fail-closed ladder, and
// ownership-based reclaim. The credential-store detection/store-resolution-parity/
// symlink-copy/verification/degrade orchestration (design.md D3 steps 1/2/3/5) is
// implemented in the next block below (T19-T22), which composes these primitives using
// the FR-B7 real-environment findings recorded in fr-b7-evidence.md (tasks.md T18).
// ---------------------------------------------------------------------------

const REVIEWER_HOME_PREFIX = ".reviewer-home.";
const REVIEWER_HOME_OWNER_FILE = "owner.json";
const REVIEWER_HOME_CONFIG_FILE = "config.toml";
const REVIEWER_HOME_AUTH_FILE = "auth.json";
// Fixed value (Q-E, provenance: TL, round 3) — deliberately distinct from
// CAPACITY_LOCK_OWNER_SCHEMA: the two owner records have different field sets and
// different reclaim thresholds, so sharing one schema string would let a malformed
// record from one mechanism validate against the other.
const REVIEWER_HOME_OWNER_SCHEMA = "devpro-second-review-reviewer-home-owner/v1";
const REVIEWER_HOME_UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Closed creation set (design.md D3 step 0, round 4/F-3-1, round 5/F-4-1): the only
// transient temp-name pattern the runner is ever allowed to create is the crash-consistent
// publication window for owner.json. config.toml and auth.json MUST be written straight to
// their final names (no temp->rename) — see step 0 in design.md for why.
const REVIEWER_HOME_OWNER_TEMP_PATTERN = new RegExp(
  `^\\.${REVIEWER_HOME_OWNER_FILE}\\.${REVIEWER_HOME_UUID_SOURCE}\\.tmp$`
);
const REVIEWER_HOME_CREATION_NAMES = new Set([
  REVIEWER_HOME_OWNER_FILE,
  REVIEWER_HOME_CONFIG_FILE,
  REVIEWER_HOME_AUTH_FILE,
]);
// NFR-5 "tool surface only shrinks" hard boundary (design.md D3 step 1, step 3 point 7):
// this MUST reject mcp_servers regardless of what an allowlist argument admits — the
// allowlist enforces "only these keys", this constant enforces "never this key".
const REVIEWER_HOME_CONFIG_TOML_FORBIDDEN_KEYS = Object.freeze(new Set(["mcp_servers"]));

// Bounded and small relative to the runner total hard cap (design.md D3 teardown ladder
// point 1): win32 EBUSY/EPERM from a just-exited CLI child releasing its handle is
// expected to clear within a few hundred ms, not minutes.
const REVIEWER_HOME_TEARDOWN_MAX_RETRIES = 5;
const REVIEWER_HOME_TEARDOWN_RETRY_DELAY_MS = 100;
// Second, non-safety-bearing guard (design.md D3 "oldEnough 門檻" — liveness is the
// safety-bearing gate; age only protects against a false-dead liveness read on a
// freshly-created home). Bounded, not user-configurable, added on top of
// totalTimeoutMs(context) so it never depends on a second hardcoded constant for "how
// long is a dispatch allowed to run".
const REVIEWER_HOME_RECLAIM_GRACE_MS = 60_000;

function reviewerHomeDirName(pid, dispatchId) {
  return `${REVIEWER_HOME_PREFIX}${pid}.${dispatchId}`;
}

function reviewerIsolatedHomePath(controlRoot, pid, dispatchId) {
  return path.join(path.resolve(controlRoot), reviewerHomeDirName(pid, dispatchId));
}

// Family naming grammar (design.md D3 step 0): the fixed prefix `.reviewer-home.`
// followed by the first dot-segment mechanically distinguishes active / quarantine /
// unrecognized. Unrecognized MUST NOT be touched by any consumer of this classifier.
function classifyReviewerHomeEntryName(name) {
  if (typeof name !== "string" || !name.startsWith(REVIEWER_HOME_PREFIX)) {
    return Object.freeze({ kind: "unrecognized" });
  }
  const rest = name.slice(REVIEWER_HOME_PREFIX.length);
  const dotIndex = rest.indexOf(".");
  const firstSegment = dotIndex < 0 ? rest : rest.slice(0, dotIndex);

  if (/^[1-9][0-9]*$/.test(firstSegment) && dotIndex > 0 && dotIndex < rest.length - 1) {
    // Active form: `.reviewer-home.<pid>.<dispatch_id>`. The pid is placed before the
    // (opaque, dot-tolerant) dispatch_id precisely so parsing isn't ambiguous when the
    // dispatch_id itself contains dots.
    return Object.freeze({
      kind: "active",
      pid: Number(firstSegment),
      dispatchId: rest.slice(dotIndex + 1),
    });
  }

  if (firstSegment === "recovery") {
    // Quarantine form: `.reviewer-home.recovery.<reclaimer_pid>.<uuid>`.
    const remainder = dotIndex < 0 ? "" : rest.slice(dotIndex + 1);
    const remainderDotIndex = remainder.indexOf(".");
    const pidSegment = remainderDotIndex < 0 ? remainder : remainder.slice(0, remainderDotIndex);
    const uuidSegment = remainderDotIndex < 0 ? "" : remainder.slice(remainderDotIndex + 1);
    if (/^[1-9][0-9]*$/.test(pidSegment) && uuidSegment.length > 0) {
      return Object.freeze({ kind: "quarantine", pid: Number(pidSegment), uuid: uuidSegment });
    }
    return Object.freeze({ kind: "unrecognized" });
  }

  return Object.freeze({ kind: "unrecognized" });
}

// Closed creation-set guard (design.md D3 step 0, F-2-1): the only entries the runner is
// ever permitted to create inside a reviewer isolated home. Every in-home write path in
// this block funnels its target basename through this guard. Execution-time entries
// Codex itself writes are explicitly NOT covered by this (F-2-1) — this only bounds what
// *this runner* creates.
function assertReviewerHomeCreationName(basename) {
  if (REVIEWER_HOME_CREATION_NAMES.has(basename)) return basename;
  if (REVIEWER_HOME_OWNER_TEMP_PATTERN.test(basename)) return basename;
  throw new ProjectionRunnerError(
    `reviewer isolated home creation name "${basename}" is outside the closed creation set`,
    "reviewer_home_creation_name_rejected"
  );
}

// config.toml MUST be built by allowlist, not copy-then-strip (design.md D3 step 1). The
// allowlist itself is supplied by the caller (populated with FR-B7-derived keys at T19,
// out of this block's scope) — this function only enforces the two hard rules: never
// mcp_servers (or any other forbidden tool-surface key), and never a key outside the
// caller's allowlist.
function assertReviewerHomeConfigTomlKeyAllowed(key, allowlist) {
  if (REVIEWER_HOME_CONFIG_TOML_FORBIDDEN_KEYS.has(key)) {
    throw new ProjectionRunnerError(
      `reviewer isolated home config.toml MUST NOT contain tool-surface key "${key}"`,
      "reviewer_home_config_toml_key_rejected"
    );
  }
  if (!Array.isArray(allowlist) || !allowlist.includes(key)) {
    throw new ProjectionRunnerError(
      `reviewer isolated home config.toml key "${key}" is not on the allowlist`,
      "reviewer_home_config_toml_key_rejected"
    );
  }
  return key;
}

// Canonical bytes mirror second-review-control-evidence.mjs's canonicalBytes() shape
// (JSON.stringify + trailing newline, object literal field order is the canonical order)
// so "not canonical" is machine-checkable the same way capacity-lock owner records are.
function canonicalReviewerHomeOwnerBytes(owner) {
  return Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
}

// Mirrors the capacity-lock owner precedent (assertCapacityLockOwner's exact sorted
// key-set comparison): an owner.json carrying extra/injected keys must not validate just
// because canonicalReviewerHomeOwnerBytes() happens to round-trip whatever key set is on
// disk. This makes "any non-canonical content is mechanically invalid" literally true,
// not merely true for the fields this check happens to read.
const REVIEWER_HOME_OWNER_EXPECTED_KEYS = ["schema", "owner_pid", "owner_token", "created_at", "home_dev", "home_ino"];

function isPlainReviewerHomeOwnerShape(owner) {
  return owner !== null
    && typeof owner === "object"
    && !Array.isArray(owner)
    && (() => {
      const keys = Object.keys(owner).sort();
      const expected = [...REVIEWER_HOME_OWNER_EXPECTED_KEYS].sort();
      return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
    })()
    && owner.schema === REVIEWER_HOME_OWNER_SCHEMA
    && Number.isSafeInteger(owner.owner_pid) && owner.owner_pid > 0
    && typeof owner.owner_token === "string" && /^[a-f0-9-]{36}$/.test(owner.owner_token)
    && typeof owner.created_at === "string" && !Number.isNaN(Date.parse(owner.created_at))
    && new Date(owner.created_at).toISOString() === owner.created_at
    && Number.isFinite(owner.home_dev)
    && Number.isFinite(owner.home_ino);
}

// `owner.json` crash-consistent publication (design.md D3 step 0/F-2-2): temp name ->
// fsyncSync -> closeSync -> renameSync -> fsyncDirectory, in that exact order, entirely
// before any credential-continuity file (T19/T20, out of this block's scope) may be
// created. Every fs primitive is DI-overridable via `fsSeam` (mirrors the
// `{ platform }` injection shape used elsewhere in this repo) so a contract test can
// observe call order and inject failures without mocking node:fs globally.
function publishReviewerHomeOwner(dir, owner, { fsSeam = {} } = {}) {
  const openSyncFn = fsSeam.openSync ?? openSync;
  const writeFileSyncFn = fsSeam.writeFileSync ?? writeFileSync;
  const fsyncSyncFn = fsSeam.fsyncSync ?? fsyncSync;
  const closeSyncFn = fsSeam.closeSync ?? closeSync;
  const renameSyncFn = fsSeam.renameSync ?? renameSync;
  const fsyncDirectoryFn = fsSeam.fsyncDirectory ?? fsyncDirectory;

  const tempName = `.${REVIEWER_HOME_OWNER_FILE}.${randomUUID()}.tmp`;
  assertReviewerHomeCreationName(tempName);
  assertReviewerHomeCreationName(REVIEWER_HOME_OWNER_FILE);
  const tempPath = path.join(dir, tempName);
  const finalPath = path.join(dir, REVIEWER_HOME_OWNER_FILE);
  const bytes = canonicalReviewerHomeOwnerBytes(owner);

  let fd;
  try {
    fd = openSyncFn(tempPath, "wx", 0o600);
    writeFileSyncFn(fd, bytes);
    fsyncSyncFn(fd);
    closeSyncFn(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) closeSyncFn(fd);
  }
  renameSyncFn(tempPath, finalPath);
  fsyncDirectoryFn(dir);
  return { tempPath, finalPath };
}

// D3 step 0 (P-ID invariant, F-3-2): mkdirSync the isolated home under the runner's own
// pid at mkdirSync time, then immediately publish a crash-consistent owner.json (F-2-2)
// carrying the dev/ino binding — all of it before any credential-continuity file may
// exist (`afterOwnerPublished`, when supplied, models that later step for ordering
// tests; production callers of this block's T19/T20 successor pass their own).
function createReviewerIsolatedHome({
  controlRoot,
  pid,
  dispatchId,
  createdAt = new Date().toISOString(),
  fsSeam = {},
  afterOwnerPublished,
} = {}) {
  const mkdirSyncFn = fsSeam.mkdirSync ?? mkdirSync;
  const lstatSyncFn = fsSeam.lstatSync ?? lstatSync;

  const dir = reviewerIsolatedHomePath(controlRoot, pid, dispatchId);
  mkdirSyncFn(dir, { mode: 0o700 });
  const stat = lstatSyncFn(dir);
  const owner = {
    schema: REVIEWER_HOME_OWNER_SCHEMA,
    owner_pid: pid,
    owner_token: randomUUID(),
    created_at: createdAt,
    home_dev: stat.dev,
    home_ino: stat.ino,
  };
  publishReviewerHomeOwner(dir, owner, { fsSeam });
  if (typeof afterOwnerPublished === "function") afterOwnerPublished(dir, owner);
  return { dir, owner, stat };
}

function readReviewerHomeOwner(dir, deps = {}) {
  const existsSyncFn = deps.existsSync ?? existsSync;
  const readFileSyncFn = deps.readFileSync ?? readFileSync;
  const ownerPath = path.join(dir, REVIEWER_HOME_OWNER_FILE);
  if (!existsSyncFn(ownerPath)) return null;
  let bytes;
  try {
    bytes = readFileSyncFn(ownerPath);
  } catch {
    return null;
  }
  let owner;
  try {
    owner = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainReviewerHomeOwnerShape(owner)) return null;
  if (!canonicalReviewerHomeOwnerBytes(owner).equals(bytes)) return null;
  return owner;
}

// Ownership determination (design.md D3 step 0 〈ownership 身分〉/ step 4): the three
// mechanically-checkable criteria — name pattern, parent is controlEvidenceRoot(), and
// lstat proves a real directory (not a symlink-to-dir). This is deliberately independent
// of liveness/age: it only answers "is this ours to act on at all".
function reviewerHomeOwnership(controlRoot, name, deps = {}) {
  const lstatSyncFn = deps.lstatSync ?? lstatSync;
  const classification = classifyReviewerHomeEntryName(name);
  if (classification.kind === "unrecognized") {
    return { owned: false, reason: "unrecognized_name", classification };
  }
  const resolvedRoot = path.resolve(controlRoot);
  const candidatePath = path.join(resolvedRoot, name);
  let stat;
  try {
    stat = lstatSyncFn(candidatePath);
  } catch {
    return { owned: false, reason: "lstat_failed", classification };
  }
  if (path.dirname(candidatePath) !== resolvedRoot) {
    return { owned: false, reason: "parent_mismatch", classification };
  }
  if (!stat.isDirectory()) {
    return { owned: false, reason: "not_a_real_directory", classification };
  }
  return { owned: true, classification, stat };
}

// Teardown fail-closed ladder — single source of truth (design.md D3 step 4 〈teardown 失
// 敗階梯〉, round 7/F-6-1): bounded retry, then one rule with no branches. `scope: "own"`
// is THIS dispatch's own isolated home — retry exhaustion always fails closed and is
// reported, unconditionally (no credential-store-type / symlink-vs-copy / path-state /
// tree-content branch). `scope: "other"` is another dispatch's residue — retry
// exhaustion always skips and never blocks.
function teardownReviewerHome({ dir, root, scope, deps = {} }) {
  const rmSyncFn = deps.rmSync ?? rmSync;
  const fsyncDirectoryFn = deps.fsyncDirectory ?? fsyncDirectory;
  try {
    rmSyncFn(dir, {
      recursive: true,
      force: true,
      maxRetries: REVIEWER_HOME_TEARDOWN_MAX_RETRIES,
      retryDelay: REVIEWER_HOME_TEARDOWN_RETRY_DELAY_MS,
    });
  } catch (error) {
    if (scope === "own") {
      return { outcome: "fail_closed", reason: "reviewer_home_teardown_retry_exhausted", error };
    }
    return { outcome: "skip", reason: "reviewer_home_teardown_retry_exhausted_other", error };
  }
  try {
    fsyncDirectoryFn(root);
  } catch {
    // Best-effort durability confirmation only — the content removal above already
    // succeeded. This call site sits at the top of runProjection's finally block
    // (before neutral cwd cleanup and releaseAttemptOwnership), so an uncaught throw
    // here would leak both; matching the rmSyncFn try/catch above, a failure here MUST
    // NOT escape and MUST NOT downgrade an already-successful removal to fail_closed.
  }
  return { outcome: "removed" };
}

// `oldEnough` MUST be derived from the runner total hard cap, not a second hardcoded
// constant (design.md D3 step 4, self-check #10). Liveness is the safety-bearing gate;
// age is a second, non-load-bearing guard on top of it.
function reviewerHomeOldEnoughMs(context) {
  return totalTimeoutMs(context) + REVIEWER_HOME_RECLAIM_GRACE_MS;
}

// Reclaim criteria (design.md D3 step 4, round 4/F-3-2): a single safety condition,
// `oldEnough && !alive(responsible pid)`, applied uniformly across all three states —
// (1) a valid owner, (2) no valid owner (responsible pid comes from the directory name
// itself, per the P-ID invariant), (3) already-quarantined (responsible pid is the
// reclaimer's own pid). No branch may authorize reclaim by age alone.
function reviewerHomeReclaimDecision({ name, controlRoot, now = Date.now(), oldEnoughMs, deps = {} }) {
  const isAliveFn = deps.isAlive ?? capacityLockOwnerIsAlive;
  const resolvedRoot = path.resolve(controlRoot);

  // T13's ownership determination (name pattern / parent-directory / lstat-confirmed-
  // real-directory) is the single source of truth for "is this candidate a reviewer-home
  // this mechanism owns" — reused here rather than re-implemented, so scavenging can never
  // drift from the dedicated ownership check (self-check #10).
  const ownership = reviewerHomeOwnership(resolvedRoot, name, deps);
  if (!ownership.owned) {
    return { action: "skip", reason: ownership.reason, classification: ownership.classification };
  }
  const { classification, stat } = ownership;
  const candidatePath = path.join(resolvedRoot, name);

  if (classification.kind === "quarantine") {
    // Judgment 3: responsible pid is the reclaimer that rename-to-quarantined it, not
    // the original creator. A live reclaimer means another process is already tearing
    // this candidate down; do not race it.
    if (isAliveFn(classification.pid)) {
      return { action: "skip", reason: "quarantine_reclaimer_alive", classification };
    }
    const owner = readReviewerHomeOwner(candidatePath, deps);
    const ageMs = now - (owner ? Date.parse(owner.created_at) : stat.mtimeMs);
    if (!(ageMs > oldEnoughMs)) {
      return { action: "skip", reason: "not_old_enough", classification };
    }
    return { action: "reclaim", classification, stat, responsiblePid: classification.pid };
  }

  // Active form.
  const owner = readReviewerHomeOwner(candidatePath, deps);
  if (owner) {
    // dev/ino binding (hardening item, not the identity primary): a mismatch means the
    // owner record was moved/copied elsewhere. Neither delete nor block — just skip.
    if (owner.home_dev !== stat.dev || owner.home_ino !== stat.ino) {
      return { action: "skip", reason: "dev_ino_mismatch", classification };
    }
    const namePid = classification.pid;
    // Judgment 1 (round 4): a name-pid/owner-pid mismatch is treated monotonically
    // conservatively — either being alive counts as alive.
    const responsiblePids = namePid === owner.owner_pid ? [namePid] : [namePid, owner.owner_pid];
    if (responsiblePids.some((pid) => isAliveFn(pid))) {
      return { action: "skip", reason: "creator_alive", classification };
    }
    const ageMs = now - Date.parse(owner.created_at);
    if (!(ageMs > oldEnoughMs)) {
      return { action: "skip", reason: "not_old_enough", classification };
    }
    return { action: "reclaim", classification, stat, responsiblePid: namePid };
  }

  // Judgment 2 (round 4/F-3-2): no valid owner does NOT mean "no pid to check" — the
  // P-ID invariant means the responsible pid is always available from the directory
  // name itself, published atomically with mkdirSync. "No valid owner" MUST NOT be
  // treated as sufficient for reclaim by age alone.
  const namePid = classification.pid;
  if (isAliveFn(namePid)) {
    return { action: "skip", reason: "creator_alive", classification };
  }
  const ageMs = now - stat.mtimeMs;
  if (!(ageMs > oldEnoughMs)) {
    return { action: "skip", reason: "not_old_enough", classification };
  }
  return { action: "reclaim", classification, stat, responsiblePid: namePid };
}

// Reclaim procedure (design.md D3 step 4 〈回收程序〉): rename-to-quarantine ->
// TOCTOU guard (re-verify dev/ino after the rename, before deleting) -> teardown ladder
// -> fsyncDirectory. A candidate already in quarantine form (judgment 3) skips straight
// to teardown — it was already isolated by an earlier pass.
function reclaimReviewerHomeCandidate({ controlRoot, name, decision, deps = {} }) {
  const renameSyncFn = deps.renameSync ?? renameSync;
  const lstatSyncFn = deps.lstatSync ?? lstatSync;
  const existsSyncFn = deps.existsSync ?? existsSync;
  const fsyncDirectoryFn = deps.fsyncDirectory ?? fsyncDirectory;
  const resolvedRoot = path.resolve(controlRoot);
  const candidatePath = path.join(resolvedRoot, name);

  if (decision.classification.kind === "quarantine") {
    return teardownReviewerHome({ dir: candidatePath, root: resolvedRoot, scope: "other", deps });
  }

  const quarantineName = `${REVIEWER_HOME_PREFIX}recovery.${process.pid}.${randomUUID()}`;
  const quarantinePath = path.join(resolvedRoot, quarantineName);
  renameSyncFn(candidatePath, quarantinePath);
  fsyncDirectoryFn(resolvedRoot);

  const postRenameStat = lstatSyncFn(quarantinePath);
  if (postRenameStat.dev !== decision.stat.dev || postRenameStat.ino !== decision.stat.ino) {
    if (!existsSyncFn(candidatePath)) {
      renameSyncFn(quarantinePath, candidatePath);
      fsyncDirectoryFn(resolvedRoot);
    }
    return { outcome: "skip", reason: "reviewer_home_reclaim_toctou_mismatch" };
  }

  return teardownReviewerHome({ dir: quarantinePath, root: resolvedRoot, scope: "other", deps });
}

// Scan orchestrator (design.md D3 step 4): direct-child, non-recursive scan of
// `.reviewer-home.*` under controlRoot, bounded by the same-level capacity guard as
// existing dispatch-evidence scans (MAX_DISPATCHES_PER_REPOSITORY) so the scan itself
// cannot become unbounded work. A single candidate's ownership/liveness anomaly is
// always skip-and-continue (design.md 〈skip vs fail closed 邊界〉) — only the total
// count exceeding the bound fails closed.
function scavengeReviewerHomes({ controlRoot, context, now = Date.now(), deps = {} }) {
  const readdirSyncFn = deps.readdirSync ?? readdirSync;
  const resolvedRoot = path.resolve(controlRoot);
  let entries;
  try {
    entries = readdirSyncFn(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { scanned: 0, reclaimed: 0, results: [] };
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.name.startsWith(REVIEWER_HOME_PREFIX))
    .map((entry) => entry.name);
  if (candidates.length > MAX_DISPATCHES_PER_REPOSITORY) {
    throw new ProjectionRunnerError(
      `reviewer home scavenging scan exceeds the repository dispatch bound (${MAX_DISPATCHES_PER_REPOSITORY})`,
      "reviewer_home_scavenging_capacity_exceeded"
    );
  }

  const oldEnoughMs = reviewerHomeOldEnoughMs(context);
  const results = [];
  for (const name of candidates) {
    // Every abnormal single entry MUST be skip-and-continue — the ONLY fail-closed
    // condition in this path is the candidate-count bound already enforced above (spec
    // "Another dispatch's residue is skipped and never blocks"). reclaimReviewerHomeCandidate
    // does real filesystem I/O (renameSync/fsyncDirectory/lstatSync) that a concurrent
    // dispatch racing the same control-evidence root (ENOENT) or an open Windows handle
    // (EPERM/EACCES) can make throw; without this try/catch a single such candidate would
    // both abort the scan (leaving every later candidate this pass unreclaimed) and
    // propagate out of the gate, permanently blocking cross-review on this host every time
    // it re-encounters the same residue — exactly what the spec forbids.
    try {
      const decision = reviewerHomeReclaimDecision({ name, controlRoot: resolvedRoot, now, oldEnoughMs, deps });
      if (decision.action === "skip") {
        results.push({ name, outcome: "skip", reason: decision.reason });
        continue;
      }
      const outcome = reclaimReviewerHomeCandidate({ controlRoot: resolvedRoot, name, decision, deps });
      results.push({ name, ...outcome });
    } catch {
      results.push({ name, outcome: "skip", reason: "reviewer_home_reclaim_io_error" });
    }
  }
  return {
    scanned: candidates.length,
    reclaimed: results.filter((result) => result.outcome === "removed").length,
    results,
  };
}

// Deliberately narrow test seam for the D3 step 0/4 store-agnostic reviewer-home
// skeleton (T9-T17). Wired into the dispatch pipeline by
// applyReviewerHomeCredentialContinuityGate (T19-T22, below).
export const __testReviewerHome = Object.freeze({
  REVIEWER_HOME_OWNER_SCHEMA,
  REVIEWER_HOME_TEARDOWN_MAX_RETRIES,
  REVIEWER_HOME_TEARDOWN_RETRY_DELAY_MS,
  assertReviewerHomeConfigTomlKeyAllowed,
  assertReviewerHomeCreationName,
  classifyReviewerHomeEntryName,
  createReviewerIsolatedHome,
  publishReviewerHomeOwner,
  readReviewerHomeOwner,
  reclaimReviewerHomeCandidate,
  reviewerHomeDirName,
  reviewerHomeOldEnoughMs,
  reviewerHomeOwnership,
  reviewerHomeReclaimDecision,
  reviewerIsolatedHomePath,
  scavengeReviewerHomes,
  teardownReviewerHome,
});

// ---------------------------------------------------------------------------
// D3 steps 1/2/3/5 (R6; tasks.md T19-T22) — the credential continuity gate. This block
// composes the store-agnostic step 0/4 primitives above into the per-dispatch sequence:
// detect (step 1) -> build config.toml + an optional auth.json continuation file (steps
// 1/2) -> verify against the isolated home (step 3) -> either hand back a
// verification-passed home (caller injects CODEX_HOME) or degrade (step 5: tear down,
// inject nothing, record one non-terminal diagnostic). Only meaningful when
// context.reviewer_cli_recipe.tool === "codex" — the Claude path never reads CODEX_HOME
// (design.md D3 〈條件化〉); callers gate the call itself on that condition rather than this
// block gating internally, mirroring the existing tool===codex conditionals elsewhere in
// this file.
//
// Findings this block relies on (fr-b7-evidence.md, tasks.md T18 — read before changing
// anything here):
//   1. Credential store observed on the FR-B7 host = `file`; there is NO config.toml key
//      that selects it on the tested codex-cli version (confirmed by a control-comparison
//      rejection test, not a single-sample absence).
//   2. Therefore store-resolution parity (design.md D3 step 1's second product) is
//      satisfied by projecting NOTHING — an isolated home's config.toml naturally
//      resolves to the same store as the default home with zero projection. This is NOT a
//      placeholder for a future key; design.md D3 step 1 explicitly requires taking this
//      branch when FR-B7 proves it ("若...已成立則不加投影"). CAVEAT (fr-b7-evidence.md
//      §驗證覆蓋率的誠實揭露): FR-B7's zero-projection parity was only empirically observed
//      for the `file_backed_present` store on the FR-B7 host; it is inferred, not independently
//      confirmed, for a `keyring`/`not_file_backed` default home — this block's logic
//      applies uniformly to both because finding 1 (no config.toml key selects the store
//      at all) makes the store choice independent of what this block writes, but that
//      inference has not been exercised against a real keyring-backed host.
//   3. symlink-first was empirically confirmed viable and chosen as the terminal
//      mechanism; "fallback" means falling back to copy when symlinkSync itself throws
//      (e.g. win32 without Developer Mode/elevation), not a second decision point later.
// ---------------------------------------------------------------------------

// Default (non-isolated) CODEX_HOME resolution (T19). Mirrors Codex's own env-first
// resolution rule rather than hardcoding `~/.codex` (self-check #10): fr-b7-evidence.md §1
// reports `codex doctor --json`'s "auth file" equal to `<CODEX_HOME>/auth.json` under both
// an explicit CODEX_HOME override and the real default home.
function defaultReviewerCodexHome(env = process.env, deps = {}) {
  const homedirFn = deps.homedir ?? homedir;
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homedirFn(), ".codex");
}

// D3 step 1 (T19): credential-store detection. Two inputs per design.md: (i) whether
// `<default CODEX_HOME>/auth.json` is a regular file; (ii) a Codex-reported credential-
// store value token. Per fr-b7-evidence.md §2, (ii) has NO real source on the tested CLI
// version (no credential_store config key exists to read) — `storeToken` is therefore a
// deliberately injectable-only parameter with no production caller ever supplying a
// non-undefined value; it exists so this classifier can still express all four design.md
// tokens via synthetic fixtures (this task's explicit instruction), even though only two
// (`file_backed_present` / `auth_material_absent`) are reachable with a real fixture on
// this host. This detection is NOT a capability proof (spec :324) — it only decides
// whether to attempt building a continuation file (step 2); pass/fail is exclusively step
// 3's job.
function detectReviewerHomeCredentialStore({ defaultCodexHome, storeToken, deps = {} } = {}) {
  const lstatSyncFn = deps.lstatSync ?? lstatSync;
  let authIsRegularFile = false;
  try {
    authIsRegularFile = lstatSyncFn(path.join(defaultCodexHome, REVIEWER_HOME_AUTH_FILE)).isFile();
  } catch {
    authIsRegularFile = false;
  }
  if (authIsRegularFile) {
    return {
      token: storeToken === undefined || storeToken === "file"
        ? "file_backed_present"
        : "store_unknown_with_material",
    };
  }
  return { token: storeToken === "keyring" ? "not_file_backed" : "auth_material_absent" };
}

// D3 step 1's second product — store-resolution parity (T19). Empty by construction (see
// block comment above, finding 2) — not a placeholder. Callers pass no entries today;
// the allowlist machinery from T11 (assertReviewerHomeConfigTomlKeyAllowed) still governs
// this so a future entry cannot be added without going through the same fail-closed
// unknown-key / never-mcp_servers guard the isolated home's other keys would.
const REVIEWER_HOME_CONFIG_TOML_ALLOWLIST = Object.freeze([]);

function reviewerHomeConfigTomlBytes(entries = []) {
  for (const [key] of entries) {
    assertReviewerHomeConfigTomlKeyAllowed(key, REVIEWER_HOME_CONFIG_TOML_ALLOWLIST);
  }
  return Buffer.from(
    entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(""),
    "utf8"
  );
}

// config.toml is written straight to its final name (design.md D3 step 0 creation
// manifest: only owner.json's crash-consistent publication uses temp->rename) — it does
// not carry credentials, so a truncated file simply fails step 3 verification.
function writeReviewerHomeConfigToml(dir, entries = [], { fsSeam = {} } = {}) {
  const writeFileSyncFn = fsSeam.writeFileSync ?? writeFileSync;
  assertReviewerHomeCreationName(REVIEWER_HOME_CONFIG_FILE);
  writeFileSyncFn(path.join(dir, REVIEWER_HOME_CONFIG_FILE), reviewerHomeConfigTomlBytes(entries));
}

// D3 step 2 copy fallback (T20): auth.json is written directly to its final name via
// openSync(..., "wx", 0o600) — deliberately NOT a temp-name-then-rename publication.
// design.md D3 step 0's creation manifest is explicit and reaffirmed unchanged through
// round 7: a truncated/half-formed continuation file only causes step 3 verification to
// fail, which routes to the already-decided step 5 degrade — it is not a safety event the
// way owner.json's crash-consistent publication is (F-2-2 is specific to owner.json; see
// createReviewerIsolatedHome/publishReviewerHomeOwner above).
function copyReviewerHomeAuthJsonCredential({ from, to, fsSeam = {} }) {
  const readFileSyncFn = fsSeam.readFileSync ?? readFileSync;
  const openSyncFn = fsSeam.openSync ?? openSync;
  const writeFileSyncFn = fsSeam.writeFileSync ?? writeFileSync;
  const closeSyncFn = fsSeam.closeSync ?? closeSync;
  const bytes = readFileSyncFn(from);
  let fd;
  try {
    fd = openSyncFn(to, "wx", 0o600);
    writeFileSyncFn(fd, bytes);
    closeSyncFn(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) closeSyncFn(fd);
  }
}

// D3 step 2 (T20): symlink-first, copy fallback. Both branches target the final
// `auth.json` name directly (see copyReviewerHomeAuthJsonCredential above for why).
// Neither branch failing is a fail-closed point of the gate (design.md D3: only step 3
// verification and the teardown ladder are) — a continuity file that could not be built
// simply leaves the isolated home without auth material, which step 3 verification fails
// naturally, routing to step 5 degrade. Errors are deliberately swallowed rather than
// rethrown: a raw fs error's .message may carry the default-home path, which MUST NOT
// reach any output surface (`:62` path-bearing discipline).
function createReviewerHomeCredentialContinuity({ dir, defaultAuthJsonPath, fsSeam = {} }) {
  assertReviewerHomeCreationName(REVIEWER_HOME_AUTH_FILE);
  const symlinkSyncFn = fsSeam.symlinkSync ?? symlinkSync;
  const finalPath = path.join(dir, REVIEWER_HOME_AUTH_FILE);
  try {
    symlinkSyncFn(defaultAuthJsonPath, finalPath);
    return { method: "symlink" };
  } catch {
    // Symlink unavailable (e.g. win32 without Developer Mode/elevation, design.md D3 step
    // 2 〈平台落差〉) — fall back to copy.
  }
  try {
    copyReviewerHomeAuthJsonCredential({ from: defaultAuthJsonPath, to: finalPath, fsSeam });
    return { method: "copy" };
  } catch {
    return { method: "none" };
  }
}

// D3 step 3 (T21) — the named step `isolated_home_credential_verification`. Reuses the
// exported runProbeCommand (probe-second-reviewer-cli-recipe.mjs) with the SAME command
// carrier and bounds as the recipe's canonical auth_preflight; the only env difference
// from the canonical preflight is CODEX_HOME (design.md D3 step 3 point 3: "不得有第二處
// 差異"). evaluateAuthPreflight() in probe-second-reviewer-cli-recipe.mjs is
// module-private — this deliberately mirrors only the exit_zero verdict logic its
// caller's recipe (Codex) actually uses, not Claude's json_logged_in_true branch, since
// this step only ever runs for tool === "codex" (design.md 〈條件化〉). Raw stdout/stderr
// are read only to compute the returned booleans and are never persisted or returned
// (`raw_output_policy: "memory-only-do-not-persist"`).
function isolatedHomeCredentialVerificationResult({ context, isolatedHomePath, deps = {} } = {}) {
  const runCommandFn = deps.runCommand ?? runProbeCommand;
  const authPreflight = context?.reviewer_cli_recipe?.auth_preflight ?? {};
  const baseEnv = deps.baseEnv ?? process.env;
  const result = runCommandFn(authPreflight.command, {
    env: { ...baseEnv, CODEX_HOME: isolatedHomePath },
    timeoutMs: authPreflight.timeout_ms,
    maxBufferBytes: authPreflight.max_output_bytes,
  });
  const maxOutputBytes = authPreflight.max_output_bytes;
  const stdoutBytes = Buffer.byteLength(result.stdout ?? "", "utf8");
  const stderrBytes = Buffer.byteLength(result.stderr ?? "", "utf8");
  const timedOut = result.error_code === "ETIMEDOUT";
  const outputOverflowed = result.error_code === "ENOBUFS"
    || (Number.isFinite(maxOutputBytes)
      && (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes || stdoutBytes + stderrBytes > maxOutputBytes));
  const verified = result.status === 0 && !result.error && !timedOut && !outputOverflowed;
  return {
    verified,
    // Deliberately distinct from "reviewer_host_surface_unverified" (design.md D3 step 3
    // point 5) — this is a renderer-owned isolated-home fault, not a host-capability fault
    // canonical auth_preflight already cleared.
    classification: verified
      ? "isolated_home_credential_verified"
      : "isolated_home_credential_verification_failed",
    timed_out: timedOut,
    output_overflowed: outputOverflowed,
  };
}

// D3 steps 1-3/5 orchestrator (T19-T22). Builds the isolated home (step 0/4 primitives
// above), attempts a continuation file (steps 1/2), and verifies it (step 3). On success
// returns `{ applied: true, isolatedHomePath, controlRoot }` — the isolated home is left
// on disk for the caller to spawn the reviewer against and tear down at dispatch end
// (design.md D3 gate invariant: "隔離 home 整體生命週期綁 dispatch，正常路徑於 dispatch 結
// 束時以步驟 4 的同一 ownership teardown 移除"). On a step 3 verification that does not
// pass, this function itself performs the step 5 degrade — same ownership teardown ladder,
// no CODEX_HOME to inject, one non-terminal `codex_home_clamp_not_applied` diagnostic —
// and returns `{ applied: false }`; the caller injects nothing and proceeds unclamped.
//
// A teardown retry-exhaustion during degrade is itself the ladder's own-scope fail-closed
// case (design.md D3 teardown ladder point 2/3) — this throws a ProjectionRunnerError so
// it surfaces through runProjection's existing catch-all exactly like
// materializeNeutralCwd()'s neutral_cwd_unavailable does, rather than inventing a second
// error-propagation shape.
function applyReviewerHomeCredentialContinuityGate(context, options = {}) {
  const deps = options.deps ?? {};
  const controlRoot = deps.controlRoot ?? evidenceRootForContext(context);
  const defaultCodexHome = deps.defaultCodexHome ?? defaultReviewerCodexHome(deps.env, deps);
  const fsSeam = deps.fsSeam ?? {};
  const teardownDeps = deps.teardownDeps ?? {};

  // Residue scavenging (design.md D3 step 4 / spec "Residue scavenging runs before this
  // dispatch creates its own isolated home") MUST run before this dispatch creates its own
  // home — this is the ONLY production call site of scavengeReviewerHomes; without it the
  // whole reclaim mechanism is dead code and RD8's "copy-fallback residue gets reclaimed by
  // scavenging" mitigation does not exist. Bounded/skip-not-block: scavengeReviewerHomes
  // itself catches every per-candidate anomaly (including filesystem I/O errors on the
  // reclaim path) and only fails closed on the total-candidate-count bound, so a single
  // anomalous or racing candidate here MUST NOT block this dispatch from proceeding to
  // create its own home.
  const scavenge = scavengeReviewerHomes({ controlRoot, context, deps: teardownDeps });
  appendActivity(context, "reviewer_home_scavenge_completed", {
    scanned: scavenge.scanned,
    reclaimed: scavenge.reclaimed,
    skip_reasons: scavenge.results
      .filter((result) => result.outcome === "skip")
      .map((result) => result.reason),
  });

  // `dir` is computed the same deterministic way createReviewerIsolatedHome computes it
  // internally, rather than only being learned from that call's return value — home
  // creation can throw after mkdirSync/publishReviewerHomeOwner already succeeded (e.g. the
  // afterOwnerPublished callback's config.toml write or credential-store detection throws),
  // and a caller that only learns `dir` from a completed return would leak that already-
  // created, possibly credential-bearing home with no reference left to tear it down.
  const dir = reviewerIsolatedHomePath(controlRoot, process.pid, context.dispatch_id);
  let detection = null;
  let verification;
  try {
    createReviewerIsolatedHome({
      controlRoot,
      pid: process.pid,
      dispatchId: context.dispatch_id,
      fsSeam,
      afterOwnerPublished: (homeDir) => {
        writeReviewerHomeConfigToml(homeDir, [], { fsSeam });
        detection = detectReviewerHomeCredentialStore({
          defaultCodexHome,
          storeToken: deps.storeToken,
          deps: { lstatSync: fsSeam.lstatSync },
        });
        if (detection.token === "file_backed_present" || detection.token === "store_unknown_with_material") {
          createReviewerHomeCredentialContinuity({
            dir: homeDir,
            defaultAuthJsonPath: path.join(defaultCodexHome, REVIEWER_HOME_AUTH_FILE),
            fsSeam,
          });
        }
      },
    });

    verification = isolatedHomeCredentialVerificationResult({
      context,
      isolatedHomePath: dir,
      deps: { runCommand: deps.runCommand, baseEnv: deps.baseEnv },
    });
  } catch (error) {
    const teardown = teardownReviewerHome({ dir, root: controlRoot, scope: "own", deps: teardownDeps });
    if (teardown.outcome === "fail_closed") {
      throw new ProjectionRunnerError(
        "reviewer isolated home teardown failed after home setup raised an error",
        "reviewer_home_teardown_retry_exhausted"
      );
    }
    throw error;
  }

  if (verification.verified) {
    return { applied: true, isolatedHomePath: dir, controlRoot, detection, verification };
  }

  const teardown = teardownReviewerHome({ dir, root: controlRoot, scope: "own", deps: teardownDeps });
  if (teardown.outcome === "fail_closed") {
    throw new ProjectionRunnerError(
      "reviewer isolated home teardown failed after credential verification did not pass",
      "reviewer_home_teardown_retry_exhausted"
    );
  }
  appendActivity(context, "codex_home_clamp_not_applied", {
    reason_token: verification.classification,
    store_token: detection?.token ?? null,
  });
  return { applied: false, isolatedHomePath: null, controlRoot, detection, verification };
}

// Deliberately narrow test seam for the D3 steps 1/2/3/5 gate (T19-T22).
export const __testReviewerHomeGate = Object.freeze({
  applyReviewerHomeCredentialContinuityGate,
  copyReviewerHomeAuthJsonCredential,
  createReviewerHomeCredentialContinuity,
  defaultReviewerCodexHome,
  detectReviewerHomeCredentialStore,
  isolatedHomeCredentialVerificationResult,
  reviewerHomeConfigTomlBytes,
  writeReviewerHomeConfigToml,
});

function refreshHeartbeat(context, status, payload = {}) {
  if (!context?.heartbeat_path) return;
  writeJson(context.heartbeat_path, {
    status,
    attempt_id: context.attempt_id,
    generated_at: nowIso(),
    reviewer_surface: context.reviewer_surface,
    runner_owner: context.runner_owner,
    runner_script: runnerScript,
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

// D4 (R5; tasks.md T25-T26) — the single source of truth for the bounded-tail byte
// budget every stdout/stderr evidence read uses. Previously duplicated as two separate
// `65536` default-parameter literals (here and in readBoundedCompleteLineTail below);
// promoted to one named exported constant so R5's completeness precondition (truncation
// detection) and both readers share one fact instead of two hardcoded copies of the same
// number (AGENTS self-check #10). Distinct from `maxReviewerOutputLineBytes` (:114,
// `64 * 1024` — a different fact: the max size of a single reviewer output line, not the
// evidence tail read window).
export const BOUNDED_TAIL_EVIDENCE_MAX_BYTES = 65536;

function readBoundedTailEvidence(filePath, maxBytes = BOUNDED_TAIL_EVIDENCE_MAX_BYTES) {
  if (!filePath || !existsSync(filePath)) {
    return {
      completeText: "",
      partialText: "",
      partialSegments: [],
      truncated: false,
      // D2 (R1; fix-projection-completion-truncation): no archive at all is not a
      // truncation shape — a missing/empty file reports the neutral "closed" tail so
      // `deriveCompletionStreamEndShape` can name it `no_bytes` instead of guessing.
      endsWithNewline: true,
      trailingPartialBytes: 0,
    };
  }
  const size = statSync(filePath).size;
  // D4 point 1 (design.md): the whole event stream falls inside the read window iff the
  // file is no larger than what this read can cover; larger means truncated, and callers
  // MUST NOT treat a truncated read's absence of write-class evidence as proof of absence.
  const truncated = size > maxBytes;
  const length = Math.min(size, maxBytes);
  if (length <= 0) {
    return {
      completeText: "",
      partialText: "",
      partialSegments: [],
      truncated,
      endsWithNewline: true,
      trailingPartialBytes: 0,
    };
  }

  const start = size - length;
  const prefixLength = start > 0 ? 1 : 0;
  const absoluteBufferStart = start - prefixLength;
  const buffer = Buffer.alloc(length + prefixLength);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start - prefixLength);
  } finally {
    closeSync(fd);
  }

  // D2 (R1): the last byte of the bounded window IS the last byte of the archive, so
  // these two additive fields describe the file's tail without a second read: whether the
  // final line is LF-terminated, and how many trailing bytes the unterminated final
  // segment carries (0 when the tail is LF-terminated).
  const endsWithNewline = buffer[buffer.length - 1] === 0x0a;
  const trailingPartialBytes = endsWithNewline
    ? 0
    : buffer.length - Math.max(buffer.lastIndexOf(0x0a) + 1, prefixLength);

  let firstCompleteByte = prefixLength;
  let leadingPartial = "";
  let leadingPartialSegment = null;
  if (prefixLength > 0 && buffer[0] !== 0x0a) {
    const firstNewline = buffer.indexOf(0x0a, prefixLength);
    if (firstNewline < 0) {
      const partialText = buffer.subarray(prefixLength).toString("utf8");
      return {
        completeText: "",
        partialText,
        partialSegments: [{ text: partialText, start_byte: start, end_byte: size }],
        truncated,
        endsWithNewline,
        trailingPartialBytes,
      };
    }
    leadingPartial = buffer.subarray(prefixLength, firstNewline).toString("utf8");
    leadingPartialSegment = {
      text: leadingPartial,
      start_byte: start,
      end_byte: absoluteBufferStart + firstNewline,
    };
    firstCompleteByte = firstNewline + 1;
  }

  let endExclusive = buffer.length;
  let trailingPartial = "";
  let trailingPartialSegment = null;
  if (buffer.at(-1) !== 0x0a) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < firstCompleteByte) {
      const finalPartial = buffer.subarray(firstCompleteByte).toString("utf8");
      const partialSegments = [
        leadingPartialSegment,
        finalPartial === "" ? null : {
          text: finalPartial,
          start_byte: absoluteBufferStart + firstCompleteByte,
          end_byte: size,
        },
      ].filter(Boolean);
      return {
        completeText: "",
        partialText: partialSegments.map((segment) => segment.text).join("\n"),
        partialSegments,
        truncated,
        endsWithNewline,
        trailingPartialBytes,
      };
    }
    endExclusive = lastNewline + 1;
    trailingPartial = buffer.subarray(lastNewline + 1).toString("utf8");
    trailingPartialSegment = {
      text: trailingPartial,
      start_byte: absoluteBufferStart + lastNewline + 1,
      end_byte: size,
    };
  }
  const partialSegments = [leadingPartialSegment, trailingPartialSegment]
    .filter((segment) => segment !== null && segment.text !== "");
  return {
    completeText: buffer.subarray(firstCompleteByte, endExclusive).toString("utf8"),
    partialText: partialSegments.map((segment) => segment.text).join("\n"),
    partialSegments,
    truncated,
    endsWithNewline,
    trailingPartialBytes,
  };
}

function readBoundedCompleteLineTail(filePath, maxBytes = BOUNDED_TAIL_EVIDENCE_MAX_BYTES) {
  return readBoundedTailEvidence(filePath, maxBytes).completeText;
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function heartbeatIntervalMs(context) {
  const contextInterval = Number(context?.heartbeat_interval_seconds ?? 60) * 1000;
  return numericEnv(
    "DEVPRO_SECOND_REVIEW_RUNNER_HEARTBEAT_MS",
    Number.isFinite(contextInterval) && contextInterval > 0 ? contextInterval : 60000
  );
}

function defaultTotalTimeoutMsForTool(_tool) {
  return defaultTotalTimeoutMs;
}

function statusCheckpointMs() {
  return numericEnv(
    "DEVPRO_SECOND_REVIEW_RUNNER_STATUS_CHECKPOINT_MS",
    defaultStatusCheckpointMs
  );
}

function totalTimeoutMs(context) {
  return numericEnv(
    "DEVPRO_SECOND_REVIEW_RUNNER_TOTAL_TIMEOUT_MS",
    defaultTotalTimeoutMsForTool(context?.reviewer_cli_recipe?.tool)
  );
}

function terminationGraceMs() {
  return numericEnv(
    "DEVPRO_SECOND_REVIEW_RUNNER_TERMINATION_GRACE_MS",
    defaultTerminationGraceMs
  );
}

function forceSettleMs() {
  return numericEnv(
    "DEVPRO_SECOND_REVIEW_RUNNER_FORCE_SETTLE_MS",
    defaultForceSettleMs
  );
}

// The single source of truth for this cap is the packet's own verdict
// contract: SECOND_REVIEW_VERDICT_REASON_MAX_BYTES, imported above from
// ".devpro/scripts/validate-second-review-packet.mjs", is the same module
// that tells the reviewer "Every verdict reason MUST be trimmed, non-empty
// UTF-8 text of at most <cap> bytes." That contract line is what reviewers
// are told to honor for the `reason` field of a verdict; parseStickyBody/
// verifySticky do not themselves enforce it against what a reviewer actually
// writes. Binding this local name to the imported constant means the
// runner's own reason strings (both the sticky reason below and the
// completion `reason` field checked elsewhere in this file) can never drift
// from the ceiling reviewers were told to respect.
const verdictReasonByteCap = SECOND_REVIEW_VERDICT_REASON_MAX_BYTES;

const reviewerModelProvenanceWords = new Set([
  "actual",
  "reviewer",
  "model",
  "name",
  "id",
  "identity",
]);
const invalidReviewerModelStatusWords = new Set([
  "unknown",
  "generic",
  "default",
  "unavailable",
  "unset",
  "none",
  "null",
  "tbd",
  "placeholder",
  "unspecified",
  "not",
  "reported",
  "available",
  "set",
  "specified",
  "n/a",
]);

function isReviewerModelPlaceholder(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") return true;
  if (/[<>]/.test(normalized)) return true;
  if (/^(?:\{\{[^{}\r\n]+\}\}|\$\{[^{}\r\n]+\}|\[[^\[\]\r\n]+\])$/.test(normalized)) {
    return true;
  }
  if (/^(?:actual[\s_-]*)?(?:reviewer[\s_-]*)?model(?:[\s_-]*(?:name|id))?$/i.test(normalized)) {
    return true;
  }
  if (/^n[^\p{L}\p{N}]*a$/iu.test(normalized)) return true;
  const identityWords = normalized
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((word) => !reviewerModelProvenanceWords.has(word));
  const isNotApplicableIdentity =
    (identityWords.length === 1 && identityWords[0] === "na") ||
    (identityWords.length === 2 && identityWords[0] === "n" && identityWords[1] === "a");
  return (
    identityWords.length === 0 ||
    isNotApplicableIdentity ||
    identityWords.every((word) => invalidReviewerModelStatusWords.has(word))
  );
}

function parseStickyBody(body, expectedReviewerTool, expectedRulesVersion) {
  return parseSecondReviewStickyAuthorityBody(body, {
    expectedReviewerTool,
    expectedRulesVersion,
    isReviewerModelInvalid: isReviewerModelPlaceholder,
  });
}

export const __testStickyVerifier = Object.freeze({
  isReviewerModelPlaceholder,
  parseStickyBody,
  rewriteStickyProvenanceModel,
});

function resolvePrNumber(context) {
  if (!isBlank(context.pr_number) && String(context.pr_number) !== "none") {
    return String(context.pr_number);
  }
  const match = String(context.target ?? "").match(/\bPR\s*#?\s*(\d+)\b/i)
    ?? String(context.target ?? "").match(/#(\d+)\b/);
  return match?.[1] ?? null;
}

export function liveStickyAuthoritySnapshot(context, options = {}) {
  const repositorySlug = String(context.repository_slug ?? "");
  const prNumber = Number(context.pr_number);
  const spawnSyncImpl = options.spawnSync ?? spawnSync;
  const response = spawnSyncImpl("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositorySlug}/issues/${prNumber}/comments?per_page=100`,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GH_REPO: repositorySlug,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  });
  if (response.status !== 0) {
    return {
      repository_slug: repositorySlug,
      pr_number: prNumber,
      completeness: {
        status: "failed",
        pagination_exhausted: false,
        pages_fetched: 0,
      },
      query_error: {
        classification: "sticky_authority_query_failed",
        message: response.error?.message ?? String(response.stderr ?? "").slice(-512),
      },
      comments: [],
    };
  }

  let payload;
  try {
    payload = JSON.parse(response.stdout);
  } catch (error) {
    return {
      repository_slug: repositorySlug,
      pr_number: prNumber,
      completeness: {
        status: "failed",
        pagination_exhausted: false,
        pages_fetched: 0,
      },
      query_error: {
        classification: "sticky_authority_query_parse_failed",
        message: error.message,
      },
      comments: [],
    };
  }

  if (Array.isArray(payload) && payload.length > 0 && payload.every(Array.isArray)) {
    return {
      repository_slug: repositorySlug,
      pr_number: prNumber,
      completeness: {
        status: "complete",
        pagination_exhausted: true,
        pages_fetched: payload.length,
      },
      query_error: null,
      comments: payload.flat(),
    };
  }
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      repository_slug: repositorySlug,
      pr_number: prNumber,
      completeness: payload.completeness ?? {
        status: "complete",
        pagination_exhausted: true,
        pages_fetched: 1,
      },
      query_error: payload.query_error ?? null,
      comments: payload.comments,
    };
  }
  return {
    repository_slug: repositorySlug,
    pr_number: prNumber,
    completeness: {
      status: "failed",
      pagination_exhausted: false,
      pages_fetched: 0,
    },
    query_error: { classification: "sticky_authority_query_shape_invalid" },
    comments: [],
  };
}

function revalidateSecondReviewStickyWriteDisposition(context, options = {}) {
  const expected = context.sticky_write_disposition;
  if (context.mode === "audit-only") {
    const valid = expected !== null
      && typeof expected === "object"
      && !Array.isArray(expected)
      && expected.schema === "devpro-second-review-sticky-write-disposition/v1"
      && expected.action === "not-applicable"
      && expected.pr_number === "none"
      && expected.dispatch_id === context.dispatch_id;
    return valid
      ? { status: "verified", disposition: expected }
      : {
          status: "blocked",
          classification: "sticky_write_disposition_blocked",
          reason: "Audit-only sticky disposition is missing, tampered, or executable.",
        };
  }
  // Page-window intermediate packets intentionally project blocked write lines while
  // retaining the authorized create/update disposition in sidecar for final restore.
  // Pre-spawn authority must validate that authorized disposition, not the deferred blocked view.
  const deferredIntermediate = context.page_window_checkpoint_handoff === true
    && expected !== null
    && typeof expected === "object"
    && !Array.isArray(expected)
    && expected.action === "blocked"
    && expected.classification === PAGE_WINDOW_STICKY_DEFERRED_CLASSIFICATION
    && context.sticky_write_disposition_authorized !== null
    && typeof context.sticky_write_disposition_authorized === "object"
    && !Array.isArray(context.sticky_write_disposition_authorized)
    && new Set(["create", "update"]).has(context.sticky_write_disposition_authorized.action);
  const spawnExpected = deferredIntermediate
    ? context.sticky_write_disposition_authorized
    : expected;
  const expectedValid = spawnExpected !== null
    && typeof spawnExpected === "object"
    && !Array.isArray(spawnExpected)
    && spawnExpected.schema === "devpro-second-review-sticky-write-disposition/v1"
    && spawnExpected.repository_slug === context.repository_slug
    && Number(spawnExpected.pr_number) === Number(context.pr_number)
    && spawnExpected.dispatch_id === context.dispatch_id
    && new Set(["create", "update"]).has(spawnExpected.action);
  if (!expectedValid) {
    return {
      status: "blocked",
      classification: "sticky_write_disposition_blocked",
      reason: "Renderer-owned sticky disposition is missing, blocked, tampered, or target-mismatched.",
    };
  }
  const snapshot = liveStickyAuthoritySnapshot(context, options);
  const disposition = resolveSecondReviewStickyWriteDisposition(
    snapshot, { expectedDisposition: spawnExpected }
  );
  if (disposition.action === "blocked") {
    return {
      status: "blocked",
      classification: "sticky_write_disposition_blocked",
      disposition_classification: disposition.classification,
      reason: disposition.reason,
    };
  }
  return {
    status: "verified",
    disposition,
    sticky_deferred_until_final: deferredIntermediate === true,
    priorGateSatisfyingSticky: (() => {
      const body = selectExactSecondReviewStickyAuthority(snapshot.comments).authority?.body;
      if (typeof body !== "string") return null;
      const parsed = parseSecondReviewStickyAuthorityBody(body);
      return parsed.contract_errors.length === 0
        && parsed.last_reviewed_sha === context.head_ref_oid
        && ["PASS", "WARN"].includes(parsed.verdict) ? { verdict: parsed.verdict } : null;
    })(),
  };
}

function canonicalCompletionStickyIdentity(context, value) {
  const url = typeof value === "string" ? value : "";
  const prefix = `https://github.com/${context.repository_slug}/pull/${context.pr_number}#issuecomment-`;
  if (!url.startsWith(prefix)) return null;
  const idText = url.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(idText)) return null;
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || String(id) !== idText) return null;
  return { id, url };
}

function stickyVerificationFailed(context, classification, details = {}) {
  const failed = {
    ...details,
    status: "failed",
    classification,
  };
  appendActivity(context, "projection_sticky_verification_failed", failed);
  refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
  return failed;
}

function exactStickyCommentRead(context, commentId) {
  return spawnSync("gh", [
    "api",
    `repos/${context.repository_slug}/issues/comments/${commentId}`,
    "--include",
  ], {
    cwd: context.neutral_cwd_path,
    env: {
      ...process.env,
      GH_REPO: context.repository_slug,
    },
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });
}

function parseGhApiIncludeResponse(stdout) {
  const text = String(stdout ?? "").replace(/\r\n/g, "\n");
  const separator = text.indexOf("\n\n");
  const headerBlock = separator === -1 ? "" : text.slice(0, separator);
  const bodyText = (separator === -1 ? text : text.slice(separator + 2)).trim();
  let etag = null;
  for (const line of headerBlock.split("\n")) {
    const match = /^etag:\s*(.*?)\s*$/i.exec(line);
    if (match) {
      const value = match[1].trim();
      if (value) etag = value;
      break;
    }
  }
  return { etag, bodyText };
}

function parseExactStickyCommentInclude(stdout) {
  const { etag, bodyText } = parseGhApiIncludeResponse(stdout);
  return {
    etag,
    comment: JSON.parse(bodyText),
  };
}

function readStickyWriteResultPreferBlocked(context) {
  const candidates = [];
  const dispatchId = typeof context?.dispatch_id === "string" ? context.dispatch_id : undefined;
  const perDispatchBasename = stickyWriteResultBasename(dispatchId);
  if (typeof context?.observability_context_path === "string") {
    candidates.push(path.join(path.dirname(context.observability_context_path), perDispatchBasename));
    if (perDispatchBasename !== STICKY_WRITE_RESULT_BASENAME) {
      candidates.push(path.join(path.dirname(context.observability_context_path), STICKY_WRITE_RESULT_BASENAME));
    }
  }
  if (dispatchId) {
    const sidecarPath = resolveCredentialGateSidecarPath(undefined, dispatchId);
    const sidecarDir = path.dirname(sidecarPath);
    candidates.push(path.join(sidecarDir, perDispatchBasename));
    if (perDispatchBasename !== STICKY_WRITE_RESULT_BASENAME) {
      candidates.push(path.join(sidecarDir, STICKY_WRITE_RESULT_BASENAME));
    }
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (!parsed || parsed.ok !== false || typeof parsed.classification !== "string") continue;
      if (typeof parsed.dispatch_id === "string"
        && dispatchId
        && parsed.dispatch_id !== dispatchId) {
        continue;
      }
      return { path: candidate, result: parsed };
    } catch {
      // ignore unreadable result files
    }
  }
  return null;
}

function loadCredentialGateMaterialsFromSidecar(context) {
  const candidates = [];
  if (typeof context?.__credential_gate_sidecar_path === "string") {
    candidates.push(context.__credential_gate_sidecar_path);
  }
  if (typeof context?.__credential_gate_sidecar_carrier_path === "string") {
    candidates.push(context.__credential_gate_sidecar_carrier_path);
  }
  if (typeof context?.observability_context_path === "string") {
    candidates.push(path.join(
      path.dirname(context.observability_context_path),
      STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME,
    ));
  }
  if (typeof context?.dispatch_id === "string") {
    candidates.push(resolveCredentialGateSidecarPath(undefined, context.dispatch_id));
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (!isPlainObject(parsed) || parsed.schema !== STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA) {
        continue;
      }
      return {
        materialTexts: Array.isArray(parsed.materialTexts)
          ? parsed.materialTexts.filter((t) => typeof t === "string")
          : [],
        explicitDenyList: Array.isArray(parsed.explicitDenyList)
          ? parsed.explicitDenyList.filter((t) => typeof t === "string")
          : [],
        path: candidate,
      };
    } catch {
      // ignore unreadable sidecars
    }
  }
  return { materialTexts: [], explicitDenyList: [], path: null };
}

function assertStickyBodyCredentialFreeForRunner(context, body, { classification = STICKY_CREDENTIAL_LITERAL_DETECTED } = {}) {
  const materialTexts = [];
  const explicitDenyList = [];
  if (typeof context?.review_material_text === "string") materialTexts.push(context.review_material_text);
  if (Array.isArray(context?.credential_gate_material_texts)) {
    materialTexts.push(...context.credential_gate_material_texts.filter((t) => typeof t === "string"));
  }
  if (Array.isArray(context?.credential_gate_explicit_deny_list)) {
    explicitDenyList.push(...context.credential_gate_explicit_deny_list.filter((t) => typeof t === "string"));
  }
  const fromSidecar = loadCredentialGateMaterialsFromSidecar(context);
  materialTexts.push(...fromSidecar.materialTexts);
  explicitDenyList.push(...fromSidecar.explicitDenyList);
  return assertStickyBodyCredentialFree(body, {
    materialTexts,
    explicitDenyList,
    repositorySlug: context?.repository_slug,
    classification,
  });
}

function patchStickyCommentBody(context, commentId, body) {
  const gate = assertStickyBodyCredentialFreeForRunner(context, body, {
    classification: STICKY_CREDENTIAL_LITERAL_DETECTED,
  });
  if (!gate.ok) {
    return {
      status: 1,
      error: { message: gate.classification },
      stderr: JSON.stringify(credentialGateTelemetry(gate)),
      stdout: "",
      credential_gate: gate,
    };
  }
  return spawnSync("gh", [
    "api",
    "-X", "PATCH",
    `repos/${context.repository_slug}/issues/comments/${commentId}`,
    "--input", "-",
    "--jq",
    "{id: .id, html_url: .html_url, node_id: .node_id, updated_at: .updated_at, body: .body}",
  ], {
    cwd: context.neutral_cwd_path,
    env: {
      ...process.env,
      GH_REPO: context.repository_slug,
    },
    encoding: "utf8",
    input: JSON.stringify({ body }),
    ...(process.env.DEVPRO_SECOND_REVIEW_GITHUB_TRANSPORT_FILE ? {reviewerWrite:{dispatchId:context.dispatch_id,bodySha256:sha256Hex(body)}} : {}),
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });
}

function verifySticky(context, {
  reviewerCompletion = null,
  completionRequired = false,
  streamIdentity = null,
  acceptCriticalCheckpoint = false,
} = {}) {
  if (context.mode !== "pr-sticky") {
    appendActivity(context, "projection_sticky_verification_skipped", {
      reason: "audit-only mode does not write PR sticky",
    });
    return {
      status: "skipped",
      classification: "sticky_verification_skipped",
    };
  }

  const prNumber = resolvePrNumber(context);
  const expectedHead = !isBlank(context.head_ref_oid) && context.head_ref_oid !== "none"
    ? String(context.head_ref_oid)
    : null;
  appendActivity(context, "projection_sticky_verification_started", {
    pr_number: prNumber,
    expected_head_ref_oid: expectedHead,
  });

  if (!prNumber || !expectedHead) {
    return stickyVerificationFailed(context, "sticky_verification_input_missing", {
      pr_number: prNumber,
      expected_head_ref_oid: expectedHead,
    });
  }

  // PRIM-F4: blocked gated-write result MUST win over sticky_missing.
  const blockedWriteEarly = readStickyWriteResultPreferBlocked(context);
  if (blockedWriteEarly?.result?.classification === STICKY_CREDENTIAL_LITERAL_BLOCKED
    || blockedWriteEarly?.result?.classification === STICKY_CREDENTIAL_LITERAL_DETECTED) {
    return stickyVerificationFailed(context, blockedWriteEarly.result.classification, {
      pr_number: prNumber,
      expected_head_ref_oid: expectedHead,
      matched_token_kind: blockedWriteEarly.result.matched_token_kind ?? null,
      source: blockedWriteEarly.result.source ?? null,
      len_bucket: blockedWriteEarly.result.len_bucket ?? null,
      sticky_write_result_path: blockedWriteEarly.path,
    });
  }

  const view = spawnSync("gh", ["pr", "view", prNumber, "--json", "headRefOid"], {
    cwd: context.neutral_cwd_path,
    env: {
      ...process.env,
      GH_REPO: context.repository_slug,
    },
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });

  if (view.status !== 0) {
    return stickyVerificationFailed(context, "sticky_verification_read_failed", {
      pr_number: prNumber,
      error: view.error?.message ?? null,
      stderr_tail: (view.stderr ?? "").slice(-1000),
    });
  }

  let headPayload;
  try {
    headPayload = JSON.parse(view.stdout);
  } catch (error) {
    return stickyVerificationFailed(context, "sticky_verification_parse_failed", {
      pr_number: prNumber,
      error: error.message,
    });
  }

  if (headPayload === null
    || typeof headPayload !== "object"
    || Array.isArray(headPayload)
    || typeof headPayload.headRefOid !== "string") {
    return stickyVerificationFailed(context, "sticky_response_shape_invalid", {
      pr_number: prNumber,
      expected_head_ref_oid: expectedHead,
    });
  }

  const snapshot = liveStickyAuthoritySnapshot(context);
  const postWriteDisposition = resolveSecondReviewStickyWriteDisposition(snapshot);
  if (postWriteDisposition.action === "blocked") {
    return stickyVerificationFailed(context, postWriteDisposition.classification, {
      pr_number: prNumber,
      expected_head_ref_oid: expectedHead,
      current_head_ref_oid: headPayload.headRefOid,
      authority_candidate_count: postWriteDisposition.candidate_count,
    });
  }
  if (postWriteDisposition.action !== "update") {
    return stickyVerificationFailed(context, "sticky_missing", {
      pr_number: prNumber,
      expected_head_ref_oid: expectedHead,
      current_head_ref_oid: headPayload.headRefOid,
      authority_candidate_count: postWriteDisposition.candidate_count,
    });
  }

  const stickyAuthority = selectExactSecondReviewStickyAuthority(snapshot.comments);
  const sticky = stickyAuthority.authority;
  const actualTarget = postWriteDisposition.target;
  const expectedDisposition = context.sticky_write_disposition;
  const expectedUpdateTarget = expectedDisposition?.action === "update"
    ? expectedDisposition.target
    : null;
  if (!new Set(["create", "update"]).has(expectedDisposition?.action)
    || (expectedUpdateTarget !== null && (
      expectedUpdateTarget.id !== actualTarget.id
      || expectedUpdateTarget.url !== actualTarget.url
      || expectedUpdateTarget.node_id !== actualTarget.node_id
    ))) {
    return stickyVerificationFailed(context, "sticky_write_target_mismatch", {
      pr_number: prNumber,
      sticky_comment_id: actualTarget.id,
      sticky_comment_url: actualTarget.url,
      expected_sticky_write_action: expectedDisposition?.action ?? null,
      authority_candidate_count: stickyAuthority.candidate_count,
    });
  }

  const exactRead = exactStickyCommentRead(context, actualTarget.id);
  if (exactRead.status !== 0) {
    return stickyVerificationFailed(context, "sticky_exact_readback_failed", {
      pr_number: prNumber,
      sticky_comment_id: actualTarget.id,
      sticky_comment_url: actualTarget.url,
      error: exactRead.error?.message ?? null,
      stderr_tail: (exactRead.stderr ?? "").slice(-1000),
    });
  }
  let exactComment;
  let snapshotEtag;
  try {
    const parsedExact = parseExactStickyCommentInclude(exactRead.stdout);
    exactComment = parsedExact.comment;
    snapshotEtag = parsedExact.etag;
  } catch (error) {
    return stickyVerificationFailed(context, "sticky_exact_readback_parse_failed", {
      pr_number: prNumber,
      sticky_comment_id: actualTarget.id,
      sticky_comment_url: actualTarget.url,
      error: error.message,
    });
  }
  const exactNormalized = normalizeSecondReviewStickyCandidate(
    exactComment,
    context.repository_slug,
    Number(prNumber)
  );
  if (!exactNormalized.target
    || ["id", "url", "node_id", "body_sha256", "updated_at"].some(
      (field) => exactNormalized.target?.[field] !== actualTarget[field]
    )) {
    return stickyVerificationFailed(context, "sticky_exact_readback_identity_mismatch", {
      pr_number: prNumber,
      sticky_comment_id: actualTarget.id,
      sticky_comment_url: actualTarget.url,
      exact_readback_error: exactNormalized.error ?? null,
    });
  }

  const completionIdentity = canonicalCompletionStickyIdentity(
    context,
    reviewerCompletion?.sticky_comment_url
  );
  if (completionRequired && completionIdentity === null) {
    return stickyVerificationFailed(context, "sticky_completion_identity_missing", {
      pr_number: prNumber,
      sticky_comment_id: actualTarget.id,
      sticky_comment_url: actualTarget.url,
    });
  }
  if (completionIdentity !== null && (
    completionIdentity.id !== actualTarget.id
    || completionIdentity.url !== actualTarget.url
  )) {
    return stickyVerificationFailed(context, "sticky_completion_identity_mismatch", {
      pr_number: prNumber,
      sticky_comment_id: actualTarget.id,
      sticky_comment_url: actualTarget.url,
      completion_sticky_comment_id: completionIdentity.id,
      completion_sticky_comment_url: completionIdentity.url,
    });
  }

  const parsed = parseStickyBody(
    exactComment.body,
    secondReviewToolForFamily(context.reviewer_family),
    secondReviewRulesVersion()
  );
  const result = {
    pr_number: prNumber,
    sticky_comment_id: actualTarget.id,
    sticky_comment_url: actualTarget.url,
    verdict: parsed.verdict,
    last_reviewed_sha: parsed.last_reviewed_sha,
    dispatch_id: parsed.dispatch_id,
    rules_version: parsed.rules_version,
    reviewer_tool: parsed.reviewer_tool,
    reviewer_model: parsed.reviewer_model,
    expected_head_ref_oid: expectedHead,
    current_head_ref_oid: headPayload.headRefOid,
    authority_candidate_count: stickyAuthority.candidate_count,
  };

  if (parsed.contract_errors.length > 0) {
    const failed = {
      ...result,
      status: "failed",
      classification: "sticky_contract_invalid",
      contract_errors: parsed.contract_errors,
    };
    appendActivity(context, "projection_sticky_verification_failed", failed);
    refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
    return failed;
  }

  if (headPayload.headRefOid !== expectedHead || parsed.last_reviewed_sha !== expectedHead) {
    const failed = {
      ...result,
      status: "failed",
      classification: "sticky_sha_mismatch",
    };
    appendActivity(context, "projection_sticky_verification_failed", failed);
    refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
    return failed;
  }

  if (parsed.dispatch_id !== null && parsed.dispatch_id !== context.dispatch_id) {
    const failed = {
      ...result,
      status: "failed",
      classification: "sticky_dispatch_mismatch",
    };
    appendActivity(context, "projection_sticky_verification_failed", failed);
    refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
    return failed;
  }

  if (!new Set(["PASS", "WARN"]).has(parsed.verdict)
    && !(acceptCriticalCheckpoint && parsed.verdict === "CRITICAL")) {
    const failed = {
      ...result,
      status: "failed",
      classification: "sticky_verdict_not_gate_satisfying",
    };
    appendActivity(context, "projection_sticky_verification_failed", failed);
    refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
    return failed;
  }

  try {
    if (guaranteeAssessmentRequired(context) && parsed.verdict !== "CRITICAL") {
      const binding = {
        reviewedTarget: expectedHead, dispatchId: context.dispatch_id,
        ...(Array.isArray(reviewerCompletion?.findings) ? { findingIds: reviewerCompletion.findings.map(finding => finding.summary_id) } : {}),
      };
      const assessment = readReviewGuaranteeAssessment(exactComment.body, binding);
      if (assessment.requires_clarification) throw new Error("review guarantee assessment requires clarification");
      if (reviewerCompletion && !isDeepStrictEqual(assessment.report, readReviewGuaranteeAssessment(reviewerCompletion.reason, binding).report)) {
        throw new Error("sticky and completion guarantee assessments differ; regenerate both from the same report");
      }
    }
  } catch (error) {
    return stickyVerificationFailed(context, "sticky_contract_invalid", {
      ...result, contract_errors: [error.message],
    });
  }

  if (
    classificationIndicatesSameFamilyFallback(context.retry_context?.classification)
  ) {
    const sameFamilyGate = classifySameFamilyStickyReason(
      parsed.reason,
      context.retry_context,
    );
    if (!sameFamilyGate.ok) {
      const failed = {
        ...result,
        status: "failed",
        classification: sameFamilyGate.classification,
        reason: parsed.reason,
      };
      appendActivity(context, "projection_sticky_verification_failed", failed);
      refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
      return failed;
    }
  }

  if (
    primaryFamilyIsUnknown(context.primary_family)
    && !classificationIndicatesSameFamilyFallback(context.retry_context?.classification)
    && !stickyReasonRequiresCrossModelUnverified(parsed.reason)
  ) {
    const failed = {
      ...result,
      status: "failed",
      classification: "sticky_cross_model_unverified_provenance_missing",
      reason: parsed.reason,
    };
    appendActivity(context, "projection_sticky_verification_failed", failed);
    refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
    return failed;
  }

  const canonicalStreamIdentity = usableStreamReviewerModel(
    typeof streamIdentity === "string" ? streamIdentity.trim() : streamIdentity,
  );
  const finalizedCompletionIdentity = usableStreamReviewerModel(
    reviewerCompletion?.reviewer_model,
  );
  if (canonicalStreamIdentity === null
    && finalizedCompletionIdentity !== null
    && parsed.reviewer_model !== finalizedCompletionIdentity) {
    return stickyVerificationFailed(context, "sticky_contract_invalid", {
      ...result,
      contract_errors: ["sticky_reviewer_model_invalid"],
    });
  }

  const verified = {
    ...result,
    reason: parsed.reason,
    status: "verified",
    classification: "sticky_verified",
    ...(acceptCriticalCheckpoint ? { write_disposition: { ...postWriteDisposition, dispatch_id: context.dispatch_id } } : {}),
  };
  if (canonicalStreamIdentity && parsed.reviewer_model !== canonicalStreamIdentity) {
    const rewrittenBody = rewriteStickyProvenanceModel(exactComment.body, canonicalStreamIdentity);
    if (!snapshotEtag) {
      return stickyVerificationFailed(context, "sticky_patch_snapshot_stale", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
      });
    }
    const lastLookRead = exactStickyCommentRead(context, actualTarget.id);
    if (lastLookRead.status !== 0) {
      return stickyVerificationFailed(context, "sticky_patch_snapshot_stale", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
        error: lastLookRead.error?.message ?? null,
        stderr_tail: (lastLookRead.stderr ?? "").slice(-1000),
      });
    }
    let lastLookComment;
    let lastLookEtag;
    try {
      const parsedLastLook = parseExactStickyCommentInclude(lastLookRead.stdout);
      lastLookComment = parsedLastLook.comment;
      lastLookEtag = parsedLastLook.etag;
    } catch (error) {
      return stickyVerificationFailed(context, "sticky_patch_snapshot_stale", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
        error: error.message,
      });
    }
    if (!lastLookEtag
      || lastLookEtag !== snapshotEtag
      || lastLookComment.updated_at !== exactComment.updated_at
      || lastLookComment.body !== exactComment.body) {
      return stickyVerificationFailed(context, "sticky_patch_snapshot_stale", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
      });
    }
    const patch = patchStickyCommentBody(context, actualTarget.id, rewrittenBody);
    if (patch.status !== 0) {
      if (patch.credential_gate && !patch.credential_gate.ok) {
        return stickyVerificationFailed(context, STICKY_CREDENTIAL_LITERAL_DETECTED, {
          pr_number: prNumber,
          sticky_comment_id: actualTarget.id,
          sticky_comment_url: actualTarget.url,
          ...credentialGateTelemetry(patch.credential_gate),
        });
      }
      return stickyVerificationFailed(context, "sticky_exact_readback_failed", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
        error: patch.error?.message ?? null,
        stderr_tail: (patch.stderr ?? "").slice(-1000),
      });
    }
    const patchedRead = exactStickyCommentRead(context, actualTarget.id);
    if (patchedRead.status !== 0) {
      return stickyVerificationFailed(context, "sticky_exact_readback_failed", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
        error: patchedRead.error?.message ?? null,
        stderr_tail: (patchedRead.stderr ?? "").slice(-1000),
      });
    }
    let patchedComment;
    try {
      patchedComment = parseExactStickyCommentInclude(patchedRead.stdout).comment;
    } catch (error) {
      return stickyVerificationFailed(context, "sticky_exact_readback_parse_failed", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
        error: error.message,
      });
    }
    const patchedNormalized = normalizeSecondReviewStickyCandidate(
      patchedComment,
      context.repository_slug,
      Number(prNumber)
    );
    if (!patchedNormalized.target
      || patchedNormalized.target.id !== actualTarget.id
      || patchedNormalized.target.url !== actualTarget.url
      || patchedNormalized.target.node_id !== actualTarget.node_id) {
      return stickyVerificationFailed(context, "sticky_exact_readback_identity_mismatch", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
        exact_readback_error: patchedNormalized.error ?? null,
      });
    }
    const patchedParsed = parseStickyBody(
      patchedComment.body,
      secondReviewToolForFamily(context.reviewer_family),
      secondReviewRulesVersion()
    );
    if (patchedParsed.contract_errors.length > 0
      || patchedParsed.reviewer_model !== canonicalStreamIdentity) {
      return stickyVerificationFailed(context, "sticky_exact_readback_identity_mismatch", {
        pr_number: prNumber,
        sticky_comment_id: actualTarget.id,
        sticky_comment_url: actualTarget.url,
      });
    }
    verified.reviewer_model = canonicalStreamIdentity;
  }
  const blockedWrite = readStickyWriteResultPreferBlocked(context);
  if (blockedWrite?.result?.classification === STICKY_CREDENTIAL_LITERAL_BLOCKED
    || blockedWrite?.result?.classification === STICKY_CREDENTIAL_LITERAL_DETECTED) {
    return stickyVerificationFailed(context, blockedWrite.result.classification, {
      ...result,
      matched_token_kind: blockedWrite.result.matched_token_kind ?? null,
      source: blockedWrite.result.source ?? null,
      len_bucket: blockedWrite.result.len_bucket ?? null,
      sticky_write_result_path: blockedWrite.path,
    });
  }

  const credentialGate = assertStickyBodyCredentialFreeForRunner(context, exactComment.body, {
    classification: STICKY_CREDENTIAL_LITERAL_DETECTED,
  });
  if (!credentialGate.ok) {
    return stickyVerificationFailed(context, STICKY_CREDENTIAL_LITERAL_DETECTED, {
      ...result,
      ...credentialGateTelemetry(credentialGate),
    });
  }

  const { reason: _reviewerControlledReason, ...verifiedTelemetry } = verified;
  appendActivity(context, "projection_sticky_verified", verifiedTelemetry);
  refreshHeartbeat(context, "projection_sticky_verified", verifiedTelemetry);
  return verified;
}

function verifyStickyFailClosed(context, options = {}) {
  try {
    return verifySticky(context, options);
  } catch (error) {
    const failed = {
      status: "failed",
      classification: "sticky_verification_exception",
      error: error instanceof Error ? error.message : String(error),
    };
    try {
      appendActivity(context, "projection_sticky_verification_failed", failed);
    } catch {
      // Verification outcome remains fail-closed even if its diagnostic write fails.
    }
    try {
      refreshHeartbeat(context, "projection_sticky_verification_failed", failed);
    } catch {
      // Verification outcome remains fail-closed even if its heartbeat write fails.
    }
    return failed;
  }
}

function loadPacket(context) {
  if (context.packet_carrier !== "file" || isBlank(context.packet_path)) {
    throw new Error("projection runner requires file packet_carrier and packet_path");
  }
  return readFileSync(context.packet_path, "utf8");
}

function safeReviewerToolNames(value) {
  if (!Array.isArray(value)) return value == null ? null : "invalid";
  const allowed = new Set(["Write", "Bash", "StructuredOutput"]);
  return value.slice(0, 16).map((entry) => allowed.has(entry) ? entry : "unknown");
}

function safeToolSurfaceTelemetry(check) {
  return {
    status: check?.status ?? "unknown",
    classification: check?.classification ?? "unknown",
    ...(check?.reason === undefined ? {} : { reason: check.reason }),
    ...(check?.expected_tools === undefined
      ? {}
      : { expected_tools: safeReviewerToolNames(check.expected_tools) }),
    ...(check?.tools === undefined
      ? {}
      : { tools: safeReviewerToolNames(check.tools) }),
  };
}

function claudeRecipeUsesCompletionJsonSchema(context) {
  const recipe = context?.reviewer_cli_recipe ?? {};
  const flags = Array.isArray(recipe.required_flags)
    ? recipe.required_flags.map(String)
    : [];
  const args = Array.isArray(recipe.required_invocation_args)
    ? recipe.required_invocation_args.map(String)
    : [];
  return flags.includes("--json-schema") || args.includes("--json-schema");
}

function expectedClaudeToolsForContext(context, tool) {
  if (tool !== "claude") return null;
  const schemaTools = claudeRecipeUsesCompletionJsonSchema(context)
    ? ["StructuredOutput"]
    : [];
  if (context.mode === "audit-only") return schemaTools;
  if (context.mode === "pr-sticky") return ["Bash", ...schemaTools, "Write"];
  return null;
}

function initialReviewerToolSurfaceCheck(expectedTools) {
  return Array.isArray(expectedTools)
    ? {
        status: "pending",
        classification: "reviewer_tool_surface_evidence_missing",
        expected_tools: expectedTools,
      }
    : { status: "not-required", classification: "not-required" };
}

function hasExactReviewerToolSurface(actualTools, expectedTools) {
  if (!Array.isArray(actualTools)) return false;
  const actualUniqueTools = new Set(actualTools);
  return actualTools.every((entry) => typeof entry === "string")
    && actualUniqueTools.size === actualTools.length
    && actualTools.length === expectedTools.length
    && expectedTools.every((entry) => actualUniqueTools.has(entry));
}

function inspectReviewerToolSurfaceLine({ check, expectedTools, line }) {
  if (!Array.isArray(expectedTools) || check?.status === "failed" || isBlank(line)) {
    return { action: "none", check };
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return { action: "none", check };
  }
  if (event?.type !== "system" || event?.subtype !== "init") {
    return { action: "none", check };
  }

  if (check?.status === "verified") {
    return {
      action: "failed",
      check: {
        status: "failed",
        classification: "reviewer_tool_surface_mismatch",
        reason: "duplicate_init_event",
        expected_tools: expectedTools,
        tools: event.tools ?? null,
      },
    };
  }

  const actualTools = Array.isArray(event.tools) ? event.tools : null;
  if (hasExactReviewerToolSurface(actualTools, expectedTools)) {
    return {
      action: "verified",
      check: {
        status: "verified",
        classification: "reviewer_tool_surface_verified",
        expected_tools: expectedTools,
        tools: actualTools,
      },
    };
  }

  return {
    action: "failed",
    check: {
      status: "failed",
      classification: "reviewer_tool_surface_mismatch",
      reason: "unexpected_tool_surface",
      expected_tools: expectedTools,
      tools: event.tools ?? null,
    },
  };
}

function missingReviewerToolSurfaceEvidenceCheck(expectedTools) {
  return {
    status: "failed",
    classification: "reviewer_tool_surface_evidence_missing",
    expected_tools: expectedTools,
  };
}

export const __testReviewerToolSurface = Object.freeze({
  expectedToolsForContext: expectedClaudeToolsForContext,
  initialCheck: initialReviewerToolSurfaceCheck,
  inspectLine: inspectReviewerToolSurfaceLine,
  missingEvidenceCheck: missingReviewerToolSurfaceEvidenceCheck,
  safeTelemetry: safeToolSurfaceTelemetry,
});

function safeReviewerTerminationTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    status: value.status ?? "unknown",
    attempted: value.attempted === true,
    accepted: value.accepted === true,
    signal: value.signal ?? null,
    child_open_before: value.child_open_before === true,
    process_group: value.process_group === true,
    ...(value.error === undefined ? {} : { error: "reviewer transport termination failed" }),
  };
}

// Whitelist sanitiser for the close-time convergence telemetry: only bounded
// scalars cross into control-plane evidence, so no pid, no absolute path and no
// raw error text can ride along.
function safeReviewerConvergenceTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    eligible: value.eligible === true,
    outcome: typeof value.outcome === "string" ? value.outcome : null,
    probes: Number.isInteger(value.probes) ? value.probes : 0,
    signals: Array.isArray(value.signals)
      ? value.signals.filter((signal) => signal === "SIGTERM" || signal === "SIGKILL")
      : [],
    escalated: value.escalated === true,
    grace_ms: Number.isInteger(value.grace_ms) ? value.grace_ms : null,
    settle_ms: Number.isInteger(value.settle_ms) ? value.settle_ms : null,
  };
}

function runReviewerCli(context, options = {}) {
  return new Promise((resolve) => {
    const recipe = context.reviewer_cli_recipe ?? {};
    const tool = String(recipe.tool ?? "");
    const reviewerExecutable = String(options.reviewerExecutable ?? "");
    const args = Array.isArray(recipe.required_invocation_args)
      ? recipe.required_invocation_args.map(String)
      : [];
    const packet = options.trustedPacketBytes === undefined
      ? loadPacket(context)
      : Buffer.from(options.trustedPacketBytes);
    const timeoutMs = options.totalTimeoutMs ?? totalTimeoutMs(context);
    const checkpointMs = options.statusCheckpointMs ?? statusCheckpointMs();
    const intervalMs = options.heartbeatIntervalMs ?? heartbeatIntervalMs(context);
    const terminationGrace = options.terminationGraceMs ?? terminationGraceMs();
    const forcedSettlementDelay = options.forceSettleMs ?? forceSettleMs();
    const stdoutSidecarInitialBytes = statSync(context.stdout_log_path).size;
    const discardedStdoutThinkingRanges = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastSampledStdoutBytes = 0;
    let lastSampledStderrBytes = 0;
    let livenessSampleIndex = 0;
    let lastOutputAt = null;
    let lastOutputAtMs = null;
    let lastOutput = null;
    let lastStructuredOutput = null;
    let codexManifestSessionEvidence = null;
    let claudeManifestTerminal = null;
    let codexManifestUsage = null;
    const openCodeEvents = tool === "opencode" ? createOpenCodeEventCollector() : null;
    let timedOut = false;
    let spawnError = null;
    let terminationCallbackError = null;
    let terminationResult = null;
    let processStartedAtMs = null;
    let processStartedAt = null;
    let interval = null;
    let statusCheckpoint = null;
    let timeout = null;
    let terminationGraceTimer = null;
    let forceSettleTimer = null;
    let settled = false;
    let childSpawned = false;
    let reviewerProcessGroupId = null;
    let terminationState = null;
    let closeObservation = null;
    let outputAccumulatorsEnded = false;
    const expectedClaudeTools = expectedClaudeToolsForContext(context, tool);
    const requiresClaudeToolSurfaceEvidence = Array.isArray(expectedClaudeTools);
    let toolSurfaceCheck = initialReviewerToolSurfaceCheck(expectedClaudeTools);
    let outputSafetyCheck = {
      status: "verified",
      classification: "reviewer_output_within_line_limit",
      max_line_bytes: maxReviewerOutputLineBytes,
    };
    appendActivity(context, "projection_cli_starting", {
      tool,
      args,
      stdout_log_path: context.stdout_log_path,
      stderr_log_path: context.stderr_log_path,
      status_checkpoint_ms: checkpointMs,
      total_timeout_ms: timeoutMs,
    });
    refreshHeartbeat(context, "projection_cli_starting", {
      tool,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
    });

    const reviewerProcessGroupsSupported = supportsReviewerProcessGroups();
    const child = spawn(reviewerExecutable, args, {
      cwd: context.neutral_cwd_path,
      env: reviewerSpawnEnv(context, { baseEnv: options.baseEnv ?? process.env }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: reviewerProcessGroupsSupported,
    });

    function refreshRunning(reason, payload = {}) {
      refreshHeartbeat(context, "projection_cli_running", {
        pid: child.pid ?? null,
        tool,
        reason,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        last_output_at: lastOutputAt,
        ...payload,
      });
    }

    function idleEvidence() {
      const referenceMs = lastOutputAtMs ?? processStartedAtMs ?? Date.now();
      return {
        process_started_at: processStartedAt,
        idle_duration_ms: Math.max(0, Date.now() - referenceMs),
        idle_reference: lastOutputAtMs === null ? "process-start" : "last-output",
      };
    }

    function sampleReviewerStreamLiveness() {
      livenessSampleIndex += 1;
      const stdoutDeltaBytes = stdoutBytes - lastSampledStdoutBytes;
      const stderrDeltaBytes = stderrBytes - lastSampledStderrBytes;
      const payload = {
        sample_index: livenessSampleIndex,
        interval_ms: intervalMs,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_delta_bytes: stdoutDeltaBytes,
        stderr_delta_bytes: stderrDeltaBytes,
        last_output_at: lastOutputAt,
        last_output: lastOutput,
        last_structured_output: lastStructuredOutput,
        ...idleEvidence(),
        liveness: stdoutDeltaBytes > 0 || stderrDeltaBytes > 0
          ? "output-progress"
          : "no-output-progress",
        child_open: child.exitCode === null && child.signalCode === null,
        child_exit_observed: child.exitCode !== null || child.signalCode !== null,
      };
      appendActivity(context, "projection_cli_liveness_sampled", payload);
      refreshRunning("liveness-sample", payload);
      lastSampledStdoutBytes = stdoutBytes;
      lastSampledStderrBytes = stderrBytes;
    }

    function requestBoundedTermination({ classification, reason, isHardCap = false, event, payload = {} }) {
      if (terminationState !== null || settled) return false;
      terminationState = {
        classification,
        reason,
        is_hard_cap: isHardCap,
        escalated: false,
      };
      if (isHardCap) timedOut = true;
      try {
        terminationResult = terminateOpenReviewerTransport(child, {
          processGroupId: reviewerProcessGroupId,
        });
      } catch (error) {
        terminationCallbackError ??= error instanceof Error ? error.message : String(error);
        terminationResult = {
          status: "reviewer_transport_sigterm_error",
          attempted: true,
          accepted: false,
          signal: "SIGTERM",
          child_open_before: child.exitCode === null && child.signalCode === null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const terminationPayload = {
        ...payload,
        fault_classification: classification,
        fault_reason: reason,
        reviewer_transport_termination: safeReviewerTerminationTelemetry(terminationResult),
      };
      try {
        appendActivity(context, event, terminationPayload);
      } catch (error) {
        terminationCallbackError ??= error instanceof Error ? error.message : String(error);
      }
      try {
        refreshHeartbeat(context, event, terminationPayload);
      } catch (error) {
        terminationCallbackError ??= error instanceof Error ? error.message : String(error);
      }
      if (reviewerTransportCleanupComplete(terminationResult)) {
        const observation = closeObservation ?? {
          code: child.exitCode,
          signal: child.signalCode,
        };
        finalize(observation.code, observation.signal, closeObservation !== null);
        return true;
      }
      terminationGraceTimer = setTimeout(() => {
        try {
          terminationResult = forceKillOpenReviewerTransport(child, {
            processGroupId: reviewerProcessGroupId,
          });
        } catch (error) {
          terminationCallbackError ??= error instanceof Error ? error.message : String(error);
          terminationResult = {
            status: "reviewer_transport_sigkill_error",
            attempted: true,
            accepted: false,
            signal: "SIGKILL",
            child_open_before: child.exitCode === null && child.signalCode === null,
            process_group: supportsReviewerProcessGroups(),
            error: error instanceof Error ? error.message : String(error),
          };
        }
        terminationState.escalated = true;
        try {
          appendActivity(context, "projection_cli_force_kill", {
            fault_classification: terminationState.classification,
            fault_reason: terminationState.reason,
            reviewer_transport_termination: safeReviewerTerminationTelemetry(terminationResult),
          });
        } catch (error) {
          terminationCallbackError ??= error instanceof Error ? error.message : String(error);
        }
        if (closeObservation !== null) {
          finalize(closeObservation.code, closeObservation.signal, true);
          return;
        }
        forceSettleTimer = setTimeout(() => {
          finalize(child.exitCode, child.signalCode ?? "SIGKILL", false);
        }, forcedSettlementDelay);
      }, terminationGrace);
      return true;
    }

    // A terminal interrupt must not abandon a detached reviewer process. Keep
    // the runner alive until the existing bounded termination and close path
    // has observed what actually happened; never synthesize a close event.
    const interruptHandlers = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, () => {
      requestBoundedTermination({
        classification: "reviewer_cli_interrupted",
        reason: `runner_received_${signal}`,
        event: "projection_cli_interrupted",
        payload: { received_signal: signal },
      });
    }]));
    for (const [signal, handler] of interruptHandlers) process.on(signal, handler);

    function failToolSurface(check) {
      if (toolSurfaceCheck.status === "failed") return;
      toolSurfaceCheck = check;
      requestBoundedTermination({
        classification: toolSurfaceCheck.classification,
        reason: toolSurfaceCheck.reason,
        event: "projection_cli_tool_surface_mismatch",
        payload: { tool_surface_check: safeToolSurfaceTelemetry(toolSurfaceCheck) },
      });
    }

    function inspectToolSurfaceLine(line) {
      const outcome = inspectReviewerToolSurfaceLine({
        check: toolSurfaceCheck,
        expectedTools: expectedClaudeTools,
        line,
      });
      if (outcome.action === "verified") {
        toolSurfaceCheck = outcome.check;
        const safeCheck = safeToolSurfaceTelemetry(toolSurfaceCheck);
        appendActivity(context, "projection_cli_tool_surface_verified", safeCheck);
        refreshHeartbeat(context, "projection_cli_tool_surface_verified", safeCheck);
        return;
      }
      if (outcome.action === "failed") failToolSurface(outcome.check);
    }

    function observeOutputLine(stream, line) {
      const normalized = String(line).trim();
      if (isBlank(normalized)) return;
      lastOutput = {
        stream,
        observed_at: lastOutputAt,
        byte_length: Buffer.byteLength(normalized, "utf8"),
      };
      if (stream !== "stdout") return;
      let event;
      try {
        event = JSON.parse(normalized);
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      if (tool === "opencode") {
        openCodeEvents.add(normalized);
        // A no-tool review that touches any tool is outside the approved launch profile;
        // stop it now instead of waiting for the post-exit export to say so.
        if (event.type === "tool_use") {
          const toolPolicy = context.reviewer_opencode?.tool_policy;
          const used = [{ tool: typeof event.part?.tool === "string" ? event.part.tool : "unknown" }];
          if (openCodeDisallowedToolUses(toolPolicy, used).length > 0) {
            failToolSurface({
              status: "failed",
              classification: "reviewer_tool_surface_mismatch",
              reason: toolPolicy === "none" ? "opencode_tool_use_in_no_tool_mode" : "opencode_tool_use_outside_policy",
              expected_tools: [...OPENCODE_ALLOWED_TOOL_NAMES[toolPolicy]],
            });
          }
        }
      }
      if (tool === "codex") {
        codexManifestSessionEvidence ??= extractCodexReviewerSessionCandidate(event);
        if (event.type === "turn.completed" && isPlainObject(event.usage)) {
          const { input_tokens, cached_input_tokens, output_tokens } = event.usage;
          codexManifestUsage = [input_tokens, cached_input_tokens, output_tokens].every(value => Number.isSafeInteger(value) && value >= 0) && cached_input_tokens <= input_tokens
            ? { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } }
            : null;
        }
      } else if (tool === "claude" && event.type === "result") {
        claudeManifestTerminal = { type: "result", session_id: null };
        try {
          claudeManifestTerminal.session_id = (options.usageManifestSessionExtractor ?? extractReviewerSessionEntry)({ terminal: event }, "claude")?.session_id ?? null;
        } catch {
          appendActivity(context, "usage_manifest_write_failed", { window_index: options.usageManifestWindowIndex, usage_gap: "reviewer-window-session-missing", stage: "session-capture" });
        }
      }
      lastStructuredOutput = {
        observed_at: lastOutputAt,
        byte_length: Buffer.byteLength(normalized, "utf8"),
        ...foldedStructuredEventMetadata(event),
      };
    }

    function failOutputLineLimit(stream, maxLineBytes = maxReviewerOutputLineBytes, diagnostic = {}) {
      if (outputSafetyCheck.status === "failed") return;
      outputSafetyCheck = {
        status: "failed",
        classification: "reviewer_cli_failed",
        reason: "reviewer_output_line_too_large",
        stream,
        max_line_bytes: maxLineBytes,
        ...(diagnostic.byteLength === undefined ? {} : { line_bytes: diagnostic.byteLength }),
        ...(diagnostic.classificationReason === undefined
          ? {} : { classification_reason: diagnostic.classificationReason }),
      };
      requestBoundedTermination({
        classification: outputSafetyCheck.classification,
        reason: outputSafetyCheck.reason,
        event: "projection_cli_output_line_limit_exceeded",
        payload: { output_safety_check: outputSafetyCheck },
      });
    }

    // Generic live-line overflow is a control-plane memory-safety fault for every
    // reviewer and stream. Only prefix-qualified Claude stdout may enter the
    // separately bounded thinking/signature discard carriers; strict full-line closure decides discard.
    // Raw chunks reach their physical sidecars before either live parsing path.
    const outputAccumulators = {
      stdout: createReviewerOutputLineRouter({
        reviewerFamily: tool,
        stream: "stdout",
        initialByteOffset: stdoutSidecarInitialBytes,
        onLine(line) {
          inspectToolSurfaceLine(line.trim());
          observeOutputLine("stdout", line);
        },
        onOverflow({ maxBytes, ...diagnostic }) {
          failOutputLineLimit("stdout", maxBytes, diagnostic);
        },
        onDiscard(metadata, byteRange) {
          discardedStdoutThinkingRanges.push(byteRange);
          appendActivity(context, "projection_cli_thinking_line_discarded", metadata);
          refreshRunning("thinking-line-discarded", metadata);
        },
      }),
      stderr: createBoundedLineAccumulator({
        onLine(line) {
          observeOutputLine("stderr", line);
        },
        onOverflow() {
          failOutputLineLimit("stderr");
        },
      }),
    };

    function finishOutputAccumulators() {
      if (outputAccumulatorsEnded) return;
      outputAccumulatorsEnded = true;
      outputAccumulators.stdout.end();
      outputAccumulators.stderr.end();
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      lastOutputAtMs = Date.now();
      lastOutputAt = new Date(lastOutputAtMs).toISOString();
      appendFileSync(context.stdout_log_path, chunk);
      outputAccumulators.stdout.write(chunk);
      refreshRunning("stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      lastOutputAtMs = Date.now();
      lastOutputAt = new Date(lastOutputAtMs).toISOString();
      appendFileSync(context.stderr_log_path, chunk);
      outputAccumulators.stderr.write(chunk);
      refreshRunning("stderr");
    });
    child.on("error", (error) => {
      spawnError = error;
      appendActivity(context, "projection_cli_spawn_error", {
        tool,
        error: "reviewer process spawn failed",
      });
      refreshHeartbeat(context, "projection_cli_spawn_error", {
        tool,
        error: "reviewer process spawn failed",
      });
    });

    function finalize(code, signal, closeObserved) {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (statusCheckpoint) clearTimeout(statusCheckpoint);
      if (timeout) clearTimeout(timeout);
      if (terminationGraceTimer) clearTimeout(terminationGraceTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      finishOutputAccumulators();
      if (requiresClaudeToolSurfaceEvidence && childSpawned && toolSurfaceCheck.status === "pending") {
        toolSurfaceCheck = missingReviewerToolSurfaceEvidenceCheck(expectedClaudeTools);
        const safeCheck = safeToolSurfaceTelemetry(toolSurfaceCheck);
        appendActivity(context, "projection_cli_tool_surface_evidence_missing", safeCheck);
        refreshHeartbeat(context, "projection_cli_tool_surface_evidence_missing", safeCheck);
      }
      const processCloseObserved = childSpawned && closeObserved === true;
      // Everything above this point is synchronous: the settle latch is already
      // taken and every timer is already cleared, so convergence cannot be
      // re-entered and cannot race a timer it did not arm itself. The bounded
      // convergence then settles through the single `settleWith` continuation.
      void convergeReviewerTransportOnClose(child, {
        processSpawned: childSpawned,
        closeObserved: processCloseObserved,
        processGroupId: reviewerProcessGroupId,
        graceMs: terminationGrace,
        settleMs: forcedSettlementDelay,
      })
        .catch(() => ({
          confirmed: false,
          telemetry: {
            eligible: true,
            outcome: "convergence_fault",
            probes: 0,
            signals: [],
            escalated: false,
            grace_ms: null,
            settle_ms: null,
          },
        }))
        .then((convergence) => settleWith(code, signal, processCloseObserved, convergence));
    }

    function settleWith(code, signal, processCloseObserved, convergence) {
      for (const [name, handler] of interruptHandlers) process.removeListener(name, handler);
      const transportCleanupConfirmed = convergence.confirmed;
      const result = {
        code,
        signal: signal ?? null,
        timed_out: timedOut,
        spawn_error: spawnError?.message ?? null,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_log_path: context.stdout_log_path,
        stderr_log_path: context.stderr_log_path,
        tool_surface_check: toolSurfaceCheck,
        output_safety_check: outputSafetyCheck,
        discarded_stdout_thinking_ranges: discardedStdoutThinkingRanges,
        usage_manifest_evidence: {
          terminal: claudeManifestTerminal,
          codexManifestSessionEvidence,
          stdoutStructuredEvents: codexManifestUsage ? [codexManifestUsage] : [],
        },
        // Memory-only inputs for the post-exit OpenCode session proof; safeCliExit never
        // copies them into evidence.
        ...(openCodeEvents === null ? {} : {
          opencode_run_events: openCodeEvents.snapshot(),
          opencode_input_bytes: Buffer.from(packet),
        }),
        process_spawned: childSpawned,
        process_close_observed: processCloseObserved,
        transport_cleanup_confirmed: transportCleanupConfirmed,
        reviewer_transport_convergence: convergence.telemetry,
        ...(terminationState === null ? {} : {
          fault_classification: terminationState.classification,
          fault_reason: terminationState.reason,
        }),
        ...(terminationResult === null ? {} : {
          [terminationState?.is_hard_cap
            ? "hard_cap_termination"
            : "fault_termination"]: terminationResult,
        }),
        ...(terminationCallbackError === null ? {} : {
          [terminationState?.is_hard_cap
            ? "hard_cap_callback_error"
            : "fault_termination_callback_error"]: terminationCallbackError,
        }),
      };
      if (context.mode !== "pr-sticky") recordCliExited(context, result);
      resolve(result);
    }

    child.stdin.on("error", (error) => {
      appendActivity(context, "projection_cli_stdin_error", { error: error.message });
    });

    child.once("spawn", () => {
      childSpawned = true;
      reviewerProcessGroupId = reviewerProcessGroupsSupported
        && Number.isInteger(child.pid)
        && child.pid > 0
        ? child.pid
        : null;
      processStartedAtMs = Date.now();
      processStartedAt = new Date(processStartedAtMs).toISOString();
      appendActivity(context, "projection_cli_started", {
        pid: child.pid ?? null,
        tool,
        stdout_log_path: context.stdout_log_path,
        stderr_log_path: context.stderr_log_path,
      });
      refreshRunning("started");

      interval = setInterval(sampleReviewerStreamLiveness, intervalMs);
      statusCheckpoint = checkpointMs < timeoutMs
        ? setTimeout(() => {
          const payload = {
            pid: child.pid ?? null,
            checkpoint_ms: checkpointMs,
            total_timeout_ms: timeoutMs,
            stdout_bytes: stdoutBytes,
            stderr_bytes: stderrBytes,
            last_output_at: lastOutputAt,
            last_output: lastOutput,
            last_structured_output: lastStructuredOutput,
            ...idleEvidence(),
            child_open: child.exitCode === null && child.signalCode === null,
            child_exit_observed: child.exitCode !== null || child.signalCode !== null,
            next_action: "continue-until-total-hard-cap",
          };
          appendActivity(context, "projection_cli_status_checkpoint", payload);
          refreshRunning("status-checkpoint", payload);
        }, checkpointMs)
        : null;
      timeout = setTimeout(() => {
        const timeoutPayload = {
          pid: child.pid ?? null,
          total_timeout_ms: timeoutMs,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
        };
        try {
          if (typeof options.onTotalHardCap === "function") {
            options.onTotalHardCap();
          }
        } catch (error) {
          terminationCallbackError = error instanceof Error ? error.message : String(error);
        } finally {
          requestBoundedTermination({
            classification: "reviewer_cli_timeout",
            reason: "total_hard_cap_exceeded",
            isHardCap: true,
            event: "projection_cli_timeout",
            payload: timeoutPayload,
          });
        }
      }, timeoutMs);

      try {
        child.stdin.end(packet);
      } catch (error) {
        appendActivity(context, "projection_cli_stdin_error", {
          error: error.message,
        });
      }
    });

    child.on("close", (code, signal) => {
      closeObservation = { code, signal };
      finishOutputAccumulators();
      if (
        terminationState !== null
        && supportsReviewerProcessGroups()
        && terminationState.escalated === false
      ) {
        return;
      }
      finalize(code, signal, true);
    });
  });
}

function recordCliExited(context, result) {
  const safeResult = safeCliExit(result);
  appendActivity(context, "projection_cli_exited", safeResult);
  refreshHeartbeat(context, "projection_cli_exited", safeResult);
}

function parseCompletionObject(context, completionText) {
  const parsed = parseCompletionObjectWithoutGuarantee(context, completionText);
  if (parsed.status !== "accepted") return parsed;
  try {
    if (!guaranteeAssessmentRequired(context)) return parsed;
    const assessment = readReviewGuaranteeAssessment(parsed.completion.reason, {
      reviewedTarget: guaranteeReviewedTarget(context),
      dispatchId: context.dispatch_id,
      ...(Array.isArray(parsed.completion.findings) ? { findingIds: parsed.completion.findings.map(finding => finding.summary_id) } : {}),
    });
    if (assessment.requires_clarification) return { status: "malformed", diagnostic: "review guarantee assessment requires clarification" };
    return { ...parsed, guarantee_assessment: { next_actions: assessment.next_actions, requires_tl_ruling: assessment.requires_tl_ruling } };
  } catch (error) {
    return { status: "malformed", diagnostic: error.message };
  }
}

function parseCompletionObjectWithoutGuarantee(context, completionText) {
  if (typeof completionText !== "string") return { status: "malformed" };
  let completion;
  try {
    completion = JSON.parse(completionText);
  } catch {
    return { status: "malformed" };
  }
  if (
    completion
    && typeof completion === "object"
    && !Array.isArray(completion)
    && (
      !Object.hasOwn(completion, "reason")
      || (typeof completion.reason === "string" && completion.reason.trim() === "")
    )
  ) {
    return { status: "reason-missing" };
  }
  if (context.page_window_checkpoint_handoff === true
    || context.review_material?.window_role === "intermediate"
    || context.review_material?.window_role === "final") {
    return parsePageWindowCompletionObject(completion, {
      headRefOid: String(context.head_ref_oid ?? "none"),
      dispatchId: context.dispatch_id,
      expectedWindowIndex: context.page_window_index,
      expectedPageIndices: Array.isArray(context.review_material?.pages)
        ? context.review_material.pages.map((page) => page.index)
        : undefined,
    });
  }
  const expectedKeys = [
    "sticky_comment_url",
    "verdict",
    "last_reviewed_sha",
    "reviewer_model",
    "reason",
  ];
  if (
    !completion
    || typeof completion !== "object"
    || Array.isArray(completion)
    || Object.keys(completion).length !== expectedKeys.length
    || Object.keys(completion).some((key, index) => key !== expectedKeys[index])
    || expectedKeys.some((key) => typeof completion[key] !== "string")
    || expectedKeys.some((key) => completion[key].trim() === "")
    || completion.reason !== completion.reason.trim()
    || Buffer.byteLength(completion.reason, "utf8") > verdictReasonByteCap
  ) {
    return { status: "malformed" };
  }
  if (context.mode === "audit-only" && completion.sticky_comment_url !== "none") {
    return { status: "malformed" };
  }
  if (completion.last_reviewed_sha !== String(context.head_ref_oid ?? "none")) {
    return { status: "stale", completion };
  }
  if (completion.verdict === "PASS" || completion.verdict === "WARN") {
    return { status: "accepted", completion };
  }
  if (completion.verdict === "UNAVAILABLE" || completion.verdict === "CRITICAL") {
    return { status: "blocking-verdict", completion };
  }
  return { status: "malformed" };
}

function normalizeClaudeCompletionTrailer(completionText) {
  if (typeof completionText !== "string") return completionText;
  return completionText.replace(/(?:\s*<\/invoke>\s*)$/, "");
}

function parseClaudeCompletion(context, terminalResult) {
  if (!terminalResult || terminalResult.type !== "result") {
    return { status: "missing" };
  }
  if (terminalResult.subtype !== "success" || terminalResult.is_error !== false) {
    return { status: "not-successful" };
  }
  return parseCompletionObject(
    context,
    normalizeClaudeCompletionTrailer(terminalResult.result),
  );
}

function parseCodexCompletion(context, structuredEvents) {
  const terminalMessage = structuredEvents.findLast((event) => (
    event?.type === "item.completed"
    && event?.item?.type === "agent_message"
  ));
  if (!terminalMessage) return { status: "missing" };
  return parseCompletionObject(context, terminalMessage.item.text);
}

function parseReviewerCompletion(context, boundedEvidence) {
  if (context.reviewer_cli_recipe?.tool === "claude") {
    return parseClaudeCompletion(context, boundedEvidence.terminal);
  }
  if (context.reviewer_cli_recipe?.tool === "codex") {
    return parseCodexCompletion(context, boundedEvidence.stdoutStructuredEvents);
  }
  if (context.reviewer_cli_recipe?.tool === "opencode") {
    // Only the report bytes the dispatched session's export proved can be a completion.
    return typeof boundedEvidence.openCodeReport === "string"
      ? parseCompletionObject(context, boundedEvidence.openCodeReport)
      : { status: "missing" };
  }
  return { status: "missing" };
}

function usableStreamReviewerModel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // D7 (r2 finding F-srms-pr2-01): "present but unusable" MUST degrade exactly
  // like absent. isUsableIdentityFieldValue is the record writer's OWN rule, so
  // whatever survives here is something assertReviewerModelRecord() will accept
  // -- the writer can no longer throw on content and take the dispatch's
  // receipts down with it, because D12 orders the record write before every
  // seal and that throw would end a finished review as `blocked` with no
  // receipt at all. Previously only the placeholder half of this was filtered,
  // and only on the claude side.
  if (trimmed === "" || isReviewerModelPlaceholder(value) || !isUsableIdentityFieldValue(trimmed)) {
    return null;
  }
  return trimmed;
}

function resolveUniqueReviewerModelTier(candidates) {
  const identities = new Set(candidates.map(usableStreamReviewerModel).filter(Boolean));
  if (identities.size === 0) return { decisive: false, identity: null };
  if (identities.size === 1) return { decisive: true, identity: identities.values().next().value };
  return { decisive: true, identity: null };
}

// D5 (tasks.md item 9): four independent hard scan-budget caps -- depth/size
// are deliberately NOT a budget (design.md D5 r1 F-srms-r1-04): "this is our
// own isolated home" is a current-moment assumption, not a mechanical limit.
// Any cap tripped stops the scan and returns unavailable; MUST NOT return a
// partial result (that would silently become an unlabeled sample).
const CODEX_ROLLOUT_SCAN_MAX_ENTRIES_PER_LEVEL = 64;
const CODEX_ROLLOUT_SCAN_MAX_CANDIDATE_FILES = 8;
const CODEX_ROLLOUT_SCAN_MAX_TOTAL_BYTES = 1024 * 1024;
// Global visited ceiling: a YYYY/MM/DD tree can stay under per-level caps
// while still walking unbounded directories. Cap list() calls so the scan
// cannot become an unlabeled sample across many shallow directories.
const CODEX_ROLLOUT_SCAN_MAX_LIST_CALLS = 32;

// Bounded line-by-line parse of one rollout file (not JSON.parse of the whole
// file, design.md D5 "bounded"). Multiple turn_context lines can appear across
// a multi-turn rollout; the LAST one in this file wins, same "last thread/turn"
// ordering as the pre-D5 stream-based extraction it replaces. (Ordering ACROSS
// files is the caller's job -- it sorts the candidate paths first, since
// readdirSync() order would otherwise decide which file is "last".) Returns
// null when the text carries no usable turn_context model -- callers MUST NOT
// read that as a model, and MUST leave any earlier file's result standing.
function lastTurnContextModel(text) {
  let found = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "turn_context" && typeof event.payload?.model === "string") {
      const trimmed = event.payload.model.trim();
      if (trimmed !== "") found = trimmed;
    }
  }
  return found;
}

// D5: codex observed identity comes from the isolated CODEX_HOME's own rollout
// execution record, joined by thread_id -- NOT from the `--json` stream (which
// never carries a `model` field on real codex, design.md Context §3). MUST
// NOT read the operator's real ~/.codex when no isolated home was clamped for
// this dispatch (`codexHomePath` absent/empty) -- there is deliberately no
// `homedir()` call anywhere on this path (D5 MUST NOT / T9 D7).
function resolveCodexObservedModelFromRollout({
  codexHomePath,
  threadId,
  readdirSyncImpl = readdirSync,
  statSyncImpl = statSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (typeof codexHomePath !== "string" || codexHomePath.length === 0) {
    return { model: null, source: null, reason: "reviewer_home_not_isolated" };
  }
  if (typeof threadId !== "string" || threadId.length === 0) {
    return { model: null, source: null, reason: "rollout_not_found" };
  }
  const sessionsRoot = path.join(codexHomePath, "sessions");
  const suffix = `-${threadId}.jsonl`;
  const candidates = [];
  let overBudget = false;
  let listCalls = 0;

  const list = (dirPath) => {
    if (overBudget) return [];
    listCalls += 1;
    if (listCalls > CODEX_ROLLOUT_SCAN_MAX_LIST_CALLS) {
      overBudget = true;
      return [];
    }
    let entries;
    try {
      entries = readdirSyncImpl(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    if (entries.length > CODEX_ROLLOUT_SCAN_MAX_ENTRIES_PER_LEVEL) {
      overBudget = true;
      return [];
    }
    return entries;
  };

  for (const yearEntry of list(sessionsRoot)) {
    if (overBudget) break;
    if (!yearEntry.isDirectory()) continue;
    const yearDir = path.join(sessionsRoot, yearEntry.name);
    for (const monthEntry of list(yearDir)) {
      if (overBudget) break;
      if (!monthEntry.isDirectory()) continue;
      const monthDir = path.join(yearDir, monthEntry.name);
      for (const dayEntry of list(monthDir)) {
        if (overBudget) break;
        if (!dayEntry.isDirectory()) continue;
        const dayDir = path.join(monthDir, dayEntry.name);
        for (const fileEntry of list(dayDir)) {
          if (overBudget) break;
          if (!fileEntry.isFile()) continue;
          if (!fileEntry.name.startsWith("rollout-") || !fileEntry.name.endsWith(suffix)) continue;
          candidates.push(path.join(dayDir, fileEntry.name));
          if (candidates.length > CODEX_ROLLOUT_SCAN_MAX_CANDIDATE_FILES) {
            overBudget = true;
            break;
          }
        }
      }
    }
  }

  if (overBudget) {
    return { model: null, source: null, reason: "rollout_scan_budget_exceeded" };
  }
  if (candidates.length === 0) {
    return { model: null, source: null, reason: "rollout_not_found" };
  }

  // readdirSync() guarantees no order, so "the last candidate wins" below would
  // otherwise mean "last in filesystem order" (r1 finding F-srms-pr-06). Sorting
  // the full paths makes it mean "latest": every level is zero-padded
  // (`sessions/<YYYY>/<MM>/<DD>/`) and the file name carries an ISO timestamp
  // (`rollout-<ISO>-<thread-id>.jsonl`), so lexicographic order is chronological.
  candidates.sort();

  let totalBytes = 0;
  let lastModel = null;
  for (const candidatePath of candidates) {
    let size;
    try {
      size = statSyncImpl(candidatePath).size;
    } catch {
      continue;
    }
    totalBytes += size;
    if (totalBytes > CODEX_ROLLOUT_SCAN_MAX_TOTAL_BYTES) {
      return { model: null, source: null, reason: "rollout_scan_budget_exceeded" };
    }
    let text;
    try {
      text = readFileSyncImpl(candidatePath, "utf8");
    } catch {
      continue;
    }
    const fileModel = lastTurnContextModel(text);
    if (fileModel !== null) lastModel = fileModel;
  }
  if (lastModel !== null) {
    return { model: lastModel, source: "isolated-home-rollout", reason: null };
  }
  return { model: null, source: null, reason: "rollout_unparsable" };
}

// Deliberately narrow test seam so tests can exercise the four scan-budget
// caps without materializing 64+/8+/1MiB+/32-list-call real fixture trees.
export const __testCodexRolloutScan = Object.freeze({
  resolveCodexObservedModelFromRollout,
  MAX_ENTRIES_PER_LEVEL: CODEX_ROLLOUT_SCAN_MAX_ENTRIES_PER_LEVEL,
  MAX_CANDIDATE_FILES: CODEX_ROLLOUT_SCAN_MAX_CANDIDATE_FILES,
  MAX_TOTAL_BYTES: CODEX_ROLLOUT_SCAN_MAX_TOTAL_BYTES,
  MAX_LIST_CALLS: CODEX_ROLLOUT_SCAN_MAX_LIST_CALLS,
});

function extractExecutionStreamReviewerModel(boundedEvidence, { tool, codexHomePath } = {}) {
  if (tool === "claude") {
    const events = Array.isArray(boundedEvidence?.stdoutStructuredEvents)
      ? boundedEvidence.stdoutStructuredEvents
      : [];
    const directAssistantTier = resolveUniqueReviewerModelTier(events
      .filter((event) => (
        event?.type === "assistant"
        && Object.hasOwn(event, "parent_tool_use_id")
        && event.parent_tool_use_id === null
        && isPlainObject(event.message)
        && Object.hasOwn(event.message, "model")
      ))
      .map((event) => event.message?.model));
    if (directAssistantTier.decisive) return directAssistantTier.identity;

    const directInitTier = resolveUniqueReviewerModelTier(events
      .filter((event) => (
        event?.type === "system"
        && event?.subtype === "init"
        && !Object.hasOwn(event, "parent_tool_use_id")
        && Object.hasOwn(event, "model")
      ))
      .map((event) => event.model));
    if (directInitTier.decisive) return directInitTier.identity;

    const terminal = boundedEvidence?.terminal;
    if (!terminal || terminal.type !== "result" || !isPlainObject(terminal.modelUsage)) {
      return null;
    }
    return resolveUniqueReviewerModelTier(Object.keys(terminal.modelUsage)).identity;
  }
  if (tool === "codex") {
    return resolveCodexObservedIdentity(boundedEvidence, codexHomePath).model;
  }
  return null;
}

// D5/D6: `thread.started.thread_id` is the ONLY field this module still reads
// off the codex `--json` stream for identity purposes -- it is the join key
// into the isolated home's own rollout record (design.md D5 "join key"), not
// a source of the model value itself (real codex --json never carries
// `model` on either event, design.md Context §3 -- the pre-D5 branch that
// read `thread.started.model`/`turn.completed.model` never actually fired).
function codexThreadIdFromStream(boundedEvidence) {
  const events = Array.isArray(boundedEvidence?.stdoutStructuredEvents)
    ? boundedEvidence.stdoutStructuredEvents
    : [];
  const lastThread = events.findLast((event) => event?.type === "thread.started");
  return typeof lastThread?.thread_id === "string" && lastThread.thread_id.length > 0
    ? lastThread.thread_id
    : null;
}

// D7/D12: the richer sibling of extractExecutionStreamReviewerModel() that
// also carries WHY the model is unavailable, for the reviewer-model-record's
// observed_source/observed_unavailable_reason fields (item 12/13). The plain
// extractExecutionStreamReviewerModel() above stays string|null-only for its
// existing callers (streamIdentity / applyExecutionStreamReviewerModel);
// this function is the single place both facts are computed together so they
// cannot drift (same reasoning as D1's single resolver).
function resolveCodexObservedIdentity(boundedEvidence, codexHomePath) {
  const threadId = codexThreadIdFromStream(boundedEvidence);
  const resolved = resolveCodexObservedModelFromRollout({ codexHomePath, threadId });
  // D7 (r2 finding F-srms-pr2-01): a rollout value that is PRESENT but
  // placeholder-shaped, control-bearing, or over the identity-field byte bound
  // is not an observed model -- it is an unparsable rollout, and it takes the
  // same closed-set degrade as an absent one. The codex branch used to hand it
  // straight to the record writer; the claude branch has always run its value
  // through usableStreamReviewerModel(). RK-3 already concedes the rollout
  // format is not a stable contract, so this is the anticipated drift landing
  // on D7's side instead of blocking the dispatch.
  const usable = usableStreamReviewerModel(resolved.model);
  if (resolved.model !== null && usable === null) {
    return { model: null, source: null, reason: "rollout_unparsable" };
  }
  return { model: usable, source: resolved.source, reason: resolved.reason ?? "none" };
}

function resolveClaudeObservedIdentity(boundedEvidence) {
  const model = extractExecutionStreamReviewerModel(boundedEvidence, { tool: "claude" });
  return model === null
    ? { model: null, source: null, reason: "stream_identity_absent" }
    : { model, source: "execution-stream", reason: "none" };
}

// D7/D12/D13 (tasks.md items 10/12/13): the single place that answers "what is
// this dispatch's observed model, and if unavailable, why" for BOTH families,
// gathering the three record fields (observed_model/observed_source/
// observed_unavailable_reason) in one pass so no caller re-derives them.
// MUST NOT be conflated with `reviewerModelForUsageManifest` (D12 r4
// F-srms-r4-02): that variable can retain a legal self-report when this
// resolver returns unavailable (D6's finalized-identity fallback), and a
// self-report MUST NOT be written into the record's observed_* fields (D7).
function resolveReviewerObservedIdentity(boundedEvidence, { tool, codexHomePath } = {}) {
  if (tool === "codex") return resolveCodexObservedIdentity(boundedEvidence, codexHomePath);
  if (tool === "claude") return resolveClaudeObservedIdentity(boundedEvidence);
  return { model: null, source: null, reason: "stream_identity_absent" };
}

// OpenCode observed identity comes only from the dispatched session's own export. A
// divergent model is still recorded as observed (the record then says "divergent"); no
// export at all, or a pair that cannot form a legal selector, degrades to a closed reason.
function resolveOpenCodeObservedIdentity(check) {
  const selector = usableStreamReviewerModel(check?.observed?.selector);
  if (selector !== null) return { model: selector, source: "session-export", reason: "none" };
  // "unavailable" means no usable export exists: it was never attempted (the run or its events
  // were already unusable, stage "run") or its command failed. Only an export that was produced
  // and then did not prove the dispatched facts is "invalid".
  const neverExported = check?.stage === "run" || check?.classification === "opencode_export_unavailable";
  const exportInvalid = check?.status === "failed" && !neverExported;
  return {
    model: null,
    source: null,
    reason: exportInvalid ? "export_invalid" : "export_unavailable",
  };
}

// D13 (tasks.md item 13): the five-value closed-set judgment, evaluated
// top-down with the first matching branch short-circuiting (design.md D13
// table). `requestedKind` MUST already be the value D1's resolver would have
// produced (never re-derived here from `reviewer_family` -- design.md D13
// "MUST NOT 另起任何 family→kind 的推導").
function deriveReviewerModelAgreement({ requestedModel, requestedKind, observedModel }) {
  if (observedModel === null) return "unavailable";
  if (observedModel === requestedModel) return "exact";
  if (requestedKind === "exact-id") return "divergent";
  if (requestedKind === "alias") return "alias-expansion-expected";
  return "differs-unverified";
}

function applyExecutionStreamReviewerModel(boundedEvidence, parsed, { tool } = {}) {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.completion)) return parsed;
  // r2 finding F-srms-pr2-02: codex has exactly ONE observed-identity
  // derivation -- the isolated-home rollout join (D5) -- and this path (the
  // classification-only fallback in classifyCliExit) has no isolated home to
  // give it. Returning early states that, instead of letting the same answer
  // fall out of omitting an optional codexHomePath argument, which would leave
  // two codex derivations free to drift apart. Behaviour is unchanged: the
  // omitted-argument form already resolved to reviewer_home_not_isolated ->
  // null, and `null ?? existing` kept whatever the completion carried.
  if (tool === "codex") return parsed;
  const streamIdentity = extractExecutionStreamReviewerModel(boundedEvidence, { tool });
  parsed.completion.reviewer_model = streamIdentity ?? parsed.completion.reviewer_model;
  return parsed;
}

function partitionBoundedEvidence(text, { collectStructured = false } = {}) {
  const structuredEvents = [];
  const unstructuredLines = [];
  const unmatchedCandidateLines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (collectStructured && event && typeof event === "object" && !Array.isArray(event)) {
        structuredEvents.push(event);
      }
      // Parsed JSON is provider/reviewer data. Only allowlisted structured
      // control fields may affect control flow; never phrase-scan its text.
      continue;
    } catch {
      // Malformed JSON-shaped provider/reviewer data is not a CLI diagnostic.
    }
    if (/permission_denials|permission denial|permission denied|requires approval/i.test(line)) {
      unmatchedCandidateLines.push(line);
    }
    if (line.startsWith("{") || line.startsWith("[") || line.startsWith('"')) continue;
    unstructuredLines.push(line);
  }
  return { structuredEvents, unstructuredLines, unmatchedCandidateLines };
}

function normalizedDiscardedByteRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  return ranges.filter((range) => (
    Number.isSafeInteger(range?.start_byte)
    && Number.isSafeInteger(range?.end_byte)
    && range.start_byte >= 0
    && range.end_byte >= range.start_byte
  ));
}

function retainTailRelevantByteRanges(ranges, tailStartByte) {
  const normalized = normalizedDiscardedByteRanges(ranges);
  if (!Number.isSafeInteger(tailStartByte) || tailStartByte < 0) return [];
  return normalized.filter((range) => range.end_byte > tailStartByte);
}

function partialSegmentOverlapsDiscardedRange(segment, ranges) {
  return ranges.some((range) => (
    range.start_byte < segment.end_byte && range.end_byte > segment.start_byte
  ));
}

function extractBoundedTerminalEvidence(context, { discardedStdoutRanges = [] } = {}) {
  const stdoutTail = readBoundedTailEvidence(context.stdout_log_path);
  const stderrTail = readBoundedTailEvidence(context.stderr_log_path);
  const safeDiscardedStdoutRanges = normalizedDiscardedByteRanges(discardedStdoutRanges);
  const stdoutEvidence = partitionBoundedEvidence(
    stdoutTail.completeText,
    { collectStructured: true },
  );
  const stderrEvidence = partitionBoundedEvidence(
    stderrTail.completeText,
    { collectStructured: true },
  );
  return {
    structuredEvents: [
      ...stdoutEvidence.structuredEvents,
      ...stderrEvidence.structuredEvents,
    ],
    stdoutStructuredEvents: stdoutEvidence.structuredEvents,
    // D4 point 1 (R5; tasks.md T25-T26): callers so far only need the stdout tail's
    // truncation state — stdout is where Codex's item.* event stream lives (design.md
    // D4 "截斷偵測" is phrased in terms of stdout_log_path specifically).
    stdoutTruncated: stdoutTail.truncated === true,
    // D2 (R1; fix-projection-completion-truncation): additive stdout-tail shape fields,
    // derived from the SAME bounded read as everything above (no second I/O, no whole-log
    // scan). `stdoutLastStructuredEvent` is the folded description of the last complete
    // structured stdout event, or null when the window holds none.
    stdoutEndsWithNewline: stdoutTail.endsWithNewline === true,
    stdoutTrailingPartialBytes: Number.isInteger(stdoutTail.trailingPartialBytes)
      ? stdoutTail.trailingPartialBytes
      : 0,
    stdoutLastStructuredEvent: stdoutEvidence.structuredEvents.length > 0
      ? foldedStructuredEventMetadata(stdoutEvidence.structuredEvents.at(-1))
      : null,
    terminal: stdoutEvidence.structuredEvents.findLast(
      (event) => event.type === "result" || event.type === "error",
    ) ?? null,
    unstructuredText: stdoutEvidence.unstructuredLines.join("\n"),
    stderrText: stderrEvidence.unstructuredLines.join("\n"),
    unmatchedCandidateText: [
      ...stdoutEvidence.unmatchedCandidateLines,
      ...stderrEvidence.unmatchedCandidateLines,
      ...stdoutTail.partialSegments
        .filter((segment) => !partialSegmentOverlapsDiscardedRange(
          segment,
          safeDiscardedStdoutRanges,
        ))
        .map((segment) => segment.text),
      ...stderrTail.partialSegments.map((segment) => segment.text),
    ].filter((line) => (
      /permission_denials|permission denial|permission denied|requires approval/i.test(line)
    )).join("\n"),
  };
}

// Deliberately empty until a provider publishes a stable, exact complete-line
// diagnostic contract. Near matches can only produce the closed unknown class.
const approvedExactPermissionDenialMatchers = Object.freeze([]);

// D4 (R5; tasks.md T25-T26) — write-class item-type allowlist. Seeded ONLY from FR-B7's
// one-time real `codex exec --json` run (fr-b7-evidence.md, T18 — the two `item.type`
// values actually observed in that run's `item.completed`/`item.started` events). Any
// item type outside this recognized set is unproven vocabulary and MUST fail closed to
// `unknown` (design.md D4 point 3), never be guessed into either bucket. Mirrors the
// `approvedExactPermissionDenialMatchers` empty-allowlist precedent immediately above:
// start from only what has been proven, not what seems plausible.
const recognizedCodexItemTypes = Object.freeze([
  // Pre-existing vocabulary (parseCodexCompletion above); not write-class.
  "agent_message",
  // FR-B7 first-hand evidence (fr-b7-evidence.md §5): observed as `item.started`
  // (status: in_progress) then `item.completed` (status: completed) for a shell command
  // the reviewer executed. The only write-class item type observed to date.
  "command_execution",
]);
const writeClassCodexItemTypes = Object.freeze([
  "command_execution",
]);

// D4 point 2 (R5): only `item.completed`/`item.started` top-level events carry an
// `item.type` at all (FR-B7's other observed top-level types — thread.started,
// turn.started, turn.completed — carry no `item` and contribute no vocabulary either
// way); those non-item top-level types are simply skipped. But an event that IS
// `item.completed`/`item.started` and whose `item` is malformed (not a plain object, or
// no string `type`) is fail-closed to unrecognized rather than skipped: FR-B7's real shape
// always pairs these top-level types with a well-formed `item` object is an assumption
// about the observed run, not a guarantee about every stream, and treating a malformed
// pairing as "no evidence either way" would let it silently pass condition 3 below and
// falsely support `reviewer_environment_claim_uncorroborated` on a truncated/malformed
// stream — exactly the false accusation design.md D4 exists to prevent.
function reviewerEnvironmentClaimItemTypeVocabulary(structuredEvents) {
  let hasUnrecognizedItemType = false;
  let hasWriteClassItemType = false;
  for (const event of structuredEvents ?? []) {
    if (event?.type !== "item.completed" && event?.type !== "item.started") continue;
    const item = event?.item;
    if (item === null || typeof item !== "object" || Array.isArray(item)
      || typeof item.type !== "string") {
      hasUnrecognizedItemType = true;
      continue;
    }
    const itemType = item.type;
    if (!recognizedCodexItemTypes.includes(itemType)) {
      hasUnrecognizedItemType = true;
      continue;
    }
    if (writeClassCodexItemTypes.includes(itemType)) {
      hasWriteClassItemType = true;
    }
  }
  return { hasUnrecognizedItemType, hasWriteClassItemType };
}

// D4/D5 (R5; tasks.md T25-T26) — "reviewer_environment_claim_uncorroborated". Falsifies
// (or rather, refuses to falsify without proof) the Contrarian risk brd.md/design.md D4
// names: "零筆 write-class 事件 ⇒ reviewer 未曾嘗試寫入" does not hold when the event
// stream is truncated, and a false accusation against an honest reviewer is worse than
// staying silent. This is a pure function — reads ONLY allowlisted structured fields
// (`mode`, `tool`, the reviewer's own typed `verdict`, the truncation flag, and item.type
// vocabulary); it MUST NOT read or pattern-match the reviewer's free-text `reason` field,
// which is not even part of this function's input shape.
//
// Applicability gate (not part of the four D4 conditions below): only pr-sticky mode,
// only when the reviewer's own completion verdict is UNAVAILABLE. Outside that scope the
// question this diagnostic answers ("did the reviewer's environment actually let it try
// to write, when it claims otherwise") is not meaningful, so the result is `null` — not
// applicable, distinct from `unknown` (checked but inconclusive).
//
// Within that scope, exactly four conditions gate `reviewer_environment_claim_uncorroborated`;
// any single one failing fails closed to `unknown` (design.md D4 point 3: "任一成立即判
// unknown，不得輸出「主張未獲佐證」"), never a bare absence/silence:
//   1. the event stream is provably complete (not truncated per readBoundedTailEvidence)
//   2. the reviewer's tool is Codex — write-class vocabulary above was only ever proven
//      for Codex's `item.*` event shape (fr-b7-evidence.md is a Codex run); a tool whose
//      write-class vocabulary has never been observed is unproven, not corroborating.
//   3. every observed item type is allowlist-recognized (an unrecognized item type present
//      means unknown, not a free pass)
//   4. zero write-class events observed (a write-class event present means the reviewer's
//      environment evidently did let it attempt a write — not uncorroborated, and not
//      silently ignored either: still `unknown`, since this function only ever answers
//      "was the reviewer's claim corroborated", not "did the reviewer actually write")
// ...and B2's write-capability preflight (T23-T24) already proved the surface writable —
// passed in as `preflightProvedWritable`, sourced from the in-scope probe result rather
// than re-read from the activity log (the caller already holds this fact once).
function classifyReviewerEnvironmentClaimCorroboration({
  mode,
  tool,
  verdict,
  stdoutTruncated,
  stdoutStructuredEvents,
  preflightProvedWritable,
}) {
  if (mode !== "pr-sticky" || verdict !== "UNAVAILABLE") return null;
  if (tool !== "codex") return "unknown";
  if (stdoutTruncated === true) return "unknown";
  if (preflightProvedWritable !== true) return "unknown";
  const vocabulary = reviewerEnvironmentClaimItemTypeVocabulary(stdoutStructuredEvents);
  if (vocabulary.hasUnrecognizedItemType) return "unknown";
  if (vocabulary.hasWriteClassItemType) return "unknown";
  return "reviewer_environment_claim_uncorroborated";
}

// Deliberately narrow test seam for the D4 environment-claim-corroboration diagnostic
// (R5; tasks.md T25-T26) — mirrors the shape of the other __test* seams in this module.
export const __testEnvironmentClaimCorroboration = Object.freeze({
  classifyReviewerEnvironmentClaimCorroboration,
  recognizedCodexItemTypes,
  writeClassCodexItemTypes,
});

function redactedEvidenceExcerpt(value) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length <= maxOrchestrationEvidenceExcerptBytes) return bytes.toString("utf8");
  let end = maxOrchestrationEvidenceExcerptBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function orchestrationUnknownEvidence() {
  return {
    classification: "reviewer_orchestration_unknown",
    evidence_provenance: "provider_candidate_unmatched",
    evidence_confidence: "indeterminate",
    matcher_id: "none",
    denied_action_class: "unknown",
    redacted_excerpt: "unapproved provider orchestration-control candidate",
  };
}

function classifyReviewerOrchestrationEvidence(boundedEvidence) {
  const isIdentity = (value, maximumBytes = 256) => (
    typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximumBytes
  );
  const isPlainObject = (value) => (
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  const sdkDenials = [];
  const systemDenials = [];
  let hasUnapprovedStructuredCandidate = false;
  for (const event of boundedEvidence.structuredEvents) {
    if (!isPlainObject(event)) continue;
    if (Object.hasOwn(event, "permission_denials")) {
      const denials = event.permission_denials;
      const approvedResultEnvelope = event.type === "result"
        && isIdentity(event.uuid)
        && isIdentity(event.session_id)
        && Array.isArray(denials);
      const approvedDenials = approvedResultEnvelope
        && denials.length > 0
        && denials.every((denial) => (
          isPlainObject(denial)
          && isIdentity(denial.tool_name, 128)
          && isIdentity(denial.tool_use_id)
          && Object.hasOwn(denial, "tool_input")
          && isPlainObject(denial.tool_input)
        ));
      if (approvedDenials) sdkDenials.push(...denials);
      else if (!(approvedResultEnvelope && denials.length === 0)) {
        hasUnapprovedStructuredCandidate = true;
      }
    }
    if (event.type === "system" && event.subtype === "permission_denied") {
      const approved = isIdentity(event.tool_name, 128)
        && isIdentity(event.tool_use_id)
        && isIdentity(event.message)
        && isIdentity(event.uuid)
        && isIdentity(event.session_id);
      if (approved) systemDenials.push(event);
      else hasUnapprovedStructuredCandidate = true;
    }
  }
  const approvedDenials = sdkDenials.length > 0 ? sdkDenials : systemDenials;
  if (approvedDenials.length > 0) {
    const tools = [...new Set(approvedDenials.map((denial) => denial.tool_name))];
    const matcherId = sdkDenials.length > 0
      ? "anthropic.claude-agent-sdk.SDKPermissionDenial.v0.3.212"
      : "anthropic.claude-agent-sdk.system.permission_denied.v0.3.212";
    return {
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: matcherId,
      denied_action_class: tools.map((tool) => `tool:${tool}`).join(",").slice(0, 256),
      redacted_excerpt: redactedEvidenceExcerpt(
        `provider denied ${tools.map((tool) => `tool:${tool}`).join(",")}`
      ),
    };
  }

  if (hasUnapprovedStructuredCandidate || boundedEvidence.unmatchedCandidateText) {
    for (const matcher of approvedExactPermissionDenialMatchers) {
      if (matcher.test(boundedEvidence.unmatchedCandidateText)) {
        return matcher.evidence;
      }
    }
    return orchestrationUnknownEvidence();
  }
  return null;
}

function terminalHasExplicitAuthenticationFailure(terminal) {
  if (!terminal || (terminal.type !== "result" && terminal.type !== "error")) return false;
  const statusValues = [
    terminal.status,
    terminal.status_code,
    terminal.statusCode,
    terminal.api_error_status,
    terminal.error?.status,
    terminal.error?.status_code,
    terminal.error?.statusCode,
    terminal.error?.api_error_status,
  ];
  if (statusValues.some((status) => [401, 403].includes(Number(status)))) return true;

  const explicitFields = [
    terminal.subtype,
    terminal.code,
    terminal.error_code,
    terminal.error_type,
    terminal.terminal_reason,
    terminal.error?.type,
    terminal.error?.code,
  ];
  return explicitFields.some((value) => (
    /^(?:authentication_failed|authentication_error|not_logged_in|unauthorized)$/i.test(String(value ?? ""))
  ));
}

function terminalIsReviewerCliRecipeIncompatible(terminal) {
  if (!terminal || (terminal.type !== "result" && terminal.type !== "error")) return false;
  const statusValues = [
    terminal.status,
    terminal.status_code,
    terminal.statusCode,
    terminal.api_error_status,
    terminal.error?.status,
    terminal.error?.status_code,
    terminal.error?.statusCode,
    terminal.error?.api_error_status,
  ];
  if (!statusValues.some((status) => Number(status) === 400)) return false;

  // Only typed terminal control fields participate. Reviewer-owned packet/data-plane
  // content remains opaque and is never phrase-scanned for orchestration decisions.
  const typedFields = [
    terminal.message,
    terminal.subtype,
    terminal.code,
    terminal.error_code,
    terminal.error_type,
    terminal.terminal_reason,
    terminal.error?.message,
    terminal.error?.type,
    terminal.error?.code,
  ];
  return typedFields.some((value) => {
    const text = String(value ?? "");
    const explicitRecipeSelector = /(?:--(?:effort|thinking|reasoning)\b|\b(?:effort|thinking|reasoning)\b\s*(?:['":=]\s*)?(?:low|medium|high|max|xhigh)\b|\b(?:effort|thinking|reasoning)\s+(?:option|parameter|flag|setting|configuration|config|value)\b|\b(?:option|parameter|flag|setting|configuration|config)\s+(?:for\s+)?(?:effort|thinking|reasoning)\b)/i;
    return explicitRecipeSelector.test(text)
      && /\b(?:unsupported|not supported|invalid|unknown|not allowed|incompatible|unrecognized)\b/i.test(text);
  });
}

function terminalIsGenericFailure(terminal) {
  return terminal?.type === "error"
    || terminal?.is_error === true
    || terminal?.api_error_status != null
    || terminal?.terminal_reason === "api_error";
}

// Codex only. A bare notice carries no typed control field: its own keys are within
// {type, message}. Reads key names and the JSON type of `message`; never message text.
function isBareCodexErrorNotice(event) {
  return isPlainObject(event)
    && event.type === "error"
    && Object.keys(event).every((key) => key === "type" || key === "message")
    && (!Object.hasOwn(event, "message") || typeof event.message === "string");
}

// Codex only. Decides by event type, own key names, and stdout order; never reads
// message text and never depends on how many notices exist.
function classifyCodexTurnClosing(stdoutStructuredEvents) {
  const events = stdoutStructuredEvents ?? [];
  const closingIndex = events.findLastIndex(
    (event) => event?.type === "turn.completed" || event?.type === "turn.failed",
  );
  if (closingIndex < 0) return "none";
  if (events[closingIndex].type === "turn.failed") return "turn_failed";
  const isTerminalCandidate = (event) => event?.type === "result" || event?.type === "error";
  const lastCandidateIndex = events.findLastIndex(isTerminalCandidate);
  return lastCandidateIndex >= 0
    && lastCandidateIndex < closingIndex
    && events.every((event) => !isTerminalCandidate(event) || isBareCodexErrorNotice(event))
    ? "bare_notices_superseded"
    : "none";
}

// D2/D3 (R1; fix-projection-completion-truncation) — which reviewer families owe a
// terminal completion object at all. One predicate so the classifier, the completion
// diagnostic, and the non-authoritative carrier can never disagree about the trigger set.
function reviewerCompletionRequired(tool) {
  return tool === "claude" || tool === "codex" || tool === "opencode";
}

// D2 (R1) — closed vocabulary for the observed end of the reviewer stdout archive. Derived
// ONLY from the existing bounded-tail read (≤ BOUNDED_TAIL_EVIDENCE_MAX_BYTES, complete
// lines) plus the already-counted `cliResult.stdout_bytes`; no extra read, no whole-log
// scan. `no_bytes` is the absence of any truncation evidence; `partial_line` is output cut
// mid-write (archive tail not LF-terminated); `mid_turn_stream` is an LF-terminated tail
// whose last complete structured event is a claude `stream_event` (a turn cannot end on
// one — proven vocabulary only, mirroring `recognizedCodexItemTypes`); everything else is
// a `clean_boundary` (looks like a normal line-boundary end). The last two must stay
// generic classifications (D3): only proven truncation shapes may be named as truncation.
function deriveCompletionStreamEndShape({
  stdoutBytes,
  endsWithNewline,
  trailingPartialBytes,
  lastStructuredEvent,
}) {
  if (!Number.isFinite(stdoutBytes) || stdoutBytes <= 0) return "no_bytes";
  if (endsWithNewline === false || trailingPartialBytes > 0) return "partial_line";
  if (lastStructuredEvent?.type === "stream_event") return "mid_turn_stream";
  return "clean_boundary";
}

function classifyCliExit(
  context,
  cliResult,
  suppliedEvidence = null,
  suppliedCompletion = null,
) {
  if (cliResult.fault_classification) return cliResult.fault_classification;
  if (cliResult.timed_out) return "reviewer_cli_timeout";
  if (cliResult.spawn_error) return "reviewer_cli_spawn_failed";
  if (cliResult.tool_surface_check?.status === "failed") {
    return cliResult.tool_surface_check.classification;
  }
  if (cliResult.output_safety_check?.status === "failed") {
    return cliResult.output_safety_check.classification;
  }
  // OpenCode: an export that does not prove the selected model, the exact bytes and a
  // terminal completion voids the review whatever the reviewer printed.
  if (cliResult.opencode_evidence_check?.status === "failed") {
    return "reviewer_model_provenance_unverified";
  }

  const boundedEvidence = suppliedEvidence ?? extractBoundedTerminalEvidence(context);
  const orchestrationEvidence = classifyReviewerOrchestrationEvidence(boundedEvidence);
  if (orchestrationEvidence) return orchestrationEvidence.classification;
  const structuredEvents = boundedEvidence.structuredEvents;
  const terminalResult = boundedEvidence.terminal?.type === "result"
    ? boundedEvidence.terminal
    : null;
  const hasStatus = (event, expected) => [
    event?.status,
    event?.status_code,
    event?.statusCode,
    event?.error?.status,
    event?.error?.status_code,
    event?.error?.statusCode,
  ].some((status) => Number(status) === expected);
  const isRateLimitEvent = (event) => [
    event?.type,
    event?.subtype,
    event?.error?.type,
    event?.error?.code,
  ].some((value) => value === "rate_limit_event" || value === "rate_limit_error");
  const isDefinitiveRateLimit = (event) => hasStatus(event, 429) || [
    event?.type,
    event?.subtype,
    event?.error?.type,
    event?.error?.code,
  ].some((value) => value === "rate_limit_error");
  const isInformationalRateLimitTelemetry = (event) => (
    isRateLimitEvent(event)
    && ["allowed", "allowed_warning"].includes(
      String(event?.rate_limit_info?.status ?? "").toLowerCase()
    )
  );
  const isNonInformationalRateLimit = (event) => (
    isRateLimitEvent(event)
    && !isInformationalRateLimitTelemetry(event)
  );
  const completion = suppliedCompletion ?? applyExecutionStreamReviewerModel(
    boundedEvidence,
    parseReviewerCompletion(context, boundedEvidence),
    { tool: context.reviewer_cli_recipe?.tool },
  );
  const requiresCompletion = reviewerCompletionRequired(context.reviewer_cli_recipe?.tool);
  const hasTypedAuthenticationEvidence = boundedEvidence.structuredEvents.some(
    terminalHasExplicitAuthenticationFailure
  );
  const hasRecipeIncompatibility = terminalIsReviewerCliRecipeIncompatible(
    boundedEvidence.terminal
  );
  const hasUnstructuredAuthenticationEvidence = (
    /authentication_failed|not logged in|please run \/login/i.test(
      `${boundedEvidence.unstructuredText}\n${boundedEvidence.stderrText}`
    )
  );

  const codexTurnClosing = context.reviewer_cli_recipe?.tool === "codex"
    ? classifyCodexTurnClosing(boundedEvidence.stdoutStructuredEvents)
    : "none";
  const hasGenericTerminalFailure = codexTurnClosing === "turn_failed"
    || (codexTurnClosing !== "bare_notices_superseded"
      && terminalIsGenericFailure(boundedEvidence.terminal));

  if (completion?.status === "accepted" && cliResult.code === 0) {
    if (hasTypedAuthenticationEvidence || hasUnstructuredAuthenticationEvidence) {
      return "claude_reviewer_authentication_failed";
    }
    if (hasRecipeIncompatibility) {
      return "reviewer_cli_recipe_incompatible";
    }
    if (hasGenericTerminalFailure) {
      return "reviewer_cli_failed";
    }
    return "reviewer_cli_completed";
  }
  if (structuredEvents.some((event) => (
    isDefinitiveRateLimit(event) || isNonInformationalRateLimit(event)
  ))) {
    return "claude_reviewer_provider_rate_limited";
  }
  if (hasTypedAuthenticationEvidence) {
    return "claude_reviewer_authentication_failed";
  }
  if (hasUnstructuredAuthenticationEvidence) {
    return "claude_reviewer_authentication_failed";
  }
  if (hasRecipeIncompatibility) {
    return "reviewer_cli_recipe_incompatible";
  }
  if (hasGenericTerminalFailure) {
    return "reviewer_cli_failed";
  }
  if (cliResult.code !== 0) return "reviewer_cli_failed";
  if (completion?.status === "blocking-verdict") {
    if (
      completion.completion.verdict === "UNAVAILABLE"
      && structuredEvents.some((event) => isRateLimitEvent(event))
    ) {
      return "claude_reviewer_provider_rate_limited";
    }
    return completion.completion.verdict === "UNAVAILABLE"
      ? "reviewer_completion_unavailable"
      : "reviewer_completion_critical";
  }
  if (requiresCompletion && completion?.status === "missing") {
    // D2/D3 (R1; fix-projection-completion-truncation): only the two proven truncation
    // shapes earn the named classification; `no_bytes` / `clean_boundary` keep the
    // generic missing classification (their attribution is not provable — upgrading them
    // would manufacture false truncation). Precedence above this branch is untouched.
    const stdoutEndShape = deriveCompletionStreamEndShape({
      stdoutBytes: cliResult.stdout_bytes,
      endsWithNewline: boundedEvidence.stdoutEndsWithNewline,
      trailingPartialBytes: boundedEvidence.stdoutTrailingPartialBytes,
      lastStructuredEvent: boundedEvidence.stdoutLastStructuredEvent,
    });
    if (stdoutEndShape === "partial_line" || stdoutEndShape === "mid_turn_stream") {
      return "reviewer_completion_stream_truncated";
    }
    return "reviewer_completion_contract_missing";
  }
  if (requiresCompletion && completion?.status === "reason-missing") {
    return "reviewer_completion_reason_missing";
  }
  if (requiresCompletion && completion?.status !== "accepted") {
    return "reviewer_completion_contract_invalid";
  }
  return "reviewer_cli_completed";
}

function closedTerminalClassification(classification, cliResult, sticky) {
  if (cliResult?.output_safety_check?.status === "failed"
    && cliResult.output_safety_check.reason === "reviewer_output_line_too_large") {
    return "reviewer_output_line_overflow";
  }
  if ([STICKY_CREDENTIAL_LITERAL_BLOCKED, STICKY_CREDENTIAL_LITERAL_DETECTED].includes(classification)) {
    return "sticky_contract_invalid";
  }
  if (classification === "sticky_verdict_not_gate_satisfying") {
    if (sticky?.verdict === "CRITICAL") return "reviewer_completion_critical";
    if (sticky?.verdict === "UNAVAILABLE") return "reviewer_completion_unavailable";
  }
  return TERMINAL_RECEIPT_CLASSIFICATIONS.has(classification) ? classification : null;
}

async function persistClosedTerminalReceipt({
  context,
  dispatchRecord,
  classification,
  processSpawned,
  lifecyclePhase,
  processCloseObserved,
  transportCleanupConfirmed,
  invocationClaimSha256,
  // The inline runner resolves its evidence root the same way it did before,
  // ambient override included. Reconciliation passes the root it actually
  // verified, so the root every precondition read is the root the receipt is
  // written to; leaving the default here would let an ambient override send
  // the write somewhere none of C1-C14 ever looked.
  rootDir = evidenceRootForContext(context),
}) {
  const receipt = await writeTerminalReceipt({
    rootDir,
    record: {
      ...dispatchRecord,
      schema: TERMINAL_RECEIPT_SCHEMA,
      outcome_group: terminalReceiptOutcomeGroup(classification),
      classification,
      responsibility: TERMINAL_RECEIPT_RESPONSIBILITY,
      created_at: nowIso(),
      process_spawned: processSpawned,
      lifecycle_phase: lifecyclePhase,
      process_close_observed: processCloseObserved,
      transport_cleanup_confirmed: transportCleanupConfirmed,
      invocation_claim_sha256: invocationClaimSha256,
    },
  });
  appendActivity(context, "projection_terminal_receipt_written", {
    dispatch_id: dispatchRecord.dispatch_id,
    terminal_classification: classification,
    process_spawned: receipt.record.process_spawned,
    lifecycle_phase: receipt.record.lifecycle_phase,
    process_close_observed: receipt.record.process_close_observed,
    transport_cleanup_confirmed: receipt.record.transport_cleanup_confirmed,
    invocation_claim_sha256: receipt.record.invocation_claim_sha256,
    terminal_integrity_id: receipt.record.integrity_id,
  });
  return receipt;
}

function pathsPayload(context) {
  return {
    observability_context_path: context.observability_context_path,
    heartbeat_path: context.heartbeat_path,
    activity_log_path: context.activity_log_path,
    stdout_log_path: context.stdout_log_path,
    stderr_log_path: context.stderr_log_path,
    cli_probe_result_path: context.cli_probe_result_path,
    ...(context.review_scope_probe_result_path
      ? { review_scope_probe_result_path: context.review_scope_probe_result_path }
      : {}),
  };
}

// ── R2 (D4/D5; fix-projection-completion-truncation): completion-stream evidence ──────
//
// When a reviewer's completion object never arrives in usable form, the bytes the
// reviewer DID stream are still on disk, but today they are only recoverable by hand
// reading the raw stdout archive. This block adds (1) a bounded, allowlisted diagnostic
// summary of the archive's end shape, and (2) a runner-owned, explicitly NON-authoritative
// sidecar that preserves the already-arrived completion payload.
//
// Non-authority is structural, not a convention: the sidecar is written by one writer
// function placed outside the classifyCliExit→pathsPayload source-scan slice, carries the
// literal `completion_authority: "none"`, and is never read by classification, completion
// parsing, sticky verification, receipt writing, or any gate (locked by
// second-review-completion-evidence-consumer-grep.test.mjs + the invariance test).
// A truncated stream therefore still fails closed with zero chance of being read back as
// a verified terminal.
//
// D5 cap: the sidecar payload cap equals the bounded-tail window — a candidate whose
// fragments fully fit the window can never exceed it (worst observed escaped envelope
// ≤ ~52 KB), so `over_cap` is a defensive stop rather than a reachable normal path. When
// it does trip, neither `assembled_payload` nor `payload_sha256` is emitted: the hash
// would point at bytes that were deliberately not persisted.
export const COMPLETION_EVIDENCE_PAYLOAD_MAX_BYTES = 65536;
const COMPLETION_EVIDENCE_SCHEMA = "devpro-second-review-completion-evidence/v1";
const COMPLETION_EVIDENCE_FILE_NAME = "reviewer-completion-evidence.json";
const COMPLETION_EVIDENCE_ASSEMBLED_FROM = "input_json_delta";
// F-6: only the completion tool's own tool_use stream can become the carrier payload; a
// pr-sticky `Bash`/`Write` tool stream is not a completion candidate (same literal the
// tool-surface allowlist uses — `safeReviewerToolNames`).
const COMPLETION_EVIDENCE_TOOL_NAME = "StructuredOutput";
// D4/D5 trigger set: requiresCompletion AND the completion parse produced no usable
// object. One frozen set consumed by both the carrier trigger and the diagnostic event so
// they can never drift apart (r1 F-02).
const COMPLETION_EVIDENCE_TRIGGER_STATUSES = Object.freeze(new Set([
  "missing",
  "not-successful",
  "malformed",
  "reason-missing",
]));

function completionEvidenceArtifactPath(context) {
  return path.join(path.dirname(context.stdout_log_path), COMPLETION_EVIDENCE_FILE_NAME);
}

// D5 derivation — pure, bounded: walks only the already-read complete-line structured
// events and keeps the LAST claude completion-tool tool_use input stream (the completion
// payload is the final structured output of the turn; F-6: a `Bash`/`Write` tool stream is
// not a completion candidate). Deltas attach only to a candidate opened by an observed
// `content_block_start` and only while that block is open and its `index` agrees; unproven
// shapes contribute nothing (fail closed to "no carrier" rather than guessing).
function completionEvidenceCandidate(stdoutStructuredEvents) {
  let candidate = null;
  for (const event of stdoutStructuredEvents ?? []) {
    if (!isPlainObject(event) || event.type !== "stream_event") continue;
    const streamEvent = event.event;
    if (!isPlainObject(streamEvent)) continue;
    const index = Number.isInteger(streamEvent.index) ? streamEvent.index : null;
    if (
      streamEvent.type === "content_block_start"
      && isPlainObject(streamEvent.content_block)
      && streamEvent.content_block.type === "tool_use"
      && streamEvent.content_block.name === COMPLETION_EVIDENCE_TOOL_NAME
    ) {
      candidate = { index, fragments: [] };
      continue;
    }
    if (candidate === null) continue;
    if (index !== null && candidate.index !== null && index !== candidate.index) continue;
    if (streamEvent.type === "content_block_stop") {
      candidate.closed = true;
      continue;
    }
    if (
      candidate.closed !== true
      && streamEvent.type === "content_block_delta"
      && isPlainObject(streamEvent.delta)
      && streamEvent.delta.type === "input_json_delta"
      && typeof streamEvent.delta.partial_json === "string"
    ) {
      candidate.fragments.push(streamEvent.delta.partial_json);
    }
  }
  return candidate !== null && candidate.fragments.length > 0 ? candidate : null;
}

// D5 cap: stop collecting at the byte cap and report `over_cap`; the fragment that would
// cross the cap is not appended, so the persisted payload never exceeds the cap.
function assembleCompletionEvidencePayload(candidate) {
  let text = "";
  let fragmentCount = 0;
  for (const fragment of candidate.fragments) {
    const next = text + fragment;
    if (Buffer.byteLength(next, "utf8") > COMPLETION_EVIDENCE_PAYLOAD_MAX_BYTES) {
      return { text, fragmentCount, overCap: true };
    }
    text = next;
    fragmentCount += 1;
  }
  return { text, fragmentCount, overCap: false };
}

function completionEvidenceAssemblyState(text, overCap) {
  if (overCap) return "over_cap";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "partial_json";
  }
  return isPlainObject(parsed) ? "json_object" : "other_json";
}

// D5 record — exact canonical field set; `over_cap` omits BOTH payload_sha256 and
// assembled_payload (the hash prefix was never persisted, so it would reference nothing).
function buildCompletionEvidenceRecord(context, { candidate, stdoutBytes, windowTruncated }) {
  const assembled = assembleCompletionEvidencePayload(candidate);
  const assemblyState = completionEvidenceAssemblyState(assembled.text, assembled.overCap);
  const overCap = assemblyState === "over_cap";
  return {
    schema: COMPLETION_EVIDENCE_SCHEMA,
    attempt_id: context.attempt_id ?? null,
    dispatch_id: context.dispatch_id ?? null,
    tool: context.reviewer_cli_recipe?.tool ?? null,
    captured_at: nowIso(),
    completion_authority: "none",
    assembly_state: assemblyState,
    assembled_from: COMPLETION_EVIDENCE_ASSEMBLED_FROM,
    fragment_count: assembled.fragmentCount,
    payload_bytes: Buffer.byteLength(assembled.text, "utf8"),
    ...(overCap ? {} : { payload_sha256: sha256Hex(assembled.text) }),
    source: {
      file_role: "reviewer_stdout_archive",
      stdout_bytes: stdoutBytes,
      window_truncated: windowTruncated === true,
    },
    ...(overCap ? {} : { assembled_payload: assembled.text }),
  };
}

// D5 write: single exclusive create (attempt-dir precedent: publishReviewScopeProbeResult),
// never an overwrite. An existing file is accepted only on byte-identical idempotent
// re-read; a different-bytes collision is left untouched and reported as "no carrier for
// this attempt" so the diagnostic can never claim persistence that did not happen.
// F-4 bounds that re-read: a carrier whose size already differs from the body this attempt
// would persist cannot be byte-identical, so it is rejected after one stat — only an
// equal-size file is read, and then compared byte-for-byte exactly as before.
// F-5: a non-EEXIST create/append failure may have left a half-written carrier behind
// (open succeeded, write/fsync did not), so that path best-effort removes it and still
// reports "no carrier" — never a partial artifact.
// Returns `{ file, assembly_state }` (the D4 `completion_evidence` indicator) or null.
function persistCompletionEvidenceArtifact(context, { boundedEvidence, completion, stdoutBytes }) {
  if (!reviewerCompletionRequired(context?.reviewer_cli_recipe?.tool)) return null;
  // D5 boundary: paged (v5) attempts do not write this carrier — each window already has
  // its own completion/ledger contract and a shared archive would make one file ambiguous.
  if (context.page_window_checkpoint_handoff === true) return null;
  if (!COMPLETION_EVIDENCE_TRIGGER_STATUSES.has(completion?.status)) return null;
  const candidate = completionEvidenceCandidate(boundedEvidence?.stdoutStructuredEvents);
  if (candidate === null) return null;
  const record = buildCompletionEvidenceRecord(context, {
    candidate,
    stdoutBytes,
    windowTruncated: boundedEvidence?.stdoutTruncated === true,
  });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const filePath = completionEvidenceArtifactPath(context);
  let fd;
  try {
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    return { file: COMPLETION_EVIDENCE_FILE_NAME, assembly_state: record.assembly_state };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      // F-5: only this branch can have created the file before failing (the EEXIST branch
      // never got an fd). Removal is best-effort; either way the attempt reports no carrier.
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore: "no carrier for this attempt" does not depend on cleanup succeeding.
      }
      return null;
    }
    // F-4: bounded re-read — size first, content only when the sizes are equal.
    //
    // S2 reachability note (fix-truncation-review-followups): the byte-identical branch
    // below is, in practice, reachable only under a frozen clock — the record carries a
    // fresh `captured_at` every round, so a real repeated attempt's body always differs
    // (usually at the size check; a same-width timestamp can reach the byte compare and
    // still differ). It stays because a frozen clock or an explicit retry fixture can
    // legitimately re-persist the same attempt; the comparison semantics — size first,
    // then bytes — are deliberately untouched.
    let existingBytes;
    try {
      existingBytes = statSync(filePath).size;
    } catch {
      return null;
    }
    if (existingBytes !== bodyBytes) return null;
    let existing = null;
    try {
      existing = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    return existing === body
      ? { file: COMPLETION_EVIDENCE_FILE_NAME, assembly_state: record.assembly_state }
      : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// D4 diagnostic summary — closed allowlist only (counts, enums, the folded last event, the
// carrier indicator): never reviewer raw content, never the completion text itself.
function completionStreamEvidenceSummary({ boundedEvidence, stdoutBytes, completionEvidence }) {
  return {
    stdout_bytes: stdoutBytes,
    stdout_end_shape: deriveCompletionStreamEndShape({
      stdoutBytes,
      endsWithNewline: boundedEvidence?.stdoutEndsWithNewline,
      trailingPartialBytes: boundedEvidence?.stdoutTrailingPartialBytes,
      lastStructuredEvent: boundedEvidence?.stdoutLastStructuredEvent,
    }),
    stdout_trailing_partial_bytes: Number.isInteger(boundedEvidence?.stdoutTrailingPartialBytes)
      ? boundedEvidence.stdoutTrailingPartialBytes
      : 0,
    stdout_last_complete_event: boundedEvidence?.stdoutLastStructuredEvent ?? null,
    stdout_window_truncated: boundedEvidence?.stdoutTruncated === true,
    completion_evidence: completionEvidence,
  };
}

function completionStreamDiagnosticApplies(context, completion) {
  return reviewerCompletionRequired(context?.reviewer_cli_recipe?.tool)
    && COMPLETION_EVIDENCE_TRIGGER_STATUSES.has(completion?.status);
}

export function shouldBlockUnavailableStickyOverwrite({
  materialAvailable,
  priorGateSatisfyingSticky,
  proposedVerdict,
}) {
  if (materialAvailable !== false) return false;
  if (!priorGateSatisfyingSticky) return false;
  const priorVerdict = priorGateSatisfyingSticky.verdict;
  if (priorVerdict !== "PASS" && priorVerdict !== "WARN") return false;
  return proposedVerdict !== "PASS" && proposedVerdict !== "WARN";
}

function priorGateSatisfyingStickyFromContext(context) {
  const disposition = context?.sticky_write_disposition;
  if (!disposition || disposition.action === "create" || disposition.action === "blocked"
    || disposition.action === "not-applicable") {
    return null;
  }
  const verdict = disposition.prior_verdict
    ?? disposition.existing_verdict
    ?? disposition.target?.verdict
    ?? null;
  if (verdict !== "PASS" && verdict !== "WARN") return null;
  return { verdict };
}

function findingsLedgerBlocksGateSatisfyingSticky(findingsLedger) {
  const windows = findingsLedger?.windows;
  if (!Array.isArray(windows)) return false;
  return windows.some((entry) => (
    entry?.window_verdict === "CRITICAL"
    || entry?.window_verdict === "UNAVAILABLE"
    || (Array.isArray(entry?.findings) && entry.findings.some((finding) => finding?.severity === "CRITICAL"))
  ));
}

/**
 * Bind a non-executable sticky disposition so later spawns cannot write a
 * gate-satisfying sticky before D1b aggregation authorizes it (D7).
 */
export function bindBlockedStickyWriteDisposition(context, {
  classification = "page_window_aggregation_pending",
  reason = "Sticky write blocked until page-window aggregation authorizes gate-satisfying sticky.",
} = {}) {
  if (!context || context.mode !== "pr-sticky") return null;
  const prior = context.sticky_write_disposition_authorized
    ?? context.sticky_write_disposition;
  const blocked = pageWindowIntermediateStickyDisposition(prior ?? {
    schema: "devpro-second-review-sticky-write-disposition/v1",
    repository_slug: context.repository_slug ?? null,
    pr_number: context.pr_number ?? null,
    dispatch_id: context.dispatch_id ?? null,
    candidate_count: 0,
    snapshot_digest: "none",
  }, {
    classification,
    reason,
  });
  blocked.prior_verdict = prior?.prior_verdict
    ?? prior?.existing_verdict
    ?? prior?.target?.verdict
    ?? null;
  blocked.prior_body_sha256 = prior?.target?.body_sha256 ?? prior?.prior_body_sha256 ?? null;
  blocked.prior_target = prior?.action === "update" ? prior.target ?? null : null;
  context.sticky_write_disposition = blocked;
  if (Object.hasOwn(context, "sticky_write_exact_recipe")) {
    context.sticky_write_exact_recipe = null;
  }
  if (
    typeof context.packet_path === "string"
    && context.page_window_checkpoint_handoff === true
  ) {
    try {
      const reviewData = parseCanonicalSecondReviewPacketData(readFileSync(context.packet_path), {
        windowMaxPages: resolveDeclaredPageWindowMaxPages(context.page_window_max_pages),
      });
      writePageWindowPacketWithDisposition(context, reviewData, blocked);
    } catch {
      // Packet rewrite is best-effort on the failure path; disposition remains blocked in context.
    }
  }
  appendActivity(context, "projection_sticky_write_disposition_blocked", {
    classification,
    reason: blocked.reason,
  });
  return blocked;
}

// #3623: a page window whose completion payload is only malformed (the reviewer answered,
// but the completion JSON did not parse) may be dispatched once more in the same window
// instead of aborting the whole batch. The retry re-sends the same packet bytes and takes a
// fresh invocation index, exactly like the CRITICAL checkpoint re-spawn. Every other failure
// (sticky contract, provenance, sha mismatch, transport) is a real result and is never retried.
export const PAGE_WINDOW_COMPLETION_RETRY_LIMIT = 1;
export function pageWindowCompletionRetry({
  gate,
  retriesUsed,
  retryLimit = PAGE_WINDOW_COMPLETION_RETRY_LIMIT,
  // Only a cleanly closed run can owe its malformed completion to formatting. An
  // interrupted, timed-out or faulted run already carries its own classification and
  // MUST NOT get a second spawn (that would also turn an interruption into a slow retry).
  // Defaults closed: a caller that cannot prove a clean close gets no retry.
  runClean = false,
}) {
  const used = Number.isSafeInteger(retriesUsed) && retriesUsed > 0 ? retriesUsed : 0;
  if (gate?.phase !== "completion_invalid") {
    return { retry: false, retriesUsed: used, exhausted: false, classification: gate?.classification ?? null };
  }
  if (runClean !== true) {
    return { retry: false, retriesUsed: used, exhausted: false, classification: gate.classification };
  }
  if (used >= retryLimit) {
    return { retry: false, retriesUsed: used, exhausted: true, classification: gate.classification };
  }
  return { retry: true, retriesUsed: used + 1, exhausted: false, classification: gate.classification };
}

/**
 * A Critical result blocks merging immediately, while window coverage continues.
 * An existing passing sticky is invalidated through a reviewer-owned write checkpoint;
 * the runner then resumes the same attempt with the verified comment authority.
 */
export function resolveLivePageWindowStickyGate({
  context,
  reviewMaterial,
  completion,
  priorGateSatisfyingSticky = priorGateSatisfyingStickyFromContext(context),
}) {
  if (context?.page_window_checkpoint_handoff !== true) {
    return { active: false };
  }
  const retainedLedgers = reviewMaterial?.findings_ledger ? {
    checkpoint_ledger: reviewMaterial.checkpoint_ledger,
    findings_ledger: reviewMaterial.findings_ledger,
  } : null;
  if (context.page_window_critical_sticky_checkpoint === true) {
    const valid = completion?.status === "blocking-verdict" && completion.completion?.verdict === "CRITICAL";
    return {
      active: true,
      phase: valid ? "critical_sticky_checkpoint" : "completion_invalid",
      advanced: retainedLedgers,
      stickyAuthorized: valid,
      blockUnavailableOverwrite: false,
      continueToNextWindow: false,
      scanComplete: false,
      classification: valid ? "page_window_intermediate_critical_sticky_checkpoint" : "reviewer_completion_contract_invalid",
    };
  }
  if (!reviewMaterial || (completion?.status !== "accepted" && completion?.status !== "blocking-verdict")) {
    return {
      active: true, phase: "completion_invalid", advanced: retainedLedgers,
      stickyAuthorized: false, blockUnavailableOverwrite: false,
      continueToNextWindow: false, scanComplete: false,
      classification: "reviewer_completion_contract_invalid",
    };
  }
  // D9 (R10, R13): windowMaxPages is the dispatch's declared window size (undeclared
  // resolves to the unchanged default 1). dispatchedWindowCount is read straight off this
  // dispatch's own page_window_count when the caller's context carries it; a context that
  // omits it (fixtures constructed by hand, not through the renderer) falls back to
  // advancePageWindowLedgers'/authorizeGateSatisfyingSticky's own windowMaxPages-derived
  // pageWindowCount(pageCount, windowMaxPages) rather than an implicit W=1 default.
  const advanced = advancePageWindowLedgers({
    reviewMaterial,
    completion,
    windowMaxPages: resolveDeclaredPageWindowMaxPages(context.page_window_max_pages),
    dispatchedWindowCount: Number.isSafeInteger(context.page_window_count)
      ? context.page_window_count
      : null,
  });
  const proposedVerdict = completion.completion?.verdict;
  const materialAvailable = proposedVerdict === "UNAVAILABLE" ? false : true;
  const blockUnavailableOverwrite = shouldBlockUnavailableStickyOverwrite({
    materialAvailable,
    priorGateSatisfyingSticky,
    proposedVerdict,
  });
  const windows = advanced.findings_ledger?.windows;
  const ledgerUnavailable = Array.isArray(windows)
    && windows.some((entry) => entry?.window_verdict === "UNAVAILABLE");
  // An UNAVAILABLE window (this one or any earlier recorded one) means part of the material was
  // never reviewed, so no gate event of this attempt may report the scan as complete, the final
  // window included (dp-reviewer r4 F-r4-a1).
  const scanComplete = proposedVerdict !== "UNAVAILABLE" && !ledgerUnavailable;
  if (reviewMaterial.window_role === "intermediate") {
    const ledgerCritical = Array.isArray(windows)
      && windows.some((entry) => (
        entry?.window_verdict === "CRITICAL"
        || (Array.isArray(entry?.findings)
          && entry.findings.some((finding) => finding?.severity === "CRITICAL"))
      ));
    const completionCritical = proposedVerdict === "CRITICAL"
      || (Array.isArray(completion.completion?.findings)
        && completion.completion.findings.some((finding) => finding?.severity === "CRITICAL"));
    const unavailableBlocks = proposedVerdict === "UNAVAILABLE" || ledgerUnavailable;
    if (unavailableBlocks) {
      return {
        active: true,
        phase: "intermediate",
        advanced,
        stickyAuthorized: false,
        blockUnavailableOverwrite,
        continueToNextWindow: false,
        scanComplete: false,
        classification: "page_window_intermediate_blocks_aggregation",
      };
    }
    if (completionCritical || ledgerCritical) {
      const mustInvalidate = priorGateSatisfyingSticky !== null;
      return {
        active: true,
        phase: mustInvalidate ? "intermediate_critical_sticky" : "intermediate",
        advanced,
        stickyAuthorized: mustInvalidate,
        blockUnavailableOverwrite,
        continueToNextWindow: !mustInvalidate,
        scanComplete: false,
        classification: mustInvalidate
          ? "page_window_intermediate_critical_sticky_authorized"
          : "page_window_intermediate_critical_recorded_continue",
      };
    }
    return {
      active: true,
      phase: "intermediate",
      advanced,
      stickyAuthorized: false,
      blockUnavailableOverwrite,
      continueToNextWindow: true,
      scanComplete: false,
      classification: "page_window_intermediate_advanced",
    };
  }
  const stickyGate = advanced.sticky_authorized;
  const unresolvedCritical = stickyGate?.reason === "unresolved_critical";
  const criticalStickyWrite = unresolvedCritical && !blockUnavailableOverwrite;
  const stickyAuthorized = (stickyGate?.authorized === true && !blockUnavailableOverwrite)
    || criticalStickyWrite;
  return {
    active: true,
    phase: "final",
    advanced,
    stickyAuthorized,
    blockUnavailableOverwrite,
    continueToNextWindow: false,
    scanComplete,
    stickyGate,
    classification: blockUnavailableOverwrite
      ? "sticky_unavailable_overwrite_blocked"
      : stickyGate?.authorized === true
        ? "page_window_final_authorized"
        : criticalStickyWrite
          ? "page_window_final_critical_sticky_authorized"
          : "page_window_final_not_authorized",
  };
}

function rebuildPacketWithReviewData(packetBytes, nextData) {
  const bytes = Buffer.isBuffer(packetBytes) ? packetBytes : Buffer.from(packetBytes, "utf8");
  const marker = Buffer.from(SECOND_REVIEW_FRAME_MARKER, "utf8");
  const headerStart = bytes.indexOf(marker);
  if (headerStart < 0) {
    throw new TypeError("packet missing canonical JSON frame for page-window advance");
  }
  const lengthStart = headerStart + marker.length;
  const headerEnd = bytes.indexOf(Buffer.from("\n\n", "utf8"), lengthStart);
  if (headerEnd < 0) {
    throw new TypeError("packet frame header missing blank-line terminator");
  }
  const lengthText = bytes.subarray(lengthStart, headerEnd).toString("ascii");
  const declaredLength = Number(lengthText);
  const payloadStart = headerEnd + 2;
  const payloadEnd = payloadStart + declaredLength;
  const prefix = bytes.subarray(0, headerStart);
  const suffix = bytes.subarray(payloadEnd);
  const payload = Buffer.from(JSON.stringify(nextData), "utf8");
  return Buffer.concat([
    prefix,
    Buffer.from(`${SECOND_REVIEW_FRAME_MARKER}${payload.length}\n\n`, "utf8"),
    payload,
    suffix,
  ]);
}

function authorizedStickyDispositionForPageWindow(context) {
  const authorized = context.sticky_write_disposition_authorized;
  if (
    authorized
    && (authorized.action === "create" || authorized.action === "update")
  ) {
    return authorized;
  }
  const current = context.sticky_write_disposition;
  if (
    current
    && (current.action === "create" || current.action === "update")
  ) {
    return current;
  }
  return null;
}

function recordPageWindowLiveGate(context, pageWindowLiveGate, maxPageWindows, criticalUnion) {
  const publishCriticalUnion = !["intermediate_critical_sticky", "critical_sticky_checkpoint"].includes(pageWindowLiveGate.phase)
    && (pageWindowLiveGate.scanComplete === true
      || pageWindowLiveGate.continueToNextWindow !== true);
  // Intermediate windows and write checkpoints publish only the count.
  // This keeps growth O(windows); terminal / scan_complete events carry the union.
  appendActivity(context, "projection_page_window_live_gate", {
    phase: pageWindowLiveGate.phase,
    classification: pageWindowLiveGate.classification,
    sticky_authorized: pageWindowLiveGate.stickyAuthorized === true,
    block_unavailable_overwrite: pageWindowLiveGate.blockUnavailableOverwrite === true,
    continue_to_next_window: pageWindowLiveGate.continueToNextWindow === true,
    findings_windows: pageWindowLiveGate.advanced?.findings_ledger?.windows?.length ?? 0,
    page_window_count: maxPageWindows,
    scan_complete: pageWindowLiveGate.scanComplete === true,
    ...(publishCriticalUnion
      ? { critical_findings: criticalUnion }
      : { critical_findings_count: criticalUnion.length }),
  });
}

function bindCriticalStickyVerdict(context) {
  const paths = [
    resolveCredentialGateSidecarPath(undefined, context.dispatch_id),
    path.join(path.dirname(context.observability_context_path), STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME),
  ];
  for (const sidecarPath of new Set(paths)) {
    try {
      const { digest, ...payload } = JSON.parse(readFileSync(sidecarPath, "utf8"));
      if (payload.schema !== STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA
        || payload.dispatch_id !== context.dispatch_id
        || payload.repository_slug !== context.repository_slug
        || Number(payload.pr_number) !== Number(context.pr_number)
        || digest !== sha256Hex(JSON.stringify(payload))) {
        throw new Error("invalid bound sidecar");
      }
      if (payload.required_verdict === "CRITICAL") continue;
      payload.required_verdict = "CRITICAL";
      const parent = path.dirname(sidecarPath);
      replaceDurableFile({
        root: parent, parent, target: sidecarPath,
        body: JSON.stringify({ ...payload, digest: sha256Hex(JSON.stringify(payload)) }) + "\n",
      });
    } catch {
      throw new ProjectionRunnerError("Critical sticky clamp lost its bound sidecar", "sticky_credential_gate_sidecar_invalid");
    }
  }
}

function canonicalPageWindowPacket(context, nextData, dispositionForPrefix) {
  const binding = pageWindowCompletionBindingFromReviewMaterial(
    nextData.review_material,
    resolveDeclaredPageWindowMaxPages(context.page_window_max_pages),
  );
  const prefix = secondReviewPacketStaticPrefix(
    secondReviewToolForFamily(context.reviewer_family),
    context.mode,
    context.dispatch_id,
    dispositionForPrefix,
    nextData.schema_version,
    {
      pageWindowCheckpointHandoff: true,
      retryContext: nextData.retry_context,
      primaryFamily: nextData.primary_family ?? context.primary_family,
      criticalStickyCheckpoint: context.page_window_critical_sticky_checkpoint === true,
    },
  );
  const suffix = secondReviewPacketStaticSuffix(nextData.schema_version, binding);
  const payload = JSON.stringify(nextData);
  return Buffer.from(
    `${prefix}${SECOND_REVIEW_FRAME_MARKER}${Buffer.byteLength(payload, "utf8")}\n\n${payload}${suffix}`,
    "utf8",
  );
}

function writePageWindowPacketWithDisposition(context, nextData, dispositionForPrefix) {
  const packet = canonicalPageWindowPacket(context, nextData, dispositionForPrefix);
  writeFileSync(context.packet_path, packet);
  context.sticky_write_disposition = dispositionForPrefix;
  if (dispositionForPrefix?.action === "blocked") {
    if (Object.hasOwn(context, "sticky_write_exact_recipe")) {
      context.sticky_write_exact_recipe = null;
    }
  }
}

/**
 * After an intermediate CRITICAL completion, restore the authorized create/update
 * disposition and rewrite the packet for one reviewer-owned CRITICAL sticky checkpoint
 * so Path F cannot keep a stale same-head PASS|WARN.
 */
export function prepareIntermediateCriticalStickyCheckpoint(context, reviewData, advanced) {
  if (!context || context.mode !== "pr-sticky") {
    throw new TypeError("critical sticky checkpoint requires pr-sticky context");
  }
  if (!advanced?.checkpoint_ledger || !advanced?.findings_ledger) {
    throw new TypeError("critical sticky checkpoint requires advanced ledgers");
  }
  const authorized = authorizedStickyDispositionForPageWindow(context);
  if (authorized === null) {
    throw new TypeError("critical sticky checkpoint requires sticky_write_disposition_authorized create/update disposition");
  }
  if (!context.sticky_write_disposition_authorized) {
    context.sticky_write_disposition_authorized = authorized;
  }
  const nextData = {
    ...reviewData,
    review_material: {
      ...reviewData.review_material,
      checkpoint_ledger: advanced.checkpoint_ledger,
      findings_ledger: advanced.findings_ledger,
    },
  };
  context.page_window_critical_sticky_checkpoint = true;
  context.review_material = nextData.review_material;
  writePageWindowPacketWithDisposition(context, nextData, authorized);
  appendActivity(context, "projection_page_window_critical_sticky_checkpoint", {
    classification: "page_window_intermediate_critical_sticky_authorized",
    sticky_write_action: authorized.action,
    findings_windows: advanced.findings_ledger.windows.length,
  });
  return nextData;
}

function fullPagesFromTrustedClosureSeal(closureSeal) {
  if (closureSeal === null) throw new TypeError("paged review requires a trusted closure seal");
  return closureSeal.pages.map((page) => ({
    index: page.index,
    content: closureSeal.copyPageBytes(page.index).toString("utf8"),
  }));
}

function isTrustedPagedAuthorization(trustedAuthorization) {
  return trustedAuthorization?.data?.schema_version
    === SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION;
}

function assertTrustedPageWindowState(context, reviewData, trustedAuthorization) {
  if (!isTrustedPagedAuthorization(trustedAuthorization)) return;
  const sealed = trustedAuthorization.data;
  for (const field of [
    "schema_version",
    "dispatch_id",
    "head_ref_oid",
    "review_scope",
    "changed_files_or_touch_list",
    "review_material_proof",
  ]) {
    if (JSON.stringify(reviewData[field]) !== JSON.stringify(sealed[field])) {
      throw new ProjectionRunnerError(
        `trusted page-window immutable field changed: ${field}`,
        "review_material_full_closure_invalid",
      );
    }
  }
  if (JSON.stringify(reviewData.review_material?.manifest)
    !== JSON.stringify(sealed.review_material?.manifest)) {
    throw new ProjectionRunnerError(
      "trusted page-window manifest changed",
      "review_material_full_closure_invalid",
    );
  }
  const expected = framePagedReviewMaterial({
    manifest: sealed.review_material.manifest,
    fullPages: fullPagesFromTrustedClosureSeal(trustedAuthorization.closure_seal),
    checkpointLedger: reviewData.review_material.checkpoint_ledger,
    findingsLedger: reviewData.review_material.findings_ledger,
    windowIndex: Number(context.page_window_index ?? 1),
    windowMaxPages: resolveDeclaredPageWindowMaxPages(context.page_window_max_pages),
  });
  if (JSON.stringify(reviewData.review_material.pages) !== JSON.stringify(expected.pages)
    || reviewData.review_material.window_role !== expected.window_role) {
    throw new ProjectionRunnerError(
      "trusted active page window does not match its sealed bytes",
      "review_material_full_closure_invalid",
    );
  }
}

function advancePageWindowPacketAndContext(context, reviewData, advanced, trustedAuthorization) {
  const windowMaxPages = resolveDeclaredPageWindowMaxPages(context.page_window_max_pages);
  const nextWindowIndex = Number(context.page_window_index ?? 1) + 1;
  const totalWindows = Number(context.page_window_count)
    || pageWindowCount(reviewData.review_material.manifest.page_count, windowMaxPages);
  if (nextWindowIndex > totalWindows) {
    throw new TypeError("page-window advance requested past final window");
  }
  const framed = framePagedReviewMaterial({
    manifest: reviewData.review_material.manifest,
    fullPages: fullPagesFromTrustedClosureSeal(trustedAuthorization?.closure_seal ?? null),
    checkpointLedger: advanced.checkpoint_ledger,
    findingsLedger: advanced.findings_ledger,
    windowIndex: nextWindowIndex,
    windowMaxPages,
  });
  const nextData = {
    ...reviewData,
    review_material: framed,
  };
  const authorized = authorizedStickyDispositionForPageWindow(context);
  if (authorized === null) {
    throw new TypeError("page-window advance requires sticky_write_disposition_authorized create/update disposition");
  }
  if (!context.sticky_write_disposition_authorized) {
    context.sticky_write_disposition_authorized = authorized;
  }
  const dispositionForPrefix = framed.window_role === "final"
    ? authorized
    : pageWindowIntermediateStickyDisposition(authorized);
  writePageWindowPacketWithDisposition(context, nextData, dispositionForPrefix);
  context.page_window_index = nextWindowIndex;
  context.review_material = framed;
  appendActivity(context, "projection_page_window_advanced", {
    page_window_index: nextWindowIndex,
    page_window_count: totalWindows,
    window_role: framed.window_role,
    sticky_write_action: dispositionForPrefix.action,
    checkpoint_covered: advanced.checkpoint_ledger.covered_indices.length,
    findings_windows: advanced.findings_ledger.windows.length,
  });
  return nextData;
}

export function advancePageWindowLedgers({
  reviewMaterial,
  completion,
  windowMaxPages,
  dispatchedWindowCount = null,
}) {
  if (!reviewMaterial || (completion?.status !== "accepted" && completion?.status !== "blocking-verdict")) {
    throw new TypeError("page-window ledger advance requires review material and parsed completion");
  }
  // D9 (R10, R13): required, not defaulted — every caller must supply the dispatch's
  // declared window size explicitly (T7 grep-anchor guard).
  if (!Number.isSafeInteger(windowMaxPages) || windowMaxPages <= 0) {
    throw new TypeError("page-window ledger advance requires an explicit positive windowMaxPages");
  }
  const windowCompletion = completion.completion;
  const checkpointLedger = appendCheckpointCoverage(
    reviewMaterial.checkpoint_ledger,
    reviewMaterial.pages,
    reviewMaterial.manifest,
  );
  const findingsLedger = appendFindingsWindow(reviewMaterial.findings_ledger, {
    window_index: windowCompletion.window_index,
    page_indices: windowCompletion.page_indices,
    window_verdict: windowCompletion.verdict,
    findings: windowCompletion.findings,
  });
  return {
    checkpoint_ledger: checkpointLedger,
    findings_ledger: findingsLedger,
    sticky_authorized: reviewMaterial.window_role === "final"
      ? authorizeGateSatisfyingSticky({
        checkpointLedger,
        findingsLedger,
        pageCount: reviewMaterial.manifest.page_count,
        windowMaxPages,
        dispatchedWindowCount,
      })
      : { authorized: false, reason: "intermediate_window", errors: ["intermediate windows must not write PR sticky"] },
  };
}

export const __testReviewerClassification = Object.freeze({
  classifyCliExit,
  deriveCompletionStreamEndShape,
  extractBoundedTerminalEvidence,
  extractExecutionStreamReviewerModel,
  applyExecutionStreamReviewerModel,
  resolveReviewerObservedIdentity,
  deriveReviewerModelAgreement,
  normalizeClaudeCompletionTrailer,
  parseClaudeCompletion,
  parseCodexCompletion,
  parseCompletionObject,
  parseReviewerCompletion,
  partitionBoundedEvidence,
  shouldBlockUnavailableStickyOverwrite,
  advancePageWindowLedgers,
  authorizeGateSatisfyingSticky,
  bindBlockedStickyWriteDisposition,
  prepareIntermediateCriticalStickyCheckpoint,
  resolveLivePageWindowStickyGate,
  revalidateSecondReviewStickyWriteDisposition,
  retainTailRelevantByteRanges,
  safeCliExit,
});

// Deliberately narrow test seam for the R2 non-authoritative completion-evidence carrier
// (D4/D5; fix-projection-completion-truncation) — mirrors the shape of the module's other
// __test* seams. None of these symbols is consumed by any classification, sticky,
// receipt, or gate path; the seam exists only so tests can pin the pure derivation, the
// cap semantics, and the exact record field set without a live reviewer.
export const __testCompletionStreamEvidence = Object.freeze({
  COMPLETION_EVIDENCE_PAYLOAD_MAX_BYTES,
  COMPLETION_EVIDENCE_SCHEMA,
  completionEvidenceArtifactPath,
  completionEvidenceCandidate,
  assembleCompletionEvidencePayload,
  completionEvidenceAssemblyState,
  buildCompletionEvidenceRecord,
  persistCompletionEvidenceArtifact,
});

function safeCliExit(cliResult) {
  return {
    code: cliResult.code,
    signal: cliResult.signal,
    timed_out: cliResult.timed_out,
    spawn_error: cliResult.spawn_error === null ? null : "reviewer process spawn failed",
    stdout_bytes: cliResult.stdout_bytes,
    stderr_bytes: cliResult.stderr_bytes,
    tool_surface_check: safeToolSurfaceTelemetry(cliResult.tool_surface_check),
    output_safety_check: {
      status: cliResult.output_safety_check?.status ?? "unknown",
      classification: cliResult.output_safety_check?.classification ?? "unknown",
      ...(cliResult.output_safety_check?.reason === undefined
        ? {}
        : { reason: cliResult.output_safety_check.reason }),
      ...(cliResult.output_safety_check?.stream === undefined
        ? {}
        : { stream: cliResult.output_safety_check.stream }),
      ...(cliResult.output_safety_check?.max_line_bytes === undefined
        ? {}
        : { max_line_bytes: cliResult.output_safety_check.max_line_bytes }),
      ...(cliResult.output_safety_check?.line_bytes === undefined
        ? {}
        : { line_bytes: cliResult.output_safety_check.line_bytes }),
      ...(cliResult.output_safety_check?.classification_reason === undefined
        ? {}
        : { classification_reason: cliResult.output_safety_check.classification_reason }),
    },
    process_spawned: cliResult.process_spawned,
    process_close_observed: cliResult.process_close_observed,
    transport_cleanup_confirmed: cliResult.transport_cleanup_confirmed,
    ...(cliResult.reviewer_transport_convergence === undefined ? {} : {
      reviewer_transport_convergence:
        safeReviewerConvergenceTelemetry(cliResult.reviewer_transport_convergence),
    }),
    ...(cliResult.fault_classification === undefined
      ? {}
      : { fault_classification: cliResult.fault_classification }),
    ...(cliResult.fault_reason === undefined ? {} : { fault_reason: cliResult.fault_reason }),
    ...(cliResult.hard_cap_termination === undefined
      ? {}
      : { hard_cap_termination: safeReviewerTerminationTelemetry(cliResult.hard_cap_termination) }),
    ...(cliResult.fault_termination === undefined
      ? {}
      : { fault_termination: safeReviewerTerminationTelemetry(cliResult.fault_termination) }),
    ...(cliResult.hard_cap_callback_error === undefined
      ? {}
      : { hard_cap_callback_error: "reviewer termination callback failed" }),
    ...(cliResult.fault_termination_callback_error === undefined
      ? {}
      : { fault_termination_callback_error: "reviewer termination callback failed" }),
  };
}

function safeOrchestrationFault(capsule) {
  const prefixLength = 12;
  return {
    classification: capsule.classification,
    responsibility: capsule.responsibility,
    denied_action_class: capsule.denied_action_class,
    evidence_provenance: capsule.evidence_provenance,
    evidence_confidence: capsule.evidence_confidence,
    matcher_id: capsule.matcher_id,
    capsule_id_prefix: capsule.integrity_id.slice(0, prefixLength),
    integrity_id_prefix: capsule.integrity_id.slice(0, prefixLength),
    next_step: "restore reviewer invocation permissions, then render a new dispatch retry",
  };
}

function safeSticky(sticky, { includeReason = true } = {}) {
  return {
    status: sticky?.status ?? "failed",
    classification: sticky?.classification ?? "sticky_verification_exception",
    pr_number: sticky?.pr_number ?? null,
    sticky_comment_id: sticky?.sticky_comment_id ?? null,
    sticky_comment_url: sticky?.sticky_comment_url ?? null,
    verdict: sticky?.verdict ?? null,
    last_reviewed_sha: sticky?.last_reviewed_sha ?? null,
    dispatch_id: sticky?.dispatch_id ?? null,
    expected_head_ref_oid: sticky?.expected_head_ref_oid ?? null,
    current_head_ref_oid: sticky?.current_head_ref_oid ?? null,
    ...(Number.isInteger(sticky?.authority_candidate_count)
      ? { authority_candidate_count: sticky.authority_candidate_count }
      : {}),
    ...(includeReason && typeof sticky?.reason === "string" ? { reason: sticky.reason } : {}),
    ...(typeof sticky?.reviewer_model === "string" ? { reviewer_model: sticky.reviewer_model } : {}),
  };
}

const reviewScopeProbeResultSchema = "devpro-review-scope-probe-result/v1";
const reviewScopeResolvedClassification = "review_material_scope_resolved";
const reviewScopeUnresolvableClassification = "review_material_scope_unresolvable";

function exactStringSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((value) => typeof value === "string" && expected.includes(value));
}

function publishReviewScopeProbeResult(context, record) {
  const filePath = context.review_scope_probe_result_path;
  if (!filePath) return false;
  let fd;
  try {
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function scopeProbeFailure(context, recipe, failureRelation) {
  const result = {
    schema: reviewScopeProbeResultSchema,
    status: "blocked",
    classification: reviewScopeUnresolvableClassification,
    route_id: recipe.route_id,
    scope_fingerprint_sha256: recipe.scope_fingerprint_sha256,
    failure_relation: failureRelation,
    generated_at: nowIso(),
  };
  if (!publishReviewScopeProbeResult(context, result)) {
    return { ...result, failure_relation: "probe_result_not_exclusively_publishable" };
  }
  return result;
}


const PACKET_COMPLETION_RECEIPT_FILE = "completion-receipt.json";

/**
 * Control-evidence remains the integrity SSOT. Operators and the skill treat the
 * attempt packet directory as the visible sealed-audit carrier, so mirror the
 * exact receipt bytes beside the packet after a successful control-evidence write.
 * Exclusive create — never overwrite an existing packet-local receipt.
 */
function publishPacketLocalCompletionReceipt(context, controlEvidenceReceiptPath) {
  const packetPath = context?.packet_path;
  if (typeof packetPath !== "string" || !path.isAbsolute(packetPath)) {
    throw new Error("packet_path must be an absolute file path before mirroring completion-receipt.json");
  }
  if (typeof controlEvidenceReceiptPath !== "string" || !path.isAbsolute(controlEvidenceReceiptPath)) {
    throw new Error("control-evidence completion receipt path must be absolute");
  }
  const dest = path.join(path.dirname(packetPath), PACKET_COMPLETION_RECEIPT_FILE);
  const bytes = readFileSync(controlEvidenceReceiptPath);
  let fd;
  try {
    fd = openSync(dest, "wx", 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    const code = error?.code ?? "unknown";
    throw new Error(`packet-local completion-receipt mirror failed (${code}): ${dest}`);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  // Confirm byte identity after close.
  const mirrored = readFileSync(dest);
  if (!mirrored.equals(bytes)) {
    throw new Error(`packet-local completion-receipt mirror byte mismatch: ${dest}`);
  }
  return dest;
}

function taggedCompletionReceiptError(code, cause) {
  const error = new Error(
    typeof cause?.message === "string" && cause.message
      ? cause.message
      : String(cause ?? code),
  );
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function persistCompletionReceiptWithPacketMirror(context, executionEnv, record) {
  let completion;
  try {
    completion = await writeCompletionReceipt({
      rootDir: evidenceRootForContext(context, executionEnv),
      record,
    });
  } catch (cause) {
    throw taggedCompletionReceiptError("completion_receipt_control_evidence_failed", cause);
  }
  let packetReceiptPath;
  try {
    packetReceiptPath = publishPacketLocalCompletionReceipt(context, completion.path);
  } catch (cause) {
    throw taggedCompletionReceiptError("completion_receipt_packet_mirror_failed", cause);
  }
  try {
    appendActivity(context, "projection_completion_receipt_written", {
      dispatch_id: record.dispatch_id,
      completion_integrity_id: completion.record.integrity_id,
      completion_receipt_path: completion.path,
      packet_completion_receipt_path: packetReceiptPath,
    });
  } catch (cause) {
    throw taggedCompletionReceiptError("completion_receipt_activity_failed", cause);
  }
  return completion;
}

export const __testCompletionReceiptMirror = Object.freeze({
  publishPacketLocalCompletionReceipt,
  PACKET_COMPLETION_RECEIPT_FILE,
});

function validateFullPrScopeProbePayload(payload, recipe) {
  const declared = recipe.declared_scope;
  const files = Array.isArray(payload?.files)
    ? payload.files.map((entry) => entry?.path ?? entry?.filename)
    : null;
  if (!isPlainObject(payload)
    || payload.number !== declared.pull_request_number
    || payload.headRefOid !== declared.head_sha) {
    return { ok: false, relation: "resolved_pr_or_head_mismatch" };
  }
  const changedFiles = payload.changedFiles;
  if (Number.isSafeInteger(changedFiles)
    && (files === null || changedFiles > files.length)) {
    return { ok: false, relation: "gh_pr_view_files_truncated" };
  }
  if (files === null
    || files.length > recipe.bounds.max_files
    || !exactStringSet(files, recipe.expected_changed_files)) {
    // Legacy single-page gh pr view --json files ceiling was 100; keep a named
    // truncation relation when the collected page looks truncated vs expected.
    if (Array.isArray(files)
      && files.length === 100
      && recipe.expected_changed_files.length > 100) {
      return { ok: false, relation: "gh_pr_view_files_truncated" };
    }
    return { ok: false, relation: "resolved_changed_files_mismatch_or_overflow" };
  }
  return {
    ok: true,
    resolvedScope: {
      kind: "full-pr",
      pull_request_number: payload.number,
      head_sha: payload.headRefOid,
    },
    counts: { files: files.length },
  };
}

function validateCommitRangeScopeProbePayload(payload, recipe) {
  const declared = recipe.declared_scope;
  const commits = Array.isArray(payload?.commits) ? payload.commits : null;
  const files = Array.isArray(payload?.files)
    ? payload.files.map((entry) => entry?.filename)
    : null;
  if (!isPlainObject(payload)
    || payload?.base_commit?.sha !== declared.base_sha
    || payload?.merge_base_commit?.sha !== declared.base_sha
    || commits === null
    || commits.at(-1)?.sha !== declared.head_sha) {
    return { ok: false, relation: "resolved_base_head_or_merge_base_mismatch" };
  }
  if (payload.status !== "ahead"
    || payload.behind_by !== 0
    || !Number.isSafeInteger(payload.ahead_by)
    || !Number.isSafeInteger(payload.total_commits)
    || payload.ahead_by !== payload.total_commits
    || commits.length !== payload.total_commits
    || payload.total_commits < 1
    || payload.total_commits > recipe.bounds.max_commits) {
    return { ok: false, relation: "resolved_commit_relation_diverged_or_truncated" };
  }
  if (!exactStringSet(files, recipe.expected_changed_files)
    || files.length > recipe.bounds.max_files) {
    return { ok: false, relation: "resolved_changed_files_mismatch_or_overflow" };
  }
  return {
    ok: true,
    resolvedScope: {
      kind: "commit-range",
      base_sha: payload.base_commit.sha,
      head_sha: commits.at(-1).sha,
      merge_base_sha: payload.merge_base_commit.sha,
    },
    counts: {
      commits: payload.total_commits,
      files: files.length,
    },
  };
}

export function runReviewScopeProbe(context, reviewData, options = {}) {
  assertCanonicalReviewerCliRecipe(context, { reviewData });
  const recipe = context.review_scope_read_recipe;
  if (recipe === undefined) {
    return { status: "not-required", classification: "not-required" };
  }
  appendActivity(context, "projection_review_scope_probe_started", {
    route_id: recipe.route_id,
    scope_fingerprint_sha256: recipe.scope_fingerprint_sha256,
  });
  const run = options.spawnSync ?? spawnSync;
  const probeEnv = { ...(options.env ?? process.env), GH_REPO: context.repository_slug };
  const runGhProbeArgv = (argv) => {
    try {
      return run(recipe.executable, argv, {
        encoding: "utf8",
        maxBuffer: recipe.bounds.max_output_bytes,
        env: probeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return { error: new Error("probe_execution_failed"), status: 1, stdout: "" };
    }
  };
  const readStdout = (commandResult) => {
    if (typeof commandResult?.stdout === "string") return commandResult.stdout;
    if (Buffer.isBuffer(commandResult?.stdout)) return commandResult.stdout.toString("utf8");
    return "";
  };
  const commandFailed = (commandResult, stdout) => (
    Boolean(commandResult?.error)
    || commandResult?.status !== 0
    || Buffer.byteLength(stdout, "utf8") > recipe.bounds.max_output_bytes
  );

  let payload;
  if (recipe.route_id === "gh-pr-bounded-live-v1") {
    if (!Array.isArray(recipe.files_list_argv) || recipe.files_list_argv.length === 0) {
      return scopeProbeFailure(context, recipe, "probe_route_not_supported");
    }
    const headResult = runGhProbeArgv(recipe.argv);
    const headStdout = readStdout(headResult);
    if (commandFailed(headResult, headStdout)) {
      return scopeProbeFailure(context, recipe, "probe_execution_failed_or_output_overflow");
    }
    const filesResult = runGhProbeArgv(recipe.files_list_argv);
    const filesStdout = readStdout(filesResult);
    if (commandFailed(filesResult, filesStdout)) {
      return scopeProbeFailure(context, recipe, "probe_execution_failed_or_output_overflow");
    }
    // Re-bind head after the files list so a push between the two reads cannot
    // attach a newer file set to a stale headRefOid (sticky F3).
    const headAfterResult = runGhProbeArgv(recipe.argv);
    const headAfterStdout = readStdout(headAfterResult);
    if (commandFailed(headAfterResult, headAfterStdout)) {
      return scopeProbeFailure(context, recipe, "probe_execution_failed_or_output_overflow");
    }
    let headPayload;
    let headAfterPayload;
    try {
      headPayload = JSON.parse(headStdout);
      headAfterPayload = JSON.parse(headAfterStdout);
    } catch {
      return scopeProbeFailure(context, recipe, "probe_response_not_json");
    }
    if (headAfterPayload?.number !== headPayload?.number
      || headAfterPayload?.headRefOid !== headPayload?.headRefOid
      || headAfterPayload?.changedFiles !== headPayload?.changedFiles) {
      return scopeProbeFailure(context, recipe, "resolved_pr_or_head_mismatch");
    }
    // Path-only --jq '.[].filename' under --paginate yields one filename per line.
    // Accept that wire shape (and a JSON string-array fallback for fixtures).
    let filePaths;
    const trimmedFiles = filesStdout.trim();
    if (trimmedFiles.startsWith("[")) {
      let parsed;
      try {
        parsed = JSON.parse(trimmedFiles);
      } catch {
        return scopeProbeFailure(context, recipe, "probe_response_not_json");
      }
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
        return scopeProbeFailure(context, recipe, "probe_response_not_json");
      }
      filePaths = parsed;
    } else {
      filePaths = trimmedFiles.length === 0
        ? []
        : trimmedFiles.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (filePaths.some((line) => line.startsWith("{") || line.startsWith("["))) {
        return scopeProbeFailure(context, recipe, "probe_response_not_json");
      }
    }
    payload = {
      number: headPayload?.number,
      headRefOid: headPayload?.headRefOid,
      changedFiles: headPayload?.changedFiles,
      files: filePaths.map((filename) => ({ path: filename })),
    };
  } else {
    const commandResult = runGhProbeArgv(recipe.argv);
    const stdout = readStdout(commandResult);
    if (commandFailed(commandResult, stdout)) {
      return scopeProbeFailure(context, recipe, "probe_execution_failed_or_output_overflow");
    }
    try {
      payload = JSON.parse(stdout);
    } catch {
      return scopeProbeFailure(context, recipe, "probe_response_not_json");
    }
  }
  const validation = recipe.route_id === "gh-pr-bounded-live-v1"
    ? validateFullPrScopeProbePayload(payload, recipe)
    : recipe.route_id === "gh-api-exact-compare-v1"
      ? validateCommitRangeScopeProbePayload(payload, recipe)
      : { ok: false, relation: "probe_route_not_supported" };
  if (!validation.ok) {
    return scopeProbeFailure(context, recipe, validation.relation);
  }
  const result = {
    schema: reviewScopeProbeResultSchema,
    status: "verified",
    classification: reviewScopeResolvedClassification,
    route_id: recipe.route_id,
    scope_fingerprint_sha256: recipe.scope_fingerprint_sha256,
    declared_scope: recipe.declared_scope,
    resolved_scope: validation.resolvedScope,
    counts: validation.counts,
    generated_at: nowIso(),
  };
  if (!publishReviewScopeProbeResult(context, result)) {
    return { ...result, status: "blocked", classification: reviewScopeUnresolvableClassification, failure_relation: "probe_result_not_exclusively_publishable" };
  }
  appendActivity(context, "projection_review_scope_probe_result", {
    classification: result.classification,
    route_id: result.route_id,
    scope_fingerprint_sha256: result.scope_fingerprint_sha256,
  });
  return result;
}

// ── fix-flow-gate-gaps R3: authoritative pre-spawn live-head comparison ────
//
// The runner is the last zero-cost interception point before the reviewer
// process spawns. A pr-sticky packet whose declared head is already stale (a
// remediation commit that was never pushed, or a rewritten head) MUST be
// stopped here instead of burning a whole reviewer round on a head that no
// longer exists — the remediation order is
// commit → push → suite/receipt → render/dispatch (code-review-cross-model.md
// §Head movement ordering; devpro:pre-pr SKILL §Step 5.5).
//
// Applicability predicate (design D3.2): mode === "pr-sticky" ∧ packet
// head_ref_oid is 40-hex ∧ the carrier has no authoritative head comparison of
// its own (embedded-diff — no review_scope_read_recipe; full-pr / commit-range
// keep their existing recipe comparisons untouched, so this check is a no-op
// for them). Any predicate miss is a no-op, so audit-only / design-gate
// packets (head_ref_oid: none) and unresolved-PR dispatch shapes are never
// blocked by this check.
//
// Two-state disposition (design D3.2) — both terminal pre-spawn, processSpawned:
// false, zero sticky mutation, event projection_cli_blocked_before_start:
//   (a) both sides resolvable and different → failure_relation
//       "resolved_pr_or_head_mismatch" (existing literal, family unchanged);
//   (b) comparison not executable (gh failure / timeout / no PR / unparseable
//       head) → failure_relation "probe_result_not_exclusively_publishable"
//       (existing probe-fault literal, family unchanged) and a reason that
//       names the probe fault — never a head mismatch.
// NO automatic retry: a bounded retry would multiply the probe cost and can
// mask a persistent auth/PR fault; repair gh/auth/PR state and re-render
// (F-r2-02 decision record).
const PR_HEAD_REF_OID_RE = /^[0-9a-f]{40}$/;
const LIVE_HEAD_PROBE_TIMEOUT_MS = 30000;

function liveHeadProbeApplies(context) {
  return context.mode === "pr-sticky"
    && PR_HEAD_REF_OID_RE.test(String(context.head_ref_oid ?? ""))
    && context.review_scope_read_recipe === undefined;
}

function liveHeadProbeBlocked(failureRelation, reason) {
  return {
    status: "blocked",
    classification: reviewScopeUnresolvableClassification,
    failure_relation: failureRelation,
    reason,
  };
}

function verifyLiveHeadBeforeSpawn(context, options = {}) {
  if (!liveHeadProbeApplies(context)) return { status: "not-applicable" };
  const packetHead = String(context.head_ref_oid);
  const prNumber = resolvePrNumber(context);
  const slug = String(context.repository_slug ?? "");
  if (!prNumber) {
    return liveHeadProbeBlocked(
      "probe_result_not_exclusively_publishable",
      `authoritative live head probe 不可用（非 head mismatch）：packet 無法解析 PR 號（target=${String(context.target ?? "none")}）；reviewer 尚未 spawn。下一步：修復 gh／auth／PR 狀態後重 render packet（commit → push → suite/receipt → render/dispatch），不自動重試。`,
    );
  }
  const run = options.spawnSync ?? spawnSync;
  let view;
  try {
    view = run("gh", ["pr", "view", prNumber, "--repo", slug, "--json", "headRefOid"], {
      cwd: repoRoot,
      env: { ...(options.env ?? process.env), GH_REPO: slug },
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: LIVE_HEAD_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return liveHeadProbeBlocked(
      "probe_result_not_exclusively_publishable",
      `authoritative live head probe 不可用（非 head mismatch）：gh pr view ${prNumber} --repo ${slug} 執行失敗（${String(error?.message ?? "unknown error")}）；reviewer 尚未 spawn。下一步：修復 gh／auth／PR 狀態後重 render packet，不自動重試。`,
    );
  }
  let headPayload = null;
  try {
    headPayload = JSON.parse(String(view?.stdout ?? ""));
  } catch {
    headPayload = null;
  }
  if (view?.status !== 0) {
    return liveHeadProbeBlocked(
      "probe_result_not_exclusively_publishable",
      `authoritative live head probe 不可用（非 head mismatch）：gh pr view ${prNumber} --repo ${slug} 失敗（exit=${String(view?.status ?? "none")}；${String(view?.stderr ?? "").trim().slice(-200)}）；reviewer 尚未 spawn。下一步：修復 gh／auth／PR 狀態後重 render packet，不自動重試。`,
    );
  }
  const liveHead = headPayload !== null && typeof headPayload === "object" && !Array.isArray(headPayload)
    ? headPayload.headRefOid
    : null;
  if (!PR_HEAD_REF_OID_RE.test(String(liveHead ?? ""))) {
    return liveHeadProbeBlocked(
      "probe_result_not_exclusively_publishable",
      `authoritative live head probe 不可用（非 head mismatch）：gh pr view ${prNumber} --repo ${slug} 回傳的 headRefOid 不可解析；reviewer 尚未 spawn。下一步：修復 gh／auth／PR 狀態後重 render packet，不自動重試。`,
    );
  }
  if (String(liveHead) !== packetHead) {
    return liveHeadProbeBlocked(
      "resolved_pr_or_head_mismatch",
      `packet head_ref_oid ${packetHead} 與 live PR #${prNumber} headRefOid ${liveHead} 不一致；reviewer 尚未 spawn。下一步：把修正後的 head push 上去後重 render packet（commit → push → suite/receipt → render/dispatch）。`,
    );
  }
  return { status: "verified" };
}

// Post-exit proof for one OpenCode window. It only runs for a cleanly closed reviewer; any
// other exit already carries its own classification and has no trustworthy session to export.
function collectOpenCodeWindowEvidence(context, cliResult, { reviewerExecutable, baseEnv, verify }) {
  if (cliResult.process_spawned !== true
    || cliResult.process_close_observed !== true
    || cliResult.timed_out === true
    || cliResult.code !== 0
    || cliResult.fault_classification !== undefined) {
    return { status: "skipped", classification: null, reason: "reviewer_not_cleanly_closed", observed: null, report_text: null };
  }
  let check;
  try {
    check = verify({
      oc: context.reviewer_opencode,
      executable: reviewerExecutable,
      env: reviewerSpawnEnv(context, { baseEnv }),
      cwd: context.neutral_cwd_path,
      packetBytes: cliResult.opencode_input_bytes,
      events: cliResult.opencode_run_events,
    });
  } catch (error) {
    check = {
      status: "failed",
      classification: error?.classification ?? "opencode_export_unavailable",
      reason: "opencode session evidence could not be collected",
      observed: null,
      report_text: null,
    };
  }
  appendActivity(
    context,
    check.status === "verified" ? "projection_opencode_session_verified" : "projection_opencode_session_unverified",
    {
      status: check.status,
      classification: check.classification,
      observed_selector: check.observed?.selector ?? null,
      requested_variant: context.reviewer_opencode?.selection.variant ?? null,
      observed_variant: check.observed?.variant ?? null,
    }
  );
  return check;
}

export async function runProjection(contextPath, options = {}) {
  const executionEnv = options.env ?? process.env;
  if (executionEnv[terminalReviewerMarker] === "1") {
    return {
      status: "blocked",
      classification: "projection_recursive_reentry",
    };
  }
  // D5 (add-second-reviewer-runner-permission): the runner cwd/node self-check
  // runs here — after the recursive-reentry check, before
  // authorizeSecondReviewPacketFile and before any mutation. Every in-process
  // caller (this function, whether invoked from the CLI entrypoint or from a
  // test) goes through this same call.
  const selfCheckResult = projectionRunnerCwdSelfCheck(contextPath, options);
  if (selfCheckResult !== null) {
    return selfCheckResult;
  }
  let context = null;
  let reviewData;
  let trustedAuthorization;

  try {
    trustedAuthorization = authorizeSecondReviewPacketFile({ contextPath, env: executionEnv });
    context = { ...trustedAuthorization.context };
    reviewData = trustedAuthorization.data;
    validateRunnerContext(context, reviewData);
    if(context.mode==='pr-sticky')assertReviewGithubTransportContext(context,{env:executionEnv});
    context.retry_context = reviewData.retry_context ?? null;
    context.primary_family = reviewData.primary_family ?? null;
  } catch (error) {
    return {
      status: "blocked",
      classification: error.classification ?? "projection_context_invalid",
      error: error.message,
      ...(context === null ? {} : pathsPayload(context)),
    };
  }

  try {
    assertTrustedSecondReviewAuthorization(trustedAuthorization, contextPath);
  } catch (error) {
    return {
      status: "blocked",
      classification: error.classification ?? "reviewer_dispatch_identity_collision",
      error: error.message,
      ...pathsPayload(context),
    };
  }

  const ackPreflight = preflightProjectionHandoff(contextPath, {
    trustedAuthorization,
  });
  if (ackPreflight.status !== "ok") {
    return {
      status: "blocked",
      classification: ackPreflight.classification,
      error: ackPreflight.error,
      ...pathsPayload(context),
    };
  }

  let ownership;
  try {
    ownership = acquireAttemptOwnership(contextPath, context.attempt_id);
  } catch (error) {
    ownership = {
      owned: false,
      lockPath: attemptLockPath(contextPath),
      error: error.message,
    };
  }
  if (!ownership.owned) {
    const nextStep = ownership.ownerState === "dead"
      ? deadOwnerRecoveryHint(context, executionEnv)
      : null;
    const result = {
      status: "blocked",
      classification: ownership.classification,
      ownership_lock_path: ownership.lockPath,
      ownership_state: ownership.ownerState,
      error: ownership.error,
      ...(nextStep === null ? {} : { next_step: nextStep }),
      ...pathsPayload(context),
    };
    appendActivity(context, result.classification, result);
    return result;
  }

  let neutralCwdCreated = false;
  let reviewerHomeCreated = false;
  let reviewerHomeDir = null;
  let reviewerHomeRoot = null;
  // D4 (R5; tasks.md T25-T26): holds the D6 write-capability preflight's own result once
  // it runs, so the environment-claim-corroboration diagnostic below can consume the fact
  // the caller already holds instead of re-reading the activity log to rediscover it
  // (AGENTS self-check #10 — one carrier for one fact). Stays false for any exit path
  // that never reaches (or never passes) the preflight, which is exactly what
  // classifyReviewerEnvironmentClaimCorroboration needs it to mean.
  let writeSurfaceProvedWritable = false;
  // Also hoisted (same reason as the two variables above): the finally block's own-home
  // teardown receipt (below) MUST derive processSpawned/processCloseObserved/
  // transportCleanupConfirmed from what actually happened, not assume the happy path —
  // an exception can unwind through this function at any point after the reviewer
  // process spawns, including before hard-cap/close/cleanup are ever confirmed, and a
  // finally block that hardcodes "closed and cleaned" would misreport a possibly-live
  // descendant as safely torn down.
  let cliResult = null;
  let dispatchRecordForUsageManifest = null;
  let boundedEvidenceForUsageManifest = null;
  let reviewerModelForUsageManifest = null;
  let usageManifestWindowAttempted = false;
  let usageManifestPendingWindowIndex = null;
  const configuredUsageWindowCount = context.page_window_checkpoint_handoff === true ? Math.max(1, Number(context.page_window_count) || 1) : 1;
  const usageManifestCoverage = { configured_window_count: configuredUsageWindowCount, planned_window_count: configuredUsageWindowCount, invoked_window_count: 0, invoked_windows: [] };
  const usageManifestWriteGaps = [];
  function persistUsageManifestForWindow(windowIndex = null, { boundedEvidence = null, reviewerModel = null } = {}) {
    // Invocation bookkeeping remains trustworthy even if the advisory builder
    // throws. Failed rows are never retried by the coverage-only finalizer.
    const binding = windowIndex === null ? null : { index: windowIndex, host: null, session_id: null };
    if (binding) {
      usageManifestCoverage.invoked_windows.push(binding);
      usageManifestCoverage.invoked_window_count = usageManifestCoverage.invoked_windows.length;
    }
    try {
      if (binding) {
        const session = extractReviewerSessionEntry(boundedEvidence, context.reviewer_cli_recipe?.tool);
        binding.host = session?.host ?? null;
        binding.session_id = session?.session_id ?? null;
      }
      const manifest = (options.usageManifestBuilder ?? buildUsageManifest)({ context, dispatchRecord: dispatchRecordForUsageManifest,
        boundedEvidence, env: executionEnv, reviewerModel, pagedCoverage: usageManifestCoverage });
      manifest.gaps.push(...usageManifestWriteGaps);
      (options.usageManifestWriter ?? writeUsageManifest)({ rootDir: evidenceRootForContext(context, executionEnv), manifest });
      appendActivity(context, "usage_manifest_written", { dispatch_id: dispatchRecordForUsageManifest.dispatch_id, window_index: windowIndex });
    } catch (error) {
      if (windowIndex !== null) usageManifestWriteGaps.push({ name: "reviewer-window-manifest-write-failed", window_index: windowIndex, detail: `usage manifest persistence failed for invoked window ${windowIndex}` });
      appendActivity(context, "usage_manifest_write_failed", {
        dispatch_id: dispatchRecordForUsageManifest.dispatch_id,
        window_index: windowIndex,
        usage_gap: windowIndex === null ? "usage-manifest-missing" : "reviewer-window-manifest-write-failed",
        error: error.message,
      });
    }
  }
  // D7/D12 (tasks.md items 10/12/13): the reviewer-model-record's observed_*
  // fields come from THIS hoisted result, never from reviewerModelForUsageManifest
  // above (which can hold a legal self-report on an unavailable observed
  // identity -- D7 forbids writing self-report into observed_*). Last window
  // wins, same as reviewerModelForUsageManifest and D5's own rollout ordering.
  let reviewerObservedIdentityForRecord = { model: null, source: null, reason: "stream_identity_absent" };
  try {
    appendActivity(context, "projection_attempt_lock_acquired", {
      ownership_lock_path: ownership.lockPath,
      owner_pid: ownership.owner.pid,
    });
    const ack = acknowledgeProjectionHandoff(contextPath, { preflight: ackPreflight });
    if (ack.status !== "ok") {
      return {
        status: "blocked",
        classification: ack.classification,
        error: ack.error,
        ...pathsPayload(context),
      };
    }

    const dispatchRecord = trustedAuthorization === null
      ? secondReviewDispatchRecord({
          context,
          packetBytes: readFileSync(context.packet_path),
        })
      : secondReviewDispatchBaseRecord(trustedAuthorization.dispatch_record);
    dispatchRecordForUsageManifest = dispatchRecord;
    const reservationDispatchRecord = trustedAuthorization?.dispatch_record ?? dispatchRecord;
    const existingEvidence = readDispatchEvidence({
      rootDir: evidenceRootForContext(context, executionEnv),
      dispatchId: dispatchRecord.dispatch_id,
    });
    if (existingEvidence.invocationClaim
      || existingEvidence.completion
      || existingEvidence.terminal
      || existingEvidence.capsule
      || existingEvidence.consumption
      || existingEvidence.supersession
      || existingEvidence.operatorDisposition) {
      const recovery = attemptHasCloseEvidence(existingEvidence)
        ? ""
        : `; ${interruptedDispatchRecoveryHint(context.attempt_id)}`;
      const error = new Error(`dispatch already contains invocation or terminal evidence${recovery}`);
      error.classification = "reviewer_dispatch_identity_collision";
      throw error;
    }

    if (options.envSanitization?.changed === true) {
      appendActivity(context, "projection_dispatch_env_sanitized", {
        removed_path_entry_count: options.envSanitization.removed_path_entry_count,
        node_options_cleared: options.envSanitization.node_options_cleared,
      });
    }

    const reviewerExecutableResolution = resolveReviewerExecutable(
      context.reviewer_cli_recipe.tool,
      options.executableDiscoveryOptions ?? {}
    );
    if (reviewerExecutableResolution.status !== "trusted") {
      await persistClosedTerminalReceipt({
        context,
        dispatchRecord,
        rootDir: evidenceRootForContext(context, executionEnv),
        classification: "tool_discovery_blocked",
        processSpawned: false,
        lifecyclePhase: "pre_spawn_known_terminal",
        processCloseObserved: false,
        transportCleanupConfirmed: true,
        invocationClaimSha256: null,
      });
      const result = {
        status: "blocked",
        classification: "tool_discovery_blocked",
        reason: reviewerExecutableResolution.reason,
        ...pathsPayload(context),
      };
      appendActivity(context, "projection_tool_discovery_blocked", result);
      refreshHeartbeat(context, "blocked", result);
      return result;
    }
    const reviewerExecutable = reviewerExecutableResolution.executable;

    const stickyWriteDisposition = revalidateSecondReviewStickyWriteDisposition(
      context,
      options.stickyDispositionOptions ?? {}
    );
    if (stickyWriteDisposition.status !== "verified") {
      await persistClosedTerminalReceipt({
        context,
        dispatchRecord,
        rootDir: evidenceRootForContext(context, executionEnv),
        classification: "sticky_write_disposition_blocked",
        processSpawned: false,
        lifecyclePhase: "pre_spawn_known_terminal",
        processCloseObserved: false,
        transportCleanupConfirmed: true,
        invocationClaimSha256: null,
      });
      const result = {
        status: "blocked",
        classification: "sticky_write_disposition_blocked",
        disposition_classification: stickyWriteDisposition.disposition_classification ?? null,
        reason: stickyWriteDisposition.reason,
        ...pathsPayload(context),
      };
      appendActivity(context, "projection_sticky_write_disposition_blocked", result);
      refreshHeartbeat(context, "blocked", result);
      return result;
    }

    const scopeProbe = runReviewScopeProbe(context, reviewData, {
      ...(options.scopeProbeOptions ?? {}),
      env: executionEnv,
    });
    if (scopeProbe.classification === reviewScopeUnresolvableClassification) {
      await persistClosedTerminalReceipt({
        context,
        dispatchRecord,
        rootDir: evidenceRootForContext(context, executionEnv),
        classification: scopeProbe.classification,
        processSpawned: false,
        lifecyclePhase: "pre_spawn_known_terminal",
        processCloseObserved: false,
        transportCleanupConfirmed: true,
        invocationClaimSha256: null,
      });
      const result = {
        status: "blocked",
        classification: scopeProbe.classification,
        failure_relation: scopeProbe.failure_relation,
        ...pathsPayload(context),
      };
      appendActivity(context, "projection_cli_blocked_before_start", result);
      refreshHeartbeat(context, "blocked", result);
      return result;
    }
    // fix-flow-gate-gaps R3 (design D3.2): authoritative live-head comparison in
    // the same pre-spawn segment as the scope probe, before the reviewer CLI
    // probe. Applicability / two-state disposition live in
    // verifyLiveHeadBeforeSpawn() above.
    const liveHeadProbe = verifyLiveHeadBeforeSpawn(context, {
      ...(options.liveHeadProbeOptions ?? {}),
      env: executionEnv,
    });
    if (liveHeadProbe.status === "blocked") {
      await persistClosedTerminalReceipt({
        context,
        dispatchRecord,
        rootDir: evidenceRootForContext(context, executionEnv),
        classification: liveHeadProbe.classification,
        processSpawned: false,
        lifecyclePhase: "pre_spawn_known_terminal",
        processCloseObserved: false,
        transportCleanupConfirmed: true,
        invocationClaimSha256: null,
      });
      const result = {
        status: "blocked",
        classification: liveHeadProbe.classification,
        failure_relation: liveHeadProbe.failure_relation,
        reason: liveHeadProbe.reason,
        ...pathsPayload(context),
      };
      appendActivity(context, "projection_cli_blocked_before_start", result);
      refreshHeartbeat(context, "blocked", result);
      return result;
    }
    const probe = runProbeWithBoundExecutable(
      context,
      reviewerExecutable,
      context.reviewer_cli_recipe?.tool === "opencode"
        ? { env: executionEnv, ...(options.probeOptions ?? {}) }
        : options.probeOptions ?? {}
    );
    if (probe.classification !== "flags_supported") {
      if (TERMINAL_RECEIPT_CLASSIFICATIONS.has(probe.classification)) {
        await persistClosedTerminalReceipt({
          context,
          dispatchRecord,
          rootDir: evidenceRootForContext(context, executionEnv),
          classification: probe.classification,
          processSpawned: false,
          lifecyclePhase: "pre_spawn_known_terminal",
          processCloseObserved: false,
          transportCleanupConfirmed: true,
          invocationClaimSha256: null,
        });
      }
      const result = {
        status: "blocked",
        classification: probe.classification,
        missing_required_flags: probe.missing_required_flags ?? [],
        ...pathsPayload(context),
      };
      appendActivity(context, "projection_cli_blocked_before_start", result);
      refreshHeartbeat(context, "blocked", result);
      return result;
    }

    materializeNeutralCwd(context, reviewData);
    neutralCwdCreated = true;
    appendActivity(context, "projection_neutral_cwd_materialized", {
      neutral_cwd_path: context.neutral_cwd_path,
    });

    // D6 write-capability preflight (R4; tasks.md T23-T24) — same window as the D3 gate
    // below (design.md D6 "落點": after materializeNeutralCwd(), before
    // claimDispatchInvocation()), but placed BEFORE the Codex-only D3 gate rather than
    // after it, for two reasons: (1) R4 is tool-agnostic (proposal.md R4 carries no
    // `tool === "codex"` condition) — it must run for the Claude path too, which the D3
    // gate below never touches; (2) running it first avoids building (and then having to
    // tear down) an isolated Codex reviewer home for a dispatch that is about to fail
    // closed anyway, and it keeps `reviewerHomeCreated` false at this point, so a
    // write-surface failure can never be re-classified by the D3 gate's own
    // reviewer_home_teardown_retry_exhausted path (RD12) — there is nothing for that path
    // to tear down yet.
    const writeCapabilityProbe = verifyReviewerWriteSurface({
      neutralCwdPath: context.neutral_cwd_path,
      dispatchId: context.dispatch_id,
      fsSeam: options.writeCapabilityProbeDeps ?? {},
    });
    if (!writeCapabilityProbe.verified) {
      await persistClosedTerminalReceipt({
        context,
        dispatchRecord,
        rootDir: evidenceRootForContext(context, executionEnv),
        classification: writeCapabilityProbe.classification,
        processSpawned: false,
        lifecyclePhase: "pre_spawn_known_terminal",
        processCloseObserved: false,
        transportCleanupConfirmed: true,
        invocationClaimSha256: null,
      });
      const result = {
        status: "blocked",
        classification: writeCapabilityProbe.classification,
        ...pathsPayload(context),
      };
      // Single named result event, mirroring the tool_discovery_blocked/
      // sticky_write_disposition_blocked branches above rather than the generic
      // projection_cli_blocked_before_start — the event name is the classification token
      // itself (same convention as codex_home_clamp_not_applied /
      // reviewer_home_teardown_retry_exhausted below), not a second name for the same fact.
      appendActivity(context, "reviewer_write_surface_unverified", result);
      refreshHeartbeat(context, "blocked", result);
      return result;
    }
    // Positive result event (design.md D6 "observability"): records that this dispatch's
    // environment was proved writable, for anyone reading the activity log after the
    // fact. No path is included in the payload (`:62` path-bearing discipline extends to
    // success payloads too, not only failure ones). R5 (D4; tasks.md T25-T26) does not
    // re-read this log entry — it consumes the `writeSurfaceProvedWritable` flag set
    // immediately below, the same fact this event already carries (self-check #10).
    appendActivity(context, "reviewer_write_surface_verified", { dispatch_id: context.dispatch_id });
    writeSurfaceProvedWritable = true;

    // D3 credential continuity gate (R6; tasks.md T19-T22) — same window as neutral cwd
    // materialization (design.md D3 "落點"): after materializeNeutralCwd(), before
    // claimDispatchInvocation(). Codex-only (design.md D3 〈條件化〉); the Claude path never
    // reads CODEX_HOME. A verification pass leaves the isolated home on disk (spawn env
    // picks it up via context.reviewer_codex_home_path, see reviewerSpawnEnv above) and
    // schedules it for the same ownership teardown as neutral cwd, below. A verification
    // that does not pass has already been torn down by the gate itself (step 5 degrade)
    // by the time this call returns.
    if (context.reviewer_cli_recipe?.tool === "codex") {
      const reviewerHomeGate = applyReviewerHomeCredentialContinuityGate(
        context,
        {
          ...(options.reviewerHomeGateOptions ?? {}),
          deps: {
            ...(options.reviewerHomeGateOptions?.deps ?? {}),
            controlRoot: evidenceRootForContext(context, executionEnv),
            env: executionEnv,
            baseEnv: options.reviewerHomeGateOptions?.deps?.baseEnv ?? executionEnv,
          },
        }
      );
      if (reviewerHomeGate.applied) {
        context.reviewer_codex_home_path = reviewerHomeGate.isolatedHomePath;
        reviewerHomeCreated = true;
        reviewerHomeDir = reviewerHomeGate.isolatedHomePath;
        reviewerHomeRoot = reviewerHomeGate.controlRoot;
      }
    }

    // OpenCode: the runner re-derives the launch config from the validated context, checks it
    // against the digest the renderer recorded and writes it privately before any spawn.
    // A mismatch (or an instruction file that changed since) is a pre-spawn terminal.
    if (context.reviewer_cli_recipe?.tool === "opencode") {
      try {
        materializeOpenCodeLaunchConfig(context, options.openCodeLaunchOptions ?? {});
        appendActivity(context, "projection_opencode_launch_config_materialized", {
          launch_config_sha256: context.reviewer_opencode.launch_config_sha256,
        });
      } catch (error) {
        await persistClosedTerminalReceipt({
          context,
          dispatchRecord,
          rootDir: evidenceRootForContext(context, executionEnv),
          classification: "reviewer_host_surface_unverified",
          processSpawned: false,
          lifecyclePhase: "pre_spawn_known_terminal",
          processCloseObserved: false,
          transportCleanupConfirmed: true,
          invocationClaimSha256: null,
        });
        const result = {
          status: "blocked",
          classification: "reviewer_host_surface_unverified",
          reason: error?.classification ?? "opencode_launch_config_invalid",
          ...pathsPayload(context),
        };
        appendActivity(context, "projection_opencode_launch_config_blocked", result);
        refreshHeartbeat(context, "blocked", result);
        return result;
      }
    }

    // The immutable helper reports a reservation/claim mismatch as
    // reviewer_dispatch_identity_collision before any reviewer process spawn.
    // Probe-only failures never acquire this single-spawn authority record.
    const invocationClaim = await claimDispatchInvocation({
      rootDir: evidenceRootForContext(context, executionEnv),
      record: reservationDispatchRecord,
    });
    const invocationClaimSha256 = canonicalInvocationClaimSha256(invocationClaim.record);
    appendActivity(context, "projection_dispatch_invocation_claimed", {
      dispatch_id: context.dispatch_id,
      invocation_claim_sha256: invocationClaimSha256,
    });

    if (context.page_window_checkpoint_handoff === true) {
      context.review_material = reviewData.review_material;
    }

    let hardCapSticky = null;
    // cliResult itself is hoisted above the try block (see comment there); this loop
    // reassigns the outer binding each pass rather than shadowing it with a new one.
    let boundedEvidence;
    let reviewerCompletion;
    let completionEvidenceArtifact = null;
    let stickyVerificationOptions;
    let orchestrationEvidence;
    let cliClassification;
    let activeOrchestrationEvidence;
    let sticky;
    let pageWindowLiveGate = { active: false };
    let currentReviewData = reviewData;
    let trustedDiscardedStdoutRanges = [];
    const maxPageWindows = context.page_window_checkpoint_handoff === true
      ? Math.max(1, Number(context.page_window_count) || 1)
      : 1;
    let pageWindowPassLimit = maxPageWindows;
    // #3623: one same-window re-dispatch for a completion-payload format defect, reset
    // whenever a window advances.
    let completionRetryUsed = 0;
    let priorGateSatisfyingSticky = stickyWriteDisposition.priorGateSatisfyingSticky ?? null;
    const roundTimeoutMs = options.totalTimeoutMs ?? totalTimeoutMs(context);
    let roundStartedAtMs;
    let roundDeadlineExpiredBetweenWindows = false;

    // Every launch advances this index, including retries of the same page window.
    for (let launchIndex = 0; launchIndex < pageWindowPassLimit; launchIndex += 1) {
      hardCapSticky = null;
      assertTrustedPageWindowState(context, currentReviewData, trustedAuthorization);
      const trustedPacketBytes = isTrustedPagedAuthorization(trustedAuthorization)
        ? canonicalPageWindowPacket(
            context,
            currentReviewData,
            context.sticky_write_disposition,
          )
        : undefined;
      const nowMs = performance.now();
      roundStartedAtMs ??= nowMs;
      const elapsedMs = Math.floor(nowMs - roundStartedAtMs);
      const remainingMs = roundTimeoutMs - elapsedMs;
      if (launchIndex > 0 && remainingMs <= 0) {
        sticky = verifyStickyFailClosed(context);
        cliClassification = "reviewer_cli_timeout";
        roundDeadlineExpiredBetweenWindows = true;
        appendActivity(context, "projection_page_window_deadline_exhausted", {
          total_timeout_ms: roundTimeoutMs,
          elapsed_ms: elapsedMs,
          next_window_pass: launchIndex + 1,
        });
        break;
      }
      cliResult = await runReviewerCli(context, {
        ...options,
        totalTimeoutMs: remainingMs,
        usageManifestWindowIndex: launchIndex + 1,
        baseEnv: executionEnv,
        reviewerExecutable,
        ...(trustedPacketBytes === undefined ? {} : { trustedPacketBytes }),
        onTotalHardCap: context.mode === "pr-sticky"
          ? () => {
              hardCapSticky = verifyStickyFailClosed(context);
            }
          : undefined,
      });
      boundedEvidenceForUsageManifest = cliResult.usage_manifest_evidence;
      reviewerModelForUsageManifest = null;
      usageManifestPendingWindowIndex = cliResult.process_spawned === true ? launchIndex + 1 : null;
      const currentStdoutTailStart = Math.max(
        0,
        statSync(context.stdout_log_path).size - BOUNDED_TAIL_EVIDENCE_MAX_BYTES,
      );
      trustedDiscardedStdoutRanges = retainTailRelevantByteRanges([
        ...trustedDiscardedStdoutRanges,
        ...normalizedDiscardedByteRanges(cliResult.discarded_stdout_thinking_ranges),
      ], currentStdoutTailStart);
      boundedEvidence = extractBoundedTerminalEvidence(context, {
        discardedStdoutRanges: trustedDiscardedStdoutRanges,
      });
      if (context.reviewer_cli_recipe?.tool === "opencode") {
        cliResult.opencode_evidence_check = collectOpenCodeWindowEvidence(context, cliResult, {
          reviewerExecutable,
          baseEnv: executionEnv,
          verify: options.openCodeEvidenceVerifier ?? verifyOpenCodeSessionEvidence,
        });
        boundedEvidence.openCodeReport = cliResult.opencode_evidence_check.status === "verified"
          ? cliResult.opencode_evidence_check.report_text
          : null;
      }
      // Invocation-scoped identity/usage is captured live; accumulated stdout
      // tails must never supply a previous window's session to a missing one.
      const codexHomePathForWindow = context.reviewer_cli_recipe?.tool === "codex"
        ? context.reviewer_codex_home_path
        : undefined;
      // D7/D12: computed ONCE per window (not re-derived via
      // extractExecutionStreamReviewerModel() a second time) — a second call
      // would re-scan the isolated home's rollout files against the codex
      // scan budget for no reason. streamReviewerModel below is the
      // string|null projection of this same result, kept for the existing
      // stickyVerificationOptions.streamIdentity / applyExecutionStreamReviewerModel
      // callers that only ever wanted the bare model.
      reviewerObservedIdentityForRecord = context.reviewer_cli_recipe?.tool === "opencode"
        ? resolveOpenCodeObservedIdentity(cliResult.opencode_evidence_check)
        : resolveReviewerObservedIdentity(boundedEvidence, {
          tool: context.reviewer_cli_recipe?.tool,
          codexHomePath: codexHomePathForWindow,
        });
      const streamReviewerModel = reviewerObservedIdentityForRecord.model;
      reviewerCompletion = parseReviewerCompletion(context, boundedEvidence);
      if (isPlainObject(reviewerCompletion?.completion)) {
        reviewerCompletion.completion.reviewer_model = streamReviewerModel
          ?? reviewerCompletion.completion.reviewer_model;
      }
      reviewerModelForUsageManifest = reviewerCompletion?.completion?.reviewer_model ?? null;
      if (cliResult.process_spawned === true && dispatchRecordForUsageManifest) {
        usageManifestWindowAttempted = true;
        // A CRITICAL sticky checkpoint may invoke the same material window
        // twice. Invocation indices stay distinct even when sessions/pages repeat.
        const windowIndex = launchIndex + 1;
        usageManifestPendingWindowIndex = null;
        persistUsageManifestForWindow(windowIndex, { boundedEvidence: boundedEvidenceForUsageManifest, reviewerModel: reviewerModelForUsageManifest });
      }
      if (reviewerCompletion?.guarantee_assessment) {
        appendActivity(context, "projection_guarantee_assessment", {
          window_index: context.page_window_index ?? null,
          ...reviewerCompletion.guarantee_assessment,
        });
      }
      // D5 (R2): persist the already-arrived completion payload BEFORE classification, so
      // the carrier never depends on how the dispatch gets classified and no later path
      // failure can suppress it. Writer-only; trigger set is shared with the diagnostic.
      completionEvidenceArtifact = persistCompletionEvidenceArtifact(context, {
        boundedEvidence,
        completion: reviewerCompletion,
        stdoutBytes: cliResult.stdout_bytes,
      });
      stickyVerificationOptions = {
        reviewerCompletion: reviewerCompletion.completion ?? null,
        completionRequired: !cliResult.timed_out,
        streamIdentity: streamReviewerModel,
      };
      orchestrationEvidence = classifyReviewerOrchestrationEvidence(boundedEvidence);
      cliClassification = classifyCliExit(
        context,
        cliResult,
        boundedEvidence,
        reviewerCompletion,
      );
      activeOrchestrationEvidence = orchestrationEvidence?.classification === cliClassification
        ? orchestrationEvidence
        : null;

      if (context.page_window_checkpoint_handoff === true) {
        pageWindowLiveGate = resolveLivePageWindowStickyGate({
          context,
          reviewMaterial: currentReviewData.review_material,
          completion: ["reviewer_cli_completed", "reviewer_completion_critical", "reviewer_completion_unavailable"].includes(cliClassification)
            ? reviewerCompletion : { status: "invalid" },
          priorGateSatisfyingSticky,
        });
        {
          const criticalUnion = collectCriticalFindings(
            pageWindowLiveGate.advanced?.findings_ledger,
          );
          let criticalClampError = null;
          try {
            if (criticalUnion.length > 0) bindCriticalStickyVerdict(context);
          } catch (error) {
            criticalClampError = error;
            pageWindowLiveGate = {
              ...pageWindowLiveGate,
              phase: "credential_gate_invalid", classification: error.classification,
              stickyAuthorized: false, continueToNextWindow: false, scanComplete: false,
            };
          }
          recordPageWindowLiveGate(context, pageWindowLiveGate, maxPageWindows, criticalUnion);
          if (criticalClampError) throw criticalClampError;
        }

        if (pageWindowLiveGate.phase === "intermediate"
          && pageWindowLiveGate.continueToNextWindow === true
          && pageWindowLiveGate.advanced) {
          currentReviewData = advancePageWindowPacketAndContext(
            context,
            currentReviewData,
            pageWindowLiveGate.advanced,
            trustedAuthorization,
          );
          // #3623: the retry budget belongs to one window; a completed window restores it.
          completionRetryUsed = 0;
          // Intermediate windows must not authorize PR sticky; continue spawning.
          sticky = {
            status: "skipped",
            classification: "page_window_intermediate_no_sticky",
            pr_number: context.pr_number ?? null,
            sticky_comment_id: null,
            sticky_comment_url: null,
            verdict: reviewerCompletion.completion?.verdict ?? null,
            last_reviewed_sha: reviewerCompletion.completion?.last_reviewed_sha ?? null,
            dispatch_id: context.dispatch_id,
          };
          recordCliExited(context, cliResult);
          continue;
        }

        if (
          pageWindowLiveGate.phase === "intermediate_critical_sticky"
          && pageWindowLiveGate.stickyAuthorized === true
          && pageWindowLiveGate.advanced
        ) {
          currentReviewData = prepareIntermediateCriticalStickyCheckpoint(
            context,
            currentReviewData,
            pageWindowLiveGate.advanced,
          );
          // Guarantee one more reviewer spawn for the CRITICAL sticky write.
          pageWindowPassLimit += 1;
          sticky = {
            status: "skipped",
            classification: "page_window_intermediate_critical_sticky_pending_write",
            pr_number: context.pr_number ?? null,
            sticky_comment_id: null,
            sticky_comment_url: null,
            verdict: reviewerCompletion.completion?.verdict ?? null,
            last_reviewed_sha: reviewerCompletion.completion?.last_reviewed_sha ?? null,
            dispatch_id: context.dispatch_id,
          };
          recordCliExited(context, cliResult);
          continue;
        }

        if (pageWindowLiveGate.phase === "critical_sticky_checkpoint") {
          sticky = verifyStickyFailClosed(context, { ...stickyVerificationOptions, acceptCriticalCheckpoint: true });
          recordCliExited(context, cliResult);
          if (cliClassification !== "reviewer_completion_critical"
            || sticky.status !== "verified" || sticky.verdict !== "CRITICAL") {
            pageWindowLiveGate = {
              ...pageWindowLiveGate, phase: "critical_sticky_checkpoint_failed",
              classification: sticky.classification, stickyAuthorized: false,
            };
            recordPageWindowLiveGate(context, pageWindowLiveGate, maxPageWindows,
              collectCriticalFindings(pageWindowLiveGate.advanced?.findings_ledger));
            break;
          }
          // Only the verified write may replace the original snapshot authority.
          context.sticky_write_disposition_authorized = sticky.write_disposition;
          delete context.page_window_critical_sticky_checkpoint;
          priorGateSatisfyingSticky = null;
          currentReviewData = advancePageWindowPacketAndContext(context, currentReviewData, {
            checkpoint_ledger: currentReviewData.review_material.checkpoint_ledger,
            findings_ledger: currentReviewData.review_material.findings_ledger,
          }, trustedAuthorization);
          // #3623: the CRITICAL checkpoint closes that window, so the retry budget resets.
          completionRetryUsed = 0;
          continue;
        } else if (pageWindowLiveGate.phase === "completion_invalid") {
          // #3623: a malformed completion payload is a format defect, not a review result.
          // Re-dispatch the same window once before the batch fails closed.
          const retryWindowIndex = Number.isSafeInteger(context.page_window_index)
            ? context.page_window_index
            : launchIndex + 1;
          const completionRetry = pageWindowCompletionRetry({
            gate: pageWindowLiveGate,
            retriesUsed: completionRetryUsed,
            runClean: cliResult.process_close_observed === true
              && cliResult.timed_out !== true
              && cliResult.fault_classification === undefined
              && cliResult.code === 0,
          });
          if (completionRetry.retry) {
            completionRetryUsed = completionRetry.retriesUsed;
            pageWindowPassLimit += 1;
            appendActivity(context, "projection_page_window_completion_retry", {
              window_index: retryWindowIndex,
              classification: pageWindowLiveGate.classification,
              retries_used: completionRetry.retriesUsed,
            });
            sticky = {
              status: "skipped",
              classification: "page_window_completion_contract_retry_pending",
              pr_number: context.pr_number ?? null,
              sticky_comment_id: null,
              sticky_comment_url: null,
              verdict: reviewerCompletion.completion?.verdict ?? null,
              last_reviewed_sha: reviewerCompletion.completion?.last_reviewed_sha ?? null,
              dispatch_id: context.dispatch_id,
            };
            recordCliExited(context, cliResult);
            continue;
          }
          const retryNote = ` (window_index=${retryWindowIndex}; the same window was already retried ${PAGE_WINDOW_COMPLETION_RETRY_LIMIT} time)`;
          bindBlockedStickyWriteDisposition(context, {
            classification: pageWindowLiveGate.classification,
            reason: `${pageWindowLiveGate.stickyGate?.reason ?? pageWindowLiveGate.classification}${retryNote}`,
          });
          recordCliExited(context, cliResult);
          sticky = {
            status: "failed",
            classification: pageWindowLiveGate.classification,
            pr_number: context.pr_number ?? null,
            sticky_comment_id: null,
            sticky_comment_url: null,
            verdict: reviewerCompletion.completion?.verdict ?? null,
            last_reviewed_sha: reviewerCompletion.completion?.last_reviewed_sha ?? null,
            dispatch_id: context.dispatch_id,
            reason: `${pageWindowLiveGate.stickyGate?.reason ?? pageWindowLiveGate.classification}${retryNote}`,
          };
          break;
        } else if (
          (
            pageWindowLiveGate.phase === "intermediate"
            && pageWindowLiveGate.continueToNextWindow !== true
          )
          || (
            pageWindowLiveGate.phase === "final"
            && pageWindowLiveGate.stickyAuthorized !== true
          )
        ) {
          bindBlockedStickyWriteDisposition(context, {
            classification: pageWindowLiveGate.classification,
            reason: pageWindowLiveGate.stickyGate?.reason
              ?? pageWindowLiveGate.classification
              ?? "Sticky write blocked by page-window aggregation gate.",
          });
          recordCliExited(context, cliResult);
          sticky = {
            status: "failed",
            classification: pageWindowLiveGate.classification,
            pr_number: context.pr_number ?? null,
            sticky_comment_id: null,
            sticky_comment_url: null,
            verdict: reviewerCompletion.completion?.verdict ?? null,
            last_reviewed_sha: reviewerCompletion.completion?.last_reviewed_sha ?? null,
            dispatch_id: context.dispatch_id,
            reason: pageWindowLiveGate.stickyGate?.reason
              ?? pageWindowLiveGate.classification,
          };
          break;
        }
      }

      if (context.mode === "pr-sticky") {
        try {
          sticky = hardCapSticky ?? verifyStickyFailClosed(context, stickyVerificationOptions);
          if(sticky?.status==='verified') {
            const observation=refreshSecondReviewGithubObservation(context,{cwd:repoRoot,env:executionEnv});
            if(!observation.skipped)appendActivity(context,'projection_github_observation_refreshed',observation);
          }
        } finally {
          recordCliExited(context, cliResult);
        }
      } else {
        sticky = verifyStickyFailClosed(context);
      }
      break;
    }

    // D12/D13 (tasks.md items 12/13): the reviewer-model-record's single
    // runner-owned write point. Window loop has ended and observed is
    // finalized (reviewerObservedIdentityForRecord, last-window-wins) — this
    // MUST run before ANY receipt is sealed for this dispatch (fault capsule
    // just below, both completion-receipt write call sites, and the post-spawn
    // persistClosedTerminalReceipt()), and strictly before `finally`'s
    // teardownReviewerHome() (D12 "順序是保證本身": record-first, receipt-after
    // makes the harmful "receipt sealed, record missing" sequence
    // unconstructable — a later failure here can never retroactively unpublish
    // an already hard-linked receipt, but no receipt exists yet at this point).
    // Gated on cliResult.process_spawned === true: the six pre-spawn terminal
    // paths above never reach this line (they each `return` before the window
    // loop starts), so "no review happened, no record" falls out of control
    // flow rather than a second explicit check here.
    if (cliResult.process_spawned === true) {
      const modelCliFamily = context.reviewer_cli_recipe?.tool;
      const selection = context.reviewer_model_selection;
      // D1/D13: requested_kind comes from the contract module's single
      // selection->kind mapping, never a family->kind table or an "unknown"
      // literal restated here (r1 finding F-srms-pr-02). The runner MUST NOT
      // call resolveSecondReviewerModel() again because that would re-read env
      // (D2 "runner 不重讀環境變數"); requestedKindForSelection() answers from
      // the already-resolved selection instead. assertReviewerModelSelection()
      // proved at validateRunnerContext() time that source ===
      // "built-in-default" implies requested equals the probe-proven exact identity,
      // so the kind it returns is provably the one that was resolved.
      const requestedKind = requestedKindForSelection(selection, modelCliFamily);
      const agreement = deriveReviewerModelAgreement({
        requestedModel: selection.requested,
        requestedKind,
        observedModel: reviewerObservedIdentityForRecord.model,
      });
      await writeReviewerModelRecord({
        rootDir: evidenceRootForContext(context, executionEnv),
        record: {
          repository_slug: dispatchRecord.repository_slug,
          pr_number: dispatchRecord.pr_number,
          head_ref_oid: dispatchRecord.head_ref_oid,
          attempt_id: dispatchRecord.attempt_id,
          dispatch_id: dispatchRecord.dispatch_id,
          previous_dispatch_id: dispatchRecord.previous_dispatch_id,
          reviewer_cli_family: modelCliFamily,
          requested_model: selection.requested,
          requested_source: selection.source,
          requested_source_env_var: selection.env_var ?? "none",
          requested_kind: requestedKind,
          observed_model: reviewerObservedIdentityForRecord.model ?? "none",
          observed_source: reviewerObservedIdentityForRecord.source ?? "none",
          observed_unavailable_reason: reviewerObservedIdentityForRecord.reason,
          agreement,
        },
      });
      appendActivity(context, "reviewer_model_record_written", {
        dispatch_id: dispatchRecord.dispatch_id,
        agreement,
      });
    }

    let status = cliClassification === "reviewer_cli_completed" ? "finished" : "blocked";
    let classification = cliClassification;
    if (context.mode === "pr-sticky" && !roundDeadlineExpiredBetweenWindows) {
      if (pageWindowLiveGate.active === true
        && pageWindowLiveGate.stickyAuthorized !== true
        && pageWindowLiveGate.phase !== "intermediate") {
        status = "blocked";
        classification = cliClassification === "reviewer_cli_interrupted"
          ? cliClassification : pageWindowLiveGate.classification;
      } else if (cliResult.timed_out && sticky.status === "verified") {
        status = "finished";
        classification = sticky.classification;
      } else if (sticky.status !== "verified") {
        status = "blocked";
        if (classification === "reviewer_cli_completed") classification = sticky.classification;
      }
    }

    // D4 (R1; fix-projection-completion-truncation): exactly one diagnostic event per
    // dispatch once the classification has settled, positioned after the audit-only
    // terminal anchors (projection_cli_exited → projection_sticky_verification_skipped,
    // both already emitted above) and before any receipt persist below. Emitted for both
    // the named truncation and the generic missing states; it is an observation, not an
    // outcome — it never changes status/classification and carries no reviewer content.
    let completionStreamEvidence = null;
    if (completionStreamDiagnosticApplies(context, reviewerCompletion)) {
      completionStreamEvidence = completionStreamEvidenceSummary({
        boundedEvidence,
        stdoutBytes: cliResult?.stdout_bytes,
        completionEvidence: completionEvidenceArtifact,
      });
      appendActivity(context, "projection_completion_stream_evidence", completionStreamEvidence);
    }

    if (activeOrchestrationEvidence !== null) {
      const capsule = await writeFaultCapsule({
        rootDir: evidenceRootForContext(context, executionEnv),
        record: {
          schema: FAULT_CAPSULE_SCHEMA,
          repository_slug: dispatchRecord.repository_slug,
          pr_number: dispatchRecord.pr_number,
          head_ref_oid: dispatchRecord.head_ref_oid,
          attempt_id: dispatchRecord.attempt_id,
          dispatch_id: dispatchRecord.dispatch_id,
          previous_dispatch_id: dispatchRecord.previous_dispatch_id,
          responsibility: ORCHESTRATION_RESPONSIBILITY,
          created_at: nowIso(),
          ...activeOrchestrationEvidence,
        },
      });
      const result = {
        status: "blocked",
        classification: activeOrchestrationEvidence.classification,
        orchestration_fault: safeOrchestrationFault(capsule.record),
        cli_exit: safeCliExit(cliResult),
        sticky: safeSticky(sticky, { includeReason: false }),
        ...(completionStreamEvidence === null
          ? {}
          : { completion_stream_evidence: completionStreamEvidence }),
      };
      refreshHeartbeat(context, "blocked", result);
      return result;
    }

    // D4/D5 (R5; tasks.md T25-T26) — non-terminal diagnostic, independent of the
    // classification/receipt above (design.md D5: reviewer_completion_unavailable already
    // owns the terminal receipt for this scenario; this is an additional activity-log
    // annotation, not a competing outcome). Gates on the reviewer's own typed `verdict`,
    // not on the (possibly orchestration-evidence-overridden) `classification` variable —
    // the question this answers is about the reviewer's own completion, unaffected by how
    // the dispatch's externally-reported outcome gets classified.
    const environmentClaimResult = classifyReviewerEnvironmentClaimCorroboration({
      mode: context.mode,
      tool: context.reviewer_cli_recipe?.tool ?? null,
      verdict: reviewerCompletion?.completion?.verdict ?? null,
      stdoutTruncated: boundedEvidence?.stdoutTruncated === true,
      stdoutStructuredEvents: boundedEvidence?.stdoutStructuredEvents ?? [],
      preflightProvedWritable: writeSurfaceProvedWritable,
    });
    if (environmentClaimResult === "reviewer_environment_claim_uncorroborated") {
      appendActivity(context, "reviewer_environment_claim_uncorroborated", {
        dispatch_id: context.dispatch_id,
      });
    }

    if (context.mode === "pr-sticky" && status === "finished") {
      if (sticky.status !== "verified" || cliResult.process_close_observed !== true) {
        status = "blocked";
        classification = "reviewer_transport_termination_unconfirmed";
      } else {
        try {
          await persistCompletionReceiptWithPacketMirror(context, executionEnv, {
            ...dispatchRecord,
            schema: COMPLETION_SCHEMA,
            outcome: "reviewer_process_closed_and_sticky_verified",
            classification: "sticky_verified",
            sticky_verdict: sticky.verdict,
            sticky_last_reviewed_sha: sticky.last_reviewed_sha,
            sticky_dispatch_id: sticky.dispatch_id,
            sticky_comment_id: sticky.sticky_comment_id,
            sticky_comment_url: sticky.sticky_comment_url,
            process_close_observed: true,
          });
        } catch (error) {
          status = "blocked";
          classification = error?.code === "completion_receipt_control_evidence_failed"
            || error?.code === "completion_receipt_packet_mirror_failed"
            || error?.code === "completion_receipt_activity_failed"
            ? error.code
            : "completion_receipt_packet_mirror_failed";
        }
      }
    }

    if (context.mode === "audit-only"
      && status === "finished"
      && cliResult.process_close_observed === true) {
      try {
        await persistCompletionReceiptWithPacketMirror(context, executionEnv, {
          ...dispatchRecord,
          schema: COMPLETION_SCHEMA,
          outcome: "reviewer_process_closed_audit_only",
          classification: "audit_only_verified",
          process_close_observed: true,
        });
      } catch (error) {
        status = "blocked";
        classification = error?.code === "completion_receipt_control_evidence_failed"
          || error?.code === "completion_receipt_packet_mirror_failed"
          || error?.code === "completion_receipt_activity_failed"
          ? error.code
          : "completion_receipt_packet_mirror_failed";
      }
    }

    if (status === "blocked" && activeOrchestrationEvidence === null) {
      const terminalClassification = closedTerminalClassification(
        classification,
        cliResult,
        sticky
      );
      const preSpawnKnownTerminal = classification === "reviewer_cli_spawn_failed"
        && cliResult.process_spawned === false
        && cliResult.spawn_error !== null
        && cliResult.transport_cleanup_confirmed === true;
      const postCloseTransportCleaned = cliResult.process_spawned === true
        && cliResult.process_close_observed === true
        && cliResult.transport_cleanup_confirmed === true;
      const lifecycleIsClosed = preSpawnKnownTerminal || postCloseTransportCleaned;
      if (terminalClassification !== null && lifecycleIsClosed) {
        await persistClosedTerminalReceipt({
          context,
          dispatchRecord,
          rootDir: evidenceRootForContext(context, executionEnv),
          classification: terminalClassification,
          processSpawned: postCloseTransportCleaned,
          lifecyclePhase: preSpawnKnownTerminal
            ? "pre_spawn_known_terminal"
            : "post_close_transport_cleaned",
          processCloseObserved: postCloseTransportCleaned,
          transportCleanupConfirmed: true,
          invocationClaimSha256: postCloseTransportCleaned ? invocationClaimSha256 : null,
        });
      }
    }

    const result = {
      status,
      classification,
      cli_exit: safeCliExit(cliResult),
      sticky: safeSticky(sticky),
      ...(reviewerCompletion?.guarantee_assessment ? { guarantee_assessment: reviewerCompletion.guarantee_assessment } : {}),
      ...(reviewerCompletion?.diagnostic ? { assessment_diagnostic: reviewerCompletion.diagnostic } : {}),
      ...(completionStreamEvidence === null
        ? {}
        : { completion_stream_evidence: completionStreamEvidence }),
      ...pathsPayload(context),
    };
    refreshHeartbeat(context, status, result);
    return result;
  } catch (error) {
    const result = {
      status: "blocked",
      classification: error.classification ?? "reviewer_cli_runner_error",
      error: error.message,
      ...pathsPayload(context),
    };
    appendActivity(context, result.classification, result);
    refreshHeartbeat(context, "blocked", result);
    return result;
  } finally {
    // D3 gate invariant (design.md D3, tasks.md T19-T22): "隔離 home 整體生命週期綁
    // dispatch，正常路徑於 dispatch 結束時以步驟 4 的同一 ownership teardown 移除" — this
    // finally block is the one place every dispatch exit path (normal completion, thrown
    // ProjectionRunnerError, hard-cap-triggered return, reviewer spawn failure) funnels
    // through, mirroring how neutral cwd cleanup below already covers all of them.
    //
    // RD12 / design.md line 265 (TL ruling, provenance: user): "本 dispatch 自己的隔離
    // home，其 teardown 失敗（bounded 重試耗盡）MUST 一律 fail closed 並上報，且 MUST NOT
    // 存在任何例外分支" — this normal-path removal MUST use the SAME fail-closed-and-report
    // discipline as the in-gate degrade throw in applyReviewerHomeCredentialContinuityGate
    // above, unconditionally, including when the reviewer already produced a valid
    // completion. `reviewer_home_teardown_retry_exhausted` is reported via the activity
    // log token below and the unconditional `return` further down — RD12 does not require
    // a TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS group for it (see the comment on that
    // `return` for why one is deliberately not registered).
    let reviewerHomeTeardownFailedClosed = false;
    if (reviewerHomeCreated) {
      // reviewerHomeTeardownDeps mirrors the existing narrow options-based fs-seam
      // injection points on this function (executableDiscoveryOptions, probeOptions,
      // reviewerHomeGateOptions) — real callers never pass it, so behavior is unchanged;
      // it exists so this specific normal-path teardown call can be fault-injected without
      // a second bespoke test-only hook baked into production control flow.
      const reviewerHomeTeardown = teardownReviewerHome({
        dir: reviewerHomeDir,
        root: reviewerHomeRoot,
        scope: "own",
        deps: options.reviewerHomeTeardownDeps ?? {},
      });
      if (reviewerHomeTeardown.outcome === "fail_closed") {
        reviewerHomeTeardownFailedClosed = true;
        appendActivity(context, "reviewer_home_teardown_retry_exhausted", {});
      } else {
        appendActivity(context, "projection_reviewer_home_cleaned", {});
      }
    }
    if (neutralCwdCreated) {
      try {
        rmSync(context.neutral_cwd_path, { recursive: true, force: true });
        appendActivity(context, "projection_neutral_cwd_cleaned", {
          neutral_cwd_path: context.neutral_cwd_path,
        });
      } catch (error) {
        appendActivity(context, "projection_neutral_cwd_cleanup_failed", {
          neutral_cwd_path: context.neutral_cwd_path,
          error: error.message,
        });
      }
    }
    if (context && dispatchRecordForUsageManifest && (!usageManifestWindowAttempted || usageManifestWriteGaps.length > 0 || usageManifestPendingWindowIndex !== null)) {
      // Failed writes publish coverage/gaps only, never retry their session rows.
      // An unwinding exception may instead finish a still-pending window once.
      persistUsageManifestForWindow(usageManifestPendingWindowIndex, {
        boundedEvidence: usageManifestPendingWindowIndex !== null || !usageManifestWindowAttempted ? boundedEvidenceForUsageManifest : null,
        reviewerModel: reviewerModelForUsageManifest,
      });
    }
    const released = releaseAttemptOwnership(ownership);
    appendActivity(context, released ? "projection_attempt_lock_released" : "projection_attempt_lock_release_skipped", {
      ownership_lock_path: ownership.lockPath,
    });

    if (reviewerHomeTeardownFailedClosed) {
      // RD12 is satisfied by the activity-log entry above
      // (reviewer_home_teardown_retry_exhausted) and this unconditional `return` — a
      // stable token carrying no path/credential fragment, reported non-silently. A
      // closed-terminal *receipt* for this classification is deliberately not attempted:
      // it would require its own TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS group, which is
      // not authorized by the canonical spec's "exactly 7 groups" invariant
      // (openspec/specs/openspec-flow/spec.md) or this change's own
      // cross-runtime-parity/spec.md ("exactly one new terminal classification").
      const result = {
        status: "blocked",
        classification: "reviewer_home_teardown_retry_exhausted",
        ...pathsPayload(context),
      };
      refreshHeartbeat(context, "blocked", result);
      return result;
    }
  }
}

// A dispatch whose reviewer closed before the transport sweep landed keeps its
// invocation claim forever: the runner that owned it is gone, so nothing can
// ever mint its terminal receipt and every successor dispatch is refused as a
// lineage collision. Reconciliation is the operator-invoked way out. It lives
// here rather than in its own script because closedTerminalClassification and
// persistClosedTerminalReceipt are module-private: keeping the only caller
// inside this module means the ability to mint a closed-terminal receipt stays
// exactly as wide as it was, with no importable symbol for anything else to
// reach (design.md D14).
const reconcileClosedTransportFlag = "--reconcile-closed-transport";
const reconcileLegacyDiagnosticFlag = "--reconcile-legacy-diagnostic-scan";
const reconcileCredentialGateFlag = "--reconcile-credential-gate-terminal";
const reconcileLifecyclePhase = "post_close_transport_reconciled";
const canonicalDispatchIdPattern =
  /^dispatch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function reconcileBlocked(classification, dispatchId = null) {
  return { status: "blocked", classification, dispatch_id: dispatchId };
}

function readReconcileActivityLog(activityLogPath) {
  const text = readFileSync(activityLogPath, "utf8");
  // A log that does not end in a newline was cut mid-append, so its last event
  // cannot be trusted to say what it appears to say.
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error("activity log is empty or truncated");
  }
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

function reconcileStickyAuthorityVerified(context, options = {}) {
  const snapshot = liveStickyAuthoritySnapshot(context, options);
  if (snapshot.query_error !== null
    || snapshot.completeness?.status !== "complete"
    || snapshot.completeness?.pagination_exhausted !== true) {
    return false;
  }
  const selection = selectExactSecondReviewStickyAuthority(snapshot.comments);
  if (selection.status !== "selected" || selection.candidate_count !== 1) return false;
  const authority = parseSecondReviewStickyAuthorityBody(selection.authority.body);
  return options.legacyDiagnosticScan === true
    ? authority.status === "valid" && authority.dispatch_id === context.previous_dispatch_id
      && authority.last_reviewed_sha === context.head_ref_oid
    : authority.dispatch_id === context.dispatch_id;
}

// Closure-only GitHub reads: no reviewer launch, credential change or comment write.
function credentialRecoveryLiveAuthorityVerified(context, options = {}) {
  const query = endpoint => {
    const response = (options.spawnSync ?? spawnSync)("gh", ["api", endpoint], {
      cwd: repoRoot, env: { ...process.env, GH_REPO: context.repository_slug },
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30000,
    });
    if (response.status !== 0) throw new Error("live authority unavailable");
    return JSON.parse(response.stdout);
  };
  try {
    const slug = context.repository_slug;
    const repo = query(`repos/${slug}`);
    const pr = query(`repos/${slug}/pulls/${context.pr_number}`);
    if (repo.full_name !== slug || repo.permissions?.push !== true
      || pr.number !== Number(context.pr_number) || pr.state !== "open" || pr.merged !== false
      || pr.base?.repo?.full_name !== slug || pr.head?.repo?.full_name !== slug
      || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? "")) return false;
    if (pr.head.sha !== context.head_ref_oid) {
      const compare = query(`repos/${slug}/compare/${context.head_ref_oid}...${pr.head.sha}`);
      if (compare.status !== "ahead" || compare.behind_by !== 0
        || compare.base_commit?.sha !== context.head_ref_oid
        || compare.merge_base_commit?.sha !== context.head_ref_oid) return false;
    }
    const snapshot = liveStickyAuthoritySnapshot(context, options);
    const selection = selectExactSecondReviewStickyAuthority(snapshot.comments);
    return snapshot.query_error === null && snapshot.completeness?.status === "complete"
      && snapshot.completeness?.pagination_exhausted === true
      && selection.status === "missing" && selection.candidate_count === 0;
  } catch { return false; }
}

async function reconcileClosedTransport(contextPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? process.kill;
  // Only the explicit operator argv selects this recovery. It never authorizes
  // a reviewer invocation or revives the retired diagnostic scan strategy.
  const legacyDiagnosticScan = options.legacyDiagnosticScan === true;
  const credentialGateTerminal = options.credentialGateTerminal === true;
  const strictCarrier = legacyDiagnosticScan || credentialGateTerminal;
  const snapshots = new Map();
  const readLegacyFile = (target, maxBytes = PROJECTION_RUNNER_SELF_CHECK_CONTEXT_MAX_BYTES) => {
    const parent = path.dirname(target);
    const bytes = readNoFollowFile({ root: parent, parent, target, maxBytes }).bytes;
    snapshots.set(target, bytes);
    return bytes;
  };

  // C1 — the invocation names exactly one carrier, and that carrier agrees it
  // is the one named. Everything downstream derives the carrier root from
  // context.observability_context_path, so it has to be this path.
  const resolvedContextPath = path.resolve(String(contextPath ?? ""));
  let context;
  try {
    context = strictCarrier
      ? JSON.parse(readLegacyFile(resolvedContextPath).toString("utf8"))
      : readJson(resolvedContextPath);
  } catch {
    return reconcileBlocked("reconcile_invocation_invalid");
  }
  if (!isPlainObject(context)
    || !canonicalDispatchIdPattern.test(String(context.dispatch_id ?? ""))
    || path.resolve(String(context.observability_context_path ?? "")) !== resolvedContextPath
    || (legacyDiagnosticScan && typeof context.control_evidence_root !== "string")
    || !path.isAbsolute(String(context.control_evidence_root ?? ""))
    || !path.isAbsolute(String(context.activity_log_path ?? ""))
    || !path.isAbsolute(String(context.heartbeat_path ?? ""))
    || !path.isAbsolute(String(context.packet_path ?? ""))) {
    return reconcileBlocked("reconcile_invocation_invalid", context?.dispatch_id ?? null);
  }
  let dispatchId = context.dispatch_id;
  let trustedAuthorization = null;
  let structuralReviewData;
  if (legacyDiagnosticScan
    && (context.mode !== "pr-sticky"
      || context.executor_kind !== undefined
      || context.page_window_full_scan !== true
      || context.page_window_checkpoint_handoff !== true
      || !canonicalDispatchIdPattern.test(String(context.previous_dispatch_id ?? "")))) {
    return reconcileBlocked("reconcile_legacy_diagnostic_shape_invalid", dispatchId);
  }
  try {
    if (strictCarrier) {
      const carrierRoot = path.dirname(resolvedContextPath);
      for (const [field, basename] of Object.entries({
        observability_context_path: "observability-context.json", packet_path: "packet.md",
        activity_log_path: "projection-activity.ndjson", heartbeat_path: "heartbeat.json",
      })) {
        if (context[field] !== path.join(carrierRoot, basename)) throw new Error("carrier substitution");
      }
    }
    if (legacyDiagnosticScan) {
      // Historical runners advanced packet.md in place. Its current bytes are
      // not the initial packet hash in dispatch.json. This closure-only path
      // verifies the final frame against the immutable full-material pin below;
      // neither old duties nor expired material become execution authority.
      const bytes = readLegacyFile(context.packet_path, SECOND_REVIEW_PACKET_MAX_BYTES);
      const marker = Buffer.from(SECOND_REVIEW_FRAME_MARKER);
      const frame = bytes.indexOf(marker);
      const lengthStart = frame + marker.length;
      const headerEnd = bytes.indexOf("\n\n", lengthStart);
      const lengthText = bytes.subarray(lengthStart, headerEnd).toString("ascii");
      if (frame < 0 || bytes.indexOf(marker, lengthStart) >= 0 || headerEnd < lengthStart
        || !/^[1-9][0-9]*$/.test(lengthText)) throw new Error("invalid frame");
      const end = headerEnd + 2 + Number(lengthText);
      if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error("invalid frame length");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(headerEnd + 2, end));
      structuralReviewData = JSON.parse(text);
      if (JSON.stringify(structuralReviewData) !== text
        || structuralReviewData.schema_version !== SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION
        || structuralReviewData.mode !== "pr-sticky"
        || structuralReviewData.dispatch_id !== dispatchId
        || structuralReviewData.previous_dispatch_id !== context.previous_dispatch_id
        || structuralReviewData.head_ref_oid !== context.head_ref_oid) throw new Error("packet binding");
    } else {
      structuralReviewData = parseCanonicalSecondReviewPacketData(credentialGateTerminal
        ? readLegacyFile(context.packet_path, SECOND_REVIEW_PACKET_MAX_BYTES) : readFileSync(context.packet_path), {
        windowMaxPages: resolveDeclaredPageWindowMaxPages(context.page_window_max_pages),
      });
    }
    if (!legacyDiagnosticScan && structuralReviewData.schema_version === SECOND_REVIEW_PAGED_PR_DATA_SCHEMA_VERSION) {
      trustedAuthorization = authorizeSecondReviewPacketFile({ contextPath: resolvedContextPath });
      context = { ...trustedAuthorization.context };
      dispatchId = context.dispatch_id;
      structuralReviewData = trustedAuthorization.data;
    }
  } catch {
    return reconcileBlocked("reconcile_carrier_root_unresolved", dispatchId);
  }
  if (legacyDiagnosticScan) {
    const manifest = structuralReviewData.review_material?.manifest;
    const windowMaxPages = resolveDeclaredPageWindowMaxPages(context.page_window_max_pages);
    if (!Number.isSafeInteger(manifest?.page_count) || manifest.page_count < 2
      || manifest.pages?.length !== manifest.page_count
      || structuralReviewData.review_material.window_role !== "final"
      || validatePrStickyReviewMaterialContract(structuralReviewData, { windowMaxPages }).length !== 0
      || context.page_window_max_pages !== windowMaxPages
      || !Number.isSafeInteger(context.page_window_count) || context.page_window_count < 2
      || context.page_window_count !== pageWindowCount(manifest.page_count, windowMaxPages)) {
      return reconcileBlocked("reconcile_legacy_diagnostic_shape_invalid", dispatchId);
    }
    const priorWindows = structuralReviewData.review_material.findings_ledger.windows;
    const finalIndices = pageWindowIndices(manifest.page_count, context.page_window_count, windowMaxPages);
    if (priorWindows.length !== context.page_window_count - 1
      || priorWindows.some((entry, index) => !isDeepStrictEqual(entry.page_indices,
        pageWindowIndices(manifest.page_count, index + 1, windowMaxPages)))
      || !isDeepStrictEqual(structuralReviewData.review_material.pages.map(page => page.index), finalIndices)
      || !isDeepStrictEqual(structuralReviewData.review_material.checkpoint_ledger.covered_indices,
        Array.from({ length: finalIndices[0] - 1 }, (_, index) => index + 1))) {
      return reconcileBlocked("reconcile_legacy_diagnostic_shape_invalid", dispatchId);
    }
  }

  // C2 — without process groups there is no pgid to probe, so the liveness half
  // of the judgement cannot be made at all.
  if (!supportsReviewerProcessGroups(platform)) {
    return reconcileBlocked("reconcile_platform_unsupported", dispatchId);
  }

  // C3 — only a reserved dispatch carrying nothing terminal is reconcilable.
  // The evidence root comes from the named context alone; honouring an ambient
  // override here would let the caller point the write somewhere else. C15
  // writes to this same resolved root rather than re-deriving it, so the root
  // every precondition below reads is provably the root the receipt lands in.
  const evidenceRoot = strictCarrier ? path.resolve(context.control_evidence_root) : evidenceRootForContext(context);
  let evidence;
  let externalClosurePresent = false;
  try {
    evidence = (strictCarrier ? readDispatchEvidenceStrict : readDispatchEvidence)({
      rootDir: evidenceRoot,
      dispatchId,
    });
    try { lstatSync(evidence.paths.externalClosure); externalClosurePresent = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } catch {
    return reconcileBlocked("reconcile_dispatch_not_reconcilable", dispatchId);
  }
  // External evaluators are never runner-spawned: an external dispatch or any
  // external closure slot belongs to the external disposition path, never to a
  // runner terminal written here (even when a legacy-shape claim exists).
  if (!evidence.dispatch
    || evidence.dispatch.executor_kind === "external-evaluator"
    || evidence.completion
    || (evidence.terminal && !credentialGateTerminal)
    || evidence.capsule
    || evidence.consumption
    || evidence.supersession
    || evidence.externalClosure
    || externalClosurePresent
    || (credentialGateTerminal && (evidence.operatorDisposition || evidence.operatorAbandonment?.present))) {
    return reconcileBlocked("reconcile_dispatch_not_reconcilable", dispatchId);
  }
  if (legacyDiagnosticScan && !evidence.dispatch.paged_full_material_sha256) {
    return reconcileBlocked("reconcile_carrier_root_unresolved", dispatchId);
  }
  if (!evidence.invocationClaim) {
    return reconcileBlocked("reconcile_claim_binding_mismatch", dispatchId);
  }
  const invocationClaimSha256 = canonicalInvocationClaimSha256(evidence.invocationClaim);

  if (credentialGateTerminal) {
    const model = evidence.reviewerModelRecord;
    const selection = context.reviewer_model_selection;
    const family = context.reviewer_cli_recipe?.tool;
    const kind = requestedKindForSelection(selection, family);
    if (context.mode !== "pr-sticky" || !model || !selection
      || model.reviewer_cli_family !== family || model.requested_model !== selection.requested
      || model.requested_source !== selection.source
      || model.requested_source_env_var !== (selection.env_var ?? "none")
      || model.requested_kind !== kind || model.observed_model === "none"
      || model.observed_source === "none" || model.observed_unavailable_reason !== "none"
      || model.agreement !== deriveReviewerModelAgreement({ requestedModel: selection.requested,
        requestedKind: kind, observedModel: model.observed_model })
      || !["exact", "alias-expansion-expected"].includes(model.agreement)) {
      return reconcileBlocked("reconcile_model_binding_mismatch", dispatchId);
    }
    try {
      for (const target of Object.values(evidence.paths)) {
        try { readLegacyFile(target); }
        catch (error) { if (error.code !== "ENOENT") throw error; snapshots.set(target, null); }
      }
    } catch { return reconcileBlocked("reconcile_dispatch_not_reconcilable", dispatchId); }
  }

  // C5 — rederive identity and the carrier-directory digest. Ordinary transport
  // reconciliation also requires the exact initial packet hash. Legacy paged
  // runners advanced packet.md in place, so only that branch instead verifies
  // the immutable full-material pin plus the complete final-window bindings.
  let rederived;
  try {
    rederived = trustedAuthorization === null
      ? secondReviewDispatchRecord({
          context,
          packetBytes: legacyDiagnosticScan ? snapshots.get(context.packet_path) : readFileSync(context.packet_path),
        })
      : secondReviewDispatchBaseRecord(trustedAuthorization.dispatch_record);
  } catch {
    return reconcileBlocked("reconcile_carrier_root_unresolved", dispatchId);
  }
  const reservedBase = secondReviewDispatchBaseRecord(evidence.dispatch);
  const rederivedKeys = Object.keys(rederived).sort();
  if (rederivedKeys.some((key) => !(legacyDiagnosticScan && key === "packet_sha256")
    && reservedBase[key] !== rederived[key])) {
    return reconcileBlocked("reconcile_carrier_root_unresolved", dispatchId);
  }
  if (legacyDiagnosticScan) {
    try {
      const bytes = readLegacyFile(path.join(path.dirname(resolvedContextPath), PAGED_FULL_PAGES_CARRIER_BASENAME),
        SECOND_REVIEW_PRIVATE_CARRIER_MAX_BYTES);
      const carrier = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const manifest = structuralReviewData.review_material.manifest;
      if (sha256Hex(bytes) !== evidence.dispatch.paged_full_material_sha256
        || `${JSON.stringify(carrier)}\n` !== bytes.toString("utf8")
        || carrier.schema !== PAGED_FULL_PAGES_CARRIER_SCHEMA
        || carrier.dispatch_id !== dispatchId || carrier.head_ref_oid !== context.head_ref_oid
        || carrier.carrier_root_id !== reservedBase.carrier_root_id
        || carrier.created_at !== evidence.dispatch.paged_full_material_created_at
        || carrier.expires_at !== evidence.dispatch.paged_full_material_expires_at
        || carrier.manifest_sha256 !== sha256Hex(JSON.stringify(manifest))
        || carrier.manifest_sha256 !== structuralReviewData.review_material_proof.manifest_sha256
        || !Array.isArray(carrier.pages) || carrier.pages.length !== manifest.page_count
        || carrier.pages.some((page, index) => page.index !== index + 1
          || typeof page.content !== "string" || page.utf8_bytes !== Buffer.byteLength(page.content, "utf8")
          || page.sha256 !== sha256Hex(page.content)
          || page.sha256 !== manifest.pages[index].sha256
          || page.utf8_bytes !== manifest.pages[index].utf8_bytes)) throw new Error("immutable material binding");
      // Preserve the original reserved hash; the mutable final packet is never
      // promoted into a new dispatch reservation or an execution authorization.
      rederived = reservedBase;
    } catch {
      return reconcileBlocked("reconcile_carrier_root_unresolved", dispatchId);
    }
  }

  // C6 — the activity log is the only record of what the dead runner observed.
  let activity;
  try {
    if (strictCarrier) {
      const text = readLegacyFile(context.activity_log_path, SECOND_REVIEW_PACKET_MAX_BYTES).toString("utf8");
      if (!text.endsWith("\n") || text.length === 0) throw new Error("truncated activity");
      activity = text.slice(0, -1).split("\n").map(line => JSON.parse(line));
    } else {
      activity = readReconcileActivityLog(context.activity_log_path);
    }
  } catch {
    return reconcileBlocked("reconcile_activity_log_unreadable", dispatchId);
  }

  // C4 — the claim digest the carrier recorded must match the claim file that
  // is actually on disk. The file half is checkable above; this cross-check has
  // to wait for the parsed log, but both halves report the same classification.
  const claimed = activity.filter((event) => event?.event === "projection_dispatch_invocation_claimed");
  if (claimed.length !== 1
    || claimed[0].dispatch_id !== dispatchId
    || claimed[0].invocation_claim_sha256 !== invocationClaimSha256) {
    return reconcileBlocked("reconcile_claim_binding_mismatch", dispatchId);
  }

  // C7/C8 — exactly one spawn and one close, or we cannot say which process the
  // pgid probe below would even be about.
  const started = activity.filter((event) => event?.event === "projection_cli_started");
  const exited = activity.filter((event) => event?.event === "projection_cli_exited");
  if (legacyDiagnosticScan) {
    const lifecycle = activity.filter(event => ["projection_cli_started", "projection_cli_exited"].includes(event?.event));
    if (started.length !== context.page_window_count || exited.length !== context.page_window_count
      || started.some(event => !Number.isInteger(event.pid) || event.pid <= 0)
      || new Set(started.map(event => event.pid)).size !== started.length
      || lifecycle.some((event, index) => event.event !== (index % 2 === 0 ? "projection_cli_started" : "projection_cli_exited"))
      || exited.some(event => event.code !== 0 || event.process_spawned !== true
        || event.process_close_observed !== true || event.transport_cleanup_confirmed !== true)) {
      return reconcileBlocked("reconcile_legacy_window_lifecycle_invalid", dispatchId);
    }
    const gates = activity.filter(event => event?.event === "projection_page_window_live_gate");
    const advances = activity.filter(event => event?.event === "projection_page_window_advanced");
    if (gates.length !== started.length || advances.length !== started.length - 1
      || gates.some((event, index) => event.findings_windows !== index + 1
        || event.page_window_count !== started.length
        || activity.indexOf(event) < activity.indexOf(started[index])
        || activity.indexOf(event) > activity.indexOf(exited[index]))
      || gates.at(-1).scan_complete !== true || gates.at(-1).phase !== "final"
      || gates.at(-1).classification !== "page_window_full_scan_final_no_sticky"
      || advances.some((event, index) => event.page_window_index !== index + 2
        || event.page_window_count !== started.length || event.findings_windows !== index + 1
        || activity.indexOf(event) < activity.indexOf(gates[index])
        || activity.indexOf(event) > activity.indexOf(exited[index]))) {
      return reconcileBlocked("reconcile_legacy_window_lifecycle_invalid", dispatchId);
    }
  } else if (started.length !== 1 || !Number.isInteger(started[0].pid) || started[0].pid <= 0) {
    return reconcileBlocked("reconcile_cli_started_not_exactly_one", dispatchId);
  }
  if (!legacyDiagnosticScan && exited.length !== 1) {
    return reconcileBlocked("reconcile_cli_exited_not_exactly_one", dispatchId);
  }

  // C9 — reconciliation is for the one lifecycle the sweep cannot reach any
  // more: spawned, closed, transport never confirmed clean.
  if (!legacyDiagnosticScan && (exited[0].process_spawned !== true
    || exited[0].process_close_observed !== true
    || exited[0].transport_cleanup_confirmed !== credentialGateTerminal
    || (credentialGateTerminal && (exited[0].code !== 0 || exited[0].timed_out === true || exited[0].spawn_error != null)))) {
    return reconcileBlocked("reconcile_lifecycle_not_eligible", dispatchId);
  }

  if (credentialGateTerminal && (activity.indexOf(claimed[0]) >= activity.indexOf(started[0])
    || activity.indexOf(started[0]) >= activity.indexOf(exited[0]))) {
    return reconcileBlocked("reconcile_lifecycle_not_eligible", dispatchId);
  }

  // C10 — every attributed event must belong to the reserved attempt.
  if (activity.some((event) => Object.hasOwn(event ?? {}, "attempt_id")
    && event.attempt_id !== context.attempt_id)
    || (legacyDiagnosticScan && [...started, ...exited].some(event => event.attempt_id !== context.attempt_id))) {
    return reconcileBlocked("reconcile_attempt_identity_mismatch", dispatchId);
  }

  // C11 — a held lock means a runner still owns this attempt. Probe it; never
  // acquire it, because acquiring would itself be a write.
  const lockPath = attemptLockPath(resolvedContextPath);
  if (existsSync(lockPath) && lockOwnerState(lockPath).state !== "dead") {
    return reconcileBlocked("reconcile_dispatch_in_flight", dispatchId);
  }

  // C12 — the runner never emits a terminal activity event, so heartbeat.json
  // is the only durable record of the final status, classification, cli exit
  // and sticky state. Recompute the terminal classification from it rather than
  // trusting any single recorded field.
  let heartbeat;
  try {
    heartbeat = strictCarrier
      ? JSON.parse(readLegacyFile(context.heartbeat_path).toString("utf8"))
      : readJson(context.heartbeat_path);
  } catch {
    return reconcileBlocked("reconcile_classification_underivable", dispatchId);
  }
  if (credentialGateTerminal && (heartbeat?.status !== "blocked"
    || ![STICKY_CREDENTIAL_LITERAL_BLOCKED, STICKY_CREDENTIAL_LITERAL_DETECTED].includes(heartbeat.classification)
    || heartbeat.attempt_id !== context.attempt_id
    || (heartbeat.dispatch_id != null && heartbeat.dispatch_id !== dispatchId)
    || heartbeat.sticky?.classification !== heartbeat.classification || heartbeat.sticky.status !== "failed"
    || String(heartbeat.sticky.pr_number) !== context.pr_number
    || heartbeat.sticky.expected_head_ref_oid !== context.head_ref_oid
    || heartbeat.sticky.sticky_comment_id !== null || heartbeat.sticky.sticky_comment_url !== null
    || heartbeat.sticky.verdict !== null || heartbeat.sticky.last_reviewed_sha !== null
    || (heartbeat.sticky.dispatch_id !== null && heartbeat.sticky.dispatch_id !== dispatchId)
    || heartbeat.cli_exit?.code !== 0 || heartbeat.cli_exit.process_spawned !== true
    || heartbeat.cli_exit.process_close_observed !== true || heartbeat.cli_exit.transport_cleanup_confirmed !== true
    || heartbeat.cli_exit.timed_out === true || heartbeat.cli_exit.spawn_error != null)) {
    return reconcileBlocked("reconcile_classification_underivable", dispatchId);
  }
  const terminalClassification = legacyDiagnosticScan
    ? heartbeat?.status === "blocked" && heartbeat.classification === "page_window_full_scan_final_no_sticky"
      && heartbeat.attempt_id === context.attempt_id
      && heartbeat.sticky?.status === "failed" && heartbeat.sticky.sticky_comment_id === null
      && heartbeat.sticky.classification === "page_window_full_scan_final_no_sticky"
      && heartbeat.sticky.dispatch_id === dispatchId
      && heartbeat.sticky.pr_number === context.pr_number
      && heartbeat.sticky.last_reviewed_sha === context.head_ref_oid
      ? "legacy_diagnostic_scan_closed" : null
    : heartbeat?.status === "blocked"
      ? closedTerminalClassification(heartbeat.classification, heartbeat.cli_exit, heartbeat.sticky)
      : null;
  if (terminalClassification === null || (credentialGateTerminal && terminalClassification !== "sticky_contract_invalid")) {
    return reconcileBlocked("reconcile_classification_underivable", dispatchId);
  }

  // C13 — pid is the pgid for a detached spawn, so ESRCH on the group is the
  // same evidence the inline path already accepts as "cleanup is complete".
  for (const event of started) {
    if (credentialGateTerminal) {
      try { killProcess(event.pid, 0); return reconcileBlocked("reconcile_process_group_alive", dispatchId); }
      catch (error) { if (error.code !== "ESRCH") return reconcileBlocked("reconcile_process_group_probe_failed", dispatchId); }
    }
    const groupState = probeReviewerProcessGroup(event.pid, killProcess);
    if (groupState === "alive") {
      return reconcileBlocked("reconcile_process_group_alive", dispatchId);
    }
    if (groupState !== "gone") {
      return reconcileBlocked("reconcile_process_group_probe_failed", dispatchId);
    }
  }

  // C14 — ESRCH alone proves nothing on a different host than the one that
  // spawned the reviewer, because the recorded pid carries no host or boot
  // binding. Requiring the sticky authority to still be exactly this dispatch's
  // does not prove the process died; it proves the harm we actually fear —
  // a second write, an identity drift — has not happened yet.
  if (!(credentialGateTerminal ? credentialRecoveryLiveAuthorityVerified(context, options)
    : reconcileStickyAuthorityVerified(context, options))) {
    return reconcileBlocked("reconcile_sticky_authority_unverified", dispatchId);
  }
  if (strictCarrier) {
    const markerNames = postPrMarkerFilenames({ repo: context.repository_slug, prNumber: context.pr_number });
    // The default beside the named evidence root remains protected even when
    // the operator currently has a producer-supported marker-dir override.
    const markerDirs = [path.join(path.dirname(evidenceRoot), "devpro-post-pr-completion"), path.resolve(postPrCompletionDir(repoRoot))];
    const markerPaths = new Set(markerDirs.flatMap((dir) => markerNames.map((name) => path.join(dir, name))));
    try {
      let matchedMarkers = 0;
      const expectedRepo = repoName(context.repository_slug);
      for (const markerPath of markerPaths) {
        let marker;
        try { marker = parsePostPrMarkerRecord(markerPath, readLegacyFile(markerPath)); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          snapshots.set(markerPath, null);
        }
        if (marker) {
          const recorded = postPrMarkerRepoName(marker);
          if (path.basename(markerPath) === markerNames[1] && !recorded.conflict
            && ((recorded.name && recorded.name !== expectedRepo) || !marker.prNumber)) {
            snapshots.delete(markerPath);
            continue;
          }
          matchedMarkers++;
          if (!isPlainObject(marker) || recorded.conflict || String(marker.prNumber) !== context.pr_number
            || (path.basename(markerPath) === markerNames[0] && recorded.name !== expectedRepo)
            || matchedMarkers > 1) throw new Error("marker identity");
        }
        if (!credentialGateTerminal && snapshots.get(markerPath) !== null && (!isPlainObject(marker)
          || String(marker.prNumber) !== context.pr_number
          || marker.repository_slug !== context.repository_slug
          || marker.head_ref_oid !== context.head_ref_oid
          || marker.expected_dispatch_id !== dispatchId)) throw new Error("marker binding");
      }
    } catch {
      return reconcileBlocked("reconcile_pending_marker_mismatch", dispatchId);
    }
    try {
      for (const [target, expected] of snapshots) {
        if (expected === null) {
          try { lstatSync(target); throw new Error("marker appeared"); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        } else {
          const parent = path.dirname(target);
          const current = readNoFollowFile({ root: parent, parent, target,
            maxBytes: Math.max(SECOND_REVIEW_PACKET_MAX_BYTES, expected.length) }).bytes;
          if (!current.equals(expected)) throw new Error("carrier changed");
        }
      }
      if (existsSync(lockPath) && lockOwnerState(lockPath).state !== "dead") throw new Error("runner acquired lock");
    } catch {
      return reconcileBlocked("reconcile_evidence_changed", dispatchId);
    }
  }

  if (credentialGateTerminal) {
    // Re-read the complete typed snapshot after all external reads; a changed
    // claim/model or competing lifecycle authority must not be sealed over.
    try {
      if (!isDeepStrictEqual(evidence, readDispatchEvidenceStrict({ rootDir: evidenceRoot, dispatchId }))) {
        throw new Error("evidence changed");
      }
    } catch { return reconcileBlocked("reconcile_evidence_changed", dispatchId); }
    if (evidence.terminal) {
      if (evidence.terminal.classification !== "sticky_contract_invalid"
        || evidence.terminal.lifecycle_phase !== reconcileLifecyclePhase
        || evidence.terminal.process_spawned !== true || evidence.terminal.process_close_observed !== true
        || evidence.terminal.transport_cleanup_confirmed !== true
        || evidence.terminal.invocation_claim_sha256 !== invocationClaimSha256) {
        return reconcileBlocked("reconcile_dispatch_not_reconcilable", dispatchId);
      }
      return { status: "finished", classification: "sticky_contract_invalid", dispatch_id: dispatchId,
        lifecycle_phase: reconcileLifecyclePhase };
    }
  }

  // C15 — the receipt write is an exclusive create, so a concurrent reconciler
  // loses here rather than minting a second receipt.
  try {
    await persistClosedTerminalReceipt({
      context,
      dispatchRecord: rederived,
      classification: terminalClassification,
      processSpawned: true,
      lifecyclePhase: reconcileLifecyclePhase,
      processCloseObserved: true,
      transportCleanupConfirmed: true,
      invocationClaimSha256,
      rootDir: evidenceRoot,
    });
  } catch {
    return reconcileBlocked("reconcile_receipt_collision", dispatchId);
  }
  return {
    status: "finished",
    classification: terminalClassification,
    dispatch_id: dispatchId,
    lifecycle_phase: reconcileLifecyclePhase,
  };
}

function parseRunnerArgv(argv) {
  if (argv.length === 1 && !argv[0].startsWith("--")) {
    return { mode: "project", contextPath: argv[0] };
  }
  if (argv.length === 2 && argv[0] === reconcileClosedTransportFlag && !argv[1].startsWith("--")) {
    return { mode: "reconcile", contextPath: argv[1] };
  }
  if (argv.length === 2 && argv[0] === reconcileLegacyDiagnosticFlag && !argv[1].startsWith("--")) {
    return { mode: "reconcile-legacy-diagnostic", contextPath: argv[1] };
  }
  if (argv.length === 2 && argv[0] === reconcileCredentialGateFlag && !argv[1].startsWith("--")) {
    return { mode: "reconcile-credential-gate", contextPath: argv[1] };
  }
  return null;
}

async function main() {
  const envSanitization = sanitizeCmuxDispatchEnv(process.env);
  if (process.env[terminalReviewerMarker] === "1") {
    process.stdout.write(`${JSON.stringify({
      status: "blocked",
      classification: "projection_recursive_reentry",
    }, null, 2)}\n`);
    process.exit(1);
  }
  const invocation = parseRunnerArgv(process.argv.slice(2));
  if (invocation === null) {
    console.error(
      "Usage: run-second-reviewer-projection.mjs "
      + `[${reconcileClosedTransportFlag}|${reconcileLegacyDiagnosticFlag}|${reconcileCredentialGateFlag}] <observability-context.json>`
    );
    process.exit(2);
  }
  const contextPath = invocation.contextPath;

  if (["reconcile", "reconcile-legacy-diagnostic", "reconcile-credential-gate"].includes(invocation.mode)) {
    let result;
    try {
      result = await reconcileClosedTransport(contextPath, {
        legacyDiagnosticScan: invocation.mode === "reconcile-legacy-diagnostic",
        credentialGateTerminal: invocation.mode === "reconcile-credential-gate",
      });
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    process.exitCode = result.status === "finished" ? 0 : 1;
    await new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (error) => {
        if (error) reject(error); else resolve();
      });
    });
    process.exit(process.exitCode);
  }

  try {
    const result = await runProjection(contextPath, { envSanitization });
    // This block MUST uphold two separate guarantees, in this order:
    //
    // 1. Flush before exit: set process.exitCode and await the stdout write
    //    callback instead of calling process.exit() synchronously. When
    //    stdout is a non-TTY pipe (as with a parent process capturing
    //    output) and the payload exceeds the pipe's kernel buffer (e.g. a
    //    sticky reason with a truncation notice appended), an immediate
    //    process.exit() can terminate the process before the write's data is
    //    fully flushed, silently truncating this JSON result. Awaiting the
    //    write callback means the callback firing IS the guarantee that the
    //    bytes were handed to the fd.
    // 2. Bounded exit after flush: once the write has been awaited, call
    //    process.exit(process.exitCode) explicitly rather than letting the
    //    process exit naturally. The runner's child transport (stdout/stderr
    //    pipes on `child`) stays ref'd open even after forceSettle resolves
    //    this promise with process_close_observed: false (a stubborn
    //    descendant can hold those pipes open forever), so relying on
    //    natural event-loop drain can hang the whole process indefinitely
    //    even though the correct result has already been computed and
    //    flushed. process.exit() forces a bounded exit regardless of what
    //    still holds the event loop open.
    //
    // Both guarantees must hold together: flushing without exiting can hang
    // forever; exiting without flushing can truncate the result. The order
    // (flush, then exit) is load-bearing.
    const compact = String(result.classification ?? "").startsWith("reviewer_orchestration_");
    process.exitCode = result.status === "finished" ? 0 : 1;
    await new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result, null, compact ? undefined : 2)}\n`, (error) => {
        if (error) reject(error); else resolve();
      });
    });
    process.exit(process.exitCode);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
