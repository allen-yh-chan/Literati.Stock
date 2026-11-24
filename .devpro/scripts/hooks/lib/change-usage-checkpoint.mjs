/**
 * Per-change cost checkpoint (D7) + cross-change session-activity transition
 * ledger (round 6 finding F-6-2). See
 * `openspec/changes/add-change-cost-circuit-breaker/design.md` D7.
 *
 * Two independent SSOTs share the same `notes/tmp/state/devpro-change-usage/`
 * prefix:
 *   - `<change>.json`: per-change checkpoint (`sessions[]`, `overrides[]`).
 *     Isolated per named change — this module never reads or writes another
 *     change's file (D7 C-2: no change-to-change mapping table).
 *   - `_session-transitions.json`: cross-change, append-only ledger of
 *     `{ session_id, change_name, at }`. The `_` prefix guarantees it can
 *     never collide with a legal `<change>.json` — kebab-case change names
 *     (D12/F-5-5) MUST start with `[a-z0-9]`, never `_`. `--since-change`
 *     aggregation (task 3) uses this to bound a `sessions[]` entry by the
 *     next transition record for the same `session_id`, closing F-6-2's
 *     unbounded-overcount gap without per-change files ever writing into
 *     each other.
 *
 * Every write API here returns a distinguishable `{ status: "written" }` /
 * `{ status: "write_failed", reason }` result instead of throwing (round 4
 * finding F-4-3): a failed write is fail-open (the caller — `/devpro:change`
 * startup — MUST NOT be blocked by a local state-write failure), but MUST
 * be visible, not silently indistinguishable from success. Every read API
 * returns `{ status: "unavailable" }` for a missing/corrupt file, kept
 * structurally distinct from a legitimate empty result (empty `sessions`/
 * `records` array) per NFR-2.
 *
 * The CAS lock shape (per-attempt-unique lockfile, stale-lock reaping,
 * post-create contention rescan, fsync + atomic rename durable write)
 * mirrors `review-round-budget.mjs:73-186` — matching the shape, not
 * reusing its code, per that module's own precedent (its lock helpers are
 * module-private and not meant to be imported across modules).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";
import { fsyncDirectory } from "../../lib/durable-fs.mjs";

const STATE_PREFIX = "devpro-change-usage";
const LEDGER_BASENAME = "_session-transitions.json";
const LOCK_STALE_AFTER_MS = 30_000;

function defaultChangeUsageStateDir(cwd) {
  return defaultRepoStateDir(STATE_PREFIX, cwd);
}

/** Directory holding every per-change checkpoint and the sibling ledger.
 * `DEVPRO_CHANGE_USAGE_STATE_DIR` override exists for tests, matching the
 * `postPrCompletionDir` precedent (`post-pr-completion-state.mjs`). */
export function changeUsageStateDir(cwd = process.cwd(), env = process.env) {
  return env.DEVPRO_CHANGE_USAGE_STATE_DIR || defaultChangeUsageStateDir(cwd);
}

function sanitizeChangeNameToken(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function changeUsageCheckpointPath({ cwd = process.cwd(), changeName, stateDir = changeUsageStateDir(cwd) } = {}) {
  return path.join(stateDir, `${sanitizeChangeNameToken(changeName)}.json`);
}

export function sessionTransitionsLedgerPath({ cwd = process.cwd(), stateDir = changeUsageStateDir(cwd) } = {}) {
  return path.join(stateDir, LEDGER_BASENAME);
}

/** Line count of `filePath`, 0 if missing/unreadable. A trailing newline does
 * NOT count as an extra (empty) line — matches how a human counts "lines
 * written to the file", not `wc -l` semantics. This is the SAME snapshot
 * value written into `session_pending_line_count_at_start` /
 * `tasks_line_count_at_start` (task 2, `record-change-usage-checkpoint.mjs`)
 * and MUST be reused — not reimplemented — by task 9's D8 continuation-
 * checkpoint comparison, which re-counts the same two files at gate-eval
 * time: a second, independently-invented counting rule would silently
 * desync the two sides of that comparison. */
export function countFileLines(filePath) {
  if (!existsSync(filePath)) return 0;
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

// ---- shared CAS-lock + durable-write primitives (per target file) --------

function lockFileFor(targetFile) {
  return `${targetFile}.lock.${randomUUID()}`;
}

function lockFilePrefix(targetFile) {
  return `${path.basename(targetFile)}.lock.`;
}

function lockOwnerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function reapStaleLocks(targetFile) {
  const dir = path.dirname(targetFile);
  const prefix = lockFilePrefix(targetFile);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const lockFile = path.join(dir, name);
    let stat;
    try {
      stat = statSync(lockFile);
    } catch {
      continue;
    }
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_AFTER_MS) continue;
    let record = null;
    try {
      record = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      record = null;
    }
    if (record && lockOwnerAlive(record.owner_pid)) continue;
    try {
      unlinkSync(lockFile);
      fsyncDirectory(dir);
    } catch {
      // Best effort; harmless if another reaper or the owner's own release
      // already removed this exact (uniquely-named) file first.
    }
  }
}

function otherLiveLockExists(targetFile, exceptLockFile) {
  const dir = path.dirname(targetFile);
  const prefix = lockFilePrefix(targetFile);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const lockFile = path.join(dir, name);
    if (lockFile === exceptLockFile) continue;
    let stat;
    try {
      stat = statSync(lockFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return true;
    }
    if (now - stat.mtimeMs <= LOCK_STALE_AFTER_MS) return true;
    let record = null;
    try {
      record = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      record = null;
    }
    if (record && !lockOwnerAlive(record.owner_pid)) continue;
    return true;
  }
  return false;
}

function acquireLock(targetFile) {
  mkdirSync(path.dirname(targetFile), { recursive: true });
  reapStaleLocks(targetFile);
  const lockFile = lockFileFor(targetFile);
  const fd = openSync(lockFile, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({
      schema: "devpro-change-usage-checkpoint-lock/v1",
      owner_pid: process.pid,
      created_at: new Date().toISOString(),
    }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(path.dirname(lockFile));
  if (otherLiveLockExists(targetFile, lockFile)) {
    releaseLock({ lockFile });
    return null;
  }
  return { lockFile };
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    unlinkSync(lock.lockFile);
    fsyncDirectory(path.dirname(lock.lockFile));
  } catch {
    // Best effort release; a crashed owner's lock self-heals via the
    // staleness reap on the next acquisition attempt.
  }
}

function writeFileDurably(targetFile, data) {
  const dir = path.dirname(targetFile);
  mkdirSync(dir, { recursive: true });
  const candidate = `${targetFile}.${process.pid}.${Date.now()}.${randomUUID()}.candidate`;
  let fd;
  let renamed = false;
  try {
    fd = openSync(candidate, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(candidate, targetFile);
    renamed = true;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    if (!renamed) {
      try { unlinkSync(candidate); } catch { /* nothing to clean up */ }
    }
  }
}

/** Runs `mutate(current) -> nextState` under this target file's CAS lock,
 * durably writing the result. Returns `{ status: "written" }` on success or
 * `{ status: "write_failed", reason }` on ANY failure (lock unavailable,
 * unwritable directory, write/rename failure) — never throws (F-4-3). */
function withLockedReadModifyWrite(targetFile, readCurrent, mutate) {
  let lock;
  try {
    lock = acquireLock(targetFile);
    if (!lock) {
      return { status: "write_failed", reason: "lock unavailable; another writer is active" };
    }
    const current = readCurrent();
    const next = mutate(current);
    writeFileDurably(targetFile, next);
    return { status: "written" };
  } catch (error) {
    return { status: "write_failed", reason: error?.message || String(error) };
  } finally {
    releaseLock(lock);
  }
}

// ---- per-change checkpoint (sessions[] + overrides[]) ---------------------

function readRawCheckpoint(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    schema_version: 1,
    change: typeof raw.change === "string" ? raw.change : "",
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    overrides: Array.isArray(raw.overrides) ? raw.overrides : [],
  };
}

/** Read-only. `{ status: "unavailable" }` for missing/corrupt file — kept
 * structurally distinct (no `sessions`/`overrides` keys) from a legitimate
 * empty checkpoint so callers can never mistake one for the other. */
export function readChangeUsageCheckpoint({ cwd = process.cwd(), changeName, stateDir } = {}) {
  const file = changeUsageCheckpointPath({ cwd, changeName, stateDir });
  const raw = readRawCheckpoint(file);
  if (!raw) return { status: "unavailable" };
  return { status: "ok", ...raw };
}

/** Append-session semantics: idempotent per `session_id` (D7 — a given
 * `session_id` can appear at most once per change; a repeat call is a
 * successful no-op, first write wins). Returns `{status:"written"}` /
 * `{status:"write_failed", reason}` (F-4-3) — never throws. */
export function appendChangeUsageSession({
  cwd = process.cwd(),
  changeName,
  session_id,
  start_ts,
  host,
  session_pending_line_count_at_start,
  tasks_line_count_at_start,
} = {}) {
  const file = changeUsageCheckpointPath({ cwd, changeName });
  return withLockedReadModifyWrite(
    file,
    () => readRawCheckpoint(file) || { schema_version: 1, change: changeName, sessions: [], overrides: [] },
    (current) => {
      const alreadyPresent = current.sessions.some((session) => session.session_id === session_id);
      const sessions = alreadyPresent
        ? current.sessions
        : [...current.sessions, {
          session_id,
          start_ts,
          host,
          session_pending_line_count_at_start,
          tasks_line_count_at_start,
        }];
      return { schema_version: 1, change: changeName, sessions, overrides: current.overrides };
    },
  );
}

/** Order-insensitive threshold-set equality. `parsed.declared_thresholds` is
 * `[...new Set(...)]` — insertion order from the user's env var string, not
 * a sorted/canonical order — so two calls authorizing the same threshold set
 * can arrive with different array order. Compare sorted, never write a
 * normalized order back (the durable record keeps the caller's order). */
function sameThresholdSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((value, i) => value === sb[i]);
}

/** D11 override-usage append. Idempotent per `(session_id, head_ref_oid,
 * thresholds-set)` triple (F-ce6fae98 — a Stop-hook re-fires every turn
 * while REMIND_AFTER_MS=0 keeps a threshold exceeded; without this, the
 * same override event appended once per turn made overrides[] unbounded
 * and defeated evaluateOverrideDisclosure's multiset comparison). A repeat
 * call for the same triple is a successful no-op, first write wins — same
 * shape as appendChangeUsageSession's session_id idempotency above. The
 * dedup check runs inside the locked modify callback (not a separate
 * read-then-append) to stay race-free across concurrent Stop-hook turns.
 * Returns `{status:"written"}` / `{status:"write_failed", reason}` (F-4-3)
 * — never throws; the no-op path also resolves "written" since the durable
 * content (unchanged or not) was still successfully re-persisted under
 * lock. */
export function appendChangeUsageOverride({
  cwd = process.cwd(),
  changeName,
  session_id,
  at,
  thresholds,
  head_ref_oid,
} = {}) {
  const file = changeUsageCheckpointPath({ cwd, changeName });
  return withLockedReadModifyWrite(
    file,
    () => readRawCheckpoint(file) || { schema_version: 1, change: changeName, sessions: [], overrides: [] },
    (current) => {
      const alreadyPresent = current.overrides.some((o) => o.session_id === session_id
        && o.head_ref_oid === head_ref_oid
        && sameThresholdSet(o.thresholds, thresholds));
      const overrides = alreadyPresent
        ? current.overrides
        : [...current.overrides, { session_id, at, thresholds, head_ref_oid }];
      return { schema_version: 1, change: changeName, sessions: current.sessions, overrides };
    },
  );
}

// ---- cross-change session-activity transition ledger (F-6-2) --------------

function readRawLedger(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    schema_version: 1,
    transitions: Array.isArray(raw.transitions) ? raw.transitions : [],
  };
}

/** Append-only: every call adds a new record, even for a `session_id` /
 * `change_name` pair already present (re-entry — e.g. A -> B -> A — is a
 * real transition each time, not a duplicate; idempotency semantics for
 * task 3's aggregation are decided by task 3's own TDD, not by suppressing
 * writes here). Returns `{status:"written"}` / `{status:"write_failed",
 * reason}` — never throws (F-4-3 discipline extended to this ledger). */
export function recordSessionChangeTransition({ cwd = process.cwd(), session_id, change_name, at } = {}) {
  const file = sessionTransitionsLedgerPath({ cwd });
  return withLockedReadModifyWrite(
    file,
    () => readRawLedger(file) || { schema_version: 1, transitions: [] },
    (current) => ({
      schema_version: 1,
      transitions: [...current.transitions, { session_id, change_name, at }],
    }),
  );
}

/** Read-only, ordered by `at` ascending. `{status:"unavailable"}` for
 * missing/corrupt ledger — distinct from a legitimate empty `records: []`
 * (ledger exists but this `session_id` has no recorded transitions). */
export function readSessionChangeTransitions({ cwd = process.cwd(), session_id, stateDir } = {}) {
  const file = sessionTransitionsLedgerPath({ cwd, stateDir });
  const raw = readRawLedger(file);
  if (!raw) return { status: "unavailable" };
  const records = raw.transitions
    .filter((record) => record?.session_id === session_id)
    .slice()
    .sort((a, b) => {
      const aAt = String(a.at);
      const bAt = String(b.at);
      return aAt < bAt ? -1 : aAt > bAt ? 1 : 0;
    });
  return { status: "ok", records };
}
