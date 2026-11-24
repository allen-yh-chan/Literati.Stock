#!/usr/bin/env node
/**
 * check-suite-runtime-budget.mjs
 *
 * Report-only full-suite runtime measurement for the source repo.
 *
 * WHAT IT DOES: runs the canonical suite
 * (`node .devpro/scripts/run-test-suite.mjs --tier all`) once, measures
 * wall-clock real time, and prints it. It does NOT block on a
 * fixed wall-clock budget — the suite is git-integration-heavy and CPU-bound, so
 * real time swings with host load; a fixed budget forced a per-PR bypass rather
 * than protecting anything. Tier-scoped execution (run-test-suite.mjs --changed)
 * is the mechanism that keeps day-to-day runs fast; this gate just surfaces the
 * full-suite cost every time so a magnitude regression stays visible.
 *
 * A red suite (any failing test) STILL exits non-zero: a failing suite is not a
 * valid "measurement" and must not be reported as clean.
 *
 * History: an earlier version enforced a fixed 90s wall-clock budget (exit 1 over
 * budget) with an env-var escape hatch. That block was removed per the
 * test-governance "Tier-Aware Test Execution" requirement — the full-suite time
 * is report-only; there is no budget constant and no bypass env var.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Canonical suite inputs (relative to repo root). The full-suite command goes
// through run-test-suite.mjs so timing uses manifest unit+integration tiers
// instead of raw Node directory discovery.
export const SUITE_DIR = ".devpro/scripts/tests/";
export const RUN_TEST_SUITE_SCRIPT = ".devpro/scripts/run-test-suite.mjs";

function repoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // .devpro/scripts/check-suite-runtime-budget.mjs → repo root is two up.
  return path.resolve(scriptDir, "../..");
}

/**
 * Runs the canonical suite once and returns { realSeconds, testsFailed, ... }.
 * We measure wall-clock real time around the spawn rather than parsing
 * `duration_ms` from TAP output, because real time is the user-facing number and
 * does not depend on the runner's self-reported timing.
 */
function measureSuite(root) {
  const startNs = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [RUN_TEST_SUITE_SCRIPT, "--tier", "all"], {
    cwd: root,
    encoding: "utf8",
    // Capture instead of inherit so we can surface a compact summary; the child's
    // own TAP is available on failure.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const endNs = process.hrtime.bigint();
  const realSeconds = Number(endNs - startNs) / 1e9;

  if (result.error) {
    throw new Error(`failed to run suite: ${result.error.message}`);
  }

  // node --test exits non-zero when any test fails.
  const testsFailed = result.status !== 0;
  return { realSeconds, testsFailed, stdout: result.stdout, stderr: result.stderr };
}

export function suiteRuntimeSummaryLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("[test-suite] "));
}

function printSuiteRuntimeSummary(stdout) {
  for (const line of suiteRuntimeSummaryLines(stdout)) {
    console.log(line);
  }
}

function main() {
  const root = repoRoot();

  console.log(
    `[suite-runtime] running canonical suite \`node ${RUN_TEST_SUITE_SCRIPT} --tier all\` (report-only)…`,
  );

  const { realSeconds, testsFailed, stdout, stderr } = measureSuite(root);
  printSuiteRuntimeSummary(stdout);
  const rounded = realSeconds.toFixed(1);

  if (testsFailed) {
    console.error(
      `[suite-runtime] BLOCK: suite has failing tests — a red suite is not a valid measurement. Fix tests first.`,
    );
    // Surface the tail of the child's output so the failure is actionable.
    const tail = (stderr || stdout || "").split("\n").slice(-25).join("\n");
    if (tail.trim()) console.error(tail);
    process.exit(1);
  }

  console.log(
    `[suite-runtime] measured full-suite real time: ${rounded}s (report-only, no budget block)`,
  );
  process.exit(0);
}

// Only run when invoked directly as a CLI. Guarding this lets tests import
// constants without triggering a full suite run.
// Use pathToFileURL(argv[1]) rather than `file://${argv[1]}`: the two only match
// for space-free paths — import.meta.url percent-encodes (e.g. `%20`) while a raw
// `file://` template does not, so a repo path with spaces would make the guard
// false and the CLI silently no-op. pathToFileURL encodes both sides identically.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
