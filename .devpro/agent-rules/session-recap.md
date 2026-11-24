---
name: session-recap
description: Session Recap 收尾 Gate 權威來源：觸發條件 / 內容門檻 / 6 點 checklist / Discussion 寫入流程 / Template + Fallback。觸發：session 告一段落判定、Stop hook fire、回覆即將結束時。
---

# Session Recap

## Overview

> 本檔為 Session Recap 規則的**權威來源**。其他檔案（含 hooks、AGENTS.md、ai-autonomy.md、rule-design-principles.md）引用本檔而非複寫。

Session 結束時必寫 Discussion 摘要，記錄 commits、卡關、規範改進，避免 cross-session 知識流失。

## When to Use

- session 告一段落（目標收斂 / 交付完成 / 阻塞已記錄）
- Stop hook fire（CC runtime）
- 回覆將結束且 work branch 有 commit 但 Recap 未寫
- 使用者明示結束信號（bye / 晚安 / 算了 等）

**不觸發**：純問答、讀 code、探索性討論；以及下方「內容門檻」明列排除類。

## Process

### Session 定義

同一對話容器中同一目標的連續交談；目標收斂（交付、阻塞已記錄、或已約定下一步）即告一段落。穩定 runtime/session ID 是機械提醒的邊界；換題須 checkpoint，但不自行改 ID。相同 ID 的 resume/compact 延續，新 ID 不自動繼承別的 session。

### 持久化原則

不得把清理累到 session 結束；需持久化的狀態在**產出當下** commit。完成有意義工作單元後，主動詢問是否 commit。

### 觸發條件（任一即進入 Recap 判定）

1. **TL 自判斷**：session 告一段落（目標收斂、交付完成、阻塞已記錄等）
2. **使用者結束信號**：訊息 normalize 後命中下列 pattern（只收真離開；中段轉移由 #3 cover）：
   - 告別：`(^|\s)bye(\s|$)`、`^(掰|掰掰|拜)$`、`(^|\s)(晚安|good night|gn)(\s|$)`
   - 取消：`^(算了|不做了|drop|cancel|abort)$`
3. **工作收尾／交付／交棒時**（Stop hook；其他 runtime 由 TL 自判斷）：本 session 有尚未 Recap 的成功 commit／PR 工作或已明確接手的義務。一般 turn 結束、T1 完成、測試綠、空 transcript、引用範例及 `AskFirstPending: none` 不觸發。
4. **進度未落地且即將換議題 / clear / redirect**：
   - 長 session 有未交付進度時，先確保 tasks.md / Recap 反映當前接續點（做完／進行中／待查），未完成 action item 記入 `notes/session-pending.md`，使下一 session 能無縫接回（連鎖工作接續細節見 `openspec-step-1-to-9.md` Step 5 tasks.md 接續載體段）。
   - 若 active change 尚未 commit / push / PR / merge 而使用者插入 unrelated redirect、interruption、或新問題，TL 在切題前 MUST checkpoint：current state、worktree/branch、validation evidence、next action；若已能完成當前 change，先完成收斂。
   - compact 無機械觸發事件，靠「當下即記 session-pending」紀律（不靠 PreCompact，已評估並否決，見 `session-pending-lifecycle.md` §Handoff-grade 暫存）。

**排除**：`review` / `check` / `先看 X` / `T<N> 完成`（task-level）；`stop` 單字（PreToolUse 用詞，避免誤觸）。

### 內容門檻（不符 → 不寫）

本 session 有 commits（feature / bugfix / hotfix / chore B）。僅問答、讀 code、探索、chore A、bump、`rules/<source>-v<X.Y.Z>` sync（無 runtime 行為變更）→ 不觸發。從 `chore/` 升級（改名 `feature/`）的純重構視為 feature commits，會觸發；`chore/` 前綴不等於 chore A，形狀以 `chore-classification.md` 判斷表為準。`isChoreAByPRBody` 只是比對 PR 標題／描述文字的啟發式（直接否定的 `chore A` 不算宣告），其結果不得當作審查證據。

### 去重與提醒 scope

同一 session / change 每個 repo 的每張 PR 各有一筆 Recap。成功 PostToolUse commit／PR／已確認 merge 記錄本 session 工作；只有 branch 上存在 commit 不能證明本 session 有工作。相同 ID resume/compact 保留 pending、30min dedup 及 in-progress lease；新 session、同分支其他 session、missing ID 或 legacy 無主 marker 不自動接手，亦不清理其他 session 的提醒狀態。

scoped 工作存於 repo local state 的 `devpro-session-reminders/<session-key>/recap-work.json`，不靠 24h TTL 丟掉未完成義務。既有 legacy pending 的 24h TTL 僅是舊 carrier 相容介面，不參與新 evaluator。Recap 依 change、GitHub.com repo 與 PR 號去重；舊的未具名紀錄及 fact 沿用原路徑，只在未具名範圍匹配。

開始寫 Discussion 只設 own-session 短 lease；PostToolUse 看到成功 createDiscussion 回應才記完成。在 `## Branch` 列出 change、`PR #N` 和對應的完整 GitHub PR URL。沒有該段時，沿用 body 只有一個 PR 的舊辨識方式。所選 PR 號有多個 repo 或連結無法驗證時，回報原因並保留待辦。失敗／中斷／未知結果保留待辦，lease 過期可再提醒。提醒 evaluator 僅讀本地 shared fact，只清本 session 的對應義務。

Stop 只在真正收尾／交付／交棒檢查，UserPromptSubmit 只在明確使用者結束信號檢查；SessionStart 不注入 backlog、也不消耗 dedup。每個 hook 最多三行：AI pending 摘要、下一動作、session 診斷檔路徑（`Details` 相對於本次 hook event/runtime cwd，AI 從該 cwd 解析）。多筆清單與完整 gate details 留檔；AI 先讀檔，需使用者決策才由 assistant 整理交棒。

明確接手：`node .devpro/scripts/adopt-session-reminder.mjs --recap <branch> [--pr-number <number> [--repo github.com/OWNER/REPO]]`；只建立本 session 的工作記錄。除明確接手外，禁止跨 session／跨同分支自動提醒。自己的 merged pending 仍須在 final/completion/handoff 前寫 Discussion；阻塞時回報 branch/change、blocker、write path、owner、continuation。

### 收尾 Gate（強制）

符合內容門檻且尚未寫 Recap 時，**禁止**用任何「完成 / 結束 / 終局 / 收工」語意回覆。Gate 觸發時 AI **必須**逐項書面回答 6 點 checklist 才能繼續。

> **completion-語意涵蓋「報任務完成 + 給收尾選項」**：完成使用者明確要求的任務（如批次 merge）後、回報「batch 完成 / 都做完了」並提供 next-step 選項（清 worktree / 後續 follow-up / 停這），**等同** completion-語意回覆，照樣觸發本 Gate。「explicitly-requested task done」**不等於**「session done 可免 Recap」——Recap 是 always-on 收尾 Gate，不因「我只是在提供選項、沒宣告 session 結束」而豁免。merge 批次告一段落即命中觸發條件 #1（TL 自判斷收斂）。

機械 enforcement 分層：目前 Stop hook 只能用 `systemMessage` 發 soft reminder；fail-closed 來自 TL final-response / process gate。文件或 PR body 不得把目前 Stop hook 描述成 hard block，除非 runtime 已驗證可阻擋。

**Final/Goal Completion Next Step Contract**：
- goal / task / PR gate 已 complete 不豁免下一步交接。
- 任何 final 或 goal-completion response 仍 MUST 明列 Next Step / handoff：目前狀態、blocker/依賴（無則 `none`）、下一個 AI-actionable step（無則 `none`）、owner、以及 continuing/waiting。
- `update_goal complete`、測試全綠、footer (`AskFirstPending` / `RuntimeCaps`)、或「已完成」摘要都不得取代 Next Step。
- 若下一步需 git/PR Ask First，正文必須寫出等待核准的具體動作。

回覆完成前必檢：（**逐項書面回答**，不得 silent 略過）

1. 本 session 是否有符合範圍的 commits（feature/bugfix/hotfix/chore B）？— 答：是 / 否（附證據：`git log`）
2. 本 session 的該 change 分支是否已寫過 Recap（去重檢查）？— 答：是 / 否（附 Discussion URL 或 marker 狀態）
3. 若 1=是 且 2=否，是否已成功建立 Discussion 並取得 URL？— 答：URL 或 fallback 輸出
4. 本 session 建立或明確接手的工作是否存在 merged recap-pending markers？— 答：無 / 有（逐項列 branch/change）；若有，是否已補寫 Recap Discussion 或明列 blocked state + next `gh api graphql` write path？不得掃描或接手其他 session 的歷史 pending。
5. 本 session 是否有可行的規範改進（來源：被使用者糾正 / 反思 / 同一錯誤再犯 / AI 主動發現 / hook 誤判 / process friction / **subagent review deferred finding**）？— 答：是/否（列舉；hook 誤判含 AI 從 evidence 自行發現 false positive / false negative / hook evidence 與事實不符；subagent review deferred finding 含 dp-reviewer / cross-model 標 Suggestion / Important 但 TL 判 deferred / out-of-scope 者；friction 見下節）
6. 若 5=是，是否已完成 issue 決策（已建立 issue，或已明確記錄使用者決定暫不建立）？— 答：issue URL 或 user 決定

第 3 / 4 點失敗須先依 Fallback 排解；重試仍失敗才可回覆完成，並附錯誤與 fallback / blocked 輸出。第 6 點未閉環前禁止回覆完成。

### Process Friction Self-Audit

規範改進檢查不得只掃 session-pending 待辦/最後 blocker；必掃 process friction：OpenSpec / rule surface 反覆補改；hook / gate / CLI permission / sandbox / auth / sticky fallback；cross-model review；PR dependency wording；同類錯誤重複。最後成功不能證明無缺口；若 one-off environment noise，答 `否` 需 reason。

**規範改進檢查收尾強化——MUST 讀 `state/session-friction.log` + 逐項 checklist 核**：

1. 執行 `cat .devpro/scripts/hooks/state/session-friction.log`（或讀取 `DEVPRO_FRICTION_LOG` 指向的路徑）取得本 session 所有 hard-block 紀錄。
2. 對每一行（格式：`<ISO8601>\t<gate-name>`）逐項問：「這次 hard-block 是否揭示了規範缺口？」——若是，記入 `notes/session-pending.md`；若純屬 agent 操作失誤（已知 rule 未遵守），答 `否` 並附簡短 reason。
3. 回答規範改進檢查時，**必須** cite log 行數（或「log 空 / 無 log」）作為掃描依據。

**只記 hard-block**：`state/session-friction.log` 記錄所有 `pre-tool-gate.mjs` 經 `emitBlock()` 發出的 hard-block，以及所有 `gh-footer-gate.mjs` 經 `block()` 發出的 hard-block。advisory / warn-only 路徑（`emitContext()` / `warn()`）不入 log，信噪比設計。

**log 為加速層**：若 `session-friction.log` 不存在、讀取失敗、或為空，仍 MUST 靠 baseline 憑審（回想本 session 撞過哪些 gate / block），不因 log 缺失豁免規範改進 friction 掃描義務。log 只是讓掃描更完整，不是掃描的前提條件。

### In-Session Correction Log

使用者糾正/反駁/指出規範漏洞或 hook 誤判，或 AI 自行發現同一錯誤再犯 / hook false positive / hook false negative / hook evidence 與事實不符，或 **subagent review（dp-reviewer / cross-model second-opinion）提出 finding（Suggestion / Important）而 TL 判 deferred / out-of-scope** 時，AI MUST 將缺口記入 `notes/session-pending.md`（形狀依 `session-pending-lifecycle.md`：opener 為 `## 待追蹤：<原始缺口/誤判>`，續行縮排為 `  - 建議落點：<rule/hook/spec 檔或 unknown>`。頂格 `- ` 會被前一個 `## ` section 吸收而不再是可 claim 單位；若該檔已出現任一 `## `，本次新引入的頂格 bullet 另會被 Gate NS 擋下——整份檔案尚未採用 `## ` 的 legacy-only 檔不在該閘射程內，前提見 `session-pending-lifecycle.md`）。

**what-to-record 判準（R8）**：**當下處理不了的，立刻記進 `notes/session-pending.md`；能當下做完的就做掉、不記。** 理由：不記 = compact 一來就遺失（compact 不可預測）。

> **reviewer 標 deferred ≠ TL 免發落**：reviewer 把 finding 標 deferred / Suggestion / out-of-scope 只代表「不在當前 PR 修」，**不**代表「不用追蹤」。TL 收到 deferred finding **當下**即 MUST 記入 `notes/session-pending.md`（不得用「reviewer 自己標 deferred」「之後再說」帶過——這正是 deferred finding 漏發落的根因）；規範改進檢查掃 session-pending 待辦，規範改進發落負責 issue / user-deferred / already-covered。

session-pending 記錄用途是讓反思/Recap 規範改進檢查回找「當初可改善的原始缺口」與觸發 context，並在規範改進發落決定 issue / user-deferred / already-covered-by-current-change 等 disposition。條目完成後**刪除該條**（per `session-pending-lifecycle.md`），不留已完成標記。

> **路徑契約 + claim（SSOT：`session-pending-lifecycle.md`，不在此複寫細則）**：session-pending.md 永遠是 `<main-checkout-root>/notes/session-pending.md`（linked worktree 內禁用 worktree-relative 路徑，gitignored 未 checkout 會脫鉤）；抽走處理一條要在條目加 `claimed: <change-name>` 防並行雙抓，claim 失效綁 branch/PR 存在與否（event-based，no TTL），讀帶 claim 條目前先查 in-flight。此「處理中」claim 標記不受「不留已完成標記」約束（協調 ≠ 完成軌跡）。

規範改進發落必須追蹤（建立 issue、使用者明確暫不建、或說明已由當前 OpenSpec change 覆蓋），若進 issue，自動填入「觸發 context」。已發落後，final / post-merge handoff 若只是回報同一項 disposition，改用普通 prose（例：`Follow-up disposition: already covered by current change`）；若當下發現另一個新缺口，立刻記入 session-pending（不等下一次收尾）。

累積 issue pool 的後續系統性收斂（跨 session 彙整 → value-score → cruel-metric gate → 規範 PR）見 `rule-self-evolution.md`；單 session 規範改進發落後，跨 session pool 由 `rule-audit-playbook.md` Cadence 第 5 觸發承接。

正確性層在 `AGENTS.md` §9（always-on / cross-runtime）；SessionStart hook 只是加速層，無 hook runtime 仍靠 AGENTS.md baseline。

### 寫入方式

使用 `gh api graphql` 建立 Discussion（`gh discussion create` 指令不存在，禁止使用）。

**Recap Discussion 寫入位置（固定）**：一律建立於 GitHub repo `devpro-tw/devpro-agent-rules`，不論 cwd / source / consumer repo：

```
# Step 1 — 查 repo ID / category ID（owner/name 固定）
gh api graphql -f query='{ repository(owner: "devpro-tw", name: "devpro-agent-rules") { discussions(first: 5) { nodes { title url } } id discussionCategories(first: 10) { nodes { id name } } } }'

# Step 2 — 建 Discussion（multi-line body 優先用 -F body=@<file>；
# inline body 只准 single-line，否則 Gate 4b 無法 lint）
gh api graphql \
  -F repoId="<repo-id>" \
  -F categoryId="<category-id>" \
  -F title="[<cwd-repo-name>] <change-name> <YYYY-MM-DD>" \
  -F body=@<repo-root>/notes/tmp/recap-<change>-<unique>.md \
  -f query='mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) { discussion { url body } } }'
```

`<cwd-repo-name>`=cwd repo、`<change-name>`=change。regex（SSOT `recap-title-check.mjs`）：`^\[<repo>\] <change> \d{4}-\d{2}-\d{2}$`

**body file 目的地（SSOT）**：Recap body file 寫在 main-checkout `<repo-root>/notes/tmp/recap-<change>-<unique>.md`（gitignored、不綁 worktree 生命週期——worktree 被刪也寫得進 Discussion）；`<unique>` MUST 是 collision-resistant 後綴（session id、timestamp、PID 或 random token；只有 change name 不夠，同一 session 為多個 PR 各寫 Recap 時各用不同後綴，固定檔名 MUST NOT 跨 session 重用，規則見 `file-write-destinations.md`）。用字面絕對路徑，勿用 `$(pwd)`/`$VAR`（PreToolUse 讀檔在 shell 展開前）。寫檔目的地總表見 `file-write-destinations.md`。

**為什麼用 `-F body=@<file>`**：避免 inline escape 與 shell command substitution；Gate 4b 對 `body=@<file>` 跑 `recap-body-template-check.mjs` 驗 H2。inline body 只准 single-line recap。

**⚠️ body 必須含 `Rules:` footer（否則 gh-footer-gate 擋）**：`createDiscussion` 走 `gh api graphql -F body=@<file>` 會被 `gh-footer-gate.mjs` 視為 gh write-back，**強制要 body 末尾單行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>` footer**（缺則 fail-closed block）。Recap body 除 4 個 canonical H2（`## Branch` / `## 完成項` / `## Requirement Ledger Completion` / `## 版本資訊`，Gate 4b 驗）外，**末尾必須再加** `Rules:` footer 一行。版號錨點 = 本 session 執行 `gh` 指令所在 repo 的 canonical remote tip `AGENTS.md`（notes/tmp 在 main checkout → `origin/HEAD`/`origin/main` tip；不可解析才 fallback 工作區）；body file 放在別的 repo **不改變**錨點，只有 cwd 讀不到版號時才退回 body file 所在 repo（`chore/bump-v*` 例外見 `ai-autonomy.md` footer 條款）。

**body file 必須先以獨立呼叫落地，再以第二個呼叫跑 `gh api`**：Step 2 的 `-F body=@<repo-root>/notes/tmp/recap-<change>-<unique>.md` 之檔案，MUST 由前一個 Write 工具或 `cat >` 呼叫先寫好；勿與 `gh api` 放同一 compound command（如 `cat > f <<EOF…EOF && gh api … -F body=@f`）—— PreToolUse 在指令攔截時讀檔，此時 heredoc 尚未執行 → Gate 4b / gh-footer-gate 讀到不存在的檔 → fail-close / 冒 spurious advisory。SSOT 見 `file-write-destinations.md` 與 `git-pr-template-and-merge.md`（同類 `gh pr create --body-file` two-step 紀律）。

**Legacy 形狀**：`-F body="$(cat <file>)"` 仍被 Gate 4b lint；Codex 若因 command substitution 失去 `gh api` prefix approval，按 `platform-adapters/codex.md` non-sandbox / host-runner `gh api` 重跑，不得誤判 token / Discussion。

**規範改進 Issue 寫入位置**（收尾 Gate 規範改進發落）同樣是 `devpro-tw/devpro-agent-rules`：

```
gh issue create --repo devpro-tw/devpro-agent-rules --title "..." --body-file <path>
```

#### Rule Feedback Issue Template

Title：`[rule-feedback] <scope>`

Body 必含：
- 觸發 context：引用本 session `notes/session-pending.md` 記錄或具體對話片段
- observed gap：現行 rule 缺口 / ambiguity
- suggested rule change：建議改哪個規則或 gate
- affected rule files：可能受影響的 `.devpro/agent-rules/*.md`

**Naming entity 釐清**：`devpro-tw/devpro-agent-rules`（GitHub repo）與 `.devpro-agent-rules`（submodule path）是**不同 entity**；target 禁用 submodule path，必用完整 owner/repo。

### 欄位定義

| 欄位 | 必填 | 說明 |
|---|---|---|
| Branch | 必填 | 分支名稱 |
| 完成項 | 必填 | 本 PR 完成的工作摘要（1-3 bullet） |
| Requirement Ledger Completion | 必填 | OpenSpec Requirement Ledger disposition counts；無 ledger 時寫 `N/A: <reason>`；非 `implemented` rows 必列 owner / issue / next step |
| 卡關點 | 條件式 | 有卡關才寫 |
| Token 回顧 | 必填 | host 回報的真實 token 花費（見 Template），取代估算欄位；host 不支援真實用量時填 `source: N/A: <reason>` |
| 未完成項 | 條件式 | 有未完成才寫 |
| 規範改進 | 條件式 | 有可行改進才寫；AI 發現可行動的改進 → 直接詢問使用者是否開 issue |
| 討論紀要 | 條件式 | 有具時序性的設計討論才寫 |
| AI 反思 | 條件式 | 有反思才寫；禁止模糊自評如「整體還不錯」 |
| 反向自檢 | 必填 | 三行（動手前／需求／交付前），格式與「寫不出可驗內容即視為沒問」見 `reverse-self-check.md` |
| 版本資訊 | 必填 | Rules 版號 + LLM model（格式：`<工具名稱> / <model 簡稱>`） |

### Template（copy-paste-ready）

> Load-chain：`## Token 回顧` 進階情境見 `session-recap-token-usage.md`。

填下列結構，**禁止**改 H2 標題（禁 `## Context` / `## Changes` / `## Decisions` / `## Lessons` / `## Outcome` / `## Root Cause Analysis` 等）。可省略段落，不保留空 H2。

```markdown
## Branch
<branch-name> (PR #N, merged → main)
https://github.com/OWNER/REPO/pull/N

## 完成項
- <bullet 1>

## Requirement Ledger Completion
- disposition counts: implemented <n>, partial <n>, deferred <n>, rejected <n>, moved-to-issue <n>
- non-implemented rows: <N/A 或列 R# + disposition + owner/issue/next step>

## 卡關點
- <可省略，無卡關不寫>

## 討論紀要
<可省略，無時序性設計討論不寫>

## AI 反思
- <可省略；禁止模糊自評；具體指出哪個判斷不足>

## Token 回顧
執行下列其中一行取得本節資料（依實際使用的 host 擇一；`--host` 值 MUST 為 `claude-code` 或 `codex` 其中之一，MUST NOT 用不指定 host 的模式）：
`node .devpro/scripts/report-session-token-usage.mjs --host claude-code --session <session-id>`
`node .devpro/scripts/report-session-token-usage.mjs --host codex --session <session-id>`

**進階情境**：跨 session／host（禁只用 `--latest`）、`--since-change` 歸因、second-reviewer dispatch 用量、lineage／`final`／`reconciled` 等宣稱（structured claim 欄位 block 接在 `- cost_usd:` 之後）、固定歷史證據、曾用 subagent（含 orphan；明細 MUST 保留 subagent 列）、撰寫工具與用量主體不同——符合任一 MUST 先讀 `session-recap-token-usage.md`。缺 dispatch manifest 記 `usage-manifest-missing` 或對應具名缺口。

**Lint 前同步**：建 Discussion 前 MUST 先 `git fetch origin main && git pull --ff-only origin main`（或在已同步 main checkout），再跑 `recap-body-template-check.mjs`——禁止對未 pull 的舊 gate 驗證 Recap body。cwd 在 linked worktree 的 feature 分支時不得在該分支 pull main（Upstream pollution gate）：改用 `git -C <main-checkout-root> pull --ff-only origin main`（形式見 `git-workflow-tracking.md` §Post-merge Local Sync），並以該已同步 main checkout 的 `.devpro/scripts/recap-body-template-check.mjs` 驗證。host 擋下該指令時照 `git-workflow-tracking.md` §Post-merge Local Sync 的「host 擋下」交棒，拿到同步輸出前不跑 lint、不建 Discussion。

**Head-bound 雞生蛋（#2583 / D3）**：樹內證據檔（Session Recap Discussion body、`qa-test-scope.md` transcript）**MUST NOT** 要求 `tip_head`／`tested_revision`（或等價 tip SHA 欄）等於「即將寫入該證據檔而產生的 commit SHA」。合法 Prefer PASS 綁定僅適用**樹內證據檔**，**不適用** merge-gate／post-PR sticky 的 `last_reviewed_sha == headRefOid` 義務（該義務 MUST 保留，見 `code-review-cross-model.md`）。

**docs-only／空 product diff**＝R6 rename-aware bookkeeping allowlist（例 `openspec/changes/**`、`docs/**`、`notes/**`、`README*`）；**明確排除** `.devpro/agent-rules/**`、`**/SKILL.md`、`.devpro/scripts/**`、`**/tests/**`——行為檔不得當 docs-only Prefer PASS。合法 parent 綁定 MUST 記錄：(1) named parent SHA（MUST 為 tip ancestor）；(2) `parent..tip` **name-only** diff 僅含 allowlist（可機械驗證）。**MUST NOT** 以本 repo 不適用的 `*.cs` 等價措辭當 SSOT 空-diff 例。

- host: <claude-code | codex>
- session: <host 回報的 session id>
- source: <精準命中 | --latest fallback（非精準定位）| N/A: <host 不支援真實用量時的具體原因>>
- totals: <input N / output N / cache_read N / cache_creation N，或 source 為 N/A 時填 N/A>
- cost_usd: <$N | N/A: <reason>（工具從不輸出裸 null，永遠是 `$<數字>` 或 `N/A: <具體原因>`）>
- gaps: <具名缺口列表，或 無>

| 起 | 耗時 | 誰 | 項目 | input | output | cache_read | cache_creation |
|---|---|---|---|---|---|---|---|
| <ISO-8601 timestamp，如 2026-08-20T10:00:00.000Z> | <Ns> | <main 或 subagent 類型> | <prompt 首行／description> | <N> | <N> | <N> | <N 或 —> |

## 版本資訊
Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>
```

建 Discussion 前**必跑** `node .devpro/scripts/recap-body-template-check.mjs --body-file <path>`；exit ≠ 0 → 補段名重跑。PreToolUse hook 也會在 `gh api graphql ... createDiscussion` 偵測 body file 並同步驗證。

### Fallback

若 `gh api graphql` 失敗，先排解 token scope、Discussions 是否啟用、category 名稱，重試一次；仍失敗才把 recap 輸出在對話中並附錯誤。

## Exit Criteria

- 收尾 checklist 六點全部書面回答完成
- Recap body 已回報 Requirement Ledger Completion（無 ledger 時明寫 `N/A: <reason>`）
- 若 1=是 且 2=否，Discussion URL 已取得（或 fallback 輸出已留在對話）
- 若 5=是，規範改進發落已閉環（issue URL 或 user 明示暫不建立）

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「commits 不多」 | 看分支類型不看數量；feature/bugfix/hotfix/chore B 任 1 commit 即觸發。 |
| 「還沒明確結束」 | #3 cover mid-implementation / blocked，不用等使用者 bye。 |
| 「同主題寫過」 | 去重維度是同 change 分支；不同分支各寫一筆。 |
| 「GraphQL 失敗就口頭交代」 | 先排解 token / Discussions / category 並重試 1 次；仍失敗才對話輸出。 |
| 「先問使用者要發到哪個 repo」 | 位置固定在 `devpro-tw/devpro-agent-rules`，不論 cwd 是哪個 repo，不得列成選項；要問的只有去重與規範改進 issue 的決定。 |
| 「6 點 checklist 內心過了」 | 必須**逐項書面回答**，讓使用者可跨 session 驗證。 |
| 「我只是報任務完成 + 提供選項，沒宣告 session 結束」 | 報「batch 完成」+ 給收尾選項（清 worktree / follow-up / 停）就是 completion-語意；Recap 是 always-on 收尾 Gate，不因「只是選項」豁免。merge 批次告一段落即觸發。 |

## Verification

- `node .devpro/scripts/recap-body-template-check.mjs --body-file <path>`
- `gh api graphql` 查詢固定 target 與 Discussion category；失敗依 Fallback 排解。
