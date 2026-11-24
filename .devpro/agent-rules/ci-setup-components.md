---
name: ci-setup-components
description: /devpro:setup-ci Component Registry：可安裝的 CI component 清單、偵測 stack 邏輯、dispatch 規則與擴充流程。觸發：使用者執行 /devpro:setup-ci 或 /devpro:setup-ci <component> 時。
---

# `/devpro:setup-ci` Component Registry

## Overview

`/devpro:setup-ci` 支援多 component 安裝：**不帶參數**時互動式偵測並逐一詢問；**帶 component 參數**時快速安裝指定 component 略過偵測互動（例：`/devpro:setup-ci codeql`）。

| Component | 對應 rule | 狀態 |
|---|---|---|
| `integration` | `ci-cd-integration-deployment.md` | 生產可用 |
| `codeql` | `security-scanning.md` | 生產可用 |
| `secret-scan` | TBD | 佔位（P1）|
| `sbom` | TBD | 佔位（P1）|
| `sign-artifact` | TBD | 佔位（P1）|
| `release-milestone` | `release-sit-uat-pat-prod.md` | 選配（consumer-owned；source 不裝）|

## When to Use

- 使用者執行 `/devpro:setup-ci` 或 `/devpro:setup-ci <component>` 時
- 需判斷「哪些 CI component 可/應安裝到 consumer repo」時

## Process

### 不帶參數：互動偵測

1. 掃描 `.github/workflows/` 判斷已安裝 component
2. 掃描 consumer 根層檔案判斷 stack：`<sln>.sln` + `<Project ToolsVersion="...">` → `dotnet-framework`；`<Project Sdk="Microsoft.NET.Sdk">` → `dotnet-sdk`；`package.json` → `nodejs`；其他 → 問使用者
3. 對未安裝且適用的 component 逐一詢問：`detected deploy-integration.yml, no codeql.yml — install CodeQL? [y/N]`
4. 使用者同意則走「帶參數」流程

### 帶參數：fast path（以 codeql 為例）

1. 讀取 `.devpro/agent-rules/security-scanning.md` template section
2. 偵測 stack 選 Stack A / B / C template
3. 確認 `APP_ID` + `APP_PRIVATE_KEY` secret 已設定（`gh secret list`），未設定則引導建立 GitHub App
4. 詢問 `runs-on` 標籤（dotnet-framework 必填）及 solution 路徑（若有多個 `.sln`）
5. 寫入 `.github/workflows/codeql.yml`
6. 驗證：`gh workflow list` 看到新 workflow 名稱
7. 提示使用者：手動觸發 `gh workflow run codeql.yml` 跑 smoke test

`/devpro:setup-ci integration`：依 `ci-cd-integration-deployment.md` 既有流程執行。

### 帶參數：`/devpro:setup-ci release-milestone`（optional，consumer-owned）

安裝 consumer 自有 workflow：僅當 PR head 為 `feature/`、`bugfix/`、`chore/`（即 `feature/|bugfix/|chore/` 前綴）、base 為 `main`、且該 PR 缺 milestone → check fail；其他情境（非可促進前綴、非 `main` base、或已有 milestone）MUST NOT 受影響（其他情境不受影響）。**source repo MUST NOT 安裝此 workflow**（source CI workflows 已退役，local test suite 為唯一 source-side test gate），故此 component 只以 consumer 可安裝選項形式登錄於本 registry；milestone SSOT 見 `release-sit-uat-pat-prod.md` §Subset selection handoff。

### 共用 Secret

所有含 `actions/checkout` + `submodules: recursive` 的 workflow 都需要 `APP_ID` + `APP_PRIVATE_KEY`（GitHub App installation token）。安裝任一 component 時，若 `gh secret list` 未見這兩個 secret，須先引導使用者依 `ci-cd-integration-deployment.md` §1 建立 GitHub App。

### 擴充新 component

1. 新增 `.devpro/agent-rules/<component>-<feature>.md`（含 template + 觸發條件 + 驗證證據）
2. 在本檔 component registry 表新增一列
3. 在 dispatch 規則的「偵測 stack」補對應判斷
4. AGENTS.md 觸發式載入索引新增 entry（若該 component 有獨立觸發）
5. 依 SemVer 決定 AGENTS.md 版號 bump（通常 MINOR）

## Exit Criteria

- `gh workflow list` 看到新 workflow 名稱
- `APP_ID` + `APP_PRIVATE_KEY` secret 已設定（`gh secret list` 驗證）
- smoke test：`gh workflow run <component>.yml` Actions run 綠燈

## Common Rationalizations

N/A — 技術規範類，無對應藉口。

## Verification

```
# 確認 workflow 已建立
gh workflow list

# 確認 secrets 存在
gh secret list

# 禁止事項檢查（人工）
# - 未猜測 stack（缺依據時有問使用者）？
# - 未覆蓋既有同名 workflow？
# - component 間 secrets 未混用？
```
