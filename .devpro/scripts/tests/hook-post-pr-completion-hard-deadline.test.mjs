import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { expandReminderDetailsOutput, spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// R8 (fix-codex-reviewer-intent-candidate-cap, T2g): the Stop hook's supervised hard deadline.
//
// The supervisor (hooks/lib/stop-run-supervisor.mjs, T9) is the hook script's first import: it re-runs the hook as a
// `--stop-worker` child with the hard deadline as the child timeout and blocks when the worker cannot finish. None of it exists on
// the base commit, so:
//   - the supervisor module is only ever loaded by a child script (or through a dynamic import in a test body), never by a static
//     import that would fail the whole file at load time;
//   - a red test on the base commit means a missing module, a missing export, or the hook running unsupervised.
//
// Fixtures (all built at runtime under a temp dir, child-only): a throwaway git repo whose branch equals the markers' branch, a
// fake `gh` with a fixed delay per call, a `git` shim that hangs every call, `node --import` preloads that step the wall clock,
// and a wrapper script that imports the supervisor and calls superviseStopRun({ spawnSyncImpl }) (it never returns, so it cannot
// be driven in-process). The hang cases bound the outer spawnSync so that on the base commit (no supervisor, the hook just hangs)
// they fail after 15 s instead of running for minutes.
//
// Deliberate departure from test spec #12(d) and #12(g)(vi) ("re-raise the same signal"): the confirmed design (D11, K-14) is the
// opposite. A signal-killed worker BLOCKS and the supervisor does not re-raise, because a re-raised signal reaches the launcher as
// a null exit status, which the launcher treats as success.


// These gate fixtures explicitly own their PRs. Existing gate assertions read
// the full scoped diagnostic; the isolation suite asserts the compact transport.
process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;
process.env.DEVPRO_AGENT_RULES_LEVEL = "full";

const HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const RUN_HOOK = repoPath(".devpro/scripts/hooks/run-hook.mjs");
const SUPERVISOR_MODULE = repoPath(".devpro/scripts/hooks/lib/stop-run-supervisor.mjs");
const POSIX_ONLY = { skip: process.platform === "win32" ? "sh-based gh/git shims, ps and node --import preloads are POSIX-only fixtures" : false };
const SESSION = "hard-deadline-session";
const HANG_BOUND_MS = 15_000;
const tmpRoot = makeTempDir("post-pr-hard-deadline-");
const hangPidFiles = [];

after(() => {
  // The hanging git shim leaves an orphan `sleep` behind when its worker is SIGKILLed: reap them.
  for (const file of hangPidFiles) {
    try {
      for (const pid of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
    } catch {}
  }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ---- fixtures -----------------------------------------------------------------------------------------------------

const GH_SHIM = `#!/bin/sh
kind=light
case "$*" in *files*) kind=full;; esac
d="\${FAKE_GH_DELAY_S:-0}"
parent=$(ps -o command= -p $PPID 2>/dev/null | tr '\\n' ' ')
printf 'start %s parent=%s\\n' "$kind" "$parent" >> "$FAKE_GH_LOG"
if [ "$d" != "0" ]; then
  sleep "$d" &
  pid=$!
  trap 'kill $pid 2>/dev/null; exit 143' TERM
  wait $pid
fi
printf 'end %s\\n' "$kind" >> "$FAKE_GH_LOG"
state="\${FAKE_GH_STATE:-MERGED}"
sha=cccccccccccccccccccccccccccccccccccccccc
if [ "$kind" = full ]; then
  extra=',"files":[{"path":"src/app.js","additions":1,"deletions":0}],"changedFiles":1'
else
  extra=''
fi
num=9999
if [ "$2" = "view" ]; then num="$3"; fi
item=$(printf '{"number":%s,"url":"https://github.com/fixture/project/pull/%s","state":"%s","headRefName":"%s","headRefOid":"%s","comments":[],"body":"## Cost Circuit Breaker Overrides\\\\nN/A\\\\n"%s}' "$num" "$num" "$state" "$FAKE_GH_BRANCH" "$sha" "$extra")
if [ "$2" = "list" ]; then printf '[%s]' "$item"; else printf '%s' "$item"; fi
`;

// Every git call sleeps (its pid is recorded so that the orphan can be reaped). The TERM trap lets a per-call timeout inside the
// hook end the call instead of leaving spawnSync waiting on a pipe that an orphan `sleep` still holds.
const HANG_GIT_SHIM = `#!/bin/sh
sleep 30 &
pid=$!
echo $pid >> "$HANG_PID_FILE"
trap 'kill $pid 2>/dev/null; exit 143' TERM
wait $pid
`;

let fixtureCounter = 0;
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeFixture(label, { branch = "bugfix/hd-change" } = {}) {
  const root = path.join(tmpRoot, `${fixtureCounter++}-${label}`);
  const repo = path.join(root, "repo");
  const shimDir = path.join(root, "shim");
  const hangDir = path.join(root, "hang");
  mkdirSync(repo, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(hangDir, { recursive: true });
  git(repo, "init", "-q", "-b", branch);
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(path.join(shimDir, "gh"), GH_SHIM);
  chmodSync(path.join(shimDir, "gh"), 0o755);
  writeFileSync(path.join(hangDir, "git"), HANG_GIT_SHIM);
  chmodSync(path.join(hangDir, "git"), 0o755);
  const hangPidFile = path.join(root, "hang-pids");
  hangPidFiles.push(hangPidFile);
  const dirs = {
    stateDir: path.join(root, "state"),
    reminderDir: path.join(root, "reminder"),
    advisoryDir: path.join(root, "advisory"),
    usageDir: path.join(root, "usage"),
    claudeRoot: path.join(root, "claude-root"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return { label, root, repo, shimDir, hangDir, hangPidFile, branch, ghLog: path.join(root, "gh-calls.log"), ...dirs };
}

function seedMarkers(fx, { count, ageS = 4000, firstNumber = 9001 }) {
  const previous = {
    dir: process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR,
    session: process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID,
  };
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = fx.stateDir;
  process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = SESSION;
  try {
    for (let i = 0; i < count; i += 1) {
      const number = String(firstNumber + i);
      const file = writePostPrCompletionMarker({
        cwd: fx.repo,
        prNumber: number,
        branch: fx.branch,
      });
      const old = new Date(Date.now() - ageS * 1000);
      utimesSync(file, old, old);
    }
  } finally {
    if (previous.dir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous.dir;
    if (previous.session === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID;
    else process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = previous.session;
  }
}

// name -> sha256(bytes): "unchanged" is the same file names AND the same bytes, not just the same count.
function markerMap(fx) {
  const out = {};
  for (const name of readdirSync(fx.stateDir).filter((f) => f.endsWith(".json")).sort()) {
    out[name] = createHash("sha256").update(readFileSync(path.join(fx.stateDir, name))).digest("hex");
  }
  return out;
}

function assertRemainingMarkersUnmodified(before, after, message = "") {
  for (const [name, digest] of Object.entries(after)) {
    assert.equal(before[name], digest, `marker ${name} must keep its name and bytes ${message}`);
  }
}

const STRIP_FROM_CHILD_ENV = /^(DEVPRO_POST_PR_GATE_MOCK_|DEVPRO_STOP_|DEVPRO_HOOK_|DEVPRO_CROSS_MODEL_REVIEWER$|NODE_OPTIONS$|FAKE_GH_|WRAP_|DC_)/;
function childEnv(fx, { hang = false, ...extra } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIP_FROM_CHILD_ENV.test(key)) env[key] = value;
  }
  const front = [hang ? fx.hangDir : null, fx.shimDir].filter(Boolean).join(path.delimiter);
  return {
    ...env,
    PATH: `${front}${path.delimiter}${process.env.PATH}`,
    HOME: fx.root,
    // Set explicitly so the supervisor's failure path never probes git to find a state directory (a hanging git would stall it).
    DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: fx.reminderDir,
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: fx.stateDir,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: fx.advisoryDir,
    DEVPRO_CHANGE_USAGE_STATE_DIR: fx.usageDir,
    DEVPRO_TEST_CLAUDE_ROOT: fx.claudeRoot,
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: SESSION,
    DEVPRO_HOOK_HOST: "test",
    CODEX_THREAD_ID: "",
    CLAUDE_SESSION_ID: "",
    CLAUDE_CONVERSATION_ID: "",
    FAKE_GH_LOG: fx.ghLog,
    FAKE_GH_BRANCH: fx.branch,
    HANG_PID_FILE: fx.hangPidFile,
    ...extra,
  };
}

function ghLines(fx) {
  return existsSync(fx.ghLog) ? readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean) : [];
}
const ghStarts = (fx) => ghLines(fx).filter((l) => l.startsWith("start ")).length;

// `argv` is what follows the node binary; `entry` defaults to the hook itself.
function run(fx, { entry = HOOK, args = [], env = {}, hang = false, nodeOptions, timeoutMs = 120_000 } = {}) {
  const started = performance.now();
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    input: "",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: childEnv(fx, { hang, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}), ...env }),
  });
  const seconds = (performance.now() - started) / 1000;
  let json = null;
  try { json = JSON.parse(r.stdout || ""); } catch {}
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", seconds, json };
}

const reasonOf = (result) => String(result.json?.reason ?? result.json?.systemMessage ?? "");
// The launcher clause spliced into the block messages (launcherNote() in stop-run-supervisor.mjs). The digits are not pinned here:
// stop-run-supervisor-launcher-note.test.mjs owns the number and the wording; these tests only prove each message section carries it.
const LAUNCHER_NOTE = /hook launcher 逾時〔上限 [\d.]+ (?:秒|毫秒)〕會直接放行/u;
const prNumbersIn = (text) => [...String(text).matchAll(/PR #(\d+)/g)].map((m) => m[1]);

function preloadOption(fx, name, source) {
  const file = path.join(fx.root, name);
  writeFileSync(file, source);
  return `--import=${pathToFileURL(file).href}`;
}
// After 2 s of process life the wall clock steps back one hour; performance.now() is untouched.
const WALL_CLOCK_JUMP_PRELOAD = `const realNow = Date.now.bind(Date);
const t0 = performance.now();
Date.now = () => realNow() - (performance.now() - t0 > 2000 ? 3_600_000 : 0);
`;
// Date.now() = real time + offset (DC_CLOCK_OFFSET_MS at start); globalThis.__stepClockBack(ms) steps it back from then on.
const CLOCK_STEP_PRELOAD = `const realNow = Date.now.bind(Date);
let offset = Number(process.env.DC_CLOCK_OFFSET_MS || 0);
Date.now = () => realNow() + offset;
globalThis.__stepClockBack = (ms) => { offset -= ms; };
`;

// Test wrapper: imports the supervisor and calls superviseStopRun({ spawnSyncImpl }) with an injected spawnSync. The real worker
// is `[hook, "--stop-worker"]`. Every case prints how often the supervisor asked to spawn (must be exactly 1: no unsupervised rerun).
const WRAPPER = `import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [hook, supervisorModule] = process.argv.slice(2);
const mode = process.env.WRAP_MODE;
const sup = await import(pathToFileURL(supervisorModule).href);
let calls = 0;
process.on("exit", () => process.stderr.write("SPAWN_CALLS " + calls + " mode=" + mode + "\\n"));
const spawnSyncImpl = (cmd, _args, opts) => {
  calls += 1;
  if (mode === "eagain") return { error: Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }), status: null, signal: null, stdout: "", stderr: "", pid: 0 };
  if (mode === "enobufs-partial") return { error: Object.assign(new Error("spawnSync ENOBUFS"), { code: "ENOBUFS" }), status: 0, signal: null, stdout: '{"decision":"block","reason":"partial worker output that must not be relayed"', stderr: "", pid: 1 };
  if (mode === "enobufs-real") return spawnSync(cmd, [hook, "--stop-worker"], { ...opts, maxBuffer: 1 });
  if (mode === "enobufs-real-clockstep") {
    globalThis.__stepClockBack?.(600_000); // this process: the clock is now 10 minutes behind
    return spawnSync(cmd, [hook, "--stop-worker"], { ...opts, env: { ...opts.env, DC_CLOCK_OFFSET_MS: "-600000" }, maxBuffer: 1 }); // and the worker starts on the stepped clock
  }
  if (mode === "relay-ok") return { status: Number(process.env.WRAP_STATUS || 0), signal: null, stdout: "WORKER-STDOUT-BYTES\\n", stderr: "WORKER-STDERR-BYTES\\n", pid: 1 };
  if (mode === "signal") return { status: null, signal: "SIGKILL", stdout: "", stderr: "", pid: 1 };
  throw new Error("unknown WRAP_MODE " + mode);
};
sup.superviseStopRun({ spawnSyncImpl });
`;

function runWrapped(fx, mode, { env = {}, nodeOptions, timeoutMs = 120_000 } = {}) {
  const file = path.join(fx.root, "supervise-inject.mjs");
  writeFileSync(file, WRAPPER);
  return run(fx, {
    entry: file,
    args: [HOOK, SUPERVISOR_MODULE],
    env: { WRAP_MODE: mode, ...env },
    nodeOptions,
    timeoutMs,
  });
}
const spawnCallsOf = (result) => Number(/SPAWN_CALLS (\d+)/.exec(result.stderr)?.[1] ?? -1);

function reminderFileFor(fx) {
  const files = readdirSync(fx.reminderDir).filter((f) => f.includes("__stop_time_budget__"));
  assert.equal(files.length, 1, `exactly one __stop_time_budget__ reminder record: ${readdirSync(fx.reminderDir).join(",")}`);
  return path.join(fx.reminderDir, files[0]);
}

// ---- Hard Deadline Supervisor Kills The Worker And Blocks -----------------------------------------------------------

test("Hard Deadline Supervisor Kills The Worker And Blocks: every git call hangs, 8 s hard deadline, 3 markers", POSIX_ONLY, () => {
  // Every git call the hook makes hangs, including the import-time probe in recap-utils.mjs: this only stays inside the bound if
  // the supervisor is evaluated before the rest of the hook's import graph.
  const fx = makeFixture("hang-all");
  seedMarkers(fx, { count: 3 });
  const before = markerMap(fx);
  const result = run(fx, { hang: true, env: { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "8000" }, timeoutMs: HANG_BOUND_MS });
  assert.ok(!result.error, `the run must end by itself, not by the ${HANG_BOUND_MS} ms test bound (base: the hook just hangs): ${result.error?.code}`);
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block", `stdout: ${result.stdout}`);
  assert.match(reasonOf(result), /hard time limit reached/);
  assert.match(reasonOf(result), LAUNCHER_NOTE, "the hard-time-limit section names the launcher's fail-open limit");
  assert.ok(result.seconds <= 11, `8 s deadline plus at most 3 s of start-up and tail work, took ${result.seconds.toFixed(1)} s`);
  assert.deepEqual(markerMap(fx), before, "markers the killed worker never got to keep their names and bytes");
});

test("Failure Path Locates The Reminder Record With One Bounded Probe: no reminder directory configured and every git call hangs", POSIX_ONLY, () => {
  // Production shape: DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR is NOT set (every other test here sets it precisely so that the
  // failure path never runs git), so the supervisor finds the reminder directory through one main-checkout-root `git rev-parse`
  // probe. With git hanging, that probe costs its whole 2 s cap; the run still has to end inside hard deadline + 2 s + 3 s of tail.
  const fx = makeFixture("hang-default-reminder-dir");
  seedMarkers(fx, { count: 2 });
  const before = markerMap(fx);
  const env = { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "5000", DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: undefined };
  const first = run(fx, { hang: true, env, timeoutMs: HANG_BOUND_MS });
  assert.ok(!first.error, `the run must end by itself, not by the ${HANG_BOUND_MS} ms test bound: ${first.error?.code}`);
  assert.equal(first.status, 2, `stderr: ${first.stderr}; stdout: ${first.stdout}`);
  assert.equal(first.json?.decision, "block", `stdout: ${first.stdout}`);
  assert.match(reasonOf(first), /hard time limit reached/);
  assert.ok(first.seconds <= 10, `5 s deadline + the 2 s probe cap + at most 3 s of tail, took ${first.seconds.toFixed(1)} s`);
  assert.equal(readdirSync(fx.reminderDir).length, 0, "the configured-directory fixture was not used: this run resolved its own reminder location");
  // The record the first run wrote is found again by the second run (same probe, same fallback root), so the block downgrades.
  const second = run(fx, { hang: true, env, timeoutMs: HANG_BOUND_MS });
  assert.ok(!second.error, `the second run must also end by itself: ${second.error?.code}`);
  assert.equal(second.status, 0, `second run within 30 minutes downgrades; stderr: ${second.stderr}; stdout: ${second.stdout}`);
  assert.equal(second.json?.decision, undefined);
  assert.match(String(second.json?.systemMessage ?? ""), /hard time limit reached/);
  assert.ok(second.seconds <= 10, `second run took ${second.seconds.toFixed(1)} s`);
  assert.deepEqual(markerMap(fx), before, "neither run touched a marker");
});

test("Hard Deadline Supervisor Kills The Worker And Blocks: the deadline does not follow a wall clock that steps back mid-run", POSIX_ONLY, () => {
  const fx = makeFixture("hang-clock-jump");
  seedMarkers(fx, { count: 1 });
  const before = markerMap(fx);
  const result = run(fx, {
    hang: true,
    env: { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "5000" },
    nodeOptions: preloadOption(fx, "wallclock-jump.mjs", WALL_CLOCK_JUMP_PRELOAD),
    timeoutMs: HANG_BOUND_MS,
  });
  assert.ok(!result.error, `the run must end by itself: ${result.error?.code}`);
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.match(reasonOf(result), /hard time limit reached/);
  assert.ok(result.seconds <= 8, `5 s deadline plus at most 3 s, took ${result.seconds.toFixed(1)} s`);
  assert.deepEqual(markerMap(fx), before);
});

test("Hard Deadline Supervisor Kills The Worker And Blocks: a second run within 30 minutes is a soft reminder, and a cooperative time-budget block afterwards is throttled by the same record", POSIX_ONLY, () => {
  const fx = makeFixture("hang-soft");
  seedMarkers(fx, { count: 2 });
  const before = markerMap(fx);
  const first = run(fx, { hang: true, env: { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "3000" }, timeoutMs: HANG_BOUND_MS });
  assert.equal(first.status, 2, `first run blocks; stderr: ${first.stderr}; stdout: ${first.stdout}`);
  assert.match(reasonOf(first), /hard time limit reached/);
  const second = run(fx, { hang: true, env: { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "3000" }, timeoutMs: HANG_BOUND_MS });
  assert.equal(second.status, 0, `second run within 30 minutes downgrades; stderr: ${second.stderr}; stdout: ${second.stdout}`);
  assert.equal(second.json?.decision, undefined);
  assert.match(String(second.json?.systemMessage ?? ""), /hard time limit reached/);
  // Reminder interlock, supervisor -> worker: the git hang is gone, the cooperative deadline runs out. Both share the reserved key
  // and one 30-minute throttle, so this block is already reminded and downgrades.
  const third = run(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(third.status, 0, `the supervisor's record throttles the worker's block; stderr: ${third.stderr}; stdout: ${third.stdout}`);
  assert.match(String(third.json?.systemMessage ?? ""), /time budget exhausted/);
  assert.deepEqual(markerMap(fx), before, "no marker was touched by any of the three runs");
});

test("Hard Deadline Supervisor Kills The Worker And Blocks: reminder interlock the other way, a cooperative time-budget block first and a hard-deadline block second", POSIX_ONLY, () => {
  const fx = makeFixture("interlock-reverse");
  seedMarkers(fx, { count: 2 });
  const before = markerMap(fx);
  const first = run(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(first.status, 2, `the cooperative deadline blocks first; stderr: ${first.stderr}; stdout: ${first.stdout}`);
  assert.match(reasonOf(first), /time budget exhausted/);
  const second = run(fx, { hang: true, env: { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "3000" }, timeoutMs: HANG_BOUND_MS });
  assert.equal(second.status, 0, `the worker's record throttles the supervisor's block; stderr: ${second.stderr}; stdout: ${second.stdout}`);
  assert.match(String(second.json?.systemMessage ?? ""), /hard time limit reached/);
  assert.deepEqual(markerMap(fx), before);
});

// ---- Supervisor Spawn Or Buffer Error Blocks Without Rerun ----------------------------------------------------------

test("Supervisor Spawn Or Buffer Error Blocks Without Rerun: EAGAIN before any worker exists", POSIX_ONLY, () => {
  const fx = makeFixture("eagain");
  seedMarkers(fx, { count: 3 });
  const before = markerMap(fx);
  const result = runWrapped(fx, "eagain", { env: { FAKE_GH_DELAY_S: "0" } });
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block", `stdout: ${result.stdout}`);
  assert.match(reasonOf(result), /EAGAIN/);
  assert.match(reasonOf(result), LAUNCHER_NOTE, "the could-not-complete section names the launcher's fail-open limit");
  assert.equal(spawnCallsOf(result), 1, `spawnSyncImpl is called exactly once: ${result.stderr}`);
  assert.equal(ghStarts(fx), 0, "the hook body was not run in the supervisor's own process");
  assert.deepEqual(markerMap(fx), before);
});

test("Supervisor Spawn Or Buffer Error Blocks Without Rerun: ENOBUFS with partial worker output never relays that output", POSIX_ONLY, () => {
  const fx = makeFixture("enobufs-partial");
  seedMarkers(fx, { count: 3 });
  const before = markerMap(fx);
  const result = runWrapped(fx, "enobufs-partial", { env: { FAKE_GH_DELAY_S: "0" } });
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block", `stdout: ${result.stdout}`);
  assert.match(reasonOf(result), /ENOBUFS/);
  assert.ok(!result.stdout.includes("partial worker output"), "the truncated worker output is not forwarded");
  assert.equal(spawnCallsOf(result), 1, result.stderr);
  assert.equal(ghStarts(fx), 0);
  assert.deepEqual(markerMap(fx), before);
});

test("Supervisor Spawn Or Buffer Error Blocks Without Rerun: ENOBUFS after the worker already acted blocks, is not rerun, and is not downgraded by the worker's own record", POSIX_ONLY, () => {
  // maxBuffer 1 with a real worker: it clears one marker (6.5 s deadline, 2 s gh calls: the 2nd marker would start with ~4.3 s left,
  // under the 5 s minimum), writes its own time-budget block plus reminder record, and only then overflows the buffer.
  // A rerun in the supervisor's process would call gh again and clear more markers; a downgrade on the worker's record would be exit 0.
  const fx = makeFixture("enobufs-real");
  seedMarkers(fx, { count: 6 });
  const before = markerMap(fx);
  const result = runWrapped(fx, "enobufs-real", { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "6500", FAKE_GH_DELAY_S: "2" } });
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block", `stdout: ${result.stdout}`);
  assert.match(reasonOf(result), /ENOBUFS/);
  assert.equal(spawnCallsOf(result), 1, result.stderr);
  assert.equal(ghStarts(fx), 1, "one run's worth of work: the worker's single processed marker, no rerun");
  const after = markerMap(fx);
  assert.equal(Object.keys(before).length, 6);
  assert.equal(Object.keys(after).length, 5, "6 -> 5: exactly the marker the worker processed is gone");
  assertRemainingMarkersUnmodified(before, after, "the worker never got to");
});

// ---- Downgrade Ignores A Record Written By The Same Run -------------------------------------------------------------

test("Downgrade Ignores A Record Written By The Same Run: the system clock steps back 10 minutes and the worker's output is lost to ENOBUFS", POSIX_ONLY, () => {
  // The supervisor asks to spawn, its clock (and the worker's) steps back 10 minutes, the worker (6 markers, 3 s gh, 14 s deadline)
  // clears 3, writes its time-budget record, and its output overflows the buffer. A "record older than my start time" rule would
  // take the worker's record for a prior reminder and downgrade to exit 0; the run id rule blocks.
  const fx = makeFixture("clock-step-enobufs");
  seedMarkers(fx, { count: 6 });
  const before = markerMap(fx);
  const result = runWrapped(fx, "enobufs-real-clockstep", {
    env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "14000", FAKE_GH_DELAY_S: "3" },
    nodeOptions: preloadOption(fx, "clock-step.mjs", CLOCK_STEP_PRELOAD),
  });
  assert.equal(result.status, 2, `hard block, not a soft reminder; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block", `stdout: ${result.stdout}`);
  assert.equal(spawnCallsOf(result), 1, result.stderr);
  assert.equal(ghStarts(fx), 3, "the worker's one run of work, no rerun");
  const after = markerMap(fx);
  assert.equal(Object.keys(after).length, 3, "marker 6 -> 3");
  assertRemainingMarkersUnmodified(before, after, "the worker never got to");
});

test("Downgrade Ignores A Record Written By The Same Run: a record from a different run, or one without a run id, still downgrades within 30 minutes", POSIX_ONLY, () => {
  const fx = makeFixture("record-identity");
  seedMarkers(fx, { count: 1 });
  seedMarkers(fx, { count: 2 });
  const first = runWrapped(fx, "eagain");
  assert.equal(first.status, 2, `stderr: ${first.stderr}; stdout: ${first.stdout}`);
  const recordFile = reminderFileFor(fx);
  const written = JSON.parse(readFileSync(recordFile, "utf8"));
  assert.equal(typeof written.runId, "string", `the supervisor's own record carries its run id: ${JSON.stringify(written)}`);
  assert.ok(written.runId.length > 0);
  // A different run (a fresh wrapper process gets a fresh run id) within 30 minutes: soft reminder.
  const second = runWrapped(fx, "eagain");
  assert.equal(second.status, 0, `different run id downgrades; stderr: ${second.stderr}; stdout: ${second.stdout}`);
  assert.match(String(second.json?.systemMessage ?? ""), /EAGAIN/);
  // A legacy record with no run id at all: also a prior reminder.
  writeFileSync(recordFile, JSON.stringify({ remindedAt: new Date().toISOString() }));
  const third = runWrapped(fx, "eagain");
  assert.equal(third.status, 0, `a record without a run id downgrades; stderr: ${third.stderr}; stdout: ${third.stdout}`);
  assert.match(String(third.json?.systemMessage ?? ""), /EAGAIN/);
});

test("Downgrade Ignores A Record Written By The Same Run: the worker records the run id it was given, and writes none when it was given none", POSIX_ONLY, () => {
  // With DEVPRO_STOP_RUN_ID the worker's reminder record carries it; without, the record is byte-identical to today's.
  const withId = makeFixture("record-with-run-id");
  seedMarkers(withId, { count: 2 });
  const a = run(withId, { args: ["--stop-worker"], env: { DEVPRO_STOP_RUN_ID: "run-id-under-test", DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(a.status, 2, `the cooperative deadline blocks; stderr: ${a.stderr}; stdout: ${a.stdout}`);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(reminderFileFor(withId), "utf8"))).sort(), ["remindedAt", "runId"]);
  assert.equal(JSON.parse(readFileSync(reminderFileFor(withId), "utf8")).runId, "run-id-under-test");

  const without = makeFixture("record-without-run-id");
  seedMarkers(without, { count: 2 });
  const b = run(without, { args: ["--stop-worker"], env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(b.status, 2, `stderr: ${b.stderr}; stdout: ${b.stdout}`);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(reminderFileFor(without), "utf8"))), ["remindedAt"]);
});

// ---- Worker Terminated By A Signal Blocks Instead Of Passing Silently ------------------------------------------------

function processTable() {
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
function findWorkerBelow(rootPid) {
  const table = processTable();
  const below = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of table) if (!below.has(p.pid) && below.has(p.ppid)) { below.add(p.pid); grew = true; }
  }
  return table.find((p) => below.has(p.pid) && p.pid !== rootPid && p.command.includes("--stop-worker") && p.command.includes("post-pr-completion-check.mjs"));
}

test("Worker Terminated By A Signal Blocks Instead Of Passing Silently: an external SIGKILL through the real launcher", POSIX_ONLY, async () => {
  const fx = makeFixture("sigkill-worker");
  process.env.DEVPRO_HOOK_HOST = "claude-code";
  seedMarkers(fx, { count: 3 });
  process.env.DEVPRO_HOOK_HOST = "test";
  const before = markerMap(fx);
  const child = spawn(process.execPath, [RUN_HOOK, "Stop", HOOK, "--host=claude-code"], {
    cwd: fx.repo,
    env: childEnv(fx, { FAKE_GH_DELAY_S: "3", DEVPRO_HOOK_HOST: "claude-code", DEVPRO_AGENT_RULES_LEVEL: "full" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdin.end();
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));

  // Find THIS run's worker by walking the process tree under the launcher (a `pgrep -f` on the hook path would match any
  // concurrent run), then kill it from outside while it is still inside its first 3 s gh call.
  let killedPid = null;
  const deadline = Date.now() + 10_000;
  while (killedPid === null && Date.now() < deadline) {
    const worker = findWorkerBelow(child.pid);
    if (worker) {
      await new Promise((r) => setTimeout(r, 1200));
      try { process.kill(worker.pid, "SIGKILL"); killedPid = worker.pid; } catch { /* already gone */ }
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const { code, signal } = await closed;

  assert.notEqual(killedPid, null, "a --stop-worker child of the launcher's hook process must exist (base: the hook runs unsupervised, there is no worker)");
  assert.equal(signal, null, "the launcher itself was not signalled");
  // The block is the stdout JSON. The launcher re-exits 0 for a Stop gate's exit 2 plus block decision so every host
  // continues the turn; had the supervisor re-raised the signal, the launcher would see a null exit status and print nothing.
  assert.equal(code, 0, `launcher forwards the block decision and re-exits 0; stderr: ${stderr}; stdout: ${stdout}`);
  let json = null;
  try { json = JSON.parse(expandReminderDetailsOutput(stdout, fx.repo)); } catch {}
  assert.equal(json?.decision, "block", `stdout is the block JSON, which separates a block from a silent pass: ${stdout}`);
  assert.match(String(json?.reason ?? ""), /SIGKILL/);
  assert.doesNotMatch(stderr, /timed out/, "not the launcher's own timeout");
  assert.ok(ghStarts(fx) <= 1, `the supervisor does no gh work after the failure and does not rerun the hook: ${ghLines(fx).join(" | ")}`);
  const after = markerMap(fx);
  assertRemainingMarkersUnmodified(before, after, "the killed worker had not processed");
});

// ---- Supervisor Is Transparent When The Worker Finishes -------------------------------------------------------------

test("Supervisor Is Transparent When The Worker Finishes: injected worker results are relayed byte for byte", POSIX_ONLY, () => {
  const fx = makeFixture("relay");
  const ok = runWrapped(fx, "relay-ok");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "WORKER-STDOUT-BYTES\n");
  assert.ok(ok.stderr.startsWith("WORKER-STDERR-BYTES\n"), `stderr relayed unchanged: ${JSON.stringify(ok.stderr)}`);
  assert.equal(spawnCallsOf(ok), 1);
  const three = runWrapped(fx, "relay-ok", { env: { WRAP_STATUS: "3" } });
  assert.equal(three.status, 3, "the worker's exit code is the supervisor's exit code");
  assert.equal(three.stdout, "WORKER-STDOUT-BYTES\n");
});

test("Supervisor Is Transparent When The Worker Finishes: a supervised run equals the --stop-worker run for silent, cleared, hard-block and time-budget outcomes", POSIX_ONLY, () => {
  // The same scenario on two fresh fixtures (a run that blocks writes reminder state, so it cannot be repeated on one fixture).
  const scenarios = [
    { name: "no markers", count: 0, env: {} },
    { name: "markers cleared", count: 2, env: { FAKE_GH_DELAY_S: "0" }, expectStdout: "" },
    { name: "OPEN PR hard block", count: 1, env: { FAKE_GH_DELAY_S: "0", FAKE_GH_STATE: "OPEN" }, expectStatus: 2 },
    { name: "cooperative time-budget block", count: 2, env: { FAKE_GH_DELAY_S: "0", DEVPRO_STOP_HOOK_DEADLINE_MS: "4000" }, expectStatus: 2 },
  ];
  for (const scenario of scenarios) {
    const direct = makeFixture(`transparent-direct`);
    const supervised = makeFixture(`transparent-supervised`);
    seedMarkers(direct, { count: scenario.count });
    seedMarkers(supervised, { count: scenario.count });
    const viaWorker = run(direct, { args: ["--stop-worker"], env: scenario.env });
    const viaSupervisor = run(supervised, { env: scenario.env });
    const label = `scenario "${scenario.name}"`;
    if (scenario.expectStatus !== undefined) assert.equal(viaWorker.status, scenario.expectStatus, `${label}: precondition; ${viaWorker.stderr}${viaWorker.stdout}`);
    if (scenario.expectStdout !== undefined) assert.equal(viaWorker.stdout, scenario.expectStdout, `${label}: precondition`);
    assert.equal(viaSupervisor.status, viaWorker.status, `${label}: exit code`);
    assert.equal(viaSupervisor.stdout.replaceAll(supervised.repo, "<worktree>"), viaWorker.stdout.replaceAll(direct.repo, "<worktree>"), `${label}: stdout`);
    assert.equal(viaSupervisor.stderr, viaWorker.stderr, `${label}: stderr`);
    assert.deepEqual(Object.keys(markerMap(supervised)), Object.keys(markerMap(direct)), `${label}: marker outcome`);
    if (scenario.name === "markers cleared") {
      // Not vacuous on the base commit, where "supervised" and "direct" are the same unsupervised process: the work must really
      // have been done by a --stop-worker child (its parent command line names the flag).
      const parents = ghLines(supervised).filter((l) => l.startsWith("start "));
      assert.ok(parents.length > 0 && parents.every((l) => l.includes("--stop-worker")), `gh must be called from the --stop-worker child: ${parents.join(" | ")}`);
    }
  }
});

test("Supervisor Is Transparent When The Worker Finishes: it stays out of the way of --stop-worker, the cross-model reviewer and a test-runner import, and acts on a plain run", POSIX_ONLY, () => {
  // A 1 ms hard deadline makes a supervisor that wrongly acts kill the worker and block. No markers, so the outcome is silent
  // exit 0 whenever the supervisor stays out of it.
  const hardOneMs = { DEVPRO_STOP_HOOK_HARD_DEADLINE_MS: "1" };
  const worker = makeFixture("noact-worker");
  const asWorker = run(worker, { args: ["--stop-worker"], env: hardOneMs });
  assert.equal(asWorker.status, 0, `--stop-worker: ${asWorker.stderr}${asWorker.stdout}`);
  assert.equal(asWorker.stdout, "");

  const reviewer = makeFixture("noact-reviewer");
  const asReviewer = run(reviewer, { env: { ...hardOneMs, DEVPRO_CROSS_MODEL_REVIEWER: "1" } });
  assert.equal(asReviewer.status, 0, `cross-model reviewer: ${asReviewer.stderr}${asReviewer.stdout}`);
  assert.equal(asReviewer.stdout, "");

  const importer = makeFixture("noact-import");
  const importScript = path.join(importer.root, "import-hook.mjs");
  writeFileSync(importScript, `import(${JSON.stringify(pathToFileURL(HOOK).href)}).then((m) => { process.stdout.write("IMPORTED " + typeof m.__testSnapshotFromGhData); });\n`);
  const asImport = run(importer, { entry: importScript, env: hardOneMs });
  assert.equal(asImport.status, 0, `import from a test runner: ${asImport.stderr}${asImport.stdout}`);
  assert.equal(asImport.stdout, "IMPORTED function");

  // Control: the same 1 ms deadline on a plain hook run MUST act. Without this the three checks above pass on any hook, including
  // the base commit that has no supervisor at all.
  const control = makeFixture("noact-control");
  seedMarkers(control, { count: 1 });
  const plain = run(control, { env: hardOneMs, timeoutMs: HANG_BOUND_MS });
  assert.equal(plain.status, 2, `a plain run under a 1 ms hard deadline must block; stderr: ${plain.stderr}; stdout: ${plain.stdout}`);
  assert.equal(plain.json?.decision, "block");
  assert.match(reasonOf(plain), /hard time limit reached/);
});

// ---- structure -------------------------------------------------------------------------------------------------------

function importSpecifiers(source) {
  // Static `import ... from "x"` / `import "x"` declarations at the start of a line (doc comments start with ` *`), in file order.
  const found = [];
  const re = /^import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) found.push(m[1]);
  return found;
}

test("Supervisor Is Transparent When The Worker Finishes: the supervisor is the hook file's first import", () => {
  const specifiers = importSpecifiers(readFileSync(HOOK, "utf8"));
  assert.ok(specifiers.length > 5, "the import scan found the hook's imports");
  assert.equal(specifiers[0], "./lib/stop-run-supervisor.mjs", `first import is the supervisor, not ${specifiers[0]}: ES modules evaluate in import order, so anything earlier runs before the deadline timer starts`);
});

test("Supervisor Is Transparent When The Worker Finishes: the supervisor module imports only node built-ins and repo-state-identity", () => {
  assert.ok(existsSync(SUPERVISOR_MODULE), "hooks/lib/stop-run-supervisor.mjs exists");
  const source = readFileSync(SUPERVISOR_MODULE, "utf8");
  const specifiers = importSpecifiers(source);
  assert.ok(specifiers.length >= 3, "the import scan found the module's imports");
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith("node:") || specifier === "./repo-state-identity.mjs" || specifier === "./session-reminder.mjs" || specifier === "./post-pr-completion-state.mjs", `import-light: unexpected import ${specifier}`);
  }
  assert.ok(specifiers.includes("./repo-state-identity.mjs"));
  assert.doesNotMatch(source, /\bimport\s*\(/, "no dynamic import");
  assert.doesNotMatch(source, /\brequire\s*\(/, "no require");
});

test("host configuration: the Stop entry that runs post-pr-completion-check.mjs sets no timeout below 190 s", () => {
  // characterization: the three host configs carry no timeout today. A shorter one added later would cut the hook off before the
  // 165 s hard deadline can deliver its block. Claude Code and Codex nest the value in hooks[]; Cursor keeps it on the entry. Seconds.
  const hosts = [
    { file: ".claude/settings.json", stop: (j) => j.hooks?.Stop },
    { file: ".codex/hooks.json", stop: (j) => j.hooks?.Stop },
    { file: ".cursor/hooks.json", stop: (j) => j.hooks?.stop },
  ];
  for (const host of hosts) {
    const entries = host.stop(JSON.parse(readFileSync(repoPath(host.file), "utf8"))) ?? [];
    const matching = entries.filter((entry) => JSON.stringify(entry).includes("post-pr-completion-check.mjs"));
    assert.ok(matching.length >= 1, `${host.file} has a Stop entry for post-pr-completion-check.mjs`);
    for (const entry of matching) {
      const timeouts = [entry.timeout, ...(Array.isArray(entry.hooks) ? entry.hooks.map((h) => h.timeout) : [])].filter((t) => t !== undefined);
      for (const timeout of timeouts) {
        assert.ok(Number(timeout) >= 190, `${host.file}: Stop timeout ${timeout} s is below 190 s`);
      }
    }
  }
});
