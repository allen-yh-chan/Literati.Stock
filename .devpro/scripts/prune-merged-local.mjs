#!/usr/bin/env node
/**
 * prune-merged-local.mjs
 *
 * Lists local + remote branches whose tip is reachable from the `production`
 * branch (i.e. the branch content has actually shipped to PROD). Does NOT
 * auto-delete.
 *
 * Also lists:
 *   - Worktrees whose linked branch head is ancestor of `production`.
 *   - "Orphaned" local branches whose remote tracking ref no longer exists after
 *     `git fetch --prune` (possible squash-merge leftovers; requires manual verify).
 *   - With `--include-subsumed`: local branches/worktrees whose non-production
 *     patch IDs are already present in production history (`subsumed-by-squash`).
 *
 * Shipped semantic (single criterion): `git merge-base --is-ancestor <tip> production`.
 * This covers (a) feature/bugfix/chore/hotfix promoted via release/<name> → production,
 * (b) release/<name> lane branches merged into production with --no-ff, and (c) the
 * corner case where a production-* tag wasn't pushed yet but the production branch
 * is up-to-date. Rules Lane `rules/*` products are owned by prune-rules-lane.mjs
 * (main-merged tips are never production ancestors after cherry-pick).
 *
 * NOTE: PR merge must still be regular merge. `--include-subsumed` is only for
 * local squash-source WIP branches created before a PR force-push squash.
 *
 * Keep list: .git/info/deletable-keep — branches listed here are skipped in every
 * scan. Use --keep to add entries, --keep-list to review.
 *
 * Output: candidate list + exact commands for user to approve:
 *   git branch -d <local>
 *   git worktree remove --force <path>
 *   node .devpro/scripts/prune-merged-local.mjs --include-remote --exec
 *
 * Usage:
 *   node .devpro/scripts/prune-merged-local.mjs                       # scan + list candidates (dry)
 *   node .devpro/scripts/prune-merged-local.mjs --exec                # scan + execute confirmed local/worktree deletes
 *   node .devpro/scripts/prune-merged-local.mjs --local-only --exec   # explicit zero-network; remote freshness unverified
 *   node .devpro/scripts/prune-merged-local.mjs --include-remote --exec # additionally delete confirmed remote refs
 *   node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --exec # also delete verified main-contained ∩ ¬prod local/worktree
 *   node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --include-remote --exec
 *   node .devpro/scripts/prune-merged-local.mjs --include-subsumed    # also list patch-id-subsumed local WIP branches
 *   node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec
 *   node .devpro/scripts/prune-merged-local.mjs --include-subsumed --include-remote --exec
 *   node .devpro/scripts/prune-merged-local.mjs --force-delete <b>    # single-branch override (abandoned/non-standard ref escape hatch; blocks protected/release/current — abandoned local release/<name> see --allow-release)
 *   node .devpro/scripts/prune-merged-local.mjs --force-delete <b> --include-remote  # same, plus origin/<b> under an OID lease (rejects release/*; refuses branches a batch path owns)
 *   node .devpro/scripts/prune-merged-local.mjs --force-delete --allow-release <release/b>  # dual opt-in for abandoned local release/<name> (live no-remote-same-name + no tracking + tip in production|origin/main)
 *   node .devpro/scripts/prune-merged-local.mjs --keep <b> [<b>]      # add to keep list
 *   node .devpro/scripts/prune-merged-local.mjs --keep-list           # show keep list
 *
 * Dry-run is the default no-argument scan mode; `--dry-run` is intentionally
 * unsupported so cleanup handoffs cannot drift into a second flag shape.
 *
 * `--exec` and `--force-delete` perform local `git branch -D` / `git worktree remove`
 * via `execFileSync`; `--include-remote --exec` and `--force-delete <b> --include-remote`
 * additionally delete remote refs (the latter always under `--force-with-lease`).
 * These inner git calls do NOT pass through Claude Code's PreToolUse hook (only the
 * outer `node` invocation does, and Gate 2g's regex doesn't match `node ...`). So this
 * script is the SSOT canonical entry point per pre-tool-gate.mjs Gate 2g 訊息「唯一入口」承諾.
 *
 * Gate aligns with git-branch-hygiene.md「AI 提醒刪除分支」and release Step 6
 * (PROD tag pushed). Trigger point: after `git push origin production`.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { dirname, basename, join, resolve, isAbsolute, relative, sep, toNamespacedPath } from 'node:path';
import { inspectOrphanTree, dependencyEntryCount, checkDependencyInvariant } from './lib/prune-orphan.mjs';
import { KEEP_LIST_GIT_DIR_ARGV, keepListPath, readKeepListAt } from './lib/prune-keep-list.mjs';
import { isSubsumedBySquash, isArchiveOnlyShipped } from './lib/patch-id-utils.mjs';
import { isProtectedBaseBranch, isLocalReviewBranch } from './hooks/lib/branch-naming.mjs';
import { defaultMainCheckoutRoot, resolveMainCheckoutRoot } from './hooks/lib/repo-state-identity.mjs';
import {
  classifyLocalOnlyProcessInvocation,
  advisoryBranchArg,
  advisoryPathArg,
  parsePruneArgv,
  PRUNE_BRANCH_PREFIXES,
  RELEASE_PREFIX as SHARED_RELEASE_PREFIX,
  SUBMODULE_REMOVE_REFUSAL_RE,
} from './lib/prune-argv.mjs';

export {
  parsePruneArgv,
  acceptsPrintedPruneArgv,
} from './lib/prune-argv.mjs';

// ─── CLI mode parsing ────────────────────────────────────────────────────────

const RAW_ARGS = process.argv.slice(2);
const PARSED = parsePruneArgv(RAW_ARGS);
const INCLUDE_SUBSUMED = PARSED.includeSubsumed;
// patch-id-utils owns additional child processes outside this runtime's argv
// classifier, so explicit local-only marks that evidence unverified and skips it.
const EVALUATE_SUBSUMED = INCLUDE_SUBSUMED && !PARSED.localOnly;
const EXEC = PARSED.exec;
const LOCAL_ONLY = PARSED.localOnly;
const INCLUDE_REMOTE = PARSED.includeRemote;
const INCLUDE_UNSHIPPED_MAINLINE = PARSED.includeUnshippedMainline;
const ALLOW_RELEASE = PARSED.allowRelease;
const MODE = PARSED.mode;
const ARGS = PARSED.args;

function printUsage() {
  console.error('Usage: node .devpro/scripts/prune-merged-local.mjs                       # scan + list candidates (dry-run)');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --exec                # scan + execute confirmed local/worktree deletes');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --local-only --exec   # explicit zero-network; remote freshness unverified');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --include-remote --exec # additionally delete confirmed remote refs');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --exec # verified main-contained ∩ ¬prod local/worktree');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --include-remote --exec');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --include-subsumed    # dry-run including patch-id-subsumed branches');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --include-subsumed --include-remote --exec');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --force-delete <branch>  # rejects protected/release/current; abandoned local release → --allow-release');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --force-delete <branch> --include-remote  # also origin/<branch> under an OID lease; rejects release/*');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --force-delete --allow-release release/<branch>');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --keep <branch> [<branch>...]');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --keep-list');
  console.error('       node .devpro/scripts/prune-merged-local.mjs --remove-orphan <absolute-path> # named ordinary orphan only');
}

if (RAW_ARGS.includes('--dry-run')) {
  console.error('Unsupported option: --dry-run');
  console.error('Dry-run is the default no-argument mode. Use:');
  console.error('  node .devpro/scripts/prune-merged-local.mjs');
  console.error('  node .devpro/scripts/prune-merged-local.mjs --include-subsumed');
  console.error('');
  printUsage();
  process.exit(1);
}

if (RAW_ARGS.includes('--remove-orphan') && (MODE !== '--remove-orphan' || RAW_ARGS.length !== 2 || RAW_ARGS[0] !== MODE || ARGS.length !== 1 || !isAbsolute(ARGS[0]))) {
  console.error('拒絕：--remove-orphan requires exactly one absolute path and no scan/exec/remote/keep/companion flags.');
  process.exit(1);
}

if (LOCAL_ONLY && INCLUDE_REMOTE) {
  console.error('Conflicting options: --local-only and --include-remote cannot be used together.');
  console.error('Default --exec is local-only; use --include-remote --exec only after explicit remote-delete approval.');
  process.exit(1);
}

if (!PARSED.validMode) {
  console.error(`Unknown option: ${MODE}`);
  printUsage();
  process.exit(1);
}

if (ALLOW_RELEASE && MODE !== '--force-delete') {
  console.error(
    '拒絕：--allow-release 僅可與 --force-delete 併用（scan / --keep / --keep-list 不可帶此旗標）',
  );
  printUsage();
  process.exit(1);
}

// ─── Shell helpers ───────────────────────────────────────────────────────────

/**
 * argv-form sibling of `shResult()`, for probes whose arguments must survive
 * verbatim. `execSync` goes through `/bin/sh` on POSIX but `cmd.exe` on Windows,
 * and the two disagree about single quotes: sh strips them, cmd.exe passes them
 * through literally. A probe spelled `--format='%(refname:short)'` therefore
 * reaches git intact on Windows, so every output line carries stray `'` and
 * never matches a bare branch name — silently, because git still exits 0.
 * Passing argv straight to the binary takes the shell out of the path entirely.
 */
function execResult(file, args) {
  if (LOCAL_ONLY) {
    const classification = classifyLocalOnlyProcessInvocation(file, args);
    if (!classification.allowed) {
      return {
        ok: false,
        stdout: '',
        stderr: `explicit --local-only rejected child process: ${classification.reason}`,
        status: null,
      };
    }
  }
  try {
    return {
      ok: true,
      stdout: execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      stderr: '',
      status: 0,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
      status: err.status ?? null,
      error: err.message,
    };
  }
}

function execGitFileSync(args, options = {}) {
  if (LOCAL_ONLY) {
    const classification = classifyLocalOnlyProcessInvocation('git', args);
    if (!classification.allowed) {
      throw new Error(`explicit --local-only rejected child process: ${classification.reason}`);
    }
  }
  return execFileSync('git', args, options);
}

function displayQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function remoteDeleteEntrypoint({
  includeSubsumed = INCLUDE_SUBSUMED,
  includeUnshippedMainline = false,
} = {}) {
  const flags = [];
  if (includeSubsumed) flags.push('--include-subsumed');
  if (includeUnshippedMainline) flags.push('--include-unshipped-mainline');
  flags.push('--include-remote', '--exec');
  return `node .devpro/scripts/prune-merged-local.mjs ${flags.join(' ')}`;
}

const effectiveScope = {
  fetch: null,
  productionRef: null,
  mainlineRef: null,
  branchSnapshot: null,
  remoteTracking: null,
  worktreeSnapshot: null,
  worktreeFs: null,
};

/** Known dependency directory names that may be junction/symlink into main checkout. */
const DEPENDENCY_REPARSE_NAMES = ['node_modules'];

export const REPARSE_RM_RF_ADVISORY =
  'MUST NOT `rm -rf` this path (follows junction/symlink into main-checkout dependencies).';
export const REPARSE_SAFE_TEARDOWN_ADVISORY =
  'Safe teardown (link node only): PowerShell [System.IO.Directory]::Delete($path, $false); cmd /c rmdir "<path>"; POSIX: unlink/rmdir the symlink/junction node (do not follow).';

function firstFailureLine(result) {
  return String(
    result?.stderr ||
      result?.stdout ||
      result?.error ||
      result?.message ||
      'unknown failure',
  )
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || 'unknown failure';
}

function normalizePathKey(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function isReparseOrSymlink(absPath) {
  try {
    const st = lstatSync(absPath);
    if (st.isSymbolicLink()) return true;
  } catch {
    return false;
  }
  return false;
}

function pathHasDependencyReparse(absDir) {
  for (const name of DEPENDENCY_REPARSE_NAMES) {
    const candidate = join(absDir, name);
    if (isReparseOrSymlink(candidate)) return true;
  }
  return false;
}

/**
 * Tear down known dependency reparse/symlink nodes inside a registered worktree
 * without following into the link target (never `rm -rf`).
 */
function tearDownWorktreeDependencyReparses(worktreePath) {
  for (const name of DEPENDENCY_REPARSE_NAMES) {
    const target = join(worktreePath, name);
    if (!isReparseOrSymlink(target)) continue;
    console.log(`  ▶ pre-teardown reparse/symlink (non-following): ${target}`);
    try {
      // POSIX symlink-to-dir: unlink removes the link node.
      unlinkSync(target);
    } catch {
      // Windows junction often needs rmdir on the link node.
      rmdirSync(target);
    }
  }
}

/**
 * First-level `.worktree/*` dirs on the main checkout that are absent from
 * `git worktree list` (realpath-normalized). Advisory-only — never auto-deleted.
 */
function scanFilesystemWorktreeOrphans() {
  let mainRoot;
  try {
    mainRoot = defaultMainCheckoutRoot(process.cwd());
  } catch (err) {
    effectiveScope.worktreeFs = {
      ok: false,
      count: 0,
      orphans: [],
      reason: firstFailureLine(err),
    };
    return [];
  }
  const wtRoot = join(mainRoot, '.worktree');
  if (!existsSync(wtRoot)) {
    effectiveScope.worktreeFs = { ok: true, count: 0, orphans: [] };
    return [];
  }

  let children = [];
  try {
    children = readdirSync(wtRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(wtRoot, entry.name));
  } catch (err) {
    effectiveScope.worktreeFs = {
      ok: false,
      count: 0,
      orphans: [],
      reason: firstFailureLine(err),
    };
    return [];
  }

  const gitPaths = new Set();
  const list = execResult('git', ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    // Fail-closed on the git side of the FS↔git diff: an empty registry would
    // otherwise mark every registered `.worktree/<child>` child as an "orphan".
    effectiveScope.worktreeFs = {
      ok: false,
      count: 0,
      orphans: [],
      reason: firstFailureLine(list),
    };
    return [];
  }
  for (const line of list.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      gitPaths.add(normalizePathKey(trimmed.slice('worktree '.length)));
    }
  }

  const orphans = [];
  for (const child of children) {
    const key = normalizePathKey(child);
    if (!gitPaths.has(key)) orphans.push(child);
  }

  effectiveScope.worktreeFs = {
    ok: true,
    count: children.length,
    orphans,
  };
  return orphans;
}

function orphanRefusalNextStep(err, removalAttempted = false) {
  const reason = firstFailureLine(err);
  if (err.dependencyFailure || reason.startsWith('main-checkout dependency invariant failed:')) {
    return 'restore the main-checkout dependencies and verify the invariant before retrying';
  }
  if (reason.startsWith('refuse .git marker:')) {
    return 'verify whether the .git marker is a stale gitfile or an active repository/submodule; preserve it and handle it separately with an explicitly named action before retrying';
  }
  if (reason.startsWith('native reparse proof unavailable in explicit --local-only mode')) {
    return 'rerun verification without --local-only: node .devpro/scripts/prune-merged-local.mjs';
  }
  if (reason.startsWith('refuse linked/reparse') || reason.includes('refuse reparse path:')) {
    return 'inspect and resolve the linked/reparse entry without following its target before retrying';
  }
  if (reason.startsWith('native reparse probe')) {
    return 'verify the native reparse probe failure before retrying';
  }
  return removalAttempted
    ? 'inspect the remaining directory after the failed removal before retrying'
    : 'verify the reported refusal before retrying';
}

function printFilesystemOrphanAdvisory(orphans) {
  if (!orphans || orphans.length === 0) return;
  console.log(`\n  ⚠️  ${orphans.length} orphan directory(ies) under .worktree/ (present on FS, absent from git worktree list — advisory-only):`);
  for (const dir of orphans) {
    console.log(`    orphan directory: ${dir}`);
    try {
      const mainRoot = defaultMainCheckoutRoot(process.cwd());
      inspectOrphanTree(mainRoot, join(mainRoot, '.worktree'), dir, { allowNativeProbe: !LOCAL_ONLY });
      const arg = advisoryPathArg(dir);
      console.log(arg === null
        ? '      核對後再刪 / verify before deletion: the path has shell-special characters; quote the path above for your shell and run prune-merged-local.mjs with --remove-orphan'
        : `      核對後再刪 / verify before deletion: node .devpro/scripts/prune-merged-local.mjs --remove-orphan ${arg}`);
    } catch (err) {
      console.log(`      --remove-orphan refused: ${firstFailureLine(err)}; ${orphanRefusalNextStep(err)}`);
      if (pathHasDependencyReparse(dir) || isReparseOrSymlink(dir)) {
        console.log(`      ${REPARSE_RM_RF_ADVISORY}`);
        console.log(`      ${REPARSE_SAFE_TEARDOWN_ADVISORY}`);
      }
    }
  }
  console.log('  NOTE: 核對後再刪；`--exec` 不自動刪 orphan directory（與 orphaned branch 同精神）。');
}

function printEffectiveScopeSummary() {
  if (!effectiveScope.worktreeFs) {
    scanFilesystemWorktreeOrphans();
  }
  const degraded = [];
  console.log('\n  Effective scan scope:');

  if (effectiveScope.fetch?.ok) {
    console.log('    fetch: checked (git fetch --prune)');
  } else if (effectiveScope.fetch) {
    console.log(`    fetch: not checked (${effectiveScope.fetch.reason})`);
    degraded.push('fetch');
  } else {
    console.log('    fetch: not reached');
  }

  if (effectiveScope.productionRef?.ref) {
    const fallback = effectiveScope.productionRef.fallback
      ? ' (fallback: origin/production unavailable)'
      : '';
    console.log(`    production-ref: ${effectiveScope.productionRef.ref}${fallback}`);
    if (effectiveScope.productionRef.fallback) degraded.push('production-ref fallback');
  } else {
    console.log('    production-ref: not reached');
  }

  const containment = mainlineContainment();
  if (containment.status === 'verified') {
    console.log(`    mainline-ref: ${mainlineRef()}`);
  } else if (containment.status === 'unavailable') {
    console.log(`    mainline-ref: unavailable (origin/main unresolvable: ${effectiveScope.mainlineRef.reason} — mainline-containment classification disabled)`);
    degraded.push('mainline-ref unavailable');
  } else {
    console.log(`    mainline-ref: ${mainlineRef()} (containment query failed: ${containment.reason} — classification disabled)`);
    degraded.push('mainline-containment query failed');
  }

  if (effectiveScope.branchSnapshot?.ok) {
    console.log(`    branch snapshot: checked, entries=${effectiveScope.branchSnapshot.count}`);
  } else if (effectiveScope.branchSnapshot) {
    console.log(`    branch snapshot: not checked (${effectiveScope.branchSnapshot.reason})`);
    degraded.push('branch snapshot');
  } else {
    console.log('    branch snapshot: not reached');
  }

  if (effectiveScope.remoteTracking?.ok) {
    console.log(`    remote ref visibility: checked, refs=${effectiveScope.remoteTracking.count}`);
  } else if (effectiveScope.remoteTracking) {
    console.log(`    remote ref visibility: not checked (${effectiveScope.remoteTracking.reason})`);
    degraded.push('remote refs');
  } else {
    console.log('    remote ref visibility: not reached');
  }

  const gitLinked = effectiveScope.worktreeSnapshot?.ok
    ? effectiveScope.worktreeSnapshot.count
    : null;
  const fsCount = effectiveScope.worktreeFs?.ok
    ? effectiveScope.worktreeFs.count
    : null;
  if (effectiveScope.worktreeSnapshot?.ok) {
    const fsPart = fsCount === null ? 'fs-.worktree=?' : `fs-.worktree=${fsCount}`;
    console.log(
      `    worktree snapshot: checked, git-linked=${gitLinked}, ${fsPart}, entries=${gitLinked}`,
    );
  } else if (effectiveScope.worktreeSnapshot) {
    console.log(`    worktree snapshot: not checked (${effectiveScope.worktreeSnapshot.reason})`);
    degraded.push('worktrees');
  } else {
    console.log('    worktree snapshot: not reached');
  }

  const orphanCount = effectiveScope.worktreeFs?.orphans?.length || 0;
  if (
    effectiveScope.worktreeFs?.ok &&
    gitLinked !== null &&
    fsCount !== null &&
    (gitLinked !== fsCount || orphanCount > 0)
  ) {
    console.log(`    worktree FS↔git mismatch: orphans=${orphanCount}`);
  } else if (effectiveScope.worktreeFs && !effectiveScope.worktreeFs.ok) {
    console.log(`    worktree FS scan: not checked (${effectiveScope.worktreeFs.reason})`);
    degraded.push('worktree FS');
  }

  if (degraded.length > 0) {
    console.log(`    degraded effective scope: ${degraded.join(', ')}`);
  } else {
    console.log('    effective scope complete');
  }
}

// ─── Keep list helpers (.git/info/deletable-keep) ────────────────────────────

function gitDir() {
  return execResult('git', [...KEEP_LIST_GIT_DIR_ARGV]).stdout.trim() || '.git';
}

function keepFilePath() {
  return keepListPath(gitDir());
}

function readKeepList() {
  return readKeepListAt(gitDir());
}

function appendKeepList(names) {
  const p = keepFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const existing = readKeepList();
  const toAdd = names.filter(n => !existing.has(n));
  if (toAdd.length === 0) return [];
  appendFileSync(p, toAdd.join('\n') + '\n');
  return toAdd;
}

// ─── Branch helpers ──────────────────────────────────────────────────────────

const RELEASE_PREFIX = SHARED_RELEASE_PREFIX;
// release/rules-* is the Rules Lane product: prune-rules-lane.mjs owns it (its own tag
// back-merge criterion), so this script never lists, advises on or deletes it.
const RULES_RELEASE_PREFIX = 'release/rules-';
const FORCE_DELETE_LINKED_WORKTREE_WARNING =
  '  NOTE: --force-delete also removes the branch\'s linked worktree; it refuses one with uncommitted or untracked changes (commit, stash or remove them first).';
const WORKTREE_DIRTY = 'uncommitted or untracked changes';
/** Bound for live allow-release remote probes; timeout → fail-closed. */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/**
 * Scans local + remote branches matching feature/*, bugfix/*, chore/*, hotfix/*, release/*.
 * (rules/* is owned by prune-rules-lane.mjs.)
 * Single `git for-each-ref` snapshot — patterns are OR'd by git, so the result is the
 * same union the old per-pattern×scope probes produced. `%(objectname)`
 * doubles as the branch tip, so the scan loop needs no per-branch `git rev-parse`.
 * Fail-open: a failed snapshot returns [] — same as every per-pattern probe failing.
 * Returns [{ scope: 'local'|'remote', name, tip }] (name = refname:short, so remote
 * entries keep their 'origin/' prefix exactly as before).
 */
function listBranches() {
  // rules/<name> owned by prune-rules-lane.mjs (main-merged ≠ production-ancestor).
  const prefixes = PRUNE_BRANCH_PREFIXES;
  const refPatterns = [
    ...prefixes.map(p => `refs/heads/${p}`),
    ...prefixes.map(p => `refs/remotes/origin/${p}`),
  ];
  const result = execResult('git', [
    'for-each-ref',
    '--format=%(refname)%00%(refname:short)%00%(objectname)',
    ...refPatterns,
  ]);
  if (!result.ok) {
    effectiveScope.branchSnapshot = {
      ok: false,
      count: 0,
      reason: firstFailureLine(result),
    };
    return [];
  }
  const seen = new Set();
  const entries = [];
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const [refname, name, tip] = line.split('\0');
    if (!refname || !name || !tip) continue;
    const scope = refname.startsWith('refs/heads/') ? 'local' : 'remote';
    const key = `${scope}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ scope, name, tip });
  }
  effectiveScope.branchSnapshot = { ok: true, count: entries.length };
  return entries;
}

/**
 * Returns all local branch names (for orphan detection and worktree scanning).
 * Strips leading *, +, or whitespace (worktree indicator prefixes).
 */
function localBranches() {
  return execResult('git', ['branch', '--list']).stdout
    .split('\n')
    .map(line => line.replace(/^[*+\s]+/, '').trim())
    .filter(Boolean);
}

function currentBranch() {
  return execResult('git', ['branch', '--show-current']).stdout.trim();
}

/**
 * Returns the production ref name to use for ancestor / tip comparisons.
 * Prefers `origin/production` because `git fetch --prune` (step 1) updates the
 * remote-tracking ref but **NOT** local `production` branch — using local can
 * miss freshly-merged branches in the window between PR merge and the next
 * manual `git fetch origin production:production` fast-forward. Falls back to
 * local `production` when no origin (offline / test fixtures without origin).
 *
 * Memoised within a single script invocation to avoid repeating the rev-parse
 * during loops over many branch tips.
 */
let _productionRef = null;
function productionRef() {
  if (_productionRef) return _productionRef;
  const remoteResult = execResult('git', ['rev-parse', '--verify', 'origin/production']);
  const remote = remoteResult.ok ? remoteResult.stdout.trim() : '';
  _productionRef = remote ? 'origin/production' : 'production';
  effectiveScope.productionRef = {
    ref: _productionRef,
    fallback: !remote,
    reason: remote ? '' : firstFailureLine(remoteResult),
  };
  return _productionRef;
}

/**
 * Returns 'origin/main' when it resolves, else null. Deliberately does NOT
 * fall back to local `main` (see design.md D2): `origin/main` unresolvable
 * means either no origin or `main` has not been pushed to it, and in both cases the
 * pre-existing (more conservative) classification is already accurate, so a
 * fallback would only ever fire on paths this change has no reason to touch.
 *
 * Memoisation note: unlike `productionRef()`, this can legitimately return
 * `null`, so `if (_mainlineRef) return _mainlineRef;` would rerun the
 * `rev-parse` on every call in the null case. Use an explicit computed flag
 * (`undefined` = not yet computed) instead.
 */
let _mainlineRef;
function mainlineRef() {
  if (_mainlineRef !== undefined) return _mainlineRef;
  const result = execResult('git', ['rev-parse', '--verify', 'origin/main']);
  _mainlineRef = result.ok ? 'origin/main' : null;
  effectiveScope.mainlineRef = {
    ref: _mainlineRef,
    reason: result.ok ? '' : firstFailureLine(result),
  };
  return _mainlineRef;
}

/**
 * Returns a memoised three-state containment result: which local branches'
 * tips are reachable from `mainlineRef()` (i.e. their content is already
 * present in `origin/main` history). `status`:
 *   - 'verified'      — query succeeded; `set` is trustworthy.
 *   - 'unavailable'   — `mainlineRef()` is null (origin/main unresolvable).
 *   - 'query-failed'  — mainline ref resolved but `for-each-ref` failed
 *                        (`reason` set).
 * The latter two both yield an empty `set`, but that emptiness is NOT the
 * same claim as 'verified' returning an empty set (which means "verified:
 * nothing merged"). Callers MUST branch on `status`, never on `set.size`.
 *
 * Single batched `git for-each-ref --merged <ref> refs/heads/` query — no
 * per-branch ancestor-check spawn (the `merge-base --is-ancestor` subcommand
 * that `isAncestorOfProduction()` uses), and no branch-name interpolation
 * into a shell command (advisory handoff quoting is separate —
 * `advisoryBranchArg()`; git probes stay argv-form).
 */
let _mainlineContainment;
function mainlineContainment() {
  if (_mainlineContainment) return _mainlineContainment;
  const ref = mainlineRef();
  if (!ref) {
    _mainlineContainment = { status: 'unavailable', set: new Set() };
    return _mainlineContainment;
  }
  const result = execResult('git', [
    'for-each-ref',
    '--format=%(refname:short)',
    '--merged',
    ref,
    'refs/heads/',
  ]);
  _mainlineContainment = result.ok
    ? {
      status: 'verified',
      set: new Set(result.stdout.split('\n').map(l => l.trim()).filter(Boolean)),
    }
    : { status: 'query-failed', set: new Set(), reason: firstFailureLine(result) };
  return _mainlineContainment;
}

/**
 * Returns true if the branch tip is reachable from the `production` branch
 * (i.e., already merged into the production line). Single source of truth for
 * "shipped" → "deletable". Replaces the older tag-containment check; ancestor
 * semantic also covers (a) release/<name> lane branches that merge into production
 * but live separate from main, and (b) corner cases where tag push lagged
 * production push. (rules/* lane products use prune-rules-lane.mjs — tip is
 * typically main-only after cherry-pick to production.)
 */
function isAncestorOfProduction(tip) {
  if (!tip) return false;
  return execResult('git', ['merge-base', '--is-ancestor', tip, productionRef()]).ok;
}

/** True when tip is reachable from verified mainline ref (`origin/main`). */
function isAncestorOfMainline(tip) {
  if (!tip) return false;
  const ref = mainlineRef();
  if (!ref) return false;
  return execResult('git', ['merge-base', '--is-ancestor', tip, ref]).ok;
}

/**
 * Step 6A evidence for a shipped release/<name>: some production-* tag that contains the tip
 * is already in origin/main. A release branch is cut from main, so its own tip being in
 * origin/main proves nothing before the back-merge (the full-main case); the tag is the
 * production-side commit the back-merge brings into main. Unverifiable → false (kept).
 */
function releaseBackMergedToMain(tip) {
  const ref = mainlineRef();
  if (!ref || !tip) return false;
  const result = execResult('git', [
    'for-each-ref', '--format=%(refname:short)', '--contains', tip, '--merged', ref, 'refs/tags/production-*',
  ]);
  return result.ok && result.stdout.trim() !== '';
}

/**
 * Why a linked worktree must not be removed, or null when it is clean. Uncommitted or
 * untracked files count, and so does a dirty submodule (--ignore-submodules=none overrides
 * submodule.<name>.ignore). The node_modules dependency link that removal tears down first is
 * not the operator's work, so it does not count. A failed probe counts as dirty.
 */
function worktreeDirtyReason(wtPath) {
  // --untracked-files=normal: status.showUntrackedFiles=no would otherwise hide untracked files.
  const result = execResult('git', ['-C', wtPath, 'status', '--porcelain', '--ignore-submodules=none', '--untracked-files=normal']);
  if (!result.ok) return `git status failed (${firstFailureLine(result)})`;
  const changes = result.stdout.split('\n').filter(Boolean).filter((line) => {
    const name = line.slice(3).replace(/\/$/, '');
    return !(line.startsWith('?? ') && DEPENDENCY_REPARSE_NAMES.includes(name) && isReparseOrSymlink(join(wtPath, name)));
  });
  return changes.length > 0 ? WORKTREE_DIRTY : null;
}

/** Returns remote tracking branches as a Set of short names (without 'origin/') */
function remoteTrackingBranches() {
  const result = execResult('git', ['branch', '-r', '--list', 'origin/' + '*']);
  if (!result.ok) {
    effectiveScope.remoteTracking = {
      ok: false,
      count: 0,
      reason: firstFailureLine(result),
    };
    return new Set();
  }
  const refs = result.stdout
    .split('\n')
    .map(l => l.trim().replace(/^origin\//, ''))
    .filter(Boolean);
  effectiveScope.remoteTracking = { ok: true, count: refs.length };
  return new Set(refs);
}

/**
 * Returns true if the branch was previously configured to track a remote
 * (i.e. `branch.<name>.remote` is set, which `git push -u`/`--set-upstream`/
 * checkout-from-remote write). This is a weak push-history proxy, not proof:
 * a plain `git push origin <b>` (no `-u`) never writes this config, so a
 * branch can be pushed and this still reads false. It is used only to pick
 * between the `orphaned` and `untracked local-only` labels for refs that are
 * NOT already known mainline-contained (see `mainlineContainment()`), which
 * is checked first because content reachability is strictly stronger evidence
 * than this tracking-config proxy.
 * One `git config --get-regexp` snapshot of every branch.<name>.remote key replaces
 * the old per-branch probe (independent point lookups → in-memory Map). Fail-open:
 * a failed/empty snapshot yields an empty Map, so every branch reads as untracked —
 * exactly what the old per-branch probe returned on failure. Last value wins for a
 * duplicated key, matching `git config <key>` (--get) semantics.
 */
let _branchRemotes = null;
function branchRemotes() {
  if (_branchRemotes) return _branchRemotes;
  _branchRemotes = new Map();
  // argv form, not a quoted shell string: this probe decides `orphaned` vs
  // `untracked local-only`, and on cmd.exe a single-quoted regex arrives with
  // literal quotes, matches nothing, and mislabels every tracked branch as
  // "never pushed" — the exact false claim this classification must not make.
  const probe = execResult('git', ['config', '--get-regexp', '^branch\\..*\\.remote$']);
  const out = probe.stdout;
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const key = line.slice(0, sp); // branch.<name>.remote (name may itself contain dots)
    const name = key.slice('branch.'.length, -'.remote'.length);
    if (!name) continue;
    _branchRemotes.set(name, line.slice(sp + 1).trim());
  }
  return _branchRemotes;
}

function hadRemoteTracking(branch) {
  return branchRemotes().get(branch) === 'origin';
}

/**
 * Allow-release tracking probe for `branch.<name>.remote` (any remote, including `.`).
 * Distinct from orphaned-classifier `branchRemotes()` / `hadRemoteTracking` fail-open:
 * unavailable evidence must NOT authorize delete.
 *
 * - exit 1 + empty stdout → normal no-match → no tracking (ok)
 * - other nonzero / timeout / parse failure → fail-closed
 * - exit 0 → parse map; target key present → has tracking
 *
 * @returns {{ ok: true, hasTracking: boolean } | { ok: false, reason: string }}
 */
function probeAllowReleaseRemoteTracking(branch) {
  let stdout;
  let status;
  try {
    stdout = execGitFileSync(
      ['config', '--get-regexp', '^branch\\..*\\.remote$'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: LS_REMOTE_TIMEOUT_MS,
      },
    );
    status = 0;
  } catch (err) {
    status = err.status ?? null;
    stdout = String(err.stdout || '');
    const detail =
      String(err.stderr || err.message || 'config --get-regexp failed')
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean) || 'config --get-regexp failed';
    if (err.killed || err.code === 'ETIMEDOUT') {
      return { ok: false, reason: `timeout: ${detail}` };
    }
    // git config --get-regexp: exit 1 + empty stdout = no matching keys.
    if (status === 1 && !stdout.trim()) {
      return { ok: true, hasTracking: false };
    }
    return { ok: false, reason: detail };
  }

  if (!String(stdout).trim()) {
    // Exit 0 with empty body is undecidable (normal no-match is exit 1).
    return { ok: false, reason: 'undecidable empty config --get-regexp success' };
  }

  let sawValid = false;
  let hasTracking = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) {
      return { ok: false, reason: 'undecidable config --get-regexp line' };
    }
    const key = line.slice(0, sp); // branch.<name>.remote (name may contain dots)
    if (!key.startsWith('branch.') || !key.endsWith('.remote')) {
      return { ok: false, reason: 'undecidable config key shape' };
    }
    const name = key.slice('branch.'.length, -'.remote'.length);
    if (!name) {
      return { ok: false, reason: 'undecidable empty branch name in tracking key' };
    }
    sawValid = true;
    if (name === branch) hasTracking = true;
  }
  if (!sawValid) {
    return { ok: false, reason: 'undecidable config --get-regexp parse' };
  }
  return { ok: true, hasTracking };
}

/**
 * Live proof that EVERY configured remote lacks `refs/heads/<branch>`.
 * MUST NOT use local `refs/remotes/<remote>/<branch>` as sole evidence.
 * Fail-closed on `git remote` failure, option-like remote names (leading `-`),
 * or any ls-remote nonzero/timeout/undecidable.
 * ls-remote argv MUST use end-of-options `--` before `<remote>` / refspec so an
 * option-like remote name cannot be parsed as a Git option (e.g. `--upload-pack=`).
 *
 * @returns {{ ok: true, exists: boolean } | { ok: false, reason: string }}
 */
function liveRemoteSameNameCheck(branch) {
  const remotesResult = execResult('git', ['remote']);
  if (!remotesResult.ok) {
    return {
      ok: false,
      reason: firstFailureLine(remotesResult),
    };
  }
  const remotes = remotesResult.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const wantRef = `refs/heads/${branch}`;
  for (const remote of remotes) {
    // Defense in depth: never pass a leading-dash remote into git argv as an option.
    if (remote.startsWith('-')) {
      return { ok: false, reason: `${remote}: option-like remote name rejected` };
    }
    let stdout;
    try {
      stdout = execGitFileSync(
        ['ls-remote', '--heads', '--', remote, wantRef],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LS_REMOTE_TIMEOUT_MS,
        },
      );
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message || 'ls-remote failed')
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean) || 'ls-remote failed';
      return { ok: false, reason: `${remote}: ${detail}` };
    }
    for (const line of String(stdout).split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      const ref = tab === -1 ? line.trim() : line.slice(tab + 1).trim();
      if (ref === wantRef) {
        return { ok: true, exists: true };
      }
      // Undecidable / unexpected shape → fail-closed (do not treat as absent).
      return { ok: false, reason: `${remote}: undecidable ls-remote output` };
    }
  }
  return { ok: true, exists: false };
}

/**
 * tip ∈ production OR origin/main. No local `main` fallback.
 */
function tipContainedInProductionOrMainline(tip) {
  if (isAncestorOfProduction(tip)) return true;
  const ml = mainlineRef();
  if (!ml) return false;
  try {
    execGitFileSync(['merge-base', '--is-ancestor', tip, ml], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the local branch tip only via `refs/heads/<branch>`.
 * MUST NOT use ambiguous short names — a same-named tag can win `rev-parse <branch>`
 * and falsely authorize deleting an uncontained release branch.
 *
 * @returns {{ ok: true, tip: string } | { ok: false }}
 */
function resolveLocalBranchTip(branch) {
  const tipResult = execResult('git', [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}^{commit}`,
  ]);
  const tip = tipResult.stdout.trim();
  if (!tipResult.ok || !tip) return { ok: false };
  return { ok: true, tip };
}

/**
 * Live OID of origin's exact `refs/heads/<branch>` (no suffix/prefix matches).
 * `oid: null` means origin verifiably has no such branch.
 *
 * @returns {{ ok: true, oid: string|null, exactRef: string } | { ok: false, reason: string }}
 */
function liveOriginBranchOid(branch) {
  const exactRef = `refs/heads/${branch}`;
  const live = execResult('git', ['ls-remote', 'origin', exactRef]);
  if (!live.ok) return { ok: false, reason: `ls-remote failed: ${firstFailureLine(live)}` };
  const line = live.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => {
      const parts = l.split(/\s+/);
      return parts.length >= 2 && parts[1] === exactRef;
    });
  if (!line) return { ok: true, oid: null, exactRef };
  const oid = line.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(oid)) {
    return { ok: false, reason: `origin/${branch} unreadable in ls-remote output` };
  }
  return { ok: true, oid: oid.toLowerCase(), exactRef };
}

/** Work branches the batch scan covers (its prefixes minus release/*, which is retained). */
function isBatchScannedWorkBranch(branch) {
  return !branch.startsWith(SHARED_RELEASE_PREFIX) && PRUNE_BRANCH_PREFIXES.some((p) => branch.startsWith(p));
}

/**
 * Batch command that already owns deleting origin/<branch> at `oid`, or null
 * when no batch path covers it (then a named delete is the only way out).
 * Mirrors the batch criteria: work prefixes → production-ancestor or
 * origin/main-ancestor tiers; rules/* → prune-rules-lane (tip in origin/main).
 */
function batchOwnerForRemoteTip(branch, oid) {
  if (branch.startsWith('rules/')) {
    return isAncestorOfMainline(oid) ? 'node .devpro/scripts/prune-rules-lane.mjs --include-remote --exec' : null;
  }
  if (!isBatchScannedWorkBranch(branch)) return null;
  if (isAncestorOfProduction(oid)) return remoteDeleteEntrypoint({ includeSubsumed: false });
  if (isAncestorOfMainline(oid)) {
    return remoteDeleteEntrypoint({ includeSubsumed: false, includeUnshippedMainline: true });
  }
  return null;
}

/**
 * Read-only plan for `--force-delete <branch> --include-remote`. Exits before
 * any mutation when origin cannot be checked or a batch path owns the branch.
 *
 * @returns {{ oid: string|null, exactRef: string }}
 */
function planNamedRemoteDelete(branch) {
  const refuse = (message) => {
    console.error(`拒絕：${message}；未刪除任何東西`);
    process.exit(1);
  };
  const fetched = execResult('git', ['fetch', '--prune', 'origin']);
  if (!fetched.ok) refuse(`git fetch --prune origin 失敗（${firstFailureLine(fetched)}）`);
  const live = liveOriginBranchOid(branch);
  if (!live.ok) refuse(`無法確認 origin/${branch}：${live.reason}`);
  if (!live.oid) return { oid: null, exactRef: live.exactRef };
  if (!execResult('git', ['cat-file', '-e', `${live.oid}^{commit}`]).ok) {
    refuse(`origin/${branch} 的 tip ${live.oid} 在 fetch 後仍不在本機，無法判斷是否已合併`);
  }
  if ((branch.startsWith('rules/') || isBatchScannedWorkBranch(branch)) && !mainlineRef()) {
    refuse('origin/main 無法解析，無法判斷這條分支是否已由批次清理負責');
  }
  const owner = batchOwnerForRemoteTip(branch, live.oid);
  if (owner) {
    refuse(`origin/${branch} 已合進 main 或已上線，由批次清理負責；先跑該腳本不帶參數的 dry-run 確認清單，再執行：\n  ${owner}`);
  }
  return { oid: live.oid, exactRef: live.exactRef };
}

/**
 * Allow-release predicates after PROTECTED/current/existence guards.
 * @returns {{ state: 'verified'|'verified-ineligible'|'probe-failed', eligible: boolean, ok: boolean, reasons: string[] }}
 */
function evaluateAllowReleaseRemoteAndContainment(target, tip) {
  const reasons = [];
  let probeFailed = false;
  const tracking = probeAllowReleaseRemoteTracking(target);
  if (!tracking.ok) {
    probeFailed = true;
    reasons.push(`remote tracking 探測失敗（fail-closed）：${tracking.reason}`);
  } else if (tracking.hasTracking) {
    reasons.push('仍有 remote tracking config');
  }
  const live = liveRemoteSameNameCheck(target);
  if (!live.ok) {
    probeFailed = true;
    reasons.push(`遠端同名 live 探測失敗（fail-closed）：${live.reason}`);
  } else if (live.exists) {
    reasons.push('至少一個 remote 仍有同名 refs/heads/<branch>');
  }
  if (!tipContainedInProductionOrMainline(tip)) {
    reasons.push('tip 不在 production 或 origin/main 歷史中');
  }
  if (reasons.length > 0) {
    return {
      state: probeFailed ? 'probe-failed' : 'verified-ineligible',
      eligible: false,
      ok: false,
      reasons,
    };
  }
  return { state: 'verified', eligible: true, ok: true, reasons: [] };
}

/** Dry-run / advisory: true only when allow-release predicates already proven. */
function isAllowReleaseEligible(branch) {
  if (LOCAL_ONLY) return false;
  if (isProtectedBaseBranch(branch) || !branch.startsWith(RELEASE_PREFIX)) return false;
  if (currentBranch() === branch) return false;
  const resolved = resolveLocalBranchTip(branch);
  if (!resolved.ok) return false;
  return evaluateAllowReleaseRemoteAndContainment(branch, resolved.tip).ok;
}

/**
 * One --force-delete line: the command to copy, or, when the name has
 * shell-special characters on Windows, a request to quote it by hand.
 */
function printForceDeleteLine(branch, flags) {
  const arg = advisoryBranchArg(branch);
  console.log(arg === null
    ? `      （分支名含 shell 特殊字元：依你的 shell 為分支名加引號，再以 ${flags} 執行 prune-merged-local.mjs）`
    : `      node .devpro/scripts/prune-merged-local.mjs ${flags} ${arg}`);
}

/**
 * Per-ref advisory hint lines for orphaned / untracked / mainlineContained.
 * @returns {{ forceDeleteHint: boolean }} whether a --force-delete route was printed
 */
function printForceDeleteAdvisoryForBranch(branch) {
  if (isProtectedBaseBranch(branch)) {
    console.log('      （受保護分支：不可刪除、不可走 --force-delete／--allow-release）');
    return { forceDeleteHint: false };
  }
  if (branch.startsWith(RELEASE_PREFIX)) {
    if (LOCAL_ONLY) {
      console.log('      （release evidence unverified：explicit --local-only zero-network；僅可用 non-executable verification rerun，移除 --local-only 後重跑 dry-run）');
      return { forceDeleteHint: false };
    }
    const resolved = resolveLocalBranchTip(branch);
    const evidence = resolved.ok
      ? evaluateAllowReleaseRemoteAndContainment(branch, resolved.tip)
      : { state: 'probe-failed', eligible: false, ok: false, reasons: ['local branch tip unresolved'] };
    if (evidence.eligible) {
      printForceDeleteLine(branch, '--force-delete --allow-release');
      return { forceDeleteHint: true };
    }
    const explanation = evidence.state === 'probe-failed'
      ? 'verification probe failed or remained undecidable'
      : 'fresh verification completed and confirmed an eligibility disqualifier';
    console.log(`      （release evidence ${evidence.state}：${explanation}；${evidence.reasons.join('；')}；不輸出 executable deletion handoff）`);
    return { forceDeleteHint: false };
  }
  printForceDeleteLine(branch, '--force-delete');
  return { forceDeleteHint: true };
}

/**
 * Returns non-main linked worktrees: [{ path, head, branch }]
 * Skips bare worktrees and the main worktree (first entry).
 */
function linkedWorktrees() {
  // Equivalent command spelling for operator/search documentation: git worktree list --porcelain
  const result = execResult('git', ['worktree', 'list', '--porcelain']);
  if (!result.ok) {
    if (!effectiveScope.worktreeSnapshot) {
      effectiveScope.worktreeSnapshot = {
        ok: false,
        count: 0,
        reason: firstFailureLine(result),
      };
    }
    return [];
  }
  const entries = [];
  let cur = {};
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      if (cur.path !== undefined) entries.push(cur);
      cur = { path: trimmed.slice('worktree '.length) };
    } else if (trimmed.startsWith('HEAD ')) {
      cur.head = trimmed.slice('HEAD '.length);
    } else if (trimmed.startsWith('branch refs/heads/')) {
      cur.branch = trimmed.slice('branch refs/heads/'.length);
    } else if (trimmed === 'bare') {
      cur.bare = true;
    }
  }
  if (cur.path !== undefined) entries.push(cur);
  // First entry is always the main worktree — skip it
  const linked = entries.slice(1).filter(e => !e.bare && e.branch);
  if (!effectiveScope.worktreeSnapshot) {
    effectiveScope.worktreeSnapshot = { ok: true, count: linked.length };
  }
  return linked;
}

function linkedWorktreesForBranch(branch) {
  return linkedWorktrees().filter(wt => wt.branch === branch);
}

function worktreeRemoveArgv(wt, { force = false } = {}) {
  const remove = ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path];
  return process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...remove] : remove;
}

function worktreeRemoveCommandForDisplay(wt, options) {
  return `git ${worktreeRemoveArgv(wt, options).slice(0, -1).join(' ')} ${displayQuote(wt.path)}`;
}

function runWorktreeRemove(wt, force) {
  try {
    execGitFileSync(worktreeRemoveArgv(wt, { force }), { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
    return null;
  } catch (err) {
    return err;
  }
}

function directoryState(target, mayBePartiallyDeleted = false) {
  try {
    lstatSync(toNamespacedPath(target));
    return mayBePartiallyDeleted ? 'directory remains (contents may be partially deleted)' : 'directory remains';
  } catch (err) {
    return err.code === 'ENOENT' ? 'directory absent' : `directory state unknown (${firstFailureLine(err)})`;
  }
}

function reportWorktreeRemovalFailure(wt, err) {
  const registry = execResult('git', ['worktree', 'list', '--porcelain']);
  const state = registry.ok
    ? (registry.stdout.split('\n').some(line => line.startsWith('worktree ') && normalizePathKey(line.slice(9)) === normalizePathKey(wt.path)) ? 'registered' : 'unregistered')
    : `registry unknown (${firstFailureLine(registry)})`;
  console.error(`mutation failed for ${wt.branch || wt.path}: worktree ${state}; ${directoryState(wt.path, err.worktreeMutationAttempted === true)}; branch retained (branch deletion not attempted); no later mutations attempted (${firstFailureLine(err)})`);
  if (err.dependencyFailure) console.error(firstFailureLine(err.dependencyFailure));
}

function verifiedMainCheckoutRoot() {
  const identity = resolveMainCheckoutRoot(process.cwd());
  if (identity.identitySource !== 'git-common-dir') {
    throw new Error('main-checkout identity unverified: git-common-dir probe failed; mutation refused');
  }
  return identity.mainCheckoutRoot;
}

function removeLinkedWorktree(wt) {
  // Checked before anything is touched: a worktree with changes keeps its files and its branch.
  const dirty = worktreeDirtyReason(wt.path);
  if (dirty) {
    throw new Error(`worktree has ${dirty}; commit, stash or remove them first (to discard them: git worktree remove --force ${displayQuote(wt.path)})`);
  }
  const mainRoot = verifiedMainCheckoutRoot();
  const preCount = dependencyEntryCount(mainRoot);
  let primaryError;
  try {
    if (pathHasDependencyReparse(wt.path)) {
      console.log(`  ${REPARSE_RM_RF_ADVISORY}`);
      console.log(`  ${REPARSE_SAFE_TEARDOWN_ADVISORY}`);
    }
    tearDownWorktreeDependencyReparses(wt.path);
    console.log(`\n  ▶ executing: ${worktreeRemoveCommandForDisplay(wt)}`);
    let removeError = runWorktreeRemove(wt, false);
    if (removeError && SUBMODULE_REMOVE_REFUSAL_RE.test(String(removeError.stderr || ''))) {
      // git removes a worktree that contains a submodule only with --force. Re-check right
      // before forcing so a change made since the first check is never discarded.
      const recheck = worktreeDirtyReason(wt.path);
      if (recheck) throw new Error(`worktree has ${recheck}; not forced`);
      console.log(`  ▶ executing: ${worktreeRemoveCommandForDisplay(wt, { force: true })}  (clean; git refuses a plain remove because it contains a submodule)`);
      removeError = runWorktreeRemove(wt, true);
    }
    if (removeError) {
      if (removeError.stderr) process.stderr.write(String(removeError.stderr));
      throw removeError;
    }
  } catch (err) {
    primaryError = err;
  }
  try {
    checkDependencyInvariant(mainRoot, preCount);
    console.log(`  main-checkout dependency invariant: ${preCount === null ? 'N/A (node_modules absent)' : `unchanged (${preCount} entries)`}`);
  } catch (err) {
    if (primaryError) primaryError.dependencyFailure = err;
    else primaryError = err;
  }
  if (primaryError) {
    primaryError.worktreeMutationAttempted = true;
    throw primaryError;
  }
}

// Exact named opt-in; this mode never enters branch scanning or remote mutations.
if (MODE === '--remove-orphan') {
  let target = resolve(ARGS[0]);
  let mainRoot;
  let preCount;
  let deletionAttempted = false;
  try {
    const registry = execResult('git', ['worktree', 'list', '--porcelain']);
    if (!registry.ok) throw new Error(`registry probe failed: ${firstFailureLine(registry)}`);
    mainRoot = verifiedMainCheckoutRoot();
    const container = join(mainRoot, '.worktree');
    try {
      if (lstatSync(toNamespacedPath(container)).isSymbolicLink()) throw new Error(`refuse linked/reparse container: ${container}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Canonicalize the parent only; never follow the target link itself.
    target = join(realpathSync(dirname(target)), basename(target));
    const currentRoot = realpathSync(process.cwd());
    const currentRelative = relative(target, currentRoot);
    if (dirname(target) !== container || target === mainRoot || currentRelative === '' || (currentRelative !== '..' && !currentRelative.startsWith(`..${sep}`) && !isAbsolute(currentRelative))) {
      throw new Error('target must be a first-level child of main-checkout .worktree and must not be current checkout or its ancestor');
    }
    if (registry.stdout.split('\n').some(line => line.startsWith('worktree ') && normalizePathKey(line.slice(9)) === normalizePathKey(target))) {
      throw new Error('refuse registered worktree target');
    }
    inspectOrphanTree(mainRoot, container, target);
    preCount = dependencyEntryCount(mainRoot);
    deletionAttempted = true;
    let primaryError;
    try { rmSync(toNamespacedPath(target), { recursive: true, force: false }); }
    catch (err) { primaryError = err; }
    try {
      checkDependencyInvariant(mainRoot, preCount);
      console.log(`main-checkout dependency invariant: ${preCount === null ? 'N/A (node_modules absent)' : `unchanged (${preCount} entries)`}`);
    } catch (err) {
      if (primaryError) primaryError.dependencyFailure = err;
      else primaryError = err;
    }
    if (primaryError) throw primaryError;
    console.log(`orphan removed: ${target}; ${directoryState(target)}; no branch/remote mutations attempted`);
    process.exit(0);
  } catch (err) {
    console.error(`orphan removal ${deletionAttempted ? 'failed' : 'refused'}: ${firstFailureLine(err)}; ${directoryState(target, deletionAttempted)}; no branch/remote mutations attempted; ${orphanRefusalNextStep(err, deletionAttempted)}`);
    if (err.dependencyFailure) console.error(firstFailureLine(err.dependencyFailure));
    process.exit(1);
  }
}

// ─── --keep mode ─────────────────────────────────────────────────────────────

if (MODE === '--keep') {
  if (ARGS.length === 0) {
    console.error('用法：--keep <branch-name> [<branch-name>...]');
    process.exit(1);
  }
  const added = appendKeepList(ARGS);
  if (added.length === 0) {
    console.log('（所有指定分支已在 keep 清單中，未變更）');
  } else {
    console.log(`已寫入 keep 清單 (${keepFilePath()})：`);
    for (const n of added) console.log(`  + ${n}`);
  }
  process.exit(0);
}

// ─── --keep-list mode ─────────────────────────────────────────────────────────

if (MODE === '--keep-list') {
  const keep = readKeepList();
  if (keep.size === 0) {
    console.log('（keep 清單為空）');
  } else {
    console.log(`keep 清單（${keepFilePath()}）：`);
    for (const n of [...keep].sort()) console.log(`  - ${n}`);
  }
  process.exit(0);
}

// ─── --force-delete mode（廢棄分支 escape hatch；單分支顯式覆蓋）────────────────

if (MODE === '--force-delete') {
  if (ARGS.length === 0) {
    console.error('用法：--force-delete <branch-name>');
    console.error('      --force-delete <branch-name> --include-remote（連同 origin 同名分支，以 OID lease 刪除）');
    console.error('      --force-delete --allow-release <release/branch>（廢棄本地 release/<name>）');
    process.exit(1);
  }
  const target = ARGS[0];
  // 拒絕受保護分支（main/master/production）；release/<name> 需雙重 opt-in
  if (isProtectedBaseBranch(target)) {
    console.error(`拒絕：受保護分支 \`${target}\`（main/master/production/integration 不可走此路徑）`);
    process.exit(1);
  }
  if (INCLUDE_REMOTE && target.startsWith(RELEASE_PREFIX)) {
    console.error(`拒絕：\`${target}\` 是 release 分支；放棄的 release/*（含 release/rules-*）刻意保留，--include-remote 不刪 release 分支（見 git-branch-hygiene.md）。`);
    console.error('已上線的 release 分支由批次清理處理：node .devpro/scripts/prune-merged-local.mjs --include-remote --exec 或 node .devpro/scripts/prune-rules-lane.mjs --include-remote --exec');
    process.exit(1);
  }
  if (target.startsWith(RELEASE_PREFIX)) {
    if (!ALLOW_RELEASE) {
      console.error(`拒絕：受保護分支 \`${target}\`（main/master/production/integration/release/<name> 不可走此路徑）`);
      process.exit(1);
    }
  } else if (ALLOW_RELEASE) {
    console.error('拒絕：--allow-release 僅適用於 release/<name> 分支');
    process.exit(1);
  }
  if (LOCAL_ONLY && target.startsWith(RELEASE_PREFIX)) {
    console.error('拒絕：release evidence unverified：remote freshness intentionally skipped by explicit --local-only zero-network mode.');
    console.error('請移除 --local-only 並以 verification-only dry-run 重新取得 fresh live proof：');
    console.error('  node .devpro/scripts/prune-merged-local.mjs');
    process.exit(1);
  }
  // 非五前綴工作分支（如 pr-<n>-review、fetched head）不 hard-block：
  // 真正的安全核心是上面的 protected / release/<name> 與下面的 current-branch；
  // 五前綴命名對安全核心無增益，硬擋只會讓 escape hatch 對合法臨時 ref 變死路。
  // 改為印醒目警示後照常走透明刪除路徑（tip / tags / worktree → git branch -D）。
  // 警示延到 current-branch + existence 兩道 guard 之後才印，避免對「會被拒絕的 target」
  // 先印出矛盾的「放行後刪除」訊息。
  const isWorkBranchPrefix = /^(feature|bugfix|chore|hotfix|rules)\//.test(target) || isLocalReviewBranch(target);
  // 拒絕當前分支
  if (currentBranch() === target) {
    console.error(`拒絕：當前 checked-out 分支不可刪除（先 git switch 到 main）`);
    process.exit(1);
  }
  // 透明印出分支 metadata 供使用者驗證（必須綁 refs/heads，禁短名歧義／同名 tag）
  const resolved = resolveLocalBranchTip(target);
  if (!resolved.ok && !INCLUDE_REMOTE) {
    console.error(`分支 \`${target}\` 不存在於本地`);
    const arg = advisoryBranchArg(target);
    console.error(arg === null
      ? '若只剩 origin 上的同名分支：依你的 shell 為分支名加引號後執行 prune-merged-local.mjs --force-delete <該分支> --include-remote'
      : `若只剩 origin 上的同名分支：node .devpro/scripts/prune-merged-local.mjs --force-delete ${arg} --include-remote`);
    process.exit(1);
  }
  const tip = resolved.ok ? resolved.tip : null;
  if (target.startsWith(RELEASE_PREFIX) && ALLOW_RELEASE) {
    const pred = evaluateAllowReleaseRemoteAndContainment(target, tip);
    if (!pred.ok) {
      const explanation = pred.state === 'probe-failed'
        ? 'verification probe failed or remained undecidable'
        : 'fresh verification completed and confirmed an eligibility disqualifier';
      console.error(`拒絕：--allow-release evidence ${pred.state}（${explanation}；fail-closed）：${pred.reasons.join('；')}`);
      process.exit(1);
    }
  }
  // --include-remote：所有檢查在任何刪除之前完成（fetch、exact-ref ls-remote、批次歸屬）
  const remotePlan = INCLUDE_REMOTE ? planNamedRemoteDelete(target) : null;
  if (!tip && !remotePlan?.oid) {
    console.error(`分支 \`${target}\` 不存在於本地，origin 也沒有同名分支；未刪除任何東西`);
    process.exit(1);
  }
  // target 確定可刪除（非 protected/current 且存在；release 已過 allow-release 謂詞；
  // --include-remote 已過批次歸屬檢查）才印非標準警示
  if (!isWorkBranchPrefix && !target.startsWith(RELEASE_PREFIX)) {
    console.log(`⚠️  非標準工作分支 \`${target}\`（非 feature/bugfix/chore/hotfix/rules 前綴）— escape hatch 放行，仍透明列出 metadata 後刪除。`);
  }
  console.log(`分支 \`${target}\` 強制刪除：`);
  if (tip) {
    const tags = execResult('git', ['tag', '--contains', tip]).stdout
      .split('\n').filter(Boolean);
    console.log(`  tip SHA: ${tip}`);
    console.log(`  contained in tags: ${tags.length > 0 ? tags.join(', ') : '(none — 廢棄分支或未發佈)'}`);
  } else {
    console.log('  local: (不存在，只刪 origin)');
  }
  if (remotePlan) {
    console.log(`  origin/${target}: ${remotePlan.oid || '(不存在，只刪本地)'}`);
  }
  // 沒有本地 ref 時也取快照（結果為空）：快照失敗一律在任何刪除前停下
  const targetWorktrees = linkedWorktreesForBranch(target);
  if (effectiveScope.worktreeSnapshot?.ok !== true) {
    console.error(`worktree snapshot probe-failed before mutation: ${effectiveScope.worktreeSnapshot?.reason || 'unknown failure'}; no mutations attempted`);
    process.exit(1);
  }
  for (const wt of targetWorktrees) {
    const dirty = worktreeDirtyReason(wt.path);
    if (dirty) {
      console.error(`拒絕：linked worktree ${displayQuote(wt.path)} has ${dirty}; commit, stash or remove them first (to discard them: git worktree remove --force ${displayQuote(wt.path)})；未刪除任何東西`);
      process.exit(1);
    }
  }
  // 先刪 remote（OID lease：remote tip 在檢查後若被推進就拒絕），再刪本地。
  // DEVPRO_PRUNE_REMOTE_DELETE=1 讓 git-native pre-push hook 認得這是 canonical 清理路徑。
  let remoteState = '';
  if (remotePlan?.oid) {
    const leaseSpec = `${remotePlan.exactRef}:${remotePlan.oid}`;
    const deleteRefspec = `:${remotePlan.exactRef}`;
    console.log(`  執行：git push origin --force-with-lease=${leaseSpec} ${deleteRefspec}`);
    try {
      execGitFileSync(['push', 'origin', `--force-with-lease=${leaseSpec}`, deleteRefspec], {
        stdio: 'inherit',
        env: { ...process.env, DEVPRO_PRUNE_REMOTE_DELETE: '1' },
      });
    } catch (err) {
      // A non-zero push does not prove the ref survived (the server may have applied
      // the delete before the reply was lost), so read origin back before reporting.
      const after = liveOriginBranchOid(target);
      let remoteOutcome;
      if (!after.ok) remoteOutcome = `origin/${target} state unknown (${after.reason})`;
      else if (after.oid === null) remoteOutcome = `origin/${target} deleted despite the push error`;
      else if (after.oid === remotePlan.oid) remoteOutcome = `origin/${target} retained`;
      else remoteOutcome = `origin/${target} moved to ${after.oid}; retained`;
      console.error(`mutation failed: ${remoteOutcome}; local branch untouched; no later mutations attempted (${firstFailureLine(err)})`);
      process.exit(1);
    }
    remoteState = `origin/${target} deleted`;
    console.log(`已刪除：origin/${target}（remote）`);
  }
  if (!tip) process.exit(0);
  for (const wt of targetWorktrees) {
    console.log(`  linked worktree: ${wt.path}`);
    try {
      removeLinkedWorktree(wt);
    } catch (err) {
      reportWorktreeRemovalFailure(wt, err);
      if (remotePlan?.oid) console.error(`  (${remoteState}; local branch retained)`);
      process.exit(1);
    }
  }
  console.log(`  執行：git branch -D ${target}`);
  // 內層 git 呼叫不過 Claude Code PreToolUse hook（由 node child process spawn）
  try {
    execGitFileSync(['branch', '-D', target], { stdio: 'inherit' });
  } catch (err) {
    const worktreeState = targetWorktrees.length > 0 ? 'worktree removed' : 'no worktree mutation';
    const remotePart = remotePlan?.oid ? `${remoteState}; ` : '';
    console.error(`mutation failed: ${remotePart}${worktreeState}; branch retained; no later mutations attempted (${firstFailureLine(err)})`);
    process.exit(1);
  }
  console.log(`已刪除：${target}（local）`);
  process.exit(0);
}

// ─── default scan mode（dry）／--exec mode（execute）─────────────────────────

function main() {
  if (EXEC) {
    console.log('=== EXECUTION MODE / USER APPROVAL REQUIRED ===');
    console.log(INCLUDE_REMOTE
      ? 'This run will remove listed branches/worktrees AND confirmed remote refs.'
      : 'This run will remove listed local branches/worktrees only. Remote refs are advisory-only.');
    console.log('Continue only if the user explicitly approved this exact cleanup.');
  } else {
    console.log('=== DRY-RUN ONLY / USER APPROVAL REQUIRED ===');
    console.log('No branches/worktrees will be removed in this run.');
    console.log('Run `--exec` only after the user explicitly approves the listed local/worktree deletions.');
    console.log('Remote deletions require explicit `--include-remote --exec` approval.');
    console.log('Unshipped-mainline (main-contained ∩ ¬prod) requires `--include-unshipped-mainline` (plus `--include-remote` for remotes).');
  }

  console.log(LOCAL_ONLY ? '[1/4] git fetch --prune skipped (explicit --local-only zero-network)' : '[1/4] git fetch --prune');
  const fetchResult = LOCAL_ONLY
    ? { ok: false, stdout: '', stderr: 'unverified: explicit --local-only zero-network', status: null }
    : execResult('git', ['fetch', '--prune']);
  effectiveScope.fetch = fetchResult.ok
    ? { ok: true }
    : { ok: false, reason: firstFailureLine(fetchResult) };
  if (!fetchResult.ok) {
    console.log(`  ⚠️  fetch failed; continuing in degraded dry-run scope: ${effectiveScope.fetch.reason}`);
    if (EXEC && !LOCAL_ONLY) {
      printEffectiveScopeSummary();
      console.error('Refusing --exec because git fetch --prune failed; rerun after fetch succeeds.');
      process.exit(1);
    }
  }

  console.log('[2/4] checking for production branch');
  // 尚未有 production（第一次上線前）時，「已上線」三層（production-ancestor／
  // subsumed／archive）沒有比對對象而略過；已合進 origin/main 那層照常判定，
  // 所以 --include-unshipped-mainline 仍可清理已合併的分支。
  const hasProduction = execResult('git', ['rev-parse', '--verify', productionRef()]).ok;
  if (!hasProduction) {
    console.log('  no production branch found — shipped tiers skipped; only the main-contained tier (--include-unshipped-mainline) applies');
  }
  const shippedToProduction = (tip) => hasProduction && isAncestorOfProduction(tip);
  const evaluateShippedPatchTiers = EVALUATE_SUBSUMED && hasProduction;

  const keep = readKeepList();
  const current = currentBranch();
  const productionPatchIdCache = new Map();

  // ── Local + remote branches (ancestor of `production` branch) ──────────────
  console.log('[3/4] scanning local + remote branches for production-ancestor reachability');

  const localCandidates = [];
  const remoteCandidates = [];
  const subsumedLocalCandidates = [];
  const subsumedRemoteCandidates = [];
  // Third tier: branches whose entire diff vs production is byte-identical archive
  // folder content (catches rebase-merged branches that patch-id subsumption misses,
  // e.g. when a replayed commit's patch-id drifted). Fail-closed: any non-archive
  // diff disqualifies, so superseded older rule versions are NOT auto-deleted.
  const archiveShippedLocalCandidates = [];
  const archiveShippedRemoteCandidates = [];
  // Independent consent tier: verified main-contained ∩ ¬production-ancestor.
  // MUST NOT OR into shipped / isAncestorOfProduction. release/<name> stays advisory-only.
  const unshippedMainlineLocalCandidates = [];
  const unshippedMainlineRemoteCandidates = [];
  const localMutationTips = new Map();
  // Tip each shipped remote candidate had in this scan; the remote delete leases on it.
  const remoteScanTips = new Map();
  // Shipped release/<name> whose production tag is not in origin/main yet (Step 6A pending).
  const awaitingBackMerge = [];

  // Resolve containment once before the scan loop (also feeds D4 abort below).
  const containment = mainlineContainment();
  const containmentUsable = containment.status === 'verified';

  if (INCLUDE_UNSHIPPED_MAINLINE && !containmentUsable) {
    printEffectiveScopeSummary();
    console.error(
      'Refusing --include-unshipped-mainline: mainline containment is not verified (abort before any mutation, including otherwise-shipped candidates).',
    );
    process.exit(1);
  }

  for (const { scope, name, tip } of listBranches()) {
    // Strip 'origin/' prefix for keep-list lookup (keep list uses short names)
    const shortName = name.replace(/^origin\//, '');

    // Skip protected branches
    if (isProtectedBaseBranch(shortName)) continue;

    // Skip keep list
    if (keep.has(shortName) || keep.has(name)) continue;

    // Skip the current branch (local only)
    if (scope === 'local' && name === current) continue;

    if (!tip) continue;

    if (shortName.startsWith(RULES_RELEASE_PREFIX)) continue;
    // A shipped release branch is the head of the Step 6A back-merge PR: keep it until then.
    if (shortName.startsWith(RELEASE_PREFIX) && !releaseBackMergedToMain(tip)) {
      if (shippedToProduction(tip)) awaitingBackMerge.push(name);
      continue;
    }

    if (shippedToProduction(tip)) {
      if (scope === 'local') {
        localCandidates.push(name);
        localMutationTips.set(name, tip);
      } else {
        // remote: store short name (without 'origin/') for push --delete command
        remoteCandidates.push(shortName);
        remoteScanTips.set(shortName, tip);
      }
    } else if (evaluateShippedPatchTiers && isSubsumedBySquash(name, productionRef(), { productionPatchIdCache })) {
      // squash-rewritten merge breaks tip ancestry; patch-id match still proves shipped.
      // Covers both local branches and remote branches (squash-orphan that lost ancestry).
      if (scope === 'local') {
        subsumedLocalCandidates.push(name);
        localMutationTips.set(name, tip);
      } else {
        subsumedRemoteCandidates.push(shortName);
        remoteScanTips.set(shortName, tip);
      }
    } else if (evaluateShippedPatchTiers && isArchiveOnlyShipped(name, productionRef())) {
      // Third tier (fail-closed): patch-id missed it, but the branch's entire diff
      // vs production is byte-identical archive-folder content → shipped via archive.
      if (scope === 'local') {
        archiveShippedLocalCandidates.push(name);
        localMutationTips.set(name, tip);
      } else {
        archiveShippedRemoteCandidates.push(shortName);
        remoteScanTips.set(shortName, tip);
      }
    } else if (
      containmentUsable &&
      !shortName.startsWith(SHARED_RELEASE_PREFIX) &&
      (
        (scope === 'local' && containment.set.has(name)) ||
        (scope === 'remote' && isAncestorOfMainline(tip))
      )
    ) {
      if (scope === 'local') {
        unshippedMainlineLocalCandidates.push(name);
        localMutationTips.set(name, tip);
      } else {
        // Retain scanned tip OID so remote delete can revalidate before mutation
        // (CRITICAL: name-only push --delete is TOCTOU against tip movement).
        unshippedMainlineRemoteCandidates.push({ name: shortName, tipOid: tip });
      }
    }
  }

  /**
   * Revalidate an unshipped-mainline remote tip immediately before delete.
   * Fail closed if ls-remote fails, OID drifted, tip became production-shipped,
   * tip is no longer mainline-contained, or mainline evidence is degraded.
   * Uses exact `refs/heads/<name>` query (no suffix-prefix false matches).
   */
  function revalidateUnshippedMainlineRemoteBeforeDelete(candidate) {
    const name = candidate?.name;
    const expectedOid = candidate?.tipOid;
    if (!name || !expectedOid) {
      return { ok: false, reason: 'missing scanned name/tipOid' };
    }
    if (!containmentUsable) {
      return { ok: false, reason: 'mainline containment no longer verified' };
    }
    const live = liveOriginBranchOid(name);
    if (!live.ok) return { ok: false, reason: live.reason };
    if (!live.oid) {
      return { ok: false, reason: `origin/${name} missing or unreadable at delete time` };
    }
    const { oid: liveOid, exactRef } = live;
    if (liveOid !== String(expectedOid).toLowerCase()) {
      return {
        ok: false,
        reason: `origin/${name} tip drifted (${expectedOid.slice(0, 12)}… → ${liveOid.slice(0, 12)}…); refuse delete`,
      };
    }
    if (isAncestorOfProduction(liveOid)) {
      return {
        ok: false,
        reason: `origin/${name} is now production-ancestor; refuse unshipped-mainline delete path`,
      };
    }
    if (!isAncestorOfMainline(liveOid)) {
      return {
        ok: false,
        reason: `origin/${name} is no longer mainline-contained; refuse delete`,
      };
    }
    return { ok: true, liveOid, exactRef };
  }

  // ── Orphan detection (remote ref pruned, previously tracked origin) ──────────
  // Scan all local branches not covered by listBranches patterns
  const remoteRefs = remoteTrackingBranches();
  const orphaned = [];
  // Untracked local-only refs: refs with no matching remote ref AND no
  // remote-tracking config AND (when verified) tip not reachable from
  // mainlineRef(). This is the residual bucket after `mainlineContained` and
  // `orphaned` are removed — it does NOT prove the ref has not been pushed: a
  // plain `git push origin <b>` (no `-u`) writes no tracking config either,
  // so a pushed-then-remote-deleted, never-merged branch lands here too.
  // Advisory-only — NEVER auto-deleted by --exec (see summary).
  const untrackedLocalOnly = [];
  // Mainline-contained advisory residual: release/<name> (dual opt-in only) and any
  // non-candidate leftovers that still need force-delete guidance. Ordinary
  // non-release unshipped-mainline tips live in unshippedMainline* candidates.
  const mainlineContained = [];
  const mainlineQualifier = containmentUsable ? ` and tip not in ${mainlineRef()}` : '';
  const allLocal = localBranches();
  for (const b of allLocal) {
    if (b === current) continue;
    if (isProtectedBaseBranch(b)) continue;
    if (keep.has(b)) continue;
    // rules/<name> and release/rules-* are owned by prune-rules-lane.mjs — keep them out of
    // orphan/mainline advisories too; a release waiting for Step 6A gets no deletion hint.
    if (b.startsWith('rules/') || b.startsWith(RULES_RELEASE_PREFIX)) continue;
    if (awaitingBackMerge.includes(b)) continue;
    // Only flag as mainline-contained / orphan / untracked if NOT already a
    // deletion candidate. archiveShippedLocalCandidates MUST be excluded too: a
    // branch with no remote ref/tracking can also reach the archive-shipped tier
    // (its diff is byte-identical archive content already in production). Such a
    // branch has a production backup and is governed by the archive-shipped
    // deletion path; listing it in an advisory-only block would double-classify
    // it — --exec would delete a ref the same run labels "NEVER auto-deleted"
    // (cross-model CRITICAL: advisory-only contract violation).
    if (
      localCandidates.includes(b) ||
      subsumedLocalCandidates.includes(b) ||
      archiveShippedLocalCandidates.includes(b) ||
      unshippedMainlineLocalCandidates.includes(b)
    ) {
      continue;
    }
    if (!remoteRefs.has(b)) {
      if (containmentUsable && containment.set.has(b)) {
        mainlineContained.push(b);
      } else if (hadRemoteTracking(b)) {
        orphaned.push(b);
      } else {
        untrackedLocalOnly.push(b);
      }
    }
  }

  // ── Worktree scan (ancestor of `production` branch) ────────────────────────
  console.log('[4/4] scanning worktrees for production-ancestor reachability');
  const worktreeCandidates = [];
  const subsumedWorktreeCandidates = [];
  const unshippedMainlineWorktreeCandidates = [];
  const allLinkedWorktrees = linkedWorktrees();
  for (const wt of allLinkedWorktrees) {
    if (keep.has(wt.branch)) continue;
    // rules/* and release/rules-* worktrees are owned by prune-rules-lane.mjs
    if (wt.branch.startsWith('rules/') || wt.branch.startsWith(RULES_RELEASE_PREFIX)) continue;
    if (wt.branch.startsWith(RELEASE_PREFIX) && !releaseBackMergedToMain(wt.head)) continue;
    // Local PR verification has no production lifecycle. Only named force-delete
    // may remove its registered worktree through the existing safe teardown.
    if (isLocalReviewBranch(wt.branch)) continue;
    if (shippedToProduction(wt.head)) {
      worktreeCandidates.push(wt);
    } else if (evaluateShippedPatchTiers && isSubsumedBySquash(wt.branch, productionRef(), { productionPatchIdCache })) {
      subsumedWorktreeCandidates.push(wt);
    } else if (
      containmentUsable &&
      !wt.branch.startsWith(SHARED_RELEASE_PREFIX) &&
      (containment.set.has(wt.branch) || isAncestorOfMainline(wt.head))
    ) {
      unshippedMainlineWorktreeCandidates.push(wt);
    }
  }

  // A worktree with uncommitted or untracked changes is never removed, and neither is its
  // branch (git refuses to delete a checked-out branch anyway).
  // Remote lists hold short names, so one name set covers local, remote and worktree tiers.
  const branchCandidateLists = [
    localCandidates, subsumedLocalCandidates, archiveShippedLocalCandidates, unshippedMainlineLocalCandidates,
    remoteCandidates, subsumedRemoteCandidates, archiveShippedRemoteCandidates, unshippedMainlineRemoteCandidates,
  ];
  const worktreeCandidateLists = [worktreeCandidates, subsumedWorktreeCandidates, unshippedMainlineWorktreeCandidates];
  const candidateBranches = new Set([...branchCandidateLists.flat(), ...worktreeCandidateLists.flat().map((wt) => wt.branch)]);
  const dirtyWorktrees = [];
  for (const wt of allLinkedWorktrees) {
    if (!candidateBranches.has(wt.branch)) continue;
    const reason = worktreeDirtyReason(wt.path);
    if (reason) dirtyWorktrees.push({ ...wt, reason });
  }
  const dirtyBranches = new Set(dirtyWorktrees.map((wt) => wt.branch));
  for (const list of branchCandidateLists) {
    for (let i = list.length - 1; i >= 0; i -= 1) if (dirtyBranches.has(list[i])) list.splice(i, 1);
  }
  for (const list of worktreeCandidateLists) {
    for (let i = list.length - 1; i >= 0; i -= 1) if (dirtyBranches.has(list[i].branch)) list.splice(i, 1);
  }

  const filesystemOrphans = scanFilesystemWorktreeOrphans();

  // ── Summary output ───────────────────────────────────────────────────────────
  printEffectiveScopeSummary();
  printFilesystemOrphanAdvisory(filesystemOrphans);

  const hasAnything =
    localCandidates.length > 0 ||
    subsumedLocalCandidates.length > 0 ||
    remoteCandidates.length > 0 ||
    subsumedRemoteCandidates.length > 0 ||
    archiveShippedLocalCandidates.length > 0 ||
    archiveShippedRemoteCandidates.length > 0 ||
    unshippedMainlineLocalCandidates.length > 0 ||
    unshippedMainlineRemoteCandidates.length > 0 ||
    worktreeCandidates.length > 0 ||
    subsumedWorktreeCandidates.length > 0 ||
    unshippedMainlineWorktreeCandidates.length > 0 ||
    orphaned.length > 0 ||
    untrackedLocalOnly.length > 0 ||
    mainlineContained.length > 0 ||
    awaitingBackMerge.length > 0 ||
    dirtyWorktrees.length > 0 ||
    filesystemOrphans.length > 0;

  if (!hasAnything) {
    console.log('  no branches or worktrees eligible for deletion');
    if (keep.size > 0) {
      console.log(`  （另有 ${keep.size} 條分支在 keep 清單中被跳過）`);
    }
    // filesystem orphan advisory already printed above when present
    return;
  }

  if (awaitingBackMerge.length > 0) {
    console.log(`\n  ⏸  ${awaitingBackMerge.length} shipped release branch ref(s) kept until Step 6A merges the production tag back into ${mainlineRef() || 'origin/main'} (the back-merge PR uses the release branch as its head):`);
    for (const b of awaitingBackMerge) console.log(`    ${b}`);
  }

  if (dirtyWorktrees.length > 0) {
    console.log(`\n  ⏸  ${dirtyWorktrees.length} worktree(s) skipped: ${WORKTREE_DIRTY} (their branches are kept too):`);
    for (const wt of dirtyWorktrees) console.log(`    ${wt.path}  (${wt.branch})  [${wt.reason}]`);
    console.log('  Commit, stash or remove those changes, then rerun this dry-run.');
  }

  // Display order: local → remote → worktree (informational).
  // Execution order: worktrees FIRST, then local branches, then remote — because
  // `git branch -d <X>` fails while a worktree still has <X> checked out (per
  // the empirical 2026-05-10 hit when chore/bump-v6.41.1 had its worktree).
  if (localCandidates.length > 0) {
    console.log(`\n  ✅ ${localCandidates.length} local branch(es) confirmed shipped (tip is ancestor of \`production\`):`);
    for (const b of localCandidates) {
      console.log(`    ${b}`);
    }
    if (!EXEC) {
      console.log('\n  To delete local branch(es) after user confirmation:');
      console.log(`    git branch -d ${localCandidates.join(' ')}`);
    }
  }

  if (subsumedLocalCandidates.length > 0) {
    console.log(`\n  ✅ ${subsumedLocalCandidates.length} local branch(es) confirmed subsumed-by-squash (patch IDs present in production):`);
    for (const b of subsumedLocalCandidates) {
      console.log(`    ${b}  [subsumed-by-squash]`);
    }
    if (!EXEC) {
      console.log('\n  To delete subsumed branch(es) after user confirmation:');
      console.log('    node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec');
    }
  }

  if (remoteCandidates.length > 0) {
    console.log(`\n  ✅ ${remoteCandidates.length} remote branch(es) confirmed shipped (tip is ancestor of \`production\`):`);
    for (const b of remoteCandidates) {
      console.log(`    origin/${b}`);
    }
    if (!EXEC || !INCLUDE_REMOTE) {
      console.log('\n  Remote refs are NOT deleted by the default local cleanup path.');
      console.log('  To delete confirmed remote branch(es) after explicit remote-delete approval:');
      console.log(`    ${remoteDeleteEntrypoint({ includeSubsumed: false })}`);
    }
  }

  if (subsumedRemoteCandidates.length > 0) {
    console.log(`\n  ✅ ${subsumedRemoteCandidates.length} remote branch(es) confirmed subsumed-by-squash (patch IDs present in production):`);
    for (const b of subsumedRemoteCandidates) {
      console.log(`    origin/${b}  [subsumed-by-squash]`);
    }
    if (!EXEC || !INCLUDE_REMOTE) {
      console.log('\n  Remote refs are NOT deleted by the default local cleanup path.');
      console.log('  To delete subsumed remote branch(es) after explicit remote-delete approval:');
      console.log(`    ${remoteDeleteEntrypoint()}`);
    }
  }

  if (archiveShippedLocalCandidates.length > 0) {
    console.log(`\n  ✅ ${archiveShippedLocalCandidates.length} local branch(es) confirmed archive-shipped (entire diff vs production is byte-identical archive-folder content):`);
    for (const b of archiveShippedLocalCandidates) {
      console.log(`    ${b}  [archive-shipped]`);
    }
    if (!EXEC) {
      console.log('\n  To delete archive-shipped branch(es) after user confirmation:');
      console.log('    node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec');
    }
  }

  if (archiveShippedRemoteCandidates.length > 0) {
    console.log(`\n  ✅ ${archiveShippedRemoteCandidates.length} remote branch(es) confirmed archive-shipped (entire diff vs production is byte-identical archive-folder content):`);
    for (const b of archiveShippedRemoteCandidates) {
      console.log(`    origin/${b}  [archive-shipped]`);
    }
    if (!EXEC || !INCLUDE_REMOTE) {
      console.log('\n  Remote refs are NOT deleted by the default local cleanup path.');
      console.log('  To delete archive-shipped remote branch(es) after explicit remote-delete approval:');
      console.log(`    ${remoteDeleteEntrypoint()}`);
    }
  }

  if (unshippedMainlineLocalCandidates.length > 0) {
    console.log(`\n  ℹ️  ${unshippedMainlineLocalCandidates.length} local branch(es) classified unshipped-mainline (verified main-contained ∩ not production-ancestor; NOT shipped):`);
    for (const b of unshippedMainlineLocalCandidates) {
      console.log(`    ${b}  [unshipped-mainline]`);
    }
    if (!EXEC || !INCLUDE_UNSHIPPED_MAINLINE) {
      console.log('\n  Unshipped-mainline local refs require explicit consent (not plain --exec):');
      console.log('    node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --exec');
    }
  }

  if (unshippedMainlineRemoteCandidates.length > 0) {
    console.log(`\n  ℹ️  ${unshippedMainlineRemoteCandidates.length} remote branch(es) classified unshipped-mainline (verified main-contained ∩ not production-ancestor; NOT shipped):`);
    for (const b of unshippedMainlineRemoteCandidates) {
      console.log(`    origin/${b.name}  [unshipped-mainline]`);
    }
    console.log('\n  ⚠️  Deleting these remote refs before production makes the next release Step 1 label each unit `restore`:');
    console.log('      release-step-1-7.md Step 1 branch-health check 4 requires refs/remotes/origin/<branch>; the only');
    console.log('      in-rule way back is the authorized restore there (last MERGED same-repo PR headRefOid).');
    if (!EXEC || !INCLUDE_REMOTE || !INCLUDE_UNSHIPPED_MAINLINE) {
      console.log('\n  Unshipped-mainline remote refs require stronger consent than shipped remote cleanup:');
      console.log(`    ${remoteDeleteEntrypoint({ includeUnshippedMainline: true })}`);
    }
  }

  if (worktreeCandidates.length > 0) {
    console.log(`\n  ✅ ${worktreeCandidates.length} worktree(s) confirmed shipped (head is ancestor of \`production\`):`);
    for (const wt of worktreeCandidates) {
      console.log(`    path: ${wt.path}  branch: ${wt.branch}`);
    }
    if (!EXEC) {
      console.log('\n  To remove worktree(s) after user confirmation:');
      for (const wt of worktreeCandidates) {
        console.log(`    ${worktreeRemoveCommandForDisplay(wt)}`);
      }
    }
  }

  if (subsumedWorktreeCandidates.length > 0) {
    console.log(`\n  ✅ ${subsumedWorktreeCandidates.length} worktree(s) confirmed subsumed-by-squash (linked branch patch IDs present in production):`);
    for (const wt of subsumedWorktreeCandidates) {
      console.log(`    path: ${wt.path}  branch: ${wt.branch}  [subsumed-by-squash]`);
    }
    if (!EXEC) {
      console.log('\n  To remove subsumed worktree(s) after user confirmation:');
      console.log('    node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec');
    }
  }

  if (unshippedMainlineWorktreeCandidates.length > 0) {
    console.log(`\n  ℹ️  ${unshippedMainlineWorktreeCandidates.length} worktree(s) classified unshipped-mainline (verified main-contained ∩ not production-ancestor; NOT shipped):`);
    for (const wt of unshippedMainlineWorktreeCandidates) {
      console.log(`    path: ${wt.path}  branch: ${wt.branch}  [unshipped-mainline]`);
    }
    if (!EXEC || !INCLUDE_UNSHIPPED_MAINLINE) {
      console.log('\n  Unshipped-mainline worktrees require explicit consent:');
      console.log('    node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --exec');
    }
  }

  if (EXEC) {
    if (effectiveScope.worktreeSnapshot?.ok !== true) {
      console.error(`worktree snapshot probe-failed before mutation: ${effectiveScope.worktreeSnapshot?.reason || 'unknown failure'}; no mutations attempted`);
      process.exitCode = 1;
      return;
    }
    const localMutationTargets = [
      ...localCandidates,
      ...subsumedLocalCandidates,
      ...archiveShippedLocalCandidates,
      ...(INCLUDE_UNSHIPPED_MAINLINE ? unshippedMainlineLocalCandidates : []),
    ];
    // Plan -d versus -D entirely from read-only state before the first mutation.
    // A failed -d is a terminal write failure; it is never caught and upgraded.
    const currentTipResult = current
      ? execResult('git', ['rev-parse', '--verify', `refs/heads/${current}^{commit}`])
      : { ok: false, stdout: '' };
    const currentTip = currentTipResult.ok ? currentTipResult.stdout.trim() : '';
    const localMutationPlans = new Map(localMutationTargets.map((branch) => {
      const tip = localMutationTips.get(branch) || '';
      const mergedIntoCurrent = tip && currentTip
        ? execResult('git', ['merge-base', '--is-ancestor', tip, currentTip]).ok
        : false;
      return [branch, mergedIntoCurrent ? '-d' : '-D'];
    }));
    const removedWorktreePaths = new Set();
    // Each target is an ordered unit: its worktree(s), then its branch. A failure
    // returns from the outer loop immediately; completed mutations are reported,
    // never described as rolled back.
    for (const [targetIndex, b] of localMutationTargets.entries()) {
      let removedForTarget = 0;
      for (const wt of allLinkedWorktrees.filter((entry) => entry.branch === b)) {
        try {
          removeLinkedWorktree(wt);
          removedWorktreePaths.add(wt.path);
          removedForTarget += 1;
        } catch (err) {
          reportWorktreeRemovalFailure(wt, err);
          process.exitCode = 1;
          return;
        }
      }
      const deleteFlag = localMutationPlans.get(b);
      console.log(`\n  ▶ executing: git branch ${deleteFlag} ${b}`);
      try {
        execGitFileSync(['branch', deleteFlag, b], { stdio: 'inherit' });
      } catch (err) {
        const worktreeState = removedForTarget > 0 ? 'worktree removed' : 'no worktree mutation';
        const untouchedLaterTargets = [
          ...localMutationTargets.slice(targetIndex + 1),
          ...[
            ...worktreeCandidates,
            ...subsumedWorktreeCandidates,
            ...(INCLUDE_UNSHIPPED_MAINLINE ? unshippedMainlineWorktreeCandidates : []),
          ]
            .filter((wt) => !removedWorktreePaths.has(wt.path))
            .map((wt) => wt.branch),
          ...(INCLUDE_REMOTE
            ? [
              ...remoteCandidates,
              ...subsumedRemoteCandidates,
              ...archiveShippedRemoteCandidates,
              ...(INCLUDE_UNSHIPPED_MAINLINE
                ? unshippedMainlineRemoteCandidates.map((c) => c.name)
                : []),
            ].map((branch) => `origin/${branch}`)
            : []),
        ];
        const laterSummary = untouchedLaterTargets.length > 0
          ? untouchedLaterTargets.join(', ')
          : '(none)';
        const escalationState = deleteFlag === '-d' ? 'no -D escalation; ' : '';
        console.error(`mutation failed for ${b}: ${worktreeState}; branch retained; ${escalationState}untouched later targets: ${laterSummary}; no later mutations attempted (${firstFailureLine(err)})`);
        process.exitCode = 1;
        return;
      }
    }
    // Worktree-only candidates are ordered after local branch targets.
    for (const wt of [
      ...worktreeCandidates,
      ...subsumedWorktreeCandidates,
      ...(INCLUDE_UNSHIPPED_MAINLINE ? unshippedMainlineWorktreeCandidates : []),
    ]) {
      if (removedWorktreePaths.has(wt.path)) continue;
      try {
        removeLinkedWorktree(wt);
      } catch (err) {
        reportWorktreeRemovalFailure(wt, err);
        process.exitCode = 1;
        return;
      }
    }
    // Remote targets run only after every local target completes. The default
    // --exec path is local-only so cleanup handoffs can safely express "do not touch
    // remote" intent without relying on prose outside the command line.
    if (INCLUDE_REMOTE) {
      // Set DEVPRO_PRUNE_REMOTE_DELETE=1 on this specific invocation so the git-native
      // pre-push hook (hooks-git/pre-push) recognizes this as the canonical, audited
      // cleanup path and lets the deletion through. A raw `git push origin --delete` from
      // anywhere else carries no marker and is still hard-blocked (issue #947 finding 1).
      const shippedRemoteMutationTargets = [
        ...remoteCandidates,
        ...subsumedRemoteCandidates,
        ...archiveShippedRemoteCandidates,
      ];
      for (const b of shippedRemoteMutationTargets) {
        // Lease on the tip this run classified (fresh from fetch --prune): if someone pushed to
        // the branch since, the delete is rejected instead of discarding their commits.
        const exactRef = `refs/heads/${b}`;
        const leaseSpec = `${exactRef}:${remoteScanTips.get(b)}`;
        console.log(`\n  ▶ executing: git push origin --force-with-lease=${leaseSpec} :${exactRef}`);
        try {
          execGitFileSync(['push', 'origin', `--force-with-lease=${leaseSpec}`, `:${exactRef}`], {
            stdio: 'inherit',
            env: { ...process.env, DEVPRO_PRUNE_REMOTE_DELETE: '1' },
          });
        } catch (err) {
          console.error(`mutation failed for origin/${b}: remote ref retained; no later mutations attempted (${firstFailureLine(err)})`);
          process.exitCode = 1;
          return;
        }
      }
      if (INCLUDE_UNSHIPPED_MAINLINE) {
        for (const candidate of unshippedMainlineRemoteCandidates) {
          const recheck = revalidateUnshippedMainlineRemoteBeforeDelete(candidate);
          if (!recheck.ok) {
            console.error(
              `mutation refused for origin/${candidate.name}: ${recheck.reason}; remote ref retained; no later mutations attempted`,
            );
            process.exitCode = 1;
            return;
          }
          // OID-conditioned delete: refuse if remote tip moved after revalidation.
          // `git push --delete` alone is name-only; force-with-lease binds expected OID.
          const leaseSpec = `${recheck.exactRef}:${recheck.liveOid}`;
          const deleteRefspec = `:${recheck.exactRef}`;
          console.log(
            `\n  ▶ executing: git push origin --force-with-lease=${leaseSpec} ${deleteRefspec}  [unshipped-mainline OID lease ${recheck.liveOid.slice(0, 12)}]`,
          );
          try {
            execGitFileSync(
              ['push', 'origin', `--force-with-lease=${leaseSpec}`, deleteRefspec],
              {
                stdio: 'inherit',
                env: { ...process.env, DEVPRO_PRUNE_REMOTE_DELETE: '1' },
              },
            );
          } catch (err) {
            console.error(`mutation failed for origin/${candidate.name}: remote ref retained; no later mutations attempted (${firstFailureLine(err)})`);
            process.exitCode = 1;
            return;
          }
        }
      }
    } else {
      const skippedRemoteCount =
        remoteCandidates.length +
        subsumedRemoteCandidates.length +
        archiveShippedRemoteCandidates.length +
        (INCLUDE_UNSHIPPED_MAINLINE ? unshippedMainlineRemoteCandidates.length : 0);
      if (skippedRemoteCount > 0) {
        console.log(`\n  ℹ️  skipped ${skippedRemoteCount} remote ref(s): default --exec is local-only.`);
        console.log('  Remote deletion requires explicit approval and command:');
        console.log(`    ${remoteDeleteEntrypoint({
          includeUnshippedMainline: INCLUDE_UNSHIPPED_MAINLINE && unshippedMainlineRemoteCandidates.length > 0,
        })}`);
      }
    }
  }

  if (orphaned.length > 0) {
    console.log(`\n  ⚠️  ${orphaned.length} orphaned branch(es) (remote ref pruned${mainlineQualifier} — possibly squash-merged; verify manually):`);
    let orphanForceDeleteHint = false;
    for (const b of orphaned) {
      console.log(`    ${b}`);
      if (printForceDeleteAdvisoryForBranch(b).forceDeleteHint) orphanForceDeleteHint = true;
    }
    console.log('  NOTE: squash merge breaks tip ancestry；--exec 不自動刪 orphan，請逐個確認後用上方 per-ref 指令（release/<name> 不得抄單旗標 --force-delete）：');
    if (orphanForceDeleteHint) {
      console.log(FORCE_DELETE_LINKED_WORKTREE_WARNING);
    }
  }

  if (untrackedLocalOnly.length > 0) {
    console.log(`\n  ⚠️  ${untrackedLocalOnly.length} untracked local-only ref(s) (no remote ref or tracking evidence; no remote backup — verify before deleting):`);
    let untrackedForceDeleteHint = false;
    for (const b of untrackedLocalOnly) {
      console.log(`    ${b}`);
      if (printForceDeleteAdvisoryForBranch(b).forceDeleteHint) untrackedForceDeleteHint = true;
    }
    const mainlineNote = containmentUsable ? `且 tip 不在 ${mainlineRef()} 歷史中，` : '';
    console.log(`  NOTE: 這些 ref 沒有遠端同名 ref、也沒有 tracking config 紀錄，${mainlineNote}沒有遠端備份；--exec 絕不自動刪除（advisory-only），只能逐個用上面的 --force-delete／合格時的 --allow-release 移除。`);
    if (untrackedForceDeleteHint) {
      console.log(FORCE_DELETE_LINKED_WORKTREE_WARNING);
    }
  }

  if (mainlineContained.length > 0) {
    console.log(`\n  ℹ️  ${mainlineContained.length} local ref(s) already contained in ${mainlineRef()} (deleting these loses no commits):`);
    let mainlineForceDeleteHint = false;
    for (const b of mainlineContained) {
      console.log(`    ${b}`);
      if (printForceDeleteAdvisoryForBranch(b).forceDeleteHint) mainlineForceDeleteHint = true;
    }
    console.log(`  NOTE: 這些 ref 的 commit 已存在於 ${mainlineRef()} 歷史中，刪除本地 ref 不會遺失任何 commit；`);
    console.log('        plain --exec 不自動刪除。非 release/<name> 例行清理請用 --include-unshipped-mainline --exec；');
    console.log('        release/<name> 或其他需單支覆蓋者用上面的 --force-delete／合格時的 --allow-release。');
    if (mainlineForceDeleteHint) {
      console.log(FORCE_DELETE_LINKED_WORKTREE_WARNING);
    }
  }

  if (keep.size > 0) {
    console.log(`\n  （另有 ${keep.size} 條分支在 keep 清單中被跳過；如需重新顯示，刪除 .git/info/deletable-keep 對應行）`);
  }

  if (EXEC) {
    console.log('\n  ✅ --exec 完成');
  } else {
    console.log('\n  ⚠️  dry-run（未執行；這是無參數模式，沒有 --dry-run 旗標）。要實際刪除：');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --exec   # scan 確認的 local/worktree 批次刪除（不刪 remote）');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --include-remote --exec   # 顯式遠端刪除 opt-in（production-shipped）');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --exec   # verified main-contained ∩ ¬prod local/worktree');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --include-remote --exec   # unshipped-mainline remote stronger consent');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec   # Squash-Source Cleanup local/worktree（不刪 remote）');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --include-subsumed --include-remote --exec   # Squash-Source Cleanup + 顯式遠端刪除');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --force-delete <branch>   # 廢棄分支單一覆蓋，只刪本地（拒絕 protected/release/current）');
    console.log('    node .devpro/scripts/prune-merged-local.mjs --force-delete <branch> --include-remote   # 同上並以 OID lease 刪 origin 同名分支（拒絕 release/*）');
    if (LOCAL_ONLY) {
      console.log('    release evidence unverified: remote freshness intentionally skipped by explicit --local-only zero-network; verification rerun (non-executable):');
      console.log('    node .devpro/scripts/prune-merged-local.mjs');
    } else {
      console.log('    node .devpro/scripts/prune-merged-local.mjs --force-delete --allow-release release/<branch>   # 廢棄本地 release/<name> 雙重 opt-in');
    }
  }
  console.log('  若需保留某分支，執行 --keep 寫入 keep 清單避免下次再問：');
  console.log('    node .devpro/scripts/prune-merged-local.mjs --keep <branch> [<branch>...]');
  console.log('  (Per git-branch-hygiene.md: confirm with user before executing any deletion.)');
}

main();
