#!/usr/bin/env node
/**
 * Probe-backed Claude second-reviewer effort selector (design D1 + D1a).
 *
 * Order: help-filter → functional micro-probe for `xhigh`; only if xhigh is
 * compatible, conditionally probe `max` as upgrade. Fail closed on xhigh
 * incompatibility or any indeterminate/error classification. Never falls back
 * to `high` or omits `--effort`.
 *
 * CI / unit tests: set DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB=xhigh|max|fail
 * to skip live Claude. Stub is honored ONLY when also allowed via
 * DEVPRO_ALLOW_CLAUDE_EFFORT_STUB=1 or NODE_ENV=test; otherwise a set stub
 * fails closed as recipe_unresolved (no silent production bypass).
 */
import { spawnSync } from "node:child_process";
import {
  ReviewerFamilyContractError,
  resolveCanonicalReviewerFamily,
} from "./second-review-material-contract.mjs";
import {
  SECOND_REVIEWER_MODEL_OVERRIDE_ENV,
  resolveSecondReviewerModel,
  assertReviewerModelSelection,
} from "./second-reviewer-cli-recipe-contract.mjs";
import { escapeRegExp } from "./lib/primitives.mjs";

export const CLAUDE_EFFORT_STUB_ENV = "DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB";
export const CLAUDE_EFFORT_STUB_ALLOW_ENV = "DEVPRO_ALLOW_CLAUDE_EFFORT_STUB";
export const CLAUDE_EFFORT_CANDIDATES = Object.freeze(["xhigh", "max"]);

const EFFORT_PROBE_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
  },
});

const EFFORT_PROBE_PROMPT = "Return only the completion JSON required by --json-schema.";

const BOUNDED_SUMMARY_MAX_CHARS = 240;
const HELP_PROBE_DEFAULT_TIMEOUT_MS = 15000;
const FUNCTIONAL_PROBE_DEFAULT_TIMEOUT_MS = 90000;
export const HELP_PROBE_TIMEOUT_CEILING_MS = 30000;
export const FUNCTIONAL_PROBE_TIMEOUT_CEILING_MS = 90000;

export class ClaudeEffortSelectionError extends Error {
  constructor(message, classification, evidence = null) {
    super(message);
    this.name = "ClaudeEffortSelectionError";
    this.classification = classification;
    this.effort_selection = evidence;
  }
}

export function helpListsEffortValue(helpText, effort) {
  const text = String(helpText ?? "");
  // Match effort value as a help enum token, not a substring of another word.
  const pattern = new RegExp(
    `(?:^|[\\s,|/{(\\[])${escapeRegExp(effort)}(?=$|[\\s,|/})\\]])`,
    "i",
  );
  return pattern.test(text);
}

function boundedSummary(text) {
  const normalized = String(text ?? "")
    .replace(/https?:\/\/\S+/gi, "<redacted-url>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(/\b(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_-]{8,}\b/g, "<redacted-secret>")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= BOUNDED_SUMMARY_MAX_CHARS) return normalized;
  return `${normalized.slice(0, BOUNDED_SUMMARY_MAX_CHARS)}…`;
}

function redactedCandidateResult(result) {
  return {
    effort: result.effort,
    classification: result.classification,
    summary: boundedSummary(result.summary),
  };
}

function buildEvidence({ status, selected_effort = null, classification, candidates, requestedModel }) {
  return {
    status,
    selected_effort,
    classification,
    requested_model: requestedModel,
    candidates: (candidates ?? []).map(redactedCandidateResult),
  };
}

function throwProbeConfigurationError(classification, purpose, summary, requestedModel) {
  const evidence = buildEvidence({
    status: "blocked",
    classification,
    candidates: [{
      effort: purpose,
      classification,
      summary,
    }],
    requestedModel,
  });
  throw new ClaudeEffortSelectionError(
    `claude ${summary}`,
    classification,
    evidence,
  );
}

function assertValidProbeTimeout(timeoutMs, purpose, ceilingMs, requestedModel) {
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= ceilingMs) return;
  throwProbeConfigurationError(
    "probe_timeout_invalid",
    purpose,
    `${purpose} probe timeout must be a positive safe integer <= ${ceilingMs}`,
    requestedModel,
  );
}

// D10: effort_ceiling gates which candidate the ladder is allowed to select,
// not which candidates it is allowed to probe-compare against xhigh — the
// domain is the same closed set the ladder itself walks.
function assertValidEffortCeiling(effortCeiling, requestedModel) {
  if (CLAUDE_EFFORT_CANDIDATES.includes(effortCeiling)) return;
  throwProbeConfigurationError(
    "effort_ceiling_invalid",
    "effort_ceiling",
    `effort_ceiling must be one of: ${CLAUDE_EFFORT_CANDIDATES.join(", ")}`,
    requestedModel,
  );
}

function assertTestOnlySpawnSyncImpl(spawnSyncImpl, env, requestedModel) {
  if (spawnSyncImpl === undefined) return;
  if (typeof spawnSyncImpl === "function" && env?.NODE_ENV === "test") return;
  throwProbeConfigurationError(
    "probe_spawn_injection_invalid",
    "spawnSyncImpl",
    "spawnSyncImpl injection requires resolved NODE_ENV=test",
    requestedModel,
  );
}

export function buildClaudeEffortMicroProbeArgv(effort, requestedModel) {
  if (effort !== "xhigh" && effort !== "max") {
    throw new Error(`effort micro-probe only accepts xhigh|max; got ${effort}`);
  }
  if (typeof requestedModel !== "string" || requestedModel.length === 0) {
    // D9: effort compatibility is a property OF a specific model; the caller
    // MUST supply the resolved requested model so the probe never silently
    // reverts to a different model than the one actually being dispatched.
    throw new Error("effort micro-probe requires a resolved requestedModel");
  }
  // Fixed no-tool / no-write profile: dispatch-equivalent compatibility flags,
  // resolved --model, empty --tools, no --allowedTools / Write / Bash / sticky.
  // Positional prompt MUST come before `--tools` — Claude's `--tools` is variadic
  // and would otherwise consume the prompt as a tool name (live: "Input must be
  // provided either through stdin or as a prompt argument when using --print").
  return [
    "-p",
    EFFORT_PROBE_PROMPT,
    "--safe-mode",
    "--model",
    requestedModel,
    "--effort",
    effort,
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    EFFORT_PROBE_JSON_SCHEMA,
    "--tools",
    "",
  ];
}

const AUTH_EVENT_TYPES = new Set(["error", "control"]);
const AUTH_STATUS_FIELD_TOP = Object.freeze(["http_status", "status_code", "error_code"]);
const AUTH_STATUS_FIELD_NESTED = Object.freeze(["http_status", "status_code", "code"]);
const AUTH_PHRASE_RE = /not[_\s-]?logged[_\s-]?in|authentication[_\s-]?fail|unauthorized|login required/i;

function isExactAuthHttpStatus(value) {
  return value === 401 || value === 403 || value === "401" || value === "403";
}

function recordHasAllowlistedAuthStatus(record) {
  if (!record || typeof record !== "object") return false;
  for (const key of AUTH_STATUS_FIELD_TOP) {
    if (isExactAuthHttpStatus(record[key])) return true;
  }
  const nested = record.error;
  if (nested && typeof nested === "object") {
    for (const key of AUTH_STATUS_FIELD_NESTED) {
      if (isExactAuthHttpStatus(nested[key])) return true;
    }
  }
  return false;
}

function tryParseJsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const ERROR_SHAPED_RESULT_SUBTYPE_RE =
  /^(?:error|failure)(?:$|[_-])|not[_\s-]?logged|auth(?:enticat|oriz)|unauthorized|login[_\s-]?required/i;

/**
 * Error-shaped stream-json `type:"result"` records (is_error / failure subtype).
 * Successful results are intentionally excluded so payload phrases/digits are not scanned.
 */
function isErrorShapedResultRecord(record) {
  if (!record || typeof record !== "object" || record.type !== "result") return false;
  if (record.is_error === true) return true;
  const subtype = String(record.subtype ?? "").trim();
  if (!subtype) return false;
  return ERROR_SHAPED_RESULT_SUBTYPE_RE.test(subtype);
}

function recordHasTypedAuthEvidence(record) {
  if (recordHasAllowlistedAuthStatus(record)) return true;
  return AUTH_PHRASE_RE.test(JSON.stringify(record));
}

/**
 * D1 auth detection: typed exact 401/403 on error|control and error-shaped result
 * records; auth phrases on stderr, non-successful-result stdout lines, or those
 * allowlisted records. Never scans successful type=result payloads; no bare
 * 401|403 substring match.
 */
function detectFunctionalProbeAuthFailure(stdout, stderr) {
  if (AUTH_PHRASE_RE.test(stderr)) return true;

  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    const parsed = tryParseJsonLine(line);
    if (parsed?.type === "result") {
      // Skip only successful type=result payloads (4011 / embedded-phrase false positives).
      if (!isErrorShapedResultRecord(parsed)) continue;
      if (recordHasTypedAuthEvidence(parsed)) return true;
      continue;
    }
    if (parsed && AUTH_EVENT_TYPES.has(parsed.type)) {
      if (recordHasTypedAuthEvidence(parsed)) return true;
      continue;
    }
    if (AUTH_PHRASE_RE.test(line)) return true;
  }

  for (const line of String(stderr).split(/\r?\n/)) {
    if (!line) continue;
    const parsed = tryParseJsonLine(line);
    if (parsed && AUTH_EVENT_TYPES.has(parsed.type) && recordHasAllowlistedAuthStatus(parsed)) {
      return true;
    }
  }
  return false;
}

/**
 * Text the keyword checks may read: stderr, plain-text stdout lines, and error-shaped
 * stream records. Success-shaped records (init, assistant, successful result) carry
 * host-derived values such as cwd, branch-named paths and command names, which are
 * not failure evidence.
 */
function functionalProbeDiagnosticText(stdout, stderr) {
  const kept = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    const parsed = tryParseJsonLine(line);
    if (!parsed || parsed.type === "error" || isErrorShapedResultRecord(parsed)) kept.push(line);
  }
  return `${kept.join("\n")}\n${stderr}`;
}

// Only provider/control fields and plain CLI diagnostics are evidence. Init,
// successful result payloads and assistant message content are opaque data.
function functionalProbeRateLimitEvidence(stdout, stderr, { allowPlainDiagnostics = true } = {}) {
  const rateTypes = new Set(["rate_limit", "rate_limit_error", "quota_exceeded", "insufficient_quota"]);
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const record = tryParseJsonLine(line);
    if (!record) {
      if (allowPlainDiagnostics && !/^\s*[\[{]/.test(line)
        && /rate[_ -]?limit|too many requests|(?:hit|reached|exceeded).{0,40}(?:session|usage|quota).{0,20}limit|(?:quota|usage limit|session limit).{0,24}(?:exceeded|exhausted)|insufficient[_ -]?quota/i.test(line)) {
        return "Claude functional probe blocked by provider rate limit or quota (CLI diagnostic)";
      }
      continue;
    }
    const eligible = AUTH_EVENT_TYPES.has(record.type)
      || record.type === "rate_limit_event"
      || (record.type === "assistant" && record.error != null)
      || isErrorShapedResultRecord(record);
    if (!eligible) continue;
    const error = record.error;
    const types = [record.subtype, typeof error === "string" ? error : null, error?.type, error?.code];
    const statuses = [record.http_status, record.status_code, record.statusCode, record.status,
      error?.http_status, error?.status_code, error?.statusCode, error?.status, error?.code];
    if (types.some((type) => rateTypes.has(type))
      || statuses.some((status) => status === 429 || status === "429")
      || (record.type === "rate_limit_event"
        && !["allowed", "allowed_warning"].includes(record.rate_limit_info?.status))) {
      return "Claude functional probe blocked by provider rate limit or quota (typed control evidence)";
    }
  }
  return null;
}

export function classifyFunctionalProbeResult(result) {
  if (!result || typeof result !== "object") {
    return {
      classification: "malformed_stream",
      summary: "functional probe returned no result object",
    };
  }
  if (result.classification) {
    return {
      classification: String(result.classification),
      summary: boundedSummary(result.summary ?? result.classification),
    };
  }

  const status = result.status;
  const errorCode = String(result.error_code ?? result.code ?? "");
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;
  const diagnostic = functionalProbeDiagnosticText(stdout, stderr);
  const timedOut = result.timed_out === true
    || errorCode === "ETIMEDOUT"
    || /timed out|timeout/i.test(diagnostic);
  if (timedOut) {
    return { classification: "timeout", summary: boundedSummary(combined || "probe timed out") };
  }
  if (errorCode === "ENOTFOUND" || errorCode === "ECONNREFUSED" || errorCode === "ECONNRESET"
    || /network|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i.test(diagnostic)) {
    return { classification: "network_failure", summary: boundedSummary(combined || errorCode) };
  }
  if (result.spawn_error || errorCode === "ENOENT" || result.error) {
    return {
      classification: "spawn_failed",
      summary: boundedSummary(String(result.error ?? errorCode ?? "spawn failed")),
    };
  }

  const authHit = detectFunctionalProbeAuthFailure(stdout, stderr);
  if (authHit) {
    return { classification: "auth_failure", summary: boundedSummary(combined) };
  }

  const resultRecords = stdout.split(/\r?\n/).map(tryParseJsonLine)
    .filter((record) => record?.type === "result");
  const hasErrorResult = resultRecords.some(isErrorShapedResultRecord);
  const hasSuccessfulResult = resultRecords.some((record) => !isErrorShapedResultRecord(record));
  // Functional-probe auth precedence is distinct from the runner's terminal
  // classifier. A parsed successful completion also makes plain path/telemetry
  // tokens non-evidence; typed provider/control failures still block dispatch.
  const rateLimitSummary = functionalProbeRateLimitEvidence(stdout, stderr, {
    allowPlainDiagnostics: !(status === 0 && hasSuccessfulResult && !hasErrorResult),
  });
  if (rateLimitSummary) {
    return { classification: "claude_reviewer_provider_rate_limited", summary: rateLimitSummary };
  }

  const incompatHit = /(?:--(?:effort|thinking|reasoning|model)\b|\b(?:effort|thinking|reasoning|model)\b)/i
    .test(diagnostic)
    && /\b(?:unsupported|not supported|invalid|unknown|not allowed|incompatible|unrecognized)\b/i
      .test(diagnostic);
  if (incompatHit || Number(status) === 400) {
    return { classification: "incompatible", summary: boundedSummary(combined) };
  }

  if (result.malformed_stream === true
    || (/stream-json|json/i.test(diagnostic) && /malformed|parse|unexpected/i.test(diagnostic))) {
    return { classification: "malformed_stream", summary: boundedSummary(combined) };
  }

  // A provider execution failure is not evidence that an effort tier is
  // incompatible. Keep it indeterminate even at exit 0 or during a max upgrade.
  if (hasErrorResult) {
    return { classification: "probe_execution_failed", summary: "Claude functional probe returned an error result" };
  }

  if (status === 0) {
    // Exit 0 alone is not compatible: require a stream-json "type":"result" line
    // (design D1a). Error-only streams stay incompatible/auth; missing result is
    // malformed_stream (dispatch-blocking).
    const hasResultLine = hasSuccessfulResult;
    const hasErrorLine = /"type"\s*:\s*"error"/.test(stdout);
    if (hasErrorLine && !hasResultLine) {
      return { classification: "incompatible", summary: boundedSummary(combined) };
    }
    if (!hasResultLine) {
      return {
        classification: "malformed_stream",
        summary: boundedSummary(combined || "exit 0 without stream-json type=result line"),
      };
    }
    return { classification: "compatible", summary: "functional micro-probe accepted" };
  }

  if (status == null) {
    return { classification: "malformed_stream", summary: boundedSummary(combined || "missing status") };
  }
  return {
    classification: "incompatible",
    summary: boundedSummary(combined || `exit ${status}`),
  };
}

function defaultRunHelpProbe(options = {}) {
  const executable = options.executable ?? "claude";
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(executable, ["-p", "--help"], {
    encoding: "utf8",
    timeout: options.timeout_ms ?? HELP_PROBE_DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      ok: false,
      classification: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn_failed",
      summary: String(result.error.message ?? result.error),
      text: "",
    };
  }
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    const authHit = /not logged in|authentication|unauthorized/i.test(text);
    return {
      ok: false,
      classification: authHit ? "auth_failure" : "spawn_failed",
      summary: boundedSummary(text || `help exit ${result.status}`),
      text,
    };
  }
  return { ok: true, classification: "help_ok", summary: "help probe ok", text };
}

function defaultRunFunctionalProbe(effort, options = {}) {
  const executable = options.executable ?? "claude";
  const argv = buildClaudeEffortMicroProbeArgv(effort, options.requestedModel);
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(executable, argv, {
    encoding: "utf8",
    timeout: options.timeout_ms ?? FUNCTIONAL_PROBE_DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    error: result.error?.message ?? null,
    error_code: result.error?.code ?? null,
    timed_out: result.error?.code === "ETIMEDOUT",
    spawn_error: Boolean(result.error && result.error.code === "ENOENT"),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const INDETERMINATE = new Set([
  "timeout",
  "probe_execution_failed",
  "claude_reviewer_provider_rate_limited",
  "auth_failure",
  "network_failure",
  "malformed_stream",
  "spawn_failed",
]);

function isIndeterminate(classification) {
  return INDETERMINATE.has(classification);
}

function isClaudeEffortStubAllowed(env) {
  return env?.[CLAUDE_EFFORT_STUB_ALLOW_ENV] === "1" || env?.NODE_ENV === "test";
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.help_timeout_ms]
 * @param {number} [options.functional_timeout_ms]
 * @param {number} [options.timeout_ms]
 * @param {"xhigh"|"max"} [options.effort_ceiling] Highest selectable tier; default xhigh (D10).
 * @param {typeof spawnSync} [options.spawnSyncImpl]
 * @param {(probeOptions: { timeout_ms: number }) => { ok: boolean, classification: string, summary?: string, text?: string }} [options.runHelpProbe]
 * @param {(effort: string, probeOptions: { timeout_ms: number }) => object} [options.runFunctionalProbe]
 * @returns {{ status: "ok"|"blocked", selected_effort: string|null, classification: string, requested_model: string, candidates: object[] }}
 */
export function selectClaudeSecondReviewerEffort(options = {}) {
  const family = resolveCanonicalReviewerFamily(options.reviewer_family);
  if (family.cli_family !== "claude") {
    throw new ReviewerFamilyContractError();
  }
  const env = options.env ?? process.env;
  assertTestOnlySpawnSyncImpl(options.spawnSyncImpl, env, options.reviewer_model_selection?.requested ?? "");
  // D9: resolved once, from the same single source recipe contract owns, and
  // threaded through every probe + evidence field below — the probe MUST test
  // the model that will actually be dispatched, never a second hardcoded value.
  // D3: shape-validate env-override HERE, before any probe subprocess (or stub
  // short-circuit). Renderer also validates, but this selector is a public
  // entry point — a malformed override MUST NOT reach argv/`spawnSync`.
  const selection = options.reviewer_model_selection;
  if (selection) assertReviewerModelSelection(selection, family.cli_family);
  let resolvedReviewerModel;
  try { resolvedReviewerModel = selection ? {model: selection.requested, source: selection.source}
    : resolveSecondReviewerModel(family.cli_family, env, {probeModel: options.modelProbe}); }
  catch (error) {
    if (error.classification !== "reviewer_model_override_invalid") throw error;
    throwProbeConfigurationError(error.classification, "requested_model", error.message,
      String(env[SECOND_REVIEWER_MODEL_OVERRIDE_ENV[family.cli_family]] ?? ""));
  }
  const requestedModel = resolvedReviewerModel.model;
  const stub = String(env[CLAUDE_EFFORT_STUB_ENV] ?? "").trim();
  const helpProbeOptions = {
    timeout_ms: options.help_timeout_ms ?? options.timeout_ms ?? HELP_PROBE_DEFAULT_TIMEOUT_MS,
  };
  const functionalProbeOptions = {
    timeout_ms: options.functional_timeout_ms
      ?? options.timeout_ms
      ?? FUNCTIONAL_PROBE_DEFAULT_TIMEOUT_MS,
    requestedModel,
  };
  assertValidProbeTimeout(
    helpProbeOptions.timeout_ms,
    "help",
    HELP_PROBE_TIMEOUT_CEILING_MS,
    requestedModel,
  );
  assertValidProbeTimeout(
    functionalProbeOptions.timeout_ms,
    "functional",
    FUNCTIONAL_PROBE_TIMEOUT_CEILING_MS,
    requestedModel,
  );
  const effortCeiling = options.effort_ceiling ?? "xhigh";
  assertValidEffortCeiling(effortCeiling, requestedModel);

  if (stub !== "" && !isClaudeEffortStubAllowed(env)) {
    return buildEvidence({
      status: "blocked",
      selected_effort: null,
      classification: "recipe_unresolved",
      candidates: [{
        effort: "stub",
        classification: "recipe_unresolved",
        summary: `${CLAUDE_EFFORT_STUB_ENV} set without ${CLAUDE_EFFORT_STUB_ALLOW_ENV}=1 or NODE_ENV=test`,
      }],
      requestedModel,
    });
  }

  if (stub === "xhigh" || stub === "max") {
    if (stub === "max" && effortCeiling === "xhigh") {
      return buildEvidence({
        status: "blocked",
        selected_effort: null,
        classification: "effort_stub_exceeds_ceiling",
        candidates: [{
          effort: "max",
          classification: "effort_stub_exceeds_ceiling",
          summary: `stub:max exceeds effort_ceiling:${effortCeiling}`,
        }],
        requestedModel,
      });
    }
    return buildEvidence({
      status: "ok",
      selected_effort: stub,
      classification: "stub_selected",
      candidates: [{ effort: stub, classification: "stub_selected", summary: `stub:${stub}` }],
      requestedModel,
    });
  }
  if (stub === "fail") {
    return buildEvidence({
      status: "blocked",
      selected_effort: null,
      classification: "recipe_unresolved",
      candidates: [{
        effort: "xhigh",
        classification: "recipe_unresolved",
        summary: "stub:fail",
      }],
      requestedModel,
    });
  }
  if (stub !== "") {
    return buildEvidence({
      status: "blocked",
      selected_effort: null,
      classification: "recipe_unresolved",
      candidates: [{
        effort: "stub",
        classification: "recipe_unresolved",
        summary: `unsupported stub value: ${boundedSummary(stub)}`,
      }],
      requestedModel,
    });
  }

  const runHelpProbe = options.runHelpProbe
    ?? ((probeOptions) => defaultRunHelpProbe({ ...options, ...probeOptions }));
  const runFunctionalProbe = options.runFunctionalProbe
    ?? ((effort, probeOptions) => defaultRunFunctionalProbe(
      effort,
      { ...options, ...probeOptions },
    ));

  const candidates = [];
  const help = runHelpProbe(helpProbeOptions);
  if (!help?.ok) {
    const classification = help?.classification && isIndeterminate(help.classification)
      ? help.classification
      : (help?.classification ?? "spawn_failed");
    candidates.push({
      effort: "help",
      classification,
      summary: help?.summary ?? "help probe failed",
    });
    return buildEvidence({
      status: "blocked",
      classification: isIndeterminate(classification) ? classification : "recipe_unresolved",
      candidates,
      requestedModel,
    });
  }

  const helpText = help.text ?? "";

  // Step 1: xhigh
  if (!helpListsEffortValue(helpText, "xhigh")) {
    candidates.push({
      effort: "xhigh",
      classification: "incompatible",
      summary: "xhigh absent from claude -p --help enum",
    });
    return buildEvidence({
      status: "blocked",
      classification: "reviewer_cli_recipe_incompatible",
      candidates,
      requestedModel,
    });
  }

  const xhighRaw = runFunctionalProbe("xhigh", functionalProbeOptions);
  const xhigh = classifyFunctionalProbeResult(xhighRaw);
  candidates.push({ effort: "xhigh", ...xhigh });

  if (isIndeterminate(xhigh.classification)) {
    return buildEvidence({
      status: "blocked",
      classification: xhigh.classification,
      candidates,
      requestedModel,
    });
  }
  if (xhigh.classification !== "compatible") {
    return buildEvidence({
      status: "blocked",
      classification: "reviewer_cli_recipe_incompatible",
      candidates,
      requestedModel,
    });
  }

  // Step 2: only if xhigh compatible, conditionally try max — capped by effort_ceiling
  // (D10): a ceiling of "xhigh" MUST NOT select max even when the CLI help enum lists
  // it, so no functional probe of max runs in that case; the candidate ledger still
  // records the capped-away tier for evidence.
  if (!helpListsEffortValue(helpText, "max")) {
    return buildEvidence({
      status: "ok",
      selected_effort: "xhigh",
      classification: "highest_compatible",
      candidates,
      requestedModel,
    });
  }

  if (effortCeiling === "xhigh") {
    candidates.push({
      effort: "max",
      classification: "ceiling_capped",
      summary: "max help-compatible but capped by effort_ceiling:xhigh",
    });
    return buildEvidence({
      status: "ok",
      selected_effort: "xhigh",
      classification: "highest_compatible",
      candidates,
      requestedModel,
    });
  }

  const maxRaw = runFunctionalProbe("max", functionalProbeOptions);
  const maxResult = classifyFunctionalProbeResult(maxRaw);
  candidates.push({ effort: "max", ...maxResult });

  if (isIndeterminate(maxResult.classification)) {
    return buildEvidence({
      status: "blocked",
      classification: maxResult.classification,
      candidates,
      requestedModel,
    });
  }
  if (maxResult.classification === "compatible") {
    return buildEvidence({
      status: "ok",
      selected_effort: "max",
      classification: "highest_compatible",
      candidates,
      requestedModel,
    });
  }

  // max incompatible → keep xhigh (upgrade declined)
  return buildEvidence({
    status: "ok",
    selected_effort: "xhigh",
    classification: "highest_compatible",
    candidates,
    requestedModel,
  });
}

export function assertClaudeEffortSelectionReady(selection) {
  if (!selection || selection.status !== "ok"
    || (selection.selected_effort !== "xhigh" && selection.selected_effort !== "max")) {
    throw new ClaudeEffortSelectionError(
      `claude effort selection blocked (${selection?.classification ?? "recipe_unresolved"}); `
        + "MUST NOT dispatch with --effort high or omit --effort/--model",
      selection?.classification ?? "recipe_unresolved",
      selection ?? null,
    );
  }
  return selection.selected_effort;
}
