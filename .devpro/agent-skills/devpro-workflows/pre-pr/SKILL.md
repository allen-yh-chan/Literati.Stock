---
name: pre-pr
description: "Pre-PR readiness workflow：testing/QA、程式碼簡化、scenario walkthrough、六軸 review、spec-freeze archive、OpenSpec validate gate、PR 描述、post-PR workflow watch，以及 post-PR cross-model review。使用時機：使用者 invoke /devpro:pre-pr、要求準備 PR、要求跑 pre-PR checks，或測試全綠準備 push 時。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:pre-pr"
---

# Devpro Pre-PR

## Overview

本 skill 是 Devpro PR 前檢查流程的 routing 與操作食譜載體——測試/QA 驗證、程式碼簡化、scenario walkthrough、六軸 + security review、spec freeze archive、OpenSpec validate gate、PR 描述草擬，以及 PR 後 workflow/cross-model review。

**Policy SSOT 仍在 rule leaves——本 skill 不重複規範內容。** 測試慣例、簡化 heuristics、六軸 checklist、PR 模板欄位、cross-model 豁免/merge-gate 規則定義在 `testing-and-qa.md`、`code-simplification.md`、`code-review-checklist.md`、`git-branch-and-pr-flow.md`、`git-pr-template-and-merge.md`、`code-review-cross-model.md`。權威判斷務必載入並執行這些規則，不可只依本 skill 摘要。

## When to Use

使用者執行 `/devpro:pre-pr` 準備建立 PR 時；測試全綠後、push 前。
- 使用者詢問「這樣可以建 PR 嗎」或「跑一下 pre-PR checks」

## Process

MUST 先依 `rules-rigor-level.md` 核對 rigor 及來源；未設定預設 lite。lite 依矩陣免 full OpenSpec／六軸／simplify／Recap／mandatory delegation，保留測試、P2/P3 named-def checks、Consumer Pre-PR Checks Gate、Pre-PR DEV Verification Gate、PR/workflow/post-PR 與 cross-model gate。不得為了跑本 recipe 的完整段落自行升 full；需要升級時先走該 leaf 的理由與使用者授權。以下完整 artifacts／review/archive 段只在 full 已獲明確選定時適用。

**lite 刪 canonical scenario**：lite 的 push 不會自動跑 archive gate。PR diff 讓 `openspec/specs/<cap>/spec.md` 少了 `#### Scenario:` 標題時，在 PR 說明加 `## Removed Scenarios` 段逐行列裸標題，PR 建立後跑 `node .devpro/scripts/pre-pr-archive-gate.mjs . --pr <n>` 直到綠燈；SSOT 見 `openspec-archive-principles.md` Gate (i)。

TL 預設已載入 AGENTS.md §0（動手前十句自檢）+ §Intent 速查表（hook 注入或主 agent 主動讀取均可）；以下檔案於命中對應 step 時 lazy load（不在命令開頭一次讀完）：

1. `.devpro/agent-rules/testing-and-qa.md`
2. `.devpro/agent-rules/code-simplification.md`
3. `.devpro/agent-rules/code-review-checklist.md`
4. `.devpro/agent-rules/git-branch-and-pr-flow.md`
5. `.devpro/agent-rules/git-pr-template-and-merge.md`（PR 描述 canonical 模板 SSOT；Step 4 必讀，省一跳路由）
6. `.devpro/agent-rules/pre-pr-dev-verification.md`（命中 DEV gate 時）
7. `.devpro/agent-rules/project-verification.md`（命中 DEV gate 時，找專案驗證入口）
8. `.devpro/agent-rules/ci-cd-integration-deployment.md`（命中 DEV gate 時，辨識 integration-only 部署 workflow）

**跳過條件**：若同一 session 內已讀過上述檔案，且 `git diff HEAD -- <file-path>` 確認該檔案自上次讀取後未變更，可跳過重讀該檔案（見 `model-delegation.md` Token 效率規則 (c)）；hook 已預載 A+C 內容也算 cache hit，同 session 內已讀 + git diff 確認檔案未變更可跳過重讀。

### Batch Approval Carry-Forward Precheck

在任何 pre-PR / PR 建立流程中，TL 要停下詢問 Scenario Walkthrough、same-branch first push、PR create/update、workflow watch、或 post-PR completion gate 之前，MUST first inspect active proposal / proposal-mini / decisions / handoff 的 `Batch Approval Ledger`（lite 無 proposal 時為相符的 `openspec/changes/<change-name>/lite-scope.md`，欄位同義，格式見 `/devpro:change` lite 段）。若 ledger 為 `kind: same-change-dp-change-batch`，且 `named_change`、`branch`、`repo_scope: same-repo` 與當前 branch/change 相符，並覆蓋 `pre_pr_gate`、`first_push`、`pr_create_update`、`workflow_watch`、`post_pr_completion_gate`、`scenario_walkthrough`，TL MUST NOT ask again and MUST continue through the covered action or decision.

**Anti idle-stop**：matching ledger 覆蓋 `post_pr_completion_gate` 時，sticky `PASS`/`WARN`、workflow terminal/`N/A`、或 sticky URL **不是** terminal stop，也**不是**重問 covered 步驟的理由——它們只是 gate progress；TL MUST 繼續跑完 post-PR completion 並發出 Ready Response（merge Ask First 仍屬 `excludes: merge` 的 user-owned 停點）。禁止「都 PASS 了要不要停／下一步要我做什麼（卻重問 push/PR/sticky）」這類 covered-scope 回問。

**Implementation-complete anti idle-stop**：matching ledger 覆蓋 `pre_pr_gate` 時，tasks／實作／測試全綠 **不是** terminal stop——TL MUST 直接進入本 skill 流程續跑（pre-PR→covered push/PR/watch），**MUST NOT** 製造「1.跑 pre-PR 2.只 push 3.開 PR」編號選項重問同一授權（SSOT `ai-autonomy.md` Implementation-complete → covered pre-PR）。

只有 exact matching-and-covered `scenario_walkthrough` authority 才把 AI needed/not-needed decision 限定移交給 TL；ledger 缺失、malformed、ambiguous、repo/branch/change mismatch、coverage absent、custom excluded，或需要 merge / release / tag push / destructive / secrets / cross-repo write，仍是 user-owned stop point。Batch approval 也可覆蓋 mandatory-threshold bounded subagent launch，但任何 coverage 不得跨 named change、branch 或 repo 重用。

讀完後，依序執行：

### 前置檢查

1. **分支合法性**：`git branch --show-current`。禁止 `main`/`master`/`integration`/`release/*`/`production`；前綴必須是 `feature/`、`bugfix/`、`chore/`、`hotfix/`、或 `rules/`。
2. **工作目錄乾淨度**：`git status --porcelain`；若有非預期暫存檔（腳本、log、偵錯輸出）先清理。
3. **Submodule 乾淨度**：`git status` 確認 `.devpro-agent-rules` 與根層 `AGENTS.md` 無未提交變更；否則先補獨立 `chore: sync devpro-agent-rules (<short-sha>)`。
4. **Stale local main／BASE tip（勿強制 mutate local main）**：`git fetch origin main 2>&1 | tail -2`。步驟 5 **優先** `merge-base origin/main`（與 PR three-dot／receipt tip 同源），因此 local `main` behind **不是**派工／ownership 檢查的擋板——**MUST NOT** 把 `git checkout main && git pull --ff-only` 或 `git update-ref refs/heads/main refs/remotes/origin/main` 當通過前置條件（前者在 linked worktree 會失敗；後者在 `main` 已被 owning worktree checkout 時會讓該 checkout 的 index／files 與新 tip 脫節）。**MAY**（可選清理）：僅當 `git worktree list` 顯示 **沒有任何 worktree 正在 checkout `main`**，且 local `main` 是 `origin/main` 的 ancestor 時，才允許 `git update-ref refs/heads/main refs/remotes/origin/main`；或在 **owning worktree**、working tree 乾淨時 `git pull --ff-only`。diverged → stop／Ask First。**MAY** rebase work branch onto `origin/main`。Receipt tip SSOT 仍是 `git show-ref --verify --hash refs/remotes/origin/main`，與 local main 是否已對齊無關。
5. **本單位 commits 認定**：`BASE=$(git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD)`（旁路：`production`）——**優先** `origin/main`（與 PR three-dot／receipt tip 同源）；僅 remote-tracking tip 缺失時 fallback local `main`。`git log $BASE..HEAD --oneline` 不可混入他單位或 `Merge main`。**豁免清單**（不視為 subset 污染）：`chore: sync devpro-agent-rules`、`chore: simplify`、測試/QA 文件。**依賴分支例外**：本分支從 `feature/A` 建時改用 `git log feature/A..HEAD` 排除上游合法 commits。此 commit ownership 檢查不同於 PR file scope；reviewer / path-filter / exemption 檔案範圍一律用三點 diff。
6. **Committed diff whitespace gate**：跑**兩道**——
   - `node .devpro/scripts/check-committed-diff-whitespace.mjs --base <target-base-ref>`（一般 PR：`main`；production 旁路：`production`）：等價 `git diff --check <target-base-ref>...HEAD`，抓本 PR **新增/改動行**的 whitespace / EOF blank-line。
   - `node .devpro/scripts/check-committed-diff-whitespace.mjs --changed-files <target-base-ref>`：對**本 PR 改動的每個檔**做全檔 `git diff --check`（vs empty-tree），抓該檔內**既有**（更早帶進、三點 diff 漏掉）的 whitespace / EOF blank-line。**Why**：`--base` 三點 diff 只看本 PR delta，既有 EOF blank 會逃過每個 PR 增量 gate、累積到 release 全量（`--release-main <selected-main-sha>`）才爆；`--changed-files` 把它前移到改該檔的 PR。兩道都須 pass；plain working-tree-only `git diff --check` 不可替代。
   - **Spec EOF 自動自癒**（使用者已同意此寫操作）：兩道 gate 通過後，自動跑 repo-wide `node .devpro/scripts/normalize-eof.mjs --fix`。用 `git diff <target-base-ref>...HEAD --name-only -- openspec/specs/`（一般 PR：`origin/main...HEAD`）區分範圍：僅三點 diff 內的 spec.md 可納入本單位 commit。若 `--fix` 改到三點 diff 外的 spec.md，MUST 獨立 commit，並在 PR body 列出那些檔案與 originating commits。MUST NOT silently stage the entire `openspec/specs/` tree into the unit commit。Archive checkpoint（`openspec-step-1-to-9.md`）仍只修本 change 剛 promote 的 spec。

### Step 1: Testing & QA

- 跑專案約定測試指令並全綠（建議 TDD：RED→GREEN→REFACTOR）；輸出預計 >100 行時委派 `dp-assistant` 執行與摘要。
- **跳過條件（HEAD-scoped，不是 session-scoped；source-only——consumer 一律重跑自身 suite）**：`evaluateRegressionHeadCurrency`（`regression-head-record.mjs`）為 `ok: true` 時才可引用前次全綠結果不重跑——含 (a) `head_sha` **逐字等於**當前 committed HEAD，或 (b) 收據 HEAD 是 tip 祖先且 `tested..tip` 經 rename-aware 展開後皆屬 R6 bookkeeping 允許集（`kind: current-bookkeeping-tip-move`；窄於 ui-smoke；行為承載 `SKILL.md`／workflow md／scripts／tests **不**豁免）。收據不存在、malformed、非祖先、或有非允許路徑 → 一律重跑。session 從來不是正確的作用域——同一 session 內 Step 2 的簡化 commit 會推進 HEAD，卻不會讓「本 session 已跑過」變成假，於是引用到的綠燈證明的是另一棵樹（notes item `## 107.`）。
- **全綠後立刻記錄涵蓋的 HEAD（MUST；source-only）**：canonical suite 全綠後馬上執行 `node .devpro/scripts/record-regression-head.mjs --change <name> --suite-status pass --suite-fail 0 --suite-digest <64hex>`（`<64hex>` 取自 runner 在全綠時印出的 `[test-suite] suite_digest_sha256=` 行：它涵蓋該次實際跑的所有 tier（例如 `--changed main` 的 unit 加所選 integration），只跑 unit 與 unit 加 integration 的值不同；MUST NOT 自行彙總各 tier 的 `digest_sha256=`。該行印 `unavailable`（`--stdio inherit` 沒有 log）或沒有該行（有 tier 失敗）時不得自造，改以預設 `--stdio log` 重跑；值 MUST 為 64 lowercase hex），把這次全綠涵蓋的 committed HEAD 與 `suite_evidence` 寫進上述收據；sha 由該命令自己 `git rev-parse HEAD` 取得，TL **不手抄**。缺 suite flags → CLI 拒寫，receipt 無法通過 local-test merge evidence gate。Step 2 之後重跑的那次也要再記一次——最後一次全綠涵蓋的 HEAD 才是有效的那個。沒記或記的是舊 HEAD，第三點零步段的 `--pre-review` 會 fail closed 擋下派工（R6）。**Consumer（canonical-suite 收據義務為 source-only）**：consumer 以專案約定測試指令為準，測試證據（含 inherited／pre-existing／環境型失敗的誠實記錄，依 `testing-and-qa.md` Exit Criteria 的 suite×HEAD／digest 綁定段與 `ai-autonomy.md` 的「環境不可執行」段）寫入 PR 即可；consumer 不需、也不應產出 `notes/qa-regression-head-<change>.json`，亦不得以任何形式冒充綠。
- bug fix 必須有 prove-it test；E2E/integration（若定義）也需全綠。
- 檢查或產出 `qa-test-scope.md`（含 E2E 結果或「無 E2E」）並確認 `tasks.md` QA 勾選。B-mini 例外：引用 `proposal-mini.md` `Tasks` 段 task outline 與 grep/test assertion evidence，不要求不存在的 `tasks.md` / `qa-test-scope.md`。
- **ui smoke 閘（MUST）**：讀 `qa-test-scope.md` 的 `ui smoke:`／`ui smoke head:`（正文與 head currency SSOT：`testing-and-qa.md` §UI smoke）。user-visible UI 觸發時：缺欄、空值、實填仍含未解析 `|`（ILLEGAL 模板殘留）、或 `ui smoke head:` 缺／錯／不符合 `testing-and-qa.md` §UI smoke 的 head currency → **不得**宣告 pre-PR／first PR 就緒；回補記錄。web 觸發且填 `done` 時確認 Playwright／browser 自驗＋screenshot／log evidence（matching `same-change-dp-change-batch` 下 screenshot **即足**，**MUST NOT interrupt** user）。明確非 UI（含 rules／skills／docs-only）可用 `N/A+why`；觸發歧義禁 `N/A+why`。E2E「無」與 PR `## Manual Test` **不得**替代本閘。
- **執行迴路（checkbox = 執行狀態）**：此處「確認勾選」不是收尾時一次補勾，而是驗證整個實作過程已按 `openspec-quality-and-formats.md` §Tasks.md 品質要求「執行迴路」逐條認領→做→**當下回勾**、每 `[x]` 綁證據跑完。B-mini 同理驗 `proposal-mini.md` `Tasks` 段全 `[x]`（或明示 `## Deferred`）且每勾帶結構性證據 anchor（`[Req: R#]` + 驗收行）。**建議**全程接 harness task 追蹤（`TaskCreate`/`TaskUpdate`）作外部化執行迴路，勿記憶驅動；**回勾對象是 canonical task-ledger artifact（full=`tasks.md`；B-mini=`proposal-mini.md`）的 `[ ]→[x]`，非 harness task**——只 mark harness completed 不回寫檔案＝未回勾。空打勾（無證據）視為未完成，收尾 lint（Step 3.6 `lint-proposal-tasks-checked.mjs`）會機械擋下。
- 應用程式版號 bump 只做檢查與提醒：預設走獨立 `chore/bump-v<X.Y.Z>` PR；若要併入本 PR，需使用者明確授權並在 PR 寫明理由。
- **QA dispatch repository profile（前置、必過）**：選 test command 前先分類 direct consumer、Git-verified consumer-owned true `.devpro-agent-rules` submodule、或 source；Mode A/B consumer 都跳過 source-only corpus，實際 route 以 canonical runner 為準。
- **Source repo tier-aware 測試執行（必過，僅 source repo）**：前述分類為 source 時，PR feedback 可先跑 bounded fast gate `node .devpro/scripts/run-test-suite.mjs --tier fast`；它完整跑 `unit` 加固定代表性 integration carrier set，目標是讓回饋維持在 60 秒內，但不得宣稱 coverage-complete。最後的 source canonical evidence **仍必須**跑 tier-aware runner `node .devpro/scripts/run-test-suite.mjs --changed main`——unit 必跑；integration 只跑本 PR 增改的 integration tests、以完整路徑引用被改腳本的 integration tests、其 shard-import wrappers，與固定的掃全 repo 檢查清單（腳本無人引用則不選，不 fallback；無法判斷時 fail closed 到完整 integration tier）；runner 預設 `--stdio log`，child TAP stdout/stderr 寫入 main-checkout `notes/tmp`，console 只印 wall-clock + pass/fail/log summary；只有本機人工 debug 明確指定 `--stdio inherit` 才 raw console output。`node .devpro/scripts/check-suite-runtime-budget.mjs` 現為**純回報**用途：仍實跑 canonical full suite 並印出 wall-clock，但**不再**依 90s budget 擋 PR（紅 suite 仍 exit 1）；如需效能調校可參考 `test-performance-patterns.md` 四 pattern，非必要修復項。Consumer repo 跳過此步（consumer 不跑 source full suite）。

### Step 2: Simplification Pass

- 依 `code-simplification.md` 核對閱讀負擔與重構前後行為；巢狀（>3）、行數（>50）、重複只作調查訊號，不能按數量強制拆合。再檢死碼與命名。
- 簡化與功能變更分 commit（`chore: simplify <scope>`）。
- **Touch-scoped formatting（#2482）**：若跑 prettier／eslint --fix／同等格式化，範圍 MUST 收斂到本次觸及檔（`git diff --name-only` 清單）；禁寬 glob 無聲污染。格式化後確認 `git status --porcelain` 檔案數／集合與預期一致；無關檔還原。刻意全庫格式收斂 MUST 獨立 commit 並在 PR body 說明。政策 SSOT：`code-simplification.md` §Touch-scoped formatting。
- 簡化後要重跑 regression suite（同 Step 1 委派邏輯），全綠才進 Step 3。
- **簡化修改的委派**：rename/move/dead code → `dp-assistant`；需理解語意的重構（extract function/降巢狀）→ `dp-programmer`；單處小改 → TL 直接做。

### 第二點五步段：Scenario Walkthrough

#### Part 1: Trigger Conditions

同時滿足以下兩點才進入段二，否則跳過整個第二點五步：

1. 當前 repo 為 source repo（origin 是 rules source 且有維護語料 sentinel；沒有 `.gitmodules` 不代表是 source）
2. `git diff <target-base-ref>...HEAD --name-only`（一般 PR 為 `main...HEAD`；production 旁路為 `production...HEAD`）涉及任一 **enforcement 載體**：
   - `.devpro/agent-rules/*.md`（rule body 內容）
   - `scenarios/scenario-*.md`（scenario spec）
   - `.devpro/scripts/hooks/*.mjs` 或 `.devpro/scripts/hooks/lib/*.mjs`（hook 機械 enforcement）
   - `.claude/agents/*.md`（subagent prompt — implements rule via agent behavior）
   - `.claude/commands/*.md`（slash command — codifies multi-step rule workflow）
   - `.devpro/agent-skills/**/SKILL.md`（workflow-carrier skill body — command 廢除後承接 multi-step rule workflow 入口）
   - `.devpro/agent-skills/**/references/*.md`（skill references — enforcement 內容常遷入此層，與 SKILL.md 並列觸發）

> 任一改動皆等同改規則行為。Rule-ref filtering 由 dp-assistant 在 Part 2 做 scope-filtering（hook 改動只觸發 hook-related scenarios），避免「狼來了」疲乏。Per `ai-autonomy-root-cause.md` §Root-Cause First 一併修同類問題。

Consumer repo 跳過此步（規範變更來自 submodule sync，已在 source repo 驗證）。

#### Part 2: Bounded Decision and User Fallback（禁止 silent skip）

Trigger 命中後先解析 active `Batch Approval Ledger`（lite 為 `lite-scope.md`）。Only exact matching-and-covered `scenario_walkthrough` authority transfers the AI needed/not-needed decision；matching 必須同時滿足 `kind: same-change-dp-change-batch`、同一 named change、同一 branch、`repo_scope: same-repo`、`covers` 明列 `scenario_walkthrough`、`excludes` 不含 `scenario_walkthrough`，且沒有 custom scope 或 coverage 矛盾。

- For matching-and-covered authority determined needed because a changed gate, authorization boundary, workflow state transition, failure/recovery path, or other behavior requires reasoning beyond mechanical tests, directly execute the scope-filtered walkthrough without another user prompt；委派 `dp-assistant` 逐條執行 rule-ref filtering + Rule Walkthrough / Negative Checks / Assertions per scenario，通過後記錄 `executed PASS`。
- For matching-and-covered authority determined not-needed because the walkthrough adds no material assurance beyond current diff evidence and mandatory mechanical tests, record `skipped by AI decision: <reason>` with a non-empty diff-risk-specific or change-specific risk reason；schedule、effort、token cost 或 auto mode 不得作為 reason，且不得再次詢問相同授權。
- For missing, malformed, ambiguous, mismatch, coverage absent, or custom excluded authority, use a structured user prompt via `AskUserQuestion`; if unavailable, use numbered plain-text and wait for the user's actual reply；禁止 silent skip、自動選「否」或把工具缺失解讀為授權。

User-owned fallback 的 structured prompt 問：「本 PR 改動觸發 Scenario Walkthrough，要執行 dp-assistant 逐條 walkthrough 嗎？」選項如下：

1. **「是，執行 walkthrough」**（Recommended for: 改 gate / routing / 收尾條件 / 新增條款 / diff > 50 行 / 涉及 scenario rule ref 直接覆蓋的段落）
2. **「否，跳過 walkthrough」**（純文字微調 / 排版 / typo / 同義詞替換；必須提供 non-empty reason）

**強制規則（即使 auto mode 也適用）**：

- User-owned fallback MUST 在 `AskUserQuestion` 或 numbered plain-text 後等使用者實際回答；工具不可用時在 PR evidence 記錄 `[TL fallback: AskUserQuestion unavailable]`
- 使用者選「是」→ 委派 `dp-assistant` 執行 scope-filtered walkthrough；任一 scenario FAIL → 停下回報，修正後整個 `/devpro:pre-pr` 從 step 1 重跑
- 使用者選「否」→ PR 描述 `Scenario Walkthrough` 欄位記 `skipped per user decision: <reason>`，且 reason 必須 non-empty
- 使用者或 matching-and-covered AI 選擇執行且 walkthrough 通過 → PR 描述 `Scenario Walkthrough` 欄位記 `executed PASS`；**停點訊息也要驗**：委派時 MUST 要求回報每個停點實際對使用者說的內容，TL 判定前 MUST 逐一對照規則原文——規則要求停點呈現的資訊（要列出的項目、選項、原因；寫在其他步驟而指向這個停點的也算）缺任一項即 FAIL；只比對「停不停」與最終產出（證據行、可否開 PR）不得記 `executed PASS`
- 非 enforcement-carrier change → 記錄 `N/A (non-enforcement-carrier change)`
- 缺 `Scenario Walkthrough` 欄位視為違反

#### Part 3: Safety Net

`.devpro/scripts/tests/scenarios.test.mjs` 的 assertion **機械驗證**不受 walkthrough disposition 影響，無論記錄 `executed PASS`、`skipped by AI decision: <reason>`、`skipped per user decision: <reason>` 或 `N/A (non-enforcement-carrier change)` 都仍須執行且強制必過；本條款僅影響「dp-assistant 逐條閱讀 scenario `## Rule Walkthrough` checkbox／`## Negative Checks`／`## Assertions` 的步驟」（即此第二點五步流程節點），任何 disposition 都**不得**繞過或取代機械驗證 gate。

### 第三點零步段～第三點七步段（僅 full）

rigor 為 full 時，MUST 先讀 `references/full-review-and-archive.md`，依序執行其中的第三點零步段（Pre-review 機械掃描）、第三步（Six-Axis Review）、第三點六步段（Spec Freeze Archive + Archive Gate Check）與第三點七步段（OpenSpec Validate Gate），再執行下方 Post-Ledger Final Evidence Gate；本檔其他段落提到這些段名時，內容都在該檔。下方「第三步：Six-Axis Review」只留 capability spec 指定本檔為 authoritative carrier 的段落，於該檔第三步流程中標示的位置適用。lite 不執行這些段落，也不必讀該檔：lite 沒有 primary review、不造 receipt，正式 cross-model 由 Step 5.5 執行；lite 刪 canonical scenario 的處理見 Process 開頭。

### 第三步：Six-Axis Review

僅 full。完整流程見 `references/full-review-and-archive.md` 的第三步；以下段落是 capability spec 指定本檔為 authoritative carrier 的部分，於該檔標示的位置適用。

**Receipt-authority named dispositions（MUST；禁自造 `dispatch_id`）**：下列兩種情況 Step 3 的 `classify-bounded` → `seal-receipt` 鏈**不可滿足**時，TL MUST 記錄具名 disposition 並走對應路徑，**MUST NOT** 以 UUID／random／conversation 值填 `dispatch_id`：

1. **`receipt_authority_restart: missing_predecessor_seal`（#2481）**：本 change 尚無任何 sealed `notes/review-<change>-receipt-r*.json`（首輪漏封或機制引入前的歷史），僅有 mutable `notes/review-*.md`。復原＝重跑 `classify-bounded` 且 `previousReceiptRef: null`，取得合法 round-1 `route=full` 的 `dispatch_id`／`risk_shape_digest_sha256` 後再開六軸並立刻 seal。先前 mutable envelope **不是** `walkReceiptAuthorityChain` predecessor。行為路徑：`classifyBoundedRereview` 在 `previousReceiptRef === null` 時走 `initial_review` 並 mint round-1 `dispatch_id`（既有 prove-it：`review-remediation-evidence.test.mjs`「initial classifier returns exact content-addressed dispatch context…」）。重啟 seal 後，`classify-final`／`seal-final` 只評估這條新 sealed lineage，不得把先前 mutable-only 歷史當 predecessor。
2. **`receipt_authority_unavailable: chore_a_no_openspec`（#2495）**：chore A 依定義無 OpenSpec change folder（`proposal.md`／`proposal-mini.md` 皆不存在），`classify-bounded` 回 `route=risk_shape_unavailable`（debug reason 通常為 `change_folder_invalid`；disposition 以 chore-A 形狀＋此 route 為準，不綁定特定 debug-reason 值）。此時仍跑 dp-reviewer 六軸，但 **不**要求 classifier `dispatch_id`、**不**跑 `seal-receipt`；證據載體＝mutable envelope + PR body Review Summary；**MUST NOT** 宣稱已進入 `walkReceiptAuthorityChain`。互指 `chore-classification.md` §Chore A 共同不變式。

**Bounded dispatch authority checklist**（`classify-bounded` 後、dp-reviewer dispatch 前必讀）：
- `dispatch_id`：MUST 為 `classify-bounded` 輸出的 64-hex SHA256 logical dispatch digest（`canonicalJsonV1` over logical dispatch）；**MUST NOT** 使用 UUID／random id／conversation 自造值
- `route=bounded`：`repair_delta_manifest_ref` 與 `dependency_closure_manifest_ref` MUST 為 non-null sealed manifest refs（首輪 `previousReceiptRef: null` 兩份 refs MUST 為 `null`；之後 null refs 不是 route 探測：先封 manifests 再跑 `classify-bounded`；validator trust surface 變動且無先行 mandatory reopen（`git_lineage_changed`／`digest_alg_mismatch`／非 stall 的 `risk_shape_changed`）時，null refs 只在 production validator oracle 無法獨立驗證時才得 full）；材料備製依 `code-review-checklist.md` §小修與 bounded 複審範圍；small `fix-now` 留在本 change，full Touch／requirement anchors 不擴大 bounded 閱讀面。
- `receipt_payload.scope` 欄位集（exact five keys）：`risk_shape_digest_sha256`／`risk_shape_digest_alg`／`open_finding_ids`／`repair_delta_manifest_ref`／`dependency_closure_manifest_ref`；`risk_shape_digest_alg` MUST echo `classify-bounded` 的 exact 值（MUST NOT guess／invent／改寫），缺欄在 capture 以 `raw-payload-invalid — scope.risk_shape_digest_alg is required` fail fast；`open_finding_ids` MUST 為無重複的非空字串並依 code-point 嚴格遞增排序（字串序而非數字序，空陣列合法），否則 capture 以 `raw-payload-invalid` fail fast
- 範例／欄位語意：`node .devpro/scripts/review-remediation-evidence.mjs --help`（seal-first 與 null-ref 說明）；sealed receipt/manifest 路徑範例見 `review-remediation-evidence.test.mjs`。等同 forward re-anchor 的資格、兩輪 base／surface 綁定與 fail-closed 邊界見 `code-review-checklist.md` §Bounded Six-Axis Rereview Cadence；range-diff 不代替 Git tree 證明或 current HEAD 複審。

**Durable handoff**：初次/full傳review mode與full reopen reason；full successor（`previous_receipt_ref` 非 null）另傳 `previous_receipt_ref`（path+digest）與predecessor `open_finding_ids`，reviewer 由該收據讀必帶 finding 的完整 observation；bounded只傳receipt path+digest、exact `finding_id`+`expected_observation_hash_sha256`、open finding IDs、fresh `repair-delta` path+digest、immutable `dependency-closure` path+digest及count。same-agent continuation只是optimization，MUST NOT成為correctness requirement；replacement reviewer只靠durable refs即可續接。

**跨輪結轉 finding 時比對 observation 主體（MUST）**：bounded／handback／full 沿用同一個 `finding_id` 時，TL MUST 逐條比對該 id 前後兩輪的 observation **主體**是否仍是同一件事。結轉的 observation 完整帶入、不截短不摘要，主體沒變預設逐字沿用，只有關閉契約要求的欄位與同一主體位置移動的 `carrier`／`anchor`／`evidence` 可改（SSOT `code-review-checklist.md` §Bounded Six-Axis Rereview Cadence），`scope-unresolved` 轉 closed 那輪全部欄位須與上一張收據逐字相同。`observation_hash` 變了不是換題證據（依 SSOT 更新欄位或重新措辭都會變），主體換了才是。主體換了＝原主體仍是 open finding：原 id 須另立處置（`fix-now`／`tracked-follow-up`／具名拒收），不得因新主體已修就結案。實例：`F-r19-mode-mismatch-message` 在 r19 指 archive transition 的 mode 檢查搶先於 untrack 訊息，r20 換成無關的 `invalid review_mode` 訊息，TL 修了 r20 的主體並記 `fix-now`，r19 的原主體差點就此結案。

**Successor `findings[]` 組成與失敗路由（SSOT `code-review-checklist.md` §Bounded Six-Axis Rereview Cadence，本段只摘要）**：`previous_receipt_ref` 非 null（含 full）時，reviewer 回報的 `findings[]` MUST 含 predecessor 的必帶集合（`open_finding_ids` 全部＋predecessor 每筆 closed Critical；TL scope ruling 關閉者 MAY 省略，預設省略、重帶須由 TL 在該輪 bound HEAD 補綁本輪 `round_number` 的新裁示）與本輪新 finding。
- 更早已 closed 的其他 finding MAY 省略、MAY 重帶；重帶舊 ID 要 reopen 就寫 `state: open`、`disposition: null`。
- full 輪也不豁免：full 輪 MUST 沿用 predecessor 必帶集合的 `finding_id`（`git_lineage_changed` 等 full reopen 同）；MUST NOT 對同一件事另發新 ID 取代舊 ID。
- `predecessor-finding-omitted` 是 reviewer payload 缺陷，不是 receipt authority 缺陷（「收到 reviewer 回報後」段「不得重派 reviewer」的限定例外）：capture 回此碼＝零發布，請 reviewer 補齊重產（優先 continue 同一 thread，不能接續時 fresh dispatch；同輪補齊的 `admissionRecordId` MUST 沿用該輪 dispatch 的 admission record：fresh 輪是原 fresh record，續作輪是該輪的續作 record，補齊訊息另寫的新續作 record 不作本輪 authority），以同一 dispatch tuple 重跑 capture；TL MUST NOT 手補 finding 或改 payload。build／seal 回此碼而 raw 已發布（舊工具 capture 的 raw）：full 輪 commit 後重跑 `classify-bounded` 取新 `dispatch_id`；帶 sealed manifest 的 bounded 輪不可重封，交回 operator；不得覆寫、刪除或回收已發布 raw。

**收到 reviewer 回報後**（blocked／partial／finished）：第一個動作 MUST 將 reviewer payload materialize 至 `<main-checkout-root>/notes/review-<change>-r<N>.md`（mutable source）。該檔 bytes MUST 恰等於 `canonicalJsonV1(payload) + "\n"`（UTF-8、key 依 canonical code-point order、exactly one trailing LF）；若 host 只回 structured JSON value，唯一允許的 materialization 是對該 value 執行這個 serializer，不得修改、摘要、手排欄位或夾帶 transcript／prose／code fence。接著以 exact camelCase request keys `repoRoot,changeId,roundNumber,dispatchId,payloadPath` 執行 `node .devpro/scripts/review-remediation-evidence.mjs capture-reviewer-output --request <capture-request.json>`；capture 在 immutable publication 前以同一份 in-memory bytes 重驗 canonical v3 raw shape、null producer placeholders及exact tuple，並只為既有closed historical post-hoc allowlist保留byte-exact legacy carrier例外。`raw-payload-invalid` 在尚無 target carrier 時是零 publication且可用同一 review／dispatch修正source後重跑capture；若該fixed path已存在，MUST NOT覆寫、刪除、修復、回收或稱為idempotent。capture 回傳 ref 才是 immutable raw payload authority。立即把該 ref 放入 closed-shape builder request：共同必填只有 `repoRoot,changeId,rawPayloadRef`，runtime 另帶唯一 `admissionRecordId`，closed post-hoc 另帶唯一 sealed `attestationRef`，TL-direct 兩者皆不帶；執行 `build-receipt-request --request <builder-request.json>`，並把其 canonical stdout 原樣作為 `seal-receipt --request <seal-request.json>` 的 exact request，再用 seal 回傳的 `ref` 跑 `verify-receipt`。builder 必須獨立重驗 durable raw bytes，不得信任capture成功；它再從 repository authority 導出 producer-owned authority、evidence 與 digests並重播 sealer 的 read-only preclaim，TL 不得手填或覆寫這些欄位。runtime 若回傳 exact ID，MAY 另記 optional `transport_invocation_id`，但 MUST NOT 作 auth／provenance／authority。成功必須同時取得 immutable `review-<change>-receipt-r<N>-<dispatch_id>.json` 與同 basename 的 receipt commit marker `.commit.json`，只有 marker readback 通過的 receipt 才是 terminal evidence。若 capture／build／receipt／marker／verify 任一步失敗，MUST 停下修復 authority，**不得**先依 mutable source修復finding或重派 reviewer（`predecessor-finding-omitted` 例外見上段）。當失敗碼為 `receipt-authority-changed`（stale HEAD／risk shape／logical dispatch／reviewed-surface authority）時，MUST 重跑 `classify-bounded` 取得新鮮 `dispatch_id` 並派 fresh reviewer，**MUST NOT** 重用舊 payload／dispatch。其餘 ordinary capture／build defect 不得在未修正 authority 前以 redispatch「修好」；唯一的legacy poisoned-carrier recovery是先修復capture authority defect、保留舊carrier，再以fresh dispatch／reviewer重建terminal evidence，不得重用舊fixed path。latest committed `partial`／`blocked` receipt 仍有 open findings 時，下一次 dispatch 前 MUST 為每個 exact finding ID + observation hash 建立 closure classification：`not-applicable` 須附 rationale；`cross-carrier` 須寫唯一語義不變量、bounded fixed literal variants，並依 `code-review-cross-carrier.md` 全文把 current-HEAD tracked text blob 每個 hit 逐列標成 `aligned`、`historical-rejected` 或 `quoted-in-evidence`。修復 commit 後以 `seal-cross-carrier-closure` seal，並由 `--pre-review` 在當前 HEAD replay；不得以 raw payload、自製 grep 摘要或 normalizer 替代。再按 full/bounded/handback 處理。

**Machine receipt command anchor**：前述 reviewer payload source 是 reviewer structured JSON value 的唯一 canonical carrier：`canonicalJsonV1(payload) + "\n"`，不是session transcript或任意JSON序列化。落盤後必須依序執行 `capture-reviewer-output` → `build-receipt-request` → `seal-receipt` → `verify-receipt`。`build-receipt-request` 的 stdout 就是下一步接受的 `<seal-request.json>`，不得人工映射；`seal-receipt` 產生 `notes/review-<change>-receipt-r<N>-<dispatch_id>.json` machine receipt。若任一步失敗，MUST 停下修復 receipt authority；mutable `.md` alone 無法滿足 `walkReceiptAuthorityChain`。

**manifest lineage**：`change_base_sha` 對齊 `merge-base(resolvedMain, HEAD)`（不是 moving main tip）；有 predecessor receipt 時 `surface_base_sha` MUST 等於該 receipt `lineage.head_sha`（seal-manifest 產端拒，helper：`resolvePredecessorReceiptForSurfaceEquality`）。**封存順序**：本輪所有修改 MUST 先 commit 完才可執行 `seal-manifest`；seal 後到派 dp-reviewer 之間 MUST NOT 再 commit（該 commit 會推進 HEAD，使同輪 manifest 失效且不可重封；`seal-manifest` 對未 commit 的工作區拒封，訊息含 `seal-manifest requires a committed worktree`）。

### Post-Ledger Final Evidence Gate

Archive transition equivalent時 **MUST NOT** 觸發second primary full六軸；invalid/non-equivalent=>`full_reopen_required`。`classify-final` 只驗證不封存：archive 後、`seal-final` 封存 archive transition 前，它對「Git 等價但尚未封存」的轉換同樣回 `full_reopen_required`（`review_lineage_valid:true`、`review_coverage_valid:false`），並附診斷欄位 `full_reopen_debug_reason: "archive_transition_unsealed"`——這是待做 `seal-final`，**MUST NOT** 據此重開六軸；該欄位為 `"latest_receipt_not_converged"`（附 `open_finding_ids`；guarantee assessment 有 `unresolved` 時另附 `unresolved_assessment_ids`）時是最新收據尚未收斂，處理見第三點六步段收斂檢查，同樣不是重開完整六軸的理由。沒有該欄位的 `full_reopen_required`（含 `seal-final` 回具體不等價錯誤之後）才是真正需要重審。順序固定為 archive→`seal-final`→`classify-final`，以 `seal-final` 的結果（封存成功，或具體的不等價錯誤）為準。After archive, existing `seal-final`解析`direct|archive_transition`並執行唯一`node .devpro/scripts/run-test-suite.mjs --changed main`；same-agent/transcript/manual非authority。consumer 判定下 `seal-final` 記 `not-applicable-consumer-profile`；PR Test Evidence 寫 N/A（consumer profile）並引用 `seal-final`／`verify-final` 輸出紀錄的 `result`，不得寫 passed。PR 開出後 cross-model 在 archive 後指出的 rule／code／test 載體修復不適用上述重審判定，見 `post-pr-warn-repair.md` §Post-archive 載體修復的證據對齊。

### Consumer Pre-PR Checks Gate

`lite` 與 `full` 都適用（source repo 跳過；`off` 由工程師自負）：必須在 Step 4 之前完成；起跑時點、可否與六軸併行與證據 currency 全依 `.devpro/agent-rules/consumer-pre-pr-checks.md` §Consumer Pre-PR Checks（`### Consumer Pre-PR Checks` 的 §時點 與 §結果綁 HEAD）處理 `.devpro/pre-pr-checks.local.md`——HEAD 含該檔時讀 HEAD 版本並照內容做，全部做完（或逐 PR 的使用者放行，作答後先寫 `consumer_waiver:`，見 `session-pending-lifecycle.md` §逐 PR 豁免紀錄）才進 Step 4；檔內要求不擴張授權（本機準備與建置測試照做，對外送資料、改無關檔、Ask First 項目、破壞性操作與部署先問）；HEAD 與工作目錄都沒有該檔時 no-op，工作目錄有而 HEAD 沒有時停下請使用者先 commit；停點、證據格式與 Gate 4c 的 PR create 格式檢查見該節；豁免段開 PR 時、改描述時與 merge 前對照作答時紀錄；執行、使用者是否真的作答與 HEAD currency（behavior-neutral delta 白名單見該節 §結果綁 HEAD）仍為 `cooperative-only`。

`## DEV deploy-verify` 段不在本關執行，也不算本關的完成條件，只由下一節 `### Pre-PR DEV Verification Gate` 讀取與部署，所以 DEV 為 `pending:` 不擋本關。

### Pre-PR DEV Verification Gate

`lite` 與 `full` 都適用（source repo 跳過；`off` 由工程師自負）：其他可執行的驗證（Step 1 測試、UI smoke、Consumer Pre-PR Checks Gate）做完之後、Step 4 之前，依 `.devpro/agent-rules/pre-pr-dev-verification.md` 處理 DEV 驗證；本關不依賴 `.devpro/pre-pr-checks.local.md` 是否存在，該檔的 `## DEV deploy-verify` 段只由本關讀取與部署。本關停點訊息依 `stop-point-comms.md`（為何停、編號選項、回了會怎樣）。

1. 讀記錄，先讀條目再讀 meeting-notes：本 change claimed 條目的 `dev_verification:` 是最新作答，沒有才讀 meeting-notes Startup evidence；並對照實際 diff 重做判定與入口查找。
2. 記錄存在、與 diff 判定一致、入口仍相同：`deploy-before-pr` → 部署當前 PR head build 到 DEV 並驗證，不再問；其他三值直接寫對應狀態，`waived:` 只記在 meeting-notes 時先複製進條目（沒有就新建）並讀回，才寫豁免行。
3. 沒有記錄、記錄與 diff 判定不符、入口與記錄不同：只有這三種才在 PR 前補問，選項同第零步。
4. 失敗依原因分流，不依發現時點。環境類（缺環境、設定或同意範圍外的動作，DEV 主機不可達，部署管道本身壞掉）→ 停下，選項：補好後重試／本 PR 豁免（`skipped per user decision: <原因>`）／先開 PR 記 `pending: <缺什麼>`／其他。
5. 產品類（本 PR 程式讓 build 起不來或部署無法完成，或核心路徑失敗、修正點仍在）→ 停下回報部署了什麼與結果、不開 PR；MUST NOT 自行記成 `N/A:`、`pending:` 或 `skipped per user decision:`，MUST NOT 重跑沒有改動的步驟求綠；只能修正後重跑，或由使用者逐 PR 豁免（`skipped per user decision: <原因>`，觀察到的失敗原文留在豁免說明旁；選項：修正後重跑／本 PR 豁免／其他）。原因分不出來比照本項。
6. 使用者每次作答（補問或停點）後，先寫紀錄並讀回（`session-pending-lifecycle.md` §逐 PR 豁免紀錄；沒有 claimed 條目就新建，不論是否豁免）；寫不進去就停下，MUST NOT 寫豁免行。再寫 `## Test Evidence` 的 `DEV deploy-verify: HEAD <full-sha>; <狀態>` 行（四種狀態見該檔）；`pending:` 不得標 PASS 或 ready。同一輪對同一 HEAD 不部署兩次，補好環境後可在原同意範圍內重試並更新證據行；豁免段開 PR 時、改描述時與 merge 前對照作答時紀錄（見 `per-pr-waiver-record-residual`（`design-core.md` §11）），強度與 `cooperative-only` 範圍見該檔 §強度。

### Step 4: PR Description

- **建 PR 前先判定 milestone 三態**（僅 head 前綴 `feature/`／`bugfix/`／`chore/` 且 base `main` 時適用；SSOT：`release-sit-uat-pat-prod.md` §Subset selection handoff）：

  ```bash
  gh pr list --head "$(git branch --show-current)" --base main --state all --limit 100 --json state,milestone,isCrossRepository
  # 筆數 < 100 才接受，否則放大 --limit 重跑；任一 isCrossRepository=true → 停下交 TL（同 `release-milestone-assignment.md` 分支改齊指令）
  # 取 MERGED＋OPEN 的 milestone 集合，單一值且無 null:
  gh pr create --milestone "<該值>" ...
  ```

  - 單一值且無 null → 依上例 `gh pr create --milestone "<該值>"` 沿用。
  - 無其他 PR 或全部 null → 不帶 `--milestone`、不詢問；使用者已明示目標梯次時才帶（已有其他 PR 時，建 PR 後以 `release-milestone-assignment.md` 分支改齊指令一次掛整條分支，避免只掛新 PR 造成 `conflict`）。
  - 混合或多值（`conflict`）→ **PR 建立前停下**，請使用者先以 `release-milestone-assignment.md` 分支改齊指令改齊並回讀一致後再建 PR。
  - `Release Target` 欄位維持 warn-only，不因本條升級。
- 依 `.devpro/agent-rules/git-pr-template-and-merge.md` 的 **PR 描述模板**產出 PR 描述草稿；必含 `OpenSpec` / `Change Context` / `Manual Test` / `Requirement Ledger Completion` / `Test Evidence` / `Scenario Walkthrough` / `Cost Circuit Breaker Overrides` / `Security Review` / `Conditional Fields`，且 `Requirement Ledger Completion` 段必列 disposition counts（無 ledger 寫 `N/A: <reason>`），`Test Evidence` 段**必含** `驗收證據` 3-5 條 checklist（每條對應 proposal / proposal-mini 的 Target State 一項；需求驅動（full／lite）且無 proposal 時對應卡的「做成後你會看到」；附具體證據），`Cost Circuit Breaker Overrides` 段本 change 週期內 checkpoint `overrides[]`（`notes/tmp/state/devpro-change-usage/<change>.json`）為空時填 `N/A` 或 `N/A: <reason>`、非空時逐行列出（D11 §S-1）。**禁止**改用 Claude Code 預設 `## Summary` + `## Test plan` 模板或直接搬 proposal 的 `Touch List` / `Don't Touch` 段。`Change Context` 會成為第二意見 `scope_summary`（≤4096 UTF-8 bytes、單行），Target State 條目成為 `done_when`（≤32 條、每條 ≤1024 bytes）；超過時 `build-pr-sticky-handoff.mjs` 以 `handoff_limit_exceeded` 拒絕，先縮短再跑。
- Body lint：草稿產出後、push 前，跑 `node .devpro/scripts/pre-pr-body-template-check.mjs --body-file <path>`（exit != 0 → 依 stderr 修正後重跑：缺段、證據段超長、未填範本字樣）；push 前跑時看 stdout 是否為 `evidence-section checks: checked`，第一次 PR（本機沒有 `origin/<branch>`，且 origin 回答沒有同名分支）時檢查會向 origin 問一次（`git ls-remote`，有逾時）並以本地 HEAD 判定，仍是 `checked`；若為 skipped（origin 已有同名分支但本機沒有或與 HEAD 不同的 `origin/<branch>`、連不上 origin、或沒有 `origin`）則 push 後重跑，或交給 `gh pr create` 的 hook 檢查
- **餵 body 給 `gh pr create` / `gh api` 前必讀 `file-write-destinations.md` §body file two-step 紀律**：body file 必須先由**獨立** Bash 呼叫寫檔落地，再由**第二個** Bash 呼叫跑 `gh`（`--body-file <literal-abs-path>`）；同一 compound command 內 `cat > $BODY && gh …` 會讓 footer-gate PreToolUse 讀不到尚未存在的檔而 fail-closed。path 用字面絕對路徑，禁 `$(pwd)` / `$VAR` / backtick（未展開字面會被當錯路徑擋）。細則以 `file-write-destinations.md` 為 SSOT，本處不重述。
- 附上 Review Summary
- proposal 帶 `issue: #N` 時，PR 描述 MUST 帶對應行（完整交付＝裸 `Fixes #N`／`Closes #N`；部分或延期＝`Related to #N`；SSOT：`git-pr-template-and-merge.md` §PR 描述加 Fixes / Closes），否則 merge 後 issue 不會自動關閉
- **`hotfix/` 分支**：產出**單份** hotfix PR 描述草稿（base＝release carrier、`Release Target: N/A（hotfix lane）`），含條件式欄位（影響範圍、rollback 計畫）；carrier 的 production PR 與 back-merge PR 依 `release-hotfix-carrier-lane.md` §Hotfix release-carrier lane，**禁** `hotfix/*` 以 `--base production` 開 PR（SSOT `release-hotfix-carrier-policy.md`）
- **已上 PROD 緊急修復**：將修復重新切為 `hotfix/`，依 `release-hotfix-carrier-policy.md`建立單份 hotfix PR 描述草稿，再由 release carrier 建立 production PR 並依 runbook back-merge。
- **一般 `bugfix/` 分支**：PR base 維持 `main`，依核准 subset 選擇規則建立單份 PR 描述草稿（SSOT：`release-sit-uat-pat-prod.md` §Subset selection handoff）

### Step 5: Post-PR Workflow Watch

`gh pr create` 成功 **≠** 流程結束。TL 在同一輪 turn 必須完成下列收尾，**禁止**只回「PR 已建立」就停手：

> Host-neutral checklist：`.devpro/agent-rules/post-pr-completion-gate.md`。本 skill 是 Claude Code adapter 的具體執行路徑；非 Claude host 不會自動執行本檔。

1. **Workflow watch**（強制）：
   - **前置偵測**（先於 `gh pr checks`）：先驗 PR 所在 repo 的 `.github/workflows/` 目錄是否存在（從 hub 追別的 repo 時驗那個 repo 的，不驗目前 checkout）——不存在（或無任何 `*.yml`/`*.yaml`）→ `gh pr checks` 空即**確定終態**、直接判 N/A、**不**進 watch sleep-retry loop。細節與 workflow-存在時的 trigger-schema 分類見 `git-workflow-tracking.md` No-trigger 判定 SOP（SSOT，不在此重寫）。
   - `gh pr checks <PR#> --repo github.com/OWNER/REPO`（或 PR URL）列 PR checks。合併後的提醒依 `git-workflow-tracking.md` §合併後 Workflow 查詢清除。
   - `gh run list --branch <branch> -R github.com/OWNER/REPO --limit 5` 補抓 `workflow_run`（push 不留 post-merge 標記，push 後自行追到終態）
   - 等待每個 run 終態（`success` / `failure` / `cancelled`）；長 workflow 用 `gh run watch <run-id> -R github.com/OWNER/REPO` 或合理間隔重查
   - **失敗處理**：可直接修的就修復重 push；否則回報失敗並詢問是否深查
2. **Next-step surface**：依 `git-workflow-tracking.md`「Post-PR handoff」段 4 項清單（等什麼 / 誰擁有下一動作 / 下一個 AI-actionable step / TL 平行可做）。

**例外**：使用者已明確說「不用看 Actions，我自己會看」——記住但 PR merge 後仍可主動提示。

> 主規則在 `git-workflow-tracking.md`「PR 建立 / Merge / Push 後追蹤 workflow」+「Post-PR handoff」段；本步驟引用、不重寫。

> **不要自動 remove worktree**：merge 後 worktree 仍保留（per `git-branch-hygiene.md` — 時機與 branch deletion 一致，Release Step 6 PROD tag 後同 batch 清，唯一入口 `prune-merged-local.mjs`）；不要在本步驟之外 auto-remove worktree。local branch deletion / worktree removal 沒有 git-native hook backstop；需靠 named consent 與 production 後 `prune-merged-local.mjs` 流程控管。

### Step 5.5: Post-PR Cross-Model Review

**位置**：與 Step 5（workflow watch）**並行**啟動（SSOT：`post-pr-completion-gate.md` §Step 5 ∥ Step 5.5 Parallelism）；merge 之前。MUST NOT 以 CI／workflow 終態作為 sticky 前置。`pre-tool-gate.mjs` `checkCrossModelMergeGate` 在 merge 階段以 fail-closed enforcement 兜底。

本步是 `post-pr-completion-gate.md` 的 cross-model status 具體 executor；PostToolUse hook 只允許 pending reminder，不自動呼叫 reviewer，避免與本 Step 5.5 double-run。

**Head movement precheck**：dispatch 前 TL MUST 確認 final base/mergeability sync 已完成，且沒有計畫中的 `git rebase`、force-push、patch replay、merge/graph recovery 或其他 non-fast-forward head rewrite。若 PR 仍 dirty / stale / needs-rebase / needs mergeability repair，先依 `git-branch-and-pr-flow.md` 的 Ask First 邊界 settle；不得先 dispatch 再改 head。dispatch-bound sticky/marker 已存在後，head rewrite 使舊 sticky 對 readiness stale；exact per-lineage approval 只可在符合 `post-pr-completion-gate.md` contract 時恢復 active marker／clear-obligation binding，不授權 Git rewrite，也不能替代 current-head dispatch/sticky。其他 lineage-broken 狀態 fail closed。修復／新 commit 後順序 MUST 為 `commit → push → suite/receipt → render/dispatch`：修正 commit 未 push 前不得 render／dispatch（runner pre-spawn live-head 比對會先擋下且零 spawn）。

#### Step 5.5.1: 豁免判定（Default-on；豁免才跳過）

讀取 `code-review-cross-model.md`「豁免條件（SSOT）」段；hook 端調用 `pre-tool-gate.mjs::isCrossModelExempt(prHeadRefName, changedFiles, cwd, statuses, headSha, baseRefName)`（`changedFiles` 與 `statuses` 取自同一份完整清單，經 `toExemptionInput` 產生；省略 `statuses` 時每個 proposal 路徑都算證據；`headSha` 為 PR head commit、`baseRefName` 為 PR base 分支名，任一省略時零差異 ancestry repair 不豁免）：

- **命中 branch-pattern 豁免**（`chore/bump-v*`、`rules/<whitelisted-source>-v*`、`release/v*`、`release/<date>-<sha>`、`release/rules-<date>[-n]`）→ 跳過 Step 5.5（merge gate 走路徑 A 變體 pass）
- **命中 diff-shape 豁免**（`chore/*` 前綴車道 — diff 無本 change 的 `openspec/changes/<name>/proposal*.md`，判定以 `code-review-cross-model.md` §Diff-shape exemption 為準；**hotfix 除外**）→ 跳過 Step 5.5（merge gate 走路徑 A 變體 pass）；`feature/*` / `bugfix/*` 無 proposal 代表缺 OpenSpec evidence，不能套此豁免
- **命中零差異 ancestry repair 豁免**（`bugfix/fix-production-ancestry-*`、base 是 `main` 或 `release/rules-*` carrier、三點 diff 確定為空、head 是 merge 確切 `production-*` tag 的 merge commit；需帶 PR head SHA 與 base 呼叫，判定以 `code-review-cross-model.md` §Zero-diff ancestry repair exemption 為準）→ 跳過 Step 5.5（merge gate 走路徑 A 變體 pass）
- **都不豁免** → 進入 Step 5.5.2（default-on：預設需要 cross-model review）

skip/exempt 只代表 cross-model gate progress，不是 terminal response。任何 Step 5.5.1 豁免/skip path 在回報前仍 MUST 套用 `post-pr-completion-gate.md` Ready Response Next-Step Contract，包含 `CurrentIntent`、`NextAction`、`AskFirstPending`、owner、next step、success condition；若下一步是 merge Ask First 或 user-owned decision，結尾 MUST 給 numbered options。

> `hotfix/<name>` 永不豁免，即使 diff 無 proposal（PROD 修復高風險；hotfix override 必勝 chore/ 前綴車道豁免）。

#### Step 5.5.2: Dispatch（同 repo 直接派送，不逐次詢問）

dispatch devpro:second-review（或任何外部 CLI reviewer）前，TL 不問使用者、不跳 host 權限窗、不跑授權指令。cross-model dispatch 由外部模型服務（different-family reviewer；接收方 CLI 依當前 host 之 `primary_family` 由 `platform-adapters/<host>.md` 反推，非固定某家）審查該 same-repo PR，reviewer 寫回 sticky；handoff 欄位見 `code-review-cross-model.md` §Initial handoff builder：

- **same-repo PR（含手動指定 PR 號）**：直接進 Step 5.5.3。handoff 固定 `approval_context: "none"` 與 `approval_resolution: {"status":"not-required"}`。
- **仍停下**：cross-repo PR（builder `pr_repository_mismatch`）、merge、release、destructive、secrets、cross-repo write 仍 Ask First；consumer 規則文字命中 PII／secret 樣式（builder `pii-or-secret-pattern`）、external-evaluator 路徑的審查資料命中（renderer `external_ticket_unsafe_value`）不派送；預設 runner 路徑的審查資料沒有後一道掃描。
- **local rule**：consumer 在 `AGENTS.local.md` 自加的停點是一般 local rule，TL 照一般規則處理，不是 devpro 定義的逐 PR 詢問。
- **邊界**：execution-surface（approved prefix／host runner／`--allowedTools`／host outside）只是執行面證據，與 cross-repo 停點分開。

進入 Step 5.5.3。

#### Step 5.5.3: Host-aware Subagent Dispatch

完整 `Agent({...})` dispatch prompt（逐字）給 `devpro:second-review`，含如何取得 `head_ref_oid`、diff > 5000 行的 trim 規則，見 `references/subagent-dispatch-blocks.md`。這是 projection-first route：跑 renderer 前 MUST 讀 active host adapter 的 **TL renderer Shell**（Cursor → `platform-adapters/cursor.md`）。TL MUST 先跑 `.devpro/scripts/render-second-review-packet.mjs` 再跑 validator，讀出 sidecar 後才可 dispatch；缺 sidecar 或欄位不符路徑，MUST 在 dispatch 前 fail closed 回報 `projection_observability_contract_missing`，不是等 timeout 或 checkpoint 才判定。

#### Step 5.5.4: 收 subagent 回報

devpro:second-review 回傳精簡 JSON（含 `status` / `verdict` / `sticky_comment_url`）：

| `status` | `verdict` | 處理 |
|---|---|---|
| `finished` | `PASS` 或 `WARN` | 繼續流程；若 sticky 標 `same-family fallback`，TL 回報 reason/provenance |
| `finished` | `CRITICAL` | 停下；回報使用者修 critical 後跑 `/devpro:cross-review <PR#>` 重審；merge 將被 `checkCrossModelMergeGate` 路徑 E block |
| `partial` | `WARN` | 回報使用者評估是否先修 |
| `blocked` | `UNAVAILABLE` | sticky 已寫（per D9）；TL 在 PR ping 人類 reviewer 接手（per FR-7），不得宣告 ready |

**External evaluator 替代路徑**：`UNAVAILABLE`（target family 無 runner recipe、CLI 不可由 runner 呼叫）或大 PR 改選 live review 時，除了 ping 人類，TL 可改發行 External Evaluator 審查單：`render-second-review-packet.mjs`（`executor_kind: "external-evaluator"`）→ 另一 family 獨立 session live 讀 PR 並自寫 sticky → TL 跑 `accept-external-second-review.mjs <packet-dir>` 驗收；不需要／不可用時以 `--void-external-dispatch <packet-dir>` 作廢。完整契約見 `second-review-external-evaluator.md`（審查單＋收據）；驗收後回到 Step 5.5.5 做 current-head 一致性重驗。

#### Step 5.5.5: TL 收尾

回報使用者前，TL 必須以 `gh pr view <PR#> --json comments,headRefOid` 重新驗證 sticky comment 存在、`verdict:` 可解析、`last_reviewed_sha` 等於 `headRefOid`（或 Path D′ fresh-equivalent：兩者差異僅 `openspec/changes/**`／`notes/**` bookkeeping diff（路徑不含 `specs` segment），SSOT `code-review-cross-model.md`）。只有 `PASS` / `WARN` 可宣告 PR flow ready；`CRITICAL` / `UNAVAILABLE` 只能回報 blocked 與 `/devpro:cross-review <PR#>` 重審路徑或人類 reviewer handoff。缺失、解析失敗、或 stale sha → 先重跑 Step 5.5 或 `/devpro:cross-review <PR#>`，不得宣告完成。

`PASS/WARN`、`PASS|WARN`、skip/exempt 後 MUST NOT stop at verdict/skipped/exempt。回報使用者必須呼叫 `post-pr-completion-gate.md` Ready Response Next-Step Contract：`Status:` ready / ready-with-warning、`Owner:`、`Next step:`、`Success condition:`、`CurrentIntent`、`NextAction`、`AskFirstPending`。若 merge 或下一步 user-owned，結尾 MUST 給 stop-point numbered options；若 owner=TL 且 batch approval / existing authorization 已覆蓋，TL MUST continue rather than ask again。

當 `Status: ready-with-warning` 時，stop-point numbered options MUST 另外套用 `WARN Decision Contract（預設 fix-to-PASS）`：選項 1 為「先修到 PASS（預設）並重跑 `/devpro:cross-review <PR#>`」。

回報使用者：`sticky_comment_url` + `verdict` + `last_reviewed_sha` + fallback reason/provenance（若有）+ Ready Response next-step。**不** emit transcript marker（sticky 即 audit trail）。

## Test Scenarios

迴歸觀測矩陣（改本 skill 時的對照表）移到 `references/regression-scenarios.md`。
