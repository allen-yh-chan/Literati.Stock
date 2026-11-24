#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, lstatSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCoreSymlinks, ensureGitHooksPath, inheritedGitLocation } from "./hooks/lib/git-utils.mjs";
import { destinationIdentity, resetDestinationIdentityCache } from "./hooks/lib/operation-target.mjs";
import { probeGitCommonDir } from "./hooks/lib/repo-state-identity.mjs";
import { compareVersions } from "./hooks/lib/version-helpers.mjs";
import { runAutoCompactDiagnostics } from "./runtime-auto-compact-settings.mjs";
import { isDirectCliInvocation } from "./lib/cli-entry.mjs";
import { createPromptSession } from "./lib/prompt-session.mjs";

const GH_MERGE_POLICY_TIMEOUT_MS = 10000;
/** Minimum `@fission-ai/openspec` CLI. Below this, startup must stop and ask the user to upgrade. */
export const OPENSPEC_MIN_VERSION = "1.9.0";

export function parseOpenSpecCliVersion(text) {
  const match = String(text ?? "").match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * Class ② openspec CLI floor. Missing CLI stays a risk (install path is the
 * skill's). A parseable version below `OPENSPEC_MIN_VERSION` is `blocked`:
 * the user must upgrade; this check does not install or bump the CLI.
 */
export function evaluateOpenSpecCliFloor(spawnResult) {
  if (!spawnResult || spawnResult.error || spawnResult.status !== 0) {
    return {
      check: "openspec-cli",
      execution: "skipped",
      outcome: "risk",
      detail: "openspec CLI unavailable; install @fission-ai/openspec before continuing",
    };
  }
  const parsed = parseOpenSpecCliVersion(`${spawnResult.stdout || ""}\n${spawnResult.stderr || ""}`);
  if (!parsed) {
    return {
      check: "openspec-cli",
      execution: "checked",
      outcome: "risk",
      detail: "openspec --version did not yield a parseable semver",
    };
  }
  if (compareVersions(parsed, OPENSPEC_MIN_VERSION) < 0) {
    return {
      check: "openspec-cli",
      execution: "checked",
      outcome: "blocked",
      detail:
        `openspec ${parsed} is below required ${OPENSPEC_MIN_VERSION}; ` +
        "upgrade with `npm install -g @fission-ai/openspec@latest` and re-run `openspec --version` before continuing",
    };
  }
  return {
    check: "openspec-cli",
    execution: "checked",
    outcome: "compliant",
    detail: `openspec ${parsed} meets ${OPENSPEC_MIN_VERSION}`,
  };
}

function runOpenSpecVersion(cwd) {
  return spawnSync("openspec", ["--version"], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandExists(commandName) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const entry of pathEntries) {
    for (const ext of extensions) {
      try {
        accessSync(path.join(entry, commandName + ext), constants.X_OK);
        return true;
      } catch {
        // Try the next PATH entry / extension.
      }
    }
  }
  return false;
}

function runGhForMergePolicy(args, { cwd }) {
  return spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: GH_MERGE_POLICY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function maybeRepairConsumerMergePolicy(promptSession, consumerRoot, options = {}) {
  const commandExistsFn = options.commandExists ?? commandExists;
  const runGh = options.runGh ?? runGhForMergePolicy;
  const risk = (detail, execution = "skipped") => ({
    check: "github-merge-policy",
    execution,
    outcome: "risk",
    detail,
  });

  if (!commandExistsFn("gh")) {
    console.log("Skipped GitHub merge policy update (gh CLI not installed).");
    return risk("gh CLI not installed");
  }

  const viewResult = runGh(
    [
      "repo",
      "view",
      "--json",
      "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission,nameWithOwner",
    ],
    { cwd: consumerRoot }
  );

  let payload = null;
  if (!viewResult.error && viewResult.status === 0) {
    try {
      payload = JSON.parse(viewResult.stdout);
    } catch {
      payload = null;
    }
  }
  const shapeValid =
    payload !== null &&
    typeof payload.mergeCommitAllowed === "boolean" &&
    typeof payload.squashMergeAllowed === "boolean" &&
    typeof payload.rebaseMergeAllowed === "boolean" &&
    typeof payload.viewerPermission === "string" && payload.viewerPermission !== "" &&
    typeof payload.nameWithOwner === "string" && payload.nameWithOwner !== "";
  if (!shapeValid) {
    console.log("Skipped GitHub merge policy update (gh query failed or unavailable).");
    return risk("GitHub merge policy query failed or returned an invalid shape");
  }

  const {
    mergeCommitAllowed,
    squashMergeAllowed,
    rebaseMergeAllowed,
    viewerPermission,
    nameWithOwner,
  } = payload;
  if (mergeCommitAllowed && !squashMergeAllowed && !rebaseMergeAllowed) {
    return {
      check: "github-merge-policy",
      execution: "checked",
      outcome: "compliant",
      detail: "merge commit is enabled; squash and rebase merge are disabled",
    };
  }

  console.log(
    "GitHub merge policy does not match the required target for " +
    `${nameWithOwner}. See git-pr-template-and-merge.md for why repo ` +
    "settings are the only guard for the web UI merge path."
  );

  if (viewerPermission !== "ADMIN") {
    console.log("Skipped GitHub merge policy update (requires repo admin permission).");
    return risk("merge policy is noncompliant; repo admin permission is required");
  }
  if (!promptSession) {
    console.log("Skipped GitHub merge policy update (non-interactive stdin).");
    return risk("merge policy is noncompliant; stdin is non-interactive");
  }

  const shouldApply = await promptSession.ask(
    `Apply recommended GitHub merge policy to ${nameWithOwner} ` +
    "(enable merge commit; disable squash merge and rebase merge)?"
  );
  if (!shouldApply) {
    console.log("Skipped GitHub merge policy update.");
    return risk("merge policy is noncompliant; user declined", "checked");
  }

  const editResult = runGh(
    ["repo", "edit", nameWithOwner, "--enable-merge-commit", "--enable-squash-merge=false", "--enable-rebase-merge=false"],
    { cwd: consumerRoot }
  );
  if (editResult.error || editResult.status !== 0) {
    console.log("Skipped GitHub merge policy update (gh repo edit failed).");
    return risk("GitHub merge policy repair failed", "checked");
  }

  console.log(`Updated GitHub merge policy for ${nameWithOwner} (merge commit enabled; squash/rebase merge disabled).`);
  return {
    check: "github-merge-policy",
    execution: "checked",
    outcome: "repaired",
    detail: "merge commit enabled; squash and rebase merge disabled",
  };
}

function summarizeRuntimeResults(results) {
  const outcomes = results.map((result) => result.outcome);
  const outcome = outcomes.includes("risk")
    ? "risk"
    : outcomes.includes("repaired")
      ? "repaired"
      : outcomes.every((value) => value === "not-applicable")
        ? "not-applicable"
        : "compliant";
  return {
    check: "runtime-auto-compact",
    execution: results.every((result) => result.execution === "skipped") ? "skipped" : "checked",
    outcome,
    detail: results,
  };
}

const LOCAL_EXCLUDE_PATTERNS = [
  "/.worktree/",
  "/notes/tmp/",
  "/notes/cross-review/",
  "/notes/session-pending.md",
  "/openspec/changes/**/admission-records/",
  "/openspec/changes/**/override-ledger/",
  "/openspec/changes/**/lite-scope.md",
  "/openspec/changes/*/plan.md",
];

function readLocalExclude(file) {
  try {
    if (!lstatSync(path.dirname(file)).isDirectory() || !lstatSync(file).isFile()) {
      throw new Error("info/exclude is not a regular file in the common Git directory");
    }
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

function missingLocalExcludes(text) {
  const lines = text.split(/\r?\n/);
  return LOCAL_EXCLUDE_PATTERNS.filter((pattern) => !lines.includes(pattern));
}

async function maybeAddLocalExcludes({ cwd, promptSession }) {
  const result = (outcome, detail, execution = "checked") => ({ check: "local-excludes", execution, outcome, detail });
  if (inheritedGitLocation()) return result("risk", "inherited Git location makes the target ambiguous", "skipped");
  const { identity, root } = destinationIdentity(cwd);
  if (identity === "unknown") return result("risk", "target repository adoption could not be verified", "skipped");
  if (identity !== "non-devpro") return result("not-applicable", "target repository already uses Devpro", "skipped");

  const { ok, commonDir } = probeGitCommonDir(root, { timeoutMs: 2000 });
  if (!ok) return result("risk", "target common Git directory could not be resolved", "skipped");
  const file = path.join(commonDir, "info", "exclude");
  const missing = missingLocalExcludes(readLocalExclude(file));
  if (missing.length === 0) return result("compliant", "Devpro local paths are listed in info/exclude");
  if (!promptSession) return result("risk", "adding Devpro local paths to info/exclude requires consent", "skipped");
  if (!await promptSession.ask(
    `Add ${missing.join(", ")} to ${JSON.stringify(file)}, the info/exclude file shared by all worktrees of this repository?`
  )) {
    return result("risk", "user declined the info/exclude update");
  }

  // Re-read after consent so we append only approved entries still missing.
  const current = readLocalExclude(file);
  const remaining = missingLocalExcludes(current).filter((pattern) => missing.includes(pattern));
  if (remaining.length === 0) return result("compliant", "the requested entries are already in info/exclude");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const separator = current && !current.endsWith("\n") ? eol : "";
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${separator}${remaining.join(eol)}${eol}`);
  return result("repaired", "appended Devpro local paths to info/exclude");
}

const DP_CHANGE_ENVIRONMENT_STAGES = [
  {
    check: "openspec-cli",
    owner: "devpro:change",
    class: 2,
    async run(context) {
      const probe = context.runOpenSpecVersion
        ? context.runOpenSpecVersion(context.cwd)
        : runOpenSpecVersion(context.cwd);
      return evaluateOpenSpecCliFloor(probe);
    },
  },
  {
    check: "local-excludes",
    owner: "devpro:change",
    class: 2,
    run: maybeAddLocalExcludes,
  },
  {
    check: "hooks-path",
    owner: "devpro:change",
    class: 2,
    async run(context) {
      return ensureGitHooksPath({ cwd: context.cwd });
    },
  },
  {
    check: "core-symlinks",
    owner: "devpro:change",
    class: 2,
    async run(context) {
      return ensureCoreSymlinks({ cwd: context.cwd });
    },
  },
  {
    check: "runtime-auto-compact",
    owner: "devpro:change",
    class: 2,
    async run(context) {
      return summarizeRuntimeResults(
        await runAutoCompactDiagnostics(context.promptSession, context.homeDir)
      );
    },
  },
  {
    check: "github-merge-policy",
    owner: "devpro:change",
    class: 2,
    async run(context) {
      return maybeRepairConsumerMergePolicy(context.promptSession, context.cwd);
    },
  },
];

async function runDpChangeEnvironmentChecks(options = {}) {
  resetDestinationIdentityCache();
  const promptSession = options.promptSession === undefined
    ? await createPromptSession()
    : options.promptSession;
  const context = {
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir ?? os.homedir(),
    promptSession,
    runOpenSpecVersion: options.runOpenSpecVersion,
  };
  const stages = options.stages ?? DP_CHANGE_ENVIRONMENT_STAGES;
  const results = [];
  try {
    for (const stage of stages) {
      try {
        const result = await stage.run(context);
        const valid =
          result?.check === stage.check &&
          ["checked", "skipped"].includes(result.execution) &&
          ["compliant", "repaired", "risk", "not-applicable", "blocked"].includes(result.outcome);
        results.push(valid ? result : {
          check: stage.check,
          execution: "skipped",
          outcome: "risk",
          detail: "stage returned an invalid result",
        });
      } catch {
        results.push({
          check: stage.check,
          execution: "skipped",
          outcome: "risk",
          detail: "stage failed",
        });
      }
    }
  } finally {
    if (options.promptSession === undefined) promptSession?.close();
  }
  return results;
}

if (isDirectCliInvocation(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 0 && (args.length !== 1 || args[0] !== "--local-excludes-only")) {
    console.error("Usage: node .devpro/scripts/dp-change-environment-checks.mjs [--local-excludes-only]");
    process.exit(2);
  }
  const stages = args.length
    ? DP_CHANGE_ENVIRONMENT_STAGES.filter(({ check }) => check === "local-excludes")
    : DP_CHANGE_ENVIRONMENT_STAGES;
  runDpChangeEnvironmentChecks({ stages })
    .then((results) => {
      console.log(`devpro:change environment checks: ${JSON.stringify(results)}`);
      const blocked = results.find((result) => result.outcome === "blocked");
      if (blocked) {
        console.error(
          `devpro:change environment blocked (${blocked.check}): ${blocked.detail}`
        );
        process.exit(1);
      }
    })
    .catch(() => {
      console.warn(
        'devpro:change environment checks: [{"check":"environment-entry","execution":"skipped","outcome":"risk","detail":"unexpected failure"}]'
      );
    });
}

export {
  DP_CHANGE_ENVIRONMENT_STAGES,
  maybeRepairConsumerMergePolicy,
  runDpChangeEnvironmentChecks,
  runGhForMergePolicy,
};
