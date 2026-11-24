#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultMainCheckoutRoot } from "./hooks/lib/repo-state-identity.mjs";
import {
  findSessionPendingShapeViolations,
  isPendingSectionHeading,
  parseBlocks,
} from "./lib/session-pending-blocks.mjs";

// One parser for the claim line, shared by claimedBy() and releaseItem(). Those
// two disagreeing is exactly the condition releaseItem's `removeAt < 0` branch
// fails closed on; a single source removes the possibility instead of only
// detecting it. No `g` flag, so the shared instance carries no lastIndex state.
const CLAIM_LINE = /^\s*(?:-\s*)?claimed:\s*(\S+)/;

const LOCK_RETRY_COUNT = positiveIntegerEnv("DEVPRO_SESSION_PENDING_CLAIM_LOCK_RETRY_COUNT", 100);
const LOCK_RETRY_MS = positiveIntegerEnv("DEVPRO_SESSION_PENDING_CLAIM_LOCK_RETRY_MS", 20);
const STALE_LOCK_MS = 10 * 60 * 1000;

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function usage() {
  return [
    "Usage:",
    "  node .devpro/scripts/session-pending-claim.mjs list [--json]",
    "  node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>",
    "  node .devpro/scripts/session-pending-claim.mjs release --item <N> --change <change-name>",
    "  node .devpro/scripts/session-pending-claim.mjs unclaim --item <N> --change <change-name>   (alias of release)",
    "  node .devpro/scripts/session-pending-claim.mjs check-shape [--json]",
    "",
    "release removes only the claim written by --change: releasing an unclaimed",
    "item is a no-op that exits 0, and releasing another change's claim exits 1",
    "without touching the file.",
    "",
    "check-shape is read-only: it takes no lock and never writes. It exits",
    "non-zero when the file has adopted the `## ` convention and still carries",
    "column-0 `- ` / `* ` bullets, and exits 0 for a legacy-only file.",
    "",
    "Exit codes: 0 success/no-op; 1 claim conflict or releasing another change's",
    "claim; 2 fail-closed (missing pending file, or release where claimedBy and",
    "the item's own line range disagree). Untyped thrown errors also exit 2.",
    "",
    "The helper always resolves <main-checkout-root>/notes/session-pending.md",
    "from git common-dir, so linked worktrees share the same pending file.",
  ].join("\n");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function readLockMetadata(lockPath, now = Date.now()) {
  let stat;
  let content;
  try {
    stat = statSync(lockPath);
    content = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {
      stat: null,
      pid: null,
      pidLive: null,
      timestampMs: NaN,
      ageMs: 0,
    };
  }

  const [pidLine, timestampLine] = content.split(/\r?\n/);
  const pid = Number(pidLine);
  const normalizedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
  const timestampMs = Date.parse(timestampLine);
  const ageMs = Number.isFinite(timestampMs) ? now - timestampMs : now - stat.mtimeMs;
  return {
    stat,
    pid: normalizedPid,
    pidLive: pidIsLive(normalizedPid),
    timestampMs,
    ageMs,
  };
}

function lockIsClearlyStale(metadata) {
  if (!metadata) return false;
  return metadata.pidLive === false && metadata.ageMs >= STALE_LOCK_MS;
}

function tryRemoveStaleLock(lockPath) {
  const guardPath = `${lockPath}.takeover`;
  let guardFd = null;
  try {
    guardFd = openSync(guardPath, "wx");
    writeFileSync(guardFd, `${process.pid}\n${new Date().toISOString()}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    if (error?.code === "ENOENT") return false;
    return false;
  }

  try {
    const metadata = readLockMetadata(lockPath);
    if (!lockIsClearlyStale(metadata) || !metadata.stat) return false;
    rmSync(lockPath, { force: true });
    return true;
  } finally {
    try {
      closeSync(guardFd);
    } finally {
      rmSync(guardPath, { force: true });
    }
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const opts = { command, json: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--item") {
      opts.item = Number(argv[++i]);
    } else if (arg === "--change") {
      opts.change = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function pathsFor(cwd = process.cwd()) {
  const root = defaultMainCheckoutRoot(cwd);
  const notesDir = path.join(root, "notes");
  const pendingPath = path.join(notesDir, "session-pending.md");
  const stateDir = path.join(notesDir, "tmp", "state");
  const lockPath = path.join(stateDir, "session-pending-claim.lock");
  return { root, notesDir, pendingPath, stateDir, lockPath };
}

function withLock(lockPath, fn) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (tryRemoveStaleLock(lockPath)) continue;
      sleep(LOCK_RETRY_MS);
    }
  }
  if (fd === null) {
    throw new Error(
      `could not acquire lock: ${lockPath}\n` +
        `Next steps:\n` +
        `  1. Wait briefly and retry: node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>\n` +
        `  2. If Gate SP / batch ledger is blocking non-OpenSpec writes: first write openspec/changes/<change>/ ` +
        `(meeting-notes / proposal / design), fix the ledger, then claim — OpenSpec-path writes remain allowed before claim.`
    );
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } finally {
      rmSync(lockPath, { force: true });
    }
  }
}

function claimedBy(blockLines) {
  for (const line of blockLines) {
    const match = line.match(CLAIM_LINE);
    if (match) return match[1];
  }
  return null;
}

function readPending(pendingPath) {
  if (!existsSync(pendingPath)) {
    throw new Error(`session-pending.md not found: ${pendingPath}`);
  }
  return readFileSync(pendingPath, "utf8");
}

function listItems(pendingPath) {
  const content = readPending(pendingPath);
  const { blocks } = parseBlocks(content);
  return blocks.map((block, index) => ({
    item: index + 1,
    title: block.lines[0],
    claimed: claimedBy(block.lines),
  }));
}

function writeAtomic(pendingPath, content) {
  const tmp = `${pendingPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, pendingPath);
}

function claimItem({ pendingPath, item, change }) {
  if (!Number.isInteger(item) || item < 1) {
    throw new Error("--item must be a positive integer");
  }
  if (!change || !/^[a-z0-9][a-z0-9-]*$/.test(change)) {
    throw new Error("--change must be a kebab-case change name");
  }

  const content = readPending(pendingPath);
  const { lines, blocks } = parseBlocks(content);
  const block = blocks[item - 1];
  if (!block) {
    throw new Error(`item ${item} not found`);
  }

  const existingClaim = claimedBy(block.lines);
  if (existingClaim && existingClaim !== change) {
    const error = new Error(`item ${item} already claimed: ${existingClaim}`);
    error.exitCode = 1;
    throw error;
  }
  if (existingClaim === change) {
    return { item, change, changed: false };
  }

  let insertAt = block.end;
  while (insertAt > block.start + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, `  - claimed: ${change}`);
  writeAtomic(pendingPath, lines.join("\n"));
  return { item, change, changed: true };
}

/**
 * Whole-file shape verdict. Read-only by construction: it takes no lock and
 * never writes, so it is safe to run at any time, including from inside an
 * editor loop that Gate NS has just blocked.
 */
function checkShape(pendingPath) {
  const content = readPending(pendingPath);
  const violations = findSessionPendingShapeViolations(content);
  const lines = content.split("\n");
  return {
    path: pendingPath,
    // The scope criterion has exactly one carrier: the same predicate
    // findSessionPendingShapeViolations uses. Restating it here would let the
    // out-of-scope message and the violation verdict drift apart.
    inScope: lines.some((line) => isPendingSectionHeading(line)),
    violations: violations.map((line) => ({ line, text: lines[line - 1] })),
  };
}

function printShape(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!result.inScope) {
    process.stdout.write(
      "check-shape: legacy-only file (no `## ` heading) — out of scope, nothing to report\n",
    );
    return;
  }
  if (result.violations.length === 0) {
    process.stdout.write("check-shape: no column-0 `- ` / `* ` bullets\n");
    return;
  }
  process.stdout.write(
    `check-shape: ${result.violations.length} column-0 bullet(s) in an H2-adopted file\n`,
  );
  for (const violation of result.violations) {
    process.stdout.write(`  ${violation.line}: ${violation.text}\n`);
  }
  process.stdout.write(
    "\nIndent evidence lines; promote real items to a `## ` heading.\n",
  );
}

/**
 * Remove the claim `claim` wrote. The inverse of claimItem in every direction
 * that matters: same argument validation, same `parseBlocks` boundaries (so
 * `--item N` addresses the block `list` printed as N), same lock, same atomic
 * write. Only the one `claimed:` line whose value equals `change` is removed,
 * so the block count and every item index survive and a claim/release pair
 * restores the file byte-for-byte.
 */
function releaseItem({ pendingPath, item, change }) {
  if (!Number.isInteger(item) || item < 1) {
    throw new Error("--item must be a positive integer");
  }
  if (!change || !/^[a-z0-9][a-z0-9-]*$/.test(change)) {
    throw new Error("--change must be a kebab-case change name");
  }

  const content = readPending(pendingPath);
  const { lines, blocks } = parseBlocks(content);
  const block = blocks[item - 1];
  if (!block) {
    throw new Error(`item ${item} not found`);
  }

  const existingClaim = claimedBy(block.lines);
  if (!existingClaim) {
    return { item, change, changed: false };
  }
  if (existingClaim !== change) {
    const error = new Error(
      `item ${item} is claimed by ${existingClaim}, not ${change}; refusing to release another change's claim`,
    );
    error.exitCode = 1;
    throw error;
  }

  // Remove exactly one claim line, and only from inside this block's own range,
  // so an identically worded line in a neighbouring block is never touched.
  let removeAt = -1;
  for (let i = block.start; i < block.end && i < lines.length; i++) {
    const match = lines[i].match(CLAIM_LINE);
    if (match && match[1] === change) {
      removeAt = i;
      break;
    }
  }
  if (removeAt < 0) {
    // claimedBy saw the claim but the block range does not contain it: the two
    // disagree, so fail closed rather than write a guess.
    const error = new Error(
      `item ${item}: claim line for ${change} not found inside the item's own line range`,
    );
    error.exitCode = 2;
    throw error;
  }

  lines.splice(removeAt, 1);
  writeAtomic(pendingPath, lines.join("\n"));
  return { item, change, changed: true };
}

function printList(items, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  for (const item of items) {
    const claim = item.claimed ? ` claimed:${item.claimed}` : "";
    process.stdout.write(`${item.item}. ${item.title}${claim}\n`);
  }
}

function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.command) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const paths = pathsFor();
  if (opts.command === "list") {
    printList(listItems(paths.pendingPath), opts.json);
    return 0;
  }

  if (opts.command === "check-shape") {
    const result = checkShape(paths.pendingPath);
    printShape(result, opts.json);
    return result.violations.length > 0 ? 1 : 0;
  }

  if (opts.command === "claim") {
    const result = withLock(paths.lockPath, () =>
      claimItem({
        pendingPath: paths.pendingPath,
        item: opts.item,
        change: opts.change,
      }),
    );
    const verb = result.changed ? "claimed" : "already claimed";
    process.stdout.write(`${verb} item ${result.item}: ${result.change}\n`);
    return 0;
  }

  // `unclaim` is an alias, not a second implementation: two implementations
  // would be free to drift, and the round-trip invariant has to hold for both.
  if (opts.command === "release" || opts.command === "unclaim") {
    const result = withLock(paths.lockPath, () =>
      releaseItem({
        pendingPath: paths.pendingPath,
        item: opts.item,
        change: opts.change,
      }),
    );
    const verb = result.changed ? "released" : "not claimed, no-op";
    process.stdout.write(`${verb} item ${result.item}: ${result.change}\n`);
    return 0;
  }

  throw new Error(`unknown command: ${opts.command}`);
}

try {
  process.exit(run());
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode || 2);
}
