# Pre-PR Regression Scenarios

| 流程類別 | 觸發情境 | 預期結果 |
|---|---|---|
| Normal | feature 分支、tasks.md 全勾、qa-test-scope.md 已產出且 active change 尚未 archive | Step 1-5 全走完、reviewer 讀 active proposal、spec freeze 後 archive、archive gate + validate gate + lint-spec-shall-must 全 exit 0、PR 建立後**並行**跑 workflow watch 與 Step 5.5（未命中豁免則委派 devpro:second-review → sticky；兩者皆綁 merge gate，非互相前置；SSOT `post-pr-completion-gate.md` §Step 5 ∥ Step 5.5 Parallelism） |
| Existing-File | 前次 dp-reviewer 回 blocked、本輪 re-run | `retry_context.prev_critical` 載入前次 critical 清單，reviewer 比對是否解決 |
| Error | 分支前綴非 `feature/bugfix/chore/hotfix`（如 `feat/x`） | 停在 Pre-flight Check #1、回報合法前綴清單 + 要求改名 |

> 此矩陣為改本 skill 時的迴歸觀測點，協助快速辨識破壞 happy path 的修改。
