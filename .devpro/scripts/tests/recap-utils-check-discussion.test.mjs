/**
 * recap-utils-check-discussion.test.mjs
 *
 * Tests for checkDiscussionExists() behavior in recap-utils.mjs:
 *   Local "recap-written" marker lookup (zero-network, sync fs) — replaces the
 *   former GraphQL discussion-pagination scan (F6/F7 #471/#472), which timed
 *   out the UserPromptSubmit hook (30s) scanning hundreds of Discussions.
 *
 * Strategy: Each test uses `DEVPRO_RECAP_WRITTEN_DIR` (env override, see
 * recap-utils.mjs RECAP_WRITTEN_DIR) pointed at an isolated tmp dir, then
 * spawns a Node.js subprocess that imports recap-utils.mjs and exercises
 * checkDiscussionExists() via evaluateMergedRecapPending() (which calls
 * checkDiscussionExists internally). Marker presence/absence is asserted via
 * plain fs — no network, no fake `gh` spawn needed for the marker-read path
 * itself. RW-4 keeps a fake `gh` counter to prove zero `gh` calls occur.
 *
 * Test matrix: RD-1..RD-3, RD-6 (adapted to marker semantics) + RW-1..RW-6.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECAP_UTILS = pathToFileURL(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/lib/recap-utils.mjs"
)).href;

// All temp dirs created by tests — cleaned up in after()
const allTmpDirs = [];

function makeTmpDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  allTmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const d of allTmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/**
 * Create a fake gh binary in `dir/gh` that increments a call counter at
 * `dir/call-count` on every invocation, then exits non-zero (so any
 * accidental call is both counted and would fail-open if relied upon).
 */
function makeFakeGh(dir) {
  const counterPath = `${dir}/call-count`;
  const callsPath = `${dir}/calls.log`;
  writeFileSync(counterPath, "0");
  writeFileSync(callsPath, "");
  const script = `#!/bin/sh
COUNT=$(cat "${counterPath}" 2>/dev/null || echo 0)
NEXT=$((COUNT + 1))
echo "$NEXT" > "${counterPath}"
echo "$*" >> "${callsPath}"
exit 1
`;
  const ghPath = `${dir}/gh`;
  writeFileSync(ghPath, script);
  chmodSync(ghPath, 0o755);
  return { ghPath, counterPath, callsPath };
}

function ensureFakeGitBranchExists(dir, branch) {
  const gitPath = `${dir}/git`;
  if (existsSync(gitPath)) return;
  writeFileSync(
    gitPath,
    `#!/bin/sh
if [ "$1" = "branch" ] && [ "$2" = "--list" ]; then
  printf '%s\n' "$3"
  exit 0
fi
exit 1
`
  );
  chmodSync(gitPath, 0o755);
}

/**
 * Run a small Node.js probe that:
 *  1. Writes a recap-pending marker for `branch`
 *  2. Calls evaluateMergedRecapPending()
 *  3. Prints JSON result to stdout
 *
 * `fakeGhDir` is prepended to PATH so the fake `gh` script is used (proving
 * checkDiscussionExists never shells out). Isolated
 * DEVPRO_RECAP_PENDING_DIR / DEVPRO_RECAP_STATE_DIR / DEVPRO_RECAP_WRITTEN_DIR
 * per call.
 */
function runProbe({ branch, fakeGhDir, writtenDir, env = {} }) {
  ensureFakeGitBranchExists(fakeGhDir, branch);

  const pendingDir = makeTmpDir("rd-pending-");
  const stateDir = makeTmpDir("rd-state-");
  const resolvedWrittenDir = writtenDir ?? makeTmpDir("rd-written-");

  // Write the marker before spawning so evaluateMergedRecapPending sees it
  mkdirSync(pendingDir, { recursive: true });
  const sanitized = branch.replace(/\//g, "_");
  writeFileSync(path.join(pendingDir, sanitized), String(Date.now()));

  const probe = `
import { evaluateMergedRecapPending, recordRecapWork } from ${JSON.stringify(RECAP_UTILS)};
const session = {sessionId: 'discussion-probe', host: 'test', key: 'discussion-probe'};
recordRecapWork({branch: ${JSON.stringify(branch)}, session, commit: 'abc', merged: true});
const r = await evaluateMergedRecapPending({session});
process.stdout.write(JSON.stringify(r));
`;

  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeGhDir}:${process.env.PATH}`,
      DEVPRO_RECAP_PENDING_DIR: pendingDir,
      DEVPRO_RECAP_STATE_DIR: stateDir,
      DEVPRO_SESSION_REMINDER_STATE_DIR: path.join(stateDir, "scoped"),
      DEVPRO_RECAP_WRITTEN_DIR: resolvedWrittenDir,
      ...env,
    },
    timeout: 15_000,
  });

  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    pendingDir,
    stateDir,
    writtenDir: resolvedWrittenDir,
  };
}

// ── RW-1: marker present for branch → checkDiscussionExists returns true ────

test("RW-1: recap-written marker present for branch → checkDiscussionExists returns true (skip:true)", () => {
  const ghDir = makeTmpDir("rw1-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rw1-written-");
  const branch = "feature/rw1-test";

  mkdirSync(writtenDir, { recursive: true });
  writeFileSync(path.join(writtenDir, encodeURIComponent(branch)), String(Date.now()));

  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, true, "Expected skip:true (marker present → recap found), got: " + JSON.stringify(result));
});

// ── RW-2: marker dir exists but no matching marker → false ──────────────────

test("RW-2: recap-written dir exists but no matching marker → checkDiscussionExists returns false (skip:false)", () => {
  const ghDir = makeTmpDir("rw2-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rw2-written-");
  const branch = "feature/rw2-test";

  // dir exists but has an unrelated marker file only
  mkdirSync(writtenDir, { recursive: true });
  writeFileSync(path.join(writtenDir, "unrelated-branch"), String(Date.now()));

  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (no matching marker), got: " + JSON.stringify(result));
});

// ── RW-3: marker dir does not exist at all → false (fail-open) ──────────────

test("RW-3: recap-written dir does not exist → checkDiscussionExists returns false (fail-open, skip:false)", () => {
  const ghDir = makeTmpDir("rw3-gh-");
  makeFakeGh(ghDir);
  const branch = "feature/rw3-test";
  const nonexistentWrittenDir = path.join(makeTmpDir("rw3-parent-"), "does-not-exist");

  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir: nonexistentWrittenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (dir missing → fail-open), got: " + JSON.stringify(result));
});

// ── RW-4: checkDiscussionExists never shells out to gh ──────────────────────

test("RW-4: checkDiscussionExists issues zero gh calls (pure local fs read)", () => {
  const ghDir = makeTmpDir("rw4-gh-");
  const { callsPath } = makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rw4-written-");
  const branch = "feature/rw4-test";

  // No marker written — exercises the "not found" path too, which must also
  // avoid any gh call.
  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (no marker), got: " + JSON.stringify(result));

  // The scan as a whole may ask gh one thing: whether the branch's PR is merged
  // yet (`pr list --head <branch> ...`, the unmerged-PR probe). A Discussion
  // lookup (`api graphql` / `discussion`) would be checkDiscussionExists going
  // to the network, which is what this test forbids.
  const calls = readFileSync(callsPath, "utf8").split("\n").filter(Boolean);
  const nonPrListCalls = calls.filter((line) => !/^pr list --head /.test(line));
  assert.deepEqual(nonPrListCalls, [], `Expected no gh call other than the PR-state probe, got: ${JSON.stringify(calls)}`);
});

// ── RW-5: branch with "/" → sanitizeBranch + legacy underscore both match ───

test("RW-5: branch name containing '/' matches via sanitizeBranch or legacy underscore marker name", () => {
  const ghDir = makeTmpDir("rw5-gh-");
  makeFakeGh(ghDir);
  const branch = "bugfix/foo";

  // sanitizeBranch (encodeURIComponent) form
  {
    const writtenDir = makeTmpDir("rw5-sanitized-");
    mkdirSync(writtenDir, { recursive: true });
    writeFileSync(path.join(writtenDir, encodeURIComponent(branch)), String(Date.now()));

    const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
    assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.skip, true, "Expected skip:true via sanitizeBranch marker name, got: " + JSON.stringify(result));
  }

  // legacy "_" form
  {
    const writtenDir = makeTmpDir("rw5-legacy-");
    mkdirSync(writtenDir, { recursive: true });
    writeFileSync(path.join(writtenDir, branch.replace(/\//g, "_")), String(Date.now()));

    const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
    assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.skip, true, "Expected skip:true via legacy underscore marker name, got: " + JSON.stringify(result));
  }
});

// ── RW-6: writeRecapWrittenMarkerForChange writes a marker that RW-1 detects ─

test("RW-6: writeRecapWrittenMarkerForChange(changeName) writes recap-written marker for matching pending work branch", () => {
  const ghDir = makeTmpDir("rw6-gh-");
  makeFakeGh(ghDir);
  const branch = "feature/rw6-change";
  const changeName = "rw6-change";
  const pendingDir = makeTmpDir("rw6-pending-");
  const writtenDir = makeTmpDir("rw6-written-");

  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(path.join(pendingDir, encodeURIComponent(branch)), String(Date.now()));

  const probe = `
import { writeRecapWrittenMarkerForChange } from ${JSON.stringify(RECAP_UTILS)};
const count = writeRecapWrittenMarkerForChange(${JSON.stringify(changeName)});
process.stdout.write(JSON.stringify({ count }));
`;

  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      DEVPRO_RECAP_PENDING_DIR: pendingDir,
      DEVPRO_RECAP_WRITTEN_DIR: writtenDir,
    },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `probe exited ${result.status}; stderr: ${result.stderr}`);
  const written = JSON.parse(result.stdout);
  assert.ok(written.count >= 1, `Expected writeRecapWrittenMarkerForChange to write >=1 marker, got: ${JSON.stringify(written)}`);

  // Now confirm checkDiscussionExists (via evaluateMergedRecapPending) sees it.
  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);
  const probed = JSON.parse(stdout);
  assert.equal(probed.skip, true, "Expected skip:true after writeRecapWrittenMarkerForChange, got: " + JSON.stringify(probed));
});

// ── RW-7: writeRecapWrittenMarkerForChange writes a changeName-keyed marker ──
// even when there is NO branch-format pending marker at all (empty/missing
// pendingDir). Covers the gap this change fixes: backfilled historical
// Recaps / manually-created Recaps on main have no corresponding
// recap-pending marker, so the old pending-loop-only implementation wrote
// zero markers and checkDiscussionExists kept reporting "not found" forever.

test("RW-7: writeRecapWrittenMarkerForChange writes changeName-keyed marker with no pending marker present (empty pendingDir)", () => {
  const ghDir = makeTmpDir("rw7-gh-");
  makeFakeGh(ghDir);
  const changeName = "some-change";
  // pendingDir exists but is empty — no branch-format marker for changeName.
  const pendingDir = makeTmpDir("rw7-pending-");
  const writtenDir = makeTmpDir("rw7-written-");

  const probe = `
import { writeRecapWrittenMarkerForChange } from ${JSON.stringify(RECAP_UTILS)};
const count = writeRecapWrittenMarkerForChange(${JSON.stringify(changeName)});
process.stdout.write(JSON.stringify({ count }));
`;

  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      DEVPRO_RECAP_PENDING_DIR: pendingDir,
      DEVPRO_RECAP_WRITTEN_DIR: writtenDir,
    },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `probe exited ${result.status}; stderr: ${result.stderr}`);
  const written = JSON.parse(result.stdout);
  assert.ok(
    written.count >= 1,
    `Expected writeRecapWrittenMarkerForChange to write >=1 marker even with no pending marker, got: ${JSON.stringify(written)}`
  );
});

test("RW-7: writeRecapWrittenMarkerForChange also works when pendingDir does not exist at all", () => {
  const ghDir = makeTmpDir("rw7b-gh-");
  makeFakeGh(ghDir);
  const changeName = "some-other-change";
  const pendingDir = path.join(makeTmpDir("rw7b-parent-"), "does-not-exist");
  const writtenDir = makeTmpDir("rw7b-written-");

  const probe = `
import { writeRecapWrittenMarkerForChange } from ${JSON.stringify(RECAP_UTILS)};
const count = writeRecapWrittenMarkerForChange(${JSON.stringify(changeName)});
process.stdout.write(JSON.stringify({ count }));
`;

  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      DEVPRO_RECAP_PENDING_DIR: pendingDir,
      DEVPRO_RECAP_WRITTEN_DIR: writtenDir,
    },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `probe exited ${result.status}; stderr: ${result.stderr}`);
  const written = JSON.parse(result.stdout);
  assert.ok(
    written.count >= 1,
    `Expected writeRecapWrittenMarkerForChange to write >=1 marker with missing pendingDir, got: ${JSON.stringify(written)}`
  );
});

// ── RW-8: after RW-7's no-pending-marker write, checkDiscussionExists (via ──
// evaluateMergedRecapPending) must see the changeName-keyed marker. Proves
// the write-side key (sanitizeBranch(changeName)) aligns with the read-side
// key (unsanitizeBranch(marker) -> getChangeName -> changeName), per SC3.
// Uses a *plain* changeName (no "/" in it, guaranteed by
// recapChangeNameFromCanonicalTitle upstream) so getChangeName's
// `^[a-z]+\/` strip is a no-op and the round trip is exact.

test("RW-8: changeName-keyed marker (written with no pending marker) is found by checkDiscussionExists afterwards", () => {
  const ghDir = makeTmpDir("rw8-gh-");
  makeFakeGh(ghDir);
  const changeName = "some-change-rw8";
  const pendingDir = makeTmpDir("rw8-pending-"); // empty: no pending marker
  const writtenDir = makeTmpDir("rw8-written-");

  const writeProbe = `
import { writeRecapWrittenMarkerForChange } from ${JSON.stringify(RECAP_UTILS)};
const count = writeRecapWrittenMarkerForChange(${JSON.stringify(changeName)});
process.stdout.write(JSON.stringify({ count }));
`;
  const writeResult = spawnSync("node", ["--input-type=module"], {
    input: writeProbe,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      DEVPRO_RECAP_PENDING_DIR: pendingDir,
      DEVPRO_RECAP_WRITTEN_DIR: writtenDir,
    },
    timeout: 15_000,
  });
  assert.equal(writeResult.status, 0, `write probe exited ${writeResult.status}; stderr: ${writeResult.stderr}`);
  const written = JSON.parse(writeResult.stdout);
  assert.ok(written.count >= 1, `Expected >=1 marker written, got: ${JSON.stringify(written)}`);

  // Query side: checkDiscussionExists is module-private, so exercise it via
  // evaluateMergedRecapPending's probe helper with a work branch whose
  // getChangeName() equals changeName exactly.
  const branch = `feature/${changeName}`;
  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);
  const probed = JSON.parse(stdout);
  assert.equal(
    probed.skip,
    true,
    "Expected skip:true — changeName-keyed marker written with no pending marker must still satisfy checkDiscussionExists, got: " +
      JSON.stringify(probed)
  );
});

// ── RW-9: fs errors in the changeName-keyed direct-write path fail open ─────
// (do not throw, return a count, never crash the calling hook).

test("RW-9: writeRecapWrittenMarkerForChange fails open when RECAP_WRITTEN_DIR is unwritable (a file, not a dir)", () => {
  const ghDir = makeTmpDir("rw9-gh-");
  makeFakeGh(ghDir);
  const changeName = "some-change-rw9";
  const pendingDir = makeTmpDir("rw9-pending-"); // empty
  const parent = makeTmpDir("rw9-parent-");
  const writtenDirAsFile = path.join(parent, "written-is-a-file");
  // A *file* sits where RECAP_WRITTEN_DIR expects a directory: mkdirSync on
  // top of it must throw (EEXIST/ENOTDIR) — writeRecapWrittenMarkerForChange
  // must swallow that and never throw / never crash the caller.
  writeFileSync(writtenDirAsFile, "not a directory");

  const probe = `
import { writeRecapWrittenMarkerForChange } from ${JSON.stringify(RECAP_UTILS)};
const count = writeRecapWrittenMarkerForChange(${JSON.stringify(changeName)});
process.stdout.write(JSON.stringify({ count }));
`;

  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghDir}:${process.env.PATH}`,
      DEVPRO_RECAP_PENDING_DIR: pendingDir,
      DEVPRO_RECAP_WRITTEN_DIR: writtenDirAsFile,
    },
    timeout: 15_000,
  });

  assert.equal(result.status, 0, `probe must not crash; exited ${result.status}; stderr: ${result.stderr}`);
  const written = JSON.parse(result.stdout);
  assert.equal(
    written.count,
    0,
    `Expected count 0 (fail-open, no marker written) when RECAP_WRITTEN_DIR unwritable, got: ${JSON.stringify(written)}`
  );
});

// ── RD-1 (adapted): checkDiscussionExists is a local lookup, independent of cwd repo name ──
// Formerly asserted the GraphQL query targeted devpro-tw/devpro-agent-rules
// regardless of cwd repo name. The lookup is now purely local (branch-keyed
// marker), so there is no "target repo" concept left to assert — this test
// instead confirms the marker match is driven solely by branch name, not by
// any cwd-repo-derived value, and that no gh call occurs.

test("RD-1: marker lookup is branch-keyed only, independent of cwd repo name, and issues no gh call", () => {
  const ghDir = makeTmpDir("rd1-gh-");
  const { counterPath } = makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rd1-written-");
  const branch = "feature/rd1-test";

  mkdirSync(writtenDir, { recursive: true });
  writeFileSync(path.join(writtenDir, encodeURIComponent(branch)), String(Date.now()));

  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, true, "Expected skip:true (marker present), got: " + JSON.stringify(result));

  const count = parseInt(readFileSync(counterPath, "utf8").trim(), 10);
  assert.equal(count, 0, `Expected zero gh calls for marker-based lookup, got: ${count}`);
});

// ── RD-2 (adapted): marker present for exact branch → skip:true ─────────────

test("RD-2: recap-written marker for matching branch → checkDiscussionExists returns true", () => {
  const ghDir = makeTmpDir("rd2-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rd2-written-");
  const branch = "feature/add-x";

  mkdirSync(writtenDir, { recursive: true });
  writeFileSync(path.join(writtenDir, encodeURIComponent(branch)), String(Date.now()));

  const { code, stdout, stderr } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, true, "Expected skip:true (recap found), got: " + JSON.stringify(result));
});

// ── RD-2b (adapted): marker file naming has no path-traversal injection surface ──
// Formerly asserted the GraphQL query string had no backslash-escaped quote
// literals (shell-injection concern on the query text). The marker path is
// now built from sanitizeBranch (encodeURIComponent), which cannot introduce
// "/" or ".." into the marker file name — assert that directly.

test("RD-2b: marker file name via sanitizeBranch contains no path-traversal segments", () => {
  const ghDir = makeTmpDir("rd2b-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rd2b-written-");
  const branch = "feature/../../etc/passwd";

  const markerName = encodeURIComponent(branch);
  // encodeURIComponent escapes "/" to "%2F", so no raw path separator can
  // ever appear in the marker file name — a literal ".." with no adjacent
  // "/" is inert (cannot escape the marker directory).
  assert.doesNotMatch(markerName, /\//, `sanitized marker name must not contain a raw path separator: ${markerName}`);

  mkdirSync(writtenDir, { recursive: true });
  writeFileSync(path.join(writtenDir, markerName), String(Date.now()));

  const { code, stdout, stderr, pendingDir } = runProbe({ branch, fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, true, "Expected skip:true (valid sanitized marker name finds recap), got: " + JSON.stringify(result));
  assert.equal(
    existsSync(path.join(pendingDir, branch.replace(/\//g, "_"))),
    true,
    "confirmed fact clears own scoped work, leaving legacy no-owner marker untouched"
  );
});

// ── RD-3 (adapted): marker for a different (prefix-overlapping) branch does not match ──

test("RD-3: marker for a different branch with overlapping prefix does not match", () => {
  const ghDir = makeTmpDir("rd3-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rd3-written-");

  // Marker exists for "feature/add-xtra", but we probe "feature/add-x" —
  // exact marker-name match required, no prefix matching.
  mkdirSync(writtenDir, { recursive: true });
  writeFileSync(path.join(writtenDir, encodeURIComponent("feature/add-xtra")), String(Date.now()));

  const { code, stdout, stderr } = runProbe({ branch: "feature/add-x", fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  // No exact match → pending should be emitted → skip:false
  assert.equal(result.skip, false, "Expected skip:false (no exact marker match for add-x), got: " + JSON.stringify(result));
});

// ── RD-6 (adapted): no marker at all for the branch → false ─────────────────

test("RD-6: no recap-written marker for branch → checkDiscussionExists returns false", () => {
  const ghDir = makeTmpDir("rd6-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rd6-written-");
  mkdirSync(writtenDir, { recursive: true });

  const { code, stdout, stderr } = runProbe({ branch: "feature/no-match-here", fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (no match), got: " + JSON.stringify(result));
});

// ── RD-8 (adapted): recap-written dir readdir failure → false (fail-open) ───
// Simulate an unreadable dir (file where a dir is expected) so readdirSync
// throws — must not propagate, must fail-open to false.

test("RD-8: recap-written dir unreadable (readdirSync throws) → checkDiscussionExists returns false (fail-open)", () => {
  const ghDir = makeTmpDir("rd8-gh-");
  makeFakeGh(ghDir);
  const parent = makeTmpDir("rd8-parent-");
  const writtenDirAsFile = path.join(parent, "written-is-a-file");
  // Create a *file* at the path where a directory is expected — readdirSync
  // on a plain file throws ENOTDIR.
  writeFileSync(writtenDirAsFile, "not a directory");

  const { code, stdout, stderr } = runProbe({ branch: "feature/rd8-test", fakeGhDir: ghDir, writtenDir: writtenDirAsFile });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (readdir failure → fail-open), got: " + JSON.stringify(result));
});

// ── RD-9 (adapted): recap-written dir does not exist → false (fail-open) ────

test("RD-9: recap-written dir missing entirely → checkDiscussionExists returns false (fail-open)", () => {
  const ghDir = makeTmpDir("rd9-gh-");
  makeFakeGh(ghDir);
  const missingDir = path.join(makeTmpDir("rd9-parent-"), "nope");

  const { code, stdout, stderr } = runProbe({ branch: "feature/rd9-test", fakeGhDir: ghDir, writtenDir: missingDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (dir missing → fail-open), got: " + JSON.stringify(result));
});

// ── RD-10 (adapted): recap-written dir empty → false ─────────────────────────

test("RD-10: recap-written dir exists but is empty → checkDiscussionExists returns false", () => {
  const ghDir = makeTmpDir("rd10-gh-");
  makeFakeGh(ghDir);
  const writtenDir = makeTmpDir("rd10-written-");
  mkdirSync(writtenDir, { recursive: true });

  const { code, stdout, stderr } = runProbe({ branch: "feature/rd10-test", fakeGhDir: ghDir, writtenDir });
  assert.equal(code, 0, `probe exited ${code}; stderr: ${stderr}`);

  const result = JSON.parse(stdout);
  assert.equal(result.skip, false, "Expected skip:false (empty dir → fail-open), got: " + JSON.stringify(result));
});

// ── R7: Recap dedup includes PR identity; legacy unknown ≠ same ─────────────

test("R7: PR#1 marker then PR#2 query is not has-recap; same PR still skips; legacy × known PR does not skip", () => {
  const writtenDir = makeTmpDir("r7-written-");
  mkdirSync(writtenDir, { recursive: true });
  const changeName = "fix-cross-review-visibility";

  const probe = `
import {
  checkDiscussionExists,
  writeRecapWrittenMarkerForChange,
} from ${JSON.stringify(RECAP_UTILS)};
const changeName = ${JSON.stringify(changeName)};
writeRecapWrittenMarkerForChange(changeName, "1");
const afterPr1ForPr2 = checkDiscussionExists(changeName, { prNumber: "2" });
const afterPr1ForPr1 = checkDiscussionExists(changeName, { prNumber: "1" });
writeRecapWrittenMarkerForChange(changeName); // legacy change-only
const legacyVsPr2 = checkDiscussionExists(changeName, { prNumber: "2" });
const legacyNoPr = checkDiscussionExists(changeName);
process.stdout.write(JSON.stringify({
  afterPr1ForPr2,
  afterPr1ForPr1,
  legacyVsPr2,
  legacyNoPr,
}));
`;

  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_RECAP_WRITTEN_DIR: writtenDir,
      DEVPRO_RECAP_PENDING_DIR: makeTmpDir("r7-pending-"),
    },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `probe exited ${result.status}; stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.afterPr1ForPr2, false, "PR#2 must not skip after PR#1 marker");
  assert.equal(parsed.afterPr1ForPr1, true, "same PR must still skip");
  assert.equal(parsed.legacyVsPr2, false, "legacy change-only × known PR#2 must not skip (unknown≠same)");
  assert.equal(parsed.legacyNoPr, true, "legacy marker still suppresses no-PR query");
});
