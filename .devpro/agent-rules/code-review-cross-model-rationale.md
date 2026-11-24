---
name: code-review-cross-model-rationale
description: Cross-model review cold rationale/troubleshooting sibling：PGE 原則、same-family blind spots、provider probe / max-turn fault notes。只在設計、審查、或除錯 cross-model reviewer policy 時載入；一般 Step 5.5 執行只讀 `code-review-cross-model.md`。
---

# Cross-Model Rationale And Troubleshooting

> Load-chain：本檔由 `code-review-cross-model.md` on-demand 指到；不得在一般 `devpro:pre-pr` Step 5.5 eager-load。

## Overview

本 cold sibling 承載 cross-model review 的 rationale 與 invocation troubleshooting。Hot path 規則留在 `code-review-cross-model.md`；只有設計、審查、或除錯 cross-model policy 時才讀本檔。

## When to Use

- 需要檢查 PGE（Prompter / Generator / Evaluator）原則、same-family fallback 風險、或 provider-probe/max-turn fault 歷史。
- 一般 `devpro:pre-pr` Step 5.5、focused sticky-refresh、merge gate 判定不預載本檔。

## Process

### PGE Principle

PGE 把 review 拆三角色；same-family fallback 有 audit、無 PGE diversity：

| Role | 定義 | 本 repo 對映 |
|---|---|---|
| Prompter | 提出需求、限制與驗收的人 | 使用者 / proposal done-when |
| Generator | 產出實作或初審結論的一方 | primary implementation / primary review |
| Evaluator | 獨立評估產物的一方 | different-runtime second reviewer |

**Prompter ≠ Generator ≠ Evaluator** 是 cross-model review 最低心智模型：Generator 對自己產出易補完缺口/合理化設計，故 Evaluator 必須與其分離（= 不同 runtime/model 的 second reviewer，讀同一 PR metadata/diff/規範/done-when 後給獨立 verdict）才能 surface 盲點。

Anchor：reference best-practices §10.1（2026-05）為 2 元 GE；本 repo 延伸 3 元 PGE，因本 repo 明確區分需求提出者與獨立評估者。

### Same-Family Systematic Blind Spots (Same-Family Blind Spots)

cross-model 的價值不只是「多一雙眼睛」，而是結構性補位 same-family 系統性盲區。Generator 與 same-family reviewer 共享訓練分佈與推理慣性，對某幾類錯誤有共同盲區；green test suite 也覆蓋不到：

- **doc/spec 因果誤歸因**：把行為歸因到錯的 flag / 機制，same-family 因共享錯誤心智模型而一致看不出。
- **dangling cross-ref**：拆檔 / repoint 後 section ref 指向錯檔或已移走 anchor，特別檢查 spec-scenario THEN-clause cross-ref 與 grep-asserted phrase 單行可 match。
- **dead-code after refactor**：重構後某分支變 unreachable，行為測試全綠但邏輯已死。
- **跨平台 test 正確性**：negative assertion、`/tmp` 路徑、symlink realpath、macOS-only 假設在 Linux CI 才 fail。

### Troubleshooting Notes

- `error_max_turns` 是 invocation/orchestration evidence，不是 reviewer verdict。最多重組一次更小 packet、修正 mode、改 stream/progress extraction、或寫 `UNAVAILABLE`；不得同形狀重跑。
- stale `PASS|WARN` sticky + narrow delta 被 broad rerun timeout/error 卡住時，分類為 orchestration friction；下一步是 focused sticky-refresh packet，不是 reviewer unavailable。
- provider probe history 屬 cold evidence：除非正在除錯 reviewer invocation，不應為一般 sticky refresh 載入 probe 細節。Host-specific probe history 見對應 `platform-adapters/*-troubleshooting.md`。

## Exit Criteria

- Hot path 規則能只讀 `code-review-cross-model.md` 完成 routing、packet、sticky、merge-gate 判定；腳本強制的 packet 機制契約只在具名錯誤碼、fault-recovery 或核對 WARN／CRITICAL finding 的 reviewer 職責字樣時讀 `code-review-cross-model-dispatch-mechanics.md`。
- rationale / provider-probe / max-turn history 只在需要設計或除錯時由本檔補充。

## Common Rationalizations

| 說法 | 問題 |
|---|---|
| 「same-family fallback 也是 cross-model diversity」 | 只能算 audit fallback；必須標明 same-family fallback reason，不能宣稱完成 PGE diversity。 |
| 「`error_max_turns` 多跑幾次就好」 | 這是 invocation/orchestration fault；最多修正 scope/mode 後重跑一次，重複同形狀會浪費 token 並污染 sticky evidence。 |

## Verification

```bash
rg -n "Prompter|Generator|Evaluator|Same-Family Systematic Blind Spots|error_max_turns|provider probe" .devpro/agent-rules/code-review-cross-model-rationale.md
```
