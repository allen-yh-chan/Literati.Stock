---
name: model-delegation-threads-and-caps
description: 責任 thread 生命週期（continue-first、換手條件）與結構上限／lane 表（active、nested、cooperative 標記）。觸發：Executor 決策序步驟 3–5 判 continue／換手／上限時；telemetry 對帳時。
---

# 責任 Thread 生命週期 / 結構上限與 Lane

> Load-chain：本檔由 `model-delegation.md` §Executor 決策序按需載入；entry leaf 只留決策序正文與 pointer，thread 主表與上限表在此。

## Overview

決策序步驟 3（continue）、4（fresh／fork）、5（half-state／上限）需要的兩張表：同一責任只開一條 thread、續作優先；每條結構上限都標示機械載體或 `[cooperative-only]`，違反由 lineage telemetry 事後揭露。

## When to Use

- 當決策序走到步驟 3，需判定「已有同 `responsibility_id` 的 thread 是否續作或換手」時
- 當要開新 `fresh`／`fork` 子代前，需自我檢查 active、nested 上限時
- 當 checkpoint／Recap 對帳 `peak_runtime_native_concurrency`、`replacement_reason` 時

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `.devpro/scripts/hooks/lib/spawn-context-admission.mjs`（admission record 六欄、fork admission、續作載體的 conditional `parent_record_id`；不含 active／nested 計數）＋ `review-remediation-evidence-core.mjs` 的 admission chain 驗證（機械證明 chain 性質——同 change／role／`responsibility_id`、`admitted_at` 時序遞增、無循環、有界 hop 至 fresh 根、record 於 reviewed head 單次消耗；作者歸屬與獨立性 `[cooperative-only]`） |
| Advisory | lineage telemetry（`session-usage-lineage.mjs` 的 `peak_runtime_native_concurrency`／`replacement_reason`）事後揭露；`work_lane_fresh_total` 只是計數，無上限、不作違規判準 |
| Doctrine | `cooperative-only: active ≤2、Codex nested 0 無 runtime 強制面（官方：resume 不檢查、/subtask 不受阻、ultracode 豁免）` |

### 責任 thread 生命週期（continue-first）

thread key ＝ (change, role, `responsibility_id`)；`responsibility_id` 指一個可獨立驗收的 deliverable（一份 brd、一份 proposal、一個 receipt lineage、一個實作 task 群）。

- **開啟**：該責任首次需要子代時 `fresh`。
- **合併**：新工作只在「同 deliverable、同 acceptance、同 `evidence_scope` 子集」時併入既有 thread；否則是新 `responsibility_id` → 走決策序步驟 0–2（多半 TL-direct）。同角色不同責任不得共用 thread。
- **續作**：同責任一律 `continue`（runtime-native 續作：`SendMessage` 到既有 agent id；Codex 同 thread `followup_task`（model-visible `collaboration.followup_task`，2026-09-03 live fixture））。續作載體同樣經 admission gate：`message` 帶 `instance_mode: continue` 與 `parent_record_id:`（被續作 record 的 id）時寫出續作 record（`role_binding: cooperative-only`），未宣告者不 block；續作輪經 receipt 端 chain 驗證可封存 runtime-agent 收據（`subagent-behavioral-contract` 的 `Continuation Receipt Continuity Is Chain-Verified`），續作 record 仍為 `cooperative-only`；未宣告的續作沒有 admission record，無法封存；`to` 取自原 spawn 回傳的 agent id、`parent_record_id` 取自同一 thread 上一輪已 admitted 的 record（首次續作為該 spawn 回傳的 record，其後為上一次續作訊息回傳的 record，不是每輪都回到 fresh 根）；閒置 thread 不產生 token，成本只在續作 turn 且隨累積 context 上升。
- **終止**：責任驗收（receipt sealed／deliverable accepted／archive／PR 完成）→ thread retired，不再續接。

| 換手／續作判定 | 處置（`replacement_reason`） |
|---|---|
| thread 累積 context 估值 > 冷啟動＋任務重讀 | `fresh` replacement；`context-growth` |
| 需要獨立判斷（security／runtime／hook／merge／release-gate、post-PR 豁免 PR 的 primary review、記錄的獨立理由） | `fresh`；`independence` |
| 子代讀過的 rule leaf 在 thread 期間被變更（`git diff` 判定） | 續作前只重讀變更檔，不換手；記 `rule-leaf-changed`（`model-delegation-token-efficiency.md` (c)） |
| compaction／新 session 後 agent id 不可用；runtime 回報 terminal | `fresh` replacement；`identity-lost`／`terminal`；以 sealed receipt／brd／proposal 等 durable 檔接手 |
| 併發 slot 已滿 | 續作占 slot（runtime resume 不檢查上限）；記 `concurrency-slot`；peak 以 telemetry 報，不信任 env |

跨 main session 的子代續作無官方保證，不作正確性前提；per-agent `memory` 不得承載規範內容。

### 結構上限與 lane

每條上限標示機械載體或 `[cooperative-only]`；cooperative 承諾 MUST NOT 寫成機械保證。

| 控制 | 值 | 機械載體 | 標記 |
|---|---|---|---|
| review lane（second-review wrapper＋terminal external reviewer） | 不計入 work lane；受 round cap／budget／disclosure／terminality gate | telemetry | — |
| Agent-tool new-spawn（具名投影 host） | 2 | 無載體（本 repo 不設 user-local `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`；見 active adapter） | `[cooperative-only]` |
| 同時 active ≤2（含 resume／`SendMessage` 續作、`/subtask`、ultracode；work lane＋review wrapper） | 2 | 無載體；pre-dispatch 由 TL 依 admission record 的 `runtime_native_active_count` 自我檢查；telemetry 報 `peak_runtime_native_concurrency` | `[cooperative-only]` |
| Codex 同時 threads | 2 | 無載體（本 repo 不設 user-local `[agents] max_concurrent_threads_per_session`） | `[cooperative-only]` |
| nested | TL 直接子代以下 0 | 具名 `dp-*` 投影省略 `Agent`（本 repo 不設 depth env）；Codex 無 depth 開關 | 非具名投影的子代與 Codex `[cooperative-only]` |
| 子代完成回合／change | advisory 8；超過須先落地 checkpoint 再續派 | telemetry（`child_round_trips`） | advisory，`[P2]` 校準 |
| 單一子代 turn 上限 | `[P2]` 候選（agent frontmatter `maxTurns`；Codex 無對應） | 本 change 未採用，不寫入任何 agent frontmatter | `[P2]`；Codex `[cooperative-only]` |
| 同 scope 併發 ownership | 1 write-capable＋1 RO | `model-delegation.md` §Concurrent Overlapping Ownership Cap | — |

本 repo 不設 user-local 的併發／巢狀值，上列數字都沒有設定層載體，皆為 cooperative 承諾；違反由 lineage telemetry 事後揭露（`peak_runtime_native_concurrency`）。

## Exit Criteria

- 每個 `fresh` 都有 `responsibility_id`，且同角色不同責任未共用 thread
- 每次換手記 `replacement_reason`（六值之一；`rule-leaf-changed` 是唯一在**不**換手時記錄的值）；rule leaf 變更只重讀、不換手
- pre-dispatch 已對照上限表；cooperative 項目已標 `[cooperative-only]`，未寫成 runtime 已強制

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「已有 thread，直接續派最省」 | 決策序步驟 1／2 先於 3：ordered／shared-state 小任務仍 TL-direct；「可續作」不是委派理由 |
| 「設了 env 就等於 active ≤2 已被擋」 | env 只限制 Agent-tool 新 spawn；resume／`/subtask`／ultracode 不受檢查，違反只能靠 telemetry 事後揭露 |

## Verification

```bash
grep -q "responsibility_id" .devpro/agent-rules/model-delegation-threads-and-caps.md && grep -c "replacement_reason\|\[cooperative-only\]" .devpro/agent-rules/model-delegation-threads-and-caps.md
```
