---
name: rules-flow-rollback
description: consumer rules lane 上線後的回滾流程（Rollback SOP：觸發條件、5 個頂層步驟、broken carrier lane 不得旁路）。觸發：rules lane 上線後 hook／CI／衍生檔破壞，或 release 含預期外 commits 時，由 `rules-flow.md` 的 Rollback SOP 路由段載入；一般 rules sync 不載本檔。
---

# Consumer Rules Lane Rollback

> Load-chain：本檔由 `rules-flow.md` 的 Rollback SOP 路由段按需載入；一般 rules sync 不需讀本檔。回滾觸發條件、5 個頂層步驟與 broken carrier lane 不得旁路的權威內容在本檔。

## Rollback SOP

**觸發條件**（任一成立即走本 SOP；`MERGE_SHA` 的解析與驗證見步驟 (1)）：
- consumer rules lane 上線後 hook／CI／衍生檔破壞（人為判定）
- release 含預期外 commits：`git log <prev production tag>..<release tag> --oneline` 列出 rules sync pattern 以外的 commit

consumer rules-lane rollback（`hotfix/revert-rules-<date>[-n]`）**MUST NOT** 直合 `production`；一律經 `release/rules-<YYYYMMDD>[-n]` carrier，與一般 hotfix carrier 同構（見 `release-hotfix-carrier-policy.md`）。5 個頂層步驟：

(1) **判定 trigger、解析並驗證 exact `MERGE_SHA`**：trigger＝consumer rules lane 上線後 hook/CI/衍生檔破壞，或 `git log <prev production tag>..<release tag> --oneline` 超出 sync pattern。intended release 的 exact `MERGE_SHA` MUST 從 recorded production PR 或 production tag 解析並驗證——例如 `MERGE_SHA=$(git rev-parse "<intended production-*-rules* tag>^{commit}")`，或 `gh pr view <recorded-production-pr> --json state,baseRefName,headRefName,mergeCommit` 取得 `mergeCommit.oid` 並驗 `state=MERGED`、`baseRefName=production`、head 對齊該次 `release/rules-*`；再 `git fetch` freshly `origin/production`，驗 `MERGE_SHA` 可解析、為可 `git revert -m 1` 的 merge commit，且是 `origin/production` first-parent ancestor。**禁**只靠 merge-subject grep（例如舊 `Merge release/rules-` subject pattern；GitHub PR merge subject 不一定符合，可能選錯或選不到）。

(2) **cut carrier、自 `ANCHOR_TAG` 建 revert 分支，兩條合法路徑**：`ANCHOR_TAG`＝最新 `production-*` tag；自它 cut `release/rules-<YYYYMMDD>[-n]` carrier；另自同一 `ANCHOR_TAG` 建 `hotfix/revert-rules-<date>[-n]` 分支，在該分支上 `git revert -m 1 <MERGE_SHA>` 產生 revert unit（provenance `unit:` 記 `reverts=<MERGE_SHA>`）。(a) revert **clean 且恰一個 commit**（直疊 anchor）→ 可主張 `bump: N/A`，`pre-promote` 對此 unit 跑 revert 形狀驗證；(b) revert **有衝突需手工解**→ **不得**主張 `bump: N/A`，改走 bump（provenance 記 `bump: pr=…`），`pre-promote` 改驗 bump provenance、不跑 revert 形狀驗證，其餘 unit 的 GitHub／拓撲／內容完整性照常。

(3) **revert PR base＝carrier，sticky merge**：開 `hotfix/revert-rules-<date>[-n]` 作為 pull request，其 base 是該 carrier（`release/rules-<YYYYMMDD>[-n]`），絕不是 `production`；review 時留 `hotfix-review-binding` 留言，`pre-merge --pr` 再驗、`gh pr merge --merge --match-head-commit <approved-tip>`、`merge-proof --kind hotfix --pr` 驗 merge 結果。

(4) **freshness → freeze → smoke（可縮不可省）→ production PR → tag**：`hotfix-carrier-verify.mjs freshness` 通過後 freeze（記 `CARRIER_SHA`）、build once（rules lane 交付物即 `git-tree:<CARRIER_SHA^{tree}>`）、smoke；持久化 `hotfix-carrier-provenance` block（`lane: consumer-rules`）；production PR 的 head 是 carrier、base `production`；GitHub merge 後 resolve exact production PR merge commit、freshly fetch `origin/production` 並驗該 commit 可解析且為其祖先（不成立即停、不打 tag），再 tag `production-<date>-rules[-n]`（V2）、push only the tag ref；`post-promote` 驗證。Message body 含 `Reverts <merge-sha> from consumer rules lane release.`、`Reason: <具體原因>`、`Action: 開新 rules/agent-rules-v<X.Y.Z> 重做`。

(5) **carrier ff＋back-merge 回 main，重做**：carrier `git merge --ff-only` 到 exact tag，push 後開唯一的 back-merge PR 回 `main`；merge 後 `post-promote --back-merge-pr` 驗證 `MERGED`、在 `origin/main` first-parent 鏈上、內容 clean；再開新 `rules/agent-rules-v<X.Y.Z>` 重做（不 fix-forward 舊 lane）。

**Broken carrier lane 不得旁路**：即使 hook 本身或 carrier lane 被打壞，rollback 仍 MUST 走 `release/rules-*` carrier（該 pattern 仍放行 base `production`）；MUST NOT 重新授權 `hotfix/revert-rules-*` 直達 `production` 作為復原手段。
