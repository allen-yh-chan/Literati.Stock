---
name: recap-writer
description: "Session Recap Discussion 撰寫 recipe（trigger check、dedup check、6-point checklist、GitHub Discussion write-back）。使用時機：session 準備收尾、Stop hook 觸發、某則回覆即將結束但 work branch 上有 commit 卻尚未寫 Recap，或使用者給出結束信號（bye/晚安/算了）時。"
metadata:
  user-invocable: true
---

# Devpro Recap Writer

## Overview

本 skill 是在 session 結束時撰寫 Session Recap GitHub Discussion 的 routing 與 operational-recipe 載體。**Policy SSOT 留在 rule leaves——本 skill 不重複它。** Trigger 條件、content threshold、dedup 規則、強制性 6-point checklist、Discussion write target/template，以及 fallback path 全部定義在 `session-recap.md`。本 skill 只排序 check-then-write 的步驟；不重新定義何時需要 Recap，或 checklist 要問什麼。

## When to Use

- Session 看起來正在收尾（goal 已收斂 / delivery 已完成 / blocker 已記錄）
- CC Stop hook 觸發
- 某則回覆即將結束，work branch 上有 commit 但尚未寫 Recap
- 使用者給出明確的結束信號（bye / 晚安 / 算了 / cancel）
- 某則回覆回報「batch done」或類似的完成語言加上下一步選項——這仍算完成語言，仍會觸發此 gate

## Process

### 1. 先載入 policy SSOT

在寫任何東西之前，先載入並執行 `session-recap.md`。它定義 trigger、內容門檻、去重、6-point checklist、Discussion template 與 `gh api graphql` 失敗時的 fallback。

### 2. 確認此 gate 確實適用

檢查 content threshold：此 session 必須有 in-scope commits（feature/bugfix/hotfix/chore B）。純粹的問答、讀程式碼、探索、chore A、bump，或無 runtime 行為變更的 rules-lane sync 不會觸發 Recap——若符合這些情況則略過。

### 3. 以書面回答 6-point checklist

依 `session-recap.md` §收尾 Gate，明確回答（不能默默略過）以下六點：

1. 此 session 是否有 in-scope commits？（證據：`git log`）
2. 此 change branch 是否已寫過 Recap（dedup check）？
3. 若 (1)=yes 且 (2)=no，Discussion 是否已建立並有 URL？
4. 是否有任何已合併的 `recap-pending` marker 尚未處理？
5. 是否有可行的 rule-improvement 發現（使用者更正 / 自我反思 / 重複錯誤 / hook 誤判 / process friction / 延後的 subagent-review 發現）？
6. 若 (5)=yes，該 issue 的 disposition 是否已關閉（issue 已建立，或使用者明確延後）？

### 4. 撰寫 Discussion

完全依照 `session-recap.md` §寫入方式：在固定的 main-checkout 路徑建立 body file、**先同步 main 再跑 template checker**，然後用 `gh api graphql` 在 `devpro-tw/devpro-agent-rules` 下建立 Discussion（不論 cwd 為何，絕不建到其他 repo）。除非 body 確實只有一行，否則不要 inline——多行 body MUST 使用 `-F body=@<file>`，由前一個 Write/`cat >` 呼叫在其獨立的 invocation 中寫入，絕不可與 `gh api` 呼叫融合進同一個 compound command。

```bash
# main checkout: git fetch origin main && git pull --ff-only origin main
# linked worktree 的 feature 分支（不得在該分支 pull main）: git -C <main-checkout-root> pull --ff-only origin main
node .devpro/scripts/recap-body-template-check.mjs --body-file <path>   # 從已同步的 main checkout 執行
gh api graphql -f query='{ repository(owner: "devpro-tw", name: "devpro-agent-rules") { discussions(first: 5) { nodes { title url } } id discussionCategories(first: 10) { nodes { id name } } } }'
gh api graphql -F repoId="<repo-id>" -F categoryId="<category-id>" -F title="[<repo>] <change> <YYYY-MM-DD>" -F body=@<repo-root>/notes/tmp/recap-<change>-<unique>.md -f query='mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) { discussion { url body } } }'
```

Body MUST 以單行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>` footer 結尾，否則 `gh-footer-gate.mjs` 會擋下該次寫入。

### 5. 失敗時的 Fallback

若 `gh api graphql` 失敗，依 `session-recap.md` §Fallback 排查 token scope / Discussions enablement / category name 並重試一次；只有在該次重試也失敗時，才在對話中輸出 Recap 內容並附上錯誤訊息。

## Common Pitfalls

- 只在心裡默默想過 6-point checklist，而不是以書面回答
- 把「我只是給了完成選項，沒有宣告 session 結束」當成豁免——這仍算完成語言
- 把 body-file 寫入與 `gh api` 呼叫融合進同一個 compound command，導致 PreToolUse gate 讀到尚未寫入的檔案
- 忘記結尾的 `Rules:` footer 行，觸發 `gh-footer-gate.mjs`
- 回報「完成」時，卻留下未處理的已合併 `recap-pending` marker
- 未 `git pull` 就用舊版 `recap-body-template-check.mjs` 驗證 Recap body
- 跨 session change 只用 `--latest` 或手動截斷明細表，漏 subagent 列
- design-gate / cross-review 只列 TL Codex session、漏 reviewer Claude session——應先跑 `--rollup-manifests --dispatches ...`，再補 TL 主線 session

## Verification

```bash
node .devpro/scripts/recap-body-template-check.mjs --body-file <path>
node .devpro/scripts/lint-agent-skills.mjs
```
