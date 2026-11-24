import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";
import { resolveReminderSession, ownsReminder } from "./session-reminder.mjs";
import { fsyncDirectory } from "../../lib/durable-fs.mjs";
import { inheritedGitLocation, storedOriginIdentity } from "./git-utils.mjs";
import { prUrlNumber, prUrlRepo, repoName, repoStateToken } from "./repo-key.mjs";

const PREFIX = "pending-post-pr-completion-";
const LINEAGE_CLEAR_OBLIGATION_SCHEMA = "devpro-post-pr-clear-obligation/v1";
const STALE_AFTER_MS = 2 * 60 * 60_000;
const MARKER_LOCK_STALE_AFTER_MS = 30_000;

function sanitizeToken(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

const PR_NUMBER = /^[1-9]\d{0,15}$/;
const KEYED_MARKER = /^pending-post-pr-completion-([a-f0-9]{64})(?:#([1-9]\d{0,15})|@([a-f0-9]{64}))\.json$/;

function markerSelector(prNumber, branch = "") {
  const pr = String(prNumber ?? "");
  if (pr && (!PR_NUMBER.test(pr) || !Number.isSafeInteger(Number(pr)))) throw new Error("post-PR marker: invalid PR number");
  if (!pr && !branch) throw new Error("post-PR marker needs a PR number or branch");
  return { pr, branch: pr ? "" : String(branch) };
}

export function postPrMarkerFilenames({ repo = "", prNumber = "", branch = "" } = {}) {
  const { pr, branch: ref } = markerSelector(prNumber, branch);
  const token = repoStateToken(repo);
  const legacy = `${PREFIX}${sanitizeToken(pr || ref)}.json`;
  if (repo && !token) throw new Error("post-PR marker: the supplied PR must name a github.com repository");
  if (!token) return [legacy];
  const suffix = pr ? `#${pr}` : `@${createHash("sha256").update(ref).digest("hex")}`;
  return [`${PREFIX}${token}${suffix}.json`, legacy];
}

function readMarkerRecord(file, bytes) {
  if (!lstatSync(file).isFile()) throw new Error("post-PR marker must be a regular file");
  return parsePostPrMarkerRecord(file, bytes ?? readFileSync(file, "utf8"));
}

export function parsePostPrMarkerRecord(file, bytes) {
  const data = JSON.parse(bytes);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("post-PR marker must be a JSON object");
  if (data.lineage_clear_obligation !== undefined) assertLineageClearObligation(data, data.lineage_clear_obligation);
  if (data.prNumber && repoName(prUrlRepo(data.url)) && prUrlNumber(data.url) !== String(data.prNumber)) {
    throw new Error("post-PR marker URL does not match its PR number");
  }
  const name = path.basename(file);
  if (/[#@]/.test(name)) {
    const { name: repo } = postPrMarkerRepoName(data, { requireSupported: true });
    if (!repo || !KEYED_MARKER.test(name) || name !== postPrMarkerFilenames({
      repo, prNumber: data.prNumber, branch: data.branch,
    })[0]) throw new Error("post-PR marker filename does not match its repository and selector");
  }
  return data;
}

function withMarkerLocks(files, operation) {
  const locks = [];
  try {
    for (const file of [...new Set(files)].sort()) {
      const lock = acquireMarkerCompareAndSwapLock(file);
      if (!lock) throw Object.assign(new Error(`post-PR marker ${path.basename(file)} is locked; retry after its owner finishes`), { code: "POST_PR_MARKER_LOCKED" });
      locks.push(lock);
    }
    return operation();
  } finally {
    let releaseError;
    for (const lock of locks.reverse()) {
      try { releaseMarkerCompareAndSwapLock(lock); }
      catch (error) { releaseError ??= error; }
    }
    if (releaseError) throw releaseError;
  }
}

function candidatesAt(cwd, repo, selector) {
  const dir = path.resolve(postPrCompletionDir(cwd));
  return postPrMarkerFilenames({ repo, prNumber: selector.pr, branch: selector.branch })
    .map((name) => ({ file: path.join(dir, name), cwd }));
}

function resolveMarkerCandidates(candidates, requester, selector, { mutating = false } = {}) {
  const matches = [];
  for (const { file, cwd } of candidates) {
    let data;
    try { data = readMarkerRecord(file); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`post-PR marker ${path.basename(file)} cannot be read: ${error?.code || error.message}`);
    }
    // In the old layout the same filename could hold PR 42 or the branch named 42.
    if (String(data.prNumber || "") !== selector.pr || (!selector.pr && data.branch !== selector.branch)) continue;
    if (mutating && !requester && postPrMarkerRepoName(data).name) {
      throw new Error(`post-PR marker ${path.basename(file)} names a repository; specify which repository owns this operation`);
    }
    const match = markerBelongs(data, { requester, cwd });
    if (match.belongs === "stop") throw new Error(`post-PR marker ${path.basename(file)} ${match.reason}`);
    if (match.belongs === "same") matches.push({ file, data });
  }
  if (matches.length > 1) throw new Error(`post-PR markers are not unique: ${matches.map(({ file }) => path.basename(file)).join(", ")}`);
  return matches[0];
}

export function defaultPostPrCompletionDir(cwd = process.cwd()) {
  return defaultRepoStateDir("devpro-post-pr-completion", cwd);
}

export function postPrCompletionDir(cwd = process.cwd()) {
  return process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR || defaultPostPrCompletionDir(cwd);
}

export function currentPostPrCompletionSessionId() {
  return (
    process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.CLAUDE_CONVERSATION_ID ||
    ""
  ).trim();
}

export function extractPrNumberFromCreateOutput(output) {
  const text = String(output || "");
  const urlMatch = text.match(/\/pull\/(\d+)\b/);
  if (urlMatch) return urlMatch[1];
  const hashMatch = text.match(/(?:^|\s)#(\d+)\b/);
  return hashMatch ? hashMatch[1] : "";
}

export function writePostPrCompletionMarker({
  cwd = process.cwd(),
  // The PR's local checkout when it is not cwd (a declared DEVPRO_PR_CHECKOUT); cwd still picks the state dir.
  worktree = "",
  prNumber = "",
  branch = "",
  url = "",
  sessionId = currentPostPrCompletionSessionId(),
  session = sessionId ? resolveReminderSession({ session_id: sessionId }) : null,
  headRefName = branch,
  repositorySlug = "",
  headRefOid = "",
  expectedDispatchId = "",
  // Optional evaluator metadata is omitted for ordinary runner markers.
  executorKind,
} = {}) {
  const selector = markerSelector(prNumber, branch || headRefName);
  const urlRepo = url && repoName(prUrlRepo(url));
  const slugRepo = repositorySlug && repoName(repositorySlug);
  if ((url && !urlRepo) || (repositorySlug && !slugRepo)) {
    throw new Error("post-PR marker: the supplied PR must name a github.com repository");
  }
  if (urlRepo && slugRepo && urlRepo !== slugRepo) throw new Error("post-PR marker names conflicting repositories");
  if (url && prUrlNumber(url) !== selector.pr) {
    throw new Error("post-PR marker URL does not match its PR number");
  }
  const checkoutRepo = worktree ? ownRepoName(worktree) : "";
  const repo = urlRepo || slugRepo || checkoutRepo || ownRepoName(cwd);
  const dir = path.resolve(postPrCompletionDir(cwd));
  mkdirSync(dir, { recursive: true });
  const candidates = candidatesAt(cwd, repo, selector);
  const file = candidates[0].file;
  if (checkoutRepo && checkoutRepo === repo) {
    const legacyDir = path.resolve(postPrCompletionDir(worktree));
    if (legacyDir !== dir && existsSync(legacyDir)) candidates.push(...candidatesAt(worktree, repo, selector));
  }
  const body = {
    prNumber: selector.pr,
    branch: branch || headRefName || "",
    headRefName: headRefName || branch || "",
    url: url || "",
    sessionId: session?.sessionId || "",
    ...(session ? { sessionKey: session.key, host: session.host } : {}),
    worktree: path.resolve(worktree || cwd),
    authorityId: randomUUID(),
    createdAt: new Date().toISOString(),
    remindedAt: "",
    ...(repo ? { repo } : {}),
    repository_slug: repositorySlug || "",
    head_ref_oid: headRefOid || "",
    expected_dispatch_id: expectedDispatchId || "",
    ...(executorKind === undefined ? {} : { executor_kind: executorKind }),
  };
  return withMarkerLocks(candidates.map(({ file }) => file), () => {
    const prior = resolveMarkerCandidates(candidates, repo, selector, { mutating: true });
    if (prior) {
      if (prior.file === file) {
        if (session) writePostPrSubscription(file, session, prior.data);
      } else {
        movePostPrMarker(prior, file, repo, session);
      }
      return file;
    }
    // A subscription without a published authority cannot be adopted. Publish the authority only after
    // its initial subscription is durable, so a failed subscription cannot create ownerless PR state.
    if (session) writePostPrSubscription(file, session, body);
    publishPostPrCompletionMarker(file, body);
    return file;
  });
}

function publishPostPrCompletionMarker(file, body) {
  const candidate = `${file}.${randomUUID()}.create-candidate`;
  let fd;
  try {
    fd = openSync(candidate, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(body, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Linking a fully flushed candidate publishes atomically and exclusively:
    // competing writers never observe a partial authority or overwrite CAS.
    linkSync(candidate, file);
    fsyncContainingDirectory(file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(candidate)) unlinkDurably(candidate);
  }
}

export function listPostPrCompletionMarkers(cwd = process.cwd(), now = Date.now(), { pruneStale = true } = {}) {
  const dir = postPrCompletionDir(cwd);
  if (!existsSync(dir)) return [];
  const markers = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(PREFIX) || !file.endsWith(".json")) continue;
    const abs = path.join(dir, file);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      // A matching marker that cannot be inspected is not evidence of absence.
      // Keep it as an unbound marker so the post-PR gate and cleanup owner both
      // fail closed for this run. A later run can observe that it disappeared.
      markers.push({ file: abs, mtimeMs: now, marker_unreadable: true });
      continue;
    }
    try {
      const data = readMarkerRecord(abs);
      const obligation = data.lineage_clear_obligation;
      if (pruneStale && now - stat.mtimeMs > STALE_AFTER_MS && !data.expected_dispatch_id && !obligation) {
        try {
          if (retireExpiredPostPrAuthority(abs, data, now)) continue;
        } catch (error) {
          if (error?.code !== "ENOENT") {
            markers.push({ file: abs, mtimeMs: stat.mtimeMs, marker_unreadable: true });
          }
          continue;
        }
      }
      markers.push({
        ...data,
        ...(obligation && !data.expected_dispatch_id ? { expected_dispatch_id: obligation.current_dispatch_id } : {}),
        file: abs,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Corrupt, truncated, or unreadable marker content must protect all
      // mature control evidence as an unbound marker until repaired/removed.
      markers.push({ file: abs, mtimeMs: stat.mtimeMs, marker_unreadable: true });
      continue;
    }
  }
  return markers;
}

function assertLineageClearObligation(marker, obligation) {
  if (!obligation || typeof obligation !== "object" || Array.isArray(obligation)
    || obligation.schema !== LINEAGE_CLEAR_OBLIGATION_SCHEMA
    || obligation.repository_slug !== marker.repository_slug
    || obligation.pr_number !== String(marker.prNumber || "")
    || obligation.obligation_head_ref_oid !== marker.head_ref_oid
    || (marker.expected_dispatch_id && marker.expected_dispatch_id !== obligation.current_dispatch_id)
    || !/^[a-f0-9]{40}$/i.test(String(obligation.obligation_head_ref_oid || ""))
    || !/^dispatch-[0-9a-f-]{36}$/i.test(String(obligation.current_dispatch_id || ""))
    || !/^dispatch-[0-9a-f-]{36}$/i.test(String(obligation.old_dispatch_id || ""))
    || !/^dispatch-[0-9a-f-]{36}$/i.test(String(obligation.first_dispatch_id || ""))
    || !Array.isArray(obligation.approval_receipt_ids)
    || obligation.approval_receipt_ids.length === 0
    || obligation.approval_receipt_ids.some((id) => !/^[1-9][0-9]*$/.test(String(id)))
    || !Array.isArray(obligation.attempt_history)
    || typeof obligation.obligation_id !== "string"
    || !obligation.obligation_id
    || Number.isNaN(Date.parse(String(obligation.created_at || "")))) {
    throw new Error("post-PR lineage clear obligation identity is invalid");
  }
  return obligation;
}

function markerCurrentDispatchId(data) {
  if (data.lineage_clear_obligation) {
    return assertLineageClearObligation(data, data.lineage_clear_obligation).current_dispatch_id;
  }
  return data.expected_dispatch_id || "";
}

function markerLockOwnerIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function markerLockContenderPrefix(markerFile) {
  return `${path.basename(markerFile)}.compare-and-swap.lock.`;
}

function listMarkerLockContenders(markerFile) {
  const directory = path.dirname(markerFile);
  const prefix = markerLockContenderPrefix(markerFile);
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(directory, name));
  } catch {
    // An unavailable inventory cannot prove exclusive ownership.
    return null;
  }
}

function fsyncContainingDirectory(targetPath) {
  fsyncDirectory(path.dirname(targetPath));
}

function unlinkDurably(targetPath) {
  unlinkSync(targetPath);
  fsyncContainingDirectory(targetPath);
}

function markerLockContenderBlocks(lockFile, now = Date.now(), recoverStaleContender = null) {
  let stat;
  let record = null;
  try {
    stat = lstatSync(lockFile);
    if (!stat.isFile()) return true;
    try {
      record = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      record = null;
    }
  } catch (error) {
    return error?.code !== "ENOENT";
  }
  if (now - stat.mtimeMs <= MARKER_LOCK_STALE_AFTER_MS) return true;
  if (record && markerLockOwnerIsAlive(record.owner_pid)) return true;

  // A renderer may have reserved immutable dispatch evidence after acquiring
  // this contender and then crashed before publishing the marker update. The
  // next writer must recover that exact transaction before it can remove the
  // dead owner's contender. If recovery cannot prove whether the reservation
  // committed, the contender continues to block all writers.
  let finalizeRecovery = null;
  if (record?.transaction) {
    if (typeof recoverStaleContender !== "function") return true;
    try {
      const recovered = recoverStaleContender(record);
      if (typeof recovered === "function") finalizeRecovery = recovered;
    } catch {
      return true;
    }
  }

  // Each contender path contains a UUID and is never reused by a cooperating
  // writer. Removing this exact stale contender therefore cannot remove a
  // fresh replacement owner at a shared pathname.
  try {
    unlinkDurably(lockFile);
    if (finalizeRecovery) finalizeRecovery();
    return false;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function hasBlockingMarkerLockContender(markerFile, {
  except = "",
  now = Date.now(),
  recoverStaleContender = null,
} = {}) {
  const contenders = listMarkerLockContenders(markerFile);
  if (contenders === null) return true;
  for (const contender of contenders) {
    if (contender === except) continue;
    if (markerLockContenderBlocks(contender, now, recoverStaleContender)) return true;
  }
  return false;
}

function acquireMarkerCompareAndSwapLock(markerFile, {
  transaction = null,
  recoverStaleContender = null,
} = {}) {
  // Pre-create inventory rejects an already-active contender and removes only
  // stale unique contenders. The post-create inventory closes the race where
  // two writers both observed an initially empty contender set.
  if (hasBlockingMarkerLockContender(markerFile, { recoverStaleContender })) return null;

  const ownerToken = randomUUID();
  const lockFile = `${markerFile}.compare-and-swap.lock.${ownerToken}`;
  let fd;
  try {
    fd = openSync(lockFile, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({
      schema: "devpro-post-pr-marker-lock/v1",
      owner_pid: process.pid,
      owner_token: ownerToken,
      created_at: new Date().toISOString(),
      ...(transaction ? { transaction } : {}),
    }));
    fsyncSync(fd);
    fsyncContainingDirectory(lockFile);
  } catch (error) {
    let cleanupError = null;
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
      try { unlinkDurably(lockFile); } catch (candidateCleanupError) {
        cleanupError = candidateCleanupError;
      }
    }
    if (cleanupError) throw cleanupError;
    if (error?.code === "EEXIST") return null;
    throw error;
  }

  const lock = { fd, lockFile, ownerToken };
  if (hasBlockingMarkerLockContender(markerFile, {
    except: lockFile,
    recoverStaleContender,
  })) {
    releaseMarkerCompareAndSwapLock(lock);
    return null;
  }
  return lock;
}

function releaseMarkerCompareAndSwapLock(lock) {
  if (!lock) return;
  try { closeSync(lock.fd); } catch {}
  const record = JSON.parse(readFileSync(lock.lockFile, "utf8"));
  if (record.owner_token !== lock.ownerToken) {
    throw new Error("post-PR marker lock ownership changed before durable release");
  }
  unlinkDurably(lock.lockFile);
}

function markerIdentityMatches(data, {
  repositorySlug,
  prNumber,
  headRefOid,
  expectedDispatchId,
}) {
  return data.repository_slug === repositorySlug
    && String(data.prNumber || "") === String(prNumber || "")
    && data.head_ref_oid === headRefOid
    && markerCurrentDispatchId(data) === expectedDispatchId;
}

// Operator disposition changes evidence, never the marker. Hold the existing
// marker mutex across validation and the lifecycle writer (marker -> capacity).
export async function withPostPrDispatchMarkerSnapshot({ markerFile, ...identity }, operation) {
  const lock = acquireMarkerCompareAndSwapLock(markerFile);
  if (!lock) throw new Error("post-PR marker is locked; preserve it and retry after its owner finishes");
  try {
    const stat = lstatSync(markerFile);
    if (!stat.isFile()) throw new Error("post-PR marker must be a regular file");
    const bytes = readFileSync(markerFile);
    const marker = readMarkerRecord(markerFile, bytes);
    if (!markerIdentityMatches(marker, identity)) throw new Error("post-PR marker dispatch binding changed");
    return await operation({ marker, bytes });
  } finally {
    releaseMarkerCompareAndSwapLock(lock);
  }
}

// Exported so the renderer can pre-filter a binding plan through the exact predicate the
// CAS will apply, instead of restating the conditions and drifting from them.
export function markerIdentityCanAdvance(data, {
  repositorySlug,
  prNumber,
  headRefOid,
  expectedDispatchId,
}) {
  if (String(data.prNumber || "") !== String(prNumber || "")) return false;
  const existingRepo = postPrMarkerRepoName(data);
  if (existingRepo.conflict || (existingRepo.name && existingRepo.name !== namedRepoName(repositorySlug))) return false;
  const currentExpectedDispatchId = markerCurrentDispatchId(data);
  if (currentExpectedDispatchId !== expectedDispatchId) return false;
  if (expectedDispatchId !== "") {
    return data.repository_slug === repositorySlug
      && data.head_ref_oid === headRefOid;
  }
  return ((data.repository_slug || "") === "" || data.repository_slug === repositorySlug)
    && ((data.head_ref_oid || "") === "" || data.head_ref_oid === headRefOid);
}

function replacePostPrCompletionMarkerDurably(markerFile, data) {
  const candidate = `${markerFile}.${process.pid}.${Date.now()}.candidate`;
  const serializedMarker = JSON.stringify(data, null, 2);
  let candidateFd;
  let renamed = false;
  try {
    candidateFd = openSync(candidate, "wx", 0o600);
    writeFileSync(candidateFd, serializedMarker);
    fsyncSync(candidateFd);
    closeSync(candidateFd);
    candidateFd = undefined;

    renameSync(candidate, markerFile);
    renamed = true;

    fsyncContainingDirectory(markerFile);
  } finally {
    if (candidateFd !== undefined) {
      try { closeSync(candidateFd); } catch {}
    }
    if (!renamed && existsSync(candidate)) {
      try { unlinkSync(candidate); } catch {}
    }
  }
}

export async function compareAndSwapPostPrCompletionExpectedDispatch({
  markerFile,
  repositorySlug,
  prNumber,
  headRefOid,
  expectedDispatchId,
  nextDispatchId,
  transaction = null,
  recoverStaleContender = null,
  beforeCommit = null,
  // D6 (add-external-evaluator-second-review T3, R6/F-02): additive. A caller
  // that passes executorKind rebinds `data.executor_kind` to that value; a
  // caller that omits it (the only way every runner caller invokes this)
  // DELETES any existing `data.executor_kind` instead of leaving it in place —
  // otherwise a marker once bound to an external dispatch and then CAS-rebound
  // to a runner dispatch (void + same-head runner reissue) would keep routing
  // through the external disposition resolver forever. `delete` on an absent
  // key is a no-op, so a runner marker that never had the key stays
  // byte-shape-identical.
  executorKind,
}) {
  const lock = acquireMarkerCompareAndSwapLock(markerFile, {
    transaction,
    recoverStaleContender,
  });
  if (!lock) {
    return { status: "conflict", classification: "reviewer_dispatch_identity_collision" };
  }
  try {
    const data = readMarkerRecord(markerFile);
    if (!markerIdentityCanAdvance(data, {
      repositorySlug,
      prNumber,
      headRefOid,
      expectedDispatchId,
    })) {
      return { status: "conflict", classification: "reviewer_dispatch_identity_collision" };
    }
    if (typeof beforeCommit === "function") await beforeCommit({ ...data });
    data.repository_slug = repositorySlug;
    data.head_ref_oid = headRefOid;
    if (data.lineage_clear_obligation) {
      const obligation = assertLineageClearObligation(data, data.lineage_clear_obligation);
      obligation.obligation_head_ref_oid = headRefOid;
      obligation.current_dispatch_id = nextDispatchId;
      obligation.attempt_history.push({ head_ref_oid: headRefOid, dispatch_id: nextDispatchId, transition: "same-head-retry" });
      if (data.expected_dispatch_id) data.expected_dispatch_id = nextDispatchId;
    } else {
      data.expected_dispatch_id = nextDispatchId;
    }
    if (executorKind === undefined) delete data.executor_kind;
    else data.executor_kind = executorKind;
    replacePostPrCompletionMarkerDurably(markerFile, data);
    return { status: "updated", expected_dispatch_id: nextDispatchId };
  } finally {
    releaseMarkerCompareAndSwapLock(lock);
  }
}

export async function compareAndSwapPostPrCompletionHeadBinding({
  markerFile,
  repositorySlug,
  prNumber,
  expectedHeadRefOid,
  expectedDispatchId,
  nextHeadRefOid,
  nextDispatchId,
  lineageApprovalReceiptId,
  lineageApprovalAction,
  lineageClearObligation,
  transaction = null,
  recoverStaleContender = null,
  beforeCommit = null,
  // D6 (add-external-evaluator-second-review T3, R6/F-02): see the analogous
  // parameter on compareAndSwapPostPrCompletionExpectedDispatch above —
  // omitted DELETES any existing `data.executor_kind` (cross-head runner
  // reissue over a formerly-external marker), it does not preserve it.
  executorKind,
}) {
  if (!repositorySlug
    || !prNumber
    || !expectedHeadRefOid
    || !expectedDispatchId
    || !nextHeadRefOid
    || !nextDispatchId
    || expectedHeadRefOid === nextHeadRefOid
    || expectedDispatchId === nextDispatchId) {
    return { status: "conflict", classification: "reviewer_dispatch_identity_collision" };
  }
  const lock = acquireMarkerCompareAndSwapLock(markerFile, {
    transaction,
    recoverStaleContender,
  });
  if (!lock) {
    return { status: "conflict", classification: "reviewer_dispatch_identity_collision" };
  }
  try {
    const data = readMarkerRecord(markerFile);
    if (!markerIdentityMatches(data, {
      repositorySlug,
      prNumber,
      headRefOid: expectedHeadRefOid,
      expectedDispatchId,
    })) {
      return { status: "conflict", classification: "reviewer_dispatch_identity_collision" };
    }
    if (lineageClearObligation !== undefined
      && (!lineageApprovalReceiptId
        || lineageApprovalAction !== "clear"
        || lineageClearObligation.schema !== LINEAGE_CLEAR_OBLIGATION_SCHEMA
        || lineageClearObligation.repository_slug !== repositorySlug
        || String(lineageClearObligation.pr_number) !== String(prNumber)
        || lineageClearObligation.obligation_head_ref_oid !== nextHeadRefOid
        || lineageClearObligation.current_dispatch_id !== nextDispatchId
        || lineageClearObligation.old_dispatch_id !== expectedDispatchId
        || String(lineageClearObligation.approval_receipt_id) !== String(lineageApprovalReceiptId)
        || lineageClearObligation.first_dispatch_id !== nextDispatchId)) {
      return { status: "conflict", classification: "reviewer_dispatch_identity_collision" };
    }
    const existingObligation = data.lineage_clear_obligation
      ? assertLineageClearObligation(data, data.lineage_clear_obligation)
      : null;
    if (typeof beforeCommit === "function") await beforeCommit({ ...data });
    data.head_ref_oid = nextHeadRefOid;
    if (lineageClearObligation !== undefined) {
      data.lineage_clear_obligation = {
        schema: LINEAGE_CLEAR_OBLIGATION_SCHEMA,
        obligation_id: randomUUID(),
        repository_slug: repositorySlug,
        pr_number: String(prNumber),
        obligation_head_ref_oid: nextHeadRefOid,
        current_dispatch_id: nextDispatchId,
        old_dispatch_id: expectedDispatchId,
        approval_receipt_ids: [String(lineageApprovalReceiptId)],
        first_dispatch_id: nextDispatchId,
        created_at: String(lineageClearObligation.created_at || new Date().toISOString()),
        attempt_history: [],
      };
      delete data.expected_dispatch_id;
    } else if (existingObligation) {
      const obligation = existingObligation;
      const hadActiveMarkerBinding = Boolean(data.expected_dispatch_id);
      obligation.obligation_head_ref_oid = nextHeadRefOid;
      obligation.current_dispatch_id = nextDispatchId;
      obligation.attempt_history.push({
        head_ref_oid: nextHeadRefOid,
        dispatch_id: nextDispatchId,
        transition: lineageApprovalAction || "verified-fast-forward",
        ...(lineageApprovalReceiptId === undefined ? {} : { approval_receipt_id: String(lineageApprovalReceiptId) }),
      });
      if (lineageApprovalReceiptId !== undefined
        && !obligation.approval_receipt_ids.includes(String(lineageApprovalReceiptId))) {
        obligation.approval_receipt_ids.push(String(lineageApprovalReceiptId));
      }
      if (lineageApprovalAction === "clear") delete data.expected_dispatch_id;
      else if (lineageApprovalAction === "rebind" || hadActiveMarkerBinding) {
        data.expected_dispatch_id = nextDispatchId;
      } else delete data.expected_dispatch_id;
    } else {
      data.expected_dispatch_id = nextDispatchId;
    }
    if (lineageApprovalReceiptId !== undefined) {
      data.lineage_approval_receipt_id = String(lineageApprovalReceiptId);
    }
    if (executorKind === undefined) delete data.executor_kind;
    else data.executor_kind = executorKind;
    replacePostPrCompletionMarkerDurably(markerFile, data);
    return {
      status: "updated",
      head_ref_oid: nextHeadRefOid,
      expected_dispatch_id: nextDispatchId,
    };
  } finally {
    releaseMarkerCompareAndSwapLock(lock);
  }
}

function subscriptionMatchesAuthority(record, authority) {
  return authority.authorityId
    ? record.authorityId === authority.authorityId
    : !record.authorityId && record.authorityCreatedAt === String(authority.createdAt || "");
}

function retireAuthorityAndSubscriptions(markerFile, authority) {
  const dir = `${markerFile}.sessions`;
  const files = subscriptionNames(dir);
  const retired = `${markerFile}.${randomUUID()}.retired`;
  renameSync(markerFile, retired);
  try { fsyncContainingDirectory(markerFile); }
  catch (error) {
    renameSync(retired, markerFile);
    fsyncContainingDirectory(markerFile);
    throw error;
  }
  // The authority is durably retired. Any leftover sidecars have no authority and cannot be adopted.
  try { unlinkDurably(retired); } catch {}
  // A missing generation is not proof that an arbitrary subscription is ours.
  if (!authority.authorityId && !authority.createdAt) return;
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (record && subscriptionMatchesAuthority(record, authority)) {
      try { unlinkDurably(file); } catch {}
    }
  }
  try { rmdirSync(dir); fsyncContainingDirectory(dir); }
  catch {}
}

function retireExpiredPostPrAuthority(markerFile, observed, now) {
  const lock = acquireMarkerCompareAndSwapLock(markerFile);
  if (!lock) return false;
  try {
    const current = readMarkerRecord(markerFile);
    if (current.authorityId !== observed.authorityId || current.createdAt !== observed.createdAt
        || current.expected_dispatch_id || current.lineage_clear_obligation
        || now - statSync(markerFile).mtimeMs <= STALE_AFTER_MS) return false;
    retireAuthorityAndSubscriptions(markerFile, current);
    return true;
  } finally { releaseMarkerCompareAndSwapLock(lock); }
}

function postPrSubscriptionFile(markerFile, session) {
  return path.join(`${markerFile}.sessions`, `${session.key}.json`);
}

function subscriptionNames(dir) {
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("post-PR subscriptions must be a directory");
    return readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function prepareSubscriptionDirectory(file) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error("post-PR subscriptions must be a directory");
}

function readPostPrSubscription(markerFile, session, { allowUnreadable = false, authority } = {}) {
  if (!markerFile || !session) return null;
  try {
    const record = JSON.parse(readFileSync(postPrSubscriptionFile(markerFile, session), "utf8"));
    if (!ownsReminder(record, session)) return null;
    // A cleared PR authority can be recreated. A stale subscription must never
    // adopt that new obligation or reuse its earlier reminder window.
    if (allowUnreadable) return record;
    return authority && subscriptionMatchesAuthority(record, authority) ? record : null;
  } catch { return null; }
}

function writePostPrSubscription(markerFile, session, marker) {
  const file = postPrSubscriptionFile(markerFile, session);
  prepareSubscriptionDirectory(file);
  if (readPostPrSubscription(markerFile, session, { authority: marker })) return;
  replacePostPrCompletionMarkerDurably(file, {
    sessionKey: session.key, sessionId: session.sessionId, host: session.host,
    prNumber: marker.prNumber || "", authorityCreatedAt: String(marker.createdAt || ""),
    ...(marker.authorityId ? { authorityId: marker.authorityId } : {}),
    createdAt: new Date().toISOString(), remindedAt: "",
  });
}

function movePostPrMarker({ file: source, data }, target, repo, session) {
  const sourceDir = `${source}.sessions`;
  const subscriptions = [];
  for (const name of subscriptionNames(sourceDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(sourceDir, name);
    if (!lstatSync(file).isFile()) throw new Error("post-PR subscription must be a regular file");
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (record && subscriptionMatchesAuthority(record, data)) subscriptions.push({ name, record });
  }
  // Copy subscriptions before the authority moves. After a failed copy, readers still find the
  // original authority and its subscriptions at the source path.
  for (const { name, record } of subscriptions) {
    const destination = path.join(`${target}.sessions`, name);
    prepareSubscriptionDirectory(destination);
    replacePostPrCompletionMarkerDurably(destination, record);
  }
  if (session) writePostPrSubscription(target, session, data);
  if (repo && !postPrMarkerRepoName(data).name) replacePostPrCompletionMarkerDurably(source, { ...data, repo });
  // A single rename changes the authoritative path while both paths are locked.
  renameSync(source, target);
  fsyncContainingDirectory(target);
  if (path.dirname(source) !== path.dirname(target)) fsyncContainingDirectory(source);
  for (const { name } of subscriptions) {
    try { unlinkDurably(path.join(sourceDir, name)); } catch { /* no authority uses this path now */ }
  }
}

export function adoptPostPrCompletionMarker({ cwd = process.cwd(), prNumber = "", session, repo = "" } = {}) {
  if (!session || !prNumber) return false;
  const selector = markerSelector(prNumber);
  const requester = requesterRepoName(repo, repo ? "" : ownRepoName(cwd));
  const candidates = candidatesAt(cwd, requester, selector);
  if (!existsSync(path.dirname(candidates[0].file))) return false;
  try {
    return withMarkerLocks(candidates.map(({ file }) => file), () => {
      const marker = resolveMarkerCandidates(candidates, requester, selector, { mutating: true });
      if (!marker) return false;
      writePostPrSubscription(marker.file, session, marker.data);
      return true;
    });
  } catch (error) {
    if (error?.code === "POST_PR_MARKER_LOCKED") return false;
    throw error;
  }
}

export function ownsPostPrCompletionMarker(marker, session) {
  return ownsReminder(marker, session) || Boolean(readPostPrSubscription(marker?.file, session, { allowUnreadable: marker?.marker_unreadable === true, authority: marker }));
}

export function markPostPrCompletionReminded(markerFile, session = resolveReminderSession()) {
  if (!session) return false;
  const lock = acquireMarkerCompareAndSwapLock(markerFile);
  if (!lock) return false;
  try {
    const marker = { ...readMarkerRecord(markerFile), file: markerFile };
    if (!ownsPostPrCompletionMarker(marker, session)) return false;
    writePostPrSubscription(markerFile, session, marker);
    const record = readPostPrSubscription(markerFile, session, { authority: marker });
    if (!record) return false;
    replacePostPrCompletionMarkerDurably(postPrSubscriptionFile(markerFile, session),
      { ...record, remindedAt: new Date().toISOString() });
    return true;
  } finally { releaseMarkerCompareAndSwapLock(lock); }
}

export function postPrCompletionReminderTimestamp(marker, session = resolveReminderSession()) {
  if (!session) return 0;
  const record = readPostPrSubscription(marker?.file, session, { authority: marker });
  const ts = Date.parse(String(record?.remindedAt || ""));
  return Number.isFinite(ts) ? ts : 0;
}

export function clearPostPrCompletionMarker({
  cwd = process.cwd(),
  prNumber = "",
  branch = "",
  markerFile = "",
  repositorySlug = "",
  headRefOid = "",
  expectedDispatchId = "",
  expectedAuthorityId = "",
  expectedAuthorityCreatedAt = "",
} = {}) {
  if (markerFile) {
    const lock = acquireMarkerCompareAndSwapLock(markerFile);
    if (!lock) return false;
    try {
      const data = readMarkerRecord(markerFile);
      if (expectedAuthorityId && data.authorityId !== expectedAuthorityId) return false;
      if (!expectedAuthorityId && expectedAuthorityCreatedAt && data.createdAt !== expectedAuthorityCreatedAt) return false;
      if (!markerIdentityMatches(data, {
        repositorySlug,
        prNumber,
        headRefOid,
        expectedDispatchId,
      })) {
        return false;
      }
      retireAuthorityAndSubscriptions(markerFile, data);
      return true;
    } catch {
      return false;
    } finally {
      releaseMarkerCompareAndSwapLock(lock);
    }
  }
  if ((!prNumber && !branch) || !existsSync(postPrCompletionDir(cwd))) return false;
  try {
    const repo = requesterRepoName(repositorySlug, repositorySlug ? "" : ownRepoName(cwd));
    const selector = markerSelector(prNumber, branch);
    const choices = [{ selector, candidates: candidatesAt(cwd, repo, selector) }];
    if (selector.pr && branch && (expectedAuthorityId || expectedAuthorityCreatedAt)) {
      const fallback = markerSelector("", branch);
      choices.push({ selector: fallback, candidates: candidatesAt(cwd, repo, fallback) });
    }
    return withMarkerLocks(choices.flatMap(({ candidates }) => candidates.map(({ file }) => file)), () => {
      const generationKey = expectedAuthorityId ? "authorityId" : "createdAt";
      const generation = expectedAuthorityId || expectedAuthorityCreatedAt;
      const selected = choices.map(({ candidates, selector: wanted }) =>
        resolveMarkerCandidates(candidates, repo, wanted, { mutating: true })).filter(Boolean);
      if (generation && selected.some(({ data }) => !data[generationKey])) return false;
      const matches = selected.filter(({ data }) => !generation || data[generationKey] === generation);
      if (matches.length !== 1) return false;
      const [{ file, data }] = matches;
      if (markerCurrentDispatchId(data) || data.lineage_clear_obligation) {
        if (!repositorySlug || !headRefOid || !expectedDispatchId
          || !markerIdentityMatches(data, { repositorySlug, prNumber, headRefOid, expectedDispatchId })) return false;
      }
      retireAuthorityAndSubscriptions(file, data);
      return true;
    });
  } catch { return false; }
}

// ---- Which repository's PR a marker is (fix-post-pr-state-repo-keys) ----
// A hub session merges and reviews PRs of several repositories, which can share a PR number. A legacy marker's
// filename does not carry its repository, so readers derive the repository from its content: `repo`,
// `repository_slug` and its PR `url` (an obligation's slug always equals the marker's, or the listing reads the marker
// as unreadable). The hooks key github.com repositories only (repo-key.mjs),
// so a value that names no github.com repository is not evidence; values that name two repositories are a conflict. A
// marker that names no repository is the repository's of the checkout whose state holds it, as before.
//
// Every reader asks one question of a marker of the PR (markerBelongs): is it the requested repository's? The answer
// is "same", "other" (skip it), or "stop" with a reason: the marker's repositories conflict, or the caller names a
// repository and neither the marker nor the checkout names any, so nothing shows the marker is that repository's. Only
// when neither the caller nor the checkout has a repository identity does the PR number alone decide, as before.

// The checkout's repository, read when it is asked for: a cached value would outlive an origin that changes.
function ownRepoName(cwd) {
  const own = storedOriginIdentity(path.resolve(cwd || process.cwd()));
  return own ? repoName(`${own.host}/${own.slug}`) : "";
}

// The repository key a value names (OWNER/REPO, github.com/OWNER/REPO or a PR URL), or "".
function namedRepoName(value) {
  const text = String(value ?? "").trim();
  return text ? repoName(prUrlRepo(text) || text) : "";
}

// The repository a marker's content names: { name } ("" when it names none) or { conflict: true }.
export function postPrMarkerRepoName(data, { requireSupported = false } = {}) {
  const fields = [data?.repo, data?.repository_slug, data?.url].filter(Boolean);
  const keys = fields.map(namedRepoName);
  const names = new Set(keys.filter(Boolean));
  if (names.size > 1) return { conflict: true };
  if (requireSupported && (keys.includes("") || (data?.url && !repoName(prUrlRepo(data.url))))) {
    return { unsupported: true };
  }
  return { name: [...names][0] || "" };
}

export function postPrMarkerCheckout(marker) {
  // An exemption's history probes inherit Git's location variables.
  if (inheritedGitLocation()) return "";
  const cwd = marker?.worktree;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return "";
  const { name } = postPrMarkerRepoName(marker);
  return name && name === ownRepoName(cwd) ? cwd : "";
}

export function listOwnedPostPrStopMarkers(cwd, session, { crossRepositoryOnly = false } = {}) {
  if (!session) return [];
  const markers = listPostPrCompletionMarkers(cwd, Date.now(), { pruneStale: false })
    .filter((marker) => ownsPostPrCompletionMarker(marker, session));
  if (!crossRepositoryOnly || markers.length === 0) return markers;
  const own = ownRepoName(cwd);
  if (!own) return [];
  return markers.filter((marker) => {
    const { name } = postPrMarkerRepoName(marker);
    return name && name !== own;
  });
}

// The repository a caller asks for: `repo` (OWNER/REPO, github.com/OWNER/REPO or a PR URL), else `own`, the
// checkout's. A `repo` that names no repository throws, so a mistyped repository never matches every repository. The
// message never repeats the value, which may be a URL that carries credentials.
function requesterRepoName(repo, own) {
  const explicit = String(repo ?? "").trim();
  if (!explicit) return own;
  const name = namedRepoName(explicit);
  if (!name) throw new Error("post-PR state: the repository given names no github.com repository (OWNER/REPO, github.com/OWNER/REPO or a PR URL)");
  return name;
}

function markerBelongs(data, { requester, own, cwd }) {
  const marker = postPrMarkerRepoName(data);
  if (marker.conflict) return { belongs: "stop", reason: "names conflicting repositories" };
  if (!requester) return { belongs: "same" };
  const name = marker.name || own || (cwd ? ownRepoName(cwd) : "");
  if (!name) return { belongs: "stop", reason: "names no repository, so it cannot be shown to be the requested repository's" };
  return { belongs: name === requester ? "same" : "other" };
}

// The requested repository's markers of PR `prNumber` among `markers`, one listing of the state directory. It throws,
// naming the file, on a marker markerBelongs stops on, on two markers of the PR, and on a file named for the PR that
// cannot be read. The checkout's origin is read once per call.
function markersOfPrIn(markers, { own, requester, prNumber }) {
  const pr = String(prNumber ?? "");
  const same = [];
  for (const marker of markers) {
    const name = path.basename(marker.file);
    if (marker.marker_unreadable) {
      if (name === `${PREFIX}${sanitizeToken(pr)}.json`) throw new Error(`post-PR marker ${name} cannot be read`);
      continue;
    }
    if (String(marker.prNumber || "") !== pr) continue;
    const { belongs, reason } = markerBelongs(marker, { requester, own });
    if (belongs === "stop") throw new Error(`post-PR marker ${name} ${reason}`);
    if (belongs === "same") same.push(marker);
  }
  if (same.length > 1) {
    throw new Error(`post-PR markers of PR #${pr} are not unique: ${same.map((marker) => path.basename(marker.file)).join(", ")}`);
  }
  return same;
}

// Read only the keyed and legacy candidates for this repository and PR.
export function postPrMarkersOfPr({ cwd = process.cwd(), prNumber = "", repo = "" } = {}) {
  const requester = requesterRepoName(repo, repo ? "" : ownRepoName(cwd));
  const selector = markerSelector(prNumber);
  const marker = resolveMarkerCandidates(candidatesAt(cwd, requester, selector), requester, selector);
  if (!marker) return [];
  const { file, data } = marker;
  return [{
    ...data,
    ...(data.lineage_clear_obligation && !data.expected_dispatch_id
      ? { expected_dispatch_id: data.lineage_clear_obligation.current_dispatch_id } : {}),
    file,
  }];
}

// Inspect one inventory without pruning. An unreadable marker for the requested key or
// an unreadable legacy name blocks the merge. Ambiguous ownership or duplicate authorities
// also block it, even when no obligation can be read.
export function postPrMergeObligation({ cwd = process.cwd(), prNumber = "", repo = "", listMarkers = listPostPrCompletionMarkers } = {}) {
  const pr = String(prNumber ?? "");
  let mine;
  try {
    const markers = listMarkers(cwd, Date.now(), { pruneStale: false });
    const own = ownRepoName(cwd);
    const requester = requesterRepoName(repo, own);
    const candidates = pr ? postPrMarkerFilenames({ repo: requester, prNumber: pr }) : [];
    const unreadable = markers.filter((marker) => {
      if (!marker.marker_unreadable) return false;
      const name = path.basename(marker.file);
      return !requester || !KEYED_MARKER.test(name) || candidates.includes(name);
    }).map((marker) => path.basename(marker.file));
    if (unreadable.length > 0) {
      return {
        reason: `本地 post-PR state 含 unreadable marker，無法證明 PR #${pr} 沒有未解除的 lineage obligation；merge fail-closed，需 named human decision owner Ask First。（讀不到的 marker：${unreadable.join("、")}）`,
      };
    }
    mine = markersOfPrIn(markers, { own, requester, prNumber: pr });
  } catch (error) {
    return {
      reason: `PR #${pr} 的本地 post-PR state 無法判定（${error?.message || "unknown error"}），merge fail-closed。請停止 automation，由 named human decision owner Ask First 核對。`,
    };
  }
  const obligation = mine.find((marker) => marker.lineage_clear_obligation)?.lineage_clear_obligation;
  if (!obligation) return null;
  return {
    reason: `PR #${pr} 仍有未解除的 durable clear obligation ${obligation.obligation_id}（receipt ${obligation.approval_receipt_ids.join(",")}）。只有 post-PR gate 驗證 exact current-head dispatch/sticky 與既有完成條件後才可解除；需停止 automation 並由 named human decision owner Ask First 處理未能判讀的狀態。`,
  };
}
