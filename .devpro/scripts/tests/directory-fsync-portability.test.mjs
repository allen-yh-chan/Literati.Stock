/**
 * Prove-it (R1): directory-entry fsync durability must be a single cross-platform
 * SSOT (`lib/durable-fs.mjs`), not three private per-file copies that raise on
 * win32 because `openSync`/`fsyncSync` on a directory handle is POSIX-only.
 *
 * Red state (T1): `../lib/durable-fs.mjs` does not exist yet, so importing
 * `fsyncDirectory` from it fails the whole file at module load
 * (`ERR_MODULE_NOT_FOUND` or equivalent) before any test body runs.
 *
 * Green state (T2): once `lib/durable-fs.mjs` exists, the tests below assert
 * win32 injection is a no-op (never attempts `openSync`/`fsyncSync`) and
 * non-win32 preserves the exact `openSync(directory, "r")` -> `fsyncSync(fd)`
 * -> `finally closeSync(fd)` statement sequence and error propagation that the
 * three private implementations used before migration.
 *
 * T4 addition: a private-duplicate-definition guard proving the three
 * production files no longer carry their own `fsyncDirectory` function, nor an
 * inline un-factored duplicate of the same directory-open-then-fsync sequence
 * (the read-only `openSync(..., "r")` idiom used only for that purpose in this
 * codebase).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fsyncDirectory } from "../lib/durable-fs.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const durableFsPath = path.resolve(scriptDir, "../lib/durable-fs.mjs");
const durableFsSource = readFileSync(durableFsPath, "utf8");

const migratedProductionFiles = [
  path.join(REPO_ROOT, ".devpro/scripts/render-second-review-packet.mjs"),
  path.join(REPO_ROOT, ".devpro/scripts/hooks/lib/second-review-control-evidence.mjs"),
  path.join(REPO_ROOT, ".devpro/scripts/hooks/lib/post-pr-completion-state.mjs"),
];

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "durable-fs-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("exports exactly one fsyncDirectory function", () => {
  assert.equal(typeof fsyncDirectory, "function");
});

test("win32 injection is a no-op: it never attempts to open or fsync the directory", () => {
  const missingDirectory = path.join(tmpdir(), `durable-fs-test-missing-${process.pid}-${Date.now()}`);
  // A real openSync attempt on a nonexistent path throws ENOENT. win32 must
  // return immediately without throwing, proving openSync was never called.
  assert.doesNotThrow(() => fsyncDirectory(missingDirectory, { platform: "win32" }));
});

test("non-win32 attempts openSync and propagates the resulting error unmodified", () => {
  const missingDirectory = path.join(tmpdir(), `durable-fs-test-missing-${process.pid}-${Date.now()}-2`);
  assert.throws(
    () => fsyncDirectory(missingDirectory, { platform: "linux" }),
    (error) => error?.code === "ENOENT"
  );
});

test("real directory follows the host fsync contract without throwing", () => {
  withTempDir((dir) => {
    // POSIX opens/fsyncs the directory entry; native Win32 intentionally uses
    // the documented no-op because directory handles are not fsync-able there.
    assert.doesNotThrow(() => fsyncDirectory(dir, { platform: process.platform }));
  });
});

test("platform option defaults to process.platform when omitted", () => {
  if (process.platform === "win32") {
    withTempDir((dir) => {
      assert.doesNotThrow(() => fsyncDirectory(dir));
    });
    return;
  }
  withTempDir((dir) => {
    assert.doesNotThrow(() => fsyncDirectory(dir));
  });
});

test("source preserves the exact win32-no-op-then-POSIX-sequence statement order", () => {
  const win32Check = durableFsSource.indexOf('platform === "win32"');
  assert.notEqual(win32Check, -1, "missing win32 platform guard");
  const openCall = durableFsSource.indexOf('openSync(directory, "r")', win32Check);
  assert.notEqual(openCall, -1, "missing openSync(directory, \"r\") after the win32 guard");
  const fsyncCall = durableFsSource.indexOf("fsyncSync(", openCall);
  assert.notEqual(fsyncCall, -1, "missing fsyncSync(fd) after openSync");
  const finallyBlock = durableFsSource.indexOf("finally", fsyncCall);
  assert.notEqual(finallyBlock, -1, "missing finally block after fsyncSync");
  const closeCall = durableFsSource.indexOf("closeSync(", finallyBlock);
  assert.notEqual(closeCall, -1, "missing closeSync(fd) inside the finally block");
});

test("private directory-fsync definitions are removed from all three migrated production files", () => {
  for (const filePath of migratedProductionFiles) {
    const source = readFileSync(filePath, "utf8");
    assert.doesNotMatch(
      source,
      /function\s+fsyncDirectory\s*\(/,
      `${filePath} must not carry a private fsyncDirectory definition; it must import the SSOT from lib/durable-fs.mjs`
    );
  }
});

test("no un-factored inline duplicate of the directory-open-then-fsync sequence remains", () => {
  // `openSync(<path>, "r")` is the read-only-open idiom this SSOT migration uses to
  // fsync a directory entry. Other files in this codebase legitimately use a read-only
  // open for ordinary file reads (e.g. run-second-reviewer-projection.mjs,
  // probe-second-reviewer-cli-recipe.mjs) — this invariant is scoped to the three
  // migrated files only, not a codebase-wide claim. Any surviving occurrence in those
  // three means a private copy — named or inline — of the directory-fsync sequence was
  // left behind instead of calling the imported SSOT helper.
  const readOnlyOpenPattern = /openSync\([^)]*,\s*"r"\)/;
  for (const filePath of migratedProductionFiles) {
    const source = readFileSync(filePath, "utf8");
    assert.doesNotMatch(
      source,
      readOnlyOpenPattern,
      `${filePath} still contains an inline openSync(..., "r") directory-fsync duplicate`
    );
  }
});

test("post-pr-completion-state.mjs no longer declares its own directoryFd local (all call sites route through the shared wrapper)", () => {
  const postPrCompletionPath = migratedProductionFiles[2];
  const source = readFileSync(postPrCompletionPath, "utf8");
  assert.doesNotMatch(
    source,
    /directoryFd/,
    "post-pr-completion-state.mjs must route every directory fsync through fsyncContainingDirectory() -> durable-fs.mjs, not a local directoryFd variable"
  );
});
