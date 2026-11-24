#!/usr/bin/env node
/**
 * openspec-validate-delta.mjs
 *
 * Consumer-only OpenSpec validate delta gate (R2 / design.md D3-D7 of
 * fix-consumer-pre-pr-gates). Contract SSOT: `design.md` D3 (CLI, consumer-only
 * self-check, collection order), D4 (normalization / decision), D5 (transactional
 * attempt + publication, head-bound receipt, stale semantics), D6 (base snapshot
 * guards and cleanup), D7 (fail-closed code closed list).
 *
 * One question: in a consumer repository, does `openspec validate --strict
 * --specs` introduce NEW or CHANGED spec invalidity relative to
 * `git merge-base <base-ref> HEAD`? Inherited invalidity is recorded only; the
 * base side is validated from an immutable detached worktree snapshot, and the
 * resulting evidence is a HEAD-bound receipt that is only acceptable while
 * schema v2, the receipt HEAD matches the committed HEAD, the head worktree is
 * clean, and the durable invalidator marker is absent.
 *
 * Fail-closed discipline: every unusable state returns a code from the D7 closed
 * list, exits non-zero, and leaves no acceptable pass evidence. Invalidation
 * happens before any CLI/git collection (the commitment point); publication
 * first establishes the durable marker, writes the receipt last, verifies the
 * read-back, and only then removes the marker (publication commit).
 *
 * The exported runner/guard functions are the in-process seams the test matrix
 * uses for failure modes that cannot be injected through the CLI fixture;
 * there is deliberately no test-only environment bypass.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyRepoIdentity } from './lib/repo-identity.mjs';
import { createExclusiveDurableFile, fsyncDirectory, readNoFollowFile, replaceDurableFile, verifyParentPath } from './lib/durable-fs.mjs';
import { ensurePlainNotesRoot, isValidChangeName } from './lib/regression-head-record.mjs';
import { assertMainCheckoutRootWritable, defaultMainCheckoutRoot } from './hooks/lib/repo-state-identity.mjs';

export const SCHEMA_V2 = 'devpro-openspec-validate-delta/v2';
export const REVOKED_SCHEMA = 'devpro-openspec-validate-delta/revoked/v1';
export const VALIDATE_COMMAND = 'openspec validate --strict --specs --no-interactive --json';
export const USAGE = 'node .devpro/scripts/openspec-validate-delta.mjs --change <name> --base <base-ref>';

const VALIDATE_ARGS = ['validate', '--strict', '--specs', '--no-interactive', '--json'];
const SHA40_RE = /^[0-9a-f]{40}$/;
const SPEC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** One fixed placeholder for BOTH known roots (design D4): cross-side tokens
 * compare equal even though the base worktree and the head checkout differ. */
const NORMALIZED_ROOT_TOKEN = '<repo-root>';
const RECEIPT_MAX_BYTES = 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * win32 shell-backed openspec spawn guard (mirrors the established
 * `validate-openspec-change.mjs` precedent): on win32 the PATH-resolved
 * `openspec` is a `.cmd` shim that Node cannot spawn without a shell, so the
 * spawn MUST pass `shell: true`, and argv MUST stay inside a fixed literal
 * allowlist (no caller-controlled value ever reaches the CLI).
 */
const WIN32_SAFE_OPENSPEC_ARG_RE = /^(?:[a-z][a-z0-9-]*|--?[A-Za-z][A-Za-z0-9-]*)$/;

/** @param {readonly string[]} args @param {{ platform?: string }} [options] */
export function assertWin32OpenspecDeltaSpawnArgs(args, { platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: true };
  for (const arg of args) {
    if (!WIN32_SAFE_OPENSPEC_ARG_RE.test(arg)) {
      return { ok: false, reason: `openspec argv '${arg}' is not an allowlisted literal for win32 shell-backed spawn` };
    }
  }
  return { ok: true };
}

/** @param {{ cwd?: string, maxBuffer?: number, platform?: string }} [options] */
export function openspecDeltaSpawnOptions({ cwd, maxBuffer, platform = process.platform } = {}) {
  return {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(platform === 'win32' ? { shell: true } : {}),
  };
}

/**
 * win32 shell-backed spawn composes the command line by joining the file and
 * args WITHOUT quoting, so an absolute executable path containing spaces (a
 * user-profile npm prefix, `C:\\Program Files\\...`) would be split by cmd.exe
 * and the valid `openspec.cmd` would never run. Quote the command for the shell
 * form; the fixed literal argv stays unquoted.
 */
export function openspecDeltaSpawnTarget(executable, { platform = process.platform } = {}) {
  return platform === 'win32' ? `"${executable}"` : executable;
}

function errorMessage(error) {
  return error?.message || String(error);
}

function shapeViolation(side, reason) {
  return { ok: false, code: `unknown-item-shape:${side}`, reason };
}

// ── CLI (design D3) ─────────────────────────────────────────────────────────

/**
 * `<name> --base <base-ref>` only. Duplicate flags, unknown flags, missing
 * values, an invalid change name, an empty base ref, or a base ref that would
 * read as a flag are all `usage-error` (exit 1, before any collection).
 */
function parseDeltaArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  let change = null;
  let baseRef = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token !== '--change' && token !== '--base') {
      return { ok: false, reason: `unknown argument ${JSON.stringify(token)}` };
    }
    const alreadySeen = token === '--change' ? change : baseRef;
    if (alreadySeen !== null) return { ok: false, reason: `${token} was given more than once` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, reason: `${token} requires a value` };
    }
    index += 1;
    if (token === '--change') change = value;
    else baseRef = value;
  }
  if (change === null) return { ok: false, reason: '--change is required' };
  if (!isValidChangeName(change)) {
    return { ok: false, reason: `--change is not a valid change name: ${JSON.stringify(change)}` };
  }
  if (baseRef === null || baseRef === '') {
    return { ok: false, reason: '--base must be a non-empty git ref' };
  }
  if (baseRef.startsWith('-')) {
    return { ok: false, reason: `--base must not look like a flag: ${JSON.stringify(baseRef)}` };
  }
  return { ok: true, change, baseRef };
}

export function makeAttemptId({ now = new Date(), pid = process.pid, random = Math.random } = {}) {
  const compact = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${compact}-${pid}-${suffix}`;
}

// ── payload parsing and normalization (design D4) ───────────────────────────

/**
 * Validate the `openspec validate --json` stdout shape. Every item must be an
 * object with a recognized `type`; `spec` items must carry `id` (canonical
 * single path segment), boolean `valid`, and `issues[{level,path,message}]`.
 * Entries with a missing or unrecognized `type` are NOT skipped: an unrecognized
 * entry that carries a failed result must not disappear and let a pass receipt
 * be published, so they are `unknown-item-shape:<side>`. Anything else is
 * `unknown-item-shape:<side>`; non-JSON or a wrong top-level shape is
 * `unparseable-json:<side>`. The process exit code is NOT a decision input —
 * a red spec exits non-zero while still producing parseable JSON.
 */
export function parseValidatePayload(stdout, side) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ''));
  } catch {
    return { ok: false, code: `unparseable-json:${side}`, reason: 'stdout is not valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    return { ok: false, code: `unparseable-json:${side}`, reason: 'stdout is not a JSON object with an items array.' };
  }
  const specs = new Map();
  for (const item of parsed.items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return shapeViolation(side, 'items contains a non-object entry');
    }
    if (item.type !== 'spec') {
      // Fail closed: an item whose type is missing or unrecognized could carry a
      // failed result; skipping it would let that failure disappear and a pass
      // receipt be published (merge-gate review C4).
      return shapeViolation(side, `items contains an entry with a missing or unrecognized type: ${JSON.stringify(item.type)}`);
    }
    if (typeof item.id !== 'string' || !SPEC_ID_RE.test(item.id)) {
      return shapeViolation(side, `spec item id is not a canonical id: ${JSON.stringify(item.id)}`);
    }
    if (typeof item.valid !== 'boolean') {
      return shapeViolation(side, `spec item ${item.id} has no boolean valid flag`);
    }
    if (!Array.isArray(item.issues)) {
      return shapeViolation(side, `spec item ${item.id} issues is not an array`);
    }
    // Duplicate spec ids are a shape violation, not a last-write-wins map: a
    // later valid entry could otherwise hide an earlier invalid entry and turn
    // a red spec into a pass (merge-gate review C3).
    if (specs.has(item.id)) {
      return shapeViolation(side, `duplicate spec item id: ${item.id}`);
    }
    const issues = [];
    for (const entry of item.issues) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.level !== 'string' || typeof entry.path !== 'string' || typeof entry.message !== 'string') {
        return shapeViolation(side, `spec item ${item.id} has a malformed issue entry`);
      }
      issues.push({ level: entry.level, path: entry.path, message: entry.message });
    }
    specs.set(item.id, { valid: item.valid, issues });
  }
  return { ok: true, specs, summary: parsed.summary ?? null };
}

/**
 * Exit-status / payload / summary coherence (merge-gate review C11). The exit
 * code never drives the delta decision, but it must not contradict the payload:
 * a non-zero exit that reports no invalid spec (including an empty or all-valid
 * items array) is incoherent — a validator that failed for a reason the payload
 * does not represent must not reach decision=pass. Nonzero is allowed only for
 * a documented validation-invalid result fully represented by the payload, i.e.
 * at least one invalid spec. Summary counts are cross-checked when the validator
 * provides them.
 */
export function assessValidatorCoherence({ status, specs, summary, side }) {
  const invalidCount = [...specs.values()].filter((entry) => entry.valid !== true).length;
  const specCount = specs.size;
  const summarySpec = summary && typeof summary === 'object' && summary.byType && typeof summary.byType === 'object' && summary.byType.spec && typeof summary.byType.spec === 'object'
    ? summary.byType.spec
    : null;
  const summaryTotals = summary && typeof summary === 'object' && summary.totals && typeof summary.totals === 'object'
    ? summary.totals
    : null;
  if (summarySpec) {
    if (typeof summarySpec.items === 'number' && summarySpec.items !== specCount) {
      return { ok: false, code: `unknown-item-shape:${side}`, reason: `the validator summary reports ${summarySpec.items} spec items but the payload carries ${specCount}.` };
    }
    if (typeof summarySpec.failed === 'number' && summarySpec.failed !== invalidCount) {
      return { ok: false, code: `unknown-item-shape:${side}`, reason: `the validator summary reports ${summarySpec.failed} failed specs but the payload carries ${invalidCount}.` };
    }
  }
  if (summaryTotals && typeof summaryTotals.failed === 'number' && summaryTotals.failed !== invalidCount) {
    return { ok: false, code: `unknown-item-shape:${side}`, reason: `the validator summary reports ${summaryTotals.failed} failed items but the payload carries ${invalidCount} invalid specs.` };
  }
  const nonzero = typeof status === 'number' && status !== 0;
  if (nonzero && invalidCount === 0) {
    return { ok: false, code: `cli-exec-failed:${side}`, reason: `the validator exited with status ${status} but the payload reports no invalid spec (items=${specCount}); the exit status and payload are incoherent.` };
  }
  return { ok: true };
}

function normalizeMessage(message, roots) {
  let normalized = message;
  for (const root of roots) normalized = normalized.split(root).join(NORMALIZED_ROOT_TOKEN);
  return normalized;
}

function normalizationRoots(roots) {
  const expanded = new Set();
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue;
    expanded.add(root);
    try {
      expanded.add(realpathSync(root));
    } catch {
      /* literal root only */
    }
  }
  // Longest first so an enclosing path cannot shadow the specific root.
  return [...expanded].sort((left, right) => right.length - left.length);
}

/**
 * Per-id fingerprint: `valid` plus the SORTED issue token set, id-sorted.
 * Token = `level|path|norm(message)`; norm removes only the known roots.
 */
export function buildFingerprint(specs, roots) {
  const normalizedRoots = normalizationRoots(roots);
  return [...specs.entries()]
    .map(([id, spec]) => {
      const tokens = new Set();
      for (const issueEntry of spec.issues) {
        tokens.add(`${issueEntry.level}|${issueEntry.path}|${normalizeMessage(issueEntry.message, normalizedRoots)}`);
      }
      return { id, valid: spec.valid === true, tokens: [...tokens].sort() };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * `new_invalid = head_invalid − base_invalid`;
 * `changed_invalid = head_invalid ∩ base_invalid with head-only tokens`;
 * `resolved = base_invalid − head_invalid`; everything else is `inherited`.
 * `checked_specs` is the union of ids actually inspected on both sides, so the
 * output line can distinguish "checked and passed" from "not run".
 */
export function compareSpecResults({ base, head }) {
  const baseById = new Map(base.map((entry) => [entry.id, entry]));
  const headById = new Map(head.map((entry) => [entry.id, entry]));
  const baseInvalid = new Set(base.filter((entry) => entry.valid !== true).map((entry) => entry.id));
  const headInvalid = new Set(head.filter((entry) => entry.valid !== true).map((entry) => entry.id));

  const newInvalid = [...headInvalid].filter((id) => !baseInvalid.has(id)).sort();
  const resolved = [...baseInvalid].filter((id) => !headInvalid.has(id)).sort();
  const changedInvalid = [];
  const headNewTokens = {};
  let inherited = 0;
  for (const id of [...headInvalid].sort()) {
    if (!baseInvalid.has(id)) continue;
    const baseTokens = new Set(baseById.get(id).tokens);
    const added = headById.get(id).tokens.filter((token) => !baseTokens.has(token));
    if (added.length > 0) {
      changedInvalid.push(id);
      headNewTokens[id] = added;
    } else {
      inherited += 1;
    }
  }
  return {
    checkedSpecs: new Set([...baseById.keys(), ...headById.keys()]).size,
    inherited,
    newInvalid,
    changedInvalid,
    resolved,
    headNewTokens,
    decision: newInvalid.length + changedInvalid.length === 0 ? 'pass' : 'block',
  };
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function invalidEntries(fingerprint) {
  return fingerprint
    .filter((entry) => entry.valid !== true)
    .map((entry) => ({
      id: entry.id,
      path: `openspec/specs/${entry.id}/spec.md`,
      issue_tokens: entry.tokens,
    }));
}

function snapshotChecks(state) {
  return {
    head_matches_base_sha: state.head_matches_base_sha,
    porcelain_empty_tracked_staged_untracked: state.porcelain_empty_tracked_staged_untracked,
    ignored_empty: state.ignored_empty,
  };
}

// ── attempt-scoped logs (design D3 step 10) ─────────────────────────────────

/**
 * Log framing: stdout bytes, plus `\n[stderr]\n` and stderr bytes only when
 * stderr is non-empty. The digest is over these exact bytes.
 */
export function buildAttemptLogBytes({ stdout, stderr }) {
  const stdoutBytes = Buffer.from(String(stdout ?? ''), 'utf8');
  const stderrBytes = Buffer.from(String(stderr ?? ''), 'utf8');
  if (stderrBytes.length === 0) return stdoutBytes;
  return Buffer.concat([stdoutBytes, Buffer.from('\n[stderr]\n', 'utf8'), stderrBytes]);
}

export function writeAttemptLog({ root, attemptDir, side, stdout, stderr }) {
  const body = buildAttemptLogBytes({ stdout, stderr });
  const target = path.join(attemptDir, `${side}.log`);
  // No-follow, exclusive log creation inside a verified plain parent: a
  // symlinked ancestor (rejected by verifyParentPath) or a symlinked leaf
  // (EEXIST under O_EXCL) can never redirect validator output outside the
  // repository (merge-gate review C10).
  createExclusiveDurableFile({ root, parent: attemptDir, target, body });
  return { path: target, digest: sha256Hex(body) };
}

/**
 * Create `dir` (and any missing ancestors) under `root` one segment at a time,
 * rejecting a symlink or non-directory segment instead of following it, and
 * return the verified realpath. `mkdir -p` semantics otherwise let an ignored
 * or committed symlink redirect later writes outside the repository
 * (merge-gate review C10).
 */
export function ensurePlainDirectoryChain({ root, dir }) {
  const rel = path.relative(root, dir);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`directory ${dir} is outside ${root}`);
  }
  let current = root;
  for (const segment of rel === '' ? [] : rel.split(path.sep)) {
    current = path.join(current, segment);
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (stat === null) {
      mkdirSync(current, 0o700);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${current} is not a plain in-root directory`);
    }
  }
  return verifyParentPath(root, dir);
}

// ── executable / version / git / snapshot helpers (design D3, D6) ───────────

export function resolveExecutableOnPath({ name = 'openspec', env = process.env, platform = process.platform } = {}) {
  const rawPath = env.PATH ?? env.Path ?? '';
  if (rawPath === '') return null;
  const extensions = platform === 'win32'
    ? String(env.PATHEXT ?? env.PathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((extension) => extension !== '')
    : [''];
  for (const directory of String(rawPath).split(path.delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        // Pin the selected executable to an absolute target: a relative PATH
        // entry would otherwise resolve under each spawn's own cwd, so the
        // base and head runs could execute different validators while one
        // executable/version is recorded (merge-gate review C12).
        return path.resolve(candidate);
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

function parseOpenSpecVersion(stdout) {
  const match = String(stdout ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match[0] : null;
}

function runGitVia(io, target, args) {
  const result = io.spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' });
  if (result.error) {
    return { ok: false, status: null, stdout: '', stderr: '', reason: result.error.message };
  }
  return {
    ok: true,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    reason: null,
  };
}

/** Real head probe used by the pre-guard, both head-run brackets, the final
 * guards and the post-publication guard (design D5/D6). */
/**
 * Parse `git status --porcelain -z` into one array of participating paths per
 * record. A rename/copy record participates in BOTH the source and the
 * destination; taking only the destination would let a staged rename from a
 * non-gate-owned tracked path into a gate-owned path read as clean and validate
 * a tree different from committed HEAD (merge-gate review C13). -z is used so
 * paths are unquoted and lossless.
 */
function porcelainRecords(stdout) {
  const tokens = String(stdout ?? '').split('\0');
  const records = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '') continue;
    const xy = token.slice(0, 2);
    const first = token.length > 3 ? token.slice(3) : token;
    if (xy.includes('R') || xy.includes('C')) {
      const second = tokens[i + 1] ?? '';
      i += 1;
      records.push([first, second]);
    } else {
      records.push([first]);
    }
  }
  return records;
}

function probeHeadState({ cwd, ignorePaths = [] }) {
  const shaProbe = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (shaProbe.error) {
    return { ok: false, sha: null, clean: null, reason: `git rev-parse HEAD failed: ${shaProbe.error.message}` };
  }
  const sha = shaProbe.status === 0 ? String(shaProbe.stdout).trim() : '';
  if (!SHA40_RE.test(sha)) {
    return { ok: false, sha: sha || null, clean: null, reason: 'git rev-parse HEAD did not return a 40-hex commit' };
  }
  const statusProbe = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8' });
  if (statusProbe.error || statusProbe.status !== 0) {
    return { ok: false, sha, clean: null, reason: 'git status --porcelain -z --untracked-files=all failed' };
  }
  // Gate-owned artifacts are written under notes/ before the cleanliness check;
  // a consumer repository that does not ignore notes/ must not be rejected
  // because this gate dirtied its own worktree. Only the exact gate-owned paths
  // (receipt, invalidator marker, this change's attempt dir) are excluded, and a
  // rename/copy entry is excluded only when EVERY participating path is
  // gate-owned — any other change is still reported dirty (merge-gate review
  // WARN + C13).
  const prefixes = ignorePaths
    .map((target) => path.relative(cwd, target).split(path.sep).join('/'))
    .filter((rel) => rel !== '' && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel));
  const isGateOwned = (entry) => prefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`));
  const dirty = porcelainRecords(statusProbe.stdout).some((paths) => !paths.every((entry) => isGateOwned(entry)));
  return { ok: true, sha, clean: !dirty, reason: null };
}

/**
 * Base snapshot pre/post check (design D6): HEAD is exactly `baseSha`, and
 * `status --porcelain --untracked-files=all --ignored` shows no tracked/staged/
 * untracked AND no ignored entry. The single status output is split on the
 * `!!` ignored marker so the receipt keeps both booleans (diagnosis precision).
 */
export function evaluateBaseSnapshotState({ runGit, baseWt, baseSha }) {
  const head = runGit(baseWt, ['rev-parse', 'HEAD']);
  const status = runGit(baseWt, ['status', '--porcelain', '--untracked-files=all', '--ignored']);
  const lines = status.ok && status.status === 0 ? String(status.stdout).split('\n').filter((line) => line !== '') : null;
  const headMatches = head.ok && head.status === 0 && String(head.stdout).trim() === baseSha;
  const trackedClean = lines !== null && !lines.some((line) => !line.startsWith('!!'));
  const ignoredClean = lines !== null && !lines.some((line) => line.startsWith('!!'));
  return {
    head_matches_base_sha: headMatches,
    porcelain_empty_tracked_staged_untracked: trackedClean,
    ignored_empty: ignoredClean,
    ok: headMatches && trackedClean && ignoredClean,
  };
}

function chmodRecursiveRemoveWrite(target) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(target, stat.mode & ~0o222);
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      chmodRecursiveRemoveWrite(path.join(target, entry.name));
    }
    return;
  }
  if (stat.isFile()) chmodSync(target, stat.mode & ~0o222);
}

function chmodRecursiveAddWrite(target) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(target, stat.mode | 0o200);
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      chmodRecursiveAddWrite(path.join(target, entry.name));
    }
    return;
  }
  if (stat.isFile()) chmodSync(target, stat.mode | 0o200);
}

/**
 * Defense-in-depth only (design D6): the detection checks above stay
 * authoritative; the chmod result is recorded as `snapshot_mode`.
 */
export function applySnapshotReadOnly({ baseWt, platform = process.platform, chmodRemoveWrite = chmodRecursiveRemoveWrite }) {
  if (platform === 'win32') {
    return { snapshotMode: 'detection-only', reason: 'win32 has no POSIX read-only directory semantics' };
  }
  try {
    chmodRemoveWrite(baseWt);
    return { snapshotMode: 'posix-read-only', reason: null };
  } catch (error) {
    return { snapshotMode: 'detection-only', reason: `chmod -R a-w failed: ${errorMessage(error)}` };
  }
}

export function cleanupSnapshot({ cwd, tempRoot, baseWt, worktreeAdded, deps = {} }) {
  const io = { chmodRecursiveAddWrite, spawnSync, rmSync, ...deps };
  const problems = [];
  if (worktreeAdded) {
    try {
      io.chmodRecursiveAddWrite(baseWt);
    } catch (error) {
      problems.push(`chmod -R u+w failed: ${errorMessage(error)}`);
    }
    const removed = io.spawnSync('git', ['-C', cwd, 'worktree', 'remove', '--force', baseWt], { encoding: 'utf8' });
    if (removed.error || removed.status !== 0) {
      const detail = String(removed.stderr ?? removed.error?.message ?? '').trim() || `exit ${removed.status}`;
      problems.push(`git worktree remove --force failed: ${detail}`);
    }
  }
  if (tempRoot !== null && tempRoot !== undefined) {
    try {
      io.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      problems.push(`temp root removal failed: ${errorMessage(error)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── invalidation fallback chain (design D5) ─────────────────────────────────

function markerBody({ reason, attemptId, at }) {
  return `${JSON.stringify({ kind: 'invalidated', reason, attempt_id: attemptId, at }, null, 2)}\n`;
}

/**
 * Exclusive marker acquisition (merge-gate review C2): creating the marker with
 * O_EXCL is the atomic acquisition; a plain read-then-write left a TOCTOU window
 * in which a concurrent failing attempt's marker could be observed as absent,
 * then clobbered, and its failed evidence republished. Returns 'created' or
 * 'exists' (the caller re-evaluates ownership on 'exists').
 */
export function exclusiveCreateFile({ path: target, body }) {
  let fd;
  try {
    fd = openSync(target, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') return 'exists';
    throw error;
  }
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return 'created';
}

function revocationBody({ reason, attemptId, at }) {
  return `${JSON.stringify({ schema: REVOKED_SCHEMA, reason, attempt_id: attemptId, at }, null, 2)}\n`;
}

// ── per-change marker-mutation lock (design c14) ────────────────────────────

export const MARKER_LOCK_SCHEMA = 'devpro-openspec-validate-delta/lock/v1';

function markerLockPath(notesRoot, change) {
  return path.join(notesRoot, `openspec-validate-${change}.lock`);
}

function lockBody({ attemptId, at, pid, host }) {
  return `${JSON.stringify({ schema: MARKER_LOCK_SCHEMA, attempt_id: attemptId, pid, host, at }, null, 2)}\n`;
}

/**
 * Acquire the per-change exclusive marker-mutation lock (design c14). The lock
 * serializes every mutation of the invalidator marker so no attempt can ever
 * move or remove another attempt's invalidator. Idempotent for the same attempt:
 * if the on-disk lock is already this attempt's, the call reports reentrant
 * success and the caller MUST NOT release it. A foreign or malformed lock fails
 * closed with no auto-reclaim, so two committers can never overlap; recovery is
 * manual removal of `notes/openspec-validate-<change>.lock` (crashed attempt logs
 * identify the owner).
 */
export function acquireMarkerLock({
  root,
  notesRoot,
  change,
  attemptId,
  at,
  deps = {},
}) {
  const io = {
    createExclusiveDurableFile,
    readNoFollowFile,
    unlinkSync,
    fsyncDirectory,
    hostname: os.hostname,
    pid: process.pid,
    ...deps,
  };
  const lockPath = markerLockPath(notesRoot, change);
  const host = typeof io.hostname === 'function' ? io.hostname() : io.hostname;
  const body = lockBody({ attemptId, at, pid: io.pid, host });
  try {
    io.createExclusiveDurableFile({ root, parent: notesRoot, target: lockPath, body });
    return { ok: true, acquired: true, lockPath };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      return { ok: false, acquired: false, lockPath, reason: `could not acquire the invalidator lock: ${errorMessage(error)}` };
    }
  }
  let parsed = null;
  try {
    const { bytes } = io.readNoFollowFile({ root, parent: notesRoot, target: lockPath, maxBytes: 64 * 1024 });
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { ok: false, acquired: false, lockPath, reason: `the invalidator lock exists and is unreadable; refusing to proceed: ${errorMessage(error)}` };
  }
  if (parsed?.attempt_id === attemptId) return { ok: true, acquired: false, lockPath, reentrant: true };
  return { ok: false, acquired: false, lockPath, reason: 'another same-change attempt holds the invalidator lock' };
}

export function releaseMarkerLock({ lock, io = {} }) {
  if (!lock?.ok || !lock.acquired) return;
  try {
    (io.unlinkSync ?? unlinkSync)(lock.lockPath);
  } catch {
    /* best effort: ENOENT or removal fault */
  }
  try {
    (io.fsyncDirectory ?? fsyncDirectory)(path.dirname(lock.lockPath));
  } catch {
    /* best effort */
  }
}

/**
 * Ordered invalidation fallback chain shared by invalidate-first and the
 * post-publication guard. Each DURABLE step alone is enough to make the
 * canonical receipt unacceptable: (1) durable marker, (2) durable revocation
 * payload over the canonical receipt, (3) tombstone rename plus directory fsync
 * plus a MANDATORY post-rename revocation retry. The rename alone NEVER counts.
 * The whole chain runs under the per-change marker-mutation lock so no
 * concurrent attempt can observe or mutate the marker mid-step (design c14).
 * Returns `{ ok, via, rename_durability, failures }`.
 */
export function runInvalidationFallbackChain({
  root,
  notesRoot,
  change,
  attemptId,
  reason,
  at = new Date().toISOString(),
  platform = process.platform,
  deps = {},
}) {
  const io = { replaceDurableFile, renameSync, lstatSync, fsyncDirectory, createExclusiveDurableFile, readNoFollowFile, unlinkSync, ...deps };
  const markerPath = path.join(notesRoot, `openspec-validate-${change}.invalidated`);
  const receiptPath = path.join(notesRoot, `openspec-validate-${change}.json`);
  const tombstonePath = path.join(notesRoot, `openspec-validate-${change}.invalidated-${attemptId}.json`);
  const failures = [];
  const record = (step, error) => failures.push({ step, reason: errorMessage(error) });
  const bodies = { reason, attemptId, at };

  const lock = acquireMarkerLock({ root, notesRoot, change, attemptId, at, deps: io });
  if (!lock.ok) {
    failures.push({ step: 'lock', reason: lock.reason });
    return { ok: false, via: null, rename_durability: null, failures };
  }
  try {
    try {
      io.replaceDurableFile({ root, parent: notesRoot, target: markerPath, body: markerBody(bodies) });
      // The marker is the acceptance gate: its directory entry must be durable
      // BEFORE any fallible work can observe it as absent (merge-gate review C3).
      io.fsyncDirectory(notesRoot, { platform });
      return { ok: true, via: 'marker', rename_durability: null, failures };
    } catch (error) {
      record('marker', error);
    }

    try {
      io.replaceDurableFile({ root, parent: notesRoot, target: receiptPath, body: revocationBody(bodies) });
      return { ok: true, via: 'revocation', rename_durability: null, failures };
    } catch (error) {
      record('revocation', error);
    }

    let renameDurability = null;
    try {
      io.lstatSync(receiptPath);
      io.renameSync(receiptPath, tombstonePath);
      renameDurability = 'dir-fsync-unsupported';
      if (platform !== 'win32') {
        try {
          io.fsyncDirectory(notesRoot);
          renameDurability = 'fsync-verified';
        } catch {
          renameDurability = 'dir-fsync-unsupported';
        }
      }
    } catch (error) {
      record('rename', error);
      return { ok: false, via: null, rename_durability: null, failures };
    }

    try {
      io.replaceDurableFile({ root, parent: notesRoot, target: receiptPath, body: revocationBody(bodies) });
      return { ok: true, via: 'rename+revocation', rename_durability: renameDurability, failures };
    } catch (error) {
      record('rename-revocation-retry', error);
    }
    return { ok: false, via: null, rename_durability: renameDurability, failures };
  } finally {
    releaseMarkerLock({ lock, io });
  }
}

// ── publication (design D5) ────────────────────────────────────────────────

/**
 * publish-last: establish the durable invalidator marker, write the canonical
 * receipt, verify the read-back bytes, then remove the marker (publication
 * commit). A marker establishment failure is `receipt-publish-blocked` and
 * writes nothing; any later write/read-back/unlink failure is
 * `receipt-write-failed` and the publication does not commit (the marker stays).
 */
export function publishReceipt({
  root,
  notesRoot,
  change,
  attemptId,
  body,
  candidatePath = null,
  reason = 'invalidate-first',
  at = new Date().toISOString(),
  platform = process.platform,
  deps = {},
}) {
  const io = { replaceDurableFile, readNoFollowFile, exclusiveCreateFile, unlinkSync, renameSync, fsyncDirectory, ...deps };
  const markerPath = path.join(notesRoot, `openspec-validate-${change}.invalidated`);
  const receiptPath = path.join(notesRoot, `openspec-validate-${change}.json`);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const ownMarker = Buffer.from(markerBody({ reason, attemptId, at }), 'utf8');

  const markerState = () => {
    try {
      const { bytes: markerBytes } = io.readNoFollowFile({ root, parent: notesRoot, target: markerPath, maxBytes: 64 * 1024 });
      if (markerBytes.equals(ownMarker)) return 'own';
      // Ownership is keyed on the attempt id, not the whole payload: the same
      // attempt may refresh reason/at between invalidation and publication.
      try {
        const parsed = JSON.parse(markerBytes.toString('utf8'));
        return parsed?.attempt_id === attemptId ? 'own' : 'foreign';
      } catch {
        return 'foreign';
      }
    } catch (error) {
      return error?.code === 'ENOENT' ? 'absent' : 'foreign';
    }
  };
  const invalidateOwnReceipt = () =>
    runInvalidationFallbackChain({ root, notesRoot, change, attemptId, reason: 'publication-ownership-lost', at, platform, deps: io });
  // The canonical receipt is already on disk by the time the commit runs, so a
  // failed publication MUST leave a durable invalidator or revocation. When the
  // fallback chain cannot establish one, the receipt could still satisfy the
  // acceptance predicate and the failure MUST surface as receipt-unpublish-failed
  // instead of a publication-blocked error (merge-gate review C6).
  const failPublication = (reason) => {
    const invalidation = invalidateOwnReceipt();
    if (!invalidation.ok) {
      return {
        ok: false,
        code: 'receipt-unpublish-failed',
        reason: `${reason}; durable invalidation could not be established (${JSON.stringify(invalidation.failures)})`,
      };
    }
    return { ok: false, code: 'receipt-publish-blocked', reason };
  };

  // Overlapping-run ownership (merge-gate review C1/C2/C14): the marker is the
  // acceptance gate and every mutation of it runs under the per-change
  // marker-mutation lock, so no attempt can move or remove another attempt's
  // invalidator. A foreign marker still means another attempt owns the
  // invalidation state, so this attempt blocks.
  const preState = markerState();
  if (preState === 'foreign') {
    return { ok: false, code: 'receipt-publish-blocked', reason: 'the invalidator marker is owned by a different attempt' };
  }

  // Segment 1 — establish this attempt's durable invalidator marker under the
  // lock (design c14 §4). A crash after this leaves the marker present, so the
  // receipt stays unacceptable.
  const establishLock = acquireMarkerLock({ root, notesRoot, change, attemptId, at, deps: io });
  if (!establishLock.ok) {
    return { ok: false, code: 'receipt-publish-blocked', reason: establishLock.reason };
  }
  try {
    const state = markerState();
    if (state === 'foreign') {
      return { ok: false, code: 'receipt-publish-blocked', reason: 'the invalidator marker is owned by a different attempt' };
    }
    if (state === 'absent') {
      let outcome;
      try {
        outcome = io.exclusiveCreateFile({ path: markerPath, body: ownMarker });
      } catch (error) {
        return { ok: false, code: 'receipt-publish-blocked', reason: `could not establish the durable invalidator marker: ${errorMessage(error)}` };
      }
      if (outcome === 'created') {
        // Durability of the acceptance gate is established before the fallible
        // receipt writes; a non-durable marker entry could vanish on crash and
        // revive prior pass evidence (merge-gate review C3).
        try {
          io.fsyncDirectory(notesRoot, { platform });
        } catch (error) {
          return { ok: false, code: 'receipt-publish-blocked', reason: `could not establish parent-directory durability for the invalidator marker: ${errorMessage(error)}` };
        }
      } else if (markerState() !== 'own') {
        return { ok: false, code: 'receipt-publish-blocked', reason: 'another attempt acquired the invalidator marker concurrently' };
      }
    }
  } finally {
    releaseMarkerLock({ lock: establishLock, io });
  }

  // Attempt-scoped candidate receipt (design D5 attempt layout): the same bytes
  // that are then durably written to the canonical path. Receipt writes are not
  // lock-guarded (they need no marker exclusivity).
  if (candidatePath !== null) {
    try {
      io.replaceDurableFile({ root, parent: path.dirname(candidatePath), target: candidatePath, body: bytes });
    } catch (error) {
      return { ok: false, code: 'receipt-write-failed', reason: `could not write the candidate receipt: ${errorMessage(error)}` };
    }
  }
  try {
    io.replaceDurableFile({ root, parent: notesRoot, target: receiptPath, body: bytes });
  } catch (error) {
    return { ok: false, code: 'receipt-write-failed', reason: `could not write the canonical receipt: ${errorMessage(error)}` };
  }
  try {
    const { bytes: readBack } = io.readNoFollowFile({ root, parent: notesRoot, target: receiptPath, maxBytes: RECEIPT_MAX_BYTES });
    if (!readBack.equals(bytes)) {
      return { ok: false, code: 'receipt-write-failed', reason: 'canonical receipt read-back does not match the written bytes' };
    }
  } catch (error) {
    return { ok: false, code: 'receipt-write-failed', reason: `could not read the canonical receipt back: ${errorMessage(error)}` };
  }

  // Segment 2 — commit under the lock (design c14 §4). Re-read ownership while
  // holding the lock, then remove the marker with a single unlink; because every
  // cooperating attempt mutates the marker only under the lock, no foreign
  // marker can appear between the read and the unlink. A foreign marker is left
  // in place and this publication blocks. The unlink is the commit point: there
  // is no intermediate state where the marker has left the acceptance path but
  // the commit has not happened, so an interruption is always fail-closed.
  const commitLock = acquireMarkerLock({ root, notesRoot, change, attemptId, at, deps: io });
  if (!commitLock.ok) {
    return failPublication(`could not acquire the invalidator lock for the publication commit: ${commitLock.reason}`);
  }
  try {
    if (markerState() !== 'own') {
      return failPublication('invalidator marker ownership was lost before the publication commit');
    }
    try {
      io.unlinkSync(markerPath);
    } catch (error) {
      return failPublication(`could not remove the invalidator marker for the publication commit: ${errorMessage(error)}`);
    }
    try {
      io.fsyncDirectory(notesRoot, { platform });
    } catch {
      /* the commit is already observable; entry durability is best effort */
    }
  } finally {
    releaseMarkerLock({ lock: commitLock, io });
  }
  return { ok: true, code: null, reason: null };
}

// ── the runner ──────────────────────────────────────────────────────────────

function relativeToRoot(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

/**
 * The whole fail-closed flow. Returns `{ exitCode, code, decision, messages,
 * attemptId, receiptPath }`; `main()` is only the printer/exit wrapper so the
 * matrix can call this in-process with injected seams.
 */
export function runDeltaGate({ cwd = process.cwd(), change, baseRef, io: overrides = {} }) {
  const io = { ...REAL_IO, ...overrides };
  const messages = [];
  const emit = (stream, text) => {
    messages.push({ stream, text: text.endsWith('\n') ? text : `${text}\n` });
  };

  // identity self-check FIRST (added spec: before any Git or CLI collection).
  let identity;
  try {
    identity = io.classifyRepoIdentity(cwd);
  } catch (error) {
    identity = { identity: 'unknown', evidence: `identity probe threw: ${errorMessage(error)}` };
  }
  if (identity.identity !== 'consumer') {
    emit('stderr', `openspec-validate-delta: identity-refused: this gate is consumer-only (identity=${identity.identity}; evidence=${identity.evidence}).`);
    emit('stderr', '  source repositories keep the repo-wide requirement: `openspec validate --strict --specs --no-interactive` must be green.');
    emit('stderr', '  unknown identity stays fail-closed: resolve the repository identity before using this gate.');
    return { exitCode: 1, code: 'identity-refused', decision: null, messages, attemptId: null, receiptPath: null };
  }

  let root;
  try {
    root = io.defaultMainCheckoutRoot(cwd);
    io.assertMainCheckoutRootWritable(root);
  } catch (error) {
    emit('stderr', `openspec-validate-delta: receipt-invalidate-failed: cannot resolve a writable main-checkout root before invalidating existing evidence (${errorMessage(error)}). Flow stopped.`);
    return { exitCode: 1, code: 'receipt-invalidate-failed', decision: null, messages, attemptId: null, receiptPath: null };
  }

  const notesRoot = path.join(root, 'notes');
  const receiptPath = path.join(notesRoot, `openspec-validate-${change}.json`);
  const markerPath = path.join(notesRoot, `openspec-validate-${change}.invalidated`);
  // Paths this gate owns and writes before the head-cleanliness checks; they are
  // excluded from that check so a consumer repository without notes/ in
  // .gitignore is not rejected by the gate's own bookkeeping (merge-gate WARN).
  const gateOwnedPaths = [receiptPath, markerPath, path.join(notesRoot, 'tmp', `openspec-validate-${change}`), path.join(notesRoot, `openspec-validate-${change}.lock`)];

  const now = io.now();
  const generatedAt = now.toISOString();
  const attemptId = io.makeAttemptId({ now, pid: io.pid, random: io.random });

  // Invalidation seams shared by the invalidate-first commitment point and the
  // post-publication guard: one ordered fallback chain (design D5) must receive
  // the same injected deps at both call sites.
  const invalidationChainDeps = () => ({
    replaceDurableFile: io.replaceDurableFile,
    renameSync: io.renameSync,
    lstatSync: io.lstatSync,
    fsyncDirectory: io.fsyncDirectory,
    ...(io.invalidationDeps ?? {}),
  });

  // Every post-commitment exit that is not a committed publication MUST retain a
  // durable invalidator owned by THIS attempt through the exit boundary
  // (merge-gate review C8/C9). After invalidate-first, an overlapping
  // same-change attempt can replace this attempt's marker and later remove its
  // own marker when it publishes; merely observing a foreign marker is not
  // enough, because that owner can publish and remove it before this failing
  // attempt returns, leaving an acceptable pass receipt. Reassertion therefore
  // always (re)writes THIS attempt's durable marker: it overwrites any foreign
  // marker, and because a foreign owner's publication commit verifies ownership,
  // it cannot remove this marker — the failure stays durable. If the marker
  // cannot be established, the ordered fallback chain (revocation /
  // rename+revocation) runs; when nothing durable holds, the caller must surface
  // receipt-unpublish-failed.
  const reassertInvalidation = (context) => {
    if (!io.existsSync(notesRoot)) return { ok: true, via: 'no-notes-root', failures: [] };
    return io.runInvalidationFallbackChain({
      root,
      notesRoot,
      change,
      attemptId,
      reason: context,
      at: generatedAt,
      platform: io.platform,
      deps: invalidationChainDeps(),
    });
  };

  // 1. invalidate-first: the commitment point, before any CLI/git collection.
  let invalidation;
  if (!io.existsSync(notesRoot)) {
    invalidation = { ok: true, via: 'no-notes-root', rename_durability: null, failures: [] };
  } else {
    invalidation = io.runInvalidationFallbackChain({
      root,
      notesRoot,
      change,
      attemptId,
      reason: 'invalidate-first',
      at: generatedAt,
      platform: io.platform,
      deps: invalidationChainDeps(),
    });
  }
  if (!invalidation.ok) {
    emit('stderr', `openspec-validate-delta: receipt-invalidate-failed: no durable invalidation step held for ${relativeToRoot(root, receiptPath)} (marker, durable revocation, and rename+post-rename revocation all failed).`);
    for (const failure of invalidation.failures) emit('stderr', `  step ${failure.step}: ${failure.reason}`);
    emit('stderr', '  flow stopped; do not cite any receipt for this change in this session.');
    return { exitCode: 1, code: 'receipt-invalidate-failed', decision: null, messages, attemptId, receiptPath };
  }
  if (invalidation.via === 'revocation' || invalidation.via === 'rename+revocation') {
    emit('stderr', `openspec-validate-delta: note: invalidate-first held via ${invalidation.via}${invalidation.rename_durability ? ` (rename_durability=${invalidation.rename_durability})` : ''}; the previous canonical receipt is no longer acceptable.`);
  }

  const snapshot = { tempRoot: null, baseWt: null, worktreeAdded: false, cleanupOutcome: null };
  const ensureCleanup = () => {
    if (snapshot.cleanupOutcome) return snapshot.cleanupOutcome;
    if (snapshot.tempRoot === null) {
      snapshot.cleanupOutcome = { ok: true, problems: [] };
      return snapshot.cleanupOutcome;
    }
    snapshot.cleanupOutcome = io.cleanupSnapshot({
      cwd,
      tempRoot: snapshot.tempRoot,
      baseWt: snapshot.baseWt,
      worktreeAdded: snapshot.worktreeAdded,
      deps: {
        chmodRecursiveAddWrite: io.chmodRecursiveAddWrite,
        spawnSync: io.spawnSync,
        rmSync: io.rmSync,
        ...(io.cleanupDeps ?? {}),
      },
    });
    return snapshot.cleanupOutcome;
  };
  const fail = (code, detail) => {
    emit('stderr', `openspec-validate-delta: ${code}: ${detail}`);
    const reasserted = reassertInvalidation('post-failure-invalidation');
    const cleanup = ensureCleanup();
    if (!cleanup.ok && code !== 'cleanup-failed') {
      emit('stderr', `openspec-validate-delta: cleanup-failed: ${cleanup.problems.join('; ')}`);
    }
    if (!reasserted.ok) {
      emit('stderr', `openspec-validate-delta: receipt-unpublish-failed: ${code} left no durable invalidator or revocation; no receipt for this change may be cited in this session.`);
      for (const failure of reasserted.failures ?? []) emit('stderr', `  step ${failure.step}: ${failure.reason}`);
      return { exitCode: 1, code: 'receipt-unpublish-failed', decision: null, messages, attemptId, receiptPath, cause: code };
    }
    return { exitCode: 1, code, decision: null, messages, attemptId, receiptPath };
  };

  // 2. attempt dir (attempt-scoped logs; never referenced by a published receipt).
  const attemptDir = path.join(notesRoot, 'tmp', `openspec-validate-${change}`, attemptId);
  try {
    io.ensurePlainDirectoryChain({ root, dir: attemptDir });
  } catch (error) {
    return fail('attempt-dir-failed', `could not create ${relativeToRoot(root, attemptDir)} as a plain in-root directory: ${errorMessage(error)}`);
  }

  // 3-4. head and base sha.
  const headProbe = runGitVia(io, cwd, ['rev-parse', 'HEAD']);
  const head0 = headProbe.ok && headProbe.status === 0 ? headProbe.stdout.trim() : '';
  if (!SHA40_RE.test(head0)) {
    return fail('head-unresolved', `git rev-parse HEAD did not return a 40-hex commit (${headProbe.reason ?? `exit ${headProbe.status}`}).`);
  }
  const baseProbe = runGitVia(io, cwd, ['merge-base', baseRef, 'HEAD']);
  const baseSha = baseProbe.ok && baseProbe.status === 0 ? baseProbe.stdout.trim() : '';
  if (!SHA40_RE.test(baseSha)) {
    return fail('base-ref-unresolved', `git merge-base ${baseRef} HEAD did not resolve a base commit (${baseProbe.reason ?? `exit ${baseProbe.status}`}).`);
  }

  // 5. head pre-guard: tracked/staged/untracked must be clean (ignored is out of
  // scope for the real head worktree, design D6).
  const preGuard = io.probeHeadState({ cwd, ignorePaths: gateOwnedPaths });
  if (!preGuard.ok) return fail('head-unresolved', `head worktree probe failed before collection: ${preGuard.reason}`);
  if (preGuard.sha !== head0) {
    return fail('head-mutated-during-collection', `HEAD moved between resolution (${head0}) and the pre-guard (${preGuard.sha}).`);
  }
  if (!preGuard.clean) {
    return fail('dirty-worktree', 'head worktree has staged/tracked/untracked changes before collection; commit or clean them first.');
  }

  // 6. one executable, one version, used for BOTH runs (design D3 step 6).
  const executable = io.resolveExecutableOnPath({ name: 'openspec', env: io.env, platform: io.platform });
  if (executable === null) return fail('cli-exec-failed:version', 'openspec was not found as an executable on PATH.');
  const spawnTarget = openspecDeltaSpawnTarget(executable, { platform: io.platform });
  const versionArgs = ['--version'];
  const versionGuard = assertWin32OpenspecDeltaSpawnArgs(versionArgs, { platform: io.platform });
  if (!versionGuard.ok) return fail('cli-exec-failed:version', versionGuard.reason);
  const versionRun = io.spawnSync(spawnTarget, versionArgs, openspecDeltaSpawnOptions({ platform: io.platform }));
  if (versionRun.error || versionRun.status !== 0) {
    const detail = String(versionRun.stderr ?? versionRun.error?.message ?? '').trim() || `exit ${versionRun.status}`;
    return fail('cli-exec-failed:version', `openspec --version failed: ${detail}`);
  }
  const openspecVersion = parseOpenSpecVersion(versionRun.stdout);
  if (openspecVersion === null) {
    return fail('cli-exec-failed:version', `openspec --version output is not a semver: ${JSON.stringify(String(versionRun.stdout).trim())}`);
  }

  // 7. base snapshot.
  let tempRoot;
  try {
    tempRoot = io.mkdtempSync(path.join(io.tmpdir, 'devpro-openspec-validate-'));
  } catch (error) {
    return fail('base-snapshot-failed', `could not create a temp root for the base snapshot: ${errorMessage(error)}`);
  }
  snapshot.tempRoot = tempRoot;
  const baseWt = path.join(tempRoot, 'base-wt');
  snapshot.baseWt = baseWt;
  const worktreeAdd = io.spawnSync('git', ['-C', cwd, 'worktree', 'add', '--detach', baseWt, baseSha], { encoding: 'utf8' });
  if (worktreeAdd.error || worktreeAdd.status !== 0) {
    const detail = String(worktreeAdd.stderr ?? worktreeAdd.error?.message ?? '').trim() || `exit ${worktreeAdd.status}`;
    return fail('base-snapshot-failed', `git worktree add --detach failed: ${detail}`);
  }
  snapshot.worktreeAdded = true;
  const { snapshotMode } = io.applySnapshotReadOnly({
    baseWt,
    platform: io.platform,
    chmodRemoveWrite: io.chmodRemoveWrite,
  });

  // 8. base pre-check -> base run -> base post-check.
  const runGitIn = (target, args) => runGitVia(io, target, args);
  const basePre = io.evaluateBaseSnapshotState({ runGit: runGitIn, baseWt, baseSha });
  if (!basePre.ok) {
    return fail('base-snapshot-invalid', `base snapshot pre-check failed: ${JSON.stringify(snapshotChecks(basePre))}`);
  }
  const argsGuard = assertWin32OpenspecDeltaSpawnArgs(VALIDATE_ARGS, { platform: io.platform });
  if (!argsGuard.ok) return fail('cli-exec-failed:base', argsGuard.reason);
  const baseRun = io.spawnSync(spawnTarget, VALIDATE_ARGS, openspecDeltaSpawnOptions({ cwd: baseWt, maxBuffer: MAX_BUFFER, platform: io.platform }));
  if (baseRun.error) return fail('cli-exec-failed:base', `spawning the base validator failed: ${baseRun.error.message}`);
  if (baseRun.signal != null || baseRun.status == null) {
    return fail('cli-exec-failed:base', `the base validator did not exit normally (status=${baseRun.status ?? 'null'}, signal=${baseRun.signal ?? 'none'}).`);
  }
  let baseLog;
  try {
    baseLog = io.writeAttemptLog({ root, attemptDir, side: 'base', stdout: baseRun.stdout, stderr: baseRun.stderr });
  } catch (error) {
    return fail('log-write-failed', `could not write the base attempt log: ${errorMessage(error)}`);
  }
  const baseParsed = parseValidatePayload(baseRun.stdout, 'base');
  if (!baseParsed.ok) return fail(baseParsed.code, baseParsed.reason);
  const baseCoherence = assessValidatorCoherence({ status: baseRun.status, specs: baseParsed.specs, summary: baseParsed.summary, side: 'base' });
  if (!baseCoherence.ok) return fail(baseCoherence.code, baseCoherence.reason);
  const basePost = io.evaluateBaseSnapshotState({ runGit: runGitIn, baseWt, baseSha });
  if (!basePost.ok) {
    return fail('base-snapshot-mutated', `base snapshot changed during validation: ${JSON.stringify(snapshotChecks(basePost))}`);
  }

  // 9. head run bracketed by sha+clean probes.
  const headPre = io.probeHeadState({ cwd, ignorePaths: gateOwnedPaths });
  if (!headPre.ok || headPre.sha !== head0 || !headPre.clean) {
    return fail('head-mutated-during-collection', `head worktree changed after the pre-guard (sha=${headPre.sha ?? 'unresolved'}, clean=${headPre.clean ?? 'unknown'}).`);
  }
  const headArgsGuard = assertWin32OpenspecDeltaSpawnArgs(VALIDATE_ARGS, { platform: io.platform });
  if (!headArgsGuard.ok) return fail('cli-exec-failed:head', headArgsGuard.reason);
  const headRun = io.spawnSync(spawnTarget, VALIDATE_ARGS, openspecDeltaSpawnOptions({ cwd, maxBuffer: MAX_BUFFER, platform: io.platform }));
  if (headRun.error) return fail('cli-exec-failed:head', `spawning the head validator failed: ${headRun.error.message}`);
  if (headRun.signal != null || headRun.status == null) {
    return fail('cli-exec-failed:head', `the head validator did not exit normally (status=${headRun.status ?? 'null'}, signal=${headRun.signal ?? 'none'}).`);
  }
  let headLog;
  try {
    headLog = io.writeAttemptLog({ root, attemptDir, side: 'head', stdout: headRun.stdout, stderr: headRun.stderr });
  } catch (error) {
    return fail('log-write-failed', `could not write the head attempt log: ${errorMessage(error)}`);
  }
  const headParsed = parseValidatePayload(headRun.stdout, 'head');
  if (!headParsed.ok) return fail(headParsed.code, headParsed.reason);
  const headCoherence = assessValidatorCoherence({ status: headRun.status, specs: headParsed.specs, summary: headParsed.summary, side: 'head' });
  if (!headCoherence.ok) return fail(headCoherence.code, headCoherence.reason);
  const headPost = io.probeHeadState({ cwd, ignorePaths: gateOwnedPaths });
  if (!headPost.ok || headPost.sha !== head0 || !headPost.clean) {
    return fail('head-mutated-during-collection', `HEAD or the head worktree changed during collection (sha=${headPost.sha ?? 'unresolved'}, clean=${headPost.clean ?? 'unknown'}).`);
  }

  // 10-11. normalization + decision.
  const roots = [cwd, baseWt];
  const baseFingerprint = buildFingerprint(baseParsed.specs, roots);
  const headFingerprint = buildFingerprint(headParsed.specs, roots);
  const comparison = compareSpecResults({ base: baseFingerprint, head: headFingerprint });
  const counts = `checked_specs=${comparison.checkedSpecs} inherited=${comparison.inherited} new=${comparison.newInvalid.length} changed=${comparison.changedInvalid.length} resolved=${comparison.resolved.length}`;

  // 12a. cleanup always runs on the collected path, before any publication.
  const cleanup = ensureCleanup();
  if (comparison.decision === 'block') {
    emit('stderr', `openspec-validate-delta: ${change}: ${counts} decision=block`);
    const headTokensById = new Map(headFingerprint.map((entry) => [entry.id, entry.tokens]));
    if (comparison.newInvalid.length > 0) {
      emit('stderr', `  new_invalid (${comparison.newInvalid.length}): ${comparison.newInvalid.join(', ')}`);
      for (const id of comparison.newInvalid) {
        emit('stderr', `  ${id} head tokens:`);
        for (const token of headTokensById.get(id) ?? []) emit('stderr', `    ${token}`);
      }
    }
    if (comparison.changedInvalid.length > 0) {
      emit('stderr', `  changed_invalid (${comparison.changedInvalid.length}): ${comparison.changedInvalid.join(', ')}`);
      for (const id of comparison.changedInvalid) {
        emit('stderr', `  ${id} head new tokens:`);
        for (const token of comparison.headNewTokens[id] ?? []) emit('stderr', `    ${token}`);
      }
    }
    emit('stderr', '  evidence: no pass receipt is written for decision=block; durable invalidation for this change is reasserted before exit.');
    if (!cleanup.ok) return fail('cleanup-failed', cleanup.problems.join('; '));
    const blockInvalidation = reassertInvalidation('post-block-invalidation');
    if (!blockInvalidation.ok) {
      emit('stderr', 'openspec-validate-delta: receipt-unpublish-failed: decision=block could not re-establish a durable invalidator or revocation; no receipt for this change may be cited in this session.');
      for (const failure of blockInvalidation.failures ?? []) emit('stderr', `  step ${failure.step}: ${failure.reason}`);
      return { exitCode: 1, code: 'receipt-unpublish-failed', decision: 'block', messages, attemptId, receiptPath };
    }
    return { exitCode: 1, code: null, decision: 'block', messages, attemptId, receiptPath };
  }
  if (!cleanup.ok) return fail('cleanup-failed', cleanup.problems.join('; '));

  // 12b. final guards before publication.
  const finalGuard = io.probeHeadState({ cwd, ignorePaths: gateOwnedPaths });
  if (!finalGuard.ok || finalGuard.sha !== head0 || !finalGuard.clean) {
    return fail('head-mutated-during-collection', `HEAD or the head worktree changed before publication (sha=${finalGuard.sha ?? 'unresolved'}, clean=${finalGuard.clean ?? 'unknown'}).`);
  }

  // 12c. publish-last.
  try {
    io.ensurePlainNotesRoot(receiptPath);
  } catch (error) {
    return fail('receipt-write-failed', `notes/ root is not a plain directory: ${errorMessage(error)}`);
  }
  const publishedAt = io.now().toISOString();
  const receipt = {
    schema: SCHEMA_V2,
    attempt_id: attemptId,
    change,
    identity: 'consumer',
    identity_evidence: identity.evidence,
    base_ref: baseRef,
    base_sha: baseSha,
    head_sha: head0,
    command: VALIDATE_COMMAND,
    openspec_version: openspecVersion,
    openspec_executable: executable,
    base: {
      log_path: relativeToRoot(root, baseLog.path),
      log_digest_sha256: baseLog.digest,
      result_digest_sha256: sha256Hex(JSON.stringify(baseFingerprint)),
      exit_code: Number.isInteger(baseRun.status) ? baseRun.status : null,
      invalid: invalidEntries(baseFingerprint),
      snapshot_mode: snapshotMode,
      snapshot_checks: { pre: snapshotChecks(basePre), post: snapshotChecks(basePost) },
    },
    head: {
      log_path: relativeToRoot(root, headLog.path),
      log_digest_sha256: headLog.digest,
      result_digest_sha256: sha256Hex(JSON.stringify(headFingerprint)),
      exit_code: Number.isInteger(headRun.status) ? headRun.status : null,
      invalid: invalidEntries(headFingerprint),
      guards: {
        head_sha_pre: headPre.sha,
        head_sha_post: headPost.sha,
        clean_pre: headPre.clean === true,
        clean_post: headPost.clean === true,
      },
    },
    new_invalid: comparison.newInvalid,
    changed_invalid: comparison.changedInvalid,
    resolved: comparison.resolved,
    decision: 'pass',
    published_at: publishedAt,
    generated_at: generatedAt,
  };
  const publication = io.publishReceipt({
    root,
    notesRoot,
    change,
    attemptId,
    body: `${JSON.stringify(receipt, null, 2)}\n`,
    candidatePath: path.join(attemptDir, 'receipt.json'),
    reason: 'invalidate-first',
    at: publishedAt,
    platform: io.platform,
    deps: {
      replaceDurableFile: io.replaceDurableFile,
      readNoFollowFile: io.readNoFollowFile,
      unlinkSync: io.unlinkSync,
      fsyncDirectory: io.fsyncDirectory,
      ...(io.publicationDeps ?? {}),
    },
  });
  if (!publication.ok) return fail(publication.code, publication.reason);

  // 12d. post-publication guard: HEAD/worktree drift revokes via the same
  // fallback chain; no durable step means the flow stops with a distinct code.
  const postPublication = io.probeHeadState({ cwd, ignorePaths: gateOwnedPaths });
  if (!postPublication.ok || postPublication.sha !== head0 || !postPublication.clean) {
    const revocation = io.runInvalidationFallbackChain({
      root,
      notesRoot,
      change,
      attemptId,
      reason: 'head-mutated-during-publication',
      at: io.now().toISOString(),
      platform: io.platform,
      deps: invalidationChainDeps(),
    });
    const drift = `HEAD or the head worktree changed after publication (sha=${postPublication.sha ?? 'unresolved'}, clean=${postPublication.clean ?? 'unknown'}).`;
    if (revocation.ok) {
      return fail('head-mutated-during-publication', `${drift} The receipt was revoked via ${revocation.via}; do not cite it.`);
    }
    return fail('receipt-unpublish-failed', `${drift} No durable revocation step held${revocation.rename_durability ? ` (rename_durability=${revocation.rename_durability})` : ''}; flow stopped, and no receipt for this change may be cited in this session.`);
  }

  emit('stdout', `openspec-validate-delta: ${change}: ${counts} decision=pass`);
  emit('stdout', `  base_sha=${baseSha} head_sha=${head0} snapshot_mode=${snapshotMode} attempt=${attemptId}`);
  emit('stdout', `  receipt: ${relativeToRoot(root, receiptPath)}`);
  return { exitCode: 0, code: null, decision: 'pass', messages, attemptId, receiptPath };
}

// ── real dependency container (injected seams default here) ─────────────────

const REAL_IO = {
  spawnSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  chmodRemoveWrite: chmodRecursiveRemoveWrite,
  chmodRecursiveAddWrite,
  writeAttemptLog,
  probeHeadState,
  evaluateBaseSnapshotState,
  applySnapshotReadOnly,
  resolveExecutableOnPath,
  makeAttemptId,
  classifyRepoIdentity,
  ensurePlainNotesRoot,
  ensurePlainDirectoryChain,
  replaceDurableFile,
  readNoFollowFile,
  exclusiveCreateFile,
  renameSync,
  lstatSync,
  unlinkSync,
  fsyncDirectory,
  cleanupSnapshot,
  publishReceipt,
  runInvalidationFallbackChain,
  defaultMainCheckoutRoot,
  assertMainCheckoutRootWritable,
  now: () => new Date(),
  random: () => Math.random(),
  pid: process.pid,
  platform: process.platform,
  env: process.env,
  tmpdir: os.tmpdir(),
};

function main() {
  const parsed = parseDeltaArgs(process.argv);
  if (!parsed.ok) {
    process.stderr.write(`openspec-validate-delta: usage-error: ${parsed.reason}\nusage: ${USAGE}\n`);
    process.exit(1);
  }
  let result;
  try {
    result = runDeltaGate({ cwd: process.cwd(), change: parsed.change, baseRef: parsed.baseRef });
  } catch (error) {
    process.stderr.write(`openspec-validate-delta: unexpected internal failure (flow stopped, no evidence published): ${errorMessage(error)}\n`);
    process.exit(1);
  }
  for (const message of result.messages) {
    (message.stream === 'stderr' ? process.stderr : process.stdout).write(message.text);
  }
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
