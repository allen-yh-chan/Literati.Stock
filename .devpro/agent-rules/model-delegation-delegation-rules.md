---
name: model-delegation-delegation-rules
description: MUST-delegate 細則：各 subagent 的強制委派條件、SHOULD delegate 升級判斷、豁免規則。觸發：需確認「哪些情境必須委派給哪個 subagent」時。
---

# MUST delegate 規則

> Load-chain：本檔由 `model-delegation.md` 按需載入；entry leaf 只 eager-load 委派決策速查，MUST-delegate 細則在此。

### MUST delegate 規則

**Outcome mandatory；executor 由決策序決定。**各角色的 mandatory outcome（brd／proposal／六軸 receipt／實作與測試）不可省略；由誰執行依 `model-delegation.md` §Executor 決策序判定，本檔只列 `fresh` 觸發條件。未命中 `fresh` 觸發者 TL-direct，產出**同 schema 同 acceptance**；TL-direct 是決策序的正常結果而非 fallback，且 MUST NOT 滿足任何要求獨立判斷的 contract（receipt `reviewer_identity.executor_kind: tl-direct`）。

Runtime或工具政策可能限制subagent啟動，但限制本身不是自動fallback。只有benefit/cost admission通過或本檔明定mandatory role時，才形成repo-level automatic authorization/mandate `RepoDelegationAutoAuthorization`；task shape本身不形成authorization。工具另要求explicit trigger時，須有`StandingDelegationAuthorization`才可呼叫；缺trigger進`SubagentAuthPending`問一次，不得直接TL fallback。只有`subagent=no`、使用者拒絕、runtime-reported terminal quota/timeout、授權後工具仍不可用或terminal call失敗，才依Mandatory Role Fallback Mapping由TL承接；mandatory gate仍須完成。

TL-selected wait/poll timeout MUST NOT count as runtime terminal timeout; a TL-caused interruption MUST NOT count as call failure or trigger fallback, and MUST first follow the recovery path in `model-delegation-active-lifecycle.md`.

#### MUST delegate 到 `dp-analyst`

- outcome mandatory：`devpro:change` 被 invoke 時 MUST 產生 brd（pre-flight checklist + 需求分析）＋ status。
- `fresh` 觸發：pre-analyst clarify 後仍有 material ambiguity；跨 repo／多 stakeholder；記錄的 `context-isolation` 理由。
- 否則 TL-direct：TL 以 clarify capsule 為輸入寫同 schema brd ＋ status（輸出要求同 `model-delegation.md` §Fallback 最小輸出要求）。

#### MUST delegate 到 `dp-architect`

- outcome mandatory：dp-analyst 回傳 PASS 後 MUST 產生 proposal（target state、touch list、Task Outline handoff；full change 另含 `design.md`）；full task rows 由 TL／dp-assistant 寫入 `tasks.md`。
- `fresh` 觸發（mandatory 獨立判斷）：`risk_classes` 非 none 或 Architecture Ask First boundary → MUST `fresh` dp-architect。
- 否則 TL-direct：依 `openspec-flow-fallback.md` 寫 proposal／design ＋ status。
- 主 agent 在 source repo 工作且需要規劃 doc-only change 時，亦可呼叫（非必須）

#### SHOULD delegate 到 `dp-architect`（update 模式）

- TL 與使用者完成設計討論後，**scope 顯著變更**（新增/刪除 phase、架構方案改變、touch list 顯著增減）→ 把設計決策摘要交給 architect 重跑影響評估（mode: `update`）
- 判斷基準：spec更新涉及**≥3個task**或target state增減**≥2條done-when**時，MUST做update admission；通過才委派，未通過由TL直接改並記錄成本判斷
- Architect 回傳 delta report 後，TL（或 dp-programmer/dp-assistant）再依 report 寫入實際 spec 檔案

#### TL Tier Floor

TL 當下推理層依序解析：(a) runtime session metadata 明示 → (b) 使用者／啟動設定明示宣告 → (c) 皆無則 `unknown`。解析為非高推理層（含 `unknown`）時，下列 floor-gated 項目 TL **MUST NOT** 依原方式自行完成，MUST 依下表處置；`unknown` 於**首次**觸發時依既有 `SubagentAuthPending` 同型模式 ask once，答覆於該 session 內有效。此為能力下限而非義務豁免：降級只減少 TL 可自做的工作，不放寬任何委派義務。

| floor-gated 項目 | 非高推理層時的處置 |
|---|---|
| 技術設計／架構權衡 | MUST delegate `dp-architect`（交叉引用上方既有義務，非新增） |
| RCA 根因判定 | 依 `model-delegation.md` §RCA 探索逃生閥 把剩餘探索下放 `dp-assistant`；根因判定仍留 TL，仍不收斂 → STOP |
| Branch Routing Decision／Task 相依性分析與分派排序／Review 回報綜合判斷 | STOP + 交棒使用者 |

STOP 依 `stop-point-comms.md` 編號格式，選項恰兩項：1 切至有已記載 selector 且能觀測 effective rank 達該項 floor 的 adapter/session，證據成立後續行；2 其他。若目前 adapter 的 selector 為 `unavailable`，不得要求在該 adapter 內升 effort。此 STOP **non-bypassable**：不提供由 TL 以未達 floor 的 effort 繼續執行。

重新解析 tier 的可觀測訊號（任一出現即重解；不要求 TL 偵測不可觀測事件）：(a) 既有 fallback 標記（見 `platform-adapters/<runtime>-effort-tiers.md`）、(b) RCA 逃生閥非收斂訊號、(c) 使用者告知。可觀察 fallback 訊號優先於較早的階梯宣告（含同 session 較早的使用者宣告）；階梯的較早步驟優先只用於排序同一時間點並存的多個來源。

#### TL Effort Floor

Shared 四階（adapter 只做 mapping／不得當 shared SSOT）：低努力層／中努力層／高努力層／最高努力層。`最高努力層`＝該 runtime 已記載的 ceiling rank。

活動分級依實際工作內容，不依 artifact 名稱或檔案數：

| 工作活動 | Shared 預設 floor |
|---|---|
| typo／小幅文字或格式整理，無行為設計 | 低努力層 |
| routine 實作／測試／OpenSpec 文書小改；含新設計或 routing 時依該活動升級 | 中努力層 |
| 複雜 code review、RCA 根因判定、Branch Routing、相依性／分派排序、TL review 綜合判斷 | 高努力層 |
| 跨檔高風險 debug | 共享 RCA 下限為高；保留各 adapter 的較高建議；若含技術設計、release、security 或 production blocker 判斷，套用更高 floor |
| proposal 技術設計／架構權衡 | 最高努力層 |
| release／security／production blocker 的 TL 判斷 | 最高努力層 |

selected effort 與 effective rank 分開解析。使用者／啟動設定或角色 frontmatter 只記錄 selected selector，不能單獨證明已生效。effective rank 只由 adapter 可觀測的 runtime session metadata／switch report 證明。有效 rank 解析：(a) 有可觀測生效證據 → effective rank；(b) 有 verified selector 但沒有 effective 證據、selector rejected，或只有 selected 設定 → `unknown`；(c) adapter Support 載明無 verified／repo-stable selector → `unavailable`。`unknown` ≠ `unavailable`。`unknown` 於首次觸發 ask once，答覆於該 session 內有效；答覆仍只是 selected 設定，不是 effective-rank 證據。`unavailable` 宣告 `reasoning-depth unavailable`，MUST NOT 發明 selector，也 MUST NOT 要求在目前 adapter 內升 effort；改依 `#### TL Tier Floor` 同項處置＋既有 verification gates。需要改走其他 adapter/session 時，只有在其 selector 有記載且 effective rank 可觀測達 floor 後才可續行。

此為能力下限而非義務豁免：降低 effort 只減少 TL 可自做的工作，不放寬任何委派義務。兩軸同時觸發時較嚴者優先；不合併兩表。

| floor-gated 項目 | 下限 | effective rank 低於下限且 selector verified | effective rank unknown／unavailable 或升級後仍未證明 |
|---|---|---|---|
| 技術設計／架構權衡 | 最高努力層 | 升至下限並驗證 effective rank；未證明時依右欄 | 任一 active adapter 下，只有 effective rank 已證明達 floor 的 `dp-architect` 委派可承接；若沒有該角色，TL MUST STOP |
| RCA 根因判定 | 高努力層 | 升至下限；否則既有 RCA 逃生閥路徑，不收斂 → STOP | 依 `#### TL Tier Floor` 同項處置 |
| Branch Routing Decision／Task 相依性分析與分派排序／Review 回報綜合判斷 | 高努力層 | 升至下限；否則 STOP + 交棒使用者 | 依 `#### TL Tier Floor` 同項處置 |
| release／security／production blocker 的 TL 側判斷 | 最高努力層 | 升至下限；否則 STOP + 交棒使用者 | `unknown`／`unavailable`：STOP + 交棒；`unavailable` 先宣告。只有轉至可證明 floor 的 adapter/session 才可續行，仍須通過既有 verification gates |

技術設計的 floor fallback：任一 active adapter 下，若 TL 無法證明自己的 effective rank 達最高努力層，只能在 effective rank 已證明達 floor 時委派 `dp-architect`；selected selector 或固定角色 frontmatter 均不等於 effective-rank 證據。若沒有 effective effort 已證明達 floor 的 `dp-architect`，必須 STOP 並沿用上方可行選項；`unavailable` 時不得要求在目前 adapter 內升 effort。

其他 floor-gated 項目若有效 rank 未證明達下限，依上表該項既有 disposition；不得把 selected 設定或角色 frontmatter 當作 floor 證據。

重解（任一即重解；可觀察訊號優先於較早宣告）：(a) 既有 fallback 標記、(b) 使用者告知／切換回報。

本段為 `[cooperative-only, weak enforcement]`。

#### MUST delegate 到 `dp-reviewer`

- outcome mandatory：`devpro:pre-pr` 第三步 MUST 產生六軸＋security review receipt（pre-PR mandatory gate，`devpro:pre-pr` Step 3 入口）；gate 本身不可豁免。
- `fresh` 觸發（獨立判斷）：security／runtime／hook／merge／release-gate 變更；post-PR cross-model second review 被豁免的 PR；主 agent 發現實作中的 security-sensitive 區段（SQL、auth、PII、crypto）；記錄的獨立判斷理由。
- 否則 TL-direct：receipt `reviewer_identity.executor_kind: tl-direct`，MUST NOT 充當任何要求獨立判斷的 contract；subagent 不可用時 fallback 仍須完成 receipt。

#### MUST dispatch host-appropriate second-opinion reviewer

- `devpro:pre-pr` Step 5.5（default-on cross-model second-opinion）→ **每次；豁免才跳過，豁免條件 SSOT 見 `code-review-cross-model.md`**
- Preferred path：second reviewer model family differs from primary host/generator family。
- different-family adapter 不可用、未授權、或使用者選 fallback 時，可用 same-family fallback；sticky / PR evidence MUST 標 `same-family fallback` + reason/provenance，且 MUST NOT 宣稱已取得 cross-model diversity。
- non-Codex primary host default → `devpro:second-review`（spawn Codex CLI）取得 different-family second opinion。
- Codex primary host default → `platform-adapters/codex-host-cross-review.md` 指定的 different-family adapter；若 fallback，才可用 `devpro:second-review` / `codex exec` / Codex-family reviewer，並標 same-family fallback。

#### MUST delegate 到 `dp-programmer`（條件式）

- outcome mandatory：實作碼與對應測試（unit / integration；OpenSpec tasks.md 個別 task 附 `implementation_plan` + `acceptance_criteria`）MUST 產生並通過 acceptance；executor 由決策序決定。
- admission 訊號（**同時滿足**時 TL **必須**做 dp-programmer admission，不得用 task shape 直接決定執行者）：1. dp-architect 已回傳完整設計方案（含 touch list、implementation 指引）；2. 待實作的 task 涉及 ≥2 個檔案的新增/修改。
- `fresh` 觸發：工作可 bounded 隔離、驗收明確，且淨隔離效益高於 handoff／重讀／協調成本（典型：大量 output 的測試／log／廣域讀，或需獨立 context 的實作 task 群）；同 `responsibility_id` 已有 thread → `continue`。
- 否則 TL-direct：TL 依 implementation_plan 實作並記錄判斷。任務需要「理解程式碼在做什麼才能寫」→ programmer；「照指令搬移/替換/執行」→ assistant。

下列豁免只表示可略過此admission，不改workflow mandatory role。

**豁免**（TL 可自己做）：
- 單一檔案、單次 edit 的小修改（<10 行）
- dp-programmer 回報 FAIL/PARTIAL 後的主 agent 介入修正
- subagent 不可用（fallback）


#### MUST delegate 到 `dp-assistant`（條件式）

核心判斷：**「需要判斷嗎？不需要且≥2步→MUST做admission decision；只有bounded responsibility、明確驗收與淨隔離效益成立才委派。」**

`fresh` 觸發：bounded responsibility、明確驗收與淨隔離效益同時成立；`dp-explorer` 只用於位置未知的 ≥3 區域 survey，已知 symbol 直接 grep。否則 TL-direct。下列為 admission 訊號（非 shape-only spawn authority）：

- **設計討論後的 spec 更新**：將「改哪些 spec 檔、改什麼內容」整理成明確指令，委派 dp-assistant 執行
- **Bulk 檔案操作**：讀/改 ≥2 個檔案的機械性任務
- **Codebase 探索**：grep/glob 找 symbol 用處、未知區域 survey
- **測試執行**：跑測試 suite 並摘要結果；含 dp-programmer 回報 OK 後的完整 regression suite
- **Mechanical refactor**：rename、move、find-and-replace（不含 extract function——需理解邊界，屬 dp-programmer）
- **Git 操作序列**：≥2步git寫操作是admission訊號；若可獨立驗收且handoff/重讀成本低於隔離效益，委派dp-assistant，否則TL執行並留決策。典型序列仍是`git add`+`git commit`或再加`git push`。
- **執行其他 `devpro:*` skill**：`devpro:init`、`devpro:setup-ci`、`devpro:sync-rules`、`devpro:security-scan`
- **版號 bump 流程（`chore/bump-v*`）**：步驟固定且無設計判斷 → 整包委派 dp-assistant，TL 僅驗收
- **Git 唯讀大輸出查詢**：`git log <range>` / `git diff <range>` 輸出預計 > 100 行時

#### 為什麼要委派：context token 效率

Subagent context是runtime-native：可能fresh、resume、recent-turn bounded fork或full-history fork，MUST NOT一律宣稱不繼承main history。委派可能降低main-thread context成長，但lineage total仍包含child input/output、handoff、duplicate read與回流；沒有當次usage evidence不得宣稱total token saving。已存在同responsibility_id的thread且未達換手條件時一律continue（同角色不同責任不得共用thread；thread key、開啟／合併／續作／終止與五類換手條件見 `model-delegation-threads-and-caps.md`）；新spawn必須明示minimum-sufficient mode。具體mode、one-shot override與experimental fork條件只由active runtime adapter承載；shared rule不複寫brand-specific矩陣。
