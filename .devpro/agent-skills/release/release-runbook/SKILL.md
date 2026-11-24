---
name: release-runbook
description: "Release/promote 七步驟 runbook（optional DEV confidence gate → subset release → Build once → SIT terminal / UAT/PAT/PROD → existing release promotion → hotfix recovery），以及 post-PR workflow tracking 與 post-merge local sync。使用時機：使用者說 release/promote/上線/發佈、bump PR 合併後需要進行 step 2-7、或剛執行完 gh pr create/merge/push 到 workflow-bound branch 時。"
metadata:
  user-invocable: true
---

# Devpro Release Runbook

## Overview

本 skill 是 Devpro release/promote workflow 的 routing 與 operational-recipe 載體：branch-role model（`main` → optional `integration`/DEV confidence gate → `release/*` → production PR）、SemVer/bump 規則、release intent、step 1-7 執行 recipe、hotfix recovery，以及每次 push 之後的 post-PR/post-merge tracking 義務。**Policy SSOT 留在 rule leaves——本 skill 不重複它。** Branch roles、deployment iron rules、anchor rules、bump rules、release intent、freeze-break criteria 與 hotfix vs bugfix 的區分定義在 `release-sit-uat-pat-prod.md`；具體 step-by-step 指令定義在 `release-step-1-7.md`；post-push/merge 的 workflow-tracking 與 TL handoff 義務定義在 `git-workflow-tracking.md`。本 skill 排序該載入並執行哪些檔案、依什麼順序——不重新定義它們的任何規則。

## When to Use

- 使用者說「release / promote / 上線 / 發佈穩定版」
- 某個 `chore/bump-v<X.Y.Z>` PR 剛合併，需要立即進行 step 2-7
- 使用者要 release to SIT、new production promotion，或從 existing `release/*` artifact promote production
- release 負責人/TL 要求 optional DEV full-validation confidence round
- 有個 hotfix 需要進入 production PR recovery path
- `git push` 到 workflow-bound branch、`gh pr create` 或 `gh pr merge` 剛完成，workflow tracking / TL handoff 已到期
- **不觸發**：一般開發、合併前的 feature PR、例行的 `merge main` 操作

## Process

### 1. 先載入 policy SSOT

在做任何事之前，先載入並執行 `release-sit-uat-pat-prod.md`（branch roles、deployment iron rules、anchor determination、SemVer/bump 規則、freeze-break criteria、hotfix vs bugfix table）。不要憑記憶 improvise anchor 邏輯或 bump timing。

### 2. 判斷 anchor 與 phase

```bash
node .devpro/scripts/detect-branch-base.mjs --anchor
git tag -l 'production-*' | sort | tail -5
git branch --list 'release/*'
```

依 `release-sit-uat-pat-prod.md` §Release intent / entry path 與 §Anchor 判斷規則 判斷 release intent（`release-to-sit` / `release-to-production-new` / `release-to-production-existing` / hotfix）、promotable-unit anchor 優先順序，以及其 hotfix-anchor 規則（hotfix 一律以最新 `production-*` tag 為 anchor——絕不 fallback 到 `release/*` 或 `main`）。

### 3. 執行 step-by-step recipe

載入 `release-step-1-7.md` 取得具體指令序列：Step 1 判斷 release intent、做 Subset selection handoff，並視使用者/TL 要求執行 optional DEV confidence gate；Source SemVer Release Requires Explicit Subset Selection，因此 `release/v<X.Y.Z>` 只是 naming lane，有限 subset 必須依 Step 1／Step 2 核准的分支清單逐一 merge 剛驗證的 `origin/<branch>`，只有 approved subset = `full-main` 並記錄 selected `main` HEAD SHA 時才可選 whole-main；Step 2 建立新 `release/*`（含 committed-diff-whitespace pre-check 與 merge-conflict-resolution routing table）；Step 3 Build once；Step 4 在同一個 artifact 上做 SIT/UAT/PAT，且 `release-to-sit` 可在 SIT terminal outcome 停下；Step 5 UAT/PAT 期間的 bugfix 合併；Step 6 PROD promotion（new assembly 或 existing release promotion，production PR + exact-merge tag-only push）；Step 6A tag 之後把 `production` 合回 `main`（`--require-main-ancestor` gate exit 0 才算完成，見下方 §3B）；Step 7 PROD issue 修復（bugfix vs hotfix recovery）。Step 1 以無日期、完整查詢依分支分組，再以已上線判定（`unit_released`）產生候選；milestone 只用於四態標籤，不當查詢條件，契約 SSOT 在 `release-step-1-7.md` Step 1 與 `release-sit-uat-pat-prod.md` §Subset selection handoff。不要跳過步驟，也不要在單一步驟後就宣告 release「完成」——除非使用者明確要求停止，否則推進到該輪的終點（一般 promotion 的終點是 Step 6A 的 gate exit 0，不是 tag-only push）。

### Parallel existing-SIT update routing

遇既有後輪 SIT artifact、前輪後來完成的 ordinary parallel 情境，MUST 先讀 `release-sit-uat-pat-prod.md` §Parallel Release Rounds Superset Ordering 的單一 in-scope ordinary parallel handling／finalized baseline／operation authority 定義，再執行 `release-step-1-7.md` Step 2 parallel 判定；original early-SIT assembly 同樣在 scope。符號依 `release-sit-uat-pat-prod.md` §Parallel release evidence symbols；既有 artifact path 不跳過判定，不憑記憶新創 conditional production-tag update／latest-tag reassembly recipe。

先由 `release-verification-commands.md` 查 finalized candidate 與內容／功能 closure，再依 step leaf 選 conditional production-tag update、latest-tag reassembly 或 missing-evidence stop；HEAD/tree 改動回 Build once/full validation，QA 使用 `testing-and-qa.md` §Parallel release QA evidence 決定 rerun/rebind 與具名 scope approval。續 UAT/PAT 前及 production merge、tag、deploy／source effect 前 MUST 執行 verification leaf 的 freshness／candidate tree／pre-effect control／own-M／N-drift 核對；缺可驗 existing control 停下交 owner，latest-tag reassembly 不補 race。excluded lanes 沿原流程，hotfix re-open 優先。下面 tag recipe 與 Step 6A ancestry 不替代這些 scope 內前置證據。

### 3A. Production PR exact-merge tag contract

所有 applicable ordinary/source SemVer/consumer date/rules/hotfix/rollback promotion 都必須 push work/release branch → PR base `production` → GitHub merge → resolve exact merged production commit → freshly fetch `origin/production` 並驗 reachability → tag the explicit commit → push only the tag ref。hotfix、其 version bump 與 rollback 單元進 `production` 的 PR head 恆為 release carrier；`hotfix/*` work branch 只以 PR 進 carrier，不得當 base `production` 的 PR head。不得 local merge/direct-push protected production、以 current checkout `HEAD` 代替 PR result、pre-merge tag，或 combined protected-ref/tag push。production target 不存在時回報 `production target absent`，由 external repository administration 建立 protected, pull-request-capable base；runbook 不得 bootstrap 或 direct-push 該 branch。

### 3B. Universal tagged promotion ancestry completion

rules / ordinary promotion 的 all tagged promotion shapes 完成後，分別載入 `release-rules-lane.md` / `release-step-1-7.md` Step 6A（指令見 `release-back-merge-completion.md`）：先以 exact promoted tag 與 freshly fetched candidate main SHA 跑 `--require-main-ancestor` gate；exit 0 / 已為 ancestor 即 no-op complete。只有 gate 非 0 時，才可跑 `--reconciliation-status` 作為 divergence classifier；若 status 回傳 `isMainAncestor:true`、`classification=main-ancestor-confirmed` 或 `recommendedRoute=no-op`，MUST 視為 no-op complete，MUST NOT 宣告 `graph-only` 或 repair。禁 squash/rebase/`-s ours`/patch-equivalence。ordinary promotion 包含 finite subset、`full-main`、non-subset、new/existing；此 completion topology 不改 assembly selection。

`graph-only` 只在 conflict-free 且 resulting merge tree 等於 candidate main tree 成立，仍須 merge parent + zero tree delta → `recommendedRoute=release-lane-back-merge`：當輪 release branch `git merge --ff-only` exact tag，push 後開 PR 回 `main` 以 regular/no-ff merge。ff-only 失敗、branch 已 prune、事後發現缺口或 `content-review-required` / `recommendedRoute=production-ancestry-repair`（走一般內容 review/tests）→ 轉 `git-branch-production-ancestry-repair.md`。reconciliation PR merge 後 re-fetch `origin/main`，重新取得 candidate main SHA 並執行 portable server required check：

```bash
node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"
```

Exact refs 無法唯一解析或 command 非 exit 0 均 fail closed，不得宣告 complete。本 change MUST NOT 安裝 GitHub Actions workflow、repository ruleset 或 branch protection；server-side installation 須另開具名 CI change 取得授權。

### 4. Bump timing 檢查

在開啟 `release/*` 之前，依 `release-sit-uat-pat-prod.md` §SemVer 與 Bump 規則 確認版本 bump PR（`chore/bump-v<X.Y.Z>`）已經合併——bump 絕不可嵌入 feature/bugfix/hotfix PR 中，且完整 project tests 只在 release branch 組裝完成後才跑，不在 bump branch 本身跑。

### 5. Post-PR / post-push workflow tracking（每次 push/merge）

在 `gh pr create`、`gh pr merge` 或任何對 workflow-bound branch 的 `git push` 之後，載入並執行 `git-workflow-tracking.md`：

- 從 `.github/workflows/*.yml` 的 `on:` 條件枚舉每個直接與間接（`workflow_run`）觸發的 GitHub Actions workflow
- 輪詢每個到終態（`success`/`failure`/`cancelled`）——絕不要叫使用者「自己去看 Actions」
- bump PR merge 後仍先依 `git-workflow-tracking.md` 做 workflow tracking + Step 5.5 exemption check；`chore/bump-v<X.Y.Z>` 命中 branch-pattern exemption 時，不得 dispatch second reviewer / 不要求 cross-model review，記錄 exemption evidence 後接續 Release Step 2-7
- 在 PR create/merge 時，以條列（不是表格）給出 4 項 TL handoff（waiting-on / 誰擁有下一步動作 / 下一步 AI 可執行動作 / TL 平行工作）
- 合併後，針對合併目標（`main` / `production`（含 hotfix carrier）/ hotfix carrier back-merge → `main`；對應 `git-workflow-tracking.md` post-merge sync 表列）執行 Post-merge Local Sync 序列，避免本機 refs 過時

### 6. Hotfix recovery

若這是 hotfix，使用 `release-hotfix-carrier-policy.md`+ `release-hotfix-carrier-lane.md` §Hotfix release-carrier lane（source／consumer 同構）：只從最新 `production-*` tag cut carrier（`[-<n>]` 命名豁免見 `code-review-cross-model.md` §豁免條件（SSOT）Branch-pattern exemptions：`release/<YYYYMMDD>-<shortSHA>[-<n>]`）；bump-first（若適用）→ 序列化 hotfix PR merge 進 carrier（`hotfix-carrier-verify.mjs pre-merge`／`merge-proof`）→ freshness → freeze → build once → smoke → `hotfix-carrier-provenance` block → production PR（head＝carrier）→ GitHub merge → resolve exact production PR merge commit、freshly fetch `origin/production` 並驗該 commit 可解析且為其祖先（不成立即停、不打 tag）、tag the explicit commit 並 push only the tag ref → `hotfix-carrier-verify.mjs post-promote` → carrier `--ff-only` 到 tag → 開並 merge 唯一的 back-merge PR 回 `main` → 再跑一次 `post-promote --back-merge-pr` 確認 Step 6A 完成。Cutover 前已合入 `production` 的舊 PR #1（grandfathered legacy hotfix）改走 `release-hotfix-carrier-lane.md` §Grandfathered legacy hotfix completion：同一 branch ff-only forward 到 exact promoted tag，以 regular/no-ff PR #2 合回 `main`，並在宣告完成前 re-fetch `origin/main`、通過 exact-tag gate。

## Common Pitfalls

- 宣告某個 release 步驟「完成」就停下，而不是推進到該輪的終點
- 在 feature/bugfix/hotfix PR 裡 bump 版本，而不是用獨立的 `chore/bump-v<X.Y.Z>` PR
- 把 optional DEV confidence gate 當成 mandatory release gate，或漏記 `confidence-gate skip`
- 把 `integration` HEAD 部署到 SIT/UAT/PAT/PROD，而不是 `release/*` 的 Build-once artifact
- 從 existing `release/*` promotion 時重挑 subset 或 rebuild，卻沒有 release branch change / provenance unverifiable 的理由
- 把 source repo `release/v<X.Y.Z>` 解讀成整個 `main`，而沒有先提供 candidate subset list、核准分支清單，或 explicit full-main approval
- 直接在 release branch 上解決 `release/*` merge conflict，而不是 route 回 feature branch（破壞「release ⊆ main」不變量）
- 跳過 post-merge local sync，讓本機 `main`/`production` 在下次 anchor calculation 時過時
- 叫使用者自己去檢查 GitHub Actions，而不是輪詢到終態

## Verification

```bash
git tag -l 'production-*' | sort | tail -5
git log production --oneline -5
gh pr view <bump-pr-number> --json state,mergedAt

# finite subset primary check: structured approved-subset evidence
# - candidate subset list
# - approved branch list（merge 剛驗證的 origin/<branch>；見 release-step-1-7.md Step 2）
git merge-base --is-ancestor <approved-sha> main
git branch --contains <approved-sha> release/<YYYYMMDD>-<shortSHA>

# full-main only:
# approved subset = full-main
# selected main HEAD SHA = <selected-main-sha>
git diff --stat <selected-main-sha> release/<YYYYMMDD>-<shortSHA>

# <branch> 寫字面值（先用 git branch --show-current 取得）；push 不留 post-merge 提醒，push 後自行追到終態
gh run list --branch <branch> -R github.com/OWNER/REPO --limit 5
node .devpro/scripts/lint-agent-skills.mjs
```
