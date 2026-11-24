---
name: git-workflow-tracking
description: PR 建立、PR merge into main/production、integration/release/work branch push 或 tag push 後追蹤 GitHub Actions workflow 終態；Post-PR created handoff；Post-merge sync/status。
---

# Git：Workflow 追蹤與 Post-PR / Post-merge Handoff

## Overview

本檔覆蓋三項義務：主動追蹤所有被觸發 workflow 至終態、Post-PR created handoff、Post-merge sync/status。停點回報另遵守 `ai-autonomy.md` §Stop-Point Next Step Contract。Unsolicited user-visible narration throttle／豁免 → `workflow-cost-controls.md`（本檔 CI／workflow tracking 為 throttle 豁免面）。

關鍵約束：禁止叫使用者「自己去 Actions 看」；`post-PR = PR created, not merged`，後接 workflow watch ∥ Step 5.5 exemption check（並行；SSOT `post-pr-completion-gate.md` §Step 5 ∥ Step 5.5 Parallelism；禁以 CI 終態作 sticky 前置）；只有非豁免 PR 才需要 cross-model review before merge。豁免 PR（尤其 `chore/bump-v<X.Y.Z>`）記錄/回報 exemption evidence 後，接續 merge gate / release runbook，不 dispatch cross-model reviewer；`post-merge = PR merged`，後接自動 sync/status；`gh pr create` / `gh pr merge` 不等於流程結束。

## When to Use

- `git push` 到已綁定 workflow 的 `integration` / `release/*` / work branch，或 tag push 後
- PR 建立（`gh pr create`）完成後
- PR merge into `main` / `production`（`gh pr merge`）完成後
- 任何會觸發 GitHub Actions 的 git 操作完成後

## Process

### PR 建立 / Merge / Push 後追蹤 workflow

任何會觸發 GitHub Actions 的 git 操作完成後（PR 建立、PR merge into `main` / `production`、`push` 到 `integration` / `release/*` / 其他 work branch、tag push、或其他已綁定 workflow 的合法分支推送），AI **必須主動**查詢該次 run 的結果並回報，**禁止**叫使用者「自己去 Actions 看一下」。

**強制步驟：**

1. **列舉所有被觸發的 workflow**：檢查 `.github/workflows/` 中 `*.yml`／`*.yaml` 的 `on:` 條件，列出此次操作 **直接觸發**的所有 workflow。再檢查是否有 `on: workflow_run` 依賴前述 workflow 的**間接觸發** workflow——一併列入追蹤清單。確認此次操作未觸發任何 workflow 後，才回報未觸發。

   **No-trigger 判定 SOP**（同一 repo、事件與 commit 查不到適用的 workflow runs 時。查詢失敗要回報 `CI: 未定`）：
   0. **前置：先從 git top-level 驗 `.github/workflows/` 目錄存在性**（在讀 yml 分類之前）——不得用 hook/command 當下 subdir 當 repo root；先 `git rev-parse --show-toplevel` 取得 root，再看 `<root>/.github/workflows/`。**驗的是被追蹤的那個 repo、該事件用來讀取 workflow 的 commit**：從 hub 追別的 repo 時，讀 GitHub 該次事件使用的 workflow 清單（寫完整 commit SHA；分支名之後可能被推進，不能當 ref）——有該 repo 的 checkout 用 `git -C <checkout> ls-tree --name-only <commit> .github/workflows/`，沒有就用 `gh api --hostname github.com "repos/OWNER/REPO/contents/.github/workflows?ref=<commit SHA>"`（不帶 `ref` 讀到的是預設分支；不寫 `--hostname` 時 gh 依 `GH_HOST` 或預設 host 查，可能查到別站）；不得拿目前 checkout 的目錄或預設分支的清單判 N/A，後續 1-4 的 yml 也讀同一個 commit 的。以成功且完整的查詢確認 `.github/workflows/` 目錄**不存在**（或存在但無任何 `*.yml`/`*.yaml`；GitHub Actions 兩種副檔名皆合法，勿只驗 `*.yml`）→ workflow 未觸發是**確定終態**、**不**進 sleep-retry watch loop，直接依步驟 4 核對 required check 再判 **N/A**。查詢失敗、單憑 API 404 或無法確認該 commit 的清單 → `CI: 未定`。若 git root / workflow dir 探測不可得，且存在 pending marker，post-merge hook 必須輸出 `Post-merge workflow discovery not checked`，列 pending marker count、markerDir、workflowPath 與 reason；不得靜默略過 workflow watch（前饋 > 事後 gate，`ai-autonomy.md` §9）。**目錄存在且有 `*.yml`/`*.yaml`** → 進 sub-item 1-4 逐檔分類 trigger schema：
   1. **事件與 ref**。逐一比對 workflow 的事件、活動類型與 branch/tag 條件。只有 `workflow_dispatch` 或 `schedule` 等其他事件的 workflow 不列入這次追蹤。tag push 依 tag 條件判定，不套用路徑篩選。
   2. **取得路徑篩選需要的證據**。在目標 repo 的 checkout 使用該次事件的完整 commit SHA。禁止用 PR 目前的 diff 或目前的 `HEAD` 代替。
      - 既有分支 push 使用兩點 diff `git -C <checkout> diff <before commit SHA> <after commit SHA> --name-only`。兩端直接比對也能涵蓋 force push 退回舊 commit 移除的檔案。
      - 新分支 push 使用最深 commit 所在推送歷史的比較基準（GitHub 定義為其祖先的父 commit），與該次 push 的 after SHA 做兩點 diff。基準無法確認時回報 `CI: 未定`。
      - PR 使用 `git -C <checkout> diff <base commit SHA>...<head commit SHA> --name-only`，從該次事件的 merge base 比到 head。
      - 缺目標 repo 的 checkout、缺事件 commit、三點比對缺 merge base、diff 結束碼非 0 或檔案清單不完整，均回報 `CI: 未定`。先驗結束碼，再使用輸出。空 stdout 只有在 diff 成功且清單完整時才代表空清單。
   3. **套用 GitHub 的路徑規則**。下列規則適用於事件與 ref 條件已符合的 workflow。已證實的略過篩選條件優先於步驟 2 的檔案清單判斷。詳見 [GitHub Actions 的 diff 比較規則](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons)。
      - 查證 push 超過 1,000 個 commit 時，略過路徑篩選並追蹤 workflow。待判的 push 無法核實此 commit 數上限時，不能用路徑比對判 N/A。
      - 查證 GitHub 產生 diff 逾時時，略過路徑篩選並追蹤 workflow。本機 diff 成功只證明本機比對可用。
      - diff 超過 3,000 個檔案時，GitHub 只用它取出的前 3,000 個檔案。無法確認 GitHub 使用的清單且判定取決於這個子集時，回報 `CI: 未定`，禁止自行依本機排序截取。
      - diff 成功且完整清單沒有改檔，路徑篩選略過該 workflow。對含改檔的有效清單，`paths` 依 YAML 的 glob 順序處理否定與重新納入，沒有任何符合的路徑才略過。`paths-ignore` 在所有路徑都符合忽略規則時才略過。
   4. **彙總此次事件**。該次操作實際出現的 check 或 run 優先於本機推算。即使 run 清單為空，也先核對 PR 的 required check。因篩選略過的 required check 若為 `Pending`，必須回報 workflow 未觸發與合併阻擋，不得視為通過。所有適用 workflow 均有證據顯示不觸發，且 PR 沒有待通過的 required check，才能回報 `CI: N/A`。若皆因路徑篩選未觸發，PR body Test plan 記 `CI: N/A — path-filtered workflows did not trigger`。事件、活動類型及 ref 符合且沒有適用的路徑篩選，或依步驟 3 預期會觸發時，稍候（建議 ≥60 秒）重查同一次事件。仍查不到就 escalate，回報缺少預期的 run。證據不足時，列出缺項與下一個查證動作。

2. **逐一取得 run**：對追蹤清單中**每一個** workflow，使用 `gh run list --workflow=<filename> --branch <branch> -R github.com/OWNER/REPO --limit 3` 取得候選 run，核對該次事件的 ref、commit 與事件種類。這個按 branch 限量的清單只供找 run。查不到目標 run 時，按事件與 commit 限定查詢，確認結果涵蓋目標事件後才用來判斷缺 run。push 不留 post-merge 提醒，push 後照本節自行追到終態。合併後先依下方「合併後 Workflow 查詢」取得該次執行清單。`workflow_run` 間接觸發的 workflow 可能在前置 workflow 完成後數秒到數分鐘才出現，**前置 workflow 成功後必須再次查詢**。
3. **等待所有 workflow 完成**：追蹤清單中**所有** workflow run 都到終態（`success`/`failure`/`cancelled`）才可回報。若狀態為 `queued` / `in_progress`，**不可**直接回報「已觸發」就結束。選擇下列一種：
   - 用 `gh run watch <run-id> -R github.com/OWNER/REPO` 等到結束（適合短 workflow；repo 寫被追蹤的那個，否則 gh 從目前 checkout 找 run）
   - 或於合理間隔後重新查詢（適合長 workflow），並在每次查詢後告知使用者目前狀態
4. **回報格式**（一次講完，不分多次；逐一列出每個 workflow 的結果）：
   - Workflow 名稱 + run URL
   - 結論：`success` / `failure` / `cancelled`
   - 失敗時附：失敗的 job/step 名稱 + 關鍵 log 節錄（不要貼整份 log）
   - 失敗時附：可能原因初判（不確定就說不確定）

**失敗後的處理**：若失敗根因明確且修復方式在 task scope 內，**直接修復**並重新 push，不要只回覆「Actions 失敗了，你要不要看一下」。若根因不明或範圍超出當前 task，回報失敗後**詢問**是否要進一步偵查。若失敗屬於既有 flaky test 或環境問題（非本次變更造成），明確指出並建議是否 re-run。

**例外**：使用者已明確說「不用看 Actions，我自己會看」——記住但仍可在失敗時主動提示；操作不會觸發任何 workflow——明說「未觸發」即可。

### 合併後 Workflow 查詢

從保存這筆提醒的 checkout 執行：

```bash
node .devpro/scripts/track-postmerge-workflows.mjs --repo github.com/OWNER/REPO --pr <PR#>
```

查詢會向 GitHub 核對已合併的 PR，並依合併 SHA 取得 workflow runs。成功且完整的回應才會清除相同 repo、PR 的提醒，成功的空清單也成立。查詢或驗證失敗時，保留紀錄，處理錯誤後用同一命令重試。舊 push 紀錄可用同一指令的 `--branch <branch>` 查詢與清除，限該 repo 與分支的 push 紀錄。缺 repo 身分或 PR 編號的合併紀錄交既有到期機制處理。

單獨執行 `gh pr checks`、`gh run list` 或 `gh run watch` 可查狀態，這些指令不會清除紀錄。查詢成功後仍要依本節核對觸發與追到終態。空清單仍須依 No-trigger SOP 判讀。

### Post-PR created handoff（PR 建立後 TL 收尾義務）

`gh pr create` 成功 **不等於**流程結束。`post-PR = PR created, not merged`；此段不涵蓋 `gh pr merge` 後收尾。同一輪 turn MUST 用 bullet list 給下列 4 項（禁 table），作為 Stop-Point Next Step Contract 的 PR-specific specialization；**禁止**只回「PR 已建立」：

- **等什麼**：CI 全綠 / cross-model review / reviewer approve / merge gate
- **誰擁有下一動作**：reviewer（待審）/ TL（待修 critical 或 dispatch review）/ 自動化（CI 跑中）/ 使用者（待 approve / 待決定）
- **下一個 AI-actionable step + 依賴條件**：例「Step 5.5 exemption check（可與 workflow watch 並行；SSOT `post-pr-completion-gate.md` §Step 5 ∥ Step 5.5 Parallelism）」/「非豁免 PR：cross-model review PASS|WARN + merge gates green → PR merge」/「豁免 PR：記錄 exemption evidence + merge gates green → PR merge / release runbook」/「none，等 reviewer」。非豁免 PR 的 merge 必須在 workflow watch、Step 5.5 exemption check 與 cross-model review before merge **皆完成**後才可嘗試（完成條件並行可滿足，非「先 watch 再 5.5」）；豁免 PR 不 dispatch cross-model reviewer。
- **TL 平行可做事項**：例「同時可起草 next chore 的 brd」/「none，避免 context 污染」

若上述 4 項中的 owner 是使用者，或下一步因 Ask First / cross-repo PR 停點 / merge authorization 暫停，4 項 bullet **不能**當作交棒完成。回覆結尾 MUST 依 `stop-point-comms.md` 加上 `為什麼停 / 要你做什麼（回數字） / 回了會怎樣`，選項須可直接回數字且末項開放。例：cross-repo PR（builder `pr_repository_mismatch`）是停點；merge Ask First 時，給 `1.是，授權 AI merge 2.否，先停 3.其他`。已有 same-change batch approval 覆蓋的 git/PR write 不得再問，owner=TL/reviewer 並直接繼續。

**Merge 後 archive 核對（PR 作者）**：正常流程中首次 archive 必須已在 spec freeze 後、首次 push/PR 前完成並納入同一 PR；`gh pr merge` 後**不得**再跑一般 `openspec archive <name>`。merge 後 TL 只需在 4 項 handoff 中明示 archive 狀態（例：「archive already included before merge」）。若 merge 後才發現漏首次 archive，才依 `openspec-step-1-to-9.md` §Post-merge Archive Recovery 補救（命名 `chore/docs-archive-<name>-recovery`，含 `decisions.md` recovery-rationale），**漏跑記錄於 issue tag 原作者**避免重複違規。SOP 流程**不複寫於本檔**，以 `openspec-step-1-to-9.md` 為權威來源。

**Terse continuation handoff guard**：Post-PR created / post-merge / cleanup handoff 若留下多個後續，MUST expose `CurrentIntent` / `NextAction` / `AskFirstPending`，讓 `go` / `merge` / `continue` 不會綁到 stale cleanup；短指令與 handoff 衝突時以最新使用者訊息為準，先重述 intent 再做 git/GitHub write。

**Ready success path guard**：workflow / cross-model / merge-gate 成功或豁免後，`PASS/WARN`、`PASS|WARN`、skip/exempt、checks green、PR URL 都不是 terminal response。Post-PR ready response MUST follow `post-pr-completion-gate.md` Ready Response Next-Step Contract：列 `CurrentIntent`、`NextAction`、`AskFirstPending`、owner、next action、success condition；若 next action 是 merge authorization 或其他 user-owned Ask First，結尾 MUST 給 numbered options。若 owner=TL 且 batch approval / existing authorization 已覆蓋，TL MUST continue rather than stop at verdict/skipped/exempt。Owner=user + merge Ask First 時另含 `ChangeContext:` 與 `ManualTest:`（規格見 `post-pr-completion-gate.md` Ready Response；本檔不複寫階梯／cap／語態／N/A 形狀）。

與上一段關係：操作面（checks/list/watch）與溝通面（4 項）並行、不可互相取代。

**例外**：使用者已明確說「不用看 Actions / 不用列 next step，我自己會看」——記住但仍可在 PR merge 後或 workflow 失敗時主動提示。

> 操作面 checklist 見 `devpro:pre-pr` 第五步。

### Post-merge completion handoff（PR merge 後自動 sync/status）

`gh pr merge` 成功後，`post-merge = PR merged`。同一輪 turn MUST 先追蹤 merge 觸發 workflow 至終態或明示 N/A，再自動執行 §Post-merge Local Sync 的 `sync/status`；這不是使用者選項，也不得延到下一輪。完成後先 delete completed claimed pending entries from `notes/session-pending.md` for the merged change，才給 4 項 handoff，且 next state MUST 先套用 **post-merge handoff priority: Recap-first after sync/status**：

Ordered continuation priority: `sync main -> recap -> user-requested release -> production back merge -> cleanup`. cleanup MUST NOT be offered as first next action before production.

- 若本 change 符合 `session-recap.md` content threshold 且尚未寫 Recap，第一順位 / `NextAction` / `選項 1` MUST be `Session Recap Discussion creation`。
- `release / bump / next-work options` 只能在 Recap 已寫、明示 N/A、或使用者明確改選後才接續；不得用 release、bump、cleanup 或「等下一需求」取代 Recap-first handoff。
- cleanup 仍只能作狀態註記 `cleanup deferred until production`，不得因 Recap 不 due 或已完成而升成下一步。

Recap priority 已處理後，才依 merge target 給 4 項 handoff 的 next state：

- **可促進單位 → `main`（source repo）**：「累積到下次 release flow（per `release-sit-uat-pat-prod.md` Step 1-7）」/「接續 `chore/bump-v6.X.Y`」/「none，等下一需求」。**禁止**建議 consumer `devpro:sync-rules`——submodule 鎖 `production`，未走 release flow + tag 前 consumer 跑 sync 不會看到本次變更（per `AGENTS.md §8` + `rules-flow.md`）。cleanup 只能狀態註記 `cleanup deferred until production`。
- **`release/*` → `production` + tag**：「接續 Step 6A：把 `production` 合回 `main`（back-merge PR；gate exit 0 前不算 release 完成）」/「consumer repo 可跑 `devpro:sync-rules` 拉 production」/「announce + monitor 一輪告警週期」。
- **Hotfix carrier → `production` + tag → back-merge PR → `main`**（source／consumer 同構）：「組裝 promote + tag + back-merge PR 完成」（per `release-hotfix-carrier-lane.md` §Hotfix release-carrier lane；grandfathered legacy hotfix 見同節 §Grandfathered legacy hotfix completion）。

**Merge 後 archive 核對（PR 作者）**：正常流程中首次 archive 必須已在 spec freeze 後、首次 push/PR 前完成並納入同一 PR；`gh pr merge` 後**不得**再跑一般 `openspec archive <name>`。merge 後 TL 只需在 4 項 handoff 中明示 archive 狀態（例：「archive already included before merge」）。若 merge 後才發現漏首次 archive，才依 `openspec-step-1-to-9.md` §Post-merge Archive Recovery 補救（命名 `chore/docs-archive-<name>-recovery`，含 `decisions.md` recovery-rationale），**漏跑記錄於 issue tag 原作者**避免重複違規。SOP 流程**不複寫於本檔**，以 `openspec-step-1-to-9.md` 為權威來源。

### Post-merge Local Sync（merge 完成後本地同步，強制）

`gh pr merge` 成功 → 遠端產生 merge commit，本地 main/production **必落後**遠端。TL **必須**主動同步，否則下次 worktree / branch routing / anchor 會用 stale ref，與 `devpro:pre-pr` Pre-flight #4「Stale local main 偵測」形成可避免迴圈。

執行序列（依 merge target 分流；不得跳）：

| Merge target | 同步序列 |
|---|---|
| `main`（feature/bugfix/chore PR）| `git checkout main && git pull --ff-only` |
| `production`（release/v* 或 release/<date>-<sha> PR）| `git checkout production && git pull --ff-only --tags` → `git checkout main && git pull --ff-only`（bump 已先合 main；Step 6A back-merge PR 合併後 `main` 會再前進，該 PR merge 後須再對 `main` 同步一次） |
| `production`（hotfix carrier；source `release/v*` 或 consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`）| 同 `production`（release/v*）列；back-merge PR merge 後另同步 `main` |
| `main`（hotfix carrier back-merge PR，或 grandfathered legacy `hotfix/*`→`main` PR #2）| `git checkout main && git pull --ff-only` |

**從 linked worktree（`.worktree/<change>`）執行**：cwd 的分支是 feature/bugfix/chore 時，`git checkout main` 會失敗（`main` 已由 main checkout 持有），在該分支 `git pull`／merge main 又會被 Upstream pollution gate 擋。同步改對 main checkout 做：`git -C <main-checkout-root> pull --ff-only origin main`（`<main-checkout-root>` 是 `git worktree list` 第一列），下方 status verification 也以 `git -C <main-checkout-root>` 執行；MUST NOT 為了同步而 `cd` 進 main checkout 做其他 git 寫入，也不得在 worktree 分支上 pull main。Stop hook（`post-merge-check.mjs`）是 backstop：本 session 有 merge 目標為 `main` 的 merge marker，且 main checkout 的本機 `main` 還沒有 `Merge pull request #<N> ` 提交時，會在 turn 結束提醒並帶出上述指令（只讀本地，不 fetch、不查 gh；marker 缺 PR 編號或目標分支、或目標是 `production`／release 分支則不提醒，後者的同步序列見上表，hook 不涵蓋）。提醒不取代本節的同輪執行義務。

**host 擋下 `git -C <main-checkout-root>` 時**（例：worktree 隔離 session 拒絕指向共用 checkout 的 git 指令；host 細節見 active adapter，如 `platform-adapters/claude-code.md` §風險 G）：同步義務不變，仍在同一輪交棒（照 `stop-point-comms.md`）——請使用者在輸入列執行 `! git -C <main-checkout-root> pull --ff-only origin main && git -C <main-checkout-root> status --short --branch && git -C <main-checkout-root> log main..origin/main --oneline`（`<main-checkout-root>` 換成 `git worktree list` 第一列的實際路徑，可直接貼上），或改在 main checkout 的 session 執行同一指令；拿到輸出且 `main..origin/main` 為空前 MUST NOT 宣稱已同步，也不得改在 worktree 分支 pull main、`cd` 進 main checkout 或換寫法繞過。

完成後**保持在 `main`**（除非當前流程需在其他 branch，例：release Step 7 prune 後切回 main 是合規收尾）。接著執行 status verification：`git status --short --branch`；merge target 為 `main` 時 `git log main..origin/main --oneline` 必須為空。consumer 有 `.devpro-agent-rules` 時，另看 `git submodule status .devpro-agent-rules`：開頭為空白才算對齊；`+`／`-`／`U`（例如 cloud routine 或其他 clone 做完 rules sync、本機 `git pull` 之後）MUST 執行 `git submodule update --init .devpro-agent-rules`，且不得 commit 這個差異（`git add -A` 會把舊 pointer 帶進 commit、把 rules 版本退回去）；`devpro-doctor.mjs` consumer mode 的 `submodule checkout` 檢查會唯讀回報同一狀態，SessionStart 在 consumer clone 發現同一狀態時也會附一行指向 doctor 的提醒（不含修法）。

### Consumer Rules Lane Primary-Checkout Close-out

當 merged unit 是 consumer rules lane，且上述序列已在 primary checkout fast-forward `main`（包括 rules PR merge，以及適用的 production-continuation reconciliation 回到 `main`）後，MUST 立即執行 `git submodule update --init .devpro-agent-rules`，再檢查 `git submodule status .devpro-agent-rules`；這必須先於 rules-flow 對 `production` branch 或 anchor 缺失的 continuation blocker 判斷。這只對齊已由 `main` 記錄的 gitlink SHA，MUST NOT use `--remote` 選取較新的 source revision。

若 status 顯示 leading `+`、`-` 或 `U`，代表 submodule pointer 未完成對齊（分別為 HEAD mismatch、未初始化或 unmerged state）：MUST 以此輸出作為具名 blocker，且 MUST NOT declare `/devpro:sync-rules`, sync, or release complete，直到 status 只剩 leading space 的 aligned state。MUST NOT stage the stale SHA back to `main`，也不得以 commit、stash、discard、restore 或 force 隱藏 mismatch；update 失敗或 persistent non-space status 仍交由既有 dirty-tree / stop-point 規則處理。

**Post-merge sync ≠ 可刪分支（強制 guard）**：本地同步完成 **不代表**剛 merge 的分支可清理。剛 merge 進 `main` 的可促進單位**尚未上 PROD**，上線前若出問題須回原分支修——故 sync 完成後**不得**順手刪分支/移 worktree（這正是「同步＝收尾＝可清理」的常見誤判）。merge to main 後不得把 branch/worktree cleanup 列成 `NextAction`、`AskFirstPending`、`選項 1` 或任何第一順位下一步；只能列為狀態註記 `cleanup deferred until production`。post-merge-pre-release 停點 MUST NOT 端出 post-PROD 清理矩陣（`git-branch-hygiene.md` §Post-PROD Cleanup Decision Matrix 階段適用：矩陣只在 release Step 6／PROD tag pushed 後才出）。涵蓋面：merge 後的 `git push origin --delete` / `git branch -d`/`-D` / `gh pr merge --delete-branch` / `git worktree remove`。**判定（清理時機、具名授權、豁免與否、hook 未擋 ≠ 授權）以 `git-branch-hygiene.md` 為唯一 SSOT**（§使用者明示授權刪除未上 PROD 分支 + §禁止 AI 自行判斷豁免）；本段僅為 sync lifecycle 就近提醒，字面屬摘要，**與 SSOT 牴觸時一律以 `git-branch-hygiene.md` 為準**，不在此複寫判定原文。

**Why**：避免 stale ref 讓 (1) `detect-branch-base.mjs --anchor` 誤算 mainAheadCommits、(2) 下次 worktree 從舊 main 建、(3) `devpro:pre-pr` Pre-flight #4 反向補救。

## Exit Criteria

- 所有被觸發的 GitHub Actions workflow 均到達終態（`success` / `failure` / `cancelled`）
- PR 建立後 TL 已主動給出 4 項 Post-PR created handoff（等什麼 / 誰擁有下一動作 / 下一個 AI-actionable step / TL 平行可做），且已進入 workflow watch ∥ Step 5.5 exemption check（並行；SSOT `post-pr-completion-gate.md` §Step 5 ∥ Step 5.5 Parallelism）；非豁免 PR 才進 cross-model review before merge，豁免 PR 已記錄 exemption evidence
- merge 後本地已執行 Post-merge Local Sync 序列與 sync/status（依 merge target 分流，最終停在 `main`、`git status --short --branch` 無非預期 dirty、且 `git log main..origin/main --oneline` 為空；consumer rules lane 另已完成 Primary-Checkout Close-out，`git submodule status .devpro-agent-rules` 只剩 leading space 的 aligned state，leading `+`、`-`、`U` 均為 blocker；host 擋下 `git -C <main-checkout-root>` 時，以使用者 `!` 執行回傳的輸出為準）
- post-merge handoff 已套用 Recap-first after sync/status：Recap due 時 `Session Recap Discussion creation` 是第一順位，cleanup 只作 deferred 狀態

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「先 push 等使用者回報 Actions 結果就好」 | `gh run watch <run-id>` 一行就有結果；叫使用者去看是違規，AI 必須自己查到終態再回報。 |
| 「PR 已建立，待使用者 merge」 | 此屬 **Post-PR created handoff §下一個 AI-actionable step** 違規。正確：workflow watch ∥ Step 5.5 exemption check（並行；禁等 CI 才開 sticky）→ 非豁免 PR 跑 cross-model review before merge；豁免 PR 記錄 exemption evidence 並接續 merge gate / release runbook，不 dispatch cross-model reviewer。merge 仍要兩邊 gate 全過 + Ask First。把 merge 推給使用者、跳過非豁免 review gate，或把豁免 PR 誤要求 cross-model review 都違反 hub 規範。 |
| 「merge 完成、Actions 終態回報，本地 sync 下次再說」 | 違反 **§Post-merge Local Sync**。下次 worktree / anchor 計算會用 stale ref，`devpro:pre-pr` Pre-flight #4 stale-main 必觸發，等於把同步成本推到下一輪。merge 後同 turn 補 `git checkout <target> && git pull --ff-only` 與 `git status --short --branch` 才算流程閉環。 |
| 「post-merge sync/status 做完，就直接問 release / bump / next-work 或等下一需求」 | 違反 **post-merge handoff priority: Recap-first after sync/status**。若 Recap due，`Session Recap Discussion creation` 必須是第一順位；release / bump / next-work options 只能在 Recap disposition 後接續。 |
| 「分支已 merge 進 main，順手把 local/remote 分支跟 worktree 刪掉收尾」 | 違反 **§Post-merge sync ≠ 可刪分支 guard**。merge 進 `main` ≠ 上 PROD；上線前出問題要回原分支修。cleanup 只能報 `cleanup deferred until production`，不得列成 `NextAction`、`AskFirstPending` 或 `選項 1`。`git push origin --delete` / `git branch -d`/`-D` / `gh pr merge --delete-branch` / `git worktree remove` 的時機與授權判定以 `git-branch-hygiene.md` 為 SSOT（§使用者明示授權刪除未上 PROD 分支 + §禁止 AI 自行判斷豁免）。 |

## Verification

```bash
# 列出當前分支所有 workflow run（取最近 5 筆）。先用 `git branch --show-current` 取分支名，再寫成字面值（例：feature/x）；
# 同時寫明 -R github.com/OWNER/REPO；push 不留 post-merge 提醒，push 後照本節自行追到終態
gh run list --branch <branch> -R github.com/OWNER/REPO --limit 5

# 等待特定 run 完成（repo 寫被追蹤的那個）
gh run watch <run-id> -R github.com/OWNER/REPO

# 確認特定 PR 的 CI 狀態
gh pr view <N> --repo github.com/OWNER/REPO --json statusCheckRollup --jq '.statusCheckRollup[] | {name: .name, conclusion: .conclusion, status: .status}'

# push 後必須查所有 workflow
grep -n "所有被觸發的 workflow" .devpro/agent-rules/git-workflow-tracking.md
```
