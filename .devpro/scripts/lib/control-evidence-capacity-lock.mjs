import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fsyncDirectory } from "./durable-fs.mjs";

const MAX_DISPATCH_BYTES = 4096;
const CAPACITY_LOCK_DIRECTORY = ".capacity-lock";
const CAPACITY_LOCK_OWNER_FILE = "owner.json";
const CAPACITY_LOCK_OWNER_SCHEMA = "devpro-second-review-capacity-lock/v1";
const CAPACITY_LOCK_REPAIR_SCHEMA = "devpro-second-review-capacity-lock-repair/v1";
const CAPACITY_LOCK_WAIT_MS = 5000;
const CAPACITY_LOCK_STALE_AFTER_MS = 30_000;
// #3176: native Windows refuses to rename a directory while any process holds
// an open handle to a file inside it. A live contender opens owner.json on
// every poll, so the owner's release rename can lose that race with EPERM.
// Only that exact failure is retried, within this budget; it is independent of
// CAPACITY_LOCK_WAIT_MS and exhaustion still fails closed with the EPERM.
const CAPACITY_LOCK_RELEASE_RENAME_RETRY_MS = 2000;
const CAPACITY_LOCK_RELEASE_RENAME_RETRY_INTERVAL_MS = 5;
// The recoverer that was elected must withdraw its own repair marker on every
// exit. A marker held open by another process (a contender reading it, an
// antivirus scan) fails to unlink transiently on native Windows, so the
// withdrawal is retried within this budget before it is handed to the
// process-local pending set. Independent of the acquisition deadline.
const CAPACITY_LOCK_REPAIR_RETIRE_RETRY_MS = 1000;
const CAPACITY_LOCK_REPAIR_RETIRE_MAX_ROUNDS = 200;
const CAPACITY_LOCK_REPAIR_RETIRE_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const CAPACITY_LOCK_EVENT_PREFIX = "devpro-capacity-lock-event";
const CAPACITY_LOCK_EVENT_EAGAIN_MS = 100;
const CAPACITY_LOCK_UNDECIDABLE_MESSAGE = "dispatch capacity gate is unavailable; reservation failed closed; "
  + "\".capacity-lock\" in the control-evidence root (notes/tmp/state/devpro-second-review-control-evidence "
  + "under the main checkout, or DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR when set) has no valid owner record; "
  + "remove it manually once no reviewer dispatch is running";

/** Every protocol step that can be observed or crashed on, in protocol order (design D11). */
export const CAPACITY_LOCK_PROTOCOL_CHECKPOINTS = Object.freeze([
  "stage-created",
  "stage-owner-written",
  "lock-published",
  "sweep-owner-removed",
  "repair-candidate-written",
  "repair-elected",
  "repair-candidate-removed",
  "repair-target-verified",
  "repair-quarantined",
  "repair-quarantine-verified",
  "repair-owner-removed",
  "repair-quarantine-removed",
  "repair-markers-retired",
]);

const STAGE_NAME = /^\.capacity-lock\.stage\.(\d+)\.[a-f0-9-]{36}$/;
const CANDIDATE_NAME = /^\.capacity-lock\.repair-candidate\.(\d+)\.[a-f0-9-]{36}$/;
const MARKER_NAME = /^\.capacity-lock\.repair\.([a-f0-9-]{36})\.(\d+)$/;
const ISOLATION_NAME = /^\.capacity-lock\.(?:recovery|release)\.(\d+)\.[a-f0-9-]{36}$/;

// Repair markers this process elected but could not withdraw (design D4). Keyed
// by absolute marker path; the value keeps the repair_token that proves the file
// is still this process's. In-process state only; nothing is persisted.
const pendingMarkerRetirements = new Map();

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(sleepBuffer, 0, 0, Math.max(1, ms));
}

function capacityError(message) {
  const error = new Error(message);
  error.classification = "reviewer_dispatch_capacity_exceeded";
  return error;
}

function canonicalBytes(record, maxBytes) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.length > maxBytes) {
    throw capacityError(`control evidence exceeds ${maxBytes} canonical bytes`);
  }
  return bytes;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw capacityError(`${label} must be an object`);
  }
}

function assertCapacityLockOwner(record) {
  assertPlainObject(record, "capacity lock owner");
  const exactFields = ["schema", "owner_pid", "owner_token", "created_at"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(exactFields.sort())
    || record.schema !== CAPACITY_LOCK_OWNER_SCHEMA
    || !Number.isSafeInteger(record.owner_pid)
    || record.owner_pid <= 0
    || typeof record.owner_token !== "string"
    || !/^[a-f0-9-]{36}$/.test(record.owner_token)
    || typeof record.created_at !== "string"
    || Number.isNaN(Date.parse(record.created_at))
    || new Date(record.created_at).toISOString() !== record.created_at) {
    throw capacityError("dispatch capacity lock owner evidence is malformed");
  }
  return record;
}

/** EPERM and unknown process-liveness failures are treated as live. */
export function capacityLockOwnerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function readCapacityLockOwner(lockPath) {
  const ownerPath = path.join(lockPath, CAPACITY_LOCK_OWNER_FILE);
  if (!existsSync(ownerPath)) return null;
  const size = statSync(ownerPath).size;
  if (size <= 0 || size > MAX_DISPATCH_BYTES) {
    throw capacityError("dispatch capacity lock owner evidence exceeds its bound");
  }
  const bytes = readFileSync(ownerPath);
  let owner;
  try {
    owner = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw capacityError("dispatch capacity lock owner evidence is not valid JSON");
  }
  assertCapacityLockOwner(owner);
  if (!canonicalBytes(owner, MAX_DISPATCH_BYTES).equals(bytes)) {
    throw capacityError("dispatch capacity lock owner evidence is not canonical");
  }
  return owner;
}

// Writes the complete owner record into `directory` (the staging directory; the
// lock path itself is never written to). Fsyncs the file, then the directory.
function publishCapacityLockOwner(directory, owner) {
  const ownerPath = path.join(directory, CAPACITY_LOCK_OWNER_FILE);
  const bytes = canonicalBytes(owner, MAX_DISPATCH_BYTES);
  let fd;
  try {
    fd = openSync(ownerPath, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Protocol context, checkpoints and correlatable records (design D9, D11)
// ---------------------------------------------------------------------------

function createContext(rootDir, options, deadline) {
  return {
    root: rootDir,
    lockPath: path.join(rootDir, CAPACITY_LOCK_DIRECTORY),
    options,
    deadline,
    staleAfterMs: options.staleAfterMs ?? CAPACITY_LOCK_STALE_AFTER_MS,
    platform: options.platform ?? process.platform,
    // The error a checkpoint injected: best-effort catch blocks must rethrow it.
    injected: null,
    // Set when the required record for a dead owner could not be written: this
    // call takes part in no further election.
    electionsDisabled: false,
    // Election runs on every poll: a failure or a malformed marker that was already
    // written in this call is not written again (keys "<step>:<code>", "malformed:<marker>").
    reported: new Set(),
  };
}

function checkpoint(ctx, name) {
  if (typeof ctx.options.checkpoint !== "function") return;
  try {
    ctx.options.checkpoint(name);
  } catch (error) {
    ctx.injected = { error };
    throw error;
  }
}

function isInjected(ctx, error) {
  return ctx.injected !== null && ctx.injected.error === error;
}

function isFileSystemError(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string";
}

// Records the protocol step on an unexpected filesystem error. The error keeps
// its code and identity; only an extensible object can carry the property.
function tagProtocolStep(error, step) {
  if (isFileSystemError(error) && Object.isExtensible(error) && error.capacityLockStep === undefined) {
    try {
      error.capacityLockStep = step;
    } catch {
      // A frozen-like error object keeps its original shape.
    }
  }
  return error;
}

function lockIdentity(stat, owner) {
  if (!stat || !owner) return null;
  return {
    dev: stat.dev,
    ino: stat.ino,
    owner_pid: owner.owner_pid,
    owner_token: owner.owner_token,
    created_at: owner.created_at,
  };
}

function writeEventLine(line, budgetMs) {
  const bytes = Buffer.from(line, "utf8");
  const limit = Date.now() + budgetMs;
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = writeSync(2, bytes, offset, bytes.length - offset);
      if (!(written > 0)) return false;
      offset += written;
    } catch (error) {
      if (error?.code !== "EAGAIN" || Date.now() >= limit) return false;
      sleepMs(1);
    }
  }
  return true;
}

// Returns whether the destination accepted the whole record. Records carry
// entry names relative to the root, never absolute paths. A required record
// gates a destructive step; a best-effort record never changes the outcome.
function emitEvent(ctx, event, { step, code = null, lock = null, detail = {} }) {
  const record = { event, at: new Date().toISOString(), pid: process.pid, step, code, lock, detail };
  try {
    if (typeof ctx.options.onProtocolEvent === "function") {
      ctx.options.onProtocolEvent(record);
      return true;
    }
    const budgetMs = Math.min(CAPACITY_LOCK_EVENT_EAGAIN_MS, Math.max(0, ctx.deadline - Date.now()));
    return writeEventLine(`${CAPACITY_LOCK_EVENT_PREFIX} ${JSON.stringify(record)}\n`, budgetMs);
  } catch {
    return false;
  }
}

function reportUnexpected(ctx, step, error, lock = null, detail = {}) {
  emitEvent(ctx, "unexpected-fs-error", { step, code: error?.code ?? null, lock, detail });
  return tagProtocolStep(error, step);
}

// Same record, written once per call for each step and error code.
function reportUnexpectedOnce(ctx, step, error, lock) {
  const key = `${step}:${error?.code ?? ""}`;
  if (ctx.reported.has(key)) return;
  ctx.reported.add(key);
  reportUnexpected(ctx, step, error, lock);
}

// Best effort: the removal it follows is already done and a failed flush changes no outcome.
function fsyncQuietly(directory) {
  try {
    fsyncDirectory(directory);
  } catch {
    // The entry is gone; durability of its removal is best effort.
  }
}

// ---------------------------------------------------------------------------
// Shared bounded retry loop (design D6)
// ---------------------------------------------------------------------------

/**
 * One loop for every bounded retry: the owner's release rename, the recoverer's
 * quarantine rename and the elected recoverer's marker withdrawal. The caller
 * supplies the action, which errors are retryable and what to re-prove before a
 * retry. Action failures are returned, not thrown; an error thrown by
 * `beforeRetry` propagates (it means the retry must not happen).
 *
 * beforeRetry verdicts: "proceed" (run the action again), "completed" (the goal
 * already holds, stop), "skip" (nothing can be decided this round, wait and ask
 * again) or { stop: error } (give up now).
 *
 * Result: { status: "done" | "completed" | "exhausted" | "failed", attempts, error }.
 */
function retryBounded({
  action,
  isRetryable,
  beforeRetry = () => "proceed",
  budgetMs,
  intervalMs = CAPACITY_LOCK_RELEASE_RENAME_RETRY_INTERVAL_MS,
  maxRounds = Infinity,
}) {
  const deadline = Date.now() + budgetMs;
  let attempts = 1;
  let lastError;
  try {
    action();
    return { status: "done", attempts, error: null };
  } catch (error) {
    if (!isRetryable(error)) return { status: "failed", attempts, error };
    lastError = error;
  }
  while (true) {
    if (Date.now() >= deadline || attempts - 1 >= maxRounds) {
      return { status: "exhausted", attempts, error: lastError };
    }
    sleepMs(intervalMs);
    attempts += 1;
    const verdict = beforeRetry();
    if (verdict === "completed") return { status: "completed", attempts, error: lastError };
    if (verdict === "skip") continue;
    if (verdict !== "proceed") {
      return { status: "failed", attempts, error: verdict?.stop ?? lastError };
    }
    try {
      action();
      return { status: "done", attempts, error: null };
    } catch (error) {
      if (!isRetryable(error)) return { status: "failed", attempts, error };
      lastError = error;
    }
  }
}

function isRenameEperm(platform, error) {
  return platform === "win32" && error?.code === "EPERM" && error?.syscall === "rename";
}

// ---------------------------------------------------------------------------
// Repair markers (design D3)
// ---------------------------------------------------------------------------

function repairMarkerName(targetToken, generation) {
  return `${CAPACITY_LOCK_DIRECTORY}.repair.${targetToken}.${generation}`;
}

// Parsed and canonical, or null. File system errors propagate to the caller.
function readRepairMarker(markerPath) {
  const bytes = readFileSync(markerPath);
  if (bytes.length === 0 || bytes.length > MAX_DISPATCH_BYTES) return null;
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const exactFields = ["schema", "repair_pid", "repair_token", "created_at", "target_owner_token", "generation"];
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify(exactFields)
    || record.schema !== CAPACITY_LOCK_REPAIR_SCHEMA
    || !Number.isSafeInteger(record.repair_pid)
    || record.repair_pid <= 0
    || typeof record.repair_token !== "string"
    || !/^[a-f0-9-]{36}$/.test(record.repair_token)
    || typeof record.created_at !== "string"
    || Number.isNaN(Date.parse(record.created_at))
    || typeof record.target_owner_token !== "string"
    || !/^[a-f0-9-]{36}$/.test(record.target_owner_token)
    || !Number.isSafeInteger(record.generation)
    || record.generation < 0
    || !canonicalBytes(record, MAX_DISPATCH_BYTES).equals(bytes)) {
    return null;
  }
  return record;
}

// Names of every marker for `targetToken`, highest generation first.
function listRepairMarkers(root, targetToken) {
  const markers = [];
  for (const name of readdirSync(root)) {
    const match = MARKER_NAME.exec(name);
    if (match && match[1] === targetToken) markers.push({ name, generation: Number(match[2]) });
  }
  return markers.sort((left, right) => right.generation - left.generation);
}

// Reads the highest generation and decides the generation this contender may
// publish: 0 when there is none, top + 1 when the top holder is provably dead,
// otherwise null (lost). Anything unreadable or unprovable is a lost round.
function electionGeneration(ctx, targetToken, lock) {
  let markers;
  try {
    markers = listRepairMarkers(ctx.root, targetToken);
  } catch (error) {
    if (error?.code !== "ENOENT") reportUnexpectedOnce(ctx, "election-list", error, lock);
    return null;
  }
  if (markers.length === 0) return 0;
  const top = markers[0];
  let record;
  try {
    record = readRepairMarker(path.join(ctx.root, top.name));
  } catch (error) {
    if (error?.code !== "ENOENT") reportUnexpectedOnce(ctx, "election-read", error, lock);
    return null;
  }
  if (record === null) {
    // Whose marker this is cannot be proven, so it is neither superseded nor removed;
    // the record is the only trace of why every contender keeps losing.
    if (!ctx.reported.has(`malformed:${top.name}`)) {
      ctx.reported.add(`malformed:${top.name}`);
      emitEvent(ctx, "residue-preserved", {
        step: "election-read",
        lock,
        detail: { item: top.name, reason: "repair-marker-malformed" },
      });
    }
    return null;
  }
  if (record.target_owner_token !== targetToken
    || record.generation !== top.generation
    || capacityLockOwnerIsAlive(record.repair_pid)) {
    return null;
  }
  return top.generation + 1;
}

function removeQuietly(target) {
  try {
    unlinkSync(target);
  } catch {
    // Best effort; a leftover candidate is removed by the residue cleanup.
    return;
  }
  fsyncQuietly(path.dirname(target));
}

// Publishes M(T, g) by writing a complete candidate and hard-linking it, so the
// marker is both exclusive (link fails with EEXIST) and complete the moment it
// exists. Returns the marker handle, or null when this round was lost.
function publishRepairMarker(ctx, targetToken, generation, lock) {
  const repairToken = randomUUID();
  const record = {
    schema: CAPACITY_LOCK_REPAIR_SCHEMA,
    repair_pid: process.pid,
    repair_token: repairToken,
    created_at: new Date().toISOString(),
    target_owner_token: targetToken,
    generation,
  };
  const markerFile = repairMarkerName(targetToken, generation);
  const candidatePath = path.join(ctx.root, `${CAPACITY_LOCK_DIRECTORY}.repair-candidate.${process.pid}.${repairToken}`);
  const markerPath = path.join(ctx.root, markerFile);
  let fd;
  try {
    fd = openSync(candidatePath, "wx", 0o600);
    writeFileSync(fd, canonicalBytes(record, MAX_DISPATCH_BYTES));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the descriptor is lost either way */ }
    }
    removeQuietly(candidatePath);
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") reportUnexpectedOnce(ctx, "election-candidate", error, lock);
    return null;
  }
  try {
    checkpoint(ctx, "repair-candidate-written");
  } catch (error) {
    removeQuietly(candidatePath);
    throw error;
  }
  try {
    linkSync(candidatePath, markerPath);
  } catch (error) {
    removeQuietly(candidatePath);
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") reportUnexpectedOnce(ctx, "election-link", error, lock);
    return null;
  }
  return { name: markerFile, path: markerPath, token: repairToken, candidatePath, ownRetired: false, predecessorsRetired: false };
}

// What the marker file is, as far as its holder can prove: "proceed" (still ours),
// "completed" (gone, or another holder's), "skip" (unreadable for a transient
// reason) or { stop } (unreadable for good, or not a marker at all).
function confirmMarkerIsOwn(markerPath, repairToken) {
  let record;
  try {
    record = readRepairMarker(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "completed";
    if (CAPACITY_LOCK_REPAIR_RETIRE_RETRYABLE_CODES.has(error?.code)) return "skip";
    return { stop: error };
  }
  if (record === null) return { stop: null };
  return record.repair_token === repairToken ? "proceed" : "completed";
}

function pendingMarkerNames() {
  return [...pendingMarkerRetirements.keys()].map((markerPath) => path.basename(markerPath));
}

// Withdraws this process's own marker (R-own). Never throws: a failure is
// recorded and the marker is handed to the pending set, retried before the next
// election by this same process and taken over by a successor once it exits.
function retireOwnMarker(ctx, marker) {
  if (marker.ownRetired) return;
  marker.ownRetired = true;
  const result = retryBounded({
    action: () => {
      try {
        unlinkSync(marker.path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
    isRetryable: (error) => CAPACITY_LOCK_REPAIR_RETIRE_RETRYABLE_CODES.has(error?.code),
    beforeRetry: () => confirmMarkerIsOwn(marker.path, marker.token),
    budgetMs: ctx.options.repairRetireRetryMs ?? CAPACITY_LOCK_REPAIR_RETIRE_RETRY_MS,
    maxRounds: CAPACITY_LOCK_REPAIR_RETIRE_MAX_ROUNDS,
  });
  if (result.status === "done" || result.status === "completed") {
    fsyncQuietly(ctx.root);
    return;
  }
  pendingMarkerRetirements.set(marker.path, { token: marker.token });
  emitEvent(ctx, "repair-marker-retire-failed", {
    step: "marker-retire",
    code: result.error?.code ?? null,
    detail: { marker: marker.name, attempts: result.attempts, pending: pendingMarkerNames() },
  });
}

// R-gone: with T_D proven absent from the lock path, markers for T_D whose holder
// is dead are removed too. Best effort.
function retireDeadPredecessors(ctx, marker, targetToken, lock) {
  if (marker.predecessorsRetired) return;
  marker.predecessorsRetired = true;
  let removed = false;
  try {
    for (const other of listRepairMarkers(ctx.root, targetToken)) {
      if (other.name === marker.name) continue;
      const otherPath = path.join(ctx.root, other.name);
      try {
        const record = readRepairMarker(otherPath);
        if (record && !capacityLockOwnerIsAlive(record.repair_pid)) {
          unlinkSync(otherPath);
          removed = true;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") reportUnexpected(ctx, "marker-retire", error, lock, { marker: other.name });
      }
    }
    if (removed) fsyncDirectory(ctx.root);
  } catch (error) {
    if (error?.code !== "ENOENT") reportUnexpected(ctx, "marker-retire", error, lock, { marker: marker.name });
  }
}

function retireMarkers(ctx, marker, targetToken, provenGone, lock) {
  retireOwnMarker(ctx, marker);
  if (provenGone) retireDeadPredecessors(ctx, marker, targetToken, lock);
}

// One attempt per pending entry, no waiting: a marker this process could not
// withdraw earlier is removed once it is readable and still ours; an entry whose
// file is gone or now belongs to another holder is dropped without deleting it.
function retryPendingMarkerRetirements() {
  for (const [markerPath, entry] of [...pendingMarkerRetirements]) {
    const verdict = confirmMarkerIsOwn(markerPath, entry.token);
    if (verdict === "completed") {
      pendingMarkerRetirements.delete(markerPath);
    } else if (verdict === "proceed") {
      try {
        unlinkSync(markerPath);
        pendingMarkerRetirements.delete(markerPath);
        fsyncQuietly(path.dirname(markerPath));
      } catch (error) {
        if (error?.code === "ENOENT") pendingMarkerRetirements.delete(markerPath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery (design D4)
// ---------------------------------------------------------------------------

// Re-observes the lock path against the dead owner snapshot. Kinds:
// gone (the dead lock is provably no longer there), lose (cannot prove it is
// still safe to move), ambiguous (extra evidence next to owner.json) and
// verified (token, dead PID, staleness and contents all hold).
function observeDeadLock(ctx, deadOwner) {
  let stat;
  try {
    stat = lstatSync(ctx.lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "gone" };
    throw error;
  }
  if (!stat.isDirectory()) return { kind: "lose" };
  let owner = null;
  try {
    owner = readCapacityLockOwner(ctx.lockPath);
  } catch {
    owner = null;
  }
  if (!owner) return { kind: "lose" };
  if (owner.owner_token !== deadOwner.owner_token) return { kind: "gone" };
  if (capacityLockOwnerIsAlive(owner.owner_pid)
    || !(Date.now() - Date.parse(owner.created_at) > ctx.staleAfterMs)) {
    return { kind: "lose" };
  }
  let entries;
  try {
    entries = readdirSync(ctx.lockPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "lose" };
    throw error;
  }
  if (entries.some((entry) => !entry.isFile() || entry.name !== CAPACITY_LOCK_OWNER_FILE)) {
    return { kind: "ambiguous" };
  }
  if (entries.length !== 1) return { kind: "lose" };
  return { kind: "verified", stat, owner };
}

function sameOwnerRecord(left, right) {
  return left.schema === right.schema
    && left.owner_pid === right.owner_pid
    && left.owner_token === right.owner_token
    && left.created_at === right.created_at;
}

class RecoveryAborted extends Error {
  constructor(observation) {
    super("capacity lock recovery target changed");
    this.observation = observation;
  }
}

/**
 * Recovers a lock whose owner is dead beyond the stale threshold (design D3, D4).
 * The caller's snapshot only selects which dead owner token to elect for; the lock
 * path is observed again after the election is won and nothing is moved unless it
 * still carries that token. Nothing is ever moved back onto the lock path.
 *
 * Returns "retry" (the lock path changed, observe it again now) or "wait" (this
 * round was lost; the caller keeps polling).
 */
function recoverStaleCapacityLock(ctx, snapshot) {
  const deadOwner = snapshot?.owner;
  if (!deadOwner || capacityLockOwnerIsAlive(deadOwner.owner_pid)) {
    throw capacityError("dispatch capacity stale-lock owner evidence is ambiguous or live");
  }
  if (ctx.electionsDisabled) return "wait";
  retryPendingMarkerRetirements();
  const rootDir = ctx.root;
  const targetToken = deadOwner.owner_token;
  // The dead lock as the caller observed it; every unexpected error below carries it.
  const observedLock = lockIdentity(snapshot.stat, deadOwner);
  const generation = electionGeneration(ctx, targetToken, observedLock);
  if (generation === null) return "wait";
  const marker = publishRepairMarker(ctx, targetToken, generation, observedLock);
  if (marker === null) return "wait";
  // From here the marker must be withdrawn on every exit. Nothing that can throw
  // sits between the successful link and this try.
  let provenGone = false;
  let step = "repair-elected";
  try {
    checkpoint(ctx, "repair-elected");
    step = "repair-candidate-removed";
    try {
      unlinkSync(marker.candidatePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        emitEvent(ctx, "residue-deferred", { step: "repair-candidate-removed", code: error?.code ?? null, detail: { item: path.basename(marker.candidatePath) } });
      }
    }
    fsyncDirectory(rootDir);
    checkpoint(ctx, "repair-candidate-removed");

    const settle = (observation) => {
      if (observation.kind === "gone") {
        provenGone = true;
        return "retry";
      }
      if (observation.kind === "ambiguous") {
        throw capacityError("dispatch capacity stale lock contains ambiguous evidence");
      }
      return "wait";
    };

    step = "repair-observe";
    const verified = observeDeadLock(ctx, deadOwner);
    if (verified.kind !== "verified") return settle(verified);
    const deadIdentity = lockIdentity(verified.stat, verified.owner);
    step = "repair-target-verified";
    const recorded = emitEvent(ctx, "repair-target-verified", { step: "repair-target-verified", lock: deadIdentity });
    if (!recorded) {
      // The dead owner's identity has no durable place to go, so its only record is not touched.
      ctx.electionsDisabled = true;
      return "wait";
    }
    checkpoint(ctx, "repair-target-verified");

    const recoveryPath = path.join(rootDir, `${CAPACITY_LOCK_DIRECTORY}.recovery.${process.pid}.${randomUUID()}`);
    const recoveryRename = ctx.options.recoveryRename ?? renameSync;
    let moved;
    step = "repair-quarantine-rename";
    try {
      moved = retryBounded({
        action: () => recoveryRename(ctx.lockPath, recoveryPath),
        isRetryable: (error) => isRenameEperm(ctx.platform, error),
        beforeRetry: () => {
          const again = observeDeadLock(ctx, deadOwner);
          if (again.kind !== "verified"
            || again.stat.dev !== verified.stat.dev
            || again.stat.ino !== verified.stat.ino
            || !sameOwnerRecord(again.owner, verified.owner)) {
            throw new RecoveryAborted(again);
          }
          return "proceed";
        },
        budgetMs: Math.min(CAPACITY_LOCK_RELEASE_RENAME_RETRY_MS, Math.max(0, ctx.deadline - Date.now())),
      });
    } catch (error) {
      if (error instanceof RecoveryAborted) return settle(error.observation);
      throw error;
    }
    if (moved.status === "exhausted") return "wait";
    if (moved.status === "failed") {
      if (moved.error?.code === "ENOENT") {
        provenGone = true;
        return "retry";
      }
      throw moved.error;
    }
    step = "repair-quarantined";
    fsyncDirectory(rootDir);
    checkpoint(ctx, "repair-quarantined");

    step = "repair-quarantine-verified";
    const quarantined = lstatSync(recoveryPath);
    let quarantinedOwner = null;
    try {
      quarantinedOwner = readCapacityLockOwner(recoveryPath);
    } catch {
      quarantinedOwner = null;
    }
    if (!quarantined.isDirectory()
      || quarantined.dev !== verified.stat.dev
      || quarantined.ino !== verified.stat.ino
      || !quarantinedOwner
      || !sameOwnerRecord(quarantinedOwner, verified.owner)) {
      emitEvent(ctx, "repair-quarantine-mismatch", {
        step: "repair-quarantine-verified",
        lock: deadIdentity,
        detail: {
          quarantine: path.basename(recoveryPath),
          expected: deadIdentity,
          actual: lockIdentity(quarantined, quarantinedOwner),
        },
      });
      throw capacityError("dispatch capacity stale-lock identity changed during recovery");
    }
    provenGone = true;
    checkpoint(ctx, "repair-quarantine-verified");
    step = "repair-owner-removed";

    // The lock path is free from here on; a failure to clean the quarantine leaves
    // a residue for the next acquisition and does not undo the recovery.
    let ownerRemoved = false;
    try {
      unlinkSync(path.join(recoveryPath, CAPACITY_LOCK_OWNER_FILE));
      fsyncDirectory(recoveryPath);
      ownerRemoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        emitEvent(ctx, "residue-deferred", { step: "repair-owner-removed", code: error?.code ?? null, detail: { item: path.basename(recoveryPath) } });
      } else {
        ownerRemoved = true;
      }
    }
    if (ownerRemoved) {
      checkpoint(ctx, "repair-owner-removed");
      let quarantineRemoved = false;
      try {
        rmdirSync(recoveryPath);
        fsyncDirectory(rootDir);
        quarantineRemoved = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          emitEvent(ctx, "residue-deferred", { step: "repair-quarantine-removed", code: error?.code ?? null, detail: { item: path.basename(recoveryPath) } });
        } else {
          quarantineRemoved = true;
        }
      }
      if (quarantineRemoved) checkpoint(ctx, "repair-quarantine-removed");
    }
    step = "repair-markers-retired";
    retireMarkers(ctx, marker, targetToken, true, observedLock);
    checkpoint(ctx, "repair-markers-retired");
    return "retry";
  } catch (error) {
    // One record per failure: an error that already carries its step was reported.
    if (!isInjected(ctx, error) && isFileSystemError(error) && error.capacityLockStep === undefined) {
      throw reportUnexpected(ctx, step, error, observedLock);
    }
    throw error;
  } finally {
    retireMarkers(ctx, marker, targetToken, provenGone, observedLock);
    // This process is still alive, so the residue cleanup would not take its candidate file.
    removeQuietly(marker.candidatePath);
  }
}

// ---------------------------------------------------------------------------
// Residue cleanup (design D5)
// ---------------------------------------------------------------------------

function ownerIdentity(owner) {
  return owner ? { owner_pid: owner.owner_pid, owner_token: owner.owner_token, created_at: owner.created_at } : null;
}

// Handles one staging, quarantine or release directory. Returns whether anything
// was removed.
function sweepDirectoryResidue(ctx, entry, creatorPid, isStage) {
  if (capacityLockOwnerIsAlive(creatorPid)) return false;
  const item = entry.name;
  const preserve = (reason) => {
    emitEvent(ctx, "residue-preserved", { step: "residue-sweep", detail: { item, reason } });
    return false;
  };
  if (!entry.isDirectory()) return preserve("not-a-directory");
  const directory = path.join(ctx.root, item);
  const children = readdirSync(directory, { withFileTypes: true });
  if (children.some((child) => !child.isFile() || child.name !== CAPACITY_LOCK_OWNER_FILE)) {
    return preserve("unexpected-entries");
  }
  if (children.length === 0) {
    rmdirSync(directory);
    return true;
  }
  // Content that was read but is not a valid record is malformed; a failure to read
  // it at all (a transient file system error) proves nothing and propagates, so the
  // caller defers the residue. ENOENT there means someone else already handled it.
  let owner = null;
  try {
    owner = readCapacityLockOwner(directory);
  } catch (error) {
    if (error?.classification !== "reviewer_dispatch_capacity_exceeded") throw error;
    owner = null;
  }
  if (!isStage) {
    if (!owner) return preserve("owner-record-invalid");
    if (capacityLockOwnerIsAlive(owner.owner_pid)) return preserve("owner-alive");
  }
  const recorded = emitEvent(ctx, "residue-owner-removing", {
    step: "residue-sweep",
    detail: { item, owner: ownerIdentity(owner) },
  });
  if (!recorded) return false;
  unlinkSync(path.join(directory, CAPACITY_LOCK_OWNER_FILE));
  fsyncDirectory(directory);
  checkpoint(ctx, "sweep-owner-removed");
  rmdirSync(directory);
  return true;
}

function sweepEntry(ctx, entry) {
  const name = entry.name;
  let match = STAGE_NAME.exec(name);
  if (match) return sweepDirectoryResidue(ctx, entry, Number(match[1]), true);
  match = ISOLATION_NAME.exec(name);
  if (match) return sweepDirectoryResidue(ctx, entry, Number(match[1]), false);
  match = CANDIDATE_NAME.exec(name);
  if (match) {
    if (capacityLockOwnerIsAlive(Number(match[1]))) return false;
    unlinkSync(path.join(ctx.root, name));
    return true;
  }
  if (MARKER_NAME.test(name)) {
    const markerPath = path.join(ctx.root, name);
    const record = readRepairMarker(markerPath);
    if (!record) {
      // Its creator is written inside it, so it cannot be proven dead: kept, and said so.
      emitEvent(ctx, "residue-preserved", { step: "residue-sweep", detail: { item: name, reason: "repair-marker-malformed" } });
      return false;
    }
    if (capacityLockOwnerIsAlive(record.repair_pid)) return false;
    unlinkSync(markerPath);
    return true;
  }
  return false;
}

// Runs once per acquisition while the lock is held, so concurrent sweeps are
// serialized and every marker's target is, by then, not on the lock path. A
// residue is removed only when its creator is provably dead; the sweep never
// affects the lock that was just acquired.
function sweepResidue(ctx) {
  let entries;
  try {
    entries = readdirSync(ctx.root, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") reportUnexpected(ctx, "residue-sweep", error);
    return;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(`${CAPACITY_LOCK_DIRECTORY}.`)) continue;
    try {
      if (sweepEntry(ctx, entry)) removed.push(entry.name);
    } catch (error) {
      if (isInjected(ctx, error)) throw error;
      if (error?.code === "ENOENT") continue;
      emitEvent(ctx, "residue-deferred", { step: "residue-sweep", code: error?.code ?? null, detail: { item: entry.name } });
    }
  }
  if (removed.length > 0) {
    try {
      fsyncDirectory(ctx.root);
    } catch (error) {
      reportUnexpected(ctx, "residue-sweep", error, null, { items: removed });
    }
  }
}

// ---------------------------------------------------------------------------
// Release (#3199, design D12)
// ---------------------------------------------------------------------------

// Moves the isolated release directory back onto the lock path only while it
// still carries its owner record: a directory whose record is already gone must
// never become the lock path again (that would make it undecidable for everyone).
// Returns "restored", "lock-present" or "owner-missing".
function restoreCapacityLockAfterUnsafeRecovery(lockPath, recoveryPath) {
  if (!existsSync(path.join(recoveryPath, CAPACITY_LOCK_OWNER_FILE))) return "owner-missing";
  if (existsSync(lockPath)) return "lock-present";
  renameSync(recoveryPath, lockPath);
  fsyncDirectory(path.dirname(lockPath));
  return "restored";
}

// The rename is atomic, so a failed attempt leaves the lock untouched and the
// owner still holds it. Each retry first re-proves that the path is the same
// directory (dev+ino) still carrying this owner's token and PID.
function isolateOwnedCapacityLock(lockPath, releasePath, snapshot, owner, {
  platform = process.platform,
  rename,
  retryMs = CAPACITY_LOCK_RELEASE_RENAME_RETRY_MS,
} = {}) {
  const result = retryBounded({
    action: () => (rename ?? renameSync)(lockPath, releasePath),
    isRetryable: (error) => isRenameEperm(platform, error),
    beforeRetry: () => {
      const retried = lstatSync(lockPath);
      const retriedOwner = readCapacityLockOwner(lockPath);
      if (!retried.isDirectory()
        || retried.dev !== snapshot.dev
        || retried.ino !== snapshot.ino
        || retriedOwner?.owner_token !== owner.owner_token
        || retriedOwner?.owner_pid !== owner.owner_pid) {
        throw capacityError("dispatch capacity lock identity changed during release");
      }
      return "proceed";
    },
    budgetMs: retryMs,
  });
  if (result.status !== "done") throw result.error;
}

function releaseOwnedCapacityLock(rootDir, lockPath, owner, releaseOptions = {}) {
  const snapshot = lstatSync(lockPath);
  if (!snapshot.isDirectory()) {
    throw capacityError("dispatch capacity lock release path is not an exact directory");
  }
  const current = readCapacityLockOwner(lockPath);
  if (!current
    || current.owner_token !== owner.owner_token
    || current.owner_pid !== owner.owner_pid) {
    throw capacityError("dispatch capacity lock release ownership mismatch");
  }
  const releasePath = path.join(
    rootDir,
    `${CAPACITY_LOCK_DIRECTORY}.release.${process.pid}.${owner.owner_token}`
  );
  const { onProtocolEvent, ...renameOptions } = releaseOptions;
  isolateOwnedCapacityLock(lockPath, releasePath, snapshot, owner, renameOptions);
  fsyncDirectory(rootDir);
  try {
    const isolated = lstatSync(releasePath);
    const isolatedOwner = readCapacityLockOwner(releasePath);
    if (!isolated.isDirectory()
      || isolated.dev !== snapshot.dev
      || isolated.ino !== snapshot.ino
      || isolatedOwner?.owner_token !== owner.owner_token
      || isolatedOwner?.owner_pid !== owner.owner_pid) {
      restoreCapacityLockAfterUnsafeRecovery(lockPath, releasePath);
      throw capacityError("dispatch capacity lock identity changed during release");
    }
    const entries = readdirSync(releasePath, { withFileTypes: true });
    if (entries.length !== 1
      || !entries[0].isFile()
      || entries[0].name !== CAPACITY_LOCK_OWNER_FILE) {
      restoreCapacityLockAfterUnsafeRecovery(lockPath, releasePath);
      throw capacityError("dispatch capacity lock contains ambiguous release evidence");
    }
    unlinkSync(path.join(releasePath, CAPACITY_LOCK_OWNER_FILE));
    fsyncDirectory(releasePath);
    rmdirSync(releasePath);
    fsyncDirectory(rootDir);
  } catch (error) {
    if (existsSync(releasePath)
      && restoreCapacityLockAfterUnsafeRecovery(lockPath, releasePath) === "owner-missing") {
      // The owner record is already gone: the lock is released, the emptied
      // directory stays for the residue cleanup, and the original failure surfaces.
      const ctx = { options: { onProtocolEvent }, deadline: Date.now() + CAPACITY_LOCK_EVENT_EAGAIN_MS };
      reportUnexpected(ctx, "release-cleanup", error, null, { item: path.basename(releasePath) });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Acquisition (design D2)
// ---------------------------------------------------------------------------

function removeStage(stage) {
  try {
    unlinkSync(path.join(stage.path, CAPACITY_LOCK_OWNER_FILE));
    fsyncQuietly(stage.path);
  } catch {
    // Best effort; the residue cleanup removes what is left once this process is gone.
  }
  try {
    rmdirSync(stage.path);
    fsyncQuietly(path.dirname(stage.path));
  } catch {
    // Same.
  }
}

// The staging directory and its complete owner record, created once per call.
function createStage(ctx) {
  const owner = {
    schema: CAPACITY_LOCK_OWNER_SCHEMA,
    owner_pid: process.pid,
    owner_token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  const stage = { owner, path: path.join(ctx.root, `${CAPACITY_LOCK_DIRECTORY}.stage.${process.pid}.${owner.owner_token}`) };
  try {
    mkdirSync(stage.path, { mode: 0o700 });
    fsyncDirectory(ctx.root);
    checkpoint(ctx, "stage-created");
    publishCapacityLockOwner(stage.path, owner);
    checkpoint(ctx, "stage-owner-written");
  } catch (error) {
    removeStage(stage);
    if (!isInjected(ctx, error)) reportUnexpected(ctx, "stage-create", error);
    throw error;
  }
  return stage;
}

// Publishes the staging directory as the lock with one atomic rename. Returns
// "published", "exists" (someone else holds the path; observe it) or "retry"
// (win32 EPERM while the path is still free).
function publishStage(ctx, stage) {
  try {
    renameSync(stage.path, ctx.lockPath);
  } catch (error) {
    // The path was occupied when the rename ran. The occupant may already have been
    // released by now, so what a later lstat shows proves nothing: observe it again.
    // A rename onto a non-empty directory always fails, so this costs liveness only.
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return "exists";
    let exists = true;
    try {
      lstatSync(ctx.lockPath);
    } catch (statError) {
      if (statError?.code !== "ENOENT") throw reportUnexpected(ctx, "publish-rename", error);
      exists = false;
    }
    if (exists) return "exists";
    if (isRenameEperm(ctx.platform, error) && Date.now() < ctx.deadline) {
      sleepMs(CAPACITY_LOCK_RELEASE_RENAME_RETRY_INTERVAL_MS);
      return "retry";
    }
    throw reportUnexpected(ctx, "publish-rename", error);
  }
  return "published";
}

function readOwnerOrNull(lockPath) {
  try {
    return readCapacityLockOwner(lockPath);
  } catch {
    return null;
  }
}

function timeoutError(ctx, owner) {
  if (owner) return capacityError("dispatch capacity gate is unavailable; reservation failed closed");
  const error = capacityError(CAPACITY_LOCK_UNDECIDABLE_MESSAGE);
  error.capacityLockManualRemovalPath = ctx.lockPath;
  return error;
}

export function acquireCapacityLock(rootDir, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const waitMs = options.waitMs ?? CAPACITY_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const ctx = createContext(resolvedRoot, options, deadline);
  const lockPath = ctx.lockPath;
  retryPendingMarkerRetirements();
  let stage = null;
  let lostPublication = false;
  try {
    while (true) {
      let stat = null;
      try {
        stat = lstatSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw reportUnexpected(ctx, "lock-observe", error);
      }
      if (stat === null) {
        // A publication that keeps losing while the path looks free still ends at the deadline.
        if (lostPublication && Date.now() >= deadline) throw timeoutError(ctx, true);
        stage ??= createStage(ctx);
        const outcome = publishStage(ctx, stage);
        if (outcome === "exists") lostPublication = true;
        if (outcome === "retry" || outcome === "exists") continue;
        const owner = stage.owner;
        stage = null;
        const release = () => releaseOwnedCapacityLock(resolvedRoot, lockPath, owner, {
          platform: options.platform,
          rename: options.releaseRename,
          retryMs: options.releaseRenameRetryMs,
          onProtocolEvent: options.onProtocolEvent,
        });
        try {
          fsyncDirectory(resolvedRoot);
          checkpoint(ctx, "lock-published");
          sweepResidue(ctx);
        } catch (error) {
          // The lock was published but the call cannot return it: do not leave it held.
          try { release(); } catch { /* the original failure is the one to surface */ }
          if (!isInjected(ctx, error)) reportUnexpected(ctx, "lock-published", error);
          throw error;
        }
        return release;
      }
      if (!stat.isDirectory()) {
        throw capacityError("dispatch capacity lock path is not an exact directory");
      }
      const owner = readOwnerOrNull(lockPath);
      if (owner
        && !capacityLockOwnerIsAlive(owner.owner_pid)
        && Date.now() - Date.parse(owner.created_at) > ctx.staleAfterMs) {
        if (recoverStaleCapacityLock(ctx, { stat, owner }) === "retry") continue;
      }
      if (Date.now() >= deadline) {
        throw timeoutError(ctx, owner);
      }
      sleepMs(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  } finally {
    if (stage !== null) removeStage(stage);
  }
}
