---
name: design-core
description: 乾淨簡單但是高效有用的設計 baseline——Karpathy 4 原則 + Token efficiency hard constraint + accident-prevention backstop carrier（結構化訊號 > command-intent regex 猜測）；觸發：所有設計決策（新建/修改 rule file / hook / AGENTS.md / 重要架構選擇 / 設計 enforcement gate）
---

# Design Core

## Overview

Design-core 為 cross source/consumer repo 的**上位 baseline**——「乾淨簡單但是高效有用的設計」的 operational definition。Karpathy 4 原則為行為層 baseline，Token Efficiency 為 hard constraint cross-cut 4 原則之上。既有 devpro leaf（rule-design-principles / code-simplification / anti-patterns-examples / testing-and-qa）為其 instances，**不重組**既有規則。

## When to Use

- 新建或修改 `.devpro/agent-rules/*.md` rule file 前
- 新建或修改 hook（`.devpro/scripts/hooks/*`）前（改既有 mechanical gate 的 trigger/extraction 時，另須依 `rule-audit-playbook.md` §Twin-Gate Sweep 盤點 same-family 孿生 gate）
- 修改 AGENTS.md 觸發索引或 §0 前
- 任何重要架構決策（capability spec 設計 / OpenSpec change scope / subagent invoke pattern）前
- design / code review 時作為 self-check 框架

Load-chain：rule/source governance 細節按需載入 `rule-design-principles.md`、`rule-file-template.md`、`agent-skill-governance.md`、`rules-consistency-checklist.md`；consequence 八維 → `change-consequence-assessment.md`；AGENTS.md 只 eager-load 本 entry leaf。

## Process

### Enforcement Metadata

本表限定 reviewer guarantee-ceiling design admission；其他條款沿既有 carrier。Packet 傳輸邊界的 fail-closed carrier 見 `review-guarantee-ceiling.md` 的 metadata。

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for design-admission semantics |
| Advisory | `code-review-checklist.md`／renderer shared checklist |
| Doctrine | `cooperative-only`：逐路徑 producer／consumer 核對由 TL／reviewer 判斷 |

### Architecture Ask First（listed boundaries；看 actual delta）

新增或超出已批准 listed architecture boundaries 時 MUST Ask First，並提出 **≥2 options**（含 minimal restoration/fix vs architecture change，以及不做／維持現狀若合理）。判定依據是 **actual delta**（真實變更面），**不是** bugfix／issue／chore 標籤——標籤 **不是** 豁免。只問「新／超出已批准 boundary」；已批准集合內的實作細節不因本條重問。

Listed boundaries 至少含：新 capability／跨 repo 義務、新 runtime／adapter／hook 載入面、新 merge／release／auth gate、新 durable state 機或不變量、新對外披露面、transaction、semantic carrier／SoR、auth／trust、durable persistence、cross-process／external protocol、externally consumed schema、canonical evidence root。細節與既有 Ask First 清單不互斥——本條是 **加法**。

Pointer：`ai-autonomy.md` Ask First；preflight M3。

### Scope/Value Pre-Write Admission

每個新 proposed delta 或 remediation batch MUST 在寫入前完成以下四欄，記在既有 change 記錄或本次對話；同一批次未變不重做，不另建狀態或收據。

- `approved_scope`：指向本次使用者核准的需求／決策；batch git 同意不等於新增需求授權。
- `actual_delta`：列出實際要改的責任面，以及新增的抽象、義務或架構 boundary；不得只用 bugfix／chore 標籤代替。
- `direct_user_value`：以現況差異或 repro 說明這次改動如何直接達成原驗收，或修正本次 delta 自身的安全／runtime correctness／既有 RED 有效性缺陷；這些範圍內修復屬直接價值，未來可能重用不是本次價值證據。
- `minimal_repair`：列出沿既有 carrier 修復的最小方案；若不夠，指出其無法滿足哪個已核准驗收及直接證據。

範圍內、有直接價值證據的最小修復可沿既有授權執行；已批准 boundary 內的實作細節不因本檢查重問。
超出 approved_scope 或缺 direct_user_value 證據時 MUST 在寫入前停止該 proposed delta，提出至少兩個方案（最小修復與架構擴張，合理時含維持現狀）交由使用者決定；不阻止可獨立完成的已授權修復。新 listed boundary 同時適用上節 Architecture Ask First。
MUST NOT 以「可能有用」、DRY、review finding 或既有 batch approval 代替新 scope 授權；例如只需修 active-only 測試路徑，不得自行擴成共用 resolver framework 與廣域 static lint。
本檢查為 cooperative-only；機械 guard 只鎖欄位、action-point 指標與極性，MUST NOT 把文字 regex、AI 自填紀錄或 presence PASS 宣稱為 scope／user value／architecture 的 semantic oracle。

### 1. 寫程式前先思考

跨模組、介面／ownership 尚未確定或反覆實作摩擦時，設計方法讀 `design-reasoning.md`；本 entry 不重述其閉環，不增加 lite artifact 義務。

Reviewer handoff 保證上限、finding 分類或必填輸出設計：先讀 `review-guarantee-ceiling.md` 的 `Review Admission Checklist`；新 review 評估輸出／TL consumer 接收：讀同檔 `Review Output Contract`。`pr-sticky`／`audit-only` validator 不代表 primary dispatch 覆蓋。

涉及大型測試 evidence／log 的保存設計，入庫前 MUST 依 `design-template.md`「大型測試證據的保存與第二審路徑」選定保存位置與審查路徑；不等 pre-PR builder 拒絕才補設計。

不要假設。不要隱藏不確定。呈現取捨。

- **明確說明假設**：如果不確定，就詢問，而不是猜測
- **呈現多種解讀**：當存在歧義時，不要默默替使用者做選擇
- **適時提出異議**：如果有更簡單的方法，就說出來
- **不確定時停下來**：指出不清楚的地方，並要求釐清
- **外部能力查證**：設計方案依賴外部平台 / API / SDK / 工具的某能力（欄位、參數、回傳、行為）時，先查官方文件 / schema / `--help` 確認該能力存在或不存在，再據此設計；禁止從「本地 code 沒用到」或「README 沒看到」反推「不支援」——absence of local usage ≠ absence of capability（負面推論謬誤）。取捨問使用者；客觀事實查官方。第三方套件選型的 4 步查證 SOP 見 `third-party-packages-licensing.md`（make-vs-buy）。

**檢驗標準**：每個被 AI 默默選擇的解讀都應 surface 為「假設清單」或「待確認項」。

### 2. 簡潔優先

用最少的程式碼解決問題。不要過度推測需求。

- 不要加入需求之外的功能
- 不為假想重用建立抽象；當前有價值的知識／政策邊界依 `code-simplification.md` 閱讀負擔判斷
- 不要加入未被要求的「彈性」或「可設定性」
- 不要為不太可能發生的情境加入錯誤處理
- 減少程式碼須同時保留契約並降低閱讀負擔，不能只憑行數決定重寫

**檢驗標準**：資深工程師會不會覺得這太複雜？如果會，就簡化。

### 3. 精準修改

只碰必須碰的地方。只清理自己造成的混亂。

- 不要「改善」旁邊的程式碼、註解或格式
- 不要重構沒有壞掉的東西
- 配合既有風格，即使你更偏好另一種寫法
- 注意到無關的未使用程式碼，可以提一下，但不要直接刪掉
- 改動造成孤兒程式碼時：刪除因你的改動而變得無用的 import / 變數 / 函式
- 不要刪除原本就存在的未使用程式碼，除非使用者要求

**檢驗標準**：每一行修改都應該能直接追溯到使用者的請求。

### 4. 目標驅動執行

定義成功標準。反覆驗證，直到達成。

將指令式任務轉化為可驗證的目標：

| 不要這樣做 | 轉化為 |
|---|---|
| 「加入驗證」 | 「為無效輸入撰寫測試，然後讓測試通過」 |
| 「修復 bug」 | 「撰寫能重現 bug 的測試，然後讓測試通過」 |
| 「重構 X」 | 「確保重構前後測試都能通過」 |

多步驟任務：說明簡短計畫 + 每步驟附驗證檢查。

**檢驗標準**：強而有力的成功標準 → LLM 獨立進行循環式執行；薄弱標準（「讓它可以運作」）→ 不斷釐清。

### Positive Executable Recipe First

Rule / adapter / workflow design MUST lead with a dispatch-ready positive recipe: exact command / flag / tool shape, carrier, cwd / execution surface, and proof source. If behavior depends on external CLI / tool flags, first confirm support through official docs, schema, or `--help` probe, then write the exact supported recipe. Negative constraints / blacklists are boundary guards only; 正向可執行 recipe 優先，負向只當邊界——they MUST NOT replace the happy path. If no probe-backed recipe exists, mark `recipe_unresolved` and stop before declaring dispatch-ready.

**依賴 shell 執行期行為的規則先實測**：規則的判定若依賴 shell 或外部工具的執行期行為（結束代碼、狀態變數是否沿用上一個指令的值、重導向或 pipeline 對成功判定的影響），文件與推論不算 probe：動筆前 MUST 在每個宣稱支援的 shell 實機跑出情況表（成功／失敗 × 原生程式／內建指令 × 先前狀態有值／沒有值），把表與 shell 版本記入 design 或 decisions；沒有實測的 shell 版本 MUST 明寫未驗證，不得寫成已支援。

**提案前自問（落地前 MUST）**：「下一個 AI 是否可照這條 positive recipe 執行，不需猜替代 flags？」

Writing-for-agents 機制分置（本檔不複寫 SSOT）：**context pointer**／**leading words** → `agents-md-maintenance.md`；**progressive disclosure／co-location** → `doc-split-and-dedup-sop.md`；**cognitive load** → `token-frugal-io.md`。

### Thin deep-module vocab（設計薄詞）

必要子集（各 ≤1–2 句；交叉 Ousterhout／Feathers）：

| 詞 | 含義 |
|---|---|
| Module | 可獨立理解／替換的單元 |
| Interface | 模組對外契約（愈小愈好） |
| Depth | 介面小、實作能力大＝深模組；反則淺 |
| Feathers seam | 使行為可測／可替換的**程式縫**（測試 seam／依賴邊界） |
| Adapter | 跨邊界轉接，不把實作細節洩進呼叫端 |
| Leverage | 小介面撬動大行為 |
| Locality | 變更影響應靠近定義處 |

**消歧（MUST）**：**Feathers seam ≠ OpenSpec Seams-first**。OpenSpec Seams-first＝提案／Ledger 展開前的**可觀測驗收面**確認（SSOT：`proposal-template.md`）；Feathers seam＝程式可測縫。兩者不得互相改名；文件遇「seam」歧義時 MUST 具名全稱。

### 5. Useful-Context Token Efficiency（usefulness 優先）

User value / usefulness 是最終裁判；token efficiency 是 hard constraint，不是犧牲可理解性的理由。有用且 load-bearing 的 clarity > token；無用、重複、低訊息密度內容 = 浪費 token。

- byte/token estimate 過才能寫進 always-loaded（rule / hook payload / AGENTS.md）
- on-demand 觸發載入 vs every-turn 注入成本對照（×N 對話輪數總成本）
- 規則互依（leaf A → B → C chain）數過深度才接受
- 不得為了過 cap 把核心規範壓成 AI 難理解／難執行的 shorthand；ordinary change **MUST NOT** hard-trim-for-cap valued semantics；先刪低訊息密度內容，不足時走 governance／調整 cap 並留下 rationale / guard
- **跨產出類型適用**：rule file / code / GitHub artifact（issue / PR / discussion / comment）/ commit message / hook 注入內容
- Cache-Friendly Design 依 `rule-design-principles.md` 執行：穩定 prefix 前置、變動 context 後置、稀有 leaf deferred-loading

**檢驗標準**（ordinary path soft/governance；integrity 仍 fail-closed）：
- AGENTS.md `agents-md-size.test.mjs`：10500 byte hard cap（soft-warn／governance；6500 soft）；≥80% `semanticReview=required` 為 **advisory-signal only**
- TL skill body / subagent reading list 用 `compliance-telemetry.mjs --reading-list` 採樣

### 6. Usability-First Principle

設計決策 MUST 以 user value 為首要 driver；ease-of-implementation 只能作為 tie-break，不能單獨成為 rationale。

**Self-check**：我推薦 X 的理由是 user benefit 還是 ease-of-impl？

評估 user value 時至少看 4 維：

| 維度 | 問題 |
|---|---|
| discoverability | 使用者是否更容易知道能力存在、何時使用 |
| consistency | 與既有 workflow / mental model 是否一致 |
| power | 是否真的增加可完成的工作，而非只讓架構更整齊 |
| mental-model | 是否降低誤解與錯誤期待 |

> _Anchor: 無法說明真實 user benefit、只是 ease-driven 架構潔癖的「全遷移」方案，本原則明示禁止。_

### 7. Accident-Prevention Backstop Carrier（結構化訊號 > intent 猜測）

設計 accident-prevention backstop（防 agent 在盲區做未授權破壞性動作的機械閘）時，**carrier 選擇先於文字內容**：behavioral 文字靠 agent「主動想起要查」，對「沒意識到這是決策點」的盲區結構性無效；唯一驗證有效的是 mechanical 攔截，但 carrier 必須建在**結構化訊號**上。

- **MUST**：建在結構化訊號——git-native hook 讀 git 協定 stdin（如 pre-push 的 per-ref `<local-sha> <remote-sha>`，all-zero local-sha = 刪除）／檔案系統狀態／結構化 tool payload 欄位。
- **MUST NOT**：用 PreToolUse **command-intent** regex 解析命令字串猜測意圖作 backstop——會累積 escaping/quoting/expansion edge case、成 monolith debt，注定變維護黑洞。
- **錨點**：branch-delete 的 PreToolUse command-intent regex gate（退役前代號「2g/11」）於 2026-06 因 command-intent regex 累積／monolith debt 退役並以 regression 鎖死（commit `450e1c2`）；遠端刪除改用 git-native pre-push hook（commit `49c7e62b`，讀結構化 git-protocol stdin，零 regex、host-agnostic）。

**提案前自問（落地前 MUST）**：「這條 enforcement 靠**結構化訊號還是 intent 猜測**？」後者不得提。此為 carrier 選擇通則，不保證每個危險動作都有結構化攔截點（無攔截點的誠實 gap 見 `git-branch-hygiene.md`「Local Delete 無 Git-Native 攔截點」：local `git branch -d/-D` 與 `git worktree remove` 無 git-native hook 點，只能靠 behavioral + 具名同意，不假裝有 mechanical backstop）。

### 8. Hook Runtime Cost Boundary

每輪必跑事件（UserPromptSubmit / Stop / PostToolUse / PreToolUse / SessionStart）hook 的每輪路徑若無界耗時，會撞 per-hook timeout（180s）→ output 被丟棄 → fail-open → marker 不清 → 下輪再逾時的 stuck loop。先按 hook 目的分兩類，再決定能否碰網路：**提醒類**（reminder，如 Recap 提醒——提醒不需精準）vs **gate 類**（enforcement，如 cross-model merge gate / post-PR completion——擋動作或驗證前置條件）。判準：擋動作 / 驗證前置條件才算 gate，其餘查詢一律歸提醒類。

- **MUST NOT**：提醒類 hook 的每輪路徑發任何網路呼叫（`gh api` / `gh pr list` / `git fetch` / `ls-remote`）——提醒用 local 訊號（marker / fs / local git）近似即可，最壞多提醒一次，不值得為精準付出無界網路耗時。
- **MUST**：gate 類 hook 的每個網路呼叫帶固定 per-call timeout（寫死 5s）+ fail-open（逾時放行 / 靜默，絕不 hang）；能 server-side 過濾就別線性掃全量，能 local short-circuit 就別每輪發。
- **MUST**：repo-owned hook launcher/wrapper（如 `.devpro/scripts/hooks/run-hook.mjs`）enforces a total child runtime timeout capped at 180s with fail-open on every host profile (only an explicit block decision on stdout blocks). Tests may lower the timeout via `DEVPRO_HOOK_TIMEOUT_MS`, but MUST NOT raise the cap above 180s. The 180s cap exists so a multi-archive post-archive gate can finish without `DEVPRO_HOOK_BYPASS=1`.
- **MUST**：上行的 5s 是單次呼叫的上限，不是整輪預算；Stop hook 可再以剩餘時間縮短它。Stop hook（`post-pr-completion-check.mjs`）另有整輪期限：協作期限 150 秒（marker 之間停手並列出未處理清單）與硬上限 165 秒（由外層監督程序強制結束 worker 並擋下），兩者都從 launcher 上限推導（`DEVPRO_HOOK_TIMEOUT_MS` 縮短時同步縮短），環境變數只能縮短、不能延長。hook 內部可另設比 launcher 更短、由外層子程序強制執行的硬上限，好讓阻擋訊息先於 launcher 的 fail-open 送出。細節見 `post-pr-completion-gate.md` §Time Budget。
- **錨點**：`checkDiscussionExists`（提醒類卻打網路查 416 筆 Discussion = 違反，正解改讀 local "recap-written" marker）vs `post-pr-completion-check` 的 `gh pr view` 帶 5s timeout + fail-open（gate 類正確示範）。mechanical carrier：`hook-runtime-cost-boundary-grep.test.mjs`。

**提案前自問（落地前 MUST）**：「這 hook 是**提醒還是 gate**？提醒類有沒有碰網路（有就改 local）？gate 類每個網路呼叫有沒有 5s timeout + fail-open？」

### 9. OS-Level Executable Contract

Source-managed scripts/hooks that are invoked directly by Git, shell, OS, or runtime launchers MUST satisfy the OS-level executable contract for the supported consumer surfaces, not only the language-level implementation contract. If the platform requires a fixed extensionless entrypoint name (for example Git `pre-push`), keep that entrypoint as the OS-portable launcher and put substantive logic in an adjacent extensioned implementation file (for example `pre-push.mjs`) as the single source of truth.

- **MUST**：設計時同時檢查 macOS/Linux/Windows 啟動面；Git for Windows、shell PATH、line ending、executable bit、固定 hook filename 都屬於需求，不是測試環境細節。
- **MUST NOT**：只因 `node <file>` 測試會過，就把 extensionless Git/runtime entrypoint 寫成 shebang-dependent implementation file，或讓 `.js` 檔取代 Git 需要發現的 extensionless 名稱。
- **提案前自問（落地前 MUST）**：「這個 source-managed script/hook 是被誰直接啟動？該 OS/runtime 看到的是 wrapper、implementation file，還是不存在的 extension？」

### 10. Environment-Dependent Gate Effective Scope

gate 的判定若相依下列任一觸發，則「這次實際檢查了什麼」是輸出的一部分，不能只由 exit code 承載：

1. **執行環境**（cwd / worktree / branch / session / host）—既有；
2. **diff base 解析失敗**（merge-base／`--branch`／range 不可解＝base 不可解）；
3. **副檔名／目錄掃描範圍與本次 diff 不相交**。

成功輸出 MUST 含**範圍描述＋實際檢查數**（或等價可觀測欄）。exit 0 有可辨來源——**檢查過且通過** vs **兩態空／未驗**——輸出無法區分時，呼叫端會把後者誤讀為前者而得到假的綠燈；被略過的對象仍留在原地，缺口延後到更貴的時點才爆。

**兩態 0／未驗輸出（對齊 whitespace `checked=false`）**：

- **base 不可解**（其實沒檢查）：MUST 輸出 `checked=false` 或 `not verified: base unresolved`（含嘗試過的 base／range）；**MUST NOT** 印成 `no applicable files`／`checked=0`／與「有檔通過」同形。
- **base 已解析且 0 檔或與 diff 不相交**（檢查過、沒有對象）：MUST 標記 `no applicable files`／`checked=0`／等價（例 whitespace `pass (no changed files vs <base>)`）；**MUST NOT** 與有檔通過同形。

- **MUST**：environment-dependent gate 因執行環境過濾掉本 session 已擁有／明確接手的待檢對象時，讓 effective scope、實際檢查數與期待位置可觀測；其他 session 的工作不屬提醒範圍，不列入 hook 注入清單。診斷檔可記錄排除原因，但不得據此宣告被排除工作通過。
- **MUST NOT**：用 exit code 單獨承載 effective scope，或把「範圍內沒有對象」的靜默 exit 0 當成已檢查的證據。
- **錨點**：`post-pr-completion-check` 先以穩定 session ID／明確接手選定 owned scope，再驗 PR；同分支不能取代 session ownership。缺 ID 或 legacy 無主 marker 僅留診斷，不自動提醒／阻擋；自己的未完成 PR 仍立即驗 gate。leaf 見 `post-pr-completion-gate.md` §Execution Location。Whitespace 的 `checked=false` 是本條未驗狀態的實例。
- **回報形態**：advisory 不改 exit code、不阻擋當前 turn；允許有界節流去重，但去重 key MUST 含執行位置（同一對象換位置＝新的 effective scope，不得沿用抑制），去重狀態 MUST 存在被檢對象之外以免污染其生命週期。是否升級為 fail-closed（含 0 檔是否 non-zero exit）由各 gate 自行裁決，本條只要求 scope 可觀測——**不**強制 0 檔一律 fail-closed。

**提案前自問（落地前 MUST）**：「這 gate 的判定會不會因 cwd / worktree / branch / session 改變檢查對象？diff base 算不出來時會不會變成 0 檔通過？掃描範圍與本次 diff 有交集嗎？兩態輸出（base 不可解 vs 空適用集合）分得開嗎？exit 0 的來源在**輸出上**分得開嗎？」

### 11. Mechanical Gate Threat Model（閘的威脅模型：依治理對象二分）

閘的威脅模型是**語料庫預設**，不是任何單一閘家族的私規。分界依閘的 **governance object（治理對象）**判定，**不依實作形式**——是 PreToolUse hook、git hook、CLI lint 或 workflow 步驟，皆與分類無關。

**原則（使用者裁示；provenance: user）**：閘與審查防的是 AI 正常工作中的**不小心**——漏步驟、寫錯 change／PR、作答前就寫紀錄、沿用舊紀錄、用錯寫法。AI **存心**偽造或刻意繞過不在威脅模型內：不為它加終端機限定、金鑰、簽章或要使用者親自操作的步驟，審查也不得以「AI 可能故意這樣做」為由判 WARN 或 Critical。唯一例外是下方 class two（產品安全與合規產出）：PII、憑證、attribution、產品安全、授權一出錯就收不回，維持 adversarial。依據：使用者 2026-11-09 裁示「我們是防止 AI 不小心犯錯而不是故意做錯」；class two 是否一併放寬，使用者 2026-11-10 選維持。

**class one（治理 AI 自身流程遵循）**：威脅模型為 accident／opportunism。對抗性 shell 等價寫法（`\cd`、`alias c=cd`、`pushd +N`、`$(… --flag)`、`--git-dir` 重導等 agent 正常不會產生的形式）**排除在威脅模型外**；只有對**自然發出的指令**產生 false-positive／false-negative 才可升 Critical，只靠對抗性寫法才能繞過的 bypass 最多 Suggestion，且不適用 whack-a-mole→Critical。**具名 8 條**（例示，不是封閉清單；未列者依下方 residual rule 判定）：

| governance object | 治理什麼 |
|---|---|
| `branch-and-worktree-placement` | 寫入動作落在哪條分支／哪個 worktree；分支命名 verb |
| `workflow-and-openspec-state-integrity` | change folder／clarification 契約／seams／batch-approval ledger／archive 時序／test-gate admission 等 agent 自身流程狀態 |
| `release-and-distribution-lane` | 分支基底／tag 形狀／merge 策略／版號車道／consumer 同步一致性 |
| `agent-run-cost-budget` | token／context window／測試 suite runtime 等單次執行成本 |
| `process-hygiene-reminders` | Recap／PR body／notes disposition／merge transparency 等提醒面 |
| `repo-scope-consent` | 跨 repo clone／branch／edit／commit 須有具名同意（AGENTS.md §0 第 6 條） |
| `destructive-ref-and-history-rewrite` | force-push、遠端／本地 ref 刪除、破壞性動作須走合規入口 |
| `second-review-admission` | merge 前是否真的取得跨 model family 的第二意見（admission 判定本身） |

**class two（治理產品安全與合規產出）**：維持 adversarial 威脅模型、fail-closed、缺陷即 Critical。以下為 **floor 而非窮舉**：

| governance object | 說明 |
|---|---|
| `document-and-payload-privacy` | OpenSpec doc／payload 內的 PII（Gate P）。**既有例外，原樣保留** |
| `attribution-and-brand-leak-compliance` | commit／PR／issue 文字 artifact 的 attribution 與 brand-leak。**既有例外，原樣保留** |
| `credential-and-secret-handling` | 憑證／secret 落入 repo 或外送。**既有例外，原樣保留** |
| `product-security-scanning` | injection class（SQLi 等）與 CodeQL 產品面安全。registry 內無對應 risk 值 |
| `licensing-compliance` | 第三方套件授權（copyleft 核准）。registry 內同樣無對應值 |
| `gate-visibility` | 其他閘的可見性／完整性。經下方 derived-class 規則判為 class two |

**Residual rule（三段，缺一不可）**：

1. **涵蓋面**：未列入上述兩表者、歸屬可爭辯者、以及新出現者，依治理對象的**性質**判定：治理產品安全或合規產出（PII、憑證／secret、attribution／brand、injection／CodeQL 等產品安全、第三方授權，以及保護上述物件之閘的可見性）→ class two；其餘治理 AI 自身流程遵循者 → class one。
2. **舉證責任**：落在**主張 class two 的一方**，須指出它保護的是哪一種產品安全或合規產出；指不出來就是 class one。「指不出」以看得到它管什麼為前提；審查材料連它管什麼、保護什麼都看不出時屬證據不足，不算 class one：審查寫明證據限制，不套 class one 上限（見 `code-review-cross-model.md`）。「AI 可能故意繞過或偽造」不構成 class two 的理由（本節原則）。
3. **修改路徑唯一**：增刪兩表的具名列須走**獨立 change** 修改本節；**禁**在使用該分類的 PR 內就地增刪。

**軸 B — fail open 或 fail closed 取決於「不確定性的種類」，與上述分類正交。**同一個閘可以兩個方向並存：`protected-branch-write` 對無法靜態解析的 cwd fail open，對畸形的 `apply_patch` payload fail closed。三問，**先命中先適用**：

- **問 1**：缺失或不可解析的東西，是否有**書面契約要求它此刻必須存在且可解析**？（payload 格式；先行義務產物如 sticky／footer／同意紀錄／`## Clarification State`／`## Seams Confirmation`；所依賴的持久紀錄如 PR data）→ **fail closed**。證據不存在，絕不可當成合規證明。
- **問 2**：否 → 它是否為**執行期環境性質**，且工具表面合法允許隱含不寫？（effective cwd、current branch、`$VAR`、`CDPATH`、目錄堆疊、`--git-dir` 重導）→ **fail open + advisory**。
- **問 3**：兩者皆非 → **fail closed**，並記為待分類缺口。
- **Tie-breaker**：放行之後，該義務是否仍能被獨立查核？若放行會消耗掉唯一的檢查點（merge／tag／commit／留言已經發生）→ **fail closed**。
- **具名非例**：`pre-tool-gate.mjs:5082` 的 "Ambiguous control flow stays fail closed" 是 resolver **內部**拒絕採信證據，其效果是**閘層 fail open**；**MUST NOT** 拿它當「class one 也 fail closed」的反例。

**軸 C 正交**：`BASELINE_GATE_IDS`（rigor-level 免疫清單）的成員資格與上述兩軸皆無關。該清單同時含 class one hard-block、class one advisory、以及 class two hard-block 三種成員。

**Derived class（meta 閘）**：治理對象為「其他閘的可見性／完整性」的閘，其 class **繼承所受保護對象中最強的一類**（取最強，不是取多數）。故 `gate-visibility` 屬 class two——`shellWrapperBlock()` 自陳的保護對象含 attribution。**Scoping**：對 meta 閘的 finding，僅在**能證明它繞過某個 class-two 物件**的範圍內算 in-scope，否則 whack-a-mole 會復發。

**No-downgrade**：分類只決定 **review scope 與 severity**，**不決定** enforcement 強度。「既然是 class one，這個 hard-block 可以改成 advisory」是被禁止的**推論形態本身**，不限於任何具名清單。採用本預設，對既有閘恆為**零行為 delta**。

**具名反濫用清單**（引用本預設前先自查是否落入其一）：

| # | 錯誤論證 | 反駁 | evidence |
|---|---|---|---|
| F-1 | 形式論證：「它也是個 hook／CLI，所以繼承 class one」 | 邊界由治理對象決定，不由實作形式決定 | 同一支 `pre-tool-gate.mjs` 內 `openspec-doc-pii` 與 `worktree-isolation` 分屬兩類 |
| F-2 | baseline 論證（雙向）：「它在／不在 `BASELINE_GATE_IDS`，所以是某類」 | 軸 C 與軸 A 正交；那是 rigor-level 免疫清單，不是 class 名單 | `hooks/lib/rigor-level.mjs` 的五員橫跨三種組合 |
| F-3 | 逃生口論證：「有 `DEVPRO_HOOK_BYPASS`／`--no-verify`，有意繞過者已有一級管道，所以 class one」 | escape availability 與 class 邊界**不重合**，只能當 class one 的佐證，不能當判準 | `gh-footer-gate.mjs` 吃同一個 bypass，仍是 class two |
| F-4 | fail 方向論證（雙向）：「它某處 fail open／它 hard-block，所以是某類」 | 軸 B 與軸 A 正交，同一物件可兩方向並存 | `protected-branch-write` 的 cwd 面 vs `apply_patch` 面 |
| F-5 | 鄰接類比：「同檔／同 registry／同命令表面的其他閘是 class one，所以它也是」 | class 由 governance object 決定，鄰接不構成分類；依 residual 第 1 段看治理對象性質，**禁**類比外推 | 同一 `git commit` 表面兩 class：`commit-attribution-version-mismatch`（`risk: release-integrity`，one）與 `commit-attribution-brand-leak`（`risk: compliance-attribution`，two） |
| F-6 | 沉默論證（雙向）：「列舉沒提到它，所以它是 class two（或 class one）」 | 兩表只是具名列；未列者依 residual 第 1、2 段看治理對象性質，主張 class two 須指出保護的產品安全或合規產出 | 本節 residual rule |
| F-7 | 新穎論證（雙向）：「這是新閘，先按 class two（或 class one）走」 | 新閘與舊閘同樣依 residual 第 1 段判定，不因新舊預設任一類 | 本節 residual 第 1 段 |
| F-8 | meta 論證：「它保護的多半是 class one 閘，所以它 class one」 | derived class 取**最強**而非多數 | `shellWrapperBlock()` 理由字面自陳保護 attribution |
| F-9 | 能力論證：「AI 用普通指令就**寫得出**這筆同意紀錄或 sticky、而閘擋不住，所以 Critical；要加終端機限定、金鑰、簽章或要使用者親自操作才能關」 | 依本節原則，class one 物件的嚴重度看 AI 正常工作中**會不會不小心**產生錯誤紀錄（作答前就寫、寫到別的 change／PR、內容與答覆不符、沿用舊紀錄、AI 自行推斷同意），不看 AI **能不能**故意寫出：會不小心產生而閘沒擋住的仍 **Critical**；只有存心才做得到的偽造不在威脅模型內，**MUST NOT** 據以判 WARN 或 Critical，也不得要求金鑰、簽章、終端機限定或使用者親自操作；存心混淆的寫法（例：跳脫序列編碼、ANSI-C 字串、非 `gh`／`curl` 客戶端直打 API（限該情境下並非例行做法者）、以跳脫序列改寫既有檔案後送出的 TOCTOU）最多 Suggestion，具名寫法僅為例示、非封閉列舉。class two 物件（含 attribution footer）不適用本列，維持 adversarial：AI 以**普通指令**（含 repo 推薦的 heredoc、先寫 body 檔再 `--body-file`）就做得到、而閘沒擋住的偽造仍 **Critical**。反向同理：class one 閘誤擋現行規則本來就允許的普通指令同屬缺陷，**MUST NOT** 為堵存心偽造或混淆而要求擋掉；現行規則是否允許依 review material、該閘自身契約或 repo 推薦寫法判斷，未顯示時只記 evidence limitation 與後續動作、不得據以要求擋掉；AI 能否在人類同意後代發核准由各閘自身契約決定；AI 代寫的同意紀錄「閘證明不了使用者真的作答」的結構殘留見下方通則 `consent-record-residual`，既有實例為具名殘留例外 `batch-scope-record-residual`（批次範圍紀錄）與 `per-pr-waiver-record-residual`（逐 PR 豁免紀錄，限開 PR 檢查會拿該行對照作答時紀錄者） | 本節原則與 class one 定義；PR #2927 C1／W1；PR #3492 使用者裁示 |
| F-10 | downgrade 論證：「既然是 class one，這個 hard-block 可以改成 advisory」 | 見 No-downgrade：分類不決定 enforcement 強度 | 本節 No-downgrade 條款 |

**F-9 通則 `consent-record-residual`（同意紀錄的結構殘留；非分類變更）**：AI 在使用者於對話中作答**之後**依答覆代寫、且使用時有閘檢查該紀錄（存在、格式、綁定的 change／branch／PR，或與 PR 行對照）的同意紀錄，沒有閘能證明使用者真的作答過。依本節原則，這項**結構殘留**最多 INFO，**MUST NOT** 升 WARN 或 Critical，也不得要求金鑰、簽章、終端機限定或使用者親自操作的步驟。**範圍**：只涵蓋這一項殘留——審查材料顯示沒問過或尚未作答、紀錄寫於作答之前、紀錄與答覆不符、紀錄屬於別的 change 或 PR，或 AI 自行推斷同意，屬不小心產生的錯誤紀錄，依 F-9 判定；使用時沒有任何閘檢查的紀錄不適用本通則，依 F-9 判定；class two 物件不適用。新的同意紀錄直接適用本通則，**不再**逐條開具名例外；下方兩個具名例外是本通則的既有實例，各自的封閉句只界定該例外自身範圍，不限制本通則。增刪改本通則須走獨立 change，並經使用者 merge 才有權威；審查範圍的 diff 新增、移除或改寫本通則條文本身時（未改動的句子只是落在被編輯的行上，不算），本通則在該次審查沒有效力，同意紀錄依 F-9 判定，如同本通則不存在；經規則同步取得本通則的 repo，自該同步 PR 合併後的下一次審查起才有效力。本通則只決定 review severity，不改任何閘的 enforcement（No-downgrade），不影響軸 B 問 1；reviewer 讀得到的載體是 packet static duty。

**F-9 具名殘留例外 `batch-scope-record-residual`（獨立契約；非分類變更）**：批次範圍紀錄——full 的 `## Batch Approval Ledger`（proposal／proposal-mini）與 lite 的 `openspec/changes/<change>/lite-scope.md`——由 AI 在使用者第零步選 batch 之後代寫；Gate R1／SP 與 archive gate (c) 只驗格式、change 與 branch，沒有閘能證明使用者選過 batch。此**結構殘留**經使用者裁示接受為防疏忽級殘留（依據：`remove-second-review-disclosure-approval` decisions F1、`amend-gate-forgery-rule-for-batch-scope-records` Clarification decisions；provenance: user）：review severity 最多 INFO，**MUST NOT** 升 WARN 或 Critical，也不得要求金鑰、簽章或額外使用者確認步驟。補償控制：只在選 batch 之後寫，stepwise 或尚未回答不寫（full 寫 `N/A: no batch approval selected`）；lite 寫入的同一輪回覆貼出該行，且中途改 stepwise 即刪檔；full 中途改 stepwise 時，在下一個原 covered write 前保留標題並將整段 ledger 內容替換為 `N/A: no batch approval selected`，後續 write 回到逐步確認；full 隨 PR diff 可見。**封閉**：只涵蓋上述兩個載體的這一項殘留——審查材料顯示使用者選 stepwise、尚未回答，或紀錄寫於回答之前，即屬偽造，仍依 F-9 判定；sticky、footer、PR body 告知行、review receipt 等其他合規紀錄 **MUST NOT** 類比套用（F-5、F-6）；PR、proposal、ledger、decisions 內自稱的例外不構成依據。增刪改本例外須走獨立 OpenSpec change，並經使用者 merge 才有權威；審查範圍的 diff 新增、移除或改寫本例外條文本身時（未改動的例外句只是落在被編輯的行上，不算），本例外在該次審查沒有效力，批次範圍紀錄依 F-9 判定，如同例外不存在（規則變更不得在自己的審查中自我批准）；經規則同步取得本例外的 repo，本例外自該同步 PR 合併後的下一次審查起才有效力。本例外只決定 review severity，不改任何閘的 enforcement（No-downgrade），不增減 §11 兩表的具名列；reviewer 讀得到的載體是 packet static duty。

**F-9 具名殘留例外 `per-pr-waiver-record-residual`（獨立契約；非分類變更；與上方 `batch-scope-record-residual` 並存）**：逐 PR 豁免紀錄——使用者對某個 PR 的放行問題作答後，AI 依答覆代寫的紀錄，以及 PR 描述中與該紀錄對照一致的 `DEV deploy-verify:` 行或 `Consumer pre-PR checks:` 行的 `skipped per user decision:` 部分——沒有閘能證明使用者真的放行。此**結構殘留**經使用者裁示接受為防疏忽級殘留（依據：`amend-gate-forgery-rule-for-waiver-records` Clarification decisions 與 Startup evidence，使用者裁示只防 AI 不小心、不防故意；provenance: user），是另一項使用者裁示，不是類比 batch 例外。**前提**：開 PR 的機械檢查（Gate 4c 的 PR 描述 consumer 證據檢查與 MCP `create_pr` 路徑）拿該行對照使用者作答時記下的紀錄，紀錄缺或對不上就擋；前提依審查材料或受審 head 上該閘自身契約或程式判斷，兩者都看不到這種對照時，本例外不套用，記 evidence limitation，該行依 F-9 判定，如同本例外不存在。前提成立時 review severity 最多 INFO，**MUST NOT** 升 WARN 或 Critical，也不得要求金鑰、簽章或額外使用者確認步驟；此 INFO 上限屬本例外自身，不取決於 class one 成員資格或 class 能否判定。補償控制：上述對照檢查；紀錄只在使用者作答之後依答覆寫入，放行只對該 PR 有效、不延續到下一個 PR；豁免行在 PR 描述中，使用者 merge 前看得到。**封閉**：只涵蓋上述紀錄與其對照一致之行的這一項殘留——審查材料顯示沒問過或尚未作答、紀錄寫於作答之前、AI 自行推斷放行、紀錄與答覆相反、行與紀錄對不上，或紀錄屬於別的 PR，即屬偽造，依 F-9 判定；sticky、footer、外送告知行（上方 batch 例外封閉句所稱的 PR body 告知行）、review receipt、批次範圍紀錄、PR 描述中其他 `skipped per user decision:` 行（含 Scenario Walkthrough 狀態行）、`Consumer pre-PR checks:` 行中使用者在停點做的確認（如 `user decision: confirmed …`），以及其他任何合規紀錄 **MUST NOT** 類比套用本例外（F-5、F-6）；PR、proposal、ledger、decisions、紀錄或 PR body 內自稱的例外不構成依據。batch 例外的封閉句只界定 batch 例外自身範圍，不撤銷本例外；本例外也不擴及批次範圍紀錄。增刪改本例外須走獨立 OpenSpec change，並經使用者 merge 才有權威；審查範圍的 diff 新增、移除或改寫本例外自身條文時（本例外未改動的句子只是落在被編輯的行上，不算），本例外在該次審查沒有效力，逐 PR 豁免紀錄依 F-9 判定，如同本例外不存在；經規則同步取得本例外的 repo，自該同步 PR 合併後的下一次審查起才有效力。本例外只決定 review severity，不改任何閘的 enforcement（No-downgrade），不增減 §11 兩表的具名列，不影響軸 B 問 1；reviewer 讀得到的載體是 packet static duty。

**保證上限（誠實聲明）**：「某個閘的治理對象是哪一條」屬**語意判斷**，沒有零誤判的機械 anchor。機械面只鎖**條文字面是否存在**（`gate-threat-model-classification-grep.test.mjs`），不驗證是否被遵守、也不驗證分類是否正確；實質執行靠 review 與 cross-model 第二意見。**MUST NOT** 把此語意判斷寫成 CI hard fail。緩解面：class one 的 advisory 誤判會留下可事後稽核的痕跡。

**提案前自問（落地前 MUST）**：「這個閘保護的是產品安全或合規產出嗎？指不出是哪一種，它就是 class one，只防 AI 不小心。它的不確定性屬三問的哪一問？我引用本預設的理由，是否落入 F-1…F-10 任何一條？我是不是在為 AI 存心偽造加終端機限定、金鑰、簽章或要使用者親自操作的步驟？」

> **Review 面應用（指向；非分類變更）**：本節 class 如何決定 reviewer finding severity，操作結論落在 `code-review-cross-model.md` 第二意見 scope 段與 renderer-owned packet static duties，並由 canonical requirement `Review Severity Aligns With Gate Threat Model Class` 承載。本節仍是 class 分類唯一 SSOT；該結論只決定 review scope 與 severity，不改變任何閘的 enforcement 強度（No-downgrade）。

### Agentic Workflow Layer Check（條件式）

當設計觸及 agent workflow、reviewer CLI、hook orchestration、write-capable tool surface、或多步工具 loop 時，proposal / review MUST 標記各層為 in scope 或 N/A：planner、executor、tool surface、state/checkpoint、error recovery、evaluator/reviewer、security/HITL。Write-capable tool 另須回答 allowlist、least privilege、quota/budget、audit trail、kill switch/stop path，以及 agent-generated justification 是否對 human approver 隱藏。這是薄檢查，不是新 architecture template；靜態文件或簡單 rule edit 可 N/A。長任務 agentic workflow MUST 並閱讀 `ai-autonomy.md` § Agent Runtime Protection 要求：bounded budgets、repeated same (tool, args/failure) detection、pivot/stop rules、retryable vs non-retryable taxonomy、max-turn faults。

### Hook-Injected Reminder Boundary

AI-injected hook reminders should tell the agent what it must do, not ask the user to choose. 設計 `systemMessage` / `additionalContext` hook reminder 時，必須把它視為 agent context：寫出 blocker、next AI action、owner / dependency；不要放 `1.是 / 2.否 / 3.其他`、`回 1`、或「要不要」這類直接向使用者發問的選項。若真的需要使用者決策，hook 只提示 AI 必須停下，assistant 回覆再依 `stop-point-comms.md` 產生 user-facing handoff。

### 與既有 devpro 規則的對應

design-core 為**上位 baseline**，既有 leaf 為其 instances（不重組既有規則）：

| Karpathy 原則 | devpro 既有 instance |
|---|---|
| 寫程式前先思考 | AGENTS.md §0 動手前十句自檢（subset：追溯性 / 複雜度 / 假設 / 委派）+ ai-autonomy.md Ask First |
| 簡潔優先 | code-simplification.md / anti-patterns-examples.md / ai-autonomy.md §動手前十句自檢 #2「配合未來擴充」反駁 |
| 精準修改 | tasks.md「Touch / Don't touch」+ commit 級別禁混 simplification + feature + code-simplification.md「git diff 逐行確認」 |
| 目標驅動執行 | tasks.md 品質要求（驗收條件可觀測）+ testing-and-qa.md TDD prove-it pattern |
| Token Efficiency | rule-token-budget.test.mjs / token-budget-precheck.md / agents-md-size.test.mjs |
| Usability-First | rule-design-principles.md 守則使用本檔作為上位 user-value baseline |

## Exit Criteria

- 4 原則自檢書面化於 design 決策（proposal / brd 中）
- Token Efficiency 估算過（byte/token + tier cap）
- 既有 leaf cross-ref 找得到（design-core 不重複既有 instance 內容，僅作為 baseline reference）
- 6-section H2 anatomy 完整

## Common Rationalizations

**「Karpathy 4 原則太通用，不適合 devpro 的特定流程」**
→ 4 原則是行為層 baseline，devpro 既有 leaf 為其領域特定 instances。design-core 不取代既有 leaf，只統一上位入口。

**「既有 rule-design-principles.md 6 Principles 就是 design-core，不需另開」**
→ rule-design-principles.md 6 Principles（Cross-Runtime Parity / Hook-Independent Routing / Leaf Self-Contained / Token-First（usefulness first）/ Cross-Platform Scripts / Hook Enforcement Alignment）是**source repo 治理層**——管 rule 怎麼寫；design-core 是**設計行為層**——管寫 rule 之前該怎麼想。兩層不同抽象。

**「Token Efficiency 已在 token-budget-precheck.md，不需重述」**
→ token-budget-precheck.md 是 mechanical 機制（estimate 公式 + tier cap + mitigation options）；design-core 把它 surface 為**上位 north star** + 跨產出類型約束（不只 rule，也含 GitHub artifact / commit / PR description / hook content），是不同抽象。

**「這條規則是規範本身，不適用 design-core」**
→ design-core self-applies——本 leaf 自身遵守 4 原則 + Token Efficiency（精簡 / 不重述既有 leaf / 4 原則名稱 grep 命中即可驗證）。

## Verification

```bash
# 4 原則名稱命中
grep -E "(寫程式前先思考|簡潔優先|精準修改|目標驅動執行)" .devpro/agent-rules/design-core.md

# Token Efficiency 段命中
grep -E "Token Efficiency" .devpro/agent-rules/design-core.md

# 與既有規則對應表 cross-ref 命中（≥ 4）
grep -cE "(rule-design-principles|code-simplification|anti-patterns-examples|testing-and-qa)\.md" .devpro/agent-rules/design-core.md

# 6-section anatomy
grep -c "^## " .devpro/agent-rules/design-core.md  # = 6

# Canonical token-budget gate
node --test .devpro/scripts/tests/rule-token-budget.test.mjs
```
