---
name: rules-flow-routing
description: "devpro:sync-rules consumer rules lane 子能力 routing fragment：submodule 工作副本更新指令 + sync commit message 規則 + 禁止混入 feature；觸發：rules/<source>-v<X.Y.Z> 分支同步階段"
---

# rules-flow routing fragment

## Overview

本檔為 `rules-flow.md` consumer rules lane 引用之 CLI fragment。普通 `devpro:change` 不讀本檔、不執行 remote submodule update；需要新版 rules/scripts 時，先完成 `devpro:sync-rules` 專用分支。無 slash command 時直接跑同一 flow，不複製步驟。

## When to Use

- **rules/<source>-v<X.Y.Z> 分支**：更新 submodule pointer、重建衍生檔、建立 sync commit
- **PR DIRTY / CONFLICTING recovery**：rebase/recreate 後重跑同一組 sync/check 指令

## Process

### (0) Dedicated Rules Branch pre-flight

1. 平行性檢查：
   ```bash
   gh pr list --search 'head:rules/' --state open --json number,headRefName,createdAt
   ```
   有 open `rules/*` PR → block，等 merge/棄用後再開新 rules branch。

2. main 健康度警告（warn-only）：
   ```bash
   ANCHOR_JSON=$(node .devpro/scripts/detect-branch-base.mjs --anchor)
   LATEST_TAG=$(printf '%s' "$ANCHOR_JSON" | jq -r 'select(.source=="production-tag") | .ref')
   if [ -z "$LATEST_TAG" ]; then
     # 無 tag：先依 git-branch-no-tag-ancestry-evidence.md 判定 adopted, pre-first-release（四項證據）。
     if pre_first_release_evidence_pass; then
       echo "ancestry gate: N/A (pre-first-release)"
       # 跳過 AHEAD；繼續 rules-to-main（本分支不計算 AHEAD）
     else
       echo "abort: no production-* tag"; exit 1   # residual missing-tag only
     fi
   else
     AHEAD=$(git rev-list --count "$LATEST_TAG"..main)
   fi
   ```
   合法 `adopted, pre-first-release` 時記錄 `ancestry gate: N/A (pre-first-release)`、**跳過 AHEAD**、續行 rules-to-main，**不得**執行 residual `abort: no production-* tag`。有 tag 且 `AHEAD >= 5` 時列非 rules-pattern commits，確認後才繼續：
   ```bash
	   git log "$LATEST_TAG"..main --oneline \
	     --invert-grep \
	     --grep='^chore: sync devpro-agent-rules' \
	     --grep='^chore: ignore .worktree' # legacy before gitignore-alignment.md managed block
	   ```

### (i) 更新 submodule 工作副本

```bash
git submodule update --init --remote .devpro-agent-rules
```

### (ii) sync commit message 規則

commit message **固定前綴** `chore: sync devpro-agent-rules`，**必須**附上 submodule 短 SHA。

```bash
SUB_SHA=$(git -C .devpro-agent-rules rev-parse --short HEAD)
# MUST include synced 100755 mode in this commit (verify before commit):
git diff --cached --summary
git commit -m "chore: sync devpro-agent-rules (${SUB_SHA})"
```

若 `git diff --cached --summary` 顯示 mode 變更未進 stage，先在 rules lane 重跑 `--sync`（非 `release/*`）再 commit。release 上殘留 mode MUST 回 rules lane 補；**禁止**在 `release/*` 任意 restore。

### (iii) 禁止延後或併入 feature commit

在 `rules/<source>-v<X.Y.Z>` 分支有 diff 時必須獨立 commit。feature/bugfix/chore 分支禁止建立此 commit；若普通分支需要新版 rules，先切到 rules lane。

## Exit Criteria

- rules 分支 working copy 已同步至 remote（`git submodule update --init --remote` 執行完畢）
- 獨立 sync commit 存在於 `rules/<source>-v<X.Y.Z>` 歷史（不與 feature 內容混入）
- commit message 含短 SHA，格式符合 `chore: sync devpro-agent-rules (<sha>)`

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「等 feature 一起 commit，比較乾淨」 | feature commit 混入規範變更會破壞 review 與 cherry-pick 邊界；sync commit 只屬於 rules lane。 |

## Verification

```bash
# 查 sync commit 歷史
git log --grep='sync devpro-agent-rules' --oneline

# 確認 working copy 狀態
git status
```
