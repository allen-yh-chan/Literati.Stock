---
name: rule-self-evolution
description: "規範自我演進：從 open [rule-feedback] + eligible session-pending 到規範 PR 的可重複收斂流程。觸發：規範自我演進 / rule-feedback／pending ingest / 消費 unified ranked pool 時。"
---

# Rule Self-Evolution

## Overview

open `[rule-feedback]` + **eligible pending** + Session Recap harvest 併成同一 ranked/clustered 候選池，再轉為規範 PR。claim/path SSOT 仍在 `session-pending-lifecycle.md`。

## When to Use

- 跑 `rule-audit-playbook.md` cadence 時順帶檢視 open `[rule-feedback]` 與 eligible pending；corpus-dup 債（非平行）
- TL / dp-architect 消費 unified pool 準備提 proposal 時
- 懷疑多筆 pending／issue 可收斂為單一規範 PR 時

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `rule-self-evolution-grep.test.mjs`（grep：anti-hack + dual-source／selection anchors）|
| Advisory | N/A |
| Doctrine | `cooperative-only`：value-score／cruel-metric／why_not_hack／provenance 推導屬判斷；grep 只守字面 |

### 6-Step Flow

完整流程：**收集 → value-score → cruel-metric → why_not_hack → 去重 → 規範 PR**

1. **收集**：open `[rule-feedback]` + eligible pending + Recap。排除 PR findings／rule-audit audit-only（即使抄進 pending）與有效 `claimed:`。
2. **value-score**：影響範圍 × 證據強度 × 出現頻率（frequency **只計** distinct `evidence_event_ids`）。
3. **cruel-metric**：token/parity/gate/ROI 不退步；**cruel-metric 任一面向退步 → 整筆否決**。
4. **why_not_hack**：每候選至少一條；**why_not_hack 缺失 → 自動拒**。反覆錯誤的修復選擇依 `knowledge-distillation.md` §Structural Repair Before Instructions，交歷史錯法與合法控制；不複製修復優先序或另開 loop。
5. **去重**：corpus + pending + issues 三步 grep；連續 ≥2 輪無可接受候選則 anti-spin halt。
6. **規範 PR**：先完成 selection 契約再寫 OpenSpec/repair；**MUST** 掃 token budget/cap pressure；repair 只做 **accepted-finding-only**；ordinary **MUST NOT** hard-trim-for-cap。

### Dual-Source Ingest + Selection Contracts

| Axis | Contract |
|---|---|
| Eligibility shape | rule-gap + `carrier_hint`／建議落點；禁有效 claimed／產品 deferred／host bug／已覆蓋／純觀察 |
| `source_provenance` | `gate5-recap`\|`dogfood-friction`\|`gh-rule-feedback`\|`unknown`；`unknown`/banned **永不** `batch-now` |
| Linked-group | 任一成員禁源 → 整組不得乾淨放行（除非拆離且剩餘各自合格） |
| Unified Candidate Ledger | 欄：`id`\|`title`\|`carrier_hint`\|`theme_cluster`\|`root_cause_key`\|`source`\|`source_provenance`\|`in_flight`\|`linked_ids`\|`evidence_event_ids`\|`value_score`\|`disposition`；disposition ∈ `batch-now`\|`defer`\|`promote-to-issue`\|`drop`\|`consumed-temporary`\|`consumed-completed` |
| Cluster | `cluster_score = max(U) + 0.5 * median(U)`；tie：max(U)→distinct evidence→earliest timestamp→`root_cause_key`；一輪一簇；unique ≤7；≥3 無關 carrier 家族禁併 |
| Selection | **revalidate** → **claim-all** → durable `## Governance Batch Selection` → 才 repair／其餘 OpenSpec。**首次無 proposal**：claim-all 後僅可建 tracked **骨架＋選批段**；其他 OpenSpec／repair 仍待 durable 成功。partial claim → **release** 本 attempt → **reselect** |
| Post-claim durable-persist failure | A 所有權仍 OK → **重試** persist only（禁 reselect／repair）；B 不可續行 → release 本 attempt 後才可 reselect；C release 失敗 → **STOP** fail closed（禁 reselect） |
| Abandon | release 本 attempt claims → 清 `consumed-temporary` → **恢復** eligibility；GH 保持 open |

Durable 成功＝tracked proposal 含完整 `## Governance Batch Selection` 且 `claim_all_status: all-success`（scratch `notes/` 不算）。

### Anti-Hack 五概念

value-score、cruel-metric、why_not_hack、去重（dedup）、governance-budget 必跑；`net-add 無配對且缺 rationale → 退回精簡`。

### Token-Budget Cap-Pressure Governance

`devpro:rule-governance` audit-only／convergence **MUST** 掃 token budget／cap pressure（production `rule-token-budget.mjs`／`cap-pressure=over`）。修復僅 accepted finding；ordinary hard-trim-for-cap 禁止。

## Exit Criteria

- 6-step 有紀錄且可複核。
- claim-all + durable Governance Batch Selection 完成後才開 repair。
- 通過候選已進 OpenSpec change/chore。

## Common Rationalizations

- 「訊號只出現一次，先記住就好」→ per-agent memory 不跨 session；全低 → defer
- 「skip why_not_hack，直接改規範比較快」→ why_not_hack 缺失 → 自動拒
- 「pending 裡就有，先 batch-now」→ 缺合格 `source_provenance`／禁源 → 永不 batch-now
- 「先開 change 再補 claim」→ 缺 claim-all／durable Governance Batch Selection → 禁 repair

## Verification

`rule-self-evolution-grep.test.mjs` 應驗證：value-score／source_provenance／batch-now／Governance Batch Selection／claim-all／consumed-temporary／`max(U)+0.5*median(U)`／post-claim A/B/C／abandon restore。

> **Gate 5 vs Candidate Ledger disposition（一句劃界）**：Gate 5 tokens（issue／`user-deferred`／`already-covered-by-current-change` 等）屬 Recap 發落層；治理選批帳本另用 `batch-now`／`consumed-temporary`／`consumed-completed`／`defer`／`drop`／`promote-to-issue`（SSOT：`rule-self-evolution.md`）。Gate 5 結果可餵 provenance／`promote-to-issue`，**不得**把兩套 disposition 混成同一閉集。

Cross-ref：`session-recap.md`（Gate 5）；`session-pending-lifecycle.md`（claim／abandon）；`rule-audit-playbook.md`（Cadence／Signal）；`ai-autonomy.md`（無 per-project KB）。
