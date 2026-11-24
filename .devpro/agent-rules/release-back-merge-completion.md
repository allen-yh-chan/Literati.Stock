---
name: release-back-merge-completion
description: Release Step 6A 逐步指令：PROD tag 推出後把 production 對齊回 main（檢查／分類／ff／push、開 back-merge PR、merge 後再驗）與 graph-only、content-review-required、ff-only 失敗、hotfix carrier back-merge 的轉向。觸發：已推出 exact production-* tag、執行 release-step-1-7.md Step 6A 時。
---

# Release Step 6A：back-merge completion 指令

> Load-chain：本檔由 `release-step-1-7.md` Step 6A 按需載入；適用範圍、完成判準的機械 backstop 與前提揭露留在該節。SIT-only／no tag 的 release 不需讀本檔。

Step 6A 指令（`release-step-1-7.md` Step 6 的 tag-only push 之後立刻執行）分三段，各自以獨立呼叫執行；每段開頭先帶入 Step 6 的 `PROMOTED_PRODUCTION_TAG` 與 `RELEASE_BRANCH`，未設定即 fail closed。①檢查、分類、ff、push；②開 back-merge PR；③merge 後再驗。①②在 `set -euo pipefail` 的 subshell 內執行：gate 已 exit 0（no-op）、分類不是 `release-lane-back-merge`、不在 release branch、ff-only 失敗、ff 後 HEAD 不等於 tag、`origin` 上的 release branch 不等於 tag，任一情況都在 push 與 `gh pr create` 之前停下；第②段開頭重新 fetch 並重驗 gate 與分類（兩段之間隔著使用者同意，`main` 可能已變），不沿用第①段的結論：

```bash
(
  set -euo pipefail
  : "${PROMOTED_PRODUCTION_TAG:?先帶入 Step 6 的值}" "${RELEASE_BRANCH:?先帶入 Step 6 的值}"
  git fetch origin --prune --tags
  CANDIDATE_MAIN_SHA=$(git rev-parse 'origin/main^{commit}')
  # 方向：promoted tag 必須是 main 的祖先（tag ⊂ main）；不是檢查「production 是否含 main」
  # GitHub regular merge 會在 production 產生 main 還沒有的 merge commit，所以一般 release 的第一次檢查通常非 0
  if node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"; then
    echo "STEP6A_RESULT=no-op-complete（promoted tag 已是 main 的祖先；不 ff、不 push、不開 PR）"; exit 0
  fi
  # 非 0 → 分類；recommendedRoute 不是 release-lane-back-merge（content-review-required、fail-closed 等）一律停在這裡
  ROUTE=$(node .devpro/scripts/detect-branch-base.mjs --reconciliation-status --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).recommendedRoute')
  [ "$ROUTE" = "release-lane-back-merge" ] || { echo "STEP6A_RESULT=stop（recommendedRoute=${ROUTE}；不 ff、不 push、不開 PR，轉下列條目）"; exit 1; }
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$RELEASE_BRANCH" ] || { echo "STEP6A_RESULT=stop（目前不在 ${RELEASE_BRANCH} 的 checkout；不 ff、不 push）"; exit 1; }
  git merge --ff-only "$PROMOTED_PRODUCTION_TAG"   # 失敗即停（set -e）：不 push、不開 PR，轉下列條目
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")" ] || { echo "STEP6A_RESULT=stop（ff 後 HEAD 不等於 promoted tag；不 push）"; exit 1; }
  git push origin "$RELEASE_BRANCH"                # work/release branch only
  echo "STEP6A_RESULT=release-branch-pushed（下一步：取得同意（Step 1 已涵蓋的 graph-only 免）、寫好 body file 後執行第②段）"
)
```

```bash
(
  set -euo pipefail
  : "${PROMOTED_PRODUCTION_TAG:?先帶入 Step 6 的值}" "${RELEASE_BRANCH:?先帶入 Step 6 的值}"
  git fetch origin --prune --tags
  CANDIDATE_MAIN_SHA=$(git rev-parse 'origin/main^{commit}')
  # 第①②段之間可能隔著使用者同意或時間，main 可能已變：重新驗 gate 與分類（同第①段），不沿用第①段的結論
  if node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"; then
    echo "STEP6A_RESULT=no-op-complete（promoted tag 已是 main 的祖先；不開 PR）"; exit 0
  fi
  ROUTE=$(node .devpro/scripts/detect-branch-base.mjs --reconciliation-status --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).recommendedRoute')
  [ "$ROUTE" = "release-lane-back-merge" ] || { echo "STEP6A_RESULT=stop（recommendedRoute=${ROUTE}；不開 PR，轉下列條目）"; exit 1; }
  # 只有 origin 上的 release branch 恰等於 promoted tag 才可開 PR（ff 或 push 沒完成、分支多出 commit 時兩者不等，不得提出與 tag 不符的分支）
  [ "$(git rev-parse "origin/$RELEASE_BRANCH^{commit}")" = "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")" ] || { echo "STEP6A_RESULT=stop（origin/${RELEASE_BRANCH} 不等於 ${PROMOTED_PRODUCTION_TAG}；不開 PR）"; exit 1; }
  # body file 另以獨立呼叫先寫好：依 git-pr-template-and-merge.md「PR 描述模板」寫出全部必填段至 <main-checkout-root>/notes/tmp/step6a-back-merge-<unique>.md
  gh pr create --base main --head "$RELEASE_BRANCH" --title "Step 6A: back-merge $PROMOTED_PRODUCTION_TAG into main" --body-file <main-checkout-root>/notes/tmp/step6a-back-merge-<unique>.md
)
```

```bash
# 經使用者同意（或 Step 1 已涵蓋的 graph-only）、back-merge PR 以 GitHub regular merge（禁 squash／rebase）合進 main 之後
git fetch origin --prune --tags
CANDIDATE_MAIN_SHA=$(git rev-parse 'origin/main^{commit}')
node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"   # exit 0 才可回報 release complete
```

`graph-only` 判準、`content-review-required` 與 ff-only 失敗的轉向見下列條目。**合進 `main` 是 Ask First 停點**（預設；唯一例外見下一條）：tag 推出後立即以編號選項請使用者決定（`stop-point-comms.md`）；得到回覆前的狀態是「production 已上線、`main` 尚未對齊」，不是 release 完成。

- **Step 1 已涵蓋的 graph-only back-merge（Ask First 的唯一例外）**：同時滿足三點才可不再詢問——(a) 本輪 Step 1 的 intent 請求已載明涵蓋（見 `release-step-1-7.md` Step 1「back-merge 涵蓋聲明」）且未被使用者排除；(b) tag 推出後 `--reconciliation-status` 回 `recommendedRoute=release-lane-back-merge`（graph-only：conflict-free、merge tree 等於 candidate main tree、zero tree delta），且第②段開頭重新 fetch 後的重驗仍是同一結果；(c) 該 PR 可由本 session 合併（保護規則要求他人核准時，停下交使用者）。三點都滿足時，第①②③段連續執行，各自仍是獨立呼叫、仍用 regular merge（禁 squash／rebase），不另停下詢問。任一點不滿足，或分類變成 `content-review-required`、有衝突、ff-only 失敗、需 repair、ref 無法唯一解析，即回到上一段的 Ask First 停點。

- 先 re-fetch refs 並以 exact tag 對 main 執行 ancestry gate；exit 0 / 已為 ancestor 即 no-op complete。只有 ancestry gate 非 0 時，才可執行 `--reconciliation-status` 作為 divergence classifier；分類完成前不得宣告或建立 Production ancestry repair / bounded repair。若 status 回傳 `isMainAncestor:true`、`classification=main-ancestor-confirmed` 或 `recommendedRoute=no-op`，MUST 視為 no-op complete，MUST NOT 宣告 `graph-only` 或 repair。
- `graph-only` MUST 同時為 conflict-free 且 resulting merge tree 等於 candidate main tree，並保留真實 merge parent 與 zero tree delta → `recommendedRoute=release-lane-back-merge`：當輪 release branch 上 `git merge --ff-only "$PROMOTED_PRODUCTION_TAG"`，push 後開 PR 回 `main` 以 regular/no-ff merge（命中既有 `release/v*` cross-model 豁免，non-silent advisory）；MUST NOT 用 squash、rebase、`-s ours` 或 patch-equivalence 代替 ancestry。
- ff-only 失敗、release branch 已 prune、事後才發現缺口，或 `content-review-required`（MUST 走一般 content review 與 tests，不得搭 graph-only back-merge）→ 轉 `git-branch-production-ancestry-repair.md`。
- back-merge / repair PR merge 後 MUST re-fetch `origin/main` 並重新取得 `CANDIDATE_MAIN_SHA`，再執行 `node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"`；只有 exit 0 才可回報 complete。

任一 ref 無法唯一解析即 fail closed；gate 通過後，從 reconciled tag 建下一 ordinary change 的 diff 必須維持 own-change-only three-dot。

- **Hotfix carrier back-merge（新開 hotfix；非 grandfather）**：hotfix release-carrier（見`release-hotfix-carrier-lane.md` §Hotfix release-carrier lane）ff 到 tag 後開的 back-merge PR，MUST 在其 merge 後執行 `node .devpro/scripts/hotfix-carrier-verify.mjs post-promote --tag <T> --carrier <b> --carrier-sha <sha> --anchor-commit <sha> --production-pr <n> --provenance-sha256 <64hex> --back-merge-pr <m>`，證明該 back-merge PR 已 `MERGED`、其 merge commit 在 `origin/main` first-parent 鏈上，且內容為 clean merge（`merge-tree` 重算 tree 全等）；`OPEN` 或未 merge 的 back-merge PR MUST NOT 被宣告 Step 6A 完成，MUST NOT 用任何 hotfix-branch 自行 ff 到 main 的措辭代替這一個 back-merge PR。與 `main` 衝突時走上方既有 `--reconciliation-status` 分類與修復路徑，MUST NOT 在 carrier 或 back-merge head 上解衝突。
