---
name: release-already-live-backfill
description: 客戶自行修改、已上線而 repo 缺漏時的回補記錄寫法（最低證據、固定欄位、lite／full 載體、具名接受），以及 cutover 後已直合 production 的事故補救順序與補件完成判準。觸發：回補、同步已上線、客戶端已上線變更、已直合 production、production 缺 tag。
---

# Already-Live Backfill 記錄與直合事故補救

> Load-chain：由 `openspec-branch-routing.md` Step 0 前置行、`git-branch-naming-and-anchor.md` 的 `production-*` 列與 `release-hotfix-carrier-policy.md` 的 already-live backfill 條按需載入。carrier 契約（N1–N5）留在 policy，操作 recipe 留在 `release-hotfix-carrier-lane.md`；本檔只持有「怎麼記錄」與「已繞過 carrier 後怎麼補救」。

## Overview

需求在客戶端、change 已在 PROD 運作而 repo 缺漏時，SA 看不到客戶的原因，也沒有 PR 可當 base。本檔定義：什麼證據算 verified（§1）、記錄寫什麼（§2）、cutover 後已有人把變更直合進 `production` 時怎麼補救（§3）、rigor × urgency 的要求對照（§4）。

§3 是**事故補救**加債務記錄，不是另一條上線 lane：不宣稱 carrier、build once 或 provenance，也不放寬 `release-hotfix-carrier-policy.md` 的任何 gate。

## When to Use

- 請求寫「回補」「同步已上線」「客戶已上線、我們 repo 沒有」，且沒有對應 PR。
- 發現有 PR 直接合進 `production`，而 `production` tip 沒有對應的 `production-*` tag。
- 不適用：內容尚未上線（not-yet-live）→ 照可促進單位流程，有缺陷語意才走 `bugfix/*`。

## Process

### §1 適用判斷（verified 最低證據）

客戶自行修改、已上線、repo 缺漏＝verified already-live repo-missing backfill；作者是客戶不改變分類。最低證據二選一：

- 客戶提供的部署檔或差異，附上線時間。
- 對 production 的直接觀察，記錄觀察方式與時間。

兩者皆無 → 不得走回補，先取得證據。記錄的寫作時點與載體見 §2。有證據後：分支照 `git-branch-naming-and-anchor.md` 的 `hotfix/` 列，自最近 `production-*` tag 開，經 `release-hotfix-carrier-lane.md` 的 carrier lane；不走 Rule #2／#5 的 `bugfix/`。

### §2 記錄寫法（只講來源與觀察到的行為，不要求寫客戶的原因）

固定欄位：來源（誰改的、何時上線、以何種形式提供給我方）、Why、逐項 `客戶端已上線變更（observed）：<可觀察的行為>`、上線證據（§1 的兩種之一）。Why 原因不明時寫 `客戶未說明調整原因`，不得編造原因。

- **時限**：non-urgent 的欄位須在實作前備妥；independently urgent 維持既有 24h 補件規則。
- **lite**：最終載體是 PR body 的固定欄位，取代 OpenSpec、pre-flight、archive 與 PR 引用要求（lite 不建 proposal、不 archive）；PR 清單中問 OpenSpec 引用或 archive 的項目，以這組欄位回答。PR 要到開 PR 才存在，所以實作前先把欄位寫在 hotfix 分支第一個 commit 的 message，開 PR 時原文轉入 PR body。「實作前備妥」沒有機械檢查（cooperative）。
- **full**：載體依 B-mini 或 full B：`proposal-mini.md` 或 `proposal.md`，同一組欄位，加 spec delta（只寫 observed 現況行為，不要求 design）；沒有 canonical spec 涵蓋該行為時，B-mini 不能新增 capability，須升 full B 用 `proposal.md`；archive 要求適用。
- **具名接受**：observed 行為進 spec delta 前，由 SA 或 TL 在 ledger 具名接受為 intended（誰、哪幾項）。AI 可整理與提議，不得推論接受；沒有具名接受的項目留在 deferred，不進 spec delta（`intent-lookup-order.md`：只有 observed 的 code 不得宣稱 canonical）。

### §3 事故補救（cutover 後已直合 production）

變更未經 release carrier 就進了 `production`（無 tag）時，先補 tag，再接受或回退。`hotfix/*` 仍不得直達 `production`；N1(b) 不放寬、不定義例外：沒補 tag 時 tip 不等於最新 tag 的 commit，連回退用的 carrier 也會 fail closed。步驟 N 在他處以 §3.N 引用。

1. **補事故 tag（接受與回退都先做）**：先 `git fetch origin +refs/heads/production:refs/remotes/origin/production --tags`，再在**目前** production tip（`origin/production`）補打事故 `production-*` tag；pre-push hook 只放行打在本機 `origin/production` 上的 tag，不先 fetch 會打在舊 tip 或被誤擋。事故 merge 之後 production 又前進時，不打在事故 merge 上。標註「事故補打，無 carrier、build once、provenance」。名稱沿用該 repo 格式：consumer `production-YYYYMMDD[-<n>]`；SemVer source repo 依 `release-hotfix-carrier-lane.md` 的版本規則，對不上就停下交回。push tag 是 Ask First，先取得使用者同意。
2. **決定接受或回退**：回退＝開 `hotfix/revert-*`（自步驟 1 的事故 tag），走既有 carrier lane，完成後只做步驟 5，不做步驟 3、4（沒有被接受的 observed 行為，不需要 spec delta）；接受＝往下。
3. **接受時讓 `main` 收斂**（條件程序見 `git-branch-production-ancestry-repair.md`，本檔不複寫）：先分類再選路。tag 已是 `main` 的祖先 → no-op，不建 repair branch；ref invalid 或 ambiguous → fail closed，不選任何 merge 路徑；其餘依分類：`graph-only` 且 release-lane back-merge 可行走 back-merge，否則 bounded repair 對 exact tag 做 normal merge。以 `--require-main-ancestor` exit 0 為完成。
4. **補件**：non-urgent 不適用 24h，改寫延後補件四要素（`rules-consistency-checklist.md`）：前提（已直合 production、無 OpenSpec）、時限（下一次 release carrier 組裝前）、責任人（合併該 PR 的人）、驗收輸出；independently urgent 維持既有 24h，輸出集合與 non-urgent 相同。驗收輸出全部齊才算完成：
   - lite：事故 PR 的 PR body 固定欄位（§2）加 QA 證據；不建 proposal、不 archive。
   - full：`proposal-mini.md`（B-mini）或 `proposal.md`（full B），加 spec delta、QA 範圍與證據、archive。
   缺任何一項不得判為完成。此補件是 `openspec-archive-principles.md` 禁止 merge 後首次 archive 的明確例外，只在本步驟成立。
   載體：事故 PR＝步驟 3 讓事故進 `main` 的那張 PR；步驟 3 為 no-op（沒有 PR）時，full 以補件 PR 為事故 PR，lite 停下交回使用者指定載體（不自行造空 PR），使用者指定的 PR 即視為事故 PR。full 的補件走獨立補件 PR，不併入步驟 3 的 repair 分支（該分支禁夾帶無關變更）：開 `chore/docs-<name>`，自 anchor（步驟 1 之後即該事故 tag）開，與 `openspec-archive-principles.md` 的 independently urgent 補件同形，urgent 與 non-urgent 只差時限；它帶這個 change 的全部 artifacts 與其首次 archive（不是單純 archive 另建的 PR）。
5. **事故記錄（接受與回退都做）**：PR body 寫直合 production 的 PR 編號與合併方式（網頁 UI 或工具），供追查；接受時寫在事故 PR 的 PR body，回退時寫在回退 carrier 的 PR body。

### §4 對照表（rigor × urgency × merge 前後）

| rigor · urgency | merge 前（回補，經 carrier） | merge 後（已直合 production 的事故，接受時；回退見 §3 步驟 2、5） |
|---|---|---|
| lite · non-urgent | 欄位實作前寫在第一個 commit message，開 PR 時轉入 PR body | PR body 欄位加 QA 證據；下一次 release carrier 組裝前補齊 |
| lite · urgent | PR body 欄位，24h 內補齊 | PR body 欄位加 QA 證據；24h 內補齊 |
| full · non-urgent | proposal-mini.md 或 proposal.md 加 spec delta，實作前寫好 | proposal 或 proposal-mini 加 spec delta、QA、archive；下一次 release carrier 組裝前補齊 |
| full · urgent | proposal-mini.md 或 proposal.md 加 spec delta，24h 內補齊 | proposal 或 proposal-mini 加 spec delta、QA、archive；24h 內補齊 |

## Exit Criteria

- 回補：§2 欄位依 rigor 載體寫好（non-urgent 在實作前備妥），observed 行為的具名接受已記錄。
- 事故補救（接受）：§3 五步走完——事故 tag 已 push、`--require-main-ancestor` exit 0、§3.4 輸出齊全、事故 PR 的 PR body 有事故記錄。
- 事故補救（回退）：事故 tag 已 push、回退 carrier 已走完 lane 並合併、回退 carrier 的 PR body 有事故記錄；不要求步驟 3、4。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「客戶沒說原因，Why 寫不出來」 | 寫 `客戶未說明調整原因`；記錄只講來源與 observed 行為，不編原因。 |
| 「已經合進 production，tag 之後再補」 | 沒補 tag，N1(b) 對所有 carrier（含回退）fail closed；tag 是第一步。 |
| 「補 tag 等於放寬 gate」 | tag 讓 gate 能通過，gate 本身不變；tag 不是 carrier，不帶 build once 與 provenance。 |
| 「lite 不用 OpenSpec，所以什麼都不用記」 | lite 的載體是 PR body 固定欄位；缺欄位或缺 QA 證據就不算完成。 |
| 「客戶改的就是需求，直接寫進 spec delta」 | observed 不等於 intended；須 SA 或 TL 具名接受，AI 不得推論。 |

## Verification

- `node --test .devpro/scripts/tests/release-already-live-backfill-grep.test.mjs` 與 `already-live-backfill-copies-grep.test.mjs` 通過。
- `git grep -n -F 'release-already-live-backfill.md'` 列出入口與副本 pointer。
