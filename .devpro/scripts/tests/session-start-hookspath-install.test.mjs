/**
 * session-start-hookspath-install.test.mjs
 *
 * Tests that the git core.hooksPath auto-install logic works correctly,
 * including consumer／husky coexistence (GH-2483-a prove-it).
 *
 * Strategy:
 *   - Uses ensureGitHooksPath({ cwd }) from hooks/lib/git-utils.mjs as the
 *     canonical testable implementation.
 *   - session-start.mjs calls the same shared helper
 *     (which uses process.cwd() as the repo root). We test the session-start
 *     side-effect by spawning it with cwd set to a tmp git repo.
 *   - All tests use `git init` in a tmpdir — never `git clone` (repo-scope gate).
 *
 * Test cases:
 *   1. core.hooksPath unset → ensureGitHooksPathAt sets it to absolute hooks-git
 *   2. core.hooksPath already correct → no-op (idempotent)
 *   3. core.hooksPath set to legacy RELATIVE hooks-git → corrected to absolute
 *   4. Non-git directory → does not crash (fail-open)
 *   5. session-start.mjs spawn in a fresh git repo → core.hooksPath gets set
 *   6. foreign／husky-style hooksPath MUST NOT be overwritten; pre-commit
 *      remains discoverable via `git hook run pre-commit`
 *   7. after foreign preserved, deletion guard reachable／behavior-testable
 *   8. husky non-executable／shebangless pre-push + intermediate failure honors
 *      `sh -e` after wrap
 *   9. out-of-clone foreign hooksPath → preserve config; no destination mutation
 *  10. discovery file-entry symlink → no write-through outside clone
 *
 * NOTE: Do NOT claim that an arbitrary foreign／different hooksPath is
 * "corrected" to hooks-git — that is the GH-2483-a defect under prove-it.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  ensureGitHooksPath,
  __testHooksPathInstall,
  DELETION_GUARD_CHAIN_MARKER,
  CONSUMER_BACKUP_MARKER_PREFIX,
  normalizeGitBashDrivePath,
} from "../hooks/lib/git-utils.mjs";
import { mapMsysDrivePath } from "../hooks/lib/hook-command-context.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

function ensureGitHooksPathAt(cwd) {
  return ensureGitHooksPath({ cwd });
}

const SESSION_START = repoPath(".devpro/scripts/hooks/session-start.mjs");

const HOOKS_SUBPATH = ".devpro/scripts/hooks-git";
const CHAIN_MARKER = DELETION_GUARD_CHAIN_MARKER;
const ZERO_SHA = "0000000000000000000000000000000000000000";

test("nested linked worktree tracked hook uses its own index without mutation", () => {
  const main = createGitRepo();
  git(main, ["commit", "--allow-empty", "-qm", "fixture base"]);
  const linked = path.join(main, ".worktree", "nested");
  git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
  const firstWorktree = git(linked, ["worktree", "list", "--porcelain"]).split("\n")[0];
  assert.equal(realpathSync(firstWorktree.slice("worktree ".length)), realpathSync(main), "outer root comes first in the real registry");
  installRealHooksGit(linked);
  const body = "echo consumer\n";
  installHuskyStyleHooksPath(linked, { prePushBody: body });
  git(linked, ["add", "--", ".husky/pre-push"]);
  const hook = path.join(linked, ".husky", "pre-push");
  const index = git(linked, ["ls-files", "--stage", "--", ".husky/pre-push"]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(ensureGitHooksPathAt(linked).outcome, "risk");
    assert.equal(readFileSync(hook, "utf8"), body);
    assert.equal(git(linked, ["ls-files", "--stage", "--", ".husky/pre-push"]), index);
    assert.equal(getHooksPath(linked), ".husky/_");
    assert.equal(existsSync(hook + ".devpro-wrapped"), false);
  }
});

test("legacy wrapped tracked hook has restoration guidance and preserves every byte", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const original = "echo consumer\n";
  installHuskyStyleHooksPath(dir, { prePushBody: original });
  assert.equal(ensureGitHooksPathAt(dir).outcome, "repaired");
  const originalBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: original, encoding: "utf8" }).trim();
  git(dir, ["update-index", "--add", "--cacheinfo", "100644", originalBlob, ".husky/pre-push"]);
  const hook = path.join(dir, ".husky", "pre-push");
  const backup = hook + ".devpro-wrapped";
  const wrapperBytes = readFileSync(hook);
  const backupBytes = readFileSync(backup);
  const index = git(dir, ["ls-files", "--stage", "--", ".husky/pre-push"]);
  assert.equal(backupBytes.toString(), original);
  assert.ok(wrapperBytes.includes(CHAIN_MARKER));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = ensureGitHooksPathAt(dir);
    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /legacy.*tracked|tracked.*legacy/iu);
    assert.match(result.detail, /compare.*index.*backup.*restore.*remove/iu);
    assert.match(result.detail, /\.devpro-wrapped/u);
    assert.ok(result.detail.includes('exec node .devpro/scripts/hooks-git/pre-push.mjs "$@"'), "guidance is a literal usable command without escaped quote bytes");
    assert.deepEqual(readFileSync(hook), wrapperBytes);
    assert.deepEqual(readFileSync(backup), backupBytes);
    assert.equal(git(dir, ["ls-files", "--stage", "--", ".husky/pre-push"]), index);
    assert.equal(getHooksPath(dir), ".husky/_");
  }
});

test("tracked delegated hooks stay byte-identical and execute the guard exactly once", async (t) => {
  for (const [husky, command] of [
    [true, 'exec node .devpro/scripts/hooks-git/pre-push.mjs "$@"'],
    [true, 'exec node .devpro/scripts/hooks-git/pre-push.mjs'],
    [true, 'exec node ./.devpro/scripts/hooks-git/pre-push.mjs "$@"'],
    [false, 'exec .devpro/scripts/hooks-git/pre-push "$@"'],
  ]) await t.test(`${husky ? "husky" : "ordinary"}: ${command}`, () => {
    const dir = createGitRepo();
    const guardDir = path.join(dir, HOOKS_SUBPATH);
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(path.join(guardDir, "pre-push.mjs"), 'import fs from "node:fs";fs.appendFileSync("guard-runs.jsonl",JSON.stringify({args:process.argv.slice(2),stdin:fs.readFileSync(0,"utf8")})+"\\n");\n');
    writeFileSync(path.join(guardDir, "pre-push"), '#!/bin/sh\nexec node .devpro/scripts/hooks-git/pre-push.mjs "$@"\n', { mode: 0o755 });
    const hookRel = husky ? ".husky/pre-push" : "consumer-hooks/pre-push";
    const hook = path.join(dir, hookRel);
    const body = `#!/bin/sh\n# consumer-owned delegation\n${command}\n`;
    if (husky) installHuskyStyleHooksPath(dir, { prePushBody: body });
    else {
      mkdirSync(path.dirname(hook), { recursive: true });
      writeFileSync(hook, body, { mode: 0o755 });
      git(dir, ["config", "core.hooksPath", "consumer-hooks"]);
    }
    git(dir, ["add", "--", hookRel]);
    const index = git(dir, ["ls-files", "--stage", "--", hookRel]);
    const configured = getHooksPath(dir);
    if (!husky && process.platform !== "win32") {
      for (const executable of [hook, path.join(guardDir, "pre-push")]) {
        chmodSync(executable, 0o644);
        try {
          assert.equal(ensureGitHooksPathAt(dir).outcome, "risk", "POSIX delegation needs both executable files");
          assert.equal(readFileSync(hook, "utf8"), body);
          assert.equal(git(dir, ["ls-files", "--stage", "--", hookRel]), index);
        } finally {
          chmodSync(executable, 0o755);
        }
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(ensureGitHooksPathAt(dir).outcome, "compliant");
      assert.equal(readFileSync(hook, "utf8"), body, "SessionStart must not rewrite a tracked consumer hook");
      assert.equal(git(dir, ["ls-files", "--stage", "--", hookRel]), index);
      assert.equal(getHooksPath(dir), configured);
      assert.equal(readdirSync(path.dirname(hook)).some((name) => name.includes("devpro-wrapped")), false);
    }
    const run = runGitHook(dir, "pre-push", { stdin: "opaque input\n", args: ["origin", "fixture-url"] });
    assert.equal(run.status, 0, run.combined);
    const runs = readFileSync(path.join(dir, "guard-runs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(runs.length, 1, "an existing delegation must not get a second guard wrapper");
    assert.deepEqual(runs[0], { args: command.includes('"$@"') ? ["origin", "fixture-url"] : [], stdin: "opaque input\n" });
  });
});

test("tracked missing or unprovable delegation reports risk without any hook write", async (t) => {
  for (const [caseIndex, body] of [
    "echo consumer\n",
    "# exec node .devpro/scripts/hooks-git/pre-push.mjs\n",
    "exit 0\nexec node .devpro/scripts/hooks-git/pre-push.mjs\n",
    "if false; then\nexec node .devpro/scripts/hooks-git/pre-push.mjs\nfi\n",
    "exec node .devpro/scripts/hooks-git/pre-push.mjs < /dev/null\n",
    "\u00a0exec node .devpro/scripts/hooks-git/pre-push.mjs\n",
    "exec node .devpro/scripts/hooks-git/pre-push.mjs\r\n",
    "exec node .devpro/scripts/hooks-git/pre-push.mjs\n",
  ].entries()) await t.test(`case ${caseIndex}: ${JSON.stringify(body)}`, () => {
    const dir = createGitRepo();
    if (body !== "exec node .devpro/scripts/hooks-git/pre-push.mjs\n") installRealHooksGit(dir);
    installHuskyStyleHooksPath(dir, { prePushBody: body });
    git(dir, ["add", "--", ".husky/pre-push"]);
    const hook = path.join(dir, ".husky", "pre-push");
    const result = ensureGitHooksPathAt(dir);
    assert.equal(result.outcome, "risk");
    assert.match(result.detail, /tracked.*preserved|preserved.*tracked/iu);
    assert.match(result.detail, /exec node \.devpro\/scripts\/hooks-git\/pre-push\.mjs/iu);
    assert.equal(readFileSync(hook, "utf8"), body);
    assert.equal(existsSync(`${hook}.devpro-wrapped`), false);
    assert.equal(getHooksPath(dir), ".husky/_");
  });
});

test("unavailable Git index inspection cannot authorize a consumer hook rewrite", () => {
  const dir = createGitRepo();
  const body = "echo consumer\n";
  installHuskyStyleHooksPath(dir, { prePushBody: body });
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, args, options) => {
    if (file === "git" && args.includes("ls-files")) throw Object.assign(new Error("index unavailable"), { status: 128 });
    return original(file, args, options);
  };
  syncBuiltinESMExports();
  let result;
  try { result = ensureGitHooksPathAt(dir); }
  finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
  assert.equal(result.outcome, "risk");
  assert.match(result.detail, /destination worktree Git index.*check worktree ownership and index access.*retry/u);
  assert.equal(readFileSync(path.join(dir, ".husky", "pre-push"), "utf8"), body);
  assert.equal(existsSync(path.join(dir, ".husky", "pre-push.devpro-wrapped")), false);
});

test("tracked deleted and ordinary hooks preserve bytes with native Git executability", async (t) => {
  for (const deleted of [false, true]) await t.test(deleted ? "deleted index entry" : "ordinary mode-0644 hook", () => {
    const dir = createGitRepo();
    installRealHooksGit(dir);
    writeFileSync(path.join(dir, HOOKS_SUBPATH, "pre-push.mjs"), 'import fs from "node:fs";fs.writeFileSync("guard-ran", "yes");\n');
    const hookRel = "consumer-hooks/pre-push";
    const hook = path.join(dir, hookRel);
    const body = '#!/bin/sh\nexec node .devpro/scripts/hooks-git/pre-push.mjs "$@"\n';
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, body, { mode: 0o644 });
    chmodSync(hook, 0o644);
    git(dir, ["config", "core.hooksPath", "consumer-hooks"]);
    git(dir, ["add", "--", hookRel]);
    if (deleted) rmSync(hook);
    const index = git(dir, ["ls-files", "--stage", "--", hookRel]);
    if (!deleted) {
      const nativeRun = runGitHook(dir, "pre-push");
      assert.equal(nativeRun.status, process.platform === "win32" ? 0 : 1, nativeRun.combined);
      if (process.platform !== "win32") assert.match(nativeRun.combined, /ignored because it's not set as executable/u);
      assert.equal(existsSync(path.join(dir, "guard-ran")), process.platform === "win32", "native Git runs mode-0644 hooks on Windows and skips them on POSIX");
    }
    assert.equal(ensureGitHooksPathAt(dir).outcome, !deleted && process.platform === "win32" ? "compliant" : "risk");
    assert.equal(git(dir, ["ls-files", "--stage", "--", hookRel]), index);
    assert.equal(existsSync(hook), !deleted);
    if (!deleted) assert.equal(readFileSync(hook, "utf8"), body);
    assert.equal(existsSync(`${hook}.devpro-wrapped`), false);
  });
});
const REMOTE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const REAL_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// Assert exported marker constants stay wired for durable backup association tests.
assert.equal(typeof CONSUMER_BACKUP_MARKER_PREFIX, "string");
assert.ok(CONSUMER_BACKUP_MARKER_PREFIX.startsWith("# consumer-backup:"));
assert.equal(CHAIN_MARKER, "# devpro-pre-push-deletion-guard-chain");

// Expected core.hooksPath value for a repo whose MAIN worktree root is `root`.
// Must be ABSOLUTE and point at the main worktree's hooks-git dir, so the guard
// resolves identically from any linked worktree regardless of which branch is
// checked out there (relative paths resolve against the current worktree top
// and fail OPEN when that branch lacks the hook file).
//
// realpath the ROOT only (it exists) then join the subpath — the hooks-git dir
// itself need not exist for core.hooksPath to be set, so realpath'ing the whole
// chain would ENOENT. git's `worktree list` reports the realpath'd root, so we
// normalize the root to match (macOS /var → /private/var symlink).
function expectedHooksPath(root) {
  return path.join(realpathSync(root), HOOKS_SUBPATH);
}

const tmpRoot = makeTempDir("hookspath-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a fresh git repo in a new tmpdir subdirectory.
 * Returns the absolute path to the repo root.
 */
function createGitRepo() {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

/**
 * Read git config value; returns empty string if unset.
 */
function getHooksPath(dir) {
  try {
    return git(dir, ["config", "--get", "core.hooksPath"]);
  } catch {
    return "";
  }
}

/** Minimal husky-shaped dispatcher under `.husky/_/<name>` → `sh -e ../<name>`. */
function writeHuskyDispatcher(dir, hookName) {
  const internal = path.join(dir, ".husky", "_");
  mkdirSync(internal, { recursive: true });
  const dispatcher = `#!/bin/sh
# Minimal husky-shaped discovery entry (basename _ under .husky).
s="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/${hookName}"
[ -f "$s" ] || exit 0
sh -e "$s" "$@"
`;
  const target = path.join(internal, hookName);
  writeFileSync(target, dispatcher, { mode: 0o755 });
  chmodSync(target, 0o755);
  return target;
}

/**
 * Install husky-style core.hooksPath=.husky/_ with optional user hooks.
 * Returns the configured hooksPath string (relative).
 */
function installHuskyStyleHooksPath(dir, { preCommitBody, prePushBody, prePushMode } = {}) {
  writeHuskyDispatcher(dir, "pre-commit");
  writeHuskyDispatcher(dir, "pre-push");
  const huskyDir = path.join(dir, ".husky");
  mkdirSync(huskyDir, { recursive: true });
  if (preCommitBody != null) {
    const p = path.join(huskyDir, "pre-commit");
    writeFileSync(p, preCommitBody, { mode: 0o755 });
    chmodSync(p, 0o755);
  }
  if (prePushBody != null) {
    const p = path.join(huskyDir, "pre-push");
    // Default husky user hooks may lack +x and shebang; caller controls mode.
    writeFileSync(p, prePushBody, { mode: prePushMode ?? 0o644 });
    if (prePushMode != null) chmodSync(p, prePushMode);
  }
  git(dir, ["config", "core.hooksPath", ".husky/_"]);
  return ".husky/_";
}

/** Copy real hooks-git guard into the temp repo so absolute hooks-git can fire. */
function installRealHooksGit(dir) {
  const hooksDir = path.join(dir, HOOKS_SUBPATH);
  mkdirSync(hooksDir, { recursive: true });
  const realHooksDir = repoPath(".devpro/scripts/hooks-git");
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    readFileSync(path.join(realHooksDir, "pre-push"), "utf8"),
    { mode: 0o755 }
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  writeFileSync(
    path.join(hooksDir, "pre-push.mjs"),
    readFileSync(path.join(realHooksDir, "pre-push.mjs"), "utf8"),
    { mode: 0o644 }
  );
  return hooksDir;
}

function runGitHook(dir, hookName, { stdin = "", args = [] } = {}) {
  const stdinPath = path.join(dir, `.hook-stdin-${counter++}`);
  writeFileSync(stdinPath, stdin);
  const result = spawnSync(
    "git",
    ["hook", "run", "--to-stdin", stdinPath, hookName, "--", ...args],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 15000,
    }
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    stdout,
    stderr,
    // `git hook run` surfaces hook stdout on stderr in practice — match both.
    combined: `${stdout}\n${stderr}`,
  };
}

// ── ensureGitHooksPathAt() direct tests ───────────────────────────────────────

test("core.hooksPath unset → ensureGitHooksPathAt sets ABSOLUTE main-worktree path", () => {
  const dir = createGitRepo();
  const before = getHooksPath(dir);
  assert.equal(before, "", "precondition: hooksPath should be unset");

  const result = ensureGitHooksPathAt(dir);

  const after = getHooksPath(dir);
  assert.ok(path.isAbsolute(after), `hooksPath must be absolute; got '${after}'`);
  assert.equal(
    after,
    expectedHooksPath(dir),
    `hooksPath should resolve to the main worktree's ${HOOKS_SUBPATH}`
  );
  assert.deepEqual(result, {
    check: "hooks-path",
    execution: "checked",
    outcome: "repaired",
    detail: "configured absolute main-worktree hooks path",
  });
});

test("core.hooksPath already correct (absolute) → idempotent (stays correct)", () => {
  const dir = createGitRepo();
  const abs = expectedHooksPath(dir);
  git(dir, ["config", "core.hooksPath", abs]);

  // Should not throw, should not change value
  const result = ensureGitHooksPathAt(dir);
  ensureGitHooksPathAt(dir); // call twice to confirm idempotency

  const after = getHooksPath(dir);
  assert.equal(
    after,
    abs,
    "idempotent call should not change the value"
  );
  assert.equal(result.outcome, "compliant");
});

test("core.hooksPath set to legacy RELATIVE value → corrected to absolute", () => {
  const dir = createGitRepo();
  // Simulate a repo carrying the old relative value (the fail-OPEN config).
  git(dir, ["config", "core.hooksPath", HOOKS_SUBPATH]);
  const before = getHooksPath(dir);
  assert.equal(before, HOOKS_SUBPATH, "precondition: legacy relative value is set");

  ensureGitHooksPathAt(dir);

  const after = getHooksPath(dir);
  assert.ok(path.isAbsolute(after), `corrected hooksPath must be absolute; got '${after}'`);
  assert.equal(
    after,
    expectedHooksPath(dir),
    "should correct a legacy relative hooksPath to the absolute main-worktree path"
  );
});

test("non-git directory → does not crash (fail-open)", () => {
  const dir = path.join(tmpRoot, `nonrepo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  // Should not throw
  assert.equal(ensureGitHooksPathAt(dir).outcome, "risk");
});

test("completely nonexistent path → does not crash (fail-open)", () => {
  const dir = path.join(tmpRoot, "does-not-exist");
  assert.equal(ensureGitHooksPathAt(dir).outcome, "risk");
});

// ── session-start.mjs spawn integration test ─────────────────────────────────

test("session-start.mjs sets core.hooksPath on session start", () => {
  const dir = createGitRepo();
  const before = getHooksPath(dir);
  assert.equal(before, "", "precondition: hooksPath unset in fresh repo");

  // Spawn session-start.mjs with cwd = our fresh git repo.
  // The hook sets core.hooksPath relative to cwd via git config.
  const result = spawnSync(process.execPath, [SESSION_START], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      // Prevent recap logic from accessing production dirs
      DEVPRO_RECAP_PENDING_DIR: path.join(
        tmpRoot,
        `recap-pending-${counter++}`
      ),
      DEVPRO_RECAP_STATE_DIR: path.join(tmpRoot, `recap-state-${counter++}`),
    },
    timeout: 15000,
  });

  // Hook should exit 0 even if recap lookup fails
  assert.equal(result.status, 0, `session-start should exit 0; stderr=${result.stderr}`);

  const after = getHooksPath(dir);
  assert.ok(path.isAbsolute(after), `session-start should set an absolute hooksPath; got '${after}'`);
  assert.equal(
    after,
    expectedHooksPath(dir),
    `session-start should set core.hooksPath to the absolute ${HOOKS_SUBPATH}`
  );
});

test("session-start.mjs hooksPath install is idempotent (no crash on re-run)", () => {
  const dir = createGitRepo();

  const mkEnv = () => ({
    ...process.env,
    DEVPRO_RECAP_PENDING_DIR: path.join(tmpRoot, `recap-p-${counter++}`),
    DEVPRO_RECAP_STATE_DIR: path.join(tmpRoot, `recap-s-${counter++}`),
  });

  // First run
  const r1 = spawnSync(process.execPath, [SESSION_START], {
    cwd: dir,
    encoding: "utf8",
    env: mkEnv(),
    timeout: 15000,
  });
  assert.equal(r1.status, 0, "first run should exit 0");

  // Second run (idempotent)
  const r2 = spawnSync(process.execPath, [SESSION_START], {
    cwd: dir,
    encoding: "utf8",
    env: mkEnv(),
    timeout: 15000,
  });
  assert.equal(r2.status, 0, "second run should exit 0 (idempotent)");

  const after = getHooksPath(dir);
  assert.ok(path.isAbsolute(after), "hooksPath should remain absolute after two runs");
  assert.equal(
    after,
    expectedHooksPath(dir),
    "hooksPath should remain correct after two runs"
  );
});

// ── behavioral end-to-end: the guard must fire from a LINKED WORKTREE whose
//    checked-out branch does NOT contain the hook file. This is the fail-OPEN
//    that a relative core.hooksPath causes (git resolves it against the linked
//    worktree top, where the file is absent → no hook runs → deletion succeeds).
//    With an absolute main-worktree path the guard fires regardless. ────────────
test("guard fires from a linked worktree missing the hook file (absolute hooksPath)", () => {
  const main = createGitRepo();
  // Install the real pre-push guard into the main worktree's hooks-git dir.
  const hooksDir = path.join(main, HOOKS_SUBPATH);
  mkdirSync(hooksDir, { recursive: true });
  const realHooksDir = repoPath(".devpro/scripts/hooks-git");
  // Use the repo's real pre-push wrapper + JS implementation (keep test hermetic).
  const prePushBody = readFileSync(path.join(realHooksDir, "pre-push"), "utf8");
  const prePushJsBody = readFileSync(path.join(realHooksDir, "pre-push.mjs"), "utf8");
  writeFileSync(path.join(hooksDir, "pre-push"), prePushBody, { mode: 0o755 });
  writeFileSync(path.join(hooksDir, "pre-push.mjs"), prePushJsBody, { mode: 0o644 });
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "base"]);

  // Wire hooksPath the way the product code does.
  ensureGitHooksPathAt(main);

  // A bare remote + a seeded victim branch to delete.
  const bare = path.join(tmpRoot, `bare-${counter++}.git`);
  git(tmpRoot, ["init", "-q", "--bare", bare]);
  git(main, ["remote", "add", "origin", bare]);
  git(main, ["push", "-q", "origin", "HEAD:refs/heads/victim"]);

  // Linked worktree on a NEW branch that does NOT carry the hooks-git file.
  const wt = path.join(tmpRoot, `wt-${counter++}`);
  git(main, ["worktree", "add", "-q", wt, "-b", "nohookbranch"]);
  rmSync(path.join(wt, ".devpro"), { recursive: true, force: true });
  const commit = spawnSync("git", ["commit", "-a", "-q", "-m", "nohook"], {
    cwd: wt,
    encoding: "utf8",
  });
  if (commit.status !== 0) {
    git(wt, ["commit", "--allow-empty", "-q", "-m", "nohook"]);
  }
  assert.equal(
    existsSync(path.join(wt, HOOKS_SUBPATH)),
    false,
    "precondition: the linked worktree branch must lack the hook file"
  );

  // Attempt the remote deletion FROM THE WORKTREE. The guard must block it.
  const del = spawnSync("git", ["push", "origin", ":refs/heads/victim"], {
    cwd: wt,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.notEqual(del.status, 0, `deletion must be blocked from the worktree; status=${del.status} stderr=${del.stderr}`);
  assert.match(del.stderr || "", /accident guard|remote branch deletion/i,
    `pre-push advisory should appear; stderr=${del.stderr}`);
});

// ── command-injection regression: the hooks-git path is derived from
//    `git worktree list` (a filesystem path), so a repo created under a dir whose
//    name contains shell metachars ($()/backtick) MUST NOT be shell-interpolated
//    when writing core.hooksPath. A string `execSync` with the path in double
//    quotes WOULD expand $() inside the quotes; the argv-form execFileSync does
//    not. Cross-model review (codex) flagged this; verified empirically. ────────
test("ensureGitHooksPathAt does not shell-interpolate a $()-laden repo path (no command injection)", () => {
  // Repo whose PARENT dir name contains a $() payload that, if interpolated,
  // would create a marker file. git worktree list reports this literal path.
  const markerName = "INJECTED_MARKER";
  const evilParent = path.join(tmpRoot, `evil-$(touch ${markerName})-${counter++}`);
  const dir = path.join(evilParent, "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);

  const markerPath = path.join(dir, markerName);
  assert.ok(!existsSync(markerPath), "precondition: injection marker must not exist yet");

  // This is the call that writes core.hooksPath with the $()-laden path.
  ensureGitHooksPathAt(dir);

  assert.ok(
    !existsSync(markerPath),
    "command injection: the $() in the repo path was shell-interpolated when writing core.hooksPath"
  );
  // And the value is stored literally (proves the path was passed as an argv arg).
  const stored = getHooksPath(dir);
  assert.match(stored, /\$\(touch /, "the $()-laden path should be stored literally, not expanded");
});

// ── GH-2483-a prove-it: consumer／husky coexistence (expect RED until fix) ─────

test("foreign husky-style hooksPath MUST NOT be overwritten; pre-commit still discoverable", () => {
  const dir = createGitRepo();
  const foreign = installHuskyStyleHooksPath(dir, {
    preCommitBody: "#!/bin/sh\necho CONSUMER_PRE_COMMIT_OK\n",
  });
  assert.equal(getHooksPath(dir), foreign, "precondition: husky-style hooksPath set");

  // Sanity: consumer pre-commit is discoverable BEFORE helper.
  const beforeRun = runGitHook(dir, "pre-commit");
  assert.equal(
    beforeRun.status,
    0,
    `precondition: git hook run pre-commit should succeed; stderr=${beforeRun.stderr}`
  );
  assert.match(beforeRun.combined, /CONSUMER_PRE_COMMIT_OK/);

  const result = ensureGitHooksPathAt(dir);
  const after = getHooksPath(dir);

  assert.equal(
    after,
    foreign,
    `foreign husky hooksPath must be preserved; got '${after}' (expected '${foreign}')`
  );
  assert.notEqual(
    after,
    expectedHooksPath(dir),
    "MUST NOT wholesale overwrite foreign hooksPath to hooks-git"
  );
  assert.notEqual(
    result.detail,
    "configured absolute main-worktree hooks path",
    "foreign skip／chain MUST NOT be reported as repaired-to-hooks-git"
  );
  assert.match(
    result.detail ?? "",
    /preserved|chained|chain/i,
    `detail should reflect consumer preserve／chain; got '${result.detail}'`
  );

  const afterRun = runGitHook(dir, "pre-commit");
  assert.equal(
    afterRun.status,
    0,
    `consumer pre-commit must remain discoverable after helper; status=${afterRun.status} stderr=${afterRun.stderr}`
  );
  assert.match(
    afterRun.combined,
    /CONSUMER_PRE_COMMIT_OK/,
    `consumer pre-commit output missing after helper; combined=${afterRun.combined}`
  );
});

test("foreign non-husky hooksPath MUST NOT be corrected to hooks-git", () => {
  const dir = createGitRepo();
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  writeFileSync(
    path.join(foreignDir, "pre-commit"),
    "#!/bin/sh\necho FOREIGN_PRE_COMMIT\n",
    { mode: 0o755 }
  );
  chmodSync(path.join(foreignDir, "pre-commit"), 0o755);
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);
  const before = getHooksPath(dir);
  assert.equal(before, ".consumer-hooks");

  const result = ensureGitHooksPathAt(dir);
  const after = getHooksPath(dir);

  assert.equal(
    after,
    before,
    "arbitrary foreign hooksPath must not be 'corrected' to hooks-git"
  );
  assert.notEqual(after, expectedHooksPath(dir));
  assert.notEqual(
    result.detail,
    "configured absolute main-worktree hooks path",
    "rewrites the false 'different value → corrects it' foreign claim"
  );
});

test("after foreign preserved, deletion guard reachable via chain (stdin delete → advisory)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  installHuskyStyleHooksPath(dir, {
    // No user pre-push yet — helper MUST install chain at .husky/pre-push (D3).
    preCommitBody: "#!/bin/sh\nexit 0\n",
  });
  const foreign = getHooksPath(dir);
  assert.equal(foreign, ".husky/_");

  const result = ensureGitHooksPathAt(dir);

  assert.equal(
    getHooksPath(dir),
    foreign,
    "coexistence: hooksPath must stay husky-style while guard is chained"
  );
  assert.match(
    result.detail ?? "",
    /preserved|chained|chain/i,
    `outcome detail should mention preserve／chain; got '${result.detail}'`
  );

  const chained = path.join(dir, ".husky", "pre-push");
  assert.ok(
    existsSync(chained),
    "helper must install deletion-guard chain at .husky/pre-push for husky-shaped foreign"
  );
  assert.match(
    readFileSync(chained, "utf8"),
    new RegExp(CHAIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "chained pre-push must carry the stable chain marker"
  );

  const deletionStdin =
    `refs/heads/coexist-delete ${ZERO_SHA} refs/heads/coexist-delete ${REMOTE_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: deletionStdin });
  assert.notEqual(
    hookRun.status,
    0,
    `deletion guard must be reachable under preserved foreign hooksPath; status=${hookRun.status} stderr=${hookRun.stderr}`
  );
  assert.match(
    hookRun.combined,
    /accident guard|remote branch deletion|prune-merged-local/i,
    `pre-push advisory should appear via chain; combined=${hookRun.combined}`
  );
});

test("husky non-executable shebangless pre-push with intermediate failure honors sh -e after wrap", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  // Husky user hooks are often mode 0644 and shebangless; husky invokes via `sh -e`.
  const body = [
    "echo HUSKY_PRE_PUSH_START",
    "false",
    "echo HUSKY_SHOULD_NOT_REACH",
    "",
  ].join("\n");
  installHuskyStyleHooksPath(dir, {
    prePushBody: body,
    prePushMode: 0o644,
  });

  const result = ensureGitHooksPathAt(dir);
  assert.equal(
    getHooksPath(dir),
    ".husky/_",
    "husky hooksPath must remain foreign after helper"
  );
  assert.match(
    result.detail ?? "",
    /preserved|chained|chain/i,
    `detail should reflect chain wrap; got '${result.detail}'`
  );

  const chained = path.join(dir, ".husky", "pre-push");
  assert.ok(existsSync(chained), "chain／wrap must exist at .husky/pre-push");
  // Discovery entry may be the wrap; original body must still be invoked via sh -e.
  const normalStdin =
    `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  assert.notEqual(
    hookRun.status,
    0,
    `wrapped husky pre-push must fail via sh -e when intermediate command fails; status=${hookRun.status} combined=${hookRun.combined}`
  );
  assert.doesNotMatch(
    hookRun.combined,
    /HUSKY_SHOULD_NOT_REACH/,
    "sh -e must stop before the unreachable echo"
  );
});

test("out-of-clone foreign hooksPath → preserve config; no destination mutation; risk", () => {
  const dir = createGitRepo();
  const outside = path.join(tmpRoot, `outside-hooks-${counter++}`);
  mkdirSync(outside, { recursive: true });
  const outsidePrePush = path.join(outside, "pre-push");
  writeFileSync(outsidePrePush, "#!/bin/sh\necho OUTSIDE_HOOK\nexit 0\n", {
    mode: 0o755,
  });
  chmodSync(outsidePrePush, 0o755);
  const beforeListing = readdirSync(outside).sort();
  const beforeBytes = readFileSync(outsidePrePush, "utf8");

  git(dir, ["config", "core.hooksPath", outside]);
  assert.equal(getHooksPath(dir), outside);

  const result = ensureGitHooksPathAt(dir);

  assert.equal(
    getHooksPath(dir),
    outside,
    "out-of-clone foreign hooksPath must not be mutated to hooks-git"
  );
  assert.deepEqual(
    readdirSync(outside).sort(),
    beforeListing,
    "MUST NOT write wrap／chain files into an out-of-clone hooks destination"
  );
  assert.equal(
    readFileSync(outsidePrePush, "utf8"),
    beforeBytes,
    "out-of-clone pre-push bytes must be unchanged"
  );
  assert.equal(
    result.outcome,
    "risk",
    `out-of-clone destination should yield risk; got outcome=${result.outcome} detail=${result.detail}`
  );
  assert.match(
    result.detail ?? "",
    /out-of-clone|shared-hooks|chain unavailable/i,
    `risk detail must mention out-of-clone／unavailable chain; got '${result.detail}'`
  );
});

test("discovery file-entry symlink must not write-through outside clone", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const outsideTarget = path.join(tmpRoot, `symlink-target-${counter++}`);
  writeFileSync(outsideTarget, "ORIGINAL_OUTSIDE_PRE_PUSH\n", { mode: 0o644 });
  const beforeOutside = readFileSync(outsideTarget, "utf8");

  installHuskyStyleHooksPath(dir, {
    preCommitBody: "#!/bin/sh\nexit 0\n",
  });
  const userPrePush = path.join(dir, ".husky", "pre-push");
  // Replace any plain file with a symlink pointing outside the clone.
  if (existsSync(userPrePush)) rmSync(userPrePush);
  symlinkSync(outsideTarget, userPrePush);
  assert.ok(lstatSync(userPrePush).isSymbolicLink(), "precondition: discovery is a symlink");

  const result = ensureGitHooksPathAt(dir);

  assert.equal(
    getHooksPath(dir),
    ".husky/_",
    "foreign husky hooksPath must stay preserved for symlink case"
  );
  assert.equal(
    readFileSync(outsideTarget, "utf8"),
    beforeOutside,
    "MUST NOT write-through discovery symlink into out-of-clone target"
  );
  // Either replace symlink inode in-clone, or risk without mutation — never write-through.
  const stillSymlink = existsSync(userPrePush) && lstatSync(userPrePush).isSymbolicLink();
  if (stillSymlink) {
    assert.match(
      result.detail ?? "",
      /risk|unavailable|symlink|preserved/i,
      `if symlink retained, outcome must be risk／no unsafe mutation; detail=${result.detail}`
    );
  } else {
    assert.ok(
      existsSync(userPrePush),
      "replacing symlink inode must leave an in-clone discovery entry"
    );
    assert.equal(
      lstatSync(userPrePush).isSymbolicLink(),
      false,
      "atomic replace should substitute the symlink inode, not write through it"
    );
    assert.match(
      readFileSync(userPrePush, "utf8"),
      new RegExp(CHAIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "replaced discovery entry should be the chain wrapper"
    );
  }
});

test("dangling backup-path symlink must not write-through outside clone (F-fhpcc-r1-01)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  writeFileSync(discovery, "#!/bin/sh\necho CONSUMER_OK\nexit 0\n", { mode: 0o755 });
  chmodSync(discovery, 0o755);

  const outsideTarget = path.join(tmpRoot, `dangling-backup-target-${counter++}`);
  // Dangling: symlink name exists under discovery dir, target file does not.
  const primaryBackup = `${discovery}.devpro-wrapped`;
  symlinkSync(outsideTarget, primaryBackup);
  assert.ok(lstatSync(primaryBackup).isSymbolicLink(), "precondition: primary backup is symlink");
  assert.equal(existsSync(outsideTarget), false, "precondition: target is dangling");

  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);
  const result = ensureGitHooksPathAt(dir);

  assert.equal(existsSync(outsideTarget), false, "MUST NOT create out-of-clone file via backup symlink write-through");
  assert.ok(lstatSync(primaryBackup).isSymbolicLink(), "dangling primary backup symlink must remain unfollowed");
  assert.equal(getHooksPath(dir), ".consumer-hooks");
  // Collision-safe sibling backup + wrap, or risk — never write-through.
  if (result.outcome === "risk") {
    assert.match(result.detail ?? "", /unavailable|risk|symlink|out-of-clone/i);
  } else {
    assert.ok(existsSync(discovery), "discovery must remain present");
    assert.equal(lstatSync(discovery).isSymbolicLink(), false);
    assert.match(readFileSync(discovery, "utf8"), new RegExp(CHAIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(
      readFileSync(discovery, "utf8"),
      /pre-push\.devpro-wrapped\.2|consumer-backup: pre-push\.devpro-wrapped\.2/
    );
    const backup2 = `${discovery}.devpro-wrapped.2`;
    assert.ok(existsSync(backup2), "collision-safe .2 backup must be used when primary is a symlink");
    assert.equal(lstatSync(backup2).isSymbolicLink(), false);
  }
});

test("ordinary-foreign executable symlink backup preserves +x (F-fhpcc-r1-02)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const realHook = path.join(foreignDir, "real-pre-push.sh");
  writeFileSync(
    realHook,
    "#!/bin/sh\necho ORDINARY_FOREIGN_EXEC\nexit 0\n",
    { mode: 0o755 }
  );
  chmodSync(realHook, 0o755);
  const discovery = path.join(foreignDir, "pre-push");
  symlinkSync(realHook, discovery);
  assert.ok(lstatSync(discovery).isSymbolicLink());
  if (process.platform !== "win32") {
    assert.ok((statSync(discovery).mode & 0o111) !== 0, "precondition: symlink target is executable");
  }

  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);
  const result = ensureGitHooksPathAt(dir);
  assert.match(result.detail ?? "", /preserved|chained|chain/i);

  const backup = `${discovery}.devpro-wrapped`;
  assert.ok(existsSync(backup), "backup must exist");
  assert.equal(lstatSync(backup).isSymbolicLink(), false, "backup must be a regular file");
  const backupMode = lstatSync(backup).mode & 0o777;
  if (process.platform !== "win32") {
    assert.ok(
      (backupMode & 0o111) !== 0,
      `ordinary-foreign backup must preserve executable bit; mode=${backupMode.toString(8)}`
    );
  }

  const normalStdin = `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  assert.equal(
    hookRun.status,
    0,
    `exec of executable backup must succeed (not 126); status=${hookRun.status} combined=${hookRun.combined}`
  );
  assert.match(hookRun.combined, /ORDINARY_FOREIGN_EXEC/);
});

test("collision-safe .2 backup stays bound on guard-path refresh (F-fhpcc-r1-03)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  writeFileSync(
    discovery,
    "#!/bin/sh\necho CONSUMER_FROM_DOT2\nexit 0\n",
    { mode: 0o755 }
  );
  chmodSync(discovery, 0o755);

  // Occupy primary backup with an UNRELATED payload so allocate chooses .2.
  const primaryBackup = `${discovery}.devpro-wrapped`;
  writeFileSync(primaryBackup, "#!/bin/sh\necho WRONG_PRIMARY\nexit 0\n", {
    mode: 0o755,
  });
  chmodSync(primaryBackup, 0o755);

  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);
  const first = ensureGitHooksPathAt(dir);
  assert.match(first.detail ?? "", /preserved|chained|chain/i);

  const wrapper1 = readFileSync(discovery, "utf8");
  assert.match(wrapper1, new RegExp(`${CONSUMER_BACKUP_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}pre-push\\.devpro-wrapped\\.2`));
  assert.match(wrapper1, /pre-push\.devpro-wrapped\.2/);
  assert.match(
    wrapper1,
    /dirname "\$0"/,
    "consumer invocation must be $0-relative (not absolute sibling path)"
  );
  assert.doesNotMatch(
    wrapper1.split("\n").find((l) => l.includes(" || ") && l.includes("devpro-wrapped")) ?? "",
    /pre-push\.devpro-wrapped'/
  );

  // Force guard-path refresh: rewrite marker wrapper to an old guard path so
  // helper rewrites wrapper while preserving consumer association.
  const stale = wrapper1.replace(
    /'([^']*hooks-git[\\/]pre-push)'/,
    "'/tmp/stale-devpro-guard-pre-push'"
  );
  assert.notEqual(stale, wrapper1, "precondition: guard path must be stale-able");
  writeFileSync(discovery, stale, { mode: 0o755 });
  chmodSync(discovery, 0o755);

  const second = ensureGitHooksPathAt(dir);
  assert.match(second.detail ?? "", /preserved|chained|chain/i);
  const wrapper2 = readFileSync(discovery, "utf8");
  assert.match(
    wrapper2,
    new RegExp(`${CONSUMER_BACKUP_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}pre-push\\.devpro-wrapped\\.2`)
  );
  assert.match(wrapper2, /pre-push\.devpro-wrapped\.2/);
  assert.match(wrapper2, /dirname "\$0"/, "guard-path refresh must keep $0-relative consumer");
  // Must NOT re-bind to unrelated primary.
  const consumerLines = wrapper2.split("\n").filter((l) => l.includes(".devpro-wrapped"));
  assert.ok(
    consumerLines.every((l) => l.includes(".devpro-wrapped.2") || l.startsWith(CONSUMER_BACKUP_MARKER_PREFIX)),
    `refresh must keep .2 association; lines=${consumerLines.join(" | ")}`
  );

  const normalStdin = `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  assert.equal(hookRun.status, 0, `status=${hookRun.status} combined=${hookRun.combined}`);
  assert.match(hookRun.combined, /CONSUMER_FROM_DOT2/);
  assert.doesNotMatch(hookRun.combined, /WRONG_PRIMARY/);
});

test("stdin tee reaches consumer after wrap (F-fhpcc-r1-04)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const markerOut = path.join(dir, "consumer-stdin-seen.txt");
  writeFileSync(
    path.join(foreignDir, "pre-push"),
    `#!/bin/sh\ncat > '${markerOut.replace(/'/g, `'\"'\"'`)}'\nexit 0\n`,
    { mode: 0o755 }
  );
  chmodSync(path.join(foreignDir, "pre-push"), 0o755);
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);

  assert.match(ensureGitHooksPathAt(dir).detail ?? "", /preserved|chained|chain/i);

  const payload = `HEAD ${REAL_SHA} refs/heads/tee-feature ${ZERO_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: payload });
  assert.equal(hookRun.status, 0, `combined=${hookRun.combined}`);
  assert.ok(existsSync(markerOut), "consumer must receive replayed stdin");
  assert.equal(readFileSync(markerOut, "utf8"), payload);
});

test("publish-failure injection leaves discovery entry executable (no rename-away gap)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  const original = "#!/bin/sh\necho ORIGINAL_DISCOVERY\nexit 0\n";
  writeFileSync(discovery, original, { mode: 0o755 });
  chmodSync(discovery, 0o755);
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);

  __testHooksPathInstall.setAtomicPublishDiscovery(() => {
    throw new Error("injected staged-publish failure");
  });
  try {
    const result = ensureGitHooksPathAt(dir);
    assert.equal(result.outcome, "risk", `inject fail → risk; got ${result.outcome} ${result.detail}`);
    assert.match(result.detail ?? "", /unavailable|chain/i);
    assert.equal(readFileSync(discovery, "utf8"), original, "discovery bytes must remain original");
    assert.equal(lstatSync(discovery).isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assert.ok((lstatSync(discovery).mode & 0o111) !== 0, "discovery must stay executable");
    } else {
      const hookRun = runGitHook(dir, "pre-push", {
        stdin: `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`,
      });
      assert.equal(hookRun.status, 0, `preserved discovery must still run; ${hookRun.combined}`);
      assert.match(hookRun.combined, /ORIGINAL_DISCOVERY/);
    }
    // Staging leftovers must not accumulate on failure.
    const leftovers = readdirSync(foreignDir).filter((n) =>
      n.includes(".devpro-staging.")
    );
    assert.deepEqual(leftovers, [], `staging files must be cleaned; got ${leftovers}`);
  } finally {
    __testHooksPathInstall.reset();
  }
});

test("unreadable existing ordinary-foreign pre-push → risk without publish (F-fhpcc-r2-01)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  const original = "#!/bin/sh\necho SECRET_CONSUMER\nexit 0\n";
  writeFileSync(discovery, original, { mode: 0o644 });
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (String(target).replaceAll("\\", "/").endsWith("/.consumer-hooks/pre-push")) {
      const error = new Error("injected unreadable discovery");
      error.code = "EACCES";
      throw error;
    }
    return originalReadFileSync(target, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = ensureGitHooksPathAt(dir);
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
  assert.equal(
    result.outcome,
    "risk",
    `unreadable discovery must be risk not repaired; got ${result.outcome} ${result.detail}`
  );
  assert.match(result.detail ?? "", /unavailable|chain/i);
  assert.equal(getHooksPath(dir), ".consumer-hooks", "hooksPath must stay foreign");
  assert.equal(
    readFileSync(discovery, "utf8"),
    original,
    "unreadable entry must not be atomically replaced without backup"
  );
  assert.equal(
    existsSync(`${discovery}.devpro-wrapped`),
    false,
    "must not publish backup when discovery could not be read"
  );
  assert.doesNotMatch(
    readFileSync(discovery, "utf8"),
    new RegExp(CHAIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "chain wrapper must not be published over unreadable discovery"
  );
});

// Scenario: Ordinary Foreign Backup Execution Follows Native Git On Each Host
test("ordinary-foreign backup follows native git hook behavior (F-fhpcc-r2-02)", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  // Requested 0644 is non-executable on POSIX; Git for Windows can still run
  // this shell hook, so the same-host native git result is the Windows oracle.
  writeFileSync(
    discovery,
    "#!/bin/sh\necho SHOULD_NOT_RUN_NONEXEC\nexit 1\n",
    { mode: 0o644 }
  );
  chmodSync(discovery, 0o644);
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);
  const nativeRun = runGitHook(dir, "pre-push");
  if (process.platform === "win32") {
    assert.equal(nativeRun.status, 1, `native Git must exercise the Windows hook; ${nativeRun.combined}`);
    assert.match(nativeRun.combined, /SHOULD_NOT_RUN_NONEXEC/);
  }

  const result = ensureGitHooksPathAt(dir);
  assert.match(result.detail ?? "", /preserved|chained|chain/i);

  const wrapper = readFileSync(discovery, "utf8");
  assert.match(wrapper, /\[ ! -x /, "ordinary-foreign chain must gate on -x");
  assert.doesNotMatch(
    wrapper.split("\n").find((l) => l.includes(".devpro-wrapped") && l.includes("||")) ?? "",
    /\[ ! -f /
  );

  const backup = `${discovery}.devpro-wrapped`;
  assert.ok(existsSync(backup), "non-exec consumer must still be backed up");
  assert.equal((lstatSync(backup).mode & 0o111), 0, "backup must remain non-executable");

  const normalStdin = `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  if (process.platform === "win32") {
    assert.equal(hookRun.status, nativeRun.status, `chain must match native Git status; ${hookRun.combined}`);
    assert.match(hookRun.combined, /SHOULD_NOT_RUN_NONEXEC/);
  } else {
    assert.equal(hookRun.status, 0, `non-executable POSIX consumer must be skipped; ${hookRun.combined}`);
    assert.doesNotMatch(hookRun.combined, /SHOULD_NOT_RUN_NONEXEC/);
  }
});

test("normalizeGitBashDrivePath covers /c, C:/, C:\\ forms (F-fhpcc-r2-03)", () => {
  // Host-independent pure transform (win32-oriented unit lock without a win32 runner).
  assert.equal(
    mapMsysDrivePath("/c/repo/.consumer-hooks"),
    "C:\\repo\\.consumer-hooks"
  );
  assert.equal(mapMsysDrivePath("/Users/me/repo"), "/Users/me/repo");
  // Raw Win32 resolve consults the current drive; it must not be mistaken for
  // the deterministic Git-Bash /c -> C: mapping.
  assert.notEqual(
    mapMsysDrivePath("/c/repo/.consumer-hooks"),
    path.win32.resolve("/c/repo/.consumer-hooks")
  );

  if (process.platform === "win32") {
    assert.equal(
      normalizeGitBashDrivePath("/c/repo/.consumer-hooks"),
      "C:\\repo\\.consumer-hooks"
    );
    assert.equal(
      normalizeGitBashDrivePath("C:/repo/.consumer-hooks"),
      "C:\\repo\\.consumer-hooks"
    );
    assert.equal(
      normalizeGitBashDrivePath("C:\\repo\\.consumer-hooks"),
      "C:\\repo\\.consumer-hooks"
    );
    assert.equal(normalizeGitBashDrivePath("/Users/me/repo"), "/Users/me/repo");
  } else {
    // Production helper must preserve POSIX `/c/...` outside Windows.
    assert.equal(
      normalizeGitBashDrivePath("/c/repo/.consumer-hooks"),
      "/c/repo/.consumer-hooks"
    );
    assert.equal(
      normalizeGitBashDrivePath("C:/repo/.consumer-hooks"),
      "C:/repo/.consumer-hooks"
    );
    assert.equal(
      normalizeGitBashDrivePath("C:\\repo\\.consumer-hooks"),
      "C:\\repo\\.consumer-hooks"
    );
  }
});

test("non-win32 absolute POSIX /c hooksPath is not remapped (F-fhpcc-r2-03)", {
  skip: process.platform === "win32" ? "win32 maps /c by design" : false,
}, () => {
  // Production caller of mapMsysDrivePath (normalizeGitBashDrivePath) must not
  // rewrite absolute POSIX `/c/...` into a Windows drive form on darwin/linux.
  const posixHooks = "/c/repo/.consumer-hooks";
  const normalized = normalizeGitBashDrivePath(posixHooks);
  assert.equal(normalized, posixHooks, "MUST NOT remap to Windows drive form on darwin/linux");
  assert.ok(path.isAbsolute(normalized), "must remain native absolute POSIX");
  assert.equal(path.posix.isAbsolute(normalized), true);
  assert.doesNotMatch(normalized, /^[A-Za-z]:[\\/]/);
  // Pure mapper still transforms (host-independent); production helper must not.
  assert.equal(mapMsysDrivePath(posixHooks), "C:\\repo\\.consumer-hooks");
  assert.notEqual(normalized, mapMsysDrivePath(posixHooks));
});

test("linked-worktree move: stale absolute consumer backup refreshes to $0-relative", () => {
  const dir = createGitRepo();
  installRealHooksGit(dir);
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  writeFileSync(
    discovery,
    "#!/bin/sh\necho CONSUMER_AFTER_MOVE\nexit 0\n",
    { mode: 0o755 }
  );
  chmodSync(discovery, 0o755);
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);

  const first = ensureGitHooksPathAt(dir);
  assert.match(first.detail ?? "", /preserved|chained|chain/i);

  const backup = `${discovery}.devpro-wrapped`;
  assert.ok(existsSync(backup), "precondition: sibling backup exists");
  const wrapper1 = readFileSync(discovery, "utf8");
  assert.match(wrapper1, /dirname "\$0"/);

  // Simulate post-move legacy wrapper: absolute backup path points at a missing
  // old location, while the sibling backup + marker basename remain valid under
  // the current discovery dir.
  const missingOld = path.join(
    tmpRoot,
    `missing-old-backup-${counter++}`,
    "pre-push.devpro-wrapped"
  );
  const missingOldQuoted = `'${missingOld.replace(/'/g, `'\"'\"'`)}'`;
  const guardLine =
    wrapper1.split("\n").find((l) => l.replaceAll("\\", "/").includes("hooks-git/pre-push") && l.includes("|| exit")) ??
    (() => {
      throw new Error("precondition: guard invocation line missing");
    })();
  const absoluteLegacy = [
    "#!/bin/sh",
    CHAIN_MARKER,
    `${CONSUMER_BACKUP_MARKER_PREFIX}pre-push.devpro-wrapped`,
    "# Chains the devpro pre-push deletion guard, then optional consumer hook.",
    'STDIN_FILE=$(mktemp) || exit 1',
    'trap \'rm -f "$STDIN_FILE"\' EXIT HUP INT TERM',
    'cat > "$STDIN_FILE" || exit 1',
    // Keep current guard path so early return would have been compliant without
    // the legacy／missing-backup checks.
    guardLine,
    `[ ! -x ${missingOldQuoted} ] || ${missingOldQuoted} "$@" < "$STDIN_FILE" || exit $?`,
    "exit 0",
    "",
  ].join("\n");
  assert.ok(
    absoluteLegacy.includes(CHAIN_MARKER) &&
      absoluteLegacy.includes(`${CONSUMER_BACKUP_MARKER_PREFIX}pre-push.devpro-wrapped`),
    "precondition: legacy wrapper retains marker + backup basename"
  );
  assert.equal(existsSync(missingOld), false, "precondition: old absolute backup missing");
  assert.ok(existsSync(backup), "precondition: new-discovery sibling backup still present");
  assert.doesNotMatch(absoluteLegacy, /dirname "\$0"/);
  writeFileSync(discovery, absoluteLegacy, { mode: 0o755 });
  chmodSync(discovery, 0o755);

  const second = ensureGitHooksPathAt(dir);
  assert.match(
    second.detail ?? "",
    /preserved|chained|chain/i,
    `stale absolute backup must refresh not risk; got ${second.outcome} ${second.detail}`
  );
  assert.notEqual(second.outcome, "risk");
  const wrapper2 = readFileSync(discovery, "utf8");
  assert.match(wrapper2, /dirname "\$0"/, "refresh must rewrite consumer to $0-relative");
  assert.doesNotMatch(wrapper2, new RegExp(missingOld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    wrapper2,
    new RegExp(`${CONSUMER_BACKUP_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}pre-push\\.devpro-wrapped`)
  );

  const normalStdin = `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`;
  const hookRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  assert.equal(
    hookRun.status,
    0,
    `consumer must still run after refresh; status=${hookRun.status} combined=${hookRun.combined}`
  );
  assert.match(hookRun.combined, /CONSUMER_AFTER_MOVE/);
});

// Scenario: Apostrophe Path Launches Direct And Chained Deletion Guard
test("apostrophe in repo/guard path publishes chain with quoted guard", () => {
  const dir = path.join(tmpRoot, `repo-apos-${counter++}-o'repo`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);

  installRealHooksGit(dir);
  git(dir, ["config", "core.hooksPath", expectedHooksPath(dir)]);
  const normalStdin = `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}\n`;
  const directGuardRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  const deletionStdin =
    `refs/heads/apos-delete ${ZERO_SHA} refs/heads/apos-delete ${REMOTE_SHA}\n`;
  const directDeleteRun = runGitHook(dir, "pre-push", { stdin: deletionStdin });
  const foreignDir = path.join(dir, ".consumer-hooks");
  mkdirSync(foreignDir, { recursive: true });
  const discovery = path.join(foreignDir, "pre-push");
  writeFileSync(
    discovery,
    "#!/bin/sh\necho APOSTROPHE_CONSUMER\nexit 0\n",
    { mode: 0o755 }
  );
  chmodSync(discovery, 0o755);
  git(dir, ["config", "core.hooksPath", ".consumer-hooks"]);

  const result = ensureGitHooksPathAt(dir);
  assert.notEqual(
    result.outcome,
    "risk",
    `apostrophe path must publish chain; got ${result.outcome} ${result.detail}`
  );
  assert.match(result.detail ?? "", /preserved|chained|chain/i);

  const wrapper = readFileSync(discovery, "utf8");
  assert.match(wrapper, new RegExp(CHAIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // shSingleQuote rewrites ' → '"'"' — raw path must not be required as substring.
  assert.match(wrapper, /'"'"'/);
  assert.match(wrapper.replaceAll("\\", "/"), /hooks-git\/pre-push/);
  assert.match(wrapper, /dirname "\$0"/);

  const hookRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
  assert.equal(directGuardRun.status, 0, `direct guard path fails before chain; ${directGuardRun.combined}`);
  assert.equal(
    hookRun.status,
    0,
    `status=${hookRun.status} combined=${hookRun.combined}`
  );
  assert.match(hookRun.combined, /APOSTROPHE_CONSUMER/);
  assert.notEqual(directDeleteRun.status, 0, "direct guard must reject deletion under apostrophe path");
  assert.match(directDeleteRun.combined, /accident guard|remote branch deletion|prune-merged-local/i);
  const chainedDeleteRun = runGitHook(dir, "pre-push", { stdin: deletionStdin });
  assert.notEqual(chainedDeleteRun.status, 0, "chained guard must reject deletion under apostrophe path");
  assert.match(chainedDeleteRun.combined, /accident guard|remote branch deletion|prune-merged-local/i);
  assert.doesNotMatch(chainedDeleteRun.combined, /APOSTROPHE_CONSUMER/);
});
