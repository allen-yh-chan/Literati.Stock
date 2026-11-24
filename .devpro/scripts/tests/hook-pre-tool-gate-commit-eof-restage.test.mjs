/**
 * hook-pre-tool-gate-commit-eof-restage.test.mjs
 *
 * Integration tests for the Commit-Time EOF Normalize Re-stage Gate
 * (checkCommitEofRestage / checkCommitAdvisories composite) in
 * pre-tool-gate.mjs.
 *
 * Per `openspec/changes/enforce-eof-normalize-at-commit` R2/T3/T4: on `git
 * commit`, any STAGED text file that is EOF-dirty per `isDirtyPerGuard()` is
 * normalized and re-staged (index-only — `git update-index --cacheinfo`,
 * never touching the working tree), and an advisory names the affected
 * files. Binary files are skipped. File mode is preserved. The gate is a
 * side-effect-first step inside the `checkCommitAdvisories` composite so it
 * cannot be suppressed by first-truthy-wins ordering with the attribution
 * footer advisory — but a step-1 BLOCKING gate (e.g. commit-attribution
 * brand-leak) short-circuits before this composite ever runs, so no
 * re-stage side-effect happens when the commit blocks.
 *
 * TDD note: written before checkCommitEofRestage existed in
 * pre-tool-gate.mjs — cases (a)/(d)/(e)/(f) are expected RED until T3 lands.
 */

import "./lib/git-location-isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { markSourceCheckout, unmarkSourceCheckout } from "./lib/identity-fixtures.mjs";
import { ACTIVE_GATE_INVENTORY, checkCommitEofRestage } from "../hooks/pre-tool-gate.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

const tmpRoot = makeTempDir("commit-eof-restage-gate-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r;
}

function gitOk(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Build a bare-bones work repo with an initial commit on `main`, then check
 * out a `chore/fixture` feature branch — the protected-branch-write gate
 * hard-blocks `git commit` directly on `main`/`master`, which would mask the
 * EOF gate under test. All fixture commits under test happen on this branch.
 */
// `spaced` puts the checkout in a directory whose name has a space, as a temporary directory may (PR #3703 r7 W3-F3).
function setupFixture({ spaced = false } = {}) {
  const work = path.join(tmpRoot, `fixture${spaced ? " with space" : ""}-${counter++}`);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "core.autocrlf", "false"]);
  git(work, ["config", "user.email", "t@t.com"]);
  git(work, ["config", "user.name", "t"]);
  writeFileSync(path.join(work, "README.md"), "fixture\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);
  git(work, ["checkout", "-q", "-b", "chore/fixture"]);
  markSourceCheckout(work);
  return work;
}

/** Drive the hook exactly as Claude Code / Codex would via stdin PreToolUse payload. */
function runHook(command, fixtureDir) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  const sentinelDir = mkdtempSync(path.join(tmpRoot, "sentinel-"));
  const r = spawnSync("node", [HOOK], {
    cwd: fixtureDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      DEVPRO_RELEVANT_ARCHIVES: "",
      PWD: fixtureDir,
    },
  });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function advisoryText(json) {
  return json?.advisory || json?.hookSpecificOutput?.additionalContext || json?.systemMessage || "";
}

function stagedBlobHash(cwd, file) {
  const r = gitOk(cwd, ["rev-parse", `:${file}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function stagedContent(cwd, file) {
  const r = gitOk(cwd, ["show", `:${file}`]);
  return r.status === 0 ? r.stdout : null;
}

function stagedMode(cwd, file) {
  const r = gitOk(cwd, ["ls-files", "--stage", file]);
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\s+/)[0];
}

// A commit that passes the attribution gate cleanly (avoid the footer advisory
// polluting assertions in cases that don't test attribution).
const CLEAN_COMMIT_MSG =
  "chore: fixture commit\n\nRules: v6.82.1 · Tool: Test Harness · Model: n/a";

test("Commit EOF restage gate: staged text file EOF-dirty → re-stage + advisory, staged blob clean", () => {
  const dir = setupFixture();
  // Blank line at EOF (dirty per isDirtyPerGuard: last line blank).
  writeFileSync(path.join(dir, "notes.md"), "line one\nline two\n\n");
  git(dir, ["add", "-A"]);

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `expected re-stage advisory; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );

  const content = stagedContent(dir, "notes.md");
  assert.ok(content !== null, "staged notes.md must still be readable after re-stage");
  assert.equal(content, "line one\nline two\n", "staged blob must be EOF-normalized");
});

test("Commit EOF restage gate: clean staged file → no EOF advisory, blob hash unchanged", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\nline two\n");
  git(dir, ["add", "-A"]);
  const beforeHash = stagedBlobHash(dir, "notes.md");

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.doesNotMatch(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `clean staged file must not trigger re-stage advisory; got: ${JSON.stringify(r.json)}`
  );
  assert.equal(
    stagedBlobHash(dir, "notes.md"),
    beforeHash,
    "clean file's staged blob hash must be untouched"
  );
});

test("Commit EOF restage gate: staged binary file → skipped, blob hash unchanged", () => {
  const dir = setupFixture();
  // NUL byte marks the file as binary to `git diff --cached --numstat` (-\t-).
  writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x0a]));
  git(dir, ["add", "-A"]);

  const numstat = git(dir, ["diff", "--cached", "--numstat"]).stdout;
  assert.match(numstat, /^-\t-\tblob\.bin$/m, "fixture sanity: file must read as binary in numstat");

  const beforeHash = stagedBlobHash(dir, "blob.bin");
  runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.equal(
    stagedBlobHash(dir, "blob.bin"),
    beforeHash,
    "binary staged blob must not be touched by EOF normalize"
  );
});

test("Commit EOF restage gate: pure rename → no probe-failed advisory", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "old.md"), "line\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", CLEAN_COMMIT_MSG]);
  git(dir, ["mv", "old.md", "new.md"]);

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.doesNotMatch(
    advisoryText(r.json),
    /probe-failed/,
    `pure rename must not emit probe-failed; got: ${JSON.stringify(r.json)}`
  );
});

test("Commit EOF restage gate: rename-with-edit → destination re-staged", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "old.md"), "line\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", CLEAN_COMMIT_MSG]);
  git(dir, ["mv", "old.md", "new.md"]);
  writeFileSync(path.join(dir, "new.md"), "line\n\n"); // content edit after rename → EOF-dirty
  git(dir, ["add", "-A"]);

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `rename-with-edit destination must be re-staged; got: ${JSON.stringify(r.json)}`
  );
  assert.equal(stagedContent(dir, "new.md"), "line\n", "renamed destination must be EOF-normalized");
});

test("Commit EOF restage gate: filename containing ' => ' is still checked (not skipped)", () => {
  const dir = setupFixture();
  if (process.platform === "win32") {
    // Win32 Git rejects `>` even in an index-only path. Exercise the exported
    // production gate with exact Git argv/results instead of claiming that an
    // impossible Win32 index entry was staged; POSIX keeps the real-index test.
    const originalSpawnSync = childProcess.spawnSync;
    const observed = [];
    try {
      childProcess.spawnSync = (command, args, options) => {
        if (command !== "git") return originalSpawnSync(command, args, options);
        const key = args.join(" ");
        if (key === "diff --cached --numstat -z") {
          return { status: 0, stdout: "1\t0\tweird => name.md\0", stderr: "" };
        }
        if (key === "show :weird => name.md") {
          observed.push(key);
          return { status: 0, stdout: "line\n\n", stderr: "" };
        }
        if (key === "ls-files --stage -- weird => name.md") {
          observed.push(key);
          return { status: 0, stdout: "100644 f88eec3a38cd394fbb46ebb025452c9bae4f1584 0\tweird => name.md\n", stderr: "" };
        }
        if (key === "hash-object -w --stdin") {
          assert.equal(options.input, "line\n");
          observed.push(key);
          return { status: 0, stdout: "f88eec3a38cd394fbb46ebb025452c9bae4f1584\n", stderr: "" };
        }
        if (key === "update-index --cacheinfo 100644,f88eec3a38cd394fbb46ebb025452c9bae4f1584,weird => name.md") {
          observed.push(key);
          return { status: 0, stdout: "", stderr: "" };
        }
        return originalSpawnSync(command, args, options);
      };
      syncBuiltinESMExports();
      const result = checkCommitEofRestage(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);
      assert.match(result?.advisory ?? "", /已自動移除 staged EOF 空行並 re-stage/);
      assert.match(result.advisory, /weird => name\.md/);
      assert.deepEqual(observed, [
        "show :weird => name.md",
        "ls-files --stage -- weird => name.md",
        "hash-object -w --stdin",
        "update-index --cacheinfo 100644,f88eec3a38cd394fbb46ebb025452c9bae4f1584,weird => name.md",
      ]);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    }
    return;
  }

  // POSIX permits the literal filename in Git's index; retain the real
  // index-only re-stage integration assertion here.
  const payloadPath = path.join(dir, "portable-payload.md");
  writeFileSync(payloadPath, "line\n\n");
  git(dir, ["add", "portable-payload.md"]);
  const blobId = git(dir, ["rev-parse", ":portable-payload.md"]).stdout.trim();
  git(dir, ["update-index", "--force-remove", "portable-payload.md"]);
  git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blobId},weird => name.md`]);
  rmSync(payloadPath);

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `literal ' => ' filename must still be checked; got: ${JSON.stringify(r.json)}`
  );
  assert.equal(
    stagedContent(dir, "weird => name.md"),
    "line\n",
    "synthetic index-only path must be normalized and re-staged"
  );
});

test("Commit EOF restage gate: 100755 executable dirty file → re-staged with mode preserved", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n\n"); // dirty: blank at EOF
  git(dir, ["add", "-A"]);
  git(dir, ["update-index", "--chmod=+x", "run.sh"]);
  assert.equal(stagedMode(dir, "run.sh"), "100755", "fixture sanity: staged mode must be 100755 before commit");

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `expected re-stage advisory for dirty executable; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.equal(
    stagedMode(dir, "run.sh"),
    "100755",
    "re-stage must preserve the 100755 executable mode"
  );
  assert.equal(
    stagedContent(dir, "run.sh"),
    "#!/bin/sh\necho hi\n",
    "re-staged content must be EOF-normalized"
  );
});

test("Commit EOF restage gate: index-only — working tree and unrelated unstaged edits untouched", () => {
  const dir = setupFixture();
  // Stage a dirty file.
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n");
  git(dir, ["add", "-A"]);
  // Then make an UNSTAGED edit to a DIFFERENT tracked file (README.md, already
  // committed in setupFixture) — this must NOT be swept into the commit.
  writeFileSync(path.join(dir, "README.md"), "fixture\nunstaged edit\n");

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);
  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `expected re-stage advisory; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );

  // Working tree copy of the re-staged file must be untouched (still dirty on disk).
  const wtDiff = git(dir, ["diff", "--", "notes.md"]).stdout;
  assert.notEqual(wtDiff, "", "working tree notes.md must still differ from the re-staged index (index-only side effect)");

  // The unrelated unstaged README.md edit must not have been pulled into the index.
  const cachedDiffReadme = git(dir, ["diff", "--cached", "--", "README.md"]).stdout;
  assert.equal(
    cachedDiffReadme,
    "",
    "unstaged README.md edit must not be swept into the index by the gate"
  );
  const wtDiffReadme = git(dir, ["diff", "--", "README.md"]).stdout;
  assert.notEqual(
    wtDiffReadme,
    "",
    "unstaged README.md edit must remain in the working tree, unstaged"
  );
});

test("Commit EOF restage gate: step-1 attribution block short-circuits — no re-stage side effect", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty
  git(dir, ["add", "-A"]);
  const beforeHash = stagedBlobHash(dir, "notes.md");

  // Forbidden brand marker in the commit message trips the step-1 BLOCKING
  // commit-attribution-brand-leak gate (checkCommitAttribution → block).
  const brandLeakMsg = "feat: something\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  const r = runHook(`git commit -m "${brandLeakMsg}"`, dir);

  assert.equal(
    r.json?.decision,
    "block",
    `expected step-1 attribution block to fire; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.equal(
    stagedBlobHash(dir, "notes.md"),
    beforeHash,
    "blocking short-circuit must prevent the EOF gate's re-stage side effect from running"
  );
});

test("Commit EOF restage gate: staged symlink (mode 120000) must NOT be normalized — regression for data-corruption bug", () => {
  const dir = setupFixture();

  // Regular-file dirty control alongside the symlink, to prove the mode
  // whitelist is precise (skips ONLY the symlink) rather than an accidental
  // full skip of the whole gate.
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty
  writeFileSync(path.join(dir, "realfile.txt"), "target content\n");

  // Stage the symlink itself. `fs.symlinkSync` is used where available
  // (macOS/Linux dev + CI runners all support it); the raw link-target
  // string ("realfile.txt", no trailing newline) is exactly the shape that
  // triggered the bug — `git diff --numstat` reports it as a normal
  // text-like add (not `-\t-`), so it passed the old binary filter and got
  // EOF-normalized (a trailing `\n` appended to the target string) then
  // re-staged, corrupting the symlink to point at a nonexistent
  // `realfile.txt\n`.
  symlinkSync("realfile.txt", path.join(dir, "mylink"));

  git(dir, ["add", "-A"]);
  assert.equal(stagedMode(dir, "mylink"), "120000", "fixture sanity: mylink must be staged as a symlink (mode 120000)");
  const beforeHash = stagedBlobHash(dir, "mylink");
  const beforeContent = stagedContent(dir, "mylink");
  assert.equal(beforeContent, "realfile.txt", "fixture sanity: symlink blob is the raw link-target string, no trailing newline");

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  // The regular-file dirty control DOES get normalized — proves the gate
  // still runs and the mode gate is a precise whitelist, not a blanket skip.
  const text = advisoryText(r.json);
  assert.match(
    text,
    /已自動移除 staged EOF 空行並 re-stage/,
    `expected re-stage advisory for the regular-file control; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.doesNotMatch(
    text,
    /mylink/,
    `symlink must not be named in the re-stage advisory; got: ${JSON.stringify(r.json)}`
  );

  // The symlink's mode and blob must be completely untouched.
  assert.equal(stagedMode(dir, "mylink"), "120000", "symlink mode must remain 120000 after the gate runs");
  assert.equal(
    stagedBlobHash(dir, "mylink"),
    beforeHash,
    "symlink blob hash must be unchanged — the gate must not normalize/re-stage a symlink"
  );
  assert.equal(
    stagedContent(dir, "mylink"),
    "realfile.txt",
    "symlink target string must not gain a trailing newline (the corruption this bug caused)"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// fix-eof-gate-cwd-blind-spot: T1/T2 prove-it (RED before the fix lands).
// Per design.md D2/D3: PreToolUse fires BEFORE the Bash payload executes, so
// a chained `git add -A && git commit` sees the index from BEFORE `add`
// runs, and `git -C <worktree> commit` / `cd <worktree> && git commit` must
// resolve the commit's ACTUAL cwd (not the hook's baseCwd) via
// `commandCwdForGitMatch()`. Both currently return `null` silently.
// ─────────────────────────────────────────────────────────────────────────

test("Commit EOF restage gate (T1 prove-it): chained `git add -A && git commit` → stale-index-chained-add advisory, not silent null", () => {
  const dir = setupFixture();
  // EOF-dirty file that is NOT YET staged — the chained `git add -A` stages it,
  // but PreToolUse fires before that `add` executes, so `git diff --cached
  // --numstat` at hook-fire time sees an index that does not yet include it.
  writeFileSync(path.join(dir, "notes.md"), "line one\nline two\n\n");

  const r = runHook(`git add -A && git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `expected a named stale-index-chained-add advisory (not a silent null); got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (T2 prove-it): `git -C <worktree> commit` re-stages the pushing worktree, not the main checkout's baseCwd", () => {
  // A LINKED git worktree of the SAME repo (not a separate clone, so the Repo
  // Scope Evidence Gate does not interfere — it exempts same-common-dir
  // worktrees). The main checkout (baseCwd) has nothing dirty; the linked
  // worktree has an EOF-dirty staged file. If the gate read baseCwd's index
  // (or failed to resolve the `-C` target at all) it would miss the dirt.
  const main = setupFixture();
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-fixture", wt, "chore/fixture"]);
  markSourceCheckout(wt);

  writeFileSync(path.join(wt, "notes.md"), "line one\nline two\n\n"); // EOF-dirty, in the WORKTREE
  git(wt, ["add", "-A"]);
  const beforeHash = stagedBlobHash(wt, "notes.md");

  const r = runHook(`git -C "${wt}" commit -m "${CLEAN_COMMIT_MSG}"`, main);

  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `expected re-stage advisory for the TARGET worktree's dirty file, not a silent null; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.notEqual(
    stagedBlobHash(wt, "notes.md"),
    beforeHash,
    "target worktree's staged blob must be EOF-normalized and re-staged (the dirt must not survive)"
  );
  assert.equal(
    stagedContent(wt, "notes.md"),
    "line one\nline two\n",
    "target worktree staged content must be EOF-normalized"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// cross-model WARN (PR #2305, dispatch-8347ffa4): finding 1 — narrow
// INDEX_MUTATING_VERB_RE so working-tree-only `git checkout -- <path>` and
// default `git apply` don't over-fire the chained-payload staleness
// detector into a false `stale-index-chained-add` advisory. Finding 2 —
// the chained-detection helper's quote-safety must hold: literal
// `&&`/`git add` text inside a quoted argument must not be mistaken for a
// real prior chained command.
// ─────────────────────────────────────────────────────────────────────────

test("Commit EOF restage gate (finding 1a): chained bare `git checkout -- <path>` (no tree-ish) does NOT false-fire stale-index-chained-add", () => {
  const dir = setupFixture();
  // Nothing staged, nothing dirty — a bare pathspec checkout restores the
  // working tree FROM the index; it does not itself stage anything, so the
  // subsequent commit's genuinely-empty staged set is class A, not a
  // chained-staleness class B.
  const r = runHook(`git checkout -- README.md && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.doesNotMatch(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `bare pathspec checkout must not be classified as index-mutating; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (finding 1a): chained `git checkout <tree-ish> -- <path>` still correctly fires stale-index-chained-add", () => {
  const dir = setupFixture();
  // A tree-ish before `--` DOES copy that tree-ish's version into the
  // index — this positive case must keep working after the narrowing fix.
  const r = runHook(`git checkout HEAD -- README.md && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `checkout WITH a tree-ish must still be classified as index-mutating; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (finding 1b): chained default `git apply` (no --cached/--index) does NOT false-fire stale-index-chained-add", () => {
  const dir = setupFixture();
  writeFileSync(
    path.join(dir, "fixture.patch"),
    [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " fixture",
      "+extra line",
      "",
    ].join("\n")
  );
  git(dir, ["add", "fixture.patch"]);
  git(dir, ["commit", "-q", "-m", "add fixture patch"]);

  // Default `git apply` only touches the working tree, not the index.
  const r = runHook(`git apply fixture.patch && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.doesNotMatch(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `working-tree-only apply must not be classified as index-mutating; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (finding 1b): chained `git apply --cached` still correctly fires stale-index-chained-add", () => {
  const dir = setupFixture();
  writeFileSync(
    path.join(dir, "fixture.patch"),
    [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " fixture",
      "+extra line",
      "",
    ].join("\n")
  );
  git(dir, ["add", "fixture.patch"]);
  git(dir, ["commit", "-q", "-m", "add fixture patch"]);

  const r = runHook(`git apply --cached fixture.patch && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `apply --cached must still be classified as index-mutating; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (finding 1b round 2): a patch FILENAME merely containing the substring `--cached` does NOT false-fire (cross-model re-review catch)", () => {
  // Round-1 fix used an unanchored `--(?:cached|index)\b` with no left
  // boundary, so a filename like `patch--cached.diff` matched the substring
  // even though it is not the `--cached` flag at all. The flag must be a
  // standalone whitespace-delimited token.
  const dir = setupFixture();
  writeFileSync(path.join(dir, "patch--cached.diff"), "not a real patch\n");
  git(dir, ["add", "patch--cached.diff"]);
  git(dir, ["commit", "-q", "-m", "add oddly-named file"]);

  const r = runHook(`git apply patch--cached.diff && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.doesNotMatch(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `a filename containing the substring "--cached" must not be mistaken for the --cached flag; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (finding 1b round 2): `--index` as a standalone flag still correctly fires stale-index-chained-add", () => {
  const dir = setupFixture();
  writeFileSync(
    path.join(dir, "fixture2.patch"),
    ["--- a/README.md", "+++ b/README.md", "@@ -1 +1,2 @@", " fixture", "+extra line", ""].join("\n")
  );
  git(dir, ["add", "fixture2.patch"]);
  git(dir, ["commit", "-q", "-m", "add fixture2 patch"]);

  const r = runHook(`git apply --index fixture2.patch && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `standalone --index flag must still be classified as index-mutating; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate (finding 2): literal `&&`/`git add` text inside a quoted PRIOR command's argument does not false-fire chained detection", () => {
  const dir = setupFixture();
  // `echo`'s quoted argument contains `&&` and `git add` as literal text —
  // this is BEFORE the target `git commit` verb in the same payload, which
  // is exactly the prefix hasPriorChainedMutatingCommand scans. If quote
  // opacification were broken, the naive `&&`/`;`/`||` split would carve
  // out a fake segment containing `git add` and misfire.
  const r = runHook(
    `echo "fake && git add -A" && git commit --allow-empty -m "${CLEAN_COMMIT_MSG}"`,
    dir
  );

  assert.doesNotMatch(
    advisoryText(r.json),
    /stale-index-chained-add/,
    `literal &&/git-add text inside a quoted argument must not be treated as a real chained mutating command; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

test("Commit EOF restage gate: multiple dirty regular files in the same commit are all normalized and named in the advisory", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty
  writeFileSync(path.join(dir, "other.md"), "second file\n\n"); // EOF-dirty
  git(dir, ["add", "-A"]);

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /已自動移除 staged EOF 空行並 re-stage/,
    `expected re-stage advisory; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(advisoryText(r.json), /notes\.md/, "advisory must name notes.md");
  assert.match(advisoryText(r.json), /other\.md/, "advisory must name other.md");

  assert.equal(
    stagedContent(dir, "notes.md"),
    "line one\n",
    "notes.md staged blob must be EOF-normalized"
  );
  assert.equal(
    stagedContent(dir, "other.md"),
    "second file\n",
    "other.md staged blob must be EOF-normalized"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// round-1 dp-reviewer F2: dedicated assertions for `cwd-not-a-git-worktree`
// and `base-cwd-absent` — previously functionally correct (per reviewer's
// manual probe) but with zero test-file assertions naming the reason token.
// ─────────────────────────────────────────────────────────────────────────

test("Commit EOF restage gate (F2): `git --git-dir=<path> commit` → cwd-parse-unresolvable advisory", () => {
  // commandCwdForGitMatch treats `--git-dir`/`--work-tree`/`GIT_DIR=`/
  // `GIT_WORK_TREE=` as unresolvable-cwd shapes (hook-command-context.mjs)
  // regardless of whether the target path is a real worktree — this gate maps
  // that sentinel to `cwd-parse-unresolvable` (fix-silent-gate-skip D1 taxonomy).
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty
  git(dir, ["add", "-A"]);

  const r = runHook(`git --git-dir=${dir}/.git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    advisoryText(r.json),
    /reason=cwd-parse-unresolvable/,
    `expected a named cwd-parse-unresolvable advisory; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.doesNotMatch(
    advisoryText(r.json),
    /reason=cwd-not-a-git-worktree/,
    "UNRESOLVABLE must not map to cwd-not-a-git-worktree"
  );
});

test("Commit EOF restage gate (F2): commit-advisories runner with baseCwd=\"\" → base-cwd-absent advisory", () => {
  // `toolInputCwd()`'s own fallback chain (`... || environmentPwdCwd() ||
  // process.cwd()`) means main()/evaluatePreToolUsePayload can never actually
  // hand `checkCommitEofRestage` an empty baseCwd through the real PreToolUse
  // entry point today — process.cwd() always resolves to a real directory
  // barring an unreproducible mid-flight directory deletion race. `!baseCwd`
  // is therefore currently-unreachable defense-in-depth from that entry
  // point, not a dead branch: this test exercises the SAME runner function
  // object the dispatcher invokes (`ACTIVE_GATE_INVENTORY`'s "commit-advisories"
  // entry, exported for tests) directly with the documented trigger shape,
  // proving the `base-cwd-absent` branch itself is correct even though no
  // current caller can produce that input.
  const gate = ACTIVE_GATE_INVENTORY.find((g) => g.id === "commit-advisories");
  assert.ok(gate, "commit-advisories gate must exist in ACTIVE_GATE_INVENTORY");
  const result = gate.runner({ cmd: `git commit -m "${CLEAN_COMMIT_MSG}"`, baseCwd: "" });
  assert.match(
    result?.advisory || "",
    /reason=base-cwd-absent/,
    `expected base-cwd-absent advisory when baseCwd is empty; got: ${JSON.stringify(result)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// fix-eof-gate-cwd-blind-spot T13: class-A negative tests — none of these
// shapes may produce ANY advisory (not just "no block"). Each fixture also
// writes an AGENTS.md matching CLEAN_COMMIT_MSG's declared footer version,
// so Gate 2b's version-equality layer is CHECKED-and-silent (match) rather
// than skipped — an absent AGENTS.md would otherwise trip the new T11
// `version-layer-skipped` advisory and falsify a "zero advisory" assertion
// for an unrelated reason.
// ─────────────────────────────────────────────────────────────────────────

test("T13 class A: `git commit -a -m x` clean index (deferred staging) → no advisory at all", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "AGENTS.md"), "版本：6.82.1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
  writeFileSync(path.join(dir, "notes.md"), "line one\nline two\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: tracked baseline"]);
  // Modify a TRACKED file so `-a` has something to auto-stage at commit time;
  // nothing is explicitly `git add`-ed beforehand (deferred staging).
  writeFileSync(path.join(dir, "notes.md"), "line one\nline two\nline three\n");

  const r = runHook(`git commit -a -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.equal(r.json, null, `expected total silence; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`);
});

test("T13 class A: consumer repo (installed rules) commit → no advisory at all", () => {
  const dir = setupFixture();
  unmarkSourceCheckout(dir);
  writeFileSync(path.join(dir, "AGENTS.md"), "版本：6.82.1\n");
  mkdirSync(path.join(dir, ".devpro-agent-rules", ".devpro", "scripts"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro-agent-rules", "AGENTS.md"), "# rules\n");
  writeFileSync(path.join(dir, ".devpro-agent-rules", ".devpro", "scripts", "sync-agent-rules.mjs"), "// sync\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: mark as consumer repo"]);
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty, but consumer repo stays silent
  git(dir, ["add", "-A"]);

  const r = runHook(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.equal(r.json, null, `expected total silence in a consumer repo; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`);
});

test("T13 class A: a non-commit/non-push command → no advisory at all", () => {
  const dir = setupFixture();
  const r = runHook("ls -la", dir);
  assert.equal(r.json, null, `expected total silence for an unrelated command; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`);
});

// fix-eof-gate-cwd-blind-spot T13: NFR2 merged-output verification — when
// TWO class-B advisories fire on the SAME commit (Gate 3's chained-add gap
// and attribution's version-layer-skipped gap — no AGENTS.md in this
// fixture), `checkCommitAdvisories` (pre-existing `parts.join("\n\n---\n\n")`
// composite) MUST surface BOTH, not silently drop one via first-truthy-wins.
test("T13: two simultaneous class-B advisories on the same commit merge into a single `\\n\\n---\\n\\n`-joined block", () => {
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\n");

  const r = runHook(`git add -A && git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  const text = advisoryText(r.json);
  assert.match(text, /reason=stale-index-chained-add/, `expected Gate 3's advisory; got: ${text}`);
  assert.match(text, /reason=version-layer-skipped/, `expected attribution's advisory; got: ${text}`);
  assert.match(text, /\n\n---\n\n/, `expected the two advisories to be merged with the canonical separator; got: ${text}`);
});

// ─────────────────────────────────────────────────────────────────────────
// round-2 dp-reviewer S2: dedicated assertions for Gate 3's OWN `probe-failed`
// (x2 call sites) and `unexpected-error` (x1 call site) — previously
// zero-coverage per the round-2 exhaustive per-(gate x token) census (the
// existing `probe-failed` coverage was all in the ARCHIVE gate's own test
// file, a different gate). All three tests call `checkCommitEofRestage`
// directly (exported for tests, per the existing "Gate 3 (T3) exports"
// block) rather than going through `runHook`, so each exercises exactly the
// one call site under test without a second gate's own probe/throw
// interfering (the composite `checkCommitAdvisories` also runs
// `checkCommitAttribution` afterward, which is not defensively guarded
// against every malformed input the way Gate 3's own helpers are).
// ─────────────────────────────────────────────────────────────────────────

test("Commit EOF restage gate (S2): corrupted .git/index → numstat probe-failed advisory", () => {
  // Targets pre-tool-gate.mjs's numstat probe-failed return (checkCommitEofRestage,
  // the `numstatResult.status !== 0` branch right after the `git diff --cached
  // --numstat` spawn). A structurally invalid index file makes this specific
  // spawn fail (git: "index file smaller than expected") while `git rev-parse
  // --show-toplevel` (used by the earlier `isSourceRepo` gate) is unaffected —
  // it never reads the index — so this test reaches Gate 3's own numstat
  // probe rather than bailing out earlier via `isSourceRepo`'s fail-open path.
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty
  git(dir, ["add", "-A"]);
  writeFileSync(path.join(dir, ".git", "index"), "not-a-valid-git-index-file");

  const result = checkCommitEofRestage(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    result?.advisory || "",
    /reason=probe-failed/,
    `expected a named probe-failed advisory from the numstat probe; got: ${JSON.stringify(result)}`
  );
});

test("Commit EOF restage gate (S2): missing staged blob object → per-file probe-failed advisory", () => {
  // Targets pre-tool-gate.mjs's SECOND probe-failed return in
  // checkCommitEofRestage (the `changedFiles.length === 0 && probeFailures.length
  // > 0` branch, reached after the per-file loop). `git diff --cached
  // --numstat` only needs the INDEX (unaffected by a missing object), so it
  // still lists the file as changed; removing the staged blob's own loose
  // object then makes the per-file `git show :<file>` probe (the first
  // per-file git spawn) fail while `numstat` itself keeps succeeding —
  // landing in `probeFailures` with zero `changedFiles`, the exact shape
  // that fires this second probe-failed site rather than the numstat one
  // above.
  const dir = setupFixture();
  writeFileSync(path.join(dir, "notes.md"), "line one\n\n"); // EOF-dirty
  git(dir, ["add", "-A"]);
  const blobHash = git(dir, ["rev-parse", ":notes.md"]).stdout.trim();
  const objectPath = path.join(dir, ".git", "objects", blobHash.slice(0, 2), blobHash.slice(2));
  renameSync(objectPath, `${objectPath}.moved-away`);

  const result = checkCommitEofRestage(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    result?.advisory || "",
    /reason=probe-failed/,
    `expected a named probe-failed advisory from the per-file show probe; got: ${JSON.stringify(result)}`
  );
});

test("Commit EOF restage gate (finding 3): mixed outcome — one file succeeds, another probe-fails — surfaces BOTH, not just the success list", () => {
  // cross-model WARN (PR #2305, dispatch-8347ffa4) finding 3: when
  // changedFiles.length > 0 (at least one file succeeded), the old code
  // returned ONLY the success advisory, silently dropping any sibling
  // probeFailures file names. Two EOF-dirty staged files here: "ok.md"
  // keeps its blob object intact (normalizes + re-stages normally),
  // "broken.md"'s blob object is moved away so its per-file `git show`
  // probe fails — landing in probeFailures while changedFiles is non-empty.
  const dir = setupFixture();
  writeFileSync(path.join(dir, "ok.md"), "line one\n\n"); // EOF-dirty
  writeFileSync(path.join(dir, "broken.md"), "line two\n\n"); // EOF-dirty
  git(dir, ["add", "-A"]);
  const brokenBlobHash = git(dir, ["rev-parse", ":broken.md"]).stdout.trim();
  const objectPath = path.join(dir, ".git", "objects", brokenBlobHash.slice(0, 2), brokenBlobHash.slice(2));
  renameSync(objectPath, `${objectPath}.moved-away`);

  const result = checkCommitEofRestage(`git commit -m "${CLEAN_COMMIT_MSG}"`, dir);

  assert.match(
    result?.advisory || "",
    /ok\.md/,
    `expected the successfully re-staged file named in the advisory; got: ${JSON.stringify(result)}`
  );
  assert.match(
    result?.advisory || "",
    /broken\.md/,
    `expected the probe-failed file named in the SAME advisory, not silently dropped; got: ${JSON.stringify(result)}`
  );
  assert.match(
    result?.advisory || "",
    /probe-failed/,
    `expected the probe-failed reason token surfaced alongside the success text; got: ${JSON.stringify(result)}`
  );
});

test("Commit EOF restage gate (S2): non-string baseCwd under an explicit relative `cd` → unexpected-error advisory", () => {
  // Targets pre-tool-gate.mjs's catch-all UNEXPECTED_ERROR return in
  // checkCommitEofRestage. Every git-probe failure inside this gate is
  // checked via `.status`, and every helper Gate 3 calls
  // (`gateCommandSegmentText`, `isSourceRepo`, …) is itself defensively
  // fail-open — so a malformed `cmd`/`baseCwd` alone does not reach Gate 3's
  // own catch-all UNLESS the throw happens BEFORE the fail-open
  // `isSourceRepo` gate runs. `commandCwdForGitMatch` → `effectiveCdCwd`
  // (hook-command-context.mjs) resolves an explicit `cd <relative-path> &&`
  // prefix via `path.resolve(baseCwd, target)` with NO enclosing try/catch
  // of its own, and this call happens BEFORE Gate 3's `isSourceRepo` check —
  // so a non-string `baseCwd` (here a number, which passes the earlier
  // `!baseCwd` falsy guard since a truthy number is not "absent") makes
  // `path.resolve` throw a real TypeError that propagates up into Gate 3's
  // own try/catch, exercising the actual fail-open branch rather than a
  // mocked one. No git repo fixture is needed: the throw happens before any
  // filesystem/git access.
  //
  // Disclosure (same shape as this gate's own `base-cwd-absent` sibling
  // test above): `baseCwd = 42` is NOT a value production can ever hand this
  // gate — `toolInputCwd()` (hook-command-context.mjs) always returns a
  // string, so this exercises Gate 3's defensive catch-all with an
  // out-of-contract argument type (mirroring the ledger family's `cmd=null`
  // technique in rule-load-session-ledger-hook.test.mjs's F2 tests), not a
  // shape any real PreToolUse payload can currently produce.
  const result = checkCommitEofRestage(`cd some-relative-dir && git commit -m "${CLEAN_COMMIT_MSG}"`, 42);

  assert.match(
    result?.advisory || "",
    /reason=unexpected-error/,
    `expected a named unexpected-error advisory; got: ${JSON.stringify(result)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// fix-silent-gate-skip R1: newline + && mix must resolve linked-worktree cwd
// ─────────────────────────────────────────────────────────────────────────

function setupLinkedWorktreeFixture() {
  const main = setupFixture();
  writeFileSync(path.join(main, "AGENTS.md"), "版本：6.82.1\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "agents"]);
  const wt = path.join(tmpRoot, `wt-silent-${counter++}`);
  git(main, ["worktree", "add", "-q", "-b", `chore/wt-silent-${counter}`, wt, "chore/fixture"]);
  markSourceCheckout(wt);
  writeFileSync(path.join(wt, "AGENTS.md"), "版本：6.82.1\n");
  return { main, wt };
}

test("fix-silent-gate-skip R1: cd <wt>\\n git add -A && git commit <<EOF → NOT cwd-not-a-git-worktree / version-layer-skipped empty-skip", () => {
  const { main, wt } = setupLinkedWorktreeFixture();
  writeFileSync(path.join(wt, "notes.md"), "line one\nline two\n");
  const cmd =
    `cd ${wt}\n` +
    `git add -A && git commit -m "$(cat <<'EOF'\n${CLEAN_COMMIT_MSG}\nEOF\n)"`;

  const r = runHook(cmd, main);
  const text = advisoryText(r.json);
  assert.doesNotMatch(
    text,
    /reason=cwd-not-a-git-worktree/,
    `newline+&& mix must not empty-skip as cwd-not-a-git-worktree; got: ${text}`
  );
  assert.doesNotMatch(
    text,
    /reason=version-layer-skipped/,
    `newline+&& mix must not empty-skip as version-layer-skipped; got: ${text}`
  );
  // Chained add still surfaces a real Gate3 reason (stale-index), proving the
  // gate ran against the resolved worktree cwd rather than skipping.
  assert.match(
    text,
    /reason=stale-index-chained-add|已自動移除 staged EOF|Commit-time EOF/,
    `expected a real Gate3 outcome after cwd resolve; got: ${text}`
  );
});

test("fix-silent-gate-skip R1: true UNRESOLVABLE (pipe) → cwd-parse-unresolvable, not cwd-not-a-git-worktree", () => {
  const { main, wt } = setupLinkedWorktreeFixture();
  writeFileSync(path.join(wt, "notes.md"), "line one\n");
  git(wt, ["add", "-A"]);
  const cmd = `cd ${wt} | true; git commit -m "${CLEAN_COMMIT_MSG}"`;
  const r = runHook(cmd, main);
  const text = advisoryText(r.json);
  assert.match(text, /reason=cwd-parse-unresolvable/, `got: ${text}`);
  assert.doesNotMatch(text, /reason=cwd-not-a-git-worktree/, `got: ${text}`);
});

test("fix-silent-gate-skip R1: pushd <wt>\\n git commit resolves worktree (statement-internal chdir)", () => {
  const { main, wt } = setupLinkedWorktreeFixture();
  writeFileSync(path.join(wt, "notes.md"), "line one\n\n"); // EOF-dirty
  git(wt, ["add", "-A"]);
  const cmd = `pushd ${wt}\ngit commit -m "${CLEAN_COMMIT_MSG}"`;
  const r = runHook(cmd, main);
  const text = advisoryText(r.json);
  assert.doesNotMatch(text, /reason=cwd-not-a-git-worktree|reason=cwd-parse-unresolvable|reason=version-layer-skipped/);
  assert.match(
    text,
    /已自動移除 staged EOF|Commit-time EOF/,
    `pushd+newline commit must run EOF restage in worktree; got: ${text}`
  );
});

test("fix-silent-gate-skip R1: pushd/popd unwind restores prior cwd tracking", () => {
  const { main, wt } = setupLinkedWorktreeFixture();
  writeFileSync(path.join(main, "root-notes.md"), "root\n\n");
  git(main, ["add", "root-notes.md"]);
  // pushd into wt then popd back — commit should target main (base), not wt.
  const cmd = `pushd ${wt} && popd\ngit commit -m "${CLEAN_COMMIT_MSG}"`;
  const r = runHook(cmd, main);
  const text = advisoryText(r.json);
  assert.doesNotMatch(text, /reason=cwd-parse-unresolvable|reason=cwd-not-a-git-worktree/);
  assert.match(
    text,
    /已自動移除 staged EOF|Commit-time EOF/,
    `after popd, commit cwd must be main and EOF gate must run; got: ${text}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Hub session (r13 F3 of PR #3702): the hub and the target are separate repositories with different identities, and
// each holds an EOF-dirty staged file. Source eligibility and the re-stage must both follow the commit's target: only
// a source target is normalized, and the hub's own index is never touched.
// ─────────────────────────────────────────────────────────────────────────

function setupPlainRepository() {
  const work = path.join(tmpRoot, `plain with space-${counter++}`);
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "core.autocrlf", "false"]);
  git(work, ["config", "user.email", "t@t.com"]);
  git(work, ["config", "user.name", "t"]);
  writeFileSync(path.join(work, "README.md"), "plain\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);
  git(work, ["checkout", "-q", "-b", "chore/fixture"]);
  git(work, ["remote", "add", "origin", "https://github.com/example-org/plain-app.git"]);
  return work;
}

// The hub stages other text than the target (PR #3703 r10 W4-F1), so a gate that read the hub's staged blob and wrote
// it to the target's index leaves the target with the hub's text.
function stageDirty(cwd, text = "line one\nline two\n") {
  writeFileSync(path.join(cwd, "notes.md"), `${text}\n`);
  git(cwd, ["add", "notes.md"]);
  return stagedBlobHash(cwd, "notes.md");
}

test("Commit EOF restage gate (hub): a source hub committing into a plain repository leaves both indexes untouched", () => {
  const hub = setupFixture();
  const target = setupPlainRepository();
  const hubBlob = stageDirty(hub, "hub text\n");
  const targetBlob = stageDirty(target);
  assert.equal(checkCommitEofRestage(`git -C "${target}" commit -m "${CLEAN_COMMIT_MSG}"`, hub), null);
  assert.equal(stagedBlobHash(target, "notes.md"), targetBlob, "a plain target is not the source: its staged blob stays");
  assert.equal(stagedBlobHash(hub, "notes.md"), hubBlob, "the hub's index is not the commit's index");
});

test("Commit EOF restage gate (hub): a plain hub committing into the source normalizes only the source", () => {
  const hub = setupPlainRepository();
  const target = setupFixture({ spaced: true });
  const hubBlob = stageDirty(hub, "hub text\n");
  const targetBlob = stageDirty(target);
  const result = checkCommitEofRestage(`git -C "${target}" commit -m "${CLEAN_COMMIT_MSG}"`, hub);
  assert.match(advisoryText(result), /已自動移除 staged EOF 空行並 re-stage/, JSON.stringify(result));
  assert.notEqual(stagedBlobHash(target, "notes.md"), targetBlob, "the source target's staged blob is normalized");
  assert.equal(stagedContent(target, "notes.md"), "line one\nline two\n");
  assert.equal(stagedBlobHash(hub, "notes.md"), hubBlob, "the plain hub's index is not touched");
});

// The same two directions through the whole hook, run from the hub's working directory: the dispatcher hands the gate
// the commit's checkout, not the hub (PR #3703 r9 W4-F1).
test("Commit EOF restage gate (hub, whole hook): the dispatcher re-stages only a source target, never the hub", () => {
  const sourceHub = setupFixture();
  const plainTarget = setupPlainRepository();
  const sourceHubBlob = stageDirty(sourceHub, "hub text\n");
  const plainTargetBlob = stageDirty(plainTarget);
  // Each commit carries the repo-scope approval of its target, so the repo scope gate lets it through to this gate.
  const toPlain = runHook(`DEVPRO_REPO_SCOPE_APPROVED=plain-app git -C "${plainTarget}" commit -m "${CLEAN_COMMIT_MSG}"`, sourceHub);
  assert.notEqual(toPlain.json?.decision, "block", JSON.stringify(toPlain.json));
  assert.doesNotMatch(advisoryText(toPlain.json), /已自動移除 staged EOF 空行並 re-stage/, JSON.stringify(toPlain.json));
  assert.equal(stagedBlobHash(plainTarget, "notes.md"), plainTargetBlob, "a plain target keeps its staged blob");
  assert.equal(stagedBlobHash(sourceHub, "notes.md"), sourceHubBlob, "the source hub's index is not the commit's index");

  const plainHub = setupPlainRepository();
  const sourceTarget = setupFixture({ spaced: true });
  const plainHubBlob = stageDirty(plainHub, "hub text\n");
  const sourceTargetBlob = stageDirty(sourceTarget);
  const toSource = runHook(`DEVPRO_REPO_SCOPE_APPROVED=devpro-agent-rules git -C "${sourceTarget}" commit -m "${CLEAN_COMMIT_MSG}"`, plainHub);
  assert.notEqual(toSource.json?.decision, "block", JSON.stringify(toSource.json));
  assert.match(advisoryText(toSource.json), /已自動移除 staged EOF 空行並 re-stage/, JSON.stringify(toSource.json));
  assert.notEqual(stagedBlobHash(sourceTarget, "notes.md"), sourceTargetBlob, "the source target is normalized");
  assert.equal(stagedContent(sourceTarget, "notes.md"), "line one\nline two\n", "the source target keeps its own text");
  assert.equal(stagedBlobHash(plainHub, "notes.md"), plainHubBlob, "the plain hub's index is not touched");
});
