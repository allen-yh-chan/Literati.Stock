/**
 * Focused prove-it for #2498: FS↔git orphan directory advisory, scan-scope
 * dual counts, reparse advisory tokens, and --exec pre-teardown for registered
 * worktrees only (orphans MUST NOT be auto-deleted).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  promises as fs,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { advisoryPathArg } from "../lib/prune-argv.mjs";

const pruneScript = path.join(REPO_ROOT, ".devpro", "scripts", "prune-merged-local.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.error?.message || result.stderr}`);
  }
  return result.stdout.trim();
}

/** Install a child-only preload that intercepts exact Git calls without a PATH shim. */
async function installGitBehaviorPreload(tmp, envOverrides) {
  const preloadPath = path.join(tmp, "git-execfile-preload.mjs");
  await fs.writeFile(preloadPath, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import nativeFs, { unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import nativePath from "node:path";

if (process.env.DEVPRO_SIMULATE_WINDOWS) Object.defineProperty(process, "platform", { value: "win32" });
const normalizedPath = (value) => {
  const result = nativePath.normalize(nativePath.toNamespacedPath(String(value)));
  return process.platform === "win32" ? result.toLowerCase() : result;
};
const samePath = (a, b) => normalizedPath(a) === normalizedPath(b);
const originalRm = nativeFs.rmSync;
nativeFs.rmSync = function (target, options) {
  if (process.env.DEVPRO_FAIL_ORPHAN_REMOVE && samePath(target, process.env.DEVPRO_FAIL_ORPHAN_REMOVE)) {
    unlinkSync(nativePath.join(String(target), "delete-me.txt"));
    if (process.env.DEVPRO_DAMAGE_ORPHAN_MAIN_DEP) unlinkSync(process.env.DEVPRO_DAMAGE_ORPHAN_MAIN_DEP);
    throw new Error("sentinel orphan deletion failure");
  }
  const result = originalRm(target, options);
  if (process.env.DEVPRO_DAMAGE_ORPHAN_MAIN_DEP) unlinkSync(process.env.DEVPRO_DAMAGE_ORPHAN_MAIN_DEP);
  return result;
};
const originalReadDir = nativeFs.readdirSync;
nativeFs.readdirSync = function (target, options) {
  if (process.env.DEVPRO_UNREADABLE && samePath(target, process.env.DEVPRO_UNREADABLE)) throw new Error("sentinel unreadable directory: " + target);
  return originalReadDir(target, options);
};
let partialSeen = false;
// Observe every argument-array subprocess API, including future migrations
// away from execFileSync. The assertion resolves Git global options below.
for (const api of ["execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  const original = childProcess[api];
  childProcess[api] = function (file, args, ...rest) {
    if (process.env.DEVPRO_PROCESS_LEDGER) nativeFs.appendFileSync(process.env.DEVPRO_PROCESS_LEDGER, JSON.stringify({ api, file, args: Array.isArray(args) ? args : [] }) + "\\n");
    return original.call(this, file, args, ...rest);
  };
}
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, options) {
  if (file === "powershell.exe" && process.env.DEVPRO_FORBID_POWERSHELL) throw new Error("sentinel unexpected PowerShell invocation");
  if (file === "powershell.exe" && process.env.DEVPRO_NATIVE_PROBE_FAIL) throw new Error("sentinel native reparse probe failure");
  const argv = Array.isArray(args) ? args : [];
  const normalized = argv[0] === "-c" && argv[1] === "core.longpaths=true" ? argv.slice(2) : argv;
  const command = normalized.join(" ");
  if (file === "git" && process.env.DEVPRO_FAIL_ROOT_PROBE && argv.includes("--git-common-dir")) throw new Error("sentinel root identity probe failure");
  if (partialSeen && process.env.DEVPRO_FAIL_REGISTRY_AFTER_REMOVE && command === "worktree list --porcelain") throw new Error("sentinel registry observation failure");
  if (file === "git" && process.env.DEVPRO_FAIL_GIT_PREFIX && command.startsWith(process.env.DEVPRO_FAIL_GIT_PREFIX)) {
    const error = new Error("sentinel: forced failure for " + command);
    error.status = 93;
    error.stderr = Buffer.from(error.message + "\\n");
    error.stdout = Buffer.alloc(0);
    throw error;
  }
  if (file === "git" && normalized[0] === "worktree" && normalized[1] === "remove" && process.env.DEVPRO_DAMAGE_MAIN_DEP) {
    try { unlinkSync(process.env.DEVPRO_DAMAGE_MAIN_DEP); } catch {}
  }
  if (file === "git" && normalized[0] === "worktree" && normalized[1] === "remove" && process.env.DEVPRO_PARTIAL_REMOVE) {
    originalExecFileSync.call(this, file, args, options);
    mkdirSync(normalized.at(-1), { recursive: true });
    writeFileSync(nativePath.join(normalized.at(-1), "leftover.txt"), "partially removed");
    partialSeen = true;
    throw new Error("Filename too long: sentinel partial removal");
  }
  return originalExecFileSync.call(this, file, args, options);
};
syncBuiltinESMExports();
`, "utf8");
  const preloadOption = `--import=${pathToFileURL(preloadPath).href}`;
  return {
    ...process.env,
    ...envOverrides,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(" "),
  };
}

const FAILURE_CLASSES = {
  registry: /orphan removal refused: registry probe failed: sentinel: forced failure for worktree list --porcelain;/,
  identity: /main-checkout identity unverified: git-common-dir probe failed; mutation refused/,
  native: /orphan removal refused: native reparse probe failed: sentinel native reparse probe failure;/,
  registered: /orphan removal refused: refuse registered worktree target;/,
  unreadable: /orphan removal refused: sentinel unreadable directory:/,
  linked: /orphan removal refused: refuse linked\/reparse path:/,
  containerLink: /orphan removal refused: refuse linked\/reparse container:/,
  marker: /orphan removal refused: refuse \.git marker:/,
  scope: /orphan removal refused: target must be a first-level child of main-checkout \.worktree and must not be current checkout or its ancestor;/,
  missing: /orphan removal refused: ENOENT:/,
  arguments: /拒絕：--remove-orphan requires exactly one absolute path and no scan\/exec\/remote\/keep\/companion flags\./,
  deletion: /orphan removal failed: sentinel orphan deletion failure;/,
  invariant: /orphan removal failed: main-checkout dependency invariant failed:/,
};

function assertFailureClass(result, intended) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, FAILURE_CLASSES[intended]);
  for (const [name, reason] of Object.entries(FAILURE_CLASSES)) {
    if (name !== intended) assert.doesNotMatch(result.stderr, reason, `unexpected competing failure class: ${name}`);
  }
}

async function installGitFailPrefix(tmp, failPrefix) {
  return installGitBehaviorPreload(tmp, { DEVPRO_FAIL_GIT_PREFIX: failPrefix });
}

/**
 * On `worktree remove`, delete one file from main node_modules before the real
 * remove — proves dependency invariant aborts with non-zero (Pre-Teardown Failure).
 */
async function installGitWorktreeRemoveDamagesMainDeps(tmp, mainNodeModulesFile) {
  return installGitBehaviorPreload(tmp, { DEVPRO_DAMAGE_MAIN_DEP: mainNodeModulesFile });
}

async function buildBaseRepoTemplate() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-orphan-template-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@e.x"]);
  git(work, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(work, "a.txt"), "init\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "init"]);
  git(tmp, ["init", "-q", "--bare", bare]);
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["branch", "-f", "production"]);
  git(work, ["push", "-q", "origin", "production"]);
  git(work, ["tag", "production-v1.0.0"]);
  return { tmp, work, bare };
}

let baseRepoTemplatePromise;
async function ensureBaseRepoTemplate() {
  if (!baseRepoTemplatePromise) baseRepoTemplatePromise = buildBaseRepoTemplate();
  return baseRepoTemplatePromise;
}

async function createBaseRepo() {
  const template = await ensureBaseRepoTemplate();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "prune-orphan-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");
  cpSync(template.bare, bare, { recursive: true });
  cpSync(template.work, work, { recursive: true });
  git(work, ["remote", "set-url", "origin", bare]);
  return { tmp, work, bare };
}

describe("prune-merged-local: local review worktrees require named cleanup (#3160)", () => {
  it("keeps a shipped local review ref without a worktree out of every batch cleanup tier", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      git(work, ["branch", "review/pr42", "production"]);
      const scan = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
      assert.equal(scan.status, 0, scan.stderr);
      assert.match(scan.stdout, /--force-delete[^\n]*review\/pr42/);
      assert.doesNotMatch(scan.stdout, /local branch\(es\) confirmed shipped/);
      for (const flags of [[], ["--include-subsumed"], ["--include-unshipped-mainline"]]) {
        const result = spawnSync(process.execPath, [pruneScript, ...flags, "--exec"], { cwd: work, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(git(work, ["branch", "--list", "review/pr42"]), /review\/pr42/);
      }
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it("lists an unmerged review ref but never auto-removes its worktree even after its tip ships", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const wt = path.join(work, ".worktree", "pr41-review");
      git(work, ["worktree", "add", "-q", "-b", "review/pr41", wt, "production"]);
      await fs.writeFile(path.join(wt, "review.txt"), "local reproduction\n");
      git(wt, ["add", "review.txt"]);
      git(wt, ["commit", "-q", "-m", "review reproduction"]);
      const mainDeps = path.join(work, "node_modules");
      await fs.mkdir(mainDeps);
      await fs.writeFile(path.join(mainDeps, "keep.txt"), "main dependencies\n");
      symlinkSync(mainDeps, path.join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const scan = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
      assert.equal(scan.status, 0, scan.stderr);
      assert.match(scan.stdout, /review\/pr41/);
      assert.match(scan.stdout, /--force-delete[^\n]*review\/pr41/);
      for (const shipped of [false, true]) {
        if (shipped) {
          git(work, ["branch", "-f", "production", "review/pr41"]);
          git(work, ["push", "-q", "origin", "production"]);
        }
        const automatic = spawnSync(process.execPath, [pruneScript, "--exec"], { cwd: work, encoding: "utf8" });
        assert.equal(automatic.status, 0, automatic.stderr);
        assert.equal(existsSync(wt), true, `review worktree must remain advisory-only (shipped=${shipped})`);
      }
      assert.match(git(work, ["worktree", "list", "--porcelain"]), /refs\/heads\/review\/pr41/);
      const explicit = spawnSync(process.execPath, [pruneScript, "--force-delete", "review/pr41"], { cwd: work, encoding: "utf8" });
      assert.equal(explicit.status, 0, explicit.stderr);
      assert.equal(existsSync(wt), false);
      assert.equal(await fs.readFile(path.join(mainDeps, "keep.txt"), "utf8"), "main dependencies\n");
      assert.doesNotMatch(git(work, ["branch", "--list", "review/pr41"]), /review\/pr41/);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });
});

describe("prune-merged-local: FS worktree orphan advisory (#2498)", () => {
  let tmp;
  let work;
  let orphanPath;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    orphanPath = path.join(work, ".worktree", "orphan-shell");
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(path.join(orphanPath, "README.md"), "orphan leftover\n");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("dry-run lists orphan directory and dual scan-scope counts", () => {
    const result = spawnSync(process.execPath, [pruneScript], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /orphan directory/i);
    assert.match(result.stdout, /orphan-shell/);
    assert.match(result.stdout, /核對後再刪|verify before delet/i);
    assert.match(
      result.stdout,
      /worktree snapshot: checked, git-linked=\d+, fs-\.worktree=\d+/
    );
    assert.match(result.stdout, /worktree FS↔git mismatch: orphans=\d+/);
  });

  it("--exec does not delete orphan directories", () => {
    const result = spawnSync(process.execPath, [pruneScript, "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.ok(existsSync(orphanPath), "orphan directory MUST still exist after --exec");
  });
});

describe("prune-merged-local: reparse advisory + registered pre-teardown (#2498)", () => {
  let tmp;
  let work;
  let wtPath;
  let mainNodeModules;
  let mainEntryCountBefore;

  before(async () => {
    ({ tmp, work } = await createBaseRepo());
    writeFileSync(path.join(work, ".gitignore"), "node_modules/\n");
    git(work, ["add", ".gitignore"]);
    git(work, ["commit", "-q", "-m", "ignore node_modules"]);

    git(work, ["checkout", "-q", "-b", "bugfix/wt-reparse"]);
    writeFileSync(path.join(work, "feat.txt"), "shipped\n");
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "feat: reparse wt"]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "-q", "--no-ff", "bugfix/wt-reparse", "-m", "merge"]);
    git(work, ["branch", "-f", "production"]);
    git(work, ["push", "-q", "origin", "production"]);
    git(work, ["tag", "-f", "production-v1.0.1"]);

    wtPath = path.join(work, ".worktree", "wt-reparse");
    mkdirSync(path.join(work, ".worktree"), { recursive: true });
    git(work, ["worktree", "add", "-f", wtPath, "bugfix/wt-reparse"]);

    mainNodeModules = path.join(work, "node_modules");
    mkdirSync(mainNodeModules, { recursive: true });
    writeFileSync(path.join(mainNodeModules, "keep-me.txt"), "do-not-delete\n");
    mainEntryCountBefore = readdirSync(mainNodeModules).length;

    const wtNodeModules = path.join(wtPath, "node_modules");
    if (existsSync(wtNodeModules)) {
      await fs.rm(wtNodeModules, { recursive: true, force: true });
    }
    symlinkSync(mainNodeModules, wtNodeModules, "dir");

    // Also leave an orphan with a symlink dependency to exercise advisory copy.
    const orphan = path.join(work, ".worktree", "orphan-with-link");
    mkdirSync(orphan, { recursive: true });
    symlinkSync(mainNodeModules, path.join(orphan, "node_modules"), "dir");
  });

  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("stdout warns MUST NOT rm -rf on reparse orphan and includes safe teardown tokens", () => {
    const result = spawnSync(process.execPath, [pruneScript], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    // Indented per-orphan advisory proves the reparse branch ran (not only a
    // global trailer that used to print for every orphan list).
    assert.match(
      result.stdout,
      /orphan directory:.*orphan-with-link[\s\S]*MUST NOT `rm -rf`/i,
    );
    assert.match(result.stdout, /Directory\]::Delete|rmdir|unlink/);
    assert.match(result.stdout, /orphan directory/i);
  });

  it("--exec prints pre-teardown before worktree remove and preserves main node_modules", () => {
    const result = spawnSync(process.execPath, [pruneScript, "--exec"], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const preIdx = result.stdout.indexOf("pre-teardown reparse/symlink");
    const removeIdx = result.stdout.search(/executing:.*worktree remove/i);
    assert.ok(preIdx >= 0, "must log pre-teardown reparse/symlink");
    assert.ok(removeIdx >= 0, "must log worktree remove execution");
    assert.ok(
      preIdx < removeIdx,
      "pre-teardown must appear before git worktree remove",
    );
    assert.ok(!existsSync(wtPath), "registered worktree should be removed");
    assert.ok(existsSync(mainNodeModules), "main node_modules must remain");
    assert.ok(
      existsSync(path.join(mainNodeModules, "keep-me.txt")),
      "main dependency content must not be followed/deleted"
    );
    const afterCount = readdirSync(mainNodeModules).length;
    assert.ok(
      afterCount >= mainEntryCountBefore,
      `main node_modules entry count must not drop (${mainEntryCountBefore} → ${afterCount})`
    );
    assert.ok(
      existsSync(path.join(work, ".worktree", "orphan-with-link")),
      "orphan with symlink MUST NOT be auto-deleted by --exec"
    );
  });
});

describe("prune-merged-local: git worktree list failure must not invent orphans (#2498)", () => {
  it("dry-run degrades FS scan and does not list registered dirs as orphans", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const registered = path.join(work, ".worktree", "registered-wt");
      mkdirSync(path.join(work, ".worktree"), { recursive: true });
      git(work, ["checkout", "-q", "-b", "bugfix/list-fail"]);
      writeFileSync(path.join(work, "f.txt"), "x\n");
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", "feat"]);
      git(work, ["checkout", "-q", "main"]);
      git(work, ["worktree", "add", "-f", registered, "bugfix/list-fail"]);

      const env = await installGitFailPrefix(tmp, "worktree list --porcelain");
      const result = spawnSync(process.execPath, [pruneScript], {
        cwd: work,
        encoding: "utf8",
        env,
      });
      // Snapshot probe may exit 1 on --exec; dry-run still prints scope.
      assert.ok(
        result.status === 0 || result.status === 1,
        `unexpected status ${result.status}: ${result.stderr}\n${result.stdout}`,
      );
      const out = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(out, /orphan directory/i);
      assert.match(out, /worktree FS scan: not checked/i);
      assert.match(out, /degraded effective scope:.*worktree FS/i);
      assert.ok(existsSync(registered), "registered worktree must remain");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("prune-merged-local: Pre-Teardown Failure Stops Mutation (#2498)", () => {
  it("--exec exits non-zero when main node_modules loses entries across remove", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      writeFileSync(path.join(work, ".gitignore"), "node_modules/\n");
      git(work, ["add", ".gitignore"]);
      git(work, ["commit", "-q", "-m", "ignore node_modules"]);

      git(work, ["checkout", "-q", "-b", "bugfix/wt-invariant"]);
      writeFileSync(path.join(work, "feat.txt"), "shipped\n");
      git(work, ["add", "."]);
      git(work, ["commit", "-q", "-m", "feat"]);
      git(work, ["checkout", "-q", "main"]);
      git(work, ["merge", "-q", "--no-ff", "bugfix/wt-invariant", "-m", "merge"]);
      git(work, ["branch", "-f", "production"]);
      git(work, ["push", "-q", "origin", "production"]);
      git(work, ["tag", "-f", "production-v1.0.9"]);

      const wtPath = path.join(work, ".worktree", "wt-invariant");
      mkdirSync(path.join(work, ".worktree"), { recursive: true });
      git(work, ["worktree", "add", "-f", wtPath, "bugfix/wt-invariant"]);

      const mainNodeModules = path.join(work, "node_modules");
      mkdirSync(mainNodeModules, { recursive: true });
      const keepMe = path.join(mainNodeModules, "keep-me.txt");
      writeFileSync(keepMe, "do-not-delete\n");

      const wtNodeModules = path.join(wtPath, "node_modules");
      if (existsSync(wtNodeModules)) {
        await fs.rm(wtNodeModules, { recursive: true, force: true });
      }
      symlinkSync(mainNodeModules, wtNodeModules, "dir");

      const env = await installGitWorktreeRemoveDamagesMainDeps(tmp, keepMe);
      const result = spawnSync(process.execPath, [pruneScript, "--exec"], {
        cwd: work,
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0, `must fail: ${result.stdout}\n${result.stderr}`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /main-checkout dependency invariant failed/i,
      );
      assert.match(result.stderr, /unregistered.*directory absent/);
      // Must not claim a clean success summary for this worktree removal.
      assert.doesNotMatch(
        result.stdout,
        /worktree removed.*clean success|cleanup complete/i,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});


describe("prune-merged-local: partial removal recovery (#3303)", () => {
  for (const mode of ["force", "batch", "worktree-only batch"]) {
    it(`reports unregistered and remaining after ${mode} Git partial failure`, async () => {
      const { tmp, work } = await createBaseRepo();
      try {
        const branch = mode === "worktree-only batch" ? "temporary-partial-remove" : "bugfix/partial-remove";
        const wt = path.join(work, ".worktree", "partial-remove");
        git(work, ["worktree", "add", "-q", "-b", branch, wt, "production"]);
        const env = await installGitBehaviorPreload(tmp, { DEVPRO_PARTIAL_REMOVE: "1" });
        const args = mode === "force" ? ["--force-delete", branch] : ["--exec"];
        const result = spawnSync(process.execPath, [pruneScript, ...args], { cwd: work, env, encoding: "utf8" });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(git(work, ["branch", "--list", branch]), /partial-remove/);
        assert.doesNotMatch(git(work, ["worktree", "list", "--porcelain"]), /partial-remove/);
        assert.equal(existsSync(wt), true);
        assert.match(result.stderr, /unregistered.*directory remains/);
        assert.match(result.stderr, /contents may be partially deleted/);
        assert.match(result.stderr, /Filename too long/);
        assert.doesNotMatch(result.stderr, /worktree retained/);
        const scan = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
        const printedDir = /^\s+orphan directory: (.*partial-remove)$/m.exec(scan.stdout)?.[1];
        assert.ok(printedDir, scan.stdout);
        // Windows prints a command only for a path of plain characters; a temp path
        // with a ~ short name or a non-ASCII user name gets the quote-it-yourself line.
        const arg = advisoryPathArg(printedDir);
        assert.ok(
          scan.stdout.includes(arg === null
            ? "verify before deletion: the path has shell-special characters; quote the path above for your shell and run prune-merged-local.mjs with --remove-orphan"
            : `verify before deletion: node .devpro/scripts/prune-merged-local.mjs --remove-orphan ${arg}\n`),
          scan.stdout,
        );
        assert.doesNotMatch(scan.stdout, /--remove-orphan refused:/);
      } finally { await fs.rm(tmp, { recursive: true, force: true }); }
    });
  }
});


describe("prune-merged-local: named ordinary orphan cleanup (#3303)", () => {
  it("removes only the named orphan, preserving dependencies and branch refs", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const orphan = path.join(work, ".worktree", "named-orphan");
      await fs.mkdir(path.join(orphan, "nested"), { recursive: true });
      await fs.writeFile(path.join(orphan, "nested", "leftover.txt"), "leftover");
      await fs.mkdir(path.join(work, "node_modules"));
      await fs.writeFile(path.join(work, "node_modules", "keep.txt"), "keep");
      const refs = git(work, ["show-ref"]);
      const ledger = path.join(tmp, "named-mode-ledger.jsonl");
      await fs.writeFile(ledger, "");
      const env = await installGitBehaviorPreload(tmp, { DEVPRO_PROCESS_LEDGER: ledger });
      const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(orphan), false);
      assert.match(result.stdout, /unchanged \(1 entries\)/);
      assert.equal(await fs.readFile(path.join(work, "node_modules", "keep.txt"), "utf8"), "keep");
      assert.equal(git(work, ["show-ref"]), refs);
      const calls = (await fs.readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      assert.ok(calls.some(call => call.file === "git" && call.args[0] === "worktree" && call.args[1] === "list"));
      assert.ok(!calls.some(call => call.file === "git" && ["fetch", "push", "ls-remote", "remote"].includes(call.args[0])));
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it("refuses registered/current/outside/container/missing/.git/linked targets and incompatible flags", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const container = path.join(work, ".worktree");
      const ordinary = path.join(container, "ordinary");
      const marker = path.join(container, "marker");
      const nested = path.join(container, "nested-link");
      const top = path.join(container, "top-link");
      const registered = path.join(container, "registered");
      for (const dir of [ordinary, marker, nested]) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(marker, ".git"), "marker");
      symlinkSync(ordinary, top, process.platform === "win32" ? "junction" : "dir");
      symlinkSync(ordinary, path.join(nested, "child"), process.platform === "win32" ? "junction" : "dir");
      git(work, ["worktree", "add", "-q", "-b", "bugfix/registered", registered]);
      const refs = git(work, ["show-ref"]);
      for (const [target, failureClass] of [[registered, "registered"], [work, "scope"], [tmp, "scope"], [container, "scope"], [path.join(container, "missing"), "missing"], [marker, "marker"], [nested, "linked"], [top, "linked"]]) {
        const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", target], { cwd: work, encoding: "utf8" });
        assertFailureClass(result, failureClass);
        assert.doesNotMatch(result.stderr, /contents may be partially deleted/);
      }
      for (const flag of ["--exec", "--include-remote", "--include-subsumed", "--local-only", "--allow-release", "--keep", "--force-delete", "extra"]) {
        for (const args of [["--remove-orphan", ordinary, flag], [flag, "--remove-orphan", ordinary]]) {
          const result = spawnSync(process.execPath, [pruneScript, ...args], { cwd: work, encoding: "utf8" });
          assertFailureClass(result, "arguments");
        }
      }
      assert.equal(git(work, ["show-ref"]), refs);
      assert.equal(existsSync(ordinary), true);
      const scan = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
      assert.match(scan.stdout, /--remove-orphan refused:.*linked\/reparse/);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it("rejects the current orphan, its ancestor and a linked .worktree container", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const container = path.join(work, ".worktree");
      const orphan = path.join(container, "current-orphan");
      const child = path.join(orphan, "nested");
      await fs.mkdir(child, { recursive: true });
      for (const cwd of [orphan, child]) {
        const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd, encoding: "utf8" });
        assertFailureClass(result, "scope");
      }
      const relocated = path.join(work, "relocated");
      await fs.rename(container, relocated);
      symlinkSync(relocated, container, process.platform === "win32" ? "junction" : "dir");
      const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, encoding: "utf8" });
      assertFailureClass(result, "containerLink");
      assert.doesNotMatch(result.stderr, /contents may be partially deleted/);
      assert.equal(existsSync(path.join(relocated, "current-orphan")), true);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it("reports absent after orphan removal causes the dependency invariant to fail", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const orphan = path.join(work, ".worktree", "dependency-failure");
      const deps = path.join(work, "node_modules");
      await fs.mkdir(orphan, { recursive: true });
      await fs.mkdir(deps);
      const keep = path.join(deps, "keep.txt");
      await fs.writeFile(keep, "keep");
      const unreadable = await installGitBehaviorPreload(tmp, { DEVPRO_UNREADABLE: await fs.realpath(deps) });
      const denied = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, env: unreadable, encoding: "utf8" });
      assertFailureClass(denied, "unreadable");
      assert.match(denied.stderr, /sentinel unreadable directory:.*node_modules/);
      assert.doesNotMatch(denied.stderr, /contents may be partially deleted/);
      assert.equal(existsSync(orphan), true);
      const env = await installGitBehaviorPreload(tmp, { DEVPRO_DAMAGE_ORPHAN_MAIN_DEP: keep });
      const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, env, encoding: "utf8" });
      assertFailureClass(result, "invariant");
      assert.match(result.stderr, /dependency invariant failed: node_modules entries 1 → 0; directory absent/);
      assert.match(result.stderr, /restore the main-checkout dependencies and verify the invariant before retrying/);
      assert.doesNotMatch(result.stderr, /reported refusal/);
      assert.doesNotMatch(result.stderr, /inspect the remaining directory/);
      assert.equal(existsSync(orphan), false, "physical removal succeeded before the dependency postcondition failed");
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });

  it("fails closed on registry, unreadable, and native reparse proof failure, then observes partial deletion", async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const orphan = path.join(work, ".worktree", "failure");
      await fs.mkdir(orphan, { recursive: true });
      await fs.writeFile(path.join(orphan, "delete-me.txt"), "delete");
      await fs.writeFile(path.join(orphan, "keep.txt"), "keep");
      for (const [failureClass, overrides] of [
        ["registry", { DEVPRO_FAIL_GIT_PREFIX: "worktree list --porcelain" }],
        ["unreadable", { DEVPRO_UNREADABLE: await fs.realpath(orphan) }],
        ["native", { DEVPRO_SIMULATE_WINDOWS: "1", DEVPRO_NATIVE_PROBE_FAIL: "1" }],
      ]) {
        const env = await installGitBehaviorPreload(tmp, overrides);
        const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, env, encoding: "utf8" });
        assertFailureClass(result, failureClass);
        if (failureClass === "unreadable") assert.match(result.stderr, /sentinel unreadable directory:.*failure/);
        assert.doesNotMatch(result.stderr, /contents may be partially deleted/);
        assert.equal(existsSync(path.join(orphan, "delete-me.txt")), true);
      }
      const env = await installGitBehaviorPreload(tmp, { DEVPRO_FAIL_ORPHAN_REMOVE: await fs.realpath(orphan) });
      const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, env, encoding: "utf8" });
      assertFailureClass(result, "deletion");
      assert.match(result.stderr, /sentinel orphan deletion failure.*directory remains.*partially deleted/);
      assert.match(result.stderr, /inspect the remaining directory after the failed removal before retrying/);
      assert.equal(existsSync(path.join(orphan, "delete-me.txt")), false);
      assert.equal(existsSync(path.join(orphan, "keep.txt")), true);
      assert.match(result.stdout, /N\/A/);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });
});


it("partial Git failure preserves primary error while reporting unknown registry and dependency damage", async () => {
  const { tmp, work } = await createBaseRepo();
  try {
    const branch = "bugfix/observation-failure";
    const wt = path.join(work, ".worktree", "observation-failure");
    git(work, ["worktree", "add", "-q", "-b", branch, wt, "production"]);
    const deps = path.join(work, "node_modules");
    await fs.mkdir(deps);
    const keep = path.join(deps, "keep.txt");
    await fs.writeFile(keep, "keep");
    const env = await installGitBehaviorPreload(tmp, {
      DEVPRO_PARTIAL_REMOVE: "1", DEVPRO_FAIL_REGISTRY_AFTER_REMOVE: "1", DEVPRO_DAMAGE_MAIN_DEP: keep,
    });
    const result = spawnSync(process.execPath, [pruneScript, "--force-delete", branch], { cwd: work, env, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /registry unknown.*directory remains/);
    assert.match(result.stderr, /Filename too long/);
    assert.match(result.stderr, /dependency invariant failed/);
    assert.doesNotMatch(result.stderr, /worktree retained/);
    assert.match(git(work, ["branch", "--list", branch]), /observation-failure/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});


it("refuses mutation when main-checkout identity falls back after common-dir probe failure", async () => {
  const { tmp, work } = await createBaseRepo();
  try {
    const orphan = path.join(work, ".worktree", "root-proof-orphan");
    const wt = path.join(work, ".worktree", "root-proof-linked");
    const branch = "bugfix/root-proof";
    await fs.mkdir(orphan, { recursive: true });
    git(work, ["worktree", "add", "-q", "-b", branch, wt, "production"]);
    const env = await installGitBehaviorPreload(tmp, { DEVPRO_FAIL_ROOT_PROBE: "1" });
    for (const args of [["--remove-orphan", orphan], ["--force-delete", branch]]) {
      const result = spawnSync(process.execPath, [pruneScript, ...args], { cwd: work, env, encoding: "utf8" });
      assertFailureClass(result, "identity");
      assert.doesNotMatch(result.stderr, /contents may be partially deleted/);
      assert.equal(existsSync(orphan), true);
      assert.equal(existsSync(wt), true);
      assert.match(git(work, ["branch", "--list", branch]), /root-proof/);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});


it("preserves unregistered stale gitfile leftovers and prints a marker-specific refusal without a handoff", async () => {
  const { tmp, work } = await createBaseRepo();
  try {
    const orphan = path.join(work, ".worktree", "stale-gitfile");
    await fs.mkdir(orphan, { recursive: true });
    const gitfile = `gitdir: ${path.join(work, ".git", "worktrees", "missing-admin")}\n`;
    await fs.writeFile(path.join(orphan, ".git"), gitfile);
    await fs.writeFile(path.join(orphan, "leftover.txt"), "preserve contents");
    const scan = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
    assert.equal(scan.status, 0, scan.stdout + scan.stderr);
    assert.match(scan.stdout, /--remove-orphan refused: refuse \.git marker:/);
    assert.match(scan.stdout, /verify whether the \.git marker is a stale gitfile or an active repository\/submodule; preserve it and handle it separately with an explicitly named action before retrying/);
    assert.doesNotMatch(scan.stdout, /^\s+核對後再刪 \/ verify before deletion: node .*--remove-orphan/m);
    assert.doesNotMatch(scan.stdout, /resolve the linked\/reparse or unreadable/);
    const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, encoding: "utf8" });
    assertFailureClass(result, "marker");
    assert.match(result.stderr, /verify whether the \.git marker is a stale gitfile or an active repository\/submodule/);
    assert.doesNotMatch(result.stderr, /contents may be partially deleted/);
    assert.equal(await fs.readFile(path.join(orphan, ".git"), "utf8"), gitfile);
    assert.equal(await fs.readFile(path.join(orphan, "leftover.txt"), "utf8"), "preserve contents");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

it("explicit local-only scan never spawns the Windows native orphan probe and requests non-local-only verification", async () => {
  const { tmp, work } = await createBaseRepo();
  try {
    const orphan = path.join(work, ".worktree", "local-only-orphan");
    await fs.mkdir(orphan, { recursive: true });
    const ledger = path.join(tmp, "process-ledger.jsonl");
    await fs.writeFile(ledger, "");
    const env = await installGitBehaviorPreload(tmp, { DEVPRO_SIMULATE_WINDOWS: "1", DEVPRO_FORBID_POWERSHELL: "1", DEVPRO_PROCESS_LEDGER: ledger });
    const result = spawnSync(process.execPath, [pruneScript, "--local-only"], { cwd: work, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /--remove-orphan refused: native reparse proof unavailable in explicit --local-only mode/);
    assert.match(result.stdout, /rerun verification without --local-only: node \.devpro\/scripts\/prune-merged-local\.mjs/);
    assert.match(result.stdout, /^\s+--remove-orphan refused: [^\n]*rerun verification without --local-only: node \.devpro\/scripts\/prune-merged-local\.mjs$/m);
    assert.doesNotMatch(result.stdout, /resolve the linked\/reparse or unreadable/);
    assert.doesNotMatch(result.stdout, /^\s+核對後再刪 \/ verify before deletion: node .*--remove-orphan/m);
    const calls = (await fs.readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(calls.some(call => call.file === "git" && call.args[0] === "worktree" && call.args[1] === "list"));
    assert.ok(!calls.some(call => call.file === "powershell.exe"));
    const gitCommand = args => {
      for (let i = 0; i < args.length; i += 1) {
        if (["-c", "-C", "--git-dir", "--work-tree"].includes(args[i])) { i += 1; continue; }
        if (!args[i].startsWith("-")) return args[i];
      }
    };
    for (const argv of [["fetch"], ["-c", "core.longpaths=true", "fetch"], ["-C", work, "push"], ["--git-dir=.git", "ls-remote"]]) {
      assert.ok(["fetch", "push", "ls-remote"].includes(gitCommand(argv)));
    }
    assert.ok(!calls.some(call => path.basename(call.file).replace(/\.exe$/i, "") === "git" && ["fetch", "push", "ls-remote"].includes(gitCommand(call.args))));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

it("orphan deletion failure retains its primary diagnosis alongside dependency damage", async () => {
  const { tmp, work } = await createBaseRepo();
  try {
    const orphan = path.join(work, ".worktree", "compound-failure");
    const deps = path.join(work, "node_modules");
    await fs.mkdir(orphan, { recursive: true }); await fs.mkdir(deps);
    await fs.writeFile(path.join(orphan, "delete-me.txt"), "delete");
    await fs.writeFile(path.join(orphan, "keep.txt"), "keep");
    const keep = path.join(deps, "keep.txt"); await fs.writeFile(keep, "dependency");
    const env = await installGitBehaviorPreload(tmp, { DEVPRO_FAIL_ORPHAN_REMOVE: await fs.realpath(orphan), DEVPRO_DAMAGE_ORPHAN_MAIN_DEP: keep });
    const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, env, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^orphan removal failed: sentinel orphan deletion failure;[^\n]*directory remains[^\n]*partially deleted[^\n]*restore the main-checkout dependencies/m);
    assert.match(result.stderr, /^main-checkout dependency invariant failed: node_modules entries 1 → 0$/m);
    assert.equal(existsSync(path.join(orphan, "keep.txt")), true);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

for (const kind of ["nested stale worktree", "nested submodule"]) {
  it(`preserves ${kind} gitfiles without printing executable deletion handoff`, async () => {
    const { tmp, work } = await createBaseRepo();
    try {
      const orphan = path.join(work, ".worktree", "nested-marker");
      const nested = path.join(orphan, "child"); await fs.mkdir(nested, { recursive: true });
      const marker = path.join(nested, ".git");
      await fs.writeFile(marker, kind === "nested submodule" ? "gitdir: ../../.git/modules/child\n" : "gitdir: ../../.git/worktrees/missing\n");
      const scan = spawnSync(process.execPath, [pruneScript], { cwd: work, encoding: "utf8" });
      assert.equal(scan.status, 0, scan.stderr);
      assert.match(scan.stdout, /--remove-orphan refused: refuse \.git marker:/);
      assert.doesNotMatch(scan.stdout, /^\s+核對後再刪 \/ verify before deletion: node .*--remove-orphan/m);
      const result = spawnSync(process.execPath, [pruneScript, "--remove-orphan", orphan], { cwd: work, encoding: "utf8" });
      assertFailureClass(result, "marker");
      assert.match(result.stderr, /stale gitfile or an active repository\/submodule/);
      assert.doesNotMatch(result.stderr, /contents may be partially deleted/);
      assert.equal(existsSync(marker), true);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });
}

it("the process census observes all argument-array child process APIs", async () => {
  const { tmp, work } = await createBaseRepo();
  try {
    const ledger = path.join(tmp, "process-census.jsonl"); await fs.writeFile(ledger, "");
    const child = path.join(tmp, "fork-child.mjs"); await fs.writeFile(child, "process.exit(0);");
    const env = await installGitBehaviorPreload(tmp, { DEVPRO_PROCESS_LEDGER: ledger });
    const program = `import cp from "node:child_process";
cp.execFileSync("git", ["--version"]); cp.spawnSync("git", ["--version"]);
await new Promise((resolve, reject) => cp.execFile("git", ["--version"], err => err ? reject(err) : resolve()));
await new Promise((resolve, reject) => { const p=cp.spawn("git", ["--version"]); p.on("error",reject); p.on("exit", code => code === 0 ? resolve() : reject(new Error(String(code)))); });
await new Promise((resolve, reject) => { const p=cp.fork(${JSON.stringify(child)}, [], { execArgv: [] }); p.on("error",reject); p.on("exit", code => code === 0 ? resolve() : reject(new Error(String(code)))); });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: work, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const calls = (await fs.readFile(ledger, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual([...new Set(calls.map(call => call.api))].sort(), ["execFile", "execFileSync", "fork", "spawn", "spawnSync"]);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
