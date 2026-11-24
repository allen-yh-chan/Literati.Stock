/**
 * Windows consumer parity — exec-bit check fail-closed, batch chmod / index.lock,
 * and release/* skip of index mode (fix-windows-consumer-parity D1–D3).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECK_STEPS,
  SYNC_STEPS,
  formatExecBitIndexFailure,
  resolveGitIndexLockPath,
  flushExecBitIndexModes,
  resetPendingExecBitRelPaths,
  applyExecBitMode,
  isReleaseRulesBranch,
  assertExecBitParity,
  checkExecBitParity,
  resetSourceExecBitPathsMemo,
  classifySourceRepoProbe,
  TEST_SYNC_SOURCE_ROOT_ENV,
} from "../sync-agent-rules.mjs";
import {
  HOOKS_PATH_GIT_TIMEOUT_MS,
  configureFixtureGit,
  fixtureGitEnv,
  run,
  withConsumerRepo,
} from "./lib/sync-agent-rules-harness.mjs";
import { REPO_ROOT as sourceRoot } from "./lib/repo-root.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: fixtureGitEnv(cwd) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function initFixtureRepo(cwd, branch = "main") {
  const env = fixtureGitEnv(cwd, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  });
  const result = spawnSync("git", ["init", "-q", "-b", branch], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  configureFixtureGit(cwd, { overrides: {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.com",
  } });
  return env;
}

function gitSpawn(cwd, args, options = {}) {
  return spawnSync("git", args, {
    ...options,
    cwd,
    encoding: options.encoding ?? "utf8",
    env: { ...fixtureGitEnv(cwd), ...(options.env ?? {}) },
  });
}

describe("windows-parity exec-bit --check fail-closed (D1/T1+T5)", { concurrency: false }, () => {
  it("CHECK_STEPS includes checkExecBitParity and SYNC_STEPS flush before warn", () => {
    const checkNames = CHECK_STEPS.map((step) => step.run?.name || step.name);
    const syncNames = SYNC_STEPS.map((step) => step.run?.name || step.name);
    assert.ok(
      checkNames.includes("checkExecBitParity"),
      `CHECK_STEPS must include checkExecBitParity; got ${checkNames.join(",")}`
    );
    const flushIdx = syncNames.indexOf("flushExecBitIndexModes");
    const warnIdx = syncNames.indexOf("warnExecBitMismatch");
    assert.ok(flushIdx >= 0, "SYNC_STEPS must include flushExecBitIndexModes");
    assert.ok(warnIdx > flushIdx, "flushExecBitIndexModes must run before warnExecBitMismatch");
  });

  it("--check fails on synced 100755 drift and must not print in-sync green", async () => {
    await withConsumerRepo(async (ctx) => {
      initFixtureRepo(ctx.tmpDir);
      const syncResult = run(ctx.syncScript, "--sync", {
        cwd: ctx.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);

      const rel = ".devpro/scripts/hooks-git/pre-push";
      // Drop the executable bit from the consumer index to create mode drift.
      gitSpawn(ctx.tmpDir, ["update-index", "--chmod=-x", "--", rel]);
      const staged = git(ctx.tmpDir, ["ls-files", "--stage", "--", rel]).trim();
      assert.match(staged, /^100644\s/, "prove-it setup: consumer index must show 100644 drift");

      const checkResult = run(ctx.syncScript, "--check", {
        cwd: ctx.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.notEqual(checkResult.exitCode, 0, "mode drift must fail --check");
      assert.doesNotMatch(
        checkResult.stdout,
        /All derived files are in sync/,
        "must not print green in-sync on 100755 drift"
      );
      assert.match(
        `${checkResult.stderr}\n${checkResult.stdout}`,
        /100755/,
        "failure must mention 100755"
      );
    });
  });

  it("Check Warns Without Failing On Consumer-Local Extra 100755", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });

      // Consumer-owned git hook under the source-owned core.hooksPath dir.
      // The source repo does not track this path, so it is consumer-local:
      // --sync must preserve it (content + 100755 index mode) and --check must
      // warn without failing.
      const rel = ".devpro/scripts/hooks-git/pre-commit";
      const abs = path.join(ctx.tmpDir, ...rel.split("/"));
      const hookBody = "#!/bin/sh\necho consumer pre-commit\nexit 0\n";
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, hookBody);
      if (process.platform !== "win32") await fs.chmod(abs, 0o755);
      spawnSync("git", ["update-index", "--add", "--chmod=+x", "--", rel], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
      });
      const stagedBefore = git(ctx.tmpDir, ["ls-files", "--stage", "--", rel]).trim();
      assert.match(
        stagedBefore,
        /^100755\s/,
        "prove-it setup: consumer-local hook must be 100755 in the consumer index"
      );
      assert.notEqual(
        spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
          cwd: sourceRoot,
          encoding: "utf8",
        }).status,
        0,
        "prove-it setup: source repo must not track the consumer-local hook"
      );

      const syncResult = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);
      assert.equal(await fs.readFile(abs, "utf8"), hookBody, "--sync must preserve the hook content");
      assert.match(
        git(ctx.tmpDir, ["ls-files", "--stage", "--", rel]).trim(),
        /^100755\s/,
        "--sync must preserve the consumer-local hook's 100755 index mode"
      );

      const checkResult = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir });
      const combined = `${checkResult.stderr}\n${checkResult.stdout}`;
      assert.equal(
        checkResult.exitCode,
        0,
        `consumer-local 100755 extra must not fail --check\n${combined}`
      );
      assert.match(combined, /consumer-local/, "must name the extra as consumer-local");
      assert.doesNotMatch(
        combined,
        /Run --sync to restore index mode/,
        "consumer-local extras must not point at --sync"
      );
    });
  });

  it("Check Fails On Bidirectional Extra Consumer 100755 (source tracks path, not 100755)", async () => {
    await withConsumerRepo(async (ctx) => {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: ctx.tmpDir, encoding: "utf8" });
      const syncResult = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);

      // Source tracks this path but not as 100755; consumer marks it 100755.
      // A source-tracked extra stays sync drift (not consumer-local).
      const rel = ".devpro/scripts/sync-agent-rules.mjs";
      spawnSync("git", ["update-index", "--add", "--chmod=+x", "--", rel], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
      });
      const staged = git(ctx.tmpDir, ["ls-files", "--stage", "--", rel]).trim();
      assert.match(staged, /^100755\s/, "prove-it setup: consumer index must show 100755 extra");
      assert.equal(
        spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
          cwd: sourceRoot,
          encoding: "utf8",
        }).status,
        0,
        "prove-it setup: source repo must track the path"
      );

      const checkResult = run(ctx.syncScript, "--check", { cwd: ctx.tmpDir });
      const combined = `${checkResult.stderr}\n${checkResult.stdout}`;
      assert.notEqual(
        checkResult.exitCode,
        0,
        "a source-tracked extra 100755 mismatch must fail --check"
      );
      assert.match(combined, /Exec-bit check failed/);
      assert.match(
        combined,
        /git update-index --chmod=-x/,
        "a source-tracked extra must point at removing the extra consumer index mode"
      );
      assert.doesNotMatch(
        combined,
        /Run --sync to restore index mode/,
        "a source-tracked extra must not be told to run --sync (it never clears the mode)"
      );
      assert.doesNotMatch(combined, /All derived files are in sync/);
    });
  });
});

describe("windows-parity batch update-index + index.lock messaging (D2/T2+T6)", { concurrency: false }, () => {
  it("formatExecBitIndexFailure includes index.lock path and next action", async () => {
    await withConsumerRepo(async (ctx) => {
      initFixtureRepo(ctx.tmpDir);
      const lockPath = resolveGitIndexLockPath(ctx.tmpDir);
      assert.match(lockPath, /index\.lock/);
      const message = formatExecBitIndexFailure(ctx.tmpDir, {
        status: 1,
        stderr: "fatal: Unable to create index.lock: File exists",
      });
      assert.match(message, /index\.lock/);
      assert.ok(message.includes(lockPath), `message must include lock path ${lockPath}`);
      assert.match(message, /Next action:/);
    });
  });

  it("flushExecBitIndexModes batches multiple pending paths in one update-index", async () => {
    await withConsumerRepo(async (ctx) => {
      initFixtureRepo(ctx.tmpDir);
      const syncResult = run(ctx.syncScript, "--sync", {
        cwd: ctx.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);

      // Strip +x then re-apply via apply+flush to prove batch path restores modes.
      // Collect a few synced 100755 paths from the consumer index for batch flush.
      const stagedAll = gitSpawn(ctx.tmpDir, ["ls-files", "-s"]).stdout;
      const rels = stagedAll
        .split("\n")
        .map((line) => {
          const tab = line.indexOf("\t");
          if (tab === -1) return null;
          const mode = line.slice(0, tab).trim().split(/\s+/)[0];
          const rel = line.slice(tab + 1);
          return mode === "100755" && rel.startsWith(".devpro/") ? rel : null;
        })
        .filter(Boolean)
        .slice(0, 3);
      assert.ok(rels.length >= 1, "expected at least one synced 100755 path");

      for (const rel of rels) {
        gitSpawn(ctx.tmpDir, ["update-index", "--chmod=-x", "--", rel]);
      }
      resetPendingExecBitRelPaths();
      for (const rel of rels) {
        await applyExecBitMode(ctx.tmpDir, rel);
      }
      await flushExecBitIndexModes(ctx.tmpDir);
      for (const rel of rels) {
        const staged = git(ctx.tmpDir, ["ls-files", "--stage", "--", rel]).trim();
        assert.match(staged, /^100755\s/, `batch flush must restore 100755 for ${rel}`);
      }
    });
  });
});

describe("windows-parity release/* skips index --chmod=+x (D3/T7)", { concurrency: false }, () => {
  it("flush on release/* does not restore index 100755", async () => {
    await withConsumerRepo(async (ctx) => {
      initFixtureRepo(ctx.tmpDir);
      const syncResult = run(ctx.syncScript, "--sync", {
        cwd: ctx.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);

      const rel = ".devpro/scripts/hooks-git/pre-push";
      gitSpawn(ctx.tmpDir, ["update-index", "--chmod=-x", "--", rel]);
      gitSpawn(ctx.tmpDir, ["checkout", "-q", "-b", "release/rules-20990101"]);
      assert.equal(isReleaseRulesBranch(ctx.tmpDir), true);

      resetPendingExecBitRelPaths();
      await applyExecBitMode(ctx.tmpDir, rel);
      await flushExecBitIndexModes(ctx.tmpDir);

      const staged = git(ctx.tmpDir, ["ls-files", "--stage", "--", rel]).trim();
      assert.match(
        staged,
        /^100644\s/,
        "release/* must skip index --chmod=+x (mode remains drifted)"
      );
    });
  });

  it("--check on release/* points next step to rules lane (not --sync chmod)", async () => {
    await withConsumerRepo(async (ctx) => {
      initFixtureRepo(ctx.tmpDir);
      const syncResult = run(ctx.syncScript, "--sync", {
        cwd: ctx.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.equal(syncResult.exitCode, 0, syncResult.stderr);
      const rel = ".devpro/scripts/hooks-git/pre-push";
      gitSpawn(ctx.tmpDir, ["update-index", "--chmod=-x", "--", rel]);
      gitSpawn(ctx.tmpDir, ["checkout", "-q", "-b", "release/rules-20990101"]);
      const checkResult = run(ctx.syncScript, "--check", {
        cwd: ctx.tmpDir,
        timeout: HOOKS_PATH_GIT_TIMEOUT_MS,
      });
      assert.notEqual(checkResult.exitCode, 0);
      const combined = `${checkResult.stderr}\n${checkResult.stdout}`;
      assert.match(combined, /Exec-bit check failed/);
      assert.match(combined, /rules lane/i);
      assert.doesNotMatch(
        combined,
        /Run --sync to restore index mode/,
        "release/* must not suggest --sync chmod as the green path"
      );
    });
  });
});

describe("windows-parity --sync re-exec through symlink/junction (dogfood)", { concurrency: false }, () => {
  it("symlink .devpro-agent-rules realpath does not infinite-reexec", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-reexec-"));
    try {
      initFixtureRepo(tmpDir);
      // Basename of real target ≠ `.devpro-agent-rules`; Node realpaths import.meta.url
      // through the symlink (darwin + win32), which previously looped re-exec forever.
      await fs.symlink(
        sourceRoot,
        path.join(tmpDir, ".devpro-agent-rules"),
        process.platform === "win32" ? "dir" : undefined
      );
      const script = path.join(
        tmpDir,
        ".devpro-agent-rules",
        ".devpro",
        "scripts",
        "sync-agent-rules.mjs"
      );
      const result = spawnSync(process.execPath, [script, "--sync"], {
        cwd: tmpDir,
        encoding: "utf8",
        timeout: 180_000,
        env: fixtureGitEnv(tmpDir),
      });
      assert.notEqual(
        result.signal,
        "SIGTERM",
        "must finish before spawn timeout (infinite re-exec regression)"
      );
      assert.equal(result.error, undefined, result.error?.message ?? "spawn error");
      const combined = `${result.stdout}\n${result.stderr}`;
      const reexecs = combined.match(/Re-executing submodule script/g) ?? [];
      assert.ok(
        reexecs.length <= 1,
        `expected ≤1 re-exec, got ${reexecs.length}\n${combined.slice(0, 2000)}`
      );
      assert.equal(result.status, 0, combined.slice(0, 4000));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review Critical (PR #2816): the source index must be read as ONE tagged
// snapshot. An unreadable source index must fail `--check` closed (never a
// silent green), stay failed while unreadable, and recover only after the memo
// is reset — a cached failure must never be mixed with a later success.
// ---------------------------------------------------------------------------
describe("windows-parity source index unreadable stays fail-closed (review Critical)", { concurrency: false }, () => {
  let previousSourceEnv;

  before(() => {
    previousSourceEnv = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
  });
  after(() => {
    if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
    else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
    resetSourceExecBitPathsMemo();
  });

  async function makeSourceRepo() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "exec-bit-src-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8" });
    await fs.writeFile(path.join(root, "tracked.txt"), "x\n");
    spawnSync("git", ["add", "--", "tracked.txt"], { cwd: root, encoding: "utf8" });
    spawnSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: root, encoding: "utf8" }
    );
    return root;
  }

  async function makeConsumerRepo() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "exec-bit-cons-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8" });
    return root;
  }

  function sourceIndexOf(root) {
    return path.join(root, ".git", "index");
  }
  function corruptSourceIndex(root) {
    writeFileSync(sourceIndexOf(root), "corrupt-index-bytes");
  }
  function repairSourceIndex(root) {
    rmSync(sourceIndexOf(root), { force: true });
    spawnSync("git", ["read-tree", "HEAD"], { cwd: root, encoding: "utf8" });
  }
  function lsFilesStatus(root) {
    return spawnSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" }).status;
  }

  async function withFixture(fn) {
    const source = await makeSourceRepo();
    const consumer = await makeConsumerRepo();
    try {
      process.env[TEST_SYNC_SOURCE_ROOT_ENV] = source;
      resetSourceExecBitPathsMemo();
      return await fn({ source, consumer });
    } finally {
      await fs.rm(source, { recursive: true, force: true });
      await fs.rm(consumer, { recursive: true, force: true });
      if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
      else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
      resetSourceExecBitPathsMemo();
    }
  }

  it("Check Fails When Source Index Is Unreadable", async () => {
    await withFixture(async ({ source, consumer }) => {
      corruptSourceIndex(source);
      assert.notEqual(lsFilesStatus(source), 0, "prove-it: corrupt index must make ls-files fail");
      await assert.rejects(
        checkExecBitParity(consumer),
        /source git index is unreadable/,
        "an unreadable source index must not exit 0 with no drift report"
      );
    });
  });

  it("untrustworthy source probes stay unreadable (never N/A): spawn error / timeout / marker-present failures", () => {
    assert.equal(classifySourceRepoProbe({ status: 0, stdout: "true", stderr: "" }), "repo");
    assert.equal(
      classifySourceRepoProbe({ status: 0, stdout: "true", stderr: "" }, { hasGitMarker: true }),
      "repo"
    );
    // A git marker present means git found a repo it could not read: fail closed
    // for every failure mode, including a corrupt `.git` that prints the same
    // "not a git repository" text a genuine non-repo would.
    assert.equal(
      classifySourceRepoProbe(
        {
          status: 128,
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
        },
        { hasGitMarker: true }
      ),
      "unreadable",
      "marker-present 'not a git repository' must not be laundered into N/A"
    );
    assert.equal(
      classifySourceRepoProbe(
        { status: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at 'X'" },
        { hasGitMarker: true }
      ),
      "unreadable"
    );
    assert.equal(
      classifySourceRepoProbe({ status: 1, stdout: "", stderr: "" }, { hasGitMarker: true }),
      "unreadable"
    );
    assert.equal(
      classifySourceRepoProbe(
        { status: 128, stdout: "", stderr: "fatal: cannot open '.git': Permission denied" },
        { hasGitMarker: true }
      ),
      "unreadable"
    );
    // Spawn error / timeout is untrustworthy even with no marker.
    assert.equal(
      classifySourceRepoProbe({ status: null, error: { code: "ENOENT" }, stdout: "", stderr: "" }),
      "unreadable",
      "git spawn failure must not be laundered into a non-Git N/A"
    );
    assert.equal(
      classifySourceRepoProbe({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }),
      "unreadable",
      "probe timeout must stay fail-closed"
    );
    assert.equal(
      classifySourceRepoProbe({ status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }),
      "unreadable"
    );
    // No marker at all + git failure = trustworthy non-repo (N/A).
    assert.equal(
      classifySourceRepoProbe(
        { status: 128, stdout: "", stderr: "fatal: not a git repository" },
        { hasGitMarker: false }
      ),
      "not-a-repo"
    );
  });

  it("a corrupt .git marker is unreadable, not N/A (message-regex bypass regression)", async () => {
    const consumer = await makeConsumerRepo();
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "exec-bit-corrupt-marker-"));
    try {
      // Marker present, repository unreadable: `rev-parse` says "not a git
      // repository" but a filesystem marker proves a repo is here.
      await fs.mkdir(path.join(source, ".git"));
      process.env[TEST_SYNC_SOURCE_ROOT_ENV] = source;
      resetSourceExecBitPathsMemo();
      await assert.rejects(
        assertExecBitParity(consumer, { mode: "fail" }),
        /source git index is unreadable/,
        "a present-but-corrupt .git must fail closed, never N/A"
      );
    } finally {
      await fs.rm(source, { recursive: true, force: true });
      await fs.rm(consumer, { recursive: true, force: true });
      if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
      else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
      resetSourceExecBitPathsMemo();
    }
  });

  it("a git spawn failure (PATH without git) fails --check closed, not N/A", async () => {
    const consumer = await makeConsumerRepo();
    const previousPath = process.env.PATH;
    try {
      process.env[TEST_SYNC_SOURCE_ROOT_ENV] = consumer;
      resetSourceExecBitPathsMemo();
      process.env.PATH = "";
      await assert.rejects(
        assertExecBitParity(consumer, { mode: "fail" }),
        /source git index is unreadable/,
        "an ENOENT probe must be unreadable, not a silent N/A"
      );
    } finally {
      process.env.PATH = previousPath;
      await fs.rm(consumer, { recursive: true, force: true });
      if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
      else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
      resetSourceExecBitPathsMemo();
    }
  });

  it("persistent failure stays failed; a cached failure is not mixed with a later success", async () => {
    await withFixture(async ({ source, consumer }) => {
      corruptSourceIndex(source);
      await assert.rejects(checkExecBitParity(consumer), /source git index is unreadable/);
      await assert.rejects(
        checkExecBitParity(consumer),
        /source git index is unreadable/,
        "persistent failure must stay failed"
      );
      // Repair the on-disk index WITHOUT resetting the memo: the cached
      // unreadable snapshot must still be used, proving one snapshot per
      // process (no failure→success mixing inside one comparison).
      repairSourceIndex(source);
      assert.equal(lsFilesStatus(source), 0, "prove-it: repaired index must read");
      await assert.rejects(
        checkExecBitParity(consumer),
        /source git index is unreadable/,
        "cached snapshot must not silently recover mid-process"
      );
    });
  });

  it("failure→recovery: after a memo reset, a repaired source index passes --check", async () => {
    await withFixture(async ({ source, consumer }) => {
      corruptSourceIndex(source);
      await assert.rejects(checkExecBitParity(consumer), /source git index is unreadable/);
      repairSourceIndex(source);
      resetSourceExecBitPathsMemo();
      await checkExecBitParity(consumer);
    });
  });

  it("non-Git source root is N/A (fail mode does not throw)", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "exec-bit-nongit-src-"));
    const consumer = await makeConsumerRepo();
    try {
      process.env[TEST_SYNC_SOURCE_ROOT_ENV] = source;
      resetSourceExecBitPathsMemo();
      await checkExecBitParity(consumer);
    } finally {
      await fs.rm(source, { recursive: true, force: true });
      await fs.rm(consumer, { recursive: true, force: true });
      if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
      else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
      resetSourceExecBitPathsMemo();
    }
  });

  it("--sync warn mode warns (does not throw) when the source index is unreadable", async () => {
    await withFixture(async ({ source, consumer }) => {
      corruptSourceIndex(source);
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        await assertExecBitParity(consumer, { mode: "warn" });
      } finally {
        console.warn = originalWarn;
      }
      assert.match(warnings.join("\n"), /source git index is unreadable/);
    });
  });
});

describe("exec-bit parity reads the whole consumer index (#2862)", { concurrency: false }, () => {
  const EXEC_REL = ".devpro/scripts/hooks-git/pre-push";
  const PROBE_BUFFER_BYTES = 1024 * 1024;
  let previousSourceEnv;

  before(() => {
    previousSourceEnv = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
  });
  after(() => {
    if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
    else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
    resetSourceExecBitPathsMemo();
  });

  async function makeRepoWithExecutable() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "exec-bit-index-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8" });
    await fs.mkdir(path.join(root, path.dirname(EXEC_REL)), { recursive: true });
    await fs.writeFile(path.join(root, EXEC_REL), "#!/bin/sh\n");
    spawnSync("git", ["add", "--", EXEC_REL], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["update-index", "--chmod=+x", "--", EXEC_REL], { cwd: root, encoding: "utf8" });
    return root;
  }

  // Pad the index with synthetic tracked paths (one shared blob) until `git ls-files -s`
  // prints more than the 1 MB probe cap, as a large consumer does.
  function padIndexBeyondProbeBuffer(root) {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      encoding: "utf8",
      input: "pad\n",
    }).stdout.trim();
    const lines = [];
    for (let n = 0; n < 12000; n++) {
      lines.push(`100644 ${blob}\t0\tbulk/dir-${n % 100}/a-fairly-long-padding-file-name-for-index-output-${n}.txt`);
    }
    const added = spawnSync("git", ["update-index", "--add", "--index-info"], {
      cwd: root,
      encoding: "utf8",
      input: `${lines.map((line) => line.replace("\t0\t", "\t")).join("\n")}\n`,
    });
    assert.equal(added.status, 0, added.stderr);
    const out = spawnSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.ok(
      Buffer.byteLength(out.stdout) > PROBE_BUFFER_BYTES,
      `prove-it setup: ls-files -s must exceed the 1 MB probe cap, got ${Buffer.byteLength(out.stdout)} bytes`,
    );
  }

  async function withFixture(fn) {
    const source = await makeRepoWithExecutable();
    const consumer = await makeRepoWithExecutable();
    try {
      process.env[TEST_SYNC_SOURCE_ROOT_ENV] = source;
      resetSourceExecBitPathsMemo();
      return await fn({ source, consumer });
    } finally {
      await fs.rm(source, { recursive: true, force: true });
      await fs.rm(consumer, { recursive: true, force: true });
      if (previousSourceEnv === undefined) delete process.env[TEST_SYNC_SOURCE_ROOT_ENV];
      else process.env[TEST_SYNC_SOURCE_ROOT_ENV] = previousSourceEnv;
      resetSourceExecBitPathsMemo();
    }
  }

  it("Check Passes When Consumer ls-files Output Exceeds The Probe Buffer", async () => {
    await withFixture(async ({ consumer }) => {
      padIndexBeyondProbeBuffer(consumer);
      await checkExecBitParity(consumer);
    });
  });

  it("Check Fails Closed, Not As A False Missing, When The Consumer Index Is Unreadable", async () => {
    await withFixture(async ({ consumer }) => {
      writeFileSync(path.join(consumer, ".git", "index"), "corrupt-index-bytes");
      const lsFiles = spawnSync("git", ["ls-files", "-s"], { cwd: consumer, encoding: "utf8" });
      assert.notEqual(lsFiles.status, 0, "prove-it setup: corrupt index must make ls-files fail");
      await assert.rejects(checkExecBitParity(consumer), (error) => {
        assert.match(error.message, /consumer git index could not be read/);
        assert.doesNotMatch(error.message, /missing from the consumer index/);
        return true;
      });
    });
  });

  it("--sync warn mode warns, does not throw, when the consumer index is unreadable", async () => {
    await withFixture(async ({ consumer }) => {
      writeFileSync(path.join(consumer, ".git", "index"), "corrupt-index-bytes");
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        await assertExecBitParity(consumer, { mode: "warn" });
      } finally {
        console.warn = originalWarn;
      }
      assert.match(warnings.join("\n"), /consumer git index could not be read/);
      assert.doesNotMatch(warnings.join("\n"), /missing from the consumer index/);
    });
  });
});
