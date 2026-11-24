---
name: code-review-checklist-fallback
description: TL 單 context fallback（dp-reviewer／Others 不可用時六軸＋security）。
---

# Code Review Checklist Fallback（TL 單 context）

## Overview

dp-reviewer/Others不可用時，TL自行跑六軸。

Severity：**Critical**／**Important**（in-scope／未標者皆擋 seal／approve，禁 defer 關閉；範圍外見 R11）、**Suggestion**（可 disposition）。

> **Scope caveat — accident-prevention 閘門例外：依治理對象二分**（本文 SSOT `design-core.md` §11）：流程遵循類閘**自然指令** false-positive/false-negative 可升 Critical；只靠**對抗性 shell 等價 bypass** 才繞過的 gap 最多 Suggestion/deferred。安全合規產出類（§11 floor 六項：PII／attribution 品牌洩漏／憑證機敏／產品安全掃描／授權合規／閘可見性）仍 **security/compliance** fail-closed；未列入前者歸此類。**MUST NOT** 自行把 `repo-scope-consent`（跨 repo 同意）或 `destructive-ref-and-history-rewrite`（force-push／ref 刪除）改判此類——二者是 §11 class one 第 6、7 條，其 fail-closed 由軸 B 與 no-downgrade 保住，非靠改分類。fail open/closed 另依不確定性種類：解讀不確定→fail open；證據缺漏或格式不完整→fail closed。
> **Requirement anchoring（R11）**：TL 單 context review 時 TL 同時是提出者與把關者，故兩側義務都落 TL。MUST 先寫「本包目的＝…；done_when 共 N 條」；每條 finding 標 exactly one `requirement_scope`（`in-scope`／`out-of-requirement`／`scope-unresolved`）並具名 referent，無 referent 視同未標；`out-of-requirement`／`scope-unresolved` 不進本包 Critical／Important 分級（後者須註明需 TL 裁示），改記待辦並保留原 severity（正交；禁因 `scope-unresolved` 強制 Suggestion）。class-two 缺陷／overclaim／spec↔code 矛盾恆 in-scope。收據側處置（`out-of-requirement` 可 `tracked-follow-up` 關閉、`scope-unresolved` 需 `decisions.md` `## Scope Rulings` 綁定裁示、defer 永不關閉）見 `code-review-checklist.md` R11。完整三問見 `openspec/specs/code-review-checklist/spec.md`。

## When to Use

dp-reviewer/Others unavailable或BLOCK修復：TL persist-first。新 report 的保證評估依 `review-guarantee-ceiling.md`：TL 寫固定 section 並跑 `review-guarantee-assessment.mjs <report> --target <exact-target> --dispatch <exact-id-or-none>`；missing／unresolved 先補齊澄清，above-ceiling 記有理由的裁示；無 authority 用 `none`，不造 seal。

## Bounded Review Remediation Routing

SSOT=`code-review-checklist.md` §Bounded Six-Axis Rereview Cadence。First/invalid=>full；classifier derives三欄。Bounded=receipt path+finding_id/observation_hash+repair delta+immutable dependency-closure；automatic cap=3／stall 可收斂時由同 thread focused `convergence_recovery` 繼續（非預設 handback）；真 handback 僅 `requirement_conflict`／`irreversible_high_risk`／`reviewer_unrecoverable`，exact single-use override 在沒有 independent reopen 時只續一輪 bounded，只有 exception/outside/Critical 等既有 mandatory-full condition 才 full；raw first→seal receipt_payload；same-agent optimization MUST NOT be correctness authority。
Post-cap bounded receipt 必須有同 responsibility＋dispatch 的 consumed override claim，或由 chain walk 證明 classify 簽發的 `convergence_recovery` 綁定同一 dispatch＋repair／closure manifest、且 predecessor 非 `handback_authorized_*`；seal／chain walk 缺 proof 即 fail closed。
Committed active primary full precedes archive。Valid Git/durable transition=>`direct|archive_transition`/no second reviewer；invalid/non-equivalent/later commit=>full reopen。stale final evidence只阻readiness；savings/causal effect unknown。

## Process

### 軸 1：功能正確性

**判斷要點**：

- 若 PR 含 proposal.md / tasks.md：變更是否符合其 touch list 與 target state 描述？是否有 touch list 未列出的檔案被修改？task 驗收條件中承諾的改動是否缺失？
- 若無 proposal（lite／chore/ 前綴車道）：PR description 是否清楚陳述變更目的、影響範圍與驗收條件？PR file scope `git diff <target-base-ref>...HEAD --name-only`（三點；或等價 merge-base→HEAD diff）結果是否與描述一致？
- 邊界條件與例外路徑是否處理？有無邏輯遺漏（只處理 happy path）？
- **Root-cause adequacy**：PR 改 ≥ 5 行 enforcement 路徑 → proposal / PR description 是否陳述 root cause（非僅 symptom）？surface fix 標 Important；明顯 whack-a-mole 標 Critical。豁免：trivial typo / formatting / chore A（對齊類除外）。**accident-prevention 閘門例外**：對抗性 shell 等價 bypass 未窮舉不升 whack-a-mole Critical；自然指令誤擋/漏接的同類未修仍可 Critical。
- **N+1 / 大 payload**：loop 內是否有重複 DB call？是否有不必要的大資料集全載（缺 pagination）？

**分級**：
- Critical：修改了 touch list 未列且與 scope 無關的檔案；明顯 N+1 query 在高流量路徑
- Important：touch list 有列但實際改動超出描述範圍；缺邊界條件/例外路徑處理；root-cause surface fix；chore A 類 PR description 不清楚
- Suggestion：小幅超出但有合理關聯；可用 caching 優化但非必要

**Evidence**：PR file scope `git diff <target-base-ref>...HEAD --name-only` 對比 touch list（有 proposal）或 PR description（chore A）；專案約定測試指令全綠

### 軸 2：可讀性與架構

**判斷要點**：

- 命名是否符合既有代碼慣例（camelCase / PascalCase / kebab-case 依語言約定）？大括號是否符合 K&R？
- 是否違反 DRY（相同邏輯出現兩次以上）？C# 現代語法是否合理使用？
- 公開 API 是否有文件註解（.NET `/// <summary>`、TSDoc / JSDoc、Python docstring）？
- 模組間耦合度是否合理？新增依賴方向是否符合既有架構（避免 circular dependency）？
- 抽象層次是否適當？是否過度抽象（YAGNI）或抽象不足（重複邏輯）？
- **NEW named／新具名定義（任何 PR）**：corpus grep 留範圍＋結果／命中；非 self 須 disposition。禁 silent small-diff。cite `dry-ssot-corpus.md`。
- **治理型 PR sub-check（PR 觸及 `.devpro/agent-rules/**`、hook、agent、command 時，對齊主檔 SSOT）**：(a) **SSOT-drift** — 對新增 rule body 抽 anchor 字串（regex literal / placeholder / verb 集合 / row label）跨 repo grep，hit ≥ 2 檔 → Important（豁免 `*-fallback.md`，per Principle 1）；(b) **Promote-class drift** — 升 status/phase label（describe-only→executable、Phase 1→2 等跨 SSOT 鎖死）時對舊 label 字面掃 `openspec/specs/**`、`.devpro/agent-rules/**`、`.claude/{agents,commands}/**`，touch list 外命中 ≥ 1 → Important；(c) **Trajectory sanity** — PR 涉 agent workflow / tool invocation / external reviewer CLI / hook orchestration / cross-model review 時，查 transcript/log/sticky/test：repeated failed commands、wrong execution surface、unsafe retry、permission/schema fault、budget exhaustion、`error_max_turns`/max-turns；final diff 不抵消危險 trajectory，若造成資料損壞/安全暴露/merge-gate bypass/user-visible wasted time，依風險標 Important/Critical。

**分級**：
- Critical：命名與既有系統完全不一致；引入 circular dependency；破壞既有 DI 結構
- Important：DRY 違反；缺公開 API 文件；過度抽象（未來擴充用的 interface 無實際多型需求）
- Suggestion：命名可更語意化；可用更簡潔的 pattern 替換

**Evidence**：無 build warning；符合既有程式碼慣例

### 軸 3：安全

**判斷要點**：

- Query string / URL path / log 是否含 PII（個人識別資訊）？
- SQL 是否全部 parameterized？是否誤用 `.FromSqlRaw()` 搭配字串插值？
- Log / 錯誤訊息是否洩漏憑證（token、API key、密碼）或 PII？
- 第三方套件授權是否在允許清單（MIT / Apache-2.0 / BSD / ISC）？

**分級**：
- Critical：SQL injection 風險、PII 洩漏、憑證硬編碼
- Important：授權未確認；log 含敏感欄位但非直接洩漏
- Suggestion：URL 設計含非必要 user identifier

**Evidence**：PR 說明明確記錄「已檢查 SQL injection ✓」與「已檢查 PII 曝露 ✓」

> Load-chain（存取稽核軌跡 Sub-check，cooperative-only，預設 Important）：client context（Client IP／來源 Port／User-Agent 等）欄位與披露規則見 `security-access-audit-trail.md`。
- **存取稽核軌跡 Sub-check（cooperative-only）**：PR 觸及 client context（Client IP／Peer IP／來源 Port／User-Agent）擷取邏輯、或稽核儲存設計時載入上列 sibling 執行完整核對。SSOT：`openspec/specs/code-review-checklist/spec.md` §Client Context Access Audit Trail Sub-check。

### 軸 4：測試充分性

**判斷要點**：

- 新增行為是否有 unit test？bug 修復是否有先寫失敗測試（prove-it）？
- 測試是否位於獨立測試專案（per `testing-and-qa.md` Exit Criteria）？
- QA scope 是否完整？B-mini 用 `proposal-mini.md` `Tasks` 段 + grep/test evidence。

**分級**：
- Critical：新增行為完全沒有 test；bug fix 沒有 prove-it test
- Important：測試覆蓋不足（缺邊界/例外）；QA scope 缺失
- Suggestion：測試命名不符慣例；缺少整合測試（已有 unit test 覆蓋）

**Evidence**：專案約定測試全綠；QA scope 路徑，或 B-mini `proposal-mini.md` + grep/test evidence

### 軸 5：工作目錄乾淨度

**判斷要點**：

- `git status` 是否有臨時檔殘留（debug script、暫存輸出、探索測試、temp 目錄等）？

**分級**：
- Critical：臨時檔含敏感資料（credential / PII）且已 staged
- Important：temp 目錄或偵錯腳本殘留於 untracked
- Suggestion：非必要的 .DS_Store / editor 暫存

**Evidence**：`git status` 無非預期的 untracked files

### Cross-Platform（條件式）

觸發：diff 涉 `.claude/settings.json` hook commands、`.devpro/scripts/**` `.sh`、rule inline shell command，或 `node:fs` 等 syscall API。

**判斷要點**：

- pattern 是否在 macOS / Linux / Windows（cmd.exe + PowerShell）皆可執行？
- 是否使用 POSIX-only built-ins（`test -f`、`[ -f`、`find . -name` 等）？應改 Node.js APIs。
- Node.js API 封裝的 syscall 是否 POSIX-only（例：目錄 `openSync`/`fsyncSync` 於 win32 無等價）？須平台分支＋揭露。

**分級**：
- Important：POSIX-only built-in；或 POSIX-only syscall 未做平台分支
- Suggestion：`.sh` 檔未加 shebang 或 `set -e`

**Evidence**：hook commands 無 POSIX-only built-in；`cross-platform-hook-commands.test.mjs`、`directory-fsync-portability.test.mjs` 全綠

### 軸 6：Release 影響（條件式）

觸發：新增第三方套件、DB schema 變更、API 契約變更、或版號評估需求。

**判斷要點**：

- 新增第三方套件：授權是否為允許清單內（MIT/Apache-2.0/BSD/ISC）？PR 是否註明 SPDX？
- 涉及 DB schema 變更：`sql/<change-name>/` 是否含對應 SQL script？每個 script 是否有 `-- [ROLLBACK]` 區段？
- 涉及 API 契約變更：是否為 breaking change？若是，PR 描述標記 `[BREAKING]`
- 版號影響評估：屬 Breaking / Minor / Patch 哪一級？「不需要 bump」也須明確說明理由

**分級**：
- Critical：高風險授權（GPL 等 copyleft）；DB schema 無 ROLLBACK script
- Important：授權未確認；breaking change 未標記 `[BREAKING]`；版號評估缺失
- Suggestion：SPDX 標記可更完整

**Evidence**：PR 說明含 SPDX / ROLLBACK script 存在 / `[BREAKING]` 標記

### 審查輸出格式

完成六軸後輸出：

```markdown
### Review Summary
- **Critical**: 0 件
- **Important**: 1 件（軸 2：缺 prove-it test for bug fix）
- **Suggestion**: 2 件（軸 4：命名可更語意化；軸 6：可加 caching）
- **已檢查**: SQL injection ✓ | PII ✓ | 授權 ✓（或 N/A）
```

## Exit Criteria

- 六軸全部完成（條件式軸說明為何不適用）
- Critical 件數為 0（或全部已 resolve；範圍外已關閉者見 R11）
- in-scope／未標的 Important 件數為 0（禁 deferred／tracked-follow-up 關閉後仍 approve／seal）
- 審查摘要已輸出

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「這次 diff 很小，跑六軸太慢了」 | 六軸是固定開銷，小 diff 跑得更快。省的是跑一次的時間，賠的是上了 PROD 才發現 PII 洩漏。 |
| 「軸 3 security 這次不適用，沒有 SQL 也沒有外部 API」 | 「無 SQL」不代表「無安全疑慮」。軸 3 含：PII 洩漏（log）、憑證硬編碼、第三方授權——即使沒有 SQL 也必須確認。 |
| 「BLOCK 了但只有一個 Important，先 approve 再 patch」 | Important 必須修完才能 approve／seal；不可「先 approve 再說」。 |

## Verification

```bash
# 1. Review Summary exists

# 2. Tests green

# 3. 工作目錄乾淨
git status

# 4. QA scope exists
ls openspec/changes/<change-name>/qa-test-scope.md || ls openspec/changes/<change-name>/proposal-mini.md

# 5. diff vs touch list
git diff --name-only main...HEAD

# 6. SQL injection / PII 抽查（軸 3）
grep -rn "FromSqlRaw\|RawQuery\|ExecuteSqlRaw" --include="*.cs" .
grep -rn "console\.log.*email\|console\.log.*password\|console\.log.*token" --include="*.ts" --include="*.js" .
```
