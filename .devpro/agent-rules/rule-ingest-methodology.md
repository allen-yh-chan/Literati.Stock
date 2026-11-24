---
name: rule-ingest-methodology
description: 引入外部 reference / 業界框架 / 標準至 devpro rule corpus 的方法論（來源可信度分層 / Ingest-Mapping Ledger / 映射相容性）。觸發：ingest 外部 reference / 業界方法 / 標準 / 研究框架至 devpro rules 時。
---

# Rule Ingest Methodology

## Overview

本 leaf 定義將外部 reference（業界框架、標準、研究論文）ingest 進 devpro rule corpus 的執行方法論。核心問題：哪些外部概念 devpro 已有對應？哪些需要適配？哪些可直接引入？Ingest 前未做此評估 = reinvent 已有規則或引入衝突假設（cycle 4 ROT ingest 教訓）。

Ingest 形成來源理解、機制映射、改善價值與相容性證據。後續採納 verdict 與落點判斷交給 `knowledge-digest.md`；採納項要壓成最小可執行 carrier 時，再交給 `knowledge-distillation.md`。

## When to Use

- 引入業界框架（如 content-audit ROT、測試方法論、設計模式）至 devpro rules 前
- 引用標準文件（ISO / RFC / W3C）作為規範依據時
- ingest 外部研究論文或技術部落格的方法論時
- 評估是否採用新業界最佳實踐時

## Process

### 來源可信度分層

根據來源類型決定 ingest 前所需的驗證力度。優先 **primary-source**；中／低可信須交叉驗證後才可 ingest。採納判斷與 **cited durable** 落點仍交 `knowledge-digest.md`——**禁只摘要**當 ingest 完成宣稱。

| 層級 | 來源類型 | 舉例 | 處理 |
|---|---|---|---|
| **高可信** | 正式標準、同儕評審 | ISO/IEC 標準、IETF RFC、ACM/IEEE 學術 paper | 可直接參考；仍需做映射相容性評估 |
| **中可信** | 業界多來源交叉 | 多家大型工程 blog 一致實踐（如 ROT content-audit）、OWASP 等社群標準 | 需 ≥2 獨立來源交叉驗證再 ingest |
| **低可信** | 單一部落格、個人意見 | 單篇技術文章、單一 repo README | 需交叉驗證後才可 ingest；優先找更高層來源 |

**Exact identifier 核對（MUST）**：env／settings 鍵名、CLI flag、函式符號等 exact identifier，MUST 對原始來源逐字核對（raw 文件 curl＋grep，或 binary `strings`）；WebFetch／摘要模型的輸出只是線索、不是證據（本 repo 已兩度出現摘要捏造 host CLI 設定鍵名）。

### 來源理解與機制比較（cooperative-only）

去重前先理解來源如何達成目標。依問題範圍讀入口、主要流程與影響判斷的配套（如被引用的 prompt、範例或實作），說明核心方法、方法間的關係、重要取捨與尚未查明之處；只列主題或讀過的檔案不代表完成理解。閱讀深度依判斷所需證據決定，不要求整庫逐檔讀完。

先依來源自己的目標、分類與主流程，在既有 digest／ledger 建立方法圖譜，保留各主軸如何運作及彼此關係；再對照 Devpro。不可先以現有章節或「缺少哪些工具」篩選來源，讓不易列為缺口的主軸消失。收尾以來源入口核對：主要主軸都有比較理由，或明示其未完成範圍；揭露未讀材料不等於完成使用者要求的主要分析。

比較單位可以是概念、操作機制或整體工作流程。逐項比對目標、觸發條件、執行／決策方式、產物、驗證與失敗後回饋；單項原則都有對應時，仍須檢查它們的組合、順序或回饋是否帶來實質差異。現況查證沿用 AGENTS.md 的 Intent Lookup Order 入口，不得把規範寫了什麼冒充實際執行成效。

`keep-existing` 必須有來源與現有對應的機制等價或現有更強證據，且來源的重要效益已被涵蓋；同名、相似標語或一條相關規則不足以成立。材料不足時先標明待查內容，不作已完整涵蓋的終局判定。比較證據與覆蓋缺口可放既有 ledger 備注或 digest，不另建平行產物。

先評估對使用者與接手者的改善價值，供後續 digest 決定採納與落點；既有 SSOT 可以被補強或重做。去重約束落地方式，不是提前排除改進的理由；建議數量、讀檔數量與新增條文數量都不作價值指標。本節的理解與等價判斷依來源／現況證據及行為評估驗收，機械 anchor 不代表語意已證明。

最終比較須讓讀者看懂來源的核心目標、品質判準與主要方法如何共同運作，並交代這些主軸的機制比較及處置理由，包含判為 `keep-existing` 的主軸；不能只展示去重後剩下的零散增量。沿用既有 ledger／digest 即可。改善優先序沿用 AGENTS.md 的 Usability-First 原則，以受益者與預期工程效益說明；部分能力已有只影響適配方式，不自動降低其改進價值。

### Ingest-Mapping Ledger

引入前**必須**輸出逐條 ledger，評估每個外部概念 vs devpro 現有規則：

| 外部概念 | devpro 已有對應 | 對應狀態 | Disposition |
|---|---|---|---|
| `<外部概念名稱>` | `<devpro 規則/段落>` 或「無」 | 已有 / 部分 / 無 | keep-existing / adapt / ingest |

**Disposition 三選項**：

- `keep-existing`：依上節證成 devpro 已有完整對應或更強機制 → 不新增或重述等價內容
- `adapt`：已有部分對應，或同目標但來源提供實質不同的改進機制 → 補強或重做既有 SSOT，保留必要取捨與驗證
- `ingest`：devpro 無對應 → 可引入，但仍需通過 §映射相容性 評估

**`adapt` 與 `ingest` 都進入映射相容性及 digest 判斷**；前者改善既有能力，後者引入缺少的能力。`keep-existing` 不進入變更落地；單純 prose 偏好不足以推翻已證成的等價判斷。

> Ledger schema 與 `doc-split-and-dedup-sop.md` §Split/Dedup Audit Output 的 file-role ledger 同構（外部概念映射 vs 內部 file-role 映射），但用途不同：ingest-mapping 處理外部概念引入，file-role 處理內部 corpus 盤點。兩者不合併，各自完整（leaf-self-contained）。

### 映射相容性

`disposition: adapt` 或 `ingest` 在採納前都需驗證外部方法的**假設**是否與 devpro 6 Principles 相容。判準（各 Principle 的違反訊號）為設計層 SSOT，見 `rule-design-principles.md` §6 Principles；本 leaf **不複述違反訊號**，只列需逐條對照的 Principle pointer + 適配方向：

| 相容性檢查 pointer | 適配方向 |
|---|---|
| §6 Principles row 1（Cross-Runtime Parity）| 加跨 runtime 等效路徑，或標記 adapter 層適配 |
| §6 Principles row 2（Hook-Independent Routing）| 改寫為「hook 不在時仍能 routing」 |
| §6 Principles row 3（Leaf Self-Contained）| 調整為 ≤1 層 cross-ref 限制內的寫法 |
| §6 Principles row 4（Token-First / usefulness first）| 改為 on-demand 觸發載入，且不犧牲 load-bearing clarity |
| §6 Principles row 5（Cross-Platform Scripts）| 涉及 script 時驗證支援平台的等效操作 |
| §6 Principles row 6（Hook Enforcement Alignment）| 核對 enforcement 載體；語意判斷明標 cooperative-only |

逐條對照設計層 §6 Principles 的違反訊號；命中即記入 Ingest-Mapping Ledger 備注欄，不相容但仍需 ingest 者必須描述適配方案。

### 三層持久化

ingest 結果落地路徑遵循 devpro 三層持久化規則：暫存 (`notes/`) → 進行中 (`openspec/changes/<name>/`) → 歷史 (`openspec/changes/archive/`)。完整規則見 `rule-design-principles.md` §Workflow Persistence Layers，本 leaf 不重述。

## Exit Criteria

- 來源可信度已標（高 / 中 / 低）；低可信來源已完成交叉驗證
- 已說明來源核心方法與方法間關係；主要材料未讀或證據缺口已明示，未冒充完整理解
- Ingest-Mapping Ledger 已輸出；每個外部概念有 disposition
- `keep-existing` 有機制等價或現有更強證據；`adapt` 與 `ingest` 均已進入後續評估
- 映射相容性通過（或適配方案已記錄）；適用的 6 Principles 衝突點已處理
- 落地路徑符合三層持久化規則（cross-ref 見 `rule-design-principles.md` §Workflow Persistence Layers）
- 需要落成 durable carrier 的採納項，已交由 `knowledge-digest.md` verdict 與 `knowledge-distillation.md` Distillation Ledger 承接

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「我們也有同名原則，所以已完整涵蓋」 | 先比操作機制與流程組合；`keep-existing` 需等價或更強證據 |
| 「外部框架描述更清楚，直接 ingest 比較好」 | prose 偏好不是改善證據；有機制差異則以 `adapt` 評估既有 SSOT 的補強或重做 |
| 「只是一篇部落格，描述很精準，不需要交叉驗證」 | 低可信來源必須交叉驗證；單一來源的「精準」可能只是一種觀點 |
| 「外部框架與某個 devpro Principle 假設衝突，但描述很好，直接 ingest」 | 映射相容性命中衝突即須適配；判準（各 Principle 違反訊號）見設計層 §6 Principles，不可繞過 |
| 「三層持久化規則很簡單，直接在這裡重述一遍」 | 重述 = 製造 SSOT drift；cross-ref `rule-design-principles.md` §Workflow Persistence Layers 即可 |

## Verification

```bash
# 三子段 anchor 存在
grep -n '### 來源可信度分層' .devpro/agent-rules/rule-ingest-methodology.md
grep -n '### Ingest-Mapping Ledger' .devpro/agent-rules/rule-ingest-methodology.md
grep -n '### 映射相容性' .devpro/agent-rules/rule-ingest-methodology.md

# §Example Sanitization Canonical FORBIDDEN regex 自檢（email / Unix path / Windows path）
# 對本檔 grep：預期 0 命中（本檔正教規範治理，禁踩 PII dogfood）
# grep -E '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' .devpro/agent-rules/rule-ingest-methodology.md
# grep -E '/Users/[a-z]|/home/[a-z]' .devpro/agent-rules/rule-ingest-methodology.md
# grep -E 'C:\\\\Users\\\\' .devpro/agent-rules/rule-ingest-methodology.md
```
