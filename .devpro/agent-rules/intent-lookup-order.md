---
name: intent-lookup-order
description: current design / intended behavior lookup order：specs first、no-spec 只能 observed/inferred、why 用 git/PR 索引。
---

# Intent Lookup Order

## Overview

查既有行為 intent 時固定 specs first；無 spec 時只能 bounded answer；why 由 git/PR 定位後讀 archive。

## When to Use

觸發：理解既有行為，或使用者問系統功能設計 / `system feature design` / `current design` / `intended behavior` / `current contract` / 現況設計 / 預期行為。新行為設計走 `openspec-flow.md`。

## Rules

需要理解既有行為時，**MUST** 先查 canonical contract，不得從 hook/script/rule leaf 反推 intent：

1. current behavior / current design / intended behavior：先查 `openspec/specs/**`，命中後讀 `openspec/specs/<capability>/spec.md`。它是 source of truth；archive 時 delta 已合併進 specs。**MUST NOT** grep `openspec/changes/archive/` 判現狀，因 archived deltas 可能被後續 change 覆蓋，且 `openspec/changes/archive` 是 `token-frugal-io.md` 的**預設排除掃描路徑**。

2. 無 canonical OpenSpec spec：**MUST** 明說找不到該 subject/capability 的 canonical OpenSpec spec；code/tests/rule leaves 只可標成 observed implementation / inference；**MUST NOT** 宣稱 canonical/intended behavior。若使用者要 define or fix intended behavior，**MUST** 先開 OpenSpec change 建立或修補 capability spec。

3. why / 糾正史：用 `git log` / `git blame` 對 rule leaf 或 spec file 當**索引**，定位 commit/PR，再讀那一個 archived change 的 `proposal §Why` + Requirement Ledger 當**終點**。**MUST NOT** 拿 `openspec/changes/archive/` 當 grep **起點**。

4. 查 spec、no-spec fallback、查 why **皆優先於**反推；implementation 最後才查，只補機械細節。

5. 因使用者糾正而生的 requirement，proposal Requirement Ledger **MUST** 標 `user correction` + 來源 PR/session，讓未來 why 查詢找得到。

## Correction Lifecycle

`notes/session-pending.md` 只是在 session 內暫存尚未處理完的 correction/follow-up。當 correction 變成 requirement，durable carrier 是 active proposal 的 Requirement Ledger；該 requirement **MUST** 標 `user correction` + 來源 PR/session。非糾正型的 forward request 維持記為 `User request`，不需要 `user correction` tag。

why / 糾正史查詢用 `git log` / `git blame` 先定位 commit/PR，再讀該 archived proposal 的 Requirement Ledger；不得改從 archive 全域 grep 起步。

## Why

目的不是不讀 implementation，而是防止把 observed code 誤答成 intended behavior，並確保上游 proposal/spec 被消費；archive 無索引且會成長，所以 history 只能由 git/PR 定位後單點讀。

## Exit Criteria

- current behavior/current design/intended behavior 已先查 `openspec/specs/<capability>/spec.md`。
- 無 spec 時已說 no canonical OpenSpec spec found；code/tests/rule 證據只標 observed/inferred。
- why 用 `git log`/`git blame` + PR 定位，archive 只當終點。
- 使用者糾正形成 requirement 時，Requirement Ledger 已標 `user correction` + 來源 PR/session；forward request 未被誤標為 correction。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「grep archive 最快」 | archive 無界、無索引、可能過期；先用 `git blame` 定位。 |
| 「讀 hook 就知道 intent」 | hook 只證明 observed implementation，不證明 why/current contract。 |
| 「沒有 spec，所以 code 就是 intended behavior」 | 無 spec 只是缺 canonical contract；要定義/修正就開 OpenSpec change。 |

## Verification

```bash
node --test .devpro/scripts/tests/intent-lookup-order-grep.test.mjs
```
