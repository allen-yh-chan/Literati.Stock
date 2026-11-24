---
name: post-pr-completion-gate
description: "PR 後 completion gate"
---

# Post-PR Completion Gate

## Overview

PR URL/check polling is not completion.

## When to Use

- PR 建立後、complete/ready/merge 前。

Load-chain（current／ancestor 缺損或既有 lineage 的 predecessor 缺失時）：MUST 讀 `second-review-ancestor-recovery.md`；正常 review 不載入。

Load-chain（attempt 中斷要放棄、legacy 診斷 attempt 或 credential gate 失敗缺 receipt 時）：MUST 讀 `second-review-operator-recovery.md`；正常 review 不載入。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `post-pr-completion-check.mjs`、merge gate、hook tests |
| Advisory | host adapter、cross-review skills |
| Doctrine | N/A |

### Shared Gate

1. **PR creation path is not an exemption**：PR URL / number 即啟動；connector、CLI、app integration、generic publish / `commit push PR`、future runtime 均不可略過。GitHub 選路依 `tool-selection.md`：已登入 gh 優先；僅未安裝／明確未登入時，可使用具等價閘門的 devpro-work MCP。其他 connector 仍唯讀。
2. **Workflow status**：依 `git-workflow-tracking.md` 追 Actions 終態；無 workflow/path-filtered 時明示 N/A。
2a. **Step 5 ∥ Step 5.5 Parallelism（SSOT）**：`gh pr create` 後，Step 5（workflow watch 至終態／checks-based N/A）與 Step 5.5（cross-model sticky dispatch／write-back）**MAY／SHOULD 並行啟動**。Pointer-only：`devpro:pre-pr`、`git-workflow-tracking.md`、`dev-flow-checklist.md`——禁複寫衝突 serial 順序。
   - **MUST NOT**：以 CI／workflow 終態作為 sticky 啟動或完成的前置；以「等 CI／Actions／subscribe」為由 idle-stop 再跑 Step 5.5；把 path-filter miss／expected-skip／no-trigger 推測當 sticky N/A；在 workflow 終態證據尚未存在時於 sticky 寫 CI 綠／workflow complete（若提及 CI 欄，終態前只能 `pending`，終態後回填）。
   - **MUST**：sticky N/A 僅走既有 checks-based 豁免路徑（`gh pr checks` 具名證據 + `code-review-cross-model.md` exemption evidence）；merge readiness 仍要完整 gate（workflow 終態或 checks-based N/A + sticky／exempt + 使用者 merge 授權）——並行**不**弱化 merge 前 CI 終態回報；Ask First／FAIL CLOSED 正當停點仍保留。
3. **Cross-model status**：依 `code-review-checklist.md` + `platform-adapters/<host>.md`。
   - exempt：回報 branch-pattern / diff-shape。
   - non-exempt：adapter second-review；reviewer 自讀 PR/review packet；sticky writer 依 adapter；TL 不得撰寫/改寫/補完 reviewer-produced findings/verdict；保留 reviewer provenance。
   - control evidence：依 `second-review-control-evidence.md` 消費 current-dispatch structured result，禁止掃 reviewer content。下列 acceptance／marker CAS 路徑（含 authoritative PASS）均先遵守該 leaf §3.4 retirement fence；valid authority 阻擋其 members，corrupt/unreadable authority 阻擋 root，且不因此增加 PASS local-receipt 要求。Consumer authority 與 runner terminal classification 分開，runner marker 依下列順序執行（external-evaluator marker 不適用 1–5，見下方 External marker disposition）：
     1. **Authoritative PASS branch**：normal active、owned `MERGED` 先驗 exactly one parseable canonical sticky：`verdict: PASS`、`last_reviewed_sha == headRefOid`、`dispatch_id == marker.expected_dispatch_id`（`last_reviewed_sha` match 得由 Path D′ fresh-equivalent 視同，SSOT `code-review-cross-model.md`）。成立即為 consumer authority；owned scope 清 matching marker；其他 session 不由此 Stop 清理。Later same-dispatch tooling/orchestration fault仍保留為runner診斷，但不要求completion、fault-consumption、supersession或successor receipt，也不得推翻PASS。
     2. **非 PASS 分支**（2 Fault／3 WARN receipt-chain／4 Closed-terminal／5 Fail-closed）：authoritative PASS predicate 不成立時依 `post-pr-marker-disposition.md` 逐支判定；allowlisted fault、closed-terminal、missing／corrupt／並存 evidence 一律 blocked 並保留 marker，只有完整 WARN receipt chain 驗證後才可清 marker。
   - **External marker disposition**（`marker.executor_kind === "external-evaluator"`；恰回一個）：`clear_policy`（`MERGED` 或 cross-model exempt）｜`clear_verified`（已 accept 的 external completion receipt exact 綁當前 PR head 與 sticky body，verdict∈PASS｜WARN）｜`retain`（其餘）。完整判定條件與 blocked 訊息分流見 `post-pr-marker-disposition.md` §External marker disposition。
   - PR 已 `MERGED` 時（runner marker；external marker 由 `clear_policy` 清），matching authoritative PASS 可依上列 consumer-authority path 清 dispatch-bound marker；predicate 不成立時，合規 Path W waiver 可先清 marker（見 Exit Criteria Path W pointer），否則仍須完成原 consumption/supersession chain。只有完全沒有 new-format dispatch binding 的 legacy marker 可走 legacy merged self-heal。
   - final blocker：complete/ready前先驗 authoritative PASS predicate。成立時不消費fault/receipt chain即可通過；不成立時只有無current allowlisted fault、無closed-terminal failure、completion receipt exact綁current `WARN` sticky與`process_close_observed=true`、且evidence chain完整才通過。Invocation-only、closed-terminal receipt、`CRITICAL` / `UNAVAILABLE` / missing / duplicate / parse fail / stale sha（非 Path D′ fresh-equivalent）/ dispatch mismatch → blocked，跑 `/devpro:cross-review <PR#>`。External-evaluator marker 不適用本條：通過＝External marker disposition 的 `clear_verified`（未 accept 的自寫 PASS 不通過，WARN 不要求 `process_close_observed`），retain 依同條分流（只有無 slot／accepted 缺收據才指向 accept helper）。
   - sticky identity evidence：使用者可見驗證必須同時回報 sticky URL + `last_reviewed_sha`；new-format 另驗 current `dispatch_id`。
   - sticky schema：bare lines only；canonical marker、`verdict`、`last_reviewed_sha`、`dispatch_id`、`reason`與final Rules/tool/model provenance各必須exactly once；重複值即使相同也fail closed。Verdict MUST match literal regex `^verdict:\s+(PASS|WARN|CRITICAL|UNAVAILABLE)\s*$`；SHA MUST match literal regex `^last_reviewed_sha:\s+([a-f0-9]{7,40})\s*$`；Markdown emphasis/code spans/bullets/headings rejected。Runner、本gate與merge gate必須共用同一exact-once parser/contract，不得各自first-match。
   - sticky_authority_snapshot capture：組裝 `pr-sticky` handoff 時 MUST 與 `liveStickyAuthoritySnapshot()` 同路徑（`gh api --paginate --slurp` + `JSON.parse`，comments 用解析後物件原樣 `body`）。MUST NOT 經 `gh api --jq`、shell redirect、`tee`、或文字檔中介擷取 body（jq 字串輸出會加尾端換行 → `body_sha256` drift → `sticky_write_disposition_blocked`）。
   - lifecycle durability：任何 marker clear（含 authoritative PASS 清理）、normal release 與 stale recovery，每次 unlink／rename 後都要 fsync parent directory；mutex 只可 repair bounded-stale 且 provably-dead 的完整 owner record，其餘 fail closed。cross-head predecessor 五形見 `post-pr-marker-disposition.md` §Lifecycle durability。
   - head movement ordering：Step 5.5 / `/devpro:cross-review` MUST run after final base/mergeability sync. Do not create dispatch-bound `PASS|WARN` sticky for planned rebase/force-push/patch replay/non-fast-forward rewrite. After sticky, any head movement stales readiness until current-head dispatch/sticky binds `last_reviewed_sha == headRefOid`（whitelist-only bookkeeping diff 依 Path D′ 視同 fresh）; fast-forward/ancestor proof is traceability only, not marker-clear/merge readiness. A non-ancestor move may rebind or clear only an exact active marker／clear-obligation after the full per-lineage approval and fresh-evidence contract passes; that approval does not authorize Git graph operations or waive current-head review. `git rebase`、force-push、merge/graph recovery need explicit git strategy（Ask First/outside batch）. Without eligible approval, non-ancestor head remains lineage-broken stale evidence and the marker/obligation stays blocking.
   - **hotfix unit sticky（source／consumer）＋ review-binding**：審 `hotfix/*` PR 時適用（每 tip 一次 sticky、禁疊船、留 review-binding 留言）；見 `release-hotfix-carrier-policy.md`。
   - user-visible dispatch / user-visible result：先說「second reviewer 正在審核 PR #N」；回覆前列 `Cross-model review` verdict、sticky URL、`last_reviewed_sha`；不得只說「PR 已建立」或「已 dispatch」。
   - same-family fallback：CLI unavailable 時可 fallback，標 reason/provenance；strict/no fallback 才 `UNAVAILABLE` + human，blocked。
4. **Reviewer surface**：non-sandbox / host review packet；host-auth CLI 不得 sandbox 真跑，sandbox 只准 no-auth probes；不得加 sandbox-escalation wrapper；prefix/`prefix_rule`/allowlist ≠ host/outside evidence；sandbox auth failure 是 probe，不是 `UNAVAILABLE`；requires approval / permission_denials / error_max_turns = invocation/orchestration evidence；stdout/stderr/child-process + activity heartbeat / structured progress，stdout fallback；stdout silence→health probe。Denial 採 typed provider evidence first；adapter僅可對 exact provider/version complete-line registry fallback；ambiguous/unmatched/truncated=`unknown`。
5. **Requirement Ledger completion**：PR body/final handoff MUST report disposition counts；非 `implemented` rows 列 owner / issue / next step；`tasks.md all checked` 不足。
6. **Post-PR handoff**：依 `git-workflow-tracking.md` 4 bullets；Stop-Point Next Step Contract：PR create / merge 場景的具體格式；PR gate 完成不豁免 Next Step；complete/ready response 仍必須包含 handoff。`PASS|WARN`、skip/exempt 只是 gate progress，不是 terminal response，必須套用下方 Ready Response Next-Step Contract。若 handoff / blocked response 的 owner 是 user（cross-repo PR 停點、open PR not merged / awaiting merge-review、merge Ask First、或需 user decision），4 bullets / `Status:` labels 不足；回覆結尾 MUST 依 `stop-point-comms.md` 給 `要你做什麼（回數字）` 編號選項，末項開放；agent-facing hook text 不可替代 user-facing options。
7. **Session close gates**：Recap/issue/CI terminal handled/blocked；Recap 必含 Requirement Ledger Completion（無 ledger 寫 `N/A: <reason>`）。
> Load-chain：非 PASS 的 runner marker 分支、External marker disposition 完整條件與 cross-head predecessor 見 `post-pr-marker-disposition.md`。

### Blocked Response Next-Step Contract

Post-PR Blocked Response Next-Step Contract：blocked 回覆 MUST 明列：

- `Status:` blocked；不得寫 ready / complete / mergeable。
- `Blocker:` no fresh sticky / stale / `CRITICAL` / `UNAVAILABLE` / closed-terminal failure / allowlisted orchestration fault或evidence/receipt chain invalid / cross-repo PR（user-owned）。
- `Owner:` 預設 TL/reviewer；cross-repo PR（`pr_repository_mismatch`）時 owner=user。
- `Next step:` TL 跑 `/devpro:cross-review <PR#>`（或 host-equivalent adapter）；cross-repo 停點依 `stop-point-comms.md` 交使用者；external-evaluator marker 改依上方 External marker disposition 的 retain 分流（只有無 slot／accepted 缺收據才指向 accept helper）。
- `Unblock condition:` authoritative `PASS`（exactly one canonical sticky、current head、matching marker dispatch）；或 genuine current-dispatch `WARN` + exact completion receipt + `process_close_observed=true` + 無current fault + 完整舊 fault receipt/supersession chain；external-evaluator marker 改為 accepted external closure receipt exact-bound 當前 sticky body＋verdict∈PASS｜WARN（不要求 `process_close_observed`）。
- PR `## Test Evidence` 的 `DEV deploy-verify:` 為 `pending:` 時只能回本節 Blocked（`Blocker:` DEV `pending:`；`Owner:` user；`Next step:` 依 `stop-point-comms.md` 給選項：補好後部署並以 `gh pr edit` 更新證據行／逐 PR 豁免／其他；`Unblock condition:` DEV 驗證結果或使用者逐 PR 豁免），MUST NOT 發 Ready Response；判讀屬 `cooperative-only`，見 `pre-pr-dev-verification.md`。

Orchestration-fault回覆只可顯示 `second-review-control-evidence.md` 的去敏欄位與 capsule/integrity ID prefix；不得顯示 local evidence path或raw provider evidence。

禁止只回 blocked/PR URL/checks；停點須有 owner + next action + unblock condition。若 `Owner:` 是 user，回覆還 MUST 以 `stop-point-comms.md` 的三要素收尾並提供編號選項，例如 cross-repo PR（`pr_repository_mismatch`）時：`1.是，這張 PR 由你處理（或依 §Merge Gate Enforcement 走 waiver）`、`2.否，PR 維持 blocked`、`3.其他`。owner=TL/reviewer 時不問使用者，直接 dispatch `/devpro:cross-review <PR#>` 或 host-equivalent adapter。

### Ready Response Next-Step Contract

Post-PR ready response after workflow/cross-model gates MUST bridge to the next action; `PASS|WARN`、skip/exempt、PR URL、checks green、workflow `N/A`、或 sticky URL 都不是 terminal response。Matching `same-change-dp-change-batch` 覆蓋 `post_pr_completion_gate` 時，TL MUST NOT idle-stop 或重問那些 covered 步驟；MUST 直接發出本節 Ready Response（merge Ask First 仍在 `excludes: merge`）。PR 的 `DEV deploy-verify:` 為 `pending:` 時不發本節，改回上節 Blocked。Ready response MUST include:

- `Status:` ready / ready-with-warning；不得只寫 pass、skipped、exempt、complete。
- `Owner:` TL / reviewer / automation / user。
- `Next step:` 下一個具體動作，例如 merge authorization、PR merge、Recap、release gate、或等待 reviewer/human approval。
- `Success condition:` 何時算下一步完成，例如 merge gate green、PR merged、Recap written、workflow terminal。
- `CurrentIntent`：目前承接的 intent，例如 `post-pr-merge-gate`、`merge-authorization`、`recap-first`。
- `NextAction`：下一個 AI-actionable 或 user-owned action；若 owner=TL 且已授權，TL MUST continue，不得停在 `PASS|WARN` / skip/exempt。
- `AskFirstPending`：`true` / `false` + 原因；merge Ask First、user decision、或缺 external approval 時必須 `true`。

Owner=user＋merge Ask First 最終回覆**最小骨架**：`ChangeContext:` → `ManualTest:` → `CurrentIntent`／`NextAction`／`AskFirstPending` → 編號選項（選項是整則唯一的有序清單，其餘條列用 `-`；SSOT `stop-point-comms.md` 規則 2）；缺 `ChangeContext:` 或 `ManualTest:`＝Ready Response 違規（Critical／cooperative）。

若 `Owner:` 是 user（例如 merge Ask First、需要 approve/decision），回覆結尾 MUST 給 `stop-point-comms.md` 編號選項，數量匹配分岔且末項開放，例如 `1.是，授權 AI merge`、`2.否，先停`、`3.其他`。若 `Owner:` 是 TL/reviewer/automation 且 batch approval 或既有授權已覆蓋，回覆 MUST 繼續執行 `NextAction` 或等待可觀測終態；禁止只回 `PASS|WARN`、skip/exempt、PR URL、checks。

> Load-chain：當 `Status: ready-with-warning` 且需 merge 授權或使用者決策時，MUST 先讀 `post-pr-warn-repair.md` 的 WARN Decision Contract 並依其排序選項，上方通用範例不適用；archive 後 rule／code／test 載體修復的證據對齊亦見該檔。

**Post-archive 修復落點**：archive 後的 review 修復直接編輯 `openspec/changes/archive/<date>-<name>/` 的 `proposal.md`／`proposal-mini.md`／`tasks.md`／`decisions.md`／`qa-test-scope.md`（記帳類編輯），**不為此 re-archive**；不得延伸到 archived spec delta 的 body/scenario（仍走 `openspec-archive-redo-undo.md` pre-merge re-archive 程序）。

`ChangeContext`（SSOT）：`Owner:`＝user 且 merge Ask First、post-PR ready（`PASS|WARN`／skip／exempt）時 MUST 含 `ChangeContext:`。正文 MUST **白話**（禁 jargon dump）。完整形狀 MUST 先**改什麼**再**目的是什麼**；禁 file-first／檔案清單當標題；path MAY 短輔助。PR URL + current-head；殘留 WARN +1 risk；總 **最多 5**／≤5（WARN ≤4 landing +1 risk）。階梯：feature／bugfix **或** residual WARN → MUST 完整形狀；其餘 → SHOULD；mechanical chore／release／bump → MAY one-line（不強制雙段順序）。禁貼完整 PR body／長 diff／全文 sticky。缺 `ChangeContext:`＝Ready Response 違規（Critical／cooperative），**不是** Path F／`checkCrossModelMergeGate`／merge-gate 替代。`Owner≠user`不強制。

`ManualTest`（與 `ChangeContext` 同階、同觸發）：`Owner:`＝user 且 merge Ask First、post-PR ready 時 MUST 含 `ManualTest:`。需人工測試 → 怎麼測＋測什麼＋通過標準；不需 → 明確一行 `N/A: <reason>`。禁以完整測試計畫／長 QA 文件替代一行摘要。缺 `ManualTest:`＝Ready Response 違規（Critical／cooperative），**不是** Path F／merge-gate 替代。

### Host/Hook Boundary

Slash：`devpro:pre-pr` Step 5/5.5；Codex：本 leaf + `platform-adapters/codex-host-cross-review.md`；其他：本 leaf + adapter。Hook 不得自動呼叫 second reviewer；reviewer subprocess 帶 `DEVPRO_CROSS_MODEL_REVIEWER=1` 且不得清 marker。TL 不得宣告 ready/complete/merge。merge hard gate：`pre-tool-gate.mjs::checkCrossModelMergeGate`。

**ui smoke（MUST pointer）**：缺必要 `ui smoke:`／`ui smoke head:` 記錄時，不得把 sticky／ready 當完成；FAIL CLOSED 入口見 `code-review-cross-model.md` §UI smoke prerequisite；欄位 SSOT 見 `testing-and-qa.md`。

### Execution Location

Stop gate MUST 先以穩定 runtime/session ID 選定本 session 建立或明確接手的 PR，再驗 current-head sticky／receipt／lineage。相同 branch、worktree 或 repo 不是 ownership 證據。ID 缺失、無主 legacy marker、其他 session 的 marker 只留診斷，不自動提醒／阻擋，也不作 network probe 或清理。`exit 0` 不代表範圍外工作已驗證。

> Load-chain：Stop hook 的整輪時間預算、輸出格式（三行＋診斷檔）、owned PR 的 scope 細則、明確接手與退場入口見 `post-pr-stop-hook-runtime.md`。

### Non-Shell Write Surfaces

未來 runtime 非-shell GitHub write capability 不可替代本 gate；除非有 observable + fail-closed 等價 gate 可證 workflow/cross-model sticky/handoff 並阻止 completion。

## Exit Criteria

- Workflow terminal/N/A、Requirement Ledger completion、4 項 handoff、Session close gates 完成或 blocked。
- Cross-model exempt；或authoritative `PASS`（exactly one canonical sticky、current head、matching marker dispatch）；或genuine current-dispatch `WARN` + exact completion receipt/process close + 無current fault/closed-terminal failure + 完整receipt/supersession chain（以上為 runner marker）；external-evaluator marker 除 `clear_policy`（`MERGED` 或 cross-model exempt）外只憑 External marker disposition 的 `clear_verified`。Same-family fallback 已標 reason/provenance。
- `CRITICAL` / `UNAVAILABLE` 或其他closed-terminal failure只能回 blocked，不得宣告 ready；回報含 dispatch/result：`verdict`、sticky URL、`last_reviewed_sha`。
- **Path W pointer**：缺少 sticky／`UNAVAILABLE` 時，合規 current-head Path W waiver（使用者在對話說要豁免後才貼，AI 可代貼；`authorAssociation` OWNER|MEMBER|COLLABORATOR；`waived_head_sha` 恰 40-hex）可清 non-`external-evaluator` marker 並放行 merge Path B/U。**MUST NOT** 用 Path W 覆寫 Path E `CRITICAL`。stale waiver（sha ≠ head）→ 在對話重新問使用者（操作與 merge／post-PR 差異見 `post-pr-marker-disposition.md` §Path W／stale waiver 排錯）。SSOT：`code-review-cross-model.md` Path W／`second-review-waiver-authority.mjs`。

## Common Rationalizations

重複違反 → 六軸 Critical；completion gate 是交付契約。Non-shell write 不能取代 gate，除非 observable + fail-closed。

## Verification

Run post-pr + hook tests.

### Operator-disposed interrupted dispatch

既有 interrupted runner 可依 `second-review-operator-recovery.md` 的 operator disposition 契約成為 fresh full-review predecessor；它本身沒有 PASS、completion、close 或 marker-clear authority。即使晚到 sticky 是 current-head PASS/WARN，只要 exact dispatch 已 disposed，post-PR 與 merge 均須阻擋。正常 PASS 不新增本機 receipt 要求；WARN 的 current completion 與完整 lineage 義務不變。duplicate 與 CRITICAL 不因處分降級，原 marker 只由新的完整審查循正常 gate/CAS 推進。
