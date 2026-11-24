---
name: openspec-artifact-authoring
description: "OpenSpec artifact authoring recipe（proposal.md / tasks.md / spec deltas）。使用時機：使用者要求撰寫 OpenSpec proposal、tasks list 或 spec delta，或詢問 artifact format / archive-gate headings 如何運作時。"
metadata:
  user-invocable: true
---

# OpenSpec Artifact Authoring

## Overview

本 skill 是 OpenSpec **artifact-production** 端的 routing 與 operational-recipe 載體：撰寫 `proposal.md`、`tasks.md`、`spec.md` deltas 的具體順序與內容，使其能在第一次嘗試就通過 archive-gate。**Template 與 required-heading schema 留在 rule leaves**——`proposal-template.md` 擁有 required-heading contract 與 Requirement Ledger schema；`openspec-quality-and-formats.md` 擁有 tasks-quality 規則與 spec-delta 撰寫規則；`openspec-step-1-to-9.md` 擁有完整的 9-step branch/archive checklist。本 skill 排序撰寫步驟並標出 archive-gate 陷阱；不重新定義 schema。

## When to Use

- 在 `devpro:change` step 4 之後撰寫 `proposal.md` / `proposal-mini.md`
- 為新的 OpenSpec change 撰寫 `tasks.md`
- 撰寫 `## ADDED` / `## MODIFIED` / `## REMOVED` spec delta
- 偵錯為何 `openspec archive` 或 `pre-pr-archive-gate.mjs` 拒絕某個 artifact

## Process

開始本 recipe 前 MUST 先讀 `rules-rigor-level.md` 核對級別及來源；預設 lite 不要求下列 full artifacts。B 形狀不授權 full；升 full 的理由與使用者明確同意先依該 SSOT 完成。只寫使用者已授權的產物，不為了執行本 recipe 自行升級。

### 1. 先載入 schema SSOT

載入並執行 `proposal-template.md`（required headings、Requirement Ledger 6-column schema、Section 1/Section 2/Section 3 layout、**Seams-first／Seams Confirmation**）與 `openspec-quality-and-formats.md`（tasks acceptance-criteria、spec-delta 撰寫規則、**Synthesis mode**／`UNRESOLVED:`、必要時的 Rule-feedback Surface Matrix）。以下本 skill 的步驟排序撰寫順序；確切的 required headings、seams 與 synthesis 契約存在那些檔案裡——從那裡照抄，不要憑記憶；本 skill **不**複寫第二套 synthesis／seams 規則正文。

### 2. 判斷 artifact 範圍（chore A/B vs 完整 proposal）

在動筆之前，先查 `chore-classification.md` 判斷表（變更形狀維度；適用 chore/feature/bugfix/hotfix）決定 A / B-mini / B。A（doc-only/clarify-only）可完全略過 proposal；B-mini 需要含 Rule-feedback Surface Matrix 的 mini proposal；**full B** 才需要完整的 artifact set——不得只因前綴是 feature/bugfix 就預設 full。

### 3. 依此順序撰寫 `proposal.md`

1. `## Why` — 2-5 句動機說明（目前問題、影響、為何是現在）
2. `## What Changes` — 範圍 + 性質（fix/feature/refactor/chore）+ mechanical gate count
3. `## Requirement Ledger` — 6 欄 markdown table（`ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step`）；ID MUST 是精確的 `R<N>` 格式，絕不可用 `R1-R7` 這種範圍簡寫。`Disposition` 欄用固定 enum（`implemented` / `partial` / `deferred` / `rejected` / `moved-to-issue`），不要跟 spec delta 的 `ADDED`/`MODIFIED` 混用——兩者是不同語境的欄位
4. `## Capabilities` — New Capabilities / Modified Capabilities（若兩者皆無，明確寫「無新增/修改 capability」）
5. `## Section 1: Target State (Done When)` — 可 grep 的條件，用具體 anchor 字串，不要抽象措辭；施工圖級 How（怎麼做、tradeoff、風險、遷移）**不塞** Target State，外拆 `design.md`（格式見 `design-template.md`）
6. `## Section 2: Touch` — 逐檔列 path / 類別 / 動作 / Requirement；proposal 不承載 Token Budget/coverage/estimate/cap/mitigation/readability/N/A 或 substitute evidence
7. `## Section 3: Tasks` — full change 只放指向 `tasks.md` 的 non-executable pointer／scope 摘要，MUST NOT 放 top-level task checkbox；`tasks.md` 是唯一 executable ledger。B-mini 例外：`proposal-mini.md` 的 inline `## Tasks` 是唯一 executable ledger，且 MUST NOT 建 sibling `tasks.md`
8. `## Consequence Assessment`（`Security/trust/privacy/data` + `Material negatives/non-goals` 兩列）與 `## Risk Classes and Material Negatives` — **full change 無條件必要**（與 `risk_classes` 值無關，含 `none`）；`classifyBoundedRereview` 的 `parseSafetyObligations` 缺其一即 fail。B-mini 不需要這兩段。

### 4. 撰寫 archive-gate evidence 段落

Issue Anchor 是固定段落；source-governance headings 依 repository identity 與 bounded topology 條件化：

- `## Issue Anchor Verification` — 對每個引用的 issue/design anchor，執行 `grep -F "<anchor>" <file>` 並記錄目前 repo 的 hit count + 判定（現況違規/已修/不存在）
- `## File-Role Ledger` + `## Dedup Audit 三步結果` — 僅 proven source manifest 證明 delete、rename/copy、split、merge/collapse 或 cross-file dedup 時加入；普通 lone M / independent A 與 proven consumer 省略
- Ambiguous bounded source topology — 寫 exact `Source-Governance-Action: none|split|delete|merge|dedup; carriers=<exact comma-separated paths>; evidence=<status/path tuples>`；`none` 只處理 ambiguity，不得抑制 definite trigger
- Unknown identity — 有 bounded candidate 時 fail closed 等待 identity evidence；沒有 bounded candidate 時省略 headings、attestation 與 N/A

Actual-carrier token policy 由 pre-PR checks (e)/(r) 直接執行。Utilization >=80% 只標示 `semanticReview=required` 並 review actual carrier；proposal 與 full/B-mini artifact 不提供 token evidence。

### 5. 完稿並 commit 後執行 authoring-time risk-shape probe

`proposal.md`／`proposal-mini.md`（full change 另含 `design.md` 與每個 `specs/<capability>/spec.md`）寫完並 commit 後、開始寫 `tasks.md` 或動實作碼之前，跑：

```bash
node .devpro/scripts/validate-openspec-change.mjs <name> --strict
```

這重用 pre-PR Step 3 `classify-bounded` 同一套 round-1 risk-shape 推導，把「缺 `## Risk Classes and Material Negatives` 或 `## Consequence Assessment` 必要列」這類 full-change 結構缺口提前到 authoring 期發現，而不是等到 pre-PR Step 3 才回報。`classify-bounded` 現在會為 `risk_shape_unavailable` 附上封閉列舉 `risk_shape_debug_reason`（見 issue #2441／`fix-risk-shape-unavailable-diagnostics`），但那只給**類別**（例如「carrier 位元組與 HEAD 不符」），不指名是哪一個檔案、哪一個 heading；本 probe 才會指名確切的受 pin carrier 與缺漏的 heading／段落，兩者互補、非互斥。probe 要求每個受 pin 的 carrier 都已 commit（working tree 與 HEAD 一致）；剛編輯完尚未 commit 時，probe 會在呼叫 `classify-bounded` 之前就短路回報（不產生 `risk_shape_debug_reason`，該欄位僅在 `classify-bounded` 實際執行時才可能出現），訊息會指名確切的受 pin carrier，先 commit 再重跑即可。B-mini 也可執行，但不受 full-change 專屬的兩個必要段落約束。`--strict` 已蘊涵 risk-shape probe；裸 validate（無 `--strict`、無 `--risk-shape-probe`）維持不跑 probe。顯式 `--risk-shape-probe` 仍可在非 `--strict` 時單獨打開。full change 的 `design.md` `## Decisions` 標題 MUST 為 `### D<n> — <title>`（見 `design-template.md`）；裸 `### D1`／冒號變體會以「標題格式不對」早擋，不得只見裸 `risk_shape_unavailable`。

### 6. 撰寫 `tasks.md`

本步只適用 full change：把 step 3 的 task outline 落到 `tasks.md`，使它成為唯一 executable ledger；`proposal.md` 只保留 pointer／scope 摘要，不複寫 checkbox。B-mini 跳過本步，直接在 `proposal-mini.md` 的 inline `## Tasks` 維護唯一 ledger。

每個 task 需要：**做什麼**（一句話）+ **acceptance criterion**（可觀察證據——測試通過、檔案存在、API 回傳特定值）。完整的 acceptance-criteria 標準與模糊動詞 → 具體目標對照表（例如「add validation」→「列出各種無效輸入類型 → 為每種類型寫一個 failing test → 實作直到綠燈」）見 `openspec-quality-and-formats.md` §Tasks.md 品質要求。每個實作 task MUST 追溯到精確的 Requirement Ledger ID（`[Req: R1]`，多個則 `[Req: R1, R2]`——絕不可用範圍簡寫）。**Bugfix 的 tasks.md（或 B-mini 的 `proposal-mini.md` inline `## Tasks`）MUST 至少包含一個 prove-it test task，且排在 fix task 之前**——完整的 prove-it pattern 見 `testing-and-qa.md`。

### 7. 撰寫 spec deltas（`## ADDED` / `## MODIFIED` / `## REMOVED Requirements`）

Delta 粒度僅限 requirement 層級——沒有「對既有 requirement 只加一個 scenario」的 delta；新增/變更一個 scenario 意味著該 requirement 需要一個完整的 `## MODIFIED Requirements` 區塊。

**Requirement mode precheck（先查 canonical title set 再選 heading）**：寫每個 delta requirement 前，先讀 `openspec/specs/<capability>/spec.md` 的 `### Requirement:` title set。canonical title 已存在 → 用 `## MODIFIED Requirements`，並複製完整 requirement；canonical title 不存在 → 用 `## ADDED Requirements`；capability canonical spec 不存在 → 只能用 `ADDED` 建新 requirement。把 scenario 加到既有 requirement 仍是 `MODIFIED`，不是 `ADDED`。這一步不是 archive 失敗後補救，而是寫入當下的 authoring gate；archive 前用 `node .devpro/scripts/lint-delta-requirement-mode.mjs openspec/changes/<name>` 機械驗證。

**REMOVED 區塊必須逐字複製 canonical requirement 的完整區塊**：`## REMOVED Requirements` 底下的 requirement，body MUST 與 canonical `openspec/specs/<capability>/spec.md` 同名 requirement 逐字相同——`### Requirement:` 標題之後到下一個 `##`／`###` 標題為止，含全部 scenario；不寫 Reason／Migration 摘要，也不省略任何 scenario。原因：archive 後的 `seal-final`（`derivePromotion`）用精確相等比對 REMOVED 區塊與 canonical，不符時 archive commit 已經存在，唯一的修法是 rewind 後重審。`lint-delta-requirement-mode`（含 `--pre-review`）在 archive 前檢查同一件事；看到它紅燈，正解是回去把 canonical 那段原樣複製進 REMOVED 區塊，不是放寬 `seal-final`；若報 `removed-missing-capability`（`openspec/specs/` 下沒有該 capability 資料夾），沒有 canonical 可複製，正解是更正 delta 的 capability 資料夾名稱或移除該區塊。移除理由寫在 `proposal.md`／`proposal-mini.md`，不寫進 REMOVED 區塊。這是刻意覆寫 upstream spec-driven 範本對 REMOVED 的 Reason／Migration 要求；照該範本寫的區塊會被 `seal-final` 拒絕。

**單一最高風險陷阱**：`## MODIFIED Requirements` 區塊在 archive 時會對 canonical promoted requirement 做**完整取代（full replace）**。你 MUST 把該 requirement 底下所有既有 scenario 都複製進 delta，再加上你新增/變更的——遺漏的 scenario 會在 promotion 時被無聲刪除。完成一個 MODIFIED 區塊之前，問自己：*我是否複製了此 requirement 下的每個既有 scenario？若有意刪除某個，是否已列在 `## Removed Scenarios` 下？* 這是 archive-gate check (i) / `lint-modified-scenario-preservation` 的失敗模式，邊寫邊自我檢查遠比 archive 失敗後才發現划算。

**MODIFIED-delta 改 body wording 時，delta 與 canonical 必須兩邊同步**：若你在 `## MODIFIED Requirements` 區塊裡改的是既有 requirement **body 本身的 wording**（不只是加/改 scenario），archive promote 會用 delta 的 body **覆蓋** canonical spec 裡的 body。這代表 delta body 與 canonical requirement body 必須**同步寫成同一個最終態、逐行一致**——只改其中一邊會被 `lint-delta-body-canonical-wrap` 擋下。執行 lint 時 MUST 傳入建立 worktree 所用、已記在 startup evidence 的 immutable `<change-base-ref>`；禁止拿 `HEAD^`、最後一個 remediation commit 或任意 recent ref 代替，ref 缺失或無效就 fail closed。如此可機械攔截 change 開始後每個被改過卻未鏡像進 delta 的 canonical Requirement，即使同檔另一個 Requirement 已在 delta。**看到這個 lint 紅燈時，不要把它誤判為設計矛盾或架構衝突而停下**——body 逐行不一致（wrap-shape）的正解永遠是「回去把 canonical 那行也改成同樣的最終 wording」，讓兩邊同步。唯一的例外在 `canonical-touch-missing-delta`：若那個 canonical Requirement 是**具名依賴 merge 進來的、不是你寫的**，複製它等於讓 archive 記錄一筆本 change 沒做過的修改；此時改在 `proposal.md`／`proposal-mini.md`／`tasks.md`／`decisions.md` 任一檔加 `## Dependency-Absorbed Requirements` H2 並以裸標題 bullet 宣告（與 `## Removed Scenarios` 同語法）。宣告會被稽核：同時又寫進自己 delta、或沒豁免到任何一筆，都各自是一個 violation。

- 錯誤：delta 裡把 body 改成新 wording，canonical spec 裡對應 requirement 的 body 仍留舊 wording → `lint-delta-body-canonical-wrap` 擋下（兩者不逐行一致）
- 正確：delta body 與 canonical body 同一行都改成同一個最終 wording，兩邊逐行一致 → lint 通過

**`## Removed Scenarios` 宣告只留 bare title，rationale 另置段落**：每個 bullet **只能是 bare scenario title 單行**（用引號包住 canonical 的原始 title），任何說明/理由文字 MUST 放在 bullet 之後的獨立段落，**不可**尾隨在 bullet 同一行。原因：removed-scenario parser 用來擷取 title 的 regex 會把 bullet 後方尾隨文字一併吞入 title 字串，導致解析出的 title 與 canonical 的 bare title 對不上，archive-gate 會判定為「未宣告移除」而拒絕。bare 指 `#### Scenario:` 之後的文字，**不含** `Scenario: ` 前綴：lint 與 gate (i) 都以精確相等比對，帶前綴的宣告兩者皆不採認。`## REMOVED Requirements` 底下 requirement 的 scenario 若在 promote 後不再出現於同一 capability，也要列在這裡（`lint-modified-scenario-preservation` 在 archive 前檢查，不必等 gate (i)）。只宣告 promote 後真的消失的 title：gate (p) 以 title 豁免所有相關 archive 與 active change，多宣告會讓同名 ADDED／MODIFIED scenario 的 promotion 檢查被默默略過。

**`## Removed Scenarios` 寫入位置（四檔 SSOT；#2658）**：`## Removed Scenarios` **MUST** 寫在 `proposal.md`／`proposal-mini.md`／`tasks.md`／`decisions.md` **任一**檔。**MUST NOT** 只寫在（或同時留在）spec delta `specs/**/spec.md`——gate (i)／`collectRemovedScenarios` **不採認** delta-local 宣告；`lint-modified-scenario-preservation` 若在 active delta 偵測到 standalone 該 heading（略過 fence／inline 字面）→ **fail**（即使四檔也有宣告）。把宣告移到四檔並從 delta 刪除 heading 後再 archive。

- 錯誤：`- "Legacy Retry Path"——因與新 retry 邏輯重複而移除。`（bullet 尾隨理由文字，title 解析失敗）
- 正確：
  ```
  - "Legacy Retry Path"

  因與新 retry 邏輯重複而移除，詳見下方 rationale。
  ```
  （bullet 只留 bare title 單行；理由放下一段普通文字）

每個改變 agent/runtime/review/gate/workflow 行為的 `ADDED`/`MODIFIED` requirement MUST 在同一個 PR 中落地至少一個實作 carrier（rule leaf、agent skill、hook/gate/script、test），或明確標記 `cooperative-only` 並附上理由——沒有 carrier 的 spec-only requirement 無效。

**每個 scenario 的每一組 WHEN/THEN 都要有對應測項**：scenario 含多組 WHEN/THEN 時，寫完逐組對照本 change 新增的測項（`tasks.md` 驗收行所指向的實際測項（人工索引）或測試檔具名測項），缺的 MUST 補測，不得以 `tasks.md` 的文字說明代替測項（某組 THEN 無法測，代表該 scenario 本身不可驗證，改寫 scenario）；不得只測第一組。寫 scenario 的人與寫測試的人是同一個，注意力會停在剛驗證過的那條路徑上，沒測的那一組往往就是缺陷藏身處。實例：`Releasing A Claim Frees The Record For A Retry` 有兩組 WHEN/THEN，第二組（殘留必須拒絕）零測項，而碼恰與該組相反（strengthen-subagent-delegation-strategy r28）。

多組 scenario 的實際測項／machine fixture 使用 `[Scenario: <capability> :: <bare title>] [WhenThen: 1,2]` 宣告組別對應，可放在測項名稱或旁邊的註解；一測項可列多組，不同測項可合併涵蓋。組號依 scenario 內 live WHEN/THEN 的順序；AND 留在同組，fenced 範例與 HTML comment 不計。marker 兩個 bracket 欄位間與 `WhenThen:` 後各用一個空白，如上述格式。沿既有 `lint-delta-new-scenario-assertion-coverage.mjs` 執行或 active change 的 `validate-openspec-change.mjs <change> --strict` 會對未對應組號提出非阻擋 warning；依 warning 定位組別、補上真正驗證該組的測項後重跑。只限新增 scenario（ADDED 或 canonical 無同名的 MODIFIED），不補改歷史 corpus；單組維持既有檢查。`tasks.md`、Markdown scenario 說明與無關測項數不算對應；標記存在僅是 cooperative coverage evidence，MUST NOT 宣稱證明測項已執行或 assertion 語意正確。既有缺測項 title violation 仍阻擋。契約 SSOT：`openspec/specs/test-governance/spec.md` §New Multi-Pair Scenarios Have Advisory Clause Mapping。

### 8. 執行 `openspec archive` 前的預先自我檢查

```bash
git diff main --stat -- <spec>
grep -c "#### Scenario:" <spec>
node .devpro/scripts/lint-delta-requirement-mode.mjs openspec/changes/<name>
node .devpro/scripts/lint-modified-scenario-preservation.mjs openspec/changes/<name> --base <change-base-ref>
node .devpro/scripts/lint-delta-body-canonical-wrap.mjs openspec/changes/<name> --base <change-base-ref>
node .devpro/scripts/lint-proposal-tasks-checked.mjs openspec/changes/<name>
```

異常大量的刪除或 scenario 數量下降，代表你可能觸發了 step 7 的 full-replace 陷阱——先停下、恢復遺漏的 scenario 再 archive。寫入 spec.md 時也留意檔尾不要留尾行空白／trailing whitespace（archive promote 常會引入這類殘留，pre-PR 的 whitespace gate 會擋下，寫入當下順手避免比事後補救划算）。完整的 9-step branch/archive 排序（worktree setup、anchor calculation、archive timing、post-merge recovery）屬於 `openspec-step-1-to-9.md`——載入並執行它以處理周邊 workflow，而不只是 artifact 內容本身。

## Progressive Disclosure

- `references/archive-gate-headings.md` — 固定與 conditional heading 參考表，以及對應的 `pre-pr-archive-gate.mjs` check letter，摘錄自 `proposal-template.md`
- `references/spec-delta-pitfalls.md` — spec-delta 撰寫陷阱的擴充清單（MAY-only catch-22、no-delta ERROR／skip_specs、scope-shift scenario 語意、cross-carrier assertion sync），摘錄自 `openspec-quality-and-formats.md` §Writing Spec Deltas 與其按需 leaf `openspec-spec-delta-pitfalls.md`

只在你遇到特定的 archive-gate 失敗、或需要確切的 check-letter 對照時才載入這些——rule leaves 仍是 SSOT。

## Verification

```bash
grep "^## Why\|^## What Changes\|^## Requirement Ledger" openspec/changes/<name>/proposal.md
grep -E "\[Req: R[0-9]" openspec/changes/<name>/tasks.md
node .devpro/scripts/validate-openspec-change.mjs <name> --strict
node .devpro/scripts/lint-agent-skills.mjs
```
