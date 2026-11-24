/**
 * Session Recap helpers. Evaluators read only stable-session recap-work.json:
 * successful own commits/PR events or explicit adoption establish obligations.
 * Legacy shared marker primitives remain API-compatible, but never participate
 * in scoped reminder evaluation. Shared recap-written facts are local reads.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveReminderSession, ownsReminder, reminderSessionDir, compactReminder } from "./session-reminder.mjs";
import { isProtectedBaseBranch } from "./branch-naming.mjs";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";
import { prUrlNumber, prUrlRepo, repoName } from "./repo-key.mjs";

// Per-session prompt dedup lifetime.
const MARKER_TTL_MS = 30 * 60_000;

function defaultRecapPendingDir() {
  // Base: <main-checkout-root>/notes/tmp/state/devpro-recap-pending.
  // Fixes latent bug: the old path used process.cwd() hash, causing linked
  // worktrees of the same repo to get different pending dirs.
  return defaultRepoStateDir("devpro-recap-pending");
}

export const RECAP_PENDING_DIR =
  process.env.DEVPRO_RECAP_PENDING_DIR || defaultRecapPendingDir();
export const RECAP_DIAGNOSTIC_LOG_BASENAME = ".log";
// Marker 1-day TTL：超過視為 stale（branch 多半已忘了 / 不需要再 Recap）。
const RECAP_PENDING_TTL_MS = 24 * 60 * 60_000;
export const RECAP_IN_PROGRESS_DIR =
  process.env.DEVPRO_RECAP_IN_PROGRESS_DIR ||
  defaultRepoStateDir("devpro-recap-in-progress");
// In-progress is a lease: suppress duplicate reminders during one Recap write
// attempt, then resume pending behavior if no Discussion appears.
const RECAP_IN_PROGRESS_TTL_MS = 30 * 60_000;
// Shared permanent Discussion fact; written only after confirmed tool success.
export const RECAP_WRITTEN_DIR =
  process.env.DEVPRO_RECAP_WRITTEN_DIR ||
  defaultRepoStateDir("devpro-recap-written");

export function isWorkBranch(branch) {
  if (!branch) return false;
  if (isProtectedBaseBranch(branch)) return false;
  if (/^release\//.test(branch)) return false;
  if (/^chore\/(bump-v|docs-)/.test(branch)) return false;
  return /^(feature|bugfix|hotfix|chore)\//.test(branch);
}

export function getChangeName(branch) {
  return branch.replace(/^[a-z]+\//, "");
}

/**
 * Local, zero-network Recap-existence check: does a `recap-written` marker
 * exist for any work branch matching `changeName`?
 *
 * Replaces the former GraphQL discussion-pagination scan (F6/F7 #471/#472),
 * which walked up to 20 pages of `discussions(first:100)` over the network —
 * on a repo with hundreds of Recap Discussions this blew past the
 * UserPromptSubmit hook's 30s timeout, causing the hook's output (and any
 * marker bookkeeping it would have done) to be dropped.
 *
 * Per design-core §8 Hook Runtime Cost Boundary: this is a *reminder* hook
 * path (not a gate), so an approximate local signal is preferable to a
 * precise but unbounded network scan — worst case is one redundant reminder.
 *
 * Fail-open: marker dir missing / readdirSync throws / no match → false
 * (never throws).
 *
 * @param {string} changeName
 * @param {{ prNumber?: string|number|null, repo?: string }} [options]
 * @returns {boolean}
 */
export function checkDiscussionExists(changeName, { prNumber = null, repo = '' } = {}) {
  if (!changeName) return false;
  if (repo) {
    const key = repoName(repo);
    if (!key || !validRecapPr(prNumber)) return false;
    try {
      return statSync(scopedRecapWrittenPath(changeName, key, prNumber)).isFile();
    } catch { return false; }
  }
  if (!existsSync(RECAP_WRITTEN_DIR)) return false;
  let entries;
  try {
    entries = readdirSync(RECAP_WRITTEN_DIR).filter((name) => name !== '.by-pr');
  } catch {
    return false; // fail-open
  }
  if (entries.length === 0) return false;
  const wantPr = prNumber == null || prNumber === "" ? null : String(prNumber);
  for (const marker of entries) {
    const parsed = parseRecapWrittenMarker(marker);
    if (!parsed || !markerMatchesChange(parsed, changeName)) continue;
    if (wantPr == null) {
      // Pre-PR path: only legacy change-only markers count. PR-keyed markers
      // belong to a specific PR and must not suppress a different/unknown PR.
      if (parsed.prNumber == null) return true;
      continue;
    }
    if (parsed.prNumber == null) continue; // legacy unknown ≠ same
    if (parsed.prNumber === wantPr) return true;
  }
  return false;
}

function validRecapPr(value) {
  return /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
}

// Names stay bounded and live outside the legacy branch/change namespace.
function scopedRecapWrittenPath(changeName, repo, prNumber) {
  const token = createHash('sha256').update(JSON.stringify([repo, changeName, String(prNumber)])).digest('hex');
  return path.join(RECAP_WRITTEN_DIR, '.by-pr', token);
}

export function recapRepositoryFromPrUrl(url, prNumber) {
  if (!validRecapPr(prNumber) || prUrlNumber(url) !== String(prNumber)) return '';
  return repoName(prUrlRepo(url));
}

// The canonical Branch row selects the PR. Without it, preserve the old
// single-number body fallback, and let a title number guide a pre-tool lease
// when there are no body links. In both hooks, explicit repo evidence must
// resolve to at most one repository for the selected PR.
export function resolveRecapDiscussionIdentity(body, changeName, {titlePr = ''} = {}) {
  const text = String(body ?? '');
  const numbers = [...new Set([...text.matchAll(/\/pull\/([1-9][0-9]*)\b/g)].map((match) => match[1]))];
  const links = [...text.matchAll(/(?:https?:\/\/|(?<![\w.@:/])(?:[a-z0-9-]+\.)+[a-z0-9-]+\/)[^\s<>()\[\]"'`]+/gi)]
    .map(({0: url, index}) => ({url: url.replace(/[.,;:]+$/, ''), number: /\/pull\/(\d+)\b/i.exec(url)?.[1], index}))
    .filter((link) => link.number);
  const heading = /^## Branch[ \t]*\r?$/m.exec(text);
  const primary = heading ? text.slice(heading.index + heading[0].length).split(/^##[ \t]+/m, 1)[0] : '';
  const branchRow = primary.match(/^(?:[ \t]*\r?\n)+([^\s(]+)[ \t]+\(PR[ \t]+#([1-9][0-9]*)\b[^\r\n]*\)/);
  const prNumber = heading
    ? (branchRow && getChangeName(branchRow[1]) === changeName ? branchRow[2] : '')
    : (numbers.length === 1 ? numbers[0] : numbers.length === 0 ? titlePr : '');
  if (titlePr && prNumber && titlePr !== prNumber) return {error: 'the title and body select different PR numbers'};
  if (!prNumber) return links.length ? {error: 'cannot verify which PR the Recap describes'} : {prNumber: '', repo: ''};
  if (!validRecapPr(prNumber)) return {error: 'invalid PR number'};
  const inPrimary = ({index}) => heading && index >= heading.index &&
    index < heading.index + heading[0].length + primary.length;
  if (links.some((link) => inPrimary(link) && Number(link.number) !== Number(prNumber))) {
    return {error: 'the Branch section links to a different PR number'};
  }
  const matchingLinks = links.filter((link) => Number(link.number) === Number(prNumber));
  const repositories = new Set(matchingLinks.map(({url}) => recapRepositoryFromPrUrl(url, prNumber)));
  if (repositories.has('')) return {error: 'cannot verify a repository in the selected PR links'};
  if (repositories.size > 1) return {error: 'ambiguous repository for the selected PR'};
  if (heading && repositories.size && !matchingLinks.some(inPrimary)) {
    return {error: 'the repository link for the selected PR is missing from the Branch section'};
  }
  return {prNumber, repo: [...repositories][0] || ''};
}

function recapWrittenMarkerName(changeName, prNumber = null) {
  const base = sanitizeBranch(changeName);
  if (prNumber == null || prNumber === "") return base;
  return `${base}--pr-${String(prNumber)}`;
}

function parseRecapWrittenMarker(marker) {
  if (typeof marker !== "string" || !marker) return null;
  const prSuffix = marker.match(/^(.*)--pr-(\d+)$/);
  if (prSuffix) {
    return {
      key: prSuffix[1],
      branchOrChange: unsanitizeBranch(prSuffix[1]),
      prNumber: prSuffix[2],
    };
  }
  return {
    key: marker,
    branchOrChange: unsanitizeBranch(marker),
    prNumber: null,
  };
}

function markerMatchesChange(parsed, changeName) {
  const identity = parsed.branchOrChange;
  if (identity === changeName) return true;
  if (getChangeName(identity) === changeName) return true;
  if (sanitizeBranch(changeName) === parsed.key) return true;
  return false;
}

/**
 * 主入口：判斷是否該對當前 branch emit Recap 提醒。
 *
 * Returns:
 *   { skip: true, reason } — 不該提醒
 *   { skip: false, branch, changeName } — 該提醒（呼叫者 emit）
 */
// Session-owned obligations are local evidence from successful work, never inferred
// from the current checkout. A stable identity survives resume and branch changes.
function recapWorkPath(cwd, session) {
  const dir = reminderSessionDir(cwd, session);
  return dir ? path.join(dir, 'recap-work.json') : null;
}

const CHANGE_CLASSIFICATIONS = new Set(['A', 'B-mini', 'B']);

function changeClassificationPath(cwd, session, branch) {
  const dir = reminderSessionDir(cwd, session);
  return dir ? path.join(dir, `change-classification-${encodeURIComponent(branch)}.json`) : null;
}

// This producer records a named branch's classification only. It never adopts
// work, creates a Recap obligation, or reads another session's namespace.
export function recordSessionChangeClassification({cwd = process.cwd(), session, branch = '', classification = ''} = {}) {
  if (!session?.sessionId || !session.host || session.host === 'unknown' || !/^chore\/[^\s]+$/.test(branch) || !CHANGE_CLASSIFICATIONS.has(classification)) return false;
  try {
    const file = changeClassificationPath(cwd, session, branch);
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, JSON.stringify({sessionKey: session.key, sessionId: session.sessionId, host: session.host, branch, classification, recordedAt: Date.now()}), 'utf8');
    return true;
  } catch { return false; }
}

function ownChangeClassification(cwd, session, branch) {
  if (!session || !branch) return '';
  try {
    const record = JSON.parse(readFileSync(changeClassificationPath(cwd, session, branch), 'utf8'));
    return ownsReminder(record, session) && record.branch === branch && CHANGE_CLASSIFICATIONS.has(record.classification) ? record.classification : '';
  } catch { return ''; }
}

function isEligibleRecapWork(record) {
  if (!isWorkBranch(record.branch) || record.classification === 'A') return false;
  return !/^chore\//.test(record.branch) || ['B', 'B-mini'].includes(record.classification) || Boolean(record.adopted);
}

function readRecapWork(cwd, session) {
  const file = recapWorkPath(cwd, session);
  if (!file) return [];
  try {
    const records = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(records) ? records.filter((record) => ownsReminder(record, session) && isEligibleRecapWork(record)) : [];
  } catch { return []; }
}

function saveRecapWork(cwd, session, records) {
  const file = recapWorkPath(cwd, session);
  if (!file) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(records), 'utf8');
    return true;
  } catch { return false; }
}

export function recordRecapWork({cwd = process.cwd(), classificationCwd = cwd, branch, session = resolveReminderSession(), commit = '', prNumber = '', repo = '', merged = false, adopted = false, classification = ''} = {}) {
  if (!session || !isWorkBranch(branch) || classification === 'A' || (classification && !CHANGE_CLASSIFICATIONS.has(classification)) || !(commit || prNumber || merged || adopted)) return false;
  const pr = String(prNumber || '');
  const key = repoName(repo);
  if (repo && (!key || (pr ? !validRecapPr(pr) : !commit))) return false;
  const records = readRecapWork(cwd, session);
  const sameBranch = (item) => item.branch === branch && (item.repo || '') === key;
  let record = records.find((item) => sameBranch(item) && item.prNumber === pr);
  // A commit-only obligation stays unscoped until a PR confirms its repository.
  // A named PR may promote it only when the commit had a matching origin.
  if (!record && pr) {
    record = records.find((item) => item.branch === branch && !item.repo && !item.prNumber &&
      (!key || item.commitOrigin === key));
  }
  if (!record && !pr) {
    record = records.findLast(sameBranch);
    if (!record && key) record = records.find((item) => item.branch === branch && !item.repo && !item.prNumber);
  }
  const knownClassification = classification || ownChangeClassification(classificationCwd, session, branch) || record?.classification || '';
  if (!isEligibleRecapWork({branch, classification: knownClassification, adopted: adopted || record?.adopted})) return false;
  if (!record) {
    record = {sessionKey: session.key, sessionId: session.sessionId, host: session.host, branch, changeName: getChangeName(branch), prNumber: pr};
    records.push(record);
  }
  Object.assign(record, {classification: knownClassification, prNumber: pr || record.prNumber, merged: Boolean(merged || record.merged), adopted: Boolean(adopted || record.adopted), commit: commit || record.commit || '', updatedAt: Date.now()});
  if (record.prNumber) {
    if (key) record.repo = key;
    delete record.commitOrigin;
  } else if (key) {
    record.commitOrigin = key;
  } else if (commit) {
    delete record.commitOrigin;
  }
  // New successful work is new evidence; a previous reminder cannot hide it.
  delete record.promptedAt;
  return saveRecapWork(cwd, session, records);
}

export function adoptRecapWork(options = {}) {
  return recordRecapWork({...options, adopted: true});
}

function matchesRecapWork(item, changeName, prNumber, key) {
  return item.changeName === changeName && item.prNumber === String(prNumber || '') && (item.repo || '') === key;
}

export function clearOwnRecapPendingForChange(changeName, {cwd = process.cwd(), session = resolveReminderSession(), prNumber = '', repo = ''} = {}) {
  if (!session || !changeName) return 0;
  const key = repoName(repo);
  if (repo && (!key || !validRecapPr(prNumber))) return 0;
  const records = readRecapWork(cwd, session);
  const remaining = records.filter((item) => !matchesRecapWork(item, changeName, prNumber, key));
  if (remaining.length === records.length) return 0;
  if (!saveRecapWork(cwd, session, remaining)) return 0;
  return records.length - remaining.length;
}

async function evaluateOwnRecap({cwd = process.cwd(), session = resolveReminderSession(), merged = false, consume = true} = {}) {
  if (!session) return {skip: true, reason: 'missing-session-identity', pending: []};
  const records = readRecapWork(cwd, session);
  const remaining = [];
  const pending = [];
  let changed = false;
  for (const record of records) {
    if (checkDiscussionExists(record.changeName, {prNumber: record.prNumber, repo: record.repo})) {
      changed = true;
      continue;
    }
    remaining.push(record);
    if (Boolean(record.merged) !== merged) continue;
    if (Date.now() - (record.inProgressAt || 0) < RECAP_IN_PROGRESS_TTL_MS) continue;
    if (Date.now() - (record.promptedAt || 0) < MARKER_TTL_MS) continue;
    if (consume) { record.promptedAt = Date.now(); changed = true; }
    pending.push({...record});
  }
  if (changed) saveRecapWork(cwd, session, remaining);
  return {skip: pending.length === 0, reason: pending.length ? undefined : 'no-own-pending-work', pending, ...(pending[0] || {})};
}

export async function evaluateRecapState(options = {}) {
  return evaluateOwnRecap({...options, merged: false});
}

export function buildRecapReminder({cwd = process.cwd(), session, pending = []} = {}) {
  if (!session || !pending.length) return '';
  const details = ['Session Recap pending work', ...pending.map((item) => `- ${item.branch} (change ${item.changeName}, ${item.repo ? `${item.repo} ` : ''}PR ${item.prNumber || 'not recorded'}, ${item.merged ? 'merged' : 'work recorded'}, classification ${item.classification || (/^chore\//.test(item.branch) ? 'unconfirmed; explicit adoption' : 'not applicable')})`), '', 'Read .devpro/agent-rules/session-recap.md and devpro:recap-writer. Complete the own-session Recap Discussion or record a concrete blocker and continuation.'].join('\n');
  return compactReminder({cwd, session, kind: 'recap', summary: `本 session 有 ${pending.length} 項工作尚待 Recap。`, action: '讀取 detail 與 session-recap.md，完成 Recap 或記錄 blocker / continuation。', details});
}

function sanitizeBranch(branch) {
  return encodeURIComponent(branch);
}

function legacySanitizeBranch(branch) {
  return branch.replace(/\//g, "_");
}

function markerNamesForBranch(branch) {
  return new Set([sanitizeBranch(branch), legacySanitizeBranch(branch)]);
}

function unsanitizeBranch(sanitized) {
  if (sanitized.includes("%")) {
    try {
      return decodeURIComponent(sanitized);
    } catch {
      // Fall through to legacy best-effort decoding below.
    }
  }
  return sanitized.replace(/_/g, "/");
}

/**
 * Run a binary with argv (no shell) and report success vs failure separately.
 *
 * Unlike runShell/runGit (which swallow any failure into "" and thus cannot
 * tell "succeeded with empty stdout" apart from "the command failed"), this
 * returns `{ ok, out }`:
 *   - ok:true  → process exited 0; `out` is trimmed stdout (may be "")
 *   - ok:false → spawn error, non-zero exit, or 5s timeout; `out` is ""
 *
 * A fixed 5s per-call timeout (design-core §8) bounds the gate-ish marker-GC
 * network probes so a slow/hung `gh` can never hang the calling hook: on
 * timeout execFileSync throws and we fail-open to { ok:false }.
 *
 * argv form means the branch name is passed as a literal argument, so no shell
 * quoting/expansion can occur — `$`, backtick, quotes etc. in a branch name are
 * inert. Callers that need to distinguish "confirmed empty" from "could not
 * determine" (for fail-open decisions) MUST use this, not runShell/runGit.
 *
 * @param {string} file - executable name (e.g. "git", "gh")
 * @param {string[]} args - argument vector
 * @returns {{ ok: boolean, out: string }}
 */
function execFileCapture(file, args) {
  try {
    const out = execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Per design-core §8 Hook Runtime Cost Boundary: the marker-GC callers
      // (isChoreAByPRBody / isConfirmedNonexistentBranch) are gate-ish network
      // probes, so every network call carries a fixed 5s per-call timeout. On
      // timeout execFileSync throws → caught below → { ok:false } = fail-open
      // (never hangs the hook).
      timeout: 5000,
    });
    return { ok: true, out: out.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

const CHORE_A_MENTION = /chore[\s-]*A\b/i;
// A negation word directly in front of `chore A`, optionally followed by an
// article. The `n't` form carries no leading `\b` so `isn't` and `isn’t` match.
const NEGATED_CHORE_A_MENTION =
  /(?:\b(?:not|never|non)|n['’]t|不是|並非|并非|非|不屬於|不属于|不算|不能算)[\s-]*(?:(?:an?|the|一個|一个)\s+)?chore[\s-]*A\b/gi;

/**
 * Determine whether a merged branch qualifies as a chore A by querying its
 * merged PR title + body via `gh pr list`.
 *
 * Behaviour:
 *   - Branches NOT matching `^chore/` short-circuit to `false` without any
 *     `gh` call (feature/bugfix/hotfix can never be chore A).
 *   - For `chore/` branches, runs (argv form, no shell):
 *       gh pr list --state merged --search head:<branch> --limit 1
 *                  --json title,body --jq .[0]
 *     via `execFileCapture` so the branch name cannot be shell-interpreted.
 *   - Regex `/chore[\s-]*A\b/i` is applied to the concatenated title + body
 *     after negated mentions (`not chore A`, `isn't a chore A`, `non-chore A`,
 *     `不是／非／不屬於 chore A`) are removed. Match → `true` (is chore A);
 *     no match → `false`. Only a negation directly in front of `chore A`
 *     counts; any other mention still declares chore A.
 *   - Fail-open guarantee: any error (spawn failure, empty stdout, malformed
 *     JSON, null PR object) MUST yield `false`, never an unhandled rejection.
 *     A redundant Recap reminder is preferable to silently skipping a real
 *     Recap obligation.
 *
 * @param {string} branch - Branch name as stored in recap-pending marker
 * @returns {Promise<boolean>}
 */
export async function isChoreAByPRBody(branch) {
  if (!/^chore\//.test(branch)) return false;
  const { ok, out } = execFileCapture("gh", [
    "pr",
    "list",
    "--state",
    "merged",
    "--search",
    `head:${branch}`,
    "--limit",
    "1",
    "--json",
    "title,body",
    "--jq",
    ".[0]",
  ]);
  if (!ok || !out) return false;
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const text = (parsed.title || "") + "\n" + (parsed.body || "");
  return CHORE_A_MENTION.test(text.replace(NEGATED_CHORE_A_MENTION, " "));
}

/**
 * pre-tool-gate.mjs 偵測 `gh pr merge` 後呼叫，記錄該 branch 待寫 Recap。
 * 對非 work branch 直接 no-op；fail-open（不 block workflow）。
 */
export function writeRecapPendingMarker(branch) {
  if (!branch || !isWorkBranch(branch)) return;
  try {
    mkdirSync(RECAP_PENDING_DIR, { recursive: true });
    writeFileSync(
      `${RECAP_PENDING_DIR}/${sanitizeBranch(branch)}`,
      String(Date.now())
    );
  } catch {
    // fail-open
  }
}

export function clearRecapPendingMarker(branch) {
  if (!branch) return;
  try {
    for (const markerName of markerNamesForBranch(branch)) {
      const p = `${RECAP_PENDING_DIR}/${markerName}`;
      if (existsSync(p)) unlinkSync(p);
    }
  } catch {
    // ignore
  }
}

export function writeRecapInProgressMarker(branch) {
  if (!branch || !isWorkBranch(branch)) return;
  try {
    mkdirSync(RECAP_IN_PROGRESS_DIR, { recursive: true });
    writeFileSync(
      `${RECAP_IN_PROGRESS_DIR}/${sanitizeBranch(branch)}`,
      String(Date.now())
    );
  } catch {
    // fail-open
  }
}

export function clearRecapInProgressMarker(branch) {
  if (!branch) return;
  try {
    for (const markerName of markerNamesForBranch(branch)) {
      const p = `${RECAP_IN_PROGRESS_DIR}/${markerName}`;
      if (existsSync(p)) unlinkSync(p);
    }
  } catch {
    // ignore
  }
}

function clearAllRecapMarkers(branch) {
  clearRecapPendingMarker(branch);
  clearRecapInProgressMarker(branch);
}

/**
 * 列出所有 recap-pending markers 對應的 branch 名。順帶清掉超過 TTL 的 stale
 * markers。回傳已 desanitize 的 branch 名陣列（可能含非 work branch — 由
 * caller 決定是否過濾）。
 */
export function listRecapPendingMarkers() {
  if (!existsSync(RECAP_PENDING_DIR)) return [];
  const result = [];
  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(RECAP_PENDING_DIR);
  } catch {
    return [];
  }
  for (const f of entries) {
    if (f === RECAP_DIAGNOSTIC_LOG_BASENAME) continue;
    const p = `${RECAP_PENDING_DIR}/${f}`;
    let stat;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > RECAP_PENDING_TTL_MS) {
      try {
        unlinkSync(p);
      } catch {
        // ignore
      }
      continue;
    }
    result.push(unsanitizeBranch(f));
  }
  return result;
}

export function listRecapInProgressMarkers() {
  if (!existsSync(RECAP_IN_PROGRESS_DIR)) return [];
  let entries;
  try {
    entries = readdirSync(RECAP_IN_PROGRESS_DIR);
  } catch {
    return [];
  }
  return entries.map((f) => unsanitizeBranch(f));
}

function recapInProgressState(branch) {
  if (!branch) return "absent";
  for (const markerName of markerNamesForBranch(branch)) {
    const p = `${RECAP_IN_PROGRESS_DIR}/${markerName}`;
    let stat;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    if (Date.now() - stat.mtimeMs <= RECAP_IN_PROGRESS_TTL_MS) {
      return "fresh";
    }
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
    return "expired";
  }
  return "absent";
}

export function markRecapCreationStartedForChange(changeName, options) {
  if (options) {
    const {cwd = process.cwd(), session = resolveReminderSession(), prNumber = '', repo = ''} = options;
    if (!session || !changeName) return 0;
    const key = repoName(repo);
    if (repo && (!key || !validRecapPr(prNumber))) return 0;
    const records = readRecapWork(cwd, session);
    let count = 0;
    for (const record of records) {
      if (!matchesRecapWork(record, changeName, prNumber, key)) continue;
      record.inProgressAt = Date.now();
      count++;
    }
    return count && saveRecapWork(cwd, session, records) ? count : 0;
  }
  if (!changeName) return 0;
  let count = 0;
  for (const branch of listRecapPendingMarkers()) {
    if (!isWorkBranch(branch)) continue;
    if (getChangeName(branch) !== changeName) continue;
    clearRecapPendingMarker(branch);
    writeRecapInProgressMarker(branch);
    count++;
  }
  return count;
}

/**
 * Confirmed Discussion creation records a permanent shared change/PR fact.
 * Legacy branch and direct change keys remain compatible. Optional session
 * options clear only its exact change/PR obligation; no optimistic pre-tool write.
 * Filesystem failures never block the caller's GitHub write path.
 */
export function writeRecapWrittenMarkerForChange(changeName, prNumber = null, options) {
  if (!changeName) return 0;
  const repo = options?.repo;
  if (repo) {
    const key = repoName(repo);
    if (!key || !validRecapPr(prNumber)) return 0;
    const file = scopedRecapWrittenPath(changeName, key, prNumber);
    try {
      mkdirSync(path.dirname(file), {recursive: true});
      writeFileSync(file, String(Date.now()));
    } catch { return 0; }
    clearOwnRecapPendingForChange(changeName, {...options, prNumber});
    return 1;
  }
  let count = 0;
  const writtenNames = new Set();

  // Scoped success must not scan/GC legacy pending state owned by no session.
  for (const branch of options ? [] : listRecapPendingMarkers()) {
    if (!isWorkBranch(branch)) continue;
    if (getChangeName(branch) !== changeName) continue;
    const markerName = recapWrittenMarkerName(branch, prNumber);
    if (writtenNames.has(markerName)) continue;
    try {
      mkdirSync(RECAP_WRITTEN_DIR, { recursive: true });
      writeFileSync(
        `${RECAP_WRITTEN_DIR}/${markerName}`,
        String(Date.now())
      );
      writtenNames.add(markerName);
      count++;
    } catch {
      // fail-open
    }
  }

  // changeName-keyed 直寫路徑：不依賴上面迴圈是否命中任何 pending marker，
  // 保證即使 listRecapPendingMarkers() 回空（無對應 pending branch）也至少
  // 寫入一個 recap-written marker。PR identity 有則寫 `--pr-<n>` suffix。
  try {
    const changeMarkerName = recapWrittenMarkerName(changeName, prNumber);
    if (!writtenNames.has(changeMarkerName)) {
      mkdirSync(RECAP_WRITTEN_DIR, { recursive: true });
      writeFileSync(
        `${RECAP_WRITTEN_DIR}/${changeMarkerName}`,
        String(Date.now())
      );
      writtenNames.add(changeMarkerName);
      count++;
    }
  } catch {
    // fail-open
  }

  if (count && options) clearOwnRecapPendingForChange(changeName, {...options, prNumber});
  return count;
}

/** Only this stable session's successful merged work is eligible; zero network. */
export async function evaluateMergedRecapPending(options = {}) {
  return evaluateOwnRecap({...options, merged: true});
}
