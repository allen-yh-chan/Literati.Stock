---
name: git-branch-hygiene
description: 已上線分支/worktree 清理 + commit 前 local/submodule 檢查。觸發：release flow step 6 後、commit 前。
---

# Git：分支衛生與 Commit 前檢查

## Overview

本檔覆蓋已上線分支/worktree 清理、保留清單、未上 PROD 強制刪除例外、commit 前 local/submodule 檢查。

關鍵約束：刪分支/worktree 前一律取得使用者同意；commit 前確認 local settings 與 submodule 乾淨。

## When to Use

- Release flow Step 6 之後（PROD tag pushed，一輪 release 結束）
- 執行 `git add` / `git commit` 之前（commit 前檢查）

## Process

### AI 提醒刪除分支

**時機**：Release flow Step 6 後（PROD tag pushed）。`hotfix/` 與既有分支續做不觸發；清單空則跳過。

**判定**：`git merge-base --is-ancestor <branch-tip> <production-ref>` 為真即已上 PROD；`<production-ref>` 優先 `origin/production`，否則 local `production`。`prune-merged-local.mjs` 掃描不含 `rules/*` 與 `release/rules-*`（改由 `prune-rules-lane.mjs`：main-merged 即可刪，因 production 為 cherry-pick 另一 SHA）。其他 `release/*` 另要包含其 tip 的 `production-*` tag 已在 `origin/main`（Step 6A 已合回）才是候選：合回 main 的 PR 以 release branch 當 head，未合回的列「kept until Step 6A」；`origin/main` 無法驗證時保留。

**動作**：掃描 `feature/*`、`bugfix/*`、`chore/*`、`hotfix/*`、`release/*`（不含 `release/rules-*`），列候選（跳 keep；有未提交修改或未追蹤檔的 worktree 連同其分支跳過並列出）→ 輸出標示 dry-run、`--exec` 需授權 → 同意後才刪；保留用 `--keep <branch>`。`rules/*`／`release/rules-*` 走下方 Rules Lane 入口。

**禁止自動刪除**：刪分支不可逆，一律要使用者同意。

**範圍：MCP `github_delete_branch`**：上一條約束 AI 發起的每一次刪除；批次清理仍走本檔的 `prune-merged-local.mjs` 入口。AI 自己判斷要刪就先問；使用者已點名要刪的分支即算同意。MCP `github_delete_branch` 只在 `tool-selection.md` 允許改走 MCP 時使用（本機 gh 不可用），只刪單一遠端分支、不動本機 branch／worktree，並另由後端政策把關（[github-operation-gates.md](../../docs/github-operation-gates.md)）：已上 production 且不是 open PR head 的分支可刪；其他分支要本人在 Portal 一次性確認，這就是本人同意；保護分支、預設分支、open PR base 一律拒絕。政策對 `release/*` 照一般分支判定，不套本檔的 Step 6A 候選條件；AI 主動提議刪 `release/*` 時仍照本檔條件列候選。

### Post-PROD Cleanup Decision Matrix

Step 6 的 `prune-merged-local.mjs` 與 `prune-notes-tmp.mjs` dry-run 都完成後，任何只處理告警觀察的 stop point **之前**，MUST 先交付 `Post-PROD Cleanup Decision Matrix`。矩陣以編號列出實際候選的獨立 consent：production-shipped local/worktree 候選用 `node .devpro/scripts/prune-merged-local.mjs --exec`；有 production-shipped remote 候選時，另列 `node .devpro/scripts/prune-merged-local.mjs --include-remote --exec`；有 known non-state `notes/tmp` 候選時，另列 `node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of <time>`。最後一項 MUST 是開放項（依 `stop-point-comms.md`）。告警觀察只能在矩陣之後接續，不得取代矩陣。

**階段適用（stage-applicability）**：本矩陣只在 release Step 6（PROD tag pushed 後）適用——merge 後未上 production（post-merge-pre-release）的停點 MUST NOT 端出本矩陣，改只報 `[unshipped-mainline]` 狀態＋`cleanup deferred until production`（無 post-PROD 清理義務）；早清需明示 `--include-unshipped-mainline` 較強同意。矩陣候選只列本 change 相關候選；既存無關分支／worktree MUST 明確標註為既存項，不得列為本 change 的 consent 候選。

**遠端 unshipped-mainline 清理的前置提醒**：`--include-unshipped-mainline --include-remote --exec` 會讓下一輪 release Step 1 對每個已清單位判 `restore`（Step 1 第 4 項要求 `refs/remotes/origin/<branch>` 存在，見 `release-step-1-7.md`；`prune-merged-local.mjs` 列這類遠端候選時也印同一警告）。仍要清就同時準備走該項的使用者授權還原（最後一筆 MERGED、同 repo PR 的 `headRefOid`）。

unknown tmp、`notes/tmp/state/**`、unshipped-mainline refs 與 dirty worktree 不因本矩陣取得授權；仍依各自既有更強 consent / fail-closed 分流處理。

指令：
- 掃描（dry）：`node .devpro/scripts/prune-merged-local.mjs`
- 執行 local/worktree 批次刪除（production-shipped；不碰 remote）：`node .devpro/scripts/prune-merged-local.mjs --exec`（或 `--local-only --exec` 明示 local-only）
- 顯式遠端刪除 opt-in（production-shipped）：`node .devpro/scripts/prune-merged-local.mjs --include-remote --exec`
- verified main-contained ∩ ¬prod local/worktree consent：`node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --exec`
- unshipped-mainline remote stronger consent：`node .devpro/scripts/prune-merged-local.mjs --include-unshipped-mainline --include-remote --exec`（會讓下一輪 release Step 1 判 `restore`，見上方前置提醒）
- 廢棄分支單分支覆蓋（只刪本地）：`node .devpro/scripts/prune-merged-local.mjs --force-delete <branch>`
- 同上並刪 origin 同名分支（OID lease；拒絕 `release/*`）：`node .devpro/scripts/prune-merged-local.mjs --force-delete <branch> --include-remote`
- 廢棄本地 `release/*` 雙重 opt-in：`node .devpro/scripts/prune-merged-local.mjs --force-delete --allow-release <release/branch>`
- 核對並具名授權單一 orphan directory 後：`node .devpro/scripts/prune-merged-local.mjs --remove-orphan <absolute-path>`（專用模式，不可搭配其他旗標；不刪 branch／remote）
- 寫入 keep 清單：`node .devpro/scripts/prune-merged-local.mjs --keep <branch> [<branch>...]`
- 查看 keep 清單：`node .devpro/scripts/prune-merged-local.mjs --keep-list`
- Rules Lane 產物（`rules/*`／`release/rules-*`）dry-run：`node .devpro/scripts/prune-rules-lane.mjs`
- Rules Lane 產物 local/worktree：`node .devpro/scripts/prune-rules-lane.mjs --exec`
- Rules Lane 產物含 remote：`node .devpro/scripts/prune-rules-lane.mjs --include-remote --exec`
- `prune-rules-lane.mjs` 先跑 `git fetch --prune`：失敗時 dry-run 警告 refs 可能過期，`--exec` 拒絕、不刪任何東西；也跳過 keep 清單裡的分支。

Dry-run 旗標規則：`prune-merged-local.mjs` dry-run 是「無參數模式」。`--dry-run` 不是合法旗標；規範、handoff、recap、PR body 禁寫。

有效範圍回報：每次 `prune-merged-local.mjs` 掃描都必須列出 `Effective scan scope`，至少包含 `git fetch --prune` 是否完成、實際使用的 production ref（`origin/production` 或 local `production` fallback）、`mainline-ref`（`origin/main` 三態，用於區分「內容已合入主線」與弱 push-tracking proxy；`verified` / `unavailable` / `query-failed` 是內部狀態名，實際輸出依序為 `mainline-ref: origin/main`、`mainline-ref: unavailable (…)`、`mainline-ref: origin/main (containment query failed: …)`）、branch snapshot 條數、remote ref visibility 條數、worktree snapshot 條數，以及 `degraded effective scope` 或 `effective scope complete`。`--exec` 在 `git fetch --prune` 失敗時必須拒絕執行；dry-run 可降級繼續，但輸出不得讓「沒看到候選」看起來等同完整掃描。

Keep 清單檔案：`.git/info/deletable-keep`（local per-repo，不進 git 歷史；`prune-merged-local.mjs` 與 `prune-rules-lane.mjs` 共用，從 linked worktree 執行也讀寫同一份）。

### Local Branch Hygiene（本地分支清理）

時機見 When to Use；與 prune-merged-local 同 batch，判定同上。

```bash
node .devpro/scripts/prune-merged-local.mjs
```

動作：fetch --prune → 找 tip 為 `<production-ref>` ancestor 的分支（shipped）以及（dry-run 另列）verified main-contained ∩ ¬prod（unshipped-mainline，需獨立 consent）→ 排除當前/main/production → **列出候選 + 詢問使用者確認** → 同意後才執行（default `--exec`：worktree → local shipped；remote 用 `--include-remote --exec`；unshipped-mainline 用 `--include-unshipped-mainline`，遠端再加 `--include-remote`）。「no branches eligible」可靜默。

**Ask First 遠端層**：dry-run 列出 ≥1 production-shipped remote 候選時，`Post-PROD Cleanup Decision Matrix` 的編號選項 MUST 含遠端刪除為獨立項（不得只寫在 dry-run 散文）。合格形狀：`1` `node .devpro/scripts/prune-merged-local.mjs --exec`（local/worktree）· `2` `node .devpro/scripts/prune-merged-local.mjs --include-remote --exec`（local+remote）· 末項開放（`stop-point-comms.md`）。預設 `--exec` 仍只刪 local/worktree。使用者未選 `--include-remote` 時 MUST NOT 把 remote 刪除當預設。remote 候選 = 0 時不強制給遠端刪除編號項。

`Effective scan scope` 若標示 production-ref fallback、branch snapshot / remote visibility / worktree snapshot not checked，該次輸出只能作降級建議；不得把空候選清單當完整清理證據。需要 destructive cleanup 時，先讓降級來源恢復或使用明確 fallback evidence 交給使用者確認。`mainline-ref unavailable` / `mainline-containment query failed` 兩個 degraded reason：關閉 mainline-contained／unshipped-mainline 分類；若 argv 含 `--include-unshipped-mainline` 則整次 invocation 在任何 mutation 前 abort（含 otherwise-shipped）；無該旗標時 shipped（production ancestry）路徑維持獨立。

腳本另列「⚠️ 孤兒分支」：`git fetch --prune` 後 tracking ref 消失的本地分支（可能 squash-merge）；需**人工確認**已上線再刪。

**禁止自動刪除**：同本檔「禁止自動刪除分支」規定。

**已知限制**：squash merge 切斷 tip ancestry，主要清單無法自動確認；遵守「禁用 squash merge」可避免。

### 批次指令不涵蓋時

合規分支都有不需 `--no-verify` 的刪法，或明寫保留：

- 放棄的工作分支（含已推送、未上線就 squash 進 main、外洩到 origin 的 `review/pr<N>`）：具名同意後 `--force-delete <branch> --include-remote`。先刪 origin（檢查後 tip 被推進就拒絕）再刪本地；已合進 `origin/main` 或已上線的 `feature/`／`bugfix/`／`chore/`／`hotfix/`／`rules/*` 會被拒絕並印出負責的批次指令。
- `rules/*` 未合進 main：PR 還開著就保留，放棄才用上一條（`prune-rules-lane.mjs` dry-run 會印）。
- 尚無 production：plain `--exec` 不刪；已合進 main 的用 `--include-unshipped-mainline --include-remote --exec`。
- 放棄的 `release/*`（含 `release/rules-*`）刻意保留（刪除的好處很小，誤刪會失去追查 release 組裝與 QA 證據的依據），origin 上的不提供刪除指令；只在本機且符合下方豁免第 3 點者可用 `--allow-release`。

### Force-Push 前：驗 HEAD 內容匹配預期修正

**觸發**：任何 `git push --force` / `--force-with-lease` 改寫**已推**（已在 remote）歷史前——最常見於 cross-model / reviewer findings 修正後 `git commit --amend` 再 force-push。

**規則**：force-push 改寫已推歷史前，AI **MUST** 先驗 HEAD commit **實際內容**含預期修正，**MUST NOT** 只憑 `amend-exit=0` / `push-exit=0` 判定修正已進 commit。驗法：
- **必用（primary）**：`git show HEAD:<改動檔> | grep <預期錨點>`——直接讀 HEAD blob，確認修正字串**真在 commit 內**。這是唯一能證明「HEAD 實際內容含修正」的驗法，**MUST** 執行且通過。
- 輔助（非替代）：`git diff <old-head>..HEAD -- <改動檔>` 可幫忙核對改動範圍，但 **MUST NOT** 單獨當驗法——diff 可能把預期行顯示為**刪除**、或只顯示鄰近改動而未證明 HEAD blob 含錨點，故 diff 綠不代表內容對；仍須以上面 `git show HEAD:` grep 為準。

驗證**失敗**（HEAD 缺預期內容）→ **停下**重 stage / 重 amend，**不 push**；exit code 綠不代表 staged set 完整（amend 漏 stage、pre-commit hook / linter 改動、negative-test 還原錯位都會讓綠 exit 與 HEAD 真含修正脫鉤）。

**Why**：force-push 改寫已推歷史不可逆；推了漏修正的 commit 會**覆蓋正確歷史**，且下游（PR reviewer、cross-model sticky）可能誤判 findings 已 resolved。此段治 force-push **前**驗內容；與下方 `§Squash-Source Cleanup` 治 force-push **後**清理是接續非重複。

### Squash-Source Cleanup（PR force-push 後）

**觸發**：同一 PR 曾 squash/amend 並 force-push；PR regular merge 上線後，舊本地 WIP 分支/worktree 可能被新 head patch 吸收，但 tip 不是 `production` ancestor。

**規則**：force-push 後同一輪 cleanup turn 內，AI MUST 用唯一入口
`node .devpro/scripts/prune-merged-local.mjs --include-subsumed` 掃描
`subsumed-by-squash` 候選。使用者確認後才可執行
`node .devpro/scripts/prune-merged-local.mjs --include-subsumed --exec`，腳本 atomic 清理 linked worktree → local branch（不碰 remote）。若需刪除 remote subsumed/archive-shipped ref，必須另有明示遠端刪除授權並執行
`node .devpro/scripts/prune-merged-local.mjs --include-subsumed --include-remote --exec`。預設掃描仍只處理 production-ancestor。

**保留例外**：使用者明示要保留 archaeology / debug 分支時，執行
`node .devpro/scripts/prune-merged-local.mjs --keep <branch>` 寫入 keep 清單；
keep 清單優先於 `subsumed-by-squash` 判定。

### Local Worktree Hygiene（本地 worktree 清理）

**時機**：同 Local Branch Hygiene，Release flow Step 6 後同 batch 執行。

**判定**：`git worktree list --porcelain` → 排除主 worktree → HEAD 為 `<production-ref>` ancestor → 候選（`release/*` 另需上述 Step 6A 條件）。有未提交修改或未追蹤檔（`node_modules` link 不算）的 worktree 連同其分支跳過，dry-run 列出。`rules/*`／`release/rules-*` linked worktree 改由 `prune-rules-lane.mjs`（main-ancestor + dirty skip）。

`prune-merged-local.mjs` 同時輸出 worktree 候選清單（與分支候選並列）。

**動作**：列路徑/分支/HEAD/ancestor 證據；**詢問使用者確認**後才移除。官方入口 `node .devpro/scripts/prune-merged-local.mjs`（dry-run）→ 同意後 `--exec`。對**已註冊** linked worktree：`--exec`／`git worktree remove` **之前** MUST 拆除 worktree 內已知依賴目錄名（至少 `node_modules`）上的 junction／symlink／reparse（非遞迴、只拆 link 節點）；拆前／後（含移除失敗後）量測主 checkout 同名依賴目錄項目數，MUST 完全相同；不存在標 N/A，不可讀或主 checkout 身分無法確認則拒絕 mutation。**MUST NOT `rm -rf`** 穿 junction／symlink 清主 checkout 依賴；安全拆例：PowerShell `[System.IO.Directory]::Delete($path, $false)`、`cmd /c rmdir "<path>"`、POSIX `unlink`／`rmdir` 對 link 本身。FS 上 `.worktree/<name>` 未出現在 `git worktree list` 者為 **orphan directory**——dry-run advisory（核對後再刪）；`--exec` **不**自動刪 orphan。移除先不帶 `--force`；只有 git 因 submodule 拒絕、且再確認乾淨時才加 `--force`，不放寬確認。`--force-delete` 遇到有未提交修改的 worktree 直接拒絕、不刪任何東西。`--exec` batch 固定先移 worktree，再刪 local branch。

**Windows 長路徑與部分失敗**：Windows 移除 registered worktree 使用 `git -c core.longpaths=true worktree remove`（submodule 拒絕時才加 `--force`），不修改使用者 Git config。移除失敗後 MUST 重新查 Git registry 與目錄實況，分別回報 registered／unregistered／unknown 與 directory absent／remains／unknown；remains 不代表內容完整。非零退出、保留尚未刪除的 branch，停止後續 mutation；不得固定宣稱 worktree retained 或已 rollback。

**具名 orphan 復原**：先核對 dry-run 顯示的實際路徑與要保留的內容，另取得該目錄刪除同意，才使用 `--remove-orphan <absolute-path>`。目標只允許主 checkout `.worktree/` 的第一層未註冊普通目錄；主／目前 checkout、其祖先、範圍外、`.git` marker、任何層級的 symlink／junction／reparse、不可讀或身分不明皆拒絕。Windows 先用原生屬性證明不跟隨 reparse，再以長路徑支援刪除；主 checkout `node_modules` 項目數必須維持不變。此模式不 fetch、不刪 branch／remote；plain `--exec` 仍不自動刪 orphan。Windows explicit `--local-only` 掃描無原生 reparse 證據時，只列拒絕原因，不提供 executable orphan handoff。

**`.git` 殘留限制**：未註冊目錄仍可能保有頂層或 submodule 的 `.git` gitfile；即使看似指向不存在的 admin dir，`--remove-orphan` 仍拒絕並保留內容，不提供 executable handoff。先核對 marker 與 Git metadata，判斷懸空 gitfile 或有效 repo／submodule，再另行具名授權處理 marker；證明整棵樹無 `.git`／link／reparse 後才重試。此入口不推定 gitfile 可安全刪除。

**禁止自動移除**：worktree 移除不可逆（工作目錄消失），一律要使用者同意；orphan directory 同禁自動刪。

### Notes Tmp Hygiene（本地暫存檔清理）

**時機**：同 Local Branch Hygiene，Release flow Step 6 後同 batch 執行；平常 Stop hook / SessionStart 不自動 prune。

**判定**：`node .devpro/scripts/prune-notes-tmp.mjs` 列出 `notes/tmp/` 中超過 60 分鐘的 known non-state body/log/artifact 檔案、bytes、分類；`notes/tmp/state/**` 永遠跳過，prefix lifecycle 以 `file-write-destinations.md` registry 為準。

**動作**：cleanup report 必含 dry-run 摘要；有 known non-state 候選時，`Post-PROD Cleanup Decision Matrix` MUST 將 `node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of <time>` 列為獨立編號 consent 項，且在任何 alert-observation-only stop point 之前。使用者明確同意 cleanup 後才執行該命令。`<time>` 照抄 dry-run 印出的時間點：`--exec` 以它計算年齡，dry-run 後才過期的檔不刪，ctime 晚於它的檔，或所在子目錄 ctime 晚於它的檔（dry-run 後才建立、移入或修改，含整個目錄搬入）也不刪；沒帶 `--as-of`、日期不存在或時間晚於現在會被拒絕。unknown file 預設只列不刪；除非使用者具名同意，才可加 `--include-unknown`。

**禁止自動刪除**：tmp log/body 雖是 scratch，但仍可能是剛失敗流程的唯一 local evidence；批次刪除一律要使用者同意。

### 使用者明示授權刪除未上 PROD 分支

**治理入口**：PreToolUse 不解析裸刪除命令；遠端分支刪除由 git-native pre-push hook backstop。未上 PROD / worktree cleanup 由 `prune-merged-local.mjs`（production-ancestor）與 `prune-rules-lane.mjs`（Rules Lane 產物）分流。裸 `git branch -d/-D`、`git push origin --delete`、`gh pr merge --delete-branch`、`git worktree remove` 仍須具名同意；hook 未擋或 `--no-verify` ≠ 授權。

**本機 PR 驗證**：`review/pr<N>` 的正常生命週期見 `git-branch-naming-and-anchor.md`「本機 PR 驗證」。它不走 release subset；dry-run 列為 advisory，任何批次 `--exec` 都不自動移除其 branch／worktree。驗證結束後，先確認路徑、HEAD 與無需保留的本機修改，再具名取得刪除同意，執行 `node .devpro/scripts/prune-merged-local.mjs --force-delete review/pr<N>`。沿用已註冊 worktree 的 dependency-link teardown 與主 checkout dependency invariant；禁止改用裸 recursive delete。此具名清理不需等 PROD，亦不構成遠端刪除授權。

**罕見豁免場景**（正常工作分支寫壞、廢棄、實驗失敗等使用者主動放棄）：

1. AI **必須**先用 `AskUserQuestion` 確認該分支名 + 顯示「該分支未上 PROD，按規範本應保留至 release subset」警示，**禁止**模糊指令（「清理一下」「整理分支」）走此路徑
2. 使用者明確選「是，強制刪」→ AI 執行 `node .devpro/scripts/prune-merged-local.mjs --force-delete <branch>`（要連 origin 同名分支一起刪時加 `--include-remote`；拒絕 protected/release/current；非五前綴且非合法 `review/pr<N>` 的 ref 印「非標準工作分支」警示後放行；linked worktree 先移除；印 tip/tags）
<!-- prune-contract-action-point:start -->
3. 固定 protected bases exact set 為 `main`, `master`, `production`, `integration`，且 guard 必須先於獨立 `release/*` 規則。廢棄本地 `release/*` 須雙重 opt-in `node .devpro/scripts/prune-merged-local.mjs --force-delete --allow-release <release/branch>`；每次 destructive invocation 都要 fresh live proof：live 對**每一** remote 證明無同名、無 tracking config、tip ∈ production **或** `origin/main`，任一 probe failure/timeout/undecidable 都 fail-closed 且在第一個 mutation 前停止。explicit `--local-only` 是 invocation-wide zero-network，release evidence 必須標為 `unverified`，不得輸出 deletion handoff，只能提供不含 `--local-only` 與 destructive flags 的 non-executable verification rerun。ordered mutation 在 first failure 停止並如實回報 `worktree removed`／`branch retained`／`no later mutations attempted`，不宣稱 rollback。runtime Git argv allowlist 不在本 rule 複寫。
<!-- prune-contract-action-point:end -->
4. AI 不得在使用者口語授權（如「你看著辦」「都可以」）下走此路徑——必須具名分支 + 明示「強制刪除」意圖
5. 具名授權單分支廢棄仍優先走 `--force-delete <branch>`（或合格 `release/*` 的 `--allow-release`）；不要把裸 `git branch -D` 或 `DEVPRO_HOOK_BYPASS=1` 當常規路徑。

**禁止 AI 自行判斷豁免**：post-merge 順手清理不屬豁免；等 release flow Step 6 走 `prune-merged-local.mjs`。

### Local Delete 無 Git-Native 攔截點（誠實 gap）

**誠實記述**：local `git branch -d/-D` 與 `git worktree remove` 目前**無 git-native 攔截點**——git **不為本地刪除跑任何 hook**（pre-push 只在 push 時觸發，對本地刪除不適用），故此 gap **沒有乾淨的 mechanical backstop**。遠端分支刪除有 git-native pre-push hook backstop（讀結構化 stdin）；本地刪除沒有對應的協定 hook。

**故本 gap 只能靠**：(1) behavioral 紀律（post-merge 不順手清理、不把刪除當收尾）+ (2) 「具名同意才刪」（上節 L85 已要求：裸 `git branch -d/-D` / `git worktree remove` 仍須具名同意，hook 未擋 ≠ 授權）。

**不假裝有 mechanical backstop**：禁止文字或設計暗示「有 hook / PreToolUse parser 機械擋住本地刪除」。per `design-core.md`「Accident-Prevention Backstop Carrier」，不得用 PreToolUse command-intent regex 補這個洞（退役前代號「2g/11」的 regex gate 已因 command-intent regex 累積退役、以 regression 鎖死 `450e1c2`，重發明只會再成維護黑洞）。

### Protected-branch Agent Miswrite Recovery（誤寫已發生後的清理階梯）

**SSOT**：本段為「agent / subagent（含 Codex）把檔案誤寫進 protected branch（`main`/`production`/...）而非自己 worktree，事後怎麼乾淨收拾」的唯一權威來源。`multi-agent-handoff.md` §Recovery Checklist 與 `platform-adapters/codex.md` 風險 H 指回本段，不複寫判定。注意與「寫**前**怎麼避免誤寫」（codex.md 風險 H Protected-Branch git Write Rule + protected-branch pre-push hook）分屬 lifecycle 不同階段：本段處理**已發生**的誤寫。

**情境**：protected branch 上出現 agent 寫的未提交髒檔（protected-branch hook 已正確擋下該 branch 上的 `git restore` / `git stash` / 直接 commit）。**禁止**反射用 hook bypass 或破壞性命令清掉。依序走 4 步階梯：

1. **確認髒檔來源與 PR 狀態**：`git status` 列髒 paths；確認 (a) 這些 paths 確為 agent 本次誤寫（agent-owned，非使用者本機殘留），(b) 對應的修正是否已有 PR **merged** 進該 branch（`git log <branch>..origin/<branch>` / `gh pr view` 比對 incoming commit 是否含同一 patch）。**模糊就停下問使用者**，不自行判定。
2. **已 merged 且 incoming commit 含同 patch → 優先 `git pull --ff-only --autostash`**：這是**非破壞性**收尾——`--autostash` 自動把髒檔暫存、ff-only 拉入含同 patch 的 incoming commit、再還原 stash（同 patch 會乾淨吸收，殘留歸零）。不需 `git restore`/`git stash`（那些已被 protected-branch hook 擋且非必要）。**stop-condition**：若 autostash pop 後**殘留 conflict**（代表髒檔與 incoming 並非真正同 patch、或中間有別的改動），**停下**——視為「非同 patch」轉步驟 3（fix worktree 重做），**不**在 protected branch 上解 conflict / `git checkout`。殘留 conflict 的還原若需破壞性操作，走步驟 4 取得使用者同意。
3. **未 merged（incoming 不含該 patch）→ 路由到 fix branch/worktree 重做**：依 `git-branch-naming-and-anchor.md` 開 fix worktree、把改動重做在那裡走正常 PR flow；protected branch 上的誤寫改動捨棄前見步驟 4。**不**用 hook bypass 把改動硬留在 protected branch。
4. **任何破壞性 cleanup / hook bypass 前必須使用者明示同意**：若步驟 2/3 都不適用而需破壞性還原（如 `git checkout -- <path>` 捨棄、`DEVPRO_HOOK_BYPASS=1`），**必須**先具名列出將捨棄的 paths + 取得使用者明確「是，捨棄」才執行——呼應本檔「具名同意才刪」+「不假裝有 mechanical backstop」（hook 擋下 ≠ 授權繞過）。

> protected `main` 殘留髒檔時，步驟 2 `git pull --ff-only --autostash` 可乾淨收尾。

### Commit 前：本機設定與 Submodule 乾淨度檢查

**Local Settings 提醒**：`git add` / `git commit` 前檢查未被 `.gitignore` 排除的本機設定（如 `.claude/settings.local.json`、`.env.local`、`appsettings.Development.json`、`launchSettings.json`）。發現即詢問是否加入 `.gitignore`；拒絕或刻意 commit 則不追問。Devpro-managed baseline 由 `gitignore-alignment.md` 管理；專案 local settings 仍 ask-first。

常見 local settings 模式：`*.local.json`、`.env.local`、`appsettings.*.json`（非 production）、`launchSettings.json`、`.claude/settings.local.json`。

**Submodule 乾淨度**：`git commit` 或建 PR 前跑 `git status`，確認 `.devpro-agent-rules` 與根層 `AGENTS.md` 無 diff。若有：**禁止**塞進 feature commit；本機殘留則還原；需新版 rules 則改走 `rules-flow.md` 的 `rules/<source>-v<X.Y.Z>`。

## Exit Criteria

- 可刪除分支已提醒使用者確認（不自動刪除）
- tip 為 `production` ancestor 的本地分支已清理（無 zombie 分支）
- HEAD 為 `production` ancestor 的本地 worktree 已提醒使用者確認（不自動移除）
- `git status` 確認 `.devpro-agent-rules` 與 `AGENTS.md` 無未提交變更

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「分支已 merge，直接刪掉不用問使用者」 | 刪分支不可逆；一律詢問使用者確認，或寫入 keep。 |
| 「已 merge 到 main，可以刪了」 | merge-to-main **不是 shipped**（業務分支）。plain `--exec`／單獨 `--include-remote --exec` 仍只刪 production-ancestor。例行 main-contained ∩ ¬prod 清理須明示 `--include-unshipped-mainline`（遠端再加 `--include-remote`）；不得暗示 plain `--exec` 可刪，也不得把 `--no-verify` 當 production-lag／pre-first-release 官方收尾。**例外**：`rules/*`／`release/rules-*` 走 `prune-rules-lane.mjs`（lane 完成條件，不 OR 進 unshipped-mainline）。 |
| 「worktree 的分支已上線，直接 remove 掉」 | worktree 移除不可逆，工作目錄消失無法恢復；一律詢問使用者確認，不得自動執行。 |
| 「孤兒分支 remote 已刪就可以直接刪」 | remote ref 消失不等於已上線；squash merge 或手動刪 remote 都可能造成孤兒；需人工確認後才刪。 |
| 「fetch 完順手清一下分支，不用等 PROD 上線」 | production-shipped 批次觸發點仍在 PROD tag pushed 後（release flow Step 6）。merge-to-main 後的 unshipped-mainline 清理走獨立 consent（`--include-unshipped-mainline`），**不得** OR 進 shipped／plain `--exec`。業務分支入口 `prune-merged-local.mjs`；Rules Lane 產物入口 `prune-rules-lane.mjs`；禁 `--no-verify` 當官方 workflow。 |
| 「加 `--dry-run` 比較清楚」 | 錯；dry-run SSOT 是無參數，該旗標會失敗並中斷 cleanup。 |

## Verification

```bash
# 掃描可刪除分支（dry-run 無參數；不要加 --dry-run）
node .devpro/scripts/prune-merged-local.mjs

# 掃描可清 notes/tmp 暫存檔（dry-run 無參數；不要加 --dry-run）
node .devpro/scripts/prune-notes-tmp.mjs

# 確認 submodule 與 AGENTS.md 乾淨
git status

# 確認分支 tip 是否已 merge 進 production（exit 0 = 已上線）
git merge-base --is-ancestor $(git rev-parse HEAD) production && echo "shipped" || echo "not yet"

# 列出所有 worktree（含關聯分支與 tip SHA）
git worktree list --porcelain
```
