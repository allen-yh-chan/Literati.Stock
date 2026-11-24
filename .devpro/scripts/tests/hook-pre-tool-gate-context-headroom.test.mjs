/**
 * hook-pre-tool-gate-context-headroom.test.mjs
 *
 * Wiring-level tests for Gate CH (task 9) through the REAL pre-tool-gate.mjs
 * hook process (spawnSync) — proves the gate registered at the tail of
 * BASH_BLOCKING_GATES actually fires end-to-end for a genuine Bash-tool
 * PreToolUse payload. Pure-function coverage of the underlying D3/D8/D12
 * decision logic (including the NFR-1 bytes-bound and F-5-6 boundary
 * regressions) lives in context-headroom-gate.test.mjs; this file only
 * proves the wiring itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";
import {
  appendChangeUsageSession,
  recordSessionChangeTransition,
} from "../hooks/lib/change-usage-checkpoint.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs",
);

function runHook(payload, extraEnv = {}) {
  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-ch-gate-test-"),
      ...extraEnv,
    },
  });
  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // not JSON
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function assistantRecord(cacheRead) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-01T00:00:01.000Z",
    isSidechain: false,
    message: {
      id: "m1",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [],
      usage: {
        output_tokens: 5,
        input_tokens: 5,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function writeTranscript(dir, cacheRead) {
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, assistantRecord(cacheRead) + "\n", "utf8");
  return file;
}

function withChangeUsageStateDirSync(stateDir, fn) {
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = stateDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

test("Gate CH wiring: non-target Bash command never fires the gate", () => {
  const tmpDir = makeTempDir("ch-wire-nontarget-");
  try {
    const cmd = "git status --porcelain";
    const payload = { tool_name: "Bash", tool_input: { command: cmd, cwd: tmpDir } };
    const r = runHook(payload);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.ok(!advisoryText(r.json).includes("Gate CH"));
    assert.notEqual(r.json?.decision, "block");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Gate CH wiring: run-test-suite.mjs invocation with 300K-400K cache_read -> advisory, no block", () => {
  const tmpDir = makeTempDir("ch-wire-advisory-");
  const stateDir = makeTempDir("ch-wire-state-advisory-");
  try {
    const worktreeCwd = path.join(tmpDir, ".worktree", "add-change-cost-circuit-breaker");
    mkdirSync(worktreeCwd, { recursive: true });
    const transcriptPath = writeTranscript(tmpDir, 350000);
    const cmd = "node .devpro/scripts/run-test-suite.mjs --changed main";
    const payload = {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: worktreeCwd },
      transcript_path: transcriptPath,
      session_id: "wire-session-advisory",
    };
    const r = runHook(payload, { DEVPRO_CHANGE_USAGE_STATE_DIR: stateDir });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.notEqual(r.json?.decision, "block");
    assert.ok(
      advisoryText(r.json).includes("Gate CH"),
      `expected Gate CH advisory, got: ${JSON.stringify(r.json)}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Gate CH wiring: >400K cache_read + cwd not under .worktree/ -> advisory only, never block", () => {
  const tmpDir = makeTempDir("ch-wire-degraded-");
  const stateDir = makeTempDir("ch-wire-state-degraded-");
  try {
    const transcriptPath = writeTranscript(tmpDir, 500000);
    const cmd = "node .devpro/scripts/run-test-suite.mjs --changed main";
    const payload = {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: tmpDir },
      transcript_path: transcriptPath,
      session_id: "wire-session-degraded",
    };
    const r = runHook(payload, { DEVPRO_CHANGE_USAGE_STATE_DIR: stateDir });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.notEqual(r.json?.decision, "block", "unresolvable change_name/baseline must never block");
    assert.ok(advisoryText(r.json).includes("Gate CH"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Gate CH wiring: render-second-review-packet.mjs, >400K, real checkpoint, no continuation growth -> block", () => {
  const tmpDir = makeTempDir("ch-wire-block-");
  const stateDir = makeTempDir("ch-wire-state-block-");
  try {
    const changeName = "add-change-cost-circuit-breaker";
    const worktreeCwd = path.join(tmpDir, ".worktree", changeName);
    mkdirSync(worktreeCwd, { recursive: true });
    const transcriptPath = writeTranscript(tmpDir, 450000);

    withChangeUsageStateDirSync(stateDir, () => {
      appendChangeUsageSession({
        cwd: worktreeCwd,
        changeName,
        session_id: "wire-session-block",
        start_ts: "2026-01-01T00:00:00.000Z",
        host: "claude-code",
        session_pending_line_count_at_start: 0,
        tasks_line_count_at_start: 0,
      });
      recordSessionChangeTransition({
        session_id: "wire-session-block",
        change_name: changeName,
        at: "2026-01-01T00:00:00.000Z",
      });
    });

    const cmd = "node .devpro/scripts/render-second-review-packet.mjs handoff.json";
    const payload = {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: worktreeCwd },
      transcript_path: transcriptPath,
      session_id: "wire-session-block",
    };
    const r = runHook(payload, { DEVPRO_CHANGE_USAGE_STATE_DIR: stateDir });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.ok(r.json.reason.includes("Gate CH"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Gate CH wiring: >400K, real checkpoint, tasks.md grew since session start -> permitted, no block", () => {
  const tmpDir = makeTempDir("ch-wire-permitted-");
  const stateDir = makeTempDir("ch-wire-state-permitted-");
  try {
    const changeName = "add-change-cost-circuit-breaker";
    const worktreeCwd = path.join(tmpDir, ".worktree", changeName);
    mkdirSync(worktreeCwd, { recursive: true });
    const transcriptPath = writeTranscript(tmpDir, 450000);

    withChangeUsageStateDirSync(stateDir, () => {
      appendChangeUsageSession({
        cwd: worktreeCwd,
        changeName,
        session_id: "wire-session-permitted",
        start_ts: "2026-01-01T00:00:00.000Z",
        host: "claude-code",
        session_pending_line_count_at_start: 0,
        tasks_line_count_at_start: 0,
      });
      recordSessionChangeTransition({
        session_id: "wire-session-permitted",
        change_name: changeName,
        at: "2026-01-01T00:00:00.000Z",
      });
    });
    const tasksDir = path.join(worktreeCwd, "openspec", "changes", changeName);
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(path.join(tasksDir, "tasks.md"), "- [x] task 1\n- [ ] task 2\n", "utf8");

    const cmd = "node .devpro/scripts/render-second-review-packet.mjs handoff.json";
    const payload = {
      tool_name: "Bash",
      tool_input: { command: cmd, cwd: worktreeCwd },
      transcript_path: transcriptPath,
      session_id: "wire-session-permitted",
    };
    const r = runHook(payload, { DEVPRO_CHANGE_USAGE_STATE_DIR: stateDir });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.notEqual(r.json?.decision, "block");
    assert.ok(
      !advisoryText(r.json).includes("Gate CH"),
      "continuation checkpoint written -> silent pass, no repeated Gate CH nagging",
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
