---
name: design-template
description: design.md template（施工圖級 How）— hook-enforced Context/Decisions + recommended headings；角色比喻 SSOT 見 openspec-quality-doc-formats.md。
---

# Design Template

## Overview

`design.md` 承載施工圖級 How（怎麼做、tradeoff、風險、遷移）。Full OpenSpec change MUST 持久化可審查的 `design.md`（hook-enforced `## Context` + `## Decisions`，且 `## Decisions` 至少含 `### D1 — <title>` em-dash 形），即使 How 僅一句話也寫 stub——Cooperative watershed 不再授權 full 免檔，以免 risk-shape 落到 `risk_shape_unavailable`。B-mini／chore A 免寫 `design.md`。archive format-when-present 只在檔案存在時驗 headings。design.md **非**長期復刻來源，隨 change archive 備查，不進 `specs/`（唯一長期復刻來源見 `specs/` behavior contract）。角色差異白話 SSOT（裝潢比喻）見 `openspec-quality-doc-formats.md` §裝潢比喻，本檔不複寫該比喻，只定義 design.md 格式。

## When to Use

Use when writing `openspec/changes/<name>/design.md` for a full change，於 dp-architect 完成 proposal 後（一句話 How 仍寫 stub）。B-mini／chore A 不寫本檔。

## Required Sections

設計方法 SSOT：`design-reasoning.md`。在既有 Context／Decisions 中呈現實際 caller 使用例、資料／invariant owner、候選取捨、需要實證的決策與實作回饋；按觸發比例執行，不新增 required heading，也不為 lite 強制建立本檔。

Hook-enforced required headings：`## Context`、`## Decisions`。recommended（視內容需要，非 hook-enforced）：`## Goals / Non-Goals`、`## Risks / Trade-offs`、`## Migration Plan`、`## Open Questions`。

Decision headings MUST use the exact em-dash form `### D<n> — <title>`（ASCII em-dash `—` + non-empty title）。Bare `### D1`、`### D1:…`、`### D1：…` 皆為 near-miss，authoring／`--strict`／risk-shape probe 會以「標題格式不對」早擋。

```
# Design: <change-name>

## Context

<背景、現況、constraints；為何需要這份施工圖>

## Decisions

### D1 — <title>

<至少一項編號決策 + why；stub 亦須有 `### D1 — <title>`>

## Goals / Non-Goals

<本設計要達成 / 明確不處理什麼>

## Risks / Trade-offs

<風險與取捨；緩解方式>

## Migration Plan

<若涉及遷移：步驟、回滾方式>

## Open Questions

<未決事項，留給 review 或後續 change>
```

各段用途：

- **Context**：背景、現況、constraints——讀者不需回去翻 proposal 也能懂為何要做這份設計。
- **Decisions**：關鍵技術決策，每項須含 why 與 tradeoff，非只列結論；標題形狀見上。
- **Goals / Non-Goals**：劃清本設計範圍，防止 scope creep。
- **Risks / Trade-offs**：明列風險與取捨，供 review 判斷是否可接受。
- **Migration Plan**：涉及遷移 / 破壞性變更時的步驟與回滾。
- **Open Questions**：留待後續決定的未決項，不得隱藏成既定事實。

## 大型測試證據的保存與第二審路徑（入庫前）

設計壓力測試、量測或大量 log 的驗收時，MUST 在產生／入庫完整 evidence 前說明保存位置、預估完整 PR raw diff 大小與第二意見審查路徑；寫入 `## Decisions` 或 `## Risks / Trade-offs`。不要等 builder 拒絕後才決定。

- 以 `.devpro/scripts/validate-second-review-packet.mjs` 的 `SECOND_REVIEW_MATERIAL_MAX_BYTES` 與 `.devpro/scripts/second-review-material-contract.mjs` 的 embedded／paged carrier 限制為準，不把固定版號的數值當永久契約。超過 embedded 上限不必然代表標準 runner 不可用；須區分 paged carrier 能否承接，以及完整 raw diff 是否超過 material 上限。
- 選擇 **完整證據外部保存、repo 入庫摘要** 時，記錄可接手存取的位置、SHA-256、受測 commit／環境、指令與結果；確保驗收者可取得完整證據，不能只放短命本機暫存檔。
- 必須 **完整 evidence 入庫** 且完整 raw diff 超過標準 material 上限時，在設計時選 External Evaluator，保留完整證據；執行 recipe 見 `second-review-external-evaluator.md`。不得截斷 diff／log 或抬高上限來偽裝標準審查可行。
- 入庫後、pre-PR 前以與審查相同的 raw diff flags 量測實際 byte 數；flags SSOT 是 `SECOND_REVIEW_GIT_RAW_DIFF_FLAGS`，range 用 PR base 的 merge-base→HEAD。把結果與選定路徑對照；超出設計估計就先修正路徑再送審。

## Exit Criteria

- `## Context`、`## Decisions` 兩個 hook-enforced heading 存在；full change 的 Decisions 段至少含 numbered D1 em-dash title（見 Required Sections 示範形狀）。
- 若 design.md 存在，`pre-pr-archive-gate.mjs` format-when-present check 通過。
- authoring／`--strict`／risk-shape probe 對 near-miss 決策標題回「標題格式不對」（不得僅見裸 `risk_shape_unavailable`）。

## Cross-References

- `openspec-quality-doc-formats.md`（裝潢比喻角色差異 SSOT + design.md 格式定義段）
- `proposal-template.md`（proposal 回 Why/What；How → 本檔）
- `chore-classification.md`（一句話設計＝mini↔full 分水嶺：mini 免檔；full 一律有檔，一句話仍寫 stub）
