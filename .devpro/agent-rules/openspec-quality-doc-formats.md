---
name: openspec-quality-doc-formats
description: OpenSpec doc formats 細則：meeting-notes.md / brd.md / decisions.md 必含欄位、存放路徑、寫入時機，以及 Requirement Ledger lifecycle；觸發：dp-analyst 撰寫 brd 前 / TL 撰寫 meeting-notes / decisions 觸發點發生時 / 需 Ledger 欄位細節時。
---

# OpenSpec Doc Formats 細則

> Load-chain：本檔由 `openspec-quality-and-formats.md` 按需載入；entry leaf 只保留 Tasks 品質 / Spec Delta / Rule-feedback Matrix，doc 格式規格在此。

### Section 1: Doc Formats

### meeting-notes.md

存放路徑：`openspec/changes/<name>/meeting-notes.md`；chore A 類分支免。

必含欄位（依序）：

- `# Meeting Notes: <change-name>`
- `日期`
- `## 需求背景`（2-5 句）
- `## 使用者確認的決策`（條列）
- `## Scope`（In / Out）

寫入時機：TL 建 change 目錄後**立即**寫入；dp-analyst 執行 pre-flight 前**必須**先讀取。

### brd.md

存放路徑：`openspec/changes/<name>/brd.md`；chore A 類分支免。

必含欄位：問題陳述、業務目標、功能需求、非功能需求、範圍界定（In/Out）、限制與假設、成功標準、風險、現況分析（當前版本/相關檔案/最近 commit）、先前嘗試（bugfix 必填）、Pre-flight 驗證結果表、分支資訊（change name / branch prefix / archived decisions check）。
heading 行先移除 Markdown heading marker、closing hashes、既有格式的 leading numeric ordinal（如 `1. `）與一組 terminal parenthetical annotation，再以正規化後的完整 title byte-exact 比對上列 12 項。編號標題與括號變體如 `## 5. 範圍界定（In/Out）` 仍合法；`非功能需求` 不得以 substring 關係代替缺失的 `功能需求`，前後加任意 prose 或意譯標題如「需求說明」也會被攔（`pre-pr-archive-gate.mjs` gate (j) 與 `--pre-review` 共用 validator）。

`成功標準` MUST 至少含一條 outcome 判準：從目標讀者的起始狀態（尚未做這件事、無本次 session 記憶）出發即可判定需求是否被滿足。純形狀斷言（段落齊備／字面可 grep／pointer 逐字一致／測試全綠）MUST NOT 單獨構成驗收；全部條目皆為形狀斷言 → dp-analyst FAIL。套用固定樣板句而未指名該起始狀態者不算 outcome 判準。本契約 forward-only，MUST NOT 溯及既有已 archive 的 brd.md。本條為 `cooperative-only`（「是不是 outcome 判準」屬語意判斷，鄰接 gate (j) 只機械驗 heading 存在，不驗本條內容）。

寫入時機：dp-analyst 完成 pre-flight 後**立即**寫入；dp-architect 設計 proposal 前**必須**先讀取。

### decisions.md

存放路徑：`openspec/changes/<name>/decisions.md`；**空檔案合法**——但有一個條件式例外：當 change 的 proposal 載體帶有 `## Requirement Ledger` 時，`decisions.md` **MUST** 存在且 **MUST** 帶一個 `## Requirement Baseline Ledger`（見 `openspec-quality-and-formats.md` §Requirement Count Ratchet），否則 `lint-requirement-count-ratchet.mjs` 會以 `baseline-ledger-missing` 擋下 archive。無 Requirement Ledger 的 change（該閘回報 no-op）不受此限，空檔案仍合法。

每筆 entry 必含：

- `## D<N>: <標題>`
- 時間、決策者
- 觸發點（`proposal-design` / `make-vs-buy` / `scope-change` / `reviewer-rejection` / `user-override`）
- 背景、選項、選擇、排除理由
- `supersedes`（若覆蓋先前決策）

**觸發點 5（user-override）**：任何階段中使用者否決 AI 技術方案時，TL **必須**新增 entry，觸發點標記 `user-override`。不觸發：使用者選擇 AI 提供的多選項之一、要求微調格式。

### 裝潢比喻（文件角色白話 SSOT）

OpenSpec 的 Why/What/How 只落在 proposal 與 design，brd=上游 Need、specs=下游 behavior contract。以下裝潢比喻為文件角色差異的**唯一**白話 SSOT，其他檔案只指向本節、不複寫：

- **brd＝屋主的需求**：「廚房太小、光線不夠，我要能開伙、要採光，預算這麼多。」→ 我要什麼（Need／需求；OpenSpec 無此層，devpro 前置）。SA 寫。
- **proposal＝設計師的決定**：「把這面牆打掉、窗戶加大、動線改 L 型。」→ 為何改（Why，指向 brd 不重述）＋要動哪些地方（What changes）。SD 寫。
- **design＝施工圖**：牆怎麼拆、樑要不要補強、水電怎麼走。→ 怎麼做（How）。SD 寫。
- **tasks＝施工步驟表**：拆牆→補樑→拉水電→裝窗。→ 做的步驟（implementation checklist）。SD／實作。
- **specs/ 變更單＝房子「現況說明書」這次要改的條目**：新增『廚房有中島含水槽』、修改『廚房開窗＝2.4m 落地窗』、移除『舊吊櫃』。→ 完工後對外看到的樣子（behavior contract）；archive 時併進長期保存的現況說明書，是唯一會長期留著、AI 之後拿來復刻的東西。
- **一句話**：Need（brd）→ Why+What（proposal）→ How（design）→ 步驟（tasks）→ 完工長怎樣（specs/，只有這個長期留著）；前四個做完收進檔案櫃（archive 備查），只有 specs/ 併進現況說明書。

### design.md

存放路徑：`openspec/changes/<name>/design.md`；full change **強制存在**（最小 `## Context` + `## Decisions` + `### D1 — <title>`）；B-mini／chore A 免寫（Cooperative watershed，見下）。

design.md 承載施工圖級 How（怎麼做、tradeoff、風險、遷移）；SD（dp-architect）寫。hook-enforced required headings：

- `## Context`
- `## Decisions`

何時寫：full B / feature 一律寫；**一句話設計**走 B-mini 才可免檔；full 的一句話 How 仍寫 stub（見 `chore-classification.md` 分水嶺定義）。

寫入時機：dp-architect 完成 proposal 後與 proposal.md 同批寫入 full `design.md`；dp-programmer 實作前**必須**先讀取（full 必存在；B-mini 可無檔）。

canonical 定位：design.md **非**長期復刻來源——與 proposal 一樣，隨 change archive 備查，不進 `specs/`。長期復刻來源唯一是 `specs/` 的 behavior contract。

各檔格式與 required headings 定義見 `design-template.md`；模板結構風格對齊 `proposal-template.md`。

### Requirement Ledger Lifecycle

Requirement Ledger 是需求生命週期追蹤，不是 proposal 裝飾欄位。目標是避免「大需求只完成小部分就宣告完成」。

1. **Intake / meeting-notes**：多項需求、建議清單、phase、follow-up obligation 進場時，`meeting-notes.md` MUST 保留原始需求清單或忠實拆解；不得只記 AI 打算實作的 subset。
2. **Planning / proposal**：`proposal.md` 與 `proposal-mini.md` MUST 含 `## Requirement Ledger`，用穩定 ID（`R1`、`R2`...）列每個原始需求或有意義 grouping，並保留 `Root Requirement` / `Parent Requirement` / `Current Requirement` lineage。
3. **Execution / tasks**：`tasks.md` 每個 implementation task MUST 以 exact `[Req: R<N>]` trace 回 ledger ID；多個 ID 可重複 exact tag（`[Req: R1] [Req: R2]`）或用逗號列 exact ID（`[Req: R1, R2]`），但不要寫 range shorthand（如 `[Req: R1-R7]`）。每個 `implemented` / `partial` ledger row MUST 有 task coverage；每個 `[Req]` MUST 存在於 ledger。
4. **Completion / PR + final handoff**：PR body、Session Recap、final response MUST 回報 ledger 完成度（例如 `R1 implemented, R2 partial, R3 deferred` 或 disposition counts），不得只說 tasks 已勾完。
5. **Follow-up / tracker**：`partial`、`deferred`、`rejected`、`moved-to-issue` MUST 有 reason、owner、issue 或 next-step trace；禁止 orphan follow-up。

Ledger table 必填欄：

| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |
|---|---|---|---|---|---|
| R1 | <最初需求來源：PR/issue/archive/R# + 摘要；first change 可寫 same as current> | <直接承接來源：上一個 PR/archive/R#；first change 可寫 same as root> | <本 change 要處理或 disposition 的需求> | implemented / partial / deferred / rejected / moved-to-issue | <owner / issue / next action; implemented 可寫本 PR> |


### Conditional Initiator / Affected（欄位語意 SSOT；不改六欄）

當該列／scenario 的驗收或行為依賴「誰發動／誰受影響」之區分，**或**本 change `risk_classes` 非 none（taxonomy 見 `openspec-quality-and-formats.md`）→ **MUST** 宣告 Initiator／Affected；否則 MAY 省略（省略 ≠ 寫全域 Actor）。

- **Ledger 列註記**（寫在 `Current Requirement` 細胞內；注意 escape `|`）：`Initiator=<…>; Affected=<…>` 或 `Initiator/Affected=N/A — <理由>`。
- **Scenario 載體**：適用 scenario 正文 MUST 含同語意 token 兩行——`Initiator: <…>` 與 `Affected: <…>`，或單行 `Initiator/Affected=N/A — <理由>`。
- **MUST NOT**：以 **BRD-global Actor**（整案共用角色欄／全域 Actor 段）替代列／scenario 宣告。
- **MUST NOT** 為本欄新增 Ledger 第七欄；六欄 schema 維持 `ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step`。

Lineage 規則：

- First change：`Root Requirement` 與 `Parent Requirement` 可相同，指向本次使用者原始需求。
- Follow-on change：MUST 保留最早 `Root Requirement`，並把 `Parent Requirement` 指到上一個 change 的 carry-over row；不得只引用最近一層而丟失 root。
- Current requirement 可以重新拆解 parent row，但不得改寫 root 語意來合理化縮 scope。

Accepted disposition:

- `implemented`：本 PR 完整落地。
- `partial`：本 PR 只完成一部分；MUST 寫剩餘範圍與 owner/next step。
- `deferred`：刻意延後；MUST 寫原因與後續入口。
- `rejected`：明確不做；MUST 寫理由。
- `moved-to-issue`：移到 tracker；MUST 寫 issue 或 tracker reference。若尚未建 issue，不能宣告 complete，只能回 blocked 或 deferred+owner。

機械邊界：`pre-pr-archive-gate.mjs` check (m) 只驗 proposal/proposal-mini 有 parseable ledger、lineage 欄、accepted disposition、task coverage、非 implemented row 有 owner/next-step；它不判斷原始語意是否被完整拆解。語意完整性由 reviewer / cross-model review / 使用者審查承接。
