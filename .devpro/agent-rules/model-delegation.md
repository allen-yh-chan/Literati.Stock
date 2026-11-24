---
name: model-delegation
description: 模型分工與 subagent 委派：tier 架構、MUST delegate、Briefing 模板、Token 效率規則。觸發：判斷「自己做 vs 委派」時。
---

# 模型分工 / Subagent 委派

## Overview

核心原則：專業角色做專業的事。

- **主 agent（TL）** 預設高推理層 (reasoning)，可降中執行層；負責問答、協調、驗證、少量直接修改。
- **高推理層 subagent**：dp-analyst 需求、dp-architect 設計、dp-reviewer 六軸審查。
- **中執行層 (execution)**：dp-programmer 寫需理解 context 的碼；dp-assistant 做 **低機械層 (rote)** bulk 讀寫、grep、測試、rename/move、git 唯讀、`devpro:*` skill。

> **速查**：先找可獨立驗收的 bounded responsibility，再比較隔離效益與 context transfer／duplicate read／協調成本；≥2步、≥2檔、artifact或output長度只提示要評估，不單獨證明省成本或授權spawn。新spawn明示minimum-sufficient runtime mode。委派點一律先走 §Executor 決策序。

> Load-chain：需 MUST-delegate 細則載入 `model-delegation-delegation-rules.md`；token 優化細則載入 `model-delegation-token-efficiency.md`；委派 briefing / 回報格式載入 `model-delegation-briefing.md`；責任 thread 生命週期與結構上限表載入 `model-delegation-threads-and-caps.md`；active delegation lifecycle MUST 按需載入 `model-delegation-active-lifecycle.md`。entry leaf 只 eager-load 決策速查 + cheatsheet。

### Concurrent Overlapping Ownership Cap

同時段、同 scope、ownership 可能重疊：預設 **1 write-capable + 1 independent RO reviewer**。Single-writer lease **MUST NOT** 放寬。

- Sequential lifecycle（analyst→…→reviewer）= **non-overlapping over time**（非 cap 豁免）；同時段仍 1+1。
- >2000 tokens：shrink via `token-frugal-io.md`；**非** Ask First approval gate。
- Safety／consensus reviewer 預設 **RO**；不得因 exception 取得第二 write lease。
- 第二 write-capable 例外 MUST 記：`authorizer`、`eligibility`、`duration`、`lease_transfer`、`prior_writer_revocation`、**禁止 overlapping writers**；缺任一 → fail closed、禁 spawn。
- Emergency containment：最小／可逆／可驗證；原子取得 lease 並撤銷 prior writer；既有 24h follow-up／更嚴安全 gate 保留；缺 authorizer／eligibility → 禁止。

Pointers：`multi-agent-handoff.md`；>2000 shrink 正文只在 `token-frugal-io.md`。

### TL 推理層選擇建議

**Tier 詞彙**：高推理層 (reasoning) = 需求分析、技術設計、RCA、六軸審查、架構權衡；中執行層 (execution) = 實作、測試撰寫、routine command、驗收摘要；低機械層 (rote) = bulk 讀寫、grep survey、測試執行、rename/move、git 唯讀查詢。具體 model 名只寫在 platform-adapter。

三訊號越多指向高推理層，越應選高推理層；短任務、結構化執行、低錯誤代價可選中執行層。

- **對話密度**：長 session（>10 輪）、多輪推理、需跨 turn 維持複雜 context → 高推理層；短任務/單輪執行（如 `devpro:pre-pr`）→ 中執行層。
- **輸出性質**：需 deep reasoning（spec 設計、RCA、六軸審查、架構權衡）→ 高推理層；結構化執行（briefing/委派/驗收摘要）→ 中執行層。
- **錯誤代價**：影響 release/security/架構/OpenSpec proposal 等高代價節點 → 高推理層；局部 markdown、機械驗收、routine slash command → 中執行層。

## When to Use

委派評估訊號（任一命中即做benefit/cost admission；任一訊號本身都不是充分條件）：

- **≥2 步機械性操作**：批次 spec 更新、檔案搬移、git 操作序列、grep survey
- **產出需追蹤的 artifact**：spec 檔案、程式碼、PR——評估是否能切成對應角色的 bounded responsibility
- **實作碼撰寫**：主 agent 已完成設計，需寫出具體程式碼——評估 dp-programmer admission
- **≥2 個檔案的 Edit/Write**：Universal Pre-Edit Gate觸發benefit/cost與context-mode決策
- **RCA 探索逃生閥觸發**：3 輪以上 Read/Grep 仍未收斂，或累積 ~15,000 tokens → 收斂 scope 並做 dp-assistant admission；不通過則 TL bounded 續查或 STOP
- **`/devpro:change` 被 invoke**：brd → proposal outcome mandatory；dp-analyst／dp-architect 的 `fresh` 觸發條件見 `model-delegation-delegation-rules.md`，未命中則 TL-direct（`openspec-flow-fallback.md`）
- **`devpro:pre-pr` 第三步**：六軸 + security review receipt outcome mandatory；executor 依決策序（fresh 觸發條件見 `model-delegation-delegation-rules.md`），否則 TL-direct

**不觸發**：純問答、閱讀 code、TL 自行 RCA 推理（尚未達逃生閥閾值）、單步單檔 <10 行的小修改。

**Admission**：只有工作可被bounded responsibility隔離、驗收明確，且隔離效益高於handoff／重讀／回流成本時才spawn；否則TL執行。主context縮減不等於lineage total節省；無usage evidence不得宣稱後者。新spawn明示minimum-sufficient runtime mode；closed mode matrix見delegation-rules與active adapter。

**Codex授權投影**：admission通過或mandatory role才形成`RepoDelegationAutoAuthorization`；task shape不形成authorization。runtime另需explicit trigger時，以使用者明示subagent／delegation／parallel work或bounded launch選項形成`StandingDelegationAuthorization`；`go`、`依repo規範`或correction不算。缺trigger進`SubagentAuthPending`問一次，不是`subagent=no`或fallback。

## Process

### Executor 決策序（SSOT；六步，編號 0–5，順序不可互換）

每次委派前依序判定，結果寫入 admission record（六欄定義見 `model-delegation-briefing.md` §Admission record）：

0. **Outcome**：先確認需要的 outcome（brd／proposal／receipt／實作／survey）與其是否屬 mandatory 獨立判斷（各角色 `fresh` 觸發見 `model-delegation-delegation-rules.md`）。無現況差異 → no-op；mandatory 獨立判斷 → 直接跳 4 且 `instance_mode` 只能 `fresh`。
1. **Task shape 排除**：ordered／shared-state／<10 行／需頻繁來回／與 TL 現有 context 高度重疊 → TL-direct，產出同 schema 同 acceptance；不看是否已有 thread。
2. **Admission eligibility**：`objective` 屬四類之一、`evidence_scope` 與 `return_and_stop` 有界、結構上限與 budget gate 未阻擋；任一不成立 → TL-direct 或停下（half-state override 見 `workflow-cost-controls.md`）。
3. **Continue**：已有同 `responsibility_id` 的 thread 且未達換手條件 → `continue`。
4. **Fresh／Fork**：否則 `fresh`；只有「短側任務且 briefing＋冷啟動明顯高於繼承現有 context 一次」且 active adapter 記載 fork 可用時 `fork`，必附 `fork_reason`。
5. **Half-state／上限**：命中 → 退回 1 或 3；mandatory 獨立 gate 例外見 `workflow-cost-controls.md`。

**跨 repo change 不委派**：admission 只在 session 所在 repo（同一 Git common-dir）找 `.worktree/<change_id>`，change worktree 在另一個 repo 時綁不到，委派會以 `change-worktree-required` 擋下。這類 change 到目標 repo 開 session 再委派；留在原 session 就由 TL 自己做。

**Change-less 變更的 `change_id`**（本段是唯一定義，其他 leaf 只指回此處）：chore-A、或 rigor lite stepwise 下不建 change folder 的 bugfix／hotfix 沒有 `openspec/changes/<id>` 可查（lite 選 batch 時會寫 `openspec/changes/<id>/lite-scope.md`，folder 存在，不屬此類），canonical `change_id` 取值為該變更 worktree 的 `.worktree/<id>` basename，且 `<id>` MUST 等於去前綴的分支名（`bugfix/fix-x` → `fix-x`）並通過 `change_id` 格式檢查（`model-delegation-briefing.md`）；worktree 以 `git worktree add .worktree/<id> -b <prefix>/<id>` 建立。binding 有兩條合法路：在該 worktree 內派工走 cwd fast path；或從 main checkout 等其他 cwd 走 declared path，宣告 `change_id: <id>` 並帶唯讀 helper `resolve-admission-binding.mjs` 預解析的 `execution_root`（格式見 `subagent-dispatch-blocks.md` 的 Declared path）。binding 成立後以 `change-dir-absent` 放行、不寫 admission record，缺口只由 lineage telemetry `admission-records-unavailable` 揭露；這是**預期**形狀，不影響該 dispatch 產出 findings 的有效性，MUST NOT 為了留下 record 而建空 change folder。兩條路都不成立（cwd 不在 `.worktree/<id>`，也沒有能解析出 binding 的宣告）時，review／verify role 會被 `change-worktree-required` 擋下——那是「缺 binding」的訊號，不是「缺 change folder」的訊號，正確動作是換到該 worktree，或照 declared path 宣告後再派工。沒有 admission record 的 dispatch 不能當六軸收據鏈的 reviewer 證據（runtime-agent 收據需要 `admissionRecordId`）；六軸 primary review 只在 full rigor 執行，chore-A 依 `receipt_authority_unavailable: chore_a_no_openspec` 處理，lite 沒有六軸收據。

拒絕條件＝步驟 1／2 任一不成立；「省 token」、兩步、兩檔皆非 objective；「已有 thread 可續」不是委派理由（步驟 1／2 先於 3）。TL-direct 是決策序的正常結果，不是 fallback，但其產物 MUST NOT 充當要求獨立判斷的 contract；使用者口語（「你自己做」／「跳過 reviewer」）不豁免 outcome（見 §Common Rationalizations）。

責任 thread 生命週期（換手條件、`replacement_reason` 六值）與結構上限／lane 表（含 active ≤2 `[cooperative-only]`）主表在 `model-delegation-threads-and-caps.md`；步驟 3／5 依該表判定。

### Delegation Liveness Briefing Gate

產出檔案或 diff 的委派在 spawn 前，briefing MUST 明列：`claimed_artifact_paths`、具體且可判定的 `first_artifact_deadline`（絕對時間、相對分鐘數或明示 execution turn；禁止只寫「儘快」）、第一個障礙時可採用的 bounded fallback，以及下方恰好一個 `completion_mode` branch。期限是明示的有效 artifact checkpoint 交付契約；若自然邊界尚不能安全落盤，delegate 必須在同一期限內依所選 branch 回報 progress、blocker 與 reproduction evidence，不得為顯示活動而寫入無效半成品。缺 common field 或合法 branch 即 FAIL CLOSED，不得先派再靠 TL 猜測進度。

**First persisted artifact projection**：coding/authoring 的 `first persisted artifact` 可為 target file patch、failing RED test 或 repro evidence，且 MUST 對應 `claimed_artifact_paths` 與 `first_artifact_deadline`。只載入 skills/rules、探索、口頭 milestone 或 plan 都不算落盤（do not count）。

**Deadline-miss projection**：`artifact_landing_deadline_missed` 時，delegate MUST 立即 callback actual state、blocker 與 evidence；TL 只做一次 `focused scope convergence/rebrief`。單次 miss MUST NOT disable subsequent delegation。`TL takeover/reassign` 仍須 interruption evidence 或 user explicit direction；deadline miss MUST NOT authorize automatic takeover。

**dp-architect dispatch action point**：`/devpro:change` dispatch dp-architect MUST include `claimed_artifact_paths`, exact `openspec/changes/<change>/proposal.md`, exact `openspec/changes/<change>/design.md`, `first_artifact_deadline: 30m_total`, `writer_lease: single`, `completion_mode: callback`, and `completion_channel: runtime completion callback/event`。

- dp-architect accepted dispatch starts `30m_total` and MUST NOT reset or extend for activity, heartbeat, status, poll, message, or focused rebrief; it is neither an idle timeout nor a total task timeout.
- dp-architect 的 internally valid `proposal.md` or `design.md` 任一即可 satisfy the first-artifact checkpoint；另一檔仍留在同一 writer lease。
- `artifact_landing_deadline_missed` 只觸發 actual-state callback與exactly one focused rebrief to the same writer；不得self-terminalize、revoke lease、派第二writer或TL fallback。
- A dp-architect takeover requires authorization from explicit user replacement or independently sufficient terminal/interruption evidence; the takeover MUST then revoke the original writer lease; after revocation it MUST confirm the original writer inactive; only then, and never before, may it create the ownership-transfer record. Missing or reordered steps MUST FAIL CLOSED.

TL 等待期間的 lifecycle、deadline miss、artifact landing verification、safe alternative 與 polling 例外，以 `multi-agent-handoff.md` §Artifact-first Delegation Liveness 為 SSOT。入口只鎖三項：runtime 提供 completion callback/event 時 MUST event-driven 等待；delegate 的 prose `DONE`、沉默或 running 狀態都不是 artifact completion evidence；`artifact_landing_deadline_missed` 只表示明示交付契約未達，MUST NOT 單獨當成 verified stall、agent unavailable 或中斷／fallback 授權。

**Callback Delivery Entry Gate**：

- `callback-capable runtime` 使用 `completion_mode: callback`；`completion_channel` MUST name a real callback/event channel and is required。TL MUST register once that callback/event channel before waiting, then yield once；MUST NOT use `repeated short/intermediate timed waits`（包含 `wait_agent`）模擬 callback delivery。
- `explicit no-callback runtime` 使用 `completion_mode: bounded_poll`，只可在 `runtime 明示無 callback` 時使用 bounded poll；MUST NOT fabricate or require a nonexistent `completion_channel`。briefing 必填 `no_callback_evidence`、`poll_interval`、`maximum_attempts`、`hard_deadline`，所有 poll telemetry 為 log-only / internal-only。
- Any other `completion_mode`、missing or mixed branch fields、unclassified runtime 一律 FAIL CLOSED。
- `Meaningful transition gate`：`wait timeout`、`no callback yet`、unchanged poll sample 都是 internal telemetry，MUST NOT 成為 user-visible progress/update。只有 new artifact/checkpoint evidence、blocker/decision、completed/terminal 才可對使用者更新。

### Quantified Threshold Cheatsheet（速查）

> 各條詳細以對應段落為 SSOT；本表僅供查找。

| 觸發條件 | 動作 | SSOT |
|---|---|---|
| 任何委派點 | 先走 Executor 決策序步驟 0–5，結果寫入 admission record | §Executor 決策序 |
| ≥2 步機械性操作 | 做 dp-assistant admission | §When to Use |
| ≥2 檔 Edit/Write | Universal Pre-Edit Gate 委派決策 | §Universal Pre-Edit Gate |
| architect 已給設計 + 待實作 task ≥2 檔 | 做 dp-programmer admission | §MUST delegate / dp-programmer |
| 微調 ≥3 個 task 的驗收語意或 target state ≥2 done-when | 做 dp-architect update admission；寫入者另依相同判準決定 | §SHOULD delegate / §統一委派準則 |
| tasks.md checkbox 批次勾選 ≥3 | 做 dp-assistant admission | §統一委派準則 |
| 同檔 ≥3 處 Edit | 優先一次性 patch；執行者由 admission 決定 | §Token 效率規則 (i) |
| 預估 ≥6 檔或 >50K bytes context | 做分群 admission | §Token 效率規則 (h) |
| 高推理層 TL 單筆 output ≥10 行 (~300 tokens) | 做 bounded output admission | §Token 效率規則 (j) |
| 跑測試 suite | 做 dp-assistant admission | §MUST delegate / dp-assistant |
| git 唯讀大輸出 (log/diff) 預計 >100 行 | 做 dp-assistant admission | §MUST delegate / dp-assistant |
| RCA Read/Grep ≥3 輪 未收斂 或累積 >15K tokens | 觸發 RCA 逃生閥委派 | §RCA 探索逃生閥 |
| Rate limit 429 / overloaded | TL 立即 fallback 不重試（fault 分類見 `ai-autonomy.md` §Agent Runtime Protection Retryable row） | §Token 效率規則 (f) |
| 1 檔 1 次 edit <10 行 且無設計判斷 | TL 自做（豁免委派） | §主 agent 不委派 |

### 角色對應表 + TL 職掌劃分

| Agent | 角色 | 模型層 | 說明 |
|---|---|---|---|
| 主 agent | TL | 高推理層（可降中執行層） | 協調 subagent、問答、驗證判斷、少量直接修改、RCA；**預設不做多步產出工作，角色為「路由 + 審查 + 判斷」** |
| `dp-analyst` | SA（系統分析師） | 高推理層 | 需求分析、可行性評估（pre-flight checklist）、scope 定義、starting state 收集 |
| `dp-architect` | SD（系統設計師） | 高推理層 | 技術設計（proposal 草稿：target state、touch list、Task Outline handoff；full task rows 不寫入 proposal）、spec update 影響評估 |
| `dp-programmer` | PG（程式設計師） | 中執行層 | 依設計方案寫實作碼；model 可獨立調整 |
| `dp-reviewer` | Reviewer（審查員） | 高推理層 | 六軸審查 + security review，只產報告不改碼 |
| `dp-assistant` | 助理 | 中執行層 | 跑測試、grep survey、rename/move、執行腳本等機械操作 |

> 上列「主 agent」列之高推理層為前提；非高推理層（含 `unknown`）時另有能力下限，見 `model-delegation-delegation-rules.md` §TL Tier Floor。

**TL 職掌劃分表**：

| 情境 | 誰做 |
|---|---|
| 解釋/回答問題（不產出需追蹤的 artifact） | TL |
| RCA / debug 推理（定位根因） | TL |
| Task 相依性分析與排序 | TL |
| Branch Routing Decision（§2 前置路由） | TL |
| Subagent 回報的綜合判斷與使用者溝通 | TL |
| 單步小修改（1 檔、`<10` 行、無設計判斷） | TL |
| 正式 pre-flight / 影響範圍評估 | dp-analyst，依 §Executor 決策序 |
| 技術設計、proposal | dp-architect，依 §Executor 決策序 |
| 寫碼（新邏輯、函式、測試） | dp-programmer（`fresh`／`continue`）或 TL-direct，依 §Executor 決策序 |
| 機械操作（rename、bulk edit、git 序列） | dp-assistant 或 TL-direct（同上） |
| Spec 檔案寫入（tasks.md / qa-test-scope.md / decisions.md 等 OpenSpec 文件；proposal.md / design.md 由 dp-architect 寫入、brd.md 由 dp-analyst 寫入）；若 dp-architect 產出含 `decisions` 段落，一併建立 `openspec/changes/<name>/decisions.md` | dp-assistant，依 §Executor 決策序 |
| 六軸審查 + security review | dp-reviewer，依 §Executor 決策序 |

> 上表 RCA／Task 相依性分析與分派排序／Branch Routing Decision／Review 回報綜合判斷等項目以 TL 高推理層為前提；非高推理層時改依 `model-delegation-delegation-rules.md` §TL Tier Floor 處置（改委派或 STOP）。

### 可用 subagents

| Name | 模型層 | 何時用 | 工具權限 |
|---|---|---|---|
| `dp-analyst` | 高推理層 | `devpro:change` pre-flight checklist + 需求分析 | Read, Write, Grep, Glob, Bash（唯讀 git）[^1]|
| `dp-architect` | 高推理層 | `devpro:change` proposal + design 設計 + spec update 影響評估 | Read, Write, Grep, Glob, Bash（唯讀 git）[^2]|
| `dp-reviewer` | 高推理層 | `devpro:pre-pr` 第三步 六軸 + security review | Read, Grep, Glob, Bash（唯讀 git）|
| `devpro:second-review` | 高推理層（host adapter defined） | 共用 `devpro:second-review` skill 的 host-specific projection；PR workflow 由 `devpro:cross-review` 觸發。各 runtime-native projection 可存在，但 projection 只是 wrapper，不是 SSOT；projection host family 不等於 reviewer family。active host 先 resolve `primary_family`，再依 common skill + active platform adapter 選 deterministic different-family reviewer chain；same-family fallback 必須明示 reason/provenance，不得宣稱 cross-model diversity | Read, Bash（依 mode：`pr-sticky` 可 gh PR 寫 sticky；`audit-only` 不寫）|
| `dp-programmer` | 中執行層 | 依設計方案寫實作碼；model 可獨立調整 | Read, Write, Edit, Grep, Glob, Bash |
| `dp-assistant` | 中執行層 | bulk 檔案操作、grep 探索、測試執行、mechanical refactor、git 查詢、執行其他 `devpro:*` skill | Read, Write, Edit, Grep, Glob, Bash |

[^1]: Write 僅限 brd.md
[^2]: Write 僅限 proposal.md、design.md

高推理層 subagent 只可寫文件鏈產物：dp-analyst 寫 brd.md、dp-architect 寫 proposal.md（+ 視需要 design.md）；dp-reviewer **不**寫檔案，且高推理層 subagent **不**動 git 寫操作。
中執行層 subagent（programmer/assistant）**可**寫檔案，但只在主 agent 明確指派的 `touch` 範圍內。

### 統一委派準則

委派標準：artifact／≥2步／≥2檔是必須做admission decision的task-shape訊號；只有bounded responsibility、可判定驗收與隔離效益同時成立才委派對應subagent。

「步」的定義：對 codebase 產生副作用的操作（Write/Edit/git write）。Read/Grep/Glob 作為判斷的 input gathering 不計步。
**但 context 護欄獨立適用**：即使 Read/Grep 不計步，若 TL 預估需對 ≥2 個檔案做 Read→Edit 循環，應在第一次 Read 前就決定委派，讓 Read 留在 subagent context。

微調規則：≤2個task驗收條件的語意微調通常由TL直接分析；≥3個task或target state≥2個done-when時，MUST做dp-architect update admission。通過才委派impact assessment，未通過由TL寫入並記理由。dp-architect MUST NOT把task rows寫入`proposal.md`。tasks.md checkbox批次勾選≥3只觸發dp-assistant admission，不是shape-only spawn authority。

### Universal Pre-Edit Gate（所有 Edit/Write 操作的前置檢查）

TL 執行**任何** Edit/Write tool call 之前（不限於 `devpro:change` 流程），必須完成：

1. **後續步估算**：「這個任務總共要 Edit/Write 幾個檔案？」
   - 1 個檔案、1 次 edit → TL 可自己做
   - ≥2 個檔案 → **必須先輸出admission決策**：bounded responsibility、驗收、隔離效益、transfer/duplicate/coordination成本、reuse候選與minimum-sufficient mode；通過才委派，未通過由TL執行並記理由
2. **例外**：dp-programmer/dp-assistant 回報 FAIL 後的主 agent 介入修正、subagent 不可用的 fallback

此 gate 與 `devpro:change` Step 5 委派計畫互補：後者管實作階段，此 gate 管所有場景。

### RCA 探索逃生閥

滿足**任一**條件時，將剩餘探索委派給 dp-assistant 並附上已知線索：

**觸發 A（行為信號）**：3 輪以上 Read/Grep 後仍無法一句話收斂根因（仍有 3+ 等權重方向）。

**觸發 B（token 護欄）**：同一 RCA Read/Grep 累積 > ~15,000 tokens（約每行 4 tokens；模型更換時重估）。

**委派時附帶**：已排除假設及理由、剩餘候選假設、建議 dp-assistant 優先檢查的檔案/區域。

### Fallback（subagent 不可用時）

**授權未決不是 subagent 呼叫失敗**：若唯一缺口是 runtime/user authorization，TL 先詢問是否授權啟動 subagent/parallel agent 並停等。只有使用者拒絕、`subagent=no`、授權後工具仍不可用、runtime-reported terminal quota/timeout、或實際 terminal subagent 呼叫失敗，才 fallback；缺授權絕不可記成 subagent unavailable。TL-selected wait/poll timeout MUST NOT count as runtime terminal timeout; a TL-caused interruption MUST NOT count as call failure or trigger fallback, and MUST first follow the recovery path in `model-delegation-active-lifecycle.md`.

任一具 terminal runtime/tool evidence、且非 TL-caused interruption 所產生的 subagent 呼叫失敗，TL **必須 fallback**：依 `openspec-flow-fallback.md`、`code-review-checklist-fallback.md`，或自行寫碼/執行機械操作。

**禁止**因 subagent 失敗而跳過 pre-flight 或六軸——那是規則，不是 subagent 的功能。

**禁止**因使用者口頭說「跳過」而豁免 reviewer——使用者授權不能繞過 mandatory gate。

**Light review 降級模式**（可申請省時；不可跳過），觸發條件須在 PR 描述明示：
1. `grep` 抽查核心 Never 規則 substring（SQL injection / PII / auth 等 security 敏感）
2. H2 heading 完整性確認（六個必要 H2 section 存在）
3. diff 對 touch list 範圍對照

**Fallback 最小輸出要求**（輸出必須符合對應 subagent 的 Output schema）：
- **dp-analyst fallback**：TL 寫 brd.md + status（PASS/FAIL/QUESTIONS）；缺一未完成
- **dp-architect fallback**：TL 寫 proposal.md（+ 視需要 design.md）+ status；`decisions`（可選 D\<N>）供 dp-assistant 寫 decisions.md；缺一未完成
- **dp-reviewer fallback**：必含 `verdict`（PASS/BLOCK/PASS_WITH_IMPORTANT）、`axes`（6 軸）、`security`（4 類）；缺任一未完成

### 資料流摘要

- **`devpro:change`**：TL → dp-analyst（meeting-notes→brd）→ dp-architect（brd→proposal + Task Outline handoff）→ TL（分支）→ TL / dp-assistant（tasks.md）。TL 只指定 `change_path`、觸發、驗收。
- **實作迴圈**：TL（implementation_plan）→ dp-programmer（碼 + 測試/疑問）→ TL（驗收）→ dp-assistant（regression suite）。
- **`devpro:pre-pr`**：TL → dp-assistant（測試/簡化/walkthrough）→ dp-reviewer（六軸+security）→ TL（archive/PR）→ host-appropriate second-opinion reviewer（prefer different-family；unavailable 時 same-family fallback）→ TL（sticky/merge gate）。

主 agent (TL) 是所有 subagent 之間的 hub——subagent 之間不直接溝通。

### 個人覆寫

主 agent 可因長期批次 / 預算敏感降級到中執行層；設定方式見對應 `platform-adapters/<runtime>.md`，shared rule 不寫平台設定片段。

### 主 agent 不委派（TL 自己做）

- **決策序步驟 1 命中** → TL-direct，產出同 schema 同 acceptance；不因已有 thread 而改派
- 使用者問答、討論
- **單步**小修改且主 agent 已有 context（1 個檔案、1 次 edit，直接改更快）
- 根因分析、debug 思路推理
- Review subagent 回報後的判斷與使用者溝通
- 單一 git 指令（1 個指令，非序列）
- **Task 相依性分析與分派排序**：分派並行 task 前，TL 必須自行判斷相依鏈（見 `multi-agent-handoff.md`「分派原則」），此為決策行為，不委派

> 上列清單以 TL 在高推理層為前提；非高推理層（含 `unknown`）時另有能力下限（改委派或 STOP，不放寬義務），見 `model-delegation-delegation-rules.md` §TL Tier Floor。

## Exit Criteria

- 委派計畫已輸出（說明「委派給誰、做什麼、touch 哪些檔案」）；每個委派點留有六欄 admission record 或 TL-direct 記錄
- Hard Gate：task-shape訊號命中時已留下benefit/cost + reuse + context-mode admission決策；只有admission通過才要求實際委派
- Briefing 用標準模板：dp-programmer task/files_to_touch/acceptance_criteria/design_reference；dp-assistant task/files_to_touch/exact_instructions
- Subagent 回報含 status(DONE/PARTIAL/FAIL)+summary(1-3句)+changes(檔案清單)
- Artifact landing verified；missing path 不標 done/ready
- Universal Pre-Edit Gate：Edit/Write 前完成後續步估算
- RCA 未超逃生閥，或已委派 dp-assistant

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「≥2步／≥2檔所以一定省token」 | task shape只要求評估；先比較transfer、duplicate read、coordination與lineage成本，不能把main-context縮減冒充total saving。 |
| 「只是跑個測試，自己 bash 更快」 | 大量log先走admission；委派時TL仍須驗證具名artifact、exit與failed-test evidence，不可只信摘要。 |
| 「RCA 還沒收斂，再看幾個檔案就能找到」 | 樂觀偏差的典型信號。已過 3 輪或 15K tokens → 立即觸發逃生閥委派，不要繼續燒 context。 |
| 「dp-analyst/architect 不可用，跳過 pre-flight 吧」 | subagent 失敗必須 fallback 自行執行，不可跳過 pre-flight 或六軸——那是規則，不是 subagent 功能。 |
| 「TL 降成中執行層就不需要那麼嚴格委派了」 | 委派規則與 TL model 選擇無關；規則依工作性質定義，不依 model 放寬。 |
| 「使用者說『你自己做就好』／『跳過 reviewer』」 | 使用者口語不豁免 outcome。mandatory outcome（brd／proposal／receipt）不因口語指令消失；executor 仍由 §Executor 決策序決定；reviewer 是 mandatory gate，強烈想省時間請走 light review。 |

## Verification

```bash
grep -c "^## Overview\|^## When to Use\|^## Process\|^## Exit Criteria\|^## Common Rationalizations\|^## Verification" .devpro/agent-rules/model-delegation.md
grep -q "≥2 步" .devpro/agent-rules/model-delegation.md && echo "OK"
grep -q "15,000 tokens" .devpro/agent-rules/model-delegation.md && echo "OK"
grep -q "acceptance_criteria" .devpro/agent-rules/model-delegation.md && echo "OK"
grep -q "順序不可互換" .devpro/agent-rules/model-delegation.md && grep -q "responsibility_id" .devpro/agent-rules/model-delegation.md && echo "OK"
grep -q "對話密度" .devpro/agent-rules/model-delegation.md && grep -q "輸出性質" .devpro/agent-rules/model-delegation.md && grep -q "錯誤代價" .devpro/agent-rules/model-delegation.md && echo "OK"
```

Red Flags（立即停下）：task-shape訊號命中卻未做benefit/cost與context-mode admission；spawn省略runtime-native context mode；RCA超過3輪未收斂；Subagent回報Critical壓下不報。

**禁止**把 dp-analyst/architect/reviewer 當通用寫文件或修 bug 工具（各有限定職責）；**禁止**把 dp-programmer 當「做架構決策」工具；**禁止**把 dp-assistant 當「做設計決策」工具——它只執行，不推理；禁止 subagent Critical 自行壓下不報。
