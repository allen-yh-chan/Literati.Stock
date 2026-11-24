---
name: pre-pr-dev-verification
description: consumer 開 PR 前 DEV 驗證的判定、部署入口查找、四種狀態與 `DEV deploy-verify:` 證據行的 SSOT，與 `.devpro/pre-pr-checks.local.md` 是否存在無關；觸發：`/devpro:change` 第零步問 DEV、`/devpro:pre-pr` 走到 `Pre-PR DEV Verification Gate`、寫或審查 `DEV deploy-verify` 證據行、post-PR 收尾遇 `pending:`。
---

# Pre-PR DEV Verification

## Overview

consumer repo 開 PR 前，依變更影響完成適用的建置、自動測試、功能驗證與 DEV 判定，與 `.devpro/pre-pr-checks.local.md` 是否存在無關；該檔只是專案補充（加檢查、以 `## DEV deploy-verify` 段提供 DEV 指令與環境），不是任何一項的開關。

## When to Use

- `/devpro:change` 第零步問 DEV 題；`/devpro:pre-pr` 走到 `### Pre-PR DEV Verification Gate`。
- 寫或審查 PR `## Test Evidence` 的 `DEV deploy-verify:` 行；post-PR 收尾遇 `pending:`。

## Process

### 適用範圍

consumer 與判斷不出來的 repo（unknown 依 consumer）、rigor `lite`／`full`；source repo 不適用（不問、不寫 DEV 行）；`off` 由工程師自負。release lane 的四種 PR（`release/*` 進 `production`、Step 6A 合回 `main`、hotfix carrier 進 `production`、hotfix carrier 合回 `main`）不重新判定也不部署，DEV 行狀態寫 `N/A: release lane（DEV 判定在原 change／hotfix PR）`；`hotfix/*` 進 carrier 的 PR 照常判定。consumer rules lane 同步 PR（head 為 `rules/<白名單 source>-v<X.Y.Z>`，即跨模型審查分支豁免接受的形狀）沒有可部署變更：不判定、不寫 DEV 行，PR 建立 gate（`gh pr create`、MCP `create_pr`）視為 N/A；其他 head、形狀或 source 不符、白名單讀不到時照常要求。

### 判定

改到 runtime、startup、config、DB migration、外部介接或環境相依設定 → 需要 DEV 驗證；純文件、rules、test-only → `N/A: <理由>`；判斷不出來 → 當作需要。與 `.devpro/pre-pr-checks.local.md` 是否存在無關。

### 部署入口查找

第零步在 main checkout 唯讀執行，pre-PR 在 PR worktree 依 HEAD 重跑。依序找，第一個能部署當前 PR head build 的來源即為入口，找到即停：

1. HEAD 的 `.devpro/pre-pr-checks.local.md` 的 `## DEV deploy-verify` 段（只讀 HEAD 版本，讀法見 `consumer-pre-pr-checks.md` §讀法）。
2. 專案驗證入口（`project-verification.md`：runbook、`docs/verification/README.md`）中把 branch build 部署到 DEV 的段落。
3. 部署 workflow 或腳本：能以 ref／SHA 輸入部署指定 build 者算入口。
4. 環境設定位置（例如 `appsettings.Development.json`、`.env.dev`）：只定位，MUST NOT 讀取或印出內容。

每個來源（含第 1 步的 local 段）同一判準：只證明 DEV 環境存在的來源，包括只在 `integration` push 觸發、只部署 `integration` HEAD 的 workflow（例如 `deploy-integration.yml`）、只指向它的 local 段、環境設定位置，一律記為 `env-only: <路徑>` 線索並繼續找；MUST NOT 把 PR 分支推到 `integration`。結果記為入口路徑或段落、第一個 `env-only: <路徑>` 線索，或 `searched: <清單>; none`。只有 `env-only` 或 none 時，第零步推薦先開 PR 記 `pending:`，並列出「先在 `.devpro/pre-pr-checks.local.md` 補 `## DEV deploy-verify`（PR 分支部署指令）」選項；PR 前照 §PR 前執行 分流：記錄符合第 2 步時 `open-pr-pending:`／`waived:`／`n/a:` 直接寫對應狀態，`deploy-before-pr` 部署不了屬第 4 步環境類；其餘照第 3 步補問。

### 第零步記錄

`/devpro:change` 第零步擁有題目與載體；使用者答完後寫一行：

```text
dev_verification: <deploy-before-pr | n/a: <理由> | waived: <理由> | open-pr-pending: <缺什麼>>; entry: <入口形狀> (provenance: user)
```

值對應證據狀態：`deploy-before-pr` → 結果摘要；`n/a:` → `N/A:`；`waived:` → `skipped per user decision:`；`open-pr-pending:` → `pending:`。「其他」回答對不到四值就不寫記錄（PR 前補問）。只綁本 named change 與 branch，scope change re-entry 重問；壓縮、重啟或 clear 後照讀、不重問。`waived:` 是開 PR 時對照的作答時紀錄之一；之後任何一次 DEV 作答都覆寫這一行（見 `session-pending-lifecycle.md` §逐 PR 豁免紀錄）。這一行不得出現「授權」字樣。

### PR 前執行

其他可執行的驗證（測試、UI smoke、Consumer Pre-PR Checks Gate）做完後才做本關。Consumer gate 不跑也不等 local.md 的 `## DEV deploy-verify` 段、從不部署，所以 `pending:` 不擋它，該檔其他要求失敗或做不完時它照舊停下、不開 PR。本關每個停點的訊息依 `stop-point-comms.md`：為何停、編號選項（末項開放）、每個選項回了會怎樣。

1. 讀記錄，先讀條目再讀 meeting-notes：本 change claimed 條目的 `dev_verification:` 是最新作答，沒有才讀第零步 Startup evidence；對照實際 diff 重做判定與入口查找。
2. 記錄存在、與 diff 判定一致、入口仍相同：`deploy-before-pr` → 部署當前 PR head build 並驗證，不再問；其他三值直接寫對應狀態，`waived:` 只記在 meeting-notes 時先複製進條目（沒有就新建）並讀回，才寫豁免行。
3. 沒有記錄、記錄與 diff 判定不符、入口與記錄不同：只有這三種才補問，選項同第零步。
4. 失敗依原因分流，不依發現時點。環境類（缺環境、設定或同意範圍外的動作，DEV 主機不可達，部署管道本身壞掉）→ 停下，選項：補好後重試／本 PR 豁免（`skipped per user decision: <原因>`）／先開 PR 記 `pending: <缺什麼>`／其他。補好後可在原同意範圍內對同一 HEAD 重新部署並更新證據行。
5. 產品類（本 PR 程式讓 build 起不來或部署無法完成，或部署成功但核心路徑失敗、bug fix 的問題仍在）→ 停下回報部署了什麼與結果，不開 PR；MUST NOT 自行記成 `N/A:`、`pending:` 或 `skipped per user decision:`，MUST NOT 重跑沒有改動的步驟求綠；只能修正後重跑，或由使用者逐 PR 豁免（觀察到的失敗原文留在豁免說明旁）；選項：修正後重跑／本 PR 豁免（`skipped per user decision: <原因>`）／其他。環境與產品原因分不出來，比照本項。

使用者回答補問或停點後，先依 `session-pending-lifecycle.md` §逐 PR 豁免紀錄 寫紀錄並讀回（沒有 claimed 條目就新建，不論是否豁免），才寫 PR 行；寫不進去就停下，MUST NOT 寫豁免行。

local.md 的 `## DEV deploy-verify` 段只由本關執行與部署；同一輪本關對同一 HEAD 不部署兩次。

### 證據行與四種狀態

`## Test Evidence` 的 fenced code 外 MUST 恰有一行 `DEV deploy-verify: HEAD <full-sha>; <狀態>`（SHA 為完整 40 或 64 hex）。狀態是結果摘要、`N/A: <理由>`、`pending: <缺什麼>` 或 `skipped per user decision: <原因>`，原因非空且不含未填範本字樣。`skipped per user decision:` 是使用者對本 PR 的豁免，不延續到下一個 PR，且需要作答時紀錄（見 §強度）。`pending:` 表示需要但未完成的 DEV 驗證：不得標 PASS 或 ready，post-PR 收尾只能回 Blocked（見 `post-pr-completion-gate.md`），此保留屬 `cooperative-only`。結果綁 HEAD，見 `consumer-pre-pr-checks.md` §結果綁 HEAD；PR 開出後把 `pending:` 更新為結果走 `gh pr edit`。

### 三種證據分開

自動測試（Test Evidence 的指令與結果）、隔離 UI smoke（`qa-test-scope.md` 的 `ui smoke:`，限本機或臨時 instance）與 `DEV deploy-verify:` 行，各自只記實際跑過的，彼此不能代填；在 DEV 上做的檢查只記 DEV 行；`## Manual Test` 是給人的操作說明，不算任何一種證據。

### 授權與共用環境

- DEV 部署只在使用者對本 change 的 PR 明確選擇時發生；batch approval 與 `/devpro:pre-pr` 的一次同意都不涵蓋；選擇只限記錄的入口與 DEV 環境，MUST NOT 延伸到其他環境、SIT／UAT／PAT／PROD 或其他 change。
- 用當前 PR head SHA 建置部署，跑核心 happy path；bug fix 另驗修正點已消失。佈署鐵律（`release-sit-uat-pat-prod.md`）不變：SIT／UAT／PAT／PROD 仍只驗 `release/*` 的同一 Build once artifact；DEV 結果 MUST NOT 當 SIT／UAT 證據。
- 共用環境部署前先確認沒有別人的窗口（依入口宣告的協調方式）；拿不到或無法確認 → 停下，不自行覆蓋；證據記窗口起訖與曾部署的 branch／SHA。
- 部署前必要的 push／發佈不在記錄範圍時，依 `ai-autonomy.md` §Ask First 先問。

### 強度

Gate 4c 與 MCP `create_pr` 驗 DEV 行的文字格式（`off` 與正面 source 不查），並把每一段 `skipped per user decision:` 拿去對照本 change 的作答時紀錄（`session-pending-lifecycle.md` §逐 PR 豁免紀錄）：紀錄缺少、讀不到、定位不唯一或不相符就擋；見 `per-pr-waiver-record-residual`（`design-core.md` §11）。開 PR 時、`gh pr edit` 改描述時與 `gh pr merge`／MCP merge 前都對照（改描述與 merge 時不查行格式）；`gh api` 或網頁改描述不對照；MCP `update_issue` 改不了 PR，不對照。使用者是否真的作答、紀錄是否寫於作答之後，與 DEV 是否真的部署、證據 HEAD currency、第零步判定與 diff 是否相符、Ready 遇 `pending:` 是否真的擋下，皆為 `cooperative-only`。MCP 對既有 `Consumer pre-PR checks:` 行在 `off` 仍檢查是既有行為，本流程不動；`off` 不對照。marker 授權而未宣告 checkout、target 也不是自己 origin slug 的 create 為 remote-only，Gate 4c 不查 DEV 行（`consumer-pre-pr-checks.md` 強度）。

## Exit Criteria

- consumer PR 的 `## Test Evidence` 恰有一行合法 `DEV deploy-verify:` 行；`N/A` 附理由
- `pending:` 的 PR 收尾只回 Blocked，不報 PASS 或 ready

## Common Rationalizations

| Rationalization | Response |
|---|---|
| 「沒有 `.devpro/pre-pr-checks.local.md` 所以不用 DEV」 | DEV 判定與該檔是否存在無關；需要就查入口、問使用者，不需要才記 `N/A: <理由>` |
| 「本機 UI smoke 過了等於 DEV 驗過」 | 三種證據各記各的；`ui smoke:` 限本機或臨時 instance，DEV 只記 DEV 行 |
| 「batch approval 已同意，DEV 部署也算」 | batch approval 與 `/devpro:pre-pr` 一次同意都不涵蓋 DEV 部署；要使用者對本 PR 的明確選擇 |
| 「缺環境就寫 N/A」 | 缺環境、設定或同意是環境類原因：停下給四選項，不得自記 `N/A:`；`N/A:` 只給不需要 DEV 的變更 |

## Verification

```bash
node --test .devpro/scripts/tests/pre-pr-dev-verify-grep.test.mjs .devpro/scripts/tests/consumer-dev-verify-evidence.test.mjs
```
