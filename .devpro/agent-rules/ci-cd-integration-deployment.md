---
name: ci-cd-integration-deployment
description: Integration 分支自動部署與 E2E 驗證設定：GitHub Secrets + 四個 workflow 檔 + RunnerRelay API。觸發：首次導入 devpro-agent-rules 後設定 CI/CD、或執行 /setup-ci 時。
---

# CI/CD：Integration 自動部署與 E2E 驗證

> 本規則僅涵蓋 `integration` push 觸發的 CI/CD（部署目標：**DEV**）。SIT/UAT/PAT/PROD 見 `release-sit-uat-pat-prod.md`。

## Overview

```
feature → main → integration (git merge main)
                       │
                       ├─ deploy-integration.yml（自動觸發）
                       │    └─ 透過 RunnerRelay 部署 integration HEAD 到 DEV
                       │
                       └─ e2e-integration.yml（部署成功後自動觸發）
                            ├─ 全綠 → 可決定 subset 進 release
                            └─ 失敗 → 在 feature branch 修
```

**觸發分支是 `integration`，不是 `main`。** 禁止把 integration artifact 直接推 UAT/PAT/PROD。

## When to Use

- 首次在 consumer repo 導入 devpro-agent-rules 後設定 CI/CD（一次性）
- 專案需要自動部署到 integration 環境（DEV）進行全量驗證時
- 使用者執行 `/setup-ci` 時

## Process

### 1. 設定 GitHub Secrets

向使用者詢問以下值（AI 不得猜測）：

```bash
gh secret set APP_ID --body "<GitHub App 的 App ID>"
gh secret set APP_PRIVATE_KEY < ~/Downloads/<app-name>.<date>.private-key.pem
gh secret set INTEGRATION_AGENT_KEY --body "<RunnerRelay ApiKey>"
gh secret set INTEGRATION_IP --body "<integration env 內網 IP>"
```

`APP_ID` + `APP_PRIVATE_KEY` 用於 workflow 產 installation token 以 clone private submodule；不綁個人帳號且不會過期。建立方式：GitHub org Settings → Developer settings → GitHub Apps → New GitHub App，權限僅 Repository/Contents(Read-only)，建立後取 App ID 與 private key，安裝到 org。

環境相關值用 variable 管理：

```bash
gh variable set INTEGRATION_DEPLOY_PATH --body "<部署目標路徑>"
gh variable set INTEGRATION_BASE_URL --body "<integration 站台 URL>"
```

### 1b. RunnerRelay HTTP API（路徑前綴 `/RunnerRelay/`）

| 方法 | 路徑 | X-Api-Key | 說明 |
|---|---|---|---|
| `GET` | `/RunnerRelay/health` | 否 | 存活檢查；JSON `{ "status": "ok" }` |
| `GET` | `/RunnerRelay/version` | 是 | 組件版本（資訊用） |
| `POST` | `/RunnerRelay/execute` | 是 | body：`{ "type": "powershell", "command": "..." }`；用 `powershell.exe` 執行；逾時回 408；成功回 `exitCode`/`stdout`/`stderr`/`executedAt` |
| `POST` | `/RunnerRelay/download` | 是 | body：`{ "path": "<完整路徑>" }`；成功回 `application/octet-stream`；不存在回 404 |
| `POST` | `/RunnerRelay/upload` | 是 | `multipart/form-data`：欄位 `path`（目標路徑）+ `file`（檔案） |

ApiKey 來源：組態 `ApiKey` 或 `RunnerRelay:ApiKey`。若部署在 IIS 虛擬目錄或反向代理子路徑，必須設定 `PathBase` 以保持前綴一致。

**Windows `.bat` 編碼陷阱**：cmd.exe 以系統 ANSI codepage（台灣語系 CP950）解析 `.bat`，`chcp 65001` 只影響輸出不影響 tokenization。含中文 `.bat` 必須有 UTF-8 BOM（`EF BB BF`）；優先用 `.ps1` 避免問題。

### 2. 建立 Workflow 檔案

在 `.github/workflows/` 建立以下四個檔案：

#### test-runner-relay.yml（手動觸發，驗證連線）

```yaml
name: Test RunnerRelay
on:
  workflow_dispatch:
defaults:
  run:
    shell: pwsh
jobs:
  test:
    runs-on: self-hosted
    steps:
      - name: Health check
        run: |
          $ip = "${{ secrets.INTEGRATION_IP }}"
          $response = Invoke-RestMethod -Uri "http://$ip/RunnerRelay/health" -Method GET
          Write-Host "Health check response: $response"
      - name: Execute command
        run: |
          $ip = "${{ secrets.INTEGRATION_IP }}"
          $body = @{ type = "powershell"; command = "hostname" } | ConvertTo-Json
          $response = Invoke-RestMethod `
              -Uri "http://$ip/RunnerRelay/execute" `
              -Method POST `
              -Headers @{ "X-Api-Key" = "${{ secrets.INTEGRATION_AGENT_KEY }}" } `
              -ContentType "application/json" `
              -Body $body
          Write-Host "ExitCode: $($response.exitCode)"
          Write-Host "Output: $($response.stdout)"
```

#### deploy-integration.yml（integration push 自動觸發）

```yaml
name: Deploy to Integration
on:
  push:
    branches: [integration]
defaults:
  run:
    shell: pwsh
jobs:
  deploy:
    runs-on: self-hosted
    env:
      INTEGRATION_DEPLOY_PATH: ${{ vars.INTEGRATION_DEPLOY_PATH }}
    steps:
      - name: Generate token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: <github-org>
          repositories: |
            <consumer-repo>
            devpro-agent-rules
      - name: Checkout
        uses: actions/checkout@v4
        with:
          token: ${{ steps.app-token.outputs.token }}
          submodules: recursive
      # 依專案部署方式調整：
      # - dotnet publish → POST /RunnerRelay/upload（multipart：欄位 path + file）
      # - 或 POST /RunnerRelay/execute 在 integration env 執行部署腳本
      # Log 寫入 {INTEGRATION_DEPLOY_PATH}\logs（與 fetch-integration-log.yml 約定一致）
```

#### e2e-integration.yml（部署成功後自動觸發）

```yaml
name: E2E on Integration
on:
  workflow_run:
    workflows: ["Deploy to Integration"]
    types: [completed]
    branches: [integration]
defaults:
  run:
    shell: pwsh
jobs:
  e2e:
    runs-on: self-hosted
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    env:
      INTEGRATION_BASE_URL: ${{ vars.INTEGRATION_BASE_URL }}
    steps:
      # 依專案 E2E 框架調整（Playwright / Cypress / 自訂腳本）
      # 測試目標 URL 使用 $env:INTEGRATION_BASE_URL
      - name: Notify on failure
        if: failure()
        run: |
          Write-Host "::error::E2E tests failed on integration env. Fix in feature branch."
```

為了驗證而臨時改環境設定（compose override、環境變數、feature flag、設定檔）再跑 E2E 時，照 `testing-and-qa.md` §臨時改環境設定的驗證：先確認 E2E 腳本不會重建或重啟服務而還原設定，並在測試前後斷言設定仍生效。

#### fetch-integration-log.yml（手動觸發，偵錯用）

```yaml
name: Fetch Integration Log
on:
  workflow_dispatch:
defaults:
  run:
    shell: pwsh
jobs:
  fetch-log:
    runs-on: self-hosted
    env:
      INTEGRATION_DEPLOY_PATH: ${{ vars.INTEGRATION_DEPLOY_PATH }}
    steps:
      # POST /RunnerRelay/download，body：{ "path": "<Join-Path $env:INTEGRATION_DEPLOY_PATH 'logs' 後的 .log 路徑>" }
      # 標頭帶 X-Api-Key，回應串流存為檔案後 actions/upload-artifact 上傳
```

### 3. 驗證設定

1. 手動觸發 `Test RunnerRelay`，確認 health check 通過
2. 在 `integration` branch 做一次 `git merge main`，確認 `Deploy to Integration` 自動觸發
3. 確認部署成功後 `E2E on Integration` 自動觸發

## Exit Criteria

- `gh secret list` 可看到 `INTEGRATION_AGENT_KEY` 和 `INTEGRATION_IP`
- `test-runner-relay.yml` 手動觸發後 health check 通過
- `deploy-integration.yml` 在 `integration` branch push 時自動觸發並部署成功
- `e2e-integration.yml` 在部署完成後自動觸發並全綠

## Common Rationalizations

N/A — 純技術實作規範，無對應藉口反駁

## Verification

```bash
# 確認 Secrets 已設定
gh secret list

# 確認 workflow 檔案存在
ls .github/workflows/

# 手動觸發連線測試
gh workflow run test-runner-relay.yml
gh run watch
```

人工檢查項：
- `deploy-integration.yml` trigger 分支為 `integration`（非 `main`）
- `e2e-integration.yml` 的 `if` 條件確認為 `workflow_run.conclusion == 'success'`
- 所有敏感值（IP、ApiKey、路徑）均使用 Secrets/Variables，未寫死在 workflow 檔案中
