---
name: git-branch-and-pr-flow
description: 分支命名、PR 建立與 push 後追蹤的 hub。routing-only：依 step 路由至 git-branch-naming-and-anchor.md / git-pr-template-and-merge.md / git-workflow-tracking.md / git-branch-hygiene.md。觸發：建分支前、建 PR 前、push/merge 後、處理 issue 連結或 slash command 批次操作時。
---

# Git：功能分支與 PR 流程

## Overview

本檔是分支命名、PR 建立、push/merge 後 workflow 追蹤的 **hub（路由索引）**。可促進單位（`feature/`、`bugfix/`、`chore/`）與旁路分支（`hotfix/`）都以本檔為準。

關鍵約束：可促進單位分支只含自己的 commits；PR **必須** regular merge；push 後**必須**主動追到所有觸發 workflow 終態。

GitHub 工具選路依 `tool-selection.md`：已登入且可用的 gh 優先；只有明確未安裝／未登入，才可使用已驗證等價閘門的 devpro-work MCP。未驗證的 connector 寫入仍關閉。

依 step 路由至對應 leaf 取得完整規範；本檔保留跨 step 共用的前綴決策表與 Slash command 批次同意段。

## When to Use

- 開始新需求（建可促進單位或旁路分支）前
- 程式碼準備提 review（建 PR）時
- `git push` 到已綁定 workflow 分支後
- PR merge 後（確認 workflow 終態）
- 使用 `devpro:*` skill（確認批次同意範圍）時
- 需要對應 GitHub Issue 連結時

## Routing Index

| Step / 觸發 | 需讀 leaf |
|---|---|
| 開工建分支 / anchor / 可促進單位乾淨前提 | `git-branch-naming-and-anchor.md` |
| 建 PR / 合併策略 / issue 連結 / 緊急直送 | `git-pr-template-and-merge.md` |
| PR create 後 completion gate（workflow + cross-model + handoff） | `post-pr-completion-gate.md` |
| push/merge 後 workflow watch / Post-PR handoff wording | `git-workflow-tracking.md` |
| 分支清理 / merged 本地清理 / commit 前 settings 檢查 | `git-branch-hygiene.md` |

Load-chain（建 PR／合併策略／issue 連結／緊急直送）：載入 `git-pr-template-and-merge.md`。

## Process

### 建 PR 前先過 `/devpro:pre-pr`（advisory）

裸 `gh pr create` **不是** PR 流程的起點。建 PR 前 MUST 先走 `/devpro:pre-pr`（測試全綠 → 簡化 → 六軸 dp-reviewer → OpenSpec archive → PR 描述模板），除非使用者明示降 rigor 或明示跳過某步。**禁止**從「碼/檔改好了」直接 `git commit → push → gh pr create` 而略過 pre-pr——六軸是 pre-PR mandatory gate（per `devpro:pre-pr` Step 3、`chore-classification.md` 各類皆「必」），不是建 PR 後可補的選項。

**誠實註記（無 create-time hard gate）**：

- `gh pr create` 在 hook 層掛 archive gate、protected-branch、local-review PR-head guard 與 `--base` 提醒，**無**機械閘門檢查「pre-pr/六軸是否跑過」。
- 跨模型第二意見（PR sticky）是 **post-PR**：在 `gh pr create` 之後、`gh pr merge` 之前。機械兜底在 `gh pr merge`（`pre-tool-gate.mjs::checkCrossModelMergeGate`），不在 create。
- 六軸沒有 merge-time 機械閘門；create-time 也不擋六軸。不得把六軸寫成「兜底在 merge」。
- 故「create 前先過 pre-pr」靠 behavioral 紀律 + 本 advisory，**不**靠 create-time hook（per `design-core.md`：行為流程洞不用 command-intent regex 補）。
- AI 意圖建 PR 時應主動 invoke `/devpro:pre-pr`（per 下方「AI 主動 invoke slash command」），而非裸跑 `gh pr create`。

**跨 repo 開 PR**：命令加 `DEVPRO_CROSS_REPO_PR=<owner/repo>`（選路與限制見 `tool-selection.md`）。本機有 target checkout 時建議再加 `DEVPRO_PR_CHECKOUT=<absolute checkout>`：hook 會在該 checkout 驗 pre-PR evidence（契約見 `consumer-pre-pr-checks.md`）。沒宣告 checkout、target 也不是 command checkout 自己的 origin slug 時，marker create 是 remote-only：須字面 `--repo` 與 `--head <branch>`（不能是 `owner:branch`），不驗 evidence。`--repo` 請寫在動詞之後：哪些檢查不論 `--repo`／`-R` 位置都相同、哪些只讀動詞之後的寫法，見 `tool-selection.md`。

### 分支前綴

本檔為 hub；正常工作分支規範只承認五種前綴：`feature/`、`bugfix/`、`chore/`、`hotfix/`、`rules/`。**禁止** `fix/`、`bug/`、`feat/`、`refactor/`、`test/`、`docs/`、`sync/` 等任何其他前綴；release 格式依 `.devpro/agent-rules/git-branch-naming-and-anchor.md` §分支前綴對照表（唯一權威），`review/pr<N>` 僅本機驗證的專用例外依同檔「本機 PR 驗證」，禁止 push／PR head。**禁止**在受保護分支（`main`、`master`、`production`、`integration`、`release/*`）上直接實作。

> **Branch prefix 規範**：完整前綴對照表（情境、基底、合回目標、release subset）見 `.devpro/agent-rules/git-branch-naming-and-anchor.md` §分支前綴對照表（唯一權威）

### GitHub write path

先讀 `tool-selection.md`：本機 gh 有效登入時所有 GitHub 操作優先 CLI；僅未安裝／明確未登入時可使用具等價 client/server gates 的 devpro-work MCP。其餘 connector 維持唯讀，權限不足或結果不明不得換路徑。

PR creation success is not the end of the flow. Regardless of the tool path that produced an existing PR URL/number, `post-pr-completion-gate.md` must be entered and applied before reporting PR-create completion; connector/CLI/app integration/generic GitHub publish differences are not an exemption. If gates are pending or blocked, report the post-PR created state with workflow + cross-model + handoff status, including the blocked/ready handoff. For Codex `commit push PR`, PR URL/check polling is not completion.

### GitHub write-back body pattern

CLI 路徑的 AI-authored GitHub bodies（issue / PR / comment / review / discussion / release notes）must use a file-backed body that the footer hook can inspect before the real write. Standard pattern:

1. Create the body file in the main checkout at `<repo-root>/notes/tmp/<purpose>-<unique>.md` (gitignored; not bound to worktree lifecycle; version anchor = the session repo's canonical remote tip AGENTS.md). The basename MUST include purpose plus session/timestamp/PID/random entropy; the change name alone or fixed names such as `pr-body.md` are not enough.
2. Add the required footer before dispatch: `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>`.
3. Run a strict preflight against the exact intended command unless the active hook surface is already proven to enforce it:

   ```bash
   node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh issue create --body-file <repo-root>/notes/tmp/<purpose>-<unique>.md
   ```

   This is a validator-only dry run: it never executes the nested `gh` command, Exit `0` means validation passed only, and the invocation MUST NOT be treated as a GitHub write. On hook-proven shells, run the real `gh` command directly and let PreToolUse invoke the gate; MUST NOT manually insert this validator as an executor wrapper.

4. Run the real `gh` command with `--body-file <repo-root>/notes/tmp/<purpose>-<unique>.md` or the equivalent `-F body=@<repo-root>/notes/tmp/<purpose>-<unique>.md` form.
5. Delete the temporary body file immediately after a successful `gh` write unless the workflow explicitly treats it as a tracked artifact, then confirm `git status --short`.

Anti-patterns：do not use `--body-file -` / heredoc stdin as the primary path for TL-authored GitHub bodies, because pre-tool hooks cannot read the body before shell execution. Do not use repo-external `/tmp` body files for TL-authored GitHub issue / PR / comment / release bodies; use main-checkout `<repo-root>/notes/tmp/<purpose>-<unique>.md` instead. Reviewer-owned sticky staging uses the renderer-owned per-dispatch neutral cwd for every reviewer family; no recipe grants a main-checkout `<repo-root>/notes/tmp/` staging path. Target-worktree-internal staging remains forbidden. 寫檔目的地總表見 `file-write-destinations.md`。

### Slash command 批次同意

Git 操作預設都要先取得明確同意；`devpro:*` skill 享有下方批次同意豁免。若使用者只要求改檔，AI 不得自行加做版本控制操作。

**使用者 invoke `devpro:*` skill（host 叫用形見 active adapter）本身即視為對該 command 定義之標準 git 序列的一次性同意**，AI **不需**逐步再問。範圍限定於：

- `/devpro:change`：
  - **本地序列**（`<anchor-sha>` = `detect-branch-base.mjs --anchor` JSON `.sha`）：
    - `git fetch origin --tags`（不得用 `git fetch origin main:main --tags` 作為通用指令，避免 fetch into checked-out `main`）
    - `git worktree add <repo-root-abs>/.worktree/<change-name> -b <prefix>/<name> <anchor-sha>`
    - literal `cd <repo-root-abs>/.worktree/<change-name>` + `pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch` evidence
    - `git submodule update --init --recursive`（consumer 初始化已記錄 submodule；不含 remote rules update / sync commit）
  - **強制**：所有開/切分支一律走 worktree，無前綴例外（per `git-branch-naming-and-anchor.md`「Worktree 規範」段）— 不開分支操作（submodule 配置、純讀取）屬例外；**禁**直接在主 worktree 跑 `git checkout -b` / `git switch -c`
  - **延伸（同一批次同意、不需逐步再問）**：沿本次所建分支，在**首次 `git push` 之前**，為完成同一個 `openspec/changes/<name>/` change 所必須之本地 `git add`／`git commit`——含 `proposal.md`、`tasks.md`、`qa-test-scope.md`、`make-vs-buy.md`（若有）、同單位之 `chore: simplify <scope>`、測試／QA 文件、以及依 `openspec-flow.md` 在 merge 前必須完成之 **archive** 等（**不含** `git push`、不含與本 change 無關之檔案／其他單位之 commit）。
- `/devpro:sync-rules`：同一 consumer rules lane batch scope（per `rules-flow.md` / `release-rules-lane.md`）。
  - **可涵蓋**：`rules/<source>-v<X.Y.Z>` rules-to-main phase（pre-flight + sync/check + `chore: sync devpro-agent-rules (<sha>)` + push/PR）以及 PR merge 後 production continuation；也可涵蓋同一 named lane 內達 mandatory delegation threshold 的 bounded subagent launch authorization（`StandingDelegationAuthorization`）。
  - **Batch Scope Ledger**：Scope MUST 記成 Batch Scope Ledger，固定列出 push rules branch、create rules PR、merge rules PR、create release/rules branch、push release/rules branch、create production PR、merge production PR、push production tag、bounded subagent launch authorization；每項維持 `yes` / `no` / `ask-later`，missing 不授權。
  - **Production PR/tag**：若開頭 batch scope 明確點名同一 consumer repo/source version 並授權 release rules to production，則 gates pass 後依序 push work/release branch、create PR with base `production`、GitHub merge、resolve exact merged production commit、freshly fetch `origin/production` 驗證、tag the explicit commit `production-YYYYMMDD-rules[-n]`、push only the tag ref；未明確涵蓋 production PR 或 production tag action 時，最終 gate 仍須再次詢問。
  - **Subagent scope**：若使用者自訂 scope 排除 subagent launch，Codex 等 explicit-trigger runtime 仍須在第一次 mandatory dispatch 前進 `SubagentAuthPending`，不得把窄 scope 放大成完整 approval。
- `/devpro:pre-pr`：唯讀操作 + 測試執行（不含 push、PR 建立）
- `/devpro:setup-ci`：workflow 檔案寫入（不含 secrets 設定、push）

**偏離已授權標準序列 / 批次範圍**仍須逐項再問，包含：未被明確 batch scope 覆蓋的 `git push`（任何遠端寫入）、`git branch -D` / `git push origin --delete`（刪分支）、`git reset --hard`、`git rebase`、`git tag` 推遠端、建立 PR、`merge` 任何目標、修改 `.gitignore` 以外的 git 設定。

**Post-PR head movement ordering**：在 Step 5.5 / `/devpro:cross-review` 前，先完成 final base/mergeability sync；不要為已知即將 rebase / force-push / patch replay 的 head 建 dispatch-bound sticky。dispatch-bound `PASS|WARN` sticky/marker 出現後，`git rebase`、force-push、patch replay、任何 non-fast-forward head rewrite，以及 merge/graph recovery 都不屬於 batch approval；必須先停下詢問明確 git strategy。只要 sticky 的 `last_reviewed_sha != headRefOid` 且非 Path D′ fresh-equivalent（whitelist-only bookkeeping diff，SSOT `code-review-cross-model.md`），該 evidence 對 merge readiness 即為 stale；fast-forward/ancestor proof 只供 traceability。僅 exact per-lineage approval 可授權符合 post-PR recovery contract 的 active marker／clear-obligation rebind 或 clear，且不授權 git graph operation、不解除 fresh current-head review；不符合條件仍是 lineage-broken blocker。使用者明確授權的 lineage-preserving graph recovery 只恢復 ancestry/traceability，之後仍走 verified-fast-forward path 並跑新 current-head dispatch/sticky。

### Post-rebase narrative numeric freshness

已授權 rebase 若吸收會改檔案數／呼叫點數／參照次數拓樸的依賴，TL **MUST** grep 同 change 的 `meeting-notes.md`／`proposal.md`／`proposal-mini.md` 數字拓樸斷言並同步至 rebase 後現況，且在下次 review dispatch 前完成。
獨立單刀、未吸收依賴 rebase 的 change 不適用本節。
grep 後無數字拓樸斷言即 pass；不發明數字。
本節鄰近、非整段重複 Cross-Carrier Assertion Synchronization（edit/closeout）；本節 WHEN 是 rebase-absorb。
本節 **MUST NOT** 引入機械 lint 敘事數字（cooperative + 本葉 grep 鎖檢查清單；訊噪比不划算）。

**使用者在 slash command 中途改口**（例「停下不要 commit」）：立即停止，後續步驟重新取得同意。

**明確自然語言 batch approval**：使用者雖未逐字輸入 `/devpro:change <name>`，但同一請求已明確要求「開一個 change」且給出單一可推導 scope/name，並明說 `batch approval` 時：

- **認定**：視同已確認 `/devpro:change <change-name>` command + parameter，且授權同一 named change 的 whole `/devpro:change` flow batch approval。
- **範圍包含**：`/devpro:change` 本地序列、同一分支/change 的必要 local `git add` / `git commit`、pre-PR gate、首次 `git push -u origin <branch>`、`gh pr create` / PR body update、workflow watch/read-only status、post-PR completion gate、同一 named change 內達 mandatory delegation threshold 的 bounded subagent launch authorization、`scenario_walkthrough`。
- **Evidence**：此 approval evidence MUST 記錄 named change / branch（full 寫 proposal `## Batch Approval Ledger`，lite 寫 `lite-scope.md` 一行紀錄）；PR number 或 head SHA 不必在 approval 當下存在，post-PR gate 於 PR 建立後由 same named change + same branch + PR creation/update evidence derive exact PR binding。
- **Authority（needed/not-needed 判斷權）**：只有 active structured ledger 的 kind、named change、branch、same-repo scope 完全相符，`covers` 明列 `scenario_walkthrough`、`excludes` 不含 `scenario_walkthrough`，且沒有 custom scope 或 coverage 矛盾時，AI 才取得 needed/not-needed 判斷權：needed 直接執行，not-needed 記錄 change-specific risk reason，不得重問相同授權；authority 缺失、格式錯誤、ambiguous、mismatch、coverage absent 或 custom excluded 時仍由使用者決定。
- **不得重複確認**：AI 不得再消耗一輪確認是否要開 change、push 或 create PR；也不得再消耗一輪確認是否可在達門檻時用 subagent、是否允許 covered Scenario Walkthrough needed/not-needed decision。
- **例外**：`merge` / release promote / tag push / destructive action / secrets 只有在 batch scope 明確點名且 gate 已綠時才算授權；未點名則依前段逐項再問。

Cross-repo write remains outside `/devpro:change` batch approval and always requires separate explicit authorization.

**devpro:change 開場必問 batch scope**：

- **為何必問**：使用者不一定知道 `batch approval` 這個選項。
- **何時 + 必問內容**：當 TL 準備啟動 `/devpro:change` 且尚未取得「batch approval / 逐步確認」偏好時，第一個 user-facing confirmation / clarification batch MUST 主動包含 batch scope 選項，預設推薦「同一 named change 的 whole `/devpro:change` flow batch approval（含 `scenario_walkthrough`）+ mandatory-threshold bounded subagent launch authorization」，並提供「逐步確認」與開放項。取得選擇前不得進行第一個 git write。
- **已明說時**：使用者已在同一請求明說 `batch approval` 或 `stepwise confirmation` 時，此 gate 視為已完成；TL MUST 把選擇寫進 proposal / handoff evidence，供 Scenario Walkthrough authority decision 使用；lite 沒有 proposal，選 batch 後依 `/devpro:change` skill lite 段寫 `lite-scope.md`。
- **自訂 scope 排除時**：若使用者的自訂 batch scope 排除 Scenario Walkthrough 或 subagent，Codex 等 explicit-trigger runtime 仍須在第一次對應 decision / dispatch 前進 pending gate。
- **Cross-repo 例外**：Cross-repo write 不列入預設/推薦 batch scope。

### Business submodule gitlink（feature-branch tip）

Parent／host bump **業務** submodule gitlink（例 product service；**非** `.devpro-agent-rules` rules-sync，後者仍走 `rules-flow.md`／`rules-flow-routing.md`）時：
- MUST pin 該單位的 **feature-branch tip** SHA
- MUST NOT pin 下游 integration／merge commit（即使已含同變更集）
- tip vs 候選歧義：`gh api repos/<owner>/<repo>/compare/<a>...<b>`；空 file-tree ⇒ 語意等價，仍 prefer tip（等價不授權改 pin 下游 merge）
- tip 不可得，或 tip↔候選 compare 非空 file-tree → 停下交使用者（fail-closed；禁發明「改 pin merge」第二慣例）

### AI 主動 invoke slash command

使用者未明示命令但意圖明確（例「幫我開新分支做 X」）時，AI **可**主動 invoke 對應 `devpro:*` skill，並視同使用者 invoke。前提：

- 使用者意圖確實與該 command 的標準序列一致（不得扭曲意圖去套用）
- AI 在 invoke 前以一句話告知「建議透過 `/devpro:<name>` 推進」，並取得使用者明確回覆確認；**沉默、未反對、或只給使用者打斷機會不等於批次同意**
- command 若需參數（例 `/devpro:change <kebab-case-name>`），AI **先提議一個 kebab-case 名稱**並等使用者確認或替換，**不得沉默自取**；該名稱**同時作為**分支名與 OpenSpec change 目錄名，兩者必須一致。批次 git 同意只在使用者確認 command + 參數後生效
- 使用者若說「不要跑 slash command」或明確要求手動流程，尊重該選擇

依「能自己做的事不要叫人做」：AI 能自執行就不得丟回人工。

### 例外：緊急直送

詳 `git-pr-template-and-merge.md`「例外：緊急直送」（canonical source）。

## Exit Criteria

- 分支命名合規：前綴屬五種之一（feature/ / bugfix/ / chore/ / hotfix/ / rules/）、與 OpenSpec change 名稱一致（kebab-case）
- 分支從正確基底建立（可促進單位 → anchor；旁路 → 最近 `production-*` tag）
- PR 描述包含所有必填欄位（OpenSpec 路徑、tasks.md 狀態、測試證據、qa-test-scope.md）；條件式欄位視情況填寫
- 所有被觸發的 GitHub Actions workflow 均到達終態（`success` / `failure` / `cancelled`）
- 合併使用 regular merge（非 squash / rebase）— canonical source: `git-pr-template-and-merge.md`「合併策略」
- `git status` 顯示工作目錄乾淨（無非預期的 untracked files）
- OpenSpec archive 已在 merge 前完成

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「從 main 建分支比較快，anchor 差不多」 | anchor 不等於 main HEAD。從 main 建會吃進其他已 merge 的單位，污染 subset，release 時無法乾淨挑選。 |
| 「先 push 等使用者回報 Actions 結果就好」 | `gh run watch <run-id>` 一行就有結果；叫使用者去看是違規，AI 必須自己查到終態再回報。 |
| 「先把其他 feature 的 commit 帶進來再 revert 就好」 | revert 會留下歷史雜訊；正確做法是從乾淨的 anchor 重建分支或只 cherry-pick 需要的 commit。 |
| 「碼/檔改好了，直接 `git commit → push → gh pr create` 比較快」 | 跳過 `devpro:pre-pr`（六軸/測試/archive/PR 模板）違反 §建 PR 前先過 `/devpro:pre-pr`。六軸是 pre-PR mandatory gate，非建 PR 後可補的選項。`gh pr create` create-time **無** hook 擋此跳過（跨模型 sticky 兜底在 `gh pr merge`；六軸無 merge 機械閘門），故靠 behavioral 紀律——意圖建 PR 即先 invoke `/devpro:pre-pr`，除非使用者明示降 rigor。 |
| 「rebase 只碰程式碼，narrative 之後 second review 會抓」 | 那正是 issue #2133 多花一輪的成本；rebase 當下 grep 數字。 |
| 合併策略 / squash merge / hotfix 經 carrier 組裝 等 rationalization | 詳 `git-pr-template-and-merge.md`「Common Rationalizations」（canonical source） |

## Verification

依 step 路由至對應 leaf 取得完整 Verification 指令：

- 分支命名 / anchor：`git-branch-naming-and-anchor.md` Verification 段
- PR 描述 / 合併策略：`git-pr-template-and-merge.md` Verification 段
- workflow watch：`git-workflow-tracking.md` Verification 段
- 分支清理：`git-branch-hygiene.md` Verification 段

```bash
# Hub 快速抽查：確認當前分支前綴合規
git branch --show-current
# Hub 快速抽查：確認 anchor
node .devpro/scripts/detect-branch-base.mjs --anchor
```
