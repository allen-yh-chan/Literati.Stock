---
name: clarify
description: "談需求／clarification 的共用 operational recipe（modes explore｜pre-analyst）。使用時機：使用者 invoke /devpro:clarify、階段 0 談需求、或 /devpro:change 第四步 MUST 載入本 skill 的 pre-analyst mode 後才可呼叫 dp-analyst。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:clarify [explore|pre-analyst] [change-name]"
---

# Devpro Clarify

## Overview

本 skill 是談需求／clarification 的 **operational recipe** 載體（非政策 SSOT）。`explore` 與 `pre-analyst` 共用同一問法／排序；寫入載體與放行條件分 mode。

**Policy SSOT 留在 rule leaves——本 skill 不重複它。**

| Area | SSOT |
|---|---|
| round／cap／terminal／Clarification State 欄 | `.devpro/agent-rules/ambiguity-scoring.md` |
| 選項呈現 | `.devpro/agent-rules/stop-point-comms.md` |
| Seams-first／Confirmation | `.devpro/agent-rules/proposal-template.md` |
| Synthesis | `.devpro/agent-rules/openspec-quality-and-formats.md` |
| pending path／claim | `.devpro/agent-rules/session-pending-lifecycle.md` |
| executable gates | `node .devpro/scripts/check-clarification-gates.mjs` |
| operator-usage-before-packaged-default | `.devpro/agent-rules/ambiguity-scoring.md` + `proposal-template.md` |

**MUST NOT**：在本 skill 複寫 round 數字、cap、選項呈現範例、Seams schema；把 grill-me／User Story／Use Case／JTBD／OST 當 **elicitation** 方法（一開始就按模板追問）；把 leaf 政策正文搬進本檔。**允許**：synthesis／confirmation **產物形狀**使用五欄白話卡（pointer 至 `ambiguity-scoring.md` §Operator usage probe）。

## When to Use

- 使用者跑 `/devpro:clarify`（或自然語言要求談需求／clarification recipe）
- 階段 0 需求討論需要同一套 operational 步驟
- `/devpro:change` **第四步 MUST** load 並執行本 skill 的 `pre-analyst` mode（禁第二套 clarification 步驟正文；禁以「只跑 CLI／等價 gate」繞過本 skill）

跨模組、重要介面、ownership／共享狀態或實作摩擦的工程視角選取，載入 `design-reasoning.md` §Engineering Review Lenses；共通完成判準沿 `ambiguity-scoring.md` §Lens Completion，不在此複製提示表或 finding 配額。

## Mode selection（互斥 precedence）

由上而下；謂詞互斥：

1. 由 `devpro:change` Step 4 呼叫 → **強制** `pre-analyst`；change-name＝該次 named change（資料夾必須已存在）；不得改走 explore。
2. 呼叫方**明確** `mode=pre-analyst` → 必須提供 **existing** `change-name`；缺／不存在 → fail closed（禁猜最新、禁掃目錄自選）。
3. 呼叫方**明確** `mode=explore` → `explore`（即使 repo 另有其他 active changes；explore **不**寫 meeting-notes）。
4. **未**明確 mode、屬階段 0／談需求：
   - 本 session 已具名 `change-name` 且資料夾存在 → `pre-analyst`（該名）。
   - 本 session **未**具名 change，且存在 ≥1 個 active `openspec/changes/<name>/`（非 archive）→ **停下**問 1=`explore` 2=`pre-analyst`（須回具名）3=其他；**禁止**默認 explore。
   - 本 session 未具名 change，且 **零** active change folder → `explore`。
5. 其他缺參／衝突 → **停下**問；**禁止**默認任一路徑。

Decision-table 契約測至少覆蓋：Step4→pre-analyst；明確 pre-analyst 無 existing name→fail；明確 explore＋其他 active→explore；未明示＋≥1 active＋未具名→stop；未明示＋零 active→explore。

## Mode: explore

**載體**：`<main-checkout-root>/notes/session-pending.md` 最小 handoff capsule（handoff-grade；路徑 SSOT 見 `session-pending-lifecycle.md`）。

最小 capsule 形狀（opener **MUST** 是 `## ` H2，token 須可 grep）：

```markdown
## <intent one-liner>
  - clarify_stage: explore
  - decided:
    - <promotable bullet> (provenance: user|repo-fact|…)
  - unresolved:
    - <open question>
  - next: <one next action>
  - promote_ready: true|false
```

opener 用頂格 `- `／`* ` 會被前一個 `## ` section 吸收，該 capsule 從此不是獨立可 claim 的條目——`claim --item <N>` 會指到別人身上。若該檔已出現任一 `## `，本次新引入的頂格 bullet 另會被 blocking Gate NS 擋下（整份檔案尚未採用 `## ` 的 legacy-only 檔不在射程內，既存 bullet 亦不擋；兩個前提見 `session-pending-lifecycle.md`）。全檔驗證跑
`node .devpro/scripts/session-pending-claim.mjs check-shape`。

**MUST**：
- `decided` 為可逐條 promote 的 bullets，每條含 `provenance`；**禁**只留一句摘要當唯一定案證據。
- 依 `ambiguity-scoring.md`／`stop-point-comms.md` 做 clarification batches（呈現契約 pointer，不複寫）。

**MUST NOT**：
- 建立／更新任何 `meeting-notes.md`
- 呼叫／暗示放行 `dp-analyst`
- 自行跑 formalize promote（promote **唯一 owner**＝`/devpro:change`）

## Mode: pre-analyst

**適用**：feature／bugfix／chore B（由 `devpro:change` 適用範圍決定）；chore A／B-mini 由呼叫方標 N/A，本 mode 不放行 analyst；N/A 只指 clarification rounds，五欄白話卡由 `/devpro:change` 第零步（或第三步前）確認。

**載體**：`openspec/changes/<change-name>/meeting-notes.md` 的 `## Clarification State`／`## Seams Confirmation`。

排序（固定）：

1. 確認 `openspec/changes/<change-name>/` 存在；否則 fail closed。
2. 若來源為 pending formalize 且 decided 尚未出現在 Clarification State → fail closed，要求先回 `/devpro:change` promote（本 mode **MUST NOT** 自跑第二套 promote）。
3. 載入上表 leaf SSOT；執行 clarification batches（呈現 pointer `stop-point-comms.md`）。批次內 MUST 執行 `operator-usage-before-packaged-default`（政策不在本 skill 複寫）：合成五欄白話卡並請「請確認或改」；僅 `UNRESOLVED:` 欄可問；MUST NOT `{source}.copy` 當識別；**確認（含改寫後再確認）前** MUST NOT 給 packaged default、MUST NOT 呼叫／暗示放行 `dp-analyst`（與是否尚無 `UNRESOLVED:` 無關）。
4. 寫回 Clarification State＋Seams Confirmation（欄位形狀以 ambiguity／proposal-template 為權威）：確認後五欄全部進 `decisions:`（每條 `(provenance: user)`；使用者故事可還原誰／狀態／觸發）；「做成後你會看到」另轉寫 `seams:`；禁只留做成後＋must-keep。
5. `node .devpro/scripts/check-clarification-gates.mjs seams-expansion <change-name>` exit 0。
6. `node .devpro/scripts/check-clarification-gates.mjs pre-analyst <change-name>` exit 0；非 0 → **MUST NOT** 呼叫 `dp-analyst`。

CLI 是 **本 skill 內**步驟，不是跳過本 skill 的替代放行證據。

## Exit Criteria

- Mode 已依互斥 precedence 選定（或已停問）
- `explore`：pending capsule 已寫；未寫 meeting-notes；未呼叫 dp-analyst
- `pre-analyst`：Clarification State／Seams 已寫；兩道 clarification gates exit 0；方可交棒呼叫方派 `dp-analyst`
