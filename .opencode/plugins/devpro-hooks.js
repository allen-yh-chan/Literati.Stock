/**
 * OpenCode ↔ shared run-hook bridge (dependency-free project plugin).
 *
 * Auto-discovered by OpenCode CLI 1.18.29 as `.opencode/plugins/*.js`.
 * Policy SSOT remains `.devpro/scripts/hooks/run-hook.mjs` + gates.
 * Rules source: the repo `.devpro` by default; `DEVPRO_RULES_ROOT`, only when
 * explicitly set, moves run-hook, the gates and `github-mcp-tools` together to
 * `<DEVPRO_RULES_ROOT>/scripts/hooks/` (see `resolveRulesSource`).
 * This file only: normalize events/payloads, invoke shared runner, translate
 * decisions onto OpenCode tool/permission surfaces, and maintain idle host-
 * control state (reminder delivery + subsequent deny). MUST NOT import
 * third-party packages; MUST NOT reimplement gate semantics.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = "opencode";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// .opencode/plugins → repo root
const DEFAULT_REPO_ROOT = path.resolve(HERE, "../..");

/**
 * Git Bash drive form (`/c/rules`) → `C:/rules` on win32; anything else as is.
 * Mirrors the inline launcher in the runtime hook configs.
 */
export function normalizeRulesRootValue(value, platform = process.platform) {
  if (platform === "win32" && /^\/[a-zA-Z]\//.test(value)) {
    return value[1].toUpperCase() + ":" + value.slice(2);
  }
  return value;
}

/**
 * Where the shared runner, the gates and their libraries are loaded from — the
 * same order as the inline hook launcher in `.claude/settings.json` /
 * `.codex/hooks.json` / `.cursor/hooks.json`:
 *
 *   - `DEVPRO_RULES_ROOT` unset or empty → the repo `.devpro` (`source: "repo"`).
 *   - `DEVPRO_RULES_ROOT` set → `<root>/scripts/hooks/` (`source: "env"`), with a
 *     relative value resolved against the cwd; on win32 a Git Bash drive path
 *     (`/c/rules`) is read as `C:/rules`, the same as the inline launcher. The root is pinned to its real
 *     path, so a `current` symlink switched mid-session cannot leave the cached
 *     `github-mcp-tools` import and later spawns on different versions.
 *     `usable: false` means that root has no runner; nothing is replaced with
 *     the repo copy — spawns fail as runner failures (GitHub writes stay denied).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ repoRoot?: string, cwd?: string, exists?: (p: string) => boolean, realpath?: (p: string) => string, platform?: string, path?: typeof path }} [deps]
 * @returns {{ source: "repo" | "env", root: string, hooksDir: string, runHook: string, usable: boolean }}
 */
export function resolveRulesSource(env = process.env, deps = {}) {
  const repoRoot = deps.repoRoot || DEFAULT_REPO_ROOT;
  const exists = deps.exists || existsSync;
  const realpath = deps.realpath || realpathSync;
  const p = deps.path || path;
  const raw = env && typeof env.DEVPRO_RULES_ROOT === "string" ? env.DEVPRO_RULES_ROOT : "";
  if (!raw) {
    const root = p.join(repoRoot, ".devpro");
    const hooksDir = p.join(root, "scripts", "hooks");
    const runHook = p.join(hooksDir, "run-hook.mjs");
    return { source: "repo", root, hooksDir, runHook, usable: exists(runHook) };
  }
  const override = normalizeRulesRootValue(raw, deps.platform || process.platform);
  let root = p.resolve(deps.cwd || process.cwd(), override);
  try {
    root = realpath(root);
  } catch {
    // Missing root: keep the resolved path so diagnostics name it.
  }
  const hooksDir = p.join(root, "scripts", "hooks");
  const runHook = p.join(hooksDir, "run-hook.mjs");
  return { source: "env", root, hooksDir, runHook, usable: exists(runHook) };
}

const RULES_SOURCE = resolveRulesSource();
const DEFAULT_RUN_HOOK = RULES_SOURCE.runHook;
const HOOKS_DIR = RULES_SOURCE.hooksDir;

/**
 * Why the overriding rules root cannot be used, or null. Set at load when the
 * root has no runner or its `github-mcp-tools` cannot be loaded. The root is
 * then unusable as a whole: no spawn runs anything (each fails with this named
 * cause, so GitHub writes are denied), never a mix of root and repo copies.
 */
let rulesUnavailable =
  RULES_SOURCE.source === "env" && !RULES_SOURCE.usable
    ? `DEVPRO_RULES_ROOT has no scripts/hooks/run-hook.mjs: ${RULES_SOURCE.root}`
    : null;

/**
 * `github-mcp-tools` from the same root as the runner. If the overriding root
 * is unusable, nothing is used from it; the repo copy is loaded for one purpose
 * only: GitHub tools are still recognised, so their writes reach the failing
 * runner path and stay denied instead of passing as unknown tools.
 */
async function loadGithubMcpTools() {
  if (RULES_SOURCE.source === "env" && rulesUnavailable === null) {
    const lib = path.join(HOOKS_DIR, "lib", "github-mcp-tools.mjs");
    try {
      const mod = await import(pathToFileURL(lib).href);
      if (typeof mod.devproGithubToolName === "function" && typeof mod.isGithubWritePayload === "function") return mod;
      rulesUnavailable = `DEVPRO_RULES_ROOT github-mcp-tools lacks its exports: ${lib}`;
    } catch (err) {
      rulesUnavailable = `DEVPRO_RULES_ROOT github-mcp-tools failed to load: ${lib}: ${err && err.message ? err.message : err}`;
    }
  }
  return import("../../.devpro/scripts/hooks/lib/github-mcp-tools.mjs");
}
const { devproGithubToolName, isGithubWritePayload } = await loadGithubMcpTools();

/** Runner result for every spawn while the overriding rules root is unusable. */
function rulesUnavailableResult() {
  const error = new Error(`run-hook: ${rulesUnavailable}`);
  error.code = "DEVPRO_RULES_ROOT_UNUSABLE";
  return { status: 1, stdout: "", stderr: error.message, error };
}

/**
 * Runner script for one spawn. With an overriding rules root it is always that
 * root's runner. Otherwise the plugin's own repo runner, or — when the plugin
 * file sits outside a repo — the session directory's.
 */
function resolveRunHookScript(cwd) {
  if (RULES_SOURCE.source === "env" || existsSync(DEFAULT_RUN_HOOK)) return DEFAULT_RUN_HOOK;
  return path.join(cwd || DEFAULT_REPO_ROOT, ".devpro/scripts/hooks/run-hook.mjs");
}
/** Must stay aligned with `.devpro/scripts/hooks/run-hook.mjs` MAX_HOOK_TIMEOUT_MS. */
const MAX_HOOK_TIMEOUT_MS = 180_000;

function resolvePluginHookTimeoutMs(env = process.env) {
  const raw = env.DEVPRO_HOOK_TIMEOUT_MS;
  if (!raw) return MAX_HOOK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_HOOK_TIMEOUT_MS;
  // Math.max(1, …): a timeout of 0 means "no timeout" to the spawn layer, so a sub-millisecond value must not floor to 0.
  return Math.min(Math.max(1, Math.floor(parsed)), MAX_HOOK_TIMEOUT_MS);
}

/** @typedef {"supported"|"unsupported"|"unverified"|"classified-noop"} SurfaceKind */
/** @typedef {{ kind: SurfaceKind, surface: string, silentSuccess?: boolean }} SurfaceClass */
/** @typedef {{ event: string, gate: string }} GateRef */
/** @typedef {{ toolName: string, gates: GateRef[], classified: string }} ToolMap */
/** @typedef {{ status: number, stdout: string, stderr: string, error?: Error | null }} RunnerResult */
/** @typedef {(args: {
 *   event: string,
 *   gate: string,
 *   host: string,
 *   payload?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 * }) => RunnerResult | Promise<RunnerResult>} RunHookFn */

const TOOL_PROTOCOL = Object.freeze({
  bash: {
    toolName: "Bash",
    gates: [
      { event: "PreToolUse", gate: "gh-footer-gate.mjs" },
      { event: "PreToolUse", gate: "pre-tool-gate.mjs" },
    ],
  },
  shell: {
    toolName: "Bash",
    gates: [
      { event: "PreToolUse", gate: "gh-footer-gate.mjs" },
      { event: "PreToolUse", gate: "pre-tool-gate.mjs" },
    ],
  },
  edit: {
    toolName: "Edit",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  write: {
    toolName: "Write",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  read: {
    toolName: "Read",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  task: {
    toolName: "Task",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  grep: {
    toolName: "Grep",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  glob: {
    toolName: "Glob",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  webfetch: {
    toolName: "WebFetch",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  todowrite: {
    toolName: "TodoWrite",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  // OpenCode 1.18.29 built-ins (permission counterparts use the same keys).
  skill: {
    toolName: "Skill",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  apply_patch: {
    toolName: "functions.apply_patch",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  question: {
    toolName: "AskUserQuestion",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
  websearch: {
    toolName: "WebSearch",
    gates: [{ event: "PreToolUse", gate: "pre-tool-gate.mjs" }],
  },
});

/** Shared Stop set — same carriers as Cursor/Codex hosts (hooks.json Stop). */
const STOP_GATES = Object.freeze([
  { event: "Stop", gate: "recap-check.mjs" },
  { event: "Stop", gate: "session-pending-cleanup-check.mjs" },
  { event: "Stop", gate: "post-merge-check.mjs" },
  { event: "Stop", gate: "post-pr-completion-check.mjs" },
  { event: "Stop", gate: "stop-handoff-cite.mjs" },
]);

const SUPPORTED_EVENT_TYPES = new Set([
  "session.idle",
  "session.deleted",
  "tool.execute.before",
  // tool.execute.after: classified no-op for shared-gate mapping (no PostToolUse),
  // but still implemented below to append model-visible admission handoff to tool output.
  "chat.message",
  "config",
]);

// Typed plugin hook exists (@opencode-ai/plugin Hooks["permission.ask"]), but CLI
// 1.18.29 host reachability is unverified (bus path observed as permission.asked).
// Keep the handler for when the typed hook is invoked; primary fail-closed gate is
// tool.execute.before. Do NOT advertise permission.ask as a supported live surface.
const UNVERIFIED_TYPED_HOOK_SURFACES = new Set(["permission.ask"]);

const CLASSIFIED_NOOP_EVENT_TYPES = new Set(["tool.execute.after"]);

/**
 * @param {string} surface
 * @returns {SurfaceClass}
 */
export function classifyOpenCodeSurface(surface) {
  const name = String(surface || "").trim();
  if (!name) {
    return { kind: "unsupported", surface: name, silentSuccess: false };
  }
  if (/^desktop(\.|$)/i.test(name) || /unverified/i.test(name)) {
    return { kind: "unverified", surface: name, silentSuccess: false };
  }
  if (UNVERIFIED_TYPED_HOOK_SURFACES.has(name)) {
    return { kind: "unverified", surface: name, silentSuccess: false };
  }
  if (CLASSIFIED_NOOP_EVENT_TYPES.has(name)) {
    return { kind: "classified-noop", surface: name, silentSuccess: false };
  }
  if (SUPPORTED_EVENT_TYPES.has(name) || name === "session.idle") {
    return { kind: "supported", surface: name, silentSuccess: false };
  }
  if (
    name.startsWith("experimental.") ||
    name.startsWith("session.") ||
    name.startsWith("message.") ||
    name.startsWith("file.") ||
    name.includes(".")
  ) {
    return { kind: "classified-noop", surface: name, silentSuccess: false };
  }
  return { kind: "unsupported", surface: name, silentSuccess: false };
}

/**
 * @param {string} tool
 * @returns {ToolMap}
 */
export function mapOpenCodeToolToProtocol(tool) {
  const raw = String(tool || "").trim();
  if (devproGithubToolName(raw)) return { toolName: raw, gates: [{event:"PreToolUse",gate:path.join(HOOKS_DIR,"github-mcp-gate.mjs")}], classified:"supported" };
  const key = raw.toLowerCase();
  const hit = Object.prototype.hasOwnProperty.call(TOOL_PROTOCOL, key) ? TOOL_PROTOCOL[key] : undefined;
  if (!hit) {
    return { toolName: raw, gates: [], classified: "unsupported" };
  }
  return {
    toolName: hit.toolName,
    gates: hit.gates.map((g) => ({
      event: g.event,
      gate: path.join(HOOKS_DIR, g.gate),
    })),
    classified: "supported",
  };
}

/**
 * Filter a value into a diagnostic token: `[A-Za-z0-9_-]` only, at most 40
 * characters. Diagnostics never carry stderr text, absolute paths or payload
 * content (fix-codex-reviewer-intent-candidate-cap D17 decision 5).
 */
function diagToken(value) {
  const token = String(value == null ? "" : value)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40);
  return token || "unspecified";
}

/**
 * Shared hook protocol decision parse.
 * Exit-0 **empty** stdout = pass (skip/allow). An explicit block/deny (top-level
 * `decision`, or a nested `permissionDecision` deny/block/ask when there is no
 * top-level decision) blocks, whatever the runner exit status was: the
 * launcher turns a gate's nonzero exit into exit 1 but still forwards stdout.
 * Any other stdout that is not a recognized allow/advisory decision is a
 * protocol failure: `block:false` plus a fixed-vocabulary `protocolFailure`
 * cause, which the caller reports as a runner failure that fails open
 * (fix-codex-reviewer-intent-candidate-cap D17; same polarity as the other
 * host profiles).
 *
 * Multi-line streams: the last successfully parsed JSON object decides. A
 * stream that also has unparseable lines is a "partially malformed stdout"
 * protocol failure unless that last object is an explicit block. Recognized
 * advisory-only shapes (no decision field): top-level systemMessage, or Claude
 * PreToolUse hookSpecificOutput.additionalContext (shared emitContext
 * envelope). Unknown decision tokens (e.g. "blok") are protocol failures even
 * when systemMessage is present; the advisory text is not surfaced.
 *
 * @returns {{ block: boolean, reminder: string, reason: string, raw: unknown,
 *   recognized: boolean, protocolFailure: string }}
 */
function parseDecision(stdout) {
  const text = String(stdout || "").trim();
  const protocolFailure = (cause, raw = null) => ({
    block: false,
    reminder: "",
    reason: "",
    raw,
    recognized: false,
    protocolFailure: cause,
  });
  // Shared protocol: exit-0 empty stdout is pass (pre-tool / Stop skip).
  if (!text) {
    return {
      block: false,
      reminder: "",
      reason: "",
      raw: null,
      recognized: false,
      protocolFailure: "",
    };
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsedLines = [];
  let lineParseFailed = false;
  for (const line of lines) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      lineParseFailed = true;
    }
  }
  let last = null;
  if (parsedLines.length > 0) {
    last = parsedLines[parsedLines.length - 1];
  } else {
    // No per-line success: try whole blob (pretty-printed single JSON object).
    try {
      last = JSON.parse(text);
    } catch {
      return protocolFailure("unparseable stdout");
    }
  }
  // Valid JSON with non-object schema (null / array / primitive) is a protocol
  // failure. Must not throw TypeError on last.systemMessage when last is null.
  if (last === null || typeof last !== "object" || Array.isArray(last)) {
    return protocolFailure("invalid decision schema type", last);
  }
  const hasDecisionField =
    Object.prototype.hasOwnProperty.call(last, "decision") &&
    last.decision != null &&
    String(last.decision).trim() !== "";
  const decision = hasDecisionField
    ? String(last.decision).trim().toLowerCase()
    : "";
  const hookSpecific =
    last.hookSpecificOutput &&
    typeof last.hookSpecificOutput === "object" &&
    !Array.isArray(last.hookSpecificOutput)
      ? last.hookSpecificOutput
      : null;
  const hookSpecificAdvisory =
    hookSpecific &&
    typeof hookSpecific.additionalContext === "string" &&
    hookSpecific.additionalContext.trim() !== ""
      ? hookSpecific.additionalContext
      : "";
  const nestedPermissionRaw = hookSpecific
    ? hookSpecific.permissionDecision ?? hookSpecific.permission_decision
    : null;
  const hasNestedPermission =
    nestedPermissionRaw != null && String(nestedPermissionRaw).trim() !== "";
  const nestedPermission = hasNestedPermission
    ? String(nestedPermissionRaw).trim().toLowerCase()
    : "";
  const nestedPermissionBlocks =
    nestedPermission === "block" ||
    nestedPermission === "deny" ||
    nestedPermission === "ask";
  const nestedPermissionAllows =
    nestedPermission === "allow" || nestedPermission === "approve";
  // Advisory-only Claude PreToolUse envelope: additionalContext present, and either
  // no nested permissionDecision or an explicit allow/approve. Nested deny/ask/unknown
  // must not become allow just because additionalContext is also present.
  const hookSpecificAdvisoryOnly =
    Boolean(hookSpecificAdvisory) &&
    (!hasNestedPermission || nestedPermissionAllows);
  const systemMessage =
    typeof last.systemMessage === "string" && last.systemMessage
      ? last.systemMessage
      : "";

  const explicitBlock =
    decision === "block" ||
    decision === "deny" ||
    // Nested deny/block/ask MUST win over sibling systemMessage / additionalContext.
    (!hasDecisionField && nestedPermissionBlocks);
  if (explicitBlock) {
    const reminder =
      systemMessage || (typeof last.reason === "string" ? last.reason : "");
    const nestedPermissionReason = !hasDecisionField
      ? `nested permissionDecision '${nestedPermission}' (fail-closed)`
      : "";
    return {
      block: true,
      reminder,
      reason: nestedPermissionReason || last.reason || reminder || "",
      raw: last,
      recognized: true,
      protocolFailure: "",
    };
  }
  // A stream with unparseable lines whose last parsed object is not an explicit
  // block cannot be trusted as a decision.
  if (lineParseFailed) {
    return protocolFailure("partially malformed stdout", last);
  }
  const allow = (reminder) => ({
    block: false,
    reminder,
    reason: "",
    raw: last,
    recognized: true,
    protocolFailure: "",
  });
  if (decision === "allow") {
    return allow(systemMessage || hookSpecificAdvisory);
  }
  if (!hasDecisionField && hasNestedPermission && !nestedPermissionAllows) {
    // Unknown nested permissionDecision → protocol failure (before advisory allows).
    return protocolFailure(
      `unknown nested permissionDecision '${diagToken(nestedPermission)}'`,
      last
    );
  }
  if (!hasDecisionField && systemMessage) {
    // Recognized advisory-only shape: reminder / lease-held skip.
    return allow(systemMessage);
  }
  if (!hasDecisionField && hookSpecificAdvisoryOnly) {
    // Claude PreToolUse advisory envelope (shared emitContext) — allow + remind.
    return allow(hookSpecificAdvisory);
  }
  if (hasDecisionField) {
    // Unknown decision token (schema drift): not a decision, and the advisory
    // text of a drifted result is not surfaced as a reminder.
    return protocolFailure(`unknown decision '${diagToken(decision)}'`, last);
  }
  // Ambiguous nonempty object (no decision, no reminder).
  return protocolFailure("missing decision field", last);
}

/** Last nonempty line of a stderr blob ("" when there is none). */
function lastNonEmptyLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/** Path tail that also understands Windows separators. */
function pathTail(p) {
  return String(p || "").split(/[\\/]/).pop() || "";
}

const CWD_MISSING_CAUSE =
  "session working directory missing; run session_move or switch to an existing directory";

/**
 * Recognize the launcher's own fail-open diagnostic for THIS call: exit 0 with
 * empty stdout is otherwise indistinguishable from a silent pass, so the
 * launcher's last stderr line is the only trace of a launcher-translated
 * timeout or missing working directory. Anchored on the event and the gate
 * basename; a missing hook file leaves no line and stays a silent pass.
 * Returns the fixed-vocabulary cause, or "" when the line is not ours.
 */
function launcherFailOpenCause(stderr, event, gateName) {
  const line = lastNonEmptyLine(stderr);
  if (!line || !event || !gateName) return "";
  const prefix = `hook ${event} `;
  if (!line.startsWith(prefix) || !line.endsWith("; fail-open")) return "";
  const rest = line.slice(prefix.length);
  const timeout = /^(.+?) timed out after \d+ms; fail-open$/.exec(rest);
  if (timeout && pathTail(timeout[1]) === gateName) return "launcher timeout";
  const cwdGone = /^(.+?): session working directory missing\b.*; fail-open$/.exec(rest);
  if (cwdGone && pathTail(cwdGone[1]) === gateName) return CWD_MISSING_CAUSE;
  return "";
}

/** Fixed-vocabulary cause for a runner `error` (spawn error, kill, timeout). */
function runnerErrorCause(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (typeof code === "string" && code) return `error ${diagToken(code)}`;
  const message =
    error && typeof error === "object" ? String(error.message || "") : String(error || "");
  const killed = /^killed by ([A-Z0-9]+)/.exec(message);
  if (killed) return `signal ${diagToken(killed[1])}`;
  return "error unspecified";
}

/** Single-line, fixed-vocabulary runner-failure diagnostic. */
function formatRunnerFailure(event, gateName, cause) {
  const oneLine = (value) => String(value || "").replace(/\s+/g, "_") || "unknown";
  return `hook ${oneLine(event)} ${oneLine(gateName)} runner failure (${cause}); fail-open`;
}

/**
 * Classify one runner result (fix-codex-reviewer-intent-candidate-cap D17).
 * stdout is read before status: the launcher turns a gate's nonzero exit into
 * exit 1 but still forwards its stdout, so an explicit block must win at any
 * exit status.
 *   - `{ kind: "block", reason, reminder }`: an explicit block decision.
 *   - `{ kind: "allow", reminder }`: a recognized allow/advisory, or a silent
 *     pass (exit 0, empty stdout, no launcher diagnostic).
 *   - `{ kind: "runner-failure", cause, diagnostic }`: the gate did not give a
 *     decision (nonzero/null status, runner error, protocol failure, or a
 *     launcher-translated timeout / missing working directory). It fails open;
 *     the caller reports `diagnostic` and continues with the next gate.
 *
 * @param {RunnerResult | null | undefined} result
 * @param {{ event?: string, gate?: string }} [ctx]
 */
function classifyRunnerResult(result, { event = "", gate = "" } = {}) {
  const gateName = pathTail(gate);
  const failure = (cause) => ({
    kind: "runner-failure",
    cause,
    diagnostic: formatRunnerFailure(event, gateName, cause),
  });
  if (!result || typeof result !== "object") return failure("error unspecified");
  const status = result.status;
  const statusFailed = typeof status === "number" ? status !== 0 : true;
  const abnormal = Boolean(result.error) || statusFailed;
  const causeFromStatus = () => {
    if (result.error) {
      return /^hook .+: session working directory missing \(/.test(String(result.stderr || ""))
        ? CWD_MISSING_CAUSE
        : runnerErrorCause(result.error);
    }
    return `exit ${diagToken(status)}`;
  };
  if (String(result.stdout || "").trim()) {
    const parsed = parseDecision(result.stdout);
    if (parsed.block) {
      return { kind: "block", reason: parsed.reason || "decision:block", reminder: parsed.reminder };
    }
    if (parsed.recognized) return { kind: "allow", reminder: parsed.reminder };
    return failure(abnormal ? causeFromStatus() : parsed.protocolFailure || "unparseable stdout");
  }
  if (abnormal) return failure(causeFromStatus());
  const launcherCause = launcherFailOpenCause(result.stderr, event, gateName);
  if (launcherCause) return failure(launcherCause);
  return { kind: "allow", reminder: "" };
}

/** Classification of a gate whose runner threw instead of returning a result. */
function exceptionFailure({ event = "", gate = "" } = {}) {
  return {
    kind: "runner-failure",
    cause: "exception",
    diagnostic: formatRunnerFailure(event, pathTail(gate), "exception"),
  };
}

/**
 * OpenCode (and similar host binaries) set `process.execPath` to the host CLI,
 * not Node/Bun. Spawning `run-hook.mjs` with that path prints CLI help and
 * poisons every tool deny/reminder with help text. Resolve a real JS runtime.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [execPath]
 * @returns {string}
 */
export function resolveNodeExecutable(env = process.env, execPath = process.execPath) {
  const override = String(env?.DEVPRO_NODE_PATH || "").trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `devpro-hooks: DEVPRO_NODE_PATH=${override} does not exist`
      );
    }
    return override;
  }
  const base = path.basename(String(execPath || "")).toLowerCase();
  if (
    base === "node" ||
    base === "node.exe" ||
    base === "bun" ||
    base === "bun.exe"
  ) {
    return execPath;
  }
  // Windows has no `which`; `where` prints the same one-path-per-line answer.
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], {
    encoding: "utf8",
    env: env && typeof env === "object" ? env : process.env,
  });
  const fromPath = String(which.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (which.status === 0 && fromPath && existsSync(fromPath)) {
    return fromPath;
  }
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "devpro-hooks: cannot resolve Node.js to run shared hooks " +
      `(process.execPath=${execPath} is a host binary; set DEVPRO_NODE_PATH)`
  );
}

/**
 * Provider-neutral session env for hook subprocesses
 * (strengthen-host-session-neutrality): any runtime adapter declares its own
 * session via DEVPRO_HOST_SESSION_ID so identity-consuming gates work on
 * hosts without claude-code or codex session env vars.
 */
function sessionEnv(sessionID) {
  return typeof sessionID === "string" && sessionID.trim().length > 0
    ? { DEVPRO_HOST_SESSION_ID: sessionID.trim() }
    : {};
}

/**
 * Merge hook env over the ambient process env (never replace): PATH, HOME and
 * every other inherited variable must survive while the injected session key is
 * added (strengthen-hook-runtime-robustness S4 evidence).
 */
export function mergeHookEnv(env) {
  return { ...process.env, ...(env || {}) };
}

/**
 * Single owner for the deleted-session-cwd diagnostic template. All plugin
 * spawn paths (sync spawn error, async sync-throw, async error event) route
 * through here so a wording change cannot drift between them
 * (strengthen-hook-runtime-robustness F-hrr-f1-02).
 */
export function formatMissingCwdDiagnostic(event, gate, target) {
  return `hook ${event} ${gate}: session working directory missing (${target}) — run session_move (or switch to an existing directory) and retry`;
}

/**
 * @returns {RunnerResult}
 */
function defaultRunHook({ event, gate, host, payload, cwd, env }) {
  if (rulesUnavailable) return rulesUnavailableResult();
  const script = resolveRunHookScript(cwd);
  const args = [script, event, gate, `--host=${host || HOST}`];
  const mergedEnv = mergeHookEnv(env);
  let nodeBin;
  try {
    nodeBin = resolveNodeExecutable(mergedEnv, process.execPath);
  } catch (err) {
    return {
      status: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  const result = spawnSync(nodeBin, args, {
    cwd: cwd || DEFAULT_REPO_ROOT,
    encoding: "utf8",
    input: payload || "",
    env: mergedEnv,
    timeout: resolvePluginHookTimeoutMs(process.env),
    killSignal: "SIGKILL",
  });
  if (result.error) {
    // Named diagnostic for the deleted-session-directory class
    // (strengthen-hook-runtime-robustness): a spawn ENOENT here almost always
    // means the session cwd no longer exists, and the raw error is opaque.
    const target = cwd || DEFAULT_REPO_ROOT;
    const missingCwd = !existsSync(target);
    // Only the deleted-session-cwd class rewrites the diagnostic here. Other
    // spawn faults (timeout ETIMEDOUT, maxBuffer ENOBUFS, signal kills) MUST
    // fall through to the historical return shape so their own diagnostics and
    // captured stderr survive (cross-model F2).
    if (missingCwd) {
      return {
        status: 1,
        stdout: result.stdout || "",
        stderr: formatMissingCwdDiagnostic(event, gate, target),
        error: result.error,
      };
    }
  }
  return {
    status: result.status == null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function denyError(reason) {
  const err = new Error(reason || "devpro hard-gate deny (fail-closed)");
  err.name = "DevproHookDeny";
  return err;
}

function sessionIdFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  const props = event.properties || {};
  const info = props.info && typeof props.info === "object" ? props.info : null;
  return (
    props.sessionID ||
    props.sessionId ||
    info?.id ||
    event.sessionID ||
    event.sessionId ||
    ""
  );
}

/**
 * Normalize OpenCode tool args onto shared-gate shapes — SINGLE OWNER shared by
 * the V1 face (`invokeGates`) and the V2 decision path (fix-flow-gate-gaps D5).
 *
 * - `functions.apply_patch` carries `patchText`; shared pre-tool-gate reads
 *   patch/input/… and expects tool_name `functions.apply_patch` for path
 *   checks. `patchText` itself stays on the payload (host-facing parity).
 * - Write/Edit: canonicalize `path|filePath|file_path` → `file_path`,
 *   `oldString`→`old_string`, `newString`→`new_string`,
 *   `replaceAll`→`replace_all`, so the shared gates read the write PROPOSAL.
 *   (camelCase OpenCode args previously left `old_string` unset and the con-
 *   tent gate fell back to the prior on-disk file content — defect 5.)
 */
function normalizeToolArgs(toolName, args) {
  const base = args && typeof args === "object" ? { ...args } : {};
  if (toolName === "functions.apply_patch") {
    if (
      typeof base.patchText === "string" &&
      !(
        (typeof base.patch === "string" && base.patch) ||
        (typeof base.input === "string" && base.input) ||
        (typeof base.content === "string" && base.content) ||
        (typeof base.diff === "string" && base.diff)
      )
    ) {
      base.patch = base.patchText;
    }
    return base;
  }
  if (toolName === "Write" || toolName === "Edit") {
    if (typeof base.file_path !== "string" || !base.file_path) {
      const pathValue = [base.filePath, base.path].find(
        (candidate) => typeof candidate === "string" && candidate.trim() !== ""
      );
      if (pathValue) base.file_path = pathValue;
    }
    if (typeof base.old_string !== "string" && typeof base.oldString === "string") {
      base.old_string = base.oldString;
    }
    if (typeof base.new_string !== "string" && typeof base.newString === "string") {
      base.new_string = base.newString;
    }
    if (base.replace_all === undefined && typeof base.replaceAll === "boolean") {
      base.replace_all = base.replaceAll;
    }
  }
  return base;
}

/**
 * @param {object} [options]
 */
export function createDevproPluginHooks(options = {}) {
  const runHook = options.runHook || defaultRunHook;
  const reminderSink = options.reminderSink || [];
  const reminderSinkMax =
    typeof options.reminderSinkMax === "number" && options.reminderSinkMax > 0
      ? Math.floor(options.reminderSinkMax)
      : 64;
  /** @type {Map<string, object>} */
  const sessionState = options.sessionState || new Map();

  function recordReminder(entry) {
    reminderSink.push(entry);
    if (reminderSink.length > reminderSinkMax) {
      reminderSink.splice(0, reminderSink.length - reminderSinkMax);
    }
  }

  function clearReminderSinkForSession(sessionID) {
    for (let i = reminderSink.length - 1; i >= 0; i -= 1) {
      if (!sessionID || reminderSink[i]?.sessionID === sessionID) {
        reminderSink.splice(i, 1);
      }
    }
  }
  /** @type {Map<string, string>} `${sessionID}::${callID}` → admission/allow handoff */
  const pendingAdmissionByCall = options.pendingAdmissionByCall || new Map();
  const githubInputsByCall = new Map();
  const pendingAdmissionMax =
    typeof options.pendingAdmissionMax === "number" && options.pendingAdmissionMax > 0
      ? Math.floor(options.pendingAdmissionMax)
      : 64;
  const directory = options.directory || options.worktree || DEFAULT_REPO_ROOT;
  const client = options.client || null;

  function admissionKey(sessionID, callID) {
    return `${sessionID || ""}::${callID || ""}`;
  }

  function queueAdmissionHandoff(sessionID, callID, reason) {
    if (!reason) return;
    const st = sessionID ? getState(sessionID) : null;
    if (st) st.pendingAdmissionHandoff = reason;
    // Always bind session+call; empty callID still session-scoped (permission.ask).
    const key = admissionKey(sessionID, callID);
    pendingAdmissionByCall.set(key, reason);
    if (pendingAdmissionByCall.size > pendingAdmissionMax) {
      const oldest = pendingAdmissionByCall.keys().next().value;
      if (oldest != null) pendingAdmissionByCall.delete(oldest);
    }
  }

  function takeAdmissionHandoff(sessionID, callID) {
    const key = admissionKey(sessionID, callID);
    if (pendingAdmissionByCall.has(key)) {
      const handoff = pendingAdmissionByCall.get(key) || "";
      pendingAdmissionByCall.delete(key);
      const st = sessionID ? sessionState.get(sessionID) : null;
      if (st && st.pendingAdmissionHandoff === handoff) {
        st.pendingAdmissionHandoff = "";
      }
      return handoff;
    }
    // Exact composite miss: non-empty callID MUST NOT fall back to the session's
    // latest pendingAdmissionHandoff (eviction would misattribute another call).
    // Empty callID (permission.ask) may consume the session-scoped leftover.
    if (!callID) {
      const st = sessionID ? sessionState.get(sessionID) : null;
      if (st?.pendingAdmissionHandoff) {
        const handoff = st.pendingAdmissionHandoff;
        st.pendingAdmissionHandoff = "";
        return handoff;
      }
    }
    return "";
  }

  function clearPendingAdmissionForSession(sessionID) {
    const prefix = `${sessionID || ""}::`;
    for (const key of [...pendingAdmissionByCall.keys()]) {
      if (key.startsWith(prefix)) pendingAdmissionByCall.delete(key);
    }
  }

  function getState(sessionID) {
    if (!sessionID) return null;
    let st = sessionState.get(sessionID);
    if (!st) {
      st = {
        blocking: false,
        reason: "",
        reminder: "",
        reminderDelivered: false,
        reminderDeliveryError: "",
        pendingAdmissionHandoff: "",
        outcome: "",
        syncStopBlock: false,
        silentSuccess: false,
      };
      sessionState.set(sessionID, st);
    }
    return st;
  }

  /**
   * Deliver reminder via proven OpenCode host API `client.tui.showToast`
   * (POST /tui/show-toast body shape). MUST NOT push bare `{type,text}` into
   * `chat.message` parts (missing id/sessionID/messageID → SchemaError and
   * session corruption). MUST NOT mark reminderDelivered before toast succeeds.
   * MUST NOT swallow async delivery failures silently.
   *
   * @param {string} sessionID
   * @param {string} message
   * @param {{ parts?: unknown[] } | null} [chatOutput]
   * @param {{ bindReminderState?: boolean }} [options]
   *   When `bindReminderState` is false (admission handoff toasts), do not
   *   overwrite `st.reminder` / `reminderDelivered` — those belong to Stop.
   * @returns {Promise<boolean>}
   */
  async function deliverReminder(
    sessionID,
    message,
    chatOutput = null,
    options = {}
  ) {
    if (!message) return false;
    const bindReminderState = options.bindReminderState !== false;
    const entry = {
      sessionID,
      message,
      text: message,
      at: Date.now(),
    };
    const st = getState(sessionID);
    if (st && bindReminderState) {
      st.reminder = message;
      // Do not set reminderDelivered until a host channel succeeds.
    }

    let delivered = false;
    /** @type {Error | null} */
    let deliveryError = null;

    const showToast = client?.tui?.showToast;
    if (typeof showToast === "function") {
      try {
        // OpenCode SDK 1.18.29: client.tui.showToast → POST /tui/show-toast
        // Request shape (hey-api Options<TuiShowToastData>): body.message + body.variant.
        const result = await showToast.call(client.tui, {
          body: {
            message,
            variant: "warning",
            title: "Devpro",
          },
          query: directory ? { directory } : undefined,
        });
        if (result && typeof result === "object" && result.error) {
          throw result.error instanceof Error
            ? result.error
            : new Error(String(result.error));
        }
        delivered = true;
        entry.channel = "tui.showToast";
      } catch (err) {
        deliveryError =
          err instanceof Error ? err : new Error(String(err || "showToast failed"));
      }
    }

    // Do not mutate chatOutput.parts with incomplete Part objects — OpenCode
    // schema requires id/sessionID/messageID; bare pushes fail-closed at save
    // and can surface host CLI help text as poisoned tool/chat content.
    void chatOutput;

    recordReminder(entry);

    if (st && bindReminderState) {
      if (delivered) {
        st.reminderDelivered = true;
        st.reminderDeliveryError = "";
      } else {
        st.reminderDelivered = false;
        st.reminderDeliveryError =
          deliveryError?.message || "reminder delivery channel unavailable";
      }
    }

    // Surface async failure (do not swallow): chat.message path rethrows;
    // idle records error state so subsequent chat.message can retry.
    if (!delivered && deliveryError && chatOutput) {
      throw deliveryError;
    }
    return delivered;
  }

  /**
   * Report a runner failure (fail-open, D17): one single-line diagnostic per
   * failed gate through the toast + reminderSink channel. It is never bound to
   * the Stop reminder state, the admission handoff or the model-visible tool
   * output, and a delivery problem can never turn the fail-open into a failure.
   *
   * @param {string} sessionID
   * @param {string} diagnostic
   */
  async function reportRunnerFailure(sessionID, diagnostic) {
    try {
      await deliverReminder(sessionID, diagnostic, null, { bindReminderState: false });
    } catch {
      /* diagnostics are best-effort */
    }
  }

  function clearBlockingState(st) {
    if (!st) return;
    st.blocking = false;
    st.reason = "";
    st.reminder = "";
    st.reminderDelivered = false;
    st.reminderDeliveryError = "";
  }

  async function invokeGates(gates, { toolName, args, sessionID }) {
    const toolInput = normalizeToolArgs(toolName, args);
    const payload = JSON.stringify({
      tool_name: toolName,
      tool_input: toolInput,
      session_id: sessionID || "",
      cwd: directory,
    });
    let lastReason = "";
    let githubFailure = false;
    for (const g of gates) {
      // R9 (D17): a runner failure fails open — report it and keep running the
      // remaining gates; only an explicit block decision denies.
      let classified;
      try {
        const result = await runHook({
          event: g.event,
          gate: g.gate,
          host: HOST,
          payload,
          cwd: directory,
          env: sessionEnv(sessionID),
        });
        classified = classifyRunnerResult(result, { event: g.event, gate: g.gate });
      } catch {
        classified = exceptionFailure({ event: g.event, gate: g.gate });
      }
      if (classified.kind === "block") {
        return { action: "deny", reason: classified.reason };
      }
      if (classified.kind === "runner-failure") {
        await reportRunnerFailure(sessionID, classified.diagnostic);
        if (isGithubWritePayload(JSON.parse(payload))) githubFailure = true;
        continue;
      }
      if (classified.reminder) lastReason = classified.reminder;
    }
    return githubFailure ? {action:"deny",reason:"GitHub gate unavailable; write denied"} : { action: "allow", reason: lastReason };
  }

  async function enforceToolOrPermission(tool, args, sessionID) {
    const st = sessionID ? getState(sessionID) : null;
    if (st?.blocking) {
      return {
        action: "deny",
        reason: st.reason || "session blocked after idle/stop (fail-closed)",
      };
    }
    const mapped = mapOpenCodeToolToProtocol(tool);
    if (mapped.classified !== "supported") {
      // No shared gate owns this tool. Leave its native permission decision
      // intact, just as the Claude/Codex pre-tool dispatch does.
      return { action: "allow", reason: "" };
    }
    return invokeGates(mapped.gates, {
      toolName: mapped.toolName,
      args,
      sessionID,
    });
  }

  return {
    async "tool.execute.before"(input, output) {
      const tool = input?.tool || "";
      const sessionID = input?.sessionID || "";
      const args = output?.args;
      const decision = await enforceToolOrPermission(tool, args, sessionID);
      if (decision.action === "deny") {
        throw denyError(decision.reason);
      }
      if (input?.callID && ["github_check_pr","github_policy_status","github_create_pr"].includes(devproGithubToolName(tool))) {
        githubInputsByCall.set(admissionKey(sessionID,input.callID),structuredClone(args));
        if (githubInputsByCall.size > 64) githubInputsByCall.delete(githubInputsByCall.keys().next().value);
      }
      // Surface allow handoff: toast (UX) + queue for model-visible tool.execute.after /
      // chat.message (TL-consumable admission_record line).
      if (decision.reason) {
        queueAdmissionHandoff(sessionID, input?.callID || "", decision.reason);
        await deliverReminder(sessionID, decision.reason);
      }
    },

    async "tool.execute.after"(input, output) {
      const githubKey=admissionKey(input?.sessionID,input?.callID);
      const githubArgs=input?.args ?? githubInputsByCall.get(githubKey);
      githubInputsByCall.delete(githubKey);
      if (["github_check_pr","github_policy_status","github_create_pr"].includes(devproGithubToolName(input?.tool))) {
        await runHook({event:"PostToolUse",gate:path.join(HOOKS_DIR,"github-mcp-gate.mjs"),host:HOST,
          payload:JSON.stringify({tool_name:input.tool,tool_input:githubArgs,tool_response:output,cwd:directory,session_id:input.sessionID}),cwd:directory});
      }
      const sessionID = input?.sessionID || "";
      const callID = input?.callID || "";
      const handoff = takeAdmissionHandoff(sessionID, callID);
      if (!handoff || !output || typeof output !== "object") return;
      const existing = typeof output.output === "string" ? output.output : "";
      output.output = existing ? `${existing}\n${handoff}` : handoff;
    },

    async "permission.ask"(input, output) {
      const tool = input?.type || input?.permission || input?.title || "";
      const sessionID = input?.sessionID || "";
      const meta = input?.metadata && typeof input.metadata === "object" ? input.metadata : {};
      const args = meta.args || meta.input || meta;
      const decision = await enforceToolOrPermission(tool, args, sessionID);
      if (!output || typeof output !== "object") return;
      if (decision.action === "deny") {
        output.status = "deny";
        return;
      }
      if (decision.reason) {
        // permission.ask has no tool.execute.after; queue for chat.message flush.
        queueAdmissionHandoff(sessionID, "", decision.reason);
        await deliverReminder(sessionID, decision.reason);
      }
      // Gate pass MUST NOT auto-upgrade host confirmation: keep `ask` (or prior
      // non-deny status). Design D2 locks fail-closed deny polarity only.
      if (output.status == null) {
        output.status = "ask";
      }
    },

    async event({ event }) {
      const type = event?.type || "";
      const sessionID = sessionIdFromEvent(event);
      const classified = classifyOpenCodeSurface(type);

      if (type === "session.deleted") {
        if (sessionID) sessionState.delete(sessionID);
        for (const key of githubInputsByCall.keys()) if (key.startsWith(`${sessionID}::`)) githubInputsByCall.delete(key);
        clearReminderSinkForSession(sessionID);
        clearPendingAdmissionForSession(sessionID);
        return;
      }

      if (type !== "session.idle") {
        // Classified no-op / unsupported — never silent-success-as-allow.
        if (sessionID) {
          const st = getState(sessionID);
          st.outcome = classified.kind;
          st.silentSuccess = false;
          st.syncStopBlock = false;
        }
        return;
      }

      // session.idle → Stop payload hooks (state + reminder). Promise<void>:
      // MUST NOT throw as a fake sync Stop-block.
      const st = getState(sessionID || "anonymous");
      st.syncStopBlock = false;
      st.silentSuccess = false;

      // Only an explicit block decision from this round locks the session
      // (D17 decision 4). A runner failure (nonzero exit, spawn error, protocol
      // failure, launcher-translated timeout, thrown runner) is reported and the
      // remaining Stop gates still run, so a later round's failure unlocks.
      let sawBlock = false;
      let sawRunnerFailure = false;
      let blockReason = "";
      let reminder = "";

      for (const g of STOP_GATES) {
        const gatePath = path.join(HOOKS_DIR, g.gate);
        let classified;
        try {
          const result = await runHook({
            event: g.event,
            gate: gatePath,
            host: HOST,
            payload: JSON.stringify({
              session_id: sessionID,
              cwd: directory,
              hook_event_name: "Stop",
            }),
            cwd: directory,
            env: sessionEnv(sessionID),
          });
          classified = classifyRunnerResult(result, { event: g.event, gate: gatePath });
        } catch {
          classified = exceptionFailure({ event: g.event, gate: gatePath });
        }
        if (classified.kind === "runner-failure") {
          sawRunnerFailure = true;
          await reportRunnerFailure(sessionID, classified.diagnostic);
          continue;
        }
        if (classified.reminder) reminder = classified.reminder;
        if (classified.kind === "block") {
          sawBlock = true;
          blockReason = classified.reason || "Stop decision:block";
        }
      }

      if (sawBlock) {
        st.blocking = true;
        st.reason = blockReason || "idle/stop fail-closed";
        st.outcome = "fail-closed";
        st.silentSuccess = false;
        if (reminder) {
          await deliverReminder(sessionID, reminder);
        } else if (blockReason) {
          await deliverReminder(sessionID, blockReason);
        }
      } else {
        // A round without an explicit block clears prior blocking + reminder state.
        clearBlockingState(st);
        st.outcome = sawRunnerFailure ? "fail-open" : reminder ? "reminder" : "ok";
        if (reminder) {
          await deliverReminder(sessionID, reminder);
        }
      }
      // Intentionally no throw — idle cannot sync Stop-block the host.
    },

    async "chat.message"(input, output) {
      const sessionID = input?.sessionID || "";
      const st = sessionID ? sessionState.get(sessionID) : null;
      // MUST NOT push bare `{ type, text }` into output.parts — OpenCode requires
      // id/sessionID/messageID and rejects incomplete parts (session corruption;
      // symptoms: every tool result replaced by `opencode --help` text).
      // Model-visible admission handoff stays on tool.execute.after; UX via toast.
      if (st?.pendingAdmissionHandoff) {
        const handoff = st.pendingAdmissionHandoff;
        st.pendingAdmissionHandoff = "";
        // Admission UX only — MUST NOT bind Stop reminder delivery state.
        await deliverReminder(sessionID, handoff, null, {
          bindReminderState: false,
        });
      }
      if (st?.reminder && !st.reminderDelivered) {
        await deliverReminder(sessionID, st.reminder, null);
      } else if (st?.reminder) {
        recordReminder({
          sessionID,
          message: st.reminder,
          text: st.reminder,
          at: Date.now(),
          channel: "chat.message",
        });
        st.reminderDelivered = true;
      }
      void output;
    },

    async config(cfg) {
      if (!cfg || typeof cfg !== "object") return;
      const skillsPath = path.join(directory, ".agents/skills");
      if (!existsSync(skillsPath)) return;
      if (!cfg.skills || typeof cfg.skills !== "object") cfg.skills = {};
      const paths = Array.isArray(cfg.skills.paths) ? cfg.skills.paths : [];
      if (!paths.includes(skillsPath)) {
        cfg.skills.paths = [...paths, skillsPath];
      }
    },

    __test__: { reminderSink, reminderSinkMax, sessionState, pendingAdmissionByCall, pendingAdmissionMax, STOP_GATES, parseDecision, classifyRunnerResult },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// V2 face (opencode2 v0.0.0-beta-19425 plugin contract)
//
// Dual export (D15): V2 reads `id` + `setup(ctx)`; V1 1.18.29 reads `server()`.
// Zero third-party imports (D14/D20): plain object literal, no plugin SDK package.
// Decision translation: D16; idle→deny host control: D17 (incl. D26).
// ────────────────────────────────────────────────────────────────────────────

const V2_QUEUE_CAP = 32; // D17.3 global pending cap; overflow → drop + DEGRADED
const V2_MAX_RESUBSCRIBE = 3; // D17.2 backoff retries before FAILED
const V2_BACKOFF_MS = [500, 1000, 2000]; // D17.2 resubscribe backoff
const V2_TAKEOVER_MARGIN_MS = 10_000; // D17.4 stuck-job takeover margin over runner timeout
const V2_HANDOFF_MAX = 64; // admission handoff FIFO cap (V1 parity)
const V2_BOOKKEEPING_CAP = 256; // F-aorp2-r2-01: bounded per-instance bookkeeping

/**
 * V2 permission action → shared-gate mapping. Only mapped operations run
 * shared decision gates; unmapped actions preserve the host effect after
 * ownership/Stop checks. This is pass-through, never a forced allow.
 * V1 face mapping (`mapOpenCodeToolToProtocol`) stays the semantic anchor.
 */
const V2_ACTION_TOOL_KEYS = Object.freeze({
  shell: "bash",
  edit: "edit",
  write: "write",
  read: "read",
  grep: "grep",
  glob: "glob",
  webfetch: "webfetch",
  websearch: "websearch",
  skill: "skill",
  question: "question",
  subagent: "task",
});
/** V1 tool-input key each action's first resource maps onto (V1 payload parity). */
const V2_RESOURCE_KEY = Object.freeze({
  shell: "command",
  edit: "file_path",
  write: "file_path",
  read: "file_path",
  grep: "pattern",
  glob: "pattern",
  webfetch: "url",
  websearch: "query",
  skill: "name",
  question: "question",
  subagent: "subagent_type",
});

function normalizeBackoffMs(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return V2_BACKOFF_MS.slice();
  const out = raw.map((x) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return out.length ? out : V2_BACKOFF_MS.slice();
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

function createAsyncQueue(signal) {
  const items = [];
  const waiters = [];
  return {
    push(item) {
      const w = waiters.shift();
      if (w) w(item);
      else items.push(item);
    },
    length: () => items.length,
    take() {
      if (items.length) return Promise.resolve(items.shift());
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const onAbort = () => {
          remove();
          resolve(null);
        };
        const waiter = (item) => {
          remove();
          resolve(item);
        };
        const remove = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          signal.removeEventListener("abort", onAbort);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
  };
}

/**
 * Async runner for the V2 event-stream Stop jobs (D17.3: the for-await pump MUST
 * NOT run inline spawnSync — slow consumers overflow and fail the stream by
 * contract) and the evaluate decision path (fix-hook-gate-server-block). Sync
 * spawn remains only on the V1 `server()` path and the evaluate Stop-gate leg
 * (`runStopGates({ asyncSpawn: false })` — fast Stop scripts, not the pre-tool
 * chain).
 */
function defaultRunHookAsync({ event, gate, host, payload, cwd, env }) {
  return new Promise((resolve) => {
    if (rulesUnavailable) {
      resolve(rulesUnavailableResult());
      return;
    }
    const script = resolveRunHookScript(cwd);
    const mergedEnv = mergeHookEnv(env);
    let nodeBin;
    try {
      nodeBin = resolveNodeExecutable(mergedEnv, process.execPath);
    } catch (err) {
      resolve({
        status: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    let child;
    try {
      child = spawn(
        nodeBin,
        [script, event, gate, `--host=${host || HOST}`],
        { cwd: cwd || DEFAULT_REPO_ROOT, env: mergedEnv, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      const target = cwd || DEFAULT_REPO_ROOT;
      const missingCwd = !existsSync(target);
      resolve({
        status: 1,
        stdout: "",
        stderr: missingCwd
          ? formatMissingCwdDiagnostic(event, gate, target)
          : String((err && err.message) || err),
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    const timeoutMs = resolvePluginHookTimeoutMs(process.env);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      // Async spawn errors do NOT throw synchronously; the deleted-session-cwd
      // class must still surface the named diagnostic
      // (strengthen-hook-runtime-robustness F-hrr-r1-01).
      const target = cwd || DEFAULT_REPO_ROOT;
      const missingCwd = !existsSync(target);
      settle({
        status: 1,
        stdout,
        stderr: missingCwd
          ? formatMissingCwdDiagnostic(event, gate, target)
          : err.message,
        error: err,
      });
    });
    child.on("close", (code, signal) =>
      settle({
        status: code == null ? 1 : code,
        stdout,
        stderr,
        error: signal
          ? new Error(`killed by ${signal}`)
          : null,
      })
    );
    child.stdin?.on("error", (err) => {
      // A child that exits or closes stdin before draining the payload fails the
      // pending write asynchronously; without a listener that is an uncaught
      // exception in the plugin process. The child's close event still decides
      // the result. Any other stdin failure stays visible in stderr.
      if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") return;
      stderr += `hook stdin write failed: ${(err && err.message) || err}\n`;
    });
    if (payload) {
      try {
        child.stdin?.write(payload);
      } catch {
        /* ignore */
      }
    }
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  });
}

function createV2Runtime(ctx, options = {}) {
  // All runner spawns bind to the plugin instance's checkout (D17.5): the same
  // directory as the ownership check; shared state lands in repo-owned paths.
  const directory = ctx?.location?.directory || DEFAULT_REPO_ROOT;
  const myWorkspaceID =
    typeof ctx?.location?.workspaceID === "string"
      ? ctx.location.workspaceID
      : "";
  const runHook = typeof options.runHook === "function" ? options.runHook : null;
  const backoffMs = normalizeBackoffMs(options.eventBackoffMs);
  const takeoverTimeoutMs =
    typeof options.takeoverTimeoutMs === "number" && options.takeoverTimeoutMs > 0
      ? options.takeoverTimeoutMs
      : resolvePluginHookTimeoutMs(process.env) +
        V2_TAKEOVER_MARGIN_MS;
  const abort = new AbortController();
  const signal = abort.signal;

  /** @type {Map<string, object>} per-session state (D17.2 State 層) */
  const sessions = new Map();
  /**
   * Provider-neutral session propagation (strengthen-host-session-neutrality
   * F-hsn-r1-04): the agent's own shell commands run outside hook subprocesses,
   * so gates that resolve the host session (cost-budget override records,
   * change-usage checkpoints) need DEVPRO_HOST_SESSION_ID injected into the
   * Shell create.before env. Attribution is best-effort: the most recent
   * session seen by a prompt/tool hook of this plugin instance. An explicit
   * env value already present wins and is never overwritten.
   */
  let lastSessionID = "";

  function noteSession(sessionID) {
    const id = typeof sessionID === "string" ? sessionID.trim() : "";
    if (id) lastSessionID = id;
  }
  /** @type {Map<string, string[]>} admission handoff FIFO per session */
  const handoffs = new Map();
  /** @type {Map<string, "ours"|"foreign">} positive ownership cache (D17.5) */
  const ownershipCache = new Map();
  /** per-session FIFO chains keep idle task ordering without blocking the pump */
  const sessionChains = new Map();
  /**
   * Tombstones for session.deleted — after deletion, scheduled idle chains and
   * evaluate paths MUST NOT recreate ghost state (F-aorp2-r2-01). Bounded FIFO:
   * eviction only weakens the ghost guard, never the fail-closed polarity.
   */
  const deletedSessions = new Set();

  /** FIFO-capped set helper (bounded bookkeeping, F-aorp2-r2-01). */
  function setBounded(collection, key, value, cap = V2_BOOKKEEPING_CAP) {
    collection.set(key, value);
    if (collection.size > cap) {
      const oldest = collection.keys().next().value;
      if (oldest !== undefined) collection.delete(oldest);
    }
  }

  let transport = "STARTING"; // STARTING | READY | DEGRADED | FAILED (D17.2)
  let transportGen = 0;
  let resubscribeBudget = V2_MAX_RESUBSCRIBE;
  let backoffIdx = 0;
  let workerStopped = false;
  let droppedEvents = 0;
  let eventLoopPromise = Promise.resolve();
  let workerPromise = Promise.resolve();
  const queue = createAsyncQueue(signal);

  function getSessionState(sessionID) {
    if (!sessionID) return null;
    if (deletedSessions.has(sessionID)) return null; // ghost guard (F-aorp2-r2-01)
    let st = sessions.get(sessionID);
    if (!st) {
      st = {
        blocking: false,
        blockingReason: "",
        reconciled: false,
        reconcileGen: 0,
        attempt: 0,
        pendingAttempt: 0,
        attemptStartedAt: 0,
        reminder: "",
        reminderDelivered: false,
      };
      sessions.set(sessionID, st);
    }
    return st;
  }

  // ── D17.5 session→repository ownership binding ────────────────────────────

  function realpathEqual(a, b) {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return path.resolve(a) === path.resolve(b);
    }
  }

  async function probeOwnership(sessionID) {
    let info;
    try {
      info = await ctx.session.get({ sessionID });
    } catch {
      return "unresolvable";
    }
    const loc = info && typeof info === "object" ? info.location : null;
    const dir = loc && typeof loc.directory === "string" ? loc.directory : "";
    const ws = loc && typeof loc.workspaceID === "string" ? loc.workspaceID : "";
    if (!dir) return "unresolvable";
    if (realpathEqual(dir, directory)) return "ours";
    if (ws && myWorkspaceID && ws === myWorkspaceID) return "ours";
    return "foreign";
  }

  /**
   * @param {"ours"|"foreign"|"unresolvable"} kind
   */
  function cacheOwnership(sessionID, kind) {
    // Tombstoned sessions must not gain fresh ownership entries (F-aorp2-r2-01).
    if (kind === "unresolvable" || deletedSessions.has(sessionID)) return;
    setBounded(ownershipCache, sessionID, kind);
  }

  async function resolveOwnership(sessionID, { retry = false } = {}) {
    const cached = ownershipCache.get(sessionID);
    if (cached) return cached;
    let kind = await probeOwnership(sessionID);
    // evaluate deny retries once to avoid false-deny on transient failure (D17.5)
    if (kind === "unresolvable" && retry) kind = await probeOwnership(sessionID);
    cacheOwnership(sessionID, kind);
    return kind;
  }

  // ── D17.2 atomic single-winner attempt lifecycle (D26 three-terminal) ─────

  function beginAttempt(sessionID) {
    const st = getSessionState(sessionID);
    if (!st) return { attempt: 0, gen: transportGen };
    st.attempt += 1;
    st.pendingAttempt = st.attempt; // begin invalidates the previous pending attempt
    // The takeover clock starts at BEGIN (acceptance), not at worker dequeue —
    // queue wait counts toward the stuck margin (F-aorp2-r1-01: a queued-but-
    // unstarted job must be recoverable via evaluate takeover, not denied
    // "pending" until the worker drains a full queue).
    st.attemptStartedAt = Date.now();
    return { attempt: st.attempt, gen: transportGen };
  }

  /**
   * Single-winner publish (D17.2 point 2; D26):
   * - winner (token + gen both pass) → apply + reconciled=true + consume barrier
   * - owning gen-mismatch (holds the barrier, gen changed) → discard entirely
   *   + consume barrier (F-6-1); reconciled stays false → next evaluate
   *   reconciles authoritatively (eventual admission)
   * - superseded (token advanced) → discard; barrier belongs to the newer attempt
   */
  async function publishAttempt(sessionID, ref, outcome) {
    const st = sessions.get(sessionID);
    if (!st) return;
    if (ref.attempt === st.attempt && ref.gen === transportGen) {
      st.pendingAttempt = 0;
      st.reconciled = true;
      st.reconcileGen = ref.gen;
      if (outcome.blocking) {
        st.blocking = true;
        st.blockingReason =
          outcome.blockingReason ||
          outcome.reason ||
          "idle/stop fail-closed";
      } else {
        st.blocking = false;
        st.blockingReason = "";
      }
      if (!outcome.blocking && outcome.reminder) {
        st.reminder = outcome.reminder;
        st.reminderDelivered = false;
        await deliverReminder(sessionID, outcome.reminder);
      } else if (!outcome.reminder) {
        st.reminder = "";
      }
      return;
    }
    if (ref.attempt === st.pendingAttempt && ref.gen !== transportGen) {
      // completed-but-generation-invalidated: consume the barrier, keep stale
      st.pendingAttempt = 0;
      return;
    }
    // superseded: discard — MUST NOT touch pendingAttempt (D17.2 point 2)
  }

  /**
   * Report a runner failure (fail-open, D17) to the plugin log. Never carried
   * in event.message, ctx.session.synthetic, an admission handoff or
   * lastReason: the diagnostic is for the user, not the model.
   */
  function reportRunnerFailure(diagnostic) {
    try {
      console.warn(`[devpro-hooks] ${diagnostic}`);
    } catch {
      /* diagnostics are best-effort */
    }
  }

  // ── Stop payload gates (shared with V1 STOP_GATES) ────────────────────────

  function stopPayload(sessionID) {
    return JSON.stringify({
      session_id: sessionID,
      cwd: directory,
      hook_event_name: "Stop",
    });
  }

  /**
   * Run the shared Stop payload gates. `asyncSpawn` picks the async runner for
   * the event-stream worker (D17.3). Decision gates are async
   * (fix-hook-gate-server-block) — this sync leg applies to Stop payload gates
   * only (fast Stop scripts, not the pre-tool chain).
   */
  async function runStopGates(sessionID, { asyncSpawn = false } = {}) {
    const payload = stopPayload(sessionID);
    let sawBlock = false;
    let blockReason = "";
    let reminder = "";
    for (const g of STOP_GATES) {
      const gatePath = path.join(HOOKS_DIR, g.gate);
      // R9 (D17): only an explicit block decision locks; a runner failure is
      // reported to the plugin log and the remaining Stop gates still run.
      let classified;
      try {
        const result = runHook
          ? await runHook({ event: g.event, gate: gatePath, host: HOST, payload, cwd: directory, env: sessionEnv(sessionID) })
          : asyncSpawn
            ? await defaultRunHookAsync({ event: g.event, gate: gatePath, host: HOST, payload, cwd: directory, env: sessionEnv(sessionID) })
            : defaultRunHook({ event: g.event, gate: gatePath, host: HOST, payload, cwd: directory, env: sessionEnv(sessionID) });
        classified = classifyRunnerResult(result, { event: g.event, gate: gatePath });
      } catch {
        classified = exceptionFailure({ event: g.event, gate: gatePath });
      }
      if (classified.kind === "runner-failure") {
        reportRunnerFailure(classified.diagnostic);
        continue;
      }
      if (classified.reminder) reminder = classified.reminder;
      if (classified.kind === "block") {
        sawBlock = true;
        blockReason = classified.reason || "Stop decision:block";
      }
    }
    return { blocking: sawBlock, blockingReason: blockReason, reminder };
  }

  // ── Reminder delivery (D17: synthetic only; deny path uses event.message) ─

  async function deliverReminder(sessionID, text) {
    const st = getSessionState(sessionID);
    if (!text) {
      if (st) st.reminder = "";
      return;
    }
    const synthetic = ctx?.session?.synthetic;
    if (typeof synthetic !== "function") return; // prompt-hook backup stays armed
    try {
      // ctx.session.synthetic does NOT trigger prompt hooks (no self-recursion)
      await synthetic({ sessionID, text });
      if (st) st.reminderDelivered = true;
    } catch {
      // undelivered → prompt hook prepends it into the next admitted prompt
    }
  }

  // ── Admission handoff (V1 tool.execute.after parity: execute.after/prompt) ─

  function queueHandoff(sessionID, text) {
    if (!text || !sessionID) return;
    const list = handoffs.get(sessionID) || [];
    list.push(text);
    if (list.length > V2_HANDOFF_MAX) list.splice(0, list.length - V2_HANDOFF_MAX);
    handoffs.set(sessionID, list);
  }

  function takeHandoff(sessionID) {
    const list = handoffs.get(sessionID);
    if (!list || !list.length) return "";
    const text = list.shift() || "";
    if (!list.length) handoffs.delete(sessionID);
    return text;
  }

  // ── D16 decision-path gates (V2 action → V1-shared gate payloads) ─────────

  /**
   * Resolve the Task prompt for subagent admission (T4-live fix).
   * Fast path: event.metadata.prompt (host passthrough when present).
   * Fallback: live-read the tool call's input via ctx.session.context using
   * event.source.id (the tool part id); tool part input lives at
   * `part.state.input` per OpenAPI (Session.Message.Assistant.Tool +
   * ToolState.Running/Completed carry input as an object).
   * Unresolvable → null → caller denies (fail-closed, never allow).
   */
  async function resolveSubagentPrompt(event, sessionID) {
    const meta =
      event && event.metadata && typeof event.metadata === "object"
        ? event.metadata
        : null;
    if (meta && typeof meta.prompt === "string" && meta.prompt) {
      return meta.prompt;
    }
    const source =
      event && event.source && typeof event.source === "object"
        ? event.source
        : null;
    const toolCallId =
      source && typeof source.id === "string" && source.id ? source.id : "";
    const contextFn =
      ctx && ctx.session && typeof ctx.session.context === "function"
        ? ctx.session.context.bind(ctx.session)
        : null;
    if (!toolCallId || !contextFn) return null;
    let messages;
    try {
      messages = await contextFn({ sessionID });
    } catch {
      return null;
    }
    if (!Array.isArray(messages)) return null;
    for (const msg of messages) {
      const parts =
        msg && Array.isArray(msg.content) ? msg.content : null;
      if (!parts) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (part.id !== toolCallId) continue;
        const stateInput =
          part.state && typeof part.state === "object"
            ? part.state.input
            : undefined;
        if (typeof stateInput === "string" && stateInput) return stateInput;
        if (
          stateInput &&
          typeof stateInput === "object" &&
          typeof stateInput.prompt === "string" &&
          stateInput.prompt
        ) {
          return stateInput.prompt;
        }
        if (
          part.input &&
          typeof part.input === "object" &&
          typeof part.input.prompt === "string" &&
          part.input.prompt
        ) {
          return part.input.prompt;
        }
        return null;
      }
    }
    return null;
  }

  // ── D5 (fix-flow-gate-gaps): write/edit proposal content contract ─────────
  //
  // Real host shape (T-R5a live probe, notes/tmp/t-r5a-live-probe/probe-log.jsonl):
  // write AND edit tools both arrive as action:"edit" + resources:[path] +
  // metadata:{files:[FileDiff]} — no proposal fields on the event. During
  // evaluate the in-flight tool part is already visible via
  // ctx.session.context({sessionID}) and is matched exactly by
  // event.source.id === part.id; the real tool args live at part.state.input.
  //
  // Source order (design D5): (1) live-read part state.input/part.input;
  // (2) explicit proposal fields on event/event.metadata (args-as-metadata
  // host variant); (3) neither → named fail-closed deny with ZERO gate calls.
  // Multi-resource write/edit events never reach this order: one event carries
  // one proposal source, so the whole batch is denied up front with zero gate
  // calls (D3, fix-cross-model-review-followups) — a single proposal is never
  // applied across resources.
  // The on-disk/current content is NEVER a source; metadata.files[].patch is a
  // unified diff used only in the deny reason as a diagnostic note.

  const V2_PROPOSAL_DENY_PREFIX =
    "OpenCode V2 write/edit proposal fields unresolvable (fail-closed";
  const V2_CAPABILITY_DENY_PREFIX =
    "OpenCode V2 host capability unavailable (fail-closed";
  // Frozen named prefix for the multi-resource write/edit deny (D3,
  // fix-cross-model-review-followups): one event carries ONE proposal source
  // (source.id / live part / explicit field set), so a batch cannot bind a
  // per-resource proposal and is refused up front — zero context reads, zero
  // gate calls.
  const V2_MULTI_RESOURCE_DENY_PREFIX =
    "OpenCode V2 write/edit multi-resource event cannot bind a per-resource proposal (fail-closed)";
  const V2_PROPOSAL_DENY_RECOVERY =
    "recovery=disable this plugin's write/edit content gate (.opencode/plugins/devpro-hooks.js) or use the existing user-authorized exception path, then re-enable after fixing the dispatch/host mapping";

  function firstStringValue(...values) {
    for (const value of values) {
      if (typeof value === "string") return value;
    }
    return undefined;
  }

  function firstBooleanValue(...values) {
    for (const value of values) {
      if (typeof value === "boolean") return value;
    }
    return undefined;
  }

  /** Deny-reason diagnostic only: the FileDiff patch is NEVER a content source. */
  function writeEditPatchDiagnosticNote(event) {
    const meta =
      event && event.metadata && typeof event.metadata === "object"
        ? event.metadata
        : null;
    const file =
      meta && Array.isArray(meta.files)
        ? meta.files.find((entry) => entry && typeof entry.patch === "string")
        : null;
    return file
      ? "; note=metadata.files[].patch present (unified diff; diagnostic only; NOT a content source)"
      : "";
  }

  function buildWriteEditDenyReason({ capabilityIssue, sourceId, misses, event }) {
    const prefix = capabilityIssue
      ? `${V2_CAPABILITY_DENY_PREFIX}; capability=${capabilityIssue}`
      : V2_PROPOSAL_DENY_PREFIX;
    return (
      `${prefix}; source=${sourceId || "none"}; missing=${misses.join("+") || "proposal-fields"}; ` +
      `${V2_PROPOSAL_DENY_RECOVERY}${writeEditPatchDiagnosticNote(event)})`
    );
  }

  /**
   * Tool identity from the live part name; field shape only when the name is
   * absent. Unknown identity / missing fields → `{ ok:false, missing }`.
   */
  function proposalFromLivePart(liveName, input) {
    const name = String(liveName || "").trim().toLowerCase();
    const content = firstStringValue(input.content);
    const oldString = firstStringValue(input.old_string, input.oldString);
    const newString = firstStringValue(input.new_string, input.newString);
    const patchText = firstStringValue(input.patchText, input.patch, input.diff);
    let toolName = "";
    if (name === "write") toolName = "Write";
    else if (name === "edit") toolName = "Edit";
    else if (name === "apply_patch" || name === "patch" || name === "functions.apply_patch") {
      toolName = "functions.apply_patch";
    } else if (!name) {
      if (oldString !== undefined || newString !== undefined) toolName = "Edit";
      else if (content !== undefined) toolName = "Write";
      else if (patchText !== undefined) toolName = "functions.apply_patch";
    }
    if (!toolName) {
      return { ok: false, missing: name ? `tool-identity(${name})` : "tool-identity" };
    }
    if (toolName === "Write") {
      if (content === undefined) return { ok: false, missing: "content" };
    } else if (toolName === "Edit") {
      if (oldString === undefined || newString === undefined) {
        return { ok: false, missing: "old_string/new_string" };
      }
    } else if (patchText === undefined) {
      return { ok: false, missing: "patchText" };
    }
    return { ok: true, toolName };
  }

  /**
   * Source 2: explicit proposal fields only (args-as-metadata host variant).
   * MUST NOT read any "current content" field.
   */
  function proposalFromExplicitFields(event, meta) {
    const pickString = (name) =>
      firstStringValue(
        event && typeof event[name] === "string" ? event[name] : undefined,
        meta && typeof meta[name] === "string" ? meta[name] : undefined
      );
    const pickBoolean = (name) =>
      firstBooleanValue(
        event && typeof event[name] === "boolean" ? event[name] : undefined,
        meta && typeof meta[name] === "boolean" ? meta[name] : undefined
      );
    const content = pickString("content");
    const oldString = firstStringValue(pickString("old_string"), pickString("oldString"));
    const newString = firstStringValue(pickString("new_string"), pickString("newString"));
    const replaceAll = firstBooleanValue(pickBoolean("replace_all"), pickBoolean("replaceAll"));
    if (content === undefined && oldString === undefined && newString === undefined) {
      return null;
    }
    if (oldString !== undefined || newString !== undefined) {
      if (oldString === undefined || newString === undefined) {
        return { ok: false, missing: "old_string/new_string" };
      }
      const fields = { old_string: oldString, new_string: newString };
      if (replaceAll !== undefined) fields.replace_all = replaceAll;
      return { ok: true, toolName: "Edit", fields };
    }
    return { ok: true, toolName: "Write", fields: { content } };
  }

  /**
   * Resolve the write/edit proposal for ONE event (caller invokes this once,
   * before the resource loop). `{ ok:true, toolName, fields }` or
   * `{ ok:false, reason }` — the caller denies without calling any gate.
   */
  async function resolveWriteEditProposal(event, sessionID) {
    const meta =
      event && event.metadata && typeof event.metadata === "object"
        ? event.metadata
        : null;
    const source =
      event && event.source && typeof event.source === "object" ? event.source : null;
    const sourceId = source && typeof source.id === "string" && source.id ? source.id : "";
    const misses = [];
    let capabilityIssue = "";

    // Source 1 — live-read the in-flight tool part matched by event.source.id.
    const contextFn =
      ctx && ctx.session && typeof ctx.session.context === "function"
        ? ctx.session.context.bind(ctx.session)
        : null;
    if (!sessionID) misses.push("session.id");
    if (!sourceId) misses.push("source.id");
    let liveInput = null;
    let liveName = "";
    if (!contextFn) {
      capabilityIssue = "ctx.session.context";
    } else if (sourceId && sessionID) {
      let messages;
      let contextFailed = false;
      try {
        messages = await contextFn({ sessionID });
      } catch {
        contextFailed = true;
      }
      if (contextFailed) {
        capabilityIssue = "ctx.session.context";
      } else if (!Array.isArray(messages)) {
        capabilityIssue = "session.context.return-shape";
      } else {
        let matched = false;
        for (const msg of messages) {
          const parts = msg && Array.isArray(msg.content) ? msg.content : null;
          if (!parts) continue;
          for (const part of parts) {
            if (!part || typeof part !== "object" || part.id !== sourceId) continue;
            matched = true;
            const stateInput =
              part.state && typeof part.state === "object" ? part.state.input : undefined;
            const raw = stateInput !== undefined ? stateInput : part.input;
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
              liveInput = raw;
              liveName = typeof part.name === "string" ? part.name : "";
            } else {
              capabilityIssue = "part.state.input";
            }
            break;
          }
          if (matched) break;
        }
        if (!matched) misses.push(`part[${sourceId}]`);
      }
    }

    if (liveInput) {
      const live = proposalFromLivePart(liveName, liveInput);
      if (live.ok) {
        return { ok: true, toolName: live.toolName, fields: liveInput };
      }
      misses.push(live.missing);
    }

    // Source 2 — explicit proposal fields (only proposal fields, never current).
    const explicit = proposalFromExplicitFields(event, meta);
    if (explicit && explicit.ok) {
      return { ok: true, toolName: explicit.toolName, fields: explicit.fields };
    }
    if (explicit && !explicit.ok) misses.push(explicit.missing);
    if (!explicit) misses.push("explicit-fields");

    return {
      ok: false,
      reason: buildWriteEditDenyReason({ capabilityIssue, sourceId, misses, event }),
    };
  }

  async function runDecisionGates(action, event, sessionID) {
    const toolKey = V2_ACTION_TOOL_KEYS[action];
    const mapped = mapOpenCodeToolToProtocol(toolKey);
    const resources = Array.isArray(event.resources) ? event.resources : [];
    if (resources.length === 0) resources.push("");
    const key = V2_RESOURCE_KEY[action] || "input";
    let subagentPrompt;
    if (action === "subagent") {
      subagentPrompt = await resolveSubagentPrompt(event, sessionID);
      if (typeof subagentPrompt !== "string" || !subagentPrompt) {
        return {
          action: "deny",
          reason: "Spawn Context Admission Gate: subagent admission prompt unresolvable (fail-closed)",
        };
      }
    }
    // D3 (fix-cross-model-review-followups): a write/edit event binds ONE
    // proposal (single source.id / live part / explicit field set), so a
    // multi-resource event cannot bind a per-resource proposal. Deny the whole
    // event with the frozen named reason BEFORE any ctx.session.context read
    // and with ZERO gate calls — no unverified resource is ever admitted. A
    // future host carrying per-resource proposals resolves them ahead of this
    // branch; the deny reason is the recovery entry point.
    if ((action === "write" || action === "edit") && resources.length > 1) {
      return {
        action: "deny",
        reason:
          `${V2_MULTI_RESOURCE_DENY_PREFIX}; resources=${resources.length}; ` +
          "recovery=split the batch into single-resource write/edit calls, or use the existing user-authorized exception path " +
          "(disable this plugin's write/edit content gate at .opencode/plugins/devpro-hooks.js), then re-enable after fixing the dispatch/host mapping",
      };
    }
    // D5 (fix-flow-gate-gaps): resolve the write/edit proposal ONCE per event
    // (single-resource shape only — multi-resource events denied above),
    // before the resource loop. Real host sends action "edit" for BOTH Write
    // and Edit tools; the tool name comes from the live-read part. Unresolvable
    // → named fail-closed deny with ZERO gate calls (never validate the on-disk
    // current content).
    let writeEdit = null;
    if (action === "write" || action === "edit") {
      writeEdit = await resolveWriteEditProposal(event, sessionID);
      if (!writeEdit.ok) {
        return { action: "deny", reason: writeEdit.reason };
      }
    }
    // W5-CODE-001: every gated resource is covered 1:1 by its own proposal —
    // multi-resource write/edit events cannot bind a per-resource proposal and
    // are denied above (named fail-closed, zero gate calls; no unverified
    // resource is ever admitted). Other multi-resource actions still gate EVERY
    // resource — any deny denies the whole event. Never admit on a
    // first-resource-only check.
    let lastReason = "";
    for (const resource of resources) {
      let toolInput;
      let toolName = mapped.toolName;
      if (writeEdit) {
        toolName = writeEdit.toolName;
        toolInput = normalizeToolArgs(toolName, {
          ...writeEdit.fields,
          file_path: typeof resource === "string" ? resource : "",
        });
      } else {
        toolInput = { [key]: resource ?? "" };
        if (action === "subagent") {
          toolInput.prompt = subagentPrompt;
          if (event.metadata && typeof event.metadata === "object") {
            Object.assign(toolInput, event.metadata); // extra fields pass through
          }
        }
      }
      const payload = JSON.stringify({
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionID || "",
        cwd: directory,
      });
      for (const g of mapped.gates) {
        let classified;
        try {
          const result = runHook
            ? await runHook({ event: g.event, gate: g.gate, host: HOST, payload, cwd: directory, env: sessionEnv(sessionID) })
            : await defaultRunHookAsync({ event: g.event, gate: g.gate, host: HOST, payload, cwd: directory, env: sessionEnv(sessionID) });
          classified = classifyRunnerResult(result, { event: g.event, gate: g.gate });
        } catch {
          classified = exceptionFailure({ event: g.event, gate: g.gate });
        }
        if (classified.kind === "block") {
          return { action: "deny", reason: classified.reason };
        }
        if (classified.kind === "runner-failure") {
          // R9 (D17): fail open — report to the plugin log (never event.message)
          // and keep running the remaining gates.
          reportRunnerFailure(classified.diagnostic);
          if (isGithubWritePayload(JSON.parse(payload))) return {action:"deny",reason:"GitHub gate unavailable; write denied"};
          continue;
        }
        if (classified.reminder) lastReason = classified.reminder;
      }
    }
    return { action: "allow", reason: lastReason };
  }

  // ── D16/D17.4 evaluate: the single V2 deny surface ────────────────────────

  async function evaluate(event) {
    if (!event || typeof event !== "object") return;
    // D16 (V2-Q3): hooks run for allow/ask decisions only; an in-effect deny is
    // final. Never upgrade it — fail-closed polarity holds both directions.
    if (event.effect === "deny") return;
    const sessionID = String(event.sessionID || "");
    noteSession(sessionID);
    // ① ownership (D17.5)
    const own = await resolveOwnership(sessionID, { retry: true });
    if (own === "foreign") return; // pass-through — never deny other repos
    if (own === "unresolvable") {
      event.effect = "deny";
      event.message = "ownership unresolvable (fail-closed)";
      return;
    }
    const st = getSessionState(sessionID);
    if (!st) {
      // Tombstoned (deleted) session reaching evaluate: fail closed — no
      // state, no admission (F-aorp2-r2-01 ghost guard).
      event.effect = "deny";
      event.message = "session state unavailable (fail-closed)";
      return;
    }
    // ② barrier (D17.4 step 2): deny until the accepted idle's winner publish;
    //    stuck attempts are taken over (token advance + synchronous gates). The
    //    clock starts at beginAttempt (acceptance) — queue wait counts toward
    //    the margin (F-aorp2-r1-01); workerStopped (cleanup) always takes over.
    const stuckTakeover =
      st.pendingAttempt > 0 &&
      (workerStopped ||
        Date.now() - st.attemptStartedAt > takeoverTimeoutMs);
    if (st.pendingAttempt > 0 && !stuckTakeover) {
      event.effect = "deny";
      event.message = "stop verification pending (fail-closed)";
      return;
    }
    // ③ fast path vs authoritative reconcile (D17.4 step 3/4): fast path only
    //    when transport READY AND per-session reconciled in the current
    //    generation; deny cache re-verifies against shared state before deny.
    let blocking = false;
    let blockingReason = "";
    if (
      !stuckTakeover &&
      transport === "READY" &&
      st.reconciled &&
      !st.blocking
    ) {
      blocking = false;
    } else {
      // W10-CODE-001 superseded (fix-hook-gate-server-block): the archived
      // premise — sync spawn on the evaluate decision path is legal because
      // DEVPRO_HOOK_TIMEOUT_MS (30s, SIGKILL) bounds it — was overturned by
      // grandchild pipe inheritance: the real pre-tool → pre-pr-archive-gate
      // chain blocked the event loop for its true duration (measured 65.9s >
      // 30s cap; server watchdog restarts). The decision path now awaits
      // defaultRunHookAsync (runDecisionGates). Sync spawn still never appears
      // in the event pump: the for-await loop classifies + enqueues only, and
      // the worker uses asyncSpawn: true (D17.3).
      const ref = beginAttempt(sessionID);
      const outcome = await runStopGates(sessionID, { asyncSpawn: false });
      await publishAttempt(sessionID, ref, outcome);
      blocking = st.blocking;
      blockingReason = st.blockingReason;
    }
    if (blocking) {
      event.effect = "deny";
      event.message = blockingReason || "session blocked (fail-closed)";
      return;
    }
    // ④ action → gate table (D16)
    const action = String(event.action || "").trim();
    if (!Object.prototype.hasOwnProperty.call(V2_ACTION_TOOL_KEYS, action)) return;
    const decision = await runDecisionGates(action, event, sessionID);
    if (decision.action === "deny") {
      event.effect = "deny";
      event.message = decision.reason || "decision:block";
      return;
    }
    // W5-CODE-002: the decision path contains async server reads (subagent
    // live-read via session.context, injected runners) — an idle accepted
    // during the read may have raised a barrier or published a must-block.
    // Re-verify both before admitting; fail-closed polarity is not weakened.
    if (st.pendingAttempt > 0) {
      event.effect = "deny";
      event.message = "stop verification pending (fail-closed)";
      return;
    }
    if (st.blocking) {
      event.effect = "deny";
      event.message = st.blockingReason || "session blocked (fail-closed)";
      return;
    }
    if (decision.reason) queueHandoff(sessionID, decision.reason);
    // allow + reminder: keep event.effect unchanged (never auto-upgrade ask→allow)
  }

  // ── D15 prompt hook: reminder backup + admission handoff flush (transform) ─

  /**
   * Shell create.before (V2): inject the provider-neutral session env so the
   * agent's own shell commands (render, checkpoints, cost gates) can resolve a
   * host session on any runtime (F-hsn-r1-04). An explicit env value wins;
   * attribution is the last session seen by a prompt/tool hook here.
   */
  async function onShellCreateBefore(event) {
    if (!event || typeof event !== "object") return;
    const env = event.env;
    if (!env || typeof env !== "object") return;
    if (typeof env.DEVPRO_HOST_SESSION_ID === "string" && env.DEVPRO_HOST_SESSION_ID.trim()) return;
    if (lastSessionID) env.DEVPRO_HOST_SESSION_ID = lastSessionID;
  }

  async function onPrompt(event) {
    if (!event || typeof event !== "object") return;
    const sessionID = String(event.sessionID || "");
    noteSession(sessionID);
    const st = getSessionState(sessionID);
    if (!st) return;
    const prompt =
      event.prompt && typeof event.prompt === "object" ? event.prompt : event;
    if (typeof prompt?.text !== "string") return; // surface missing → stay pending
    let prefix = "";
    let hadReminder = false;
    if (st.reminder && !st.reminderDelivered) {
      prefix += (prefix ? "\n" : "") + st.reminder;
      hadReminder = true;
    }
    const handoff = takeHandoff(sessionID);
    if (handoff) prefix += (prefix ? "\n" : "") + handoff;
    if (!prefix) return;
    // Edits become the canonical persisted user input (V2-E3): the prompt hook
    // is the admission-preparation surface — a successful prepend here is the
    // admission-coupled delivery signal. Mark delivered only AFTER the mutation
    // succeeds (F-aorp2-r2-03); a failed mutation keeps the reminder pending for
    // the next admitted prompt. Corner case accepted: if preparation is
    // interrupted after our prepend, the reminder is consumed without admission
    // (no post-admit signal exists in the documented API — retrying would spam).
    prompt.text = `${prefix}\n${prompt.text}`;
    if (hadReminder) st.reminderDelivered = true;
    // MUST NOT push bare parts — text mutation only, no session corruption.
  }

  // ── D15 execute.after: admission handoff flush (result mutation) ──────────

  async function githubToolEvent(event, phase) {
    const toolName = String(event?.tool || "");
    if (!devproGithubToolName(toolName)) return;
    const payload = JSON.stringify({tool_name:toolName, tool_input:event.input,
      tool_response:event.result, cwd:directory, session_id:event.sessionID || ""});
    const args = {event:phase,gate:path.join(HOOKS_DIR,"github-mcp-gate.mjs"),host:HOST,
      payload,cwd:directory,env:sessionEnv(event.sessionID || "")};
    let result;
    try { result = runHook ? await runHook(args) : await defaultRunHookAsync(args); }
    catch { if (phase === "PreToolUse") throw new Error("GitHub gate unavailable; write denied"); return; }
    const classified = classifyRunnerResult(result,{event:phase,gate:args.gate});
    if (phase === "PreToolUse" && (classified.kind === "block" || classified.kind === "runner-failure")) {
      throw new Error(classified.reason || "GitHub gate unavailable; write denied");
    }
  }

  async function onExecuteAfter(event) {
    if (event?.status === "completed") await githubToolEvent(event,"PostToolUse");
    if (!event || typeof event !== "object") return;
    const sessionID = String(event.sessionID || "");
    noteSession(sessionID);
    const handoff = takeHandoff(sessionID);
    if (!handoff) return;
    const result = event.result;
    if (typeof result === "string") {
      event.result = result ? `${result}\n${handoff}` : handoff;
      return;
    }
    if (result && typeof result === "object") {
      if (typeof result.output === "string") {
        result.output = result.output ? `${result.output}\n${handoff}` : handoff;
        return;
      }
      if (typeof result.text === "string") {
        result.text = result.text ? `${result.text}\n${handoff}` : handoff;
        return;
      }
    }
    // no text part → documented fallback: synthetic (model-visible, no hooks)
    const synthetic = ctx?.session?.synthetic;
    if (typeof synthetic === "function") {
      try {
        await synthetic({ sessionID, text: handoff });
      } catch {
        const list = handoffs.get(sessionID) || [];
        list.unshift(handoff);
        handoffs.set(sessionID, list);
      }
    }
  }

  // ── D11 skill discovery: ctx.skill.transform over the catalog manifest ────
  // (refactor-agent-skills-entry): the 2-entry topology's `.agents/skills/devpro`
  // / `.claude/skills/devpro` symlinks both resolve to `.devpro/agent-skills`,
  // whose `manifest.json` is the single SSOT inventory of every user-invocable
  // skill. This plugin walks that manifest directly (not a per-skill entry
  // directory readdir) so a new catalog skill needs no plugin change.

  const SKILL_CATALOG_MANIFEST_REL = ".devpro/agent-skills/manifest.json";

  function readSkillFrontmatter(content) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || "");
    const meta = {};
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const mm = /^(name|description):\s*(.+)\s*$/.exec(line);
        if (!mm) continue;
        let value = mm[2].trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1); // YAML-quoted scalar
        }
        meta[mm[1]] = value;
      }
    }
    return meta;
  }

  async function registerSkills() {
    const transform =
      ctx && ctx.skill && typeof ctx.skill.transform === "function"
        ? ctx.skill.transform
        : null;
    if (!transform) return;
    await transform((editor) => {
      if (!editor || typeof editor.add !== "function") return;
      const manifestPath = path.join(directory, SKILL_CATALOG_MANIFEST_REL);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        // Unreadable (consumer not synced) or unparseable manifest — D11:
        // return without throwing, so the whole plugin never disables itself
        // over a missing/malformed catalog.
        return;
      }
      const groups = Array.isArray(manifest?.groups) ? manifest.groups : [];
      for (const group of groups) {
        const skills = Array.isArray(group?.skills) ? group.skills : [];
        for (const skill of skills) {
          // id is the catalog's bare name: the D12 host probe confirmed
          // OpenCode lists and invokes catalog skills by bare id, with no
          // `devpro:` namespace.
          const id = typeof skill?.name === "string" ? skill.name : "";
          const skillRelPath = typeof skill?.path === "string" ? skill.path : "";
          if (!id || !skillRelPath) continue;
          const skillPath = path.join(directory, skillRelPath, "SKILL.md");
          if (!existsSync(skillPath)) continue; // no SKILL.md — skip this entry
          try {
            const content = readFileSync(skillPath, "utf8");
            const meta = readSkillFrontmatter(content);
            editor.add({
              id,
              name: meta.name || id,
              description: meta.description || "",
              // OpenCode v2.0.11 `Skill.Info` requires `path`; `location` makes
              // `editor.add` die with SchemaError(Missing key at ["path"]) and
              // the host then disables the whole plugin.
              path: skillPath,
              content, // mirror of the SSOT file — no second content tree
            });
          } catch (err) {
            // Per-skill isolation (D11 NFR8 / plugin-load invariant): one
            // skill's schema/read failure MUST NOT stop the rest of the
            // catalog from registering, and MUST NOT be silent.
            console.warn(
              `[devpro-hooks] skill registration failed for ${id}:`,
              err && err.message ? err.message : err
            );
          }
        }
      }
    });
  }

  // ── event stream (D17.2/D17.3): classification → ownership → barrier+enqueue ─

  function enterReady() {
    if (transport !== "READY") {
      transport = "READY";
      transportGen += 1;
      resubscribeBudget = V2_MAX_RESUBSCRIBE;
      // generation switch invalidates cache freshness for ALL sessions; cache
      // CONTENT is kept but marked stale — never cleared-and-trusted (F-4-1)
      for (const st of sessions.values()) st.reconciled = false;
    }
  }

  function handleIdle(sessionID) {
    const chain = sessionChains.get(sessionID) || Promise.resolve();
    const next = chain.then(() => handleIdleTask(sessionID)).catch(() => {});
    setBounded(sessionChains, sessionID, next);
  }

  async function handleIdleTask(sessionID) {
    if (deletedSessions.has(sessionID)) return; // ghost guard (F-aorp2-r2-01)
    const own = await resolveOwnership(sessionID);
    if (deletedSessions.has(sessionID)) return; // deleted while the probe was in flight
    if (own !== "ours") {
      if (own === "unresolvable") {
        const st = getSessionState(sessionID);
        if (st) st.reconciled = false; // reconcile flag: evaluate goes authoritative
      }
      return; // foreign ignore / unresolvable no-action (D17.5)
    }
    if (queue.length() >= V2_QUEUE_CAP) {
      // F-aorp2-r2-04 note: the cap is a SOFT upper bound. The check-then-push
      // pair below is synchronous (single JS task, no await between) so it
      // cannot interleave-overshoot today; if a future change inserts an await
      // here, a bounded overshoot becomes possible — fail-safe is unchanged
      // either way (overflow drops the event and DEGRADED routes enforcement to
      // the authoritative path; never silent allow).
      // cap exceeded: drop THIS event (no begin → no stuck barrier) + DEGRADED —
      // prefer the authoritative path over blocking the pump (D17.3). Dropped
      // sessions recover via evaluate's authoritative reconcile.
      droppedEvents += 1;
      transport = "DEGRADED";
      return;
    }
    const { attempt, gen } = beginAttempt(sessionID); // accept ⇒ barrier (D17.3)
    if (!attempt) return; // tombstoned mid-task → never enqueue ghost work
    queue.push({ sessionID, attempt, gen });
  }

  function handleDeleted(sessionID) {
    if (!sessionID) return;
    // ownership-filtered fire-and-forget (never block the pump)
    Promise.resolve()
      .then(async () => {
        const own = await resolveOwnership(sessionID);
        // unresolvable: no action (D17.5 event-face disposition). Ours AND
        // foreign both clear local bookkeeping (foreign never runs gates —
        // clearing is local-only, no runner, no shared state) and tombstone the
        // session so scheduled chains cannot recreate ghost state (F-aorp2-r2-01).
        if (own === "unresolvable") return;
        sessions.delete(sessionID);
        ownershipCache.delete(sessionID);
        handoffs.delete(sessionID);
        sessionChains.delete(sessionID);
        if (deletedSessions.size >= V2_BOOKKEEPING_CAP) {
          const oldest = deletedSessions.values().next().value;
          if (oldest !== undefined) deletedSessions.delete(oldest);
        }
        deletedSessions.add(sessionID);
      })
      .catch(() => {});
  }

  function handleEvent(ev) {
    const type = String((ev && ev.type) || "");
    const data = ev && typeof ev.data === "object" ? ev.data : {};
    enterReady(); // ≥1 event (incl. server.connected) proves the stream live
    if (type === "server.connected") return;
    const sessionID = String(data.sessionID || ev?.sessionID || "");
    if (type === "session.deleted") {
      handleDeleted(sessionID);
      return;
    }
    if (type === "session.idle" && sessionID) {
      handleIdle(sessionID);
      return;
    }
    // other native/rpc events: classified no-op — never silent-success-as-allow
  }

  async function afterStreamFailure() {
    if (signal.aborted) return true;
    if (resubscribeBudget <= 0) {
      transport = "FAILED";
      // D17.2 FAILED marker; plugin reload (OpenCode watcher) is outer recovery
      console.error("[devpro-hooks] event stream failed, reconcile-only enforcement");
      return true;
    }
    resubscribeBudget -= 1;
    transport = "DEGRADED";
    const delay = backoffMs[Math.min(backoffMs.length - 1, backoffIdx++)];
    if (delay > 0) await sleep(delay, signal);
    return signal.aborted;
  }

  async function eventLoop() {
    while (!signal.aborted) {
      let stream;
      try {
        stream = ctx.event.subscribe({ signal });
      } catch {
        if (await afterStreamFailure()) return;
        continue;
      }
      try {
        for await (const ev of stream) {
          if (signal.aborted) return;
          handleEvent(ev); // classification only — no inline spawn (D17.3)
        }
      } catch {
        /* source failure — fall through */
      }
      if (signal.aborted) return;
      if (await afterStreamFailure()) return;
    }
  }

  async function workerLoop() {
    while (!signal.aborted) {
      const job = await queue.take();
      if (signal.aborted) return;
      if (!job) continue;
      // NOTE: no attemptStartedAt stamping here — beginAttempt stamps the clock
      // at acceptance; a superseded job dequeued later must NOT reset the newer
      // attempt's takeover clock (F-aorp2-r1-01).
      let outcome;
      try {
        outcome = await runStopGates(job.sessionID, { asyncSpawn: true });
      } catch {
        // every attempt has exactly one completion path (D17.3) — never stuck.
        // R9 (D17): a job that failed to run is a runner failure, not a block.
        reportRunnerFailure(formatRunnerFailure("Stop", "stop-gates", "exception"));
        outcome = { blocking: false, blockingReason: "" };
      }
      try {
        await publishAttempt(
          job.sessionID,
          { attempt: job.attempt, gen: job.gen },
          outcome
        );
      } catch {
        /* publish must never kill the worker */
      }
    }
  }

  function register() {
    ctx.permission.hook("evaluate", evaluate);
    ctx.session.hook("prompt", onPrompt);
    ctx.tool.hook("execute.before", event => githubToolEvent(event,"PreToolUse"));
    ctx.tool.hook("execute.after", onExecuteAfter);
    // F-hsn-r1-04: propagate the (best-effort) session into shell tool
    // subprocesses so identity-consuming gates work on hosts without
    // claude-code/codex session env vars.
    if (ctx.shell && typeof ctx.shell.hook === "function") {
      ctx.shell.hook("create.before", onShellCreateBefore);
    }
  }

  async function start() {
    // D18 registration stays non-blocking, but a failure MUST NOT be silent:
    // the host disables the WHOLE plugin when a transform fails (v2.0.11 hit
    // this via the `path`/`location` schema mismatch), so swallowing the error
    // hides a total loss of gates. Surface it; doctor still reports gaps.
    registerSkills().catch((err) => {
      console.error("[devpro-hooks] skill registration failed:", err);
    });
    workerPromise = workerLoop().catch(() => {});
    eventLoopPromise = eventLoop().catch(() => {});
  }

  function cancellableTimer(ms) {
    let t;
    const promise = new Promise((resolve) => {
      t = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(t) };
  }

  async function dispose() {
    abort.abort();
    workerStopped = true;
    // The worker settles on abort (queue take → null). A mid-job run may take
    // up to the runner timeout; bound cleanup without leaking a timer handle.
    const guard = cancellableTimer(1000);
    try {
      await Promise.race([workerPromise, guard.promise]);
    } finally {
      guard.cancel();
    }
    sessions.clear();
    handoffs.clear();
    ownershipCache.clear();
    sessionChains.clear();
    deletedSessions.clear();
  }

  return {
    register,
    start,
    dispose,
    diagnostics: () => ({
      transport: () => transport,
      transportGen: () => transportGen,
      sessionState: sessions,
      queueLength: () => queue.length(),
      dropped: () => droppedEvents,
      ownershipCacheSize: () => ownershipCache.size,
      sessionChainsSize: () => sessionChains.size,
    }),
  };
}

export default {
  id: "devpro-hooks",
  async setup(ctx) {
    // D19: load marker only — never payloads or secrets (risk class (d)).
    console.log(`[devpro-hooks] v2 setup loaded ${(ctx && ctx.app && ctx.app.version) || "unknown"}`);
    const options =
      ctx && ctx.options && typeof ctx.options === "object" ? ctx.options : {};
    const runtime = createV2Runtime(ctx, options);
    runtime.register();
    await runtime.start();
    // Test-mode-only observability handle (F-aorp2-r2-02): production must not
    // carry the diagnostics surface on the ctx.
    if (ctx && typeof ctx === "object" && options.testMode === true) {
      ctx.__devproHooksV2 = runtime.diagnostics();
    }
    return runtime.dispose; // V2 lifecycle cleanup (abort stream + worker)
  },
  async server(input = {}, pluginOptions = {}) {
    // V1 face (1.18.29): unchanged createDevproPluginHooks wiring (D1–D3, D10–D11).
    return createDevproPluginHooks({
      directory: input.directory || input.worktree || DEFAULT_REPO_ROOT,
      worktree: input.worktree,
      client: input.client,
      ...pluginOptions,
    });
  },
};

// Additive test seams (fix-hook-gate-server-block): sync/async runner
// equivalence tests import these named exports; the `export default {`
// dual-export shape stays byte-intact for multi-runtime parity.
export { defaultRunHook, defaultRunHookAsync };
