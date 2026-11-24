---
name: change
description: "啟動新 change 的 workflow：建立 unit-scoped feature/bugfix/chore 分支 + 其 OpenSpec change（verb whitelist precheck、chore classification routing、worktree/env startup sequence、MUST invoke /devpro:clarify pre-analyst、dp-analyst 與 dp-architect dispatch、delegation checkpoint）。使用時機：使用者 invoke /devpro:change、要求開始一個新需求或行為變更，或要求把 session-pending 條目 formalize 成 change。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:change [change-name or request]"
---

# Devpro Change

## Overview

本 skill 是 Devpro 啟動新 change workflow 的 routing 與 operational-recipe 載體。它執行 verb whitelist precheck、（條件式）session-pending claim precheck、chore classification routing、worktree + environment + meeting-notes startup sequence、（條件式）formalize auto-promote、**MUST invoke `/devpro:clarify` mode `pre-analyst`**（談需求 recipe；政策 pointer 至 leaf）、dp-analyst 與 dp-architect dispatch、change naming，以及在任何實作程式碼寫出前的強制 delegation-plan checkpoint。

**Policy SSOT 留在 rule leaves——本 skill 不重複它。** Verb whitelist、one-scope body 規則、chore classification tables、OpenSpec + Branch checklist 與 delegation 規則定義於 `preflight-checklist.md`、`chore-classification.md`、`openspec-flow.md`、`openspec-step-1-to-9.md`、`git-branch-naming-and-anchor.md`、`git-branch-and-pr-flow.md` 與 `model-delegation.md`。本 skill 只告訴你*何時*該 invoke、*如何*排序 read-then-execute 步驟與 subagent dispatch。權威決策永遠載入並執行那些規則，而非本 skill 的摘要。

## When to Use

- 使用者跑 `/devpro:change` 開始新需求或行為變更
- 使用者要求把 `notes/session-pending.md` 條目 formalize 成 change
- 既有 pre-merge branch/change/PR 收到 requirement scope change、active PR 增補需求，或使用者要求「回原分支修」同一可促進單位
- **Change Entry Gate**：使用者要求修 future AI behavior、調整 rule、workflow、process、讓 AI 以後會、或任何會改變規範/流程/行為的 repo carrier 時，TL MUST route through devpro:change/OpenSpec before any non-OpenSpec repo write；明確 no-op 或不改 behavior/gate/routing/acceptance semantics 的機械豁免，必須先寫出 exemption evidence 才可跳過
- Diagnosis-to-implementation re-entry：若 session 起點是 diagnosis / timing / read-only investigation / `just look`，且使用者後續說 `go`、`開始修`、`實作`、`do it` 或等效 implementation intent，TL MUST 視為 `/devpro:change` re-entry before any repo write，先明示 active implementation intent 並 route through devpro:change/OpenSpec；先前 read-only diagnosis MUST NOT 視為 completed change startup。若 re-entry formalize 已 claim 的 `notes/session-pending.md` 條目，且該條目記錄 batch approval，TL MUST 在第一個非 OpenSpec repo write 前完成 pre-write evidence checkpoint：active proposal/proposal-mini 的 `## Batch Approval Ledger`（lite 無 proposal 時為相符的 `lite-scope.md`）必須是 matching structured ledger，`N/A: no batch approval selected`、missing 或 mismatched ledger 皆無效；可先寫 `openspec/changes/<change-name>/` 修正 evidence。active intent / change name / approval boundary 模糊時停下詢問

TL 預設已載入 AGENTS.md §0（動手前十句自檢）+ §Intent → Action 表（hook 注入或主 agent 主動讀取均可）；`.devpro/agent-rules/openspec-flow.md` 為 router，含 step 1-9 + Archive + Source Repo Specifics + 各子能力 cross-ref pointer；命中本 skill 時讀 router；step 2a / 3a submodule sync 觸發時才讀 `.devpro/agent-rules/rules-flow-routing.md`。AGENTS.md 由 CLAUDE.md（或對應 host 的 redirect entry）project instruction always-load 注入，無需重讀。

> commit-level 禁混 simplification + feature（per `preflight-checklist.md` 點 1 延伸）：實作中若需 token trim / 純壓縮，**必須**單獨 commit；勿與行為變更同 commit。

讀完後，**先執行第零步 Batch Scope Confirmation**，再執行第一步 Verb Whitelist Precheck（含 one-scope body）；若來源是 `notes/session-pending.md` 條目，接著執行「第一點五」claim precheck；通過後才進入第二步 chore 分類路由判定。若本 skill 是 AI 主動 invoke（使用者未直接輸入 `/devpro:change`），必須先取得使用者對 command 名稱、change name、以及 batch scope 的明確確認；但使用者自然語言要求開 change、提供可安全推導的 concrete scope/name、且明說 `batch approval` 時，視同已確認 `/devpro:change <change-name>` command + parameter，不得再重問。確認前不得套用批次 git 同意。

## Process

### Rigor precheck（先於分類與 full artifacts）

MUST 先載入 `.devpro/agent-rules/rules-rigor-level.md`，以 `resolveRigorSelection({cwd})` 核對級別及來源，並核對本 session 的使用者指示；未設定預設 lite。A/B-mini/B 不等於 rigor，禁止以 B 形狀直接啟動 full。若提議升 full，先依 SSOT §升 full列出必要產物、lite 缺口與成本，再取得使用者明確同意；未同意保留原級別。一般實作指示／git batch／bounded agent 授權不取代此決定。有效的既有 full 選擇不重問；非法設定的 full 保護不算授權，先修設定。判斷檢查 `evaluateRigorUpgrade` 的 `userApproved` 只能取自實際使用者指示（cooperative-only），不得由 AI 自寫 ledger 推定。

**設計方法入口（full/lite 共用）**：跨模組、介面／ownership 未定或實作摩擦時載入 `design-reasoning.md`。TL-direct 與 dp-architect 沿相同方法；lite 用既有回覆／handoff，full 用既有 design.md，不改 artifact 或 delegation gate。

**第零步：Batch Scope Confirmation**

使用者不一定知道 `batch approval` 這個選項。TL 準備啟動 `/devpro:change` 時，若本次對話尚未明確取得 `batch approval` 或 `stepwise confirmation` 偏好，第一個 user-facing confirmation / clarification batch MUST 主動包含 batch scope 選項：

1. `batch approval`（推薦）：授權同一 named change 的 whole `/devpro:change` flow batch approval，包含 worktree/local commit、pre-PR gate、首次 push、PR create/update、workflow watch、post-PR completion gate 與 `scenario_walkthrough`；同時授權本 change 內達 mandatory delegation threshold 的 bounded subagent launch（bounded subagent launch authorization for mandatory-threshold subagent use，例如 dp-analyst / dp-architect / dp-programmer / dp-assistant）；reviewer sticky 寫回與 same-repo 第二審派送不屬 batch 授權範圍，照 same-repo 流程直接 dispatch；不含未點名的 merge/release/destructive/secrets。
   Approval evidence MUST record the named change and branch. The PR number/head SHA need not exist at approval time; post-PR gate derives the exact PR binding after `gh pr create` / PR update from the same named change, same branch, and PR creation/update evidence.
   Cross-repo write remains outside `/devpro:change` batch approval and always requires separate explicit authorization.
2. `stepwise confirmation`：每個 git/PR write 前逐步確認。
3. `其他`：使用者自訂授權邊界。

**條件式 main-tip 依賴題（併入第零步同一則訊息）**：發問前先跑唯讀的 `node .devpro/scripts/detect-branch-base.mjs --anchor`（輸出導到檔案再讀）；`mainAheadCommits` 非空時，在同一則訊息多問一題「這個 change 是否依賴這些 main 領先的 commit」，附與預計要動的檔的重疊證據與建議選項，取法與記錄位置見 `openspec-step-1-to-9.md` Step 2c；請求已明說 batch／stepwise 而第零步不發問時，在建分支前單獨問，證據同樣附上；多題並列照 `stop-point-comms.md` 規則 2 寫成行內 `Q1-1.`。建議不取代回答，回答前不得建分支。

**條件式 DEV 驗證題（併入第零步同一則訊息）**：consumer（判斷不出來照 consumer）且 rigor `lite`／`full` 才問，source repo 與 `off` 不問 DEV 題。發問前唯讀：依請求初判是否影響可部署行為（判斷不出來當作會），並找部署入口；題目附初判與理由、入口查找結果，MUST NOT 貼設定內容；判定與入口查找規則以 `pre-pr-dev-verification.md` 為準，本段只管問法。排在同一則訊息 main-tip 題之後、需求白話卡之前。初判需要：`1. 開 PR 前部署 DEV 驗證`（有 PR head 入口時推薦）／`2. 本 PR 不做 DEV（附原因）`／`3. 先開 PR，DEV 記 pending:`（只有 `env-only` 或沒找到入口時推薦；此時選項 1 改為「先在 `.devpro/pre-pr-checks.local.md` 補 `## DEV deploy-verify`（PR 分支部署指令），PR 前照它部署」）／`4. 其他`。初判不需要：`1. 同意不需要（N/A: <理由>）`／`2. 其實需要：開 PR 前部署 DEV 驗證`／`3. 其他`；與其他題並列時照 `stop-point-comms.md` 規則 2 寫成行內 `Q<n>-<m>.`。請求已明說 batch／stepwise 而第零步不發問時，DEV 題在建分支前單獨問（可與 main-tip 單獨題、單獨送卡併成一則），回答前不得建分支。

**需求白話卡（請確認或改）（併入第零步同一則訊息）**：不變量與欄位規則 SSOT 是 `ambiguity-scoring.md` §Operator usage probe（anchor `plain-language-card-before-first-implementation-write`），出卡前 MUST 先載入該節依欄位規則合成。lite 全分類與 full 初判 A／B-mini（第二步尚未執行，依 `chore-classification.md` 判斷表對請求初判）在第零步訊息另起一區附五欄卡，排版照 `stop-point-comms.md` 規則 5：為什麼停 → 授權選項 → （條件式）main-tip 題 → （條件式）DEV 驗證題 → 需求白話卡 → 回了會怎樣（回授權數字＋DEV 題號＋「卡 OK」或改某一欄）。卡確認（改欄後再確認）前 MUST NOT 建 worktree；任一欄仍是 `UNRESOLVED:` 不算確認（回「卡 OK」亦同），只就該欄提問；改欄時只重送卡區，授權回答保留。full 初判 B 不在第零步出卡，照第四步 pre-analyst 訪談後出卡。第零步不發問時，依第二步正式分類定落點：lite 全分類與 full 判 A／B-mini 在第三步前單獨送出卡並等確認（可與 main-tip 單獨題併一則）；full 判 B 不提前。第二步正式分類與初判不符時：初判 B、正式 A／B-mini → 第三步前單獨送卡；初判 A／B-mini、正式 B → 第四步訪談後仍重呈卡請確認或改，再寫 `decisions:`。

**card capsule（卡確認後、建 worktree 前寫好）**：第零步路徑確認的卡（含第三步前單獨送出的卡：第零步不發問，或初判 B 而第二步正式判 A／B-mini）寫成 `<main-checkout-root>/notes/session-pending.md` 的 claimed capsule（`<main-checkout-root>` 取 `git rev-parse --git-common-dir` 的 dirname），讓 context 壓縮或 session 重啟時能續接；stepwise 下也要在等建 worktree 同意的那次停下前寫好。full＋B 的卡照舊只寫 meeting-notes `decisions:`；初判 A／B-mini 而第二步正式判 B 時，第零步已寫的 capsule 在第四步把重呈確認的卡寫進 `decisions:` 的同一步刪掉（獨立 capsule 整條刪除；formalize 只刪 `card:` 子區塊、claim 保留），之後續接以 meeting-notes 為準。形狀（`claimed:` 行由 helper 插入，不手寫）：

```markdown
## <change-name>：已確認白話卡
  - clarify_stage: card-confirmed
  - decided:
    - 使用者故事：<誰／什麼狀態／什麼觸發> (provenance: user)
    - 現在：<…> (provenance: user)
    - 引擎：<…> (provenance: user)
    - 做成後你會看到：<…> (provenance: user)
    - 不該被整包丟掉的：<…> (provenance: user)
  - dev_verification: deploy-before-pr; entry: <路徑或段落> (provenance: user)
  - pr_branch: <branch 全名>
  - next: 實作與開 PR 時照讀；PR merge 後整條刪除
  - promote_ready: true
```

寫入序列（`claim` 輸出：本次新加 stdout `claimed item N: <change>`、本 change 原有 stdout `already claimed item N: <change>`，兩者 exit 0；條目已屬他 change 時 stderr `item N already claimed: <other>`、exit 1，走下方失敗路徑、不 release）：

1. append capsule。
2. `session-pending-claim.mjs list` 取 item 編號 N。
3. `node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>`。
4. claim 返回後讀回，兩項都要過：`list` 的 item N 是預期標題且 `claimed:<change-name>`；直接讀檔確認 item N 含 `clarify_stage: card-confirmed` 與五欄（`list` 不印內容）。
5. item N 不是預期標題（他 session 未經 helper 增刪條目使編號位移）→ 視同寫入失敗，只撤本次新加的 claim：stdout 以 `claimed item` 開頭才 `release --item <N> --change <change-name>`；以 `already claimed item` 開頭不撤（那是本 change 原有的 claim）。
6. 建好 worktree、第一個 repo write 之前，核對 `pr_branch:` 等於新 worktree 的 `git branch --show-current`，不同就改成實際值（這是 `pr_branch:` 唯一允許的改寫，此時還沒有 PR 行用到它）。

預期標題：獨立 capsule 是 capsule 標題；formalize（來源是已 claim 的 pending item）不新增 sibling `## `，卡寫在原 item 的 `card:` 子區塊（同樣的 `clarify_stage`／`decided`／`next`／`promote_ready`），預期標題是原待辦標題，第 2、3 步改為對原 item 再跑一次同一 `claim`——同 change 重複 claim 不寫檔但在 lock 內執行，返回時更早持舊快照的 helper 寫入都已落地，讀回才可靠；此時預期 stdout 以 `already claimed item` 開頭，以 `claimed item` 開頭即代表落錯條目。capsule MUST NOT 寫 batch／stepwise 選擇或任何授權字樣（授權只記在 `lite-scope.md` 或 proposal ledger；欄內容非提不可時改用不命中 Gate SP 的同義詞並在同輪說明；唯一例外是 `dev_verification:` 子項，以及同一份紀錄用的 `consumer_waiver:`、`pr_branch:` 子項：它們記的是使用者對本 change 的 DEV 決定、逐 PR 放行與本 PR 的 branch，不是 batch scope；值只用 `pre-pr-dev-verification.md` 的封閉字彙、放行原因或 branch 全名），不含 PII／secret；寫入時的 Gate N advisory（缺 `缺輸入:`／`trigger:`／`carrier:`）可忽略，capsule 不是 deferred 議題。formalize 原條目自身若有記錄授權的 `approval:` 子項，Gate SP 在第一點五步就已生效，與卡無關。任一步失敗 → 重讀檔案重試一次（lock 忙照 helper 訊息的具名下一步）；仍失敗 → 在下一個 repo write（含建 worktree）前停下，照 `stop-point-comms.md` 給選項：1. 重試（推薦：卡留在本機才能壓縮後續接） 2. 不留耐久紀錄繼續（壓縮或 clear 後可能要重問卡） 3. 其他；選 2 時在回覆記下這個選擇再繼續。MUST NOT 默默略過。

**`dev_verification:` 記錄（綁本 change）**：使用者答 DEV 題後寫一行 `dev_verification: <deploy-before-pr | n/a: <理由> | waived: <理由> | open-pr-pending: <缺什麼>>; entry: <入口> (provenance: user)`，值只用 `pre-pr-dev-verification.md` 的封閉字彙；「其他」的回答對不到四值就不寫（PR 前補問）。落點：lite 全分類與 full 初判 A／B-mini 寫進 card capsule 的 `dev_verification:` 子項（與 `clarify_stage` 同層，在 `decided:` 之後、`next:` 之前，與 capsule 同一次寫入）；初判 B 而第二步正式判 A／B-mini 或第零步不發問時，隨第三步前單獨送卡後的 capsule 寫入；full 初判 B 寫進第三步 `meeting-notes.md` 的 Startup evidence 一行 `- dev_verification: …`（第三步寫 meeting-notes 殼時；之前只在本輪對話中，遺失即 PR 前補問）。它與 capsule 同生同滅，capsule 到 PR merge 後才整條刪除，所以 pre-PR DEV gate 在壓縮、重啟或 clear 後照讀、不重問；第二步正式判或第四步重分類為 full B 時，在把卡寫進 `decisions:`、刪 capsule 的同一步，把 `dev_verification:` 原值搬到 meeting-notes Startup evidence。記錄只綁本 named change 與 branch 的 PR；scope change re-entry MUST 重問 DEV 題。`waived:` 是開 PR 時對照的作答時紀錄之一；之後的 DEV 作答覆寫這一行（見 `session-pending-lifecycle.md` §逐 PR 豁免紀錄）。

**條件式第二意見審查模型預選（batch scope 選擇取得後、第一個 git write 前追加一題）**：本題是 user-owned pause，套 `stop-point-comms.md` 硬規則 1–5；唯讀判定、依序短路，只讀 host 與 PATH，不寫任何 user-local 設定：

1. **host 判定**：active host 是否為 Claude Code 或 Codex？判定沿用既有 adapter host detection（Cursor=`isCursorRuntime()`、OpenCode=`.opencode` plugin identity、Codex=`.codex` runtime markers）。是 → **MUST NOT 問**（兩 host 有固定 primary，既有 deterministic chain 不變）。
2. **雙 CLI probe**：`command -v claude` 且 `command -v codex` 皆 exit 0 → 續問；任一失敗 → **MUST NOT 問**（dispatch 端既有偵測／fail-closed 不變）。
3. **呈現**：三要素（為什麼停＝開 change 前先鎖第二意見審查模型／要你做什麼＝回數字／回了會怎樣＝後續 design gate 與 post-PR 審查用該模型）＋編號選項 `1. codex 2. claude 3. 其他`（末項開放項）＋術語配白話（second reviewer（第二意見審查模型）、design gate（設計稿二審）、post-PR（PR 後審查）首現加註）＋走提案確認主路徑（禁作文題主路徑）（stop-point-comms.md 硬規則 1–5 全覆蓋）。**無 auto 預設**：不得標「推薦」、不得預填。
4. **落點**：選擇 → 寫入 meeting-notes startup 證據＋proposal / proposal-mini `## Batch Approval Ledger` 欄位 `second_reviewer_family: codex | claude`；條件未命中或選「3. 其他」→ 欄位缺省。
5. **改選**：口頭改選 → TL 更新 ledger 欄位＋meeting-notes 記改選；後續 dispatch 生效；已 dispatch 的 round 不受影響。

取得選擇前不得執行第一個 git write。若使用者已在同一請求明說 `batch approval`、`stepwise confirmation`、或給出更窄/更寬的具名 batch scope，**batch scope 選擇**視為已完成並將 scope、named change、branch、以及 future PR derivation 記入 proposal / proposal-mini evidence（lite 無 proposal，改依下方 Lite 段寫 `lite-scope.md`；decisions／handoff／meeting-notes 可逐字重述，不得為唯一載體）；**條件式第二意見預選（上方）是獨立的一題：符合條件時 MUST 仍問，除非使用者已在同一請求明示 second reviewer family（此時直接記入 ledger 欄位，不重問）**。
若使用者只授權 git/PR batch scope、或自訂 scope 排除 subagent，repo 層的 `RepoDelegationAutoAuthorization` 仍成立，但 Codex 這類 explicit-trigger runtime 在第一次 mandatory subagent dispatch 前 MUST 進 `SubagentAuthPending` 問一次取得 `StandingDelegationAuthorization`。generic git/PR batch approval alone MUST NOT be used as fallback excuse；不得把缺 runtime launch trigger 記成 subagent unavailable 或 TL fallback。

**Executor 決策與路由順序（outcome mandatory、executor 由決策序決定）**：第零步的 bounded subagent launch authorization 只是授權面，不是委派義務。第二步 chore 分類（A／B-mini／B）與 workflow relevance 路由先行；之後每次 dispatch 前依 `model-delegation.md` §Executor 決策序判定 `continue`／TL-direct／`fresh`／`fork`，並在 dispatch prompt 前綴 admission record 六欄（`objective`、`responsibility_id`、`instance_mode`、`evidence_scope`、`return_and_stop`、`role`＝subagent_type；hook 對缺欄的具名 `dp-*` dispatch fail closed）。決策序判為 TL-direct 時，TL 依 `platform-adapter-contract.md` §4a 同列產出等價 artifact（brd／proposal／receipt 同 schema、同 acceptance；receipt `executor_kind: tl-direct`）——這是正常路徑，不記 fallback，但不得作為獨立判斷證據。`fresh`／`fork` 與 review-lane dispatch 前 MUST 先讀 `--budget-check` 的 `budget_state`（half-state 規則見 `workflow-cost-controls.md` §Review Remediation Cost Stop-Loss）。本 skill 與第零步 MUST NOT 寫任何 user-local 設定；本 repo 不再建議或檢查 user-local 的 subagent 併發／巢狀值。

**Batch Approval Ledger（proposal / proposal-mini 必寫）**：第零步選 `batch approval` 時，`proposal.md` 或 `proposal-mini.md`（full／B-mini 的機械判定唯一 carrier，pre-write gate 與 archive check 只讀這兩者；lite 無 proposal，見下方 Lite 段）MUST 使用結構化 ledger 記錄 approval scope，不得只用自由文字；`decisions.md`／handoff／`meeting-notes.md` 可逐字重述同一 ledger 供人工參考，但 MUST NOT 作為唯一載體。第零步結論未落 ledger（結構化或 `N/A`）→ pre-write gate 會擋。ledger 至少包含：

```yaml
kind: same-change-dp-change-batch
named_change: <change-name>
branch: <branch-name>
repo_scope: same-repo
# second_reviewer_family: codex|claude（R2 條件式選擇題落點，選填）
covers:
  - worktree
  - local_commit
  - pre_pr_gate
  - first_push
  - pr_create_update
  - workflow_watch
  - post_pr_completion_gate
  - scenario_walkthrough
excludes:
  - merge
  - release
  - destructive
  - secrets
  - cross_repo_write
```

只在使用者第零步選 batch 之後寫；stepwise 或尚未回答寫 `N/A: no batch approval selected`。在 stepwise、尚未回答或自行推斷 batch 時寫出相符 ledger，屬偽造同意證據。閘只驗格式、change 與 branch；這項殘留屬 `design-core.md` §11 `batch-scope-record-residual`，補償控制是 ledger 隨 PR diff 可見。

**full 中途改 stepwise**：使用者中途撤回 batch 或改成 stepwise 時，TL MUST 在下一個原 covered write 前保留 `## Batch Approval Ledger` 標題，將整段 ledger 內容替換為 `N/A: no batch approval selected`；MUST NOT 留下舊的 `kind`／`covers` 或沿用原 matching ledger。後續 git／PR write 回到逐步確認。 若同一 change 的 claimed session-pending 條目仍記錄舊批次授權，TL MUST 同步移除過期授權記載並保留 claim；Gate SP 對仍記錄 batch 的條目維持拒絕 N/A，MUST NOT 為過閘重建已撤回的 ledger。Gate R1 與 archive gate (c) 仍接受 N/A 結論，不刪標題、不新增授權載體。 撤回 batch 不撤回獨立的 reviewer family 選擇；既有 meeting-notes MUST 保留該選擇與原使用者回答，後續 dispatch 沿用該選擇，不把它當批次授權。

**Approval scope narrowing prohibition**：本禁令只禁止 AI 自行縮限授權；使用者明示撤回或改 stepwise 時，優先依上方 full 撤除規則執行。若既有 ledger 是 `same-change-dp-change-batch`，後續 proposal / handoff / PR draft MUST NOT 改寫成 local-only 或寫出 `push/PR out of scope` 等與 ledger 矛盾的結論。re-entry 發現矛盾 artifact 時，TL MUST 先更正 evidence，並在 same named change / same branch / same repo 已覆蓋的 pre-PR、first push、PR create/update、workflow watch、post-PR gate、`scenario_walkthrough` 範圍內繼續，不得停下重問同一授權。只有 ledger kind、named change、branch、same-repo scope 完全相符，`covers` 明列 `scenario_walkthrough`、`excludes` 不含 `scenario_walkthrough`，且沒有 custom scope 或 coverage 矛盾時，AI 才可在 trigger 命中後自判 needed/not-needed；needed 直接執行，not-needed 記錄 non-empty change-specific risk reason。Scenario Walkthrough authority missing/malformed/ambiguous/mismatch/coverage absent/custom excluded、merge、release、tag push、destructive、secrets 或 cross-repo write 仍是獨立停點。

### Lite rigor level：跳過什麼、batch approval 怎麼取得

rigor level 為 lite（對話宣告即可）時仍走 `/devpro:change`，只是不寫 OpenSpec proposal，批次授權的載體改為 `openspec/changes/<change-name>/lite-scope.md` 一行紀錄（不進 git，與 full 的 `## Batch Approval Ledger` 對稱）。

- **跳過項**：以 `rules-rigor-level.md` 三級矩陣為準（OpenSpec artifacts、pre-flight、clarify／dp-analyst／dp-architect、delegation checkpoint、六軸、simplify、Recap），本節不另列副本。跳過 clarify／dp-analyst 不等於不確認需求：五欄白話卡照第零步出卡，卡確認前不建 worktree。
- **保留項**：4 條底線、測試綠燈、Verb Whitelist Precheck、post-PR completion gate、cross-model 第二意見（`cross-model-sticky-merge-review` 仍 fire；builder 用 `--lite`）。
- **第零步在 lite 不寫 proposal ledger**：沒有 proposal，所以不寫 `Batch Approval Ledger`；仍照上面問 batch／stepwise 選項，這一題不改。
- **選 batch 之後才寫 `lite-scope.md`**：lite 的 change 名稱與 branch 在第一步 Verb Whitelist Precheck 通過後才確定。使用者選 batch（或請求中已明說）之後，TL 依該次回答在第三步建立 worktree；worktree 內第一個寫入就是 `lite-scope.md`，內容恰為下列一行（固定欄位順序、`; ` 分隔、清單以 `,` 分隔且不含空白）：

```text
kind=same-change-dp-change-batch; named_change=<change-name>; branch=<branch>; repo_scope=same-repo; covers=worktree,local_commit,pre_pr_gate,first_push,pr_create_update,workflow_watch,post_pr_completion_gate,scenario_walkthrough; excludes=merge,release,destructive,secrets,cross_repo_write
```

- **`lite-scope.md` 只放那一行，計畫另放 `plan.md`**：`lite-scope.md` 的內容恰為上面那一行（Gate R1 對多行／空行判 `malformed`）；需求背景、改法、測試與驗證放同一 change 目錄的 `plan.md`（兩者都被 `.gitignore` 忽略、不進 git；交付說明寫在 PR body。lite 沒有歸檔步驟，入 git 的 `plan.md` 會讓資料夾一直留在 `openspec/changes`，被 `openspec validate --strict --all` 判成沒有 spec delta 的 change）。把 markdown 計畫寫進 `lite-scope.md` 會被擋，且搬檔時容易漏內容。
- **同一輪回覆貼出該行並點名使用者的回答**：寫入 `lite-scope.md` 的同一輪回覆 MUST 把該行原文貼給使用者，並點名它依據的是使用者哪一次回答（例：「依你在第零步選的 batch approval」）；沒貼出的寫入視為違規。
- **stepwise 不寫**：使用者選 stepwise 或尚未回答時 MUST NOT 寫此檔，每個 git／PR write 前逐步確認；在 stepwise、尚未回答或自行推斷 batch 時寫出相符紀錄，屬偽造同意證據（與偽造 proposal ledger 同級）；另，紀錄由 AI 代寫，閘只驗紀錄格式、change 與 branch，無法證明使用者選過 batch，這項結構殘留（不含上述偽造）屬 `design-core.md` §11 `batch-scope-record-residual`。
- **中途改 stepwise 就刪檔**：使用者中途改成 stepwise 時，TL MUST 立即刪除 `lite-scope.md`，後續 covered write 回到逐步確認。
- **中途改 full 就刪檔、改由 proposal 承載**：lite 中途升為 full（開始寫 proposal）時，TL MUST 刪除 `lite-scope.md`，並把 batch approval 寫進 proposal 的 `## Batch Approval Ledger`；同一 change 同時有 proposal 與 `lite-scope.md` 時 archive gate 回報 `lite-scope-with-proposal`（兩個載體並存、授權來源不唯一），修法即刪 `lite-scope.md`。
- **壓縮或重啟後**：照讀此檔、不重問。紀錄相符時其 `covers` 內的 git／PR write 不再詢問（`ai-autonomy.md` Matching Batch Approval Ledger）；merge、release、destructive、secrets、cross-repo write 仍是獨立停點。紀錄綁此 change＋branch，無有效期。本 change 的 card capsule 同樣照讀、不重問卡；續接不是 formalize，不跑第一點五 claim precheck 或 Formalize auto-promote。

**Scope Change Re-entry（既有 branch/change/PR；含 post-merge continuation）**

若同一 **named change** 收到 requirement scope change（新增、移除、或實質改變 target behavior、acceptance criteria、gate semantics、workflow state transitions、merge/release obligations）——**不論**原 PR 是否已 merge、使用者是否已說「在這個 PR 補齊／直接實作 Option B」、是否拒絕開新 change 名稱——TL MUST NOT 直接寫 implementation carrier。流程：

1. TL 先判斷是否為 requirement scope change；micro-tweak（1-2 個 acceptance condition 文字澄清或一個 auxiliary file，且不改 behavior/gate/workflow/merge semantics）可由 TL 直接更新 tasks/proposal evidence。
2. 若是 requirement scope change，更新 `decisions.md` trigger point `scope-change`，摘要寫明新增需求、原 scope 影響、same named change reason。
3. 重跑 `dp-analyst -> dp-architect`，用既有 active/archived artifacts + 新需求作輸入；B-mini 只影響初始 authoring path，MUST NOT bypass 後續 scope-change re-entry。
4. 確認 `openspec/changes/<same-named-change>/` **active**（已 archive 則 active-missing 還原）；更新 proposal / tasks / spec delta 後才繼續實作；已有 `comprehension.md` 時把第一行改回 `status: pending`，重做 Design Cold Read。
5. 原 PR **未 merge**：留在 same branch/change/PR；若先前已 archive → pre-merge re-archive（`openspec-archive-redo-undo.md`）。
6. 原 PR **已 merge**：開 follow-up branch/PR（同一 named change）；**禁止**在 `main` 無 active folder 時寫碼；**禁止**新建不同 change 名稱代替 spec 流程。follow-up branch 名受 `git-branch-naming-and-anchor.md` 不重用已用過分支名之規則約束；與「分支名＝change 名」慣例衝突時停下交 TL（此路由結果——開 follow-up branch/PR、沿用同一 named change——不變）。
7. 滿足 `openspec-scope-change.md` §OpenSpec-before-code hard gate 後才寫 script/rule/test；草稿程式須對齊 spec，不得以 dogfood 代替 artifacts。
8. 再回到 implementation / pre-PR / post-PR gate。

**第一步：Verb Whitelist Precheck（含 one-scope body）**

在執行第二步 Chore Classification 與第三步 worktree 建立**之前**，TL 必須先驗證提議的分支 verb 在白名單內，並同步檢查 branch `<name>` body 是否符合「一動詞一 scope」：

1. 從使用者需求 / 既有 issue 描述抽出提議的 branch verb（例：「禁止 X」→ verb=`ban`；「補強 Y」→ verb=`strengthen`）
2. `grep -E "^[[:space:]]*- \\\`<verb>\\\`" .devpro/agent-rules/preflight-checklist.md` 比對 marker 區塊（`<!-- branch-verb-whitelist:start --> ... <!-- branch-verb-whitelist:end -->`）
3. **未命中** → 停下要求重命名，建議白名單內最近義同義 verb（例：`ban` → `enforce`/`strengthen`）；**禁止**直接跑 `git checkout/worktree`
4. 檢查 `<name>` scope body 不含 `-and-` 或其他一動詞一 scope violation（如「順便」／空格或他字串連多動詞）；命中 → 停下要求拆 change 或改成單一概念 scope，**禁止**等 branch hook / `gh pr create` 才攔
5. **命中**且 scope body 合格，或屬豁免（`chore/bump-v*`、`release/v*`） → 進入第二步

> 此步補既有 hook Gate 11 / N2 之 process gap：hook 雖已覆蓋 `git checkout/switch/branch/worktree/gh pr create`（見 `.devpro/scripts/hooks/lib/branch-naming.mjs` 的 `BRANCH_COMMAND_PATTERNS` 與 `-and-` N2 block），但 TL 在連續寫 commit 後才被攔會造成晚期 rename/re-push 成本。Verb SSOT 仍為 `preflight-checklist.md` 點 2 marker 區塊；one-scope 判斷 SSOT 仍為 `preflight-checklist.md` 點 1，本前置步驟禁止複製白名單到本檔，避免 SSOT 漂移。

**第一點五：Session-pending Source Claim Precheck（條件式）**

若本次 `/devpro:change` 是把 `notes/session-pending.md` 的某條待辦 formalize 成 change，TL 在第二步 Chore Classification 與第三步 worktree 建立**之前**，必須先：

1. 執行 `node .devpro/scripts/session-pending-claim.mjs list`，讓使用者/紀錄能對應當前 1-based item index。
2. 執行 `node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>`。
3. claim 成功才可繼續；claim 失敗（已被其他 change claimed、item 不存在、pending file 不存在）→ 停下依 `session-pending-lifecycle.md` 判定 in-flight / stale / done，禁止直接 `git worktree add`。

此 helper 使用 `<main-checkout-root>/notes/session-pending.md` + lock/atomic rename；linked worktree 中也不得手寫 worktree-relative `notes/session-pending.md`。lock 失敗時錯誤訊息具名下一步（等待重試 claim；若被 Gate SP／batch ledger 擋住 → **先寫** `openspec/changes/<change-name>/` 再 claim）。

若 claimed 條目本身記錄 batch approval（只認 code fence 外的 `approval:` 子項，格式見 `session-pending-lifecycle.md` §批次授權紀錄），TL MUST 先檢查 active `proposal.md` / `proposal-mini.md` 是否已有 matching structured `Batch Approval Ledger`；`N/A: no batch approval selected`、missing 或 named change / branch / repo scope mismatch 在非 OpenSpec repo write 前皆 invalid evidence。lite 無 proposal 載體：此時相符的 `openspec/changes/<change-name>/lite-scope.md`（見上方 Lite 段）即滿足 Gate SP；lite 紀錄 missing、mismatch 或 malformed 才是 invalid evidence，TL MUST NOT 為了過 Gate SP 補寫 proposal。支援 PreToolUse 的 runtime 由 `pre-tool-gate.mjs` Gate SP 機械攔截；允許先寫 `openspec/changes/<change-name>/` 修正 ledger（claim 前亦可先寫該目錄）。

**第二步：Change Classification Routing**

依**變更形狀**分流（SSOT=`chore-classification.md`；分類維度≠分支前綴）：

- **chore / feature / bugfix / hotfix** → 讀 `.devpro/agent-rules/chore-classification.md` 判斷表，判定 A / B-mini / B 並書面記錄（commit message 或 proposal 開頭）；依判定走對應 Fast-Track / 簡化 / 完整路徑（路徑細節以 `chore-classification.md` 為 SSOT，本檔不重述）。分支前綴仍保留語意與 anchor 職責；**hotfix** anchor 來源仍依 `git-branch-naming-and-anchor.md` 從最近 `production-*` tag。**禁止**只因前綴是 feature/bugfix/hotfix 就跳過判斷表、直接走完整第五步＋第六步。

**chore 分類 producer（full/lite 共用）**：第二步判定具名 `chore/<name>` 的 A / B-mini / B 後，TL MUST 依 `chore-classification.md` §Session-owned 分類 metadata 執行 `node .devpro/scripts/record-session-change-classification.mjs --branch chore/<name> --classification <A|B-mini|B>`。只有可驗證 runtime metadata 才補 actual `--session-id`／相同 run-hook `--host`；缺 trusted ID／host 時接受 diagnostic-only `not-checked` 並繼續工作，MUST NOT 臆造或因記錄不可用卡住。成功只記本 session classification，always-running successful PostToolUse 才消費以支援 optional／later Recap；lite 仍無 automatic Recap reminder，不升 full／建立 full artifact。非法 option／classification／storage error 仍需修正；adoption 的 strict identity contract 不變。

> 第二步只做**分類路由判定**，**不**處理 anchor 計算（anchor 仍由本 skill 第三步處理，per `openspec-step-1-to-9.md`）。判錯只升不降與升級路徑見 `chore-classification.md` §判錯只升不降與升級路徑。

**OpenSpec Artifact Authoring Skill 為 Mandatory Load（所有 authoring 路徑共同前置）**：撰寫**任何** OpenSpec artifact 內容（`proposal.md` / `proposal-mini.md` / `tasks.md` / spec delta）之前，TL **必須載入** `openspec-artifact-authoring` skill——它承載寫入當下的 archive-gate 格式前饋 recipe（MODIFIED-delta body 與 canonical 同步、`## Removed Scenarios` bare-title 格式等），漏載入等於讓已知格式雷重演。此條款置於第二步之後，因為它對**全部**路徑生效：full path（feature/bugfix/chore B）在第六步 dp-architect 撰 proposal 時觸達；chore-A / B-mini path 在第二步分流後由 TL 自寫 proposal-mini 時觸達——兩條路徑都在此共同上游被要求載入。當撰寫 artifact 的工作委派給 `dp-architect` 或 `dp-programmer` 時，此 mandatory-load 條款 MUST 一併寫入該 subagent 的 `routing_context`（格式雷曾擴及委派鏈，subagent 沒有自動繼承主 agent 的 skill 載入狀態）。

**第三步：建 worktree + 環境檢查 + 寫 meeting-notes.md（startup gates first）**

在前兩步通過後、呼叫 dp-analyst / dp-architect 之前，TL **必須**先完成 startup gates，才可建 worktree、執行環境檢查，並寫入 meeting-notes.md。pre-flight docs（meeting-notes / brd / proposal）也是 repo write，受 protected-branch gate 約束——禁止在 main cwd 寫入。

執行序列（依 `git-branch-naming-and-anchor.md`「Worktree 規範」段 + `openspec-step-1-to-9.md` Step 3a）：

1. **保護分支 / cwd 校驗**：`pwd` + `git rev-parse --abbrev-ref HEAD`；若在 protected branch 上有未提交變更，先停下。
2. **working tree 乾淨**：`git status --porcelain`；若有非同步 diff，先依 `openspec-step-1-to-9.md` Step 1 問 stash / commit / discard / 帶 WIP。
3. **同步 refs**：`git fetch origin --tags`；不得 fetch into checked-out local `main` ref。若需更新本地 `main`，只在 clean `main` worktree 用 `git pull --ff-only`；divergence 停下釐清。
4. **production ancestry gate**：feature/bugfix/chore 先用 canonical anchor detection 取得合法 latest consumer production tag；存在時必須執行 `node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref <production-tag> --main-ref origin/main`。非 0 即停止普通 `/devpro:change`，禁止 fallback 到 `origin/main` 繼續；只可依 `git-branch-production-ancestry-repair.md`轉入 bounded `bugfix/fix-production-ancestry-<production-tag>`。只有 canonical detection 證實真正 no-tag first import 才記錄 `ancestry gate: N/A`，不得捏造或推論 production tag；其他缺 tag 狀態 fail closed。專用 repair 本身依該 leaf 執行，不把 ordinary startup 的非 0 當 bypass。
5. **分支依賴確認**：ancestry gate 通過後，feature/bugfix/chore 使用同一份 `node .devpro/scripts/detect-branch-base.mjs --anchor` JSON 的 `.sha` 作為預設 `<anchor-sha>`。若 JSON `mainAheadCommits` 非空，必須詢問是否依賴 content-level main-ahead commits，且併入第零步同一則訊息（第零步未發問時在建分支前單獨問）、附重疊證據與建議選項（SSOT `openspec-step-1-to-9.md` Step 2c；第零步已取得回答，且 fetch 後重跑 `--anchor` 的 anchor SHA 與 `mainAheadCommits` 未變才不重問；有變動就附新證據重問）；release lane 的 graph-only merge commit 不列入、不詢問。使用者確認依賴才可從 main HEAD 建，否則使用 JSON `.sha`。若使用者提及依賴尚未上 PROD 的 feature，從該 feature 分支建並在 proposal/decisions 記錄。
6. **決定 base**：feature/bugfix/chore 使用上一步決定的 `<anchor-sha>`；hotfix 使用最近 `production-*` tag（無 tag → 先排除異常能補就補、確不可能才降 `bugfix/` flow，見 `release-sit-uat-pat-prod.md`）。
7. `git worktree add <repo-root-abs>/.worktree/<change-name> -b <prefix>/<name> <anchor-sha>`
   - hotfix only：`git worktree add <repo-root-abs>/.worktree/<change-name> -b hotfix/<name> <production-tag>`
   - **提醒（只提醒，不擋；enforcement 見 `release-step-1-7.md` Step 1／`pre-pr/SKILL.md` Step 4）**：若這是在已有 merged PR 的分支上開始新修改，且本次目標梯次與該分支既有 PR 的 milestone 不同，提醒使用者改開新分支（同分支不支援部分上線，見 `git-branch-naming-and-anchor.md`）。
8. `git submodule update --init --recursive`
9. cwd 切入 worktree（**Bash cwd ≠ session cwd**；execution／artifact 佐證，非 admission 前提）：shell `cd`／工具 `working_directory`／`git -C` **不**自動等於 host session root。完成 worktree 後 MUST 留下 Bash evidence：`cd <repo-root-abs>/.worktree/<change-name>` 後立刻 `pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch`（此為 execution／artifact 佐證）。**session cwd 對齊不再是 admission gate 條件**：spawn admission 以宣告＋`git worktree list` exact-one `.worktree/<change_id>` 決定 binding，父 session MAY 留在 primary／main 派 `dp-*`；離開 worktree 的 session 派送前 MUST 以唯讀 helper 預解析、在 brief 填 `change_id`＋`execution_root`：`node .devpro/scripts/resolve-admission-binding.mjs <change-name> --cwd <session-cwd> --json`（唯讀、零 state、封閉碼；宣告路徑缺 `execution_root` → `execution-root-required`，realpath 不符 → `execution-root-mismatch`）。仍**建議**依 active host 將 session cwd 對齊 worktree 作為執行面優選（禁腦補 API）：Claude `EnterWorktree`（見 `platform-adapters/claude-code.md`）；Cursor（見 `platform-adapters/cursor.md` §5／§5b）——序列：嘗試／評估 `move_agent_to_root`（仍受未 push／checkout 風險約束；**成功＝優選、非唯一**）→ 失敗或停用切換 → **一等公民宣告路徑**（父 session MAY 留 primary；**binding root**＝宣告 id → exact-one `.worktree/<change_id>`；**execution root**＝該 worktree 絕對路徑＋`working_directory`／`git -C`；**binding root ≠ execution root**；**不得宣稱 Task 真在 worktree 執行**）→ 另開已根於 `.worktree/<change_id>` 的 session 僅 **最後手段／non-default**（MUST NOT 當預設解）；Codex 無 mid-session cwd API → 於 `.worktree/<change_id>` 新開／resume 為預設實務，但不再是 admission 前提（見 `platform-adapters/codex.md`「Session cwd」；opaque 載體之 `execution_root` 為 cooperative）；OpenCode session 開在 `.worktree/<change_id>` 為建議，或留原 session 以 helper 預解析宣告路徑派送——`session_move` **不再是 gate 條件**（見 `platform-adapters/opencode.md`）
10. **環境檢查/setup**：依 `.devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md` 在 worktree 內完成 core CLI readiness（含 `.nvmrc` 存在時 `nvm install` → `nvm use`）與下列唯一順序；**本步（子步 1–5）完成前禁止任何 repo write**，並 MUST 跑完本步：
    1. 單一 class ② 環境入口 `node .devpro/scripts/dp-change-environment-checks.mjs`（hooks path／runtime auto-compact／GitHub merge policy 等 structured results）
    2. **link／reparse 前置**：若 `node_modules`（或等價依賴目錄）為 symlink／junction／reparse → **MUST NOT** `npm ci`／等價刪裝、**MUST NOT** `rm -rf`；改 `blocked`／`not verified` 停點交回
    3. **專案依賴安裝**（環境就緒後）：`package-lock.json`／`npm-shrinkwrap.json` → `npm ci`；`yarn.lock` → `yarn install --frozen-lockfile`；`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`（**MUST NOT** 對 yarn／pnpm 跑 `npm ci`）；有 `*.sln`／`*.csproj` → `dotnet restore`；無棧 → `N/A`＋依據。**MUST NOT** junction／symlink／hardlink 共用主 checkout（或其他 worktree）依賴目錄
    4. Playwright local-package gate（掃 tracked 檔含子目錄；Node 先有真實 `node_modules` 再驗 `.bin/playwright`，.NET 驗 `playwright.ps1` 與 `pwsh`；見 env-setup）
    5. 回報 node/npm/openspec/gh/Playwright 及 class ② structured results 後才可進入下一步
    （core CLI readiness 與「第一個 implementation write 前」義務仍成立；本步完成前含 readiness 前窗口皆禁 repo write）
11. `mkdir -p openspec/changes/<change-name>/`
12. 寫入 `openspec/changes/<change-name>/meeting-notes.md`（B-mini / chore A 可免，仍建議留底）——此檔 MUST 為本 worktree 內**第一個** repo write（緊接 env checks 之後、其他 tracked 寫入之前；對齊 `openspec-branch-routing.md` §Step 0：未**收集**不得建分支，收集≠先寫 tracked notes）
13. **成本用量 checkpoint 登記**（design D7／round 6 finding F-6-2；無條件執行，B-mini / chore A **不可**跳過）：MUST 執行 `node .devpro/scripts/record-change-usage-checkpoint.mjs --change <change-name>`。此腳本以既有 `captureTlHostSession` 解析本次啟動的 `session_id`／`host`，同一步驟內同時呼叫 `appendChangeUsageSession`（寫入 per-change checkpoint 的 `sessions[]`）與 `recordSessionChangeTransition`（寫入跨 change 共用的 global session-activity transition ledger）——兩筆寫入缺一不可，後者是 task 3 `--since-change` 聚合判定「本 session 是否已離開本 change」上界的唯一依據。任一寫入回傳 `write_failed` 時，腳本輸出非阻斷的可見 advisory（`[record-change-usage-checkpoint] ADVISORY: ...`）並仍以 exit 0 結束——啟動序列不 block、不中止其餘步驟（round 4 finding F-4-3 的 fail-open 紀律：`notes/` 為 gitignored 本機狀態，擋下沒有救濟）。

**Formalize auto-promote（唯一 owner＝本 skill／`/devpro:change`；禁第二套）**：claim 成功且來源為 pending item 時，在本步寫完 `meeting-notes.md` 殼之後、**第四步之前**，TL MUST 將該 item 的 `decided`／`unresolved` capsule **idempotent merge** 進 Clarification State（設計 D7）：

1. 解析 capsule 的 `decided`／`unresolved`／`promote_ready`。
2. 缺 `provenance` 的 decided bullet → reject 該條並記 `UNRESOLVED: missing-provenance`；不得 silently drop／捏造 provenance。
3. Merge key＝normalize（正文去尾端 provenance）＋provenance；同 key → no-op（retry 安全）；同正文不同 provenance（含 incoming 互撞）→ `UNRESOLVED: promote-provenance-conflict` 並**整批 abort**（本呼叫不得 merge 任何 incoming decided；既有 Clarification State 不變）後停下。
4. 已決 → `decisions:`；仍開 → `frontier:`／`unresolved`；保留每條 provenance。
5. `promote_ready: false`／無 decided → 記 skip reason，不得捏造 decisions。
6. **MUST NOT** 把 promote 交給 `/devpro:clarify` 自跑；`pre-analyst` 僅可 fail-closed 回推「先完成 promote」。

可選實作：純函式於 `.devpro/scripts/lib/promote-pending-clarification.mjs`（非使用者 CLI gate）供單元測 idempotent retry。

完成後才能進入第四步。

**第四步～第六步（僅 full）**：rigor 為 full 時，MUST 先讀 `references/full-analysis-and-design.md` §第四步～第六步，依序執行第四步（Pre-analyst Clarification）、第五步（`dp-analyst`）、第六步（`dp-architect`，含 dispatch schema 與 Design.md Second-Review Gate）與 analyst／architect 不可用時的 fallback，再回本檔「接著根據參數決定 change 名稱」繼續；本檔其他段落提到這些步驟時，內容都在該檔。lite 不執行這些步驟，也不必讀該檔（跳過項見上方 Lite 段），直接往下。

接著根據參數決定 change 名稱：
- 若 name/request 參數已提供具體名稱（如 `add-export-retention`）：直接使用
- 若 name/request 參數是需求描述（如「匯出功能加上保留期限設定」）：AI 自行轉為 kebab-case 名稱（注意：若本次是 AI 主動 invoke 而非使用者直接輸入 `/devpro:change`，依 `git-branch-and-pr-flow.md`「AI 主動 invoke」規則，名稱與 command 皆須先提議並等使用者明確確認；例外是同一請求已自然語言要求開 change、具 concrete scope/name、且明說 `batch approval`，此時視同已確認 `/devpro:change <change-name>` command + parameter，批次 git 同意才生效）
- 若 name/request 參數為空：詢問使用者需求內容，再由 AI 命名

依 openspec-flow.md 的「OpenSpec + Branch checklist」逐步執行。**使用者 invoke `/devpro:change` 即視為對本 skill 內定義之標準 git 序列的一次性同意**（見 `.devpro/agent-rules/git-branch-and-pr-flow.md`「Slash command 批次同意」），AI 不需逐步再問；偏離標準序列才重新徵詢。

**步驟 1-3a 細節**：見 `.devpro/agent-rules/openspec-step-1-to-9.md` Process 段；`step 3a` 收尾 sync commit 細節見 `.devpro/agent-rules/rules-flow-routing.md`。

**Implementation-phase Ask First Carry-Forward**：實作／測試／archive 的本地 `git add`／`git commit` 前，TL MUST 對照 active matching ledger；`covers` 含 `local_commit` 且不在 `excludes` → **直接執行**，禁 `AskFirstPending: git` 重問（SSOT `ai-autonomy.md` Matching Batch Approval Ledger）。implementation-complete 後的續跑鏈見下方**第七步**。

**批次同意延伸**：沿本次所建分支，為完成同一 `openspec/changes/<name>/`（`proposal.md`、`tasks.md`、`qa-test-scope.md`、`make-vs-buy.md`（若有）、同單位 `chore: simplify <scope>`、測試／QA、merge 前必要之 archive 等）所必須之本地 `git add`／`git commit`，**以及 per `git-branch-naming-and-anchor.md`「Worktree 規範」段要求之 `git worktree add <repo-root-abs>/.worktree/<change-name> -b <prefix>/<name> <anchor-sha>` + `git submodule update --init --recursive`**，與上一段「Slash command 批次同意」同一範圍，不需逐步再問；若第零步選擇 `batch approval`，同一 named change 的首次 push、PR create/update、workflow watch、post-PR completion gate、matching structured ledger 所覆蓋的 `scenario_walkthrough` needed/not-needed decision 也包含在 batch scope 內（見 `git-branch-and-pr-flow.md`「明確自然語言 batch approval」）。Cross-repo write 不列入此延伸。
  若第零步已有 `Batch Approval Ledger`，本段延伸必須引用 ledger 判斷，不得用較窄自由文字覆寫。

**proposal 同步、Design Cold Read 與委派計畫（僅 full）**：rigor 為 full 時，MUST 先讀 `references/full-analysis-and-design.md` §proposal 同步～委派計畫，依序執行 Architect → proposal.md 同步驗證、Redirect Entry / Runtime Load Parity Checkpoint、建立 `tasks.md`、Design Cold Read 與 Step 5 前置委派計畫，再回本檔第七步；本檔其他段落提到這些段名時，內容都在該檔。lite 不執行這些段落，也不必讀該檔，直接到第七步。

**第七步：Matching Ledger Carry-Forward（implementation-complete → ship；禁 milestone idle-stop）**

Policy SSOT：`ai-autonomy.md` Matching Batch Approval Ledger、`ai-autonomy.md` Implementation-complete → covered pre-PR、`stop-point-comms.md` Matching Ledger 例外。本段只列 operational recipe；不得用 host user-rule「only commit when requested」覆寫 matching ledger（`ai-autonomy.md` §行為邊界）。

**Turn-end Ledger Self-Check（每個 final / handoff 回覆前；禁憑記憶）**

1. 讀 active `proposal.md` / `proposal-mini.md` 的 `## Batch Approval Ledger`（機械 carrier SSOT；lite 無 proposal 時讀 `openspec/changes/<change-name>/lite-scope.md` 一行紀錄；`decisions.md` 僅供參考）。
2. 判定 matching：`kind: same-change-dp-change-batch` + `named_change` + `branch` + `repo_scope: same-repo`。
3. 若 matching，且下一個 git/PR write ∈ `covers` 且 ∉ `excludes` → **owner=AI**，**MUST 續跑**，**MUST NOT** 製造「要不要 commit／push／開 PR／跑 pre-PR」編號選項。
4. `AskFirstPending` footer、測試全綠、sticky PASS、或「實作完成」摘要 **不得** 取代本 self-check 或把 owner 改回 user。

**Implementation-complete 續跑鏈（ledger matching 時 MUST 直接執行）**

tasks／實作／測試／archive gate 通過後 **不是終點**。TL MUST 依序續跑，直到下一個真正 user gate（通常在 `excludes`）：

| `covers` 項 | TL 動作 |
|---|---|
| `local_commit` | `git add` + `git commit` 本 change 必要變更 |
| `pre_pr_gate` | invoke `/devpro:pre-pr`（或等價 pre-PR recipe） |
| `first_push` | `git push -u origin HEAD`（或 ledger 覆蓋的等價首次 push） |
| `pr_create_update` | `gh pr create` / PR body update |
| `workflow_watch` | poll GitHub Actions 至終態 |
| `post_pr_completion_gate` | Ready Response + post-PR completion checklist |

**禁止 milestone idle-stop 選項**（matching ledger 時違規；含但不限於）：

- `1. commit+PR / 2. 只 commit`
- `1. 跑 pre-PR / 2. push / 3. 開 PR`
- 用 `1.是 2.否 3.其他` 包裝已覆蓋的 `local_commit`／`first_push`／`pr_create_update` 決策

**仍須停下的獨立 gate**（`excludes` 或無 matching ledger；實作前的 Design Cold Read 停點見上方，同樣不受 ledger 影響）：

- `merge` / squash / rebase merge（**預設**在 Step 0 ledger `excludes`；僅當使用者於 batch scope 明確 opt-in 且 ledger 把 `merge` 列在 `covers` 時，才可視為已授權 merge）
- `release` / promote / production tag
- `destructive`（未核准的 force-delete remote、force-push 等）
- `secrets`、未授權版號 bump
- `cross_repo_write`
- ledger missing / mismatch / `N/A: no batch approval selected` → 回到 stepwise Ask First

停下時 MUST 先報：ledger 狀態、已滿足的 `covers` 項、下一動作為何落在 `excludes` 或 ledger 缺口；再依 `stop-point-comms.md` 交棒。**禁止** 把已覆蓋的 commit/push/PR 包進交棒選項。

**禁止**：在建立 OpenSpec change 前寫任何實作程式碼。

## Test Scenarios

| 流程類別 | 觸發情境 | 預期結果 |
|---|---|---|
| Normal | 乾淨 working tree、使用者下「/devpro:change 加匯出保留期限」 | chore 分類 → pre-flight 通過 → proposal 設計 → 從 anchor 建 worktree + 分支 → 輸出委派計畫 |
| Existing-File | `openspec/changes/<name>/brd.md` 已存在但無 `proposal.md` | 跳過 BRD 撰寫、由 dp-architect 直接設計 proposal；既有 brd.md 不重寫 |
| Ledger-Carry-Forward | batch approval ledger matching；tasks 全勾、測試全綠 | TL 直接 commit → `/devpro:pre-pr` → push → PR → watch；**不**問「commit+PR / 只 commit」；merge 仍等使用者 |
| Error | working tree 有 uncommitted 改動（非 `.devpro-agent-rules` / `AGENTS.md`） | 停在 step 1、回報 `git status --porcelain` 並要求 stash/commit/discard 後再 invoke |

> 此矩陣為改本 skill 時的迴歸觀測點，協助快速辨識破壞 happy path 的修改。

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs
```
