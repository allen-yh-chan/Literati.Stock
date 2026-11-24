import { probeOpenCodeReviewerModel } from "./opencode-model-probe.mjs";
/**
 * opencode-primary-review.mjs
 *
 * Ordinary-primary execution of the shared OpenCode adapter: one read-only review (the
 * dp-reviewer duties) run through the same isolation, event policy and session-export proof
 * as the second-review runner. It deliberately mints NO second-review control-evidence
 * (dispatch / claim / terminal / model-record) and no sticky: its output is an unsealed CLI
 * report that the primary consumer reads, labelled as such, never relabeled as a runtime
 * agent admission.
 */

import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReviewGuaranteeAssessment } from "../review-guarantee-assessment.mjs";
import { readOpenCodeCliVersion } from "./opencode-launch.mjs";
import {
  OPENCODE_ALLOWED_TOOL_NAMES,
  OpenCodeReviewerError,
  composeOpenCodeLaunchConfig,
  openCodeAgentNameForPolicy,
  openCodeDisallowedToolUses,
  openCodeReviewerEnv,
  openCodeRunArgv,
  parseOpenCodeVersion,
  resolveOpenCodeReviewerSelection,
  serializeOpenCodeLaunchConfig,
  serializeOpenCodeModelSelector,
} from "./opencode-reviewer.mjs";
import { OPENCODE_EVENTS_MAX_BYTES, createOpenCodeEventCollector, verifyOpenCodeSessionEvidence } from "./opencode-session-evidence.mjs";
import {
  MAX_REVIEWER_OUTPUT_LINE_BYTES,
  createBoundedLineAccumulator,
  supportsProcessGroups,
  sweepProcessGroup,
  terminateProcessTree,
} from "./reviewer-process-guard.mjs";

export const OPENCODE_PRIMARY_TOOL_POLICY = "read-only";
export const OPENCODE_PRIMARY_TIMEOUT_MS = 30 * 60_000;
export const OPENCODE_PRIMARY_EXECUTOR = "opencode-cli";
// Past this much stdout the event collector would overflow and the proof would fail anyway, so the
// reviewer is stopped there instead of being allowed to keep writing.
export const OPENCODE_PRIMARY_MAX_STDOUT_BYTES = OPENCODE_EVENTS_MAX_BYTES;
// stderr is not judged, but what is kept of it is bounded all the same: without a cap a reviewer that keeps
// writing short lines would grow the raw sidecar until the hard timeout.
export const OPENCODE_PRIMARY_MAX_STDERR_BYTES = OPENCODE_EVENTS_MAX_BYTES;
// One raw stdout line of the OpenCode process, newline excluded. `--format json` writes one JSON event per line, and a
// `read` tool event carries the file content twice (state.output and state.metadata.content) at up to about twice
// OpenCode's own read cap: roughly 110 KB for ASCII text, 310 KB for 3-byte characters, 410 KB for 4-byte ones. A
// 108,328-byte event failed a real review at 64 KiB. stderr keeps MAX_REVIEWER_OUTPUT_LINE_BYTES and the second-review
// wrapper keeps its own bound; the total stdout cap above is unchanged.
export const OPENCODE_PRIMARY_MAX_STDOUT_LINE_BYTES = 512 * 1024;
const lineLimit = (stream) => (stream === "stdout" ? OPENCODE_PRIMARY_MAX_STDOUT_LINE_BYTES : MAX_REVIEWER_OUTPUT_LINE_BYTES);
// The raw sidecars of one run (same names as the second-review attempt directory): every chunk the reviewer wrote,
// as it arrived, before it is split into lines, bounded or judged.
export const OPENCODE_PRIMARY_SIDECAR_FILES = Object.freeze({ stdout: "reviewer-stdout.ndjson", stderr: "reviewer-stderr.log" });
// After a kill, how long to wait for the child's streams to close before settling without them.
export const OPENCODE_PRIMARY_KILL_SETTLE_MS = 5000;
// After the reviewer process exits, how long its stdout/stderr may stay open (a descendant holding
// them) before the group is swept and the streams are closed.
export const OPENCODE_PRIMARY_DRAIN_GRACE_MS = 1000;

const FINDING_LINE = /^\s*[-*]\s+\*\*\[(Critical|Important|Suggestion)\]\*\*.*?\[finding_id:([^\]\s]+)\]/u;
// A bullet that opens with a severity tag is a finding; without a finding_id it cannot be tracked or
// covered by the assessment, and counting it as nothing would let a Critical pass as a clean review.
const SEVERITY_BULLET = /^\s*[-*]\s+\*\*\[(Critical|Important|Suggestion)\]\*\*/u;
// The Security Review lines of the report template carry their severity unbracketed
// (`- SQL injection: **Critical**: ...`) and no finding_id; they still decide the verdict.
const SECURITY_SEVERITY_LINE = /^\s*[-*]\s+[^\n*]*?:\s*\*\*(Critical)\*\*/u;

function writeAllToFd(fd, chunk) {
  let offset = 0;
  while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
}

// Each run gets a directory of its own under `root`. mkdtemp creates it new and private (0700), so nothing in it can
// pre-exist: no earlier file whose permissions would be inherited, no symlink planted under a sidecar name to be
// followed and truncated, and a rerun never overwrites the evidence of the run before. The root itself may be anything
// (it is created private only when missing); `wx` keeps even a race inside the new directory from reusing a name.
function openSidecars(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(root, "run-"));
  const fds = {};
  try {
    for (const [stream, name] of Object.entries(OPENCODE_PRIMARY_SIDECAR_FILES)) fds[stream] = openSync(path.join(dir, name), "wx", 0o600);
  } catch (error) {
    for (const fd of Object.values(fds)) closeSync(fd);
    throw error;
  }
  return { dir, fds };
}

function result(status, classification, reason, extra = {}) {
  return {
    status,
    classification,
    reason,
    executor: OPENCODE_PRIMARY_EXECUTOR,
    sealed_admission: false,
    ...extra,
  };
}

function nonblank(value) {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

// The dp-reviewer report states one verdict under `## 總判定`; the verdict must agree with the
// findings the report itself lists (Critical -> blocked, Important only -> partial, else
// finished), so a prose PASS over a Critical finding cannot pass for a clean review.
export function readPrimaryReviewVerdict(reportText) {
  const text = String(reportText).replace(/\r\n/g, "\n");
  const headings = [...text.matchAll(/^## 總判定[^\n]*\n/gm)];
  if (headings.length !== 1) {
    return { ok: false, reason: "report requires exactly one 總判定 section" };
  }
  const section = text.slice(headings[0].index + headings[0][0].length).split(/^## /m)[0];
  const stated = [...section.matchAll(/\*\*(finished|blocked|partial)\*\*/g)].map((match) => match[1]);
  if (new Set(stated).size !== 1) {
    return { ok: false, reason: "總判定 must name exactly one of finished, blocked or partial" };
  }
  const findings = [];
  let unidentifiedCritical = false;
  for (const line of text.split("\n")) {
    const match = FINDING_LINE.exec(line);
    if (match) findings.push({ severity: match[1], finding_id: match[2] });
    else if (SEVERITY_BULLET.test(line)) return { ok: false, reason: "a finding line carries a severity tag but no [finding_id:...]" };
    else if (SECURITY_SEVERITY_LINE.test(line)) unidentifiedCritical = true;
  }
  const derived = unidentifiedCritical || findings.some((finding) => finding.severity === "Critical")
    ? "blocked"
    : findings.some((finding) => finding.severity === "Important") ? "partial" : "finished";
  if (derived !== stated[0]) {
    return { ok: false, reason: `總判定 ${stated[0]} contradicts the listed findings (${derived})` };
  }
  return { ok: true, verdict: stated[0], finding_ids: findings.map((finding) => finding.finding_id) };
}

// Runs the reviewer and always settles. The child is its own process-group leader on POSIX so one
// SIGKILL reaches every descendant; both pipes are read line by line under a bound (stdout 512 KiB per
// line and also under a total cap, stderr 64 KiB per line), because an unbounded buffer or a descendant
// that keeps the pipes open would otherwise defeat both the memory limit and the hard timeout.
function runReviewer({
  executable, argv, env, cwd, promptBytes, collector, toolPolicy, timeoutMs, spawnProcess,
  maxStdoutBytes, maxStderrBytes, killSettleMs, drainGraceMs, platform, sidecar, sidecarWriter, terminate,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(executable, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: supportsProcessGroups(platform) });
    } catch {
      resolve({ spawn_error: true });
      return;
    }
    let settling = false;
    let stopping = false;
    let violation = null;
    let timedOut = false;
    let overflow = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let sidecarFault = false;
    let terminationUnconfirmed = false;
    let exitInfo = null;
    let settleTimer = null;
    let drainTimer = null;
    let drainEpoch = 0;
    const destroyStreams = () => {
      for (const stream of [child.stdout, child.stderr]) {
        try { stream?.destroy(); } catch { /* already closed */ }
      }
    };
    const onParentSignal = (signal) => {
      // A detached reviewer no longer shares the terminal's process group; take it down with the wrapper.
      terminate(child, { platform });
      process.removeListener("SIGINT", onParentSignal);
      process.removeListener("SIGTERM", onParentSignal);
      process.kill(process.pid, signal);
    };
    const settle = async (value, { drained = false } = {}) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      clearTimeout(drainTimer);
      process.removeListener("SIGINT", onParentSignal);
      process.removeListener("SIGTERM", onParentSignal);
      // POSIX can prove the group is empty. Windows only has `taskkill /T`, so it cannot prove anything and reports
      // null (not verifiable) -- except when the wait for 'close' was given up on: the process had exited but its pipes
      // stayed open, which means a descendant still holds them. That is a survivor, not an unknown.
      let cleanupConfirmed = null;
      if (supportsProcessGroups(platform)) {
        try { cleanupConfirmed = await sweepProcessGroup(child, { platform }); } catch { cleanupConfirmed = false; }
      } else if (drained) {
        cleanupConfirmed = false;
      }
      // A tree kill that could not be confirmed (Windows taskkill stalled or missing) is not a clean ending.
      if (terminationUnconfirmed) cleanupConfirmed = false;
      destroyStreams();
      resolve({ violation, timed_out: timedOut, overflow, sidecar_fault: sidecarFault, cleanup_confirmed: cleanupConfirmed, ...value });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (terminate(child, { platform })?.unconfirmed === true) terminationUnconfirmed = true;
      destroyStreams();
      // 'close' normally follows at once; if a stream or the kill never completes, settle anyway.
      settleTimer = setTimeout(() => { settle({ code: null, signal: "SIGKILL" }); }, killSettleMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    process.once("SIGINT", onParentSignal);
    process.once("SIGTERM", onParentSignal);

    const observe = (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      collector.add(trimmed);
      let event = null;
      try { event = JSON.parse(trimmed); } catch { return; }
      if (event?.type !== "tool_use") return;
      const used = [{ tool: typeof event.part?.tool === "string" ? event.part.tool : "unknown" }];
      if (violation === null && openCodeDisallowedToolUses(toolPolicy, used).length > 0) {
        violation = used[0].tool;
        stop();
      }
    };
    const lineOverflow = (stream) => () => {
      if (overflow === null) overflow = { stream, kind: "line" };
      stop();
    };
    const stdoutLines = createBoundedLineAccumulator({ onLine: observe, onOverflow: lineOverflow("stdout"), maxBytes: lineLimit("stdout") });
    const stderrLines = createBoundedLineAccumulator({ onLine: () => {}, onOverflow: lineOverflow("stderr"), maxBytes: lineLimit("stderr") });

    // After the process has exited its output may still be in the pipe: every chunk that arrives restarts the
    // quiet period, and the wait ends one event-loop turn after it so a chunk that was already readable is
    // delivered before the streams are closed (timers run before I/O in a loop turn, so a loaded machine would
    // otherwise cut the stream short). A chunk can arrive after the timer fired but before that turn's check phase;
    // the epoch lets the already queued callback see that it has been superseded by the re-armed wait.
    const armDrain = () => {
      clearTimeout(drainTimer);
      const epoch = ++drainEpoch;
      drainTimer = setTimeout(() => {
        setImmediate(() => {
          if (settling || epoch !== drainEpoch) return;
          stdoutLines.end();
          settle(exitInfo, { drained: true });
        });
      }, drainGraceMs);
    };
    // The raw bytes are kept first: a line that is then refused as too long, or a stream that is then cut off, is
    // exactly the evidence someone will want. A sidecar that cannot be written ends the run (nothing is dropped quietly).
    const retain = (stream, chunk) => {
      if (sidecar === null) return true;
      try {
        sidecarWriter(sidecar[stream], chunk);
        return true;
      } catch {
        sidecarFault = true;
        stop();
        return false;
      }
    };
    child.stdout.on("data", (chunk) => {
      if (stopping) return;
      if (exitInfo !== null) armDrain();
      if (!retain("stdout", chunk)) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        if (overflow === null) overflow = { stream: "stdout", kind: "total" };
        stop();
        return;
      }
      stdoutLines.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stopping) return;
      if (exitInfo !== null) armDrain();
      if (!retain("stderr", chunk)) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        if (overflow === null) overflow = { stream: "stderr", kind: "total" };
        stop();
        return;
      }
      stderrLines.write(chunk);
    });
    child.on("error", () => { settle({ spawn_error: true }); });
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      // The process is gone but a descendant may still hold the pipes: let the streams drain until they have
      // been quiet for the grace period, then stop waiting for 'close' (settle sweeps the group and destroys them).
      armDrain();
    });
    child.on("close", (code, signal) => {
      stdoutLines.end();
      settle(exitInfo ?? { code, signal });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(promptBytes);
  });
}

export async function runOpenCodePrimaryReview({
  promptBytes,
  repoRoot,
  reviewedTarget,
  dispatchId,
  instructionFiles = [],
  env = process.env,
  executable = "opencode",
  tmpRoot = tmpdir(),
  timeoutMs = OPENCODE_PRIMARY_TIMEOUT_MS,
  maxStdoutBytes = OPENCODE_PRIMARY_MAX_STDOUT_BYTES,
  maxStderrBytes = OPENCODE_PRIMARY_MAX_STDERR_BYTES,
  sidecarRoot = null,
  sidecarWriter = writeAllToFd,
  terminate = terminateProcessTree,
  killSettleMs = OPENCODE_PRIMARY_KILL_SETTLE_MS,
  drainGraceMs = OPENCODE_PRIMARY_DRAIN_GRACE_MS,
  platform = process.platform,
  spawnProcess = spawn,
  versionOptions = {},
  modelProbeOptions = {},
  verifyOptions = {},
} = {}) {
  if (!Buffer.isBuffer(promptBytes) || promptBytes.length === 0
    || !path.isAbsolute(String(repoRoot ?? "")) || !nonblank(reviewedTarget) || !nonblank(dispatchId)) {
    return result("failed", "opencode_primary_input_invalid", "prompt bytes, absolute repo root, reviewed target and dispatch id are required");
  }
  if (!Array.isArray(instructionFiles) || instructionFiles.some((file) => typeof file !== "string" || !path.isAbsolute(file))) {
    return result("failed", "opencode_primary_input_invalid", "instruction files must be absolute paths");
  }
  if (sidecarRoot !== null && (typeof sidecarRoot !== "string" || !path.isAbsolute(sidecarRoot))) {
    return result("failed", "opencode_primary_input_invalid", "the sidecar root must be an absolute path");
  }
  let version;
  let selection;
  try {
    version = parseOpenCodeVersion(readOpenCodeCliVersion({ executable, env, ...versionOptions }));
    selection = resolveOpenCodeReviewerSelection(env, probeOpenCodeReviewerModel({ ...modelProbeOptions, env, requested: env.DEVPRO_SECOND_REVIEWER_MODEL_OPENCODE }));
  } catch (error) {
    if (error instanceof OpenCodeReviewerError) return result("failed", error.classification, error.message);
    throw error;
  }
  const workDir = mkdtempSync(path.join(tmpRoot, "devpro-opencode-primary-"));
  try {
    chmodSync(workDir, 0o700);
    const cwd = path.join(workDir, "cwd");
    mkdirSync(cwd, { mode: 0o700 });
    const launchConfigPath = path.join(workDir, "opencode-launch.json");
    let config;
    try {
      config = composeOpenCodeLaunchConfig({
        generation: version.generation,
        toolPolicy: OPENCODE_PRIMARY_TOOL_POLICY,
        instructionFiles,
        readableRoots: [repoRoot],
        cwd,
      });
    } catch (error) {
      // e.g. an OpenCode generation that cannot be launched read-only: a refusal, not a crash.
      if (error instanceof OpenCodeReviewerError) return result("failed", error.classification, error.message);
      throw error;
    }
    writeFileSync(launchConfigPath, serializeOpenCodeLaunchConfig(config), { mode: 0o600 });
    const reviewerEnv = openCodeReviewerEnv({ baseEnv: env, launchConfigPath, cwd });
    const collector = createOpenCodeEventCollector();
    const argv = openCodeRunArgv(version.generation, {
      agent: openCodeAgentNameForPolicy(OPENCODE_PRIMARY_TOOL_POLICY),
      selector: serializeOpenCodeModelSelector(selection),
      variant: selection.variant,
    });
    let sidecar = null;
    let sidecarDir = null;
    if (sidecarRoot !== null) {
      try {
        const opened = openSidecars(sidecarRoot);
        sidecar = opened.fds;
        sidecarDir = opened.dir;
      } catch {
        return result("failed", "opencode_primary_input_invalid", "the sidecar root cannot be used for the reviewer's raw output");
      }
    }
    let run;
    try {
      run = await runReviewer({
        executable, argv, env: reviewerEnv, cwd, promptBytes, collector,
        toolPolicy: OPENCODE_PRIMARY_TOOL_POLICY, timeoutMs, spawnProcess,
        maxStdoutBytes, maxStderrBytes, killSettleMs, drainGraceMs, platform, sidecar, sidecarWriter, terminate,
      });
    } finally {
      for (const fd of Object.values(sidecar ?? {})) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
    if (run.spawn_error) return result("failed", "opencode_cli_unavailable", "the OpenCode CLI could not be started");
    // Facts of this run for the caller (identity of the CLI, the raw event stream); added to every outcome from here on.
    const runFacts = {
      cli_version: version.version,
      events_text: collector.snapshot().text,
      cleanup_confirmed: run.cleanup_confirmed,
      ...(sidecarDir === null ? {} : { sidecar_dir: sidecarDir }),
    };
    if (run.violation !== null) {
      return result("failed", "opencode_tool_surface_violation", `tool ${JSON.stringify(run.violation)} is outside the read-only policy`, {
        expected_tools: [...OPENCODE_ALLOWED_TOOL_NAMES[OPENCODE_PRIMARY_TOOL_POLICY]],
        ...runFacts,
      });
    }
    if (run.overflow !== null) {
      const total = run.overflow.kind === "total";
      return result("failed", total ? "reviewer_output_total_overflow" : "reviewer_output_line_overflow",
        total ? `the reviewer wrote more ${run.overflow.stream} than the review allows`
          : `a ${run.overflow.stream} line exceeded ${lineLimit(run.overflow.stream)} bytes`, {
          stream: run.overflow.stream,
          // Same detail name the second-review runner records under this classification. The oversize bytes
          // themselves are not kept: a raw stderr or an unbounded line is exactly what must not be buffered.
          fault_reason: total ? "reviewer_output_total_too_large" : "reviewer_output_line_too_large",
          max_line_bytes: lineLimit(run.overflow.stream),
          ...runFacts,
        });
    }
    if (run.sidecar_fault) {
      return result("failed", "reviewer_sidecar_write_failed", "the reviewer's raw output could not be kept, so the run is not accepted", runFacts);
    }
    if (run.timed_out) return result("failed", "opencode_run_timeout", "the review exceeded its hard cap", runFacts);
    if (run.cleanup_confirmed === false) {
      return result("failed", "opencode_process_cleanup_unconfirmed", "a process of the reviewer's group survived its termination", runFacts);
    }
    if (run.code !== 0) return result("failed", "opencode_run_failed", "the OpenCode process did not exit cleanly", runFacts);
    const oc = { generation: version.generation, selection, tool_policy: OPENCODE_PRIMARY_TOOL_POLICY };
    const proof = verifyOpenCodeSessionEvidence({
      oc, executable, env: reviewerEnv, cwd, packetBytes: promptBytes, events: collector.snapshot(), ...verifyOptions,
    });
    if (proof.status !== "verified") {
      return result("failed", "reviewer_model_provenance_unverified", proof.reason, { adapter_classification: proof.classification, stage: proof.stage, ...runFacts });
    }
    const evidence = {
      session_id: proof.session_id,
      observed_selector: proof.observed.selector,
      provider_id: proof.observed.selector.slice(0, proof.observed.selector.indexOf("/")),
      model_id: proof.observed.selector.slice(proof.observed.selector.indexOf("/") + 1),
      report_text: proof.report_text,
      ...runFacts,
    };
    const verdict = readPrimaryReviewVerdict(proof.report_text);
    if (!verdict.ok) return result("failed", "primary_report_contract_invalid", verdict.reason, evidence);
    let assessment;
    try {
      assessment = readReviewGuaranteeAssessment(proof.report_text, { reviewedTarget, dispatchId, findingIds: verdict.finding_ids });
    } catch (error) {
      // A blocked review keeps its own classification even without a usable assessment.
      if (verdict.verdict !== "blocked") {
        return result("failed", "primary_assessment_invalid", String(error.message).replace(/^review_guarantee_assessment_invalid: /, ""), evidence);
      }
    }
    return result(verdict.verdict, "opencode_primary_review_completed", null, {
      ...evidence,
      verdict: verdict.verdict,
      finding_ids: verdict.finding_ids,
      guarantee_assessment: assessment ? { next_actions: assessment.next_actions, requires_tl_ruling: assessment.requires_tl_ruling, requires_clarification: assessment.requires_clarification } : null,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
