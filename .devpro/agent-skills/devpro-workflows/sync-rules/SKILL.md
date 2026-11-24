---
name: sync-rules
description: "規範同步 workflow：開啟 rules/<source>-v<X.Y.Z> 分支、執行 rules-to-main phase，並依規則接續 consumer production continuation。使用時機：使用者 invoke /devpro:sync-rules、要求開啟規範同步分支，或要求補救既有規範同步分支。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:sync-rules"
---

# Devpro Sync Rules

## Overview

本 skill 是 Devpro 規範同步流程的 routing 與操作步驟載體。用於開啟（或補救）`rules/<source>-v<X.Y.Z>` 分支，並針對上游 source repo 的 release tag 執行 rules-to-main phase；若 consumer repo 有 production lane，PR 不是完成點，後續 production continuation 仍由 `rules-flow-production-continuation.md`（經 `rules-flow.md` 路由）/ `release-rules-lane.md` 定義。

**Policy SSOT 留在規則 leaf——本 skill 不重複其內容。** pre-flight 條件、anchor 計算、conflict 處理定義於 `rules-flow-routing.md` 與 `rules-flow.md`，rollback 細節定義於 `rules-flow-rollback.md`（經 `rules-flow.md` § Rollback SOP 路由）；本 skill 只告訴你*何時*呼叫、*如何*排序「讀取後執行」的步驟。務必讀取並執行這些規則以取得權威流程，而非依賴本 skill 的摘要。

## When to Use

使用者執行 `/devpro:sync-rules` 開規範同步分支或補救既有分支。

## Process

### 0. Batch Scope Confirmation

開場先確認或記錄 batch scope。若使用者尚未明確授權，第一個 user-facing confirmation MUST 提供推薦選項：同一 consumer repo + source version 的完整 `/devpro:sync-rules` rules lane batch approval，涵蓋 rules-to-main phase、PR gate/merge、production continuation 的 release/rules branch push、production PR create/merge、production tag-only push、promotion 後 ancestry repair branch/PR/merge 與 fresh refetch/exact-tag gate，以及同一 rules lane 內達 mandatory delegation threshold 的 bounded subagent launch authorization（作為 `StandingDelegationAuthorization`）。若使用者已在同一請求明確說要 release rules to production 或給出 batch approval，視為此 gate 已完成，但 MUST 在 handoff / PR body / release report 記錄 scope。

**Batch Scope Ledger（必填）**：scope 記錄 MUST 使用固定欄位，逐項標 `yes` / `no` / `ask-later`，不得只寫「已 batch approval」：
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

推薦完整 rules lane batch approval MUST 涵蓋全部欄位。只有明確標 `yes` 的 action 才是已授權；missing field、`no` 或 `ask-later` 不得推定授權，任何未授權的 remote write 或 merge MUST Ask First。未明確涵蓋 production PR 或 production tag action 的 batch scope 不得被放大；到對應 create/merge/tag-only push gate 時再依 `rules-flow.md` / `release-rules-lane.md` 詢問。

若使用者選擇或自訂的 scope 排除 subagent launch，Codex 等 explicit-trigger runtime 仍須在第一次 mandatory subagent dispatch 前進 `SubagentAuthPending` 一次；不得把窄 scope 放大成完整 approval，也不得把 missing launch authorization 當成 TL-only fallback 的理由。

### 1. 本 command 是薄 wrapper；不另定一套流程

AGENTS.md 由 CLAUDE.md project instruction always-load 注入，無需重讀。

先讀小檔 `.devpro/agent-rules/rules-flow-routing.md` 的 Dedicated Rules Branch pre-flight / CLI fragment；只在需要 Dedicated Branch 5 步、conflict、rollback 細節時讀 `.devpro/agent-rules/rules-flow.md` 對應段落（rollback 由該檔 § Rollback SOP 路由到 `rules-flow-rollback.md`），避免因 DRY 強迫載入整份大檔。

### 2. 執行 pre-flight 檢查

依 `rules-flow-routing.md` § Dedicated Rules Branch pre-flight 執行：

- open rules PR block（開始前先確認該 source/version 是否已有 rules sync PR 開啟）
- main ahead warn-only（僅供參考，不阻擋）

若 legal latest production tag 尚未在 candidate main ancestry 內，依 `rules-flow.md` fail closed 並先委派 `release-rules-lane.md` 的 reconciliation classification；分類完成前不得宣告或建立 bounded repair。此 startup reconciliation 只屬 preflight/recovery，不取代 promotion 後 continuation。

### 3. 執行 rules-to-main phase（Dedicated Rules Branch 5 步）

依 `rules-flow.md` § Dedicated Rules Branch 依序執行 5 步。這是 rules-to-main phase，不是整條 consumer rules lane 的完成點：

1. `git fetch` source repo
2. anchor 計算
3. 由 source `production-v<X.Y.Z>` tag 開 `rules/<source>-v<X.Y.Z>` 分支
4. sync 規則檔
5. commit + push + PR

### Primary Checkout Close-out

rules PR merge 或適用的 production-continuation reconciliation 已 fast-forward primary checkout `main` 後，依 `rules-flow.md` 的 completion invariant 立即執行 `git submodule update --init .devpro-agent-rules`，再檢查 `git submodule status .devpro-agent-rules`，且必須在判斷 `production` branch 或合法 production tag anchor 是否存在之前完成。leading `+`、`-` 或 `U` 都是具名 blocker；MUST NOT declare `/devpro:sync-rules`, sync, or release complete，直到 status 只剩 leading space 的 aligned state。MUST NOT use `--remote` 或 stage the stale SHA back to `main`，也不得以 commit、stash、discard、restore 或 force 隱藏 non-space status；release、recovery 與其他 dirty state 仍由 canonical leaves 處理，本 skill 不複寫。

### 4. PR 後 continuation，不在 PR 停止

PR URL 或 PR merge 只能作為 phase evidence，不能宣告 `/devpro:sync-rules` 完成。PR 尚未 merge 時，依 `rules-flow.md` § PR-open gate-dependent handoff 追蹤或交棒 exact next action；不得停在 PR URL 而不給使用者下一步選項。workflow/checks pending → 依 `git-workflow-tracking.md` 追到終態或停 CI blocker 與 track/hold/other 選項；cross-model required → dispatch `/devpro:cross-review <PR#>` / host-equivalent second-review，缺授權才停下問，並提供 cross-review/hold/other 選項；(cross-model exempt 或 fresh PASS/WARN sticky) 且 Batch Scope Ledger 允許 `merge rules PR=yes` → merge 並跑 post-merge sync/checks；merge ready 但未授權 → stop-point handoff `1. merge <PR#>` / `2. hold` / `3. other`。

rules PR merge 到 `main` 後，僅在 Primary Checkout Close-out 成功後先讀 `rules-flow.md` § PR merge 後 production continuation 路由段；rules PR 已記錄 adoption，有效 pre-first-release 先依該路由記錄 production continuation N/A，在 main 與 primary submodule 對齊後完成同步；首個業務 release 由使用者另行決定。已有合法 production tag 且 consumer 存在 `origin/production` 時再讀 `rules-flow-production-continuation.md`，並依 `release-rules-lane.md` 執行 consumer production lane：push work/release branch → PR base `production` → GitHub merge → resolve exact merged production commit → freshly fetch `origin/production` 驗證 → tag the explicit commit → push only the tag ref。promotion exact tag 固定後，仍委派 `release-rules-lane.md` 的 classifier/repair mechanics：gate 已通過即 no-op；gate 非 0 只是 reconciliation classification trigger，必須先分類，才能依分類走 release-lane back-merge 或 bounded repair branch/PR/merge；merge 後 fresh re-fetch candidate `origin/main`，再以同一 exact promoted tag 執行 main-ancestor gate。任何 action 失敗或未授權，都 MUST 停下回報具名 blocker，且不得宣告 `/devpro:sync-rules`、sync 或 release complete。若已有合法 production tag 而 `origin/production` 不存在，回報 `production target absent`，不得從 `main` 合成或 direct-push production branch；由 external repository administration 建立 protected, pull-request-capable base。本 skill 只負責順序與 canonical leaf routing，不複寫 classifier 或 merge commands。

### 5. 完成後重新讀取 AGENTS.md

整條 rules lane 完成，或因具名 blocker 停下交棒後，**重新讀取 AGENTS.md**，確保後續工作遵守最新規範——session 開始時載入的版本可能已經過時。

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs
```
