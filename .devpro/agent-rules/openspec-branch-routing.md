---
name: openspec-branch-routing
description: 修 bug / fix 類指令收到時的歸屬決策樹；判定該回原可促進單位分支或新建 bugfix/hotfix；觸發：使用者下指令含「修」「修正」「fix」動詞或「回補」「同步已上線」時 / `devpro:change` pre-flight 前。
---

# OpenSpec Branch Routing Decision

## Overview

本檔是「修正類指令」的分支歸屬決策樹，為 `openspec-flow.md` 的 `### Branch Routing Decision` 段落外部化。AI 收到任何修 bug / 修正類指令時，**必須先過此表再決定是否進入 Pre-flight Checklist**；跳過此表直接走新分支流程是已知反覆犯錯模式。

## When to Use

- 任何 bug / fix / 修正類指令收到時（使用者指令含「修」「修正」「fix」等動詞）
- `devpro:change` 流程的 Branch Routing Decision 段觸發時（pre-flight 之前強制執行）

## Process

Branch routing 不決定 rigor。MUST 先依 `rules-rigor-level.md` 核對級別及來源；未設定預設 lite，以下 full OpenSpec continuation artifacts 僅在 full 已選定且授權時適用。B 形狀不授權升級；需要升 full 時先提出具體理由並取得使用者明確同意。

**前置判斷**：客戶自行修改、已上線而 repo 缺漏的回補（「回補」「同步已上線」，無對應 PR）：先讀 `release-already-live-backfill.md`（§1 給分支與路徑），不走 Rule #2／#5 的 `bugfix/`。

### Step 0: Defect-After-Merge Frontier Check

> **本段優先於下方決策樹**——收到任何「修」「修正」「fix」類指令時，**先收集 promotion frontier 證據**，再進入下方 Rule #1。直接跳 Rule #1 反射「fix → bugfix 新分支」是已知失誤路徑（issue #763 evidence：PR #25 merge 後 dashboard 漏列項目，TL 反射建 bugfix 而非回原 feature branch 加 commit）。使用者明示「回原分支修」只能決定 branch routing，**不能**取代 frontier evidence 或 OpenSpec continuation。

先**收集**前置 evidence（最少四筆）；收集可落在 session scratch／handoff，**不**要求先有 tracked `meeting-notes.md`。未**收集**前不得建立分支、修改程式碼、或判定 OpenSpec 是否可縮免。worktree 建立後，`meeting-notes.md` MUST 為該 worktree 內**第一個** repo write（見 `/devpro:change` Step 3）：

```bash
# 1. defect 對應之 PR / branch metadata（使用者明指 / AI 從 git log 推斷後回報確認）
gh pr view <PR#> --json mergedAt,state,baseRefName,headRefName,mergeCommit

# 2. 最近 production tag
git tag --list 'production-*' --sort=-committerdate | head -1

# 3. PR mergeCommit 是否已被 production-* tag 包含（只在 state=MERGED 時跑；OPEN/CLOSED-unmerged 跳過此步，mergeCommit 為 null）
git tag --contains <mergeCommit.oid> | grep "^production-"

# 4. 原 head branch 生命狀態
git ls-remote --heads origin <headRefName>
git branch --list <headRefName>
```

依 evidence 判定：

| PR state | mergeCommit ∈ production-* tag | 原 branch 仍存在 | 動作 |
|---|---|---|---|
| MERGED | 是（已上 PROD） | — | 進入下方決策樹 **Rule #5**（緊急 → hotfix；不急 → bugfix） |
| MERGED | 否（未上 PROD） | 是 | **回原 branch 加 commit 再推**（base=main, head=原 branch；對應 Rule #4）。禁止新建 bugfix 分支分裂同一 logical unit |
| MERGED | 否（未上 PROD） | 否（已刪） | 新建 `bugfix/<name>` from main（branch 已死、無法回原 branch）→ 走下方 Rule #2 |
| OPEN | — | 是 | 在原 branch 加 commit 再 push（原 PR 自動 update；同 Rule #4 變體） |
| OPEN | — | 否（已刪） | 罕見：PR 還 open 但 head branch 已刪 → 視同「找不到對應 PR」，進入下方 Rule #1 |
| CLOSED（未 merge） | — | — | PR 已關閉但從未 merge → 對應 PR 已作廢；defect 並非「剛 merge PR 後發現」場景 → 進入下方 Rule #1 |
| 找不到對應 PR | — | — | defect 並非「剛 merge PR 後發現」場景 → 進入下方 Rule #1 |

> **Pointer（不改上表路由結果）**：「MERGED／未上 PROD／原分支已刪」列——原分支的已合併 PR 仍未上線時，release Step 1 會因分支已刪停下並請使用者 GitHub Restore branch（未授權 AI 代做時；使用者明示授權後走 `release-step-1-7.md` Step 1 第 4 項的還原路徑）；本列新建的 `bugfix/<name>` 分支名 MUST NOT 重用原分支名（見 `git-branch-naming-and-anchor.md`）。

> **lite 例外**：「回原 branch」列若原分支 HEAD 已帶該 change 的 proposal（含 archive）而本次走 lite，第二審會以 `lite_proposal_present` 拒絕；建分支前停下問使用者：回原分支走 full，或從 main HEAD 開 `bugfix/` 走 lite（release 時兩分支一起選）。

**Common pitfalls**（issue #763 根因對應）：
- **PR state 語意誤解**：`state=MERGED` 不等於 promoted；只有 `mergeCommit` ∈ `production-*` tag 才算上 PROD
- **verb 反射偏誤**：看到「修」就反射 `fix` verb；應先過 Step 0 evidence
- **lazy loading 未觸發**：本檔需透過 `AGENTS.md` Intent 速查「剛 merge PR 後發現問題 / defect-after-merge」入口進入；TL 收到 fix-class 指令時主動讀本檔

### 決策樹

> **本段優先於 `devpro:change` Pre-flight**——AI 收到任何修 bug / 修正類指令時，**必須先**過此決策樹再決定是否進入 Pre-flight。跳過此表直接走新分支流程是已知反覆犯錯模式。

| # | 問題 | 答案 | 動作 |
|---|------|------|------|
| 1 | 修正可歸屬到一個**已存在**的可促進單位分支？ | 不確定 | **停下問使用者**，禁止自行判定 |
| 2 | 同上 | 否（跨單位 regression、無法歸屬） | 新建 `bugfix/` 從 anchor → 走下方 Pre-flight |
| 3 | 同上 | 是 → 該分支 tip 已被 `production-*` tag 包含？ | 見 #4 / #5 |
| 4 | tip 未被 `production-*` tag 包含（未上 PROD） | — | **在原分支修**：checkout 回去繼續 commit → PR → main。走「回到既有可促進單位分支」段落，仍須完成 active OpenSpec continuation checkpoint（深度依 `chore-classification.md` 形狀判定：A／B-mini／B；**禁止**因前綴是 feature/bugfix 就預設 full）。只跳過新建 branch/anchor；A 免 analyst／完整 proposal 鏈，B-mini／B 依判定表。**無論該分支是否已 merge 到 main。** |
| 5 | tip 已被 `production-*` tag 包含（已上 PROD） | — | 緊急 → 新建 `hotfix/` 從最近 `production-*` tag（僅此；無 tag 改走 `bugfix/`，見 `release-sit-uat-pat-prod.md`「Anchor 判斷規則」段）；不急 → 新建 `bugfix/` 從 anchor，合回 `main` 跟 release 走 |

### 改 base / 重建分支須新建獨立 change folder

決策樹判定後，若 base/anchor 改變導致丟棄舊 worktree、從新 base **重建分支**（例：原 anchor 缺目標程式碼改用 main HEAD 當 base、`git worktree remove` 原 worktree 重建），**必須**為新分支新建獨立的 `openspec/changes/<name>/` change folder。OpenSpec change folder 含在 worktree 內，會隨原 worktree 移除一併消失；新 worktree **不會**自動補回。

- **不得**復用已 archive 的舊 folder（`openspec/changes/archive/<date>-<name>/`）——archive 是上一個 promotion cycle 的凍結快照，復用會污染本次 change 的 active spec 追溯。
- 重建後第一個動作是確認 `openspec/changes/<name>/` 存在於新 worktree；不存在則停下補建（per `git-branch-naming-and-anchor.md`「既有分支但 worktree 不存在」重建段的 change-folder 確認步驟）。
- 否則會延後到 `devpro:pre-pr` archive gate 才發現缺 active change folder（已踩過的失誤）。

### 常見誤判

使用者說「幫我修 feature/X 的 bug」→ AI 看到「修」就觸發「收到新需求」→ 建新分支。正確行為：feature/X 的 tip 未上 PROD → 直接回到 feature/X 修。「已 merge 到 main」**不代表**分支生命結束（見上方決策樹 Rule #4：tip 未被 `production-*` tag 包含時在原分支修，無論是否已 merge 到 main）。

### 歸屬判斷方法

使用者明確指名可促進單位分支名 → 歸屬確定，直接走 #4。使用者只描述症狀未指名分支 → AI 可用 `git log` 或 `openspec/changes/` 輔助推斷，但**必須回報使用者確認**後才行動。

### Source Repo 純文件修正

> **Source repo 純文件修正**：`.devpro/agent-rules/*.md`、`README.md` 等純文件修正走 chore A 類 → 單 PR → main。

## Exit Criteria

- 已判定「在原分支修」（Rule #4）或「新建 bugfix/hotfix」（Rule #2 / #5）
- Step 0 frontier evidence 已落到本 change artifact（meeting-notes / BRD / decisions 之一）；未落地不得進 coding
- 使用者未指名分支時，AI 已回報推斷結果並**徵詢使用者確認**後才行動
- 確定後方可進入 Pre-flight Checklist 或「回到既有可促進單位分支」段落

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「使用者說修，那一定是新需求 → 建新分支」 | 「修」字不等於新需求。先過決策樹 #1-#3 判定歸屬；tip 未上 PROD → 在原分支修，禁止擅自建新分支。 |
| 「已 merge 到 main，分支結束了」 | tip 未被 `production-*` tag 包含 → 仍在原分支修（Rule #4），merge 到 main 不代表分支生命結束。 |
| 「PR MERGED 就是 feature 結束」 | MERGED 只代表 merged 到 main；`production-*` tag 才代表 promoted to PROD。defect-after-merge 必先過 Step 0 frontier check 區分這兩者（per issue #763）。|
| 「使用者叫我回原分支，所以不用重走 OpenSpec」 | 回原分支是 branch routing 結論，不是 OpenSpec 豁免。形狀判為 B-mini／B（含 feature/bugfix/hotfix 前綴）仍須進「回到既有可促進單位分支」checkpoint，確認 active change folder 並延續 devpro:change；A 依 `chore-classification.md` 例外，**禁止**把 feature/bugfix 前綴讀成一律 full。 |

## Verification

```bash
# 判定 branch tip 是否已被 production-* tag 包含（Rule #3 → #4/#5）
git tag --contains <branch-tip-sha> | grep "^production-"
# 空輸出 → 未上 PROD → 在原分支修（Rule #4）
# 有輸出 → 已上 PROD → 走 Rule #5（hotfix from latest production-* tag / bugfix from anchor）

# 取得 branch tip sha
git rev-parse <branch-name>

# 用 git log 輔助推斷歸屬分支
git log --oneline --all | grep -i <symptom-keyword>
```
