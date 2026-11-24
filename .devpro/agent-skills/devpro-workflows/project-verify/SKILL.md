---
name: project-verify
description: "建立、執行或維護產品驗證入口與功能地圖。使用時機：要求可交接的產品驗證、依既有 runbook 驗功能，或修正過期驗證指引；consumer adoption 健康檢查使用 consumer-doctor。"
metadata:
  user-invocable: true
  argument-hint: "setup|run|maintain [project/runbook] [features]"
---

# Devpro Project Verify

## Overview

提供 setup、run、maintain 三個產品驗證入口。Policy SSOT 是 `.devpro/agent-rules/project-verification.md`；本 skill 只路由與排序，不另定結果、覆蓋或寫入契約。

## When to Use

- 要建立團隊／下一個 agent 可直接操作的產品驗證入口或功能地圖。
- 要執行既有產品驗證，或維護產品改動後過期的 runbook／harness。

## Process

1. 載入 `project-verification.md`，依使用者目的決定 setup／run／maintain、專案、入口及功能範圍。已有唯一入口就復用；多個不明確先確認。run／maintain 無入口時照 policy 回報，不默默建立。
2. 讀選定入口與當前模式所需的專案材料；執行 policy 對應模式、故障分流、結果及清理要求。工具只用已證明可用的 runtime／專案 harness，不把別的平台 tool schema 當成可用能力。
3. 交付實際功能結果、證據位置、未覆蓋項目、必要修正及下一步。setup／maintain 留下的操作入口須可發現、可重跑；run 不改指引，maintain 不修產品。

## Verification

`node .devpro/scripts/lint-agent-skills.mjs` 驗分發與格式。Baseline／fresh-context treatment 及 run／maintain 實際寫入與失敗分流，依 change-local skill-evaluation 驗收；格式通過不代表產品通過。
