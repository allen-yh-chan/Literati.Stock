// Native Windows witness for the capacity-lock stale recovery (design D6: W1 to W6, plus the two
// end-to-end recovery cases). The design leaves these Windows file system behaviors unproven; this
// file records what a real Windows host does and fails when an observation is incompatible with the
// protocol's stated disposition, which sends the change back to the design (acceptance gate T12).
//
// Run on a Windows host with only this checkout and Node (no npm packages, no bash):
//   node .devpro/scripts/tests/fix-capacity-lock-stale-recovery-races-native.test.mjs
// Results are printed and written as JSON. Set CAPACITY_LOCK_NATIVE_WITNESS_OUT to a file path to put
// them in the change folder; otherwise they go to the OS temp directory and the path is printed.
// W4 (2) needs powershell.exe or pwsh.exe; its absence fails the test, it is never skipped.
// Other platforms skip every test: these semantics exist only on native Windows.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireCapacityLock } from "../lib/control-evidence-capacity-lock.mjs";
import { createDeadLock, listLockEntries, removeTree } from "./lib/capacity-lock-contender.mjs";

const skip = process.platform === "win32" ? false : "native Windows file system semantics only";
const TIMEOUT = { skip, timeout: 180_000 };
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const TIMEOUT_MESSAGE = "dispatch capacity gate is unavailable; reservation failed closed";
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const tempDirs = [];
const holders = [];
const results = [];

const NODE_HOLDER = [
  "const fs = require('node:fs');",
  "const fd = fs.openSync(process.argv[1], 'r');",
  "process.stdout.write('READY\\n');",
  "const done = () => { fs.closeSync(fd); process.exit(0); };",
  "if (process.argv[2]) { setTimeout(done, Number(process.argv[2])); }",
  "else { process.stdin.on('data', done); process.stdin.on('end', done); }",
].join(" ");

// FileShare.None is what an exclusive scanner does: any other open, delete or rename of the file fails.
const POWERSHELL_HOLDER = [
  "$ErrorActionPreference = 'Stop';",
  "$f = [System.IO.File]::Open($env:CAPACITY_LOCK_WITNESS_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None);",
  "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush();",
  "[void][Console]::In.ReadLine();",
  "$f.Close()",
].join(" ");

function sleepMs(ms) {
  Atomics.wait(sleepBuffer, 0, 0, Math.max(1, ms));
}

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `capacity-lock-native-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function attempt(action) {
  try {
    action();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, syscall: error?.syscall ?? null, errno: error?.errno ?? null };
  }
}

// The protocol's own shape: retry every 5ms inside a budget.
function retryWithin(budgetMs, action) {
  const limit = Date.now() + budgetMs;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const outcome = attempt(action);
    if (outcome.ok || Date.now() >= limit) return { ...outcome, attempts };
    sleepMs(5);
  }
}

function ownerRecord(pid, token = randomUUID()) {
  return {
    schema: "devpro-second-review-capacity-lock/v1",
    owner_pid: pid,
    owner_token: token,
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
  };
}

function ownerBytes(owner) {
  return Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
}

function exitedPid() {
  return spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid;
}

function startHolder(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`holder not ready in 60s: ${stderr}`)), 60_000);
    child.stdout.on("data", () => {
      if (stdout.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    exited.then((code) => {
      if (!stdout.includes("READY")) {
        clearTimeout(timer);
        reject(new Error(`holder exited ${code} before READY: ${stderr}`));
      }
    }, reject);
  });
  const holder = {
    pid: child.pid,
    ready,
    exited,
    release: () => {
      child.stdin.write("go\n");
      child.stdin.end();
      return exited;
    },
    kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); },
  };
  holders.push(holder);
  return holder;
}

// Holds `file` open with Node's default sharing (delete and rename are allowed on the file itself,
// the containing directory cannot be renamed).
async function holdWithNode(file, holdMs) {
  const holder = startHolder(process.execPath, ["-e", NODE_HOLDER, file, ...(holdMs ? [String(holdMs)] : [])]);
  await holder.ready;
  return holder;
}

let powershell;
function powershellCommand() {
  if (powershell) return powershell;
  for (const candidate of ["powershell.exe", "pwsh.exe"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { windowsHide: true });
    if (probe.status === 0) {
      powershell = candidate;
      return powershell;
    }
  }
  throw new Error("neither powershell.exe nor pwsh.exe can be started; W4 (2) cannot be witnessed");
}

async function holdExclusivelyWithPowerShell(file) {
  const holder = startHolder(
    powershellCommand(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_HOLDER],
    { CAPACITY_LOCK_WITNESS_FILE: file },
  );
  await holder.ready;
  return holder;
}

function witness(id, title, body) {
  test(`${id} ${title}`, TIMEOUT, async () => {
    const entry = { id, title, observed: {}, verdict: "incompatible" };
    results.push(entry);
    try {
      await body(entry.observed);
      entry.verdict = "compatible";
    } catch (error) {
      entry.failure = { message: error?.message ?? String(error), code: error?.code ?? null };
      throw error;
    }
  });
}

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill();
    await holder.exited.catch(() => null);
  }
});

function gitValue(args) {
  try {
    const run = spawnSync("git", args, { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: "utf8", windowsHide: true });
    return run.status === 0 ? run.stdout.trim() : null;
  } catch {
    return null;
  }
}

function fileSha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

after(() => {
  for (const dir of tempDirs) removeTree(dir);
  if (skip) return;
  const here = fileURLToPath(import.meta.url);
  const porcelain = gitValue(["status", "--porcelain"]);
  const report = {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: { type: os.type(), release: os.release(), version: os.version() },
    commit: gitValue(["rev-parse", "HEAD"]),
    dirty: porcelain === null ? null : porcelain.length > 0,
    files_sha256: {
      lock_module: fileSha256(path.resolve(path.dirname(here), "..", "lib", "control-evidence-capacity-lock.mjs")),
      witness_file: fileSha256(here),
    },
    results,
  };
  const target = process.env.CAPACITY_LOCK_NATIVE_WITNESS_OUT
    ?? path.join(os.tmpdir(), `capacity-lock-native-witness-${Date.now()}.json`);
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`NATIVE-WITNESS ${JSON.stringify(report)}`);
  console.log(`NATIVE-WITNESS-FILE ${target}`);
});

// ---------------------------------------------------------------------------
// W1: rename of a non-empty directory onto an existing directory
// ---------------------------------------------------------------------------

witness("W1", "renameSync(non-empty directory, existing directory) error codes", (observed) => {
  const base = tempDir("w1");
  const makeSource = (name) => {
    const dir = path.join(base, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "owner.json"), "source\n");
    return dir;
  };
  const sourceA = makeSource("source-a");
  const emptyDestination = path.join(base, "destination-empty");
  mkdirSync(emptyDestination);
  const ontoEmpty = attempt(() => renameSync(sourceA, emptyDestination));
  observed.onto_empty_directory = {
    ...ontoEmpty,
    source_still_exists: existsSync(sourceA),
    destination_entries: readdirSync(emptyDestination),
  };
  const sourceB = makeSource("source-b");
  const fullDestination = path.join(base, "destination-full");
  mkdirSync(fullDestination);
  writeFileSync(path.join(fullDestination, "owner.json"), "holder\n");
  const ontoFull = attempt(() => renameSync(sourceB, fullDestination));
  observed.onto_non_empty_directory = {
    ...ontoFull,
    source_still_exists: existsSync(sourceB),
    destination_content: readFileSync(path.join(fullDestination, "owner.json"), "utf8"),
  };
  // The mutual exclusion of publication: a non-empty lock directory is never replaced.
  assert.equal(ontoFull.ok, false, "rename onto a non-empty directory must fail");
  assert.equal(observed.onto_non_empty_directory.destination_content, "holder\n");
  assert.equal(observed.onto_non_empty_directory.source_still_exists, true);
  if (ontoEmpty.ok) {
    assert.deepEqual(observed.onto_empty_directory.destination_entries, ["owner.json"]);
    assert.equal(observed.onto_empty_directory.source_still_exists, false);
  } else {
    assert.equal(observed.onto_empty_directory.source_still_exists, true);
    assert.deepEqual(observed.onto_empty_directory.destination_entries, []);
  }
});

// ---------------------------------------------------------------------------
// W2: rename of the lock directory while another process holds owner.json open
// ---------------------------------------------------------------------------

witness("W2", "renameSync(L, Q) while another process holds L/owner.json open", async (observed) => {
  const base = tempDir("w2");
  const lock = path.join(base, ".capacity-lock");
  const quarantine = path.join(base, `.capacity-lock.recovery.${process.pid}.${randomUUID()}`);
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner.json"), ownerBytes(ownerRecord(exitedPid())));
  const holder = await holdWithNode(path.join(lock, "owner.json"));
  const whileOpen = attempt(() => renameSync(lock, quarantine));
  observed.while_open = whileOpen;
  if (!whileOpen.ok) {
    assert.equal(whileOpen.code, "EPERM", "the recovery retry only handles EPERM");
    assert.equal(whileOpen.syscall, "rename", "the recovery retry requires syscall rename");
  }
  await holder.release();
  const afterClose = whileOpen.ok ? { ok: true, attempts: 0 } : retryWithin(2000, () => renameSync(lock, quarantine));
  observed.after_close = afterClose;
  assert.equal(afterClose.ok, true, "the rename must succeed once the handle is closed");
  assert.equal(existsSync(quarantine), true);
  assert.equal(existsSync(lock), false);
});

// ---------------------------------------------------------------------------
// W3: linkSync onto an existing destination
// ---------------------------------------------------------------------------

witness("W3", "linkSync onto an existing marker name", (observed) => {
  const base = tempDir("w3");
  const marker = path.join(base, `.capacity-lock.repair.${randomUUID()}.0`);
  const firstCandidate = path.join(base, `.capacity-lock.repair-candidate.${process.pid}.${randomUUID()}`);
  const secondCandidate = path.join(base, `.capacity-lock.repair-candidate.${process.pid}.${randomUUID()}`);
  writeFileSync(firstCandidate, "first\n");
  writeFileSync(secondCandidate, "second\n");
  const first = attempt(() => linkSync(firstCandidate, marker));
  const second = attempt(() => linkSync(secondCandidate, marker));
  observed.first_link = first;
  observed.second_link_onto_existing = second;
  observed.marker_content_after = existsSync(marker) ? readFileSync(marker, "utf8") : null;
  assert.equal(first.ok, true, "hard links must work on this volume for the election to exist");
  assert.equal(second.ok, false, "a second link onto an existing marker must fail");
  assert.equal(observed.marker_content_after, "first\n");
});

// ---------------------------------------------------------------------------
// W4: removing, reading and re-linking a marker another process has open
// ---------------------------------------------------------------------------

witness("W4", "(1) marker open in another Node process; (2) marker open with FileShare.None", async (observed) => {
  const base = tempDir("w4");
  const markerName = `.capacity-lock.repair.${randomUUID()}.0`;
  const marker = path.join(base, markerName);
  const candidate = path.join(base, `.capacity-lock.repair-candidate.${process.pid}.${randomUUID()}`);

  // (1) Default Node sharing, as a contender reading the marker during an election.
  writeFileSync(marker, "marker\n");
  writeFileSync(candidate, "replacement\n");
  const nodeHolder = await holdWithNode(marker);
  const unlinkWhileOpen = attempt(() => unlinkSync(marker));
  observed.node_open = {
    unlink: unlinkWhileOpen,
    exists_after_unlink: existsSync(marker),
    read_after_unlink: attempt(() => readFileSync(marker)),
    link_same_name_after_unlink: attempt(() => linkSync(candidate, marker)),
  };
  await nodeHolder.release();
  observed.node_open.entries_after_close = readdirSync(base).sort();
  if (existsSync(marker)) unlinkSync(marker);

  // (2) FileShare.None, as an antivirus or indexing scan that excludes sharing.
  writeFileSync(marker, "marker\n");
  const exclusive = await holdExclusivelyWithPowerShell(marker);
  const unlinkExclusive = attempt(() => unlinkSync(marker));
  const readExclusive = attempt(() => readFileSync(marker));
  const openExclusive = attempt(() => openSync(marker, "r"));
  observed.powershell_none = {
    shell: powershellCommand(),
    unlink: unlinkExclusive,
    read: readExclusive,
    open_for_read: openExclusive,
    exists_while_open: existsSync(marker),
  };
  await exclusive.release();
  const retriedUnlink = retryWithin(1000, () => unlinkSync(marker));
  observed.powershell_none.unlink_after_close = retriedUnlink;
  observed.powershell_none.exists_after_unlink = existsSync(marker);
  // D4's closed retry list must contain what Windows really reports.
  if (!unlinkExclusive.ok) {
    assert.ok(RETRYABLE.has(unlinkExclusive.code), `unlink code ${unlinkExclusive.code} is outside EPERM/EBUSY/EACCES`);
  }
  if (!readExclusive.ok) {
    assert.ok(RETRYABLE.has(readExclusive.code), `read code ${readExclusive.code} is outside EPERM/EBUSY/EACCES`);
  }
  assert.equal(retriedUnlink.ok, true, "the withdrawal must succeed after the handle is closed");
  assert.equal(existsSync(marker), false);
});

// ---------------------------------------------------------------------------
// W5: process.kill(pid, 0) after the process ended
// ---------------------------------------------------------------------------

witness("W5", "process.kill(pid, 0) reports ESRCH for an ended process", async (observed) => {
  const file = path.join(tempDir("w5"), "live.txt");
  writeFileSync(file, "x\n");
  const holder = await holdWithNode(file);
  const liveCheck = attempt(() => process.kill(holder.pid, 0));
  await holder.release();
  const endedCheck = attempt(() => process.kill(holder.pid, 0));
  const spawnedAndEnded = exitedPid();
  const spawnedCheck = attempt(() => process.kill(spawnedAndEnded, 0));
  const unusedCheck = attempt(() => process.kill(2_147_483_646, 0));
  observed.live_process = liveCheck;
  observed.ended_process = { pid: holder.pid, ...endedCheck };
  observed.ended_synchronous_child = { pid: spawnedAndEnded, ...spawnedCheck };
  observed.unused_pid = unusedCheck;
  assert.equal(liveCheck.ok, true);
  assert.equal(endedCheck.ok, false);
  assert.equal(endedCheck.code, "ESRCH");
  assert.equal(spawnedCheck.code, "ESRCH");
});

// ---------------------------------------------------------------------------
// W6: rmdirSync of a quarantine or release directory with a file another process has open
// ---------------------------------------------------------------------------

witness("W6", "rmdirSync of X with an owner file open elsewhere, and the cleanup of that X by the module", async (observed) => {
  // (a) Node default sharing: the delete is allowed, the directory may stay until the handle closes.
  const baseA = tempDir("w6a");
  const dirA = path.join(baseA, `.capacity-lock.release.${exitedPid()}.${randomUUID()}`);
  mkdirSync(dirA);
  writeFileSync(path.join(dirA, "owner.json"), "owner\n");
  const nodeHolder = await holdWithNode(path.join(dirA, "owner.json"));
  const unlinkA = attempt(() => unlinkSync(path.join(dirA, "owner.json")));
  const rmdirA = attempt(() => rmdirSync(dirA));
  observed.node_open = { unlink_owner: unlinkA, rmdir_while_open: rmdirA };
  await nodeHolder.release();
  observed.node_open.rmdir_after_close = existsSync(dirA) ? retryWithin(1000, () => rmdirSync(dirA)) : { ok: true, attempts: 0 };
  assert.equal(observed.node_open.rmdir_after_close.ok, true, "the directory must be removable once the handle is closed");

  // (b) FileShare.None, through the real module: acquisition must still succeed, the held X must be
  // kept, and the next acquisition after the handle closes must clean it.
  const root = tempDir("w6b");
  const deadPid = exitedPid();
  const releaseName = `.capacity-lock.release.${deadPid}.${randomUUID()}`;
  mkdirSync(path.join(root, releaseName));
  writeFileSync(path.join(root, releaseName, "owner.json"), ownerBytes(ownerRecord(deadPid)));
  const exclusive = await holdExclusivelyWithPowerShell(path.join(root, releaseName, "owner.json"));
  const firstEvents = [];
  const firstRelease = acquireCapacityLock(root, { onProtocolEvent: (event) => firstEvents.push(event) });
  firstRelease();
  observed.module_cleanup_while_open = {
    events: firstEvents.map((event) => ({ event: event.event, step: event.step, code: event.code, detail: event.detail })),
    entries_after: listLockEntries(root),
  };
  await exclusive.release();
  const secondEvents = [];
  acquireCapacityLock(root, { onProtocolEvent: (event) => secondEvents.push(event) })();
  observed.module_cleanup_after_close = {
    events: secondEvents.map((event) => ({ event: event.event, step: event.step, code: event.code, detail: event.detail })),
    entries_after: listLockEntries(root),
  };
  assert.ok(observed.module_cleanup_while_open.entries_after.includes(releaseName), "the held directory must be kept");
  assert.deepEqual(observed.module_cleanup_after_close.entries_after, [], "the next acquisition must clean it");
});

// ---------------------------------------------------------------------------
// End to end: recovery through a short and through a long open handle on owner.json
// ---------------------------------------------------------------------------

witness("E-a", "recovery outlasts a contender that briefly holds owner.json open", async (observed) => {
  const root = path.join(tempDir("ea"), "root");
  const { deadPid } = await createDeadLock(root);
  const holder = await holdWithNode(path.join(root, ".capacity-lock", "owner.json"), 400);
  const events = [];
  const startedAt = Date.now();
  const release = acquireCapacityLock(root, { waitMs: 10_000, onProtocolEvent: (event) => events.push(event) });
  observed.elapsed_ms = Date.now() - startedAt;
  release();
  await holder.exited;
  observed.dead_pid = deadPid;
  observed.event_names = events.map((event) => event.event);
  observed.entries_after = listLockEntries(root);
  assert.equal(events.filter((event) => event.event === "repair-target-verified").length, 1);
  assert.equal(events.filter((event) => event.event === "unexpected-fs-error").length, 0, JSON.stringify(events));
  assert.deepEqual(observed.entries_after, []);
});

witness("E-b", "recovery fails closed with L unchanged while owner.json stays open past the budget, then recovers", async (observed) => {
  const root = path.join(tempDir("eb"), "root");
  await createDeadLock(root);
  const lock = path.join(root, ".capacity-lock");
  const inoBefore = lstatSync(lock, { bigint: true }).ino;
  const bytesBefore = readFileSync(path.join(lock, "owner.json"));
  const holder = await holdWithNode(path.join(lock, "owner.json"));
  const events = [];
  let failure = null;
  try {
    acquireCapacityLock(root, { waitMs: 400, onProtocolEvent: (event) => events.push(event) })();
  } catch (error) {
    failure = error;
  }
  observed.failure = failure ? { message: failure.message, classification: failure.classification ?? null } : null;
  observed.event_names = events.map((event) => event.event);
  observed.entries_while_failed = listLockEntries(root);
  assert.ok(failure, "the acquisition must fail closed while the handle stays open");
  assert.equal(failure.message, TIMEOUT_MESSAGE);
  assert.equal(lstatSync(lock, { bigint: true }).ino, inoBefore);
  assert.deepEqual(readFileSync(path.join(lock, "owner.json")), bytesBefore);
  assert.deepEqual(observed.entries_while_failed, [".capacity-lock"], "the failed attempt must leave no marker or quarantine");
  await holder.release();
  const recovered = [];
  acquireCapacityLock(root, { waitMs: 10_000, onProtocolEvent: (event) => recovered.push(event) })();
  observed.recovered_event_names = recovered.map((event) => event.event);
  observed.entries_after = listLockEntries(root);
  assert.deepEqual(observed.entries_after, []);
});
