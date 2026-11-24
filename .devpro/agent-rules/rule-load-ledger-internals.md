---
name: rule-load-ledger-internals
description: Session rule-load ledger 的機制細則：PreToolUse 記錄來源與 host tool mapping、lifecycle（reliable／unknown）與 SessionStart 行為、duplicate full read hard block、partial／full coverage、何時可重讀、手動 session reset、host 診斷。觸發：讀 rule leaf 被 duplicate hard block 擋下、ledger 記錄異常要診斷、要手動校正 ledger、或設計／審查 rule-load ledger hook 時。
---

# Rule Load Ledger Internals

> Load-chain：本檔由 `token-frugal-io.md` §Rule Load Ledger Gate 的 Load-chain（session ledger 機制）行按需載入；平常載入 rule leaf 只需該段的記錄規則（何時記 ledger、已載入未變更不重讀、CLI 用法），不必讀本檔。

Session rule-load ledger 是 source-aware gate + telemetry，state 依 runtime session identity 分檔：

- PreToolUse 在 compatible shell-command 讀取 `.devpro/agent-rules/*.md` 前記錄正常 `cat` / `sed` / `nl` / `head` / `tail` / `less`，並在 native `Read` payload 提供 `tool_input.file_path` / `filePath` / `path` 指向 `.devpro/agent-rules/*.md` 時記錄該 leaf，讓 rule text 進 context 前已有 ledger。
- runtime shell/read tool name 必須有 live host evidence；已驗證 mapping 由 active platform adapter 維護，例如 shell-command tool 可是 `Bash` 或 `functions.exec_command`，native read tool 可是 `Read`，裸 `exec_command` 未經 live host 證實時不得要求 matcher。
- 若 live session 顯示 SessionStart 已 reset ledger 但真實 rule-read 後 ledger 仍空，修復前 MUST 先加 bounded host diagnostic log，證明 PreToolUse 是否被觸發、實際 `tool_name` / command 或 file-path 欄位 / session identity / extracted refs / recorder decision；不得只用 simulated payload POC 宣告 host runtime 已驗證。
- PostToolUse 不作為 rule-load recording 權威來源，也不得 double-count PreToolUse 已記錄的 read。
- redirect / pipe 不視為 full context load；native `Read` 無 offset/limit 視為 full coverage，有 offset/limit 視為 partial。
- PreToolUse 在同 session ledger 的 lifecycle=`reliable` 且同 context epoch 內重複 full read 未變更 leaf 時 hard block，並列 duplicate bytes/tokens，避免相同 rule text 再進 context。
- lifecycle 只有 `reliable` / `unknown`：SessionStart 有 supported source 且有 session identity 時，`clear`/`startup` reset，`compact` 只 advance epoch，`resume` preserve existing lifecycle（reliable stays reliable；unknown stays telemetry-only）；missing/unsupported source 但有 session identity 時為 `unknown`，只記 telemetry、不 advisory、不 block；runtime 無 session identity 時不寫 shared ledger、不啟用機械 duplicate block。
- partial read 不覆蓋後續 full read；檔案 hash 已變、使用者要求重驗、或 context 確認遺失可重讀。
- 手動校正必須顯式指定 target：`node .devpro/scripts/rule-load-ledger.mjs --session-reset --reason "<why>" --session-id "<id>"` 或 `--state-file <path>`（必填 reason、寫 audit；不猜 current session）。
- 不要用 runtime `context used %` 判斷 ledger lifecycle；該值不保證進 hook payload。
- native Read 未送出可解析 file path payload 時以 CLI ledger + TL 自律補足，不宣稱全覆蓋。
