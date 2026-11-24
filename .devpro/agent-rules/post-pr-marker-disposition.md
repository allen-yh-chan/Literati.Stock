---
name: post-pr-marker-disposition
description: Post-PR completion marker 的處置細則：authoritative PASS 不成立時的 runner marker 分支（Fault／WARN receipt-chain／Closed-terminal／Fail-closed）、External marker disposition 的完整判定條件與 blocked 訊息分流、lifecycle durability、Path W stale waiver 排錯。觸發：post-PR gate 未得到 authoritative PASS、marker 為 external-evaluator、merge／post-PR 提示 stale waiver、或設計／審查 marker 清除邏輯時。
---

# Post-PR Marker Disposition

> Load-chain：本檔由 `post-pr-completion-gate.md` §Shared Gate 第 3 項 control evidence 按需載入，§Path W／stale waiver 排錯另由該檔 Exit Criteria 的 Path W pointer 與 `troubleshooting.md` 的 gh write-block 段載入；Authoritative PASS branch（第 1 支）、final blocker 與 External marker disposition 的三種結果摘要留在該檔。current-head authoritative PASS 成立且 marker 非 external-evaluator 時不必讀本檔（適用所有 marker clear 的 fsync／mutex repair 約束在入口的 lifecycle durability 條）。

### Runner marker 非 PASS 分支

接續 `post-pr-completion-gate.md` §Shared Gate control evidence 的第 1 支（Authoritative PASS branch）；編號沿用該處順序。

2. **Fault branch**：前述 authoritative PASS predicate 不成立時，兩個 allowlisted orchestration faults 即使同時有 accepted completion、`UNAVAILABLE`、`WARN` 或其他 fresh sticky仍 blocked。驗證 capsule後，exclusive建立或驗證固定 `blocked_orchestration_fault` receipt，並保留 marker。
3. **WARN / receipt-chain branch**：runner只有在process close已觀測，且current-dispatch sticky的`PASS|WARN` verdict、SHA、dispatch、positive REST ID與canonical same-repo/PR/ID URL exact匹配時，才可immutable建立current `devpro-second-review-completion/v2` receipt。Authoritative PASS不成立時，`WARN` 仍須無current fault；gate須驗receipt與marker/sticky exact binding，再為lineage舊faults逐一建立supersession receipts。Pre-upgrade `v1`只按原field set唯讀；runner不得新寫、升級或改寫。Claim或`WARN` sticky單獨不得清marker；完整chain驗證後才可清。
4. **Closed-terminal branch**：`CRITICAL`／`UNAVAILABLE`、provider rate/auth、confirmed timeout、spawn/probe failure、tool-surface fault、output overflow或terminal contract/CLI failure，只能由runner以`devpro-second-review-closed-terminal/v1`表達「invocation已可靠關閉但review未成功」。Pre-spawn terminal或post-close且transport/process-group cleanup確認完成才可發布；termination-unconfirmed、claim-only、leader-only close或cleanup不明都維持blocked且不得成為closed predecessor。Runner在post-close但cleanup未確認時自己就死掉而卡住的dispatch，若要取得closed-terminal，**唯一**補救是明確人工觸發的runner-owned post-hoc transport對帳（runner `--reconcile-closed-transport <observability-context>`）：只吃一個具名carrier context、不列舉任何evidence/carrier root、前置條件全fail closed且任一不過零寫入，`ESRCH`與sticky權威交叉驗證合取成立才以`lifecycle_phase=post_close_transport_reconciled`經同一receipt writer發布同形receipt；不得由hook／gate／renderer／merge gate／排程觸達，也不得手工偽造或修補terminal evidence。此對帳的cleanup合取需要可即讀的PR sticky權威面，故只適用帶該面的dispatch；`audit-only`等無sticky權威者若卡在同一lifecycle即永久blocked，屬已揭露殘留缺口，不得改走其他修補路徑。Gate驗證receipt後保留marker並回blocked，不得改寫成PASS/WARN。
5. **Fail-closed branch**：Missing/corrupt/tampered/binding mismatch、duplicate receipt或多種terminal evidence並存一律 fail closed；legacy sticky只限完全沒有 new-format dispatch record。

### External marker disposition

- **External marker disposition**（`marker.executor_kind === "external-evaluator"`；cost/disclosure blocker 評估後、MERGED self-heal 前分流，恰回一個）：`clear_policy`（`MERGED` 或 cross-model exempt）｜`clear_verified`（`readDispatchEvidenceStrict` 得 slot `accepted`＋external completion receipt，且 snapshot 當前 PR head＝record `head_ref_oid`＝receipt `sticky_last_reviewed_sha`＝當前 sticky `last_reviewed_sha` 四者相等、body sha256 相符、verdict∈PASS｜WARN、footer 相符）｜`retain`（其餘：無收據、voided、`external_closure_incomplete`、digest 漂移、head 不一致、CRITICAL／UNAVAILABLE、無 sticky body）。owned Stop 的 external marker 同樣經此 resolver，不落原 runner verifier 的 `process_close_observed` 要求。Blocked 訊息依狀態分流：無 slot／accepted 缺收據 → 指令 `node .devpro/scripts/accept-external-second-review.mjs <packet-dir>`；已驗收但不符（含 head 不一致）、CRITICAL／UNAVAILABLE、voided → 指示重新發行審查單（不指向 accept）；不可讀 → reason code 回報 TL。

### Lifecycle durability

- lifecycle durability：cross-head只接受gate-consumed fault、runner-owned verified success、closed-terminal（runner-owned，或`second-review-control-evidence.md` §2 所列 operator slot／lifecycle slot衍生的pre-spawn recovery terminal）、external accepted completion（slot `accepted`）或external voided terminal（slot `voided`）五種互斥closed predecessor（external兩形免invocation claim）；另可依`second-review-operator-recovery.md`接受獨立operator-disposed interrupted predecessor，保留close/cleanup/scan false且只准fresh full-pr review，不能當closed或PASS。invocation claim單獨存在仍是in-flight。Publication/marker/capacity mutex只可repair bounded-stale且provably-dead的完整owner record；live、malformed或ambiguous owner fail closed。Normal release、stale recovery與marker clear每次unlink／rename後都要fsync parent directory。

### Path W／stale waiver 排錯

**Path W / stale post-PR**：若 merge／post-PR 提示 stale waiver，head 已移動 → 在對話重新問使用者是否豁免；使用者說要豁免後，刪舊 comment、以 OWNER|MEMBER|COLLABORATOR 帳號（AI 代貼時用使用者自己的 `gh` 登入）重貼合規 `<!-- devpro-cross-model-waiver -->`（第一行）+ 當前 40-hex `waived_head_sha`。CRITICAL sticky 存在時 Path W **不能**解除；先修 CRITICAL 並重跑 `/devpro:cross-review`。使用者還沒在對話說要豁免時，AI 不得貼 waiver。**Merge vs post-PR（stale UNAVAILABLE）**：merge gate 對 stale sticky 先走 Path D（sha ≠ head）block，通常到不了 Path U／W；post-PR `hasFreshWaiver` 可用本地 ungated sticky verdict，對 **stale UNAVAILABLE**（非 CRITICAL）仍可清 non-external marker——兩者不一致屬已知契約，勿假設 merge 與 post-PR 對 stale UNAVAILABLE 行為相同。**已合併 PR**：已啟動 dispatch 的 dispatch-bound marker 同樣先判 Path W，再驗 dispatch 證據；條件與未合併時相同，不清 `lineage_clear_obligation`，dispatch review authority fence 擋下時保留 marker；清除後一併清 review-round sidecar。細節見 `code-review-cross-model.md` Path W／`post-pr-completion-gate.md` Exit Criteria Path W pointer。
