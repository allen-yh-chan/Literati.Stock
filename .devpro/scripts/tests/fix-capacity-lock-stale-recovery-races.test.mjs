// Prove-it tests for the capacity-lock stale-recovery races (design D11, D12).
// They assert the corrected behavior and use no new options: the contender's
// "owner is dead" moment is hooked through process.kill(pid, 0), and fs calls
// are wrapped, so the same tests run against the code before and after the fix.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireCapacityLock } from "../lib/control-evidence-capacity-lock.mjs";
import * as capacityLockModule from "../lib/control-evidence-capacity-lock.mjs";

const DEAD_PID = 2_147_483_646;
const realFs = { ...fs };
const realKill = process.kill;

function ownerBytes(owner) {
  return Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
}

function newOwner(pid, createdAt) {
  return {
    schema: "devpro-second-review-capacity-lock/v1",
    owner_pid: pid,
    owner_token: randomUUID(),
    created_at: createdAt,
  };
}

function writeLock(lockPath, owner) {
  realFs.mkdirSync(lockPath, { mode: 0o700 });
  realFs.writeFileSync(path.join(lockPath, "owner.json"), ownerBytes(owner));
}

// A lock left by a dead owner, old enough to pass the stale threshold.
function withDeadLock(body) {
  const root = realFs.mkdtempSync(path.join(os.tmpdir(), "capacity-lock-recovery-"));
  const lockPath = path.join(root, ".capacity-lock");
  const deadOwner = newOwner(DEAD_PID, new Date(Date.now() - 3_600_000).toISOString());
  writeLock(lockPath, deadOwner);
  try {
    body({ root, lockPath, deadOwner });
  } finally {
    fs.renameSync = realFs.renameSync;
    fs.rmdirSync = realFs.rmdirSync;
    process.kill = realKill;
    syncBuiltinESMExports();
    realFs.rmSync(root, { recursive: true, force: true });
  }
}

// Reports DEAD_PID as dead and runs `onFirstDeadCheck` at the moment the
// contender first concludes that. Everything else goes to the real process.kill.
function hookDeadOwnerCheck(onFirstDeadCheck) {
  let fired = false;
  process.kill = (pid, signal) => {
    if (pid !== DEAD_PID || signal !== 0) return realKill.call(process, pid, signal);
    if (!fired) {
      fired = true;
      onFirstDeadCheck();
    }
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", syscall: "kill" });
  };
}

// Records every rename and lets `decide` replace it (return a thrown error to inject).
function wrapRename(renames, decide = () => undefined) {
  fs.renameSync = (from, to) => {
    renames.push({ from, to });
    decide(from, to, renames.length);
    return realFs.renameSync(from, to);
  };
  syncBuiltinESMExports();
}

test("a contender that loses the stale-lock recovery race acquires the lock instead of failing with ENOENT", () => {
  withDeadLock(({ root, lockPath, deadOwner }) => {
    // Another process recovers the same dead lock first: L is gone when we rename.
    hookDeadOwnerCheck(() => realFs.rmSync(lockPath, { recursive: true, force: true }));
    let release;
    try {
      release = acquireCapacityLock(root, { waitMs: 2000, staleAfterMs: 1000 });
    } catch (error) {
      assert.fail(`loser of the recovery race must not fail (${error.message})`);
    }
    try {
      const current = JSON.parse(realFs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      assert.equal(current.owner_pid, process.pid);
      assert.notEqual(current.owner_token, deadOwner.owner_token);
    } finally {
      release();
    }
  });
});

test("a contender with a stale snapshot never renames a lock created after its snapshot", () => {
  withDeadLock(({ root, lockPath }) => {
    // Another process recovered the dead lock and a live owner took a new one.
    // The test runner (parent) is a live process other than the contender itself.
    const liveOwner = newOwner(process.ppid, new Date().toISOString());
    const liveBytes = ownerBytes(liveOwner);
    let liveIno;
    hookDeadOwnerCheck(() => {
      realFs.rmSync(lockPath, { recursive: true, force: true });
      writeLock(lockPath, liveOwner);
      liveIno = realFs.lstatSync(lockPath).ino;
    });
    const renames = [];
    wrapRename(renames);
    let failure;
    try {
      acquireCapacityLock(root, { waitMs: 150, staleAfterMs: 1000 })();
      assert.fail("a live owner holds the lock; acquisition must not succeed");
    } catch (error) {
      failure = error;
    }
    const fromLock = renames.filter((rename) => rename.from === lockPath);
    assert.deepEqual(fromLock, [], "the live owner's new lock must never be the source of a rename");
    assert.match(failure.message, /dispatch capacity gate is unavailable; reservation failed closed/);
    assert.equal(realFs.lstatSync(lockPath).ino, liveIno);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), liveBytes);
  });
});

test("win32 stale-lock recovery retries a rename EPERM and then acquires the lock", () => {
  withDeadLock(({ root, lockPath, deadOwner }) => {
    // Native Windows: a contender holding owner.json open makes rename(L) fail transiently.
    hookDeadOwnerCheck(() => {});
    const renames = [];
    wrapRename(renames, (from) => {
      if (from === lockPath && renames.filter((rename) => rename.from === lockPath).length <= 3) {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM", syscall: "rename" });
      }
    });
    let release;
    try {
      release = acquireCapacityLock(root, { platform: "win32", waitMs: 2000, staleAfterMs: 1000 });
    } catch (error) {
      assert.fail(`recovery must retry a transient rename EPERM (${error.message})`);
    }
    try {
      const current = JSON.parse(realFs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      assert.equal(current.owner_pid, process.pid);
      assert.notEqual(current.owner_token, deadOwner.owner_token);
      assert.ok(renames.filter((rename) => rename.from === lockPath).length >= 4, "must have retried after each EPERM");
    } finally {
      release();
    }
  });
});

test("a release that fails after owner.json was deleted does not move the emptied directory back to .capacity-lock", () => {
  const root = realFs.mkdtempSync(path.join(os.tmpdir(), "capacity-lock-release-gap-"));
  const lockPath = path.join(root, ".capacity-lock");
  try {
    const release = acquireCapacityLock(root);
    const failure = Object.assign(new Error("EIO: i/o error, rmdir"), { code: "EIO", syscall: "rmdir" });
    const renames = [];
    wrapRename(renames);
    fs.rmdirSync = (target, ...rest) => {
      if (path.basename(target).startsWith(".capacity-lock.release.")) throw failure;
      return realFs.rmdirSync(target, ...rest);
    };
    syncBuiltinESMExports();
    assert.throws(release, (error) => error === failure);
    const toLock = renames.filter((rename) => rename.to === lockPath);
    assert.deepEqual(toLock, [], "an emptied release directory must never become .capacity-lock again");
    assert.equal(realFs.existsSync(lockPath), false);
    const leftovers = realFs.readdirSync(root);
    assert.equal(leftovers.length, 1);
    assert.match(leftovers[0], /^\.capacity-lock\.release\./);
    assert.deepEqual(realFs.readdirSync(path.join(root, leftovers[0])), []);
  } finally {
    fs.renameSync = realFs.renameSync;
    fs.rmdirSync = realFs.rmdirSync;
    syncBuiltinESMExports();
    realFs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Protocol tests (design D2-D9). Everything below runs in this one process with
// injected options and wrapped fs functions; the real-subprocess crash and
// barrier tests live in the crash file (T10).
// ---------------------------------------------------------------------------
const LOCK_SOURCE_URL = new URL("../lib/control-evidence-capacity-lock.mjs", import.meta.url);
const MARKER_SCHEMA = "devpro-second-review-capacity-lock-repair/v1";
const NEW_TIMEOUT_MESSAGE = "dispatch capacity gate is unavailable; reservation failed closed";
const hookedFsNames = new Set();

function hookFs(name, wrap) {
  fs[name] = wrap(realFs[name]);
  hookedFsNames.add(name);
  syncBuiltinESMExports();
}

function restoreFs() {
  for (const name of hookedFsNames) fs[name] = realFs[name];
  hookedFsNames.clear();
  process.kill = realKill;
  syncBuiltinESMExports();
}

// Pending marker retirements are module state that outlives a test; a scratch
// acquisition retries (and drops) every entry whose root is already gone.
function withProtocolRoot(body) {
  const root = realFs.mkdtempSync(path.join(os.tmpdir(), "capacity-lock-protocol-"));
  try {
    body({ root, lockPath: path.join(root, ".capacity-lock") });
  } finally {
    restoreFs();
    realFs.rmSync(root, { recursive: true, force: true });
    const scratch = realFs.mkdtempSync(path.join(os.tmpdir(), "capacity-lock-scratch-"));
    try {
      acquireCapacityLock(scratch, { onProtocolEvent() {} })();
    } finally {
      realFs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function eventCollector() {
  const events = [];
  return { events, onProtocolEvent: (record) => { events.push(record); } };
}

function protocolOptions(extra = {}) {
  return { waitMs: 2000, staleAfterMs: 1000, onProtocolEvent() {}, ...extra };
}

function deadLock(root, { pid = DEAD_PID, ageMs = 3_600_000 } = {}) {
  const lockPath = path.join(root, ".capacity-lock");
  const owner = newOwner(pid, new Date(Date.now() - ageMs).toISOString());
  writeLock(lockPath, owner);
  return { lockPath, owner, ino: realFs.lstatSync(lockPath).ino, bytes: ownerBytes(owner) };
}

function rootEntries(root) {
  return realFs.readdirSync(root).sort();
}

function markerNames(root) {
  return rootEntries(root).filter((name) => name.startsWith(".capacity-lock.repair."));
}

function markerName(target, generation) {
  return `.capacity-lock.repair.${target}.${generation}`;
}

function markerBytes(target, generation, { pid = DEAD_PID, token = randomUUID() } = {}) {
  return Buffer.from(`${JSON.stringify({
    schema: MARKER_SCHEMA,
    repair_pid: pid,
    repair_token: token,
    created_at: new Date().toISOString(),
    target_owner_token: target,
    generation,
  })}\n`, "utf8");
}

function writeMarker(root, target, generation, options) {
  const bytes = markerBytes(target, generation, options);
  const name = markerName(target, generation);
  realFs.writeFileSync(path.join(root, name), bytes);
  return { name, bytes };
}

function fsError(code, syscall) {
  return Object.assign(new Error(`${code}: injected, ${syscall}`), { code, syscall });
}

function isMarkerPath(target) {
  return typeof target === "string" && path.basename(target).startsWith(".capacity-lock.repair.");
}

function sourceOfFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const ends = ["\nfunction ", "\nexport function ", "\nconst ", "\nclass "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index >= 0);
  return source.slice(start, Math.min(...ends));
}

test("T3 the module exports the frozen, ordered protocol checkpoint list", () => {
  const list = capacityLockModule.CAPACITY_LOCK_PROTOCOL_CHECKPOINTS;
  assert.ok(Array.isArray(list) && Object.isFrozen(list));
  assert.deepEqual([...list], [
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
});

test("T3 every exported checkpoint is reached exactly once by a recovery that also cleans a residue", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    residueDirectory(root, residueName("release", DEAD_PID), { owner: deadResidueOwner() });
    const reached = [];
    acquireCapacityLock(root, protocolOptions({ checkpoint: (name) => { reached.push(name); } }))();
    assert.deepEqual([...reached].sort(), [...capacityLockModule.CAPACITY_LOCK_PROTOCOL_CHECKPOINTS].sort());
    assert.deepEqual(rootEntries(root), []);
  });
});

// ---- T2 (D2): staged publication ------------------------------------------

test("T2 acquire stages the complete lock and publishes it with one rename; the lock path is never created or written", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const seen = { mkdirs: [], lockOpens: [], published: null };
    hookFs("mkdirSync", (real) => (target, ...rest) => { seen.mkdirs.push(String(target)); return real(target, ...rest); });
    hookFs("openSync", (real) => (target, ...rest) => {
      // Read-only opens (including the test's own readFileSync) are not writes.
      if (String(target).startsWith(`${lockPath}${path.sep}`) && /[wa+]/.test(String(rest[0] ?? "r"))) {
        seen.lockOpens.push(String(target));
      }
      return real(target, ...rest);
    });
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath) {
        assert.equal(realFs.existsSync(lockPath), false, "the lock path must not exist before publication");
        seen.published = { from, owner: realFs.readFileSync(path.join(from, "owner.json")) };
      }
      return real(from, to);
    });
    const release = acquireCapacityLock(root, protocolOptions());
    assert.ok(seen.published, "the lock must be published by renaming a staging directory");
    assert.match(path.basename(seen.published.from), /^\.capacity-lock\.stage\.\d+\.[0-9a-f-]{36}$/);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), seen.published.owner);
    const owner = JSON.parse(seen.published.owner.toString("utf8"));
    assert.equal(owner.owner_pid, process.pid);
    assert.equal(owner.schema, "devpro-second-review-capacity-lock/v1");
    assert.equal(seen.mkdirs.includes(lockPath), false, "the lock path must never be created by mkdir");
    assert.deepEqual(seen.lockOpens, [], "nothing may be opened or written inside the lock path");
    assert.deepEqual(rootEntries(root), [".capacity-lock"], "the staging directory is consumed by the publication");
    release();
    assert.deepEqual(rootEntries(root), []);
  });
  assert.doesNotMatch(realFs.readFileSync(LOCK_SOURCE_URL, "utf8"), /mkdirSync\(\s*lockPath/);
});

test("T2 a contender whose publication loses to a live lock removes its staging directory and fails closed", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const live = newOwner(process.ppid, new Date().toISOString());
    let injected = false;
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath && !injected) {
        injected = true;
        writeLock(lockPath, live);
      }
      return real(from, to);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 80 })), (error) => {
      assert.equal(error.message, NEW_TIMEOUT_MESSAGE);
      assert.equal(error.classification, "reviewer_dispatch_capacity_exceeded");
      return true;
    });
    assert.ok(injected);
    assert.deepEqual(rootEntries(root), [".capacity-lock"], "no staging directory may remain");
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), ownerBytes(live));
  });
});

test("T2 win32 publication retries a rename EPERM inside the wait bound and then publishes", () => {
  withProtocolRoot(({ root, lockPath }) => {
    let attempts = 0;
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath) {
        attempts += 1;
        if (attempts <= 2) throw fsError("EPERM", "rename");
      }
      return real(from, to);
    });
    const release = acquireCapacityLock(root, protocolOptions({ platform: "win32" }));
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(realFs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).owner_pid, process.pid);
    release();
  });
});

test("T2 publication EPERM is bounded by the wait deadline and an unexpected publish failure carries its step", () => {
  withProtocolRoot(({ root, lockPath }) => {
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath) throw fsError("EPERM", "rename");
      return real(from, to);
    });
    const started = Date.now();
    assert.throws(
      () => acquireCapacityLock(root, protocolOptions({ platform: "win32", waitMs: 60 })),
      (error) => error.code === "EPERM" && error.capacityLockStep === "publish-rename"
    );
    assert.ok(Date.now() - started < 1500, "the publication retry must stop at the wait deadline");
    assert.deepEqual(rootEntries(root), [], "a failed publication removes its staging directory");
    assert.throws(
      () => acquireCapacityLock(root, protocolOptions({ platform: "linux" })),
      (error) => error.code === "EPERM" && error.capacityLockStep === "publish-rename"
    );
    assert.deepEqual(rootEntries(root), []);
  });
});

// ---- T3 (D3): election ----------------------------------------------------

test("T3 with no marker the contender elects generation 0 with a complete marker record", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const seen = [];
    const release = acquireCapacityLock(root, protocolOptions({
      checkpoint: (name) => {
        if (name !== "repair-elected") return;
        for (const markerFile of markerNames(root)) {
          seen.push({
            markerFile,
            record: JSON.parse(realFs.readFileSync(path.join(root, markerFile), "utf8")),
            candidates: rootEntries(root).filter((entry) => entry.startsWith(".capacity-lock.repair-candidate.")),
          });
        }
      },
    }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].markerFile, markerName(dead.owner.owner_token, 0));
    assert.deepEqual(Object.keys(seen[0].record), [
      "schema", "repair_pid", "repair_token", "created_at", "target_owner_token", "generation",
    ]);
    assert.equal(seen[0].record.schema, MARKER_SCHEMA);
    assert.equal(seen[0].record.repair_pid, process.pid);
    assert.equal(seen[0].record.target_owner_token, dead.owner.owner_token);
    assert.equal(seen[0].record.generation, 0);
    assert.equal(seen[0].candidates.length, 1, "the candidate file still exists when the marker is published");
    release();
    assert.deepEqual(rootEntries(root), [], "marker, candidate and quarantine are all gone");
  });
});

test("T3 a live holder of the highest generation makes the contender lose without touching anything", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    const marker = writeMarker(root, dead.owner.owner_token, 0, { pid: process.ppid });
    const links = [];
    const renames = [];
    hookFs("linkSync", (real) => (from, to) => { links.push(to); return real(from, to); });
    hookFs("renameSync", (real) => (from, to) => { renames.push({ from, to }); return real(from, to); });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 150 })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.deepEqual(links, [], "a losing contender must not even try to publish a marker");
    assert.deepEqual(renames.filter((rename) => rename.from === lockPath), []);
    assert.deepEqual(realFs.readFileSync(path.join(root, marker.name)), marker.bytes);
    assert.equal(realFs.lstatSync(lockPath).ino, dead.ino);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
  });
});

test("T3 a dead holder of the highest generation is superseded by generation + 1 and its markers are retired", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    writeMarker(root, dead.owner.owner_token, 0, { pid: DEAD_PID });
    let during = [];
    const release = acquireCapacityLock(root, protocolOptions({
      checkpoint: (name) => { if (name === "repair-elected") during = markerNames(root); },
    }));
    assert.deepEqual(during, [markerName(dead.owner.owner_token, 0), markerName(dead.owner.owner_token, 1)]);
    release();
    assert.deepEqual(rootEntries(root), [], "the dead predecessor marker is retired with the new one");
  });
});

test("T3 an unreadable or mismatching highest marker makes the contender lose", () => {
  for (const kind of ["garbage", "wrong-target", "wrong-generation"]) {
    withProtocolRoot(({ root, lockPath }) => {
      const dead = deadLock(root);
      const name = markerName(dead.owner.owner_token, 0);
      const bytes = kind === "garbage"
        ? Buffer.from("not json\n")
        : kind === "wrong-target"
          ? markerBytes(randomUUID(), 0)
          : markerBytes(dead.owner.owner_token, 5);
      realFs.writeFileSync(path.join(root, name), bytes);
      const links = [];
      hookFs("linkSync", (real) => (from, to) => { links.push(to); return real(from, to); });
      assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 100 })), (error) => error.message === NEW_TIMEOUT_MESSAGE, kind);
      assert.deepEqual(links, [], kind);
      assert.deepEqual(realFs.readFileSync(path.join(root, name)), bytes, kind);
      assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes, kind);
    });
  }
});

test("T3 a link EEXIST loses the election quietly and leaves no candidate behind", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    const { events, onProtocolEvent } = eventCollector();
    const renames = [];
    hookFs("renameSync", (real) => (from, to) => { renames.push(from); return real(from, to); });
    hookFs("linkSync", (real) => (from, to) => {
      if (isMarkerPath(to)) throw fsError("EEXIST", "link");
      return real(from, to);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 100, onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.deepEqual(rootEntries(root), [".capacity-lock"], "no candidate or marker may remain");
    assert.equal(renames.includes(lockPath), false);
    assert.deepEqual(events.filter((event) => event.event === "unexpected-fs-error"), []);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
  });
});

test("T3 an ENOENT while reading the highest marker is a lost election, not an error", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    writeMarker(root, dead.owner.owner_token, 0, { pid: DEAD_PID });
    const { events, onProtocolEvent } = eventCollector();
    hookFs("readFileSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("ENOENT", "open");
      return real(target, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 100, onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.deepEqual(events.filter((event) => event.event === "unexpected-fs-error"), []);
  });
});

// ---- T4 (D4): recovery steps and the exit discipline ----------------------

test("T4 recovery removes the dead lock, leaves no quarantine and does not move anything back", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    const renames = [];
    hookFs("renameSync", (real) => (from, to) => { renames.push({ from, to }); return real(from, to); });
    const release = acquireCapacityLock(root, protocolOptions());
    const fromLock = renames.filter((rename) => rename.from === lockPath);
    assert.equal(fromLock.length, 1);
    assert.match(path.basename(fromLock[0].to), /^\.capacity-lock\.recovery\.\d+\.[0-9a-f-]{36}$/);
    assert.deepEqual(renames.filter((rename) => rename.to === lockPath).map((rename) => path.basename(rename.from)).filter((name) => !name.startsWith(".capacity-lock.stage.")), []);
    const current = JSON.parse(realFs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    assert.notEqual(current.owner_token, dead.owner.owner_token);
    assert.deepEqual(rootEntries(root), [".capacity-lock"]);
    release();
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T4 step 4 re-observation: a lock that is gone, replaced by another owner, unreadable or revived is not moved", () => {
  const scenarios = {
    gone: ({ lockPath }) => realFs.rmSync(lockPath, { recursive: true, force: true }),
    "other-owner": ({ lockPath }) => {
      realFs.rmSync(lockPath, { recursive: true, force: true });
      writeLock(lockPath, newOwner(process.ppid, new Date().toISOString()));
    },
    unreadable: ({ lockPath }) => realFs.writeFileSync(path.join(lockPath, "owner.json"), "garbage\n"),
    "pid-reused": ({ lockPath, dead }) => realFs.writeFileSync(
      path.join(lockPath, "owner.json"),
      ownerBytes({ ...dead.owner, owner_pid: process.ppid })
    ),
  };
  for (const [name, mutate] of Object.entries(scenarios)) {
    withProtocolRoot(({ root, lockPath }) => {
      const dead = deadLock(root);
      const renames = [];
      hookFs("renameSync", (real) => (from, to) => { renames.push(from); return real(from, to); });
      const options = protocolOptions({
        waitMs: 120,
        checkpoint: (point) => { if (point === "repair-candidate-removed") mutate({ lockPath, dead }); },
      });
      if (name === "gone") {
        acquireCapacityLock(root, options)();
        assert.deepEqual(rootEntries(root), [], name);
        return;
      }
      const before = realFs.readFileSync(path.join(lockPath, "owner.json"));
      assert.throws(() => acquireCapacityLock(root, options), (error) => error.message.startsWith(NEW_TIMEOUT_MESSAGE), name);
      assert.equal(renames.includes(lockPath), false, `${name}: the lock must not be renamed away`);
      const after = realFs.readFileSync(path.join(lockPath, "owner.json"));
      assert.notEqual(after.length, 0);
      if (name !== "unreadable" && name !== "pid-reused") assert.deepEqual(after, ownerBytes(JSON.parse(after.toString("utf8"))), name);
      assert.deepEqual(markerNames(root), [], `${name}: the elected marker is withdrawn`);
      assert.deepEqual(rootEntries(root), [".capacity-lock"], name);
      assert.ok(before.length > 0);
    });
  }
});

test("T4 step 4 ambiguous evidence: extra items in the dead lock keep it untouched and fail closed", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    const renames = [];
    hookFs("renameSync", (real) => (from, to) => { renames.push(from); return real(from, to); });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      checkpoint: (point) => { if (point === "repair-candidate-removed") realFs.writeFileSync(path.join(lockPath, "stray.txt"), "x"); },
    })), (error) => {
      assert.equal(error.message, "dispatch capacity stale lock contains ambiguous evidence");
      assert.equal(error.classification, "reviewer_dispatch_capacity_exceeded");
      return true;
    });
    assert.equal(renames.includes(lockPath), false);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
    assert.ok(realFs.existsSync(path.join(lockPath, "stray.txt")));
    assert.deepEqual(rootEntries(root), [".capacity-lock"]);
  });
});

test("T4 step 6 mismatch keeps the quarantined directory, moves nothing back and fails closed", () => {
  withProtocolRoot(({ root, lockPath }) => {
    deadLock(root);
    const live = newOwner(process.ppid, new Date().toISOString());
    const renames = [];
    let quarantinePath;
    hookFs("renameSync", (real) => (from, to) => { renames.push({ from, to }); return real(from, to); });
    const { events, onProtocolEvent } = eventCollector();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      // A legacy recoverer moved the dead lock away and someone published a new one,
      // which is what this recoverer's rename then carries into the quarantine path.
      recoveryRename: (from, to) => {
        realFs.renameSync(from, `${from}.aside`);
        writeLock(to, live);
        quarantinePath = to;
      },
    })), (error) => error.message === "dispatch capacity stale-lock identity changed during recovery");
    assert.deepEqual(renames.filter((rename) => rename.to === lockPath), []);
    assert.equal(realFs.existsSync(lockPath), false, "nothing is moved back onto the lock path");
    assert.deepEqual(realFs.readFileSync(path.join(quarantinePath, "owner.json")), ownerBytes(live), "the quarantined directory is preserved");
    assert.deepEqual(markerNames(root), []);
    assert.equal(events.filter((event) => event.event === "repair-quarantine-mismatch").length, 1);
  });
});

test("T4 recoverStaleCapacityLock does not call the restore helper", () => {
  const source = realFs.readFileSync(LOCK_SOURCE_URL, "utf8");
  const body = sourceOfFunction(source, "recoverStaleCapacityLock");
  assert.equal(body.includes("restoreCapacityLockAfterUnsafeRecovery"), false);
  assert.ok(source.includes("restoreCapacityLockAfterUnsafeRecovery"), "the release path keeps its own restore");
});

test("T4 an exception at any checkpoint from repair-elected on withdraws the marker and is rethrown unchanged", () => {
  const points = capacityLockModule.CAPACITY_LOCK_PROTOCOL_CHECKPOINTS;
  const from = points.indexOf("repair-elected");
  const quarantined = points.indexOf("repair-quarantined");
  assert.ok(from >= 0 && quarantined > from);
  for (const point of points.slice(from)) {
    withProtocolRoot(({ root, lockPath }) => {
      const dead = deadLock(root);
      const injected = new Error(`injected at ${point}`);
      assert.throws(() => acquireCapacityLock(root, protocolOptions({
        checkpoint: (name) => { if (name === point) throw injected; },
      })), (error) => error === injected, point);
      assert.deepEqual(markerNames(root), [], `${point}: this process's marker must be withdrawn`);
      if (points.indexOf(point) < quarantined) {
        assert.equal(realFs.lstatSync(lockPath).ino, dead.ino, point);
        assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes, point);
      } else {
        assert.equal(realFs.existsSync(lockPath), false, `${point}: the dead lock was already moved out`);
      }
    });
  }
});

test("T4 a retire failure with a non-retryable code is recorded once and retried first by the next acquisition", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const name = markerName(dead.owner.owner_token, 0);
    const injected = new Error("injected at repair-elected");
    const { events, onProtocolEvent } = eventCollector();
    const unlinks = [];
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) {
        unlinks.push(path.basename(target));
        throw fsError("EIO", "unlink");
      }
      return real(target, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    assert.deepEqual(unlinks, [name], "a non-retryable code is attempted once");
    const failed = events.filter((event) => event.event === "repair-marker-retire-failed");
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0].detail.pending, [name]);
    assert.equal(failed[0].detail.attempts, 1);
    assert.equal(failed[0].code, "EIO");
    assert.deepEqual(markerNames(root), [name]);
    restoreFs();
    const ops = [];
    hookFs("readFileSync", (real) => (target, ...rest) => { if (isMarkerPath(target)) ops.push("read"); return real(target, ...rest); });
    hookFs("unlinkSync", (real) => (target, ...rest) => { if (isMarkerPath(target)) ops.push("unlink"); return real(target, ...rest); });
    hookFs("linkSync", (real) => (from, to) => { ops.push("link"); return real(from, to); });
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent }))();
    assert.deepEqual(ops.slice(0, 3), ["read", "unlink", "link"], "the pending marker is read and removed before anything else");
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T4 a pending marker whose name was reused by another holder is dropped, not deleted", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const name = markerName(dead.owner.owner_token, 0);
    const injected = new Error("injected at repair-elected");
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("EIO", "unlink");
      return real(target, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    restoreFs();
    const foreign = markerBytes(dead.owner.owner_token, 0, { pid: process.ppid });
    realFs.writeFileSync(path.join(root, name), foreign);
    const unlinks = [];
    hookFs("unlinkSync", (real) => (target, ...rest) => { if (isMarkerPath(target)) unlinks.push(path.basename(target)); return real(target, ...rest); });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 100 })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.deepEqual(unlinks, [], "another holder's marker must never be deleted by name");
    assert.deepEqual(realFs.readFileSync(path.join(root, name)), foreign);
    restoreFs();
    realFs.rmSync(path.join(root, name));
    const links = [];
    hookFs("linkSync", (real) => (from, to) => { links.push(path.basename(to)); return real(from, to); });
    const reads = [];
    hookFs("readFileSync", (real) => (target, ...rest) => { if (isMarkerPath(target)) reads.push(path.basename(target)); return real(target, ...rest); });
    acquireCapacityLock(root, protocolOptions())();
    assert.deepEqual(reads, [], "the dropped entry is not read again");
    assert.deepEqual(links, [name]);
  });
});

// ---- T5 (D6): shared retry loop -------------------------------------------

test("T5 the bounded retry loop exists once and is used by release, recovery and marker retirement", () => {
  const source = realFs.readFileSync(LOCK_SOURCE_URL, "utf8");
  assert.equal((source.match(/function retryBounded\(/g) ?? []).length, 1);
  assert.ok((source.match(/retryBounded\(/g) ?? []).length >= 4, "release, recovery and retirement all call it");
  assert.equal((source.match(/Atomics\.wait\(/g) ?? []).length, 1, "a single sleep helper serves every wait");
});

test("T5 win32 recovery exhausting its rename retries leaves the lock byte-for-byte and loses the round", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    let calls = 0;
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      platform: "win32",
      waitMs: 200,
      recoveryRename: () => { calls += 1; throw fsError("EPERM", "rename"); },
    })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.ok(calls > 1, "the recovery rename was retried");
    assert.equal(realFs.lstatSync(lockPath).ino, dead.ino);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
    assert.deepEqual(rootEntries(root), [".capacity-lock"], "the marker is withdrawn");
  });
});

test("T5 win32 recovery retries a transient rename EPERM and then recovers", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    let calls = 0;
    const release = acquireCapacityLock(root, protocolOptions({
      platform: "win32",
      recoveryRename: (from, to) => {
        calls += 1;
        if (calls <= 3) throw fsError("EPERM", "rename");
        return realFs.renameSync(from, to);
      },
    }));
    assert.equal(calls, 4);
    release();
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T5 a recovery rename EPERM is not retried off win32, and an ENOENT means the lock was already recovered", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    let calls = 0;
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      platform: "linux",
      recoveryRename: () => { calls += 1; throw fsError("EPERM", "rename"); },
    })), (error) => error.code === "EPERM" && typeof error.capacityLockStep === "string");
    assert.equal(calls, 1);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
    assert.deepEqual(markerNames(root), []);
    // ENOENT: another recoverer won; the loser acquires instead of failing.
    let enoent = 0;
    const release = acquireCapacityLock(root, protocolOptions({
      recoveryRename: (from) => {
        enoent += 1;
        realFs.rmSync(from, { recursive: true, force: true });
        throw fsError("ENOENT", "rename");
      },
    }));
    assert.equal(enoent, 1);
    release();
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T5 recovery re-proves the lock before every retry and stops when it was replaced", () => {
  withProtocolRoot(({ root, lockPath }) => {
    deadLock(root);
    const live = newOwner(process.ppid, new Date().toISOString());
    let calls = 0;
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      platform: "win32",
      waitMs: 150,
      recoveryRename: () => {
        calls += 1;
        realFs.rmSync(lockPath, { recursive: true, force: true });
        writeLock(lockPath, live);
        throw fsError("EPERM", "rename");
      },
    })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.equal(calls, 1, "a replaced lock is never renamed again");
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), ownerBytes(live));
    assert.deepEqual(markerNames(root), []);
  });
});

test("T5 a marker retire EPERM is retried after confirming the marker is still this process's, then succeeds", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const injected = new Error("injected at repair-elected");
    const { events, onProtocolEvent } = eventCollector();
    const ops = [];
    let unlinkCount = 0;
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) {
        ops.push("unlink");
        unlinkCount += 1;
        if (unlinkCount === 1) throw fsError("EPERM", "unlink");
      }
      return real(target, ...rest);
    });
    hookFs("readFileSync", (real) => (target, ...rest) => { if (isMarkerPath(target)) ops.push("read"); return real(target, ...rest); });
    hookFs("linkSync", (real) => (from, to) => { ops.push("link"); return real(from, to); });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    assert.deepEqual(ops, ["link", "unlink", "read", "unlink"]);
    assert.deepEqual(markerNames(root), []);
    assert.deepEqual(events.filter((event) => event.event === "repair-marker-retire-failed"), []);
    ops.length = 0;
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent }))();
    assert.equal(ops[0], "link", "an empty pending set means no marker read or unlink before the election");
    assert.equal(dead.owner.owner_token.length, 36);
  });
});

test("T5 a marker replaced during the retry window is not deleted", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const name = markerName(dead.owner.owner_token, 0);
    const foreign = markerBytes(dead.owner.owner_token, 0, { pid: process.ppid });
    const injected = new Error("injected at repair-elected");
    const { events, onProtocolEvent } = eventCollector();
    let unlinkCount = 0;
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) {
        unlinkCount += 1;
        assert.equal(unlinkCount, 1, "the replacement must never be unlinked");
        real(target, ...rest);
        realFs.writeFileSync(target, foreign);
        throw fsError("EPERM", "unlink");
      }
      return real(target, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    assert.deepEqual(realFs.readFileSync(path.join(root, name)), foreign);
    assert.deepEqual(events.filter((event) => event.event === "repair-marker-retire-failed"), []);
  });
});

test("T5 an unreadable marker is never deleted by name; the budget ends in exactly one record", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const name = markerName(dead.owner.owner_token, 0);
    const injected = new Error("injected at repair-elected");
    const { events, onProtocolEvent } = eventCollector();
    const unlinks = [];
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) {
        unlinks.push(path.basename(target));
        throw fsError("EPERM", "unlink");
      }
      return real(target, ...rest);
    });
    hookFs("readFileSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("EPERM", "open");
      return real(target, ...rest);
    });
    const started = Date.now();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      repairRetireRetryMs: 60,
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(unlinks, [name], "only the first, unconfirmed deletion runs");
    const failed = events.filter((event) => event.event === "repair-marker-retire-failed");
    assert.equal(failed.length, 1);
    assert.ok(failed[0].detail.attempts > 1);
    assert.deepEqual(failed[0].detail.pending, [name]);
    assert.deepEqual(markerNames(root), [name]);
  });
});

test("T5 the retire retry is capped at 200 rounds even when the time budget is large", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    const injected = new Error("injected at repair-elected");
    const { events, onProtocolEvent } = eventCollector();
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("EBUSY", "unlink");
      return real(target, ...rest);
    });
    hookFs("readFileSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("EBUSY", "open");
      return real(target, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      repairRetireRetryMs: 600_000,
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    const failed = events.filter((event) => event.event === "repair-marker-retire-failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].detail.attempts, 201, "the first deletion plus 200 retry rounds");
  });
});

// ---- T6 (D12): release path restore condition -----------------------------

test("T6 a release whose owner.json unlink fails still restores the complete lock", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const release = acquireCapacityLock(root, protocolOptions());
    const before = realFs.readFileSync(path.join(lockPath, "owner.json"));
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (path.basename(target) === "owner.json" && path.basename(path.dirname(target)).startsWith(".capacity-lock.release.")) {
        throw fsError("EIO", "unlink");
      }
      return real(target, ...rest);
    });
    assert.throws(release, (error) => error.code === "EIO");
    assert.deepEqual(rootEntries(root), [".capacity-lock"]);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), before);
  });
});

test("T6 a release that finds no owner.json in the isolated directory does not move it back", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const renames = [];
    hookFs("renameSync", (real) => (from, to) => { renames.push({ from, to }); return real(from, to); });
    const release = acquireCapacityLock(root, protocolOptions({
      releaseRename: (from, to) => {
        realFs.renameSync(from, to);
        realFs.unlinkSync(path.join(to, "owner.json"));
      },
    }));
    assert.throws(release, /identity changed during release/);
    assert.deepEqual(renames.filter((rename) => rename.to === lockPath).map((rename) => path.basename(rename.from)).filter((name) => !name.startsWith(".capacity-lock.stage.")), []);
    assert.equal(realFs.existsSync(lockPath), false);
    const leftovers = rootEntries(root);
    assert.equal(leftovers.length, 1);
    assert.match(leftovers[0], /^\.capacity-lock\.release\./);
    assert.deepEqual(realFs.readdirSync(path.join(root, leftovers[0])), []);
  });
});

// ---- T7 (D5): residue cleanup ---------------------------------------------

const UNDECIDABLE_MESSAGE = "dispatch capacity gate is unavailable; reservation failed closed; \".capacity-lock\" in the control-evidence root (notes/tmp/state/devpro-second-review-control-evidence under the main checkout, or DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR when set) has no valid owner record; remove it manually once no reviewer dispatch is running";

function residueDirectory(root, name, { owner, raw, extra } = {}) {
  const dir = path.join(root, name);
  realFs.mkdirSync(dir, { mode: 0o700 });
  if (owner) realFs.writeFileSync(path.join(dir, "owner.json"), ownerBytes(owner));
  if (raw !== undefined) realFs.writeFileSync(path.join(dir, "owner.json"), raw);
  if (extra) realFs.writeFileSync(path.join(dir, extra), "x");
  return dir;
}

function residueName(kind, pid) {
  return `.capacity-lock.${kind}.${pid}.${randomUUID()}`;
}

function sweepWith(root, extra = {}) {
  const collector = eventCollector();
  acquireCapacityLock(root, protocolOptions({ onProtocolEvent: collector.onProtocolEvent, ...extra }))();
  return collector.events;
}

function deadResidueOwner() {
  return newOwner(DEAD_PID, new Date(Date.now() - 3_600_000).toISOString());
}

test("T7 a staging directory is removed only when its creator is dead and it holds nothing but owner.json", () => {
  withProtocolRoot(({ root }) => {
    const emptyDead = residueName("stage", DEAD_PID);
    const ownerDead = residueName("stage", DEAD_PID);
    const garbledDead = residueName("stage", DEAD_PID);
    const strayDead = residueName("stage", DEAD_PID);
    const live = residueName("stage", process.ppid);
    residueDirectory(root, emptyDead);
    const staged = deadResidueOwner();
    residueDirectory(root, ownerDead, { owner: staged });
    residueDirectory(root, garbledDead, { raw: "garbled\n" });
    residueDirectory(root, strayDead, { owner: staged, extra: "stray.txt" });
    residueDirectory(root, live, { owner: newOwner(process.ppid, new Date().toISOString()) });
    const events = sweepWith(root);
    assert.deepEqual(rootEntries(root), [live, strayDead].sort());
    const removing = events.filter((event) => event.event === "residue-owner-removing");
    assert.deepEqual(removing.map((event) => event.detail.item).sort(), [garbledDead, ownerDead].sort());
    assert.equal(removing.find((event) => event.detail.item === garbledDead).detail.owner, null);
    assert.equal(removing.find((event) => event.detail.item === ownerDead).detail.owner.owner_token, staged.owner_token);
    const preserved = events.filter((event) => event.event === "residue-preserved");
    assert.deepEqual(preserved.map((event) => event.detail.item), [strayDead]);
  });
});

test("T7 candidate files and repair markers are removed only when their creator is dead", () => {
  withProtocolRoot(({ root }) => {
    const target = randomUUID();
    const deadCandidate = residueName("repair-candidate", DEAD_PID);
    const liveCandidate = residueName("repair-candidate", process.ppid);
    realFs.writeFileSync(path.join(root, deadCandidate), "x");
    realFs.writeFileSync(path.join(root, liveCandidate), "x");
    const deadMarker = writeMarker(root, target, 0, { pid: DEAD_PID });
    const liveMarker = writeMarker(root, randomUUID(), 0, { pid: process.ppid });
    const malformedName = markerName(randomUUID(), 0);
    realFs.writeFileSync(path.join(root, malformedName), "garbled\n");
    const events = sweepWith(root);
    assert.deepEqual(rootEntries(root), [liveCandidate, liveMarker.name, malformedName].sort());
    assert.deepEqual(events.filter((event) => event.event === "residue-owner-removing"), []);
    assert.ok(deadMarker.name);
  });
});

test("T7 quarantine and release directories follow the same table: removal needs a dead creator and provably dead evidence", () => {
  for (const kind of ["recovery", "release"]) {
    withProtocolRoot(({ root }) => {
      const dead = deadResidueOwner();
      const emptyDead = residueName(kind, DEAD_PID);
      const ownerDead = residueName(kind, DEAD_PID);
      const ownerAlive = residueName(kind, DEAD_PID);
      const malformed = residueName(kind, DEAD_PID);
      const stray = residueName(kind, DEAD_PID);
      const creatorAlive = residueName(kind, process.ppid);
      residueDirectory(root, emptyDead);
      residueDirectory(root, ownerDead, { owner: dead });
      residueDirectory(root, ownerAlive, { owner: newOwner(process.ppid, new Date().toISOString()) });
      residueDirectory(root, malformed, { raw: "{\"schema\":\"incomplete\"}\n" });
      residueDirectory(root, stray, { owner: dead, extra: "stray.txt" });
      residueDirectory(root, creatorAlive, { owner: dead });
      const events = sweepWith(root);
      assert.deepEqual(rootEntries(root), [creatorAlive, malformed, ownerAlive, stray].sort(), kind);
      assert.deepEqual(
        events.filter((event) => event.event === "residue-owner-removing").map((event) => event.detail.item),
        [ownerDead],
        kind
      );
      assert.deepEqual(
        events.filter((event) => event.event === "residue-preserved").map((event) => event.detail.item).sort(),
        [malformed, ownerAlive, stray].sort(),
        kind
      );
    });
  }
});

test("T7 the owner record is announced before it is deleted, and an unwritable record keeps the residue", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadResidueOwner();
    const name = residueName("release", DEAD_PID);
    const dir = residueDirectory(root, name, { owner: dead });
    const bytes = ownerBytes(dead);
    const log = [];
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (path.basename(target) === "owner.json" && path.dirname(target) === dir) log.push("unlink-owner");
      return real(target, ...rest);
    });
    // 1. the destination refuses the record: nothing is deleted and the lock is still granted
    const refused = acquireCapacityLock(root, protocolOptions({
      onProtocolEvent: (record) => { if (record.event === "residue-owner-removing") throw fsError("EPIPE", "write"); },
    }));
    refused();
    assert.deepEqual(realFs.readFileSync(path.join(dir, "owner.json")), bytes);
    assert.deepEqual(log, []);
    // 2. the real destination (stderr) refuses the record
    hookFs("writeSync", (real) => (fd, ...rest) => {
      if (fd === 2) throw fsError("EPIPE", "write");
      return real(fd, ...rest);
    });
    acquireCapacityLock(root, { staleAfterMs: 1000, waitMs: 2000 })();
    assert.deepEqual(realFs.readFileSync(path.join(dir, "owner.json")), bytes, "the destination failed, so the residue stays");
    assert.deepEqual(log, []);
    // 3. a working destination: the record precedes the deletion and the residue goes
    restoreFs();
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (path.basename(target) === "owner.json" && path.dirname(target) === dir) log.push("unlink-owner");
      return real(target, ...rest);
    });
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent: (record) => { log.push(record.event); } }))();
    assert.deepEqual(log, ["residue-owner-removing", "unlink-owner"]);
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T7 a residue that cannot be removed is deferred with a record and does not affect the lock", () => {
  withProtocolRoot(({ root }) => {
    const name = residueName("release", DEAD_PID);
    residueDirectory(root, name, { owner: deadResidueOwner() });
    hookFs("rmdirSync", (real) => (target, ...rest) => {
      if (path.basename(target) === name) throw fsError("EBUSY", "rmdir");
      return real(target, ...rest);
    });
    const events = sweepWith(root);
    const deferred = events.filter((event) => event.event === "residue-deferred");
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].detail.item, name);
    assert.equal(deferred[0].code, "EBUSY");
    assert.deepEqual(rootEntries(root), [name]);
  });
});

test("T7 a checkpoint exception during the cleanup is rethrown unchanged and does not leave the lock held", () => {
  withProtocolRoot(({ root }) => {
    residueDirectory(root, residueName("release", DEAD_PID), { owner: deadResidueOwner() });
    const injected = new Error("injected at sweep-owner-removed");
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      checkpoint: (name) => { if (name === "sweep-owner-removed") throw injected; },
    })), (error) => error === injected);
    assert.equal(realFs.existsSync(path.join(root, ".capacity-lock")), false);
  });
});

// ---- T8 (D7): undecidable lock evidence and every pre-existing disk state ---

function assertNewTimeout(action, expected, lockPath) {
  assert.throws(action, (error) => {
    assert.equal(error.message, expected);
    assert.equal(error.classification, "reviewer_dispatch_capacity_exceeded");
    if (expected === UNDECIDABLE_MESSAGE) assert.equal(error.capacityLockManualRemovalPath, lockPath);
    else assert.equal(error.capacityLockManualRemovalPath, undefined);
    return true;
  });
}

test("T8 FR-8 missing owner record: preserved, failed closed with the manual-removal wording and path property", () => {
  withProtocolRoot(({ root, lockPath }) => {
    realFs.mkdirSync(lockPath, { mode: 0o700 });
    assertNewTimeout(() => acquireCapacityLock(root, protocolOptions({ waitMs: 0, staleAfterMs: 0 })), UNDECIDABLE_MESSAGE, lockPath);
    assert.deepEqual(realFs.readdirSync(lockPath), []);
    assert.deepEqual(rootEntries(root), [".capacity-lock"]);
  });
});

test("T8 FR-8 malformed owner record: preserved byte-for-byte with the manual-removal wording", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const bytes = Buffer.from("{\"schema\":\"incomplete\"}\n");
    realFs.mkdirSync(lockPath, { mode: 0o700 });
    realFs.writeFileSync(path.join(lockPath, "owner.json"), bytes);
    assertNewTimeout(() => acquireCapacityLock(root, protocolOptions({ waitMs: 0, staleAfterMs: 0 })), UNDECIDABLE_MESSAGE, lockPath);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), bytes);
    assert.equal(UNDECIDABLE_MESSAGE.includes(root), false, "the message never carries an absolute path");
  });
});

test("T8 FR-8 live owner: waits to the bound and never touches the lock", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const live = newOwner(process.ppid, new Date(Date.now() - 3_600_000).toISOString());
    writeLock(lockPath, live);
    assertNewTimeout(() => acquireCapacityLock(root, protocolOptions({ waitMs: 60, staleAfterMs: 0 })), NEW_TIMEOUT_MESSAGE, lockPath);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), ownerBytes(live));
    assert.deepEqual(rootEntries(root), [".capacity-lock"]);
  });
});

test("T8 FR-8 dead owner past the stale threshold: recovered and the lock acquired", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const release = acquireCapacityLock(root, protocolOptions());
    const current = JSON.parse(realFs.readFileSync(path.join(root, ".capacity-lock", "owner.json"), "utf8"));
    assert.notEqual(current.owner_token, dead.owner.owner_token);
    release();
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T8 FR-8 dead owner inside the stale threshold: waits, never elects, fails closed untouched", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root, { ageMs: 1000 });
    const links = [];
    hookFs("linkSync", (real) => (from, to) => { links.push(to); return real(from, to); });
    assertNewTimeout(() => acquireCapacityLock(root, protocolOptions({ waitMs: 60, staleAfterMs: 3_600_000 })), NEW_TIMEOUT_MESSAGE, lockPath);
    assert.deepEqual(links, []);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
  });
});

test("T8 FR-8 leftover recovery directory from the old protocol is cleaned by the next acquisition", () => {
  withProtocolRoot(({ root }) => {
    residueDirectory(root, residueName("recovery", DEAD_PID), { owner: deadResidueOwner() });
    sweepWith(root);
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T8 FR-8 leftover release directory from the old protocol is cleaned by the next acquisition", () => {
  withProtocolRoot(({ root }) => {
    residueDirectory(root, residueName("release", DEAD_PID));
    residueDirectory(root, residueName("release", DEAD_PID), { owner: deadResidueOwner() });
    sweepWith(root);
    assert.deepEqual(rootEntries(root), []);
  });
});

// ---- T9 (D9): correlatable records -----------------------------------------

function assertEventShape(record, name) {
  assert.deepEqual(Object.keys(record), ["event", "at", "pid", "step", "code", "lock", "detail"], name);
  assert.equal(record.event, name);
  assert.equal(new Date(record.at).toISOString(), record.at);
  assert.equal(record.pid, process.pid);
  assert.equal(typeof record.step, "string");
  assert.ok(record.code === null || typeof record.code === "string");
  assert.equal(typeof record.detail, "object");
  assert.ok(record.detail !== null);
}

function assertLockIdentity(lock, owner) {
  assert.deepEqual(Object.keys(lock), ["dev", "ino", "owner_pid", "owner_token", "created_at"]);
  assert.equal(lock.owner_pid, owner.owner_pid);
  assert.equal(lock.owner_token, owner.owner_token);
  assert.equal(lock.created_at, owner.created_at);
  assert.equal(typeof lock.dev, "number");
  assert.equal(typeof lock.ino, "number");
}

test("T9 repair-target-verified carries the dead owner's identity and is the only record of a clean recovery", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const { events, onProtocolEvent } = eventCollector();
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent }))();
    assert.deepEqual(events.map((event) => event.event), ["repair-target-verified"]);
    assertEventShape(events[0], "repair-target-verified");
    assertLockIdentity(events[0].lock, dead.owner);
    assert.equal(events[0].lock.ino, dead.ino);
    assert.equal(JSON.stringify(events[0]).includes(root), false, "records never carry an absolute path");
  });
});

test("T9 repair-quarantine-mismatch and repair-marker-retire-failed carry their details", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const live = newOwner(process.ppid, new Date().toISOString());
    const { events, onProtocolEvent } = eventCollector();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      recoveryRename: (from, to) => {
        realFs.renameSync(from, `${from}.aside`);
        writeLock(to, live);
      },
    })), /identity changed during recovery/);
    const mismatch = events.find((event) => event.event === "repair-quarantine-mismatch");
    assertEventShape(mismatch, "repair-quarantine-mismatch");
    assertLockIdentity(mismatch.detail.expected, dead.owner);
    assertLockIdentity(mismatch.detail.actual, live);
    assert.match(mismatch.detail.quarantine, /^\.capacity-lock\.recovery\./);
    assert.equal(JSON.stringify(mismatch).includes(root), false);
  });
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const { events, onProtocolEvent } = eventCollector();
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("EIO", "unlink");
      return real(target, ...rest);
    });
    const injected = new Error("injected");
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      onProtocolEvent,
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    const failed = events.find((event) => event.event === "repair-marker-retire-failed");
    assertEventShape(failed, "repair-marker-retire-failed");
    assert.equal(failed.code, "EIO");
    assert.deepEqual(Object.keys(failed.detail), ["marker", "attempts", "pending"]);
    assert.equal(failed.detail.marker, markerName(dead.owner.owner_token, 0));
    assert.equal(failed.lock, null);
    assert.equal(JSON.stringify(failed).includes(root), false);
  });
});

test("T9 unexpected-fs-error names the step and code, the thrown error keeps its code and gains capacityLockStep", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const { events, onProtocolEvent } = eventCollector();
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath) throw fsError("EACCES", "rename");
      return real(from, to);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ onProtocolEvent })), (error) => {
      assert.equal(error.code, "EACCES");
      assert.equal(error.capacityLockStep, "publish-rename");
      return true;
    });
    assert.equal(events.length, 1);
    assertEventShape(events[0], "unexpected-fs-error");
    assert.equal(events[0].step, "publish-rename");
    assert.equal(events[0].code, "EACCES");
  });
  // a failing release after the owner record was removed (D12) records the step and rethrows the same error
  withProtocolRoot(({ root, lockPath }) => {
    const { events, onProtocolEvent } = eventCollector();
    const release = acquireCapacityLock(root, protocolOptions({ onProtocolEvent }));
    const failure = fsError("EIO", "rmdir");
    hookFs("rmdirSync", (real) => (target, ...rest) => {
      if (path.basename(target).startsWith(".capacity-lock.release.")) throw failure;
      return real(target, ...rest);
    });
    assert.throws(release, (error) => error === failure);
    assert.equal(realFs.existsSync(lockPath), false);
    assertEventShape(events[0], "unexpected-fs-error");
    assert.equal(events[0].code, "EIO");
    assert.equal(failure.capacityLockStep, events[0].step);
  });
});

test("T9 an unexpected error on the recovery path carries the step, the code and the observed dead lock", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const { events, onProtocolEvent } = eventCollector();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      platform: "linux",
      onProtocolEvent,
      recoveryRename: () => { throw fsError("EACCES", "rename"); },
    })), (error) => {
      assert.equal(error.code, "EACCES", "the original error code is kept");
      assert.equal(typeof error.capacityLockStep, "string");
      return true;
    });
    const unexpected = events.filter((event) => event.event === "unexpected-fs-error");
    assert.equal(unexpected.length, 1, "exactly one record per failure");
    assertEventShape(unexpected[0], "unexpected-fs-error");
    assert.equal(unexpected[0].code, "EACCES");
    assert.equal(unexpected[0].step, "repair-quarantine-rename");
    assertLockIdentity(unexpected[0].lock, dead.owner);
    assert.equal(JSON.stringify(unexpected[0]).includes(root), false);
    assert.deepEqual(markerNames(root), []);
  });
});

test("T9 residue-preserved, residue-deferred and residue-owner-removing carry the item name and no absolute path", () => {
  withProtocolRoot(({ root }) => {
    const name = residueName("recovery", DEAD_PID);
    residueDirectory(root, name, { owner: deadResidueOwner(), extra: "stray.txt" });
    const events = sweepWith(root);
    assert.equal(events.length, 1);
    assertEventShape(events[0], "residue-preserved");
    assert.equal(events[0].detail.item, name);
    assert.equal(typeof events[0].detail.reason, "string");
    assert.equal(JSON.stringify(events[0]).includes(root), false);
  });
  withProtocolRoot(({ root }) => {
    const name = residueName("release", DEAD_PID);
    const owner = deadResidueOwner();
    residueDirectory(root, name, { owner });
    hookFs("rmdirSync", (real) => (target, ...rest) => {
      if (path.basename(target) === name) throw fsError("EBUSY", "rmdir");
      return real(target, ...rest);
    });
    const events = sweepWith(root);
    assert.deepEqual(events.map((event) => event.event), ["residue-owner-removing", "residue-deferred"]);
    assertEventShape(events[0], "residue-owner-removing");
    assert.equal(events[0].detail.item, name);
    assert.deepEqual(events[0].detail.owner, { owner_pid: owner.owner_pid, owner_token: owner.owner_token, created_at: owner.created_at });
    assert.equal(events[0].lock, null);
    assertEventShape(events[1], "residue-deferred");
    assert.equal(events[1].code, "EBUSY");
    assert.equal(events[1].detail.item, name);
    for (const event of events) assert.equal(JSON.stringify(event).includes(root), false);
  });
});

test("T9 the default destination is one prefixed JSON line on fd 2; normal acquire and release write nothing", () => {
  withProtocolRoot(({ root }) => {
    const writes = [];
    hookFs("writeSync", (real) => (fd, ...rest) => {
      if (fd === 2) writes.push(Buffer.from(rest[0]).toString("utf8"));
      return real(fd, ...rest);
    });
    const release = acquireCapacityLock(root, { staleAfterMs: 1000 });
    release();
    assert.deepEqual(writes, [], "a normal acquisition and release must not write to stderr");
    deadLock(root);
    // swallow the real stderr write: the sink is observed, not forwarded
    restoreFs();
    const captured = [];
    hookFs("writeSync", (real) => (fd, ...rest) => {
      if (fd === 2) {
        captured.push(Buffer.from(rest[0]).toString("utf8"));
        return rest[2] ?? Buffer.byteLength(String(rest[0]));
      }
      return real(fd, ...rest);
    });
    acquireCapacityLock(root, { staleAfterMs: 1000 })();
    assert.equal(captured.length, 1);
    assert.match(captured[0], /^devpro-capacity-lock-event \{.*\}\n$/);
    const record = JSON.parse(captured[0].slice("devpro-capacity-lock-event ".length));
    assertEventShape(record, "repair-target-verified");
  });
});

test("T9 the default destination retries EAGAIN briefly and finishes a partially accepted line", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    let eagain = 2;
    let received = Buffer.alloc(0);
    hookFs("writeSync", (real) => (fd, ...rest) => {
      if (fd !== 2) return real(fd, ...rest);
      if (eagain > 0) {
        eagain -= 1;
        throw fsError("EAGAIN", "write");
      }
      const [buffer, offset = 0, length = buffer.length - offset] = rest;
      const taken = Math.min(7, length);
      received = Buffer.concat([received, buffer.subarray(offset, offset + taken)]);
      return taken;
    });
    acquireCapacityLock(root, { staleAfterMs: 1000 })();
    assert.match(received.toString("utf8"), /^devpro-capacity-lock-event \{.*"event":"repair-target-verified".*\}\n$/);
  });
});

test("T9 when the real destination refuses the required record the dead lock is not recovered", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    const renames = [];
    const links = [];
    hookFs("renameSync", (real) => (from, to) => { renames.push(from); return real(from, to); });
    hookFs("linkSync", (real) => (from, to) => { links.push(path.basename(to)); return real(from, to); });
    hookFs("writeSync", (real) => (fd, ...rest) => {
      if (fd === 2 && Buffer.from(rest[0]).toString("utf8").startsWith("devpro-capacity-lock-event")) {
        throw fsError("EPIPE", "write");
      }
      return real(fd, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, { waitMs: 300, staleAfterMs: 1000 }), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.equal(renames.includes(lockPath), false, "the dead lock must not be moved");
    assert.equal(realFs.lstatSync(lockPath).ino, dead.ino);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
    assert.deepEqual(rootEntries(root), [".capacity-lock"], "no quarantine and no marker remain");
    assert.equal(links.length, 1, "after the refusal this call does not take part in another election");
  });
});

test("T9 an onProtocolEvent that throws counts as a failed destination for the required record", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      waitMs: 150,
      onProtocolEvent: () => { throw new Error("sink down"); },
    })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
  });
});

test("T9 the required record is written before the dead lock is renamed", () => {
  withProtocolRoot(({ root, lockPath }) => {
    deadLock(root);
    const log = [];
    hookFs("renameSync", (real) => (from, to) => {
      if (from === lockPath && path.basename(to).startsWith(".capacity-lock.recovery.")) log.push("rename-lock");
      return real(from, to);
    });
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent: (record) => { log.push(record.event); } }))();
    assert.deepEqual(log, ["repair-target-verified", "rename-lock"]);
  });
});

test("T9 a best-effort record that cannot be delivered never changes the lock outcome", () => {
  withProtocolRoot(({ root }) => {
    residueDirectory(root, residueName("recovery", DEAD_PID), { owner: deadResidueOwner(), extra: "stray.txt" });
    const release = acquireCapacityLock(root, protocolOptions({ onProtocolEvent: () => { throw new Error("sink down"); } }));
    release();
  });
});

// ---- Round-644 findings: publication race with a released competitor, and read-failure classification ----

test("T2 a publish rename refused because a competitor held the path, released before the follow-up lstat, is observed again", () => {
  for (const platform of ["linux", "win32"]) {
    for (const code of ["ENOTEMPTY", "EEXIST"]) {
      withProtocolRoot(({ root, lockPath }) => {
        const { events, onProtocolEvent } = eventCollector();
        let armed = true;
        hookFs("renameSync", (real) => (from, to) => {
          if (armed && to === lockPath) {
            armed = false;
            // The competitor published and released between this contender's lstat and its follow-up lstat.
            throw fsError(code, "rename");
          }
          return real(from, to);
        });
        const release = acquireCapacityLock(root, protocolOptions({ platform, onProtocolEvent }));
        assert.equal(armed, false);
        assert.equal(JSON.parse(realFs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).owner_pid, process.pid, `${platform} ${code}`);
        assert.deepEqual(events, [], `${platform} ${code}: a lost publication race is not an unexpected error`);
        release();
        assert.deepEqual(rootEntries(root), []);
      });
    }
  }
});

test("T2 the repro: a competitor that publishes and releases around the refused rename does not fail the contender", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const { events, onProtocolEvent } = eventCollector();
    let armed = true;
    hookFs("renameSync", (real) => (from, to) => {
      if (armed && to === lockPath) {
        armed = false;
        realFs.mkdirSync(lockPath);
        realFs.writeFileSync(path.join(lockPath, "owner.json"), "competitor\n");
        try { return real(from, to); } finally { realFs.rmSync(lockPath, { recursive: true, force: true }); }
      }
      return real(from, to);
    });
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent }))();
    assert.deepEqual(events, []);
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T2 a publish refusal that keeps recurring while the path is free stops at the wait deadline without an error record", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const { events, onProtocolEvent } = eventCollector();
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath) throw fsError("ENOTEMPTY", "rename");
      return real(from, to);
    });
    const started = Date.now();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 60, onProtocolEvent })), (error) => {
      assert.equal(error.classification, "reviewer_dispatch_capacity_exceeded");
      return true;
    });
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(events, []);
    assert.deepEqual(rootEntries(root), [], "the staging directory is removed");
  });
});

test("T2 a genuinely unexpected publish error code still writes a record and is thrown even when the path is free", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const { events, onProtocolEvent } = eventCollector();
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath) throw fsError("EIO", "rename");
      return real(from, to);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ onProtocolEvent })), (error) => error.code === "EIO" && error.capacityLockStep === "publish-rename");
    assert.deepEqual(events.map((event) => `${event.event}:${event.code}:${event.step}`), ["unexpected-fs-error:EIO:publish-rename"]);
  });
});

test("T7 a residue whose owner.json cannot be read for a transient file system reason is deferred, not called malformed", () => {
  for (const kind of ["release", "recovery"]) {
    for (const code of ["EPERM", "EBUSY", "EACCES", "EIO"]) {
      withProtocolRoot(({ root }) => {
        const name = residueName(kind, DEAD_PID);
        const dir = residueDirectory(root, name, { owner: deadResidueOwner() });
        const bytes = realFs.readFileSync(path.join(dir, "owner.json"));
        hookFs("readFileSync", (real) => (target, ...rest) => {
          if (target === path.join(dir, "owner.json")) throw fsError(code, "open");
          return real(target, ...rest);
        });
        const events = sweepWith(root);
        assert.deepEqual(events.map((event) => event.event), ["residue-deferred"], `${kind} ${code}`);
        assert.equal(events[0].code, code);
        assert.equal(events[0].detail.item, name);
        assert.deepEqual(realFs.readFileSync(path.join(dir, "owner.json")), bytes, "the residue is untouched");
      });
    }
  }
});

test("T7 a residue whose owner.json vanishes while being read is treated as already handled, and malformed content is still preserved", () => {
  withProtocolRoot(({ root }) => {
    const name = residueName("release", DEAD_PID);
    const dir = residueDirectory(root, name, { owner: deadResidueOwner() });
    hookFs("readFileSync", (real) => (target, ...rest) => {
      if (target === path.join(dir, "owner.json")) throw fsError("ENOENT", "open");
      return real(target, ...rest);
    });
    assert.deepEqual(sweepWith(root), []);
  });
  withProtocolRoot(({ root }) => {
    const name = residueName("release", DEAD_PID);
    residueDirectory(root, name, { raw: "{\"schema\":\"incomplete\"}\n" });
    const events = sweepWith(root);
    assert.deepEqual(events.map((event) => `${event.event}:${event.detail.reason}`), ["residue-preserved:owner-record-invalid"]);
  });
});

// ---- fsync order (design D10, D11) -------------------------------------------
// The module reaches fsync through named imports, which fs.fsyncSync interception sees after
// syncBuiltinESMExports; the fixture shim (preloaded or not) is replaced the same way as rename.

const ROLE_PATTERNS = [
  [/^\.capacity-lock$/, "<lock>"],
  [/^\.capacity-lock\.stage\./, "<stage>"],
  [/^\.capacity-lock\.release\./, "<release>"],
  [/^\.capacity-lock\.recovery\./, "<quarantine>"],
  [/^\.capacity-lock\.repair-candidate\./, "<candidate>"],
  [/^\.capacity-lock\.repair\./, "<marker>"],
];

function roleOf(root, target) {
  const relative = path.relative(root, String(target));
  if (relative === "") return "<root>";
  const [first, ...rest] = relative.split(path.sep);
  const role = ROLE_PATTERNS.find(([pattern]) => pattern.test(first))?.[1] ?? first;
  return [role, ...rest].join("/");
}

function parentRole(role) {
  const cut = role.lastIndexOf("/");
  return cut < 0 ? "<root>" : role.slice(0, cut);
}

// Wraps whatever is installed now, so a fault hook installed earlier keeps working underneath.
function wrapInstalledFs(name, wrap) {
  fs[name] = wrap(fs[name]);
  hookedFsNames.add(name);
  syncBuiltinESMExports();
}

// Records, in call order, every call that changes the directory tree and every fsync (by the path
// the descriptor was opened from), as readable strings such as "unlink <marker>" or "fsync <root>".
// A call that throws is not recorded.
function recordDurabilityOps(root) {
  const ops = [];
  const fdTargets = new Map();
  wrapInstalledFs("openSync", (real) => (target, ...rest) => {
    const fd = real(target, ...rest);
    fdTargets.set(fd, String(target));
    return fd;
  });
  wrapInstalledFs("fsyncSync", (real) => (fd) => {
    const result = real(fd);
    ops.push(`fsync ${roleOf(root, fdTargets.get(fd) ?? "?")}`);
    return result;
  });
  for (const [name, verb] of [["mkdirSync", "mkdir"], ["unlinkSync", "unlink"], ["rmdirSync", "rmdir"]]) {
    wrapInstalledFs(name, (real) => (target, ...rest) => {
      const result = real(target, ...rest);
      ops.push(`${verb} ${roleOf(root, target)}`);
      return result;
    });
  }
  for (const [name, verb] of [["renameSync", "rename"], ["linkSync", "link"]]) {
    wrapInstalledFs(name, (real) => (from, to) => {
      const result = real(from, to);
      ops.push(`${verb} ${roleOf(root, from)} -> ${roleOf(root, to)}`);
      return result;
    });
  }
  return ops;
}

// The durability contract on a recorded call list: a mkdir or rename is followed at once by an fsync
// of the directory it changed; a removal is followed by an fsync of its parent before anything is
// created and before the parent itself is removed.
function assertDurableOrder(ops, label) {
  ops.forEach((op, index) => {
    const [verb, ...rest] = op.split(" ");
    const subject = rest.join(" ");
    if (verb === "mkdir") {
      assert.equal(ops[index + 1], `fsync ${parentRole(subject)}`, `${label}: ${op} must be followed by an fsync of its parent (${ops.join(" | ")})`);
    } else if (verb === "rename") {
      const target = subject.split(" -> ")[1];
      assert.equal(ops[index + 1], `fsync ${parentRole(target)}`, `${label}: ${op} must be followed by an fsync of its destination directory (${ops.join(" | ")})`);
    } else if (verb === "unlink" || verb === "rmdir") {
      const parent = parentRole(subject);
      let durable = false;
      for (const later of ops.slice(index + 1)) {
        if (later === `fsync ${parent}`) { durable = true; break; }
        if (/^(mkdir|link|rename) /.test(later) || later === `rmdir ${parent}`) break;
      }
      assert.ok(durable, `${label}: ${op} must be followed by an fsync of ${parent} (${ops.join(" | ")})`);
    }
  });
}

test("T12 an uncontended acquire and release fsync the parent after every create, publish and release step", () => {
  withProtocolRoot(({ root }) => {
    const ops = recordDurabilityOps(root);
    acquireCapacityLock(root, protocolOptions())();
    assert.deepEqual(ops, [
      "mkdir <stage>",
      "fsync <root>",
      "fsync <stage>/owner.json",
      "fsync <stage>",
      "rename <stage> -> <lock>",
      "fsync <root>",
      "rename <lock> -> <release>",
      "fsync <root>",
      "unlink <release>/owner.json",
      "fsync <release>",
      "rmdir <release>",
      "fsync <root>",
    ]);
    assertDurableOrder(ops, "acquire+release");
  });
});

test("T12 recovery fsyncs after the quarantine move, the candidate and quarantine removals and the marker retirement", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    const ops = recordDurabilityOps(root);
    acquireCapacityLock(root, protocolOptions())();
    const recovery = ops.slice(0, ops.indexOf("mkdir <stage>"));
    assert.deepEqual(recovery, [
      "fsync <candidate>",
      "link <candidate> -> <marker>",
      "unlink <candidate>",
      "fsync <root>",
      "rename <lock> -> <quarantine>",
      "fsync <root>",
      "unlink <quarantine>/owner.json",
      "fsync <quarantine>",
      "rmdir <quarantine>",
      "fsync <root>",
      "unlink <marker>",
      "fsync <root>",
    ]);
    assertDurableOrder(ops, "recovery");
  });
});

test("T12 the removal of a dead predecessor's repair marker is followed by an fsync of the root", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const predecessor = writeMarker(root, dead.owner.owner_token, 0, { pid: DEAD_PID });
    const ops = recordDurabilityOps(root);
    acquireCapacityLock(root, protocolOptions())();
    assert.equal(realFs.existsSync(path.join(root, predecessor.name)), false, "the dead predecessor marker is gone");
    const recovery = ops.slice(0, ops.indexOf("mkdir <stage>"));
    // The own marker is retired first, the dead predecessor's marker second; both are markers by role,
    // so the pair is told apart by position: the second marker unlink must be followed by the fsync.
    const unlinks = recovery.flatMap((op, index) => (op === "unlink <marker>" ? [index] : []));
    assert.equal(unlinks.length, 2, `the own marker and the dead predecessor marker are both removed (${recovery.join(" | ")})`);
    assert.equal(recovery[unlinks[1] + 1], "fsync <root>", `the predecessor marker removal must be followed at once by an fsync of the root (${recovery.join(" | ")})`);
    assert.equal(ops[unlinks[1] + 2], "mkdir <stage>", `nothing else changes the tree between that fsync and the next create (${ops.join(" | ")})`);
    assertDurableOrder(ops, "dead predecessor marker retirement");
  });
});

test("T12 the residue cleanup fsyncs the root after the removals it made", () => {
  withProtocolRoot(({ root }) => {
    const owner = deadResidueOwner();
    residueDirectory(root, residueName("stage", DEAD_PID), { owner });
    residueDirectory(root, residueName("release", DEAD_PID));
    residueDirectory(root, residueName("recovery", DEAD_PID), { owner });
    realFs.writeFileSync(path.join(root, residueName("repair-candidate", DEAD_PID)), "x");
    writeMarker(root, randomUUID(), 0, { pid: DEAD_PID });
    const ops = recordDurabilityOps(root);
    acquireCapacityLock(root, protocolOptions())();
    const removals = ops.filter((op) => /^(unlink|rmdir) /.test(op) && !op.includes("<release>/owner.json"));
    assert.ok(removals.length >= 8, `the cleanup must have removed all five residues (${ops.join(" | ")})`);
    assertDurableOrder(ops, "residue cleanup");
    assert.deepEqual(rootEntries(root), []);
  });
});

test("T12 a pending repair marker that the next acquisition retires is followed by an fsync of the root", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const injected = new Error("injected at repair-elected");
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError("EIO", "unlink");
      return real(target, ...rest);
    });
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    assert.deepEqual(markerNames(root), [markerName(dead.owner.owner_token, 0)]);
    restoreFs();
    const ops = recordDurabilityOps(root);
    acquireCapacityLock(root, protocolOptions())();
    assert.equal(ops[0], "unlink <marker>", "the pending marker is retired before anything else");
    assert.equal(ops[1], "fsync <root>", "the retirement is made durable at once");
    assertDurableOrder(ops, "pending marker");
  });
});

test("T12 a lost election removes its candidate and fsyncs the root; so does a failed recovery's final cleanup", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    hookFs("linkSync", (real) => (from, to) => {
      if (isMarkerPath(to)) throw fsError("EEXIST", "link");
      return real(from, to);
    });
    const ops = recordDurabilityOps(root);
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 60 })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.ok(ops.includes("unlink <candidate>"), "the loser removes its own candidate");
    assertDurableOrder(ops, "lost election");
  });
  withProtocolRoot(({ root }) => {
    deadLock(root);
    const injected = new Error("injected at repair-elected");
    const ops = recordDurabilityOps(root);
    assert.throws(() => acquireCapacityLock(root, protocolOptions({
      checkpoint: (point) => { if (point === "repair-elected") throw injected; },
    })), (error) => error === injected);
    assert.ok(ops.includes("unlink <candidate>"), "the final cleanup removes the candidate the failed recoverer still had");
    assertDurableOrder(ops, "failed recovery");
  });
});

test("T12 a staging directory removed by a publisher that lost is followed by fsyncs of the stage and the root", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const live = newOwner(process.ppid, new Date().toISOString());
    let injected = false;
    hookFs("renameSync", (real) => (from, to) => {
      if (to === lockPath && !injected) {
        injected = true;
        writeLock(lockPath, live);
      }
      return real(from, to);
    });
    const ops = recordDurabilityOps(root);
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 80 })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.deepEqual(ops.slice(-4), ["unlink <stage>/owner.json", "fsync <stage>", "rmdir <stage>", "fsync <root>"]);
    assertDurableOrder(ops, "lost publication");
  });
});


// ---- records for states that used to leave none (review round 1) ------------------

function unexpectedRecords(events, step) {
  return events.filter((event) => event.event === "unexpected-fs-error" && (step === undefined || event.step === step));
}

test("T13 a malformed highest repair marker blocks the election with one residue-preserved record naming the marker", () => {
  withProtocolRoot(({ root, lockPath }) => {
    const dead = deadLock(root);
    const name = markerName(dead.owner.owner_token, 0);
    const bytes = Buffer.from("not json\n");
    realFs.writeFileSync(path.join(root, name), bytes);
    const { events, onProtocolEvent } = eventCollector();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 200, onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    const preserved = events.filter((event) => event.event === "residue-preserved");
    assert.equal(preserved.length, 1, `one record per marker per acquisition: ${JSON.stringify(events)}`);
    assertEventShape(preserved[0], "residue-preserved");
    assert.deepEqual(preserved[0].detail, { item: name, reason: "repair-marker-malformed" });
    assert.equal(JSON.stringify(preserved[0]).includes(root), false, "the record carries the marker name, not a path");
    assert.deepEqual(realFs.readFileSync(path.join(root, name)), bytes, "fail closed: the marker stays");
    assert.deepEqual(realFs.readFileSync(path.join(lockPath, "owner.json")), dead.bytes);
    // A later acquisition is a new call and reports the same marker again.
    const second = eventCollector();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 100, onProtocolEvent: second.onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.equal(second.events.filter((event) => event.event === "residue-preserved").length, 1);
  });
});

test("T13 the residue cleanup preserves a malformed repair marker with a record and keeps it", () => {
  withProtocolRoot(({ root }) => {
    const name = markerName(randomUUID(), 0);
    const bytes = Buffer.from("garbled\n");
    realFs.writeFileSync(path.join(root, name), bytes);
    const events = sweepWith(root);
    assert.deepEqual(events.map((event) => event.event), ["residue-preserved"]);
    assertEventShape(events[0], "residue-preserved");
    assert.equal(events[0].step, "residue-sweep");
    assert.deepEqual(events[0].detail, { item: name, reason: "repair-marker-malformed" });
    assert.deepEqual(realFs.readFileSync(path.join(root, name)), bytes);
  });
});

// Each election step that keeps failing is reported once per acquisition and error code.
const ELECTION_FAULTS = {
  "election-list": {
    arrange: (root) => { deadLock(root); },
    install: (code, isRoot) => hookFs("readdirSync", (real) => (target, ...rest) => {
      if (rest.length === 0 && isRoot(target)) throw fsError(code(), "scandir");
      return real(target, ...rest);
    }),
  },
  "election-read": {
    arrange: (root) => { const dead = deadLock(root); writeMarker(root, dead.owner.owner_token, 0, { pid: DEAD_PID }); },
    install: (code) => hookFs("readFileSync", (real) => (target, ...rest) => {
      if (isMarkerPath(target)) throw fsError(code(), "open");
      return real(target, ...rest);
    }),
  },
  "election-candidate": {
    arrange: (root) => { deadLock(root); },
    install: (code) => hookFs("openSync", (real) => (target, ...rest) => {
      if (path.basename(String(target)).startsWith(".capacity-lock.repair-candidate.")) throw fsError(code(), "open");
      return real(target, ...rest);
    }),
  },
  "election-link": {
    arrange: (root) => { deadLock(root); },
    install: (code) => hookFs("linkSync", (real) => (from, to) => {
      if (isMarkerPath(to)) throw fsError(code(), "link");
      return real(from, to);
    }),
  },
};

for (const [step, fault] of Object.entries(ELECTION_FAULTS)) {
  test(`T13 ${step} failing on every poll writes one unexpected-fs-error per error code within an acquisition`, () => {
    withProtocolRoot(({ root, lockPath }) => {
      fault.arrange(root);
      let code = "EIO";
      fault.install(() => code, (target) => target === root);
      const first = eventCollector();
      assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 250, onProtocolEvent: first.onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
      assert.deepEqual(unexpectedRecords(first.events).map((event) => `${event.step}:${event.code}`), [`${step}:EIO`], JSON.stringify(first.events));
      // The dedup state belongs to the call: the next acquisition reports again, and a new code is a new record.
      code = "EACCES";
      const second = eventCollector();
      assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 150, onProtocolEvent: second.onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
      assert.deepEqual(unexpectedRecords(second.events).map((event) => `${event.step}:${event.code}`), [`${step}:EACCES`]);
      assert.ok(realFs.existsSync(lockPath), "fail closed: the dead lock is untouched");
    });
  });
}

test("T13 an acquisition whose error code changes mid-wait writes one record per distinct code", () => {
  withProtocolRoot(({ root }) => {
    deadLock(root);
    let calls = 0;
    hookFs("linkSync", (real) => (from, to) => {
      if (isMarkerPath(to)) {
        calls += 1;
        throw fsError(calls % 2 === 0 ? "EIO" : "EACCES", "link");
      }
      return real(from, to);
    });
    const { events, onProtocolEvent } = eventCollector();
    assert.throws(() => acquireCapacityLock(root, protocolOptions({ waitMs: 200, onProtocolEvent })), (error) => error.message === NEW_TIMEOUT_MESSAGE);
    assert.ok(calls > 4, "the election was retried many times");
    assert.deepEqual(unexpectedRecords(events).map((event) => event.code).sort(), ["EACCES", "EIO"]);
  });
});

test("T13 a marker-retire failure for a dead predecessor carries the dead lock and the marker name", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    const predecessor = writeMarker(root, dead.owner.owner_token, 0, { pid: DEAD_PID });
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      if (path.basename(String(target)) === predecessor.name) throw fsError("EIO", "unlink");
      return real(target, ...rest);
    });
    const { events, onProtocolEvent } = eventCollector();
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent }))();
    const retire = unexpectedRecords(events, "marker-retire");
    assert.equal(retire.length, 1, JSON.stringify(events));
    assert.equal(retire[0].code, "EIO");
    assertLockIdentity(retire[0].lock, dead.owner);
    assert.equal(retire[0].detail.marker, predecessor.name);
    assert.equal(JSON.stringify(retire[0]).includes(root), false);
  });
});

test("T13 a marker-retire failure while listing the predecessors carries the dead lock and the elected marker", () => {
  withProtocolRoot(({ root }) => {
    const dead = deadLock(root);
    let listings = 0;
    hookFs("readdirSync", (real) => (target, ...rest) => {
      if (rest.length === 0 && target === root) {
        listings += 1;
        if (listings === 2) throw fsError("EIO", "scandir");
      }
      return real(target, ...rest);
    });
    const { events, onProtocolEvent } = eventCollector();
    acquireCapacityLock(root, protocolOptions({ onProtocolEvent }))();
    const retire = unexpectedRecords(events, "marker-retire");
    assert.equal(retire.length, 1, JSON.stringify(events));
    assertLockIdentity(retire[0].lock, dead.owner);
    assert.equal(retire[0].detail.marker, markerName(dead.owner.owner_token, 0));
  });
});

test("T13 a residue-sweep failure after removals names the entries that were removed", () => {
  withProtocolRoot(({ root }) => {
    const name = residueName("repair-candidate", DEAD_PID);
    realFs.writeFileSync(path.join(root, name), "x");
    const fdTargets = new Map();
    let removed = false;
    let failed = false;
    hookFs("openSync", (real) => (target, ...rest) => {
      const fd = real(target, ...rest);
      fdTargets.set(fd, String(target));
      return fd;
    });
    hookFs("unlinkSync", (real) => (target, ...rest) => {
      const result = real(target, ...rest);
      if (path.basename(String(target)) === name) removed = true;
      return result;
    });
    hookFs("fsyncSync", (real) => (fd) => {
      if (removed && !failed && fdTargets.get(fd) === root) {
        failed = true;
        throw fsError("EIO", "fsync");
      }
      return real(fd);
    });
    const events = sweepWith(root);
    assert.ok(failed);
    const sweep = unexpectedRecords(events, "residue-sweep");
    assert.equal(sweep.length, 1, JSON.stringify(events));
    assert.equal(sweep[0].code, "EIO");
    assert.deepEqual(sweep[0].detail, { items: [name] });
  });
});
