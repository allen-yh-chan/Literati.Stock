/**
 * patch-id-utils.mjs
 *
 * SSOT for git `patch-id` based subsumed-by-squash detection. Consumed by
 * `.devpro/scripts/prune-merged-local.mjs` (batch scan of stale local
 * branches / worktrees). Extracted during PR #691 to remove cross-file
 * copy-paste of identical helpers introduced in PR #685.
 *
 * Exports:
 *   - `patchIdForCommit(sha, opts)`     — stable patch-id for a single commit
 *   - `patchIdsForRange(range, opts)`   — Set of patch-ids in a git rev range
 *   - `isSubsumedBySquash(ref, prodRef, opts)`
 *         — true iff every non-prodRef patch-id on `ref` is already present
 *           in production-side range (`mergeBase..prodRef`)
 *
 * Caller responsibilities:
 *   - Pre-check that `ref` tip is NOT a direct ancestor of `prodRef` before
 *     calling `isSubsumedBySquash` (each caller uses its own ancestor
 *     strategy: hook → literal `production`, prune → `productionRef()` with
 *     `origin/production` preference).
 *   - Supply `prodRef` literally; this lib does not pick prodRef.
 *   - For batch scans (≥2 candidate branches), pass `productionPatchIdCache:
 *     Map<mergeBase, Set<patchId>>` so production-side patch IDs are
 *     computed at most once per mergeBase.
 *
 * All functions are fail-open: any underlying git failure returns null /
 * empty Set / false rather than throwing, so callers never crash on edge
 * cases (missing ref, no merge-base, fetch failure mid-scan).
 *
 * **Security note**：呼叫端**絕勿**將未信任 input（branch name from user
 * prompt 等）直接拼進 `ref` / `prodRef` / `range`。本 lib 對命令不做任何
 * escape／sanitization，直接交給 `execSync` shell。所有現行 caller 皆來自
 * `git for-each-ref` / `git worktree list --porcelain` / hardcoded literal
 * 等 trusted 自家 git 輸出 — 維護此契約。
 */

import { execSync, execFileSync } from 'node:child_process';

/** @param {string} cmd @param {string|undefined} cwd @returns {string} */
function capture(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * Shell-free git runner: argv form via execFileSync, so arguments (notably
 * tree-enumerated FILENAMES, which git permits to contain `$()`, backticks, `;`)
 * are passed literally and NEVER interpreted by a shell. Use this — not the
 * string-based `capture` — for any git call whose arguments include filenames or
 * other repository-controlled values. Returns trimmed stdout, or '' on failure.
 *
 * @param {string[]} args  git argv (without leading 'git')
 * @param {string|undefined} cwd
 * @returns {string}
 */
function captureArgv(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * Like `captureArgv` but returns RAW stdout WITHOUT trimming. Required for
 * NUL-delimited output (`git ... -z`): trimming would strip leading ASCII
 * whitespace from the first record, corrupting a filename that legitimately
 * begins with a space and breaking the NUL contract. Use only for `-z` parsing.
 *
 * @param {string[]} args  git argv (without leading 'git')
 * @param {string|undefined} cwd
 * @returns {string}
 */
function captureArgvRaw(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

/**
 * Returns the stable git patch-id for a single commit SHA, or null if unavailable.
 *
 * @param {string} commitSha
 * @param {{ cwd?: string }} [opts]
 * @returns {string|null}
 */
export function patchIdForCommit(commitSha, { cwd } = {}) {
  const out = capture(
    `git show --format=medium --no-ext-diff "${commitSha}" | git patch-id --stable`,
    cwd,
  );
  return out.split(/\s+/)[0] || null;
}

/**
 * Returns the set of stable git patch-ids for all non-merge commits in `range`.
 *
 * @param {string} range  git rev-list range (e.g. `"mergeBase..prodRef"`)
 * @param {{ cwd?: string }} [opts]
 * @returns {Set<string>}
 */
export function patchIdsForRange(range, { cwd } = {}) {
  const ids = new Set();
  // Batched: ONE pipeline for the whole range instead of a `git show | git patch-id`
  // spawn per commit. The commit set comes from the IDENTICAL `rev-list --no-merges`
  // invocation the per-commit loop used; `git patch-id` natively splits `git
  // diff-tree --stdin` output and emits one "<patch-id> <commit-sha>" line per
  // non-empty patch (an empty-diff commit emits no line — same as the old
  // per-commit path yielding null and being skipped). `--root` pins root-commit
  // diffs to the empty tree, matching `git show`. `-M` restores rename detection:
  // `git show` honors diff.renames (default on) and renders a rename as a
  // `rename from/to` hunk, but bare `git diff-tree` does NOT detect renames and
  // would render the same commit as a full delete+add, yielding a DIFFERENT
  // patch-id for any rename commit. `-M` makes the pipeline emit the byte-identical
  // patch-id set the old per-commit `git show` path produced (verified against a
  // real rename commit). Fail-open: a failed pipeline yields empty output → empty
  // Set, never a throw.
  const out = capture(
    `git rev-list --no-merges ${range} | git diff-tree --stdin --root -M -p | git patch-id --stable`,
    cwd,
  );
  for (const line of out.split('\n')) {
    const id = line.split(/\s+/)[0];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Returns true if every non-merge commit in `ref` that is not yet in `prodRef` has
 * its patch-id present in the production history since the merge-base.
 *
 * Caller responsibilities:
 * - `prodRef` is passed by the caller (e.g. `'production'` from the hook, or
 *   `'origin/production'` from prune-merged-local when a remote exists).
 * - The caller should already have confirmed that the branch tip is NOT a
 *   direct ancestor of `prodRef` (ancestor check short-circuits before here).
 * - `productionPatchIdCache` is an optional `Map<string, Set<string>>`
 *   (keyed by mergeBase SHA) shared across all branches in a single scan run.
 *   Omit it for one-off calls; supply it in batch-scan scenarios to avoid
 *   recomputing production patch IDs for the same mergeBase repeatedly.
 *
 * @param {string} ref                   branch name or ref
 * @param {string} prodRef               production ref, supplied by caller
 * @param {{ cwd?: string, productionPatchIdCache?: Map<string, Set<string>> }} [opts]
 * @returns {boolean}
 */
export function isSubsumedBySquash(ref, prodRef, { cwd, productionPatchIdCache } = {}) {
  const branchPatchIds = patchIdsForRange(`${prodRef}.."${ref}"`, { cwd });
  if (branchPatchIds.size === 0) return false;

  const mergeBase = capture(`git merge-base ${prodRef} "${ref}"`, cwd);
  if (!mergeBase) return false;

  let productionPatchIds;
  if (productionPatchIdCache) {
    productionPatchIds = productionPatchIdCache.get(mergeBase);
    if (!productionPatchIds) {
      productionPatchIds = patchIdsForRange(`${mergeBase}..${prodRef}`, { cwd });
      productionPatchIdCache.set(mergeBase, productionPatchIds);
    }
  } else {
    productionPatchIds = patchIdsForRange(`${mergeBase}..${prodRef}`, { cwd });
  }

  if (productionPatchIds.size === 0) return false;

  for (const patchId of branchPatchIds) {
    if (!productionPatchIds.has(patchId)) return false;
  }
  return true;
}

/**
 * Returns true iff EVERY file the branch introduces relative to `prodRef` lives
 * under an `openspec/changes/archive/<date>-<slug>/` path AND has byte-identical
 * content in `prodRef`. This catches a shipped branch that patch-id subsumption
 * misses — e.g. a rebase-merged branch whose content commit's patch-id drifted,
 * leaving only its archive folder as proof of shipping.
 *
 * This predicate is intentionally **fail-closed** (the opposite of the other
 * helpers in this file): when in doubt it returns false, because a false positive
 * here deletes a branch. Specifically it returns false if:
 *   - the branch introduces ANY file outside an archive folder (even a
 *     superseded older version of a shipped rule — that is NOT archive-only), or
 *   - any introduced archive file's blob differs from `prodRef`'s blob (path
 *     existence is NOT enough; content MUST be byte-identical), or
 *   - the branch introduces no archive file at all, or
 *   - any underlying git command fails.
 *
 * Caller responsibilities mirror `isSubsumedBySquash`: pass a trusted `ref`
 * (from `git for-each-ref`/`git worktree list`, never user input) and a literal
 * `prodRef`; pre-check that the tip is not a direct ancestor of `prodRef`.
 *
 * @param {string} ref       branch name or ref (trusted)
 * @param {string} prodRef   production ref, supplied by caller
 * @param {{ cwd?: string }} [opts]
 * @returns {boolean}
 */
export function isArchiveOnlyShipped(ref, prodRef, { cwd } = {}) {
  // SECURITY: filenames come from `git diff` (tree-enumerated, may contain
  // `$()`/backticks/`;`) so EVERY call below uses the shell-free `captureArgv`
  // argv form — a filename is never interpolated into a shell string.
  // Only consider what the branch introduces ON ITS OWN SIDE since the merge-base,
  // NOT the symmetric two-dot diff (which would also surface production's own newer
  // files as phantom "changes" and wrongly disqualify a clean archive-only branch).
  const mergeBase = captureArgv(['merge-base', prodRef, ref], cwd);
  if (!mergeBase) return false;
  // `-z` → NUL-delimited, so filenames containing newlines/spaces are intact.
  // Use the RAW (non-trimming) runner: trimming would strip a leading space from
  // the first filename and break the NUL contract in this destructive predicate.
  const diffOut = captureArgvRaw(['diff', '-z', '--name-only', mergeBase, ref], cwd);
  const changedFiles = diffOut ? diffOut.split('\0').filter(Boolean) : [];
  if (changedFiles.length === 0) return false;

  const ARCHIVE_RE = /^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-[^/]+\//;
  let sawArchiveFile = false;

  for (const file of changedFiles) {
    // fail-closed: any non-archive file means this is not an archive-only branch.
    if (!ARCHIVE_RE.test(file)) return false;
    sawArchiveFile = true;

    // Require byte-identical content in production (not mere path existence).
    // argv form: `${ref}:${file}` is one literal argument, never shell-evaluated.
    const prodBlob = captureArgv(['rev-parse', `${prodRef}:${file}`], cwd);
    const refBlob = captureArgv(['rev-parse', `${ref}:${file}`], cwd);
    if (!prodBlob || !refBlob || prodBlob !== refBlob) return false;
  }

  return sawArchiveFile;
}
