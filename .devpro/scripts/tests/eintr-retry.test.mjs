import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientGitIoError, retryOnTransientGitIo } from "../lib/eintr-retry.mjs";

const eintr = () =>
  Object.assign(new Error("Command failed: git show deadbeef"), {
    stderr: "fatal: unable to open loose object deadbeef: Interrupted system call",
  });

test("isTransientGitIoError recognizes EINTR stderr and codes", () => {
  assert.equal(isTransientGitIoError(eintr()), true);
  const coded = new Error("boom");
  coded.code = "EINTR";
  assert.equal(isTransientGitIoError(coded), true);
  assert.equal(isTransientGitIoError(new Error("fatal: not a git repository")), false);
  assert.equal(isTransientGitIoError(undefined), false);
});

test("isTransientGitIoError ignores EINTR-looking text in message or stdout (cross-model F4)", () => {
  const noisy = Object.assign(
    new Error("Command failed: git cat-file blob abc\nfatal: unable to open loose object abc: Interrupted system call"),
    {
      stdout: "source text mentioning Interrupted system call",
      stderr: "fatal: bad revision 'abc'",
    },
  );
  assert.equal(isTransientGitIoError(noisy), false);
});

test("retryOnTransientGitIo retries EINTR then returns the value", () => {
  let calls = 0;
  const value = retryOnTransientGitIo(() => {
    calls += 1;
    if (calls < 3) throw eintr();
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("retryOnTransientGitIo propagates non-EINTR errors immediately", () => {
  let calls = 0;
  assert.throws(
    () =>
      retryOnTransientGitIo(() => {
        calls += 1;
        throw new Error("fatal: bad revision");
      }),
    /bad revision/,
  );
  assert.equal(calls, 1);
});

test("retryOnTransientGitIo rejects non-positive attempt budgets", () => {
  assert.throws(
    () => retryOnTransientGitIo(() => "never", { attempts: 0 }),
    /attempts must be a positive integer/,
  );
  assert.throws(
    () => retryOnTransientGitIo(() => "never", { attempts: 1.5 }),
    /attempts must be a positive integer/,
  );
});

test("retryOnTransientGitIo exhausts bounded attempts on persistent EINTR", () => {
  let calls = 0;
  assert.throws(
    () =>
      retryOnTransientGitIo(() => {
        calls += 1;
        throw eintr();
      }, { attempts: 2, delayMs: 0 }),
    /Command failed: git show deadbeef/,
  );
  assert.equal(calls, 2);
});
