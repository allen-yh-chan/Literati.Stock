---
name: dry-ssot-corpus
description: "DRY/SSOT corpus-scope doctrine（P1–P8；P9 pointer）。觸發：DRY/SSOT corpus、新具名定義、copy-execute 模板。"
---

# DRY / SSOT Corpus Scope

## Overview

DRY／SSOT 判準的預設視野是 **corpus**，不是本 PR diff（seam token: corpus-not-diff）。本葉是 language-/carrier-agnostic 的 P1–P8 正文 SSOT；語言葉只 pointer。P9 契約正文在 `change-consequence-assessment.md`，本葉只 cite。

## When to Use

- 新增具名定義、copy-execute 模板、或設計新 grep／gate 時
- 實作中看見超出本 change 範圍的重複、只該 pattern-level 記錄時
- 既有治理 cadence 順帶觀察 corpus-dup 債時（同一 cadence 觀察口，非平行）
- 需要 lite 標註（P2 keep／P3 degrade）時——標註載體是 `rules-rigor-level.md`，不在本葉發明第四級

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `dry-ssot-corpus-grep.test.mjs`（shape／pointer／lite 標註／十句計數／equal-pass dual-token）；`--pre-review` via `named-def-corpus-grep-evidence.mjs`（`## Named-Definition Corpus-Grep Evidence` JSON fence；缺／缺欄 fail closed；禁 diff materiality oracle） |
| Advisory | `code-review-checklist.md` 軸 2 NEW named／新具名定義 corpus-grep（Important；質檢／disposition 語意仍屬 reviewer） |
| Doctrine | `cooperative-only`：何謂具名定義屬 reviewer 判斷，禁 regex materiality oracle |

### Complementary axes（守則 3 vs P1–P4）

兩軸 complementary、不是 override。守則 3 = policy leaf 禁 chain-load（leaf 自含；允許 AGENTS 索引或 cite ≤1 層）。P1–P4 = 同一個 executed 事實在 corpus 一個 SSOT。P4 不是「policy leaf 必須 chain-load」。本葉 P1–P8 自含；軸 2 仍是完整審查步驟，只 cite 本檔一次（≤1 層）。

### P1 — Corpus-not-diff（一 SSOT）

視野是 **corpus**，不是本 PR diff。語言葉（`csharp-style-and-dry.md`）只 pointer，不另立第二套 corpus 準則。

### P2 — Creation-time named-def lookup

新增具名定義 MUST grep 名稱／關鍵字 + 掃 shared dir（例 `.devpro/scripts/lib/`）；禁 corpus read-through。first-use 可就地寫；近匹配才擴 SSOT；禁為預期第二場景預先抽取。lite = keep（見 rigor 矩陣）。

### P3 — Review-time 新具名定義 corpus grep

對 PR 新增的 NEW named／新具名定義做 corpus grep 並留證據（查詢範圍＋結果／命中；非 self 命中須 disposition）；fallback 同步。任何 PR 都適用；禁 silent small-diff 豁免。lite = degrade（仍做 grep＋一行證據，不是 exempt）。一行證據即該較富欄位列，不是 command-only。

**Pre-review mechanical carrier（#2526）**：owned active change 的 `proposal.md`／`proposal-mini.md` MUST 含 `## Named-Definition Corpus-Grep Evidence`，內嵌單一 json fence 物件：`status: none`（加非空 `reason`）或 `status: present`（`definitions[]` 每項含 `name`／`scope`／`hits|results`／`disposition`）。`pre-pr-archive-gate.mjs --pre-review` 缺段／缺欄 fail closed 並點名定義；**不**從 diff regex 判定何謂具名定義（仍 cooperative-only）。軸 2 繼續質檢證據真偽與非 self disposition。

### P4 — Copy-executed templates are DRY-shaped

會被 copy-execute 的模板必須能指向既有 SSOT。例外僅 instructional snippets 與 self-contained host JSON。Briefing `existing_ssot_list` 由 TL 填；lookup 不委派 executor。

### P5 — New gates equal-pass

新 gate：inline 原文與 SSOT-import 須 equal-pass。既有刻意 inline assertion（`cli-entry-guard-portability`）不 force-change。Blocking grep dual-token per `rule-anchor-guard-strength.md`。

### P6 — Pattern-level record only

Out-of-scope dup 只 pattern-level 記錄：出現 ≥3 **或** already-divergent（已分裂）。≤2 屬 `code-simplification.md` 項 4 stay interval、不記錄。禁 drive-by 修存量。

### P7 — corpus-dup 債

既有治理 cadence 加具名 corpus-dup 債觀察口；不另開平行軌道、無新 auto-threshold。載體：`rule-audit-playbook.md`、`rule-self-evolution.md`、`devpro:rule-governance` skill。

### P8 — Complementary to AGENTS §0 第 10 條

Change-time「改既有事實 → grep 全副本」仍是 `AGENTS.md` 第 10 條**一致性掃描**；P2／P3 補 creation-time。不加第 11 條自檢。

### P9 — pointer only

現況比較後再 consequence；trigger 在 suggestion／rule-feedback。契約 SSOT：`change-consequence-assessment.md`（cite `intent-lookup-order.md`）。本葉不另寫八維 vocab。

## Exit Criteria

- 新具名定義已做有界查找（名稱／關鍵字 + shared dir），無 corpus read-through
- Review 對 NEW named／新具名定義留下 corpus-grep 證據（範圍＋命中＋非 self disposition）；無 silent small-diff 豁免；禁 command-only
- 新 gate 對 inline 與 SSOT-import equal-pass
- 越界 dup 僅 pattern-level 記錄（≥3 或 already-divergent）；≤2 stay interval 不記錄
- 十句自檢仍 10 項；無第 11 條

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「這是小 diff，跳過軸 2」 | 禁 silent small-diff 豁免；任何新具名定義都做 corpus grep |
| 「指令就夠當 P3 證據」 | 否；須範圍＋結果／命中；非 self 須 disposition |
| 「lite 就免 P2／P3」 | P2 keep、P3 degrade，不是 exempt，不是預設 full-only |
| 「順便修存量 dup」 | 禁 drive-by；≤2 stay interval 不記錄 |
| 「為 DRY 把 workflow 拆到多葉」 | 守則 3 極性不倒轉；P1–P4 不管 chain-load |
| 「幫 executor 掃一遍 corpus」 | lookup 是 TL／reviewer 職責，不委派 |

## Verification

```bash
node --test .devpro/scripts/tests/dry-ssot-corpus-grep.test.mjs
node --test .devpro/scripts/tests/agents-md-section0-sync.test.mjs
```
