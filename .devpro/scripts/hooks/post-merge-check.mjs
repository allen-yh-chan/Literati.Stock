#!/usr/bin/env node
/**
 * post-merge-check.mjs — Stop hook
 *
 * 配對 pre-tool-gate.mjs Gate 4，在 turn 結束前提醒查詢合併後的 workflow。
 *
 * Marker：<main-checkout-root>/notes/tmp/state/devpro-postmerge-state/
 *   `<repo token>#<PR>.merge`、`<repo token>__<branch>.push`（fix-cross-repo-state-keys），舊名 `<branch>.<push|merge>` 照讀
 *   - 內容：JSON {branch, headRefName, baseRefName, kind, prNumber, repo?, sessionId, createdAt}；`repo` 是小寫
 *     HOST/OWNER/REPO，沒寫的屬於 session checkout 自己的 repo
 *   - 讀不到內容的 marker（例如舊的 timestamp-only）屬於不明 repo：不提醒，也不在過期前刪（PR #3703 r11 W2-F2）
 *   - 寫入：pre-tool-gate.mjs 偵測 gh pr merge；push 不寫（fix-unknown-push-reminder-repeat），之前寫的 push 紀錄照讀
 *   - repo 不明的 push 紀錄（#3704 寫的）不提醒：沒有查詢清得掉它，提醒了 AI 也做不了什麼；過期照刪
 *   - 清除：track-postmerge-workflows.mjs 驗證 GitHub 回應後清除對應紀錄
 *
 * 觸發：marker mtime > REMIND_AFTER_MS（30s）→ emit。STALE_AFTER_MS（1h）→ 自動清。
 *
 * Output: JSON {systemMessage} 軟提醒（Stop event 不支援 hookSpecificOutput.additionalContext，
 * 用 top-level systemMessage 注入下輪 context）。
 *
 * Per git-workflow-tracking.md「PR 建立 / Merge / Push 後追蹤
 * workflow」+「Post-PR handoff」段。
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { defaultMainCheckoutRoot } from "./lib/repo-state-identity.mjs";
import { storedOriginIdentity } from "./lib/git-utils.mjs";
import { repoKey } from "./lib/repo-key.mjs";
import { expirePostmergeMarker, parsePostmergeMarker, postmergeMarkerKind, postmergeStateDir } from "./lib/postmerge-marker.mjs";
import { countPendingItems, findClaimedChangesForBranch } from "./lib/session-pending-utils.mjs";

function gitRoot(cwd = process.cwd()) {
  try {
    return String(
      execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }) || ""
    ).trim();
  } catch {
    return "";
  }
}

// R2: 若 repo 無 GitHub workflow，「追蹤 workflow」的提醒沒有意義（source repo
// CI 為 N/A）。解析 git top-level 後掃 .github/workflows/ 有無 *.yml/*.yaml；
// 無則 skip workflow-watch。若 repo root 解析失敗，不能把「未檢查」靜默折成
//「沒有 workflow」：有 pending marker 時輸出 not-checked advisory。
// Test override：DEVPRO_POSTMERGE_FORCE_WORKFLOWS=0/1 強制結果（讓 emit 行為可在
// 無 workflow 的 source repo 內被測，且 no-workflow skip 本身也可測）。
function workflowDiscovery(cwd = process.cwd()) {
  const forced = process.env.DEVPRO_POSTMERGE_FORCE_WORKFLOWS;
  if (forced === "1" || forced === "0") {
    return {
      checked: true,
      forced: true,
      hasWorkflows: forced === "1",
      path: "(forced)",
    };
  }
  const root = gitRoot(cwd);
  if (!root) {
    return {
      checked: false,
      hasWorkflows: false,
      path: path.join(cwd, ".github", "workflows"),
      reason: "git root unresolved",
    };
  }
  const dir = path.join(root, ".github", "workflows");
  if (!existsSync(dir)) {
    return { checked: true, hasWorkflows: false, path: dir };
  }
  try {
    return { checked: true, hasWorkflows: readdirSync(dir).some((f) => /\.ya?ml$/i.test(f)), path: dir };
  } catch (err) {
    return {
      checked: false,
      hasWorkflows: false,
      path: dir,
      reason: err?.message || "workflow directory unreadable",
    };
  }
}

function repoHasWorkflows(cwd = process.cwd()) {
  return workflowDiscovery(cwd).hasWorkflows;
}

const REMIND_AFTER_MS = 30_000;
const STALE_AFTER_MS = 60 * 60_000;

function currentSessionId() {
  return (
    process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.CLAUDE_CONVERSATION_ID ||
    ""
  ).trim();
}

function currentBranch(cwd = process.cwd()) {
  try {
    const result = spawnSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

// The marker in a file, read with the reader Gate 4 clears with (lib/postmerge-marker.mjs), or null.
function readJsonMarker(filePath, fileName) {
  try {
    return parsePostmergeMarker(readFileSync(filePath, "utf8"), fileName);
  } catch {
    return null;
  }
}

// The repository key of the session checkout's stored origin, or "" when it cannot be read.
let ownRepoKey;
function sessionRepoKey(cwd = process.cwd()) {
  if (ownRepoKey === undefined) {
    const own = storedOriginIdentity(cwd);
    ownRepoKey = own ? repoKey(own.host, own.slug) : "";
  }
  return ownRepoKey;
}

// A marker that records a repository other than the session checkout's (a merge or push of another repository from
// this session). When the session checkout's repository cannot be read, no marker is known to be another repository's.
function isOtherRepoMarker(marker, cwd = process.cwd()) {
  const own = sessionRepoKey(cwd);
  return Boolean(marker.repo && own) && marker.repo !== own;
}

// A marker whose writer could not prove its repository (#3704 r2 F2): it is not the session checkout's, nothing clears
// it, and it is reminded until it expires (user decision Q1-1).
function isUnknownRepoMarker(marker) {
  return marker.repoUnknown === true;
}

// A marker the session checkout's own workflows and main say nothing about.
function isForeignMarker(marker, cwd = process.cwd()) {
  return isUnknownRepoMarker(marker) || isOtherRepoMarker(marker, cwd);
}

function markerLabel(marker, cwd = process.cwd()) {
  const branch = marker.headRefName || marker.branch;
  if (isUnknownRepoMarker(marker)) return `repo 不明 ${branch}(${marker.kind})`;
  // A merge names its PR, also when the session's own repository's PR reported no head branch (#3704 r6 F4).
  const pr = marker.kind === "merge" && marker.prNumber ? `#${marker.prNumber}` : "";
  if (!isOtherRepoMarker(marker, cwd)) return `${pr}${pr && branch ? " " : ""}${branch}(${marker.kind})`;
  return `${marker.repo}${pr}${branch ? ` ${branch}` : ""}(${marker.kind})`;
}

function isSessionPendingRelevantMerge(marker, cwd = process.cwd()) {
  if (marker.kind !== "merge") return false;
  const sessionId = currentSessionId();
  if (sessionId && marker.sessionId === sessionId) return true;
  // The current branch names a branch of the session checkout's repository only.
  if (isForeignMarker(marker, cwd)) return false;
  const branch = currentBranch(cwd);
  const markerBranch = String(marker.headRefName || marker.branch || "").trim();
  return Boolean(branch && markerBranch && branch === markerBranch);
}

// True / false: the PR's merge commit ("Merge pull request #N …", the shape `gh pr merge --merge` makes and the
// merge-strategy gate requires) is / is not on the main checkout's local `main`. null: cannot tell (no local `main`,
// git failed), which the caller treats as "say nothing". Local only — no fetch, no gh (design-core §8 Hook Runtime
// Cost Boundary): after `gh pr merge` the remote has the merge commit and local `main` gets it only from a pull.
function mergeCommitOnLocalMain(mainRoot, prNumber) {
  try {
    const result = spawnSync(
      "git",
      ["-C", mainRoot, "log", "main", "-1", "--format=%H", `--grep=^Merge pull request #${prNumber} `],
      { encoding: "utf8", timeout: 3000 }
    );
    if (result.status !== 0) return null;
    return String(result.stdout || "").trim() !== "";
  } catch {
    return null;
  }
}

async function main() {
  // R2: 無 workflow 的 repo（如 source repo）不追蹤 workflow → 整段 skip。
  // 仍清理過期 marker 以免累積，但不 emit 提醒。
  const workflowScope = workflowDiscovery();
  const hasWorkflows = workflowScope.hasWorkflows;

  const markerDir = postmergeStateDir();

  if (!existsSync(markerDir)) process.exit(0);

  const pending = [];
  let files = [];
  try {
    files = readdirSync(markerDir);
  } catch {
    process.exit(0);
  }

  const now = Date.now();
  for (const f of files) {
    if (!postmergeMarkerKind(f)) continue;
    const p = path.join(markerDir, f);
    let stat;
    try {
      stat = statSync(p);
    } catch {
      continue;
    }
    const age = now - stat.mtimeMs;
    if (age > STALE_AFTER_MS) {
      try { expirePostmergeMarker(p, now - STALE_AFTER_MS); }
      catch { /* Retry stale cleanup on the next Stop. */ }
      continue;
    }
    const marker = readJsonMarker(p, f);
    // A marker this hook cannot read belongs to no known repository: it stays until it is stale (PR #3703 r11 W2-F2).
    if (!marker) continue;
    // A push marker of an unknown repository (written by #3704) is not reminded: no query clears it, so the reminder asked
    // for something the agent could never confirm (fix-unknown-push-reminder-repeat). It is removed once it is stale.
    if (marker.kind === "push" && isUnknownRepoMarker(marker)) continue;
    if (age >= REMIND_AFTER_MS) {
      pending.push({
        ...marker,
        ageSec: Math.round(age / 1000),
      });
    }
  }

  const parts = [];

  // 段1: workflow-watch 提醒（R2 約束：有 workflow + pending 才發）。這個 checkout 的 .github/workflows 只說得了本 repo：
  // 別 repo 與 repo 不明的紀錄一律提醒，由使用者照那個 repo 追（使用者決定 #3704 Q1-1）。
  const ownPending = pending.filter((p) => !isForeignMarker(p));
  const remind = hasWorkflows ? pending : pending.filter((p) => isForeignMarker(p));
  if (remind.length > 0) {
    const refs = remind.map((marker) => markerLabel(marker)).join("、");
    const query = "node .devpro/scripts/track-postmerge-workflows.mjs --repo github.com/OWNER/REPO";
    const next = [];
    if (remind.some((marker) => marker.kind === "merge" && marker.prNumber && !isUnknownRepoMarker(marker))) {
      next.push(`從保存紀錄的 checkout 執行 ${query} --pr <PR#>，成功後追蹤各 run 終態。`);
    }
    if (remind.some((marker) => marker.kind === "push")) {
      next.push(`舊 push 紀錄可用 ${query} --branch <branch> 查詢。`);
    }
    if (remind.some((marker) => isUnknownRepoMarker(marker) || (marker.kind === "merge" && !marker.prNumber))) {
      next.push("repo 不明或缺 PR 編號的合併紀錄會在 1 小時後自動到期。先確認正確的 PR 並追蹤 workflow。");
    }
    parts.push(`Post-merge：${refs} 尚待查詢 workflow。 ${next.join(" ")}（見 git-workflow-tracking.md）`);
  }
  if (!hasWorkflows && !workflowScope.checked && ownPending.length > 0) {
    parts.push(
      `Post-merge workflow discovery not checked: pending marker count=${ownPending.length}; ` +
      `markerDir=${markerDir}; workflowPath=${workflowScope.path}; ` +
      `reason=${workflowScope.reason || "unknown"}.`
    );
  }

  // 段2: session-pending 提醒（不受 R2 約束，只 merge kind 觸發）
  const relevantMergeMarkers = pending.filter((p) => isSessionPendingRelevantMerge(p));
  const hasMergePending = relevantMergeMarkers.length > 0;
  if (hasMergePending) {
    // fail-open: countPendingItems 任何錯誤 → 0，不 throw
    const sessionPendingCount = countPendingItems();
    if (sessionPendingCount > 0) {
      parts.push(
        `AI action reminder (not a user prompt): 工作（PR）已 merge，notes/session-pending.md 有 ${sessionPendingCount} 條未處理待辦。Next AI action: 若目前無更高優先事項，先讀取 pending 待辦並向使用者回報建議處理順序（per AGENTS.md §9 session-pending）。`
      );
    }

    // 完成側前饋：merged branch 反查 claimed 條目 → 命中即催「整條刪除」。
    // 反查沿用 merge marker 本身作為完成信號，不新增任何 gh / 網路探針
    // （per design-core §8 Hook Runtime Cost Boundary）。
    // fail-open: findClaimedChangesForBranch 任何錯誤 → []，不 throw；
    // 無命中則維持上面既有的泛泛 count 提醒不變，不額外 emit。
    const claimedChanges = new Set();
    for (const marker of relevantMergeMarkers) {
      const branch = String(marker.headRefName || marker.branch || "").trim();
      if (!branch) continue;
      for (const change of findClaimedChangesForBranch(branch)) {
        claimedChanges.add(change);
      }
    }
    if (claimedChanges.size > 0) {
      const changeList = [...claimedChanges].map((c) => `\`${c}\``).join("、");
      parts.push(
        `AI action reminder (not a user prompt): claimed 條目 ${changeList} 對應的 PR 已 merge，依 session-pending-lifecycle.md §完成刪除，該條目應**整條刪除**（不留標記）。Next AI action: 打開 notes/session-pending.md 刪除該條目。`
      );
    }
  }

  // 段3: Post-merge Local Sync 提醒（git-workflow-tracking.md §Post-merge Local Sync）。merge 後本機 main 必落後遠端，
  // 規範要求同一輪 turn 同步；沒有任何東西會在 merge 後提醒這件事，只能靠記得。只看本 session 的 merge marker、
  // 只在能確認「main checkout 的 local main 還沒有該 PR 的 merge commit」時才提醒（無 PR 編號或判斷不了 → 不說話）。
  // 只管 merge 目標是 main 的 PR：production／release 目標的 merge commit 本來就不在 local main，對它提醒永遠消不掉；
  // marker 沒記 baseRefName（舊 marker、gh pr view 失敗）同樣不說話。production 目標的同步序列仍由規範負責。
  // 同步後下一輪 Stop 就查得到 merge commit，提醒自然消失；marker 1 小時後本來就會過期。
  if (relevantMergeMarkers.length > 0) {
    let mainRoot = "";
    try {
      mainRoot = defaultMainCheckoutRoot();
    } catch {
      mainRoot = "";
    }
    const unsynced = mainRoot
      ? relevantMergeMarkers.filter(
          (marker) =>
            // Another (or an unknown) repository's merge commit is never on this checkout's main.
            !isForeignMarker(marker) &&
            marker.baseRefName === "main" &&
            /^\d+$/.test(marker.prNumber) &&
            mergeCommitOnLocalMain(mainRoot, marker.prNumber) === false
        )
      : [];
    if (unsynced.length > 0) {
      const refs = unsynced.map((m) => `PR #${m.prNumber}（${m.headRefName || m.branch}）`).join("、");
      parts.push(
        `AI action reminder (not a user prompt): Post-merge Local Sync 尚未做：${refs} 已 merge，但 main checkout（${mainRoot}）的本機 main 還沒有它的 merge commit。` +
        `Next AI action: 本輪內執行 \`git -C ${mainRoot} pull --ff-only origin main\`（cwd 在 linked worktree 時用這個形式；cwd 就是 main checkout 時用 \`git checkout main && git pull --ff-only\`），` +
        `再以 \`git -C ${mainRoot} status --short --branch\` 與 \`git -C ${mainRoot} log main..origin/main --oneline\`（須為空）確認（per git-workflow-tracking.md §Post-merge Local Sync）。`
      );
    }
  }

  if (parts.length === 0) process.exit(0);

  process.stdout.write(JSON.stringify({ systemMessage: parts.join("\n\n") }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`post-merge-check hook error: ${err.message}\n`);
  process.exit(0);
});
