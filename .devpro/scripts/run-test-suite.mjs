#!/usr/bin/env node
/**
 * run-test-suite.mjs
 *
 * Tier-aware runner for the source-repo test suite using test-suite-manifest.mjs.
 *
 *   --tier unit|integration|fast|all  Run an explicit tier (default: all = unit then integration).
 *   --changed <base>             Select mechanically from the diff vs <base>:
 *                                always the complete unit tier, plus only the
 *                                integration-tier manifest tests this PR added
 *                                or modified, plus those whose source names a
 *                                changed non-test script by its full repo-
 *                                relative path, with `/` or as adjacent quoted
 *                                segments (including the old path of a
 *                                deleted or renamed script), plus the shard-
 *                                import wrappers of any selected sharded
 *                                body, plus the fixed repo-sweep guards
 *                                (REPO_SWEEP_INTEGRATION_TESTS, listed on a
 *                                `repo_sweep` line), which any new or changed
 *                                file can turn red. A script that no
 *                                integration test names selects nothing and
 *                                does not fall back; a `script_references`
 *                                line lists such scripts.
 *                                Other non-test carriers (SKILL.md, runtime
 *                                projection, helper, fixture) select no
 *                                integration file of their own; only the
 *                                repo-sweep guards ride along. Any unprovable state
 *                                (unknown path, unreadable changed set or
 *                                rename sources, selector error, or a broken
 *                                selection invariant) fails closed to the
 *                                complete integration manifest. The exhaustive
 *                                full suite runs in `devpro:rule-governance` and
 *                                release, not on every `--changed` PR run.
 *   --integration-manifest <path> Replay an exact repo-relative integration
 *                                file list on the canonical source checkout.
 *   --allow-full-fallback        Opt-in escape: when selection falls back to full
 *                                integration set, continue with test-result exit
 *                                instead of EXIT_FULL_FALLBACK (still prints banner).
 *                                Not a CI default.
 *   --stdio log|inherit          Default: log. Captures child TAP to notes/tmp
 *                                and prints only a compact summary. `inherit`
 *                                preserves the legacy raw console stream.
 *
 * Every run prints its wall-clock real time — there is no fixed budget block here;
 * the full-suite runtime is report-only (see check-suite-runtime-budget.mjs).
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  listFiles,
  resolveTier,
  SUITE_DIR,
  TIER_UNIT,
  TIER_INTEGRATION,
} from "./test-suite-manifest.mjs";
import { RULES_TAG_RE } from "./hooks/lib/tag-shapes.mjs";
import { probeGitCommonDir } from "./hooks/lib/repo-state-identity.mjs";
import { detectShardImportTargets } from "./lint-test-suite-manifest.mjs";
import { logTextLooksLikeTransientGitEintr } from './lib/git-exec-retry.mjs';
import { escapeRegExp } from "./lib/primitives.mjs";
import {
  classifyCheckoutRoot,
  runWindowsCheckoutPreflight,
} from "./windows-checkout-preflight.mjs";

export { detectShardImportTargets };

/**
 * Fail-path helper for tier runs: print a named transient-git-eintr hint when
 * the captured error/log looks like a scoped git EINTR/loose-object failure.
 * @param {{ status: number|null|undefined, errorMessage?: string, logText?: string, writeErr?: (msg: string) => void }} args
 * @returns {boolean} true when the hint was emitted
 */
export function maybePrintTransientGitEintrHint({
  status,
  errorMessage = '',
  logText = '',
  writeErr = (msg) => console.error(msg),
} = {}) {
  // Align with runTier's `status !== 0`: null/undefined are failures, not skips.
  if (status === 0) return false;
  const logBlob = [errorMessage, logText].filter(Boolean).join('\n');
  if (!logTextLooksLikeTransientGitEintr(logBlob)) return false;
  writeErr(
    '[test-suite] transient-git-eintr: log matches Interrupted system call / loose-object EINTR; re-run this tier before treating as a logic failure',
  );
  return true;
}

/**
 * Drive the suite fail-path hint from a tier run result (injectable IO for prove-it).
 * @param {{ status?: number|null, error?: { message?: string }|null, logPath?: string|null }} result
 * @param {{ readFile?: typeof readFileSync, exists?: typeof existsSync, writeErr?: (msg: string) => void }} [io]
 * @returns {boolean}
 */
export function emitTransientHintForTierResult(result, {
  readFile = readFileSync,
  exists = existsSync,
  writeErr,
} = {}) {
  const logPath = result?.logPath;
  return maybePrintTransientGitEintrHint({
    status: result?.status,
    errorMessage: result?.error?.message ?? '',
    logText: typeof logPath === 'string' && exists(logPath)
      ? readFile(logPath, 'utf8').slice(-64 * 1024)
      : '',
    writeErr,
  });
}

export const TIER_FAST = "fast";
/** Dedicated non-zero exit when `--changed` selection falls back to full integration without `--allow-full-fallback`. Distinct from test-failure statuses. */
export const EXIT_FULL_FALLBACK = 75;
const VALID_TIERS = new Set(["unit", "integration", TIER_FAST, "all"]);
const VALID_STDIO_MODES = new Set(["log", "inherit"]);
const CONSUMER_RULES_SMOKE_TESTS = [
  ".devpro/scripts/tests/multi-runtime-parity.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-git-flow.test.mjs",
];

// Fixed PR-latency carrier set. This is intentionally separate from the
// unit/integration manifest tiers: `fast` is a bounded feedback route, while
// `all` remains the exhaustive manifest route. Keep this list small, explicit,
// and representative; the runtime contract is guarded by
// fastIntegrationFiles() and run-test-suite.test.mjs.
export const FAST_INTEGRATION_TESTS = Object.freeze([
  ".devpro/scripts/tests/gh-footer-gate-echo-fp.test.mjs",
  ".devpro/scripts/tests/hook-gh-footer-gate.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-git-flow.test.mjs",
  ".devpro/scripts/tests/pre-pr-archive-gate-runner-a.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-a.test.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection-runner-a.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
  ".devpro/scripts/tests/git-utils.test.mjs",
  ".devpro/scripts/tests/run-test-suite-consumer-routing.test.mjs",
]);
// Integration tests that sweep every tracked file of the repository. A new or
// changed file anywhere can turn them red without touching them or a script
// they name, so a scoped `--changed` plan always carries them. Fixed and
// hand-registered on purpose — no detector derives it. Register a new
// whole-repo sweep here; keep each entry small (move the sweep out of a large
// body into its own file first). A missed entry is still caught by `--tier
// all` at rule-governance and release.
export const REPO_SWEEP_INTEGRATION_TESTS = Object.freeze([
  ".devpro/scripts/tests/hotfix-release-carrier-marker-scan.test.mjs",
  ".devpro/scripts/tests/opencode-skill-discovery.test.mjs",
  ".devpro/scripts/tests/second-review-reconciliation-unreachable-sweep.test.mjs",
  ".devpro/scripts/tests/skill-entry-rename-sweep-guard.test.mjs",
]);
// Ordered by descending measured solo real time (LPT-style list scheduling:
// biggest files claim a concurrency slot first so no slot idles waiting on a
// straggler). Re-measure and re-sort after any split/merge of these files —
// see test-performance-patterns.md (e).
export const INTERLEAVED_INTEGRATION_TEST_PRIORITY = [
  ".devpro/scripts/tests/review-remediation-evidence-runner-c.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-d3.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-d1.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-d4.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-d2.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-b.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence-runner-a.test.mjs",
  ".devpro/scripts/tests/review-remediation-evidence.test.mjs",
  // ~215s standalone (3 real debug CLI cases); register so interleaved
  // scheduling starts this long-tail carrier early instead of priority=∞.
  ".devpro/scripts/tests/opencode-cli-smoke.test.mjs",
  ".devpro/scripts/tests/pre-pr-archive-gate-runner-a.test.mjs",
  ".devpro/scripts/tests/pre-pr-archive-gate.test.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection-runner-a.test.mjs",
  ".devpro/scripts/tests/pre-pr-archive-gate-runner-b.test.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection.test.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection-runner-b.test.mjs",
  ".devpro/scripts/tests/hook-post-pr-completion.test.mjs",
  ".devpro/scripts/tests/render-second-review-packet-runner-a.test.mjs",
  ".devpro/scripts/tests/render-second-review-packet.test.mjs",
  ".devpro/scripts/tests/detect-branch-base.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules.test.mjs",
  ".devpro/scripts/tests/prune-merged-local-c.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-git-flow.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-a2.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-b.test.mjs",
  ".devpro/scripts/tests/hook-post-pr-completion-runner-a.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-release-version.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-repo-scope.test.mjs",
  ".devpro/scripts/tests/devpro-doctor.test.mjs",
  ".devpro/scripts/tests/devpro-doctor-runner-a.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-release-rules-base.test.mjs",
  ".devpro/scripts/tests/prune-merged-local.test.mjs",
  ".devpro/scripts/tests/hook-pre-tool-gate-worktree-mandatory.test.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection-ownership.test.mjs",
  ".devpro/scripts/tests/prune-merged-local-b.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-git-flow.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-uninstall.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-d.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-uninstall-b.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-e.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-full-source.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-auto-compact-check.test.mjs",
  ".devpro/scripts/tests/sync-agent-rules-workflows.test.mjs",
];
const LONG_INTEGRATION_TEST_PRIORITY_INDEX = new Map(
  INTERLEAVED_INTEGRATION_TEST_PRIORITY.map((file, index) => [file, index]),
);
let logCounter = 0;

// Known carrier paths (design.md D2 step 5). None of these forces the whole
// integration tier — selection is decided by manifest membership (classify*
// below) plus, for a non-test `.mjs` script under `.devpro/scripts/`
// (isScriptReferenceCarrier), the integration tests that name its full path;
// every other path here selects nothing by itself. Every one of them MUST
// classify as "known", never "unknown", or a PR that only touches a carrier
// would incorrectly fail closed (exit EXIT_FULL_FALLBACK) instead of staying
// scoped (C1). Kept identical to the pre-amend-pr-integration-test-scope
// INTEGRATION_PATH_MATCHERS list, plus the ignore-list paths it used to
// special-case separately (notes/, openspec/, *.md).
const KNOWN_PATH_MATCHERS = [
  // Tracked rigor example is a documentation carrier, not a runtime config.
  (f) => f === ".devpro/rules.config.example",
  (f) => f.startsWith(".devpro/scripts/hooks/"),
  // Git-native hooks (e.g. hooks-git/pre-push) are non-.mjs executables
  // exercised by integration tests that spawn them.
  (f) => f.startsWith(".devpro/scripts/hooks-git/"),
  (f) => f.startsWith(".claude/"),
  // OpenCode runtime plugin/hooks — parallel to `.claude/` IDE adapters.
  (f) => f.startsWith(".opencode/"),
  // Codex / Cursor runtime projections — same class as `.claude/` / `.opencode/`.
  (f) => f.startsWith(".codex/"),
  (f) => f.startsWith(".cursor/"),
  // Codex/Cursor skill discovery entries (`.agents/skills/devpro`) — same class as `.claude/`.
  (f) => f.startsWith(".agents/"),
  // Skill catalog and refs payload beyond SKILL.md (manifests, plugin.json, agents/openai.yaml).
  (f) => f.startsWith(".devpro/agent-skills/"),
  (f) => f.startsWith(".devpro/agent-skills-refs/"),
  (f) => f.endsWith("/SKILL.md"),
  // Repo-root attrs feed sync-agent-rules managed-block derive.
  (f) => f === ".gitattributes",
  // Repo-root ignore file carries the managed gitignore baseline that sync-agent-rules propagates.
  (f) => f === ".gitignore",
  // Any non-test script under .devpro/scripts/ (any depth, any extension —
  // .mjs / .cjs / .sh). A *.test.mjs is classified via the manifest instead.
  (f) => f.startsWith(".devpro/scripts/") && !f.endsWith(".test.mjs"),
  (f) => f.startsWith("notes/"),
  (f) => f.startsWith("openspec/"),
  (f) => f.endsWith(".md"),
];

function defaultRepoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "../..");
}

/**
 * @param {string[]} argv process.argv slice (e.g. process.argv.slice(2))
 * @returns {{ tier: "unit" | "integration" | "fast" | "all" | null, changedBase: string | null, repoRoot: string, stdioMode: "log" | "inherit", allowFullFallback: boolean }}
 */
export function parseArgs(argv, { repoRoot = defaultRepoRoot() } = {}) {
  let tier = null;
  let changedBase = null;
  let root = repoRoot;
  let explicitRoot = false;
  let integrationManifestPath = null;
  let stdioMode = "log";
  let allowFullFallback = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tier") {
      const next = argv[i + 1];
      if (!next || !VALID_TIERS.has(next)) {
        throw new Error(`--tier requires one of: ${[...VALID_TIERS].join(", ")}`);
      }
      tier = next;
      i += 1;
      continue;
    }
    if (arg === "--changed") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--changed requires a base ref (e.g. --changed main)");
      }
      changedBase = next;
      i += 1;
      continue;
    }
    if (arg === "--root") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--root requires a repository path");
      }
      root = path.resolve(next);
      explicitRoot = true;
      i += 1;
      continue;
    }
    if (arg === "--integration-manifest") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--integration-manifest requires a repository-relative path");
      }
      if (integrationManifestPath !== null) {
        throw new Error("--integration-manifest may be specified only once");
      }
      integrationManifestPath = next;
      i += 1;
      continue;
    }
    if (arg === "--stdio") {
      const next = argv[i + 1];
      if (!next || !VALID_STDIO_MODES.has(next)) {
        throw new Error(`--stdio requires one of: ${[...VALID_STDIO_MODES].join(", ")}`);
      }
      stdioMode = next;
      i += 1;
      continue;
    }
    if (arg === "--allow-full-fallback") {
      // Opt-in escape only — not a CI default. Still prints the fail-visible
      // full-fallback banner; exit follows test results instead of EXIT_FULL_FALLBACK.
      allowFullFallback = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (tier !== null && changedBase !== null) {
    throw new Error("--tier and --changed are mutually exclusive");
  }
  if (integrationManifestPath !== null) {
    if (tier !== TIER_INTEGRATION) {
      throw new Error("--integration-manifest requires an explicit --tier integration");
    }
    if (changedBase !== null) {
      throw new Error("--integration-manifest cannot be combined with --changed");
    }
    if (explicitRoot) {
      throw new Error("--integration-manifest cannot be combined with --root");
    }
  }
  // Neither flag → full suite (back-compat with the documented default).
  if (tier === null && changedBase === null) tier = "all";

  const parsed = { tier, changedBase, repoRoot: root, stdioMode, allowFullFallback };
  if (explicitRoot) parsed.explicitRoot = true;
  if (integrationManifestPath !== null) {
    parsed.integrationManifestPath = integrationManifestPath;
  }
  return parsed;
}

/** Reject the bounded manifest option outside the source-maintainer route. */
export function assertSourceOnlyManifestRoute({
  integrationManifestPath,
  route,
} = {}) {
  if (integrationManifestPath != null && route !== "source-suite") {
    throw new Error("--integration-manifest is source-suite only");
  }
}

function isInsideRepo(repoRoot, targetPath) {
  const relative = path.relative(repoRoot, targetPath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Read and validate a repo-relative list of exact integration-tier test paths.
 * Every entry is checked before the caller can dispatch any child process.
 */
export function readIntegrationManifestFiles(
  manifestPath,
  {
    repoRoot = defaultRepoRoot(),
    exists = existsSync,
    lstat = lstatSync,
    realpath = realpathSync,
    readFile = readFileSync,
  } = {},
) {
  const invalid = (reason) => {
    throw new Error(`invalid --integration-manifest: ${reason}`);
  };
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    invalid("a repository-relative path is required");
  }
  const portableManifestPath = manifestPath.replaceAll("\\", "/");
  const manifestSegments = portableManifestPath.split("/");
  if (
    path.isAbsolute(manifestPath) ||
    path.win32.isAbsolute(manifestPath) ||
    manifestSegments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    invalid("manifest path must resolve inside the repository");
  }

  const resolvedRoot = path.resolve(repoRoot);
  const manifestAbsolutePath = path.resolve(
    resolvedRoot,
    ...portableManifestPath.split("/"),
  );
  if (!isInsideRepo(resolvedRoot, manifestAbsolutePath)) {
    invalid("manifest path must resolve inside the repository");
  }

  let manifestStat;
  let manifestRealPath;
  let rootRealPath;
  try {
    manifestStat = lstat(manifestAbsolutePath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      invalid("manifest must be a regular file inside the repository");
    }
    rootRealPath = realpath(resolvedRoot);
    manifestRealPath = realpath(manifestAbsolutePath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid --integration-manifest:")) {
      throw error;
    }
    invalid("manifest must exist inside the repository");
  }
  if (!isInsideRepo(rootRealPath, manifestRealPath)) {
    invalid("manifest path must resolve inside the repository");
  }

  let contents;
  try {
    contents = readFile(manifestAbsolutePath, "utf8");
  } catch {
    invalid("manifest must be readable");
  }
  if (typeof contents !== "string" || contents.length === 0 || /[\r\0]/u.test(contents)) {
    invalid("manifest must contain non-empty newline-delimited paths");
  }

  const files = (contents.endsWith("\n") ? contents.slice(0, -1) : contents).split("\n");
  if (files.some((file) => file.length === 0 || file.trim() !== file)) {
    invalid("manifest entries must be non-empty paths without surrounding whitespace");
  }
  if (new Set(files).size !== files.length) {
    invalid("manifest entries must be unique");
  }

  const integrationFiles = new Set(
    listFiles(TIER_INTEGRATION).map(normalizeRepoPath),
  );
  for (const file of files) {
    const portableFile = file.replaceAll("\\", "/");
    if (
      portableFile !== file ||
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      invalid(`entry is not a canonical repository-relative path: ${file}`);
    }
    if (!integrationFiles.has(file)) {
      invalid(`entry is not in the canonical integration tier: ${file}`);
    }
    const testAbsolutePath = path.resolve(resolvedRoot, ...file.split("/"));
    let testRealPath;
    try {
      if (!exists(testAbsolutePath)) invalid(`integration test does not exist: ${file}`);
      testRealPath = realpath(testAbsolutePath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid --integration-manifest:")) {
        throw error;
      }
      invalid(`integration test does not exist: ${file}`);
    }
    if (!isInsideRepo(rootRealPath, testRealPath)) {
      invalid(`integration test resolves outside the repository: ${file}`);
    }
  }
  return files;
}

export function resolveTierFromArgv(argv) {
  return parseArgs(argv).tier;
}

function normalizeRepoPath(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//u, "");
}

/**
 * Classify one changed path for `--changed` selection (design.md D2).
 *
 * Priority order:
 *   1. deleted-test  — git-confirmed deletion (`deletedSet`) of a suite-test
 *      shaped path (Q3/BRD C1: the only deletion exemption).
 *   2. integration-test — member of the integration manifest (`integrationSet`).
 *   3. unit-test     — suite-test shaped, and the real manifest resolves it
 *      to the unit tier.
 *   4. unknown        — suite-test shaped, but the real manifest does not
 *      know it (added without a manifest entry) — fails closed.
 *   5. known          — matches a `KNOWN_PATH_MATCHERS` carrier (never
 *      falls back; C1 invariant).
 *   6. unknown        — anything else, fails closed.
 *
 * Membership of an integration test in the plan is decided by `integrationSet`
 * (changed tests) and, for a known non-test `.mjs` script, by the reference
 * lookup in `selectIntegrationTestFilesForChangedFiles`; no path pattern here
 * can add or remove a file from the integration plan by itself.
 *
 * @param {string} file repo-relative changed path
 * @param {{ integrationSet: Set<string>, deletedSet?: Set<string> }} options
 * @returns {"deleted-test"|"integration-test"|"unit-test"|"unknown"|"known"}
 */
export function classifyChangedPathForSelection(
  file,
  { integrationSet, deletedSet = new Set() },
) {
  const normalized = normalizeRepoPath(file);
  const isSuiteTestShape =
    normalized.startsWith(SUITE_DIR) && normalized.endsWith(".test.mjs");
  if (deletedSet.has(normalized) && isSuiteTestShape) return "deleted-test";
  if (integrationSet.has(normalized)) return "integration-test";
  if (isSuiteTestShape) {
    try {
      return resolveTier(normalized.slice(SUITE_DIR.length)) === TIER_UNIT
        ? "unit-test"
        : "integration-test";
    } catch {
      return "unknown";
    }
  }
  if (KNOWN_PATH_MATCHERS.some((matcher) => matcher(normalized))) {
    return "known";
  }
  return "unknown";
}

/**
 * Plan-invariant guard (design.md D5). Re-checks the six conditions that
 * MUST hold for a scoped (non-fallback) selection; any failure is an
 * unexplained selection and the caller falls back to the complete manifest.
 * Also the injectable fail-closed test seam for `selection-unexplained`.
 *
 * Conditions 1 (`files ⊆ integrationSet`), 3 (`changedIntegrationTests ⊆
 * files`) and 4 (`files ∩ deletedSet = ∅`) are independently failable
 * checks. Conditions 5 (`referencedTests ⊆ files`) and 6 (every file is
 * explained by a changed test, a script reference or a wrapper; only when
 * `shardWrappers` is supplied) are representation self-checks like 2.
 * Condition 2 (`files` equals `expected` in manifest order) is the
 * representation self-check: in the production call the caller passes the
 * manifest-order image of the same union as both sides
 * (`selectIntegrationTestFilesForChangedFiles`), so it holds by construction
 * and guards the representation contract against drift rather than an
 * independent input property (review F-3b7d1e). The injected-validator test
 * seam exercises its failure path.
 *
 * @param {{
 *   files: string[],
 *   integrationSet: Set<string>,
 *   changedIntegrationTests: string[],
 *   expected: string[],
 *   deletedSet?: Set<string>,
 *   referencedTests?: string[],
 *   shardWrappers?: string[] | null,
 * }} input
 * @returns {boolean}
 */
export function defaultPlanValidator({
  files,
  integrationSet,
  changedIntegrationTests,
  expected,
  deletedSet = new Set(),
  referencedTests = [],
  shardWrappers = null,
  repoSweepTests = [],
}) {
  if (files.some((file) => !integrationSet.has(file))) return false;
  if (
    files.length !== expected.length ||
    files.some((file, index) => file !== expected[index])
  ) {
    return false;
  }
  if (!changedIntegrationTests.every((file) => files.includes(file))) {
    return false;
  }
  if (files.some((file) => deletedSet.has(file))) return false;
  // Condition 5: tests selected because they name a changed script must be in
  // the plan. Like condition 2 this is a representation self-check (the plan is
  // built from the same set); lookup completeness is proven by fixture tests.
  if (!referencedTests.every((file) => files.includes(file))) return false;
  // Condition 6: every selected file is explained by a changed integration
  // test, a script reference, a shard-import wrapper, or a declared repo-sweep
  // guard. Only evaluated when the caller supplies `shardWrappers`, so a legacy
  // five-field call whose `files` legitimately contain wrappers keeps its
  // original semantics.
  if (shardWrappers !== null) {
    const explained = new Set([
      ...changedIntegrationTests,
      ...referencedTests,
      ...shardWrappers,
      ...repoSweepTests,
    ]);
    if (files.some((file) => !explained.has(file))) return false;
  }
  return true;
}

/**
 * Build a target → wrapper-files reverse index over the integration
 * manifest, reading each candidate's source once (design.md D3). Only called
 * when the changed integration-tier tests plus the tests selected by script
 * reference are non-empty — a PR that touches no integration test and no
 * script never reads integration test source at all.
 *
 * @param {string[]} candidates suite-relative integration manifest paths
 * @param {{
 *   repoRoot: string,
 *   integrationSet: Set<string>,
 *   shardTargetDetector: Function,
 *   readSource?: (candidate: string) => string,
 * }} options `readSource` defaults to reading the file under `repoRoot`; the
 *   selector passes its memoized reader so each source is read once
 * @returns {Map<string, string[]>} body path → sorted wrapper paths
 */
function buildShardWrapperIndex(
  candidates,
  {
    repoRoot,
    integrationSet,
    shardTargetDetector,
    readSource = (candidate) => readFileSync(path.join(repoRoot, candidate), "utf8"),
  },
) {
  const wrappersByTarget = new Map();
  for (const candidate of candidates) {
    const content = readSource(candidate);
    const targets = shardTargetDetector(content, { file: candidate });
    for (const target of targets) {
      if (!integrationSet.has(target)) {
        throw new Error(
          `shard-import target is not part of the integration manifest: ${target} (from ${candidate})`,
        );
      }
      const wrappers = wrappersByTarget.get(target) ?? [];
      wrappers.push(candidate);
      wrappersByTarget.set(target, wrappers);
    }
  }
  for (const wrappers of wrappersByTarget.values()) wrappers.sort();
  return wrappersByTarget;
}

const SCRIPT_REFERENCE_ROOT = ".devpro/scripts/";

/**
 * Whether a repo-relative path is a script whose full path integration tests
 * may name (amend-changed-integration-selection-by-reference D2): a non-test
 * `.mjs` under `.devpro/scripts/`, outside the suite directory (test helpers
 * and fixtures). Hooks and libraries qualify; git-native hooks (no `.mjs`),
 * skill bodies, projections and rule `.md` do not.
 *
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isScriptReferenceCarrier(file) {
  const normalized = normalizeRepoPath(file);
  return (
    normalized.startsWith(SCRIPT_REFERENCE_ROOT) &&
    normalized.endsWith(".mjs") &&
    !normalized.endsWith(".test.mjs") &&
    !normalized.startsWith(SUITE_DIR)
  );
}

// Between two path segments: a `/`, or the end of one quoted string and the
// start of the next (`".devpro", "scripts"` as written in a path.join call).
const PATH_SEGMENT_JOIN = String.raw`(?:/|["'\`]\s*,\s*["'\`])`;

/**
 * Matches the full repo-relative path, written either with `/` or split into
 * adjacent quoted strings at any separator.
 *
 * @param {string} carrier normalized repo-relative path
 * @returns {RegExp}
 */
function scriptReferencePattern(carrier) {
  return new RegExp(carrier.split("/").map(escapeRegExp).join(PATH_SEGMENT_JOIN));
}

/**
 * One match of each carrier's full repo-relative path over the raw source of
 * every manifest integration test. Each `/` may also be written as adjacent
 * quoted strings (`".devpro", "scripts", "x.mjs"`); every segment must still be
 * present in order (single hop: no basename or fixture-token match, no import
 * following, no recursion through matches). `readSource` throws when a source
 * is unreadable; the caller maps that to `selector-error`.
 *
 * @param {string[]} carriers normalized, deduplicated carrier paths
 * @param {string[]} integrationFiles manifest-ordered integration tests
 * @param {(file: string) => string} readSource
 * @returns {{referencedTests: string[], unreferenced: string[], referencingFiles: number}}
 */
export function findIntegrationTestsReferencingScripts(carriers, integrationFiles, readSource) {
  const referencedTests = [];
  const named = new Set();
  const patterns = carriers.map((carrier) => [carrier, scriptReferencePattern(carrier)]);
  for (const file of integrationFiles) {
    const source = readSource(file);
    let referencing = false;
    for (const [carrier, pattern] of patterns) {
      if (pattern.test(source)) {
        named.add(carrier);
        referencing = true;
      }
    }
    if (referencing) referencedTests.push(file);
  }
  return {
    referencedTests,
    unreferenced: carriers.filter((carrier) => !named.has(carrier)),
    referencingFiles: referencedTests.length,
  };
}

/**
 * Build the scoped integration-file plan for a `--changed` run
 * (design.md D1–D5; amend-changed-integration-selection-by-reference D2).
 *
 * The result is `C ∪ R ∪ wrappersOf(C ∪ R)`, in manifest order, where C is
 * the changed integration tests and R the manifest integration tests whose
 * source names a changed script (a known non-test `.mjs` under
 * `.devpro/scripts/`, plus the old path of a script git reports as renamed)
 * by its full repo-relative path. R is looked up only when there is at least
 * one such script; a script that no test names selects nothing and does not
 * fall back. Only integration-tier tests trigger wrapper expansion — a changed
 * unit-tier test never does (F1). Any unprovable state (empty/unreadable
 * changed set, undetermined rename sources, an unknown path, a
 * selector/reference/shard-detector error, or a broken plan invariant) returns
 * the complete integration manifest with a stable, named fallback reason so
 * the caller can fail closed (design.md D5 — exactly four reasons).
 * `renamedFromFiles`: `undefined` means no rename information (`[]`);
 * `null` means the rename query could not be answered.
 *
 * @param {string[]} changedFiles normalized repo-relative changed paths
 * @param {{
 *   repoRoot?: string,
 *   integrationFiles?: string[],
 *   deletedFiles?: string[],
 *   renamedFromFiles?: string[] | null,
 *   shardTargetDetector?: Function,
 *   planValidator?: Function,
 * }} options
 * @returns {{files: string[], fallbackToFull: boolean, reason: string, diagnostics: object}}
 */
export function selectIntegrationTestFilesForChangedFiles(
  changedFiles,
  {
    repoRoot = defaultRepoRoot(),
    integrationFiles = listFiles(TIER_INTEGRATION),
    deletedFiles = [],
    renamedFromFiles = [],
    shardTargetDetector = detectShardImportTargets,
    planValidator = defaultPlanValidator,
    repoSweepTests = REPO_SWEEP_INTEGRATION_TESTS,
  } = {},
) {
  const fullFiles = [...integrationFiles].map(normalizeRepoPath);
  const fallback = (reason, diagnostics = {}) => ({
    files: fullFiles,
    fallbackToFull: true,
    reason,
    diagnostics,
  });
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return fallback("changed-set-unavailable");
  }
  // The rename query could not be answered: rename sources are part of the
  // changed set, so an undetermined answer is an unavailable changed set.
  if (renamedFromFiles === null) return fallback("changed-set-unavailable");

  try {
    const normalizedChanged = [...new Set(changedFiles.map(normalizeRepoPath))];
    const integrationSet = new Set(fullFiles);
    const deletedSet = new Set((deletedFiles ?? []).map(normalizeRepoPath));
    const classifications = Object.fromEntries(
      normalizedChanged.map((file) => [
        file,
        classifyChangedPathForSelection(file, { integrationSet, deletedSet }),
      ]),
    );
    if (Object.values(classifications).includes("unknown")) {
      return fallback("unknown-path", { classifications });
    }

    const changedIntegrationTests = normalizedChanged
      .filter((file) => classifications[file] === "integration-test")
      .sort();

    // Carriers: known changed non-test scripts, plus the old path of a renamed
    // script (its new path is a carrier only if it is itself a changed .mjs).
    const carriers = [
      ...new Set([
        ...normalizedChanged.filter(
          (file) => classifications[file] === "known" && isScriptReferenceCarrier(file),
        ),
        ...renamedFromFiles.map(normalizeRepoPath).filter(isScriptReferenceCarrier),
      ]),
    ].sort();

    // Each integration source is read at most once, shared by the reference
    // lookup and the shard-wrapper index.
    const sourceCache = new Map();
    const readSource = (file) => {
      if (!sourceCache.has(file)) {
        sourceCache.set(file, readFileSync(path.join(repoRoot, file), "utf8"));
      }
      return sourceCache.get(file);
    };

    const references =
      carriers.length > 0
        ? findIntegrationTestsReferencingScripts(carriers, fullFiles, readSource)
        : null;
    const referencedTests = references?.referencedTests ?? [];

    let shardWrappers = [];
    const expansionRoots = [...new Set([...changedIntegrationTests, ...referencedTests])];
    if (expansionRoots.length > 0) {
      const wrappersByTarget = buildShardWrapperIndex(fullFiles, {
        repoRoot,
        integrationSet,
        shardTargetDetector,
        readSource,
      });
      const wrapperSet = new Set();
      for (const body of expansionRoots) {
        for (const wrapper of wrappersByTarget.get(body) ?? []) {
          wrapperSet.add(wrapper);
        }
      }
      shardWrappers = [...wrapperSet].sort();
    }

    // Repo-sweep guards in this manifest; a fixture manifest without them
    // selects none. The real list is checked against the real manifest by a
    // unit test, so an entry that drifts out of it fails the unit tier.
    const repoSweep = [...new Set(repoSweepTests.map(normalizeRepoPath))]
      .filter((file) => integrationSet.has(file))
      .sort();

    const selected = new Set([
      ...changedIntegrationTests,
      ...referencedTests,
      ...shardWrappers,
      ...repoSweep,
    ]);
    const files = fullFiles.filter((file) => selected.has(file));
    const diagnostics = {
      classifications,
      changedIntegrationTests,
      shardWrappers,
      repoSweepTests: repoSweep,
      ...(references === null
        ? {}
        : {
            scriptReferences: {
              carriers,
              referencedTests,
              unreferenced: references.unreferenced,
              referencingFiles: references.referencingFiles,
            },
          }),
    };

    if (
      !planValidator({
        files,
        integrationSet,
        changedIntegrationTests,
        expected: files,
        deletedSet,
        referencedTests,
        shardWrappers,
        repoSweepTests: repoSweep,
      })
    ) {
      return fallback("selection-unexplained", diagnostics);
    }

    return { files, fallbackToFull: false, reason: "scoped", diagnostics };
  } catch (error) {
    return fallback("selector-error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Derive both the tiers to run AND the scoped integration-file plan for a
 * `--changed` run in one pass (design.md D6). The integration plan is always
 * computed — never skipped — so a zero-file selection is still observable
 * via `integrationPlan.files`/`formatChangedSelectionSummary`. The
 * integration tier is only added when the plan selected at least one file;
 * a full-fallback plan always carries the complete (non-empty) manifest, so
 * a fallback always includes the integration tier too.
 *
 * @param {string[]} changedFiles
 * @param {object} [options] forwarded to `selectIntegrationTestFilesForChangedFiles`
 * @returns {{tiers: ("unit"|"integration")[], integrationPlan: {files: string[], fallbackToFull: boolean, reason: string, diagnostics: object}}}
 */
export function buildChangedTestExecutionPlan(changedFiles, options = {}) {
  const integrationPlan = selectIntegrationTestFilesForChangedFiles(changedFiles, options);
  const tiers =
    integrationPlan.files.length > 0 ? [TIER_UNIT, TIER_INTEGRATION] : [TIER_UNIT];
  return { tiers, integrationPlan };
}

/**
 * Render the one-line, machine-greppable `--changed` selection summary
 * (design.md D6). Zero files renders exactly `integration_files=0/<total>
 * selection=scoped` — no unresolved-paths suffix, since a zero-file scoped
 * plan by definition has no unknown classifications.
 *
 * @param {{files: string[], fallbackToFull: boolean, reason: string, diagnostics: object}} integrationPlan
 * @param {number} totalFiles
 * @returns {string}
 */
export function formatChangedSelectionSummary(integrationPlan, totalFiles) {
  const selection = integrationPlan.fallbackToFull
    ? `full-fallback:${integrationPlan.reason}`
    : "scoped";
  const base = `integration_files=${integrationPlan.files.length}/${totalFiles} selection=${selection}`;
  const classifications = integrationPlan.diagnostics?.classifications ?? {};
  const unresolvedPaths = Object.entries(classifications)
    .filter(([, kind]) => kind === "unknown")
    .map(([file]) => file)
    .sort();
  const unknownSuffix =
    unresolvedPaths.length > 0
      ? ` unresolved_paths=${unresolvedPaths.join(",")}`
      : "";
  return `${base}${unknownSuffix}`;
}

/**
 * Render the one-line `script_references` summary (D4), or `null` when the
 * plan fell back or the changed set had no carrier. Paths in
 * `unreferenced_paths` percent-escape `%`, `,` and control characters
 * (`%XX`, uppercase hex) so the summary is always one physical line and each
 * path stays identifiable.
 *
 * @param {{fallbackToFull?: boolean, diagnostics?: object}} integrationPlan
 * @returns {string | null}
 */
export function formatScriptReferenceSummary(integrationPlan) {
  const references = integrationPlan?.diagnostics?.scriptReferences;
  if (integrationPlan?.fallbackToFull === true || !references) return null;
  const escapePath = (file) =>
    file.replace(
      /[%,\u0000-\u001f\u007f-\u009f]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );
  const unreferenced = [...references.unreferenced].sort();
  const base =
    `script_references carriers=${references.carriers.length} ` +
    `referencing_files=${references.referencingFiles} unreferenced=${unreferenced.length}`;
  return unreferenced.length > 0
    ? `${base} unreferenced_paths=${unreferenced.map(escapePath).join(",")}`
    : base;
}

/**
 * Render the one-line `repo_sweep` summary naming the fixed repo-sweep guards
 * a scoped plan carries, or `null` when the plan fell back (it already runs
 * everything) or carries none.
 *
 * @param {{fallbackToFull?: boolean, diagnostics?: object}} integrationPlan
 * @returns {string | null}
 */
export function formatRepoSweepSummary(integrationPlan) {
  const sweep = integrationPlan?.diagnostics?.repoSweepTests ?? [];
  if (integrationPlan?.fallbackToFull === true || sweep.length === 0) return null;
  return `repo_sweep files=${sweep.length} paths=${sweep.join(",")}`;
}

export function formatIntegrationManifestSelection(manifestPath, files) {
  return `[test-suite] integration selection=explicit-manifest manifest=${normalizeRepoPath(manifestPath)} files=${files.length}`;
}

/** Fail-visible full-fallback banner (R4). */
export function formatFullFallbackBanner({ reason, summary, allowFullFallback }) {
  return (
    `[test-suite] FULL-FALLBACK (fail-visible): reason=${reason}; ` +
    `selection=${summary}` +
    (allowFullFallback
      ? `; continuing because --allow-full-fallback was set (opt-in escape; not CI default)`
      : `; exiting ${EXIT_FULL_FALLBACK} (pass --allow-full-fallback to continue)`)
  );
}

/**
 * Return and validate the fixed fast-gate carrier set.
 *
 * The validation is deliberately performed at route execution time so a
 * renamed, deleted, or retiered carrier fails closed instead of silently
 * shrinking the PR gate. `--tier all` does not use this list.
 *
 * @param {{repoRoot?: string}} options
 * @returns {string[]}
 */
export function fastIntegrationFiles({ repoRoot = defaultRepoRoot() } = {}) {
  const manifestIntegration = new Set(listFiles(TIER_INTEGRATION));
  const invalid = FAST_INTEGRATION_TESTS.filter(
    (file) =>
      !manifestIntegration.has(file) ||
      !existsSync(path.join(repoRoot, file)),
  );
  if (invalid.length > 0) {
    throw new Error(
      `fast integration carrier set is invalid (missing or not integration-tier): ${invalid.join(", ")}`,
    );
  }
  return [...FAST_INTEGRATION_TESTS];
}

export function isConsumerRulesTagBase(base) {
  return typeof base === "string" && RULES_TAG_RE.test(base);
}

function hasInstalledConsumerRulesSource(repoRoot) {
  return (
    existsSync(path.join(repoRoot, ".devpro-agent-rules", "AGENTS.md")) &&
    existsSync(
      path.join(
        repoRoot,
        ".devpro-agent-rules",
        ".devpro",
        "scripts",
        "sync-agent-rules.mjs",
      ),
    )
  );
}

function gitmodulesDeclaresConsumerRulesSource(repoRoot) {
  const gitmodulesPath = path.join(repoRoot, ".gitmodules");
  if (!existsSync(gitmodulesPath)) return false;
  const body = readFileSync(gitmodulesPath, "utf8");
  return /^\s*path\s*=\s*\.devpro-agent-rules\s*$/m.test(body);
}

function hasGeneratedConsumerSmokeEntrypoints(repoRoot) {
  return (
    existsSync(path.join(repoRoot, ".devpro", "scripts", "sync-agent-rules.mjs")) &&
    existsSync(path.join(repoRoot, ".devpro", "scripts", "devpro-doctor.mjs"))
  );
}

export function isConsumerRulesRepoRoot(repoRoot) {
  return (
    hasInstalledConsumerRulesSource(repoRoot) ||
    (gitmodulesDeclaresConsumerRulesSource(repoRoot) &&
      hasGeneratedConsumerSmokeEntrypoints(repoRoot))
  );
}

/**
 * Resolve whether the requested root is a consumer repository itself, a
 * consumer-owned true rules submodule, or a normal source repository.
 * Ambiguous and failed Git probes preserve source rigor.
 */
export function resolveConsumerRulesContext(
  repoRoot,
  { runGit = spawnSync } = {},
) {
  const resolvedRoot = path.resolve(repoRoot);
  if (isConsumerRulesRepoRoot(resolvedRoot)) {
    return {
      profile: "consumer",
      mode: "direct",
      consumerRoot: resolvedRoot,
    };
  }

  let probe;
  try {
    probe = runGit(
      "git",
      ["-C", resolvedRoot, "rev-parse", "--show-superproject-working-tree"],
      { encoding: "utf8" },
    );
  } catch {
    return {
      profile: "source",
      mode: "direct",
      diagnostic: "superproject probe failed",
    };
  }

  if (probe?.error || probe?.status !== 0 || typeof probe?.stdout !== "string") {
    return {
      profile: "source",
      mode: "direct",
      diagnostic: "superproject probe failed",
    };
  }

  const superproject = probe.stdout.trim();
  if (!superproject) return { profile: "source", mode: "direct" };

  const consumerRoot = path.resolve(superproject);
  if (
    resolvedRoot !== path.join(consumerRoot, ".devpro-agent-rules") ||
    !isConsumerRulesRepoRoot(consumerRoot)
  ) {
    return { profile: "source", mode: "direct" };
  }

  return {
    profile: "consumer",
    mode: "submodule",
    consumerRoot,
  };
}

// Single stdout line of the consumer-na route. Exported so the final-suite
// profile cross-check compares against the runner's own wording (design D2/D3
// of fix-seal-final-consumer-na-suite-evidence); `main()` prints exactly this.
export const CONSUMER_PROFILE_NA_LINE =
  "[test-suite] source-maintainer checks: N/A reason=consumer repository profile; source-only corpus checks are not required";

export function selectTestSuiteRoute({ changedBase, consumerContext }) {
  if (consumerContext?.profile !== "consumer") return "source-suite";
  return isConsumerRulesTagBase(changedBase)
    ? "consumer-smoke"
    : "consumer-na";
}

export function consumerRulesSmokeCommands({ nodeCommand = process.execPath } = {}) {
  return [
    {
      label: "submodule-init",
      command: "git",
      args: ["submodule", "update", "--init", ".devpro-agent-rules"],
    },
    {
      label: "submodule-sync",
      command: nodeCommand,
      args: [".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs", "--sync"],
    },
    {
      label: "sync-check",
      command: nodeCommand,
      args: [".devpro/scripts/sync-agent-rules.mjs", "--check"],
    },
    {
      label: "doctor-consumer-smoke",
      command: nodeCommand,
      args: [".devpro/scripts/devpro-doctor.mjs", "--consumer-smoke"],
    },
    {
      label: "generated-tool-tests",
      command: nodeCommand,
      args: ["--test", ...CONSUMER_RULES_SMOKE_TESTS],
    },
  ];
}

function splitNameOnlyOutput(stdout) {
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Effective diff base for `--changed <base>`.
 *
 * A linked worktree cannot fast-forward the local `<base>` branch (the main checkout holds it, and the pre-pr skill
 * forbids mutating it), so a stale local `main` makes `<base>...HEAD` start from an old merge-base and pulls every
 * commit merged since into the selection (PR #3045: 4 changed files selected 69 test files). The remote-tracking ref is
 * what the PR's own three-dot diff uses, so prefer it when it exists. Only a bare branch name is rewritten: a full ref
 * (anything with a `/`, e.g. `origin/main`) and a consumer rules tag are already exact, and a missing remote-tracking
 * ref falls back to the name as given. `spawnGit` is injectable for unit testing.
 *
 * @param {string} base the `--changed` argument
 * @param {string} root repo root
 * @param {{ spawnGit?: typeof spawnSync }} [options]
 * @returns {string} the ref `changedSetVsBase` should diff against
 */
export function resolveChangedBaseRef(base, root, { spawnGit = spawnSync } = {}) {
  if (typeof base !== "string" || base === "" || base.includes("/") || isConsumerRulesTagBase(base)) {
    return base;
  }
  const probe = spawnGit(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  return probe.status === 0 ? `origin/${base}` : base;
}

/**
 * Two `git diff --name-only` queries against the same base (design.md D4):
 * the plain query (rename-aware: a renamed test's add half is listed, its
 * delete half is not) and a second `--diff-filter=D` query that identifies
 * which of those paths git confirms were deleted. `spawnGit` is injectable
 * for unit testing without a real git spawn.
 *
 * @param {string} base ref to diff against (e.g. "main")
 * @param {string} root repo root
 * @param {{ spawnGit?: typeof spawnSync }} [options]
 * @returns {{ changed: string[], deleted: string[] }} both empty on git
 *   failure so the caller fails closed (`changed-set-unavailable` /
 *   `unknown-path`)
 */
export function changedSetVsBase(base, root, { spawnGit = spawnSync } = {}) {
  const changedRes = spawnGit("git", ["diff", `${base}...HEAD`, "--name-only"], {
    cwd: root,
    encoding: "utf8",
  });
  const changed =
    changedRes.status === 0 && typeof changedRes.stdout === "string"
      ? splitNameOnlyOutput(changedRes.stdout)
      : [];

  const deletedRes = spawnGit(
    "git",
    ["diff", `${base}...HEAD`, "--name-only", "--diff-filter=D"],
    { cwd: root, encoding: "utf8" },
  );
  const deleted =
    deletedRes.status === 0 && typeof deletedRes.stdout === "string"
      ? splitNameOnlyOutput(deletedRes.stdout)
      : [];

  return { changed, deleted };
}

/**
 * Old paths of scripts git reports as renamed vs <base> (`changedSetVsBase`
 * lists only a rename's destination). NUL-delimited `--name-status -z` keeps
 * paths lossless (no quoting of spaces or non-ASCII). Returns `null` — never
 * an empty list — when the answer cannot be determined (git failure, or any
 * entry that is not `R<score> <old> <new>`), so the caller fails closed.
 *
 * @param {string} base ref to diff against
 * @param {string} root repo root
 * @param {{ spawnGit?: typeof spawnSync }} [options]
 * @returns {string[] | null}
 */
export function renamedSourcesVsBase(base, root, { spawnGit = spawnSync } = {}) {
  const res = spawnGit(
    "git",
    ["diff", `${base}...HEAD`, "--name-status", "-z", "--diff-filter=R"],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  const tokens = res.stdout.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  if (tokens.length % 3 !== 0) return null;
  const sources = [];
  for (let i = 0; i < tokens.length; i += 3) {
    const [status, oldPath, newPath] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (!/^R\d*$/u.test(status) || oldPath === "" || newPath === "") return null;
    sources.push(normalizeRepoPath(oldPath));
  }
  return sources;
}

/**
 * The real `--changed` call chain, with an injectable `spawnGit`: changed and
 * deleted paths, rename sources, then the execution plan. `main()` calls this
 * so tests exercise the same chain (including the undetermined-rename
 * fallback) without a real git repository.
 *
 * @param {string} diffBase resolved diff base ref
 * @param {string} root repo root
 * @param {{ spawnGit?: typeof spawnSync } & object} [options] `spawnGit`, plus
 *   selector options (e.g. `integrationFiles`) forwarded to the plan builder
 * @returns {{ changed: string[], execution: ReturnType<typeof buildChangedTestExecutionPlan> }}
 */
export function resolveChangedExecutionPlan(
  diffBase,
  root,
  { spawnGit = spawnSync, ...selectorOptions } = {},
) {
  const { changed, deleted } = changedSetVsBase(diffBase, root, { spawnGit });
  const renamedFrom = renamedSourcesVsBase(diffBase, root, { spawnGit });
  const execution = buildChangedTestExecutionPlan(changed, {
    repoRoot: root,
    deletedFiles: deleted,
    renamedFromFiles: renamedFrom,
    ...selectorOptions,
  });
  return { changed, execution };
}

function printHelp() {
  console.log(`Usage: node .devpro/scripts/run-test-suite.mjs [--tier unit|integration|fast|all | --changed <base> | --tier integration --integration-manifest <path>] [--allow-full-fallback] [--stdio log|inherit]

  --tier unit         Run manifest unit subset only (~2-5s)
  --tier integration  Run manifest integration subset only
  --tier fast         Run complete unit tier plus the fixed PR-latency integration carrier set
  --tier all          Run canonical full suite (default): unit then integration manifest tiers
 --changed <base>    Select from the diff vs <base> (a bare branch name prefers its
                      origin/<base> remote-tracking ref when present, because a
                      linked worktree's local <base> can be stale; the printed
                      diff base= line names the ref used): complete unit tier always,
                      plus only the integration tests this PR added or modified,
                      the ones whose source names a changed non-test script by its
                      full repo-relative path (a \`script_references\` line lists
                      scripts no test names), the shard-import wrappers of
                      those, and the fixed repo-sweep guards (a \`repo_sweep\`
                      line lists them).
                      Full-fallback (unprovable state) exits ${EXIT_FULL_FALLBACK}
                      unless --allow-full-fallback.
  --integration-manifest <path>
                      Replay exact repository-relative integration-tier paths
                      on the source checkout only; incompatible with --changed and --root.
  --allow-full-fallback  Opt-in escape only (not CI default): continue after full-fallback
                      with test-result exit; still prints the fail-visible banner.
  --stdio log          Default. Write child stdout/stderr to notes/tmp log and print summary.
  --stdio inherit      Print raw child stdout/stderr to the console.

Every run prints its wall-clock real time; there is no fixed-budget block here.
The fast tier is bounded feedback only; it does not replace the exhaustive all tier.`);
}

function resolveMainCheckoutRoot(repoRoot) {
  // Shared memoized probe; this call site keeps BOTH of its original
  // fallbacks-to-repoRoot: on a failed/empty probe, and on a common-dir whose
  // basename is not ".git" (e.g. a --separate-git-dir checkout), where the
  // parent of the git dir is not the checkout root.
  const { ok, commonDir } = probeGitCommonDir(repoRoot);
  if (!ok || !commonDir) return repoRoot;
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : repoRoot;
}

function safeLogLabel(label) {
  return label.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function createLogFile(repoRoot, label) {
  const notesTmp = path.join(resolveMainCheckoutRoot(repoRoot), "notes", "tmp");
  mkdirSync(notesTmp, { recursive: true });
  const safe = safeLogLabel(label);
  for (let i = 0; i < 100; i += 1) {
    const suffix = `${process.pid}.${Date.now()}.${logCounter++}`;
    const logPath = path.join(notesTmp, `run-test-suite-${safe}.${suffix}.log`);
    try {
      const fd = openSync(logPath, "wx");
      return { logPath, fd };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`failed to create unique log file in ${notesTmp}`);
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function summarizeTapLog(logPath) {
  const rawBytes = readFileSync(logPath);
  const text = rawBytes.toString("utf8");
  // With its output redirected `node --test` writes TAP on Node 20/22 and the spec
  // format on Node 24; the summary lines differ only in their prefix.
  const readCount = (name) => {
    const match = text.match(new RegExp(`^(?:# |\u2139 )${name}\\s+(\\d+)`, "m"));
    return match ? Number(match[1]) : null;
  };
  const failedNames = [];
  for (const line of text.split("\n")) {
    // The spec format repeats every failure under this heading; stop before the repeat.
    if (line === "\u2716 failing tests:") break;
    const match =
      line.match(/^not ok \d+ - (.+)$/) ?? line.match(/^\u2716 (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/);
    if (match) failedNames.push(match[1]);
  }
  return {
    lines: countLines(text),
    bytes: rawBytes.length,
    digestSha256: createHash("sha256").update(rawBytes).digest("hex"),
    tests: readCount("tests"),
    suites: readCount("suites"),
    pass: readCount("pass"),
    fail: readCount("fail"),
    cancelled: readCount("cancelled"),
    skipped: readCount("skipped"),
    todo: readCount("todo"),
    failedNames,
  };
}

function formatCount(value) {
  return value === null ? "?" : String(value);
}

export function formatLogSummary({ scope, label, logPath, summary }) {
  const failed =
    summary.failedNames.length > 0
      ? ` failed_names=${summary.failedNames.slice(0, 5).join(" | ")}`
      : "";
  return `[test-suite] ${scope}=${label} log=${logPath} lines=${summary.lines} bytes=${summary.bytes} digest_sha256=${summary.digestSha256} tests=${formatCount(summary.tests)} pass=${formatCount(summary.pass)} fail=${formatCount(summary.fail)} skipped=${formatCount(summary.skipped)}${failed}`;
}

function printLogSummary(details) {
  console.log(formatLogSummary(details));
}

// One digest for a whole run, so a caller that has to record a single 64-hex value (`record-regression-head.mjs
// --suite-digest`) does not invent its own way to combine the per-tier `digest_sha256=` values. It covers exactly the
// tiers that ran: the hash input is one `<tier>=<digest>\n` line per tier, sorted by tier name, so the value does not
// depend on run order, and a unit-only run differs from a unit + integration run. A tier that ran with a different
// file selection (`--changed main` picks integration files per PR) has a different log, hence a different digest.
export function combineTierDigests(entries) {
  const lines = [...entries]
    .sort((a, b) => (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0))
    .map(({ tier, digestSha256 }) => {
      if (!/^[0-9a-f]{64}$/.test(digestSha256 ?? "")) {
        throw new Error(`tier ${tier}: digest must be 64 lowercase hex`);
      }
      return `${tier}=${digestSha256}\n`;
    });
  return createHash("sha256").update(lines.join("")).digest("hex");
}

export function formatSuiteDigest(entries) {
  const tiers = entries.map(({ tier }) => tier).sort();
  return `[test-suite] suite_digest_sha256=${combineTierDigests(entries)} tiers=${tiers.join(",")}`;
}

// Printed only for a run in which every tier passed: a digest of a red run must not become a receipt. Without a log
// (`--stdio inherit`) there is nothing to hash, which is said out loud instead of leaving the line out.
export function reportSuiteDigest(digests, tierCount, status) {
  if (status !== 0) return;
  if (digests.length !== tierCount) {
    console.log(
      "[test-suite] suite_digest_sha256=unavailable reason=a tier wrote no log (--stdio inherit writes none)",
    );
    return;
  }
  console.log(formatSuiteDigest(digests));
}

/**
 * Per suite/worker owned friction log under os.tmpdir() (F-4 / D4).
 * Injected into every test child so module-load FRICTION_LOG never binds the
 * live hooks/state/session-friction.log during suite runs.
 */
export function suiteOwnedFrictionEnv({
  workerId = process.pid,
  suiteToken = randomUUID(),
} = {}) {
  const ownedDir = path.join(
    tmpdir(),
    `devpro-suite-friction-${workerId}-${suiteToken}`,
  );
  mkdirSync(ownedDir, { recursive: true });
  return {
    DEVPRO_FRICTION_LOG: path.join(ownedDir, "session-friction.log"),
  };
}

const TEMP_ROOT_ENV_NAMES = new Set(["TMPDIR", "TMP", "TEMP"]);

/**
 * Per runCommand owned temp root. Suite files create temp directories under
 * os.tmpdir() and most never remove them, so the child gets its own root that
 * runCommand deletes afterwards. All three names are set because os.tmpdir()
 * reads TMPDIR on POSIX and TEMP/TMP on Windows, where names are case-insensitive.
 */
function suiteOwnedTempEnv(baseEnv) {
  const ownedDir = mkdtempSync(path.join(tmpdir(), "devpro-suite-tmp-"));
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (!TEMP_ROOT_ENV_NAMES.has(name.toUpperCase())) env[name] = value;
  }
  for (const name of TEMP_ROOT_ENV_NAMES) env[name] = ownedDir;
  return { env, ownedDir };
}

function suiteChildEnv() {
  const { env, ownedDir } = suiteOwnedTempEnv(process.env);
  return {
    env: {
      ...env,
      DEVPRO_REQUIRE_ISOLATED_CONTROL_EVIDENCE: "1",
      ...suiteOwnedFrictionEnv(),
    },
    ownedTempDir: ownedDir,
  };
}

function frictionOwnedDirFromEnv(env) {
  const frictionLog = env?.DEVPRO_FRICTION_LOG;
  if (typeof frictionLog !== "string" || frictionLog.length === 0) return null;
  return path.dirname(frictionLog);
}

export function runCommand(
  command,
  args,
  { repoRoot, stdioMode = "log", logLabel = "command" },
) {
  if (!VALID_STDIO_MODES.has(stdioMode)) {
    throw new Error(`invalid stdio mode: ${stdioMode}`);
  }

  const startNs = process.hrtime.bigint();
  let result;
  let logPath = null;
  let summary = null;
  const { env: childEnv, ownedTempDir } = suiteChildEnv();
  const frictionOwnedDir = frictionOwnedDirFromEnv(childEnv);

  try {
    if (stdioMode === "inherit") {
      result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        env: childEnv,
      });
    } else {
      const log = createLogFile(repoRoot, logLabel);
      logPath = log.logPath;
      try {
        result = spawnSync(command, args, {
          cwd: repoRoot,
          stdio: ["ignore", log.fd, log.fd],
          env: childEnv,
        });
      } finally {
        closeSync(log.fd);
      }
      summary = summarizeTapLog(logPath);
    }
  } finally {
    // F3: each runCommand owns a unique os.tmpdir friction dir — remove after the child exits.
    if (frictionOwnedDir) {
      rmSync(frictionOwnedDir, { recursive: true, force: true });
    }
    try {
      rmSync(ownedTempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      // A leftover temp root must not turn a finished run red; name it so it can be removed by hand.
      console.error(`[test-suite] temp-root cleanup failed dir=${ownedTempDir} reason=${error.code ?? error.message}`);
    }
  }

  const realSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
  return {
    error: result.error ?? null,
    status: result.error ? 1 : result.status ?? 1,
    realSeconds,
    logPath,
    summary,
  };
}

export function runNodeCommand(args, { repoRoot, stdioMode = "log", logLabel = "node" }) {
  return runCommand(process.execPath, args, { repoRoot, stdioMode, logLabel });
}

export function expandExplicitTier(tier) {
  if (tier === "all") return [TIER_UNIT, TIER_INTEGRATION];
  if (tier === TIER_FAST) return [TIER_UNIT, TIER_FAST];
  if (tier === TIER_UNIT || tier === TIER_INTEGRATION) return [tier];
  throw new Error(`unknown tier: ${tier}`);
}

export function runTierSequence(tiers, runOneTier) {
  let worstStatus = 0;
  for (const t of tiers) {
    const status = runOneTier(t);
    if (status !== 0) worstStatus = status;
  }
  return worstStatus;
}

export function orderFilesForTier(tier, files) {
  if (tier !== TIER_INTEGRATION) return [...files];
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const aPriority =
        LONG_INTEGRATION_TEST_PRIORITY_INDEX.get(a.file) ?? Number.POSITIVE_INFINITY;
      const bPriority =
        LONG_INTEGRATION_TEST_PRIORITY_INDEX.get(b.file) ?? Number.POSITIVE_INFINITY;
      return aPriority - bPriority || a.index - b.index;
    })
    .map(({ file }) => file);
}

/**
 * Run one tier and print its wall-clock time. Returns the child exit status.
 * @param {"unit"|"integration"|"fast"} tier
 * @param {string} repoRoot
 * @returns {number}
 */
function runTier(tier, repoRoot, stdioMode, filesOverride = null, digests = null) {
  const rawFiles =
    filesOverride !== null
      ? filesOverride
      : tier === TIER_FAST
      ? fastIntegrationFiles({ repoRoot })
      : listFiles(tier);
  const files = orderFilesForTier(
    tier === TIER_FAST ? TIER_INTEGRATION : tier,
    rawFiles,
  );
  if (files.length === 0) {
    console.error(`[test-suite] no files for tier "${tier}"`);
    return 1;
  }

  console.log(`[test-suite] tier=${tier} files=${files.length} — running…`);

  const result = runNodeCommand(["--test", ...files], {
    repoRoot,
    stdioMode,
    logLabel: `tier-${tier}`,
  });

  if (result.error) {
    console.error(`[test-suite] tier=${tier} failed: ${result.error.message}`);
    console.log(
      `[test-suite] tier=${tier} real=${result.realSeconds.toFixed(1)}s status=error`,
    );
    return 1;
  }

  if (result.logPath && result.summary) {
    printLogSummary({
      scope: "tier",
      label: tier,
      logPath: result.logPath,
      summary: result.summary,
    });
    digests?.push({ tier, digestSha256: result.summary.digestSha256 });
  }

  const status = result.status;
  console.log(
    `[test-suite] tier=${tier} real=${result.realSeconds.toFixed(1)}s status=${status === 0 ? "pass" : "fail"}`,
  );
  if (status !== 0) {
    emitTransientHintForTierResult(result);
  }
  return status;
}

function runAllTiers(repoRoot, stdioMode) {
  const tiers = expandExplicitTier("all");
  const startNs = process.hrtime.bigint();
  console.log(
    `[test-suite] tier=all expands=${tiers.join(",")} — running sequential manifest tiers…`,
  );

  const digests = [];
  const worstStatus = runTierSequence(tiers, (t) =>
    runTier(t, repoRoot, stdioMode, null, digests),
  );

  const realSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
  console.log(
    `[test-suite] tier=all real=${realSeconds.toFixed(1)}s status=${worstStatus === 0 ? "pass" : "fail"}`,
  );
  reportSuiteDigest(digests, tiers.length, worstStatus);
  return worstStatus;
}

function runFastGate(repoRoot, stdioMode) {
  const tiers = expandExplicitTier(TIER_FAST);
  const startNs = process.hrtime.bigint();
  console.log(
    `[test-suite] tier=fast expands=${tiers.join(",")} — running complete unit plus fixed integration carriers…`,
  );

  const digests = [];
  const worstStatus = runTierSequence(tiers, (t) =>
    runTier(t, repoRoot, stdioMode, null, digests),
  );

  const realSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
  console.log(
    `[test-suite] tier=fast real=${realSeconds.toFixed(1)}s status=${worstStatus === 0 ? "pass" : "fail"}`,
  );
  reportSuiteDigest(digests, tiers.length, worstStatus);
  return worstStatus;
}

function displayCommand(command, args) {
  const displayName = command === process.execPath ? "node" : command;
  return `${displayName} ${args.join(" ")}`;
}

function runConsumerRulesSmoke(repoRoot, changedBase, stdioMode) {
  console.log(
    `[test-suite] --changed ${changedBase}: consumer rules tag + consumer rules metadata/source -> consumer rules smoke`,
  );
  console.log(
    "[test-suite] source-maintainer checks: N/A reason=consumer rules lane uses generated-file smoke; source-only corpus checks are not required",
  );

  let worstStatus = 0;
  for (const { label, command, args } of consumerRulesSmokeCommands()) {
    console.log(`[test-suite] smoke=${label} — running: ${displayCommand(command, args)}`);
    const result = runCommand(command, args, {
      repoRoot,
      stdioMode,
      logLabel: `smoke-${label}`,
    });

    if (result.error) {
      console.error(`[test-suite] smoke=${label} failed: ${result.error.message}`);
      console.log(
        `[test-suite] smoke=${label} real=${result.realSeconds.toFixed(1)}s status=error`,
      );
      worstStatus = 1;
      continue;
    }

    if (result.logPath && result.summary) {
      printLogSummary({
        scope: "smoke",
        label,
        logPath: result.logPath,
        summary: result.summary,
      });
    }

    const status = result.status;
    console.log(
      `[test-suite] smoke=${label} real=${result.realSeconds.toFixed(1)}s status=${status === 0 ? "pass" : "fail"}`,
    );
    if (status !== 0) worstStatus = status;
  }
  return worstStatus;
}

/**
 * macOS only: /usr/bin/git is an xcrun shim that re-resolves the active
 * developer directory on EVERY invocation (measured ~15.7ms/spawn vs ~7.9ms for
 * the resolved binary — a 21% user+sys CPU cut on git-heavy tiers). This suite
 * is git-spawn-bound (thousands of real git forks across the integration tier),
 * so front PATH once here with the developer git dir the shim would exec anyway:
 * spawned test children inherit process.env, so their git spawns skip the shim.
 * Same binary, same version, same semantics — spawn latency only. No-op
 * off-darwin (Linux CI has no shim), when xcrun is unavailable, or when the
 * resolved git is already /usr/bin/git. Idempotent: skips if already fronted.
 */
function frontDeveloperGitOnPath() {
  if (process.platform !== "darwin") return;
  try {
    const realGit = spawnSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
    }).stdout?.trim();
    if (!realGit || realGit === "/usr/bin/git" || !existsSync(realGit)) return;
    const dir = path.dirname(realGit);
    const parts = (process.env.PATH || "").split(path.delimiter);
    if (parts[0] === dir) return;
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ""}`;
  } catch {
    // xcrun missing / not on a dev machine → leave PATH untouched (fail open).
  }
}

/**
 * macOS only: Node fsync is F_FULLFSYNC, which waits for the physical device
 * and queues every process on the machine behind it. The suite publishes
 * thousands of fixture records through it under file-level concurrency
 * (measured: integration tier 436s -> 346s real with the same failure set).
 * Preload the fixture shim into every spawned test process and its Node
 * descendants so the flush becomes a descriptor check; what the shim keeps and
 * drops is documented in tests/lib/fixture-fsync-shim.cjs. The shim is a no-op
 * off-darwin, so a run on any other platform keeps flushing for real, and
 * DEVPRO_TEST_FIXTURE_FSYNC=real restores the real flush on macOS: that is the
 * only way a macOS run exercises the real call. Skipped when the shim file is
 * absent (a checkout without the source test tree).
 */
function preloadFixtureFsyncShim() {
  if (process.platform !== "darwin" || process.env.DEVPRO_TEST_FIXTURE_FSYNC === "real") return;
  const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "tests", "lib", "fixture-fsync-shim.cjs");
  if (!existsSync(shim)) return;
  const preload = `--require ${JSON.stringify(shim)}`;
  const inherited = process.env.NODE_OPTIONS ?? "";
  if (inherited.includes(preload)) return;
  process.env.NODE_OPTIONS = inherited === "" ? preload : `${inherited} ${preload}`;
}

function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const {
    tier,
    changedBase,
    repoRoot,
    stdioMode,
    allowFullFallback,
    explicitRoot = false,
    integrationManifestPath = null,
  } = parsedArgs;

  const consumerContext = resolveConsumerRulesContext(repoRoot);
  const route = selectTestSuiteRoute({ changedBase, consumerContext });
  assertSourceOnlyManifestRoute({ integrationManifestPath, route });
  if (route === "consumer-na") {
    console.log(CONSUMER_PROFILE_NA_LINE);
    process.exit(0);
  }

  frontDeveloperGitOnPath();

  if (route === "consumer-smoke") {
    process.exit(
      runConsumerRulesSmoke(
        consumerContext.consumerRoot,
        changedBase,
        stdioMode,
      ),
    );
  }

  // Source suite only: a consumer smoke run keeps the real flush.
  preloadFixtureFsyncShim();

  const checkoutRootKind = classifyCheckoutRoot({
    repoRoot,
    runnerRepoRoot: defaultRepoRoot(),
    explicitRoot,
  });
  if (checkoutRootKind === "source") {
    const checkoutPreflightStatus = runWindowsCheckoutPreflight({ repoRoot });
    if (checkoutPreflightStatus !== 0) process.exit(checkoutPreflightStatus);
  } else if (checkoutRootKind === "synthetic") {
    console.log(
      "[test-suite] checkout-preflight=N/A reason=verified-explicit-synthetic-root",
    );
  } else {
    console.error(
      "[test-suite] checkout-preflight=FAIL reason=explicit root is neither an identified source checkout nor a verified synthetic fixture",
    );
    process.exit(1);
  }

  let tiers;
  let integrationFilesOverride = null;
  let pendingFullFallback = null;
  if (integrationManifestPath !== null) {
    integrationFilesOverride = readIntegrationManifestFiles(integrationManifestPath, {
      repoRoot,
    });
    console.log(formatIntegrationManifestSelection(integrationManifestPath, integrationFilesOverride));
    tiers = [TIER_INTEGRATION];
  } else if (changedBase !== null) {
    const diffBase = resolveChangedBaseRef(changedBase, repoRoot);
    const { changed, execution } = resolveChangedExecutionPlan(diffBase, repoRoot);
    tiers = execution.tiers;
    console.log(
      `[test-suite] --changed ${changedBase}: ${changed.length} changed file(s) → tiers: ${tiers.join(", ")}`,
    );
    // Names the ref actually diffed against (a bare `<base>` prefers origin/<base>, see resolveChangedBaseRef).
    console.log(`[test-suite] --changed ${changedBase}: diff base=${diffBase}`);
    // Always computed and printed — even at zero integration files — so
    // selection stays observable without ever calling runTier("integration",
    // []) or emitting an unpaired `tier=integration` terminal line (design.md
    // D6 / BRD C2 seal-final pairing).
    integrationFilesOverride = execution.integrationPlan.files;
    const summary = formatChangedSelectionSummary(
      execution.integrationPlan,
      listFiles(TIER_INTEGRATION).length,
    );
    console.log(`[test-suite] ${summary}`);
    const referenceSummary = formatScriptReferenceSummary(execution.integrationPlan);
    if (referenceSummary !== null) console.log(`[test-suite] ${referenceSummary}`);
    const repoSweepSummary = formatRepoSweepSummary(execution.integrationPlan);
    if (repoSweepSummary !== null) console.log(`[test-suite] ${repoSweepSummary}`);
    if (execution.integrationPlan.fallbackToFull === true) {
      const banner = formatFullFallbackBanner({
        reason: execution.integrationPlan.reason,
        summary,
        allowFullFallback,
      });
      console.error(banner);
      if (!allowFullFallback) {
        process.exit(EXIT_FULL_FALLBACK);
      }
      pendingFullFallback = execution.integrationPlan.reason;
    }
  } else if (tier === "all") {
    process.exit(runAllTiers(repoRoot, stdioMode));
  } else if (tier === TIER_FAST) {
    process.exit(runFastGate(repoRoot, stdioMode));
  } else {
    tiers = expandExplicitTier(tier);
  }

  let worstStatus = 0;
  const digests = [];
  for (const t of tiers) {
    const status = runTier(
      t,
      repoRoot,
      stdioMode,
      t === TIER_INTEGRATION ? integrationFilesOverride : null,
      digests,
    );
    if (status !== 0) worstStatus = status;
  }
  reportSuiteDigest(digests, tiers.length, worstStatus);
  if (pendingFullFallback && worstStatus === 0) {
    console.error(
      `[test-suite] FULL-FALLBACK completed under --allow-full-fallback (reason=${pendingFullFallback})`,
    );
  }
  process.exit(worstStatus);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
