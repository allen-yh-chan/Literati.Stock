import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

// Per-process memo. The git common-dir for a given cwd is STRUCTURALLY
// invariant — only moving the checkout on disk could change it — and hooks are
// one-shot short-lived processes, so there is no staleness window. Callers ask
// repeatedly (integration-tier spawn census: 1304 duplicate `rev-parse
// --git-common-dir` calls, the single largest in-process duplicate) and each
// repeat costs a real fork+exec, which is ~93% of this suite's CPU. Same
// pattern and rationale as `getRepoRoot` in ./git-utils.mjs.
const identityCache = new Map();

const commonDirCache = new Map();

/** Stable error token when resolved main-checkout root would land under `.worktree/`. */
export const REPO_STATE_ROOT_UNDER_WORKTREE_TOKEN = "repo-state-root-under-worktree";

/**
 * The single shared probe for `git rev-parse --git-common-dir`.
 *
 * This one structural invariant used to be probed with four different argv
 * shapes across six call sites, none of them sharing a memo. `--path-format=
 * absolute` is used because the bare form may return a RELATIVE path (plain
 * `.git` when run from the repo root), which every caller then had to resolve
 * on its own; asking for absolute collapses the four shapes into one and lets
 * a single cache serve every caller.
 *
 * Returns `{ ok, commonDir, error }` and NEVER throws. It deliberately does NOT
 * pick a fallback, because the callers' fail modes are genuinely different and
 * unifying them would be a behaviour change:
 *   - `repoStateIdentity` (below) fails OPEN to `realpath(cwd)`.
 *   - `run-test-suite.mjs` falls back to the repo root it was handed.
 *   - `second-reviewer-cli-recipe-contract.mjs` MUST fail CLOSED by throwing,
 *     because its derived value feeds a reviewer-writable containment
 *     boundary; making it fail open would hand that gate a plausible-looking
 *     but wrong root.
 * So each caller keeps its own post-processing and its own fail mode; only the
 * probe and its memo are shared.
 *
 * `timeoutMs` is a per-caller spawn cap for the same reason: a cap is part of a
 * caller's fail mode, and only `repoStateIdentity` had one (2s) before this
 * probe existed. Defaulting it to `undefined` is Node's documented "no timeout"
 * and preserves the other five call sites; capping them all would regress the
 * two that fail QUIETLY -- `run-test-suite.mjs` (falls back to the repo root it
 * was handed, which is where notes/tmp tier logs land) and
 * `hook-command-context.mjs` (falls open to "") -- in an integration tier that
 * spawns ~19k processes at load average 20-26.
 *
 * Only successes are memoized: caching a failure would turn one transient git
 * failure -- including a timeout -- into a process-wide wrong answer.
 */
export function probeGitCommonDir(cwd = process.cwd(), { timeoutMs } = {}) {
  const resolved = path.resolve(cwd);
  const cached = commonDirCache.get(resolved);
  if (cached !== undefined) return cached;
  let commonDir;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", resolved, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }
    ).trim();
  } catch (error) {
    return { ok: false, commonDir: "", error };
  }
  const result = { ok: true, commonDir, error: null };
  commonDirCache.set(resolved, result);
  return result;
}

function realpathOrResolved(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * True when `candidate` normalizes to a path under a `.worktree` directory
 * (including using `.worktree` itself as the root).
 */
export function isPathUnderDotWorktree(candidate) {
  const normalized = realpathOrResolved(candidate).split(path.sep).join("/");
  return (
    normalized.includes("/.worktree/") ||
    normalized.endsWith("/.worktree") ||
    normalized === ".worktree"
  );
}

/**
 * B-root climb for fail-open: if cwd is under `<main>/.worktree/<leaf>`, return
 * `<main>`; if cwd is exactly `<main>/.worktree`, return `<main>`; else cwd.
 */
function climbOutOfDotWorktree(cwdReal) {
  const parts = cwdReal.split(path.sep);
  const idx = parts.lastIndexOf(".worktree");
  if (idx <= 0) return cwdReal;
  // Keep drive/root prefix: join up to but not including `.worktree`.
  const climbed = parts.slice(0, idx).join(path.sep);
  // On POSIX, empty join means "/"; on win32 keep drive letter via path.parse.
  if (!climbed) {
    return path.parse(cwdReal).root || path.sep;
  }
  return climbed;
}

/**
 * Resolve the shared main-checkout root with an observable identitySource.
 *
 * Success (`git-common-dir`): dirname(realpath(common-dir)).
 * Fail-open (`fallback`): climb out of `.worktree/<leaf>` when present; never
 * apply unconditional dirname(cwd) that shifts root to `<main>/.worktree`.
 *
 * `options.probeResult` is a test/injection seam for forced probe failure.
 * Production callers omit it.
 *
 * `repoStateIdentity` still returns the common-dir string on success (shared
 * identity contract). Callers that need the main-checkout root MUST use this
 * helper or `defaultMainCheckoutRoot` — do not `dirname(repoStateIdentity(...))`.
 */
export function resolveMainCheckoutRoot(cwd = process.cwd(), options = {}) {
  const resolved = path.resolve(cwd);
  const cwdReal = realpathOrResolved(resolved);
  const probe =
    options.probeResult ??
    probeGitCommonDir(resolved, { timeoutMs: 2000 });

  if (probe?.ok && probe.commonDir) {
    const commonPath = path.resolve(resolved, probe.commonDir);
    const commonReal = realpathOrResolved(commonPath);
    return {
      mainCheckoutRoot: path.dirname(commonReal),
      identitySource: "git-common-dir",
    };
  }

  return {
    mainCheckoutRoot: climbOutOfDotWorktree(cwdReal),
    identitySource: "fallback",
  };
}

export function assertMainCheckoutRootWritable(root) {
  if (isPathUnderDotWorktree(root)) {
    throw new Error(
      `${REPO_STATE_ROOT_UNDER_WORKTREE_TOKEN}: main-checkout root must not land under .worktree/ (got ${root})`
    );
  }
}

export function repoStateIdentity(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  const cached = identityCache.get(resolved);
  if (cached !== undefined) return cached;
  // Keeps this call site's original 2s cap: hooks are one-shot, so a hung git
  // would hang the hook. The other callers had no cap and keep having none.
  const { commonDir } = probeGitCommonDir(resolved, { timeoutMs: 2000 });
  if (commonDir) {
    const commonPath = path.resolve(resolved, commonDir);
    let identity;
    try {
      identity = realpathSync(commonPath);
    } catch {
      identity = commonPath;
    }
    // Only memoize successful resolutions: the fallbacks below are fail-open
    // values, and caching one would turn a transient git failure into a
    // process-wide wrong answer.
    identityCache.set(resolved, identity);
    return identity;
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The main-checkout root shared by the main checkout and every linked worktree
 * of the same repo.
 *
 * Prefer this (or `resolveMainCheckoutRoot`) over
 * `dirname(repoStateIdentity(cwd))`. Fail-open identity is a directory (not a
 * `.git` tail); unconditional dirname peels `.worktree/<leaf>` and wrongly
 * lands on `<main>/.worktree`.
 *
 * Non-git fallback caveat: when cwd is not under `.worktree/`, fail-open uses
 * realpath(cwd) itself as the root (sibling non-git dirs no longer collapse
 * via an extra dirname peel on the identity string alone — root helpers own
 * that derivation).
 */
export function defaultMainCheckoutRoot(cwd = process.cwd(), options = {}) {
  return resolveMainCheckoutRoot(cwd, options).mainCheckoutRoot;
}

/**
 * Returns the canonical state directory for a given prefix, rooted at
 * `<main-checkout-root>/notes/tmp/state/<prefix>`.
 *
 * Hard-fails with `repo-state-root-under-worktree` when the resolved root (or
 * final state path) would land under `.worktree/` — MUST NOT mkdir a fake tree
 * at `.worktree/notes/tmp/state/...`.
 *
 * Options:
 * - `mainCheckoutRoot`: explicit root (tests / rare overrides); still guarded.
 * - `resolveOptions`: forwarded to `resolveMainCheckoutRoot` (probe injection).
 */
export function defaultRepoStateDir(prefix, cwd = process.cwd(), options = {}) {
  const root =
    options.mainCheckoutRoot ??
    defaultMainCheckoutRoot(cwd, options.resolveOptions || {});
  assertMainCheckoutRootWritable(root);
  const stateDir = path.join(root, "notes", "tmp", "state", prefix);
  if (isPathUnderDotWorktree(stateDir)) {
    throw new Error(
      `${REPO_STATE_ROOT_UNDER_WORKTREE_TOKEN}: state dir must not land under .worktree/ (got ${stateDir})`
    );
  }
  return stateDir;
}
