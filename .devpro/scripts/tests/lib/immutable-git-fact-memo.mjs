/**
 * immutable-git-fact-memo.mjs
 *
 * Test-only: answer a repeated `git` query from memory instead of a new child.
 *
 * The review-evidence suites call production operations in-process hundreds of
 * times per file, and every operation re-derives the same facts through fresh
 * `git` children (measured: ~26 spawns per operation, more than half of them
 * exact repeats within one repository). Process creation, not git's own work,
 * is what those suites spend their time on.
 *
 * Two classes of query are remembered, and only when they succeed:
 *
 *   immutable — repository invariants (common dir, object format) and
 *     object-store facts whose every revision argument is a full object id.
 *     Remembered for the life of the process. A fact a full object id fully
 *     determines (blob bytes, a --full-tree listing, a merge base, ancestry)
 *     is shared across fixture repositories: they are copies of one template,
 *     so each new copy would otherwise ask again for an answer already known.
 *     A repository that lacks the object would have failed live; a test that
 *     removes objects and expects that failure is the case the audit mode
 *     below exists to catch.
 *
 *   ref state — `rev-parse HEAD`, `show-ref --verify`, `worktree list`.
 *     Remembered only until this process starts ANY child that is not a
 *     known read-only git query: a writing git command, a CLI under test, a
 *     hook. Such a child may move a ref where this process cannot see it, so
 *     every ref-state answer is dropped, and nothing is remembered while an
 *     asynchronous child is still running.
 *
 * Index and working-tree queries (`status`, `diff` against the tree) always
 * run: a test changes those with plain file writes that nothing here observes.
 * For the same reason a test that edits `.git` by hand, or swaps directories
 * under a path it already queried, is outside what the ref-state rule can
 * see. That is what the audit mode is for: DEVPRO_TEST_GIT_FACT_MEMO=verify
 * runs every remembered query live as well and reports any answer that
 * differs. A new query shape, or a new kind of fixture mutation, MUST pass
 * that mode with zero stale facts across the whole family.
 *
 * A failing command is never remembered, so fault paths keep failing live.
 * Production code is untouched and CLI children are separate processes: the
 * memo lives in the importing test process only. Set
 * DEVPRO_TEST_GIT_FACT_MEMO=0 to run every query live.
 */

import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const OBJECT_ID_WITH_PATH = /^(?:[0-9a-f]{40}|[0-9a-f]{64}):.+$/u;
const REPOSITORY_INVARIANTS = new Set([
  "--git-common-dir",
  "--path-format=absolute\0--git-common-dir",
  "--show-object-format",
]);
// Positional revisions each object-store query must carry, all full ids.
const OBJECT_STORE_REVISIONS = new Map([
  ["merge-base", 2],
  ["diff", 2],
  ["ls-tree", 1],
]);
// Subcommands that never move a ref; running one keeps ref-state answers.
const READ_ONLY_SUBCOMMANDS = new Set([
  "rev-parse", "cat-file", "show", "ls-tree", "merge-base", "diff", "status",
  "show-ref", "log", "rev-list", "ls-files", "for-each-ref", "grep",
]);

function withoutWorkingDirectoryFlag(args) {
  return args[0] === "-C" && args.length > 2 ? args.slice(2) : args;
}

function positionalBeforeSeparator(args) {
  const separator = args.indexOf("--");
  const head = separator === -1 ? args : args.slice(0, separator);
  return head.filter((arg) => !arg.startsWith("-"));
}

function isStringList(args) {
  return Array.isArray(args) && args.every((arg) => typeof arg === "string");
}

export function isImmutableGitQuery(args) {
  if (!isStringList(args)) return false;
  const [subcommand, ...tail] = withoutWorkingDirectoryFlag(args);
  if (subcommand === "rev-parse") return REPOSITORY_INVARIANTS.has(tail.join("\0"));
  if (subcommand === "cat-file") {
    return tail.length === 2 && tail[0] === "blob" && FULL_OBJECT_ID.test(tail[1]);
  }
  if (subcommand === "show") return tail.length === 1 && OBJECT_ID_WITH_PATH.test(tail[0]);
  const revisions = OBJECT_STORE_REVISIONS.get(subcommand);
  if (revisions === undefined) return false;
  const positional = positionalBeforeSeparator(tail);
  return positional.length === revisions && positional.every((arg) => FULL_OBJECT_ID.test(arg));
}

// True when the answer depends on the object ids alone, not on which
// repository or directory asked. Path-limited queries qualify only when git
// resolves the path from the tree root regardless of the working directory.
export function isContentAddressedGitQuery(args) {
  if (!isImmutableGitQuery(args)) return false;
  const [subcommand, ...tail] = withoutWorkingDirectoryFlag(args);
  if (subcommand === "cat-file" || subcommand === "merge-base") return true;
  if (subcommand === "show") return !/^[0-9a-f]+:\.{1,2}\//u.test(tail[0]);
  if (subcommand === "ls-tree") return tail.includes("--full-tree");
  return false;
}

// Ancestry is asked for its exit status; the caller discards stdout.
function isExitStatusGitQuery(args) {
  return withoutWorkingDirectoryFlag(args)[0] === "merge-base" && args.includes("--is-ancestor");
}

export function isRefStateGitQuery(args) {
  if (!isStringList(args)) return false;
  const [subcommand, ...tail] = withoutWorkingDirectoryFlag(args);
  if (subcommand === "rev-parse") return tail.length === 1 && tail[0] === "HEAD";
  if (subcommand === "show-ref") {
    return tail.includes("--verify") && tail.at(-1).startsWith("refs/")
      && tail.slice(0, -1).every((arg) => arg.startsWith("--"));
  }
  if (subcommand === "worktree") {
    return tail[0] === "list" && tail.slice(1).every((arg) => arg.startsWith("-"));
  }
  return false;
}

export function isReadOnlyGitCommand(args) {
  if (!isStringList(args)) return false;
  const [subcommand, ...tail] = withoutWorkingDirectoryFlag(args);
  if (subcommand === "worktree") return tail[0] === "list";
  return READ_ONLY_SUBCOMMANDS.has(subcommand);
}

function memoKey(args, options) {
  // The answer depends on where git runs and on nothing else we allow through.
  if (options.env !== undefined || options.input !== undefined) return null;
  if (options.shell || options.uid !== undefined || options.gid !== undefined) return null;
  if (isContentAddressedGitQuery(args)) return `<object-store>\0${withoutWorkingDirectoryFlag(args).join("\0")}`;
  return `${options.cwd ?? process.cwd()}\0${args.join("\0")}`;
}

function decode(bytes, encoding) {
  return encoding && encoding !== "buffer" ? bytes.toString(encoding) : Buffer.from(bytes);
}

// What the live call hands back for stdout: null when it was not captured.
function stdoutFor(bytes, settings) {
  return capturesStdout(settings.stdio) ? decode(bytes, settings.encoding) : null;
}

function capturesStdout(stdio) {
  if (stdio === undefined || stdio === "pipe") return true;
  return Array.isArray(stdio) && (stdio[1] === undefined || stdio[1] === null || stdio[1] === "pipe");
}

function reportStaleFact(key, known, live) {
  const line = JSON.stringify({ key: key.split("\0"), known: known.toString("utf8"), live });
  process.stderr.write(`immutable-git-fact-memo: stale fact ${line}\n`);
  const log = process.env.DEVPRO_TEST_GIT_FACT_MEMO_VERIFY_LOG;
  if (log) appendFileSync(log, `${line}\n`);
}

let installed = null;

export function installImmutableGitFactMemo() {
  if (installed !== null) return installed;
  const stats = { hits: 0, misses: 0, refStateDrops: 0 };
  const mode = process.env.DEVPRO_TEST_GIT_FACT_MEMO;
  const verify = mode === "verify";
  installed = { stats, enabled: mode !== "0", verify };
  if (!installed.enabled) return installed;

  const immutableFacts = new Map();
  const refStateFacts = new Map();
  let runningChildren = 0;
  const dropRefState = () => {
    if (refStateFacts.size > 0) stats.refStateDrops += 1;
    refStateFacts.clear();
  };

  // Which store may answer this call, or null when it must run live.
  const storeFor = (file, args, settings) => {
    if (file !== "git" || typeof settings !== "object") return null;
    if (!capturesStdout(settings.stdio)) {
      return isStringList(args) && isExitStatusGitQuery(args) && isImmutableGitQuery(args) ? immutableFacts : null;
    }
    if (isImmutableGitQuery(args)) return immutableFacts;
    if (isRefStateGitQuery(args) && runningChildren === 0) return refStateFacts;
    return null;
  };
  const mayMoveRefs = (file, args) => !(file === "git" && isReadOnlyGitCommand(args));

  const liveExecFileSync = childProcess.execFileSync;
  const liveSpawnSync = childProcess.spawnSync;
  const liveExecSync = childProcess.execSync;

  childProcess.execFileSync = function execFileSyncWithGitFactMemo(file, args, options) {
    const settings = options ?? {};
    const store = storeFor(file, args, settings);
    const key = store === null ? null : memoKey(args, settings);
    if (key === null) {
      if (mayMoveRefs(file, args)) dropRefState();
      try {
        return liveExecFileSync.call(this, file, args, options);
      } finally {
        if (mayMoveRefs(file, args)) dropRefState();
      }
    }
    const known = store.get(key);
    if (known !== undefined) {
      stats.hits += 1;
      if (verify) {
        let live;
        try {
          live = liveExecFileSync.call(this, file, args, { ...settings, encoding: "buffer" });
        } catch (error) {
          reportStaleFact(key, known, `failed: ${error.message}`);
          throw error;
        }
        const liveBytes = Buffer.from(live ?? []);
        if (!known.equals(liveBytes)) reportStaleFact(key, known, liveBytes.toString("utf8"));
        return stdoutFor(liveBytes, settings);
      }
      return stdoutFor(known, settings);
    }
    // Capture raw bytes once so a later caller may ask for another encoding.
    const bytes = Buffer.from(liveExecFileSync.call(this, file, args, { ...settings, encoding: "buffer" }) ?? []);
    stats.misses += 1;
    store.set(key, bytes);
    return stdoutFor(bytes, settings);
  };

  childProcess.spawnSync = function spawnSyncWithGitFactMemo(file, args, options) {
    const settings = options ?? {};
    // spawnSync callers read the status themselves; only captured output is answered.
    const store = typeof settings === "object" && capturesStdout(settings.stdio) ? storeFor(file, args, settings) : null;
    const key = store === null ? null : memoKey(args, settings);
    if (key === null) {
      if (mayMoveRefs(file, args)) dropRefState();
      try {
        return liveSpawnSync.call(this, file, args, options);
      } finally {
        if (mayMoveRefs(file, args)) dropRefState();
      }
    }
    const known = store.get(key);
    if (known !== undefined && verify) {
      stats.hits += 1;
      const live = liveSpawnSync.call(this, file, args, options);
      const bytes = Buffer.isBuffer(live.stdout)
        ? live.stdout
        : Buffer.from(String(live.stdout ?? ""), settings.encoding ?? "utf8");
      if (live.error || live.status !== 0) reportStaleFact(key, known, `failed: status ${live.status}`);
      else if (!known.equals(bytes)) reportStaleFact(key, known, bytes.toString("utf8"));
      return live;
    }
    if (known !== undefined) {
      stats.hits += 1;
      const stdout = decode(known, settings.encoding);
      const stderr = decode(Buffer.alloc(0), settings.encoding);
      return { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: 0, signal: null };
    }
    const result = liveSpawnSync.call(this, file, args, { ...settings, encoding: "buffer" });
    const succeeded = !result.error && result.status === 0 && Buffer.isBuffer(result.stdout);
    if (succeeded) {
      stats.misses += 1;
      store.set(key, Buffer.from(result.stdout));
    }
    const convert = (value) => (Buffer.isBuffer(value) ? decode(value, settings.encoding) : value);
    const stdout = convert(result.stdout);
    const stderr = convert(result.stderr);
    return { ...result, stdout, stderr, output: [null, stdout, stderr] };
  };

  // A shell line is opaque: assume it can move a ref.
  childProcess.execSync = function execSyncDroppingRefState(...callArgs) {
    dropRefState();
    try {
      return liveExecSync.apply(this, callArgs);
    } finally {
      dropRefState();
    }
  };

  // Asynchronous children overlap with later queries: nothing about ref state
  // is remembered from the moment one starts until the last one has closed.
  for (const name of ["spawn", "exec", "execFile", "fork"]) {
    const live = childProcess[name];
    childProcess[name] = function asyncChildDroppingRefState(...callArgs) {
      dropRefState();
      const child = live.apply(this, callArgs);
      runningChildren += 1;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        runningChildren -= 1;
        dropRefState();
      };
      child.once("close", settle);
      child.once("error", () => { if (child.pid === undefined) settle(); });
      return child;
    };
    // util.promisify(exec|execFile) resolves through this hook, not the wrapper.
    const livePromisified = live[promisify.custom];
    if (livePromisified !== undefined) {
      Object.defineProperty(childProcess[name], promisify.custom, {
        value(...callArgs) {
          dropRefState();
          runningChildren += 1;
          const pending = livePromisified.apply(this, callArgs);
          const settle = () => {
            runningChildren -= 1;
            dropRefState();
          };
          pending.then(settle, settle);
          return pending;
        },
      });
    }
  }

  syncBuiltinESMExports();
  return installed;
}
