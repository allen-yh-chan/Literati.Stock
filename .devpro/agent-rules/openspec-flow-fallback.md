---
name: openspec-flow-fallback
description: TL 單 context fallback workflow — subagent 不可用 / Others runtime 主路徑時跑 OpenSpec devpro:change lifecycle 用。內含 pre-flight checklist + design checklist + tasks 規範三段 mini workflow。
---

# OpenSpec Flow Fallback（TL 單 context）

## Overview

本檔定義 **TL 單 context lifecycle**：當 dp-analyst / dp-architect subagent 不可用，或 Others runtime（無 subagent 機制）作為主路徑時，TL 自行跑完整 `devpro:change` OpenSpec 流程。

功能上與 subagent-capable runtime 的雙 subagent 路徑等價，差別在於職責由 TL 一人承擔，不委派。本檔為三段 mini workflow 的詳細操作手冊。

## When to Use

以下三種情境觸發本 fallback：

1. **dp-analyst 失敗 fallback**：subagent-capable runtime 委派 dp-analyst 發生 terminal failure（runtime-reported quota 耗盡、terminal 工具錯誤、runtime-contract task timeout），TL 接手執行 pre-flight checklist + brd.md 撰寫。TL-selected wait/poll timeout MUST NOT count as runtime terminal timeout; a TL-caused interruption MUST NOT count as call failure or trigger fallback, and MUST first follow the recovery path in `model-delegation-active-lifecycle.md`.
2. **dp-architect 失敗 fallback**：subagent-capable runtime 委派 dp-architect 發生 terminal failure（runtime-reported quota 耗盡、terminal 工具錯誤、runtime-contract timeout），TL 接手執行 Design checklist + proposal.md 撰寫。任何 JSON `status: failed`（有效 dissent 與契約錯誤）MUST NOT 觸發本 fallback。
3. **Others runtime 主路徑**：subagent 不可用之 IDE assistant runtime（對應 adapter 見 `platform-adapters/<runtime>.md`），TL 單 context 直接跑本檔三段流程

## Process

### Mandatory Clause Enforcement Map

Principle 6 對本 fallback leaf 的強制語氣採下列 carrier；若新增 MUST / 必須 / 禁止 類條款，須同步更新本表或標 `cooperative-only`。

| Mandatory clause group | Enforcement carrier |
|---|---|
| subagent 不可用不得跳 gate | `platform-adapter-contract.md` role fallback + `openspec/specs/cross-runtime-parity/spec.md` Subagent Mechanism scenarios；runtime 是否能委派屬 cooperative-only process boundary |
| pre-flight checklist / branch verb SSOT | `preflight-checklist.md` marker + `openspec-flow-fallback-verb-ssot.test.mjs` |
| proposal `## Why` / `## What Changes` headings | `pre-pr-archive-gate.mjs` check (c) + `dp-architect-template-alignment.test.mjs` |
| tasks quality / prove-it ordering | `openspec-quality-and-formats.md` SSOT + `openspec/specs/openspec-flow/spec.md` tasks-quality scenarios; task semantic quality remains cooperative-only reviewer/process enforcement |
| rule-doc dogfooding self-check | `pre-tool-gate.mjs` Gate P for OpenSpec docs + `strengthen-openspec-flow-rules-grep.test.mjs` |

### 段一：Pre-flight Checklist（dp-analyst 職責內容化）

建立 OpenSpec change 前，TL 必須逐一確認以下 checklist。任一項不符 → 停下釐清，**禁止**擅自填補或繼續建 change。

1. **一動詞一 scope**：change 名稱含 "and"／「順便」／多個互不相關動詞 → 拆為兩個 change（例：「加 retry 並重構 logger」→ `add-retry` + `refactor-logger`）
2. **動詞白名單**：動詞清單（含語意區隔與 `chore/bump-v<X.Y.Z>` 例外）以 `preflight-checklist.md` 點 2 為 SSOT，本檔不重複列舉
3. **Starting state**：確認並記錄當前版本、相關現存檔案路徑、最近相關 commit SHA
4. **Target state（"done when"）**：寫出 3-5 條可驗收條件；禁止模糊目標（「改好了」「正常運作」不算）
5. **Touch / Don't touch**：列出預計修改檔案清單 + 明示不會動的檔案；實作中若需改動未在清單上的檔案 → 停下重新確認 scope
6. **預估 task 數**：依需求描述估算 task 總數。> 7 時**建議**拆為 sub-changes；堅持單一 change 須記錄「不拆原因」
7. **Prior attempts（bugfix 類必含）**：`bugfix/` 類 change 必含「已嘗試過的方案 + 失敗原因」；**首次修復可填「無先前嘗試」**
8. **Archived decisions 檢查**：以關鍵字 grep 搜尋 `openspec/changes/archive/` 中與本 change 主題相關的已 archive decisions；若有衝突須在 proposal 中明示處理方式
9. **Rule-doc dogfooding self-check**：寫描述新 Never / PII / output-discipline 規則的 `proposal.md` / `proposal-mini.md` 後 commit 前，依 `preflight-checklist.md` 點 9 對自身執行 Example Sanitization canonical check

完成後寫入 `openspec/changes/<name>/brd.md`，格式含：問題陳述、業務目標、功能需求、非功能需求、範圍界定（In/Out）、Pre-flight 驗證結果表。

### 段二：Design Checklist（dp-architect 職責內容化）

讀取 brd.md 後，TL 進行設計，寫入 `openspec/changes/<name>/proposal.md`。

- **`## Why` + `## What Changes` 必含**：proposal.md MUST 含 `## Why` + `## What Changes`（per `proposal-template.md` §Required Sections；archive gate (c) 強制，缺則 exit 1 block）
- **Target state 3-5 條 done-when**：每條須為可觀測證據（測試通過、API 回傳值、檔案存在等）；禁止「完成實作」類模糊條件
- **Touch list 明確化**：列出每個修改/新增/刪除的檔案路徑 + 變更類型 + 對應功能需求編號
- **Token Budget boundary**：proposal 僅列 touch scope，不承載 Token evidence；pre-PR checks (e)/(r) 依 `token-budget-precheck.md` 直接量測 actual carrier。
- **Source-governance basic matrix**：proven consumer（含 adopted carrier rename/delete）跳過 gate 並省略 File-Role Ledger／Dedup Audit／N/A；proven source 只有 delete、rename/copy、split、merge/collapse、cross-file dedup definite/attested 才寫兩章，ordinary lone M／independent A 省略；ambiguous bounded topology 需 exact `Source-Governance-Action` attestation，不能判定則停下；unknown identity 有 bounded candidate 時 fail closed，無 candidate 時省略 headings／attestation／N/A 且不 hard fail。
- **Task outline 排序**：依邏輯依賴關係排序 task；bugfix 類須將「prove-it test task」排在修復 task 之前；強調檔案隔離（不同 task 盡量不 touch 同一檔案）
- **Inbound/outbound network zone（DMZ IN/OUT）**：功能同時含 inbound 接收與 outbound 反向呼叫時，依 `change-consequence-assessment.md` §Workflow/state/ops 評估目標部署是否存在 DMZ IN/OUT（或等效 inbound/outbound 區隔）；分離可能存在時 **MUST** 將 Relay Service（或等效內部轉發）納入方案選項——pointer only，正文 SSOT 在 consequence leaf。

### 段三：Tasks 規範

寫入 `openspec/changes/<name>/tasks.md`。每個 task 必須符合以下規範：

- **做什麼**（一句話，含動詞 + 受詞 + 範圍）
- **驗收條件**（可觀測的證據：測試指令全綠、grep 確認關鍵字存在、API 回傳正確 HTTP 狀態等）
- **禁止**模糊描述：`[ ] 實作功能` / `[ ] 修改程式碼` 不符合規範
- task 完成勾選時**必須**已滿足驗收條件；未滿足**禁止**勾選
- **bugfix 強制項**：tasks.md（或 B-mini 的 `proposal-mini.md` inline `## Tasks`）必須包含至少一個 prove-it test task（撰寫能重現 bug 的 failing test），且排序先於修復 task

範例格式：
```
- [ ] 新增 GET /api/users/{id} endpoint
  驗收：unit test 驗證 200 回傳正確 DTO、404 回傳非存在 ID；專案約定測試指令全綠
```

## Exit Criteria

- `openspec/changes/<name>/proposal.md` 已寫入，含 `## Why` + `## What Changes` 兩段（archive gate (c) 強制必含）、Target state（3-5 條 done-when）與 Touch list
- `openspec/changes/<name>/tasks.md` 已建立，每個 task 含「做什麼 + 驗收條件」
- `openspec/changes/<name>/brd.md` 已建立，Pre-flight checklist 驗證結果表格完整
- Token budget 由 pre-PR gate 對 actual carrier 執行；proposal 沒有 Token evidence。
- Source-governance headings 僅依 proven identity + bounded operation evidence 觸發；不得由 proposal prose keyword 或 consumer adoption carrier action推論。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「我直接寫不用 pre-flight，需求很清楚了」 | Pre-flight checklist 不只是「釐清需求」——點 7（prior attempts）防止重蹈覆轍，點 8（archived decisions）防止與已有決策衝突。跳過 pre-flight，同一 bug 可能第三次出現。 |
| 「target state 模糊一點 OK，反正做完了就看得出來」 | 模糊 target state 導致兩個問題：(1) reviewer 沒有客觀標準可以 approve；(2) scope creep——「做完」的定義在實作中不斷漂移。3-5 條可驗收條件是最低門檻。 |
| 「task 數超 7 不拆吧，拆了要管兩個 PR 很麻煩」 | > 7 tasks 通常代表 scope 已含兩個獨立的業務目標。拆開的好處：(1) 每個 PR 更容易 review；(2) 其中一個失敗不影響另一個上線；(3) token budget 壓力分散。若有強耦合 atomic 理由不拆，必須在 proposal 明確記錄「不拆原因」。 |

## Verification

```bash
# 1. brd.md 存在且含 Pre-flight 驗證結果表
ls openspec/changes/<name>/brd.md && grep -c "Pre-flight" openspec/changes/<name>/brd.md

# 2. proposal.md 含 ## Why + ## What Changes + Target state + Touch list（per proposal-template.md §Required Sections）
grep -E "^## Why$|^## What Changes$" openspec/changes/<name>/proposal.md
grep -E "done.when|Target state|Touch" openspec/changes/<name>/proposal.md

# 3. tasks.md 每個 task 含驗收條件（grep 確認「驗收：」字樣）
grep -c "驗收：\|驗收:" openspec/changes/<name>/tasks.md

# 4. bugfix 類：prove-it test task 存在（含 B-mini fallback）
grep -i "prove-it\|failing test\|重現 bug" openspec/changes/<name>/tasks.md openspec/changes/<name>/proposal-mini.md 2>/dev/null

# 5. Token Budget：production gate 直接檢查 actual carrier
node .devpro/scripts/tests/rule-token-budget.test.mjs
```
