---
name: consumer-local-rules
description: Consumer root AGENTS.local.md additive-only overlay 契約；觸發：寫／讀 local rules、與 source 衝突、doctor overlay、禁手改 AGENTS 例外出口。
---

# Consumer Local Rules

## Overview

Consumer 可用 repo root `AGENTS.local.md`（與 `AGENTS.md` 同層）疊加內容型規範。本契約為 **contract-layer**（cooperative），非機械強制 parser；doctor 僅 INFO／advisory WARN。

自由格式 markdown 檔 `.devpro/pre-pr-checks.local.md`（consumer pre-PR checks）的契約不在本檔，見 `consumer-pre-pr-checks.md`。

第二意見審查規則檔 `.devpro/second-review-rules.local.md`（自由格式 markdown）的契約不在本檔，見 `code-review-cross-model.md` 的 `#### Consumer 審查規則（second-review-rules.local.md）`。

## When to Use

- 撰寫或解釋 consumer root `AGENTS.local.md`
- SessionStart／doctor／AGENTS 入口提到 local overlay
- 「禁手改 synced AGENTS」敘述需合法出口時
- 提到 `.devpro/pre-pr-checks.local.md` 時，契約見 `consumer-pre-pr-checks.md`
- 提到 `.devpro/second-review-rules.local.md` 時，契約見 `code-review-cross-model.md`

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `pre-tool-gate.mjs` 的既有 `pr-body-template-lint`（Gate 4c）：consumer pre-PR checks 適用性與證據格式，豁免段對照作答時紀錄（見 `consumer-pre-pr-checks.md`；不證明測試執行）；`gh pr edit` 改描述時由 `per-pr-waiver-edit-record` 對照，merge 前由 `per-pr-waiver-merge-record` 與 MCP merge 再對照；`gh api` 或網頁改描述不對照，MCP `update_issue` 改不了 PR、不對照 |
| Advisory | doctor overlay INFO／WARN（見 `consumer-adoption.md`）；doctor `pre-pr-checks.local.md` INFO／WARN；doctor `second-review-rules.local.md` INFO／WARN；doctor 對已移除功能或已改名而殘留的舊 `.local` 檔 WARN（目前為 `cross-model-skip-paths.local`、`pre-pr-checks.local`、`second-review-rules.local`） |
| Doctrine | `cooperative-only: additive-only is contract-layer; no runtime parser reject`；`cooperative-only: consumer pre-PR checks execution, whether the user really answered a waiver, and HEAD currency remain human/reviewer judgments; no receipt` |

1. **檔位**：consumer repo root `AGENTS.local.md`（alongside `AGENTS.md`）。缺檔 → **no-op**。
2. **Precedence（additive-only）**：可收緊、**不可放寬** source；衝突 → **source wins**；語意模糊 → **FAIL CLOSED** 問使用者。
3. **誠實邊界**：契約層，非機械強制；不得把 overlay 當覆寫／關閉 source gate 的工具。
4. **職責分工**：`.devpro/rules.config`＝rigor intensity；`AGENTS.local.md`＝內容；兩者獨立。
5. **多檔**：可從 `AGENTS.local.md` relative-link 其他檔；source 不索引／不驗證那些檔。
5a. **Hub session**：從本 repo 啟動 session 去改別的 repo 時，本 repo 的 `AGENTS.local.md` 只管本 repo；動目標 repo 前先讀目標 repo 自己的 `AGENTS.md`／`AGENTS.local.md`（規則見 `ai-autonomy.md` 第 6 項）。
6. **Additive 收緊示例（milestone）**：consumer MAY 於 root `AGENTS.local.md` 要求可促進單位 PR 掛 release-target milestone（`<YYYYMMDD>`）；這是允許的 additive 收緊，MUST NOT 放寬任何 source gate、衝突 MUST source wins、語意模糊 MUST FAIL CLOSED。在 source release-bucket milestone 契約 sync 到 consumer 前，此 overlay 是過渡機制，MUST NOT 用來關閉或繞過任何 source release gate。

> Load-chain（consumer pre-PR checks）：建立、修改或解釋 `.devpro/pre-pr-checks.local.md`、`/devpro:pre-pr` 走到 Consumer Pre-PR Checks Gate、寫或審查 PR 描述的 `Consumer pre-PR checks` 證據行、或該證據行記下的 HEAD 之後又有變動而要更新 PR 或宣稱可合併之前，MUST 先讀 `consumer-pre-pr-checks.md`（該檔執行契約的唯一來源）。

## Exit Criteria

- Overlay 存在時已先讀；缺檔 no-op
- 衝突／放寬語意已 source-wins 或 FAIL CLOSED
- 未用 overlay 關閉／放寬 source gate

## Common Rationalizations

| Rationalization | Response |
|---|---|
| 「這 gate 不適合我們，overlay 關掉」 | **禁止**。正確路徑＝對 source 開 issue／PR；overlay 只可 additive 收緊 |
| 「衝突時以 local 為準比較快」 | 衝突 **source wins**；模糊 FAIL CLOSED |
| 「把 repo 規則寫進 synced AGENTS.md」 | 禁手改 synced／衍生檔；合法出口＝root `AGENTS.local.md` |

## Verification

```bash
test -f .devpro/agent-rules/consumer-local-rules.md
grep -F 'AGENTS.local.md' .devpro/agent-rules/consumer-local-rules.md
grep -E 'additive-only|不可放寬|source wins|FAIL CLOSED' .devpro/agent-rules/consumer-local-rules.md
node --test .devpro/scripts/tests/agents-md-consumer-entry.test.mjs
```
