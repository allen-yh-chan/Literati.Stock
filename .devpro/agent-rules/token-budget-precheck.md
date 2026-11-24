---
name: token-budget-precheck
description: Archive checks (e)/(r) actual-carrier token policy：ordinary-path soft/governance over-cap、advisory 80% semanticReview、integrity fail-closed。
---

# Token Budget Pre-Check

## Overview

Token budget 的 authoritative input 是 root `AGENTS.md` 與 nested `.devpro/agent-rules/**/*.md` 的 actual carrier final state；production SSOT 是 `.devpro/scripts/lib/rule-token-budget.mjs`。Proposal 不是 token-budget evidence carrier；既有 Token heading/table 僅為 inert legacy content，checks (e)/(r) 不得解析或依賴。Ordinary PR／pre-PR／test 路徑對 over-cap／AGENTS HARD 採 soft/governance；remediation 屬 `devpro:rule-governance`。

## When to Use

在 pre-PR archive gate checks (e)/(r) 對本次 authoritative Git manifest 執行。此檢查不因 source/consumer identity、full/B-mini artifact、archive 數量或 proposal 內容而改變。

| Actual carrier 類型 | Cap |
|---|---|
| root `AGENTS.md` | 10500 byte（HARD cap；SOFT cap 6500） |
| `.devpro/agent-rules/**/*.md` core | 7500 token（per-file override 由 production SSOT 登錄） |
| `.devpro/agent-rules/**/*.md` next | 3000 token |
| `.devpro/agent-rules/**/*.md` small / fallback | 1500 token |

## Process

1. Required probes 包含 committed、staged、unstaged tracked 與 untracked probes：committed PR scope 必須使用 three-dot `origin/main...HEAD`（或 resolved target-base 的 merge-base-to-HEAD 等價形式）；四者再合成單一 normalized manifest，且所有 probes 都必須執行。
2. Manifest state 僅可為 `known-empty`、`known-nonempty` 或 `unknown`。只篩選 root `AGENTS.md` 與 nested `.devpro/agent-rules/**/*.md`。
3. `DEVPRO_PR_TOUCHED_RULE_FILES` 只能作 exact-list assertion seam；它必須和獨立 discovery 結果雙向、忽略排序完全相等。Legacy `DEVPRO_PR_TOUCHES_RULE_FILE` 必須以 migration error 拒絕。
4. A/M/R/C 的 final `newPath` 必須存在、可讀並由 production module 量測；D 或 rename-out 記為 `state=deleted`。
5. 產生 ordered per-file `path/status/bytes/tokens/tier/cap/utilization/registry/guard/verdict/semanticReview` 與 aggregate verdict。Check (r) 直接消費同一 in-memory result，不得重算或讀 proposal。

`known-empty` 輸出 `scope=known-empty; checked=0; verdict=pass`。Required-probe、baseline、path parse、final-path read/measurement、cap/registry/guard 的任何 uncertainty，以及 registry mismatch、guard failure，都必須 fail closed 並指出 probe/path/reason；assertion 不得把 `unknown` 修復為 known。Objective over-cap alone MUST NOT fail closed on the ordinary PR/pre-PR/test path：`verdict` 維持 pass，gate 以 soft-warn（字面含 `cap-pressure=over` + path）或 per-file `utilization > 100` 供 governance 消費。

取捨原則仍是有用且 load-bearing 的 clarity > raw compression；先移除無用、重複、低訊息密度內容。Ordinary change **MUST NOT** hard-trim-for-cap：不得僅為迎合 cap／壓 utilization 把執行順序、停止條件、分岔或其他 valued／normative meaning 壓成需要重建推論的 shorthand。Over-cap mitigation options（移出可獨立內容、trim 真冗文、拆 scope、調整 cap / per-file override）屬 governance accepted-finding 路徑；ordinary path 對 AGENTS HARD／rule over-cap 採 soft-warn（`cap-pressure=over`），不 fail closed。

其中「移出可獨立內容」與「拆 scope」是拆分：動手前先依 `doc-split-and-dedup-sop.md` 的決策 gate（前置三題；先 trim、trim 不足才拆）判斷，三題未全 yes 即不拆。gate 未通過、也沒有真冗文可移除時，依下方最小必要公式調 cap 就是正當處置——它表示 tier 預設 cap 對該檔的內容量偏低，不是應該迴避的結果。

**最小必要 CAP 公式（SSOT）**：只有前述方法會損失 load-bearing clarity 時，`cap/tier override` 才是 last resort（governance-owned）。Token carrier 使用 `Math.ceil((actualTokens + 250) / 500) * 500`；byte-governed `AGENTS.md` 使用 `Math.ceil((actualBytes + 875) / 1750) * 1750`。必須先以完整 faithful actual carrier 重算，再採公式所得最小 cap，同步 production registry、`READABILITY_CAP_GUARDS` 與鄰近測試 rationale；不得先壓低內容迎合 cap，或選高於公式的值。

## Semantic Review Signal

- utilization < 80%：`semanticReview=not-triggered`
- utilization >= 80%：`semanticReview=required`，review actual carrier — **advisory-signal only**（ordinary PR／pre-PR 無強制壓縮式 semantic review 義務；不得因本信號擋 merge）

**Actual-carrier cooperative readability review**：governance／cold-read 直接預讀完整 actual carrier，確認 AI 無須 reconstructive inference 即可辨識必要次序、failure/stop behavior、branch alternatives、authority、例外與其他 load-bearing normative meaning；發現缺口就修 carrier 或採最小必要 cap，不把答案抄進 proposal/manual artifact。

80% 僅是 advisory review signal。Gate 不得產生 semantic PASS/FAIL；Machine tooling MUST NOT produce semantic PASS/FAIL。Gate 也不得寫 evidence sidecar，且不得要求 proposal 內的 coverage、estimate、cap、mitigation、readability、N/A 或 substitute manual evidence。Governance audit／convergence 擁有 ≥80% cold-read 掃描與 accepted-finding remediation。Cap、guard、公式、carrier set 維持 production SSOT。

## Exit Criteria

1. Authoritative manifest state 已知，或以明確 probe/path/reason fail closed（integrity／unknown）。
2. 每個 actual carrier 都有 deterministic machine record；deleted carrier 不做 estimate。
3. Source 與 consumer 對相同 manifest 與相同 bytes 產生 deep-equal ordered objective records 與 aggregate verdict。
4. >=80% 只標示 advisory `semanticReview=required`；over-cap alone 不使 ordinary path fail closed；proposal 與 artifact type 不影響 objective verdict。

## Common Rationalizations

**「legacy artifact 已有 estimate，可直接採用」** → estimate 不是 final carrier state；production module 的 actual-file result 才 authoritative。

**「consumer 不需要 token gate」** → token check 是 cross-profile deterministic；identity 只影響 source-governance topology/cadence。

**「env assertion 已列檔案，可跳過 Git probes」** → assertion 只驗證 discovery；required probes 仍須全部成功且集合完全相等。

**「80% 代表機械 semantic pass/fail 或普通 PR 必須壓縮」** → `semanticReview=required` 是 advisory-signal only；ordinary PR 無強制壓縮義務。

**「為了不 over-cap，先把 load-bearing 內容壓短」** → ordinary hard-trim-for-cap 禁止；先走 governance accepted finding，必要時依最小必要公式 last-resort override。

## Verification

```bash
node .devpro/scripts/tests/rule-token-budget.test.mjs
node .devpro/scripts/tests/pre-pr-archive-gate.test.mjs
! grep -Eq "^## Token Budget Check$|估算後 byte|Readability Precheck（>=80%）" .devpro/agent-rules/proposal-template.md
grep -E "advisory-signal only|soft/governance|hard-trim-for-cap|cap-pressure=over" .devpro/agent-rules/token-budget-precheck.md
```
