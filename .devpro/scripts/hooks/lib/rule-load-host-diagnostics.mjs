import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defaultRepoStateDir, resolveMainCheckoutRoot } from "./repo-state-identity.mjs";
import { sha256Hex } from "../../lib/primitives.mjs";
import {
  extractRuleLeafReadsFromBash,
  extractRuleLeafReadsFromPayload,
  payloadAgentId,
  readToolFilePath,
  RULE_LOAD_LEDGER_STATE_PREFIX,
  SCOPED_SUFFIX_DELIMITER,
  sessionRuleLoadIdentity,
  sessionRuleLoadLedgerStateFile,
  subagentRuleLoadSuffix,
} from "./rule-load-session-ledger.mjs";

const MAX_REASON_BYTES = 120;

// Historically this returned "unknown" for an empty session identity
// (distinct from rule-load-session-ledger.mjs's safeSessionStateSuffix,
// which returns "" for empty — the ledger's "" means "use the unscoped
// base filename" while this diagnostic path always wants a visible
// placeholder segment). Kept as-is for the sessionIdentity call site;
// subagent-suffix dispatch below reuses the ledger's own suffix semantics
// via subagentRuleLoadSuffix so both families agree on subagent scoping.
function safeSuffix(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 80);
  if (safe && safe.length === raw.length && safe.length <= 80) return safe;
  return sha256Hex(raw).slice(0, 16);
}

// Decision-label classification for the subagent-scope dispatch (diagnostic
// visibility only — no id content, only which signal drove the decision).
// Mirrors rule-load-session-ledger.mjs's subagentRuleLoadSuffix branching so
// the label always matches the actual filename suffix applied.
function subagentDispatchDecision(payload = {}) {
  const suffix = subagentRuleLoadSuffix(payload);
  if (!suffix) return { subagentScoped: false, subagentSuffixSource: "main" };

  const agentId = payloadAgentId(payload);
  if (agentId) return { subagentScoped: true, subagentSuffixSource: "claude-agent-id" };

  const hasCodexThreadEnv = Object.prototype.hasOwnProperty.call(
    process.env,
    "CODEX_THREAD_ID"
  );
  if (hasCodexThreadEnv && String(process.env.CODEX_THREAD_ID || "").trim()) {
    return { subagentScoped: true, subagentSuffixSource: "codex-thread-id" };
  }
  return { subagentScoped: true, subagentSuffixSource: "fallback" };
}

function commandFields(payload = {}) {
  const toolInput = payload.tool_input || payload.toolInput || {};
  return {
    command: typeof toolInput.command === "string" ? toolInput.command : "",
    cmd: typeof toolInput.cmd === "string" ? toolInput.cmd : "",
  };
}

function commandText(payload = {}) {
  const fields = commandFields(payload);
  return fields.command || fields.cmd || "";
}

function filePathFields(payload = {}) {
  const toolInput = payload.tool_input || payload.toolInput || {};
  const filePath = readToolFilePath(payload);
  return {
    hasFilePath: typeof toolInput.file_path === "string" && Boolean(toolInput.file_path.trim()),
    hasFilePathCamel: typeof toolInput.filePath === "string" && Boolean(toolInput.filePath.trim()),
    hasPath: typeof toolInput.path === "string" && Boolean(toolInput.path.trim()),
    filePathBytes: Buffer.byteLength(filePath || "", "utf8"),
  };
}

// Presence-only metadata for the two subagent detection signals (per FR4:
// no id content, only whether the signal was present — the actual decision
// is in subagentDispatchDecision's subagentScoped/subagentSuffixSource).
function subagentSignalFields(payload = {}) {
  const agentId = payloadAgentId(payload);
  const hasCodexThreadEnv = Object.prototype.hasOwnProperty.call(
    process.env,
    "CODEX_THREAD_ID"
  );
  return {
    hasAgentId: Boolean(agentId),
    hasCodexThreadIdEnv: hasCodexThreadEnv,
    codexThreadIdEnvEmpty: hasCodexThreadEnv && !String(process.env.CODEX_THREAD_ID || "").trim(),
  };
}

// Top-level payload keys that carry rule content or command output — these
// are the ONLY exclusions from the full-payload diagnostic record. Everything
// else (identity fields like agent_id/agent_type/session_id, cwd, tool name,
// etc.) is preserved verbatim so a later debug session can reverse-trace
// "which agent produced this" — the concrete gap the presence-only fields
// (subagentFields.hasAgentId etc., kept below unmodified) cannot answer.
const TOP_LEVEL_OUTPUT_KEYS = new Set([
  "tool_response",
  "toolResponse",
  "tool_output",
  "toolOutput",
  "output",
  "stdout",
  "stderr",
]);

// tool_input (and its camelCase alias) sub-keys that carry the literal
// command string or file content — excluded; everything else in tool_input
// (file_path, cwd, workdir, path, ...) is preserved verbatim.
const TOOL_INPUT_CONTENT_KEYS = new Set(["command", "cmd", "content"]);

/**
 * Deep-clones payload and strips only rule-content/command-output-bearing
 * fields, preserving every other field (including identity values) as-is.
 * Fail-open: any structured-clone failure (e.g. non-serializable payload)
 * falls back to {} rather than throwing, since this is diagnostic-only
 * telemetry and must never block the caller.
 */
function sanitizePayloadForDiagnostic(payload = {}) {
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(payload));
  } catch {
    return {};
  }
  if (!clone || typeof clone !== "object") return {};

  for (const key of TOP_LEVEL_OUTPUT_KEYS) {
    delete clone[key];
  }

  for (const toolInputKey of ["tool_input", "toolInput"]) {
    const toolInput = clone[toolInputKey];
    if (toolInput && typeof toolInput === "object") {
      for (const key of TOOL_INPUT_CONTENT_KEYS) {
        delete toolInput[key];
      }
    }
  }

  // Nested hook_input/hookInput mirrors (Codex/Claude payload shapes carry
  // duplicated tool_input under these) get the same content/output strip.
  for (const hookInputKey of ["hook_input", "hookInput"]) {
    const hookInput = clone[hookInputKey];
    if (hookInput && typeof hookInput === "object") {
      for (const key of TOP_LEVEL_OUTPUT_KEYS) {
        delete hookInput[key];
      }
      for (const toolInputKey of ["tool_input", "toolInput"]) {
        const toolInput = hookInput[toolInputKey];
        if (toolInput && typeof toolInput === "object") {
          for (const key of TOOL_INPUT_CONTENT_KEYS) {
            delete toolInput[key];
          }
        }
      }
    }
  }

  return clone;
}

function hasRulePath(value) {
  return /\.devpro[\\/]+agent-rules[\\/]+[^"'`\r\n<>|]*?\.md(?=$|[\s"'`<>|;,)}\]])/i.test(String(value || ""));
}

function isCandidateRuleReadPayload(payload = {}) {
  const command = commandText(payload);
  if (hasRulePath(command)) return true;
  const filePath = readToolFilePath(payload);
  if (hasRulePath(filePath)) return true;
  try {
    return hasRulePath(JSON.stringify(payload));
  } catch {
    return false;
  }
}

function stateDir(cwd) {
  return process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR ||
    defaultRepoStateDir(RULE_LOAD_LEDGER_STATE_PREFIX, cwd);
}

function diagnosticPath(cwd, sessionIdentity, payload = {}) {
  const suffix = safeSuffix(sessionIdentity);
  const subagentSuffix = subagentRuleLoadSuffix(payload);
  // Same structural delimiter as the ledger family (SCOPED_SUFFIX_DELIMITER,
  // "~sub~") so both file families can be disambiguated base-vs-scoped by
  // the same sweep logic (session-start.mjs) with zero UUID/base false
  // positives. See rule-load-session-ledger.mjs's SCOPED_SUFFIX_DELIMITER
  // doc comment for why a plain "-" join is unsound here.
  const base = subagentSuffix ? `${suffix}${SCOPED_SUFFIX_DELIMITER}${subagentSuffix}` : suffix;
  return path.join(stateDir(cwd), `rule-load-host-diagnostic-${base}.jsonl`);
}

function truncate(value, maxBytes = MAX_REASON_BYTES) {
  const raw = String(value || "");
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw;
  return `${raw.slice(0, maxBytes)}...`;
}

export function buildRuleLoadHostDiagnostic(payload = {}, {
  repoRoot = process.cwd(),
  source = "host-diag",
  refs,
  recordCount,
  duplicateCount,
  skippedReason = "",
} = {}) {
  const toolInput = payload.tool_input || payload.toolInput || {};
  const fields = commandFields(payload);
  const command = fields.command || fields.cmd;
  const sessionIdentity = sessionRuleLoadIdentity(payload);
  const extractedRefs =
    refs ||
    extractRuleLeafReadsFromPayload(payload, repoRoot) ||
    [];
  const diagnosticRefs = extractedRefs.length > 0
    ? extractedRefs
    : command
      ? extractRuleLeafReadsFromBash(command, repoRoot)
      : [];
  const fileFields = filePathFields(payload);
  const candidate = isCandidateRuleReadPayload(payload) || diagnosticRefs.length > 0;
  const reason = skippedReason || (
    !candidate ? "not-candidate" :
      !command && fileFields.filePathBytes === 0 ? "missing-read-input" :
        !sessionIdentity ? "missing-session-identity" :
          diagnosticRefs.length === 0 ? "no-rule-refs" :
            "candidate-rule-read"
  );
  let identitySource = "unknown";
  try {
    identitySource = resolveMainCheckoutRoot(repoRoot).identitySource;
  } catch {
    identitySource = "unknown";
  }
  return {
    version: 1,
    at: new Date().toISOString(),
    source,
    identitySource,
    event: process.env.DEVPRO_HOOK_EVENT || "",
    host: process.env.DEVPRO_HOOK_HOST || "",
    toolName: payload.tool_name || payload.toolName || "",
    commandFields: {
      hasCommand: Boolean(fields.command),
      hasCmd: Boolean(fields.cmd),
      commandBytes: Buffer.byteLength(command || "", "utf8"),
    },
    filePathFields: fileFields,
    cwdFields: {
      hasToolCwd: typeof toolInput.cwd === "string" && Boolean(toolInput.cwd.trim()),
      hasToolWorkdir: typeof toolInput.workdir === "string" && Boolean(toolInput.workdir.trim()),
      hasTopCwd: typeof payload.cwd === "string" && Boolean(payload.cwd.trim()),
      hasTopWorkdir: typeof payload.workdir === "string" && Boolean(payload.workdir.trim()),
    },
    session: {
      hasIdentity: Boolean(sessionIdentity),
      stateFile: sessionIdentity
        ? sessionRuleLoadLedgerStateFile(repoRoot, { sessionIdentity, payload })
        : "",
      ...subagentDispatchDecision(payload),
      subagentFields: subagentSignalFields(payload),
    },
    candidate,
    reason: truncate(reason),
    refs: diagnosticRefs.map((ref) => ({
      relPath: ref.relPath,
      coverage: ref.coverage,
      commandKind: ref.commandKind,
    })),
    recordCount: Number.isInteger(recordCount) ? recordCount : undefined,
    duplicateCount: Number.isInteger(duplicateCount) ? duplicateCount : undefined,
    // Full hook payload, deep-cloned with only rule-content/command-output
    // fields removed (see sanitizePayloadForDiagnostic). Additive to — not a
    // replacement for — the flattened presence-only fields above: identity
    // values (agent_id, agent_type, session_id, ...) are preserved verbatim
    // here so a later debug session can reverse-trace "which agent" without
    // needing to have anticipated every field in advance as its own
    // existence-flag. no-leak contract still holds: only content/output is
    // excluded, never identity/metadata.
    payload: sanitizePayloadForDiagnostic(payload),
  };
}

export function appendRuleLoadHostDiagnostic(payload = {}, options = {}) {
  try {
    const repoRoot = options.repoRoot || process.cwd();
    const entry = buildRuleLoadHostDiagnostic(payload, { ...options, repoRoot });
    if (!entry.candidate) return false;
    const sessionIdentity = sessionRuleLoadIdentity(payload);
    const logPath = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE ||
      diagnosticPath(repoRoot, sessionIdentity, payload);
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
