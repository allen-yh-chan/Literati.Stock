---
name: knowledge-distillation
description: "把 digest 後可採納知識壓成最小可執行 carrier；支援外部 KB 與 devpro self-distill。"
---

# Knowledge Distillation

## Overview

Distillation（蒸餾）非 LLM 訓練專用；在規範庫裡，它把可採納知識壓成最小、可執行、可驗證 carrier。它不是摘要：distill 要留下 action point、SSOT placement、驗證與排除邊界。

Devpro 的三段式語意：

| Stage | Role | Output |
|---|---|---|
| `ingest` | 來源可信度、概念對映、相容性盤點 | Ingest-Mapping Ledger |
| `digest` | 採納/排除判斷與 SSOT placement | Knowledge Digest artifact |
| `distill` | 把採納內容壓成最小可執行 carrier | Distillation Ledger + rule/skill/spec/test/KB patch |

## When to Use

- 使用者要求 `distill`、蒸餾、自我蒸餾、優化知識庫、或把 digest 收斂成規範時
- `knowledge-digest.md` verdict 是 `adopt-rewrite` / `adapter-only`，需落成 rule、skill、adapter、spec、test、或外部 KB patch 時
- 維護另一個 knowledge base，需可執行 guidance、索引、測試或治理規則時
- 維護 devpro corpus，把重複、ROT、recap harvest、audit findings 收斂成更小 SSOT 時

Load-chain：外部來源先載入 `rule-ingest-methodology.md`、`knowledge-digest.md`；自我蒸餾按需載入 audit/dedup/design leaves。

## Invocation Defaults

一句話即可觸發：`蒸餾 <URL/path>`、`distill <URL/path> to devpro`、`蒸餾 <URL/path> 到 <KB>`；使用者不必重述三階段。target 未指明→先產 digest + Distillation Ledger + carrier 建議，不改 durable carrier；target 已指明→照做，僅 Ask First 停問。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for semantic execution |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


1. **Declare Source / Target**：標出 source/target。source 可是 external KB、refs、wiki/notes、OpenSpec、recap、devpro corpus；target 可是 KB patch 或 devpro rule/skill/spec/test/adapter。
2. **Require Upstream Evidence**：外部來源先有 Ingest-Mapping Ledger 與 Knowledge Digest verdict；自我蒸餾要有 audit/dedup/recap evidence。
3. **Write Distillation Ledger**：每個採納項列 source signal、digest verdict/evidence、distilled behavior、target carrier、action point、verification、exclusion/anti-drift note。
4. **Choose Minimal Carrier**：
   - shared 行為規範 → `.devpro/agent-rules/*.md`
   - 使用者可呼叫 workflow → `.devpro/agent-skills/.../SKILL.md` + manifest + discovery symlink
   - runtime 差異 → `platform-adapters/*.md`
   - behavior-changing contract → OpenSpec spec delta + implementation carrier
   - 外部 KB 維護 → target KB 的索引/條目/測試或 checklist
5. **Compress, Do Not Summarize**：移除背景、重複、本地格式，只留下一個 agent 會執行且會被驗證的句子；缺 action point 或 verification 就退回 digest。
6. **Preserve Single Interpretation**：壓縮後不同 reader / model 冷讀須導出**同一 operative 意思**；壓到多重解讀（失真）即為 regression，即使 action point、verification、safety 皆保留亦然。此條與第 5 條並列且缺一不可——第 5 條去冗餘、本條防失真。**Recommended 驗收**：actual carrier 的 machine utilization 達 tier cap 之 80% 時只發出 `semanticReview=required` signal，由另一 family 的 model cooperative cold-read 並逐條複述；全數 MATCH 才能作為單一解讀的 advisory 佐證。Machine signal 不判定 semantic PASS/FAIL，也不建立 proposal heading、manual evidence 或替代 artifact。
7. **Persist Deferred Work**：使用者要求先暫存不落地時，依 `session-pending-lifecycle.md` 寫 handoff-grade pending；不得只留 URL 或一句提醒。
8. **Self-Distill Safeguards**：自我蒸餾 devpro corpus 時，先 grep 同義規範；優先改既有 SSOT，不新增平行 leaf；不得弱化 MUST/MUST NOT/FAIL CLOSED、security、PII、SQL、git safety、adapter parity，除非同 change 提供更強 replacement。

### Structural Repair Before Instructions

反覆錯誤先從實際事件分類：哪個無效狀態／入口可被建立、哪個 invariant 被多處同步。Carrier 選擇依序評估：結構／單一 owner／推導 → 型別 → 可執行檢查 → 行為測試 → 判斷文字。先消除錯法可行路徑；高階手段不適用時在既有 ledger 說明原因，不新建另一套治理紀錄。

MUST 證明真實歷史錯法被拒絕，且合法操作仍通過；新增 lint／runtime check 應指出違反的 invariant 與可行修法。仍能由結構消除的錯誤 MUST NOT 只加文字提醒；文字承擔需要情境判斷的餘項。只有 replacement 已覆蓋原約束才移除重複指引；安全、PII、SQL、授權與必要 why／公開契約／license 註解不因減字刪除。Grep 不能證明理解、設計或 judgment 正確。

## Distillation Ledger Template

| Source signal | Digest verdict/evidence | Distilled behavior | Target carrier | Action point | Verification | Exclusion / anti-drift |
|---|---|---|---|---|---|---|
| `<path/issue/recap/source>` | `<verdict + evidence>` | `<smallest durable behavior>` | `<rule/skill/spec/test/adapter/KB>` | `<what agent must do>` | `<grep/test/validate/review>` | `<what is not copied or redefined>` |

## Exit Criteria

- Distillation Ledger exists for every adopted concept
- Each distilled item has one carrier and one verification path
- External-source distillation links to ingest/digest evidence
- Self-distill proves dedup and preserves stronger safety language
- Deferred distill output is recoverable from handoff-grade `session-pending.md`
- New leaf/skill/spec/test surfaces update AGENTS.md, README, manifest, symlinks, and focused tests where applicable

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「已摘要來源，所以算 distill」 | 摘要不等於蒸餾；沒有 action point、carrier、verification 只是 digest notes。 |
| 「規範太長，刪短就是 self-distill」 | 壓縮必須保留或提高強度；弱化 safety / parity 是 regression。 |
| 「壓到最短、token 最省就是最好蒸餾」 | 最短≠最好；壓到多重解讀（失真）是 regression，即使 action point/verification/safety 皆在。單一解讀優先於字數，與第 5 條並列——第 5 條去冗餘、本條防失真；heavy 壓縮以跨 family model 複述佐證。 |
| 「外部 KB 直接搬 devpro 規範」 | 仍要 target mapping；distill 到對方可執行 carrier。 |
| 「新增 distill skill 就夠了」 | Skill 是入口；schema/defaults/exit criteria 留在本 leaf。 |

## Verification

```bash
grep -F "Distillation Ledger" .devpro/agent-rules/knowledge-distillation.md
grep -F "Invocation Defaults" .devpro/agent-rules/knowledge-distillation.md
grep -F "knowledge-distillation.md" AGENTS.md README.md
grep -F "Preserve Single Interpretation" .devpro/agent-rules/knowledge-distillation.md
node --test .devpro/scripts/tests/knowledge-distillation-grep.test.mjs
node .devpro/scripts/lint-agent-skills.mjs
```
