/**
 * Tests for hooks/lib/context-headroom-gate.mjs — Gate CH (task 9).
 *
 * Covers task 9 acceptance (i)-(iv):
 *   (i)   four paths (advisory / block / checkpoint-permitted / unavailable)
 *         independently tested, each producing a distinguishable result;
 *   (ii)  NFR-1 bytes-read-bound as PRIMARY evidence (two file sizes ->
 *         equal bytesRead), plus two F-5-6 regression tests (small file;
 *         exact-line-boundary read start);
 *   (iii) three independent change_name/session_id/baseline resolution
 *         tests (match; session_id-not-found; cwd-not-in-worktree);
 *   (iv)  change_name/baseline-unavailable -> >400K path is advisory-only
 *         (NOT block) even when session-pending.md/tasks.md both exist and
 *         grew — guards against regressing to the rejected round-2 design.
 *
 * See design.md D3/D8/D12 for the full rationale this file's tests encode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  TAIL_BYTES,
  CH_ADVISORY_THRESHOLD,
  CH_BLOCK_THRESHOLD,
  readBoundedTailCacheRead,
  resolveChangeNameFromWorktreeCwd,
  evaluateContextHeadroomGate,
  resolveContinuationCheckpointState,
  commandTargetsContextHeadroomGate,
  evaluateContextHeadroomGateFromCtx,
} from "../hooks/lib/context-headroom-gate.mjs";
import {
  appendChangeUsageSession,
  recordSessionChangeTransition,
} from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { captureTlHostSession } from "../lib/session-usage-manifest.mjs";
import { sessionRuleLoadIdentity } from "../hooks/lib/rule-load-session-ledger.mjs";

function withStateDir(fn) {
  const dir = makeTempDir("devpro-context-headroom-state-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function assistantRecord({ cacheRead, isSidechain = false, ts = "2026-01-01T00:00:00.000Z" }) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    isSidechain,
    message: {
      id: `m-${cacheRead}-${Math.random().toString(36).slice(2)}`,
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [],
      usage: {
        output_tokens: 10,
        input_tokens: 5,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function userRecord(ts = "2026-01-01T00:00:00.000Z") {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    cwd: "/repo",
    message: { id: "u1", role: "user", content: "hi" },
  });
}

function padLine(targetBytes) {
  // A structurally-valid, cheaply-skippable non-assistant JSONL line of an
  // EXACT target byte length (including its own trailing "\n"), used to pad
  // files to precise sizes for the boundary tests below. "x" is a single
  // ASCII byte with no JSON escaping, so byte length is perfectly linear in
  // pad length — one measure-and-correct step converges exactly.
  const build = (padLen) => JSON.stringify({ type: "cost-state", pad: "x".repeat(Math.max(0, padLen)) }) + "\n";
  let padLen = Math.max(0, targetBytes - 40);
  const actual = Buffer.byteLength(build(padLen), "utf8");
  padLen += targetBytes - actual;
  return build(Math.max(0, padLen));
}

// ── readBoundedTailCacheRead ────────────────────────────────────────────

test("readBoundedTailCacheRead: missing transcriptPath -> unavailable, bytesRead 0", () => {
  const result = readBoundedTailCacheRead({ transcriptPath: "" });
  assert.equal(result.state, "unavailable");
  assert.equal(result.bytesRead, 0);
});

test("readBoundedTailCacheRead: nonexistent file -> unavailable, bytesRead 0", () => {
  const result = readBoundedTailCacheRead({ transcriptPath: "/nonexistent/path/does-not-exist.jsonl" });
  assert.equal(result.state, "unavailable");
  assert.equal(result.bytesRead, 0);
});

test("readBoundedTailCacheRead: small file (< TAIL_BYTES) finds the last assistant record, no discard", () => {
  const dir = makeTempDir("ch-gate-small-");
  try {
    const file = path.join(dir, "transcript.jsonl");
    const lines = [userRecord(), assistantRecord({ cacheRead: 12345 })];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const result = readBoundedTailCacheRead({ transcriptPath: file });
    assert.equal(result.state, "ok");
    assert.equal(result.value, 12345);
    assert.ok(result.bytesRead > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTailCacheRead: NFR-1 bytesRead does not scale with total file size", () => {
  const dir = makeTempDir("ch-gate-nfr1-");
  try {
    const fileSmall = path.join(dir, "small.jsonl");
    const fileLarge = path.join(dir, "large.jsonl");
    const finalLine = assistantRecord({ cacheRead: 555000 });

    // "Small": a bit bigger than TAIL_BYTES so the bound actually engages.
    writeFileSync(fileSmall, padLine(TAIL_BYTES + 4096), "utf8");
    appendFileSync(fileSmall, finalLine + "\n", "utf8");

    // "Large": ~6x TAIL_BYTES of leading padding, same final record.
    writeFileSync(fileLarge, "", "utf8");
    for (let i = 0; i < 6; i += 1) {
      appendFileSync(fileLarge, padLine(TAIL_BYTES), "utf8");
    }
    appendFileSync(fileLarge, finalLine + "\n", "utf8");

    const small = readBoundedTailCacheRead({ transcriptPath: fileSmall });
    const large = readBoundedTailCacheRead({ transcriptPath: fileLarge });

    assert.equal(small.state, "ok");
    assert.equal(large.state, "ok");
    assert.equal(small.value, 555000);
    assert.equal(large.value, 555000);
    assert.equal(small.bytesRead, large.bytesRead, "bytesRead must be identical regardless of total file size");
    assert.ok(small.bytesRead <= TAIL_BYTES + 8, "bytesRead must stay within TAIL_BYTES + small fixed overhead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTailCacheRead: pathological case — no usable record inside tail window still bounds bytesRead (no full-scan fallback)", () => {
  const dir = makeTempDir("ch-gate-pathological-");
  try {
    const file = path.join(dir, "transcript.jsonl");
    // A record with NO message.usage.cache_read_input_tokens, repeated well
    // past TAIL_BYTES, so the only "record" ever seen in the tail window is
    // this valid-but-unusable shape — the reader must still return
    // unavailable WITHOUT having read anywhere near the full file.
    const uselessLine = JSON.stringify({ type: "assistant", message: { id: "x", role: "assistant" } }) + "\n";
    const totalTarget = TAIL_BYTES * 8;
    const repeats = Math.ceil(totalTarget / Buffer.byteLength(uselessLine, "utf8"));
    writeFileSync(file, uselessLine.repeat(repeats), "utf8");
    const result = readBoundedTailCacheRead({ transcriptPath: file });
    assert.equal(result.state, "unavailable");
    assert.ok(
      result.bytesRead <= TAIL_BYTES + 8,
      `bytesRead (${result.bytesRead}) must stay bounded even when nothing usable is found — a full-scan fallback would read ~${totalTarget} bytes`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTailCacheRead: F-5-6 regression — read start landing exactly on a line boundary keeps the first line", () => {
  const dir = makeTempDir("ch-gate-boundary-");
  try {
    const file = path.join(dir, "transcript.jsonl");

    // Precise construction: file = [prefix][alignedLine][finalLine], where
    // prefix is arbitrary (>=1 byte, ends in "\n") and byteLength(alignedLine)
    // + byteLength(finalLine) === TAIL_BYTES exactly. Then:
    //   size = byteLength(prefix) + TAIL_BYTES
    //   wantStart = size - TAIL_BYTES = byteLength(prefix)
    // i.e. wantStart lands exactly on alignedLine's first byte — the byte
    // immediately BEFORE it (at wantStart - 1) is prefix's own trailing "\n".
    // This deterministically exercises the "keep, do not discard" branch,
    // regardless of prefix's own length.
    const finalLine = assistantRecord({ cacheRead: 777777 }) + "\n";
    const finalLineBytes = Buffer.byteLength(finalLine, "utf8");
    const alignedLine = padLine(TAIL_BYTES - finalLineBytes);
    assert.equal(
      Buffer.byteLength(alignedLine, "utf8") + finalLineBytes,
      TAIL_BYTES,
      "test construction sanity: aligned + final must sum to exactly TAIL_BYTES",
    );

    const prefix = JSON.stringify({ type: "cost-state" }) + "\n";
    writeFileSync(file, prefix, "utf8");
    appendFileSync(file, alignedLine, "utf8");
    appendFileSync(file, finalLine, "utf8");

    const result = readBoundedTailCacheRead({ transcriptPath: file });
    assert.equal(result.state, "ok");
    assert.equal(result.value, 777777, "must resolve the newest (final) record's value");
    // The bound must still hold at this exact boundary: prefix must NOT have
    // been read (bytesRead stays at TAIL_BYTES + the 1-byte peek, not
    // TAIL_BYTES + byteLength(prefix)).
    assert.ok(result.bytesRead <= TAIL_BYTES + 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTailCacheRead: mid-line split discards the truncated leading line, finds the real record", () => {
  const dir = makeTempDir("ch-gate-midline-");
  try {
    const file = path.join(dir, "transcript.jsonl");
    writeFileSync(file, "", "utf8");
    for (let i = 0; i < 4; i += 1) appendFileSync(file, padLine(TAIL_BYTES / 2), "utf8");
    appendFileSync(file, assistantRecord({ cacheRead: 42424 }) + "\n", "utf8");
    const result = readBoundedTailCacheRead({ transcriptPath: file });
    assert.equal(result.state, "ok");
    assert.equal(result.value, 42424);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTailCacheRead: trailing non-assistant record does not shadow the last assistant record", () => {
  const dir = makeTempDir("ch-gate-nonassistant-");
  try {
    const file = path.join(dir, "transcript.jsonl");
    const lines = [
      assistantRecord({ cacheRead: 9999 }),
      JSON.stringify({ type: "cost-state", totalCostUSD: 1.23, modelUsage: {} }),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const result = readBoundedTailCacheRead({ transcriptPath: file });
    assert.equal(result.state, "ok");
    assert.equal(result.value, 9999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTailCacheRead: trailing isSidechain:true assistant record is skipped in favor of the last main-session record", () => {
  const dir = makeTempDir("ch-gate-sidechain-");
  try {
    const file = path.join(dir, "transcript.jsonl");
    const lines = [
      assistantRecord({ cacheRead: 55555, isSidechain: false }),
      assistantRecord({ cacheRead: 1, isSidechain: true }),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const result = readBoundedTailCacheRead({ transcriptPath: file });
    assert.equal(result.state, "ok");
    assert.equal(result.value, 55555, "must not report a sidechain/subagent record's cache_read as this session's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveChangeNameFromWorktreeCwd ────────────────────────────────────

test("resolveChangeNameFromWorktreeCwd: cwd under .worktree/<name>/ resolves <name>", () => {
  assert.equal(
    resolveChangeNameFromWorktreeCwd("/Users/x/repo/.worktree/add-change-cost-circuit-breaker/sub/dir"),
    "add-change-cost-circuit-breaker",
  );
});

test("resolveChangeNameFromWorktreeCwd: cwd exactly at .worktree/<name> (no trailing content) resolves <name>", () => {
  assert.equal(resolveChangeNameFromWorktreeCwd("/Users/x/repo/.worktree/my-change"), "my-change");
});

test("resolveChangeNameFromWorktreeCwd: cwd not under any .worktree/ returns null", () => {
  assert.equal(resolveChangeNameFromWorktreeCwd("/Users/x/repo/main-checkout"), null);
  assert.equal(resolveChangeNameFromWorktreeCwd(""), null);
  assert.equal(resolveChangeNameFromWorktreeCwd(undefined), null);
});

// ── evaluateContextHeadroomGate (pure decision function) ────────────────

test("evaluateContextHeadroomGate: unavailable cacheReadValue -> unavailable", () => {
  assert.equal(evaluateContextHeadroomGate({ cacheReadValue: null }).state, "unavailable");
  assert.equal(evaluateContextHeadroomGate({ cacheReadValue: undefined }).state, "unavailable");
  assert.equal(evaluateContextHeadroomGate({ cacheReadValue: NaN }).state, "unavailable");
});

test("evaluateContextHeadroomGate: <=300K -> ok", () => {
  assert.equal(evaluateContextHeadroomGate({ cacheReadValue: 0 }).state, "ok");
  assert.equal(evaluateContextHeadroomGate({ cacheReadValue: CH_ADVISORY_THRESHOLD }).state, "ok");
});

test("evaluateContextHeadroomGate: 300K < value <= 400K -> advisory, not degraded", () => {
  const result = evaluateContextHeadroomGate({ cacheReadValue: CH_ADVISORY_THRESHOLD + 1 });
  assert.equal(result.state, "advisory");
  assert.ok(!result.degraded);
  const atUpper = evaluateContextHeadroomGate({ cacheReadValue: CH_BLOCK_THRESHOLD });
  assert.equal(atUpper.state, "advisory");
});

test("evaluateContextHeadroomGate: >400K + baseline unavailable -> advisory, degraded (same class as >300K advisory)", () => {
  const result = evaluateContextHeadroomGate({
    cacheReadValue: CH_BLOCK_THRESHOLD + 1,
    continuationCheckpointAvailable: false,
  });
  assert.equal(result.state, "advisory");
  assert.equal(result.degraded, true);
});

test("evaluateContextHeadroomGate: >400K + baseline available + continuation checkpoint present -> ok (permitted)", () => {
  const result = evaluateContextHeadroomGate({
    cacheReadValue: CH_BLOCK_THRESHOLD + 12345,
    continuationCheckpointAvailable: true,
    hasContinuationCheckpoint: true,
  });
  assert.equal(result.state, "ok");
  assert.equal(result.continuationCheckpoint, true);
});

test("evaluateContextHeadroomGate: >400K + baseline available + no continuation checkpoint -> block", () => {
  const result = evaluateContextHeadroomGate({
    cacheReadValue: CH_BLOCK_THRESHOLD + 1,
    continuationCheckpointAvailable: true,
    hasContinuationCheckpoint: false,
  });
  assert.equal(result.state, "block");
});

// ── resolveContinuationCheckpointState (D8 + D12 F-3-1/F-3-2) ───────────

test("resolveContinuationCheckpointState: matching session_id + tasks.md growth -> available, hasContinuationCheckpoint", () => {
  withStateDir(() => {
    const cwd = makeTempDir("ch-gate-cwd-match-");
    try {
      const changeName = "add-change-cost-circuit-breaker";
      appendChangeUsageSession({
        cwd,
        changeName,
        session_id: "session-match",
        start_ts: "2026-01-01T00:00:00.000Z",
        host: "claude-code",
        session_pending_line_count_at_start: 5,
        tasks_line_count_at_start: 10,
      });
      const tasksDir = path.join(cwd, "openspec", "changes", changeName);
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(path.join(tasksDir, "tasks.md"), Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"), "utf8");

      const checkpoint = { status: "ok", sessions: [{ session_id: "session-match", session_pending_line_count_at_start: 5, tasks_line_count_at_start: 10 }] };
      const result = resolveContinuationCheckpointState({ cwd, sessionId: "session-match", changeName, checkpoint });
      assert.equal(result.available, true);
      assert.equal(result.hasContinuationCheckpoint, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// F-1a4e77b0 (round 2): write side (captureTlHostSession, UUID-shape
// validated) and read side (sessionRuleLoadIdentity, no shape validation)
// derive session_id independently. resolveContinuationCheckpointState
// requires exact string equality between them. This test feeds an actual
// captureTlHostSession-produced id into a sessionRuleLoadIdentity-consumed
// hook payload to prove the real write->read round trip agrees, instead of
// each side only ever being tested against its own hand-authored fixture
// string.
test("resolveContinuationCheckpointState: captureTlHostSession write-side id round-trips through sessionRuleLoadIdentity read-side payload", () => {
  withStateDir(() => {
    const cwd = makeTempDir("ch-gate-cwd-roundtrip-");
    try {
      const changeName = "add-change-cost-circuit-breaker";
      const writeSideEntry = captureTlHostSession({
        CLAUDE_CODE_SESSION_ID: "b38240ba-dd7d-4cd2-8748-2845797dc0c3",
      });
      assert.equal(writeSideEntry.host, "claude-code");

      appendChangeUsageSession({
        cwd,
        changeName,
        session_id: writeSideEntry.session_id,
        start_ts: "2026-01-01T00:00:00.000Z",
        host: writeSideEntry.host,
        session_pending_line_count_at_start: 0,
        tasks_line_count_at_start: 0,
      });

      // Shape of the real Claude Code PreToolUse hook JSON stdin payload
      // (see design.md D12: "Claude Code 標準 hook 輸入契約既有欄位").
      const hookPayload = { session_id: writeSideEntry.session_id };
      const readSideSessionId = sessionRuleLoadIdentity(hookPayload);
      assert.equal(readSideSessionId, writeSideEntry.session_id);

      const tasksDir = path.join(cwd, "openspec", "changes", changeName);
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(path.join(tasksDir, "tasks.md"), "line 0\nline 1\n", "utf8");

      const checkpoint = {
        status: "ok",
        sessions: [{ session_id: writeSideEntry.session_id, session_pending_line_count_at_start: 0, tasks_line_count_at_start: 0 }],
      };
      const result = resolveContinuationCheckpointState({ cwd, sessionId: readSideSessionId, changeName, checkpoint });
      assert.equal(result.available, true);
      assert.equal(result.hasContinuationCheckpoint, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("resolveContinuationCheckpointState: session_id not found in checkpoint sessions[] -> unavailable", () => {
  const cwd = makeTempDir("ch-gate-cwd-nomatch-");
  try {
    const checkpoint = { status: "ok", sessions: [{ session_id: "some-other-session", session_pending_line_count_at_start: 0, tasks_line_count_at_start: 0 }] };
    const result = resolveContinuationCheckpointState({
      cwd,
      sessionId: "session-not-present",
      changeName: "add-change-cost-circuit-breaker",
      checkpoint,
    });
    assert.equal(result.available, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveContinuationCheckpointState: no changeName -> unavailable", () => {
  const result = resolveContinuationCheckpointState({
    cwd: "/whatever",
    sessionId: "session-a",
    changeName: null,
    checkpoint: { status: "ok", sessions: [] },
  });
  assert.equal(result.available, false);
});

test("resolveContinuationCheckpointState: checkpoint status unavailable -> unavailable", () => {
  const result = resolveContinuationCheckpointState({
    cwd: "/whatever",
    sessionId: "session-a",
    changeName: "some-change",
    checkpoint: { status: "unavailable" },
  });
  assert.equal(result.available, false);
});

test("resolveContinuationCheckpointState: no growth in either file -> available but hasContinuationCheckpoint false", () => {
  const cwd = makeTempDir("ch-gate-cwd-nogrowth-");
  try {
    const changeName = "add-change-cost-circuit-breaker";
    const tasksDir = path.join(cwd, "openspec", "changes", changeName);
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(path.join(tasksDir, "tasks.md"), "line 1\nline 2", "utf8");
    const checkpoint = {
      status: "ok",
      sessions: [{ session_id: "s1", session_pending_line_count_at_start: 0, tasks_line_count_at_start: 2 }],
    };
    const result = resolveContinuationCheckpointState({ cwd, sessionId: "s1", changeName, checkpoint });
    assert.equal(result.available, true);
    assert.equal(result.hasContinuationCheckpoint, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── commandTargetsContextHeadroomGate ────────────────────────────────────

test("commandTargetsContextHeadroomGate: matches render-second-review-packet.mjs invocation", () => {
  assert.ok(commandTargetsContextHeadroomGate("node .devpro/scripts/render-second-review-packet.mjs handoff.json"));
});

test("commandTargetsContextHeadroomGate: matches run-test-suite.mjs invocation", () => {
  assert.ok(commandTargetsContextHeadroomGate("node .devpro/scripts/run-test-suite.mjs --changed main"));
});

test("commandTargetsContextHeadroomGate: does not match unrelated command", () => {
  assert.ok(!commandTargetsContextHeadroomGate("git status --porcelain"));
});

// F-3b8e05c4 (round 2): live false positives — a heredoc mentioning a target
// script's name, and a read-only `git diff -- <path>` whose path argument
// happens to end in a target basename. Neither invokes the script.
test("commandTargetsContextHeadroomGate: does not match a heredoc that merely mentions a target script name", () => {
  const cmd = "cat <<'EOF'\nremember to run run-test-suite.mjs later\nEOF";
  assert.ok(!commandTargetsContextHeadroomGate(cmd));
});

test("commandTargetsContextHeadroomGate: does not match a git diff whose path argument ends in a target basename", () => {
  assert.ok(!commandTargetsContextHeadroomGate("git diff -- .devpro/scripts/run-test-suite.mjs"));
});

test("commandTargetsContextHeadroomGate: matches a piped node invocation (statement after a leading command)", () => {
  assert.ok(commandTargetsContextHeadroomGate("echo start && node .devpro/scripts/run-test-suite.mjs --changed main"));
});

// ── evaluateContextHeadroomGateFromCtx (full runner) ─────────────────────

function writeTranscriptWithCacheRead(dir, cacheRead) {
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, assistantRecord({ cacheRead }) + "\n", "utf8");
  return file;
}

test("evaluateContextHeadroomGateFromCtx: non-matching command -> null without touching transcript", () => {
  const result = evaluateContextHeadroomGateFromCtx({
    cmd: "git status",
    effectiveCwd: "/repo/.worktree/some-change",
    payload: { transcript_path: "/nonexistent.jsonl", session_id: "s1" },
  });
  assert.equal(result, null);
});

test("evaluateContextHeadroomGateFromCtx: matching command + <=300K -> null (silent pass)", () => {
  withStateDir(() => {
    const dir = makeTempDir("ch-gate-ctx-ok-");
    try {
      const transcriptPath = writeTranscriptWithCacheRead(dir, 100000);
      const result = evaluateContextHeadroomGateFromCtx({
        cmd: "node .devpro/scripts/run-test-suite.mjs --changed main",
        effectiveCwd: path.join(dir, ".worktree", "add-change-cost-circuit-breaker"),
        payload: { transcript_path: transcriptPath, session_id: "s1" },
      });
      assert.equal(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("evaluateContextHeadroomGateFromCtx: matching command + unavailable transcript -> null", () => {
  const result = evaluateContextHeadroomGateFromCtx({
    cmd: "node .devpro/scripts/run-test-suite.mjs --changed main",
    effectiveCwd: "/repo/.worktree/add-change-cost-circuit-breaker",
    payload: { transcript_path: "/nonexistent.jsonl", session_id: "s1" },
  });
  assert.equal(result, null);
});

test("evaluateContextHeadroomGateFromCtx: 300K-400K -> advisory result with 'Gate CH' in text", () => {
  withStateDir(() => {
    const dir = makeTempDir("ch-gate-ctx-advisory-");
    try {
      const transcriptPath = writeTranscriptWithCacheRead(dir, 350000);
      const result = evaluateContextHeadroomGateFromCtx({
        cmd: "node .devpro/scripts/run-test-suite.mjs --changed main",
        effectiveCwd: path.join(dir, ".worktree", "add-change-cost-circuit-breaker"),
        payload: { transcript_path: transcriptPath, session_id: "s1" },
      });
      assert.ok(result);
      assert.ok(!result.block);
      assert.ok(result.advisory.includes("Gate CH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("evaluateContextHeadroomGateFromCtx (task 9-iv): >400K + cwd not under .worktree/ -> advisory only, even with real growing session-pending/tasks -- NOT block", () => {
  withStateDir(() => {
    const dir = makeTempDir("ch-gate-ctx-degraded-");
    try {
      const transcriptPath = writeTranscriptWithCacheRead(dir, 500000);
      // Real, non-empty, GROWING session-pending.md + tasks.md exist — but
      // cwd is deliberately NOT under any .worktree/<name>/, so change_name
      // cannot resolve. This must NOT be treated as a bypassable "files
      // exist" fallback (F-3-2's whole point) — it must still degrade to
      // advisory, never block.
      const mainRoot = path.join(dir, "main-checkout");
      mkdirSync(path.join(mainRoot, "notes"), { recursive: true });
      writeFileSync(path.join(mainRoot, "notes", "session-pending.md"), "- item 1\n- item 2\n- item 3\n", "utf8");
      const result = evaluateContextHeadroomGateFromCtx({
        cmd: "node .devpro/scripts/run-test-suite.mjs --changed main",
        effectiveCwd: mainRoot,
        payload: { transcript_path: transcriptPath, session_id: "s1" },
      });
      assert.ok(result);
      assert.ok(!result.block, "must not block when change_name/baseline is unavailable");
      assert.ok(result.advisory.includes("Gate CH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("evaluateContextHeadroomGateFromCtx: >400K + baseline available + no continuation checkpoint -> block", () => {
  withStateDir(() => {
    const dir = makeTempDir("ch-gate-ctx-block-");
    try {
      const changeName = "add-change-cost-circuit-breaker";
      const worktreeCwd = path.join(dir, ".worktree", changeName);
      mkdirSync(worktreeCwd, { recursive: true });
      const transcriptPath = writeTranscriptWithCacheRead(dir, 450000);
      appendChangeUsageSession({
        cwd: worktreeCwd,
        changeName,
        session_id: "session-block",
        start_ts: "2026-01-01T00:00:00.000Z",
        host: "claude-code",
        session_pending_line_count_at_start: 0,
        tasks_line_count_at_start: 0,
      });
      recordSessionChangeTransition({ session_id: "session-block", change_name: changeName, at: "2026-01-01T00:00:00.000Z" });
      // No growth: neither notes/session-pending.md nor tasks.md exist/changed.
      const result = evaluateContextHeadroomGateFromCtx({
        cmd: "node .devpro/scripts/render-second-review-packet.mjs handoff.json",
        effectiveCwd: worktreeCwd,
        payload: { transcript_path: transcriptPath, session_id: "session-block" },
      });
      assert.ok(result);
      assert.equal(result.block, true);
      assert.ok(result.reason.includes("Gate CH"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("evaluateContextHeadroomGateFromCtx: >400K + baseline available + continuation checkpoint written -> null (permitted, silent)", () => {
  withStateDir(() => {
    const dir = makeTempDir("ch-gate-ctx-permitted-");
    try {
      const changeName = "add-change-cost-circuit-breaker";
      const worktreeCwd = path.join(dir, ".worktree", changeName);
      mkdirSync(worktreeCwd, { recursive: true });
      const transcriptPath = writeTranscriptWithCacheRead(dir, 450000);
      appendChangeUsageSession({
        cwd: worktreeCwd,
        changeName,
        session_id: "session-permitted",
        start_ts: "2026-01-01T00:00:00.000Z",
        host: "claude-code",
        session_pending_line_count_at_start: 0,
        tasks_line_count_at_start: 0,
      });
      recordSessionChangeTransition({ session_id: "session-permitted", change_name: changeName, at: "2026-01-01T00:00:00.000Z" });
      const tasksDir = path.join(worktreeCwd, "openspec", "changes", changeName);
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(path.join(tasksDir, "tasks.md"), "line 1\nline 2\n", "utf8");
      const result = evaluateContextHeadroomGateFromCtx({
        cmd: "node .devpro/scripts/render-second-review-packet.mjs handoff.json",
        effectiveCwd: worktreeCwd,
        payload: { transcript_path: transcriptPath, session_id: "session-permitted" },
      });
      assert.equal(result, null, "continuation checkpoint written -> silent pass, no repeated nagging");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
