---
name: platform-adapter-codex-workflow-capabilities
description: "Codex cold-path capability details for /dp workflow parity, Skills/Plugins vs deprecated Custom Prompts, load-plan, syntax validation, cache metrics, and reasoning effort."
---

# Codex Workflow Capabilities

## Overview

Cold-path capability detail for Codex `$devpro:*` workflow parity and support matrix. Load when implementing or auditing Codex user-invocable workflow behavior, not for ordinary repo edits.

## When to Use

- User invokes `$devpro:workflows` or asks about Codex `$devpro:*` parity
- Updating Devpro workflow skill carrier or Codex skill registration
- Auditing load-plan, cache metric, syntax validation, or reasoning depth capability support

## Process

### User-Invocable Command/Skill Capability

Support: fully implemented via repo-scoped skill parity, not native Codex slash-command registration.

Devpro `/dp:*` equivalents are now carried by each single-function skill under `.devpro/agent-skills/`, registered in `.devpro/agent-skills/manifest.json`, and exposed to Codex through the single `.agents/skills/devpro` entry (→ catalog root), so each skill is `$devpro:<name>`. `devpro:workflows` is a meta-index that routes command name to the owning single-function skill. `$devpro:workflows` and natural-language workflow requests are supported; direct `/dp:*` input may be intercepted by Codex UI as an unrecognized command and may not reach the model. Fallback when the skill is unavailable: read `AGENTS.md` trigger index and run the workflow steps directly.

### `$devpro:*` parity path

Devpro Codex workflow parity uses Skills / Plugins, not `~/.codex/prompts`.

- **Skills**: `SKILL.md` is the reusable workflow authoring format, can be checked into the repo, and supports explicit or implicit invocation. Each `$devpro:*` workflow has its own single-function skill source carrier under `.devpro/agent-skills/`; Codex discovers all of them through the `.agents/skills/devpro` entry. `.devpro/agent-skills/devpro-workflows/workflows/SKILL.md` remains as a meta-index that routes command name to the owning skill.
- **Plugins**: distribution unit for reusable skills when cross-repo distribution, multiple skills, app/MCP settings, or marketplace ordering are needed.
- **Custom Prompts**: compat-only path. `~/.codex/prompts/*.md` → `/prompts:<name>` may behave slash-command-like, but Custom Prompts are deprecated; do not build new shared Devpro workflow on them.

### Load-Plan Capability

Support: partial support, no built-in load-plan command. Codex host should echo loaded AGENTS sections and triggered leaf files at session start or on request. Fallback: TL manual summary using `AGENTS.md` trigger index, `rg --files .devpro/agent-rules .devpro/scripts/hooks`, and command/agent manifests if present.

### Edit-Time Syntax Validation

Support: implemented through `.codex/hooks.json` parity with shared `post-tool-gate.mjs` when the active host sends compatible hook payloads. If Codex host does not send post-tool payload, fallback is TL manually running the corresponding checker.

### Pre-commit Cross-Review Reminder

Support: partial/manual. Shared hook is `.devpro/scripts/hooks/commit-soft-nudge.mjs`; Codex may not hard-enforce it on every surface. Fallback: `git commit`前 manually decide whether `$devpro:cross-review` is required.

### Cache-Friendly Design Metric

OpenAI API usage observes prompt cache hit through `usage.prompt_tokens_details.cached_tokens` when raw usage is available. Codex host transcripts may not expose this; do not claim cache hit without host usage/trace evidence.

### Reasoning Depth Control

See `platform-adapters/codex-effort-tiers.md`: low / medium / high / xhigh. Codex CLI uses `-c model_reasoning_effort="<tier>"`. TL defaults medium/high; release/security blockers use xhigh when available.

### Subagent Context Admission

Support: mechanically enforced by the shared PreToolUse gate. Multi-Agent v2 `collaborationspawn_agent` defaults omitted `fork_turns` to full history, so omit/`all` requires `spawn-context-override.mjs --reason ...`; `none` and string integers `1..6` are direct minimum-sufficient modes. Legacy `spawn_agent`/`Agent` uses boolean `fork_context`; `true` requires the same override, false/omitted is fresh. Unknown/coerced shapes fail closed and require a redacted fixture + adapter/parser update, not coercion. The 2026-08-31 live probe is prior source evidence; committed fixtures replay it and MUST NOT be described as a new live spawn.

Admission record（`[cooperative-only]`；2026-09-03 live fixture 修訂）：codex-cli 0.152.1 的 PreToolUse payload 為 `collaborationspawn_agent` ＋ `tool_input` `agent_type`／`fork_turns`／`message`／`task_name`（fixture `codex-v2-opaque-message.json`）；`message` 到 hook 時是 opaque token（Fernet 形狀，明文只在 runtime 內），gate 對這種載體不寫 record、不擋、只回 advisory `codex-message-opaque`；`message` 為明文時才解析六欄，且 `agent_type` 為閉集角色名時 `role` MUST 相等（record 標 `role_binding: host-verified`），自訂 agent 名則維持 `cooperative-only`。原 2026-08-31 fixture 的「payload 沒有 agent 名稱欄」敘述已被本 fixture 取代。gate 只在 `message`／`prompt` 帶可讀文字時解析六欄（`objective`／`responsibility_id`／`instance_mode`／`evidence_scope`／`return_and_stop`／`role`）並寫 `<change_dir>/admission-records/<record_id>.json`（`<change_dir>` active-or-archived 解析同 Claude 分支；`role_binding` 依上述 `agent_type` 判定：閉集角色名 `host-verified`，其餘 `cooperative-only`）；無文字的 bounded dispatch 直接放行、不寫 record，缺口由 lineage telemetry（`admission-records-incomplete`／`codex-role-carrier-unverified`）事後揭露。`cooperative-only` 宣告 MUST NOT 被宣稱與 host-verified 綁定同強度。

Continuation 與 preload（2026-09-03 live fixture `codex-continuation-followup-task.json`，codex-cli 0.152.1）：同 thread 續作的 rollout `function_call` 名為 `followup_task`（model-visible `collaboration.followup_task`；引數 `message`／`target`，`target` 為子代 `agent_path`），等待為 `wait_agent`（`timeout_ms`）；每次 follow-up 在子代 rollout 產生一個新的 `task_started`／`task_complete` turn，子代 `session_meta.payload.source.subagent.thread_spawn` 帶 `parent_thread_id`／`depth`／`agent_path`／`agent_role`。續作 admission（D34，`[cooperative-only]`）：gate 的 agent matcher 含 `followup_task`／`collaborationfollowup_task`（後者套用 hook-visible `collaborationspawn_agent` 已示範的去點規則），走與 spawn 相同的 text-carrier 紀律——無文字不寫 record 也不 block、opaque 只回 advisory、明文且 `message` 帶 `instance_mode:` 行時才機械強制六欄＋`parent_record_id` 且 `instance_mode: continue`，record 標 `role_binding: cooperative-only`。兩種拼法皆無 PreToolUse payload fixture，故本面維持 fixture-gated `[cooperative-only]`；機械保證落在 receipt 端 chain 驗證。**實務可達性（round-3 review F-r3-codex-continuation-record-unreachable）**：唯一觀測到的 codex-cli 0.152.1 rollout 中，`followup_task` 的 `message` 到 hook 時**恆為** opaque token，因此 Codex 分支目前實際上永遠走 advisory 路徑、永不寫 record，Codex 的 continue receipt 今天無法封為 `runtime-agent`。條文寫成兩 runtime 對稱是為了在 plaintext carrier 出現時即時生效，**不**表示兩者今天能力相同。telemetry 以子代 turn boundaries 導出 `continuation_turns`（boundaries 缺失時記 `codex-continuation-unverified`，不得推論），`policy_mode` 由 parent `spawn_agent` 引數 `fork_turns` 經 `function_call_output.task_name`＝`agent_path` join 決定（`none`→fresh、整數字串／`all`→fork；無法 join 時 `unknown`）。preload：`[[skills.config]]` 只影響 skills listing（name／description／path），**不**把 SKILL.md 本文注入子代 context（子代回報 `skill_bodies_in_context: []`），故 `developer_instructions` MUST 維持完整角色邊界與 bounded reads、MUST NOT 改成 pointer-only；子代工具清單含 `collaboration.spawn_agent`，runtime 不擋巢狀。同時 threads 上限為 `[cooperative-only]`（本 repo 不再建議或檢查 user-local `[agents] max_concurrent_threads_per_session`，見 `platform-adapters/codex.md`）；Codex 無 depth 開關，nested 0 為 `[cooperative-only]`。

Declared path（全 host 一等公民；session cwd 非 `.worktree/<change_id>`；同一 resolver `resolveAdmissionBinding` 與同一封閉碼群，非 Codex 專有）：dispatch 於六欄之外帶 conditional `change_id`（A2；A1 trusted `responsibility_id` 前綴／A3 段為替代來源，讀序 A2＞A1＞A3）與 `execution_root`（absolute binding worktree path，全 role 含 fork／continuation 必帶；唯讀 helper `resolve-admission-binding.mjs` 預解析）；binding 由同 common-dir exact-one `.worktree/<change_id>` 決定，fresh／resume at worktree 不再是條件、cwd 不是 gate 條件。review／verify 無 binding 仍 `change-worktree-required` fail closed；其餘 role 為非靜默 `binding-unresolved` advisory、不 mint。尚無 change 的 audit-only 審查（方向／設計確認）不派 `dp-second-reviewer` subagent，由 TL 直接執行 renderer-owned runner；不得為了過 gate 建立空 worktree。**Opaque prepared-intent carrier 之誠實邊界**：其 message 對 hook 不可讀（above all the Codex prepared-intent message），`execution_root` 無法在 spawn 期機械驗證——TL 仍 MUST 於 message 帶 `execution_root`（cooperative），機械保證落在 host-matched intent tuple（`canonical_worktree_sha256`＋`head_sha`＋`change_id` revalidation）；本 adapter MUST NOT 宣稱該 opaque 載體已被機械驗證，殘餘記於 telemetry／ledger，不得敘事為全防。

Prepared intent 發行與唯一性（fix-codex-reviewer-intent-candidate-cap）：issuer `issue-codex-reviewer-admission.mjs --request` 綁的是 process cwd，main-rooted session MUST 先 `cd .worktree/<change_id>` 再執行（request 檔照舊放 main checkout 的 gitignored `notes/tmp/`）；從 main 執行得 `identifier-invalid`，stderr 有一行 process cwd 提示。之後由 main-rooted host 呼叫 `spawn_agent`，走全域 discovery。兩個唯一性契約：本地 fast path（host cwd 即該 change worktree）只在本地目錄判斷唯一——恰 1 份 live 即放行且不檢查、不消耗 sibling，0 份掉回全域，2 份以上 `intent-ambiguous`；全域 discovery 在同 common-dir 所有 linked worktree 合計恰 1 份 live 才放行，2 份以上 `intent-ambiguous`。兩個獨立預算：worktree 列表（含 main）上限 128、intent 目錄 entry（含 `.claim/` 與雜項，已 claim 的一張算 2）合計上限 8192，超過各回 `intent-candidate-limit-exceeded`／`intent-entry-budget-exhausted`，補救為使用者同意後依 `git-branch-hygiene.md` Local Worktree Hygiene 清除已合併的 worktree。

### Per-Session Usage Telemetry

Support: fully implemented. `report-session-token-usage.mjs --host codex` reads `<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl` (default root `~/.codex/sessions`; three levels of date subdirectories, NOT a flat `sessions/*.jsonl` — the reader walks the nested layout; filename contains the session id, and `CODEX_SESSION_ID` only resolves the exact rollout after passing the UUID-shape whitelist). Each rollout line's `type` is one of `session_meta` / `turn_context` / `response_item` / `event_msg`; `session_meta`'s session id and cwd live at `payload.id` / `payload.cwd`. Token usage events are `type: "event_msg"` records with `payload.type === "token_count"` and the counters at `payload.info` (`payload.info` MAY be `null` and is skipped, never treated as a zero-token turn). The reader streams the rollout once, groups `token_count` events by `task_started` / `task_complete` / `turn_aborted` turn boundaries, and takes the last event with a present `info.total_token_usage` as the session total. Within each turn, `項目` comes from the first non-system user `response_item` message (with `[spawn: <agent_type>]` appended when the turn issued `spawn_agent`, including `dp-*`); `耗時` comes from `task_complete.duration_ms` (or `turn_aborted`); `誰` stays `main` for all token rows in the caller rollout because `token_count` events belong to the parent session—child spend MUST be read from the child's own rollout via `--session <thread-id>`. Rollout files with no turn boundaries fall back to per-`token_count` rows (empty `項目` / `耗時`). Codex `input_tokens` already includes cached tokens, so the ledger's `input` column is `input_tokens − cached_input_tokens`; `reasoning_output_tokens` is a display-only breakdown of `output_tokens` and is never added on top. `cost_usd` stays `null` — Codex has no USD field. `cache_creation` stays `unverified-on-host`.

`report-session-token-usage.mjs --host codex --session <root-id> --lineage` uses `session_meta.payload.id` and `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` as direct edge evidence. Candidate discovery is root-anchored, newest-first, and spans 24 hours before through 24 hours after the root timestamp; file/byte/node/depth caps stop traversal with named gaps. Exact duplicate and fully evidenced shared-child edges count one `host:session_id`; cycle、identity collision、unresolved child、read failure 或 cap hit降級 coverage，絕不 fallback 成 unbounded whole-home scan。

Spawn observability is `complete | partial | unavailable`. `spawn_events=0` only supports `lineage-complete` when the bounded root rollout is completely readable; malformed、partial 或 unreadable evidence adds `codex-spawn-observability-unverified`. A positive spawn without a resolved child adds `codex-descendant-usage-missing`. Adapter output includes only canonical counts/metrics and sanitized named gaps—raw local paths, email/account markers, secrets, and transcript body MUST NOT be output. Without explicit closure evidence, terminality remains `open|unknown`; a completed turn alone does not prove `final`.

> _Anchor: 截至 2026-08-28, Codex CLI 0.149.1 observed rollout format (corrected against real `~/.codex/sessions/**` data — the nested date-subdirectory layout and the `event_msg`/`payload` envelope were misdescribed prior to 2026-08-28). `token_count` / `total_token_usage` / `cached_input_tokens` / `cache_write_input_tokens` / `session_meta` are not a public contract and may drift across versions; `report-session-token-usage.mjs` degrades to `{ available: false, reason }` rather than throwing when the root or session file is absent._

## Exit Criteria

- `$devpro:*` workflow carrier remains the repo skill, not Custom Prompts
- Skill source path and Codex discovery path are documented
- Capability support claims distinguish fully implemented, partial, and fallback

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「直接複製 Claude slash commands 到 Codex」 | Codex parity is skill-based; `.claude/commands` stays Claude-specific |
| 「Custom Prompts 比 skill 快」 | deprecated compat path only |
| 「cache hit 應該有」 | only claim with usage/trace evidence |

## Verification

```bash
node --test .devpro/scripts/tests/codex-dp-workflow-parity-grep.test.mjs .devpro/scripts/tests/token-frugal-mechanical-gates.test.mjs
```
