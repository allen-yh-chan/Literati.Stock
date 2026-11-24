---
name: session-recap-token-usage
description: Session Recap「Token 回顧」的進階情境：跨 session／host change、--since-change 歸因的明細範圍、second-reviewer dispatch 用量 rollup、lineage-inclusive claim gate、固定歷史證據、subagent 列、撰寫工具與用量主體，以及 structured claim 欄位 block。觸發：Recap 的用量跨多個 session／host、含 cross-review dispatch 或 subagent、或要提出 lineage／final／reconciled 等宣稱時。
---

# Session Recap Token Usage

> Load-chain：本檔由 `session-recap.md` §Template（copy-paste-ready）的 `## Token 回顧` 按需載入；取得用量的基本指令、必填欄位（host／session／source／totals／cost_usd／gaps）與明細表格式留在該檔。該檔「進階情境」所列情境一項都不符時不必讀本檔。

**跨 session / 跨 host change**：若同一 change 跨多個 session continuation、host 切換或 worktree handoff，MUST 對**每個**實際使用的 session id 各跑一次 CLI（`--session <id>` 精準命中），並在本節分段列出；最後加一段算術彙總（標註「非 host 對帳」）。**禁止**以 `--latest` 作為 Recap 唯一資料來源。**禁止**手動截斷明細表（須貼 CLI 輸出，或註明 `--top N` 與完整列數）。

**change 歸因（`--since-change`）的明細範圍**：`--since-change <change>`（含 `--json`／`--lineage`）只輸出歸因 totals 與 session 摘要、沒有明細表，且 subagent 用量不在其 totals 內。明細表 MUST 取自對同一批 session 各跑的 `--session <id>`（subagent 列以 `--session <id> --lineage` 為準），並在表前加一行「明細範圍：session 層級（可能含同 session 內其他 change 的 turns）；totals 歸因範圍：change（`--since-change`）」，兩個範圍不得混成同一個宣稱。`recap-body-template-check.mjs` 只要求至少一列完整八欄明細，上述範圍標示行不影響檢查。

**Design-gate / cross-review（second-reviewer dispatch）**：Recap 使用 projection runner 的 `usage-manifest.json` 關聯 TL host 與 reviewer sessions；累積、coverage 判定、證據上限與保留讀取契約的唯一 owner 是 `second-review-control-evidence.md` §3 usage companion 段。Recap MUST 保留 CLI 顯示的 coverage 與具名 gaps，並優先執行：
`node .devpro/scripts/report-session-token-usage.mjs --rollup-manifests --dispatches <dispatch-id-1>,<dispatch-id-2>,...`
（或 `--dispatch <id>` 重複、或省略 dispatch 清單改以 `--repository-slug` 掃描本 repo 全部 manifest）。將 CLI 輸出的「Dispatch 關聯用量」與「算術彙總」併入本節。Reviewer transcript 可讀時以 transcript 用量為準；transcript unavailable 時才使用 manifest snapshot，且 MUST 保留 CLI 的來源標籤。Codex reviewer snapshot 只保存正規化 totals：`input_tokens - cached_input_tokens`、`output_tokens`、`cached_input_tokens` 對應 `cache_read`；來源標為 `reviewer-manifest:turn.completed.usage`。若 reviewer session/transcript 不可用且沒有 snapshot（舊 dispatch 或 stream 無 usage），再手動補跑 `--host ... --session ...`；仍無法取得時在 `gaps:` 記具名缺口。manifest 寫入失敗不得阻斷 review 本身，但 Recap MUST 在缺少 manifest 時記 `usage-manifest-missing` 或對應具名缺口。

**Lineage-inclusive claim gate**：要宣稱 `current-change`、`lineage-complete`、`final`、`reconciled`、`reproduced`、`improved` 或 `regressed`，MUST 貼同次 reporter 產生的 `devpro-lineage-usage-report/v1` 結構化摘要。direct session 用 `node .devpro/scripts/report-session-token-usage.mjs --host <host> --session <id> --lineage`；change attribution 用 `node .devpro/scripts/report-session-token-usage.mjs --since-change <change> --lineage`。摘要分開列 `lookup`、`scope`、`coverage`、`terminality`、`reconciliation`，並列 root／unique descendants／unique external reviewers、dispatch rows、spawn events、role totals、`claims` 與 named `gaps`；不得由 exact lookup 推論其餘四個維度。

`spawn_events > 0` 且 `descendant_sessions = 0` 時，coverage 必須降級並列 descendant missing/read/cap named gap。`mixed-session|session-wide` 不得 claim `current-change`；`open|unknown` 不得 claim `final`；`reconciliation: gaps` 或 input/output 算式不守恆不得 claim `reconciled`。`improved|regressed` 另需 equivalent lineage-inclusive actual baseline；無 provider authority 時 `quota_impact` / `quota_authority` 保持 `N/A: <reason>`，禁止從 tokens 或本機 price table 換算。

`source: N/A: <reason>`只豁免non-zero totals、cost/gaps與detail table要求；若同一節已出現任一lineage-exclusive field，仍必須通過完整structured claim validation，禁止以N/A繞過scope/coverage/terminality/reconciliation矛盾。`--since-change --lineage`遞迴發現但未被checkpoint明列的descendant必須降為`mixed-session`並列`change-attribution-unverified-descendant`，不得把該child的full-session totals claim為`current-change`。

固定歷史證據只在本機以 `node .devpro/scripts/report-session-token-usage.mjs --evidence-boundary <gitignored-boundary.json> --json` 重跑；boundary expected invariants必須包含sorted role+canonical-identity set digest，identity replacement即使counts/totals不變也算drift。只保留 boundary basename、digest、generated-at 與 sanitized summary。`evidence-boundary-drift` 必須移除 `reproduced` 狀態；此 recipe 不執行或暗示任何 Discussion write，且不得輸出裸本機路徑、email/account marker 或 transcript body。

**Subagent 列**：CLI 輸出的明細表 `誰` 欄含 `main` 與 subagent 類型（如 `general-purpose`）；Recap MUST 保留 subagent 列（含 unattached 時的 orphan 列），不得只貼 main turns。Codex caller rollout：`誰` 固定為 `main`；`spawn_agent` 的 `agent_type`（含 `dp-*`）出現在 `項目` 的 `[spawn: ...]` 後綴；完整 child/grandchild 用量以 root 的 `--lineage` 遞迴摘要為準，單一 child 的 `--host codex --session <thread-id>` 只作補充查核。若 `gaps` 含 `subagent-read-failed` / `subagent-unattached`，MUST 在 `gaps:` 如實列出。

**Recap 撰寫工具 vs 用量主體**：`## Token 回顧` 記錄的是**本 change 實際產生 model 用量的 host session**（`claude-code` / `codex`），不是正在撰寫 Recap 的 IDE 或 agent runtime。未註冊 per-session telemetry 的 host 若僅負責收尾、pre-PR、archive 而未產生可讀 session id，**MUST NOT** 另加固定「收尾 host／N/A」段落；`## 版本資訊` 的 `Tool:` 已標示撰寫工具。僅當該 change 的實作工作確實在該 host 上產生可報告用量時，才在本節列出對應 host block。

### Structured claim 欄位

整塊接在 `session-recap.md` Template 的 `- cost_usd:` 之後、`- gaps:` 之前（Template 本身不含 `- schema:` 行）：

```markdown
- schema: <devpro-lineage-usage-report/v1；只有 source 非 N/A 且提出 structured claim 時填完整 block>
- lookup: <exact | latest-fallback | unavailable>
- scope: <current-change | mixed-session | session-wide | unavailable>
- coverage: <lineage-complete | lineage-incomplete | root-only | unavailable>
- terminality: <terminal | open | unknown>
- reconciliation: <reconciled | gaps | unavailable>
- claims: <current-change, lineage-complete, final, reconciled 的可證實子集；無則 none>
- root_sessions: <non-negative safe integer>
- descendant_sessions: <non-negative safe integer>
- external_reviewer_sessions: <non-negative safe integer>
- dispatch_rows: <non-negative safe integer；與 unique reviewer sessions 分列>
- spawn_events: <non-negative safe integer>
- root_totals: <input N / output N；不支援值用 N/A: <reason>>
- descendant_totals: <input N / output N；不支援值用 N/A: <reason>>
- external_reviewer_totals: <input N / output N；不支援值用 N/A: <reason>>
- lineage_totals: <input N / output N；須等於前三者逐 metric 總和>
- efficiency_verdict: <improved | regressed | not-comparable>
- baseline: <equivalent baseline id | N/A: <reason>>
- quota_impact: <provider-authoritative numeric value | N/A: <reason>>
- quota_authority: <provider authority ref | N/A: <reason>>
```
