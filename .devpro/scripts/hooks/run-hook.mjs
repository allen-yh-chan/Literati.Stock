#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HOOK_NOOP_POLICY, resolveRigorLevel, shouldNoOp } from "./lib/rigor-level.mjs";
import { isGithubWritePayload, githubHookDeny } from "./lib/github-mcp-tools.mjs";
import { isCwdAvailable } from "./lib/cwd-availability.mjs";
import { getRepoRoot } from "./lib/git-utils.mjs";

const [, , eventName, scriptPath, ...runnerArgs] = process.argv;
const MAX_HOOK_TIMEOUT_MS = 180000;

function write(stream, value) {
  if (value) stream.write(value);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function resolveHookTimeoutMs(env = process.env) {
  const raw = env.DEVPRO_HOOK_TIMEOUT_MS;
  if (!raw) return MAX_HOOK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_HOOK_TIMEOUT_MS;
  // Math.max(1, …): spawnSync treats timeout 0 as "no timeout", so a sub-millisecond value must not floor to 0.
  return Math.min(Math.max(1, Math.floor(parsed)), MAX_HOOK_TIMEOUT_MS);
}

if (!eventName || !scriptPath) {
  fail("hook wrapper error: usage node .devpro/scripts/hooks/run-hook.mjs <event> <script> [--host=<runtime>]");
}

function parseHostMarker(args) {
  const marker = args.find((arg) => typeof arg === "string" && arg.startsWith("--host="));
  if (!marker) return "";
  const value = marker.slice("--host=".length).trim();
  return /^[a-z0-9-]+$/.test(value) ? value : "";
}

const PAYLOAD_EVENTS = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"]);
const STOP_PAYLOAD_HOOKS = new Set(["recap-check.mjs", "post-pr-completion-check.mjs", "stop-handoff-cite.mjs", "release-back-merge-check.mjs"]);
const EVENT_ALIASES = new Map([
  ["preToolUse", "PreToolUse"],
  ["postToolUse", "PostToolUse"],
  ["beforeSubmitPrompt", "UserPromptSubmit"],
  ["stop", "Stop"],
  // OpenCode host aliases (plugin normally maps; accept raw names fail-safe)
  ["session.idle", "Stop"],
  ["tool.execute.before", "PreToolUse"],
  ["tool.execute.after", "PostToolUse"],
  ["chat.message", "UserPromptSubmit"],
]);

function normalizeEventName(event) {
  return EVENT_ALIASES.get(event) || event;
}

function shouldForwardInput(event, scriptBasename) {
  const normalizedEvent = normalizeEventName(event);
  return PAYLOAD_EVENTS.has(normalizedEvent) || (
    normalizedEvent === "Stop" && STOP_PAYLOAD_HOOKS.has(scriptBasename)
  );
}

/**
 * B-fallback (defense-in-depth): resolve relative scriptPath against the
 * repo root (= wrapperDir/../../../) when cwd-relative check fails.
 * This handles production gate-path shape ".devpro/scripts/hooks/<gate>.mjs"
 * which is root-relative — resolving it against wrapperDir would produce a
 * doubled path: <root>/.devpro/scripts/hooks/.devpro/scripts/hooks/<gate>.mjs.
 * Resolving against repo root (wrapperDir 3 levels up) gives the correct path.
 * wrapperDir = <root>/.devpro/scripts/hooks  →  3 levels up = <root>.
 */
function resolveScriptPath(rawPath) {
  // Absolute paths: use as-is
  if (path.isAbsolute(rawPath)) return rawPath;
  // Relative: first try cwd-relative (normal case)
  if (existsSync(rawPath)) return rawPath;
  // B-fallback: try relative to repo root (wrapperDir goes up 3 levels to root)
  const wrapperDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(wrapperDir, "../../..");
  const fromRoot = path.resolve(repoRoot, rawPath);
  if (existsSync(fromRoot)) return fromRoot;
  // Return original (missing path handled by caller — a silent pass on every host profile)
  return rawPath;
}

const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
});

let githubWrite = false;
try { githubWrite = normalizeEventName(eventName) === "PreToolUse" && isGithubWritePayload(JSON.parse(input)); } catch { githubWrite = path.basename(scriptPath) === "github-mcp-gate.mjs"; }
function denyGithubFailure(reason) {
  if (!githubWrite) return;
  process.stdout.write(JSON.stringify(githubHookDeny(`GitHub write blocked: ${reason}. Repair the hook before retrying.`)));
  process.exit(0);
}

const candidateScriptPath = resolveScriptPath(scriptPath);
const resolvedScriptPath = existsSync(candidateScriptPath) ? realpathSync(candidateScriptPath) : candidateScriptPath;
const hookHost = parseHostMarker(runnerArgs);

// Session cwd may vanish (deleted worktree / moved session). process.cwd()
// throws ENOENT in that state, so probe it before anything spawns and fail
// with a named, actionable diagnostic instead of an opaque gate failure
// (strengthen-hook-runtime-robustness). All host profiles fail open: no child runs in
// this branch, so the run passes (fix-codex-reviewer-intent-candidate-cap D17).
// The resolveScriptPath/parseHostMarker calls above are pure path/string ops:
// existsSync on a relative path simply returns false under a deleted cwd, so
// the probe below is reached before any spawn or throwing cwd read
// (cross-model F3).
if (!isCwdAvailable()) {
  denyGithubFailure("working directory unavailable");
  process.stderr.write(
    `hook ${eventName} ${scriptPath}: session working directory missing (deleted worktree?) — run session_move (or switch to an existing directory) and retry; fail-open\n`
  );
  process.exit(0);
}

if (!existsSync(resolvedScriptPath)) {
  denyGithubFailure("hook file missing");
  // All host profiles fail open (exit 0, empty output): a missing requested hook
  // file is a silent pass, as it was for every host except `.opencode` before
  // fix-codex-reviewer-intent-candidate-cap D17.
  process.exit(0);
}


// Resolve rigor level (env > .devpro/rules.config > "lite") and apply
// Layer 1 no-op policy: if this hook should be skipped at the current level,
// exit 0 immediately without spawning. pre-tool-gate.mjs / post-tool-gate.mjs
// are never skipped here — they carry baseline gates filtered at Layer 2.
const cwd = process.cwd();
// The launcher can come from shared rules while the hook runs in another checkout.
const resolvedLevel = resolveRigorLevel({ cwd: getRepoRoot(cwd) || cwd });
const scriptBasename = path.basename(resolvedScriptPath);
const hookEnv = {
  ...process.env,
  DEVPRO_HOOK_EVENT: eventName,
  DEVPRO_HOOK_PROTOCOL: "json",
  DEVPRO_AGENT_RULES_LEVEL: resolvedLevel,
  ...(hookHost ? { DEVPRO_HOOK_HOST: hookHost } : {}),
};

async function hasCrossRepoStopObligation() {
  if (resolvedLevel !== "off" || normalizeEventName(eventName) !== "Stop"
    || HOOK_NOOP_POLICY[scriptBasename] !== "cross-repo-stop") return false;
  try {
    const payload = JSON.parse(input || "{}") ?? {};
    const options = { crossRepositoryOnly: true };
    if (scriptBasename === "post-pr-completion-check.mjs") {
      const { resolveReminderSession } = await import("./lib/session-reminder.mjs");
      const { listOwnedPostPrStopMarkers } = await import("./lib/post-pr-completion-state.mjs");
      return listOwnedPostPrStopMarkers(cwd, resolveReminderSession(payload, hookEnv), options).length > 0;
    }
    const { releaseBackMergeStopContext, linkedReleaseBackMergeSources } = await import("./lib/release-back-merge-state.mjs");
    return linkedReleaseBackMergeSources(releaseBackMergeStopContext(payload, options), options).length > 0;
  } catch {
    process.stderr.write(`hook ${eventName} ${scriptBasename}: cross-repository obligations could not be inspected\n`);
    return false;
  }
}

if (shouldNoOp(scriptBasename, resolvedLevel, { hasCrossRepoObligation: await hasCrossRepoStopObligation() })) {
  process.exit(0);
}
const shouldPipeInput = shouldForwardInput(eventName, scriptBasename);
const hookTimeoutMs = resolveHookTimeoutMs();

const spawnOptions = {
  encoding: "utf8",
  killSignal: "SIGKILL",
  timeout: hookTimeoutMs,
  env: hookEnv,
};

if (shouldPipeInput) {
  spawnOptions.input = input;
}

const result = spawnSync(process.execPath, [resolvedScriptPath], spawnOptions);

if (result.error?.code === "ETIMEDOUT") {
  denyGithubFailure("hook timed out");
  // All host profiles fail open on a launcher timeout: the timed-out child's
  // stdout is discarded, so the run passes; explicit block decisions from
  // children that finish still block (fix-codex-reviewer-intent-candidate-cap D17).
  process.stderr.write(`hook ${eventName} ${resolvedScriptPath} timed out after ${hookTimeoutMs}ms; fail-open\n`);
  process.exit(0);
}

if (result.error) {
  denyGithubFailure("hook process failed");
  fail(`hook ${eventName} ${resolvedScriptPath} spawn failed: ${result.error.message}`);
}

if (githubWrite && (result.signal || result.status !== 0)) denyGithubFailure("hook exited abnormally");
if (githubWrite && result.stdout?.trim()) {
  try {
    const decision = JSON.parse(result.stdout.trim());
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) denyGithubFailure("invalid hook decision");
  } catch { denyGithubFailure("invalid hook decision"); }
}
write(process.stdout, result.stdout);
write(process.stderr, result.stderr);

// A Stop gate that blocks prints {"decision":"block",...} and exits 2. Measured on real host
// binaries: one host does not continue the turn for exit 2 or exit 1 with only a stdout JSON,
// while exit 0 with the same JSON continues on every measured host. Re-exiting 0 here makes
// the block take effect everywhere; any other failure keeps exiting 1.
function isStopBlockDecision(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim());
    return Boolean(parsed) && typeof parsed === "object" && parsed.decision === "block";
  } catch {
    return false;
  }
}

if (result.status === 2 && normalizeEventName(eventName) === "Stop" && isStopBlockDecision(result.stdout)) {
  process.exit(0);
}

if (result.status && result.status !== 0) {
  const stderr = (result.stderr || "").trim();
  const detail = stderr ? `; stderr: ${stderr}` : "";
  fail(`hook ${eventName} ${resolvedScriptPath} failed with exit ${result.status}${detail}`);
}

process.exit(0);
