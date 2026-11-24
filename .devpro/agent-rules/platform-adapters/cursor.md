---
name: platform-adapter-cursor
description: "Cursor：風險型差異（快迭代、長上下文、Pilot）。觸發：Cursor 內實作或 devpro:* skill 前；不綁特定版本。"
---

# Platform Adapter：Cursor

## Overview

先讀 `platform-adapter-contract.md`，再讀本檔。
本檔只處理 Cursor 特有風險，**不重寫** `AGENTS.md` 與 leaf rules。所有流程判斷一律回到 `AGENTS.md` 的觸發式載入索引。

## When to Use

- 在 Cursor 內要改碼、跑流程、或接到 `devpro:*` skill 時

## Process

### 1) AGENTS 路由優先（每一步都先找對 leaf）

- **觸發**：任何要執行下一步（建分支、改檔、commit/push、release、收尾）前。
- **行為**：
  1. 先 `Read` 根目錄 `AGENTS.md`；
  2. 依「觸發式載入索引」定位本步驟對應 leaf（例如分支→`git-branch-naming-and-anchor.md`、流程→`openspec-flow.md`、分類→`chore-classification.md`、收尾→`ai-autonomy.md`）；
  3. 只依該 leaf 執行，不在本檔複製規則本體。
- **禁止**：用本檔替代 `AGENTS.md` 索引決策；或憑記憶跳過 leaf 讀取。

### 2) Cursor 風險：Session/工作樹偏移

- **觸發**：即將第一次改檔前。
- **行為**：按 `git-branch-naming-and-anchor.md` 先確認 work branch/worktree；若在穩定分支工作樹，停下回問。
- **禁止**：沿用編輯器當前 checkout 直接改檔。

### 3) Cursor 風險：Hook 可用性不確定

- **觸發**：改檔路徑不一定會進 Cursor hooks runtime（例如非 IDE 路徑）。
- **行為**：視為 `preToolUse` 不可證明可用，採 fail-closed：先通過分支/worktree gate 才能改檔。
- **禁止**：僅以 `.cursor/hooks.json` 存在就推定本次一定被攔截。
- **release back-merge completion gate**：只靠文字（無 `postToolUse`，`stop` 登記僅為對齊用 no-op）；規則見 `release-step-1-7.md` Step 6A。

### 3b) Cursor 風險：Shell tool 必須掛載 shell gates

- **觸發**：在 Cursor 內用 agent **Shell** tool 執行 `gh pr merge`、git write、或其他 shell gate 覆蓋面命令。
- **行為**：`.cursor/hooks.json` 的 shell PreToolUse matcher **MUST** 含 `Shell`（與 `Bash` 並列），讓 `pre-tool-gate.mjs` / `gh-footer-gate.mjs` 能攔截 cross-model merge gate；`isShellCommandToolName()` 已認 `Shell`，但 matcher 漏掛會讓 gate 完全 bypass（2026-08 batch 根因）。
- **禁止**：只 match `Bash` 就假設 Cursor agent 的 `gh pr merge` 已被 cross-model sticky gate 驗證。

### 3c) Cursor 風險：Stop hook 沒有 timeout

- **觸發**：`.cursor/hooks.json` 的 `stop` 條目（`recap-check`、`session-pending-cleanup-check`、`post-merge-check`、`post-pr-completion-check`、`release-back-merge-check`、`stop-handoff-cite`）都沒有 `timeout` 欄位，Cursor 文件未載明預設逾時。
- **行為**：Stop hook 的擋下或提醒訊息（例如 R8）在 Cursor 的送達沒有保證，不得把它當成 Cursor 上一定送達的信號；需要保證的義務（Post-merge Local Sync、Post-PR completion 等）仍由規範與 AI 在同一輪自行執行，Stop hook 只是 backstop。
- **為什麼不補 `timeout`**：補上會經 `sync-agent-rules.mjs` 同步給每個 consumer，而目前沒有 Cursor 文件或實測證據顯示缺它造成實際問題；因此記為已知限制、不改設定。之後若有實測證據才補，屬 Ask First（影響 consumer 同步）。

### 4) Cursor 風險：hook cwd visibility 不可假設

- **觸發**：在 Cursor 內對 worktree 執行 git write command，且 `.cursor/hooks.json` 可能啟用。
- **行為**：先留下 `pwd`、`git rev-parse --abbrev-ref HEAD`、`git status --short --branch`。若 hook 可用性或 cwd visibility 不可證明，git write command 必須帶 hook-visible cwd evidence：`git -C <abs-worktree> ...`（唯一建議的 git write 形；帶 `cd` 前綴的寫法不再建議），且 `git add` 與 `git commit` 分兩次 Bash 呼叫。
- **禁止**：假設 Cursor UI 目前檔案或 terminal workdir 會被 hook payload 正確接收。

### 5) Cursor 風險：move_agent_to_root 會改 checkout

- **觸發**：即將呼叫 `cursor-app-control.move_agent_to_root`（或等價換 session root）、或同一 round 呼叫 `SetActiveBranch` **之前**；以及換 root 之後、任何 repo write 之前。
- **行為**：
  1. MUST NOT 把 `move_agent_to_root` 當成只換 IDE root、不改 checkout。該工具對目的地跑 `git fetch origin <session-branch>` 並 checkout；local-only 新分支尤其危險。
  2. MUST NOT 與 `SetActiveBranch` 並行。先完成 worktree add 與 `cd`／`git -C` 身份證據，再（若需要）序列呼叫 `SetActiveBranch`；不要同一 round 並行 MCP 換 root。
  3. 換 root 之後、repo write 之前：`git -C <dest> rev-parse --abbrev-ref HEAD` 必須等於意圖分支；`git worktree list` 確認沒有把別棵樹的分支偷走。不符先 `git switch` 回意圖分支，再寫檔。
  4. 意圖分支尚未 push 時，預設不要呼叫 `move_agent_to_root`（fetch 失敗或錯切上一把遠端分支）。改用 `git -C <abs-worktree>` 或 `working_directory`。
- **禁止**：假設新 worktree HEAD 仍是 `git worktree add -b` 剛建的分支。

### 5b) Cursor degraded worktree path（一等公民；泛化為全 host 宣告路徑）

- **通用契約（全 host；design D9.2）**：session cwd 非 `.worktree/<change_id>` 時，宣告路徑為一等公民——同一 resolver（`resolveAdmissionBinding`）與同一封閉碼群決定同 common-dir exact-one `.worktree/<change_id>`；六欄之外帶 conditional `change_id`（A2；A1／A3 替代來源，讀序 A2＞A1＞A3）與全 role `execution_root`（唯讀 helper `resolve-admission-binding.mjs` 預解析；缺 → `execution-root-required`、realpath 不符 → `execution-root-mismatch`），binding 由檔案系統 exact-one 決定，`head_sha`／`admission-records/` 落該 worktree。環境儀式（`move_agent_to_root`、`EnterWorktree`、另開 rooted session、OpenCode `session_move`）**不是** gate 條件；任一 host 不得因 hook 表面不同被寫成較弱的 binding 路徑。下列 Cursor 具體行為是本通用契約的特例（成功 move 仍為優選、非唯一）。
- **觸發**：`move_agent_to_root` **失敗**（或產品無法切入 linked worktree／local-only 未 push 預設停用切換）時；父 Cursor session MAY 留在 primary／main。
- **術語**：
  - **binding root**：admission／`change_id`／`head_sha` 所選的 exact-one `.worktree/<change_id>`（同 common-dir；lookup key 為 verified changeId——讀序 A2 `change_id`＞A1 trusted `responsibility_id`（closed duty-prefix strip，禁 whole-id／bare duty 名）＞A3 `evidence_scope`／`return_and_stop` 段（僅在 cwd 未解出 id 且 A2／A1 皆缺時單獨成立）；禁無任何可解宣告的全域任意 exact-one；宣告 id 僅 lookup key、非合規證據）。
  - **execution root**：實際讀寫／`git -C`／工具材料根——MUST 為該 worktree **絕對路徑**；父 session root MAY 仍為 primary。**binding root ≠ execution root**。
- **行為**：
  1. 嘗試／評估 `move_agent_to_root`（仍受 §5 checkout 安全約束）；**成功仍為優選**，但**非唯一**合法路徑。
  2. 失敗 → **一等公民宣告路徑**（Cursor degraded 為其特例）：以宣告解析（A2＞A1＞A3）→ exact-one binding；執行材料用 `.worktree/<change_id>` 絕對路徑＋`git -C`／`working_directory`（execution／hook-visible cwd 輔助，**不是** binding 權威）。
  3. MUST NOT 把「另開／再開第二個 Cursor」或「另開已根於 `.worktree/<change_id>` 的 session」寫成預設解或主路徑。
  4. MAY 保留一句：**最後手段／non-default**——使用者自選可另開已根於 worktree 的 session（明確標 last resort）。
  5. 宣告路徑（含 Cursor degraded 特例）MUST NOT 宣稱「Task 真在 worktree 執行」或等價 forge-false-runtime-agent；host-verified admission 只證明 role／responsibility／binding HEAD／dispatch。
- **review severity 指向**：degraded worktree binding 閘的治理對象為 `branch-and-worktree-placement`（class one，`design-core.md` §11）；其 adversarial bypass narrative（含以 `responsibility_id` 等 prompt 欄位可偽造為唯一依據）is at most a Suggestion，MUST NOT 因對抗性輸入單獨升 Critical；gates and reviews guard against the AI's accidental mistakes in normal work, not deliberate forgery or deliberate bypass (design-core §11 principle), and class-two objects are the only exception and stay adversarial：on a class-one object, a wrong record that normal work would accidentally produce and the gate fails to block remains CRITICAL, while a forgery only a deliberate act produces is outside the threat model and MUST NOT be raised to WARN or CRITICAL, and a form reachable only through deliberate obfuscation is at most a Suggestion；on a class-two object, attribution footer included, a forgery the AI can produce with an ordinary command remains CRITICAL when the gate fails to block it（普通指令＝a form the AI would naturally produce in normal work）；對稱：a class-one gate blocking an ordinary command the current rules already allow is equally a defect（例示、允許性判定與代發核准歸屬見 `code-review-cross-model.md`）。One closed, user-ruled residual exception applies (design-core §11 `batch-scope-record-residual`): a batch scope record — the full `## Batch Approval Ledger` or the lite `lite-scope.md` line — is written by the AI after the user picks batch and no gate can prove the user picked batch, and that structural residual alone is at most INFO and MUST NOT be raised to WARN or CRITICAL; that INFO limit is this exception's own and does not depend on class-one membership or on whether the governance-object class is determinable from this packet; it covers only those two carriers and only that residual: when review material shows the user chose stepwise or had not answered, or the record predates the answer, it is a forgery judged by F-9; sticky, footer, PR body notice line, review receipt, and every other compliance record stay under F-9 unchanged; the exception has no force in a review whose diff adds, removes, or rewords the exception text itself (an unchanged exception sentence that merely sits on an edited line does not count), and the record is then judged by F-9 as if the exception did not exist; B5/B8 full text: see `code-review-cross-model.md`. A governance object listed in neither §11 table is classified by its nature: one that protects product security or compliance output is class two and MUST NOT receive this ceiling; any other AI-process-adherence object is class one, and whoever claims class two must name the protected output. General clause `consent-record-residual` (design-core §11): a consent record the AI writes after the user answers, checked by a gate when used, carries the residual that no gate can prove the user really answered, at most INFO and never WARN or CRITICAL (full text: see `code-review-cross-model.md`). Per-PR waiver records: `per-pr-waiver-record-residual` caps the `skipped per user decision:` residual at INFO only while the open-PR checks compare the line with the answer-time record, otherwise F-9 applies (full text: see `code-review-cross-model.md`).
- **禁止**：env／prompt／notes 手寫 absolute path 當 binding／`head_sha` 權威；宣告不可解時用無 scope 的全域任意 exact-one 挑樹。

### Load-Plan Capability

**Support**: partial support, Cursor Rules panel is UI-driven and may not expose a machine-readable manifest. Use visible active rules / project instructions when available; fallback is manual read of AGENTS.md trigger index and `.cursor/rules/` entries.

### Edit-Time Syntax Validation

**Support**: partial support, Cursor config currently has no `postToolUse` event and the shared test suite treats that as an architectural gap. The shared `.devpro/scripts/hooks/post-tool-gate.mjs` validation logic can be reused only after an equivalent after-edit hook event is officially verified and registered. Fallback: manually run `bash -n`, `node --check`, JSON parse, or `python3 -m py_compile` for edited files before claiming syntax-clean status.

### Pre-commit Cross-Review Reminder

**Support**: partial support, manual register。共用 hook 為 `.devpro/scripts/hooks/commit-soft-nudge.mjs`，但 `.cursor/hooks.json` 尚未註冊；需先確認 Cursor `preToolUse` schema 與 cwd visibility，再加等價 Bash entry。Fallback：`git commit` 前手動判斷 cross-review 豁免並視需要跑 `/cross-review`。

### User-Invocable Command/Skill Capability

**Support**: partial support, `.cursor/rules/*.mdc` is glob-scoped / context-scoped rather than a user-invocable command form. Cursor users can trigger behavior by prompt intent plus active rules; fallback is manual AGENTS.md trigger-index routing and explicit leaf-rule reads.

First-party skills 經 `.agents/skills/devpro` 被發現，id 為裸名（取自含 `SKILL.md` 的目錄名，無 `devpro:` 前綴）：叫用形 `/<name>`（例：`/cross-review`），亦可由 prompt intent 自動路由。限制：CLI Skills 選單只掃 discovery root 下一層，不列出個別 devpro skill；`/` 自動完成清單未驗證。缺選單項目不影響叫用。

### Cache-Friendly Design Metric

**Support**: partial support, Cursor pricing/usage docs expose cached-input cost and usage breakdowns, but this repo has no machine-readable per-request cache-read field. Verification path: inspect Cursor dashboard usage breakdown for cached input; if the active plan/UI omits it, report cache metric unavailable and rely on stable-prefix / deferred-loading design.

### Reasoning Depth Control

**Support**: partial support, Cursor exposes model selection through UI/settings but this repo has no verified reasoning-effort flag. Mapping heuristic 未驗證：fast/default model for small edits and tests; strongest visible reasoning model for proposal, RCA, architecture, review, or security-sensitive work. If UI hides selector, report unavailable rather than inventing a tier. Shared effort rank 與 TL Effort Floor 見 `model-delegation-delegation-rules.md` §TL Effort Floor。本 runtime 無 verified／repo-stable selector → 解析為 `unavailable`；宣告 `reasoning-depth unavailable`（既有字面），MUST NOT 發明 selector。

### Per-Session Usage Telemetry

**Support**: not applicable, Recap 記 source: N/A: host does not expose usage data

### Native Subagent Capability

**Support**: official native support with live-probe caveats. Cursor supports project custom subagents under `.cursor/agents/*.md` and user/global custom subagents under `~/.cursor/agents/`. Devpro dp-* Cursor files are runtime projections only: `.devpro/agent-rules/model-delegation.md`, `.devpro/agent-rules/multi-agent-handoff.md`, and `.claude/agents/dp-*.md` remain the role SSOT.

> _Anchor: 截至 2026-06 Cursor docs `https://cursor.com/docs/subagents` document `.cursor/agents/`, YAML frontmatter (`name`, `description`, `model`, `read_only`, `is_background`), automatic/explicit delegation, parallel execution, background output under `~/.cursor/subagents/`, MCP inheritance, and Cursor 2.5 nested child subagents. Cursor 2.4 changelog (`https://cursor.com/changelog/2-4`) announces subagents as independent agents with own context, parallel execution, custom prompts, tool access, and models._

**Live probe before relying on native delegation**:

1. Confirm the active Cursor mode exposes `Task` / subagent invocation for the requested run.
2. Confirm `.cursor/agents/dp-*.md` are visible in the current project context.
3. Confirm `read_only: true` projections cannot edit files or run state-changing shell commands in the current policy mode.
4. Confirm hooks/tool policies do not block nested subagent launches when nested delegation is required.
5. If any check fails or is unavailable, mark `subagent=no` or `subagent=constrained` and execute the same gate through `platform-adapter-contract.md` Mandatory Role Fallback Mapping.

### Cursor-first Pilot（可選但建議）

- **目的**：用同一套 scenario 收集 VT-*，把「高頻偏移」回寫到本檔與契約（不靠一次性盤點版本）。
- **記錄**：每次違規仍用固定欄位（場景／規則／預期／實際／修補）；週回顧只看統計，不追版本號。

### 強制回問（觸發即停）

1. 在 `production`、`main`/`master`（或同等穩定分支）工作樹上、無合規 work branch／worktree 卻要實作
2. 本步驟尚未按 `AGENTS.md` 索引讀到對應 leaf 規範
3. 改檔前無法證明本次路徑會觸發 `preToolUse`，且仍想在穩定分支工作樹寫入
4. 可能踩 Never 但不確定安全性
5. git write command 目標 worktree 無法以 hook-visible cwd evidence 證明

## Rigor Level（DEVPRO_AGENT_RULES_LEVEL）

本 runtime 讀取與其他 runtime 相同的旗標 `DEVPRO_AGENT_RULES_LEVEL`（值 `full|lite|off`，預設 `lite`）及相同的 consumer `.devpro/rules.config`，precedence 一致（env > config > 內建 lite）。禁止使用任何 runtime-specific 旗標別名。以 shell 環境變數設定：在終端機執行 `export DEVPRO_AGENT_RULES_LEVEL=lite` 後啟動 Cursor，或於 Cursor terminal 環境內設定。詳見 `rules-rigor-level.md`。

## Exit Criteria

- 已讀 `platform-adapter-contract.md` + 本檔
- 本次 session 每個關鍵步驟均可追溯到 `AGENTS.md` 索引對應 leaf
- 改檔前已確認分支／worktree 符合 `git-branch-naming-and-anchor.md`
- 非 IDE 路徑或 hook 可用性不明時，已採 Hook 可用性 fail-closed
- git write command 在 worktree 內執行時，已有 hook-visible cwd evidence 或已記錄不適用原因
- 無「用本檔取代 AGENTS/leaf 規範」情況

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「我記得規範，不用每步都讀 leaf」 | 記憶不是證據；本步驟仍須按 AGENTS 索引讀對應 leaf |
| 「本檔都寫了，照本檔就好」 | 本檔是 adapter 差異，不是總規範副本；權威仍是 AGENTS + leaf |
| 「有 hooks 設定就一定能擋」 | hook 可用性不可證明時要 fail-closed，不得假設已攔截 |
| 「Cursor terminal 在 worktree，所以 hook 一定知道」 | hook cwd visibility 需證據；git write 一律用 `git -C <abs-worktree>`（唯一建議形，`cd` 前綴不再建議），`git add` 與 `git commit` 分兩次呼叫 |
| 「只是換 Cursor root，HEAD 不會動」 | `move_agent_to_root` 會改目的地 checkout；換 root 後先核對 HEAD 與 `git worktree list` |

## Verification

```bash
rg -n "AGENTS|索引|leaf|worktree|Hook 可用性|fail-closed|hook-visible cwd evidence|git -C|強制回問|move_agent_to_root|SetActiveBranch|Turn-end Ledger-First|owner=AI|commit\\+PR" .devpro/agent-rules/platform-adapters/cursor.md
```

---

### Risk: AI tool grep hallucination

> 本段為 Cursor 特定 risk；通用規範 `pr-review-evidence-verification.md` 保留泛化 idiom（contributor 聲明遠端 ref 須機械驗證），具體 PR #222 hallucination 案例與重現命令在此。

Cursor 在 review thread 回覆「phrase 已存在 / contract 保留」要視為 **hypothesis**。必先機械驗證遠端 ref——本機 grep / Cursor 聲明都不算 evidence（PR #222 round 4 真實案例：Cursor hallucinated grep 結果）。

**Process**：① `git fetch origin <branch>` → ② 取 head SHA → ③ `git show <sha>:<path> | grep -n <phrase>` → ④ 比對：不一致 → reply 附完整重現命令 + 自己輸出；不軟化結論。

#### Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「我對著最新 head grep 過」 | Cursor 會 hallucinate grep 結果（PR #222 round 4）。輸出 ≠ 機械 evidence。|
| 「本機 grep 也找到了」 | Source of truth 是 `git show <remote-sha>:<path>`，不是本機 worktree。|

```bash
git fetch origin <branch>
SHA=$(gh pr view <N> --json headRefOid --jq '.headRefOid')
git show $SHA:<path> | grep -n '<phrase>'
```

---

### Hook availability uncertainty

> 本段為 Cursor 特定風險：Cursor hook event API 與 Claude / Codex 不同名，且公開資料較弱。通用規範 `rules-flow.md` / `openspec-flow/spec.md` 保留泛化原則（修改 hook 設定前查 runtime 官方來源），Cursor 特定 6 點檢查在此。

改 `.cursor/hooks.json` 的 hook 設定會 propagate 到 consumer。修改前**必須**確認以下 6 點：

1. **Hook 腳本路徑必在 SYNC_DIRS**（`.devpro/`、`.codex/`、`.cursor/`、`.github/`；見 `sync-agent-rules.mjs`）。不在 SYNC_DIRS → consumer 拉不到檔案，gate 失效且**不報錯**。
2. **理解 hooks 整批替換語意**：對 `hooks.<EventName>` 為 per-event-type 整批替換（非 deep merge）。consumer 同 event custom hooks 會被覆蓋；PR description 必須明示受影響 events。
3. **Cross-platform wrapper 強制格式**：hook command 必為 cwd-proof inline launcher（`node -e "<root-walk spawnSync>" <EventName> .devpro/scripts/hooks/<x>.mjs`）。禁 `test -f`、`[ -f`、`find`、裸相對路徑；launcher 內的 `spawnSync` 以 `cwd:root` 呼叫 wrapper 屬允許用途（非 runtime-specific command）。
4. **Sync gate 在 PR 前跑**：建 tmp consumer dir 後跑 `--sync` + `--check`，兩步均 exit 0 才能建 PR。
5. **PR description 標 `[SETTINGS-CHANGE]`**：PR title 或 body summary 列受影響 event types。
6. **Cursor hook 查官方來源**：Cursor hook event 名稱與 Claude / Codex **不一定同名**，且公開資料較弱。改 `.cursor/hooks.json` 前必查 Cursor docs / Marketplace / changelog（per `openspec-flow/spec.md` Cross-Runtime Hook Wrapper Pattern Requirement——runtime 特定來源即 Cursor Marketplace metadata）；PR body 記錄查證日期與採用 event。查無官方來源 → fail closed。

---

### Pilot operations

> 本段為 Cursor 平台 pilot 操作細節；通用規範 `multi-agent-handoff.md` 範例採泛例（`[agent:assistant]`），Cursor 為當前 pilot adapter 的具體操作手冊在此。

Cursor 是當前 pilot adapter，使用 `[agent:cursor]` 標記任務（狀態機與 `multi-agent-handoff.md` 共用）。若本次 live probe 證明 native subagent 可用，可用 `.cursor/agents/dp-*.md` projection 委派；若 `Task` tool、nested launch、`read_only`、model/tool policy 任一受限，改由 TL fallback 承接同一 gate，不得跳過。

**Capability snapshot（Cursor official docs per 2026-06 + local adapter caveat）**：`shell ✓ / file-rw ✓ / git-ops ✓ / spec-flow ~ / review ~ / test-run ✓ / web ✓ / delegate ✓*`。`✓*` = official native subagent surface exists, but Devpro gate execution still requires per-session live probe above; `~` = depends on active Cursor mode, configured tools, hooks, and model policy.

ready 範例：`- [ ] [agent:cursor][status:ready] 實作 GET /api/users endpoint`

handoff 範例：

```markdown
- [ ] [agent:cursor][status:handoff] 實作 GET /api/users endpoint
  - **交接**：改動 `UsersController.cs`、`dotnet test` 全綠、風險：未處理 pagination
```

#### Violation Recap（handoff 時使用）

若有 Core Contract 違規，Cursor **MUST** 在 tasks.md 交接區補充 `[VT-<代號>]` 記錄（場景／觸發規則／預期行為／實際行為／修補提案）。無違規填 `- **Violations**：無`，不得省略。

#### 週回顧統計

Cursor pilot 週回顧時，從 tasks.md 彙整所有 VT-* 記錄進行統計分析（高頻偏移回寫本檔與 `platform-adapter-contract.md`）。

```bash
grep -n 'VT-' tasks.md
```

---

## Cross-Model Second Opinion Adapter

Cursor host 同 Claude Code / Codex — 在 `gh pr create` 成功後（**post-PR**）觸發 cross-model second review；審查結果以 sticky comment 寫回 PR；merge 前 `checkCrossModelMergeGate` fail-closed backstop。

### 角色定位

Cursor 為 chat-based host，使用者可隨時切換 Claude / GPT / Gemini；**無固定 primary model**。本節描述「在 post-PR 觸發 cross-model review 時的對應 flow」。Cursor host 透過 `.cursor/hooks.json` 引用共用 `pre-tool-gate.mjs`，host detection 走 `isCursorRuntime()`（偵測 `CURSOR_TRACE_ID` / `CURSOR_SESSIONID`）；real-runtime env var presence 待 live Cursor session 驗證。

### 雙邊偵測與 Default 順序

| 偵測結果 | 行為 |
|---|---|
| 已知 `primary_family=claude` | 預設使用 Codex/OpenAI-family reviewer（`codex` CLI；packet `reviewer_family=codex`） |
| 已知 `primary_family=openai-codex` | 預設使用 Claude-family reviewer（`claude -p`） |
| 已知 `primary_family=gemini` 或其他非 Claude/非 OpenAI family | 使用 adapter-configured different-family reviewer；`$CROSS_MODEL_REVIEWER` 可明示 |
| `primary_family=unknown` 或 Cursor host 無法從 trusted session metadata 證明 primary | **Dispatch（不停下）**：`reviewer_family=codex`（Codex CLI）；TL MUST NOT 因「我是 Claude 還是 Codex」**在 dispatch 當下**停下要求 manual remap；devpro:change 開頭條件式預選為 sanctioned 前饋（見 devpro:change skill 第零步）。**pr-sticky**：packet `primary_family=unknown`；sticky `reason:` MUST 標 `cross-model-unverified`（若實際 primary 為 OpenAI/Codex-family 則改標 `same-family fallback`）；**MUST NOT** 宣稱 different-family cross-model diversity，**MUST NOT** 為取得 merge-gate cross-model credit 而寫 `primary_family=claude` + `family-alias`。**design gate only**：見下段。禁止 `cursor-composer` 等非 canonical token。`$CROSS_MODEL_REVIEWER` 或 trusted-session 證明 distinct families 後可覆寫 |
| 兩者皆無可用 reviewer CLI | **仍寫 sticky comment** `verdict: UNAVAILABLE` + `reason: no CLI available`（per D9：不得跳過 sticky 寫入；UNAVAILABLE blocked，不是 merge approval） |

**Cursor design-gate default（design-only；非 pr-sticky cross-model credit）**：`## Design-Author Identity` 第一次 persist 時 MUST 使用 `identity: unknown`、`provenance: unknown`（host-unproven；**禁止**假貼 `claude`＋`family-alias`）；對應 design `audit-only` handoff 使用 `primary_family: unknown`、預設 `reviewer_family: codex`（或 ledger／`$CROSS_MODEL_REVIEWER` 預選）。`evaluateDesignReviewIndependence` 對此回 `host_primary_unproven`（執行獨立），**禁止**標 `same-family fallback`、**禁止**宣稱 family diversity；**不得**當成 post-PR 已驗證 cross-model diversity。**若本 session 已有 trusted-session primary evidence，MUST NOT** 把 Design-Author 自降為 `unknown`/`unknown` 以略過 same-family 記帳——host-unproven 僅限無 trusted-session primary 時。

**Cursor pr-sticky dispatch default（SSOT 錨點）**：primary 未證明時仍 dispatch `reviewer_family=codex` + `primary_family=unknown` + sticky `cross-model-unverified`；primary 已證明為 `claude` 時才可用完整 different-family pairing 並宣稱 cross-model credit。

invocation 須使用 handoff-declared `reviewer_effort_ceiling`（缺省 `xhigh`；`max` 須 handoff 明示 opt-in）內經 probe 證實的最高相容 reasoning tier。**原則**：codex 保持 `-c model_reasoning_effort="xhigh"`（cross-review recipe 政策固定 tier；`gpt-6` 目錄另有 max/ultra 但本 recipe 不採用；不寫死 dated model id）；external Claude second-review recipe 使用 `--model <resolved>` + probe-backed highest-compatible `--effort xhigh`（禁 silent fixed effort=`high` / omit-model）。該值為集中定義的探測政策解析結果，可經 `DEVPRO_SECOND_REVIEWER_MODEL_CLAUDE` 覆寫；政策 selector 集中宣告於 `second-reviewer-cli-recipe-contract.mjs` 的 `SECOND_REVIEWER_MODEL_DEFAULTS`；實際 exact model 與探測證據以 renderer 的 `reviewer_model_selection` 為準。一般 interactive TL session 的 model 選擇不在此強制改寫；selector／effort 相容 frontier 變更須以 live probe 與 dogfood evidence 更新。`.codex/agents/dp-second-reviewer.toml` `model_reasoning_effort=xhigh` ≠ terminal `claude -p --effort`。

**Env var override**：`$CROSS_MODEL_REVIEWER=codex` 或 `=claude` 可強制指定，優先於偵測結果（FR-2 / D3 保留）。

### TL renderer Shell（all families）

所有 reviewer family 在 Step 5.5 / `/cross-review` **先**跑 renderer，再 validate／dispatch。`render-second-review-packet.mjs` 執行 live model discovery：Claude 為 `claude -p` model／effort micro-probe，Codex 為 `codex app-server` model/list（helper ceiling `CODEX_MODEL_PROBE_TIMEOUT_MS` = `35000ms`）；不是純本機 JSON 組包。

1. Cursor `Shell`：`block_until_ms` **≥ 330000**。**MUST NOT** 用預設 30s。**MUST NOT** background renderer。
2. **MUST** host / non-sandbox。Auto-review 擋 → `request_smart_mode_approval` 重試同一指令。sandbox 只准 `command -v claude` / `claude --version`。
3. Model discovery 的 `requires_host_rerun=true` 先換 host surface 重跑，不能用 override 掩蓋；`claude effort selection blocked (timeout)` **MUST** 分類 `sandbox-surface-fault`：換 surface 重跑。**MUST NOT** 只加長等待。**MUST NOT** 判 Claude unavailable / `recipe_unresolved`。
4. 同一 session 稍早 render 成功 **不是** 本次 host-surface proof。
5. **Host system temp parity（#2711）**：Codex／cmux 可能把 shell `TMPDIR` 設成巢狀 `…/T/devpro-codex-tmpdir`。`render-second-review-packet.mjs` 與 `run-second-reviewer-projection.mjs` 皆經 `resolveHostSystemTmpdir`（`.devpro/scripts/lib/host-system-tmpdir.mjs`）把 `neutral_cwd` 錨在 **host system temp**（unwrap 該 leaf），不得假設 raw `os.tmpdir()`／當下 `TMPDIR` 在兩次呼叫間一致。TL **SHOULD** 在 render／run 前把 `TMPDIR` 設為 host system temp（`dirname` of nested `devpro-codex-tmpdir`，或已是 host root 則不動）；機械 unwrap 是 fail-closed 防線，不是豁免 TL 對齊環境的理由。

### 執行流程概要

1. `gh pr create` 成功後，依 `pre-tool-gate.mjs::isCrossModelExempt` 判斷豁免（branch-pattern / diff-shape 豁免清單）；預設所有 PR 均需 cross-model review
2. 命中豁免 → 略過（`chore/bump-v<X.Y.Z>` 等 branch-pattern 豁免）；否 → 先 resolve `primary_family`，再依單一優先序取 reviewer family：非空 `$CROSS_MODEL_REVIEWER` env 最高 → active change ledger `second_reviewer_family` 次之 → 兩者皆無才偵測 CLI 依上表選 second reviewer（無欄位時維持既有偵測順序）
3. Invoke second 前，由共用renderer消費complete bounded issue-comments snapshot並產生綁定repo/PR/dispatch/snapshot digest的`sticky_write_disposition`；0筆marker candidate=`create`、1筆=`update` exact identity、超過1筆或snapshot/query/identity不完整=`blocked`。Wrapper在claim/probe/spawn前重驗同一snapshot與binding；drift或blocked時`process_spawned=false`，以new dispatch rerender。Cursor MUST NOT自行搜尋marker、重算candidate或選create/update。
4. Invoke second（依 step 2 resolve 之 reviewer family（env > ledger > 偵測），使用 `reviewer_effort_ceiling` 內最高相容 reasoning tier flag，缺省 `xhigh`）；要求 JSON 輸出並合併 verdict（任一 Critical → `CRITICAL`）。`pr-sticky` reviewer只執行revalidated disposition指定的packet `sticky_write_exact_recipe`：Claude family先用`Write`建立固定`cross-model-second-opinion.md`，再原樣執行renderer-selected、disposition-bound、fully concrete且endpoint為single-quoted的exact `gh api` command，不得複製／推導／替換target、path、endpoint、repo、PR或comment identity，也不得改用`gh pr comment`；Codex reviewer family維持active adapter既有exact env-target contract。Cursor host不重做discovery、action selection或手寫write recipe。
5. 亦可由 `/cross-review <PR#>` slash command 手動重跑（sticky edit 同一條，不開新 thread）

### Merge gate（`checkCrossModelMergeGate`）

Cursor host hook 可觸發 merge gate（路徑同 Claude Code / Codex host）：
- 路徑 F（`verdict: PASS | WARN`）→ pass
- 路徑 U（`verdict: UNAVAILABLE`）→ block；audit sticky 不是 merge approval
- 路徑 E（`verdict: CRITICAL`）→ block
- 路徑 B / C / D（sticky 缺失 / verdict 解析失敗 / stale sha 且非 Path D′ fresh-equivalent）→ fail-closed + 提示 `/cross-review <PR#>`

real-runtime env var 驗證 follow-up 完成前，使用者仍可手動觸發`/cross-review <PR#>`，但必須走同一renderer snapshot／disposition／runner revalidation與packet exact recipe；不得手寫`gh pr comment`或自行選sticky action。

**External evaluator 入口**：兩者皆無可用 reviewer CLI 時，除了寫 `UNAVAILABLE`，TL 可改發行 External Evaluator 審查單（`render-second-review-packet.mjs` 帶 `executor_kind: "external-evaluator"`），交由另一 family 的獨立 session live 讀 PR 並自寫 sticky，TL 再跑 `accept-external-second-review.mjs <packet-dir>` 驗收；撤回改跑 `render-second-review-packet.mjs --void-external-dispatch <packet-dir>`（審查單不提供 same-family fallback）；完整契約見 `second-review-external-evaluator.md`（審查單＋收據）。footer `Tool:` token SSOT 見 `second-review-sticky-authority.mjs` `STICKY_PROVENANCE_TOOL_TOKENS`。

## Post-PR Ready Response And Batch Carry-Forward (Cursor)

- Owner=user 且 merge Ask First／post-PR ready 時，最終回覆 MUST 含 `ChangeContext:`／`ManualTest:`（SSOT `post-pr-completion-gate.md` Ready Response）；缺欄＝Ready Response 違規，不是 Path F。
- matching `same-change-dp-change-batch` 且 `covers` 含 `local_commit`／`first_push`／`pr_create_update` 時，MUST 直接執行 covered git／PR writes，**MUST NOT** 逐步再問；Cursor user-rules「only commit when requested」在 matching ledger 覆蓋範圍內讓位給 `ai-autonomy.md` Matching Batch Approval Ledger。

### Turn-end Ledger-First Checklist（Cursor；每個 final / handoff 回覆前）

Cursor TL **沒有**可靠的 response-time hook 攔截錯誤交棒，因此本 checklist 是 Cursor 上 enforcement 缺口的主要補強（grep 鎖 skill／adapter 文字；行為靠 TL 逐步執行）。

**觸發**：準備寫本 turn 最後一段、且可能結束 turn 或把球交回使用者（含「實作完成」「測試全綠」「PR 已開」「給 next-step 選項」）。

**MUST（依序；禁憑記憶）**：

0. **Recovery intervention gate**：先判定下列 recovery trigger；命中時先讀並執行 `post-intervention-recovery-gate.md` §`Post-Intervention Exact-Case Recovery Gate`，完成該 shared gate 的完整 evidence block 後才進入 ledger owner 判定。
   - 最近一次 recovery intervention 後仍沒有 current original exact-case result 時（即使 intervention／錯誤 handoff 在前一 turn、這一 turn 只有 reminder），每個 final / handoff 前 MUST 執行 shared gate；不得因跨 turn 而跳過。
   - existing authority/tool boundaries 內可跑時，Cursor MUST 自行重跑 current original exact case，再依本輪 user-visible result 與 request 後穩定性決定 terminal state。
   - listener-only probe、同對話 reminder、先前承諾或 user retry 要求 MUST NOT 替代 shared gate；不得把仍可自行執行的驗證外包給使用者。
   - exact case `failed`／`crash` 時，final／handoff MUST 回到 investigating/blocked，MUST NOT 宣稱 recovered/ready。
   - exact case 在 existing authority/tool boundaries 內 `unavailable` 時，final／handoff MUST 使用 blocked/unverified，MUST NOT 宣稱 recovered/ready。
   - 兩種 terminal disposition 都 MUST 列出 alternate evidence、missing evidence 與 owner。
1. **讀 ledger carrier**：若當前 change 有 active `openspec/changes/<name>/proposal.md` 或 `proposal-mini.md`，讀 `## Batch Approval Ledger`（SSOT；`decisions.md` 僅參考）；lite 無 proposal 時讀 `openspec/changes/<name>/lite-scope.md` 一行紀錄（`ai-autonomy.md` Matching Batch Approval Ledger）。
2. **Matching 判定**：`kind: same-change-dp-change-batch` + `named_change` + `branch` + `repo_scope: same-repo` 全相符？
3. **下一動作分類**：下一個 git/PR write 是否在 `covers` 且不在 `excludes`？
   - **是** → `owner=AI`；**MUST 續跑**（見 `devpro:change` 第七步續跑鏈：`local_commit` → `/pre-pr` → `first_push` → `pr_create_update` → `workflow_watch` → `post_pr_completion_gate`）。
   - **否**（`merge`／`release`／`destructive`／`secrets`／`cross_repo_write`／ledger missing）→ `owner=user`；才允許 `stop-point-comms.md` 交棒。
4. **禁 covered-scope idle-stop**：`owner=AI` 時 **MUST NOT** 用編號選項重問已覆蓋動作。違規範例（禁）：
   - `1. commit+PR / 2. 只 commit`
   - `1. 跑 pre-PR / 2. push / 3. 開 PR`
   - `1.是 2.否 3.其他` 包裝已覆蓋的 commit/push/PR
5. **Footer 不推翻 owner**：`AskFirstPending`、測試全綠、sticky PASS **不得**把 `owner=AI` 改回 user。
6. **User-rules 讓位**：matching ledger `covers` 時，Cursor user-rules「only commit when requested」**不得**阻擋 covered commit／push／PR（SSOT `ai-autonomy.md` Matching Batch Approval Ledger）。

**仍須停下的 Cursor 特有 gate**（與 ledger 無關）：

- `merge` 預設在 ledger `excludes`；僅當 Step 0 明確 opt-in 且 ledger 把 `merge` 列在 `covers` 時才可視為已授權 merge
- cross-model sticky `CRITICAL`／`UNAVAILABLE`／stale sha（非 Path D′ fresh-equivalent）→ 先 `/cross-review` 或修復，不得宣稱 merge-ready

**Pointer SSOT**：`devpro:change` 第七步、`ai-autonomy.md` Matching Batch Approval Ledger + Implementation-complete → covered pre-PR、`stop-point-comms.md` Matching Ledger 例外。
