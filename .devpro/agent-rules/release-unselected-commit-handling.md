---
name: release-unselected-commit-handling
description: Release Step 1 例外路徑：分支上有本輪不上線的 commit 時的 AI 處理步驟（拆出新分支、lease 綁定改寫原分支、回讀驗證、停止條件）。觸發：release-step-1-7.md Step 1 健全檢查第 5 步 tip 不一致時。
---

# Release Step 1 補充：分支上有本輪不上線的 commit

> Load-chain：本檔由 `release-step-1-7.md` Step 1 健全檢查第 5 步按需載入；tip 一致的一般 release 不需讀本檔。

**Step 1 補充：分支上有本輪不上線的 commit（AI 處理路徑）**

由 `release-step-1-7.md` Step 1 健全檢查第 5 步（tip 不一致）指入。只新增的步驟在前，改寫原分支放最後：

1. `git fetch origin --prune` 後記下原分支 remote tip（observed OID），並驗證最後一筆 merged PR 的 `headRefOid` 是 observed OID 的 ancestor；不成立 → 停下交 TL：

   ```bash
   git fetch origin --prune
   OBSERVED=$(git rev-parse "origin/<branch>")                           # observed OID
   git merge-base --is-ancestor "<last-merged-headRefOid>" "$OBSERVED"     # 不成立 → 停下交 TL
   git log --oneline "<last-merged-headRefOid>..$OBSERVED"                 # 列給使用者，問本輪是否一起上
   ```

2. 問使用者 `<last-merged-headRefOid>..$OBSERVED` 的 commit 本輪是否一起上：要上 → 走正常 PR 合進 `main`，再重跑 `release-step-1-7.md` Step 1；不上 → 進第 3 步；不確定 → 本輪不帶此分支，記為待決。

3. **PR 寫入前先判定 milestone 三態**（在任何寫入之前）：以與 `release-milestone-assignment.md` 分支改齊指令相同的查詢，取原分支的 milestone inventory（MERGED＋OPEN），依三態判定：

   ```bash
   BRANCH=<branch>; LIMIT=100
   PRS=$(gh pr list --head "$BRANCH" --base main --state all --limit "$LIMIT" --json number,state,milestone)
   test "$(printf '%s' "$PRS" | jq length)" -lt "$LIMIT"
   STATE=$(printf '%s' "$PRS" | jq -r '[.[] | select(.state=="MERGED" or .state=="OPEN")] |
     if (map(.milestone) | all(. == null)) then "unassigned"
     elif ([.[] | .milestone.title] | unique | length == 1) then (.[0].milestone.title)
     else "conflict" end')
   ```

   - `$STATE` = `conflict` → 停下，MUST NOT 帶著 `conflict` 開新 PR；先以分支改齊指令改齊並回讀一致，才從第 1 步重新開始本節。
   - `$STATE` = `unassigned` → 4.3 的新 PR 不帶 milestone。
   - `$STATE` 為單一值 → 4.3 的新 PR 以 `--milestone "$STATE"` 沿用。
   - 判定結果寫進下一步的同意請求，讓使用者知道新 PR 會掛什麼。

4. 以下 4.1～4.5（全部寫入）開始前，一次取得使用者明確同意；既有 change 的 batch approval 不涵蓋這些寫入。

   1. OpenSpec change 處置：原 change 已 archive → 新分支另開新 change，名稱與新分支一致；仍 active → 停下交 TL；MUST NOT 同時存在兩份涵蓋同一批 commit 的 change。
   2. 從 observed OID 推新分支並回讀：

      ```bash
      git push origin "$OBSERVED:refs/heads/<new>"
      test "$(git ls-remote --exit-code origin "refs/heads/<new>" | cut -f1)" = "$OBSERVED"
      ```

      失敗 → 停止；此時沒有任何既有狀態被改動。`<new>` 分支名 MUST 過 verb 白名單（`preflight-checklist.md` 點 1–2）、不重用（見 `git-branch-naming-and-anchor.md`），並與新 OpenSpec change 同名。
   3. 已有 open PR 時，由新分支開新 PR、掛依上面 `$STATE` 判定的 milestone、與原 PR 互連，並回讀確認：

      ```bash
      if [ "$STATE" = "unassigned" ]; then
        gh pr create --head "<new>" --base main --title "<title>" --body "Relocated from <branch>; links #<old-pr>"
      else
        gh pr create --head "<new>" --base main --title "<title>" --body "Relocated from <branch>; links #<old-pr>" --milestone "$STATE"
      fi
      NEW_PR=$(gh pr view "<new>" --json number -q .number)
      gh pr view "<new>" --json milestone -q .milestone.title   # MUST 等於 $STATE（unassigned 時為 null）
      ```

      回讀不符 → 停止；原分支與原 PR 都尚未變動。
   4. 關閉原 open PR、留言指向新 PR，並回讀確認已關閉；此步 MUST 在改寫原分支之前完成：

      ```bash
      gh pr close <old-pr> --comment "Relocated to #$NEW_PR"
      gh pr view <old-pr> --json state -q .state   # MUST = CLOSED
      ```

      失敗 → 停止；原分支沒動。
   5. 改寫原分支（唯一改寫歷史的動作，放在最後）：

      ```bash
      git push --force-with-lease="refs/heads/<branch>:$OBSERVED" origin "<last-merged-headRefOid>:refs/heads/<branch>"
      test "$(git ls-remote --exit-code origin "refs/heads/<branch>" | cut -f1)" = "<last-merged-headRefOid>"
      ```

      - lease 被拒 → 停下交使用者；原分支未被改寫，commit 仍保存在新分支。
      - push 成功但回讀不符 → MUST NOT 再對原分支 force push（包括任何「還原」）；立即停下，回報寫入的 OID、回讀到的 OID、observed OID 與新分支名。
   6. 回報最終狀態：原分支與新分支的 tip、新／舊 PR 狀態、milestone。

5. 後段已進 `main`（無法拆）→ 告知只能整條延期，協助以 `release-milestone-assignment.md` 的分支改齊指令改齊整條分支的 milestone。

**非破壞性改寫論證**：本節不是「amend 後 force push」（push 來源非本機 HEAD），`git-branch-hygiene.md` §Force-Push 前 的 HEAD blob grep 核對不適用；等價核對 (a)–(d)：(a) 第 1 步 ancestry 驗證、(b) 4.2 新分支回讀 == observed OID、(c) lease 綁 observed OID、(d) 4.5 回讀 == `<last-merged-headRefOid>`。
