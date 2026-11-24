/**
 * Hard time limit for the post-PR Stop hook (R8).
 *
 * run-hook.mjs kills a hook at MAX_HOOK_TIMEOUT_MS (180 s) and that timeout is fail-open on every host profile, so a
 * hook that overruns is silently skipped. The hook's own cooperative deadline (R7) only takes effect between markers; the
 * work inside one marker, and even the hook's module imports, are synchronous and cannot be interrupted from inside the
 * process. So the real work runs in a WORKER process (this hook script with STOP_WORKER_ARG) and this module -- evaluated
 * FIRST, before the rest of the hook's import graph -- is the parent that does nothing but wait. At STOP_HARD_DEADLINE_MS it
 * kills the worker and blocks, so the hook answers before the launcher's fail-open. The worker's markers are left as they
 * are: a marker is only cleared on positive evidence, so a killed worker can leave a marker in place, never clear one wrongly.
 *
 * KEEP THIS MODULE IMPORT-LIGHT (built-ins and side-effect-free identity/state helpers): whatever it imports runs in the parent, before the
 * deadline timer starts. (recap-utils.mjs, for one, resolves a state directory at import time and spends up to 8 s doing it
 * when git hangs.)
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultRepoStateDir } from "./repo-state-identity.mjs";
import { resolveReminderSession, compactReminder } from "./session-reminder.mjs";
import { listOwnedPostPrStopMarkers } from "./post-pr-completion-state.mjs";

// The three deadlines, outermost first: the launcher (run-hook.mjs MAX_HOOK_TIMEOUT_MS, SIGKILL + fail-open) at 180 s; the hard limit
// below it (this module kills the worker); the cooperative limit below that (the hook stops between markers and can name the
// unprocessed PRs). Each inner one keeps a margin under the one outside it, and each env override can only shorten.
export const LAUNCHER_TIMEOUT_MS = 180_000;
export const STOP_HARD_DEADLINE_MS = 165_000;
export const STOP_RUN_DEADLINE_MS = 150_000;
export const STOP_WORKER_ARG = "--stop-worker";
// Per-run identity: the parent generates one id per run and hands it to the worker, whose reminder record carries it back (hook:
// markCostCircuitBreakerReminded). The parent uses it to tell "a record written by THIS run" from "a record from an earlier run"
// without comparing timestamps (a wall-clock comparison breaks when the clock steps back during the run).
export const STOP_RUN_ID_ENV = "DEVPRO_STOP_RUN_ID";
// Shared with the hook's own cooperative time-budget block (R7): one 30-minute throttle for both.
export const STOP_TIME_BUDGET_REMINDER_KEY = "__stop_time_budget__";
const REMINDER_DEDUP_MS = 30 * 60_000;
const REMINDER_STATE_PREFIX = "devpro-post-pr-cost-breaker-reminder";

/**
 * An env-var deadline may only SHORTEN the default (same shape as run-hook.mjs's DEVPRO_HOOK_TIMEOUT_MS), and a positive value never
 * becomes 0: spawnSync treats `timeout: 0` as "no timeout", so a value like 0.5 must round UP to 1 ms, not down to 0.
 * (run-hook.mjs itself floors 0.5 to 0 and so runs its child with no timeout at all; that is existing behavior, not copied here.)
 */
export function resolveShortenOnlyMs(raw, defaultMs) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return Math.min(Math.max(1, Math.floor(parsed)), defaultMs);
}

const marginBelow = (ms) => Math.min(15_000, Math.floor(ms / 4));

// The launcher reads the same shorten-only DEVPRO_HOOK_TIMEOUT_MS as run-hook.mjs (and the OpenCode plugin), so the deadlines below
// follow it: with the variable at 60000 the hard limit is 45 s, not 165 s (otherwise the launcher would fail open before either fires).
// Every inner deadline is a positive integer (>= 1 ms) and never above the one outside it: hard <= launcher, coop <= hard, and both are
// strictly below once the outer one is >= 4 ms. There is deliberately no floor ABOVE the outer deadline: a 1000 ms floor under a 500 ms
// launcher would put the hard limit behind the launcher's fail-open. (A launcher limit this small cannot start node and the hook in time
// anyway; supported range is DEVPRO_HOOK_TIMEOUT_MS >= 10000 -- below that the ordering still holds but the block may not arrive first.)
export function resolveLauncherTimeoutMs(env = process.env) {
  return resolveShortenOnlyMs(env.DEVPRO_HOOK_TIMEOUT_MS, LAUNCHER_TIMEOUT_MS);
}

export function resolveStopHardDeadlineMs(env = process.env) {
  const launcherMs = resolveLauncherTimeoutMs(env);
  const ceilingMs = Math.max(1, launcherMs - marginBelow(launcherMs));
  return Math.min(resolveShortenOnlyMs(env.DEVPRO_STOP_HOOK_HARD_DEADLINE_MS, STOP_HARD_DEADLINE_MS), ceilingMs);
}

export function resolveStopRunDeadlineMs(env = process.env) {
  const hardMs = resolveStopHardDeadlineMs(env);
  const ceilingMs = Math.max(1, hardMs - marginBelow(hardMs));
  return Math.min(resolveShortenOnlyMs(env.DEVPRO_STOP_HOOK_DEADLINE_MS, STOP_RUN_DEADLINE_MS), ceilingMs);
}

function sanitizeToken(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

// Same file the hook's own reminder helpers use (post-pr-completion-check.mjs: costCircuitBreakerReminderDir/File).
function reminderFile(cwd, session, env = process.env) {
  const dir = env.DEVPRO_POST_PR_COST_BREAKER_REMINDER_STATE_DIR || defaultRepoStateDir(REMINDER_STATE_PREFIX, cwd);
  return path.join(dir, `${session.key}__${sanitizeToken(STOP_TIME_BUDGET_REMINDER_KEY)}.json`);
}

export const formatDuration = (ms) => (ms < 1000 ? `${ms} 毫秒` : ms % 1000 === 0 ? `${ms / 1000} 秒` : `${(ms / 1000).toFixed(1)} 秒`);
const NEXT_STEP_LINES = [
  "Agent-facing next step（本段落內容 MUST 原樣轉達給使用者；AI 不得代為選擇選項 2）：",
  "1. 是，停下，交由使用者決定下一步（檢查本機 git／磁碟狀況、清掉已結束的 marker、或調整範圍）",
  "2. 否，使用者已確認可承擔未檢查的風險，明確授權繼續",
  "3. 其他",
];
export const launcherNote = () => `hook launcher 逾時〔上限 ${formatDuration(resolveLauncherTimeoutMs())}〕會直接放行`;

// cause "ETIMEDOUT": the worker ran past the hard limit and was killed. Any other cause: the supervisor itself could not run or collect the
// worker (spawn failure such as EAGAIN, output overflow such as ENOBUFS after the worker already ran) or the worker was ended by a signal the
// supervisor did not send (the cause is then the signal name, e.g. SIGKILL). Either way the check did not finish, and the hook body is NOT
// re-run in this process: that would run unsupervised until the launcher's fail-open, and after an ENOBUFS it would repeat work the worker
// already did.
function buildFailureSection(hardMs, cause) {
  if (cause === "ETIMEDOUT") {
    return [
      "### Post-PR completion check hard time limit reached",
      "",
      `這一輪檢查超過 ${formatDuration(hardMs)} 的硬性期限（${launcherNote()}，所以本 hook 先強制結束檢查程序並擋下）：檢查沒有完成。被強制結束的那一刻仍在 marker 目錄內的 marker 原樣保留，沒有清除也沒有判定（結束前已處理完成的 marker 可能已經清除）；哪些 PR 仍待處理，請在本機 git／檔案讀取恢復正常後重跑檢查，或直接查看 marker 目錄。`,
      "",
      "可能原因：本機的 git 或檔案讀取被卡住（同步工作無法在程序內中斷）。",
      ...NEXT_STEP_LINES,
    ].join("\n");
  }
  const code = String(cause || "unknown").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "unknown";
  return [
    "### Post-PR completion check could not be completed",
    "",
    `這一輪檢查的監督程序無法完成檢查（原因碼：${code}；${launcherNote()}，所以本 hook 不在本程序內無監督地重跑檢查，而是擋下）：檢查沒有完成。marker 原樣保留，沒有由本次擋下清除或判定（檢查程序在出錯之前可能已經處理並清除了部分 marker）；請在本機資源（程序數、記憶體）恢復正常後重跑檢查，或直接查看 marker 目錄。`,
    "",
    "可能原因：無法啟動檢查程序（例如 EAGAIN，資源不足）、檢查程序的輸出超過緩衝上限（ENOBUFS），或檢查程序被外部訊號結束（例如 SIGKILL，可能是記憶體不足或被手動結束）。",
    ...NEXT_STEP_LINES,
  ].join("\n");
}

// Failure handling never probes gh or prunes evidence. It reads authority and
// subscription metadata to establish this session's scope before writing its
// reminder. State-directory resolution may use bounded local git probes;
// configured state directories avoid those probes entirely.
function answerFailure(hardMs, cause, runId, session) {
  if (!session) {
    process.stderr.write("post-pr-completion-check: session identity unavailable; supervisor reminder suppressed.\n");
    process.exit(0);
  }
  let hasOwnedMarker = false;
  try {
    hasOwnedMarker = listOwnedPostPrStopMarkers(process.cwd(), session, {
      crossRepositoryOnly: process.env.DEVPRO_AGENT_RULES_LEVEL === "off",
    }).length > 0;
  } catch {}
  if (!hasOwnedMarker) {
    process.stderr.write("post-pr-completion-check: supervisor failure outside known session ownership; reminder suppressed.\n");
    process.exit(0);
  }
  const now = Date.now();
  const section = buildFailureSection(hardMs, cause);
  const compact = (details) => compactReminder({ cwd: process.cwd(), session,
    kind: "post-pr-supervisor", summary: "Post-PR completion check did not finish; keep status blocked.",
    action: "Read Details, then resolve the scoped runtime failure and rerun the check.", details });
  let file = null;
  try { file = reminderFile(process.cwd(), session); } catch { /* no state directory: block without throttling */ }
  if (file) {
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      const ts = Date.parse(String(record?.remindedAt || ""));
      // Only a record from an EARLIER run counts. The worker itself may have written one (its own time-budget block, tagged with this run's
      // id) just before its output was lost (killed at the deadline, or ENOBUFS); throttling on that would downgrade the only block this run
      // can still deliver. Identity, not time order: a wall-clock comparison against this run's start fails when the clock steps back mid-run.
      if (record?.runId !== runId && Number.isFinite(ts) && now - ts < REMINDER_DEDUP_MS) {
        process.stdout.write(JSON.stringify({ systemMessage: compact(`此時間預算狀態已在 30 分鐘內 hard-block 過；本次改為 soft reminder，避免 Stop hook loop。此 soft reminder 不代表狀態已解除，merge gate 不受影響。\n\n${section}`) }));
        process.exit(0);
      }
    } catch { /* no reminder yet, or unreadable: treat as not reminded (more blocks, never a premature downgrade) */ }
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ remindedAt: new Date(now).toISOString(), runId }));
    } catch { /* not persisted: the next turn just blocks again */ }
  }
  process.stdout.write(JSON.stringify({ decision: "block", reason: compact(section) }));
  process.exit(2);
}

/**
 * Runs the hook in a worker process and NEVER returns: every path ends in process.exit (or a relayed signal).
 * `deps.spawnSyncImpl` is for tests only (the entry point below passes none).
 */
export function superviseStopRun(deps = {}) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  let input = "";
  try { input = deps.input ?? readFileSync(0, "utf8"); } catch {}
  let payload = {};
  try { payload = JSON.parse(input || "{}"); } catch {}
  const session = resolveReminderSession(payload);
  const hardMs = resolveStopHardDeadlineMs();
  const runId = randomUUID();
  const run = spawnSyncImpl(process.execPath, [process.argv[1], STOP_WORKER_ARG], {
    cwd: process.cwd(),
    env: { ...process.env, [STOP_RUN_ID_ENV]: runId },
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: Math.max(1, hardMs), // never 0: spawnSync reads 0 as "no timeout"
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Any spawn or collection error (ETIMEDOUT, EAGAIN, ENOBUFS, ...) means the check did not finish: block, never re-run the hook here.
  if (run.error) answerFailure(hardMs, run.error.code, runId, session);
  // A worker ended by a signal this supervisor did not send (OOM kill, an external kill; the supervisor's own timeout kill always comes
  // with run.error) did not finish either: block, with the signal name as the cause. The signal is NOT re-raised on this process: a
  // signal-terminated child reaches the launcher as a null exit status, which run-hook.mjs treats as success, so re-raising would let an
  // unfinished check pass silently. No rerun here, and no partial worker output is relayed.
  if (run.signal) answerFailure(hardMs, run.signal, runId, session);
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}

// Act only when the Stop hook script itself is the entry point (not when a test imports it), not inside the worker, and not in
// the cross-model reviewer subprocess (which the hook exempts and exits 0 for).
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === new URL("../post-pr-completion-check.mjs", import.meta.url).href &&
  !process.argv.includes(STOP_WORKER_ARG) &&
  process.env.DEVPRO_CROSS_MODEL_REVIEWER !== "1"
) {
  superviseStopRun();
}
