---
name: model-delegation-briefing
description: 委派 Briefing 模板、admission record、回報格式。觸發：需查閱委派時的標準輸入格式或驗收回報規範時。
---

# Briefing 模板 / 回報格式

> Load-chain：本檔由 `model-delegation.md` 按需載入；entry leaf 只 eager-load 委派決策速查，委派 briefing / 回報格式在此。

### Briefing 模板（TL 委派時的標準 input 格式）

**dp-programmer**：
- `task`：做什麼（一句話）
- `working_directory`：worktree 絕對路徑；subagent 開工前確認 `pwd` 在此，回報須附 `pwd` + branch 佐證
- `files_to_touch`：預計修改的檔案清單（**具體路徑，禁描述性語言** — per Token 效率規則 (k)）
- `acceptance_criteria`：怎樣算完成
- `design_reference`：設計依據（architect proposal 摘要或具體段落引用）
- `test_strategy`：測試策略（選填；bugfix 時**必填** `"prove-it"`——dp-programmer 收到後須先寫 failing test 再修復）
- `semantic_preservation_checks`：語意不變類 task 必填；列 3-10 組 `<file>: <pattern>`，先確認 pattern 存在，完成後回命中行號/路徑，未全命中 FAIL。
- `existing_ssot_list`：TL 填既有 SSOT 清單（可為「無／N-A」但必須顯式）。lookup 是 TL／reviewer 職責，MUST NOT 委派給 dp-programmer／dp-assistant。

**dp-assistant**：
- `task`：做什麼（一句話）
- `working_directory`：worktree 絕對路徑；subagent 開工前確認 `pwd` 在此，回報須附 `pwd` + branch 佐證
- `files_to_touch`：預計修改的檔案清單
- `exact_instructions`：逐步指令（assistant 照做不判斷）
- **Touch-scoped formatting（#2482）**：若 `exact_instructions` 含 prettier／eslint --fix／dotnet format／同等寫入格式化，MUST 明示「只格式化本次觸及檔（由 `git diff --name-only`／明確 path 清單）」「禁寬 glob」「格式化後核對 `git status --porcelain` 與預期集合一致」。政策 SSOT：`code-simplification.md` §Touch-scoped formatting。
- `existing_ssot_list`：TL 填既有 SSOT 清單（可為「無／N-A」但必須顯式）。lookup 是 TL／reviewer 職責，MUST NOT 委派給 dp-programmer／dp-assistant。

> **dp-analyst 和 dp-architect 不使用 Briefing 模板**：TL 僅傳 `change_path`，agent 自行讀文件鏈產物（meeting-notes.md → brd.md → proposal.md）；admission record 六欄仍必填。

### Admission record（六欄＋conditional `parent_record_id`／`change_id`／`execution_root`）

TL 依 `model-delegation.md` §Executor 決策序判定後手填六欄；`budget_state`、`runtime_native_active_count`、`child_round_trips` 由 telemetry 導出。hook 於 admission 通過時把六欄加 `change_id`／`host`／`admitted_at`／`record_id`／`head_sha`／`prompt_sha256` 寫成 durable record（`<change_dir>/admission-records/<record_id>.json`；`<change_dir>` 為 active `openspec/changes/<change_id>`，`openspec archive` 之後則為最新的 `openspec/changes/archive/<YYYY-MM-DD>-<change_id>`——與 reader 同一支 active-or-archived 解析，故 archive 後的 Step 5.5 cross-review dispatch 仍寫得出 record；兩處皆無任何 entry（chore-A worktree 本就沒有 change 資料夾）則放行不寫 record，缺口由 lineage telemetry `admission-records-unavailable` 揭露，但 entry 存在卻不是普通目錄（symlink）仍 block），並以單行 `admission_record: <record_id> sha256=<digest>` 交回 TL 供 `seal-receipt --admission-record` 綁定；TL 不得手填 digest。

| 欄 | 值域 |
|---|---|
| `objective` | 閉集 `parallel-latency`｜`context-isolation`｜`independent-judgment`｜`specialized-surface` |
| `responsibility_id` | 一個可獨立驗收的 deliverable 識別；例與 thread key 見 `model-delegation-threads-and-caps.md` |
| `instance_mode` | `fresh`｜`continue`｜`fork`（`fork` MUST 附 `fork_reason:`；`continue` MUST 附 `parent_record_id:`） |
| `parent_record_id` | **conditional 第七欄**：`instance_mode: continue` 時恰好必填、其餘 mode 恰好不得出現；值為被續作 record 的 `record_id`（UUID v4）。續作載體（具名投影 host 的 `SendMessage`、Codex `followup_task`）宣告 opt-in by carrier：無 `instance_mode:` 行不視為受管續作；宣告後六欄＋本欄機械強制。receipt 端（v2 `executor_evidence` 與 v3 generic runtime-admission）沿本欄走 chain 到同責任的 fresh 根（同 change／role／`responsibility_id`、`admitted_at` 嚴格遞增、無循環、≤8 hop）；v3 另要求根為 `host-verified` v1 record、續作 record 的 head 等於 reviewed head，續作輪經 receipt 端 chain 驗證可封存；未宣告的續作無法封存 |
| `evidence_scope` | 可讀的 path／symbol／command／URL；無界即拒絕 |
| `return_and_stop` | `expected_return` ≤500 tokens 或 workflow 指定的 structured receipt ＋ `stop_condition` |
| `change_id` | **conditional 宣告欄（A2）**：僅走宣告路徑（session cwd 非 `.worktree/<id>`，binding 由宣告＋`git worktree list` exact-one 決定）時使用；由唯讀 helper 預解析後填入，非 always-required。權威一律檔案系統；宣告 id 僅 lookup key，非合規證據。canonical 位置在 `return_and_stop` 與 `execution_root` 之間 |
| `execution_root` | **conditional 宣告欄**：同宣告路徑、**全 role**（含 fork／continuation）必填的 absolute binding worktree path；缺失 → `execution-root-required`、realpath 不符 → `execution-root-mismatch`。cwd fast path（真 `.worktree/<id>` session cwd）豁免。由同一 helper 輸出直接複製 |
| `role` | 閉集＝七個 `dp-*` 角色名：`dp-analyst`｜`dp-architect`｜`dp-reviewer`｜`dp-second-reviewer`｜`dp-programmer`｜`dp-assistant`｜`dp-explorer`（與 `.claude/agents/*.md`／`.codex/agents/*.toml` 檔名一致）。receipt role binding 的權威宣告欄：具名投影 host 由 hook 驗 `role === subagent_type`（fork 改驗 `instance_mode: fork`）；Codex 由 hook 驗 `role === agent_type`（限閉集角色名，`host-verified`）；自訂 agent 名或 opaque 載體 `[cooperative-only]`＋named gap `codex-role-carrier-unverified` |

`change_id` MUST 過 `^[a-z0-9][a-z0-9-]{0,99}$` 且 `openspec/changes/<change_id>` 經 `lstat` 為非 symlink 目錄。change-less 變更（chore-A／lite stepwise 無 change folder）的 `change_id` 取值、兩條 binding 路與放行語意只定義在 `model-delegation.md` 的「Change-less 變更的 `change_id`」段，此處不另定義。Briefing 全文 ≤2000 tokens、reference-only（`model-delegation-token-efficiency.md` (l)(m)）。

**宣告路徑與 `execution_root` 契約**：session cwd 不是 `.worktree/<change_id>` 時，dispatch 的宣告需在六欄之外補 `change_id`（A2；A1 trusted `responsibility_id` 前綴、A3 `evidence_scope`／`return_and_stop` 段為替代來源，讀序 A2＞A1＞A3 且 A3 僅在 cwd 未解出 id 且 A2／A1 皆缺時單獨成立）與 `execution_root`。填值前以唯讀 helper 預解析，**不得手抄**：

```bash
node .devpro/scripts/resolve-admission-binding.mjs <change_id> --cwd <session-cwd> --json
# → { repoRoot, changeId, headSha, branch, execution_root }（唯讀、零 state；失敗輸出 { ok:false, code } 且 exit 非 0）
```

`execution_root` 直接複製 helper 的 `repoRoot`（= exact-one `.worktree/<change_id>` realpath）；`--binding-root` 僅為 optional pin，與解析結果不符即 `binding-root-mismatch`。宣告路徑的 binding root 與 execution root 都指向該 worktree 絕對路徑；child 的所有讀寫 MUST 在該路徑（`working_directory`／`git -C` 為執行面工具，非 binding authority）。session cwd 對齊（`EnterWorktree`／另開 worktree-rooted session／`session_move`）**不是 admission gate 條件**：留 primary 的 session 以 helper 預解析即可派送；成功 move 仍可作為執行面優選，但非必要。fail 訊息會附解析出的 absolute binding root 供修正重送；該絕對路徑永不落 record／telemetry／receipt payload。

**Active delegation fields**：
- **Dispatch completeness**: Artifact-producing dispatch MUST fail closed before spawn when the original briefing lacks `claimed_artifact_paths` or `first_artifact_deadline`; a post-dispatch follow-up MUST NOT retroactively cure that dispatch.
- `claimed_artifact_paths`：coding/authoring 首次有效落盤的具體 target path；`first_artifact_deadline`：可判定的交付期限。
- `first_persisted_artifact_type`：此 `first persisted artifact` 為 target file patch、failing RED test 或 repro evidence 三選一，MUST 對應 `claimed_artifact_paths` 與 `first_artifact_deadline`；只載入 skills/rules、探索、口頭 milestone 或 plan 都不算落盤（do not count）。
- `artifact_landing`：暫存與產物的落點依 `file-write-destinations.md`（TL-authored body 與 subagent 暫存用 main-checkout `notes/tmp/`；reviewer-owned sticky body 用 renderer 指定的 carrier）；briefing MUST 明寫落點，禁 repo root 或任何未宣告路徑。
- `deadline_miss_report`：若分類為 `artifact_landing_deadline_missed`，delegate MUST 立即 callback actual state、blocker、evidence 與下一 checkpoint；TL 只送一次 `focused scope convergence/rebrief`。單次 miss MUST NOT disable subsequent delegation。
- `takeover_authority`：`TL takeover/reassign` 仍須 interruption evidence 或 user explicit direction；deadline miss MUST NOT authorize automatic takeover。
- `callback-capable runtime` 使用 `completion_mode: callback`；`completion_channel` MUST name a real callback/event channel and is required。TL MUST register once that callback/event channel before waiting, then yield once；MUST NOT use `repeated short/intermediate timed waits`。
- `explicit no-callback runtime` 使用 `completion_mode: bounded_poll`，只可在 `runtime 明示無 callback` 時使用 bounded poll；MUST NOT fabricate or require a nonexistent `completion_channel`。briefing 必填 `no_callback_evidence`、`poll_interval`、`maximum_attempts`、`hard_deadline`；所有 `poll telemetry` 為 log-only / internal-only（lifecycle SSOT：`multi-agent-handoff.md`）。
- Any other `completion_mode`、missing or mixed branch fields、unclassified runtime 一律 FAIL CLOSED。

**dp-architect immutable dispatch**：`/devpro:change` 派 dp-architect 的 dispatch 欄位、`30m_total` 計時、first-artifact checkpoint、deadline miss 與 takeover 見 `model-delegation.md` 的 **dp-architect dispatch action point**（載入本檔前已讀）；independent design reviewer 的 no-write／no-claim 共存見 `multi-agent-handoff.md` §Artifact-first Delegation Liveness。

### 回報格式

**Subagent → TL**（≤500 tokens）：`status`、`summary`、`changes`、`issues`；Critical（build break/安全/設計矛盾）可超限，須以 `[CRITICAL]` 開頭。

- `delegated test/long command completion schema`：`started_at`、`ended_at`、`elapsed_ms`；callback 加 `completed_at`；TL 記 `callback_received_at`、`callback_delivery_latency_ms`，分開回報 execution duration 與 delivery delay（clock-domain 算術見 handoff SSOT）。

**TL → 使用者**：每步後必含 **結果** + **Next Step**；不可只轉述 subagent。

> Load-chain（委派後）：等待、status／rebrief、中斷、接手與 Subagent Artifact Landing Verification 在 `model-delegation-active-lifecycle.md`；dispatch 後要查狀態、中斷或驗收落盤前 MUST 先讀。
