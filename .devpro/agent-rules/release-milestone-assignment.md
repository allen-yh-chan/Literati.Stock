---
name: release-milestone-assignment
description: 可促進分支 milestone 的分支改齊指令（首次指派與延期共用）：整條分支 MERGED＋OPEN PR 一次寫入、回讀確認、失敗處理與 release 重切提醒。觸發：TL／release 負責人要指派或改派 milestone、或分支被判 unassigned／conflict 需改齊時。
---

# Release Milestone Assignment

> Load-chain：本檔由 `release-sit-uat-pat-prod.md` §Subset selection handoff 按需載入；milestone 掛載契約與三態（`unassigned`／單一梯次／`conflict`）定義留在該節，本檔只持有可直接執行的分支改齊指令。不需指派或改派 milestone 時不必讀本檔。

非部署的 consumer 自有規範／文件／CI 仍按預計進 `production` 生效日指派；完整日期與 lane 契約見上述 SSOT。

**Branch-Level Milestone Assignment With Read-Back（首次指派與延期共用同一段可直接執行指令）**：

```bash
set -euo pipefail
BRANCH=<prefix>/<name>; MS=<YYYYMMDD>; LIMIT=100
PRS=$(gh pr list --head "$BRANCH" --base main --state all --limit "$LIMIT" --json number,state,milestone,isCrossRepository)
test "$(printf '%s' "$PRS" | jq length)" -lt "$LIMIT"   # 未通過 → 放大 LIMIT 重跑
printf '%s' "$PRS" | jq -e 'all(.[]; .isCrossRepository|not)' >/dev/null      # fork → 停下交 TL
FAILED=
for N in $(printf '%s' "$PRS" | jq -r '.[] | select(.state=="MERGED" or .state=="OPEN") | .number'); do
  gh pr edit "$N" --milestone "$MS" || FAILED="$FAILED $N"
done
READBACK=$(gh pr list --head "$BRANCH" --base main --state all --limit "$LIMIT" --json number,state,milestone,headRefOid,mergedAt)
MISMATCH=$(printf '%s' "$READBACK" | jq -r --arg ms "$MS" \
  '.[] | select((.state=="MERGED" or .state=="OPEN") and .milestone.title != $ms) | .number')
if [ -n "$FAILED" ] || [ -n "$MISMATCH" ]; then
  echo "未完成；寫入失敗的 PR：$FAILED；回讀仍不一致的 PR：$MISMATCH"; exit 1
fi
git fetch origin --prune
TIP=$(printf '%s' "$READBACK" | jq -r '[.[] | select(.state=="MERGED")] | max_by(.mergedAt) | .headRefOid // empty')
if [ -n "$TIP" ] && git cat-file -e "$TIP^{commit}" 2>/dev/null; then
  git branch -r --contains "$TIP" --list 'origin/release/*'
elif [ -n "$TIP" ]; then
  echo "unit tip $TIP 尚未 fetch 到本機，略過重切提醒"
fi
```

任一步失敗（含 `gh pr edit` 個別失敗）、或回讀仍有不一致 → 一律回報哪幾筆寫入失敗、哪幾筆回讀不一致後停下（殘留不一致下次會被判 `conflict`）；不得靜默視為完成。`<MS>` milestone 不存在時 `gh pr edit` 會失敗 → 停下請 TL 建立 milestone，不自動建立。最後一段先 `git fetch origin --prune` 再檢查分支 unit tip 是否已在某 `origin/release/*` 內；TIP 物件不存在本機時跳過並印提示，不中止；有輸出 → 只提醒該 release 可能需要重切，不自動重切。
