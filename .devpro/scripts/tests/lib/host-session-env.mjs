/**
 * Host-marker env helpers for tests that assert or execute
 * `projection_runner_command` (design.md D1, D11; add-second-reviewer-runner-permission).
 *
 * Any test process invoked from an actual Claude Code CLI session already
 * has `CLAUDE_CODE_SESSION_ID` set in its own ambient `process.env` (the var
 * is inherited by every child process the CLI spawns, including whatever
 * spawns `node --test`). A test that spreads `...process.env` unfiltered
 * into a renderer/runner invocation would therefore silently get a
 * Claude-Code-host render when run interactively under Claude Code, and a
 * non-Claude-Code-host render in CI — two different behaviors for what
 * looks like the same test. These helpers give a caller an explicit,
 * ambient-independent starting point instead.
 *
 * `HOST_MARKER_ENV_KEYS` is the exact set of env var names any host
 * detection in this repo currently reads (design.md D1;
 * lib/session-usage-manifest.mjs `captureTlHostSession`;
 * hooks/pre-tool-gate.mjs `isCodexRuntime`; `platform-adapters/cursor.md`;
 * lib/projection-runner-carrier.mjs OpenCode markers, decisions.md D21),
 * so `envWithoutHostMarkers()` strips exactly those, not a guess.
 */
import { randomUUID } from "node:crypto";

export const HOST_MARKER_ENV_KEYS = Object.freeze([
  // Codex (hooks/pre-tool-gate.mjs isCodexRuntime; session-usage-manifest.mjs).
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "CODEX_SESSION_ID",
  "DEVPRO_HOOK_HOST",
  // Cursor (platform-adapters/cursor.md).
  "CURSOR_TRACE_ID",
  "CURSOR_SESSIONID",
  // OpenCode (lib/projection-runner-carrier.mjs; decisions.md D21).
  // `DEVPRO_HOOK_HOST` above is shared with the Codex clause.
  "OPENCODE_TERMINAL",
  // Claude Code / claude-code-adjacent identity hints (session-usage-manifest.mjs
  // captureTlHostSession; design.md D1 "未採用的做法" — CLAUDE_SESSION_ID and
  // CLAUDE_CONVERSATION_ID are identity hints, not host evidence, but are
  // stripped here too so a test's baseline is unambiguous either way).
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CONVERSATION_ID",
  "DEVPRO_POST_PR_COMPLETION_SESSION_ID",
  // Provider-neutral fallback (strengthen-host-session-neutrality).
  "DEVPRO_HOST_SESSION_ID",
]);

/** A syntactically valid session-id-shaped UUID, for tests that need "some
 * valid id" without asserting a specific value. */
export function validSessionId() {
  return randomUUID();
}

/** `base` (default `process.env`) with every known host marker deleted. */
export function envWithoutHostMarkers(base = process.env) {
  const env = { ...base };
  for (const key of HOST_MARKER_ENV_KEYS) delete env[key];
  return env;
}

/** `envWithoutHostMarkers()` plus a valid `CLAUDE_CODE_SESSION_ID` and no
 * Codex/Cursor/OpenCode marker — the env shape design.md D1 defines as the
 * Claude Code renderer host. */
export function claudeCodeHostEnv(overrides = {}) {
  return {
    ...envWithoutHostMarkers(),
    CLAUDE_CODE_SESSION_ID: validSessionId(),
    ...overrides,
  };
}
