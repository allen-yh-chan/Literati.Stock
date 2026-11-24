---
name: rules-flow
description: Rules sync flow（consumer rules lane + source SemVer release）。觸發：手動補救、rules branch、source release。子能力見 rules-flow-routing.md；PR merge 後 production continuation 與 Rollback SOP 只留路由，內容在 rules-flow-production-continuation.md、rules-flow-rollback.md。
---

# devpro-agent-rules 同步作業

## Overview

`devpro-agent-rules` 是跨 repo 規範來源；consumer 以 submodule 同步並重建衍生檔。規範只在 source repo 改；consumer 禁手改規範或衍生檔（含 synced `AGENTS.md`）。合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。

> **Retired**：舊 consumer `chore/sync-devpro-agent-rules*`、`rules/<source>-<YYYYMMDD>-<sha>` 全退役；只用 `rules/<source>-v<X.Y.Z>`。

## When to Use

- `/devpro:sync-rules`：slash-command host 入口；包同一條 rules lane flow
- 無 slash command 的 agent：直接跑同一 flow
- PR CI：每個 PR 執行 `--check`；失敗不可 merge

## Process

> 僅 consumer repo `rules/<source>-v<X.Y.Z>` lane 適用；source repo 不適用。feature/bugfix/chore 禁跑；步驟**必須**在 consumer root。

### Batch Scope Ledger

啟動 `/devpro:sync-rules` 時先確認 batch scope；若使用者授權完整 rules lane batch approval，後續不得在 rules-to-main、production continuation 或 promotion 後 ancestry reconciliation 人為切斷。Scope MUST 用 Batch Scope Ledger 固定逐項列出，且每項標 `yes` / `no` / `ask-later`：

- push rules branch
- create rules PR
- merge rules PR
- create release/rules branch
- push release/rules branch
- create production PR
- merge production PR
- push production tag
- bounded subagent launch authorization
- create ancestry repair branch
- create ancestry repair PR
- merge ancestry repair PR
- re-fetch candidate `origin/main`
- run exact promoted-tag main-ancestor gate

推薦完整 rules lane batch approval MUST 涵蓋全部欄位。只有明確標 `yes` 的項目才視為已授權；missing field、`no` 或 `ask-later` 不得推定授權，任何未授權的 remote write 或 merge MUST Ask First，未明確涵蓋 production PR 或 production tag action 時 final gate 仍須再次詢問。若 bounded subagent launch authorization 是 `yes`，同一 named consumer repo/source version rules lane 的 mandatory-threshold dispatch 記為 `StandingDelegationAuthorization`；若是 `no` / `ask-later`，Codex 等 explicit-trigger runtime 必須進 `SubagentAuthPending` 一次。

### Sync / Check 腳本入口

`--sync` 一律用 submodule 內最新版 script；`--check` 用同步後 root script 驗證 consumer CI 入口。root `--sync` 只是 fallback guard（`root --sync is a fallback guard, not the standard workflow entrypoint`）。

若誤從 root path（`.devpro/scripts/sync-agent-rules.mjs`）執行 `--sync`，script 會自動 re-exec submodule 版本（印一行 `↻ Re-executing submodule script…`），確保跑到含最新 prune 邏輯的 code，而非記憶體中的舊版 root script；文件與 prompt 不得把 root `--sync` 寫成標準同步入口。

```bash
node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync
node .devpro/scripts/sync-agent-rules.mjs --check
```

raw `--sync` / `--check` MUST only handle class ① versioned 或 submodule-delivered state，且 MUST NOT query、prompt 或 write class ② user、machine、clone-local 或 external-service state（包括 `core.hooksPath`、個人 runtime auto-compact 與 GitHub merge policy；`core.symlinks` 的 write／repair 亦屬 class ② 由 `devpro:change` 擁有——raw sync 可 probe 以 prefer-plain，但 MUST NOT 寫入 `core.symlinks`）；class ② 由 `devpro:change` environment setup 共同入口檢查，class ③ rules-lane workflow state 仍由 `devpro:sync-rules` 擁有。新增 raw diagnostic 必須先在 registry/manifest 提供 delivery/reachability class 與 owner 證據。

`.gitattributes` 仍是 class ①：它可交付 LF checkout attributes，但不能設定或停用 GitHub squash/rebase merge method；不得把 managed `.gitattributes` 描述成 GitHub merge policy 防線。

首次導入只多 `git submodule add --force -b production <source-url> .devpro-agent-rules`；`.devpro-agent-rules` 已存在就跑 submodule script。

root script 是 sync 產物；`--check` 比對 consumer root 與 `.devpro-agent-rules` source。source repo root 執行 `--sync` / `--check` 必須 fail closed。

consumer rules release validation 的 runner 入口也在 consumer root：`node .devpro/scripts/run-test-suite.mjs --changed <production-rules-tag>`。當 `<production-rules-tag>` 符合 `production-YYYYMMDD-rules[-n]`，且 repo 已安裝 `.devpro-agent-rules` 或 `.gitmodules` 宣告 `path = .devpro-agent-rules` 並已有 root smoke entrypoints，runner 會改跑 consumer-safe smoke：`git submodule update --init .devpro-agent-rules`、submodule `--sync`、root `sync-agent-rules.mjs --check`、root `devpro-doctor.mjs --consumer-smoke`、focused generated-tool tests，並把 source-maintainer-only corpus checks 回報為 `N/A`。`--changed` 在 source repo 或 ownership 無法驗證的 root 仍維持 source tier selection，不可用來跳過 source suite；已證實 consumer 的非 rules tag base、default／`--tier all`／explicit-tier 路徑則回 source-maintainer checks `N/A`，不得進入 source tier（profile／ownership 判定見 `test-suite-cadence.md`）。

### 標準同步流程

1. **Pre-flight：確認 submodule 追蹤 `production` 分支**
   ```bash
   CURRENT=$(git config --file .gitmodules --get submodule..devpro-agent-rules.branch 2>/dev/null || echo "")
   ```
   - `production`：no-op，繼續 step 2
   - `main`（舊版預設）：AI 切換並告知：`git submodule set-branch -b production .devpro-agent-rules && git -C .devpro-agent-rules fetch origin production`；`.gitmodules` diff 收進 step 5 commit
   - 其他或空：不擅自切換（no-op）

2. **更新 submodule 工作副本**（指令見 `rules-flow-routing.md`）

3. **同步（重建所有衍生檔案）**
   ```bash
   node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync
   ```
   重建 sync-managed outputs（含 `.gitignore` / `.gitattributes` managed block）。此步只處理 class ① delivered state，MUST NOT 觸碰 class ②；本機與外部服務設定由 `devpro:change` environment setup 負責。此步同時會自清 legacy source-managed residue（退役的 `.claude/commands/dp/*` 與 `LEGACY_SOURCE_WORKFLOW_FILES` workflow），每筆刪除均以 console 宣告 `Removed legacy …`；刪除路徑隨即落入 step 5 的 `git add` 範圍，殘留清理與 pointer 更新一次 commit 完成，不再事後補。

4. **一致性檢查**
   ```bash
   node .devpro/scripts/sync-agent-rules.mjs --check
   ```
   `--check` fail → 重跑 step 3/4；大小寫衝突保留 consumer 內容、再更名 tracked path；`--sync` 停止且不寫檔。仍失敗停下回報。**禁止**手改衍生檔；自訂寫 root `AGENTS.local.md`。

5. **提交（rules 分支有 diff 時）**：展開 sync managed set 後 `git add`——必須涵蓋 `.gitmodules`、`.devpro-agent-rules`、`AGENTS.md`、`STATIC_FILES`、`SYNC_DIRS`（含 `.agents`／`.opencode` 可見性）、`.claude` sync 面（`CLAUDE_SYNC_SUBDIRS` **＋** `.claude/settings.json` wirefile）、`.gitignore`、`.gitattributes`。SSOT helper：`listSyncCommitPaths()` in `sync-agent-rules.mjs`（Parity keep：不改 `STATIC_FILES`／`SYNC_DIRS` 成員）。禁在 README／本 leaf 維護第二份硬編 path 陣列。

   > `.gitignore` SSOT：`gitignore-alignment.md`；commit message + 禁止延後：`rules-flow-routing.md`

### Dedicated Rules Branch（專用規範分支）

consumer pointer/regeneration **必須**走專用 `rules/<source>-v<X.Y.Z>`；Feature/bugfix/chore **禁** commit submodule。

**SSOT**：pre-flight/指令見 `rules-flow-routing.md`；`/devpro:sync-rules` 只是 wrapper。

**流程（5 步）**：

1. `git fetch origin --tags`
2. 計算 anchor：`node .devpro/scripts/detect-branch-base.mjs --anchor`
3. 不掃描 `origin/rules/*`；expected branch = source `production` tip 的唯一 `production-v<X.Y.Z>` tag 正規化為 `rules/<source>-v<X.Y.Z>`；不唯一就 fail closed，禁止 date+SHA。
4. Base = legal production anchor `<anchor-sha>`：普通 sync 前必須確認 exact production tag 是 candidate `origin/main` ancestor；若 anchor JSON `.isMainAncestor=false`（或 `git merge-base --is-ancestor <anchor-sha> origin/main` false），MUST fail closed 並依 `release-rules-lane.md` 先跑 reconciliation classification，分類完成前不得宣告 bounded repair，且禁止用 `origin/main` fallback 繼續普通 sync/change；exact-tag gate 通過後才可從 legal production anchor 重啟本步驟
5. 開 worktree：`REPO_ROOT=$(git rev-parse --show-toplevel)`→`git worktree add "$REPO_ROOT/.worktree/rules-<source>-v<X.Y.Z>" -b rules/<source>-v<X.Y.Z> <base>`（兩者須在同一個 Bash 呼叫，gate 看不到前一個呼叫的變數）→`cd "$REPO_ROOT/.worktree/rules-<source>-v<X.Y.Z>"`→route：`git ls-tree -d HEAD .devpro-agent-rules`。hit→`git submodule update --init --remote .devpro-agent-rules`→submodule `--sync`→root `--check`→commit；empty（首導或 main/anchor 未導入）→先 `git submodule add --force -b production <source-url> .devpro-agent-rules`，再同 hit。push→以字面 worktree cwd 與明確 head 建 PR：`cd <abs-rules-worktree> && gh pr create ... --head rules/<source>-v<X.Y.Z>`。rules lane 的 footer 版號錨點是該 exact operation worktree 的 `AGENTS.md`；`gh-footer-gate` 必須驗 current branch、`--head`、branch suffix、worktree `AGENTS.md` version 與 source whitelist 一致，context 無法解析或互相矛盾即 fail closed。同一 compound command 不得包含多個 rules write-back；gate 會因無法逐一綁定 body 與 operation 而 fail closed，必須拆成獨立命令。TL body file 仍留 main-checkout `notes/tmp/`，不改 carrier lifecycle；non-rules generic GitHub write 的版號錨點是**本 session 執行指令所在 repo（cwd checkout）的 canonical remote tip `AGENTS.md`**（cwd 讀不到版號才 fallback body-file 所在 repo，null fail-open 不變），不隨 `-R` 目標改變（#3437）。

> `--force` handles `unable to rmdir` leftovers；nonzero→stop，清理前先問。

> rules lane PR body 照 `git-pr-template-and-merge.md` 模板；`DEV deploy-verify:` 行與 `## Requirement Ledger Completion` 段免填，PR 建立 gate（`gh pr create`、MCP `create_pr`）依 head 白名單形狀視為 N/A，比照跨模型審查的分支豁免（`pre-pr-dev-verification.md` §適用範圍）。

**Discovery probe 原則**：mandatory 只有 `origin/main`；`origin/master` / `origin/develop` absent=skipped。optional ref 存在且違規（如無 `origin/main` 但有 `origin/master`，或 `origin/develop` 領先 `origin/main`）才停。shell pattern 必須引用；source tag probe 固定 `git ls-remote --tags <source-url> 'production-v*'`，不得用未引用 `production-v*` 或 legacy `v*`。source `production` tip 必須對到唯一 `production-v<X.Y.Z>`；缺失、舊 tag、多 tag 都停。

**版本段 value-equality 驗證（discrete verify，建/用 branch 前必做）**：
- derive 出 `rules/<source>-v<X.Y.Z>` 後，必須 mechanically 驗證版本段（`<X.Y.Z>`）== source `production` tip 對應的 `production-v<X.Y.Z>` tag。
- 本地讀法：submodule 已 init 時用 `git -C .devpro-agent-rules tag --points-at production 'production-v*'`（或 `git -C .devpro-agent-rules describe --tags --exact-match production`）取版本；無法本地讀則用 `git ls-remote --tags <source-url> 'production-v*'` 取 tip tag。
- 版本段不符 → fail closed，禁止繼續 sync。
- **`validateRulesBranch`（PreToolUse / `.devpro/scripts/hooks/lib/branch-naming.mjs` L76-97）只機械驗 shape（`RULES_BRANCH_RE`）+ source whitelist；版本段 == source production tip 的 value-equality 由本 process step 守（cooperative-only，無 hook enforce）**。
- Rationale：hook-time 驗 source tip 需網路 / submodule state，fail-closed 風險高，故 defer 給 rules-flow process（per #959 N4 使用者決策）。

**Rules branch 建立原則**：不以 `origin/rules/*` 作前置 gate；用 expected SemVer branch。branch 已存在 / non-fast-forward / PR/CI 不一致 / conflict → 依 GitHub/CI 處理。date+SHA rules branch 已退役且 hook 會阻擋。

**PR DIRTY / CONFLICTING 補救**：
- 禁止 `git merge origin/main` 進 `rules/*`。
- PR branch 只服務 main review/merge；production rules release 必須另從 consumer repo 最近 `production-*` tag 建 `release/rules-*`，只 cherry-pick 該批 sync commit（保留 patch/內容等價，非 commit SHA identity）。
- 若根因是 production anchor 與 candidate main ancestry divergence，禁止 rebase/recreate 到 `origin/main` 規避：先依 `release-rules-lane.md` 完成 reconciliation classification；`graph-only` 且 release-lane completion 可行時走 back-merge，否則才進 bounded repair，最後通過 exact-tag gate 後再從 legal production anchor recreate rules branch；若是其他 PR/CI 不一致，依 GitHub/CI 結果補救並重跑 submodule update、submodule `--sync`、root `--check`。
- rewrite remote branch 僅可 `git push --force-with-lease`。
- 以上只適用 rules PR（`rules/*` → main）；carrier（`release/rules-*`）→ `production` PR DIRTY 不 rebase/recreate，走 `release-rules-lane.md` §Carrier ancestry repair。

**PR-open gate-dependent handoff**：
- rules PR 已開但尚未 merge 時，final response / continuation MUST account for current gate state，不得只寫「next step is review / merge」或停在 PR URL 而不給下一步選項。
- workflow/checks pending → 依 `git-workflow-tracking.md` 追到終態，或停下交棒具名 CI blocker 與 track/hold/other 選項；cross-model review required → dispatch `/devpro:cross-review <PR#>` / host-equivalent second-review，runtime 缺授權才停下問，並提供 cross-review/hold/other 選項；(cross-model exempt 或 fresh PASS/WARN sticky) 且 Batch Scope Ledger 明確 `merge rules PR=yes` → merge rules PR 並跑 post-merge sync/checks；merge ready 但未授權 → stop-point handoff：`1. merge <PR#>` / `2. hold` / `3. other`。
- 不得暗示 merge 永遠是下一步；non-exempt PR 必須先 route through cross-model review。

### Consumer Rules Lane Primary-Checkout Close-out

rules PR merge，及適用的 production-continuation reconciliation，令 primary checkout 的 `main` fast-forward 後，該 lane 的 close-out MUST 立即執行 `git submodule update --init .devpro-agent-rules`，然後檢查 `git submodule status .devpro-agent-rules`，並且 MUST 在判斷 `production` branch 或合法 production tag anchor 是否存在之前完成。此命令只 checkout 已由 `main` 記錄的 pointer；MUST NOT use `--remote` 選新版本。

status 的 leading `+`、`-` 或 `U` 都是 terminal pointer non-alignment（分別為 HEAD mismatch、未初始化或 unmerged state）：MUST 回報具名 blocker，並且 MUST NOT declare `/devpro:sync-rules`, sync, or release complete，直到 status 只剩 leading space 的 aligned state。MUST NOT stage the stale SHA back to `main`，也不得以 commit、stash、discard、restore 或 force 處理它；command 失敗或 persistent non-space status 依既有 dirty-tree / stop-point 規則交棒。只有 alignment/status validation 成功後，才依下段分流 pre-first-release 終點或 production continuation 的 named blocker；它不得略過 primary-checkout close-out。post-merge local sync 的 ordering 以 `git-workflow-tracking.md` 為 SSOT；本段只定義 rules-lane completion invariant，不複寫 release、promotion 或 reconciliation mechanics。

**PR merge 後 production continuation**：

> Load-chain（production continuation）：primary-checkout close-out 成功後，若 consumer repo 已有合法 production tag 且存在 `origin/production`，MUST 先讀 `rules-flow-production-continuation.md` 再續行；batch scope 授權沿用、release/rules branch → production PR → tag 順序、promotion 後 reconciliation 與失敗停點的內容都在該 leaf，本檔不複寫。

- primary-checkout close-out 成功後，MUST fresh re-evaluate `git-branch-no-tag-ancestry-evidence.md`；rules PR 已記錄 adoption，須通過 `adopted, pre-first-release` 四項記錄 `production continuation: N/A (pre-first-release)`，回報同步完成。MUST NOT 因 production branch 已存在或 sync batch 授權自動進入 first-rules-release；第一個業務 release 由使用者另行明確決定，不把 rules sync 當作首發。
- 已有 legal tag 而 `origin/production` 不存在，或零 tag 且兩組合法 no-tag 證據皆不成立，MUST 停下回報 `production target absent` 或具名 anchor/history blocker，不得宣告同步完成；release/sync automation MUST NOT 從 `main` 建立、合成或直接 push protected production branch，必須由 external repository administration 先建立 protected, pull-request-capable production base。明確要求 first-rules-release 時另走 `release-rules-lane.md` 的 remote target／FIRST_BASE gate，不能沿用 sync-only 的 N/A。

**Base 選擇 rationale（兩 lane 前提與對照）**：兩條 lane 都以 legal production anchor 已是 candidate main ancestor 為普通流程前提；divergence MUST 先完成 reconciliation classification，分類前不得宣告 bounded repair，且禁止用 `origin/main` fallback 繼續普通 sync/change：

| Lane | 目標分支 | Base | 目的 |
|---|---|---|---|
| `rules/<source>-v<X.Y.Z>` | `main`（review/merge） | legal production anchor（最近 `production-*` tag SHA，且已驗為 candidate main ancestor） | 讓 main 收到 rules pointer |
| `release/rules-<date>` | `production`（上線） | 最近 `production-*` tag（**非 main**） | 從穩定 production 基線 cherry-pick 重放該批 sync commit（patch/內容等價）上 PROD |

- **ordinary lane 前提**：`detect-branch-base.mjs --anchor` 的 `.isMainAncestor`（或同義 merge-base check）必須證明 legal production anchor 已在 candidate main ancestry 內；false 即停 ordinary rules branch，先跑 reconciliation classification 與 exact-tag gate，分類結果需要 repair 時才進 bounded repair，通過後才可重啟。
- **lane 互動**：`rules/*`（→ main）與 `release/rules-*`（→ production）各自使用 production anchor；production lane 固定從 production tag 建 branch，只 cherry-pick 該批 sync commit（patch/內容等價，非 commit SHA identity），既有 isolation 不變。
- **promotion 後 closure**：production tag 建立後固定該 exact promoted tag，依 `release-rules-lane.md` 分類；`graph-only` 且 release-lane completion 可行時走 back-merge，需要 repair 時才建立 bounded repair PR；merge 後 fresh re-fetch candidate main，再以同一 exact tag 跑 main-ancestor gate。只有 gate exit 0 才完成整條 rules lane。

**分類**：consumer rules lane 走 **smoke only**（CI/hook 不爆 + submodule `--sync` + root `--check` pass + consumer root smoke）。對 production rules tag base，`node .devpro/scripts/run-test-suite.mjs --changed <production-rules-tag>` 是 canonical smoke wrapper；release 報告中 source-maintainer-only corpus checks 記為 `N/A`，不得誤報為 consumer regression。

**Consumer full Node suite diagnostic**：額外跑 `node --test .devpro/scripts/tests/` 時，source-only tests MUST 透過 `.devpro-agent-rules` 解析 source root；不得要求 consumer business `README.md` 或 consumer-local `openspec/specs` 長得像 source repo。

**CI N/A 原則**：
- consumer rules lane 的必要 smoke 是 `node .devpro/scripts/sync-agent-rules.mjs --check` pass。
- 若 `gh pr checks <N>` 回 `no checks reported`、`gh run list --branch <rules-branch>` 為空，且 `gh pr view <N> --json mergeStateStatus,mergeable,statusCheckRollup` 顯示 `mergeStateStatus=CLEAN`、`mergeable=MERGEABLE`、`statusCheckRollup=[]`，視為 `CI: N/A — no workflow configured or triggered for rules sync`；不得只因 `gh pr checks` 非 0 停下。
- 有 checks/runs 則依 `git-workflow-tracking.md` 追到終態。

**為何不在 feature 分支 sync**：平行 feature 各自 sync 到不同 SHA 會造成 pointer + `AGENTS.md` conflict；專用分支使 pointer 線性更新。普通 `/devpro:change` 不跑 remote rules update；需新版 rules 時先完成 `/devpro:sync-rules`。

### 修改 source hook 設定

改 `.claude/settings.json` / `.codex/hooks.json` / `.cursor/hooks.json` 會 propagate。要求：hook 腳本在 SYNC_DIRS；`hooks.<EventName>` 整批替換，consumer 同 event custom hooks 會被覆蓋；command 為 cwd-proof launcher（`node -e "<walker>" Event Gate`）；`cross-platform-hook-commands.test.mjs` 守；PR 前跑 submodule `--sync` + root `--check`；PR title/body 標 `[SETTINGS-CHANGE]`、列 events；官方設定查無即 fail closed。Consumer 禁改衍生 source-owned event。

### Merge Conflict 解決策略

平行 sync 分支 merge 回 `main` 造成 pointer + `AGENTS.md` 衝突時：比較兩側 submodule SHA 時序（`git -C .devpro-agent-rules log --format='%H %ci' ... | sort -k2`），保留較新 SHA；重跑 submodule `--sync` + root `--check`；`git add` 路徑同 step 5 後用 default merge message commit。禁手動 resolve 衍生檔；若兩 SHA 間含破壞性規範變更，merge 方須確認 artifacts 符合新版規範。

### 版本策略

預設：`.gitmodules` 設 `branch = production`（穩定版，所有 consumer 預設）。Bleeding edge：`git submodule set-branch -b main .devpro-agent-rules`（開發測試版）。需固定版本：`git -C .devpro-agent-rules checkout production-v<X.Y.Z>`（或指定 SHA）取代 step 2 的 `--remote`；須在 `README.md` 或 `.devpro-agent-rules/VERSION` 註記鎖定版本與原因。

### 升級註記：skill 入口 2-entry（`devpro:` 命名空間）

- 18 支 skill 去 `dp-` 前綴：叫用由 `/dp-<x>`／`$dp-<x>` 改為 `/devpro:<x>`／`$devpro:<x>`；部分 host 以裸名 `<x>` 叫用（例如 `/<x>` 或 `@<x>`），實際形式見 active adapter；`cmux-surface-comms`、`openspec-artifact-authoring` 名稱不變；7 個 `dp-*` agent 不改名。
- 升級後先跑 `--sync`：安裝 `.claude/skills/devpro`、`.agents/skills/devpro` 兩條 entry，再 prune 舊 per-skill link 與未修改的舊 payload；自建或已修改者保留並列手動步驟。之後 commit 異動。
- 未 `--sync` 就 `--check` → exit 30 `legacy-skill-entry-residue`；catalog 內有自建 `SKILL.md` → exit 30 `skill-entry-inventory-mismatch`（自建 skill 改放 `.claude/skills/<own-name>`）。
- 部分 host 只在已信任的 workspace 載入 `devpro` entry；升級後 host 的 skill 清單看不到 `devpro:*` 時，見 `consumer-failure-playbook.md`。

### Source Repo Release

> 僅 source repo；完整流程見 `release-sit-uat-pat-prod.md` Source Repo 段。

- bump 必改 `AGENTS.md` `版本：`；禁止 no-op；merge 後接 release step 2-7
- source repo release 禁用 `release/rules-*`；PreToolUse Gate 2h 會 block source repo 建立 `release/rules-*`；只走 `release/v<X.Y.Z>` → `production-v<X.Y.Z>`

**SemVer**：MAJOR = 破壞性（移除 section / 改行為邊界 / 改 slash command 行為）；MINOR = 新功能（新 rule / 新 slash command）；PATCH = 語意不變修正（錯別字 / 澄清 / 排版）。

## Exit Criteria

- `node .devpro/scripts/sync-agent-rules.mjs --check` 回傳 exit code 0
- `git status` 顯示 `.devpro-agent-rules` 指向最新 commit
- primary checkout 在相關 `main` fast-forward 後已執行 `git submodule update --init .devpro-agent-rules`，且 `git submodule status .devpro-agent-rules` 只剩 leading space 的 aligned state（leading `+`、`-`、`U` 均為 blocker）
- sync commit message 含 `chore: sync devpro-agent-rules (<sha>)`
- sync commit MUST include executable-bit mode changes for synced `100755` paths（commit 前用 `git diff --cached --summary` 確認 mode）；`--check` 對 synced exec-bit drift fail-closed（drift＝source 標 `100755` 而 consumer index 缺，或 source 有 track 該路徑但未標 `100755`），且訊息 next step 依類別分流：缺失類指 `--sync`，source-tracked extra 類指 `git update-index --chmod=-x`（`--sync` 不會清除該 mode）；consumer 自有的 `100755` git hook（source 根本未 track 的路徑，落點 `.devpro/scripts/hooks-git/<hook>`）屬 consumer-local、不算 drift，`--check` 只 `warn` 且 exit 0，訊息不得指向 `--sync`；source 或 consumer 的 git index 不可讀時 `--check` 亦 fail closed（`--sync` 僅 `warn`；不可把讀不到的 consumer index 當空集合而誤報 missing）
- 在 `release/*` 上重跑 `--sync` 會跳過 index `--chmod=+x`（仍 copy 內容）；若 release 殘留 mode drift，MUST 回 rules lane 補進 sync commit，**禁止**在 `release/*` 任意 `git restore`
- 所有衍生檔案（`AGENTS.md`、`.claude/`、`.github/`、`.cursor/`、`.codex/`、`GEMINI.md`、`.windsurfrules`）與 submodule 來源一致

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「手動改一下 AGENTS.md 比重跑 sync 快」 | Synced／衍生 `AGENTS.md` 仍禁手改；手動改無法保證一致性，`--check` 會繼續 fail。合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。 |
| 「現在這條分支不需要最新規範，跳過 sync」 | CI 強制跑 `--check`；就算本條分支沒用到新規範，不一致就是 fail。 |

## Verification

```bash
node .devpro/scripts/sync-agent-rules.mjs --check  # 一致性
git config --file .gitmodules --get submodule..devpro-agent-rules.branch  # 追蹤分支
git status  # submodule 指向最新
git log --grep='sync devpro-agent-rules' --oneline  # sync commit 歷史
```

人工檢查項：
- sync commit SHA 與 `git -C .devpro-agent-rules rev-parse --short HEAD` 一致
- `git diff .devpro-agent-rules AGENTS.md .claude` 無手動編輯 diff

## Rollback SOP

> Load-chain（Rollback SOP）：consumer rules lane 上線後 hook／CI／衍生檔破壞，或 release 含預期外 commits（`git log <prev production tag>..<release tag> --oneline` 超出 sync pattern）時，MUST 先讀 `rules-flow-rollback.md` 再動手；rollback（`hotfix/revert-rules-<date>[-n]`）MUST NOT 直合 `production`，一律經 `release/rules-<YYYYMMDD>[-n]` carrier。觸發條件、5 個頂層步驟與 broken carrier lane 不得旁路的內容都在該 leaf，本檔不複寫。
