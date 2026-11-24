/**
 * git-utils.mjs
 *
 * SSOT for thin git (and generic shell) wrappers shared across hooks.
 * Centralises the repeated inline `shStr` / `shStrSafe` / `getCurrentBranch`
 * pattern so future hooks import rather than duplicate. Per
 * .devpro/agent-rules/code-simplification.md「Pre-Implementation Over-Design
 * Audit」— avoid copy-paste creep.
 *
 * Exports:
 *   - `runShell(cmd, opts)`   — generic shell exec, fail-open (returns "")
 *   - `runGit(args, opts)`    — git-prefixed shortcut over runShell
 *   - `getCurrentBranch(cwd)` — current work branch name
 *   - `getShortHead(cwd)`     — short HEAD SHA (git auto abbrev ≥ 7 chars)
 *   - `getHead(cwd)`          — full 40-char HEAD SHA
 *   - `resolveGithubOwnerRepo(cwd)` — `owner/repo` slug of `origin`
 *   - `resolveGithubRepoIdentity(cwd)` — `{host, slug}` of `origin` (host kept, #3332)
 *   - `readAgentsMdVersion(repoRoot)` — workspace AGENTS.md `版本：`
 *   - `resolveCanonicalAgentsMdRef(repoRoot)` — origin/HEAD|main|master tip ref
 *   - `readAgentsMdVersionAtRef(repoRoot, ref)` — `git show <ref>:AGENTS.md`
 *   - `readCanonicalAgentsMdVersion(repoRoot)` — tip-then-workspace (#2533)
 *   - `ensureGitHooksPath`    — clone-local core.hooksPath class ② helper
 *   - `ensureCoreSymlinks`    — clone-local core.symlinks class ② helper
 *   - `probeOsSymlinkCapability` — default OS symlink create probe
 *
 * All functions are fail-open: errors (no git repo, detached HEAD, etc.)
 * return "" rather than throwing, so callers never crash on edge cases.
 *
 * **Security note**：呼叫端**絕勿**將未信任 input（user-provided branch name /
 * file path / category ID 等）直接拼進 `cmd` / `args`。本 lib 不對命令做任何
 * escape／sanitization，直接交給 `execSync` shell。所有現行 caller 皆為
 * hardcoded literal 或來自 trusted 自家 git/gh 輸出 — 維護此契約。
 */

import { execSync, execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { mapMsysDrivePath } from "./hook-command-context.mjs";
import { extractVersionFromLine } from "./version-helpers.mjs";

/**
 * Run an arbitrary shell command and return stdout (trimmed). Fail-open: any
 * error returns "".
 *
 * @param {string} cmd  - Full shell command string (e.g. "gh repo view ...")
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeout] optional exec timeout in milliseconds
 */
export function runShell(cmd, { cwd = process.cwd(), timeout } = {}) {
  try {
    const opts = {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    };
    if (timeout != null) opts.timeout = timeout;
    return execSync(cmd, opts).trim();
  } catch {
    return "";
  }
}

/**
 * Run a git subcommand and return stdout (trimmed). Fail-open: any error
 * returns "".
 *
 * @param {string} args - Args string without the leading "git " prefix
 *                        (e.g. "branch --show-current")
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeout] optional exec timeout in milliseconds
 */
export function runGit(args, { cwd = process.cwd(), timeout } = {}) {
  return runShell(`git ${args}`, { cwd, timeout });
}

/**
 * Return the current work branch name. Returns "" when in detached HEAD state
 * or outside a git repo.
 *
 * @param {string} [cwd]
 */
export function getCurrentBranch(cwd) {
  return runGit("branch --show-current", { cwd, timeout: 2000 });
}

/**
 * Return the short HEAD SHA using git's own auto-abbrev algorithm (minimum 7
 * chars; automatically extended on large repos to avoid collisions). Replaces
 * the `rev-parse HEAD | slice(0, 7)` pattern used in earlier inline helpers —
 * that pattern always truncates to exactly 7 even when the repo requires more
 * chars for uniqueness.
 *
 * @param {string} [cwd]
 */
export function getShortHead(cwd) {
  return runGit("rev-parse --short HEAD", { cwd });
}

/**
 * Return the full 40-character HEAD SHA. Returns "" outside a git repo or on
 * any error.
 *
 * @param {string} [cwd]
 */
export function getHead(cwd) {
  return runGit("rev-parse HEAD", { cwd });
}

/**
 * Return the git toplevel of the CURRENT worktree containing `cwd` (i.e. the
 * working-tree root for that cwd). Returns "" outside a git repo or on any
 * error (fail-open).
 *
 * NOTE: this is the CURRENT worktree's top, which is SEMANTICALLY DIFFERENT from
 * resolveAbsoluteHooksPath()'s MAIN-worktree root (first `git worktree list`
 * entry). Do not conflate the two — a linked worktree's toplevel is its own
 * checkout, not the main repo.
 *
 * @param {string} [cwd]
 */
// Per-process memo. The toplevel for a given cwd is STRUCTURALLY invariant —
// only moving the checkout on disk could change it — and hooks are one-shot
// short-lived processes, so there is no staleness window. Callers ask
// repeatedly (spawn census: 874 `rev-parse --show-toplevel` across 252
// pre-tool-gate runs = 3.5x per process, identical answer each time) and each
// repeat costs a real fork+exec, which is ~93% of this suite's CPU. See
// test-performance-patterns.md (d).
const repoRootCache = new Map();
export function getRepoRoot(cwd) {
  const key = cwd ?? process.cwd();
  const cached = repoRootCache.get(key);
  if (cached !== undefined) return cached;
  const repoRoot = runGit("rev-parse --show-toplevel", { cwd });
  // Only memoize successes: "" is the fail-open value, and caching it would
  // turn one transient git failure into a process-wide one.
  if (repoRoot) repoRootCache.set(key, repoRoot);
  return repoRoot;
}

/**
 * resolveGithubOwnerRepo(cwd)
 *
 * Resolve `owner/repo` from `git remote get-url origin` for the repo containing
 * `cwd`. Supports https://github.com/o/r(.git)[/] and git@github.com:o/r(.git).
 * Fail-open: returns null when there is no origin or its URL is not a GitHub slug.
 *
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveGithubOwnerRepo(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!url) return null;
    const m =
      url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i) ||
      url.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
  } catch {
    return null;
  }
}

// The repository a checkout's origin names, read from the URL stored in that repository's own configuration
// (`git config --local --get-all`: no global, system or command-line value, so a checkout without an origin of its own
// binds nothing) and accepted only in a closed set of forms; the merge-destination gate binds evidence to a checkout
// with it. The stored URL binds only when it is the one URL git fetches and pushes origin with: a second stored value,
// a pushurl that differs from it, or an `insteadOf`/`pushInsteadOf` rewrite from any configuration scope binds nothing. `https://[user@]host[:port]/owner/repo[.git]` keeps its literal host (a non-default
// port stays as `host:port`); ssh binds only when its host is written `github.com` or `ssh.github.com`
// (`git@github.com:o/r`, `ssh://git@github.com[:port]/o/r`), both read as github.com, because any other ssh host may be
// an alias of the ssh configuration that this hook does not resolve. Every other form (plain http, file://, a local
// path, git://, another ssh host), a path outside a repository and a read failure return null: that checkout is
// evidence for no repository. { host, slug } are lower-case.
// The reads locate the repository from cwd alone: the variables of `git rev-parse --local-env-vars` that choose which
// repository, work tree, index, object store or configuration file git reads (GIT_REPOSITORY_LOCATING_ENV_VARS) are
// removed, so an inherited GIT_DIR cannot make another repository answer for this checkout. Configuration values from
// the environment (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/KEY_n/VALUE_n) stay, like global and system files, so a
// rewrite they carry still makes get-url differ and binds nothing. Values are compared byte for byte: an empty value,
// a second value or surrounding whitespace binds nothing.
export const GIT_REPOSITORY_LOCATING_ENV_VARS = Object.freeze([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_IMPLICIT_WORK_TREE", "GIT_PREFIX", "GIT_CONFIG", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
]);
// Windows environment names ignore case, so a copied environment can hold `Git_Dir` for GIT_DIR (PR #3703 r8 W1-F1).
const _locatingName = (key, platform = process.platform) =>
  GIT_REPOSITORY_LOCATING_ENV_VARS.find((name) => (platform === "win32" ? name === key.toUpperCase() : name === key));
// The first repository-locating variable the environment sets, even to an empty value (git reads an empty GIT_DIR too,
// PR #3703 r8 W1-F2), or null; on Windows a name in any case counts.
export function inheritedGitLocation(env = process.env, platform = process.platform) {
  for (const key of Object.keys(env)) {
    const name = _locatingName(key, platform);
    if (name && typeof env[key] === "string") return name;
  }
  return null;
}
function cwdLocatedGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (_locatingName(key)) delete env[key];
  return env;
}
export function storedOriginIdentity(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  const env = cwdLocatedGitEnv();
  // Each value ends with its terminator (NUL with -z, else a newline); the text after the last one must be empty.
  const values = (args, terminator) => {
    const read = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000, env });
    if (read.error || read.status !== 0) return null;
    const parts = read.stdout.split(terminator);
    return parts.pop() === "" ? parts : null;
  };
  const stored = values(["config", "--local", "--no-includes", "-z", "--get-all", "remote.origin.url"], "\0");
  if (stored?.length !== 1) return null;
  const [url] = stored;
  for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
    const used = values(args, "\n");
    if (used?.length !== 1 || used[0] !== url) return null;
  }
  const web = /^https:\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::(\d+))?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (web) {
    const port = web[2] && web[2] !== "443" ? `:${web[2]}` : "";
    return { host: `${web[1].toLowerCase()}${port}`, slug: `${web[3]}/${web[4]}`.toLowerCase() };
  }
  const ssh =
    /^ssh:\/\/(?:[^@/\s]+@)?((?:ssh\.)?github\.com)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url) ||
    /^(?:[^@/:\s]+@)?((?:ssh\.)?github\.com):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return ssh ? { host: "github.com", slug: `${ssh[2]}/${ssh[3]}`.toLowerCase() } : null;
}

// A repository argument for gh, `HOST/OWNER/REPO` or `OWNER/REPO`, as { host, slug } (host null when it is not
// written), or null for any other shape. A `gh api` call names the host with --hostname and the path with the slug.
export function splitRepoArg(value) {
  const m = /^(?:([^/\s]+)\/)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(typeof value === "string" ? value : "");
  return m ? { host: m[1] ? m[1].toLowerCase() : null, slug: m[2] } : null;
}

/**
 * resolveGithubRepoIdentity(cwd)
 *
 * Like resolveGithubOwnerRepo, but keeps the host: `{ host, slug }` (both lower-case) from
 * `git remote get-url origin`. Accepts `scheme://[user@]host[:port]/owner/repo(.git)` and the scp form
 * `[user@]host:owner/repo(.git)`; an http(s) port other than the default (443/80) stays in `host` as `host:port`,
 * an ssh/git transport port never does. Two repos with the same owner/repo on different hosts are different
 * repos, so a caller choosing a version authority MUST compare the host too (#3332).
 * Fail-open: null when there is no origin or it is not a two-segment `owner/repo` remote (e.g. a local path).
 *
 * @param {string} [cwd]
 * @returns {{host: string, slug: string}|null}
 */
export function resolveGithubRepoIdentity(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const web = url.match(
      /^(https?):\/\/(?:[^@/]+@)?([^/:@]+)(?::(\d+))?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
    );
    if (web) {
      // A non-default HTTP(S) port is part of the web host a `-R HOST:PORT/...` target names; the default port is not.
      const scheme = web[1].toLowerCase();
      const port = web[3] && web[3] !== (scheme === "https" ? "443" : "80") ? `:${web[3]}` : "";
      return { host: `${web[2].toLowerCase()}${port}`, slug: `${web[4]}/${web[5]}`.toLowerCase() };
    }
    // Other schemes (ssh://, git://) and the scp form: any port is transport, not the web host.
    const m =
      url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
      url.match(/^(?:[^@/:]+@)?([^/:@]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    return { host: m[1].toLowerCase(), slug: `${m[2]}/${m[3]}`.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * readAgentsMdVersion(repoRoot)
 *
 * Read AGENTS.md from `<repoRoot>/AGENTS.md` and extract the canonical
 * `版本：X.Y.Z` version string via `extractVersionFromLine`.
 *
 * Fail-safe (fail-open): returns null when:
 *   - `repoRoot` is empty / falsy
 *   - file does not exist or cannot be read
 *   - `extractVersionFromLine` returns null (no match / multi-match)
 *
 * I/O is intentionally placed in this file (not version-helpers.mjs) to keep
 * version-helpers leaf-pure (no file system calls).
 *
 * @param {string} repoRoot - absolute path to the repository root
 * @returns {string|null} the X.Y.Z version string, or null on any failure
 */
export function readAgentsMdVersion(repoRoot) {
  if (!repoRoot) return null;
  try {
    const content = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    return extractVersionFromLine(content);
  } catch {
    return null; // file not found, permission error, etc. — fail-open
  }
}

/**
 * resolveCanonicalAgentsMdRef(repoRoot)
 *
 * Pick the remote-tracking ref that represents the repo's canonical default
 * tip for generic footer version equality (#2533):
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` → e.g. `origin/main`
 *   2. else first existing of `origin/main`, `origin/master`
 * Returns null when none resolve (caller falls back to workspace AGENTS.md).
 *
 * Verification uses `rev-parse --verify --quiet <ref>` **without** `^{commit}`.
 * `runGit` is shell-backed (`execSync("git …")`); on Windows, Node's default
 * cmd.exe treats `^` as the escape character and strips it, turning
 * `origin/main^{commit}` into `origin/main{commit}` so every candidate fails
 * and the caller silently falls back to workspace (#2533 Windows case). Peel
 * syntax is unnecessary here — `git show <ref>:AGENTS.md` already fail-opens.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function resolveCanonicalAgentsMdRef(repoRoot) {
  if (!repoRoot) return null;
  const sym = runGit("symbolic-ref -q refs/remotes/origin/HEAD", {
    cwd: repoRoot,
    timeout: 2000,
  });
  if (sym.startsWith("refs/remotes/")) {
    const ref = sym.slice("refs/remotes/".length);
    if (/^[A-Za-z0-9._/-]+$/.test(ref)
      && runGit(`rev-parse --verify --quiet ${ref}`, { cwd: repoRoot, timeout: 2000 })) {
      return ref;
    }
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    if (runGit(`rev-parse --verify --quiet ${candidate}`, {
      cwd: repoRoot,
      timeout: 2000,
    })) {
      return candidate;
    }
  }
  return null;
}

/**
 * readAgentsMdVersionAtRef(repoRoot, ref)
 *
 * Read `AGENTS.md` via `git show <ref>:AGENTS.md` and extract `版本：X.Y.Z`.
 * Fail-open null on any error. `ref` MUST already be a trusted local resolver
 * output (see `resolveCanonicalAgentsMdRef`); rejects unsafe characters.
 *
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {string|null}
 */
export function readAgentsMdVersionAtRef(repoRoot, ref) {
  if (!repoRoot || !ref) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return null;
  const content = runGit(`show ${ref}:AGENTS.md`, { cwd: repoRoot, timeout: 2000 });
  if (!content) return null;
  return extractVersionFromLine(content);
}

/**
 * readCanonicalAgentsMdVersion(repoRoot)
 *
 * Generic-lane version source (#2533): prefer canonical remote-tip AGENTS.md,
 * then workspace AGENTS.md. Returns `{ version, anchor }` where `anchor` is
 * `ref:<name>`, `workspace`, or null when both fail (fail-open).
 *
 * @param {string} repoRoot
 * @returns {{ version: string|null, anchor: string|null }}
 */
export function readCanonicalAgentsMdVersion(repoRoot) {
  if (!repoRoot) return { version: null, anchor: null };
  const ref = resolveCanonicalAgentsMdRef(repoRoot);
  if (ref) {
    const fromRef = readAgentsMdVersionAtRef(repoRoot, ref);
    if (fromRef) return { version: fromRef, anchor: `ref:${ref}` };
  }
  const workspace = readAgentsMdVersion(repoRoot);
  if (workspace) return { version: workspace, anchor: "workspace" };
  return { version: null, anchor: null };
}

/**
 * Subpath (under the MAIN worktree root) where the git-native pre-push deletion
 * guard lives.
 */
export const HOOKS_GIT_SUBPATH = ".devpro/scripts/hooks-git";

/** Stable marker identifying a devpro-managed pre-push chain wrapper (D4). */
export const DELETION_GUARD_CHAIN_MARKER = "# devpro-pre-push-deletion-guard-chain";

/**
 * Durable association between a chain wrapper and its consumer backup basename
 * (sibling of discovery). Prevents refresh from guessing the wrong
 * `*.devpro-wrapped(.N)` after collision-safe allocate.
 */
export const CONSUMER_BACKUP_MARKER_PREFIX = "# consumer-backup: ";

/**
 * Resolve the MAIN worktree root for the repo containing `cwd`.
 * Fail-open: returns "" when unresolvable.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveMainWorktreeRoot(cwd) {
  const out = runShell("git worktree list --porcelain", { cwd });
  if (!out) return "";
  const firstLine = out.split("\n").find((l) => l.startsWith("worktree "));
  if (!firstLine) return "";
  return firstLine.slice("worktree ".length).trim();
}

/**
 * Resolve the ABSOLUTE core.hooksPath for the repo containing `cwd` — the MAIN
 * worktree's hooks-git dir.
 *
 * MUST be absolute, NOT relative: git resolves a relative core.hooksPath
 * against the CURRENT worktree's top dir, so from a linked worktree whose
 * checked-out branch lacks the hook file NO hook runs and the pre-push deletion
 * guard fails OPEN (the deletion succeeds silently). An absolute main-worktree
 * path resolves identically from every worktree regardless of which branch is
 * checked out. The first entry of `git worktree list --porcelain` is always the
 * main worktree.
 *
 * Used by ensureGitHooksPath() below. Fail-open: returns "" when the main
 * worktree can't be resolved (caller treats "" as "skip the config write").
 *
 * @param {string} [cwd] - a dir inside the repo (any worktree)
 * @returns {string} absolute hooks-git path, or "" if it can't be resolved
 */
export function resolveAbsoluteHooksPath(cwd) {
  const mainWorktreeRoot = resolveMainWorktreeRoot(cwd);
  if (!mainWorktreeRoot) return "";
  return path.join(mainWorktreeRoot, HOOKS_GIT_SUBPATH);
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function listWorktreeRoots(cwd) {
  const out = runShell("git worktree list --porcelain", { cwd });
  if (!out) return [];
  const roots = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const root = line.slice("worktree ".length).trim();
    if (root) roots.push(root);
  }
  return roots;
}

/**
 * Normalize Git-Bash / Windows drive path forms before host resolution.
 * On win32: `/c/repo` → `C:\repo`; `C:/repo` and `C:\repo` → `C:\repo`.
 * On darwin/linux: absolute POSIX `/<letter>/...` MUST stay unchanged — mapping
 * would turn a legitimate path into a non-absolute Windows drive string and
 * break ownership/chain resolution (F-fhpcc-r2-03). Pure transform for unit
 * locks without a win32 runner lives in `mapMsysDrivePath`.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeGitBashDrivePath(p) {
  if (typeof p !== "string" || p === "") return p;
  // Production caller gate: MSYS/`/c` remapping is win32-only.
  if (process.platform !== "win32") return p;
  const mapped = mapMsysDrivePath(p);
  if (mapped !== p) return mapped;
  const drive = /^([A-Za-z]):([\\/].*)?$/.exec(p);
  if (!drive) return p;
  const restRaw = drive[2] || path.win32.sep;
  const rest = restRaw.replace(/\//g, path.win32.sep);
  return `${drive[1].toUpperCase()}:${rest.startsWith("\\") ? rest : `\\${rest}`}`;
}

function isWindowsDriveAbs(p) {
  return typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Resolve a hooksPath config value to an absolute path (relative → current
 * worktree top, matching git's resolution for relative core.hooksPath).
 * Git-Bash POSIX drive forms are normalized before win32 absolute handling.
 */
function resolveHooksPathAbsolute(hooksPathValue, cwd) {
  const trimmed = String(hooksPathValue ?? "").trim();
  if (!trimmed) return "";
  const normalized = normalizeGitBashDrivePath(trimmed);
  if (isWindowsDriveAbs(normalized)) {
    return path.win32.normalize(normalized);
  }
  if (path.isAbsolute(normalized)) return normalized;
  const top = getRepoRoot(cwd) || cwd;
  return path.resolve(top, trimmed);
}

/**
 * Canonicalize an absolute path for ownership／equality compares.
 * realpath existing roots only (hooks-git dir itself may not exist yet).
 * Normalizes Git-Bash drive forms first so `/c/...` and `C:\...` compare equal.
 */
function canonicalizePath(absPath) {
  if (!absPath) return "";
  let candidate = normalizeGitBashDrivePath(absPath);
  if (isWindowsDriveAbs(candidate)) {
    candidate = path.win32.normalize(candidate);
  }
  try {
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = isWindowsDriveAbs(candidate)
      ? path.win32.dirname(candidate)
      : path.dirname(candidate);
    if (existsSync(parent)) {
      const base = isWindowsDriveAbs(candidate)
        ? path.win32.basename(candidate)
        : path.basename(candidate);
      return isWindowsDriveAbs(candidate)
        ? path.win32.join(realpathSync(parent), base)
        : path.join(realpathSync(parent), base);
    }
  } catch {
    // fall through
  }
  if (isWindowsDriveAbs(candidate)) return path.win32.normalize(candidate);
  return path.resolve(candidate);
}

function pathPrefixSep(a, b) {
  if (isWindowsDriveAbs(a) || isWindowsDriveAbs(b) || /\\/.test(a) || /\\/.test(b)) {
    return "\\";
  }
  return path.sep;
}

function isPathInsideClone(candidateAbs, cwd) {
  const resolved = canonicalizePath(candidateAbs);
  if (!resolved) return false;
  const roots = listWorktreeRoots(cwd);
  for (const root of roots) {
    const rootReal = canonicalizePath(root);
    if (!rootReal) continue;
    if (resolved === rootReal) return true;
    const sep = pathPrefixSep(resolved, rootReal);
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (resolved.startsWith(prefix)) return true;
  }
  return false;
}

function isHuskyShapedHooksPath(absoluteHooksPath) {
  const base = path.basename(absoluteHooksPath);
  const parent = path.basename(path.dirname(absoluteHooksPath));
  return base === "_" && parent === ".husky";
}

/**
 * D2 four-state classifier for core.hooksPath vs owned hooks-git footprint.
 * @returns {"unset"|"owned-absolute"|"owned-stale"|"foreign"}
 */
function classifyHooksPath(current, target, cwd) {
  const trimmed = String(current ?? "").trim();
  if (!trimmed) return "unset";
  if (trimmed === target) return "owned-absolute";
  if (trimmed === HOOKS_GIT_SUBPATH) return "owned-stale";

  const absCurrent = resolveHooksPathAbsolute(trimmed, cwd);
  const canonCurrent = canonicalizePath(absCurrent);
  const canonTarget = canonicalizePath(target);
  if (canonCurrent && canonTarget && canonCurrent === canonTarget) {
    // Non-canonical form of the same hooks-git footprint (e.g. relative with
    // extra ./, or /var vs /private/var after realpath of an existing parent).
    return trimmed === target ? "owned-absolute" : "owned-stale";
  }
  return "foreign";
}

function pathExistsNoFollow(absPath) {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

function isSymlinkNoFollow(absPath) {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve durable consumer backup path from an existing wrapper.
 * Prefers the embedded `# consumer-backup:` marker; never guesses "first
 * existing" `.devpro-wrapped` (collision-safe `.N` would be lost on refresh).
 */
function resolveConsumerBackupFromWrapper(wrapperContent, discoveryPath) {
  if (typeof wrapperContent !== "string" || !wrapperContent) return "";
  const dir = path.dirname(discoveryPath);
  for (const line of wrapperContent.split("\n")) {
    if (!line.startsWith(CONSUMER_BACKUP_MARKER_PREFIX)) continue;
    const base = line.slice(CONSUMER_BACKUP_MARKER_PREFIX.length).trim();
    // Basename only — reject path separators / traversal.
    if (!base || base !== path.basename(base) || base.includes("..")) continue;
    if (!base.includes(".devpro-wrapped")) continue;
    return path.join(dir, base);
  }
  // Legacy wrappers: extract quoted path that contains .devpro-wrapped.
  const re = /'([^']*\.devpro-wrapped[^']*)'/g;
  let match;
  while ((match = re.exec(wrapperContent)) !== null) {
    const quoted = match[1];
    if (!quoted || quoted.includes("..")) continue;
    const abs = path.isAbsolute(quoted) ? path.normalize(quoted) : path.resolve(dir, quoted);
    if (path.dirname(abs) === dir && path.basename(abs).includes(".devpro-wrapped")) {
      return abs;
    }
  }
  return "";
}

/**
 * Consumer sibling backup invocation relative to the wrapper script.
 * Absolute backup paths go stale after linked-worktree／checkout moves; marker
 * already stores basename — resolve via dirname "$0" at hook runtime.
 */
function consumerInvocationRef(consumerPath) {
  const base = path.basename(consumerPath);
  // Adjacent-quote concat: "$(dirname "$0")"/'basename'
  return `"$(dirname "$0")/"${shSingleQuote(base)}`;
}

function wrapperHasConsumerBackupMarker(wrapperContent) {
  if (typeof wrapperContent !== "string" || !wrapperContent) return false;
  return wrapperContent
    .split("\n")
    .some((line) => line.startsWith(CONSUMER_BACKUP_MARKER_PREFIX));
}

/** True when wrapper already uses $0-relative sibling backup (not absolute). */
function wrapperUsesRelativeConsumerInvocation(wrapperContent) {
  return (
    typeof wrapperContent === "string" &&
    wrapperContent.includes('dirname "$0"')
  );
}

function buildChainWrapper({ guardPath, consumerPath, huskyShaped }) {
  const g = shSingleQuote(guardPath);
  // Husky invokes user hooks via `sh -e`; use `cmd || exit $?` so set -e / if-!
  // does not clobber the real non-zero status from the guard or consumer.
  const lines = [
    "#!/bin/sh",
    DELETION_GUARD_CHAIN_MARKER,
  ];
  if (consumerPath) {
    lines.push(
      `${CONSUMER_BACKUP_MARKER_PREFIX}${path.basename(consumerPath)}`
    );
  }
  lines.push(
    "# Chains the devpro pre-push deletion guard, then optional consumer hook.",
    'STDIN_FILE=$(mktemp) || exit 1',
    'trap \'rm -f "$STDIN_FILE"\' EXIT HUP INT TERM',
    'cat > "$STDIN_FILE" || exit 1',
    `${g} "$@" < "$STDIN_FILE" || exit $?`
  );
  if (consumerPath) {
    const c = consumerInvocationRef(consumerPath);
    if (huskyShaped) {
      // Husky user hooks are often non-executable／shebangless; invoke via sh -e.
      lines.push(`[ ! -f ${c} ] || sh -e ${c} "$@" < "$STDIN_FILE" || exit $?`);
    } else {
      // Match git: ignore non-executable ordinary hooks (do not direct-exec → 126).
      lines.push(`[ ! -x ${c} ] || ${c} "$@" < "$STDIN_FILE" || exit $?`);
    }
  }
  lines.push("exit 0", "");
  return lines.join("\n");
}

/**
 * Collision-safe backup path using lstat (no-follow). existsSync follows
 * symlinks and can treat a dangling `*.devpro-wrapped` symlink as "free",
 * after which writeFileSync would write through outside the clone.
 */
function allocateBackupPath(discoveryPath) {
  const primary = `${discoveryPath}.devpro-wrapped`;
  if (!pathExistsNoFollow(primary)) return primary;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${discoveryPath}.devpro-wrapped.${i}`;
    if (!pathExistsNoFollow(candidate)) return candidate;
  }
  throw new Error("backup path collision");
}

/**
 * Staged validate/chmod + atomic rename publish. Never rename-away discovery
 * first; rename of temp onto discovery replaces a symlink inode without
 * write-through. Staging leftovers are removed on any chmod/validate/rename
 * failure (temp is gone after a successful rename).
 */
function atomicPublishDiscoveryDefault(discoveryPath, contents) {
  const dir = path.dirname(discoveryPath);
  const temp = path.join(
    dir,
    `.pre-push.devpro-staging.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );
  try {
    writeFileSync(temp, contents, { encoding: "utf8", mode: 0o755 });
    chmodSync(temp, 0o755);
    const written = readFileSync(temp, "utf8");
    if (!written.includes(DELETION_GUARD_CHAIN_MARKER)) {
      throw new Error("staged chain wrapper failed marker validation");
    }
    renameSync(temp, discoveryPath);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // best-effort — rename may have already consumed temp
    }
    throw err;
  }
}

/** Overridable publish impl — production default; tests may inject failure. */
let atomicPublishDiscoveryImpl = atomicPublishDiscoveryDefault;

function atomicPublishDiscovery(discoveryPath, contents) {
  return atomicPublishDiscoveryImpl(discoveryPath, contents);
}

/**
 * Narrow test seam for staged-publish failure injection (D4 / F-1-2).
 * Production callers MUST NOT use this.
 */
export const __testHooksPathInstall = Object.freeze({
  setAtomicPublishDiscovery(fn) {
    atomicPublishDiscoveryImpl =
      typeof fn === "function" ? fn : atomicPublishDiscoveryDefault;
  },
  reset() {
    atomicPublishDiscoveryImpl = atomicPublishDiscoveryDefault;
  },
});

/**
 * Preserve executable mode for ordinary-foreign backups (wrapper uses exec).
 * Symlink discovery: follow to the target's mode so +x is not forced to 0644.
 */
function resolveBackupMode(discoveryPath) {
  try {
    const lst = lstatSync(discoveryPath);
    if (lst.isSymbolicLink()) {
      try {
        const followed = statSync(discoveryPath);
        return followed.mode & 0o777 || 0o755;
      } catch {
        return 0o755;
      }
    }
    return lst.mode & 0o777 || 0o644;
  } catch {
    return 0o644;
  }
}

function copyDiscoveryToBackup(discoveryPath, backupPath, cwd) {
  // Read content (follows symlink for bytes) and write a new regular file —
  // never open/write the discovery path for mutation; never write through a
  // backup-path symlink (dangling or otherwise).
  if (isSymlinkNoFollow(backupPath)) {
    throw new Error("backup path is a symlink; refusing write-through");
  }
  if (pathExistsNoFollow(backupPath)) {
    throw new Error("backup path already occupied");
  }
  const backupDir = path.dirname(backupPath);
  if (!isPathInsideClone(backupDir, cwd)) {
    throw new Error("backup path outside clone ownership boundary");
  }

  const bytes = readFileSync(discoveryPath);
  const mode = resolveBackupMode(discoveryPath);

  // Write via temp + rename so we never open(backupPath) if a symlink appears
  // between allocate and write (TOCTOU); rename replaces a symlink inode
  // without following it, but we still refuse if lstat sees a symlink first.
  const temp = path.join(
    backupDir,
    `.pre-push.devpro-backup-staging.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );
  try {
    if (isSymlinkNoFollow(backupPath) || pathExistsNoFollow(backupPath)) {
      throw new Error("backup path became occupied before publish");
    }
    writeFileSync(temp, bytes, { mode });
    chmodSync(temp, mode);
    renameSync(temp, backupPath);
    // Final ownership／symlink gate: refuse leaving a symlink or out-of-clone file.
    if (isSymlinkNoFollow(backupPath)) {
      try {
        unlinkSync(backupPath);
      } catch {
        // best-effort
      }
      throw new Error("backup path resolved to symlink after publish");
    }
    if (!isPathInsideClone(backupPath, cwd)) {
      try {
        unlinkSync(backupPath);
      } catch {
        // best-effort
      }
      throw new Error("backup path outside clone after publish");
    }
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // best-effort
    }
    throw err;
  }
}

/** Inspect the most specific destination worktree index without resolving the hook entry. */
function discoveryTrackingState(discoveryPath, cwd) {
  const candidate = path.join(canonicalizePath(path.dirname(discoveryPath)), path.basename(discoveryPath));
  const owners = [...new Set(listWorktreeRoots(cwd).map(canonicalizePath))].filter((root) => {
    const relative = path.relative(root, candidate);
    return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  }).sort((left, right) => right.length - left.length);
  const owner = owners[0];
  if (!owner || owners[1]?.length === owner.length) return "unknown";
  const relative = path.relative(canonicalizePath(owner), candidate).split(path.sep).join("/");
  try {
    const entries = execFileSync("git", ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", relative], {
      cwd: owner, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (entries === "") return "untracked";
    return entries === `${relative}\0` ? "tracked" : "unknown";
  } catch { return "unknown"; }
}

function trackedHookDelegatesDeletionGuard(content, metadata, huskyShaped, cwd) {
  if (typeof content !== "string" || content.includes("\r") || !metadata?.isFile()) return false;
  // Git for Windows executes shell hooks without POSIX mode bits; Node's
  // native stat reports those files as 0666 even after chmod(0755).
  if (!huskyShaped && ((process.platform !== "win32" && !(metadata.mode & 0o111)) || !content.startsWith("#!/bin/sh\n"))) return false;
  const commands = content.split("\n").map((line) => line.replace(/^[ \t]+|[ \t]+$/gu, "")).filter((line) => line && !line.startsWith("#"));
  if (commands.length !== 1) return false;
  const match = /^exec (node )?(?:\.\/)?\.devpro\/scripts\/hooks-git\/(pre-push(?:\.mjs)?)(?: "\$@")?$/u.exec(commands[0]);
  if (!match || Boolean(match[1]) !== match[2].endsWith(".mjs")) return false;
  try {
    const root = getRepoRoot(cwd);
    if (!root) return false;
    const target = lstatSync(path.join(root, HOOKS_GIT_SUBPATH, match[2]));
    return target.isFile() && (Boolean(match[1]) || process.platform === "win32" || Boolean(target.mode & 0o111));
  } catch { return false; }
}

/**
 * Install／refresh deletion-guard chain at discoveryPath (D3–D4).
 * @returns {{ ok: true, changed: boolean, delegated?: boolean } | { ok: false, reason: "out-of-clone"|"unavailable"|"tracked-hook"|"tracked-legacy-wrapper"|"tracking-unavailable" }}
 */
function installDeletionGuardChain({ discoveryPath, guardPath, huskyShaped, cwd }) {
  const destDir = path.dirname(discoveryPath);
  if (!isPathInsideClone(destDir, cwd)) {
    return { ok: false, reason: "out-of-clone" };
  }
  if (!existsSync(destDir)) {
    return { ok: false, reason: "unavailable" };
  }

  // Split ENOENT absence from discovery-read failure: an existing but
  // unreadable entry MUST NOT be treated as absent (would replace without
  // backup while reporting repaired).
  let isSymlink = false;
  let existingContent = null;
  let discoveryStat = null;
  try {
    discoveryStat = lstatSync(discoveryPath);
    isSymlink = discoveryStat.isSymbolicLink();
  } catch (err) {
    if (err && err.code === "ENOENT") {
      discoveryStat = null;
      isSymlink = false;
    } else {
      return { ok: false, reason: "unavailable" };
    }
  }

  if (discoveryStat) {
    try {
      existingContent = readFileSync(discoveryPath, "utf8");
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  // An index entry is consumer-owned even when deleted from the worktree.
  // Inspection failure is never permission to publish a wrapper or backup.
  const hasMarker =
    typeof existingContent === "string" &&
    existingContent.includes(DELETION_GUARD_CHAIN_MARKER);
  const tracking = discoveryTrackingState(discoveryPath, cwd);
  if (tracking !== "untracked") {
    if (tracking === "tracked" && !isSymlink
      && trackedHookDelegatesDeletionGuard(existingContent, discoveryStat, huskyShaped, cwd)) {
      return { ok: true, changed: false, delegated: true };
    }
    if (tracking === "tracked") return { ok: false, reason: hasMarker ? "tracked-legacy-wrapper" : "tracked-hook" };
    return { ok: false, reason: "tracking-unavailable" };
  }

  // Validate against shell-quoted form — apostrophes in guardPath become '"'"'
  // and raw path is no longer a substring of the wrapper.
  const guardQuoted = shSingleQuote(guardPath);
  const guardEmbedded =
    hasMarker &&
    typeof existingContent === "string" &&
    existingContent.includes(guardQuoted);

  if (hasMarker && guardEmbedded && !isSymlink) {
    if (wrapperHasConsumerBackupMarker(existingContent)) {
      const backup = resolveConsumerBackupFromWrapper(
        existingContent,
        discoveryPath
      );
      if (!backup || !pathExistsNoFollow(backup)) {
        // Marker promises a sibling backup that is gone (e.g. after move) —
        // cannot silently skip; do not publish a dead consumer ref.
        return { ok: false, reason: "unavailable" };
      }
      if (!wrapperUsesRelativeConsumerInvocation(existingContent)) {
        // Legacy absolute consumer path — force refresh to $0-relative.
      } else {
        return { ok: true, changed: false };
      }
    } else {
      return { ok: true, changed: false };
    }
  }

  let consumerPath = "";
  if (hasMarker) {
    // Durable association from wrapper marker／quoted path — never "first existing".
    consumerPath = resolveConsumerBackupFromWrapper(existingContent, discoveryPath);
    if (wrapperHasConsumerBackupMarker(existingContent)) {
      if (!consumerPath || !pathExistsNoFollow(consumerPath)) {
        return { ok: false, reason: "unavailable" };
      }
    }
  } else if (existingContent != null) {
    // Existing consumer hook (or symlink to one) — copy-backup then wrap.
    try {
      consumerPath = allocateBackupPath(discoveryPath);
      copyDiscoveryToBackup(discoveryPath, consumerPath, cwd);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  const wrapper = buildChainWrapper({
    guardPath,
    consumerPath: consumerPath || "",
    huskyShaped,
  });
  if (!wrapper.includes(guardQuoted)) {
    return { ok: false, reason: "unavailable" };
  }

  try {
    atomicPublishDiscovery(discoveryPath, wrapper);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, changed: true };
}

function foreignChainOutcome(installResult) {
  if (!installResult.ok) {
    if (installResult.reason === "tracked-legacy-wrapper") {
      return {
        check: "hooks-path", execution: "checked", outcome: "risk",
        detail: "legacy wrapped tracked hook preserved; compare the intended hook, Git index and .devpro-wrapped backup, restore the intended tracked hook after preserving its logic, then remove obsolete backup; manually integrate exec node .devpro/scripts/hooks-git/pre-push.mjs \"$@\"; helper performs no restoration or cleanup",
      };
    }
    if (installResult.reason === "tracking-unavailable") {
      return {
        check: "hooks-path", execution: "checked", outcome: "risk",
        detail: "consumer hooksPath and unverified hook preserved; destination worktree Git index cannot be verified; check worktree ownership and index access, then retry before choosing manual delegation; no hook files changed",
      };
    }
    if (installResult.reason === "tracked-hook") {
      return {
        check: "hooks-path", execution: "checked", outcome: "risk",
        detail: "consumer hooksPath and tracked hook preserved; deletion guard delegation unproven; review or restore the intended hook if missing, then manually integrate exec node .devpro/scripts/hooks-git/pre-push.mjs \"$@\" using the repository-relative path; hooks retaining custom logic remain risk under the narrow static check",
      };
    }
    if (installResult.reason === "out-of-clone") {
      return {
        check: "hooks-path",
        execution: "checked",
        outcome: "risk",
        detail:
          "consumer hooksPath preserved; deletion guard chain unavailable (out-of-clone destination)",
      };
    }
    return {
      check: "hooks-path",
      execution: "checked",
      outcome: "risk",
      detail: "consumer hooksPath preserved; deletion guard chain unavailable",
    };
  }
  if (installResult.changed) {
    return {
      check: "hooks-path",
      execution: "checked",
      outcome: "repaired",
      detail: "preserved consumer hooksPath; installed deletion-guard chain",
    };
  }
  return {
    check: "hooks-path",
    execution: "checked",
    outcome: "compliant",
    detail: installResult.delegated
      ? "consumer hooksPath preserved; tracked hook delegates deletion guard"
      : "consumer hooksPath preserved; deletion guard chained",
  };
}

/**
 * Idempotently ensure the git-native pre-push deletion guard is reachable.
 *
 * D2 classifier:
 *   - unset／owned-stale → write absolute main-worktree hooks-git
 *   - owned-absolute → compliant no-op
 *   - foreign／husky → MUST NOT overwrite core.hooksPath; chain guard into the
 *     untracked consumer discovery path (D1／D3／D4) when destination ownership allows;
 *     tracked hooks are preserved, with proven delegation or explicit risk
 *
 * SSOT for both session-start.mjs (a silent SessionStart backstop) and the
 * devpro:change environment entry point (the primary per-user startup check).
 * Caller behavior is parameterized through `cwd` (default process.cwd()) and
 * `onConfigured` (called with the new target ONLY on an actual core.hooksPath
 * write). This helper NEVER writes to stdout itself.
 *
 * Fail-open: any error (not a git repo, unresolvable main worktree, read-only
 * config) is swallowed — callers must never crash on this.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - dir inside the repo to configure (default process.cwd())
 * @param {(target: string) => void} [opts.onConfigured] - notified on a config write
 */
export function ensureGitHooksPath({ cwd = process.cwd(), onConfigured } = {}) {
  try {
    const target = resolveAbsoluteHooksPath(cwd);
    if (!target) {
      return {
        check: "hooks-path",
        execution: "skipped",
        outcome: "risk",
        detail: "main worktree hooks path could not be resolved",
      };
    }
    let current;
    try {
      // execFileSync (argv form) — NO shell, so `target` (a filesystem path from
      // `git worktree list`, which may contain $()/backtick/space) is passed
      // literally and cannot be shell-interpolated. A string `execSync` with the
      // path inside double quotes would still expand $()/backtick inside the
      // quotes — a command-injection surface introduced by deriving the path
      // dynamically (the old code used a constant literal). Read is a constant
      // command but uses the same argv form for consistency.
      current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // exit non-zero means config key is unset — treat as empty
      current = "";
    }

    const state = classifyHooksPath(current, target, cwd);

    if (state === "owned-absolute") {
      return {
        check: "hooks-path",
        execution: "checked",
        outcome: "compliant",
        detail: "absolute main-worktree hooks path already configured",
      };
    }

    if (state === "unset" || state === "owned-stale") {
      execFileSync("git", ["config", "core.hooksPath", target], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      onConfigured?.(target);
      return {
        check: "hooks-path",
        execution: "checked",
        outcome: "repaired",
        detail: "configured absolute main-worktree hooks path",
      };
    }

    // foreign — preserve core.hooksPath; chain deletion guard when allowed.
    const absHooks = resolveHooksPathAbsolute(current, cwd);
    const huskyShaped = isHuskyShapedHooksPath(absHooks);
    const discoveryPath = huskyShaped
      ? path.join(path.dirname(absHooks), "pre-push")
      : path.join(absHooks, "pre-push");
    const guardPath = path.join(target, "pre-push");

    // Destination ownership gate (D2): foreign only. Out-of-clone → risk, no mutation.
    const destDir = path.dirname(discoveryPath);
    if (!isPathInsideClone(destDir, cwd)) {
      return foreignChainOutcome({ ok: false, reason: "out-of-clone" });
    }

    const installResult = installDeletionGuardChain({
      discoveryPath,
      guardPath: canonicalizePath(guardPath) || guardPath,
      huskyShaped,
      cwd,
    });
    return foreignChainOutcome(installResult);
  } catch {
    // Fail-open: non-git repo, git unavailable, read-only config, etc.
    return {
      check: "hooks-path",
      execution: "skipped",
      outcome: "risk",
      detail: "hooks path could not be inspected or configured",
    };
  }
}

/**
 * Probe the repository filesystem with the same relative directory symlink
 * kind used by skill discovery. Keep phase/code evidence, never raw errors.
 * Cleanup failure is not a successful capability proof.
 * @returns {{capable: boolean, phase: string, errorCode: string|null,
 *   cleanupErrorCode?: string, probeDirectory?: string}} Phase/code evidence;
 *   probeDirectory is only the run-owned basename when cleanup fails.
 */
export function probeOsSymlinkCapability({
  cwd = process.cwd(),
  createSymlink = symlinkSync,
  removeProbe = rmSync,
} = {}) {
  let dir;
  let phase = "prepare";
  let result;
  try {
    dir = mkdtempSync(path.join(cwd, ".devpro-symlink-probe-"));
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    mkdirSync(target);
    phase = "create";
    createSymlink("target", link, "dir");
    phase = "verify";
    if (!lstatSync(link).isSymbolicLink() || !statSync(link).isDirectory()
      || realpathSync(link) !== realpathSync(target)) {
      const error = new Error("Directory symlink verification failed");
      error.code = "EINVAL";
      throw error;
    }
    result = { capable: true, phase, errorCode: null };
  } catch (error) {
    const errorCode = /^E[A-Z0-9_]{1,31}$/.test(error?.code) ? error.code : "UNKNOWN";
    result = { capable: false, phase, errorCode };
  } finally {
    if (dir) {
      try {
        removeProbe(dir, { recursive: true, force: true });
      } catch (error) {
        const errorCode = /^E[A-Z0-9_]{1,31}$/.test(error?.code) ? error.code : "UNKNOWN";
        result = { ...result, capable: false, cleanupErrorCode: errorCode, probeDirectory: path.basename(dir) };
        if (result.errorCode === null) {
          result.phase = "cleanup";
          result.errorCode = errorCode;
        }
      }
    }
  }
  return result;
}

function defaultCoreSymlinksRunGit(args, { cwd } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Idempotently ensure clone-local `core.symlinks` is true when the OS can
 * create symlinks. Capability probe MUST run before any set-true.
 *
 * Fail-open: incapable hosts never write true; write/discovery failures return
 * risk and callers continue. Developer Mode (or equivalent) does not rewrite
 * an existing clone's core.symlinks by itself.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {(opts: {cwd: string}) => boolean|object} [opts.canCreateSymlink]
 * @param {(args: string[], opts?: { cwd?: string }) => string} [opts.runGit]
 */
export function ensureCoreSymlinks({
  cwd = process.cwd(),
  canCreateSymlink = probeOsSymlinkCapability,
  runGit = defaultCoreSymlinksRunGit,
} = {}) {
  try {
    let probe;
    let capable;
    try {
      probe = canCreateSymlink({ cwd });
      if (typeof probe !== "boolean" && typeof probe?.capable !== "boolean") {
        throw new Error("Malformed symlink capability evidence");
      }
      capable = probe === true || probe?.capable === true;
    } catch {
      return {
        check: "core-symlinks",
        execution: "skipped",
        outcome: "risk",
        detail: "core.symlinks discovery failed",
      };
    }

    if (!capable) {
      // Boolean injection remains compatible with existing helper callers;
      // the native probe always supplies structured phase/code evidence.
      let detail = "OS cannot create symlinks; Developer Mode does not rewrite an existing clone's core.symlinks; after enabling OS symlink capability, set core.symlinks true manually or re-run devpro:change, then --sync";
      if (typeof probe === "object") {
        const phase = ["prepare", "create", "verify", "cleanup"].includes(probe.phase) ? probe.phase : "unknown";
        const code = /^E[A-Z0-9_]{1,31}$/.test(probe.errorCode) ? probe.errorCode : "UNKNOWN";
        let action;
        if (phase === "prepare") {
          action = "Check repository existence and directory write/access permissions; this does not prove OS symlink capability is missing.";
        } else if (phase === "cleanup") {
          action = "Probe cleanup failed; inspect and remove only the named disposable probe directory before retrying.";
        } else if (phase === "create" && ["EPERM", "EACCES"].includes(code)) {
          action = "Check symbolic link privilege and directory permissions; on Windows check Developer Mode or the Create symbolic links privilege under your machine policy. Developer Mode does not rewrite an existing clone's core.symlinks.";
        } else if (phase === "create" && ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(code)) {
          action = "Check directory symlink support on the repository filesystem or share; use a supported filesystem and retry.";
        } else {
          action = "Inspect the repository filesystem/storage and directory symlink target; do not infer a missing Windows privilege from this error.";
        }
        detail = `Directory symlink probe failed (${phase}: ${code}). ${action} After fixing the cause, re-run devpro:change, then --sync to rebuild and verify the managed skill symlinks.`;
        if (probe.cleanupErrorCode) {
          detail += ` Cleanup failed; inspect leftover ${probe.probeDirectory} before retrying.`;
        }
      }
      return { check: "core-symlinks", execution: "checked", outcome: "risk", detail };
    }

    let current;
    try {
      current = runGit(["config", "--get", "core.symlinks"], { cwd });
    } catch (err) {
      const status = err?.status ?? err?.statusCode;
      if (status === 1) {
        current = "";
      } else {
        return {
          check: "core-symlinks",
          execution: "skipped",
          outcome: "risk",
          detail: "core.symlinks discovery failed",
        };
      }
    }

    if (String(current ?? "").trim().toLowerCase() === "true") {
      return {
        check: "core-symlinks",
        execution: "checked",
        outcome: "compliant",
        detail: "core.symlinks already true",
      };
    }

    try {
      runGit(["config", "core.symlinks", "true"], { cwd });
      return {
        check: "core-symlinks",
        execution: "checked",
        outcome: "repaired",
        detail: "set core.symlinks true",
      };
    } catch {
      return {
        check: "core-symlinks",
        execution: "checked",
        outcome: "risk",
        detail: "core.symlinks write failed",
      };
    }
  } catch {
    return {
      check: "core-symlinks",
      execution: "skipped",
      outcome: "risk",
      detail: "core.symlinks discovery failed",
    };
  }
}
