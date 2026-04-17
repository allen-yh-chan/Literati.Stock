---
description: "PR 前檢查：測試、QA 文件、簡化、六軸審查、PR 描述（AGENTS.md §4 + §4b + §4c + §5）"
---

STOP — 先用讀檔工具讀取 `AGENTS.md` 全文，確認行為邊界與本次相關章節。

接著依序讀取以下四份檔案全文（consumer repo 路徑加 `.devpro-agent-rules/` 前綴）：

1. `agent-rules/testing-and-qa.md`
2. `agent-rules/code-simplification.md`
3. `agent-rules/code-review-checklist.md`
4. `agent-rules/git-branch-and-pr-flow.md`

讀完後，依序執行：

## 第零步：前置檢查（未通過則立即停止並回報使用者，**禁止**進入後續步驟）

1. **當前分支合法性**：執行 `git branch --show-current` 取得當前分支名。
   - **禁止**在 `main`、`master`、`integration`、`release/*`、`production` 上跑 pre-pr（這些分支不走 PR 流程）
   - 分支前綴**必須**為 `feature/`、`bugfix/`、`chore/`、`hotfix/` 其中之一
   - 違反任一條 → 停下告知使用者，建議依需求類型重開分支（走 `/dp:change`）或確認是否誤切分支
2. **工作目錄乾淨度**：`git status --porcelain` — 若有非預期的 untracked files（AI 工作過程殘留的暫存腳本、偵錯輸出等），停下提醒使用者清除
3. **Submodule 乾淨度**：`git status` 檢查 `.devpro-agent-rules` 與根層 `AGENTS.md` 沒有 uncommitted/unstaged 變更（若有，代表 `openspec-flow.md` step 1b 被跳過，必須補做獨立 `chore: sync devpro-agent-rules (<short-sha>)` commit 後才能繼續）
4. **本單位 commits 認定**：`git log <anchor>..HEAD --oneline` 確認分支上只有本單位 commits + 豁免清單（`chore: sync devpro-agent-rules`、`chore: simplify`、測試/QA 文件）。若發現 `Merge main` 或他單位 commit，**立即停止**——這是 subset 污染，需依「可促進單位的乾淨前提」處理後才能建 PR

## 第一步：§4 測試與文件（依 testing-and-qa.md）
- 執行**專案約定測試指令**（見 testing-and-qa.md「專案約定測試指令」表：.NET→`dotnet test`、Node.js→`npm test`、Python→`pytest` 等），確認全綠（建議 TDD：RED→GREEN→REFACTOR）
- Bug fix 必須有 prove-it test（修復前失敗、修復後通過）
- 若專案有定義 E2E / integration test，執行並確認全綠
- 確認測試在獨立測試專案／目錄
- 檢查或產出 `qa-test-scope.md`（含 E2E 結果或「無 E2E」註記）
- 確認 `tasks.md` 已勾選 QA 任務
- **應用程式版號 bump 檢查**（consumer repo 自身 artifact 版本；**非** AGENTS.md 規範版號。不在本 PR 內執行修改）：評估本次變更是否需要 bump（.NET 查 `Directory.Build.props` / `.csproj` 的 `<Version>`；Node.js 查 `package.json` 的 `version`；其他語言類推）。若需 bump，**不得**在當前 feature/bugfix PR 內改版號——提醒使用者獨立開 `chore/bump-v<X.Y.Z>` 分支與 PR 處理（版號變更屬 chore，應走獨立可促進單位以保持 subset 乾淨與 review 焦點）。若語境允許單一 PR 合併（小團隊／版號變更確實由本 feature 決定），須使用者明確授權並在 PR 描述欄「版號變更理由」記錄。

## 第二步：§4c 簡化 pass（依 code-simplification.md）
- 檢查過深巢狀（> 3 層）、過長函式（> 50 行）、死碼、重複邏輯、命名
- 簡化與功能變更分開 commit
- 簡化後 `dotnet test` 仍全綠

## 第三步：§4b 六軸審查（依 code-review-checklist.md）
- 逐一檢查六軸，每項標 Critical / Important / Suggestion
- Critical 全數解決前禁止建 PR

## 第四步：§5 PR 描述（依 git-branch-and-pr-flow.md）
- 產出 PR 描述草稿，包含必填欄位與條件式欄位
- 附上 Review Summary
