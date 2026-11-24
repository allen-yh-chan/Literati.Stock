---
name: change-consequence-assessment
description: 比例化 8 維 consequence assessment + closed disposition + 跨 repo auth boundary；觸發：suggestion／rule-feedback 落地、BRD／proposal／design／Ledger 副作用段，或需跨 repo 唯讀證據時。
---

# Change Consequence Assessment

## Overview

比例化 consequence assessment：對 source／consumer 的行為、rule、workflow 變更，用單次可重用 artifact 覆蓋八維，並對每維標閉集 disposition。本 leaf **不**複寫 high-risk taxonomy；taxonomy SSOT 仍為 `openspec-quality-and-formats.md`。

## When to Use

- 撰寫／更新 BRD、proposal、design、Requirement Ledger 的副作用／consequence 段（suggestion／rule-feedback 作者點）
- suggestion／rule-feedback 落地（含上列 artifact）時；不是每個實作 write 都重跑
- 需讀其他 repo 做 assessment 證據時（預設 read-only）

每維 disposition **之前** MUST 引用／比較現況正文（file／symbol；current-state compare 順序 pointer `intent-lookup-order.md`：specs first，無 spec 只標 observed）。未引現況不得 disposition。

Load-chain：high-risk material negatives → `openspec-quality-and-formats.md`；跨 repo write 授權 → `ai-autonomy.md` Ask First／repo scope。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for semantic execution |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


### Proportional Eight-Dimension Assessment

Assessment MUST cover all eight dimensions; each MUST receive exactly one closed disposition:

| Dimension | Notes |
|---|---|
| Direct behavior | 直接行為／契約變更 |
| Callers/downstream | 呼叫端／下游義務 |
| Compatibility/migration | 相容／遷移。舊版雙讀／vN-1／遷移層先套用 `pre-implementation-over-design.md` §`Pre-Ship Contract Dual-Read Ban` holder test；**禁止**為假想（無持有者）舊版相容開 `accepted-in-approved-scope`。Holder 陰性時僅該「舊版雙讀／vN-1／遷移層」子議題可 `non-material-or-na-with-evidence`（證據＝引用 SSOT 陰性結論）；**不得**把整個 Compatibility／migration 維度因陰性一筆勾成 N/A——forward-compat 或其他相容影響仍各自 disposition。 |
| Security/trust/privacy/data | **獨立 disposition；禁併入 grouped N/A** |
| Workflow/state/ops | 流程／狀態／營運；inbound+outbound 同功能時須評估 DMZ IN/OUT（或等效 inbound/outbound 網路區隔）→ 見下節 |
| Cost/performance | 成本／效能 |
| Failure/recovery/rollback | **獨立 disposition；禁併入 grouped N/A** |
| Material negatives/non-goals | 含 material negatives；不得用 Non-goals 逃脫 |

**Closed disposition vocab**（每維恰好一詞）:

- `accepted-in-approved-scope`
- `mitigated-with-verification`
- `deferred-with-owner-and-trigger`
- `non-material-or-na-with-evidence`

**MUST NOT** fold Security/trust/privacy/data or Failure/recovery/rollback into a grouped N/A with other dimensions.

### Critical Safety Assumptions

當安全結論取決於具體執行行為時，MUST 指出決定安全結論的 runtime／library／wire／生命週期假設，並以實際使用版本的程式匯入、小型 probe 或真實產物核對；追間接 consumer 與資料持有者，不只列直接 caller。只驗會改變結論的關鍵假設，不要求八維各跑一次實驗。

MUST NOT 把 caller 搜尋、靜態引用或多數意見當成執行證據；無法執行 MUST 標示未證實與影響，依既有風險與授權規則處置，不虛構 PASS。Probe 沿用同一 assessment evidence，不重建平行收據，也不授權 live process 修改或跨 repo 寫入。

### Workflow/state/ops: Inbound/outbound network zone separation

功能同時涉及 **inbound 接收**（webhook、callback、對外 API endpoint）與 **outbound 反向呼叫**（同一 request 或流程內對外 HTTPS／外部 API）時，Workflow/state/ops 維度 **MUST** 評估目標部署環境是否將 inbound 與 outbound 分置不同網路區段（例如 **DMZ IN**（承接 inbound）與 **DMZ OUT**（可對外打 internet），或等效拓樸）。

- 若目標環境 **可能存在** 此分離（issuer 正式環境、 hardened DMZ、production 等），設計 **MUST** 將 **Relay Service**（或等效內部轉發元件）列為明確方案選項；**MUST NOT** 在未具部署拓樸證據時預設 inbound/outbound 可同機、同 process 直連。
- demo/sandbox 若 inbound/outbound 同機，**不得**據此否定 production 分離；須引用部署拓樸證據，或依 `intent-lookup-order.md` 標 observed/inferred。
- dp-architect 撰寫 proposal／design 時 **MUST** 在 inbound+outbound 觸發時 surface 本檢查；正文 SSOT 在本節。

### High-risk material negatives（pointer only）

High-risk taxonomy／defer 規則 SSOT = `openspec-quality-and-formats.md`。本 leaf **MUST NOT** restate taxonomy body、**MUST NOT** 新增或放寬「containment + informed approval 即可 defer」路徑。僅當既有 high-risk SSOT **已經**授權某一精確 defer 路線時，才可沿該路線；否則 fail closed Ask First。

### Reuse model

單次 assessment artifact 可嵌於 BRD／proposal／design／Ledger；後續階段 MAY cite 既有 digest。**僅**當 material scope、architecture、或 evidence 變更時 MUST 更新；否則禁止重寫全文。

### Cross-Repo Consequence Auth Boundary

- Assessment MAY include **read-only** inspection of other repositories.
- Cross-repo write-class actions（clone／branch／edit／commit／push／open PR）remain unauthorized unless the user grants **named approval** for that write.
- Matching batch ledger that **excludes** `cross_repo_write` MUST NOT be treated as write approval.
- Without named write approval: record adoption disposition with owner + trigger；**MUST NOT** perform cross-repo writes.

## Exit Criteria

- 八維齊全且各有閉集 disposition 一詞
- Security／Failure 兩維為獨立 disposition（非 grouped N/A）
- high-risk 路徑遵守 openspec-quality pointer（未複寫 taxonomy）
- 跨 repo 僅 read-only，或具名 write 批准已記錄

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「八維太長，併成 grouped N/A」 | Security／Failure 禁 grouped N/A；其餘亦須單維 disposition。 |
| 「高風險可先 defer 再說」 | taxonomy SSOT 在 openspec-quality；本 leaf 不放寬 defer。 |
| 「batch 已批，可改別的 repo」 | excludes `cross_repo_write` 時仍禁 write；需具名批准。 |

## Verification

```
test -f .devpro/agent-rules/change-consequence-assessment.md
rg -n "accepted-in-approved-scope|mitigated-with-verification|deferred-with-owner-and-trigger|non-material-or-na-with-evidence" .devpro/agent-rules/change-consequence-assessment.md
node --test .devpro/scripts/tests/change-governance-guardrails-grep.test.mjs
```
