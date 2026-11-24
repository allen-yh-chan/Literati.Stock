---
name: openspec-quality-and-formats
description: OpenSpec 文件格式與 tasks 品質合一規格；觸發：dp-analyst 撰寫 brd 前 / dp-architect 寫 task outline 前 / TL 撰寫 meeting-notes / decisions 觸發點發生時 / TL 勾 task 前驗收 / 實作中或 PR merge 前 requirement scope change 時。
---

# OpenSpec 品質與格式

## Overview

本檔為文件格式規格（Doc Formats）與 tasks 品質要求（Tasks Quality）合一規格，覆蓋：

- **(a) Doc Formats**：OpenSpec change folder 三類核心文件（meeting-notes.md / brd.md / decisions.md）的存放路徑、必含欄位、寫入時機與合法例外
- **(b) Tasks Quality**：每個 task 必須可驗收（做什麼 + 可觀測的完成證據）；實作中或 PR merge 前 requirement scope change 須走 re-entry 流程

本檔為 `openspec-flow.md` 文件格式與任務品質概要段的子能力外部化；**模糊 task = 無效 task，不得勾選。**

## When to Use

觸發本檔的時機：

1. **TL 建 change 目錄後**：立即寫入 meeting-notes.md（dp-analyst 執行 pre-flight 前必須先讀取）
2. **dp-analyst 完成 pre-flight 後**：立即寫入 brd.md（dp-architect 設計 proposal 前必須先讀取）
3. **decisions 觸發點發生時**：`proposal-design` / `make-vs-buy` / `scope-change` / `reviewer-rejection` / `user-override` 任一發生，TL 新增 decisions.md entry（cross-model round 本身非此五項 trigger；pr-sticky lane 每輪仍須依 `code-review-cross-model.md` §Round Budget 另記一列 compact round-ledger row，形狀與 `## D<N>` entry 不同、非互斥矛盾，見 canonical `openspec-flow.md` Scenario: Cross-Model Review Round Is Not A Decisions Trigger）
4. **dp-architect 撰寫 task outline 時**
5. **TL 驗收 task、勾選前**
6. **實作中或 PR merge 前 requirement scope change 時**（新增/刪除 target behavior、acceptance criteria、gate semantics、workflow state transitions、merge/release obligations）

## Process

> Load-chain：doc 格式細則（meeting-notes / brd / decisions / Requirement Ledger lifecycle）按需載入 `openspec-quality-doc-formats.md`；Diagram / Archive-Time Task Split 進階規範按需載入 `openspec-quality-advanced-patterns.md`；Scope Change 流程按需載入 `openspec-scope-change.md`；本 entry leaf 保留 Tasks 品質 / Spec Delta / Rule-feedback Matrix 三節（熱路徑，重複載入成本低）。

### Synthesis mode

合成 `brd.md`／`proposal.md`：**只轉錄已決**（禁腦補／合成期再面試）；缺決策標 `UNRESOLVED:` 並停。Seams → `proposal-template.md`。

### Mandatory Clause Enforcement Map

Principle 6 對本 leaf 的強制語氣採下列 carrier；新增/改 mandatory clause 時須同步更新本表或標 `cooperative-only`。

| Mandatory clause group | Enforcement carrier |
|---|---|
| archive 產物 format-when-present（proposal heading／brd 欄位／design.md heading） | `pre-pr-archive-gate.mjs` check (c)／(j)／(q) + `pre-pr-archive-gate*.test.mjs`、`dp-architect-template-alignment.test.mjs`（鎖 design.md heading 四載體一致）。三者皆**只在該檔存在時**驗格式、**都不驗存在**；chore A 無 brd／design 直接 skip |
| meeting-notes 存在與寫入時機 | `cooperative-only`：無 hook/gate 驗其存在（`pre-tool-gate.mjs` Gate P 只掃其 PII 內容，見下列）。理由：chore A 依本檔 §Exit Criteria 第 1 點合法免此檔，presence gate 須先推斷 chore 類型而 archive gate 無此依據，硬加會誤擋合法 chore A |
| OpenSpec doc PII / example sanitization | `pre-tool-gate.mjs` Gate P + `hook-pre-tool-gate-meeting-notes-pii.test.mjs`、`strengthen-openspec-flow-rules-grep.test.mjs` |
| tasks checked before archive | `openspec archive` incomplete-task warning + `pre-pr-archive-gate.mjs`; semantic acceptance quality is cooperative-only reviewer/process enforcement |
| tasks 證據行表徵（收據名／可重跑載體） | `pre-archive-task-checkbox-grep.test.mjs` describe `T3 R3 evidence-line-representation anchor guard`（鎖條文字面、§證據時序 pointer、`devpro:pre-pr` freeze 子檢查位置與 SSOT pointer）；「某行是否會漂移」屬語意判斷，`cooperative-only`：由 `devpro:pre-pr` Final-tree freeze 具名子檢查＋reviewer 承擔 |
| single executable task ledger | `lint-proposal-tasks-checked.mjs` + `pre-pr-archive-gate.mjs` check (o) + `pre-archive-task-checkbox-grep.test.mjs`; full=`tasks.md`, B-mini=`proposal-mini.md` inline Tasks |
| spec delta heading mode / promotion / scenario preservation | `lint-delta-requirement-mode.mjs` + `lint-delta-requirement-mode.test.mjs`、`lint-modified-scenario-preservation.mjs` + `lint-modified-scenario-preservation.test.mjs`、`pre-pr-archive-gate-scenario-diff.test.mjs`、`openspec validate --strict --all` |
| spec implementation carrier | `agent-reference-digest-grep.test.mjs` anchors for this correction; semantic carrier adequacy is reviewer / cross-model cooperative evidence |
| Rule-feedback Surface Matrix | `rule-feedback-openspec-routing-grep.test.mjs`; omitted surfaces require explicit `N/A: <reason>` in proposal evidence |
| Requirement scope change 入口指標與 proposal 初列 carrier groups | `scope-change-reentry-grep.test.mjs`、`change-governance-guardrails-grep.test.mjs`（鎖入口字面與 `openspec-scope-change.md` 內容）；是否實際重進流程 `cooperative-only` |
| archive-before / archive-after task split | `pre-pr-archive-gate.mjs` active-folder block + `archive-timing-cross-doc.test.mjs`; post-archive GitHub actions remain cooperative-only handoff evidence |
| Requirement Ledger lifecycle | `pre-pr-archive-gate.mjs` check (m) + `pre-pr-archive-gate.test.mjs`; PR body / Recap lint cover completion-report headings; semantic completeness vs raw user wording is reviewer/process evidence |
| Cross-carrier assertion synchronization | `cross-carrier-assertion-sync-grep.test.mjs`（鎖 §Writing Spec Deltas 前饋 anchor + `code-review-cross-carrier.md` 正文（review／remediation 兩側觸發）+ `ai-autonomy.md` §0 第10條 pointer + `code-review-checklist.md` Load-chain + canonical scenario 存在）; `cooperative-only`：斷言全副本語意一致無零誤判機械 anchor，機械兜底僅鎖 anchor 字串存在 + cross-model review |
| Trigger decidability（brd 成功標準 outcome 判準 / operator-usage probe 第四維度 / When to Use 非循環觸發條件） | `strengthen-clarify-operator-usage-grep.test.mjs`（A2：`ambiguity-scoring.md` SSOT + `clarify/SKILL.md` 中文字面，`openspec-flow` canonical/delta 對應英文字面；`proposal-template.md` 現況 pointer-only 不需此字面）+ `rule-anatomy.test.mjs` §trigger decidability content anchors（A1／A3 字面）；`cooperative-only`：「是不是 outcome 判準／是不是循環」屬語意判斷，機械兜底僅鎖條文字面，實質執行靠 `code-review-checklist.md` §2「When to Use Trigger Decidability sub-check」+ cross-model review |

### Section 2: Tasks Quality

交接的重要介面、資料／invariant owner、依賴、失敗情境與驗收方式，依 `design-reasoning.md` §Design Cold Read and Implementation Handoff 先明確；局部可逆寫法保留 implementer 決定。lite 沿既有 handoff，不新增必填文件。

### Tasks.md 品質要求

每個 task **必須**包含：**做什麼**（一句話）+ **驗收條件**（怎樣算完成）。

- 驗收條件須為**可觀測的證據**：測試通過、檔案存在、API 回傳正確值、畫面顯示正確等；**勾選前自問：資深工程師會核准驗收已滿足？**（rationale：`preflight-checklist.md` §Target state 先定 done-when）
- 未滿足驗收條件則**禁止**勾選
- **唯一 ledger + 執行迴路（checkbox = 執行狀態，非事後裝飾）**：每個 change 的 **canonical task-ledger artifact 只能有一個**：full change=`tasks.md`（`proposal.md` 的 canonical Tasks 與 explicit `## Deferred` 等 task-bearing section 只能放 non-executable pointer／scope／defer rationale，MUST NOT 放 top-level task checkbox；Deferred 不授權第二份 ledger）；B-mini=`proposal-mini.md` 的 inline `## Tasks`（MUST NOT 另建 sibling `tasks.md`）。AI **必須**把該唯一清單當**逐條執行迴路**跑——**逐條認領**一個 task →做→**當下回勾**，**禁止**記憶驅動、事後一次補勾。每個 `[x]` **必須綁可驗證證據**（commit sha／test 名／`file:line`／grep assertion）寫在該 task 的驗收行；空打勾等同未完成。**建議**接 harness task 追蹤（`TaskCreate`／`TaskUpdate`）作外部化執行迴路輔助，但**回勾對象是 canonical ledger 本身**的 `- [ ]` → `- [x]`（archive-gate lint 機械讀的就是這個檔）——只更新 harness task 未回寫 canonical ledger 等同未回勾。此為 `multi-agent-handoff.md` §Finding Verification「記憶敘述當 hypothesis、不當已驗證事實」原則在自身執行狀態上的延伸。
- **canonical Tasks heading**：canonical task-ledger 段落 **MUST** 對齊 `lint-proposal-tasks-checked.mjs` `CANONICAL_TASKS_HEADING_RE` 完整合法形狀：三前綴 `## Tasks`／`## Section N: Tasks`／`## N. Tasks`，之後可選**一個**半形 `(…)` 或全形 `（…）` 附註（例 `## Tasks（3）`、`## 3. Tasks (2)`）；heading noun boundary 見 `openspec-flow/spec.md`「Requirement: Proposal Tasks Heading Canonical Boundary」。否則 lint 與 archive gate check (o) 讀不到，仍有 checkbox 會 `noncanonical-heading-with-checkbox` hard-fail。
- **證據 MUST 能被事後獨立覆核（上一條「可驗證證據」的通用判準）**：把證據行交給**沒有本次 session 記憶的人**，他要能只靠這行重跑一次並得到同一答案。**錨點**面——行號**在同一個 change 內就會腐爛**（同批編輯的任一插入／刪除都位移它），故 `file:line` 只能當**當下定位提示**，**MUST NOT** 單獨作為證據錨點；每條驗收證據 MUST 錨在改完仍能被重新算出來的載體：symbol／函式名、段落標題、task ID、test 名、或 grep assertion 的字面。同理適用**派生值**：散文寫死的計數（「共 N 處」「五個檔案」）與覆蓋面宣稱下一次編輯即過期且無人會重算，MUST 改指向能重算它的機械集合（測試檔內的常數清單、lint 輸出）或可重跑的判準。**時序**面（守門跑在非最終內容或未 commit 狀態上）見 `openspec-quality-advanced-patterns.md` §證據時序。
- **證據行表徵（收據名／可重跑載體）**：`tasks.md`（含 B-mini `proposal-mini.md` inline Tasks）的證據行中，量測值類證據（suite 結果、計數、當前 HEAD 等）MUST 以收據名／穩定欄位表徵，或引可重跑命令／test 名／grep 字面，例如 `notes/qa-regression-head-<change>.json` 的 `suite_evidence.status`／`fail`（currency 由收據自身維護、由既有 regression-head currency gate 斷言）；**MUST NOT 內嵌**會隨本 change 後續 commit 漂移的量測值——canonical scenario 計數、suite pass／fail 計數、tip／HEAD SHA，或「其後僅 markdown 變更」這類後續 commit 內容宣稱；**不可變歷史 commit 引用（例如 RED commit SHA、`--base <sha>` 參數）不在此限**——禁令只涵蓋「隨本 change 後續 commit 漂移」的量測值。本條補充（不取代）上一條可重算錨點要求：symbol／段落標題／task ID 等錨點仍合法，不可變歷史 commit 引用可作補充證據。本條為證據行表徵規則的 SSOT；其他載體（capability spec、`openspec-quality-advanced-patterns.md` §證據時序）僅得放 pointer，不得複寫。
- 每個 implementation task **必須** trace 回 Requirement Ledger exact ID（例：`[Req: R1]`）。多 ID 可重複 exact tag（`[Req: R1] [Req: R2]`）或用逗號列 exact ID（`[Req: R1, R2]`）；range shorthand（如 `[Req: R1-R7]`）不是 ledger ID，會被 archive gate (m) 擋下。無法對應任何 ledger row → 先更新 ledger 或停下問使用者。每個 `implemented` / `partial` row 必須有至少一個 task/evidence 覆蓋；`deferred` / `rejected` / `moved-to-issue` 可無 implementation task，但必須有 owner/next step。
- **bugfix 強制項**：tasks.md（或 B-mini 的 `proposal-mini.md` inline `## Tasks`）**必須**包含至少一個 prove-it test task（撰寫能重現 bug 的 failing test），且排序先於修復 task
- 轉換不出可觀測目標時，AI **必須**停下問使用者，不得猜想就開工

**模糊動詞 → 可驗收目標對照**：

| 模糊動詞 | 可驗收目標 |
|---|---|
| 「加 validation」 | 列出 invalid input 類型 → 每種寫 test（先 fail）→ 實作使 test pass → 全綠 |
| 「修 bug」 | 寫能重現 bug 的 test（先 fail，prove-it）→ 修 → 同 test pass → 無回歸 |
| 「Refactor X」 | refactor 前相關 test 全綠（基準線）→ refactor → 同組 test 仍全綠 |
| 「優化效能」 | 指定 benchmark 指標（例 p95 < 100ms）→ 前後量測對比達標 |
| 「改善 error handling」 | 列出錯誤情境 → 每種寫 test → 實作使 test pass |
| 「清理 dead code」 | 列出要刪的 symbol → 刪除 → `dotnet build` 無 warning、測試全綠 |

### Requirement Scope Change（含 PR merge 前與 post-merge continuation）

requirement scope change 指新增、移除、或實質改變 target behavior、acceptance criteria、gate semantics、workflow state transitions、merge/release obligations；不論 PR 前後、是否同一 named change、是否使用者已選定方案並要求實作皆適用。發生時 MUST 先讀 `openspec-scope-change.md` 並走完重進流程（`decisions.md` `scope-change` entry、`dp-analyst -> dp-architect`、更新 proposal／tasks／spec delta）；滿足該檔 OpenSpec-before-code hard gate 之前 MUST NOT 寫入或擴充 implementation carrier。

**micro-tweak 基準**（TL 直接改）：1-2 個 acceptance condition 文字澄清、或新增一個 auxiliary file，且不改 target behavior、gate semantics、workflow state transitions、merge/release obligations。

> Load-chain：Material Semantic Carrier Group Scope Stop-Loss 在 `openspec-scope-change.md`。每份 proposal MUST 初列 material semantic carrier groups + rationale（分組與計數規則見該檔 Anti-gaming）；初列 >10 → 第一次 rule／code write 前具名批准或拆分。會觸及已批准集合外的第 11 個 group、已批准 design 後第二次 substantive redesign、或越出已批准 scope 的新 boundary 時 MUST 先讀該檔並於 write 前停下。

### Requirement Count Ratchet（需求數棘輪）

Carrier group stop-loss 管的是**觸及面**；本節管的是**需求條數**。兩者互補，皆不取代上方 scope-change gates。

**契約**：change 的 `## Requirement Ledger` 若存在，其唯一正式 ID/Disposition 表格之 ID 欄相異 recognized ID 計數 **MUST NOT** 超過 `decisions.md` 中唯一 `## Requirement Baseline Ledger` 表格最後一列的 `baseline_to`；且在有傳 `--base`、快照可由本辨識器讀取且落在所查 Git 範圍內時，納入鏈式驗證序列的已 commit 列 **MUST** append-only——抬 baseline 只能追加列，**MUST NOT** 就地改動或刪除既有列。機械閘 `lint-requirement-count-ratchet.mjs`（`devpro:pre-pr` Step 3.6 ＋ `validate-openspec-change.mjs`）在 archive 前攔下；append-only 那一半需傳 `--base <change-base-ref>` 才會對 Git 驗證，未傳時結果明示 `priorState: not-requested`（沒驗，不冒充已驗）。此保證以手寫辨識器與所查 Git 範圍能對齊檔案為界；它防誠實失誤，不保證阻止存心規避。

**Schema（唯一合法清除路徑）**：

```
## Requirement Baseline Ledger

| decision_id | trigger | baseline_from | baseline_to |
|---|---|---|---|
| D1 | initial | 0 | 5 |
| D7 | scope-change | 5 | 9 |
```

- `trigger` 為封閉二值：首列 **MUST** `initial` 且 `baseline_from` **MUST** 為 0；其餘列 **MUST** `scope-change`。
- 每列 `baseline_from` **MUST** 等於前一列 `baseline_to`（鏈式）。
- `decision_id` **MUST** 唯一，且 **MUST** 對應同檔真實存在的編號 decision heading——防「只加一個數字就抬 baseline 而不寫決策」。
- baseline **可降**（瘦身）；閘只擋成長。

**MUST NOT**：以散文提及 `scope-change` 字樣作為清除依據。閘**只認結構化列**，不做任何自由文字搜尋——已實證的假陽性是敘述句中的 `**觸發點**：… scope-change …`，若被當成清除依據會使閘失效。

> Load-chain：閘的辨識與實作邊界（no-op 邊界、inert-only ledger、不可解析列、惰性 markdown 中立化、id 形狀與載體順序 SSOT、共用邊界、grandfathering、保證上限）見 `requirement-count-ratchet-internals.md`；閘回報非預期結果、或修改／審查 `lint-requirement-count-ratchet.mjs` 及其共用 lib 時 MUST 先讀。正式 Ledger 選擇由 `lib/requirement-ledger.mjs` 共用給棘輪、archive 與 pre-archive coverage；只保留一份 live Ledger 及 ID/Disposition 表格，修正具名 ambiguity 後重跑原 lint。作者須知：`## Requirement Ledger` 只出現在圍籬／HTML comment 內（inert-only），或列缺結尾 `|`，閘都會 fail closed，不是 no-op。

### Writing Spec Deltas

- **顆粒度**：delta 只有 requirement 級（`## ADDED/MODIFIED/REMOVED/RENAMED Requirements` + `### Requirement: <name>`）；沒有「只 ADD 一個 scenario 到既有 requirement」。加/改既有 scenario = `## MODIFIED Requirements` 整個 requirement。all-REMOVED／retire → `openspec-archive-principles.md` Capability retirement recipe（禁複寫完整雙列 triage 表）。
- **THEN/AND clause-final citation**：THEN/AND bullet 內的 `` `leaf.md` §heading `` citation MUST 放在子句句尾（其後只允許收尾標點）。這是 `cross-ref-spec-thenclause-grep.test.mjs` 的 `LEAF_SECTION_RE` 能過的必要條件：citation 後接英文會被貪婪 heading capture 誤判。Guard 對不存在的 leaf filename fail-closed，sanity floor 跟 live corpus hit count 而不是 `>= 1`。
- **ADDED/MODIFIED canonical title precheck（前饋）**：寫入每個 delta requirement 前，MUST 先比對 canonical `openspec/specs/<capability>/spec.md` 的 `### Requirement:` title set，再選 heading：title 已存在 → `## MODIFIED Requirements`；title 不存在 → `## ADDED Requirements`；capability canonical spec 不存在 → 只能 `ADDED` 新 requirement。把 scenario 加到既有 requirement 仍是 `MODIFIED`，不是 `ADDED`；`ADDED` 同名已存在或 `MODIFIED` 同名不存在都代表 authoring 形狀錯。archive 前 MUST 跑 `node .devpro/scripts/lint-delta-requirement-mode.mjs openspec/changes/<name>`，讓錯誤在 `openspec archive` 前 fail。
- **REMOVED 區塊必須逐字複製 canonical（前饋）**：`## REMOVED Requirements` 底下的 requirement，body MUST 與 canonical 同名 requirement 逐字相同（標題之後到下一個 `##`／`###` 標題，含全部 scenario；非 Reason／Migration 摘要）；`lint-delta-requirement-mode.mjs` 在 archive 前（含 `--pre-review`）檢查，`seal-final` 在 archive 後以精確相等比對。
- **Spec Implementation Carrier**：OpenSpec `spec.md` 不是 implementation。任何改變 agent / runtime / review / gate / workflow 行為的 `ADDED` 或 `MODIFIED` requirement，必須在同一 PR 落至少一個 implementation carrier：rule leaf、agent skill、hook/gate/script、test、scenario、adapter，或明確標 `cooperative-only` 並寫出承載理由。spec-only requirement 視為無效；archive / PR 前逐條對照 carrier，缺 carrier 就停下實作、移除，或延後到有 carrier 的 change。
- **`MODIFIED` 全替換（高危）／Dual Author Shapes**：delta 同名 requirement raw block 會整段取代 canonical promoted spec；漏列 scenario 會靜默刪除。範例：`openspec/changes/archive/2026-06-02-fix-postmerge-marker-state/specs/pre-tool-mechanical-gates/spec.md`。作者對既有 Requirement 加／改 scenario 時，只認兩種合法形狀——(1) **Restate**：`## MODIFIED Requirements` 重述所有仍保留的 canonical scenarios（可另加新 scenario）；未保留者列 `## Removed Scenarios`。(2) **Additive contiguous-insert**：同一 `## MODIFIED` 區塊內，保留 canonical 每個 contiguous segment（main + 既有 scenarios）原序逐行相等，並插入完整新 `#### Scenario:` segment。**禁止** new-scenario-only MODIFIED（只貼新 scenario、省略未宣告移除的 siblings；#1968／#1971）。**寫入前自問（前饋，非事後兜底）**：寫每個 `## MODIFIED Requirements` block 的**當下**，MUST 先自問「我走的是 restate 還是 additive contiguous-insert？restate 是否複製了**全部**既有 scenario？沒保留的是否列入 `## Removed Scenarios`？有沒有只貼新 scenario？」——把 archive gate (i) / `lint-modified-scenario-preservation` 的事後攔截提前到寫入當下，別靠事後 gate 才發現靜默刪（evidence：PR #1462 gate (i) 攔靜默刪；#1968 full proposal 曾跳過 wrapper lint）。**`## Removed Scenarios` 位置（#2658）**：MUST 落在 `proposal.md`／`proposal-mini.md`／`tasks.md`／`decisions.md` 四檔之一；MUST NOT 只寫／留在 active delta `specs/**/spec.md`（delta 出現 standalone heading → lint fail，即使四檔也有）。**機械守門**：archive／validate 前跑 `node .devpro/scripts/lint-modified-scenario-preservation.mjs openspec/changes/<name>`；per-change 驗證用 `node .devpro/scripts/validate-openspec-change.mjs <name> --strict`（full／B-mini **一律**於 `openspec validate` exit 0 後跑 preservation lint——**禁止**裸 `openspec validate` 當保全證據）。寫 `## MODIFIED Requirements` 前 MUST 先讀 `openspec-spec-delta-pitfalls.md`（`lint-delta-body-canonical-wrap` 的 contiguous-block 比對實務）。
- **強制 check**：任何改 `openspec/specs/**/spec.md` 或 archive promotion 後，對每個受影響 spec 跑 `git diff main --stat -- <spec>` + `grep -c "#### Scenario:" <spec>`。行數/scenario 數須符合預期；非預期大量刪除、scenario 數驟降、或大幅負行數（evidence：新增 1 scenario 卻 `-97` 行 / 13 scenarios 被刪）→ 停下，先還原 promoted spec，再補完整 requirement block。
- **No-delta / skip_specs（OpenSpec ≥1.9.0）**：`Change must have at least one delta. No deltas found` = **ERROR**（非 warn）；零 `specs/` delta 時合法 opt-out = change-folder `.openspec.yaml` 的 `skip_specs: true`（通常搭配 `schema: spec-driven`）+ proposal 明記無 capability-spec impact / cite-only 理由。**允許 skip_specs** 的典型：cite-only bugfix（canonical 已 cover）、doc/test-only chore、hygiene archive、implementation-only 且 canonical 已 promote。**禁止**為過 gate 發明 delta。**MAY-only catch-22** 路徑 (a) 亦走 `skip_specs`。archive / `validate-openspec-change.mjs --strict` 前 MUST 評估 cite-only → `skip_specs` vs 補 delta；不得 wave-through 舊 warn 心智模型。
- **條件性陷阱（Load-chain）**：canonical 既有 MAY-only scenario 要進 `MODIFIED`、把既有 single-mode／single-scope requirement 抽象成 multi-mode、或以 static grep guard 斷言已 promoted 的 delta 文字時，MUST 先讀 `openspec-spec-delta-pitfalls.md`。
- **值級一致性**：spec delta 引用具體值（env 值／旗標／常數／檔名）時，寫入前 MUST grep 實作確認與 code 一致，禁憑記憶發明值（cooperative-only：同一語義多種合法字面、跨檔比對需語義判斷，無零誤判 anchor；機械兜底 = cross-model review，evidence：PR #1063 兩輪 env `true|false` drift；與 `openspec-spec-delta-pitfalls.md` 的 grep guard no-op 陷阱 bullet 同精神）。
- **跨 carrier 語意斷言同步（前饋）**：改動一個**跨 carrier 語意斷言**（fail-open／fail-closed 方向、契約、常數值、polarity——即意義在 code + spec delta + canonical + narrative（brd/proposal/meeting-notes/tasks）多處被重述的斷言）時，寫入當下 MUST 先 `grep` 該斷言的**所有自然語言變體（中英、正反向）**遍歷上述全部 carrier，逐一對齊或明列「此處不動」的理由——禁止逐輪只改被點名那一處。同步面包含 proposal/proposal-mini `## Requirement Ledger` 的 `Current Requirement` 欄、由 requirement 派生的 tables/threshold/counts、QA/test-scope/PR/comment closeout prose；宣稱「已記錄/already recorded」前 MUST grep 目標 carrier；重寫 PR body / sticky / issue comment / Recap 等留言前 MUST 對 final commit state 重讀；派生數字 MUST 以 script/command 從 merge-base→HEAD 重算並附 evidence；同一 canonical spec 內描述同一機制的 requirement MUST 對齊 precision level（例如 path containment 同時需要 lexical + realpath + bidirectional 時，不得另一處只寫 resolves-inside）。既有結構閘（spec↔canonical scenario diff `gate (h)/(i)`、`lint-delta-body-canonical-wrap` body 字元）只驗**結構**，**不驗 narrative prose ↔ code 的語意一致**；同一機制的兩處 narrative 自相矛盾（如一處寫 over-remind、另一處寫 under-remind）須由本 grep 抓出，非靠 review 運氣。cooperative-only（同一斷言多種合法字面、跨檔語意判斷無零誤判 anchor；機械兜底 = grep guard 鎖 anchor 存在 + cross-model review）。evidence：PR #1462 fail-open 方向斷言散落 ≥6 carrier、被 cross-review 抓四輪（逐輪只改被點名處）。review／remediation 側窮盡律見 `code-review-cross-carrier.md`（entry `code-review-checklist.md` Load-chain pointer）。
- **scenario 涵蓋面宣告（前饋，cooperative-only）**：寫每個 `## ADDED`／`## MODIFIED` requirement 的 scenario 時，除 happy path 外，該 requirement **明顯的主要 error／邊界／negative 路徑**要嘛各寫成一個 `#### Scenario:`，要嘛在 proposal（B-mini 走 proposal-mini）明列「刻意不涵蓋 `<路徑>`＋理由」。動機：upstream `openspec validate --strict` 只強制每 requirement ≥1 scenario、**不驗涵蓋面**，單一 happy-path scenario 即可過閘，使 canonical spec（AI 事後復刻系統的唯一長期依據）對 error/邊界行為 under-specify。本條只要求「**涵蓋或明講省略**」、**不要求窮舉**（哪些算「主要」是作者語意判斷，無零誤判機械 anchor，故 cooperative-only、無 hook gate，同上「寫入前自問」精神）；review 側「有無無聲省略」抽驗見 `code-review-checklist.md` 軸 1 §Scenario Omission Disclosure sub-check。

- **High-risk material negatives（SSOT；加嚴上方涵蓋面宣告）**：
  1. **閉集 high-risk taxonomy**：change 觸及下列任一即為高風險——(a) 授權／權限邊界；(b) 狀態機／不變量；(c) 耐久寫入／原子性；(d) 對外披露（含把 repo／PR 內容送 external reviewer、對外網路披露敏感面）。**禁止**只用未定義的「感覺高風險」當觸發。
  2. **強制 `risk_classes` 紀錄（leading YAML front matter）**：每個 in-scope OpenSpec change（**Chore A 豁免**：無 `proposal.md` 且無 `proposal-mini.md` → 整份 change PASS，不讀 `brd.md`／`meeting-notes.md`）在 eligible carrier（`proposal.md`／`proposal-mini.md`／`brd.md`／`meeting-notes.md`）**MUST** 以檔案開頭的 **leading YAML front matter** 留下 `risk_classes: [<a-d 子集>]` **或** `risk_classes: none`＋同區塊 `rationale:`。缺分類、未閉合 FM、duplicate key、非法 nested、未知 token、空 `[]`、placeholder、或 `none` 卻無 substantive rationale → 不合規。正文／fence／`<pre>`／HTML comment 範例 **MUST NOT** 使閘門 PASS。多檔皆宣告時：固定優先序 `proposal.md` → `proposal-mini.md` → `brd.md` → `meeting-notes.md` 選 canonical owner，其餘必須 normalize-equal，否則 `multi-owner-conflict`。
  3. 當 `risk_classes` **非 none**：MUST 對所列每一類覆蓋或明示省略——未授權拒絕｜非法狀態／不變量｜寫入失敗／原子性｜對外披露不該發生（與 taxonomy a–d 對齊）。
  4. **`Non-goals` 不得逃脫**：`## Non-goals`／Decision Boundaries **MUST NOT** 作為上述 material negatives 的逃脫載體；亦 **MUST NOT** 用 Non-goals 把本屬 a–d 的 change 改口成 `risk_classes: none`。
  4b. **Deferred sibling live carrier（#2492）**：scope-split 留下的 deferred sibling（Non-goals／Split scope／「另案」／Ledger `deferred`｜`moved-to-issue` 且仍需 follow-up）**MUST** 另有 live tracking carrier（`notes/session-pending.md` H2 與／或 Program dashboard／Backlog／sub-issue）。**MUST NOT** 只把 sibling 寫在 closing change 的 Non-goals／archive prose。Owner／next step 契約 → `proposal-template.md`；pending／program 載體 → `session-pending-lifecycle.md`／`program-tracker-mode.md`。
  5. **省略條件**：省略僅允許判定為**非 material** 時，且 MUST 含 rationale＋owner；material 省略禁用「延後／非目標」搪塞。
  6. 語意是否「真 material／分類是否誠實」→ review-only；機械只鎖 leading YAML front matter 存在（`lint-risk-classes-record.mjs`＋`validate-openspec-change` **active／pre-archive** wire；既有 archive 不回溯）。**禁止**語意白話 hard CI fail；**禁止** prose／方言掃描作為 enforcement path。

### Rule-feedback Surface Matrix

`rule-feedback` 類 B-mini / B proposal 必須列 Rule-feedback Surface Matrix，避免靠 try/error 猜同步面。Matrix 至少含下列列；每列狀態只能是檔案/測試證據或具體 `N/A: <reason>`：

| Surface | 必填條件 | 驗收證據 |
|---|---|---|
| Rule leaf / adapter / hook / command | 改變 agent/runtime/review/gate 行為時 | 具體 `.devpro/agent-rules/*`、agent skill `SKILL.md`、platform adapter、hook、command/agent 路徑 |
| Affected capability spec | B-mini 一律必填（有可觀察行為即有 capability semantics） | 具體 `openspec/specs/<capability>/spec.md` delta；`N/A: no capability semantics` **僅限**判定為 chore A 的 doc-only/clarify-only，**不可**作為 B-mini strict-exit 的替代 |
| Cross-runtime parity spec | runtime、reviewer CLI、sticky、tool allowlist、adapter 行為變更時 | `openspec/specs/cross-runtime-parity/spec.md` 更新或具體 N/A |
| Mechanical guard | 有 grep/hook 可觀察 anchor 時 | `.devpro/scripts/tests/*` grep/hook test；無法 hook 時標 cooperative-only reason |
| PR dependency wording | 依賴另一個 pending/recent rule PR 時 | PR body / proposal-mini 明列 dependency branch/PR/SHA 與 release subset ordering |

TL 勾 B-mini `Tasks` 前，必須逐列確認 matrix 已落地；若任一列靠「應該不需要」而無 reason，視為 proposal 未完成。

## Exit Criteria

1. 三類文件存在於 `openspec/changes/<name>/` 對應路徑（chore A 免 meeting-notes + brd）
2. 欄位齊全：meeting-notes 含 5 節、brd 含 12 欄、decisions 每筆含 8 子項（空檔案合法）
3. 寫入時機正確：meeting-notes 在 pre-flight 前完成；brd 在 proposal 前完成；decisions 在觸發點發生時新增
4. tasks.md 每個 task 含「做什麼」一句話 + 可觀測驗收條件
5. bugfix tasks.md（或 B-mini 的 `proposal-mini.md` inline `## Tasks`）含 prove-it test task，排序先於修復 task
6. pre-merge requirement scope change 時已更新 decisions.md trigger `scope-change`、重跑 `dp-analyst -> dp-architect`、更新 spec/tasks，且未 merge PR 仍維持 same branch/change/PR 並完成 pre-merge re-archive，才繼續實作或 merge
7. proposal/proposal-mini 含 `## Requirement Ledger`，且該段是 parseable markdown table（非 bullet list）；tasks implementation rows trace 回 exact `[Req: R<N>]`（不可寫 `[Req: R1-R7]` range；多 ID 重複 exact tag 或逗號列 exact ID）（欄位 schema — 6 欄：`ID`、`Root Requirement`、`Parent Requirement`、`Current Requirement`、`Disposition`、`Owner / Next Step` + Disposition 列舉值 — SSOT 見 `proposal-template.md`；gate (m) 強制 markdown table，非 bullet list）

## Common Rationalizations

**「openspec-flow.md 已有概要，brd.md 不必這麼齊全」**
→ 反駁：openspec-flow.md 是路徑索引，本檔是欄位規格。齊全欄位是 dp-architect 讀取 brd 前的前提條件；缺欄位等於 brd 未完成。

**「decisions.md 空檔案算完成嗎」**
→ 對，空檔合法。decisions 僅在 5 個觸發點發生時才須寫入 entry；無觸發點的 chore 建立空檔即符合規格。

| AI 的藉口 | 反駁 |
|---|---|
| 「task 很明顯不用寫驗收條件」 | 模糊 task 勾選時無法驗證完成；30 秒寫驗收條件省去後續爭議。 |
| 「scope 只變一點點／使用者已選方案／原 PR 已 merge，不用重進 OpenSpec」 | 皆不構成豁免；見 `openspec-scope-change.md` §Common Rationalizations。 |
| 「bugfix 很明顯，不用 prove-it test」 | 沒有重現測試 = 無法確認修復、無法防回歸。強制項無豁免。 |

## Cross-References

- `openspec-flow.md` — OpenSpec 主流程 router
- `openspec-step-1-to-9.md` — step 1-9／Post-merge Recovery；`openspec-archive-principles.md` — Archive 細節
- `preflight-checklist.md` — pre-flight 明細
- `proposal-template.md` — Seams-first／Ledger schema（本檔 Synthesis pointer 對側）
- `dp-analyst.md`／`dp-architect.md` — 讀取本檔相關節

## Verification

```bash
# REQUIRED retain: grep "^## D[0-9]" | grep "prove-it" | grep "scope-change" | Synthesis
ls openspec/changes/<name>/{meeting-notes,brd,decisions}.md
grep -E "問題陳述|業務目標|Pre-flight 驗證結果表|分支資訊" openspec/changes/<name>/brd.md
grep "^## Scope" openspec/changes/<name>/meeting-notes.md
grep "^## D[0-9]" openspec/changes/<name>/decisions.md
grep -c "驗收\|test pass\|全綠" openspec/changes/<name>/tasks.md
grep "^## Requirement Ledger" openspec/changes/<name>/proposal.md
grep -E "\[Req: R[0-9]" openspec/changes/<name>/tasks.md
grep "prove-it" openspec/changes/<name>/tasks.md openspec/changes/<name>/proposal-mini.md 2>/dev/null
grep "scope-change" openspec/changes/<name>/decisions.md
grep -n "Synthesis mode\|UNRESOLVED:" .devpro/agent-rules/openspec-quality-and-formats.md
```
