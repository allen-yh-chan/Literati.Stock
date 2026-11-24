#!/usr/bin/env node
/**
 * R8/D8 advisory lint: post-archive review-ledger compactness.
 *
 * Usage: node .devpro/scripts/lint-review-ledger-compactness.mjs <change-path> --base <ref> [--pr <n>]
 *
 * Measures the added-line total of
 *   `git diff --numstat <base>..HEAD -- <change-path>/decisions.md <change-path>/tasks.md`
 * (the pr-sticky lane's per-round ledger carriers) and divides by the
 * review-round sidecar `round_count` for `--pr` (D8 denominator). A missing
 * sidecar or `round_count = 0` counts as 1 round and is flagged
 * `round_count_unavailable` (B3). Threshold: 30 added lines per round —
 * pr-sticky steady state is ~3 lines/round (one decisions.md table row), so
 * 30 is a 10x slack bound that still catches the PR #2407 shape (per-round
 * Round State + Audit Findings Ledger + per-finding D-entries).
 *
 * ALWAYS exit 0: this is an advisory (R8) and MUST NOT be promoted to a
 * blocking check. It prints exactly one status line; the over-threshold line
 * starts with "Review ledger compactness advisory:". Callers (e.g.
 * pre-pr-archive-gate.mjs's pass path) surface stdout verbatim.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { readReviewRoundState } from "./hooks/lib/review-round-budget.mjs";
import { storedOriginIdentity } from "./hooks/lib/git-utils.mjs";

const THRESHOLD_PER_ROUND = 30;

function main() {
  const args = process.argv.slice(2);
  const changePath = args[0] && !args[0].startsWith("--") ? args[0] : "";
  let base = "";
  let pr = "";
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--base") { base = args[i + 1] ?? ""; i += 1; }
    else if (args[i] === "--pr") { pr = args[i + 1] ?? ""; i += 1; }
  }
  if (!changePath || !base) {
    process.stdout.write(
      "Review ledger compactness: skipped (usage: <change-path> --base <ref> [--pr <n>])\n"
    );
    return 0;
  }
  const cwd = process.cwd();
  const rel = path.isAbsolute(changePath) ? path.relative(cwd, changePath) : changePath;
  const relPosix = rel.split(path.sep).join("/");
  const targets = [`${relPosix}/decisions.md`, `${relPosix}/tasks.md`];
  const diff = spawnSync(
    "git",
    ["diff", "--numstat", `${base}..HEAD`, "--", ...targets],
    { cwd, encoding: "utf8" }
  );
  if (diff.error || diff.status !== 0) {
    process.stdout.write(
      `Review ledger compactness: skipped (git diff --numstat failed for base ${base})\n`
    );
    return 0;
  }
  let added = 0;
  for (const line of diff.stdout.split("\n")) {
    // numstat: "<added>\t<deleted>\t<path>"; binary files show "-" and are skipped.
    const match = /^(\d+)\t\d+\t/.exec(line);
    if (match) added += Number(match[1]);
  }
  // D8 denominator: pr-sticky round-budget sidecar round_count. Missing
  // sidecar / round_count 0 / no --pr → count as 1 round, flagged (B3).
  let rounds = 1;
  let roundCountUnavailable = true;
  if (pr) {
    try {
      const origin = storedOriginIdentity(cwd);
      const repositorySlug = origin ? `${origin.host}/${origin.slug}` : "";
      const state = readReviewRoundState({ cwd, prNumber: pr, repositorySlug });
      if (state.exists && state.round_count > 0) {
        rounds = state.round_count;
        roundCountUnavailable = false;
      }
    } catch {
      // stays round_count_unavailable
    }
  }
  const perRound = added / rounds;
  const flag = roundCountUnavailable ? " round_count_unavailable" : "";
  if (perRound > THRESHOLD_PER_ROUND) {
    process.stdout.write(
      `Review ledger compactness advisory: ${added} lines over ${rounds} round(s) = `
      + `${Math.round(perRound)}/round (threshold ${THRESHOLD_PER_ROUND})${flag}\n`
    );
  } else {
    process.stdout.write(
      `Review ledger compactness: ${added} lines over ${rounds} round(s) `
      + `(threshold ${THRESHOLD_PER_ROUND}/round) — ok${flag}\n`
    );
  }
  return 0;
}

process.exit(main());
