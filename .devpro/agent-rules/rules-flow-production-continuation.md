---
name: rules-flow-production-continuation
description: consumer rules PR merge 到 main 之後接續 production rules lane 的規則（batch scope 授權沿用、release/rules branch → production PR → tag 順序、promotion 後 ancestry reconciliation、失敗停點）。觸發：primary-checkout close-out 成功且 consumer repo 有合法 production tag 與 `origin/production` 時，由 `rules-flow.md` 的同名路由段載入；rules-to-main 階段與沒有 production 的 consumer 不載本檔。
---

# Rules Lane Production Continuation

> Load-chain：本檔由 `rules-flow.md` 的「PR merge 後 production continuation」路由段按需載入；pre-first-release 的 main-only 終點與缺 target／anchor 的 blocker 都留在該 entry。只有已有合法 production tag 且 remote target 存在才進本 continuation；另行明確要求的 first-rules-release recipe 在 `release-rules-lane.md`。

**PR merge 後 production continuation**：
- 啟動 `/devpro:sync-rules` 時先確認 batch scope；推薦完整 scope 應點名 rules-to-main、PR gate/merge、production continuation 的 release/rules branch push、production PR create/merge、production tag-only push、promotion 後 ancestry reconciliation，以及同一 lane 的 mandatory-threshold bounded subagent launch authorization（`StandingDelegationAuthorization`）。
- 若開頭 batch scope 已明確點名同一 consumer rules lane，則 Batch Scope Ledger 中對應 action 明確標 `yes` 時後續可沿用該授權；missing field、`no` 或 `ask-later` 均不得推定授權，任何未授權的 remote write/merge 必須 Ask First。
- 若自訂 scope 排除 subagent launch，Codex 等 explicit-trigger runtime 仍須在第一次 mandatory dispatch 前進 `SubagentAuthPending`。
- primary-checkout close-out 成功後，若 consumer repo 存在 `origin/production` 且 `detect-branch-base.mjs --anchor` 可解析合法 `production-*` tag，MUST 接著載入 `release-rules-lane.md`，從最近 production tag 建 `release/rules-<YYYYMMDD>[-n]`，只 cherry-pick 本批 sync commit，跑 consumer rules smoke，並依 ledger push release/rules branch、create production PR、merge production PR、resolve exact merged production commit、freshly fetch `origin/production` 驗證、tag the explicit commit，再 push only the tag ref；任一 PR 建立、merge 或 tag push 都不是完成點。
- production PR 前若 `origin/production` tip 不在 carrier 歷史內（常見症狀：production PR `DIRTY`），MUST 停下點名根因並依 `release-rules-lane.md` §Carrier ancestry repair 處理；修復分支、PR 與 merge 不在 ledger 既有 action 內，須使用者另行同意，MUST NOT rebase/recreate carrier 或在 carrier 上解衝突。
- promotion exact tag 固定後，MUST 繼續使用 `release-rules-lane.md` 的 classifier 與 repair mechanics：gate 已通過即 no-op；gate 非 0 只是 classification trigger，不得直接宣告 repair，必須分類後才依 ledger 續跑 back-merge 或 repair branch/PR/merge，merge 後 fresh re-fetch candidate `origin/main`，再對同一 exact promoted tag 執行 main-ancestor gate。
- 任何步驟失敗或未授權時，MUST 停下回報具名 blocker，且不得宣告 `/devpro:sync-rules`、sync 或 release complete。
- 啟動時的 ancestry repair 只屬 preflight/recovery，不取代 promotion 後 continuation。
