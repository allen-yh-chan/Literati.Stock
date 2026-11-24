/**
 * Shared argv parsing / printed-command shape validation for prune-merged-local.mjs.
 * Pure: no git, no process side effects. Used by the CLI and contract-guard tests.
 */

import { isProtectedBaseBranch } from '../hooks/lib/branch-naming.mjs';

export const SCAN_FLAGS = new Set([
  '--include-subsumed',
  '--exec',
  '--local-only',
  '--include-remote',
  '--include-unshipped-mainline',
]);

/** Companion flags filtered before MODE (same layer as SCAN_FLAGS; not VALID_MODES). */
export const COMPANION_FLAGS = new Set(['--allow-release']);

export const VALID_MODES = new Set([undefined, '--keep', '--keep-list', '--force-delete', '--remove-orphan']);

export const RELEASE_PREFIX = 'release/';
/** git's stderr when a plain `worktree remove` refuses a worktree that contains a submodule. */
export const SUBMODULE_REMOVE_REFUSAL_RE = /working trees containing submodules cannot be moved or removed/i;

/**
 * @param {string[]} rawArgs
 * @returns {{
 *   includeSubsumed: boolean,
 *   exec: boolean,
 *   localOnly: boolean,
 *   includeRemote: boolean,
 *   includeUnshippedMainline: boolean,
 *   allowRelease: boolean,
 *   mode: string|undefined,
 *   args: string[],
 *   validMode: boolean,
 * }}
 */
export function parsePruneArgv(rawArgs) {
  const allowRelease = rawArgs.includes('--allow-release');
  const nonMode = new Set([...SCAN_FLAGS, ...COMPANION_FLAGS]);
  const positional = rawArgs.filter((a) => !nonMode.has(a));
  const mode = positional[0];
  const args = positional.slice(1);
  return {
    includeSubsumed: rawArgs.includes('--include-subsumed'),
    exec: rawArgs.includes('--exec'),
    localOnly: rawArgs.includes('--local-only'),
    includeRemote: rawArgs.includes('--include-remote'),
    includeUnshippedMainline: rawArgs.includes('--include-unshipped-mainline'),
    allowRelease,
    mode,
    args,
    validMode: VALID_MODES.has(mode),
  };
}

function posixSingleQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const PLAIN_BRANCH_ARG_RE = /^[A-Za-z0-9._\/-]+$/;

/**
 * Branch argument for a copy-pastable deletion command, or null when no single
 * spelling is safe. Plain names stay bare on every platform. Other names are
 * single-quoted on POSIX; on Windows the pasting shell (cmd, PowerShell, Git Bash)
 * is unknown and their quoting rules conflict, so callers print the branch name
 * and ask the operator to quote it instead of printing an executable command.
 *
 * @param {string} value
 * @param {NodeJS.Platform} [platform=process.platform]
 * @returns {string|null}
 */
export function advisoryBranchArg(value, platform = process.platform) {
  const s = String(value);
  if (PLAIN_BRANCH_ARG_RE.test(s)) return s;
  if (platform === 'win32') return null;
  return posixSingleQuote(s);
}

// Nothing here is special inside double quotes in cmd, PowerShell or Git Bash.
// Excluded: a doubled backslash (Git Bash collapses it to one) and a trailing
// backslash (it would escape the closing quote).
const WINDOWS_DOUBLE_QUOTABLE_PATH_RE = /^(?!.*\\\\)(?!.*\\$)[A-Za-z0-9 ._\\/:-]+$/;

/**
 * Path argument for a copy-pastable command, or null when no single spelling is
 * safe. POSIX: single-quoted. Windows: double-quoted only when the path holds
 * nothing but letters, digits, space and `. _ \ / : -`; otherwise null, and
 * callers ask the operator to quote the printed path for their shell.
 *
 * @param {string} value
 * @param {NodeJS.Platform} [platform=process.platform]
 * @returns {string|null}
 */
export function advisoryPathArg(value, platform = process.platform) {
  const s = String(value);
  if (platform !== 'win32') return posixSingleQuote(s);
  return WINDOWS_DOUBLE_QUOTABLE_PATH_RE.test(s) ? `"${s}"` : null;
}

/**
 * Mode/companion acceptance for printed `prune-merged-local.mjs …` argv tokens
 * (everything after the script path). Does NOT evaluate live allow-release predicates.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
export function acceptsPrintedPruneArgv(tokens) {
  const parsed = parsePruneArgv(tokens);
  if (!parsed.validMode) return false;

  if (parsed.mode === '--remove-orphan') {
    return tokens.length === 2 && parsed.args.length === 1 && isResolvedLocalWorktreePath(parsed.args[0]);
  }

  if (parsed.mode === '--force-delete') {
    const target = parsed.args[0];
    if (!target || parsed.args.length !== 1) return false;
    if (isProtectedBaseBranch(target)) return false;
    // Named remote deletion: never for release/* (retained), never zero-network.
    if (parsed.includeRemote && (target.startsWith(RELEASE_PREFIX) || parsed.localOnly)) return false;
    if (target.startsWith(RELEASE_PREFIX)) return parsed.allowRelease === true;
    if (parsed.allowRelease) return false;
    return true;
  }

  // Printed advisory/footer never pairs companion with other modes.
  if (parsed.allowRelease) return false;
  return true;
}

export const PRUNE_BRANCH_PREFIXES = Object.freeze([
  'feature/',
  'bugfix/',
  'chore/',
  'hotfix/',
  'release/',
]);

const BRANCH_SNAPSHOT_ARGV = Object.freeze([
  'for-each-ref',
  '--format=%(refname)%00%(refname:short)%00%(objectname)',
  ...PRUNE_BRANCH_PREFIXES.map((prefix) => `refs/heads/${prefix}`),
  ...PRUNE_BRANCH_PREFIXES.map((prefix) => `refs/remotes/origin/${prefix}`),
]);

const MAINLINE_CONTAINMENT_ARGV = Object.freeze([
  'for-each-ref',
  '--format=%(refname:short)',
  '--merged',
  'origin/main',
  'refs/heads/',
]);

const OBJECT_ID = /^[0-9a-f]{6,64}$/i;

function argvEquals(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function isLocalBranchName(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.startsWith('origin/') || value.startsWith('refs/')) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false;
  return value.split('/').every((part) =>
    part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

function isResolvedLocalWorktreePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith('\\\\') || value.startsWith('//')) {
    return false;
  }
  return value.startsWith('/') || /^[A-Za-z]:[\\/](?![\\/])/.test(value);
}

function isAllowedRevParseTarget(value) {
  if (['production', 'origin/production', 'origin/main'].includes(value)) return true;
  const match = value.match(/^refs\/heads\/(.+)\^\{commit\}$/);
  return match !== null && isLocalBranchName(match[1]);
}

// `git [-c core.longpaths=true] worktree remove [--force] <absolute path>`
function isLocalWorktreeRemoveArgv(args) {
  const rest = args[0] === '-c' && args[1] === 'core.longpaths=true' ? args.slice(2) : args;
  if (rest[0] !== 'worktree' || rest[1] !== 'remove') return false;
  const tail = rest.slice(2);
  const path = tail.length === 2 && tail[0] === '--force' ? tail[1] : tail.length === 1 ? tail[0] : null;
  return isResolvedLocalWorktreePath(path);
}

/** Sole authority for Git argv permitted during an explicit --local-only invocation. */
export function classifyLocalOnlyGitArgv(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
    return { allowed: false, reason: 'unknown argv shape' };
  }
  const verb = args[0];
  if (['fetch', 'ls-remote', 'push', 'pull', 'remote'].includes(verb)) {
    return { allowed: false, reason: 'network-capable Git verb' };
  }
  const allowed =
    argvEquals(args, ['rev-parse', '--git-dir']) ||
    argvEquals(args, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ||
    (args.length === 5
      && args[0] === '-C'
      && isResolvedLocalWorktreePath(args[1])
      && args[2] === 'rev-parse'
      && args[3] === '--path-format=absolute'
      && args[4] === '--git-common-dir') ||
    (args.length === 3 && verb === 'rev-parse' && args[1] === '--verify' && isAllowedRevParseTarget(args[2])) ||
    argvEquals(args, ['branch', '--list']) ||
    argvEquals(args, ['branch', '--show-current']) ||
    argvEquals(args, ['branch', '-r', '--list', 'origin/*']) ||
    (args.length === 3 && verb === 'branch' && ['-d', '-D'].includes(args[1]) && isLocalBranchName(args[2])) ||
    argvEquals(args, BRANCH_SNAPSHOT_ARGV) ||
    argvEquals(args, MAINLINE_CONTAINMENT_ARGV) ||
    (args.length === 4 && verb === 'merge-base' && args[1] === '--is-ancestor' &&
      OBJECT_ID.test(args[2]) &&
      (OBJECT_ID.test(args[3]) || ['production', 'origin/production', 'origin/main'].includes(args[3]))) ||
    argvEquals(args, ['config', '--get-regexp', '^branch\\..*\\.remote$']) ||
    (args.length === 3 && verb === 'tag' && args[1] === '--contains' && OBJECT_ID.test(args[2])) ||
    argvEquals(args, ['worktree', 'list', '--porcelain']) ||
    (args.length === 7 && verb === 'for-each-ref' && args[1] === '--format=%(refname:short)' &&
      args[2] === '--contains' && OBJECT_ID.test(args[3]) && args[4] === '--merged' &&
      args[5] === 'origin/main' && args[6] === 'refs/tags/production-*') ||
    (args.length === 6 && verb === '-C' && isResolvedLocalWorktreePath(args[1]) &&
      args[2] === 'status' && args[3] === '--porcelain' && args[4] === '--ignore-submodules=none' &&
      args[5] === '--untracked-files=normal') ||
    isLocalWorktreeRemoveArgv(args);
  return allowed
    ? { allowed: true, reason: 'local repository operation' }
    : { allowed: false, reason: 'unclassified Git argv' };
}

/** Sole process-level authority: explicit local-only accepts literal `git` only. */
export function classifyLocalOnlyProcessInvocation(file, args) {
  if (file !== 'git') return { allowed: false, reason: 'non-Git executable' };
  return classifyLocalOnlyGitArgv(args);
}

/** Executable examples are derived from the classifier rather than a second allowlist. */
export function localOnlyGitArgvExamples() {
  return [
    ['rev-parse', '--git-dir'],
    ['branch', '--show-current'],
    [...BRANCH_SNAPSHOT_ARGV],
    ['worktree', 'list', '--porcelain'],
  ].map((args) => ({ args, ...classifyLocalOnlyGitArgv(args) }));
}
