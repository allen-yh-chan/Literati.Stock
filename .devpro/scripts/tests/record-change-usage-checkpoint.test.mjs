import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  computeChangeUsageStartupSnapshot,
  runRecordChangeUsageCheckpoint,
} from "../record-change-usage-checkpoint.mjs";
import { readChangeUsageCheckpoint, readSessionChangeTransitions } from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../record-change-usage-checkpoint.mjs", import.meta.url));

// NOTE: `fn` may be async — MUST `await` it before restoring the env var in
// `finally`, otherwise the restore races ahead of `fn`'s first `await` and
// every write inside `fn` silently lands under the wrong (already-restored)
// state dir.
async function withStateDir(fn) {
  const dir = makeTempDir("devpro-record-change-usage-checkpoint-state-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

// `captureTlHostSession` -> `isValidSessionIdShape` requires a UUID-shaped
// value (session-token-usage.mjs UUID_SHAPE); plain test labels are rejected.
function claudeEnv(sessionId = randomUUID()) {
  return { ...process.env, CLAUDE_SESSION_ID: sessionId, CODEX_SESSION_ID: "", CODEX_THREAD_ID: "" };
}

// --- computeChangeUsageStartupSnapshot: line-count baselines (D8) ----------

test("computeChangeUsageStartupSnapshot defaults both counts to 0 when neither file exists", () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  const mainCheckoutRoot = makeTempDir("devpro-record-checkpoint-root-");
  const snapshot = computeChangeUsageStartupSnapshot({ cwd, changeName: "some-change", mainCheckoutRoot });
  assert.equal(snapshot.session_pending_line_count_at_start, 0);
  assert.equal(snapshot.tasks_line_count_at_start, 0);
});

test("computeChangeUsageStartupSnapshot counts lines of an existing session-pending.md and tasks.md", () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  const mainCheckoutRoot = makeTempDir("devpro-record-checkpoint-root-");
  mkdirSync(path.join(mainCheckoutRoot, "notes"), { recursive: true });
  writeFileSync(path.join(mainCheckoutRoot, "notes", "session-pending.md"), "line1\nline2\nline3\n");

  const changeName = "example-change";
  const tasksDir = path.join(cwd, "openspec", "changes", changeName);
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(path.join(tasksDir, "tasks.md"), "- [ ] task a\n- [ ] task b\n");

  const snapshot = computeChangeUsageStartupSnapshot({ cwd, changeName, mainCheckoutRoot });
  assert.equal(snapshot.session_pending_line_count_at_start, 3);
  assert.equal(snapshot.tasks_line_count_at_start, 2);
});

// --- runRecordChangeUsageCheckpoint: happy path -----------------------------

test("runRecordChangeUsageCheckpoint writes both the per-change checkpoint and the transition ledger on the happy path", async () => {
  await withStateDir(async () => {
    const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
    const mainCheckoutRoot = makeTempDir("devpro-record-checkpoint-root-");
    const changeName = "happy-path-change";
    const sessionId = randomUUID();

    const result = await runRecordChangeUsageCheckpoint({
      cwd,
      argv: ["--change", changeName],
      env: { CLAUDE_SESSION_ID: sessionId },
      now: () => "2026-09-01T00:00:00.000Z",
      mainCheckoutRoot,
    });

    assert.deepEqual(result.advisories, []);
    assert.equal(result.sessionCheckpoint.status, "written");
    assert.equal(result.transitionLedger.status, "written");

    const checkpoint = readChangeUsageCheckpoint({ cwd, changeName });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.sessions.length, 1);
    assert.equal(checkpoint.sessions[0].session_id, sessionId);
    assert.equal(checkpoint.sessions[0].host, "claude-code");
    assert.equal(checkpoint.sessions[0].start_ts, "2026-09-01T00:00:00.000Z");

    const transitions = readSessionChangeTransitions({ cwd, session_id: sessionId });
    assert.equal(transitions.status, "ok");
    assert.equal(transitions.records.length, 1);
    assert.equal(transitions.records[0].change_name, changeName);
    assert.equal(transitions.records[0].at, "2026-09-01T00:00:00.000Z");
  });
});

// --- write_failed advisory path (round 4 finding F-4-3) --------------------

test("runRecordChangeUsageCheckpoint prints an advisory and still succeeds (does not throw) when the per-change checkpoint write fails", async () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  const result = await runRecordChangeUsageCheckpoint({
    cwd,
    argv: ["--change", "some-change"],
    env: { CLAUDE_SESSION_ID: randomUUID() },
    now: () => "2026-09-01T00:00:00.000Z",
    appendSession: () => ({ status: "write_failed", reason: "simulated disk full" }),
    recordTransition: () => ({ status: "written" }),
  });

  assert.equal(result.advisories.length, 1);
  assert.match(result.advisories[0], /per-change usage checkpoint write failed/);
  assert.match(result.advisories[0], /simulated disk full/);
  assert.equal(result.sessionCheckpoint.status, "write_failed");
  assert.equal(result.transitionLedger.status, "written");
});

test("runRecordChangeUsageCheckpoint prints an advisory when only the transition ledger write fails", async () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  const result = await runRecordChangeUsageCheckpoint({
    cwd,
    argv: ["--change", "some-change"],
    env: { CLAUDE_SESSION_ID: randomUUID() },
    now: () => "2026-09-01T00:00:00.000Z",
    appendSession: () => ({ status: "written" }),
    recordTransition: () => ({ status: "write_failed", reason: "simulated lock contention" }),
  });

  assert.equal(result.advisories.length, 1);
  assert.match(result.advisories[0], /session-activity transition ledger write failed/);
  assert.match(result.advisories[0], /simulated lock contention/);
});

test("runRecordChangeUsageCheckpoint prints two advisories when both writes fail", async () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  const result = await runRecordChangeUsageCheckpoint({
    cwd,
    argv: ["--change", "some-change"],
    env: { CLAUDE_SESSION_ID: randomUUID() },
    now: () => "2026-09-01T00:00:00.000Z",
    appendSession: () => ({ status: "write_failed", reason: "reason-a" }),
    recordTransition: () => ({ status: "write_failed", reason: "reason-b" }),
  });

  assert.equal(result.advisories.length, 2);
});

// --- missing files / missing inputs must not crash -------------------------

test("runRecordChangeUsageCheckpoint tolerates missing session-pending.md/tasks.md (line counts default to 0)", async () => {
  await withStateDir(async () => {
    const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
    const mainCheckoutRoot = makeTempDir("devpro-record-checkpoint-root-");
    const changeName = "no-files-yet-change";

    let capturedArgs;
    const result = await runRecordChangeUsageCheckpoint({
      cwd,
      argv: ["--change", changeName],
      env: { CLAUDE_SESSION_ID: randomUUID() },
      now: () => "2026-09-01T00:00:00.000Z",
      mainCheckoutRoot,
      appendSession: (args) => {
        capturedArgs = args;
        return { status: "written" };
      },
    });

    assert.deepEqual(result.advisories, []);
    assert.equal(capturedArgs.session_pending_line_count_at_start, 0);
    assert.equal(capturedArgs.tasks_line_count_at_start, 0);
  });
});

test("runRecordChangeUsageCheckpoint returns a fatalError (not an advisory) and skips writes when --change is missing", async () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  let called = false;
  const result = await runRecordChangeUsageCheckpoint({
    cwd,
    argv: [],
    env: { CLAUDE_SESSION_ID: randomUUID() },
    appendSession: () => { called = true; return { status: "written" }; },
  });

  assert.equal(called, false);
  // Missing --change is a caller-contract bug (the SKILL.md step already
  // knows the change name), not a write/environmental degradation — it MUST
  // NOT surface through the same advisories array as write_failed, or the
  // CLI would exit 0 and this class of bug would silently no-op forever.
  assert.equal(result.advisories.length, 0);
  assert.match(result.fatalError, /missing --change/);
});

test("runRecordChangeUsageCheckpoint advises (non-throwing) and skips writes when no session_id/host can be resolved", async () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cwd-");
  let called = false;
  const result = await runRecordChangeUsageCheckpoint({
    cwd,
    argv: ["--change", "some-change"],
    env: {},
    appendSession: () => { called = true; return { status: "written" }; },
  });

  assert.equal(called, false);
  assert.equal(result.advisories.length, 1);
  assert.match(result.advisories[0], /no resolvable session_id\/host/);
  // Unlike missing --change, this stays fail-open: a host that legitimately
  // doesn't populate any checked env var is plausible (a future host, a
  // scrubbed test env), not proof of a caller-contract bug.
  assert.equal(result.fatalError, undefined);
});

// --- real CLI process: exit code contract -----------------------------------

test("CLI process exits 0 on the happy path and prints no advisory", async () => {
  await withStateDir(() => {
    const cwd = makeTempDir("devpro-record-checkpoint-cli-cwd-");
    const sessionId = randomUUID();
    const result = spawnSync("node", [SCRIPT_PATH, "--change", "cli-happy-change"], {
      cwd,
      encoding: "utf8",
      env: claudeEnv(sessionId),
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /ADVISORY/);

    const checkpoint = readChangeUsageCheckpoint({ cwd, changeName: "cli-happy-change" });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.sessions.length, 1);
    assert.equal(checkpoint.sessions[0].session_id, sessionId);
  });
});

test("CLI process exits 0 and prints a visible advisory when the checkpoint directory is unwritable", async () => {
  await withStateDir((dir) => {
    const cwd = makeTempDir("devpro-record-checkpoint-cli-cwd-");
    // `chmod(0500)` is ignored on Windows/NTFS. A file at the configured
    // state-root path gives the CLI a deterministic parent-directory failure.
    const blocker = path.join(dir, "state-root-is-a-file");
    writeFileSync(blocker, "not a directory\n");
    const result = spawnSync("node", [SCRIPT_PATH, "--change", "cli-unwritable-change"], {
      cwd,
      encoding: "utf8",
      env: { ...claudeEnv(), DEVPRO_CHANGE_USAGE_STATE_DIR: blocker },
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /\[record-change-usage-checkpoint\] ADVISORY:/);
    assert.match(result.stdout, /write_failed|checkpoint write failed|ledger write failed/i);
  });
});

test("CLI process exits non-zero with a stderr usage error (not an advisory) when --change is missing", () => {
  const cwd = makeTempDir("devpro-record-checkpoint-cli-cwd-");
  const result = spawnSync("node", [SCRIPT_PATH], {
    cwd,
    encoding: "utf8",
    env: claudeEnv(),
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /ADVISORY/);
  assert.match(result.stderr, /\[record-change-usage-checkpoint\] USAGE ERROR:/);
  assert.match(result.stderr, /missing --change/);
});
