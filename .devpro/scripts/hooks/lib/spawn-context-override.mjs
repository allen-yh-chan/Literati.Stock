import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { durableWrite, fsyncDirectory } from "../../lib/durable-fs.mjs";
import { getRepoRoot } from "./git-utils.mjs";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";

export const SPAWN_CONTEXT_OVERRIDE_TTL_MS = 10 * 60 * 1000;
export const ISSUER_LOCK_STALE_MS = 30_000;
const MAX_REASON_CHARS = 500;
const SCHEMA_VERSION = 1;

function canonicalCwd(cwd) {
  const resolved = path.resolve(cwd);
  const worktreeRoot = getRepoRoot(resolved) || resolved;
  try { return realpathSync(worktreeRoot); } catch { return worktreeRoot; }
}

export function cwdKeyForSpawnContextOverride(cwd = process.cwd()) {
  return createHash("sha256").update(canonicalCwd(cwd)).digest("hex");
}

export function spawnContextOverrideStateDir(cwd = process.cwd()) {
  return defaultRepoStateDir("devpro-spawn-context-override", cwd);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}


function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function lockPrefix(key) { return `issuer-${key}.lock.`; }

function reapStaleIssuerLocks(stateDir, key, nowMs) {
  for (const name of readdirSync(stateDir)) {
    if (!name.startsWith(lockPrefix(key))) continue;
    const file = path.join(stateDir, name);
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (nowMs - stat.mtimeMs <= ISSUER_LOCK_STALE_MS) continue;
    let record;
    try { record = JSON.parse(readFileSync(file, "utf8")); } catch { record = null; }
    if (record && ownerAlive(record.owner_pid)) continue;
    try { unlinkSync(file); fsyncDirectory(stateDir); } catch { /* another reaper may win */ }
  }
}

function acquireIssuerLock(stateDir, key, nowMs) {
  ensureDir(stateDir);
  reapStaleIssuerLocks(stateDir, key, nowMs);
  const file = path.join(stateDir, `${lockPrefix(key)}${randomUUID()}`);
  durableWrite(file, JSON.stringify({ owner_pid: process.pid, created_at_ms: nowMs }));
  const contenders = readdirSync(stateDir).filter((name) => name.startsWith(lockPrefix(key)) && path.join(stateDir, name) !== file);
  if (contenders.length > 0) {
    try { unlinkSync(file); fsyncDirectory(stateDir); } catch { /* fail closed below */ }
    return { ok: false, status: "issuer_busy" };
  }
  return { ok: true, file };
}

function releaseIssuerLock(lock, stateDir) {
  if (!lock?.file) return;
  try { unlinkSync(lock.file); fsyncDirectory(stateDir); } catch { /* stale+dead reaper handles crash residue */ }
}

function activeDir(stateDir, key) { return path.join(stateDir, `active-${key}`); }
function recoveryPendingDir(stateDir, key) { return path.join(stateDir, `recovery-pending-${key}`); }

function clearRecoveryPending(pending, stateDir) {
  rmdirSync(pending);
  fsyncDirectory(stateDir);
}

function readRecord(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, "override.json"), "utf8")); } catch { return null; }
}

function validateRecord(record, key, nowMs) {
  if (!record || record.schema_version !== SCHEMA_VERSION) return "malformed";
  if (!/^[0-9a-f-]{36}$/.test(String(record.nonce || ""))) return "malformed";
  if (record.cwd_key !== key) return "cwd_mismatch";
  if (typeof record.reason !== "string" || !record.reason.trim() || record.reason.length > MAX_REASON_CHARS || /[\r\n]/.test(record.reason)) return "malformed";
  if (typeof record.created_at !== "string" || typeof record.expires_at !== "string") return "malformed";
  const createdAtMs = Date.parse(record.created_at);
  const expiresAtMs = Date.parse(record.expires_at);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) return "malformed";
  if (new Date(createdAtMs).toISOString() !== record.created_at || new Date(expiresAtMs).toISOString() !== record.expires_at) return "malformed";
  if (expiresAtMs - createdAtMs !== SPAWN_CONTEXT_OVERRIDE_TTL_MS) return "malformed";
  if (!Number.isFinite(nowMs) || expiresAtMs <= nowMs) return "expired";
  return "valid";
}

function archiveClaim({ claimDir, stateDir, record, disposition, fsyncDirectoryFn = fsyncDirectory }) {
  const auditDir = path.join(stateDir, "audit");
  ensureDir(auditDir);
  const nonce = /^[0-9a-f-]{36}$/.test(String(record?.nonce || "")) ? record.nonce : randomUUID();
  const target = path.join(auditDir, `${nonce}.${disposition}`);
  renameSync(claimDir, target);
  fsyncDirectoryFn(auditDir);
  fsyncDirectoryFn(stateDir);
  return target;
}

export function issueSpawnContextOverride({ cwd = process.cwd(), stateDir = spawnContextOverrideStateDir(cwd), reason, nowMs = Date.now() } = {}) {
  const normalizedReason = typeof reason === "string" ? reason.trim() : "";
  if (!normalizedReason || normalizedReason.length > MAX_REASON_CHARS || /[\r\n]/.test(normalizedReason)) return { ok: false, status: "invalid_reason" };
  if (!Number.isFinite(nowMs)) return { ok: false, status: "invalid_clock" };
  const key = cwdKeyForSpawnContextOverride(cwd);
  let lock;
  try {
    lock = acquireIssuerLock(stateDir, key, nowMs);
    if (!lock.ok) return lock;
    const active = activeDir(stateDir, key);
    const pending = recoveryPendingDir(stateDir, key);
    if (existsSync(pending)) return { ok: false, status: "recovery_pending" };
    if (existsSync(active)) {
      const existing = readRecord(active);
      if (validateRecord(existing, key, nowMs) === "valid") return { ok: false, status: "active_exists" };
      mkdirSync(pending, { mode: 0o700 });
      fsyncDirectory(stateDir);
      const recovery = path.join(stateDir, `recovery-${randomUUID()}`);
      try { renameSync(active, recovery); } catch (error) {
        if (error?.code !== "ENOENT") return { ok: false, status: "recovery_failed" };
        try { clearRecoveryPending(pending, stateDir); }
        catch { return { ok: false, status: "recovery_failed" }; }
      }
      if (existsSync(recovery)) {
        try { archiveClaim({ claimDir: recovery, stateDir, record: existing, disposition: "rejected" }); }
        catch { return { ok: false, status: "recovery_failed" }; }
        try { clearRecoveryPending(pending, stateDir); }
        catch { return { ok: false, status: "recovery_failed" }; }
      }
    }
    const nonce = randomUUID();
    const candidate = path.join(stateDir, `candidate-${nonce}`);
    mkdirSync(candidate, { mode: 0o700 });
    const record = {
      schema_version: SCHEMA_VERSION,
      nonce,
      cwd_key: key,
      reason: normalizedReason,
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + SPAWN_CONTEXT_OVERRIDE_TTL_MS).toISOString(),
    };
    durableWrite(path.join(candidate, "override.json"), `${JSON.stringify(record)}\n`);
    fsyncDirectory(candidate);
    renameSync(candidate, active);
    fsyncDirectory(stateDir);
    return { ok: true, status: "issued", cwd_key_prefix: key.slice(0, 12), expires_at: record.expires_at };
  } catch {
    return { ok: false, status: "write_failed" };
  } finally {
    releaseIssuerLock(lock, stateDir);
  }
}

export function consumeSpawnContextOverride({ cwd = process.cwd(), stateDir = spawnContextOverrideStateDir(cwd), nowMs = Date.now(), fsyncDirectoryFn = fsyncDirectory } = {}) {
  const key = cwdKeyForSpawnContextOverride(cwd);
  const active = activeDir(stateDir, key);
  const claim = path.join(stateDir, `claim-${randomUUID()}`);
  try { renameSync(active, claim); }
  catch (error) { return { ok: false, status: error?.code === "ENOENT" ? "missing" : "claim_failed" }; }
  const record = readRecord(claim);
  const validity = validateRecord(record, key, nowMs);
  const disposition = validity === "valid" ? "consumed" : "rejected";
  try { archiveClaim({ claimDir: claim, stateDir, record, disposition, fsyncDirectoryFn }); }
  catch { return { ok: false, status: "archive_failed" }; }
  return validity === "valid" ? { ok: true, status: "consumed" } : { ok: false, status: validity };
}
