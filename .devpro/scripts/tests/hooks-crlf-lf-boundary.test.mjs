/**
 * hooks-crlf-lf-boundary.test.mjs
 *
 * Prove-it for consumer husky／shell hook CRLF on POSIX (GH-2483-c / D3):
 *   - Direct: CRLF hook fails under sh; consent repair → succeeds; mode preserved
 *   - Chained: husky foreign hooksPath → ensureGitHooksPath chain → CRLF backup
 *     fails; repair → succeeds; deletion-guard failure exit still propagates
 *   - Negatives: no consent／missing／symlink／multi-file fail → zero writes
 *   - win32: skip POSIX spawn (not R1 evidence); non-win32 missing sh → fail
 *   - Managed gitattributes MUST NOT contain `.husky`
 *
 * Minimal helpers copied from session-start-hookspath-install.test.mjs —
 * do not bloat that file.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
  lstatSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  ensureGitHooksPath,
  DELETION_GUARD_CHAIN_MARKER,
  CONSUMER_BACKUP_MARKER_PREFIX,
} from "../hooks/lib/git-utils.mjs";
import {
  repairNamedHookEol,
  main as repairMain,
  __testHooks,
} from "../repair-named-hook-eol.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOKS_SUBPATH = ".devpro/scripts/hooks-git";
const CHAIN_MARKER = DELETION_GUARD_CHAIN_MARKER;
const ZERO_SHA = "0000000000000000000000000000000000000000";
const REMOTE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const REAL_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const IS_WIN32 = process.platform === "win32";
const WIN32_SKIP = "POSIX sh spawn required; win32 skip is not R1 evidence";

/** Resolve `sh` once; non-win32 MUST have it or tests fail (not skip). */
function requireSh() {
  if (IS_WIN32) return null;
  const probed = spawnSync("sh", ["-c", "exit 0"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (probed.error || probed.status !== 0) {
    assert.fail(
      `non-win32 host must have working \`sh\` for CRLF prove-it; error=${probed.error} status=${probed.status}`
    );
  }
  return "sh";
}

const SH = requireSh();

const tmpRoot = makeTempDir("hooks-crlf-lf-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

let counter = 0;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createGitRepo() {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

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

function installHuskyStyleHooksPath(dir, { prePushBody, prePushMode } = {}) {
  writeHuskyDispatcher(dir, "pre-commit");
  writeHuskyDispatcher(dir, "pre-push");
  const huskyDir = path.join(dir, ".husky");
  mkdirSync(huskyDir, { recursive: true });
  if (prePushBody != null) {
    const p = path.join(huskyDir, "pre-push");
    writeFileSync(p, prePushBody);
    if (prePushMode != null) chmodSync(p, prePushMode);
  }
  git(dir, ["config", "core.hooksPath", ".husky/_"]);
  return ".husky/_";
}

function installRealHooksGit(dir) {
  const hooksDir = path.join(dir, HOOKS_SUBPATH);
  mkdirSync(hooksDir, { recursive: true });
  const realHooksDir = repoPath(".devpro/scripts/hooks-git");
  writeFileSync(
    path.join(hooksDir, "pre-push"),
    readFileSync(path.join(realHooksDir, "pre-push")),
    { mode: 0o755 }
  );
  chmodSync(path.join(hooksDir, "pre-push"), 0o755);
  writeFileSync(
    path.join(hooksDir, "pre-push.mjs"),
    readFileSync(path.join(realHooksDir, "pre-push.mjs")),
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
    combined: `${stdout}\n${stderr}`,
  };
}

/** CRLF shell body that triggers `: not found`-style failure under POSIX sh. */
function crlfTrueHookBody() {
  return Buffer.from("#!/bin/sh\r\ntrue\r\n", "utf8");
}

function resolveConsumerBackup(wrapperPath) {
  const content = readFileSync(wrapperPath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.startsWith(CONSUMER_BACKUP_MARKER_PREFIX)) continue;
    const base = line.slice(CONSUMER_BACKUP_MARKER_PREFIX.length).trim();
    return path.join(path.dirname(wrapperPath), base);
  }
  return "";
}

function runShOnFile(filePath) {
  assert.ok(SH, "sh required");
  return spawnSync(SH, [filePath], {
    encoding: "utf8",
    timeout: 5000,
  });
}

// ── Managed gitattributes must not claim .husky ─────────────────────────────

test("managed gitattributes SSOT and wrappers omit .husky; source hooks-git is LF", () => {
  const alignment = readFileSync(
    repoPath(".devpro/agent-rules/gitattributes-alignment.md"),
    "utf8"
  );
  const begin = alignment.indexOf(
    "# devpro-agent-rules gitattributes managed begin"
  );
  const end = alignment.indexOf(
    "# devpro-agent-rules gitattributes managed end"
  );
  assert.ok(begin >= 0 && end > begin, "managed block markers present in SSOT");
  const managedBlock = alignment.slice(begin, end);
  assert.doesNotMatch(
    managedBlock,
    /\.husky/,
    "managed gitattributes SSOT MUST NOT contain .husky"
  );

  const rootGa = repoPath(".gitattributes");
  if (existsSync(rootGa)) {
    const ga = readFileSync(rootGa, "utf8");
    const gBegin = ga.indexOf(
      "# devpro-agent-rules gitattributes managed begin"
    );
    const gEnd = ga.indexOf("# devpro-agent-rules gitattributes managed end");
    if (gBegin >= 0 && gEnd > gBegin) {
      assert.doesNotMatch(
        ga.slice(gBegin, gEnd),
        /\.husky/,
        "root .gitattributes managed block MUST NOT contain .husky"
      );
    }
  }

  const hooksGitPrePush = readFileSync(
    repoPath(".devpro/scripts/hooks-git/pre-push")
  );
  assert.equal(
    hooksGitPrePush.includes(0x0d),
    false,
    "source hooks-git/pre-push must be LF-only"
  );
});

// ── Direct POSIX CRLF prove-it ──────────────────────────────────────────────

test(
  "direct: CRLF hook fails under sh; repair succeeds; mode preserved",
  { skip: IS_WIN32 ? WIN32_SKIP : false },
  () => {
    const dir = path.join(tmpRoot, `direct-${counter++}`);
    mkdirSync(dir, { recursive: true });
    const hookPath = path.join(dir, "hook.sh");
    writeFileSync(hookPath, crlfTrueHookBody());
    chmodSync(hookPath, 0o755);
    const modeBefore = lstatSync(hookPath).mode & 0o7777;

    const before = runShOnFile(hookPath);
    assert.notEqual(
      before.status,
      0,
      `CRLF hook must exit non-zero under sh; status=${before.status} stderr=${before.stderr}`
    );

    const result = repairNamedHookEol([hookPath], {
      consent: true,
      cwd: dir,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(
      readFileSync(hookPath).includes(0x0d),
      false,
      "repaired bytes must not contain CR"
    );
    assert.equal(
      lstatSync(hookPath).mode & 0o7777,
      modeBefore,
      "mode must be preserved across repair"
    );

    const after = runShOnFile(hookPath);
    assert.equal(
      after.status,
      0,
      `repaired hook must exit 0; status=${after.status} stderr=${after.stderr}`
    );
  }
);

// ── Chained husky + deletion-guard path ─────────────────────────────────────

test(
  "chained: CRLF consumer backup fails via chain; repair → success; guard exit propagates",
  { skip: IS_WIN32 ? WIN32_SKIP : false },
  () => {
    const dir = createGitRepo();
    installRealHooksGit(dir);

    // Prefer body that triggers `: not found` under sh -e (true\r).
    installHuskyStyleHooksPath(dir, {
      prePushBody: crlfTrueHookBody(),
      prePushMode: 0o755,
    });

    const install = ensureGitHooksPath({ cwd: dir });
    assert.match(
      install.detail ?? "",
      /preserved|chained|chain/i,
      `expect chain install; detail=${install.detail}`
    );

    const discovery = path.join(dir, ".husky", "pre-push");
    assert.ok(existsSync(discovery), "chain discovery must exist");
    const wrapperBytes = readFileSync(discovery);
    assert.equal(
      wrapperBytes.includes(0x0d),
      false,
      "chain wrapper itself must be LF"
    );
    assert.match(
      wrapperBytes.toString("utf8"),
      new RegExp(CHAIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );

    const backup = resolveConsumerBackup(discovery);
    assert.ok(backup && existsSync(backup), `consumer backup missing; backup=${backup}`);
    assert.ok(
      readFileSync(backup).includes(0x0d),
      "precondition: consumer backup still CRLF"
    );

    // Non-deletion stdin so guard passes; failure must come from CRLF consumer.
    const normalStdin = `HEAD ${REAL_SHA} refs/heads/feature-crlf ${ZERO_SHA}\n`;
    const failRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
    assert.notEqual(
      failRun.status,
      0,
      `chained CRLF consumer must fail; status=${failRun.status} combined=${failRun.combined}`
    );

    const repaired = repairNamedHookEol([backup], {
      consent: true,
      cwd: dir,
    });
    assert.equal(repaired.ok, true, repaired.error);
    assert.equal(readFileSync(backup).includes(0x0d), false);

    const okRun = runGitHook(dir, "pre-push", { stdin: normalStdin });
    assert.equal(
      okRun.status,
      0,
      `after repair chain must succeed; status=${okRun.status} combined=${okRun.combined}`
    );

    // Guard failure exit still propagates (deletion stdin).
    const deletionStdin = `refs/heads/victim ${ZERO_SHA} refs/heads/victim ${REMOTE_SHA}\n`;
    const guardRun = runGitHook(dir, "pre-push", { stdin: deletionStdin });
    assert.notEqual(
      guardRun.status,
      0,
      `deletion guard failure must stay non-zero; status=${guardRun.status} combined=${guardRun.combined}`
    );
    assert.match(
      guardRun.combined,
      /accident guard|remote branch deletion|prune-merged-local/i,
      `guard advisory expected; combined=${guardRun.combined}`
    );
  }
);

// ── Negatives: zero writes ──────────────────────────────────────────────────

test("negative: missing consent → zero writes", () => {
  const dir = path.join(tmpRoot, `neg-consent-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "hook.sh");
  const original = crlfTrueHookBody();
  writeFileSync(filePath, original);

  const result = repairNamedHookEol([filePath], { consent: false, cwd: dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.written, []);
  assert.ok(original.equals(readFileSync(filePath)), "bytes must be unchanged");

  const prev = process.cwd();
  try {
    process.chdir(dir);
    const code = repairMain(["--file", filePath]);
    assert.notEqual(code, 0);
  } finally {
    process.chdir(prev);
  }
  assert.ok(original.equals(readFileSync(filePath)));
});

test("negative: missing file → zero writes (prevalidation)", () => {
  const dir = path.join(tmpRoot, `neg-missing-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const good = path.join(dir, "good.sh");
  const original = crlfTrueHookBody();
  writeFileSync(good, original);
  const missing = path.join(dir, "missing.sh");

  const result = repairNamedHookEol([good, missing], {
    consent: true,
    cwd: dir,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.written, []);
  assert.ok(original.equals(readFileSync(good)), "good file must not be written");
});

test("negative: symlink → zero writes", () => {
  const dir = path.join(tmpRoot, `neg-symlink-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "target.sh");
  const link = path.join(dir, "link.sh");
  const original = crlfTrueHookBody();
  writeFileSync(target, original);
  symlinkSync(target, link);
  assert.ok(lstatSync(link).isSymbolicLink());

  const result = repairNamedHookEol([link], { consent: true, cwd: dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.written, []);
  assert.ok(original.equals(readFileSync(target)), "symlink target unchanged");
});

test("negative: multi-file with lone CR → all zero writes", () => {
  const dir = path.join(tmpRoot, `neg-lonecr-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "a.sh");
  const b = path.join(dir, "b.sh");
  const aBody = crlfTrueHookBody();
  const bBody = Buffer.from("#!/bin/sh\r\ntrue\r\nline-with-lone-cr\ronly\n", "utf8");
  writeFileSync(a, aBody);
  writeFileSync(b, bBody);

  const result = repairNamedHookEol([a, b], { consent: true, cwd: dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.written, []);
  assert.ok(aBody.equals(readFileSync(a)));
  assert.ok(bBody.equals(readFileSync(b)));
  assert.match(result.error ?? "", /lone CR/i);
});

test("negative: chmod failure after write reports modified path", () => {
  const dir = path.join(tmpRoot, `neg-chmod-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "hook.sh");
  const original = crlfTrueHookBody();
  writeFileSync(filePath, original);
  chmodSync(filePath, 0o755);

  __testHooks.afterWriteBeforeChmod = () => {
    throw new Error("injected chmod failure");
  };
  try {
    const result = repairNamedHookEol([filePath], { consent: true, cwd: dir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.written, [realpathSync(filePath)]);
    assert.match(result.error ?? "", /modified-or-possibly-modified/);
    assert.match(result.error ?? "", /injected chmod failure/);
    // bytes already rewritten despite chmod failure
    assert.equal(readFileSync(filePath).includes(0x0d), false);
  } finally {
    __testHooks.afterWriteBeforeChmod = null;
  }
});

test("CLI requires --file and consent; exports repairNamedHookEol", () => {
  assert.equal(typeof repairNamedHookEol, "function");
  const dir = path.join(tmpRoot, `cli-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "hook.sh");
  writeFileSync(filePath, crlfTrueHookBody());
  chmodSync(filePath, 0o644);

  const prev = process.cwd();
  try {
    process.chdir(dir);
    assert.notEqual(repairMain([]), 0);
    assert.notEqual(repairMain(["--file", filePath]), 0);
    assert.equal(
      repairMain(["--file", filePath, "--i-consent-rewrite-named-files"]),
      0
    );
  } finally {
    process.chdir(prev);
  }
  assert.equal(readFileSync(filePath).includes(0x0d), false);
});
