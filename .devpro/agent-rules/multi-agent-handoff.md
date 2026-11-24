---
name: multi-agent-handoff
description: 多 Agent 協作交接規範：4 狀態狀態機（ready/wip/handoff/done）+ tasks.md 格式 + commit convention + 中斷 recovery。觸發：同一 OpenSpec change 由多 agent 分工、session 開始時在非 main 分支且有 tasks.md。
---

# 多 Agent 協作（Multi-Agent Handoff）

## Overview

**git + OpenSpec（`tasks.md`）是唯一共享狀態**；禁依賴 agent memory、session 或專屬工具。中斷韌性依「開工第一動作」+「小步 commit」，任何 agent clone 後可由 `tasks.md` 恢復。

## When to Use

- 同一個 OpenSpec change 由多個 AI agent 分工完成
- Planner 或使用者明確指派 task 給特定 agent
- 使用者在不同 AI 工具間切換繼續同一份工作
- Session 開始時在非 main/master 分支且該 change 有 `tasks.md`（必須先跑 Recovery Checklist）
- **跨 cmux 頁籤／surface／視窗 session 溝通或交接**（含「能不能跟另一個頁籤的 Codex／claude-code host 說話」）→ 先載入 skill `cmux-surface-comms`（probe `command -v cmux`／可執行 fallback 後再回答可否；勿只查本 runtime session 清單就斷言不行）；使用者明示 herdr（含 Herdr app／`hc`），或未指名工具但 `HERDR_ENV=1` 或 `HC_TERMINAL_SOCKET` 有值 → 改載入 skill `herdr-pane-comms`（兩種形態都探測，任一成立就不得回報不在 herdr 內）

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for semantic execution |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


### Worktree 粒度（per change，per branch；非 per agent）

粒度 SSOT 為 `git-branch-naming-and-anchor.md`：**per change**（per branch），**不 per agent**。同一 change 串行 agents 共用 worktree+branch，以 git / tasks.md 交接；git 禁同分支在兩 worktree checkout，真正並行的無相依 task 須用不同分支/worktree。開工第一動作、小步 commit、Recovery Checklist 仍適用。

### Task Ownership 與狀態機

#### tasks.md 格式

```markdown
- [ ] [agent:assistant][status:ready] 實作 GET /api/users endpoint
  - 驗收：unit test 通過、回傳正確 DTO
```

#### 狀態機（4 states）

| 狀態 | 意義 | checkbox | 可轉入 |
|---|---|---|---|
| `ready` | 可認領，尚無 agent 開始 | `[ ]` | `wip` |
| `wip` | agent 正在處理 | `[ ]` | `handoff`、`done`、`ready`（衝突退回） |
| `handoff` | 當前 agent 完成其部分，待下一個 agent 驗證或接續 | `[ ]` | `wip`、`done`、`ready` |
| `done` | 驗收完成 | `[x]` | — |

#### 核心規則

- **開工第一動作**（強制）：改 `[status:wip]` + 寫一行「預計改動哪些檔案」，先 commit 此 tasks.md 變更，再開始寫程式碼
- **小步 commit**（強制）：每個 subtask 或邏輯單元完成就 commit，不累積一大包
- `[status:done]` 時 checkbox **必須**同步改 `[x]`；不一致視為中斷證據
- handoff 時在 task 驗收區補充交接資訊，不另開檔案；接手者開工時才改 `[agent:X]` 為自己
- **退回**：reviewer 不通過時改 `[status:wip]` + `[agent:X]` 改回原實作者，commit 用 `review(task-N)` prefix

#### handoff 交接資訊範例

```markdown
- [ ] [agent:assistant][status:handoff] 實作 GET /api/users endpoint
  - 驗收：unit test 通過、回傳正確 DTO
  - **交接**：
    - 改動：`src/Controllers/UsersController.cs`、`tests/UsersControllerTests.cs`
    - 驗證：`dotnet test` 全綠（12 passed, 0 failed）
    - 風險：未處理 pagination，留給下一個 task
```

### DAG 範例（多 agent 並行 task）

同一 OpenSpec change ≥3 個 task 且存在並行可能時，建議 `tasks.md` 開頭附 DAG 表格：

| Task | Owner | Depends-on | Artifact |
|---|---|---|---|
| T1 設計 schema | dp-architect | — | `proposal.md` Schema 段 |
| T2a 寫 migration | dp-programmer | T1 | `sql/<name>/up.sql` |
| T2b 寫 DTO | dp-programmer | T1 | `src/Dtos/*.cs` |
| T3 寫 controller | dp-programmer | T2a, T2b | `src/Controllers/*.cs` |

- T2a/T2b 無相依可並行；worktree 同分支不可同時 checkout（per `git-branch-naming-and-anchor.md`），實務上串行 commit
- Critical path：T1 → T2a → T3（T2b slack 可吸收）；慣例觀測點非強制，linear task 可省略

### Artifact Landing Verification

subagent／reviewer 的暫存檔與產物 MUST 落在 `file-write-destinations.md` 指定的落點（該表是路徑 SSOT；TL-authored body 與 subagent 暫存用 main-checkout `notes/tmp/`，reviewer-owned sticky body 用 renderer 指定的 carrier），MUST NOT 寫 repo root、worktree 內的隨手檔名或任何未宣告路徑。dispatch brief MUST 明寫落點；TL 收 handoff 時若見 root 或其他未宣告路徑的新檔，先移除並要求重派，不得 `git add -A` 帶進 PR。

handoff / done 只描述 claimed artifact paths 不足以改 task 狀態。TL 接受 subagent handoff 前 MUST verify artifact landing verification：先跑 `git status --short`，再對每個 claimed path 用 `test -f <path>`（新檔）或 `git diff --name-only` / `git diff -- <path>`（更新檔）確認。缺檔或無 diff evidence 時，handoff 視為 `partial` / `failed`，TL MUST NOT move tasks.md 到 `[status:done]`、不可勾 `[x]`、也不可宣告 PR readiness；先重派、補寫、或記錄 fallback。

### Artifact-first Delegation Liveness

Artifact-producing briefing MUST 在 spawn 前包含 `claimed_artifact_paths` 與可判定的 `first_artifact_deadline`；期限可用絕對時間、相對分鐘或 execution turn，禁只寫「儘快」。它是 artifact checkpoint，不是 stall evidence。

- **Single-writer lease**: Canonicalized claimed paths with exact or ancestor/descendant overlap MUST have at most one active write owner; retry, replacement, or second architect labels MUST NOT grant authority; an owner that is running or has current progress/ETA MUST NOT be reassigned.
- **Concurrent overlapping ownership（pointer）**: 同時同 scope 預設 1 write-capable + 1 RO；例外欄位與 fail-closed → `model-delegation.md` Concurrent Overlapping Ownership Cap。
- **Shared-host process signal（pointer）**：對共享主機上非本 shell child 送 `SIGTERM`／`kill`／`pkill` 前，MUST 先證明 cwd 或 parent/session/surface ownership；argv／時間重疊單獨不足 → fail closed。SSOT：`ai-autonomy.md` §Shared-Host Process Signal Ownership。
- **Named scope handoff + ownership-overlap gate**：具名交棒前，outgoing owner MUST 達 safe stop、釋放 overlapping write lease，並通過 ownership-overlap gate（shared paths／branch／workflow dependency／external state／lease conflicts）。衝突未清 → **fail closed**，禁 transfer。Handoff record MUST 含 exact scope、new owner、branch、evidence、pending、unblock。Named handoff ≠ full session stop，且 **MUST NOT** 暗示未授權 git／GitHub／cross-repo write。Capsule 機械細節 pointer：`session-pending-lifecycle.md`（本檔擁有 overlap／lease 契約）。
- **Unsolicited status narration（pointer）**：節流規則 → `workflow-cost-controls.md`；machine／CI／user-ask／stop-point 豁免。

Coding/authoring 的 `first persisted artifact` 只可為 target file patch、failing RED test 或 repro evidence，MUST 位於 `claimed_artifact_paths` 並受 `first_artifact_deadline` 約束；skills/rules loading、探索、口頭 milestone 或 plan 不算落盤。

Delegate 遇到第一個障礙時 MUST NOT 立即放棄；先在 scope 內試 bounded `safe alternative path`。無安全替代則保留有效 partial artifact/repro evidence 與理由。不得為滿足 deadline 落下結構無效、跨 carrier 不一致或無法通過適用 strict validation 的半成品；無有效 checkpoint 則回報 progress 並延後落盤。僅附 blocker、已試替代（或無安全替代理由）與 artifact/evidence 才可回 `failed` / `partial`，否則不得視為 terminal。

TL 等待 agent 的預設是 runtime completion callback/event-driven notification：dispatch 後繼續可獨立進行的工作或一次 yield，讓 progress/checkpoint/terminal callback/event 喚醒；MUST NOT 用 `periodic polling/list-agents busy wait` 反覆查狀態。只有收到 `checkpoint`、`handoff` 或 `done` claim 後，TL 才執行 §Artifact Landing Verification；callback prose 不取代檔案/diff 證據。deadline/timer event 只觸發交付契約檢查，不把 active execution 偽裝成 completion acceptance。

只有 runtime 明確沒有 completion callback/event，且該任務確實需要主動監控，才可用 briefing 先定義的 interval、maximum attempts 與 hard deadline 做 bounded poll；未界定上限的 poll、以 list-agents 反覆探活、或無新 evidence 的 busy wait 一律禁止。

若 `first_artifact_deadline` 到期仍沒有有效 checkpoint claim 與落盤，分類為 `artifact_landing_deadline_missed`；這是交付契約 miss，MUST NOT 單獨分類成 verified stall、agent unavailable、terminal failure，或授權中斷／重派／TL fallback。Delegate MUST 立即 callback actual state、blocker、evidence 與下一 checkpoint；TL 只送一次 `focused scope convergence/rebrief`，且單次 miss MUST NOT disable subsequent delegation。

`TL takeover/reassign` 仍須 interruption evidence 或 user explicit direction；deadline miss MUST NOT authorize automatic takeover。只有 `checkpoint` / `handoff` / `done` claim 缺少檔案或 diff 時才依 §Artifact Landing Verification 判為 partial/failed；接手或重派仍須符合 §Delegated Task Interruption Evidence Gate 的 user replacement、safety/scope violation、terminal runtime failure 或 verified stall 條件。

- `artifact_landing_deadline_missed` requires an actual state callback and exactly one focused rebrief to the same writer; it MUST NOT authorize a second writer, takeover, or TL fallback.
- A dp-architect takeover requires authorization from explicit user replacement or independently sufficient terminal/interruption evidence; the takeover MUST then revoke the original writer lease; after revocation it MUST confirm the original writer inactive; only then, and never before, may it create the ownership-transfer record. Missing or reordered steps MUST FAIL CLOSED.
- An independent design reviewer MAY coexist only with explicit no-write/no-claim and MUST NOT acquire a writer lease.

#### Callback Delivery Control Plane

- `callback-capable runtime`：`completion_mode: callback`；`completion_channel` MUST be real and required。TL MUST register once it, then yield；MUST NOT use `repeated short/intermediate timed waits`（包含 `wait_agent`）模擬 callback delivery。dispatch 後可做獨立工作，但不得以短 timeout loop 取代 event channel。
- `Meaningful transition gate`：`wait timeout`、`no callback yet`、unchanged poll sample 都是 internal telemetry，MUST NOT 成為 user-visible progress/update。只有 new artifact/checkpoint evidence、blocker/decision、completed/terminal 才可對使用者更新；相同狀態樣本不得偽裝成新進度。
- `explicit no-callback runtime`：`completion_mode: bounded_poll` 只可 bounded poll；MUST NOT fabricate/require nonexistent `completion_channel`。必填 `no_callback_evidence`、`poll_interval`、`maximum_attempts`、`hard_deadline`；poll telemetry 為 log-only / internal-only。hard deadline 不自動等同 terminal failure；仍依既有 evidence gate 分類。
- 其他 `completion_mode` 或 missing/mixed/unclassified branch：FAIL CLOSED。
- `delegated test/long command completion schema`：delegate 記錄 `started_at`、`ended_at`、`elapsed_ms`，callback terminal report 另帶 `completed_at`。TL 收到 callback 時記錄 `callback_received_at`、計算 `callback_delivery_latency_ms`，並把 `elapsed_ms` 當 execution duration、把 callback latency 當 delivery delay 分開回報。
- 若 clock domains differ，TL MUST NOT subtract 不同 clock domain 的 wall-clock timestamps；改用 runtime monotonic evidence，或明示無法可靠計算 delivery latency。
- 本段是 cooperative rule guard；現有跨 runtime rule/test 只能鎖 operative wording，MUST NOT 宣稱為 runtime hard enforcement。若 runtime 能提供機械式 event registration evidence，可再加 adapter-specific gate，但不得反向弱化本段。

### Finding Verification（fan-out 判斷回源核對）

Artifact Landing 只驗「檔案落地」，**不驗 finding 判斷內容**。當 subagent 的 artifact 是**分析式 finding**（audit / review / explore 回報的 bug / 孤兒 / 不合規 / 缺口 / 「檔案不存在」等判斷）時，TL 在**採信或據以動工前** MUST 逐項對源頭回查（讀該 file:line、實跑重現命令），駁回誤報，只保留實查存活的 finding。subagent 的敘述（含「我 grep 過 / 我確認過」）一律視為 **hypothesis**，非 evidence——與 `pr-review-evidence-verification.md` 對 contributor 聲明的同一原則，適用面擴及**任何 fan-out subagent finding**（不限 PR review）。未回源即採信 = 把二手判斷當事實，屬 §0 追溯性違規。實證：rationalization audit 的 fan-out agent 曾系統性把合規 load-chain sibling 誤判為孤兒、把存在的檔報成「不存在」；未逐項回源即會據誤報動工。**這條同樣約束 TL 自己記下的靜態 finding**：動工前先實跑重現，勿信記憶敘述。

### Multi-Agent Pattern Decision Table

TL 分派前先選協作 pattern；pattern 只決定工作流，不豁免本檔狀態機、worktree 規範或測試 gate。

| Pattern | 1 句定義 | 觸發條件 | 推薦 model 分配 | 風險 | 我們的實例 |
|---|---|---|---|---|---|
| Fan-out | 1 個 TL 拆成 N 個獨立讀取/檢查 task | 多檔案搜尋、互不相依、可平行驗證 | TL 高推理層；子任務低機械層或中執行層 | 重複讀檔、輸出格式不一、同分支 worktree 不能同時 checkout | TL 指派多個讀取 task；dp-explorer 做多檔讀與 grep map；若需真正並行實作，拆分支/獨立 worktree |
| Alternatives | 相同 brief 的完整候選，經比較選出 coherent base | 持久介面／ownership 有實質未解取捨；不是 disjoint coverage | 依既有 admission 與能力選擇；不固定模型、不自動 spawn | 強制拼接破壞整體、候選偷看彼此而失去獨立性 | TL 依 caller、資料與約束比較完整方案，必要時才委派 |
| Pipeline | 前一 agent 的 artifact 是下一 agent 的輸入 | discovery → design → implementation → review | Stage 0 可用低機械層；設計用高推理層；實作用中執行層 | 前段輸出不清會放大 downstream 錯誤 | dp-explorer stage-0 探勘 → dp-analyst → dp-architect → dp-programmer → dp-reviewer |
| Hierarchical | Planner 拆 task，worker 執行，TL 聚合 | scope 大但子任務可明確分界 | Planner 高推理層；worker 中執行層 | Planner 把相依 task 錯分給不同 worker | TL → dp-architect 規劃 → dp-programmer 執行 |
| Consensus | 多 reviewer 對同一 artifact 各自判斷，由 TL 核證裁決 | 高風險 PR、架構決策、security-sensitive diff | 至少一個高推理層 reviewer；可搭配不同 runtime | 成本高；未解產品／授權取捨需人類仲裁 | primary + second reviewer 獨立回報，TL 逐項 disposition；merge gate 沿 `code-review-cross-model.md` |
| Advisor | 主 agent 持續工作，旁路 agent 只回答窄問題 | 單點疑難、需要第二意見但不需完整交接 | 主流程依任務；advisor 用高推理層或低機械層 | advisor 回答被過度當成授權 | TL 諮詢 dp-architect 做高 effort decision；或讓 dp-explorer 做一次性 lookup |

**完成條件依目的分型**：候選比較 MUST 選一個完整基底，其他優點只在理由成立時合併並驗整體；覆蓋調查 MUST 將未回報切片標為缺口，不能當完整；獨立審查的 TL MUST 回源核對後逐項裁決 finding，保留來源與理由，不自動套 patch。MUST NOT 以多數票駁回已證實的單一安全 finding，或以 TL 裁決繞過既有 review／merge gate。

### Commit Convention

| Prefix | 格式 | 語意 |
|---|---|---|
| `wip(task-N)` | `wip(task-N): <agent> — <描述>` | 中間快照；同一 agent 可能續做或已中斷 |
| `handoff(task-N)` | `handoff(task-N): <from> → <to>` | 計畫性交棒 |
| `done(task-N)` | `done(task-N): <reviewer> — <結果>` | 驗收完成 |
| `review(task-N)` | `review(task-N): <reviewer> — <原因>` | 退回修改 |
| `escalate(task-N)` | `escalate(task-N): <A> vs <B> — <爭點>` | 升級給人類 |

**最低要求**：commit message 包含上述關鍵字（無 pre-commit hook 前為 SHOULD）。

追蹤：`git log --grep='wip\|handoff\|done\|review\|escalate' --oneline`

**Staged area 檢查**（MUST）：打 `wip` commit 前執行 `git status` 確認 staging area 只含本 task 改動；無關檔案先 `git reset HEAD <file>`。

### Recovery Checklist（非自願中斷接手）

接手 agent 開始工作前**必須**依序執行：

1. `git status`：檢查未 commit 改動；有殘留先 `git diff` 判斷，再決定保留或捨棄
2. `git stash list`：檢查有無 stash 半成品
3. `git log -5 --oneline`：尋找 `wip(...)` prefix
4. 檢查 `tasks.md` 狀態一致性（以 `git show HEAD:tasks.md` 為基準）：
   - `[status:wip/handoff]` → 讀交接資訊
   - `[status:done]` 但 `[ ]`（或反之）→ 視為中斷，需驗證
5. `git diff HEAD~1`：從改動本身推斷前一個 agent 進度

**Stale WIP 偵測**：開始新工作階段時建議先執行 `grep -n '\[status:wip\]' tasks.md`；若發現非自己的 wip task，透過 `git log` 判斷最近 commit 時間，提醒使用者。

**Subagent 誤寫進 protected branch 的 recovery**：若步驟 1 `git status` 發現髒檔落在 protected branch（`main`/`production`/...，而非自己的 worktree）—— 即 agent/subagent 誤寫 protected branch —— 走 `git-branch-hygiene.md` §Protected-branch Agent Miswrite Recovery 的 4 步階梯（agent-owned + 已 merged 判定 → `git pull --ff-only --autostash` → 未 merged 走 fix branch 不 bypass → 破壞性前須使用者同意）。括號內為 keyword 摘要，與 SSOT 牴觸時一律以 `git-branch-hygiene.md` 為準；本檔不複寫判定原文。

### 分派原則

- 被分派 task 的 agent 必須具備 `git-ops` 能力，否則無法操作狀態機
- TL 分派並行 task 前**必須**分析 task 間介面相依性（critical path）；**禁止**同時分派存在直接相依的 task 給不同 agent
- 分派時在 task 描述中標注相依關係（例：`depends-on: task-2.4`）
- **責任 thread**：thread key＝(change, role, `responsibility_id`)（SSOT `model-delegation-threads-and-caps.md`）；同角色不同責任不得共用 thread；續作用 `continue`，換手記 `replacement_reason`
- **Fan-out＝獨立性**：只在子任務彼此獨立、各有自己的 `responsibility_id` 且可平行驗證時 fan-out；平行度本身不是委派理由
- **結構上限（handoff 面；SSOT `model-delegation-threads-and-caps.md`）**：nested 0 依該表；同時 active ≤2 為 `[cooperative-only]`——env 只限 Agent-tool 新 spawn，resume／`SendMessage`／`/subtask`／ultracode 不受檢查，違反由 lineage telemetry（`peak_runtime_native_concurrency`）事後揭露，handoff 記錄 MUST NOT 寫成 runtime 已擋下

### Codex runtime 授權投影

`model-delegation.md`是跨runtime admission SSOT：`≥2檔 Edit/Write`、`≥2步非判斷性工作`等shape只要求benefit/cost與context-mode判斷。admission通過或workflow明定mandatory role後才形成`RepoDelegationAutoAuthorization`。Codex另需explicit trigger時，使用者明確要求subagent／delegation／parallel work或選擇明示bounded launch的選項，才形成`StandingDelegationAuthorization`；`go`、`依repo規範`或same-session correction不單獨滿足。缺trigger進`SubagentAuthPending`問一次，不是`subagent=no`或TL fallback；只有拒絕、能力缺失、授權後不可用或terminal failure才走adapter fallback mapping。

TL-selected wait/poll timeout MUST NOT count as runtime terminal timeout; a TL-caused interruption MUST NOT count as call failure or trigger fallback, and MUST first follow the recovery path in `model-delegation-active-lifecycle.md`.

> Load-chain（on-demand siblings）：`model-delegation.md` 的 MUST-delegate 細則在 `model-delegation-delegation-rules.md`；token 效率規則在 `model-delegation-token-efficiency.md`；Briefing 模板 / 回報格式在 `model-delegation-briefing.md`。

### 驗收測試節奏（pointer → test-suite-cadence）

任何涉及 source code / rule file 的 task 回報完成前，被委派 agent **必須**依 `test-suite-cadence.md` 跑 focused RED／GREEN + required lint（claimed carriers）。**本檔 MUST NOT** 另立 worker `--tier all` 強制政策正文。`--tier all` 僅保留給 `test-suite-cadence.md` 已列之 release／全量／明示例外；final change-scoped suite（預設 `--changed main`）由單一 canonical owner 在 final tree 跑一次。

**反例**：主 agent prompt 寫「驗收：跑 X.test.mjs」，被委派 agent 只跑 X 全綠就回報 OK，但同批 carriers 的必跑 lint／focused suite 沒跑 → 問題延後暴露。

**正確**：指定 test 綠燈後，依 test-suite-cadence 完成 worker 義務再回報；全量 `--tier all` 不是預設 worker gate。

#### 執行位置回報（強制）

回報測試或 validate 結果時，**必須**附上執行位置佐證，防止「在主 repo 跑、卻宣稱 worktree 結果」的假綠：

```
pwd: <絕對路徑>
branch: <git rev-parse --abbrev-ref HEAD 輸出>
```

**反例（本 session 實踩）**：dp-assistant 在主 repo（`main`）跑 `node --test .devpro/scripts/tests/`，回報 2420/2420 pass；但 worktree 分支（`chore/fix-session-audit-enforcement-gaps`）實際有 1 個新 test fail（2425 tests, 1 fail）。缺執行位置欄，TL 無從辨別，假綠延後暴露。

#### Agent Capability Matrix（參考，最終以當前 runtime 實測為準）

| Agent | shell | file-rw | git-ops | spec-flow | review | test-run | web | delegate |
|---|---|---|---|---|---|---|---|---|
| Subagent CLI host | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| dp-explorer | ✗ | read-only | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Others (IDE assistant / CLI agent) | ✓ | ✓ | ~ | ✗ | ✗ | ~ | ~ | ✗ |

> Others-runtime 之具體 Capability snapshot 見對應 `platform-adapters/<runtime>.md`。

`dp-explorer` 是低機械層 search/explore/map agent；read-only = `Read` / `Grep` / `Glob` only。

`~` = 依當前 runtime / integration 功能而定；TL 分派前先以最小探測確認（例如：是否可跑 shell、是否可做 git-ops、是否可執行測試）。

### Violation Recap Mini-Template（交接時使用）

當 handoff 的 task 期間發生 Core Contract 違規，接手 agent **MUST** 在 tasks.md 的「交接」區補充 Violation Recap，格式如下：

```markdown
- **Violations（本 task 期間）**：
  - [VT-<代號>] 場景：<簡述觸發情境>
    觸發規則：<leaf 名稱> §<節名>
    預期行為：<規範要求的行為>
    實際行為：<前一個 agent 實際做了什麼>
    修補提案：<已修補 / 待下一個 agent 修補 / 需升級人類>
```

若本 task 期間無違規，填 `- **Violations**：無`（不得省略此欄位，空欄意味資訊遺失）。

**Violation Recap 的用途**：
1. 接手 agent 能快速判斷前一個 agent 是否有未處理的違規殘留。
2. Session Recap 的「AI 反思」欄位可引用此記錄，提供具體證據。
3. Pilot adapter 週回顧時，從 tasks.md 彙整所有 VT-* 記錄進行統計分析（當前 pilot 流程見 `platform-adapters/cursor.md` Pilot operations 段）。

### 衝突升級

- 可由現有證據解決的技術分歧由 TL 回源核對、逐項裁決；不是按票數表決，也不是授權 implementer 自改設計。
- 產品方向、授權、越界或核證後仍未解的實質取捨升級給人類；禁止 agent 之間無限 ping-pong。
- 升級時在 tasks.md 標注分歧內容，改 `[status:ready]` + 移除 `[agent:X]`，commit（prefix `escalate(task-N)`）

### 併發控制

每次 push 前必須 `git pull --rebase`。Race condition：先 push 成功的 agent 贏；後到者 `git rebase --abort` → 改認下一個 ready task。

原始碼 conflict 即使看似 trivial 一律升級給人類：
1. `git rebase --abort`
2. `git branch task-N-backup`（備份）
3. `git reset --hard origin/<branch>`
4. 只改 tasks.md 標注衝突 → commit `escalate(task-N)` → push

## Exit Criteria

- 每個 task 開工前已執行「開工第一動作」commit
- handoff 時交接資訊已寫入 tasks.md 驗收區
- `[status:done]` + `[x]` 一致
- 非自願中斷接手時 Recovery Checklist 5 步已完成

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「我自己處理完再交接，不用動 tasks.md」 | 沒有開工 commit，中斷後下一個 agent 無法判斷前一個 agent 的意圖，recovery 成本倍增。 |
| 「這個衝突看起來很簡單，agent 自己解就好」 | 原始碼 conflict 一律升級；試點期間保守，避免語意衝突被誤判為 trivial。 |
| 「一起 commit 比較乾淨，不用分那麼細」 | 大包 commit = 中斷時 working tree 殘留多，recovery 複雜度高。小步 commit 是中斷韌性的主要防線。 |

## Verification

```bash
# 確認協作鏈完整（含中斷點與退回）
git log --grep='wip\|handoff\|done\|review\|escalate' --oneline

# 確認 tasks.md 中狀態一致性
grep -n '\[status:wip\]\|\[status:handoff\]' tasks.md

# Staged area 檢查（wip commit 前）
git status && git diff --staged
```

人工檢查項：
- tasks.md 所有 `[status:done]` 的 task checkbox 皆為 `[x]`
- handoff task 的驗收區有填「改動 / 驗證 / 風險」三項

## Subagent Status Vocabulary

5 詞 canonical 集（`finished` / `blocked` / `failed` / `questions` / `partial`）是所有 dp-* subagent terminal status 的單一事實來源。借鏡 oh-my-codex STATE_MODEL.md「Terminal lifecycle outcome compatibility」設計，將 lifecycle outcome 與 mode-phase 切割——每個 subagent 採用集合的子集，禁止在 subagent definition 單方面新增詞彙。

### When to Use

- 新增/修改任一 dp-* subagent definition 的 Communication Protocol → Output 段
- 主 agent 解析 subagent 回報 status 並做後續路由判斷
- 撰寫 IO contract test 驗證 subagent definition 是否符合 vocabulary 約束

### Canonical 5 詞語意定義

| 詞 | 語意 | 主 agent 處置 |
|---|---|---|
| `finished` | 任務完成且通過 | 繼續主流程下一步 |
| `blocked` | 有阻擋條件，PR/流程不可前進 | 停下回報使用者修阻擋條件後重跑 |
| `failed` | 任務嘗試但失敗（測試紅、pre-flight 不過） | 主 agent 介入決策 |
| `questions` | 有需使用者確認的待澄清項 | 向使用者確認後重呼 |
| `partial` | 完成不完整（語意分流見「Polysemy of partial」段） | 視 schema 欄位（important_findings / 未處理項）決定 |

### 5 個 subagent 子集對照表

| Subagent | 允許的 status | 對映原舊詞 |
|---|---|---|
| dp-analyst | `finished` / `failed` / `questions` | PASS / FAIL / QUESTIONS |
| dp-architect | `finished` / `questions` / `failed` (new-mode Need dissent; malformed failed is still `failed`, not a sixth token) | PASS / QUESTIONS |
| dp-reviewer | `finished` / `blocked` / `partial`（在 `verdict` 欄） | PASS / BLOCK / PASS_WITH_IMPORTANT |
| dp-programmer | `finished` / `failed` / `partial` | OK / FAIL / PARTIAL |
| dp-assistant | `finished` / `failed` / `partial` | OK / FAIL / PARTIAL |

### Polysemy of `partial`

- Reviewer 語意：完成且通過但有非阻擋建議（原 `PASS_WITH_IMPORTANT`）
- Programmer / Assistant 語意：完成部分工作須續做（原 `PARTIAL`）
- 共用同一詞，**語意分流靠 schema 欄位**：
  - Reviewer 的 `partial` **必含 `important_findings[]` 非空**（reviewer-specific guard；空陣列等於 `finished`）
  - Programmer / Assistant 的 `partial` 必含「未處理項」markdown 段
- 不引入第六詞——5 詞集 + reviewer guard 已足夠涵蓋。

### Main Agent 解析守則

- 收到 `finished` → 繼續主流程
- 收到 `blocked` → 停下回報使用者
- 收到 `failed` → 主 agent 介入決策（重試 / 補資訊 / 重新設計）
- 收到 `questions` → 向使用者確認 pending_questions 後重呼 subagent
- 收到 `partial` → 檢查 schema 欄位（important_findings or 未處理項）決定後續

### Subagent Status Vocabulary Exit Criteria

- 5 個 subagent definition 的 Communication Protocol → Output 段含且僅含對照表中允許的子集詞
- `.devpro/scripts/tests/subagent-status-vocabulary.test.mjs` 綠燈
- AGENTS.md 觸發式載入索引含本 leaf row

### Subagent Status Vocabulary Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「PASS_WITH_IMPORTANT 語意特殊，不要併入 partial」 | partial + important_findings[] 非空 schema guard 已足以區隔，引入第六詞徒增 TL 解析複雜度 |
| 「subagent 用什麼詞各自決定就好」 | 主 agent 解析負擔 = 5 詞 vs 3 套不同詞彙；canonical 統一是 ergonomic 投資 |
| 「我這個 subagent 想加新詞」 | 任何新詞須先擴充本 leaf 與測試 allowlist，禁止僅在 subagent definition 單方面新增 |

### Subagent Status Vocabulary Verification

```bash
# 本段 H2 段數應為 8（含 Subagent Status Vocabulary 本身及其子段）
grep -c "^## " .devpro/agent-rules/multi-agent-handoff.md

# 5 個 canonical 詞每個都在 Subagent Status Vocabulary 段出現
grep -E "finished|blocked|failed|questions|partial" .devpro/agent-rules/multi-agent-handoff.md | wc -l

# 機械式驗證 → 跑專屬測試
node --test .devpro/scripts/tests/subagent-status-vocabulary.test.mjs
```
