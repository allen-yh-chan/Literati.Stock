import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applySessionStartRuleLoadLedger,
  extractRuleLeafReadsFromBash,
  extractRuleLeafReadsFromPayload,
  formatDuplicateRuleLoadBlockReason,
  inspectSessionRuleLoadDuplicates,
  isReadToolName,
  isShellCommandToolName,
  recordSessionRuleLoads,
  SCOPED_SUFFIX_DELIMITER,
  sessionRuleLoadIdentity,
  sessionRuleLoadLedgerStateFile,
} from "../hooks/lib/rule-load-session-ledger.mjs";
import { toolResponseStdout } from "../hooks/post-tool-gate.mjs";
import {
  checkDuplicateRuleLoadLedger,
  checkDuplicateRuleLoadLedgerPayload,
  recordRuleLoadLedgerState,
  recordRuleLoadLedgerPayload,
} from "../hooks/pre-tool-gate.mjs";
import { appendRuleLoadHostDiagnostic } from "../hooks/lib/rule-load-host-diagnostics.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const preToolHook = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const postToolHook = repoPath(".devpro/scripts/hooks/post-tool-gate.mjs");
const ruleLoadDiagHook = repoPath(".devpro/scripts/hooks/rule-load-ledger-host-diag.mjs");
const sessionStartHook = repoPath(".devpro/scripts/hooks/session-start.mjs");

function tempStateFile(prefix = "rule-load-hook-") {
  return path.join(mkdtempSync(path.join(tmpdir(), prefix)), "ledger.json");
}

function readState(stateFile) {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function inspectCommand(command, { stateFile, lifecycle = "reliable" } = {}) {
  const effectiveStateFile = stateFile || tempStateFile();
  if (!readStateMaybe(effectiveStateFile)) {
    writeFileSync(effectiveStateFile, JSON.stringify({ lifecycle }));
  }
  const refs = extractRuleLeafReadsFromBash(command, REPO_ROOT);
  const result = inspectSessionRuleLoadDuplicates(refs, { repoRoot: REPO_ROOT, stateFile: effectiveStateFile });
  return {
    refs,
    result,
    reason: formatDuplicateRuleLoadBlockReason(result),
  };
}

function writeInitialLedgerState(stateFile, state) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
}

function readStateMaybe(stateFile) {
  try {
    return readState(stateFile);
  } catch {
    return null;
  }
}

function recordCommand(command, { stateFile, output = "rule body\n" } = {}) {
  const refs = extractRuleLeafReadsFromBash(command, REPO_ROOT);
  if (refs.length > 0 && output.trim()) {
    return recordSessionRuleLoads(refs, { repoRoot: REPO_ROOT, stateFile });
  }
  return null;
}

function hookEnv(stateFile, { stateDir, deriveDiagFile = false } = {}) {
  // Either an explicit single stateFile (existing session-scoped fixture
  // pattern) or a stateDir (T1/T2 subagent-scope fixtures, where the hook
  // itself must derive the per-session/per-subagent filename via
  // DEVPRO_RULE_LOAD_LEDGER_STATE_DIR) must be provided.
  const isolatedDir = stateFile ? path.dirname(stateFile) : stateDir;
  const env = {
    ...process.env,
    ...(stateFile ? { DEVPRO_RULE_LOAD_LEDGER_STATE_FILE: stateFile } : {}),
    ...(stateDir ? { DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir } : {}),
    // deriveDiagFile=true (T4 diagnostic-dispatch tests) intentionally omits
    // DEVPRO_RULE_LOAD_HOST_DIAG_FILE so the hook derives its own scoped
    // filename via diagnosticPath() instead of writing to a single fixed file.
    ...(deriveDiagFile
      ? {}
      : { DEVPRO_RULE_LOAD_HOST_DIAG_FILE: path.join(isolatedDir, "rule-load-host-diagnostic.jsonl") }),
    DEVPRO_FRICTION_LOG: path.join(isolatedDir, "friction.json"),
    DEVPRO_RECAP_PENDING_DIR: path.join(isolatedDir, "recap-pending"),
    DEVPRO_RECAP_STATE_DIR: path.join(isolatedDir, "recap-state"),
    DEVPRO_NOTES_DIR: path.join(isolatedDir, "notes"),
    DEVPRO_RIGOR_LEVEL: "full",
  };
  // Tests that model "no Codex subagent signal" must not inherit the live
  // parent Codex session id. Individual fixtures pass CODEX_THREAD_ID in
  // spawnHook(..., { env }) when they intentionally test Codex scoping.
  delete env.CODEX_THREAD_ID;
  return env;
}

function spawnHook(script, payload, { cwd = REPO_ROOT, stateFile, stateDir, deriveDiagFile = false, env = {} }) {
  return spawnSync(process.execPath, [script], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...hookEnv(stateFile, { stateDir: stateDir || env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR, deriveDiagFile }),
      ...env,
    },
    timeout: 10_000,
  });
}

test("unknown lifecycle records duplicate telemetry without advisory or block", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "unknown" }));

  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  const second = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
  });

  assert.equal(second.result.lifecycle, "unknown");
  assert.equal(second.result.duplicates.length, 1);
  assert.equal(second.reason, "");
});

test("default session ledger path is scoped by session identity", () => {
  const dir = makeTempDir("rule-load-session-path-");
  const a = sessionRuleLoadLedgerStateFile(dir, { sessionIdentity: "session-a" });
  const b = sessionRuleLoadLedgerStateFile(dir, { sessionIdentity: "session-b" });

  assert.notEqual(a, b);
  assert.match(path.basename(a), /^rule-load-session-ledger-session-a\.json$/);
  assert.match(path.basename(b), /^rule-load-session-ledger-session-b\.json$/);
});

test("session identity ignores path-only transcript fallbacks", () => {
  assert.equal(sessionRuleLoadIdentity({ transcript_path: "/tmp/transcript.jsonl" }), "");
  assert.equal(sessionRuleLoadIdentity({ hook_input: { transcript_path: "/tmp/transcript.jsonl" } }), "");
  assert.equal(sessionRuleLoadIdentity({ conversation_id: "conversation-1" }), "conversation-1");
});

// ── Subagent-scope ledger dispatch (T1/T2: prove-it) ──────────────────────
//
// Root cause: main agent and its subagents share the same payload session_id
// (Claude + Codex both observed). The ledger filename must diverge for
// subagent-signaled payloads so parallel subagent full-reads of the same
// rule leaf do not collide with the main session's ledger and get
// hard-blocked. Q1-decided direction: only a *confirmed* main payload gets
// the base (no-suffix) filename; everything else (subagent signal OR
// ambiguous signal) gets a scoped filename.
//
// These tests exercise the hook as a subprocess (matching runtime behavior)
// with DEVPRO_RULE_LOAD_LEDGER_STATE_DIR set, so the *hook itself* derives
// the ledger filename from the payload/env it receives — not the test
// process. The expected base filename
// (`rule-load-session-ledger-<sessionId>.json`) is asserted directly by
// literal string per the documented naming convention (see the "default
// session ledger path is scoped by session identity" test above), avoiding
// any reliance on env state in the test-runner process itself.

function baseLedgerStateFile(stateDir, sessionId) {
  return path.join(stateDir, `rule-load-session-ledger-${sessionId}.json`);
}

test("T1(a) Claude subagent payload (agent_id present) writes a scoped ledger and is not blocked by a parallel main full-read", () => {
  const stateDir = makeTempDir("rule-load-subagent-claude-");
  const mainStateFile = baseLedgerStateFile(stateDir, "shared-session");

  // Main already recorded a full read of this leaf (simulating the fan-out
  // parent having read it, or a sibling subagent's read leaking into main).
  writeInitialLedgerState(mainStateFile, { lifecycle: "reliable" });
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile: mainStateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "Bash",
    session_id: "shared-session",
    agent_id: "subagent-1",
    tool_input: {
      command: "cat .devpro/agent-rules/token-frugal-io.md",
      cwd: REPO_ROOT,
    },
  }, { env: { DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir } });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    "",
    "subagent full-read must not be blocked by the main session's ledger"
  );
});

test("T1(b) pure Claude main (no agent_id) real duplicate full-read is still hard-blocked and uses the base ledger filename", () => {
  const stateDir = makeTempDir("rule-load-subagent-claude-main-");
  const mainStateFile = baseLedgerStateFile(stateDir, "main-only-session");

  writeInitialLedgerState(mainStateFile, { lifecycle: "reliable" });
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile: mainStateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "Bash",
    session_id: "main-only-session",
    tool_input: {
      command: "cat .devpro/agent-rules/token-frugal-io.md",
      cwd: REPO_ROOT,
    },
  }, { env: { DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir } });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.decision, "block");
  assert.match(envelope.reason, /Duplicate Rule Load Ledger/);
  assert.match(envelope.reason, /token-frugal-io\.md/);
});

test("T2(a) Codex subagent (CODEX_THREAD_ID != session_id) writes a scoped ledger and is not blocked by a parallel main full-read", () => {
  const stateDir = makeTempDir("rule-load-subagent-codex-");
  const mainStateFile = baseLedgerStateFile(stateDir, "codex-shared-session");

  writeInitialLedgerState(mainStateFile, { lifecycle: "reliable" });
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile: mainStateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "functions.exec_command",
    session_id: "codex-shared-session",
    tool_input: {
      cmd: "cat .devpro/agent-rules/token-frugal-io.md",
      workdir: REPO_ROOT,
    },
  }, {
    env: {
      DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "codex-subagent-thread-1",
    },
  });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    "",
    "Codex subagent full-read must not be blocked by the main session's ledger"
  );
});

test("T2(b) Codex main (CODEX_THREAD_ID == session_id) real duplicate full-read is still hard-blocked and uses the base ledger filename", () => {
  const stateDir = makeTempDir("rule-load-subagent-codex-main-");
  const mainStateFile = baseLedgerStateFile(stateDir, "codex-main-session");

  writeInitialLedgerState(mainStateFile, { lifecycle: "reliable" });
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile: mainStateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "functions.exec_command",
    session_id: "codex-main-session",
    tool_input: {
      cmd: "cat .devpro/agent-rules/token-frugal-io.md",
      workdir: REPO_ROOT,
    },
  }, {
    env: {
      DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "codex-main-session",
    },
  });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.decision, "block");
  assert.match(envelope.reason, /Duplicate Rule Load Ledger/);
  assert.match(envelope.reason, /token-frugal-io\.md/);
});

test("T2(c) ambiguous Codex signal (CODEX_THREAD_ID env present but empty) falls back to scoped and is not blocked by main's ledger", () => {
  const stateDir = makeTempDir("rule-load-subagent-codex-fallback-");
  const mainStateFile = baseLedgerStateFile(stateDir, "codex-fallback-session");

  writeInitialLedgerState(mainStateFile, { lifecycle: "reliable" });
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile: mainStateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "functions.exec_command",
    session_id: "codex-fallback-session",
    tool_input: {
      cmd: "cat .devpro/agent-rules/token-frugal-io.md",
      workdir: REPO_ROOT,
    },
  }, {
    env: {
      DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir,
      // Present-but-empty env var: ambiguous signal per Q1 — must not be
      // treated as a confirmed main session, must not collide with main.
      CODEX_THREAD_ID: "",
    },
  });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    "",
    "ambiguous subagent signal must fall back to scoped, not collide with main ledger"
  );
});

// ── T4: diagnostic subagent-scope dispatch + no-leak ───────────────────────

test("T4 Claude subagent payload produces a scoped diagnostic file with dispatch decision fields", () => {
  const stateDir = makeTempDir("rule-load-diag-subagent-claude-");

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "exec_command",
    session_id: "diag-shared-session",
    agent_id: "diag-subagent-1",
    tool_input: {
      command: "cat .devpro/agent-rules/token-frugal-io.md",
      workdir: REPO_ROOT,
    },
  }, { stateDir, deriveDiagFile: true });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);

  const expectedDiagFile = path.join(
    stateDir,
    `rule-load-host-diagnostic-diag-shared-session${SCOPED_SUFFIX_DELIMITER}diag-subagent-1.jsonl`
  );
  assert.ok(
    existsSync(expectedDiagFile),
    "subagent diagnostic file must use the same scoped suffix as the ledger (agent_id)"
  );

  const entries = readFileSync(expectedDiagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session.subagentScoped, true);
  assert.equal(entries[0].session.subagentSuffixSource, "claude-agent-id");
  assert.equal(entries[0].session.subagentFields.hasAgentId, true);
});

test("T4 pure main payload (no subagent signal) produces the unscoped base diagnostic file with subagentScoped=false", () => {
  const stateDir = makeTempDir("rule-load-diag-main-");

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "exec_command",
    session_id: "diag-main-session",
    tool_input: {
      command: "cat .devpro/agent-rules/token-frugal-io.md",
      workdir: REPO_ROOT,
    },
  }, { stateDir, deriveDiagFile: true });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);

  const expectedDiagFile = path.join(stateDir, "rule-load-host-diagnostic-diag-main-session.jsonl");
  assert.ok(
    existsSync(expectedDiagFile),
    "main (confirmed, no subagent signal) diagnostic file must use the unscoped base filename"
  );

  const entries = readFileSync(expectedDiagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session.subagentScoped, false);
  assert.equal(entries[0].session.subagentSuffixSource, "main");
  assert.equal(entries[0].session.subagentFields.hasAgentId, false);
  assert.equal(entries[0].session.subagentFields.hasCodexThreadIdEnv, false);
});

test("T4 no-leak: subagent-scoped diagnostic entry never contains the raw command text", () => {
  const stateDir = makeTempDir("rule-load-diag-no-leak-");
  const secretMarker = "SECRET_TOKEN_FRUGAL_MARKER_DO_NOT_LEAK";

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "exec_command",
    session_id: "diag-no-leak-session",
    agent_id: "diag-subagent-no-leak",
    tool_input: {
      command: `cat .devpro/agent-rules/token-frugal-io.md # ${secretMarker}`,
      workdir: REPO_ROOT,
    },
  }, { stateDir, deriveDiagFile: true });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);

  const expectedDiagFile = path.join(
    stateDir,
    `rule-load-host-diagnostic-diag-no-leak-session${SCOPED_SUFFIX_DELIMITER}diag-subagent-no-leak.jsonl`
  );
  const raw = readFileSync(expectedDiagFile, "utf8");
  assert.equal(raw.includes(secretMarker), false, "diagnostic must not leak raw command text");
  // The full-payload `payload` field intentionally DOES include a
  // `tool_input` object (identity/metadata like workdir preserved) — the
  // no-leak contract is content/output-only, not "avoid the key name
  // tool_input entirely". See the dedicated payload-field tests below for
  // the content/output exclusion + identity-preservation assertions.
  assert.equal(raw.includes("tool_input"), true, "full payload field must retain tool_input (minus command/cmd/content)");

  const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session.subagentScoped, true);
  assert.equal(entries[0].session.subagentSuffixSource, "claude-agent-id");
  assert.equal(entries[0].commandFields.hasCommand, true);
  assert.ok(Number.isInteger(entries[0].commandFields.commandBytes));
});

// ── Full hook payload recording (diagnostic entry `payload` field) ─────────
//
// User's explicit requirement (twice): diagnostic must record the FULL hook
// payload so a later debug session can find "which agent" — presence-only
// flags (hasAgentId, etc.) cannot answer "what was the agent_id value".
// Scope: exclude ONLY rule-content/command-output-bearing fields
// (tool_input.command/cmd/content, tool_response/tool_output/output/
// stdout/stderr) via deep-clone + delete; everything else (agent_id,
// agent_type, session_id, tool_input.file_path/cwd/workdir, ...) is
// preserved verbatim. Additive to the existing flattened presence fields,
// which remain unchanged.

test("T4 payload field: records the actual agent_id value (reverse-trace) while omitting command/content/output values", () => {
  const stateDir = makeTempDir("rule-load-diag-payload-reverse-trace-");
  const secretMarker = "SECRET_MARKER_MUST_NOT_LEAK";
  const ruleBodyText = "rule body text";
  const toolResponseText = "tool_response_output_value";

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "exec_command",
    session_id: "payload-trace-session",
    agent_id: "test-agent-xyz",
    agent_type: "dp-programmer",
    tool_input: {
      command: `cat .devpro/agent-rules/token-frugal-io.md # ${secretMarker}`,
      content: ruleBodyText,
      file_path: ".devpro/agent-rules/token-frugal-io.md",
      cwd: REPO_ROOT,
    },
    tool_response: toolResponseText,
  }, { stateDir, deriveDiagFile: true });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);

  // This payload carries agent_id, so per Q1 dispatch it produces the
  // scoped diagnostic filename (agent_id present => subagent-scoped), not
  // the unscoped base file — see the T4 dispatch tests above for the
  // filename-scoping contract itself; this test's focus is the `payload`
  // field's content, not which file it lands in.
  const expectedDiagFile = path.join(
    stateDir,
    `rule-load-host-diagnostic-payload-trace-session${SCOPED_SUFFIX_DELIMITER}test-agent-xyz.jsonl`
  );
  const raw = readFileSync(expectedDiagFile, "utf8");

  // Reverse-trace guarantee: the actual agent_id value is retrievable.
  const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.agent_id, "test-agent-xyz");
  assert.equal(entries[0].payload.agent_type, "dp-programmer");
  assert.equal(entries[0].payload.session_id, "payload-trace-session");
  // Identity/metadata sub-fields of tool_input preserved verbatim.
  assert.equal(entries[0].payload.tool_input.file_path, ".devpro/agent-rules/token-frugal-io.md");
  assert.equal(entries[0].payload.tool_input.cwd, REPO_ROOT);
  // Content/output fields excluded from the payload sub-object.
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload.tool_input, "command"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload.tool_input, "content"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload, "tool_response"), false);

  // no-leak does not regress: none of the excluded values appear anywhere
  // in the serialized entry.
  assert.equal(raw.includes(secretMarker), false, "payload field must not leak the raw command text");
  assert.equal(raw.includes(ruleBodyText), false, "payload field must not leak rule content");
  assert.equal(raw.includes(toolResponseText), false, "payload field must not leak tool_response output");
});

test("T4 payload field: strips tool_output/output/stdout/stderr aliases and cmd (Codex shape) while preserving other tool_input fields", () => {
  const stateDir = makeTempDir("rule-load-diag-payload-codex-strip-");
  const outputMarker = "CODEX_OUTPUT_MARKER_MUST_NOT_LEAK";

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "functions.exec_command",
    session_id: "payload-codex-session",
    tool_input: {
      cmd: `cat .devpro/agent-rules/token-frugal-io.md`,
      workdir: REPO_ROOT,
    },
    tool_output: outputMarker,
    stdout: outputMarker,
    stderr: outputMarker,
  }, { stateDir, deriveDiagFile: true });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);

  const expectedDiagFile = path.join(stateDir, "rule-load-host-diagnostic-payload-codex-session.jsonl");
  const raw = readFileSync(expectedDiagFile, "utf8");
  const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);

  assert.equal(entries[0].payload.tool_input.workdir, REPO_ROOT);
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload.tool_input, "cmd"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload, "tool_output"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload, "stdout"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entries[0].payload, "stderr"), false);
  assert.equal(raw.includes(outputMarker), false, "payload field must not leak any output-alias field value");
});

test("T6: host-diagnostics reuses ledger payloadAgentId (probe-array dedup regression)", () => {
  // Root cause this guards: rule-load-host-diagnostics.mjs used to inline its
  // own 6-candidate agent_id probe array in both subagentDispatchDecision()
  // and subagentSignalFields(), independently of the ledger's payloadAgentId()
  // in rule-load-session-ledger.mjs — three probe arrays that could silently
  // diverge if only one got updated. Post-dedup, host-diagnostics imports and
  // calls the ledger's payloadAgentId() directly instead of re-deriving it.
  //
  // This asserts the source text itself: the import block must name
  // payloadAgentId, and the module body must contain zero occurrences of the
  // old inline candidate literals (e.g. `hook_input?.agentId`). If someone
  // reverts host-diagnostics to an inline array, this test goes red even
  // though the runtime behavior might still happen to agree for common
  // payload shapes.
  const hostDiagnosticsSource = readFileSync(
    repoPath(".devpro/scripts/hooks/lib/rule-load-host-diagnostics.mjs"),
    "utf8"
  );

  assert.match(
    hostDiagnosticsSource,
    /import\s*\{[^}]*\bpayloadAgentId\b[^}]*\}\s*from\s*["']\.\/rule-load-session-ledger\.mjs["']/,
    "host-diagnostics must import payloadAgentId from the ledger module"
  );
  assert.equal(
    (hostDiagnosticsSource.match(/\bpayloadAgentId\s*\(/g) || []).length >= 2,
    true,
    "host-diagnostics must call the imported payloadAgentId (subagentDispatchDecision + subagentSignalFields), not re-derive it"
  );
  assert.equal(
    hostDiagnosticsSource.includes("hook_input?.agentId"),
    false,
    "host-diagnostics must not reintroduce its own inline agent_id candidate array"
  );
});

test("shell command tool detection covers live Claude and Codex shell surfaces", () => {
  assert.equal(isShellCommandToolName("Bash"), true);
  assert.equal(isShellCommandToolName("functions.exec_command"), true);
  assert.equal(isShellCommandToolName("exec_command"), false);
  assert.equal(isShellCommandToolName("Write"), false);
});

test("native Read payload extraction covers claude-code file_path surface", () => {
  assert.equal(isReadToolName("Read"), true);
  assert.equal(isReadToolName("Bash"), false);

  const full = extractRuleLeafReadsFromPayload({
    tool_name: "Read",
    session_id: "claude-session",
    tool_input: {
      file_path: path.join(REPO_ROOT, ".devpro/agent-rules/ai-autonomy-root-cause.md"),
    },
  }, REPO_ROOT);

  assert.equal(full.length, 1);
  assert.equal(full[0].relPath, "ai-autonomy-root-cause.md");
  assert.equal(full[0].coverage, "full");
  assert.equal(full[0].coverageKey, "full");
  assert.equal(full[0].commandKind, "Read");

  const partial = extractRuleLeafReadsFromPayload({
    tool_name: "Read",
    session_id: "claude-session",
    tool_input: {
      file_path: ".devpro/agent-rules/ai-autonomy-root-cause.md",
      offset: 1,
      limit: 20,
    },
  }, REPO_ROOT);

  assert.equal(partial.length, 1);
  assert.equal(partial[0].coverage, "partial");
  assert.equal(partial[0].coverageKey, "Read:1:20");
});

test("reliable lifecycle full reread is blocked before duplicate rule text enters context", () => {
  const stateFile = tempStateFile();
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "test-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  const second = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  assert.match(second.reason, /Duplicate Rule Load Ledger/);
  assert.match(second.reason, /token-frugal-io\.md/);
  assert.match(second.reason, /duplicate tokens/i);
  assert.match(second.reason, /--session-id/);
});

test("mixed duplicate and new full reads list the new leaves to rerun", () => {
  const stateFile = tempStateFile();
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "test-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  const mixed = inspectCommand(
    "cat .devpro/agent-rules/token-frugal-io.md .devpro/agent-rules/ai-autonomy-root-cause.md",
    { stateFile }
  );

  assert.match(mixed.reason, /尚未載入的 full read/);
  assert.match(mixed.reason, /ai-autonomy-root-cause\.md/);
});

test("PreToolUse hook emits a block envelope for a duplicate full rule reread", () => {
  const stateFile = tempStateFile("rule-load-pretool-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "test-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/ai-autonomy-root-cause.md", { stateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "Bash",
    session_id: "test-session",
    tool_input: {
      command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      cwd: REPO_ROOT,
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.decision, "block");
  assert.match(envelope.reason, /Duplicate Rule Load Ledger/);
  assert.match(envelope.reason, /ai-autonomy-root-cause\.md/);
});

test("PreToolUse hook records a first full Bash rule read before command output enters context", () => {
  const stateFile = tempStateFile("rule-load-pretool-record-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "test-session" },
    { stateFile }
  );

  const result = spawnHook(preToolHook, {
    tool_name: "Bash",
    session_id: "test-session",
    tool_input: {
      command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      cwd: REPO_ROOT,
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  const state = readState(stateFile);
  assert.ok(state.files["ai-autonomy-root-cause.md"]);
  assert.equal(state.files["ai-autonomy-root-cause.md"].coverage, "full");
  assert.equal(state.files["ai-autonomy-root-cause.md"].readCount, 1);
});

test("Codex functions.exec_command PreToolUse records a first full rule read before command output enters context", () => {
  const stateFile = tempStateFile("rule-load-codex-pretool-record-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "codex-session" },
    { stateFile }
  );

  const result = spawnHook(preToolHook, {
    tool_name: "functions.exec_command",
    session_id: "codex-session",
    tool_input: {
      cmd: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      workdir: REPO_ROOT,
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  const state = readState(stateFile);
  assert.ok(state.files["ai-autonomy-root-cause.md"]);
  assert.equal(state.files["ai-autonomy-root-cause.md"].coverage, "full");
  assert.equal(state.files["ai-autonomy-root-cause.md"].readCount, 1);
});

test("Codex Bash PreToolUse records a first full rule read before command output enters context", () => {
  const stateFile = tempStateFile("rule-load-codex-bash-pretool-record-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "codex-bash-session" },
    { stateFile }
  );

  const result = spawnHook(preToolHook, {
    tool_name: "Bash",
    session_id: "codex-bash-session",
    tool_input: {
      command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      cwd: REPO_ROOT,
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  const state = readState(stateFile);
  assert.ok(state.files["ai-autonomy-root-cause.md"]);
  assert.equal(state.files["ai-autonomy-root-cause.md"].coverage, "full");
  assert.equal(state.files["ai-autonomy-root-cause.md"].commandKind, "cat");
  assert.equal(state.files["ai-autonomy-root-cause.md"].readCount, 1);
});

test("Codex Bash PreToolUse blocks duplicate full rule rereads", () => {
  const stateFile = tempStateFile("rule-load-codex-bash-pretool-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "codex-bash-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/ai-autonomy-root-cause.md", { stateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "Bash",
    session_id: "codex-bash-session",
    tool_input: {
      command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      cwd: REPO_ROOT,
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.decision, "block");
  assert.match(envelope.reason, /Duplicate Rule Load Ledger/);
  assert.match(envelope.reason, /ai-autonomy-root-cause\.md/);
});

test("claude-code Read PreToolUse records a first full rule read before file text enters context", () => {
  const stateFile = tempStateFile("rule-load-claude-read-pretool-record-hook-");
  const diagFile = path.join(path.dirname(stateFile), "claude-read-recorder-diag.jsonl");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "claude-session" },
    { stateFile }
  );

  const result = spawnHook(preToolHook, {
    tool_name: "Read",
    session_id: "claude-session",
    tool_input: {
      file_path: path.join(REPO_ROOT, ".devpro/agent-rules/ai-autonomy-root-cause.md"),
    },
  }, {
    stateFile,
    env: { DEVPRO_RULE_LOAD_HOST_DIAG_FILE: diagFile },
  });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  const state = readState(stateFile);
  assert.ok(state.files["ai-autonomy-root-cause.md"]);
  assert.equal(state.files["ai-autonomy-root-cause.md"].coverage, "full");
  assert.equal(state.files["ai-autonomy-root-cause.md"].readCount, 1);

  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(entries[0].toolName, "Read");
  assert.equal(entries[0].filePathFields.hasFilePath, true);
  assert.equal(entries[0].reason, "recorder-recorded");
  assert.equal(entries[0].refs[0].relPath, "ai-autonomy-root-cause.md");
  assert.equal(entries[0].refs[0].coverage, "full");
});

test("rule-load host diagnostic hook records bounded candidate metadata only", () => {
  const stateFile = tempStateFile("rule-load-host-diag-");
  const diagFile = path.join(path.dirname(stateFile), "host-diag.jsonl");

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "exec_command",
    session_id: "host-session",
    tool_input: {
      command: "sed -n '1,5p' .devpro/agent-rules/token-frugal-io.md",
      workdir: REPO_ROOT,
    },
  }, {
    stateFile,
    env: { DEVPRO_RULE_LOAD_HOST_DIAG_FILE: diagFile },
  });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(readStateMaybe(stateFile), null, "diagnostic hook must not mutate ledger state");

  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "host-diag");
  assert.equal(entries[0].toolName, "exec_command");
  assert.equal(entries[0].commandFields.hasCommand, true);
  assert.equal(entries[0].session.hasIdentity, true);
  assert.equal(entries[0].refs[0].relPath, "token-frugal-io.md");
  assert.equal(JSON.stringify(entries[0]).includes("Specification-First"), false);
});

test("rule-load host diagnostic hook captures native Read file_path payload shape", () => {
  const stateFile = tempStateFile("rule-load-read-host-diag-");
  const diagFile = path.join(path.dirname(stateFile), "read-host-diag.jsonl");

  const result = spawnHook(ruleLoadDiagHook, {
    tool_name: "Read",
    session_id: "claude-session",
    tool_input: {
      file_path: path.join(REPO_ROOT, ".devpro/agent-rules/token-frugal-io.md"),
    },
  }, {
    stateFile,
    env: { DEVPRO_RULE_LOAD_HOST_DIAG_FILE: diagFile },
  });

  assert.equal(result.status, 0, `diag hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(readStateMaybe(stateFile), null, "diagnostic hook must not mutate ledger state");

  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "host-diag");
  assert.equal(entries[0].toolName, "Read");
  assert.equal(entries[0].commandFields.hasCommand, false);
  assert.equal(entries[0].filePathFields.hasFilePath, true);
  assert.equal(entries[0].reason, "candidate-rule-read");
  assert.equal(entries[0].refs[0].relPath, "token-frugal-io.md");
  assert.equal(entries[0].refs[0].coverage, "full");
  assert.equal(JSON.stringify(entries[0]).includes("Specification-First"), false);
});

test("PreToolUse recorder writes host diagnostic decision metadata", () => {
  const stateFile = tempStateFile("rule-load-recorder-diag-");
  const diagFile = path.join(path.dirname(stateFile), "recorder-diag.jsonl");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "codex-session" },
    { stateFile }
  );

  const result = spawnHook(preToolHook, {
    tool_name: "functions.exec_command",
    session_id: "codex-session",
    tool_input: {
      cmd: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      workdir: REPO_ROOT,
    },
  }, {
    stateFile,
    env: { DEVPRO_RULE_LOAD_HOST_DIAG_FILE: diagFile },
  });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  assert.equal(result.stdout, "");
  const state = readState(stateFile);
  assert.ok(state.files["ai-autonomy-root-cause.md"]);

  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(entries[0].reason, "recorder-recorded");
  assert.equal(entries[0].recordCount, 1);
  assert.equal(entries[0].refs[0].relPath, "ai-autonomy-root-cause.md");
});

test("PostToolUse hook does not double-count rule reads recorded by PreToolUse", () => {
  const stateFile = tempStateFile("rule-load-posttool-no-double-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "test-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/ai-autonomy-root-cause.md", { stateFile });

  const result = spawnHook(postToolHook, {
    tool_name: "Bash",
    session_id: "test-session",
    tool_input: {
      command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      cwd: REPO_ROOT,
    },
    tool_response: {
      exit_code: 0,
      stdout: "rule body\n",
    },
  }, { stateFile });

  assert.equal(result.status, 0, `post-tool hook should exit 0; stderr=${result.stderr}`);
  const state = readState(stateFile);
  assert.equal(state.files["ai-autonomy-root-cause.md"].readCount, 1);
});

test("Codex functions.exec_command PreToolUse blocks duplicate full rule rereads", () => {
  const stateFile = tempStateFile("rule-load-codex-pretool-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "codex-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/ai-autonomy-root-cause.md", { stateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "functions.exec_command",
    session_id: "codex-session",
    tool_input: {
      cmd: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
      workdir: REPO_ROOT,
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.decision, "block");
  assert.match(envelope.reason, /Duplicate Rule Load Ledger/);
  assert.match(envelope.reason, /ai-autonomy-root-cause\.md/);
});

test("claude-code Read PreToolUse blocks duplicate full rule rereads", () => {
  const stateFile = tempStateFile("rule-load-claude-read-pretool-hook-");
  applySessionStartRuleLoadLedger(
    { source: "startup", session_id: "claude-session" },
    { stateFile }
  );
  recordCommand("cat .devpro/agent-rules/ai-autonomy-root-cause.md", { stateFile });

  const result = spawnHook(preToolHook, {
    tool_name: "Read",
    session_id: "claude-session",
    tool_input: {
      file_path: path.join(REPO_ROOT, ".devpro/agent-rules/ai-autonomy-root-cause.md"),
    },
  }, { stateFile });

  assert.equal(result.status, 0, `pre-tool hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.decision, "block");
  assert.match(envelope.reason, /Duplicate Rule Load Ledger/);
  assert.match(envelope.reason, /ai-autonomy-root-cause\.md/);
});

test("PostToolUse stdout extraction ignores metadata when stdout is empty", () => {
  const stdout = toolResponseStdout({
    exit_code: 0,
    stdout: "",
    command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
    metadata: { note: "rule body omitted" },
  });

  assert.equal(stdout.found, true);
  assert.equal(stdout.text, "");

  const missing = toolResponseStdout({
    exit_code: 0,
    command: "cat .devpro/agent-rules/ai-autonomy-root-cause.md",
    metadata: { note: "rule body omitted" },
  });
  assert.equal(missing.found, false);
});

test("SessionStart hook applies clear lifecycle and returns SessionStart JSON envelope", () => {
  const stateFile = tempStateFile("rule-load-session-hook-");
  const gitRepo = makeTempDir("rule-load-session-hook-repo-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: gitRepo, encoding: "utf8" });
  writeFileSync(stateFile, JSON.stringify({
    lifecycle: "reliable",
    files: { "ai-autonomy-root-cause.md": { hash: "abc", readCount: 2 } },
  }));

  const result = spawnHook(sessionStartHook, {
    source: "clear",
    session_id: "test-session",
  }, { cwd: gitRepo, stateFile });

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.hookSpecificOutput?.hookEventName, "SessionStart");
  const state = readState(stateFile);
  assert.deepEqual(state.files, {});
  assert.equal(state.lifecycle, "reliable");
  assert.equal(state.audit.at(-1).source, "clear");
});

test("SessionStart hook with session identity writes only session-scoped state", () => {
  const isolatedDir = makeTempDir("rule-load-session-scoped-");
  const stateDir = path.join(isolatedDir, "state");
  const result = spawnSync(process.execPath, [sessionStartHook], {
    cwd: REPO_ROOT,
    input: JSON.stringify({ source: "startup", session_id: "scoped-session" }),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_RULE_LOAD_LEDGER_STATE_FILE: "",
      DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir,
      DEVPRO_FRICTION_LOG: path.join(isolatedDir, "friction.json"),
      DEVPRO_RECAP_PENDING_DIR: path.join(isolatedDir, "recap-pending"),
      DEVPRO_RECAP_STATE_DIR: path.join(isolatedDir, "recap-state"),
      DEVPRO_NOTES_DIR: path.join(isolatedDir, "notes"),
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  const stateFile = path.join(stateDir, "rule-load-session-ledger-scoped-session.json");
  assert.equal(readState(stateFile).lifecycle, "reliable");
  assert.equal(
    existsSync(path.join(stateDir, "rule-load-session-ledger-current.json")),
    false,
    "SessionStart must not write a last-writer-wins current pointer"
  );
});

test("SessionStart hook without lifecycle payload does not write shared unknown ledger state", () => {
  const isolatedDir = makeTempDir("rule-load-session-no-payload-");
  const stateDir = path.join(isolatedDir, "state");
  const result = spawnSync(process.execPath, [sessionStartHook], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_RULE_LOAD_LEDGER_STATE_FILE: "",
      DEVPRO_RULE_LOAD_LEDGER_STATE_DIR: stateDir,
      DEVPRO_FRICTION_LOG: path.join(isolatedDir, "friction.json"),
      DEVPRO_RECAP_PENDING_DIR: path.join(isolatedDir, "recap-pending"),
      DEVPRO_RECAP_STATE_DIR: path.join(isolatedDir, "recap-state"),
      DEVPRO_NOTES_DIR: path.join(isolatedDir, "notes"),
    },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(
    existsSync(path.join(stateDir, "rule-load-session-ledger.json")),
    false,
    "missing SessionStart payload must not poison the shared fallback ledger"
  );
});

test("partial reliable read does not cover a later full rule leaf read", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  recordCommand("sed -n '1,20p' .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
    output: "partial rule body\n",
  });

  const full = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  assert.deepEqual(full.result.duplicates, []);
  assert.equal(full.reason, "");
});

test("piped rule leaf reads are not recorded as full context loads", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  const recordResult = recordCommand("cat .devpro/agent-rules/token-frugal-io.md|wc -l", {
    stateFile,
    output: "120\n",
  });
  const full = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  assert.equal(recordResult, null);
  assert.deepEqual(full.result.duplicates, []);
  assert.equal(full.reason, "");
});

test("redirected rule leaf reads are not recorded as full context loads", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  const commands = [
    "cat .devpro/agent-rules/token-frugal-io.md >out",
    "cat .devpro/agent-rules/token-frugal-io.md 2>err",
    "cat .devpro/agent-rules/token-frugal-io.md >>out",
    "cat .devpro/agent-rules/token-frugal-io.md 1>out",
  ];
  for (const command of commands) {
    const recordResult = recordCommand(command, { stateFile, output: "redirected body\n" });
    assert.equal(recordResult, null, command);
  }
  const full = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  assert.deepEqual(full.result.duplicates, []);
  assert.equal(full.reason, "");
});

test("read command words in argument position are not recorded or blocked", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  for (const command of [
    "echo cat .devpro/agent-rules/token-frugal-io.md",
    "printf %s cat .devpro/agent-rules/token-frugal-io.md",
  ]) {
    const recordResult = recordCommand(command, { stateFile, output: `${command}\n` });
    assert.equal(recordResult, null, command);
  }
  const full = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });
  assert.deepEqual(full.result.duplicates, []);

  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
    output: "rule body\n",
  });
  const echoAfterRead = inspectCommand("echo cat .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
  });
  assert.deepEqual(echoAfterRead.result.refs, []);
  assert.equal(echoAfterRead.reason, "");
});

test("read commands after shell separators are still recorded", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  const recordResult = recordCommand("echo start ; cat .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
    output: "rule body\n",
  });

  assert.equal(recordResult.records[0].relPath, "token-frugal-io.md");
  assert.equal(recordResult.records[0].coverage, "full");
});

test("known whole-file tail and sed reads are treated as full coverage", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  const tail = recordCommand("tail -n +1 .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
    output: "rule body\n",
  });
  assert.equal(tail.records[0].coverage, "full");
  const fullAfterTail = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });
  assert.equal(fullAfterTail.result.duplicates.length, 1);

  const sedStateFile = tempStateFile();
  writeFileSync(sedStateFile, JSON.stringify({ lifecycle: "reliable" }));
  const sed = recordCommand("sed -n '1,$p' .devpro/agent-rules/token-frugal-io.md", {
    stateFile: sedStateFile,
    output: "rule body\n",
  });
  assert.equal(sed.records[0].coverage, "full");
  const fullAfterSed = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", {
    stateFile: sedStateFile,
  });
  assert.equal(fullAfterSed.result.duplicates.length, 1);
});

test("less reads are partial telemetry rather than full hard-block input", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  const recordResult = recordCommand("less .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
    output: "rule page\n",
  });

  assert.equal(recordResult.records[0].coverage, "partial");
  const full = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });
  assert.deepEqual(full.result.duplicates, []);
});

test("failed or empty-output rule reads are not recorded", () => {
  const stateFile = tempStateFile();
  writeFileSync(stateFile, JSON.stringify({ lifecycle: "reliable" }));

  recordCommand("cat .devpro/agent-rules/token-frugal-io.md", {
    stateFile,
    output: "",
  });
  const reread = inspectCommand("cat .devpro/agent-rules/token-frugal-io.md", { stateFile });

  assert.deepEqual(reread.result.duplicates, []);
  assert.equal(reread.reason, "");
});

test("non-rule Bash reads do not produce ledger refs", () => {
  const json = inspectCommand("sed -n '1,20p' README.md", {
    stateFile: tempStateFile(),
  });

  assert.deepEqual(json.refs, []);
  assert.deepEqual(json.result.duplicates, []);
  assert.equal(json.reason, "");
});

test("SessionStart source=clear resets session rule-load ledger state", () => {
  const stateFile = tempStateFile("rule-load-session-start-");
  writeFileSync(stateFile, JSON.stringify({ files: { "token-frugal-io.md": { readCount: 2 } } }));

  applySessionStartRuleLoadLedger(
    { source: "clear", session_id: "test-session" },
    { stateFile }
  );

  const state = readState(stateFile);
  assert.deepEqual(state.files, {});
  assert.equal(state.audit.at(-1).type, "reset");
  assert.equal(state.audit.at(-1).source, "clear");
});

test("SessionStart source=compact advances epoch without clearing files", () => {
  const stateFile = tempStateFile("rule-load-session-compact-");
  writeFileSync(stateFile, JSON.stringify({
    contextEpoch: 0,
    lifecycle: "reliable",
    files: { "token-frugal-io.md": { hash: "abc", readCount: 1 } },
  }));

  applySessionStartRuleLoadLedger(
    { source: "compact", session_id: "test-session" },
    { stateFile }
  );

  const state = readState(stateFile);
  assert.equal(state.contextEpoch, 1);
  assert.ok(state.files["token-frugal-io.md"]);
  assert.equal(state.audit.at(-1).type, "epoch");
  assert.equal(state.audit.at(-1).source, "compact");
});

test("SessionStart source=resume preserves reliable lifecycle and files", () => {
  const stateFile = tempStateFile("rule-load-session-resume-");
  writeFileSync(stateFile, JSON.stringify({
    contextEpoch: 2,
    lifecycle: "reliable",
    files: { "token-frugal-io.md": { hash: "abc", readCount: 1 } },
  }));

  applySessionStartRuleLoadLedger(
    { source: "resume", session_id: "test-session" },
    { stateFile }
  );

  const state = readState(stateFile);
  assert.equal(state.contextEpoch, 2);
  assert.ok(state.files["token-frugal-io.md"]);
  assert.equal(state.lifecycle, "reliable");
  assert.equal(state.audit.at(-1).type, "preserve");
  assert.equal(state.audit.at(-1).lifecycle, "reliable");
});

test("SessionStart missing source preserves files but marks lifecycle unknown", () => {
  const stateFile = tempStateFile("rule-load-session-unknown-");
  writeFileSync(stateFile, JSON.stringify({
    contextEpoch: 4,
    lifecycle: "reliable",
    files: { "token-frugal-io.md": { hash: "abc", readCount: 1 } },
  }));

  applySessionStartRuleLoadLedger({}, { stateFile });

  const state = readState(stateFile);
  assert.equal(state.contextEpoch, 4);
  assert.ok(state.files["token-frugal-io.md"]);
  assert.equal(state.lifecycle, "unknown");
  assert.equal(state.audit.at(-1).type, "unknown");
});

test("SessionStart source without session identity preserves files and marks lifecycle unknown", () => {
  const stateFile = tempStateFile("rule-load-session-no-id-");
  writeFileSync(stateFile, JSON.stringify({
    contextEpoch: 4,
    lifecycle: "reliable",
    files: { "token-frugal-io.md": { hash: "abc", readCount: 1 } },
  }));

  applySessionStartRuleLoadLedger({ source: "clear" }, { stateFile });

  const state = readState(stateFile);
  assert.equal(state.contextEpoch, 4);
  assert.ok(state.files["token-frugal-io.md"]);
  assert.equal(state.lifecycle, "unknown");
  assert.equal(state.audit.at(-1).type, "unknown");
  assert.match(state.audit.at(-1).reason, /session identity missing/);
});

// ── T5: scoped sibling house-keeping sweep (session-start.mjs) ─────────────
//
// Base-vs-scoped disambiguation is structural: a scoped sibling's id segment
// always contains SCOPED_SUFFIX_DELIMITER ("~sub~"), which — unlike a plain
// "-" join — can never occur inside a sanitized base id (including
// hyphen-heavy UUID session ids) or a sanitized subagent suffix. Tests below
// build scoped filenames with the delimiter directly, and include a
// dedicated UUID-base-survives regression case per the reported false-
// positive (a `-`-based join could not tell a UUID base id apart from a
// scoped sibling).

function sessionStartWithStateDir(payload, stateDir) {
  return spawnHook(sessionStartHook, payload, { stateDir });
}

function scopedLedgerFile(stateDir, mainId, subagentSuffix) {
  return path.join(stateDir, `rule-load-session-ledger-${mainId}${SCOPED_SUFFIX_DELIMITER}${subagentSuffix}.json`);
}

function scopedDiagFile(stateDir, mainId, subagentSuffix) {
  return path.join(stateDir, `rule-load-host-diagnostic-${mainId}${SCOPED_SUFFIX_DELIMITER}${subagentSuffix}.jsonl`);
}

test("T5 SessionStart source=clear connected-clears scoped ledger and diagnostic siblings for the same main session", () => {
  const isolatedDir = makeTempDir("rule-load-t5-clear-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const mainLedger = path.join(stateDir, "rule-load-session-ledger-main-session.json");
  const scopedLedger = scopedLedgerFile(stateDir, "main-session", "agent-1");
  const scopedDiag = scopedDiagFile(stateDir, "main-session", "agent-1");
  writeFileSync(mainLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(scopedLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(scopedDiag, `${JSON.stringify({ version: 1 })}\n`);

  const result = sessionStartWithStateDir(
    { source: "clear", session_id: "main-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(existsSync(mainLedger), true, "main session's own ledger must survive its own clear/reset");
  assert.equal(existsSync(scopedLedger), false, "connected clear must remove the scoped ledger sibling");
  assert.equal(existsSync(scopedDiag), false, "connected clear must remove the scoped diagnostic sibling");
});

test("T5 SessionStart source=startup connected-clears scoped siblings the same way as clear", () => {
  const isolatedDir = makeTempDir("rule-load-t5-startup-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const scopedLedger = scopedLedgerFile(stateDir, "startup-session", "agent-2");
  writeFileSync(scopedLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));

  const result = sessionStartWithStateDir(
    { source: "startup", session_id: "startup-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(existsSync(scopedLedger), false, "startup connected clear must remove scoped ledger sibling");
});

test("T5 connected-clear does not touch a different main session's scoped siblings or its own base file", () => {
  const isolatedDir = makeTempDir("rule-load-t5-clear-scope-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const otherBase = path.join(stateDir, "rule-load-session-ledger-other-session.json");
  const otherScoped = scopedLedgerFile(stateDir, "other-session", "agent-x");
  writeFileSync(otherBase, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(otherScoped, JSON.stringify({ lifecycle: "reliable", files: {} }));

  const result = sessionStartWithStateDir(
    { source: "clear", session_id: "clearing-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(existsSync(otherBase), true, "a different main session's base file must not be touched by a foreign clear");
  assert.equal(existsSync(otherScoped), true, "a different main session's fresh scoped sibling must not be touched by a foreign clear");
});

test("T5 TTL sweep unlinks expired orphaned scoped siblings regardless of main session match", () => {
  const isolatedDir = makeTempDir("rule-load-t5-ttl-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const expiredLedger = scopedLedgerFile(stateDir, "orphan-session", "agent-9");
  const expiredDiag = scopedDiagFile(stateDir, "orphan-session", "agent-9");
  writeFileSync(expiredLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(expiredDiag, `${JSON.stringify({ version: 1 })}\n`);

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(expiredLedger, twoDaysAgo, twoDaysAgo);
  utimesSync(expiredDiag, twoDaysAgo, twoDaysAgo);

  // Unrelated main session's own SessionStart (resume, not clear/startup) —
  // TTL sweep must still catch the unrelated expired orphan.
  const result = sessionStartWithStateDir(
    { source: "resume", session_id: "different-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(existsSync(expiredLedger), false, "expired orphaned scoped ledger sibling must be unlinked by TTL sweep");
  assert.equal(existsSync(expiredDiag), false, "expired orphaned scoped diagnostic sibling must be unlinked by TTL sweep");
});

test("T5 TTL sweep preserves non-expired scoped siblings", () => {
  const isolatedDir = makeTempDir("rule-load-t5-fresh-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const freshLedger = scopedLedgerFile(stateDir, "active-session", "agent-3");
  writeFileSync(freshLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));

  const result = sessionStartWithStateDir(
    { source: "resume", session_id: "different-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(existsSync(freshLedger), true, "non-expired scoped sibling must be preserved");
});

test("T5 sweep never touches the base (unscoped) main ledger or diagnostic files", () => {
  const isolatedDir = makeTempDir("rule-load-t5-base-preserve-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const baseLedger = path.join(stateDir, "rule-load-session-ledger-plain-session.json");
  const baseDiag = path.join(stateDir, "rule-load-host-diagnostic-plain-session.jsonl");
  writeFileSync(baseLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(baseDiag, `${JSON.stringify({ version: 1 })}\n`);

  const result = sessionStartWithStateDir(
    { source: "clear", session_id: "plain-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(existsSync(baseLedger), true, "base ledger file for the clearing session itself must survive");
  assert.equal(existsSync(baseDiag), true, "base diagnostic file must never be touched by the scoped sweep");
});

test("T5 REGRESSION: a UUID-shaped base ledger file (many literal '-' chars) older than the TTL survives the sweep untouched", () => {
  // Root cause of the reported bug: safeSessionStateSuffix's sanitize
  // alphabet keeps "-" verbatim, so a UUID session id like
  // "2d10cccc-d0f8-48ed-a189-7003162c5b44" produces a base filename whose id
  // segment contains many "-" characters. A naive `idSegment.includes("-")`
  // TTL heuristic would misclassify this base file as a scoped sibling and
  // delete it, silently defeating the main session's own duplicate-read
  // ledger. The fix disambiguates structurally via SCOPED_SUFFIX_DELIMITER
  // ("~sub~"), which cannot appear in any sanitized id — so this base file
  // (no delimiter present) must never be touched, expired or not.
  const isolatedDir = makeTempDir("rule-load-t5-uuid-base-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const uuidSessionId = "2d10cccc-d0f8-48ed-a189-7003162c5b44";
  const uuidBaseLedger = path.join(stateDir, `rule-load-session-ledger-${uuidSessionId}.json`);
  const uuidBaseDiag = path.join(stateDir, `rule-load-host-diagnostic-${uuidSessionId}.jsonl`);
  writeFileSync(uuidBaseLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(uuidBaseDiag, `${JSON.stringify({ version: 1 })}\n`);

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(uuidBaseLedger, twoDaysAgo, twoDaysAgo);
  utimesSync(uuidBaseDiag, twoDaysAgo, twoDaysAgo);

  // A completely unrelated session's SessionStart triggers the TTL pass.
  const result = sessionStartWithStateDir(
    { source: "resume", session_id: "different-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  assert.equal(
    existsSync(uuidBaseLedger),
    true,
    "an idle UUID-id base ledger file must survive the TTL sweep — it is not a scoped sibling"
  );
  assert.equal(
    existsSync(uuidBaseDiag),
    true,
    "an idle UUID-id base diagnostic file must survive the TTL sweep — it is not a scoped sibling"
  );
});

test("T5 sweep failure (unreadable state dir) does not affect SessionStart's main output message", () => {
  const isolatedDir = makeTempDir("rule-load-t5-sweep-error-");
  // Point DEVPRO_RULE_LOAD_LEDGER_STATE_DIR at a path that is itself a file
  // (not a directory), so readdirSync() throws inside the sweep helper.
  const notADir = path.join(isolatedDir, "not-a-dir");
  writeFileSync(notADir, "not a directory");

  const result = sessionStartWithStateDir(
    { source: "clear", session_id: "error-session" },
    notADir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0 despite sweep failure; stderr=${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.ok(
    typeof envelope.hookSpecificOutput?.additionalContext === "string" &&
      envelope.hookSpecificOutput.additionalContext.length > 0,
    "SessionStart main output message must still be emitted when the sweep fails"
  );
});

test("T5 sweep leaves the state dir with only the expected surviving files after a clear + TTL pass", () => {
  const isolatedDir = makeTempDir("rule-load-t5-combined-");
  const stateDir = path.join(isolatedDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const mainLedger = path.join(stateDir, "rule-load-session-ledger-combo-session.json");
  const connectedSibling = scopedLedgerFile(stateDir, "combo-session", "agent-a");
  const unrelatedExpired = scopedLedgerFile(stateDir, "unrelated", "agent-b");
  writeFileSync(mainLedger, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(connectedSibling, JSON.stringify({ lifecycle: "reliable", files: {} }));
  writeFileSync(unrelatedExpired, JSON.stringify({ lifecycle: "reliable", files: {} }));
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(unrelatedExpired, twoDaysAgo, twoDaysAgo);

  const result = sessionStartWithStateDir(
    { source: "clear", session_id: "combo-session" },
    stateDir
  );

  assert.equal(result.status, 0, `session-start hook should exit 0; stderr=${result.stderr}`);
  const remaining = readdirSync(stateDir).filter((f) => f.startsWith("rule-load-session-ledger-"));
  assert.deepEqual(remaining.sort(), ["rule-load-session-ledger-combo-session.json"]);
});

// ─────────────────────────────────────────────────────────────────────────
// fix-eof-gate-cwd-blind-spot T12: rule-load ledger's 4 call points surface
// a named reason instead of a silent catch (design.md D6, D7). The two
// recorder functions' `repo-root-unresolved` branch is exercised via direct
// import rather than spawnHook — it is structurally unreachable through the
// full PreToolUse flow because the sibling check function (same bucket,
// runs first, same root cause) always short-circuits `checkBashCommand`
// before the state-update phase (`runStateUpdateInventory`) is reached.
// ─────────────────────────────────────────────────────────────────────────

test("T12: checkDuplicateRuleLoadLedger surfaces repo-root-unresolved when cwd is outside any git repo and a bare rule-leaf read is plausible", () => {
  const nonRepoCwd = makeTempDir("rule-load-t12-non-repo-cwd-");
  // Bare relative filename (NOT `.devpro/agent-rules/`-prefixed): this shape
  // depends on `ruleRoot` (built from repoRoot) to resolve via existsSync, so
  // it IS a real gap when repoRoot can't resolve — unlike the canonical
  // prefixed form, which resolves via a repoRoot-independent shortcut.
  const result = checkDuplicateRuleLoadLedger(
    "cat some-rule.md",
    nonRepoCwd,
    nonRepoCwd,
    { session_id: "t12-check-bash" }
  );
  assert.ok(result?.advisory, `expected an advisory; got ${JSON.stringify(result)}`);
  assert.match(result.advisory, /reason=repo-root-unresolved/);
});

test("T12: checkDuplicateRuleLoadLedgerPayload surfaces repo-root-unresolved for a Read outside any git repo", () => {
  const nonRepoCwd = makeTempDir("rule-load-t12-non-repo-cwd-read-");
  const filePath = path.join(nonRepoCwd, "some-rule.md");
  const result = checkDuplicateRuleLoadLedgerPayload(
    { session_id: "t12-check-read", tool_name: "Read", tool_input: { file_path: filePath } },
    nonRepoCwd,
    nonRepoCwd
  );
  assert.ok(result?.advisory, `expected an advisory; got ${JSON.stringify(result)}`);
  assert.match(result.advisory, /reason=repo-root-unresolved/);
});

test("T12: checkDuplicateRuleLoadLedger / …Payload stay class A silent when there is no rule-leaf reference (repoRoot resolves fine)", () => {
  const bashResult = checkDuplicateRuleLoadLedger("ls -la", REPO_ROOT, REPO_ROOT, { session_id: "t12-noop-bash" });
  assert.equal(bashResult, null);
  const payloadResult = checkDuplicateRuleLoadLedgerPayload(
    { session_id: "t12-noop-read", tool_name: "Read", tool_input: { file_path: path.join(REPO_ROOT, "package.json") } },
    REPO_ROOT,
    REPO_ROOT
  );
  assert.equal(payloadResult, null);
});

test("T12: recordRuleLoadLedgerState writes recorder-repo-root-unresolved to the telemetry channel (not a user-facing advisory)", () => {
  const isolatedDir = makeTempDir("rule-load-t12-recorder-bash-");
  const diagFile = path.join(isolatedDir, "recorder-diag.jsonl");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  // round-1 dp-reviewer F1 fix: an ABSOLUTE path is used here (rather than
  // the bare relative `.devpro/agent-rules/`-PREFIXED form this fixture used
  // before the fix) precisely because that relative-prefixed shape is
  // normalizeRuleLeafRef's repoRoot-INDEPENDENT shortcut — after the F1 fix,
  // it resolves and gets recorded even when repoRoot can't resolve (see the
  // dedicated "F1 fix" test below), so it can no longer stand in for a
  // genuine repo-root-unresolved case. An absolute path routes through
  // normalizeRuleLeafRef's `path.isAbsolute` branch instead, which DOES
  // depend on repoRoot (via `path.relative(ruleRoot, value)`) and correctly
  // fails to resolve when repoRoot is empty — while still containing the
  // literal `.devpro/agent-rules/` substring so isCandidateRuleReadPayload's
  // diagnostic-candidacy gate fires (buildRuleLoadHostDiagnostic requires a
  // "candidate" read shape before it will write anything at all).
  const cmd = `cat ${isolatedDir}/.devpro/agent-rules/some-rule.md`;
  let returnValue;
  try {
    returnValue = recordRuleLoadLedgerState(
      cmd,
      isolatedDir,
      isolatedDir,
      {
        session_id: "t12-recorder-bash",
        tool_name: "Bash",
        tool_input: { command: cmd },
      }
    );
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
  }
  assert.equal(returnValue, undefined, "recorder must stay fail-open — no return value is consumed by callers");
  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(entries[0].reason, "recorder-repo-root-unresolved");
});

test("F1 fix: recordRuleLoadLedgerState still records a canonical `.devpro/agent-rules/`-prefixed ref when repoRoot is unresolved (no longer silently skipped)", () => {
  // Regression coverage for round-1 dp-reviewer F1: recordRuleLoadLedgerState
  // used to `if (!repoRoot) return` BEFORE calling extractRuleLeafReadsFromBash,
  // which silently dropped canonical-prefixed refs that normalizeRuleLeafRef
  // can resolve independently of repoRoot. The fix reorders extraction before
  // the repoRoot check (mirroring checkDuplicateRuleLoadLedger). This test
  // proves the ref is now extracted and recording is attempted (reason
  // "recorder-recorded", not "recorder-repo-root-unresolved") even though
  // repoRoot itself never resolves.
  const isolatedDir = makeTempDir("rule-load-f1-recorder-bash-");
  const diagFile = path.join(isolatedDir, "recorder-diag.jsonl");
  const stateDir = path.join(isolatedDir, "state");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  const prevStateDir = process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  // Isolate the ledger write target — recordSessionRuleLoads unconditionally
  // writeState()s once it gets past the refs.length===0 short-circuit, so
  // without this the real repo's default state dir would be touched.
  process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR = stateDir;
  const cmd = "cat .devpro/agent-rules/some-rule.md";
  let returnValue;
  try {
    returnValue = recordRuleLoadLedgerState(
      cmd,
      isolatedDir,
      isolatedDir,
      {
        session_id: "f1-recorder-bash",
        tool_name: "Bash",
        tool_input: { command: cmd },
      }
    );
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
    if (prevStateDir === undefined) delete process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR;
    else process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR = prevStateDir;
  }
  assert.equal(returnValue, undefined, "recorder must stay fail-open — no return value is consumed by callers");
  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(
    entries[0].reason,
    "recorder-recorded",
    `expected extraction to succeed via the repoRoot-independent canonical shortcut, not be skipped by the repoRoot guard; got: ${JSON.stringify(entries[0])}`
  );
  assert.equal(entries[0].refs?.[0]?.relPath, "some-rule.md", "the canonical-prefixed ref must be the one extracted");
});

test("Scenario: Backslash Rule Path Enters Host Diagnostic Flow", () => {
  const isolatedDir = makeTempDir("rule-load-d13-backslash-");
  const diagFile = path.join(isolatedDir, "backslash-diag.jsonl");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  const filePath = "C:\\checkout\\.devpro\\agent-rules\\some-rule.md";
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  try {
    const appended = appendRuleLoadHostDiagnostic({
      session_id: "d13-backslash-read",
      tool_name: "Read",
      tool_input: { file_path: filePath },
    }, { repoRoot: isolatedDir, refs: [] });
    assert.equal(appended, true, "native Windows rule path must enter the host-diagnostic flow");
    const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].candidate, true);
    assert.equal(entries[0].payload.tool_input.file_path, filePath);
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
  }
});

test("Scenario: Windows Metadata Path Under Agent Rules Is Not A Rule Diagnostic Candidate", () => {
  const isolatedDir = makeTempDir("rule-load-d13-metadata-");
  const diagFile = path.join(isolatedDir, "metadata-diag.jsonl");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  try {
    const appended = appendRuleLoadHostDiagnostic({
      session_id: "d13-metadata-read",
      tool_name: "Read",
      tool_input: { file_path: "C:\\checkout\\.devpro\\agent-rules\\metadata.json" },
    }, { repoRoot: isolatedDir, refs: [] });
    assert.equal(appended, false, "non-rule metadata beneath agent-rules must not enter the diagnostic flow");
    assert.equal(existsSync(diagFile), false, "non-rule metadata must not create a diagnostic record");
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
  }
});

test("T12: recordRuleLoadLedgerPayload writes recorder-repo-root-unresolved to the telemetry channel (not a user-facing advisory)", () => {
  const isolatedDir = makeTempDir("rule-load-t12-recorder-read-");
  const diagFile = path.join(isolatedDir, "recorder-diag.jsonl");
  const filePath = path.join(isolatedDir, ".devpro/agent-rules/some-rule.md");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  let returnValue;
  try {
    returnValue = recordRuleLoadLedgerPayload(
      { session_id: "t12-recorder-read", tool_name: "Read", tool_input: { file_path: filePath } },
      isolatedDir,
      isolatedDir
    );
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
  }
  assert.equal(returnValue, undefined);
  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(entries[0].reason, "recorder-repo-root-unresolved");
});

test("Scenario: Unrelated Windows Path Does Not Enter Rule Diagnostics", () => {
  const isolatedDir = makeTempDir("rule-load-d13-unrelated-");
  const diagFile = path.join(isolatedDir, "unrelated-diag.jsonl");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  try {
    recordRuleLoadLedgerPayload(
      { session_id: "d13-unrelated", tool_name: "Read", tool_input: { file_path: "C:\\checkout\\notes\\other.md" } },
      isolatedDir,
      isolatedDir,
    );
    assert.equal(existsSync(diagFile), false, "unrelated file path must not be a rule diagnostic candidate");
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
  }
});

test("F1 fix: recordRuleLoadLedgerPayload still records a canonical `.devpro/agent-rules/`-prefixed ref when repoRoot is unresolved (no longer silently skipped)", () => {
  // Payload-variant sibling of the recordRuleLoadLedgerState F1 fix test
  // above — same repoRoot-independent shortcut applies when a Read tool's
  // file_path is itself the relative canonical-prefixed form (not an
  // absolute filesystem path).
  const isolatedDir = makeTempDir("rule-load-f1-recorder-read-");
  const diagFile = path.join(isolatedDir, "recorder-diag.jsonl");
  const stateDir = path.join(isolatedDir, "state");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  const prevStateDir = process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR = stateDir;
  let returnValue;
  try {
    returnValue = recordRuleLoadLedgerPayload(
      {
        session_id: "f1-recorder-read",
        tool_name: "Read",
        tool_input: { file_path: ".devpro/agent-rules/some-rule.md" },
      },
      isolatedDir,
      isolatedDir
    );
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
    if (prevStateDir === undefined) delete process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR;
    else process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_DIR = prevStateDir;
  }
  assert.equal(returnValue, undefined, "recorder must stay fail-open — no return value is consumed by callers");
  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(
    entries[0].reason,
    "recorder-recorded",
    `expected extraction to succeed via the repoRoot-independent canonical shortcut, not be skipped by the repoRoot guard; got: ${JSON.stringify(entries[0])}`
  );
  assert.equal(entries[0].refs?.[0]?.relPath, "some-rule.md", "the canonical-prefixed ref must be the one extracted");
});

// ─────────────────────────────────────────────────────────────────────────
// round-1 dp-reviewer F2: dedicated assertions for the ledger family's
// `unexpected-error` (checkDuplicateRuleLoadLedger / …Payload — the shared
// NOT_CHECKED_REASONS taxonomy token, a user-facing advisory) and
// `recorder-unexpected-error` (recordRuleLoadLedgerState / …Payload — a
// separate diagnostic-only skippedReason, never user-facing). Everything
// inside these functions' try blocks is otherwise defensively wrapped
// (readState/gitRootForCwd/etc. all swallow their own errors internally),
// so each test below deliberately feeds a malformed argument shape that
// makes a DIFFERENT, un-guarded internal call throw — exercising the real
// catch-all fail-open branch rather than any mocked/stubbed behavior.
// ─────────────────────────────────────────────────────────────────────────

test("F2: checkDuplicateRuleLoadLedger surfaces unexpected-error when cmd is not a string", () => {
  // extractRuleLeafReadsFromBash calls `command.includes("|")` directly on
  // the raw `command` argument (no String() coercion) — a non-string cmd
  // throws a TypeError there, which this function's catch must convert into
  // the shared UNEXPECTED_ERROR taxonomy token rather than propagating.
  const result = checkDuplicateRuleLoadLedger(null, "/tmp", "/tmp", { session_id: "f2-check-bash-throw" });
  assert.ok(result?.advisory, `expected an advisory; got ${JSON.stringify(result)}`);
  assert.match(result.advisory, /reason=unexpected-error/);
});

test("F2: checkDuplicateRuleLoadLedgerPayload surfaces unexpected-error when payload is not an object", () => {
  // A null payload throws on the first property access (payload.tool_name
  // etc.) inside extractRuleLeafReadsFromPayload / readToolFilePath.
  const result = checkDuplicateRuleLoadLedgerPayload(null, "/tmp", "/tmp");
  assert.ok(result?.advisory, `expected an advisory; got ${JSON.stringify(result)}`);
  assert.match(result.advisory, /reason=unexpected-error/);
});

test("F2: recordRuleLoadLedgerState writes recorder-unexpected-error when the ledger state file cannot be created", () => {
  // Forces evaluateSessionRuleLoads's writeState() → mkdirSync(dirname) to
  // throw ENOTDIR by pointing DEVPRO_RULE_LOAD_LEDGER_STATE_FILE at a path
  // whose parent segment is a regular file, not a directory. This is an
  // unguarded fs call inside recordSessionRuleLoads (unlike readState, it
  // has no internal try/catch), so it propagates up to the recorder's own
  // catch — the real fail-open path, not a mock.
  const isolatedDir = makeTempDir("rule-load-f2-recorder-bash-throw-");
  const diagFile = path.join(isolatedDir, "recorder-diag.jsonl");
  const blockerFile = path.join(isolatedDir, "blocker-file");
  writeFileSync(blockerFile, "not a directory\n");
  const stateFile = path.join(blockerFile, "subdir", "ledger.json");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  const prevStateFile = process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE = stateFile;
  const cmd = "cat .devpro/agent-rules/some-rule.md";
  let returnValue;
  try {
    returnValue = recordRuleLoadLedgerState(cmd, isolatedDir, isolatedDir, {
      session_id: "f2-recorder-bash-throw",
      tool_name: "Bash",
      tool_input: { command: cmd },
    });
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
    if (prevStateFile === undefined) delete process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE;
    else process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE = prevStateFile;
  }
  assert.equal(returnValue, undefined, "recorder must stay fail-open — no return value is consumed by callers");
  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(entries[0].reason, "recorder-unexpected-error");
});

test("F2: recordRuleLoadLedgerPayload writes recorder-unexpected-error when the ledger state file cannot be created", () => {
  // Same technique as the Bash-variant sibling above, but the Read-tool path
  // requires repoRoot to genuinely resolve (a real git repo) AND the ref to
  // extract successfully, so the failure surfaces from recordSessionRuleLoads
  // itself rather than the earlier refs.length===0 / !repoRoot branches.
  // realpathSync is required on macOS: os.tmpdir() returns a path through
  // the `/var` → `/private/var` symlink, but `git rev-parse --show-toplevel`
  // (used internally to resolve repoRoot) returns the resolved form — an
  // unresolved isolatedDir here would make normalizeRuleLeafRef's
  // path.relative(ruleRoot, value) mismatch and silently classify the ref
  // as unresolvable instead of exercising the intended throw.
  const isolatedDir = realpathSync(makeTempDir("rule-load-f2-recorder-read-throw-"));
  spawnSync("git", ["init", "-q"], { cwd: isolatedDir, encoding: "utf8" });
  mkdirSync(path.join(isolatedDir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(isolatedDir, ".devpro/agent-rules/some-rule.md"), "content\n");
  const diagFile = path.join(isolatedDir, "recorder-diag.jsonl");
  const blockerFile = path.join(isolatedDir, "blocker-file");
  writeFileSync(blockerFile, "not a directory\n");
  const stateFile = path.join(blockerFile, "subdir", "ledger.json");
  const prevDiagFile = process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
  const prevStateFile = process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE;
  process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = diagFile;
  process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE = stateFile;
  const filePath = path.join(isolatedDir, ".devpro/agent-rules/some-rule.md");
  let returnValue;
  try {
    returnValue = recordRuleLoadLedgerPayload(
      { session_id: "f2-recorder-read-throw", tool_name: "Read", tool_input: { file_path: filePath } },
      isolatedDir,
      isolatedDir
    );
  } finally {
    if (prevDiagFile === undefined) delete process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE;
    else process.env.DEVPRO_RULE_LOAD_HOST_DIAG_FILE = prevDiagFile;
    if (prevStateFile === undefined) delete process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE;
    else process.env.DEVPRO_RULE_LOAD_LEDGER_STATE_FILE = prevStateFile;
  }
  assert.equal(returnValue, undefined, "recorder must stay fail-open — no return value is consumed by callers");
  const entries = readFileSync(diagFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "recorder");
  assert.equal(entries[0].reason, "recorder-unexpected-error");
});
