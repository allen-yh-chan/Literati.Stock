---
name: knowledge-ingest
description: "External knowledge/framework ingest recipe（source-credibility tiering、Ingest-Mapping Ledger、對 6 Principles 的 mapping compatibility、knowledge-digest artifact）。使用時機：使用者想把 refs/、外部 repo、wiki/notes/memory store、產業 framework 或標準中的可重用實務萃取進 devpro rules 時。"
metadata:
  user-invocable: true
---

# Devpro Knowledge Ingest

## Overview

本 skill 是把外部知識——產業 framework、標準、研究，或 reference-directory 內容——帶進 devpro rule corpus 的 routing 與 operational-recipe 載體，且不重新發明既有規則、不建立平行的 memory store。**Policy SSOT 留在 rule leaves——本 skill 不重複它。** Source-credibility tiering、Ingest-Mapping Ledger，以及對 6 Principles 的 mapping-compatibility 檢查定義在 `rule-ingest-methodology.md`；knowledge-digest artifact 的形狀、decision-type taxonomy 與 SSOT-placement 規則定義在 `knowledge-digest.md`；digest 後採納項的 minimal carrier / Distillation Ledger 定義在 `knowledge-distillation.md`。本 skill 排序該載入哪些檔案、依什麼順序；不重新定義 ledger schema、decision types 或 placement 規則。

## When to Use

- 把產業 framework（例如 content-audit ROT、某個測試方法論、某個 design pattern）帶進 devpro rules
- 引用某個標準文件（ISO / RFC / W3C）作為規則依據
- Ingest 外部研究論文或技術部落格的方法論
- 評估是否採納某個新的產業最佳實務
- 從 `refs/`、外部 repo、wiki/notes 或 memory store 萃取可重用知識

## Process

### 1. 先載入 policy SSOT

載入 `rule-ingest-methodology.md`（source-credibility tiers、Ingest-Mapping Ledger schema、mapping-compatibility pointer table、three-layer persistence）與 `knowledge-digest.md`（digest-artifact 形狀、五種 decision types、SSOT placement 規則、dedup-before-add discipline）。以下本 skill 的步驟排序 ingest 順序；ledger 欄位與 decision-type 語意存在那些檔案裡。

### 2. 分級 source 並依可信度 gate

依 `rule-ingest-methodology.md` §來源可信度分層 分類 source，採納前滿足對應的交叉驗證要求。先核對原文與方法；證據不足的採納主張明示限制，不把來源分級當成略過理解的理由。

### 3. 理解來源的方法與整體工作方式

依 `rule-ingest-methodology.md` §來源理解與機制比較，先按來源自身的目標、分類與主流程建立方法圖譜，再對照 Devpro；不用現有規範章節或「我們缺什麼」先篩選來源。讀入口、主要流程及影響判斷的配套，將各主軸如何運作、彼此關係、取捨及未查明處放進既有 digest／ledger。此步完成後才作去重 disposition；單一來源待交叉驗證的採納主張，不得被包裝成已驗證成效。

### 4. 比較機制並產出 Ingest-Mapping Ledger

依同一 policy 的等價判準比較概念、機制與流程組合，再記錄外部方法、devpro 對應 rule/section、對應狀態（full / partial / none）、disposition（`keep-existing` / `adapt` / `ingest`）及比較證據。`adapt`、`ingest` 繼續後續評估；`keep-existing` 須有完整對應證據。先判改善價值，再決定如何沿既有 SSOT 補強或重做。

### 5. 檢查 mapping compatibility

對每個 `disposition: adapt` 或 `ingest` 項目，依 `rule-ingest-methodology.md` §映射相容性 對照設計層 6 Principles。把衝突與調適方式記在 ledger 備注；實際判準沿用 policy 指向的 SSOT，不在 skill 複寫。

### 6. 撰寫 digest artifact 並放置它

先依 policy 呈現來源方法圖譜與各主軸的機制比較，再排序採納候選；`keep-existing` 只排除重複落地，不把核心方法從比較中刪掉。結束前以來源入口核對主軸是否有比較理由，或明示其未完成範圍；限制聲明不能把使用者要求的主要分析變成已完成。讓讀者能從整體方法理解建議的工程效益。

依 `knowledge-digest.md`：在 OpenSpec change 中建立 `knowledge-digest.md`（或在 `skill-evaluation.md` 中建立 `Knowledge Digest` 段落），為每個主要來源列出 source / extract / decision / target SSOT / exclusion / verification。新增任何內容之前，先搜尋既有 rules/spec/README/AGENTS 找出現有落腳處——強化那個 SSOT，而不是新增平行的 leaf。依 SSOT 規則放置採納的內容：共用行為 → `.devpro/agent-rules/*.md`；runtime-specific 能力差異 → `platform-adapters/*.md`；一次性 handoff → Session Recap / OpenSpec artifact；個人偏好或機器本地 memory → 完全不進 repo。

### 7. 落地三層持久化路徑

依 `rule-design-principles.md` §Workflow Persistence Layers 遵循 devpro 的三層持久化（`notes/` scratch → `openspec/changes/<name>/` in-progress → `openspec/changes/archive/` historical）——本 skill 不重述那些 layer 語意。

### 8. 必要時 hand off 到 distill

若 digest verdict 是 `adopt-rewrite` 或 `adapter-only`，且下一步要落成 rule、skill、adapter、spec、test 或外部 KB patch，改用 `devpro:knowledge-distill` / `knowledge-distillation.md` 產出 Distillation Ledger。本 skill 停在 ingest + digest gate。

## Common Pitfalls

- 只是摘要 source，而不是為每個項目指派五種 decision verdict 之一
- 未理解主要方法就按同名條文去重，或把單項原則的對應當成整體流程等價
- 用既有 SSOT 當成不評估更好機制的理由，或因 prose 偏好就重述已證成等價的內容
- 對單一低可信度 source 跳過交叉驗證
- 把外部 skill/wiki/memory directory 整批複製過來，而不是重寫成 runtime-neutral 的 rule 內容
- 在 dedup 搜尋之後仍建立新的平行 leaf，而不是強化既有 SSOT
- 把 digest verdict 當成已完成落地，卻沒有 distill carrier、action point 與 verification

## Verification

修改本 skill 的操作指引時，依 `agent-skill-governance.md` §Behavioral Evaluation Before Deployment，以目前版本為 baseline、修正版在 fresh context 重跑相同任務。驗收比較分析產物、實際讀取及 disposition 證據，涵蓋同名不同機制、流程組合增益與真正等價的情況；下列結構檢查不代表行為評估已通過。

```bash
grep -n '### 來源可信度分層' .devpro/agent-rules/rule-ingest-methodology.md
grep -n '### 來源理解與機制比較' .devpro/agent-rules/rule-ingest-methodology.md
grep -n '### Ingest-Mapping Ledger' .devpro/agent-rules/rule-ingest-methodology.md
grep -F "Knowledge Digest" .devpro/agent-rules/knowledge-digest.md
grep -F "knowledge-distillation.md" .devpro/agent-skills/rules-authoring/knowledge-ingest/SKILL.md
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/reusable-skill-adoption-grep.test.mjs
```
