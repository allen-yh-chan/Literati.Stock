---
name: platform-adapter-claude-code-capabilities
description: "Claude Code 能力清單（Load-Plan / Syntax Validation / Cross-Review Reminder / User-Invocable / Cache-Friendly / Reasoning Depth / Usage Telemetry）。觸發：devpro:load-plan 或需要驗證某項 capability support 狀態時；一般 session 不載入。"
---

# Platform Adapter：Claude Code Capabilities

先讀 `platform-adapters/claude-code.md`（active adapter entry leaf）。本檔是 on-demand capability inventory，只在 `devpro:load-plan` 或需要核對某項能力 support 狀態時載入，不隨 adapter 每 session 載入。能力真值仍以 `platform-adapter-contract.md` 四探測為準；本檔列各能力的具體實作落點。

## When to Use

- `devpro:load-plan` 列能力清單時
- 需要查某項 Claude Code capability 的 support 狀態 / 實作落點時

## Capabilities

### Load-Plan Capability

**Support**: fully implemented。`devpro:load-plan` 列 AGENTS.md loaded sections、trigger index leaf、commands、agents、hook scripts 與 `.claude/settings.json`，並用 `[loaded]` / `[on-demand: <trigger>]` + `Math.ceil(bytes / 3.5)` 呈現。

### Edit-Time Syntax Validation

**Support**: fully implemented。`.claude/settings.json` 的 `PostToolUse` 對 `Edit|Write|MultiEdit` 註冊共用 `.devpro/scripts/hooks/post-tool-gate.mjs`；該 hook 對 `.sh` / `.json` / `.mjs` / `.py` 做 fail-open syntax validation，只警告不擋 edit。

> _Anchor: 截至 2026-05，本 repo Claude Code hook config 可對 `PostToolUse` + `Edit|Write|MultiEdit` matcher 執行 `post-tool-gate.mjs`；syntax lint scope 由 `post-tool-gate-lint-extension.test.mjs` 鎖定。_

### Pre-commit Cross-Review Reminder

**Support**: fully implemented。`.claude/settings.json` 的 `PreToolUse` / `Bash` 註冊 `.devpro/scripts/hooks/commit-soft-nudge.mjs`；該 hook 對 rules sync SemVer 豁免分支 silent exit 0，其他 `git commit` stderr 提醒先跑 `/devpro:cross-review`，且永遠不阻擋 commit。

### User-Invocable Command/Skill Capability

**Support**: fully implemented。skill-only 觸發模型：`.devpro/agent-skills/<group>/<skill>/SKILL.md` 為內容 SSOT；`devpro:load-plan` skill 會列出 skills 與 on-demand 條件。`.claude/skills/devpro`（及 `.agents/skills/devpro`）以 relative symlink 指向 catalog root `.devpro/agent-skills`——**禁**在這兩個目錄放 catalog skill 的副本或 per-skill link；consumer 自建 skill 放 `.claude/skills/<own-name>`，由 sync 保留（治理見 `agent-skill-governance.md`「Skill Cross-Platform Distribution」）。`.cursor/skills/` 已退役，不再是 discovery root。Claude Code 把該 entry 註冊為 `devpro@skills-dir` plugin，只在已信任的 workspace 載入；同 repo 的 git worktree 沿用信任。未信任的 checkout（含 headless `claude -p`）看不到 `devpro:*`，要先接受 workspace trust。舊 per-skill link 不受此限，屬本拓撲的已知取捨。

> _Anchor: 截至 2026-07，`/dp:*` 冒號式 slash command manifest 已廢除；`/devpro:<name>` 與自然語言 auto-load 走 `.claude/skills/devpro` entry（→ `.devpro/agent-skills`＋`.claude-plugin/plugin.json`）解析同一份 skill，為唯一跨平台 first-party 入口。_

### Cache-Friendly Design Metric

**Support**: 官方確認。API usage 以 `cache_read_input_tokens` 觀察 cache hit，並以 `cache_creation_input_tokens` 觀察新建 cache；CLI session 若未露出 raw usage，改用對應 provider usage log / transcript telemetry 驗證，不可在 shared rule 寫死此欄位。

> _Anchor: 截至 2026-05 prompt caching docs，Messages API usage 內含 `cache_read_input_tokens` / `cache_creation_input_tokens`；本 adapter 承接 shared Cache-Friendly Design 的具體 metric。_

### Reasoning Depth Control

**Support**: fully implemented。5-tier mapping 與切換流程在 `platform-adapters/claude-code-effort-tiers.md`：low / medium / high / xhigh / max；互動 session 用 `/model <selector>`，新 process 用 `claude --model <selector>`。TL 預設 medium/high，release/security blocker 才升 max。

### Subagent Context Admission

**Support**: `Agent|Task` 為 mechanically enforced（有 live 攔截證據）；`SendMessage` 續作面為 **fixture-gated `[cooperative-only]`**——PreToolUse envelope 係由 runtime 暴露的 SendMessage tool schema **構造**而非實地擷取，本 repo 尚無 live capture，且 round-3 review F-r3-claude-sendmessage-carrier-evidence-asymmetry 判定「同 session 的 `Agent` 被擋」不具鑑別力（`Agent|Task` 在該 commit 之前即為註冊 matcher）。matcher token `Agent|Task|SendMessage`（`.devpro/scripts/hooks/lib/spawn-context-admission.mjs`）. 三種 dispatch 形狀共用宣告路徑（session cwd 非 `.worktree/<change_id>` 時六欄之外另帶 conditional `change_id`＋`execution_root`；全 role 含 fork／continuation 適用，讀序與碼群見下方 fresh 段）。三種 dispatch 形狀分述：

- **fresh（具名投影）**：`subagent_type` ∈ 七個 `dp-*`，isolated context；prompt 前 8 KiB／100 行 MUST 帶 admission record 六欄（`objective`／`responsibility_id`／`instance_mode: fresh`／`evidence_scope`／`return_and_stop`／`role`），hook 機械驗 `role === subagent_type`，通過即寫 `<change_dir>/admission-records/<record_id>.json`（`role_binding: host-verified`；`<change_dir>` 為 active `openspec/changes/<change_id>`，archive 後為 `openspec/changes/archive/<YYYY-MM-DD>-<change_id>`）並以 `additionalContext` 回傳 `admission_record: <record_id> sha256=<digest>`；缺欄／閉集外值／role 不符 → block。session cwd 非 `.worktree/<change_id>` 時走**宣告路徑**（全 host 一等公民；同一 resolver 與同一封閉碼群）：六欄之外在 `return_and_stop` 與 `role` 之間另帶 conditional `change_id`（A2；A1 trusted `responsibility_id` 前綴、A3 `evidence_scope`／`return_and_stop` 段為替代來源，讀序 A2＞A1＞A3）與 `execution_root`（全 role 必帶的 absolute binding worktree path，缺 → `execution-root-required`、realpath 不符 → `execution-root-mismatch`；兩值由唯讀 helper `resolve-admission-binding.mjs` 預解析），binding 由同 common-dir exact-one `.worktree/<change_id>` 決定；review role 無任何宣告可解時仍 `change-worktree-required` block，其餘 role 為非靜默 `binding-unresolved` advisory、不 mint、不得作 independence 證據；`EnterWorktree`／另開 rooted session 不是 gate 條件。change 資料夾 active 與 archive 兩處皆不存在（chore-A worktree；須 binding 已成立）則放行不寫 record，缺口記於 lineage telemetry，但存在卻是 symlink 仍 block。
- **continue**：`SendMessage` 到既有 agent id（`Agent` tool 無 `resume` 參數）。`SendMessage` 也承載一般訊息，故宣告 **opt-in by carrier**：`message` 無 `instance_mode:` 行者不視為受管續作，不寫 record 也不 block；宣告 `instance_mode: continue` **且**同時帶至少一個其他 admission 欄時，才機械強制六欄＋conditional `parent_record_id`（parent record 的 id），通過即在新 head 寫 record（`role_binding: cooperative-only`）並回傳同一 handoff 行。目標 `to` 是 runtime 指派的 agent id、fresh spawn 當下無法預先綁定，故「訊息確實送到 parent thread 同一角色」為 `[cooperative-only]` 殘餘面；receipt 端（v2 與 v3）有 chain 驗證（同 change／role／`responsibility_id`、時序遞增、無循環、≤8 hop、根為 fresh），續作輪經 receipt 端 chain 驗證可封存；未宣告的續作無法封存；`to` 取自原 spawn 回傳的 agent id、`parent_record_id` 取自同一 thread 上一輪已 admitted 的 record（首次續作為該 spawn 回傳的 record，其後為上一次續作訊息回傳的 record，不是每輪都回到 fresh 根）以縮小該殘餘面。非 `continue` 模式（例如整段引用 fresh dispatch block）與孤立一行 `instance_mode:` 一律放行不寫 record——本載體無法真的開 fresh／fork thread，那類文字是討論而非受管交接（round-3 F-r3-continuation-declaration-false-positive）。
- **fork**：`subagent_type: "fork"` 繼承 TL 全部 context；MUST 帶 `fork_reason:`（≤500 字元）＋六欄且 `instance_mode: fork`，record 標 `role_binding: cooperative-only`（fork 無具名角色載體）。fork mode 依 runtime 預設（design D3 Option A：不寫 user-local 設定、不加 project `Agent(fork)` deny，管制只落 hook admission）。`CLAUDE_CODE_FORK_SUBAGENT=1` 只是非互動 session 的明示開啟證據、`0` 為全 session 明示關閉，皆不選擇 gate 分支——分支由 `subagent_type` 決定，而 `fork_reason:` 仍只是 audit accountability，不是第二道 authorization。This is outcome/reason-visibility parity with Codex, not identical authorization strength：Claude 的 `role` 綁定 host-verified，Codex 的 `role` 只是宣告欄（`cooperative-only`，telemetry named gap `codex-role-carrier-unverified`）。

**併發／巢狀（本 repo 不設 user-local 值）**：`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 是官方 env，只限制 Agent-tool **新 spawn**（v2.1.217+）——resume／`SendMessage` 續作直接占 slot 不檢查、`/subtask` fork 不受阻、ultracode 豁免；`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 控制巢狀深度。本 repo 不再建議、檢查或寫入這兩個值（未設時沿用 runtime 預設，預設值不在官方 env-vars 頁載明、不在此固定），故「同時 active ≤2」與 nested 0 都是 `[cooperative-only]`，違反由 lineage telemetry `peak_runtime_native_concurrency` 事後揭露；具名 `dp-*` 投影 `tools` 省略 `Agent` 仍是 nested 的機械載體。`maxTurns` 為官方 frontmatter 能力，`[P2]` 候選、本 change 未採用（design D14）。

> _Anchor: 截至 2026-09-03，安裝版 Claude Code 2.1.259 二進位字串含 `CLAUDE_CODE_FORK_SUBAGENT`／`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`／`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`（各 5 處）、`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`（2 處，語意 unverified、不納入策略）與 `subagent_type: "fork"` 字面；不含 `forkMode`／`CLAUDE_CODE_FORK_MODE`。fixture `.devpro/scripts/tests/fixtures/claude-code-binary-strings.json` 記錄同一組計數，`claude-code-binary-strings.test.mjs` 以本行版本字面比對，不一致即紅。這兩個 env 不在官方 env-vars 頁，只見於 sub-agents 頁；版本字面只留本檔（design D5）。_

### Per-Session Usage Telemetry

**Support**: fully implemented。`report-session-token-usage.mjs --host claude-code` 解析同一個 session 的 transcript JSONL（`type:"user"` 真實 prompt 行切 turn、`message.id` 去重、subagent `meta.json` 終態行去重）與其中的 `type: "cost-state"` 行（取最後一筆 `totalCostUSD` → `cost_usd`，逐 model `modelUsage` 作外部對帳基準），輸出明細帳供 Recap `## Token 回顧` 填答。0 筆 cost-state、或某 model 出現在 cost-state 卻不在 transcript，皆具名進 `gaps`，不得靜默。真實輸入的 `message.content`：一般使用者手打的 prompt 是**純字串**，NOT 陣列；陣列只出現在 `tool_result`（或混合 `tool_result` + `text` 區塊）情境，兩種型別 reader 皆需處理。

`report-session-token-usage.mjs --host claude-code --session <root-id> --lineage` exposes evidence-backed relationship classes `fresh | fork | resume | nested | unknown`. Trusted manifest/transcript fields or exactly attributable Agent/Task edges may add a relationship; absence of resume alone MUST NOT guess fresh/fork. Resume snapshots dedupe by canonical session identity；nested edge若找不到 carrier加入 `claude-nested-lineage-unresolved`；ambiguous mode/layout/read failure保持 `unknown` 或 named gap並阻止 `lineage-complete`。

Claude and Codex share `devpro-lineage-usage-report/v1` claim dimensions、counts、per-metric reconciliation與 fail-closed degradation outcomes, not private transcript layout. The adapter emits only bounded metadata-derived relationships and sanitized summaries；raw local paths、email/account markers、secrets與 transcript body MUST NOT be output. Terminality without explicit closure stays `open|unknown`, and unavailable metrics remain typed N/A/unavailable rather than zero.

> _Anchor: 截至 2026-08-28（校正對照本機真實 `~/.claude/projects/**` 資料——`message.content` 的真實型別於此日期修正），Claude Code session transcript 位於 `~/.claude/projects/<url-encoded-cwd>/<session-id>.jsonl`（subagent 在 `<url-encoded-cwd>/<session-id>/subagents/`：現行 CC CLI 為平面檔 `agent-<id>.meta.json` + `agent-<id>.jsonl`；fixture／舊形狀為 `<agentDir>/{meta.json,transcript.jsonl}`），逐行含 `type:"user"` / `type:"assistant"` / `type:"cost-state"` 事件；`cost-state` 行帶 `totalCostUSD` 與逐 model `modelUsage`（`inputTokens` / `outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens`）。此格式非公開契約，可能隨版本變動；`report-session-token-usage.mjs` 對 root 不存在一律降級為 `{ available: false, reason }`，不拋錯。_
