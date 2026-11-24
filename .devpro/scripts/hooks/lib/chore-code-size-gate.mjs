/**
 * chore-code-size-gate.mjs
 *
 * Pure-function core of the `chore-code-size-push` PreToolUse gate
 * (`pre-tool-gate.mjs`) and of the historical dry-run script. Counts the
 * non-test code lines a `chore/` branch adds and deletes against `origin/main`,
 * and holds the pure classifiers the gate needs (path judgments, `-z` numstat
 * and `git config --list -z` parsers, push-target / remote / chained-command
 * classification). Every function returns a RESULT VALUE.
 *
 * Contract (per `pre-tool-mechanical-gates` spec, "Chore Lane Non-Test Code
 * Size Push Gate" requirement): this module MUST be side-effect-free. No
 * process termination calls, no stdout/stderr printing, no file writes, no
 * network. The only child process is the local read-only `git`, always run with
 * `--no-optional-locks` (so `git diff` does not refresh the index) and
 * `--literal-pathspecs`; a git failure comes back as `{ ok: false, error }`,
 * never as a throw. Callers own the block / advisory decisions and the shell
 * parsing (push clause, chain prefix, per-occurrence cwd).
 *
 * Counting definition (design D2): range `<mergeBase>..HEAD`, numstat with
 * `-z -M`; a record's measured path is the new path (rename / copy) or the
 * deleted path; a record counts when its path has one of `CODE_FILE_EXTENSIONS`,
 * is not test code and is not under `openspec/changes/archive/`; each record
 * counts added + deleted, binary counts 0; a total strictly greater than
 * `CHORE_CODE_SIZE_LIMIT` is over the limit.
 *
 * Input shape of `classifyChain` (built by the caller from the text before the
 * push): an array with one entry per git command in the chain,
 * `{ verb, args, sameCwd }` where `args` are the tokens after the verb and
 * `sameCwd` says the command runs in the push worktree.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { CMD_POSITION_ANCHOR, GIT_GLOBAL_OPT } from "./shell-context.mjs";
import { parseGitNameStatusZ } from "../../lib/changed-file-status.mjs";

export const CHORE_CODE_SIZE_LIMIT = 100;

export const CODE_FILE_EXTENSIONS = Object.freeze([
  "mjs",
  "cjs",
  "js",
  "ts",
  "tsx",
  "jsx",
  "sh",
  "py",
  "ps1",
]);

// This gate's own closed set of "not checked" reasons (design D9). Deliberately
// NOT part of the shared NOT_CHECKED_REASONS taxonomy in pre-tool-gate.mjs.
export const CHORE_CODE_SIZE_NOT_CHECKED = Object.freeze({
  CWD_UNRESOLVED: "cwd-unresolved",
  PUSH_TARGET_UNPROVEN: "push-target-unproven",
  CHAINED_COMMAND_UNSUPPORTED: "chained-command-unsupported",
  AMEND_REWRITES_MERGE_BASE: "amend-rewrites-merge-base",
  BASE_UNRESOLVED: "base-unresolved",
  GIT_PROBE_FAILED: "git-probe-failed",
  GATE_ERROR: "gate-error",
});

export const CHORE_CODE_SIZE_NOT_CHECKED_REMEDY = Object.freeze({
  [CHORE_CODE_SIZE_NOT_CHECKED.CWD_UNRESOLVED]:
    "改寫成可靜態追蹤的 `cd <abs>`／`git -C <abs>` 形狀，或把 push 拆成獨立的 Bash 呼叫",
  [CHORE_CODE_SIZE_NOT_CHECKED.PUSH_TARGET_UNPROVEN]:
    "改用 `git push` 或 `git push <remote> <目前分支>` 的形狀，讓 gate 能證明 push 對象包含目前分支；或自行確認改動量",
  [CHORE_CODE_SIZE_NOT_CHECKED.CHAINED_COMMAND_UNSUPPORTED]:
    "把 push 前的 git 指令與 push 分成兩次 Bash 呼叫",
  [CHORE_CODE_SIZE_NOT_CHECKED.AMEND_REWRITES_MERGE_BASE]:
    "把 commit 與 push 分開執行，push 時才有精確數字",
  [CHORE_CODE_SIZE_NOT_CHECKED.BASE_UNRESOLVED]:
    "確認 `origin/main` 存在（必要時單獨執行 `git fetch origin`）後重試",
  [CHORE_CODE_SIZE_NOT_CHECKED.GIT_PROBE_FAILED]:
    "手動執行 `git diff --numstat -M origin/main...HEAD` 確認改動量",
  [CHORE_CODE_SIZE_NOT_CHECKED.GATE_ERROR]:
    "重跑一次；若持續發生請回報（gate 內部發生非預期例外，已 fail-open 不影響本次指令）",
});

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

function git(args, cwd) {
  return spawnSync("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
    encoding: "utf8",
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

// null when the git invocation succeeded, otherwise a message.
function gitFailure(result, label) {
  if (result.error) return result.error.message;
  if (result.status !== 0) {
    return (
      (result.stderr || "").trim() || `git ${label} exited ${result.status}`
    );
  }
  return null;
}

// ── path judgments (design D2) ──────────────────────────────────────────────

const CODE_EXTENSION_RE = new RegExp(`\\.(?:${CODE_FILE_EXTENSIONS.join("|")})$`);
const TEST_DIR_RE = /(^|\/)(tests|__tests__)\//;
const TEST_FILE_RE = /\.(test|spec)\.[^/]+$/;
const TEST_MANIFEST_RE = /(^|\/)test-suite-manifest\.mjs$/;
const ARCHIVE_PREFIX = "openspec/changes/archive/";

export function isTestCodePath(p) {
  return TEST_DIR_RE.test(p) || TEST_FILE_RE.test(p) || TEST_MANIFEST_RE.test(p);
}

export function isCountedCodePath(p) {
  return (
    CODE_EXTENSION_RE.test(p) &&
    !isTestCodePath(p) &&
    !p.startsWith(ARCHIVE_PREFIX)
  );
}

// ── numstat parsing ─────────────────────────────────────────────────────────

/**
 * Parse `git diff --numstat -z` output. A plain record is `a\tb\tpath\0`, a
 * rename / copy is `a\tb\t\0old\0new\0`, a binary file has `-\t-` counts.
 * Throws on a malformed record (the git-backed callers turn that into
 * `{ ok: false, error }`), so a parse problem never silently under-counts.
 *
 * @returns {{path: string, oldPath: string|null, added: number,
 *   deleted: number, binary: boolean, count: number}[]}
 */
export function parseNumstatZ(text) {
  const entries = [];
  let pos = 0;
  const nextToken = () => {
    const end = text.indexOf("\0", pos);
    const stop = end === -1 ? text.length : end;
    const token = text.slice(pos, stop);
    pos = end === -1 ? text.length : end + 1;
    return token;
  };
  while (pos < text.length) {
    const header = nextToken();
    const firstTab = header.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : header.indexOf("\t", firstTab + 1);
    if (secondTab === -1) {
      throw new Error(`malformed numstat record: ${JSON.stringify(header)}`);
    }
    const addedText = header.slice(0, firstTab);
    const deletedText = header.slice(firstTab + 1, secondTab);
    const rest = header.slice(secondTab + 1);
    const binary = addedText === "-" && deletedText === "-";
    if (!binary && !(/^\d+$/.test(addedText) && /^\d+$/.test(deletedText))) {
      throw new Error(`malformed numstat counts: ${JSON.stringify(header)}`);
    }
    const added = binary ? 0 : Number(addedText);
    const deleted = binary ? 0 : Number(deletedText);
    let oldPath = null;
    let entryPath = rest;
    if (rest === "") {
      oldPath = nextToken();
      entryPath = nextToken();
      if (oldPath === "" || entryPath === "") {
        throw new Error("malformed numstat rename record: missing path");
      }
    }
    entries.push({
      path: entryPath,
      oldPath,
      added,
      deleted,
      binary,
      count: added + deleted,
    });
  }
  return entries;
}

// ── git config parsing and effective remote (design D5) ─────────────────────

// `a.b.c.d` -> section `a` and variable `d` lowercased, subsection `b.c` kept.
function normalizeConfigKey(key) {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1 || first === last) return key.toLowerCase();
  return (
    key.slice(0, first).toLowerCase() +
    "." +
    key.slice(first + 1, last) +
    "." +
    key.slice(last + 1).toLowerCase()
  );
}

/**
 * Parse `git config --list -z` (`key\nvalue\0` records; a key without a value
 * has no newline).
 *
 * @returns {Map<string, string[]>} normalized key -> every value, in order.
 */
export function parseGitConfigListZ(text) {
  const config = new Map();
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    const rawKey = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
    const key = normalizeConfigKey(rawKey);
    const values = config.get(key);
    if (values) values.push(value);
    else config.set(key, [value]);
  }
  return config;
}

function lastConfigValue(config, key) {
  const values = config.get(key);
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

function isConfiguredRemote(config, name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    config.has(`remote.${name}.url`)
  );
}

/**
 * Pick the remote a push goes to: an explicit remote from the command wins;
 * otherwise `branch.<b>.pushremote`, `remote.pushdefault`, `branch.<b>.remote`,
 * then `origin`. The pick must be a configured remote name (`remote.<r>.url`
 * present and not `.`).
 *
 * @returns {{remote: string} | {remote: null, reason: string}}
 */
export function resolveEffectiveRemote({ explicitRemote, currentBranch, config }) {
  let selected = explicitRemote;
  if (selected === undefined || selected === null || selected === "") {
    selected =
      lastConfigValue(config, `branch.${currentBranch}.pushremote`) ??
      lastConfigValue(config, "remote.pushdefault") ??
      lastConfigValue(config, `branch.${currentBranch}.remote`) ??
      "origin";
  }
  if (selected === ".") return { remote: null, reason: "remote-is-local" };
  if (!isConfiguredRemote(config, selected)) {
    return { remote: null, reason: "remote-not-configured" };
  }
  return { remote: selected };
}

// ── push target classification (design D4 table) ────────────────────────────

const UNPROVEN_FLAG_RE =
  /^(?:--tags|--delete|-d|--all|--branches|--mirror|--prune|--repo(?:=.*)?|--exec(?:=.*)?|--receive-pack(?:=.*)?|--recurse-submodules(?:=.*)?)$/;
const NEUTRAL_FLAG_RE =
  /^(?:-u|--set-upstream|--follow-tags|--no-follow-tags|-f|--force|--force-with-lease(?:=.*)?|--force-if-includes|--no-force-if-includes|-q|--quiet|-v|--verbose|--progress|--no-progress|--verify|--no-verify|--atomic|--no-atomic|--thin|--no-thin|-4|-6|--ipv4|--ipv6|--porcelain|--signed(?:=.*)?|--no-signed|--push-option=.*)$/;
const SHELL_EXPANSION_RE = /[$`*?[]/;
const PUSH_DEFAULT_COUNTING = new Set(["simple", "current", "upstream"]);

const COUNTS = Object.freeze({ status: "counts" });
const unproven = (reason) => ({ status: "unproven", reason });

/**
 * Decide whether a `git push` demonstrably includes the current branch.
 *
 * @param {object} args
 * @param {string[]} args.tokens tokens after `push`, quotes already removed
 * @param {string} args.currentBranch full branch name
 * @param {Map<string, string[]>} args.config from `parseGitConfigListZ`
 * @returns {{status: "counts"} | {status: "unproven", reason: string}}
 */
export function classifyPushTarget({ tokens, currentBranch, config }) {
  if (tokens.some((t) => SHELL_EXPANSION_RE.test(t))) {
    return unproven("shell-expansion");
  }
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    if (token === "-o") {
      i += 1; // the push option's value is the next token
      continue;
    }
    if (UNPROVEN_FLAG_RE.test(token)) return unproven(`flag:${token}`);
    if (NEUTRAL_FLAG_RE.test(token)) continue;
    return unproven(`unknown-flag:${token}`);
  }

  if (positional.length >= 3) return unproven("multiple-refspecs");

  const explicitRemote = positional.length >= 1 ? positional[0] : undefined;
  const resolved = resolveEffectiveRemote({
    explicitRemote,
    currentBranch,
    config,
  });
  if (resolved.remote === null) return unproven(resolved.reason);

  if (positional.length === 2) {
    const ref = positional[1];
    if (ref === currentBranch || ref === "HEAD") return COUNTS;
    if (ref.includes(":") || ref.startsWith("+")) {
      return unproven("explicit-refspec");
    }
    return unproven("other-ref");
  }

  // Bare `git push` or `git push <remote>`: the remote's own push config and
  // push.default decide what is pushed.
  if (config.has(`remote.${resolved.remote}.push`)) {
    return unproven("remote-push-configured");
  }
  const pushDefault = lastConfigValue(config, "push.default");
  if (
    pushDefault !== undefined &&
    !PUSH_DEFAULT_COUNTING.has(pushDefault.toLowerCase())
  ) {
    return unproven(`push-default:${pushDefault}`);
  }
  return COUNTS;
}

// ── chained commands before the push (design D6, D4 step 3.5) ───────────────

const READ_ONLY_GIT_VERBS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);

/**
 * Does this chained git command leave HEAD, refs and the work tree alone?
 * `branch` only qualifies as `--show-current` (every other form creates, moves
 * or deletes a branch); `--output` lets diff / log / show write a file. `fetch`
 * is not read-only: it moves `origin/main`, the counting base. A shell
 * redirect is not looked at, the same as any non-git command in the chain.
 *
 * @param {{verb: string, args?: string[]}} command
 */
function isReadOnlyGitCommand({ verb, args = [] }) {
  if (verb === "branch") return args.length === 1 && args[0] === "--show-current";
  if (!READ_ONLY_GIT_VERBS.has(verb)) return false;
  return !args.some((arg) => arg === "--output" || arg.startsWith("--output="));
}

/**
 * Classify the git commands chained before a push.
 *
 * - read-only git commands (`isReadOnlyGitCommand`) are skipped, wherever they run
 * - no other git command, or only `add` -> `plain` (HEAD is unchanged by the push)
 * - any `commit` -> `chained-commit`; `includeUntracked` when any `add`;
 *   `amend` when a commit carries `--amend`
 * - any other verb (alias included), or an add / commit that runs outside the
 *   push worktree -> `unsupported`
 *
 * @param {{verb: string, args?: string[], sameCwd?: boolean}[]} prefixGitCommands
 * @returns {{mode: "plain"|"chained-commit"|"unsupported",
 *   includeUntracked: boolean, amend: boolean, reason?: string}}
 */
export function classifyChain(prefixGitCommands) {
  let hasAdd = false;
  let hasCommit = false;
  let amend = false;
  for (const command of prefixGitCommands) {
    if (isReadOnlyGitCommand(command)) continue;
    const { verb } = command;
    if (verb !== "add" && verb !== "commit") {
      return {
        mode: "unsupported",
        includeUntracked: false,
        amend: false,
        reason: `verb:${verb}`,
      };
    }
    if (command.sameCwd === false) {
      return {
        mode: "unsupported",
        includeUntracked: false,
        amend: false,
        reason: "cross-directory",
      };
    }
    if (verb === "add") hasAdd = true;
    else {
      hasCommit = true;
      if ((command.args || []).includes("--amend")) amend = true;
    }
  }
  if (!hasCommit) return { mode: "plain", includeUntracked: false, amend: false };
  return { mode: "chained-commit", includeUntracked: hasAdd, amend };
}

const BRANCH_SWITCH_RE = new RegExp(
  `${CMD_POSITION_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*(switch|checkout)(?=\\s|$)([^;&|\\n\\r]*)`,
  "g",
);
const CHECKOUT_CREATE_FLAGS = new Set(["-b", "-B", "--orphan", "--detach"]);

/**
 * Does the text before a push contain a branch switch? Pure text check.
 * Every `git switch` counts. `git checkout` counts when it creates / detaches
 * (`-b`, `-B`, `--orphan`, `--detach`) or names a positional (branch, `-`);
 * the path forms `git checkout -- <path>` and `git checkout <rev> -- <path>`
 * do not.
 */
export function hasBranchSwitchVerb(prefixText) {
  for (const match of prefixText.matchAll(BRANCH_SWITCH_RE)) {
    if (match[1] === "switch") return true;
    const tokens = match[2].split(/\s+/).filter(Boolean);
    if (tokens.some((t) => CHECKOUT_CREATE_FLAGS.has(t))) return true;
    if (tokens.includes("--")) continue;
    if (tokens.some((t) => t === "-" || !t.startsWith("-"))) return true;
  }
  return false;
}

// ── counting ────────────────────────────────────────────────────────────────

function countedEntries(numstatEntries) {
  return numstatEntries.filter(
    (e) => e.count > 0 && isCountedCodePath(e.path),
  );
}

function sumCounts(entries) {
  return entries.reduce((total, e) => total + e.count, 0);
}

function parseNumstatResult(result, label) {
  const failure = gitFailure(result, label);
  if (failure) return { ok: false, error: failure };
  try {
    return { ok: true, entries: parseNumstatZ(result.stdout) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Count the committed difference `<mergeBase>..HEAD`.
 *
 * `files` lists every measured path in the range (all file types, deletions
 * included) so the caller can run its proposal-path checks; `entries` and
 * `total` cover only counted code files.
 *
 * @returns {{ok: true, total: number, entries: object[], files: string[]}
 *   | {ok: false, error: string}}
 */
export function countCommitted({ repoRoot, mergeBase }) {
  const parsed = parseNumstatResult(
    git(["diff", "--numstat", "-z", "-M", mergeBase, "HEAD"], repoRoot),
    "diff --numstat",
  );
  if (!parsed.ok) return parsed;
  const entries = countedEntries(parsed.entries);
  return {
    ok: true,
    total: sumCounts(entries),
    entries,
    files: parsed.entries.map((e) => e.path),
  };
}

/**
 * Per-file change status of the committed difference `<mergeBase>..HEAD`
 * (`git diff --name-status -z -M`, the same rename detection as `countCommitted`).
 * The chore-A proposal check needs it to tell an in-place edit of another
 * change's proposal from an added / removed / renamed one (#3333).
 *
 * @returns {{ok: true, entries: {status: string, path: string, previousPath: string|null}[]}
 *   | {ok: false, error: string}}
 */
export function readCommittedStatuses({ repoRoot, mergeBase }) {
  const result = git(["diff", "--name-status", "-z", "-M", mergeBase, "HEAD"], repoRoot);
  const failure = gitFailure(result, "diff --name-status");
  if (failure) return { ok: false, error: failure };
  try {
    return { ok: true, entries: parseGitNameStatusZ(result.stdout) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Number of lines of a single file, the way git numstat counts an added file:
 * `\n` count, plus one when the file is non-empty and does not end in a
 * newline. Symlinks, non-regular files, binary files (a NUL in the first 8000
 * bytes), empty files and unreadable files are 0.
 */
export function countFileLines(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size === 0) return 0;
    const content = readFileSync(filePath);
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 0;
    let lines = 0;
    for (const byte of content) if (byte === 10) lines += 1;
    if (content[content.length - 1] !== 10) lines += 1;
    return lines;
  } catch {
    return 0;
  }
}

/**
 * Lines of the counted code files that are untracked and not ignored.
 *
 * @returns {{ok: true, lines: number, entries: object[]}
 *   | {ok: false, error: string}}
 */
export function countUntrackedCodeLines({ repoRoot }) {
  const listed = git(["ls-files", "-o", "--exclude-standard", "-z"], repoRoot);
  const failure = gitFailure(listed, "ls-files");
  if (failure) return { ok: false, error: failure };
  const entries = [];
  for (const file of listed.stdout.split("\0")) {
    if (file === "" || !isCountedCodePath(file)) continue;
    const lines = countFileLines(path.join(repoRoot, file));
    if (lines > 0) entries.push({ path: file, added: lines, deleted: 0, count: lines });
  }
  return { ok: true, lines: sumCounts(entries), entries };
}

/**
 * Estimate the line count of a chained `git commit` before it happens: per
 * counted code path the larger of (mergeBase vs work tree) and (mergeBase vs
 * index), plus untracked code files when the chain contains a `git add`.
 *
 * @returns {{ok: true, total: number, entries: object[], untrackedLines: number}
 *   | {ok: false, error: string}}
 */
export function estimateChained({ repoRoot, mergeBase, includeUntracked }) {
  const worktree = parseNumstatResult(
    git(["diff", "--numstat", "-z", "-M", mergeBase], repoRoot),
    "diff --numstat",
  );
  if (!worktree.ok) return worktree;
  const index = parseNumstatResult(
    git(["diff", "--cached", "--numstat", "-z", "-M", mergeBase], repoRoot),
    "diff --cached --numstat",
  );
  if (!index.ok) return index;

  const larger = new Map();
  for (const entry of [...countedEntries(worktree.entries), ...countedEntries(index.entries)]) {
    const seen = larger.get(entry.path);
    if (!seen || entry.count > seen.count) larger.set(entry.path, entry);
  }
  const entries = [...larger.values()];

  let untrackedLines = 0;
  if (includeUntracked) {
    const untracked = countUntrackedCodeLines({ repoRoot });
    if (!untracked.ok) return untracked;
    untrackedLines = untracked.lines;
    entries.push(...untracked.entries);
  }
  return { ok: true, total: sumCounts(entries), entries, untrackedLines };
}

/**
 * First `n` entries by count descending, then path ascending (code-point
 * order). Does not mutate the input.
 */
export function topFiles(entries, n = 5) {
  return [...entries]
    .sort((a, b) => {
      const byCount = (b.count ?? 0) - (a.count ?? 0);
      if (byCount !== 0) return byCount;
      if (a.path === b.path) return 0;
      return a.path < b.path ? -1 : 1;
    })
    .slice(0, n);
}

// ── git probes for the hook (design D3, D4 steps 6 and 9, D10) ──────────────

/**
 * Read `git config --list -z` (every config layer) in `cwd`.
 *
 * @returns {{ok: true, config: Map<string, string[]>} | {ok: false, error: string}}
 */
export function readGitConfigList({ cwd }) {
  const listed = git(["config", "--list", "-z"], cwd);
  const failure = gitFailure(listed, "config --list");
  if (failure) return { ok: false, error: failure };
  return { ok: true, config: parseGitConfigListZ(listed.stdout) };
}

/**
 * Merge-base of `origin/main` and HEAD. `reason` on failure separates a base
 * that cannot be resolved (`origin/main` missing, or no common ancestor) from
 * any other git failure.
 *
 * @returns {{ok: true, mergeBase: string}
 *   | {ok: false, reason: "base-unresolved"|"git-probe-failed", error: string}}
 */
export function resolveMergeBase({ repoRoot }) {
  const base = git(
    ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"],
    repoRoot,
  );
  if (base.error) {
    return { ok: false, reason: "git-probe-failed", error: base.error.message };
  }
  if (base.status !== 0) {
    return { ok: false, reason: "base-unresolved", error: "origin/main not found" };
  }
  const merged = git(["merge-base", "origin/main", "HEAD"], repoRoot);
  if (merged.error) {
    return { ok: false, reason: "git-probe-failed", error: merged.error.message };
  }
  if (merged.status === 1 && (merged.stdout || "").trim() === "") {
    return { ok: false, reason: "base-unresolved", error: "no merge-base" };
  }
  const failure = gitFailure(merged, "merge-base");
  if (failure) return { ok: false, reason: "git-probe-failed", error: failure };
  const mergeBase = merged.stdout.trim();
  if (mergeBase === "") {
    return { ok: false, reason: "base-unresolved", error: "no merge-base" };
  }
  return { ok: true, mergeBase };
}

/**
 * Full SHA of HEAD.
 *
 * @returns {{ok: true, sha: string} | {ok: false, error: string}}
 */
export function resolveHeadSha({ repoRoot }) {
  const head = git(["rev-parse", "HEAD"], repoRoot);
  const failure = gitFailure(head, "rev-parse HEAD");
  if (failure) return { ok: false, error: failure };
  const sha = head.stdout.trim();
  if (sha === "") return { ok: false, error: "empty HEAD sha" };
  return { ok: true, sha };
}

// Every path named by `git status --porcelain -z` output. A record is
// `XY path\0`; a rename / copy record is followed by its source path.
export function parseStatusPathsZ(text) {
  const found = new Set();
  const records = text.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    found.add(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2)) && i + 1 < records.length) {
      i += 1;
      found.add(records[i]);
    }
  }
  return found;
}

/**
 * Which of `paths` (committed paths) are equal to HEAD in both the index and
 * the work tree, i.e. have no `git status` entry (design D7). A path absent
 * from the status output is untouched; a deleted, modified or staged-changed
 * path shows up and is not returned.
 *
 * @returns {{ok: true, untouched: string[]} | {ok: false, error: string}}
 */
export function findUntouchedPaths({ repoRoot, paths }) {
  if (paths.length === 0) return { ok: true, untouched: [] };
  const status = git(["status", "--porcelain", "-z", "--", ...paths], repoRoot);
  const failure = gitFailure(status, "status");
  if (failure) return { ok: false, error: failure };
  const touched = parseStatusPathsZ(status.stdout);
  return { ok: true, untouched: paths.filter((p) => !touched.has(p)) };
}

/**
 * Short SHA and latest commit date of `origin/main`, plus the short SHA of the
 * merge-base, for the block message (block path only). A field is `null` when
 * its probe fails; the message degrades instead of failing.
 *
 * @returns {{originMainShort: string|null, originMainDate: string|null,
 *   mergeBaseShort: string|null}}
 */
export function describeCountingBase({ repoRoot, mergeBase }) {
  const log = git(
    ["log", "-1", "--date=short", "--format=%h%x09%cd", "origin/main"],
    repoRoot,
  );
  let originMainShort = null;
  let originMainDate = null;
  if (!gitFailure(log, "log")) {
    const [shortSha, date] = log.stdout.trim().split("\t");
    originMainShort = shortSha || null;
    originMainDate = date || null;
  }
  const short = git(["rev-parse", "--short", mergeBase], repoRoot);
  const mergeBaseShort = gitFailure(short, "rev-parse") ? null : short.stdout.trim() || null;
  return { originMainShort, originMainDate, mergeBaseShort };
}

/**
 * Does the remote-tracking ref `refs/remotes/<remote>/<branch>` exist locally?
 * (Used to tell an already-pushed branch from a first push; never fetches.)
 */
export function remoteTrackingRefExists({ repoRoot, remote, branch }) {
  const probed = git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
    repoRoot,
  );
  return !probed.error && probed.status === 0;
}
