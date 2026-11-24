/**
 * opencode-session-evidence.mjs
 *
 * Runner-side proof for an OpenCode review window. The reviewer's stdout is only an event
 * transport: it names the dispatched session, but the CLI name, flags, echoed text and the
 * events themselves are never model evidence. Identity, completion and the exact input and
 * report bytes are proven by exporting that one session after the reviewer process closed
 * and comparing the export to what the runner itself sent and read.
 */

import {
  OpenCodeReviewerError,
  dispatchedSessionIdFromEvents,
  evaluateOpenCodeSessionExport,
  openCodeDisallowedToolUses,
  openCodeExportArgv,
  parseOpenCodeRunEvents,
} from "./opencode-reviewer.mjs";
import { spawnSyncBounded } from "./reviewer-process-guard.mjs";

// Event lines kept in memory for one window. A review emits step, text and (pr-sticky) tool
// events; anything beyond this is not a plausible single review and fails closed instead of
// being truncated into a report that no longer matches the export.
export const OPENCODE_EVENTS_MAX_BYTES = 16 * 1024 * 1024;
export const OPENCODE_EXPORT_TIMEOUT_MS = 60000;
export const OPENCODE_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

export function createOpenCodeEventCollector({ maxBytes = OPENCODE_EVENTS_MAX_BYTES } = {}) {
  const lines = [];
  let bytes = 0;
  let overflowed = false;
  return {
    add(line) {
      if (overflowed) return;
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (bytes + lineBytes > maxBytes) {
        overflowed = true;
        lines.length = 0;
        return;
      }
      bytes += lineBytes;
      lines.push(line);
    },
    snapshot() {
      return { text: lines.join("\n"), overflowed };
    },
  };
}

// A timed-out exporter is killed with SIGKILL and its process group is swept afterwards (see
// spawnSyncBounded): the default SIGTERM can be ignored, and a descendant that inherited the pipes
// would otherwise outlive the call.
export function defaultRunExport({ executable, argv, env, cwd, timeoutMs }) {
  const result = spawnSyncBounded(executable, argv, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: OPENCODE_EXPORT_MAX_BYTES,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    error_code: result.error?.code ?? null,
  };
}

// `stage` mirrors the probe's command_summary.stage: "run" = the run itself or its events were
// unusable (no export was attempted), "export" = the export could not be produced or parsed,
// "validate" = a parsed export did not prove the dispatched facts.
function failed(classification, reason, observed = null, stage = "validate") {
  return { status: "failed", classification, reason, stage, observed, session_id: null, report_text: null };
}

// `oc` is the validated reviewer_opencode section. `events` is the collector snapshot of the
// window's stdout; `packetBytes` are the exact bytes the runner wrote to the reviewer's stdin.
export function verifyOpenCodeSessionEvidence({
  oc,
  executable,
  env,
  cwd,
  packetBytes,
  events,
  runExport = defaultRunExport,
  timeoutMs = OPENCODE_EXPORT_TIMEOUT_MS,
}) {
  if (!events || events.overflowed === true) {
    return failed("opencode_run_events_overflow", "run events exceeded the bounded in-memory window", null, "run");
  }
  if (!Buffer.isBuffer(packetBytes) || packetBytes.length === 0) {
    return failed("opencode_input_binding_mismatch", "the dispatched input bytes are unavailable", null, "run");
  }
  const parsed = parseOpenCodeRunEvents(events.text);
  if (parsed.errors.length > 0) {
    return failed("opencode_run_failed", "the run emitted an error event", null, "run");
  }
  if (openCodeDisallowedToolUses(oc.tool_policy, parsed.tool_uses).length > 0) {
    return failed("opencode_tool_surface_violation", "the review emitted a tool event outside its policy", null, "run");
  }
  let sessionId;
  try {
    sessionId = dispatchedSessionIdFromEvents(parsed);
  } catch (error) {
    if (error instanceof OpenCodeReviewerError) return failed(error.classification, error.message, null, "run");
    throw error;
  }
  const exported = runExport({
    executable,
    argv: openCodeExportArgv(oc.generation, sessionId),
    env,
    cwd,
    timeoutMs,
  });
  if (exported.error_code || exported.status !== 0) {
    return failed("opencode_export_unavailable", "the dispatched session could not be exported", null, "export");
  }
  const evidence = evaluateOpenCodeSessionExport({
    exportText: exported.stdout,
    generation: oc.generation,
    dispatchedSessionId: sessionId,
    selection: oc.selection,
    inputBytes: packetBytes,
    runFinalText: parsed.final_text,
  });
  if (!evidence.ok) {
    return failed(
      evidence.classification,
      evidence.reason,
      evidence.observed ?? null,
      // Both "no usable export" and "export present but its JSON is not the session schema"
      // are export-stage failures; "validate" stays for an export that was read and judged.
      ["opencode_export_malformed", "opencode_export_unavailable"].includes(evidence.classification)
        ? "export"
        : "validate",
    );
  }
  return {
    status: "verified",
    classification: null,
    reason: null,
    observed: evidence.observed,
    session_id: sessionId,
    report_text: evidence.report_text,
  };
}
