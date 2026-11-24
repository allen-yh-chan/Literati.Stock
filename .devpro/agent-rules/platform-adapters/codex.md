---
name: platform-adapter-codex
description: "Codex repo/tool adapter: auth, cwd, writes, delegation and post-PR load rules."
---

# Platform Adapter：OpenAI Codex

## Overview

先讀 `platform-adapter-contract.md`。

## Process

### Action-based Load Chain

- 純文字免載 runtime adapter；repo tool（含 `rg`／`cat`）讀 shared+本檔。唯讀不載 GitHub-write／reviewer CLI／workflow capability／post-PR leaves。
- 唯讀轉 GitHub-write／reviewer／workflow／post-PR action 前載對應 Load-chain leaf+gate；缺 leaf／未證 gate visibility 即 STOP。
- Entry：identity/authorization、首次 Node/host-auth、cwd/absolute patch、CLI-first GitHub write、PII/secret/credential/attribution/gate visibility、footer precondition；同一 class-two mechanical gate 未證每次 action 覆蓋這些 anchors 前，不得移出。

### Proactive First-Command Matrix

已知 Codex 風險在觸發條件明確時，第一個命令就必須改形；不得先用 ambient/default/sandbox 命令重跑一次，只為重新發現已記錄風險。

| Situation | First command MUST use |
|---|---|
| OpenSpec / modern JS repo tooling | Node 20-compatible PATH or explicit Node 20 invocation from the first attempt; `bash -lc` => source nvm first or explicit Node 20 inside that shell |
| Host-auth/session/network CLI mode (`git fetch/pull/push`, `gh auth/api/pr comment/pr edit`, `claude auth status` / `claude -p`, `codex exec`) | approved non-sandbox / host command from the first release/PR gate attempt; sandbox may only do no-auth local probes |
| GitHub action in Codex host | 先讀 `tool-selection.md`：authenticated local gh 優先；僅未安裝／未登入可用已驗證的 devpro-work MCP；其他 connector 仍唯讀 |
| Preparing PR diff / packet | `git diff origin/<base>...HEAD` first; use `gh pr diff/view` only for remote-only metadata |
| GitHub body write through `functions.exec_command` | append footer before dispatch; write TL body files to main-checkout `<repo-root>/notes/tmp/<purpose>-<unique>.md`; when hook enforcement is not proven, run strict preflight as a validator-only dry run that never executes the nested `gh` command and where Exit `0` means validation passed only |
| PR create/update 後 | 載 post-pr-completion-gate.md（無後續 gh 亦同）；complete/ready/merge 前重驗；URL/polling≠completion |
| `git worktree add <path>` | immediate literal `cd <path> && pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch` evidence |
| Protected-branch git write inside Codex worktree | command string itself carry worktree evidence: `git -C <abs-worktree> ...` only, with `git add` and `git commit` as separate Bash calls |

**Execution surface evidence**：approved prefix / `prefix_rule` / tool allowlist 只代表命令類型可批准，不代表該命令已在 non-sandbox / host surface 執行。需要 host auth/session/network 的 CLI 模式 MUST NOT 在 Codex sandbox 內跑第一個真實 invocation；要有已核准且實際執行的 non-sandbox / host runner stdout/stderr/exit evidence。Codex sandbox cannot access usable keychain/session/OAuth/network write-back auth；sandbox 內最多跑 no-auth local probes，例如 `git status` / `git diff`。active runtime 若是 full-access host surface，MUST NOT 再附加 sandbox-escalation wrapper；approval/sandbox 斷點不得當 host evidence。

**bash -lc shell switch risk**：`bash -lc` may rebuild PATH and use system Node. OpenSpec / modern JS tooling wrapped this way MUST source nvm first or call explicit Node 20 inside the shell; MUST NOT rely on ambient PATH after shell switch. 高輸出 first attempt 用 `node .devpro/scripts/capture-command.mjs --topic <topic> -- <cmd>` 或 `token-frugal-io.md` wrapper。

**Anti-pattern**：不要先跑 ambient `node`、sandbox full suite、default post-worktree shell、hook-cwd-dependent git write、或 generic GitHub publish flow，只為 rediscover an already documented Codex adapter risk。

### 風險 A：規範未載入

- **觸發**：使用者首則訊息未附 `AGENTS.md` Core Contract 或同等摘要。
- **行為**：`AskFirstPending` 維持非 `none` → 只輸出確認問句，要求貼上摘要或明確授權「依 repo 現有規範執行」。
- **禁止**：用「業界最佳實踐」替代 Core Contract。

### 風險 B/C：執行面與能力不可假設

- **觸發**：同一 Codex 入口但任務落於不同執行面；或即將執行安裝依賴、改 CI、改版本檔、git 寫操作、對外 PR/留言。
- **行為**：宣告 `ExecutionSurface`，依 `platform-adapter-contract.md` 探測 `RuntimeCaps`，測試/build 完成須附可核對 evidence。
- **禁止**：把雲端任務結果當成已寫入本機 repo；以「應該過了」代替可重跑驗證。
- **release back-merge completion gate**：機制（pre-push 記錄 ＋ PostToolUse 綁定 ＋ Stop 阻擋），前提是專案 hook 已被 Codex 信任並實際執行；前提與放行不等於完成見 `release-step-1-7.md` Step 6A。

### 風險 D：sandbox network failure / 風險 G：host auth/session fault

- **觸發**：sandbox 內 `gh auth status` token invalid、`lookup api.github.com: no such host`、NuGet restore `lookup api.nuget.org: no such host`、或 `nuget.devexpress.com` / `api.nuget.org` feed network failure。
- **行為**：先區分 network unavailable 與 token/feed invalid；保留 sandbox failure evidence。命令對完成任務必要且錯誤像 sandbox/network/permission 時，用已核准 non-sandbox / host runner 重跑同一命令或最小聚焦命令。`gh pr list --state merged` / compliance telemetry 等 release/PR gate 需要 GitHub API 時，不得只憑 sandbox 內 `gh auth status` 要求使用者重登；先改用 sandbox 外 host surface 取得 evidence。
- **禁止**：把 sandbox DNS/network error 宣告成 token invalid、套件源壞掉、使用者環境壞掉、或測試 regression。

**GitHubApiSurface latch**：任一 sandbox `gh`/GitHub API 命令因 `error connecting to api.github.com`、`lookup api.github.com: no such host`、DNS/network denied 失敗 → 同 goal 標記 `GitHubApiSurface=sandbox-unreliable`。Retry budget is per (surface, host)；後續 GitHub API 命令 MUST 直接使用第一次已核准 host runner；不 per-command reprobe sandbox。

### 風險 E：subagent / tool-policy fallback

- **觸發**：Codex tool policy 需要 explicit subagent trigger、`spawn_agent` 不可用、structured prompt 工具不可用，或能力探測標記 `subagent=no`。
- **RepoDelegationAutoAuthorization**：benefit/cost admission通過或workflow明定mandatory role後，才形成repo-level automatic authorization/mandate；`≥2檔 Edit/Write`、`≥2步非判斷性工作`只是task-shape訊號。runtime允許直接spawn時，只有admission通過才啟動bounded`spawn_agent`。
- **Runtime trigger boundary**：StandingDelegationAuthorization is the runtime/tool-layer explicit bounded launch evidence needed when Codex tool policy requires an explicit user trigger。來源包含使用者明確說 `use subagent`、`delegate this`、`parallel agent work`，或在 `$devpro:change` / `$devpro:sync-rules` 第零步選擇含 bounded subagent launch authorization 的選項。
- **No fallback excuse**：缺 `StandingDelegationAuthorization` 只是 runtime/tool-layer 授權未決，不是使用者拒絕、不是 `subagent=no`、不是 `spawn_agent` 不可用。missing tool-layer trigger is not `subagent=no` and not TL fallback。TL 不得引用缺 explicit trigger 作為 fallback 理由。
- **Correction handling**：`go`、`依 repo 規範`、或 same-session correction 不單獨滿足 runtime/tool-layer explicit trigger，不自動成立 `StandingDelegationAuthorization`。若使用者只糾正 TL 未委派但未明確授權 subagent/delegation/parallel-agent launch 或未提供 runtime 所需 launch trigger，TL MUST 進 `SubagentAuthPending`，不得把 correction 當 current-turn authorization，也不得把工具說明當成使用者拒絕或 `subagent=no`。
- **SubagentAuthPending**：達門檻但缺 runtime-required launch authorization 時，TL MUST enter `SubagentAuthPending`, ask once, and wait；禁先記 unavailable fallback。Fallback only for user refusal, post-authorization tool unavailability, runtime-reported terminal quota/timeout, or terminal non-TL call failure；拒絕記 `[TL fallback: subagent refused by user]`。TL-selected wait/poll timeout MUST NOT count as runtime terminal timeout; a TL-caused interruption MUST NOT count as call failure or trigger fallback, and MUST first follow the recovery path in `model-delegation-active-lifecycle.md`.
- **併發／巢狀上限**：本 repo 不再建議或檢查 user-local `~/.codex/config.toml` 的 `[agents] max_concurrent_threads_per_session`，也不加 project `.codex/config.toml`；同時 threads 上限為 `[cooperative-only]`，記 configuration gap，不豁免 outcome gate。Codex 無 depth 開關與 `maxTurns` 對應欄位，nested 0 屬 `[cooperative-only]`；`spawn_agent` 前仍 MUST 有六欄 admission record；`role` 的綁定強度依 host 送來的 `agent_type`（2026-09-03 codex-cli 0.152.1 live fixture，見 `codex-workflow-capabilities.md`）：`agent_type` 為閉集角色名時 `role` MUST 相等、record 標 `host-verified`；`agent_type` 全缺（v1 payload 與 v2 modes fixture 皆無該欄）、為自訂 agent 名、或載體不可讀時，才是 `[cooperative-only]` 並記 telemetry named gap `codex-role-carrier-unverified`。

### 風險 F：工具 runtime 太舊

- **觸發**：`node --test` 回 `bad option: --test`、OpenSpec CLI 現代 JS 語法錯、或 repo 約定工具因 PATH 舊 runtime 失敗。
- **行為**：查 `node -v` / `which node`；若 repo 指定 Node 20，改用該 runtime 重跑。
- **禁止**：把舊 node 語法錯宣告成本次 regression。

### 風險 H：worktree/cwd 錯位

- **觸發**：同 repo 同時存在 main checkout 與 `.worktree/<change>`，或 `apply_patch` 無 workdir surface。
- **行為**：所有 manual patch 使用 target worktree 絕對路徑；`apply_patch` 不得用相對路徑假設目前 shell cwd。TL-authored `.pr-body.md` 類 retired body file name 必須改寫至 main-checkout `<repo-root>/notes/tmp/<purpose>-<unique>.md`（gitignored、不綁 worktree 生命週期；generic write 版號錨點 = 本 session cwd checkout 的 canonical remote tip `AGENTS.md`（cwd 讀不到版號才退回 body-file 所在 repo；#3437；canonical rules operation 例外見下方；change name alone is not enough））。Reviewer-owned `.cross-model-sticky-*` 依 renderer family recipe：全 family 皆走 reviewer current neutral cwd，Codex 已不持有 main-checkout notes/tmp 的 `--add-dir` 授權；兩者都仍禁 target worktree-internal sticky staging。寫檔目的地總表見 `file-write-destinations.md`。
- **Protected-Branch git Write Rule 摘要**：hook-visible cwd evidence 必須來自 hook payload 可觀測資訊或命令字串本身；`functions.exec_command.workdir`、statusline branch、agent memory、或 UI cwd 不等於 PreToolUse payload 可見。Codex git write command 必須讓命令字串本身帶 worktree evidence：`git -C <abs-worktree> ...`（唯一建議的 git write 形；帶 `cd` 前綴的寫法不再建議），且 `git add` 與 `git commit` MUST 分兩次 Bash 呼叫。`tool_input.cwd` / `tool_input.workdir` 只有 hook 實際收到才可作為證據；不得把「tool call UI 有 workdir」當成 hook 可見證據。plain git write 只得到 `target branch/worktree could not be proven` 的 fallback-only evidence；單靠 tool `workdir` 不視為等價。Codex `functions.apply_patch` 必須走 PreToolUse file-write hard gate；因工具本身沒有 workdir surface，patch header path 必須是 target worktree 絕對路徑，否則 protected checkout 會被 block。
- **Session cwd：宣告路徑**：fresh／resume at worktree 不再要求；helper 預解析 `change_id`／`execution_root` 可自任何 cwd 派送（同一 resolver／封閉碼群）；cwd 不是 gate 條件。
- **詳細規則**：見 `platform-adapters/codex-github-writes.md` § Protected-Branch git Write Rule。
- **誤寫已發生後的 recovery（非預防）**：上述為**寫前**避免誤寫；若 Codex subagent 已把檔案誤寫進 protected `main`/`production`（hook 擋下該 branch 上的 restore/stash），**不**反射 hook bypass，走 `git-branch-hygiene.md` §Protected-branch Agent Miswrite Recovery 4 步階梯（agent-owned + 已 merged → `git pull --ff-only --autostash`；未 merged 走 fix worktree；破壞性 cleanup/bypass 前須使用者同意）。括號內為 keyword 摘要，與 SSOT 牴觸時一律以 `git-branch-hygiene.md` 為準；本檔不複寫判定原文。

### 風險 I：OpenSpec 文件靠記憶手寫

- **觸發**：建立或修改 `proposal.md`、`proposal-mini.md`、`tasks.md`、spec delta。
- **行為**：寫 proposal 前先讀 template/對應 B-mini 格式；archive/validate warning 不得略過。
- **禁止**：憑記憶自創 proposal 章節後等 archive warning 才補。

### 風險 J：GitHub connector/MCP write-back visibility

- **GitHub route**：依 `tool-selection.md`，本機 gh 可用先用 gh；僅未安裝／未登入可用具已驗證 client/server gates 的 devpro-work MCP。其他 connector 仍唯讀。
- **Boundary**：MCP 必須有實際 host hook 與 compatible 後端 artifact；任一未證明即停止受影響寫入，不能以 tool success 代替等價閘門證據。
- **Anti-patterns**：TL-authored GitHub bodies 不得用 `--body-file -` / heredoc stdin；不得用 repo-external `/tmp` body file。TL body 使用 main-checkout `<repo-root>/notes/tmp/<purpose>-<unique>.md`；reviewer sticky body 不沿用 TL carrier，而須使用 renderer 固定的 per-dispatch neutral cwd（全 family 一致、repo 外；see `file-write-destinations.md`）。
- **詳細規則**：見 `platform-adapters/codex-github-writes.md`。

### 風險 K：functions.exec_command body-file footer gate

- **First-attempt TL body pattern**：create the body file in the main checkout at `<repo-root>/notes/tmp/<purpose>-<unique>.md`, append the required footer `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>`, run `gh-footer-gate.mjs --strict-exit -- <gh command...>` only when hook enforcement is not proven, run the real `gh` command, then immediately delete the temporary body file and run `git status --short`.
- **Strictness**：Codex `functions.exec_command` GitHub writes with `--body-file` MUST NOT rely on repo hook auto-block when `CODEX_CI` / `CODEX_THREAD_ID` or missing cwd payload can hide hook context; use strict preflight when footer enforcement is required. That invocation is a validator-only dry run: it never executes the nested `gh` command, Exit `0` means validation passed only, and the real `gh` command still must run separately if a write is intended. On hook-proven shells, run the real `gh` command directly and let PreToolUse invoke the gate; MUST NOT manually insert this validator as an executor wrapper.

### Worktree-scoped footer version equality

`gh-footer-gate.mjs` resolves `--body-file` before shell execution. Codex TL bodies must use a main-checkout absolute path `<repo-root>/notes/tmp/<purpose>-<unique>.md`, not a relative body path that depends on compound `cd <worktree> && gh ... --body-file .pr-body.md`.

Canonical rules sync PR 必須用 `cd <abs-rules-worktree> && gh pr create ... --head rules/<source>-v<X.Y.Z>`，使 hook 可觀測 exact operation worktree。該 lane 的 footer version 由 rules worktree `AGENTS.md` 提供，且 current branch、`--head`、branch suffix、worktree `AGENTS.md` version 與 rules source whitelist 必須一致；無法解析或互相矛盾即 fail closed。同一 compound command 的多個 rules write-back 無法逐一綁定 body，必須拆成獨立命令。body file 仍位於 main-checkout `notes/tmp/`；非 rules GitHub write 以本 session 執行指令所在 repo（cwd checkout）的 canonical remote tip `AGENTS.md` 為版本錨點，cwd 讀不到版號才退回 body-file 所在 repo。

### User-Invocable Command/Skill Capability

**Support**: fully implemented via repo-scoped skill parity (`.devpro/agent-skills/devpro-workflows/workflows/SKILL.md`, `.agents/skills/devpro`), not native Codex slash-command registration. `$devpro:workflows` and natural-language workflow requests are supported；direct `/dp:*` input may be intercepted by Codex UI as an unrecognized command and may not reach the model。`~/.codex/prompts` / `/prompts:` Custom Prompts are deprecated compat-only and MUST NOT be the shared Devpro workflow carrier；prefer Skills/Plugins；details live in `platform-adapters/codex-workflow-capabilities.md`（見 codex-workflow-capabilities.md §User-Invocable Command/Skill Capability）.

### Cross-Model Second Opinion Adapter

Codex cross-model review hot path splits by host direction: Codex-as-reviewer uses the Codex CLI recipe below; Codex-host second review uses the Claude reviewer leaf.

### Codex CLI as Tool

Codex CLI Cross-Review Skill: `platform-adapters/codex-cli-tooling.md`. Claude-host -> Codex CLI uses active adapter writer contract. Anchors: Codex sandbox 禁用；Codex CLI auth-required reviewer mode MUST NOT 在 Codex sandbox 內執行；first invocation needs non-sandbox / host execution surface；這條同樣適用於 `gh` / GitHub remote `git` / `claude` 的 host-auth 模式；sandbox 內失敗不是憑證壞掉的證據。Invocation: `codex exec --json`, `-c model_reasoning_effort="xhigh"`, Git repo required, Codex OAuth, `pty=true`, bounded timeout, stdout/stderr evidence, do not use `--full-auto` / 不使用 `--full-auto`, stdin must be closed with `</dev/null`。Recipe in cold leaf. focused sticky-refresh：stale `verdict: PASS|WARN` sticky + narrow follow-up/finding disposition/test-only/gate-evidence -> previous sticky/verdict/findings、latest delta/range、current head SHA、current gate/test evidence；reviewer evaluate only delta and PATCH existing sticky；focused packet insufficient/risk shape changed -> broad；same-shape broad rerun timeout/error = orchestration friction, not reviewer unavailable。

Codex-host Claude reviewer: `platform-adapters/codex-host-cross-review.md`. Hot-path anchors: host-only `claude -p`, review packet mode+self-write sticky, file/stdin, `stream-json`+`include-partial-messages`+hook events, first schema-valid `verdict`, sticky verify before ready/timeout/fallback/kill。Wrapper 每 `60s` sample reviewer stdout/stderr delta；activity heartbeat / structured progress 優先，stdout/stderr 只作 fallback，health probe 同看 child process、final JSON 與 sticky freshness；sticky polling itself MUST NOT reset activity state。`15m` status checkpoint 自動續跑；Claude/Codex 共用 `30m` total hard cap，current-head sticky verification須先於timeout record及transport termination；Post-PR：marker-bound exact-one current-head `PASS`優先，timeout只留`cli_exit.timed_out`診斷；`WARN`仍需no current fault + complete receipt chain。Merge Path F獨立只驗exact-one current-head `PASS|WARN`，不讀local control evidence；其他fail closed。Callback/process close 才是 terminal；有 runtime callback 時不得 poll lifecycle。Spawn/early-exit faults MUST fail fast；`error_max_turns` 是 invocation/orchestration evidence，not CLI unavailable。Projection wrappers owning `claude -p`/`codex exec` MUST expose renderer-owned `observability_context` (`activity_log_path`/`stdout_log_path`/`stderr_log_path`/`cli_probe_result_path`, `projection_bootstrap_script`, cwd-independent absolute `projection_bootstrap_command` to `.devpro/scripts/ack-second-reviewer-projection.mjs`, `projection_runner_script`, cwd-independent absolute `projection_runner_command` to `.devpro/scripts/run-second-reviewer-projection.mjs`, `reviewer_cli_recipe.required_invocation_args`, `required_activity_events` / `duration_conditional_activity_events`, `cli-probe-result.json`, heartbeat <=60s). First action runs exact `projection_runner_command`; runner emits `projection_handoff_validated`, runs `.devpro/scripts/probe-second-reviewer-cli-recipe.mjs`, emits `projection_cli_probe_started`/`projection_cli_probe_result`, and after help flags pass MUST execute family-specific `reviewer_cli_recipe.auth_preflight` with the inherited reviewer environment. Raw auth output is bounded under `memory-only-do-not-persist`; any failed or ambiguous evidence is pre-spawn `reviewer_host_surface_unverified`, while only verified evidence preserves `flags_supported`. The runner then spawns with renderer-owned args, streams stdout/stderr, emits common `projection_cli_starting`/`projection_cli_started` plus conditional `projection_cli_liveness_sampled`/`projection_cli_status_checkpoint`; `pr-sticky` terminal order is `projection_sticky_verification_started`, then `projection_sticky_verified|projection_sticky_verification_failed`, then `projection_cli_exited`. stale sticky = verification failure; MUST NOT be treated as write attempts/progress. Prefix: `claude -p --safe-mode --system-prompt <renderer-owned fixed prompt> --model <resolved> --effort xhigh --verbose --output-format stream-json`；fixed prompt treats stdin packet as complete and prohibits cwd/environment/git bootstrap without compressing packet semantics. No argv reconstruction; no `--bare` unless host probe proves auth preserved. `required_flag_absent_in_host_help`=unsupported; typed HTTP 400 effort/thinking/reasoning incompatibility=`reviewer_cli_recipe_incompatible`；HTTP 401/403 or explicit auth remains auth failure；other 400=`reviewer_cli_failed`。`probe_evidence_unavailable`/`probe_malformed`/`probe_capture_suspect`/`recipe_parser_mismatch`=probe faults. `projection_log_unavailable_by_runtime_api` is not a waiver; missing=`projection_observability_contract_missing`, stale=`projection_activity_stale`.

### Load-Plan Capability

**Support**: partial support, no built-in load-plan command. Manual summary uses AGENTS trigger index, active adapter, and triggered leaf list.

### Edit-Time Syntax Validation

**Support**: partial support, supported through repo tests/lints and focused syntax checks; Codex has no separate edit-time parser guarantee beyond tool/test evidence.

### Reasoning Depth Control

**Support**: partial support, supported through configured reasoning effort where the runtime exposes it; see `platform-adapters/codex-effort-tiers.md`.

### Pre-commit Cross-Review Reminder

**Support**: partial support, supported as a procedural reminder/gate, not an automatic native pre-commit reviewer. Use `post-pr-completion-gate.md` and cross-review leaves before complete/ready claims.

### Per-Session Usage Telemetry

**Support**: fully implemented; see `platform-adapters/codex-workflow-capabilities.md`.

### Load-Plan / Reasoning / Cache

- Cache metric: use `usage.prompt_tokens_details.cached_tokens` when exposed; otherwise do not claim cache hit.
- Auto-compact and workflow capability details live in `platform-adapters/codex-workflow-capabilities.md`. Recommended local setting is `model_auto_compact_token_limit = 400000`.

### Rigor Level

This runtime reads `DEVPRO_AGENT_RULES_LEVEL` (`full|lite|off`, default `lite`) and consumer `.devpro/rules.config` with shared precedence. Default lite applies when no setting exists. Codex MUST NOT override an explicit user selection or upgrade to full without the reason and consent required by `rules-rigor-level.md`. See `rules-rigor-level.md`.

### Load-chain（cold siblings）

- GitHub write-back, connector ban details, TL body-file pattern, and Protected-Branch git Write Rule → `platform-adapters/codex-github-writes.md`
- Codex CLI-as-tool / external reviewer CLI details → `platform-adapters/codex-cli-tooling.md`
- `devpro:*` parity, Skills/Plugins/Custom Prompts, Load-plan/support status → `platform-adapters/codex-workflow-capabilities.md`
- Codex-host Claude second reviewer → `platform-adapters/codex-host-cross-review.md`
- reasoning effort selectors → `platform-adapters/codex-effort-tiers.md`

## Exit Criteria

- 已讀 `platform-adapter-contract.md` + 本檔；只在對應 trigger 命中時讀 cold sibling
- `RuntimeCaps` 與 `ExecutionSurface` 已以 evidence 更新
- GitHub connector write 未使用；GitHub write 走 `gh` / `git`
- GitHub body footer/body-file 規則已依 cold sibling 或 `git-branch-and-pr-flow.md` 執行
- subagent 授權與 fallback 未混淆
- post-PR completion gate 完成後才宣告 complete/ready/merge

## Common Rationalizations

- 「Codex adapter 細節都先讀比較安全」→ hot-path 只讀本檔；cold siblings 按 trigger 載入。
- 「connector 可寫比較方便」→ source hooks 看不到 connector payload；GitHub write 必須 `gh` / `git`。
- 「workdir 已設所以 plain git add 可以」→ git write 用 `git -C <abs-worktree>`（唯一形；帶 `cd` 前綴的寫法不再建議），且 `git add`／`git commit` 分兩次 Bash 呼叫。
- 「PR 建了且 checks 綠就是 done」→ post-pr completion gate 與 sticky SHA/verdict 才是完成證據。

## Verification

```bash
node --test .devpro/scripts/tests/rule-token-budget.test.mjs
node --test .devpro/scripts/tests/codex-dp-workflow-parity-grep.test.mjs .devpro/scripts/tests/cross-review-cli-skills-grep.test.mjs
```
