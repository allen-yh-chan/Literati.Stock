/**
 * pr-sticky lane review-round budget: repository-and-PR sidecar (D3), schema (D4),
 * override polarity (D5). See
 * `openspec/changes/strengthen-cross-review-loop-termination/design.md`.
 *
 * Lane-scoped cap: `PR_STICKY_REVIEW_ROUND_CAP` belongs ONLY to the pr-sticky
 * lane (this module). It is deliberately NOT named `REVIEW_ROUND_CAP` and
 * MUST NOT be merged with the design-gate audit-only lane cap (6) or the
 * harness write-block cap (3) — three different lanes, three different
 * counters (D9).
 *
 * The sidecar is the SOLE authority for `round_count` / `dispatch_lineage[]`.
 * It intentionally does NOT reuse `post-pr-completion-state.mjs`'s marker CAS
 * lock helpers (`acquireMarkerCompareAndSwapLock` / `unlinkDurably`) because
 * those are module-private (not exported) there. This module reimplements an
 * equivalent per-attempt-unique-lockfile CAS shape (same discipline as the
 * marker's CAS lock, matching the shape not the exact code): each attempt
 * creates its own `<sidecar>.lock.<uuid>` via `openSync(lockFile, "wx")`,
 * stale contenders (dead owner PID, or mtime older than the stale window)
 * are reaped by their own path before each acquisition attempt, a
 * post-create rescan detects a live concurrent contender (unique names mean
 * `wx`'s EEXIST can no longer signal that), and durable writes go through
 * fsync + atomic rename + fsyncDirectory, matching the marker durability
 * path.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { postPrCompletionDir } from "./post-pr-completion-state.mjs";
import { repoName, repoStateToken } from "./repo-key.mjs";
import { fsyncDirectory } from "../../lib/durable-fs.mjs";

// D5: this cap belongs to the pr-sticky lane only (D9). MUST NOT be merged
// with the design-gate audit-only lane cap (6) or the harness write-block
// cap (3).
export const PR_STICKY_REVIEW_ROUND_CAP = 3;

const SIDECAR_PREFIX = "review-round-";
const SIDECAR_LOCK_STALE_AFTER_MS = 30_000;
const COUNTING_ATTEMPTS = new Set(["initial", "focused-sticky-refresh"]);
export const PAGE_WINDOW_CONTINUE_ATTEMPT = "page-window-continue";

/**
 * Derive the effective review-round attempt kind. `page-window-continue` is
 * non-counting ONLY when checkpoint sidecar evidence proves a valid
 * page_window_checkpoint_handoff continuation (same head_ref_oid + monotonic
 * window_index). Callers MUST NOT self-declare continue to skip counting —
 * a bare `attempt: "page-window-continue"` without proof is coerced to a
 * counting `initial` (fake-continue fail-closed polarity: still counts).
 */
export function resolveReviewRoundAttemptKind({
  declaredAttempt,
  pageWindowHandoff = null,
  priorState = null,
} = {}) {
  const proof = provePageWindowContinue({ pageWindowHandoff, priorState });
  if (proof.ok) {
    return {
      kind: PAGE_WINDOW_CONTINUE_ATTEMPT,
      counting: false,
      derived: true,
      page_window_index: proof.page_window_index,
      head_ref_oid: proof.head_ref_oid,
    };
  }
  if (declaredAttempt === PAGE_WINDOW_CONTINUE_ATTEMPT) {
    return {
      kind: "initial",
      counting: true,
      derived: false,
      fake_continue: true,
      reason: proof.reason || "page_window_continue_unproven",
    };
  }
  return {
    kind: declaredAttempt,
    counting: COUNTING_ATTEMPTS.has(declaredAttempt),
    derived: false,
  };
}

function provePageWindowContinue({ pageWindowHandoff, priorState } = {}) {
  if (!pageWindowHandoff || typeof pageWindowHandoff !== "object") {
    return { ok: false, reason: "missing_page_window_handoff" };
  }
  if (pageWindowHandoff.page_window_checkpoint_handoff !== true) {
    return { ok: false, reason: "checkpoint_handoff_absent" };
  }
  const headRefOid = typeof pageWindowHandoff.head_ref_oid === "string"
    ? pageWindowHandoff.head_ref_oid.trim()
    : "";
  if (!/^[0-9a-f]{40}$/.test(headRefOid)) {
    return { ok: false, reason: "head_ref_oid_invalid" };
  }
  const windowIndex = Number(pageWindowHandoff.window_index);
  if (!Number.isSafeInteger(windowIndex) || windowIndex < 2) {
    return { ok: false, reason: "window_index_not_continuation" };
  }
  const lineage = Array.isArray(priorState?.dispatch_lineage) ? priorState.dispatch_lineage : [];
  let priorMaxWindow = 0;
  let sawSameHead = false;
  for (const entry of lineage) {
    if ((entry?.head_ref_oid || "") !== headRefOid) continue;
    sawSameHead = true;
    const priorWindow = Number(entry?.page_window_index);
    if (Number.isSafeInteger(priorWindow) && priorWindow > priorMaxWindow) {
      priorMaxWindow = priorWindow;
    }
  }
  if (!sawSameHead) {
    return { ok: false, reason: "no_prior_same_head_lineage" };
  }
  // Continuation proof requires a prior same-head lineage entry that already
  // recorded a page_window_index (typically the counting first window at 1).
  // Do NOT invent baseline=1 from a bare initial/focused entry — that lets a
  // forged handoff:true + window_index:2 skip counting without any on-disk
  // page-window checkpoint artifact.
  if (!(priorMaxWindow >= 1)) {
    return { ok: false, reason: "no_prior_page_window_lineage" };
  }
  if (!(windowIndex > priorMaxWindow)) {
    return { ok: false, reason: "window_index_not_monotonic" };
  }
  return {
    ok: true,
    page_window_index: windowIndex,
    head_ref_oid: headRefOid,
  };
}

function sanitizePrNumberToken(value) {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

function reviewRoundIdentity({ cwd = process.cwd(), prNumber, repositorySlug = "" } = {}) {
  const requested = String(repositorySlug ?? "").trim();
  const repository = repoName(requested);
  const pr = String(prNumber ?? "");
  if (requested && (!repository || !/^[1-9]\d{0,15}$/.test(pr) || !Number.isSafeInteger(Number(pr)))) {
    throw roundIdentityError("Review round state requires a valid GitHub.com repository and PR number.");
  }
  const dir = postPrCompletionDir(cwd);
  const legacy = path.join(dir, `${SIDECAR_PREFIX}${sanitizePrNumberToken(pr)}.json`);
  const keyed = repository
    ? path.join(dir, `${SIDECAR_PREFIX}${repoStateToken(repository)}#${pr}.json`)
    : legacy;
  return { repository, pr, legacy, keyed };
}

// The default path for new state. A scoped operation may instead select an owned legacy file.
export function reviewRoundSidecarPath(options) {
  return reviewRoundIdentity(options).keyed;
}

function roundIdentityError(message) {
  return Object.assign(new Error(message), { classification: "review_round_state_identity_conflict" });
}

// F4 fix: per-attempt unique lock filenames. The prior shared fixed name
// (`<sidecar>.lock`) let a reap that lost the stat/unlink race against a
// fresh contender's brand-new lock delete that fresh lock instead of the
// stale one it inspected (both had the same path). A UUID-suffixed name
// makes that impossible — a reap only ever unlinks the exact file it just
// verified stale-and-dead, by that file's own path.
function lockFileFor(sidecarFile) {
  return `${sidecarFile}.lock.${randomUUID()}`;
}

function lockFilePrefix(sidecarFile) {
  return `${path.basename(sidecarFile)}.lock.`;
}

function lockOwnerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Reaps every stale-and-dead lock file for `sidecarFile` (there can be more
 * than one abandoned contender at once). Each candidate is inspected and
 * unlinked by its own unique path, so this can never remove a live
 * contender's lock. */
function reapStaleLocks(sidecarFile) {
  const dir = path.dirname(sidecarFile);
  const prefix = lockFilePrefix(sidecarFile);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const lockFile = path.join(dir, name);
    let stat;
    try {
      stat = statSync(lockFile);
    } catch {
      continue;
    }
    if (Date.now() - stat.mtimeMs <= SIDECAR_LOCK_STALE_AFTER_MS) continue;
    let record = null;
    try {
      record = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      record = null;
    }
    if (record && lockOwnerAlive(record.owner_pid)) continue;
    try {
      unlinkSync(lockFile);
      fsyncDirectory(dir);
    } catch {
      // Best effort; harmless if another reaper or this file's own owner's
      // release already removed this exact (uniquely-named) file first.
    }
  }
}

/** Post-create contention signal. Unique names mean `wx`-create at
 * `acquireSidecarLock` can no longer collide (EEXIST is no longer the "lost
 * the race" signal), so contention must instead be detected by rescanning
 * for another live (non-stale) lock file after creating our own.
 *
 * Uses the same age-then-owner "is this lock dead" evidence as
 * `reapStaleLocks` (a lock is only presumed dead once it is both stale by
 * age AND its owner fails the liveness check), but fails closed wherever
 * that evidence is missing or unreadable — directory listing failure, or a
 * candidate's stat failing for a reason other than a genuine ENOENT
 * disappearance race. `reapStaleLocks` giving up silently on such evidence
 * only risks leaving a dead lock behind a little longer, which is harmless;
 * this function giving up the same way would instead let a second acquirer
 * proceed straight into the sidecar's critical section, so anything it
 * cannot affirmatively prove dead MUST be treated as live contention. */
function otherLiveLockExists(sidecarFile, exceptLockFile) {
  const dir = path.dirname(sidecarFile);
  const prefix = lockFilePrefix(sidecarFile);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const lockFile = path.join(dir, name);
    if (lockFile === exceptLockFile) continue;
    let stat;
    try {
      stat = statSync(lockFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return true;
    }
    if (now - stat.mtimeMs <= SIDECAR_LOCK_STALE_AFTER_MS) return true;
    let record = null;
    try {
      record = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      record = null;
    }
    if (record && !lockOwnerAlive(record.owner_pid)) continue;
    return true;
  }
  return false;
}

/** F-2945ee6b784c: after the fixed 30s stale reap, briefly retry acquire with
 * bounded backoff before failing closed. Live contention still exhausts the
 * attempts and returns null (review_round_state_write_failed). */
const SIDECAR_LOCK_ACQUIRE_ATTEMPTS = 4;
const SIDECAR_LOCK_RETRY_BACKOFF_MS = Object.freeze([0, 25, 75, 150]);

function sleepMs(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireSidecarLock(sidecarFile) {
  for (let attempt = 0; attempt < SIDECAR_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepMs(SIDECAR_LOCK_RETRY_BACKOFF_MS[attempt] ?? 150);
    reapStaleLocks(sidecarFile);
    const lockFile = lockFileFor(sidecarFile);
    let fd;
    try {
      fd = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({
        schema: "devpro-review-round-sidecar-lock/v1",
        owner_pid: process.pid,
        created_at: new Date().toISOString(),
      }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(path.dirname(lockFile));
    if (otherLiveLockExists(sidecarFile, lockFile)) {
      releaseSidecarLock({ lockFile });
      continue;
    }
    return { lockFile };
  }
  return null;
}

function releaseSidecarLock(lock) {
  if (!lock) return;
  try {
    unlinkSync(lock.lockFile);
    fsyncDirectory(path.dirname(lock.lockFile));
  } catch {
    // Best effort release; a crashed owner's lock self-heals via staleness
    // reap on the next acquisition attempt.
  }
}

function withReviewRoundLocks({ legacy, keyed, pr }, operation) {
  const locks = [];
  try {
    for (const file of [...new Set([legacy, keyed])].sort()) {
      const lock = acquireSidecarLock(file);
      if (!lock) throw new Error(`review round sidecar lock unavailable for PR #${pr}; another writer is active`);
      locks.push(lock);
    }
    return operation();
  } catch (error) {
    if (!error.classification) error.classification = "review_round_state_write_failed";
    throw error;
  } finally {
    for (const lock of locks.reverse()) releaseSidecarLock(lock);
  }
}

function writeSidecarDurably(sidecarFile, data) {
  const dir = path.dirname(sidecarFile);
  mkdirSync(dir, { recursive: true });
  const candidate = `${sidecarFile}.${process.pid}.${Date.now()}.${randomUUID()}.candidate`;
  let fd;
  let renamed = false;
  try {
    fd = openSync(candidate, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(candidate, sidecarFile);
    renamed = true;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (!renamed) {
      try { unlinkSync(candidate); } catch {}
    }
  }
}

// N3: missing file, unreadable/corrupt JSON, or missing `round_count` /
// `schema_version` all collapse to round_count = 0 and `upgraded: true` so
// the caller can stamp `provenance: "upgraded-from-missing"` on the next
// lineage entry. MUST NOT throw on a merely-incomplete sidecar.
function readRawSidecarState(sidecarFile) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(sidecarFile, "utf8"));
  } catch {
    raw = null;
  }
  return normalizeSidecarState(raw);
}

function normalizeSidecarState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { round_count: 0, dispatch_lineage: [], repository_slug: "", upgraded: true };
  }
  const hasRoundCount = Number.isSafeInteger(raw.round_count) && raw.round_count >= 0;
  const hasSchemaVersion = Number.isSafeInteger(raw.schema_version);
  return {
    round_count: hasRoundCount ? raw.round_count : 0,
    dispatch_lineage: Array.isArray(raw.dispatch_lineage) ? raw.dispatch_lineage : [],
    repository_slug: typeof raw.repository_slug === "string" ? raw.repository_slug : "",
    upgraded: !hasRoundCount || !hasSchemaVersion,
  };
}

function readScopedSidecar(file, { repository, pr }, { legacy = false } = {}) {
  let raw;
  try {
    if (!lstatSync(file).isFile()) throw new Error("Not a regular sidecar");
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw roundIdentityError(`Review round sidecar ${path.basename(file)} cannot be read. Verify its repository and PR before retrying.`);
  }
  const owner = repoName(raw?.repository_slug);
  if (legacy && owner && owner !== repository) return null;
  const samePr = (legacy && raw?.pr_number == null) || String(raw?.pr_number) === pr;
  if (owner !== repository || !samePr) {
    throw roundIdentityError(`Review round sidecar ${path.basename(file)} does not prove its expected repository and PR. Resolve its ownership before retrying.`);
  }
  return { file, state: normalizeSidecarState(raw), exists: true };
}

function selectReviewRoundSidecar(identity) {
  const { repository, legacy, keyed } = identity;
  if (!repository) return { file: legacy, state: readRawSidecarState(legacy), exists: existsSync(legacy) };
  const current = readScopedSidecar(keyed, identity);
  const prior = readScopedSidecar(legacy, identity, { legacy: true });
  if (current && prior) {
    throw roundIdentityError(`Review round sidecars ${path.basename(keyed)} and ${path.basename(legacy)} both claim this repository and PR. Resolve the duplicate before retrying.`);
  }
  // Keep a proven legacy authority in place so no move or merge can discard its lineage.
  return current || prior || { file: keyed, state: normalizeSidecarState(null), exists: false };
}

/** Read-only snapshot. Safe to call without the lock — the gating
 * read-modify-write happens inside `recordReviewRoundDispatch`, which takes
 * the lock itself. Callers that need a pre-record snapshot (e.g. to decide
 * whether a prior round already exists before this dispatch's own lineage
 * entry lands) MUST call this BEFORE `recordReviewRoundDispatch`/
 * `assertReviewRoundBudget`, not after. */
export function readReviewRoundState(options) {
  const identity = reviewRoundIdentity(options);
  const { state, exists } = selectReviewRoundSidecar(identity);
  return {
    schema_version: 1,
    pr_number: identity.pr,
    repository_slug: state.repository_slug,
    round_count: state.round_count,
    dispatch_lineage: state.dispatch_lineage,
    exists,
  };
}

/** D4 read-modify-write: `initial` / `focused-sticky-refresh` (`kind` ==
 * renderer `attempt` token, D4) increment `round_count`; `fault-recovery`
 * does not, but still appends a lineage entry whose `round` records the
 * current (unincremented) `round_count` (D4).
 *
 * N4: durable write is fsync + atomic rename + this module's CAS lock. Any
 * failure (lock unavailable, unwritable state dir, write/rename failure)
 * throws with `error.classification = "review_round_state_write_failed"` —
 * callers MUST NOT treat that as `round_count = 0` and continue dispatching. */
export function recordReviewRoundDispatch({
  cwd = process.cwd(),
  prNumber,
  repositorySlug = "",
  attempt,
  dispatchId = "",
  headRefOid = "",
  reviewScope = "",
  override = null,
  pageWindowHandoff = null,
} = {}) {
  const identity = reviewRoundIdentity({ cwd, prNumber, repositorySlug });
  try {
    mkdirSync(path.dirname(identity.keyed), { recursive: true });
  } catch (error) {
    error.classification = "review_round_state_write_failed";
    throw error;
  }
  return withReviewRoundLocks(identity, () => {
    const { file, state: current } = selectReviewRoundSidecar(identity);
    const resolved = resolveReviewRoundAttemptKind({
      declaredAttempt: attempt,
      pageWindowHandoff: pageWindowHandoff
        ?? (attempt === PAGE_WINDOW_CONTINUE_ATTEMPT
          ? {
            page_window_checkpoint_handoff: false,
            head_ref_oid: headRefOid,
            window_index: 0,
          }
          : null),
      priorState: current,
    });
    const effectiveAttempt = resolved.kind;
    const isCountingAttempt = resolved.counting;
    // Re-validate under the lock (closes the TOCTOU between this dispatch's
    // earlier lock-free `evaluateReviewRoundBudget` check and this write): a
    // concurrent dispatch may have already incremented `round_count` past the
    // cap since that check ran. Re-derive authorization from the SAME
    // `override` the caller already computed rather than re-parsing env (see
    // this function's doc comment: the check's own result is the one that
    // authorized the caller and MUST be the one recorded) — an override
    // remains valid here as long as its `override_max` still exceeds this
    // fresh `round_count`.
    if (isCountingAttempt && current.round_count >= PR_STICKY_REVIEW_ROUND_CAP) {
      const stillAuthorized =
        override && Number.isSafeInteger(override.override_max) && override.override_max > current.round_count
        && (!identity.repository || override.override_pr === identity.pr)
        && (!override.override_repo || override.override_repo === identity.repository);
      if (!stillAuthorized) {
        throw budgetExhaustedError(prNumber, current.round_count, identity.repository);
      }
    }
    const nextRoundCount = isCountingAttempt ? current.round_count + 1 : current.round_count;
    const lineageEntry = {
      round: nextRoundCount,
      kind: effectiveAttempt,
      attempt: effectiveAttempt,
      dispatch_id: dispatchId || "",
      head_ref_oid: headRefOid || resolved.head_ref_oid || "",
      review_scope: reviewScope || "",
      recorded_at: new Date().toISOString(),
      ...(Number.isSafeInteger(resolved.page_window_index)
        ? { page_window_index: resolved.page_window_index }
        : Number.isSafeInteger(Number(pageWindowHandoff?.window_index))
          ? { page_window_index: Number(pageWindowHandoff.window_index) }
          : {}),
      ...(current.upgraded ? { provenance: "upgraded-from-missing" } : {}),
      ...(override ? { override } : {}),
      ...(resolved.fake_continue ? { fake_continue_coerced: true } : {}),
    };
    const nextState = {
      schema_version: 1,
      pr_number: String(prNumber ?? ""),
      repository_slug: identity.repository ? identity.repository.slice("github.com/".length) : current.repository_slug,
      round_count: nextRoundCount,
      dispatch_lineage: [...current.dispatch_lineage, lineageEntry],
      updated_at: new Date().toISOString(),
    };
    writeSidecarDurably(file, nextState);
    return nextState;
  });
}

/** Clear point 1/2 (D3 lifecycle): called by `post-pr-completion-check.mjs`
 * once a PR is observed MERGED/CLOSED. Returns `true` iff a file was
 * durably removed. */
export function clearReviewRoundState(options) {
  const identity = reviewRoundIdentity(options);
  if (!existsSync(path.dirname(identity.keyed))) return false;
  return withReviewRoundLocks(identity, () => {
    const { file, exists } = selectReviewRoundSidecar(identity);
    if (!exists) return false;
    try {
      unlinkSync(file);
      fsyncDirectory(path.dirname(file));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
}

/** Read-only inventory for the archive advisory. Recognizes both filename
 * forms and returns `[{ prNumber, file, mtimeMs }]`. Only the scoped reader
 * establishes sidecar ownership. */
export function listReviewRoundSidecars({ cwd = process.cwd() } = {}) {
  const dir = postPrCompletionDir(cwd);
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.startsWith(SIDECAR_PREFIX) || !file.endsWith(".json")) continue;
    const token = file.slice(SIDECAR_PREFIX.length, -".json".length);
    const prNumber = token.includes("#") ? /^[a-f0-9]{64}#([1-9]\d{0,15})$/.exec(token)?.[1] : token;
    if (!prNumber) continue;
    const full = path.join(dir, file);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    out.push({ prNumber, file: full, mtimeMs });
  }
  return out;
}

/** Orphan-scan probe throttle support: bump the sidecar mtime after a
 * non-cleared PR-state probe so the Stop hook re-probes at most once per its
 * throttle window instead of on every turn. Best effort — a failed bump only
 * means the next turn probes again. */
export function touchReviewRoundSidecar(file) {
  try {
    const now = new Date();
    utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

// One PR-number override, optionally qualified by a GitHub.com repository.
const OVERRIDE_RE = /^(?:([^#:\s]+)#)?(\d{1,10}):(\d{1,3})$/;

/** D5 polarity (locked, MUST NOT change): missing / malformed / PR#-mismatch
 * all fail closed (`authorized: false`). A syntactically valid override only
 * authorizes when `override_max > roundCount` (`<= roundCount` is treated as
 * unauthorized, per D5's "收緊方向" fourth clause). */
export function parseReviewRoundOverride(envValue, { prNumber, repositorySlug = "", roundCount } = {}) {
  const raw = envValue === undefined || envValue === null ? "" : String(envValue).trim();
  if (raw === "") {
    return { authorized: false, reason: "missing" };
  }
  const match = OVERRIDE_RE.exec(raw);
  const repository = repoName(repositorySlug);
  const overrideRepo = repoName(match?.[1]);
  if (!match || (match[1] && !overrideRepo) || (repositorySlug && !repository)) {
    return { authorized: false, reason: "malformed" };
  }
  const overridePr = match[2];
  const overrideMax = Number(match[3]);
  if (String(prNumber ?? "") !== overridePr) {
    return {
      authorized: false,
      reason: "pr_mismatch",
      override_pr: overridePr,
      override_max: overrideMax,
    };
  }
  if (overrideRepo && overrideRepo !== repository) {
    return { authorized: false, reason: "repo_mismatch", override_pr: overridePr, override_max: overrideMax };
  }
  if (!(overrideMax > roundCount)) {
    return {
      authorized: false,
      reason: "not_greater_than_round_count",
      override_pr: overridePr,
      override_max: overrideMax,
    };
  }
  return {
    authorized: true,
    reason: "authorized",
    override_pr: overridePr,
    override_max: overrideMax,
    ...(overrideRepo ? { override_repo: overrideRepo } : {}),
  };
}

function budgetExhaustedError(prNumber, roundCount, repository) {
  const scopedHint = repository
    ? ` Target repository is ${repository}. To limit the authorization to this repository, use DEVPRO_REVIEW_ROUND_OVERRIDE=${repository}#${prNumber}:<n>.`
    : "";
  const error = new Error(
    `pr-sticky lane round budget (cap ${PR_STICKY_REVIEW_ROUND_CAP}) exhausted for PR #${prNumber} `
    + `(round_count=${roundCount}). Extend only with named user authorization: `
    + `DEVPRO_REVIEW_ROUND_OVERRIDE=${prNumber}:<n> where n > ${roundCount}. This cap belongs to the `
    + "pr-sticky lane and MUST NOT be merged with the audit-only lane cap (6) or the harness write-block cap (3)."
    + scopedHint
  );
  error.classification = "review_round_budget_exhausted";
  return error;
}

/** CHECK ONLY (no write): fail closed (throw, `review_round_budget_exhausted`,
 * zero durable write) when a counting attempt would exceed the cap without a
 * valid override; otherwise returns the pre-record snapshot a caller needs
 * both to decide "did a prior round already exist" and to carry the SAME
 * override determination forward into a later `recordReviewRoundDispatch`
 * call, rather than re-deriving it (env could theoretically differ between a
 * check and a later record in the same process, so the check's own result is
 * the one that authorized the caller and MUST be the one recorded).
 *
 * Split out from `assertReviewRoundBudget` so a caller whose dispatch has
 * multiple non-trivial steps between "is this round allowed" and "this round
 * actually happened" (e.g. render-second-review-packet.mjs's publication
 * transaction) can check at the cheapest possible point and record only once
 * the dispatch is truly committed — see `recordReviewRoundDispatch`'s doc
 * comment for why recording earlier than that over-counts on a validation
 * failure. */
/** F-6e2b84fa17d9 (documented tradeoff): this pre-check reads sidecar state
 * outside the CAS lock on purpose — early fail-closed before packet work.
 * `recordReviewRoundDispatch` re-validates `round_count` under the lock and
 * is the authority that closes the TOCTOU; a concurrent winner may exhaust
 * the cap between evaluate and record, in which case record throws
 * `review_round_budget_exhausted`. Do not "fix" evaluate by taking the lock
 * here unless the caller contract also moves packet work inside that hold. */
export function evaluateReviewRoundBudget({
  cwd = process.cwd(),
  prNumber,
  repositorySlug = "",
  attempt,
  env = process.env,
  pageWindowHandoff = null,
  headRefOid = "",
} = {}) {
  const priorState = readReviewRoundState({ cwd, prNumber, repositorySlug });
  const resolved = resolveReviewRoundAttemptKind({
    declaredAttempt: attempt,
    pageWindowHandoff: pageWindowHandoff
      ?? (attempt === PAGE_WINDOW_CONTINUE_ATTEMPT
        ? {
          page_window_checkpoint_handoff: false,
          head_ref_oid: headRefOid,
          window_index: 0,
        }
        : null),
    priorState,
  });
  const isCountingAttempt = resolved.counting;
  let override = null;
  if (isCountingAttempt && priorState.round_count >= PR_STICKY_REVIEW_ROUND_CAP) {
    const parsed = parseReviewRoundOverride(env?.DEVPRO_REVIEW_ROUND_OVERRIDE, {
      prNumber,
      repositorySlug,
      roundCount: priorState.round_count,
    });
    if (!parsed.authorized) {
      throw budgetExhaustedError(prNumber, priorState.round_count, repoName(repositorySlug));
    }
    override = {
      override_pr: parsed.override_pr,
      override_max: parsed.override_max,
      observed_round_count: priorState.round_count,
      ...(parsed.override_repo ? { override_repo: parsed.override_repo } : {}),
    };
  }
  return {
    prior_round_count: priorState.round_count,
    prior_dispatch_lineage_length: priorState.dispatch_lineage.length,
    had_prior_dispatch: priorState.dispatch_lineage.length > 0,
    override,
    resolved_attempt: resolved,
  };
}

/** Combined check-then-record (D6 `assertReviewRoundBudget`): fail closed
 * (throw, `review_round_budget_exhausted`, zero durable write) when a
 * counting attempt would exceed the cap without a valid override; otherwise
 * records this dispatch (N4 "先記後派" — the sidecar write happens before
 * the caller does anything a crash could leave half-done) and returns the
 * pre-record snapshot plus the post-record state so a caller can derive
 * "did a prior round already exist" without re-reading (reading
 * `dispatch_lineage` AFTER this call's own record would always be
 * non-empty and give the wrong answer for round-1 checks).
 *
 * Callers that need to check early and record later (e.g. to avoid burning a
 * round on a subsequent validation failure) MUST use `evaluateReviewRoundBudget`
 * + `recordReviewRoundDispatch` separately instead of this combined helper. */
export function assertReviewRoundBudget({
  cwd = process.cwd(),
  prNumber,
  repositorySlug = "",
  attempt,
  dispatchId = "",
  headRefOid = "",
  reviewScope = "",
  env = process.env,
  pageWindowHandoff = null,
} = {}) {
  const evaluation = evaluateReviewRoundBudget({
    cwd,
    prNumber,
    repositorySlug,
    attempt,
    env,
    pageWindowHandoff,
    headRefOid,
  });
  const recorded = recordReviewRoundDispatch({
    cwd,
    prNumber,
    repositorySlug,
    attempt,
    dispatchId,
    headRefOid,
    reviewScope,
    override: evaluation.override,
    pageWindowHandoff,
  });
  return {
    prior_round_count: evaluation.prior_round_count,
    prior_dispatch_lineage_length: evaluation.prior_dispatch_lineage_length,
    had_prior_dispatch: evaluation.had_prior_dispatch,
    round_count: recorded.round_count,
    dispatch_lineage: recorded.dispatch_lineage,
    override: evaluation.override,
    resolved_attempt: evaluation.resolved_attempt,
  };
}
