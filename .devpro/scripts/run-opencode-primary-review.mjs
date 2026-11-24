#!/usr/bin/env node
/**
 * Ordinary-primary review through the shared OpenCode adapter (no sticky, no second-review
 * control evidence). Usage:
 *
 *   node .devpro/scripts/run-opencode-primary-review.mjs --prompt <file> --repo-root <abs-dir> \
 *     --target <reviewed target> --dispatch <dispatch id> --out <report file> \
 *     [--instruction <abs rule file>]... [--events-out <ndjson file>] [--sidecar-root <dir>]
 *
 * Prints one JSON line (the report text is written to --out, the OpenCode events to
 * --events-out when given; neither is ever printed). The reviewer's raw stdout and stderr, exactly as
 * they arrived, are kept in reviewer-stdout.ndjson / reviewer-stderr.log (mode 0600) in a new private
 * directory made for this run under --sidecar-root (default: the --out path plus `.raw`); the summary
 * names that directory as `sidecar_dir`. An existing root is never written into directly. The result is an
 * unsealed CLI report (`sealed_admission: false`): it is not a runtime-agent admission and
 * must not be relabeled as one. Exit 0 = finished or partial; 1 = blocked or failed; 2 = usage.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveCliPath } from "./lib/native-cli-path.mjs";
import { runOpenCodePrimaryReview } from "./lib/opencode-primary-review.mjs";

const FLAGS = ["--prompt", "--repo-root", "--target", "--dispatch", "--out"];
const OPTIONAL_FLAGS = ["--events-out", "--sidecar-root"];
const REPEATABLE_FLAGS = ["--instruction"];

function usageError() {
  const required = FLAGS.map((name) => `${name} <value>`);
  const optional = [...OPTIONAL_FLAGS.map((name) => `[${name} <value>]`), ...REPEATABLE_FLAGS.map((name) => `[${name} <value>]...`)];
  return new Error(`usage: run-opencode-primary-review.mjs ${[...required, ...optional].join(" ")}`);
}

export function parsePrimaryReviewArgs(argv) {
  const values = {};
  const instructionFiles = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const known = FLAGS.includes(flag) || OPTIONAL_FLAGS.includes(flag) || REPEATABLE_FLAGS.includes(flag);
    if (!known || typeof value !== "string" || value === "") throw usageError();
    if (REPEATABLE_FLAGS.includes(flag)) {
      instructionFiles.push(resolveCliPath(value));
      continue;
    }
    if (Object.hasOwn(values, flag)) throw usageError();
    values[flag] = value;
  }
  if (FLAGS.some((flag) => !Object.hasOwn(values, flag))) throw usageError();
  const outPath = resolveCliPath(values["--out"]);
  return {
    promptPath: resolveCliPath(values["--prompt"]),
    repoRoot: resolveCliPath(values["--repo-root"]),
    reviewedTarget: values["--target"],
    dispatchId: values["--dispatch"],
    outPath,
    sidecarRoot: Object.hasOwn(values, "--sidecar-root") ? resolveCliPath(values["--sidecar-root"]) : `${outPath}.raw`,
    instructionFiles,
    eventsPath: Object.hasOwn(values, "--events-out") ? resolveCliPath(values["--events-out"]) : null,
  };
}

export async function runPrimaryReviewCli(argv, options = {}) {
  const args = parsePrimaryReviewArgs(argv);
  const outcome = await runOpenCodePrimaryReview({
    promptBytes: readFileSync(args.promptPath),
    repoRoot: args.repoRoot,
    reviewedTarget: args.reviewedTarget,
    dispatchId: args.dispatchId,
    instructionFiles: args.instructionFiles,
    sidecarRoot: args.sidecarRoot,
    ...options,
  });
  const { report_text: reportText, events_text: eventsText, ...summary } = outcome;
  if (typeof reportText === "string") {
    writeFileSync(args.outPath, reportText, "utf8");
    summary.report_path = args.outPath;
  }
  if (args.eventsPath !== null && typeof eventsText === "string") {
    writeFileSync(args.eventsPath, eventsText.endsWith("\n") || eventsText === "" ? eventsText : `${eventsText}\n`, "utf8");
    summary.events_path = args.eventsPath;
  }
  return summary;
}

function directInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (directInvocation()) {
  try {
    const summary = await runPrimaryReviewCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.status !== "finished" && summary.status !== "partial") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
