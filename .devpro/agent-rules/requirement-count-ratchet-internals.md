---
name: requirement-count-ratchet-internals
description: Requirement Count Ratchet（需求數棘輪）閘的辨識與實作邊界：no-op 邊界、inert-only ledger、不可解析列、惰性 markdown 中立化、Requirement id 形狀 SSOT、載體順序 SSOT、共用邊界、grandfathering 落點、保證上限。觸發：棘輪閘回報非預期結果，或修改／審查 lint-requirement-count-ratchet.mjs 及其共用 lib 時。
---

# Requirement Count Ratchet Internals

> Load-chain：本檔由 `openspec-quality-and-formats.md` §Requirement Count Ratchet（需求數棘輪）按需載入；契約（正式表格相異 ID 計數不得超過 baseline）、Baseline Ledger schema 與「只認結構化列」的禁令留在該檔。只是依 schema 撰寫或更新 `## Requirement Baseline Ledger`、且閘結果符合預期時不必讀本檔。

**no-op 邊界**：無 proposal 載體、或有載體但**原文與中立化後皆無** `## Requirement Ledger` 區段 → exit 0 並輸出 `no-op` 及原因（**MUST NOT** 靜默略過，亦 **MUST NOT** 當作 `baseline=0`）。

**inert-only ledger 不是 no-op**：若**任一**載體的**原文**帶 `## Requirement Ledger`（只存在於圍籬、HTML comment，或因含 comment 起始序列的 inline code span 而被本辨識器轉暗）而中立化後沒有，**MUST** fail closed（`requirement-ledger-inert-only`），**MUST NOT** 回 `no-requirement-ledger`。理由是文件有宣告但辨識器無法把它讀為正式 Ledger；不能把不可讀當成沒有宣告。此 refusal 現由 `lib/requirement-ledger.mjs` 共用，棘輪、archive gate (m) 與 pre-archive task coverage 都讀同一結果。此規則對**每一載體獨立**適用：只要任一載體的 line-normalised view 有 exact `## Requirement Ledger` heading 而 live view 沒有，就在載體挑選與計數**之前** fail closed；另一載體帶 live ledger **不豁免**。

**不可解析的列 MUST 不被略過**：正式表格內以 `|` 開頭卻缺結尾 `|` 的列仍會被 markdown 渲染成資料列。閘 **MUST** 以 `malformed-requirement-row` fail closed，**MUST NOT** 靜默跳過——略過會讓 `current` 少計，方向與閘的目的相反。

**惰性 markdown 中立化**：fenced code block（backtick 或 tilde）**與 HTML comment**（`<!-- -->`）內的 heading 與表格 **MUST** 在辨識前被中立化；此外，目前手寫 comment scanner 會把 inline code span 內的 comment 起始序列當成真 opener，使其後內容轉暗——後者是**已知 false positive**，不是 CommonMark-correct 的保證。中立化 **MUST** 在**檔案讀取的那一次**做完（連同 BOM 去除與 CRLF 正規化），而非在個別 parser 內各自加固——辨識器已支援的 fence/comment 範例、或被註解掉的舊表格，**MUST NOT** 被讀成真實宣告。缺此處理會造成 fail-open：只有範例、沒有真表格的 change 會拿範例裡的數字當 baseline 而放行。**做在讀取邊界**是本條的實質要求：逐 parser 加固必然不對稱——本閘初版正是 `exactH2Blocks` 已 fence-aware 而 `decisionHeadingIds` 未 fence-aware，使 fenced-only 的 `## D<n>` 仍能綁定 baseline 列。

**Requirement id 形狀 SSOT**：辨識 `R<n>` 列的形狀 **MUST** 取自 `lib/requirement-ledger-rows.mjs`，**MUST NOT** 在消費端各自重打。窄一格的形狀會漏算 `R4a`／`R4.1`／`` `R3` ``，而拆分需求（R4 → R4a/R4b）正是需求成長最常見的形狀——重打形狀的閘會在它存在的目的上失明。四個消費端（gate (m)、本棘輪、`lint-proposal-tasks-checked.mjs` 的 `[Req:]` 探測、gate (m) 的 range 檢查）由 `lint-requirement-count-ratchet.test.mjs` 的反分歧測試機械鎖定：該測試 glob 全部非測試 `.mjs`（不得硬編碼消費端清單）、掃一組拼法而非單一字面（`R\d`／`R[0-9]`／`[R]\d` … 皆算重打）、豁免錨定完整上下文字面且該字面消失即失敗。

**載體順序 SSOT**：`proposal.md` → `proposal-mini.md` 的優先順序 **MUST** 取自 `lib/proposal-carriers.mjs`，**MUST NOT** 在消費端重打。順序反了就會對「哪個檔是 proposal」給出與 archive gate 不同的答案。語意不同的更廣清單（risk-class 載體、declaration 檔案）**不**併入——它們回答的不是同一個問題。

**共用邊界 MUST 誠實載明**：`lib/requirement-ledger.mjs` 共用正式 Ledger 的載體／recognized live H2／唯一 ID + Disposition 表格及其資料列；棘輪、gate (m) 與 pre-archive coverage **MUST** 消費同一結果。recognized fence/comment 範例不供應正式列；多 live 載體、多 heading、多 qualifying table **MUST** 依具名 ambiguity reason 拒絕，作者保留一份正式表格再重跑。棘輪數正式表格 ID 欄的相異 id，gate (m) 驗 lineage，coverage 比任務互咬；**MUST NOT** 宣稱總數或 verdict 必然相同。`lib/requirement-ledger-rows.mjs` 仍是 cell／id 形狀 SSOT；低階 `collectRequirementIds` 不等於正式表格選擇。此共用不擴 Markdown 支援、不改 baseline Git-history 機制、不防存心規避。

**Grandfathering 落點**：豁免由 `validate-openspec-change.mjs` 的 active-change scope（`!isArchived`，`:689`）提供，**呼叫點形狀**與 `lint-risk-classes-record`（`:677`）相同——兩支 lint 自身都不認得 archive。「同形」僅指這個呼叫點守衛，**不**代表兩者豁免語意相同：`lint-risk-classes-record` 對 chore A 給的是整份 change PASS，本閘對應的是具名 `no-op` 並印出原因。直接對 `openspec/changes/archive/` 執行本 lint CLI **會** exit 1 回報缺宣告，那是預期行為而非缺陷。

**保證上限（MUST 誠實載明）**：本閘保證「需求擴張留下具名、可稽核、需明確動作的痕跡」，**不保證**「擴張不會發生」。有動機且同時是作者的對手可自行追加一列後繼續擴張——驗證該決策理由是否為真屬語意判斷，為**具名接受的殘餘風險**，**MUST NOT** 據此增建機制。
