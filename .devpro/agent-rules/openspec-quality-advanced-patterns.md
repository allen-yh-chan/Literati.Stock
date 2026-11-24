---
name: openspec-quality-advanced-patterns
description: OpenSpec 進階模式細則：Diagram / Mermaid Evidence 製圖規範、Archive-Time Task Split（archive-before vs archive-after 任務分類），以及證據時序（守門重跑判準、archive gate 必須跑在 promote commit 之後）；觸發：新增 Mermaid / 架構圖時 / 設計 tasks.md archive 前後分類時 / 守門通過後又改 delta 或 archive 未 commit 時。
---

# OpenSpec Advanced Patterns

> Load-chain：本檔由 `openspec-quality-and-formats.md` 按需載入；entry leaf 只保留 Tasks 品質 / Spec Delta / Rule-feedback Matrix，Diagram 製圖規範、Archive-Time Task Split 與證據時序在此。

### Diagram / Mermaid Evidence

OpenSpec / README / design doc 若新增 Mermaid 或架構圖，diagram 是 evidence artifact，不是裝飾。寫入前必須：

1. **Source-grounded**：列出 diagram 依據的 source files / config / requirement / assumption；禁止憑想像畫「看起來合理」的架構。
2. **Type-scoped**：只載入與圖型相關的 guide/template（sequence / activity / architecture / deployment / design-doc template）；不要為單張圖載完整 reference tree。
3. **Validate-before-finalize**：若本機有 Mermaid validator / renderer（如 `mmdc` 或既有 repo script），先驗證語法再把圖當成完成證據；沒有 validator 時明示 `unvalidated`，不得聲稱已 render-safe。
4. **Readable contrast**：自訂 `classDef` / `style` 顏色時，必須指定可讀文字色或維持預設；避免低對比圖在 review / docs 中失真。
5. **No asset churn**：除非使用者要求圖片輸出，預設只提交 source markdown / mermaid；不要新增 generated PNG/SVG。

### Archive-Time Task Split

`openspec archive <name>` CLI 對 `tasks.md` 內未勾選的 task 會 emit `Warning: N incomplete task(s) found`。Tasks 設計時必須明確區分 **archive-before**（archive 前必須勾完）vs **archive-after**（archive 後才能完成）兩類，否則會撞到「勾選 → 尚未完成卻 mark done」或「不勾 → archive 帶 incomplete-task warning」的雙重死角。

**Archive-before tasks（archive 前必須勾完）**：
- 寫 spec deltas / requirement / scenario / capability
- 寫 / 改實作程式碼
- 跑專案測試（unit / integration / E2E）+ 產出 `qa-test-scope.md`
- `devpro:pre-pr` step 1-3 (testing / simplification / scenario walkthrough)
- dp-reviewer 六軸 spec freeze
- decisions.md 紀錄
- PR-ready handoff artifacts 準備（PR title 草稿、PR body 框架、required reviewers 名單、CI 預檢命令）

**Archive-after tasks（archive 後才完成；放 follow-up checklist 或不入 tasks.md）**：
- `git commit` archive commit
- `git push`
- `gh pr create`
- GitHub Issue / Program Issue tracker update（PR URL、Project field、parent dashboard sub-issue link）
- Workflow watch + CI 終態觀察
- Session Recap → GitHub Discussion
- Post-PR cross-model review dispatch + sticky update

**範例 wording 對照**：

| 反模式（會撞 incomplete-task warning）| 推薦 wording |
|---|---|
| `T7: commit + push + draft PR` | `T7: PR-ready handoff artifacts`（在 task 內列：PR title 草稿、PR body 框架、依賴 spec 標註；archive 後再做實際 git push / gh pr create） |
| `T8: 在 GitHub project 標 phase 完成`（consumer repo only） | `T8: phase 完成證據準備`（archive-before：列 PR link 預期格式 / project field 待更新清單；archive-after：真正去 update GitHub project field） |
| `T9: post-merge 收尾` | `T9: Session Recap 草稿`（archive-before：寫 recap draft；archive-after：archive + PR merge 後貼到 GitHub Discussion） |

**why this split matters**：openspec archive 走後，tasks.md 已被搬到 `openspec/changes/archive/<date>-<name>/tasks.md`，**不再可勾選**——任何 archive-after 工作只能在 PR body / parent Program Issue dashboard 追蹤，不能事後回去勾 archived tasks。預先 split 避免 archive 時的反射「先勾再說」或「事後 amend archive commit」兩種錯誤路徑。

### 證據時序

本節是 `openspec-quality-and-formats.md` §Tasks.md 品質要求「證據 MUST 能被事後獨立覆核」的**時序**面：錨點選對了，但量測跑在**不是最終送出的那份狀態**上，證據同樣無法覆核。兩個形狀——

**量測跑在非最終內容上**：**守門的通過只涵蓋它實際讀到的那份內容**。任何守門／`openspec validate --strict`／lint 之後又編輯 delta（補 `## Removed Scenarios`、改 wording、增刪 scenario、unwrap 行），先前 exit 0 **MUST NOT** 充當最終證據，**MUST** 重跑；判準是「跑的那份是不是最終送出的那份」，不是「跑過了沒」。evidence：`amend-second-review-handoff-field-contract` tasks T3 記 strict validate exit 0，事後對最終 delta 重跑 `lintModifiedScenarioPreservation` 得 `pass=false` 並具名兩條 scenario——守門本身無缺口，是證據跑在非最終狀態。

**量測跑在 commit 之前**：**archive gate MUST 跑在 archive/promote 已 commit 之後**。gate 判定 relevant archive 時看得到未 commit 的 folder，下游檢查卻只讀 committed state，promote 未 commit 時兩者答案相反——gate 會綠，但綠的是不含 promote 的狀態。同一個 ordering 錯誤有**兩個受害者**：check (i) 的 changed-spec 清單取自兩點 committed diff，故為空而靜默跳過比對；cadence (f) 找不到 archive folder 的 introduction commit 而回 `indeterminate`。修正固定為先 commit 再重跑，**不得**以「跑過了」宣告通過。

**證據行表徵（pointer）**：內嵌於證據行、會隨後續 commit 漂移的量測值同受 currency 約束；表徵規則 SSOT 見 `openspec-quality-and-formats.md` §Tasks.md 品質要求，本節只承擔時序面、不複寫該條文。
