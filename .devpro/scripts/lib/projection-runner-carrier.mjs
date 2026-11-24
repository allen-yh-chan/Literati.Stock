/**
 * D1/D3 (add-second-reviewer-runner-permission design.md): the single carrier
 * for "is this render/run happening on the Claude Code host" and "which of
 * the exactly-two canonical projection_runner_command shapes, if any, does
 * this value match". renderer/ack/runner all import from here instead of
 * duplicating the shape or host-marker logic (design.md D1 "沿用既有 host
 * marker 詞彙"; D3 "三處共用一個分類 helper").
 */
import path from "node:path";
import { isValidSessionIdShape } from "./session-token-usage.mjs";

// D1 step 1 — Codex markers, exact literals reused from
// hooks/pre-tool-gate.mjs `isCodexRuntime()` plus the `CODEX_SESSION_ID`
// candidate from `lib/session-usage-manifest.mjs` `captureTlHostSession`.
const CODEX_PRESENCE_ENV_KEYS = Object.freeze(["CODEX_THREAD_ID", "CODEX_CI", "CODEX_SESSION_ID"]);

// D1 step 1 — Cursor markers, exact literals reused from
// `platform-adapters/cursor.md` (`isCursorRuntime()` detection pair;
// design-review round 1 F-r1-01).
const CURSOR_PRESENCE_ENV_KEYS = Object.freeze(["CURSOR_TRACE_ID", "CURSOR_SESSIONID"]);

// D1 step 1 — OpenCode markers (decisions.md D21, post-PR cross-model round 1).
// `OPENCODE_TERMINAL` is written by OpenCode's own shell service into the
// environment of every command it runs (observed on OpenCode v2.0.11; other
// builds unverified). `DEVPRO_HOOK_HOST === "opencode"` is this repo's own host
// declaration (`hooks/run-hook.mjs` from the `--host=opencode` flag),
// symmetrical to the `"codex"` clause below. Both are veto markers: they only
// push a render toward the absolute carrier (the pre-change behavior).
const OPENCODE_PRESENCE_ENV_KEYS = Object.freeze(["OPENCODE_TERMINAL"]);

function hasNonBlankEnvValue(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value !== "";
}

function hasCodexMarker(env) {
  return CODEX_PRESENCE_ENV_KEYS.some((key) => hasNonBlankEnvValue(env, key))
    || env?.DEVPRO_HOOK_HOST === "codex";
}

function hasCursorMarker(env) {
  return CURSOR_PRESENCE_ENV_KEYS.some((key) => hasNonBlankEnvValue(env, key));
}

function hasOpenCodeMarker(env) {
  return OPENCODE_PRESENCE_ENV_KEYS.some((key) => hasNonBlankEnvValue(env, key))
    || env?.DEVPRO_HOOK_HOST === "opencode";
}

/**
 * D1 — exact 3-step predicate. Codex/Cursor/OpenCode markers win over
 * `CLAUDE_CODE_SESSION_ID` even when both are present (an inherited-but-stale
 * residual is not evidence the CURRENT host is Claude Code). Only
 * `CLAUDE_CODE_SESSION_ID` (via the existing `isValidSessionIdShape` UUID
 * whitelist) counts as positive Claude-Code-host evidence;
 * `DEVPRO_POST_PR_COMPLETION_SESSION_ID`, `CLAUDE_SESSION_ID`,
 * `CLAUDE_CONVERSATION_ID`, and the provider-neutral `DEVPRO_HOST_SESSION_ID`
 * are identity hints elsewhere in this repo, not host evidence for this
 * predicate (design.md D1 "未採用的做法"). A non-Claude host that exposes none
 * of the markers above yet inherits a valid `CLAUDE_CODE_SESSION_ID` is
 * classified as Claude Code; the runner's read-only cwd/node self-check is
 * its only backstop (design.md D1 "誤判後果都有界").
 */
export function isClaudeCodeRendererHost(env = process.env) {
  if (hasCodexMarker(env) || hasCursorMarker(env) || hasOpenCodeMarker(env)) return false;
  return isValidSessionIdShape(env?.CLAUDE_CODE_SESSION_ID);
}

// D2 — the fixed literal for the Claude Code host repo-relative carrier's
// argv[0]; equal to the existing `projection_runner_script` value.
export const PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL = ".devpro/scripts/run-second-reviewer-projection.mjs";

// D2 — the fixed literal for the Claude Code host repo-relative carrier's
// executable field.
export const PROJECTION_RUNNER_RELATIVE_EXECUTABLE_LITERAL = "node";

/**
 * D3 — the exactly-two canonical `projection_runner_command` shapes for a
 * given render/run. `runnerScriptAbsPath` is the caller's own
 * cwd-independent absolute path to the runner script (unused for the
 * repo-relative shape, whose argv[0] is always the fixed D2 literal above,
 * never derived from it); `contextPath` is resolved to an absolute path the
 * same way both canonical carriers must land on argv[1]; `execPath` is the
 * caller's own `process.execPath`.
 */
export function canonicalProjectionRunnerCarriers({ runnerScriptAbsPath, contextPath, execPath }) {
  const resolvedContextPath = path.resolve(String(contextPath ?? ""));
  return Object.freeze({
    absolute: Object.freeze({
      executable: execPath,
      argv: Object.freeze([runnerScriptAbsPath, resolvedContextPath]),
    }),
    repoRelative: Object.freeze({
      executable: PROJECTION_RUNNER_RELATIVE_EXECUTABLE_LITERAL,
      argv: Object.freeze([PROJECTION_RUNNER_RELATIVE_SCRIPT_LITERAL, resolvedContextPath]),
    }),
  });
}

function isExactCarrierShape(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "argv,executable"
    && Array.isArray(value.argv)
    && value.argv.length === 2;
}

function matchesCarrierExactly(actual, expected) {
  return actual.executable === expected.executable
    && actual.argv[0] === expected.argv[0]
    && actual.argv[1] === expected.argv[1];
}

/**
 * D3 — classifies `actual` against the two canonical shapes returned by
 * `canonicalProjectionRunnerCarriers`. Returns `"absolute"`,
 * `"repo-relative"`, or `null` for anything else (legacy string, wrong own
 * keys, wrong argv length, or a mixed shape such as `node` paired with an
 * absolute script path, or `process.execPath` paired with the relative
 * script literal).
 */
export function classifyProjectionRunnerCarrier(actual, canonical) {
  if (!isExactCarrierShape(actual)) return null;
  if (matchesCarrierExactly(actual, canonical.absolute)) return "absolute";
  if (matchesCarrierExactly(actual, canonical.repoRelative)) return "repo-relative";
  return null;
}
