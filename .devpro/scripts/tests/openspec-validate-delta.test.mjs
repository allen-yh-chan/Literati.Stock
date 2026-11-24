/**
 * openspec-validate-delta.test.mjs
 *
 * Executable regression for R2 / design.md D3-D7 of fix-consumer-pre-pr-gates:
 * the consumer-only `openspec-validate-delta.mjs` gate. Contract SSOT is
 * `openspec/changes/fix-consumer-pre-pr-gates/design.md` (D3 CLI/collection,
 * D4 normalization/decision, D5 transaction/publication, D6 snapshot guards,
 * D7 fail-closed code closed list); the D10 matrix is covered case by case.
 *
 * Fixture strategy (design D10): real spawns against a real `git init` consumer
 * fixture, with a fixture `openspec` CLI injected by prepending `<fixture>/bin`
 * to PATH. The fake CLI decides base/head output from its cwd (`base-wt` is the
 * script's detached snapshot worktree), can mutate the base worktree (tracked /
 * ignored), can move the head HEAD, and can refuse/fail in the ways the matrix
 * needs. Codes that cannot be reached through the CLI (cleanup failure, chain
 * step failures, publication interruption) are exercised by calling the
 * exported runner/guard functions directly — no test-only env bypass exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { replaceDurableFile } from "../lib/durable-fs.mjs";
import {
  REVOKED_SCHEMA,
  SCHEMA_V2,
  applySnapshotReadOnly,
  assertWin32OpenspecDeltaSpawnArgs,
  buildAttemptLogBytes,
  buildFingerprint,
  cleanupSnapshot,
  compareSpecResults,
  evaluateBaseSnapshotState,
  openspecDeltaSpawnOptions,
  openspecDeltaSpawnTarget,
  parseValidatePayload,
  publishReceipt,
  resolveExecutableOnPath,
  runDeltaGate,
  runInvalidationFallbackChain,
  writeAttemptLog,
} from "../openspec-validate-delta.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../openspec-validate-delta.mjs");
const CHANGE = "delta-change";
const SHA_40 = /^[0-9a-f]{40}$/;

// ── fixture helpers ─────────────────────────────────────────────────────────

function git(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function specOk(id) {
  return { id, valid: true, issues: [] };
}

function specBad(id, issues) {
  return { id, valid: false, issues };
}

function issue(level, message, specPath = "openspec/specs/alpha/spec.md") {
  return { level, path: specPath, message };
}

/**
 * The fixture `openspec` CLI. `__dirname` is `<fixture>/bin` on both the POSIX
 * shebang wrapper and the win32 `.cmd` shim, so the control file always
 * resolves to the fixture root.
 */
const FAKE_OPENSPEC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const binDir = __dirname;
const fixtureRoot = path.dirname(binDir);
const control = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'fake-openspec.json'), 'utf8'));
const args = process.argv.slice(2);

function deleteBin() {
  for (const name of ['openspec', 'openspec.cjs', 'openspec.cmd']) {
    try { fs.rmSync(path.join(binDir, name), { force: true }); } catch (error) {}
  }
}

function commitHead(root) {
  const result = spawnSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'head drift'], { encoding: 'utf8' });
  if (result.status !== 0) process.exit(96);
}

function chmodRecursiveWrite() {
  spawnSync('chmod', ['-R', 'u+w', process.cwd()], { encoding: 'utf8' });
}

if (args[0] === '--version') {
  if (control.versionFails) { process.stderr.write('openspec fixture: version probe failed\\n'); process.exit(1); }
  process.stdout.write((control.version || '1.11.0') + '\\n');
  if (control.selfDeleteOnVersion) deleteBin();
  process.exit(0);
}

const side = path.basename(process.cwd()) === 'base-wt' ? 'base' : 'head';
const sideControl = control.sides[side] || {};
const mutations = control.mutations || {};

if (side === 'base' && mutations.tempRootReadOnly) {
  try { fs.chmodSync(path.dirname(process.cwd()), 0o555); } catch (error) {}
}
if (side === 'base' && mutations.baseTrackedWrite) {
  chmodRecursiveWrite();
  fs.appendFileSync(path.join(process.cwd(), 'openspec/specs/alpha/spec.md'), '\\nmutated during base run\\n');
}
if (side === 'base' && mutations.baseIgnoredWrite) {
  chmodRecursiveWrite();
  fs.writeFileSync(path.join(process.cwd(), 'ignored-artifact.tmp'), 'ignored mutation\\n');
}
if (side === 'base' && mutations.headCommitDuringBase) commitHead(control.headRoot);
if (side === 'base' && mutations.deniedWriteProbe) {
  try { fs.writeFileSync(path.join(process.cwd(), 'openspec', '__denied_probe.tmp'), 'probe'); }
  catch (error) { process.exit(1); }
}
if (side === 'head' && mutations.headCommitDuringHeadRun) commitHead(process.cwd());
if (typeof sideControl.rawStdout === 'string') {
  process.stdout.write(sideControl.rawStdout);
  if (side === 'base' && mutations.selfDeleteAfterBase) deleteBin();
  process.exit(sideControl.exitCode ?? 0);
}
const items = (sideControl.items || []).map((entry) => entry.raw !== undefined ? entry.raw : {
  type: 'spec',
  id: entry.id,
  valid: entry.valid,
  issues: (entry.issues || []).map((entryIssue) => ({
    level: entryIssue.level,
    path: entryIssue.path,
    message: String(entryIssue.message).split('__CWD__').join(process.cwd()),
  })),
});
process.stdout.write(JSON.stringify({ items, summary: sideControl.summary ?? {}, version: control.version || '1.11.0', root: process.cwd() }));
if (side === 'base' && mutations.selfDeleteAfterBase) deleteBin();
process.exit(sideControl.exitCode ?? 0);
`;

const POSIX_WRAPPER = '#!/usr/bin/env node\nrequire("./openspec.cjs");\n';
const WIN_CMD = '@echo off\r\nnode "%~dp0openspec.cjs" %*\r\n';

/**
 * Build a consumer (default) / source / unknown git fixture with:
 *  - a `main` baseline commit and a `work` branch commit (so base != head),
 *  - `.gitignore` covering `notes/`, the fake CLI and the ignored-artifact probe,
 *  - the fake `openspec` CLI and its control file,
 *  - optional prior canonical receipt / marker / notes state for the
 *    invalidate-first and publication cases.
 */
function makeFixture(options = {}) {
  const {
    identity = "consumer",
    baseItems = [],
    headItems = [],
    version = "1.11.0",
    versionFails = false,
    selfDeleteOnVersion = false,
    mutations = {},
    priorReceipt = null,
    notesMode = "dir",
    attemptRootAsFile = false,
    attemptParentSymlinkTo = null,
    ignoreNotes = true,
    markerAsDirectory = false,
    receiptAsDirectory = false,
    dirtyWorktree = false,
    change = CHANGE,
  } = options;

  const root = makeTempDir("openspec-validate-delta-");
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(root, "openspec/specs/alpha"), { recursive: true });
  mkdirSync(path.join(root, "openspec/specs/beta"), { recursive: true });
  writeFileSync(path.join(root, "openspec/specs/alpha/spec.md"), "# alpha\n");
  writeFileSync(path.join(root, "openspec/specs/beta/spec.md"), "# beta\n");

  if (identity === "consumer") {
    mkdirSync(path.join(root, ".devpro-agent-rules/.devpro/scripts"), { recursive: true });
    writeFileSync(path.join(root, ".devpro-agent-rules/AGENTS.md"), "# consumer fixture\n");
    writeFileSync(path.join(root, ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs"), "// sentinel\n");
  }
  if (identity === "source") {
    mkdirSync(path.join(root, ".devpro/scripts"), { recursive: true });
    mkdirSync(path.join(root, ".devpro/agent-rules"), { recursive: true });
    writeFileSync(path.join(root, ".devpro/scripts/pre-pr-archive-gate.mjs"), "// sentinel\n");
    writeFileSync(path.join(root, ".devpro/agent-rules/rule-audit-playbook.md"), "# sentinel\n");
  }

  writeFileSync(path.join(root, ".gitignore"), `${ignoreNotes ? "notes/\n" : ""}ignored-artifact.tmp\nbin/\nfake-openspec.json\n`);
  writeFileSync(path.join(binDir, "openspec.cjs"), FAKE_OPENSPEC);
  writeFileSync(path.join(binDir, "openspec"), POSIX_WRAPPER, { mode: 0o755 });
  writeFileSync(path.join(binDir, "openspec.cmd"), WIN_CMD);
  writeFileSync(
    path.join(root, "fake-openspec.json"),
    JSON.stringify(
      {
        version,
        versionFails,
        selfDeleteOnVersion,
        mutations,
        headRoot: root,
        sides: { base: { items: baseItems }, head: { items: headItems } },
      },
      null,
      2,
    ),
  );

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, [
    "remote",
    "add",
    "origin",
    identity === "source"
      ? "https://example.invalid/devpro-agent-rules.git"
      : "https://example.invalid/consumer-business-repo.git",
  ]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture baseline"]);
  git(root, ["checkout", "-q", "-b", "work"]);
  writeFileSync(path.join(root, "openspec/specs/alpha/spec.md"), "# alpha\nhead-side edit\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "head work"]);

  const realRoot = realpathSync(root);
  const notesDir = path.join(realRoot, "notes");
  if (notesMode !== "absent") {
    mkdirSync(notesDir, { recursive: true });
    if (priorReceipt !== null) {
      const headSha = git(root, ["rev-parse", "HEAD"]).stdout.trim();
      const record =
        priorReceipt === "acceptable"
          ? {
              schema: SCHEMA_V2,
              attempt_id: "prior-attempt",
              change,
              head_sha: headSha,
              decision: "pass",
              published_at: "2026-01-01T00:00:00.000Z",
            }
          : priorReceipt === "stale"
            ? {
                schema: SCHEMA_V2,
                attempt_id: "stale-attempt",
                change,
                head_sha: "f".repeat(40),
                decision: "pass",
                published_at: "2026-01-01T00:00:00.000Z",
              }
            : priorReceipt;
      writeFileSync(path.join(notesDir, `openspec-validate-${change}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
    if (markerAsDirectory) mkdirSync(path.join(notesDir, `openspec-validate-${change}.invalidated`), { recursive: true });
    if (receiptAsDirectory) {
      rmSync(path.join(notesDir, `openspec-validate-${change}.json`), { force: true });
      mkdirSync(path.join(notesDir, `openspec-validate-${change}.json`), { recursive: true });
    }
    if (attemptRootAsFile) {
      mkdirSync(path.join(notesDir, "tmp"), { recursive: true });
      writeFileSync(path.join(notesDir, "tmp", `openspec-validate-${change}`), "not a directory\n");
    }
    if (attemptParentSymlinkTo !== null) {
      mkdirSync(path.join(notesDir, "tmp"), { recursive: true });
      symlinkSync(attemptParentSymlinkTo, path.join(notesDir, "tmp", `openspec-validate-${change}`));
    }
    if (notesMode === "read-only") chmodSync(notesDir, 0o555);
  }
  if (dirtyWorktree) writeFileSync(path.join(root, "untracked-file.txt"), "dirty\n");

  return {
    root,
    realRoot,
    binDir,
    change,
    baseRef: "main",
    notesDir,
    receiptPath: path.join(notesDir, `openspec-validate-${change}.json`),
    markerPath: path.join(notesDir, `openspec-validate-${change}.invalidated`),
    cleanup() {
      try {
        chmodSync(notesDir, 0o755);
      } catch {
        /* notes may never have been created */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function pathEnv(binDir) {
  return `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

function runDelta(fixture, { baseRef = fixture.baseRef, extraArgs = [], relativeBinPath = false } = {}) {
  const pathValue = relativeBinPath
    ? `${path.relative(fixture.root, fixture.binDir)}${path.delimiter}${process.env.PATH ?? ""}`
    : pathEnv(fixture.binDir);
  return spawnSync(
    process.execPath,
    [SCRIPT, "--change", fixture.change, "--base", baseRef, ...extraArgs],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, PATH: pathValue },
    },
  );
}

/** Run the exported runner in-process (no CLI contract, but real fixture). */
function runDeltaInProcess(fixture, io = {}) {
  return runDeltaGate({
    cwd: fixture.root,
    change: fixture.change,
    baseRef: fixture.baseRef,
    io: { env: { ...process.env, PATH: pathEnv(fixture.binDir) }, ...io },
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** design D5 receipt acceptance predicate, evaluated against the fixture. */
function acceptance(fixture) {
  let schema = null;
  let headSha = null;
  let parseable = false;
  if (existsSync(fixture.receiptPath)) {
    try {
      const parsed = readJson(fixture.receiptPath);
      schema = parsed.schema;
      headSha = parsed.head_sha;
      parseable = true;
    } catch {
      parseable = false;
    }
  }
  const currentHead = git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
  // Mirrors the gate: only gate-owned artifacts under notes/ are excluded from
  // the cleanliness clause; any other change still counts as dirty.
  const clean = git(fixture.root, ["status", "--porcelain", "--untracked-files=all"]).stdout
    .split("\n")
    .filter(Boolean)
    .every((line) => {
      const entry = line.slice(3).split(path.sep).join("/");
      return entry === "notes" || entry.startsWith("notes/");
    });
  const markerPresent = existsSync(fixture.markerPath);
  return {
    parseable,
    schema,
    headSha,
    currentHead,
    clean,
    markerPresent,
    acceptable: parseable && schema === SCHEMA_V2 && headSha === currentHead && clean && !markerPresent,
  };
}

function stderrLine(result) {
  return `${result.stderr}\n${result.stdout}`;
}

// ── CLI shape and identity self-check (D3) ─────────────────────────────────

test("CLI shape errors are usage-error: missing/duplicate/invalid flags", () => {
  const fixture = makeFixture({ notesMode: "absent" });
  try {
    const cases = [
      ["--change", CHANGE], // missing --base
      ["--change", "../escape", "--base", "main"], // invalid change name
      ["--change", CHANGE, "--base"], // missing value
      ["--change", CHANGE, "--base", "--force"], // ref that would read as a flag
      ["--change", CHANGE, "--base", "main", "--unknown"], // unknown flag
      ["--change", CHANGE, "--change", CHANGE, "--base", "main"], // duplicate
    ];
    for (const args of cases) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: fixture.root,
        encoding: "utf8",
        env: { ...process.env, PATH: pathEnv(fixture.binDir) },
      });
      assert.equal(result.status, 1, `args ${args.join(" ")}: ${stderrLine(result)}`);
      assert.match(result.stderr, /usage-error/, `args ${args.join(" ")}: ${stderrLine(result)}`);
      assert.match(result.stderr, /openspec-validate-delta\.mjs --change <name> --base <base-ref>/);
    }
    // Usage errors must not touch evidence or markers.
    assert.equal(existsSync(fixture.markerPath), false);
    assert.equal(existsSync(fixture.receiptPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("identity-refused: source and unknown repositories cannot use the consumer path", () => {
  for (const identity of ["source", "unknown"]) {
    const fixture = makeFixture({ identity, priorReceipt: "acceptable" });
    try {
      const result = runDelta(fixture);
      assert.equal(result.status, 1, stderrLine(result));
      assert.match(result.stderr, /identity-refused/);
      assert.match(result.stderr, /repo-wide requirement/);
      // Pre-check failures happen before the commitment point: existing
      // evidence and markers are untouched (design D5).
      assert.equal(existsSync(fixture.markerPath), false, `identity=${identity} must not write a marker`);
      assert.equal(acceptance(fixture).acceptable, true, `identity=${identity} must not revoke the existing receipt`);
    } finally {
      fixture.cleanup();
    }
  }
});

// ── inherited / new / changed / resolved decisions (D4) ────────────────────

test("inherited-only invalid specs pass, and the receipt carries the full v2 evidence set", () => {
  const fixture = makeFixture({
    baseItems: [specBad("alpha", [issue("error", "inherited problem")]), specOk("beta")],
    headItems: [specBad("alpha", [issue("error", "inherited problem")]), specOk("beta")],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    assert.match(
      result.stdout,
      /checked_specs=2 inherited=1 new=0 changed=0 resolved=0 decision=pass/,
      stderrLine(result),
    );

    const receipt = readJson(fixture.receiptPath);
    assert.equal(receipt.schema, SCHEMA_V2);
    assert.equal(receipt.decision, "pass");
    assert.equal(receipt.change, CHANGE);
    assert.equal(receipt.identity, "consumer");
    assert.equal(receipt.base_ref, "main");
    assert.match(receipt.head_sha, SHA_40);
    assert.equal(receipt.head_sha, git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim());
    assert.equal(receipt.base_sha, git(fixture.root, ["rev-parse", "main"]).stdout.trim());
    assert.match(receipt.attempt_id, /^\d{8}T\d{6}Z-\d+-[0-9a-z]+$/);
    assert.match(receipt.published_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(receipt.openspec_version, /^1\.11\.0$/);
    assert.equal(receipt.command, "openspec validate --strict --specs --no-interactive --json");
    assert.deepEqual(receipt.new_invalid, []);
    assert.deepEqual(receipt.changed_invalid, []);
    assert.deepEqual(receipt.resolved, []);

    assert.deepEqual(receipt.base.invalid.map((entry) => entry.id), ["alpha"]);
    assert.deepEqual(receipt.head.invalid.map((entry) => entry.id), ["alpha"]);
    assert.equal(receipt.head.invalid[0].path, "openspec/specs/alpha/spec.md");
    assert.deepEqual(receipt.head.invalid[0].issue_tokens, ["error|openspec/specs/alpha/spec.md|inherited problem"]);
    assert.equal(receipt.base.log_path, `notes/tmp/openspec-validate-${CHANGE}/${receipt.attempt_id}/base.log`);
    assert.equal(receipt.head.log_path, `notes/tmp/openspec-validate-${CHANGE}/${receipt.attempt_id}/head.log`);
    // Attempt layout (design D5): base.log, head.log, and the candidate
    // receipt.json that was published byte-identically to the canonical path.
    const candidatePath = path.join(
      fixture.realRoot,
      "notes/tmp",
      `openspec-validate-${CHANGE}`,
      receipt.attempt_id,
      "receipt.json",
    );
    assert.equal(existsSync(candidatePath), true);
    assert.deepEqual(readFileSync(candidatePath), readFileSync(fixture.receiptPath));

    for (const side of ["base", "head"]) {
      const logPath = path.join(fixture.realRoot, receipt[side].log_path);
      assert.equal(existsSync(logPath), true, `${side} log must exist`);
      assert.equal(sha256(readFileSync(logPath)), receipt[side].log_digest_sha256);
      assert.match(receipt[side].result_digest_sha256, /^[0-9a-f]{64}$/);
      assert.equal(receipt[side].exit_code, 0);
    }
    const expectedSnapshotMode = process.platform === "win32" ? "detection-only" : "posix-read-only";
    assert.equal(receipt.base.snapshot_mode, expectedSnapshotMode);
    for (const phase of ["pre", "post"]) {
      assert.deepEqual(receipt.base.snapshot_checks[phase], {
        head_matches_base_sha: true,
        porcelain_empty_tracked_staged_untracked: true,
        ignored_empty: true,
      });
    }
    assert.deepEqual(receipt.head.guards, {
      head_sha_pre: receipt.head_sha,
      head_sha_post: receipt.head_sha,
      clean_pre: true,
      clean_post: true,
    });

    // marker lifecycle: invalidate-first wrote it; publication removed it.
    assert.equal(existsSync(fixture.markerPath), false);
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

test("head-only new red blocks with a named new_invalid id and leaves no acceptable receipt", () => {
  const fixture = makeFixture({
    baseItems: [specOk("alpha"), specOk("beta")],
    headItems: [specOk("alpha"), specBad("beta", [issue("error", "new problem", "openspec/specs/beta/spec.md")])],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(stderrLine(result), /decision=block/);
    assert.match(stderrLine(result), /checked_specs=2 inherited=0 new=1 changed=0 resolved=0 decision=block/);
    assert.match(stderrLine(result), /new_invalid \(1\): beta/);
    assert.equal(acceptance(fixture).acceptable, false);
    // invalidate-first marker is the reason there is no acceptable evidence.
    assert.equal(existsSync(fixture.markerPath), true);
  } finally {
    fixture.cleanup();
  }
});

test("shared-input invalidity of an untouched spec is still new_invalid (round-2 named case)", () => {
  // The branch commit edits only alpha/spec.md; beta is untouched. A head-only
  // red on beta therefore cannot be explained away by touched-path inference.
  const fixture = makeFixture({
    baseItems: [specOk("alpha"), specOk("beta")],
    headItems: [specOk("alpha"), specBad("beta", [issue("error", "shared tooling drift", "openspec/specs/beta/spec.md")])],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(stderrLine(result), /new_invalid \(1\): beta/);
    assert.match(stderrLine(result), /shared tooling drift/);
  } finally {
    fixture.cleanup();
  }
});

test("same id invalid on both sides with a new head issue is changed_invalid", () => {
  const fixture = makeFixture({
    baseItems: [specBad("alpha", [issue("error", "first problem")]), specOk("beta")],
    headItems: [
      specBad("alpha", [issue("error", "first problem"), issue("warning", "second problem")]),
      specOk("beta"),
    ],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(stderrLine(result), /checked_specs=2 inherited=0 new=0 changed=1 resolved=0 decision=block/);
    assert.match(stderrLine(result), /changed_invalid \(1\): alpha/);
    assert.match(stderrLine(result), /warning\|openspec\/specs\/alpha\/spec\.md\|second problem/);
  } finally {
    fixture.cleanup();
  }
});

test("resolved base-only invalid passes and is recorded in the receipt", () => {
  const fixture = makeFixture({
    baseItems: [specBad("alpha", [issue("error", "was broken")]), specOk("beta")],
    headItems: [specOk("alpha"), specOk("beta")],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    assert.match(result.stdout, /checked_specs=2 inherited=0 new=0 changed=0 resolved=1 decision=pass/);
    const receipt = readJson(fixture.receiptPath);
    assert.deepEqual(receipt.resolved, ["alpha"]);
    assert.deepEqual(receipt.base.invalid.map((entry) => entry.id), ["alpha"]);
    assert.deepEqual(receipt.head.invalid, []);
  } finally {
    fixture.cleanup();
  }
});

test("identical issue text is inherited even when each side reports its own absolute root", () => {
  // Normalization (D4) removes only the two known roots with one fixed token,
  // so a logically identical issue does not become changed_invalid merely
  // because the base worktree and the head checkout have different paths.
  const rooted = () => [issue("error", "shared problem at __CWD__/openspec/specs/alpha/spec.md")];
  const fixture = makeFixture({
    baseItems: [specBad("alpha", rooted())],
    headItems: [specBad("alpha", rooted())],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    assert.match(result.stdout, /checked_specs=1 inherited=1 new=0 changed=0 resolved=0 decision=pass/);
    const receipt = readJson(fixture.receiptPath);
    assert.deepEqual(receipt.head.invalid[0].issue_tokens, [
      "error|openspec/specs/alpha/spec.md|shared problem at <repo-root>/openspec/specs/alpha/spec.md",
    ]);
  } finally {
    fixture.cleanup();
  }
});

// ── stale / re-run supersession (D5) ───────────────────────────────────────

test("stale receipt is not evidence; a successful re-run republishes at the new HEAD", () => {
  const fixture = makeFixture({
    priorReceipt: "acceptable",
    baseItems: [specOk("alpha"), specOk("beta")],
    headItems: [specOk("alpha"), specOk("beta")],
  });
  try {
    const before = readJson(fixture.receiptPath);
    assert.equal(acceptance(fixture).acceptable, true);
    // Land a commit after the receipt: it must read as stale.
    writeFileSync(path.join(fixture.root, "later.md"), "later\n");
    git(fixture.root, ["add", "later.md"]);
    git(fixture.root, ["commit", "-q", "-m", "later commit"]);
    assert.equal(acceptance(fixture).acceptable, false, "HEAD moved: old receipt must be stale");

    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    const after = readJson(fixture.receiptPath);
    assert.notEqual(after.attempt_id, before.attempt_id);
    assert.equal(after.head_sha, git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim());
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

test("re-running at the same HEAD supersedes the previous attempt", () => {
  const fixture = makeFixture({
    baseItems: [specOk("alpha")],
    headItems: [specOk("alpha")],
  });
  try {
    assert.equal(runDelta(fixture).status, 0);
    const first = readJson(fixture.receiptPath);
    assert.equal(runDelta(fixture).status, 0);
    const second = readJson(fixture.receiptPath);
    assert.notEqual(second.attempt_id, first.attempt_id);
    assert.equal(second.head_sha, first.head_sha);
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

test("a failing re-run at the same HEAD leaves the previous pass receipt unacceptable", () => {
  const fixture = makeFixture({
    priorReceipt: "acceptable",
    baseItems: [specOk("alpha")],
    headItems: [specBad("alpha", [issue("error", "regressed")])],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(stderrLine(result), /decision=block/);
    assert.equal(acceptance(fixture).acceptable, false);
    assert.equal(existsSync(fixture.markerPath), true);
    // The failure attempt left its own attempt dir for diagnosis, but the
    // canonical location still holds the (marker-revoked) prior bytes.
    const attemptsRoot = path.join(fixture.notesDir, "tmp", `openspec-validate-${CHANGE}`);
    assert.equal(existsSync(attemptsRoot), true);
  } finally {
    fixture.cleanup();
  }
});

// ── base ref / snapshot guards (D3, D6) ────────────────────────────────────

test("unresolvable or unrelated base ref fails closed with base-ref-unresolved", () => {
  const fixture = makeFixture();
  try {
    const result = runDelta(fixture, { baseRef: "no-such-ref" });
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /base-ref-unresolved/);
  } finally {
    fixture.cleanup();
  }
});

test("HEAD that cannot be resolved fails closed with head-unresolved", () => {
  // Consumer evidence in a git repo with no commits: identity is consumer,
  // but `git rev-parse HEAD` cannot name a tree.
  const root = makeTempDir("openspec-validate-delta-empty-");
  try {
    mkdirSync(path.join(root, ".devpro-agent-rules/.devpro/scripts"), { recursive: true });
    writeFileSync(path.join(root, ".devpro-agent-rules/AGENTS.md"), "# consumer fixture\n");
    writeFileSync(path.join(root, ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs"), "// sentinel\n");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["remote", "add", "origin", "https://example.invalid/consumer-business-repo.git"]);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--change", CHANGE, "--base", "main"],
      { cwd: root, encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /head-unresolved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dirty head worktree fails closed with dirty-worktree before any CLI run", () => {
  const fixture = makeFixture({ dirtyWorktree: true });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /dirty-worktree/);
    // invalidate-first is the commitment point: the marker exists even though
    // collection failed before any openspec invocation.
    assert.equal(existsSync(fixture.markerPath), true);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("base pre-check failure fails closed with base-snapshot-invalid", () => {
  const fixture = makeFixture();
  try {
    let evaluations = 0;
    const result = runDeltaInProcess(fixture, {
      evaluateBaseSnapshotState: (args) => {
        evaluations += 1;
        if (evaluations === 1) {
          return {
            head_matches_base_sha: true,
            porcelain_empty_tracked_staged_untracked: false,
            ignored_empty: true,
            ok: false,
          };
        }
        return evaluateBaseSnapshotState(args);
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "base-snapshot-invalid");
    assert.match(result.messages.map((entry) => entry.text).join(""), /base-snapshot-invalid/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("a fresh repository without notes/ publishes through ensurePlainNotesRoot", () => {
  const fixture = makeFixture({ notesMode: "absent" });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    assert.equal(existsSync(fixture.receiptPath), true);
    assert.equal(existsSync(fixture.markerPath), false);
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

test("base snapshot creation failure fails closed with base-snapshot-failed", () => {
  if (process.platform === "win32") {
    // The read-only-.git/worktrees injection is POSIX-only; the code path is
    // still exercised through mkdtemp failure below.
    return;
  }
  const fixture = makeFixture();
  const worktreesDir = path.join(fixture.root, ".git", "worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  chmodSync(worktreesDir, 0o555);
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /base-snapshot-failed/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    chmodSync(worktreesDir, 0o755);
    fixture.cleanup();
  }
});

test("base-snapshot-failed also covers a temp root that cannot be created", {
  skip: process.platform === "win32" ? "chmod cannot make a directory unwritable on Windows" : false,
}, () => {
  const fixture = makeFixture();
  const readOnlyTmp = makeTempDir("openspec-validate-delta-tmp-");
  try {
    chmodSync(readOnlyTmp, 0o555);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--change", CHANGE, "--base", "main"],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: { ...process.env, PATH: pathEnv(fixture.binDir), TMPDIR: readOnlyTmp },
      },
    );
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /base-snapshot-failed/);
  } finally {
    chmodSync(readOnlyTmp, 0o755);
    rmSync(readOnlyTmp, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("base snapshot mutation during validation fails closed: tracked file", () => {
  const fixture = makeFixture({
    mutations: { baseTrackedWrite: true },
    baseItems: [specOk("alpha")],
    headItems: [specOk("alpha")],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /base-snapshot-mutated/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("base snapshot mutation during validation fails closed: ignored path", () => {
  const fixture = makeFixture({
    mutations: { baseIgnoredWrite: true },
    baseItems: [specOk("alpha")],
    headItems: [specOk("alpha")],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /base-snapshot-mutated/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("a validator write denied by the read-only snapshot fails the base side closed", () => {
  if (process.platform === "win32") return; // no POSIX read-only mode
  const fixture = makeFixture({
    mutations: { deniedWriteProbe: true },
    baseItems: [specOk("alpha")],
    headItems: [specOk("alpha")],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /unparseable-json:base/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("head mutation during collection fails closed, both during base and during the head run", async (t) => {
  for (const [name, mutations] of [
    ["head moves while the base snapshot validates", { headCommitDuringBase: true }],
    ["head moves during its own run", { headCommitDuringHeadRun: true }],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture({
        mutations,
        baseItems: [specOk("alpha")],
        headItems: [specOk("alpha")],
      });
      try {
        const result = runDelta(fixture);
        assert.equal(result.status, 1, stderrLine(result));
        assert.match(result.stderr, /head-mutated-during-collection/);
        assert.equal(acceptance(fixture).acceptable, false);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

// ── CLI execution / payload shapes (D3 step 10-11) ─────────────────────────

test("a failing --version probe fails closed before collection, after invalidating evidence", () => {
  const fixture = makeFixture({ versionFails: true, priorReceipt: "acceptable" });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /cli-exec-failed:version/);
    // invalidate-first ran before any CLI probe: the old receipt is revoked.
    assert.equal(existsSync(fixture.markerPath), true);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

// cmd.exe reads a batch file again after every command, on one line or several. A `.cmd` wrapper removed
// while it runs therefore fails that same call, one step before the side each case names.
const WINDOWS_SELF_DELETE_SKIP = process.platform === "win32"
  ? "a .cmd wrapper deleted mid-run fails the running call, not the next one"
  : false;

test("a validator that disappears after --version fails the base side with cli-exec-failed", { skip: WINDOWS_SELF_DELETE_SKIP }, () => {
  const fixture = makeFixture({ selfDeleteOnVersion: true });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /cli-exec-failed:base/);
  } finally {
    fixture.cleanup();
  }
});

test("a validator that disappears after the base run fails the head side with cli-exec-failed", { skip: WINDOWS_SELF_DELETE_SKIP }, () => {
  const fixture = makeFixture({ mutations: { selfDeleteAfterBase: true } });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /cli-exec-failed:head/);
  } finally {
    fixture.cleanup();
  }
});

test("unparseable or shapeless stdout fails closed per side", async (t) => {
  for (const [name, sides, code] of [
    ["base stdout is not JSON", { base: { rawStdout: "not json at all" } }, "unparseable-json:base"],
    ["head top-level shape is wrong", { head: { rawStdout: "{\"items\":{}}" } }, "unparseable-json:head"],
  ]) {
    await t.test(name, () => {
      const base = sides.base ?? { items: [specOk("alpha")] };
      const head = sides.head ?? { items: [specOk("alpha")] };
      const fixture = makeFixture({ baseItems: base.items ?? [], headItems: head.items ?? [] });
      // rawStdout cases need the control override, which makeFixture does not
      // take directly: patch the control file before running.
      const controlPath = path.join(fixture.root, "fake-openspec.json");
      const control = readJson(controlPath);
      if (sides.base) control.sides.base = sides.base;
      if (sides.head) control.sides.head = sides.head;
      writeFileSync(controlPath, JSON.stringify(control, null, 2));
      try {
        const result = runDelta(fixture);
        assert.equal(result.status, 1, stderrLine(result));
        assert.match(result.stderr, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(acceptance(fixture).acceptable, false);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("spec item shape violations fail closed per side with unknown-item-shape", async (t) => {
  for (const [name, sides, code] of [
    [
      "base spec id is not canonical",
      { base: { items: [{ raw: { type: "spec", id: "BAD_ID", valid: false, issues: [] } }] } },
      "unknown-item-shape:base",
    ],
    [
      "head issues is not an array",
      { head: { items: [{ raw: { type: "spec", id: "alpha", valid: false, issues: "nope" } }] } },
      "unknown-item-shape:head",
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture();
      const controlPath = path.join(fixture.root, "fake-openspec.json");
      const control = readJson(controlPath);
      if (sides.base) control.sides.base = sides.base;
      if (sides.head) control.sides.head = sides.head;
      writeFileSync(controlPath, JSON.stringify(control, null, 2));
      try {
        const result = runDelta(fixture);
        assert.equal(result.status, 1, stderrLine(result));
        assert.match(result.stderr, new RegExp(code.replace(/[.:]/g, "\\$&")));
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("unrecognized or missing item type fails closed and publishes no receipt (e2e)", async (t) => {
  for (const [name, sides, code] of [
    [
      "head has an unrecognized-type item carrying an invalid result",
      { head: { items: [{ raw: { type: "spec", id: "alpha", valid: false, issues: [] } }, { raw: { type: "mystery", id: "alpha", valid: false, issues: [{ level: "ERROR", path: "p", message: "boom" }] } }] } },
      "unknown-item-shape:head",
    ],
    [
      "base has an item with no type at all",
      { base: { items: [{ raw: { id: "alpha", valid: false, issues: [{ level: "ERROR", path: "p", message: "boom" }] } }] } },
      "unknown-item-shape:base",
    ],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
      const controlPath = path.join(fixture.root, "fake-openspec.json");
      const control = readJson(controlPath);
      if (sides.base) control.sides.base = sides.base;
      if (sides.head) control.sides.head = sides.head;
      writeFileSync(controlPath, JSON.stringify(control, null, 2));
      try {
        const result = runDelta(fixture);
        assert.equal(result.status, 1, stderrLine(result));
        assert.match(result.stderr, new RegExp(code.replace(/[.:]/g, "\\$&")));
        assert.equal(existsSync(fixture.receiptPath), false, "no canonical receipt may be published");
        assert.equal(acceptance(fixture).acceptable, false);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("a non-zero head validator exit with an all-valid payload fails closed", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  const controlPath = path.join(fixture.root, "fake-openspec.json");
  const control = readJson(controlPath);
  control.sides.head.exitCode = 1;
  writeFileSync(controlPath, JSON.stringify(control, null, 2));
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /cli-exec-failed:head/);
    assert.equal(existsSync(fixture.receiptPath), false, "no canonical receipt may be published");
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("a non-zero base validator exit with an empty payload fails closed", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  const controlPath = path.join(fixture.root, "fake-openspec.json");
  const control = readJson(controlPath);
  control.sides.base = { items: [], rawStdout: JSON.stringify({ items: [], summary: {}, version: "1.11.0", root: "/x" }), exitCode: 1 };
  writeFileSync(controlPath, JSON.stringify(control, null, 2));
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /cli-exec-failed:base/);
    assert.equal(existsSync(fixture.receiptPath), false, "no canonical receipt may be published");
  } finally {
    fixture.cleanup();
  }
});

test("a validator summary that contradicts its payload fails closed", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  const controlPath = path.join(fixture.root, "fake-openspec.json");
  const control = readJson(controlPath);
  control.sides.head.summary = { totals: { items: 1, passed: 1, failed: 0 }, byType: { spec: { items: 1, passed: 0, failed: 1 } } };
  writeFileSync(controlPath, JSON.stringify(control, null, 2));
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /unknown-item-shape:head/);
    assert.equal(existsSync(fixture.receiptPath), false, "no canonical receipt may be published");
  } finally {
    fixture.cleanup();
  }
});

test("a non-zero exit fully represented by an invalid spec is allowed (inherited red)", () => {
  const invalid = {
    id: "alpha",
    valid: false,
    issues: [{ level: "ERROR", path: "openspec/specs/alpha/spec.md", message: "boom __CWD__" }],
  };
  const fixture = makeFixture({ baseItems: [invalid], headItems: [invalid] });
  const controlPath = path.join(fixture.root, "fake-openspec.json");
  const control = readJson(controlPath);
  control.sides.base.exitCode = 1;
  control.sides.head.exitCode = 1;
  writeFileSync(controlPath, JSON.stringify(control, null, 2));
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

test("a relative PATH entry still pins one absolute validator for base and head", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  try {
    const result = runDelta(fixture, { relativeBinPath: true });
    assert.equal(result.status, 0, stderrLine(result));
    assert.equal(acceptance(fixture).acceptable, true);
    const receipt = readJson(fixture.receiptPath);
    assert.equal(path.isAbsolute(receipt.openspec_executable), true, "the receipt must record an absolute executable");
  } finally {
    fixture.cleanup();
  }
});

test("gate-owned artifacts do not dirty the head worktree (non-ignored notes passes)", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")], ignoreNotes: false });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 0, stderrLine(result));
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

test("a non-gate-owned untracked file still fails closed as dirty-worktree", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")], ignoreNotes: false, dirtyWorktree: true });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /dirty-worktree/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("a staged rename from a non-gate-owned path into a gate-owned path is still dirty-worktree", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  try {
    writeFileSync(path.join(fixture.root, "tracked.txt"), "x\n");
    git(fixture.root, ["add", "tracked.txt"]);
    git(fixture.root, ["commit", "-q", "-m", "add tracked"]);
    const attemptDir = path.join(fixture.notesDir, "tmp", `openspec-validate-${fixture.change}`);
    mkdirSync(attemptDir, { recursive: true });
    git(fixture.root, ["mv", "tracked.txt", `notes/tmp/openspec-validate-${fixture.change}/x.txt`]);
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /dirty-worktree/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

// ── attempt dir / logs / receipt writes (D5, D7) ───────────────────────────

test("attempt dir creation failure fails closed after invalidation with attempt-dir-failed", () => {
  const fixture = makeFixture({ attemptRootAsFile: true, priorReceipt: "acceptable" });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /attempt-dir-failed/);
    assert.equal(existsSync(fixture.markerPath), true);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("a symlinked attempt-parent is rejected without writing validator logs outside the repo", () => {
  const external = makeTempDir("delta-attempt-escape-");
  const fixture = makeFixture({ attemptParentSymlinkTo: external });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /attempt-dir-failed/);
    assert.equal(readdirSync(external).length, 0, "no data may be written through the symlink");
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
    rmSync(external, { recursive: true, force: true });
  }
});

test("log write failure fails closed with log-write-failed and no acceptable receipt", () => {
  const fixture = makeFixture({ priorReceipt: "acceptable" });
  try {
    const result = runDeltaInProcess(fixture, {
      writeAttemptLog: () => {
        throw new Error("forced log write failure");
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "log-write-failed");
    assert.match(result.messages.map((entry) => entry.text).join(""), /log-write-failed/);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("canonical receipt write failure fails closed with receipt-write-failed", () => {
  const fixture = makeFixture({ receiptAsDirectory: true });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /receipt-write-failed/);
    assert.equal(acceptance(fixture).acceptable, false);
    assert.equal(existsSync(fixture.markerPath), true, "marker stays in place when publication does not commit");
  } finally {
    fixture.cleanup();
  }
});

test("publication precondition failure is receipt-publish-blocked and writes no receipt", () => {
  const fixture = makeFixture({ markerAsDirectory: true });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /receipt-publish-blocked/);
    // The invalidate-first fallback (2) wrote a durable revocation payload; the
    // revoked schema is not acceptable evidence even after HEAD/worktree are
    // clean again.
    assert.equal(acceptance(fixture).acceptable, false);
    const canonical = readFileSync(fixture.receiptPath, "utf8");
    assert.equal(JSON.parse(canonical).schema, REVOKED_SCHEMA);
  } finally {
    fixture.cleanup();
  }
});

test("invalidation fallback (3): rename plus post-rename revocation, and rename alone never counts", () => {
  // Marker path and canonical receipt path are both directories: durable marker
  // and durable revocation both fail, the tombstone rename succeeds, and the
  // mandatory post-rename revocation retry writes the revoked payload.
  const fixture = makeFixture({
    markerAsDirectory: true,
    receiptAsDirectory: true,
    baseItems: [specOk("alpha")],
    headItems: [specBad("alpha", [issue("error", "still red")])],
  });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(stderrLine(result), /decision=block/);
    const canonical = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
    assert.equal(canonical.schema, REVOKED_SCHEMA);
    const tombstones = readdirSync(fixture.notesDir).filter((name) =>
      name.startsWith(`openspec-validate-${CHANGE}.invalidated-`),
    );
    assert.equal(tombstones.length, 1, "the renamed-in dump must be preserved as a tombstone");
  } finally {
    fixture.cleanup();
  }
});

test("invalidate-first chain failure fails closed with receipt-invalidate-failed", () => {
  if (process.platform === "win32") return; // POSIX read-only directory semantics
  const fixture = makeFixture({ priorReceipt: "acceptable", notesMode: "read-only" });
  try {
    const result = runDelta(fixture);
    assert.equal(result.status, 1, stderrLine(result));
    assert.match(result.stderr, /receipt-invalidate-failed/);
  } finally {
    fixture.cleanup();
  }
});

test("cleanup failure fails closed with cleanup-failed and no receipt", () => {
  const fixture = makeFixture();
  const realSpawn = spawnSync;
  try {
    const result = runDeltaInProcess(fixture, {
      spawnSync: (command, args, opts) => {
        if (command === "git" && args.includes("worktree") && args.includes("remove")) {
          return { status: 1, stdout: "", stderr: "forced worktree remove failure", error: undefined };
        }
        return realSpawn(command, args, opts);
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "cleanup-failed");
    assert.equal(acceptance(fixture).acceptable, false);
    assert.equal(existsSync(fixture.markerPath), true);
  } finally {
    fixture.cleanup();
  }
});

test("a signaled or null-status validator with parseable stdout is rejected as cli-exec-failed", async (t) => {
  const payload = JSON.stringify({
    items: [{ type: "spec", id: "alpha", valid: true, issues: [] }],
    summary: {},
    version: "1.11.0",
    root: "/tmp/x",
  });
  for (const [name, side] of [
    ["base validator signaled", "base"],
    ["head validator has null status", "head"],
  ]) {
    await t.test(name, () => {
      const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
      const realSpawn = spawnSync;
      const isBaseRun = (opts) => typeof opts?.cwd === "string" && opts.cwd.endsWith("base-wt");
      try {
        const result = runDeltaInProcess(fixture, {
          spawnSync: (command, args, opts) => {
            if (Array.isArray(args) && args.includes("validate") && (side === "base") === isBaseRun(opts)) {
              return side === "base"
                ? { status: null, signal: "SIGKILL", stdout: payload, stderr: "", error: undefined }
                : { status: null, signal: null, stdout: payload, stderr: "", error: undefined };
            }
            return realSpawn(command, args, opts);
          },
        });
        assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
        assert.equal(result.code, `cli-exec-failed:${side}`);
        assert.equal(existsSync(fixture.receiptPath), false, "no receipt may be published");
        assert.equal(acceptance(fixture).acceptable, false);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

// ── post-publication guard (D5) ────────────────────────────────────────────

test("post-publication drift revokes via the fallback chain: head-mutated-during-publication", () => {
  const fixture = makeFixture();
  try {
    const headSha = git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    let probes = 0;
    const result = runDeltaInProcess(fixture, {
      probeHeadState: () => {
        probes += 1;
        // 1: pre-guard, 2: head-run pre, 3: head-run post, 4: final guards,
        // 5: post-publication guard — only the last one sees drift.
        return probes <= 4
          ? { ok: true, sha: headSha, clean: true }
          : { ok: true, sha: headSha, clean: false };
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "head-mutated-during-publication");
    assert.equal(acceptance(fixture).acceptable, false);
    assert.equal(existsSync(fixture.markerPath), true, "revocation marker must be durable in place");
  } finally {
    fixture.cleanup();
  }
});

test("post-publication drift with every durable step failing is receipt-unpublish-failed", () => {
  const fixture = makeFixture();
  try {
    const headSha = git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
    let probes = 0;
    // The injected chain deps must leave invalidate-first working (its marker
    // write is the first durable call) and only fail the post-publication chain.
    let durableWrites = 0;
    const result = runDeltaInProcess(fixture, {
      probeHeadState: () => {
        probes += 1;
        return probes <= 4
          ? { ok: true, sha: headSha, clean: true }
          : { ok: true, sha: headSha, clean: false };
      },
      invalidationDeps: {
        replaceDurableFile: (args) => {
          durableWrites += 1;
          if (durableWrites === 1) return replaceDurableFile(args);
          throw new Error("forced durable write failure");
        },
        renameSync: () => {
          throw new Error("forced rename failure");
        },
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "receipt-unpublish-failed");
    // No durable revocation step held, so the flow stops with an explicit
    // instruction that no receipt may be cited (design D5 post-publication).
    assert.match(result.messages.map((entry) => entry.text).join(""), /no receipt for this change may be cited/);
  } finally {
    fixture.cleanup();
  }
});

test("post-commitment failure reasserts durable invalidation after an overlapping attempt removes the marker", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  const realSpawn = spawnSync;
  try {
    const result = runDeltaInProcess(fixture, {
      spawnSync: (command, args, opts) => {
        const isBaseRun = typeof opts?.cwd === "string" && opts.cwd.endsWith("base-wt");
        if (Array.isArray(args) && args.includes("validate") && !isBaseRun) {
          // Overlapping same-change attempt: it removes this attempt's marker and
          // publishes its own pass receipt, then this attempt's head run fails.
          rmSync(fixture.markerPath, { force: true });
          const headSha = git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim();
          writeFileSync(fixture.receiptPath, `${JSON.stringify({ schema: SCHEMA_V2, head_sha: headSha, decision: "pass" })}\n`);
          return { status: null, signal: "SIGKILL", stdout: "", stderr: "", error: undefined };
        }
        return realSpawn(command, args, opts);
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "cli-exec-failed:head");
    // The failure must have reasserted a durable invalidator, so the overlapping
    // attempt's pass receipt is not acceptable evidence.
    assert.equal(existsSync(fixture.markerPath), true, "a durable invalidator must be re-established");
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("decision=block reasserts durable invalidation when invalidate-first held only via revocation", () => {
  const fixture = makeFixture({
    baseItems: [specOk("alpha")],
    headItems: [specOk("alpha"), { id: "gamma", valid: false, issues: [{ level: "ERROR", path: "x", message: "boom" }] }],
  });
  let durableWrites = 0;
  try {
    const result = runDeltaInProcess(fixture, {
      invalidationDeps: {
        replaceDurableFile: (args) => {
          durableWrites += 1;
          if (durableWrites === 1) throw new Error("forced marker write failure");
          return replaceDurableFile(args);
        },
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.decision, "block");
    assert.equal(existsSync(fixture.markerPath), true, "block must reassert a durable invalidator");
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("failed run retains its own durable marker over an overlapping attempt's marker", () => {
  const fixture = makeFixture({ baseItems: [specOk("alpha")], headItems: [specOk("alpha")] });
  const realSpawn = spawnSync;
  try {
    const result = runDeltaInProcess(fixture, {
      spawnSync: (command, args, opts) => {
        const isBaseRun = typeof opts?.cwd === "string" && opts.cwd.endsWith("base-wt");
        if (Array.isArray(args) && args.includes("validate") && !isBaseRun) {
          // Overlapping attempt B owns the marker at this failure's exit time.
          // The failing attempt must not merely observe it: B could publish and
          // remove its own marker before this attempt returns.
          writeFileSync(fixture.markerPath, `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-other", at: "2026-09-25T00:00:00.000Z" }, null, 2)}\n`);
          return { status: null, signal: "SIGKILL", stdout: "", stderr: "", error: undefined };
        }
        return realSpawn(command, args, opts);
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.messages));
    assert.equal(result.code, "cli-exec-failed:head");
    const marker = JSON.parse(readFileSync(fixture.markerPath, "utf8"));
    assert.notEqual(marker.attempt_id, "attempt-other", "the failing run must retain its own durable marker at exit");
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

// ── acceptance predicate and marker supersession (D5) ──────────────────────

test("receipt acceptance predicate: schema v2 + head match + clean + marker absent", () => {
  const fixture = makeFixture();
  try {
    assert.equal(runDelta(fixture).status, 0);
    assert.equal(acceptance(fixture).acceptable, true);

    // (d) marker present → unacceptable even with a valid v2 receipt.
    writeFileSync(fixture.markerPath, `${JSON.stringify({ kind: "invalidated" })}\n`);
    assert.equal(acceptance(fixture).markerPresent, true);
    assert.equal(acceptance(fixture).acceptable, false);
    rmSync(fixture.markerPath, { force: true });
    assert.equal(acceptance(fixture).acceptable, true);

    // (a) revoked/other schema → unacceptable.
    const original = readFileSync(fixture.receiptPath);
    writeFileSync(fixture.receiptPath, `${JSON.stringify({ schema: REVOKED_SCHEMA })}\n`);
    assert.equal(acceptance(fixture).acceptable, false);
    writeFileSync(fixture.receiptPath, original);
    assert.equal(acceptance(fixture).acceptable, true);

    // (c) dirty worktree → unacceptable.
    writeFileSync(path.join(fixture.root, "dirty-probe.txt"), "dirty\n");
    assert.equal(acceptance(fixture).acceptable, false);
    rmSync(path.join(fixture.root, "dirty-probe.txt"), { force: true });

    // (b) head mismatch → unacceptable.
    const parsed = readJson(fixture.receiptPath);
    parsed.head_sha = "a".repeat(40);
    writeFileSync(fixture.receiptPath, `${JSON.stringify(parsed)}\n`);
    assert.equal(acceptance(fixture).acceptable, false);
  } finally {
    fixture.cleanup();
  }
});

test("interrupted publication leaves receipt plus marker unacceptable; a later publish supersedes", () => {
  const fixture = makeFixture();
  try {
    const candidateDir = path.join(fixture.notesDir, "tmp", `openspec-validate-${CHANGE}`, "attempt-interrupted");
    mkdirSync(candidateDir, { recursive: true });
    const candidatePath = path.join(candidateDir, "receipt.json");
    const bodyFor = (attemptId) =>
      `${JSON.stringify(
        {
          schema: SCHEMA_V2,
          attempt_id: attemptId,
          change: CHANGE,
          head_sha: git(fixture.root, ["rev-parse", "HEAD"]).stdout.trim(),
          decision: "pass",
        },
        null,
        2,
      )}\n`;
    const first = publishReceipt({
      root: fixture.realRoot,
      notesRoot: fixture.notesDir,
      change: CHANGE,
      attemptId: "attempt-interrupted",
      body: bodyFor("attempt-interrupted"),
      candidatePath,
      reason: "invalidate-first",
      at: "2026-01-01T00:00:00.000Z",
      deps: {
        unlinkSync: (target) => {
          if (target === fixture.markerPath) throw new Error("forced marker unlink failure");
          return unlinkSync(target);
        },
      },
    });
    assert.equal(first.ok, false);
    assert.equal(first.code, "receipt-publish-blocked");
    assert.equal(existsSync(fixture.markerPath), true);
    assert.equal(existsSync(fixture.receiptPath), true);
    assert.equal(existsSync(candidatePath), true, "the candidate receipt is retained for diagnosis");
    assert.deepEqual(readFileSync(candidatePath), readFileSync(fixture.receiptPath));
    assert.equal(acceptance(fixture).acceptable, false, "mid-publication state must not be acceptable");

    // A real later run invalidates first (writing its own attempt-owned marker)
    // before publishing; publishing without that step is blocked by design.
    const invalidated = runInvalidationFallbackChain({
      root: fixture.realRoot,
      notesRoot: fixture.notesDir,
      change: CHANGE,
      attemptId: "attempt-superseding",
      reason: "invalidate-first",
      at: "2026-01-01T00:00:01.000Z",
    });
    assert.equal(invalidated.ok, true);

    const second = publishReceipt({
      root: fixture.realRoot,
      notesRoot: fixture.notesDir,
      change: CHANGE,
      attemptId: "attempt-superseding",
      body: bodyFor("attempt-superseding"),
      reason: "invalidate-first",
      at: "2026-01-01T00:00:01.000Z",
    });
    assert.equal(second.ok, true);
    assert.equal(existsSync(fixture.markerPath), false, "successful publication removes the marker last");
    assert.equal(readJson(fixture.receiptPath).attempt_id, "attempt-superseding");
    assert.equal(acceptance(fixture).acceptable, true);
  } finally {
    fixture.cleanup();
  }
});

// ── exported guard functions (cases not injectable through the CLI) ────────

test("invalidation fallback chain: marker failure falls through to durable revocation", () => {
  const root = makeTempDir("delta-chain-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const receiptPath = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
  writeFileSync(receiptPath, `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`);
  try {
    const result = runInvalidationFallbackChain({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-chain-1",
      reason: "invalidate-first",
      deps: {
        replaceDurableFile: (args) => {
          if (args.target === markerPath) throw new Error("forced marker failure");
          return replaceDurableFile(args);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "revocation");
    assert.equal(readJson(receiptPath).schema, REVOKED_SCHEMA);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalidation fallback chain: rename plus post-rename revocation retry is the third durable step", () => {
  const root = makeTempDir("delta-chain-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const receiptPath = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
  writeFileSync(receiptPath, `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`);
  try {
    let receiptWrites = 0;
    const result = runInvalidationFallbackChain({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-chain-3",
      reason: "invalidate-first",
      deps: {
        replaceDurableFile: (args) => {
          if (args.target === markerPath) throw new Error("forced marker failure");
          if (args.target === receiptPath) {
            receiptWrites += 1;
            if (receiptWrites === 1) throw new Error("forced revocation failure");
          }
          return replaceDurableFile(args);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "rename+revocation");
    assert.equal(result.rename_durability, process.platform === "win32" ? "dir-fsync-unsupported" : "fsync-verified");
    assert.equal(readJson(receiptPath).schema, REVOKED_SCHEMA);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalidation fallback chain: rename alone never counts without the revocation retry", () => {
  const root = makeTempDir("delta-chain-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const receiptPath = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
  writeFileSync(receiptPath, `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`);
  try {
    const result = runInvalidationFallbackChain({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-chain-4",
      reason: "invalidate-first",
      platform: "win32",
      deps: {
        replaceDurableFile: () => {
          throw new Error("forced durable write failure");
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.via, null);
    assert.equal(result.rename_durability, "dir-fsync-unsupported");
    assert.equal(existsSync(receiptPath), false, "the canonical path stays released after the rename");
    assert.equal(
      readdirSync(notesDir).some((name) => name.startsWith(`openspec-validate-${CHANGE}.invalidated-`)),
      true,
      "the rename happened and is preserved as a tombstone",
    );
    assert.deepEqual(
      result.failures.map((failure) => failure.step),
      ["marker", "revocation", "rename-revocation-retry"],
    );
    assert.equal(existsSync(markerPath), false, "the marker write failed, so no invalidator marker exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("win32 shell-backed openspec spawn: shell options and argv allowlist", () => {
  assert.deepEqual(openspecDeltaSpawnOptions({ cwd: "/wt", maxBuffer: 8, platform: "win32" }), {
    cwd: "/wt",
    encoding: "utf8",
    maxBuffer: 8,
    shell: true,
  });
  assert.deepEqual(openspecDeltaSpawnOptions({ platform: "linux" }), { encoding: "utf8" });
  assert.equal(
    assertWin32OpenspecDeltaSpawnArgs(["validate", "--strict", "--specs", "--no-interactive", "--json"], { platform: "win32" }).ok,
    true,
  );
  assert.equal(assertWin32OpenspecDeltaSpawnArgs(["--version"], { platform: "win32" }).ok, true);
  assert.equal(assertWin32OpenspecDeltaSpawnArgs(["validate;rm -rf /"], { platform: "win32" }).ok, false);
  assert.equal(assertWin32OpenspecDeltaSpawnArgs(["--evil|x"], { platform: "win32" }).ok, false);
  assert.equal(assertWin32OpenspecDeltaSpawnArgs(["validate;rm -rf /"], { platform: "linux" }).ok, true);
  assert.equal(
    openspecDeltaSpawnTarget("C:\\Program Files\\nodejs\\openspec.cmd", { platform: "win32" }),
    "\"C:\\Program Files\\nodejs\\openspec.cmd\"",
  );
  assert.equal(openspecDeltaSpawnTarget("/usr/local/bin/openspec", { platform: "linux" }), "/usr/local/bin/openspec");
});

test("overlapping runs: a foreign invalidator marker blocks publication", () => {
  const root = makeTempDir("delta-ownership-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  writeFileSync(
    markerPath,
    `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-other", at: "2026-09-25T00:00:00.000Z" }, null, 2)}\n`,
  );
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    assert.equal(existsSync(path.join(notesDir, `openspec-validate-${CHANGE}.json`)), false, "no canonical receipt may be written");
    assert.equal(readFileSync(markerPath, "utf8").includes("attempt-other"), true, "the foreign marker is left untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping runs: losing marker ownership before commit invalidates the new receipt", () => {
  const root = makeTempDir("delta-ownership-race-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const ownMarker = `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-a", at: "2026-09-25T00:00:01.000Z" }, null, 2)}\n`;
  writeFileSync(markerPath, ownMarker);
  let markerReads = 0;
  const realRead = readFileSync;
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        readNoFollowFile: ({ target }) => {
          if (target !== markerPath) {
            return { bytes: realRead(target), stat: {} };
          }
          markerReads += 1;
          return {
            bytes: Buffer.from(markerReads <= 2 ? ownMarker : `${JSON.stringify({ kind: "invalidated", attempt_id: "attempt-other" }, null, 2)}\n`, "utf8"),
            stat: {},
          };
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    const canonical = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
    const acceptable = (() => {
      if (existsSync(markerPath)) return false; // marker present -> not acceptable
      if (!existsSync(canonical)) return false;
      try {
        const parsed = JSON.parse(realRead(canonical, "utf8"));
        return parsed.schema === SCHEMA_V2;
      } catch {
        return false;
      }
    })();
    assert.equal(acceptable, false, "the receipt written by this attempt must not remain acceptable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("total invalidation failure after marker loss surfaces receipt-unpublish-failed", () => {
  const root = makeTempDir("delta-unpublish-total-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const ownMarker = `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-a", at: "2026-09-25T00:00:01.000Z" }, null, 2)}\n`;
  writeFileSync(markerPath, ownMarker);
  let markerReads = 0;
  let durableWrites = 0;
  const realRead = readFileSync;
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        // Ownership is lost by the commit read ...
        readNoFollowFile: ({ target }) => {
          if (target !== markerPath) return { bytes: realRead(target), stat: {} };
          markerReads += 1;
          return {
            bytes: Buffer.from(markerReads <= 2 ? ownMarker : `${JSON.stringify({ kind: "invalidated", attempt_id: "attempt-other" }, null, 2)}\n`, "utf8"),
            stat: {},
          };
        },
        // ... and every durable invalidation step then fails (the receipt write
        // itself is the first durable call and must still succeed).
        replaceDurableFile: (args) => {
          durableWrites += 1;
          if (durableWrites >= 2) throw new Error("forced durable write failure");
          return replaceDurableFile(args);
        },
        renameSync: () => {
          throw new Error("forced rename failure");
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-unpublish-failed");
    assert.match(result.reason, /durable invalidation could not be established/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interruption at the publication commit leaves the marker present and never moves it", () => {
  const root = makeTempDir("delta-commit-interrupt-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const receiptPath = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
  const ownMarker = `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-a", at: "2026-09-25T00:00:01.000Z" }, null, 2)}\n`;
  writeFileSync(markerPath, ownMarker);
  const renameSources = [];
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        renameSync: (from, to) => {
          renameSources.push(from);
          return renameSync(from, to);
        },
        unlinkSync: (target) => {
          if (target === markerPath) throw new Error("forced commit interruption");
          return unlinkSync(target);
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    assert.equal(existsSync(markerPath), true, "an interrupted commit leaves the marker present");
    assert.equal(renameSources.includes(markerPath), false, "the marker is never renamed");
    const acceptable = !existsSync(markerPath) && existsSync(receiptPath) && (() => {
      try {
        return JSON.parse(readFileSync(receiptPath, "utf8")).schema === SCHEMA_V2;
      } catch {
        return false;
      }
    })();
    assert.equal(acceptable, false, "an interrupted commit must not leave acceptable evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping runs: atomic marker acquisition loses the race without clobbering", () => {
  const root = makeTempDir("delta-acquire-race-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const foreignMarker = `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-other", at: "2026-09-25T00:00:00.000Z" }, null, 2)}\n`;
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        // Simulate the concurrent winner: the foreign marker appears between
        // the absence observation and the exclusive create.
        exclusiveCreateFile: ({ path: target, body }) => {
          writeFileSync(target, foreignMarker);
          return "exists";
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    assert.equal(readFileSync(markerPath, "utf8"), foreignMarker, "the concurrent attempt's marker is preserved verbatim");
    assert.equal(existsSync(path.join(notesDir, `openspec-validate-${CHANGE}.json`)), false, "no canonical receipt may be written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication commit clears only its own marker", () => {
  const root = makeTempDir("delta-commit-own-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const receiptPath = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
  const unlinked = [];
  const renameSources = [];
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        unlinkSync: (target) => {
          unlinked.push(target);
          return unlinkSync(target);
        },
        renameSync: (from, to) => {
          renameSources.push(from);
          return renameSync(from, to);
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(markerPath), false, "a successful commit removes its own marker");
    assert.equal(unlinked.includes(markerPath), true, "the owner unlinks its own marker");
    assert.equal(renameSources.includes(markerPath), false, "the marker is never renamed");
    const acceptable = !existsSync(markerPath) && existsSync(receiptPath);
    assert.equal(acceptable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign marker swapped in between establish and commit is never removed", () => {
  const root = makeTempDir("delta-commit-swap-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const receiptPath = path.join(notesDir, `openspec-validate-${CHANGE}.json`);
  const foreignMarker = `${JSON.stringify({ kind: "invalidated", reason: "invalidate-first", attempt_id: "attempt-other", at: "2026-09-25T00:00:00.000Z" }, null, 2)}\n`;
  const unlinked = [];
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        // Cooperating attempt-b replaces the marker after this attempt released
        // the establish lock and before it re-acquires the commit lock: model it
        // as a side effect of this attempt's canonical receipt write.
        replaceDurableFile: (args) => {
          if (args.target === receiptPath) writeFileSync(markerPath, foreignMarker);
          return replaceDurableFile(args);
        },
        unlinkSync: (target) => {
          unlinked.push(target);
          return unlinkSync(target);
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    assert.equal(unlinked.includes(markerPath), false, "the commit must never unlink the marker");
    assert.equal(existsSync(markerPath), true, "the acceptance path keeps a marker");
    const acceptable = !existsSync(markerPath) && existsSync(receiptPath) && (() => {
      try {
        return JSON.parse(readFileSync(receiptPath, "utf8")).schema === SCHEMA_V2;
      } catch {
        return false;
      }
    })();
    assert.equal(acceptable, false, "the receipt must not read as acceptable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign per-change lock fails closed without touching the marker", () => {
  const root = makeTempDir("delta-lock-foreign-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  const markerPath = path.join(notesDir, `openspec-validate-${CHANGE}.invalidated`);
  const lockPath = path.join(notesDir, `openspec-validate-${CHANGE}.lock`);
  const foreignLock = `${JSON.stringify({ schema: "devpro-openspec-validate-delta/lock/v1", attempt_id: "attempt-other", pid: 999999, host: "other-host", at: "2026-09-25T00:00:00.000Z" }, null, 2)}\n`;
  writeFileSync(lockPath, foreignLock);
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    assert.match(result.reason, /holds the invalidator lock/);
    assert.equal(existsSync(markerPath), false, "no marker may be established while the lock is held by another attempt");
    assert.equal(readFileSync(lockPath, "utf8"), foreignLock, "the foreign lock is preserved verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate spec ids are a shape violation, not last-write-wins", () => {
  const invalidThenValid = JSON.stringify({
    items: [
      { type: "spec", id: "dup-spec", valid: false, issues: [{ level: "ERROR", path: "x", message: "boom" }] },
      { type: "spec", id: "dup-spec", valid: true, issues: [] },
    ],
  });
  const validThenInvalid = JSON.stringify({
    items: [
      { type: "spec", id: "dup-spec", valid: true, issues: [] },
      { type: "spec", id: "dup-spec", valid: false, issues: [{ level: "ERROR", path: "x", message: "boom" }] },
    ],
  });
  const base = parseValidatePayload(invalidThenValid, "base");
  assert.equal(base.ok, false);
  assert.equal(base.code, "unknown-item-shape:base");
  assert.match(base.reason, /duplicate spec item id/);
  const head = parseValidatePayload(validThenInvalid, "head");
  assert.equal(head.ok, false);
  assert.equal(head.code, "unknown-item-shape:head");
});

test("items with a missing or unrecognized type are rejected, not skipped", () => {
  const unrecognized = JSON.stringify({
    items: [
      { type: "spec", id: "alpha", valid: true, issues: [] },
      { type: "mystery", id: "alpha", valid: false, issues: [{ level: "ERROR", path: "x", message: "boom" }] },
    ],
  });
  const missing = JSON.stringify({
    items: [
      { id: "alpha", valid: false, issues: [{ level: "ERROR", path: "x", message: "boom" }] },
    ],
  });
  const base = parseValidatePayload(unrecognized, "base");
  assert.equal(base.ok, false);
  assert.equal(base.code, "unknown-item-shape:base");
  assert.match(base.reason, /missing or unrecognized type/);
  const head = parseValidatePayload(missing, "head");
  assert.equal(head.ok, false);
  assert.equal(head.code, "unknown-item-shape:head");
});

test("publishReceipt fails closed when marker parent-directory durability cannot be established", () => {
  const root = makeTempDir("delta-marker-durability-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  try {
    const result = publishReceipt({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-a",
      reason: "invalidate-first",
      at: "2026-09-25T00:00:01.000Z",
      body: `${JSON.stringify({ schema: SCHEMA_V2, decision: "pass" })}\n`,
      deps: {
        fsyncDirectory: () => {
          throw new Error("dir fsync unavailable");
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "receipt-publish-blocked");
    assert.equal(existsSync(path.join(notesDir, `openspec-validate-${CHANGE}.json`)), false, "no receipt may be written before durable acquisition");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalidation fallback chain: no durable step at all is a named chain failure", () => {
  const root = makeTempDir("delta-chain-");
  const notesDir = path.join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    path.join(notesDir, `openspec-validate-${CHANGE}.json`),
    `${JSON.stringify({ schema: SCHEMA_V2 })}\n`,
  );
  try {
    const result = runInvalidationFallbackChain({
      root,
      notesRoot: notesDir,
      change: CHANGE,
      attemptId: "attempt-chain-5",
      reason: "invalidate-first",
      deps: {
        replaceDurableFile: () => {
          throw new Error("forced durable write failure");
        },
        renameSync: () => {
          throw new Error("forced rename failure");
        },
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.failures.map((failure) => failure.step),
      ["marker", "revocation", "rename"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("base snapshot state evaluation separates HEAD mismatch, tracked dirt and ignored dirt", () => {
  const baseSha = "a".repeat(40);
  const runGitFrom = (headOut, statusOut) => (cwd, args) =>
    args[0] === "rev-parse"
      ? { ok: true, status: 0, stdout: headOut }
      : { ok: true, status: 0, stdout: statusOut };
  const clean = evaluateBaseSnapshotState({ runGit: runGitFrom(`${baseSha}\n`, ""), baseWt: "x", baseSha });
  assert.deepEqual(clean, {
    head_matches_base_sha: true,
    porcelain_empty_tracked_staged_untracked: true,
    ignored_empty: true,
    ok: true,
  });
  assert.equal(
    evaluateBaseSnapshotState({ runGit: runGitFrom(`${"b".repeat(40)}\n`, ""), baseWt: "x", baseSha }).ok,
    false,
  );
  const trackedDirt = evaluateBaseSnapshotState({
    runGit: runGitFrom(`${baseSha}\n`, " M openspec/specs/alpha/spec.md\n"),
    baseWt: "x",
    baseSha,
  });
  assert.deepEqual(
    { tracked: trackedDirt.porcelain_empty_tracked_staged_untracked, ignored: trackedDirt.ignored_empty, ok: trackedDirt.ok },
    { tracked: false, ignored: true, ok: false },
  );
  const ignoredDirt = evaluateBaseSnapshotState({
    runGit: runGitFrom(`${baseSha}\n`, "!! ignored-artifact.tmp\n"),
    baseWt: "x",
    baseSha,
  });
  assert.deepEqual(
    { tracked: ignoredDirt.porcelain_empty_tracked_staged_untracked, ignored: ignoredDirt.ignored_empty, ok: ignoredDirt.ok },
    { tracked: true, ignored: false, ok: false },
  );
  const probeFailure = evaluateBaseSnapshotState({
    runGit: (cwd, args) => ({ ok: false, status: null, stdout: "" }),
    baseWt: "x",
    baseSha,
  });
  assert.equal(probeFailure.ok, false);
});

test("normalization replaces both known roots with one fixed token", () => {
  const fingerprint = buildFingerprint(
    new Map([
      [
        "alpha",
        {
          valid: false,
          issues: [
            { level: "error", path: "openspec/specs/alpha/spec.md", message: "at /base/root/x" },
            { level: "error", path: "openspec/specs/alpha/spec.md", message: "at /head/root/y" },
          ],
        },
      ],
    ]),
    ["/base/root", "/head/root"],
  );
  assert.deepEqual(fingerprint, [
    {
      id: "alpha",
      valid: false,
      tokens: [
        "error|openspec/specs/alpha/spec.md|at <repo-root>/x",
        "error|openspec/specs/alpha/spec.md|at <repo-root>/y",
      ],
    },
  ]);
});

test("compareSpecResults derives new/changed/resolved sets and checked counts", () => {
  const fp = (id, valid, tokens = []) => ({ id, valid, tokens: [...tokens].sort() });
  const comparison = compareSpecResults({
    base: [fp("alpha", false, ["t1"]), fp("beta", false, ["t2"]), fp("delta", true)],
    head: [fp("alpha", false, ["t1", "t2"]), fp("beta", true), fp("gamma", false, ["t3"]), fp("delta", true)],
  });
  assert.deepEqual(comparison.newInvalid, ["gamma"]);
  assert.deepEqual(comparison.changedInvalid, ["alpha"]);
  assert.deepEqual(comparison.resolved, ["beta"]);
  assert.equal(comparison.inherited, 0);
  assert.equal(comparison.checkedSpecs, 4);
  assert.equal(comparison.decision, "block");
  const passing = compareSpecResults({
    base: [fp("alpha", false, ["t1"]), fp("beta", true)],
    head: [fp("alpha", false, ["t1"]), fp("beta", true)],
  });
  assert.equal(passing.decision, "pass");
  assert.equal(passing.inherited, 1);
  assert.equal(passing.checkedSpecs, 2);
});

test("snapshot read-only mode is best-effort detection-only when chmod is unavailable", () => {
  assert.equal(applySnapshotReadOnly({ baseWt: "x", platform: "win32", chmodRemoveWrite: () => {} }).snapshotMode, "detection-only");
  assert.equal(
    applySnapshotReadOnly({
      baseWt: "x",
      platform: "darwin",
      chmodRemoveWrite: () => {
        throw new Error("chmod unavailable");
      },
    }).snapshotMode,
    "detection-only",
  );
  assert.equal(
    applySnapshotReadOnly({ baseWt: "x", platform: "darwin", chmodRemoveWrite: () => {} }).snapshotMode,
    "posix-read-only",
  );
});

test("attempt log framing appends a named stderr section only when stderr is present", () => {
  assert.equal(buildAttemptLogBytes({ stdout: "out", stderr: "" }).toString("utf8"), "out");
  assert.equal(buildAttemptLogBytes({ stdout: "out", stderr: "err" }).toString("utf8"), "out\n[stderr]\nerr");
  const attemptDir = makeTempDir("delta-log-");
  try {
    const written = writeAttemptLog({ root: attemptDir, attemptDir, side: "base", stdout: "out", stderr: "" });
    assert.equal(path.basename(written.path), "base.log");
    assert.equal(readFileSync(written.path, "utf8"), "out");
    assert.equal(written.digest, sha256(Buffer.from("out")));
  } finally {
    rmSync(attemptDir, { recursive: true, force: true });
  }
});

test("a symlinked attempt-log leaf is rejected instead of followed", () => {
  const root = makeTempDir("delta-log-leaf-");
  const external = path.join(root, "external.log");
  try {
    writeFileSync(external, "sentinel\n");
    symlinkSync(external, path.join(root, "base.log"));
    assert.throws(
      () => writeAttemptLog({ root, attemptDir: root, side: "base", stdout: "out", stderr: "" }),
      /EEXIST/,
    );
    assert.equal(readFileSync(external, "utf8"), "sentinel\n", "the symlink target must be untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupSnapshot reports each cleanup problem instead of masking it", () => {
  const result = cleanupSnapshot({
    cwd: "ignored",
    tempRoot: "/nonexistent-root",
    baseWt: "/nonexistent-root/base-wt",
    worktreeAdded: true,
    deps: {
      chmodRecursiveAddWrite: () => {
        throw new Error("forced chmod failure");
      },
      spawnSync: () => ({ status: 1, stdout: "", stderr: "forced remove failure", error: undefined }),
      rmSync: () => {
        throw new Error("forced rm failure");
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.match(result.problems[0], /chmod/);
  assert.match(result.problems[1], /worktree remove/);
  assert.match(result.problems[2], /temp root/);
});

test("resolveExecutableOnPath resolves the first executable on PATH and fails otherwise", () => {
  const dir = makeTempDir("delta-exe-");
  const emptyDir = makeTempDir("delta-empty-");
  try {
    const exe = path.join(dir, "openspec");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveExecutableOnPath({ env: { PATH: dir }, platform: "linux" }), exe);
    assert.equal(resolveExecutableOnPath({ env: { PATH: emptyDir }, platform: "linux" }), null);
    const relativeDir = path.relative(process.cwd(), dir);
    assert.equal(
      resolveExecutableOnPath({ env: { PATH: relativeDir }, platform: "linux" }),
      exe,
      "a relative PATH entry must be pinned to an absolute target",
    );
    const winDir = makeTempDir("delta-win-");
    writeFileSync(path.join(winDir, "openspec.cmd"), "@echo off\r\n", { mode: 0o755 });
    // Case-insensitive filesystems resolve the PATHEXT probe to the existing
    // file; compare case-insensitively because the returned string keeps the
    // extension spelling used by the probe.
    assert.equal(
      resolveExecutableOnPath({ env: { Path: winDir, PATHEXT: ".CMD;.EXE" }, platform: "win32" }).toLowerCase(),
      path.join(winDir, "openspec.cmd").toLowerCase(),
    );
    rmSync(winDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
