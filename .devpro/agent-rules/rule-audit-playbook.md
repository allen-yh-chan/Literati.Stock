---
name: rule-audit-playbook
description: rule corpus 定期 audit 的執行方法論（Cadence / Signal prioritization / Disposition / 風險分級 / Fan-out）。觸發：審查/盤點/rationalize rules / rule corpus 治理 / rationalization audit。
---

# Rule Audit Playbook

## Overview

本 leaf 定義 rule corpus 定期 audit（rationalization cycle）的**執行流程**。audit = 把**全部 design 判準**（6 Principles 設計合規 + ROT 三維內容品質 + LM-1~4 載入對齊）套到既有 corpus 跑一遍。判準（ROT 三維 / dedup 三分類 / Hook-or-Don't-Add / LM-1~4 / 6 Principles 違反訊號）全部是設計層 SSOT，見 `rule-design-principles.md`；本 leaf 不複述判準，只說明「如何執行審查」。

## When to Use

- 執行 rationalization audit checkpoint 時
- Cadence 觸發條件達成時（見 §Cadence）
- 對 rule corpus 做盤點/整理/治理時
- 受委派執行 corpus-level audit agent 任務時

## Process

### Cadence（何時開審，不是何時開 change）

Cadence 僅適用 proven source repository；proven consumer 必須跳過 source cadence。下列任一達成 → 啟動 **audit checkpoint**；不得預先建立或選定 B-mini／其他 change，也不得預先建立對應分支或 OpenSpec artifact。audit 完成 inventory、回源、Disposition 與風險分級後，才知道是否存在可交付 delta：

1. migration epoch 後，自上次 relevant rationalize archive 累積 ≥ **5 個 chore B**；只計 introduction diff 可證明 bounded source rule-corpus governance action 的 relevant full archives
2. 距上次 rationalize ≥ **5 個 minor bump**（production tag 計數）
3. AGENTS.md byte count ≥ **6300**（SOFT cap 6500，buffer 200；HARD soft-warn／governance，ordinary path 不因 HARD alone fail closed）
4. 任一 leaf rule token cap 占用率 ≥ **75%**（warning 警戒；ordinary PR 不因 over-cap alone 硬擋）
5. rule-feedback／eligible pending 累積（open `[rule-feedback]` issues **或** eligible provenance-clean session-pending 有未收斂候選；消費流程見 `rule-self-evolution.md`）

**觀察機制**：`pre-pr-archive-gate.mjs` check (f) 是 proven-source warn-only reminder；proven consumer 跳過。只有觸發 1 自動計數，且只計 unique-parent introduction diff 證明的 bounded source governance action。Identity、epoch locator、history 或 parentage 不確定時輸出 non-blocking `indeterminate` advisory，不得計數、reset、宣稱低於門檻或 exit 1。只有 relevant archive basename 的 token-boundary `rationalize` 可 reset；dry audit 不建立 marker。觸發 2-5 為文字檢查清單。**corpus-dup 債觀察口**：同一 cadence 順帶觀察 corpus-dup 債；不是第 6 條平行軌道、無新 auto-threshold。紀錄門檻見 `dry-ssot-corpus.md`。

**Token-budget MUST-scan（governance ownership）**：audit-only／convergence **MUST** 掃 token budget／cap pressure（rule-file utilization/over-cap、`AGENTS.md` HARD、`cap-pressure=over`／`utilization > 1`）。Repair **accepted-finding-only**（拆檔／trim／提 cap／override）。Ordinary change **MUST NOT** hard-trim-for-cap valued semantics。

#### Audit outcome 與 static signal re-arm

- **零 accepted finding**：結束為 **dry audit**，向使用者回報 inventory、evidence 與 Disposition；不得建立空 change/PR 只為重設 reminder。因無 repo marker，warn-only 提示日後可以再次出現；**重複 reminder 不是 audit 未完成**，也不是強制 PR 的證據。
- **有 accepted finding**：只有 accepted finding 才建立 change。無 capability semantics 的 doc-only edit → chore A；低風險、同主題且有 observable delta → 可用 B-mini；normative、中高風險、multi-file gate 或其他非 mini 工作 → 各自獨立 full chore B，不得混入 rationalization B-mini。
- **靜態訊號 #3/#4**：Keep／調 CAP 等 Disposition 已存在，且**相關內容與 CAP 都未變**時，不得僅因 level threshold 仍為真就重開 change。只有相關 source/CAP 改變、占用率**跨越下一個適用的 warning / failure boundary**（例如 80%／100%），或 #1/#2/#5 事件／backlog 訊號啟動新 audit 時才 re-arm 並重評。

### Batch-approved rationalization change continuation + token red

rule rationalization / rule-feedback audit 已接受 finding、選定同名 change 且有 `batch approval` 時，流程不得退回逐步確認；TL 直接串適用的 OpenSpec 路徑 → 實作 → 測試/驗證 → archive → push/PR → post-PR cross-review。只在 out-of-scope、high-risk normative、scope ambiguous、merge/release/tag/destructive、cross-repo write、user-only decision 停下。若 actual touched carrier utilization ≥80%，依 `token-budget-precheck.md` 的 production result 標示 `semanticReview=required`（**advisory-signal only** on ordinary PR；本節屬 governance accepted-repair 路徑，cold-read actual carrier）。proposal 不承載 token evidence。先 trim low-info prose / trigger-load cold detail / split scope，並保留 load-bearing clarity；`cap/tier override` 是 last resort，但其他 mitigation 會損失 load-bearing clarity 時，必須依最小必要公式提高 CAP 並同步 mechanical guard，不得用難讀 shorthand／hard-trim-for-cap 迎合 CAP。

### Scope（每輪固定 4 task）

1. **SSOT dedup**：grep 跨檔重複 anchor 字串，集中到單一 SSOT，其他改 anchor-link
2. **Orphan resolution**：`AGENTS.md` 觸發索引未涵蓋之 rule files → 加索引或 merge into existing
3. **Hook-or-Don't-Add audit**：自上次 rationalize 累積之 cooperative-only 規範 → hook-ability matrix 評估，可升 mechanical 的升級（判準見 `rule-design-principles.md` §Hook-or-Don't-Add 守則）
4. **Dead reference cleanup**：grep 全 repo file basename，找已 deleted/renamed 檔之殘留引用

### Twin-Gate Sweep

修改某 mechanical gate 的 trigger 偵測或 arg/body extraction 時（不限定期 audit，任何 gate change 皆適用），MUST 先盤點 `pre-tool-gate.mjs` 內結構孿生（same-family）gate —— 共用 trigger 形狀、共用 extraction helper（`BODY_FILE_RE` / `gateCommandSegmentText` 等）、或互 cite 為 precedent 者（例 Gate 4b `checkRecapBodyLint` ↔ Gate 4c `checkPrBodyTemplateLint`）—— 判斷同類缺陷是否也存在於孿生，並在同一 change 或明確記錄的 follow-up 一起處置。只修一個會留同形漏洞、下次才爆（PR #1182 修 Gate 4c trigger filtering → PR #1183 才補 Gate 4b 同類 raw-cmd trigger 缺陷）。盤點結論（無孿生／已正確／需同步修）MUST 寫進 proposal 或 PR，不得 silent 略過。孿生不必同解：trigger 是 command verb（可 segment-filter）vs quoted data（不可直接 filter）等差異 MUST 個別判斷，勿假設「mirror 既有 gate」就對（PR #1183 cross-model evidence）。

### Inventory → Audit 分層

先列「有什麼」再評「好不好」，禁跳過 inventory 直接評：

1. **Inventory**：file-role ledger（逐檔 file / role / routing trigger / classification）——格式見 `doc-split-and-dedup-sop.md` §Split/Dedup Audit Output
2. **Audit**：對 inventory 結果逐 leaf 套用**三組視角**（訊號 pointer 見下表，判準全部見設計層 SSOT）

#### 視角 A：設計合規（6 Principles）

逐 leaf 套用 6 Principles 違反訊號；違反訊號判準見 `rule-design-principles.md` §6 Principles，本 leaf 0 複述。

| # | Principle | 判準 SSOT（cross-ref）|
|---|---|---|
| 1 | **Cross-Runtime Parity** | `rule-design-principles.md` §6 Principles row 1 |
| 2 | **Hook-Independent Routing** | `rule-design-principles.md` §6 Principles row 2 |
| 3 | **Leaf Self-Contained** | `rule-design-principles.md` §6 Principles row 3 |
| 4 | **Token-First（usefulness first）** | `rule-design-principles.md` §6 Principles row 4 |
| 5 | **Cross-Platform Scripts** | `rule-design-principles.md` §6 Principles row 5 |
| 6 | **Hook Enforcement Alignment** | `rule-design-principles.md` §6 Principles row 6 |

#### 視角 B：內容品質（ROT 三維）

| 維度 | devpro 訊號 | 判準 SSOT（cross-ref，不複述）|
|---|---|---|
| **R** Redundant | 跨檔重複 anchor 字串 | `doc-split-and-dedup-sop.md` §Split/Dedup Audit Output |
| **O** Obsolete | 孤兒觸發點、dead reference | `rules-consistency-checklist.md` §6.5 LM-1~LM-4 |
| **T** Trivial | cooperative-only（marginal ~0）| `rule-design-principles.md` §Hook-or-Don't-Add 守則 |

#### 視角 C：載入對齊（LM-1~4）

孤兒觸發點 / dead reference / 觸發詞不匹配 / 載入時機耦合；判準見 `rules-consistency-checklist.md` §6.5 LM-1~LM-4。

### Signal-based Prioritization

devpro 無 traffic data，用等價訊號排序（高頻載入 + 高違規 + 高 byte 的規則優先審）：

| 訊號 | 說明 |
|---|---|
| load-frequency | always-load §0 > on-demand 索引 > orphan |
| violation-rate | hook 攔截次數（pre-pr-archive-gate 等 gate 記錄）|
| byte-cost | always-load 檔每 session 付 token |
| rule-feedback | open `[rule-feedback]` issue pool **與** eligible provenance-clean session-pending 未收斂候選（見 `rule-self-evolution.md` 消費 SOP；禁源／unknown 永不 batch-now）|

### Disposition 四分類

每個 finding 標一個，決定後續行動：

| Disposition | 行動 |
|---|---|
| **Keep** | 保留，無需改動 |
| **Modify** | 改寫 anchor、收窄觸發詞 |
| **Merge** | dedup 到 SSOT（限設計層判準允許之 duplication 類型，見 `doc-split-and-dedup-sop.md` §Split/Dedup Audit Output）|
| **Delete** | 移除孤兒/死路由 |

### 風險分級（決定可否進同一 B-mini）

| 風險 | 特徵 | 處理 |
|---|---|---|
| **低** | 索引 prose 編輯、補 row（零 SHALL）| 可進同一 B-mini |
| **中** | 收窄觸發詞、leaf frontmatter | defer，記下輪 |
| **高** | 碰 normative SHALL prose、跨 ≥3 檔、hook 升級 | 各自獨立 chore，禁混進 B-mini |

一輪 B-mini 只收低風險同主題 findings；中高風險 defer。

### Fan-out 執行

corpus > ~30 檔時分組平行審（一組一 agent，各跨三維度，帶 AGENTS 索引 cross-file context），再 synthesize 成單一 prioritized ledger。synthesize 前 MUST 對每個 agent finding 逐項回源核對、駁回誤報（見 `multi-agent-handoff.md` §Finding Verification）——audit agent 誤報率高（把合規 load-chain sibling 誤判孤兒等），未回源即進 ledger 會污染整輪 disposition。

**Findings artifact 路徑規則**：落 change folder 時路徑必 repo-relative（agent 回傳常含絕對 worktree 路徑；commit 前 strip 前綴——絕對路徑入 repo 違 §0 Never 禁路徑，且 Gate P 不掃 `.json`，靠 dedup/reviewer 兜底）。

### 成熟 corpus 的 sim FP taxonomy（Fan-out 回源時套用）

成熟 corpus（坑已填多輪）上 sim fan-out 的 false-positive 率**近 100%**（convergence-loop Round 1–4 實測：~48 sim finding 僅 1 confirmed，且該 1 條出自機械掃描非 sim）。Fan-out 回源核對時 MUST 先問「這是不是下列四類系統性 FP」——**命中即駁回，不進 ledger**；每類附一個「先確認 X」動作，讓 TL 做出駁回動作而非只認得現象：

| # | FP 模式 | 先確認 X（駁回判準）|
|---|---|---|
| ① | **責任分層**誤判為缺實作（看到 A 沒做某事 → 喊「沒人做」）| 先確認該職責是否由**他檔／他層**承擔（transport 層 vs 決策 gate、helper vs caller）|
| ② | **跨檔正交條件**誤判為衝突（A 說往左、B 說往右）| 先確認兩條件是否**互斥情境、不同時**發生（不會同時觸發＝各自都對）|
| ③ | **統一設計共用步驟**誤判為缺步（B 流程沒單獨寫該步）| 先確認是否**刻意共用同一份**、非各寫一遍（共用 ≠ 缺）|
| ④ | **原則式判準**誤判為缺決策樹（規範給原則不給流程圖）| 先確認是否**本應靠原則裁量**、非窮舉決策樹（有些判斷不該也無法窮舉）|

**配置推論（邊際遞減）**：成熟 corpus 應**減 sim** 編制、把力氣移**機械掃描**（客觀比對如跨檔常數同步、dead-ref、token cap 優於 sim 判斷）；真 actionable 多出自機械維度非 sim 幻覺。

## Exit Criteria

- Inventory file-role ledger 已輸出（禁跳過直接評）
- 每個 finding 已標 Disposition（四分類之一）
- Cadence signal 與 change creation 已分離；dry audit 無 accepted finding 時未建立空 change/PR
- #3/#4 的既有 Disposition 已檢查 source/CAP 變化與 re-arm boundary，未以 unchanged level 重開 change
- 風險分級已標；高風險 findings 已 defer 獨立 chore，不混入 B-mini
- Fan-out artifacts 路徑 repo-relative（無絕對路徑）
- B-mini scope 只含低風險同主題 findings

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「先跳過 inventory 直接審 findings 比較快」 | 沒有 inventory 就沒有完整視角；遺漏 file-role ledger = 遺漏 fallback leaf 等結構性 findings |
| 「Cadence 達門檻，就先開 B-mini 再看有什麼能改」 | signal 只證明需要 audit；無 accepted delta 就沒有 change，禁用空 PR 重設 reminder |
| 「同一靜態門檻還在，所以前次 Keep／CAP disposition 無效」 | unchanged level 不是新 evidence；只在 source/CAP 改變、跨下一 boundary 或事件型 signal 啟動新 audit 時 re-arm |
| 「這個 finding 改動不大，可以進同一 B-mini」 | 風險分級是 SHALL；碰 normative prose = 高風險，必須獨立 chore |
| 「ROT 或 6 Principles 判準在這裡也說一遍，比較方便」 | 複述 = 製造 SSOT drift；設計層判準只有一個出處，見 `rule-design-principles.md` §ROT 設計判準 / §6 Principles |

## Verification

```bash
# Signal-based prioritization 存在
grep -n 'Signal-based' .devpro/agent-rules/rule-audit-playbook.md

# Disposition 四分類存在
grep -n 'Disposition' .devpro/agent-rules/rule-audit-playbook.md

# Fan-out 執行存在
grep -n 'Fan-out' .devpro/agent-rules/rule-audit-playbook.md

# Cadence 觸發條件存在
grep -n 'Cadence' .devpro/agent-rules/rule-audit-playbook.md

# 正向驗收：6 Principles pointer 命中（作為 audit 維度 pointer，不是複述違反訊號）
grep -n 'Cross-Runtime Parity\|Hook-Independent Routing\|Leaf Self-Contained\|Token-First\|Cross-Platform Scripts\|Hook Enforcement Alignment' .devpro/agent-rules/rule-audit-playbook.md

# 負向驗收：違反訊號具體內容 0 複述（判準只在設計層 SSOT）
# 用驗收腳本或人工確認：rule-design-principles.md §6 Principles 違反訊號欄內的具體描述
# （如 POSIX-only built-ins 指令名、chain ref 箭頭寫法、hook inject 措詞）
# 均不應以 prose 形式出現在本 leaf；pointer 表只列 Principle 名稱 + row ref，不列訊號內容

# 判準定義 SSOT 在設計層（負向驗收：dedup 三分類定義短語應不在本檔複述）
# 見 T-AUDIT-LEAF 驗收：proposal.md §Section 1 item 3
```
