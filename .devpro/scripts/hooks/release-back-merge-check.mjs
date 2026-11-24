#!/usr/bin/env node
/**
 * release-back-merge-check.mjs — Stop hook
 *
 * Release back-merge completion gate (openspec enforce-release-back-merge-completion,
 * design D1/D4/D5/D6). After a conversation pushed a production-* tag (recorded by
 * pre-push + PostToolUse into a pending record), the turn may not end while that
 * tag is not an ancestor of the REMOTE main, unless a release condition applies.
 *
 * Flow: session filter -> garbage collect -> pending records of this conversation
 *   (own state dir plus the state dirs of repos the conversation pushed from, found
 *   through the session link written at PostToolUse)
 *   -> per pushed remote one bounded `git ls-remote` for the candidate tag refs
 *   -> candidates whose tag is absent / different on a successfully queried remote
 *      are removed (tag-not-on-origin); a FAILED query never removes anything
 *   -> completion target is `origin`'s main (the Step 6A definition), also when the tag
 *      was pushed to another remote; the pushed remote's main is used only when the repo
 *      has no remote named origin. `ls-remote` + `git fetch --no-tags <remote>
 *      +refs/heads/main:refs/remotes/<remote>/main` run once per Stop for that target
 *   -> detect-branch-base.mjs --require-main-ancestor with raw SHAs (exit 0 removes)
 *   -> unmerged candidates: release on deferral / qualified handoff / loop guard /
 *      block cap, otherwise {decision:"block", reason} on stdout with exit 0
 *      (a host may ignore a stdout JSON paired with exit 1/2; exit 0 + JSON blocks on
 *      every registered host, also through run-hook.mjs, which maps a non-zero child exit to 1;
 *      measurements are in the change decisions.md).
 *
 * One 90 second wall-clock budget covers every external call (each timeout is
 * min(its own limit, remaining budget)). Every release is traced and none clears
 * a record; completion is only ever the judge's exit 0. Any internal error
 * fails open (stderr line, exit 0).
 *
 * Test seam: DEVPRO_RELEASE_BACK_MERGE_BUDGET_MS lowers the budget (never raises it).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin } from "./lib/stdin.mjs";
import {
  MAX_BLOCKS_PER_WINDOW,
  appendTrace,
  currentBlockState,
  deletePendingRecord,
  extractDeferral,
  garbageCollect,
  isQualifiedBackMergeHandoff,
  lastAssistantMessage,
  linkedReleaseBackMergeSources,
  loadPendingRecords,
  recordBlockOnRecords,
  releaseBackMergeStopContext,
  removeSessionLinkRepos,
  savePendingRecord,
  takeReminder,
} from "./lib/release-back-merge-state.mjs";

const STARTED_AT = Date.now();
const MAX_BUDGET_MS = 90_000;
const LS_REMOTE_LIMIT_MS = 10_000;
const FETCH_LIMIT_MS = 20_000;
const LOCAL_GIT_LIMIT_MS = 5_000;
const JUDGE_LIMIT_MS = 10_000;
const JUDGE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "detect-branch-base.mjs");
const STEP_6A_RULE = ".devpro/agent-rules/release-step-1-7.md";

function budgetMs() {
  const raw = Number(process.env.DEVPRO_RELEASE_BACK_MERGE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_BUDGET_MS) : MAX_BUDGET_MS;
}
const DEADLINE = STARTED_AT + budgetMs();

const ctx = { budgetExceeded: false, traceDir: "", sessionId: "" };

/** Run an external command with timeout = min(own limit, remaining budget). */
function runBounded(command, args, { cwd, limitMs }) {
  const left = DEADLINE - Date.now();
  if (left <= 0) {
    ctx.budgetExceeded = true;
    return { ok: false, stdout: "", status: null };
  }
  const timeout = Math.min(limitMs, left);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error?.code === "ETIMEDOUT" && timeout < limitMs) ctx.budgetExceeded = true;
  return { ok: !result.error && result.status === 0, stdout: result.stdout || "", status: result.status };
}

const isUrlRemote = (remote) => /[:/\\]/.test(remote);

function parseLsRemote(stdout) {
  const refs = new Map();
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

/** Name of the remote whose main decides completion: `origin` when the repo has one (Step 6A), else the pushed remote. */
function completionRemoteFor(remote, cwd) {
  if (remote === "origin") return remote;
  const names = runBounded("git", ["remote"], { cwd, limitMs: LOCAL_GIT_LIMIT_MS });
  return names.ok && names.stdout.split("\n").some((name) => name.trim() === "origin") ? "origin" : remote;
}

/**
 * Query + fetch the completion remote's main once per (repo, remote) per Stop.
 * `knownMainSha` is passed when the caller's tag query already listed main.
 * Returns { ok, sha }; any failure is { ok: false } (callers keep the record).
 */
function resolveCompletionMain(completionRemote, cwd, mainCache, knownMainSha) {
  const key = `${cwd}\0${completionRemote}`;
  const cached = mainCache.get(key);
  if (cached) return cached;
  let sha = knownMainSha;
  if (sha === undefined) {
    const ls = runBounded("git", ["ls-remote", completionRemote, "refs/heads/main"], { cwd, limitMs: LS_REMOTE_LIMIT_MS });
    sha = ls.ok ? parseLsRemote(ls.stdout).get("refs/heads/main") : undefined;
  }
  let result = { ok: false, sha: "" };
  if (sha) {
    const fetchArgs = isUrlRemote(completionRemote)
      ? ["fetch", "--no-tags", completionRemote, "refs/heads/main"]
      : ["fetch", "--no-tags", completionRemote, `+refs/heads/main:refs/remotes/${completionRemote}/main`];
    const fetched = runBounded("git", fetchArgs, { cwd, limitMs: FETCH_LIMIT_MS });
    const resolvable =
      fetched.ok && runBounded("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, limitMs: LOCAL_GIT_LIMIT_MS }).ok;
    result = { ok: resolvable, sha };
  }
  mainCache.set(key, result);
  return result;
}

/**
 * Verify every candidate pushed to one remote. Sets `item.state` to one of
 * absent | confirmed | unmerged | undetermined | unverified, and `item.mainSha`.
 */
function verifyRemote(remote, items, cwd, mainCache) {
  const tags = [...new Set(items.map((item) => item.candidate.tag))];
  const completionRemote = completionRemoteFor(remote, cwd);
  const completionKey = `${cwd}\0${completionRemote}`;
  // The pushed remote's own query also lists main when it is the completion target and not fetched yet.
  const listMain = completionRemote === remote && !mainCache.has(completionKey);
  const ls = runBounded(
    "git",
    ["ls-remote", remote, ...(listMain ? ["refs/heads/main"] : []), ...tags.map((t) => `refs/tags/${t}`)],
    { cwd, limitMs: LS_REMOTE_LIMIT_MS },
  );
  if (!ls.ok) {
    for (const item of items) item.state = "unverified";
    return;
  }
  const refs = parseLsRemote(ls.stdout);
  const survivors = [];
  for (const item of items) {
    if (refs.get(`refs/tags/${item.candidate.tag}`) === item.candidate.expected_sha) survivors.push(item);
    else item.state = "absent";
  }
  if (survivors.length === 0) return;

  const main = resolveCompletionMain(completionRemote, cwd, mainCache, listMain ? refs.get("refs/heads/main") : undefined);
  if (!main.ok) {
    for (const item of survivors) item.state = "unverified";
    return;
  }
  const mainSha = main.sha;

  for (const item of survivors) {
    item.mainSha = mainSha;
    item.completionRemote = completionRemote;
    const peeled = runBounded("git", ["rev-parse", "--verify", "--end-of-options", `${item.candidate.expected_sha}^{commit}`], {
      cwd,
      limitMs: LOCAL_GIT_LIMIT_MS,
    });
    const commit = peeled.stdout.trim();
    if (!peeled.ok || !commit) {
      item.state = "undetermined";
      continue;
    }
    const judge = runBounded(
      process.execPath,
      [JUDGE_SCRIPT, "--require-main-ancestor", "--production-ref", commit, "--main-ref", mainSha],
      { cwd, limitMs: JUDGE_LIMIT_MS },
    );
    if (judge.ok) {
      item.state = "confirmed";
      continue;
    }
    let classification = "";
    try {
      classification = JSON.parse(judge.stdout).classification;
    } catch {
      classification = "";
    }
    if (judge.status === 1 && classification === "reconciliation-required") item.state = "unmerged";
    else item.state = ctx.budgetExceeded && judge.status === null ? "unverified" : "undetermined";
  }
}

function obligationLabel({ candidate, source }, cwd) {
  const repo = source.root ? path.relative(cwd, source.root) : "";
  return repo ? `${candidate.tag}（repo ${repo}）` : candidate.tag;
}

function blockReason(unmerged, cwd) {
  const lines = unmerged.map(
    (item) => `- ${obligationLabel(item, cwd)}（pushed remote ${item.candidate.remote}）→ 核對用 ${item.completionRemote} main ${item.mainSha}`,
  );
  return [
    "### Release back-merge 尚未完成（Step 6A）",
    "",
    "本對話推送的 production-* tag 還不是遠端 main 的祖先：",
    ...lines,
    "",
    `請在上列 repo 依 \`${STEP_6A_RULE}\` Step 6A 完成 back-merge，重新抓取該遠端的 main，再用 \`node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref <tag> --main-ref <fresh-main-sha>\` 確認 exit 0。` +
      "注意：合進 `main` 仍是 Ask First 停點；只有 Step 1 的 release 請求已載明涵蓋、且 Step 6A 判定為 graph-only 時才可不再詢問，否則未經使用者授權不得自行合併。",
    "",
    "要結束本回合，三擇一：",
    "1. 完成 Step 6A（判定器 exit 0 後記錄自動清除）。",
    "2. 正在等使用者時：最後訊息點名 back-merge，並附至少 2 個編號選項、末項為開放項（例如「其他」）。",
    "3. 使用者已明說先不合：最後訊息加一行 `BackMergeDeferredByUser: <使用者原話摘要>`。",
    "",
    "（機制放行不等於完成；完成只看 `--require-main-ancestor` exit 0。）",
  ].join("\n");
}

function emit(object) {
  process.stdout.write(JSON.stringify(object));
}

async function main() {
  let payload;
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    process.exit(0);
  }
  if (!payload || typeof payload !== "object") process.exit(0);

  const crossRepositoryOnly = process.env.DEVPRO_AGENT_RULES_LEVEL === "off";
  const { cwd, sessionId, dir } = releaseBackMergeStopContext(payload, { crossRepositoryOnly });
  if (!sessionId) process.exit(0);
  ctx.traceDir = dir;
  ctx.sessionId = sessionId;
  const sources = [];
  if (!crossRepositoryOnly) {
    garbageCollect(dir);
    sources.push({ dir, cwd, records: loadPendingRecords(dir, sessionId) });
  }
  sources.push(...linkedReleaseBackMergeSources({ dir, sessionId }, { crossRepositoryOnly }));
  // A linked repo without a pending record for this conversation no longer needs its link.
  const staleRoots = sources.filter((source) => source.root && source.records.length === 0).map((source) => source.root);
  if (staleRoots.length > 0) removeSessionLinkRepos(dir, sessionId, staleRoots);
  const records = sources.flatMap((source) => source.records);
  if (records.length === 0) process.exit(0);

  // Verify per (repo, pushed remote); records of one conversation share the budget.
  const items = sources.flatMap((source) =>
    source.records.flatMap((entry) =>
      entry.record.candidates.map((candidate) => ({ entry, source, candidate, state: "unverified", mainSha: "" })),
    ),
  );
  const byRemote = new Map();
  for (const item of items) {
    const key = `${item.source.cwd}\0${item.candidate.remote}`;
    const group = byRemote.get(key) ?? { cwd: item.source.cwd, remote: item.candidate.remote, items: [] };
    group.items.push(item);
    byRemote.set(key, group);
  }
  const mainCache = new Map();
  for (const group of byRemote.values()) verifyRemote(group.remote, group.items, group.cwd, mainCache);

  // Remove candidates that are confirmed merged or absent on a successfully queried remote.
  for (const [state, reason] of [["confirmed", "main-ancestor-confirmed"], ["absent", "tag-not-on-origin"]]) {
    const cleared = items.filter((item) => item.state === state);
    if (cleared.length === 0) continue;
    for (const item of cleared) item.entry.record.candidates = item.entry.record.candidates.filter((c) => c !== item.candidate);
    appendTrace(dir, { sessionId, event: "cleared", reason, tags: cleared.map((item) => item.candidate.tag) });
  }
  const live = [];
  for (const entry of records) {
    if (entry.record.candidates.length === 0) deletePendingRecord(entry.file);
    else live.push(entry);
  }
  const doneRoots = sources
    .filter((source) => source.root && source.records.every((entry) => !live.includes(entry)))
    .map((source) => source.root);
  if (doneRoots.length > 0) removeSessionLinkRepos(dir, sessionId, doneRoots);
  const remaining = items.filter((item) => item.state !== "confirmed" && item.state !== "absent");
  const tagsOf = (list) => list.map((item) => item.candidate.tag);
  const labelsOf = (list) => list.map((item) => obligationLabel(item, cwd)).join(", ");
  const persist = () => live.forEach(savePendingRecord);

  const release = (reason, { systemMessage = "", detail, throttled = false } = {}) => {
    appendTrace(dir, { sessionId, event: "released", reason, tags: tagsOf(remaining), detail });
    const show = systemMessage && (!throttled || takeReminder(live));
    persist();
    if (show) emit({ systemMessage });
    process.exit(0);
  };

  if (remaining.length === 0) process.exit(0);

  const unmerged = remaining.filter((item) => item.state === "unmerged");
  if (unmerged.length === 0) {
    const unverified = remaining.filter((item) => item.state === "unverified");
    const undetermined = remaining.filter((item) => item.state === "undetermined");
    if (unverified.length > 0) {
      appendTrace(dir, {
        sessionId,
        event: "released",
        reason: "origin-unverified",
        tags: tagsOf(unverified),
        detail: ctx.budgetExceeded ? "budget-exceeded" : undefined,
      });
    }
    if (undetermined.length > 0) {
      appendTrace(dir, { sessionId, event: "released", reason: "ancestry-undetermined", tags: tagsOf(undetermined) });
    }
    const show = takeReminder(live);
    persist();
    if (show) {
      emit({
        systemMessage:
          `release back-merge 未驗證：無法向遠端確認 ${labelsOf(remaining)} 是否已合回 main` +
          "（離線、認證失敗、remote 已不存在或超出時間預算）；記錄保留，連線後下次回合結束會再核對。放行不代表 back-merge 已完成。",
      });
    }
    process.exit(0);
  }

  const message = lastAssistantMessage(payload);
  const deferral = extractDeferral(message);
  if (deferral) {
    const at = new Date().toISOString();
    for (const entry of live) entry.record.deferred = { at, summary: deferral };
  }
  const deferred = live.map((entry) => entry.record.deferred).find(Boolean);
  const stillOpen = `release back-merge 仍未完成：${labelsOf(unmerged)} 尚未合回 main（Step 6A）；放行不代表完成。`;

  if (deferred) {
    release("user-deferred", {
      throttled: true,
      systemMessage: `${stillOpen}使用者已延後（${deferred.summary}）。`,
    });
  }
  if (isQualifiedBackMergeHandoff(message)) release("qualified-handoff");

  const state = currentBlockState(live);
  if (payload.stop_hook_active === true && state.lastBlockedAt) {
    release("loop-guard-degraded", { systemMessage: stillOpen });
  }
  if (state.count >= MAX_BLOCKS_PER_WINDOW) {
    release("block-cap-degraded", { systemMessage: stillOpen });
  }

  recordBlockOnRecords(live);
  persist();
  appendTrace(dir, { sessionId, event: "blocked", reason: "blocked", tags: tagsOf(unmerged) });
  emit({ decision: "block", reason: blockReason(unmerged, cwd) });
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`release-back-merge-check error (fail-open): ${err?.message ?? err}\n`);
  if (ctx.traceDir) appendTrace(ctx.traceDir, { sessionId: ctx.sessionId, event: "error", reason: "hook-error" });
  process.exit(0);
});
