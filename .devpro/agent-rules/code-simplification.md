---
name: code-simplification
description: 程式碼簡化 pass 規則：過深巢狀、過長函式、死碼、重複邏輯、命名、過度防禦 hack，以及 Match existing style 範圍界定。觸發：PR 前六軸 review 之前、使用者要求「簡化／重構／clean up」時。
---

# Code Simplification（程式碼簡化）

## Overview

簡化 pass 是獨立於功能實作的必做檢查。目標是讓下一個讀這段程式碼的人能更快理解，不是追求最短字數。**簡化必須和功能變更分開 commit**（`chore: simplify <scope>`），方便 review 和 rollback。有疑慮時（不確定某段是否為死碼），先問使用者再刪。

## When to Use

- PR 前、六軸 review 之前，作為獨立的簡化 pass（所有功能實作完成、測試全綠之後執行）
  - **單檔且 diff < 200 行 → 降級**：可省略 simplify skill 多 agent fanout，由 `devpro:pre-pr` Step 3 dp-reviewer 軸 2（可讀性/架構/重複）涵蓋；或 TL 自做 grep-based 抽查。理由：simplify 與 reviewer 軸 2 重疊度 > 70%，小 diff 雙軌跑屬重複付費。
- Review 過程中發現 Important 等級的可讀性/架構問題時
- 使用者明確要求「簡化」「重構」「clean up」時

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for semantic execution |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


### Reader Load and Behavior Preservation

先評估兩個獨立負擔：理解行為要追蹤層數，以及同時記住的隱藏／可變狀態。MUST NOT 僅因 caller 數或重複次數強制拆合；共享的是 invariant／知識，不是文字相似度。單一 caller 的政策、安全或協定邊界可以有價值；更短但多層 pass-through 不自動更簡單。

重構 MUST 先固定可觀察行為，以 characterization／既有契約測試或可重跑的等價案例 pin 住輸入、輸出、錯誤與必要副作用；改後驗等價及上述閱讀負擔如何改善，不混入新功能或順手 bug fix。安全／授權／相容性 guardrails 保留。

Characterization 也核對邊界輸入的錯誤種類與檢查順序。發現既有缺陷或「新結構比較安全」時，MUST 先裁決契約與現況的差異，不得自行把已知缺陷修復夾進純重構；已授權修復須分清其行為差異與驗證，未授權則保留可獨立的等價重構並回報，不用「兩者都拒絕」合理化錯誤契約改變，也不為守舊而放寬安全 gate。

TL 的技術裁決不等於使用者授權：超出純重構的行為差異 MUST 取得使用者明示決定後才套用；「更安全」「實務不可達」不能代替同意。有安全疑慮則停下該差異、保留未改的現況供決策，不自行放寬或收緊原契約。

### 六項簡化檢查

1. **過深巢狀**：超過 3 層 `if`/`for`/`try` 巢狀 → 考慮 early return、guard clause、或抽取方法
2. **過長函式**：超過 50 行 → 評估閱讀負擔與職責；流程已清晰可保留，不為行數製造跳轉或註解
3. **死碼**：註解掉的程式碼區塊 → 刪除（靠 git 歷史追溯）；未被呼叫的 private 方法 → 刪除；不可達分支 → 刪除
4. **重複邏輯**：兩處以上相似邏輯 → 評估是否共享同一 invariant／知識及 owner；集中真正共變的知識。若抽取增加跳轉、耦合不同語意或隱藏狀態，保留局部重複並說明取捨；第三處也不自動強制抽取
5. **命名**：不能反映用途的變數或方法名稱 → 重新命名；布林應能讀成「是否 XXX」（`isValid`、`hasPermission`、`CanExecute`）；避免縮寫（除領域內公認縮寫如 `Id`、`Url`、`Http`）
6. **過度防禦的 framework hack**：「為了保險而手動 X」的程式碼（手動 cache invalidation、touch、flush、cleanup 等）→ **必須**有證據證明 framework 沒處理該情境（程式碼位置／官方文件連結／integration test 結果）；無法提供證據 → 必須刪除；有證據則在上方加 `// Reason: <framework 沒處理 X 的證據>`

### Match Existing Style（風格順序）

1. **規範已明示的項目**（K&R 大括號、C# 現代語法、正體中文註解等）：以規範為準；但**不**在當前 task 順手糾正既有違反——另開 `chore/align-style-<scope>` 處理
2. **規範未明示的格式偏好**（引號風格、空行配置、using 排序、member 排序等）：一律跟隨該檔案既有程式碼
3. **禁止**：在 bug fix / feature PR 內順手改引號、空行、import 順序、`var` vs 顯式型別等與功能無關的變更（drive-by refactor，見 `anti-patterns-design.md` §1）

**簡化 pass 結束後**跑 `git diff` 逐行確認——每一行變更能追溯回本次 task 的功能目標或明確簡化項目；不符的部分**還原**。

### Touch-scoped formatting（#2482）

格式化工具（prettier／eslint --fix／dotnet format／同等）的寫入範圍 **MUST** 收斂到本次觸及檔：

1. **預設**：由 `git diff --name-only`（必要時再加 working-tree 已改路徑）產生清單再傳給 formatter；**禁止**寫死寬 glob（例：`src/**/*.ts`）無聲重排無關檔。
2. **全庫／寬範圍格式收斂**（刻意的 debt payoff）：MUST 獨立 commit，並在 PR body 說明範圍與理由。
3. **格式化後**：確認 `git status --porcelain` 的檔案集合與預期觸及集合一致；多出的無關檔 MUST 還原後再 commit。
4. **委派**：dispatch 格式化時，briefing／`exact_instructions` MUST 明示 touch-scoped 邊界（見 `model-delegation-briefing.md`）。

對照：`devpro:pre-pr` Spec EOF 自癒同樣要求三點 diff 外的改動獨立 commit——格式化適用同一紀律。

### 物理切分例外（hunks 互纏 case）

**規則**：當 fix / refactor / chore 在同 file 同 method 同位置之 hunks 互纏（`git add -p` 無法乾淨切分為獨立 commit 範圍），允許合併為單一 commit。**強制要求**：commit body 必須以分層 heading 描述各變更屬性，使 reviewer 可在單一 diff 中辨識三類變更：

```
fix(<scope>): <summary>

Behavior fixes (fix)：FR1, FR2, FR3, ...
Behavior-equivalent restructure (refactor)：FR4, ...
Comments / simplification (chore)：FR5, FR6, ...
```

**Why**：嚴格分 commit 在物理可分時提升 review 體驗；不可分時強行切分會引入 (a) 前後 commit 互依（commit A 編譯不過 → CI 失敗）、(b) 重複的 import / class field 改動、(c) reviewer 仍需跨 commit 還原全貌。commit body 分層描述保留 traceability。

**Anti-rationalization**：「順便 trim」「都改了」「同 commit 比較好 review」**仍**禁止——此例外**僅限**同 file 同 method 同位置 hunks 物理互纏；可分而選不分屬 `preflight-checklist.md` 點 1 延伸違反（commit-level 同範圍紀律）。

> **開工前 over-design 自檢**：見 `pre-implementation-over-design.md`（已抽離至「開工前」階段 leaf）。

## Exit Criteria

- 專案約定測試指令全綠（簡化後不能壞掉任何測試）
- 變更範圍僅限簡化，未混入功能變更
- 簡化項目已列在 PR 說明或 commit message 中（`chore: simplify <scope>`）

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「能動就好，不需要簡化」 | 能動但難讀的程式碼，下一個人維護時成本加倍。 |
| 「簡化可能引入 bug」 | 所以簡化後必須跑測試。測試全綠就是安全網。 |
| 「這個重構範圍太大」 | 那就只做不需要大改的簡化（命名、early return、刪死碼）。不必一次完美。 |
| 「這行防禦性程式碼加了又不會錯」 | 加了會：(1) 擴大維護表面積、(2) 對下一個讀程式碼的人發送「這裡有隱藏需求」的錯誤訊號。先驗證 framework 是否已處理，再決定要不要加。 |

## Verification

```
# 測試全綠
# （依專案執行對應指令，見 testing-and-qa.md）

# 工作目錄 diff 確認
git diff

# 確認 commit message 格式
git log --oneline -5
# 預期看到：chore: simplify <scope>
```
