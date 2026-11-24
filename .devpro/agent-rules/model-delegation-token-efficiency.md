---
name: model-delegation-token-efficiency
description: Token 效率規則（a）–（k）：委派時機、分群策略、output 閾值、Reference Pattern。觸發：需查閱具體 token 優化委派細則時。
---

# Token 效率規則

> Load-chain：本檔由 `model-delegation.md` 按需載入；entry leaf 只 eager-load 委派決策速查，token 優化細則在此。

### Token 效率規則

**（a）Scenario walkthrough bash 化**：`devpro:pre-pr` Step 2.5 Assertion 驗證用 bash for-loop + `grep -c` / `grep -q` 批次驗證，不委派 subagent 逐條。Source repo 備註：若已有 `node .devpro/scripts/run-test-suite.mjs --tier all` 且涵蓋全部 assertions，可直接引用測試結果。

**（b）Worktree 隔離平行 pre-pr**：同一 session 多條分支需要 `devpro:pre-pr` 時，用 `git worktree add` 為各分支建立隔離工作目錄，平行執行，完成後 `git worktree remove` 清理。

**（c）同 session 跳過重複讀檔／續作只重讀變更檔**：同一 session 內已讀過的 `.devpro/agent-rules/*.md`，且 `git diff` 確認未變更 → 跳過重讀，直接沿用。`continue` 既有 thread 前，只把該 thread 期間被變更的 rule leaf（`git diff <thread 起始 sha>..HEAD -- .devpro/agent-rules/`）列入重讀，不換手（`replacement_reason: rule-leaf-changed` 只記錄、不 replace）。程式碼檔案不適用（可能被 subagent 修改）。

**（d）委派前驗證操作方式**：委派 subagent 執行依賴特定腳本前，先以 `test -f <path>` 或 `which <command>` 確認目標存在，避免 subagent 啟動後才發現路徑不存在。

**（e）Reviewer 分析複用**：同一 session 內 dp-analyst 可引用 dp-reviewer 先前回傳的摘要（已掃描的檔案清單、已確認的 starting state），直接沿用不重複分析。

**（f）Rate limit instant fallback**：subagent 回報 rate limit 錯誤（HTTP 429 / `rate_limit` / `overloaded`）→ TL 立即 fallback 自行執行，不重試（fault 分類見 `ai-autonomy.md` §Agent Runtime Protection Retryable row）。須遵守「Fallback 最小輸出要求」。

**（g）Scenario walkthrough 增量策略**：`devpro:pre-pr` skill Step 2.5 範圍決定——先 `git diff <target-base-ref>...HEAD --name-only`（三點；或等價 merge-base→HEAD diff）取 PR file scope 變更檔案清單，僅 walk 其 rule ref 涵蓋到變更檔案的 scenario；無匹配靜默跳過。安全網：全部 assertions 仍由 canonical full suite `node .devpro/scripts/run-test-suite.mjs --tier all` 涵蓋，增量策略僅縮減 subagent 逐條閱讀範圍。

> **User-decided opt-out 適用（(a)(g) 共用）**：使用者於 `AskUserQuestion` 選擇跳過時，(a) assertion bash 驗證的 dp-assistant 委派不觸發、(g) 增量策略 walkthrough 整段不觸發；opt-out 條件與記錄義務見 `devpro:pre-pr` skill 第二點五步。`node .devpro/scripts/run-test-suite.mjs --tier all` 機械 assertion 不受影響。

**（h）大規模 Edit/Write 任務分群評估**：預估**≥6檔**或**>50K bytes context**只觸發分群admission；先證明每群bounded、可獨立驗收且parallel協調/重讀成本可接受，通過才分4-6檔/agent。不得因檔數單獨fan-out。

**（i）同檔密集 Edit 一次性 patch**：同檔預估**≥3處**Edit時優先一次性patch；是否委派仍由admission決定，不能為避免post-edit dump反而付出更大的context handoff。

**（j）高推理層 TL output 訊號**：預估單筆output≥10行只提示評估是否可交付bounded formatting/assembly responsibility；output長度本身不授權spawn，也不證明lineage成本較低。

**（k）Reference Pattern（具體路徑優先）**：TL 委派 dp-programmer / dp-assistant 時，Briefing `files_to_touch` 必須列**具體檔案路徑**（如 `src/auth/login.ts`），**禁止**描述性語言（「login 那塊」、「相關設定」）。模糊路徑會讓 subagent 自行 grep，浪費 tokens 且易錯。探索任務豁免：`task` 明示「未知路徑、需 survey」，並改用 `dp-assistant`。

**（l）Full-flow compact handoff**：完整 `devpro:change`→實作→`devpro:pre-pr`→PR→Recap 流程中，TL MUST 以 evidence ledger + path/range 傳遞上下文，不重送已存在於 worktree 的 proposal/tasks/QA/review 全文。若 reviewer/recap 需要詳細內容，按需讀檔；預設 packet 只列 `file:line`、task、acceptance、test/log path。

**（m）Reference-only packet telemetry**：委派、review、cross-model packet 預設只傳 path/range/task/acceptance；packet builder 或 TL handoff MUST 附 telemetry capsule（`source_lines`/`source_bytes`、`packet_lines`/`packet_bytes`、`inline_full_payloads` 或 `blocked_inline_payloads`、`reference_only: true`、引用的 file/log path）。若同時宣稱 token-cost reduction，宣稱 MUST 引用 `report-session-token-usage.mjs --lineage` 的 descendant-inclusive / lineage-inclusive actual evidence；baseline 與 after 必須 equivalent，並涵蓋 root、descendants 與 external reviewer sessions且均為 `lineage-complete` + `reconciled`，不得只憑估算或口頭宣稱。沒有涵蓋所有 contributors 的 provider authority 時，quota impact 與 cost 保持 `N/A` / unavailable，不得用 token conversion 推測。

**（n）往返紀律**：往返數 × main context 體積是最大成本槽，先算它再算 agent 數。獨立子代在同一 turn 一次派出；callback 註冊一次後 yield 一次，禁輪詢（`model-delegation.md` §Callback Delivery Entry Gate）；子代回傳只給 path:line、結論與 receipt，不回傳檔案內容；main context 超過 Gate CH advisory 時先落地狀態（tasks.md／decisions.md）再派工，派工前不做 broad exploration。

> Cross-ref：search/載入面的 token 紀律見 `token-frugal-io.md` § Rule Loading Scope Order（載入範圍順序）與 § Exploratory Search Gate Forbidden-path default（archive / `.worktree` 預設排除）；本檔只列委派面細則。
