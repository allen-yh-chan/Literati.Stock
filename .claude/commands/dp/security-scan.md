---
description: "執行 CodeQL 安全掃描並產生 HTML 報告（AGENTS.md §1c）"
---

STOP — 先用讀檔工具讀取 `AGENTS.md` 全文，確認行為邊界與本次相關章節。

接著讀取 `agent-rules/security-scanning.md` 全文（consumer repo 路徑為 `.devpro-agent-rules/agent-rules/security-scanning.md`）。

讀完後，依下列流程執行：

## 1. 前置檢查

- 確認 consumer repo 有 `.github/workflows/codeql.yml`（若無 → 提示使用者先跑 `/dp:setup-ci codeql`）
- 確認 `gh` CLI 已登入（`gh auth status`）
- 確認 self-hosted runner 在線（若 workflow 需要）：`gh api repos/:owner/:repo/actions/runners`

## 2. 觸發 CodeQL workflow

```bash
gh workflow run codeql.yml
```

取得最近一筆 run ID：

```bash
gh run list --workflow codeql.yml --limit 1 --json databaseId --jq '.[0].databaseId'
```

## 3. 等待完成

```bash
gh run watch <run-id> --exit-status
```

- 綠燈 → 進 step 4
- 紅燈 → 取 log 給使用者看（`gh run view <run-id> --log-failed`），停下請使用者判斷

## 4. 下載 SARIF artifact

```bash
mkdir -p codeql-results
gh run download <run-id> --name codeql-results --dir codeql-results
```

SARIF 檔通常在 `codeql-results/csharp.sarif`（其他 language 對應檔名）。

## 5. 產生 HTML 報告

```bash
node .devpro-agent-rules/scripts/sarif-report.mjs \
  --sarif codeql-results/csharp.sarif \
  --source-root . \
  --project "<consumer-repo-name>" \
  --out docs/codeql-YYYY-MM-DD.html
```

（`--out` 省略時 script 自動以 `docs/codeql-<本地日期>.html` 命名並覆蓋同日檔案）

## 6. 報告摘要

讀 script 輸出的 severity 計數（error / warning / note），以及 finding 總數，給使用者：

- **error + warning 皆 0** → 回報「掃描通過」
- **error > 0** → 回報「掃描發現 Critical/Error 議題 N 件」並附 HTML 路徑；依 `security-scanning.md` 三時機點決定是否 block 後續動作（例 release 線強制時 block、pre-PR 建議時提示）
- **僅 warning/note** → 回報「掃描無 Critical 但有 warning N 件」

## 7. 提示後續

- HTML 路徑：`docs/codeql-YYYY-MM-DD.html`（可用 `open` / `code` 打開）
- 若 consumer repo 採 committed history 策略（預設），提醒使用者本次報告應 commit 到 repo
- 若屬 pre-PR 建議時機，提醒在 PR 描述加入「已跑 CodeQL 掃描」與結果摘要

## 錯誤處理

| 情境 | 處置 |
|---|---|
| `codeql.yml` 不存在 | 停下，請使用者先跑 `/dp:setup-ci codeql` |
| `gh auth status` 失敗 | 停下，請使用者 `gh auth login` |
| self-hosted runner 離線 | 停下，請使用者確認 runner 狀態；不自動改 `runs-on` |
| `gh run watch` 逾時 | 回報當前狀態；詢問使用者是否繼續等或 abort |
| `gh run download` 找不到 artifact | 確認 workflow 是否成功產出 `codeql-results`；檢查 workflow YAML `upload-artifact` 步驟 |
| `sarif-report.mjs` 執行失敗 | 回報 stderr；常見原因：SARIF 路徑錯、檔案非 v2.1.0 格式、`--out` 目錄建立失敗 |

## 禁止事項

- **禁止**跳過 `gh run watch`（需確認掃描實際完成，不可憑空假設成功）
- **禁止**把 `codeql-results/` 原始 SARIF commit 進 repo（尺寸大且非人類可讀；應加入 `.gitignore`）
- **禁止**用這個 command 當 PR gate（自動 block merge）— gate 由 consumer repo 自行決定是否加 workflow trigger
