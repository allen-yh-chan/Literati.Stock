---
name: platform-adapter-claude-code
description: "Claude Code：風險型差異（注入、hook、委派）。觸發：CLI 實作、`/devpro:*` skill 或 `dp-*` agent 前；不綁特定版本。"
---

# Platform Adapter：Claude Code

## Overview

先讀 `platform-adapter-contract.md`，再讀本檔。
風險軸與觸發時機已摘要於檔首 `description`；可執行細節以本文 **Process** 為準。CLI／hook／委派隨設定與沙箱變動，以 **探測 + 自報** 為準、不寫死能力表。

## When to Use

- 在 Claude Code CLI 跑實作、`/devpro:*` skill、或啟用 repo hooks 時

## Process

GitHub 操作前先讀 `tool-selection.md`，遵循 local gh 優先、受驗證 devpro-work MCP 備援及不確定時停止的規則。

### 風險 A：把「已注入」誤當「已遵守」

- **觸發**：系統提示看似已含規範。
- **行為**：仍逐條執行 Gate 與 Ask First；footer 必附。
- **禁止**：用「有規範在上下文」跳過確認問句唯一輸出規則（見 `ai-autonomy.md`）。

### 風險 B：hook 與規範雙軌

- **觸發**：`.devpro/scripts/hooks/` 存在且可能攔截/改寫行為。
- **行為**：把 hook 當 **加速層**；hook 失效時仍必須可只靠 leaf 執行（見 `rule-design-principles.md` Hook-Independent）。
- **Enforcement boundary**：hook 可提供機械 backstop；hook 不可用時是 hook-independent leaf + TL process 的 `cooperative-only` enforcement，不得宣稱 hook 已代替人工 gate。
- **release back-merge completion gate**：機制（pre-push 記錄 ＋ PostToolUse 綁定 ＋ Stop 阻擋）；前提與放行不等於完成見 `release-step-1-7.md` Step 6A。
- **禁止**：「hook 會擋所以我不檢查」。

### 風險 C：委派不可用

- **觸發**：Task/subagent 無法啟用或失敗。
- **行為**：走 `openspec-flow-fallback.md` / `code-review-checklist-fallback.md` 等 fallback；**禁止**用不可用跳過 mandatory gate。
- **Enforcement boundary**：fallback 是否被採用由 TL process 與 cross-review evidence 守；可用的機械 guard 是相關 leaf/test anchor，非 Claude Code hook 自動證明。

### 風險 D：hook cwd visibility 不可假設

- **觸發**：在 worktree 內執行 `git add` / `git commit` / `git restore` / `git rm` 等 git write command，且 repo hooks 可能啟用。
- **行為**：Claude Code 可透過 hook payload / shell cwd 傳遞 cwd，但仍須先留下 `pwd` + `git rev-parse --abbrev-ref HEAD` + `git status --short --branch` 證據；若 hook block reason 顯示 protected branch 與實際 worktree 不符，worktree **git** 補救以 **預設／優先** `git -C <abs-worktree> ...` 重跑（含 read-only git 查詢作 cwd/branch evidence）。`cd <abs-worktree> && ...` 僅為**非 git、單一指令**的**次要**形狀；勿把 `cd <dir> && git ...` 當 Claude Code 常規 git 路徑。Claude Code Bash auto-mode 可能對 `cd <dir> && git ...` 施加**分類器摩擦**（發生在 PreToolUse 之前）；**分類器摩擦 ≠ hook cwd visibility**（與 hook 邏輯無關）——hook 仍可把合法 `cd` 前綴當 hook-visible evidence，勿解讀成 PreToolUse 拒 `cd`。worktree git 寫入一律用 `git -C <abs-worktree>` 單一形，且 `git add` 與 `git commit` MUST 分兩次 Bash 呼叫（同一 payload 串 add＋commit 會讓 commit-time EOF re-stage gate 落入 `checked=false`）。
- **禁止**：把 hook 當成一定知道 UI/agent workdir；不得因「hook 會擋」就跳過分支/cwd 證據。

### Session cwd：worktree 為預設實務（非 admission gate）

- **觸發**：`/devpro:change` 建好 `.worktree/<change_id>` 後，後續 Agent／admission 的 binding 由何決定。
- **行為**：worktree 內工作仍是預設實務，但 **session cwd 對齊不是 admission gate 條件**：離開 worktree 的 session 派 `dp-*` 時，以唯讀 helper 預解析 `change_id`＋`execution_root`（`node .devpro/scripts/resolve-admission-binding.mjs <change_id> --cwd <session-cwd> --json`；宣告路徑全 role 必帶 `execution_root`，缺 → `execution-root-required`），binding 由同 common-dir exact-one `.worktree/<change_id>` 決定、record 落該 worktree；宣告路徑為全 host 一等公民，與其他 host 同一 resolver 與同一封閉碼群。Claude Code 具名 `EnterWorktree`（必要時先 `ExitWorktree`）仍是可選的執行面優選，非唯一合法路徑。
- **禁止**：把 `EnterWorktree`／「另開 rooted session」當 admission 前提或把載體變更敘述成 enforcement 降級；宣告 id 僅 lookup key，非合規證據。review／verify 無 binding 仍 `change-worktree-required` fail closed。尚無 change 的 audit-only 審查（方向／設計確認）不派 `dp-second-reviewer` subagent，由 TL 直接執行 renderer-owned runner；不得為了過 gate 建立空 worktree。

### 風險 E：subagent 併發／巢狀設定（本 repo 不設 user-local 值）

- **現況**：本 repo 不再建議、檢查或回報 user-local `~/.claude/settings.json` 的 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`／`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`（session-start 不再有 Runtime consent 區段）。兩者仍是官方 env，使用者可自行設定，屬使用者選擇、非本 repo 規範。
- **fork**：`CLAUDE_CODE_FORK_SUBAGENT` 不由本 repo 管理：fork mode 維持 runtime 預設，fork 管制落在 hook admission（`subagent_type: "fork"` MUST 附 `fork_reason:`＋六欄 admission record，否則 block）。使用者若自行設 `CLAUDE_CODE_FORK_SUBAGENT="0"`，所有 session 子代預設 foreground、`fork` type 不可用。
- **未設定時**：保留 cooperative 控制並記 configuration gap；不豁免 outcome gate；不宣稱任何 token 節省。同時 active 上限對 Claude 只是 cooperative 承諾（官方：resume 不檢查、`/subtask` 不受阻、ultracode 豁免）。
- **禁止**：TL 靜默改寫 user-local 設定。
- **三種 dispatch 形狀與同時 active 上限**：fresh（具名 `dp-*`，六欄 admission record、`role_binding: host-verified`）／continue（`SendMessage`，經 gate；宣告 opt-in by carrier，宣告後六欄＋`parent_record_id` 強制）／fork（`subagent_type: "fork"`＋`fork_reason:`＋六欄）分述於 `platform-adapters/claude-code-capabilities.md` §Subagent Context Admission；session cwd 非 `.worktree/<change_id>` 時三形狀共用宣告路徑（conditional `change_id`＋`execution_root`，helper 預解析）；「同時 active ≤2」為 cooperative 承諾（`model-delegation-threads-and-caps.md`；本 repo 不設 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）。

### 風險 F：auto mode 分類器擋下與關鍵指令串接

- **觸發**：Claude Code Bash auto mode 的分類器（發生在 PreToolUse 之前，與 repo hook 無關）擋下某個 Bash call。實測形狀：`gh pr merge` 串在 `cd` 與後續 `gh pr view` 之間被以 `Merge Without Review` 擋下；merge 後串了 fetch／log／merge-base 的唯讀驗證 call 也被擋；單獨的 `gh pr view` 或 `git fetch origin main` 則通過。
- **行為（擋下即停手）**：被分類器擋下後立即停止同一目標並交回使用者，附停下交棒（為何停／要使用者做什麼／回了會怎樣）；連續被擋累積到 Claude Code 的門檻會暫停 auto mode，門檻以官方為準、本規範不寫死。
- **行為（關鍵指令單獨一個 call）**：`gh pr merge`、`git push`、runner（`run-test-suite.mjs`）這類關鍵指令各自單獨一個 Bash call，不與 `cd`／`pwd`／`| tail` 或後續查詢串接；`pwd && git rev-parse` 預檢另開一個 call。
- **行為（照 gate 訊息做）**：PR／comment 的 body file 先以獨立 call（或 Write 工具）寫入，再以字面絕對路徑執行 `gh`；admission record 的自由文字欄位（`evidence_scope`／`return_and_stop`／`fork_reason`）寫 repo-relative 且去識別的內容，含使用者 home 絕對路徑或非白名單 email 會被擋為 `admission-record-unsafe-value`（`execution_root` 是例外，必須是絕對路徑）；預期大量輸出的指令走 `capture-command.mjs`。
- **備援**：Ready Response 的「是，授權 AI merge」選項在 auto mode 下可能被分類器擋；被擋時依上述停手交回，由使用者以 `!` 前綴自行執行（例如 `! gh pr merge 123 --repo github.com/OWNER/REPO --merge`）。
- **Enforcement boundary**：`cooperative-only`——分類器是 Claude Code 的 auto mode 判斷，不在本 repo 的 hook 路徑上，沒有機械 backstop；分類器擋下不是 hook 或 gate 失敗，不得記成 hook 缺陷。
- **禁止**：被擋後換寫法重試同一個 merge／push（含拆成多步、改用別的指令繞過）；把一串動作塞進單一 call 以省一次往返。

### 風險 G：worktree 隔離 session 擋 main checkout 的 `git -C`

- **觸發**：session 隔離在 linked worktree（例：以 `EnterWorktree` 進入）時，Claude Code 可能擋下以 `git -C <main-checkout-root>` 指向共用 main checkout 的 git 指令。實測：PR #3382 merge 後的 `git -C <main-checkout-root> pull --ff-only origin main` 被擋；唯讀查詢（`log`／`show`）不一定被擋，不能拿來推斷 `pull` 會過。merge 後的 Post-merge Local Sync 與 Recap 的 Lint 前同步都用這個形狀。
- **行為**：照 `git-workflow-tracking.md` §Post-merge Local Sync 的「host 擋下」段交棒：請使用者以 `!` 前綴執行同步與 status verification（路徑換成 `git worktree list` 第一列的實際值），或改在 main checkout 的 session 執行；拿到輸出才算同步完成。
- **Enforcement boundary**：`cooperative-only`——擋下來自 session 隔離，不在 repo hook 路徑上；main 未同步時 `post-merge-check.mjs` Stop hook 仍會在 turn 結束提醒。
- **禁止**：宣稱已同步或略過同步；改在 worktree 分支 pull main、`cd` 進 main checkout 或換寫法繞過。

### 能力真值

- 以 `platform-adapter-contract.md` 四探測更新 `RuntimeCaps`；不自假設「一定全 yes」。

### TL Model 設定

Shared rule 使用 `model-delegation.md` 的 tier 詞彙；本 adapter 才寫 Claude Code 具體 selector。

| shared tier | Claude Code selector | 典型用途 |
|---|---|---|
| 高推理層 | `opus` | TL、需求分析、架構設計、六軸審查、RCA |
| 中執行層 | `sonnet` | 實作、測試、結構化執行、預算敏感長 session |
| 低機械層 | `haiku` | 快速讀檔、grep 摘要、低風險 fan-out 探索 |

設定方式：互動 session 用 `/model <selector>`；多 terminal 同時跑不同 tier 時，用啟動參數 `claude --model <selector>`。TL 推理層的解析階梯、能力下限與重新解析訊號見 `model-delegation-delegation-rules.md` §TL Tier Floor（shared 條文，本 adapter 不複寫）。

> _Anchor: 截至 2026-05 Claude Code model configuration docs，`/model` 可切換 model，`--model` 可於啟動時指定；`opus` / `sonnet` / `haiku` aliases 會解析到帳號可用的最新版本，且高推理層可能因 usage threshold fallback 到中執行層。_

### Token-Frugal Rule Loading

Claude Code session MUST 依 `token-frugal-io.md` § Rule Loading Scope Order 載入規範（AGENTS.md → active adapter → trigger leaf only，禁 eager-load 整包），並套 § Exploratory Search Gate 的 Forbidden-path default（預設不掃 `openspec/changes/archive` 與 `.worktree/*`）。

Local auto-compact: the `devpro:change` startup common environment entry may prompt to set `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` when the `claude` CLI is installed and the setting is missing or not equal to that recommended pair. Raw `sync-agent-rules.mjs --sync` / `--check` do not run this user-local check. Supported bash/zsh rc and Windows PowerShell profile writes require consent; unsupported shells fail open.

### Load-chain：能力清單 / Cross-Review

- 能力清單（Load-Plan / Syntax Validation / Cross-Review Reminder / User-Invocable / Cache-Friendly / Reasoning Depth）細節按需載入 `platform-adapters/claude-code-capabilities.md`；`devpro:load-plan` 或需核對某項 capability support 狀態時才讀。
- Claude Code CLI 當 external second reviewer 的完整契約按需載入 `platform-adapters/claude-code-cross-review.md`；`devpro:cross-review`、`devpro:pre-pr` cross-review step、reviewer agent、或 adapter 路由到外部 Claude reviewer CLI 時才讀。不得由 AGENTS trigger index eager-load 這兩個 sibling。

### Per-Session Usage Telemetry

**Support**: fully implemented。細節與 anchor date 見 `platform-adapters/claude-code-capabilities.md`。

## Rigor Level（DEVPRO_AGENT_RULES_LEVEL）

本 runtime 讀取與其他 runtime 相同的旗標 `DEVPRO_AGENT_RULES_LEVEL`（值 `full|lite|off`，預設 `lite`）及相同的 consumer `.devpro/rules.config`，precedence 一致（env > config > 內建 lite）。禁止使用任何 runtime-specific 旗標別名。以 shell 環境變數設定：互動 session 啟動前 `export DEVPRO_AGENT_RULES_LEVEL=lite`，或於 Claude Code 設定檔的 `env` 區塊注入。詳見 `rules-rigor-level.md`。

## Exit Criteria

- 已讀 `platform-adapter-contract.md` + 本檔
- hook 目錄若存在：已知本次是否可能觸發相關 hook（不需要背檔名，但要守「不雙軌」原則）
- git write command 在 worktree 內執行時，已有 hook-visible cwd evidence 或已記錄不適用原因
- `gh pr merge`、`git push`、runner 以單獨一個 Bash call 執行；被 auto mode 分類器擋下時已停手交回，沒有換寫法重試（§風險 F）
- merge 後同步的 `git -C <main-checkout-root>` 被 worktree 隔離 session 擋下時，已交棒請使用者以 `!` 執行，拿到輸出才宣稱同步（§風險 G）
- footer 每回合附帶

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「能力齊全所以不用探測」 | 齊全是假設；探測成本低、漂移成本高 |
| 「subagent 失敗就先 merge」 | 失敗走 fallback，不是跳 gate |
| 「Claude Code hook 會知道我在哪個 worktree」 | hook cwd/payload 仍是 runtime 行為；先留 cwd/branch 證據，不符時 worktree git **預設／優先** `git -C <abs-worktree>`；`cd&&` 僅**非 git**次要。Bash auto-mode **分類器摩擦** ≠ hook cwd visibility |
| 「使用者已授權 AI merge，把 merge 和驗證串成一個 call 比較快」 | 關鍵指令單獨一個 Bash call；被分類器擋下就停手交回，由使用者以 `!` 前綴自行執行，不換寫法重試（§風險 F）。分類器擋下 ≠ hook 或 gate 失敗 |

## Verification

```bash
rg -n "風險 A|風險 B|風險 C|風險 D|風險 F|RuntimeCaps|TL Model 設定|hook-visible cwd evidence|git -C|Token-Frugal Rule Loading|預設／優先|分類器摩擦|非 git" .devpro/agent-rules/platform-adapters/claude-code.md
```
