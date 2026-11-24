// #3176: native Windows refuses to rename the lock directory while a contender
// holds owner.json open. The owner's release retries only that failure, inside
// a bound, re-proving ownership before every retry, and still fails closed.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireCapacityLock } from "../lib/control-evidence-capacity-lock.mjs";

function renameError(code) {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code, syscall: "rename" });
}

function withLock(options, body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "capacity-lock-release-"));
  const lockPath = path.join(root, ".capacity-lock");
  const calls = { count: 0 };
  try {
    const release = acquireCapacityLock(root, {
      ...options,
      releaseRename: (from, to) => {
        calls.count += 1;
        return options.releaseRename(calls.count, from, to);
      },
    });
    body({ root, lockPath, release, calls, ownerBytes: readFileSync(path.join(lockPath, "owner.json")) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("win32 release retries a rename EPERM and then releases the lock", () => {
  withLock({
    platform: "win32",
    releaseRename: (attempt, from, to) => {
      if (attempt <= 3) throw renameError("EPERM");
      renameSync(from, to);
    },
  }, ({ root, release, calls }) => {
    release();
    assert.equal(calls.count, 4);
    assert.deepEqual(readdirSync(root), []);
  });
});

test("win32 release fails closed with the EPERM once the retry budget is spent", () => {
  withLock({
    platform: "win32",
    releaseRenameRetryMs: 40,
    releaseRename: () => { throw renameError("EPERM"); },
  }, ({ root, lockPath, release, calls, ownerBytes }) => {
    assert.throws(release, (error) => error.code === "EPERM" && error.syscall === "rename");
    assert.ok(calls.count > 1, "the bounded retry must have retried");
    assert.deepEqual(readdirSync(root), [".capacity-lock"]);
    assert.deepEqual(readFileSync(path.join(lockPath, "owner.json")), ownerBytes);
  });
});

test("win32 release does not retry once the lock directory was replaced", () => {
  withLock({
    platform: "win32",
    releaseRename: (attempt, from) => {
      if (attempt > 1) assert.fail("must not rename a directory it no longer owns");
      // Same owner bytes in a different directory: only dev+ino can tell.
      const ownerBytes = readFileSync(path.join(from, "owner.json"));
      renameSync(from, `${from}.moved-away`);
      mkdirSync(from);
      writeFileSync(path.join(from, "owner.json"), ownerBytes);
      throw renameError("EPERM");
    },
  }, ({ lockPath, release, calls, ownerBytes }) => {
    assert.throws(release, /identity changed during release/);
    assert.equal(calls.count, 1);
    assert.deepEqual(readFileSync(path.join(lockPath, "owner.json")), ownerBytes);
  });
});

test("win32 release does not retry over a foreign owner", () => {
  withLock({
    platform: "win32",
    releaseRename: (attempt, from) => {
      if (attempt > 1) assert.fail("must not rename a lock another owner holds");
      const ownerPath = path.join(from, "owner.json");
      const foreign = { ...JSON.parse(readFileSync(ownerPath, "utf8")), owner_token: "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12) };
      writeFileSync(ownerPath, `${JSON.stringify(foreign)}\n`);
      throw renameError("EPERM");
    },
  }, ({ lockPath, release, calls }) => {
    assert.throws(release, /identity changed during release/);
    assert.equal(calls.count, 1);
    assert.ok(existsSync(path.join(lockPath, "owner.json")));
  });
});

test("win32 release does not retry over malformed owner evidence", () => {
  withLock({
    platform: "win32",
    releaseRename: (attempt, from) => {
      if (attempt > 1) assert.fail("must not rename a lock with malformed owner evidence");
      writeFileSync(path.join(from, "owner.json"), "not json\n");
      throw renameError("EPERM");
    },
  }, ({ lockPath, release, calls }) => {
    assert.throws(release, (error) => error.classification === "reviewer_dispatch_capacity_exceeded");
    assert.equal(calls.count, 1);
    assert.ok(existsSync(lockPath));
  });
});

test("a rename EPERM is not retried off win32", () => {
  withLock({
    platform: "linux",
    releaseRename: () => { throw renameError("EPERM"); },
  }, ({ release, calls }) => {
    assert.throws(release, (error) => error.code === "EPERM");
    assert.equal(calls.count, 1);
  });
});

test("win32 release does not retry other rename failures", () => {
  for (const code of ["EBUSY", "EACCES", "ENOENT"]) {
    withLock({
      platform: "win32",
      releaseRename: () => { throw renameError(code); },
    }, ({ release, calls }) => {
      assert.throws(release, (error) => error.code === code);
      assert.equal(calls.count, 1, code);
    });
  }
});
