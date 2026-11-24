/**
 * whitespace-gate.mjs
 *
 * Pure-function core shared by `check-committed-diff-whitespace.mjs` (CLI) and
 * `pre-tool-gate.mjs` (push-time PreToolUse hook). Runs `git diff --check`
 * against a committed range or a changed-files-vs-base full-file check and
 * returns a RESULT VALUE.
 *
 * Contract (per `pre-tool-mechanical-gates` spec, "Committed-Diff Whitespace
 * Push Gate" requirement): this module MUST be side-effect-free — no process
 * termination calls, no stdout/stderr printing. Callers own exit-code mapping /
 * printing / block decisions. This keeps the CLI and the hook from drifting —
 * both consume the SAME `git diff --check` logic instead of each implementing
 * their own.
 */

import { spawnSync } from "node:child_process";

// git's canonical empty-tree SHA. Diffing a file against this treats the WHOLE
// file as added, so `git diff --check` flags every whitespace error in it —
// including ones that pre-date this PR (which a 3-dot <base>...HEAD diff misses
// because it only sees lines this PR changed).
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(args, cwd) {
  return spawnSync("git", args, { encoding: "utf8", cwd });
}

/**
 * Run `git diff --check <range>` once.
 *
 * `git diff --check` exit-code convention: 0 = clean, 2 = whitespace error(s)
 * found (a DEFINITE offender), any OTHER non-zero (notably 128 = unresolvable
 * ref / bad range) = an operational error, NOT a whitespace finding. This
 * function distinguishes the two: a status of 2 is a real offender (ok=false,
 * NO error field); a spawn failure or a non-0/non-2 status is infra uncertainty
 * (ok=false, `error` set). Callers that must fail OPEN on infra uncertainty
 * (the push hook) branch on `error`; the CLI wrapper preserves its historical
 * exit code by exiting with `status` regardless.
 *
 * @param {string} range — a git diff range/revspec (e.g. `origin/main...HEAD`)
 * @param {string} [cwd] — directory to run git in (defaults to process.cwd())
 * @returns {{ok: boolean, output: string, status: number|null, error?: string}}
 *   ok=false + error set → the git invocation failed operationally (infra
 *   uncertainty, distinct from a whitespace offender). ok=false + NO error →
 *   a DEFINITE whitespace offender (git exit 2).
 */
export function checkRangeWhitespace(range, cwd = process.cwd()) {
  const result = git(["diff", "--check", range], cwd);
  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  if (result.error) {
    return { ok: false, output, status: null, error: result.error.message };
  }
  // Exit 2 = whitespace offender (blockable). Any other non-zero (128 bad ref,
  // etc.) is an operational error → surface as `error` so hook callers fail open.
  if (result.status !== 0 && result.status !== 2) {
    return {
      ok: false,
      output,
      status: result.status,
      error: output.trim() || `git diff --check exited ${result.status}`,
    };
  }
  return { ok: result.status === 0, output, status: result.status };
}

/**
 * Full-file whitespace check on every file changed vs `base` (3-dot name-only
 * diff to list files, then each file is diffed against the empty tree so
 * PRE-EXISTING whitespace errors are caught too — a 3-dot `base...HEAD` diff
 * would miss lines this PR didn't touch).
 *
 * @param {string} base — base ref (e.g. `origin/main`)
 * @param {string} [cwd] — directory to run git in (defaults to process.cwd())
 * @returns {{ok: boolean, offenders: string[], files: string[], error?: string}}
 *   ok=false + error set means the git invocation itself failed (infra
 *   uncertainty). ok=false + offenders non-empty means a DEFINITE whitespace
 *   violation was found. ok=true means a clean pass (offenders is []).
 */
export function checkChangedFilesWhitespace(base, cwd = process.cwd()) {
  const listed = git(["diff", "--name-only", `${base}...HEAD`], cwd);
  if (listed.error || listed.status !== 0) {
    const detail = listed.error ? listed.error.message : listed.stderr.trim();
    return { ok: false, offenders: [], files: [], error: detail };
  }

  const files = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (files.length === 0) {
    return { ok: true, offenders: [], files: [] };
  }

  const offenders = [];
  for (const file of files) {
    const result = git(["diff", "--check", EMPTY_TREE_SHA, "HEAD", "--", file], cwd);
    if (result.error) {
      return { ok: false, offenders, files, error: result.error.message };
    }
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("").trimEnd();
      offenders.push(output || `${file}: whitespace error`);
    }
  }

  return { ok: offenders.length === 0, offenders, files };
}
