#!/usr/bin/env node
// Whole post-PR Stop hook: latency with the worktree count and the number of pending markers, plus the real-launcher deadline cases.
//
// One-off development tool: it is not on any hook path and not part of the canonical suite. Run it again whenever a change touches the Stop
// hook's cost (the shared worktree budget in hooks/lib/admission-record.mjs, the marker loop, R7 cooperative deadline, R8 hard-deadline
// supervisor) and record the numbers in that change's decisions.md. Rule (design-core.md section 8): 128 worktrees (main included) with
// K=10 same-branch markers, the SLOWEST of 5 runs must stay <= 18 s (one tenth of the launcher's 180 s fail-open limit).
//
//   node .devpro/scripts/bench-post-pr-stop-hook-latency.mjs [--mode throughput] [--worktrees 128] [--markers 1,3,10] [--runs 5] [--limit-s 18] [--sp <dir>]
//   node .devpro/scripts/bench-post-pr-stop-hook-latency.mjs --mode launcher-deadline [--worktrees 128] [--markers 40] [--gh-delay-ms 4500]   (~3 min)
//   node .devpro/scripts/bench-post-pr-stop-hook-latency.mjs --mode launcher-hang        (`git worktree list` hangs, default deadlines, ~3 min)
//   node .devpro/scripts/bench-post-pr-stop-hook-latency.mjs --mode launcher-shortened   (DEVPRO_HOOK_TIMEOUT_MS=30000, every git call hangs, ~50 s)
//   node .devpro/scripts/bench-post-pr-stop-hook-latency.mjs --mode launcher-tiny        (DEVPRO_HOOK_TIMEOUT_MS=500, every git call hangs)
//   node .devpro/scripts/bench-post-pr-stop-hook-latency.mjs --self-test
//
// --worktrees is the TOTAL `git worktree list` count INCLUDING the main checkout (N-1 linked). The worktree budget constant is rewritten to
// max(128, N) in a throwaway copy of the scripts, and a constant that is not found exactly once exits 1 naming it. gh is mocked with the hook's own
// DEVPRO_POST_PR_GATE_MOCK_* env in throughput/hang modes (gh cost EXCLUDED; the launcher-deadline mode uses a fake `gh` with a fixed delay instead).
// Every run asserts the workload shape BEFORE (worktree count, marker count) and the outcome AFTER (exit status, marker files, the exact number of
// `git worktree list` calls); any miss makes the whole benchmark exit 1. POSIX only (sh shims).
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SP = opt("sp", os.tmpdir());
const MODE = opt("mode", "throughput");
const RUNS = Number(opt("runs", "5"));
const LIMIT_S = Number(opt("limit-s", "18"));
const GH_DELAY_MS = Number(opt("gh-delay-ms", "4500"));
const FAULT = opt("fault", "none"); // self-test only: injects a defect that the assertions must catch
const LAUNCHER_MODES = new Set(["launcher-deadline", "launcher-hang", "launcher-shortened", "launcher-tiny"]);
const DEFAULT_WORKTREES = { throughput: 128, "launcher-deadline": 128, "launcher-hang": 4, "launcher-shortened": 4, "launcher-tiny": 4 };
const DEFAULT_MARKERS = { throughput: "1,3,10", "launcher-deadline": "40", "launcher-hang": "3", "launcher-shortened": "3", "launcher-tiny": "3" };
const WORKTREES = Number(opt("worktrees", String(DEFAULT_WORKTREES[MODE] ?? 128)));
const MARKERS = opt("markers", DEFAULT_MARKERS[MODE] ?? "1,3,10").split(",").map(Number);
const WORKTREE_CONSTANT = "CODEX_REVIEWER_WORKTREE_LIST_MAX";
const SESSION = "bench-stop-session";

if (process.platform === "win32") {
  console.error("bench-post-pr-stop-hook-latency: POSIX only (sh shims); not measured on Windows");
  process.exit(2);
}
if (MODE !== "throughput" && !LAUNCHER_MODES.has(MODE)) {
  console.error(`bench-post-pr-stop-hook-latency: unknown --mode ${MODE}`);
  process.exit(2);
}

if (argv.includes("--self-test")) {
  const child = (...extra) => spawnSync(process.execPath, [process.argv[1], "--sp", SP, ...extra], { encoding: "utf8", timeout: 300_000 });
  const small = ["--mode", "throughput", "--worktrees", "4", "--markers", "2", "--runs", "1"];
  const tiny = ["--mode", "launcher-tiny", "--worktrees", "4", "--markers", "2"];
  const cases = [
    { name: "control (throughput, no defect)", args: small, expectExit: 0 },
    { name: "the workload has one worktree too many (inadmissible shape)", args: [...small, "--fault", "extra-worktree"], expectExit: 1 },
    { name: "a pending marker is left behind by the run", args: [...small, "--fault", "leave-marker"], expectExit: 1 },
    { name: "the hook does not complete (hard deadline shortened to 1 ms)", args: [...small, "--fault", "hook-fails"], expectExit: 1 },
    { name: "the worktree list is enumerated twice per run (call-count assertion)", args: [...small, "--fault", "double-list"], expectExit: 1 },
    { name: "the worktree budget constant is not found exactly once (exit 1 naming it)", args: [...small, "--fault", "missing-constant"], expectExit: 1, expectStderr: WORKTREE_CONSTANT },
    { name: "control (launcher-tiny, no defect)", args: tiny, expectExit: 0 },
    { name: "a marker is modified after the launcher run (marker bytes assertion)", args: [...tiny, "--fault", "tamper-marker"], expectExit: 1 },
  ];
  let all = true;
  for (const c of cases) {
    const r = child(...c.args);
    const pass = r.status === c.expectExit && (!c.expectStderr || (r.stderr || "").includes(c.expectStderr));
    if (!pass) all = false;
    const problems = (r.stdout || "").split("\n").filter((l) => l.startsWith("CELL ") || l.startsWith("LAUNCHER ")).map((l) => JSON.parse(l.slice(l.indexOf(" ") + 1)).problems).flat();
    console.log(`${pass ? "PASS" : "FAIL"}  [${c.name}] benchmark exit=${r.status} (expected ${c.expectExit}) problems=${JSON.stringify(problems)}`);
  }
  console.log("SELFTEST", JSON.stringify({ cases: cases.length, all_pass: all }));
  process.exit(all ? 0 : 1);
}

const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function pinConstant(src, name, value) {
  const re = new RegExp(`^export const ${name} = [0-9_]+;$`, "gm");
  const hits = src.match(re) ?? [];
  if (hits.length !== 1) throw new Error(`budget constant ${name} not found exactly once (expected a line \`export const ${name} = <number>;\` in hooks/lib/admission-record.mjs, found ${hits.length})`);
  return src.replace(re, `export const ${name} = ${value};`);
}

console.log("ENV " + JSON.stringify({ platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, git: git(".", "--version"), mode: MODE, worktrees_total: WORKTREES, markers: MARKERS, runs: RUNS, limit_s: LIMIT_S, load_avg_at_start: os.loadavg().map((x) => Math.round(x * 10) / 10) }));

const work = mkdtempSync(path.join(SP, "bench-stop-"));
const cleanup = () => rmSync(work, { recursive: true, force: true });
const repo = path.join(work, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "bench@example.invalid");
git(repo, "config", "user.name", "bench");
writeFileSync(path.join(repo, "README.md"), "x\n");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");

// the real scripts (no tests, no live hook state); only the shared worktree budget is pinned so that N worktrees are not cut short
const tree = path.join(repo, ".devpro/scripts");
cpSync(path.join(REPO, ".devpro/scripts"), tree, {
  recursive: true,
  filter: (s) => !s.includes(`${path.sep}tests`) && !s.includes(path.join("hooks", "state")),
});
try {
  const modPath = path.join(tree, "hooks/lib/admission-record.mjs");
  writeFileSync(modPath, pinConstant(readFileSync(modPath, "utf8"), FAULT === "missing-constant" ? `${WORKTREE_CONSTANT}_ABSENT` : WORKTREE_CONSTANT, Math.max(128, WORKTREES)));
} catch (error) {
  console.error(`bench-post-pr-stop-hook-latency: ${error.message}`);
  cleanup();
  process.exit(1);
}
const HOOK = path.join(tree, "hooks/post-pr-completion-check.mjs");
const RUN_HOOK = path.join(tree, "hooks/run-hook.mjs");
const stateMod = await import(pathToFileURL(path.join(REPO, ".devpro/scripts/hooks/lib/post-pr-completion-state.mjs")).href);

const dirs = { claudeRoot: path.join(work, "claude-root"), usage: path.join(work, "usage"), reminder: path.join(work, "reminder"), advisory: path.join(work, "advisory") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// shims: `git` (logs every argv, optionally hangs, optionally double-logs the worktree list) and `gh` (fixed delay, answers MERGED)
const shimDir = path.join(work, "shim");
mkdirSync(shimDir);
const shimLog = path.join(work, "git-calls.log");
writeFileSync(path.join(shimDir, "git"), `#!/bin/sh
case "$*" in worktree\\ list*) [ "$BENCH_GIT_DOUBLE_LIST" = 1 ] && printf '%s\\n' "$*" >> '${shimLog}';; esac
printf '%s\\n' "$*" >> '${shimLog}'
case "$BENCH_GIT_HANG" in
  all) exec sleep 300;;
  worktree-list) if [ "$1" = worktree ] && [ "$2" = list ]; then exec sleep 300; fi;;
esac
exec '${REAL_GIT}' "$@"
`);
writeFileSync(path.join(shimDir, "gh"), `#!/bin/sh
kind=light
case "$*" in *files*) kind=full;; esac
d="\${FAKE_GH_DELAY_S:-0}"
if [ "$d" != "0" ]; then
  sleep "$d" &
  pid=$!
  trap 'kill $pid 2>/dev/null; exit 143' TERM
  wait $pid
fi
sha=cccccccccccccccccccccccccccccccccccccccc
if [ "$kind" = full ]; then extra=',"files":[{"path":"src/app.js","additions":1,"deletions":0}],"changedFiles":1'; else extra=''; fi
num=9999
if [ "$2" = "view" ]; then num="$3"; fi
item=$(printf '{"number":%s,"url":"https://example.invalid/pull/%s","state":"MERGED","headRefName":"%s","headRefOid":"%s","comments":[],"body":"## Cost Circuit Breaker Overrides\\\\nN/A\\\\n"%s}' "$num" "$num" "$FAKE_GH_BRANCH" "$sha" "$extra")
if [ "$2" = "list" ]; then printf '[%s]' "$item"; else printf '%s' "$item"; fi
`);
chmodSync(path.join(shimDir, "git"), 0o755);
chmodSync(path.join(shimDir, "gh"), 0o755);

let linked = 0;
function addWorktree() {
  const id = `c${linked + 1}`;
  git(repo, "worktree", "add", "-q", "-b", `bugfix/${id}`, `.worktree/${id}`);
  mkdirSync(path.join(repo, ".worktree", id, "openspec", "changes", id), { recursive: true });
  linked += 1;
}
// `git worktree list` counts the main checkout too: N total = main + (N - 1) linked
const worktreesTotal = () => git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
const BRANCH = "bugfix/c1";
const cwdOfHook = () => path.join(repo, ".worktree", "c1");

// Markers are written by the repo's own writer, on the branch the hook runs on (only same-branch markers enter the loop), and aged so that none looks
// "not due yet". In mock mode the hook's own DEVPRO_POST_PR_GATE_MOCK_* env answers what gh would; otherwise the fake gh answers.
function makeMarkers(k, { mock }) {
  const stateDir = path.join(work, `state-${Math.random().toString(16).slice(2)}`);
  mkdirSync(stateDir, { recursive: true });
  const prev = { dir: process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR, session: process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID };
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = SESSION;
  const headRefs = []; const shas = []; const bodies = []; const stickies = [];
  try {
    for (let i = 1; i <= k; i += 1) {
      const pr = String(9000 + i);
      const file = stateMod.writePostPrCompletionMarker({ cwd: repo, prNumber: pr, branch: BRANCH, url: `https://example.invalid/pull/${pr}` });
      const old = new Date(Date.now() - 4000 * 1000);
      utimesSync(file, old, old);
      headRefs.push(`${pr}:${BRANCH}`); shas.push(`${pr}:${"c".repeat(40)}`); bodies.push(`${pr}:${b64("## Cost Circuit Breaker Overrides\nN/A\n")}`); stickies.push(pr);
    }
  } finally {
    for (const [key, value] of [["DEVPRO_POST_PR_COMPLETION_STATE_DIR", prev.dir], ["DEVPRO_POST_PR_COMPLETION_SESSION_ID", prev.session]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  return {
    stateDir,
    env: mock ? {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: stickies.join(","),
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: headRefs.join(","),
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: shas.join(","),
      DEVPRO_POST_PR_GATE_MOCK_BODY_B64: bodies.join(","),
    } : {},
  };
}
const markerFiles = (stateDir) => (existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.endsWith(".json")).sort() : []);
const markerDigests = (stateDir) => Object.fromEntries(markerFiles(stateDir).map((f) => [f, sha256(readFileSync(path.join(stateDir, f)))]));

const STRIP = /^(DEVPRO_POST_PR_GATE_MOCK_|DEVPRO_STOP_|DEVPRO_HOOK_|DEVPRO_CROSS_MODEL_REVIEWER$|NODE_OPTIONS$|FAKE_GH_|BENCH_)/;
function childEnv(stateDir, { withShim, extra }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!STRIP.test(key)) env[key] = value;
  return {
    ...env,
    ...(withShim ? { PATH: `${shimDir}${path.delimiter}${process.env.PATH}` } : {}),
    HOME: work,
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
    DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: dirs.reminder,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: dirs.advisory,
    DEVPRO_CHANGE_USAGE_STATE_DIR: dirs.usage,
    DEVPRO_TEST_CLAUDE_ROOT: dirs.claudeRoot,
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: SESSION,
    CODEX_THREAD_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CONVERSATION_ID: "",
    FAKE_GH_BRANCH: BRANCH,
    ...extra,
  };
}
function runNode(args, stateDir, { withShim, extra = {}, timeoutMs = 900_000 }) {
  const t = performance.now();
  const r = spawnSync(process.execPath, args, { cwd: cwdOfHook(), encoding: "utf8", input: "", env: childEnv(stateDir, { withShim, extra }), timeout: timeoutMs, killSignal: "SIGKILL" });
  let json = null;
  try { json = JSON.parse(r.stdout || ""); } catch {}
  return { ms: Math.round(performance.now() - t), status: r.status, signal: r.signal, error: r.error ? String(r.error.code ?? r.error.message) : null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json };
}
function worktreeListCalls() {
  const lines = existsSync(shimLog) ? readFileSync(shimLog, "utf8").split("\n").filter(Boolean) : [];
  return lines.filter((l) => /^worktree list/.test(l)).length;
}

let allOk = true;

// ---------------------------------------------------------------- throughput mode
if (MODE === "throughput") {
  while (linked + 1 < WORKTREES) addWorktree();
  const cells = [];
  for (const k of MARKERS) {
    const problems = [];
    if (FAULT === "extra-worktree") git(repo, "worktree", "add", "-q", "-b", `bugfix/extra-${k}`, path.join(work, `extra-${k}`));
    const total = worktreesTotal();
    if (total !== WORKTREES) problems.push(`workload-shape-mismatch(worktrees_total: have ${total}, want ${WORKTREES})`);
    const deadlineFault = FAULT === "hook-fails" ? { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "1" } : {};
    const shape = (label, { stateDir }) => {
      const have = markerFiles(stateDir).length;
      if (have !== k) problems.push(`${label}: workload-shape-mismatch(markers: have ${have}, want ${k})`);
    };
    const finish = (label, r, stateDir) => {
      if (FAULT === "leave-marker") writeFileSync(path.join(stateDir, "stray.json"), "{}");
      const remaining = markerFiles(stateDir).length;
      if (r.status !== 0 || r.signal || r.error) problems.push(`${label}: status=${r.status} signal=${r.signal} error=${r.error} stderr=${r.stderr.slice(0, 200)} stdout=${r.stdout.slice(0, 200)}`);
      if (remaining !== 0) problems.push(`${label}: remaining-markers=${remaining}`);
    };
    // one counted run: the worktree list is enumerated exactly once, whatever K is (the shared handle)
    const counted = makeMarkers(k, { mock: true });
    shape("counted", counted);
    rmSync(shimLog, { force: true });
    const c = runNode([HOOK], counted.stateDir, { withShim: true, extra: { ...counted.env, ...deadlineFault, ...(FAULT === "double-list" ? { BENCH_GIT_DOUBLE_LIST: "1" } : {}) } });
    finish("counted", c, counted.stateDir);
    const listCalls = worktreeListCalls();
    if (listCalls !== 1) problems.push(`counted: git worktree list called ${listCalls} times, want exactly 1`);
    const times = [];
    for (let i = 0; i < RUNS; i += 1) {
      const m = makeMarkers(k, { mock: true });
      shape(`run${i}`, m);
      const r = runNode([HOOK], m.stateDir, { withShim: false, extra: { ...m.env, ...deadlineFault } });
      finish(`run${i}`, r, m.stateDir);
      if (r.stdout !== c.stdout) problems.push(`run${i}: stdout differs from the counted run`);
      times.push(r.ms);
    }
    const within = Math.max(...times) <= LIMIT_S * 1000;
    if (!within) problems.push(`rule: slowest run ${Math.max(...times)} ms is above ${LIMIT_S} s`);
    const cell = { worktrees_total: WORKTREES, markers: k, worktree_list_calls: listCalls, ms_all: times, ms_median: median(times), ms_max: Math.max(...times), within_limit: within, problems, load_avg_1m: Math.round(os.loadavg()[0] * 10) / 10 };
    if (problems.length) allOk = false;
    cells.push(cell);
    console.log("CELL " + JSON.stringify(cell));
  }
  console.log("SUMMARY " + JSON.stringify({ mode: MODE, all_ok: allOk, cells: cells.map((x) => ({ worktrees: x.worktrees_total, markers: x.markers, median_ms: x.ms_median, max_ms: x.ms_max, list_calls: x.worktree_list_calls })) }));
}

// ---------------------------------------------------------------- real-launcher modes (`run-hook.mjs Stop <hook> --host=claude-code`, the way the hosts start it)
if (LAUNCHER_MODES.has(MODE)) {
  while (linked + 1 < WORKTREES) addWorktree();
  const k = MARKERS[0];
  const hang = { "launcher-deadline": null, "launcher-hang": "worktree-list", "launcher-shortened": "all", "launcher-tiny": "all" }[MODE];
  const modeEnv = {
    "launcher-deadline": { FAKE_GH_DELAY_S: String(GH_DELAY_MS / 1000) },
    "launcher-hang": {},
    "launcher-shortened": { DEVPRO_HOOK_TIMEOUT_MS: "30000" },
    "launcher-tiny": { DEVPRO_HOOK_TIMEOUT_MS: "500", DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "0.5" },
  }[MODE];
  // wall-clock ceilings per mode (seconds): the block must arrive before the launcher's own limit
  const ceilingS = { "launcher-deadline": 160, "launcher-hang": 170, "launcher-shortened": 25, "launcher-tiny": 10 }[MODE];
  const wantReason = { "launcher-deadline": /time budget exhausted/, "launcher-hang": /hard time limit reached/, "launcher-shortened": /hard time limit reached|could not be completed/, "launcher-tiny": /hard time limit reached|could not be completed/ }[MODE];
  const m = makeMarkers(k, { mock: hang !== null });
  const before = markerDigests(m.stateDir);
  const problems = [];
  const total = worktreesTotal();
  if (total !== WORKTREES) problems.push(`workload-shape-mismatch(worktrees_total: have ${total}, want ${WORKTREES})`);
  if (Object.keys(before).length !== k) problems.push(`workload-shape-mismatch(markers: have ${Object.keys(before).length}, want ${k})`);
  const extra = { ...m.env, ...modeEnv, ...(hang ? { BENCH_GIT_HANG: hang } : {}) };
  const launch = () => runNode([RUN_HOOK, "Stop", HOOK, "--host=claude-code"], m.stateDir, { withShim: true, extra, timeoutMs: 400_000 });
  const first = launch();
  if (FAULT === "tamper-marker") { const f = markerFiles(m.stateDir)[0]; if (f) appendFileSync(path.join(m.stateDir, f), " "); }
  const after = markerDigests(m.stateDir);
  const seconds = Math.round(first.ms / 100) / 10;
  if (first.status !== 1 || first.signal || first.error) problems.push(`first: launcher exit status=${first.status} signal=${first.signal} error=${first.error} (want exit 1, the launcher's mapping of the hook's block)`);
  if (/timed out/.test(first.stderr)) problems.push("first: the launcher's own timeout fired (stderr says timed out) before the block was delivered");
  if (first.json?.decision !== "block" || !wantReason.test(String(first.json?.reason ?? ""))) problems.push(`first: stdout is not the expected block (${wantReason}): ${first.stdout.slice(0, 200)}`);
  if (seconds > ceilingS) problems.push(`first: ${seconds} s is above the ${ceilingS} s ceiling`);
  // the markers the run did not touch keep their name AND bytes; with the cooperative deadline some were processed (cleared), never modified
  for (const [name, digest] of Object.entries(after)) if (before[name] !== digest) problems.push(`first: marker ${name} changed its name or bytes`);
  if (MODE === "launcher-deadline") { if (Object.keys(after).length === 0) problems.push("first: no unprocessed marker remains (the cooperative deadline never bit)"); }
  else if (Object.keys(after).length !== k) problems.push(`first: ${Object.keys(after).length} of ${k} markers remain, want all (nothing can be processed while git hangs)`);
  let second = null;
  if (MODE === "launcher-shortened") { // same session within 30 minutes: the second block downgrades to a soft reminder
    second = launch();
    if (second.status !== 0 || typeof second.json?.systemMessage !== "string") problems.push(`second: want exit 0 and a systemMessage soft reminder, got status=${second.status} stdout=${second.stdout.slice(0, 200)}`);
    if (/timed out/.test(second.stderr)) problems.push("second: the launcher's own timeout fired");
    if (second.ms / 1000 > ceilingS) problems.push(`second: ${Math.round(second.ms / 100) / 10} s is above the ${ceilingS} s ceiling`);
  }
  if (problems.length) allOk = false;
  console.log("LAUNCHER " + JSON.stringify({ mode: MODE, worktrees_total: WORKTREES, markers: k, first: { seconds, exit: first.status, stderr_has_timed_out: /timed out/.test(first.stderr), reason_head: String(first.json?.reason ?? "").slice(0, 160), markers_before: Object.keys(before).length, markers_after: Object.keys(after).length }, second: second && { seconds: Math.round(second.ms / 100) / 10, exit: second.status, soft_reminder: typeof second.json?.systemMessage === "string" }, problems }));
}

cleanup();
process.exit(allOk ? 0 : 1);
