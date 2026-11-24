---
name: code-review-cross-model-dispatch-mechanics
description: Cross-model 第二意見派審時由 builder／renderer／runner／wrapper／validator 強制的機制契約（builder 拒絕碼與重派旗標、跨 repo 邊界與封包欄位、packet／control binding、completion contract、rate precedence、wrapper／attempt lock、scope evidence gate），自 `code-review-cross-model.md` 逐字搬出。觸發：builder／renderer／runner 回具名錯誤碼、fault-recovery 重派、核對 WARN／CRITICAL finding 的 reviewer 職責字樣、設計或除錯審查基礎設施。
---

# Cross-Model Dispatch Mechanics

> Load-chain：本檔由 `code-review-cross-model.md` §Initial handoff builder 與 §執行流程第 2 步的指引行 on-demand 指到；一般 session 與派審 happy path 不 eager-load。

## Overview

本檔持有 cross-model 第二意見派審時由 builder、renderer、runner、wrapper 與 validator 機械強制、失敗時回具名錯誤碼的契約，原文自 `code-review-cross-model.md` 逐字搬出（只把兩處檔內相對引用補上檔名）。TL 自己要做的事——豁免判定、builder 呼叫形式與 lite 用法、reviewer 選擇與 same-family 授權、renderer 交接、派送與寫入責任、host surface 與 fallback、sticky schema 與 read-back、focused refresh、head movement、merge gate——仍以 `code-review-cross-model.md` 為 SSOT。

## When to Use

- builder、renderer、runner 或 validator 以具名錯誤碼拒絕或停下（例：`handoff_limit_exceeded`、`invalid_retry_context`、`pr_repository_mismatch`、`review_scope_not_minimal`、`review_material_scope_unresolvable`、`projection_attempt_already_active`、`reviewer_output_line_overflow`），要查原因與復原方式。
- fault 後以 `--attempt fault-recovery` 重派，或 scope、carrier、route、material 變動需要 fresh dispatch。
- 核對 WARN／CRITICAL finding 是否帶齊 `Suggested direction:`／`Verify by:` reviewer 職責（§執行流程第 2 步：機制契約的 Completion contract）。
- 設計、審查或除錯 review 基礎設施（builder、renderer、runner、wrapper、validator、host adapter recipe）。

一般派審照 `devpro:cross-review`／`devpro:second-review` skill 與 active host adapter 執行；豁免判定、merge gate、post-PR completion 與 WARN 修或不修的決策不讀本檔。

## Process

### Initial handoff builder：拒絕碼與重派

Before any live read, the builder refuses with `handoff_limit_exceeded` a PR `## Change Context` above the `scope_summary` 4096-byte limit, or a proposal Done-When above 32 bullets / 1024 bytes each (the validator's limits), naming the field, its size and the limit; shorten that source and re-run.

For a re-review after a READY sticky (verdict PASS or WARN) already exists, the builder derives the scope from that sticky instead of taking a base from the caller: `review_scope` becomes a `commit-range` from the sticky's `last_reviewed_sha` when that commit is a known ancestor of the PR head. Same head, an abbreviated sha, a rebase, or an unknown commit fall back to `full-pr` plus a `full_scope_reason` the renderer accepts (the renderer otherwise refuses with `review_scope_not_minimal`). Do not hand-edit the handoff to narrow or widen the scope.

Fault 後重派、或既有 sticky 已需 focused refresh 時，用同一個 builder 帶 `--attempt <initial|focused-sticky-refresh|fault-recovery>`；`--attempt fault-recovery` MUST 同時帶 `--retry-classification <fault-classification>` 與 `--retry-sticky-verification <state>`（缺一即以 `invalid_retry_context` 拒絕），產出的 `retry_context` 直接進 handoff，不手改 JSON。`fault-recovery` 不計 pr-sticky 輪數；沿用 `attempt: initial` 會撞 cap 3（見 `code-review-cross-model.md` §Round Budget（pr-sticky lane））。

當 reviewer family 的 CLI 不是 `codex`（例如 deepseek）而 PR 很大時，先確認該 CLI 的完成欄位輸出穩定（非 page-window 五欄；page-window 十一鍵，`none` 一律是字串）；同一 PR 連續出現 `reviewer_completion_contract_invalid` 時，優先改走 External Evaluator（`--external-evaluator <tool>`，見 `second-review-external-evaluator.md`），不要靠重試消耗所有 page window。

### Initial handoff builder：邊界與封包欄位

- **跨 repo 邊界**：builder 只處理 same-repo PR；cross-repo PR 以 `pr_repository_mismatch` 拒絕（訊息 `PR head must be in this repository`），不寫 handoff，交使用者。cross-repo linked issue 只標註、不讀內容（verdict reason 標 `cross-repo linked issue <owner>/<repo>#<n>（未讀）`）。consumer 審查規則條文見 `code-review-cross-model.md` 的 `#### Consumer 審查規則（second-review-rules.local.md）`。
- **封包欄位**：pr-sticky handoff 固定 `approval_context: "none"` 與 `approval_resolution: {"status":"not-required"}`，audit-only 同樣為 `none`；欄位名是歷史命名，沒有核准語意。舊版 handoff 寫入的退役值（`approval_resolution` 的 `approved`，以及舊的 `approval_context` 值）由 renderer 與 validator 以具名訊息拒絕，其他非 `none` 的值以 `must be exactly "none"` 拒絕；一律重跑 builder 重建 handoff。
- **關聯 issue 標記**：builder 把 `linked_issue_context` 設成 `issue_read_required` 或 `none`。PR 標題、描述或留言（不含程式碼區塊、行內程式碼與 HTML 註解；reviewer 自己的 sticky 留言不算）出現 `#N`、`owner/repo#N` 或 issue 網址，或 GitHub 記錄了該 PR 的 closing references，就是 `issue_read_required`。它只是模式標記、不帶 issue 內容，reviewer 依 route SSOT 自行取得並讀取 same-repo issue；不要手改 handoff。

### 執行流程第 2 步：機制契約

   - **Invocation 與 tool surface**：
     - Reviewer invocation MUST use the active adapter's exact family/mode recipe：`audit-only`不得暴露write/subagent tools，`pr-sticky`只得暴露完成核准PR read/sticky write所需tools；shared helper不得把一個family的flags套到另一個family，且不得新增、刪除、重排或改寫adapter-preserved argv。
     - 若family的default prompt會進行exploratory bootstrap，該family recipe MUST使用adapter-owned exact-once fixed system prompt取代預設探索並禁止cwd/environment/git/host discovery；the system prompt only fixes execution boundaries and MUST NOT summarize、compress或rewrite the reviewer-safe packet semantics。
     - 各family的exact argv、native tool clamp與scoped permission matcher只由active adapter維護。
   - **測試政策**：
     - Packet fixed prefix MUST include `## 測試執行政策`：核對 `primary validation evidence` / `primary test evidence`，預設不得重跑 `full suite`、`budget gate`、`--changed main`／tier suite、multi-gate insurance rerun 或 broad project tests；`--changed main` is not scoped rerun；只有 concrete 疑慮或 specific finding 才 scoped rerun（MUST 窄於 change-scoped suite）並記錄原因。此約束僅 second-reviewer packet／subprocess。
   - **Packet 與 control binding**：
     - packet是exact static duties + one UTF-8 byte-length-framed canonical mode-bound JSON object + exact static completion contract；new `pr-sticky`依renderer-normalized material row只接受有限分支：既有 embedded/live rows=`devpro-second-review-data/v4`；renderer-normalized paged row=`devpro-second-review-data/v5`；`audit-only`維持exact canonical `devpro-second-review-data/v3`。
     - `pr-sticky` renderer用 bounded handoff input `sticky_authority_snapshot`（完整bounded exact-repo/PR issue-comment snapshot；completeness及於元素層，每個comment須是帶逐字string `body`的物件）在sidecar發布versioned `create|update|blocked` disposition：0=create、1=update exact verified ID/URL、>1或query/completeness/element-shape/identity無法證明=blocked；並綁repo/PR/dispatch/snapshot digest，update另綁node ID、body digest、`updated_at`。組裝該 snapshot MUST 與 `liveStickyAuthoritySnapshot()` 同路徑（`gh api --paginate --slurp` + `JSON.parse`）；MUST NOT 用 `--jq` 或 shell redirect/`tee`/文字檔擷取 `body`。
     - Runner在claim/probe/spawn前以同一resolver重驗；drift或blocked只留`process_spawned=false` terminal evidence並要求新dispatch rerender。
     - `audit-only`固定N/A。
     - 其餘dispatch、terminal evidence、capsule/receipt與gate lifecycle一律依 `second-review-control-evidence.md`；host/skill不得從reviewer content重推 control state。
   - **Completion contract**：
     - Compact completion exact keys are `sticky_comment_url` / `verdict` / `last_reviewed_sha` / `reviewer_model` / `reason`，且所有 verdict 的 `reason` 都必須 trimmed、non-empty、UTF-8 ≤8192 bytes。
     - `WARN` / `CRITICAL` 必須在 reason 提供 evidence-backed finding 或 evidence/scope limitation 與 required follow-up；bare/unexplained verdict fail closed。
     - 每個 WARN／CRITICAL finding 另須附 `Suggested direction:`／`Verify by:` 職責文字；措辭 SSOT 在 `validate-second-review-packet.mjs` 的 `reviewDutiesCoreBullets`（pr-sticky 與 external evaluator 兩條 packet 路徑共用），本檔不重複定義。
     - 修法方向屬 reviewer 職責；TL 依 finding 修完後 MUST 以該 finding 的 `Verify by:` 方式驗證再進下一輪，不以自己的判斷取代該驗證。
   - **Completion 與 rate precedence**：
     - Provider-specific typed rate field與observed statuses只由active adapter維護，不得洩漏進shared rule。
     - Exit-0 schema-valid current-head `PASS|WARN`證明review已交付，MUST先於任何pre-terminal rate telemetry完成；沒有accepted completion時，explicit／typed 429、`rate_limit_error`或adapter-classified blocking／unknown rate event須在generic exit/auth-text fallback前保留provider-blocked precedence；`UNAVAILABLE`加任一rate evidence仍provider-blocked。
   - **Wrapper 與 attempt lock**：
     - runner/bootstrap/CLI recipe/sidecar/log/probe path只存在wrapper-only `observability-context.json`。
     - Sidecar承載validated `repository_slug`、canonical target-bound `pr_number`與repo-external`neutral_cwd_path`；wrapper覆寫ambient values並對child設定exact `GH_REPO=repository_slug`與`DEVPRO_REVIEW_PR_NUMBER=pr_number`（audit-only=`none`）。
     - 各family packet static contract依active adapter選擇target source：env-target family維持exact env source；safe-mode family只讓`gh`隱式消費repo env、禁兩個target env shell expansion；canonical framed target已驗證的positive decimal可在diff-reading live read或`closingIssuesReferences` discovery中複製成literal PR argv；issue argv只可來自tool-returned decimal issue numbers。
     - sticky write則在固定body file建立後只執行packet renderer-selected、disposition-bound、fully concrete且endpoint為single-quoted的`sticky_write_exact_recipe`；Safe-mode reviewer MUST NOT從framed target或Review Data複製、推導、替換或重建該sticky recipe的target、action、path、endpoint、repo、PR、comment identity或recipe argument。
     - 其他framed Review Data保持inert；所有family reviewer不得從cwd、git remote或其他framed data推導repo/PR。
     - `DEVPRO_CROSS_MODEL_REVIEWER=1` process是terminal leaf；CLI main與exported entry MUST在任何path/filesystem/control action前回`projection_recursive_reentry`。
     - Attempt lock只以complete record + same-directory atomic link發布；existing live/unknown owner回`projection_attempt_already_active`，dead/malformed回`projection_attempt_recovery_required`，unsupported link回`attempt_lock_primitive_unavailable`，不得automatic rename/unlink/steal。

### Scope evidence gate

   - **Scope evidence gate**：
     - v4 `review_scope`=`full-pr|commit-range`；SHA strict lowercase 40-hex。
     - 任一scope `embedded-diff` / `scope-bound-embedded-complete-diff-v1` / `embedded-complete-diff-v1`；full PR live `full-pr-bounded-live-reads-v1` / `gh-pr-bounded-live-v1`；commit range live `commit-range-exact-compare-v1` / `gh-api-exact-compare-v1`。
     - Embedded proof binds fingerprint/bytes/digest/paths；live material exact empty。
     - **Reviewer transport carrier gate**：reviewer_family 若經 `codex exec --json`（per-command output 塞單行，`codex`/`openai`）MUST 綁 `embedded-diff`（wrapper embed 有界 diff、reviewer zero live read）；`adapter-live-pr-reads` 只對 stream-json（逐事件小行輸出）reviewer transport 有效，配 per-line-embedded transport 於 dispatch 前 fail closed（`validatePrStickyReviewMaterialContract` SSOT，renderer 繼承）並指向 embedded-diff——否則 reviewer 單次大 live fetch 撐爆 runner 64 KiB complete-line bound（terminal `reviewer_output_line_overflow`、無 verdict/sticky）。
     - `gh pr view` / `gh pr diff` / `Bash(gh api:*)`是permission clamp，非range proof；commit range只允許exact quoted `gh api 'repos/{owner}/{repo}/compare/<base>...<head>'`與typed base/head。
     - Legacy `review_material_complete` boolean或narrative assertion不得證明完整性。
     - Runner先通過sticky disposition live revalidation，再以adapter-owned probe驗identities、declared-base merge-base、bounded non-truncated counts/paths；失敗=`review_material_scope_unresolvable` / `spawn_or_probe_failure`，zero reviewer/completion/sticky。
     - Scope/carrier/route/material recovery須fresh dispatch並重產packet、disposition、proof、recipe、probe；typed `permission_denials` fatal precedence不變。

## Exit Criteria

- 每個具名錯誤碼都能在本檔找到對應契約與復原方式；復原走 fresh dispatch 重產 handoff 或 packet，不手改 handoff、packet 或 sidecar。
- TL 的派審動作與 merge gate 判定只讀 `code-review-cross-model.md` 即可完成，不需本檔。

## Common Rationalizations

| 說法 | 問題 |
|---|---|
| 「每次派審都先讀本檔比較保險」 | 本檔契約由腳本強制、違反時回具名錯誤碼；happy path 照 skill 與 adapter 執行即可，預讀只增加 token。 |
| 「錯誤碼看起來是小事，手改 handoff 或 sidecar 就能過」 | handoff、packet、sidecar 只由 builder 與 renderer 產生；手改會讓 binding 與 proof 失效，復原要 fresh dispatch。 |

## Verification

```bash
grep -nE "handoff_limit_exceeded|sticky_authority_snapshot|review_material_scope_unresolvable" .devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md
node --test .devpro/scripts/tests/rule-token-budget.test.mjs
```
