#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCurrentBranch,
  readAgentsMdVersion,
  resolveAbsoluteHooksPath,
  runGit,
} from "./hooks/lib/git-utils.mjs";
import { isProtectedBaseBranch } from "./hooks/lib/branch-naming.mjs";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";
import { askYesNo, createPromptSession } from "./lib/prompt-session.mjs";
import {
  CONSUMER_PRE_PR_CHECKS_BASENAME,
  CONSUMER_PRE_PR_CHECKS_REL,
} from "./lib/consumer-pre-pr-checks.mjs";
import {
  CONSUMER_SECOND_REVIEW_RULES_BASENAME,
  CONSUMER_SECOND_REVIEW_RULES_REL,
} from "./lib/consumer-second-review-rules.mjs";
import {
  LEGACY_SKILL_ENTRY_LINKS,
  LEGACY_SKILL_PAYLOAD_FILES,
  classifyLegacySkillEntryLink,
  classifyLegacySkillPayloadFile,
  ancestorChainStatus,
} from "./lib/legacy-skill-entry-artifacts.mjs";
import { collectEntryTreeSkillSet } from "./lint-agent-skills.mjs";

const modulePath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(modulePath);
const scriptRoot = path.resolve(scriptDir, "../..");
const cwd = process.cwd();
const isCLI = isDirectCliInvocation(import.meta.url);
const defaultCentralRoot = resolveCentralRoot();
const TEST_SYNC_SOURCE_ROOT_ENV = "DEVPRO_TEST_SYNC_SOURCE_ROOT";
const TEST_SYNC_CONSUMER_ROOT_ENV = "DEVPRO_TEST_SYNC_CONSUMER_ROOT";

/** Runtime source root (honors slim-fixture test override when spawned with env). */
function getCentralRoot() {
  const testSource = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
  if (testSource) return path.resolve(testSource);
  return defaultCentralRoot ?? resolveCentralRoot();
}
const SOURCE_ROOT_ERROR =
  "Cannot determine source root. Run from a consumer repo root containing .devpro-agent-rules, " +
  "or run .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync after bootstrap.";

function resolveCentralRoot() {
  if (path.basename(scriptRoot) === ".devpro-agent-rules") {
    return scriptRoot;
  }

  const submoduleRoot = path.resolve(cwd, ".devpro-agent-rules");
  const hasSubmoduleSource =
    existsSync(path.join(submoduleRoot, "AGENTS.md")) &&
    existsSync(path.join(submoduleRoot, ".devpro", "scripts", "sync-agent-rules.mjs"));

  if (hasSubmoduleSource) {
    return submoduleRoot;
  }

  if (!isCLI) {
    // Tests import constants from source repo without running the CLI pipeline.
    return scriptRoot;
  }

  // Consumer-only CLI: source repo self-check would compare derived files to themselves.
  return null;
}

function requireCentralRoot() {
  const root = getCentralRoot();
  if (!root) {
    throw new Error(SOURCE_ROOT_ERROR);
  }
  return root;
}

function resolveConsumerRoot() {
  const testConsumer = process.env[TEST_SYNC_CONSUMER_ROOT_ENV];
  if (testConsumer) {
    return path.resolve(testConsumer);
  }

  const testSource = process.env[TEST_SYNC_SOURCE_ROOT_ENV];
  if (testSource) {
    // Slim submod fixture: consumer is cwd; source is the real devpro-agent-rules tree.
    return cwd;
  }

  const sourceRoot = requireCentralRoot();
  const fromCwd = path.resolve(cwd, ".devpro-agent-rules");
  if (fromCwd === sourceRoot) {
    return cwd;
  }

  if (cwd === sourceRoot) {
    if (path.basename(sourceRoot) === ".devpro-agent-rules") {
      return path.resolve(sourceRoot, "..");
    }
    if (!isCLI) {
      return cwd;
    }
  }

  throw new Error(
    "Cannot determine consumer repo root. Run this script from consumer root, or from .devpro-agent-rules."
  );
}

async function exists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}

async function nodeExists(p) {
  return fs.lstat(p).then(() => true).catch(() => false);
}

const RUNTIME_JSON_SKIP_REL_PATHS = Object.freeze([
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
]);

const GIT_PROBE_TIMEOUT_MS = 5000;
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;
// `git ls-files -s` prints one line per tracked file (~150 bytes), so its output grows with the
// repo: a 26k-file consumer already prints ~4 MB, which overflowed the 1 MB probe cap and was
// read as an empty index (#2862). Bounded probes keep the 1 MB cap; a whole-index read gets a
// cap no real repo reaches.
const GIT_INDEX_MAX_BUFFER = 256 * 1024 * 1024;

let writeFileGitProbeCache = null;

function resetWriteFileGitProbeMemo() {
  writeFileGitProbeCache = null;
}

function crlfToLf(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) {
      out.push(0x0a);
      i += 1;
    } else {
      out.push(buf[i]);
    }
  }
  return Buffer.from(out);
}

function posixRel(from, to) {
  const fromR = realpathSync(from);
  const toR = realpathSync(to);
  return path.relative(fromR, toR).split(path.sep).join("/");
}

function safePosixRel(from, to) {
  try {
    const rel = posixRel(from, to);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel;
  } catch {
    return null;
  }
}

function inferConsumerRootFromRuntimeJson(targetPath) {
  const target = path.resolve(targetPath);
  for (const rel of RUNTIME_JSON_SKIP_REL_PATHS) {
    const suffix = path.join(...rel.split("/"));
    const needle = `${path.sep}${suffix}`;
    if (target.endsWith(needle)) {
      return target.slice(0, target.length - needle.length);
    }
  }
  return null;
}

function probeRelPaths(repo, targetPath) {
  const rels = [];
  const self = safePosixRel(repo, targetPath);
  if (self) rels.push(self);
  const consumerRoot = inferConsumerRootFromRuntimeJson(targetPath);
  if (consumerRoot) {
    for (const rel of RUNTIME_JSON_SKIP_REL_PATHS) {
      const sibling = safePosixRel(repo, path.join(consumerRoot, ...rel.split("/")));
      if (sibling) rels.push(sibling);
    }
  }
  return [...new Set(rels)];
}

function spawnGitArgv(cwd, argv, { maxBuffer = GIT_PROBE_MAX_BUFFER } = {}) {
  return spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
}

function gitProbeFailed(result) {
  if (!result) return "missing-result";
  if (result.error?.code === "ENOENT") return "ENOENT";
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") return "timeout";
  if (result.error) return result.error.code || "spawn-error";
  return null;
}

function logGitProbeWrite(targetPath, reason) {
  console.error(`writeFileUnlessSameBytes: git probe ${reason}; writing ${targetPath}`);
}

function porcelainXyByPath(stdout) {
  const map = new Map();
  const text = stdout || "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\0") {
      i += 1;
      continue;
    }
    if (text.length - i < 3 || text[i + 2] !== " ") return null;
    const xy = text.slice(i, i + 2);
    i += 3;
    const nul = text.indexOf("\0", i);
    if (nul === -1) return null;
    const filePath = text.slice(i, nul);
    i = nul + 1;
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const nul2 = text.indexOf("\0", i);
      if (nul2 === -1) return null;
      i = nul2 + 1;
    }
    if (!filePath) return null;
    map.set(filePath.replace(/\\/g, "/"), xy);
  }
  return map;
}

function loadGitProbeCache(targetPath) {
  const startDir = path.dirname(targetPath);
  const rev = spawnGitArgv(startDir, ["-C", startDir, "--no-optional-locks", "rev-parse", "--show-toplevel"]);
  const revFail = gitProbeFailed(rev);
  if (revFail || rev.status !== 0) {
    logGitProbeWrite(targetPath, revFail || `rev-parse:${rev.status}`);
    return { repo: null, writeAll: true };
  }
  const repo = (rev.stdout || "").trim();
  const probeRels = probeRelPaths(repo, targetPath);
  if (probeRels.length === 0) {
    logGitProbeWrite(targetPath, "posix-rel");
    return { repo, writeAll: true };
  }
  const ls = spawnGitArgv(repo, [
    "-C",
    repo,
    "-c",
    "core.quotePath=false",
    "--no-optional-locks",
    "ls-files",
    "-z",
    "--error-unmatch",
    "--",
    ...probeRels,
  ]);
  const lsFail = gitProbeFailed(ls);
  if (lsFail && lsFail !== "ENOENT") {
    logGitProbeWrite(targetPath, lsFail);
    return { repo, writeAll: true };
  }
  const lsHits = new Set(
    (ls.stdout || "")
      .split("\0")
      .map((line) => line.replace(/\\/g, "/"))
      .filter(Boolean)
  );
  const st = spawnGitArgv(repo, [
    "-C",
    repo,
    "-c",
    "core.quotePath=false",
    "--no-optional-locks",
    "status",
    "--porcelain",
    "-z",
    "--",
    ...probeRels,
  ]);
  const stFail = gitProbeFailed(st);
  if (stFail || st.status !== 0) {
    logGitProbeWrite(targetPath, stFail || `status:${st.status}`);
    return { repo, writeAll: true };
  }
  const xy = porcelainXyByPath(st.stdout);
  if (xy === null) {
    logGitProbeWrite(targetPath, "porcelain-parse");
    return { repo, writeAll: true };
  }
  return { repo, writeAll: false, lsHits, xy };
}

function applyD7Xy(cache, targetPath) {
  const rel = safePosixRel(cache.repo, targetPath);
  if (!rel) {
    logGitProbeWrite(targetPath, "posix-rel");
    return false;
  }
  if (!cache.lsHits.has(rel)) {
    logGitProbeWrite(targetPath, "ls-files-miss");
    return false;
  }
  const xy = cache.xy.get(rel);
  if (xy === undefined || xy === "M ") return true;
  logGitProbeWrite(targetPath, `xy:${xy || "??"}`);
  return false;
}

function pathInsideCachedRepo(cache, targetPath) {
  if (!cache?.repo) return false;
  return safePosixRel(cache.repo, targetPath) !== null;
}

function d7ShouldSkipWrite(targetPath) {
  if (pathInsideCachedRepo(writeFileGitProbeCache, targetPath)) {
    if (writeFileGitProbeCache.writeAll) {
      logGitProbeWrite(targetPath, "writeAll-memo");
      return false;
    }
    return applyD7Xy(writeFileGitProbeCache, targetPath);
  }
  const loaded = loadGitProbeCache(targetPath);
  if (!loaded.repo) return false;
  writeFileGitProbeCache = loaded;
  if (loaded.writeAll) return false;
  return applyD7Xy(loaded, targetPath);
}

/**
 * Write unless raw bytes match, or CRLF/LF-normalized bytes match and D7 skip.
 * Only ENOENT is treated as missing (then write). Other read errors propagate.
 * Git-aware only after raw inequality; name kept (D1).
 */
async function writeFileUnlessSameBytes(targetPath, contents) {
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  try {
    const existing = await fs.readFile(targetPath);
    if (existing.equals(next)) return;
    if (!next.includes(0x0d) && crlfToLf(existing).equals(crlfToLf(next))) {
      if (d7ShouldSkipWrite(targetPath)) return;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(targetPath, next);
}

async function readFileOrEmpty(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return "";
  }
}

/** Source-controlled JSON; decorate failures with path for CI diagnosis (target-side may stay loose-parse). */
async function parseSourceJsonFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    throw new Error(`Failed to read source file ${filePath}: ${e.message}`, { cause: e });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : String(e);
    throw new Error(`Invalid JSON in source file ${filePath}: ${detail}`, { cause: e });
  }
}

/**
 * Consumer-owned basenames that sync/check/uninstall must never own, overwrite,
 * or delete. Parallel survivors: `.devpro/rules.config` (under SYNC_DIRS but
 * preserved by omission — no source counterpart) and root `AGENTS.local.md`
 * (never in STATIC_FILES / A-class; root AGENTS copy/check target stays the
 * literal `"AGENTS.md"` only — never AGENTS.local.md, never AGENTS* glob).
 * `.devpro/pre-pr-checks.local.md` sits under SYNC_DIRS' `.devpro` and is reserved
 * because source has no counterpart (the consumer owns and commits the file).
 * `.devpro/second-review-rules.local.md` is reserved for the same reason.
 */
const RESERVED_CONSUMER_BASENAMES = Object.freeze([
  "rules.config",
  "AGENTS.local.md",
  CONSUMER_PRE_PR_CHECKS_BASENAME,
  CONSUMER_SECOND_REVIEW_RULES_BASENAME,
]);

/**
 * Static files — root-level single files maintained in source repo, synced by byte-copy.
 * Must not include any RESERVED_CONSUMER_BASENAMES entry.
 */
const STATIC_FILES = [
  { name: "claude", relPath: "CLAUDE.md" },
  { name: "gemini", relPath: "GEMINI.md" },
  { name: "windsurf", relPath: ".windsurfrules" },
  { name: "statusline", relPath: ".claude/statusline.cjs" },
];

/**
 * Directories synced by recursive byte-copy (all files, not just .md).
 * Consumer-local extras are preserved (we don't delete).
 * Source walks must not yield RESERVED_CONSUMER_BASENAMES (e.g. rules.config).
 */
const SYNC_DIRS = [
  { relPath: ".agents" },
  { relPath: ".codex" },
  { relPath: ".cursor" },
  { relPath: ".opencode" },
  { relPath: ".devpro" },
  { relPath: ".github" },
];
const LEGACY_SOURCE_WORKFLOW_FILES = [
  ".github/workflows/compliance-telemetry.yml",
  ".github/workflows/hook-tests.yml",
  ".github/workflows/multi-runtime-parity.yml",
  ".github/workflows/refs-size-monitor.yml",
  ".github/workflows/source-governance-tests.yml",
];
const LEGACY_SECOND_REVIEW_ARTIFACTS = [
  ".devpro/agent-skills/devpro-reviews/dp-second-reviewer",
  ".agents/skills/dp-second-reviewer",
  ".claude/skills/dp-second-reviewer",
  ".cursor/skills/dp-second-reviewer",
];
const LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS = [
  ".devpro/agent-skills/rules-authoring/dp-convergence-loop",
  ".devpro/agent-skills/rules-authoring/dp-rule-audit",
  ".agents/skills/dp-convergence-loop",
  ".agents/skills/dp-rule-audit",
  ".claude/skills/dp-convergence-loop",
  ".claude/skills/dp-rule-audit",
  ".cursor/skills/dp-convergence-loop",
  ".cursor/skills/dp-rule-audit",
];
/**
 * Fixed named legacy allowlist (design D2) of the twenty `.cursor/skills/<name>`
 * discovery links previously distributed by --sync before `.cursor/skills`
 * was retired as a managed discovery root (design D1). Deliberately NOT
 * derived from the current managed skill inventory or the manifest — the
 * inventory no longer reads `.cursor/skills` at all once it's retired, and
 * the manifest would drift the allowlist as skills are added/renamed, which
 * is exactly what this fixed "our own past output" list must not do (see
 * pruneLegacySecondReviewArtifacts()/pruneLegacyRuleGovernanceSkillArtifacts()
 * above for the same pattern). Named 1:1 with the twenty symlinks removed by
 * `git rm .cursor/skills/*` in this same commit (design D1, NFR4).
 */
const LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS = [
  ".cursor/skills/cmux-surface-comms",
  ".cursor/skills/dp-change",
  ".cursor/skills/dp-clarify",
  ".cursor/skills/dp-consumer-doctor",
  ".cursor/skills/dp-cross-review",
  ".cursor/skills/dp-init",
  ".cursor/skills/dp-knowledge-distill",
  ".cursor/skills/dp-knowledge-ingest",
  ".cursor/skills/dp-load-plan",
  ".cursor/skills/dp-pre-pr",
  ".cursor/skills/dp-recap-writer",
  ".cursor/skills/dp-release-runbook",
  ".cursor/skills/dp-rule-governance",
  ".cursor/skills/dp-second-review",
  ".cursor/skills/dp-second-review-dogfood",
  ".cursor/skills/dp-security-scan",
  ".cursor/skills/dp-setup-ci",
  ".cursor/skills/dp-sync-rules",
  ".cursor/skills/dp-workflows",
  ".cursor/skills/openspec-artifact-authoring",
];

/**
 * design D7 — a fail-closed exit-30 lane distinct from the pre-existing
 * exit-1 residue checks (cursor/second-review/rule-governance): the 2-entry
 * skill topology migration needs to name specifically WHICH manual-steps
 * lane applies (legacy per-skill link/payload residue vs. a consumer skill
 * that doesn't match the catalog inventory), so `main()` maps this error's
 * own `exitCode` instead of collapsing every failure to exit 1.
 */
class SkillEntryBlockedError extends Error {
  constructor(message, { reason, paths = [], manualSteps = [] } = {}) {
    super(message);
    this.name = "SkillEntryBlockedError";
    this.exitCode = 30;
    this.reason = reason;
    this.paths = paths;
    this.manualSteps = manualSteps;
  }
}

const CODEX_HOOKS_REL_PATH = ".codex/hooks.json";
const CURSOR_HOOKS_REL_PATH = ".cursor/hooks.json";
const HOOK_JSON_CONFIGS = [
  {
    sourceRelPath: CODEX_HOOKS_REL_PATH,
    syncLabel: "Synchronized .codex/hooks.json (hooks)",
    driftLabel: ".codex/hooks.json",
    syncVersionPolicy: "ignore",
    checkVersionPolicy: "ignore",
  },
  {
    sourceRelPath: CURSOR_HOOKS_REL_PATH,
    syncLabel: "Synchronized .cursor/hooks.json (hooks + version)",
    driftLabel: ".cursor/hooks.json",
    syncVersionPolicy: "copy-if-number",
    checkVersionPolicy: "must-match-if-number",
  },
];
const CLAUDE_SYNC_SUBDIRS = ["agents", "skills"];

/**
 * Paths that belong in a rules-sync commit `git add` (managed set).
 * SSOT for README / rules-flow commit guidance — do NOT maintain a second hardcoded
 * path array in docs. Parity invariant: keep — does not alter STATIC_FILES / SYNC_DIRS membership.
 */
function listSyncCommitPaths() {
  const paths = new Set([
    ".gitmodules",
    ".devpro-agent-rules",
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    // syncClaudeConfig writes this wirefile; not covered by CLAUDE_SYNC_SUBDIRS alone
    ".claude/settings.json",
  ]);
  for (const { relPath } of STATIC_FILES) paths.add(relPath);
  for (const { relPath } of SYNC_DIRS) paths.add(relPath);
  for (const subdir of CLAUDE_SYNC_SUBDIRS) paths.add(`.claude/${subdir}`);
  return [...paths].sort((a, b) => a.localeCompare(b));
}

const GITIGNORE_SSOT_REL_PATH = ".devpro/agent-rules/gitignore-alignment.md";
const GITIGNORE_MANAGED_BEGIN = "# devpro-agent-rules managed begin";
const GITIGNORE_MANAGED_END = "# devpro-agent-rules managed end";
const GITIGNORE_BASELINE_BEGIN = "<!-- devpro-gitignore-baseline begin -->";
const GITIGNORE_BASELINE_END = "<!-- devpro-gitignore-baseline end -->";
const GITATTRIBUTES_MANAGED_BEGIN = "# devpro-agent-rules gitattributes managed begin";
const GITATTRIBUTES_MANAGED_END = "# devpro-agent-rules gitattributes managed end";
/** Explicit LF checkout baseline (not derived). Whitespace exceptions derive from source `.gitattributes`. */
const GITATTRIBUTES_MANAGED_ENTRIES = [
  ".devpro/scripts/hooks-git/* text eol=lf",
  ".gitignore text eol=lf",
  ".gitattributes text eol=lf",
  ".claude/settings.json text eol=lf",
  ".codex/hooks.json text eol=lf",
  ".cursor/hooks.json text eol=lf",
  ".opencode/plugins/devpro-hooks.js text eol=lf",
];

/**
 * Build consumer-managed `.gitattributes` entries: LF baseline constant ∪
 * path-scoped `whitespace=` tokens derived from source `.gitattributes` text.
 * Token-level only — strips text/eol/diff/merge/binary/linguist/export-ignore/filter.
 * Skips `[attr]` macros. Path `*` or extension-only `*.ext` with whitespace= → throw (fail closed).
 */
function deriveGitattributesManagedEntries(sourceText) {
  const whitespaceByPath = new Map();
  for (const rawLine of String(sourceText ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[attr]")) continue;

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const pathToken = tokens[0];
    const attrTokens = tokens.slice(1);
    const whitespaceToken = attrTokens.find((token) => token.startsWith("whitespace="));
    if (!whitespaceToken) continue;

    if (pathToken === "*" || /^\*\.[^/]+$/.test(pathToken)) {
      throw new Error(
        `Cannot derive gitattributes managed entries: over-wide whitespace pattern "${pathToken}" is fail-closed`
      );
    }

    whitespaceByPath.set(pathToken, `${pathToken} ${whitespaceToken}`);
  }

  const derivedWhitespace = [...whitespaceByPath.entries()]
    .sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
    .map(([, entry]) => entry);

  return [...GITATTRIBUTES_MANAGED_ENTRIES, ...derivedWhitespace];
}

async function loadGitattributesManagedEntries() {
  const sourcePath = path.join(getCentralRoot(), ".gitattributes");
  const raw = await readFileOrEmpty(sourcePath);
  return deriveGitattributesManagedEntries(raw);
}
const SKILL_MANIFEST_REL_PATH = ".devpro/agent-skills/manifest.json";
const SKILL_TARGET_ROOT = ".devpro/agent-skills";
/**
 * Refs root (design D2): on-demand external reviewer CLI manuals and
 * documentation workflow skills that must NOT be reachable through the
 * `devpro` plugin entry tree (Codex recurses the whole discovery tree and
 * would otherwise prefix them `devpro:`). Same manifest schema as the
 * catalog, but its own `path` values may only point inside this root — see
 * loadSkillManifestTargets()'s `rootRelPath` parameter.
 */
const SKILL_REFS_MANIFEST_REL_PATH = ".devpro/agent-skills-refs/manifest.json";
const SKILL_REFS_ROOT = ".devpro/agent-skills-refs";
/**
 * Host plugin manifest (design D1/D3). Lives inside the catalog root so
 * Claude's skills-dir plugin form and Codex's prefix-by-manifest-presence
 * behavior share one file. It is a managed FILE output (not a skill
 * target): buildManagedSkillInventory() adds it (and its ancestors)
 * directly to `outputs` so gitignore-exception / git-persistence coverage
 * reach it without walkSourceFiles() treating it as a skill subtree.
 */
const SKILL_PLUGIN_MANIFEST_REL_PATH = ".devpro/agent-skills/.claude-plugin/plugin.json";
const SKILL_DISCOVERY_DIRS = [
  path.join(".agents", "skills"),
  path.join(".claude", "skills"),
];
/**
 * design D3 — the sole permitted discovery entry name under each
 * SKILL_DISCOVERY_DIRS member, and the literal (separator-normalized)
 * symlink target it must carry. Both runtimes therefore reach the SAME
 * catalog root via one entry each, rather than one entry per skill.
 */
const SKILL_ENTRY_NAME = "devpro";
const SKILL_ENTRY_LINK_TARGET = "../../.devpro/agent-skills";
/**
 * `.cursor/skills` was retired as a managed discovery root (design D1):
 * Cursor also reads `.agents/skills` and continues to read `.claude/skills`,
 * so a third distributed copy was redundant. This list exists ONLY for
 * `collectDevproSkillSymlinks()` (the `--uninstall` scan, design D3) so a
 * consumer who has not yet run `--sync` against the current source still has
 * its devpro-owned `.cursor/skills/<name>` symlinks listed and removed.
 * `SKILL_DISCOVERY_DIRS` itself (inventory / install) MUST NOT include this
 * dir — see LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS below for the --sync
 * prune / --check residue path, which uses a fixed allowlist instead of
 * readdir.
 */
const LEGACY_SKILL_DISCOVERY_DIRS = [path.join(".cursor", "skills")];
function normalizeRelPath(relPath) {
  return relPath.split(path.sep).join("/");
}

function normalizeSymlinkTargetSeparators(target) {
  if (typeof target !== "string") {
    throw new TypeError(
      `normalizeSymlinkTargetSeparators expects a string symlink target, got ${
        target === null ? "null" : typeof target
      }`
    );
  }
  return target.split("\\").join("/");
}

/**
 * Create a managed relative link without letting Node guess the Windows link
 * kind. Native Windows treats an omitted symlink type as a file link; that
 * makes a relative directory discovery target appear broken even though the
 * target is present. POSIX keeps the historical call shape. The caller must
 * provide the already-validated semantic kind, so this helper does not widen
 * target acceptance or change confinement checks.
 */
async function createPortableManagedSymlink(linkTarget, targetPath, kind) {
  if (process.platform === "win32") {
    await fs.symlink(linkTarget, targetPath, kind === "directory" ? "dir" : "file");
    return;
  }
  await fs.symlink(linkTarget, targetPath);
}

function isMalformedRelativeSymlinkTarget(target) {
  if (typeof target !== "string") return true;
  const normalized = normalizeSymlinkTargetSeparators(target);
  return (
    normalized.length === 0 ||
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    (process.platform === "win32" && /^[A-Za-z]:/.test(normalized)) ||
    normalized.startsWith("/") ||
    /[\0\r\n]/.test(normalized)
  );
}

function buildIgnoredRelPaths(relPath) {
  const ignoredRelPaths = new Set();
  if (relPath === ".codex") {
    ignoredRelPaths.add(path.basename(CODEX_HOOKS_REL_PATH));
  }
  if (relPath === ".cursor") {
    ignoredRelPaths.add(path.basename(CURSOR_HOOKS_REL_PATH));
  }
  if (relPath === ".opencode") {
    // Local OpenCode CLI install residue — never source-owned sync carriers.
    ignoredRelPaths.add("node_modules");
    ignoredRelPaths.add("package-lock.json");
    ignoredRelPaths.add("package.json"); // root install manifest; source-owned is plugins/package.json
    ignoredRelPaths.add(".gitignore");
    ignoredRelPaths.add("bun.lock");
  }
  if (relPath === ".github") {
    ignoredRelPaths.add("workflows");
  }
  if (relPath === ".devpro") {
    ignoredRelPaths.add("scripts/hooks/state");
  }
  return ignoredRelPaths;
}

async function gitignoreBaselineEntries() {
  const source = path.join(getCentralRoot(), GITIGNORE_SSOT_REL_PATH);
  const raw = await readFileOrEmpty(source);
  const start = raw.indexOf(GITIGNORE_BASELINE_BEGIN);
  const end = raw.indexOf(GITIGNORE_BASELINE_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Invalid gitignore SSOT markers in ${GITIGNORE_SSOT_REL_PATH}`);
  }

  const body = raw.slice(start + GITIGNORE_BASELINE_BEGIN.length, end);
  const entries = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```") && !line.startsWith("#"));

  if (entries.length === 0) {
    throw new Error(`No gitignore baseline entries found in ${GITIGNORE_SSOT_REL_PATH}`);
  }
  return entries;
}

function validateManagedRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty repository-relative POSIX path`);
  }
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    /[\0\r\n*?[\]#!<>:"|]/.test(value)
  ) {
    throw new Error(
      `Invalid ${label} '${value}': path is absolute or contains cross-platform-ambiguous characters`
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid ${label} '${value}': empty or traversal segment`);
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) {
    throw new Error(
      `Invalid ${label} '${value}': Windows-ambiguous path segment ends in a dot or space`
    );
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`Invalid ${label} '${value}': path is not normalized`);
  }
  return value;
}

function compareRepoPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runGitSymlinkCommand(repoRoot, args, options) {
  return spawnSync("git", args, { ...options, cwd: repoRoot });
}

function readExactGitSymlinkBlob(
  repoRoot,
  relPath,
  gitSymlinkRunner = runGitSymlinkCommand
) {
  const rootProbe = gitSymlinkRunner(repoRoot, ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (rootProbe.status !== 0) return null;
  const requestedRoot = realpathSync(repoRoot);
  const reportedRoot = realpathSync(rootProbe.stdout.trim());
  if (requestedRoot !== reportedRoot) return null;

  const indexProbe = gitSymlinkRunner(repoRoot, ["ls-files", "--stage", "-z", "--", relPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (indexProbe.error || indexProbe.status !== 0) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: ${indexProbe.error?.message ?? indexProbe.stderr.trim()}`
    );
  }
  if (indexProbe.stdout === "") return null;
  const match = /^(\d{6}) ([0-9a-f]+) 0\t([^\0]+)\0$/.exec(indexProbe.stdout);
  if (!match || match[3] !== relPath) {
    throw new Error(`Git symlink evidence fault for ${relPath}: malformed or duplicate index record`);
  }
  if (match[1] !== "120000") return null;

  const blobProbe = gitSymlinkRunner(repoRoot, ["cat-file", "blob", `:${relPath}`], {
    cwd: repoRoot,
    encoding: null,
  });
  if (blobProbe.error || blobProbe.status !== 0) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: ${blobProbe.error?.message ?? String(blobProbe.stderr)}`
    );
  }
  return blobProbe.stdout;
}

function createMissingGitSymlinkBlob(
  repoRoot,
  relPath,
  linkTargetBytes,
  gitSymlinkRunner = runGitSymlinkCommand
) {
  const rootProbe = gitSymlinkRunner(repoRoot, ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (rootProbe.error || rootProbe.status !== 0) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: ${rootProbe.error?.message ?? rootProbe.stderr?.trim() ?? "consumer root is not a Git worktree"}`
    );
  }

  let requestedRoot;
  let reportedRoot;
  try {
    requestedRoot = realpathSync(repoRoot);
    reportedRoot = realpathSync(rootProbe.stdout.trim());
  } catch (error) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: cannot resolve exact consumer Git root: ${error.message}`
    );
  }
  if (requestedRoot !== reportedRoot) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: Git top-level does not match the exact consumer root`
    );
  }

  const indexProbe = gitSymlinkRunner(repoRoot, ["ls-files", "--stage", "-z", "--", relPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (indexProbe.error || indexProbe.status !== 0) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: ${indexProbe.error?.message ?? indexProbe.stderr.trim()}`
    );
  }
  if (indexProbe.stdout !== "") {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: refusing to replace an existing index record`
    );
  }

  const hashProbe = gitSymlinkRunner(repoRoot, ["hash-object", "-w", "--stdin"], {
    cwd: repoRoot,
    input: linkTargetBytes,
    encoding: "utf8",
  });
  const objectId = hashProbe.stdout?.trim();
  if (
    hashProbe.error ||
    hashProbe.status !== 0 ||
    typeof objectId !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(objectId)
  ) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: ${hashProbe.error?.message ?? hashProbe.stderr?.trim() ?? "invalid hash-object result"}`
    );
  }

  const updateProbe = gitSymlinkRunner(
    repoRoot,
    ["update-index", "--add", "--cacheinfo", `120000,${objectId},${relPath}`],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (updateProbe.error || updateProbe.status !== 0) {
    throw new Error(
      `Git symlink evidence fault for ${relPath}: ${updateProbe.error?.message ?? updateProbe.stderr.trim()}`
    );
  }

  // The entry is staged now; unstage it if verification fails, because the
  // caller only learns about this index record from a successful return.
  let blob;
  try {
    blob = readExactGitSymlinkBlob(repoRoot, relPath, gitSymlinkRunner);
    if (blob == null || !blob.equals(linkTargetBytes)) {
      throw new Error(
        `Git symlink evidence fault for ${relPath}: persisted 120000 entry does not match the managed link target`
      );
    }
  } catch (error) {
    const unstage = gitSymlinkRunner(repoRoot, ["update-index", "--force-remove", "--", relPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (unstage.error || unstage.status !== 0) {
      throw new Error(
        `${error.message}; the staged entry could not be removed ` +
        `(${unstage.error?.message ?? unstage.stderr?.trim() ?? "unknown error"}); ` +
        `run: git update-index --force-remove -- ${relPath}`
      );
    }
    throw error;
  }
  return blob;
}

async function readGitBackedPlainLink(sourceRoot, relPath, sourcePath) {
  const blob = readExactGitSymlinkBlob(sourceRoot, relPath);
  if (blob == null) {
    throw new Error(
      `Invalid skill discovery link ${relPath}: plain file requires exact Git mode 120000 evidence`
    );
  }
  const physical = await fs.readFile(sourcePath);
  if (!physical.equals(blob)) {
    throw new Error(
      `Invalid skill discovery link ${relPath}: plain checkout bytes differ from its Git 120000 blob`
    );
  }
  const linkTarget = blob.toString("utf8");
  if (!Buffer.from(linkTarget, "utf8").equals(blob)) {
    throw new Error(`Invalid skill discovery link ${relPath}: link blob is not valid UTF-8`);
  }
  return linkTarget;
}

/**
 * Load one manifest's skill targets (design D3.1). Shared by the catalog
 * manifest (root SKILL_TARGET_ROOT) and the refs manifest (root
 * SKILL_REFS_ROOT) — each manifest's `path` entries may only point inside
 * its OWN root; a catalog entry pointing into the refs root (or vice versa)
 * is rejected here, not tolerated as "some other root".
 *
 * Mutates the shared `targetPaths` / `targetByRealPath` sets so duplicate
 * detection (by repo-relative path and by resolved realpath) spans both
 * manifests — the two roots must never alias the same directory.
 */
async function loadSkillManifestTargets(
  sourceRoot,
  { manifestRelPath, rootRelPath, targets, targetPaths, targetByRealPath }
) {
  const manifestPath = path.join(sourceRoot, ...manifestRelPath.split("/"));
  const manifest = await parseSourceJsonFile(manifestPath);
  if (!Array.isArray(manifest.groups)) {
    throw new Error(`Invalid ${manifestRelPath}: groups must be an array`);
  }

  for (const [groupIndex, group] of manifest.groups.entries()) {
    if (!group || !Array.isArray(group.skills)) {
      throw new Error(`Invalid ${manifestRelPath} group ${groupIndex}: skills must be an array`);
    }
    for (const [skillIndex, skill] of group.skills.entries()) {
      const label = `${manifestRelPath} groups[${groupIndex}].skills[${skillIndex}].path`;
      const relPath = validateManagedRepoPath(skill?.path, label);
      if (!relPath.startsWith(`${rootRelPath}/`)) {
        throw new Error(`Invalid ${label} '${relPath}': target escapes ${rootRelPath}/`);
      }
      if (targetPaths.has(relPath)) {
        throw new Error(`Invalid ${label} '${relPath}': duplicate managed skill target`);
      }

      const sourcePath = path.join(sourceRoot, ...relPath.split("/"));
      const stats = await fs.lstat(sourcePath).catch(() => null);
      if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        const observed = stats ? "wrong node type (expected directory)" : "missing";
        throw new Error(`Invalid managed skill target ${relPath}: ${observed}`);
      }
      const realPath = await fs.realpath(sourcePath);
      if (targetByRealPath.has(realPath)) {
        throw new Error(`Invalid managed skill target ${relPath}: duplicate resolved target`);
      }

      const outputs = [{ relPath, type: "directory" }];
      await walkSourceFiles(
        sourcePath,
        new Set(),
        async (entryPath) => {
          outputs.push({
            relPath: normalizeRelPath(path.relative(sourceRoot, entryPath)),
            type: "file",
          });
        },
        async (entryPath) => {
          outputs.push({
            relPath: normalizeRelPath(path.relative(sourceRoot, entryPath)),
            type: "directory",
          });
        },
        async (entryPath) => {
          outputs.push({
            relPath: normalizeRelPath(path.relative(sourceRoot, entryPath)),
            type: "symlink",
            linkTarget: await fs.readlink(entryPath),
          });
        }
      );
      const target = { relPath, sourcePath, realPath, outputs };
      targets.push(target);
      targetPaths.add(relPath);
      targetByRealPath.set(realPath, target);
    }
  }
}

async function buildManagedSkillInventory(sourceRoot) {
  const targets = [];
  const targetPaths = new Set();
  const targetByRealPath = new Map();
  await loadSkillManifestTargets(sourceRoot, {
    manifestRelPath: SKILL_MANIFEST_REL_PATH,
    rootRelPath: SKILL_TARGET_ROOT,
    targets,
    targetPaths,
    targetByRealPath,
  });
  await loadSkillManifestTargets(sourceRoot, {
    manifestRelPath: SKILL_REFS_MANIFEST_REL_PATH,
    rootRelPath: SKILL_REFS_ROOT,
    targets,
    targetPaths,
    targetByRealPath,
  });

  // Plugin manifest (design D3.2): a managed FILE output, not a skill
  // target — never walked, never a discovery-link resolution candidate.
  const pluginManifestSourcePath = path.join(sourceRoot, ...SKILL_PLUGIN_MANIFEST_REL_PATH.split("/"));
  const pluginManifestStats = await fs.lstat(pluginManifestSourcePath).catch(() => null);
  if (!pluginManifestStats?.isFile() || pluginManifestStats.isSymbolicLink()) {
    const observed = pluginManifestStats ? "wrong node type (expected file)" : "missing";
    throw new Error(`Invalid managed skill plugin manifest ${SKILL_PLUGIN_MANIFEST_REL_PATH}: ${observed}`);
  }
  const pluginManifest = { relPath: SKILL_PLUGIN_MANIFEST_REL_PATH, type: "file" };

  const catalogRootRealPath = await fs.realpath(path.join(sourceRoot, ...SKILL_TARGET_ROOT.split("/")));

  const discovery = [];
  const discoveryPaths = new Set();
  for (const discoveryDir of SKILL_DISCOVERY_DIRS) {
    const sourceDir = path.join(sourceRoot, discoveryDir);
    const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch((error) => {
      throw new Error(`Invalid skill discovery directory ${normalizeRelPath(discoveryDir)}: ${error.message}`);
    });
    for (const entry of entries) {
      if (entry.name !== SKILL_ENTRY_NAME) {
        throw new Error(
          `Invalid skill discovery entry ${normalizeRelPath(path.join(discoveryDir, entry.name))}: ` +
          `only '${normalizeRelPath(discoveryDir)}/${SKILL_ENTRY_NAME}' is allowed`
        );
      }
    }

    const relPath = validateManagedRepoPath(
      normalizeRelPath(path.join(discoveryDir, SKILL_ENTRY_NAME)),
      "skill discovery path"
    );
    const sourcePath = path.join(sourceDir, SKILL_ENTRY_NAME);
    const stats = await fs.lstat(sourcePath).catch(() => null);
    const linkTarget = stats?.isSymbolicLink()
      ? await fs.readlink(sourcePath).catch(() => null)
      : stats?.isFile()
        ? await readGitBackedPlainLink(sourceRoot, relPath, sourcePath)
        : null;
    if (linkTarget == null) {
      throw new Error(`Invalid skill discovery entry ${relPath}: missing or not a symlink/Git-backed plain link`);
    }
    if (typeof linkTarget !== "string") {
      throw new Error(`Invalid skill discovery link ${relPath}: malformed relative target`);
    }
    const normalized = normalizeSymlinkTargetSeparators(linkTarget);
    if (isMalformedRelativeSymlinkTarget(normalized) || normalized !== SKILL_ENTRY_LINK_TARGET) {
      throw new Error(
        `Invalid skill discovery link ${relPath}: target '${normalized}' must equal '${SKILL_ENTRY_LINK_TARGET}'`
      );
    }
    const resolvedTarget = await fs.realpath(path.resolve(sourceDir, normalized)).catch(() => null);
    if (resolvedTarget == null || resolvedTarget !== catalogRootRealPath) {
      throw new Error(
        `Invalid skill discovery link ${relPath}: target '${normalized}' must resolve to ${SKILL_TARGET_ROOT}`
      );
    }
    if (discoveryPaths.has(relPath)) {
      throw new Error(`Invalid skill discovery link ${relPath}: duplicate discovery output`);
    }
    discoveryPaths.add(relPath);
    discovery.push({ relPath, type: "symlink", linkTarget: normalized, targetRelPath: SKILL_TARGET_ROOT });
  }

  targets.sort((left, right) => compareRepoPaths(left.relPath, right.relPath));
  discovery.sort((left, right) => compareRepoPaths(left.relPath, right.relPath));
  const outputs = [
    ...targets.flatMap((target) => target.outputs),
    ...discovery,
    pluginManifest,
  ].sort((left, right) => compareRepoPaths(left.relPath, right.relPath));
  const outputPaths = new Set();
  for (const output of outputs) {
    if (outputPaths.has(output.relPath)) {
      throw new Error(`Invalid managed skill inventory: duplicate output path ${output.relPath}`);
    }
    outputPaths.add(output.relPath);
  }
  return { targets, discovery, pluginManifest, outputs };
}

function managedPathAncestorExceptions(relPath) {
  const segments = relPath.split("/");
  const patterns = [];
  for (let depth = 1; depth < segments.length; depth++) {
    patterns.push(`!/${segments.slice(0, depth).join("/")}/`);
  }
  return patterns;
}

function gitignoreExceptionDepth(pattern) {
  return pattern
    .replace(/^!\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/$/, "")
    .split("/").length;
}

function managedSkillGitignoreExceptions(inventory) {
  const patterns = new Set();
  for (const target of inventory.targets) {
    for (const pattern of managedPathAncestorExceptions(target.relPath)) patterns.add(pattern);
    patterns.add(`!/${target.relPath}/`);
    patterns.add(`!/${target.relPath}/**`);
  }
  for (const link of inventory.discovery) {
    for (const pattern of managedPathAncestorExceptions(link.relPath)) patterns.add(pattern);
    patterns.add(`!/${link.relPath}`);
  }
  if (inventory.pluginManifest) {
    for (const pattern of managedPathAncestorExceptions(inventory.pluginManifest.relPath)) patterns.add(pattern);
    patterns.add(`!/${inventory.pluginManifest.relPath}`);
  }
  return [...patterns].sort((left, right) => {
    const depthDifference = gitignoreExceptionDepth(left) - gitignoreExceptionDepth(right);
    return depthDifference || compareRepoPaths(left, right);
  });
}

function canonicalGitignoreManagedBlock(entries) {
  return [GITIGNORE_MANAGED_BEGIN, ...entries, GITIGNORE_MANAGED_END];
}

function contentLines(content) {
  return contentLineRecords(content).map(({ body }) => body);
}

function contentLineRecords(content) {
  const records = [];
  let start = 0;

  for (let cursor = 0; cursor < content.length; cursor++) {
    const char = content[cursor];
    if (char !== "\r" && char !== "\n") continue;

    const end = char === "\r" && content[cursor + 1] === "\n" ? cursor + 2 : cursor + 1;
    records.push({
      body: content.slice(start, cursor),
      raw: content.slice(start, end),
    });
    cursor = end - 1;
    start = end;
  }

  if (start < content.length) {
    records.push({ body: content.slice(start), raw: content.slice(start) });
  }
  return records;
}

function trimTrailingBlankLines(lines) {
  while (lines.length > 0 && lines.at(-1).trim() === "") {
    lines.pop();
  }
  return lines;
}

function mergeGitignoreManagedBlock(content, baselineEntries, managedEntries) {
  const baseline = new Set(baselineEntries);
  const canonical = `${canonicalGitignoreManagedBlock(managedEntries).join("\n")}\n`;
  const output = [];
  let inManagedBlock = false;

  for (const record of contentLineRecords(content)) {
    const trimmed = record.body.trim();
    if (trimmed === GITIGNORE_MANAGED_BEGIN) {
      if (inManagedBlock) {
        throw new Error("Cannot synchronize .gitignore: nested managed block markers");
      }
      inManagedBlock = true;
      continue;
    }
    if (trimmed === GITIGNORE_MANAGED_END) {
      if (!inManagedBlock) {
        throw new Error("Cannot synchronize .gitignore: managed end marker has no begin marker");
      }
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) continue;
    if (baseline.has(trimmed)) {
      continue;
    }
    output.push(record.raw);
  }

  if (inManagedBlock) {
    throw new Error("Cannot synchronize .gitignore: managed block is missing end marker");
  }
  const consumerOwned = output.join("");
  const separator = consumerOwned !== "" && !/[\r\n]$/.test(consumerOwned) ? "\n" : "";
  return `${consumerOwned}${separator}${canonical}`;
}

function validateGitignoreManagedBlock(content, baselineEntries, managedEntries) {
  const baseline = new Set(baselineEntries);
  const expected = canonicalGitignoreManagedBlock(managedEntries).join("\n");
  const outside = [];
  const blocks = [];
  let currentBlock = null;
  let completedBlock = false;
  let hasPostBlockContent = false;

  for (const record of contentLineRecords(content)) {
    const line = record.body;
    const trimmed = line.trim();
    if (trimmed === GITIGNORE_MANAGED_BEGIN) {
      if (currentBlock) {
        return "has nested managed block markers";
      }
      currentBlock = [record];
      continue;
    }
    if (currentBlock) {
      currentBlock.push(record);
      if (trimmed === GITIGNORE_MANAGED_END) {
        blocks.push(currentBlock);
        currentBlock = null;
        completedBlock = true;
      }
      continue;
    }
    if (trimmed === GITIGNORE_MANAGED_END) {
      return "managed end marker has no begin marker";
    }
    if (completedBlock && trimmed !== "") hasPostBlockContent = true;
    outside.push(line);
  }

  if (currentBlock) {
    return "managed block is missing end marker";
  }
  if (blocks.length === 0) {
    return "is missing devpro-agent-rules managed block";
  }
  if (blocks.length > 1) {
    return "has multiple devpro-agent-rules managed blocks";
  }

  const actual = blocks[0].map(({ raw }) => raw).join("");
  if (actual !== `${expected}\n`) {
    return "managed block differs from .devpro/agent-rules/gitignore-alignment.md";
  }

  const duplicates = outside
    .map((line) => line.trim())
    .filter((line) => baseline.has(line));
  if (duplicates.length > 0) {
    return `has duplicate managed entries outside the block: ${[...new Set(duplicates)].join(", ")}`;
  }
  if (hasPostBlockContent) {
    return "managed block is not terminal";
  }

  return "";
}

function canonicalGitattributesManagedBlock(managedEntries = GITATTRIBUTES_MANAGED_ENTRIES) {
  return [
    GITATTRIBUTES_MANAGED_BEGIN,
    ...managedEntries,
    GITATTRIBUTES_MANAGED_END,
  ];
}

function mergeGitattributesManagedBlock(content, managedEntries = GITATTRIBUTES_MANAGED_ENTRIES) {
  const managed = new Set(managedEntries);
  const canonical = `${canonicalGitattributesManagedBlock(managedEntries).join("\n")}\n`;
  const output = [];
  let inManagedBlock = false;

  for (const record of contentLineRecords(content)) {
    const trimmed = record.body.trim();
    if (trimmed === GITATTRIBUTES_MANAGED_BEGIN) {
      if (inManagedBlock) {
        throw new Error("Cannot synchronize .gitattributes: nested managed block markers");
      }
      inManagedBlock = true;
      continue;
    }
    if (trimmed === GITATTRIBUTES_MANAGED_END) {
      if (!inManagedBlock) {
        throw new Error("Cannot synchronize .gitattributes: managed end marker has no begin marker");
      }
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) continue;
    if (managed.has(trimmed)) {
      continue;
    }
    output.push(record.raw);
  }

  if (inManagedBlock) {
    throw new Error("Cannot synchronize .gitattributes: managed block is missing end marker");
  }
  const consumerOwned = output.join("");
  const separator = consumerOwned !== "" && !/[\r\n]$/.test(consumerOwned) ? "\n" : "";
  return `${consumerOwned}${separator}${canonical}`;
}

function validateGitattributesManagedBlock(content, managedEntries = GITATTRIBUTES_MANAGED_ENTRIES) {
  const managed = new Set(managedEntries);
  const expected = canonicalGitattributesManagedBlock(managedEntries).join("\n");
  const outside = [];
  const blocks = [];
  let currentBlock = null;
  let completedBlock = false;
  let hasPostBlockContent = false;

  for (const record of contentLineRecords(content)) {
    const line = record.body;
    const trimmed = line.trim();
    if (trimmed === GITATTRIBUTES_MANAGED_BEGIN) {
      if (currentBlock) {
        return "has nested managed block markers";
      }
      currentBlock = [record];
      continue;
    }
    if (currentBlock) {
      currentBlock.push(record);
      if (trimmed === GITATTRIBUTES_MANAGED_END) {
        blocks.push(currentBlock);
        currentBlock = null;
        completedBlock = true;
      }
      continue;
    }
    if (trimmed === GITATTRIBUTES_MANAGED_END) {
      return "managed end marker has no begin marker";
    }
    if (completedBlock && trimmed !== "") hasPostBlockContent = true;
    outside.push(line);
  }

  if (currentBlock) {
    return "managed block is missing end marker";
  }
  if (blocks.length === 0) {
    return "is missing devpro-agent-rules gitattributes managed block";
  }
  if (blocks.length > 1) {
    return "has multiple devpro-agent-rules gitattributes managed blocks";
  }

  const actual = blocks[0].map(({ raw }) => raw).join("");
  if (actual !== `${expected}\n`) {
    return "managed block differs from canonical devpro-agent-rules gitattributes block";
  }

  const duplicates = outside
    .map((line) => line.trim())
    .filter((line) => managed.has(line));
  if (duplicates.length > 0) {
    return `has duplicate managed entries outside the block: ${[...new Set(duplicates)].join(", ")}`;
  }
  if (hasPostBlockContent) {
    return "managed block is not terminal";
  }

  return "";
}

const MANAGED_BLOCK_DRIFT_AUTO_FIXABLE = [
  "is missing devpro-agent-rules gitattributes managed block",
  "is missing devpro-agent-rules managed block",
  "has multiple devpro-agent-rules gitattributes managed blocks",
  "has multiple devpro-agent-rules managed blocks",
  "managed block differs from canonical devpro-agent-rules gitattributes block",
  "managed block differs from .devpro/agent-rules/gitignore-alignment.md",
  "has duplicate managed entries outside the block:",
  "managed block is not terminal",
];

const MANAGED_BLOCK_DRIFT_MANUAL_STEPS = [
  {
    match: "nested managed block markers",
    step: "Manually delete the extra inner managed-block begin marker so begin/end markers pair up, then rerun --check before running --sync.",
  },
  {
    match: "managed end marker has no begin marker",
    step: "Manually delete the orphan managed-block end marker that appears before any begin marker.",
  },
  {
    match: "managed block is missing end marker",
    step: "Manually add the missing managed-block end marker at the end of the managed section.",
  },
];

// Allowlist direction (fail closed): only drift strings that fully match a known
// auto-fixable substring route to --sync. Everything else — including drift shapes
// not yet known to this list — falls to a manual instruction, so a newly introduced
// malformed shape defaults to "don't run --sync" rather than silently being told to.
function managedBlockRemediation(drift) {
  if (MANAGED_BLOCK_DRIFT_AUTO_FIXABLE.some((known) => drift.includes(known))) {
    return "Run sync-agent-rules.mjs --sync.";
  }
  const manual = MANAGED_BLOCK_DRIFT_MANUAL_STEPS.find(({ match }) => drift.includes(match));
  if (manual) {
    return manual.step;
  }
  return "Manually inspect and resolve this drift; do not run --sync — its effect on this shape is unverified.";
}

function parseGitCheckIgnoreRecords({ stdout, status, expectedPaths }) {
  if (status !== 0 && status !== 1) {
    throw new Error(`Git persistence validator fault: git check-ignore exited ${status}`);
  }
  if (typeof stdout !== "string") {
    throw new Error("Git persistence validator fault: check-ignore output is not text");
  }
  if (stdout.length === 0) {
    if (status === 0) {
      throw new Error(
        "Git persistence validator fault: git check-ignore exited 0 but returned no records"
      );
    }
    return [];
  }
  if (status === 1) {
    throw new Error(
      "Git persistence validator fault: git check-ignore exited 1 but returned records"
    );
  }
  if (!stdout.endsWith("\0")) {
    throw new Error("Git persistence validator fault: malformed unterminated NUL record");
  }

  const fields = stdout.slice(0, -1).split("\0");
  if (fields.length % 4 !== 0) {
    throw new Error(
      `Git persistence validator fault: malformed record has ${fields.length} fields, expected groups of 4`
    );
  }
  const expected = new Set(expectedPaths);
  const seen = new Set();
  const records = [];
  for (let index = 0; index < fields.length; index += 4) {
    const [source, line, pattern, pathname] = fields.slice(index, index + 4);
    if (!source || !/^\d+$/.test(line) || !pattern || !pathname) {
      throw new Error(
        `Git persistence validator fault: malformed source/line/pattern/pathname record at index ${index / 4}`
      );
    }
    if (pathname.includes("\\") || !expected.has(pathname)) {
      throw new Error(`Git persistence validator fault: unknown pathname '${pathname}'`);
    }
    if (seen.has(pathname)) {
      throw new Error(
        `Git persistence validator fault: contradictory duplicate records for '${pathname}'`
      );
    }
    seen.add(pathname);
    records.push({
      source,
      line,
      pattern,
      pathname,
      isNegation: pattern.startsWith("!") && !pattern.startsWith("\\!"),
    });
  }
  return records;
}

function managedOutputObservedState(stats) {
  if (!stats) return "missing";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other node type";
}

function managedDiscoveryIgnoredRelPaths(rootRelPath, inventory) {
  const normalizedRoot = normalizeRelPath(rootRelPath).replace(/\/$/, "");
  const prefix = `${normalizedRoot}/`;
  return new Set(
    inventory.discovery
      .filter((output) => output.relPath.startsWith(prefix))
      .map((output) => output.relPath.slice(prefix.length))
  );
}

function gitBackedPlainLinkMatches(consumerRoot, output, physicalBytes) {
  const blob = readExactGitSymlinkBlob(consumerRoot, output.relPath);
  return (
    blob != null &&
    blob.equals(Buffer.from(output.linkTarget, "utf8")) &&
    physicalBytes.equals(blob)
  );
}

const MANAGED_SKILL_DISCOVERY_DEGRADED_TOKEN = "managed-skill-discovery-degraded";

const CORE_SYMLINKS_FALSE_ALIASES = new Set(["false", "no", "0", "off"]);
const CORE_SYMLINKS_TRUE_ALIASES = new Set(["true", "yes", "1", "on"]);

function runCoreSymlinksProbe(consumerRoot, args, options) {
  return spawnSync("git", args, { ...options, cwd: consumerRoot });
}

/**
 * Probe `git config --get core.symlinks` at consumerRoot.
 * Returns one of: "false" | "true" | "unset" | "malformed".
 * Prefer-plain applies for "false" and "malformed" (conservative).
 */
function probeCoreSymlinksState(consumerRoot, { runner = runCoreSymlinksProbe } = {}) {
  let result;
  try {
    result = runner(consumerRoot, ["config", "--get", "core.symlinks"], {
      cwd: consumerRoot,
      encoding: "utf8",
    });
  } catch {
    return "malformed";
  }
  if (result == null || result.error) return "malformed";
  const status = result.status;
  if (status === 1) return "unset";
  if (status !== 0) return "malformed";
  const token = String(result.stdout ?? "").trim().toLowerCase();
  if (CORE_SYMLINKS_FALSE_ALIASES.has(token)) return "false";
  if (CORE_SYMLINKS_TRUE_ALIASES.has(token)) return "true";
  return "malformed";
}

function isPreferPlainCoreSymlinksState(state) {
  return state === "false" || state === "malformed";
}

const MANAGED_SKILL_SYMLINK_FALLBACK_ERROR_CODES = new Set(["EPERM", "EACCES", "ENOSYS"]);

function isManagedSkillSymlinkFallbackError(error) {
  return MANAGED_SKILL_SYMLINK_FALLBACK_ERROR_CODES.has(error?.code);
}

function warnManagedSkillDiscoveryDegraded(degradedCount, { preferPlainActive = false, failedCreations = [] } = {}) {
  if (!(degradedCount > 0)) return;
  const preferPlainNote = preferPlainActive
    ? "When git config core.symlinks=false (or unsettable), matching plain links are kept intentionally (prefer-plain); --sync will not upgrade them to OS symlinks. "
    : "";
  const remediation = preferPlainActive
    ? "If true OS symlinks are desired, enable OS symlink creation (Windows: Developer Mode) and set git config core.symlinks true, then re-run node .devpro/scripts/sync-agent-rules.mjs --sync. "
    : "Prefer OS symlink creation (Windows: Developer Mode) and/or git config core.symlinks true, then re-run node .devpro/scripts/sync-agent-rules.mjs --sync. ";
  const failureNote = failedCreations.map(({ relPath, code }) =>
    `Symlink creation failed for ${relPath} (${code}). ` +
    (code === "ENOSYS"
      ? "Check symlink support on this entry's filesystem/share; "
      : "Check this entry's directory permissions and symbolic link privilege; ")
  ).join("");
  console.warn(
    `WARN: ${MANAGED_SKILL_DISCOVERY_DEGRADED_TOKEN}: ${degradedCount} git-backed plain link(s); ` +
      failureNote +
      "runtime skill discovery may fail. " +
      preferPlainNote +
      remediation +
      "True symlinks must not fail solely because readlink returns '\\' vs '/'; " +
      "separator-normalized target checks apply after this fix."
  );
}

async function restoreManagedSkillPlainBlob(targetPath, expectedBlob, primaryError) {
  try {
    await fs.writeFile(targetPath, expectedBlob);
  } catch (restoreError) {
    const aggregate = new Error(
      `Failed to restore managed skill plain link at ${targetPath} after symlink error ` +
        `(${primaryError?.code ?? primaryError}): ${restoreError.message}`
    );
    aggregate.cause = { primaryError, restoreError };
    throw aggregate;
  }
}

/**
 * design D8 item 1 (precheck) — classify what is currently at a discovery
 * output's path, WITHOUT mutating anything, so syncManagedSkillDiscovery()
 * can precheck every entry before creating any of them. Returns one of:
 *   "missing"         — nothing here yet; safe to create.
 *   "correct-symlink"  — already a symlink whose literal target equals
 *                        output.linkTarget; idempotent-skip (no rm+recreate).
 *   "correct-plain"    — a Git-120000-backed plain-file fallback whose
 *                        bytes already equal the expected link blob.
 *   "conflict"         — anything else (unmanaged node, wrong-target link,
 *                        non-matching plain file, directory, etc.).
 */
async function classifyDiscoveryEntryState(consumerRoot, output) {
  const targetPath = path.join(consumerRoot, ...output.relPath.split("/"));
  const stats = await fs.lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stats == null) return { state: "missing", targetPath };

  if (stats.isSymbolicLink()) {
    const literal = await fs.readlink(targetPath).catch(() => null);
    const normalized = literal == null ? null : normalizeSymlinkTargetSeparators(literal);
    if (normalized === output.linkTarget) return { state: "correct-symlink", targetPath };
    return {
      state: "conflict",
      targetPath,
      observed: `symlink -> ${literal ?? "?"}`,
    };
  }
  if (stats.isFile()) {
    const physicalBytes = await fs.readFile(targetPath);
    if (gitBackedPlainLinkMatches(consumerRoot, output, physicalBytes)) {
      return { state: "correct-plain", targetPath, physicalBytes };
    }
    return {
      state: "conflict",
      targetPath,
      observed: "plain file (not the expected Git 120000 link blob)",
    };
  }
  return { state: "conflict", targetPath, observed: managedOutputObservedState(stats) };
}

/**
 * design D8 item 4 — best-effort rollback of every discovery entry this
 * run's syncManagedSkillDiscovery() actually created (context.
 * createdSkillEntries), invoked whenever a later step in the same
 * transaction fails. Re-verifies each entry (node type, then link target or
 * blob bytes) still matches what this run created before unlinking it (never
 * rm's a pre-existing, already-correct entry — those are never tracked here
 * in the first place, see
 * the idempotent-skip branch above), reverts any `git update-index --add`
 * this run performed, and returns a list of human-readable manual-step
 * strings for anything it could not clean up (it never throws itself —
 * the caller decides how to surface rollback failures).
 */
async function rollbackCreatedSkillEntries(consumerRoot, context) {
  const entries = context.createdSkillEntries ?? [];
  const failures = [];
  for (const entry of [...entries].reverse()) {
    const targetPath = path.join(consumerRoot, ...entry.relPath.split("/"));
    const revertIndexEntry = () => {
      if (!entry.addedIndexEntry) return;
      const result = spawnSync("git", ["update-index", "--force-remove", "--", entry.relPath], {
        cwd: consumerRoot,
        encoding: "utf8",
      });
      if (result.error || result.status !== 0) {
        failures.push(
          `${entry.relPath}: failed to revert its Git index entry ` +
          `(${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}); ` +
          `run: git update-index --force-remove -- ${entry.relPath}`
        );
      }
    };
    // The index entry was absent before this run added it, so it is ours to
    // revert on every path below: file gone, file kept for manual
    // inspection, file removed, or a filesystem error along the way.
    try {
      // Only a missing node counts as already gone; any other lstat error
      // is reported below as a manual step.
      const stats = await fs.lstat(targetPath).catch((error) => {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
        throw error;
      });
      if (stats == null) continue;
      if (entry.kind === "symlink" && !stats.isSymbolicLink()) {
        failures.push(`${entry.relPath}: no longer a symlink at rollback time; left in place for manual inspection`);
        continue;
      }
      if (entry.kind === "symlink" && normalizeSymlinkTargetSeparators(await fs.readlink(targetPath)) !== normalizeSymlinkTargetSeparators(entry.linkTarget)) {
        failures.push(`${entry.relPath}: link target changed since this run created it; left in place for manual inspection`);
        continue;
      }
      if (entry.kind === "plain-blob" && (!stats.isFile() || stats.isSymbolicLink())) {
        failures.push(`${entry.relPath}: no longer a plain file at rollback time; left in place for manual inspection`);
        continue;
      }
      if (entry.kind === "plain-blob") {
        // A failed write can leave an empty or truncated file; any prefix of
        // our bytes is still this run's own write.
        const onDisk = await fs.readFile(targetPath);
        if (onDisk.length > entry.bytes.length || !entry.bytes.subarray(0, onDisk.length).equals(onDisk)) {
          failures.push(`${entry.relPath}: content changed since this run created it; left in place for manual inspection`);
          continue;
        }
      }
      await fs.unlink(targetPath);
    } catch (error) {
      failures.push(`${entry.relPath}: rollback failed (${error.message}); remove it manually`);
    } finally {
      revertIndexEntry();
    }
  }
  context.createdSkillEntries = [];
  return failures;
}

async function syncManagedSkillDiscovery(consumerRoot, context) {
  const { managedSkillInventory } = context;
  context.createdSkillEntries = context.createdSkillEntries ?? [];
  const synchronizedByDirectory = new Map();
  let degradedCount = 0;
  const failedCreations = [];
  const coreSymlinksState = probeCoreSymlinksState(consumerRoot);
  const preferPlainActive = isPreferPlainCoreSymlinksState(coreSymlinksState);

  const bump = (relPath) => {
    const directory = path.posix.dirname(relPath);
    synchronizedByDirectory.set(directory, (synchronizedByDirectory.get(directory) ?? 0) + 1);
  };

  // design D8 item 1 — precheck EVERY entry before creating ANY of them.
  const states = [];
  for (const output of managedSkillInventory.discovery) {
    states.push({ output, ...(await classifyDiscoveryEntryState(consumerRoot, output)) });
  }
  const conflicts = states.filter((entry) => entry.state === "conflict");
  if (conflicts.length > 0) {
    throw new SkillEntryBlockedError(
      "Refusing to install skill discovery entries: " +
        conflicts.map((entry) => `${entry.output.relPath} (${entry.observed})`).join("; ") +
        " — this path already holds a non-managed node. If it is your own, rename it; " +
        "if it is a stale devpro artifact, remove it manually; then re-run --sync.",
      {
        reason: "legacy-skill-entry-residue",
        paths: conflicts.map((entry) => entry.output.relPath),
        manualSteps: conflicts.map(
          (entry) => `Inspect and resolve ${entry.output.relPath} (${entry.observed}), then re-run --sync.`
        ),
      }
    );
  }

  // design D8 item 2 — idempotent-skip already-correct entries; only
  // "missing" entries are created and tracked for rollback.
  //
  // The whole install pass runs inside ONE try/catch: design D8 item 4's
  // representative EPERM must roll back this run's createdSkillEntries no
  // matter which internal step actually throws. EPERM is itself a fallback
  // code (isManagedSkillSymlinkFallbackError), so on a Git consumer root it
  // is caught locally below and degrades to a plain-file link — but on a
  // non-Git (or otherwise Git-fault) consumer root the fallback path's own
  // createMissingGitSymlinkBlob()/readExactGitSymlinkBlob() plumbing throws
  // its own "Git symlink evidence fault", which is a SEPARATE failure mode
  // from "the symlink call itself failed" and has no local catch of its
  // own. A single outer catch is the only way to cover that path, the
  // correct-plain upgrade path's own non-fallback failure, and the
  // already-covered "missing" non-fallback failure with one rollback call.
  try {
    for (const entry of states) {
      const { output, state, targetPath } = entry;
      if (state === "correct-symlink") continue;

      if (state === "correct-plain") {
        if (preferPlainActive) {
          degradedCount += 1;
          bump(output.relPath);
          continue;
        }
        // Upgrade a matching plain-file fallback to a real symlink now that
        // core.symlinks is no longer false/malformed. This entry already
        // existed correctly before this run, so it is intentionally NOT
        // pushed onto context.createdSkillEntries: rollback (design D8) only
        // undoes entries this run newly created, and a failed upgrade is
        // already restored to the plain blob by restoreManagedSkillPlainBlob.
        const expectedBlob = entry.physicalBytes;
        await fs.rm(targetPath, { force: true });
        try {
          await createPortableManagedSymlink(output.linkTarget, targetPath, "directory");
        } catch (error) {
          if (isManagedSkillSymlinkFallbackError(error)) {
            failedCreations.push({ relPath: output.relPath, code: error.code });
            await fs.writeFile(targetPath, expectedBlob);
            degradedCount += 1;
          } else {
            await restoreManagedSkillPlainBlob(targetPath, expectedBlob, error);
            throw new Error(`Failed to upgrade skill discovery entry ${output.relPath}: ${error.message}`);
          }
        }
        bump(output.relPath);
        continue;
      }

      // state === "missing"
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await createPortableManagedSymlink(output.linkTarget, targetPath, "directory");
        context.createdSkillEntries.push({ relPath: output.relPath, kind: "symlink", linkTarget: output.linkTarget });
      } catch (error) {
        if (!isManagedSkillSymlinkFallbackError(error)) {
          throw new Error(`Failed to install skill discovery entry ${output.relPath}: ${error.message}`);
        }
        failedCreations.push({ relPath: output.relPath, code: error.code });
        const expectedBytes = Buffer.from(output.linkTarget, "utf8");
        const existingBlob = readExactGitSymlinkBlob(consumerRoot, output.relPath);
        const addedIndexEntry = existingBlob == null;
        const blob = existingBlob ?? createMissingGitSymlinkBlob(consumerRoot, output.relPath, expectedBytes);
        if (blob == null || !blob.equals(expectedBytes)) {
          throw new Error(
            `Cannot materialize ${output.relPath} as a symlink on this host, and no matching Git 120000 entry exists`
          );
        }
        // Record before writing: the index entry may already be staged, and
        // rollback must unwind it even if the write below fails.
        context.createdSkillEntries.push({ relPath: output.relPath, kind: "plain-blob", bytes: blob, addedIndexEntry });
        await fs.writeFile(targetPath, blob);
        degradedCount += 1;
      }
      bump(output.relPath);
    }
  } catch (error) {
    const failures = await rollbackCreatedSkillEntries(consumerRoot, context);
    throw new SkillEntryBlockedError(error.message, {
      reason: "legacy-skill-entry-residue",
      paths: [],
      manualSteps: [`Resolve the underlying error (${error.message}), then re-run --sync.`, ...failures],
    });
  }

  for (const [directory, count] of [...synchronizedByDirectory].sort(([left], [right]) =>
    compareRepoPaths(left, right)
  )) {
    console.log(`Synchronized ${directory}/ (${count} managed links)`);
  }
  warnManagedSkillDiscoveryDegraded(degradedCount, { preferPlainActive, failedCreations });
}

/**
 * design D8 item 4 (SYNC_STEPS step 4, `[新] verifySkillEntryInstalled`) —
 * an independent, narrower re-check than validateManagedSkillFilesystem()
 * (which covers ALL managed outputs at SYNC_STEPS step 14): this step
 * verifies ONLY what the entry-install transaction is responsible for
 * (each discovery entry's literal target, its realpath resolving to the
 * consumer's own catalog root, and the plugin manifest's existence), and on
 * failure rolls back this run's created entries before throwing exit 30 —
 * validateManagedSkillFilesystem() has no rollback behavior, so reusing it
 * here would leave a half-installed transaction in place.
 */
async function verifySkillEntryInstalled(consumerRoot, context) {
  const { managedSkillInventory } = context;
  const catalogRootAbs = path.join(consumerRoot, ...SKILL_TARGET_ROOT.split("/"));
  const catalogRealPath = await fs.realpath(catalogRootAbs).catch(() => null);
  const problems = [];
  if (catalogRealPath == null) {
    problems.push(`${SKILL_TARGET_ROOT}: catalog root missing after sync`);
  }
  for (const output of managedSkillInventory.discovery) {
    const targetPath = path.join(consumerRoot, ...output.relPath.split("/"));
    const stats = await fs.lstat(targetPath).catch(() => null);
    if (stats == null) {
      problems.push(`${output.relPath}: missing after install`);
      continue;
    }
    let literal = null;
    if (stats.isSymbolicLink()) {
      literal = await fs.readlink(targetPath).catch(() => null);
    } else if (stats.isFile()) {
      const blob = readExactGitSymlinkBlob(consumerRoot, output.relPath);
      const physical = await fs.readFile(targetPath).catch(() => null);
      if (blob != null && physical != null && physical.equals(blob)) {
        literal = blob.toString("utf8");
      }
    }
    const normalized = literal == null ? null : normalizeSymlinkTargetSeparators(literal);
    if (normalized !== output.linkTarget) {
      problems.push(`${output.relPath}: literal target '${literal ?? "?"}' does not equal '${output.linkTarget}'`);
      continue;
    }
    if (catalogRealPath != null) {
      const resolved = await fs
        .realpath(path.resolve(path.dirname(targetPath), literal))
        .catch(() => null);
      if (resolved !== catalogRealPath) {
        problems.push(`${output.relPath}: does not resolve to ${SKILL_TARGET_ROOT}`);
      }
    }
  }
  const pluginManifestPath = path.join(consumerRoot, ...SKILL_PLUGIN_MANIFEST_REL_PATH.split("/"));
  if (!(await exists(pluginManifestPath))) {
    problems.push(`${SKILL_PLUGIN_MANIFEST_REL_PATH}: missing after sync`);
  }
  if (problems.length > 0) {
    const failures = await rollbackCreatedSkillEntries(consumerRoot, context);
    throw new SkillEntryBlockedError(
      `Skill discovery entry verification failed: ${problems.join("; ")}`,
      {
        reason: "legacy-skill-entry-residue",
        paths: managedSkillInventory.discovery.map((output) => output.relPath),
        manualSteps: [...problems, ...failures],
      }
    );
  }
}

async function validateManagedSkillFilesystem(consumerRoot, { managedSkillInventory }) {
  let degradedCount = 0;
  const coreSymlinksState = probeCoreSymlinksState(consumerRoot);
  const preferPlainActive = isPreferPlainCoreSymlinksState(coreSymlinksState);
  for (const output of managedSkillInventory.outputs) {
    const targetPath = path.join(consumerRoot, ...output.relPath.split("/"));
    const stats = await fs.lstat(targetPath).catch(() => null);
    const observed = managedOutputObservedState(stats);
    const gitBackedPlainLink =
      output.type === "symlink" &&
      observed === "file" &&
      gitBackedPlainLinkMatches(consumerRoot, output, await fs.readFile(targetPath));
    if (observed !== output.type && !gitBackedPlainLink) {
      throw new Error(
        `Managed skill output ${output.relPath}: observed ${observed}, expected ${output.type}. ` +
        "Run the source-owned sync-agent-rules.mjs --sync repair path."
      );
    }
    if (output.type !== "symlink") continue;
    if (gitBackedPlainLink) {
      degradedCount += 1;
      continue;
    }

    const linkTarget = await fs.readlink(targetPath).catch(() => null);
    if (typeof linkTarget !== "string") {
      throw new Error(
        `Managed skill output ${output.relPath}: observed symlink target '${linkTarget}', ` +
        `expected '${output.linkTarget}'. Run the source-owned sync-agent-rules.mjs --sync repair path.`
      );
    }
    if (
      normalizeSymlinkTargetSeparators(linkTarget) !==
      normalizeSymlinkTargetSeparators(output.linkTarget)
    ) {
      throw new Error(
        `Managed skill output ${output.relPath}: observed symlink target '${linkTarget}', ` +
        `expected '${output.linkTarget}'. Run the source-owned sync-agent-rules.mjs --sync repair path.`
      );
    }
    const resolved = await fs.realpath(targetPath).catch(() => null);
    if (resolved == null) {
      throw new Error(
        `Managed skill output ${output.relPath}: observed broken symlink. ` +
        "Run the source-owned sync-agent-rules.mjs --sync repair path."
      );
    }
    if (output.targetRelPath) {
      const expectedTarget = await fs.realpath(
        path.join(consumerRoot, ...output.targetRelPath.split("/"))
      ).catch(() => null);
      if (expectedTarget == null || resolved !== expectedTarget) {
        throw new Error(
          `Managed skill output ${output.relPath}: symlink does not resolve to ` +
          `${output.targetRelPath}. Run the source-owned sync-agent-rules.mjs --sync repair path.`
        );
      }
    }
  }
  warnManagedSkillDiscoveryDegraded(degradedCount, { preferPlainActive });
}

function spawnGitForPersistence(consumerRoot, args, options = {}) {
  const { allowUnavailable = false, ...spawnOptions } = options;
  const result = spawnSync("git", args, {
    cwd: consumerRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...spawnOptions,
    env: {
      ...process.env,
      ...(spawnOptions.env ?? {}),
      LC_ALL: "C",
      LANG: "C",
    },
  });
  if (result.error && !(allowUnavailable && result.error.code === "ENOENT")) {
    throw new Error(`Git persistence validator fault: ${result.error.message}`);
  }
  return result;
}

async function hasGitControlMarkerAtOrAbove(startPath) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  let current = await fs.realpath(startPath).catch(() => path.resolve(startPath));
  while (true) {
    const marker = await fs.lstat(path.join(current, ".git")).catch(() => null);
    if (marker?.isDirectory() || marker?.isFile()) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function validateManagedSkillGitPersistence(
  consumerRoot,
  { managedSkillInventory, gitPersistenceRunner = spawnGitForPersistence }
) {
  const rootProbe = gitPersistenceRunner(
    consumerRoot,
    ["rev-parse", "--show-toplevel"],
    { allowUnavailable: true }
  );
  if (rootProbe.error?.code === "ENOENT") {
    if (await hasGitControlMarkerAtOrAbove(consumerRoot)) {
      throw new Error(`Git persistence validator fault: ${rootProbe.error.message}`);
    }
    console.log("Git persistence validation: N/A (non-Git consumer root)");
    return;
  }
  if (
    rootProbe.status !== 0 &&
    /not a git repository/i.test(`${rootProbe.stderr ?? ""}\n${rootProbe.stdout ?? ""}`)
  ) {
    console.log("Git persistence validation: N/A (non-Git consumer root)");
    return;
  }
  if (rootProbe.status !== 0) {
    throw new Error(
      `Git persistence validator fault: git rev-parse exited ${rootProbe.status}: ` +
      `${String(rootProbe.stderr || rootProbe.stdout).trim()}`
    );
  }

  const requestedRoot = await fs.realpath(consumerRoot).catch(() => path.resolve(consumerRoot));
  const reportedRootText = rootProbe.stdout.trim();
  if (!reportedRootText) {
    throw new Error("Git persistence validator fault: git rev-parse returned an empty top-level");
  }
  const reportedRoot = await fs.realpath(reportedRootText).catch(() => path.resolve(reportedRootText));
  if (reportedRoot !== requestedRoot) {
    throw new Error(
      `Git persistence validator fault: consumer root '${requestedRoot}' is inside different Git root ` +
      `'${reportedRoot}'`
    );
  }

  const paths = managedSkillInventory.outputs.map((output) => output.relPath);
  const result = gitPersistenceRunner(
    consumerRoot,
    ["check-ignore", "-v", "-z", "--no-index", "--stdin"],
    { input: `${paths.join("\0")}\0` }
  );
  const records = parseGitCheckIgnoreRecords({
    stdout: result.stdout,
    status: result.status,
    expectedPaths: paths,
  });
  const positive = records.find((record) => !record.isNegation);
  if (positive) {
    throw new Error(
      `Managed skill output ${positive.pathname} remains ignored by ` +
      `${positive.source}:${positive.line} pattern '${positive.pattern}'. ` +
      "Run the source-owned sync-agent-rules.mjs --sync repair path; do not use git add -f."
    );
  }
  console.log(
    `Git persistence validation: PASS (${paths.length} managed outputs; 1 check-ignore batch)`
  );
}

/**
 * Read consumer-owned JSON for sync, check, or uninstall. Missing or blank
 * means there is nothing to preserve. Read errors, malformed JSON, and non-object
 * values must stop the command instead of being treated as an empty config.
 */
async function readConsumerJsonObject(filePath, label, command) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") {
      // A symlink whose target is missing also reads as ENOENT; writing through it would
      // create the target, so only a path with no directory entry at all counts as absent.
      const entry = await fs.lstat(filePath).catch(() => null);
      if (entry === null) return {};
      throw new Error(
        `Consumer file ${label} is a symlink to a missing target. Refusing to continue; fix or remove the link, then re-run ${command} with the same options.`,
        { cause: e }
      );
    }
    throw new Error(
      `Failed to read consumer file ${label}: ${e.message}. Refusing to continue; fix the file, then re-run ${command} with the same options.`,
      { cause: e }
    );
  }
  if (raw.trim() === "") return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : String(e);
    throw new Error(
      `Invalid JSON in consumer file ${label}: ${detail}. Refusing to continue; fix or remove the file, then re-run ${command} with the same options.`,
      { cause: e }
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `Consumer file ${label} is not a JSON object. Refusing to continue; fix or remove the file, then re-run ${command} with the same options.`
    );
  }
  return data;
}

async function forEachStaticSourceFile(callback) {
  for (const { relPath } of STATIC_FILES) {
    const source = path.join(getCentralRoot(), relPath);
    if (!(await exists(source))) continue;
    await callback({ relPath, source });
  }
}

function mergeHookEvents(targetData, sourceData) {
  if (sourceData.hooks) {
    targetData.hooks = { ...targetData.hooks, ...sourceData.hooks };
  }
}

function assertHookEventsMatch({ sourceData, targetData, driftLabel }) {
  if (!sourceData.hooks) return;
  const targetHooksData = targetData.hooks ?? {};
  for (const key of Object.keys(sourceData.hooks)) {
    const expected = JSON.stringify(sourceData.hooks[key]);
    const actual = JSON.stringify(targetHooksData[key]);
    if (expected !== actual) {
      throw new Error(`Out of sync: ${driftLabel} hooks.${key} differs`);
    }
  }
}

async function syncHooksJsonConfig({
  consumerRoot,
  sourceRelPath,
  syncLabel,
  versionPolicy = "ignore",
}) {
  const sourceHooks = path.join(getCentralRoot(), sourceRelPath);
  if (!(await exists(sourceHooks))) return;

  const targetHooks = path.join(consumerRoot, sourceRelPath);
  const sourceData = await parseSourceJsonFile(sourceHooks);
  const targetData = await readConsumerJsonObject(targetHooks, sourceRelPath, "--sync");

  mergeHookEvents(targetData, sourceData);
  if (versionPolicy === "copy-if-number" && typeof sourceData.version === "number") {
    targetData.version = sourceData.version;
  }

  await fs.mkdir(path.dirname(targetHooks), { recursive: true });
  await writeFileUnlessSameBytes(
    targetHooks,
    `${JSON.stringify(targetData, null, 2)}\n`
  );
  console.log(syncLabel);
}

async function checkHooksJsonConfig({
  consumerRoot,
  sourceRelPath,
  driftLabel,
  versionPolicy = "ignore",
}) {
  const sourceHooks = path.join(getCentralRoot(), sourceRelPath);
  if (!(await exists(sourceHooks))) return;

  const targetHooks = path.join(consumerRoot, sourceRelPath);
  const sourceData = await parseSourceJsonFile(sourceHooks);
  const targetData = await readConsumerJsonObject(targetHooks, sourceRelPath, "--check");

  assertHookEventsMatch({ sourceData, targetData, driftLabel });
  if (versionPolicy === "must-match-if-number" && typeof sourceData.version === "number" && targetData.version !== sourceData.version) {
    throw new Error(`Out of sync: ${driftLabel} version differs`);
  }
}

/**
 * Read a repo's git index once and derive both the set of tracked relpaths and
 * the subset marked `100755`. `ls-files -s` is authoritative under
 * `core.fileMode=false` (Windows), where index mode — not the filesystem bit —
 * decides synchronization parity.
 *
 * Returns `null` (not an empty set) when the index cannot be read, so callers
 * can distinguish "repo tracks no such path" from "index unreadable" and keep
 * fail-closed semantics instead of silently treating every extra as local.
 */
function readRepoIndex(repoRoot) {
  const result = spawnGitArgv(
    repoRoot,
    ["--no-optional-locks", "-c", "core.quotePath=false", "ls-files", "-s"],
    { maxBuffer: GIT_INDEX_MAX_BUFFER },
  );
  if (gitProbeFailed(result) || result.status !== 0) return null;
  const execPaths = new Set();
  const trackedPaths = new Set();
  for (const line of (result.stdout || "").split("\n")) {
    if (!line) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) continue;
    const mode = line.slice(0, tabIndex).trim().split(/\s+/)[0];
    const relPath = line.slice(tabIndex + 1).replace(/\\/g, "/");
    if (!relPath) continue;
    trackedPaths.add(relPath);
    if (mode === "100755") execPaths.add(relPath);
  }
  return { execPaths, trackedPaths };
}

let sourceRepoIndexMemo;
function resetSourceExecBitPathsMemo() {
  sourceRepoIndexMemo = undefined;
}

/**
 * True when `startDir` or any ancestor carries a git repository marker
 * (a `.git` directory for a normal repo, or a `.git` gitfile for a linked
 * worktree / submodule). Locale-independent and filesystem-based — unlike a
 * regex over git's stderr, which a *corrupt* `.git` also trips with
 * "not a git repository".
 */
function hasGitMarkerUpTree(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Classify a `rev-parse --is-inside-work-tree` probe result.
 *
 * - `gitProbeFailed(result)` (spawn error / timeout) → `unreadable`, regardless
 *   of marker presence: a probe that could not run is untrustworthy.
 * - status 0 → `repo`.
 * - non-zero status → `unreadable` when a git marker exists up the tree (a repo
 *   git could not read, e.g. a corrupt `.git`); otherwise `not-a-repo` (N/A) —
 *   the only trustworthy non-repo conclusion.
 */
function classifySourceRepoProbe(result, { hasGitMarker = false } = {}) {
  if (gitProbeFailed(result)) return "unreadable";
  if (result.status === 0) return "repo";
  return hasGitMarker ? "unreadable" : "not-a-repo";
}

/**
 * Probe the source repo's git index exactly once per process and memoize the
 * *tagged* outcome. A single snapshot is read and reused by every consumer of
 * the source index, so a transient failure on one getter can never be combined
 * with a later success on another getter inside the same parity comparison.
 *
 * States:
 * - `{ state: "ok", execPaths, trackedPaths }` — index readable.
 * - `{ state: "not-a-repo" }` — the probe completed normally with a non-zero
 *   status and no git marker exists anywhere up the tree (a trustworthy
 *   non-repo, e.g. a slim fixture); parity is N/A, the same class as the
 *   consumer non-git skip.
 * - `{ state: "unreadable" }` — the git process could not run at all (spawn
 *   error / timeout — regardless of marker presence), or a git marker exists
 *   but the probe / index read failed. Callers stay fail-closed.
 */
function probeSourceRepoIndex() {
  const sourceRoot = getCentralRoot();
  const probe = spawnGitArgv(sourceRoot, ["rev-parse", "--is-inside-work-tree"]);
  const kind = classifySourceRepoProbe(probe, {
    hasGitMarker: hasGitMarkerUpTree(sourceRoot),
  });
  if (kind === "not-a-repo") return { state: "not-a-repo" };
  if (kind === "unreadable") return { state: "unreadable" };
  const index = readRepoIndex(sourceRoot);
  if (index === null) return { state: "unreadable" };
  return { state: "ok", execPaths: index.execPaths, trackedPaths: index.trackedPaths };
}

function getSourceRepoIndex() {
  if (sourceRepoIndexMemo === undefined) {
    sourceRepoIndexMemo = probeSourceRepoIndex();
  }
  return sourceRepoIndexMemo;
}
function getSourceExecBitPaths() {
  const sourceIndex = getSourceRepoIndex();
  return sourceIndex.state === "ok" ? sourceIndex.execPaths : new Set();
}

/**
 * Pending synced relPaths that need consumer index `100755` after content copy.
 * Flushed once (or in bounded batches) by flushExecBitIndexModes — avoids N
 * independent `update-index` lock acquires on contended Windows worktrees.
 */
let pendingExecBitRelPaths = new Set();
const EXEC_BIT_INDEX_RETRY_LIMIT = 3;
const EXEC_BIT_INDEX_RETRY_MS = 50;
const EXEC_BIT_INDEX_BATCH_SIZE = 256;

function resetPendingExecBitRelPaths() {
  pendingExecBitRelPaths = new Set();
}

function isReleaseRulesBranch(consumerRoot) {
  try {
    const branch = getCurrentBranch(consumerRoot);
    return typeof branch === "string" && branch.startsWith("release/");
  } catch {
    return false;
  }
}

function resolveGitIndexLockPath(consumerRoot) {
  const result = spawnGitArgv(consumerRoot, ["rev-parse", "--git-path", "index.lock"]);
  if (!gitProbeFailed(result) && result.status === 0 && result.stdout?.trim()) {
    const resolved = result.stdout.trim();
    return path.isAbsolute(resolved) ? resolved : path.join(consumerRoot, resolved);
  }
  return path.join(consumerRoot, ".git", "index.lock");
}

function formatExecBitIndexFailure(consumerRoot, result) {
  const lockPath = resolveGitIndexLockPath(consumerRoot);
  const detail = result?.stderr?.trim() || result?.error?.message || "unknown error";
  return (
    `Exec-bit warning: failed to batch-set 100755 via update-index: ${detail}. ` +
    `If git index is locked, inspect and clear after stopping competing writers: ${lockPath}. ` +
    `Next action: stop TortoiseGit/VS Code git polling (or other concurrent git), ` +
    `remove stale index.lock only if safe, then re-run --sync.`
  );
}

/**
 * Restore working-tree +x (POSIX) and enqueue index `100755` for a synced file.
 * Index writes are batched in flushExecBitIndexModes (D2); win32 skips FS chmod.
 */
async function applyExecBitMode(consumerRoot, relPath) {
  // POSIX: git executes hooks based on the working-tree executable bit, not the
  // index mode. Index `--chmod=+x` only touches the index, so a 0644 working-tree
  // file would remain non-executable. Set the working-tree mode explicitly
  // (no-op on win32, which has no executable bit).
  if (process.platform !== "win32") {
    try {
      await fs.chmod(path.join(consumerRoot, relPath), 0o755);
    } catch (error) {
      console.warn(
        `Exec-bit warning: failed to chmod 755 for ${relPath}: ${error?.message || "unknown error"}`
      );
    }
  }
  pendingExecBitRelPaths.add(relPath);
}

/**
 * Batch `git update-index --add --chmod=+x` for pending synced paths.
 * Skips index mode writes on `release/*` (D3): content still copied; residual
 * mode must be fixed on the rules lane, never via arbitrary restore on release.
 */
async function flushExecBitIndexModes(consumerRoot) {
  const paths = [...pendingExecBitRelPaths].sort();
  pendingExecBitRelPaths.clear();
  if (paths.length === 0) return;
  if (isReleaseRulesBranch(consumerRoot)) {
    console.warn(
      "Exec-bit notice: skipping git update-index --chmod=+x on release/* branch; " +
        "rules-lane sync commit must include mode (`git diff --cached --summary`). " +
        "Residual mode on release → return to rules lane; do not git restore on release/*."
    );
    return;
  }
  for (let offset = 0; offset < paths.length; offset += EXEC_BIT_INDEX_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + EXEC_BIT_INDEX_BATCH_SIZE);
    let lastResult = null;
    let ok = false;
    for (let attempt = 0; attempt < EXEC_BIT_INDEX_RETRY_LIMIT; attempt++) {
      lastResult = spawnGitArgv(consumerRoot, [
        "--no-optional-locks",
        "update-index",
        "--add",
        "--chmod=+x",
        "--",
        ...batch,
      ]);
      if (!gitProbeFailed(lastResult) && lastResult.status === 0) {
        ok = true;
        break;
      }
      if (attempt + 1 < EXEC_BIT_INDEX_RETRY_LIMIT) {
        await new Promise((resolve) =>
          setTimeout(resolve, EXEC_BIT_INDEX_RETRY_MS * (attempt + 1))
        );
      }
    }
    if (!ok) {
      console.warn(formatExecBitIndexFailure(consumerRoot, lastResult));
    }
  }
}

/**
 * Return true when a repo-relative path lives under a synced carrier
 * (SYNC_DIRS or STATIC_FILES), so mode comparison ignores consumer-local files.
 */
function isSyncedExecBitPath(relPath) {
  for (const { relPath: dirRel } of SYNC_DIRS) {
    if (relPath === dirRel || relPath.startsWith(`${dirRel}/`)) return true;
  }
  for (const { relPath: fileRel } of STATIC_FILES) {
    if (relPath === fileRel) return true;
  }
  return false;
}

/**
 * Classify the source-vs-consumer synced `100755` difference from a single
 * memoized source-index snapshot.
 *
 * - `sourceState`: `"ok"` | `"not-a-repo"` | `"unreadable"` (see
 *   `probeSourceRepoIndex`). `missing`/`extra`/`consumerLocal` are only
 *   meaningful when `"ok"`.
 * - `consumerState`: `"ok"` | `"unreadable"`. An unreadable consumer index is
 *   reported as such, never read as an empty index — that would classify every
 *   source `100755` path as `missing` and send the operator to `--sync`.
 * - `missing`: source-`100755` synced paths absent from the consumer index (drift).
 * - `extra`: consumer-`100755` synced paths the source repo *also tracks* but
 *   does not itself mark `100755` (drift — a real index-mode divergence).
 * - `consumerLocal`: consumer-`100755` synced paths the source repo does not
 *   track at all, e.g. a consumer-owned git hook under `core.hooksPath`
 *   (`.devpro/scripts/hooks-git/<hook>`). Sync preserves these, so they are not
 *   drift.
 */
function diffExecBitParity(consumerRoot) {
  const sourceIndex = getSourceRepoIndex();
  if (sourceIndex.state !== "ok") {
    return { sourceState: sourceIndex.state, consumerState: "ok", missing: [], extra: [], consumerLocal: [] };
  }
  const consumerIndex = readRepoIndex(consumerRoot);
  if (consumerIndex === null) {
    return { sourceState: "ok", consumerState: "unreadable", missing: [], extra: [], consumerLocal: [] };
  }
  const sourceExec = [...sourceIndex.execPaths].filter(isSyncedExecBitPath);
  const consumerExec = [...consumerIndex.execPaths].filter(isSyncedExecBitPath);
  const sourceSet = new Set(sourceExec);
  const consumerSet = new Set(consumerExec);
  const missing = sourceExec.filter((relPath) => !consumerSet.has(relPath));
  const extraAll = consumerExec.filter((relPath) => !sourceSet.has(relPath));
  const extra = extraAll.filter((relPath) => sourceIndex.trackedPaths.has(relPath));
  const consumerLocal = extraAll.filter((relPath) => !sourceIndex.trackedPaths.has(relPath));
  return { sourceState: "ok", consumerState: "ok", missing, extra, consumerLocal };
}

/**
 * Compare source vs consumer synced `100755` sets.
 * mode "warn" = sync path (never blocks); mode "fail" = --check fail-closed (D1).
 *
 * Real drift fails `--check` with a class-appropriate next step: a `missing`
 * path (source `100755`, consumer index not) points at `--sync`; an `extra`
 * path the source tracks as `100644` points at removing the mode
 * (`git update-index --chmod=-x`) because `--sync` never clears it. A
 * consumer-local extra (a path the source repo does not track) is never drift:
 * it is reported as consumer-local and never points at `--sync`.
 *
 * Index states that cannot prove parity stay fail-closed for `--check`:
 * a readable source AND consumer index is required, so an unreadable index
 * throws (never a silent green, never a false `missing`). `--sync` only warns. A non-Git source root is N/A (no index to
 * compare, same class as the `checkExecBitParity` consumer non-Git skip).
 */
async function assertExecBitParity(consumerRoot, { mode = "warn" } = {}) {
  const { sourceState, consumerState, missing, extra, consumerLocal } = diffExecBitParity(consumerRoot);
  if (sourceState === "not-a-repo") return;
  if (sourceState === "unreadable") {
    if (mode === "fail") {
      throw new Error(
        "Exec-bit check failed: source git index is unreadable "
        + `at ${getCentralRoot()}; cannot verify synced 100755 parity. `
        + "Re-run once the source index is readable (repair the source clone / index lock)."
      );
    }
    console.warn(
      "Exec-bit warning: source git index is unreadable; cannot verify synced 100755 parity. Re-run after the source index is readable."
    );
    return;
  }
  if (consumerState === "unreadable") {
    if (mode === "fail") {
      throw new Error(
        "Exec-bit check failed: consumer git index could not be read "
        + `at ${consumerRoot}; cannot verify synced 100755 parity. `
        + "Re-run once `git ls-files -s` succeeds there (repair the index / index lock); "
        + "--sync does not fix an unreadable index."
      );
    }
    console.warn(
      "Exec-bit warning: consumer git index could not be read; cannot verify synced 100755 parity. Re-run after `git ls-files -s` succeeds in the consumer."
    );
    return;
  }
  if (consumerLocal.length > 0) {
    console.warn(
      `Exec-bit warning: ${consumerLocal.length} consumer-local 100755 file(s) not tracked by the source repo (consumer-local, not sync drift): ${consumerLocal.join(", ")}. Leave them as-is; no upstream re-sync is needed.`
    );
  }
  if (missing.length === 0 && extra.length === 0) return;
  const parts = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} source 100755 file(s) missing from the consumer index: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    parts.push(`${extra.length} consumer 100755 file(s) tracked by the source but not marked 100755 there: ${extra.join(", ")}`);
  }
  if (mode === "fail") {
    // Next step is per class: --sync only ever ADDS 100755 for source-marked
    // paths, so it restores the `missing` class but never clears the `extra`
    // class (a consumer 100755 mode on a path the source tracks as 100644).
    const steps = [];
    if (missing.length > 0) {
      steps.push(
        isReleaseRulesBranch(consumerRoot)
          ? "On release/* --sync skips index --chmod=+x; return to the rules lane, sync there so the commit includes mode (100755), then re-check."
          : "Run --sync to restore index mode (100755), then re-check."
      );
    }
    if (extra.length > 0) {
      steps.push(
        "For the extra path(s) the source tracks as 100644, --sync cannot clear the consumer's 100755 mode; remove it with `git update-index --chmod=-x -- <path>` (plus `chmod -x` on a POSIX working tree), then re-check."
      );
    }
    throw new Error(
      `Exec-bit check failed: ${parts.join("; ")}. ${steps.join(" ")}`
    );
  }
  console.warn(`Exec-bit warning: ${parts.join("; ")}`);
}

/**
 * Warn (never block) when the source and consumer sets of `100755` synced
 * paths differ after sync — both directions (equality), not just
 * source-marked files missing from the consumer.
 */
async function warnExecBitMismatch(consumerRoot) {
  await assertExecBitParity(consumerRoot, { mode: "warn" });
}

/** Fail-closed --check step: synced 100755 drift must not print in-sync green. */
async function checkExecBitParity(consumerRoot) {
  // Non-Git fixtures cannot assert index mode (same class as Git persistence N/A).
  // Consumer CI / real worktrees always have Git — drift still fails closed there.
  const probe = spawnGitArgv(consumerRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (gitProbeFailed(probe) || probe.status !== 0) return;
  await assertExecBitParity(consumerRoot, { mode: "fail" });
}

async function syncStaticFiles(consumerRoot) {
  await forEachStaticSourceFile(async ({ relPath, source }) => {
    const target = path.join(consumerRoot, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    if (getSourceExecBitPaths().has(relPath)) {
      await applyExecBitMode(consumerRoot, relPath);
    }
    console.log(`Synchronized ${relPath}`);
  });
}

async function checkStaticFiles(consumerRoot) {
  await forEachStaticSourceFile(async ({ relPath, source }) => {
    const srcContent = await readFileOrEmpty(source);
    const tgtContent = await readFileOrEmpty(path.join(consumerRoot, relPath));
    if (srcContent !== tgtContent) {
      throw new Error(`Out of sync: ${relPath} differs`);
    }
  });
}

async function walkSourceFiles(srcDir, ignoredRelPaths, onFile, onDirectory, onSymlink, rootDir = srcDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (RESERVED_CONSUMER_BASENAMES.includes(entry.name)) continue;
    const sourcePath = path.join(srcDir, entry.name);
    const rel = normalizeRelPath(path.relative(rootDir, sourcePath));
    if (ignoredRelPaths.has(rel)) continue;
    // Symlink nodes (e.g. .agents/skills/devpro) must never be
    // followed into (they'd recurse into the *target* tree) nor treated as
    // a plain file (fs.copyFile would follow the link and materialize the
    // target contents). Checked before isDirectory() because Dirent from
    // withFileTypes reports isDirectory() === false for a symlink-to-dir.
    if (entry.isSymbolicLink()) {
      if (onSymlink) {
        await onSymlink(sourcePath, rel);
      } else {
        // Backward-compat fallback for callers that don't care about
        // symlink semantics: preserve pre-existing behavior (treat as file).
        await onFile(sourcePath, rel);
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (onDirectory) {
        await onDirectory(sourcePath, rel);
      }
      await walkSourceFiles(sourcePath, ignoredRelPaths, onFile, onDirectory, onSymlink, rootDir);
      continue;
    }
    await onFile(sourcePath, rel);
  }
}

/**
 * Byte-equal sync of all files under srcDir into tgtDir (recursive).
 * Consumer-local extras are preserved (we don't delete). Missing source dir is a no-op.
 *
 * @param {string} srcDir
 * @param {string} tgtDir
 * @param {string} label
 * @param {{ ignoredRelPaths?: Set<string>, consumerRoot?: string }} [options]
 *   consumerRoot — required whenever srcDir/tgtDir can contain skill-discovery
 *   symlinks (i.e. every current SYNC_DIRS / CLAUDE_SYNC_SUBDIRS call site);
 *   used to confine both the recreated link's resolved target (C3
 *   path-traversal guard) and any pre-existing node at targetPath (C1
 *   data-loss guard) to this consumer's own `.devpro/agent-skills/` tree
 *   before ever calling fs.rm/fs.symlink. See onSymlink below.
 */
async function syncDir(srcDir, tgtDir, label, { ignoredRelPaths = new Set(), consumerRoot } = {}) {
  if (!(await exists(srcDir))) {
    return;
  }
  await fs.mkdir(tgtDir, { recursive: true });
  let syncedCount = 0;
  await walkSourceFiles(
    srcDir,
    ignoredRelPaths,
    async (sourcePath) => {
      const targetPath = path.join(tgtDir, path.relative(srcDir, sourcePath));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      const relPath = normalizeRelPath(path.relative(getCentralRoot(), sourcePath));
      if (getSourceExecBitPaths().has(relPath)) {
        await applyExecBitMode(consumerRoot, relPath);
      }
      syncedCount++;
    },
    async (sourcePath) => {
      const targetPath = path.join(tgtDir, path.relative(srcDir, sourcePath));
      await fs.mkdir(targetPath, { recursive: true });
    },
    async (sourcePath) => {
      // Recreate the symlink itself (not its target contents) at the
      // consumer destination, using the source's own relative target —
      // never fs.copyFile, which would follow the link.
      const targetPath = path.join(tgtDir, path.relative(srcDir, sourcePath));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const linkTarget = await fs.readlink(sourcePath);

      if (!consumerRoot) {
        throw new Error(
          `Cannot safely install symlink ${sourcePath} -> ${linkTarget}: syncDir() was called ` +
          "without a consumerRoot, so the confinement guard cannot run. This is a caller bug, not " +
          "a consumer data problem — every SYNC_DIRS/CLAUDE_SYNC_SUBDIRS call site must pass consumerRoot."
        );
      }

      // C3 (path-traversal): the relative linkTarget will be resolved by the
      // OS against targetPath's own directory once installed on the consumer
      // side — never against the source tree. Verify THAT resolution stays
      // confined to this consumer's own .devpro/agent-skills/ before ever
      // writing the symlink. Mirrors collectDevproSkillSymlinks()'s
      // canonicalizeBestEffort() + prefix-check confinement logic (SSOT).
      const resolvedConsumerTarget = await canonicalizeBestEffort(
        path.resolve(path.dirname(targetPath), linkTarget)
      );
      if (!(await isConfinedToConsumerSkillsRoot(consumerRoot, resolvedConsumerTarget))) {
        throw new Error(
          `Refusing to install symlink at ${targetPath}: its target (${linkTarget}) resolves to ` +
          `${resolvedConsumerTarget}, which escapes this consumer's .devpro/agent-skills/ tree. ` +
          "Source-tree skill symlinks must only ever point within .devpro/agent-skills/."
        );
      }

      // C1 (data-loss): only remove a pre-existing node at targetPath when it
      // is itself one of OUR previously-distributed symlinks (a real symlink
      // resolving inside this consumer's .devpro/agent-skills/) — mirrors the
      // uninstall side's collectDevproSkillSymlinks() classification exactly.
      // A consumer-owned plain file/dir, or a consumer-authored symlink
      // pointing elsewhere, must never be silently fs.rm'd here.
      const existingStats = await fs.lstat(targetPath).catch(() => null);
      if (existingStats) {
        if (!existingStats.isSymbolicLink()) {
          throw new Error(
            `Refusing to overwrite ${targetPath}: a plain file/directory already exists there and is ` +
            "not a devpro-agent-rules-managed skill symlink. Move or remove it manually, then re-run --sync."
          );
        }
        const existingLinkTarget = await fs.readlink(targetPath).catch(() => null);
        const resolvedExistingTarget =
          existingLinkTarget == null
            ? null
            : await canonicalizeBestEffort(path.resolve(path.dirname(targetPath), existingLinkTarget));
        const existingIsOurs =
          resolvedExistingTarget != null &&
          (await isConfinedToConsumerSkillsRoot(consumerRoot, resolvedExistingTarget));
        if (!existingIsOurs) {
          throw new Error(
            `Refusing to overwrite ${targetPath}: an existing symlink there points outside this ` +
            "consumer's .devpro/agent-skills/ tree (not a devpro-agent-rules-managed skill symlink). " +
            "Move or remove it manually, then re-run --sync."
          );
        }
        await fs.rm(targetPath, { recursive: true, force: true });
      }

      const sourceTargetStats = await fs.stat(sourcePath).catch(() => null);
      await createPortableManagedSymlink(
        linkTarget,
        targetPath,
        sourceTargetStats?.isDirectory() ? "directory" : "file"
      );
      syncedCount++;
    }
  );
  if (syncedCount > 0) {
    console.log(`Synchronized ${label} (${syncedCount} files)`);
  }
}

/**
 * Byte-equal parity check of all files under srcDir against tgtDir.
 * Consumer-local extras are allowed (not checked); every source file must match.
 * Missing source dir is a no-op.
 */
async function checkDir(srcDir, tgtDir, label, { ignoredRelPaths = new Set() } = {}) {
  if (!(await exists(srcDir))) {
    return;
  }
  await walkSourceFiles(
    srcDir,
    ignoredRelPaths,
    async (sourcePath) => {
      const targetPath = path.join(tgtDir, path.relative(srcDir, sourcePath));
      const sourceContent = await readFileOrEmpty(sourcePath);
      const targetContent = await readFileOrEmpty(targetPath);
      if (sourceContent !== targetContent) {
        const rel = path.relative(srcDir, sourcePath);
        throw new Error(`Out of sync: ${label}/${rel} differs`);
      }
    },
    undefined,
    async (sourcePath) => {
      // Symlink parity: target must also be a symlink with an identical
      // relative link target — not byte-content comparison (readFileOrEmpty
      // on a symlink would follow it and compare materialized contents,
      // which is not what "in sync" means for a distributed symlink).
      const targetPath = path.join(tgtDir, path.relative(srcDir, sourcePath));
      const rel = path.relative(srcDir, sourcePath);
      const sourceLinkTarget = await fs.readlink(sourcePath);
      const targetStats = await fs.lstat(targetPath).catch(() => null);
      if (!targetStats?.isSymbolicLink()) {
        throw new Error(`Out of sync: ${label}/${rel} differs (expected symlink)`);
      }
      const targetLinkTarget = await fs.readlink(targetPath);
      if (typeof sourceLinkTarget !== "string" || typeof targetLinkTarget !== "string") {
        throw new Error(`Out of sync: ${label}/${rel} differs (symlink target)`);
      }
      if (
        normalizeSymlinkTargetSeparators(sourceLinkTarget) !==
        normalizeSymlinkTargetSeparators(targetLinkTarget)
      ) {
        throw new Error(`Out of sync: ${label}/${rel} differs (symlink target)`);
      }
    }
  );
}

/**
 * `attribution` in .claude/settings.json is source-owned only when the source
 * value is a plain object; sync, the uninstall plan and the uninstall reversal
 * all gate on this one check.
 */
function isSourceAttributionObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Sync .claude/commands/*, .claude/agents/*, and .claude/settings.json to consumer repo root */
async function syncClaudeConfig(consumerRoot, { managedSkillInventory }) {
  for (const subdir of CLAUDE_SYNC_SUBDIRS) {
    const ignoredRelPaths = managedDiscoveryIgnoredRelPaths(
      path.join(".claude", subdir),
      managedSkillInventory
    );
    await syncDir(
      path.join(getCentralRoot(), ".claude", subdir),
      path.join(consumerRoot, ".claude", subdir),
      `.claude/${subdir}/`,
      { consumerRoot, ignoredRelPaths }
    );
  }

  const sourceSettings = path.join(getCentralRoot(), ".claude", "settings.json");
  if (await exists(sourceSettings)) {
    const targetSettings = path.join(consumerRoot, ".claude", "settings.json");
    const sourceData = await parseSourceJsonFile(sourceSettings);
    const targetData = await readConsumerJsonObject(targetSettings, ".claude/settings.json", "--sync");

    mergeHookEvents(targetData, sourceData);
    if (typeof sourceData.model === "string") {
      targetData.model = sourceData.model;
    }
    if (sourceData.statusLine) {
      targetData.statusLine = sourceData.statusLine;
    }
    if (isSourceAttributionObject(sourceData.attribution)) {
      targetData.attribution = sourceData.attribution;
    }

    await writeFileUnlessSameBytes(
      targetSettings,
      `${JSON.stringify(targetData, null, 2)}\n`
    );
    console.log("Synchronized .claude/settings.json (hooks + model + statusLine + attribution)");
  }
}

/** Sync all SYNC_DIRS from source to consumer */
async function syncDirs(consumerRoot, context) {
  const { managedSkillInventory } = context;
  for (const { relPath } of SYNC_DIRS) {
    const ignoredRelPaths = buildIgnoredRelPaths(relPath);
    for (const discoveryPath of managedDiscoveryIgnoredRelPaths(relPath, managedSkillInventory)) {
      ignoredRelPaths.add(discoveryPath);
    }
    await syncDir(
      path.join(getCentralRoot(), relPath),
      path.join(consumerRoot, relPath),
      relPath + "/",
      { ignoredRelPaths, consumerRoot }
    );
  }
  await syncManagedSkillDiscovery(consumerRoot, context);
}

async function syncCodexConfig(consumerRoot) {
  for (const config of HOOK_JSON_CONFIGS) {
    await syncHooksJsonConfig({
      consumerRoot,
      sourceRelPath: config.sourceRelPath,
      syncLabel: config.syncLabel,
      versionPolicy: config.syncVersionPolicy,
    });
  }
}

/**
 * Check parity for .claude/commands/, .claude/agents/, and .claude/settings.json.
 * Semantics mirror syncClaudeConfig: extras in consumer are allowed
 * (consumer-local commands/agents, consumer-local settings keys); every source
 * file / hook key / top-level model field must have a byte-equal counterpart.
 */
async function checkClaudeConfig(consumerRoot, { managedSkillInventory }) {
  for (const subdir of CLAUDE_SYNC_SUBDIRS) {
    const ignoredRelPaths = managedDiscoveryIgnoredRelPaths(
      path.join(".claude", subdir),
      managedSkillInventory
    );
    await checkDir(
      path.join(getCentralRoot(), ".claude", subdir),
      path.join(consumerRoot, ".claude", subdir),
      `.claude/${subdir}`,
      { ignoredRelPaths }
    );
  }

  const sourceSettings = path.join(getCentralRoot(), ".claude", "settings.json");
  if (await exists(sourceSettings)) {
    const targetSettings = path.join(consumerRoot, ".claude", "settings.json");
    const sourceData = await parseSourceJsonFile(sourceSettings);
    const targetData = await readConsumerJsonObject(targetSettings, ".claude/settings.json", "--check");
    assertHookEventsMatch({
      sourceData,
      targetData,
      driftLabel: ".claude/settings.json",
    });
    if (typeof sourceData.model === "string" && targetData.model !== sourceData.model) {
      throw new Error(`Out of sync: .claude/settings.json model differs`);
    }
    if (sourceData.statusLine) {
      const expected = JSON.stringify(sourceData.statusLine);
      const actual = JSON.stringify(targetData.statusLine);
      if (expected !== actual) {
        throw new Error(`Out of sync: .claude/settings.json statusLine differs`);
      }
    }
  }
}

/** Check all SYNC_DIRS for parity */
async function checkDirs(consumerRoot, { managedSkillInventory }) {
  for (const { relPath } of SYNC_DIRS) {
    const ignoredRelPaths = buildIgnoredRelPaths(relPath);
    for (const discoveryPath of managedDiscoveryIgnoredRelPaths(relPath, managedSkillInventory)) {
      ignoredRelPaths.add(discoveryPath);
    }
    await checkDir(
      path.join(getCentralRoot(), relPath),
      path.join(consumerRoot, relPath),
      relPath,
      { ignoredRelPaths }
    );
  }
}

/**
 * --sync self-cleanup for source-managed workflow files that used to be
 * installed by an earlier version of this script but have since been
 * retired (see cross-runtime-parity spec's install-not-delete contract:
 * --sync may only delete a fixed, named allowlist of its own past output —
 * it must never readdir an unknown directory or rm -rf a whole directory).
 * Iterates the fixed LEGACY_SOURCE_WORKFLOW_FILES allowlist and removes each
 * file that still exists; files not present are a no-op.
 *
 * Accepted-risk note: these five names are reserved devpro-owned workflow
 * names — detection is by filename only (no provenance/content check), so a
 * consumer repo that created its own file under one of these exact names
 * will have it silently deleted on --sync. This is a deliberate accepted
 * risk (consumers MUST NOT reuse these reserved names), so every deletion
 * is announced via a loud console.warn (not console.log) naming the
 * reserved-name contract and how to recover (git restore + rename) if the
 * deleted file was actually the consumer's own.
 *
 * Best-effort: an individual file's fs.rm failure (e.g. permission denied)
 * must not abort the whole --sync run — it is warned and skipped so the
 * rest of sync still completes.
 */
async function pruneLegacySourceWorkflows(consumerRoot) {
  for (const relPath of LEGACY_SOURCE_WORKFLOW_FILES) {
    const target = path.join(consumerRoot, relPath);
    if (!(await exists(target))) continue;
    try {
      await fs.rm(target, { force: true });
      console.warn(
        `⚠ Removed legacy source-managed workflow: ${relPath} — this is a reserved devpro-owned name; if this file was your own, restore it with git and rename it.`
      );
    } catch (err) {
      console.warn(
        `⚠ Failed to prune legacy workflow ${relPath}: ${err.message} — skipping, sync continues.`
      );
    }
  }
}

/**
 * --check backstop for legacy source-managed workflow residue (enforce-sync-
 * prune-verification R3, reversing the ROT-premise removal made by archived
 * change 2026-07-05-refactor-legacy-cleanup-into-sync — see decisions.md D1).
 * Shares the fixed LEGACY_SOURCE_WORKFLOW_FILES allowlist with
 * pruneLegacySourceWorkflows() (single SSOT, no duplicated list). Same
 * independent-backstop rationale as checkLegacyConsumerCommands(): a --sync
 * run through a stale root-path script copy can bypass the prune entirely,
 * so --check must fail-closed on its own whenever residue exists. Read-only:
 * never deletes, never warns about the reserved-name accepted risk (that
 * belongs to the --sync-side prune, not this read-only check).
 */
async function checkLegacySourceWorkflows(consumerRoot) {
  for (const relPath of LEGACY_SOURCE_WORKFLOW_FILES) {
    if (await exists(path.join(consumerRoot, relPath))) {
      throw new Error(
        "Out of sync: legacy source-managed workflow residue present. Run --sync."
      );
    }
  }
}

async function pruneLegacySkillArtifacts(consumerRoot, relPaths, label) {
  for (const relPath of relPaths) {
    const target = path.join(consumerRoot, relPath);
    if (!(await nodeExists(target))) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      console.warn(
        `⚠ Removed legacy source-managed ${label} artifact: ${relPath} — this is a reserved devpro-owned name; if this path was your own, restore it with git and rename it.`
      );
    } catch (err) {
      console.warn(
        `⚠ Failed to prune legacy ${label} artifact ${relPath}: ${err.message} — skipping, sync continues.`
      );
    }
  }
}

async function checkLegacySkillArtifacts(consumerRoot, relPaths, residueMessage) {
  for (const relPath of relPaths) {
    if (await nodeExists(path.join(consumerRoot, relPath))) {
      throw new Error(`Out of sync: ${residueMessage}. Run --sync.`);
    }
  }
}

/**
 * --sync cleanup for the source-owned skill rename:
 * the reusable skill moved from `dp-second-reviewer` to `devpro:second-review`.
 * The runtime subagent/projection remains `dp-second-reviewer`, so this allowlist
 * prunes only the old skill directory and skill symlinks. Recursive sync
 * preserves consumer-local extras by design, so old source-managed skill paths
 * need an explicit fixed allowlist prune. This must handle stale/broken symlinks
 * too, so it uses lstat-based node detection rather than access().
 *
 * Accepted-risk note: these names are reserved devpro-owned skill
 * names. If a consumer repo created its own node under one of these exact
 * paths, --sync will delete it; the loud warning tells the user how to recover.
 */
async function pruneLegacySecondReviewArtifacts(consumerRoot) {
  await pruneLegacySkillArtifacts(
    consumerRoot,
    LEGACY_SECOND_REVIEW_ARTIFACTS,
    "second-review"
  );
}

/**
 * --check backstop for the old `dp-second-reviewer` skill artifacts.
 * Read-only: never deletes residue. Uses lstat so stale old skill symlinks are
 * still detected even when their target no longer exists.
 */
async function checkLegacySecondReviewArtifacts(consumerRoot) {
  await checkLegacySkillArtifacts(
    consumerRoot,
    LEGACY_SECOND_REVIEW_ARTIFACTS,
    "legacy dp-second-reviewer artifact residue present"
  );
}

/**
 * --sync cleanup for source-owned rule-governance skill consolidation:
 * `dp-rule-audit` and `dp-convergence-loop` moved under `devpro:rule-governance`.
 * Recursive sync preserves consumer-local extras by design, so the retired
 * source-managed skill directories and discovery symlinks need this fixed
 * allowlist prune.
 */
async function pruneLegacyRuleGovernanceSkillArtifacts(consumerRoot) {
  await pruneLegacySkillArtifacts(
    consumerRoot,
    LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS,
    "rule-governance"
  );
}

/**
 * --check backstop for retired rule-governance split skill artifacts.
 * Read-only: never deletes residue. Uses lstat so stale old skill symlinks are
 * still detected even when their target no longer exists.
 */
async function checkLegacyRuleGovernanceSkillArtifacts(consumerRoot) {
  await checkLegacySkillArtifacts(
    consumerRoot,
    LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS,
    "legacy rule-governance split skill artifact residue present"
  );
}

/**
 * --sync cleanup for the retired `.cursor/skills` discovery root (design
 * D1/D2): `.cursor/skills` is no longer a SKILL_DISCOVERY_DIRS member, so
 * recursive sync (which preserves consumer-local extras by design) will
 * never again touch these twenty source-managed discovery links on its own.
 * This fixed allowlist prune removes them explicitly. Delegates to the same
 * pruneLegacySkillArtifacts() helper as the second-review and rule-governance
 * legacy prunes above — no parallel implementation. lstat-based (via
 * pruneLegacySkillArtifacts()'s nodeExists), so dangling symlinks and
 * Git-backed plain-file residue (e.g. a Windows fallback checkout) are
 * removed the same as a live symlink.
 */
async function pruneLegacyCursorSkillDiscoveryArtifacts(consumerRoot) {
  await pruneLegacySkillArtifacts(
    consumerRoot,
    LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS,
    "cursor skill discovery"
  );
}

/**
 * --check backstop for retired `.cursor/skills` discovery link residue.
 * Read-only: never deletes residue. Uses lstat so a dangling symlink or a
 * Git-backed plain-file residue variant is still detected even when its
 * target no longer exists.
 */
async function checkLegacyCursorSkillDiscoveryArtifacts(consumerRoot) {
  await checkLegacySkillArtifacts(
    consumerRoot,
    LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS,
    "legacy .cursor/skills discovery artifact residue present"
  );
}

function legacySkillEntryManualStep(kind, relPath, status) {
  if (kind === "link") {
    return status === "owned"
      ? `${relPath}: legacy devpro-owned skill discovery link. Run --sync to remove it.`
      : `${relPath}: not recognized as a devpro-shipped legacy link (altered target, absolute/junction ` +
        "form, or your own file at this reserved legacy name). If it is devpro's, remove it manually " +
        "with git; if it is yours, rename it away from this reserved legacy skill name.";
  }
  if (status === "owned") {
    return `${relPath}: legacy devpro-owned skill payload file. Run --sync to remove it.`;
  }
  if (status === "modified") {
    return `${relPath}: modified from the devpro-shipped content. Confirm the content, then delete or move it manually.`;
  }
  return `${relPath}: not a regular file (symlink/directory/etc.) at a reserved legacy skill path. Confirm and handle it manually.`;
}

/**
 * design D7 (CHECK_STEPS, first — before validateManagedSkillFilesystem) —
 * read-only fail-closed backstop for legacy per-skill discovery link and
 * payload residue (design D5's LEGACY_SKILL_ENTRY_LINKS /
 * LEGACY_SKILL_PAYLOAD_FILES). Placed ahead of validateManagedSkillFilesystem
 * so an upgraded-but-not-yet-`--sync`ed consumer gets a named exit 30 with
 * "run --sync" as its first manual step, rather than a generic exit 1 from
 * a later filesystem-parity check (RK3).
 */
function currentManagedOutputPaths(managedSkillInventory) {
  return new Set((managedSkillInventory?.outputs ?? []).map((output) => output.relPath));
}

async function checkLegacySkillEntryResidue(consumerRoot, { managedSkillInventory } = {}) {
  const currentOutputPaths = currentManagedOutputPaths(managedSkillInventory);
  const residuePaths = [];
  const manualSteps = [];
  for (const entry of LEGACY_SKILL_ENTRY_LINKS) {
    const status = await classifyLegacySkillEntryLink(consumerRoot, entry.path);
    if (status === "absent") continue;
    residuePaths.push(entry.path);
    manualSteps.push(legacySkillEntryManualStep("link", entry.path, status));
  }
  for (const entry of LEGACY_SKILL_PAYLOAD_FILES) {
    // design D5 — a path in this fixed allowlist that the CURRENT source
    // manifest still legitimately declares as one of its own managed
    // outputs is never legacy residue: the regular sync/parity machinery
    // already owns it, and this allowlist exists precisely for paths the
    // current manifest no longer declares at all (see the "擴大 FR7 prune
    // 集" rationale in design D5 — retired names, not merely reused ones).
    if (currentOutputPaths.has(entry.path)) continue;
    const status = await classifyLegacySkillPayloadFile(consumerRoot, entry.path);
    if (status === "absent") continue;
    residuePaths.push(entry.path);
    manualSteps.push(legacySkillEntryManualStep("payload", entry.path, status));
  }
  if (residuePaths.length > 0) {
    throw new SkillEntryBlockedError(
      `Out of sync: legacy skill entry residue present (${residuePaths.length} path(s)). Run --sync, or see manual steps.`,
      { reason: "legacy-skill-entry-residue", paths: residuePaths, manualSteps }
    );
  }
}

/**
 * design D8 (SYNC_STEPS, after the pre-existing legacy prunes) — deletes
 * only the fixed LEGACY_SKILL_ENTRY_LINKS paths that classify as "owned"
 * (design D5, F-rase-r1-01). Re-classifies each link immediately before
 * unlinking it ("刪除前重驗") so a link that changed between the earlier
 * classification and this delete pass is never removed on stale evidence.
 * Uses a plain fs.unlink (never fs.rm({recursive})) — these are always
 * links, never directories.
 */
async function pruneLegacySkillEntryLinks(consumerRoot) {
  for (const entry of LEGACY_SKILL_ENTRY_LINKS) {
    const status = await classifyLegacySkillEntryLink(consumerRoot, entry.path);
    if (status === "absent") continue;
    if (status !== "owned") {
      console.warn(`⚠ Keeping ${entry.path}: ${legacySkillEntryManualStep("link", entry.path, status)}`);
      continue;
    }
    const reverified = await classifyLegacySkillEntryLink(consumerRoot, entry.path);
    if (reverified !== "owned") {
      console.warn(`⚠ Skipping ${entry.path}: no longer classifies as owned immediately before delete; leaving in place.`);
      continue;
    }
    const targetPath = path.join(consumerRoot, ...entry.path.split("/"));
    try {
      await fs.unlink(targetPath);
      console.warn(`⚠ Removed legacy skill discovery link: ${entry.path} — replaced by the '${SKILL_ENTRY_NAME}' entry.`);
    } catch (err) {
      console.warn(`⚠ Failed to prune legacy skill link ${entry.path}: ${err.message} — skipping, sync continues.`);
    }
  }
}

/**
 * design D5 — bounds pruneLegacySkillPayload()'s empty-directory cleanup to
 * ONLY the directories that exist solely to hold retired legacy payload
 * (the old `dp-<x>` SSOT dirs and their subdirectories, plus the
 * fully-retired `autonomous-ai-agents`/`documentation`/`templates` roots).
 * Deliberately stops at SKILL_TARGET_ROOT itself and at every directory on
 * the path to a current catalog skill (derived from the managed skill
 * inventory, so a manifest group change cannot drift it) — those remain
 * live catalog groups holding other,
 * non-legacy skills, so attempting rmdir on them would either delete a
 * shared directory that still has content (impossible; ENOTEMPTY protects
 * against that) or, worse, warn every single --sync run once nothing else
 * is left to prune under them (an NFR4 idempotence violation the design
 * explicitly warns against).
 */
function legacyPayloadCleanupDirs(managedSkillInventory) {
  const dirs = new Set();
  const stopPaths = new Set([SKILL_TARGET_ROOT]);
  for (const target of managedSkillInventory?.targets ?? []) {
    let dir = normalizeRelPath(target.relPath);
    while (dir.startsWith(`${SKILL_TARGET_ROOT}/`)) {
      stopPaths.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  for (const entry of LEGACY_SKILL_PAYLOAD_FILES) {
    let dir = path.posix.dirname(entry.path);
    while (dir !== "." && dir !== "/" && !stopPaths.has(dir)) {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return [...dirs].sort(
    (left, right) => right.split("/").length - left.split("/").length || compareRepoPaths(left, right)
  );
}

/**
 * design D8 (SYNC_STEPS, immediately after pruneLegacySkillEntryLinks) —
 * deletes only the fixed LEGACY_SKILL_PAYLOAD_FILES paths that classify as
 * "owned" (design D5, F-rase-r1-02), re-verifying immediately before each
 * unlink. Afterward attempts a non-recursive `fs.rmdir` on each now-possibly-
 * empty legacy directory (deepest first), tolerating ENOTEMPTY by keeping
 * the directory and warning — never a readdir-driven recursive delete
 * (NFR2).
 */
async function pruneLegacySkillPayload(consumerRoot, { managedSkillInventory } = {}) {
  const currentOutputPaths = currentManagedOutputPaths(managedSkillInventory);
  for (const entry of LEGACY_SKILL_PAYLOAD_FILES) {
    // See checkLegacySkillEntryResidue() above — never prune a path the
    // current source manifest still legitimately declares as its own.
    if (currentOutputPaths.has(entry.path)) continue;
    const status = await classifyLegacySkillPayloadFile(consumerRoot, entry.path);
    if (status === "absent") continue;
    if (status !== "owned") {
      console.warn(`⚠ Keeping ${entry.path}: ${legacySkillEntryManualStep("payload", entry.path, status)}`);
      continue;
    }
    const reverified = await classifyLegacySkillPayloadFile(consumerRoot, entry.path);
    if (reverified !== "owned") {
      console.warn(`⚠ Skipping ${entry.path}: no longer classifies as owned immediately before delete; leaving in place.`);
      continue;
    }
    const targetPath = path.join(consumerRoot, ...entry.path.split("/"));
    try {
      await fs.unlink(targetPath);
      console.warn(`⚠ Removed legacy skill payload file: ${entry.path} — moved/renamed under the 2-entry skill topology.`);
    } catch (err) {
      console.warn(`⚠ Failed to prune legacy skill payload ${entry.path}: ${err.message} — skipping, sync continues.`);
    }
  }

  for (const dirRelPath of legacyPayloadCleanupDirs(managedSkillInventory)) {
    // design D8 (T9 scenario-binding finding) — re-check the FULL ancestor chain
    // (through the candidate directory itself, `inclusive: true`) right
    // before rmdir, reusing the same fail-closed judgment
    // classifyLegacySkillPayloadFile() applies to the file it sits under.
    // Without this, an intermediate legacy skill directory replaced by a
    // symlink would let `fs.lstat`/`fs.rmdir` transparently follow it and
    // delete a real, empty directory living entirely outside the catalog.
    const ancestorStatus = await ancestorChainStatus(consumerRoot, dirRelPath, { inclusive: true });
    if (ancestorStatus === "absent") continue;
    if (ancestorStatus === "unsafe") {
      console.warn(
        `⚠ Kept ${dirRelPath}: an ancestor segment is not a real directory (possibly replaced by a symlink); ` +
        "not removed — inspect and handle manually."
      );
      continue;
    }
    const dirPath = path.join(consumerRoot, ...dirRelPath.split("/"));
    try {
      await fs.rmdir(dirPath);
    } catch (err) {
      if (err.code === "ENOTEMPTY") {
        console.warn(`⚠ Kept ${dirRelPath}: not empty after legacy payload prune; inspect and remove any remaining files manually.`);
      } else {
        console.warn(`⚠ Failed to remove empty legacy directory ${dirRelPath}: ${err.message} — skipping.`);
      }
    }
  }
}

/**
 * design D6 (CHECK_STEPS/SYNC_STEPS, right after validateManagedSkillFilesystem)
 * — expected-inventory parity: the consumer's catalog-root entry tree
 * (walked the same way a host discovery scan would, via lint-agent-skills.
 * mjs's collectEntryTreeSkillSet — shared with the source-side lint, not a
 * second copy) must equal exactly the catalog manifest's 20 skill paths,
 * with no stray plugin manifest and no bare SKILL.md at the catalog root.
 */
async function checkSkillEntryInventory(consumerRoot, { managedSkillInventory }) {
  const catalogRootAbs = path.join(consumerRoot, ...SKILL_TARGET_ROOT.split("/"));
  if (!(await exists(catalogRootAbs))) return; // validateManagedSkillFilesystem already fails closed on this.

  const entryTree = await collectEntryTreeSkillSet(catalogRootAbs);
  const expected = managedSkillInventory.targets
    .filter((target) => target.relPath.startsWith(`${SKILL_TARGET_ROOT}/`))
    .map((target) => normalizeRelPath(path.posix.relative(SKILL_TARGET_ROOT, target.relPath)))
    .sort();
  const observed = entryTree.skillDirs.filter((rel) => rel !== "").sort();
  const rootHasSkillMd = entryTree.skillDirs.includes("");
  const strayPluginManifests = entryTree.pluginManifestDirs.filter((rel) => rel !== ".claude-plugin");

  // design D5 — dp-second-reviewer/dp-rule-audit/dp-convergence-loop are
  // already governed by the pre-existing LEGACY_SECOND_REVIEW_ARTIFACTS /
  // LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS allowlists and their own
  // dedicated (later-running) checkLegacy*Artifacts() checks, with their
  // own specific, actionable messages. Defer to them instead of reporting
  // a generic mismatch for the same residue.
  const otherLegacyCatalogDirs = new Set(
    [...LEGACY_SECOND_REVIEW_ARTIFACTS, ...LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS]
      .filter((legacyPath) => legacyPath.startsWith(`${SKILL_TARGET_ROOT}/`))
      .map((legacyPath) => normalizeRelPath(path.posix.relative(SKILL_TARGET_ROOT, legacyPath)))
  );

  const extra = observed.filter((rel) => !expected.includes(rel) && !otherLegacyCatalogDirs.has(rel));
  const missing = expected.filter((rel) => !observed.includes(rel));
  if (!rootHasSkillMd && extra.length === 0 && missing.length === 0 && strayPluginManifests.length === 0) {
    return;
  }

  const isLegacyExtra = (rel) =>
    LEGACY_SKILL_PAYLOAD_FILES.some((file) => file.path.startsWith(`${SKILL_TARGET_ROOT}/${rel}/`));
  const allExtraAreLegacy = extra.length > 0 && extra.every(isLegacyExtra);
  const reason =
    allExtraAreLegacy && missing.length === 0 && strayPluginManifests.length === 0 && !rootHasSkillMd
      ? "legacy-skill-entry-residue"
      : "skill-entry-inventory-mismatch";

  const paths = [
    ...(rootHasSkillMd ? [SKILL_TARGET_ROOT] : []),
    ...extra.map((rel) => `${SKILL_TARGET_ROOT}/${rel}`),
    ...missing.map((rel) => `${SKILL_TARGET_ROOT}/${rel}`),
    ...strayPluginManifests.map((rel) => `${SKILL_TARGET_ROOT}/${rel}`),
  ];
  // F-rase-pr-r1-04 — a legacy dir's SKILL.md survives --sync only when the
  // prune kept it (modified / not-owned) or it is not a shipped path at all,
  // so "Run --sync" is correct only for a file that still classifies owned;
  // anything else gets the same manual step the prune warned with.
  let anyLegacyNeedsManualStep = false;
  const legacyExtraManualStep = async (rel) => {
    const skillRel = `${SKILL_TARGET_ROOT}/${rel}/SKILL.md`;
    if (!LEGACY_SKILL_PAYLOAD_FILES.some((file) => file.path === skillRel)) {
      anyLegacyNeedsManualStep = true;
      return `${skillRel}: not a devpro-shipped file at a legacy skill path. Confirm the content, then delete or move it manually.`;
    }
    const status = await classifyLegacySkillPayloadFile(consumerRoot, skillRel);
    if (status !== "owned") anyLegacyNeedsManualStep = true;
    return legacySkillEntryManualStep("payload", skillRel, status);
  };
  // Each extra gets the step for its own kind, whatever the overall reason:
  // a legacy dir's SKILL.md is never "your own skill" to move.
  const extraManualSteps = [];
  for (const rel of extra) {
    extraManualSteps.push(
      isLegacyExtra(rel)
        ? await legacyExtraManualStep(rel)
        : `${SKILL_TARGET_ROOT}/${rel}: not a devpro catalog skill. Move your own skill under ` +
          ".claude/skills/<own-name> or .agents/skills/<own-name> instead of under " +
          `${SKILL_TARGET_ROOT}/.`
    );
  }
  const manualSteps = [
    ...(rootHasSkillMd ? [`${SKILL_TARGET_ROOT}: must not contain a SKILL.md directly.`] : []),
    ...extraManualSteps,
    ...missing.map((rel) => `${SKILL_TARGET_ROOT}/${rel}: expected by the catalog manifest but missing. Run --sync.`),
    ...strayPluginManifests.map((rel) => `${SKILL_TARGET_ROOT}/${rel}: unexpected plugin manifest location.`),
  ];
  throw new SkillEntryBlockedError(
    `Out of sync: consumer skill entry tree does not match the catalog inventory (${paths.length} path(s)). ` +
      (reason === "legacy-skill-entry-residue" && !anyLegacyNeedsManualStep ? "Run --sync." : "See manual steps."),
    { reason, paths, manualSteps }
  );
}

/**
 * .claude/commands/dp/ is no longer a CLAUDE_SYNC_SUBDIRS entry (the 14
 * /dp:* thin-redirect commands were removed in favor of skill-only
 * invocation, see cross-runtime-parity spec's command-removal Requirement).
 * --sync therefore never re-creates this directory, but a consumer repo that
 * synced before the removal may still have it on disk. Unlike
 * pruneLegacySourceWorkflows() (fixed-file-list existence checks), this
 * removes the directory's own entries via readdir — the readdir target is
 * this single named, retired directory (not an arbitrary unknown location),
 * so it stays within the "fixed allowlist of our own past output" boundary.
 * Once all files are removed, the now-empty dp/ directory itself is removed
 * (still scoped to this one named directory — never a broader rm -rf).
 *
 * Unlike pruneLegacySourceWorkflows(), this deletion does not need a loud
 * warn: provenance here is guaranteed by directory ownership (the whole
 * retired `.claude/commands/dp/` namespace was only ever source-managed),
 * not by filename collision, so there is no accepted-risk trade-off to
 * announce — the existing console.log is sufficient.
 *
 * Residue is assumed to be flat files directly under dp/; if an unexpected
 * subdirectory shows up there, it is conservatively left alone (not
 * recursively deleted) rather than guessing at its provenance.
 *
 * Best-effort: the initial readdir, each fs.rm (per-file), and the final
 * empty-dir removal are each independently try/caught so a failure warns
 * and continues rather than aborting the rest of --sync.
 */
async function pruneLegacyConsumerCommands(consumerRoot) {
  const dpCommandsDir = path.join(consumerRoot, ".claude", "commands", "dp");
  if (!(await exists(dpCommandsDir))) return;

  let entries;
  try {
    entries = await fs.readdir(dpCommandsDir, { withFileTypes: true });
  } catch (err) {
    console.warn(
      `⚠ Failed to read legacy command directory .claude/commands/dp: ${err.message} — skipping, sync continues.`
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relPath = path.join(".claude", "commands", "dp", entry.name);
    try {
      await fs.rm(path.join(consumerRoot, relPath), { force: true });
      console.log(`Removed legacy source-managed command: ${relPath}`);
    } catch (err) {
      console.warn(
        `⚠ Failed to prune legacy command ${relPath}: ${err.message} — skipping, sync continues.`
      );
    }
  }

  try {
    const remaining = await fs.readdir(dpCommandsDir);
    if (remaining.length === 0) {
      await fs.rm(dpCommandsDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(
      `⚠ Failed to prune empty legacy directory .claude/commands/dp: ${err.message} — skipping, sync continues.`
    );
  }
}

/**
 * --check backstop for legacy .claude/commands/dp/ residue (enforce-sync-
 * prune-verification R2, reversing the ROT-premise removal made by archived
 * change 2026-07-05-refactor-legacy-cleanup-into-sync — see decisions.md D1).
 * pruneLegacyConsumerCommands() only runs on --sync, and a --sync invoked
 * through a stale root-path script copy can bypass it entirely; --check must
 * independently fail-closed whenever residue exists, regardless of why
 * --sync's own prune didn't run. Read-only: never deletes anything.
 */
async function checkLegacyConsumerCommands(consumerRoot) {
  const dpCommandsDir = path.join(consumerRoot, ".claude", "commands", "dp");
  if (!(await exists(dpCommandsDir))) return;

  const entries = await fs.readdir(dpCommandsDir, { withFileTypes: true });
  const hasFileEntry = entries.some((entry) => entry.isFile());
  if (hasFileEntry) {
    throw new Error(
      "Out of sync: legacy .claude/commands/dp/ residue present. Run --sync."
    );
  }
}

async function checkCodexConfig(consumerRoot) {
  for (const config of HOOK_JSON_CONFIGS) {
    await checkHooksJsonConfig({
      consumerRoot,
      sourceRelPath: config.sourceRelPath,
      driftLabel: config.driftLabel,
      versionPolicy: config.checkVersionPolicy,
    });
  }
}

async function syncGitattributes(consumerRoot) {
  const managedEntries = await loadGitattributesManagedEntries();
  const target = path.join(consumerRoot, ".gitattributes");
  const current = await readFileOrEmpty(target);
  const updated = mergeGitattributesManagedBlock(current, managedEntries);
  await fs.writeFile(target, updated);
  console.log("Synchronized .gitattributes (devpro-agent-rules managed block)");
}

async function checkGitattributes(consumerRoot) {
  const managedEntries = await loadGitattributesManagedEntries();
  const target = path.join(consumerRoot, ".gitattributes");
  if (!(await exists(target))) {
    throw new Error(
      "Out of sync: .gitattributes is missing devpro-agent-rules gitattributes managed block. " +
      "Run sync-agent-rules.mjs --sync."
    );
  }
  const current = await readFileOrEmpty(target);
  const drift = validateGitattributesManagedBlock(current, managedEntries);
  if (drift) {
    throw new Error(`Out of sync: .gitattributes ${drift}. ${managedBlockRemediation(drift)}`);
  }
}

async function syncGitignore(consumerRoot, { managedSkillInventory }) {
  const baselineEntries = await gitignoreBaselineEntries();
  const managedEntries = [
    ...baselineEntries,
    ...managedSkillGitignoreExceptions(managedSkillInventory),
  ];
  const target = path.join(consumerRoot, ".gitignore");
  const current = await readFileOrEmpty(target);
  const updated = mergeGitignoreManagedBlock(current, baselineEntries, managedEntries);
  await fs.writeFile(target, updated);
  console.log("Synchronized .gitignore (devpro-agent-rules managed block)");
}

async function checkGitignore(consumerRoot, { managedSkillInventory }) {
  const baselineEntries = await gitignoreBaselineEntries();
  const managedEntries = [
    ...baselineEntries,
    ...managedSkillGitignoreExceptions(managedSkillInventory),
  ];
  const target = path.join(consumerRoot, ".gitignore");
  if (!(await exists(target))) {
    throw new Error(
      "Out of sync: .gitignore is missing devpro-agent-rules managed block. " +
      "Run sync-agent-rules.mjs --sync."
    );
  }
  const current = await readFileOrEmpty(target);
  const drift = validateGitignoreManagedBlock(current, baselineEntries, managedEntries);
  if (drift) {
    throw new Error(`Out of sync: .gitignore ${drift}. ${managedBlockRemediation(drift)}`);
  }
}

async function runPipeline(consumerRoot, steps, context, expectedOwner) {
  for (const entry of steps) {
    if (
      typeof entry?.run !== "function" ||
      entry.owner !== expectedOwner ||
      entry.class !== 1 ||
      !/(?:versioned|submodule-delivered)/.test(entry.basis)
    ) {
      throw new Error(`Invalid ${expectedOwner} pipeline classification`);
    }
    await entry.run(consumerRoot, context);
  }
}

/**
 * A-class plan: STATIC_FILES + AGENTS.md consumer paths that currently exist.
 * Read-only (no side effect).
 * Root target is the literal `"AGENTS.md"` only — never AGENTS.local.md
 * (see RESERVED_CONSUMER_BASENAMES) and never an AGENTS* glob.
 */
async function computeAClassPlan(consumerRoot) {
  const relPaths = [...STATIC_FILES.map(({ relPath }) => relPath), "AGENTS.md"];
  const items = [];
  for (const relPath of relPaths) {
    if (await exists(path.join(consumerRoot, relPath))) {
      items.push(relPath);
    }
  }
  return items;
}

/**
 * B-class plan: consumer-side files that exist AND have a source-tree
 * counterpart under SYNC_DIRS / CLAUDE_SYNC_SUBDIRS (i.e. files --sync would
 * have brought in). Consumer-only extras (no source counterpart) are
 * deliberately excluded — they are preserved by omission, never referenced
 * here. Read-only (no side effect).
 */
async function computeBClassPlan(consumerRoot) {
  const items = [];
  // Symlink nodes (e.g. .agents/skills/devpro, and .claude/skills
  // entries) are exclusively D-class's
  // responsibility (see applyDClassRemoval()'s named lstat().isSymbolicLink()
  // removal) — B-class must not also claim them, or applyBClassRemoval()'s
  // removeConsumerFile() (non-recursive fs.rm) would collide with D-class's
  // removal and throw EISDIR on a consumer-owned plain directory at that
  // exact path.
  const skipSymlinkNode = () => {};

  for (const { relPath } of SYNC_DIRS) {
    const srcDir = path.join(getCentralRoot(), relPath);
    const ignoredRelPaths = buildIgnoredRelPaths(relPath);
    await walkSourceFiles(
      srcDir,
      ignoredRelPaths,
      async (sourcePath) => {
        const rel = normalizeRelPath(path.join(relPath, path.relative(srcDir, sourcePath)));
        if (await exists(path.join(consumerRoot, rel))) {
          items.push(rel);
        }
      },
      undefined,
      skipSymlinkNode
    );
  }

  for (const subdir of CLAUDE_SYNC_SUBDIRS) {
    const srcDir = path.join(getCentralRoot(), ".claude", subdir);
    await walkSourceFiles(
      srcDir,
      new Set(),
      async (sourcePath) => {
        const rel = normalizeRelPath(path.join(".claude", subdir, path.relative(srcDir, sourcePath)));
        if (await exists(path.join(consumerRoot, rel))) {
          items.push(rel);
        }
      },
      undefined,
      skipSymlinkNode
    );
  }

  return items;
}

/**
 * C-class plan: merge-injected artifacts that would be reverse-injected
 * (managed block / source hook event keys / statusLine / attribution). Read-only (no side
 * effect) — only reports whether a reversible injection is currently present.
 */
async function computeCClassPlan(consumerRoot) {
  const items = [];

  const gitignorePath = path.join(consumerRoot, ".gitignore");
  const gitignoreContent = await readFileOrEmpty(gitignorePath);
  if (gitignoreContent.includes(GITIGNORE_MANAGED_BEGIN)) {
    items.push(".gitignore (devpro-agent-rules managed block)");
  }

  const sourceSettings = path.join(getCentralRoot(), ".claude", "settings.json");
  if (await exists(sourceSettings)) {
    const targetSettings = path.join(consumerRoot, ".claude", "settings.json");
    const sourceData = await parseSourceJsonFile(sourceSettings);
    const targetData = await readConsumerJsonObject(targetSettings, ".claude/settings.json", "--uninstall");
    const targetHooks = targetData.hooks ?? {};
    const sourceHookKeys = Object.keys(sourceData.hooks ?? {}).filter((key) =>
      Object.prototype.hasOwnProperty.call(targetHooks, key)
    );
    if (sourceHookKeys.length > 0) {
      items.push(`.claude/settings.json hooks: ${sourceHookKeys.join(", ")}`);
    }
    if (typeof sourceData.model === "string" && targetData.model === sourceData.model) {
      items.push(".claude/settings.json model");
    }
    if (sourceData.statusLine && targetData.statusLine) {
      items.push(".claude/settings.json statusLine");
    }
    if (
      isSourceAttributionObject(sourceData.attribution) &&
      JSON.stringify(targetData.attribution) === JSON.stringify(sourceData.attribution)
    ) {
      items.push(".claude/settings.json attribution");
    }
  }

  for (const config of HOOK_JSON_CONFIGS) {
    const sourceHooks = path.join(getCentralRoot(), config.sourceRelPath);
    if (!(await exists(sourceHooks))) continue;
    const targetHooks = path.join(consumerRoot, config.sourceRelPath);
    const sourceData = await parseSourceJsonFile(sourceHooks);
    const targetData = await readConsumerJsonObject(targetHooks, config.sourceRelPath, "--uninstall");
    const targetHooksData = targetData.hooks ?? {};
    const sourceHookKeys = Object.keys(sourceData.hooks ?? {}).filter((key) =>
      Object.prototype.hasOwnProperty.call(targetHooksData, key)
    );
    if (sourceHookKeys.length > 0) {
      items.push(`${config.driftLabel} hooks: ${sourceHookKeys.join(", ")}`);
    }
  }

  return items;
}

/**
 * Best-effort test of whether an already-resolved absolute path (as produced
 * by canonicalizeBestEffort()) is confined to consumerRoot's own
 * `.devpro/agent-skills/` tree. Shared SSOT for both:
 *   - collectDevproSkillSymlinks() (uninstall dry-run/apply classification)
 *   - syncDir()'s onSymlink branch (install-time C1/C3 guards)
 * so "is this our managed skill symlink target" is judged identically on
 * both the install and uninstall side.
 *
 * @param {string} consumerRoot
 * @param {string} resolvedAbsPath — already run through canonicalizeBestEffort()
 * @returns {Promise<boolean>}
 */
async function isConfinedToConsumerSkillsRoot(consumerRoot, resolvedAbsPath) {
  const realConsumerRoot = await fs.realpath(consumerRoot).catch(() => consumerRoot);
  const devproSkillsRoot = path.join(realConsumerRoot, ".devpro", "agent-skills") + path.sep;
  return (resolvedAbsPath + path.sep).startsWith(devproSkillsRoot);
}

/**
 * Scans the active skill discovery directories (.agents/skills,
 * .claude/skills) plus the retired legacy discovery root (.cursor/skills,
 * design D3 — see LEGACY_SKILL_DISCOVERY_DIRS) and returns the repo-relative
 * path of every entry that is BOTH (a) a symbolic link (never followed —
 * lstat only, matching the T7/I2 safety invariant below) AND (b) resolves to
 * a target under this consumerRoot's own `.devpro/agent-skills/` tree, i.e.
 * an artifact this tool itself distributed (see walkSourceFiles' onSymlink
 * recreation branch) — never a consumer-authored symlink pointing elsewhere.
 * The legacy root is included here so `--uninstall` keeps removing
 * devpro-owned `.cursor/skills/<name>` symlinks left over on a consumer that
 * has not yet run `--sync` against the current source, even though install
 * (SKILL_DISCOVERY_DIRS) no longer distributes into it.
 *
 * Safety invariants (must hold for both dry-run and apply, since both call
 * this same helper — see computeDClassPlan()/applyDClassRemoval() (I2)):
 *   a. fs.lstat().isSymbolicLink() only — never exists()/fs.access(), which
 *      follow symlinks and would misclassify a plain file/dir at this exact
 *      path, or silently skip a broken (dangling) symlink.
 *   b. Only symlinks whose target resolves under this consumerRoot's own
 *      `.devpro/agent-skills/` are included. A consumer-authored symlink at
 *      the same path pointing elsewhere is NOT our artifact and MUST be
 *      left alone — removing it would be real consumer data loss. The
 *      target need not actually exist on disk to be recognized as "ours"
 *      (a broken/dangling symlink is classified the same way as a live
 *      one) — see canonicalizeBestEffort() below, which walks up to the
 *      nearest existing ancestor to realpath it (resolving OS-level path
 *      aliasing, e.g. macOS's /tmp -> /private/tmp, /var -> /private/var
 *      symlinks) and only re-appends the possibly-nonexistent remainder
 *      textually, without ever requiring the full target path to exist.
 *      If readlink() itself fails, the entry is left out (skip on doubt).
 *   c. A discovery directory that does not exist yields no entries for that
 *      directory (not an error).
 *
 * @param {string} consumerRoot
 * @returns {Promise<string[]>} repo-relative paths, sorted lexicographically
 */
async function collectDevproSkillSymlinks(consumerRoot) {
  const found = [];

  for (const discoveryDir of [...SKILL_DISCOVERY_DIRS, ...LEGACY_SKILL_DISCOVERY_DIRS]) {
    const discoveryDirAbs = path.join(consumerRoot, discoveryDir);
    const entries = await fs.readdir(discoveryDirAbs, { withFileTypes: true }).catch(() => []);
    // Canonicalize the discovery dir itself (it always exists, since we just
    // successfully read it above) so a *relative* symlink target resolves
    // against the same canonical base as isConfinedToConsumerSkillsRoot()'s
    // realpath'd .devpro/agent-skills/ root (invariant (b) above).
    const realDiscoveryDirAbs = await fs.realpath(discoveryDirAbs).catch(() => discoveryDirAbs);
    for (const entry of entries) {
      const entryAbs = path.join(discoveryDirAbs, entry.name);
      const stats = await fs.lstat(entryAbs).catch(() => null);
      if (!stats?.isSymbolicLink()) continue;

      const linkTarget = await fs.readlink(entryAbs).catch(() => null);
      if (linkTarget == null) continue;

      const resolvedTarget = await canonicalizeBestEffort(path.resolve(realDiscoveryDirAbs, linkTarget));
      const isOurs = await isConfinedToConsumerSkillsRoot(consumerRoot, resolvedTarget);

      if (isOurs) {
        found.push(normalizeRelPath(path.join(discoveryDir, entry.name)));
      }
    }
  }

  found.sort();
  return found;
}

/**
 * Best-effort realpath of an absolute path that may not exist (e.g. a
 * broken/dangling symlink target, or one whose deepest components were
 * never created). Walks up from `absPath` until it finds the nearest
 * existing ancestor, realpath's ONLY that ancestor (so no existence
 * requirement is placed on the rest), then re-joins the original,
 * possibly-nonexistent remainder onto the canonical ancestor. This resolves
 * OS-level path aliasing (e.g. macOS's /tmp -> /private/tmp, /var ->
 * /private/var symlinks) for the purposes of a same-machine prefix
 * comparison, without requiring `absPath` itself to exist. Falls back to
 * the original `absPath` unchanged if even the filesystem root can't be
 * realpath'd (should not happen in practice).
 *
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function canonicalizeBestEffort(absPath) {
  let ancestor = absPath;
  const remainderParts = [];
  while (true) {
    const real = await fs.realpath(ancestor).catch(() => null);
    if (real != null) {
      return remainderParts.length === 0 ? real : path.join(real, ...remainderParts.reverse());
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      // Reached the filesystem root without finding an existing ancestor —
      // give up and return the original path unchanged.
      return absPath;
    }
    remainderParts.push(path.basename(ancestor));
    ancestor = parent;
  }
}

/**
 * D-class plan: non-file side effects (core.hooksPath, submodule, skills
 * symlink). Read-only (no side effect) — only reports whether the current
 * value matches our own footprint.
 */
async function computeDClassPlan(consumerRoot) {
  const items = [];

  const ourHooksPath = resolveAbsoluteHooksPath(consumerRoot);
  const currentHooksPath = runGit("config --get core.hooksPath", { cwd: consumerRoot });
  if (ourHooksPath && currentHooksPath === ourHooksPath) {
    items.push(`core.hooksPath (currently ${currentHooksPath})`);
  }

  const gitmodulesPath = path.join(consumerRoot, ".gitmodules");
  if (await exists(gitmodulesPath)) {
    const gitmodulesContent = await readFileOrEmpty(gitmodulesPath);
    if (gitmodulesContent.includes(".devpro-agent-rules")) {
      items.push("submodule .devpro-agent-rules (deregister)");
    }
  }

  // Same collectDevproSkillSymlinks() scan as applyDClassRemoval() (T7,
  // generalized past the single devpro:workflows name): both sides share one
  // helper so dry-run and apply always agree (I2) on which discovery
  // symlinks are our managed artifacts vs. consumer-owned data.
  const skillSymlinks = await collectDevproSkillSymlinks(consumerRoot);
  for (const relPath of skillSymlinks) {
    items.push(`${relPath} (symlink)`);
  }

  return items;
}

/**
 * computeUninstallPlan(consumerRoot)
 *
 * Pure read-only computation of everything --uninstall would remove,
 * split into the four artifact classes described in
 * openspec/changes/add-uninstall-mode/proposal.md Section 3:
 *   A: whole-file STATIC_FILES + AGENTS.md
 *   B: source-tree-brought files under SYNC_DIRS / CLAUDE_SYNC_SUBDIRS
 *      (consumer-only extras are never included — preserved by omission)
 *   C: merge-injected content (.gitignore managed block, hook event keys,
 *      settings.json model/statusLine/attribution)
 *   D: non-file side effects (core.hooksPath, submodule, skills symlink)
 *
 * MUST NOT have side effects — no delete, no write, no git mutation. Shared
 * SSOT for both the dry-run preview and the apply path (T4-T7 apply the same
 * plan; this function only computes it).
 *
 * @param {string} consumerRoot
 * @returns {Promise<{a: string[], b: string[], c: string[], d: string[]}>}
 */
async function computeUninstallPlan(consumerRoot) {
  const [a, b, c, d] = await Promise.all([
    computeAClassPlan(consumerRoot),
    computeBClassPlan(consumerRoot),
    computeCClassPlan(consumerRoot),
    computeDClassPlan(consumerRoot),
  ]);
  return { a, b, c, d };
}

function printUninstallPlan(plan) {
  console.log("[dry-run] would remove:");
  console.log("");
  console.log(`A. Whole files (${plan.a.length}):`);
  for (const item of plan.a) console.log(`  - ${item}`);
  console.log("");
  console.log(`B. Source-tree-brought files (${plan.b.length}):`);
  for (const item of plan.b) console.log(`  - ${item}`);
  console.log("");
  console.log(`C. Merge-injected content (${plan.c.length}):`);
  for (const item of plan.c) console.log(`  - ${item}`);
  console.log("");
  console.log(`D. Non-file side effects (${plan.d.length}):`);
  for (const item of plan.d) console.log(`  - ${item}`);
}

const IRREVERSIBLE_WARNING = [
  "The following are IRREVERSIBLE by this tool (no undo):",
  "  1. .claude/settings.json / hooks.json event keys that match source keys will be deleted outright",
  "     (any manual edits you made to those specific keys are lost, not just reset).",
  "  2. core.hooksPath will be unset if it currently points at our hooks-git dir",
  "     (its original/prior value, if any, is not restored — it is simply cleared).",
  "  3. Directory extras boundary: only files with a source-tree counterpart are removed;",
  "     this is a best-effort boundary — verify with `git status` before committing.",
].join("\n");

/**
 * One-shot snapshot of every git-tracked path in consumerRoot (a single
 * `git ls-files -z` spawn), replacing the previous per-file
 * `git ls-files --error-unmatch -- <path>` probe in removeConsumerFile()
 * that spawned git once per removed file (350+ spawns per uninstall).
 * NUL-separated (-z) output is unquoted and exact, so unusual filenames
 * survive; entries are POSIX-slash relative paths as git prints them.
 *
 * Fail-open like the probe it replaces: outside a git repo (or on any git
 * failure) the snapshot is empty, every lookup reports "untracked", and the
 * staged-deletion step is skipped — same end state as the old per-file
 * probe returning "".
 *
 * Built once per runUninstall() invocation and passed down (never cached at
 * module level: a second uninstall in the same process must observe index
 * changes made since the first). The only index mutations during A/B-class
 * removal are this uninstall's own staged deletions, and each removed path
 * is consulted exactly once, so the snapshot cannot go stale for the
 * lookups it serves.
 *
 * @param {string} consumerRoot
 * @returns {Set<string>} POSIX-slash relative paths tracked in the index
 */
function loadTrackedPaths(consumerRoot) {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: consumerRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Stage the deletion of already-removed tracked files in one `git rm
 * --cached` spawn per 500-path chunk (index-only; working-tree copies are
 * already gone), replacing the previous per-file spawn in
 * removeConsumerFile() (one git process per removed tracked file — the
 * dominant uninstall cost on repos with hundreds of managed files).
 * Chunked to stay clear of platform argv limits. Order within the batch is
 * irrelevant: every path is an independent index entry.
 *
 * Same strictness as the per-file call it replaces: any git failure
 * propagates via runGitStrict (no partial-success masking).
 *
 * @param {string} consumerRoot
 * @param {string[]} relPaths - tracked paths whose deletion must be staged
 */
function stageTrackedDeletions(consumerRoot, relPaths) {
  const CHUNK = 500;
  for (let i = 0; i < relPaths.length; i += CHUNK) {
    runGitStrict(
      ["rm", "--cached", "--quiet", "--", ...relPaths.slice(i, i + CHUNK)],
      { cwd: consumerRoot }
    );
  }
}

/**
 * Remove a single consumer-side file (A/B class). No-op if missing. If the
 * file is git-tracked in consumerRoot's repo (per the trackedPaths
 * snapshot), record it in stagedOut; the caller flushes the whole batch via
 * stageTrackedDeletions() (index-only; we already removed the working-tree
 * copy ourselves) so `git status` shows a staged deletion rather than an
 * untracked-removal.
 *
 * @param {string} consumerRoot
 * @param {string} relPath
 * @param {Set<string>} trackedPaths - loadTrackedPaths() snapshot
 * @param {string[]} stagedOut - accumulates tracked paths awaiting the batch stage
 */
async function removeConsumerFile(consumerRoot, relPath, trackedPaths, stagedOut) {
  const target = path.join(consumerRoot, relPath);
  if (!(await exists(target))) return;

  await fs.rm(target, { force: true });

  if (trackedPaths.has(normalizeRelPath(relPath))) {
    stagedOut.push(relPath);
  }
  console.log(`Removed ${relPath}`);
}

/**
 * T4 — A-class whole-file removal (STATIC_FILES + AGENTS.md).
 * Removes every path in plan.a (already existence-filtered by
 * computeAClassPlan) and stages the deletion for tracked files.
 *
 * @param {string} consumerRoot
 * @param {string[]} relPaths - plan.a from computeUninstallPlan()
 * @param {Set<string>} trackedPaths - loadTrackedPaths() snapshot
 */
async function applyAClassRemoval(consumerRoot, relPaths, trackedPaths) {
  const staged = [];
  for (const relPath of relPaths) {
    await removeConsumerFile(consumerRoot, relPath, trackedPaths, staged);
  }
  stageTrackedDeletions(consumerRoot, staged);
}

/**
 * T5 — B-class source-tree-brought file removal (plan.b from
 * computeUninstallPlan(), already filtered to files that exist in the
 * consumer AND have a source-tree counterpart — consumer-only extras are
 * never in this list, so they are preserved by omission).
 *
 * 禁 rm -rf：every entry is removed individually via removeConsumerFile();
 * we never recurse-delete a directory. After all files are removed, prune
 * now-empty directories bottom-up (children before parents) so directories
 * that still contain consumer extras are left untouched (fs.rmdir throws on
 * a non-empty dir; the failure is swallowed).
 *
 * @param {string} consumerRoot
 * @param {string[]} relPaths - plan.b from computeUninstallPlan()
 * @param {Set<string>} trackedPaths - loadTrackedPaths() snapshot
 */
async function applyBClassRemoval(consumerRoot, relPaths, trackedPaths) {
  const staged = [];
  for (const relPath of relPaths) {
    await removeConsumerFile(consumerRoot, relPath, trackedPaths, staged);
  }
  stageTrackedDeletions(consumerRoot, staged);

  // Prune now-empty directories, deepest first, so a parent that still has
  // extras (or another untouched subdir) is left alone.
  const dirs = [...new Set(relPaths.map((relPath) => path.dirname(relPath)))]
    .filter((dir) => dir !== ".")
    .sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of dirs) {
    try {
      await fs.rmdir(path.join(consumerRoot, dir));
    } catch {
      // Non-empty (consumer extras remain) or already gone — leave it.
    }
  }
}

/**
 * T6a — .gitignore reverse-injection: strip the devpro-agent-rules managed
 * block, leaving every other line untouched. Reuses the same line-scanning
 * loop as mergeGitignoreManagedBlock() (skip lines inside
 * GITIGNORE_MANAGED_BEGIN/END and baseline-duplicate lines outside the
 * block) but never re-inserts the canonical block.
 *
 * @param {string} consumerRoot
 */
async function reverseGitignoreManagedBlock(consumerRoot) {
  const target = path.join(consumerRoot, ".gitignore");
  const current = await readFileOrEmpty(target);
  if (!current.includes(GITIGNORE_MANAGED_BEGIN)) return;

  const entries = await gitignoreBaselineEntries();
  const baseline = new Set(entries);
  const output = [];
  let inManagedBlock = false;

  for (const line of contentLines(current)) {
    const trimmed = line.trim();
    if (trimmed === GITIGNORE_MANAGED_BEGIN) {
      inManagedBlock = true;
      continue;
    }
    if (inManagedBlock) {
      if (trimmed === GITIGNORE_MANAGED_END) {
        inManagedBlock = false;
      }
      continue;
    }
    if (baseline.has(trimmed)) {
      continue;
    }
    output.push(line);
  }

  trimTrailingBlankLines(output);
  const updated = output.length > 0 ? output.join("\n") + "\n" : "";
  await fs.writeFile(target, updated);
  console.log("Reversed .gitignore managed block");
}

/**
 * T6b — remove source hook event keys (+ statusLine/model/attribution when
 * they match the source value) from consumer .claude/settings.json. Consumer-owned
 * hook event keys and top-level keys are left untouched.
 *
 * @param {string} consumerRoot
 */
async function reverseClaudeSettings(consumerRoot) {
  const sourceSettings = path.join(getCentralRoot(), ".claude", "settings.json");
  if (!(await exists(sourceSettings))) return;

  const targetSettings = path.join(consumerRoot, ".claude", "settings.json");
  if (!(await exists(targetSettings))) return;

  const sourceData = await parseSourceJsonFile(sourceSettings);
  const targetData = await readConsumerJsonObject(targetSettings, ".claude/settings.json", "--uninstall");
  let changed = false;

  if (sourceData.hooks && targetData.hooks) {
    for (const key of Object.keys(sourceData.hooks)) {
      if (Object.prototype.hasOwnProperty.call(targetData.hooks, key)) {
        delete targetData.hooks[key];
        changed = true;
      }
    }
  }
  if (sourceData.statusLine && targetData.statusLine &&
      JSON.stringify(targetData.statusLine) === JSON.stringify(sourceData.statusLine)) {
    delete targetData.statusLine;
    changed = true;
  }
  if (typeof sourceData.model === "string" && targetData.model === sourceData.model) {
    delete targetData.model;
    changed = true;
  }
  if (
    isSourceAttributionObject(sourceData.attribution) &&
    JSON.stringify(targetData.attribution) === JSON.stringify(sourceData.attribution)
  ) {
    delete targetData.attribution;
    changed = true;
  }

  if (!changed) return;
  await fs.writeFile(targetSettings, JSON.stringify(targetData, null, 2) + "\n");
  console.log("Reversed .claude/settings.json (hooks + model + statusLine + attribution)");
}

/**
 * T6c — remove source hook event keys (+ version when it matches the
 * source value, per config.checkVersionPolicy) from consumer
 * .codex/hooks.json / .cursor/hooks.json. Consumer-owned keys are
 * preserved.
 *
 * @param {string} consumerRoot
 */
async function reverseHooksJsonConfigs(consumerRoot) {
  for (const config of HOOK_JSON_CONFIGS) {
    const sourceHooks = path.join(getCentralRoot(), config.sourceRelPath);
    if (!(await exists(sourceHooks))) continue;

    const targetHooks = path.join(consumerRoot, config.sourceRelPath);
    if (!(await exists(targetHooks))) continue;

    const sourceData = await parseSourceJsonFile(sourceHooks);
    const targetData = await readConsumerJsonObject(targetHooks, config.sourceRelPath, "--uninstall");
    let changed = false;

    if (sourceData.hooks && targetData.hooks) {
      for (const key of Object.keys(sourceData.hooks)) {
        if (Object.prototype.hasOwnProperty.call(targetData.hooks, key)) {
          delete targetData.hooks[key];
          changed = true;
        }
      }
    }
    if (
      config.checkVersionPolicy === "must-match-if-number" &&
      typeof sourceData.version === "number" &&
      targetData.version === sourceData.version
    ) {
      delete targetData.version;
      changed = true;
    }

    if (!changed) continue;
    await fs.writeFile(targetHooks, JSON.stringify(targetData, null, 2) + "\n");
    console.log(`Reversed ${config.sourceRelPath} (hooks)`);
  }
}

/**
 * T6 — C-class merge reverse-injection: .gitignore managed block strip +
 * settings.json / hooks.json source-key removal.
 *
 * @param {string} consumerRoot
 */
async function applyCClassRemoval(consumerRoot) {
  await reverseGitignoreManagedBlock(consumerRoot);
  await reverseClaudeSettings(consumerRoot);
  await reverseHooksJsonConfigs(consumerRoot);
}

/**
 * Strict, argv-based git runner for the mutating --uninstall steps (D-class
 * removal + the --git-flow orchestration). Unlike the fail-open runGit
 * (git-utils.mjs) — which swallows every error, including a non-zero exit,
 * and returns "" — this throws on a non-zero exit, so a failed checkout /
 * commit / push / `rm --cached` cannot be silently swallowed and later
 * misreported as success. Args are passed as an array (never interpolated
 * into a shell string), so path-like values cannot break quoting or inject
 * into the command line. Returns trimmed stdout.
 *
 * Use this ONLY where a failure means something is genuinely wrong (the step
 * is expected to succeed). Defensive/probing calls (e.g. "is this path
 * tracked?", "does this branch already exist?", or best-effort residue
 * cleanup where failure is harmless) intentionally keep using the fail-open
 * `runGit`/`runShell` — do not convert those to `runGitStrict`.
 *
 * @param {string[]} args
 * @param {{cwd: string}} opts
 */
function runGitStrict(args, { cwd }) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * T7 — D-class non-file side-effect removal: core.hooksPath unset (only when
 * it currently points at OUR hooks-git dir — fail-open, never touches a
 * consumer-owned value), submodule deregister (.devpro-agent-rules), and
 * generalized removal of every skill discovery symlink (under
 * .agents/skills, .claude/skills, and the retired legacy .cursor/skills root
 * — design D3) that points into this consumer's own .devpro/agent-skills/
 * tree.
 *
 * @param {string} consumerRoot
 */
async function applyDClassRemoval(consumerRoot) {
  // (a) core.hooksPath — unset only when it matches our own footprint.
  const ourHooksPath = resolveAbsoluteHooksPath(consumerRoot);
  const currentHooksPath = runGit("config --get core.hooksPath", { cwd: consumerRoot });
  if (ourHooksPath && currentHooksPath === ourHooksPath) {
    runGitStrict(["config", "--unset", "core.hooksPath"], { cwd: consumerRoot });
    console.log("Unset core.hooksPath");
  }

  // (b) submodule deregister — only when .gitmodules references our submodule.
  const gitmodulesPath = path.join(consumerRoot, ".gitmodules");
  if (await exists(gitmodulesPath)) {
    const gitmodulesContent = await readFileOrEmpty(gitmodulesPath);
    if (gitmodulesContent.includes(".devpro-agent-rules")) {
      runGitStrict(["submodule", "deinit", "-f", "--", ".devpro-agent-rules"], { cwd: consumerRoot });
      runGitStrict(["rm", "-f", "--", ".devpro-agent-rules"], { cwd: consumerRoot });

      // git rm above already rewrites .gitmodules to drop the submodule's
      // section; strip any leftover section defensively (e.g. if git rm left
      // an empty stub) so no residue survives.
      if (await exists(gitmodulesPath)) {
        const remaining = await readFileOrEmpty(gitmodulesPath);
        const strippedLines = [];
        let skipping = false;
        for (const line of contentLines(remaining)) {
          const trimmed = line.trim();
          if (trimmed === '[submodule ".devpro-agent-rules"]') {
            skipping = true;
            continue;
          }
          if (skipping) {
            if (trimmed.startsWith("[")) {
              skipping = false;
            } else {
              continue;
            }
          }
          strippedLines.push(line);
        }
        trimTrailingBlankLines(strippedLines);
        if (strippedLines.length === 0) {
          await fs.rm(gitmodulesPath, { force: true });
          // Defensive/best-effort residue cleanup: by this point `git rm`
          // above may have already dropped .gitmodules from the index, so
          // this `rm --cached` can legitimately fail (nothing left to
          // unstage) — kept on fail-open runGit intentionally, not
          // runGitStrict. `--` pathspec separator retained for hardening.
          runGit('rm --cached --quiet -- ".gitmodules"', { cwd: consumerRoot });
        } else {
          const updated = strippedLines.join("\n") + "\n";
          if (updated !== remaining) {
            await fs.writeFile(gitmodulesPath, updated);
          }
        }
      }
      console.log("Deregistered submodule .devpro-agent-rules");
    }
  }

  // (c) skill discovery symlinks — generalized removal across the active
  // discovery dirs plus the retired legacy root (.agents/skills,
  // .claude/skills, and .cursor/skills — design D3), never just the single
  // devpro:workflows name. Uses the same collectDevproSkillSymlinks()
  // scan as computeDClassPlan() (I2: dry-run and apply MUST agree), which
  // itself is built on fs.lstat (not exists()/fs.access, which follow
  // symlinks) so a broken symlink is still detected, AND so the node's type
  // can be checked before touching it. Only a node that is actually a
  // symlink pointing into this consumer's own .devpro/agent-skills/ tree is
  // removed (our managed artifact); a consumer who happens to have a plain
  // file/directory at that path, or a symlink pointing elsewhere, is NOT our
  // artifact and MUST be left alone — removing it would be real consumer
  // data loss. A missing node is simply absent from the collected list and
  // silently skipped.
  const skillSymlinkRelPaths = await collectDevproSkillSymlinks(consumerRoot);
  for (const skillsSymlinkRelPath of skillSymlinkRelPaths) {
    const skillsSymlink = path.join(consumerRoot, skillsSymlinkRelPath);
    await fs.rm(skillsSymlink, { force: true });

    const tracked = runGit(`ls-files --error-unmatch -- "${skillsSymlinkRelPath}"`, {
      cwd: consumerRoot,
    });
    if (tracked) {
      runGitStrict(["rm", "--cached", "--quiet", "--", skillsSymlinkRelPath], { cwd: consumerRoot });
    }
    console.log(`Removed ${skillsSymlinkRelPath}`);
  }
}

/**
 * Name of the branch this tool creates/reuses for the --git-flow commit.
 */
const UNINSTALL_GIT_FLOW_BRANCH = "chore/remove-devpro-agent-rules";

/**
 * True when `branch` must be refused as the target of the --git-flow
 * orchestration (protected mainline names + any `production-*` release
 * branch). Reuses branch-naming.mjs's PROTECTED_BASE_BRANCHES SSOT
 * (main/master/production/integration) and additionally rejects
 * `production-*` prefixed branches, which are release branches rather than
 * disposable work branches — neither should ever receive a direct commit
 * from this tool. An empty string (detached HEAD / not a git repo) is also
 * refused, fail-closed, since we cannot safely `checkout -b` from there.
 *
 * @param {string} branch
 */
function isGitFlowProtectedBranch(branch) {
  if (!branch) return true;
  return isProtectedBaseBranch(branch) || branch.startsWith("production-");
}

/**
 * The single error message for a refused `--git-flow` run on a
 * protected/mainline branch. Shared by both the early guard in runUninstall()
 * (refuse before any removal) and the guard in runUninstallGitFlow() (refuse
 * at the orchestration entry) so the two intentional defense-in-depth checks
 * emit identical wording without duplicating the string.
 *
 * @param {string} branch
 */
function gitFlowProtectedMessage(branch) {
  return (
    `--git-flow refused: current branch "${branch || "(detached HEAD)"}" is protected/mainline. ` +
    `Check out a work branch first, then re-run --uninstall --git-flow. ` +
    `(This tool never commits directly to main/master/production/integration/production-*.)`
  );
}

/**
 * Build the `gh pr create` body: a summary of what was removed (mirrors
 * printUninstallPlan()'s four classes) plus the three irreversible warnings
 * (IRREVERSIBLE_WARNING) so the reviewer sees them without re-running
 * `--uninstall --dry-run`, plus an explicit note that merging is left to the
 * human reviewer — this tool never merges.
 *
 * @param {{a: string[], b: string[], c: string[], d: string[]}} plan
 */
function buildUninstallPrBody(plan) {
  return [
    "## Summary",
    "Removes devpro-agent-rules governance artifacts installed by `--sync`:",
    `- A. Whole files removed: ${plan.a.length}`,
    `- B. Source-tree-brought files removed: ${plan.b.length}`,
    `- C. Merge-injected content reversed (.gitignore block / settings.json / hooks.json keys): ${plan.c.length}`,
    `- D. Non-file side effects reversed (core.hooksPath / submodule / skills symlink): ${plan.d.length}`,
    "",
    "## Irreversible by this tool",
    IRREVERSIBLE_WARNING,
    "",
    "## Merge",
    "This PR is left for a human to review and merge — `sync-agent-rules.mjs --uninstall` never merges.",
  ].join("\n");
}

/**
 * Build the commit message for the --git-flow orchestration commit. Footer
 * line format is fixed by ai-autonomy.md's GitHub/Git text-artifact footer
 * convention: `Rules: v<AGENTS.md version> · Tool: <tool> · Model: <model>`.
 *
 * @param {{a: string[], b: string[], c: string[], d: string[]}} plan
 * @param {string} rulesVersion - AGENTS.md `版本：X.Y.Z`, captured BEFORE
 *   applyAClassRemoval() deletes the consumer's AGENTS.md (see
 *   runUninstall() call site).
 */
function buildUninstallCommitMessage(plan, rulesVersion) {
  const versionSuffix = rulesVersion ? `v${rulesVersion}` : "unknown";
  return [
    "chore: remove devpro-agent-rules governance rules",
    "",
    `Removes ${plan.a.length} whole file(s), ${plan.b.length} source-tree file(s), ` +
      `reverses ${plan.c.length} merge-injected block(s), and ${plan.d.length} non-file side effect(s) ` +
      "installed by devpro-agent-rules --sync.",
    "",
    "Rules: " + versionSuffix + " · Tool: unknown · Model: unknown",
  ].join("\n");
}

/**
 * T9 — self-contained git-flow orchestration for `--uninstall --git-flow`.
 *
 * MUST be called AFTER applyAClassRemoval/B/C/D have already removed every
 * artifact from the working tree and staged the deletions (git rm --cached),
 * so this function only needs to `git add -A` the remainder (working-tree
 * edits to .gitignore/settings.json/hooks.json made by the C-class reverse
 * merge) and commit.
 *
 * Self-deletion timing note: by the time this function runs, A-class removal
 * has already deleted the consumer's copy of AGENTS.md and D-class removal
 * has deregistered the `.devpro-agent-rules` submodule — which is where THIS
 * running script's own on-disk file lives. That is safe: Node has already
 * fully loaded this module into memory before execution reached this call,
 * so deleting the file backing it does not interrupt the running process —
 * the remaining `git` / `gh` subprocess calls below complete normally.
 *
 * @param {string} consumerRoot
 * @param {{a: string[], b: string[], c: string[], d: string[]}} plan
 * @param {{yes?: boolean, ghRunner?: (file: string, args: string[], options: object) => string}} [options]
 */
async function runUninstallGitFlow(consumerRoot, plan, { yes = false, ghRunner = execFileSync } = {}) {
  const currentBranch = getCurrentBranch(consumerRoot);
  if (isGitFlowProtectedBranch(currentBranch)) {
    throw new Error(gitFlowProtectedMessage(currentBranch));
  }

  if (currentBranch !== UNINSTALL_GIT_FLOW_BRANCH) {
    // runGit is fail-open (returns "" on any error, including a non-zero
    // exit) so `rev-parse --verify` doubles as an existence check: non-empty
    // stdout (the branch's SHA) means the branch already exists locally.
    // This probe is intentionally left on fail-open runGit — a nonexistent
    // branch is an expected, harmless outcome here, not a real error.
    const branchSha = runGit(`rev-parse --verify --quiet ${UNINSTALL_GIT_FLOW_BRANCH}`, {
      cwd: consumerRoot,
    });
    if (branchSha) {
      runGitStrict(["checkout", UNINSTALL_GIT_FLOW_BRANCH], { cwd: consumerRoot });
    } else {
      runGitStrict(["checkout", "-b", UNINSTALL_GIT_FLOW_BRANCH], { cwd: consumerRoot });
    }

    // A failed checkout must never be silently treated as success: verify we
    // actually landed on the expected branch before continuing to mutate.
    const branchAfterCheckout = getCurrentBranch(consumerRoot);
    if (branchAfterCheckout !== UNINSTALL_GIT_FLOW_BRANCH) {
      throw new Error(
        `git checkout did not land on the expected branch (expected "${UNINSTALL_GIT_FLOW_BRANCH}", ` +
          `actual "${branchAfterCheckout || "(detached HEAD)"}").`
      );
    }
  }

  runGitStrict(["add", "-A"], { cwd: consumerRoot });

  const rulesVersion = plan.rulesVersion ?? null;
  const commitMessage = buildUninstallCommitMessage(plan, rulesVersion);
  const commitMessagePath = path.join(os.tmpdir(), `devpro-uninstall-commit-${Date.now()}.txt`);
  await fs.writeFile(commitMessagePath, commitMessage);
  try {
    runGitStrict(["commit", "--quiet", "-F", commitMessagePath], { cwd: consumerRoot });
  } finally {
    await fs.rm(commitMessagePath, { force: true });
  }
  console.log(`Committed removal on branch ${UNINSTALL_GIT_FLOW_BRANCH}`);

  const promptSession = await createPromptSession();
  let pushConfirmed = yes;
  try {
    if (!pushConfirmed && promptSession) {
      pushConfirmed = await askYesNo(
        promptSession,
        `Push ${UNINSTALL_GIT_FLOW_BRANCH} and open a PR?`
      );
    }
  } finally {
    promptSession?.close();
  }

  if (!pushConfirmed) {
    console.log(
      `Committed on ${UNINSTALL_GIT_FLOW_BRANCH}, but did NOT push (needs --yes or interactive confirmation).`
    );
    return;
  }

  runGitStrict(["push", "-u", "origin", UNINSTALL_GIT_FLOW_BRANCH], { cwd: consumerRoot });
  console.log(`Pushed ${UNINSTALL_GIT_FLOW_BRANCH} to origin`);

  const prBody = buildUninstallPrBody(plan);
  const prBodyPath = path.join(os.tmpdir(), `devpro-uninstall-pr-body-${Date.now()}.md`);
  await fs.writeFile(prBodyPath, prBody);
  try {
    // gh pr create is fail-soft by design: the push above already succeeded
    // (the branch is safely on origin), so a `gh` failure here (missing
    // binary, no auth, no network) should degrade to an informational
    // message rather than aborting a run that has otherwise fully succeeded.
    let prUrl = "";
    try {
      prUrl = ghRunner(
        "gh",
        [
          "pr",
          "create",
          "--title",
          "chore: remove devpro-agent-rules governance rules",
          "--body-file",
          prBodyPath,
        ],
        { cwd: consumerRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim();
    } catch {
      prUrl = "";
    }
    if (prUrl) {
      console.log(prUrl);
    } else {
      console.log("Pushed branch, but `gh pr create` did not return a PR URL (see stderr/gh CLI state).");
    }
  } finally {
    await fs.rm(prBodyPath, { force: true });
  }

  // This tool never merges — the PR above is left for a human to review.
}

/**
 * runUninstall(consumerRoot, options)
 *
 * Dispatch target for `--uninstall`. Computes the removal plan via
 * computeUninstallPlan() (shared SSOT with dry-run and apply).
 *
 * dry-run branch: print the plan + irreversible warning, zero side effects.
 * apply branch: confirmation gate (T8), then A/B/C/D removal in order
 * (T4-T7), then (T9) optional --git-flow branch/commit/push/PR orchestration
 * when `gitFlow` is true. The git-flow protected-branch check runs BEFORE
 * any removal so a refusal never leaves a protected branch (main/master/
 * production/integration/production-*) with staged deletions.
 *
 * @param {string} consumerRoot
 * @param {{dryRun?: boolean, yes?: boolean, gitFlow?: boolean, ghRunner?: (file: string, args: string[], options: object) => string}} [options]
 */
async function runUninstall(
  consumerRoot,
  { dryRun = false, yes = false, gitFlow = false, ghRunner = execFileSync } = {}
) {
  const plan = await computeUninstallPlan(consumerRoot);

  if (dryRun) {
    printUninstallPlan(plan);
    console.log("");
    console.log(IRREVERSIBLE_WARNING);
    return;
  }

  if (gitFlow) {
    const currentBranch = getCurrentBranch(consumerRoot);
    if (isGitFlowProtectedBranch(currentBranch)) {
      throw new Error(gitFlowProtectedMessage(currentBranch));
    }
  }

  console.log(IRREVERSIBLE_WARNING);

  const promptSession = await createPromptSession();
  try {
    if (!promptSession) {
      if (!yes) {
        throw new Error(
          "Non-interactive stdin: pass --yes to confirm --uninstall, or run in a TTY session."
        );
      }
    } else {
      const confirmed = yes || (await askYesNo(promptSession, "Proceed with --uninstall (irreversible)?"));
      if (!confirmed) {
        console.log("Aborted --uninstall (no changes made).");
        return;
      }
    }
  } finally {
    promptSession?.close();
  }

  // Capture the rules version BEFORE A-class removal deletes the consumer's
  // AGENTS.md — the --git-flow commit footer needs it and centralRoot is
  // null on a real (non-source-repo) consumer CLI run, so this is the only
  // reachable copy at commit time.
  const rulesVersion = readAgentsMdVersion(consumerRoot);

  const trackedPaths = loadTrackedPaths(consumerRoot);
  await applyAClassRemoval(consumerRoot, plan.a, trackedPaths);
  await applyBClassRemoval(consumerRoot, plan.b, trackedPaths);
  await applyCClassRemoval(consumerRoot);
  await applyDClassRemoval(consumerRoot);

  if (gitFlow) {
    await runUninstallGitFlow(consumerRoot, { ...plan, rulesVersion }, { yes, ghRunner });
  }

  console.log(`consumerRoot=${consumerRoot}`);
}

function rawPipelineStep(run, owner) {
  const basis = owner === "raw-check"
    ? "read-only parity for versioned or submodule-delivered managed state"
    : "versioned or submodule-delivered managed state";
  return Object.freeze({ run, owner, class: 1, basis });
}

const CHECK_STEPS = Object.freeze([
  checkLegacySkillEntryResidue,
  validateManagedSkillFilesystem,
  checkSkillEntryInventory,
  checkClaudeConfig,
  checkDirs,
  checkCodexConfig,
  checkStaticFiles,
  checkExecBitParity,
  checkGitattributes,
  checkGitignore,
  validateManagedSkillGitPersistence,
  checkLegacyConsumerCommands,
  checkLegacySourceWorkflows,
  checkLegacySecondReviewArtifacts,
  checkLegacyRuleGovernanceSkillArtifacts,
  checkLegacyCursorSkillDiscoveryArtifacts,
].map((run) => rawPipelineStep(run, "raw-check")));

const SYNC_STEPS = Object.freeze([
  syncClaudeConfig,
  syncDirs,
  verifySkillEntryInstalled,
  syncCodexConfig,
  syncStaticFiles,
  pruneLegacySourceWorkflows,
  pruneLegacyConsumerCommands,
  pruneLegacySecondReviewArtifacts,
  pruneLegacyRuleGovernanceSkillArtifacts,
  pruneLegacyCursorSkillDiscoveryArtifacts,
  pruneLegacySkillEntryLinks,
  pruneLegacySkillPayload,
  syncGitattributes,
  syncGitignore,
  flushExecBitIndexModes,
  warnExecBitMismatch,
  validateManagedSkillFilesystem,
  checkSkillEntryInventory,
  validateManagedSkillGitPersistence,
].map((run) => rawPipelineStep(run, "raw-sync")));

function managedOutputPathspecs(managedOutputPaths) {
  const managedRoots = new Set();
  const topLevelPaths = new Set();
  for (const relPath of managedOutputPaths) {
    const separator = relPath.indexOf("/");
    if (separator === -1) topLevelPaths.add(relPath);
    else managedRoots.add(relPath.slice(0, separator));
  }
  return [
    ...[...managedRoots].map((relPath) => `:(icase,top,glob)${relPath}/**`),
    ...[...topLevelPaths].map((relPath) => `:(icase,top,literal)${relPath}`),
  ];
}

function caseFoldManagedPath(relPath) {
  return normalizeRelPath(relPath).normalize("NFC").toLowerCase();
}

async function readTrackedManagedPaths(consumerRoot, managedOutputPaths) {
  if (!(await hasGitControlMarkerAtOrAbove(consumerRoot))) return [];
  const rootProbe = spawnGitForPersistence(consumerRoot, ["rev-parse", "--show-toplevel"]);
  if (rootProbe.status !== 0) {
    throw new Error(
      `Unable to inspect tracked managed paths: git rev-parse exited ${rootProbe.status}: ` +
      `${String(rootProbe.stderr || rootProbe.error?.message || rootProbe.stdout || "no diagnostic").trim()}`
    );
  }

  const requestedRoot = await fs.realpath(consumerRoot).catch(() => path.resolve(consumerRoot));
  const reportedRootText = rootProbe.stdout.trim();
  if (!reportedRootText) {
    throw new Error("Unable to inspect tracked managed paths: git returned an empty worktree root");
  }
  const reportedRoot = await fs.realpath(reportedRootText).catch(() => path.resolve(reportedRootText));
  if (reportedRoot !== requestedRoot) {
    throw new Error(
      `Unable to inspect tracked managed paths: consumer root '${requestedRoot}' is inside ` +
      `different Git root '${reportedRoot}'`
    );
  }

  const result = spawnGitForPersistence(consumerRoot, [
    "--no-optional-locks", "ls-files", "-z", "--full-name", "--cached", "--",
    ...managedOutputPathspecs(managedOutputPaths),
  ]);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to inspect tracked managed paths: git ls-files exited ${result.status}: ` +
      `${String(result.stderr || result.error?.message || result.stdout || "no diagnostic").trim()}`
    );
  }
  return (result.stdout ?? "").split("\0").filter(Boolean);
}

async function collectManagedOutputPaths(sourceRoot, consumerRoot, managedSkillInventory) {
  const outputPaths = new Set([
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    ".claude/settings.json",
    ...STATIC_FILES.map(({ relPath }) => relPath),
    ...HOOK_JSON_CONFIGS.map(({ sourceRelPath }) => sourceRelPath),
    ...managedSkillInventory.outputs.map(({ relPath }) => relPath),
    ...LEGACY_SOURCE_WORKFLOW_FILES,
    ...LEGACY_SECOND_REVIEW_ARTIFACTS,
    ...LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS,
    ...LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS,
  ]);
  const managedRoots = [
    ...SYNC_DIRS.map(({ relPath }) => relPath),
    ...CLAUDE_SYNC_SUBDIRS.map((subdir) => `.claude/${subdir}`),
  ];
  for (const relPath of managedRoots) {
    const ignoredRelPaths = buildIgnoredRelPaths(relPath);
    for (const discoveryPath of managedDiscoveryIgnoredRelPaths(relPath, managedSkillInventory)) {
      ignoredRelPaths.add(discoveryPath);
    }
    await walkSourceFiles(
      path.join(sourceRoot, relPath),
      ignoredRelPaths,
      (_sourcePath, relativePath) => outputPaths.add(`${relPath}/${relativePath}`),
      undefined,
      (_sourcePath, relativePath) => outputPaths.add(`${relPath}/${relativePath}`)
    );
  }
  return outputPaths;
}

async function assertNoCaseInsensitiveManagedPathCollisions(
  sourceRoot,
  consumerRoot,
  managedSkillInventory
) {
  if (!(await hasGitControlMarkerAtOrAbove(consumerRoot))) return;

  const managedOutputPaths = await collectManagedOutputPaths(
    sourceRoot,
    consumerRoot,
    managedSkillInventory
  );
  const trackedPaths = await readTrackedManagedPaths(consumerRoot, managedOutputPaths);
  if (trackedPaths.length === 0) return;

  const outputsByFoldedPath = new Map();
  const managedPathsByFoldedParent = new Map();
  for (const managedPath of managedOutputPaths) {
    const folded = caseFoldManagedPath(managedPath);
    const paths = outputsByFoldedPath.get(folded) ?? [];
    paths.push(managedPath);
    outputsByFoldedPath.set(folded, paths);

    const components = folded.split("/");
    for (let index = 1; index < components.length; index++) {
      const parent = components.slice(0, index).join("/");
      const descendants = managedPathsByFoldedParent.get(parent) ?? [];
      descendants.push(managedPath);
      managedPathsByFoldedParent.set(parent, descendants);
    }
  }

  const collisions = [];
  for (const trackedPath of trackedPaths) {
    const foldedTrackedPath = caseFoldManagedPath(trackedPath);
    const candidateManagedPaths = new Set([
      ...(outputsByFoldedPath.get(foldedTrackedPath) ?? []),
      ...(managedPathsByFoldedParent.get(foldedTrackedPath) ?? []),
    ]);
    const components = foldedTrackedPath.split("/");
    for (let index = 1; index < components.length; index++) {
      const ancestor = components.slice(0, index).join("/");
      for (const managedPath of outputsByFoldedPath.get(ancestor) ?? []) {
        candidateManagedPaths.add(managedPath);
      }
    }
    for (const managedPath of candidateManagedPaths) {
      const pathsShareExactCasePrefix = trackedPath.startsWith(`${managedPath}/`)
        || managedPath.startsWith(`${trackedPath}/`);
      if (managedPath !== trackedPath && !pathsShareExactCasePrefix) {
        collisions.push({ managedPath, trackedPath });
      }
    }
  }
  if (collisions.length === 0) return;
  collisions.sort((left, right) => {
    const leftKey = `${left.managedPath}\0${left.trackedPath}`;
    const rightKey = `${right.managedPath}\0${right.trackedPath}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const listed = collisions
    .map(({ managedPath, trackedPath }) => `  source-managed: ${managedPath}\n  tracked consumer: ${trackedPath}`)
    .join("\n");
  throw new Error(
    `Case-insensitive managed-path collision detected; no sync writes were made. ` +
    `Rename or remove the consumer path after preserving its contents, then retry:\n${listed}`
  );
}

// Direct calls that represent a raw-mode behavior lane outside ordinary
// setup/plumbing must be classified here. This makes a newly added diagnostic
// fail the structural guard until its delivery/reachability owner is explicit.
// Each SYNC_STEPS/CHECK_STEPS entry also carries its own class ① owner and
// delivery basis so a nested diagnostic cannot inherit a blanket exemption.
const RAW_MODE_DIRECT_CALL_CLASSIFICATIONS = Object.freeze([
  Object.freeze({
    mode: "runSync",
    call: "resetWriteFileGitProbeMemo",
    owner: "raw-sync",
    class: 1,
    basis: "versioned or submodule-delivered managed state",
  }),
  Object.freeze({
    mode: "runSync",
    call: "resetSourceExecBitPathsMemo",
    owner: "raw-sync",
    class: 1,
    basis: "versioned or submodule-delivered managed state",
  }),
  Object.freeze({
    mode: "runSync",
    call: "resetPendingExecBitRelPaths",
    owner: "raw-sync",
    class: 1,
    basis: "versioned or submodule-delivered managed state",
  }),
  Object.freeze({
    mode: "runSync",
    call: "assertNoCaseInsensitiveManagedPathCollisions",
    owner: "raw-sync",
    class: 1,
    basis: "versioned consumer Git index preflight for managed output paths",
  }),
  Object.freeze({
    mode: "runSync",
    call: "runPipeline",
    owner: "raw-sync",
    class: 1,
    basis: "versioned or submodule-delivered managed state",
  }),
  Object.freeze({
    mode: "runCheck",
    call: "assertNoCaseInsensitiveManagedPathCollisions",
    owner: "raw-check",
    class: 1,
    basis: "versioned consumer Git index preflight for managed output paths",
  }),
  Object.freeze({
    mode: "runCheck",
    call: "runPipeline",
    owner: "raw-check",
    class: 1,
    basis: "read-only parity for versioned or submodule-delivered managed state",
  }),
]);

const MODE_FLAGS = ["--sync", "--check", "--uninstall"];
const UNINSTALL_MODIFIER_FLAGS = ["--dry-run", "--yes", "--git-flow"];
const USAGE =
  "Usage: node sync-agent-rules.mjs [--sync|--check|--uninstall [--dry-run] [--yes] [--git-flow]]";

/**
 * Parse and validate CLI args. Throws with a message naming the offending
 * flag(s) on any invalid combination. Pure (no I/O) so it's easy to reason
 * about / test in isolation.
 *
 * @param {string[]} args
 * @returns {{mode: string, dryRun: boolean, yes: boolean, gitFlow: boolean}}
 */
function parseArgs(args) {
  const valid = new Set([...MODE_FLAGS, ...UNINSTALL_MODIFIER_FLAGS]);
  for (const arg of args) {
    if (!valid.has(arg)) {
      throw new Error(USAGE);
    }
  }

  const modesPresent = MODE_FLAGS.filter((flag) => args.includes(flag));
  if (modesPresent.length > 1) {
    throw new Error(
      `Cannot combine ${modesPresent.join(" and ")}. Choose exactly one of ${MODE_FLAGS.join(", ")}.`
    );
  }
  const mode = modesPresent[0] ?? "--sync";

  const modifiersPresent = UNINSTALL_MODIFIER_FLAGS.filter((flag) => args.includes(flag));
  if (mode !== "--uninstall" && modifiersPresent.length > 0) {
    throw new Error(
      `Cannot combine ${mode} and ${modifiersPresent.join(", ")}. ` +
      `${modifiersPresent.join(", ")} ${modifiersPresent.length > 1 ? "are" : "is"} only valid with --uninstall.`
    );
  }

  return {
    mode,
    dryRun: args.includes("--dry-run"),
    yes: args.includes("--yes"),
    gitFlow: args.includes("--git-flow"),
  };
}

async function runCheck(consumerRoot) {
  const sourceRoot = requireCentralRoot();
  const sourceAgents = path.join(sourceRoot, "AGENTS.md");

  if (!(await exists(sourceAgents))) {
    throw new Error(`Missing source file: ${sourceAgents}`);
  }
  const context = {
    managedSkillInventory: await buildManagedSkillInventory(sourceRoot),
  };
  await assertNoCaseInsensitiveManagedPathCollisions(
    sourceRoot,
    consumerRoot,
    context.managedSkillInventory
  );

  const targetAgents = path.join(consumerRoot, "AGENTS.md");
  const sourceText = await readFileOrEmpty(sourceAgents);
  const targetText = await readFileOrEmpty(targetAgents);
  if (sourceText !== targetText) {
    throw new Error("Out of sync: AGENTS.md differs");
  }
  await runPipeline(consumerRoot, CHECK_STEPS, context, "raw-check");
  console.log("All derived files are in sync");
  console.log(`consumerRoot=${consumerRoot}`);
}

async function runSync(consumerRoot) {
  resetWriteFileGitProbeMemo();
  resetSourceExecBitPathsMemo();
  resetPendingExecBitRelPaths();
  const sourceRoot = requireCentralRoot();
  const sourceAgents = path.join(sourceRoot, "AGENTS.md");

  if (!(await exists(sourceAgents))) {
    throw new Error(`Missing source file: ${sourceAgents}`);
  }
  const context = {
    managedSkillInventory: await buildManagedSkillInventory(sourceRoot),
  };
  await assertNoCaseInsensitiveManagedPathCollisions(
    sourceRoot,
    consumerRoot,
    context.managedSkillInventory
  );

  const targetAgents = path.join(consumerRoot, "AGENTS.md");
  await fs.copyFile(sourceAgents, targetAgents);
  console.log("Synchronized AGENTS.md from .devpro-agent-rules");

  await runPipeline(consumerRoot, SYNC_STEPS, context, "raw-sync");

  console.log(`consumerRoot=${consumerRoot}`);
}

async function main() {
  const args = process.argv.slice(2);
  const { mode, dryRun, yes, gitFlow } = parseArgs(args);

  const consumerRoot = resolveConsumerRoot();

  if (mode === "--uninstall") {
    await runUninstall(consumerRoot, { dryRun, yes, gitFlow });
    return;
  }

  // Root-path re-exec guard (enforce-sync-prune-verification R1): a --sync
  // invoked via the bootstrapped consumer root entrypoint
  // (.devpro/scripts/sync-agent-rules.mjs) may be running a stale in-memory
  // copy of this script — an older version's --sync body can silently miss
  // prune logic added since it was last synced. Transparently re-exec the
  // submodule's own copy so --sync always runs its own latest code. Only
  // applies to --sync (not --check/--uninstall) and never recurses: the
  // submodule copy's scriptRoot basename is normally ".devpro-agent-rules".
  // On Windows, Node may realpath `import.meta.url` through a junction/symlink
  // so basename(scriptRoot) loses `.devpro-agent-rules`; compare realpaths
  // before re-exec to avoid an infinite re-exec loop (demo:20022 dogfood).
  if (mode === "--sync" && path.basename(scriptRoot) !== ".devpro-agent-rules") {
    const submoduleScriptPath = path.join(
      cwd,
      ".devpro-agent-rules",
      ".devpro",
      "scripts",
      "sync-agent-rules.mjs"
    );
    if (existsSync(submoduleScriptPath)) {
      let alreadyOnSubmoduleEntry = false;
      try {
        alreadyOnSubmoduleEntry =
          realpathSync(submoduleScriptPath) === realpathSync(modulePath);
      } catch {
        alreadyOnSubmoduleEntry = false;
      }
      if (!alreadyOnSubmoduleEntry) {
        console.log("↻ Re-executing submodule script…");
        try {
          execFileSync(process.execPath, [submoduleScriptPath, ...process.argv.slice(2)], {
            stdio: "inherit",
          });
          process.exitCode = 0;
        } catch (err) {
          process.exitCode = err.status ?? 1;
        }
        return;
      }
    }
  }

  if (mode === "--check") {
    await runCheck(consumerRoot);
    return;
  }

  await runSync(consumerRoot);
}

// When run as CLI, execute main(); when imported as module, expose internals for testing.
if (isCLI) {
  main().catch((error) => {
    console.error(error.message);
    // design D7 (T9 scenario-binding finding) — SkillEntryBlockedError's own `reason`
    // token (`legacy-skill-entry-residue` / `skill-entry-inventory-mismatch`)
    // was thrown and even asserted on in-process, but never reached stderr:
    // an operator running the CLI never saw the named exit-30 reason the
    // requirement text promises. Printed only when present, so every other
    // error keeps its pre-existing exact stderr shape (no `reason: ` line).
    if (error?.reason) {
      console.error(`reason: ${error.reason}`);
    }
    // design D6/D7 — manualSteps carries the actionable, per-path
    // remediation text (e.g. which reserved legacy name to rename away
    // from, or the exact rollback failure to fix by hand); printing only
    // error.message would leave "see manual steps" with no steps to see.
    for (const step of error?.manualSteps ?? []) {
      console.error(`  - ${step}`);
    }
    // design D7 — SkillEntryBlockedError carries its own exit 30; every
    // other failure keeps the pre-existing exit 1 contract.
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
}

export {
  RESERVED_CONSUMER_BASENAMES,
  CONSUMER_PRE_PR_CHECKS_REL,
  CONSUMER_SECOND_REVIEW_RULES_REL,
  STATIC_FILES,
  SYNC_DIRS,
  CLAUDE_SYNC_SUBDIRS,
  listSyncCommitPaths,
  LEGACY_SOURCE_WORKFLOW_FILES,
  LEGACY_SECOND_REVIEW_ARTIFACTS,
  LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS,
  GITIGNORE_MANAGED_BEGIN,
  GITIGNORE_MANAGED_END,
  GITATTRIBUTES_MANAGED_BEGIN,
  GITATTRIBUTES_MANAGED_END,
  GITATTRIBUTES_MANAGED_ENTRIES,
  deriveGitattributesManagedEntries,
  mergeGitignoreManagedBlock,
  mergeGitattributesManagedBlock,
  validateGitattributesManagedBlock,
  writeFileUnlessSameBytes,
  resetWriteFileGitProbeMemo,
  porcelainXyByPath,
  managedBlockRemediation,
  TEST_SYNC_SOURCE_ROOT_ENV,
  TEST_SYNC_CONSUMER_ROOT_ENV,
  computeUninstallPlan,
  runCheck,
  runSync,
  runUninstall,
  runUninstallGitFlow,
  parseArgs,
  checkLegacyConsumerCommands,
  checkLegacySourceWorkflows,
  checkLegacySecondReviewArtifacts,
  pruneLegacySecondReviewArtifacts,
  checkLegacyRuleGovernanceSkillArtifacts,
  pruneLegacyRuleGovernanceSkillArtifacts,
  LEGACY_CURSOR_SKILL_DISCOVERY_ARTIFACTS,
  LEGACY_SKILL_DISCOVERY_DIRS,
  checkLegacyCursorSkillDiscoveryArtifacts,
  pruneLegacyCursorSkillDiscoveryArtifacts,
  SKILL_TARGET_ROOT,
  SKILL_REFS_ROOT,
  SKILL_ENTRY_NAME,
  SKILL_ENTRY_LINK_TARGET,
  buildManagedSkillInventory,
  managedSkillGitignoreExceptions,
  parseGitCheckIgnoreRecords,
  validateManagedSkillFilesystem,
  validateManagedSkillGitPersistence,
  createMissingGitSymlinkBlob,
  normalizeSymlinkTargetSeparators,
  isMalformedRelativeSymlinkTarget,
  buildIgnoredRelPaths,
  probeCoreSymlinksState,
  isPreferPlainCoreSymlinksState,
  isManagedSkillSymlinkFallbackError,
  CHECK_STEPS,
  SYNC_STEPS,
  RAW_MODE_DIRECT_CALL_CLASSIFICATIONS,
  applyExecBitMode,
  flushExecBitIndexModes,
  assertExecBitParity,
  checkExecBitParity,
  warnExecBitMismatch,
  formatExecBitIndexFailure,
  resolveGitIndexLockPath,
  isReleaseRulesBranch,
  resetPendingExecBitRelPaths,
  resetSourceExecBitPathsMemo,
  classifySourceRepoProbe,
  SkillEntryBlockedError,
  checkLegacySkillEntryResidue,
  pruneLegacySkillEntryLinks,
  pruneLegacySkillPayload,
  checkSkillEntryInventory,
  verifySkillEntryInstalled,
  rollbackCreatedSkillEntries,
  classifyDiscoveryEntryState,
  legacyPayloadCleanupDirs,
};
