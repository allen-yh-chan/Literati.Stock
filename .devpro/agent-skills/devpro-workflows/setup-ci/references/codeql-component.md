# /devpro:setup-ci codeql

Topology note：本檔為 `devpro:setup-ci` umbrella skill 的子步驟，不是可獨立由使用者觸發的 skill/command（原始 command 來源帶有 `disable-model-invocation: true`）。只在 umbrella body 路由至此（`codeql` fast path）時才載入本檔。

用途：建立 CodeQL workflow，完成基礎設定與 smoke check。

### Required Rules

- `.devpro/agent-rules/security-scanning.md`

### Steps

1. 偵測 stack：
   - legacy csproj（dotnet-framework）
   - SDK-style csproj（dotnet-sdk）
   - 混合時停下請 user 指定主 stack
2. 詢問使用者：
   - `runs-on` label（framework 必填；sdk 可預設 `ubuntu-latest`）
   - solution path（若有多個 `.sln`）
3. 依 stack 寫入 `.github/workflows/codeql.yml`（使用對應模板）。
4. 檢查 `.gitignore`：
   - `codeql-results/` 必須 ignore
   - `docs/codeql-*.html` 不應 ignore
5. 驗證：
   - `gh workflow list` 應看見 CodeQL workflow
   - 提醒 user 執行 `gh workflow run codeql.yml` 做 smoke test
