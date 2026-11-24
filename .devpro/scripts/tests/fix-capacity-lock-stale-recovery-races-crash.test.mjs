// Integration tests for the capacity-lock stale recovery (design D11, D12): real child processes,
// crash injection at every protocol checkpoint, deterministic barrier orderings, failures in a
// process that stays alive, and a multi-process smoke. No sleep is used as a synchronizer: every
// ordering is a barrier line from a child, and every end is a process exit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPACITY_LOCK_PROTOCOL_CHECKPOINTS } from "../lib/control-evidence-capacity-lock.mjs";
import {
  CRASH_EXIT_CODE,
  ageLock,
  cloneRoot,
  createDeadLock,
  listLockEntries,
  removeTree,
  runRound,
  scrubHostPaths,
  spawnContender,
  witnessLogViolations,
} from "./lib/capacity-lock-contender.mjs";

const TIMEOUT = { timeout: 90_000 };
const TIMEOUT_MESSAGE = "dispatch capacity gate is unavailable; reservation failed closed";
const tempDirs = [];
const liveContenders = [];
let template;

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `capacity-lock-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function launch(config) {
  const contender = spawnContender(config);
  liveContenders.push(contender);
  return contender;
}

function freshDeadRoot() {
  const root = path.join(tempDir("crash"), "root");
  return cloneRoot(template.root, root);
}

function emptyRoot() {
  const root = path.join(tempDir("crash"), "root");
  mkdirSync(root);
  return root;
}

before(async () => {
  const root = path.join(tempDir("template"), "root");
  template = { root, ...(await createDeadLock(root)) };
});

afterEach(async () => {
  for (const contender of liveContenders.splice(0)) {
    contender.kill();
    await contender.closed.catch(() => null);
  }
});

after(() => {
  for (const dir of tempDirs) removeTree(dir);
});

// ---------------------------------------------------------------------------
// Disk inspection
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Everything the protocol can leave next to the lock, classified by entry name.
function survey(root) {
  const found = { lock: null, stages: [], candidates: [], markers: [], quarantines: [], releases: [], other: [] };
  for (const name of listLockEntries(root)) {
    const full = path.join(root, name);
    if (name === ".capacity-lock") {
      found.lock = { ino: lstatSync(full).ino, owner: readJson(path.join(full, "owner.json")), entries: readdirSync(full) };
    } else if (name.startsWith(".capacity-lock.stage.")) {
      found.stages.push({ name, entries: readdirSync(full) });
    } else if (name.startsWith(".capacity-lock.repair-candidate.")) {
      found.candidates.push({ name });
    } else if (name.startsWith(".capacity-lock.repair.")) {
      found.markers.push({ name, generation: Number(name.split(".").at(-1)), record: readJson(full) });
    } else if (name.startsWith(".capacity-lock.recovery.")) {
      found.quarantines.push({ name, entries: readdirSync(full) });
    } else if (name.startsWith(".capacity-lock.release.")) {
      found.releases.push({ name, entries: readdirSync(full) });
    } else {
      found.other.push(name);
    }
  }
  found.markers.sort((left, right) => left.generation - right.generation);
  return found;
}

function lockBytes(root) {
  return readFileSync(path.join(root, ".capacity-lock", "owner.json"));
}

function lockIno(root) {
  return lstatSync(path.join(root, ".capacity-lock")).ino;
}

function countEvents(events, name) {
  return events.filter((event) => event.event === name).length;
}

function assertNoUnexpectedEvents(events, label) {
  const bad = events.filter((event) => event.event === "unexpected-fs-error" || event.event === "residue-preserved");
  assert.deepEqual(bad, [], `${label}: unexpected protocol records`);
}

// A later contender with the default wait bound. The lock must be acquired and released and the
// root must end with no capacity-lock entry at all.
async function assertFollowUpAcquires(root, label) {
  const follower = launch({ root });
  const result = await follower.closed;
  assert.equal(result.code, 0, `${label}: follow-up contender failed: ${JSON.stringify(result.failure)} ${result.stderr}`);
  assertNoUnexpectedEvents(result.events, label);
  assert.deepEqual(listLockEntries(root), [], `${label}: root must end clean`);
  return result;
}

// Contenders started together after a crash, with the overlap witness (design D11): every one of them
// must acquire and release, no two may hold the lock at once, and nothing of the protocol may remain.
// This is the state a crash leaves behind being taken over by several processes, not by one.
const FOLLOW_UP_CONTENDERS = 2;

async function assertFollowUpsAcquireTogether(root, label) {
  const witness = { dir: tempDir("witness") };
  const followers = Array.from({ length: FOLLOW_UP_CONTENDERS }, () => launch({ root, startGate: true, witness }));
  await Promise.all(followers.map((follower) => follower.waitFor("READY")));
  followers.forEach((follower) => follower.send());
  const results = await Promise.all(followers.map((follower) => follower.closed));
  results.forEach((result, index) => {
    assert.equal(result.code, 0, `${label}: follow-up contender ${index} exited ${result.code} (3 means it saw another holder inside): ${JSON.stringify(result.failure)} ${result.stderr}`);
    assert.ok(result.lines.includes("ACQUIRED"), `${label}: follow-up contender ${index} never acquired`);
  });
  const events = results.flatMap((result) => result.events);
  assertNoUnexpectedEvents(events, label);
  const logFile = path.join(witness.dir, "enter-exit.log");
  assert.deepEqual(witnessLogViolations(logFile), [], `${label}: holding intervals overlapped`);
  const entered = readFileSync(logFile, "utf8").split("\n").filter((line) => line.startsWith("enter ")).length;
  assert.equal(entered, FOLLOW_UP_CONTENDERS, `${label}: every follow-up contender must have held the lock`);
  assert.deepEqual(listLockEntries(root), [], `${label}: root must end clean`);
  return { events };
}

// ---------------------------------------------------------------------------
// Crash injection: every checkpoint, in protocol order
// ---------------------------------------------------------------------------

function withReleaseResidue(root) {
  // A release directory whose creator is dead and whose owner is a valid, dead owner.
  const name = `.capacity-lock.release.${template.deadPid}.${randomUUID()}`;
  mkdirSync(path.join(root, name));
  const owner = {
    schema: "devpro-second-review-capacity-lock/v1",
    owner_pid: template.deadPid,
    owner_token: randomUUID(),
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
  };
  writeFileSync(path.join(root, name, "owner.json"), `${JSON.stringify(owner)}\n`);
  return name;
}

// Per checkpoint: how to build the root, the on-disk state a crash there leaves (design "當機復原表"),
// and how many repair-target-verified records the follow-up writes (a takeover repeats the record
// only while the dead lock is still on the lock path).
const CRASH_CASES = {
  "stage-created": {
    root: emptyRoot,
    check: ({ found }) => {
      assert.equal(found.lock, null);
      assert.equal(found.stages.length, 1);
      assert.deepEqual(found.stages[0].entries, []);
    },
    followUpVerified: 0,
  },
  "stage-owner-written": {
    root: emptyRoot,
    check: ({ found }) => {
      assert.equal(found.lock, null, "the lock path must never show a half-built lock");
      assert.deepEqual(found.stages.map((stage) => stage.entries), [["owner.json"]]);
    },
    followUpVerified: 0,
  },
  "lock-published": {
    root: emptyRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock.owner.owner_pid, crashPid);
      assert.deepEqual(found.lock.entries, ["owner.json"]);
    },
    ageAfterCrash: true,
    followUpVerified: 1,
  },
  "sweep-owner-removed": {
    root: () => {
      const root = emptyRoot();
      withReleaseResidue(root);
      return root;
    },
    check: ({ found, crashPid, crash }) => {
      assert.equal(found.lock.owner.owner_pid, crashPid);
      assert.equal(found.releases.length, 1);
      assert.deepEqual(found.releases[0].entries, []);
      assert.equal(countEvents(crash.events, "residue-owner-removing"), 1, "the owner removal must be recorded first");
    },
    ageAfterCrash: true,
    followUpVerified: 1,
  },
  "repair-candidate-written": {
    root: freshDeadRoot,
    check: ({ found }) => {
      assert.equal(found.lock.owner.owner_token, template.ownerToken);
      assert.equal(found.candidates.length, 1);
      assert.equal(found.markers.length, 0);
    },
    followUpVerified: 1,
  },
  "repair-elected": {
    root: freshDeadRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock.owner.owner_token, template.ownerToken);
      assert.deepEqual(found.markers.map((marker) => [marker.generation, marker.record.repair_pid]), [[0, crashPid]]);
      assert.equal(found.candidates.length, 1);
    },
    followUpVerified: 1,
  },
  "repair-candidate-removed": {
    root: freshDeadRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock.owner.owner_token, template.ownerToken);
      assert.deepEqual(found.markers.map((marker) => [marker.generation, marker.record.repair_pid]), [[0, crashPid]]);
      assert.equal(found.candidates.length, 0);
    },
    followUpVerified: 1,
  },
  "repair-target-verified": {
    root: freshDeadRoot,
    check: ({ found, crashPid, crash }) => {
      assert.equal(found.lock.owner.owner_token, template.ownerToken);
      assert.deepEqual(found.markers.map((marker) => marker.record.repair_pid), [crashPid]);
      assert.equal(countEvents(crash.events, "repair-target-verified"), 1);
    },
    followUpVerified: 1,
  },
  "repair-quarantined": {
    root: freshDeadRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock, null);
      assert.deepEqual(found.quarantines.map((q) => q.entries), [["owner.json"]]);
      assert.deepEqual(found.markers.map((marker) => marker.record.repair_pid), [crashPid]);
    },
    followUpVerified: 0,
  },
  "repair-quarantine-verified": {
    root: freshDeadRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock, null);
      assert.deepEqual(found.quarantines.map((q) => q.entries), [["owner.json"]]);
      assert.deepEqual(found.markers.map((marker) => marker.record.repair_pid), [crashPid]);
    },
    followUpVerified: 0,
  },
  "repair-owner-removed": {
    root: freshDeadRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock, null);
      assert.deepEqual(found.quarantines.map((q) => q.entries), [[]]);
      assert.deepEqual(found.markers.map((marker) => marker.record.repair_pid), [crashPid]);
    },
    followUpVerified: 0,
  },
  "repair-quarantine-removed": {
    root: freshDeadRoot,
    check: ({ found, crashPid }) => {
      assert.equal(found.lock, null);
      assert.equal(found.quarantines.length, 0);
      assert.deepEqual(found.markers.map((marker) => marker.record.repair_pid), [crashPid]);
    },
    followUpVerified: 0,
  },
  "repair-markers-retired": {
    root: freshDeadRoot,
    check: ({ found }) => {
      assert.deepEqual(found, { lock: null, stages: [], candidates: [], markers: [], quarantines: [], releases: [], other: [] });
    },
    followUpVerified: 0,
  },
};

test("the crash cases cover exactly the exported protocol checkpoints, in order", () => {
  assert.equal(CAPACITY_LOCK_PROTOCOL_CHECKPOINTS.length, 13);
  assert.deepEqual(Object.keys(CRASH_CASES), [...CAPACITY_LOCK_PROTOCOL_CHECKPOINTS]);
});

for (const checkpointName of CAPACITY_LOCK_PROTOCOL_CHECKPOINTS) {
  test(`crash at ${checkpointName}: exit 77, disk state as designed, later contenders started together all acquire with no overlap`, TIMEOUT, async () => {
    const spec = CRASH_CASES[checkpointName];
    assert.ok(spec, `no crash case for checkpoint ${checkpointName}`);
    const root = spec.root();
    const crasher = launch({ root, crashAt: checkpointName });
    const crash = await crasher.closed;
    assert.equal(crash.code, CRASH_EXIT_CODE, `${checkpointName} was not reached (exit ${crash.code}): ${crash.stderr} ${JSON.stringify(crash.lines)}`);
    spec.check({ found: survey(root), crashPid: crasher.pid, crash });
    if (spec.ageAfterCrash) ageLock(root);
    const followUp = await assertFollowUpsAcquireTogether(root, checkpointName);
    assert.equal(
      countEvents(followUp.events, "repair-target-verified"),
      spec.followUpVerified,
      `${checkpointName}: follow-up repair-target-verified records (all follow-up contenders together)`,
    );
  });
}

// ---------------------------------------------------------------------------
// Release: crash points and the D12 failure
// ---------------------------------------------------------------------------

test("crash right after the release rename: the isolated directory is cleaned by the next acquirer", TIMEOUT, async () => {
  const root = emptyRoot();
  const crasher = launch({ root, crashAfterReleaseRename: true });
  const crash = await crasher.closed;
  assert.equal(crash.code, CRASH_EXIT_CODE, crash.stderr);
  const found = survey(root);
  assert.equal(found.lock, null);
  assert.deepEqual(found.releases.map((release) => release.entries), [["owner.json"]]);
  await assertFollowUpAcquires(root, "release-after-rename");
});

test("crash right after the release removed the owner record: the empty directory is cleaned, not restored", TIMEOUT, async () => {
  const root = emptyRoot();
  const crasher = launch({ root, crashAfterReleaseOwnerUnlink: true });
  const crash = await crasher.closed;
  assert.equal(crash.code, CRASH_EXIT_CODE, crash.stderr);
  const found = survey(root);
  assert.equal(found.lock, null);
  assert.deepEqual(found.releases.map((release) => release.entries), [[]]);
  await assertFollowUpAcquires(root, "release-after-owner-removed");
});

test("release that fails after its owner record was removed surfaces the failure and does not restore the lock path", TIMEOUT, async () => {
  const root = emptyRoot();
  const releaser = launch({ root, failReleaseRmdir: "EBUSY", expectReleaseFailure: true });
  const result = await releaser.closed;
  assert.equal(result.code, 0, result.stderr);
  const failed = result.lines.find((line) => line.startsWith("RELEASE-FAILED "));
  assert.ok(failed, `release must fail: ${JSON.stringify(result.lines)}`);
  assert.equal(JSON.parse(failed.slice("RELEASE-FAILED ".length)).code, "EBUSY");
  const found = survey(root);
  assert.equal(found.lock, null, "an owner-less directory must not return to the lock path");
  assert.deepEqual(found.releases.map((release) => release.entries), [[]]);
  assert.ok(
    result.events.some((event) => event.event === "unexpected-fs-error" && event.step === "release-cleanup"),
    "the failed release must leave a correlatable record",
  );
  await assertFollowUpAcquires(root, "release-failure");
});

// ---------------------------------------------------------------------------
// Deterministic orderings (barriers)
// ---------------------------------------------------------------------------

test("two recoverers started together: exactly one records the dead owner and both acquire", TIMEOUT, async () => {
  const root = freshDeadRoot();
  const witness = { dir: tempDir("witness") };
  const config = { root, startGate: true, witness, pauseAt: ["repair-candidate-written"] };
  const first = launch(config);
  const second = launch(config);
  await Promise.all([first.waitFor("READY"), second.waitFor("READY")]);
  first.send();
  second.send();
  await Promise.all([first.waitFor("BARRIER repair-candidate-written"), second.waitFor("BARRIER repair-candidate-written")]);
  first.send();
  second.send();
  const results = await Promise.all([first.closed, second.closed]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
  const events = results.flatMap((result) => result.events);
  assert.equal(countEvents(events, "repair-target-verified"), 1);
  assertNoUnexpectedEvents(events, "two recoverers");
  assert.deepEqual(listLockEntries(root), []);
});

test("a losing contender never touches the lock while the elected recoverer is held back", TIMEOUT, async () => {
  const root = freshDeadRoot();
  const winner = launch({ root, pauseAt: ["repair-elected"] });
  await winner.waitFor("BARRIER repair-elected");
  const inoBefore = lockIno(root);
  const bytesBefore = lockBytes(root);
  // Every lost election of the loser reads the winner's liveness once: that is its poll counter.
  const loser = launch({ root, reportKillOf: [winner.pid] });
  await loser.waitFor(`KILL-CHECK ${winner.pid}`, { count: 3 });
  assert.equal(lockIno(root), inoBefore);
  assert.deepEqual(lockBytes(root), bytesBefore);
  const found = survey(root);
  assert.deepEqual(found.markers.map((marker) => marker.record.repair_pid), [winner.pid]);
  assert.deepEqual(
    [found.stages.length, found.quarantines.length, found.releases.length, found.other.length],
    [0, 0, 0, 0],
    "the loser must leave nothing of its own",
  );
  assert.equal(found.candidates.length, 1, "only the winner's candidate may exist");
  winner.send();
  const results = await Promise.all([winner.closed, loser.closed]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
  assert.equal(countEvents(results.flatMap((result) => result.events), "repair-target-verified"), 1);
  assert.deepEqual(listLockEntries(root), []);
});

test("a recoverer that crashed after its election is taken over with generation 1", TIMEOUT, async () => {
  const root = freshDeadRoot();
  const crasher = launch({ root, crashAt: "repair-elected" });
  const crash = await crasher.closed;
  assert.equal(crash.code, CRASH_EXIT_CODE, crash.stderr);
  const successor = launch({ root, pauseAt: ["repair-candidate-removed"] });
  await successor.waitFor("BARRIER repair-candidate-removed");
  const found = survey(root);
  assert.deepEqual(
    found.markers.map((marker) => [marker.generation, marker.record.repair_pid]),
    [[0, crasher.pid], [1, successor.pid]],
  );
  successor.send();
  const result = await successor.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(countEvents(result.events, "repair-target-verified"), 1);
  assert.deepEqual(listLockEntries(root), []);
});

// The elected recoverer fails after the election but its process stays alive (parked).
async function launchFailedRecoverer(root, extra = {}) {
  const failed = launch({ root, throwAt: "repair-elected", parkOnFailure: true, ...extra });
  await failed.waitFor("PARKED");
  const message = JSON.parse((await failed.waitFor("FAILED"))[0].slice("FAILED ".length)).message;
  assert.equal(message, "injected failure at repair-elected");
  return failed;
}

test("a recoverer that failed after its election and stays alive withdraws its marker; another contender recovers within its bound", TIMEOUT, async () => {
  const root = freshDeadRoot();
  const inoBefore = lockIno(root);
  const bytesBefore = lockBytes(root);
  const failed = await launchFailedRecoverer(root);
  const found = survey(root);
  assert.deepEqual(found.markers, [], "the failed recoverer must withdraw its marker");
  assert.equal(found.candidates.length, 0);
  assert.equal(lockIno(root), inoBefore);
  assert.deepEqual(lockBytes(root), bytesBefore);
  const other = launch({ root, pauseAt: ["repair-candidate-removed"] });
  await other.waitFor("BARRIER repair-candidate-removed");
  assert.deepEqual(survey(root).markers.map((marker) => [marker.generation, marker.record.repair_pid]), [[0, other.pid]]);
  other.send();
  const result = await other.closed;
  assert.equal(result.code, 0, `default wait bound must be enough: ${result.stderr}`);
  assert.equal(countEvents(result.events, "repair-target-verified"), 1);
  failed.send();
  const failedResult = await failed.closed;
  assert.equal(failedResult.code, 1);
  assert.deepEqual(failedResult.events, [], "a withdrawn marker needs no record");
  assert.deepEqual(listLockEntries(root), []);
});

test("a marker that cannot be removed: one record, other contenders fail closed, a later contender takes over with generation 1", TIMEOUT, async () => {
  const root = freshDeadRoot();
  const inoBefore = lockIno(root);
  const bytesBefore = lockBytes(root);
  const failed = await launchFailedRecoverer(root, { failMarkerUnlink: "EPERM" });
  const found = survey(root);
  assert.equal(found.markers.length, 1, "the marker must still be there");
  const markerName = found.markers[0].name;
  const markerBytes = readFileSync(path.join(root, markerName));
  assert.equal(found.markers[0].record.repair_pid, failed.pid);
  assert.equal(lockIno(root), inoBefore);
  assert.deepEqual(lockBytes(root), bytesBefore);

  const blocked = launch({ root, waitMs: 300 });
  const blockedResult = await blocked.closed;
  assert.equal(blockedResult.code, 1);
  assert.equal(blockedResult.failure.message, TIMEOUT_MESSAGE);
  assert.equal(blockedResult.failure.classification, "reviewer_dispatch_capacity_exceeded");
  assert.deepEqual(blockedResult.events, []);
  assert.equal(lockIno(root), inoBefore);
  assert.deepEqual(lockBytes(root), bytesBefore);
  assert.deepEqual(readFileSync(path.join(root, markerName)), markerBytes);
  assert.deepEqual(listLockEntries(root), [".capacity-lock", markerName], "the blocked contender must leave nothing");

  failed.send();
  const failedResult = await failed.closed;
  assert.equal(failedResult.code, 1);
  const retireFailed = failedResult.events.filter((event) => event.event === "repair-marker-retire-failed");
  assert.equal(retireFailed.length, 1, JSON.stringify(failedResult.events));
  assert.ok(retireFailed[0].detail.attempts > 1, `attempts=${retireFailed[0].detail.attempts}`);
  assert.equal(retireFailed[0].detail.marker, markerName);
  assert.ok(retireFailed[0].detail.pending.includes(markerName));

  const successor = launch({ root, pauseAt: ["repair-candidate-removed"] });
  await successor.waitFor("BARRIER repair-candidate-removed");
  assert.deepEqual(
    survey(root).markers.map((marker) => [marker.generation, marker.record.repair_pid]),
    [[0, failed.pid], [1, successor.pid]],
  );
  successor.send();
  const successorResult = await successor.closed;
  assert.equal(successorResult.code, 0, successorResult.stderr);
  assert.equal(countEvents(successorResult.events, "repair-target-verified"), 1);
  assert.deepEqual(listLockEntries(root), []);
});

// ---------------------------------------------------------------------------
// Stress tool output
// ---------------------------------------------------------------------------

test("a stress round that fails keeps its directory by relative name and writes no host path", TIMEOUT, async () => {
  const parentDir = tempDir("kept");
  // A 1 ms round timeout kills the contenders at their start gate: a deterministic failed round.
  const result = await runRound({ contenders: 2, parentDir, waitMs: 5000, roundTimeoutMs: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.round_dir, "a failed round keeps its directory");
  assert.equal(path.isAbsolute(result.round_dir), false);
  assert.equal(path.basename(result.round_dir), result.round_dir, "relative to the parent directory, one segment");
  assert.ok(lstatSync(path.join(parentDir, result.round_dir)).isDirectory(), "the kept directory exists under the parent directory");
  const written = JSON.stringify(result);
  assert.ok(written.length > 0);
  // The written form is JSON, where every backslash of a Windows path is doubled: look for the path in
  // its plain form and in its JSON-escaped forms, so the check also holds on Windows. Two rounds of
  // stringify put three characters that are not part of the path on each side (quote, backslash, quote).
  const escapedForms = (hostPath) => [hostPath, JSON.stringify(hostPath).slice(1, -1), JSON.stringify(JSON.stringify(hostPath)).slice(3, -3)];
  for (const hostPath of [parentDir, realpathSync(parentDir), os.tmpdir()]) {
    for (const form of escapedForms(hostPath)) {
      assert.equal(written.includes(form), false, `the round result must not contain ${hostPath === parentDir ? "the parent directory" : "a host path"}`);
    }
  }
  assert.doesNotMatch(written, /\/(?:var\/folders|Users|private|tmp|home)\//);
});

test("scrubHostPaths replaces the round directory, its parent, the temp directory and the repository root", () => {
  const parentDir = tempDir("scrub");
  const roundDir = path.join(parentDir, "capacity-lock-stress-abc");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const text = `ENOENT: no such file or directory, open '${path.join(roundDir, "root", "x")}' at file://${path.join(parentDir, "y")} in ${os.tmpdir()}; ${path.join(repoRoot, "z")}`;
  const scrubbed = scrubHostPaths(text, { roundDir, parentDir });
  assert.match(scrubbed, /; <repo>.z$/);
  assert.match(scrubbed, /'<round>.root.x'/);
  assert.match(scrubbed, /file:\/\/<parent>.y in <tmp>; /);
  assert.equal(scrubbed.includes(os.tmpdir()), false);
});

// A Windows path cannot be made on this platform, so the scrubbing of one is checked at string level:
// the helper is handed Windows-form directories, and the text is the shapes a log really carries. An
// error message holds the path as is; the contender's "FAILED <json>" stdout line holds it after one
// JSON.stringify (each backslash doubled); the start-gate failure text wraps that line in another
// JSON.stringify (each backslash four times).
test("scrubHostPaths removes a Windows path from a message, a FAILED json line and a start-gate text", () => {
  const parentDir = "C:\\Users\\someone\\AppData\\Local\\Temp";
  const roundDir = `${parentDir}\\capacity-lock-stress-AbC`;
  const repoRoot = "D:\\work\\someone-repo";
  const options = { roundDir, parentDir, tmpDir: parentDir, repoRoot };
  const message = `EPERM: operation not permitted, rename '${roundDir}\\root\\.capacity-lock.stage.1' -> '${roundDir}\\root\\.capacity-lock' via ${repoRoot}\\.devpro\\scripts and ${parentDir}`;
  const failedLine = `FAILED ${JSON.stringify({ message, code: "EPERM" })}`;
  const releaseLine = `RELEASE-FAILED ${JSON.stringify({ message })}`;
  const gateText = JSON.stringify({ error: `contender 1 failed at the start gate: ${failedLine}` });
  const thirdLevel = JSON.stringify({ details: [gateText] });
  for (const [label, text] of [["message", message], ["FAILED line", failedLine], ["RELEASE-FAILED line", releaseLine], ["start-gate text", gateText], ["three levels", thirdLevel]]) {
    const scrubbed = scrubHostPaths(text, options);
    assert.doesNotMatch(scrubbed, /someone/i, `${label}: the account name must not survive: ${scrubbed}`);
    assert.doesNotMatch(scrubbed, /Users/, `${label}: the user directory must not survive: ${scrubbed}`);
    assert.doesNotMatch(scrubbed, /AppData|work/, `${label}: no part of a host path may survive: ${scrubbed}`);
    assert.match(scrubbed, /<round>/, `${label}: the round directory is named by its placeholder`);
  }
  assert.match(scrubHostPaths(failedLine, options), /<repo>.{1,8}\.devpro/);
});

test("scrubHostPaths matches a Windows path whatever the case of the drive letter and directory names", () => {
  const parentDir = "C:\\Users\\someone\\AppData\\Local\\Temp";
  const roundDir = `${parentDir}\\capacity-lock-stress-AbC`;
  const lower = `ENOENT: no such file or directory, open 'c:\\users\\someone\\appdata\\local\\temp\\capacity-lock-stress-abc\\root\\x'`;
  for (const text of [lower, `FAILED ${JSON.stringify({ message: lower })}`, lower.replaceAll("\\", "/")]) {
    const scrubbed = scrubHostPaths(text, { roundDir, parentDir, tmpDir: parentDir, repoRoot: "D:\\repo" });
    assert.doesNotMatch(scrubbed, /someone|users/i, scrubbed);
    assert.match(scrubbed, /<round>/);
  }
});

test("scrubHostPaths leaves text without a host path unchanged and does not treat a path as a pattern", () => {
  const parentDir = "/tmp/a.b+c(d)";
  const roundDir = `${parentDir}/round`;
  const options = { roundDir, parentDir, tmpDir: "/nonexistent-tmp", repoRoot: "/nonexistent-repo" };
  assert.equal(scrubHostPaths("EEXIST: file already exists", options), "EEXIST: file already exists");
  assert.equal(scrubHostPaths("open '/tmp/aXb+c(d)/round/x'", options), "open '/tmp/aXb+c(d)/round/x'");
  assert.equal(scrubHostPaths("open '/tmp/a.b+c(d)/round/x'", options), "open '<round>/x'");
});

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

test("smoke: 4 contenders over 20 rounds of a real dead lock, no overlap and no residue", { timeout: 300_000 }, async () => {
  const parentDir = tempDir("smoke");
  for (let round = 1; round <= 20; round += 1) {
    const result = await runRound({ contenders: 4, parentDir, waitMs: 60_000 });
    assert.deepEqual(result.failures, [], `round ${round}`);
  }
});
