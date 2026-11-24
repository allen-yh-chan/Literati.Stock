---
name: rules-consistency-checklist
description: 規範一致性檢查清單：修改 rules / commands / agents 前後，驗證流程、術語、路徑、例外條款、能力假設、載入時機對齊（孤兒觸發點 / 載入鏈斷裂 / 雙時機耦合 / 觸發詞-索引不匹配）是否一致。
---

# 規範一致性 Checklist

## Overview

本清單用於防止 rules / commands / agents / AGENTS / README / scenarios 與 guard tests 漂移。流程調整時要確認：規範、入口、agent 行為、測試契約同步。

## When to Use

- 新增或修改流程規範
- 新增或修改 command / agent definition
- 修補已發生的規範衝突或執行卡關

## Process

### 1) 流程語意一致

- 同一流程在不同檔案的必要條件 / 例外條件 / 結束條件沒有矛盾
- 若某流程有 fallback（例如 anchor），需明確標註適用範圍與不適用範圍
- hotfix / bugfix / chore bump 等特例在權威檔與入口命令皆有相同描述

### 2) Command 入口對齊規範

- 規範新增 mandatory gate 時，對應 command 有實際步驟
- command 內 script：`node .devpro/scripts/...`；規範檔：`.devpro/agent-rules/...`。`.devpro-agent-rules/.devpro/...` 僅允許出現在首次導入 bootstrap（README / openspec-flow）與 `rules-flow.md`
- command 的 skip/exception 條件與規範一致（例如 bump 免六軸）

### 3) Agent 行為可執行

- 規範要求的前置條件（如 worktree、測試全套、交接狀態）在 agent definition 有明文
- agent 的「禁止事項」不與 command 的 mandatory step 衝突
- status vocabulary 僅使用 canonical 集合（finished / blocked / failed / questions / partial）

### 4) 術語與責任邊界

- 關鍵術語（TL、主 agent、可促進單位、anchor、旁路）在各檔案用法一致
- 判斷責任（誰決策、誰執行）明確，避免 AI/TL 混用語意
- 表格中的能力矩陣不把 runtime-dependent 能力寫死

### 5) 時序與補件規則

- 允許延後補件的流程（如 hotfix 24h）需定義：前提、時限、責任人、驗收輸出
- 上線流程若允許縮短驗證，需明示「可縮短但不可省略」的最低檢查包

### 6) 索引與可發現性

- 新增 rule file 後，AGENTS.md 觸發式載入索引**與** README.md §模組總覽 table 皆已新增對應 row（兩處皆有兜底測試：`agents-md-index-mapping.test.mjs` / `readme-module-table-coverage.test.mjs`；新建 leaf 時須在 proposal touch list 同列兩處，勿靠測試事後兜底）
- 交叉引用路徑可直接定位，不留「看某檔」但無 leaf 名稱的模糊引用

### 6.5) 載入時機對齊自檢

改規範時**必經**自檢以下 4 類載入錯配，**禁止**靠事後重審補抓。每改一個 rule leaf / AGENTS 索引 / agent / command / flow，逐項對照：

| 代號 | 錯配類別 | 偵測問句 | 修補方向 |
|---|---|---|---|
| LM-1 | **孤兒觸發點** | leaf `When to Use` 宣稱某情境觸發載入，但 AGENTS.md 觸發式載入索引無對應入口 → 規則寫了卻沒人載入 | 在 AGENTS 索引補 row，或修 leaf 的觸發宣稱使其與實際入口一致 → mechanical: `lm1-intent-alignment.test.mjs` |
| LM-2 | **載入鏈斷裂** | agent / command / flow 流程要求某 leaf 行為，但其 definition / step 未 require（讀取）該 leaf → 階段到了卻沒載入 | 在 agent definition / command step / flow routing 補明文 require（人工自檢）|
| LM-3 | **雙時機耦合** | 單一 leaf 同時混入「不同載入時機」的內容（如「開工前」紀律與「PR 前」紀律同檔），導致任一時機載入都帶入無關段落或漏載 | 拆檔，各時機獨立 leaf，掛各自的階段錨（人工自檢）|
| LM-4 | **觸發詞-索引不匹配** | leaf `description` / `When to Use` 的觸發關鍵字與 AGENTS 索引該 row 的「情境」關鍵字不一致 → 使用者用 leaf 的詞描述需求時索引無法命中 | 對齊兩處關鍵字（以 leaf 的實際觸發語意為準）（人工自檢）|

> **Root-cause（為何要主動自檢）**：AGENTS.md 觸發式載入索引是「關鍵字反應式」router，不是「階段錨定」載入器——只有當使用者輸入命中索引關鍵字才載入對應 leaf。因此「動手前」「PR 前」等**階段性紀律**的 leaf 容易變孤兒（規則寫了，但該階段到來時沒有任何索引關鍵字觸發載入）。對策：階段性紀律必須掛在 **always-loaded 階段錨**（如 AGENTS §0 動手前十句自檢、`openspec-step-1-to-9.md` 各 step、agent definition「開工前」段），不能只靠關鍵字 router。範例：`pre-implementation-over-design.md` 的開工前 over-design 自檢已同時錨在 openspec-step-1-to-9 Step 3a/5 + dp-programmer §開工前 + AGENTS 索引 row（PR #992），即為 LM-1 的正確修法。

### 7) Mechanical Guard 同步

- 新增 rule file 後，同步更新 rule anatomy / token budget 相關測試契約
- 規範文字改名或改語意時，同步更新 `scenarios/*.md` assertions
- README / AGENTS / template / scenario 內的 quick reference 也納入一致性檢查
- 對舊語句做負向 grep，確認沒有 stale wording 殘留

### 8) Violation Taxonomy

發現違規時依下表分類並記錄。

| 類別 | 代號 | 定義 | 常見觸發情境 |
|---|---|---|---|
| **Routing** | VT-R | 意圖未分類或路由錯誤 | 未分類就直接改 |
| **Gate** | VT-G | 未過 Gate 即跳下一階段 | 未完成 Spec 就 Build |
| **Approval** | VT-A | 未同意先執行 Ask First 操作 | 未問就 push / 裝套件 |
| **Scope** | VT-S | touch 外改動或混入不相關任務 | 順手改旁邊檔案 |
| **Reporting** | VT-P | 違規後未依規回報 | 靜默繼續、不列規則 |

**記錄格式**：`[VT-<代號>] 場景 / 觸發規則 / 預期行為 / 實際行為 / 修補提案`

每週統計各類別次數；連兩週重複者優先修補。

## Exit Criteria

- 變更內容已通過 Checklist 第 1-7 節（含 6.5 載入時機對齊：LM-1 孤兒觸發點／LM-2 載入鏈斷裂／LM-3 雙時機耦合／LM-4 觸發詞-索引不匹配）
- 發現衝突時，已在同一 PR 內同步修正 rules + commands + agents
- AGENTS 索引與 README §模組總覽 table 皆已可導向新規範
- 相關 mechanical guards 已同步且 source repo 測試全綠

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「只改一個 rule file 就好」 | 流程規則通常同時影響 command / agent / AGENTS 索引；不查就會 drift。 |
| 「入口命令會自己懂」 | command 只會照文字執行；mandatory gate 必須在入口明文落地。 |
| 「測試只是字串比對，不用改」 | scenario / anatomy / token budget 是 source repo 的契約；文字改了但 guard 沒改，本機驗證會紅或失去保護。 |
| 「載入錯配事後重審再抓就好」 | 孤兒觸發點 / 載入鏈斷裂在「規則寫了但沒載入」當下不會報錯，靠記憶事後重審必漏；§6.5 LM-1～LM-4 是改規範時的前置 gate，不是收尾掃描。 |

## Verification

```bash
# 1) 檢查新規範是否加入索引
rg -n "rules-consistency-checklist\.md|<new-rule-file>" AGENTS.md

# 2) 除 rules-flow.md 外，不得出現 devpro-agent-rules/.devpro（本檔自排除）
rg -n "devpro-agent-rules/\\.devpro" .devpro/agent-skills .claude/agents README.md scenarios .devpro/agent-rules/*.md | rg -v "rules-flow\\.md" || true

# 3) 檢查 agent 定義是否出現關鍵前置條件（例：worktree）
rg -n "worktree|shared worktree|開工前" .claude/agents/*.md

# 4) 快速掃描可能衝突詞（例：hotfix、bump、六軸、例外）
rg -n "hotfix|bump|六軸|例外|mandatory gate" .devpro/agent-rules/*.md .devpro/agent-skills/*/*/SKILL.md

# 5) 掃 stale wording（依本次改動替換 pattern）
rg -n '從 anchor 新開 `hotfix|hotfix/.+<anchor-sha>|anchor/production tag|工作分支未從 anchor 建' AGENTS.md README.md .devpro/agent-rules scenarios .claude | rg -v 'rules-consistency-checklist.md'

# 6) 載入時機對齊自檢段存在（§6.5 LM-1～LM-4）
rg -n "載入時機對齊自檢|LM-1|LM-2|LM-3|LM-4" .devpro/agent-rules/rules-consistency-checklist.md

# 7) 跑 PR 範圍的 source repo guard（完整 unit＋本 PR 改到的 integration；範圍 SSOT `test-suite-cadence.md`）
# commit 後執行：它讀 `main...HEAD` 的已提交差異，未提交的變更不會被選到，分支尚無 commit 時會退回完整 integration；commit 前先跑 `--tier unit`。governance／release 的全量要求不變
node .devpro/scripts/run-test-suite.mjs --changed main
```
