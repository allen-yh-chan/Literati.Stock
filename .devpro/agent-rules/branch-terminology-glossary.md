---
name: branch-terminology-glossary
description: 分支治理三核心術語可促進單位/anchor/subset 的 SSOT 定義；觸發：閱讀其他 leaf 遇到這三詞且不確定時
---

# 分支治理術語詞彙表

## 可促進單位 (Promotable Unit)

### 定義

`feature/*`、`bugfix/*`、`chore/*` 三類分支的統稱；代表一個可獨立進入 release subset 的交付單位。

### 為什麼這樣設計

分支路徑：可促進單位 → `main` → `integration` → DEV 全量 → `release/*` → `production`。hotfix 是可審查單元，source／consumer 同構經 release carrier 組裝進 production（不屬可促進單位表列，但仍經 release；見 `release-hotfix-carrier-policy.md`）。verified already-live repo-missing backfill 同走 carrier lane；外部作者身分不改變分類。

### 反例

`hotfix/*`：source／consumer 皆不直合 production、須經 release carrier（lane 見上方 SSOT pointer）；不屬於可促進單位。反之，not-yet-live nonurgent 內容仍是可促進單位，有 defect semantics 才用 `bugfix/*`，不得因來源是 customer/upstream 就改走 hotfix。

### Cross-References

- `release-sit-uat-pat-prod.md` 頂層「## Overview」段 — 分支節奏定義（`feature/bugfix/chore → main → integration → release → production`）
- `git-branch-naming-and-anchor.md`「可促進單位的乾淨前提」段 — 乾淨前提與合法 commits 豁免清單

---

## Anchor

### 定義

可促進單位分支的建立基底點，依優先序判斷：
1. 最近 `production-*` tag
2. `git merge-base <latest release/*> main`
3. 無以上則用 `main` HEAD

### 為什麼這樣設計

release/* 用 `git merge <單位>` 挑 subset；基底不乾淨（混入其他單位 commits）就無法保證 subset 乾淨。

### 反例

從 `main` 直接建 `feature/*`（非 anchor）：會吃進其他單位 commits，污染後續 subset。

### Cross-References

- `git-branch-naming-and-anchor.md`「Anchor 判斷（機器可驗證）」段 — Anchor 判斷三優先序與機器指令
- `git-branch-naming-and-anchor.md`「可促進單位的乾淨前提」段 — 可促進單位乾淨前提

---

## Subset

### 定義

ordinary finite-subset 的 `release ⊆ main` 是內容來源約束；唯一操作規範見 `.devpro/agent-rules/release-step-1-7.md` §Step 2 補充：merge 衝突處理原則「不變式」；MUST 讀取該 rule owner，依其核准來源、合法 assembly 拓樸例外與適用範圍執行；本節只提供術語入口，不另持規範正文。

`in-scope ordinary parallel handling`、`finalized production baseline`、`conditional production-tag update`、`latest-tag reassembly` 的單一定義見 `release-sit-uat-pat-prod.md` §Parallel Release Rounds Superset Ordering；只對該 scope 新增 pinned parents/tree/context proof，見 `release-step-1-7.md` Step 2。證據符號依 `release-sit-uat-pat-prod.md` §Parallel release evidence symbols。不要把裸 A/C（可能也是 feature 示例名）當路徑規範。

### 為什麼這樣設計

保證 subset 不變式才能確保 release 內容可追溯、可回滾，且 Build once 產出的 artifact 與 main 歷史一致。

### 反例

直接在 `release/*` commit 解衝突 MUST NOT 被允許：resolution 內容未經可促進單位及 main 的核准來源閉合，破壞 content provenance；合法 assembly merge OID 不在 main 不是違規理由。衝突一律 abort→回單位 sync production tag 解→regular PR main→重核准／重組裝。

### Cross-References

- `release-sit-uat-pat-prod.md` §Parallel Release Rounds Superset Ordering — scope／finalized／兩條路徑的單一定義
- `release-step-1-7.md` Step 2 — content 不變式、核准單位組裝、conflict abort／單位解衝突與 scope 內 parent/tree/context proof
- `release-verification-commands.md` §Verification — structured approved-subset evidence／content provenance、parallel 內容處置與 promotion 核對

---

## Discovery

本 leaf 經 AGENTS.md 觸發式載入索引「開工建分支 / anchor / worktree / 術語」row cross-ref 進入；遇到「可促進單位 / anchor / subset」術語不確定時讀本檔。
