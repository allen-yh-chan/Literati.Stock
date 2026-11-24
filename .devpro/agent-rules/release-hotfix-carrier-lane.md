---
name: release-hotfix-carrier-lane
description: Hotfix release-carrier lane 逐步 recipe（cut carrier、bump-first、序列化 hotfix PR、freeze／build once／smoke、provenance、production PR、tag、back-merge）與 grandfathered legacy hotfix 收尾、consumer 遷移自查。觸發：執行 hotfix／rollback／already-live backfill 上線時。
---

# Hotfix Release-Carrier Lane Recipe

> Load-chain：本檔由 `release-step-1-7.md` Step 7 與 `release-hotfix-carrier-policy.md` 按需載入；normative 條款（N1–N5、狀態機、新鮮度 gate、cutover）SSOT 在後者，本檔放逐步執行 recipe 與 consumer 遷移自查。一般 release（Step 1–6A）不需讀本檔。

### Hotfix release-carrier lane（source／consumer 同構）

一個 `hotfix/<name>` 單元、其版本 bump（若適用）與 rules-lane rollback 單元（`hotfix/revert-rules-*`），一律經**同一序列**進 `production`，不因 repo 身分分岔：cut carrier 自 `ANCHOR_TAG`（拓撲判定的最新 `production-*` tag，見 `release-sit-uat-pat-prod.md`「hotfix 基底固定規則」）→ bump-first（若適用）→ 序列化 hotfix PR merge（carrier 同時只允許一個 in-flight hotfix PR）→ 雙條件新鮮度 gate（一律 fail closed，無 lock 例外）→ freeze（pin `CARRIER_SHA`）→ build once → SIT/UAT/smoke（可縮不可省）→ `hotfix-carrier-provenance` block → production PR（head＝carrier）→ tag → carrier `--ff-only` 到 tag ＋ 單一 back-merge PR 回 `main`。`hotfix/*` 與 `chore/bump-v*` **MUST NOT** 是 base `production` 的 PR head；只有 carrier 自己的 PR 進 `production`。

| lane | carrier 命名 | bump | tag 族 |
|---|---|---|---|
| source | `release/v<X.Y.Z>` | 必 bump（`chore/bump-v<X.Y.Z>`；bump-first，`MC^1==anchor_commit`） | `production-v<X.Y.Z>` |
| consumer | `release/<YYYYMMDD>-<shortSHA>[-<n>]` | 有版本檔（`version-metadata-files` 清單，見 `release-sit-uat-pat-prod.md`）才 bump；否則 `bump: N/A`（`anchor_commit` 與 `carrier_sha` 兩個 tree 皆無版本檔） | `production-<YYYYMMDD>[-<n>]` |
| consumer-rules rollback | `release/rules-<YYYYMMDD>[-<n>]` | 純 clean revert（單 commit、直疊 anchor）可 `bump: N/A`（先過 revert 形狀驗證）；手動解衝突的 revert MUST 改走 bump | `production-<YYYYMMDD>-rules[-<n>]` |

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
git fetch origin --prune --tags
ANCHOR_TAG=<拓撲判定的最新 production-* tag>
ANCHOR_COMMIT=$(git rev-parse "$ANCHOR_TAG^{commit}")
node .devpro/scripts/hotfix-carrier-verify.mjs freshness --anchor-tag "$ANCHOR_TAG" --anchor-commit "$ANCHOR_COMMIT"

# T1：cut carrier（source release/v<X.Y.Z>；consumer release/<YYYYMMDD>-<shortSHA>[-<n>]；rules rollback release/rules-<YYYYMMDD>[-<n>]）
# carrier worktree MUST 用獨立路徑（carrier 名含 `/`，轉安全字元，例 release/v1.2.3 → <carrier-name-safe>=release-v1.2.3）；
# 下方 hotfix worktree <name> MUST NOT 與 <carrier-name-safe> 相同，否則第二次 git worktree add 會撞路徑失敗
CARRIER=<carrier-branch-name>
git worktree add "$REPO_ROOT/.worktree/<carrier-name-safe>" -b "$CARRIER" "$ANCHOR_TAG"
cd "$REPO_ROOT/.worktree/<carrier-name-safe>"
git push -u origin "$CARRIER"   # cut 後立即 push；carrier 須先是既存 ref 才能作下方 hotfix／bump PR 的 base（N2）
# 有版本檔（source 必；consumer 依 version-metadata-files 清單）：bump PR base=carrier，先 merge（bump-first）
gh pr merge <bump-pr> --repo github.com/OWNER/REPO --merge
git fetch origin --prune --tags   # GitHub 端 merge 後先 fetch；merge-proof 讀 origin/$CARRIER
node .devpro/scripts/hotfix-carrier-verify.mjs merge-proof --kind bump --pr <bump-pr> --carrier "$CARRIER" --anchor-commit "$ANCHOR_COMMIT"
git merge --ff-only "origin/$CARRIER"   # 本地 carrier 追上遠端（bump 已在 GitHub 端 merge 進 origin/$CARRIER）

# 每個 hotfix 單元自身仍從同一 ANCHOR_TAG 開，用獨立 worktree 路徑（source repo hotfix uses latest `production-v<X.Y.Z>`；
# consumer date lane uses `production-YYYYMMDD[-n]`）：
git worktree add "$REPO_ROOT/.worktree/<name>" -b hotfix/<name> <production-* tag>   # <production-* tag>＝上方 $ANCHOR_TAG
cd "$REPO_ROOT/.worktree/<name>"
# 修復 → sticky 綁 tip → 選定核准的 tip SHA（1..N）→ PR base＝carrier（已於上方 T1 push、為既存 ref），review 時留 hotfix-review-binding 留言

# T2：逐一序列化每個核准 hotfix 單元（review 時於該 hotfix PR 留言
#     hotfix-review-binding: head=<40hex> base_ref_oid=<40hex> merge_base_sha=<40hex>；格式定義見
#     release-hotfix-carrier-policy.md）
node .devpro/scripts/hotfix-carrier-verify.mjs pre-merge --pr <n> --carrier "$CARRIER" --approved-tip <sha> --base-ref-oid <sha> --merge-base <sha>
gh pr merge <n> --repo github.com/OWNER/REPO --merge --match-head-commit <approved-tip>   # 只 merge 審過的 tip；PR head 已前進 → GitHub 拒絕 merge、停下
git fetch origin --prune --tags   # GitHub 端 merge 後先 fetch；merge-proof 讀 origin/$CARRIER
node .devpro/scripts/hotfix-carrier-verify.mjs merge-proof --kind hotfix --pr <n> --carrier "$CARRIER" --anchor-commit "$ANCHOR_COMMIT" --approved-tip <sha> --base-ref-oid <sha>
cd "$REPO_ROOT/.worktree/<carrier-name-safe>"
git merge --ff-only "origin/$CARRIER"   # 本地 carrier 追上遠端，供下方 freeze／back-merge push 使用
# 衝突：重寫單元或重新核准合併單元（新 sticky）；禁在 carrier 上解衝突、禁兄弟 hotfix merge-in

# T3：freeze → build once → smoke（可縮不可省）
git fetch origin --prune --tags
node .devpro/scripts/hotfix-carrier-verify.mjs freshness --anchor-tag "$ANCHOR_TAG" --anchor-commit "$ANCHOR_COMMIT"   # freeze 前再驗一次
CARRIER_SHA=$(git rev-parse "origin/$CARRIER^{commit}")   # freeze：一律取 origin/$CARRIER tip pin carrier content；此後任何 content-changing ref 移動作廢本次 build
# build once → 記 artifact_id → SIT/UAT/smoke（同一 artifact）

# T4：hotfix-carrier-provenance block → production PR（fence info string 必須逐字是 hotfix-carrier-provenance；
#     verifier 逐行解析 key: value，info string 寫成 text 或其他字串會使 pre-promote 判定 block missing）
# hotfix lane PR body（T4 production PR、back-merge PR、grandfathered PR #2 同規則）：main-checkout notes/tmp 字面絕對路徑（禁 $VAR／worktree 內路徑）、
#     canonical PR 模板段＋該 PR 專屬行＋末尾 footer（缺 footer 會被 gh-footer-gate 擋下）、gh 送出後即刪；見 file-write-destinations.md
# body file 前段（獨立呼叫）：依 git-pr-template-and-merge.md「PR 描述模板」寫出全部必填段至 <main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md
#     （不適用段寫 N/A: <具體理由>；缺段會被 pr-body-template-lint 擋下），再以獨立呼叫附加本 PR 專屬行與末尾 footer：
cat >> <main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md <<EOF
\`\`\`hotfix-carrier-provenance
lane: source | consumer | consumer-rules
anchor_tag: $ANCHOR_TAG
anchor_commit: $ANCHOR_COMMIT
carrier: $CARRIER
carrier_sha: $CARRIER_SHA
bump: pr=<n> head=<40hex> mc=<40hex> | N/A
unit: pr=<n> approved_tip=<40hex> base_ref_oid=<40hex> merge_base_sha=<40hex> mc=<40hex> shape=merge [reverts=<40hex>]
artifact_id: <non-empty>
built_at: <UTC instant ending in Z>
gates: <gate>=pass, smoke=pass
\`\`\`
Release Target: N/A（hotfix lane）

Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>
EOF
node .devpro/scripts/hotfix-carrier-verify.mjs pre-promote --carrier "$CARRIER" --body-file <main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md
gh pr create --base production --head "$CARRIER" --body-file <main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md
rm <main-checkout-root>/notes/tmp/hotfix-carrier-provenance-<unique>.md
PRODUCTION_PR=<production-pr-number>
PRE_PROMOTE_JSON=$(node .devpro/scripts/hotfix-carrier-verify.mjs pre-promote --carrier "$CARRIER" --production-pr "$PRODUCTION_PR"); PRE_PROMOTE_EXIT=$?
printf '%s\n' "$PRE_PROMOTE_JSON"
test "$PRE_PROMOTE_EXIT" -eq 0   # pre-promote 非 0 → 停下、不 merge（上方 JSON 的 reason／checks 說明哪一項失敗）
PROVENANCE_SHA256=$(printf '%s' "$PRE_PROMOTE_JSON" | jq -r '.checks[] | select(.id=="pre-promote.provenance-sha256") | .detail')
test -n "$PROVENANCE_SHA256" && test "$PROVENANCE_SHA256" != null   # digest 只在全部 check 通過後輸出；post-promote 以它確認 merge 後 provenance block 未被改寫
node .devpro/scripts/hotfix-carrier-verify.mjs merge-target --pr <production-pr-number> --carrier "$CARRIER" --base production   # 與下一行同一個字面編號；確認它是本 repo 的 carrier → production 開啟中 PR（fork 的同名分支不算；同 repo 同一組 head／base 只會有一個開啟中 PR）；非 0 → 停下、不 merge
gh pr merge <production-pr-number> --repo github.com/OWNER/REPO --merge --match-head-commit "$CARRIER_SHA"   # PR 編號寫字面值（merge gate 在 shell 展開前判定，讀不到變數）；PR 身分靠上一行 merge-target，--match-head-commit 只確認 head 仍是 pre-promote 驗過的 carrier_sha，carrier 已前進 → GitHub 拒絕 merge、停下
MERGE_SHA=$(gh pr view "$PRODUCTION_PR" --repo github.com/OWNER/REPO --json mergeCommit -q .mergeCommit.oid)   # 與上一行 merge 同一個 repo；只寫編號時 gh 依目前目錄或 GH_REPO 選 repo，可能讀到別的 repo 同號 PR
test -n "$MERGE_SHA" && test "$MERGE_SHA" != null
git fetch origin +refs/heads/production:refs/remotes/origin/production --tags
git cat-file -e "$MERGE_SHA^{commit}"
git merge-base --is-ancestor "$MERGE_SHA" origin/production   # 打 tag 前先證明已在 production 上；不成立 → 停下、不打 tag、不 push
TAG=<production-v<X.Y.Z> | production-YYYYMMDD[-<n>] | production-YYYYMMDD-rules[-<n>]>
git tag "$TAG" "$MERGE_SHA"
git push origin "refs/tags/$TAG"   # push only the tag ref
node .devpro/scripts/hotfix-carrier-verify.mjs post-promote --tag "$TAG" --carrier "$CARRIER" --carrier-sha "$CARRIER_SHA" --anchor-commit "$ANCHOR_COMMIT" --production-pr "$PRODUCTION_PR" --provenance-sha256 "$PROVENANCE_SHA256"

# carrier ff → 單一 back-merge PR 回 main
git fetch origin --prune --tags
git merge --ff-only "origin/$CARRIER"   # push 前先與遠端同步，避免 non-fast-forward 被拒
git merge --ff-only "$TAG"
git push origin "$CARRIER"
# body file 前段（獨立呼叫）：依 git-pr-template-and-merge.md「PR 描述模板」寫出全部必填段至 <main-checkout-root>/notes/tmp/hotfix-carrier-back-merge-<unique>.md
#     （不適用段寫 N/A: <具體理由>；缺段會被 pr-body-template-lint 擋下），再以獨立呼叫附加本 PR 專屬行與末尾 footer：
cat >> <main-checkout-root>/notes/tmp/hotfix-carrier-back-merge-<unique>.md <<EOF
Back-merge: $CARRIER → main（tag $TAG）

Release Target: N/A（hotfix lane）

Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>
EOF
gh pr create --head "$CARRIER" --base main --title "Back-merge $CARRIER" --body-file <main-checkout-root>/notes/tmp/hotfix-carrier-back-merge-<unique>.md
rm <main-checkout-root>/notes/tmp/hotfix-carrier-back-merge-<unique>.md
BACK_MERGE_PR=<back-merge-pr-number>
node .devpro/scripts/hotfix-carrier-verify.mjs merge-target --pr <back-merge-pr-number> --carrier "$CARRIER" --base main   # 與下一行同一個字面編號；確認它是本 repo 的 carrier → main 開啟中 back-merge PR（fork 的同名分支不算）；非 0 → 停下、不 merge
gh pr merge <back-merge-pr-number> --repo github.com/OWNER/REPO --merge --match-head-commit "$MERGE_SHA"   # PR 編號寫字面值；PR 身分靠上一行 merge-target，--match-head-commit 只確認 head 仍是 MERGE_SHA（carrier 已 ff 到 tag），不符 → GitHub 拒絕 merge、停下
git fetch origin --prune --tags   # post-promote --back-merge-pr 讀 origin/main first-parent 鏈；merge 後先 fetch
node .devpro/scripts/hotfix-carrier-verify.mjs post-promote --tag "$TAG" --carrier "$CARRIER" --carrier-sha "$CARRIER_SHA" --anchor-commit "$ANCHOR_COMMIT" --production-pr "$PRODUCTION_PR" --provenance-sha256 "$PROVENANCE_SHA256" --back-merge-pr "$BACK_MERGE_PR"
```

若進行中 release 要含修復，棄舊並從新 tag 重開/rebuild（不得把 hotfix carrier 內容 cherry-pick 進正在組裝的一般 release）。

**Rollback 與 already-live backfill**：consumer rules-lane rollback（`hotfix/revert-rules-*`；SOP 見 `rules-flow-rollback.md` §Rollback SOP）、一般 `hotfix/revert-*`、與 verified already-live repo-missing backfill 全部走本 carrier lane 全套（freeze、build once、smoke、provenance）；`hotfix/*` **MUST NOT** 有任何直達 `production` 的旁路，即使是為了從壞掉的 carrier lane 恢復。來源記在 PR/commit/OpenSpec；若內容是 not-yet-live nonurgent，仍是可促進單位，有 defect semantics 才走 `bugfix/*`。Only an independently urgent hotfix repair may defer OpenSpec + qa scope within 24h; non-urgent already-live backfill MUST complete normal OpenSpec/pre-flight 於實作前，組裝後仍至少 smoke / at least smoke；hotfix prefix alone MUST NOT authorize freeze-break；緊急（hotfix 旁路）僅限 independently urgent，non-urgent already-live 不得借旁路跳正常 OpenSpec。（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）

**Cutover／grandfather**：生效點＝本 repo 取得含本 change 規則版本後新開的 hotfix（consumer 見下方「Consumer 遷移自查」）。in-flight legacy PR #1（`hotfix/*`→`production`）尚未 merge → 關閉，自最新 tag 依本 carrier lane 重切、新 sticky；已 merge → 走下方「Grandfathered legacy hotfix completion」完成舊 lane，其後續 PR body 記 `grandfathered-legacy-hotfix: PR #<n>`。不得以 bypass merge 舊 PR #1、不得把舊 PR #1 retarget 成 carrier。

**Milestone 為 inert**：hotfix、bump、carrier 三類 PR body 皆寫 `Release Target: N/A（hotfix lane）`；缺 milestone 或誤掛 milestone 皆不影響本 lane 的完成判準——判準恆為核准的 tip SHA＋sticky（連同上方 GitHub 記錄核對），從不是 milestone 欄位。

### Grandfathered legacy hotfix completion（僅適用 cutover 前已 merge 進 production 的舊 PR #1）

只適用於「本 repo cutover 前，PR #1（`hotfix/*`→`production`）已透過舊 lane 合併」的既存情況；仍在 review、尚未 merge 的舊 PR #1 MUST 改走上方 carrier lane 重切，不適用本段。cutover 後已合併進 `production` 者不適用本段，見 `release-already-live-backfill.md` §3。

```bash
# PR #1 已在 cutover 前 merge 進 production；沿用當時的 exact tag，將同一 hotfix 分支 ff-only 前進，再合回 main
git fetch origin --prune --tags
git merge --ff-only "$PROMOTED_PRODUCTION_TAG"
test "$(git rev-parse HEAD)" = "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")"   # HEAD 等於 exact promoted tag
git push origin hotfix/<name>
# body file 前段（獨立呼叫）：依 git-pr-template-and-merge.md「PR 描述模板」寫出全部必填段至 <main-checkout-root>/notes/tmp/hotfix-grandfathered-back-merge-<unique>.md
#     （不適用段寫 N/A: <具體理由>；缺段會被 pr-body-template-lint 擋下），再以獨立呼叫附加本 PR 專屬行與末尾 footer：
cat >> <main-checkout-root>/notes/tmp/hotfix-grandfathered-back-merge-<unique>.md <<EOF
grandfathered-legacy-hotfix: PR #<n>

Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>
EOF
gh pr create --head hotfix/<name> --base main --title "Back-merge hotfix/<name>" --body-file <main-checkout-root>/notes/tmp/hotfix-grandfathered-back-merge-<unique>.md
rm <main-checkout-root>/notes/tmp/hotfix-grandfathered-back-merge-<unique>.md
# PR #2 MUST 以 regular/no-ff merge 進 main；禁止 squash、rebase、patch replay
git fetch origin '+refs/heads/main:refs/remotes/origin/main'
node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$(git rev-parse origin/main)"
# exit 0 才可 complete；若 stale-H PR #2 已 merge，MUST 走 release-step-1-7.md Step 6A generic candidate-main exact-tag repair
```

ff-only 或 unique-ref 失敗即 fail closed；PR #2 merge 後 re-fetch `origin/main` 再執行 `--require-main-ancestor` gate，exit 0 才可 complete、post-gate failure fail closed。SIT/UAT smoke 可縮不可省。

### Consumer 遷移自查（取得本 lane 規則後）

Normative 條款（N1–N5、狀態機、雙條件新鮮度 gate、cutover／grandfather）SSOT 在 `release-hotfix-carrier-policy.md`；本節只給 consumer 遷移時的自查步驟。

**生效點（cutover）**：本 consumer repo 經 rules sync 取得含本 change 規則版本後，新開的 `hotfix/*` 一律走 carrier lane（`release/<YYYYMMDD>-<shortSHA>[-<n>]`）；同步前已開的舊 `hotfix/*`→`production` PR #1 依下方 (a) 自查分流。

**Grandfather**：舊 PR #1 已 merge 進 `production` → 完成舊 lane（tag，再開一個從 hotfix 分支到 `main` 的 PR），該 PR body 記 `grandfathered-legacy-hotfix: PR #<n>`；完整 mechanics 見上方「Grandfathered legacy hotfix completion」。舊 PR #1 尚未 merge → 關閉並依 carrier lane 重切。

**遷移自查 (a)–(d)**：

- (a) **in-flight 盤點**：`gh pr list --state open --json number,headRefName,baseRefName` 篩 `headRefName` 為 `hotfix/` 且 `baseRefName` 為 `production` 的項目；有結果 → 依上方 grandfather 分流。
- (b) **merge policy**：既有 `dp-change-environment-checks`（無需額外檢核）。
- (c) **CD 重 build 自查**：檢視 production merge／tag 觸發是否會讓 CD 重 build；若與本 lane 的 build once 衝突，須改為部署既有 `artifact_id`，不得對同一 `CARRIER_SHA` 重複 build。
- (d) **git 版本**：`git --version` MUST ≥ 2.40（`hotfix-carrier-verify.mjs` 前置條件；`merge-tree --write-tree` 需 ≥ 2.38、revert 形狀檢查的 `--merge-base` 需 ≥ 2.40）；低於此版本 verifier 一律 exit 2。

不加 `devpro-doctor.mjs` 檢核：doctor 為離線／無 `gh` 路徑，consumer 保護與 CD 形狀無法可靠偵測，in-flight 盤點需網路。
