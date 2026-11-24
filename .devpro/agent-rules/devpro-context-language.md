---
name: devpro-context-language
description: Devpro 流程薄詞表（選定 process terms + _Avoid_ + pointer）；觸發：流程說詞／lexicon／澄清／seams／synthesis 用語不一時。
---

# Devpro Context Language（thin process lexicon）

## Overview

選定**流程詞**的薄詞表：每詞 = canonical + `_Avoid_` 近義／漂移 + pointer 到既有 leaf SSOT。
**不是**產品 ubiquitous language、不是 session `CONTEXT.md`、不取代 OpenSpec BRD／proposal。

## Terms

| Canonical | `_Avoid_` | Pointer SSOT |
|---|---|---|
| clarification batch / round | 一題一輪；無限 grill；「再問幾輪就好」 | `ambiguity-scoring.md`（round-policy） |
| `/devpro:clarify`（explore｜pre-analyst） | 在 `devpro:change` 內另寫第二套 clarification 步驟；explore 寫 meeting-notes／放行 analyst | `devpro:clarify` skill（recipe）＋`ambiguity-scoring.md`（政策） |
| working cap / absolute max / `extension_used` / `round4_completed` | skill 內自訂 cap；重複 +1 | `ambiguity-scoring.md` |
| `cap_hit` / `cap_resolution` | 用 `shared_understanding` 繞過未決 cap-hit | `ambiguity-scoring.md` |
| Clarification State / frontier / `UNRESOLVED:` | full transcript；無界筆記 | `ambiguity-scoring.md` |
| Synthesis mode | 合成階段再面試；腦補未決 | `openspec-quality-and-formats.md` |
| Seams-first / Seams Confirmation | 先寫長文再補驗收面；無證 bypass | `proposal-template.md` |
| Feathers seam（程式可測縫） | 用 Feathers seam 指稱 OpenSpec 驗收 seams；用 Seams-first 指稱測試／依賴程式縫；裸寫「seam」不具名 | `design-core.md`（薄詞＋消歧）；驗收面 SSOT：`proposal-template.md` |
| stop-point 交棒 | 停下不給選項；口頭 undefined redirect | `stop-point-comms.md` |

## Non-goals

- MUST NOT 把本 leaf 讀成「強制產品 repo 建 `CONTEXT.md`」
- MUST NOT 用本詞表取代 `brd.md`／`proposal.md`／Requirement Ledger
- MUST NOT 在本 leaf 複寫 round cap／trigger／seams 規則正文（只 pointer）

## When to Use

流程說詞／lexicon／澄清／seams／synthesis 用語不一致，或需查 canonical／`_Avoid_`／pointer 時載入本 leaf。

## Process

1. 查上表 Canonical；若措辭落在 `_Avoid_`，改用 Canonical
2. 規則正文以 Pointer SSOT 為準；本 leaf 不複寫 round cap／trigger／seams
3. 產品 `CONTEXT.md`／BRD／proposal 仍走既有 OpenSpec 載體

## Exit Criteria

- 選定流程詞可對到 Canonical + pointer；未把本 leaf 當成產品 CONTEXT 或 BRD 替代品

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「先在本 leaf 寫完整 round 規則比較方便」 | round／cap／trigger SSOT 在 `ambiguity-scoring.md`；本檔只 pointer |
| 「沒有產品 CONTEXT.md 就違規」 | Non-goals：禁強制產品 `CONTEXT.md` |
| 「用詞表取代 BRD／proposal」 | OpenSpec 載體仍是權威；本檔只對齊流程說詞 |

## Verification

```bash
test -f .devpro/agent-rules/devpro-context-language.md
grep -q "_Avoid_" .devpro/agent-rules/devpro-context-language.md
grep -qE "流程說詞/lexicon|devpro-context-language" AGENTS.md
grep -q "ambiguity-scoring.md" .devpro/agent-rules/devpro-context-language.md
```

## Cross-References

- `ambiguity-scoring.md` — round-policy／Clarification State
- `openspec-quality-and-formats.md` — Synthesis mode
- `proposal-template.md` — Seams-first
- `design-core.md` — Feathers seam／deep-module 薄詞；Feathers seam ≠ OpenSpec Seams-first
- `stop-point-comms.md` — 交棒呈現
- `AGENTS.md` 觸發式載入索引 — 流程說詞／lexicon 列
