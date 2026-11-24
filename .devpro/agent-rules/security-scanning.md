---
name: security-scanning
description: CodeQL 安全掃描規範：三個時機點（pre-PR 建議 / release 線建議 / PROD 前建議確認）+ workflow template（dotnet-framework / dotnet-sdk）+ sarif-report.mjs。觸發：建立或維護 CodeQL 掃描流程、執行 /devpro:setup-ci codeql 或 /devpro:security-scan 時。
---

# 安全掃描：CodeQL 工作流程與時機

## Overview

CodeQL 掃描分三層：pre-PR 建議、release 線建議掃描、上 PROD 前建議確認。以 SARIF `level` 判定：`error`（Critical / Error）為應處理級別；`warning` / `note` 需追蹤。三層均為**建議 / 文件紀律**——目前 `release-sit-uat-pat-prod.md` **未實作** build-time CodeQL block；如需強制 gate（release/PROD push 自動 block）屬未來 feature，非現況。

## When to Use

- 要對 consumer repo 建立或維護 CodeQL 掃描流程時
- 使用者執行 `/devpro:setup-ci codeql` 或 `/devpro:security-scan` 時
- 規範本檔「三個時機點」任一層級需要驗證時

## Process

### 三個時機點

| 時機 | 強度 | 執行方式 | 驗收 |
|---|---|---|---|
| **pre-PR 建議** | 建議（可選）| 開 PR 前手動跑 `/devpro:security-scan` | 報告中 Critical + Error = 0；非 0 時 PR 描述需列「已評估並接受」 |
| **release 線建議** | 建議（非強制）| `release/*` 分支 push 或 release artifact build 前手動跑 | 建議 CodeQL workflow 綠燈 + SARIF Critical + Error = 0；非 0 時 release/PR 描述需列「已評估並接受」（**文件紀律，非 build-time block**） |
| **上 PROD 前建議確認** | 建議確認 | 部署 PROD 前（`production-*` tag 建立前的最後確認）| 建議最近一次 release 分支 CodeQL 報告 Critical + Error = 0；PR/release 描述填「已跑 CodeQL 掃描 + 結果」；非 0 時另填「已評估並接受」（與 release 線對稱，文件紀律） |

`codeql.yml` 預設只保留 `workflow_dispatch`；是否加 `push` / `pull_request` / `tag` 自動觸發由 consumer repo 自行決定。

### CodeQL Workflow Template

依 consumer csproj 格式選 stack（`devpro:setup-ci codeql` 會自動寫入 `.github/workflows/codeql.yml`）：

> **Token scope 必填**：`<github-org>` / `<consumer-repo>` 替換為實際值；`devpro-agent-rules` 為 submodule 來源 repo（`actions/create-github-app-token@v1` 預設只發當前 repo token，submodule 拉取需明確 scope，否則 404）。

#### Stack A：dotnet-framework（net4x + legacy csproj）

適用：`<Project ToolsVersion="...">` 格式，目標 framework `net40`～`net48`；必須 Windows runner + MSBuild。

```yaml
name: CodeQL Security Analysis
on:
  workflow_dispatch:
defaults:
  run:
    shell: pwsh
jobs:
  analyze:
    name: Analyze (net48)
    runs-on: [self-hosted, <consumer-label>, codeql]
    permissions:
      security-events: write
      actions: read
      contents: read
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
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ steps.app-token.outputs.token }}
          submodules: recursive
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: csharp
          queries: security-and-quality
      - name: Setup MSBuild
        uses: microsoft/setup-msbuild@v2
      - name: Disable MvcBuildViews for CodeQL
        run: |
          Get-ChildItem -Recurse -Filter *.csproj | ForEach-Object {
            $content = Get-Content $_.FullName -Raw -Encoding utf8
            $content = $content -replace 'Condition="''\$\(MvcBuildViews\)''==''true''"', 'Condition="false"'
            Set-Content $_.FullName -Value $content -Encoding utf8 -NoNewline
          }
      - name: Restore NuGet packages
        run: nuget restore <solution>.sln
      - name: Build
        run: msbuild <solution>.sln /p:Configuration=Release /p:UseSharedCompilation=false
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:csharp"
          upload: never
          output: codeql-results
      - name: Upload SARIF as artifact
        uses: actions/upload-artifact@v4
        with:
          name: codeql-results
          path: codeql-results
          retention-days: 30
```

> `upload: never` 對應未啟用 GitHub Advanced Security 的 repo；已啟用 GHAS 可改為預設上傳。

#### Stack B：dotnet-sdk（net5.0+，含 net8）

適用：`<Project Sdk="Microsoft.NET.Sdk">` SDK-style csproj；可用 `ubuntu-latest`。

```yaml
name: CodeQL Security Analysis
on:
  workflow_dispatch:
jobs:
  analyze:
    name: Analyze (dotnet-sdk)
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      actions: read
      contents: read
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
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ steps.app-token.outputs.token }}
          submodules: recursive
      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: csharp
          queries: security-and-quality
      - name: Restore
        run: dotnet restore
      - name: Build
        run: dotnet build --configuration Release --no-restore
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:csharp"
          upload: never
          output: codeql-results
      - name: Upload SARIF as artifact
        uses: actions/upload-artifact@v4
        with:
          name: codeql-results
          path: codeql-results
          retention-days: 30
```

#### Stack C：nodejs / python / 其他

**TBD（P1 擴充）**：待有實際 consumer 採用時再補 template。

### 報告產生器：`sarif-report.mjs`

```bash
node .devpro/scripts/sarif-report.mjs \
  --sarif ./codeql-results/csharp.sarif \
  --source-root . \
  --project "<consumer-name>" \
  --out ./docs/codeql-YYYY-MM-DD.html
```

| 旗標 | 說明 |
|---|---|
| `--sarif <path>` | SARIF v2.1.0 輸入檔（必填） |
| `--source-root <dir>` | snippet 注入的基準目錄（預設：`.`） |
| `--project <name>` | 報告標題（預設：repo 資料夾名稱） |
| `--out <path>` | HTML 輸出路徑（預設：`docs/codeql-YYYY-MM-DD.html`） |

- HTML 報告含 Security Severity（CVSS 4 桶）+ Problem Severity（3 桶）雙維分類。
- `sarif-report.mjs` 為 zero-dep ES module（僅 Node.js 內建模組）。

### `.gitignore` 約定

- 原始 SARIF（`codeql-results/`）：**ignored**（檔案大、非人類可讀）；`.gitignore` baseline entry 由 `gitignore-alignment.md` 管理
- HTML 報告（`docs/codeql-*.html`）：**tracked**（PR review 可 diff，Actions artifact 30 天保留）

> **Runner Readiness**（為何不用 enumeration / 30s queued-timeout / timeout 值 SoT）：見 `.devpro/agent-rules/codeql-execution.md` § Runner Readiness

## Exit Criteria

- （建議）release 線觸發的 CodeQL workflow 綠燈
- （建議）SARIF 報告 Critical + Error = 0（或 release/PR 描述已列「已評估並接受」）
- PROD 部署前 PR/release 描述已填「已跑 CodeQL 掃描 + 結果」（文件紀律；非 build-time gate——release-sit 未實作自動 block）

## Common Rationalizations

N/A — 純技術實作規範，無對應藉口反駁

## Verification

```bash
# 手動觸發掃描
gh workflow run codeql.yml

# 監看執行狀態
gh run watch

# 下載 SARIF artifact
gh run download <run-id> --name codeql-results

# 產生 HTML 報告
node .devpro/scripts/sarif-report.mjs \
  --sarif ./codeql-results/csharp.sarif \
  --out ./docs/codeql-YYYY-MM-DD.html
```

人工檢查項：
- `codeql.yml` 中 `permissions` 包含 `security-events: write`
- SARIF 報告中 `level: error` 的 rule 結果數量
- `docs/codeql-*.html` 已 committed（非 gitignored）
- Release PR 描述有填「已跑 CodeQL 掃描 + Critical/Error 數量」

參考：
- `devpro:setup-ci codeql`：首次建立 CodeQL workflow
- `devpro:security-scan`：執行掃描並產生報告
- `.devpro/agent-rules/ci-setup-components.md`：`devpro:setup-ci` component registry
- `.devpro/agent-rules/release-sit-uat-pat-prod.md`：release 流程文件（目前**未含** build-time CodeQL gate；本檔三層 CodeQL 為建議 / 文件紀律，非該檔強制 gate）
