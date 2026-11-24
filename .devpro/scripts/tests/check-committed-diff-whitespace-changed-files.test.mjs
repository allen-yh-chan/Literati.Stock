/**
 * check-committed-diff-whitespace-changed-files.test.mjs
 *
 * Regression tests for the --changed-files <base> mode of
 * check-committed-diff-whitespace.mjs.
 *
 * Core claim: --changed-files does a full-file `git diff --check` against
 * EMPTY_TREE_SHA for every file the PR touched, catching pre-existing
 * whitespace errors that the 3-dot --base diff misses (because a 3-dot diff
 * only shows lines this PR changed, not lines that were already bad before
 * the PR started).
 *
 * Case A — pre-existing EOF blank line in a touched file → --changed-files fails
 * Case B — touched file is clean → --changed-files passes
 * Case C — no changed files (base == HEAD) → exit 0 + "no changed files"
 * Case D — contrast: same repo as case A, --base (3-dot) exits 0 (misses the pre-existing error)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const checker = repoPath(".devpro/scripts/check-committed-diff-whitespace.mjs");

// Helpers ─────────────────────────────────────────────────────────────────────

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function mustRun(cmd, args, cwd) {
  const result = run(cmd, args, cwd);
  assert.equal(
    result.status,
    0,
    `${cmd} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

/**
 * Create a minimal git repo with a single base commit.
 * Returns { dir, baseSha } — baseSha is the SHA of the initial commit (useful
 * as the --changed-files <base> reference).
 */
function createBaseRepo({ fileName = "f.txt", content = "line\n" } = {}) {
  const dir = makeTempDir("ws-changed-files-test-");
  mustRun("git", ["init", "-b", "main"], dir);
  mustRun("git", ["config", "user.email", "test@example.invalid"], dir);
  mustRun("git", ["config", "user.name", "Test User"], dir);
  writeFileSync(path.join(dir, fileName), content);
  mustRun("git", ["add", fileName], dir);
  mustRun("git", ["commit", "-m", "base"], dir);
  const baseSha = run("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  return { dir, baseSha };
}

// ── Case A ───────────────────────────────────────────────────────────────────
//
// f.txt already has a trailing blank line (pre-existing EOF whitespace error).
// A subsequent commit touches f.txt but changes a different line — it does NOT
// add a new blank line.  The 3-dot diff only shows the changed line, so --base
// misses the pre-existing problem.  --changed-files does a full-file check and
// catches it.

test("Case A — pre-existing EOF blank line in touched file → --changed-files exit ≠ 0", () => {
  // Base commit: f.txt already has trailing blank line (the pre-existing error).
  const { dir, baseSha } = createBaseRepo({ content: "line\n\n" });

  // Second commit: change a different line in f.txt (do NOT remove the blank line).
  writeFileSync(path.join(dir, "f.txt"), "changed\n\n");
  mustRun("git", ["add", "f.txt"], dir);
  mustRun("git", ["commit", "-m", "touch file without fixing eof blank"], dir);

  // --changed-files should detect the EOF blank line in the full file.
  const result = run(process.execPath, [checker, "--changed-files", baseSha], dir);

  assert.notEqual(
    result.status,
    0,
    `expected exit ≠ 0 but got 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(
    result.stderr,
    /Committed diff whitespace gate \(changed-files full-file vs [0-9a-f]+\) failed/,
    `stderr did not contain expected gate failure message:\n${result.stderr}`
  );
});

// ── Case B ───────────────────────────────────────────────────────────────────
//
// Touched file has no whitespace errors.  --changed-files should exit 0.

test("Case B — clean touched file → --changed-files exit 0", () => {
  const { dir, baseSha } = createBaseRepo({ content: "line one\n" });

  // Second commit: clean change.
  writeFileSync(path.join(dir, "f.txt"), "line one\nline two\n");
  mustRun("git", ["add", "f.txt"], dir);
  mustRun("git", ["commit", "-m", "add clean second line"], dir);

  const result = run(process.execPath, [checker, "--changed-files", baseSha], dir);

  assert.equal(
    result.status,
    0,
    `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(
    result.stdout,
    /Committed diff whitespace gate: pass/,
    `stdout did not contain pass message:\n${result.stdout}`
  );
});

// ── Case C ───────────────────────────────────────────────────────────────────
//
// base == HEAD — no files have changed.  --changed-files should exit 0 and
// report "no changed files".

test("Case C — no changed files (base == HEAD) → exit 0 + 'no changed files'", () => {
  const { dir, baseSha } = createBaseRepo();

  // Do NOT make another commit — baseSha IS HEAD.
  const result = run(process.execPath, [checker, "--changed-files", baseSha], dir);

  assert.equal(
    result.status,
    0,
    `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.match(
    result.stdout,
    /no changed files/i,
    `stdout did not contain 'no changed files':\n${result.stdout}`
  );
});

// ── Case D (contrast) ────────────────────────────────────────────────────────
//
// Same fixture as case A: f.txt has a pre-existing EOF blank line; only a
// different line is changed in the second commit.  Running the OLD --base
// (3-dot diff) exits 0 — it misses the pre-existing error because the 3-dot
// diff only surfaces the lines this PR introduced.
//
// This directly demonstrates the gap that --changed-files closes.

test("Case D — contrast: --base (3-dot diff) exits 0 for same pre-existing EOF blank (misses it)", () => {
  // Exactly the same repo construction as Case A.
  const { dir, baseSha } = createBaseRepo({ content: "line\n\n" });

  writeFileSync(path.join(dir, "f.txt"), "changed\n\n");
  mustRun("git", ["add", "f.txt"], dir);
  mustRun("git", ["commit", "-m", "touch file without fixing eof blank"], dir);

  // --base uses a 3-dot diff: only shows lines this PR changed.
  // The trailing blank line was already there in the base commit, so the diff
  // does not include it as a new line → git diff --check does not flag it.
  const oldResult = run(process.execPath, [checker, "--base", baseSha], dir);

  assert.equal(
    oldResult.status,
    0,
    `expected --base to exit 0 (miss the pre-existing error), but got ${oldResult.status}\nstderr: ${oldResult.stderr}`
  );

  // Now confirm --changed-files catches what --base misses.
  const newResult = run(process.execPath, [checker, "--changed-files", baseSha], dir);

  assert.notEqual(
    newResult.status,
    0,
    `expected --changed-files to exit ≠ 0 (catch the pre-existing error), but got 0\nstdout: ${newResult.stdout}\nstderr: ${newResult.stderr}`
  );
});
