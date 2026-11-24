---
name: environment-setup-nvm-nodejs-openspec
description: nvm + Node.js + OpenSpec + GitHub CLI + Playwright 初始化；觸發：新專案、切換 repo、.nvmrc 變更、或工具指令失敗時。
---

# 環境準備：nvm + Node.js + OpenSpec + GitHub CLI + Playwright

## Overview

本流程採**可恢復流程（recoverable flow）**：優先使用 `.nvmrc`，失敗時允許 fallback；只有無法取得可用環境時才中止。確保 `node`、`npm`、`openspec`、`gh` 可用；在 `devpro:change` startup 期間由單一入口檢查 clone-local、使用者本機與外部服務狀態；若專案宣告 Playwright，另需完成 Playwright browser install 後才實作。

若專案含 `.devpro-agent-rules` submodule 且腳本失敗疑似需要新版 rules/scripts，普通 `feature/bugfix/chore/hotfix` 分支**禁止**直接執行 remote rules update；先依 `rules-flow-routing.md` 走 `devpro:sync-rules` / `rules/<source>-v<X.Y.Z>`。只有在 rules lane 內才可執行 `git submodule update --init --remote .devpro-agent-rules`，完成 rules PR 後回原工作分支重試。

## When to Use

- 開啟新專案（首次 clone / 進 repo）時
- `devpro:change` 建好 worktree 並 `cd` 進去後、第一個 repo write 前
- `.nvmrc` 內容變更後（pull/merge 後版本可能不同）
- 切換專案或 repo 後
- 執行 `node`、`npm`、`openspec`、`gh`、`npx playwright`、`playwright.ps1` 指令失敗時
- `devpro:change` 開頭需要集中檢查使用者本機 runtime 設定時
- **不觸發**：已確認過的同一專案環境，新 session 不需重跑

## Process

依序執行（命令級）：

1. `nvm --version`（若 `command not found` → 跳至 step 3 fallback，回報「使用系統 Node」）
2. 若 `nvm` 可用且有 `.nvmrc`：`nvm install` → `nvm use`
3. 若 step 2 失敗或 `nvm` 未安裝，fallback：`node -v` / `npm -v`；major 與 `.nvmrc` 相容**且** `node -v` 達本 flow 工具 engines 下限（目前 openspec `>=20.19.0`）則可繼續；否則說明缺口並 HELP INSTALL
4. 若無 `.nvmrc`：查明文版本來源（CI workflow `node-version`、`package.json` `engines`）並以 nvm（或等價）安裝／切換後驗證 `node -v` / `npm -v`；皆無 → HELP INSTALL 建議版本（對齊本 flow 工具 engines 下限，目前 openspec `>=20.19.0`），可建議寫入 `.nvmrc`（Windows 注意：`.nvmrc` 應為 LF；`core.autocrlf=true` 可能引入 CR 導致 nvm 讀失敗，可用 consumer `.gitattributes` `eol=lf`，不強制納入 Devpro managed baseline）
5. `openspec --version`；若未安裝：`npm install -g @fission-ai/openspec@latest` → 再次驗證。`@fission-ai/openspec` 需 **Node `>=20.19.0`**（其 `engines.node`）；若出現 `SyntaxError: Invalid regular expression flags` → 查 `node -v`／安裝達下限的 Node（全域 npm 安裝成功但 Node 低於 floor 仍不算 ready）
6. `gh --version`；若未安裝：macOS `brew install gh` / Windows `winget install --id GitHub.cli`
7. `gh auth status`；若未登入提示執行 `gh auth login`（需使用者互動，AI 不可代操）
8. **共同 class ② 環境檢查入口**（class ②＝user、machine、clone-local 或 external-service 狀態；best-effort，不 block 後續 step）：

   ```bash
   node .devpro/scripts/dp-change-environment-checks.mjs
   ```

   此步在 worktree 與 core CLI readiness 完成後、第一個 implementation write 前執行，固定依 `openspec-cli` → `local-excludes` → `hooks-path` → `core-symlinks` → `runtime-auto-compact` → `github-merge-policy` 排序。`openspec-cli` 若解析到的版本低於 `1.9.0`，outcome 為 `blocked`、程序非 0 結束，並要求使用者自行 `npm install -g @fission-ai/openspec@latest` 後重跑 `openspec --version`；入口不得代為升級。CLI 不存在維持 `risk`（安裝仍走本 flow 的 auto-install）。其餘 stage 回傳 `{ check, execution, outcome, detail }`；unknown/error 必須是 skipped/risk，整體 fail-open 且繼續後續 stage。class ② MUST run at `devpro:change` startup，且 raw `--sync` / `--check` MUST NOT query, prompt, or write class ② state。SessionStart 只可保留 shared hooks helper 的 backstop，不得觸發 runtime 或 GitHub diagnostics。

   在未導入 Devpro 的目標 worktree 中，透過 hub 提供的 `dp-change-environment-checks.mjs --local-excludes-only` 只執行本機排除檢查。互動同意及寫入規則見 `environment-class2-checks.md` 的 `info/exclude`。

   Load-chain：各 stage 的判定與寫入行為、diagnostics 三分類見 `environment-class2-checks.md`；入口提示確認、回報 skipped／risk／blocked，或要新增 diagnostic 時 MUST 先讀該檔。

9. **專案依賴安裝（環境就緒後；第一個 implementation write 前）**：

   worktree 是獨立目錄——`node_modules`／NuGet 等**不**隨 `git worktree add` 複製而來。本步在 core CLI readiness（steps 1–7）與 class ②（step 8）完成後、Playwright local-package gate 之前執行。

   **Link／reparse 前置（MUST，先於任何 install）**：偵測目標依賴目錄（至少 `node_modules`；.NET 若採共用 cache 路徑同理）是否為 symlink／junction／reparse point／指向他處的 link。若是 → **MUST NOT** 執行 `npm ci`／等價刪裝、**MUST NOT** `rm -rf` 該目錄；回報 `blocked: project-deps not verified — dependency dir is link/reparse`（或等價）並依 `ai-autonomy.md` Stop-Point 交回使用者手動解除連結後再重跑。

   **偵測＋指令**：

   - Node：
     - `package-lock.json` 或 `npm-shrinkwrap.json` → `npm ci`
     - `yarn.lock` → `yarn install --frozen-lockfile`（或等價 immutable；yarn 版本差異以專案文件為準）
     - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
     - 僅 `package.json` 無 lock → 記 `N/A: no lockfile` 或 Ask First 的 `npm install` 邊界
     - **MUST NOT** 對 yarn／pnpm lock 執行 `npm ci`（會失敗並誤標環境 not verified）
   - .NET：存在 `*.sln` 或 `*.csproj` → `dotnet restore`。
   - 其他棧／皆未命中 → `N/A`＋一句偵測依據。

   **MUST NOT**：以 junction／symlink／hardlink 共用主 checkout（或其他 worktree）的依賴目錄作為標準或建議路徑；裝不起來時改走 blocked／`not verified`，禁 workaround。

10. **Playwright 安裝檢查**：

   偵測：在 worktree 根目錄跑 `node .devpro/scripts/detect-playwright-projects.mjs`（讀 `git ls-files` 的 tracked 檔，含子目錄；跨平台，不依賴 shell 引號），依輸出 `status` 判定：

   - Node 訊號：任一層 `playwright.config.*`（`declared: false`），或 `package.json` 的 `dependencies`／`devDependencies` 含 `@playwright/test`/`playwright`；`scripts`、`overrides` 等其他欄位不算
   - .NET 訊號：任一層 `*.csproj` 或 `Directory.Build.props` 的 `PackageReference` 含 `Microsoft.Playwright`（前綴匹配，涵蓋 `.NUnit`／`.MSTest`／`.Xunit`／`.Xunit.v3`）；註解內的不算

   - `none` → `Playwright: N/A（已查 tracked playwright.config.*、package.json、*.csproj、Directory.Build.props）`。N/A 只代表上列訊號未命中，Python／Java 版不在偵測範圍；「根目錄沒有 Node 專案」MUST NOT 當成 N/A 依據。
   - `not-verified` → 有 manifest 讀不到或解析失敗（列在 `unreadable`；`*.csproj`／`Directory.Build.props` 只驗 tag 與 attribute 語法，不是完整 XML 驗證），MUST NOT 回報 N/A；回報 `Playwright: not verified（<路徑>）`，blocked；`projects` 非空時仍逐一跑下方 gate
   - `detected` → 逐一對 `projects` 跑下方 gate，回報帶專案路徑。step 9 在 worktree 根目錄執行，子目錄專案的依賴本步不代裝。

   **Local package gate（Node）**：在命中專案目錄執行 `npx playwright ...` 前必須驗證 `node_modules/.bin/playwright` 存在（workspace 可由上層目錄提供，到 repo root 為止）；缺包時 `npx` 會 fallback registry fetch（non-TTY 假設 yes），違反契約。

   - local 已 install（含只有 `playwright.config.*` 但上述路徑有 CLI）→ 在該目錄跑 `npx playwright --version`、`npx playwright install --with-deps`、`npx playwright install --list`；失敗 blocked
   - 已宣告但依賴未裝 → 禁 `npx playwright`；回報 `Playwright: <專案路徑> 依賴未裝，先在該目錄安裝依賴`，blocked
   - 未宣告（只有 `playwright.config.*`）且上述路徑都沒有 CLI → 禁 `npx playwright`；回報 `Playwright: local 缺失，先 npm i -D @playwright/test`，blocked

   **Local package gate（.NET）**：`playwright.ps1` 由 `dotnet build` 產生在命中專案的 `<輸出目錄>`（`bin/<Configuration>/<TFM>/`），step 9 的 `dotnet restore` 不會產生；執行前必須驗證該檔存在且 `pwsh` 在 PATH。

   - 兩者皆在 → `pwsh <輸出目錄>/playwright.ps1 install --with-deps`、`pwsh <輸出目錄>/playwright.ps1 install --list`；版本取自 `dotnet list <專案> package`（官方文件未列 `playwright.ps1` 的版本指令）；失敗 blocked
   - `playwright.ps1` 缺失 → **MUST NOT** 自動 build，也不得改走其他下載路徑；回報 `Playwright: <專案路徑> 未 build，先 dotnet build`，blocked
   - `pwsh` 缺失 → **MUST NOT** 自動安裝 PowerShell；回報 `Playwright: 缺 pwsh，先安裝 PowerShell`，blocked

   AI **不可**自動新增或升級 Playwright npm package 或 `Microsoft.Playwright` NuGet package（仍依 `third-party-packages-licensing.md` Ask First）。

11. **Baseline `.gitignore` 衛生檢查**（warn-only，不 block 後續 step）：

   Devpro-managed `.gitignore` baseline SSOT：`.devpro/agent-rules/gitignore-alignment.md`。

   environment setup 只提示/引用；**不**自動寫入 `.gitignore`，也**不**把 `.gitignore` 修正當成本 flow 的 commit 工作。缺少 managed block 或疑似 drift 時列 `[WARN]`，修正路徑是走 `rules-flow.md` 的 sync-rules 專用分支：

   ```
   [WARN] .gitignore Devpro-managed baseline missing/stale.
   參考：.devpro/agent-rules/gitignore-alignment.md
   修正：跑 sync-rules；由 `sync-agent-rules.mjs --sync` 建立/更新 managed block。
   ```

   `.gitignore` 不存在時 → 提示 sync-rules 會建立（非 fail）；continue 後續 step。

**回報格式**：`node -v`、`npm -v`、`gh --version`、`gh auth status`、runtime auto-compact 狀態（applied / skipped / already suitable / runtime N/A）。skipped/risk 時 MUST 附 stdout 對照表（WINDOW/PCT/effective 與 Codex limit 的 current vs recommended）；`skipped-without-table is not environment-complete`。MUST NOT report skipped as applied。另附 Playwright 狀態（專案路徑 / 版本 / install / blocked / N/A＋偵測依據）、fallback 路徑（若有）、風險評估（有/無 + 一句原因）。

## Exit Criteria

- `node -v` / `npm -v` 輸出版本，且 major 與 `.nvmrc`（若有）相容，**且** `node -v` 滿足本 flow 工具 engines 下限（目前 openspec `>=20.19.0`）；Node `<20.19.0` 不得判環境完成
- `openspec --version` 輸出版本，且執行期未因 Node 低於 floor 而 crash（僅有全域安裝成功不算）
- `gh --version` 輸出版本且 `gh auth status` 已認證
- 使用者本機 runtime auto-compact 設定已檢查；需修復時已先問後寫，或以 skipped/fail-open 回報並附 current vs recommended 對照表（無表則不算完成）
- 若 Playwright 宣告：每個命中專案的 gate 指令（Node 3 條 `npx playwright`／.NET 2 條 `playwright.ps1`）已完成 或 blocked 已回報
- 回報已附：版本、fallback 路徑（若有）、風險評估

**必停條件**：`node` / `npm` 無法執行；Node major 完全不相容；`node -v` 低於本 flow 工具 engines 下限（目前 openspec `>=20.19.0`）且經說明後未以 nvm（或等價）HELP INSTALL 補齊；`openspec` / `gh` 無法安裝且無替代方案；Playwright 宣告且本次任務需要但 install 無法完成。未達 floor 時主路徑＝說明缺口＋以 nvm **協助安裝**建議版本；**MUST NOT** 把 npm `engine-strict` 硬擋當成本 flow 預設修好定義或默認擋牆。

## Common Rationalizations

N/A — 本流程為強制環境初始化，無合理跳過理由。

## Verification

```
nvm --version
node --version
npm --version
openspec --version
gh --version && gh auth status
node .devpro/scripts/dp-change-environment-checks.mjs
node .devpro/scripts/detect-playwright-projects.mjs
# 以下三條僅在命中專案目錄且 local node_modules/.bin/playwright 存在時執行（避免 npx auto-fetch from registry）
npx playwright --version
npx playwright install --with-deps
npx playwright install --list
# 以下兩條僅在 playwright.ps1 已由 dotnet build 產生且 pwsh 在 PATH 時執行
pwsh <輸出目錄>/playwright.ps1 install --with-deps
pwsh <輸出目錄>/playwright.ps1 install --list
dotnet list <專案> package
```

`.gitignore` baseline 內容驗證由 `sync-agent-rules.mjs --check` 負責；本 flow 只回報 warn-only 狀態與 SSOT 路徑。
