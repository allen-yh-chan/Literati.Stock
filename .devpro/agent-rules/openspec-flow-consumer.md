---
name: openspec-flow-consumer
description: Consumer repo OpenSpec 補充流程：rules lane routing + Issue-first Program Tracking；觸發：consumer repo 建新分支、執行 openspec-flow、或需求呈現 long-running program 形狀時。
---

# OpenSpec Consumer Repo 補充流程

## Overview

由 `openspec-flow.md` 在 consumer repo 建分支前後載入；source repo 跳過。原則：(1) 普通 feature/bugfix/chore 不推進 `.devpro-agent-rules` pointer；需新版 rules/scripts 先走 `rules/<source>-v<X.Y.Z>` lane；(2) long-running program live state 用 Issue-first Program Tracking，不放 synced `AGENTS.md`（仍禁手改）；其他 consumer 自訂規範合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。

## When to Use

- Consumer repo 新建可促進單位分支時（Pre-create-branch: 確認是否需先走 `/devpro:sync-rules`）
- Consumer repo 分支收尾時（Pre-push: 檢查 rules sync 污染）
- 使用者需求或初步 touch scope 呈現 long-running program 形狀時（Program Issue discovery / bootstrap / update）
- **不觸發**：source repo；新建旁路分支（`hotfix/`）；既有分支的 Pre-create-branch

## Process

### Pre-create-branch: no remote rules update

普通 `/devpro:change` 新建 `feature/`、`bugfix/`、`chore/` 時，**禁止** `git submodule update --init --remote .devpro-agent-rules`。分支建立後只允許初始化已記錄 checkout：

```
git submodule update --init --recursive
```

若需要 newer rules/scripts（新版 hook、anchor/sync script），停止 feature，改走 `/devpro:sync-rules` 建 `rules/<source>-v<X.Y.Z>`；merge 後再重開 feature。禁止用暫時 update submodule working copy 繞過，root `.devpro/scripts` 仍舊且會留下 pointer diff。

### Pre-push: rules sync contamination check

feature/bugfix/chore **禁止**在自身歷史 commit `.devpro-agent-rules` pointer 或衍生 `AGENTS.md`。收尾時：

- **若 working tree 含 `.devpro-agent-rules` / 根層 `AGENTS.md` uncommitted 變更**：`git restore .devpro-agent-rules AGENTS.md`（**僅 consumer repo**；source repo `AGENTS.md` 不可 restore），避免 push 帶 pointer
- **若 diff 代表真的需要新版 rules**：停止 feature commit，改走 `rules/<source>-v<X.Y.Z>`（見 `rules-flow.md`），完成 pointer + `--sync` + root `--check` 後再回 feature
- **理由**：feature 分支 commit submodule pointer 會導致平行分支 merge 時 pointer + `AGENTS.md` 雙重 conflict

### Capability spec workflow 啟用（consumer onboarding）

首次設置 `/opsx:onboard` GLOBAL config 見 `openspec-step-1-to-9.md`「GLOBAL config」；一台機器設一次。

驗證：`openspec config get workflows` 或 `openspec config list` 含 `onboard`；命中 0 → 依 `openspec-step-1-to-9.md` GLOBAL 重設 + `openspec update` reapply。`config set workflows` 不驗 enum，回讀才算數。

### Main-tip dependency check (consumer path)

依 `openspec-step-1-to-9.md`「Main-tip dependency 處理」；腳本一律 `node .devpro/scripts/...`。**禁止**靜默 branch from main HEAD。

### Program Tracker Mode
> consumer repo 需求呈 program-shaped（多 PR / 多 phase / 跨 release / migration）時，planning / implementation 前載入 `program-tracker-mode.md`（external-tracker / local-md discovery、bootstrap、update gate、completion、fail-closed）。規劃態條款（目的地、還講不清的部分、不做的部分、卡關關係、認領判定）見同組 sibling `program-planning-state.md`。

## Exit Criteria

- Pre-create-branch 未執行 remote `.devpro-agent-rules` update；只初始化已記錄 submodule checkout
- feature 分支歷史**不含** `.devpro-agent-rules` pointer commit；submodule 同步走專用 `rules/<source>-v<X.Y.Z>` 分支
- push 前 working tree 無 `.devpro-agent-rules` / 根層 `AGENTS.md` 殘留 diff（已 `git restore` 或已先完成 rules PR）
- Program-shaped 需求已有 active Program Issue，或已完成 bootstrap decision；state-changing phase PR 已更新 parent dashboard / issue / sub-issue / project fields
- GitHub Issues list 可用 title prefix + `program:<program-key>` labels 區分 parent / phase / program 歸屬；phase body 無 parent markdown mention duplicate

## Common Rationalizations

- **藉口**：「分支清理放這邊吧反正都是 git 動作」
- **反駁**：分支清理為 universal 動作（source / consumer 都應跑），不應綁 consumer-only 段；統一移到 release flow Step 6 觸發。
- **藉口**：「把 migration 規則先塞 AGENTS.md 比較快」
- **反駁**：Synced `AGENTS.md` 仍禁手改（source routing surface）。Program live state 屬 Program Issue；其他 consumer 自訂規範合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`），不可混入 synced 檔。
- **藉口**：「phase body 寫 `Parent: #123` 比較清楚」
- **反駁**：native sub-issue 已表達 parent-child；body mention 會污染 parent timeline。Issues list 可讀性靠 `Sub-issue：P<N>：...` title + `program:<program-key>` label。
- **藉口**：「Parent issue 貼幾個 phase 的完整驗證段，dashboard 比較完整」
- **反駁**：parent 只放 validation evidence index；完整驗證證據以 phase sub-issue、PR body、OpenSpec archive 為準。

## Verification

```
git status --porcelain
git log --oneline -3
gh issue list --label type:program --label program:active --search "<keyword>"
gh issue list --label program:<program-key>
gh issue list --search "is:issue is:open -label:program:phase"
```

確認 ordinary feature 分支沒有 submodule pointer / generated `AGENTS.md` diff；若需要 rules sync，另走 `rules-flow.md`。
