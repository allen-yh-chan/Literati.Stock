// #3176 native witness: a second process really holds owner.json open, which is
// what makes native Windows refuse the release rename. Other platforms allow
// that rename, so there is nothing to witness there and the tests skip.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireCapacityLock } from "../lib/control-evidence-capacity-lock.mjs";

const skip = process.platform === "win32" ? false : "native Windows sharing semantics only";
const HOLDER = [
  "const fs = require('node:fs');",
  "const fd = fs.openSync(process.argv[1], 'r');",
  "process.stdout.write('READY');",
  "setTimeout(() => fs.closeSync(fd), Number(process.argv[2]));",
].join("");

async function holdOwnerFile(lockPath, holdMs) {
  const child = spawn(process.execPath, ["-e", HOLDER, path.join(lockPath, "owner.json"), String(holdMs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  // Wrapped: an async function returning the bare promise would await the exit.
  return { exited };
}

async function withHeldLock(holdMs, options, body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "capacity-lock-native-"));
  try {
    const release = acquireCapacityLock(root, options);
    const { exited: holderExited } = await holdOwnerFile(path.join(root, ".capacity-lock"), holdMs);
    await body({ root, release, holderExited });
    await holderExited;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("release outlasts a contender that briefly holds owner.json open", { skip }, async () => {
  await withHeldLock(300, {}, ({ root, release }) => {
    release();
    assert.deepEqual(readdirSync(root), []);
  });
});

test("release fails closed while owner.json stays open past the retry budget", { skip }, async () => {
  await withHeldLock(1500, { releaseRenameRetryMs: 100 }, async ({ root, release, holderExited }) => {
    assert.throws(release, (error) => error.code === "EPERM" && error.syscall === "rename");
    assert.deepEqual(readdirSync(root), [".capacity-lock"]);
    // The failed release left the lock owned and intact: it still releases.
    await holderExited;
    release();
    assert.deepEqual(readdirSync(root), []);
  });
});
