---
description: "CI/CD 一次性設定：依 component 安裝 workflow + secrets + 連線驗證（AGENTS.md §1b）"
---

STOP — 先用讀檔工具讀取 `AGENTS.md` 全文，確認行為邊界與本次相關章節。

接著讀取 `agent-rules/ci-setup-components.md` 全文（consumer repo 路徑為 `.devpro-agent-rules/agent-rules/ci-setup-components.md`）以取得 component registry 與 dispatch 規則。

依參數決定流程：

## 模式 A：不帶參數 → 互動偵測

1. 掃描 consumer `.github/workflows/` 列出已安裝 component
2. 依 `ci-setup-components.md` 的 dispatch 規則偵測 stack（`dotnet-framework` / `dotnet-sdk` / `nodejs` / 其他）
3. 列出**可安裝且未安裝**的 component，逐一詢問使用者：
   ```
   detected deploy-integration.yml, no codeql.yml — install CodeQL? [y/N]
   ```
4. 使用者每回答 `y`，**遞迴 invoke** 本 command 的「模式 B」對應 component

## 模式 B：帶 component 參數 → fast path

依 component 跳轉對應子流程：

### `/dp:setup-ci integration`

讀取 `agent-rules/ci-cd-integration-deployment.md` 全文，依該檔步驟執行：

1. **詢問使用者**以下資訊（禁止猜測或編造）：
   - integration env 內網 IP
   - RunnerRelay ApiKey
   - workflow `runs-on` 標籤（`sinopac` / `devpro` / 其他；若其他需完整 label）
   - 部署目標路徑（若適用）
   - E2E 測試框架與指令（若已有）

2. **設定 GitHub Secrets**：用 `gh secret set INTEGRATION_IP`、`gh secret set INTEGRATION_AGENT_KEY`，以及 `gh variable set INTEGRATION_DEPLOY_PATH` / `INTEGRATION_BASE_URL`

3. **建立 workflow 檔案**：依 `ci-cd-integration-deployment.md` 的模板，根據使用者提供的資訊調整後建立 `deploy-integration.yml`、`e2e-integration.yml`、`fetch-integration-log.yml`、`test-runner-relay.yml`

4. **驗證**：提示使用者手動觸發 `Test RunnerRelay` workflow 確認連線

### `/dp:setup-ci codeql`

讀取 `agent-rules/security-scanning.md` 全文，依該檔 template section 執行：

1. **偵測 csproj stack**：
   - 掃描根層 `.csproj` / `.sln` 判斷 `dotnet-framework`（legacy csproj）或 `dotnet-sdk`（SDK-style）
   - 若同 repo 有混合，停下請使用者指定主 stack

2. **詢問使用者**以下資訊（dotnet-framework 必填；dotnet-sdk 可採 default）：
   - `runs-on` 標籤（預設依 stack：framework → `[self-hosted, <label>, codeql]`；sdk → `ubuntu-latest`）
   - solution 路徑（若有多個 `.sln`）

3. **寫入 workflow 檔案**：依 stack 選 `security-scanning.md` 的 Stack A / B template，替換 placeholder 後寫入 `.github/workflows/codeql.yml`

4. **`.gitignore` 收斂**：確認 `codeql-results/` 已在 `.gitignore`（若無則加）；`docs/codeql-*.html/pdf` **不** ignore

5. **驗證**：
   - `gh workflow list` 看到新 `CodeQL Security Analysis` entry
   - 提示使用者：手動跑 `gh workflow run codeql.yml` 做 smoke test 確認 Actions 綠燈

### `/dp:setup-ci <未知 component>`

列出 `ci-setup-components.md` 已定義的 component，詢問使用者是否要改 invoke 既有的哪一個，或確認為新 component 需先補 rule 檔案。

## 禁止事項

- **禁止**覆蓋 consumer 既有 workflow 檔案（偵測到同名檔時停下提問：更新 / 略過 / 另命名）
- **禁止**把 component 間的 secrets 混用（例：`INTEGRATION_AGENT_KEY` 不可複用於 CodeQL 認證情境）
- **禁止**未取得使用者同意就批次安裝多個 component（模式 A 必須逐一確認）

完成後回報本次安裝的 component 清單與後續提示。
