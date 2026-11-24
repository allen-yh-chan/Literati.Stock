---
name: post-pr-stop-hook-runtime
description: Post-PR completion Stop hook 的執行期細則：整輪時間預算（協作期限／硬上限／送達範圍）、owned PR scope 細則、三行輸出與診斷檔、明確接手、退場入口。觸發：Stop hook 擋下或提醒時要解讀診斷、接手其他 session 的 PR 提醒、或設計／審查 Stop hook 行為時。
---

# Post-PR Stop Hook Runtime

> Load-chain：本檔由 `post-pr-completion-gate.md` §Execution Location 按需載入；「先以 session ID 選定 owned PR 再驗」的 ownership 規則與 gate 條件留在該檔。未遇到 Stop hook 擋下／提醒、也不需接手或退場時不必讀本檔。

### Time Budget

Stop hook 每輪有兩道期限，都從 launcher 上限（`DEVPRO_HOOK_TIMEOUT_MS`，預設 180 秒）往內推導，環境變數只能縮短、不能延長：協作期限預設 150 秒、硬上限預設 165 秒。

- **協作期限**（hook 自己以單調時鐘計時）：每個 marker 開始前剩餘不足 5 秒，該 marker 與其後全部原樣保留（不清除、不判定、不標記已提醒），hook 保留原 gate 決策，以三行 AI 指令指向診斷；診斷中的 `### Post-PR completion check time budget exhausted` 列出精確的 owned 未處理 PR 清單。沒有可證明 owned 的 pending marker 時保持靜默。
- **硬上限**（外層監督程序強制結束 worker）：用於單一 marker 內同步卡住（例如本機 git 或檔案讀取無回應）而協作期限碰不到的情況。三行 AI 指令指向診斷中的 `### Post-PR completion check hard time limit reached`（或 worker 被訊號結束、無法啟動時的 `could not be completed`）；診斷只給一般訊息，不列 PR 清單；被結束那一刻仍在磁碟上的 marker 原樣保留。
- 兩種擋下共用保留 key `__stop_time_budget__` 與 30 分鐘內第 2 次降為 soft reminder 的規則；soft reminder 不代表狀態已解除。AI MUST 先讀診斷並依既有授權繼續可處理的工作；只有需要使用者決策時，才依 `stop-point-comms.md` 整理交棒，不把 hook 文字當使用者提示。

送達範圍（條件句，非保證）：擋下訊息**預期**送達的前提是該 host 自己的 Stop 逾時大於硬上限；launcher 上限依構造大於硬上限，且適用於所有經 launcher 啟動 hook 的 host；文件載明 Stop 預設逾時為 600 秒的 host 也大於硬上限。三個 host 設定的 Stop 條目不得設定小於 190 秒的 `timeout`。**任何 host 都尚未實測**硬上限情境下的送達；Stop 逾時沒有文件載明的 host，送達沒有依據。連監督程序本身也被卡住的檔案系統停滯，以及監督程序自己被訊號結束，仍回到 launcher 既有的放行行為。

### Execution Location（細則）

自己的 PR 即使切回 main 仍在 scope；AI 依診斷中的 branch/change 指向正確 worktree，不把 location mismatch 當作通過。每個 session 的 subscription／remindedAt 分開持久化；同一 PR 的 shared authority 不被另一 session 寫入覆蓋。只有符合 `post-pr-completion-gate.md` §Execution Location ownership 規則及 §Shared Gate evidence 規則的實際 PR 驗證，才能清 shared authority；已證明 owned 且即讀 PR state 確為 `CLOSED` 時，MUST 先評估／記錄最後一輪 cost 與 override disclosure，再取消該 PR 的 review obligation及清 round state；既有 cost/disclosure blocker／advisory 仍須在本次 scoped diagnostic 揭露，明示 canceled，不宣稱 merge 完成（不等同 reviewer 的 closed-terminal receipt）。Stop 不做外 session 的 merged self-heal／全域 evidence pruning；targeted merge gate 仍直接驗目標 PR，不受提醒 scope 影響。

輸出最多三行：AI pending/block 摘要、下一動作、session 診斷檔路徑（`Details` 相對於本次 hook event/runtime cwd；AI 必須從該 cwd 解析，即使下一個 shell 的 cwd 已切換）。完整 blocker／gate 條件／多筆清單放診斷檔；AI MUST 先讀檔再行動，有使用者決策才由 assistant 自行整理交棒，hook 不直接塞人類選項。診斷檔 mkdir/write 失敗時仍保留既有 gate 決策，第三行明示 unavailable／錯誤碼，不以診斷失敗吞掉已證明 owned 的 block；ownership 尚未可證明時仍不阻擋 foreign／missing-ID。真正 own-session blocking gate 即時執行；soft loop guard 仍保留，但不表示 gate 已解除。

明確接手：`node .devpro/scripts/adopt-session-reminder.mjs --pr <number>`（本 session 的 trusted ID 必須存在）；只增加本 session subscription，不偷走原 session。新 session 不自動繼承；相同 ID resume/compact 延續。legacy marker 須明確接手才能提醒。

退場入口：actual owner Stop 依 `post-pr-completion-gate.md` §Shared Gate 驗證 `MERGED`／completion evidence 或確認 `CLOSED` 後退休；新 session／legacy authority 先用上述 `adopt-session-reminder.mjs --pr <number>` 明示接手，再由 owned Stop 驗證。既有非 Stop 入口（PR-sticky renderer、targeted merge gate）呼叫 marker inventory，保留超過兩小時且無 dispatch binding／lineage obligation 的 expiry；Stop 使用 `pruneStale: false`，不執行外 session 清理。每次 verified clear／CLOSED cancellation／非 Stop expiry 只刪 exact retired authority generation 的 PR `.sessions` subscriptions，保留不同 generation、其他 PR 與不可判讀記錄；與 subscription／remindedAt writer 共用該 PR CAS lock。dispatch-bound 或 lineage-obligation authority 不以 age 自動退休。CLOSED 後 reopen 不自動重建 Stop obligation；新的具名 PR review flow 可建立新 authority，targeted merge gate 仍獨立驗 current-head sticky。
