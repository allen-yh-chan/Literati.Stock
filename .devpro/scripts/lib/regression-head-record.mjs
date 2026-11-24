/**
 * regression-head-record.mjs
 *
 * One carrier for one fact: **which committed HEAD was the canonical test
 * suite last recorded green at, for change `<name>`**. R6 / design.md D16.
 *
 * Two callers, one question, one answer — the same shape T8 established for
 * the Requirement-Ledger coverage verdict:
 *   - `record-regression-head.mjs` writes the receipt after the suite passes.
 *   - `pre-pr-archive-gate.mjs --pre-review` reads it and compares against the
 *     current committed HEAD, before the six-axis reviewer is dispatched.
 * Path resolution lives HERE rather than in either caller, because a writer
 * and a reader that resolve the path differently is the one failure this
 * receipt cannot survive: the write succeeds, the read reports "missing", and
 * the gate fails closed on evidence that exists.
 *
 * Why a gitignored `notes/` receipt and not a tracked field (D16): a tracked
 * carrier is self-referential. Writing the sha into a tracked file and
 * committing it advances HEAD, so `recorded == current` can never hold. The
 * receipt does not enter the tree, so writing it does not move HEAD.
 *
 * `branch` is recorded for DIAGNOSIS ONLY and is deliberately not part of the
 * verdict. The fact under test is "this tree state was green", and the sha
 * already identifies the tree exactly; adding branch to the comparison would
 * fail a receipt that is factually correct (same commit, reached from another
 * ref) while catching nothing the sha does not already catch.
 *
 * Every unusable state — absent, unparseable, malformed sha, or keyed to a
 * different change than its own filename — is reported as its own kind and
 * fails closed at the gate. Missing evidence is not evidence of a clean run
 * (D16 三態, brd S7).
 */
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { defaultMainCheckoutRoot } from '../hooks/lib/repo-state-identity.mjs';
import { readNoFollowFile, replaceDurableFile, verifyParentPath } from './durable-fs.mjs';

/** Strict lowercase 40-hex. The gate's message contract promises the author
 * two full object ids, so an abbreviated or uppercase value is not usable
 * evidence — it is a malformed receipt. */
export const REGRESSION_HEAD_SHA_RE = /^[0-9a-f]{40}$/;

/** Strict lowercase 64-hex suite digest (sha256 of the recorded suite log). */
export const SUITE_DIGEST_SHA256_RE = /^[0-9a-f]{64}$/;

/** Filename pattern for regression-head receipts under `notes/`. */
const REGRESSION_HEAD_RECEIPT_NAME_RE = /^qa-regression-head-.+\.json$/;

/** A change name is a single path segment under `openspec/changes/`. The
 * receipt filename embeds it, so anything that could escape the `notes/`
 * directory or collide with another change's receipt is rejected before a
 * path is built — not sanitized into something adjacent-but-wrong. */
const CHANGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REGRESSION_HEAD_RECORD_MAX_BYTES = 64 * 1024;

/**
 * Merge-acceptable suite_evidence: status==="pass", fail===0 (integer),
 * digest_sha256 64 lowercase hex. Writers refuse anything else; merge gate
 * only accepts receipts that still satisfy this shape.
 *
 * @returns {{ ok: true, suite_evidence: { status: string, fail: number, digest_sha256: string } } | { ok: false, reason: string }}
 */
export function normalizeMergeAcceptableSuiteEvidence(suiteEvidence) {
  if (suiteEvidence === null || suiteEvidence === undefined || typeof suiteEvidence !== 'object' || Array.isArray(suiteEvidence)) {
    return { ok: false, reason: 'suiteEvidence is required as { status, fail, digest_sha256 }' };
  }
  const status = suiteEvidence.status;
  if (status !== 'pass') {
    return {
      ok: false,
      reason: `suiteEvidence.status must be "pass" for a merge-acceptable receipt (got ${JSON.stringify(status)})`,
    };
  }
  const fail = suiteEvidence.fail;
  if (!Number.isInteger(fail) || fail !== 0) {
    return {
      ok: false,
      reason: `suiteEvidence.fail must be integer 0 for a merge-acceptable receipt (got ${JSON.stringify(fail)})`,
    };
  }
  const digest = String(suiteEvidence.digest_sha256 ?? '');
  if (!SUITE_DIGEST_SHA256_RE.test(digest)) {
    return {
      ok: false,
      reason: `suiteEvidence.digest_sha256 must be 64 lowercase hex (got ${JSON.stringify(digest)})`,
    };
  }
  return { ok: true, suite_evidence: { status: 'pass', fail: 0, digest_sha256: digest } };
}

function suiteEvidenceLooksAcceptable(suiteEvidence) {
  return normalizeMergeAcceptableSuiteEvidence(suiteEvidence).ok;
}

function recordFilesystem(recordPath) {
  const notesRoot = path.dirname(recordPath);
  return { root: path.dirname(notesRoot), notesRoot };
}

/**
 * Create `<main-checkout-root>/notes` when absent and prove it is a plain
 * directory under a plain parent before a durable write. Exported for the
 * consumer delta receipt (fix-consumer-pre-pr-gates design D5), which resolves
 * `<main-checkout-root>/notes/openspec-validate-<change>.json` and must answer
 * the same "is this notes root writable" question as this receipt.
 */
export function ensurePlainNotesRoot(recordPath) {
  const { root, notesRoot } = recordFilesystem(recordPath);
  try {
    mkdirSync(notesRoot, { recursive: false });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  verifyParentPath(root, notesRoot);
  return { root, notesRoot };
}

export function isValidChangeName(change) {
  const value = String(change ?? '');
  if (value === '.' || value === '..') return false;
  return CHANGE_NAME_RE.test(value);
}

/**
 * `<main-checkout-root>/notes/qa-regression-head-<change>.json`.
 *
 * The root is the main checkout's, not the current worktree's, so a receipt
 * written from a linked worktree is the same file the gate reads from that
 * worktree — the same resolution `notes/session-pending.md` and the per-change
 * usage checkpoint already use.
 */
export function regressionHeadRecordPath({ cwd = process.cwd(), change, mainCheckoutRoot } = {}) {
  if (!isValidChangeName(change)) {
    throw new Error(`invalid change name for a regression-head receipt: ${JSON.stringify(String(change ?? ''))}`);
  }
  const root = mainCheckoutRoot ?? defaultMainCheckoutRoot(cwd);
  return path.join(root, 'notes', `qa-regression-head-${change}.json`);
}

/**
 * Writes the receipt. Returns `{ status, recordPath, record, reason }`.
 *
 * Unlike the per-change usage checkpoint (fail-open by design: blocking
 * `/devpro:change` startup on a local-state write has no remedy), a failed write
 * here IS reported to the caller, because this receipt has a consumer that
 * fails closed. Silently failing open would only defer the block to the gate,
 * where the author is told "no receipt" instead of "the receipt could not be
 * written" — the same stop, minus the diagnosis.
 */
export function writeRegressionHeadRecord({
  cwd = process.cwd(),
  change,
  headSha,
  branch = null,
  suiteEvidence,
  mainCheckoutRoot,
  now = () => new Date(),
} = {}) {
  const recordPath = regressionHeadRecordPath({ cwd, change, mainCheckoutRoot });
  const sha = String(headSha ?? '');
  if (!REGRESSION_HEAD_SHA_RE.test(sha)) {
    return {
      status: 'invalid_sha',
      recordPath,
      record: null,
      reason: `head sha is not 40-hex: ${JSON.stringify(sha)}`,
    };
  }
  const suite = normalizeMergeAcceptableSuiteEvidence(suiteEvidence);
  if (!suite.ok) {
    return {
      status: 'invalid_suite_evidence',
      recordPath,
      record: null,
      reason: suite.reason,
    };
  }
  const record = {
    change: String(change),
    branch: branch === null || branch === undefined ? null : String(branch),
    head_sha: sha,
    recorded_at: now().toISOString(),
    suite_evidence: suite.suite_evidence,
  };
  try {
    const { root, notesRoot } = ensurePlainNotesRoot(recordPath);
    replaceDurableFile({
      root,
      parent: notesRoot,
      target: recordPath,
      body: `${JSON.stringify(record, null, 2)}\n`,
    });
  } catch (error) {
    return { status: 'write_failed', recordPath, record: null, reason: error?.message || String(error) };
  }
  return { status: 'written', recordPath, record, reason: null };
}

/**
 * Reads the receipt without judging currency. Returns
 * `{ status: 'ok' | 'missing' | 'unusable', recordPath, record, reason }`.
 *
 * `unusable` covers unreadable, unparseable, non-object, malformed `head_sha`,
 * and a `change` field disagreeing with the filename it was found under. That
 * last one matters because the filename is the key: a receipt claiming another
 * change means the file was hand-edited or written by a different keying
 * scheme, and trusting either half of the contradiction is a guess.
 */
export function readRegressionHeadRecord({ cwd = process.cwd(), change, mainCheckoutRoot } = {}) {
  const recordPath = regressionHeadRecordPath({ cwd, change, mainCheckoutRoot });
  const { root, notesRoot } = recordFilesystem(recordPath);
  let bytes;
  try {
    lstatSync(notesRoot);
    ({ bytes } = readNoFollowFile({
      root,
      parent: notesRoot,
      target: recordPath,
      maxBytes: REGRESSION_HEAD_RECORD_MAX_BYTES,
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', recordPath, record: null, reason: 'no receipt file' };
    }
    return { status: 'unusable', recordPath, record: null, reason: `unreadable: ${error?.message || error}` };
  }
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return { status: 'unusable', recordPath, record: null, reason: `not valid UTF-8: ${error?.message || error}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'unusable', recordPath, record: null, reason: `not valid JSON: ${error?.message || error}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unusable', recordPath, record: null, reason: 'receipt is not a JSON object' };
  }
  if (!REGRESSION_HEAD_SHA_RE.test(String(parsed.head_sha ?? ''))) {
    return {
      status: 'unusable',
      recordPath,
      record: null,
      reason: `head_sha is not 40-hex: ${JSON.stringify(String(parsed.head_sha ?? ''))}`,
    };
  }
  if (String(parsed.change ?? '') !== String(change)) {
    return {
      status: 'unusable',
      recordPath,
      record: null,
      reason:
        `receipt is keyed to change ${JSON.stringify(String(parsed.change ?? ''))},` +
        ` not ${JSON.stringify(String(change))}`,
    };
  }
  return { status: 'ok', recordPath, record: parsed, reason: null };
}

/**
 * Expand `git diff --name-status -M` (or equivalent) into a path set that
 * includes rename/copy **source and destination**, plus A/M/D paths.
 * MUST NOT use name-only alone: rename detection can hide a denied source
 * behind an allowed destination (design D2 / F-DG-R1-01).
 */
export function expandRenameAwareNameStatusPaths(raw) {
  const paths = new Set();
  for (const line of String(raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (/^[RC]\d*/.test(status) && parts.length >= 3) {
      if (parts[1]) paths.add(parts[1]);
      if (parts[2]) paths.add(parts[2]);
      continue;
    }
    if (parts.length >= 2 && parts[1]) paths.add(parts[1]);
  }
  return [...paths];
}

/**
 * Paths that may land after a recorded-green HEAD without invalidating R6
 * currency (docs / change-folder bookkeeping). Narrower than ui-smoke:
 * MUST NOT call or reuse `isAllowedPostSmokeDeltaPath` (scripts are smoke-ok,
 * R6-stale). Deny-first for UI, scripts/tests, and behavior-bearing
 * skill/workflow markdown; default-deny remaining agent-rules/skills.
 */
export function isAllowedPostRegressionHeadDeltaPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (/\.(cshtml|razor|tsx|jsx|vue|css|scss)$/i.test(filePath)) return false;
  if (/(^|\/)(Views|Pages|wwwroot|components)\//i.test(filePath)) return false;
  if (filePath.startsWith('.devpro/scripts/')) return false;
  if (/(^|\/)tests\//.test(filePath)) return false;
  if (/\.test\.[^/]+$/i.test(filePath) || /\.spec\.[^/]+$/i.test(filePath)) return false;
  if (filePath.startsWith('.devpro/agent-skills/devpro-workflows/')) return false;
  if (filePath.startsWith('.devpro/agent-skills/') && /(^|\/)SKILL\.md$/i.test(filePath)) {
    return false;
  }
  // Default-deny remaining skills/rules carriers (only explicit bookkeeping below).
  if (filePath.startsWith('.devpro/agent-skills/')) return false;
  if (filePath.startsWith('.devpro/agent-rules/')) return false;
  if (filePath.startsWith('openspec/changes/') || filePath.startsWith('notes/')) return true;
  if (filePath.startsWith('docs/') || filePath === 'README.md' || filePath.startsWith('README.')) {
    return true;
  }
  return false;
}

function gitText(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    const err = new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`,
    );
    err.code = 'git-failed';
    throw err;
  }
  return String(result.stdout ?? '');
}

/**
 * The verdict the gate consumes. `kind` is one of:
 *   - `current`  — the receipt names the current committed HEAD (ok)
 *   - `current-bookkeeping-tip-move` — ancestor tip-move within the R6 allowlist (ok)
 *   - `stale`    — a usable receipt naming a different HEAD; BOTH shas returned
 *   - `missing`  — no receipt
 *   - `unusable` — a receipt that cannot be trusted (see readRegressionHeadRecord)
 *
 * `ok === true` for `current` and bookkeeping tip-move. Callers MUST key on
 * `ok`, not `kind === 'current'`. `stale` carries `testedSha` and `currentSha`
 * because naming just one of them leaves the author to work out which is which.
 * Carve-out never rewrites the receipt.
 */
export function evaluateRegressionHeadCurrency({
  cwd = process.cwd(),
  change,
  currentHeadSha,
  mainCheckoutRoot,
} = {}) {
  const currentSha = String(currentHeadSha ?? '');
  const read = readRegressionHeadRecord({ cwd, change, mainCheckoutRoot });
  const base = {
    change: String(change),
    recordPath: read.recordPath,
    currentSha,
    testedSha: null,
    branch: null,
  };
  if (!REGRESSION_HEAD_SHA_RE.test(currentSha)) {
    return {
      ...base,
      ok: false,
      kind: 'unusable',
      reason: `current HEAD is not a 40-hex sha: ${JSON.stringify(currentSha)}`,
    };
  }
  if (read.status !== 'ok') {
    return { ...base, ok: false, kind: read.status, reason: read.reason };
  }
  const testedSha = String(read.record.head_sha);
  const branch = read.record.branch === undefined ? null : read.record.branch;
  if (testedSha === currentSha) {
    return { ...base, ok: true, kind: 'current', testedSha, branch, reason: null };
  }

  const stale = {
    ...base,
    ok: false,
    kind: 'stale',
    testedSha,
    branch,
    reason: 'HEAD moved since the suite was recorded green',
  };

  try {
    const ancestor = spawnSync(
      'git',
      ['-C', cwd, 'merge-base', '--is-ancestor', testedSha, currentSha],
      { encoding: 'utf8' },
    );
    if (ancestor.status !== 0) return stale;

    const nameStatus = gitText(cwd, ['diff', '--name-status', '-M', `${testedSha}..${currentSha}`]);
    const deltaPaths = expandRenameAwareNameStatusPaths(nameStatus);
    const blocked = deltaPaths.filter((p) => !isAllowedPostRegressionHeadDeltaPath(p));
    if (blocked.length > 0) {
      return {
        ...stale,
        reason: 'HEAD moved with non-bookkeeping delta since the suite was recorded green',
        blocked: blocked.slice(0, 20),
      };
    }
    return {
      ...base,
      ok: true,
      kind: 'current-bookkeeping-tip-move',
      testedSha,
      branch,
      reason: null,
      delta_count: deltaPaths.length,
    };
  } catch {
    return stale;
  }
}

/**
 * Scan `<main-checkout-root>/notes/qa-regression-head-*.json` for a receipt
 * acceptable as local-test merge evidence for `headSha`.
 *
 * Acceptable only when `head_sha` matches AND `suite_evidence.status==="pass"`
 * AND `suite_evidence.fail===0` AND `digest_sha256` is 64 lowercase hex.
 * Old receipts lacking `suite_evidence` remain readable for pre-review currency
 * via `readRegressionHeadRecord`, but are NOT acceptable here.
 *
 * Does not follow symlinks for `notes/` or receipt targets (reuses durable-fs
 * no-follow reads). Returns the first matching receipt.
 *
 * @returns {{ ok: true, record: object, recordPath: string } | { ok: false, reason: string }}
 */
export function findAcceptableLocalTestReceipt({
  cwd = process.cwd(),
  headSha,
  mainCheckoutRoot,
} = {}) {
  const sha = String(headSha ?? '');
  if (!REGRESSION_HEAD_SHA_RE.test(sha)) {
    return { ok: false, reason: `head sha is not 40-hex: ${JSON.stringify(sha)}` };
  }
  const root = mainCheckoutRoot ?? defaultMainCheckoutRoot(cwd);
  const notesRoot = path.join(root, 'notes');
  let entries;
  try {
    const notesStat = lstatSync(notesRoot);
    if (notesStat.isSymbolicLink() || !notesStat.isDirectory()) {
      return { ok: false, reason: 'notes/ is missing or not a plain directory' };
    }
    verifyParentPath(root, notesRoot);
    entries = readdirSync(notesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'no notes/ directory' };
    }
    return { ok: false, reason: `unreadable notes/: ${error?.message || error}` };
  }

  for (const ent of entries) {
    if (!REGRESSION_HEAD_RECEIPT_NAME_RE.test(ent.name)) continue;
    if (ent.isSymbolicLink() || !ent.isFile()) continue;
    const recordPath = path.join(notesRoot, ent.name);
    let bytes;
    try {
      ({ bytes } = readNoFollowFile({
        root,
        parent: notesRoot,
        target: recordPath,
        maxBytes: REGRESSION_HEAD_RECORD_MAX_BYTES,
      }));
    } catch {
      continue;
    }
    let raw;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    if (String(parsed.head_sha ?? '') !== sha) continue;
    if (!suiteEvidenceLooksAcceptable(parsed.suite_evidence)) continue;
    return { ok: true, record: parsed, recordPath };
  }

  return {
    ok: false,
    reason: `no acceptable local-test receipt for head ${sha} (need suite_evidence status=pass fail=0 + matching head_sha)`,
  };
}

/**
 * Merge-gate form (2) / S1 (design D3): a bookkeeping tip-move receipt is
 * acceptable local-test evidence for `headSha` when — and only when —
 * `evaluateRegressionHeadCurrency` judges the tip-move `current-bookkeeping
 * -tip-move` AND the receipt it read still carries a merge-acceptable
 * `suite_evidence` (pass / fail=0 / 64-hex digest).
 *
 * Composes three existing exports without changing any of their bodies or
 * verdict shapes: `evaluateRegressionHeadCurrency` (currency + bookkeeping
 * -allowlist judgment), `readRegressionHeadRecord` (re-read the same receipt
 * to apply the stricter merge acceptance rule the `--pre-review` currency
 * check does not enforce), and `normalizeMergeAcceptableSuiteEvidence` (the
 * merge-acceptable `suite_evidence` shape `findAcceptableLocalTestReceipt`
 * already uses for form (1)).
 *
 * Only `verdict.kind === 'current-bookkeeping-tip-move'` is accepted here.
 * Every other ok `kind` the evaluator can return — including `current`
 * (receipt already names the exact PR head), and any `kind` the evaluator
 * gains in the future — is refused as `not-bookkeeping-tip-move` WITHOUT
 * reading `suite_evidence` at all: this is the deliberate default-deny that
 * keeps this function from becoming a second, differently-gated path to
 * exact-head admission. A `current` verdict reaching this function means
 * form (1)'s `findAcceptableLocalTestReceipt` already judged that exact same
 * receipt insufficient (its `suite_evidence` is missing or unacceptable) —
 * accepting it here would let the same receipt pass through a laxer gate the
 * second time it is checked (design D3).
 *
 * @returns {
 *   | { ok: true, kind: 'current-bookkeeping-tip-move', testedSha: string, currentSha: string, delta_count: number }
 *   | { ok: false, kind: 'change-unmapped' }
 *   | { ok: false, kind: string, reason: string, testedSha: string|null, currentSha: string, blocked?: string[] }
 *   | { ok: false, kind: 'not-bookkeeping-tip-move', verdictKind: string, testedSha: string, currentSha: string }
 *   | { ok: false, kind: 'suite-evidence-unacceptable', testedSha: string, currentSha: string }
 * }
 */
export function evaluateLocalTestTipMoveReceipt({
  cwd = process.cwd(),
  change,
  headSha,
  mainCheckoutRoot,
} = {}) {
  if (!isValidChangeName(change)) {
    return { ok: false, kind: 'change-unmapped' };
  }
  const verdict = evaluateRegressionHeadCurrency({
    cwd,
    change,
    currentHeadSha: headSha,
    mainCheckoutRoot,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      kind: verdict.kind,
      reason: verdict.reason,
      testedSha: verdict.testedSha,
      currentSha: verdict.currentSha,
      ...(verdict.blocked ? { blocked: verdict.blocked } : {}),
    };
  }
  if (verdict.kind !== 'current-bookkeeping-tip-move') {
    return {
      ok: false,
      kind: 'not-bookkeeping-tip-move',
      verdictKind: verdict.kind,
      testedSha: verdict.testedSha,
      currentSha: verdict.currentSha,
    };
  }
  const read = readRegressionHeadRecord({ cwd, change, mainCheckoutRoot });
  const suiteAcceptable =
    read.status === 'ok' &&
    String(read.record?.head_sha ?? '') === verdict.testedSha &&
    normalizeMergeAcceptableSuiteEvidence(read.record?.suite_evidence).ok;
  if (!suiteAcceptable) {
    return {
      ok: false,
      kind: 'suite-evidence-unacceptable',
      testedSha: verdict.testedSha,
      currentSha: verdict.currentSha,
    };
  }
  return {
    ok: true,
    kind: 'current-bookkeeping-tip-move',
    testedSha: verdict.testedSha,
    currentSha: verdict.currentSha,
    delta_count: verdict.delta_count,
  };
}
