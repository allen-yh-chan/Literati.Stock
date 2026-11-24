---
name: cross-review
description: "跨模型第二意見 PR review workflow（different-family reviewer dispatch、sticky comment write-back、merge gate enforcement）。使用時機：使用者 invoke /devpro:cross-review、要求對 PR 提供第二意見、要求跑 cross-model review，或 PR 需要 Step 5.5 post-PR review dispatch。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:cross-review <PR#>"
---

# Devpro Cross-Review

## Overview

本 skill 是 Devpro 跨模型第二意見 review workflow 的 PR 層 routing 與 gate 載體。它決定一個開啟中的 PR 是否需要 **different-family** AI reviewer、是否豁免、要交給 executor 的 bounded handoff inputs，以及如何驗證 sticky/merge gate。實際第二 reviewer 的 host-family selection、final reviewer packet shape、`pr-sticky` / `audit-only` output mode、fallback provenance 邊界由共用 `.devpro/agent-skills/devpro-reviews/second-review/SKILL.md` 執行。

**Policy SSOT 留在 rule leaves 與 executor skill——本 skill 不重複它。** 豁免條件、六軸 checklist、sticky schema 與 merge-gate path table 定義於 `code-review-cross-model.md` 與 `code-review-checklist.md`；第二 reviewer host-family selection、packet ownership 與 output modes 定義於 `devpro:second-review` skill。本 skill 只告訴你 PR workflow 何時該 invoke、如何準備 bounded handoff inputs、如何驗證 gate。權威決策永遠載入並執行那些規則，而非本 skill 的摘要。

## When to Use

- 使用者跑 `/devpro:cross-review <PR#>` 或要求「get a second opinion on PR #N」
- `post-pr-completion-gate.md` Step 5.5 在 PR 建立後觸發
- TL 對已 review 過的 PR push 新 commit，需要 re-review
- 使用者詢問 cross-model review 如何運作，或為何 `gh pr merge` 被擋

**反向護欄**：使用者**僅泛指「審查 PR」**而**未指明**跨模型 / 第二意見 / 寫 sticky 時，主 agent **應先確認**審查類型，**勿預設**等同本 skill。本 skill 是 specific 子動作，非泛「審查 PR」的預設入口。三條路由如下——六軸自審（`/code-review` 或直接依 `code-review-checklist.md` 六軸）；跨模型第二意見並寫 PR sticky comment（`/devpro:cross-review <PR#>`）；pre-PR 六軸加 post-PR 跨模型（`/devpro:pre-pr`；跨模型是 Step 5.5，不是開 PR 前）。使用者意圖不明時應先問，再 invoke 對應 skill。

## Process

### 1. 先載入 policy SSOT

在 dispatch 任何東西前，先載入並執行：

- `code-review-cross-model.md` —— 豁免條件（branch-pattern、diff-shape）、執行流程、sticky schema、衝突仲裁、merge gate path table（A–F、U）
- `second-review-control-evidence.md` —— mode-bound v4 `pr-sticky` / exact v3 `audit-only` dispatch、typed-first terminal classification、immutable capsule/receipts、gate consumption lifecycle
- `code-review-checklist.md` —— 此 reviewer 必須涵蓋的六軸 review scope
- `.devpro/agent-skills/devpro-reviews/second-review/SKILL.md` —— reviewer-family selection、`pr-sticky` / `audit-only` output mode、fallback provenance；PR merge gate 必須使用 `pr-sticky`
- **本 session host** 對應的 host-specific adapter：`platform-adapters/claude-code-cross-review.md`（Claude Code 為 host、dispatch Codex/Claude reviewer 時）或 `platform-adapters/codex-host-cross-review.md`（Codex 為 host、dispatch Claude reviewer 時）

不要憑記憶自行 improvise 豁免邏輯或 sticky schema——那些規則是 enforcement SSOT，且獨立於本 skill 變動。

### 2. 決定 host↔reviewer 配對

預設配對為 **different-family**：無論哪個 host 在跑本 session，都 dispatch *另一* family 的 CLI 作為外部第二 reviewer。具體判斷以 `devpro:second-review` skill 的 `primary_family` contract 為準；Cursor/other host 不能只靠 host brand 宣稱 cross-model。

- Claude Code host → dispatch `codex` CLI 作為第二 reviewer
- Codex host → dispatch `claude` CLI 作為第二 reviewer（見 `platform-adapters/codex-host-cross-review.md`）
- Cursor host → 先 resolve `primary_family`；unknown 時 dispatch `reviewer_family=codex` 且 **pr-sticky** packet `primary_family=unknown` + sticky `cross-model-unverified`（不得宣稱 cross-model credit）；design gate 用 `platform-adapters/cursor.md` design-only default
- 其他 host → 先 resolve `primary_family`；unknown 時要求明示或標 `cross-model-unverified` / fallback
- Override：`$CROSS_MODEL_REVIEWER` env var（非空才算存在），若有設定則明確指名 reviewer family，優先於預設配對；次優先為 devpro:change 開頭預選（active change ledger `second_reviewer_family`）；兩者皆無才用預設配對（單一優先序：env > ledger > 預設配對）
- 若 different-family 不可用/未授權，或使用者選擇 fallback，adapter MAY 使用 **same-family fallback**——sticky comment MUST 記錄 `reason: same-family fallback: <why>`，且 MUST NOT 宣稱 cross-model diversity
- reviewer CLI 登入／auth 失敗的「不可用」判定以 `.devpro/scripts/hooks/lib/host-auth-surface.mjs` 的 `classifyAuthSurfaceFault`／`isFallbackAllowed` 為唯一判準，區分真的沒裝（`real-unavailable`）與 sandbox auth false-negative（`sandbox-surface-fault`）；何時可 fallback 或標 `UNAVAILABLE` 見 `code-review-cross-model-cli-contract.md`
- 目標 family 無 runner CLI recipe（如 `gemini`）、CLI 不可由 runner 呼叫，或大 PR 改選 live review 時，改走 `devpro:second-review` skill §Executor Selection 的 External Evaluator 審查單（`executor_kind: "external-evaluator"`）路徑，而非 same-family fallback 或 `UNAVAILABLE`；footer `Tool:` token SSOT 是 `second-review-sticky-authority.mjs` `STICKY_PROVENANCE_TOOL_TOKENS`

### 3. Dispatch 前先檢查豁免

執行 `pre-tool-gate.mjs::isCrossModelExempt` 邏輯（branch-pattern 豁免 → hotfix override → diff-shape chore/ 前綴車道豁免）。若豁免，merge gate 走 Path A（pass），你跳過 dispatch——但仍會觸發 **advisory** 通知使豁免不至於無聲無息（non-silent 要求見 `code-review-cross-model.md` §豁免條件）。若非豁免，依 host adapter 進行 Step 5.5 dispatch。

skip/exempt 只是 gate progress，不是 terminal response。若本步判定豁免或 skip，最終回報仍 MUST bridge to `post-pr-completion-gate.md` Ready Response Next-Step Contract，包含 `CurrentIntent`、`NextAction`、`AskFirstPending`、owner、next action、success condition；若下一步 user-owned，結尾 MUST 給 numbered options。

### 3.5 Final head / lineage precheck

Before Step 5.5 or `/devpro:cross-review <PR#>` dispatch, TL MUST confirm final base/mergeability sync is complete for the intended merge head and no rebase、force-push、patch replay、merge graph recovery、or other non-fast-forward rewrite remains planned. If the PR is stale or mergeability repair requires those git actions, stop and Ask First for an explicit git strategy instead of dispatching a dispatch-bound sticky.

After a dispatch-bound `PASS|WARN` sticky/marker exists, any later PR head movement makes that sticky stale for merge readiness unless a fresh current-head dispatch replaces it or the movement is Path D′ fresh-equivalent (whitelist-only bookkeeping diff; SSOT `code-review-cross-model.md`). If old reviewed head H1 is not an ancestor of current head H2, the sticky is additionally lineage-broken stale sha evidence. Exact per-lineage approval may rebind or clear only an eligible active marker／clear-obligation under the post-PR recovery contract; it does not authorize git history rewrite, restore readiness, or replace the new H2 dispatch/sticky that binds `last_reviewed_sha == headRefOid`. User-approved lineage-preserving graph recovery restores ancestry/traceability only; continue through the verified-fast-forward path and require a new H2 dispatch/sticky.

### Initial handoff builder

For an initial PR-sticky review, the active host builds the handoff before invoking the renderer. Invocation form:

```sh
node .devpro/scripts/build-pr-sticky-handoff.mjs <PR#> (--change <name> | --branch <branch>) --carrier-root <main-checkout-root>/notes/cross-review --primary-family <host-family> [--preferred-reviewer <family>] [--attempt <initial|focused-sticky-refresh|fault-recovery> [--retry-classification <fault-classification> --retry-sticky-verification <state>]]
```

The user supplies the PR number, exactly one of `--change` or `--branch`, and `--carrier-root`. The active host alone injects the trusted `--primary-family` alias; do not ask the user to select it. The Codex adapter injects `codex`; the Claude Code adapter injects `claude`; a deepseek primary (non-Codex host) injects `deepseek`. Reviewer precedence is non-empty `$CROSS_MODEL_REVIEWER`, then the `--preferred-reviewer` value preselected by `/devpro:change`, then the different-family default (a `deepseek` primary defaults to `codex`); same-family selection fails closed unless the user explicitly authorizes the fallback and the builder carries `--allow-same-family <why>` (conditions in `code-review-cross-model.md` §Initial handoff builder). Both selectors accept `codex`, `claude`, or `deepseek` (the OpenCode CLI, which `--preferred-reviewer deepseek` selects by name and the default never does); `--primary-family` additionally accepts `unknown` for the unproven-host path.

For a same-repo PR, including a PR number the user names manually, dispatch directly: devpro defines no per-PR question, so do not ask the user, do not wait for a host prompt, and do not run any authorization command. A stop that a consumer adds in its own `AGENTS.local.md` is an ordinary local rule that the TL follows like any other local rule; it is not a devpro-defined per-PR question.

Under lite (no proposal, no ledger) run the builder with the value-less `--lite` switch (exclusive with `--change`, requires `--branch`, reads no rigor level); `done_when` comes from the checked `驗收證據` bullets under the PR body `## Test Evidence` (`lite_acceptance_missing` when absent or unchecked), and a PR head that already carries a proposal for the change is refused with `lite_proposal_present` (use the full path):

```sh
node .devpro/scripts/build-pr-sticky-handoff.mjs <PR#> --branch <branch> --carrier-root <main-checkout-root>/notes/cross-review --primary-family <host-family> --lite
```

When the builder returns `review_material_unavailable` because the PR raw diff exceeds the embed limit, re-run it with `--external-evaluator <tool>` (one `STICKY_PROVENANCE_TOOL_TOKENS` token) to produce an External Evaluator handoff; see `second-review-external-evaluator.md`. When its message says the pull request has no content diff (empty three-dot changed-file list), `--external-evaluator` does not apply: a zero-diff production ancestry repair is exempt from cross-model review (`code-review-cross-model.md` §Zero-diff ancestry repair exemption), and any other zero-diff PR needs the user's Path W decision.

Stop and ask the user instead of dispatching when the builder refuses a cross-repo PR with `pr_repository_mismatch`.

The builder prints only the handoff JSON path. Pass that path and the identical carrier root to the existing renderer:

```sh
node .devpro/scripts/render-second-review-packet.mjs "$HANDOFF_JSON" --carrier-root "$CARRIER_ROOT"
```

The handoff contains the PR diff and raw comment bodies. Keep it until the renderer has consumed it, then remove the caller-owned file with `rm -- "$HANDOFF_JSON"`; retain renderer attempt evidence according to its existing cleanup policy.

### 4. Dispatch reviewer（adapter-specific）

**Claude Code host `pr-sticky` route**：正式路徑由 TL 擁有 runner：依 `devpro:second-review` §`pr-sticky formal path` render + validate，讀 sidecar 後以 runtime-native background 直接執行 renderer-owned `projection_runner_command`，並驗證 terminal events 與 current-head sticky。Claude Code 標準 `Agent` wrapper 約 10m，短於 runner 的 30m hard cap；該 wrapper 下 TL MUST NOT dispatch `dp-second-reviewer`。若 TL-owned background 不可用，可依下方條件使用 proxy；只有正式路徑不可用且 proxy 不符合資格時，才在 launch 前停止。

下方 Claude-host `Agent({...})` block 是非預設 proxy；proxy 僅在 active wrapper 的可查 timeout 證據至少覆蓋 runner 的 30m hard cap，且能持有 return gate 至 terminal events 時符合資格。它不構成正式路徑。Host adapter 的執行細節見 `platform-adapters/claude-code-cross-review.md`。

依共用 `devpro:second-review` skill 與適用 host adapter 中具體的 CLI recipe 進行——final reviewer packet 建構、sandbox/auth surface 規則、tool allowlist、renderer-owned auth-preserving recipe、no-subagent isolation（或 adapter probe-backed equivalent）、timeout policy（wrapper每`60s` sample reviewer stream；`15m` status checkpoint自動續跑；`30m` total hard cap前final verify/classify後終止；callback/process close才是terminal）與 stream-json evidence extraction 全都定義在 executor/adapter，非本檔。PR cross-review 必須使用 `mode: pr-sticky`；`audit-only` findings 不滿足 merge gate。

same-repo PR 的 `pr-sticky` handoff 由 builder 固定寫入 `approval_context: "none"` 與 `approval_resolution: {"status":"not-required"}`；TL 不補寫、不改寫這兩欄。 TL 不得把已組好的 final CLI packet 當成 executor 的輸入；dispatch 時只交 bounded handoff inputs：

- Bounded handoff inputs：PR metadata、head SHA、changed files、diff 或 touch-list summary（若 diff > 5000 行）、`done_when`、primary review evidence、linked-issue context（若適用）、`approval_context`／`approval_resolution`（`pr-sticky` 由 builder 固定寫 `none`／`not-required`）、`sticky_authority_snapshot`（`pr-sticky` required complete bounded issue-comments snapshot；complete 及於元素層——每個 comment MUST 是帶逐字 string `body` 的物件，且 MUST 含 `html_url`（或合規 `url`）+ `id` + `node_id` + `updated_at`；缺 identity → disposition blocked；摘要或衍生元素無法判定 marker 在不在，整份 snapshot 會被 disposition 解析判為 blocked；renderer 用它產生 trusted `sticky_write_disposition`，缺失為 pre-render handoff error。Capture MUST match `liveStickyAuthoritySnapshot()`：`gh api --paginate --slurp` + `JSON.parse`，object `body` 原樣；MUST NOT `gh api --jq` / redirect / `tee` / text-file body 中介）、optional `retry_context` object（exact keys `classification` + `sticky_verification`）與 same-head `previous_dispatch_id` 鏈；`reviewer_constraints` 由 builder 從 `second-review-rules.local.md` 產生、TL 不手填也不改寫，契約見 `code-review-cross-model.md`
- `## 測試執行政策` intent：handoff inputs 必須提供 primary validation evidence / primary test evidence 的位置與可信度，final reviewer packet 由 `devpro:second-review` 要求 reviewer 核對該 evidence；預設不得重跑 `full suite`、`budget gate`、`--changed main`／tier suite、multi-gate insurance rerun 或 broad project tests；`--changed main` is not scoped rerun；只有 primary evidence 缺失、互相矛盾、結果可疑，或需要確認 specific finding 時才 scoped rerun（MUST 窄於 change-scoped suite），並記錄具體疑慮。此約束僅 second-reviewer packet／subprocess。PR-stage integration 證據範圍見 `pr-review-evidence-verification.md` §Packet Prompt 測試執行政策。
- 若既有 sticky 是 stale 的 `PASS|WARN`（round ≥2；典型 delta 為 follow-up/test-only/gate-evidence commit），handoff inputs **MUST** 標成 **focused sticky-refresh intent**（commit-range delta since `last_reviewed_sha`）而非廣泛探索；full-pr 只在 rule/code carrier 實質變更且附 `full_scope_reason` 時可用——見 `code-review-cross-model.md` §執行流程 point 4 與 §Round Budget（pr-sticky cap 3）
- Reviewer 自行寫入 sticky comment（host 不代 reviewer 轉述 findings）

Packet template discipline：第一次 dispatch、focused sticky-refresh、fault recovery 都必須由 `devpro:second-review` 的 Canonical Reviewer Packet Template 產生 mode-bound final packet：nonpaged `pr-sticky` only `devpro-second-review-data/v4`；renderer-paged page-window exclusively `devpro-second-review-data/v5`；`audit-only` exact canonical `devpro-second-review-data/v3`。Renderer先 exclusive reserve `dispatch_id`/`dispatch.json`，runner只驗 binding並 exclusive claim一次 invocation；retry/rerender須新 dispatch及 predecessor lineage（`previous_dispatch_id` 鏈上一次同頭 render，含未呼叫 CLI 仍推進 pending marker）。每次 initial dispatch / focused sticky-refresh / fault recovery / rerender / retry，TL 都必須以 `--carrier-root <main-checkout-root>/notes/cross-review` 呼叫 renderer；renderer 每次 invocation 自行在該 root 下配置 fresh `<main-checkout-root>/notes/cross-review/<attempt_id>/` carrier directory（TL 不自行命名或建立該目錄），成功路徑並將絕對 packet path 印至 stdout。不得 overwrite、patch、delete 或 reuse prior attempt packet/sidecar/proof/log/probe/sticky disposition（cleanup owner 依 TTL 清理除外），prior attempt directory 僅作 read-only lineage evidence。First-run happy path 是 structured handoff JSON → `.devpro/scripts/render-second-review-packet.mjs`（或 adapter-equivalent deterministic renderer）→ renderer-generated sidecar → validator → CLI。TL 只交 bounded handoff inputs 與 optional `retry_context` object（`classification` + `sticky_verification`）；TL MUST NOT hand-write final prompt/path。

Focused-range handoff MUST carry typed `review_scope` (`full-pr` or `commit-range`, all SHAs strict lowercase 40-hex), `review_material_carrier`, `review_material_capability`, and `review_material_proof`. The finite closure is：either scope + `embedded-diff` / `scope-bound-embedded-complete-diff-v1` / `embedded-complete-diff-v1`；full PR live + `full-pr-bounded-live-reads-v1` / `gh-pr-bounded-live-v1`；commit range live + `commit-range-exact-compare-v1` / `gh-api-exact-compare-v1`. Generic `gh pr view` / `gh pr diff` and `Bash(gh api:*)` do not prove a commit range；only exact quoted `gh api 'repos/{owner}/{repo}/compare/<base>...<head>'` may be used after typed identity validation. Before spawn, the sidecar recipe/probe MUST verify exact scope、merge-base/count/non-truncation/path reconciliation；failure is `review_material_scope_unresolvable` in `spawn_or_probe_failure`, with zero reviewer/completion/sticky. Any recovery that changes scope、carrier、route、or material requires a fresh dispatch、packet、proof、recipe、and probe. Existing typed `permission_denials` fatal precedence is unchanged.

Renderer sidecar 是 TL 的標準 path discovery source，固定列出 `packet_path`、`observability_context_path`、`tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn`、`required_spawn_payload_fields`、`reviewer_surface: host-non-sandbox-required`、`runner_owner: adapter-host-runner`、`sandbox_policy: auth-required-reviewer-cli-must-not-run-in-sandbox`、`heartbeat.json`、`projection-activity.ndjson`、`reviewer-stdout.ndjson`、`reviewer-stderr.log`、`cli-probe-result.json`、`cli_probe_result_path`、`projection_bootstrap_script`、`projection_bootstrap_command`、`projection_runner_script`、`projection_runner_command`、`reviewer_cli_recipe`、and `required_activity_events` / `duration_conditional_activity_events`。For runtime-native projection dispatch, TL MUST run the renderer and validator before `spawn_agent` / `Task`，read sidecar，then pass exact `packet_path`、`observability_context_path`、`heartbeat_path`、`activity_log_path`、`stdout_log_path`、`stderr_log_path`、`cli_probe_result_path`、`projection_bootstrap_command`、`projection_runner_command`、and `tl_pre_dispatch_contract`。Missing/malformed sidecar or handoff path is `projection_observability_contract_missing` before dispatch，not a timeout wait。

Projection first executable action MUST execute exact `projection_runner_command`：on every host except the Claude Code host this is cwd-independent absolute canonical `.devpro/scripts/run-second-reviewer-projection.mjs` + `observability_context_path`；on the Claude Code host it is the repo-root-relative typed carrier `node .devpro/scripts/run-second-reviewer-projection.mjs '<observability_context_path>'`, executed with cwd at the renderer repo root — before authorization or any mutation the runner self-check returns `projection_runner_cwd_not_repo_root` when cwd/own-root/renderer-root disagree。Runner first executes canonical bootstrap through `.devpro/scripts/ack-second-reviewer-projection.mjs`，then records `projection_handoff_validated`，updates `heartbeat_path` / `activity_log_path`，runs `.devpro/scripts/probe-second-reviewer-cli-recipe.mjs <observability_context_path>`，writes `cli_probe_result_path`，and records `projection_cli_probe_started` / `projection_cli_probe_result`。Help flags pass後，runner MUST以reviewer將繼承的相同環境直接執行renderer-owned `reviewer_cli_recipe.auth_preflight`；raw auth output須bounded且遵守`memory-only-do-not-persist`。任何失敗或模糊證據皆pre-spawn fail closed為`reviewer_host_surface_unverified`；只有驗證成功才保留`flags_supported`並繼續。Only `required_flag_absent_in_host_help` is true unsupported recipe / `recipe_unresolved`。`probe_evidence_unavailable`、`probe_malformed`、`probe_capture_suspect`、and `recipe_parser_mismatch` are evidence faults，not missing flags or `projection_runner_unavailable`。

Runner records common `projection_cli_starting` before spawn，`projection_cli_started` after spawn，`projection_cli_liveness_sampled` every `60s` while open，and non-terminal `projection_cli_status_checkpoint` at `15m`。This workflow's `pr-sticky` terminal order MUST exactly record `projection_sticky_verification_started`, then `projection_sticky_verified|projection_sticky_verification_failed`, then `projection_cli_exited`；extra、missing、or reordered entries fail closed；stale sticky comments MUST NOT be inferred as write attempts。Wrapper-owned stream sampling is independent from agent/projection lifecycle waiting；the `15m` checkpoint auto-continues without kill or user-authorization wait，and the `30m` total hard cap queries current-head sticky before timeout record and termination。Post-PR exactly-one canonical current-head marker-matching `PASS`先保留consumer gate success，later fault仍在`cli_exit.timed_out`保留transport/finalization診斷且不要求receipts；`WARN`須無current fault與完整receipt chain。Actual merge hook Path F仍獨立只驗exactly-one canonical current-head `PASS|WARN`。Callback/process close is terminal completion。

TL waits runtime completion callback/event；callback-capable runtime MUST NOT use periodic polling or list-agents busy wait。Only no-callback runtime may poll projection lifecycle/artifact/sticky every `60s`，at most 30 attempts／`30m`。Its first 60s observation window MUST see terminal status、fresh current-head sticky、or post-handoff heartbeat/activity（including `projection_handoff_validated` / `projection_cli_probe_started` / `projection_cli_probe_result`）；otherwise classify `projection_activity_stale` without waiting to cap。No host/non-sandbox runner for `claude -p` / `codex exec` is `projection_runner_unavailable` before dispatch，not a timeout wait。

若 structured terminal result、`error_max_turns`、packet-width timeout、completion或sticky使 dispatch未完成，TL依 `second-review-control-evidence.md` 先消費 result/capsule，不得從 reviewer content重推 fault。Retry overlay帶 classification、redacted provenance、sticky verification、SHA、previous dispatch lineage、denied class、focused scope及既有approval；不得帶 local evidence path/raw evidence，也不得叫reviewer讀 transcript/log。

Projection invocation discipline：renderer sidecar MUST include `reviewer_cli_recipe.required_invocation_args`; after the probe reports `flags_supported`, the projection/direct wrapper MUST invoke the reviewer CLI with those args exactly and MUST NOT reconstruct argv from memory. Codex-host Claude stream-json recipe includes `--verbose` before `--output-format stream-json`.

Claude Code host 委派格式（projection-first；這是交給 runtime-native `dp-second-reviewer` 的 bounded handoff block，不是 final external CLI packet）。欄位分兩層，SSOT 各自不同：bounded handoff 欄位對齊 `code-review-cross-model-cli-contract.md` §External Reviewer CLI Skill Contract；render-first 契約欄位對齊 renderer 產出的 `observability-context.json` sidecar（見本節上方 sidecar 段與 `openspec/specs/cross-runtime-parity/spec.md`）——TL MUST 先跑 `.devpro/scripts/render-second-review-packet.mjs` → `.devpro/scripts/validate-second-review-packet.mjs`，再從 sidecar 讀出下列絕對路徑逐欄填入；缺任一欄位即 pre-dispatch `projection_observability_contract_missing`，不是 timeout wait。本 block 與下方 Codex host block 是同一契約的兩個 host 投影，**除本 block 標注的 host 差異外欄位集必須等價**：

```
Agent({
  subagent_type: "dp-second-reviewer",
  description: "Cross-model second-opinion re-run for PR <#>",
  prompt: `
objective: independent-judgment
responsibility_id: post-pr-cross-review
instance_mode: fresh
evidence_scope: <repo-relative or de-identified review scope descriptors (e.g. openspec/changes/<named_change>/, changed-files touch-list summary); absolute paths belong only in packet_path / observability_context_path>
return_and_stop: <compact completion JSON；sticky write-back 後停>
role: dp-second-reviewer
mode: pr-sticky
primary_family: claude
pr_number: <# (string)>
head_ref_oid: <oid>
change_name: <string; the cost-advisory change binding; for round-override disclosure it MUST equal the change derived from the live PR head branch, which is used when change_name is absent>
page_window_max_pages: <1..4; omit for the default 1>
changed_files_or_touch_list: <bounded list；若無 active proposal 則空陣列>
review_scope: <typed full-pr | commit-range identity>
review_material_carrier: embedded-diff
review_material_capability: <finite-matrix capability>
review_material_proof: <scope-bound digest>
done_when: <acceptance/evidence summary；若無 active proposal 則留空>
primary_validation_evidence: <openspec/test/lint evidence>
primary_test_evidence: <test evidence or none>
primary_verdict: <none | PASS | WARN | CRITICAL | UNAVAILABLE> （本 skill 為 cross-model re-run；主審已在 /devpro:pre-pr Step 3 完成，通常填 `none`）
write_back: pr-sticky
linked_issue_context: <issue_read_required OR none — mode token only, never issue content; route SSOT: cross-runtime-parity spec -> External Reviewer Linked Issue Route>
approval_context: none
approval_resolution: {"status":"not-required"}
sticky_authority_snapshot: <complete canonical marker candidate snapshot for exact repository/pr; each comments[] entry MUST include body + html_url (or compliant url) + id + node_id + updated_at; missing identity → disposition blocked>
retry_context: <object with exact keys classification + sticky_verification; default {classification:"none", sticky_verification:"not-needed"}; never null-as-string or CRITICAL list>
previous_dispatch_id: <omit on first dispatch only with no pending marker/ancestor obligation; else direct predecessor dispatch_id for same-head retry or approved cross-head successor, including when CLI was not invoked but pending marker advanced>
packet_path: <absolute renderer-generated packet file>
observability_context_path: <absolute renderer-generated observability-context.json>
heartbeat_path: <absolute renderer-generated heartbeat.json>
activity_log_path: <absolute renderer-generated projection-activity.ndjson>
stdout_log_path: <absolute renderer-generated reviewer-stdout.ndjson>
stderr_log_path: <absolute renderer-generated reviewer-stderr.log>
cli_probe_result_path: <absolute renderer-generated cli-probe-result.json>
projection_bootstrap_command: <exact renderer-generated cwd-independent absolute command from observability-context.json>
projection_runner_command: <exact renderer-generated typed carrier from observability-context.json: cwd-independent absolute on non-Claude-Code hosts; repo-root-relative on the Claude Code host>
tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn
reviewer_cli_recipe.required_invocation_args: <exact renderer-owned argv from observability-context.json>

routing_context:
  - AGENTS.md §0
  - .devpro/agent-skills/devpro-reviews/second-review/SKILL.md
  - code-review-cross-model.md Cross-Model 第二意見節（SSOT）
  - code-review-cross-model-cli-contract.md §External Reviewer CLI Skill Contract
  - platform-adapters/claude-code-cross-review.md（本 host adapter；reviewer CLI 為 codex exec --json）
  - reviewer-family fallback：preferred different-family；codex CLI 不可用/未授權或使用者選 fallback 時，可由本 agent 做 same-family fallback，sticky 標 reason/provenance，不得宣稱 cross-model diversity
  - .devpro/agent-skills-refs/autonomous-ai-agents/codex/SKILL.md
  - platform-adapters/codex.md §Codex CLI Cross-Review Skill

請使用 TL supplied packet_path/observability/probe paths；不要重新 render；不要接受 TL-authored final prompt/packet。
第一個 executable action 必須先執行 exact `projection_runner_command`；runner nonzero exit 即
`projection_observability_contract_missing` 或 explicit runner fault，不得讀 docs/PR 或自行啟動 reviewer CLI。

Runner 會先執行 bootstrap，再 run
`.devpro/scripts/probe-second-reviewer-cli-recipe.mjs <observability_context_path>`，append
`projection_cli_probe_started` / `projection_cli_probe_result`，write cli_probe_result_path，
且只在 classification=`flags_supported` 後使用 sidecar 的 `reviewer_cli_recipe.required_invocation_args` exact argv；
不得從記憶重組 `codex exec` flags。執行期間依序 append `projection_cli_starting` / `projection_cli_started`
（`projection_cli_liveness_sampled` / `projection_cli_status_checkpoint` 為 duration-conditional）。
pr-sticky terminal 序 MUST 恰為 `projection_sticky_verification_started` →
`projection_sticky_verified` 或 `projection_sticky_verification_failed` → `projection_cli_exited`；
多、少或重排即 fail closed。

若任一路徑缺失或與 observability sidecar 不符，立即回 `projection_observability_contract_missing`；不得啟動
reviewer CLI，也不得等到任何 checkpoint 或 timeout。
若 `linked_issue_context` 為 `issue_read_required`，依 route SSOT `openspec/specs/cross-runtime-parity/spec.md` → `Requirement: External Reviewer Linked Issue Route` 取得 linked issue 及其 repo identity 後再讀；本區塊 MUST NOT 重述 route How。
pr-sticky mode 由 adapter-designated Codex-family reviewer 自行寫入／更新同一條 sticky comment
（find existing sticky → PATCH）；TL 轉述不算完成，回傳精簡 completion JSON（completion JSON 禁 local path/raw evidence；non-page-window 五欄 sticky_comment_url/verdict/last_reviewed_sha/reviewer_model/reason；page-window 十一鍵含 window/findings digest）。
`.trim()
})
```

上述 block 與下方 Codex host block 的 **host 差異**（TL-facing；MUST NOT 互抄，且刻意寫在 fence 外，因為
copyable payload 本身不得含對向 host 的 flag 字面值）：`primary_family` 為 `claude` 而非 `openai-codex`；
`review_material_carrier` 只能 `embedded-diff`，不得加 `adapter-live-pr-reads`——本 host 的 reviewer 走
`codex exec --json`，live PR reads 會撐爆 runner 的 64 KiB 單行上界而變成 `reviewer_output_line_overflow`
（見 `platform-adapters/claude-code-cross-review.md`）；本 host 的 reviewer recipe **MUST NOT** 帶 `--verbose`
（那是 Codex host 跑 Claude `stream-json` 才需要的 flag，見上方 Projection invocation discipline 段）；sticky
由 Codex-family reviewer 寫入，而非 Claude-family。

Codex host 委派格式（projection-first；這是交給 runtime-native `dp-second-reviewer` 的 bounded handoff block，不是 final Claude CLI packet；若 runtime 未 expose projection，才依 Codex adapter 記錄 `projection_unavailable` / `tool_discovery_blocked` / manual fallback reason 後走 direct adapter recipe）：

```
spawn_agent({
  agent_type: "dp-second-reviewer",
  message: `
objective: independent-judgment
responsibility_id: post-pr-cross-review
instance_mode: fresh
evidence_scope: <repo-relative or de-identified review scope descriptors (e.g. openspec/changes/<named_change>/, changed-files touch-list summary); absolute paths belong only in packet_path / observability_context_path>
return_and_stop: <compact completion JSON；sticky write-back 後停>
role: dp-second-reviewer
mode: pr-sticky
primary_family: openai-codex
pr_number: <# (string)>
head_ref_oid: <oid>
change_name: <string; the cost-advisory change binding; for round-override disclosure it MUST equal the change derived from the live PR head branch, which is used when change_name is absent>
page_window_max_pages: <1..4; omit for the default 1>
changed_files_or_touch_list: <bounded list>
review_scope: <typed full-pr | commit-range identity>
review_material_carrier: embedded-diff | adapter-live-pr-reads
review_material_capability: <finite-matrix capability>
review_material_proof: <scope-bound digest | adapter route proof>
done_when: <acceptance/evidence summary>
primary_validation_evidence: <openspec/test/lint evidence>
primary_test_evidence: <test evidence or none>
primary_verdict: <none | PASS | WARN | CRITICAL | UNAVAILABLE>
linked_issue_context: <issue_read_required OR none — mode token only, never issue content; route SSOT: cross-runtime-parity spec -> External Reviewer Linked Issue Route>
write_back: pr-sticky
approval_context: none
approval_resolution: {"status":"not-required"}
sticky_authority_snapshot: <complete canonical marker candidate snapshot for exact repository/pr; each comments[] entry MUST include body + html_url (or compliant url) + id + node_id + updated_at; missing identity → disposition blocked>
retry_context: <object with exact keys classification + sticky_verification; default {classification:"none", sticky_verification:"not-needed"}; never null-as-string or CRITICAL list>
previous_dispatch_id: <omit on first dispatch only with no pending marker/ancestor obligation; else direct predecessor dispatch_id for same-head retry or approved cross-head successor, including when CLI was not invoked but pending marker advanced>
packet_path: <absolute renderer-generated packet file>
observability_context_path: <absolute renderer-generated observability-context.json>
heartbeat_path: <absolute renderer-generated heartbeat.json>
activity_log_path: <absolute renderer-generated projection-activity.ndjson>
stdout_log_path: <absolute renderer-generated reviewer-stdout.ndjson>
stderr_log_path: <absolute renderer-generated reviewer-stderr.log>
cli_probe_result_path: <absolute renderer-generated cli-probe-result.json>
projection_bootstrap_command: <exact renderer-generated cwd-independent absolute command from observability-context.json>
projection_runner_command: <exact renderer-generated typed carrier from observability-context.json: cwd-independent absolute on non-Claude-Code hosts; repo-root-relative on the Claude Code host>
tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn
reviewer_cli_recipe.required_invocation_args: <exact renderer-owned argv from observability-context.json>

routing_context:
  - AGENTS.md §0
  - .devpro/agent-skills/devpro-reviews/second-review/SKILL.md
  - code-review-cross-model.md Cross-Model 第二意見節（SSOT）
  - code-review-cross-model-cli-contract.md §External Reviewer CLI Skill Contract
  - platform-adapters/codex-host-cross-review.md（本 host adapter；reviewer CLI 為 claude -p）
  - reviewer-family fallback：preferred different-family；claude CLI 不可用/未授權或使用者選 fallback 時，可由本 agent 做 same-family fallback，sticky 標 reason/provenance，不得宣稱 cross-model diversity
  - .devpro/agent-skills-refs/autonomous-ai-agents/claude-code/SKILL.md
  - platform-adapters/claude-code-cross-review.md §Claude Code CLI Cross-Review Skill

請使用 TL supplied packet_path/observability/probe paths；不要重新 render；不要接受 TL-authored final prompt/packet。
第一個 executable action 必須先執行 exact `projection_runner_command`；runner nonzero exit 即
`projection_observability_contract_missing` 或 explicit runner fault，不得讀 docs/PR 或自行啟動 reviewer CLI。

Runner 會先執行 bootstrap，再 run
`.devpro/scripts/probe-second-reviewer-cli-recipe.mjs <observability_context_path>`，append
`projection_cli_probe_started` / `projection_cli_probe_result`，write cli_probe_result_path，且只在
classification=`flags_supported` 後使用 sidecar 的 `reviewer_cli_recipe.required_invocation_args` exact argv。
執行期間依序 append `projection_cli_starting` / `projection_cli_started`
（`projection_cli_liveness_sampled` / `projection_cli_status_checkpoint` 為 duration-conditional；
`projection_cli_exited` 屬終局序，見下方 terminal 段）；
不得從記憶重組 `claude -p`/`codex exec` flags，Codex-host Claude `stream-json` recipe 必含 `--verbose`。

Wrapper 必須每 60 秒取樣自己擁有的 stdout/stderr 活性；15 分鐘只寫 status checkpoint 並自動繼續，
不得終止 reviewer、等待使用者授權或把 checkpoint 當 completion。總執行時間到 30 分鐘時，先做 final
completion/current-head sticky verification 與 fault classification，再自動終止。callback/process close 只是
wrapper 自身的 child-process terminal 訊號，不能替代 projection 讀自己 attempt_id 的 activity_log_path 終局
events 才能回報。Only the dispatching TL waits callback/event；callback-capable runtime 不得輪詢 agent lifecycle
或使用 list-agents busy wait；此 callback-waiting 授權不得轉移給本 projection 作為 background
`projection_runner_command` 並結束 turn 的許可，本 projection 須維持自己 return gate 的擁有者。無 callback
runtime 的 TL 才能每 60 秒檢查 lifecycle/artifact/sticky，最多 30 次／30 分鐘。

只有 `required_flag_absent_in_host_help` 可標 true unsupported recipe / `recipe_unresolved`；
`probe_evidence_unavailable`、`probe_malformed`、`probe_capture_suspect`、`recipe_parser_mismatch` 是 probe evidence
fault，不得當成缺 flag 或 `projection_runner_unavailable`。pr-sticky terminal 序 MUST 恰為
`projection_sticky_verification_started` → `projection_sticky_verified` 或
`projection_sticky_verification_failed` → `projection_cli_exited`；不得多、少或重排；stale sticky 不得當成 write attempt。

若任一路徑缺失或與 observability sidecar 不符，立即回 `projection_observability_contract_missing`；
不得啟動 reviewer CLI，也不得等到任何 checkpoint 或 timeout。pr-sticky mode 由 adapter-designated
Claude-family reviewer 自行寫入／更新 sticky comment；回傳精簡 completion JSON（completion JSON 禁 local path/raw evidence；non-page-window 五欄 sticky_comment_url/verdict/last_reviewed_sha/reviewer_model/reason；page-window 十一鍵含 window/findings digest）。
`.trim()
})
```

其他 host：依 `platform-adapters/codex-host-cross-review.md`（Codex host）/ `platform-adapters/cursor.md`（Cursor）/ `platform-adapters/copilot.md`；CLI unavailable 時依 adapter fallback，strict/no fallback 才 UNAVAILABLE + human。

### 5. 驗證 sticky write-back

Reviewer CLI 回傳後，驗證——不要假設——sticky 確實已落地（本步只轄 runner；External Evaluator 審查單改由 TL 跑 `accept-external-second-review.mjs <packet-dir>`，post-PR 通過只憑 `post-pr-completion-gate.md` External marker disposition 的 `clear_verified`，cross-model exempt 與 `MERGED` 依 `clear_policy`）：

```bash
gh pr view <PR#> --json comments,headRefOid
```

先驗post-PR exactly-one canonical current-head marker-matching `PASS` consumer authority；成立時later fault仍保留runner診斷但不要求receipt chain。Predicate不成立時，allowlisted orchestration fault須寫/驗blocked receipt並停止，`WARN`、`UNAVAILABLE`或其他fresh sticky不得覆蓋。確認 marker、current `dispatch_id`、bare-line `verdict:`、matching `last_reviewed_sha:`、bounded non-empty `reason:`，且 reviewed head 必須等於 current PR head（`last_reviewed_sha == headRefOid`，或 Path D′ fresh-equivalent 視同 match，SSOT `code-review-cross-model.md`）。Ancestor lineage 只可作 recovery traceability，不能通過 merge readiness；non-ancestor 另列 lineage-broken stale sha。Exact per-lineage approval 僅可恢復合格 active marker／clear-obligation binding，不取代 current-head dispatch/sticky。legacy sticky僅在完全沒有new-format dispatch record時可用。格式、binding或lineage不對，route adapter retry，不得自行修補。

**Harness `gh` write-block**：若 harness classifier 擋下 reviewer 的 `gh` write 而 `pr-sticky` 無法落地，**不得**把 `audit-only` 當 merge gate 替代品。依 `devpro:second-review` skill §Harness write-block degrade path：改跑 `audit-only`（`audit round cap 3`）→ TL 依 audit 輸出組 sticky body 並加 `provenance: manual-publish audit-only`（**NOT gate artifact**）→ 使用者 terminal 自行發佈 → merge gate remains unsatisfied，直到 verified `pr-sticky` 或 **explicit user waiver** 文件化。

### 6. 回報結果

在回應中陳述 verdict、sticky URL、`last_reviewed_sha` 與 reviewer model/surface。Orchestration fault只回傳允許的去敏欄位與 capsule/integrity prefix，禁止 local path/raw evidence。`CRITICAL`、`UNAVAILABLE`或allowlisted fault不得宣稱 ready。

`PASS/WARN`、`PASS|WARN`、skip/exempt MUST NOT stop at verdict/skipped/exempt。`PASS` / `WARN` 或 skip/exempt 最終回報 MUST follow `post-pr-completion-gate.md` Ready Response Next-Step Contract：列出 `Status:` ready / ready-with-warning、`Owner:`、`Next step:`、`Success condition:`、`CurrentIntent`、`NextAction`、`AskFirstPending`。若 owner=TL 且 batch approval / existing authorization 已覆蓋，continue with `NextAction`；若 owner=user（merge Ask First、approval/decision），提供 numbered options。

## Common Pitfalls（冷門細節：完整 troubleshooting 見 references/）

- Sandbox auth false-negative：sandbox 內出現 `Not logged in` / auth-network denied 是 **surface fault**，不是 reviewer-unavailable——宣告 fallback/`UNAVAILABLE` 前 MUST host-rerun；成功 init 的 `apiKeySource:none` 是中性 metadata
- Claude-family renderer effort `timeout` ≠ wrapper 30m cap；same-shape 加長 Shell 無效。Cursor 依 `platform-adapters/cursor.md` **TL renderer Shell** 換 surface，不把 probe timeout 當 Claude unavailable
- `error_max_turns`：invocation/orchestration fault——用較小的 packet 或 focused sticky-refresh 重新框定；不要只是調高 `--max-turns` 然後用同樣 shape 重跑
- Stale sticky + 窄 delta：用 focused sticky-refresh，不要廣泛探索 repo，否則會把 timeout budget 燒在不必要的 context 上
- Reviewer 可能已寫 sticky 後才 timeout：post-PR exact current-head marker-matching `PASS`先形成consumer authority；later fault保留診斷。`WARN`仍須無fault與完整receipt chain

完整決策樹（provider probes、`permission_denials`、sticky-only PATCH retry、`529 overloaded`）見 `references/troubleshooting.md`。

## Progressive Disclosure

- `references/troubleshooting.md` —— 從 `platform-adapters/codex-host-cross-review-troubleshooting.md` 濃縮的完整故障決策樹（provider probe history、max-turn/empty-result handling、permission denials、provider transient errors）
- `references/cli-invocation.md` —— 各 host adapter 的具體 CLI flag 對照表（Claude Code `claude -p` flags、Codex `codex exec` reasoning-effort flags），從 `platform-adapters/claude-code-cross-review.md` + `platform-adapters/codex-host-cross-review.md` 濃縮而來

只在 dispatch 真的出錯，或你需要確切 flag 語法時才載入這些——adapter 本身仍是 SSOT；這裡的 references 只是更快掃描的索引。

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/agent-skill-governance.test.mjs .devpro/scripts/tests/cross-review-cli-skills-grep.test.mjs
gh pr view <PR#> --json comments,headRefOid
```
