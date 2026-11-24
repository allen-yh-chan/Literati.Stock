---
name: workflow-cost-controls
description: status/next-step fast path、最短判定鏈與 review remediation stop-loss。
---

# Workflow Cost Controls

## Overview

Status/next-step asks use bounded evidence first; expand only when it is stale, conflicting, incomplete, or the user requests a global audit.

## When to Use

- 使用者問待辦、下一步、狀態、session-pending、PR/release state 或 cleanup branch hygiene。
- 工作需要多個 non-atomic tool loops、broad exploration、reviewer、fanout 或 broad suite。
- PR merge 後要決定 continuation handoff。
- Review remediation 要決定 batch admission、review 次數或 quota/cost stop。

## Process

### Status Fast Path

Pick the smallest matching lane first:

| Lane | First evidence | Sufficient no-op evidence |
|---|---|---|
| session-pending | `node .devpro/scripts/session-pending-claim.mjs list` or direct bounded read of `notes/session-pending.md` | no open or unclaimed matching item |
| PR state | known PR: `gh pr view --json number,state,headRefName,mergeStateStatus,statusCheckRollup,url`; unknown PR: `gh pr list --state open --json number,title,headRefName,state,url` | no open matching PR, or known PR is terminal |
| release state | targeted `gh run list --json databaseId,status,conclusion,workflowName,headBranch -L 10` plus named release branch/tag only when relevant | no relevant nonterminal or failed run and no user-requested release action |
| cleanup branch hygiene | `git branch --merged <target>` plus `git worktree list --porcelain` for the named branch/target | branch not production-eligible, or cleanup deferred until production |

The answer MUST include result, no-op evidence when applicable, owner, and next action. Do not list file line numbers unless the user asks for file references.

### Shortest Decision Chain

Before any work that requires more than one non-atomic tool loop, or any broad exploration, reviewer dispatch, fanout, or broad suite, the AI MUST define the shortest decision chain as `decision target`, `minimum evidence`, and `stop condition`.

The chain MAY live in the active plan or task ledger and MUST NOT create a new artifact solely for narration.

Every subsequent non-atomic action MUST produce the `minimum evidence` or satisfy a mandatory gate on the chain; if it cannot do either, it MUST be skipped.

Work outside the chain MUST NOT be performed merely because it may be useful, including exploration, documentation, review, or testing.

When the `stop condition` is satisfied, the AI MUST stop the chain and report the decision.

New evidence that proves the current minimum evidence cannot resolve the target MUST end the current chain; if work remains authorized and continues within the current scope, it MUST be replaced by the shortest next decision chain; otherwise the AI MUST stop and report the decision. It MUST NOT accumulate speculative branches. Unchanged chain state MUST NOT be repeatedly narrated.

This chain MUST NOT weaken Review Remediation Cost Stop-Loss; an active quota/cost hard-stop remains the stronger boundary.

### Unsolicited Status Narration Throttle

Throttle **unsolicited** user-visible status narration so the same `(scope, evidence digest, state)` is not replayed without new evidence. Unsolicited narration is limited to blockers/decisions、first verified RED、final GREEN、terminal outcomes、and milestones already required by other SSOTs.

**Exempt from this throttle**（MUST NOT suppress）:
- User-asked status / next-step（Status Fast Path 仍為權威）
- Machine heartbeat／activity／liveness／completion callback signals
- CI／workflow tracking surfaces（見 `git-workflow-tracking.md`）
- Stop-point communication contracts（見 `stop-point-comms.md`）

This throttle **MUST NOT** replace or weaken Status Fast Path.

### Review Remediation Cost Stop-Loss

TL MUST 在新 remediation batch 寫入前依 `design-core.md` §Scope/Value Pre-Write Admission 完成範圍／價值准入；review finding 不擴大原核准需求。

After each primary review receipt, freeze one accepted remediation batch. Same-PR admits only Critical or direct source/repro proof breaking current acceptance/security/trust-boundary/runtime correctness/existing RED validity. Suggestion (and other non-blocking) findings MAY take disposition + owner follow-up and MUST NOT alone change behavior-risk digest or trigger full review. Seal requires Critical=0 ∧ Important=0 over in-scope／unlabeled findings with finished verdict（範圍外處置見 `code-review-checklist.md` R11，severity 不改寫）；in-scope／unlabeled Important／Critical MUST NOT close via `tracked-follow-up`／`defer-with-owner-trigger`（only `fix-now`｜`non-issue-with-evidence`）. A successor round whose sole job is clearing remaining open Important／Critical (`blocking_ids` true-subset shrink) is **clearance**, not abusive stall.

Traceable in-scope trivial-fixable Suggestions already within the accepted repair batch remain same-change `fix-now` per `code-review-checklist.md` Finding Disposition Discipline; this does not admit a new requirement or scope. Their successor review material follows that checklist's §小修與 bounded 複審範圍. Follow-up is not the default substitute for these small fixes.

Per accepted batch: at most one RED-contract review, at most one post-GREEN source review, at most one OpenSpec update, and at most one OpenSpec closeout; reviewer-of-review MUST NOT dispatch another reviewer. Caps do not require extra reviews.

User quota/cost concern or trusted runtime/provider warning activates a hard-stop before the next non-atomic reviewer, fanout, or broad suite; only an already-running atomic command MAY finish. The Cost Circuit Breaker's three cumulative totals (`lib/cost-budget.mjs`: `output`, `cache_read`, `model_time`) are **advisory** in every consumer: still measured, still reported, and MUST NOT be relayed as a stop or recorded as blocked. A total says how large a change is, not whether anything is being wasted, so it is not what asks a user to stop. `stalled_rounds` still counts consecutive review rounds whose **blocking_ids** (open Critical／Important) set made no progress: progress = strict subset shrink of `blocking_ids`; same-cardinality swap `{A}→{B}` counts as stall; clearance subset shrink does **not** (cap SSOT `lib/review-stall-budget.mjs`). What still activates the same hard-stop independent of user or runtime signal is a blocking Cost Circuit Breaker threshold (`lib/cost-budget.mjs`: `stalled_rounds` reporting **`unavailable`**) — receipts exist and the chain will not load, so the gate's own evidence is damaged and FAIL CLOSED applies. The pr-sticky review-round cap is enforced solely by the round gate (`review_round_budget_exhausted`, whose only unlock is `DEVPRO_REVIEW_ROUND_OVERRIDE`) and is not a Cost Circuit Breaker threshold. Convergent `stalled_rounds` / three-round bounded cap **exceeded** does **not** activate that hard-stop: follow Wave／Stall Revokes recovery (no unlock). Scope: this is the pre-dispatch hard-stop only; the post-PR completion Stop hook keeps its own block table and still blocks on `stalled_rounds` `exceeded` as well as `unavailable` (`POST_PR_BLOCKING_COST_THRESHOLD_STATES`, D20), returning the choice to the user instead of unlocking. Record state, remaining gates, and model/cost plan. Resume requires explicit user approval for the exact bounded scope on the quota/runtime/`stalled_rounds`-`unavailable` hard-stop path only; one artifact-batch approval does not authorize Round-3, another review, archive, or broad suite.

Post-PR Stop 從 PR 所屬 repo 的已驗證 checkout 讀成本與 disclosure。找不到 checkout 時，從目標 repo 重查。要套用名稱型 override，從目標 checkout 用同一 session 重跑，`DEVPRO_POST_PR_COMPLETION_STATE_DIR` 指向原 marker 目錄（預設為原 main checkout 的 `notes/tmp/state/devpro-post-pr-completion`），checkpoint 用目標 repo 的原位置。marker 已結清時，回報成本結果交使用者決定。快取與提醒的 repo 歸屬見 `pre-tool-mechanical-gates` §Post-PR Completion Stop Hook Cost Circuit Breaker Block。

**Cross-model repeat-finding simplify-first（pointer）**：當 cross-model round 對同一函式／機制連續 ≥2 輪以新場景擊破同一缺陷類時，下一輪修復前的判斷順序見 `code-review-cross-model.md` §Round Budget「同函式同缺陷類 ≥2 輪 → 先刪／簡化」；簡化判準仍用 `code-simplification.md`／`pre-implementation-over-design.md`，本檔不複寫。

Scope/architecture and the single authority review MAY use high reasoning; mechanical work follows `model-delegation.md`, large output follows `token-frugal-io.md`; an estimate MUST NOT be reported as actual savings.

### Review Wave Discipline（primary 六軸一次 ＋ focused successor）

- Primary 六軸只在 frozen artifacts 上跑一次＝`initial full` receipt（round one must be initial full）。remediation 凍結成一批後，同責任的再審一律 `continue` 既有 reviewer thread（經 receipt 端 chain 驗證可封存，未宣告的續作無法封存，見 `model-delegation-threads-and-caps.md` 續作條），或以 sealed receipt 接手的 replacement（只做 focused verification：open blocking IDs＋repair delta＋dependency closure；MUST NOT 全量六軸重掃或擴 scope），只核對 open finding（successor 形狀：previous receipt ref ＋ initial full digest）；同 role fresh spawn ≠ continuation；reviewer-of-review MUST NOT dispatch another reviewer（見 Stop-Loss）。
- 三個 round cap 分列、不得合併：audit-only 上限 6 輪（anchor `audit round cap` 與數值 SSOT 在 `devpro:second-review` skill／`devpro:change` design gate）、pr-sticky 3（`code-review-cross-model.md` §Round Budget）、harness write-block audit-only 3（`devpro:second-review` skill）。本檔只宣告分列，數值 SSOT 在各自載體。
- pr-sticky counting round 只含 `initial`／`focused-sticky-refresh`；同一 head 的 `page-window-continue`（由 checkpoint sidecar 證明 `page_window_checkpoint_handoff`＋單調 `window_index`，不得呼叫端自宣）寫入 lineage 但不遞增 `round_count`。Cap 預設維持 3；不得以 `DEVPRO_HOOK_BYPASS` 當大 PR 解法。
- 被豁免 post-PR cross-model second review 的 PR，仍 MUST 有一次 `fresh` 獨立 primary review（`dp-reviewer`，receipt `executor_kind: runtime-agent`）；TL-direct receipt 不得充當該獨立審查。
- Half-state（`lib/cost-budget.mjs` 導出 `budget_state: at-or-above-half`／`unavailable`；數值門檻 SSOT 為 `COST_BUDGET_THRESHOLDS`，本檔不複寫）**本身不撤銷任何授權**：它由三個累計量推導，而總量量的是 change 有多大、不是有沒有在浪費。`budget_state` 仍照常求值、照常印出、照常留紀錄，現況用途為 **audit／report only**。`stalled_rounds` 或 three-round bounded cap 在**可收斂**路徑上 MUST NOT 預設 `handback_required`：classifier 簽發 focused `route=bounded`／`full_reopen_reason=convergence_recovery`（recovery reason，不是 full reopen），scope 凍結於仍 open 的 blocking IDs＋repair delta＋dependency closure；同一 `dp-reviewer` thread 能接續則 `continue`（同 role fresh spawn ≠ continuation）。Suggestion 與已 `tracked-follow-up` 關閉的 out-of-scope finding MUST NOT 擴張 blocking set；仍 open 的 Critical／Important 留在其中。下一輪 recovery 僅在每個仍 open blocking ID 都有綁定上一 recovery `dispatch_id` 的新 disposition（root-cause fix／simplification／`non-issue-with-evidence`）時才再簽發；否則 `route=recovery_disposition_required`（非 handback、不要求 user unlock）。Blocking 歸零且其餘 final 前置滿足 → `final_ready`，**不**要求 override。`REVIEW_STALL_ROUND_CAP` 與 bounded 自動觀察門檻維持 stop-loss 數值（不得抬 cap 當修復）。真 handback 僅明示 `handbackCause` ∈ `requirement_conflict`｜`irreversible_high_risk`｜`reviewer_unrecoverable`；此時才回 `handback_required`（不簽發 `dispatch_id`），再由使用者 exact single-use override 授權恰一次 `route=bounded`／`full_reopen_reason=handback_authorized_bounded`（無獨立 mandatory-full 時）或 `route=full`／`full_reopen_reason=handback_authorized_full`。mandatory-full reopen 命中時 cap 必須讓位；`stalled_rounds` 僅對 mere `risk_shape_changed` 不讓位（出口改 recovery），其餘 mandatory-full（`git_lineage_changed`／`validator_trust_surface_changed`／…）仍必須讓位為 full。prior batch approval 不得替代 override。授權優先序：`exact single-use override（僅真 handback 後）> convergence recovery（stall／cap 可收斂）> 先前 batch approval`。**評估面限定**：`budget_state` 只在**需要一次新授權的動作**之前評估——即新 `fresh`／`fork` work-lane spawn 與新 review-lane dispatch；`continue` 續作與 TL-direct 都不需要新授權，故 MUST NOT 評估；以 `continue` 派的 bounded rereview 亦同。
- Half-state 機械載體（exact-once override claim）：`classify-bounded` request 帶 `budgetState`，其現況用途只為 audit／report。Override 檔 `<override_id>.json` 只由 `node .devpro/scripts/issue-half-state-override.mjs` 在使用者明示後簽發（`issued_by: user`、`responsibility_id` 綁定、`scope: review-dispatch`），且**只**在 durable `handback_required`（明示 `handbackCause`）之後、classifier 產生 `handback_authorized_bounded|handback_authorized_full` 時，才在同一步以 `overrideId`＋`responsibilityId` 通過 exact-once claim；claim 是 `openspec/changes/<change>/override-ledger/<override_id>.claim/` 的 non-recursive `mkdir`，任何 `EEXIST` 一律不授權。普通／recovery `route=bounded` 即使誤帶 override 也 fail closed 且不得消耗。**窄 handback→bounded→final**：真 handback 後 authorized bounded 封出合格 `finished`，其餘 final 前置滿足時 `classify-final` 可達 `final_ready`；可收斂路徑不以 override 為正常下一步。自動 bounded 觀察門檻仍為三、`REVIEW_STALL_ROUND_CAP` 仍為 2（僅 stop-loss）。`stalled_rounds` 由 sealed receipt chain 自算，不接受 caller 宣告。
- Post-cap receipt gate：任何 `bounded_rereview_count > 3` 的 bounded receipt 在 seal 與後續 chain walk 都 MUST 要麼由 `hasConsumedHalfStateOverrideClaim` 找到同 `responsibility_id`＋`dispatch_id` 的 durable `consumed.json`（真 `handback_authorized_*`），要麼由 chain walk 證明 classify 簽發的 `convergence_recovery` 綁定同一 `dispatch_id` 與 repair／closure manifest、且 predecessor 非 `handback_authorized_*`；偽造／改標的 recovery 仍 fail closed。

### Broad Scan Avoidance

The first pass MUST NOT start with broad repo-wide `rg -n`, broad state dumps, `notes/tmp/state`, `openspec/changes/archive`, `.worktree`, or `refs`. A broad repo-wide `rg -n` first pass is allowed only after the fast path shows a real gap or the user explicitly asks for global inventory.

If narrow evidence is sufficient, stop there and say so.

### Post-Merge Continuation Priority

After PR merge, apply: `sync main -> recap -> user-requested release -> production back merge -> cleanup`.

- Sync/status is automatic per `git-workflow-tracking.md`.
- Recap is first when due.
- Release/back-merge require the normal approval and release-flow boundaries.
- Cleanup remains status-only until production; it is not the first next action.

## Exit Criteria

- Smallest lane matched, no-op evidence reported, and broad scan used only on a specific trigger.

## Common Rationalizations

| Rationalization | Correction |
|---|---|
| "A full repo scan is safer." | Use Status Fast Path; escalate only for stale, conflicting, or incomplete evidence. |
| "Cleanup is obviously next after merge." | Defer cleanup until production. |
| "The user asked about rules, so I can patch rules directly." | Rule-feedback writes require devpro:change/OpenSpec unless exempt. |

## Verification

- `node --test .devpro/scripts/tests/workflow-cost-controls-grep.test.mjs`
- For full pre-PR, run `node .devpro/scripts/run-test-suite.mjs --changed main` after the change is committed or otherwise ready for the selected base.
