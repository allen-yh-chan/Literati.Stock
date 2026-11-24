import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnWithReminderDetails as spawnSync } from "./lib/post-pr-reminder-fixtures.mjs";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// R7 (fix-codex-reviewer-intent-candidate-cap, T2f): the Stop hook's cooperative deadline.
//
// The hook is run as a child process against a throwaway git repo. `gh` is a fake on a child-only PATH (a fixed delay per
// call, an answer chosen by env), the deadline is shortened through DEVPRO_STOP_HOOK_DEADLINE_MS (it can only shorten, so no
// test waits for the real 150 s), and the wall clock is stepped through a `node --import` preload that lives in the fixture
// dir. Nothing here adds a production seam.
//
// The supervisor module (stop-run-supervisor.mjs, T9) does not exist on the base commit, so it is only ever loaded through
// a dynamic import inside the one test that needs it: a static import would fail the whole file at load time and hide which
// tests are red for a behavioural reason.
//
// Reading guide: tests marked "characterization" describe behaviour that already holds on the base commit and must keep
// holding; every other test is red on the base commit and goes green with T8 (cooperative deadline) / T9 (derivation).


// These gate fixtures explicitly own their PRs. Existing gate assertions read
// the full scoped diagnostic; the isolation suite asserts the compact transport.
process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;
process.env.DEVPRO_AGENT_RULES_LEVEL = "full";

const HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const SUPERVISOR_MODULE = repoPath(".devpro/scripts/hooks/lib/stop-run-supervisor.mjs");
const POSIX_ONLY = { skip: process.platform === "win32" ? "sh-based gh/git shims and node --import preloads are POSIX-only fixtures" : false };
const SESSION = "time-budget-session";
const tmpRoot = makeTempDir("post-pr-time-budget-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ---- fixtures -----------------------------------------------------------------------------------------------------

// Fake `gh`: one fixed delay per call, and the light / full call of a two-stage snapshot told apart by `files` in --json.
// `sleep & wait` with a TERM trap so that a timeout kill (spawnSync's default SIGTERM) ends the call instead of leaving an
// orphan `sleep` that keeps spawnSync waiting on the pipe. A call that runs to the end logs `end <kind>`; a killed call never does.
const GH_SHIM = `#!/bin/sh
kind=light
case "$*" in *files*) kind=full;; esac
if [ -n "\${FAKE_GH_FIRST_CALL_FLAG:-}" ] && [ ! -e "$FAKE_GH_FIRST_CALL_FLAG" ]; then : > "$FAKE_GH_FIRST_CALL_FLAG"; fi
d="\${FAKE_GH_DELAY_S:-0}"
if [ "$kind" = full ] && [ -n "\${FAKE_GH_FULL_DELAY_S:-}" ]; then d="$FAKE_GH_FULL_DELAY_S"; fi
parent=$(ps -o command= -p $PPID 2>/dev/null | tr '\\n' ' ')
printf 'start %s parent=%s\\n' "$kind" "$parent" >> "$FAKE_GH_LOG"
if [ "$kind" = light ] && [ -n "\${FAKE_GH_LIGHT_STARTED_FLAG:-}" ]; then : > "$FAKE_GH_LIGHT_STARTED_FLAG"; fi
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

let fixtureCounter = 0;
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A repo whose checked-out branch is the markers' branch: otherwise the hook files the markers as "not relevant to this
// turn" (skipped) and never judges them, which would make every assertion about judged markers pass or fail for the wrong reason.
function makeFixture(label, { branch = "bugfix/tb-change" } = {}) {
  const root = path.join(tmpRoot, `${fixtureCounter++}-${label}`);
  const repo = path.join(root, "repo");
  const shimDir = path.join(root, "shim");
  mkdirSync(repo, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  git(repo, "init", "-q", "-b", branch);
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(path.join(shimDir, "gh"), GH_SHIM);
  chmodSync(path.join(shimDir, "gh"), 0o755);
  const dirs = {
    stateDir: path.join(root, "state"),
    reminderDir: path.join(root, "reminder"),
    advisoryDir: path.join(root, "advisory"),
    usageDir: path.join(root, "usage"),
    claudeRoot: path.join(root, "claude-root"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return { label, root, repo, shimDir, branch, ghLog: path.join(root, "gh-calls.log"), gitLog: path.join(root, "git-calls.log"), ...dirs };
}

// Markers are seeded through the production writer. They are aged: the hook's own clocks (and the wall-clock step used in
// some cases) must never make a marker look "not due yet", which would end the run silently and prove nothing.
function seedMarkers(fx, { count, ageS = 4000, withPrNumber = true, firstNumber = 9001 }) {
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
        prNumber: withPrNumber ? number : "",
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

// name -> sha256(bytes): "unchanged" means the same file names AND the same bytes, not merely the same count.
function markerMap(fx) {
  const out = {};
  for (const name of readdirSync(fx.stateDir).filter((f) => f.endsWith(".json")).sort()) {
    out[name] = createHash("sha256").update(readFileSync(path.join(fx.stateDir, name))).digest("hex");
  }
  return out;
}

function markerPrs(fx) {
  const out = {};
  for (const name of readdirSync(fx.stateDir).filter((f) => f.endsWith(".json"))) {
    out[name] = String(JSON.parse(readFileSync(path.join(fx.stateDir, name), "utf8")).prNumber);
  }
  return out;
}

function assertRemainingMarkersUnmodified(before, after, message = "") {
  for (const [name, digest] of Object.entries(after)) {
    assert.equal(before[name], digest, `marker ${name} must keep its name and bytes ${message}`);
  }
}

const STRIP_FROM_CHILD_ENV = /^(DEVPRO_POST_PR_GATE_MOCK_|DEVPRO_STOP_|DEVPRO_HOOK_|DEVPRO_CROSS_MODEL_REVIEWER$|NODE_OPTIONS$|FAKE_GH_)/;
function childEnv(fx, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIP_FROM_CHILD_ENV.test(key)) env[key] = value;
  }
  return {
    ...env,
    PATH: `${fx.shimDir}${path.delimiter}${process.env.PATH}`,
    HOME: fx.root,
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: fx.stateDir,
    DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR: fx.reminderDir,
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
    DEVPRO_TEST_GIT_LOG: fx.gitLog,
    ...extra,
  };
}

function ghLines(fx) {
  return existsSync(fx.ghLog) ? readFileSync(fx.ghLog, "utf8").split("\n").filter(Boolean) : [];
}
const ghStarts = (fx) => ghLines(fx).filter((l) => l.startsWith("start ")).length;

// Logs the argv of every `git` the hook process spawns and forwards to the real git (the cross-platform child-only
// preload pattern of recap-utils.test.mjs; nothing on the parent's PATH, no production seam).
const GIT_LOG_PRELOAD = `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = childProcess.spawnSync;
childProcess.spawnSync = function loggedSpawnSync(file, args) {
  if (file === "git" && Array.isArray(args) && process.env.DEVPRO_TEST_GIT_LOG) appendFileSync(process.env.DEVPRO_TEST_GIT_LOG, JSON.stringify(args) + "\\n");
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
`;
const worktreeListCalls = (fx) => (existsSync(fx.gitLog) ? readFileSync(fx.gitLog, "utf8").split("\n").filter(Boolean) : [])
  .map((line) => JSON.parse(line))
  .filter((args) => args[0] === "worktree" && args[1] === "list" && args.includes("-z")).length;

function runHook(fx, { env = {}, nodeOptions, timeoutMs = 120_000 } = {}) {
  const started = performance.now();
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: fx.repo,
    encoding: "utf8",
    input: "",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: childEnv(fx, { FAKE_GH_FIRST_CALL_FLAG: path.join(fx.root, "first-gh-call"), ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}), ...env }),
  });
  const endedAt = Date.now();
  const seconds = (performance.now() - started) / 1000;
  let json = null;
  try { json = JSON.parse(r.stdout || ""); } catch {}
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", seconds, endedAt, json };
}

// Seconds from the first gh call to the hook's exit, which the two deadline tests below bound instead of the whole run.
// The hook's start-up, which a busy machine (the full integration run) stretches by seconds, all comes before the first
// gh call; every gh call the deadline governs comes after it. The shim marks that call once, so a later call (the
// branch-only marker makes three) does not move it.
function secondsSinceFirstGhCall(fx, result) {
  return (result.endedAt - statSync(path.join(fx.root, "first-gh-call")).mtimeMs) / 1000;
}

// Preloads (node --import) live in the fixture dir and only reach the hook processes through NODE_OPTIONS of that run.
function preloadOption(fx, name, source) {
  const file = path.join(fx.root, name);
  writeFileSync(file, source);
  return `--import=${pathToFileURL(file).href}`;
}
// After 2 s of process life the wall clock (Date.now) steps back one hour; performance.now() is untouched.
const WALL_CLOCK_JUMP_PRELOAD = `const realNow = Date.now.bind(Date);
const t0 = performance.now();
Date.now = () => realNow() - (performance.now() - t0 > 2000 ? 3_600_000 : 0);
`;

// Same step, but triggered by the fake gh's first (light) call instead of a timer: the step is then guaranteed to land inside the
// light call however slow the hook's start-up was (a timer could fire before the snapshot window is even opened).
const WALL_CLOCK_JUMP_AFTER_LIGHT_CALL_PRELOAD = `import { existsSync } from "node:fs";
const realNow = Date.now.bind(Date);
Date.now = () => realNow() - (existsSync(process.env.FAKE_GH_LIGHT_STARTED_FLAG) ? 3_600_000 : 0);
`;

const prNumbersIn = (text) => [...String(text).matchAll(/PR #(\d+)/g)].map((m) => m[1]);
const reasonOf = (result) => String(result.json?.reason ?? result.json?.systemMessage ?? "");
// The launcher clause spliced into the block messages (launcherNote() in stop-run-supervisor.mjs). The digits are not pinned here:
// stop-run-supervisor-launcher-note.test.mjs owns the number and the wording; these tests only prove each message section carries it.
const LAUNCHER_NOTE = /hook launcher 逾時〔上限 [\d.]+ (?:秒|毫秒)〕會直接放行/u;

// ---- shared scenario: 6 same-branch markers, 3 s gh, 14 s cooperative deadline ----------------------------------------
// 14 s keeps the "less than 5 s remain" test at least ~0.6 s from either edge: the 4th marker starts with ~4.4 s left, the
// 3rd with ~7.6 s, whatever the startup cost. The run costs ~10 s, so it is executed once and shared by the tests below.
let sixMarkerRun = null;
function getSixMarkerRun() {
  if (!sixMarkerRun) {
    const fx = makeFixture("six-markers");
    seedMarkers(fx, { count: 6 });
    const before = markerMap(fx);
    const prByFile = markerPrs(fx);
    const result = runHook(fx, {
      env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "14000", FAKE_GH_DELAY_S: "3" },
      nodeOptions: preloadOption(fx, "git-log.mjs", GIT_LOG_PRELOAD),
    });
    sixMarkerRun = { fx, before, prByFile, after: markerMap(fx), result, ghCalls: ghStarts(fx) };
  }
  return sixMarkerRun;
}

function assertCooperativeBlock({ fx, before, after, prByFile, result, ghCalls }) {
  assert.equal(result.status, 2, `expected exit 2; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block", `stdout: ${result.stdout}`);
  const reason = reasonOf(result);
  assert.match(reason, /time budget exhausted/);
  const remainingNames = Object.keys(after);
  assert.equal(remainingNames.length, 3, `3 of 6 markers are processed and cleared, 3 stay: ${remainingNames.join(",")}`);
  assert.equal(ghCalls, 3, "one gh call per processed marker, none for the unprocessed ones");
  assertRemainingMarkersUnmodified(before, after, `when ${fx.label} leaves it unprocessed`);
  const listed = prNumbersIn(reason);
  for (const name of Object.keys(before)) {
    const pr = prByFile[name];
    if (name in after) assert.ok(listed.includes(pr), `unprocessed PR #${pr} must be named in the reason:\n${reason}`);
    else assert.ok(!listed.includes(pr), `processed PR #${pr} must not be listed as unprocessed:\n${reason}`);
  }
}

// ---- R7 behaviour --------------------------------------------------------------------------------------------------

test("Cooperative Deadline Blocks And Keeps Unprocessed Markers: 6 markers at 3 s each under a 14 s deadline", POSIX_ONLY, () => {
  assertCooperativeBlock(getSixMarkerRun());
});

test("Same-Branch Markers Share One Successful Worktree Enumeration: a run cut short by the time budget still lists the worktrees once", POSIX_ONLY, () => {
  // R5 x R7: three markers go through the per-marker stall query before the deadline stops the loop. Without the shared handle
  // each of them would list the worktrees again (3 calls); the unprocessed markers never reach the query, so they add none.
  const run = getSixMarkerRun();
  assert.equal(run.ghCalls, 3, "control: three markers really went through the per-marker evaluation");
  assert.equal(worktreeListCalls(run.fx), 1, "one successful enumeration serves every processed marker of the run");
});

test("Cooperative Deadline Blocks And Keeps Unprocessed Markers: the same run still blocks when the wall clock steps back one hour mid-run", POSIX_ONLY, () => {
  // v9's wall-clock budget processed all 6 markers here and exited 0: after the step Date.now() is an hour behind, so the
  // remaining budget looks huge. The monotonic budget must not care.
  const fx = makeFixture("clock-step");
  seedMarkers(fx, { count: 6 });
  const before = markerMap(fx);
  const prByFile = markerPrs(fx);
  const result = runHook(fx, {
    env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "14000", FAKE_GH_DELAY_S: "3" },
    nodeOptions: preloadOption(fx, "wallclock-jump.mjs", WALL_CLOCK_JUMP_PRELOAD),
  });
  assertCooperativeBlock({ fx, before, prByFile, after: markerMap(fx), result, ghCalls: ghStarts(fx) });
});

test("Time Budget Exhaustion Never Exits Silently Without Pending Markers: every judged marker was cleared, only unprocessed ones remain", POSIX_ONLY, () => {
  // All processed markers are MERGED and cleared, so nothing is judged still pending: this is the branch that used to end in
  // the silent `stillPending.length === 0 && !costCircuitBreakerHit` exit 0.
  const { result } = getSixMarkerRun();
  assert.notEqual(result.status, 0, "must not exit 0");
  assert.ok(result.stdout.trim().length > 0, "must not be silent");
  const reason = reasonOf(result);
  assert.match(reason, /### Post-PR completion check time budget exhausted/);
  assert.match(reason, LAUNCHER_NOTE, "the cooperative time-budget block names the launcher's fail-open limit");
  assert.doesNotMatch(reason, /Post-PR completion gate hard-block/, "no pending-marker hard-block body: nothing was judged pending");
});

test("Time Budget Exhaustion Never Exits Silently Without Pending Markers: a deadline shorter than one marker's minimum leaves every marker unprocessed", POSIX_ONLY, () => {
  // 4 s < the 5 s per-marker minimum: no marker may be started, none cleared or judged, and the run must still speak.
  const fx = makeFixture("zero-processed");
  seedMarkers(fx, { count: 2 });
  const before = markerMap(fx);
  const result = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "2" } });
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block");
  const reason = reasonOf(result);
  assert.match(reason, /time budget exhausted/);
  for (const pr of ["9001", "9002"]) assert.ok(prNumbersIn(reason).includes(pr), `PR #${pr} unprocessed and named:\n${reason}`);
  assert.deepEqual(markerMap(fx), before, "every marker keeps its name and bytes");
  assert.equal(ghStarts(fx), 0, "no gh call for a marker that was never started");
});

test("Time Budget Block Joins The Jointly Gated Downgrade: a repeat turn that only has the time budget downgrades with a time-budget sentence, not a cost-circuit-breaker one", POSIX_ONLY, () => {
  // No cost-circuit-breaker or disclosure item exists here, so the soft reminder must not tell the user that an override can lift
  // the state: DEVPRO_COST_BUDGET_OVERRIDE has no effect on the time budget.
  const fx = makeFixture("tb-only-soft");
  seedMarkers(fx, { count: 2 });
  const before = markerMap(fx);
  const first = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(first.status, 2, `precondition: the time budget hard-blocks; stderr: ${first.stderr}; stdout: ${first.stdout}`);
  const second = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(second.status, 0, `soft reminder within 30 minutes; stderr: ${second.stderr}; stdout: ${second.stdout}`);
  const message = String(second.json?.systemMessage ?? "");
  assert.match(message, /^此時間預算狀態已在 30 分鐘內 hard-block 過；本次改為 soft reminder/u, message);
  assert.doesNotMatch(message, /成本斷路器狀態|override 或使用者決定前/u, "no cost-circuit-breaker sentence when only the time budget is reported");
  assert.match(message, /time budget exhausted/);
  for (const pr of ["9001", "9002"]) assert.ok(prNumbersIn(message).includes(pr), `unprocessed PR #${pr} still listed`);
  assert.deepEqual(markerMap(fx), before, "neither turn touched a marker");
});

test("Time Budget Block Joins The Jointly Gated Downgrade: an unreminded time-budget key hard-blocks even when every other key was reminded", POSIX_ONLY, () => {
  const change = "tb-stall";
  const fx = makeFixture("jointly-gated", { branch: `chore/${change}` });
  // `stalled_rounds` is reachable in a few lines: an unreadable receipt in a real repo cwd blocks the cost circuit breaker.
  mkdirSync(path.join(fx.repo, "openspec", "changes", change), { recursive: true });
  mkdirSync(path.join(fx.repo, "notes"), { recursive: true });
  writeFileSync(path.join(fx.repo, "notes", `review-${change}-receipt-r1.json`), "this is not a sealed receipt\n");

  // Turn 1: only the cost circuit breaker stops (fast gh, no time pressure). Its key is now reminded.
  seedMarkers(fx, { count: 1 });
  const turn1 = runHook(fx, { env: { FAKE_GH_DELAY_S: "0" } });
  assert.equal(turn1.status, 2, `precondition: the stall blocks on its own; stderr: ${turn1.stderr}; stdout: ${turn1.stdout}`);
  assert.match(reasonOf(turn1), /stalled_rounds/, "precondition: the stall is the reason");
  assert.equal(readdirSync(fx.reminderDir).some((f) => f.includes(change)), true, "precondition: the breaker key was reminded");

  // Turn 2: the same breaker item plus the time budget running out. The breaker key was reminded already, the time-budget key
  // was not: the turn must still hard-block (on the base commit it downgrades to a soft reminder and exits 0).
  seedMarkers(fx, { count: 6 });
  const turn2 = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "14000", FAKE_GH_DELAY_S: "3" } });
  assert.equal(turn2.status, 2, `an unreminded __stop_time_budget__ hard-blocks; stderr: ${turn2.stderr}; stdout: ${turn2.stdout}`);
  assert.equal(turn2.json?.decision, "block");
  assert.match(reasonOf(turn2), /time budget exhausted/);
  assert.match(reasonOf(turn2), /stalled_rounds/, "the breaker item is still reported on the same turn");

  // Turn 3, within 30 minutes: every key (breaker and __stop_time_budget__) has been reminded, so the time budget running out
  // again downgrades to a soft systemMessage that still names the unprocessed PRs.
  seedMarkers(fx, { count: 2 });
  const turn3 = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "4000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(turn3.status, 0, `soft reminder once every key was reminded; stderr: ${turn3.stderr}; stdout: ${turn3.stdout}`);
  assert.equal(turn3.json?.decision, undefined);
  assert.match(String(turn3.json?.systemMessage ?? ""), /time budget exhausted/);
  for (const pr of ["9001", "9002"]) assert.ok(prNumbersIn(turn3.json?.systemMessage).includes(pr), `unprocessed PR #${pr} still listed in the soft reminder`);
});

test("Two-Stage Snapshot Stays Inside The Monotonic Window: the full-fields call is bounded by the monotonic remainder after a wall-clock step", POSIX_ONLY, () => {
  // One PR-number marker whose PR is OPEN with no sticky: light call (3 s, inside the step), then the full call. The snapshot
  // window is 5 s. The wall clock steps back one hour as soon as the light call starts; a wall-clock window then hands the full call an
  // hour-long timeout, and this fake full call (15 s) would run to the end. The monotonic window leaves it ~1.6 s.
  const fx = makeFixture("two-stage");
  seedMarkers(fx, { count: 1 });
  const result = runHook(fx, {
    env: { FAKE_GH_STATE: "OPEN", FAKE_GH_DELAY_S: "3", FAKE_GH_FULL_DELAY_S: "15", FAKE_GH_LIGHT_STARTED_FLAG: path.join(fx.root, "light-call-started") },
    nodeOptions: preloadOption(fx, "wallclock-jump-after-light.mjs", WALL_CLOCK_JUMP_AFTER_LIGHT_CALL_PRELOAD),
  });
  const lines = ghLines(fx);
  assert.ok(lines.some((l) => l.startsWith("end light")), `the light call completes (3 s < 5 s window): ${lines.join(" | ")}`);
  assert.ok(!lines.some((l) => l.startsWith("end full")), `the full call must be cut off by the monotonic window, not run its 15 s: ${lines.join(" | ")}`);
  const span = secondsSinceFirstGhCall(fx, result);
  assert.ok(span < 10, `the gh calls stay near the 5 s window: ${span.toFixed(1)} s from the first gh call to exit (whole run ${result.seconds.toFixed(1)} s)`);
});

test("Cooperative Deadline Blocks And Keeps Unprocessed Markers: both gh calls of a branch-only marker are bounded by the remaining time", POSIX_ONLY, () => {
  // A marker without a PR number is judged through `gh pr list` and then `gh pr view` (light, then full). 7.2 s deadline, 4.5 s
  // per call: ~2.1 s remain after the first call. On the base commit every later call runs its own fixed 5 s window, so the run
  // takes ~10 s; bounded by the remaining time it ends ~7.2 s.
  const fx = makeFixture("branch-only");
  seedMarkers(fx, { count: 1, withPrNumber: false });
  const result = runHook(fx, {
    env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "7200", FAKE_GH_STATE: "OPEN", FAKE_GH_DELAY_S: "4.5", FAKE_GH_FULL_DELAY_S: "30" },
  });
  const lines = ghLines(fx);
  assert.ok(lines.some((l) => l.startsWith("end light")), `precondition: the marker was started and its light call finished: ${lines.join(" | ")}; stderr: ${result.stderr}`);
  assert.ok(!lines.some((l) => l.startsWith("end full")), "the full call never gets to finish its 30 s");
  const span = secondsSinceFirstGhCall(fx, result);
  assert.ok(span < 8.6, `the second gh call is cut to the remaining time; ${span.toFixed(1)} s from the first gh call to exit (whole run ${result.seconds.toFixed(1)} s; base: ~10 s)`);
});

// ---- characterization: what must not change ------------------------------------------------------------------------

test("characterization: markers that all finish inside the time budget behave exactly as before (silent exit 0, all cleared)", POSIX_ONLY, () => {
  const fx = makeFixture("within-budget");
  seedMarkers(fx, { count: 3 });
  const result = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "60000", FAKE_GH_DELAY_S: "0" } });
  assert.equal(result.status, 0, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.stdout, "", "no output, no time-budget section");
  assert.equal(result.stderr, "");
  assert.deepEqual(markerMap(fx), {}, "every MERGED marker is cleared");
  assert.equal(ghStarts(fx), 3, "one gh call per marker");
});

test("characterization: an OPEN PR still hard-blocks as a pending marker and carries no time-budget section", POSIX_ONLY, () => {
  const fx = makeFixture("open-pr");
  seedMarkers(fx, { count: 1 });
  const before = markerMap(fx);
  const result = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "60000", FAKE_GH_STATE: "OPEN", FAKE_GH_DELAY_S: "0" } });
  assert.equal(result.status, 2, `stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.json?.decision, "block");
  const reason = reasonOf(result);
  assert.match(reason, /Post-PR completion gate hard-block/);
  assert.ok(prNumbersIn(reason).includes("9001"));
  assert.doesNotMatch(reason, /time budget exhausted/);
  assert.equal(Object.keys(markerMap(fx)).length, Object.keys(before).length, "a pending marker stays");
});

test("characterization: no pending markers still exits 0 silently, even with a 1 ms cooperative deadline", POSIX_ONLY, () => {
  const fx = makeFixture("no-markers");
  const result = runHook(fx, { env: { DEVPRO_STOP_HOOK_DEADLINE_MS: "1" } });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, "", "the time budget only speaks when a marker was left unprocessed");
  assert.equal(ghStarts(fx), 0);
});

// ---- deadline derivation -------------------------------------------------------------------------------------------

const ENV_LAUNCHER = "DEVPRO_HOOK_TIMEOUT_MS";
const ENV_HARD = "DEVPRO_STOP_HOOK_HARD_DEADLINE_MS";
const ENV_COOP = "DEVPRO_STOP_HOOK_DEADLINE_MS";

test("Deadlines Derive From The Launcher Limit And Only Shorten: defaults, the documented table, and every override shape", async () => {
  // Dynamic import on purpose: on the base commit the module does not exist and only this test may fail because of that.
  const sup = await import(pathToFileURL(SUPERVISOR_MODULE).href);
  const derive = (env) => ({
    launcher: sup.resolveLauncherTimeoutMs(env),
    hard: sup.resolveStopHardDeadlineMs(env),
    coop: sup.resolveStopRunDeadlineMs(env),
  });
  const rows = [
    // [env, launcher, hard, coop]
    [{}, 180000, 165000, 150000],
    [{ [ENV_LAUNCHER]: "60000" }, 60000, 45000, 33750],
    [{ [ENV_LAUNCHER]: "30000" }, 30000, 22500, 16875],
    [{ [ENV_LAUNCHER]: "10000" }, 10000, 7500, 5625],
    [{ [ENV_LAUNCHER]: "500" }, 500, 375, 282],
    [{ [ENV_LAUNCHER]: "1" }, 1, 1, 1],
    [{ [ENV_LAUNCHER]: "999999" }, 180000, 165000, 150000],
    [{ [ENV_HARD]: "8000" }, 180000, 8000, 6000],
    [{ [ENV_HARD]: "0.5" }, 180000, 1, 1],
    [{ [ENV_COOP]: "0.5" }, 180000, 165000, 1],
    [{ [ENV_COOP]: "14000" }, 180000, 165000, 14000],
    [{ [ENV_HARD]: "100000" }, 180000, 100000, 85000],
    // larger than the default never raises a limit; non-numeric, zero and negative fall back to the default
    [{ [ENV_HARD]: "999999", [ENV_COOP]: "999999" }, 180000, 165000, 150000],
    [{ [ENV_LAUNCHER]: "abc", [ENV_HARD]: "x", [ENV_COOP]: "y" }, 180000, 165000, 150000],
    [{ [ENV_LAUNCHER]: "0", [ENV_HARD]: "0", [ENV_COOP]: "0" }, 180000, 165000, 150000],
    [{ [ENV_LAUNCHER]: "-5", [ENV_HARD]: "-1", [ENV_COOP]: "-1" }, 180000, 165000, 150000],
    [{ [ENV_LAUNCHER]: "500", [ENV_HARD]: "0.5" }, 500, 1, 1],
  ];
  for (const [env, launcher, hard, coop] of rows) {
    assert.deepEqual(derive(env), { launcher, hard, coop }, `env ${JSON.stringify(env)}`);
  }

  // Property sweep: whatever the combination, all three are integers >= 1 with coop <= hard <= launcher, an outer limit of
  // at least 4 ms leaves the inner one strictly below it, and no override raises a limit above its default.
  const launchers = [undefined, "", "abc", "0", "-5", "0.5", "1", "2", "3", "4", "5", "7", "9", "10", "99", "100", "499", "500", "501", "999", "1000", "1001", "9999", "10000", "29999", "30000", "60000", "179999", "180000", "180001", "999999", "Infinity"];
  const hards = [undefined, "", "0", "0.5", "1", "3", "8000", "164999", "165000", "999999", "x"];
  const coops = [undefined, "", "0", "0.5", "1", "3", "14000", "149999", "150000", "999999", "x"];
  let combinations = 0;
  for (const l of launchers) for (const h of hards) for (const c of coops) {
    const env = {};
    if (l !== undefined) env[ENV_LAUNCHER] = l;
    if (h !== undefined) env[ENV_HARD] = h;
    if (c !== undefined) env[ENV_COOP] = c;
    const { launcher, hard, coop } = derive(env);
    const label = `env ${JSON.stringify(env)} -> ${JSON.stringify({ launcher, hard, coop })}`;
    combinations += 1;
    for (const [name, value] of Object.entries({ launcher, hard, coop })) {
      assert.ok(Number.isInteger(value) && value >= 1, `${name} is an integer >= 1: ${label}`);
    }
    assert.ok(hard <= launcher, `hard <= launcher: ${label}`);
    assert.ok(coop <= hard, `coop <= hard: ${label}`);
    if (launcher >= 4) assert.ok(hard < launcher, `hard strictly below a launcher >= 4 ms: ${label}`);
    if (hard >= 4) assert.ok(coop < hard, `coop strictly below a hard limit >= 4 ms: ${label}`);
    assert.ok(launcher <= 180000 && hard <= 165000 && coop <= 150000, `no override raises a limit above its default: ${label}`);
  }
  assert.equal(combinations, launchers.length * hards.length * coops.length);
});
