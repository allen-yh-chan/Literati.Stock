"use strict";
/**
 * fixture-fsync-shim.cjs
 *
 * Test-only: replace the durability flush with a descriptor check.
 *
 * The review carriers publish every record through fsync, and on macOS Node's
 * fsync is F_FULLFSYNC: it waits for the physical device and serialises every
 * process on the machine behind it. Measured per renderer child: 171 ms of a
 * 366 ms run. A fixture that is deleted when its test ends has no power-loss
 * window to protect, so the flush buys the suite nothing and costs it most of
 * its wall time under file-level concurrency.
 *
 * What stays: the call still happens, still receives the descriptor, and still
 * throws EBADF for a closed or invalid one (fstat). What goes: the device
 * flush, and with it any fault only a real flush could raise. Durability-fault
 * tests inject through `fsOps`; they never depended on a real flush failing.
 *
 * Importing this file patches the current process and, through NODE_OPTIONS,
 * every Node descendant that inherits the environment (the CLI children these
 * suites spawn). A child whose NODE_OPTIONS a test replaces runs the real
 * flush. Production code only calls fsyncSync; the other entry points are
 * covered so a future caller is not silently left on the slow path, and
 * FileHandle#sync is not patched because nothing here uses it.
 *
 * Active on macOS only, where the flush is the expensive kind; elsewhere this
 * file changes nothing, so a run on another platform still makes the real call. Set
 * DEVPRO_TEST_FIXTURE_FSYNC=real to run every flush for real on macOS too.
 * run-test-suite.mjs preloads this file for the whole suite; the review
 * carrier test files also import it so a direct `node --test` run matches.
 */
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const MARK = Symbol.for("devpro.test.fixture-fsync-shim");

if (process.platform === "darwin" && process.env.DEVPRO_TEST_FIXTURE_FSYNC !== "real" && !fs[MARK]) {
  const checkDescriptorSync = (fd) => {
    fs.fstatSync(fd);
  };
  const checkDescriptor = (fd, done) => {
    let failure = null;
    try {
      checkDescriptorSync(fd);
    } catch (error) {
      failure = error;
    }
    process.nextTick(done, failure);
  };
  fs.fsyncSync = checkDescriptorSync;
  fs.fdatasyncSync = checkDescriptorSync;
  fs.fsync = checkDescriptor;
  fs.fdatasync = checkDescriptor;
  Object.defineProperty(fs, MARK, { value: true });
  syncBuiltinESMExports();

  const preload = `--require ${JSON.stringify(__filename)}`;
  const inherited = process.env.NODE_OPTIONS ?? "";
  if (!inherited.includes(preload)) {
    process.env.NODE_OPTIONS = inherited === "" ? preload : `${inherited} ${preload}`;
  }
}
