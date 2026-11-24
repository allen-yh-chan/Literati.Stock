---
name: security-scan
description: "CodeQL security scan workflow（local CLI vs GitHub Actions detection、SARIF report generation）。使用時機：使用者呼叫 /devpro:security-scan、要求跑 CodeQL scan，或詢問如何在 consumer repo 執行/解讀 security scan 時。（安裝 CodeQL workflow 本身是 /devpro:setup-ci codeql——由 devpro:setup-ci 負責，不是本 skill。）"
metadata:
  user-invocable: true
  argument-hint: "/devpro:security-scan"
---

# Devpro Security Scan

## Overview

本 skill 是 Devpro CodeQL security scan workflow 的 routing 與 operational-recipe 載體：偵測本機 CodeQL CLI 是否可行，不可行時 fallback 到 GitHub Actions，並產出人類可讀的 SARIF report。**Policy 留在 rule leaves**——三種掃描時機 tier（pre-PR / release-line / pre-PROD）、SARIF severity thresholds 與 PROD gate 文件紀律定義在 `security-scanning.md`；local-vs-GHA decision matrix 與 runner-readiness timeout SoT 定義在 `codeql-execution.md`。本 skill 排序 CLI 步驟；不重新定義 policy。

## When to Use

- 使用者執行 `/devpro:security-scan`
- 為 consumer repo 執行或解讀 CodeQL scan（安裝 `codeql.yml` workflow 本身是 `/devpro:setup-ci codeql`，由 devpro:setup-ci 負責）
- 判斷在目前機器上該用本機掃描還是透過 GitHub Actions
- PR 之前、`release/*` push 之前，或 `production-*` tag 之前——依 `security-scanning.md` 的三層 timing

## Process

### 1. 先載入 policy SSOT

在執行之前，先載入並執行 `security-scanning.md`（三層 timing、SARIF severity policy、workflow templates）與 `codeql-execution.md`（local-vs-GHA decision matrix、runner-readiness timeout SoT）。以下本 skill 的步驟是操作順序；pass/fail policy 與 severity thresholds 存在那些檔案裡。

### 2. Pre-flight checks

```bash
node --version
gh auth status
ls .github/workflows/codeql.yml   # must exist first — if missing, stop and run /devpro:setup-ci codeql
```

若 `codeql.yml` 不存在，停下——使用者需要先設置 workflow（`/devpro:setup-ci codeql`；見 `ci-setup-components.md`）。

### 3. Detect local viability

```bash
node .devpro/scripts/detect-codeql-local-route.mjs --root .
```

此 public argv 在 bash、native PowerShell與cmd完全相同。Probe以Node built-ins解析PATH／Windows PATHEXT、`process.platform`與recursive csproj evidence；不依賴shell lookup、platform或text-processing commands。有效local或expected fallback都exit 0，stdout恰為一個stable JSON object，至少包含`schemaVersion`、`platform`、`cliPresent`、`cliVersion`、`stack`、`viability`、`route`、`reason`。

- Probe non-zero：停止並回報stderr；這是invalid args/root或unexpected probe failure，不得改走GHA掩蓋錯誤。
- `route="local"`：CLI present且Platform × Stack viable，進step 4 prompt。
- `route="gha"`：expected fallback，跳過prompt直進step 5b。Stack A on non-Windows為`not-viable`；Stack C與unknown platform為`undetermined`；CLI absent為`reason="cli-missing"`。
- `reason="cli-missing"`：不得auto-install；macOS提示`brew install --cask codeql && codeql pack download codeql/csharp-queries`並附官方binary URL，Linux／Windows／Other提示`https://github.com/github/codeql-cli-binaries/releases`。

### 4. Route: local vs GitHub Actions

- `route="gha"` → 直接走 GHA path（step 5b）；不要詢問
- 僅 `route="local"` → 提示 `已偵測到 CodeQL CLI <version> + Stack [A/B]，本機掃描？[Y/n]`——空白輸入預設 `y`；任何非 `y`/`n` 的回答重新詢問一次，仍預設 `y`
  - `y`（或空白）→ local path（step 5a）
  - `n` → GHA path（step 5b）

### 5a. Local path

```bash
# database create (build command depends on Stack; Stack A = msbuild, Stack B = dotnet build)
codeql database create .codeql-db --language=csharp --command="<build-cmd>"

# analyze + emit SARIF
codeql database analyze .codeql-db codeql/csharp-queries \
  --format=sarif-latest \
  --output=./codeql-results/csharp.sarif
```

### 5b. GitHub Actions path (fallback)

```bash
gh workflow run codeql.yml
```

接著以 `30s` timeout 輪詢 runner readiness（`3 × 10s` 輪詢，依 `codeql-execution.md` §Runner Readiness——timeout 數值的 SoT）：

```bash
run_id=$(gh run list --workflow codeql.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$run_id" --json status -q '.status'   # poll until it leaves queued/pending/requested
gh run watch "$run_id" --exit-status                 # then watch that run to terminal status
gh run download "$run_id" --name codeql-results      # fetch the SARIF artifact
```

### 6. Generate the HTML report (both paths converge here)

```bash
node .devpro/scripts/sarif-report.mjs \
  --sarif ./codeql-results/csharp.sarif \
  --source-root . \
  --project "<consumer-name>" \
  --out ./docs/codeql-YYYY-MM-DD.html
```

Raw SARIF（`codeql-results/`）已 gitignored——不要 commit 它。`docs/codeql-*.html` 下產生的 HTML report 是有被追蹤的（PR-reviewable，作為 Actions artifact 保留 30 天）。這個切分的 SSOT 見 `security-scanning.md` §`.gitignore` 約定。

### 7. Report against policy thresholds

回報 SARIF `level: error` 的數量（依 `security-scanning.md` 的 Critical/Error severity）。目標是零；非零數量需要依 `security-scanning.md` 的三層文件紀律，在 PR/release description 中聲明「已評估並接受」——這是文件 gate，不是 build-time block（`release-sit-uat-pat-prod.md` 目前並未強制 build-time CodeQL block）。

## Progressive Disclosure

- `references/workflow-templates.md` — Stack A（dotnet-framework）與 Stack B（dotnet-sdk）的完整 `codeql.yml` YAML，摘錄自 `security-scanning.md` §CodeQL Workflow Template
- `references/sarif-report-flags.md` — `sarif-report.mjs` 完整 flag 表，摘錄自 `security-scanning.md` §報告產生器

只在實際撰寫/編輯 `codeql.yml` workflow 檔案，或需要確切的 `sarif-report.mjs` flag 語意時才載入這些——rule leaf 仍是 template 內容的 SSOT。

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node .devpro/scripts/detect-codeql-local-route.mjs --root .
node --test .devpro/scripts/tests/detect-codeql-local-route.test.mjs
gh run list --workflow codeql.yml --limit 1
ls docs/codeql-*.html 2>/dev/null
```
