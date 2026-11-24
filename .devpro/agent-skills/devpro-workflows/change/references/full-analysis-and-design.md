# Full-rigor Analysis and Design Steps (devpro:change)

Cold detail: the full-rigor-only parts of `devpro:change`. Section 1 holds 第四步 Pre-analyst Clarification, 第五步 `dp-analyst`, 第六步 `dp-architect` (with the dp-architect dispatch schema, the Design.md Second-Review Gate and its round state) and the analyst／architect fallback. Section 2 holds Architect → proposal.md 同步驗證, Redirect Entry / Runtime Load Parity Checkpoint, the full `tasks.md` ledger, Design Cold Read and the Step 5 前置 delegation plan. Load this file only when the active rigor level is `full`; lite does not run these steps. Each section ends with where to return in `SKILL.md`. Section names this file mentions but does not contain (第零步, 第一步～第三步, 第七步, the Lite section, Formalize auto-promote) are in `SKILL.md`, and 上方／下方 references to them resolve there.

## 第四步～第六步

**第四步：Pre-analyst Clarification（MUST invoke `/devpro:clarify`）**

> **適用範圍**：本 checkpoint 只對需要呼 dp-analyst 的路徑生效——判斷表判為 **B（full）** 的 chore / feature / bugfix / hotfix。A / B-mini 跳過 dp-analyst（per `chore-classification.md`），本步驟自動 N/A；N/A 只指 clarification rounds，五欄白話卡已在第零步（或第三步前）確認。

Consumer repo 若需求呈現 long-running program 形狀，TL 在呼叫 dp-analyst 前 MUST 執行 `program-tracker-mode.md`「Issue-first Program Tracking」（由 `openspec-flow-consumer.md` 按需載入）：搜尋 `label:type:program label:program:active` issue；命中時讀 parent issue / sub-issues；找不到但符合 program-shaped 條件時先問使用者是否 bootstrap Program Issue。此 gate 是 GitHub / third-party live tracker，不以 `openspec/specs/<capability>/spec.md` 作為 program tracker。

TL **MUST load** `.devpro/agent-skills/devpro-workflows/clarify/SKILL.md` 並執行 **mode `pre-analyst`**（change-name＝本 named change）。**禁止**在本檔另寫第二套 clarification 步驟正文；**禁止**以「只跑 `check-clarification-gates`／其他等價 gate 證據」繞過 `/devpro:clarify` skill invoke。

政策 pointer（細節經 `devpro:clarify` Overview，本檔不複寫）：`ambiguity-scoring.md`／`proposal-template.md`／`openspec-quality-and-formats.md`／`stop-point-comms.md`（規則 5 選項呈現契約）。`check-clarification-gates.mjs` `seams-expansion` → `pre-analyst` 於 `/devpro:clarify` `pre-analyst` 內執行（非繞過 skill 的等價放行）。

若來源為 pending formalize，第四步前 MUST 已完成上方 Formalize auto-promote；否則 `devpro:clarify` `pre-analyst` 應 fail closed 回推。

**Soft gate**（dp-reviewer 抽檢，非 hook-enforced）：若 dp-analyst 仍回 `status: questions`，TL 必須在 commit message 或對應 task 旁註記「為何此題沒在 batch 裡先問」（例：使用者首次需求未含此線索／規則模糊點 architect 設計階段才浮現）。未註記由 dp-reviewer 軸 1 root-cause adequacy backstop。

**第五步：呼叫 `dp-analyst`（SA）執行 pre-flight 與需求分析**：

呼叫前 MUST 已完成第四步（經 `/devpro:clarify` `pre-analyst`，且其內 `check-clarification-gates.mjs pre-analyst` exit 0）。失敗 → 禁 Agent／Task 呼叫 `dp-analyst`，依 ambiguity-scoring／stop-point／`devpro:clarify` 補齊後重跑。

呼叫前先檢查第零步是否已包含 bounded subagent launch authorization。若 active runtime 需要 explicit subagent trigger 且第零步未取得該授權，TL MUST 進 `SubagentAuthPending` 問一次並停等；授權後才呼叫 `dp-analyst`，拒絕或授權後工具不可用才走 fallback。

```
Agent({
  subagent_type: "dp-analyst",
  description: "Pre-flight analysis for /devpro:change",
  prompt: "objective: context-isolation\nresponsibility_id: brd\ninstance_mode: fresh\nevidence_scope: <openspec/changes/<change>/meeting-notes.md ＋ 需求引用的 repo 路徑>\nreturn_and_stop: <brd.md ＋ status JSON；寫入後停>\nrole: dp-analyst\n使用者需求：<原始的 name/request 參數或使用者描述>\n\nrouting_context:\n  - AGENTS.md §0（動手前十句自檢已載入）\n  - 觸發式載入索引第 N 行對應的 leaf 檔（由主 agent 依 intent 命中後填入）\n\n請讀 openspec-flow.md（routing_context 已含 AGENTS.md A+C，不重讀），執行 pre-flight checklist 與開場引用規則，回傳分析結果與待確認項。"
})
```

收到 analyst 回報：
- **status: failed / questions** → 主 agent 向使用者確認／補齊資料後，重呼 analyst（或直接在主 agent 補完）
- **status: finished** → 進入第六步

**第六步：呼叫 `dp-architect`（SD）設計 proposal 草稿**（開始前確認已依第二步後的「OpenSpec Artifact Authoring Skill 為 Mandatory Load」條款載入 authoring skill，並如下範本把該義務帶入 `routing_context`）：

呼叫前沿用第零步 / 第五步的 bounded subagent launch authorization evidence；若仍缺且 active runtime 需要 explicit trigger，先進 `SubagentAuthPending` 問一次並停等，不得以缺授權為由 TL fallback。

```
Agent({
  subagent_type: "dp-architect",
  description: "Proposal design for /devpro:change",
  prompt: "objective: independent-judgment\nresponsibility_id: proposal-design\ninstance_mode: fresh\nevidence_scope: <openspec/changes/<change>/brd.md ＋ Touch 候選路徑>\nreturn_and_stop: <proposal.md／design.md ＋ status JSON；寫入後停>\nrole: dp-architect\n使用者需求：<原始描述>\n\nAnalyst 分析結果：<analyst 回傳的 JSON>\n\nrouting_context:\n  - AGENTS.md §0（動手前十句自檢已載入）\n  - MUST load `openspec-artifact-authoring` skill（撰寫 proposal/tasks/spec delta 前必須載入，承載 archive-gate 格式前饋 recipe）\n  - 觸發式載入索引第 N 行對應的 leaf 檔（由主 agent 依 intent 命中後填入）\n\ndelegation_contract:\n  claimed_artifact_paths:\n    - openspec/changes/<change>/proposal.md\n    - openspec/changes/<change>/design.md\n  first_artifact_deadline: 30m_total\n  writer_lease: single\n  completion_mode: callback\n  completion_channel: runtime completion callback/event\n\n請設計 proposal 草稿（target state、touch list、Task Outline handoff）。Full change 的 `proposal.md` Section 3 只可放 non-executable pointer／scope summary，MUST NOT contain task checkboxes；Task Outline handoff 交 TL / dp-assistant 寫入唯一 executable ledger `tasks.md`。第一個 internally valid proposal.md 或 design.md 即滿足 first-artifact checkpoint，另一檔仍由同一 writer lease 續作。"
})
```

**dp-architect dispatch schema**：`claimed_artifact_paths` MUST contain exact `openspec/changes/<change>/proposal.md` and `openspec/changes/<change>/design.md` with `first_artifact_deadline: 30m_total`, `writer_lease: single`, `completion_mode: callback`, and `completion_channel: runtime completion callback/event`。

- dp-architect accepted dispatch starts `30m_total` and MUST NOT reset or extend for activity, heartbeat, status, poll, message, or focused rebrief; it is neither an idle timeout nor a total task timeout.
- `artifact_landing_deadline_missed` requires an actual state callback and exactly one focused rebrief to the same writer; it MUST NOT authorize a second writer, takeover, or TL fallback.
- A dp-architect takeover requires authorization from explicit user replacement or independently sufficient terminal/interruption evidence; the takeover MUST then revoke the original writer lease; after revocation it MUST confirm the original writer inactive; only then, and never before, may it create the ownership-transfer record. Missing or reordered steps MUST FAIL CLOSED.
- An independent design reviewer MAY coexist only with explicit no-write/no-claim and MUST NOT acquire a writer lease or write authority.
Writer-lease `independent design reviewer` is not `independent of the design author`.

收到 architect 回報：
- **`status: failed` + 有效 `dissent`**（`kind` + 非空 `reasons`）→ MUST 停，把 dissent 交回使用者。MUST NOT 把 proposal 當 finished 設計。MUST NOT fallback 自寫 proposal。MUST NOT 進入「proposal 草稿完整」／「Architect → proposal.md 同步驗證」成功路徑。
- **`status: failed` 無有效 `dissent`**（裸／缺欄／空 `reasons`）→ MUST 停並回報契約錯誤（payload 缺失）。MUST NOT 發明 reasons。MUST NOT 宣稱 Need disagreement。MUST NOT 把 `dissent.reasons` 交回使用者。MUST NOT 當 finished／questions／fallback。
- **`status: questions`**（缺輸入／待確認項）→ 主 agent 向使用者確認後，重呼 architect 或直接補完
- **`status: finished`**（proposal 草稿完整）→ 以該草稿為基礎，進入後續 change 命名／step 1

**Design.md Second-Review Gate（when-present）**：若 architect 完成後 active change 內存在 `openspec/changes/<change>/design.md`，TL 在建立或 finalizing 唯一 executable task ledger（full=`tasks.md`；B-mini=`proposal-mini.md` inline Tasks）或開始實作前，MUST 先完成一次 `dp-second-reviewer` `audit-only` 審查 that is independent of the design author。TL 先做 proposal/design/touch/target-state consistency sanity check，再以 bounded handoff inputs dispatch；handoff 至少包含 `proposal.md`、`design.md`、affected spec delta paths / touch list、target state、known validation evidence。Round 1 `review_material`／`scope_summary`／`changed_files_or_touch_list` MUST 涵蓋該 mandatory handoff 集，作者縮掉不得算過閘。`approval_context: none`、`write_back: none`、`sticky_write_disposition: N/A`；不得寫 PR sticky，不滿足 PR merge gate，也不得在後續 PR 報告中當作 Step 5.5 cross-review completion。
第一次 persist `design.md` MUST 同寫 `openspec/changes/<change>/decisions.md` sibling H2 `## Design-Author Identity`（identity、provenance、recorded_at）；later sessions MUST NOT backfill from git `Author:` / `Co-authored-by`。
**`## Design-Author Identity` 機械格式（fail closed）**：section MUST 恰好 **3** 行非空 bullet（多一行人類說明即失敗）：`- identity:`、`- provenance:`、`- recorded_at:`，順序固定。`provenance` 閉集：`trusted-session-metadata` | `family-alias` | `unknown`。`recorded_at` MUST 為 UTC `Z` 結尾 instant（例如 `2026-08-28T02:22:00Z`）；`+08:00` 等 offset 形式拒絕。解析／比對 SSOT：`.devpro/scripts/lib/design-review-independence-identity.mjs`（`parseDesignAuthorIdentity`）。`dp-architect` 首次 persist `design.md` 時 MUST 同寫此 section；TL 在 architect `status: finished` 後 MUST 驗證 `decisions.md` 已含合法 section，缺失或 malformed 時 MUST NOT 進入 design audit dispatch。
**Cursor design-gate default（design-only；非 pr-sticky cross-model credit）**：active adapter 為 Cursor 且無 trusted-session primary evidence 時，第一次 persist 的 `## Design-Author Identity` MUST 使用 `identity: unknown`、`provenance: unknown`（host-unproven；**禁止**假貼 `claude`＋`family-alias`）；design audit-only handoff 使用 `primary_family: unknown`、預設 `reviewer_family: codex`（或 ledger／env 預選）。helper 回 `host_primary_unproven`＝執行獨立，**禁止**標 `same-family fallback`、**禁止**宣稱 family diversity；**不得**套用到 post-PR `pr-sticky` 以宣稱 cross-model diversity；pr-sticky 在 primary 未證明時 MUST 用 `primary_family: unknown` + sticky `cross-model-unverified`。MUST NOT 使用 `cursor-composer`；TL MUST NOT 因 identity 未知在 dispatch 當下停下要求 manual remap；devpro:change 開頭條件式預選（change ledger `second_reviewer_family`）為 sanctioned 前饋，不在禁止之列。**Hosts／sessions 已有 trusted-session primary evidence 時 MUST NOT** 自降 Design-Author 為 `unknown`/`unknown` 以略過 same-family 記帳；host-unproven 路徑僅限無 trusted-session primary evidence。
Parse the design-author identity from that `decisions.md` via `parseDesignAuthorIdentity`; the comparable key for both parties is the canonical family token; each dispatched reviewer's identity MUST NOT equal that design-author identity **unless** the conditional same-family fallback below applies.

**Conditional same-family fallback（design gate only；非 cross-model diversity）**：僅當 design-author 已是可比較 canonical family token 且與 reviewer 同 family 時適用。當 different-family reviewer **客觀不可用**（例如 CLI 額度耗盡、auth 未登入、probe `flags_supported` 失敗、`projection_runner_unavailable`、未安裝／未授權）且 TL 已嘗試或記錄該不可用證據後，TL MAY 改派 same-family reviewer，但 MUST 在呼叫 `evaluateDesignReviewIndependence` 時傳入 `differentFamilyUnavailable: { reason: "<non-empty objective cause>" }`（reason UTF-8 ≥ 10 bytes）。**第二授權道（user-preselected at devpro:change start）**：TL 只在 active change ledger 有 `second_reviewer_family` 且其值 == dispatched reviewer family **且** author 非 host-unproven（非 `unknown`/`unknown`）時，才可把該值傳為 `userPreselectedReviewerFamily`（canonical family token）；helper 回傳 `{ ok: true, same_family_fallback: true, fallback_reason: "same-family fallback: user-preselected: <family>" }`。host-unproven author + 預選／預設 canonical CLI → helper `host_primary_unproven`，**禁止**標 `same-family fallback`。兩道互不互認：user-preselected 不得偽裝成客觀不可用，反之亦然；不得事後補傳改判已 dispatch 的 round。helper 回傳 `{ ok: true, same_family_fallback: true, fallback_reason }` 時，TL MUST：(1) 在該 round 的 audit findings ledger／Round State 記錄 `same-family fallback` 分類與 `fallback_reason`；(2) 要求 reviewer `audit-only` completion／findings 明示 same-family provenance；(3) **MUST NOT** 宣稱 cross-model diversity 或將此輪當作 PR Step 5.5 cross-review completion。無 `differentFamilyUnavailable` 證據且無 matching `userPreselectedReviewerFamily` 的 same-family dispatch 仍 `identity equality` fail closed。

**Explicit waiver（最後手段）**：若 different-family 不可用且使用者拒絕 same-family fallback，或 cap／UNAVAILABLE 後仍無法取得 audit 終態，TL MUST 停下並取得使用者 explicit waiver，寫入 `decisions.md` sibling H2 `## Design Review Waiver`，恰好四行：`- classification: user-authorized-waiver`、`- authorized_at: <UTC Z instant>`、`- reason: <non-empty>`、`- scope: design-second-review-gate-bypass`。waiver 不得冒充 audit PASS；後續 PR cross-review 要求不變。

TL MUST 使用既有 `devpro:second-review` projection/control plane，不得手寫 final reviewer prompt 取代：以 structured handoff JSON 對 `--carrier-root <main-checkout-root>/notes/cross-review` 執行 `.devpro/scripts/render-second-review-packet.mjs <handoff-json> --carrier-root <dir>`（renderer 自行在該 root 下配置 fresh `<attempt_id>/` carrier directory，TL 不自行命名或建立該目錄），再跑 `.devpro/scripts/validate-second-review-packet.mjs <packet-file>`，通過後才可 dispatch `dp-second-reviewer`。handoff MUST 傳入 renderer-generated `packet_path`、`observability_context_path`、`heartbeat_path`、`activity_log_path`、`stdout_log_path`、`stderr_log_path`、`cli_probe_result_path`、`projection_bootstrap_command`、`projection_runner_command`、`tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn`、以及 `reviewer_cli_recipe.required_invocation_args`；缺 renderer sidecar、缺 handoff path、缺 `projection_runner_command`、或 runner command/path mismatch MUST 先分類為 `projection_observability_contract_missing`，不得啟動 reviewer CLI 或等 timeout。`audit-only` terminal audit evidence MUST 依序包含 `projection_cli_exited` → `projection_sticky_verification_skipped`；多、少或重排皆 fail closed。

**Round state 與 findings ledger 的 durable 落點**：design-gate 的 audit-only 迴圈以 `openspec/changes/<change>/decisions.md` 的 `## Audit Findings Ledger` 段為 round 計數與 findings 的唯一 durable 真源——此段落即本規則所稱 `audit findings ledger`（其餘 target 無 change 目錄時改用 caller 選定之等價 carrier，例如 `session-pending`，schema 不變）。該段落 MUST 以**每個 dispatch 為一列**記錄 Round State：`round`（1-based）、`dispatch_id`、`head_ref_oid`、`reserved_at`、`outcome`（`pending` / `pass` / `warn` / `critical` / `unavailable`）；round 1 之外任一 round MUST 恰有一列，round 1 MAY 恰有兩列（見下段）。

**Dispatch 前置序列（reserve-before-dispatch）**：TL 每次要 dispatch 前，MUST 先讀上述 Round State：不存在 → 本次是 round 1；最新 round 全部列 `outcome` 皆非 `pending`、且該 round 已完成下段「completion transition」→ 新 round = 該 round 之 `round + 1`；新 round 大於 `audit round cap 6` → MUST NOT dispatch，直接停下交回使用者裁決，不得續跑、不得略過。決定 dispatch 後，MUST 先以 `.devpro/scripts/lib/design-review-independence-identity.mjs` 對該 change `decisions.md` 呼叫 `parseDesignAuthorIdentity` 得到 `authorRecord`，再依下列**單一優先序** resolve 本次 handoff `reviewer_family`（design gate audit-only 與 post-PR pr-sticky 兩 dispatch 共用；無欄位 → 既有 chain，零行為變更）：① 非空 `$CROSS_MODEL_REVIEWER` env 最高 → ② active proposal / proposal-mini ledger `second_reviewer_family` 次之 → ③ 兩者皆無 → 既有 deterministic chain 兜底（Cursor host-unproven：Design-Author unknown／unknown＋handoff `primary_family: unknown`＋預設 reviewer codex，或 resolved primary 的 different-family chain）。resolve 後 MUST 呼叫 renderer（`render-second-review-packet.mjs`）取得該次 dispatch 唯一分配來源的 `dispatch_id`（renderer 於 render 當下以 `randomUUID()` 配發，TL 不可預先指定），render+validate 通過後，再呼叫 `evaluateDesignReviewIndependence({ authorRecord, reviewerFamilyFromValidatedPacket, differentFamilyUnavailable, userPreselectedReviewerFamily })`（`reviewerFamilyFromValidatedPacket`＝validator-accepted `reviewer_family`；`differentFamilyUnavailable` 僅在 documented objective unavailability 時傳入；`userPreselectedReviewerFamily` 僅在 active change ledger 有 `second_reviewer_family` 且其值 == dispatched reviewer family 時傳入，不得事後補傳改判已 dispatch 的 round）；fail closed → MUST NOT reserve、MUST NOT spawn。通過後才 MUST 立刻把本輪 `round` / `dispatch_id` / `head_ref_oid` / `reserved_at` / `outcome: pending` 以**單一 commit**寫入 Round State；commit 完成才可呼叫 reviewer CLI dispatch——這個 commit 本身即「消耗」該輪次，不因後續 session 中斷、context compaction 或 host reset 而復原。

**round 1 平行雙 dispatch 的原子 joint-reservation（R4，optional）**：round 1 MAY 平行派 2 個 reviewer 取聯集建立基準 ledger。若 TL 決定使用平行雙 reviewer，MUST：先各自 render 兩份 packet 並各自 validate 通過，取得兩個 `dispatch_id`，並對每個已接受 packet 跑 helper 比較（全部 `{ ok: true }` 才可 joint-reservation）；**在任一 CLI 呼叫之前**，把兩列（`round: 1`、各自 `dispatch_id` / `head_ref_oid` / `reserved_at`、`outcome: pending`）**於同一次 commit**寫入 Round State；該 commit 落地後才可依任意順序（含並行）呼叫兩個 CLI dispatch。TL MUST NOT 先 commit 一列、dispatch、再補第二列——那會使第二個 reviewer 在「任一列 pending 即停」規則下永遠無法被 reserve。

**completion transition（五步原子 commit）**：一個 round（單列或兩列）的 member 列，在其對應 dispatch 拿到 evidence-gate 驗證過的終態判定（非 `pending`、非僅 liveness/checkpoint 訊號）後，`outcome` MUST NOT 立刻覆寫——MUST 維持 `pending`，直到單一次 commit 內原子完成下列全部步驟，才可在**同一 commit**把該 round 全部 member 列的 `outcome` 一併改為終態值：(1) 確認該 round 全部 member 皆已拿到 evidence-gate 驗證過的終態（或已被使用者裁決標記 `unavailable`，見下段）；(2) 若為兩列，取兩個 reviewer 回傳原始 findings 之**聯集**；若為單列，取該 dispatch 的原始 findings；(3) 與該 round 開始前的凍結快照比較，判定新增/已閉合；(4) TL 對每筆新增或重新開啟的 finding 完成 disposition；(5) 把 (3)(4) 結果 merge 回該 ledger 的 Findings 表。這五步與「把 member 列 `outcome` 改為終態值」MUST 同屬一次 commit；commit 落地前，即使個別 dispatch 已回報明確終態，該 round 對「是否可以 reserve 下一輪」而言仍視為 unresolved，MUST NOT reserve 下一輪，MUST NOT 只憑另一個已終態的 member 片面判定整個 round 的結果，也 MUST NOT 繞過此 completion transition commit 另行寫入終態值。

**unavailable member 併入 completion transition**：若 round 任一 member 最終仍卡在 `pending`（未拿到終態證據），套用下段「reserved 但未解決 MUST 停止」規則交使用者裁決；使用者若裁決人工標記該 member `outcome: unavailable`，MUST 透過同一個五步 completion transition commit 執行，不得另立第二個能把 `outcome` 移出 `pending` 的機制：步驟 (1) 判定標準放寬為「每個 member 皆已拿到終態判定，或已被裁決標記 `unavailable`」；步驟 (2) 取聯集時，被標記 `unavailable` 的 member 對聯集的貢獻定義為**空集合**（不因此整輪判定聯集不可得），其餘已終態 member 的 findings 照常參與聯集與 merge；步驟 (3)(4)(5) 對僅存的已終態 member findings 照常執行——已驗證的真實 findings MUST NOT 因不相關 member 失敗而被連帶丟棄。該 commit 落地後此 round 視為已完成 completion transition，cap 已在 reserve 當下消耗，不授予同一 round 內的額外重試機會。

**reserved 但未解決 MUST 停止，不得續跑**：若 TL 讀到最新 round 任一 member 列 `outcome` 仍是 `pending`，或該 round 尚未完成 completion transition（即使全部 member 的 dispatch 本身皆已終態），MUST NOT 當成可續跑的同一輪重新 dispatch（含補 reserve round 1 平行對子的第二個 member），也 MUST NOT 略過直接 reserve 下一輪。正確路徑：停下並回報使用者，由使用者決定（a）人工標記 `outcome: unavailable` 並依上段完成 completion transition，該輪視為已消耗；「用剩餘輪次重試」指依常規規則（**含下方 R2 停止判準**）reserve 下一個 round（`round + 1`，仍受 round cap 限制），不是重開或延續這一輪——該 completion transition commit 落地後，若 R2 停止判準（`Critical = 0` 且相對 ledger 無新增 finding）已成立，(a) 的結果是停止再派下一輪，而非取得額外重試機會；或（b）直接進入既有 CRITICAL / UNAVAILABLE fail-closed 路徑。

**跨 session 不重置**：round 狀態的唯一真源是 Round State 的內容，MUST NOT 因 TL context compaction、新 session、host session-limit reset 或 subagent 重啟而重新從 round 1 起算。

**後續輪窄掃與 open Critical 強制重驗**：第一輪（含平行雙 dispatch 的選項）建立基準該 ledger；後續輪 TL 只驗 ledger 未閉合項、只掃改動 carrier：`review_material` / `scope_summary` / `changed_files_or_touch_list` 限定為本輪 ledger 未閉合項所在及本輪自上一次 dispatch `head_ref_oid` 起改動的 carrier，MUST NOT 對全 surface 重新審查。但任何 ledger 內 `status: open` 的 Critical 條目，無論其 carrier 是否在本輪改動集合內，MUST 在本輪 review_material 中明確列出並要求 reviewer 逐項確認是否已閉合，不得因窄掃範圍而 silent-drop，更不得因此從本輪 Critical 計數中消失。TL 為寫入 disposition、更新 `outcome`、標記條目 `closed` 而對承載該 ledger 的 carrier（如 `decisions.md` 該 section）所做的記帳編輯，本身 MUST NOT 被計入下一輪「改動 carrier」判定所依據的 diff 集合，否則每次 disposition 寫入都會讓該 carrier 遞迴變成下一輪的改動 carrier。

**是否再派下一輪的判準（R2；與 executor verdict 語意分離）**：executor `PASS` / `WARN` / `CRITICAL` 判定標準維持既有語意不變；TL 是否再派下一輪由下列獨立判準決定——本輪 dispatch 完成後，若 `Critical = 0`（即該 ledger 內無任何 `status: open` 的 Critical 條目，不只是本輪新掃出的 surface 裡沒有 Critical）且相對 ledger 無新增 finding，MUST 停止再派下一輪；此處 Important 不強制清零——Important 未清零不阻擋停止，仍依下方 WARN 逐項 disposition（RK-1）義務處理。
- `verdict: PASS` → 可繼續 task ledger / delegation plan。
- `verdict: WARN` → TL 必須在 tasks / proposal / design / decisions / session-pending 中逐項 disposition finding（accept/reject/defer + owner/next step）後才可實作。
- `verdict: CRITICAL` 或 `UNAVAILABLE` / missing terminal audit evidence → fail closed；先修正設計，再依上述 reserve-before-dispatch 規則 reserve 下一個 round 並重跑 audit-only（受 round cap 限制；cap 用盡時 MUST NOT 再重跑，直接停下交回使用者裁決），或取得 explicit human design review / user-authorized waiver 並寫入 `decisions.md`，才可繼續。

若 `design.md` 不存在，TL MUST 在 durable carrier（`tasks.md`、`proposal-mini.md`、`decisions.md`、或 delegation plan）記錄 `design second-review: N/A - no design.md` 並繼續；本 when-present gate 不得被解讀為要求 B-mini／chore A 產生 `design.md`。full change MUST 已持久化 `design.md`，因此本 gate 會跑 audit-only。

若 `dp-analyst` 或 `dp-architect` subagent 不可用（fallback），主 agent 自行**依 `.devpro/agent-rules/openspec-flow.md` 的「`devpro:change` Pre-flight Checklist」逐項確認 checklist 與開場規則**，並自行設計 proposal 草稿；任一項不符停下問使用者，通過後才進入後續 change 命名／step 1。

> 第六步完成後，回 `SKILL.md` 從「接著根據參數決定 change 名稱」繼續。

## proposal 同步～委派計畫

**Architect → proposal.md 同步驗證**：寫完 `proposal.md` 後，確認 Touch 清單和 Target State 與 dp-architect 回傳的 `touch` / `target_state` 一致。不一致時以 architect 為準修正 proposal（architect 是設計來源，proposal 是持久化載體）。此驗證確保 `/devpro:pre-pr` 第三步傳給 dp-reviewer 的 `touch_list` / `done_when` 與設計階段一致。

**Redirect Entry / Runtime Load Parity Checkpoint**：proposal / proposal-mini touch list 若含 redirect entry file（`CLAUDE.md` / `GEMINI.md` / `.windsurfrules` / `.github/copilot-instructions.md`）或 runtime 載入/分發機制（如 `sync-agent-rules.mjs` 的 `STATIC_FILES` / `SYNC_DIRS`、`.claude/settings.json`、`.cursor/hooks.json`、`.codex/hooks.json`），TL / dp-architect 在 finalizing proposal 前 **MUST** 先讀 `rule-design-principles.md` 守則 1 + `.devpro/scripts/tests/multi-runtime-parity.test.mjs`。proposal / proposal-mini 必須標註 `Parity invariant impact: 保持 / 放寬 / 收緊` + rationale；若改動 parity invariant，須同步更新 `multi-runtime-parity.test.mjs` 註解或斷言以區分 load-bearing invariant 與 convenience proxy。

依「tasks.md 品質要求」由 TL / dp-assistant 將 architect 的 Task Outline handoff 建立為 full change 唯一 executable task ledger，並依「驗證證據」確認完成；不得把 task checkbox 複製回 `proposal.md`。

**Design Cold Read（有 `design.md` 時必做；第一個實作寫入前）**：規範 SSOT 是 `design-reasoning.md` §Design Cold Read and Implementation Handoff；Gate CR 在紀錄放行前擋實作寫入。設計審查收斂、`tasks.md` 建好後依序：

1. 派 fresh 唯讀讀者。材料只列最終 artifact，不給對話背景、ledger、審查重點、作者結論或白話卡：

```text
Agent({
  subagent_type: "dp-explorer",
  description: "Design cold read",
  prompt: "objective: independent-judgment\nresponsibility_id: design-cold-read\ninstance_mode: fresh\nevidence_scope: openspec/changes/<change>/ 有的 brd.md、proposal.md 或 proposal-mini.md（B-mini 的任務在內）、design.md、tasks.md、specs/\nreturn_and_stop: 回報冷讀結果後停\nrole: dp-explorer\n你沒有這個 change 的任何背景。只讀上列檔案，用不熟程式的人也看得懂的白話，自己從檔案內容寫出（不是去找現成的卡）：使用者故事、現在、引擎、做成後你會看到、不該被整包丟掉的、要使用者決定的事與代價、讀不懂或矛盾的地方。寫不出來的欄位要明說。不要用 file:line 摘要格式，不要提修正建議。"
})
```

2. 用檔案工具寫 `openspec/changes/<change>/comprehension.md`：第一行 `status: pending`，下方放讀者原文。
3. 逐欄對照使用者確認過的白話卡（full＋B 在 meeting-notes `decisions:`，其餘在 session-pending 的 card capsule）。不一致或寫不出的欄位記為 finding，寫下處置：改 artifact、問使用者，或說明讀者為何讀錯。找不到卡時在第 4 步明說，由使用者直接看讀者原文。
4. 停下交給使用者確認，batch approval 不涵蓋此停點。照 `stop-point-comms.md` 寫三要素：為什麼停（設計還沒經使用者確認，確認前不能開始實作）、要你做什麼、回了會怎樣。呈現讀者原文（含兩個沒有對應卡欄的項目：要使用者決定的事與代價、讀不懂或矛盾的地方）、對照結果與處置，選項是 `1. 確認 2. 要改（說改哪裡） 3. 其他`，使用者在對話回答即可，不用自己跑指令。回了會怎樣要寫明：選 1 後 AI 跑 `node .devpro/scripts/confirm-design-cold-read.mjs <change> --user-answer "<使用者原話>"`、讀回第一行再繼續，選 2 修 artifact 後重跑冷讀，選 3 依使用者回覆處理。讀者原文裡的編號清單改成項目符號，整則只留這組編號。
5. 使用者回答確認後，AI 跑上面那行，`--user-answer` 原樣帶入使用者的回答，讀回第一行是 `status: user-confirmed`、下兩行是 `user-answer:` 與本 change 的 `change:` 才繼續。使用者還沒回答前不得跑；Gate CR 只認第一行恰為放行狀態、帶一行 `user-answer:` 且 `change:` 是本 change 的紀錄。放行後不再改這個檔。使用者要改就修 artifact，回第 1 步重跑。

Gate CR 回報放行狀態缺 `user-answer:`，或紀錄是舊版帶 `proof=` 的簽章格式時：在對話向使用者說明紀錄內容（改過就說改了什麼）並問一句是否確認，使用者回答後 AI 依原話重跑同一行，紀錄已有讀者原文與對照就不用重做冷讀。內容實質改變或紀錄沒有讀者原文時，把第一行改回 `status: pending`，從第 1 步重跑。Gate CR 回報 `change:` 不是本 change（從別的 change 複製來的紀錄）時，不要重跑確認指令：把第一行改回 `status: pending`，從第 1 步為本 change 重跑冷讀。

讀者不可得，或本規則上線前已開工時，寫 `comprehension.md`（第一行 `status: pending`，下方寫「冷讀未驗證」與原因），再照 `stop-point-comms.md` 停下：為什麼停寫原因與確認前不能開始實作，再說明繼續代表接受沒有獨立讀者驗證的設計、既有 gate 照舊。選項是 `1. 繼續 2. 先等讀者 3. 其他`。回了會怎樣要寫明：選 1 後 AI 跑同一行加 `--unverified`、`--user-answer` 帶入使用者原話，讀回第一行再繼續，選 2 就維持 pending，讀者可用時從第 1 步重跑，選 3 依使用者回覆處理。讀回第一行是 `status: user-accepted-unverified`、下兩行是 `user-answer:` 與本 change 的 `change:` 才繼續。冷讀不佔審查輪數；scope change re-entry 時把第一行改回 `status: pending` 再從第 1 步重跑，Gate CR 會在重跑完成前擋實作寫入。

**Step 5 前置：委派計畫（Mandatory Checkpoint）**

tasks.md 建好且設計冷讀放行後、開始實作前，TL **必須**產出委派計畫並輸出給使用者看：

| Task | 委派給 | 理由 |
|---|---|---|
| （逐 task 列出） | dp-programmer / dp-assistant / TL 自己做 | 判斷依據 |

**Matching `same-change-dp-change-batch`**：委派計畫為 **FYI＋當輪續跑**（owner=AI；不適用於上方冷讀停點）；**MUST NOT** 再以編號選項重問 executor／要不要派 `dp-programmer`／`dp-assistant`（第零步已授權 bounded subagent launch）。「輸出給使用者看」≠ Ask First pause。無 matching ledger 時仍可為 user-owned pause。

判斷規則：
- 涉及寫新邏輯（函式、測試、規則段落）→ `dp-programmer`
- 機械操作（rename、bulk edit、spec 檔案寫入、git 序列）→ `dp-assistant`
- **TL 自己做的條件**：僅限單步小修改（1 檔 1 次 edit、<10 行）且無需設計判斷

**Hard Gate**：若 tasks.md 有 ≥2 個 task 涉及檔案修改，委派計畫中 `dp-programmer` 或 `dp-assistant` **至少出現一次**。全部填「TL 自己做」必須附明確理由（如 subagent 不可用）。跳過此 checkpoint 直接 Edit/Write = Red Flag 違規。

**Execution Tracking**：TL 開始第一個 task 前，回顧委派計畫。每個標記為 dp-programmer/dp-assistant 的 task，TL 必須實際委派執行。若因故需 TL 自行做（如 subagent 失敗），必須在 task 旁註記理由（如 `[TL override: subagent unavailable]`）。未註記理由的自行執行視為 Red Flag 違規。

> 委派計畫完成後，回 `SKILL.md` 第七步。
