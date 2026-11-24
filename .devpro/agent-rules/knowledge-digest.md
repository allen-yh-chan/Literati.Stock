---
name: knowledge-digest
description: "從 refs/外部 repo/知識庫萃取可重用規範時使用；要求 digest artifact、採納判斷、去重與 SSOT 回寫證據。"
---

# Knowledge Digest

## Overview

Knowledge digest 是把外部或本地 reference 的可重用知識轉成 devpro 規範的流程，不是新增一個 runtime 記憶庫。它保留來源、判斷與回寫位置，避免 AI 把 wiki、notepad、memory provider 或 skill 目錄直接搬進 source rules。shared repo 只收斂「可跨 runtime 重複執行的行為規範」。

Digest 停在 verdict 與 SSOT placement；當採納項需要變成可執行 rule、skill、spec、test、adapter 或外部 KB patch 時，交給 `knowledge-distillation.md` 的 Distillation Ledger，不在本 leaf 重述 distill schema。

## When to Use

- 使用者要求從 `refs/`、外部 repo、best-practice repo、wiki、notes、memory、digest 來源萃取做法時
- 規範變更想引用另一套 agent workflow、skill、prompt、hook、command 作為來源時
- Session Recap 或 review 發現可泛化規範，準備回寫 source rules 時
- 需要判斷某個 local knowledge store 應進 shared rule、adapter、recap，或應排除時

Load-chain：需要 proposal 版型或 token 預估時，按需載入 `proposal-template.md`、`token-budget-precheck.md`；AGENTS.md 只 eager-load 本 entry leaf。

## Process

1. **Inventory**：列來源 repo/path、主題、原用途、可驗證證據；理解深度與機制比較依 `rule-ingest-methodology.md` §來源理解與機制比較。核心方法、方法間關係與材料缺口須在採納判斷前說清楚。只讀 reference；不得把 reference 目錄納入本次 commit。優先 **primary-source**（一手原文／標準／repo），次才二手轉述。
2. **Digest Artifact**：在 OpenSpec change 內新增 `knowledge-digest.md`，或在 `skill-evaluation.md` 加 `Knowledge Digest` section。每列至少含：source、extract、decision、target SSOT、exclusion、verification。採納須落到 **cited durable** artifact（OpenSpec／rule／test），**禁只摘要**當 verdict——摘要不是採納判斷。
3. **Decision Types**：只允許五類 verdict：`adopt-rewrite`、`mine-only`、`adapter-only`、`defer`、`reject`。禁止用「看起來有用」替代 decision。
4. **SSOT Placement**：
   - shared 行為規範 → `.devpro/agent-rules/*.md`
   - runtime 能力差異 → `platform-adapters/*.md`
   - 一次性交接 → Session Recap / OpenSpec artifact
   - 個人偏好或機器本地記憶 → 不進 repo
5. **Dedup Before Add**：先完成方法理解與改善價值判斷，再搜尋現有 rule/spec/README/AGENTS 決定落點；有對應則補強或重做原 SSOT，不新增平行 leaf。等價判準與 `adapt`／`ingest` 後續路徑依上游 policy；相似名稱不足以排除改進。
6. **Evidence**：採納項必須有 grep/test/validate 證據；排除項必須寫明排除理由與會造成的 drift 或 dependency。
7. **Distill Handoff**：`adopt-rewrite` 或 `adapter-only` 若要落成 durable carrier，依 `knowledge-distillation.md` 產出 Distillation Ledger；本 leaf 只保存 digest verdict。

## Exit Criteria

- Digest artifact 存在，且每個 primary source 都有 verdict 與 target/exclusion
- 採納內容已改寫成 runtime-neutral 規範，沒有直接 copy skill/wiki/memory 目錄
- 新 leaf 已更新 AGENTS.md 觸發索引、README 規則表、token tier（如適用）
- regression test 或 QA grep 驗證 digest anchor、SSOT anchor、direct-copy exclusion

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「先把整個 knowledge store 放進 repo，之後再整理」 | 未整理內容會變成平行 SSOT；先 digest 再採納。 |
| 「memory/wiki 類工具很像知識庫，直接用它的格式就好」 | 工具格式是 runtime/local implementation；shared rules 只採納可跨 runtime 的行為。 |
| 「來源太多，摘要一下就好」 | 摘要不是 verdict；每個 primary source 都要有採納/排除判斷。 |
| 「已有 Session Recap，不用 digest」 | Recap 是交接紀錄；digest 是把可泛化規範回寫 SSOT 的 gate。 |

## Verification

```bash
grep -F "Knowledge Digest" .devpro/agent-rules/knowledge-digest.md
grep -F "knowledge-digest.md" AGENTS.md README.md
grep -F "knowledge-distillation.md" .devpro/agent-rules/knowledge-digest.md
node --test .devpro/scripts/tests/reusable-skill-adoption-grep.test.mjs
```
