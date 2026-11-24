---
name: proposal-template
description: OpenSpec proposal/proposal-mini template for archive/pr gates.
---

# Proposal Template

## Overview

Hook-enforced OpenSpec proposal headings and PR/archive gate evidence. proposal 語意＝Why/What（動機指向 brd + What Changes scope）；**How 不屬 proposal**——施工圖級 How（怎麼做、tradeoff、風險、遷移）寫入 `design.md`，見 `design-template.md`（角色差異白話 SSOT：`openspec-quality-doc-formats.md` §裝潢比喻）。

## When to Use

Use when writing `proposal.md` or `proposal-mini.md` after `devpro:change` step 4.

## Seams-first + Seams Confirmation

長文 Target State／Requirement Ledger **展開前**，MUST 先鎖可觀測驗收面（外在行為／grep／scenario／prove-it）並經使用者確認。合成品質（只轉錄已決／`UNRESOLVED:`）→ pointer `openspec-quality-and-formats.md` Synthesis mode。

寫入 active change `meeting-notes.md`（有界；禁 PII／transcript）：

```markdown
## Seams Confirmation
- seams: ≤15 bullets; each ≤200 chars; observable done-when only
- confirmed: false | true
- provenance: user
- bypass: none | ask-first-recorded
- bypass_reason: ≤200 chars; **MUST non-empty when bypass=ask-first-recorded**; empty only when bypass=none
- seams_fingerprint: exactly `sha256(canonical(seams))` hex (64 chars); free-text labels forbidden. Canonical = NFC + LF newlines + strip trailing spaces per line + trim trailing newlines. Helper: `computeSeamsContentFingerprint` in `.devpro/scripts/lib/clarification-contract.mjs`. Fingerprint means **user-confirmed seams content** — not a recomputable label you may refresh alone.
- reconfirm_required: false | true
- invalidation_reason: none | seams-change | frontier-change
```

- 長文／Ledger 前：`confirmed=true` 且 `reconfirm_required=false`（或 `bypass=ask-first-recorded` **且** `bypass_reason` 非空）。無證 bypass **禁止**；`ask-first-recorded` + 空 `bypass_reason` **禁止**。
- **frontier 或 seams 變更**後 MUST `reconfirm_required=true` 並設 `invalidation_reason`（`seams-change`｜`frontier-change`）；再展開前須 reconfirm。Pending reconfirm 合法形狀：`confirmed=false` + `bypass=none` + `reconfirm_required=true`（**禁止**為過 validator 而假寫 bypass）。`confirmed=true` + `reconfirm_required=true` **禁止**（stale confirm）。Executable expansion gate：`seamsExpansionAllowed` in `.devpro/scripts/lib/clarification-contract.mjs`。**機械內容綁定（#2480）**：`validateSeamsConfirmationFields`／`seamsExpansionAllowed` MUST 重算 `sha256(canonical(seams))` 並與 `seams_fingerprint` 比對；不符 → 形狀無效、expansion blocked（等同忘立 `reconfirm_required` 的 fail-closed）。自由文字 fingerprint **禁止**。**mismatch 修復路徑（MUST）**：先設 `reconfirm_required=true` + `invalidation_reason=seams-change` + `confirmed=false`，取得使用者 reconfirm **之後**才可更新 `seams_fingerprint` 為新的 `sha256(canonical(seams))`；**MUST NOT** 只重算 hash 清錯誤（否則 silent seams edit + rehash 仍綠，fingerprint 不再代表 user-confirmed seams）。
- **MUST NOT** 削弱 archive／`openspec validate`／prove-it gate bar（只調作者順序）。Executable check：`.devpro/scripts/lib/clarification-contract.mjs`（未知 `- key:` 欄 fail-closed）。
- **operator-usage-before-packaged-default**：observable done-when is not a substitute for operator usage。編號 packaged default **與** `dp-analyst` 前 MUST 產出五欄白話卡並取得「請確認或改」（確認前即擋，與是否尚無 `UNRESOLVED:` 無關；僅 `UNRESOLVED:` 欄可問；確認後五欄全部進 Clarification `decisions:`＋做成後另轉 `seams:`；SSOT `ambiguity-scoring.md` §Operator usage probe before packaged default）。以上是 full＋B 的位置，其他需求驅動路徑在第一個實作寫入前確認同一張卡（適用範圍見同節）。複製建立後不可變識別（ID／SKU／slug／FormKey）MUST regenerate 對齊 Create，MUST NOT `{source}.copy`。

## Required Sections

Required hook headings: `## Why`, `## What Changes`, `## Batch Approval Ledger`, `## Requirement Ledger`; proposals also carry Issue Anchor and any topology-triggered source-governance headings below.

```
# Proposal: <change-name>

issue: #<N>  <!-- optional, single or space-separated -->

## Why

<2-5 句：現況、影響、為何現在做>

## What Changes

<範圍 + 性質（fix/feature/refactor/chore）+ gate 數量>

## Batch Approval Ledger

<未使用 batch approval 時寫 `N/A: no batch approval selected`.>

```yaml
kind: same-change-dp-change-batch
named_change: <change-name>
branch: <branch-name>
repo_scope: same-repo
covers:
  - worktree
  - local_commit
  - pre_pr_gate
  - first_push
  - pr_create_update
  - workflow_watch
  - post_pr_completion_gate
  - scenario_walkthrough
excludes:
  - merge
  - release
  - destructive
  - secrets
  - cross_repo_write
```

Batch approval prose MUST NOT narrow this ledger. With `same-change-dp-change-batch`, do not mark covered worktree/local commit/same-branch push/PR/watch/post-PR or `scenario_walkthrough` out of scope unless `excludes` says so; merge/release/destructive/secrets/cross-repo write stay separate. Scenario Walkthrough transfers to AI only when the ledger exactly matches the active named change, branch, and same-repo scope, explicitly covers `scenario_walkthrough`, `excludes` does not contain `scenario_walkthrough`, and no custom scope or coverage statement contradicts that coverage; otherwise the decision remains user-owned.

**full 中途改 stepwise**：使用者中途撤回 batch 或改成 stepwise 時，TL MUST 在下一個原 covered write 前保留 `## Batch Approval Ledger` 標題，將整段 ledger 內容替換為 `N/A: no batch approval selected`；MUST NOT 留下舊的 `kind`／`covers` 或沿用原 matching ledger。後續 git／PR write 回到逐步確認。

Write the ledger only after the user chooses batch approval at Step 0; for stepwise or an unanswered choice write `N/A: no batch approval selected`. The gates verify only format, change name and branch and cannot prove the user chose batch approval; that residual is the named exception in `design-core.md` §11 `batch-scope-record-residual`, with the ledger visible in the PR diff as the compensating control.

## Requirement Ledger

| ID | Root Requirement | Parent Requirement | Current Requirement | Disposition | Owner / Next Step |
|---|---|---|---|---|---|
| R1 | <root source + summary> | <parent PR/archive/R#; first change same as root> | <this change scope> | implemented / partial / deferred / rejected / moved-to-issue | <this PR / issue #N / owner / next action> |

Ledger cells use summaries and MUST NOT contain an unescaped `|`; escape a literal pipe as `\|`, use `/`, or cite a source. Requirement Ledger MUST be a 6-column markdown table; bullet lists are not accepted by archive gate (m).
ID 必須為 `R<N>` 格式. Tasks cite exact IDs only; never ranges such as `[Req: R1-R7]`.

**Deferred sibling live carrier（#2492）**：Disposition 為 `deferred` 或 `moved-to-issue` 且仍需 follow-up 時，`Owner / Next Step` **MUST** 指向 live tracking carrier（`notes/session-pending.md` 的 H2 標題、GitHub issue #、或 Program dashboard／Backlog／phase key）——**MUST NOT** 只寫「另案／later／Non-goals」。Non-goals 可記範圍邊界，但不得當唯一追蹤面；SSOT → `session-pending-lifecycle.md` §Deferred sibling live carrier（#2492）。

## Capabilities

### New Capabilities

<若無新增 capability 寫「無新增 capability。」>

### Modified Capabilities

<若無修改 capability 寫「無修改 capability。」>

## Section 1: Target State (Done When)

<grep-able 條目，含具體 anchor>

> **Guard：Target State 不得塞 How**。條目只列可觀測 done-when（grep anchor / test pass / 檔案存在），**不得**寫實作步驟或施工圖級 How——How → design.md（超一句／需比較行為相關選項即升 full B，見 `chore-classification.md` 分水嶺）。

> **Guard：第二意見 handoff 上限**。`build-pr-sticky-handoff.mjs` 把 Target State 條目當 `done_when`，上限為 ≤32 條、每條 ≤1024 UTF-8 bytes；PR 描述 `## Change Context` 當 `scope_summary`，上限 ≤4096 UTF-8 bytes（約 1,365 個中日文字，單行）。超過時 builder 以 `handoff_limit_exceeded` 在任何寫入前拒絕（上限常數來自 `validate-second-review-packet.mjs`，本處只是提醒）。

## Section 2: Touch

| 檔案 | 類別 | 動作 | Requirement |
|---|---|---|---|
| <path> | rule / code / test / spec | add / modify / delete / rename | R<N> |

不動清單：<不改的檔案 + 理由>

**Self change-folder paths（MUST）：** Touch／file-list **表格列**若指向**本 change folder 自身**產物，MUST 寫成歸檔後路徑形狀 `openspec/changes/archive/<YYYY-MM-DD>-<this-change>/…`（日期可先用字面佔位 `<YYYY-MM-DD>`），或改以非表格佔位敘述／列入不動清單並說明為何不列表格列。**MUST NOT** 寫 active 路徑 `openspec/changes/<this-change>/…`（不含 `archive/`）——歸檔後會觸發 `archived-touch-path-hygiene`，且 archive transition byte-equality 無法事後修。機械閘：`lint-proposal-touch-self-path.mjs`（pre-archive／`--pre-review`）。

## Section 3: Tasks

Full change 的唯一 executable task ledger：見 [`tasks.md`](./tasks.md)。本節只可放 non-executable pointer／scope 摘要，MUST NOT 放 top-level task checkbox（`- [ ]` / `- [x]`）。

## Consequence Assessment

Full change 必要（`risk_classes` 值無關，含 `none`——`classifyBoundedRereview` 的 `parseSafetyObligations` 對每個 full change 無條件要求本段連同下段；B-mini 不需要）：

| Dimension | Consequence |
|---|---|
| Security/trust/privacy/data | <此變更對安全/信任邊界/隱私/資料的具體影響，或「無」> |
| Material negatives/non-goals | <明確不做什麼、已知取捨或殘留風險> |

## Risk Classes and Material Negatives

Full change 必要（`risk_classes` 值無關；B-mini 不需要）。逐條列出 front matter `risk_classes:` 每個值對應的具體義務或殘留風險：

<bullet list，每條對應一個 risk_classes 值>
```

### B-mini Section 3 variant

B-mini 不建立 sibling `tasks.md`；`proposal-mini.md` 的 inline `## Tasks` 是唯一 executable task ledger：

```markdown
## Tasks

- [ ] [Req: R1][agent:<role>][status:ready] T1：<做什麼>
  - 驗收：<可觀測證據>
```

## Pre-architect Checklist

Before dp-architect review, TL self-checks:

1. **AGENTS.md 觸發式載入索引 entry**：new rule/template/skill has index/touch evidence.
2. **mechanical gate 整合點**：new gate names hook path / `devpro:pre-pr` step / check letter.
3. **Section 1 grep-anchor literal**：Target State uses grep anchors.
4. Ledger is 6-column; canonical task ledger uses exact `[Req: R<N>]`; non-implemented rows have owner / next. Full proposal Section 3 is pointer/summary only; B-mini uses inline Tasks without sibling `tasks.md`.
5. `## Issue Anchor Verification` exists. Source File-Role Ledger / Dedup Audit headings exist only when proven source topology triggers them; consumer proposals omit them.
6. **existing-SSOT lookup**：作者若新增具名定義，Ledger／design MUST 列出已查 existing-SSOT（或「first-use in place」）。lookup 是 TL／reviewer 職責，不委派 `dp-programmer`／`dp-assistant`。
7. Full change only: `## Consequence Assessment` (with both `Security/trust/privacy/data` and `Material negatives/non-goals` rows) and `## Risk Classes and Material Negatives` exist — `classifyBoundedRereview` requires both unconditionally for every full change; run `node .devpro/scripts/validate-openspec-change.mjs <name> --risk-shape-probe` after committing to catch a gap before pre-PR Step 3. B-mini exempt.

## Issue Anchor Verification

Verify cited anchors against current repo evidence.

| Issue 引用 | current repo grep result | 判定 |
|---|---|---|
| <anchor> | `grep -F "<anchor>" <file>` → <hit count> @ <file:line> | 現況違規 / 已修 / 不存在 |
| ... | ... | ... |

## File-Role Ledger

Only for proven source topology that triggers delete, rename/copy, split, merge/collapse, or cross-file dedup, list each bounded carrier:

| 檔案 | routing trigger / role | split-gate rationale | duplication classification |
|---|---|---|---|
| <file> | <trigger> | <split rationale> | true duplication / leaf-self-contained / cross-runtime fallback |

## Dedup Audit 三步結果

Only when the same proven source topology triggers governance evidence, record the three-step audit:

1. 守則 3「leaf 自含 > DRY」+ 守則 4「token-first」評估。
2. `grep -r '<phrase>' .devpro/scripts/tests/` 找隱性約束。
3. 每 hotspot 判定 token-first violation 或正當冗餘。

For ambiguous bounded source topology, use the exact anchored attestation `Source-Governance-Action: none|split|delete|merge|dedup; carriers=<exact comma-separated paths>; evidence=<status/path tuples>`. `none` applies only to ambiguity and cannot suppress a definite trigger. Proven consumer and non-triggering source proposals omit both governance headings and the attestation; do not add substitute evidence. Unknown identity with a bounded candidate blocks for identity evidence; unknown identity without a bounded candidate also omits headings, attestation, and N/A.

## Exit Criteria

- `## Why`, `## What Changes`, `## Requirement Ledger` exist.
- `pre-pr-archive-gate.mjs` checks (c)(m) pass.

## Cross-References

- `openspec-flow.md`（step 4 / 5 產出時點）
- `openspec-step-1-to-9.md`（step 7 archive 前驗證）
- `pre-pr-archive-gate.mjs`（mechanical gate checks (c)(m)）
- `design-template.md`（施工圖級 How 的落點；proposal 不承載 How）
- `openspec-quality-doc-formats.md`（裝潢比喻角色差異 SSOT + design.md 格式定義）
