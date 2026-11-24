import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createOpenCodeEventCollector,
  defaultRunExport,
  verifyOpenCodeSessionEvidence,
} from "../lib/opencode-session-evidence.mjs";
import { buildOpenCodeContext } from "./lib/opencode-context-fixture.mjs";

// The v2 fixtures are real local smoke captures; their prompt is the fixed STDIN_OK input.
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode");
const readFixture = (name) => readFileSync(path.join(fixtureDir, name), "utf8");
const INPUT = Buffer.from("Reply with the single token STDIN_OK.\n", "utf8");
const SESSION_ID = "ses_eb5000658ffeEpZCzkI0yl09SK";

function events(text = readFixture("v2-run-events.ndjson")) {
  const collector = createOpenCodeEventCollector();
  for (const line of text.split("\n")) if (line.trim() !== "") collector.add(line);
  return collector.snapshot();
}

function exportRunner(mutate) {
  const exported = JSON.parse(readFixture("v2-session-export.json"));
  for (const message of exported.messages) if (message.model) message.model.variant = "max";
  mutate?.(exported);
  const calls = [];
  const runExport = (request) => {
    calls.push(request);
    return { status: 0, stdout: JSON.stringify(exported), error_code: null };
  };
  return { runExport, calls };
}

function verify(overrides = {}, mutateExport) {
  const { runExport, calls } = exportRunner(mutateExport);
  const oc = overrides.oc ?? buildOpenCodeContext().reviewer_opencode;
  const result = verifyOpenCodeSessionEvidence({
    oc,
    executable: "/usr/bin/opencode",
    env: { OPENCODE_CONFIG: oc.launch_config_path },
    cwd: "/tmp/neutral",
    packetBytes: INPUT,
    events: events(),
    runExport,
    ...overrides,
  });
  return { result, calls };
}

test("export evidence rejects a missing or downgraded effort on any assistant turn", () => {
  for (const variant of [undefined, "default", "high", "xhigh"]) {
    const { result } = verify({}, exported => {
      for (const message of exported.messages) if (message.type === "assistant") message.model.variant = variant;
    });
    assert.equal(result.status, "failed");
    assert.equal(result.classification, "opencode_effort_provenance_mismatch");
  }
});

test("verified: the export of the dispatched session proves model, bytes and completion", () => {
  const { result, calls } = verify();
  assert.equal(result.status, "verified");
  assert.equal(result.session_id, SESSION_ID);
  assert.equal(result.report_text, "STDIN_OK");
  assert.deepEqual(result.observed, {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    selector: "deepseek/deepseek-v4-pro",
    variant: "max",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["session", "export", "--standalone", SESSION_ID]);
  assert.equal(calls[0].cwd, "/tmp/neutral");
});

test("a different exported model is a failure that still records what was observed", () => {
  const { result } = verify({}, (exported) => {
    exported.messages[1].model.id = "deepseek-v4-flash";
  });
  assert.equal(result.status, "failed");
  assert.equal(result.classification, "opencode_model_provenance_mismatch");
  assert.equal(result.observed.selector, "deepseek/deepseek-v4-flash");
  assert.equal(result.report_text, null);
});

test("an observed pair that cannot form a legal selector is reported without a selector", () => {
  const { result } = verify({}, (exported) => {
    exported.messages[1].model.providerID = "deep/seek";
  });
  assert.equal(result.classification, "opencode_model_provenance_mismatch");
  assert.equal(result.observed.providerID, "deep/seek");
  assert.equal(result.observed.selector, null);
});

test("input, report and terminal evidence are exact or the window fails", () => {
  assert.equal(
    verify({ packetBytes: Buffer.from("another packet\n") }).result.classification,
    "opencode_input_binding_mismatch"
  );
  assert.equal(
    verify({}, (exported) => { exported.messages[1].content[0].text = "STDIN_OK!"; }).result.classification,
    "opencode_report_mismatch"
  );
  assert.equal(
    verify({}, (exported) => { exported.messages[1].finish = "length"; }).result.classification,
    "opencode_terminal_evidence_missing"
  );
  assert.equal(
    verify({}, (exported) => { exported.info.id = "ses_other"; }).result.classification,
    "opencode_session_binding_mismatch"
  );
});

test("events: an error event, two sessions or an oversized stream fail before any export", () => {
  const errorEvent = JSON.stringify({ type: "error", sessionID: SESSION_ID, error: { type: "ApiError", message: "boom" } });
  const withError = verify({ events: events(`${readFixture("v2-run-events.ndjson")}\n${errorEvent}\n`) });
  assert.equal(withError.result.classification, "opencode_run_failed");
  assert.equal(withError.calls.length, 0);

  const twoSessions = verify({
    events: events(`${readFixture("v2-run-events.ndjson")}\n${JSON.stringify({ type: "step_start", sessionID: "ses_second", part: {} })}\n`),
  });
  assert.equal(twoSessions.result.classification, "opencode_session_binding_mismatch");
  assert.equal(twoSessions.calls.length, 0);

  const collector = createOpenCodeEventCollector({ maxBytes: 64 });
  collector.add("x".repeat(40));
  collector.add("y".repeat(40));
  assert.deepEqual(collector.snapshot(), { text: "", overflowed: true });
  const overflowed = verify({ events: collector.snapshot() });
  assert.equal(overflowed.result.classification, "opencode_run_events_overflow");
  assert.equal(overflowed.calls.length, 0);
});

test("tool events void a no-tool review but are allowed under the pr-sticky policy", () => {
  const toolEvent = JSON.stringify({
    type: "tool_use",
    sessionID: SESSION_ID,
    part: { type: "tool", tool: "bash", state: { status: "completed" } },
  });
  const withTool = events(`${readFixture("v2-run-events.ndjson")}\n${toolEvent}\n`);

  const audit = verify({ events: withTool });
  assert.equal(audit.result.classification, "opencode_tool_surface_violation");
  assert.equal(audit.calls.length, 0);

  const sticky = verify({ oc: buildOpenCodeContext({ mode: "pr-sticky" }).reviewer_opencode, events: withTool });
  assert.equal(sticky.result.status, "verified");

  // pr-sticky still has a closed tool vocabulary: a name outside it voids the review.
  const stickyContext = buildOpenCodeContext({ mode: "pr-sticky" }).reviewer_opencode;
  for (const tool of ["write", "edit", "shell", "read"]) {
    const allowed = JSON.stringify({ type: "tool_use", sessionID: SESSION_ID, part: { type: "tool", tool, state: { status: "completed" } } });
    assert.equal(verify({ oc: stickyContext, events: events(`${readFixture("v2-run-events.ndjson")}\n${allowed}\n`) }).result.status, "verified", tool);
  }
  const outside = JSON.stringify({ type: "tool_use", sessionID: SESSION_ID, part: { type: "tool", tool: "webfetch", state: { status: "error" } } });
  const violation = verify({ oc: stickyContext, events: events(`${readFixture("v2-run-events.ndjson")}\n${outside}\n`) });
  assert.equal(violation.result.classification, "opencode_tool_surface_violation");
  assert.equal(violation.result.stage, "run");
  assert.equal(violation.calls.length, 0);
});

test("failed evidence names the stage that failed, so a never-attempted export is not called invalid", () => {
  const stages = [];
  const overflow = createOpenCodeEventCollector({ maxBytes: 8 });
  overflow.add("x".repeat(20));
  stages.push(["opencode_run_events_overflow", verify({ events: overflow.snapshot() }).result]);
  stages.push(["opencode_export_unavailable", verifyOpenCodeSessionEvidence({
    oc: buildOpenCodeContext().reviewer_opencode,
    executable: "/usr/bin/opencode",
    env: {},
    cwd: "/tmp/neutral",
    packetBytes: Buffer.from("x"),
    events: events(readFixture("v2-run-events.ndjson")),
    runExport: () => ({ status: 1, stdout: "", error_code: null }),
  })]);
  // #3624: an exporter that runs but prints no JSON produced no usable export, so the
  // window is attributed to the export stage as unavailable, not to invalid evidence.
  stages.push(["opencode_export_unavailable", verifyOpenCodeSessionEvidence({
    oc: buildOpenCodeContext().reviewer_opencode,
    executable: "/usr/bin/opencode",
    env: {},
    cwd: "/tmp/neutral",
    packetBytes: Buffer.from("x"),
    events: events(readFixture("v2-run-events.ndjson")),
    runExport: () => ({ status: 0, stdout: "not json", error_code: null }),
  })]);
  stages.push(["opencode_export_malformed", verifyOpenCodeSessionEvidence({
    oc: buildOpenCodeContext().reviewer_opencode,
    executable: "/usr/bin/opencode",
    env: {},
    cwd: "/tmp/neutral",
    packetBytes: Buffer.from("x"),
    events: events(readFixture("v2-run-events.ndjson")),
    runExport: () => ({ status: 0, stdout: JSON.stringify({ messages: [] }), error_code: null }),
  })]);
  assert.deepEqual(stages.map(([classification, result]) => [classification, result.classification, result.stage]), [
    ["opencode_run_events_overflow", "opencode_run_events_overflow", "run"],
    ["opencode_export_unavailable", "opencode_export_unavailable", "export"],
    ["opencode_export_unavailable", "opencode_export_unavailable", "export"],
    ["opencode_export_malformed", "opencode_export_malformed", "export"],
  ]);
});

test("an export that cannot be produced is unavailable evidence, never a pass", () => {
  for (const response of [
    { status: 1, stdout: "", error_code: null },
    { status: null, stdout: "", error_code: "ETIMEDOUT" },
  ]) {
    const result = verifyOpenCodeSessionEvidence({
      oc: buildOpenCodeContext().reviewer_opencode,
      executable: "/usr/bin/opencode",
      env: {},
      cwd: "/tmp/neutral",
      packetBytes: INPUT,
      events: events(),
      runExport: () => response,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.classification, "opencode_export_unavailable");
  }
  // #3624: an exit-0 exporter whose stdout carries no JSON is "no usable export"; the
  // window keeps a closed, attributable terminal instead of claiming invalid evidence.
  const notJson = verifyOpenCodeSessionEvidence({
    oc: buildOpenCodeContext().reviewer_opencode,
    executable: "/usr/bin/opencode",
    env: {},
    cwd: "/tmp/neutral",
    packetBytes: INPUT,
    events: events(),
    runExport: () => ({ status: 0, stdout: "not json", error_code: null }),
  });
  assert.equal(notJson.classification, "opencode_export_unavailable");
  assert.equal(notJson.stage, "export");
});

// #3624: some releases print a one-line banner before the exported JSON. The banner is
// CLI noise, not model evidence: the object behind it must still prove the whole session.
test("export: a one-line CLI banner ahead of the exported JSON still verifies", () => {
  const exported = JSON.parse(readFixture("v2-session-export.json"));
  for (const message of exported.messages) if (message.model) message.model.variant = "max";
  const banner = `Exporting session ${SESSION_ID} ...\n`;
  const result = verifyOpenCodeSessionEvidence({
    oc: buildOpenCodeContext().reviewer_opencode,
    executable: "/usr/bin/opencode",
    env: {},
    cwd: "/tmp/neutral",
    packetBytes: INPUT,
    events: events(),
    runExport: () => ({ status: 0, stdout: banner + JSON.stringify(exported), error_code: null }),
  });
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.equal(result.session_id, SESSION_ID);
  assert.equal(result.report_text, "STDIN_OK");
});

test("export: a banner does not excuse JSON that is still truncated", () => {
  const exported = JSON.parse(readFixture("v2-session-export.json"));
  const truncated = `Exporting session ${SESSION_ID} ...\n${JSON.stringify(exported).slice(0, 120)}`;
  const result = verifyOpenCodeSessionEvidence({
    oc: buildOpenCodeContext().reviewer_opencode,
    executable: "/usr/bin/opencode",
    env: {},
    cwd: "/tmp/neutral",
    packetBytes: INPUT,
    events: events(),
    runExport: () => ({ status: 0, stdout: truncated, error_code: null }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.classification, "opencode_export_unavailable");
});

test("export: an exporter that ignores SIGTERM is killed at the deadline instead of blocking past it", { skip: process.platform === "win32" && "SIGTERM is not deliverable on Windows" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-export-timeout-"));
  try {
    const pidFile = path.join(dir, "exporter.pid");
    // POSIX sh rather than node: the deadline is 500 ms, and a node child's cold start can take longer than that on a busy
    // machine, which kills it before it records its pid. The trap is installed before the pid is published (atomically, via mv).
    // Ignores SIGTERM and would only stop by itself after 4 s; a SIGKILL at the 500 ms deadline must end it first.
    const script = `trap '' TERM; echo $$ > "$1.tmp"; mv "$1.tmp" "$1"; i=0; while [ "$i" -lt 4 ]; do sleep 1; i=$((i + 1)); done`;
    const started = Date.now();
    const outcome = defaultRunExport({ executable: "/bin/sh", argv: ["-c", script, "sh", pidFile], env: process.env, cwd: dir, timeoutMs: 500 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2500, `the export must stop at its deadline, took ${elapsed} ms`);
    assert.equal(outcome.error_code, "ETIMEDOUT");
    assert.notEqual(outcome.status, 0);
    assert.ok(existsSync(pidFile), "the exporter did start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH", "no exporter process may survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("export: a descendant that inherited the exporter's pipes is gone once the call returns", { skip: process.platform === "win32" && "process groups are POSIX-only" }, async () => {
  // POSIX sh rather than node: two node cold starts (the exporter, then its descendant) can take longer than the 600 ms deadline
  // on a busy machine, so the pid would never be printed. The descendant (`sleep`) inherits the pipes like the node one did.
  // Both stop by themselves after 30 s, so a broken kill cannot leak them for good.
  const script = `trap '' TERM; sleep 30 & echo "pid:$!"; i=0; while [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done`;
  const outcome = defaultRunExport({ executable: "/bin/sh", argv: ["-c", script], env: process.env, cwd: tmpdir(), timeoutMs: 600 });
  assert.equal(outcome.error_code, "ETIMEDOUT");
  const descendant = Number(/pid:(\d+)/u.exec(outcome.stdout)?.[1]);
  try {
    assert.ok(descendant > 0, "the exporter started its descendant");
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(descendant, 0); await new Promise((resolve) => setTimeout(resolve, 25)); } catch { alive = false; }
    }
    assert.equal(alive, false, "no exporter descendant may survive");
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
  }
});
