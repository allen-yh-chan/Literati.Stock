---
name: knowledge-distill
description: "Knowledge distillation recipe（Distillation Ledger、minimal carrier、self-distill safeguards、ingest/digest handoff）。使用時機：使用者要求 distill/蒸餾/自我蒸餾、優化外部知識庫，或把 digest 結果收斂成 rule/skill/spec/test/KB carrier 時。"
metadata:
  user-invocable: true
---

# Devpro Knowledge Distill

## Overview

本 skill 是 knowledge distillation 的 routing 與 operational-recipe 載體：把已 ingest/digest 或已 audit 的知識壓成最小可執行 carrier。**Policy SSOT 留在 rule leaves——本 skill 不重複它。** Ingest source credibility 與 Ingest-Mapping Ledger 定義在 `rule-ingest-methodology.md`；digest verdict、decision types 與 SSOT placement 定義在 `knowledge-digest.md`；Distillation Ledger、minimal carrier 選擇、self-distill safeguards 與 exit criteria 定義在 `knowledge-distillation.md`。

## When to Use

- 使用者要求 `distill`、distillation、蒸餾、自我蒸餾或優化知識庫
- 已有 `knowledge-digest.md` artifact，要把 `adopt-rewrite` / `adapter-only` verdict 落成 rule、skill、spec、test、adapter 或外部 KB patch
- 要維護/優化另一套 knowledge base，把來源材料收斂成對方可執行的 guidance、索引、檢查表或測試
- 要維護/優化 devpro 自身規範庫，把 audit/recap/dedup signal 收斂成更小 SSOT

## Invocation

One-line calls are enough: `蒸餾 <URL/path>`、`distill <URL/path> to devpro`、`蒸餾 <URL/path> 到 <KB>`。使用者不必重述 ingest/digest/distill。target 未指明時，先產出 digest + Distillation Ledger 與 carrier 建議，不直接改 durable carrier；target 已指明時照 target 執行。

## Workflow

1. 載入 `knowledge-distillation.md`。若 source 是外部 refs/repo/wiki/notes/memory，先載入 `rule-ingest-methodology.md` 與 `knowledge-digest.md`，並確認 upstream ledger/verdict 已存在。
2. 判斷 target system：external KB 還是 devpro rule corpus。若是 self-distill devpro，按需載入 `rule-audit-playbook.md`、`doc-split-and-dedup-sop.md`、`rule-design-principles.md`。
3. 依 `knowledge-distillation.md` 建立 Distillation Ledger：source signal、digest verdict/evidence、distilled behavior、target carrier、action point、verification、exclusion/anti-drift note。
4. 選擇最小 carrier。Devpro skill carrier 必須走 `.devpro/agent-skills/manifest.json`，由 `.claude/skills/devpro`、`.agents/skills/devpro` 兩條 discovery entry 發現；rule leaf 必須更新 AGENTS.md / README；behavior-changing spec 必須有 implementation carrier。
5. 驗證 distill 後的內容是可執行行為，不只是摘要；沒有 action point 或 verification 時退回 digest 階段。

## Verification

```bash
grep -F "Distillation Ledger" .devpro/agent-rules/knowledge-distillation.md
grep -F '"name": "knowledge-distill"' .devpro/agent-skills/manifest.json
node .devpro/scripts/lint-agent-skills.mjs
node --test .devpro/scripts/tests/knowledge-distillation-grep.test.mjs
```
