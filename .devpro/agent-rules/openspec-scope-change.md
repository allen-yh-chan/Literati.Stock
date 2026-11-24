---
name: openspec-scope-change
description: Requirement scope change 的重進流程、OpenSpec-before-code hard gate、Material Semantic Carrier Group Scope Stop-Loss 與對應的常見藉口反駁。觸發：實作中或 PR merge 前後出現 requirement scope change（新增／移除／實質改變 target behavior、acceptance criteria、gate semantics、workflow state transitions、merge/release obligations），或變更將越出已批准的 material semantic carrier group／design／scope 邊界時。
---

# OpenSpec Requirement Scope Change

> Load-chain：本檔由 `openspec-quality-and-formats.md` §Requirement Scope Change 按需載入；該檔保留 scope change 定義與 micro-tweak 基準的入口摘要，重進流程、hard gate 與 stop-loss 的權威內容在本檔。

## Requirement Scope Change（含 PR merge 前與 post-merge continuation）

> 舊稱「Pre-merge Requirement Scope Change」；**post-merge**、**原 PR 已 merge**、**同 named change continuation**、**使用者明示「直接實作／補齊／Option B」** 皆適用本節，不得因時機或措辭不同而跳過。

實作中或 **PR merge 前／後** 出現 requirement scope change 時，不可當成「直接 patch 原 PR」或「延續對話直接寫碼」。requirement scope change 指新增、移除、或實質改變 target behavior、acceptance criteria、gate semantics、workflow state transitions、merge/release obligations；不論發生在 PR 前或 PR 後、是否已有 review / cross-model PASS、是否同一 named change、是否使用者已選定方案並要求實作，都必須先重進分析與設計。

1. TL 整理設計決策摘要（變更原因、新 requirement、對現有 spec / tasks / merge gate 的影響範圍）。
2. TL 同步更新 `decisions.md`（觸發點：`scope-change`）。
3. TL 必須在同一 named change 上重跑 `dp-analyst -> dp-architect`，取得 requirement / architecture impact；B-mini 僅影響初始 authoring path，不能 bypass 後續 requirement scope change。
4. 原 PR **未 merge** 時，必須留在 same branch/change/PR；禁止另開 bugfix branch 逃避原流程。
5. 原 PR **已 merge** 時，必須在同一 **named change** 上走 active-missing continuation（`openspec-step-1-to-9.md` + `openspec-archive-redo-undo.md` §Pre-merge Archive Re-do），開 follow-up branch/PR；**禁止**新建不同 change 名稱來跳過 spec，也**禁止**在 `main` 無 active folder 時直接寫 implementation carrier。
6. 依 analyst/architect output 更新 proposal / tasks / spec delta；若 active folder 已 archive，依 `openspec-step-1-to-9.md` 執行 pre-merge re-archive（或 post-merge active-missing 還原後 re-archive）。
7. 更新完成後才可繼續實作或 merge；完成後重新走 step 6-9 / pre-PR / post-PR gates。

### OpenSpec-before-code hard gate（scope-change 專用）

在滿足上方 1–6 之前，TL **MUST NOT** 寫入或擴充下列 **implementation carrier**（含「先寫 draft 再補 spec」「順便 dogfood」「程式已調好」）：

- `*.mjs` / `*.ts` / hooks / scripts / tests（非僅 `openspec/changes/<name>/` 內）
- `.devpro/agent-rules/*`、agent skill `SKILL.md`、platform adapter（會改 gate/runtime 行為者）
- Recap body 中宣稱已落地、且對應 requirement 尚未進 active change 的 spec delta / tasks

**寫碼前 MUST 全部成立**（缺一即 fail closed、停下補 spec）：

1. `openspec/changes/<same-named-change>/` **active** 且含本次 scope-change 的 `decisions.md` `scope-change` entry。
2. `proposal.md` / `proposal-mini.md` 與 `tasks.md`（或 B-mini `Tasks` 段）已反映新 requirement（含 `[Req: R#]` 或等價 trace）。
3. 至少一個 `specs/<capability>/spec.md` **delta** 已寫入且對應新行為（cooperative-only 須明示理由，不得用「延後」跳過）。
4. `dp-analyst -> dp-architect` 影響評估已完成（可委派；TL 不得單方面跳過）。

**下列理由一律不構成豁免**（見 `ai-autonomy-rationalizations.md` 同條）：

- 使用者說「在這個 PR 補齊」「直接實作 Option B」「不要開新 change」
- 原 feature PR 已 merge / change 已 archive
- 實作已在 worktree、僅差 spec 文件
- 同 session Recap／討論延續、trade-off 已在對話中選定
- 變更「只是」補 Recap 可觀測性／manifest／rollup（改 gate 或 workflow 即 scope change）

**micro-tweak 基準**（TL 直接改）：1-2 個 acceptance condition 文字澄清、或新增一個 auxiliary file，且不改 target behavior、gate semantics、workflow state transitions、merge/release obligations。

**禁止**：(a) 模糊動詞無轉換就開工；(b) requirement scope change 後不更新 spec 就繼續實作或 merge；(c) TL 自己直接大改 spec 而不經 `dp-analyst -> dp-architect` 影響評估；(d) 用 B-mini、PR 已開、PR 已 merge、使用者已點頭實作、或 cross-model 已通過作為不重跑流程的理由；(e) 以 dogfood／草稿程式／notes/tmp 實驗代替 OpenSpec artifacts。

## Material Semantic Carrier Group Scope Stop-Loss（加法；不取代上方）

在既有 Touch／pre-merge scope-change gates **之上**加 stop-loss（**不得**解讀為可跳過那些 gates）：

1. **Write 前停下**：若會觸及已批准集合外的第 11 個 material semantic carrier group、已批准 design 後第二次 substantive redesign、或引入已批准 scope 外的新 acceptance／consumer obligation／repo scope／architecture boundary → **MUST** stop 並提出具體 amendment／拆分。
2. **Proposal 初列** groups + rationale。初列 >10 → 第一次 rule／code write 前具名批准或拆分；批准後對同一具名集合不再問；僅新未批准 groups 再 Ask First。
3. **Anti-gaming MUST**：獨立 owner／contract／generator／validation path 必分組；不確定先分開計數；同契約多 host projections 可一組。禁為壓 ≤10 併無關契約或拆微檔謊稱一組。
4. **機械邊界**：只鎖 shape／pointers／closed vocab；**MUST NOT** 用 prose／關鍵字 regex 當 materiality oracle。

Pointers：`preflight-checklist.md`、`pre-implementation-over-design.md`（最短；不擁有本契約）。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「scope 只變一點點，不用更新 spec」 | micro-tweak 可 TL 直接改；只要改 target behavior / acceptance criteria / gate semantics / workflow state transitions / merge/release obligations，就是 requirement scope change，**PR merge 前或後**皆必走 `dp-analyst -> dp-architect`、same named change、更新 spec/tasks；未 merge 則 same branch/change/PR + pre-merge re-archive；已 merge 則 active-missing continuation + follow-up PR；B-mini 不是後續 scope-change 豁免。 |
| 「使用者已說在這個 PR 補齊／直接實作 Option B」 | 選定方案 ≠ OpenSpec 豁免；`scope-change` + active change + spec delta + analyst/architect **先於** implementation carrier（見本檔 OpenSpec-before-code hard gate）。 |
| 「原 PR 已 merge，只是 continuation／同 change 延續」 | archive 後新增行為仍是 requirement scope change；須 active-missing 還原同一 named change，**禁止**無 active folder 在 main 直接寫碼。 |
| 「程式已在 worktree 調好，先 dogfood 再補 spec」 | 草稿實作不滿足 hard gate；須先 decisions/proposal/tasks/spec delta，再對齊或重寫程式。 |
| 「不要開新 change 名，所以不用走 devpro:change」 | 同 named change ≠ 跳過 OpenSpec；只是不新建 `openspec/changes/<other-name>/`。 |
