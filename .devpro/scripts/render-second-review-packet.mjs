#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { reviewGithubSpawnSync as spawnSync, reviewGithubTransportMode } from "./lib/second-review-github-transport.mjs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isDirectChildOfHostSystemTmpdir,
  resolveHostSystemTmpdir,
} from "./lib/host-system-tmpdir.mjs";
import {
  canonicalProjectionRunnerCarriers,
  classifyProjectionRunnerCarrier,
  isClaudeCodeRendererHost,
  PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL,
} from "./lib/projection-runner-carrier.mjs";
import {
  SECOND_REVIEW_DATA_SCHEMA_VERSION,
  SECOND_REVIEW_PR_DATA_SCHEMA_VERSION,
  SECOND_REVIEW_FRAME_MARKER,
  SECOND_REVIEW_MATERIAL_MAX_BYTES,
  SECOND_REVIEW_PACKET_MAX_BYTES,
  SECOND_REVIEW_PACKET_STATIC_SUFFIX,
  externalEvaluatorPacketStaticPrefix,
  externalEvaluatorTicketSuffix,
  formatSecondReviewPacketValidationError,
  pageWindowIntermediateStickyDisposition,
  reviewScopeDriftAdvisoryFromData,
  secondReviewPacketStaticPrefix,
  secondReviewPacketStaticSuffix,
  secondReviewRulesVersion,
  validateSecondReviewPacketText,
  externalAuditPacketStaticPrefix,
  externalAuditTicketSuffix,
  resolveCredentialGateSidecarPath,
  STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME,
  CREDENTIAL_LITERAL_RULE,
  EXTERNAL_CREDENTIAL_LITERAL_RULE,
  classificationIndicatesSameFamilyFallback,
  sameFamilyFallbackDisclosure,
  sameFamilyFallbackWhy,
  PR_STICKY_APPROVAL_CONTEXT,
  APPROVED_RESOLUTION_RETIRED_MESSAGE,
  ADOPTION_NOTICE_CONTEXT_RETIRED_MESSAGE,
} from "./validate-second-review-packet.mjs";
import {
  STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
  stickyWriteResultBasename,
} from "./write-second-review-sticky-gated.mjs";
import { isBlank, isPlainObject, isRepositorySlug } from "./lib/primitives.mjs";
import { findPIIHits } from "./lib/pii-pattern-contract.mjs";
import { findSecretHits } from "./lib/secret-pattern-contract.mjs";
import { sanitizeCmuxDispatchEnv } from "./lib/second-review-env-sanitizer.mjs";
import { fsyncDirectory } from "./lib/durable-fs.mjs";
import {
  normalizePrStickyReviewMaterialData,
  pageWindowCount,
  resolveDeclaredPageWindowMaxPages,
  SECOND_REVIEW_EMBEDDED_MAX_BYTES,
  SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING,
  SECOND_REVIEW_PRIVATE_CARRIER_MAX_BYTES,
  PAGED_FULL_PAGES_CARRIER_BASENAME,
  PAGED_FULL_PAGES_CARRIER_SCHEMA,
  SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
  SECOND_REVIEW_GH_PROBE_TIMEOUT_MS,
  SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
  SECOND_REVIEW_GIT_RENAME_COPY_FLAGS,
  canonicalEmbeddedReviewMaterialProof,
  changedPathsFromGitDiff,
  changedPathsSha256,
  classifyFullPrPatchCompleteness,
  deriveAuthoritativeChangedSet,
  materialSha256,
  reviewScopeFingerprintSha256,
  resolveCanonicalReviewerFamily,
  resolveReviewerCli,
  REVIEWER_FAMILY_GROUPS,
  validatePrStickyReviewMaterialContract,
} from "./second-review-material-contract.mjs";
import { buildOpenCodeReviewerSection, readOpenCodeCliVersion } from "./lib/opencode-launch.mjs";
import {
  REVIEW_SCOPE_PROBE_RESULT_FILE,
  REVIEWER_MODEL_OVERRIDE_VALUE_RE,
  SECOND_REVIEWER_MODEL_OVERRIDE_ENV,
  assertCanonicalReviewerCliRecipe,
  canonicalReviewScopeReadRecipe,
  canonicalReviewerCliRecipe,
  deriveMainCheckoutNotesTmp,
  isPathInside,
  resolveSecondReviewerModel,
  reviewerWritableRootsFromRecipe,
} from "./second-reviewer-cli-recipe-contract.mjs";
import {
  assertClaudeEffortSelectionReady,
  selectClaudeSecondReviewerEffort,
} from "./select-claude-second-reviewer-effort.mjs";
import {
  SECOND_REVIEW_STICKY_MARKER,
  SECOND_REVIEW_STICKY_WRITE_DISPOSITION_SCHEMA,
  STICKY_PROVENANCE_TOOL_TOKENS,
  parseSecondReviewStickyAuthorityBody,
  resolveReadyStickyBaseline as resolveReadyStickyBaselineFromSnapshot,
  resolveSecondReviewStickyWriteDisposition,
} from "./hooks/lib/second-review-sticky-authority.mjs";
import {
  LINEAGE_APPROVAL_RECEIPT_SCHEMA,
  resolveSecondReviewLineageApproval,
} from "./hooks/lib/second-review-lineage-approval.mjs";
import { selectExactSecondReviewStickyAuthority } from "./hooks/lib/second-review-sticky-authority.mjs";
import {
  evaluateReviewRoundBudget,
  recordReviewRoundDispatch as recordReviewRoundDispatchImpl,
} from "./hooks/lib/review-round-budget.mjs";
import { evaluateCostBudget } from "./lib/cost-budget.mjs";
import {
  CHANGE_NAME_GRAMMAR,
  changeNameFolderExists,
  resolveChangeCostUsage,
} from "./lib/resolve-change-cost-usage.mjs";
import { captureTlHostSession } from "./lib/session-usage-manifest.mjs";
import { EXTERNAL_AUDIT_REPORT_BASENAME, externalAuditReviewDataSha256 } from "./lib/external-audit-review.mjs";
// D6/D7 (fix-second-review-loop-friction, T6): round-override disclosure
// write. deriveChangeNameFromBranch is the SAME read-side change-name
// derivation post-pr-cost-circuit-breaker.mjs's evaluateOverrideDisclosure
// uses (D7 point 2 requires byte-identical predicates on both sides) — both
// modules import this single dependency-free source.
import { deriveChangeNameFromBranch } from "./lib/derive-change-name-from-branch.mjs";
import {
  appendChangeUsageOverride,
  changeUsageCheckpointPath,
} from "./hooks/lib/change-usage-checkpoint.mjs";

const allowedModes = new Set(["pr-sticky", "audit-only"]);
const allowedAttempts = new Set(["initial", "focused-sticky-refresh", "fault-recovery"]);
const allowedCarriers = new Set(["embedded-diff", "adapter-live-pr-reads", "external-live-reads"]);
const observabilityContextFileName = "observability-context.json";
const observabilityHeartbeatFileName = "heartbeat.json";
const observabilityActivityFileName = "projection-activity.ndjson";
const observabilityStdoutFileName = "reviewer-stdout.ndjson";
const observabilityStderrFileName = "reviewer-stderr.log";
const observabilityCliProbeFileName = "cli-probe-result.json";
const observabilityOpenCodeLaunchFileName = "opencode-launch.json";
const canonicalPacketFileName = "packet.md";
const publicationTransactionSchema = "devpro-second-review-publication-transaction/v3";
const publicationTransactionEnvelopeSchema = "devpro-second-review-publication-owner/v1";
const publicationTransactionRemediationSchema =
  "devpro-second-review-publication-transaction-remediation/v1";
const publicationTransactionPrefix = ".renderer-publication-transaction.";
const publicationTransactionRemediationDir = ".renderer-publication-transaction-remediation";
const publicationTransactionStaleAfterMs = 30_000;
const publicationTransactionMaxBytes = 64 * 1024;
const publicationTransactionMaxFiles = 256;
const fullPrPatchFactsMaxBytes = 4 * 1024 * 1024;
const fullPrPatchGithubRowsMaxBytes = 16 * 1024 * 1024;
const fullPrPatchGithubMaxPages = 30;
const fullPrPatchGithubRowsPerPage = 100;
// A lawful 2 MiB UTF-8 diff can expand to six JSON bytes per source byte when every
// byte is represented by an escape. Page metadata and the exact carrier envelope have
// their own bounded allowance rather than borrowing the substantially smaller packet cap.
const pagedFullMaterialCarrierMaxBytes = SECOND_REVIEW_PRIVATE_CARRIER_MAX_BYTES;
const publicationCarrierRoles = Object.freeze([
  "packet",
  "observability-context",
  "heartbeat",
  "activity",
  "stdout",
  "stderr",
  "cli-probe-result",
  "paged-full-material",
]);
const projectionBootstrapScript = ".devpro/scripts/ack-second-reviewer-projection.mjs";
const projectionRunnerScript = PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL;
const rendererScriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rendererScriptDir, "../..");
const projectionBootstrapScriptPath = path.join(repoRoot, projectionBootstrapScript);
const projectionRunnerScriptPath = path.join(repoRoot, projectionRunnerScript);
const controlEvidenceHelperPath = path.join(
  repoRoot,
  ".devpro/scripts/hooks/lib/second-review-control-evidence.mjs"
);
const postPrCompletionStatePath = path.join(
  repoRoot,
  ".devpro/scripts/hooks/lib/post-pr-completion-state.mjs"
);
const controlEvidenceHelper = await import(pathToFileURL(controlEvidenceHelperPath).href);
// D1/D4 (R1, R4): the sole external-evaluator executor_kind token. Read off the
// already-committed control-evidence helper (T2) rather than re-declaring the
// literal here, so the renderer and the dispatch-record writer/reader can never
// drift apart on this string.
const EXTERNAL_EVALUATOR_EXECUTOR_KIND = controlEvidenceHelper.EXTERNAL_EVALUATOR_EXECUTOR_KIND;
// D1: external tickets never spawn a reviewer CLI, so they have no per-mode
// runner activity contract — they have exactly these two events instead.
const EXTERNAL_TICKET_REQUIRED_ACTIVITY_EVENTS = Object.freeze([
  "packet_rendered",
  "external_evaluator_ticket_issued",
]);
const requiredReviewerSurface = "host-non-sandbox-required";
const requiredRunnerOwner = "adapter-host-runner";
const requiredSandboxPolicy = "auth-required-reviewer-cli-must-not-run-in-sandbox";
const tlPreDispatchContract = "tl-must-render-before-runtime-native-projection-spawn";
// The reviewer CLI recipe no longer grants a reviewer any writable root inside the main
// checkout (issue #1735); this is now used only to place renderer-owned carriers under a
// canonical, stable root that stays outside whatever writable root the recipe does grant.
const mainCheckoutNotesTmp = deriveMainCheckoutNotesTmp(repoRoot);
const mainCheckoutRoot = path.dirname(path.dirname(mainCheckoutNotesTmp));
const canonicalCarrierRoot = path.join(path.dirname(mainCheckoutNotesTmp), "cross-review");
const reviewerWritableRootCarrierCollision = "reviewer_writable_root_carrier_collision";
const reviewerWritableRootEnumerationOverflowRisk = "reviewer_writable_root_enumeration_overflow_risk";
const reviewerWritableRootInsideRepo = "reviewer_writable_root_inside_repo";
const canonicalCarrierRootMismatch = "canonical_carrier_root_mismatch";
const canonicalCarrierRootContainment = "canonical_carrier_root_containment";
const secondReviewInitialCarrierCollision = "second_review_initial_carrier_collision";
// Half the runner's 64 KiB complete-line bound. issue #1735 case 1 overflowed at 69697
// bytes — only 6% past the real bound — so a threshold that hugs 65536 would leave no
// room for the JSON escaping and event envelope the listing still has to pass through.
export const maxReviewerWritableRootListingBytes = 32 * 1024;
// `ls -la` sizes its fixed columns (mode, nlink, owner, group, size, date) from the
// widest entry in that directory, so the width is not a cross-directory constant. These
// deliberately over-count rather than average: overshooting keeps the gate fail-closed,
// while a measured average would under-estimate on a directory with wider columns.
// They are not a *provable* bound — long LDAP owner/group names, a >=10^10-byte file
// widening the size column, and GNU coreutils quoting (a name with a space gains two
// quote bytes, a control character expands to a `\NNN` escape) all print wider than
// `Buffer.byteLength(name)` can see. What makes a false pass implausible is the margin
// above, not these widths: because the threshold is half the runner's bound, a false
// pass needs the fixed columns to exceed 129 + the mean name length, and measured here
// they are 53. `render-second-review-packet.test.mjs` reads the runner's own declaration
// and fails if that halving ever stops holding, so the margin cannot erode unnoticed.
const lsFixedColumnOvercountBytes = 64;
const lsListingHeaderOvercountBytes = 32;
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
  {
    event: "projection_cli_liveness_sampled",
    required_when: "child-remains-open-at-60s-sample-boundary",
  },
  {
    event: "projection_cli_status_checkpoint",
    required_when: "child-remains-open-at-15m-status-checkpoint",
  },
];
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

function requiredActivityEventsForMode(mode) {
  return requiredActivityEventsByMode[mode] ?? [];
}

function isExactOrderedArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value);
}
const rendererOwnedObservabilityPathFields = [
  "attempt_id",
  "base_dir",
  "packet_path",
  "context_path",
  "observability_context_path",
  "heartbeat_path",
  "activity_log_path",
  "stdout_log_path",
  "stderr_log_path",
  "cli_probe_result_path",
  "review_scope_probe_result_path",
  "projection_bootstrap_script",
  "projection_bootstrap_command",
  "projection_runner_script",
  "projection_runner_command",
  "reviewer_cli_recipe",
  "reviewer_opencode",
  "review_scope_read_recipe",
  "required_activity_events",
  "duration_conditional_activity_events",
  "neutral_cwd_path",
  "control_evidence_root",
  "dispatch_id",
  "previous_dispatch_id",
];

const requiredFields = [
  "mode",
  "attempt",
  "primary_family",
  "reviewer_family",
  "target",
  "repository_slug",
  "approval_context",
  "scope_summary",
  "changed_files_or_touch_list",
  "review_material_carrier",
  "primary_validation_evidence",
  "primary_test_evidence",
];

function scalar(value, fallback = "none") {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : fallback;
  if (isBlank(value)) return fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function defaultReviewerTool(input) {
  return resolveCanonicalReviewerFamily(input?.reviewer_family).tool;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectReviewerCliRecipe(input, neutralCwd, options = {}) {
  const recipeOptions = {
    page_window_checkpoint_handoff: options.page_window_checkpoint_handoff === true,
  };
  if (options.selected_effort === "xhigh" || options.selected_effort === "max") {
    recipeOptions.selected_effort = options.selected_effort;
  }
  // D2: hand the SAME validated selection object down to the contract layer
  // via options.reviewer_model_selection — the channel canonicalReviewerCliRecipe()'s
  // resolveRequestedReviewerModel() checks first.
  if (options.reviewer_model_selection) {
    recipeOptions.reviewer_model_selection = options.reviewer_model_selection;
  }
  return cloneJson(canonicalReviewerCliRecipe({
    reviewer_family: input?.reviewer_family,
    mode: input?.mode,
    linked_issue_context: input?.linked_issue_context ?? "none",
    repository_slug: input?.repository_slug,
    neutral_cwd_path: neutralCwd,
    ...(options.github_transport ? {github_transport:options.github_transport} : {}),
    ...(options.reviewer_opencode ? { reviewer_opencode: options.reviewer_opencode } : {}),
    page_window_checkpoint_handoff: options.page_window_checkpoint_handoff === true,
    claude_selected_effort: recipeOptions.selected_effort,
  }, recipeOptions));
}

function resolveClaudeEffortSelectionForRender(input, options = {}) {
  if (options.effortSelection) return options.effortSelection;
  return selectClaudeSecondReviewerEffort({
    reviewer_family: "claude",
    reviewer_model_selection: options.reviewer_model_selection,
    env: options.env ?? process.env,
    effort_ceiling: input?.reviewer_effort_ceiling ?? "xhigh",
  });
}

function slug(value, fallback) {
  const raw = scalar(value, fallback).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function shortHead(input) {
  const head = scalar(input.head_ref_oid, "no-sha").trim();
  return head === "none" ? "no-sha" : head.slice(0, 12);
}

function prNumberFromTarget(value) {
  const match = String(value ?? "").match(/^PR #([1-9][0-9]*)$/);
  return match?.[1] ?? "none";
}

/**
 * Resolve the PR head branch.
 * Prefer live `gh pr view --json headRefName` whenever it resolves; handoff
 * `pr_head_ref_name` is hermetic fallback only when gh is unresolved.
 * When both are present and disagree, return `{ conflict: true, ... }` so the
 * caller can fail closed (a stale handoff cannot stand in for the live head).
 */
function resolvePrHeadRefName(input, { spawnSyncImpl = spawnSync } = {}) {
  const handoffName = typeof input?.pr_head_ref_name === "string"
    && input.pr_head_ref_name.trim().length > 0
    ? input.pr_head_ref_name.trim()
    : null;

  const prNumber = prNumberFromTarget(input?.target);
  let liveName = null;
  let liveSource = 'gh';
  if (prNumber !== "none" && isRepositorySlug(input?.repository_slug)) {
    const response = spawnSyncImpl(
      "gh",
      [
        "pr",
        "view",
        prNumber,
        "--repo",
        input.repository_slug,
        "--json",
        "headRefName",
      ],
      { encoding: "utf8", timeout: SECOND_REVIEW_GH_PROBE_TIMEOUT_MS },
    );
    if (response.status === 0) {
      try {
        const parsed = JSON.parse(String(response.stdout ?? ""));
        if (typeof parsed?.headRefName === "string" && parsed.headRefName.trim().length > 0) {
          liveName = parsed.headRefName.trim();
          liveSource = response.github_transport === 'mcp' ? 'mcp' : 'gh';
        }
      } catch {
        liveName = null;
      }
    }
  }

  if (liveName !== null) {
    if (handoffName !== null && handoffName !== liveName) {
      return {
        headRefName: liveName,
        source: liveSource,
        conflict: true,
        handoffName,
      };
    }
    return { headRefName: liveName, source: liveSource, conflict: false, handoffName };
  }
  if (handoffName !== null) {
    return { headRefName: handoffName, source: "handoff", conflict: false, handoffName };
  }
  return null;
}

/** Test seam: live PR head branch resolution (spawnSync injectable). */
export const __testApprovalResolutionBinding = Object.freeze({
  resolvePrHeadRefName,
});

function executableCarrier(scriptPath, contextPath) {
  // Contract: a cwd-independent absolute path plus exact argv, never a shell command string.
  // This shape is used on every host for projection_bootstrap_command (D4: no
  // Claude Code exception, ever), and on every host except the Claude Code
  // host for projection_runner_command (see relativeRunnerExecutableCarrier
  // below for that one exception).
  return { executable: process.execPath, argv: [scriptPath, contextPath] };
}

// D1/D2 (add-second-reviewer-runner-permission): on the Claude Code host only,
// projection_runner_command uses this repo-root-relative typed carrier instead
// of executableCarrier() above, so the runner invocation can match a narrow
// Bash allow rule on the user's side. The repo no longer tracks such a rule
// (removed by amend-claude-settings-sync-contract). Never used for
// projection_bootstrap_command (D4).
function relativeRunnerExecutableCarrier(contextPath) {
  return canonicalProjectionRunnerCarriers({
    runnerScriptAbsPath: projectionRunnerScriptPath,
    contextPath,
    execPath: process.execPath,
  }).repoRelative;
}

function isExactExecutableCarrier(actual, expected) {
  return actual !== null
    && typeof actual === "object"
    && !Array.isArray(actual)
    && Object.keys(actual).sort().join(",") === "argv,executable"
    && actual.executable === expected.executable
    && Array.isArray(actual.argv)
    && actual.argv.length === expected.argv.length
    && expected.argv.every((value, index) => actual.argv[index] === value);
}

function defaultAttemptId(input) {
  return [
    "second-review",
    slug(input.target, "target"),
    slug(shortHead(input), "no-sha"),
    slug(input.attempt, "attempt"),
    randomUUID(),
  ].join("-");
}

// `precomputedDispatchId` lets a caller (prepareSecondReviewRender, R2) mint
// the dispatch_id BEFORE this function normally would, so the exact same id
// that gets recorded into the pr-sticky round-budget sidecar's
// dispatch_lineage (N4 "先記後派": the sidecar write must happen before
// anything else that could make dispatch happen) is also the id the
// renderer ultimately puts on the wire — one id, not two independently
// generated ones.
function allocateDispatchLineage(input, precomputedDispatchId) {
  return {
    dispatch_id: precomputedDispatchId ?? `dispatch-${randomUUID()}`,
    previous_dispatch_id: input?.previous_dispatch_id ?? null,
  };
}

function normalizeObservabilityContext(input, packetPath, lineage, options = {}) {
  input = input ?? {};
  const provided = input.observability_context && typeof input.observability_context === "object"
    ? input.observability_context
    : {};
  const attemptId = defaultAttemptId(input);
  // The CLI no longer accepts a caller-chosen packet path (S1a, `--carrier-root` replaces
  // the old positional): it always renders under the canonical root itself.
  const effectivePacketPath = options.autoCarrierRoot
    ? path.join(canonicalCarrierRoot, attemptId, canonicalPacketFileName)
    : packetPath;
  // stdout mode has no packet path to derive the carrier root from, so it falls back to
  // the canonical root. It used to fall back under notes/tmp, which the boundary guard
  // below now rejects — the fallback has to land where the guard permits (issue #1735).
  const defaultBaseDir = effectivePacketPath && effectivePacketPath !== "-"
    ? path.dirname(path.resolve(effectivePacketPath))
    : path.join(canonicalCarrierRoot, attemptId);
  const baseDir = path.resolve(scalar(provided.base_dir, defaultBaseDir));
  const heartbeatInterval = Number(provided.heartbeat_interval_seconds ?? 60);
  const packetCarrier = effectivePacketPath && effectivePacketPath !== "-" ? "file" : "stdout";
  const resolvedPacketPath = packetCarrier === "file" ? path.resolve(effectivePacketPath) : "-";
  const contextPath = path.join(baseDir, observabilityContextFileName);
  // Same env source as the reviewer-model resolution below and as the recipe
  // options above: a caller-injected env MUST NOT be honoured for one seam and
  // silently ignored for another.
  const controlEvidenceRoot = controlEvidenceHelper.controlEvidenceRoot(
    options.env ?? process.env,
    repoRoot
  );
  const neutralCwdPath = path.join(
    resolveHostSystemTmpdir(),
    `devpro-second-review-neutral-${slug(attemptId, "attempt")}-${randomUUID()}`
  );
  const reviewScopeReadRecipe = canonicalReviewScopeReadRecipe(input);
  const isExternal = input.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
  // D4 step 1 (R4): the exact instant this dispatch was issued — the ONLY value
  // accept-external-second-review.mjs uses to bound "updated_at/created_at not
  // earlier than issued_at". Computed once so dispatch record and (if ever
  // displayed) the ticket agree.
  const issuedAt = new Date().toISOString();

  const prNumber = input.mode === "pr-sticky" ? prNumberFromTarget(input.target) : "none";
  if (input.mode === "pr-sticky") {
    const selected = selectExactSecondReviewStickyAuthority(input.sticky_authority_snapshot?.comments);
    if (selected.status === "selected") {
      const parsed = parseSecondReviewStickyAuthorityBody(selected.authority.body);
      if (parsed.status === "valid") controlEvidenceHelper.assertDispatchReviewAuthority({
        rootDir: controlEvidenceRoot, dispatchId: parsed.dispatch_id,
        repositorySlug: input.repository_slug, prNumber, headRefOid: parsed.last_reviewed_sha });
    }
  }
  const stickyWriteDisposition = input.mode === "pr-sticky"
    ? {
      ...resolveSecondReviewStickyWriteDisposition(
        input.sticky_authority_snapshot
      ),
      dispatch_id: lineage.dispatch_id,
    }
    : {
      schema: SECOND_REVIEW_STICKY_WRITE_DISPOSITION_SCHEMA,
      repository_slug: scalar(input.repository_slug),
      pr_number: "none",
      dispatch_id: lineage.dispatch_id,
      marker: SECOND_REVIEW_STICKY_MARKER,
      candidate_count: 0,
      snapshot_digest: "none",
      action: "not-applicable",
      classification: "audit_only_no_write",
      reason: "Audit-only review has no sticky write authority.",
    };
  // D1/D4 (R1, R4): an external ticket has no runner to catch a blocked sticky
  // write disposition at spawn time (D7 typed-rejects external context before
  // any spawn) — it must fail closed here, at issuance, instead.
  if (isExternal && stickyWriteDisposition.action === "blocked") {
    const error = new Error(
      `sticky_write_disposition_blocked: ${stickyWriteDisposition.reason ?? "sticky authority is blocked"}`
    );
    error.classification = stickyWriteDisposition.classification ?? "sticky_write_disposition_blocked";
    throw error;
  }

  let claudeEffortFields = {};
  let recipeOptions = {};
  const githubTransport=!isExternal&&input.mode==='pr-sticky'?reviewGithubTransportMode({env:options.env??process.env,
    repository:input.repository_slug,number:prNumber,head:input.head_ref_oid}):undefined;
  if(githubTransport)recipeOptions.github_transport=githubTransport;
  // D1/D2: the requested reviewer model is resolved once, here, for both
  // families (never re-derived at runner time — D2 "runner 不重讀環境變數").
  // External tickets skip this entirely, same reasoning as the effort probe
  // below: there is no runner CLI recipe to select a model for.
  let reviewerModelSelectionFields = {};
  if (!isExternal) {
    const modelCliFamily = options.reviewerFamilyDescriptor.cli_family;
    const resolvedReviewerModel = resolveSecondReviewerModel(modelCliFamily, options.env ?? process.env, { probeModel: options.modelProbe, openCodeModelProbe: options.openCodeModelProbe });
    // D3: the charset/shape rule is enforced here, at render time, on the raw
    // env-override value — the ONLY place this module reads the override
    // environment variable. MUST NOT fall back to the built-in default on an
    // invalid value (S5 — no silent replacement of a misconfigured setting).
    // OpenCode selectors are provider/model pairs that resolveSecondReviewerModel already
    // parsed with the selector grammar (slash-bearing by design); the alias charset rule is
    // for the Claude/Codex override values only.
    if (resolvedReviewerModel.source === "env-override"
      && modelCliFamily !== "opencode"
      && !REVIEWER_MODEL_OVERRIDE_VALUE_RE.test(String(resolvedReviewerModel.model))) {
      const error = new Error(
        `reviewer_model_override_invalid: ${SECOND_REVIEWER_MODEL_OVERRIDE_ENV[modelCliFamily]}`
        + ` must match ${REVIEWER_MODEL_OVERRIDE_VALUE_RE} (not trimmed; set-but-empty is invalid)`
      );
      error.classification = "reviewer_model_override_invalid";
      throw error;
    }
    reviewerModelSelectionFields = {
      reviewer_model_selection: {
        requested: resolvedReviewerModel.model,
        source: resolvedReviewerModel.source,
        ...(resolvedReviewerModel.probe ? {probe: resolvedReviewerModel.probe} : {}),
        env_var: resolvedReviewerModel.source === "env-override"
          ? SECOND_REVIEWER_MODEL_OVERRIDE_ENV[modelCliFamily]
          : null,
      },
    };
    // D2: recipe and record MUST share this same validated object — handed
    // down to selectReviewerCliRecipe() below via recipeOptions, the same
    // channel selected_effort already uses.
    recipeOptions.reviewer_model_selection = reviewerModelSelectionFields.reviewer_model_selection;
  }
  // OpenCode: the reviewer is launched from a trusted profile re-derived from this section,
  // so the renderer records the installed generation, the tool policy for the mode and the
  // launch digest here, once, and every later stage validates against the same section.
  let openCodeFields = {};
  if (!isExternal && options.reviewerFamilyDescriptor.cli_family === "opencode") {
    const section = buildOpenCodeReviewerSection({
      mode: input.mode,
      reviewer_family: input.reviewer_family,
      linked_issue_context: scalar(input.linked_issue_context, "none"),
      repository_slug: scalar(input.repository_slug),
      ...(githubTransport?{github_transport:githubTransport}:{}),
      neutral_cwd_path: neutralCwdPath,
      reviewer_model_selection: reviewerModelSelectionFields.reviewer_model_selection,
    }, {
      cliVersionText: options.openCodeVersionText
        ?? readOpenCodeCliVersion({ env: options.env ?? process.env }),
      launchConfigPath: path.join(baseDir, observabilityOpenCodeLaunchFileName),
    });
    recipeOptions.reviewer_opencode = section;
    openCodeFields = { reviewer_opencode: section };
  }
  // D10: external tickets skip the Claude effort probe entirely — there is no
  // CLI recipe to select an --effort flag for.
  if (!isExternal && options.reviewerFamilyDescriptor.cli_family === "claude") {
    const effortSelection = resolveClaudeEffortSelectionForRender(input, {...options, reviewer_model_selection: recipeOptions.reviewer_model_selection});
    assertClaudeEffortSelectionReady(effortSelection);
    recipeOptions.selected_effort = effortSelection.selected_effort;
    claudeEffortFields = {
      claude_selected_effort: effortSelection.selected_effort,
      claude_effort_selection: {
        status: effortSelection.status,
        selected_effort: effortSelection.selected_effort,
        classification: effortSelection.classification,
        requested_model: effortSelection.requested_model,
        candidates: effortSelection.candidates,
      },
    };
  }

  const context = {
    ...(githubTransport?{github_transport:githubTransport}:{}),
    attempt_id: attemptId,
    guarantee_assessment_required: true,
    dispatch_id: lineage.dispatch_id,
    previous_dispatch_id: lineage.previous_dispatch_id,
    mode: scalar(input.mode),
    reviewer_family: scalar(input.reviewer_family),
    linked_issue_context: scalar(input.linked_issue_context, "none"),
    target: scalar(input.target),
    pr_number: prNumber,
    head_ref_oid: scalar(input.head_ref_oid),
    repository_slug: scalar(input.repository_slug),
    packet_carrier: packetCarrier,
    packet_path: resolvedPacketPath,
    tl_pre_dispatch_contract: tlPreDispatchContract,
    required_spawn_payload_fields: requiredSpawnPayloadFields,
    projection_log_visibility: scalar(
      provided.projection_log_visibility,
      "wrapper-owned-artifacts"
    ),
    reviewer_surface: scalar(provided.reviewer_surface, requiredReviewerSurface),
    runner_owner: scalar(provided.runner_owner, requiredRunnerOwner),
    sandbox_policy: scalar(provided.sandbox_policy, requiredSandboxPolicy),
    heartbeat_interval_seconds: heartbeatInterval,
    context_path: contextPath,
    observability_context_path: contextPath,
    heartbeat_path: path.join(baseDir, observabilityHeartbeatFileName),
    activity_log_path: path.join(baseDir, observabilityActivityFileName),
    stdout_log_path: path.join(baseDir, observabilityStdoutFileName),
    stderr_log_path: path.join(baseDir, observabilityStderrFileName),
    cli_probe_result_path: path.join(baseDir, observabilityCliProbeFileName),
    ...(reviewScopeReadRecipe === null
      ? {}
      : {
          review_scope_read_recipe: cloneJson(reviewScopeReadRecipe),
          review_scope_probe_result_path: path.join(baseDir, REVIEW_SCOPE_PROBE_RESULT_FILE),
        }),
    control_evidence_root: controlEvidenceRoot,
    neutral_cwd_path: neutralCwdPath,
    projection_bootstrap_script: projectionBootstrapScript,
    projection_bootstrap_command: executableCarrier(projectionBootstrapScriptPath, contextPath),
    projection_runner_script: projectionRunnerScript,
    // D1: external tickets never spawn a projection runner. D1/D2
    // (add-second-reviewer-runner-permission): on the Claude Code host,
    // projection_runner_command uses the repo-root-relative carrier instead
    // of the cwd-independent absolute one every other host keeps
    // byte-for-byte unchanged. Same `options.env ?? process.env` injection
    // pattern as resolveClaudeEffortSelectionForRender above.
    projection_runner_command: isExternal
      ? null
      : (isClaudeCodeRendererHost(options.env ?? process.env)
        ? relativeRunnerExecutableCarrier(contextPath)
        : executableCarrier(projectionRunnerScriptPath, contextPath)),
    ...claudeEffortFields,
    ...reviewerModelSelectionFields,
    ...openCodeFields,
    // D1/D2: external tickets skip selectReviewerCliRecipe() entirely — there is
    // no runner CLI recipe to select.
    reviewer_cli_recipe: isExternal ? null : selectReviewerCliRecipe(input, neutralCwdPath, recipeOptions),
    required_activity_events: isExternal
      ? EXTERNAL_TICKET_REQUIRED_ACTIVITY_EVENTS
      : requiredActivityEventsForMode(input.mode),
    duration_conditional_activity_events: durationConditionalActivityEvents,
    owner: scalar(provided.owner, "dp-second-reviewer-wrapper"),
    generated_by: "render-second-review-packet.mjs",
    sticky_write_disposition: stickyWriteDisposition,
    same_family_disclosure: sameFamilyFallbackDisclosure(input?.retry_context),
    // D1/D4 (R1, R4): additive external-evaluator dispatch-record fields.
    // secondReviewDispatchRecord (control-evidence.mjs, T2) copies these onto
    // the dispatch record only when executor_kind is an own key here.
    ...(isExternal
      ? {
        executor_kind: EXTERNAL_EVALUATOR_EXECUTOR_KIND,
        primary_family: scalar(input.primary_family),
        reviewer_tool: scalar(input.reviewer_tool),
        ...(input.mode === "audit-only" ? {
          external_audit_report_path: path.join(baseDir, EXTERNAL_AUDIT_REPORT_BASENAME),
        } : {
          sticky_write_action: stickyWriteDisposition.action,
          sticky_target_comment_id: stickyWriteDisposition.action === "create"
            ? null
            : stickyWriteDisposition.target.id,
          sticky_snapshot_digest: stickyWriteDisposition.snapshot_digest,
        }),
        issued_at: issuedAt,
      }
      : {}),
  };
  if (isExternal && input.mode === "audit-only") {
    context.review_data_sha256 = externalAuditReviewDataSha256(buildSecondReviewData(input, context));
  }
  return context;
}

function validateObservabilityContextInput(input, errors) {
  const provided = input?.observability_context;
  if (!provided) {
    return;
  }
  if (typeof provided !== "object" || Array.isArray(provided)) {
    errors.push("observability_context must be an object when provided; renderer materializes defaults when omitted");
    return;
  }
  for (const field of rendererOwnedObservabilityPathFields) {
    if (Object.hasOwn(provided, field)) {
      errors.push(`observability_context.${field} is renderer-owned; TL MUST NOT hand-author observability paths`);
    }
  }
}

function validateObservabilityContext(context, errors, reviewData) {
  if(reviewData.github_transport!==undefined&&context.github_transport!==reviewData.github_transport)errors.push('observability_context.github_transport differs from the selected transport');
  if(context.github_transport!==undefined&&context.github_transport!=='mcp-ticket-v1')errors.push('observability_context.github_transport is invalid');
  const isExternal = context.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
  if (!Number.isFinite(context.heartbeat_interval_seconds)
    || context.heartbeat_interval_seconds <= 0
    || context.heartbeat_interval_seconds > 60) {
    errors.push("observability_context.heartbeat_interval_seconds must be > 0 and <= 60");
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
  for (const field of [
    "attempt_id",
    "dispatch_id",
    "reviewer_family",
    "linked_issue_context",
    "repository_slug",
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
    "control_evidence_root",
    "neutral_cwd_path",
    "projection_bootstrap_script",
    "projection_bootstrap_command",
    "projection_runner_script",
    // D1: external tickets set projection_runner_command to null (no-spawn) —
    // it is validated separately below instead of here.
    ...(isExternal ? [] : ["projection_runner_command"]),
  ]) {
    if (isBlank(context[field])) {
      errors.push(`observability_context.${field} is required`);
    }
  }
  if (isExternal) {
    if (context.projection_runner_command !== null) {
      errors.push("observability_context.projection_runner_command must be null for executor_kind external-evaluator");
    }
    if (context.executor_kind !== EXTERNAL_EVALUATOR_EXECUTOR_KIND) {
      errors.push(`observability_context.executor_kind must be ${EXTERNAL_EVALUATOR_EXECUTOR_KIND}`);
    }
    if (isBlank(context.primary_family)) {
      errors.push("observability_context.primary_family is required for executor_kind external-evaluator");
    }
    if (isBlank(context.reviewer_tool) || !STICKY_PROVENANCE_TOOL_TOKENS.includes(context.reviewer_tool)) {
      errors.push(`observability_context.reviewer_tool must be one of: ${STICKY_PROVENANCE_TOOL_TOKENS.join(", ")}`);
    }
    if (context.mode === "audit-only") {
      if (context.pr_number !== "none" || !/^[a-f0-9]{64}$/.test(String(context.review_data_sha256 ?? ""))
        || context.external_audit_report_path !== path.join(path.dirname(context.context_path), EXTERNAL_AUDIT_REPORT_BASENAME)) {
        errors.push("observability_context external audit binding is invalid");
      }
    } else {
      if (context.sticky_write_action !== "create" && context.sticky_write_action !== "update") {
        errors.push("observability_context.sticky_write_action must be create or update");
      }
      if (context.sticky_write_action === "create" && context.sticky_target_comment_id !== null) {
        errors.push("observability_context.sticky_target_comment_id must be null for a create disposition");
      }
      if (context.sticky_write_action === "update"
        && (!Number.isSafeInteger(context.sticky_target_comment_id) || context.sticky_target_comment_id <= 0)) {
        errors.push("observability_context.sticky_target_comment_id must be a positive integer for an update disposition");
      }
      if (!/^[a-f0-9]{64}$/.test(String(context.sticky_snapshot_digest ?? ""))) {
        errors.push("observability_context.sticky_snapshot_digest is invalid");
      }
    }
    if (typeof context.issued_at !== "string" || Number.isNaN(Date.parse(context.issued_at))) {
      errors.push("observability_context.issued_at is required and must be a parseable timestamp");
    }
  }
  if (!/^[\x21-\x7e]{1,128}$/.test(String(context.dispatch_id ?? ""))) {
    errors.push("observability_context.dispatch_id must be 1..128 printable ASCII bytes");
  }
  if (context.previous_dispatch_id !== null
    && !/^[\x21-\x7e]{1,128}$/.test(String(context.previous_dispatch_id ?? ""))) {
    errors.push("observability_context.previous_dispatch_id must be null or 1..128 printable ASCII bytes");
  }
  if (context.previous_dispatch_id === context.dispatch_id) {
    errors.push("observability_context dispatch lineage must not refer to itself");
  }
  if (context.tl_pre_dispatch_contract !== tlPreDispatchContract) {
    errors.push(`observability_context.tl_pre_dispatch_contract must be ${tlPreDispatchContract}`);
  }
  if (!["file", "stdout"].includes(context.packet_carrier)) {
    errors.push("observability_context.packet_carrier must be file or stdout");
  }
  if (context.context_path !== context.observability_context_path) {
    errors.push("observability_context.observability_context_path must match context_path");
  }
  if (!path.isAbsolute(context.control_evidence_root)) {
    errors.push("observability_context.control_evidence_root must be an absolute renderer-owned path");
  }
  if (!isRepositorySlug(context.repository_slug)) {
    errors.push("observability_context.repository_slug must use strict owner/name format");
  }
  const targetPrNumber = prNumberFromTarget(context.target);
  if (context.mode === "pr-sticky"
    && (!/^[1-9][0-9]*$/.test(String(context.pr_number ?? ""))
      || context.pr_number !== targetPrNumber)) {
    errors.push("observability_context.pr_number must exactly match the canonical positive decimal target PR number for pr-sticky mode");
  }
  if (context.mode === "audit-only" && context.pr_number !== "none") {
    errors.push("observability_context.pr_number must be none for audit-only mode");
  }
  const resolvedNeutralCwd = path.resolve(context.neutral_cwd_path);
  if (!isDirectChildOfHostSystemTmpdir(resolvedNeutralCwd)
    || !path.basename(resolvedNeutralCwd).startsWith("devpro-second-review-neutral-")) {
    errors.push("observability_context.neutral_cwd_path must be a renderer-owned direct child of the host temp directory");
  }
  if (context.projection_bootstrap_script !== projectionBootstrapScript) {
    errors.push(`observability_context.projection_bootstrap_script must be ${projectionBootstrapScript}`);
  }
  if (!isExactExecutableCarrier(
    context.projection_bootstrap_command,
    executableCarrier(projectionBootstrapScriptPath, context.observability_context_path)
  )) {
    errors.push("observability_context.projection_bootstrap_command must be the exact canonical executable/argv carrier; rerender the packet");
  }
  if (context.projection_runner_script !== projectionRunnerScript) {
    errors.push(`observability_context.projection_runner_script must be ${projectionRunnerScript}`);
  }
  // D3 (add-second-reviewer-runner-permission): accepts either canonical
  // shape (absolute on every host except Claude Code; repo-root-relative on
  // the Claude Code host per D1/D2) via the single shared classifier, not a
  // hardcoded single shape.
  if (!isExternal && classifyProjectionRunnerCarrier(
    context.projection_runner_command,
    canonicalProjectionRunnerCarriers({
      runnerScriptAbsPath: projectionRunnerScriptPath,
      contextPath: context.observability_context_path,
      execPath: process.execPath,
    })
  ) === null) {
    errors.push("observability_context.projection_runner_command must be the exact canonical executable/argv carrier; rerender the packet");
  }
  if (!Array.isArray(context.required_spawn_payload_fields)
    || requiredSpawnPayloadFields.some((field) => !context.required_spawn_payload_fields.includes(field))) {
    errors.push("observability_context.required_spawn_payload_fields must include packet and observability artifact paths");
  }
  if (isExternal) {
    if (context.reviewer_cli_recipe !== null) {
      errors.push("observability_context.reviewer_cli_recipe must be null for executor_kind external-evaluator");
    }
  } else if (!context.reviewer_cli_recipe || typeof context.reviewer_cli_recipe !== "object") {
    errors.push("observability_context.reviewer_cli_recipe is required");
  } else {
    try {
      assertCanonicalReviewerCliRecipe(context, {
        reviewData,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  const expectedRequiredActivityEvents = isExternal
    ? EXTERNAL_TICKET_REQUIRED_ACTIVITY_EVENTS
    : requiredActivityEventsForMode(context.mode);
  if (!isExactOrderedArray(context.required_activity_events, expectedRequiredActivityEvents)) {
    errors.push(`observability_context.required_activity_events must exactly match canonical ${isExternal ? "external-evaluator" : context.mode} activity events`);
  }
  if (!Array.isArray(context.duration_conditional_activity_events)
    || context.duration_conditional_activity_events.length !== durationConditionalActivityEvents.length
    || durationConditionalActivityEvents.some((expected, index) => {
      const actual = context.duration_conditional_activity_events[index];
      return actual?.event !== expected.event || actual?.required_when !== expected.required_when;
    })) {
    errors.push("observability_context.duration_conditional_activity_events must bind 60s liveness and 15m checkpoint events to their runtime-duration conditions");
  }
}

// The approval fields keep their historical names (design D2); no per-PR approval is collected. Both
// pr-sticky and audit-only carry the `none` context and the not-required resolution. Runs inside
// assertValidHandoff, so every refusal precedes any round-budget or dispatch reservation. No grant,
// resolver, or PR-bound resolution is consulted any more.
function isFixedNotRequiredResolution(value) {
  return isPlainObject(value)
    && Object.keys(value).length === 1
    && value.status === "not-required";
}

function assertFixedApprovalFields(input, errors) {
  const resolution = input?.approval_resolution;
  const resolutionPresent = resolution !== undefined && resolution !== null;
  if (isPlainObject(resolution) && resolution.status === "approved") {
    errors.push(APPROVED_RESOLUTION_RETIRED_MESSAGE);
  } else if (input?.mode === "pr-sticky" ? !isFixedNotRequiredResolution(resolution)
    : resolutionPresent && !isFixedNotRequiredResolution(resolution)) {
    errors.push('approval_resolution must be exactly {"status":"not-required"}; rebuild the handoff with build-pr-sticky-handoff.mjs');
  }
  if (input?.mode === "pr-sticky" && input.approval_context !== PR_STICKY_APPROVAL_CONTEXT) {
    errors.push(input.approval_context === "adoption-notice"
      ? ADOPTION_NOTICE_CONTEXT_RETIRED_MESSAGE
      : `pr-sticky approval_context must be exactly "${PR_STICKY_APPROVAL_CONTEXT}"; rebuild the handoff with build-pr-sticky-handoff.mjs`);
  }
}

function assertValidHandoff(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push("handoff JSON must be an object");
  }

  for (const field of requiredFields) {
    if (!input || isBlank(input[field]) || (Array.isArray(input[field]) && input[field].length === 0)) {
      errors.push(`missing required handoff field: ${field}`);
    }
  }

  if (input?.mode === "audit-only") {
    if (input?.review_material_complete !== true) {
      errors.push("review_material_complete must be true for the declared audit-only review scope");
    }
    if (isBlank(input?.review_material)) {
      errors.push("missing required handoff field: review_material");
    }
  }
  if (input?.mode === "pr-sticky") {
    if (Object.hasOwn(input ?? {}, "review_material_complete")) {
      errors.push("legacy review_material_complete is unsupported for pr-sticky; render a canonical v4 scope proof");
    }
    // F-a7d411193b52: typed early exit before the generic joined shape error.
    if (!Object.hasOwn(input ?? {}, "sticky_authority_snapshot")
      || input.sticky_authority_snapshot === undefined
      || input.sticky_authority_snapshot === null) {
      const error = new Error(
        "sticky_authority_snapshot_required: pr-sticky handoff must include sticky_authority_snapshot"
      );
      error.classification = "sticky_authority_snapshot_required";
      throw error;
    }
    for (const field of [
      "review_scope",
      "review_material_capability",
      "review_material_proof",
    ]) {
      if (!Object.hasOwn(input ?? {}, field)) {
        errors.push(`missing required pr-sticky handoff field: ${field}`);
      }
    }
    if (typeof input?.review_material !== "string") {
      errors.push("pr-sticky review_material must be a string; live rows use the exact empty string");
    }
  }

  if (!allowedModes.has(input?.mode)) {
    errors.push(`mode must be one of: ${Array.from(allowedModes).join(", ")}`);
  }
  if (!allowedAttempts.has(input?.attempt)) {
    errors.push(`attempt must be one of: ${Array.from(allowedAttempts).join(", ")}`);
  }
  if (!allowedCarriers.has(input?.review_material_carrier)) {
    errors.push(`review_material_carrier must be one of: ${Array.from(allowedCarriers).join(", ")}`);
  }
  if (!isRepositorySlug(input?.repository_slug)) {
    errors.push("repository_slug is required and must use strict owner/name format");
  }
  // D1/D2 (R1, R2, R9, R10): executor_kind is additive; its absence is the runner
  // path, whose handoff/dispatch shape stays exactly as before (no new keys).
  const declaredExecutorKind = input?.executor_kind;
  const isExternalExecutor = declaredExecutorKind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
  if (Object.hasOwn(input ?? {}, "executor_kind") && !isExternalExecutor) {
    errors.push(`executor_kind must be omitted or exactly ${EXTERNAL_EVALUATOR_EXECUTOR_KIND}`);
  }
  if (isExternalExecutor && !allowedModes.has(input?.mode)) {
    const error = new Error(
      "external_evaluator_mode_unsupported: external-evaluator supports pr-sticky and audit-only"
    );
    error.classification = "external_evaluator_mode_unsupported";
    throw error;
  }
  if (!isExternalExecutor) {
    // D2: `gemini` (cli_family "external") and the external-only carrier have no
    // runner CLI recipe. Reject before selectReviewerCliRecipe() would otherwise
    // silently fall into the Codex recipe branch (any non-claude cli_family).
    let runnerFamilyDescriptor = null;
    try {
      runnerFamilyDescriptor = resolveCanonicalReviewerFamily(input?.reviewer_family);
    } catch {
      runnerFamilyDescriptor = null;
    }
    // `reviewer_cli` is the selectable CLI, kept apart from the model family. Omitted means
    // the family's own verified CLI; an explicit value must equal it, so a mismatch is a
    // typed handoff rejection instead of a silently different recipe.
    if (Object.hasOwn(input ?? {}, "reviewer_cli") && runnerFamilyDescriptor !== null) {
      resolveReviewerCli(input.reviewer_family, input.reviewer_cli);
    }
    if (runnerFamilyDescriptor?.cli_family === "external"
      || input?.review_material_carrier === "external-live-reads") {
      const error = new Error(
        "reviewer_cli_family_unsupported: this reviewer_family or review_material_carrier has no runner CLI recipe; it is only reachable through executor_kind external-evaluator"
      );
      error.classification = "reviewer_cli_family_unsupported";
      throw error;
    }
  }
  if (isExternalExecutor) {
    if (isBlank(input?.reviewer_tool) || !STICKY_PROVENANCE_TOOL_TOKENS.includes(input.reviewer_tool)) {
      errors.push(`external-evaluator handoff requires reviewer_tool to be one of: ${STICKY_PROVENANCE_TOOL_TOKENS.join(", ")}`);
    }
    if (input.mode === "pr-sticky" && input?.review_material_carrier !== "external-live-reads") {
      errors.push("external-evaluator handoff requires review_material_carrier to be exactly external-live-reads");
    }
    if (input.mode === "pr-sticky" && input?.review_material !== "") {
      errors.push("external-evaluator handoff requires review_material to be the exact empty string; review material is live-read by the evaluator, never embedded");
    }
    if (input.mode === "audit-only" && (input.review_material_carrier !== "embedded-diff"
      || scalar(input.linked_issue_context, "none") !== "none")) {
      errors.push("external audit requires complete embedded material and linked_issue_context none");
    }
    for (const field of ["page_window_max_pages", "reviewer_effort_ceiling"]) {
      if (Object.hasOwn(input ?? {}, field)) {
        const error = new Error(
          `external_evaluator_field_not_applicable: ${field} is not applicable to executor_kind external-evaluator; the ticket is single-window and does not spawn a CLI`
        );
        error.classification = "external_evaluator_field_not_applicable";
        throw error;
      }
    }
    // D2 (R2): prove reviewer_family and primary_family resolve to different
    // model-provider groups before this ticket can be issued. No "other"
    // fallback and no same-family issuance — both fail closed.
    const primaryGroup = REVIEWER_FAMILY_GROUPS[input?.primary_family];
    if (primaryGroup === undefined) {
      const error = new Error(
        "cross_model_family_unprovable: primary_family does not resolve to a known reviewer family group"
      );
      error.classification = "cross_model_family_unprovable";
      throw error;
    }
    const reviewerGroup = REVIEWER_FAMILY_GROUPS[input?.reviewer_family];
    if (reviewerGroup !== undefined && reviewerGroup === primaryGroup) {
      // Same-family issuance stays fail closed unless the handoff carries the
      // explicit, change-specific fallback authorization; the shared validator
      // then forces the `same-family fallback: <why>` sticky reason prefix.
      if (sameFamilyFallbackWhy(input?.retry_context) === null) {
        const error = new Error(
          "cross_model_family_same: reviewer_family and primary_family resolve to the same model family group "
          + "(same-family issuance requires an explicit --allow-same-family <why> fallback authorization)"
        );
        error.classification = "cross_model_family_same";
        throw error;
      }
    }
  }
  assertFixedApprovalFields(input, errors);
  if (
    input?.mode === "pr-sticky"
    && classificationIndicatesSameFamilyFallback(input?.retry_context?.classification)
    && sameFamilyFallbackWhy(input?.retry_context) === null
  ) {
    const error = new Error(
      "same_family_fallback_why_required: same_family_fallback requires non-empty sticky_verification why "
      + "(not not-needed/none/empty/generic placeholder)",
    );
    error.classification = "same_family_fallback_why_required";
    throw error;
  }
  const expectedPrNumber = input?.mode === "pr-sticky" ? prNumberFromTarget(input?.target) : "none";
  if (Object.hasOwn(input ?? {}, "pr_number")
    && (typeof input.pr_number !== "string" || input.pr_number !== expectedPrNumber)) {
    errors.push("pr_number must exactly match the canonical target PR number in pr-sticky mode and must be none in audit-only mode");
  }
  if (Object.hasOwn(input ?? {}, "dispatch_id")) {
    errors.push("dispatch_id is renderer-owned and MUST NOT be supplied by the handoff");
  }
  if (Object.hasOwn(input ?? {}, "attempt_id")) {
    errors.push("attempt_id is renderer-owned and MUST NOT be supplied by the handoff");
  }
  if (Object.hasOwn(input ?? {}, "__paged_full_pages_carrier")
    || Object.hasOwn(input ?? {}, "__changed_set_authority")) {
    errors.push("renderer-private authority and full-pages carriers MUST NOT be supplied by the handoff");
  }
  if (input?.previous_dispatch_id !== undefined
    && (typeof input.previous_dispatch_id !== "string"
      || !/^[\x21-\x7e]{1,128}$/.test(input.previous_dispatch_id))) {
    errors.push("previous_dispatch_id must be omitted or contain 1..128 printable ASCII bytes");
  }
  // D6/D6-note: shape-only check here, matching previous_dispatch_id above.
  // Whether full_scope_reason is REQUIRED (already-reviewed pr-sticky PR +
  // review_scope full-pr) is a runtime-state judgement, not a static handoff
  // shape fact — that presence requirement is enforced later by
  // assertReviewScopeMinimality (review_scope_not_minimal), not here.
  if (input?.full_scope_reason !== undefined
    && (typeof input.full_scope_reason !== "string"
      || !/^[\x20-\x7e]{8,200}$/.test(input.full_scope_reason))) {
    errors.push("full_scope_reason must be omitted or contain 8..200 printable ASCII bytes");
  }
  if (Object.hasOwn(input ?? {}, "page_window_full_scan")) {
    errors.push("page_window_full_scan has been removed; regenerate the handoff for the unified scan");
  }
  // D10: additive; absence keeps the selector's own default (xhigh). Only valid for
  // reviewer_family claude — a non-Claude reviewer declaring it is a typed rejection,
  // not a generic shape error, since Codex effort is fixed and cannot be capped.
  if (Object.hasOwn(input ?? {}, "reviewer_effort_ceiling")) {
    if (input.reviewer_effort_ceiling !== "xhigh" && input.reviewer_effort_ceiling !== "max") {
      errors.push("reviewer_effort_ceiling must be omitted or one of: xhigh, max");
    } else if (resolveCanonicalReviewerFamily(input?.reviewer_family).cli_family !== "claude") {
      const error = new Error(
        "reviewer_effort_ceiling_not_applicable: reviewer_effort_ceiling is only valid for reviewer_family claude"
      );
      error.classification = "reviewer_effort_ceiling_not_applicable";
      throw error;
    }
  }
  // D9 (R10, R13): additive; absence keeps the runner path byte-identical (resolves to
  // the unchanged default windowMaxPages=1). external-evaluator handoffs already reject
  // this field above (external_evaluator_field_not_applicable) before this point runs.
  if (Object.hasOwn(input ?? {}, "page_window_max_pages")) {
    if (
      !Number.isSafeInteger(input.page_window_max_pages)
      || input.page_window_max_pages < 1
      || input.page_window_max_pages > SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING
    ) {
      const error = new Error(
        `page_window_max_pages_invalid: page_window_max_pages must be an integer in 1..${SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING}`
      );
      error.classification = "page_window_max_pages_invalid";
      throw error;
    }
  }
  validateObservabilityContextInput(input, errors);

  if (input?.mode === "pr-sticky") {
    const materialErrors = validatePrStickyReviewMaterialContract(
      buildSecondReviewData(input, {
        dispatch_id: "handoff-validation",
        previous_dispatch_id: null,
      }),
      { materialMaxBytes: SECOND_REVIEW_MATERIAL_MAX_BYTES },
    );
    errors.push(...materialErrors);
  }

  if (errors.length > 0) {
    const error = new Error(errors.join("\n"));
    error.errors = errors;
    throw error;
  }
}

// assertFixedApprovalFields has already refused every other shape, so the only value a rendered
// packet can carry is the fixed not-required resolution.
function canonicalApprovalResolution() {
  return { status: "not-required" };
}

function canonicalDoneWhen(input) {
  if (!Object.hasOwn(input ?? {}, "done_when")) return undefined;
  const value = input.done_when;
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return value;
}

// Only a pr-sticky handoff projects reviewer_constraints. The markdown string is carried as given (no trim, filter or
// truncation); type and limits are the validator's job. An absent key or an empty string keeps the key out of Review Data.
function canonicalReviewerConstraints(input) {
  if (input?.mode !== "pr-sticky") return undefined;
  if (!Object.hasOwn(input, "reviewer_constraints")) return undefined;
  const value = input.reviewer_constraints;
  if (value === "") return undefined;
  return value;
}

function canonicalRetryContext(input) {
  const retryContext = input?.retry_context;
  if (retryContext === undefined || retryContext === null) {
    return { classification: "none", sticky_verification: "not-needed" };
  }
  if (typeof retryContext !== "object" || Array.isArray(retryContext)) return retryContext;
  return {
    classification: retryContext.classification,
    sticky_verification: retryContext.sticky_verification,
  };
}

function buildSecondReviewData(input, context) {
  const authoritativeChangedPaths = context.__changed_set_authority?.paths;
  const commonPrefix = {
    schema_version: input.mode === "pr-sticky"
      ? SECOND_REVIEW_PR_DATA_SCHEMA_VERSION
      : SECOND_REVIEW_DATA_SCHEMA_VERSION,
    mode: input.mode,
    attempt: input.attempt,
    dispatch_id: context.dispatch_id,
    previous_dispatch_id: context.previous_dispatch_id,
    primary_family: input.primary_family,
    reviewer_family: input.reviewer_family,
    target: input.target,
    head_ref_oid: input.head_ref_oid ?? "none",
    approval_context: input.approval_context,
    approval_resolution: canonicalApprovalResolution(),
  };
  const reviewMaterial = input.mode === "pr-sticky"
    ? {
      review_scope: input.review_scope,
      scope_summary: input.scope_summary,
      changed_files_or_touch_list: authoritativeChangedPaths ?? input.changed_files_or_touch_list,
      review_material_carrier: input.review_material_carrier,
      review_material_capability: input.review_material_capability,
      review_material_proof: input.review_material_proof,
      review_material: input.review_material,
    }
    : {
      scope_summary: input.scope_summary,
      changed_files_or_touch_list: input.changed_files_or_touch_list,
      review_material_carrier: input.review_material_carrier,
      review_material_complete: input.review_material_complete,
      review_material: input.review_material,
    };
  const doneWhen = canonicalDoneWhen(input);
  const reviewerConstraints = canonicalReviewerConstraints(input);
  return {
    ...commonPrefix,
    ...reviewMaterial,
    previous_sticky: input.previous_sticky ?? "none",
    retry_context: canonicalRetryContext(input),
    linked_issue_context: input.linked_issue_context ?? "none",
    primary_verdict: input.primary_verdict ?? "none",
    evidence: [
      { kind: "validation", narrative: input.primary_validation_evidence },
      { kind: "test", narrative: input.primary_test_evidence },
    ],
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    ...(reviewerConstraints === undefined ? {} : { reviewer_constraints: reviewerConstraints }),
    ...(context.github_transport?{github_transport:context.github_transport}:{}),
  };
}

// D8 (R8): recursively walk every string leaf of a handoff-derived value,
// collecting PII (lib/pii-pattern-contract.mjs) and bounded secret
// (lib/secret-pattern-contract.mjs) hits, tagged with a field path for the
// eventual error — never the matched value itself.
function collectExternalPacketHits(value, fieldPath, hits) {
  if (typeof value === "string") {
    for (const hit of findPIIHits(value)) {
      hits.push({ path: fieldPath, category: `pii:${hit.type}` });
    }
    for (const hit of findSecretHits(value)) {
      hits.push({ path: fieldPath, category: `secret:${hit.category}` });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExternalPacketHits(item, `${fieldPath}[${index}]`, hits));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectExternalPacketHits(item, `${fieldPath}.${key}`, hits);
    }
  }
}

// D8 (R8): two layers over the same Review Data that is about to be embedded
// in an external-facing packet — (1) a structured per-leaf walk (precise
// field paths for the error), (2) a scan of the fully serialized payload
// (catches a pattern that only forms once fields are concatenated/escaped
// together). Fail closed: any hit throws before dispatch_id reservation, so
// nothing is reserved and nothing is published (D1 pipeline order).
function assertExternalPacketScrub(data, serializedPayload) {
  const hits = [];
  collectExternalPacketHits(data, "review_data", hits);
  for (const hit of findPIIHits(serializedPayload)) {
    hits.push({ path: "review_data.<serialized>", category: `pii:${hit.type}` });
  }
  for (const hit of findSecretHits(serializedPayload)) {
    hits.push({ path: "review_data.<serialized>", category: `secret:${hit.category}` });
  }
  if (hits.length === 0) return;
  const uniqueLocations = [...new Set(hits.map((hit) => `${hit.path} (${hit.category})`))];
  const error = new Error(
    `external_ticket_unsafe_value: unsafe value detected before dispatch reservation at: ${uniqueLocations.join(", ")}`
  );
  error.classification = "external_ticket_unsafe_value";
  throw error;
}

function buildSecondReviewPacket(input, context) {
  // D9 (R10, R13): resolve once, thread explicitly into every windowMaxPages callsite
  // below; undeclared writes no new context key so runner-path bytes stay identical.
  const resolvedWindowMaxPages = resolveDeclaredPageWindowMaxPages(input.page_window_max_pages);
  if (Object.hasOwn(input ?? {}, "page_window_max_pages")) {
    context.page_window_max_pages = resolvedWindowMaxPages;
  }
  const sourceData = buildSecondReviewData(input, context);
  const normalized = input.mode === "pr-sticky"
    ? normalizePrStickyReviewMaterialData(sourceData, {
      materialMaxBytes: SECOND_REVIEW_MATERIAL_MAX_BYTES,
      windowMaxPages: resolvedWindowMaxPages,
    })
    : sourceData;
  const pagedFullPages = normalized.__paged_full_pages;
  const data = normalized.__paged_full_pages === undefined
    ? normalized
    : Object.fromEntries(
      Object.entries(normalized).filter(([key]) => key !== "__paged_full_pages")
    );
  if (Array.isArray(pagedFullPages)) {
    context.__paged_full_pages_path = path.join(
      path.dirname(context.context_path),
      PAGED_FULL_PAGES_CARRIER_BASENAME,
    );
    context.page_window_checkpoint_handoff = true;
    const declaredPagedIndex = Number(input.page_window_index);
    context.page_window_index = Number.isSafeInteger(declaredPagedIndex) && declaredPagedIndex >= 1
      ? declaredPagedIndex
      : 1;
    context.page_window_count = pageWindowCount(data.review_material.manifest.page_count, resolvedWindowMaxPages);
    if (context.__paged_full_pages_carrier === undefined) {
      const createdAt = new Date();
      const createdAtIso = createdAt.toISOString();
      const expiresAtIso = new Date(createdAt.getTime() + 7_200_000).toISOString();
      const authorityPathsSha256 = changedPathsSha256(data.changed_files_or_touch_list);
      context.__paged_full_pages_carrier = {
        schema: PAGED_FULL_PAGES_CARRIER_SCHEMA,
        dispatch_id: context.dispatch_id,
        head_ref_oid: data.head_ref_oid,
        scope_fingerprint_sha256: reviewScopeFingerprintSha256(data.review_scope),
        carrier_root_id: sha256(Buffer.from(path.dirname(context.context_path), "utf8")),
        changed_set_authority: {
          kind: context.__changed_set_authority.kind,
          comparison_base_sha: context.__changed_set_authority.comparison_base_sha,
          head_sha: context.__changed_set_authority.head_sha,
          path_count: context.__changed_set_authority.path_count,
          paths_sha256: context.__changed_set_authority.paths_sha256,
        },
        changed_paths_sha256: authorityPathsSha256,
        manifest_sha256: data.review_material_proof.manifest_sha256,
        created_at: createdAtIso,
        expires_at: expiresAtIso,
        pages: pagedFullPages.map((page) => ({
          index: page.index,
          utf8_bytes: Buffer.byteLength(page.content, "utf8"),
          sha256: materialSha256(page.content),
          content: page.content,
        })),
      };
    }
  } else if (data?.review_material_carrier === "renderer-paged-snapshot") {
    context.page_window_checkpoint_handoff = true;
    const declaredSnapshotIndex = Number(input.page_window_index);
    context.page_window_index = Number.isSafeInteger(declaredSnapshotIndex) && declaredSnapshotIndex >= 1
      ? declaredSnapshotIndex
      : 1;
    context.page_window_count = pageWindowCount(data.review_material.manifest.page_count, resolvedWindowMaxPages);
  } else {
    context.page_window_checkpoint_handoff = false;
  }
  if (
    context.page_window_checkpoint_handoff === true
    && data?.review_material?.window_role === "intermediate"
    && isPlainObject(context.sticky_write_disposition)
    && (context.sticky_write_disposition.action === "create"
      || context.sticky_write_disposition.action === "update")
  ) {
    context.sticky_write_disposition_authorized = cloneJson(context.sticky_write_disposition);
    context.sticky_write_disposition = pageWindowIntermediateStickyDisposition(
      context.sticky_write_disposition_authorized,
    );
  }
  const payload = JSON.stringify(data);
  const isExternal = input.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
  const isExternalAudit = isExternal && input.mode === "audit-only";
  if (isExternal) {
    // D8 (R8): last-line-of-defense scrub before any external-facing bytes are
    // assembled — this runs before dispatch_id reservation (D1), so a hit
    // never reserves and never publishes anything.
    assertExternalPacketScrub(data, payload);
  }
  const reviewerTool = isExternal ? scalar(input.reviewer_tool) : defaultReviewerTool(input);
  // D2/D3: single source for the external ticket's repo-relative carrier dir
  // string — same helper buildCredentialGateSidecarContent uses for body_file,
  // so the sidecar and the ticket's recipe/body/working-directory lines can
  // never separately drift.
  const externalCarrierDir = isExternal ? externalCarrierRepoRelativeDir(context) : undefined;
  // F-04: an external-evaluator ticket has no runner wrapper, so it gets its
  // own carrier-agnostic static prefix instead of reusing the runner's
  // wrapper-assuming secondReviewPacketStaticPrefix.
  const prefix = isExternalAudit
    ? externalAuditPacketStaticPrefix(reviewerTool, context.dispatch_id)
    : isExternal
    ? externalEvaluatorPacketStaticPrefix(
      reviewerTool,
      context.dispatch_id,
      context.sticky_write_disposition,
      {
        retryContext: data.retry_context,
        primaryFamily: data.primary_family,
        reviewScopeDriftAdvisory: reviewScopeDriftAdvisoryFromData(data),
        externalCarrierDir,
      },
    )
    : secondReviewPacketStaticPrefix(
      reviewerTool,
      input.mode,
      context.dispatch_id,
      context.sticky_write_disposition,
      data.schema_version,
      {
        pageWindowCheckpointHandoff: context.page_window_checkpoint_handoff === true,
        retryContext: data.retry_context,
        primaryFamily: data.primary_family,
        reviewScopeDriftAdvisory: reviewScopeDriftAdvisoryFromData(data),
        githubTransport:context.github_transport,
      },
    );
  // D1: external tickets replace the runner-oriented "## Completion JSON"
  // suffix (no CLI parses a completion JSON off this path) with a
  // renderer-owned, self-sufficient "## External Evaluator Ticket" section.
  const suffix = isExternalAudit
    ? externalAuditTicketSuffix({
      repositorySlug: scalar(input.repository_slug), headRefOid: data.head_ref_oid,
      reviewScopeSummary: data.scope_summary, dispatchId: context.dispatch_id,
      reviewerFamily: data.reviewer_family, reviewerTool, externalCarrierDir,
      attemptId: context.attempt_id, reviewDataSha256: context.review_data_sha256, target: data.target,
    })
    : isExternal
    ? externalEvaluatorTicketSuffix({
      repositorySlug: scalar(input.repository_slug),
      prNumber: context.pr_number,
      headRefOid: data.head_ref_oid,
      reviewScopeSummary: data.scope_summary,
      dispatchId: context.dispatch_id,
      reviewerFamily: data.reviewer_family,
      reviewerTool,
      stickyWriteDisposition: context.sticky_write_disposition,
      externalCarrierDir,
      sameFamilyDisclosure: sameFamilyFallbackDisclosure(input?.retry_context),
      rulesVersion: secondReviewRulesVersion(),
    })
    // D9 (R10, R13): the packet-owned suffix binds the actual active window/page indices
    // (data.review_material.pages), not the W=1 window-1/page-1 default — with a
    // declared windowMaxPages > 1 the first window already spans more than page 1.
    : secondReviewPacketStaticSuffix(data.schema_version, {
      windowIndex: context.page_window_index,
      pageIndices: Array.isArray(data.review_material?.pages)
        ? data.review_material.pages.map((page) => page.index)
        : undefined,
    });
  return `${prefix}${SECOND_REVIEW_FRAME_MARKER}${Buffer.byteLength(payload, "utf8")}\n\n${payload}${suffix}`;
}

function assertValidPacket(packet, windowMaxPages) {
  const validation = validateSecondReviewPacketText(packet, { windowMaxPages });
  if (!validation.ok) {
    throw new Error(formatSecondReviewPacketValidationError(validation));
  }
}

// Roles the pre-existence collision check deliberately skips. The review-scope probe
// result is written later by the probe, not by the renderer's initial publication, so
// including it here would reject legitimate renders.
const preExistenceExemptCarrierRoles = new Set(["review-scope-probe-result"]);

// Single source for every path the renderer derives from the carrier base dir. Both the
// pre-existence check and the reviewer-writable boundary guard read this list, so a new
// carrier cannot be added to one and forgotten in the other.
function rendererCarrierEntries(context) {
  return [
    ...(context.packet_carrier === "file" ? [["packet", context.packet_path]] : []),
    ["observability-context", context.observability_context_path],
    ["context", context.context_path],
    ["heartbeat", context.heartbeat_path],
    ["activity", context.activity_log_path],
    ["stdout", context.stdout_log_path],
    ["stderr", context.stderr_log_path],
    ["cli-probe-result", context.cli_probe_result_path],
    ["paged-full-material", context.__paged_full_pages_path],
    ["review-scope-probe-result", context.review_scope_probe_result_path],
  ].filter(([, value]) => typeof value === "string" && value.length > 0);
}

function initialCarrierPaths(context) {
  return [...new Set(
    rendererCarrierEntries(context)
      .filter(([role]) => !preExistenceExemptCarrierRoles.has(role))
      .map(([, value]) => value)
  )];
}

// Every form a path could take when compared against a boundary: the lexical
// resolution plus the realpath of its nearest existing ancestor. Symlinked directories
// resolve to their target here, so a link cannot launder a carrier across the boundary.
// `null` means no ancestor resolved at all, which the caller treats as inside.
//
// Both boundary guards below share this resolution, so the classification and the phrase
// naming the decision are parameters: an unreadable path must fail closed under the typed
// classification of whichever guard asked, not under whichever one happened to be written
// first.
function boundaryComparisonForms(target, {
  classification = reviewerWritableRootCarrierCollision,
  decision = "sits inside the reviewer-writable root",
} = {}) {
  const lexical = path.resolve(target);
  const forms = new Set([lexical]);
  let probe = lexical;
  for (;;) {
    try {
      forms.add(path.resolve(realpathSync(probe), path.relative(probe, lexical)));
      return [...forms];
    } catch (err) {
      // A missing ancestor is the expected step on the way up. Any other errno (EACCES,
      // ELOOP, ENOTDIR) means the boundary cannot be proven, and swallowing it would
      // report a carrier collision whose real cause is an unreadable path — the exact
      // misdiagnosis design.md names as risk R-b. Fail closed, but say why.
      if (err?.code !== "ENOENT") {
        throw new Error(
          `${classification}: cannot resolve ${probe} while deciding `
          + `whether ${lexical} ${decision} `
          + `(${err?.code ?? "unknown"}: ${err?.message ?? err})`
        );
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

// issue #1735 case 3: a reviewer CLI recipe that hands a reviewer a writable root inside
// this repo checkout can reach shared control-evidence state, tier logs, and other
// repo-scoped material well past its per-dispatch scope. This runs before the
// carrier-collision and leanness guards below so the immediately-actionable cause (the
// recipe itself, not accumulated machine state) is reported first.
//
// Both checkouts are compared, not just `repoRoot`. `repoRoot` resolves to whatever
// checkout this file sits in, so from a linked worktree it is the worktree — while the
// grant this gate exists to reject named `<main-checkout>/notes/tmp`, which is not inside
// that worktree. Comparing only `repoRoot` would therefore fail open on the exact shape of
// issue #1735 whenever the render runs from `.worktree/<change>/`, which is this repo's
// normal working shape. The two roots coincide outside a worktree, hence the dedupe.
//
// Containment is checked in BOTH directions. The invariant is that the reviewer's writable
// surface must not intersect the repo at all, and a root that *contains* a checkout (`/`,
// `$HOME`, or the parent directory holding both the main checkout and `.worktree/`) grants
// strictly more than the `<main-checkout>/notes/tmp` shape issue #1735 actually shipped. A
// one-way check would wave through the larger grant while rejecting the smaller one.
//
// Both sides are compared through `boundaryComparisonForms()`, not `path.resolve()` alone.
// The requirement is that the root must not *resolve* inside a checkout, and a lexical
// comparison reads a symlink that points into the repo as an ordinary out-of-tree path —
// the reviewer gets the repo-internal surface anyway, which is the whole shape issue #1735
// shipped. The sibling carrier guard below already normalizes this way; leaving this one
// lexical would make the two guards in this file disagree about what "inside" means, with
// the weaker one deciding whether the reviewer reaches the repo at all.
function assertReviewerWritableRootOutsideRepo(context) {
  const containmentRoots = reviewerWritableRootsFromRecipe(context.reviewer_cli_recipe);
  const resolution = {
    classification: reviewerWritableRootInsideRepo,
    decision: "intersects this repository checkout",
  };
  const checkoutRoots = [...new Set([path.resolve(repoRoot), path.resolve(mainCheckoutRoot)])]
    .map((checkoutRoot) => ({
      checkoutRoot,
      forms: boundaryComparisonForms(checkoutRoot, resolution) ?? [checkoutRoot],
    }));
  for (const writableRoot of containmentRoots) {
    const rootForms = boundaryComparisonForms(writableRoot, resolution) ?? [path.resolve(writableRoot)];
    for (const { checkoutRoot, forms } of checkoutRoots) {
      const rootIsInsideCheckout = rootForms.some((root) => forms.some(
        (checkout) => root === checkout || isPathInside(checkout, root)
      ));
      const rootContainsCheckout = rootForms.some((root) => forms.some(
        (checkout) => isPathInside(root, checkout)
      ));
      if (!rootIsInsideCheckout && !rootContainsCheckout) continue;
      const relation = rootIsInsideCheckout ? "sits inside" : "contains";
      // When the lexical and realpath forms differ, the rejected root does not visibly touch
      // the checkout — name the resolved form so the TL is not left comparing an out-of-tree
      // path against a checkout it appears unrelated to.
      const symlinkNote = rootForms.length > 1
        ? ` (${rootForms[0]} resolves through a symlink to ${rootForms[rootForms.length - 1]}; `
          + `either form intersecting a checkout rejects)`
        : "";
      throw new Error(
        `${reviewerWritableRootInsideRepo}: the reviewer CLI recipe grants ${writableRoot} as a `
        + `writable root, which ${relation} this repository checkout (${checkoutRoot})${symlinkNote}; a reviewer that `
        + `can read or write inside the repo can reach shared control-evidence state, tier logs, and `
        + `other repo-scoped material well past its per-dispatch scope (issue #1735). The recipe must `
        + `only grant a per-dispatch root that does not intersect the repo checkout.`
      );
    }
  }
}

// D2's fourth guard. It does not derive its root from reviewerWritableRootsFromRecipe()
// like the other three guards in this window — it derives from the renderer's own
// canonicalCarrierRoot + attempt_id instead, because what it protects against is not a bad
// recipe grant but the renderer's own carrier placement drifting away from its own root,
// whatever the cause. The two classifications separate a wrong --carrier-root value (a TL
// input, fixable by passing the flag the renderer itself derives) from a placement that
// already resolved somewhere else despite a correct flag value (fixable only by removing
// whatever caused the drift, not by retrying with a different value).
//
// The assertion target is the *resolved* base dir and carrier entries, not the CLI
// argument: normalizeObservabilityContext() lets a handoff's observability_context.base_dir
// override the packet-path-derived default entirely, and validateObservabilityContextInput()
// already rejects that field upstream of this guard today — but this guard checks the
// resolved values so it stays correct if that upstream rejection is ever loosened.
function assertCarriersUnderCanonicalCarrierRoot(context, options = {}) {
  if (typeof options.carrierRootValue === "string" && options.carrierRootValue.length > 0) {
    const mismatchResolution = {
      classification: canonicalCarrierRootMismatch,
      decision: "names the renderer's own canonical carrier root",
    };
    const suppliedForms = boundaryComparisonForms(options.carrierRootValue, mismatchResolution)
      ?? [path.resolve(options.carrierRootValue)];
    const canonicalForms = boundaryComparisonForms(canonicalCarrierRoot, mismatchResolution)
      ?? [path.resolve(canonicalCarrierRoot)];
    if (!suppliedForms.some((supplied) => canonicalForms.includes(supplied))) {
      throw new Error(
        `${canonicalCarrierRootMismatch}: --carrier-root ${options.carrierRootValue} does not `
        + `name the renderer's own canonical carrier root ${canonicalCarrierRoot}; pass that `
        + `value instead of a caller-chosen one — the renderer always publishes there `
        + `regardless of what --carrier-root says.`
      );
    }
  }

  const containmentResolution = {
    classification: canonicalCarrierRootContainment,
    decision: "sits under the canonical carrier root",
  };
  const attemptRoot = path.join(canonicalCarrierRoot, context.attempt_id);
  const attemptRootForms = boundaryComparisonForms(attemptRoot, containmentResolution)
    ?? [path.resolve(attemptRoot)];
  const baseDir = path.dirname(context.observability_context_path);

  for (const [role, carrierPath] of [["base directory", baseDir], ...rendererCarrierEntries(context)]) {
    const carrierForms = boundaryComparisonForms(carrierPath, containmentResolution);
    const contained = carrierForms !== null
      && carrierForms.some((form) => attemptRootForms.some(
        (root) => form === root || isPathInside(root, form)
      ));
    if (!contained) {
      throw new Error(
        `${canonicalCarrierRootContainment}: the ${role} ${carrierPath} does not resolve under `
        + `the canonical carrier root ${attemptRoot}/; something overrode the renderer's own `
        + `carrier placement. Remove whatever supplied that override — the renderer always `
        + `publishes under its own <canonicalCarrierRoot>/<attempt_id>/ and cannot be `
        + `redirected elsewhere.`
      );
    }
  }
  if (path.basename(baseDir) !== context.attempt_id) {
    throw new Error(
      `${canonicalCarrierRootContainment}: the carrier base directory ${baseDir} is not named `
      + `after this render's own attempt_id (${context.attempt_id}); the renderer always names `
      + `its attempt directory after its own attempt_id.`
    );
  }
}

function assertCarriersOutsideReviewerWritableRoot(context) {
  const collisionRoots = reviewerWritableRootsFromRecipe(context.reviewer_cli_recipe);
  for (const collisionRoot of collisionRoots) {
    const rootForms = boundaryComparisonForms(collisionRoot) ?? [path.resolve(collisionRoot)];
    for (const [role, carrierPath] of rendererCarrierEntries(context)) {
      const carrierForms = boundaryComparisonForms(carrierPath);
      const collides = carrierForms === null
        || rootForms.some((root) => carrierForms.some((carrier) => isPathInside(root, carrier)));
      if (collides) {
        // When the lexical and realpath forms differ, the rejected path does not visibly
        // sit under the root — say which form triggered it so the TL is not left comparing
        // two strings that look unrelated.
        const symlinkNote = carrierForms && carrierForms.length > 1
          ? ` (${carrierForms[0]} resolves through a symlink to `
            + `${carrierForms[carrierForms.length - 1]}; either form inside the root rejects)`
          : "";
        throw new Error(
          `${reviewerWritableRootCarrierCollision}: the ${role} carrier would be published inside `
          + `the reviewer-writable root ${collisionRoot}, which the reviewer CLI recipe grants as a `
          + `writable root; a reviewer that re-reads its own packet there overflows the runner `
          + `complete-line bound${symlinkNote}. This collision means the current repository `
          + `checkout sits under the OS temp directory, overlapping the reviewer's per-dispatch `
          + `writable root; move the checkout out of the temp directory — rerunning the renderer `
          + `or choosing a different packet path will not help, because the writable root is `
          + `regenerated under the same temp directory on every dispatch.`
        );
      }
    }
  }
}

/**
 * Upper bound on the bytes a single-line `ls -la` of `dir` would occupy.
 *
 * Deliberately NON-recursive: `notes/tmp/state/**` alone holds 700+ files, so a
 * recursive estimate would exceed the threshold on every render this repo does today.
 * The gate therefore covers exactly one reviewer behaviour — a top-level orientation
 * listing of the reviewer-writable root — and claims nothing about `ls -R`, `find`, or a
 * listing of any subdirectory.
 *
 * A missing root is a provable zero (a reviewer cannot enumerate what is not there);
 * every other errno means the root cannot be proven lean and is left for the caller to
 * fail closed on.
 */
export function estimateSingleLineListing(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  let bytes = lsListingHeaderOvercountBytes;
  // readdirSync omits `.` and `..`; `ls -la` prints them.
  for (const name of [".", "..", ...names]) {
    bytes += lsFixedColumnOvercountBytes + Buffer.byteLength(name, "utf8") + 1;
  }
  return bytes;
}

/**
 * The threshold in force for this render. The override exists so tests can reproduce an
 * over-full root without seeding hundreds of files into a developer's real scratch
 * directory, and it is clamped with `Math.min` so it can only ever tighten the gate.
 * A seam that could raise the threshold would be a fail-open path reachable from the
 * environment, which is the one thing a fail-closed gate must not have.
 */
export function effectiveWritableRootListingLimit(
  raw = process.env.DEVPRO_SECOND_REVIEW_MAX_WRITABLE_ROOT_LISTING_BYTES
) {
  if (!/^\d+$/.test(String(raw ?? ""))) return maxReviewerWritableRootListingBytes;
  return Math.min(maxReviewerWritableRootListingBytes, Number(raw));
}

function assertReviewerWritableRootIsLean(context) {
  const leannessRoots = reviewerWritableRootsFromRecipe(context.reviewer_cli_recipe);
  const threshold = effectiveWritableRootListingLimit();
  const remediation =
    `  → the reviewer CLI recipe's writable root is meant to be a fresh, per-dispatch, `
    + `empty-at-render-time directory; delete or relocate whatever is accumulating there `
    + `before the next render\n`
    + `  (this is state the recipe's writable root has accumulated, not a misconfiguration `
    + `of this render)`;

  for (const leannessRoot of leannessRoots) {
    let estimated;
    try {
      estimated = estimateSingleLineListing(leannessRoot);
    } catch (err) {
      throw new Error(
        `${reviewerWritableRootEnumerationOverflowRisk}: reason=listing_unreadable\n`
        + `  writableRoot=${leannessRoot}  estimated=unknown  threshold=${threshold}B\n`
        + `  (${err?.code ?? "unknown"}: ${err?.message ?? err})\n`
        + remediation
      );
    }

    if (estimated <= threshold) continue;
    throw new Error(
      `${reviewerWritableRootEnumerationOverflowRisk}: reason=estimate_exceeds_threshold\n`
      + `  writableRoot=${leannessRoot}  estimated=${estimated}B  threshold=${threshold}B\n`
      + `  A reviewer that runs one orientation \`ls -la\` on this root emits the whole listing as a `
      + `single line and latches the runner complete-line bound, killing the dispatch with no verdict `
      + `and no sticky (issue #1735 case 1).\n`
      + remediation
    );
  }
}

function assertInitialCarriersAvailable(context) {
  const collisionPath = initialCarrierPaths(context).find((filePath) => existsSync(filePath));
  if (collisionPath) {
    throw new Error(
      `${secondReviewInitialCarrierCollision}: second-review initial carrier already exists: `
      + `${path.basename(collisionPath)}`
    );
  }
}

function writeExclusiveText(filePath, content) {
  writeExclusiveBytes(filePath, content, { encoding: "utf8" });
}

function writeExclusiveBytes(filePath, content, options = undefined) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  let fd;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, content, options);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (existsSync(temporaryPath)) {
      try { unlinkSync(temporaryPath); } catch {}
    }
  }
}

// The publication ledger already reserves a fresh random staging path durably, so a
// second anonymous temp name would create an unowned crash residue. Write the recorded
// name directly and durably; recovery may delete a partial staging file only while no
// target hard link exists, because the pending entry proves this exact exclusive name.
function writeRecordedStagingBytes(filePath, content) {
  let fd;
  try {
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

// Like the recorded carrier staging writer, this direct writer creates only the
// deterministic rewrite name owned by the already-durable primary envelope.
function writeRecordedRewriteBytes(filePath, content) {
  let fd;
  try {
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class PublicationTransactionCandidateSchemaViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicationTransactionCandidateSchemaViolation";
    this.classification = "schema-violation";
  }
}


function pushCredentialGatePageTexts(texts, pages) {
  if (!Array.isArray(pages)) return;
  for (const page of pages) {
    if (typeof page?.content === "string" && page.content.length > 0) {
      texts.push(page.content);
    }
    if (typeof page?.text === "string" && page.text.length > 0) {
      texts.push(page.text);
    }
  }
}

export function collectCredentialGateMaterialTexts(effectiveInput, context) {
  const texts = [];
  const material = effectiveInput?.review_material;
  if (typeof material === "string" && material.length > 0) {
    texts.push(material);
  } else if (isPlainObject(material) && Array.isArray(material.pages)) {
    pushCredentialGatePageTexts(texts, material.pages);
  }
  if (typeof effectiveInput?.reviewer_constraints === "string" && effectiveInput.reviewer_constraints.length > 0) {
    texts.push(effectiveInput.reviewer_constraints);
  }
  // PRIM-F7: final sticky concludes the full review; deny-set MUST include every
  // paged window, not only the active final window framed into review_material.
  const fullPages = context?.__paged_full_pages_carrier?.pages;
  if (Array.isArray(fullPages)) {
    pushCredentialGatePageTexts(texts, fullPages);
  }
  return texts;
}

// D2 (fix-external-evaluator-sticky-recipe): single source for the external-
// evaluator carrier's repo-relative directory string. Used by both
// buildCredentialGateSidecarContent (D1's body_file, below) and
// buildSecondReviewPacket (D3's ticket/prefix recipe lines) so the sidecar and
// the ticket always share one string, never separately-derived copies.
//
// Verified against canonicalCarrierRoot + attempt_id, not mainCheckoutRoot:
// assertCarriersUnderCanonicalCarrierRoot already guarantees every carrier
// path resolves under <canonicalCarrierRoot>/<attempt_id>/, and in production
// canonicalCarrierRoot is always <mainCheckoutRoot>/notes/cross-review
// (derived from the same mainCheckoutNotesTmp), so this check proves the same
// invariant without a second, independent derivation from mainCheckoutRoot —
// and it stays true under test fixtures that relocate only canonicalCarrierRoot.
//
// Runs before any sidecar write (buildCredentialGateSidecarContent is the
// first call inside writeCredentialGateSidecarFiles, before its
// notes/tmp writeFileSync), so a mismatch here never writes notes/tmp, never
// reserves a dispatch, and never publishes.
function externalCarrierRepoRelativeDir(context) {
  const attemptId = context.attempt_id;
  const expectedCarrierDir = path.resolve(canonicalCarrierRoot, attemptId);
  const actualCarrierDir = path.resolve(path.dirname(context.observability_context_path));
  if (expectedCarrierDir !== actualCarrierDir) {
    throw Object.assign(
      new Error(
        `${canonicalCarrierRootContainment}: the external carrier directory ${actualCarrierDir} `
        + `does not equal canonicalCarrierRoot/attempt_id (${expectedCarrierDir}); the renderer `
        + `always publishes under its own <canonicalCarrierRoot>/<attempt_id>/`
      ),
      { classification: canonicalCarrierRootContainment },
    );
  }
  return `notes/cross-review/${attemptId}`;
}

function buildCredentialGateSidecarContent(context, effectiveInput) {
  const disposition = context?.sticky_write_disposition;
  if (!isPlainObject(disposition)) return null;
  if (disposition.action !== "create" && disposition.action !== "update") return null;
  const materialTexts = collectCredentialGateMaterialTexts(effectiveInput, context);
  const isExternal = context.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
  // D1: only the external sidecar's body_file points at the gitignored
  // carrier directory itself (a real, existing path an evaluator can write
  // to from the main checkout root). The runner keeps writing the same
  // neutral-cwd basename it always has (byte-identical; R7 must-keep) —
  // PRIM-F8's digest-seals-body_file rationale still holds for that branch.
  const bodyFile = isExternal
    ? `${externalCarrierRepoRelativeDir(context)}/cross-model-second-opinion.md`
    : "cross-model-second-opinion.md";
  const payload = {
    schema: STICKY_CREDENTIAL_GATE_SIDECAR_SCHEMA,
    disposition: disposition.action,
    repository_slug: disposition.repository_slug,
    pr_number: disposition.pr_number,
    dispatch_id: disposition.dispatch_id ?? context?.dispatch_id,
    body_file: bodyFile,
    materialTexts,
    explicitDenyList: [],
    credential_gate_mode: materialTexts.length > 0 ? "full" : "shape-and-explicit-only",
  };
  if (disposition.action === "update" && disposition.target?.id != null) {
    payload.comment_id = disposition.target.id;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
  return `${JSON.stringify({ ...payload, digest }, null, 2)}\n`;
}

function pruneStaleCredentialGateSidecars(notesTmpDir, {
  keepGateBasename,
  keepResultBasename,
} = {}) {
  // TTL policy: delete sticky-credential-gate-*.json / sticky-write-result*.json older than 60m; keep current dispatch files.
  const TTL_MS = 60 * 60 * 1000;
  const now = Date.now();
  let names;
  try {
    names = readdirSync(notesTmpDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keepGateBasename || name === keepResultBasename) continue;
    if (
      !/^sticky-credential-gate-.+\.json$/.test(name)
      && !/^sticky-write-result.*\.json$/.test(name)
    ) {
      continue;
    }
    const full = path.join(notesTmpDir, name);
    try {
      const ageMs = now - statSync(full).mtimeMs;
      if (ageMs > TTL_MS) unlinkSync(full);
    } catch {
      // best-effort: prune failures MUST NOT fail render
    }
  }
}

function writeCredentialGateSidecarFiles(context, effectiveInput) {
  // Target State 4 / PRIM-F13: renderer source MUST carry credential_literal_rule
  // (the runner packet prefix embeds CREDENTIAL_LITERAL_RULE and the runner
  // gated write enforces it; the external prefix embeds
  // EXTERNAL_CREDENTIAL_LITERAL_RULE, where the gated writer is only an
  // accident guard and accept is the backstop — decisions D2/D3).
  if (!CREDENTIAL_LITERAL_RULE.startsWith("credential_literal_rule:")
    || !EXTERNAL_CREDENTIAL_LITERAL_RULE.startsWith("credential_literal_rule:")) {
    throw new Error("CREDENTIAL_LITERAL_RULE invariant broken");
  }
  const content = buildCredentialGateSidecarContent(context, effectiveInput);
  if (content === null) return null;
  const recipePath = resolveCredentialGateSidecarPath(undefined, context.dispatch_id);
  const notesTmpDir = path.dirname(recipePath);
  mkdirSync(notesTmpDir, { recursive: true });
  try {
    pruneStaleCredentialGateSidecars(notesTmpDir, {
      keepGateBasename: path.basename(recipePath),
      keepResultBasename: stickyWriteResultBasename(context.dispatch_id),
    });
  } catch {
    // best-effort
  }
  // notes/tmp recipe path is renderer-owned and may be rewritten on the same
  // dispatch when prepare + main both materialize the packet; use truncate write.
  writeFileSync(recipePath, content, { encoding: "utf8", mode: 0o600 });
  const carrierPath = path.join(
    path.dirname(context.observability_context_path),
    STICKY_CREDENTIAL_GATE_SIDECAR_BASENAME,
  );
  context.__credential_gate_sidecar_path = recipePath;
  context.__credential_gate_sidecar_carrier_path = carrierPath;
  context.__credential_gate_sidecar_content = content;
  return { recipePath, carrierPath, content };
}

function writeCredentialGateSidecarCarrierCopy(context) {
  const content = context?.__credential_gate_sidecar_content;
  const carrierPath = context?.__credential_gate_sidecar_carrier_path;
  if (typeof content !== "string" || typeof carrierPath !== "string") return null;
  // Must run only after the carrier root exists via ensureDurableDirectory
  // (best-effort 0o700 intent; win32 P1–P3 named alternative — do not mkdirSync
  // the carrier root here on non-win32 or mode asserts regress).
  writeFileSync(carrierPath, content, { encoding: "utf8", mode: 0o600 });
  return carrierPath;
}

function initialCarrierEntries(prepared, outputPath) {
  const context = prepared.context;
  const renderedAt = new Date().toISOString();
  const isExternal = context.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND;
  const {
    __paged_full_pages_carrier: _pagedFullPagesCarrier,
    __paged_full_pages_path: _pagedFullPagesPath,
    __changed_set_authority: _changedSetAuthority,
    __credential_gate_sidecar_path: _credentialGateSidecarPath,
    __credential_gate_sidecar_carrier_path: _credentialGateSidecarCarrierPath,
    __credential_gate_sidecar_content: _credentialGateSidecarContent,
    ...publishedContext
  } = context;
  const entries = [
    { role: "packet", path: path.resolve(outputPath), content: prepared.packet },
    {
      role: "observability-context",
      path: context.context_path,
      content: `${JSON.stringify(publishedContext, null, 2)}\n`,
    },
    {
      role: "heartbeat",
      path: context.heartbeat_path,
      content: `${JSON.stringify({
      status: isExternal ? "external_ticket_issued" : "packet_rendered",
      attempt_id: context.attempt_id,
      dispatch_id: context.dispatch_id,
      generated_at: renderedAt,
      reviewer_surface: context.reviewer_surface,
      runner_owner: context.runner_owner,
      next_owner: context.owner,
      }, null, 2)}\n`,
    },
    {
      role: "activity",
      path: context.activity_log_path,
      // D1: external tickets never spawn, so the activity carrier is written
      // atomically with both of its required events already present — there
      // is no later runner process to append `external_evaluator_ticket_issued`.
      content: isExternal
        ? [
          JSON.stringify({
            event: "packet_rendered",
            attempt_id: context.attempt_id,
            dispatch_id: context.dispatch_id,
            generated_at: renderedAt,
            reviewer_surface: context.reviewer_surface,
            runner_owner: context.runner_owner,
            packet_renderer: true,
          }),
          JSON.stringify({
            event: "external_evaluator_ticket_issued",
            attempt_id: context.attempt_id,
            dispatch_id: context.dispatch_id,
            generated_at: renderedAt,
            reviewer_surface: context.reviewer_surface,
            runner_owner: context.runner_owner,
            packet_renderer: true,
          }),
        ].join("\n") + "\n"
        : `${JSON.stringify({
        event: "packet_rendered",
        attempt_id: context.attempt_id,
        dispatch_id: context.dispatch_id,
        generated_at: renderedAt,
        reviewer_surface: context.reviewer_surface,
        runner_owner: context.runner_owner,
        packet_renderer: true,
        })}\n`,
    },
    { role: "stdout", path: context.stdout_log_path, content: "" },
    { role: "stderr", path: context.stderr_log_path, content: "" },
    {
      role: "cli-probe-result",
      path: context.cli_probe_result_path,
      content: isExternal
        ? `${JSON.stringify({
        status: "not-applicable",
        attempt_id: context.attempt_id,
        dispatch_id: context.dispatch_id,
        generated_at: renderedAt,
        result_owner: context.owner,
        }, null, 2)}\n`
        : `${JSON.stringify({
        status: "pending",
        attempt_id: context.attempt_id,
        dispatch_id: context.dispatch_id,
        generated_at: renderedAt,
        probe_script: context.reviewer_cli_recipe.probe_script,
        result_owner: context.owner,
        }, null, 2)}\n`,
    },
    ...(context.__paged_full_pages_carrier
      ? [{
          role: "paged-full-material",
          path: context.__paged_full_pages_path,
          content: `${JSON.stringify(context.__paged_full_pages_carrier)}\n`,
        }]
      : []),
  ];
  return entries.map((entry) => ({
    role: entry.role,
    path: path.resolve(entry.path),
    bytes: Buffer.from(entry.content, "utf8"),
  }));
}

function carrierManifest(entries) {
  return entries.map((entry) => ({
    role: entry.role,
    path: entry.path,
    byte_length: entry.bytes.length,
    sha256: sha256(entry.bytes),
  }));
}

function prepareSecondReviewContext(input, options = {}) {
  const reviewerFamilyDescriptor = options.reviewerFamilyDescriptor
    ?? resolveCanonicalReviewerFamily(input?.reviewer_family);
  if (options.prevalidated !== true) {
    assertValidHandoff(input);
  }
  const context = normalizeObservabilityContext(
    input,
    options.packetPath,
    allocateDispatchLineage(input, options.precomputedDispatchId),
    { ...options, reviewerFamilyDescriptor }
  );
  const errors = [];
  validateObservabilityContext(context, errors, input);
  if (errors.length > 0) {
    const error = new Error(errors.join("\n"));
    error.errors = errors;
    throw error;
  }
  // All four guards live in this window — after the context is validated, before any
  // carrier or dispatch reservation lands. Three of them (repo-containment, carrier
  // collision, leanness) derive their root set from the same
  // reviewerWritableRootsFromRecipe() derivation (three independent calls, one per guard);
  // that shared source is the design, not an accident: a re-added grant has to widen all
  // three at once or none. The fourth (canonical-carrier-root) does NOT call
  // reviewerWritableRootsFromRecipe() at all — it derives from the renderer's own
  // canonicalCarrierRoot + attempt_id instead, because what it protects against is not a
  // bad recipe grant but the renderer's own carrier placement drifting away from its own
  // root. What differs across all four is the second input each guard adds, and how
  // upstream its cause sits — repo-containment adds the two checkout roots (the recipe
  // itself is wrong, the most immediately-fixable cause), the canonical-carrier-root guard
  // adds the renderer's own placement invariant (a drift fixable by removing whatever
  // caused it), the collision guard adds the carrier paths (a TL input, fixable right now),
  // and the leanness guard adds the contents of the root (accumulated machine state,
  // fixable by a different action). They run in that order, so the most upstream cause is
  // the one reported rather than a downstream symptom of it: a recipe granting a
  // repo-internal root would otherwise surface as whatever that root happens to contain on
  // this machine.
  assertReviewerWritableRootOutsideRepo(context);
  assertCarriersUnderCanonicalCarrierRoot(context, options);
  assertCarriersOutsideReviewerWritableRoot(context);
  assertReviewerWritableRootIsLean(context);
  return context;
}

function decodeFullPrPatchProbeUtf8(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function parseFullPrRawGitFacts(bytes) {
  const text = decodeFullPrPatchProbeUtf8(bytes);
  if (text === null || text.length === 0 || !text.endsWith("\0")) return null;
  const fields = text.slice(0, -1).split("\0");
  const facts = [];
  for (let offset = 0; offset < fields.length;) {
    const metadata = fields[offset++];
    const match = metadata.match(
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ((?:[ADMTUXB]|[RC](?:100|0[0-9]{2})))$/u,
    );
    if (match === null) return null;
    const pathCount = match[5].startsWith("R") || match[5].startsWith("C") ? 2 : 1;
    if (offset + pathCount > fields.length) return null;
    const paths = fields.slice(offset, offset + pathCount);
    offset += pathCount;
    facts.push({
      path: paths[pathCount - 1],
      status: match[5],
      old_mode: match[1],
      new_mode: match[2],
      old_oid: match[3],
      new_oid: match[4],
    });
  }
  return facts.length > 0 ? facts : null;
}

function parseFullPrNumstat(bytes) {
  const text = decodeFullPrPatchProbeUtf8(bytes);
  if (text === null || text.length === 0 || !text.endsWith("\0")) return null;
  const fields = text.slice(0, -1).split("\0");
  const rows = [];
  for (let offset = 0; offset < fields.length;) {
    const match = fields[offset++].match(/^([^\t]+)\t([^\t]+)\t(.*)$/su);
    if (match === null) return null;
    let pathValue = match[3];
    if (pathValue === "") {
      if (offset + 2 > fields.length) return null;
      offset += 1;
      pathValue = fields[offset++];
    }
    rows.push({ path: pathValue, additions: match[1], deletions: match[2] });
  }
  return rows.length > 0 ? rows : null;
}

function deriveFullPrPatchGitFacts(authority, spawnSyncImpl) {
  const endpoints = [authority.comparison_base_sha, authority.head_sha, "--"];
  const rawResult = spawnSyncImpl("git", [
    "diff", "--raw", "-z", "--full-index", "--abbrev=40", ...SECOND_REVIEW_GIT_RENAME_COPY_FLAGS, ...endpoints,
  ], {
    cwd: SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
    encoding: "buffer",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: fullPrPatchFactsMaxBytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const numstatResult = spawnSyncImpl("git", [
    "diff", "--numstat", "-z", ...SECOND_REVIEW_GIT_RENAME_COPY_FLAGS, ...endpoints,
  ], {
    cwd: SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
    encoding: "buffer",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: fullPrPatchFactsMaxBytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (rawResult.status !== 0 || numstatResult.status !== 0) return null;
  const rawFacts = parseFullPrRawGitFacts(rawResult.stdout);
  const numstat = parseFullPrNumstat(numstatResult.stdout);
  if (rawFacts === null || numstat === null
    || new Set(rawFacts.map((fact) => fact.path)).size !== rawFacts.length
    || new Set(numstat.map((row) => row.path)).size !== numstat.length) return null;
  const numstatByPath = new Map(numstat.map((row) => [row.path, row]));
  if (rawFacts.length !== numstat.length || rawFacts.some((fact) => !numstatByPath.has(fact.path))) return null;
  return rawFacts.map((fact) => ({ ...fact, ...numstatByPath.get(fact.path) }));
}

function readFullPrGithubFileRows(input, spawnSyncImpl) {
  const response = spawnSyncImpl("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${input.repository_slug}/pulls/${input.review_scope.pull_request_number}/files?per_page=${fullPrPatchGithubRowsPerPage}`,
  ], {
    cwd: SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
    env: { ...process.env, GH_REPO: input.repository_slug },
    encoding: "utf8",
    timeout: SECOND_REVIEW_GH_PROBE_TIMEOUT_MS,
    maxBuffer: fullPrPatchGithubRowsMaxBytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (response.status !== 0) return null;
  let pages;
  try {
    pages = JSON.parse(String(response.stdout ?? ""));
  } catch {
    return null;
  }
  if (!Array.isArray(pages)
    || pages.length === 0
    || pages.length > fullPrPatchGithubMaxPages
    || pages.some((page) => !Array.isArray(page) || page.length > fullPrPatchGithubRowsPerPage)) return null;
  return pages.flat();
}

function readFullPrComparisonRefOids(input, spawnSyncImpl) {
  const response = spawnSyncImpl("gh", [
    "pr", "view", String(input.review_scope.pull_request_number),
    "--repo", input.repository_slug,
    "--json", "baseRefOid,headRefOid",
  ], {
    cwd: SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: SECOND_REVIEW_GH_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (response.status !== 0) return null;
  try {
    const resolved = JSON.parse(String(response.stdout ?? ""));
    if (typeof resolved?.baseRefOid !== "string" || typeof resolved?.headRefOid !== "string") return null;
    return { baseRefOid: resolved.baseRefOid, headRefOid: resolved.headRefOid };
  } catch {
    return null;
  }
}

function effectiveComparisonBaseSha(baseRefOid, headRefOid, spawnSyncImpl) {
  const mergeBaseResult = spawnSyncImpl("git", [
    "merge-base", "--all", baseRefOid, headRefOid,
  ], {
    cwd: SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (mergeBaseResult.status !== 0) return null;
  const mergeBases = String(mergeBaseResult.stdout ?? "").trimEnd().split("\n");
  if (mergeBases.length !== 1 || !/^[a-f0-9]{40}$/.test(mergeBases[0])) return null;
  return mergeBases[0];
}

function probeFullPrLivePatchCompleteness(input, { spawnSyncImpl = spawnSync } = {}) {
  try {
    const authority = deriveAuthoritativeChangedSet(input.review_scope, {
      repositorySlug: input.repository_slug,
      spawnSyncImpl,
    });
    if (authority === null) return { classification: "probe-fault", reason: "git-authority-unavailable" };
    const gitFacts = deriveFullPrPatchGitFacts(authority, spawnSyncImpl);
    if (gitFacts === null) return { classification: "probe-fault", reason: "git-facts-unavailable" };
    const githubRows = readFullPrGithubFileRows(input, spawnSyncImpl);
    if (githubRows === null) return { classification: "probe-fault", reason: "github-rows-unavailable" };
    // Re-read base+head after files pagination so a retarget / base force-update
    // between authority derivation and GitHub rows cannot keep the old comparison
    // base while rows describe a new one.
    const refsAfterRows = readFullPrComparisonRefOids(input, spawnSyncImpl);
    if (refsAfterRows === null) {
      return { classification: "probe-fault", reason: "comparison-refs-unavailable-after-rows" };
    }
    if (refsAfterRows.headRefOid !== authority.head_sha) {
      return { classification: "probe-fault", reason: "head-mismatch-after-rows" };
    }
    const comparisonAfterRows = effectiveComparisonBaseSha(
      refsAfterRows.baseRefOid,
      refsAfterRows.headRefOid,
      spawnSyncImpl,
    );
    if (comparisonAfterRows !== authority.comparison_base_sha) {
      return { classification: "probe-fault", reason: "base-mismatch-after-rows" };
    }
    return {
      ...classifyFullPrPatchCompleteness({
        authorityPaths: authority.paths,
        gitFacts,
        githubRows,
      }),
      authority,
    };
  } catch {
    return { classification: "probe-fault", reason: "probe-execution-failed" };
  }
}

function isCandidateV5Handoff(input) {
  return input?.mode === "pr-sticky"
    && input.review_material_carrier === "embedded-diff"
    && typeof input.review_material === "string"
    && Buffer.byteLength(input.review_material, "utf8") > SECOND_REVIEW_EMBEDDED_MAX_BYTES;
}

function sortedCanonicalChangedPaths(paths) {
  if (!Array.isArray(paths)
    || paths.length === 0
    || paths.some((entry) => typeof entry !== "string" || entry.length === 0)
    || new Set(paths).size !== paths.length) return null;
  return [...paths].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
}

function assertImmutableAuthorityClosure(input, authority) {
  if (!authority) {
    const error = new Error("review_material_scope_unresolvable: immutable Git scope is unavailable");
    error.classification = "review_material_scope_unresolvable";
    throw error;
  }
  const declared = sortedCanonicalChangedPaths(input.changed_files_or_touch_list);
  const material = changedPathsFromGitDiff(input.review_material);
  const materialPaths = sortedCanonicalChangedPaths(material);
  const authoritative = sortedCanonicalChangedPaths(authority.paths);
  const samePaths = (left, right) => left !== null
    && right !== null
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
  const sameRawBytes = Buffer.from(authority.raw_diff, "utf8")
    .equals(Buffer.from(input.review_material, "utf8"));
  if (!samePaths(authoritative, declared)
    || !samePaths(authoritative, materialPaths)
    || !sameRawBytes) {
    const error = new Error("review_material_full_closure_invalid: immutable A, declared D, and raw material M differ");
    error.classification = "review_material_full_closure_invalid";
    throw error;
  }
  return authority;
}

function assertCandidateV5ImmutableClosure(input, existingAuthority = null) {
  if (!isCandidateV5Handoff(input)) return null;
  const authority = existingAuthority ?? deriveAuthoritativeChangedSet(input.review_scope, {
    repositorySlug: input.repository_slug,
  });
  return assertImmutableAuthorityClosure(input, authority);
}

function isFullPrLivePatchProbeCandidate(input) {
  return input?.mode === "pr-sticky"
    && input.review_scope?.kind === "full-pr"
    && input.review_material_carrier === "adapter-live-pr-reads";
}

export function resolveSecondReviewEffectiveInput(input, options = {}) {
  if (!isFullPrLivePatchProbeCandidate(input)) {
    return { effective_input: input, probe: null, authority: null };
  }
  const probe = (options.livePatchProbe ?? probeFullPrLivePatchCompleteness)(input, {
    spawnSyncImpl: options.spawnSyncImpl ?? spawnSync,
  });
  if (probe?.classification === "probe-fault") {
    const error = new Error(
      `review_material_scope_unresolvable: full-PR patch probe failed (${probe.reason ?? "unknown"})`,
    );
    error.classification = "review_material_scope_unresolvable";
    throw error;
  }
  if ((probe?.classification !== "live-patch-complete"
      && probe?.classification !== "expected-text-patch-missing")
    || probe.authority === null
    || typeof probe.authority !== "object") {
    const error = new Error("review_material_scope_unresolvable: full-PR patch probe result is invalid");
    error.classification = "review_material_scope_unresolvable";
    throw error;
  }
  if (probe.classification === "live-patch-complete") {
    // Live fast-path keeps the caller handoff, but only after caller D equals
    // immutable authority A. Checking before the synthetic A=D=M rewrite avoids
    // returning a live route when the caller declaration disagrees with probe A.
    const declared = sortedCanonicalChangedPaths(input.changed_files_or_touch_list);
    const authoritative = sortedCanonicalChangedPaths(probe.authority.paths);
    if (declared === null
      || authoritative === null
      || declared.length !== authoritative.length
      || !declared.every((entry, index) => entry === authoritative[index])) {
      const error = new Error(
        "review_material_full_closure_invalid: caller declared D and immutable authority A differ",
      );
      error.classification = "review_material_full_closure_invalid";
      throw error;
    }
    return { effective_input: input, probe, authority: probe.authority };
  }
  const authorityInput = {
    ...input,
    changed_files_or_touch_list: [...probe.authority.paths],
    review_material_carrier: "embedded-diff",
    review_material_capability: "scope-bound-embedded-complete-diff-v1",
    review_material_proof: canonicalEmbeddedReviewMaterialProof(input.review_scope, probe.authority.raw_diff),
    review_material: probe.authority.raw_diff,
  };
  assertImmutableAuthorityClosure(authorityInput, probe.authority);
  return { effective_input: authorityInput, probe, authority: probe.authority };
}

// D6/R2 (revised 2026-08-31, TL decision): CHECK ONLY, no write. pr-sticky
// only; `attempt` values that count toward the round cap are `initial` and
// `focused-sticky-refresh` (fault-recovery and proven page-window-continue are
// exempt). Fail-closed (`review_round_budget_exhausted`) throws before any of
// the more expensive validation/build work below runs. The durable sidecar
// write is deferred to `recordReviewRoundBudgetDispatch` after reservation
// succeeds — N4 "先記後派". Check and record MUST share
// `buildPageWindowHandoffFromCarrier` so proven continue is reachable at cap.
/**
 * Build the page-window handoff proof object shared by check + record so
 * evaluateReviewRoundBudget and recordReviewRoundDispatch resolve the same
 * attempt kind / counting polarity. Carrier may be handoff input (pre-packet)
 * or prepared context (post-packet); both use page_window_* fields.
 */
export function buildPageWindowHandoffFromCarrier(carrier) {
  if (!carrier || carrier.page_window_checkpoint_handoff !== true) return null;
  const headRefOid = typeof carrier.head_ref_oid === "string" ? carrier.head_ref_oid : "";
  const windowIndex = Number(carrier.page_window_index);
  return {
    page_window_checkpoint_handoff: true,
    head_ref_oid: headRefOid,
    window_index: Number.isSafeInteger(windowIndex) && windowIndex >= 1 ? windowIndex : 1,
  };
}

export function checkReviewRoundBudget(input, { env } = {}) {
  if (input?.mode !== "pr-sticky") return null;
  return evaluateReviewRoundBudget({
    cwd: process.cwd(),
    prNumber: prNumberFromTarget(input.target),
    repositorySlug: input.repository_slug,
    attempt: input.attempt,
    env: env ?? process.env,
    headRefOid: typeof input.head_ref_oid === "string" ? input.head_ref_oid : "",
    pageWindowHandoff: buildPageWindowHandoffFromCarrier(input),
  });
}

// Companion to checkReviewRoundBudget: the actual durable write, called from
// main() once reservation has succeeded (see call sites in
// bindPendingPostPrCompletionMarker / main()'s no-marker branch). `override`
// MUST be the same value `checkReviewRoundBudget` returned — not
// re-derived — so the audit trail records exactly what authorized this
// dispatch. Failure throws `review_round_state_write_failed`; callers MUST
// let that abort the publication transaction so the packet is never
// delivered on a round the sidecar never actually recorded.
function recordReviewRoundBudgetDispatch(context, roundBudget, { attempt, reviewScope } = {}) {
  if (context.mode !== "pr-sticky") return null;
  return recordReviewRoundDispatchImpl({
    cwd: process.cwd(),
    prNumber: context.pr_number,
    repositorySlug: context.repository_slug,
    attempt,
    dispatchId: context.dispatch_id,
    headRefOid: context.head_ref_oid,
    reviewScope,
    override: roundBudget?.override ?? null,
    pageWindowHandoff: buildPageWindowHandoffFromCarrier(context),
  });
}

// D10/D2 (fix-second-review-loop-friction): pre-dispatch cost-circuit-breaker
// check. Unlike checkReviewRoundBudget (pr-sticky only), this runs for BOTH
// modes — thresholds (a)(b)(c) are session-cost signals independent of
// dispatch mode. `change_name` degrades gracefully (missing/malformed/
// folder-nonexistent — D12 F-5-5/F-6-3, unified: all three resolve (a)(b)(c)
// to `unavailable`, never a block) via resolveChangeCostUsage returning
// `undefined`, which evaluateCostBudget's own `usage?.totals ?? {}` default
// plus evaluateNumericThreshold's Number.isFinite guard (task 4) already
// handle — this function does not re-implement that fail-open logic.
//
// D1/D2: the renderer has no blocking cost threshold at all any more. Pr-
// sticky round extension has exactly one authorization — the round gate's
// own `DEVPRO_REVIEW_ROUND_OVERRIDE=<PR#>:<n>` (checkReviewRoundBudget, which
// runs before this and is the sole gate at the round cap). This function
// never throws; it only reports. `DEVPRO_COST_BUDGET_OVERRIDE` is not read
// here at all — there is nothing left for it to unlock on this lane.
function reportCostBudgetAdvisory(input, { env } = {}) {
  const resolvedEnv = env ?? process.env;
  const usage = resolveChangeCostUsage({
    changeName: input?.change_name,
    cwd: process.cwd(),
    env: resolvedEnv,
  });
  const budget = evaluateCostBudget({ usage });
  // D14, "閘走了、話還在": the gate is gone, the message is not. Every
  // exceeded threshold is still named verbatim so demoting the totals to
  // advisory never costs a reader the number that made them look.
  if (budget.exceeded_thresholds.length > 0) {
    console.error(
      `cost_budget_advisory: ${budget.exceeded_thresholds.join(", ")} threshold(s) exceeded for this change (advisory only; the second-review renderer has no blocking cost threshold)`,
    );
  }
  return budget;
}

// D6/D7/D9 (fix-second-review-loop-friction, T6): plan the round-override
// disclosure write. Called from prepareSecondReviewRender immediately after
// checkReviewRoundBudget, and ONLY when roundBudget.override != null (a round
// override was actually consumed this turn — D6). Every predictable failure
// below is checked and thrown HERE, before any packet artifact exists (before
// writeCredentialGateSidecarFiles / buildSecondReviewPacket / reservation), so
// a failure on this path never produces a stray sidecar file, dispatch
// reservation, or delivered packet. The actual durable write happens later,
// inside main()'s shared recordRound closure (appendRoundOverrideDisclosure),
// after recordReviewRoundBudgetDispatch has durably recorded the round (D6's
// "record first, then disclose" ordering — K3).
//
// Returns `{ action: "write", changeName, sessionId, headRefOid, at }`,
// `{ action: "advisory", reason, readerName, liveHeadRefName }` (F-2-1
// accepted residual — nothing will be written), or is never called at all
// when `roundBudget.override` is null (checked by the caller, not here).
function planRoundOverrideDisclosure(input, { env, spawnSyncImpl = spawnSync } = {}) {
  const headRefOid = typeof input?.head_ref_oid === "string" ? input.head_ref_oid : "";
  if (!/^[0-9a-f]{40}$/.test(headRefOid)) {
    const error = new Error(
      "review_round_override_disclosure_head_ref_oid_invalid: head_ref_oid must be a 40-character lowercase "
      + "hex sha to disclose a consumed round override (otherwise the written checkpoint entry could never be "
      + "matched by the PR body's `head_ref_oid=` line)"
    );
    error.classification = "review_round_override_disclosure_head_ref_oid_invalid";
    throw error;
  }

  // D7 point 1: only a LIVE GitHub headRefName counts on this path. The handoff
  // pr_head_ref_name is NOT accepted as a fallback here — it may be stale or
  // forged and would route the disclosure write to a checkpoint the reader
  // (the PR's actual head branch) never looks at (F-1-1).
  const resolved = resolvePrHeadRefName(input, { spawnSyncImpl });
  if (resolved === null || !['gh','mcp'].includes(resolved.source)) {
    const error = new Error(
      "review_round_override_disclosure_head_ref_unresolved: cannot resolve the live PR head branch "
      + "(gh or the bound reviewer transport); restore gh access or the bound transport to consume a round override — the handoff "
      + "pr_head_ref_name is not accepted on this path"
    );
    error.classification = "review_round_override_disclosure_head_ref_unresolved";
    throw error;
  }
  const liveHeadRefName = resolved.headRefName;

  // D7 point 2: byte-identical to evaluateOverrideDisclosure's own read-side
  // predicate (post-pr-cost-circuit-breaker.mjs), so the write side and the
  // read side always agree on which checkpoint file this is.
  const readerName = deriveChangeNameFromBranch(liveHeadRefName);
  const readerReads = CHANGE_NAME_GRAMMAR.test(readerName)
    && changeNameFolderExists({ changeName: readerName, cwd: process.cwd() });

  // D7 point 3: handoff change_name is an assertion against the verified
  // reader name, never an independent routing choice — checked regardless of
  // readerReads, and before any write.
  const handoffName = typeof input?.change_name === "string" && input.change_name.trim().length > 0
    ? input.change_name.trim()
    : null;
  if (handoffName !== null && handoffName !== readerName) {
    const error = new Error(
      `review_round_override_disclosure_change_conflict: handoff change_name (${handoffName}) does not equal `
      + `the verified PR head's change (${readerName})`
    );
    error.classification = "review_round_override_disclosure_change_conflict";
    throw error;
  }

  if (!readerReads) {
    // D7 point 4 / F-2-1 accepted residual: no active, or not exactly one
    // archive, change folder for the PR's actual head branch. This
    // consumption will not be disclosed; evaluateOverrideDisclosure degrades
    // to `unavailable` for the identical branch/name for the identical
    // reason, so an `N/A` PR body still passes there. Printed now (nothing
    // will be written later), not deferred to the write step.
    console.error(
      `review_round_override_disclosure_advisory: no resolvable change folder for the PR head branch `
      + `(${liveHeadRefName}); this round override consumption will not be disclosed (accepted residual, `
      + "design.md D7/F-2-1)"
    );
    return { action: "advisory", reason: "reader_does_not_read", readerName, liveHeadRefName };
  }

  // D6: resolve the checkpoint path now — this ONLY resolves a path, it does
  // not touch the checkpoint file or its containing directory at all
  // (no mkdir/writeFile/access against it), so it cannot detect, and does not
  // throw for, an unwritable state dir. An unwritable dir's failure surfaces
  // only later, at the actual append inside the shared recordRound closure —
  // AFTER the round has already been durably recorded in the sidecar (K3: the
  // write failure burns the round, it does not preflight it).
  changeUsageCheckpointPath({ cwd: process.cwd(), changeName: readerName });

  // D9: a session that cannot be resolved does not block; the write below
  // still proceeds with session_id: null (appendRoundOverrideDisclosure
  // prints the D9 advisory once the write actually succeeds).
  const session = captureTlHostSession(env ?? process.env);
  return {
    action: "write",
    changeName: readerName,
    sessionId: session?.session_id ?? null,
    headRefOid,
    at: new Date().toISOString(),
  };
}

// Companion to planRoundOverrideDisclosure: the actual durable write, called
// from main()'s shared recordRound closure AFTER recordReviewRoundBudgetDispatch
// has succeeded (D6's ordering: record the round, then disclose the override
// that authorized it, both inside the same publication transaction, before
// carriers are published — the SAME closure covers both the no-marker and
// marker-bound branches, per D6's "两條分支共用同一 closure"). `plan` MUST be
// the exact object planRoundOverrideDisclosure already returned in
// prepareSecondReviewRender — not re-derived — so this step never re-resolves
// gh or re-decides the D7 judgment a second time. A no-op for a `null` or
// `"advisory"` plan (nothing to write). Any failure throws
// `review_round_override_disclosure_write_failed` and MUST abort the
// publication transaction — the round is already burned in the sidecar (K3,
// D10), so the thrown message tells the caller to retry with the override's
// `n` incremented by one.
function appendRoundOverrideDisclosure(plan) {
  if (!plan || plan.action !== "write") return;
  let result;
  try {
    result = appendChangeUsageOverride({
      cwd: process.cwd(),
      changeName: plan.changeName,
      session_id: plan.sessionId,
      at: plan.at,
      thresholds: ["review_round"],
      head_ref_oid: plan.headRefOid,
    });
  } catch (error) {
    const wrapped = new Error(
      `review_round_override_disclosure_write_failed: could not disclose the consumed round override for `
      + `${plan.changeName} (${error.message}); this round is already recorded in the review-round sidecar — `
      + "retry with DEVPRO_REVIEW_ROUND_OVERRIDE's n incremented by one"
    );
    wrapped.classification = "review_round_override_disclosure_write_failed";
    throw wrapped;
  }
  if (result?.status !== "written") {
    const error = new Error(
      `review_round_override_disclosure_write_failed: could not disclose the consumed round override for `
      + `${plan.changeName} (${result?.reason ?? "unknown"}); this round is already recorded in the `
      + "review-round sidecar — retry with DEVPRO_REVIEW_ROUND_OVERRIDE's n incremented by one"
    );
    error.classification = "review_round_override_disclosure_write_failed";
    throw error;
  }
  if (!plan.sessionId) {
    console.error(
      "review_round_override_disclosure_advisory: session_unresolvable; entry recorded without session attribution"
    );
  }
}

// R5/D6 (revised 2026-08-31, TL decision): a prior REVIEWED baseline is
// evidenced ONLY by a READY sticky (verdict PASS or WARN, a well-formed body
// per parseSecondReviewStickyAuthorityBody) carrying a parseable
// `last_reviewed_sha`, resolved from the SAME complete issue-comments
// snapshot (`input.sticky_authority_snapshot`) the renderer already uses to
// resolve `sticky_write_disposition` — NOT the round-budget sidecar's
// dispatch_lineage. A non-empty sidecar lineage without any sticky
// (fault-recovery re-dispatch, or a first round whose reviewer never wrote a
// sticky) proves nothing was ever reviewed: there is no commit-range
// starting point to narrow to, so full-pr remains the only legal scope and
// this MUST NOT block it. `attempt: fault-recovery` and `mode: audit-only`
// are unconditionally exempt.
function resolveReadyStickyBaseline(input) {
  const snapshot = input?.sticky_authority_snapshot;
  // F-a7d411193b52: missing snapshot MUST surface a typed code, not a generic
  // disposition/shape failure buried in resolveSecondReviewStickyWriteDisposition.
  if (snapshot === undefined || snapshot === null) {
    const error = new Error(
      "sticky_authority_snapshot_required: resolveReadyStickyBaseline needs sticky_authority_snapshot"
    );
    error.classification = "sticky_authority_snapshot_required";
    throw error;
  }
  return resolveReadyStickyBaselineFromSnapshot(snapshot);
}

function assertReviewScopeMinimality(input) {
  if (input?.mode !== "pr-sticky") return;
  if (input?.attempt === "fault-recovery") return;
  if (input?.review_scope?.kind !== "full-pr") return;
  if (resolveReadyStickyBaseline(input) === null) return;
  if (typeof input?.full_scope_reason === "string" && /^[\x20-\x7e]{8,200}$/.test(input.full_scope_reason)) {
    return;
  }
  const error = new Error(
    "review_scope_not_minimal: pr-sticky review_scope=full-pr requires full_scope_reason once a prior "
    + "READY sticky (verdict PASS/WARN) with last_reviewed_sha exists for this PR; narrow review_scope to "
    + "commit-range or provide full_scope_reason"
  );
  error.classification = "review_scope_not_minimal";
  throw error;
}

// R7/D6: advisory only — never throws. Signals a widened diff (touching the
// review-loop's own machinery under .devpro/scripts/hooks/**) that the
// handoff's own scope_summary/target text doesn't call out, so a human/
// reviewer can confirm the expansion is intentional. Uses the same predicate
// the packet's own static-prefix bullet is derived from (validate-second-
// review-packet.mjs) so this returned signal and the packet's embedded
// bullet never disagree for the common (non-V5-authority-override) case.
function assertReviewScopeDrift(input) {
  if (input?.mode !== "pr-sticky") return { drift: false };
  return { drift: reviewScopeDriftAdvisoryFromData(input) };
}

function prepareSecondReviewRender(input, options = {}) {
  const reviewerFamilyDescriptor = resolveCanonicalReviewerFamily(input?.reviewer_family);
  assertValidHandoff(input);
  const roundBudget = checkReviewRoundBudget(input, { env: options.env });
  // D6: only planned when an override was actually consumed this turn; every
  // fail-closed check inside runs before any packet artifact is produced.
  const roundOverrideDisclosurePlan = roundBudget?.override != null
    ? planRoundOverrideDisclosure(input, { env: options.env, spawnSyncImpl: options.spawnSyncImpl })
    : null;
  reportCostBudgetAdvisory(input, { env: options.env });
  assertReviewScopeMinimality(input);
  const scopeDrift = assertReviewScopeDrift(input);
  const resolved = resolveSecondReviewEffectiveInput(input, options);
  const effectiveInput = resolved.effective_input;
  if (effectiveInput !== input) assertValidHandoff(effectiveInput);
  const authority = assertCandidateV5ImmutableClosure(effectiveInput, resolved.authority);
  const precomputedDispatchId = input?.mode === "pr-sticky" ? `dispatch-${randomUUID()}` : undefined;
  const context = prepareSecondReviewContext(effectiveInput, {
    ...options,
    prevalidated: true,
    reviewerFamilyDescriptor,
    precomputedDispatchId,
  });
  assertOperatorDisposedSuccessorScope(context, effectiveInput);
  if (authority !== null) context.__changed_set_authority = authority;
  writeCredentialGateSidecarFiles(context, effectiveInput);
  const packet = buildSecondReviewPacket(effectiveInput, context);
  if (context.page_window_checkpoint_handoff === true) {
    context.reviewer_cli_recipe = selectReviewerCliRecipe(effectiveInput, context.neutral_cwd_path, {
      reviewer_model_selection: context.reviewer_model_selection,
      reviewer_opencode: context.reviewer_opencode,
      page_window_checkpoint_handoff: true,
      selected_effort: context.claude_selected_effort,
    });
  }
  assertValidPacket(packet, resolveDeclaredPageWindowMaxPages(context.page_window_max_pages));
  return {
    context,
    packet,
    effective_input: effectiveInput,
    advisories: scopeDrift.drift ? ["review_scope_drift"] : [],
    // Consumed by main() to record the round AFTER dispatch reservation
    // succeeds — see checkReviewRoundBudget/recordReviewRoundBudgetDispatch.
    review_round_budget: roundBudget,
    // Consumed by main()'s shared recordRound closure, after the round is
    // durably recorded — see planRoundOverrideDisclosure/appendRoundOverrideDisclosure.
    round_override_disclosure_plan: roundOverrideDisclosurePlan,
  };
}

function assertOperatorDisposedSuccessorScope(context, input) {
  if (context.mode !== "pr-sticky" || context.previous_dispatch_id === null) return;
  const baseline = input.sticky_authority_snapshot ? resolveReadyStickyBaseline(input) : null;
  const visited = new Set();
  let cursor = context.previous_dispatch_id;
  while (cursor !== null) {
    if (visited.has(cursor) || visited.size >= controlEvidenceHelper.MAX_DISPATCHES_PER_PR_LINEAGE) {
      throw new Error("operator disposition scope lineage is cyclic or exceeds its bound");
    }
    visited.add(cursor);
    const prior = controlEvidenceHelper.readDispatchEvidenceStrict({ rootDir: context.control_evidence_root, dispatchId: cursor });
    // Reservation/publication still enforces missing predecessors. This scope
    // check does not impose local receipts on an ordinary remote review.
    if (!prior.dispatch) return;
    if (prior.operatorDisposition) {
      if (input.review_scope?.kind !== "full-pr") throw new Error("operator-disposed predecessor requires a fresh full-pr review from its first window");
      return;
    }
    // A failed attempt is not coverage. Only a verified completion or the
    // canonical READY sticky for that exact successor discharges the duty.
    const completion = prior.completion;
    if ((completion && ["PASS", "WARN"].includes(completion.sticky_verdict)
      && completion.sticky_dispatch_id === cursor && completion.sticky_last_reviewed_sha === prior.dispatch.head_ref_oid)
      || (baseline?.dispatch_id === cursor && baseline.last_reviewed_sha === prior.dispatch.head_ref_oid)) return;
    cursor = prior.dispatch.previous_dispatch_id;
  }
}

// Validate after ALL marker adoption/rebinding paths have finalized predecessor.
export async function planPendingPostPrCompletionMarkerBinding(context, input) {
  const plan = await planPendingPostPrCompletionMarkerBindingUnchecked(context, input);
  assertOperatorDisposedSuccessorScope(context, input);
  return plan;
}

async function planPendingPostPrCompletionMarkerBindingUnchecked(context, input) {
  if (context.mode !== "pr-sticky") return { type: "none" };
  const postPrCompletionState = await import(pathToFileURL(postPrCompletionStatePath).href);
  // Only this repository's marker of the PR is a candidate; another repository's PR of the same number is skipped. A
  // candidate that cannot be told to be this repository's, or a file that may be this PR's marker but cannot be read,
  // stops the render instead of counting as absent (fix-post-pr-state-repo-keys; one decision with the merge gate).
  let markers;
  try {
    markers = postPrCompletionState.postPrMarkersOfPr({ cwd: process.cwd(), prNumber: context.pr_number, repo: context.repository_slug });
  } catch (error) {
    throw new Error(`reviewer_dispatch_identity_collision: pending ${error?.message || "post-PR marker state cannot be read"}`);
  }
  if (markers.length === 0) return { type: "none" };
  const marker = markers[0];
  if (marker.expected_dispatch_id && marker.head_ref_oid !== context.head_ref_oid) {
    if (marker.repository_slug !== context.repository_slug
      || String(marker.prNumber || "") !== context.pr_number
      || !/^[a-f0-9]{40}$/i.test(String(marker.head_ref_oid || ""))
      || !/^[a-f0-9]{40}$/i.test(context.head_ref_oid)) {
      throw new Error("reviewer_dispatch_identity_collision: pending post-PR marker head binding is invalid");
    }
    const ancestry = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", marker.head_ref_oid, context.head_ref_oid],
      { cwd: repoRoot, stdio: "ignore" }
    );
    if (ancestry.status === 1) {
      const priorClosureDigest = assertPriorDispatchIsClosed(context, marker);
      assertAuthoritativePrHead(context);
      // Same predecessor rule as the verified fast-forward branch below: a handoff that states
      // a predecessor is asserting lineage, and the approved route must not overwrite it.
      if (context.previous_dispatch_id !== null
        && context.previous_dispatch_id !== marker.expected_dispatch_id) {
        throw new Error("reviewer_dispatch_identity_collision: handoff predecessor does not match the prior-head marker dispatch");
      }
      const sourceState = marker.lineage_clear_obligation ? "clear-obligation" : "dispatch-marker";
      let approval;
      try {
        approval = resolveSecondReviewLineageApproval({
          repositorySlug: context.repository_slug,
          prNumber: context.pr_number,
          sourceState,
          oldHead: marker.head_ref_oid,
          newHead: context.head_ref_oid,
          oldDispatchId: marker.expected_dispatch_id,
          action: ["rebind", "clear"],
          consumedCommentIds: controlEvidenceHelper.listConsumedLineageApprovalIds({
            rootDir: context.control_evidence_root,
          }),
        });
      } catch {
        throw new Error("reviewer_dispatch_identity_collision: no unique exact lineage approval is available");
      }
      controlEvidenceHelper.assertLineageApprovalNotConsumed({
        rootDir: context.control_evidence_root,
        approvalCommentId: approval.receipt.approval_comment_id,
      });
      const snapshot = input?.sticky_authority_snapshot;
      if (!snapshot || snapshot.completeness?.status !== "complete"
        || snapshot.completeness?.pagination_exhausted !== true
        || snapshot.query_error !== null
        || !Array.isArray(snapshot.comments)) {
        throw new Error("reviewer_dispatch_identity_collision: old sticky snapshot is incomplete");
      }
      const sticky = selectExactSecondReviewStickyAuthority(approval.comments);
      if (sticky.status !== "selected") {
        throw new Error("reviewer_dispatch_identity_collision: old sticky authority is not unique");
      }
      const parsedSticky = parseSecondReviewStickyAuthorityBody(sticky.authority.body);
      if (parsedSticky.status !== "valid"
        || parsedSticky.last_reviewed_sha?.toLowerCase() !== marker.head_ref_oid.toLowerCase()
        || parsedSticky.dispatch_id !== marker.expected_dispatch_id
        || !["WARN", "CRITICAL", "UNAVAILABLE"].includes(parsedSticky.verdict)) {
        throw new Error("reviewer_dispatch_identity_collision: old sticky is missing, passing, unknown, or not bound to the old dispatch");
      }
      const oldStickyAuthorityDigest = sha256(Buffer.from(JSON.stringify(sticky.authority), "utf8"));
      context.previous_dispatch_id = marker.expected_dispatch_id;
      context.lineage_approval_receipt = approval.receipt;
      return {
        type: approval.receipt.action === "clear"
          ? "approved-non-fast-forward-clear"
          : "approved-non-fast-forward-rebind",
        sourceState,
        state: postPrCompletionState,
        marker,
        approval,
        oldStickyAuthorityDigest,
        priorClosureDigest,
      };
    }
    if (ancestry.status !== 0) {
      throw new Error("reviewer_dispatch_identity_collision: pending post-PR marker head transition is not a verified fast-forward");
    }
    const priorClosureDigest = assertPriorDispatchIsClosed(context, marker);
    if (context.previous_dispatch_id !== null
      && context.previous_dispatch_id !== marker.expected_dispatch_id) {
      throw new Error("reviewer_dispatch_identity_collision: handoff predecessor does not match the prior-head marker dispatch");
    }
    context.previous_dispatch_id = marker.expected_dispatch_id;
    return {
      type: "verified-fast-forward-head",
      state: postPrCompletionState,
      marker,
      priorClosureDigest,
    };
  }
  // The same-head path used to return here unconditionally, so a handoff that merely
  // omitted previous_dispatch_id reached the CAS with an expectation of "" against a
  // marker already bound to some other dispatch. The CAS correctly refused, but only
  // after the publication transaction had been made durable — which left an envelope
  // that no later render could linearize. Adopt first (a missing predecessor is only
  // adoptable once the marker's dispatch is closed), then pre-filter through the exact
  // predicate the CAS applies. The order is not interchangeable: pre-filtering first
  // would compare "" and always lose, making adoption unreachable.
  // Only the omitted-predecessor case is checked for closedness. A handoff that states
  // its predecessor is asserting lineage it already knows; adopting one is an inference
  // this code makes on the handoff's behalf, and an inference has to clear a higher bar.
  if (marker.expected_dispatch_id && context.previous_dispatch_id === null) {
    assertPriorDispatchIsClosed(context, marker);
    context.previous_dispatch_id = marker.expected_dispatch_id;
  }
  if (!postPrCompletionState.markerIdentityCanAdvance(marker, {
    repositorySlug: context.repository_slug,
    prNumber: context.pr_number,
    headRefOid: context.head_ref_oid,
    expectedDispatchId: context.previous_dispatch_id ?? "",
  })) {
    throw new Error("reviewer_dispatch_identity_collision: handoff predecessor cannot advance the pending post-PR marker");
  }
  return {
    type: "same-head",
    state: postPrCompletionState,
    marker,
  };
}

// Shared by both binding paths: a marker may only hand its dispatch over once that
// dispatch is exactly bound and closed or explicitly operator-disposed.
function assertPriorDispatchIsClosed(context, marker) {
  const priorEvidence = controlEvidenceHelper.readDispatchEvidenceStrict({
    rootDir: context.control_evidence_root,
    dispatchId: marker.expected_dispatch_id,
  });
  const priorDispatch = priorEvidence.dispatch;
  if (!priorDispatch
    || priorDispatch.repository_slug !== marker.repository_slug
    || priorDispatch.pr_number !== String(marker.prNumber || "")
    || priorDispatch.head_ref_oid !== marker.head_ref_oid
    || priorDispatch.dispatch_id !== marker.expected_dispatch_id) {
    throw new Error("reviewer_dispatch_identity_collision: pending post-PR marker prior dispatch binding is invalid");
  }
  if (!priorEvidence.consumption && !priorEvidence.completion && !priorEvidence.terminal && !priorEvidence.operatorDisposition) {
    throw new Error(`reviewer_dispatch_identity_collision: prior-head dispatch must have a terminal fault consumed by the post-PR gate, a successful completion receipt, or a closed terminal receipt; ${controlEvidenceHelper.interruptedDispatchRecoveryHint(priorDispatch.attempt_id)}`);
  }
  return sha256(Buffer.from(JSON.stringify({
    dispatch: priorEvidence.dispatch,
    invocationClaim: priorEvidence.invocationClaim,
    completion: priorEvidence.completion,
    terminal: priorEvidence.terminal,
    capsule: priorEvidence.capsule,
    consumption: priorEvidence.consumption,
    externalClosure: priorEvidence.externalClosure,
    operatorDisposition: priorEvidence.operatorDisposition,
  }), "utf8"));
}

function assertAuthoritativePrHead(context) {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "view",
      context.pr_number,
      "--repo",
      context.repository_slug,
      "--json",
      "headRefOid",
      "--jq",
      ".headRefOid",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const authoritativeHead = String(result.stdout ?? "").trim();
  if (result.status !== 0
    || !/^[a-f0-9]{40}$/i.test(authoritativeHead)
    || authoritativeHead !== context.head_ref_oid) {
    throw new Error("reviewer_dispatch_identity_collision: requested successor is not the authoritative current PR head");
  }
}

// The dispatch record no longer carries absolute carrier paths, so the manifest is
// bound to its reservation through the carrier-root digest plus the renderer-owned
// sidecar file names. The packet basename stays free because the TL chooses it.
const canonicalCarrierBasenames = new Map([
  ["observability-context", observabilityContextFileName],
  ["heartbeat", observabilityHeartbeatFileName],
  ["activity", observabilityActivityFileName],
  ["stdout", observabilityStdoutFileName],
  ["stderr", observabilityStderrFileName],
  ["cli-probe-result", observabilityCliProbeFileName],
  ["paged-full-material", PAGED_FULL_PAGES_CARRIER_BASENAME],
]);

// The pruner owns cleanup for the carrier root, so its classifier must recognise every
// file name the renderer can drop there. Exported so the pruner's test iterates this
// list rather than a restated copy that would silently drift as carriers are added.
export const rendererOwnedCarrierFileNames = [
  ...canonicalCarrierBasenames.values(),
  REVIEW_SCOPE_PROBE_RESULT_FILE,
];

function carrierMatchesReservation(record, carrier) {
  const expectedBasename = canonicalCarrierBasenames.get(carrier.role);
  if (expectedBasename !== undefined && path.basename(carrier.path) !== expectedBasename) {
    return false;
  }
  return sha256(Buffer.from(path.dirname(carrier.path), "utf8")) === record.carrier_root_id;
}

function assertPublicationTransaction(transaction, expectedControlEvidenceRoot = null) {
  const exactFields = [
    "schema",
    "publication_mode",
    "control_evidence_root",
    "repository_slug",
    "pr_number",
    "marker_file",
    "expected_repository_slug",
    "expected_head_ref_oid",
    "expected_dispatch_id",
    "next_head_ref_oid",
    "next_dispatch_id",
    "reservation",
    "carriers",
    "created_carriers",
    "pending_carrier",
  ];
  if (!transaction
    || typeof transaction !== "object"
    || Array.isArray(transaction)
    || JSON.stringify(Object.keys(transaction).sort()) !== JSON.stringify([...exactFields].sort())
    || transaction.schema !== publicationTransactionSchema
    || !new Set(["marker-bound", "standalone"]).has(transaction.publication_mode)
    || !path.isAbsolute(String(transaction.control_evidence_root || ""))
    || (expectedControlEvidenceRoot !== null
      && transaction.control_evidence_root !== path.resolve(expectedControlEvidenceRoot))
    || !transaction.repository_slug
    || !transaction.pr_number
    || typeof transaction.next_head_ref_oid !== "string"
    || transaction.next_head_ref_oid.length === 0
    || !transaction.next_dispatch_id
    || !transaction.reservation) {
    throw new Error("publication transaction identity is invalid");
  }
  const record = transaction.reservation;
  controlEvidenceHelper.assertSecondReviewDispatchRecord(record);
  if (record.repository_slug !== transaction.repository_slug
    || record.pr_number !== transaction.pr_number
    || record.head_ref_oid !== transaction.next_head_ref_oid
    || record.dispatch_id !== transaction.next_dispatch_id) {
    throw new Error("publication transaction reservation binding is invalid");
  }
  if (transaction.publication_mode === "marker-bound") {
    if (!path.isAbsolute(String(transaction.marker_file || ""))
      || !/^[a-f0-9]{40}$/i.test(transaction.next_head_ref_oid)
      || typeof transaction.expected_repository_slug !== "string"
      || (transaction.expected_head_ref_oid !== ""
        && !/^[a-f0-9]{40}$/i.test(String(transaction.expected_head_ref_oid || "")))
      || typeof transaction.expected_dispatch_id !== "string"
      || (record.previous_dispatch_id ?? "") !== transaction.expected_dispatch_id) {
      throw new Error("marker-bound publication transaction predecessor is invalid");
    }
  } else if (transaction.marker_file !== null
    || transaction.expected_repository_slug !== null
    || transaction.expected_head_ref_oid !== null
    || transaction.expected_dispatch_id !== null) {
    throw new Error("standalone publication transaction carries marker state");
  }

  const expectedCarrierRoles = Object.hasOwn(record, "paged_full_material_sha256")
    ? publicationCarrierRoles
    : publicationCarrierRoles.filter((role) => role !== "paged-full-material");
  if (!Array.isArray(transaction.carriers)
    || transaction.carriers.length !== expectedCarrierRoles.length) {
    throw new Error("publication transaction carrier manifest is incomplete");
  }
  const seenRoles = new Set();
  const seenPaths = new Set();
  for (const carrier of transaction.carriers) {
    if (!carrier
      || typeof carrier !== "object"
      || Array.isArray(carrier)
      || !expectedCarrierRoles.includes(carrier.role)
      || seenRoles.has(carrier.role)
      || !path.isAbsolute(String(carrier.path || ""))
      || path.resolve(carrier.path) !== carrier.path
      || seenPaths.has(carrier.path)
      || !carrierMatchesReservation(record, carrier)
      || !Number.isSafeInteger(carrier.byte_length)
      || carrier.byte_length < 0
      || carrier.byte_length > carrierByteLimit(carrier.role)
      || !/^[a-f0-9]{64}$/.test(String(carrier.sha256 || ""))) {
      throw new Error("publication transaction carrier manifest is invalid");
    }
    seenRoles.add(carrier.role);
    seenPaths.add(carrier.path);
  }
  const packetCarrier = transaction.carriers.find((carrier) => carrier.role === "packet");
  if (packetCarrier.sha256 !== record.packet_sha256) {
    throw new Error("publication transaction packet hash does not match its reservation");
  }
  if (!Array.isArray(transaction.created_carriers)
    || transaction.created_carriers.length > transaction.carriers.length) {
    throw new Error("publication transaction created-path touch ledger is invalid");
  }
  const createdRoles = new Set();
  for (const created of transaction.created_carriers) {
    const intended = transaction.carriers.find((carrier) => carrier.role === created?.role);
    if (!intended
      || createdRoles.has(created.role)
      || JSON.stringify(Object.keys(created)) !== JSON.stringify([
        "role", "path", "byte_length", "sha256", "dispatch_id", "carrier_root_id",
      ])
      || created.path !== intended.path
      || created.byte_length !== intended.byte_length
      || created.sha256 !== intended.sha256
      || created.dispatch_id !== transaction.next_dispatch_id
      || created.carrier_root_id !== record.carrier_root_id) {
      throw new Error("publication transaction created-path touch ledger is invalid");
    }
    createdRoles.add(created.role);
  }
  if (transaction.pending_carrier !== null) {
    const pending = transaction.pending_carrier;
    const intended = transaction.carriers.find((carrier) => carrier.role === pending?.role);
    const alreadyCreated = createdRoles.has(pending.role);
    if (!intended
      || JSON.stringify(Object.keys(pending)) !== JSON.stringify([
        "role", "path", "staging_path", "byte_length", "sha256", "dispatch_id", "carrier_root_id",
      ])
      || pending.path !== intended.path
      || path.dirname(pending.staging_path) !== path.dirname(pending.path)
      || !path.basename(pending.staging_path).startsWith(`.${path.basename(pending.path)}.`)
      || pending.byte_length !== intended.byte_length
      || pending.sha256 !== intended.sha256
      || pending.dispatch_id !== transaction.next_dispatch_id
      || pending.carrier_root_id !== record.carrier_root_id) {
      throw new Error("publication transaction pending carrier ownership is invalid");
    }
    if (alreadyCreated) {
      const created = transaction.created_carriers.find((entry) => entry.role === pending.role);
      if (created.path !== pending.path
        || created.byte_length !== pending.byte_length
        || created.sha256 !== pending.sha256
        || created.dispatch_id !== pending.dispatch_id
        || created.carrier_root_id !== pending.carrier_root_id) {
        throw new Error("publication transaction pending carrier transition is invalid");
      }
    }
  }
}

function carrierByteLimit(role) {
  return role === "paged-full-material"
    ? pagedFullMaterialCarrierMaxBytes
    : SECOND_REVIEW_PACKET_MAX_BYTES;
}

function publicationTransaction({ context, plan, record, entries }) {
  const markerBound = plan.type !== "none";
  const marker = markerBound ? plan.marker : null;
  const expectedDispatchId = markerBound
    ? (plan.type === "verified-fast-forward-head"
      ? marker.expected_dispatch_id
      : (context.previous_dispatch_id ?? ""))
    : null;
  const transaction = {
    schema: publicationTransactionSchema,
    publication_mode: markerBound ? "marker-bound" : "standalone",
    control_evidence_root: path.resolve(context.control_evidence_root),
    repository_slug: context.repository_slug,
    pr_number: context.pr_number,
    marker_file: markerBound ? path.resolve(marker.file) : null,
    expected_repository_slug: markerBound ? String(marker.repository_slug || "") : null,
    expected_head_ref_oid: markerBound ? String(marker.head_ref_oid || "") : null,
    expected_dispatch_id: expectedDispatchId,
    next_head_ref_oid: context.head_ref_oid,
    next_dispatch_id: context.dispatch_id,
    reservation: record,
    carriers: carrierManifest(entries),
    created_carriers: [],
    pending_carrier: null,
  };
  assertPublicationTransaction(transaction, context.control_evidence_root);
  return transaction;
}

function publicationTransactionPath(transaction) {
  return path.join(
    transaction.control_evidence_root,
    `${publicationTransactionPrefix}${transaction.next_dispatch_id}.json`
  );
}

function createPublicationTransaction(transaction) {
  assertPublicationTransaction(transaction, transaction.control_evidence_root);
  controlEvidenceHelper.ensureDurableDirectory(transaction.control_evidence_root, 0o700);
  const envelope = {
    schema: publicationTransactionEnvelopeSchema,
    owner_pid: process.pid,
    owner_token: randomUUID(),
    created_at: new Date().toISOString(),
    transaction,
  };
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (bytes.length > publicationTransactionMaxBytes) {
    throw new Error("publication transaction exceeds its durable evidence bound");
  }
  const file = publicationTransactionPath(transaction);
  writeExclusiveText(file, bytes);
  return { file, bytes, envelope };
}

function rewritePublicationTransaction(handle) {
  assertPublicationTransaction(
    handle.envelope.transaction,
    handle.envelope.transaction.control_evidence_root,
  );
  const nextBytes = Buffer.from(`${JSON.stringify(handle.envelope)}\n`, "utf8");
  if (nextBytes.length > publicationTransactionMaxBytes) {
    throw new Error("publication transaction touch ledger exceeds its durable evidence bound");
  }
  // The primary envelope is durable ownership for this one deterministic rewrite
  // name. Do not call writeExclusiveBytes here: that would create a second,
  // anonymous nested temp which stale recovery cannot attribute after SIGKILL.
  const temporaryPath = `${handle.file}.rewrite.tmp`;
  writeRecordedRewriteBytes(temporaryPath, nextBytes);
  renameSync(temporaryPath, handle.file);
  fsyncDirectory(path.dirname(handle.file));
  handle.bytes = nextBytes;
}

function createdCarrierLedgerEntry(transaction, entry) {
  return {
    role: entry.role,
    path: entry.path,
    byte_length: entry.bytes.length,
    sha256: sha256(entry.bytes),
    dispatch_id: transaction.next_dispatch_id,
    carrier_root_id: transaction.reservation.carrier_root_id,
  };
}

function publishCarrierWithLedger(handle, entry) {
  const directory = path.dirname(entry.path);
  controlEvidenceHelper.ensureDurableDirectory(directory, 0o700, {
    trustedParent: canonicalCarrierRoot,
  });
  const stagingPath = path.join(directory, `.${path.basename(entry.path)}.${randomUUID()}.staging`);
  const ledgerEntry = createdCarrierLedgerEntry(handle.envelope.transaction, entry);
  // Persist the unique staging intent before touching the carrier directory. A crash in
  // either direction is then distinguishable from a race-created destination: recovery
  // only treats the destination as owned when it is the hard link of these sealed bytes.
  handle.envelope.transaction.pending_carrier = {
    role: ledgerEntry.role,
    path: ledgerEntry.path,
    staging_path: stagingPath,
    byte_length: ledgerEntry.byte_length,
    sha256: ledgerEntry.sha256,
    dispatch_id: ledgerEntry.dispatch_id,
    carrier_root_id: ledgerEntry.carrier_root_id,
  };
  rewritePublicationTransaction(handle);
  writeRecordedStagingBytes(stagingPath, entry.bytes);
  linkSync(stagingPath, entry.path);
  fsyncDirectory(directory);
  // Keep the pending hard-link proof durable through the created-ledger transition. If
  // the process dies before the staging name is removed, recovery can prove ownership by
  // inode; if it dies just after removal, the created ledger already owns the target.
  handle.envelope.transaction.created_carriers.push(ledgerEntry);
  rewritePublicationTransaction(handle);
  unlinkSync(stagingPath);
  fsyncDirectory(directory);
  handle.envelope.transaction.pending_carrier = null;
  rewritePublicationTransaction(handle);
}

function publishCarriersWithLedger(handle, entries) {
  for (const entry of entries) publishCarrierWithLedger(handle, entry);
}

function removePublicationTransaction(handle) {
  if (!handle) return;
  const rewritePath = `${handle.file}.rewrite.tmp`;
  const rewriteStat = lstatIfPresent(rewritePath);
  if (rewriteStat !== null) {
    if (!rewriteStat.isFile()) {
      throw new Error("publication transaction rewrite ownership is not a regular file");
    }
    const expectedRewriteBytes = Buffer.from(`${JSON.stringify(handle.envelope)}\n`, "utf8");
    const currentRewriteBytes = readFileSync(rewritePath);
    if (!currentRewriteBytes.equals(expectedRewriteBytes)) {
      throw new Error("publication transaction rewrite ownership changed before cleanup");
    }
    unlinkSync(rewritePath);
    fsyncDirectory(path.dirname(rewritePath));
  }
  const stat = lstatIfPresent(handle.file);
  if (stat === null) return;
  if (!stat.isFile()) {
    throw new Error("publication transaction ownership is not a regular file");
  }
  const current = readFileSync(handle.file);
  if (!current.equals(handle.bytes)) {
    throw new Error("publication transaction ownership changed before cleanup");
  }
  unlinkSync(handle.file);
  fsyncDirectory(path.dirname(handle.file));
}

function lstatIfPresent(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readExactTransactionCarrier(carrier) {
  const stat = lstatIfPresent(carrier.path);
  if (stat === null) return null;
  if (!stat.isFile()
    || stat.size !== carrier.byte_length
    || stat.size > carrierByteLimit(carrier.role)) {
    throw new Error(`publication carrier ownership is invalid for ${carrier.role}`);
  }
  const bytes = readFileSync(carrier.path);
  if (sha256(bytes) !== carrier.sha256) {
    throw new Error(`publication carrier ownership changed for ${carrier.role}`);
  }
  return bytes;
}

function pendingCarrierOwnedByTransaction(transaction) {
  const pending = transaction.pending_carrier;
  if (pending === null) return null;
  const stagingStat = lstatIfPresent(pending.staging_path);
  const targetStat = lstatIfPresent(pending.path);
  if (stagingStat === null) {
    if (targetStat !== null
      && !transaction.created_carriers.some((created) => created.role === pending.role)) {
      throw new Error(`pending carrier ownership proof is missing for ${pending.role}`);
    }
    return null;
  }
  if (!stagingStat.isFile()) {
    throw new Error(`pending carrier staging ownership is invalid for ${pending.role}`);
  }
  const stagingIsSealed = stagingStat.size === pending.byte_length
    && sha256(readFileSync(pending.staging_path)) === pending.sha256;
  if (!stagingIsSealed) {
    if (targetStat !== null) {
      throw new Error(`pending carrier staging ownership is invalid for ${pending.role}`);
    }
    return null;
  }
  if (targetStat === null) return null;
  if (!targetStat.isFile()
    || targetStat.dev !== stagingStat.dev
    || targetStat.ino !== stagingStat.ino) {
    throw new Error(`pending carrier target is not transaction-owned for ${pending.role}`);
  }
  return transaction.carriers.find((carrier) => carrier.role === pending.role);
}

function inspectTransactionCarriers(transaction) {
  const present = [];
  for (const created of transaction.created_carriers) {
    const carrier = transaction.carriers.find((candidate) => candidate.role === created.role);
    if (readExactTransactionCarrier(carrier) === null) continue;
    present.push(carrier);
  }
  const pendingOwned = pendingCarrierOwnedByTransaction(transaction);
  if (pendingOwned !== null
    && !transaction.created_carriers.some((created) => created.role === pendingOwned.role)) {
    present.push(pendingOwned);
  }
  for (const carrier of transaction.carriers) {
    if (transaction.created_carriers.some((created) => created.role === carrier.role)) continue;
    if (transaction.pending_carrier?.role === carrier.role) continue;
    if (lstatIfPresent(carrier.path) !== null) {
      throw new Error(`publication carrier is present without created-path ownership for ${carrier.role}`);
    }
  }
  return present;
}

function sameCarrierInventory(left, right) {
  return left.length === right.length
    && left.every((carrier, index) => carrier.role === right[index].role
      && carrier.path === right[index].path);
}

function removeInspectedTransactionCarriers(transaction, expectedPresent) {
  const currentPresent = inspectTransactionCarriers(transaction);
  if (!sameCarrierInventory(currentPresent, expectedPresent)) {
    throw new Error("publication carrier inventory changed during recovery");
  }
  for (const carrier of currentPresent) unlinkSync(carrier.path);
  if (transaction.pending_carrier !== null
    && lstatIfPresent(transaction.pending_carrier.staging_path) !== null) {
    unlinkSync(transaction.pending_carrier.staging_path);
  }
  const touchedDirectories = new Set(currentPresent.map((carrier) => path.dirname(carrier.path)));
  if (transaction.pending_carrier !== null) {
    touchedDirectories.add(path.dirname(transaction.pending_carrier.staging_path));
  }
  for (const directory of touchedDirectories) {
    fsyncDirectory(directory);
  }
}

function verifyCommittedPublication(transaction) {
  const evidence = controlEvidenceHelper.readDispatchEvidence({
    rootDir: transaction.control_evidence_root,
    dispatchId: transaction.next_dispatch_id,
  });
  const expectedDispatchBytes = Buffer.from(`${JSON.stringify(transaction.reservation)}\n`, "utf8");
  if (!evidence.dispatchBytes?.equals(expectedDispatchBytes)) {
    throw new Error("committed publication reservation does not match its transaction");
  }
  for (const carrier of transaction.carriers) {
    if (new Set(["packet", "observability-context"]).has(carrier.role)) {
      if (readExactTransactionCarrier(carrier) === null) {
        throw new Error(`committed publication is missing ${carrier.role}`);
      }
      continue;
    }
    const stat = lstatIfPresent(carrier.path);
    if (stat === null || !stat.isFile()) {
      throw new Error(`committed publication is missing ${carrier.role}`);
    }
  }
}

function classifyMarkerPublication(transaction) {
  // A marker that is simply gone — cleared by the post-PR gate, or aged out by the
  // unbound-marker sweep — used to surface here as an unhandled ENOENT thrown from
  // inside the stale sweeper's loop. That is the same wedge this function exists to
  // remove, only one door over: the throw escapes before removePublicationTransaction
  // can run, so the envelope survives and every later render under this evidence root
  // fails. An absent marker cannot place the transaction on either side of the CAS, so
  // it is the third state and goes through the same authority plus zero-residue gate as
  // any other orphan. A marker that is present but unreadable still throws — malformed
  // is not absent, and guessing at its contents is exactly what recovery must not do.
  if (lstatIfPresent(transaction.marker_file) === null) return "unlinearizable";
  const marker = JSON.parse(readFileSync(transaction.marker_file, "utf8"));
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error("publication transaction marker is malformed");
  }
  for (const field of ["repository_slug", "prNumber", "head_ref_oid"]) {
    if (typeof marker[field] !== "string") {
      throw new Error(`publication transaction marker field ${field} is malformed`);
    }
  }
  const markerDispatchId = marker.expected_dispatch_id
    ?? marker.lineage_clear_obligation?.current_dispatch_id;
  if (typeof markerDispatchId !== "string") {
    throw new Error("publication transaction marker dispatch identity is malformed");
  }
  const committedClear = transaction.reservation.lineage_approval_receipt?.action === "clear"
    && marker.lineage_clear_obligation?.obligation_head_ref_oid === transaction.next_head_ref_oid
    && marker.lineage_clear_obligation?.current_dispatch_id === transaction.next_dispatch_id
    && marker.lineage_clear_obligation?.approval_receipt_ids?.includes(
      transaction.reservation.lineage_approval_receipt_id,
    ) === true;
  const committed = marker.repository_slug === transaction.repository_slug
    && marker.prNumber === transaction.pr_number
    && marker.head_ref_oid === transaction.next_head_ref_oid
    && (marker.expected_dispatch_id === transaction.next_dispatch_id || committedClear);
  if (committed) return "committed";
  const uncommitted = marker.prNumber === transaction.pr_number
    && marker.repository_slug === transaction.expected_repository_slug
    && marker.head_ref_oid === transaction.expected_head_ref_oid
    && markerDispatchId === transaction.expected_dispatch_id;
  if (uncommitted) return "uncommitted";
  return "unlinearizable";
}

const unlinearizableMarkerMessage =
  "publication transaction cannot be linearized against the current marker";

// The two grants that exist. Both are facts the caller has already established: the stale
// sweepers only reach their recovery call after proving owner death plus the staleness
// window (and, when a marker lock contender exists, the same two facts about it), and the
// inline caller holds the exact envelope bytes it wrote itself.
const ORPHAN_OWNER_DEAD_STALE = { orphanRecoveryAuthority: "owner-dead-stale" };
const ORPHAN_SELF_OWNED = { orphanRecoveryAuthority: "self-owned" };
// Membership, not truthiness. "The caller passed something" is not a grant; a future
// call site that hands over a bare `true`, an empty string or an options object it
// happened to have would otherwise silently acquire CAS-bypassing authority.
const ORPHAN_RECOVERY_AUTHORITIES = new Set([
  ORPHAN_OWNER_DEAD_STALE.orphanRecoveryAuthority,
  ORPHAN_SELF_OWNED.orphanRecoveryAuthority,
]);

// An orphan is a transaction the marker can place on neither side of the CAS: it was made
// durable, then the CAS refused it, then the process died. Nothing will ever commit it and
// nothing will ever roll it back through the normal path, so without this it wedges every
// later render for the same PR forever. Discarding one is still the narrowest possible
// escape hatch, so the authority to do it is never derived here — the caller has to have
// already proven the owner is dead and the transaction is stale (recoverStalePublication-
// Transactions / recoverAbandonedMarkerPublication), or that this process itself owns the
// exact envelope bytes. The inline caller at the end of main() is in the latter position;
// a transaction the current process is still writing must never be treated as an orphan.
function recoverPublicationTransaction(transaction, expectedControlEvidenceRoot = null, {
  orphanRecoveryAuthority = null,
} = {}) {
  assertPublicationTransaction(transaction, expectedControlEvidenceRoot);
  let orphaned = false;
  let markerState = null;
  if (transaction.publication_mode === "marker-bound") {
    markerState = classifyMarkerPublication(transaction);
    if (markerState === "committed") {
      verifyCommittedPublication(transaction);
      return "committed";
    }
    if (markerState === "unlinearizable") {
      if (!ORPHAN_RECOVERY_AUTHORITIES.has(orphanRecoveryAuthority)) {
        throw new Error(unlinearizableMarkerMessage);
      }
      orphaned = true;
    }
  }
  const inspectedCarriers = inspectTransactionCarriers(transaction);
  if (transaction.reservation.lineage_approval_receipt_id
    && transaction.publication_mode === "marker-bound"
    && markerState === "uncommitted") {
    const evidence = controlEvidenceHelper.readDispatchEvidence({
      rootDir: transaction.control_evidence_root,
      dispatchId: transaction.next_dispatch_id,
    });
    const expectedDispatchBytes = Buffer.from(`${JSON.stringify(transaction.reservation)}\n`, "utf8");
    if (evidence.dispatchBytes?.equals(expectedDispatchBytes)) {
      controlEvidenceHelper.writeLineageApprovalTransactionAbort({
        rootDir: transaction.control_evidence_root,
        record: transaction.reservation,
        transactionId: transaction.next_dispatch_id,
        reason: "exact source marker remained unchanged after publication did not commit",
      });
      removeInspectedTransactionCarriers(transaction, inspectedCarriers);
      return "aborted";
    }
    if (evidence.dispatchBytes) {
      throw new Error("lineage approval transaction reservation does not match its exact source transaction");
    }
  }
  controlEvidenceHelper.rollbackUnclaimedDispatchReservation({
    rootDir: transaction.control_evidence_root,
    record: transaction.reservation,
    beforeRollback: ({ reservationPresent }) => {
      const currentCarriers = inspectTransactionCarriers(transaction);
      if (!sameCarrierInventory(currentCarriers, inspectedCarriers)) {
        throw new Error("publication carrier inventory changed before reservation rollback");
      }
      if (!reservationPresent && currentCarriers.length > 0) {
        throw new Error("publication carriers exist without their exact reservation");
      }
      // An uncommitted transaction owns its residue and may roll it back. An orphan owns
      // nothing the marker agrees with, so it may only be discarded when it left nothing
      // at all; any surviving reservation stays fail closed for a human to resolve. The
      // fact is read here rather than through an unlocked existsSync because only inside
      // the capacity lock is "absent" still true by the time the rollback acts on it.
      if (orphaned && reservationPresent) throw new Error(unlinearizableMarkerMessage);
      removeInspectedTransactionCarriers(transaction, currentCarriers);
    },
  });
  return "rolled-back";
}

function transactionOwnerIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readPublicationTransactionEnvelope(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > publicationTransactionMaxBytes) {
    throw new PublicationTransactionCandidateSchemaViolation(
      "publication transaction envelope exceeds its durable evidence bound"
    );
  }
  const bytes = readFileSync(file);
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PublicationTransactionCandidateSchemaViolation(
      "publication transaction envelope is not valid JSON"
    );
  }
  if (!envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || envelope.schema !== publicationTransactionEnvelopeSchema
    || !Number.isSafeInteger(envelope.owner_pid)
    || envelope.owner_pid <= 0
    || typeof envelope.owner_token !== "string"
    || !/^[0-9a-f-]{36}$/i.test(envelope.owner_token)
    || typeof envelope.created_at !== "string"
    || Number.isNaN(Date.parse(envelope.created_at))) {
    throw new PublicationTransactionCandidateSchemaViolation(
      "publication transaction envelope identity is invalid"
    );
  }
  try {
    assertPublicationTransaction(envelope.transaction, path.dirname(file));
  } catch (error) {
    throw new PublicationTransactionCandidateSchemaViolation(
      error instanceof Error ? error.message : String(error)
    );
  }
  if (publicationTransactionPath(envelope.transaction) !== file) {
    throw new PublicationTransactionCandidateSchemaViolation(
      "publication transaction envelope path binding is invalid"
    );
  }
  return { envelope, handle: { file, bytes }, stat };
}

function remediationDirectory(root) {
  return path.join(root, publicationTransactionRemediationDir);
}

function ensureExactRemediationJson(file, expectedOriginalSha256) {
  const existing = lstatIfPresent(file);
  if (existing === null) return false;
  if (!existing.isFile() || existing.size > publicationTransactionMaxBytes) {
    throw new Error("publication transaction remediation sidecar is invalid");
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("publication transaction remediation sidecar is not valid JSON");
  }
  if (!evidence
    || typeof evidence !== "object"
    || Array.isArray(evidence)
    || evidence.schema !== publicationTransactionRemediationSchema
    || evidence.original_sha256 !== expectedOriginalSha256
    || evidence.evidence_mode !== "digest-only"
    || evidence.raw_payload_retained !== false) {
    throw new Error("publication transaction remediation sidecar does not match the candidate");
  }
  return true;
}

// Envelope/schema violations are not recoverable through marker or reservation logic, but
// leaving the malformed active file in inventory wedges every future render. Preserve only
// digest/basename-level evidence first; only then remove the active candidate.
function quarantineMalformedStalePublicationTransactionCandidate(root, file, now, error) {
  if (!(error instanceof PublicationTransactionCandidateSchemaViolation)) return null;
  const stat = lstatIfPresent(file);
  if (stat === null) return null;
  if (!stat.isFile()
    || stat.size <= 0
    || stat.size > publicationTransactionMaxBytes
    || now - stat.mtimeMs <= publicationTransactionStaleAfterMs) {
    return null;
  }
  const activeFileName = path.basename(file);
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size) {
    throw new Error("publication transaction candidate changed before quarantine");
  }
  const originalSha256 = sha256(bytes);
  const evidenceId = `${activeFileName}.${originalSha256.slice(0, 16)}`;
  const quarantineDir = remediationDirectory(root);
  const sidecarFileName = `${evidenceId}.json`;
  controlEvidenceHelper.ensureDurableDirectory(quarantineDir, 0o700);
  const sidecarPath = path.join(quarantineDir, sidecarFileName);
  if (!ensureExactRemediationJson(sidecarPath, originalSha256)) {
    const sidecar = {
      schema: publicationTransactionRemediationSchema,
      classification: error.classification,
      action: "quarantined-active-transaction",
      evidence_mode: "digest-only",
      active_file_name: activeFileName,
      original_sha256: originalSha256,
      original_byte_length: bytes.length,
      original_mtime_ms: Math.trunc(stat.mtimeMs),
      reason: error.message,
      raw_payload_retained: false,
    };
    const sidecarText = `${JSON.stringify(sidecar)}\n`;
    if (Buffer.byteLength(sidecarText, "utf8") > publicationTransactionMaxBytes) {
      throw new Error("publication transaction remediation sidecar exceeds its evidence bound");
    }
    writeExclusiveText(sidecarPath, sidecarText);
  }
  const currentStat = lstatIfPresent(file);
  if (currentStat === null) return { sidecarFileName };
  if (!currentStat.isFile()
    || currentStat.size !== bytes.length
    || !readFileSync(file).equals(bytes)) {
    throw new Error("publication transaction candidate changed before quarantine cleanup");
  }
  unlinkSync(file);
  fsyncDirectory(root);
  return { sidecarFileName };
}

function readExactMarkerLockContender(file, envelope) {
  const stat = lstatIfPresent(file);
  if (stat === null || !stat.isFile()
    || stat.size <= 0 || stat.size > publicationTransactionMaxBytes) {
    throw new Error("publication marker contender is not bounded regular evidence");
  }
  const bytes = readFileSync(file);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("publication marker contender is not valid JSON");
  }
  const exactFields = ["schema", "owner_pid", "owner_token", "created_at", "transaction"];
  if (!record
    || typeof record !== "object"
    || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...exactFields].sort())
    || record.schema !== "devpro-post-pr-marker-lock/v1"
    || record.owner_pid !== envelope.owner_pid
    || !Number.isSafeInteger(record.owner_pid)
    || record.owner_pid <= 0
    || typeof record.owner_token !== "string"
    || !/^[0-9a-f-]{36}$/i.test(record.owner_token)
    || typeof record.created_at !== "string"
    || Number.isNaN(Date.parse(record.created_at))
    || JSON.stringify({
      ...record.transaction,
      created_carriers: [],
      pending_carrier: null,
    }) !== JSON.stringify({
      ...envelope.transaction,
      created_carriers: [],
      pending_carrier: null,
    })) {
    throw new Error("publication marker contender does not exactly match its common transaction");
  }
  assertPublicationTransaction(record.transaction, envelope.transaction.control_evidence_root);
  return { file, bytes, record, stat };
}

function markerLockContendersForTransaction(transaction) {
  const directory = path.dirname(transaction.marker_file);
  const prefix = `${path.basename(transaction.marker_file)}.compare-and-swap.lock.`;
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.startsWith(prefix));
  } catch {
    throw new Error("publication marker contender inventory is unavailable");
  }
  if (names.length > 1) {
    throw new Error("publication marker contender inventory is ambiguous");
  }
  return names.map((name) => path.join(directory, name));
}

function removeExactMarkerLockContender(contender) {
  const stat = lstatIfPresent(contender.file);
  if (stat === null || !stat.isFile()) {
    throw new Error("publication marker contender disappeared before cleanup");
  }
  const current = readFileSync(contender.file);
  if (!current.equals(contender.bytes)) {
    throw new Error("publication marker contender ownership changed before cleanup");
  }
  unlinkSync(contender.file);
  fsyncDirectory(path.dirname(contender.file));
}

/**
 * win32 P1–P3: mode/uid mismatch alone must not invalidate rewrite residue.
 * non-win32: require exact 0600 + matching uid when getuid exists.
 * Exported for platform-inject prove-it (sticky WARN #5).
 */
export function isRewriteResidueModeUidInvalid(
  rewriteStat,
  { platform = process.platform, uid = typeof process.getuid === "function" ? process.getuid() : null } = {},
) {
  if (platform === "win32") return false;
  return (
    (rewriteStat.mode & 0o777) !== 0o600
    || (uid !== null && rewriteStat.uid !== uid)
  );
}

function recoverStalePublicationTransactionCandidate(root, file, now, { platform = process.platform } = {}) {
  const { envelope, handle, stat } = readPublicationTransactionEnvelope(file);
  if (now - stat.mtimeMs <= publicationTransactionStaleAfterMs
    || transactionOwnerIsAlive(envelope.owner_pid)) {
    return;
  }
  const rewriteTemporaryPath = `${file}.rewrite.tmp`;
  const rewriteStat = lstatIfPresent(rewriteTemporaryPath);
  if (rewriteStat !== null) {
    // win32: POSIX mode/uid cannot materialize as ACL (P1–P3 named alternative);
    // do not fail solely on observed mode bits. non-win32 keeps exact 0600+uid.
    const modeUidInvalid = isRewriteResidueModeUidInvalid(rewriteStat, { platform });
    if (!rewriteStat.isFile()
      || rewriteStat.size <= 0
      || rewriteStat.size > publicationTransactionMaxBytes
      || modeUidInvalid) {
      throw new Error("publication transaction rewrite residue ownership is invalid");
    }
    const rewriteBytes = readFileSync(rewriteTemporaryPath);
    let rewriteEnvelope;
    try {
      const rewriteText = new TextDecoder("utf-8", { fatal: true }).decode(rewriteBytes);
      if (!rewriteText.endsWith("\n")) throw new Error("missing terminator");
      rewriteEnvelope = JSON.parse(rewriteText);
      if (`${JSON.stringify(rewriteEnvelope)}\n` !== rewriteText) throw new Error("noncanonical envelope");
      assertPublicationTransaction(rewriteEnvelope.transaction, root);
    } catch {
      throw new Error("publication transaction rewrite residue ownership is invalid");
    }
    const immutableTransaction = (transaction) => {
      const copy = structuredClone(transaction);
      delete copy.created_carriers;
      delete copy.pending_carrier;
      return copy;
    };
    if (rewriteEnvelope.schema !== envelope.schema
      || rewriteEnvelope.owner_pid !== envelope.owner_pid
      || rewriteEnvelope.owner_token !== envelope.owner_token
      || rewriteEnvelope.created_at !== envelope.created_at
      || publicationTransactionPath(rewriteEnvelope.transaction) !== file
      || JSON.stringify(immutableTransaction(rewriteEnvelope.transaction))
        !== JSON.stringify(immutableTransaction(envelope.transaction))) {
      throw new Error("publication transaction rewrite residue ownership is invalid");
    }
    unlinkSync(rewriteTemporaryPath);
    fsyncDirectory(root);
  }
  if (envelope.transaction.publication_mode === "marker-bound") {
    const contenderFiles = markerLockContendersForTransaction(envelope.transaction);
    if (contenderFiles.length === 1) {
      const contender = readExactMarkerLockContender(contenderFiles[0], envelope);
      if (now - contender.stat.mtimeMs <= publicationTransactionStaleAfterMs
        || transactionOwnerIsAlive(contender.record.owner_pid)) {
        return;
      }
      recoverPublicationTransaction(envelope.transaction, root, ORPHAN_OWNER_DEAD_STALE);
      removeExactMarkerLockContender(contender);
      removePublicationTransaction(handle);
      return;
    }
  }
  recoverPublicationTransaction(envelope.transaction, root, ORPHAN_OWNER_DEAD_STALE);
  removePublicationTransaction(handle);
}

function recoverStalePublicationTransactions(controlEvidenceRoot) {
  const root = path.resolve(controlEvidenceRoot);
  const rootStat = lstatIfPresent(root);
  if (rootStat === null) return;
  if (!rootStat.isDirectory()) {
    throw new Error("publication transaction root is not a directory");
  }
  const files = readdirSync(root)
    .filter((name) => name.startsWith(publicationTransactionPrefix) && name.endsWith(".json"));
  if (files.length > publicationTransactionMaxFiles) {
    throw new Error("publication transaction inventory exceeds its recovery bound");
  }
  const now = Date.now();
  const failures = [];
  for (const name of files) {
    const file = path.join(root, name);
    try {
      recoverStalePublicationTransactionCandidate(root, file, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const remediation = quarantineMalformedStalePublicationTransactionCandidate(
          root,
          file,
          now,
          error
        );
        if (remediation !== null) {
          failures.push(
            `${name}: ${message}; quarantined malformed stale transaction candidate as `
            + `${remediation.sidecarFileName}`
          );
          continue;
        }
      } catch (remediationError) {
        const remediationMessage = remediationError instanceof Error
          ? remediationError.message
          : String(remediationError);
        failures.push(`${name}: ${message}; quarantine failed: ${remediationMessage}`);
        continue;
      }
      failures.push(`${name}: ${message}`);
    }
  }
  if (failures.length > 0) {
    const candidateNoun = failures.length === 1 ? "candidate" : "candidates";
    throw new Error([
      `publication transaction recovery blocked for ${failures.length} transaction ${candidateNoun}`,
      ...failures,
    ].join("\n"));
  }
}

function recoverAbandonedMarkerPublication(expectedControlEvidenceRoot, contenderRecord) {
  if (!contenderRecord?.transaction) {
    throw new Error("publication marker contender transaction is missing");
  }
  assertPublicationTransaction(contenderRecord.transaction, expectedControlEvidenceRoot);
  const transactionFile = publicationTransactionPath(contenderRecord.transaction);
  const transactionStat = lstatIfPresent(transactionFile);
  if (transactionStat === null) {
    throw new Error("publication marker contender has no common recovery transaction");
  }
  const { envelope, handle, stat } = readPublicationTransactionEnvelope(transactionFile);
  const exactFields = ["schema", "owner_pid", "owner_token", "created_at", "transaction"];
  if (!contenderRecord
    || typeof contenderRecord !== "object"
    || Array.isArray(contenderRecord)
    || JSON.stringify(Object.keys(contenderRecord).sort()) !== JSON.stringify([...exactFields].sort())
    || contenderRecord.schema !== "devpro-post-pr-marker-lock/v1"
    || contenderRecord.owner_pid !== envelope.owner_pid
    || !Number.isSafeInteger(contenderRecord.owner_pid)
    || contenderRecord.owner_pid <= 0
    || typeof contenderRecord.owner_token !== "string"
    || !/^[0-9a-f-]{36}$/i.test(contenderRecord.owner_token)
    || typeof contenderRecord.created_at !== "string"
    || Number.isNaN(Date.parse(contenderRecord.created_at))
    || JSON.stringify(contenderRecord.transaction) !== JSON.stringify(envelope.transaction)
    || Date.now() - stat.mtimeMs <= publicationTransactionStaleAfterMs
    || transactionOwnerIsAlive(envelope.owner_pid)) {
    throw new Error("publication marker contender does not exactly own its common transaction");
  }
  recoverPublicationTransaction(envelope.transaction, expectedControlEvidenceRoot, ORPHAN_OWNER_DEAD_STALE);
  return () => removePublicationTransaction(handle);
}

async function bindPendingPostPrCompletionMarker(context, plan, transaction, publishCarriers, recordRound) {
  if (plan.type === "none") return;
  const record = transaction.reservation;
  const recoverStaleContender = (staleContender) => recoverAbandonedMarkerPublication(
    context.control_evidence_root,
    staleContender
  );
  const reserveBeforeCommit = async (markerSnapshot) => {
    // Run under the marker lock immediately before reservation and marker
    // publication for initial, same-head, and cross-head bindings alike.
    assertAuthoritativePrHead(context);
    if (plan.priorClosureDigest !== undefined
      && assertPriorDispatchIsClosed(context, plan.marker) !== plan.priorClosureDigest) {
      throw new Error("reviewer_dispatch_identity_collision: prior dispatch closure evidence changed under marker lock");
    }
    if (plan.type === "approved-non-fast-forward-rebind") {
      let currentApproval;
      try {
        currentApproval = resolveSecondReviewLineageApproval({
          repositorySlug: context.repository_slug,
          prNumber: context.pr_number,
          sourceState: plan.sourceState,
          oldHead: plan.marker.head_ref_oid,
          newHead: context.head_ref_oid,
          oldDispatchId: plan.marker.expected_dispatch_id,
          action: plan.approval.receipt.action,
          consumedCommentIds: controlEvidenceHelper.listConsumedLineageApprovalIds({
            rootDir: context.control_evidence_root,
          }),
        });
      } catch {
        throw new Error("reviewer_dispatch_identity_collision: approval evidence changed or became unavailable under marker lock");
      }
      if (JSON.stringify(currentApproval.receipt) !== JSON.stringify(plan.approval.receipt)) {
        throw new Error("reviewer_dispatch_identity_collision: approval evidence changed under marker lock");
      }
      const currentSticky = selectExactSecondReviewStickyAuthority(currentApproval.comments);
      if (currentSticky.status !== "selected"
        || sha256(Buffer.from(JSON.stringify(currentSticky.authority), "utf8")) !== plan.oldStickyAuthorityDigest) {
        throw new Error("reviewer_dispatch_identity_collision: old sticky authority changed under marker lock");
      }
      controlEvidenceHelper.assertLineageApprovalNotConsumed({
        rootDir: context.control_evidence_root,
        approvalCommentId: currentApproval.receipt.approval_comment_id,
      });
    }
    if (plan.type === "approved-non-fast-forward-clear") {
      let currentApproval;
      try {
        currentApproval = resolveSecondReviewLineageApproval({
          repositorySlug: context.repository_slug,
          prNumber: context.pr_number,
          sourceState: plan.sourceState,
          oldHead: plan.marker.head_ref_oid,
          newHead: context.head_ref_oid,
          oldDispatchId: plan.marker.expected_dispatch_id,
          action: "clear",
          consumedCommentIds: controlEvidenceHelper.listConsumedLineageApprovalIds({
            rootDir: context.control_evidence_root,
          }),
        });
      } catch {
        throw new Error("reviewer_dispatch_identity_collision: approval evidence changed or became unavailable under marker lock");
      }
      if (JSON.stringify(currentApproval.receipt) !== JSON.stringify(plan.approval.receipt)) {
        throw new Error("reviewer_dispatch_identity_collision: approval evidence changed under marker lock");
      }
      const currentSticky = selectExactSecondReviewStickyAuthority(currentApproval.comments);
      if (currentSticky.status !== "selected"
        || sha256(Buffer.from(JSON.stringify(currentSticky.authority), "utf8")) !== plan.oldStickyAuthorityDigest) {
        throw new Error("reviewer_dispatch_identity_collision: old sticky authority changed under marker lock");
      }
      controlEvidenceHelper.assertLineageApprovalNotConsumed({
        rootDir: context.control_evidence_root,
        approvalCommentId: currentApproval.receipt.approval_comment_id,
      });
    }
    await controlEvidenceHelper.reserveDispatchRecord({
      rootDir: context.control_evidence_root,
      record,
      predecessorMarker: plan.marker && markerSnapshot ? {
        file: plan.marker.file,
        snapshot: markerSnapshot,
        sha256: sha256(readFileSync(plan.marker.file)),
      } : null,
    });
    // D6/TL decision: record the review-round dispatch immediately once
    // reservation has actually succeeded, before carriers are published — a
    // throw here (review_round_state_write_failed) aborts this CAS attempt
    // the same way a reservation failure would, so the packet is never
    // delivered on a round the sidecar never durably recorded.
    recordRound();
    publishCarriers();
  };
  if (plan.type === "verified-fast-forward-head") {
    const marker = plan.marker;
    const postPrCompletionState = plan.state;
    const advanced = await postPrCompletionState.compareAndSwapPostPrCompletionHeadBinding({
      markerFile: marker.file,
      repositorySlug: context.repository_slug,
      prNumber: context.pr_number,
      expectedHeadRefOid: marker.head_ref_oid,
      expectedDispatchId: marker.expected_dispatch_id,
      nextHeadRefOid: context.head_ref_oid,
      nextDispatchId: context.dispatch_id,
      transaction,
      recoverStaleContender,
      beforeCommit: reserveBeforeCommit,
      executorKind: context.executor_kind,
    });
    if (advanced.status !== "updated") {
      throw new Error("reviewer_dispatch_identity_collision: pending post-PR marker head CAS failed");
    }
    return;
  }
  const marker = plan.marker;
  const expectedDispatchId = context.previous_dispatch_id ?? "";
  if (plan.type === "approved-non-fast-forward-rebind") {
    const rebound = await plan.state.compareAndSwapPostPrCompletionHeadBinding({
      markerFile: marker.file,
      repositorySlug: context.repository_slug,
      prNumber: context.pr_number,
      expectedHeadRefOid: marker.head_ref_oid,
      expectedDispatchId: marker.expected_dispatch_id,
      nextHeadRefOid: context.head_ref_oid,
      nextDispatchId: context.dispatch_id,
      lineageApprovalReceiptId: plan.approval.receipt.approval_comment_id,
      lineageApprovalAction: "rebind",
      transaction,
      recoverStaleContender,
      beforeCommit: reserveBeforeCommit,
      executorKind: context.executor_kind,
    });
    if (rebound.status !== "updated") {
      throw new Error("reviewer_dispatch_identity_collision: approved non-fast-forward marker CAS failed");
    }
    return;
  }
  if (plan.type === "approved-non-fast-forward-clear") {
    const initialObligation = plan.sourceState === "dispatch-marker" ? {
      schema: "devpro-post-pr-clear-obligation/v1",
      repository_slug: context.repository_slug,
      pr_number: context.pr_number,
      obligation_head_ref_oid: context.head_ref_oid,
      current_dispatch_id: context.dispatch_id,
      old_dispatch_id: marker.expected_dispatch_id,
      approval_receipt_id: plan.approval.receipt.approval_comment_id,
      first_dispatch_id: context.dispatch_id,
      created_at: new Date().toISOString(),
    } : undefined;
    const cleared = await plan.state.compareAndSwapPostPrCompletionHeadBinding({
      markerFile: marker.file,
      repositorySlug: context.repository_slug,
      prNumber: context.pr_number,
      expectedHeadRefOid: marker.head_ref_oid,
      expectedDispatchId: marker.expected_dispatch_id,
      nextHeadRefOid: context.head_ref_oid,
      nextDispatchId: context.dispatch_id,
      lineageApprovalReceiptId: plan.approval.receipt.approval_comment_id,
      lineageApprovalAction: "clear",
      lineageClearObligation: initialObligation,
      transaction,
      recoverStaleContender,
      beforeCommit: reserveBeforeCommit,
      executorKind: context.executor_kind,
    });
    if (cleared.status !== "updated") {
      throw new Error("reviewer_dispatch_identity_collision: approved non-fast-forward clear CAS failed");
    }
    return;
  }
  const result = await plan.state.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile: marker.file,
    repositorySlug: context.repository_slug,
    prNumber: context.pr_number,
    headRefOid: context.head_ref_oid,
    expectedDispatchId,
    nextDispatchId: context.dispatch_id,
    transaction,
    recoverStaleContender,
    beforeCommit: reserveBeforeCommit,
    executorKind: context.executor_kind,
  });
  if (result.status !== "updated") {
    throw new Error("reviewer_dispatch_identity_collision: pending post-PR marker CAS failed");
  }
}

export function getSecondReviewObservabilityContext(input, options = {}) {
  return prepareSecondReviewContext(input, options);
}

export function renderSecondReviewPacket(input, options = {}) {
  return prepareSecondReviewRender(input, options).packet;
}

// D5 (R5): `--void-external-dispatch <packet-dir>`. Step 1 is the same
// identity cross-validation D4 step 1 requires of accept-external-second-
// review.mjs (T5): the packet-dir's own observability-context.json must
// agree with the dispatch record it claims to belong to on every identity
// field, including carrier_root_id recomputed from the packet-dir argument
// itself (not trusted from the file) — otherwise a copied/relocated
// packet-dir could void a dispatch it was never issued for.
export async function voidExternalDispatch(packetDirArg, { controlEvidenceHelperOverride } = {}) {
  const helper = controlEvidenceHelperOverride ?? controlEvidenceHelper;
  const packetDir = path.resolve(String(packetDirArg ?? ""));
  const observabilityContextPath = path.join(packetDir, observabilityContextFileName);
  const identityCollision = (message) => {
    const error = new Error(`reviewer_dispatch_identity_collision: ${message}`);
    error.classification = "reviewer_dispatch_identity_collision";
    return error;
  };
  let observabilityContext;
  try {
    observabilityContext = JSON.parse(readFileSync(observabilityContextPath, "utf8"));
  } catch (error) {
    throw identityCollision(
      `cannot read ${observabilityContextFileName} under the given packet-dir: ${error.message}`
    );
  }
  if (!isPlainObject(observabilityContext)) {
    throw identityCollision(`${observabilityContextFileName} must be a JSON object`);
  }
  const dispatchId = observabilityContext.dispatch_id;
  const controlEvidenceRootValue = observabilityContext.control_evidence_root;
  if (typeof dispatchId !== "string" || dispatchId === ""
    || typeof controlEvidenceRootValue !== "string" || controlEvidenceRootValue === "") {
    throw identityCollision("observability context is missing dispatch_id or control_evidence_root");
  }
  const evidence = helper.readDispatchEvidence({
    rootDir: controlEvidenceRootValue,
    dispatchId,
  });
  const dispatchRecord = evidence.dispatch;
  const expectedCarrierRootId = sha256(Buffer.from(path.dirname(observabilityContextPath), "utf8"));
  const identityMatches = dispatchRecord
    && dispatchRecord.executor_kind === EXTERNAL_EVALUATOR_EXECUTOR_KIND
    && dispatchRecord.dispatch_id === dispatchId
    && dispatchRecord.repository_slug === observabilityContext.repository_slug
    && dispatchRecord.pr_number === observabilityContext.pr_number
    && dispatchRecord.head_ref_oid === observabilityContext.head_ref_oid
    && dispatchRecord.attempt_id === observabilityContext.attempt_id
    && dispatchRecord.carrier_root_id === expectedCarrierRootId;
  if (!identityMatches) {
    throw identityCollision("packet-dir observability context does not match its dispatch reservation");
  }
  await helper.writeExternalClosureSlot({
    rootDir: controlEvidenceRootValue,
    dispatchId,
    kind: "voided",
  });
  return helper.writeExternalVoidTerminalReceipt({
    rootDir: controlEvidenceRootValue,
    dispatchId,
  });
}

async function main() {
  sanitizeCmuxDispatchEnv(process.env);
  const rawArgs = process.argv.slice(2);
  const voidFlagIndex = rawArgs.indexOf("--void-external-dispatch");
  if (voidFlagIndex !== -1) {
    const packetDirValue = rawArgs[voidFlagIndex + 1];
    const hasOtherArgs = rawArgs.some((_value, index) => index !== voidFlagIndex && index !== voidFlagIndex + 1);
    if (!packetDirValue || hasOtherArgs) {
      console.error("Usage: render-second-review-packet.mjs --void-external-dispatch <packet-dir>");
      process.exit(2);
      return;
    }
    try {
      const result = await voidExternalDispatch(packetDirValue);
      console.log(result.path);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    return;
  }

  const inputPath = process.argv[2];
  const flagArgs = process.argv.slice(3);
  const carrierRootFlagIndex = flagArgs.indexOf("--carrier-root");
  const carrierRootValue = carrierRootFlagIndex === -1 ? undefined : flagArgs[carrierRootFlagIndex + 1];
  if (!inputPath || carrierRootFlagIndex === -1 || !carrierRootValue) {
    console.error("Usage: render-second-review-packet.mjs <handoff-json> --carrier-root <dir>");
    process.exit(2);
  }

  let input;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (error) {
    console.error(`Cannot read handoff JSON: ${error.message}`);
    process.exit(2);
  }

  try {
    const prepared = prepareSecondReviewRender(input, {
      autoCarrierRoot: true,
      carrierRootValue,
      env: process.env,
    });
    const outputPath = prepared.context.packet_path;
    recoverStalePublicationTransactions(prepared.context.control_evidence_root);
    assertInitialCarriersAvailable(prepared.context);
    const markerBindingPlan = await planPendingPostPrCompletionMarkerBinding(prepared.context, prepared.effective_input);
    writeCredentialGateSidecarFiles(prepared.context, prepared.effective_input);
    prepared.packet = buildSecondReviewPacket(prepared.effective_input, prepared.context);
    if (prepared.context.page_window_checkpoint_handoff === true) {
      prepared.context.reviewer_cli_recipe = selectReviewerCliRecipe(
        prepared.effective_input,
        prepared.context.neutral_cwd_path,
        {
          reviewer_model_selection: prepared.context.reviewer_model_selection,
          reviewer_opencode: prepared.context.reviewer_opencode,
          page_window_checkpoint_handoff: true,
          selected_effort: prepared.context.claude_selected_effort,
        },
      );
    }
    assertValidPacket(prepared.packet, resolveDeclaredPageWindowMaxPages(prepared.context.page_window_max_pages));
    controlEvidenceHelper.ensureDurableDirectory(
      path.dirname(prepared.context.context_path),
      0o700,
      { trustedParent: canonicalCarrierRoot }
    );
    const record = controlEvidenceHelper.secondReviewDispatchRecord({
      context: prepared.context,
      packetBytes: prepared.packet,
    });
    const entries = initialCarrierEntries(prepared, outputPath);
    const transaction = publicationTransaction({
      context: prepared.context,
      plan: markerBindingPlan,
      record,
      entries,
    });
    const publicationHandle = createPublicationTransaction(transaction);
    // D6/TL decision: recorded once reservation has actually succeeded, not
    // at packet-build time — see checkReviewRoundBudget/
    // recordReviewRoundBudgetDispatch doc comments.
    const recordRound = () => {
      const recorded = recordReviewRoundBudgetDispatch(
        prepared.context,
        prepared.review_round_budget,
        {
          attempt: prepared.effective_input.attempt,
          reviewScope: typeof prepared.effective_input.review_scope?.kind === "string"
            ? prepared.effective_input.review_scope.kind
            : "",
        }
      );
      // D6: disclose the override that just authorized this round, in the
      // SAME publication transaction, immediately after the round is durably
      // recorded and before carriers are published (both the no-marker and
      // marker-bound branches share this closure).
      appendRoundOverrideDisclosure(prepared.round_override_disclosure_plan);
      return recorded;
    };
    try {
      if (markerBindingPlan.type === "none") {
        await controlEvidenceHelper.reserveDispatchRecord({
          rootDir: prepared.context.control_evidence_root,
          record,
        });
        recordRound();
        publishCarriersWithLedger(publicationHandle, entries);
      } else {
        await bindPendingPostPrCompletionMarker(
          prepared.context,
          markerBindingPlan,
          transaction,
          () => {
            publishCarriersWithLedger(publicationHandle, entries);
          },
          recordRound
        );
      }
      removePublicationTransaction(publicationHandle);
    } catch (publicationError) {
      let recoveryOutcome;
      try {
        // Self-owned: this process created the envelope with an exclusive create and
        // still holds its exact bytes, and removePublicationTransaction re-verifies them
        // before unlinking. Without the grant a transaction the CAS just refused would
        // survive here and then have to wait out the staleness window before any later
        // render could clear it.
        recoveryOutcome = recoverPublicationTransaction(
          transaction,
          prepared.context.control_evidence_root,
          ORPHAN_SELF_OWNED
        );
        removePublicationTransaction(publicationHandle);
      } catch (recoveryError) {
        throw new Error(
          `${publicationError.message}; publication transaction recovery failed: ${recoveryError.message}`
        );
      }
      if (recoveryOutcome !== "committed") throw publicationError;
    }
    // Post-publish: material deny-list sidecar beside observability for accept/verify.
    writeCredentialGateSidecarCarrierCopy(prepared.context);
    console.log(outputPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
