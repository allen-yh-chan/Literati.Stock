// Shared contender for the capacity-lock crash tests and the stress tool (design D11).
//
// Child side: `node capacity-lock-contender.mjs --contender <base64url JSON config>` imports the
// lock module, optionally waits at a start gate, acquires the lock, runs the overlap witness and
// releases. The config injects the faults and barriers the tests need. It speaks to its parent
// through stdout lines (READY, BARRIER <checkpoint>, KILL-CHECK <pid>, ACQUIRED, FAILED <json>,
// PARKED, RELEASE-FAILED <json>, DONE); the lock module's own records stay on stderr.
//
// Parent side: spawnContender, createDeadLock, runRound and small disk-inspection helpers. Nothing
// here synchronizes by sleeping: every wait is a barrier line on stdout or a process exit.
import { spawn } from "node:child_process";
import fs, {
  appendFileSync,
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONTENDER_FLAG = "--contender";
export const CRASH_EXIT_CODE = 77;
export const EVENT_PREFIX = "devpro-capacity-lock-event ";
const HELPER_PATH = fileURLToPath(import.meta.url);
const LOCK_MODULE_URL = pathToFileURL(
  path.resolve(path.dirname(HELPER_PATH), "..", "..", "lib", "control-evidence-capacity-lock.mjs"),
).href;
const LOCK_ENTRY = /^\.capacity-lock(\.|$)/;
const MARKER_ENTRY = /^\.capacity-lock\.repair\.[a-f0-9-]{36}\.\d+$/;
const RELEASE_ENTRY = /^\.capacity-lock\.release\./;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(sleepBuffer, 0, 0, Math.max(1, ms));
}

// ---------------------------------------------------------------------------
// Child side
// ---------------------------------------------------------------------------

function writeAll(fd, text) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (error?.code !== "EAGAIN") throw error;
      sleepMs(1);
    }
  }
}

function out(line) {
  writeAll(1, `${line}\n`);
}

// Blocks until the parent sends a line (or closes stdin). The child is fully synchronous, so this
// is the barrier primitive for checkpoints, the start gate and the park-after-failure state.
function waitForGo() {
  const byte = Buffer.alloc(1);
  while (true) {
    let count;
    try {
      count = readSync(0, byte, 0, 1, null);
    } catch (error) {
      if (error?.code === "EAGAIN") {
        sleepMs(2);
        continue;
      }
      if (error?.code === "EOF") return;
      throw error;
    }
    if (count === 0 || byte[0] === 10) return;
  }
}

function injectedFsError(code, syscall, target) {
  return Object.assign(new Error(`${code}: injected failure, ${syscall} '${path.basename(String(target))}'`), { code, syscall });
}

function installInterceptors(config) {
  const realKill = process.kill;
  const realUnlink = fs.unlinkSync;
  const realRmdir = fs.rmdirSync;
  if (Array.isArray(config.reportKillOf) && config.reportKillOf.length > 0) {
    const watched = new Set(config.reportKillOf);
    process.kill = (pid, signal) => {
      if (signal === 0 && watched.has(pid)) out(`KILL-CHECK ${pid}`);
      return realKill.call(process, pid, signal);
    };
  }
  fs.unlinkSync = (target, ...rest) => {
    const name = path.basename(String(target));
    if (config.failMarkerUnlink && MARKER_ENTRY.test(name)) {
      throw injectedFsError(config.failMarkerUnlink, "unlink", target);
    }
    const result = realUnlink(target, ...rest);
    if (config.crashAfterReleaseOwnerUnlink
      && name === "owner.json"
      && RELEASE_ENTRY.test(path.basename(path.dirname(String(target))))) {
      process.exit(CRASH_EXIT_CODE);
    }
    return result;
  };
  fs.rmdirSync = (target, ...rest) => {
    if (config.failReleaseRmdir && RELEASE_ENTRY.test(path.basename(String(target)))) {
      throw injectedFsError(config.failReleaseRmdir, "rmdir", target);
    }
    return realRmdir(target, ...rest);
  };
  syncBuiltinESMExports();
  return { realUnlink };
}

function failureRecord(error) {
  return JSON.stringify({
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    classification: error?.classification ?? null,
    step: error?.capacityLockStep ?? null,
  });
}

// Overlap witness (design D11): an exclusive file outside the root plus an append-only enter/exit
// log. Neither depends on the lock module. Returns true when another holder was seen inside.
function enterWitness(witness, realUnlink) {
  const witnessFile = path.join(witness.dir, "in-critical-section");
  const logFile = path.join(witness.dir, "enter-exit.log");
  let overlapped = false;
  try {
    closeSync(openSync(witnessFile, "wx"));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    overlapped = true;
  }
  appendFileSync(logFile, `enter ${process.pid}\n`);
  const low = witness.holdMinMs ?? 2;
  const high = witness.holdMaxMs ?? 8;
  sleepMs(low + Math.random() * Math.max(0, high - low));
  appendFileSync(logFile, `exit ${process.pid}\n`);
  if (!overlapped) realUnlink(witnessFile);
  return overlapped;
}

async function runContender(config) {
  const { realUnlink } = installInterceptors(config);
  const { acquireCapacityLock } = await import(LOCK_MODULE_URL);
  if (config.startGate) {
    out("READY");
    waitForGo();
  }
  let thrown = false;
  const options = {
    checkpoint: (name) => {
      if (config.crashAt === name) process.exit(CRASH_EXIT_CODE);
      if (Array.isArray(config.pauseAt) && config.pauseAt.includes(name)) {
        out(`BARRIER ${name}`);
        waitForGo();
      }
      if (config.throwAt === name && !thrown) {
        thrown = true;
        throw new Error(`injected failure at ${name}`);
      }
    },
  };
  for (const key of ["waitMs", "staleAfterMs", "repairRetireRetryMs"]) {
    if (config[key] !== undefined) options[key] = config[key];
  }
  if (config.crashAfterReleaseRename) {
    options.releaseRename = (from, to) => {
      fs.renameSync(from, to);
      process.exit(CRASH_EXIT_CODE);
    };
  }
  let release;
  try {
    release = acquireCapacityLock(config.root, options);
  } catch (error) {
    out(`FAILED ${failureRecord(error)}`);
    if (config.parkOnFailure) {
      out("PARKED");
      waitForGo();
    }
    process.exit(1);
  }
  out("ACQUIRED");
  if (config.afterAcquire === "hold-and-exit") process.exit(0);
  const overlapped = config.witness ? enterWitness(config.witness, realUnlink) : false;
  try {
    release();
  } catch (error) {
    out(`RELEASE-FAILED ${failureRecord(error)}`);
    process.exit(config.expectReleaseFailure ? 0 : 1);
  }
  out("DONE");
  process.exit(overlapped ? 3 : 0);
}

if (process.argv[2] === CONTENDER_FLAG) {
  await runContender(JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8")));
}

// ---------------------------------------------------------------------------
// Parent side
// ---------------------------------------------------------------------------

export function parseEvents(stderr) {
  const events = [];
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(EVENT_PREFIX)) continue;
    try {
      events.push(JSON.parse(line.slice(EVENT_PREFIX.length)));
    } catch {
      // A torn line is not a record; the caller sees it in the raw stderr.
    }
  }
  return events;
}

/** Spawns a contender child. Waits are barrier lines (waitFor) or process exit (closed). */
export function spawnContender(config) {
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  const child = spawn(process.execPath, [HELPER_PATH, CONTENDER_FLAG, encoded], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const state = { buffer: "", lines: [], stderr: "", closedResult: null, watchers: new Set() };
  const notify = () => {
    for (const watcher of [...state.watchers]) watcher();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    const parts = state.buffer.split("\n");
    state.buffer = parts.pop();
    state.lines.push(...parts.filter((line) => line.length > 0));
    notify();
  });
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const failedLine = state.lines.find((line) => line.startsWith("FAILED "));
      state.closedResult = {
        code,
        signal,
        lines: [...state.lines],
        stderr: state.stderr,
        events: parseEvents(state.stderr),
        failure: failedLine ? JSON.parse(failedLine.slice("FAILED ".length)) : null,
      };
      resolve(state.closedResult);
      notify();
    });
  });
  const contender = {
    child,
    pid: child.pid,
    closed,
    lines: () => [...state.lines],
    stderr: () => state.stderr,
    send: (text = "go\n") => { child.stdin.write(text); },
    kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); },
    /** Resolves with the matching lines once `count` of them arrived; rejects on early exit or timeout. */
    waitFor(prefix, { count = 1, timeoutMs = 30_000 } = {}) {
      return new Promise((resolve, reject) => {
        const matching = () => state.lines.filter((line) => line.startsWith(prefix));
        const timer = setTimeout(() => {
          state.watchers.delete(check);
          reject(new Error(`pid ${child.pid}: no "${prefix}" x${count} within ${timeoutMs}ms; lines=${JSON.stringify(state.lines)} stderr=${state.stderr}`));
        }, timeoutMs);
        function check() {
          const found = matching();
          if (found.length >= count) {
            clearTimeout(timer);
            state.watchers.delete(check);
            resolve(found);
          } else if (state.closedResult) {
            clearTimeout(timer);
            state.watchers.delete(check);
            reject(new Error(`pid ${child.pid} exited ${state.closedResult.code} before "${prefix}" x${count}; lines=${JSON.stringify(state.lines)} stderr=${state.stderr}`));
          }
        }
        state.watchers.add(check);
        check();
      });
    },
  };
  return contender;
}

/** Entries of the root that belong to the capacity lock protocol (L and every auxiliary item). */
export function listLockEntries(root) {
  return readdirSync(root).filter((name) => LOCK_ENTRY.test(name)).sort();
}

/** Rewrites created_at of the lock owner so it is past the stale threshold. Returns the owner. */
export function ageLock(root, ageMs = 3_600_000) {
  const ownerPath = path.join(root, ".capacity-lock", "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.created_at = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
  return owner;
}

/**
 * Leaves a real dead lock in `root`: a child acquires and exits without releasing, so the owner PID
 * is a real, now dead process and the directory has a real inode. created_at is moved past the
 * stale threshold.
 */
export async function createDeadLock(root) {
  mkdirSync(root, { recursive: true });
  const holder = spawnContender({ root, waitMs: 15_000, afterAcquire: "hold-and-exit" });
  const result = await holder.closed;
  if (result.code !== 0) {
    throw new Error(`dead-lock fixture child exited ${result.code}: ${result.stderr} ${JSON.stringify(result.lines)}`);
  }
  const owner = ageLock(root);
  return { deadPid: holder.pid, ownerToken: owner.owner_token };
}

/** Copies a fixture root (used with a template made once per file). */
export function cloneRoot(from, to) {
  cpSync(from, to, { recursive: true });
  return to;
}

export function removeTree(target) {
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Violations of the enter/exit log of a witness: another holder inside, or a line that is not enter/exit. */
export function witnessLogViolations(logFile) {
  let text;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return ["witness log missing"];
  }
  const violations = [];
  let inside = null;
  for (const line of text.split("\n").filter(Boolean)) {
    const [kind, pid] = line.split(" ");
    if (kind === "enter") {
      if (inside !== null) violations.push(`enter ${pid} while ${inside} inside`);
      inside = pid;
    } else if (kind === "exit") {
      if (inside !== pid) violations.push(`exit ${pid} while ${inside ?? "nobody"} inside`);
      inside = null;
    } else {
      violations.push(`unreadable witness line: ${line}`);
    }
  }
  return violations;
}

const MAX_PID_REUSE_RERUNS = 5;
const REPO_ROOT = path.resolve(path.dirname(HELPER_PATH), "..", "..", "..", "..");

// The pattern for one host path: every separator run matches any run of backslashes or slashes, so the
// path is found as written, with forward slashes, and after any number of JSON.stringify layers (each
// layer doubles every backslash: a stdout "FAILED <json>" line has two, the start-gate text four). A
// Windows path (drive letter or UNC) matches without regard to case, as the file system does.
function hostPathPattern(hostPath) {
  const windowsLike = /^(?:[A-Za-z]:|\\)/.test(hostPath);
  // A POSIX path starts with exactly one slash; matching a run there would swallow the "//" of file://.
  const leading = hostPath.startsWith("/") && !hostPath.startsWith("//") ? "/" : hostPath.match(/^[\\/]+/) ? "[\\\\/]+" : "";
  const source = leading + hostPath
    .replace(/^[\\/]+/, "")
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]+");
  return new RegExp(source, windowsLike ? "gi" : "g");
}

/**
 * Replaces the host's absolute paths in text that is written to a log (a stress log is kept in a change
 * folder): the round directory, its parent, the system temp directory and the repository root, each as
 * written, as its real path, with forward slashes, and with its backslashes doubled by any number of
 * JSON.stringify layers (see hostPathPattern). Longest path first, so the most specific name wins. The
 * temp directory and the repository root are injectable so a test can use a Windows path on any host.
 * Not covered: a Windows 8.3 short name (RUNNER~1) of a directory, and percent-encoded file:// URLs.
 */
export function scrubHostPaths(text, { roundDir, parentDir, tmpDir = os.tmpdir(), repoRoot = REPO_ROOT }) {
  const names = [[roundDir, "<round>"], [parentDir, "<parent>"], [tmpDir, "<tmp>"], [repoRoot, "<repo>"]];
  const prefixes = [];
  for (const [prefix, name] of names) {
    if (!prefix) continue;
    prefixes.push([prefix, name]);
    try {
      const real = realpathSync(prefix);
      if (real !== prefix) prefixes.push([real, name]);
    } catch { /* a removed directory has no real path */ }
  }
  prefixes.sort((left, right) => right[0].length - left[0].length);
  let result = text;
  for (const [prefix, name] of prefixes) result = result.replace(hostPathPattern(prefix), () => name);
  return result;
}

/**
 * One stress round (design D11): a real dead lock, N contenders released together after every one
 * of them has loaded the lock module, the overlap witnesses, the residue rule, and one cleanup
 * acquisition. Never throws for a protocol failure; the verdict is in `failures`.
 */
export async function runRound({
  contenders,
  parentDir = os.tmpdir(),
  waitMs = 120_000,
  roundTimeoutMs = 300_000,
  platform = process.platform,
} = {}) {
  const startedAt = Date.now();
  let pidReuseReruns = 0;
  while (true) {
    const roundDir = mkdtempSync(path.join(parentDir, "capacity-lock-stress-"));
    const root = path.join(roundDir, "root");
    const witnessDir = path.join(roundDir, "witness");
    mkdirSync(witnessDir);
    const fixture = await createDeadLock(root);
    const group = Array.from({ length: contenders }, () => spawnContender({
      root,
      waitMs,
      startGate: true,
      witness: { dir: witnessDir },
    }));
    try {
      await Promise.all(group.map((contender) => contender.waitFor("READY", { timeoutMs: 60_000 })));
    } catch (error) {
      group.forEach((contender) => contender.kill());
      await Promise.all(group.map((contender) => contender.closed.catch(() => null)));
      return finishRound({ roundDir, parentDir, root, fixture, results: [], failures: [`start-gate: ${error.message}`], pidReuseReruns, startedAt, platform, keep: true });
    }
    // A contender that was handed the dead owner's PID would see a live owner and wait out its
    // whole budget: an environment collision, not a protocol outcome. Counted, then rerun.
    if (group.some((contender) => contender.pid === fixture.deadPid)) {
      group.forEach((contender) => contender.kill());
      await Promise.all(group.map((contender) => contender.closed.catch(() => null)));
      pidReuseReruns += 1;
      if (pidReuseReruns > MAX_PID_REUSE_RERUNS) {
        return finishRound({ roundDir, parentDir, root, fixture, results: [], failures: ["pid-reuse: dead owner PID reused by a contender too many times"], pidReuseReruns, startedAt, platform, keep: true });
      }
      removeTree(roundDir);
      continue;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      group.forEach((contender) => contender.kill());
    }, roundTimeoutMs);
    group.forEach((contender) => contender.send());
    const results = await Promise.all(group.map((contender) => contender.closed));
    clearTimeout(timer);
    return finishRound({
      roundDir,
      parentDir,
      root,
      fixture,
      results: results.map((result, index) => ({ ...result, pid: group[index].pid })),
      failures: timedOut ? [`round-timeout: no result within ${roundTimeoutMs}ms`] : [],
      pidReuseReruns,
      startedAt,
      platform,
      keep: false,
    });
  }
}

const MAX_STDERR_BYTES = 64 * 1024;
const UNEXPECTED_EVENTS = new Set(["unexpected-fs-error", "residue-preserved"]);

// A process that exits non-zero because of its own unexpected-fs-error record is one incident, not two.
function processIncidents(result) {
  const badExit = result.code !== 0 && result.code !== 3 ? 1 : 0;
  return Math.max(badExit, result.events.filter((event) => UNEXPECTED_EVENTS.has(event.event)).length);
}

// Everything a failed round needs to be diagnosed later: exit status, stdout lines and stderr (every
// protocol record included), cut at 64KB per process and marked when cut.
function processDetail(label, result, scrub) {
  const truncated = Buffer.byteLength(result.stderr, "utf8") > MAX_STDERR_BYTES;
  const stderr = truncated ? Buffer.from(result.stderr, "utf8").subarray(0, MAX_STDERR_BYTES).toString("utf8") : result.stderr;
  return {
    label,
    pid: result.pid ?? null,
    code: result.code,
    signal: result.signal,
    lines: result.lines.map(scrub),
    stderr: scrub(stderr),
    stderr_truncated: truncated,
  };
}

async function finishRound({ roundDir, parentDir, root, fixture, results, failures, pidReuseReruns, startedAt, platform, keep }) {
  const events = results.flatMap((result) => result.events);
  let overlap = 0;
  let unexpectedFailures = 0;
  for (const result of results) {
    unexpectedFailures += processIncidents(result);
    if (result.code === 3) {
      overlap += 1;
    } else if (result.code !== 0) {
      failures.push(`contender ${result.pid} exited ${result.code}${result.failure ? ` (${result.failure.message})` : ""}`);
    }
  }
  const logViolations = results.some((result) => result.code === 0 || result.code === 3) ? witnessLogViolations(path.join(roundDir, "witness", "enter-exit.log")) : [];
  overlap += logViolations.length;
  if (overlap > 0) failures.push(`overlap: witness=${results.filter((r) => r.code === 3).length} log=${JSON.stringify(logViolations)}`);

  const unexpectedEvents = events.filter((event) => UNEXPECTED_EVENTS.has(event.event));
  for (const event of unexpectedEvents) failures.push(`event ${event.event} step=${event.step} code=${event.code} detail=${JSON.stringify(event.detail)}`);
  const verified = events.filter((event) => event.event === "repair-target-verified").length;
  if (results.length > 0 && verified !== 1) {
    unexpectedFailures += 1;
    failures.push(`repair-target-verified recorded ${verified} times, expected exactly 1`);
  }
  if (failures.length > 0 && results.length === 0) unexpectedFailures += 1;
  const retireFailed = events.filter((event) => event.event === "repair-marker-retire-failed");
  if (retireFailed.length > 0) failures.push(`repair-marker-retire-failed x${retireFailed.length}: ${JSON.stringify(retireFailed.map((event) => event.detail))}`);

  // Residue rule (D11): every protocol entry left behind must match a residue-deferred or
  // repair-marker-retire-failed record of this round.
  const explainedNames = new Set(events.flatMap((event) => {
    if (event.event === "residue-deferred") return [event.detail?.item];
    if (event.event === "repair-marker-retire-failed") return [event.detail?.marker];
    return [];
  }));
  const preSweep = listLockEntries(root);
  const unexplained = preSweep.filter((name) => !explainedNames.has(name));
  let unexplainedResidue = unexplained.length;
  if (unexplained.length > 0) failures.push(`unexplained residue before the cleanup acquisition: ${JSON.stringify(unexplained)}`);
  if (platform !== "win32" && preSweep.length > 0) failures.push(`residue before the cleanup acquisition on ${platform}: ${JSON.stringify(preSweep)}`);

  // One cleanup acquisition: every creator is dead by now, so the residue sweep can take them all.
  const cleaner = spawnContender({ root, waitMs: 30_000 });
  const cleanup = await cleaner.closed;
  events.push(...cleanup.events);
  unexpectedFailures += processIncidents(cleanup);
  if (cleanup.code !== 0) failures.push(`cleanup acquisition exited ${cleanup.code}${cleanup.failure ? ` (${cleanup.failure.message})` : ""}`);
  for (const event of cleanup.events.filter((e) => UNEXPECTED_EVENTS.has(e.event))) {
    failures.push(`cleanup event ${event.event} step=${event.step} code=${event.code} detail=${JSON.stringify(event.detail)}`);
  }
  const postSweep = listLockEntries(root);
  if (postSweep.length > 0) {
    unexplainedResidue += postSweep.length;
    failures.push(`residue after the cleanup acquisition: ${JSON.stringify(postSweep)}`);
  }

  const scrub = (text) => scrubHostPaths(text, { roundDir, parentDir });
  const result = {
    duration_ms: Date.now() - startedAt,
    ok: failures.length === 0,
    failures: failures.map(scrub),
    contenders: results.map((r) => ({ pid: r.pid, code: r.code, events: r.events.length })),
    dead_pid: fixture.deadPid,
    overlap,
    unexpected_failures: unexpectedFailures,
    target_verified: verified,
    pre_sweep_residue: preSweep.length,
    pre_sweep_entries: preSweep,
    unexplained_residue: unexplainedResidue,
    post_sweep_residue: postSweep.length,
    repair_marker_retire_failed: retireFailed.length,
    event_counts: countBy(events.map((event) => event.event)),
    errno_counts: countBy([
      ...events.map((event) => event.code).filter(Boolean),
      ...results.map((r) => r.failure?.code).filter(Boolean),
    ]),
    pid_reuse_reruns: pidReuseReruns,
    round_dir: null,
  };
  if (failures.length > 0 || keep) {
    result.details = [
      ...results.map((r) => processDetail("contender", r, scrub)),
      processDetail("cleanup", { ...cleanup, pid: cleaner.pid }, scrub),
    ];
    // The kept directory by name, relative to parentDir: no host path reaches a log.
    result.round_dir = path.relative(parentDir, roundDir);
  } else {
    removeTree(roundDir);
  }
  return result;
}
