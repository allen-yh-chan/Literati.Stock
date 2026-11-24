/**
 * release-back-merge-state.mjs
 *
 * Shared state and pure helpers for the release back-merge completion gate
 * (openspec change enforce-release-back-merge-completion, design D2/D3/D4/D6):
 *
 *   pre-push (hooks-git/pre-push.mjs)  -> recordProductionTagPush()  writes a ledger entry
 *   PostToolUse (post-tool-gate.mjs)   -> bindReleaseBackMergeLedger() claims it into a pending record
 *   Stop (release-back-merge-check.mjs)-> reads / rewrites pending records, appends trace lines
 *
 * State directory (worktree-shared, local, gitignored):
 *   <main-checkout-root>/notes/tmp/state/devpro-release-back-merge/
 * Tests override it with DEVPRO_RELEASE_BACK_MERGE_STATE_DIR.
 *
 *   pushed-<ms>-<rand8>.json                 pre-push ledger (unclaimed)
 *   claimed-<key>-<pushed-name>              ledger being claimed (rename = atomic claim)
 *   pending-<key>-<ms>-<rand8>.json          per-conversation pending record
 *   repos-<key>.json                         session link: other repos (main checkout roots) this
 *                                            conversation pushed from, written in the state dir of
 *                                            the repo where the conversation runs
 *   trace.jsonl                              append-only audit trail (session id stored hashed)
 *
 * Nothing here reads exit_code or push output, and no candidate tag ever comes
 * from command text: the only source of a candidate is the pre-push ref list.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defaultRepoStateDir, resolveMainCheckoutRoot } from "./repo-state-identity.mjs";
import { lastAssistantMessageText } from "./transcript-message.mjs";
import { isValidProductionTag } from "./tag-shapes.mjs";
import { resolveRigorLevel } from "./rigor-level.mjs";
import { currentPostPrCompletionSessionId } from "./post-pr-completion-state.mjs";
import { segmentCommand, isMatchInCommandSegment, GIT_GLOBAL_OPT, LOOSE_CMD_PREFIX } from "./shell-context.mjs";
import { hasNumberedOptions, hasOpenLastOption } from "./stop-point-handoff-shape-gate.mjs";

export const STATE_DIR_ENV = "DEVPRO_RELEASE_BACK_MERGE_STATE_DIR";
export const LEDGER_SCHEMA = "devpro-release-back-merge-push/v1";
export const PENDING_SCHEMA = "devpro-release-back-merge-pending/v1";
export const LINK_SCHEMA = "devpro-release-back-merge-repos/v1";

export const CLAIM_WINDOW_MS = 10 * 60_000;
export const LEDGER_TTL_MS = 24 * 60 * 60_000;
export const PENDING_TTL_MS = 14 * 24 * 60 * 60_000;
// Same value as post-pr-completion HARD_BLOCK_DEDUP_MS (number only, no shared code).
export const BLOCK_WINDOW_MS = 30 * 60_000;
export const MAX_BLOCKS_PER_WINDOW = 2;
export const REMINDER_INTERVAL_MS = 30 * 60_000;
export const TRACE_MAX_BYTES = 256 * 1024;
export const DEFERRED_SUMMARY_MAX = 200;
const ZERO_SHA_RE = /^0+$/;

// ── paths and names ────────────────────────────────────────────────────────

export function releaseBackMergeStateDir(cwd = process.cwd()) {
  return process.env[STATE_DIR_ENV] || defaultRepoStateDir("devpro-release-back-merge", cwd);
}

export function sessionKey(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);
}

function uniqueSuffix() {
  return `${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function jsonFileNames(dir, prefix) {
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
}

const iso = (ms) => new Date(ms).toISOString();

function ageMs(value, now) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? now - parsed : null;
}

// ── trace ──────────────────────────────────────────────────────────────────

/**
 * Append one audit line; trim to the latter half when the file passes
 * TRACE_MAX_BYTES. Never throws: the trace must not break a gate.
 */
export function appendTrace(dir, { sessionId, event, reason, tags = [], detail } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "trace.jsonl");
    const line = {
      ts: iso(Date.now()),
      session_key: sessionId ? sessionKey(sessionId) : "",
      event,
      reason,
      tags,
      ...(detail ? { detail } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    if (statSync(file).size > TRACE_MAX_BYTES) {
      const text = readFileSync(file, "utf8");
      const cut = text.indexOf("\n", Math.floor(text.length / 2));
      writeFileSync(file, cut === -1 ? "" : text.slice(cut + 1));
    }
  } catch {
    // trace failures are swallowed by design
  }
}

// ── pre-push ledger ────────────────────────────────────────────────────────

/** Strip userinfo from a URL-form remote; remote names pass through. */
export function sanitizeRemote(remote) {
  const value = String(remote || "").trim();
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/**
 * Parse pre-push stdin (`<local-ref> <local-sha> <remote-ref> <remote-sha>`;
 * deletion lines use `(delete)` as the first token, same positions) into the
 * production-* tag refs this push creates or updates.
 */
export function productionTagRefsFromPrePushLines(lines) {
  const refs = [];
  for (const line of lines) {
    const parts = String(line).trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [, localSha, remoteRef, remoteSha] = parts;
    if (!remoteRef.startsWith("refs/tags/")) continue;
    if (ZERO_SHA_RE.test(localSha)) continue;
    const tag = remoteRef.slice("refs/tags/".length);
    if (!isValidProductionTag(tag)) continue;
    refs.push({ tag, local_sha: localSha, remote_old_sha: remoteSha });
  }
  return refs;
}

/**
 * Called by pre-push.mjs after it has decided to exit 0. May throw: the caller
 * owns the error boundary and swallows everything.
 */
export function recordProductionTagPush({ lines, remote, cwd = process.cwd() }) {
  if (resolveRigorLevel() === "off") return null;
  const refs = productionTagRefsFromPrePushLines(lines);
  if (refs.length === 0) return null;
  const dir = releaseBackMergeStateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pushed-${uniqueSuffix()}.json`);
  writeJsonAtomic(file, {
    schema: LEDGER_SCHEMA,
    created_at: iso(Date.now()),
    remote: sanitizeRemote(remote),
    refs,
    session_hint: currentPostPrCompletionSessionId(),
  });
  return file;
}

// ── PostToolUse binding ────────────────────────────────────────────────────

/**
 * True when the shell command runs `git push` in a command segment (not inside
 * a quoted string, heredoc body or comment). Used only to decide WHETHER to
 * bind; it never supplies a tag, a remote or a SHA.
 */
export function isGitPushCommand(command) {
  const cmd = String(command || "");
  if (!cmd) return false;
  const re = new RegExp(
    `${LOOSE_CMD_PREFIX}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*push\\b`,
    "g",
  );
  let segs = null;
  try {
    segs = segmentCommand(cmd);
  } catch {
    segs = null;
  }
  for (const match of cmd.matchAll(re)) {
    if (isMatchInCommandSegment(match.index, segs)) return true;
  }
  return false;
}

function usableLedger(entry) {
  return (
    entry &&
    entry.schema === LEDGER_SCHEMA &&
    typeof entry.remote === "string" &&
    Array.isArray(entry.refs) &&
    entry.refs.length > 0
  );
}

/**
 * Claim fresh, unclaimed ledger entries for the conversation whose shell call
 * just ran `git push`, and write (or extend) its pending record. Does not read
 * exit_code or push output. Never throws.
 */
export function bindReleaseBackMergeLedger({ command, payload = {}, cwd = process.cwd(), sessionCwd = "", now = Date.now() }) {
  try {
    if (!isGitPushCommand(command)) return { claimed: 0 };
    const dir = releaseBackMergeStateDir(cwd);
    if (!existsSync(dir)) return { claimed: 0 };

    const sessionId = String(payload.session_id || payload.sessionId || "").trim();
    const fresh = [];
    for (const name of jsonFileNames(dir, "pushed-")) {
      const file = path.join(dir, name);
      let entry;
      try {
        entry = readJsonFile(file);
      } catch {
        appendTrace(dir, { event: "error", reason: "record-unreadable", detail: name });
        continue;
      }
      const age = ageMs(entry?.created_at, now);
      if (!usableLedger(entry) || age === null || age > CLAIM_WINDOW_MS) continue;
      fresh.push({ name, file, entry });
    }
    if (fresh.length === 0) return { claimed: 0 };
    if (!sessionId) {
      appendTrace(dir, { event: "error", reason: "session-unbound", tags: fresh.flatMap((f) => f.entry.refs.map((r) => r.tag)) });
      return { claimed: 0 };
    }

    const callIds = new Set([sessionId, currentPostPrCompletionSessionId()].filter(Boolean));
    const key = sessionKey(sessionId);
    const claimedFiles = [];
    const candidates = [];
    for (const { name, file, entry } of fresh) {
      const hint = String(entry.session_hint || "").trim();
      if (hint && !callIds.has(hint)) continue;
      const claimedFile = path.join(dir, `claimed-${key}-${name}`);
      try {
        renameSync(file, claimedFile);
      } catch {
        continue; // lost the race (ENOENT) or unreadable: skip
      }
      claimedFiles.push(claimedFile);
      for (const ref of entry.refs) {
        candidates.push({ tag: ref.tag, remote: entry.remote, expected_sha: ref.local_sha });
      }
    }
    if (claimedFiles.length === 0) return { claimed: 0 };

    const existing = loadPendingRecords(dir, sessionId).sort((a, b) => a.file.localeCompare(b.file))[0];
    if (existing) {
      const kept = existing.record.candidates.filter(
        (old) => !candidates.some((c) => c.tag === old.tag && c.remote === old.remote),
      );
      existing.record.candidates = [...kept, ...candidates];
      writeJsonAtomic(existing.file, existing.record);
    } else {
      writeJsonAtomic(path.join(dir, `pending-${key}-${uniqueSuffix()}.json`), {
        schema: PENDING_SCHEMA,
        session_id: sessionId,
        recorded_at: iso(now),
        candidates,
        blocks: { count: 0, window_started_at: null, last_blocked_at: null },
        deferred: null,
        reminded_at: null,
      });
    }
    for (const file of claimedFiles) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
    appendTrace(dir, { sessionId, event: "recorded", reason: "recorded", tags: candidates.map((c) => c.tag) });
    if (sessionCwd) linkSessionToRepo({ sessionCwd, repoCwd: cwd, repoDir: dir, sessionId, now });
    return { claimed: claimedFiles.length };
  } catch {
    return { claimed: 0 };
  }
}

// ── session links (conversation started in repo A, push ran in repo B) ──────

function usableLink(link) {
  return (
    link &&
    link.schema === LINK_SCHEMA &&
    typeof link.session_id === "string" &&
    Array.isArray(link.repos)
  );
}

function linkFileFor(dir, sessionId) {
  return path.join(dir, `repos-${sessionKey(sessionId)}.json`);
}

/** The session link of one conversation in `dir`, or null (a broken file is traced, not thrown). */
export function loadSessionLink(dir, sessionId, { traceUnreadable = true } = {}) {
  const file = linkFileFor(dir, sessionId);
  if (!existsSync(file)) return null;
  try {
    const link = readJsonFile(file);
    if (usableLink(link) && link.session_id === sessionId) return { file, link };
  } catch {
    // fall through
  }
  if (traceUnreadable) appendTrace(dir, { sessionId, event: "error", reason: "link-unreadable", detail: path.basename(file) });
  return null;
}

/**
 * When the push ran in another repo than the one the conversation runs in, the
 * Stop gate (which only knows its own cwd) must still find the pending record:
 * write a link in the conversation's own state dir naming the pushed repo.
 * Never throws.
 */
function linkSessionToRepo({ sessionCwd, repoCwd, repoDir, sessionId, now }) {
  try {
    const sessionDir = releaseBackMergeStateDir(sessionCwd);
    if (path.resolve(sessionDir) === path.resolve(repoDir)) return;
    const root = resolveMainCheckoutRoot(repoCwd).mainCheckoutRoot;
    mkdirSync(sessionDir, { recursive: true });
    const existing = loadSessionLink(sessionDir, sessionId);
    const repos = [...new Set([...(existing?.link.repos ?? []), root])];
    writeJsonAtomic(linkFileFor(sessionDir, sessionId), {
      schema: LINK_SCHEMA,
      session_id: sessionId,
      updated_at: iso(now),
      repos,
    });
  } catch {
    // linking is best effort; the pending record itself is already written
  }
}

/** Drop repos from a conversation's link; the file goes away when nothing is left. */
export function removeSessionLinkRepos(dir, sessionId, roots) {
  try {
    const existing = loadSessionLink(dir, sessionId);
    if (!existing) return;
    const repos = existing.link.repos.filter((root) => !roots.includes(root));
    if (repos.length === existing.link.repos.length) return;
    if (repos.length === 0) unlinkSync(existing.file);
    else writeJsonAtomic(existing.file, { ...existing.link, updated_at: iso(Date.now()), repos });
  } catch {
    // best effort
  }
}

// ── pending records (Stop side) ────────────────────────────────────────────

function usablePending(record) {
  return (
    record &&
    record.schema === PENDING_SCHEMA &&
    typeof record.session_id === "string" &&
    Array.isArray(record.candidates)
  );
}

/** Read every readable pending record of one conversation. */
export function loadPendingRecords(dir, sessionId, { activeAt } = {}) {
  const records = [];
  if (!existsSync(dir)) return records;
  for (const name of jsonFileNames(dir, "pending-")) {
    const file = path.join(dir, name);
    try {
      const record = readJsonFile(file);
      if (!usablePending(record) || record.session_id !== sessionId) continue;
      if (activeAt !== undefined) {
        const age = ageMs(record.recorded_at, activeAt) ?? activeAt - statSync(file).mtimeMs;
        if (record.candidates.length === 0 || age > PENDING_TTL_MS) continue;
      }
      records.push({ file, record });
    } catch {
      // unreadable files are reported by garbageCollect, not here
    }
  }
  return records;
}

export function releaseBackMergeStopContext(payload, { crossRepositoryOnly = false } = {}) {
  const sessionId = String(payload.session_id || payload.sessionId || currentPostPrCompletionSessionId() || "").trim();
  const cwd = !crossRepositoryOnly && typeof payload.cwd === "string" && existsSync(payload.cwd) ? payload.cwd : process.cwd();
  return { cwd, sessionId, dir: sessionId ? releaseBackMergeStateDir(cwd) : "" };
}

// An off-level Stop only reads this session's live linked records. The
// ordinary Stop also owns garbage collection and link diagnostics.
export function linkedReleaseBackMergeSources({ dir, sessionId }, { crossRepositoryOnly = false } = {}) {
  if (!sessionId) return [];
  const link = loadSessionLink(dir, sessionId, { traceUnreadable: !crossRepositoryOnly });
  const sources = [];
  const seen = new Set([path.resolve(dir)]);
  const activeAt = crossRepositoryOnly ? Date.now() : undefined;
  for (const root of link?.link.repos ?? []) {
    let linkedDir = "";
    try {
      if (typeof root === "string" && path.isAbsolute(root) && existsSync(path.join(root, ".git"))) {
        linkedDir = releaseBackMergeStateDir(root);
      }
    } catch {
      // Treat unusable paths like missing links and keep checking other repos.
    }
    if (!linkedDir) {
      if (!crossRepositoryOnly) appendTrace(dir, { sessionId, event: "error", reason: "link-unreadable", detail: "linked repo path" });
      continue;
    }
    const key = path.resolve(linkedDir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!crossRepositoryOnly) garbageCollect(linkedDir);
    const records = loadPendingRecords(linkedDir, sessionId, { activeAt });
    if (!crossRepositoryOnly || records.length > 0) sources.push({ dir: linkedDir, cwd: root, root, records });
  }
  return sources;
}

export function savePendingRecord({ file, record }) {
  writeJsonAtomic(file, record);
}

export function deletePendingRecord(file) {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Garbage-collect expired ledger / claimed / pending files (expiry never
 * clears a record a conversation could still be checked against inside its
 * TTL) and report unreadable files in the trace.
 */
export function garbageCollect(dir, now = Date.now()) {
  if (!existsSync(dir)) return;
  const drop = (file, name, ttl, stamp, sessionId, tags) => {
    const age = stamp === undefined ? null : ageMs(stamp, now);
    let effective = age;
    if (effective === null) {
      try {
        effective = now - statSync(file).mtimeMs;
      } catch {
        return;
      }
    }
    if (effective <= ttl) return;
    try {
      unlinkSync(file);
    } catch {
      return;
    }
    appendTrace(dir, { sessionId, event: "expired", reason: "expired", tags, detail: name });
  };
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!name.endsWith(".json")) continue;
    const isLedger = name.startsWith("pushed-") || name.startsWith("claimed-");
    const isPending = name.startsWith("pending-");
    const isLink = name.startsWith("repos-");
    if (!isLedger && !isPending && !isLink) continue;
    let data = null;
    try {
      data = readJsonFile(file);
    } catch {
      data = null;
    }
    const valid = isLedger ? usableLedger(data) : isLink ? usableLink(data) : usablePending(data);
    if (!valid) {
      appendTrace(dir, { event: "error", reason: isLink ? "link-unreadable" : "record-unreadable", detail: name });
      drop(file, name, isLedger ? LEDGER_TTL_MS : PENDING_TTL_MS, undefined, undefined, []);
      continue;
    }
    if (isLink) {
      drop(file, name, PENDING_TTL_MS, data.updated_at, data.session_id, []);
    } else if (isLedger) {
      drop(file, name, LEDGER_TTL_MS, data.created_at, undefined, data.refs.map((r) => r.tag));
    } else {
      drop(file, name, PENDING_TTL_MS, data.recorded_at, data.session_id, data.candidates.map((c) => c.tag));
    }
  }
}

// ── block state (D6) ───────────────────────────────────────────────────────

/** Block counters of one conversation across all its records, inside the 30 minute window. */
export function currentBlockState(records, now = Date.now()) {
  let count = 0;
  let windowStartedAt = null;
  let lastBlockedAt = null;
  for (const { record } of records) {
    const blocks = record.blocks || {};
    const windowAge = ageMs(blocks.window_started_at, now);
    if (windowAge !== null && windowAge < BLOCK_WINDOW_MS) {
      count = Math.max(count, Number(blocks.count) || 0);
      if (windowStartedAt === null || Date.parse(blocks.window_started_at) < Date.parse(windowStartedAt)) {
        windowStartedAt = blocks.window_started_at;
      }
    }
    const lastAge = ageMs(blocks.last_blocked_at, now);
    if (lastAge !== null && lastAge < BLOCK_WINDOW_MS) {
      if (lastBlockedAt === null || Date.parse(blocks.last_blocked_at) > Date.parse(lastBlockedAt)) {
        lastBlockedAt = blocks.last_blocked_at;
      }
    }
  }
  return { count, windowStartedAt, lastBlockedAt };
}

/** Count one hard block on every record (new window when the old one expired). */
export function recordBlockOnRecords(records, now = Date.now()) {
  const state = currentBlockState(records, now);
  const blocks = {
    count: state.count + 1,
    window_started_at: state.windowStartedAt ?? iso(now),
    last_blocked_at: iso(now),
  };
  for (const entry of records) entry.record.blocks = { ...blocks };
  return blocks;
}

/** At most one reminder per conversation per 30 minutes (`reminded_at`). */
export function takeReminder(records, now = Date.now()) {
  const due = records.every(({ record }) => {
    const age = ageMs(record.reminded_at, now);
    return age === null || age >= REMINDER_INTERVAL_MS;
  });
  if (due) for (const entry of records) entry.record.reminded_at = iso(now);
  return due;
}

// ── last assistant message and release signals (D4) ────────────────────────

/**
 * Last assistant message: payload `last_assistant_message` when it is a non-empty
 * string, otherwise the last assistant text of the transcript (shared reader,
 * `transcript-message.mjs`).
 */
export function lastAssistantMessage(payload = {}) {
  const direct = payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;
  const transcript = payload.transcript_path;
  if (typeof transcript !== "string" || !transcript) return "";
  return lastAssistantMessageText(transcript);
}

// `\x60` stands for a backtick: the protected-base census scanner refuses a regex body holding a raw one.
const BACK_MERGE_MENTION_RE = /back[- ]?merge|Step\s*6A|合回\s*\x60?main\x60?/i;

/** Names back-merge, has >= 2 numbered options, and the last option is open-ended. */
export function isQualifiedBackMergeHandoff(text) {
  const message = String(text || "");
  return BACK_MERGE_MENTION_RE.test(message) && hasNumberedOptions(message) && hasOpenLastOption(message);
}

/** `BackMergeDeferredByUser: <summary>` (non-empty, not none/n/a/無), truncated; else null. */
export function extractDeferral(text) {
  const match = /(?:^|\n)[ \t>*\x60-]*BackMergeDeferredByUser:[ \t]*([^\n]*)/.exec(String(text || ""));
  if (!match) return null;
  const value = match[1].trim();
  if (!value || /^(?:none|n\/a|無)$/i.test(value)) return null;
  return value.slice(0, DEFERRED_SUMMARY_MAX);
}
