/**
 * normalize-eof.test.mjs
 *
 * TDD test suite for normalize-eof.mjs.
 *
 * Uses synthetic tmp-file fixtures — does NOT depend on live specs (which may
 * all be clean and cannot serve as dirty samples).  Every test is isolated via
 * os.tmpdir() scratch files that are cleaned up after each case.
 *
 * EOF "dirty" definition is SSOT-locked to spec-eof-newline-grep.test.mjs:
 *   dirty if EITHER
 *     (a) !content.endsWith("\n")
 *     (b) lastLine (after stripping single trailing \r?\n$) is blank/whitespace
 *   T6 (synonym lock) re-applies that exact logic inline to prove byte-for-byte
 *   parity between fixer output and grep guard expectations.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixerPath = path.resolve(scriptDir, "../normalize-eof.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(content) {
  const dir = makeTempDir("normalize-eof-test-");
  const file = path.join(dir, "spec.md");
  writeFileSync(file, content, { encoding: "utf8" });
  return { dir, file };
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scanFilesForNeedle(dir, relativeFiles, needle) {
  const hits = [];
  for (const relativeFile of relativeFiles) {
    const lines = readFileSync(path.join(dir, relativeFile), "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.includes(needle)) hits.push(`${relativeFile}:${index + 1}:${line}`);
    }
  }
  return hits;
}

/** Run the fixer CLI via spawnSync and return { status, stdout, stderr }. */
function runFixer(args) {
  const result = spawnSync(process.execPath, [fixerPath, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Inline re-implementation of the grep guard dirty check
 * (SSOT: spec-eof-newline-grep.test.mjs lines ~62-86).
 * Returns true if the content is dirty (would fail the grep guard).
 */
function isDirtyPerGrepGuard(content) {
  if (!content.endsWith("\n")) return true;
  const withoutFinalNewline = content.replace(/\r?\n$/, "");
  const lastLine = withoutFinalNewline.slice(
    withoutFinalNewline.lastIndexOf("\n") + 1,
  );
  return !(lastLine.trim() !== "" || withoutFinalNewline === "");
}

// ---------------------------------------------------------------------------
// T1: --fix collapses LF blank lines at EOF
// ---------------------------------------------------------------------------
test("T1: --fix removes trailing blank LF lines", () => {
  const { dir, file } = makeTmp("# Spec\nbody\n\n");
  try {
    const { status } = runFixer(["--fix", file]);
    assert.equal(status, 0, "--fix should exit 0");

    const result = readFileSync(file, "utf8");
    assert.equal(result, "# Spec\nbody\n", "should collapse to single trailing LF");
    assert.ok(result.endsWith("\n"), "must end with \\n");
    assert.ok(!result.endsWith("\n\n"), "must not end with \\n\\n");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T2: --fix handles CRLF and whitespace-only trailing lines
// ---------------------------------------------------------------------------
test("T2a: --fix collapses CRLF blank at EOF", () => {
  const { dir, file } = makeTmp("# Spec\r\nbody\r\n\r\n");
  try {
    const { status } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.ok(result.endsWith("\n"), "must end with \\n");
    assert.ok(!isDirtyPerGrepGuard(result), "result must pass grep guard");
  } finally {
    cleanup(dir);
  }
});

test("T2b: --fix collapses whitespace-only trailing line (spaces)", () => {
  const { dir, file } = makeTmp("# Spec\nbody\n \n");
  try {
    const { status } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.ok(result.endsWith("\n"), "must end with \\n");
    assert.ok(!isDirtyPerGrepGuard(result), "result must pass grep guard");
  } finally {
    cleanup(dir);
  }
});

test("T2c: --fix collapses whitespace-only trailing line (tabs)", () => {
  const { dir, file } = makeTmp("# Spec\nbody\n\t\n");
  try {
    const { status } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.ok(result.endsWith("\n"), "must end with \\n");
    assert.ok(!isDirtyPerGrepGuard(result), "result must pass grep guard");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T3: idempotent / no-op on already-clean files
// ---------------------------------------------------------------------------
test("T3: --fix is idempotent on clean file (no change, no output)", () => {
  const original = "# Spec\nbody\n";
  const { dir, file } = makeTmp(original);
  try {
    const { status, stdout } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.equal(result, original, "clean file must be byte-identical after --fix");
    assert.ok(!stdout.includes(file), "clean file must NOT appear in stdout (no-op)");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T4: --fix adds missing trailing newline
// ---------------------------------------------------------------------------
test("T4: --fix adds missing trailing newline", () => {
  const { dir, file } = makeTmp("# Spec\nbody");
  try {
    const { status } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.equal(result, "# Spec\nbody\n", "missing newline must be added");
    assert.ok(result.endsWith("\n"));
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T5: --check mode
// ---------------------------------------------------------------------------
test("T5a: --check exits 1 and prints offender to stderr for dirty file", () => {
  const { dir, file } = makeTmp("# Spec\nbody\n\n");
  try {
    const { status, stderr } = runFixer(["--check", file]);
    assert.equal(status, 1, "--check must exit 1 for dirty file");
    assert.ok(stderr.includes(file), "stderr must contain offender path");

    // file must NOT be modified
    const result = readFileSync(file, "utf8");
    assert.equal(result, "# Spec\nbody\n\n", "--check must not write the file");
  } finally {
    cleanup(dir);
  }
});

test("T5b: --check exits 0 for clean file", () => {
  const { dir, file } = makeTmp("# Spec\nbody\n");
  try {
    const { status, stderr } = runFixer(["--check", file]);
    assert.equal(status, 0, "--check must exit 0 for clean file");
    assert.ok(!stderr.includes(file), "clean file must not appear in stderr");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T6: Synonym lock — fixer output passes grep guard byte-for-byte (both directions)
// ---------------------------------------------------------------------------
test("T6a: dirty→fix→guard-clean (forward direction)", () => {
  const dirtyInputs = [
    "# Spec\nbody\n\n",           // LF blank
    "# Spec\r\nbody\r\n\r\n",     // CRLF
    "# Spec\nbody\n \n",           // whitespace-only line
    "# Spec\nbody\n\t\n",          // tab-only line
    "# Spec\nbody",               // missing trailing newline
  ];

  for (const input of dirtyInputs) {
    const { dir, file } = makeTmp(input);
    try {
      // Verify input is actually dirty per grep guard
      assert.ok(isDirtyPerGrepGuard(input), `fixture should be dirty: ${JSON.stringify(input)}`);

      const { status } = runFixer(["--fix", file]);
      assert.equal(status, 0, `--fix must exit 0 for: ${JSON.stringify(input)}`);

      const fixed = readFileSync(file, "utf8");
      assert.ok(
        !isDirtyPerGrepGuard(fixed),
        `after --fix, output must pass grep guard for input: ${JSON.stringify(input)}\nGot: ${JSON.stringify(fixed)}`,
      );
    } finally {
      cleanup(dir);
    }
  }
});

test("T6b: guard-clean CRLF file — fixer does NOT modify bytes (reverse direction lock)", () => {
  // A CRLF file whose last content line is non-blank is guard-clean.
  // The fixer must return the content byte-for-byte unchanged (no \r stripping).
  const cleanCrlf = "# Spec\r\nbody\r\n";
  assert.ok(!isDirtyPerGrepGuard(cleanCrlf), "fixture must be guard-clean");

  const { dir, file } = makeTmp(cleanCrlf);
  try {
    const { status, stdout } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.equal(result, cleanCrlf, "guard-clean CRLF file must be byte-identical after --fix");
    assert.ok(!stdout.includes(file), "guard-clean file must NOT appear in stdout (no-op)");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T7: --fix prints "fixed: <path>" for changed files
// ---------------------------------------------------------------------------
test("T7: --fix prints fixed: <path> for dirty file, not for clean file", () => {
  const { dir: dirDirty, file: fileDirty } = makeTmp("# Spec\nbody\n\n");
  const { dir: dirClean, file: fileClean } = makeTmp("# Spec\nbody\n");
  try {
    const { status, stdout } = runFixer(["--fix", fileDirty, fileClean]);
    assert.equal(status, 0);
    assert.ok(stdout.includes(`fixed: ${fileDirty}`), "dirty file must appear in stdout");
    assert.ok(!stdout.includes(`fixed: ${fileClean}`), "clean file must NOT appear in stdout");
  } finally {
    cleanup(dirDirty);
    cleanup(dirClean);
  }
});

// ---------------------------------------------------------------------------
// T8: mid-file blank lines are preserved — only trailing blanks are collapsed
// ---------------------------------------------------------------------------
test("T8: mid-file blank lines preserved, only trailing blank collapsed", () => {
  // Two mid-file blank lines must survive; only the trailing \n\n is collapsed.
  const input = "# H\n\npara\n\nmore\n\n";
  const expected = "# H\n\npara\n\nmore\n";

  const { dir, file } = makeTmp(input);
  try {
    const { status } = runFixer(["--fix", file]);
    assert.equal(status, 0);

    const result = readFileSync(file, "utf8");
    assert.equal(result, expected, "mid-file blank lines must be preserved");

    // Both mid-file blank lines still present
    assert.ok(result.includes("\n\npara"), "first mid-file blank line preserved");
    assert.ok(result.includes("\n\nmore"), "second mid-file blank line preserved");
    // Trailing is clean
    assert.ok(!result.endsWith("\n\n"), "trailing double-newline must be collapsed");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// T1 (prove-it, fix-t9-grep-worktree-pollution): naive `grep -rn` recursive
// scan over a directory tree is polluted by non-tracked content (e.g. a
// `.worktree/`-style linked checkout, or a gitignored scratch file) that
// happens to contain the old-filename literal, while a `git ls-files`-driven
// scan (scoped to tracked files only) is immune to that pollution.
//
// This is a strategy-comparison regression test, not an invocation of the
// real T9 (T9 always scans the live repoRoot, which cannot be sandboxed here
// without side effects). Both strategies below are exercised against the
// exact same synthetic "polluted worktree" fixture so the RED/GREEN contrast
// directly demonstrates the defect and its fix.
// ---------------------------------------------------------------------------

/**
 * Naive strategy (the pre-fix T9 behavior): recursively grep the whole
 * directory tree for `needle`, regardless of whether files are tracked by
 * git. Mirrors the original `grep -rn "${needle}" --include=... "${dir}"`.
 */
function naiveRecursiveGrepStrategy(dir, needle) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && /\.(?:md|mjs)$/.test(entry.name)) {
        files.push(path.relative(dir, absolute));
      }
    }
  };
  visit(dir);
  return scanFilesForNeedle(dir, files, needle);
}

/**
 * git-ls-files-driven strategy (the fix): only scan files tracked by git in
 * `dir` (a real git worktree). Untracked pollution (e.g. a nested `.worktree/`
 * checkout, or a gitignored scratch file) is never visited because it never
 * appears in `git ls-files` output.
 */
function gitLsFilesGrepStrategy(dir, needle) {
  const lsOutput = git(dir, ["ls-files", "-z", "--", "*.md", "*.mjs"]);
  const files = lsOutput.split("\0").filter((f) => f !== "");

  return scanFilesForNeedle(dir, files, needle);
}

test("T1 (prove-it): naive grep -rn hits untracked pollution, git-ls-files scan does not", () => {
  const oldName = "normalize" + "-spec-eof"; // runtime-built so this literal isn't itself a "reference"

  // Build a real git worktree (tracked content only mentions the current,
  // renamed filename) that also has an *untracked* polluting file — mimicking
  // a `.worktree/`-style leftover checkout or a gitignored scratch note that
  // still contains the old-filename literal.
  const repoDir = makeTempDir("t9-prove-it-repo-");
  try {
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);

    // Tracked file: clean, references only the current filename.
    const trackedFile = path.join(repoDir, "clean.md");
    writeFileSync(trackedFile, "# Clean\nuses normalize-eof only\n", "utf8");
    git(repoDir, ["add", "clean.md"]);
    git(repoDir, ["commit", "-q", "-m", "init"]);

    // Untracked pollution: a nested dir (simulating `.worktree/`) containing
    // a file with the stale literal, never added to git.
    const pollutionDir = path.join(repoDir, ".worktree", "leftover");
    mkdirSync(pollutionDir, { recursive: true });
    const pollutionFile = path.join(pollutionDir, "stale.md");
    writeFileSync(pollutionFile, `references ${oldName} here\n`, "utf8");

    // RED (defect reproduced): naive recursive grep walks into the untracked
    // pollution and reports a stale hit.
    const naiveHits = naiveRecursiveGrepStrategy(repoDir, oldName);
    assert.ok(
      naiveHits.some((line) => line.includes("stale.md")),
      `naive strategy should hit untracked pollution (defect reproduced); got: ${JSON.stringify(naiveHits)}`,
    );

    // GREEN (defect fixed): git-ls-files-driven scan only visits tracked
    // files, so the untracked pollution is invisible and there are no hits.
    const gitLsHits = gitLsFilesGrepStrategy(repoDir, oldName);
    assert.equal(
      gitLsHits.length,
      0,
      `git-ls-files strategy must not see untracked pollution; got: ${JSON.stringify(gitLsHits)}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

/**
 * Mirrors T9's openspec/changes/** exclusion filter exactly (archive OR any
 * active/in-progress change directory is excluded as a discussion artifact,
 * not a live production reference). Operates on absolute-path grep hit lines
 * ("path:line:content") and — like T9 — tests only the PATH segment (before
 * the first ":"), never the whole line, so a hit whose CONTENT quotes an
 * openspec/changes/ path is not false-negatively excluded.
 */
function pathOfHitLine(line) {
  return line.match(/^(.*?):\d+:/)?.[1] ?? line;
}

function filterOutChangesDocDiscussion(hitLines) {
  const pathOf = pathOfHitLine;
  return hitLines
    .filter((line) => !pathOf(line).includes(`${path.sep}openspec${path.sep}changes${path.sep}archive${path.sep}`))
    .filter((line) => {
      const marker = `${path.sep}openspec${path.sep}changes${path.sep}`;
      const idx = pathOf(line).indexOf(marker);
      if (idx === -1) return true;
      const afterMarker = pathOf(line).slice(idx + marker.length);
      const isActiveChangeDir = afterMarker !== "" && !afterMarker.startsWith(`archive${path.sep}`);
      return !isActiveChangeDir;
    });
}

test("T1b (prove-it): generalized this-change filter excludes any active change dir, still detects real stale refs outside openspec/changes/", () => {
  const oldName = "normalize" + "-spec-eof"; // runtime-built so this literal isn't itself a "reference"

  const repoDir = makeTempDir("t9-prove-it-changes-filter-");
  try {
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);

    // (a) An active/in-progress change dir (NOT the hardcoded old change
    // name, and NOT under archive/) whose own proposal doc discusses the
    // rename and legitimately contains the old-filename literal.
    const activeChangeDir = path.join(
      repoDir,
      "openspec",
      "changes",
      "some-other-active-change",
    );
    mkdirSync(activeChangeDir, { recursive: true });
    writeFileSync(
      path.join(activeChangeDir, "proposal.md"),
      `discusses the old name ${oldName} as part of a rename write-up\n`,
      "utf8",
    );

    // (b) A real live doc OUTSIDE openspec/changes/ that still references the
    // old filename — this must remain detectable (no regression in detection
    // power from generalizing the filter).
    const liveDocDir = path.join(repoDir, "docs");
    mkdirSync(liveDocDir, { recursive: true });
    writeFileSync(
      path.join(liveDocDir, "live.md"),
      `stale live reference to ${oldName} outside any change dir\n`,
      "utf8",
    );

    // (c) A real live doc OUTSIDE openspec/changes/ whose matched CONTENT also
    // quotes an ABSOLUTE openspec/changes/<active>/ path (leading path.sep so
    // it contains the exact `${sep}openspec${sep}changes${sep}` marker the
    // filter keys on). The exclusion filter must test the PATH segment only, so
    // this genuine stale reference is still detected — testing the whole
    // `path:line:content` line would false-negatively drop it because the
    // content mentions an active-change path.
    const embeddedActivePath = `${path.sep}repo${path.sep}openspec${path.sep}changes${path.sep}some-other-active-change${path.sep}proposal.md`;
    writeFileSync(
      path.join(liveDocDir, "cross-ref.md"),
      `see ${embeddedActivePath} — still uses ${oldName} here\n`,
      "utf8",
    );

    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);

    const rawHits = gitLsFilesGrepStrategy(repoDir, oldName).map((line) => {
      const sepIndex = line.indexOf(":");
      const relPath = line.slice(0, sepIndex);
      const rest = line.slice(sepIndex);
      return `${path.resolve(repoDir, relPath)}${rest}`;
    });

    const filteredHits = filterOutChangesDocDiscussion(rawHits);

    // GREEN direction: the active-change-dir doc itself (its PATH) must be
    // excluded. Match on the path segment (before the first ":"), not the whole
    // line — case (c)'s content legitimately mentions the active-change dir
    // name, and that content mention must NOT count as an exclusion.
    assert.ok(
      !filteredHits.some((line) => pathOfHitLine(line).includes(`some-other-active-change${path.sep}proposal.md`)),
      `active change dir doc (by path) must be excluded by generalized filter; got: ${JSON.stringify(filteredHits)}`,
    );

    // RED direction (detection power preserved): the real live doc outside
    // openspec/changes/ must still be detected.
    assert.ok(
      filteredHits.some((line) => line.includes(`${path.sep}docs${path.sep}live.md`)),
      `real stale reference outside openspec/changes/ must still be detected; got: ${JSON.stringify(filteredHits)}`,
    );

    // RED direction (content-embedded-path edge): a stale ref outside
    // openspec/changes/ whose CONTENT quotes an active-change path must still
    // be detected — proves the filter tests the path segment, not the whole
    // line (guards against the false-negative codex cross-review flagged).
    assert.ok(
      filteredHits.some((line) => line.includes(`${path.sep}docs${path.sep}cross-ref.md`)),
      `stale ref whose content quotes an openspec/changes/ path must still be detected (path-segment filtering); got: ${JSON.stringify(filteredHits)}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("T1c (prove-it): single-file grep hit still carries a path prefix (-H boundary)", () => {
  const oldName = "normalize" + "-spec-eof"; // runtime-built so this literal isn't itself a "reference"

  const repoDir = makeTempDir("t9-prove-it-single-file-");
  try {
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);

    // Exactly ONE tracked .md/.mjs file, and it is the sole match — so grep
    // receives a single file arg. Without -H, grep omits the path prefix and
    // emits a bare `line:content`; the path-splitting map in T9 would then
    // slice the line number as if it were the path and path.resolve() would
    // corrupt the hit. -H forces `path:line:content` even for one file, which
    // this test locks in.
    writeFileSync(
      path.join(repoDir, "only.md"),
      `the sole tracked file references ${oldName} once\n`,
      "utf8",
    );
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);

    const hits = gitLsFilesGrepStrategy(repoDir, oldName);
    assert.equal(hits.length, 1, `expected exactly one hit; got: ${JSON.stringify(hits)}`);

    // The hit must begin with the file path, not a bare line number. Applying
    // T9's own path-splitting to it must recover `only.md` — proving the -H
    // prefix survived the single-file boundary.
    const line = hits[0];
    const sepIndex = line.indexOf(":");
    const relPath = line.slice(0, sepIndex);
    assert.equal(
      relPath,
      "only.md",
      `single-file grep hit must be prefixed with the path (got relPath=${JSON.stringify(relPath)} from line=${JSON.stringify(line)})`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T9: reference-integrity lock — no live doc/script still references the old
// filename (normalize-spec-eof). Excludes archived openspec changes (historical
// record) and ANY active/in-progress change's own docs (proposal/tasks/notes
// that discuss the rename itself — not hardcoded to this change's directory).
// This test is EXPECTED to be RED until every live reference is
// updated (tracked as a separate task in this change) — that is the point:
// it proves the rename is actually complete repo-wide, not just locally.
// ---------------------------------------------------------------------------
test("T9: no live .md/.mjs reference to the old filename normalize-spec-eof remains", () => {
  const oldName = "normalize" + "-spec-eof"; // built at runtime so this literal isn't itself a "reference"

  // Scan only git-tracked *.md/*.mjs files (not a raw recursive repoRoot walk)
  // so untracked working-tree pollution — linked `.worktree/` checkouts,
  // gitignored scratch notes — can never produce a false stale hit.
  // See openspec/changes/fix-t9-grep-worktree-pollution/proposal.md Decision D1.
  const lsOutput = git(REPO_ROOT, ["ls-files", "-z", "--", "*.md", "*.mjs"]);
  const relFiles = lsOutput
    .split("\0")
    .filter((f) => f !== "")
    // During archive, git ls-files still reports tracked active-change files
    // that are deleted in the working tree. They are not live references and
    // passing them to grep makes grep fail with status 2.
    .filter((f) => existsSync(path.join(REPO_ROOT, f)));

  const stdout = scanFilesForNeedle(REPO_ROOT, relFiles, oldName).join("\n");

  // grep -nH prints `path:line:content` with paths relative to cwd (repoRoot).
  // Split each hit into its path segment (before the first ":") and keep the
  // full raw line for the failure report. ALL exclusion filters below test the
  // PATH segment only — never the whole `path:line:content` string — so that a
  // live file OUTSIDE openspec/changes/ whose matched CONTENT happens to quote
  // an absolute /openspec/changes/<dir>/ path is NOT false-negatively excluded
  // (that would silently drop a genuine stale reference and defeat the lock).
  // Paths are resolved to absolute so the existing filter/self-exclude literals
  // (built against absolute path segments) keep working unchanged.
  const thisFile = fileURLToPath(import.meta.url);
  const hits = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const sepIndex = line.indexOf(":");
      const relPath = line.slice(0, sepIndex);
      const absPath = path.resolve(REPO_ROOT, relPath);
      return { path: absPath, raw: `${absPath}${line.slice(sepIndex)}` };
    })
    // Any openspec/changes/** document — archived (historical record) or
    // active/in-progress (this change's own proposal/tasks/notes discussing
    // the rename itself) — is excluded as a discussion artifact, not a live
    // production reference. The active-change branch is intentionally NOT
    // hardcoded to a single change directory name: any current or future
    // in-progress change that discusses the old filename in its own docs is
    // excluded the same way, without needing a filter update per change.
    .filter((hit) => !hit.path.includes(`${path.sep}openspec${path.sep}changes${path.sep}archive${path.sep}`))
    .filter((hit) => {
      const marker = `${path.sep}openspec${path.sep}changes${path.sep}`;
      const idx = hit.path.indexOf(marker);
      if (idx === -1) return true; // path not under openspec/changes/ at all — keep as a real hit
      const afterMarker = hit.path.slice(idx + marker.length);
      const isActiveChangeDir = afterMarker !== "" && !afterMarker.startsWith(`archive${path.sep}`);
      return !isActiveChangeDir; // drop active-change-dir hits; archive already handled above
    })
    .filter((hit) => hit.path !== thisFile);

  assert.equal(
    hits.length,
    0,
    `found live reference(s) to old filename "${oldName}" outside archive/any active change's own docs:\n${hits.map((h) => h.raw).join("\n")}`,
  );
});
