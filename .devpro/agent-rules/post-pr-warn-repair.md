---
name: post-pr-warn-repair
description: Post-PR 得到 WARN 或 archive 後被 cross-model 指出需修復時的處置：WARN Decision Contract（收斂即接受 WARN、未收斂才 fix-to-PASS 的選項排序）與 post-archive rule／code／test 載體修復的證據對齊。觸發：Ready Response 為 ready-with-warning、或 PR 開出後 cross-model 在 archive 後指出載體修復時。
---

# Post-PR WARN And Post-Archive Repair

> Load-chain：本檔由 `post-pr-completion-gate.md` §Ready Response Next-Step Contract 按需載入；Ready Response 必備欄位、`ChangeContext`／`ManualTest` 與記帳類的「Post-archive 修復落點」留在該檔。cross-model 為 PASS／exempt 且 archive 後無修復時不必讀本檔。

**WARN Decision Contract（收斂即接受 WARN；未收斂才 fix-to-PASS）**：當 `Status: ready-with-warning` 且下一步是 merge authorization 或 user decision 時，回覆 MUST 用三選一的 stop-point options，**選項 1 由收斂謂詞決定**：post-archive cross-model **round ≥2** 且本輪 **Critical=0** 且相對上輪 **無新 rule/code finding**（test carrier 同計；純 `change-folder-bookkeeping` finding 或 test-hardening Suggestion 不算新 finding，定義與排除對齊 `code-review-cross-model.md` §Round Budget carrier class）三條件同時成立時，選項 1 MUST 是「接受殘留 WARN 風險，進入 merge 決策」，選項 2 才是「先修到 PASS 並重跑 `/devpro:cross-review <PR#>`」；三條件任一不成立（首輪、有 Critical、rule/code carrier 有新 finding）則選項 1 為「先修到 PASS 並重跑 `/devpro:cross-review <PR#>`」、選項 2 為接受殘留 WARN。選項 3 為「其他（例如 tracked-follow-up）」。round 計數、cap 3 與具名 override 見 `code-review-cross-model.md` §Round Budget。同時，使用者端的 `ChangeContext:` MUST 以白話說明 WARN evidence-backed 原因（來自 sticky/second review 的 `reason`）。

**Post-archive 載體修復的證據對齊**：PR 開出後，cross-model 在 archive 後指出的 rule／code／test 載體修復（非記帳類，`post-pr-completion-gate.md`「Post-archive 修復落點」不涵蓋）直接在同一 branch 修，不 re-archive、不重開 primary 六軸——behavior／scope 沒變。primary final evidence 仍綁 archive 後的 reviewed HEAD；`classify-final` 在修復 commit 之後回 `full_reopen_required`（且無 `archive_transition_unsealed` 診斷）是預期輸出，不是重開指令。merge 證據改由兩項承擔：(1) 重跑 canonical suite 後執行 `record-regression-head` 記錄修復 HEAD（`test-suite-cadence.md` §Merge evidence 形 (1)）；(2) 修復 HEAD 上的 current-head cross-model sticky（`focused-sticky-refresh`，依上方 WARN Decision Contract 與 Round Budget cap 3）。修復若改變 behavior、scope 或 spec delta body，不適用本段，走 pre-merge re-archive 並回 primary 六軸。
