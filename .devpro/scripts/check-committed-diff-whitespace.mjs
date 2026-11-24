#!/usr/bin/env node
/**
 * check-committed-diff-whitespace.mjs
 *
 * Blocks whitespace errors in committed diff ranges. This is intentionally a
 * tiny wrapper around `git diff --check` so PR and release flows do not rely on
 * working-tree-only `git diff --check` after the offending content is already
 * committed.
 */

import { spawnSync } from "node:child_process";
import { sortProductionTags } from "./detect-branch-base.mjs";
import { isValidProductionTag } from "./hooks/lib/tag-shapes.mjs";
import { checkRangeWhitespace, checkChangedFilesWhitespace } from "./hooks/lib/whitespace-gate.mjs";

const PRODUCTION_TAG_SHAPES = "production-vX.Y.Z, production-YYYYMMDD[-n] or production-YYYYMMDD-rules[-n]";

function usage() {
  return [
    "Usage:",
    "  node .devpro/scripts/check-committed-diff-whitespace.mjs --base <ref>",
    "  node .devpro/scripts/check-committed-diff-whitespace.mjs --range <range>",
    "  node .devpro/scripts/check-committed-diff-whitespace.mjs --changed-files <base>",
    "  node .devpro/scripts/check-committed-diff-whitespace.mjs --release-main <selected-main-sha>",
    "",
    "Defaults to --base origin/main.",
    "",
    "--base / --range: 3-dot/explicit diff — checks only the lines this PR changed.",
    "--changed-files <base>: full-file whitespace check on every file this PR touched",
    "  (vs <base>), catching pre-existing whitespace errors a 3-dot diff misses.",
    "--release-main <selected-main-sha>: <latest production tag>..<selected-main-sha>",
    `  range (explicit full-main release only; tag shapes: ${PRODUCTION_TAG_SHAPES}).`,
  ].join("\n");
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function isFullCommitSha(value) {
  return /^[0-9a-fA-F]{40}$/.test(value) || /^[0-9a-fA-F]{64}$/.test(value);
}

// The newest production tag of any canonical shape: SemVer in the source repo,
// date or rules-date in a consumer. It is ordered the way release anchor
// detection orders it, so the sweep starts where the last promotion did.
function latestProductionTag() {
  const result = git(["tag", "--list", "production-*"]);
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : result.stderr.trim();
    throw new Error(`failed to list production tags: ${detail}`);
  }
  const tags = result.stdout.split("\n").map((line) => line.trim()).filter(isValidProductionTag);
  const tag = sortProductionTags(tags).at(-1);
  if (!tag) throw new Error(`no production tag found (expected ${PRODUCTION_TAG_SHAPES})`);
  return tag;
}

function parseArgs(argv) {
  let mode = "base";
  let value = "origin/main";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--base") {
      const next = argv[i + 1];
      if (!next) throw new Error("--base requires a ref");
      mode = "base";
      value = next;
      i += 1;
      continue;
    }
    if (arg === "--range") {
      const next = argv[i + 1];
      if (!next) throw new Error("--range requires a git diff range");
      mode = "range";
      value = next;
      i += 1;
      continue;
    }
    if (arg === "--changed-files") {
      const next = argv[i + 1];
      if (!next) throw new Error("--changed-files requires a base ref");
      mode = "changed-files";
      value = next;
      i += 1;
      continue;
    }
    if (arg === "--release-main") {
      const next = argv[i + 1];
      if (!next) throw new Error("--release-main requires the selected main SHA");
      if (!isFullCommitSha(next)) {
        throw new Error("--release-main requires an immutable selected main SHA, not a branch/ref");
      }
      mode = "release-main";
      value = next;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { mode, value };
}

// Resolve the {mode, value} descriptor to a single `git diff --check` range.
// `--release-main` is an explicit selected-main release sweep. Passing the
// selected SHA avoids silently expanding the approved subset when main moves.
// Finite subset releases should pass their assembled release range via --range.
function resolveRange({ mode, value }) {
  if (mode === "base") return `${value}...HEAD`;
  if (mode === "range") return value;
  return `${latestProductionTag()}..${value}`;
}

// Run `git diff --check <range>` once; returns {ok, output, status}. Thin CLI
// wrapper over the shared pure-function lib (hooks/lib/whitespace-gate.mjs) —
// print and process.exit live here, not in the lib.
//
// The lib sets `error` for BOTH a spawn failure (status null) and a non-0/non-2
// git exit (128 bad ref) — that distinction exists so the PUSH HOOK can fail
// open on infra uncertainty. The CLI, however, must preserve its historical
// exit codes unchanged (spec: "--base/--range/--changed-files/--release-main <sha>,
// exit codes 0/1/2 MUST remain unchanged"): a genuine spawn failure (no git
// binary) exits 2, but a git-reported non-zero (128 bad ref, 2 whitespace)
// flows through to main()'s `process.exit(status || 1)`. So only exit-2 here
// when there is NO git status to pass through (status == null → spawn failure).
function checkRange(range) {
  const result = checkRangeWhitespace(range);
  if (result.error && result.status == null) {
    console.error(`Committed diff whitespace gate failed to run: ${result.error}`);
    process.exit(2);
  }
  return result;
}

// --changed-files <base>: list files this PR touched (3-dot name-only), then
// full-file-check each against the empty tree so PRE-EXISTING whitespace errors
// in those files are caught (the 3-dot --base diff would miss them). Thin CLI
// wrapper over the shared pure-function lib — print and process.exit live here.
function runChangedFiles(base) {
  const result = checkChangedFilesWhitespace(base);
  if (result.error) {
    console.error(`Committed diff whitespace gate failed to list changed files: ${result.error}`);
    process.exit(2);
  }

  if (result.files.length === 0) {
    console.log(`Committed diff whitespace gate: pass (no changed files vs ${base})`);
    return;
  }

  if (result.offenders.length > 0) {
    console.error(
      `Committed diff whitespace gate (changed-files full-file vs ${base}) failed:`
    );
    console.error(result.offenders.join("\n"));
    process.exit(1);
  }

  console.log(
    `Committed diff whitespace gate: pass (changed-files full-file, ${result.files.length} file(s) vs ${base})`
  );
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Committed diff whitespace gate: ${err.message}\n\n${usage()}`);
    process.exit(2);
  }

  if (parsed.mode === "changed-files") {
    runChangedFiles(parsed.value);
    return;
  }

  // A missing production tag keeps its historical exit 1, with the reason
  // printed instead of a stack trace.
  let range;
  try {
    range = resolveRange(parsed);
  } catch (err) {
    console.error(`Committed diff whitespace gate: ${err.message}`);
    process.exit(1);
  }
  const { ok, output, status } = checkRange(range);
  if (!ok) {
    console.error(`Committed diff whitespace gate failed for range ${range}:`);
    if (output.trim()) console.error(output.trimEnd());
    process.exit(status || 1);
  }
  console.log(`Committed diff whitespace gate: pass (${range})`);
}

main();
