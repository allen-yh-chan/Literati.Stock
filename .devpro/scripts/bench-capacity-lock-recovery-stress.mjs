#!/usr/bin/env node
// Stress tool for the capacity-lock stale recovery (design D11, tasks T11/T12). Manual run only: it is
// not on any hook path and not part of any test tier.
//
//   node .devpro/scripts/bench-capacity-lock-recovery-stress.mjs --contenders 4 --rounds 1000 --out <log.ndjson> [--root <dir>]
//
// Every round leaves a real dead lock (a child acquires and exits; created_at is moved past the stale
// threshold), starts N real contender processes that are released together once each has loaded the lock
// module, and checks: all exit 0, no overlap (an exclusive witness file plus an enter/exit log, both
// outside the lock root), exactly one repair-target-verified record, no unexpected-fs-error or
// residue-preserved record, and the residue rule (each leftover `.capacity-lock*` entry must match a
// residue-deferred or repair-marker-retire-failed record; on non-Windows platforms any leftover fails).
// Then one cleanup acquisition runs and the root must hold no `.capacity-lock*` entry.
//
// The log is NDJSON: a header line, one line per round, and a summary line. The run stops at the first
// failing round and keeps that round's directory; the log names it relative to --root. The helper replaces
// the round directory, --root, the system temp directory and the repository root in failure text, stderr and
// stdout lines, in the form written, with forward slashes, and with the doubled or quadrupled backslashes a
// Windows path has inside JSON; a path outside those four (for example a Windows 8.3 short name) is not
// recognised. Exit code: 0 pass, 1 any overlap, unexplained residue, unexpected failure or
// repair-marker-retire-failed (all mean "back to the design"), 2 bad arguments.
// Windows runs the same script: no shell, no POSIX path, only Node core.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRound } from "./tests/lib/capacity-lock-contender.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const PROGRESS_EVERY = 50;

function usage(message) {
  if (message) console.error(`bench-capacity-lock-recovery-stress: ${message}`);
  console.error("usage: node .devpro/scripts/bench-capacity-lock-recovery-stress.mjs --contenders N --rounds R --out <ndjson path> [--root <dir>]");
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--contenders", "--rounds", "--out", "--root"].includes(flag) || argv[index + 1] === undefined) {
      usage(`unknown or incomplete argument ${flag}`);
    }
    values[flag.slice(2)] = argv[index + 1];
  }
  const contenders = Number(values.contenders);
  const rounds = Number(values.rounds);
  if (!Number.isInteger(contenders) || contenders < 1) usage("--contenders must be a positive integer");
  if (!Number.isInteger(rounds) || rounds < 1) usage("--rounds must be a positive integer");
  if (!values.out) usage("--out is required");
  return { contenders, rounds, out: path.resolve(values.out), root: values.root ? path.resolve(values.root) : os.tmpdir() };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(args) {
  try {
    const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

// The log being written is not part of the code under test: leave its directory out of the dirty check,
// otherwise the second group of a sequence would always report dirty.
function environment(outDir) {
  const relativeOut = path.relative(REPO_ROOT, outDir).split(path.sep).join("/");
  const outsideRepo = relativeOut.startsWith("..") || path.isAbsolute(relativeOut);
  const status = git(["status", "--porcelain", "--", ".", ...(outsideRepo || relativeOut === "" ? [] : [`:(exclude)${relativeOut}`])]);
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: { type: os.type(), release: os.release(), version: os.version() },
    commit: git(["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    files_sha256: {
      lock_module: sha256(path.join(SCRIPT_DIR, "lib", "control-evidence-capacity-lock.mjs")),
      contender_helper: sha256(path.join(SCRIPT_DIR, "tests", "lib", "capacity-lock-contender.mjs")),
      stress_tool: sha256(fileURLToPath(import.meta.url)),
    },
  };
}

function merge(target, counts) {
  for (const [key, value] of Object.entries(counts)) target[key] = (target[key] ?? 0) + value;
}

const { contenders, rounds, out, root } = parseArgs(process.argv.slice(2));
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(root, { recursive: true });
const startedAt = Date.now();
const env = environment(path.dirname(out));
writeFileSync(out, `${JSON.stringify({ type: "header", started_at: new Date(startedAt).toISOString(), contenders, rounds, wait_ms: 120_000, ...env })}\n`);

const totals = {
  completed: 0,
  overlap: 0,
  unexpected_failures: 0,
  unexplained_residue: 0,
  pre_sweep_residue: 0,
  post_sweep_residue: 0,
  repair_marker_retire_failed: 0,
  pid_reuse_reruns: 0,
  errno_counts: {},
  event_counts: {},
};
let stoppedAt = null;
let keptRoundDir = null;
for (let round = 1; round <= rounds; round += 1) {
  const result = await runRound({ contenders, parentDir: root });
  totals.completed += 1;
  totals.overlap += result.overlap;
  totals.unexpected_failures += result.unexpected_failures;
  totals.unexplained_residue += result.unexplained_residue;
  totals.pre_sweep_residue += result.pre_sweep_residue;
  totals.post_sweep_residue += result.post_sweep_residue;
  totals.repair_marker_retire_failed += result.repair_marker_retire_failed;
  totals.pid_reuse_reruns += result.pid_reuse_reruns;
  merge(totals.errno_counts, result.errno_counts);
  merge(totals.event_counts, result.event_counts);
  appendFileSync(out, `${JSON.stringify({ type: "round", round, ...result })}\n`);
  if (round % PROGRESS_EVERY === 0 || round === rounds) {
    console.log(`round ${round}/${rounds} ok (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }
  if (!result.ok) {
    stoppedAt = round;
    keptRoundDir = result.round_dir;
    console.error(`round ${round} FAILED: ${JSON.stringify(result.failures)}`);
    if (keptRoundDir) console.error(`round directory kept: ${keptRoundDir} (under the --root directory, default: the system temp directory)`);
    break;
  }
}

const pass = stoppedAt === null
  && totals.overlap === 0
  && totals.unexpected_failures === 0
  && totals.unexplained_residue === 0
  && totals.repair_marker_retire_failed === 0
  && (process.platform === "win32" || totals.pre_sweep_residue === 0);
const summary = {
  type: "summary",
  verdict: pass ? "pass" : "fail",
  requested_rounds: rounds,
  rounds: totals.completed,
  stopped_early: stoppedAt !== null,
  stopped_at_round: stoppedAt,
  kept_round_dir: keptRoundDir,
  contenders,
  overlap: totals.overlap,
  unexpected_failures: totals.unexpected_failures,
  unexplained_residue: totals.unexplained_residue,
  pre_sweep_residue: totals.pre_sweep_residue,
  post_sweep_residue: totals.post_sweep_residue,
  repair_marker_retire_failed: totals.repair_marker_retire_failed,
  pid_reuse_reruns: totals.pid_reuse_reruns,
  errno_counts: totals.errno_counts,
  event_counts: totals.event_counts,
  duration_ms: Date.now() - startedAt,
  finished_at: new Date().toISOString(),
  node: env.node,
  platform: env.platform,
  os: env.os,
};
appendFileSync(out, `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));
process.exit(pass ? 0 : 1);
