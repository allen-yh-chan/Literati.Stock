/**
 * Cross-platform durable-write filesystem helpers (R1).
 *
 * `fsyncDirectory()` is the single source of truth for fsyncing a directory
 * entry after a rename/link/mkdir/rmdir so the entry itself is durable, not
 * just the file content. Directory-handle fsync is a POSIX-only syscall
 * semantic — `openSync(directory, "r")` followed by `fsyncSync(fd)` throws on
 * win32, which has no equivalent API for making a directory entry durable.
 * See `openspec/changes/fix-windows-cross-review-dispatch/design.md` D1/D2.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Fsync a directory's entry so a preceding rename/link/mkdir/rmdir into (or
 * out of) it survives a crash. No-op on win32 (no equivalent API exists);
 * on every other platform this performs the exact
 * `openSync(directory, "r")` -> `fsyncSync(fd)` -> `finally closeSync(fd)`
 * sequence the three call sites this replaces used to carry privately, with
 * the same error propagation (nothing here is caught or swallowed).
 *
 * @param {string} directory
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {void}
 */
export function fsyncDirectory(directory, { platform = process.platform } = {}) {
  if (platform === "win32") return;
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Create-once durable file write shared by the spawn-context override claim
 * and the spawn admission record writer (strengthen-subagent-delegation-
 * strategy design D6 (2.6)): `wx` (fails on an existing path — never
 * read-modify-write), mode 0o600, then fsync the file content. Callers
 * fsync the parent directory entry themselves via `fsyncDirectory()`.
 * Nothing is caught here; an EEXIST/EACCES/ENOSPC propagates to the caller,
 * which must fail closed.
 *
 * @param {string} file
 * @param {string | Buffer} body
 * @returns {void}
 */
export function durableWrite(file, body) {
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const fd = openSync(file, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── D15 identifier validation + separated Create / Read path algorithms ──
// (strengthen-subagent-delegation-strategy design D15). Threat model is
// deliberately narrow: path traversal, mistaken symlinks, and a parent
// swapped between check and open (detected, then fail closed). It does NOT
// claim to stop a same-uid writer who can already edit the hook itself.

/** (A) `change_id` is a single lowercase path segment: no `.`, `/`, `\\`, NUL. */
export const CHANGE_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** (A) `record_id` / `override_id` MUST be UUID v4. */
export const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class DurablePathError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function isDurablePathError(error) {
  return error instanceof DurablePathError;
}

function fail(code) {
  throw new DurablePathError(code);
}

// Portability guard shared with validate-second-review-packet.mjs: win32 has
// no O_NOFOLLOW constant, so the flag degrades to 0 there.
//
// Risk class of that degradation (r14 review finding on the win32 carve-out):
// the flag is defence in depth here, not the only symlink check, so dropping it
// does not open a symlink-escape path. Parents are rejected by
// `verifyParentPath`, which lstats every segment on every platform. A symlinked
// target is rejected before the open on both paths — Create passes
// `O_CREAT|O_EXCL`, so an existing link is EEXIST, and Read lstats the target
// first and fails `target-not-regular-file`. What win32 loses is only the
// kernel's refusal during a TOCTOU swap between that lstat and the open, and
// the same-inode proof that follows (dev/ino/size against the pre-open lstat)
// still rejects the swap unless the substitute resolves to the inode that was
// already there. Closing the remaining window needs a win32 reparse-point
// probe, not a different open flag.
function noFollowFlag() {
  return Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
}

/**
 * (B) step 2 / (C) step 2: from `root` walk `parent` one segment at a time,
 * `lstat` every step (root included) rejecting symlinks and non-directories,
 * and return `realpath(parent)`, which MUST sit at or under `realpath(root)`.
 * The target is never touched here — on the Create path it does not exist yet.
 *
 * @param {string} root
 * @param {string} parent
 * @returns {string} realpath(parent)
 */
export function verifyParentPath(root, parent) {
  const rel = path.relative(root, parent);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) fail("parent-outside-root");
  const steps = [root];
  let current = root;
  for (const segment of rel === "" ? [] : rel.split(path.sep)) {
    current = path.join(current, segment);
    steps.push(current);
  }
  for (const step of steps) {
    const stat = lstatSync(step);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("parent-not-plain-directory");
  }
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(parent);
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) fail("parent-outside-root");
  return parentReal;
}

/**
 * (B) Create: exclusive, no-follow, durable creation of `target` inside an
 * already-verified `parent`. Sequence: verify parent (never the target) →
 * `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` → write body via fd →
 * fsync fd → same-inode proof (`fstat(fd)` vs `lstat(target)`, both regular
 * files) → recompute `realpath(parent)` → on any mismatch unlink the file
 * (only when the inode is provably ours) and throw → fsync parent entry.
 * `hooks.beforeOpen` exists for race tests; `hooks.fsyncFile` defaults to
 * `fsyncSync` and lets tests assert the fsync happened before return.
 * `hooks.closeFile` defaults to `closeSync` and is a test seam for late close
 * faults after a complete body write (survivors stay; callers decide scrub).
 *
 * @param {{ root: string, parent: string, target: string, body: string | Buffer,
 *   hooks?: { beforeOpen?: () => void, fsyncFile?: (fd: number) => void,
 *     closeFile?: (fd: number) => void } }} input
 * @returns {{ bytes: number }}
 */
export function createExclusiveDurableFile({ root, parent, target, body, hooks = {} }) {
  const { beforeOpen, fsyncFile = fsyncSync, closeFile = closeSync } = hooks;
  const parentReal = verifyParentPath(root, parent);
  if (path.dirname(target) !== parent) fail("target-not-in-parent");
  if (typeof beforeOpen === "function") beforeOpen();
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncFile(fd);
    const open = fstatSync(fd);
    let onDisk = null;
    try { onDisk = lstatSync(target); } catch { onDisk = null; }
    const sameInode = onDisk !== null && open.dev === onDisk.dev && open.ino === onDisk.ino;
    let parentNow = null;
    try { parentNow = realpathSync(parent); } catch { parentNow = null; }
    const proven = sameInode && open.isFile() && onDisk.isFile() && parentNow === parentReal;
    if (!proven) {
      // Same-inode-proof unlink-on-unproven only: do not scrub on write/fsync/
      // close/parent-fsync faults. Late survivors are the caller's scrub decision
      // (admission unlinks; raw capture must preserve partials).
      if (sameInode) { try { unlinkSync(target); } catch { /* fail closed below regardless */ } }
      fail("same-inode-proof-failed");
    }
  } finally {
    closeFile(fd);
  }
  fsyncDirectory(parent);
  return { bytes: bytes.length };
}

/**
 * Crash-consistent replacement of one regular file inside a verified plain
 * parent. The final target is never opened for write: bytes go to a fresh,
 * no-follow temp inode, then `rename` replaces the directory entry atomically.
 * Existing symlink/non-file targets are rejected before publication; a target
 * swapped after that check is replaced as an entry rather than followed.
 * Parent identity is checked before the temp open, immediately before rename,
 * and after publication. This is the overwrite counterpart to
 * `createExclusiveDurableFile` for single-writer evidence such as the
 * regression-head receipt.
 *
 * @param {{ root: string, parent: string, target: string, body: string | Buffer,
 *   hooks?: { beforeRename?: () => void, fsyncFile?: (fd: number) => void } }} input
 * @returns {{ bytes: number }}
 */
export function replaceDurableFile({ root, parent, target, body, hooks = {} }) {
  const { beforeRename, fsyncFile = fsyncSync } = hooks;
  const parentReal = verifyParentPath(root, parent);
  if (path.dirname(target) !== parent) fail("target-not-in-parent");
  try {
    const existing = lstatSync(target);
    if (!existing.isFile()) fail("target-not-regular-file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const candidate = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd;
  let candidateStat = null;
  let published = false;
  try {
    fd = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
    candidateStat = fstatSync(fd);
    const namedAtCreate = lstatSync(candidate);
    if (!candidateStat.isFile() || !namedAtCreate.isFile()
      || candidateStat.dev !== namedAtCreate.dev || candidateStat.ino !== namedAtCreate.ino) {
      fail("same-inode-proof-failed");
    }
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncFile(fd);
    const open = fstatSync(fd);
    const namedAfterWrite = lstatSync(candidate);
    if (!open.isFile() || !namedAfterWrite.isFile()
      || open.dev !== namedAfterWrite.dev || open.ino !== namedAfterWrite.ino
      || realpathSync(parent) !== parentReal) {
      fail("same-inode-proof-failed");
    }
    closeSync(fd);
    fd = undefined;

    if (typeof beforeRename === "function") beforeRename();
    if (verifyParentPath(root, parent) !== parentReal) fail("parent-identity-changed");
    try {
      const existing = lstatSync(target);
      if (!existing.isFile()) fail("target-not-regular-file");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    renameSync(candidate, target);
    published = true;

    const onDisk = lstatSync(target);
    if (!onDisk.isFile() || onDisk.dev !== candidateStat.dev || onDisk.ino !== candidateStat.ino
      || verifyParentPath(root, parent) !== parentReal) {
      fail("same-inode-proof-failed");
    }
    fsyncDirectory(parent);
    return { bytes: bytes.length };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    if (!published && candidateStat !== null) {
      try {
        const current = lstatSync(candidate);
        if (current.dev === candidateStat.dev && current.ino === candidateStat.ino) unlinkSync(candidate);
      } catch { /* fail closed at the original error; cleanup is best effort */ }
    }
  }
}

/**
 * (C) Read: no-follow read of `target` inside a verified `parent`. Sequence:
 * verify parent → `lstat(target)` must be a regular file (a symlink is not)
 * → `open(O_RDONLY|O_NOFOLLOW)` → same-inode proof (dev/ino/size) →
 * `realpath(target)` MUST be under `realpath(parent)` → read the whole body
 * through the fd → final fstat proves nothing changed while reading.
 *
 * @param {{ root: string, parent: string, target: string, maxBytes?: number, hooks?: {
 *   afterLstat?: (target: string) => void,
 *   openSync?: typeof openSync,
 *   readSync?: typeof readSync,
 * } }} input
 * @returns {{ bytes: Buffer, stat: import("node:fs").Stats }}
 */
export function readNoFollowFile({ root, parent, target, maxBytes = 1024 * 1024, hooks = {} }) {
  const parentReal = verifyParentPath(root, parent);
  if (path.dirname(target) !== parent) fail("target-not-in-parent");
  const pathStat = lstatSync(target);
  if (!pathStat.isFile()) fail("target-not-regular-file");
  if (typeof hooks.afterLstat === "function") hooks.afterLstat(target);
  const open = hooks.openSync ?? openSync;
  const read = hooks.readSync ?? readSync;
  const fd = open(target, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size !== pathStat.size) fail("same-inode-proof-failed");
    if (stat.size > maxBytes) fail("target-oversize");
    if (!realpathSync(target).startsWith(parentReal + path.sep)) fail("target-outside-parent");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = read(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const finalStat = fstatSync(fd);
    if (offset !== bytes.length || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalStat.size !== stat.size) fail("file-changed-while-reading");
    return { bytes, stat };
  } finally {
    closeSync(fd);
  }
}
