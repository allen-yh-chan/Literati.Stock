---
name: anti-patterns-examples
description: 16 組 ❌/✅ 對照：6 組 design 越界（Drive-by Refactor / Silent Assumption / Premature Abstraction / Defensive Without Evidence / Fix-Without-Reproduce-Test / Name Drift）+ 10 組 LLM agent behavioral（OpenSpec 缺失、委派失敗、token burst、文件未更新、假設未明示、POSIX-only shell/syscall、Convenience-Driven Boundary、Incomplete Character-Class Enumeration、Incomplete Supersede Sweep、Retained-API Without Hard-Fail Deprecation）。察覺自己要越界時查閱。
---

# Anti-Patterns 案例庫（❌ / ✅ 對照）

## Overview

本檔是反 pattern 對照範例庫：`ai-autonomy.md` 提一句話反駁，這裡給完整情境與 ❌/✅ 對照。共 16 組 pattern（§1-§6 design 越界 + §7-§16 LLM agent behavioral）。

## When to Use

- 「順手」改非 task scope 的程式碼 → §1
- 收到模糊需求準備直接實作 → §2
- 考慮抽介面、strategy、新抽象層 → §3
- 打算加 null check / try-catch / 預設值 → §4
- 拿到 bug report 直覺要改某行 → §5
- 修 bug 順手把名稱改得「更好」 → §6
- 想把新檔案塞進「目前部署比較方便」的現有 project / 目錄 → §13
- 取代既有方法只改部分 call site，殘留的舊用法零警告 → §15
- 保留舊 API 未配 deprecate 標記或未升 error 級攔截 → §16

## Process

### Patterns

> Load-chain：design 越界 anti-patterns（§1-§6）見 `anti-patterns-design.md`；LLM agent 行為 anti-patterns（§7-§16）見 `anti-patterns-behavioral.md`。

| # | Anti-pattern | 載入 |
|---|---|---|
| §1 | Drive-by Refactor（順手改旁邊） | `anti-patterns-design.md` |
| §2 | Silent Assumption（沒問就假設需求） | `anti-patterns-design.md` |
| §3 | Premature Abstraction（過早抽象） | `anti-patterns-design.md` |
| §4 | Defensive Without Evidence（沒證據就防禦） | `anti-patterns-design.md` |
| §5 | Fix-Without-Reproduce-Test（沒重現測試就修） | `anti-patterns-design.md` |
| §6 | Name Drift（順手改名） | `anti-patterns-design.md` |
| §7 | OpenSpec 缺失（直接寫碼跳過流程） | `anti-patterns-behavioral.md` |
| §8 | 委派失敗（沒做 executor 決策就自己做 ≥2 步） | `anti-patterns-behavioral.md` |
| §9 | Token burst（regex 全文 grep / 全 read） | `anti-patterns-behavioral.md` |
| §10 | 文件未更新（PR review 後 spec drift） | `anti-patterns-behavioral.md` |
| §11 | 假設未明示（腦補使用者意圖） | `anti-patterns-behavioral.md` |
| §12 | POSIX-only Shell Built-ins and Node.js Syscall Semantics in Source-Repo Scripts | `anti-patterns-behavioral.md` |
| §13 | Convenience-Driven Boundary Placement（為部署方便而錯置邊界） | `anti-patterns-behavioral.md` |
| §14 | Incomplete Character-Class Enumeration（改 regex 字元類沒窮舉成員） | `anti-patterns-behavioral.md` |
| §15 | Incomplete Supersede Sweep（取代舊方法未掃全 call site） | `anti-patterns-behavioral.md` |
| §16 | Retained-API Without Hard-Fail Deprecation（保留舊 API 未配硬攔 deprecate） | `anti-patterns-behavioral.md` |

### Seam 撞名／淺模組（短案例）

**Feathers seam ≠ OpenSpec Seams-first**——前者是程式可測縫；後者是提案驗收面（見 `design-core.md`／`proposal-template.md`）。

| | ❌ | ✅ |
|---|---|---|
| 撞名 | 把 OpenSpec **Seams-first** 誤當 Feathers seam，去改 production 測試 seam／依賴注入「對齊驗收 seams」 | 驗收 seams 留在 proposal／Ledger；程式縫另名 **Feathers seam**／測試邊界 |
| 淺模組 | 介面暴露內部細節、呼叫端需懂實作才能用 | 縮小 Interface、加深 Depth；細節藏在模組內 |

## Exit Criteria

- 識別對應 pattern 後停下詢問使用者意圖，不擅自展開越界動作
- 實作僅涵蓋 task scope 內的檔案
- 更改可直接追溯回使用者請求

## Verification

- Review PR diff 時逐一對照 §1–§6 觸發條件
- 每一行變更能追溯回需求（§1 自我提問）
- 新增抽象前問：「有第二個使用情境嗎？」沒有 → 不抽（§3）
- Bug fix PR 含重現 test 且修復前確實 fail（§5）
- Bug fix 與 rename 分開 commit / PR（§6）
