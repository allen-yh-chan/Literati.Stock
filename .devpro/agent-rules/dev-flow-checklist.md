---
name: dev-flow-checklist
description: 一個完整開發單位（feature/bugfix/chore-B）的主線全程勾稽 checklist——討論→OpenSpec→實作→pre-PR→PR→post-PR 六階段，防跨 command/跨 session 漏步。pointer-only，每站骨架＋gate＋回指既有 SSOT，細則不在本檔。
---

# Dev Flow Checklist（主線全程勾稽）

## Overview

`/devpro:change` 管 OpenSpec 建立、`/devpro:pre-pr` 管 pre-PR 到 post-PR review、`session-recap.md` 管收尾，但 session-pending record/claim、CI 終態回報、pending 清理時機落在 command 之間的「縫」，跨 session 續作時無單一處對位而漏步。本 leaf 是**縫合導覽層**：pointer-only，每站只列骨架與 gate，細則以回指的 SSOT 為準。

## When to Use

- 開始一個完整開發單位（feature / bugfix / chore-B），要確認主線無遺漏時。
- 跨 session 接手 in-flight 單位，要定位「走到哪階段、下一站是什麼」時。
- 在 claim / 動碼前 / `/devpro:pre-pr` 前 / merge 後 / Recap 前想對位整體進度時。
- **不觸發**：chore A（走 `preflight-checklist.md`）；rigor lite/off 依 `rules-rigor-level.md` 縮免（測試仍須全綠）。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `N/A`（各階段自身 gate 由其 SSOT 的 carrier 承接，如 `pre-pr-archive-gate.mjs` / `pre-tool-gate.mjs`） |
| Advisory | SessionStart nudge（session-pending / CI 終態提醒）+ 本導覽 leaf + **動作點 nudge：`pre-tool-gate.mjs` `checkAdvisories()` 在 `gh pr create`（→ 階段 3/4）與 `git push`（→ 階段 3.6 archive / 階段 4）非阻擋提醒本 checklist 對位站** |
| Doctrine | `cooperative + advisory: 本檔為跨階段導覽，不新增獨立 hard gate；防漏主靠對位既有各站 gate，並由 pre-tool-gate.mjs 在 push / PR-create 動作點 advisory 推本 checklist 至 AI 眼前（防長流程中段「流程意識衰減」不主動讀本 leaf）；advisory-only，不 block` |

主線六階段（chore A 免；rigor lite/off 依 `rules-rigor-level.md` 縮免）：

### 階段 0 需求討論（進主流程前）
- [ ] 模糊先釐清 → `/devpro:clarify`（explore recipe）＋`ambiguity-scoring.md`；單位拆分/白名單 → `preflight-checklist.md`
- [ ] 帶「修」字 → 先過 Step 0 Frontier Check 並記錄 evidence；若結論是回原分支，仍進階段 1 的 existing-branch OpenSpec continuation → `openspec-branch-routing.md`
- [ ] 五欄白話卡已確認（需求驅動 change 第一個實作寫入前；lite 全分類與 full 初判 A／B-mini 在 `/devpro:change` 第零步、手動 chore A 在第一次 git 動作確認、full＋B 在階段 1 pre-analyst 訪談後；SSOT `ambiguity-scoring.md` §Operator usage probe）
- [ ] DEV 決定已記錄（consumer、`lite`／`full` 的需求驅動 change：第零步 DEV 題的答案寫成 `dev_verification:`；source 與 `off` 免）→ `pre-pr-dev-verification.md`
- [ ] 當下不做 → session-pending **record**（explore capsule／promotable decided）；要做 → 進階段 1 前先 **claim**（pending file 路徑/lock 語意見 `session-pending-lifecycle.md`，worktree 內用 main-checkout-root 不用 worktree-relative）

### 階段 1 OpenSpec 建立（`openspec-step-1-to-9.md` §1–4b；入口 `/devpro:change`）
- [ ] Step 1 working tree 乾淨 → 2 sync refs/anchor → 2d pending claim gate → 3 branch/worktree/env
- [ ] 回既有 `feature/*` / `bugfix/*` / chore-B 分支修：只跳過新建分支/anchor；先確認 active change folder 並延續 dp-analyst → dp-architect → proposal/tasks/QA
- [ ] Step 4 change 初始化：meeting-notes → **`/devpro:clarify` pre-analyst** → brd（dp-analyst）→ proposal（dp-architect）→ tasks → qa-test-scope
- [ ] **Gate：OpenSpec 先於碼**（chore A 免）

### 階段 2 實作（`openspec-step-1-to-9.md` §5–6）
- [ ] 若修法牽涉外部介接邊界（API / CLI / SDK / webhook / network service / auth / file or stream I/O / process spawn）或 host/auth/sandbox/hook/runner/spawn 等真實執行面，先做最小真路徑「基本功能探針」並取得 `VALIDATED`，再擴大 spec/tests/cross-carrier → `testing-and-qa.md`
- [ ] 有 `design.md` 的 change：第一個實作寫入前完成設計冷讀並交使用者確認；**Gate CR：`comprehension.md` 第一行放行才可寫**（`design-reasoning.md`）
- [ ] Step 5 委派實作（`model-delegation.md`）；TDD；**task 驗收才勾**
- [ ] Step 6 專案測試全綠 + qa-test-scope 更新；**Gate：全綠才 PR**

### 階段 3 pre-PR（`/devpro:pre-pr` Step 1–4）
- [ ] 前置 6 檢 → 1 Testing/QA → 2 簡化 → 2.5 Scenario Walkthrough → 3 六軸審查（dp-reviewer）
- [ ] 3.6 spec-freeze **archive** + gate → 3.7 `openspec validate --strict --specs`（source／identity unknown；consumer 正面身分改跑 `openspec-validate-delta.mjs`）；**Gate：archive 在首次 push/PR 前**
- [ ] Consumer Pre-PR Checks Gate（Step 4 之前完成；`lite`／`full` 都跑，source 跳過，`lite` 在最後一關、`full` 可與六軸併行）：HEAD 含 `.devpro/pre-pr-checks.local.md` 時讀該檔並照內容做，全部做完（或逐 PR 使用者放行）才進 4；契約見 `consumer-pre-pr-checks.md` §Consumer Pre-PR Checks
- [ ] Pre-PR DEV Verification Gate（Consumer gate 之後、4 之前；consumer 每個 PR，與 local checks 檔是否存在無關）：照第零步 `dev_verification:` 記錄執行、不重問，沒有記錄或與 diff 不符才補問；失敗依原因分流，`pending:` 不報 ready → `pre-pr-dev-verification.md`
- [ ] 4 PR 描述（Requirement Ledger / Test Evidence / Scenario / Security 含 SQLi·PII）

### 階段 4 PR
- [ ] 一次 push → 建 PR → CI watch **至終態並回報** → `git-workflow-tracking.md`
- [ ] review threads / evidence → `code-review-checklist.md`

### 階段 5 post-PR
- [ ] `/devpro:pre-pr` Step 5 workflow watch ∥ Step 5.5 exemption check（並行；SSOT `post-pr-completion-gate.md` §Step 5 ∥ Step 5.5 Parallelism；handoff 4 項：等什麼/誰擁有/下一步/平行可做）→ `git-workflow-tracking.md`
- [ ] Step 5.5 exemption check：豁免 PR（含 `chore/bump-v<X.Y.Z>`）記錄 exemption evidence 並接續 merge/release path；非豁免 PR 先做 final base/mergeability sync，再跑 cross-model review；dispatch-bound sticky 後的 rebase/force-push/non-fast-forward head movement 需 Ask First；exact per-lineage approval 僅可授權符合 recovery contract 的 active marker／clear-obligation transition，不授權 Git rewrite 且仍需 fresh current-head sticky；`last_reviewed_sha != headRefOid` 除 Path D′ fresh-equivalent（whitelist-only bookkeeping diff，SSOT `code-review-cross-model.md`）外一律 stale block；非 ancestor 未符合 approval recovery 即 lineage-broken stale evidence fail closed；ancestor/recovery lineage 仍不能替代 current-head sticky → sticky verdict 過 merge gate → `code-review-cross-model.md`
- [ ] `post-pr-completion-gate.md` 逐項核；以本 session 擁有／明確接手的 PR 為 scope，依診斷指向該 change worktree；其他 session 不注入提醒，exit 0 不代表已驗其工作 → §Execution Location
- [ ] **gate 全過後**才 regular merge（禁破壞性 merge）
- [ ] regular merge / post-merge cleanup 屬 gate-passed AI-actionable 收尾；需確認時問「是否授權 AI 執行」，不要外包成使用者手動動作
- [ ] merge 後：post-merge workflow watch → local sync/status → pending **整條刪除**（不留 ✅）；branch/worktree cleanup deferred until production → `git-workflow-tracking.md` + `git-branch-hygiene.md`
- [ ] Session Recap 收尾 Gate → Discussion → `session-recap.md`

## Exit Criteria

- 每一階段都已對位其 SSOT 並確認該階段 gate 通過或有記錄的豁免（chore A / rigor 縮免）。
- 階段 0 的 record 或 claim 已落地（main-checkout-root 的 pending file，路徑語意見 `session-pending-lifecycle.md`），非空手進階段 1。
- 階段 3.6 archive 在首次 push/PR **之前**同分支完成（非先 PR 後補）。
- 階段 5 的 pending 已依 merge 狀態整條刪除、CI 終態已回報、Recap 收尾 gate 已逐項答。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「跑了 `/devpro:change`＋`/devpro:pre-pr` 就等於走完主線」 | command 各管一段；record/claim、CI 終態、pending 清理落在 command 之間的縫，正是本 checklist 存在的理由。 |
| 「小改動不用對位整條」 | 規模判定屬 `chore-classification.md`；chore A 才免，B/feature/bugfix 全走。 |
| 「勾選框逐項勾完就好」 | 勾選框是對位入口非驗收憑證；每站驗收在回指的 SSOT。 |

## Verification

```bash
# 本 leaf 結構/token 合規
node --test .devpro/scripts/tests/rule-anatomy.test.mjs .devpro/scripts/tests/rule-token-budget.test.mjs

# AGENTS.md 索引 row（強制引用本 leaf）+ byte 上限 + README 表 row
node --test .devpro/scripts/tests/agents-md-index-mapping.test.mjs \
  .devpro/scripts/tests/agents-md-size.test.mjs \
  .devpro/scripts/tests/readme-module-table-coverage.test.mjs
```
