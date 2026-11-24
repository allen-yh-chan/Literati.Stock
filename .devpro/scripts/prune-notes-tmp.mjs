#!/usr/bin/env node
/**
 * prune-notes-tmp.mjs
 *
 * Dry-run by default. Lists stale non-state files under the main-checkout
 * notes/tmp directory and the cross-review carrier root notes/cross-review;
 * deletes only with --exec. Hook state under notes/tmp/state/** is
 * owner-managed and is always skipped.
 *
 * The dry-run prints the time point it measured age from and the exact
 * `--exec --as-of <time>` command. --exec requires --as-of, so it measures age
 * from the time the user saw in the dry-run instead of re-measuring at exec time:
 * a file that turned stale after the dry-run is not deleted, and neither is a
 * notes/tmp file whose ctime, or the ctime of a directory between notes/tmp and
 * it, is later than that time (created, moved in, or modified after the dry-run,
 * even with an old mtime; moving a directory changes only the directory's ctime).
 *
 * Usage:
 *   node .devpro/scripts/prune-notes-tmp.mjs
 *   node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of <time printed by the dry-run>
 *   node .devpro/scripts/prune-notes-tmp.mjs --max-age-minutes 60
 *   node .devpro/scripts/prune-notes-tmp.mjs --limit 0
 *   node .devpro/scripts/prune-notes-tmp.mjs --include-unknown
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { probeGitCommonDir } from "./hooks/lib/repo-state-identity.mjs";
import { readDispatchEvidence as readCanonicalDispatchEvidence } from "./hooks/lib/second-review-control-evidence.mjs";
import { isPlainObject } from "./lib/primitives.mjs";
import {
  acquireAttemptOwnership,
  attemptLockPath,
  lockOwnerState,
  releaseAttemptOwnership,
} from "./lib/second-review-attempt-lock.mjs";

const DEFAULT_MAX_AGE_MINUTES = 60;
const DEFAULT_LIST_LIMIT = 50;
const MAX_ATTEMPT_ID_BYTES = 128;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_ATTEMPT_ENTRIES = 4096;
const MAX_ATTEMPT_DEPTH = 32;
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function printUsage() {
  console.error("Usage: node .devpro/scripts/prune-notes-tmp.mjs [--exec --as-of <time>] [--max-age-minutes <n>] [--limit <n>] [--include-unknown]");
  console.error("Dry-run is the default and prints the --exec --as-of command to run after approval.");
  console.error("--exec deletes stale known non-state files, measuring age from --as-of.");
  console.error("Default listing is bounded to 50 files; use --limit 0 to list all.");
}

function parseArgs(args) {
  const options = {
    exec: false,
    includeUnknown: false,
    limit: DEFAULT_LIST_LIMIT,
    maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES,
    asOfMs: null,
  };
  const fail = (message) => {
    console.error(message);
    printUsage();
    process.exit(1);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--exec") {
      options.exec = true;
      continue;
    }
    if (arg === "--include-unknown") {
      options.includeUnknown = true;
      continue;
    }
    if (arg === "--max-age-minutes") {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0) {
        console.error("--max-age-minutes requires a positive integer");
        printUsage();
        process.exit(1);
      }
      options.maxAgeMinutes = Number(raw);
      continue;
    }
    if (arg === "--as-of") {
      const raw = args[++i];
      const parsed = raw && AS_OF_RE.test(raw) ? Date.parse(raw) : NaN;
      // Date.parse normalizes impossible dates (Feb 30 -> Mar 2); the round trip must keep them.
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== raw.slice(0, 19)) fail("--as-of requires an ISO 8601 UTC time, as printed by the dry-run (e.g. 2026-11-11T08:30:00.000Z)");
      if (parsed > Date.now()) fail("--as-of must not be later than now; copy the time printed by the dry-run");
      options.asOfMs = parsed;
      continue;
    }
    if (arg === "--limit") {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw)) {
        console.error("--limit requires a non-negative integer (0 = all)");
        printUsage();
        process.exit(1);
      }
      options.limit = Number(raw);
      continue;
    }
    if (arg === "--dry-run") {
      console.error("Unsupported option: --dry-run");
      console.error("Dry-run is the default no-argument mode.");
      printUsage();
      process.exit(1);
    }
    console.error(`Unknown option: ${arg}`);
    printUsage();
    process.exit(1);
  }

  if (options.exec && options.asOfMs === null) {
    fail("--exec requires --as-of <time>; run the dry-run first (node .devpro/scripts/prune-notes-tmp.mjs) and, after approval, run the --exec command it prints");
  }
  return options;
}

// The command the dry-run hands over: same scope options, age measured from the dry-run's time.
function execCommandFor(options, nowMs) {
  const parts = ["node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of", new Date(nowMs).toISOString()];
  if (options.maxAgeMinutes !== DEFAULT_MAX_AGE_MINUTES) parts.push(`--max-age-minutes ${options.maxAgeMinutes}`);
  if (options.includeUnknown) parts.push("--include-unknown");
  return parts.join(" ");
}

function repoRootFromCommonDir() {
  // Shared memoized probe; this call site keeps its original disposition of
  // exiting with a human-readable message rather than raising.
  const { ok, commonDir } = probeGitCommonDir();
  if (!ok) {
    console.error("prune-notes-tmp: not inside a git repository");
    process.exit(1);
  }
  return path.dirname(commonDir);
}

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

function classifyKnownTmpFile(relPath) {
  const rel = toPosix(relPath);
  const base = path.posix.basename(rel);
  const lower = base.toLowerCase();

  if (rel === "state" || rel.startsWith("state/")) return "state";

  if (
    lower.endsWith(".md") ||
    lower.endsWith(".json") ||
    /^\.cross-model-sticky-/.test(base) ||
    /^sticky-credential-gate-/.test(base) ||
    /^sticky-write-result/.test(base)
  ) {
    return "body";
  }

  if (
    lower.endsWith(".log") ||
    lower.endsWith(".out") ||
    lower.endsWith(".tap") ||
    lower.endsWith(".ndjson") ||
    lower.endsWith(".time") ||
    /^devpro-out\./.test(base) ||
    /^one-test\./.test(base)
  ) {
    return "log";
  }

  if (
    /(^|[-_.])(artifact|packet|payload|probe|poc|scratch|candidate|timing|refresh|review|test|suite|openspec|validate|run)([-_.]|$)/i.test(base)
  ) {
    return "artifact";
  }

  return "unknown";
}

async function walkFiles(root, dir = root, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);
    const rel = toPosix(relPath);
    if (rel === "state" || rel.startsWith("state/")) {
      if (entry.isDirectory()) await walkFiles(root, fullPath, out);
      else if (entry.isFile()) out.push({ fullPath, relPath, state: true });
      continue;
    }
    if (entry.isDirectory()) {
      await walkFiles(root, fullPath, out);
      continue;
    }
    if (entry.isFile()) out.push({ fullPath, relPath, state: false });
  }
  return out;
}

// Newest ctime of the file and of each directory between root (exclusive) and the file.
// root itself is left out: other sessions keep adding files to it.
async function newestPathCtimeMs(root, fullPath, fileCtimeMs, dirCtimeCache) {
  let newest = fileCtimeMs;
  for (let dir = path.dirname(fullPath); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    if (!dirCtimeCache.has(dir)) dirCtimeCache.set(dir, (await fs.lstat(dir)).ctimeMs);
    newest = Math.max(newest, dirCtimeCache.get(dir));
  }
  return newest;
}

async function removeEmptyDirs(root, dir = root) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "state" && dir === root) continue;
    await removeEmptyDirs(root, path.join(dir, entry.name));
  }

  if (dir === root) return;
  try {
    await fs.rmdir(dir);
  } catch {
    // Non-empty or already removed.
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function summarize(files) {
  return files.reduce((acc, file) => {
    acc.count += 1;
    acc.bytes += file.size;
    acc.categories[file.category] = (acc.categories[file.category] || 0) + 1;
    return acc;
  }, { count: 0, bytes: 0, categories: {} });
}

function printFileList(title, files, limit) {
  if (files.length === 0) return;
  const shown = limit === 0 ? files : files.slice(0, limit);
  console.log(title);
  for (const file of shown) {
    console.log(`  ${file.category.padEnd(8)} ${String(file.size).padStart(8)} B  ${file.rel}`);
  }
  if (shown.length < files.length) {
    console.log(`  ... ${files.length - shown.length} more not shown; use --limit 0 to list all`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedAttemptId(name) {
  const value = String(name ?? "unknown-attempt");
  if (Buffer.byteLength(value, "utf8") <= MAX_ATTEMPT_ID_BYTES) return value;
  let bounded = "";
  for (const character of value) {
    if (Buffer.byteLength(`${bounded}${character}`, "utf8") > MAX_ATTEMPT_ID_BYTES) break;
    bounded += character;
  }
  return bounded || "unknown-attempt";
}

function attemptOutcome(attemptId, classification, reason, bytes = 0) {
  return {
    attempt_id: boundedAttemptId(attemptId),
    classification,
    reason,
    bytes,
  };
}

function isWithinRoot(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function readAttemptContext(attemptDir, attemptId, {
  trustedEvidenceRoot,
}) {
  const contextPath = path.join(attemptDir, "observability-context.json");
  const contextStat = await fs.lstat(contextPath);
  if (!contextStat.isFile() || contextStat.size <= 0 || contextStat.size > MAX_CONTEXT_BYTES) {
    throw new Error("context-shape-invalid");
  }
  const bytes = await fs.readFile(contextPath);
  let context;
  try {
    context = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("context-json-invalid");
  }
  if (!isPlainObject(context)
    || context.attempt_id !== attemptId
    || !/^[\x21-\x7e]{1,128}$/.test(String(context.dispatch_id ?? ""))
    || typeof context.context_path !== "string"
    || !path.isAbsolute(context.context_path)
    || typeof context.observability_context_path !== "string"
    || !path.isAbsolute(context.observability_context_path)
    || typeof context.packet_path !== "string"
    || !path.isAbsolute(context.packet_path)
    || typeof context.control_evidence_root !== "string"
    || !path.isAbsolute(context.control_evidence_root)
    || !trustedEvidenceRoot) {
    throw new Error("context-binding-invalid");
  }
  const declaredEvidenceRoot = await fs.realpath(path.resolve(context.control_evidence_root));
  if (declaredEvidenceRoot !== trustedEvidenceRoot) {
    throw new Error("context-binding-invalid");
  }
  const resolvedAttemptDir = await fs.realpath(attemptDir);
  const resolvedContextPath = await fs.realpath(contextPath);
  const declaredContextPath = await fs.realpath(path.resolve(context.context_path));
  const declaredObservabilityPath = await fs.realpath(path.resolve(context.observability_context_path));
  const resolvedPacketPath = await fs.realpath(path.resolve(context.packet_path));
  if (declaredContextPath !== resolvedContextPath
    || declaredObservabilityPath !== resolvedContextPath
    || !isWithinRoot(resolvedAttemptDir, resolvedPacketPath)) {
    throw new Error("context-binding-invalid");
  }
  return { context, contextPath, resolvedPacketPath, trustedEvidenceRoot };
}

async function inventoryAttempt(attemptDir, lockPath) {
  const inventory = [];
  const lockBase = path.basename(lockPath);
  const isEphemeralLock = (entryPath) => {
    if (path.dirname(entryPath) !== path.dirname(lockPath)) return false;
    const base = path.basename(entryPath);
    return base === lockBase
      || base.startsWith(`${lockBase}.candidate-`)
      || base.startsWith(`${lockBase}.release-`);
  };
  const visit = async (directory, depth) => {
    if (depth > MAX_ATTEMPT_DEPTH) throw new Error("inventory-depth-exceeded");
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      const entryPath = path.join(directory, entry.name);
      if (isEphemeralLock(entryPath)) continue;
      if (inventory.length >= MAX_ATTEMPT_ENTRIES) {
        throw new Error("inventory-entry-limit-exceeded");
      }
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("inventory-entry-shape-invalid");
      }
      inventory.push({ path: await fs.realpath(entryPath), stat });
      if (stat.isDirectory()) await visit(entryPath, depth + 1);
    }
  };
  await visit(attemptDir, 1);
  return inventory;
}

async function validateTerminalAttempt({
  attemptId,
  context,
  controlEvidenceRoot,
  inventory,
  packetPath,
  readDispatchEvidence,
}) {
  const packetEntry = inventory.find((entry) => entry.path === packetPath);
  if (!packetEntry?.stat.isFile()) throw new Error("packet-carrier-invalid");
  const evidence = readDispatchEvidence({
    rootDir: controlEvidenceRoot,
    dispatchId: context.dispatch_id,
  });
  const dispatch = evidence?.dispatch;
  if (!dispatch
    || dispatch.attempt_id !== attemptId
    || dispatch.dispatch_id !== context.dispatch_id
    || dispatch.previous_dispatch_id !== context.previous_dispatch_id
    || dispatch.repository_slug !== context.repository_slug
    || dispatch.pr_number !== context.pr_number
    || dispatch.head_ref_oid !== context.head_ref_oid
    || dispatch.carrier_root_id !== sha256(
      Buffer.from(path.dirname(context.observability_context_path), "utf8")
    )
    || dispatch.packet_sha256 !== sha256(await fs.readFile(packetPath))) {
    throw new Error("dispatch-binding-invalid");
  }
  return Boolean(evidence.completion || evidence.terminal);
}

async function releaseOwnedAttempt(ownership) {
  return releaseAttemptOwnership(ownership);
}

async function evaluateAttempt(attemptDir, attemptId, options, dependencies) {
  const contextPath = path.join(attemptDir, "observability-context.json");
  const lockPath = attemptLockPath(contextPath);
  let ownership = null;
  let inventory = null;

  try {
    const attemptStat = await fs.lstat(attemptDir);
    if (!attemptStat.isDirectory() || attemptStat.isSymbolicLink()) {
      return attemptOutcome(attemptId, "invalid-evidence-skipped", "attempt-root-shape-invalid");
    }
  } catch {
    return attemptOutcome(attemptId, "invalid-evidence-skipped", "attempt-root-unreadable");
  }

  if (options.execute) {
    ownership = acquireAttemptOwnership(contextPath, attemptId, {
      signalOwner: dependencies.signalOwner,
    });
    if (!ownership.owned) {
      if (ownership.classification === "projection_attempt_already_active"
        && ["live", "unknown"].includes(ownership.ownerState)) {
        return attemptOutcome(attemptId, "active-skipped", `owner-${ownership.ownerState}`);
      }
      return attemptOutcome(
        attemptId,
        "invalid-evidence-skipped",
        ownership.ownerState === "dead"
          ? "owner-dead"
          : ownership.classification === "attempt_lock_primitive_unavailable"
            ? "ownership-primitive-unavailable"
            : "owner-evidence-invalid"
      );
    }
  } else {
    try {
      const lockStat = await fs.lstat(lockPath);
      if (!lockStat.isFile()) {
        return attemptOutcome(attemptId, "invalid-evidence-skipped", "owner-evidence-invalid");
      }
      const existing = lockOwnerState(lockPath, { signalOwner: dependencies.signalOwner });
      if (["live", "unknown"].includes(existing.state)) {
        return attemptOutcome(attemptId, "active-skipped", `owner-${existing.state}`);
      }
      return attemptOutcome(
        attemptId,
        "invalid-evidence-skipped",
        existing.state === "dead" ? "owner-dead" : "owner-evidence-invalid"
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return attemptOutcome(attemptId, "invalid-evidence-skipped", "owner-inspection-failed");
      }
    }
  }

  try {
    let context;
    let controlEvidenceRoot;
    let resolvedPacketPath;
    try {
      ({
        context,
        resolvedPacketPath,
        trustedEvidenceRoot: controlEvidenceRoot,
      } = await readAttemptContext(
        attemptDir,
        attemptId,
        dependencies
      ));
      inventory = await inventoryAttempt(attemptDir, lockPath);
    } catch {
      return attemptOutcome(attemptId, "invalid-evidence-skipped", "attempt-inventory-invalid");
    }

    let terminal;
    try {
      terminal = await validateTerminalAttempt({
        attemptId,
        context,
        controlEvidenceRoot,
        inventory,
        packetPath: resolvedPacketPath,
        readDispatchEvidence: dependencies.readDispatchEvidence,
      });
    } catch {
      return attemptOutcome(attemptId, "invalid-evidence-skipped", "control-evidence-invalid");
    }
    const bytes = inventory.reduce(
      (total, entry) => total + (entry.stat.isFile() ? entry.stat.size : 0),
      0
    );
    if (!terminal) {
      return attemptOutcome(attemptId, "nonterminal-skipped", "terminal-receipt-absent", bytes);
    }
    const cutoffMs = options.nowMs - options.maxAgeMinutes * 60_000;
    if (inventory.some((entry) => entry.stat.mtimeMs > cutoffMs)) {
      return attemptOutcome(attemptId, "ttl-skipped", "persistent-entry-fresh", bytes);
    }
    if (!options.execute) {
      return attemptOutcome(attemptId, "delete-planned", "terminal-expired-delete-planned", bytes);
    }

    try {
      await dependencies.removeAttemptRoot(attemptDir);
    } catch (error) {
      const failure = new Error(`attempt cleanup failed for ${boundedAttemptId(attemptId)}: ${error.message}`);
      failure.cause = error;
      failure.publicMessage = `attempt-root-remove-failed for ${boundedAttemptId(attemptId)}`;
      throw failure;
    }
    ownership = null;
    return attemptOutcome(attemptId, "deleted", "terminal-expired-removed", bytes);
  } finally {
    if (ownership?.owned) await releaseOwnedAttempt(ownership);
  }
}

export async function __testCrossReviewAttemptPlanner({
  carrierRoot,
  execute,
  limit,
  maxAgeMinutes,
  nowMs,
}, {
  readDispatchEvidence = readCanonicalDispatchEvidence,
  signalOwner = (pid) => process.kill(pid, 0),
  removeAttemptRoot = (attemptDir) => fs.rm(attemptDir, { recursive: true, force: false }),
} = {}) {
  if (typeof carrierRoot !== "string"
    || !path.isAbsolute(carrierRoot)
    || typeof execute !== "boolean"
    || !Number.isInteger(limit)
    || limit < 0
    || !Number.isInteger(maxAgeMinutes)
    || maxAgeMinutes <= 0
    || !Number.isFinite(nowMs)) {
    throw new Error("cross-review attempt planner options are invalid");
  }
  const resolvedRoot = path.resolve(carrierRoot);
  const attempts = [];
  const removalErrors = [];
  let rootStat;
  try {
    rootStat = await fs.lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { attempts, limit };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("cross-review carrier root must be a non-symlink directory");
  }
  const canonicalRoot = await fs.realpath(resolvedRoot);
  const evidenceTail = path.join("tmp", "state", "devpro-second-review-control-evidence");
  const canonicalEvidenceRoot = path.join(path.dirname(canonicalRoot), evidenceTail);
  let trustedEvidenceRoot = null;
  try {
    const evidenceRealpath = await fs.realpath(canonicalEvidenceRoot);
    if (evidenceRealpath === path.resolve(canonicalEvidenceRoot)) {
      trustedEvidenceRoot = evidenceRealpath;
    }
  } catch {
    // Missing or redirected canonical evidence cannot authorize deletion.
  }
  const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const attemptId = entry.name;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      attempts.push(attemptOutcome(
        attemptId,
        "invalid-evidence-skipped",
        "attempt-root-shape-invalid"
      ));
      continue;
    }
    if (!/^[\x21-\x7e]{1,128}$/.test(attemptId)) {
      attempts.push(attemptOutcome(attemptId, "invalid-evidence-skipped", "attempt-id-invalid"));
      continue;
    }
    try {
      attempts.push(await evaluateAttempt(
        path.join(resolvedRoot, attemptId),
        attemptId,
        { execute: Boolean(execute), limit, maxAgeMinutes, nowMs },
        {
          readDispatchEvidence,
          signalOwner,
          removeAttemptRoot,
          trustedEvidenceRoot,
        }
      ));
    } catch (error) {
      removalErrors.push(error);
    }
  }
  if (removalErrors.length > 0) throw removalErrors[0];
  return { attempts, limit };
}

function printAttemptResults(result, limit) {
  const attempts = result.attempts;
  const counts = attempts.reduce((acc, attempt) => {
    const summary = acc[attempt.classification] ?? { count: 0, bytes: 0 };
    summary.count += 1;
    summary.bytes += attempt.bytes;
    acc[attempt.classification] = summary;
    return acc;
  }, {});
  console.log(`cross-review attempts: ${attempts.length}`);
  for (const classification of Object.keys(counts).sort()) {
    console.log(
      `  ${classification}: ${counts[classification].count} attempts (${formatBytes(counts[classification].bytes)})`
    );
  }
  const shown = limit === 0 ? attempts : attempts.slice(0, limit);
  for (const attempt of shown) {
    console.log(`  ${attempt.classification} ${attempt.attempt_id} ${attempt.reason}`);
  }
  if (shown.length < attempts.length) {
    console.log(`  ... ${attempts.length - shown.length} more attempts not shown; use --limit 0 to list all`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFromCommonDir();
  const tmpRoot = path.join(repoRoot, "notes", "tmp");
  // Second-review carriers moved out of notes/tmp so the reviewer cannot re-read its
  // own packet from its writable root (issue #1735). They are attempt-owned rather than
  // file-owned, so this pruner evaluates that root through the independent planner below.
  const carrierRoot = path.join(repoRoot, "notes", "cross-review");
  // One time point for notes/tmp files and cross-review attempts alike.
  const nowMs = options.asOfMs ?? Date.now();
  const cutoffMs = nowMs - options.maxAgeMinutes * 60_000;
  // A file whose ctime (or a parent directory's, below notes/tmp) is after the time point
  // was not in notes/tmp in this form at the dry-run.
  // The time point has millisecond precision, so compare ctime at the same precision.
  const isStale = (entry) => entry.mtimeMs <= cutoffMs && Math.floor(entry.ctimeMs) <= nowMs;
  let tmpExists = false;
  try {
    const tmpStat = await fs.lstat(tmpRoot);
    if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) {
      throw new Error("notes/tmp prune root must be a non-symlink directory");
    }
    tmpExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const attemptResult = await __testCrossReviewAttemptPlanner({
    carrierRoot,
    execute: options.exec,
    limit: options.limit,
    maxAgeMinutes: options.maxAgeMinutes,
    nowMs,
  });
  const files = tmpExists
    ? (await walkFiles(tmpRoot)).map((file) => ({ ...file, displayPrefix: null }))
    : [];
  const staleKnown = [];
  const freshKnown = [];
  const unknown = [];
  let stateFileCount = 0;

  const dirCtimeCache = new Map();
  for (const file of files) {
    const rel = toPosix(file.relPath);
    if (file.state) {
      stateFileCount += 1;
      continue;
    }
    const category = classifyKnownTmpFile(rel);
    const stat = await fs.stat(file.fullPath);
    const entry = {
      ...file,
      rel: file.displayPrefix === null ? rel : path.posix.join(file.displayPrefix, rel),
      category,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: await newestPathCtimeMs(tmpRoot, file.fullPath, stat.ctimeMs, dirCtimeCache),
    };
    if (category === "unknown") {
      unknown.push(entry);
      continue;
    }
    if (isStale(entry)) staleKnown.push(entry);
    else freshKnown.push(entry);
  }

  const staleUnknown = unknown.filter(isStale);
  const freshUnknown = unknown.filter((entry) => !isStale(entry));
  const skippedUnknown = options.includeUnknown ? freshUnknown : unknown;
  const executableCandidates = options.includeUnknown
    ? staleKnown.concat(staleUnknown)
    : staleKnown;
  const summary = summarize(executableCandidates);
  const unknownSummary = summarize(skippedUnknown);

  console.log(`notes/tmp prune ${options.exec ? "exec" : "dry-run"}`);
  console.log(`root: ${tmpRoot}`);
  console.log(`carrier root: ${carrierRoot}`);
  console.log(`as of: ${new Date(nowMs).toISOString()}`);
  console.log(`max age: ${options.maxAgeMinutes} minutes`);
  console.log(`state skipped: ${stateFileCount} files`);
  console.log(`fresh known skipped: ${freshKnown.length} files`);
  console.log(`unknown skipped: ${skippedUnknown.length} files (${formatBytes(unknownSummary.bytes)})`);
  console.log(`candidates: ${summary.count} files (${formatBytes(summary.bytes)})`);
  console.log(`list limit: ${options.limit === 0 ? "all" : options.limit}`);
  for (const category of Object.keys(summary.categories).sort()) {
    console.log(`  ${category}: ${summary.categories[category]}`);
  }
  printFileList("candidate files:", executableCandidates, options.limit);
  if (!options.includeUnknown) printFileList("unknown files (not deleted by default):", unknown, options.limit);
  printAttemptResults(attemptResult, options.limit);

  if (!options.exec) {
    console.log("dry-run only; after explicit cleanup approval, delete exactly this scope with:");
    console.log(`  ${execCommandFor(options, nowMs)}`);
    return;
  }

  for (const file of executableCandidates) {
    await fs.rm(file.fullPath, { force: true });
  }
  if (tmpExists) await removeEmptyDirs(tmpRoot);
  console.log(`deleted: ${summary.count} files (${formatBytes(summary.bytes)})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`prune-notes-tmp failed: ${err.publicMessage ?? err.message}`);
    process.exit(1);
  });
}
