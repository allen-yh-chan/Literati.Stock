#!/usr/bin/env node
/**
 * Windows checkout preflight for the canonical source-repo suite.
 *
 * A clone can be syntactically clean while still materializing tracked links as
 * ordinary files or converting LF-controlled files to CRLF. The canonical
 * runner must fail closed before spawning a large suite when those checkout
 * invariants are not true. This module only observes state; it never changes
 * Git configuration or the worktree. Win32 additionally checks the effective
 * Git settings that caused the reported fresh-clone failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const WINDOWS_CHECKOUT_PREFLIGHT_PATHS = Object.freeze({
  symlink: ".agents/skills/devpro",
  lf: ".devpro/scripts/hooks-git/pre-push",
});

const EXPECTED_CONFIG = Object.freeze({
  "core.symlinks": "true",
  "core.autocrlf": "false",
});

const SOURCE_ROOT_MARKERS = Object.freeze([
  ".devpro/scripts/sync-agent-rules.mjs",
  ".devpro/scripts/test-suite-manifest.mjs",
]);
const SYNTHETIC_ROOT_MARKER = ".devpro-synthetic-test-root";
const SYNTHETIC_ROOT_MARKER_BYTES = Buffer.from("devpro-test-fixture-v1");

/**
 * A test may invoke the runner with --root pointing at a synthetic Git repo.
 * Those repos exercise tier routing, not the source checkout contract. Keep
 * the preflight attached to an identifiable source checkout instead of making
 * a fixture fail for files it intentionally does not contain.
 */
export function isCanonicalSourceRepoRoot(
  repoRoot,
  { exists = existsSync } = {},
) {
  return (
    typeof repoRoot === "string" &&
    exists(path.join(repoRoot, ".devpro", "scripts", "sync-agent-rules.mjs")) &&
    exists(path.join(repoRoot, ".devpro", "scripts", "test-suite-manifest.mjs"))
  );
}

/**
 * Identify source roots and the only explicit-root case allowed to bypass the
 * checkout contract. A partial source identity stays on the source route so
 * the preflight can fail closed on missing required files.
 */
export function classifyCheckoutRoot({
  repoRoot,
  runnerRepoRoot,
  explicitRoot = false,
  exists = existsSync,
  lstat = lstatSync,
  readFile = readFileSync,
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) return "ambiguous";

  const resolvedRoot = path.resolve(repoRoot);
  if (
    !explicitRoot ||
    (typeof runnerRepoRoot === "string" &&
      resolvedRoot === path.resolve(runnerRepoRoot))
  ) {
    return "source";
  }

  if (
    SOURCE_ROOT_MARKERS.some((marker) => {
      try {
        return exists(path.join(resolvedRoot, ...marker.split("/")));
      } catch {
        return false;
      }
    })
  ) {
    return "source";
  }

  const markerPath = path.join(resolvedRoot, SYNTHETIC_ROOT_MARKER);
  try {
    const markerStat = lstat(markerPath);
    if (
      markerStat.isFile() &&
      !markerStat.isSymbolicLink() &&
      Buffer.from(readFile(markerPath)).equals(SYNTHETIC_ROOT_MARKER_BYTES)
    ) {
      return "synthetic";
    }
  } catch {
    // An absent, unreadable, or malformed marker is ambiguous, never N/A.
  }
  return "ambiguous";
}

function defaultRunGit(args, { repoRoot }) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function display(value) {
  return String(value ?? "").trim() || "<unset>";
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
 * Evaluate the checkout contract without writing to the checkout.
 *
 * The I/O seams make the platform-specific contract proveable from the POSIX
 * unit suite. `platform` is injectable only for tests; production callers use
 * `process.platform` through the default.
 *
 * @param {{
 *   repoRoot: string,
 *   platform?: string,
 *   runGit?: (args: string[], options: {repoRoot: string}) => {status?: number|null, stdout?: string, stderr?: string, error?: Error|null},
 *   lstat?: typeof lstatSync,
 *   readFile?: typeof readFileSync,
 *   realpath?: typeof realpathSync,
 * }} options
 * @returns {{ok: boolean, skipped: boolean, platform: string, checks: Array<{name: string, ok: boolean, detail: string}>, fixCommands: string[]}}
 */
export function evaluateWindowsCheckoutPreflight({
  repoRoot,
  platform = process.platform,
  runGit = defaultRunGit,
  exists = existsSync,
  lstat = lstatSync,
  readFile = readFileSync,
  realpath = realpathSync,
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new TypeError("repoRoot is required");
  }

  const checks = [];
  const addCheck = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  for (const marker of SOURCE_ROOT_MARKERS) {
    const markerPath = path.join(repoRoot, ...marker.split("/"));
    let markerExists = false;
    try {
      markerExists = exists(markerPath);
    } catch {
      markerExists = false;
    }
    addCheck(
      `source-marker:${marker}`,
      markerExists,
      markerExists ? `${marker} exists` : `${marker} is missing from the source checkout`,
    );
  }

  if (platform === "win32") {
    for (const [key, expected] of Object.entries(EXPECTED_CONFIG)) {
      let result;
      try {
        result = runGit(["config", "--type=bool", "--get", key], { repoRoot });
      } catch (error) {
        result = { status: null, stdout: "", stderr: error.message, error };
      }
      const actual = String(result?.stdout ?? "").trim().toLowerCase();
      const usesGitAutocrlfDefault =
        key === "core.autocrlf" &&
        result?.status === 1 &&
        String(result?.stdout ?? "") === "" &&
        String(result?.stderr ?? "") === "" &&
        result?.error == null;
      const configOk =
        (result?.status === 0 && actual === expected) ||
        (expected === "false" && usesGitAutocrlfDefault);
      addCheck(
        `git-config:${key}`,
        configOk,
        usesGitAutocrlfDefault
          ? "unset; using Git default false"
          : `expected ${expected}, got ${display(actual)}${result?.stderr ? ` (${display(result.stderr)})` : ""}`,
      );
    }
  }

  const symlinkRelative = WINDOWS_CHECKOUT_PREFLIGHT_PATHS.symlink;
  const symlinkPath = path.join(repoRoot, ...symlinkRelative.split("/"));
  const symlinkParentPath = path.dirname(symlinkPath);
  try {
    const resolvedParent = realpath(symlinkParentPath);
    const parentInside = isInsideRepo(repoRoot, resolvedParent);
    addCheck(
      "worktree:symlink-parent",
      parentInside,
      parentInside
        ? `${symlinkRelative} parent resolves inside the checkout`
        : `${symlinkRelative} parent resolves outside the checkout: ${resolvedParent}`,
    );
  } catch (error) {
    addCheck(
      "worktree:symlink-parent",
      false,
      `${symlinkRelative} parent is unresolved: ${error.code ?? error.message}`,
    );
  }

  let stageResult;
  try {
    stageResult = runGit(["ls-files", "--stage", "--", symlinkRelative], {
      repoRoot,
    });
  } catch (error) {
    stageResult = { status: null, stdout: "", stderr: error.message, error };
  }
  const mode = String(stageResult?.stdout ?? "").trim().split(/\s+/u)[0] ?? "";
  addCheck(
    "index:tracked-symlink-mode",
    stageResult?.status === 0 && mode === "120000",
    `${symlinkRelative} index mode is ${display(mode)} (expected 120000)`,
  );

  let linkStat;
  try {
    linkStat = lstat(symlinkPath);
    addCheck(
      "worktree:tracked-symlink",
      linkStat.isSymbolicLink(),
      `${symlinkRelative} is ${linkStat.isSymbolicLink() ? "a symlink" : "not a symlink"}`,
    );
  } catch (error) {
    addCheck(
      "worktree:tracked-symlink",
      false,
      `${symlinkRelative} cannot be inspected: ${error.code ?? error.message}`,
    );
  }

  if (linkStat?.isSymbolicLink?.()) {
    try {
      const resolvedTarget = realpath(symlinkPath);
      addCheck(
        "worktree:symlink-target",
        isInsideRepo(repoRoot, resolvedTarget),
        isInsideRepo(repoRoot, resolvedTarget)
          ? `${symlinkRelative} resolves inside the checkout`
          : `${symlinkRelative} resolves outside the checkout: ${resolvedTarget}`,
      );
    } catch (error) {
      addCheck(
        "worktree:symlink-target",
        false,
        `${symlinkRelative} target is unresolved: ${error.code ?? error.message}`,
      );
    }
  }

  const lfRelative = WINDOWS_CHECKOUT_PREFLIGHT_PATHS.lf;
  const lfPath = path.join(repoRoot, ...lfRelative.split("/"));
  try {
    const bytes = readFile(lfPath);
    const hasCrlf = bytes.includes(Buffer.from("\r\n"));
    addCheck(
      "worktree:lf-controlled-file",
      !hasCrlf,
      hasCrlf
        ? `${lfRelative} contains CRLF bytes`
        : `${lfRelative} contains LF-only bytes`,
    );
  } catch (error) {
    addCheck(
      "worktree:lf-controlled-file",
      false,
      `${lfRelative} cannot be read: ${error.code ?? error.message}`,
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    skipped: false,
    platform,
    checks,
    fixCommands: [
      "git config --local core.symlinks true",
      "git config --local core.autocrlf false",
      "git checkout -- .",
    ],
  };
}

/** Run the preflight and emit an actionable result for the suite runner. */
export function runWindowsCheckoutPreflight(options = {}) {
  const result = evaluateWindowsCheckoutPreflight(options);
  for (const check of result.checks) {
    console.log(
      `[test-suite] checkout-preflight ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`,
    );
  }
  if (result.ok) {
    console.log(`[test-suite] checkout-preflight=pass platform=${result.platform}`);
    return 0;
  }

  console.error(
    `[test-suite] checkout-preflight=FAIL platform=${result.platform}; canonical suite stopped before spawning tests`,
  );
  console.error(
    "[test-suite] repair the checkout (after preserving any uncommitted work), then rerun:",
  );
  for (const command of result.fixCommands) console.error(`[test-suite]   ${command}`);
  console.error(
    "[test-suite] symlink creation may require Windows Developer Mode or Administrator privileges",
  );
  return 1;
}
