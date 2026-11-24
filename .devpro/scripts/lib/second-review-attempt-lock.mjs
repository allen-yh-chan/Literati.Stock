import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isBlank, nowIso } from "./primitives.mjs";

export function attemptLockPath(contextPath) {
  return `${path.resolve(contextPath)}.attempt.lock`;
}

function writeAttemptOwnerCandidate(candidatePath, owner) {
  const fd = openSync(candidatePath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishAttemptOwner(candidatePath, lockPath, injectedPublisher) {
  if (injectedPublisher) return injectedPublisher(candidatePath, lockPath);
  return linkSync(candidatePath, lockPath);
}

export function readAttemptOwner(lockPath) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
  const expectedKeys = ["attempt_id", "pid", "created_at", "owner_token"];
  if (!owner || typeof owner !== "object" || Array.isArray(owner)
    || Object.keys(owner).length !== expectedKeys.length
    || expectedKeys.some((key, index) => Object.keys(owner)[index] !== key)
    || typeof owner.attempt_id !== "string"
    || isBlank(owner.attempt_id)
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.created_at !== "string"
    || isBlank(owner.created_at)
    || Number.isNaN(Date.parse(owner.created_at))
    || typeof owner.owner_token !== "string"
    || isBlank(owner.owner_token)) {
    return null;
  }
  return owner;
}

export function lockOwnerState(lockPath, options = {}) {
  const owner = readAttemptOwner(lockPath);
  if (!owner) return { state: "malformed", owner: null };
  const signalOwner = options.signalOwner ?? ((pid) => process.kill(pid, 0));
  try {
    signalOwner(owner.pid);
    return { state: "live", owner };
  } catch (error) {
    if (error?.code === "ESRCH") return { state: "dead", owner };
    return { state: "unknown", owner };
  }
}

export function acquireAttemptOwnership(contextPath, attemptId, options = {}) {
  const lockPath = attemptLockPath(contextPath);
  const owner = {
    attempt_id: String(attemptId ?? "unknown-attempt"),
    pid: process.pid,
    created_at: nowIso(),
    owner_token: randomUUID(),
  };
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.owner_token}`;
  try {
    writeAttemptOwnerCandidate(candidatePath, owner);
  } catch (error) {
    try {
      unlinkSync(candidatePath);
    } catch {
      // A failed candidate creation may leave no pathname; cleanup is best effort only.
    }
    return {
      owned: false,
      lockPath,
      owner: null,
      ownerState: "unknown",
      classification: "attempt_lock_primitive_unavailable",
      error: error.message,
    };
  }

  try {
    publishAttemptOwner(candidatePath, lockPath, options.publishLink);
    return { owned: true, lockPath, owner, ownerState: "owned" };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return {
        owned: false,
        lockPath,
        owner: null,
        ownerState: "unknown",
        classification: "attempt_lock_primitive_unavailable",
        error: error.message,
      };
    }
    const existing = lockOwnerState(lockPath, options);
    return {
      owned: false,
      lockPath,
      owner: existing.owner,
      ownerState: existing.state,
      classification: ["live", "unknown"].includes(existing.state)
        ? "projection_attempt_already_active"
        : "projection_attempt_recovery_required",
    };
  } finally {
    try {
      unlinkSync(candidatePath);
    } catch {
      // The published hard link owns the inode; candidate cleanup must not affect it.
    }
  }
}

export function releaseAttemptOwnership(ownership, options = {}) {
  if (!ownership?.owned) return false;
  const current = readAttemptOwner(ownership.lockPath);
  if (!current) return false;
  if (current.owner_token !== ownership.owner.owner_token) return false;
  const tombstonePath = `${ownership.lockPath}.release-${process.pid}-${ownership.owner.owner_token}-${randomUUID()}`;
  const renamePath = options.renamePath ?? renameSync;
  const unlinkPath = options.unlinkPath ?? unlinkSync;
  try {
    renamePath(ownership.lockPath, tombstonePath);
  } catch {
    return false;
  }
  const tombstoneOwner = readAttemptOwner(tombstonePath);
  if (tombstoneOwner?.owner_token !== ownership.owner.owner_token) {
    try {
      if (!existsSync(ownership.lockPath)) renamePath(tombstonePath, ownership.lockPath);
    } catch {
      // Preserve an unverified tombstone rather than unlinking another owner's record.
    }
    return false;
  }
  try {
    unlinkPath(tombstonePath);
    return true;
  } catch {
    return false;
  }
}
