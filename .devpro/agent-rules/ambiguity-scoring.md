---
name: ambiguity-scoring
description: 條件式 ambiguity 量化評分 + 3 challenge lens（Contrarian/Simplifier/Ontologist）；觸發：模糊動詞 AND 未指具體範圍/檔案/symbol，OR pre-flight 後有 ≥1 待確認項。
---

# Ambiguity Scoring + Challenge Lens

## Overview

pre-flight 為 binary gate。本 leaf 補 6 維 weighted score + 3 challenge lens，並鎖 Non-goals + Decision Boundaries（brd 必含）。亦為 pre-analyst clarification round-policy 唯一 SSOT（multi-round + hard caps；禁無限 state machine）。五欄白話卡的欄位規則與適用範圍亦以本檔 §Operator usage probe 為 SSOT（不限 pre-analyst）。

## Clarification Round Policy (pre-analyst SSOT)

本節規範 `/devpro:change` 呼叫 `dp-analyst` **之前**的 TL clarification。`devpro:change`／`stop-point-comms.md` 只 pointer 至此；禁第二套 cap／trigger（§Operator usage probe 的白話卡另適用全路徑，見該節適用範圍）。

**選項呈現（pointer-only）**：使用者可見的 clarification batch 問題／選項呈現 **MUST** 遵循 `stop-point-comms.md` **規則 5（選項呈現契約）**（提案確認主路徑、禁作文題主路徑、白話問題／選項、推薦理由在選項旁）。**禁止**在本 leaf 複寫作文題／理由旁註正文（禁雙寫矛盾）。

| 要素 | 規範 |
|---|---|
| Round unit | **一輪＝一次 clarification batch**（一次 AskUserQuestion 或一次 plain-text 問題清單；可含多題）。**不是**一題一輪。Cap 計 batch 次數。batch≠question。 |
| Default | 一輪 clarification batch |
| Multi-round trigger | 任一：`ambiguity ≥ 0.30`／大型行為變更／使用者明示先想清楚 |
| Working hard cap | **working cap 3** batches（觸發多輪後至此必須 cap-hit stop） |
| Absolute max | **absolute max 4** batches（3 + 至多一次使用者授權 extension）；記 `extension_used`；重複 +1 **禁止** |
| Cap-hit | `cap_hit=true`（或 round 3 結束且 frontier 非空）→ MUST 先取得 `cap_resolution`∈{`extend`,`split`,`carry-gaps`} 且 `cap_resolution_provenance=user`。**`cap_resolution` 未決前**，即使 `shared_understanding=confirmed` 也 **MUST NOT** 呼叫 `dp-analyst` |
| Post-cap | `extend`：僅 `round4_completed=true` 後，且 frontier 空 **或** 後續 `split`／`carry-gaps` 條件滿足才可放行；`extension_used=true` alone 不夠。`split`：`terminal=split`，**MUST NOT** 呼叫 `dp-analyst`。`carry-gaps`：缺口已寫入 Non-goals／Decision Boundaries 且 `gaps_written=true`、`terminal=carry-gaps`，且 `unresolved` 含對應 `UNRESOLVED:` 耐久證據（禁只靠 boolean／空 unresolved）；禁只用 `shared_understanding` 滿足 post-cap |
| 無 trigger | frontier 非空且無 multi-round trigger → MUST NOT 開 round 2；MUST：`shared_understanding=confirmed` **或** `terminal=carry-gaps`／`split` |
| Analyst gate | 僅當 cap 優先序滿足 **且** 對應 terminal 證據齊全；未 cap-hit 路徑才允許 frontier-empty／shared-understanding／carry-gaps 三選一 |

### Operator usage probe before packaged default

Anchor：`operator-usage-before-packaged-default`。pre-analyst **MUST** 先從訪談／repo **合成**五欄白話卡，再請使用者「請確認或改」。**確認（含改寫後再確認）前** → **MUST NOT** 給 numbered packaged default、**MUST NOT** 呼叫 `dp-analyst`——與五欄是否已合成齊全、是否尚無 `UNRESOLVED:` **無關**；卡已合成、仍在等待使用者回覆時亦同。有未解 `UNRESOLVED:` → 同樣 **MUST NOT**。確認後才可給 numbered packaged default／呼叫 `dp-analyst`。具體或 lens 未觸發**不豁免**；通則不隨交付物類型條件化。observable done-when **不能代替**本確認。`devpro:clarify` 只 pointer。

**適用範圍（不變量）**：Anchor `plain-language-card-before-first-implementation-write`。rigor full／lite 下每個需求驅動 change（A／B-mini／B，含手動 chore A）**MUST** 在第一個實作寫入前取得五欄白話卡確認（改欄後再確認）；第一個實作寫入＝`openspec/changes/<change>/` 以外的第一個 repo write，startup／授權／OpenSpec 證據與 gitignored `notes/` 不算。位置：full＋B 在 pre-analyst 訪談後、`dp-analyst` 前（上段）；lite 全分類與 full 初判 A／B-mini 在 `/devpro:change` 第零步，卡確認前不建 worktree；手動 chore A 在第一次 git 動作的確認訊息。任一欄仍是 `UNRESOLVED:` 不算確認（回「卡 OK」亦同）：只就該欄提問，補齊並確認前同樣不建 worktree、不做第一個實作寫入。跳過 clarify／`dp-analyst` 不等於不確認需求；欄位規則同本節。不適用：rigor `off`；bump、rules sync、release、archive 回補、revert、`review/pr<N>` 等非需求變更車道（不是 A 類豁免）。

五欄固定（使用者可見預設正體中文）：**使用者故事**／**現在**／**引擎**／**做成後你會看到**／**不該被整包丟掉的**。僅標 `UNRESOLVED:` 的欄可再提問；其餘走確認形狀，**MUST NOT** 以四維逼問＋捏造 numbered 選項當主路徑。

**使用者故事** MUST 同時可觀測回答誰／什麼狀態／什麼觸發，禁止同義反覆／空泛過閘：

| 必含 | 合格例 | 不合格（MUST `UNRESOLVED:`） |
| --- | --- | --- |
| 誰 | 角色或具體操作者類別（例：流程設計者） | 「使用者／有人會用」 |
| 什麼狀態 | 進入該需求前的系統／工作狀態（例：已開屬性窗） | 「需要時／平常」 |
| 什麼觸發 | 觸發要做這件事的具體事件 | 「當要使用此功能時」（同義反覆） |

缺任一、或僅同義反覆 → 該欄 `UNRESOLVED:`。空泛使用者故事不可當 confirmed。

**現在**：

- 能力**已存在**：合成 last real episode 或 current workaround；合成不出才 `UNRESOLVED:`。
- **greenfield**（尚無該能力）：只要求現況繞法／現在怎麼做；**MUST NOT** 捏造「上次用未建功能卡住」的 episode 選項。

**引擎** MUST 承接（合成優先；未知才問）：

1. 既有能力／機制：repo 或訪談可指出的路徑／規範／工具；未知 → `UNRESOLVED:`。
2. 複製＋建立後不可變識別（ID／SKU／slug／FormKey）：引擎欄 MUST 寫明新實體該欄如何賦值，並與同表面 Create 路徑比較；已知則合成供確認，未知標 `UNRESOLVED:`。複製建立後不可變識別 **MUST** regenerate 對齊 Create，**MUST NOT** `{source}.copy`（硬禁令；不靠「僅提問」替代）。

**做成後你會看到**：observable done-when。

**不該被整包丟掉的**：must-keep。

**卡確認後寫回**（full＋B；第零步路徑（含第三步前單獨送卡）與手動 chore A 確認的卡改寫 session-pending capsule，見 `devpro:change` 第零步。Seams／Ledger schema 不動；禁只留做成後＋must-keep 而丟其餘欄）：

1. **五欄全部**進 Clarification State `decisions:`（每條 `(provenance: user)`；改寫欄同）；使用者故事條 MUST 可還原誰／狀態／觸發。
2. 「做成後你會看到」**另**轉寫進既有 `seams:` observable bullets，再走 confirmed／fingerprint／reconfirm／expansion。
3. 「不該被整包丟掉的」must-keep 留在 `decisions:`（**不**擴 Requirement Ledger 欄）。

### Web theme/locale probe before dp-analyst dispatch

Anchor：`web-theme-locale-probe-before-analyst`。**本節僅在觸發條件成立時適用**：需求明示要新建或重建一個 user-visible Web 頁面／畫面／view／route（非對既有頁面的局部修改、非純樣式微調、非非 UI 需求），觸發條件逐字定義見 `.devpro/agent-rules/frontend-theming-and-i18n.md` `## When to Use`，本節不複寫。觸發條件成立時：repo 無可繼承 `web-theme:` 決策時，pre-analyst **MUST** 主動問是否需要 dark/light 主題切換機制，且 **MUST wait until** 該題已 answered 才可繼續；repo 無可繼承 `web-locale:` 決策時，pre-analyst **MUST** 主動問是否需要多語系支援，且 **MUST wait until** 該題已 answered 才可繼續。任一維度未命中繼承判定、且該維未取得使用者答覆 → MUST 在 `## Clarification State` 記一行 `UNRESOLVED:`，且 **MUST NOT** 呼叫 `dp-analyst`。**觸發條件不成立時**（既有頁面局部修改、非 UI 需求）：本節 **MUST NOT** 被引用為阻擋 `dp-analyst` 呼叫的理由，即使 repo 缺乏可繼承的 `web-theme:`／`web-locale:` 決策。繼承證據 MUST 只取自 `## Clarification State` 區段內 `decisions:` 欄的 item，區段外與他欄一律 **MUST NOT** 視為證據。完整判定形狀（觸發條件、四階段程序、判定指令、掃描路徑封閉集、排除清單、CE 反例表）見 `.devpro/agent-rules/frontend-theming-and-i18n.md` `## When to Use`，本節不複寫。

### Clarification State（meeting-notes 有界欄）

寫入 active change `meeting-notes.md`（非 full transcript）：

```markdown
## Clarification State
- round: <1|2|3|4>   # batch count; not question count
- extension_used: false | true
- round4_completed: false | true
- cap_hit: false | true
- cap_resolution: none | extend | split | carry-gaps
- cap_resolution_provenance: none | user
- frontier: ≤20 bullets; each ≤200 chars; each ends `(provenance: user|repo-fact)`; no PII/secrets/transcript
- unresolved: ≤20 lines; each ≤200 chars; `UNRESOLVED:` prefix; each ends `(provenance: user|repo-fact)`
- decisions: retained decision bullets; each ≤200 chars; each ends `(provenance: user|repo-fact)`  # Provenance MUST
- shared_understanding: pending | confirmed
- shared_understanding_provenance: none | user
- terminal: none | split | carry-gaps | frontier-empty | shared-understanding | abort
- gaps_written: false | true
```

**Field bounds**：超上限 MUST 截斷並標 `UNRESOLVED: field-overflow` 或 fail-closed。**Provenance MUST**：frontier／unresolved／decision 每條 bullet 末尾 `(provenance: user|repo-fact)`（禁單一頂層 `decision_provenance` 欄位代替）。frontier 非空且 `shared_understanding=confirmed` → MUST `shared_understanding_provenance=user`（禁無 user 證據的 confirmed）。PII／secret／transcript deny-list（Gate P 對齊）命中 → fail-closed，不得寫入。Executable check：`.devpro/scripts/lib/clarification-contract.mjs`（unit：`clarification-contract.test.mjs`）。

**Write-back fail-closed**：meeting-notes／BRD-boundary 寫入失敗 → 停。出口僅：(1) 成功 retry；或 (2) 使用者 recorded `terminal`∈{`split`,`carry-gaps`,`abort`}（provenance=`user`）。meeting-notes **可寫** → Clarification State.`terminal=abort`（或 split／carry-gaps）。meeting-notes **本身寫失敗** → 同 change `decisions.md` 固定 heading `## Write-back Abort`（日期、失敗表面、user choice、provenance=user）+ stop-point。未成功 retry 且無 recorded terminal → **MUST NOT** 呼叫 `dp-analyst`。`terminal=abort`：本案澄清中止；MUST NOT 呼叫 `dp-analyst`。

**Done When＝機械測**；民俗品質指標（「感覺問清楚」「較完整」等）**manual-only**，禁作 CI fail／硬驗收。

## When to Use

### Score / lens trigger（dp-analyst）

dp-analyst 在 pre-flight checklist 通過後，偵測下列任一條件命中即觸發本 leaf 的 score／lens：

1. **模糊動詞觸發**：需求含 starter list 7 詞之一（`優化`、`改善`、`重構`、`做好`、`處理一下`、`整理`、`修一修`）**AND** 未指具體範圍/檔案/symbol。Starter list 為 floor，未列詞由 dp-analyst 視語境判斷
2. **待確認項觸發**：pre-flight checklist 通過後有 ≥1 「待確認項」（dp-analyst 對任一點仍存疑）

兩條件擇一即啟動。皆未命中時，Output 必含一行 `Ambiguity scoring skipped (trigger conditions not met: <條件>)`，**禁靜默跳過**。

### 邊界 case 對照

- ✅ **觸發**：「優化效能」（含模糊動詞 + 未指範圍）
- ❌ **不觸發**：「優化 SQL query 至無 N+1 問題」（含模糊動詞但已指 N+1 具體目標）
- ✅ **觸發**：「整理 logging」（含模糊動詞 + 未指 file/symbol）
- ❌ **不觸發**：「整理 OrderService.cs 中 30 行的 if 巢狀」（含模糊動詞但已指 file:symbol）

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A |
| Advisory | `.devpro/scripts/tests/web-theme-locale-probe-grep.test.mjs`（防條文字面被靜默刪除／弱化，不驗「是否遵守」） |
| Doctrine | `cooperative-only`：白話卡確認（含第一個實作寫入前不變量）是否真被執行不落 repo diff，欄位義務無可靠 hookable indicator（矩陣見 `proposal.md`） |

### Spec-Interview Lens（高複雜 / 高模糊時）

當需求達成任一條件時，dp-analyst 在交棒 dp-architect 前補一輪 runtime-neutral spec interview：

- ambiguity score `>= 0.30`
- 預估 task 數 `> 7`
- UI/UX、資料邊界、權限、安全、效能任一面向會改變使用者可觀察行為
- 使用者描述含「大型功能」「新架構」「先想清楚」「方案比較」

只問 non-obvious 問題；已由 repo／使用者文字回答的不問。至少覆蓋 acceptance、non-goals、risk、edge、compatibility。compatibility 問句 **MUST** 先依 `pre-implementation-over-design.md` §`Pre-Ship Contract Dual-Read Ban` holder test 釐清有無持有者（**不重列**該節三條件原文）；無持有者則在 brd `## Decision Boundaries`／non-goals **記錄**「不做 vN-1 相容」。結果寫回 brd `## Decision Boundaries` 或 proposal done-when，不綁特定 runtime tool。

### 6 維加權公式

公式：`ambiguity = 1 - weighted_sum(scores)`；每維 0.0（不清晰）— 1.0（清晰）

#### Greenfield（無既有 codebase context 需求）

| 維度 | 權重 | 評分依據 |
|---|---|---|
| Intent Clarity | 30% | 為何要做此變更？根因 vs 症狀區隔 |
| Outcome Clarity | 25% | 達成什麼可觀測的端狀態？ |
| Scope Clarity | 20% | 變更走多遠？哪些 explicit 不做？ |
| Constraints Clarity | 15% | 技術 / 業務界線 |
| Success Criteria | 10% | 完成的判定標準 |

#### Brownfield（既有 codebase 需要 context grounding）

| 維度 | 權重 | 評分依據 |
|---|---|---|
| Intent | 25% | 同上 |
| Outcome | 20% | 同上 |
| Scope | 15% | 同上 |
| Constraints | 15% | 同上 |
| Success | 10% | 同上 |
| Context | 15% | 既有 codebase 的相關 file / symbol / pattern 是否已盤點 |

### Threshold 0.30 gate

- `ambiguity ≥ 0.30` → 回傳 `status: questions`，列 pending_questions 給主 agent，**禁交棒** dp-architect
- `ambiguity < 0.30` → 方可 `status: finished`

### Mandatory readiness gate（全分支必過）

無論 ambiguity scoring 是否觸發，brd.md MUST 含兩段：

- `## Non-goals`：明示「不做什麼」（避免 over-scope）
- `## Decision Boundaries`：明示哪些技術選擇 dp-architect 可自決、哪些必問使用者

任一段空白或寫 `TBD` 視為 dp-analyst FAIL。

**Material negatives 禁逃（短 MUST；SSOT pointer）**：`## Non-goals`／`## Decision Boundaries` **MUST NOT** 用來逃脫 high-risk material negatives，也 **MUST NOT** 把本屬 closed-set taxonomy a–d 的 change 改口成 `risk_classes: none`。完整 taxonomy／`risk_classes`／四類 negatives／省略條件 → `.devpro/agent-rules/openspec-quality-and-formats.md`（本 leaf 不複寫）。

### Lens Completion

每個必要視角須記錄檢查對象、結論、依據。可回報具體 finding，或有依據的「未發現問題」；不能只填無問題、空白、TBD 或未評估。沒有 finding 不代表未執行，也不得為完成配額製造問題。已發現的真實問題仍依原規範處置。語意與依據充分度為 cooperative-only，anchor 只守載體／契約，不新增 runtime lens validator。原觸發、ambiguity 分數門檻、Non-goals／Decision Boundaries、finished／questions／failed 均不因此改變。

### 3 Challenge Lens（觸發時各跑一輪，留下有依據的判斷）

| Lens | 適用情境 | 典型問題 | 結束條件 |
|---|---|---|---|
| **Contrarian** — 質疑核心假設 | 需求建立在未驗證假設（如「使用者覺得 X 慢」） | 「假設不成立時方案是否仍合理？有反例？資料/證據？」 | 假設被資料支持，或推翻後調整方案 |
| **Simplifier** — 質疑 over-scope | scope 比 outcome 更大（如修 bug 順便 refactor） | 「最少做什麼即可達成 outcome？輔助功能能否 defer？」 | scope 收斂到最小可達 outcome 集合，多餘項列「本次不做」 |
| **Ontologist** — 症狀 vs 根因 | 描述偏症狀層（「測試很慢」「commit 很大」） | 「症狀還是根因？治症狀後根因會以其他形式再現嗎？」 | 問題框定到根因層，或確認治症狀是 acceptable trade-off（含理由） |

## Exit Criteria

- **觸發時**：brd.md 含四段：`## Ambiguity Score`（6 維 + 總分）、`## Challenge Lens Findings`（3 lens 各有檢查對象、結論、依據）、`## Non-goals`、`## Decision Boundaries`
- **未觸發時**：brd.md 含 `## Non-goals` + `## Decision Boundaries` + skip notice 一行
- 高複雜 / 高模糊時已執行 Spec-Interview Lens，或明示未觸發原因
- ambiguity 總分 < 0.30 才允許 dp-analyst 回 `finished` 並交棒 dp-architect

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「需求清楚不用 scoring」 | 本 leaf 只在條件命中時啟動，無觸發即 skip，無 cost |
| 「mandatory gate 太多 brd 段」 | 兩段各 1-3 句即足；missing 等於 dp-architect 決策無 anchor |
| 「lens 只是形式問問」 | 必要視角須有檢查對象、結論、依據；空白／TBD／未評估不算完成，有依據的無 finding 合法 |
| 「starter list 沒列我用的詞不用觸發」 | starter list 是 floor，未列詞由 dp-analyst 視語境判斷 |
| 「訪談要靠特定 runtime tool」 | shared rule 只要求問題品質與紀錄位置；工具 UI 是 adapter 實作細節。 |

## Verification

```bash
grep -c "^## " .devpro/agent-rules/ambiguity-scoring.md          # = 8
grep -c "Contrarian" .devpro/agent-rules/ambiguity-scoring.md    # ≥ 1
grep -c "Simplifier" .devpro/agent-rules/ambiguity-scoring.md    # ≥ 1
grep -c "Ontologist" .devpro/agent-rules/ambiguity-scoring.md    # ≥ 1
grep -c "Spec-Interview Lens" .devpro/agent-rules/ambiguity-scoring.md # ≥ 1
grep -cE "✅|❌" .devpro/agent-rules/ambiguity-scoring.md        # ≥ 4
grep -c "working cap 3" .devpro/agent-rules/ambiguity-scoring.md # ≥ 1
grep -c "absolute max 4" .devpro/agent-rules/ambiguity-scoring.md # ≥ 1
wc -l .devpro/agent-rules/ambiguity-scoring.md                   # ≤ 220
```
