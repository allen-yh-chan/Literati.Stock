#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateMatrix, profileEntries, SUPPORTED_PROFILES } from "./consumer-adoption-matrix.mjs";
import { findConsumerRepoRoot } from "./lib/find-root.mjs";
import {
  CONSUMER_PRE_PR_CHECKS_BASENAME,
  CONSUMER_PRE_PR_CHECKS_LEGACY_REL,
  CONSUMER_PRE_PR_CHECKS_REL,
} from "./lib/consumer-pre-pr-checks.mjs";
import {
  CONSUMER_SECOND_REVIEW_RULES_BASENAME,
  CONSUMER_SECOND_REVIEW_RULES_LEGACY_REL,
  CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS,
  CONSUMER_SECOND_REVIEW_RULES_REL,
  checkConsumerReviewRulesBytes,
} from "./lib/consumer-second-review-rules.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "../..");

function hasFile(root, relPath) {
  return existsSync(path.join(root, relPath));
}

function resolveSourceRoot(repoRoot) {
  const submoduleRoot = path.join(repoRoot, ".devpro-agent-rules");
  const hasSubmoduleSource =
    hasFile(submoduleRoot, "AGENTS.md") &&
    hasFile(submoduleRoot, ".devpro/scripts/sync-agent-rules.mjs");
  return hasSubmoduleSource ? submoduleRoot : repoRoot;
}

function runNode(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function runTool(command, args, cwd, runner = spawnSync) {
  const result = runner(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
    signal: result.signal ?? null,
  };
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function isNetworkSurfaceFailure(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}\n${result.error?.message || ""}`;
  return /error connecting to api\.github\.com|lookup .*api\.github\.com|no such host|check your internet connection|could not resolve host|network/i.test(text);
}

function checkRulesSource(sourceRoot) {
  const missing = [];
  if (!hasFile(sourceRoot, "AGENTS.md")) missing.push("AGENTS.md");
  if (!hasFile(sourceRoot, ".devpro/scripts/sync-agent-rules.mjs")) {
    missing.push(".devpro/scripts/sync-agent-rules.mjs");
  }
  if (!hasFile(sourceRoot, ".devpro/scripts/consumer-adoption-matrix.mjs")) {
    missing.push(".devpro/scripts/consumer-adoption-matrix.mjs");
  }
  return {
    name: "rules source",
    status: missing.length === 0 ? "OK" : "FAIL",
    detail: missing.length === 0
      ? `rules source available at ${sourceRoot}`
      : `missing source files: ${missing.join(", ")}`,
  };
}

function checkOpenSpec(repoRoot, sourceRoot, runner) {
  const cli = runTool("openspec", ["--version"], repoRoot, runner);
  const repoHasOpenSpec = hasFile(repoRoot, "openspec");
  const sourceHasOpenSpec = hasFile(sourceRoot, "openspec");
  const hasAnyOpenSpec = repoHasOpenSpec || sourceHasOpenSpec;
  const cliOk = cli.status === 0;
  const version = firstLine(cli.stdout) || firstLine(cli.stderr) || "version unavailable";
  return {
    name: "openspec",
    status: cliOk && hasAnyOpenSpec ? "OK" : "WARN",
    detail: [
      cliOk ? `cli=${version}` : "cli unavailable",
      `repoOpenSpec=${repoHasOpenSpec ? "present" : "missing"}`,
      `sourceOpenSpec=${sourceHasOpenSpec ? "present" : "missing"}`,
    ].join("; "),
  };
}

function checkGh(repoRoot, runner) {
  const version = runTool("gh", ["--version"], repoRoot, runner);
  if (version.status !== 0) {
    return {
      name: "gh",
      status: "WARN",
      reason: "missing-cli",
      detail: "gh CLI unavailable",
    };
  }

  const auth = runTool("gh", ["auth", "status", "--hostname", "github.com"], repoRoot, runner);
  if (auth.status !== 0) {
    const api = runTool("gh", ["api", "user", "--jq", ".login"], repoRoot, runner);
    if (api.status === 0) {
      return {
        name: "gh",
        status: "OK",
        reason: "auth-ok",
        detail: "gh available; api auth OK",
      };
    }
    if (isNetworkSurfaceFailure(api)) {
      return {
        name: "gh",
        status: "WARN",
        reason: "auth-surface-unavailable",
        detail: "gh available; auth surface unavailable",
      };
    }
  }
  return {
    name: "gh",
    status: auth.status === 0 ? "OK" : "WARN",
    reason: auth.status === 0 ? "auth-ok" : "auth-unavailable",
    detail: auth.status === 0
      ? "gh available; auth status OK"
      : "gh available; auth status unavailable",
  };
}

async function checkProfiles(sourceRoot) {
  try {
    const matrix = await generateMatrix(sourceRoot);
    const counts = SUPPORTED_PROFILES.map((profile) => [
      profile,
      profileEntries(matrix, profile).length,
    ]);
    const empty = counts.filter(([, count]) => count === 0).map(([profile]) => profile);
    return {
      name: "profiles",
      status: empty.length === 0 ? "OK" : "FAIL",
      detail: counts.map(([profile, count]) => `${profile}=${count}`).join("; "),
    };
  } catch (error) {
    return {
      name: "profiles",
      status: "FAIL",
      detail: error.message,
    };
  }
}

// `git submodule status` leads with a space when the checkout matches the gitlink
// recorded by HEAD, `+` when it differs, `-` when it is not initialised and `U` on
// merge conflicts. A pull in a clone that did not run the rules sync (cloud routine,
// teammate, second machine) leaves `+`: git does not move a submodule to the new
// gitlink on its own. Read-only and advisory: anything we cannot read is INFO, never
// a warning, so an unreadable status can neither hide behind nor block a green report.
function checkSubmoduleCheckout(repoRoot, runner) {
  const name = "submodule checkout";
  const result = runTool("git", ["submodule", "status", ".devpro-agent-rules"], repoRoot, runner);
  const marker = result.status === 0 ? result.stdout.charAt(0) : "";
  if (marker === "+" || marker === "-" || marker === "U") {
    return {
      name,
      status: "WARN",
      detail: `.devpro-agent-rules checkout does not match the pointer recorded by HEAD (git submodule status prefix "${marker}")`,
    };
  }
  if (marker === " ") {
    return { name, status: "OK", detail: ".devpro-agent-rules checkout matches the recorded pointer" };
  }
  return { name, status: "INFO", detail: "git submodule status unavailable; checkout alignment not verified" };
}

function checkConsumerReadiness(mode, checks) {
  if (mode !== "consumer") {
    return {
      name: "consumer readiness",
      status: "OK",
      detail: "source mode; consumer readiness aggregate not applicable",
    };
  }

  const requiredNames = ["rules source", "adoption matrix", "profiles", "generated files"];
  const required = checks.filter((check) => requiredNames.includes(check.name));
  const failed = required.filter((check) => check.status === "FAIL");
  if (failed.length > 0) {
    return {
      name: "consumer readiness",
      status: "FAIL",
      detail: `blocking checks: ${failed.map((check) => check.name).join(", ")}`,
    };
  }

  const warnings = checks.filter((check) =>
    ["submodule branch", ".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"].includes(check.name) &&
    check.status === "WARN"
  );
  if (warnings.length > 0) {
    return {
      name: "consumer readiness",
      status: "WARN",
      detail: `review warnings: ${warnings.map((check) => check.name).join(", ")}`,
    };
  }

  return {
    name: "consumer readiness",
    status: "OK",
    detail: "consumer essentials present",
  };
}

function checkHookFile(root, relPath) {
  const fullPath = path.join(root, relPath);
  if (!existsSync(fullPath)) {
    return { name: relPath, status: "WARN", detail: "missing generated hook config" };
  }
  const content = readFileSync(fullPath, "utf8");
  return {
    name: relPath,
    status: content.includes("pre-tool-gate.mjs") ? "OK" : "WARN",
    detail: content.includes("pre-tool-gate.mjs")
      ? "references pre-tool-gate.mjs"
      : "does not reference pre-tool-gate.mjs",
  };
}

const OPENCODE_AGENT_ROLES = [
  "dp-analyst",
  "dp-architect",
  "dp-assistant",
  "dp-explorer",
  "dp-programmer",
  "dp-reviewer",
  "dp-second-reviewer",
];

/** OpenCode CLI source-owned carriers (plugin auto-discover + ESM package + seven role projections). */
function checkOpenCodeCliCarriers(root, toolRunner = spawnSync) {
  const missing = [];
  const pluginRel = ".opencode/plugins/devpro-hooks.js";
  const pluginPkgRel = ".opencode/plugins/package.json";
  if (!hasFile(root, pluginRel)) missing.push(pluginRel);
  // Required for OpenCode to load dependency-free `.js` plugin as ESM.
  if (!hasFile(root, pluginPkgRel)) missing.push(pluginPkgRel);
  for (const role of OPENCODE_AGENT_ROLES) {
    const rel = `.opencode/agent/${role}.md`;
    if (!hasFile(root, rel)) missing.push(rel);
  }
  // V2 re-anchor (R18/T7): probe `opencode2 --version`; the V1 face is carried
  // by the dual export (D13) — a missing V1 binary must report
  // "V1 face unverified" without failing the whole doctor run (no fail-whole).
  const cli2 = runTool("opencode2", ["--version"], root, toolRunner);
  const v2Raw = firstLine(cli2.stdout) || firstLine(cli2.stderr) || "";
  const v2Version = v2Raw.replace(/^opencode2\s+/i, "").trim();
  const v2Note =
    cli2.status === 0
      ? `opencode2=${v2Version || "version unavailable"}`
      : "opencode2 unavailable (carriers still checked on disk)";
  const cliV1 = runTool("opencode", ["--version"], root, toolRunner);
  // W1-CODE-001: the V1 version probe only reports the binary literal — it is
  // NOT V1-face verification. No live V1-face verification mechanism exists
  // (no behavioral probe; harness evidence only), so the face status stays
  // "unverified" in BOTH branches; never present the probe as face proof.
  const v1Literal = cliV1.status === 0
    ? firstLine(cliV1.stdout) || firstLine(cliV1.stderr) || ""
    : "";
  const v1Note =
    cliV1.status === 0
      ? `V1 CLI present (${v1Literal || "version unavailable"}) — V1 face unverified (no live verification mechanism; dual export per V2 docs)`
      : "V1 face unverified (V1 binary not available locally; dual export per V2 docs)";
  return {
    name: "OpenCode CLI carriers",
    status: missing.length === 0 ? "OK" : "WARN",
    detail:
      missing.length === 0
        ? `plugin+package+7 agents present; ${v2Note}; ${v1Note}`
        : `missing: ${missing.join(", ")}; ${v2Note}; ${v1Note}`,
  };
}

/** Desktop remains unsupported/unverified — never treat CLI success as Desktop proof. */
function checkOpenCodeDesktopSurface() {
  return {
    name: "OpenCode Desktop",
    status: "WARN",
    detail:
      "unsupported/unverified — Desktop hook dispatch not proven; do not extrapolate from OpenCode CLI success",
  };
}

function readGitmodulesBranch(repoRoot) {
  const gitmodules = path.join(repoRoot, ".gitmodules");
  if (!existsSync(gitmodules)) return "";
  const content = readFileSync(gitmodules, "utf8");
  const sections = [];
  let current = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      if (current) sections.push(current);
      current = { name: sectionMatch[1], path: "", branch: "" };
      continue;
    }
    if (!current || !line || line.startsWith("#") || line.startsWith(";")) continue;

    const keyValue = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyValue) continue;
    const key = keyValue[1];
    const value = keyValue[2].trim();
    if (key === "path") current.path = value;
    if (key === "branch") current.branch = value.split(/\s+/)[0] || "";
  }
  if (current) sections.push(current);

  const devproSection = sections.find((section) =>
    section.path === ".devpro-agent-rules" || section.name === ".devpro-agent-rules"
  );
  return devproSection?.branch || "";
}

/** Relaxing phrasing tokens (advisory; false positives expected). */
const OVERLAY_RELAXING_TOKENS = Object.freeze([
  "跳過",
  "不用",
  "免",
  "豁免",
  "skip",
  "exempt",
  "不需要",
]);

/** Devpro gate nouns that co-occur with relaxing tokens on one line. */
const OVERLAY_GATE_NOUNS = Object.freeze([
  "security scan",
  "OpenSpec",
  "Ask First",
  "Recap",
  "code review",
  "CodeQL",
  "pre-PR",
  "PR",
  "main",
  "test",
]);

function overlayTokenMatches(line, token) {
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
    return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line);
  }
  if (/^[A-Za-z]/.test(token)) {
    return line.toLowerCase().includes(token.toLowerCase());
  }
  return line.includes(token);
}

function findOverlayRelaxingGateLines(content) {
  const hits = [];
  const lines = String(content || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const hasRelaxing = OVERLAY_RELAXING_TOKENS.some((token) => overlayTokenMatches(line, token));
    if (!hasRelaxing) continue;
    const hasGate = OVERLAY_GATE_NOUNS.some((token) => overlayTokenMatches(line, token));
    if (hasGate) hits.push(i + 1);
  }
  return hits;
}

/**
 * Consumer-only advisory for root AGENTS.local.md.
 * Always INFO for present/absent (+ bytes); optional WARN on co-occurrence — never FAIL.
 */
export function checkAgentsLocalOverlay(repoRoot) {
  const name = "AGENTS.local.md";
  const fullPath = path.join(repoRoot, name);
  if (!existsSync(fullPath)) {
    return [{ name, status: "INFO", detail: "absent" }];
  }

  const content = readFileSync(fullPath, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  const checks = [{ name, status: "INFO", detail: `present; bytes=${bytes}` }];

  const hitLines = findOverlayRelaxingGateLines(content);
  if (hitLines.length > 0) {
    const preview = hitLines.slice(0, 5).join(", ");
    const more = hitLines.length > 5 ? ` (+${hitLines.length - 5} more)` : "";
    checks.push({
      name,
      status: "WARN",
      detail:
        `advisory: possible gate-relaxing phrasing on line(s) ${preview}${more}; ` +
        "see consumer-local-rules.md additive-only (cooperative; not a hard fail)",
    });
  }
  return checks;
}

/**
 * Why a working-tree list that HEAD does not contain will not take effect (staged, ignored, or untracked).
 * `willNot` is the consequence phrase, e.g. "pre-PR will NOT run it".
 */
function describeListMissingFromHead(rel, git, willNot) {
  const staged = git(["ls-files", "--error-unmatch", "--", rel]);
  if (staged.status === 0) {
    return `${rel} is staged but not committed; ${willNot} until it is committed`;
  }
  const ignored = staged.status === 1 ? git(["check-ignore", "-v", "--", rel]) : null;
  if (ignored?.status === 0) {
    const rule = firstLine(ignored.stdout).split("\t")[0] || "unknown rule";
    return `${rel} exists but is ignored by ${rule}; ${willNot} (the list must be committed)`;
  }
  if (ignored?.status === 1) {
    return `${rel} exists but is untracked; ${willNot} until it is committed`;
  }
  return `${rel} is not in HEAD, so ${willNot}; tracking or ignore status cannot be confirmed`;
}

/** Read-only git query for the list checks: a spawn error, a signal or a throw all read as "status unknown" (null). */
function createListGit(repoRoot, toolRunner) {
  return (args) => {
    try {
      const result = runTool("git", args, repoRoot, toolRunner);
      // A signal leaves no exit code; runTool's default of 1 would read as "differs" or "untracked".
      return result.error || result.signal ? { ...result, status: null } : result;
    } catch (error) {
      return { status: null, stdout: "", stderr: "", error };
    }
  };
}

/**
 * Consumer-only, read-only health check for the pre-PR checks file (free-form markdown).
 * Only INFO or WARN — never FAIL, never throws. Only `git` is invoked, with
 * four fixed argv arrays; file content never enters an argument, is never
 * executed, parsed or echoed. HEAD is decided first because pre-PR follows the committed version.
 */
export function checkConsumerPrePrChecks(repoRoot, toolRunner = spawnSync) {
  const name = CONSUMER_PRE_PR_CHECKS_BASENAME;
  const rel = CONSUMER_PRE_PR_CHECKS_REL;
  const info = (detail) => ({ name, status: "INFO", detail });
  const warn = (detail) => ({ name, status: "WARN", detail });
  const git = createListGit(repoRoot, toolRunner);

  try {
    const fullPath = path.join(repoRoot, rel);
    if (!existsSync(fullPath)) {
      return [info("absent; only the working tree was inspected, HEAD was not checked")];
    }

    try {
      readFileSync(fullPath);
    } catch (error) {
      return [warn(`${rel} exists but cannot be read: ${error.message}`)];
    }

    const inHead = git(["ls-tree", "--name-only", "HEAD", "--", rel]);
    if (inHead.status !== 0) {
      return [warn(`${rel} exists but whether it is committed cannot be confirmed (git ls-tree HEAD failed; a repository without any commit lands here)`)];
    }

    if (inHead.stdout.trim() === "") {
      return [warn(describeListMissingFromHead(rel, git, "pre-PR will NOT run it"))];
    }

    const checks = [info("tracked; pre-PR follows the version committed in HEAD")];
    const diff = git(["diff", "--quiet", "HEAD", "--", rel]);
    if (diff.status === 1) {
      checks.push(warn(`${rel} has uncommitted changes relative to HEAD (working-tree content differs, or the path was removed from the index); pre-PR runs the version committed in HEAD, not the working-tree version`));
    } else if (diff.status !== 0) {
      checks.push(warn(`${rel} is committed in HEAD but whether the working tree matches HEAD cannot be confirmed`));
    }

    return checks;
  } catch (error) {
    return [warn(`${rel} check could not complete: ${error.message}`)];
  }
}

/**
 * Consumer-only, read-only health check for the second-review rules file (free-form markdown).
 * Only INFO or WARN — never FAIL, never throws. Only `git` is invoked, with
 * three fixed argv arrays; file content never enters an argument, is never
 * executed and is never echoed. Unlike the pre-PR file, the version that
 * takes effect is the one on a pull request's base commit, so the working-tree
 * versus HEAD comparison is deliberately not made here. Integrity problems come from the
 * builder's own byte check; the regular-file and PII/secret-pattern stops are the builder's alone.
 */
export function checkConsumerSecondReviewRules(repoRoot, toolRunner = spawnSync) {
  const name = CONSUMER_SECOND_REVIEW_RULES_BASENAME;
  const rel = CONSUMER_SECOND_REVIEW_RULES_REL;
  const info = (detail) => ({ name, status: "INFO", detail });
  const warn = (detail) => ({ name, status: "WARN", detail });
  const git = createListGit(repoRoot, toolRunner);

  try {
    const fullPath = path.join(repoRoot, rel);
    if (!existsSync(fullPath)) {
      return [info("absent; only the working tree was inspected, HEAD was not checked")];
    }

    let bytes;
    try {
      bytes = readFileSync(fullPath);
    } catch (error) {
      return [warn(`${rel} exists but cannot be read: ${error.message}`)];
    }

    const inHead = git(["ls-tree", "--name-only", "HEAD", "--", rel]);
    if (inHead.status !== 0) {
      return [warn(`${rel} exists but whether it is committed cannot be confirmed (git ls-tree HEAD failed; a repository without any commit lands here)`)];
    }

    if (inHead.stdout.trim() === "") {
      return [warn(describeListMissingFromHead(rel, git, "second review will NOT apply it"))];
    }

    const checks = [info(`tracked; ${bytes.byteLength} bytes (each pull request applies the version on its base commit)`)];
    for (const code of new Set(checkConsumerReviewRulesBytes(bytes).problems.map((problem) => problem.code))) {
      checks.push(warn(`${code} (${CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS[code]}); the review stops with consumer_review_rules_invalid`));
    }
    return checks;
  } catch (error) {
    return [warn(`${rel} check could not complete: ${error.message}`)];
  }
}

function legacyRenamedFile(rel, renamedRel, what) {
  return {
    rel,
    detail:
      `present but no longer read: the ${what} file is now ${renamedRel}, so this one is silently unused; ` +
      `rename it with git mv ${rel} ${renamedRel} (content can be reused as is; rules sync does not rename it); ` +
      `if ${renamedRel} already exists, merge what you still need into it and delete ${rel}`,
    action: (staleRel) =>
      `Rename the stale ${staleRel} to ${renamedRel} (git mv; advisory, and rules sync does not rename it); if ${renamedRel} already exists, merge what you still need into it and delete ${staleRel}.`,
  };
}

/**
 * Consumer files whose feature was removed. Rules sync never deletes consumer files, so a
 * stale copy would otherwise stay silently ignored. The two pre-markdown list files were renamed, not removed.
 * Advisory only: WARN, never FAIL, and the file content is never read.
 */
const LEGACY_CONSUMER_LOCAL_FILES = Object.freeze([
  {
    rel: ".devpro/cross-model-skip-paths.local",
    detail:
      "present but no longer read: the feature was removed, so every PR now goes through second-opinion review " +
      "unless a built-in exemption applies; delete .devpro/cross-model-skip-paths.local (rules sync does not delete it)",
    action: (rel) => `Delete the stale ${rel} (feature removed; advisory, and rules sync does not delete it).`,
  },
  legacyRenamedFile(CONSUMER_PRE_PR_CHECKS_LEGACY_REL, CONSUMER_PRE_PR_CHECKS_REL, "pre-PR checks"),
  legacyRenamedFile(CONSUMER_SECOND_REVIEW_RULES_LEGACY_REL, CONSUMER_SECOND_REVIEW_RULES_REL, "second-review rules"),
]);

export function checkLegacyConsumerLocalFiles(repoRoot) {
  const checks = [];
  for (const { rel, detail } of LEGACY_CONSUMER_LOCAL_FILES) {
    if (!existsSync(path.join(repoRoot, ...rel.split("/")))) continue;
    checks.push({ name: path.posix.basename(rel), status: "WARN", detail });
  }
  return checks;
}

export async function runDoctor(options = {}) {
  const repoRoot = options.repoRoot || findConsumerRepoRoot(options.cwd || process.cwd());
  const sourceRoot = resolveSourceRoot(repoRoot);
  const mode = sourceRoot === repoRoot ? "source" : "consumer";
  const toolRunner = options.toolRunner || spawnSync;
  const checks = [];

  checks.push({
    name: "mode",
    status: "OK",
    detail: `${mode}; repoRoot=${repoRoot}; sourceRoot=${sourceRoot}`,
  });

  checks.push(checkRulesSource(sourceRoot));

  checks.push({
    name: "node",
    status: "OK",
    detail: process.version,
  });

  checks.push(checkOpenSpec(repoRoot, sourceRoot, toolRunner));
  checks.push(checkGh(repoRoot, toolRunner));

  if (options.consumerSmoke) {
    checks.push({
      name: "consumer smoke",
      status: "OK",
      detail: mode === "source"
        ? "source mode uses the read-only/source-safe doctor path"
        : "consumer-safe/generated-file smoke path is active",
    });
  }

  const matrixScript = path.join(sourceRoot, ".devpro", "scripts", "consumer-adoption-matrix.mjs");
  if (existsSync(matrixScript)) {
    const matrix = runNode(matrixScript, ["--check"], sourceRoot);
    checks.push({
      name: "adoption matrix",
      status: matrix.status === 0 ? "OK" : "FAIL",
      detail: matrix.status === 0
        ? matrix.stdout.trim()
        : (matrix.stderr || matrix.stdout || matrix.error?.message || "matrix check failed").trim(),
    });
  } else {
    checks.push({
      name: "adoption matrix",
      status: "FAIL",
      detail: "missing .devpro/scripts/consumer-adoption-matrix.mjs",
    });
  }

  checks.push(await checkProfiles(sourceRoot));

  if (mode === "consumer") {
    const branch = readGitmodulesBranch(repoRoot);
    checks.push({
      name: "submodule branch",
      status: branch === "production" ? "OK" : "WARN",
      detail: branch ? `.gitmodules branch=${branch}` : ".gitmodules branch not set",
    });
    checks.push(checkSubmoduleCheckout(repoRoot, toolRunner));

    const rootSync = path.join(repoRoot, ".devpro", "scripts", "sync-agent-rules.mjs");
    if (existsSync(rootSync)) {
      const sync = runNode(rootSync, ["--check"], repoRoot);
      checks.push({
        name: "generated files",
        status: sync.status === 0 ? "OK" : "FAIL",
        detail: sync.status === 0
          ? "sync-agent-rules.mjs --check passed"
          : (sync.stderr || sync.stdout || sync.error?.message || "sync check failed").trim(),
      });
    } else {
      checks.push({
        name: "generated files",
        status: "FAIL",
        detail: "missing root .devpro/scripts/sync-agent-rules.mjs; run rules sync",
      });
    }

    // Consumer-facing overlay only: INFO always; advisory WARN never upgrades to FAIL.
    checks.push(...checkAgentsLocalOverlay(repoRoot));
    // Advisory only: INFO/WARN, never FAIL, and kept out of the readiness WARN list.
    checks.push(...checkConsumerPrePrChecks(repoRoot, toolRunner));
    // Same advisory contract; the version that applies is the pull request's base commit, so no HEAD diff.
    checks.push(...checkConsumerSecondReviewRules(repoRoot, toolRunner));
    // Files of removed features that sync will never delete: tell the consumer once.
    checks.push(...checkLegacyConsumerLocalFiles(repoRoot));
  } else {
    checks.push({
      name: "generated files",
      status: "OK",
      detail: "source mode; consumer sync drift check not applicable",
    });
  }

  for (const relPath of [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"]) {
    checks.push(checkHookFile(repoRoot, relPath));
  }

  checks.push(checkOpenCodeCliCarriers(repoRoot, toolRunner));
  checks.push(checkOpenCodeDesktopSurface());

  checks.push(checkConsumerReadiness(mode, checks));

  const failures = checks.filter((check) => check.status === "FAIL");
  const warnings = checks.filter((check) => check.status === "WARN");
  const nextActions = [];
  if (failures.some((check) => check.name === "rules source")) {
    nextActions.push("Initialize or sync .devpro-agent-rules so AGENTS.md and source scripts are available.");
  }
  if (failures.some((check) => check.name === "profiles")) {
    nextActions.push("Run node .devpro-agent-rules/.devpro/scripts/consumer-adoption-matrix.mjs --check from the rules source.");
  }
  if (failures.some((check) => check.name === "generated files")) {
    nextActions.push("Run node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync, then node .devpro/scripts/sync-agent-rules.mjs --check.");
  }
  if (warnings.some((check) => check.name === "openspec")) {
    nextActions.push("Install or initialize OpenSpec before running feature changes that need spec workflow.");
  }
  const ghWarning = warnings.find((check) => check.name === "gh");
  if (ghWarning?.reason === "missing-cli") {
    nextActions.push("Install GitHub CLI before PR, review, or release workflows.");
  } else if (ghWarning?.reason === "auth-unavailable") {
    nextActions.push("Run gh auth login -h github.com before PR, review, or release workflows.");
  } else if (ghWarning?.reason === "auth-surface-unavailable") {
    nextActions.push("Re-run gh auth status -h github.com from a host/network-enabled shell before PR, review, or release workflows.");
  }
  if (warnings.some((check) => check.name === "submodule checkout")) {
    nextActions.push(
      "Run git submodule update --init .devpro-agent-rules to align the checkout with the recorded pointer; do not commit this difference (git add -A would roll the rules version back)."
    );
  }
  if (warnings.some((check) => check.name === "submodule branch")) {
    nextActions.push("Use rules-flow.md to move .devpro-agent-rules tracking to production during the next rules sync.");
  }
  if (warnings.some((check) => check.name.endsWith(".json"))) {
    nextActions.push("Verify runtime hook support for the tools this consumer repo actually uses.");
  }
  if (warnings.some((check) => check.name === "OpenCode Desktop")) {
    nextActions.push(
      "Treat OpenCode Desktop as unsupported/unverified; rely on OpenCode CLI carriers only until Desktop dispatch is proven."
    );
  }
  if (warnings.some((check) => check.name === "OpenCode CLI carriers")) {
    nextActions.push(
      "Sync or restore .opencode/plugins/devpro-hooks.js, .opencode/plugins/package.json, and .opencode/agent/dp-*.md source-owned carriers."
    );
  }
  if (warnings.some((check) => check.name === "AGENTS.local.md")) {
    nextActions.push(
      "Review AGENTS.local.md against consumer-local-rules.md additive-only (advisory; doctor does not fail on this)."
    );
  }
  if (warnings.some((check) => check.name === CONSUMER_PRE_PR_CHECKS_BASENAME)) {
    nextActions.push(
      `Review ${CONSUMER_PRE_PR_CHECKS_REL} against consumer-pre-pr-checks.md §Consumer Pre-PR Checks (advisory; doctor does not fail on this).`
    );
  }
  for (const { rel, action } of LEGACY_CONSUMER_LOCAL_FILES) {
    if (warnings.some((check) => check.name === path.posix.basename(rel))) {
      nextActions.push(action(rel));
    }
  }
  if (nextActions.length === 0) {
    nextActions.push("No blocking adoption action detected.");
  }

  return {
    mode,
    repoRoot,
    sourceRoot,
    checks,
    ok: failures.length === 0,
    nextActions,
  };
}

export function formatReport(report) {
  const lines = [
    `Devpro doctor: ${report.ok ? "OK" : "FAIL"}`,
    `mode=${report.mode}`,
    `repoRoot=${report.repoRoot}`,
    `sourceRoot=${report.sourceRoot}`,
    "",
    "Checks:",
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.status} ${check.name}: ${check.detail}`);
  }
  lines.push("", "Next actions:");
  for (const action of report.nextActions) lines.push(`- ${action}`);
  // Standing, read-only pointer — doctor never runs uninstall itself; this
  // just tells a consumer how to preview/remove the rules cleanly. Consumer
  // mode only: the source repo has nothing installed by --sync to uninstall,
  // and running --uninstall there would hit SOURCE_ROOT_ERROR.
  if (report.mode === "consumer") {
    lines.push(
      "",
      "To remove devpro-agent-rules from this repo: node .devpro/scripts/sync-agent-rules.mjs --uninstall --dry-run (preview), then --uninstall (apply) or --uninstall --git-flow (apply + PR)."
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node .devpro/scripts/devpro-doctor.mjs [--consumer-smoke]");
    return;
  }
  const report = await runDoctor({ repoRoot: defaultRepoRoot, consumerSmoke: args.includes("--consumer-smoke") });
  console.log(formatReport(report));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
