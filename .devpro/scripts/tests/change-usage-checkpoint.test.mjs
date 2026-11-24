import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendChangeUsageOverride,
  appendChangeUsageSession,
  changeUsageCheckpointPath,
  readChangeUsageCheckpoint,
  readSessionChangeTransitions,
  recordSessionChangeTransition,
  sessionTransitionsLedgerPath,
} from "../hooks/lib/change-usage-checkpoint.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoPath } from "./lib/repo-root.mjs";

function withStateDir(fn) {
  const dir = makeTempDir("devpro-change-usage-checkpoint-");
  const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
  process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
  }
}

function seedSession(changeName, sessionId, overrides = {}) {
  return appendChangeUsageSession({
    changeName,
    session_id: sessionId,
    start_ts: "2026-09-01T00:00:00.000Z",
    host: "claude-code",
    session_pending_line_count_at_start: 0,
    tasks_line_count_at_start: 0,
    ...overrides,
  });
}

// D7 schema round-trip + F-5-2 `host` field.
test("appendChangeUsageSession then readChangeUsageCheckpoint round-trips sessions[]", () => {
  withStateDir(() => {
    const changeName = "example-change";
    const result = appendChangeUsageSession({
      changeName,
      session_id: "session-a",
      start_ts: "2026-09-01T00:00:00.000Z",
      host: "claude-code",
      session_pending_line_count_at_start: 3,
      tasks_line_count_at_start: 17,
    });
    assert.equal(result.status, "written");

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.status, "ok");
    assert.equal(checkpoint.change, changeName);
    assert.equal(checkpoint.sessions.length, 1);
    assert.deepEqual(checkpoint.sessions[0], {
      session_id: "session-a",
      start_ts: "2026-09-01T00:00:00.000Z",
      host: "claude-code",
      session_pending_line_count_at_start: 3,
      tasks_line_count_at_start: 17,
    });
    assert.deepEqual(checkpoint.overrides, []);
  });
});

test("appendChangeUsageSession is idempotent per session_id (first write wins, no duplicate)", () => {
  withStateDir(() => {
    const changeName = "example-change";
    seedSession(changeName, "session-a");
    const second = appendChangeUsageSession({
      changeName,
      session_id: "session-a",
      start_ts: "2026-09-01T09:00:00.000Z",
      host: "codex",
      session_pending_line_count_at_start: 99,
      tasks_line_count_at_start: 99,
    });
    assert.equal(second.status, "written");

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.sessions.length, 1);
    assert.equal(checkpoint.sessions[0].start_ts, "2026-09-01T00:00:00.000Z");
  });
});

// Missing/unreadable checkpoint MUST be distinguishable from a true empty read.
test("readChangeUsageCheckpoint returns unavailable for missing file, distinguishable from empty sessions", () => {
  withStateDir(() => {
    const missing = readChangeUsageCheckpoint({ changeName: "never-written" });
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.sessions, undefined);

    seedSession("has-file", "s1");
    const present = readChangeUsageCheckpoint({ changeName: "has-file" });
    assert.equal(present.status, "ok");
    assert.equal(present.sessions.length, 1);
  });
});

test("readChangeUsageCheckpoint returns unavailable for corrupt JSON", () => {
  withStateDir(() => {
    const changeName = "corrupt-change";
    const file = changeUsageCheckpointPath({ changeName });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not valid json");

    const result = readChangeUsageCheckpoint({ changeName });
    assert.equal(result.status, "unavailable");
  });
});

// F-1-3(a): two different session_id concurrent append calls must not lose either.
test("concurrent appendChangeUsageSession calls for different session_id both survive", () => {
  withStateDir(() => {
    const changeName = "concurrent-change";
    const ids = Array.from({ length: 8 }, (_unused, index) => `session-${index}`);
    const results = ids.map((id) => seedSession(changeName, id));
    for (const result of results) assert.equal(result.status, "written");

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.sessions.length, ids.length);
    const seenIds = new Set(checkpoint.sessions.map((session) => session.session_id));
    for (const id of ids) assert.ok(seenIds.has(id), `missing ${id}`);
  });
});

// round 4 finding F-4-3: write path itself failing MUST return a distinguishable
// result, not throw and not silently look like success.
test("appendChangeUsageSession returns write_failed (not a throw) when the write path is unwritable", () => {
  withStateDir((dir) => {
    // POSIX chmod does not make a directory unwritable on Windows/NTFS. Point
    // the state root at a regular file instead; creating the checkpoint's
    // parent then fails deterministically on every platform.
    const blocker = path.join(dir, "state-root-is-a-file");
    writeFileSync(blocker, "not a directory\n");
    const previous = process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
    process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = blocker;
    try {
      let result;
      assert.doesNotThrow(() => {
        result = seedSession("unwritable-change", "s1");
      });
      assert.equal(result.status, "write_failed");
      assert.ok(typeof result.reason === "string" && result.reason.length > 0);
    } finally {
      if (previous === undefined) delete process.env.DEVPRO_CHANGE_USAGE_STATE_DIR;
      else process.env.DEVPRO_CHANGE_USAGE_STATE_DIR = previous;
    }
  });
});

// D7 schema (含 overrides[]) 讀寫 — minimal round-trip; D11 S-1 validation semantics
// belong to task 8, not here.
test("appendChangeUsageOverride then readChangeUsageCheckpoint round-trips overrides[]", () => {
  withStateDir(() => {
    const changeName = "override-change";
    seedSession(changeName, "session-a");
    const result = appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes", "cache_read_bytes"],
      head_ref_oid: "a".repeat(40),
    });
    assert.equal(result.status, "written");

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.overrides.length, 1);
    assert.deepEqual(checkpoint.overrides[0], {
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes", "cache_read_bytes"],
      head_ref_oid: "a".repeat(40),
    });
  });
});

// round 3 finding F-ce6fae98: a Stop-hook re-fires every turn while a
// threshold stays exceeded (REMIND_AFTER_MS=0) — without dedup, overrides[]
// grew by one entry per turn even though it is the same authorized event.
test("appendChangeUsageOverride is idempotent per (session_id, head_ref_oid, thresholds-set) triple", () => {
  withStateDir(() => {
    const changeName = "override-dedup-change";
    seedSession(changeName, "session-a");
    const first = appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes", "cache_read_bytes"],
      head_ref_oid: "a".repeat(40),
    });
    assert.equal(first.status, "written");
    // Repeat call: same triple, later `at` (as a real re-fired Stop-hook turn
    // would produce) — must be a no-op, not a second entry.
    const second = appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T02:00:00.000Z",
      thresholds: ["output_bytes", "cache_read_bytes"],
      head_ref_oid: "a".repeat(40),
    });
    assert.equal(second.status, "written");

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.overrides.length, 1);
    assert.equal(checkpoint.overrides[0].at, "2026-09-01T01:00:00.000Z");
  });
});

test("appendChangeUsageOverride dedup is order-insensitive on the thresholds set", () => {
  withStateDir(() => {
    const changeName = "override-dedup-order-change";
    seedSession(changeName, "session-a");
    appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes", "cache_read_bytes"],
      head_ref_oid: "a".repeat(40),
    });
    appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T02:00:00.000Z",
      thresholds: ["cache_read_bytes", "output_bytes"], // same set, reversed order
      head_ref_oid: "a".repeat(40),
    });

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.overrides.length, 1);
  });
});

test("appendChangeUsageOverride does not dedup across a different session_id, head_ref_oid, or thresholds set", () => {
  withStateDir(() => {
    const changeName = "override-no-dedup-change";
    seedSession(changeName, "session-a");
    seedSession(changeName, "session-b");
    appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes"],
      head_ref_oid: "a".repeat(40),
    });
    appendChangeUsageOverride({
      changeName,
      session_id: "session-b", // different session_id
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes"],
      head_ref_oid: "a".repeat(40),
    });
    appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["output_bytes"],
      head_ref_oid: "b".repeat(40), // different head_ref_oid
    });
    appendChangeUsageOverride({
      changeName,
      session_id: "session-a",
      at: "2026-09-01T01:00:00.000Z",
      thresholds: ["cache_read_bytes"], // different thresholds set
      head_ref_oid: "a".repeat(40),
    });

    const checkpoint = readChangeUsageCheckpoint({ changeName });
    assert.equal(checkpoint.overrides.length, 4);
  });
});

// round 6 finding F-6-2: cross-change global session-activity transition ledger.
test("recordSessionChangeTransition then readSessionChangeTransitions round-trips, ordered by at", () => {
  withStateDir(() => {
    const sessionId = "session-x";
    recordSessionChangeTransition({
      session_id: sessionId,
      change_name: "change-b",
      at: "2026-09-01T02:00:00.000Z",
    });
    recordSessionChangeTransition({
      session_id: sessionId,
      change_name: "change-a",
      at: "2026-09-01T00:00:00.000Z",
    });

    const result = readSessionChangeTransitions({ session_id: sessionId });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.records.map((record) => record.change_name),
      ["change-a", "change-b"],
    );
  });
});

// F-12cc4a14: readSessionChangeTransitions previously sorted with
// String#localeCompare, a locale-dependent collation that can diverge from
// the plain lexicographic `<`/`>` comparison session-token-usage.mjs's
// consumer uses for the same `at` values (turn.ts < upperBoundAt). Fixed to
// plain lexicographic comparison to match; two regressions locked in below.
test("readSessionChangeTransitions sorts equal-`at` records without losing any (tie-break exercises the `0` branch)", () => {
  withStateDir(() => {
    const sessionId = "session-tie";
    const tiedAt = "2026-09-01T00:00:00.000Z";
    recordSessionChangeTransition({ session_id: sessionId, change_name: "change-a", at: tiedAt });
    recordSessionChangeTransition({ session_id: sessionId, change_name: "change-b", at: tiedAt });

    const result = readSessionChangeTransitions({ session_id: sessionId });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.records.map((record) => record.change_name).sort(),
      ["change-a", "change-b"],
    );
  });
});

test("readSessionChangeTransitions no longer uses locale-dependent localeCompare for `at` ordering", () => {
  const source = readFileSync(repoPath(".devpro/scripts/hooks/lib/change-usage-checkpoint.mjs"), "utf8");
  assert.doesNotMatch(source, /localeCompare/, "localeCompare must not reappear in change-usage-checkpoint.mjs");
});

test("recordSessionChangeTransition keeps separate records for the same session_id across two change_name values (no overwrite)", () => {
  withStateDir(() => {
    const sessionId = "session-y";
    recordSessionChangeTransition({ session_id: sessionId, change_name: "change-a", at: "2026-09-01T00:00:00.000Z" });
    recordSessionChangeTransition({ session_id: sessionId, change_name: "change-b", at: "2026-09-01T01:00:00.000Z" });
    recordSessionChangeTransition({ session_id: sessionId, change_name: "change-a", at: "2026-09-01T02:00:00.000Z" });

    const result = readSessionChangeTransitions({ session_id: sessionId });
    assert.equal(result.records.length, 3);
  });
});

test("readSessionChangeTransitions returns unavailable for missing ledger, distinguishable from empty records", () => {
  withStateDir(() => {
    const missing = readSessionChangeTransitions({ session_id: "never-seen" });
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.records, undefined);

    recordSessionChangeTransition({ session_id: "seen", change_name: "change-a", at: "2026-09-01T00:00:00.000Z" });
    const empty = readSessionChangeTransitions({ session_id: "never-seen-but-ledger-exists" });
    assert.equal(empty.status, "ok");
    assert.deepEqual(empty.records, []);
  });
});

test("readSessionChangeTransitions returns unavailable for corrupt ledger JSON", () => {
  withStateDir(() => {
    const file = sessionTransitionsLedgerPath({});
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not json");

    const result = readSessionChangeTransitions({ session_id: "anyone" });
    assert.equal(result.status, "unavailable");
  });
});

test("concurrent recordSessionChangeTransition calls for different session_id both survive", () => {
  withStateDir(() => {
    const sessionIds = Array.from({ length: 8 }, (_unused, index) => `session-${index}`);
    const results = sessionIds.map((id) =>
      recordSessionChangeTransition({ session_id: id, change_name: "change-a", at: "2026-09-01T00:00:00.000Z" }));
    for (const result of results) assert.equal(result.status, "written");

    for (const id of sessionIds) {
      const result = readSessionChangeTransitions({ session_id: id });
      assert.equal(result.records.length, 1);
    }
  });
});

// `_` prefix keeps the sibling ledger from ever colliding with a legal
// `<change>.json` (kebab-case change names cannot start with `_`).
test("sessionTransitionsLedgerPath is a sibling of the per-change checkpoint file, prefixed with _", () => {
  withStateDir(() => {
    const checkpointFile = changeUsageCheckpointPath({ changeName: "some-change" });
    const ledgerFile = sessionTransitionsLedgerPath({});
    assert.equal(path.dirname(ledgerFile), path.dirname(checkpointFile));
    assert.equal(path.basename(ledgerFile), "_session-transitions.json");
  });
});
