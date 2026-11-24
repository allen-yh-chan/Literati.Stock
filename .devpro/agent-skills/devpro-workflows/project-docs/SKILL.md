---
name: project-docs
description: "建立架構／模組文件或盤點文件與實作落差。使用時機：要求整理指定 repo／模組文件、比較文件與實作，或找出未記錄的重要行為時。"
metadata:
  user-invocable: true
  argument-hint: "build|drift <repo-or-module>"
---

# Devpro Project Docs

## Overview

提供按需的 build／drift 入口。Policy SSOT 是 `.devpro/agent-rules/project-documentation.md`；本 skill 只路由與安排步驟，不重定義權威、分類或寫入邊界。

## When to Use

- 要整理指定 repo／模組的架構與現況文件。
- 要雙向比較文件與實作，找出落差或未記錄的重要行為。
- 要實跑功能或修驗證操作指引時，轉 `devpro:project-verify`。

## Process

1. 載入 `project-documentation.md`，依使用者目的確認 build／drift、repo／模組及文件入口；只釐清尚未明確的部分。
2. 依 policy 查契約與現況材料，執行所選模式。build 由底層向上整理；drift 雙向盤點並依證據分類。寫入與無文件情形均遵循 policy，不自行改走另一模式。
3. 交付實際產物或報告、證據、未覆蓋與下一步；將需實跑的確認交由既有產品驗證入口。

## Verification

`node .devpro/scripts/lint-agent-skills.mjs` 驗分發與格式；比例適當的 no-guidance baseline 與 fresh-context treatment 依 `agent-skill-governance.md` 驗收，結構通過不等於行為遵循。具名 change 的實際情境、產物與限制記在其 skill-evaluation 證據。
