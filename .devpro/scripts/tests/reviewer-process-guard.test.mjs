import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  MAX_REVIEWER_OUTPUT_LINE_BYTES,
  createBoundedLineAccumulator,
  processGroupGone,
  spawnSyncBounded,
  supportsProcessGroups,
  sweepProcessGroup,
  terminateProcessTree,
} from "../lib/reviewer-process-guard.mjs";

const POSIX = process.platform !== "win32";

function collect(maxBytes) {
  const lines = [];
  const overflows = [];
  const accumulator = createBoundedLineAccumulator({
    onLine: (line) => lines.push(line),
    onOverflow: (detail) => overflows.push(detail),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { accumulator, lines, overflows };
}

test("line accumulator: the default bound is 64 KiB and a line of exactly that size is accepted", () => {
  assert.equal(MAX_REVIEWER_OUTPUT_LINE_BYTES, 65536);
  const { accumulator, lines, overflows } = collect();
  accumulator.write(Buffer.from("a".repeat(65536) + "\n"));
  assert.deepEqual(overflows, []);
  assert.equal(lines.length, 1);
  assert.equal(Buffer.byteLength(lines[0]), 65536);
});

test("line accumulator: one byte more overflows, and nothing is emitted afterwards", () => {
  const { accumulator, lines, overflows } = collect();
  accumulator.write(Buffer.from("a".repeat(65537) + "\nlater\n"));
  assert.deepEqual(overflows, [{ maxBytes: 65536 }]);
  assert.deepEqual(lines, []);
  accumulator.write(Buffer.from("more\n"));
  accumulator.end();
  assert.deepEqual(lines, [], "the latch is permanent");
  assert.equal(overflows.length, 1, "overflow is reported once");
});

test("line accumulator: a newline-free stream overflows across chunks instead of growing without bound", () => {
  const { accumulator, overflows } = collect(1000);
  for (let index = 0; index < 100; index += 1) accumulator.write(Buffer.alloc(100, 0x7a));
  assert.deepEqual(overflows, [{ maxBytes: 1000 }]);
});

test("line accumulator: the bound counts bytes, not characters, and a character split across chunks survives", () => {
  const { accumulator, lines, overflows } = collect(6);
  const text = Buffer.from("審查\n", "utf8"); // 3 + 3 bytes
  accumulator.write(text.subarray(0, 4));
  accumulator.write(text.subarray(4));
  assert.deepEqual(lines, ["審查"]);
  assert.deepEqual(overflows, []);
  const tooWide = collect(5);
  tooWide.accumulator.write(Buffer.from("審查\n", "utf8"));
  assert.equal(tooWide.overflows.length, 1, "two 3-byte characters exceed a 5-byte bound");
});

test("line accumulator: an unterminated last line is emitted by end(), an empty line is kept", () => {
  const { accumulator, lines } = collect();
  accumulator.write(Buffer.from("one\n\ntail"));
  accumulator.end();
  assert.deepEqual(lines, ["one", "", "tail"]);
});

test("process group support: everything but win32", () => {
  assert.equal(supportsProcessGroups("linux"), true);
  assert.equal(supportsProcessGroups("darwin"), true);
  assert.equal(supportsProcessGroups("win32"), false);
});

test("processGroupGone: ESRCH means gone, success or EPERM means a member is still there, other errors are not swallowed", () => {
  assert.equal(processGroupGone(4242, { killProcess: () => true }), false);
  assert.equal(processGroupGone(4242, { killProcess: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); } }), true);
  // macOS answers EPERM for a member that is on its way out: it exists, so the group is not provably empty.
  assert.equal(processGroupGone(4242, { killProcess: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); } }), false);
  assert.throws(() => processGroupGone(4242, { killProcess: () => { throw Object.assign(new Error("x"), { code: "EINVAL" }); } }), /x/);
  assert.equal(processGroupGone(undefined), true, "no pid, nothing to wait for");
});

test("terminateProcessTree: Windows asks taskkill for the whole tree; a child without a pid falls back to kill()", () => {
  const calls = [];
  const outcome = terminateProcessTree({ pid: 321, kill: () => assert.fail("must use taskkill") }, {
    platform: "win32",
    spawnSyncImpl: (command, args) => { calls.push([command, ...args]); return { status: 0 }; },
  });
  assert.equal(outcome.method, "taskkill-tree");
  assert.deepEqual(calls, [["taskkill", "/pid", "321", "/T", "/F"]]);

  const signals = [];
  const fallback = terminateProcessTree({ kill: (signal) => signals.push(signal) }, { platform: "linux" });
  assert.equal(fallback.method, "child-kill");
  assert.deepEqual(signals, ["SIGKILL"]);
});

test("terminateProcessTree: taskkill is bounded, and one that stalls, fails or is missing is reported as unconfirmed", () => {
  const calls = [];
  const attempt = (spawnSyncImpl) => terminateProcessTree({ pid: 321, kill: () => assert.fail("must use taskkill") }, { platform: "win32", spawnSyncImpl });
  const stalled = attempt((command, args, options) => { calls.push(options); return { status: null, error: Object.assign(new Error("spawnSync taskkill ETIMEDOUT"), { code: "ETIMEDOUT" }) }; });
  assert.equal(stalled.method, "taskkill-tree");
  assert.equal(stalled.unconfirmed, true);
  assert.ok(Number.isInteger(calls[0].timeout) && calls[0].timeout > 0 && calls[0].timeout <= 30_000, "taskkill has its own deadline");
  assert.equal(calls[0].killSignal, "SIGKILL");
  assert.equal(attempt(() => { throw Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }); }).unconfirmed, true);
  // Only a clean exit confirms the kill. A launched taskkill that answers with a failure (1: access denied or the
  // tree could not be ended) sets no `error`, and 128 ("not found") only says the root is gone, which proves
  // nothing about descendants it left behind.
  assert.equal(attempt(() => ({ status: 0 })).unconfirmed, false);
  for (const status of [1, 128, 255]) assert.equal(attempt(() => ({ status })).unconfirmed, true, `exit ${status}`);
  assert.equal(attempt(() => ({ status: null, signal: "SIGKILL" })).unconfirmed, true, "ended by a signal, no exit status");
});

test("terminateProcessTree (real taskkill, Windows only): a live tree ends and is confirmed, a pid already gone is not", { skip: POSIX && "needs taskkill" }, async () => {
  const { child, descendant } = await spawnTreeWithDescendantHoldingPipes();
  try {
    assert.equal(terminateProcessTree(child).unconfirmed, false, "taskkill ended the whole tree");
    assert.equal(await waitUntilGone(descendant), true);
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(terminateProcessTree(child).unconfirmed, true, "nothing left to kill is not proof that nothing is left");
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
    child.kill("SIGKILL");
  }
});

test("terminateProcessTree: POSIX signals the negative pid and treats a vanished group as done", () => {
  const sent = [];
  const outcome = terminateProcessTree({ pid: 777, kill: () => assert.fail("group kill expected") }, {
    platform: "linux",
    killProcess: (pid, signal) => { sent.push([pid, signal]); },
  });
  assert.equal(outcome.method, "process-group-sigkill");
  assert.deepEqual(sent, [[-777, "SIGKILL"]]);
  terminateProcessTree({ pid: 777, kill: () => assert.fail("ESRCH is not a reason to retry") }, {
    platform: "linux",
    killProcess: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  });
});

function spawnTreeWithDescendantHoldingPipes() {
  // The parent starts a descendant that inherits stdout/stderr, prints its pid and then lingers.
  const script = `
    const { spawn } = require("node:child_process");
    const d = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    process.stdout.write("pid:" + d.pid + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], detached: POSIX });
  return new Promise((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk) => {
      seen += chunk.toString("utf8");
      const match = /pid:(\d+)\n/u.exec(seen);
      if (match) resolve({ child, descendant: Number(match[1]) });
    });
    child.on("error", reject);
  });
}

async function waitUntilGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("terminateProcessTree: a descendant that inherited the pipes dies with its parent", async () => {
  const { child, descendant } = await spawnTreeWithDescendantHoldingPipes();
  try {
    terminateProcessTree(child);
    assert.equal(await waitUntilGone(descendant), true, "the descendant must not outlive the tree kill");
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
    child.kill("SIGKILL");
  }
});

test("sweepProcessGroup: removes a descendant that outlived its parent and reports the group empty", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  const { child, descendant } = await spawnTreeWithDescendantHoldingPipes();
  try {
    process.kill(child.pid, "SIGKILL"); // the parent alone; the descendant keeps the group alive
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(processGroupGone(child.pid), false, "precondition: the group still has a member");
    assert.equal(await sweepProcessGroup(child), true);
    assert.equal(await waitUntilGone(descendant), true);
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("sweepProcessGroup: a member that answers EPERM while it dies is waited for, not reported as an error", async () => {
  const answers = ["EPERM", "ok", "EPERM", "ESRCH"]; // probe, SIGKILL, then the poll until the member is gone
  const seen = [];
  const killProcess = (pid, signal) => {
    seen.push([pid, signal]);
    const answer = answers.shift();
    if (answer === "ok") return true;
    throw Object.assign(new Error(answer), { code: answer });
  };
  assert.equal(await sweepProcessGroup({ pid: 5151 }, { platform: "linux", killProcess, intervalMs: 1 }), true);
  assert.deepEqual(seen, [[-5151, 0], [-5151, "SIGKILL"], [-5151, 0], [-5151, 0]]);
});

test("sweepProcessGroup: an already empty group and platforms without groups need no action", async () => {
  assert.equal(await sweepProcessGroup({ pid: 5151 }, { platform: "win32", killProcess: () => assert.fail("no group on win32") }), true);
  assert.equal(await sweepProcessGroup({}, { platform: "linux" }), true);
  assert.equal(await sweepProcessGroup({ pid: 5151 }, { platform: "linux", killProcess: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), true);
});

// ---- spawnSyncBounded: a synchronous call whose deadline cannot be ignored and that leaves no group member behind

const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 4000); setInterval(() => {}, 1000);`;
// POSIX sh rather than node: the deadline is 2000 ms (600 ms raced sh under load), and two node cold starts (the tool, then its descendant) can take longer
// than that on a busy machine, so the pid would never be printed. The descendant (`sleep`) inherits the pipes like the node one did.
// Both stop by themselves after 30 s, so a broken kill cannot leak them for good.
const WITH_LINGERING_DESCENDANT = `trap '' TERM; sleep 30 & echo "pid:$!"; i=0; while [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done`;

test("spawnSyncBounded: asks for an uncatchable kill and, off Windows, its own process group", () => {
  const seen = [];
  const outcome = spawnSyncBounded("tool", ["--version"], { timeout: 5 }, {
    platform: "linux",
    spawnSyncImpl: (...args) => { seen.push(args); return { status: 0, stdout: "ok", pid: 4321 }; },
    killProcess: (pid, signal) => { seen.push(["kill", pid, signal]); throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  });
  assert.equal(outcome.stdout, "ok");
  assert.equal(seen[0][2].killSignal, "SIGKILL");
  assert.equal(seen[0][2].detached, true);
  assert.equal(seen[0][2].timeout, 5, "the caller's own options pass through");
  assert.deepEqual(seen[1], ["kill", -4321, "SIGKILL"], "the group is swept after the call");
  const windows = [];
  spawnSyncBounded("tool", [], {}, { platform: "win32", spawnSyncImpl: (...args) => { windows.push(args); return { status: 0, pid: 99 }; }, killProcess: () => assert.fail("no group on win32") });
  assert.equal(windows[0][2].detached, false);
  assert.equal(windows[0][2].killSignal, "SIGKILL");
});

test("spawnSyncBounded: a tool that ignores SIGTERM is cut off at its deadline", { skip: !POSIX && "SIGTERM semantics are POSIX-only" }, async () => {
  const started = Date.now();
  const outcome = spawnSyncBounded(process.execPath, ["-e", IGNORES_SIGTERM], { encoding: "utf8", timeout: 400 });
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
  assert.equal(outcome.error?.code, "ETIMEDOUT");
});

test("spawnSyncBounded: a descendant that inherited the pipes does not outlive the call", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  const outcome = spawnSyncBounded("/bin/sh", ["-c", WITH_LINGERING_DESCENDANT], { encoding: "utf8", timeout: 2000 });
  const descendant = Number(/pid:(\d+)/u.exec(outcome.stdout ?? "")?.[1]);
  try {
    assert.ok(descendant > 0, "the tool started its descendant");
    assert.equal(await waitUntilGone(descendant), true, "the descendant must be gone");
  } finally {
    try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
  }
});
