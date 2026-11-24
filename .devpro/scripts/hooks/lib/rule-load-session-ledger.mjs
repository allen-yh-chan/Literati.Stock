import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";
import { sha256Hex } from "../../lib/primitives.mjs";

export const RULE_LOAD_BYTES_PER_TOKEN = 3.5;
export const RULE_LOAD_LEDGER_STATE_PREFIX = "devpro-rule-load-ledger-state";

// Structural (not textual-guess) base-vs-scoped filename discriminator.
// `safeSessionStateSuffix`'s sanitize alphabet is exactly [A-Za-z0-9_.-]
// (either directly, via the character-replace branch, or via the sha256-hex
// fallback branch, which only ever emits [0-9a-f]). "~" is outside that
// alphabet in both branches, so it can PROVABLY never appear inside a
// sanitized base id or a sanitized subagent suffix — unlike a plain "-" or
// "." separator, which base ids (e.g. UUIDs, which are mostly "-") can and
// routinely do contain, making textual-substring disambiguation unsound.
// This makes `<baseSuffix>${SCOPED_SUFFIX_DELIMITER}<subagentSuffix>` the
// ONLY place `~` can occur in these filenames, so any sweep/parser can
// split on it with zero false positives against real (including
// hyphen-heavy UUID) session ids. See fix-duplicate-rule-load-ledger-
// subagent-scope: T5 UUID-base-survives regression.
export const SCOPED_SUFFIX_DELIMITER = "~sub~";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fallbackRepoRoot = path.resolve(scriptDir, "../../../..");
const READ_COMMANDS = new Set(["cat", "sed", "nl", "head", "tail", "less"]);
const FULL_READ_COMMANDS = new Set(["cat", "nl"]);
const VALID_COVERAGE = new Set(["full", "range", "partial", "unknown"]);
const MAX_AUDIT_ENTRIES = 30;
const READ_TOOL_NAMES = new Set(["Read"]);
const SHELL_COMMAND_TOOL_NAMES = new Set([
  "Bash",
  "bash",
  "Shell",
  "shell",
  "functions.exec_command",
]);

export function estimateRuleLoadTokens(bytes) {
  return Math.ceil(bytes / RULE_LOAD_BYTES_PER_TOKEN);
}

export function isShellCommandToolName(value) {
  return SHELL_COMMAND_TOOL_NAMES.has(String(value || "").trim());
}

export function isReadToolName(value) {
  return READ_TOOL_NAMES.has(String(value || "").trim());
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function safeSessionStateSuffix(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 80);
  if (safe && safe.length === raw.length && safe.length <= 80) return safe;
  return sha256Hex(raw).slice(0, 16);
}

export function sessionRuleLoadIdentity(payload = {}) {
  // Keep this list to stable conversation/session ids. File paths such as
  // transcript_path can differ across hook events and split one runtime session
  // into multiple ledger files.
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
    payload.thread_id,
    payload.threadId,
    payload.hook_input?.session_id,
    payload.hook_input?.sessionId,
    payload.hook_input?.conversation_id,
    payload.hook_input?.conversationId,
    payload.hookInput?.session_id,
    payload.hookInput?.sessionId,
    payload.hookInput?.conversation_id,
    payload.hookInput?.conversationId,
  ];
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

export function payloadAgentId(payload = {}) {
  const candidates = [
    payload.agent_id,
    payload.agentId,
    payload.hook_input?.agent_id,
    payload.hook_input?.agentId,
    payload.hookInput?.agent_id,
    payload.hookInput?.agentId,
  ];
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

// Q1-decided dispatch direction: only a *confirmed* main payload gets the
// base (no-suffix) ledger/diagnostic filename; everything else — subagent
// signal OR ambiguous signal — gets a scoped filename. This is deliberately
// asymmetric with the historically-safer default (main) because the hard
// constraint here is "subagent reads must never collide with the main
// ledger", not "minimize scoped-file churn" (see
// fix-duplicate-rule-load-ledger-subagent-scope proposal.md Q1).
//
// Returns "" iff confirmed main:
//   (no payload agent_id) AND (no CODEX_THREAD_ID env, OR CODEX_THREAD_ID === sessionRuleLoadIdentity(payload))
// Otherwise returns a sanitized scoped suffix token:
//   - Claude subagent (payload agent_id present) → suffix derived from agent_id
//   - Codex subagent (CODEX_THREAD_ID present and != session identity) → suffix derived from CODEX_THREAD_ID
//   - Ambiguous (CODEX_THREAD_ID env present but empty/unusable and not
//     confirmable as main by any other signal) → scoped fallback token
export function subagentRuleLoadSuffix(payload = {}) {
  const agentId = payloadAgentId(payload);
  if (agentId) return safeSessionStateSuffix(agentId);

  const hasCodexThreadEnv = Object.prototype.hasOwnProperty.call(
    process.env,
    "CODEX_THREAD_ID"
  );
  if (!hasCodexThreadEnv) return "";

  const codexThreadId = String(process.env.CODEX_THREAD_ID || "").trim();
  const sessionIdentity = sessionRuleLoadIdentity(payload);
  if (codexThreadId && codexThreadId === sessionIdentity) return "";
  if (codexThreadId) return safeSessionStateSuffix(codexThreadId);

  // CODEX_THREAD_ID env present but empty/unusable: a runtime signal exists
  // but main cannot be confirmed from it. Per Q1, default to scoped rather
  // than risk colliding with the main ledger.
  return safeSessionStateSuffix("codex-thread-id-unresolved");
}

export function sessionRuleLoadLedgerStateFile(cwd = process.cwd(), {
  sessionIdentity = "",
  payload,
} = {}) {
  if (process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE) {
    return process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE;
  }
  const dir =
    process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR ||
    defaultRepoStateDir(RULE_LOAD_LEDGER_STATE_PREFIX, cwd);
  const identity = sessionIdentity || (payload ? sessionRuleLoadIdentity(payload) : "");
  const suffix = safeSessionStateSuffix(identity);
  const subagentSuffix = payload ? subagentRuleLoadSuffix(payload) : "";
  if (suffix && subagentSuffix) {
    return path.join(
      dir,
      `rule-load-session-ledger-${suffix}${SCOPED_SUFFIX_DELIMITER}${subagentSuffix}.json`
    );
  }
  if (suffix) return path.join(dir, `rule-load-session-ledger-${suffix}.json`);
  return path.join(dir, "rule-load-session-ledger.json");
}

// Parses a rule-load-ledger or rule-load-host-diagnostic filename's id
// segment (the part between the family prefix and file extension) into its
// base and (optional) subagent components, using the structurally-unique
// SCOPED_SUFFIX_DELIMITER. Returns { baseId, subagentSuffix } where
// subagentSuffix is "" for an unscoped (base) filename. Since "~" can never
// appear in a sanitized id/suffix outside of this delimiter, a single split
// on the first occurrence is unambiguous.
export function parseScopedRuleLoadIdSegment(idSegment) {
  const value = String(idSegment || "");
  const at = value.indexOf(SCOPED_SUFFIX_DELIMITER);
  if (at === -1) return { baseId: value, subagentSuffix: "" };
  return {
    baseId: value.slice(0, at),
    subagentSuffix: value.slice(at + SCOPED_SUFFIX_DELIMITER.length),
  };
}

function explicitSessionLedgerStateFile(stateFile, operation) {
  const value = String(stateFile || "").trim();
  if (!value) {
    throw new Error(`${operation} requires an explicit session ledger stateFile`);
  }
  return value;
}

export function normalizeRuleLeafRef(ref, repoRoot = fallbackRepoRoot) {
  if (!ref || typeof ref !== "string") return null;
  let value = ref.trim().replace(/^['"]|['"]$/g, "");
  if (!value.endsWith(".md")) return null;
  value = value.replace(/^\.\//, "");

  const ruleRoot = path.join(repoRoot, ".devpro", "agent-rules");
  if (path.isAbsolute(value)) {
    const rel = slash(path.relative(ruleRoot, value));
    if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
    return rel;
  }

  if (value.startsWith(".devpro/agent-rules/")) {
    return value.slice(".devpro/agent-rules/".length);
  }

  if (value.includes("..")) return null;
  const full = path.join(ruleRoot, value);
  if (existsSync(full)) return slash(value);
  return null;
}

function readState(stateFile) {
  try {
    return normalizeState(JSON.parse(readFileSync(stateFile, "utf8")));
  } catch {
    return normalizeState({});
  }
}

function writeState(stateFile, state) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
}

function normalizeState(state) {
  const normalized = state && typeof state === "object" ? state : {};
  normalized.version = 3;
  normalized.contextEpoch = Number.isInteger(normalized.contextEpoch)
    ? normalized.contextEpoch
    : 0;
  const lifecycle = normalized.lifecycle || normalized.lifecycleState;
  normalized.lifecycle = lifecycle === "reliable" ? "reliable" : "unknown";
  delete normalized.lifecycleState;
  normalized.files = normalized.files && typeof normalized.files === "object"
    ? normalized.files
    : {};
  normalized.audit = Array.isArray(normalized.audit) ? normalized.audit.slice(-MAX_AUDIT_ENTRIES) : [];
  return normalized;
}

function hashFile(fullPath) {
  return sha256Hex(readFileSync(fullPath));
}

function buildRuleLoadRecord(relPath, repoRoot) {
  const fullPath = path.join(repoRoot, ".devpro", "agent-rules", relPath);
  const stat = statSync(fullPath);
  const bytes = stat.size;
  return {
    relPath,
    bytes,
    tokens: estimateRuleLoadTokens(bytes),
    hash: hashFile(fullPath),
  };
}

function normalizeRuleLoadInput(input) {
  if (typeof input === "string") {
    return {
      ref: input,
      coverage: "full",
      coverageKey: "full",
      commandKind: "manual",
    };
  }
  if (!input || typeof input !== "object") return null;
  const coverage = VALID_COVERAGE.has(input.coverage) ? input.coverage : "unknown";
  const ref = input.ref || input.relPath || input.path;
  if (!ref) return null;
  return {
    ref,
    coverage,
    coverageKey: input.coverageKey || coverage,
    commandKind: input.commandKind || input.sourceCommandKind || "unknown",
  };
}

function loadSlot(load) {
  if (load.coverage === "full") return "full";
  return `${load.coverage}:${load.coverageKey || load.commandKind || "unknown"}`;
}

function legacyLoadForEntry(entry, contextEpoch) {
  if (!entry?.hash) return null;
  const coverage = VALID_COVERAGE.has(entry.coverage) ? entry.coverage : "unknown";
  return {
    relPath: entry.relPath,
    bytes: entry.bytes,
    tokens: entry.tokens,
    hash: entry.hash,
    coverage,
    coverageKey: entry.coverageKey || coverage,
    commandKind: entry.commandKind || "legacy",
    contextEpoch: Number.isInteger(entry.contextEpoch) ? entry.contextEpoch : contextEpoch,
    firstReadAt: entry.firstReadAt,
    lastReadAt: entry.lastReadAt,
    readCount: entry.readCount || 1,
  };
}

function existingLoadsForEntry(entry, contextEpoch) {
  const loads = entry?.loads && typeof entry.loads === "object" ? { ...entry.loads } : {};
  if (Object.keys(loads).length === 0) {
    const legacy = legacyLoadForEntry(entry, contextEpoch);
    if (legacy) loads[loadSlot(legacy)] = legacy;
  }
  return loads;
}

function evaluateSessionRuleLoads(refs, {
  repoRoot = fallbackRepoRoot,
  stateFile,
  sessionIdentity = "",
  payload,
  now = new Date().toISOString(),
  write = true,
} = {}) {
  const identity = sessionIdentity || (payload ? sessionRuleLoadIdentity(payload) : "");
  if (write && !stateFile && !identity) {
    throw new Error("session ledger target required: pass sessionIdentity/payload or stateFile");
  }
  const effectiveStateFile =
    stateFile || sessionRuleLoadLedgerStateFile(repoRoot, { sessionIdentity: identity, payload });
  const state = readState(effectiveStateFile);
  state.files ||= {};

  const normalizedLoads = [];
  const seen = new Set();
  for (const load of refs.map(normalizeRuleLoadInput).filter(Boolean)) {
    const relPath = normalizeRuleLeafRef(load.ref, repoRoot);
    if (!relPath) continue;
    const normalized = { ...load, relPath };
    const key = `${relPath}\0${loadSlot(normalized)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedLoads.push(normalized);
  }

  const normalizedRefs = [...new Set(
    refs
      .map((ref) => normalizeRuleLoadInput(ref)?.ref)
      .map((ref) => normalizeRuleLeafRef(ref, repoRoot))
      .filter(Boolean)
  )];
  const records = [];
  const duplicates = [];

  for (const load of normalizedLoads) {
    const relPath = load.relPath;
    let record;
    try {
      record = buildRuleLoadRecord(relPath, repoRoot);
    } catch {
      continue;
    }

    const previous = state.files[relPath];
    const previousLoads = previous?.hash === record.hash
      ? existingLoadsForEntry(previous, state.contextEpoch)
      : {};
    const slot = loadSlot(load);
    const previousLoad = previousLoads[slot];
    const duplicate =
      previousLoad?.hash === record.hash &&
      previousLoad?.contextEpoch === state.contextEpoch;
    const readCount = duplicate ? (previousLoad.readCount || 1) + 1 : 1;
    const entry = {
      ...record,
      coverage: load.coverage,
      coverageKey: load.coverageKey,
      commandKind: load.commandKind,
      contextEpoch: state.contextEpoch,
      firstReadAt: duplicate ? previousLoad.firstReadAt : now,
      lastReadAt: now,
      readCount,
    };
    previousLoads[slot] = entry;
    if (write) {
      state.files[relPath] = {
        ...record,
        coverage: entry.coverage,
        coverageKey: entry.coverageKey,
        commandKind: entry.commandKind,
        contextEpoch: entry.contextEpoch,
        firstReadAt: entry.firstReadAt,
        lastReadAt: entry.lastReadAt,
        readCount: entry.readCount,
        loads: previousLoads,
      };
    }
    records.push(entry);
    if (duplicate) duplicates.push(entry);
  }

  if (write) writeState(effectiveStateFile, state);

  const duplicateBytes = duplicates.reduce((sum, item) => sum + item.bytes, 0);
  const duplicateTokens = duplicates.reduce((sum, item) => sum + item.tokens, 0);
  return {
    stateFile: effectiveStateFile,
    contextEpoch: state.contextEpoch,
    lifecycle: state.lifecycle,
    refs: normalizedRefs,
    records,
    duplicates,
    duplicateBytes,
    duplicateTokens,
  };
}

export function inspectSessionRuleLoadDuplicates(refs, options = {}) {
  return evaluateSessionRuleLoads(refs, { ...options, write: false });
}

export function recordSessionRuleLoads(refs, options = {}) {
  return evaluateSessionRuleLoads(refs, { ...options, write: true });
}

export function resetSessionRuleLoadLedger({
  stateFile,
  reason = "",
  actor = "unknown",
  source = "manual",
  now = new Date().toISOString(),
  requireReason = false,
} = {}) {
  const effectiveStateFile = explicitSessionLedgerStateFile(stateFile, "resetSessionRuleLoadLedger");
  const trimmedReason = String(reason || "").trim();
  if (requireReason && trimmedReason.length < 3) {
    throw new Error("--reason is required for manual session rule-load ledger reset");
  }
  const state = readState(effectiveStateFile);
  const entryCount = Object.keys(state.files || {}).length;
  const previousEpoch = state.contextEpoch;
  const nextState = normalizeState({
    ...state,
    contextEpoch: previousEpoch + 1,
    lifecycle: "reliable",
    files: {},
    audit: [
      ...(state.audit || []),
      {
        type: "reset",
        source,
        actor,
        reason: trimmedReason || source,
        at: now,
        previousEpoch,
        contextEpoch: previousEpoch + 1,
        entryCount,
      },
    ],
  });
  writeState(effectiveStateFile, nextState);
  return {
    stateFile: effectiveStateFile,
    reset: true,
    entryCount,
    previousEpoch,
    contextEpoch: nextState.contextEpoch,
    lifecycle: nextState.lifecycle,
  };
}

export function advanceSessionRuleLoadLedgerEpoch({
  stateFile,
  reason = "compact",
  source = "compact",
  actor = "runtime",
  now = new Date().toISOString(),
} = {}) {
  const effectiveStateFile = explicitSessionLedgerStateFile(stateFile, "advanceSessionRuleLoadLedgerEpoch");
  const state = readState(effectiveStateFile);
  const previousEpoch = state.contextEpoch;
  state.contextEpoch = previousEpoch + 1;
  state.lifecycle = "reliable";
  state.audit = [
    ...(state.audit || []),
    {
      type: "epoch",
      source,
      actor,
      reason,
      at: now,
      previousEpoch,
      contextEpoch: state.contextEpoch,
      entryCount: Object.keys(state.files || {}).length,
    },
  ].slice(-MAX_AUDIT_ENTRIES);
  writeState(effectiveStateFile, state);
  return {
    stateFile: effectiveStateFile,
    previousEpoch,
    contextEpoch: state.contextEpoch,
    lifecycle: state.lifecycle,
  };
}

export function markSessionRuleLoadLedgerUnknown({
  stateFile,
  reason = "missing lifecycle source",
  source = "unknown",
  actor = "runtime",
  now = new Date().toISOString(),
} = {}) {
  const effectiveStateFile = explicitSessionLedgerStateFile(stateFile, "markSessionRuleLoadLedgerUnknown");
  const state = readState(effectiveStateFile);
  state.lifecycle = "unknown";
  state.audit = [
    ...(state.audit || []),
    {
      type: "unknown",
      source,
      actor,
      reason,
      at: now,
      contextEpoch: state.contextEpoch,
      entryCount: Object.keys(state.files || {}).length,
    },
  ].slice(-MAX_AUDIT_ENTRIES);
  writeState(effectiveStateFile, state);
  return {
    stateFile: effectiveStateFile,
    contextEpoch: state.contextEpoch,
    lifecycle: state.lifecycle,
  };
}

export function sessionStartSource(payload = {}) {
  const candidates = [
    payload.source,
    payload.session_start_source,
    payload.sessionStartSource,
    payload.matcher,
    payload.hook_input?.source,
    payload.hookInput?.source,
  ];
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function sessionStartIdentity(payload = {}) {
  return sessionRuleLoadIdentity(payload);
}

export function applySessionStartRuleLoadLedger(payload = {}, {
  stateFile,
  now = new Date().toISOString(),
} = {}) {
  const source = sessionStartSource(payload);
  const sessionIdentity = sessionStartIdentity(payload);
  const effectiveStateFile = stateFile || (
    sessionIdentity
      ? sessionRuleLoadLedgerStateFile(process.cwd(), { sessionIdentity })
      : ""
  );
  if (!source || !sessionIdentity) {
    const reason = source
      ? "SessionStart session identity missing"
      : "SessionStart source missing or unsupported";
    if (!effectiveStateFile) {
      return {
        source,
        action: "unknown",
        stateFile: "",
        contextEpoch: 0,
        lifecycle: "unknown",
        skipped: true,
        reason,
      };
    }
    return {
      source,
      action: "unknown",
      ...markSessionRuleLoadLedgerUnknown({
        stateFile: effectiveStateFile,
        reason,
        source: source || "unknown",
        actor: "runtime",
        now,
      }),
    };
  }
  if (source === "clear") {
    return {
      source,
      action: "reset",
      ...resetSessionRuleLoadLedger({
        stateFile: effectiveStateFile,
        reason: "SessionStart clear",
        source,
        actor: "runtime",
        now,
      }),
    };
  }
  if (source === "startup") {
    return {
      source,
      action: "reset",
      ...resetSessionRuleLoadLedger({
        stateFile: effectiveStateFile,
        reason: "SessionStart startup",
        source,
        actor: "runtime",
        now,
      }),
    };
  }
  if (source === "compact") {
    return {
      source,
      action: "epoch",
      ...advanceSessionRuleLoadLedgerEpoch({
        stateFile: effectiveStateFile,
        reason: "SessionStart compact",
        source,
        actor: "runtime",
        now,
      }),
    };
  }
  if (source === "resume") {
    const state = readState(effectiveStateFile);
    const lifecycle = state.lifecycle === "reliable" ? "reliable" : "unknown";
    state.lifecycle = lifecycle;
    state.audit = [
      ...(state.audit || []),
      {
        type: "preserve",
        source,
        actor: "runtime",
        reason: "SessionStart resume",
        at: now,
        contextEpoch: state.contextEpoch,
        lifecycle,
        entryCount: Object.keys(state.files || {}).length,
      },
    ].slice(-MAX_AUDIT_ENTRIES);
    writeState(effectiveStateFile, state);
    return {
      source,
      action: "preserve",
      stateFile: effectiveStateFile,
      contextEpoch: state.contextEpoch,
      lifecycle: state.lifecycle,
    };
  }
  return {
    source,
    action: "unknown",
    ...markSessionRuleLoadLedgerUnknown({
      stateFile: effectiveStateFile,
      reason: "SessionStart source missing or unsupported",
      source: source || "unknown",
      actor: "runtime",
      now,
    }),
  };
}

function tokenizeShellish(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function stripCommandDecorations(token) {
  return token.replace(/^command\s+/, "").replace(/^builtin\s+/, "");
}

function ruleReadCoverage(commandName, commandArgs) {
  if (FULL_READ_COMMANDS.has(commandName)) return "full";
  if (commandName === "tail") {
    if (commandArgs.includes("+1")) return "full";
    if (commandArgs.some((arg) => arg === "-n+1" || arg === "-n" || arg === "--lines=+1")) {
      const index = commandArgs.findIndex((arg) => arg === "-n");
      if (index === -1 || commandArgs[index + 1] === "+1") return "full";
    }
  }
  if (commandName === "sed" && commandArgs.includes("-n")) {
    if (commandArgs.some((arg) => arg === "1,$p" || arg === "1,${p}" || arg === "1,$ p")) {
      return "full";
    }
  }
  return "partial";
}

function dedupeRuleLeafReads(refs) {
  const seen = new Set();
  return refs.filter((item) => {
    const key = `${item.relPath}\0${item.coverage}\0${item.coverageKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasUnquotedShellRedirect(command) {
  let quote = "";
  let escaped = false;
  for (const char of String(command || "")) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ">") return true;
  }
  return false;
}

export function extractRuleLeafReadsFromBash(command, repoRoot = fallbackRepoRoot) {
  if (hasUnquotedShellRedirect(command)) return [];
  if (command.includes("|")) return [];
  const tokens = tokenizeShellish(command);
  const refs = [];
  let currentCommand = "";
  let commandArgs = [];
  let atCommandStart = true;

  for (const rawToken of tokens) {
    const token = stripCommandDecorations(rawToken);
    if (/^(;|&&|\|\||\|)$/.test(token)) {
      currentCommand = "";
      commandArgs = [];
      atCommandStart = true;
      continue;
    }
    if (atCommandStart) {
      if (token === "command" || token === "builtin" || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
        continue;
      }
      const commandName = path.basename(token);
      if (READ_COMMANDS.has(commandName)) {
        currentCommand = commandName;
        commandArgs = [];
        atCommandStart = false;
        continue;
      }
      currentCommand = "";
      commandArgs = [];
      atCommandStart = false;
      continue;
    }
    if (!currentCommand) continue;
    const relPath = normalizeRuleLeafRef(token, repoRoot);
    if (relPath) {
      const coverage = ruleReadCoverage(currentCommand, commandArgs);
      refs.push({
        ref: relPath,
        relPath,
        coverage,
        coverageKey: coverage === "full" ? "full" : `${currentCommand}:${commandArgs.join(" ") || "partial"}`,
        commandKind: currentCommand,
      });
      continue;
    }
    commandArgs.push(token);
  }

  return dedupeRuleLeafReads(refs);
}

export function readToolFilePath(payload = {}) {
  const toolInput = payload.tool_input || payload.toolInput || {};
  return [
    toolInput.file_path,
    toolInput.filePath,
    toolInput.path,
  ].map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) || "";
}

function readToolCoverage(toolInput = {}) {
  const offset = toolInput.offset ?? toolInput.start_line ?? toolInput.startLine;
  const limit = toolInput.limit ?? toolInput.end_line ?? toolInput.endLine;
  if (offset === undefined && limit === undefined) {
    return { coverage: "full", coverageKey: "full" };
  }
  const offsetText = offset === undefined ? "" : String(offset);
  const limitText = limit === undefined ? "" : String(limit);
  return {
    coverage: "partial",
    coverageKey: `Read:${offsetText}:${limitText}`,
  };
}

export function extractRuleLeafReadsFromReadTool(payload = {}, repoRoot = fallbackRepoRoot) {
  const toolInput = payload.tool_input || payload.toolInput || {};
  const filePath = readToolFilePath(payload);
  const relPath = normalizeRuleLeafRef(filePath, repoRoot);
  if (!relPath) return [];
  const coverage = readToolCoverage(toolInput);
  return [{
    ref: relPath,
    relPath,
    coverage: coverage.coverage,
    coverageKey: coverage.coverageKey,
    commandKind: "Read",
  }];
}

export function extractRuleLeafReadsFromPayload(payload = {}, repoRoot = fallbackRepoRoot) {
  const toolName = payload.tool_name || payload.toolName || "";
  const toolInput = payload.tool_input || payload.toolInput || {};
  if (isShellCommandToolName(toolName)) {
    const command = toolInput.command || toolInput.cmd || "";
    return command ? extractRuleLeafReadsFromBash(command, repoRoot) : [];
  }
  if (isReadToolName(toolName)) {
    return dedupeRuleLeafReads(extractRuleLeafReadsFromReadTool(payload, repoRoot));
  }
  return [];
}

export function formatDuplicateRuleLoadBlockReason(result) {
  if (result?.lifecycle !== "reliable") return "";
  const duplicates = (result.duplicates || []).filter((item) => item.coverage === "full");
  if (duplicates.length === 0) return "";
  const duplicateKeys = new Set(duplicates.map((item) => item.relPath));
  const newFullRefs = (result.records || [])
    .filter((item) => item.coverage === "full" && !duplicateKeys.has(item.relPath))
    .map((item) => item.relPath);
  const duplicateBytes = duplicates.reduce((sum, item) => sum + item.bytes, 0);
  const duplicateTokens = duplicates.reduce((sum, item) => sum + item.tokens, 0);
  const lines = [
    "Duplicate Rule Load Ledger：reliable lifecycle 內偵測到同 session 重複 full read，已阻止避免相同 rule leaf 再進 context。",
    "",
    ...duplicates.map(
      (item) => `- \`${item.relPath}\`: ${item.tokens} duplicate tokens est, coverage=${item.coverage}, epoch=${item.contextEpoch}`
    ),
    "",
    `Total duplicate bytes: ${duplicateBytes}; duplicate tokens est: ${duplicateTokens}.`,
    ...(newFullRefs.length > 0
      ? [
          "同一指令中還有尚未載入的 full read；請拆開重跑這些 leaf：",
          ...newFullRefs.map((relPath) => `- \`${relPath}\``),
          "",
        ]
      : []),
    "改用既有 context 或 file:line anchor；若 context 已 clear/compact 但 runtime 未送 lifecycle event，先執行 `node .devpro/scripts/rule-load-ledger.mjs --session-reset --reason \"<why>\" --session-id \"<id>\"` 或 `--state-file <path>`。",
  ];
  return lines.join("\n");
}
