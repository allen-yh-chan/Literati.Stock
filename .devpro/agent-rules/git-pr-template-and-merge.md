---
name: git-pr-template-and-merge
description: PR 描述必填欄位、模板、合併策略（regular merge）、Issue 連結、緊急直送的權威規範。觸發：建 PR 前、決定合併方式、處理 issue 連結時。
---

# Git：PR 模板與合併策略

## Overview

本檔覆蓋「建 PR 前」所需規範：PR 描述必填欄位、PR 描述模板、合併策略（必須 regular merge）、GitHub Issue 追蹤連結、例外緊急直送。

關鍵約束：每個 feature 變更必須走 PR；PR 描述必填欄位不可缺漏；合併必須使用 Create a merge commit（regular merge）。

## When to Use

- 程式碼準備提 review（建 PR）時
- 決定合併方式（regular merge / squash / rebase）時
- 需要對應 GitHub Issue 連結時
- 遇到緊急狀況需要直接 commit（例外緊急直送）時

## Process

### PR 建立前置（feature → main / hotfix）

每個 feature 變更必須走 PR，除非符合「例外：緊急直送」。

- **可促進單位**（`feature/`、`bugfix/`、`chore/`）：建立 → `main` 的 PR。建 PR 前先判定同分支既有 PR 的 milestone 三態並依此沿用／擋 `conflict`：執行步驟 SSOT 見 `pre-pr/SKILL.md` Step 4；三態定義 SSOT 見 `release-sit-uat-pat-prod.md` §Subset selection handoff。
- **Hotfix（source／consumer 同構）**：單元 sticky 後經 release carrier（source `release/v*`；consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`；bump 若適用先 merge 進 carrier）組裝；**禁** merge `hotfix/*`／`chore/bump-v*` → `production`，只有 carrier 自己的 PR 進 `production`——該 PR 經 GitHub merge 後 resolve exact merged production commit、freshly fetch `origin/production` 驗 reachability，再 tag the explicit commit、push only the tag ref。完整 mechanics：`release-hotfix-carrier-lane.md` §Hotfix release-carrier lane／`release-hotfix-carrier-policy.md`。
- **Grandfathered legacy hotfix**（cutover 前已合入 `production` 的舊 PR #1，後續 `hotfix/*`→`main` PR #2）：same branch MUST be advanced to the exact PR #1 tag before PR #2 → `main`，缺一視為未完成。完整 mechanics 委派 `.devpro/agent-rules/release-hotfix-carrier-lane.md` §Grandfathered legacy hotfix completion；分支類型對照見 `release-sit-uat-pat-prod.md`「Hotfix vs Bugfix」。

Applicable hotfix/rollback promotion MUST NOT local-merge or direct-push `production`：production ingress 一律 push work/release branch → PR base `production` → GitHub merge → exact merged production commit → freshly fetch `origin/production` 驗證 → explicit tag target → push only the tag ref。hotfix、其 version bump 與 rollback 單元進 `production` 的 PR head 恆為 release carrier；`hotfix/*` work branch 只以 PR 進 carrier，不得當 base `production` 的 PR head。

### PR 描述必填欄位

**PR 描述必填：**

- OpenSpec change 路徑：`openspec/changes/<name>/`
- 對應 `tasks.md` 勾選完成狀態（B-mini：列 `proposal-mini.md` `Tasks` 段 task outline 完成狀態）
- Requirement Ledger Completion：列 disposition counts；若有 `partial` / `deferred` / `rejected` / `moved-to-issue`，逐列列 owner / next step；若無 ledger（chore A）明寫 `N/A: <reason>`
- 測試證據：專案約定測試指令全綠（附實際指令與摘要，例 `dotnet test` / `npm test` / `pytest`）
- QA 文件：`openspec/changes/<name>/qa-test-scope.md` 連結或檔案路徑（B-mini：列 grep/test assertion evidence 路徑）
- **Change Context**：白話說明**改什麼**再**目的**（對齊 `post-pr-completion-gate.md` `ChangeContext`；禁 file-first／檔案清單當標題；需求驅動（full／lite）且無 proposal 時，改什麼對齊卡的引擎、目的對齊使用者故事）；第二意見 handoff 的 `scope_summary` 有長度上限，數值見 `proposal-template.md` Section 1 的「第二意見 handoff 上限」
- **Manual Test**：需人工測試時寫怎麼測／測什麼／通過標準；否則明確一行 `N/A: <reason>`

**PR 描述條件式欄位**（適用時**必須**填寫）：

- **新增或升級第三方套件時**：套件名稱、版本、SPDX 授權識別碼（§3e）
- **涉及 DB schema 變更時**：migration 檔案路徑、rollback 可行性說明
- **涉及 release 線或 production 修復時**：影響範圍評估、受影響環境、rollback 計畫
- **PR 帶 release 目標輪時**：PR milestone 與 `Release Target: <YYYYMMDD>` 一致；該欄位為人讀備援，body lint **warn-only**、不升 hard fail（milestone SSOT 見 `release-sit-uat-pat-prod.md` §Subset selection handoff）
- **source repo enforcement carrier** 被修改時：填寫 `Scenario Walkthrough` 狀態與證據；未觸發時填 N/A

### Attribution footer（commit message 與 PR body 皆適用，mechanical gate）

> SSOT 為 `ai-autonomy.md`「Always」attribution footer 段；本段是 PR/commit 準備時的快取，避免漏。`gh-footer-gate.mjs` + `pre-tool-gate.mjs` 共用 `lib/attribution-patterns.mjs` 機械驗證下列兩條——surface 不同，severity 不同：

1. **必含**末尾**單行** footer：`Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>`（版號取 `AGENTS.md` 開頭；separator 任意非換行字元；**禁**拆三行）。presence 缺漏：**commit message → emit advisory**（normative-debt，per spec `pre-tool-mechanical-gates` L981）；**gh body（PR/issue/comment 等）→ block**。版號不符（commit 或 gh body）→ **release-integrity block**（兩個 surface 皆是）。⚠️ **`chore/bump-v<X.Y.Z>` PR 特例**：bump PR 的 footer 版號用 **canonical（當前 main / body-file 所在 repo `AGENTS.md`）版號**，**非**分支目標新版號——因為新版號在 bump PR **merge 後**才進 `AGENTS.md`，開 PR 當下 canonical 仍是舊版號；footer 寫分支目標新版號會被 `gh-footer-gate` 判 release-integrity mismatch。新版號的生效點是 merge，不是開 PR。
2. **禁含** `Co-Authored-By:` 等 AI / coauthor / AI-generated brand marker（任何變體）——兩個 surface 皆 **block**。

Byte-for-byte 正確範例（單行、含 `v` 前綴；實際 tool/model 依 host 填入；版號以 `AGENTS.md` 開頭為準，下例版號只示意格式、不隨 bump 更新，照抄舊版號會被 `Footer version mismatch` block）：

```text
Rules: v6.98.0 · Tool: Codex · Model: GPT-5
```

常見錯誤反例（兩者都不合格；本 repo 覆蓋任何 host/harness 預設 co-author 指引，詳 `ai-autonomy.md` Always attribution footer / F1-F5 forbidden pattern）：

```text
Rules: v6.98.0
Tool: Codex
Model: GPT-5
```

```text
Rules: v6.98.0 · Tool: Codex · Model: GPT-5
Co-Authored-By: <AI tool or model marker>
```

**版本來源（worktree-aware）**：commit footer 的版號比對以實際 `git commit` invocation 的有效 cwd 為準（`git -C <worktree>` / hook-visible `cd <worktree>`），相對 `-F <message-file>` 也必須從同一 cwd 讀取；不得用 hook/session 起始 cwd 推論。**commit message 輸入方式**（首選多個 `-m`；`-F` 的可用條件與反模式）見 `ai-autonomy.md` §Commit message 寫法，本檔不重述；**不得** `git commit -F -`（stdin heredoc：gate 讀不到 stdin source → `source read failed` fail-closed）。`gh --body-file` / `--notes-file` / `-F body=@<file>` / `-F body="$(cat <file>)"` 的版號比對以 **本 session 執行指令所在 repo（hook cwd）** 為第一優先，cwd 讀不到版號才回退成功讀取的 body file 所在 repo。hook enforcement 未證明時，才用 exact command 跑 validator-only strict preflight：

```bash
node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr create --title "<title>" --body-file <repo-root>/notes/tmp/<change>-pr-body-<session-or-timestamp>.md
```

This strict invocation is a validator-only dry run: it never executes the nested `gh` command, Exit `0` means validation passed only, and the real `gh pr create` still must run separately if creation is intended. On hook-proven shells, run the real `gh` command directly and let PreToolUse invoke the gate; MUST NOT manually insert this validator as an executor wrapper.

PreToolUse hook 也會在 `gh pr create` 偵測可抽取的 body file（`--body-file <path>` / `-F <path>` / `-F body=@<file>`）並跑 `pre-pr-body-template-check.mjs`：缺段、cost-override disclosure 不一致、證據段超長、`## Change Context` 超過 `scope_summary` 上限、證據段或 `## Change Context` 含未填範本字樣 → **block**（Gate 4c early-fail at PR write）。inline `--body`（無 extractable path）與 unreadable body file 在正面 source 維持 fail-open／advisory；consumer／unknown 在 `lite`／`full` 須讀得到 body 查 DEV 行（`pre-pr-dev-verification.md`）與適用時的 consumer checks 行，無法抽取／讀取即 block。

PR body file 寫至 main-checkout `<repo-root>/notes/tmp/<purpose>-<unique>.md`（gitignored、不綁 worktree 生命週期，版號錨點 = 本 session 執行指令所在 repo 的 canonical remote tip `AGENTS.md`，#3437）；basename MUST include purpose + collision-resistant suffix（session id、timestamp、PID 或 random token），change name alone is not enough，且不得使用固定 basename（例如 `pr-body.md`）讓同 repo 多 session 互蓋。建檔與送出分兩個 Bash 呼叫（細則見 `file-write-destinations.md` §body file two-step 紀律）。`gh` 成功送出後 MUST 立即刪除該 body file。寫檔目的地總表見 `file-write-destinations.md`。

> ⚠️ 部分 host runtime 的**預設** commit / PR 慣例會自動 append 一行 `Co-Authored-By:` coauthor marker——本 repo 禁止，產出 commit message / PR body 時**須主動移除**該行（常見失誤是「補了 footer 卻留 coauthor」吃第二次拒絕）。host 差異見 `platform-adapters/*.md`。首次導入／sync 前唯一可靠載體見 root `README.md` Step 6／原則區（禁 AI coauthor brand trailer）；落地後 hook ban **不**放寬，已推歷史**不**改寫。

### PR 描述模板（複製後填入，降低遺漏率）

```markdown
## OpenSpec
- change: `openspec/changes/<name>/`
- tasks.md: all checked ✓（或 B-mini: proposal-mini `Tasks` 段 all checked / 列出延後項目與原因）
- archive: done（`openspec/specs/<name>/`）。Only an independently urgent hotfix repair may填 `deferred — <原因>，24h 內補齊`; a non-urgent already-live backfill MUST引用 OpenSpec/pre-flight（實作前）及 archive（dp-reviewer freeze 後、PR 前）。資料夾已有 `proposal.md`／`proposal-mini.md` 時不得填 N/A，lite 同（見 `rules-rigor-level.md`）。（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）

## Change Context
- 改什麼：<plain language what changed>
- 目的：<why>

## Manual Test
- 需要人工測試：是 / 否（否 → 一行 `N/A: <reason>`，刪其餘 bullet）
- 怎麼測：<steps>
- 測什麼：<scope>
- 通過標準：<pass criteria>

## Requirement Ledger Completion
- disposition counts: implemented <n>, partial <n>, deferred <n>, rejected <n>, moved-to-issue <n>
- non-implemented rows: <N/A 或列 R# + disposition + owner/issue/next step>
- coverage: implemented/partial rows have `[Req: R#]` task evidence; unknown `[Req]` refs: none

## Test Evidence
- 指令：`<dotnet test / npm test / pytest ...>`
- 結果：`<passed X, failed 0, skipped Y>` **或** `not verified: <reason>`（環境不可執行時；見 `ai-autonomy.md` Stop-Point）
- 覆蓋：`<各 gate 輸出的範圍／檢查數；base 不可解填 not verified／base unresolved；base 已解析且 0／不相交須註明 no applicable files 或 checked=0>`
- QA 範圍：`openspec/changes/<name>/qa-test-scope.md`（B-mini: grep/test assertion evidence `<path>`）
- Consumer pre-PR checks: HEAD <full-sha>; <結果摘要或 skipped per user decision: 原因>；條件式選用，不貼 log；HEAD 與工作目錄都沒有 `.devpro/pre-pr-checks.local.md` 時刪除本行；豁免需作答紀錄；格式見 `consumer-pre-pr-checks.md` §Consumer Pre-PR Checks
- DEV deploy-verify: HEAD <full-sha>; <結果摘要／N/A: 理由／pending: 缺什麼／skipped per user decision: 原因>；consumer 必填（rules lane 同步 PR 免填）、source 刪除本行；豁免需作答紀錄；見 `pre-pr-dev-verification.md`
- **驗收證據**（3-5 條 checklist，每條對應 proposal / proposal-mini 的 Target State 一項；需求驅動（full／lite）且無 proposal 時每條對應卡的「做成後你會看到」一項）：
  - [ ] <驗收條件 1 + 具體證據：測試名／指令輸出／檔案路徑／截圖>
  - [ ] <驗收條件 2 + 具體證據>
  - [ ] <驗收條件 3 + 具體證據>

## Scenario Walkthrough
<!-- Required when PR touches enforcement carriers: `.devpro/agent-rules/*.md`, `scenarios/scenario-*.md`, `.devpro/scripts/hooks/*.mjs`, `.devpro/scripts/hooks/lib/*.mjs`, `.claude/agents/*.md`, `.claude/commands/*.md`, or `.devpro/agent-skills/**/SKILL.md`. Otherwise mark N/A. -->
- Status: [executed PASS | skipped by AI decision: <reason> | skipped per user decision: <reason> | N/A (non-enforcement-carrier change)]
- Evidence: [walkthrough subagent return summary | mechanical scenarios.test.mjs output | N/A]

## Cost Circuit Breaker Overrides
<!-- Required when this change-cycle's checkpoint (notes/tmp/state/devpro-change-usage/<change>.json) has any overrides[] entries; otherwise `N/A` or `N/A: <reason>`. One line per override, sorted by `at` ascending: `- at=<ISO8601> thresholds=<comma-separated, ASCII-ascending> head_ref_oid=<40-hex sha>`. This section also records `thresholds=review_round` entries (a round-cap extension via `DEVPRO_REVIEW_ROUND_OVERRIDE`); disclosure is one entry per (session, head), not one per round. -->
- N/A

## Security Review
- SQL injection：已檢查（無字串拼接 / 使用 parameterized query）
- PII：已檢查（無 query string / log 外洩）

## Conditional Fields
- 第三方套件：`<name>@<ver>` SPDX: `<license>`
- DB schema：migration 路徑、rollback 可行性
- Release/production 修復：影響範圍、環境、rollback 計畫
- Release 目標輪：`Release Target: <YYYYMMDD>`（與 PR milestone 一致；warn-only 人讀備援，不阻擋 PR）
- issue：Fixes #N（有對應 GitHub Issue 時填寫；optional；**裸文字，勿用反引號**——code-span 內關鍵字 GitHub 不會 auto-close；多 issue 見下方「PR 描述加 Fixes / Closes」，禁 `Close #A / #B`）
```

> **Requirement Ledger Completion 段**禁止只寫 `all done` 或 `tasks checked`。有 ledger 時必須回報 disposition counts；非 `implemented` rows 必須列 owner / issue / next step。無 ledger 僅限 chore A / non-OpenSpec 例外，且必須寫 `N/A: <reason>`；consumer rules lane 同步 PR（head `rules/<白名單 source>-v<X.Y.Z>`）可省略本段，lint 依 head 視為 N/A。

> **OpenSpec 的 `archive:` 行是機械驗證欄位**（`pre-pr-body-template-check.mjs`）：只接受 `done`、`deferred — <原因>`、或 `N/A: <原因>`；`pending` 或其他值一律 fail 並印出違規行。缺該行時行為不變。理由：`pending` 記錄的是承諾而非結果，PR #3592 即以此形狀帶著未 archive 的 change 走到 merge gate。

> **Change Context / Manual Test**：PR body 必含 `## Change Context` 與 `## Manual Test`（與 merge Ask First Ready Response 的 `ChangeContext:`／`ManualTest:` 對齊語意；缺段＝body lint fail）。`ManualTest`／Manual Test 缺漏或把完整 PR body 當 merge-gate 替代 **不是** Path F／`checkCrossModelMergeGate` 失敗條件。

> **驗收證據段**（Test Evidence 下的 checklist）禁止空白或泛化描述（如「全部做完」「功能正常」）。每條必須對應 proposal / proposal-mini 的 Target State 一項（需求驅動（full／lite）且無 proposal 時對應卡的「做成後你會看到」；非需求變更車道與 rigor `off` 沿用既有證據來源），並附具體證據（測試 ID、指令輸出、檔案 SHA、截圖路徑等）。泛化＝未填。

> **證據段長度與字樣限制**（PR 建立前由 lint 阻擋、建立後 builder 仍會獨立檢查：`build-pr-sticky-handoff.mjs` 建 handoff 時違反即以 `pr_evidence_invalid` 拒絕）：`## Test Evidence`（→ `primary_test_evidence`）、`## OpenSpec` 加 `## Requirement Ledger Completion`（合併，→ `primary_validation_evidence`）各自 ≤ 8192 UTF-8 bytes，且不得含 `TODO`、`TBD`、`[fill`、`placeholder`（不分大小寫）；`<…>` 僅在 inline／fenced code 內且為單一 ASCII 識別字樣（如 `<name>`、`<n>`、`<X.Y.Z>`）時放行，其餘（含空白、中日文、逗號、`...`，如 `<observed OID>`）一律算未填。lint 只在 PR 會送第二意見時檢查（`cd` 後以 cd 目標 checkout 為準），判斷不了即放行。過長明細移到另開的 `## Supplementary Evidence`。

- PR 內容必須已包含 archive 後的 OpenSpec 結果；**不得**在 PR merge 後再另開分支補做 archive（Post-merge Archive Recovery 依 `openspec-step-1-to-9.md` 明文流程例外）。
- CI：等待 GitHub Actions / CI 全綠（至少包含 build + test 的結果）。
- 審核：至少一位審核者 approve（依 GitHub 設定或團隊共識）。
- 合併：用 GitHub PR 合併按鈕 merge（見下節「合併策略」）。

### 合併策略（feature → main）— canonical source

> 本節為 merge 策略**唯一規範來源**。`ai-autonomy.md` Never 條款、`git-branch-and-pr-flow.md` Exit Criteria、`release-sit-uat-pat-prod.md` Never 條款皆 link 至此。

- `feature/<name>` 併入 `main` 時，必須使用 **Create a merge commit**（regular merge），讓 `main` 上出現一筆可辨識的 merge commit。
- **禁**使用 **Squash and merge**、**Rebase and merge**。例外處理見下方「Exceptions」章節（目前 allowlist 為空 → 等同無例外）。
- **原因**：regular merge 可保留清楚的**可促進單位邊界**與完整歷史，方便 release 線以 `git merge <可促進單位>` 納入完整功能；squash 或 rebase merge 會壓扁或改寫邊界，較難穩定追溯與組 subset。
- **Hook enforcement**：`.devpro/scripts/hooks/pre-tool-gate.mjs` Gate 2c 會 block `gh pr merge --squash` / `--rebase`。stacked PR 等若獲明文例外授權，請在單次 Bash payload 內放入 `DEVPRO_HOOK_BYPASS=1 gh pr merge ...` 顯式 bypass，並在 PR 描述記錄理由。命中後整個 Bash payload 的 Bash gates 都會跳過，因此該 payload 必須只包含已授權的 merge 動作。
- **Repo settings enforcement**：上一條 hook 只涵蓋 CLI 路徑；GitHub 網頁 UI 的 merge 下拉選單不經過任何 hook，架構上無法涵蓋，因此 **repo settings 是網頁 UI 合併路徑的唯一防線**。目標值：`mergeCommitAllowed: true`、`squashMergeAllowed: false`、`rebaseMergeAllowed: false`。`devpro:change` startup 的 common environment entry（`node .devpro/scripts/dp-change-environment-checks.mjs`）會 best-effort 診斷 consumer repo 的這三個欄位，偵測到任一目標不合規時輸出警告；具 repo admin 權限且為互動 stdin 時先問後寫，答 `y`／`yes` 才發出單一 `gh repo edit`。`gh` 未安裝／未認證／無 admin 權限／非互動一律降級為訊息，不阻斷 change；raw `sync-agent-rules.mjs --sync` 與 `--check` **MUST NOT** 執行此 external-state 診斷或修復。

#### Linked Worktree Merge Cleanup Note

**Linked worktree 情境**：若目標分支（或 `main`）正被另一個 worktree checkout，**避免**直接使用 `gh pr merge --delete-branch` 一步到位——remote merge 本身沒問題，但 local branch cleanup 會失敗（git 不允許刪除被 worktree checkout 的分支）。正確做法：PR merge to main 時只執行 merge（`gh pr merge` **不**帶 `--delete-branch`）；post-merge 下一步是 workflow watch + local sync/status，**不是** branch/worktree cleanup。cleanup deferred until production：等 Release Step 6（PROD merge/tag pushed）達成後，才可依 `git-branch-hygiene.md` 由使用者授權執行 canonical cleanup flow：先跑 dry-run `node .devpro/scripts/prune-merged-local.mjs`，再 `--exec`（連 remote 用 `--include-remote --exec`）。**不要**手動 `git push origin --delete <branch>`：raw remote-branch delete 與 branch-hygiene SSOT（`git-branch-hygiene.md`：清理唯一入口 `prune-merged-local.mjs`）衝突，且會被 git-native pre-push hook hard-block（只有 prune script 受控發出的 delete 會通過）。

#### Exceptions（明文 allowlist；未列出 = 禁止）

| 情境 | 允許策略 | 授權人 / 來源 | 備註 |
|---|---|---|---|
| _（暫無）_ | — | — | — |

> 新增例外必須走 chore B 修改本表，並在 PR 描述說明「對 subset release / cherry-pick 的影響」。AI 不得自行解讀任何情境符合「明文例外」。

### GitHub Issue 追蹤連結（optional）

本節全為 **optional**；無 issue 可跳過。

**Commit message 加 issue 後綴**：末尾可加 `(#N)`，讓 GitHub 在 commit 頁面自動建立 issue 連結：

```
feat: add export retention logic (#42)
fix: handle null token in refresh flow (#87)
```

- 格式：`(<主體>) (#N)`，`#N` 放訊息結尾並用括號包圍
- 僅做**連結**，不自動關閉 issue（關閉需在 PR 描述用 `Fixes #N`）
- **分支名不放 issue 編號**——分支命名維持純語意 kebab-case，issue 編號只出現在 commit message 或 PR 描述

**PR 描述加 Fixes / Closes**：可加 `Fixes #N` 或 `Closes #N`，讓 GitHub 在 PR merge 時自動關閉對應 issue：

- `Fixes #N` 與 `Closes #N` 語義等價，擇一即可
- 放在 PR 描述模板的 **`## Fixes / Closes`** 區塊（有對應 issue 時填；否則刪該段）
- 一個 PR 可對應多個 issue：每行一條 `Fixes #N`（或每行一條 `Closes #N`）；亦可使用 GitHub 接受的 comma 形——**每個 issue 仍須是獨立 `KEYWORD #N` token**（例 `Closes #12, closes #34`；官方「Use full syntax for each issue」）
- **MUST NOT** 用 slash／模糊併寫、或 comma 後只留裸 `#N` 冒充多關閉（例 `Close #12 / #34`、`Close #12/#34`、`Fixes #12 / Fixes #34`、`Closes #12, #34`）。GitHub closing keywords **不會**把 `/ #34` 或 `, #34` 當成第二個 closing token（實例：`Close #12 / #34` → 只 auto-close #12，#34 需手動關）
- 若僅部分解決 issue，改用 `Related to #N`（不自動關閉）
- proposal 帶 `issue: #N`（見 `preflight-checklist.md` Proposal Metadata）時，PR 描述 **MUST** 帶對應行：完整交付＝裸 `Fixes #N`／`Closes #N`；部分或延期＝`Related to #N`；缺則 merge 後 issue 不會關、也無 cross-reference（實例：只寫 `issue: #N`，PR body 沒有關鍵字）
- **關鍵字必須是裸文字，禁包進反引號 / code-span / fenced code block**——GitHub 的 auto-close linker **不解析** code 內的 `Fixes` / `Closes` / `Resolves`（含 `Fix`/`Fixed`、`Close`/`Closed`、`Resolve`/`Resolved` 變體），merge 後 issue **不會**自動關閉（實例：PR body 寫 `` `Fixes #N` `` → `closingIssuesReferences` 全程為 `[]` → issue 需 TL 手動關）。正確：在 PR body 寫裸文字 `Fixes #N`（無反引號）。`gh-footer-gate.mjs` 對 PR body 內 code-span 包住的關閉關鍵字發 warn 提醒（warn-level，不 block）。

**gh body 序數防誤連結（cooperative-only）**：GitHub body 內，若 hash-number 只表示序數（第 N 個 PR／第 N 步），MUST 改寫為中文序數，或將純序數 token 放入 code-span，避免 GitHub 自動連到無關 issue/PR。只有真正引用既有 issue/PR 時才保留裸文字 hash-number；前述 auto-close 關鍵字仍必須保持裸文字。本判斷依賴語意，MUST NOT 以編號是否存在、大小等 heuristic 新增 mechanical gate。

### 例外：緊急直送

若遇到緊急狀況需要直接 commit（暫時不走 feature branch + OpenSpec 流程），仍需在 commit 訊息或 PR/交付說明中清楚註明「為何例外」；並在後續補齊該需求對應的 OpenSpec/feature branch 追溯流程。

## Exit Criteria

- PR 描述包含所有必填欄位（OpenSpec 路徑、tasks.md 狀態、Requirement Ledger Completion、測試證據、qa-test-scope.md；B-mini 使用 proposal-mini task outline 與 grep/test assertion evidence 替代）；條件式欄位視情況填寫
- 所有被觸發的 GitHub Actions workflow 均到達終態（`success` / `failure` / `cancelled`）
- 合併使用 regular merge（非 squash / rebase）
- OpenSpec archive 已在 merge 前完成

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「squash merge 讓 main 歷史比較乾淨」 | squash 破壞可促進單位邊界，讓 release 線無法以 `git merge <單位>` 穩定納入 subset，禁止使用。 |
| 「hotfix 只需要一個 PR 就夠了」 | source／consumer 同構：hotfix 單元不直合 production，經 carrier 組裝、tag 後 carrier ff＋back-merge PR 回 `main`；缺 back-merge PR（`MERGED`）未完成。 |
| 「`Fixes #N` 用反引號比較好看 / 一致」 | 反引號 = code-span，GitHub auto-close linker **不解析** code 內關鍵字 → issue 不會自動關閉。auto-close 關鍵字必須**裸文字**。 |
| 「`Close #12 / #34` 比較省事／一眼看出兩個」 | Slash 併寫不是合法多關閉形；GitHub 通常只認第一個 `#N`（`Close #12 / #34` 只關 #12）。改每行一條或 `Closes #12, closes #34`（每個 issue 都要完整 KEYWORD）。 |
| 「`Closes #12, #34` 是官方 comma 形」 | Comma 後仍須完整 `KEYWORD #N`；裸 `, #34` 不會關 #34（GitHub docs：Use full syntax for each issue）。正確：`Closes #12, closes #34`。 |
| 「`gh pr merge --delete-branch` 最方便，一步搞定」 | 若目標分支正被 linked worktree checkout，local cleanup 會失敗；先 merge（不帶 `--delete-branch`）。cleanup deferred until production：PR merge to main / post-merge local sync 都不是清 branch/worktree 的時機，須等 Release Step 6（PROD merge/tag pushed）後才可走 `prune-merged-local.mjs` dry-run → `--exec`／`--include-remote --exec` canonical flow——不要手動 `git push origin --delete`（與 branch-hygiene SSOT 衝突、被 pre-push hook 擋）。 |

## Verification

```bash
# 確認特定 PR 的 CI 狀態
gh pr view <N> --json statusCheckRollup --jq '.statusCheckRollup[] | {name: .name, conclusion: .conclusion, status: .status}'

# PR 描述必填欄位
grep -n "PR 描述必填" .devpro/agent-rules/git-pr-template-and-merge.md

# Squash/Rebase 禁止
grep -n "Squash and merge\|Rebase and merge" .devpro/agent-rules/git-pr-template-and-merge.md
```
