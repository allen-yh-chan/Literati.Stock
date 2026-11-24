---
name: git-branch-production-ancestry-repair
description: 合法 latest consumer production tag 對 candidate main 的 ancestry gate 非 0 時的分類與 bounded repair 流程（普通 subset／rules subset 共用）。觸發：startup 或 post-hoc ancestry gate 非 0。
---

# Git：Production ancestry repair

> Load-chain（entry）：本檔是 `git-branch-naming-and-anchor.md` § Production ancestry repair 的條件 leaf；anchor 計算與 ancestry gate 的執行時機留在 entry。ancestry gate exit 0 時不讀本檔。

### Production ancestry repair（普通 subset / rules subset 共用）

當事後（post-hoc）或 startup gate 檢查發現合法 latest consumer production tag 對 candidate `origin/main` 的 ancestry gate 非 0 時，普通 change / rules sync 必須停止；該非 0 只是 reconciliation classification trigger，不得立即宣告或建立 Production ancestry repair / bounded repair。`--reconciliation-status` 僅能在非 0 gate 後使用；若 status 回傳 `isMainAncestor:true`、`classification=main-ancestor-confirmed` 或 `recommendedRoute=no-op`，即為 no-op，不得進 repair。只有 status 與 release/rules lane mechanics 判定不能走 release-lane back-merge，或分類為 `content-review-required` / invalid recovery shape 時，才進 bounded `bugfix/fix-production-ancestry-<production-tag>`（`<production-tag>` 僅做 branch-valid normalization），從 candidate `origin/main` 建立且只 normal-merge 該 exact production tag：`git merge --no-ff "$PROMOTED_PRODUCTION_TAG"`。repair branch 禁止 unrelated changes，也禁止 squash、rebase、`-s ours`、patch-equivalence 或任何 acknowledgement / bypass 取代 ancestry。

> Scope：本 repair lane 服務事後缺口——startup gate 發現 tag 未收斂、hotfix stale-H、release branch 已 prune——與 `content-review-required` 分類。Release 當輪 completion 的主路徑是 release-lane back-merge（當輪 release branch `git merge --ff-only` 至 exact promoted tag 後開 PR 回 `main` regular/no-ff merge，見 `release-step-1-7.md` Step 6A 與 `release-rules-lane.md`）；back-merge 可行時不進本 lane。反方向——rules lane 的 `release/rules-*` carrier 不含 `origin/production` tip、production PR `DIRTY`——不是本 lane（本 lane 只修 main），走 `release-rules-lane.md` §Carrier ancestry repair。

分類指令：`node .devpro/scripts/detect-branch-base.mjs --reconciliation-status --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"`。`graph-only` 只有 hypothetical merge conflict-free 且 resulting merge tree 等於 candidate main tree 時成立，route 為 `recommendedRoute=release-lane-back-merge`；同一 release lane 的 ff-only completion 可行時 MUST 先走 back-merge，而非 bounded repair。其他 valid graph 一律為 `content-review-required` / `recommendedRoute=production-ancestry-repair`，仍 normal-merge exact tag，且須走普通 content review 與測試；衝突解完後 PR 三點 diff 為空時沒有內容可審，cross-model 由零差異 ancestry repair 豁免處理（`code-review-cross-model.md` §Zero-diff ancestry repair exemption），不要對空 diff 改跑 `--external-evaluator`；invalid / ambiguous ref fail closed。

repair PR merge 後重新 fetch candidate main，固定以 exact promoted tag 與 candidate main SHA 執行：

```bash
node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"
```

只有 exit 0 才完成 reconciliation；release completion 仍由 `release-rules-lane.md`（rules subset）或 `release-sit-uat-pat-prod.md`（ordinary subset）判定。這個 repair 只建立必要的 lineage，不改「可促進單位分支只含本單位 commits」與三點 diff invariants，也不改 rules payload 必須 `git cherry-pick <sync-commit-sha>` 的隔離契約。
