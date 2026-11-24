---
name: consumer-doctor
description: "Consumer 端 adoption 健康檢查 recipe（matrix/profile/doctor/smoke，含失敗症狀 triage table）。使用時機：使用者要求檢查 consumer adoption 健康度、跑 devpro-doctor、查 consumer-lite/consumer-full/source-maintainer profile，或在 consumer repo 卡在 dirty tree、rules drift、PR dirty/conflicting、無 CI、gh auth、archive 或 cross-review 問題時。"
metadata:
  user-invocable: true
---

# Devpro Consumer Doctor

## Overview

本 skill 是 Devpro consumer repo 健康檢查的 routing 與 operational-recipe 載體：adoption matrix、profile views、`devpro-doctor.mjs`、consumer smoke，以及卡住時用的失敗症狀 triage table。**Policy SSOT 留在 rule leaves——本 skill 不重複它。** Hard Gate / Advisory / Doctrine matrix、profile 語意與 uninstall scope 定義於 `consumer-adoption.md`；失敗症狀 → 第一步檢查 → owner-route 對照表定義於 `consumer-failure-playbook.md`。本 skill 只排序該跑哪個指令、依什麼順序。

## When to Use

- Consumer repo 首次 adoption 或 sync 後健康檢查
- 使用者詢問 `consumer-lite` / `consumer-full` / `source-maintainer` profile scope
- 使用者詢問 Hard Gate / Advisory / Doctrine enforcement matrix
- Consumer adoption 或 rules sync 出現卡住、阻塞，或產生不明錯誤
- PR 呈 dirty、conflicting、checkless，或 cross-review 卡住
- `gh` auth、hook wiring 或 OpenSpec archive 狀態不明

## Process

### 1. 先載入 policy SSOT

載入並執行 `consumer-adoption.md`（matrix/profile/doctor/smoke 指令參考、profile 語意；uninstall 見 `consumer-uninstall.md`），若有失敗/症狀在場，再載入 `consumer-failure-playbook.md`（症狀 → 第一步檢查 → owner route → fail-closed 下一步動作的 triage table）。以下本 skill 的步驟是操作順序；enforcement buckets 與 triage routing 定義在那些檔案裡。

### 2. 健康檢查路徑（尚無已知失敗）

```bash
node .devpro/scripts/consumer-adoption-matrix.mjs --check
node .devpro/scripts/consumer-adoption-matrix.mjs --profile consumer-lite --summary
node .devpro/scripts/devpro-doctor.mjs
```

`--check` 驗證產出的 `.mjs` carrier 與 source-controlled basename 是否一致。`devpro-doctor.mjs` 是唯讀的——它回報 source discovery、profile counts、OpenSpec、`gh`、drift、hook wiring、readiness 與下一步動作。它 MUST NOT 執行 `--sync`、commit、push 或修改 hook config；若 drift 需要修復，route 到 `rules-flow.md`，不要要求 doctor 修。

### 3. Profile-scoped 指引

```bash
node .devpro/scripts/consumer-adoption-matrix.mjs --profile <consumer-lite|consumer-full|source-maintainer> --enforcement-map
node .devpro/scripts/consumer-adoption-matrix.mjs --profile <name> --agents-md
```

優先用精簡 profile；只在當前任務明確需要該領域時才按需載入 leaf rule。`consumer-full` / `source-maintainer` 需要有文件化理由——不要預設用最寬的 profile。

### 4. 症狀 triage 路徑（卡住時）

在 `consumer-failure-playbook.md` 的 triage table 中挑出對應那一列（dirty tree / rules pointer pollution / PR DIRTY-CONFLICTING / hook false positive / no CI / `gh` unavailable / archive missed / generated AGENTS drift / submodule sync drift / cross-model sticky stale）。執行該列的第一步檢查，再依其 owner route 走——不要修復、commit、push、merge 或超出該列與使用者授權範圍的 bypass。

```bash
node .devpro/scripts/devpro-doctor.mjs --consumer-smoke
node .devpro/scripts/test-consumer-smoke.mjs
```

Consumer smoke 是 rules-lane readiness check，與完整 source-governance test suite（`node .devpro/scripts/run-test-suite.mjs --tier all`）不同——不要拿完整 suite 當 consumer-smoke 替代品。

### 5. Uninstall（乾淨移除）

若使用者想從 consumer repo 移除 devpro-agent-rules，route 到 `consumer-uninstall.md`，取得三層 `sync-agent-rules.mjs --uninstall` recipe（`--dry-run` 預覽、plain confirm-gated 移除、`--git-flow` 用於 commit+push+PR）。本 skill 不重述不可逆警告或移除範圍——執行任何 uninstall flag 前先讀那一節。

## Common Pitfalls

- 把 doctor 輸出當成可自動修復的東西——doctor 是唯讀的；drift 修復走 `rules-flow.md`
- 拿完整 source-governance suite 當「consumer smoke」跑——兩者假設與範圍不同
- 挑寬 profile（`consumer-full`/`source-maintainer`）卻無文件化理由
- 跳過 triage table，自行 improvise 修復卡住的 PR/hook/archive 症狀，而不是照 owner route 走

## Verification

```bash
# source repo（維護本 skill 時）：
node .devpro/scripts/lint-agent-skills.mjs
# consumer repo：不要跑 lint-agent-skills——它只接受 discovery 目錄下的 `devpro` 單一入口，會拒絕 consumer 自建的 skill 入口；改跑 sync parity 檢查：
node .devpro/scripts/sync-agent-rules.mjs --check
# 兩者共用：
node .devpro/scripts/consumer-adoption-matrix.mjs --check
node .devpro/scripts/devpro-doctor.mjs --consumer-smoke
node .devpro/scripts/test-consumer-smoke.mjs
```
