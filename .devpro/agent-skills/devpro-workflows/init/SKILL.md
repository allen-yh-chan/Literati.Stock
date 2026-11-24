---
name: init
description: "環境初始化 workflow：在 repo 工作開始前檢查 nvm、Node.js 與 OpenSpec CLI 是否可用。使用時機：使用者 invoke /devpro:init、要求首次設定專案環境，或詢問如何為此 repo bootstrap nvm/Node/OpenSpec。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:init"
---

# Devpro Init

## Overview

本 skill 是 Devpro 環境初始化流程的 routing 與操作步驟載體。用於在任何 repo 寫入動作發生前，檢查 `nvm`、Node.js、OpenSpec CLI 是否存在且版本正確。

**Policy SSOT 留在規則 leaf——本 skill 不重複其內容。** 必做檢查與驗證完成所需的證據定義於 `environment-setup-nvm-nodejs-openspec.md`；本 skill 只告訴你*何時*呼叫、*如何*排序「讀取後執行」的步驟。務必讀取並執行該規則以取得權威 checklist，而非依賴本 skill 的摘要。

## When to Use

使用者執行 `/devpro:init` 或首次設定專案環境時。

## Process

### 1. 先讀取 policy SSOT

讀取 `.devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md` 全文。AGENTS.md 由 CLAUDE.md project instruction always-load 注入，無需重讀。

### 2. 執行必做檢查

依該檔案的「必做檢查」逐步執行，依序進行。不可因先前 session 看起來正常而略過某項檢查——環境漂移（nvm 版本升級、node 重裝、OpenSpec CLI 升級）正是本流程存在的目的。

### 3. 以證據確認完成

讀完後，依「驗證證據」確認完成——不可只憑「看起來沒問題」就宣告 `/devpro:init` 完成；須展示實際指令輸出以證明每項檢查通過。

class ② auto-compact：完成報告 MUST 附上 `dp-change-environment-checks.mjs` stdout 的 current vs recommended 對照表（WINDOW/PCT/effective 與 Codex limit）。`skipped-without-table is not environment-complete`。MUST NOT report skipped as applied。MUST NOT write HOME auto-compact；寫入只在 `devpro:change` HITL TTY，或同一 session 已確認套用建議值後把 `y/yes` 餵給同一 capability。session confirmation equals y/yes；superseded comments MUST NOT reopen Ask First。

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs
```
