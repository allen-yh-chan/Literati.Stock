---
name: session-pending-lifecycle
description: session-pending.md 的 operational lifecycle 權威來源：記入 disposition / 單一路徑契約（main-checkout-root）/ 抽走處理 claim（event-based no-TTL）/ 完成刪除（不留標記射程）。觸發：處理 session-pending 條目、並行 session 協調、worktree 內讀寫 session-pending。
---

# Session Pending Lifecycle

## Overview

本 leaf 是 `session-pending.md` **operational lifecycle** 的權威來源（SSOT）：路徑契約、claim 協調、完成刪除射程界定。三層 Workflow Persistence Layers table（暫存 / 進行中 / 歷史）與 Disposition 寫入前檢查留在 `rule-design-principles.md`（廣引 SSOT）。

## When to Use

- 處理（抽走）`notes/session-pending.md` 中的條目前
- 在 linked worktree 環境讀寫 `session-pending.md` 前（防路徑脫鉤）
- 兩個 session 同時處理同一條目時（防並行雙抓）
- 確認哪些標記「處理中 claim」可寫、哪些「已完成軌跡標記」禁寫

## Process

Formalizing a pending item into an OpenSpec/change starts under `token-frugal-io.md` `Session Pending Formalization Narrowing Gate`: use the selected item, direct target file(s), and the minimum routing leaf before broad exploration. Detailed search/path rules live there.

Item boundary is a `## ` H2 section (Gate N / claim / cleanup share this); legacy top-level `- `/`* ` bullets are still accepted, so a consumer repository's legacy-only file stays countable and claimable untouched.

**新條目 MUST 以 `## ` H2 開頭**，其證據行一律縮排。頂格 `- `／`* ` 只有在**整份檔案都還沒採用 `## `** 時才是對的形狀：一旦檔內出現任一 `## `，頂格 bullet 會被前一個 section 吸收，該條目從此不是獨立可 claim 的單位，而 `claim --item <N>` 會指到別人身上。這不是假想——本 repo 曾因此讓 39 個條目集體隱形（見 `notes/session-pending.md` 的 `## 93.`）。

機械載體有兩處，判準同一個：blocking Gate NS 擋下寫入時**新引入**的頂格 bullet（既存的不擋，否則移除它們的編輯會被自己擋住）；全檔驗證跑
`node .devpro/scripts/session-pending-claim.mjs check-shape`，它是唯讀的、不取 claim lock。

Claim 生命週期可逆：`release --item <N> --change <name>`（`unclaim` 為同義），只移除自己那一行 `claimed:`，未 claim 為 no-op、他人 claim 則退出 1，不必手改檔案繞過 lock。

### 單一路徑契約（防 worktree 脫鉤）

`session-pending.md` 永遠是 `<main-checkout-root>/notes/session-pending.md`；main-checkout-root = `git rev-parse --git-common-dir` 之 dirname（同 `repo-state-identity.mjs` 解析，所有 linked worktree 收斂到同一份）。

在 linked worktree 內**禁用** worktree-relative `notes/session-pending.md`——`notes/` 為 gitignored、worktree checkout **不含**該目錄，相對路徑會讀到不存在的檔或誤建 worktree-local 幽靈檔，使跨 session 共用與下方 claim 全部失效。AI 與 hook 共用此同一份。

### Deferred sibling live carrier（#2492）

當本 change **scope-split** 並留下 **deferred sibling**（未來可促進單位，出現在 `## Non-goals`／Split scope／「另案」／「still deferred」，或 Requirement Ledger Disposition `deferred`／`moved-to-issue` 且仍需 follow-up）時，在 closing change archive／PR merge **之前** MUST 建立至少一個 **live tracking carrier**：

1. `<main-checkout-root>/notes/session-pending.md` 的 `## ` H2 item（handoff-grade；路徑契約見上節），**與／或**
2. program-shaped 時：Program Issue Backlog／phase dashboard row／native sub-issue（`external-tracker`），或 `program.md` dashboard row（`local-md`）——細節 pointer → `program-tracker-mode.md`

**MUST NOT** 把 deferred sibling **只**留在 closing change 的 `## Non-goals`／Decision Boundaries／archive prose，而沒有上列任一 live carrier。Ledger `Owner / Next Step` MUST 指向該 live carrier（pending H2 標題／issue #／program phase key），禁只寫「另案／later」。

> Non-goals 是歷史範圍邊界，不是跨 session 發現面；對齊 Program／pending 時 Non-goals-only 會漏件（#2492）。

### Handoff-grade 暫存（防 compact/clear 斷鏈）

**compact 紀律**：compact 處理靠「當下即記」紀律——compact 隨時來都不丟；**無機械 enforce、不靠 PreCompact**（PreCompact 為 CC runtime 獨家事件，cross-runtime parity 否決，已評估並 rejected）。clear 後新 session 讀回由 SessionStart hook 注入偵測非空 session-pending 來處理（clear 與 compact 是不同問題，分別處置）。

寫入「尚未完成、等下一輪決策」的 pending 時，內容 MUST 足以讓 session compact/clear 後的接手者不用靠模型記憶重建現狀；一句提醒或只有 URL 不合格。至少列：使用者意圖、source/target、目前階段、已做證據、暫定結論或候選 output、未做/不採納項、blocker 或下一個決策。

**Explore clarification capsule**（`/devpro:clarify` mode `explore`）：除上列 handoff-grade 外，談需求定案 MUST 使用可 promote 的 `decided` bullets（每條含 `provenance`；禁只寫一句摘要）、`clarify_stage: explore`、`unresolved`／`next`／`promote_ready`。Formalize 時由 `/devpro:change` **唯一 owner** 做 idempotent promote → meeting-notes Clarification State（見 `devpro:change` Formalize auto-promote；recipe pointer `devpro:clarify`）。本 leaf 仍擁有 path／claim SSOT。

digest / distill / audit 類 pending 還 MUST 記：來源身分與可信度、verdict 或 draft ledger、候選 carrier、verification idea、exclusion / anti-drift note。未知欄位寫 `unknown/not checked`，不得省略到讓下一輪誤判已完成或重新做同一輪探索。

### 抽走處理要 claim（防並行雙抓；event-based 失效，no TTL）

抽一條 session-pending 開始處理時，在該條目加 `claimed: <change-name>`（指向即將/已建的 branch）。

標準載體：`node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>`。先用 `list` 取得當前 1-based item index；helper 解析 `<main-checkout-root>/notes/session-pending.md`、以 `notes/tmp/state/session-pending-claim.lock` 協調，並用 atomic rename 更新檔案。從 linked worktree 執行時也必須寫 main checkout 的 pending file，不得寫 worktree-local ghost file。lock file 可包含 pid / timestamp metadata；helper 只可在 lock clearly stale（例如 pid 已不存在且超過保守 stale age）時 takeover。pid live、metadata 不可解析、或 age 未達門檻時 MUST 保留 live-lock fail-visible 行為（`could not acquire lock` + 具名下一步，含先寫 `openspec/changes/<change>/` 再 claim），不得移除不確定 lock。`claimed:` 存的是無 prefix 的 change-name；後續查 branch/PR 時必須用 prefix-aware lookup（例如 `feature/<change-name>` / `bugfix/<change-name>` / `chore/<change-name>` / `hotfix/<change-name>`），不得用裸 `<change-name>` 判定 stale。

claim 失效**綁 work artifact 存在與否、不綁時間**。**判定順序由上而下，先命中先適用**（因 merge 後若 `--delete-branch=false`，branch tip 仍在，必須先排除 merged 才不會誤判 in-flight）：

1. **對應 PR 已 merge**（不論 branch 是否還在）→ 該條目**已完成**，走「整條刪除」主路徑（見下節），**非**靠 claim-stale 回收；若完成卻忘刪，下次處理該條前以「對應 PR 已 merge」判定為 done 並補刪、不重做。
2. branch 仍在 or 對應 PR open（且未 merge）→ claim 有效（在做）。
3. branch 已無且無 merged PR → stale（沿用 `recap-utils.mjs::isConfirmedNonexistentBranch` 同 paradigm 判定），下個讀到的 session **清掉該 claim 重新開做**（`card-confirmed` 例外見 §Card-confirmed capsule）。

讀到帶 `claimed:` 的條目前，先查該 branch/PR：依上列順序判定 → merged 補刪不重做 / in-flight 跳過 / stale 清 claim 重做。

**in-flight handoff / next-action discipline**：有效 `claimed:`（branch 仍在或 PR open 且未 merge）代表「其他 change 正在做」，預設只能回報為 `in-flight` / `FYI` / blocker，**不得**放進推薦 next-action、選項 1、或「建議優先處理」清單。只有三種情況可「接續」：使用者明確要求接手該具名 item、原 claim owner 明確 handoff、或當前 session 本來就是該 claim owner。否則跳過；列 pending 選項時，已 claimed 且有效的 item 要另列狀態，不得與可抓的新待辦混排。

**same-change handoff capsule**：不得為同一 change 的 PR / blocker / handoff / status 新增 sibling top-level pending item。PR URL、head SHA、cross-review sticky 條件、CI/check 狀態、下一步等續接資訊，必須寫成原 claimed item 底下的 child handoff/status capsule（例如 `status:` / `blocked_on:` / `next:` / `unblock_condition:` 子項）。只有 root requirement、branch/change owner 都不同時，才可新增另一個 top-level pending item。這讓接手者看到一個工作單元，而不是把同一 PR 誤讀成兩個待辦。Named handoff／write-lease overlap gate 契約 → `multi-agent-handoff.md`（本檔只擁有 capsule 機械）。

git 同名分支互斥本身即第二層 claim（兩 session 同時建同名分支，第二個撞名即發現已被搶）。

**Governance claim-all／abandon-restore（交叉；選批 SSOT＝`rule-self-evolution.md`）**：evolution 選批對 pending 成員 MUST **claim-all** 全成功後才可 durable `## Governance Batch Selection`／repair；任一失敗 → `release` 本 attempt 已取得 claims → reselect。batch／change **abandon** 後 MUST release 本 attempt claims，**恢復**該 pending 的 eligibility（不得永久鎖死）。本 leaf 仍擁有 path／單條 claim helper SSOT，不複寫 cluster／ledger 長流程。

### 批次授權紀錄

條目要記下使用者對某 change 的批次授權時，MUST 寫成該條目下、code fence 外的 `approval:` 子項，一次授權一行（例：`  - approval: <日期> 使用者對 <change-name> 選 batch approval`）。Gate SP（`pre-tool-gate.mjs` `sessionPendingBlockRecordsBatchApproval`）只比對 claimed 條目中這種子項是否帶授權字樣；標題、其他子項、code fence 內提到同樣字樣是議題文字，不算紀錄（例如待辦本身在討論授權規則）。沒寫成 `approval:` 子項的授權 Gate SP 認不出來，等於沒有紀錄。撤回授權時刪掉該子項、保留 claim（見 `/devpro:change` 第零步「full 中途改 stepwise」）。

### 逐 PR 豁免紀錄

紀錄＝本 PR 最新的 DEV 作答、各項 Consumer 放行與綁定它們的 `pr_branch:`。寫在 main checkout `notes/session-pending.md` 本 change 的 claimed 條目（恰一行 fence 外 `claimed:`，同一 change 不分散兩條；formalize 在 `card:` 內）：

```text
  - pr_branch: <PR branch 全名>
  - dev_verification: <值同第零步>; entry: <入口> (provenance: user)
  - consumer_waiver: <原因> (provenance: user)
```

- `pr_branch:` MUST 恰一行、與第一筆紀錄同寫；第零步先寫將建的 branch，建好後核對、不符才改（`change/SKILL.md`）；MUST NOT 為對上既有紀錄而改；條目已綁他 branch 且其 PR 未 merge → 停下回報。
- `dev_verification:` 恰一行，之後任何 DEV 作答都覆寫，以最新為準；`consumer_waiver:` 每放行項一行，撤回即刪。
- 三鍵非 `approval:`，Gate SP 不讀；值不含 `授權` 等批次用語、PII、secret、log。

作答之後、寫 PR 的 `skipped per user decision:` 之前寫入並讀檔確認，失敗重試一次，仍失敗 MUST 停下、MUST NOT 寫豁免行。第零步之後任何 DEV 作答或 Consumer 放行都在沒有條目時新建條目 `## <change>：逐 PR 豁免紀錄`，用 claim helper 認領並同寫 `pr_branch:`（full B 複製 `waived:` 亦同）；續接先讀條目再讀 meeting-notes。紀錄隨條目 PR merge 後整條刪除。

### Card-confirmed capsule（不是待辦）

`clarify_stage: card-confirmed` 是 `/devpro:change` 第零步（含第三步前單獨送卡）或手動 chore A 已確認的五欄白話卡（形狀與寫入序列見 `change/SKILL.md` 第零步），不是待辦：他 session 不接手、不重做。有效 claim 照上節 in-flight；branch 不存在且無 merged PR 時不適用第 3 條：
- 獨立 capsule（自成 `## ` 條目）→ 只列 FYI，經 owner 或使用者確認後整條刪除。
- 帶子卡的 formalize 待辦（原條目下的 `card:` 子區塊）→ 同樣只列 FYI，不清 claim、不刪子卡（stepwise 下子卡在等建 worktree 同意前就寫好，branch 本來就不存在）；經確認放棄或 owner 自行放棄（含 abandon-restore）時，release 與刪子卡在同一步做，原需求保留可再選。`release` 只刪 `claimed:` 那一行，只跑 release 不算完成。

PR merge 後整條刪除（第 1 條）。初判 A／B-mini 而第二步正式判 B：第四步卡寫進 meeting-notes `decisions:` 的同一步刪掉 capsule（獨立整條；子卡只刪 `card:`、claim 保留）。owner 壓縮或重啟後照讀卡，這不是 formalize。

### 完成刪除（不留標記射程）

條目完成後**刪除該條**，不留 ✅ 標記（軌跡已在 `openspec/changes/archive/` + `git log`）。

此「不留標記」**只禁「已完成」軌跡標記**（冗餘 ROT）；**不**禁上節的「處理中」`claimed:` 協調標記——並發協調 ≠ 完成軌跡，兩者射程不同。

session-pending.md 全清空時，刪檔本身。

## Exit Criteria

- 抽走處理的條目已在條目行加上 `claimed: <change-name>`，指向對應 branch
- claim helper stale-lock takeover 只在 dead pid + stale age 等 clearly stale evidence 下發生；live / unproven lock 仍 fail-visible
- 讀到帶 `claimed:` 條目前已查 branch/PR in-flight 狀態；stale claim 已清除並重做
- 有效 in-flight claim 只作狀態回報；未獲明確接手授權時，未列入推薦 next-action / 選項 1 / 優先處理清單
- 同一 change 的 PR / blocker / handoff / status 已落在原 claimed item 的 child handoff/status capsule；未新增 sibling top-level pending item
- 未完成且等待後續決策的 pending item 達 handoff-grade：意圖、source/target、階段、已做證據、候選 output、未做/排除、下一步決策足以跨 session 接手；digest/distill/audit 類另含 verdict/ledger、carrier、verification、anti-drift 欄位
- 完成的條目已整條刪除（不留 ✅）；全清空時已刪檔
- worktree 環境內讀寫 `session-pending.md` 走 `<main-checkout-root>/notes/session-pending.md`（由 `git rev-parse --git-common-dir` 解析），非 worktree-relative 路徑
- scope-split deferred sibling 已有 live carrier（pending H2 與／或 Program dashboard／Backlog）；未只留 Non-goals（#2492）

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「寫在 Non-goals／另案就夠了，不必掛 pending」 | Deferred sibling live carrier（#2492）：Non-goals 是歷史範圍邊界，不是 live 發現面；MUST 有 session-pending 與／或 Program dashboard／Backlog |
| 「兩個 session 各做各的，不會撞」 | 所有 session 讀同一份 main-checkout-root 的 session-pending.md；無 claim 標記時，兩個 session 可能同時抓同一條目，導致雙開 worktree / PR 撞名 |
| 「claim 標記違反不留標記原則」 | 不留標記只禁「已完成」軌跡標記；claim 是「處理中」協調標記，射程不同——完成後整條刪除，不是打 ✅ |
| 「claim 要設個 TTL 才不會卡死」 | 不設 TTL；失效條件綁 branch/PR 存在與否（event-based），比計時器更準且無 clock skew 問題 |
| 「使用者問待辦，我可以把 claimed item 排成下一步讓他選」 | 有效 claim = in-flight，不是 free item；只能列狀態，除非使用者明確說接手該具名 item |
| 「PR 已開但卡 reviewer/approval，另加一條 pending 比較醒目」 | 同一 change 的狀態要在原 claimed item 的 child handoff/status capsule；另加 sibling top-level pending item 會讓接手者誤判成兩個工作單元 |
| 「在 worktree 內寫 notes/session-pending.md 比較方便」 | worktree 的 notes/ 為 gitignored 且未 checkout，相對路徑會誤建 worktree-local 幽靈檔，與 main-checkout-root 脫鉤，claim 機制全部失效 |
| 「pending 只要提醒我下次看 URL 就好」 | pending 是跨 session handoff，不是個人便條；compact/clear 後不能靠本輪記憶補洞。 |

## Verification

```bash
# 路徑契約驗證：從 worktree 確認 main-checkout-root
git rev-parse --git-common-dir
# 取 dirname → notes/session-pending.md 應在該目錄下

# claim helper：
node .devpro/scripts/session-pending-claim.mjs list
node .devpro/scripts/session-pending-claim.mjs claim --item <N> --change <change-name>

# claim 存活驗證：
# branch 仍在 → prefix-aware git branch → claim 有效
git branch --list "*/<change-name>"
# branch 不存在 → 查 merged PR → 若無 merged PR → stale → 清 claim

# hook 機械守門：session-pending-cleanup-check.mjs（Stop hook）
# test：.devpro/scripts/tests/hook-session-pending-cleanup.test.mjs
```
