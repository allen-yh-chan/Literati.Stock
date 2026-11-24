---
name: codeql-execution
description: CodeQL 執行路徑（local CLI vs GitHub Actions）+ runner readiness gate；觸發：撰寫/維護 devpro:security-scan skill / 評估 local-first vs GHA 分流 / 判定 Platform × Stack 可行性。
---

# CodeQL Execution Paths

## Overview

`devpro:security-scan` 雙路徑：本機 CodeQL CLI（local-first，預設選擇）vs GitHub Actions self-hosted runner（fallback）。Local 路徑在 macOS / Linux / Windows + Stack B，或 Windows + Stack A 可行；Stack A net4x 在 non-Windows 強制 fallback，Stack C 保守標為 undetermined 並 fallback。只有 probe 回傳 `route="local"` 才 always-ask `[Y/n]` (default y) 給 user 最後確認。本 leaf 同時吸收 Runner Readiness 設計理由（從 security-scanning.md 外移）。

## When to Use

- 撰寫 / 維護 `devpro:security-scan` skill 的執行邏輯
- 評估在 macOS / Linux 開發機跑 local scan vs GHA 的決策
- 判定當前 Platform × Stack 組合是否走 local viable
- 解 GHA path 行為（runner readiness / queued-timeout）疑問

## Process

### Detection

```bash
node .devpro/scripts/detect-codeql-local-route.mjs --root .
```

Probe 使用 Node built-ins 遞迴檢查 project evidence（忽略 `.git`、`node_modules`、`bin`、`obj`、`.codeql-db`、`codeql-results`），直接解析 PATH 與 Windows PATHEXT，並由 `process.platform` 判定 platform。有效 outcome exit 0，stdout 恰為一個 stable JSON object，至少含：`schemaVersion`、`platform`、`cliPresent`、`cliVersion`、`stack`、`viability`、`route`、`reason`。

- `route="local"`：local viable，才可進入 `[Y/n]` prompt。
- `route="gha"`：預期 fallback，不 prompt；CLI missing、Stack A on non-Windows、Stack C undetermined、unknown platform 都屬此類。
- Probe non-zero：invalid args/root 或 probe failure；停止並回報 stderr，不可誤當 GHA fallback。

`reason="cli-missing"` 時只提示、不自動安裝：

- macOS：`brew install --cask codeql && codeql pack download codeql/csharp-queries`，並提供 [`github/codeql-cli-binaries`](https://github.com/github/codeql-cli-binaries/releases) fallback。
- Linux / Windows / Other：提供 [`github/codeql-cli-binaries`](https://github.com/github/codeql-cli-binaries/releases)；首次使用再執行 `codeql pack download codeql/csharp-queries`。

### Local Path

Probe `route="local"` AND user 答 y 時：

```bash
# database create（依 Stack 選 build command）
codeql database create .codeql-db --language=csharp --command="<build-cmd>"
# Stack A: msbuild <sln> /p:Configuration=Release
# Stack B: dotnet build --configuration Release --no-incremental

# analyze + 產出 SARIF
codeql database analyze .codeql-db codeql/csharp-queries \
  --format=sarif-latest \
  --output=./codeql-results/csharp.sarif

# 串接既有 sarif-report.mjs（兩 path 共用 SARIF 路徑）
node .devpro/scripts/sarif-report.mjs --sarif ./codeql-results/csharp.sarif
```

### GHA Path（fallback；引用 W4，非重述）

Probe `route="gha"` OR user 答 n 時，走 `devpro:security-scan` GHA path既有 queued-timeout 邏輯（30s = 3 × 10s 輪詢、`gh run view --json status`、queued/pending/requested 三 pre-running 狀態探測）。完整邏輯見 skill body GHA path。Probe non-zero 不在此 fallback 條件內。

### Y/N Prompt Design

僅 probe `route="local"` 時 prompt：

```
已偵測到 CodeQL CLI <version> + Stack [A/B]，本機掃描？[Y/n]
```

回應解析：
- 空回（直接 Enter）→ `y` ← **default y**（local-first 友善預設）
- `y` / `Y` / `yes` / `Yes` → y
- `n` / `N` / `no` / `No` → n
- 其他 → 重提一次後仍 default y

### Platform × Stack Matrix

| Stack | macOS | Linux | Windows |
|---|---|---|---|
| **A** net4x ToolsVersion | ❌ | ❌ | ✅ |
| **B** SDK-style net5+ | ✅ | ✅ | ✅ |
| **C** Node/Python/etc | undetermined → GHA | undetermined → GHA | undetermined → GHA |

Probe 的 platform mapping：`darwin` → macOS、`linux` → Linux、`win32` → Windows、其他 → unknown。Legacy `ToolsVersion` evidence 優先 Stack A，SDK-style csproj 為 Stack B，其餘為 Stack C。

- ❌ 或 undetermined 即 expected GHA fallback（exit 0、**不** prompt）。
- ✅ 且 CLI present 才回傳 `route="local"` 並進 prompt。
- CLI missing 永遠回傳 `route="gha"`、`reason="cli-missing"`。

### Runner Readiness（GHA path）：為何不用 enumeration

runner 可在 repo / org / enterprise 三層；repo endpoint 在 org setup 下回 false negative；org-level 需 `admin:org` scope 超出最小權限。觸發後 `gh run view --json status` 輪詢 30s；離開 queued/pending/requested → runner 存在。

**Timeout SoT**：30s = 3 輪 × 10s（per `devpro:security-scan` skill step 5b GHA path 實作）；本 leaf 為 timeout 值與輪詢策略的單一事實來源，spec / skill / 其他引用皆以此為準。

**Assumption**：codeql.yml 多 job 化後須改逐 job 查 runner_id。

## Exit Criteria

- `devpro:security-scan` skill 呼叫 exact probe command並依 stable JSON routing
- Probe 以 Node PATH/PATHEXT、`process.platform`、recursive csproj scan完成 detection
- Skill 僅在 `route="local"` 含 `[Y/n]` prompt default y
- Skill local 分支 + GHA fallback 分流均存在；valid fallback不誤報 probe failure
- security-scanning.md Runner Readiness 段已確認本 leaf 為 timeout 值單一事實來源（skill 引用本 leaf）

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「local 比較慢，不如直接 GHA」 | local 同步等 build，GHA queued + watch + download 反而 latency 高；probe 選出 `route="gha"` 時才直接 fallback |
| 「Stack A 加 build command 太複雜」 | Stack A on Windows 一行 `msbuild *.sln /p:Configuration=Release`；non-Windows 直接 fallback GHA |
| 「不 prompt 直接 default y 比較順」 | 違反「always ask」訓令；user 可能想換 GHA 對齊 release 線 build artifact 一致 |
| 「保留 enumeration 作 fast-path」 | enumeration 永遠 false negative（org-level setup），保留只增複雜度 |

## Verification

```bash
node .devpro/scripts/detect-codeql-local-route.mjs --root .              # cross-shell route probe
node --test .devpro/scripts/tests/detect-codeql-local-route.test.mjs     # PATH/PATHEXT/platform/stack contract
codeql resolve packs                                                     # 人工確認 pack（非 routing 前提）
gh workflow run codeql.yml && sleep 5                                    # GHA manual verify
run_id=$(gh run list --workflow codeql.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$run_id" --json status -q '.status'
```

人工檢查項：
- skill probe command與本 leaf一致，`route="gha"` 不 prompt
- skill local prompt文字與本 leaf「Y/N Prompt Design」段一致
- security-scanning.md Runner Readiness 段引用本 leaf 作為 timeout SoT（`grep -c "codeql-execution.md" .devpro/agent-rules/security-scanning.md` ≥ 1）
