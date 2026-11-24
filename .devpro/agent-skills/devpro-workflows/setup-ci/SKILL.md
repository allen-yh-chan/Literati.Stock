---
name: setup-ci
description: "一次性 CI/CD 設定：發現缺少的 component 或安裝具名 component（integration、codeql），含 workflow 檔案、secrets 與連線驗證。使用時機：使用者 invoke /devpro:setup-ci、/devpro:setup-ci integration、/devpro:setup-ci codeql，或要求首次設定 CI/CD。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:setup-ci [component]"
---

# Devpro Setup CI

## Overview

本 skill 是 Devpro CI/CD 一次性設定流程的 routing 與操作步驟載體。它是一個 **umbrella skill**：路由到無參數的 discover mode 或具名 component 的 fast path，並將各 component 的詳細步驟收在 `references/`。

**Policy SSOT 留在規則 leaf——本 skill 不重複其內容。** component dispatch 規則、支援的 stack、workflow 模板定義於 `.devpro/agent-rules/ci-setup-components.md`（CodeQL component 另見 `security-scanning.md`；integration component 另見 `ci-cd-integration-deployment.md`）。務必讀取並執行這些規則以取得權威決策，而非依賴本 skill 的摘要。

**Topology**：discovery mode 與兩個具名 component（`integration`、`codeql`）是本 umbrella skill 的子步驟——它們不是可獨立由使用者觸發的 skill 或 slash command（其來源 command 檔帶有 `disable-model-invocation: true`）。只有本 umbrella skill 是 user-invocable；它會載入對應的 `references/` 檔取得具體步驟。

## When to Use

使用者執行 `/devpro:setup-ci` 進行 CI/CD 初次設定時。

先讀：`.devpro/agent-rules/ci-setup-components.md`

## Process

### Routing

#### A) 無參數（discover mode）

載入 `references/discovery-mode.md`：偵測 `.github/workflows/` 現有檔案，依 `ci-setup-components.md` dispatch 規則判斷 stack 與可安裝 component，只列「可安裝且未安裝」的 component，逐一詢問是否安裝。

#### B) 有參數（fast path）

- `/devpro:setup-ci integration` → 載入 `references/integration-component.md`
- `/devpro:setup-ci codeql` → 載入 `references/codeql-component.md`
- 其他參數 → 列出已支援 component，請使用者選擇是否要 invoke 既有 component；若確認為新 component，需先補對應 rule 檔案於 `ci-setup-components.md` 後再 invoke

## Constraints

1. 禁止猜測 secrets/infra 參數，必須詢問使用者。
2. 偵測到既有同名 workflow 時，必須停下詢問（更新/略過/另命名）。
3. 模式 A 逐項確認，禁止未同意即批次安裝多個 component。
4. **禁止**把 component 間的 secrets 混用（例：`INTEGRATION_AGENT_KEY` 不可複用於 CodeQL 認證情境）。

## Test Scenarios

| 流程類別 | 觸發情境 | 預期結果 |
|---|---|---|
| Normal | `/devpro:setup-ci integration` + 未安裝 integration component | discovery 確認 → 安裝 workflow + 設 secrets + 連線驗證；單一 component 完成 |
| Existing-File | 偵測到既有同名 workflow | 停下詢問（更新 / 略過 / 另命名），禁止靜默覆蓋 |
| Error | 使用者輸入未支援 component（如 `lighthouse`） | 停下列出已支援清單，要求先補 `ci-setup-components.md` 後再 invoke |

> 此矩陣為改本 command 時的迴歸觀測點，協助快速辨識破壞 happy path 的修改。

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
```
