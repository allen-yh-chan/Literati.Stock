---
name: preflight-checklist
description: devpro:change pre-flight checklist 明細與引用詞處理；openspec-flow.md 從本檔展開規則。
---

# devpro:change Pre-flight Checklist

## Overview

`devpro:change` 開工前的結構性檢查。任一點不符 → 停下問使用者，**禁止**擅自填補或繼續建 change。

## When to Use

由 `openspec-flow.md` 「Pre-flight Checklist」段引用展開。`devpro:change` 收到新需求、行為變更指令時觸發 pre-flight checklist。

## Scope

所有需建 OpenSpec change 的分支。`chore/` A 類**僅需過點 1-2**（名稱健全性），點 3-9 略過。Only an independently urgent hotfix repair may use lite pre-flight（**必過**點 1-4，點 5-9 可延後 24h 內補齊）; a non-urgent already-live backfill MUST complete normal checklist 點 1-9 於實作前。（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）

## Relationship with ambiguity-scoring

Pre-flight checklist 為 binary gate；語意仍模糊時再啟動 `ambiguity-scoring.md`。高複雜或高模糊需求需依該 leaf 的 `Spec-Interview Lens` 先鎖 acceptance criteria、non-goals、risk/trade-off、edge cases、compatibility，再交棒設計。

## Process

### Checklist

建立 OpenSpec change 前，AI 必須主動確認整份 checklist。任一項不符 → 停下問使用者，**禁止**擅自填補或繼續建 change。

1. **一動詞一 scope**：change 名稱含 "and"／「順便」／多個互不相關動詞 → 拆為兩個 change（例：「加 retry 並重構 logger」→ `add-retry` + `refactor-logger`）

   **點 1 延伸：commit-level 同範圍紀律**

   同一 commit / 可促進單位內**禁止**混 simplification（refactor / token trim / 純壓縮）+ feature（行為變更 / 規則新增 / gate）。違反即拆 commit 或 chore。

   **Anti-rationalization**：「順便」「都改了」「同 PR 比較好 review」皆不成立。dp-analyst pre-flight 須偵測「順便 trim」「先壓縮再加 feature」等措辭，警告 TL 拆 commit。

   **點 1 延伸：`devpro:change` 前移檢查 branch scope body**。`devpro:change` 第一個 **Verb Whitelist Precheck** 不只驗 verb 是否在點 2 marker SSOT；在 Chore Classification、anchor、`git worktree add`、branch hook、`gh pr create` 前，TL 必須檢查 `<name>` scope body 是否含 `-and-` 或其他一動詞一 scope violation（如「順便」/多動詞）。命中即停下要求拆 change 或改成單一概念 scope；禁等 hook/PR 才攔。

   **點 1 延伸：hook 已機械擋 `-and-`，但過 hook ≠ 合規**。N2 block 已 reject 含 `-and-` 的 branch body（測試：`branch-naming.test.mjs` N2 block）；改用單一概念 scope 詞即可。反向不成立：hook 只擋 `-and-`，其餘「順便」／空格或他字串連多動詞仍須 preflight 判拆。

2. **動詞白名單**：change 名稱僅允許 marker 區塊中的動詞開頭。**例外**：`chore/bump-v<X.Y.Z>` 以 whole-name 逐字比對豁免（不是 verb 層豁免）；`review/pr<N>` 僅豁免本機 PR 驗證命名（正整數、無前導零），禁止 push／PR head，完整生命週期見 `git-branch-naming-and-anchor.md`「本機 PR 驗證」。它不是新 change 動詞或可促進工作前綴。

   下方為**機器可解析的權威清單**（SSOT）：`.devpro/scripts/hooks/lib/branch-naming.mjs` 解析 marker 區塊抓取動詞集合，供 `devpro:change` preflight、branch naming library tests、與 PreToolUse branch-verb hard gate 使用。**禁**在 hook 或其他位置 hardcode 重複清單。修改清單只動下方 marker 區塊。

   > **兩層白名單**：本區塊是 verb 白名單，只檢查 prefix 之後 `<verb>-<scope>` 的第一段；prefix 本身另有白名單，見 `git-branch-naming-and-anchor.md`。`docs`／`fix`／`wire` 是 verb，不是 prefix，不能直接當分支開頭。

   <!-- branch-verb-whitelist:start -->
   - `add` — 新增功能
   - `fix` — 修 bug
   - `refactor` — 不變行為重整
   - `remove` — 移除
   - `migrate` — 切換技術棧
   - `update` — 同一依賴升新版
   - `sync` — 同步 submodule pointer 或外部規範來源（eg. `rules/<source>-v<X.Y.Z>`）
   - `docs` — 純文件
   - `amend` — 修規範既有 requirement 文字
   - `strengthen` — 補既有規則漏洞但不變主規則
   - `wire` — 啟用既有設計（hook 上線、設定串接）
   - `clarify` — 澄清既有規則語意但不改行為
   - `enforce` — 把既有規則上升為強制 gate / hook / 驗證機制
   - `revert` — 緊急回退已合入之 release/hotfix，經 release carrier 完成（eg. `hotfix/revert-rules-<date>` per `rules-flow-rollback.md` § Rollback SOP）
   - `rationalize` — rule corpus 定期 audit（rationalization cycle，見 rule-audit-playbook.md §Cadence）
   <!-- branch-verb-whitelist:end -->

   > **`rules/` 前綴豁免**：`rules/<source>-v<X.Y.Z>` 命名以 source 起頭，**不**走動詞白名單；改驗 `<source>` 在「rules/ 分支 source 白名單」marker 區塊內。

### 點 2b：rules/ 分支 source 白名單

`rules/<source>-v<X.Y.Z>` 命名的 `<source>` 須在以下 marker 區塊白名單內。新增 source 須走獨立 OpenSpec change 修改本 marker，不得在 `rules/` PR 內就地擴增。`branch-naming.mjs` 解析此 marker 區塊驗證 `<source>` 合法性。

<!-- rules-source-whitelist:start -->
- `agent-rules` — devpro-agent-rules submodule（規範同步）
<!-- rules-source-whitelist:end -->

3. **Starting state**：proposal 必含當前版本、相關現存檔案、最近相關 commit
4. **Target state ("done when")**：proposal 必含 3-5 條可驗收條件；禁止模糊目標。**開工前自問：資深工程師會核准這 3-5 條為 done 的定義嗎？**

> _Anchor: done-when 需先過 senior-engineer self-check；勾選前驗收見 `openspec-quality-and-formats.md` §Tasks Quality。_

   **點 4 延伸：`risk_classes`／角色／負向勾選（pointer，不複寫 SSOT）**

   - **`risk_classes`**：eligible carrier（proposal／proposal-mini／brd／meeting-notes）已在檔首 **leading YAML front matter** 留下 `risk_classes: […]|none`（none 須同區塊 `rationale:`）；正文／fence 範例不算；規則 SSOT → `openspec-quality-and-formats.md` High-risk material negatives。
   - **負向／Non-goals 禁逃**：高風險四類 material negatives 已覆蓋或明示省略；不得把 material 塞進 Non-goals 逃脫（同 SSOT）。
   - **角色（Initiator／Affected）**：條件觸發時 Ledger `Current Requirement` 與／或 scenario 已宣告，或 `Initiator/Affected=N/A — <理由>`；**禁 BRD-global Actor**（語意 SSOT → `openspec-quality-doc-formats.md`）。
   - **Scope stop-loss（pointer）**：material semantic carrier group 超標／二次 redesign／越界 boundary → 停下 amendment；SSOT → `openspec-scope-change.md`。
   - **Consequence assessment（pointer）**：八維 + closed disposition → `change-consequence-assessment.md`（禁在此複寫）。

5. **Touch / Don't touch**：proposal 必含預計修改檔案清單與明示不會動的檔案；實作中若需改動未在清單上的檔案，回來問使用者（touch set 確定後，依 `git-branch-naming-and-anchor.md` [§ 動手前 anchor-divergence 自檢（touch set）](git-branch-naming-and-anchor.md#動手前-anchor-divergence-自檢touch-set) 執行分歧自檢）

   **點 5 延伸：redirect entry / runtime load parity pre-read**

   Touch list 含 redirect entry file（以 `.devpro/scripts/tests/multi-runtime-parity.test.mjs` 的 `REDIRECT_FILES` 為權威清單）或 runtime 載入/分發機制（如 `sync-agent-rules.mjs` 的 `STATIC_FILES` / `SYNC_DIRS`、`.claude/settings.json`、`.cursor/hooks.json`、`.codex/hooks.json`）時，設計 proposal / proposal-mini 前 **MUST** 先讀 `rule-design-principles.md` 守則 1 + `.devpro/scripts/tests/multi-runtime-parity.test.mjs`，並在 proposal / proposal-mini 標註 `Parity invariant impact: 保持 / 放寬 / 收緊` + rationale。若選擇放寬或收緊 parity invariant，須同步更新 `multi-runtime-parity.test.mjs` 的斷言或註解，明確區分 load-bearing invariant 與 convenience proxy。

6. **預估 task 數**：AI 依描述估算 task 總數。> 7 時**建議**拆為 sub-changes；使用者堅持單一 change 時須在 proposal 記錄「不拆原因」
7. **Prior attempts（bugfix 類必含欄位）**：`bugfix/` 類 change 必含「已嘗試過的方案 + 失敗原因」欄位；**首次修復可填「無先前嘗試」**
8. **Archived decisions 檢查**：以關鍵字 grep 搜尋 `openspec/changes/archive/` 中與本 change 主題相關的已 archive decisions；若有衝突須在 proposal 中明示處理方式

9. **Rule-doc dogfooding self-check**：寫描述新 Never / PII / output-discipline 規則的 `proposal.md` / `proposal-mini.md` 後 commit 前，**必須**對自身執行 `rule-design-principles.md` §Example Sanitization 之 canonical FORBIDDEN regex set；任一 hit → 用同段 placeholder 修正後再 commit。SSOT 紀律：regex / placeholder 完整清單僅在 `rule-design-principles.md` §Example Sanitization 維護，本點不複製以免漂移。**Why**：rule SSOT 自身違反規則 = 諷刺與內部矛盾，且 real user data 落入 git history 後續無法清除。**Mechanical gate backstop**：`pre-tool-gate.mjs` Gate P 對 `openspec/changes/<X>/{meeting-notes,brd,proposal,proposal-mini,tasks,qa-test-scope,decisions}.md` 寫入做 pre-write block（per issue #706）；剩餘 cooperative-only 路徑：`openspec/specs/<cap>/spec.md`（spec delta）與 `make-vs-buy.md`（低頻條件式產出，未達 Gate P ROI bar）。

## Early Feature Dependency Collection

若使用者提及對其他未上 PROD 的 feature 之依賴，dp-analyst 應在 brd.md「現況分析」中記錄，供 TL 在 step 2c 決策分支基底。

## Proposal Metadata

`issue: #N` 寫在 proposal 的 `## Summary` 之前（無 issue 時省略）。

## Handling User References to Prior Discussions

描述含「剛剛／上次／之前／我們討論過的」等引用詞時，AI **必須**先 echo 當前理解（2-3 句）給使用者確認，再進入 step 1。禁止憑引用詞直接開 change。

## Mechanical Check（最小集，可自動化驗證）

Pre-flight checklist 通過後補做 M1-M5；任一 `✗` 即 blocking。

| # | 欄位 | 驗證方式 | 阻擋條件 |
|---|---|---|---|
| M1 | Declaration | contract：trusted exact→family/config→unknown；宣告/footer/provenance 同源，不增 specificity | 缺失/不一致→修正；無可信 evidence→unknown |
| M2 | **Intent classified?** | 意圖已依 AGENTS.md Intent 速查分類，且已路由至對應入口 | 意圖未分類 → 停下分類 |
| M3 | **Ask-first approval captured?** | Ask First 操作（git / 套件 / CI / 版號）皆已取得明確同意；Architecture Ask First／listed boundaries 見 `design-core.md`（本列不複寫） | 未取得同意 → 停下詢問 |
| M4 | **Restricted action blocked when missing approval?** | 若 M3 尚未全部授權，對應操作尚未執行 | 未授權但已執行 → 立即停止並回報 Violation |
| M5 | **Repo scope evidence captured?** | 寫入目標 repo 與使用者指定 repo / proposal Touch / cwd repo 一致；跨 repo read-only inspection 可 N/A | 目標 repo 無證據卻要 clone / branch / edit / commit 另一 repo → 停下回報 negative evidence 並詢問 |
| M6 | **Redirect/runtime parity pre-read captured?** | Touch list 命中 redirect entry / runtime load surface 時，proposal / proposal-mini 含 `Parity invariant impact` 與守則 1 + `multi-runtime-parity.test.mjs` 讀取 evidence；未命中可 N/A | 命中但未標註影響或未同步測試註解/斷言 → 停下補 proposal / tests |

## Exit Criteria

- checklist 全部通過（或 A 類點 1-2；僅 independently urgent hotfix repair 可先過點 1-4，non-urgent already-live backfill 必須在實作前完成點 1-9）（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）
- Mechanical Check M1-M6 全部 `✓`（或 `N/A`）
- 若 M6 命中，proposal / proposal-mini 已標註 parity invariant impact 並完成測試同步；未命中則 `N/A`
- proposal 含 Starting State、Target State、Touch / Don’t Touch
- 無引用詞未確認就進入 step 1 的情況

## Example

> 範例：使用者要新增 export 功能 → AI 進入 pre-flight，逐項驗證 checklist → 點 1「一動詞一 scope」FAIL（描述含「順便加 retry」） → 停下問使用者拆分。
