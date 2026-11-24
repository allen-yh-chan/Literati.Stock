---
name: rule-design-principles
description: source repo (devpro-agent-rules) 設計守則（6 Principles）：跨 runtime 等效、不依賴 hook、leaf 自含、token-first、cross-platform scripts、hook enforcement alignment；含 Workflow Persistence Layers (notes/ 暫存 → OpenSpec changes → archive 三層)。觸發：新增/修改 .devpro/agent-rules/*.md、AGENTS.md、.devpro/scripts/hooks/*（設計時）。
---

# Rule Design Principles

## Overview

source repo 設計判準的上位依據（6 Principles + Workflow Persistence Layers 見下方）；新增/修改 rule file、AGENTS.md、hook 時作為 self-check 框架。

Usability-First 為上位 baseline：新增 rule / hook / adapter capability 先以 `design-core.md` `### Usability-First Principle` 驗 user value，再談成本。

## When to Use

- 新建 `.devpro/agent-rules/*.md` leaf 前
- 修改既有 leaf 結構（不只 typo）前
- AGENTS.md 觸發索引或 §0 變更前
- 設計／修改 hook 前
- review rule 變更時作為 self-check 依據

## Process

### 6 Principles

| # | 守則 | 違反訊號 |
|---|---|---|
| 1 | **Cross-Runtime Parity** — 不把單一 runtime 獨家機制（subagent/tool、model-invoked skill、hook 注入）當主路徑；fallback 同等優化非降級 | rule 用 runtime-specific tool schema 卻無 Others runtime（CLI / IDE assistant）等效路徑；fallback 寫成「降級版」 |
| 2 | **Hook-Independent Routing** — AGENTS.md / leaf 在 hook 失效或 runtime 不支援時仍能 routing；hook 是加速層非正確性層 | rule 寫「hook 已注入 X」「TL 已從 hook 取得 Y」 |
| 3 | **Leaf Self-Contained** — 每 leaf 含完整 workflow；允許 ref AGENTS.md 索引或 ≤1 層同主題深化；禁 leaf→leaf→leaf chain；見 `dry-ssot-corpus.md`；本列極性不倒轉 | leaf A 內 ref leaf B，B 又 ref C；DRY 拆 leaf 互 ref |
| 4 | **Token-First（usefulness first）** — token cost 是 hard constraint，但服從 user value / usefulness；無用、重複、低訊息密度內容才是 token waste；on-demand 觸發載入 vs every-turn 注入（×M 對話輪）成本對照後，只能在同等可讀、可執行、load-bearing 的選項間選 lower-total-cost | 把內容塞 hook / always-on 前未量「輪數 × token」總成本；或為過 cap 把 load-bearing clarity 壓到 AI 難理解／難執行 |
| 5 | **Cross-Platform Scripts** — source repo scripts（含 settings.json hook commands、`.devpro/scripts/**`）必須跨平台（macOS / Linux / Windows native shell + cmd.exe + PowerShell）；禁 POSIX-only built-ins 與 POSIX-only syscall 語意 | hook command 含 `test -f`、`[ -f`、`find . -name`；目錄 fsync 於 win32 無等價；見 `anti-patterns-behavioral.md` §12 + `code-review-checklist.md` §Cross-Platform |
| 6 | **Hook Enforcement Alignment** — 任何強制性條款（MUST / SHALL / 必須 / 禁止）異動必須**同時**驗證對應 hook gate 行為一致；rule 說一套、hook 做一套 → AI 無所適從、規範失效；新增 mandatory clause 時須點名 mechanical enforcement point（hook 路徑 / gate check 字母 / test file）或明標 `cooperative-only` + rationale | rule 增/改 mandatory clause 但無對應 hook 行為 update（或反向：hook 改 gate 行為但 rule wording 未跟進）；cross-cite 失效（rule cite hook line ref / hook cite rule §X 不存在；2026-05-10 audit F1-F20 cluster，evidence 見 commit 15da4c25 message）；新增 MUST 無 mechanical enforcement point 點名且無 `cooperative-only` 標記 |

> **守則 5 process/path carrier**：Node-host 呼叫 native executable 必須傳 exact argv，不得把動態值重組成 shell string；確需 shell syntax 時必須顯式選 shell 與 dialect，且不得宣稱通用。ESM URL／host path 必須用 `fileURLToPath`、`path`／`path.delimiter`、Node fs。literal shipped `.sh` 可保留文字契約，但不得把此例外套到 Node-host executed shim。Mechanical carrier：`protected-anchor-grep.test.mjs`。

> **守則 6 反向執行（Hook-diff 反查）**：PR 改 `.devpro/scripts/hooks/*.mjs` 行為（非純註解/格式）→ 反查 cite 該 hook/gate 的 rule leaf，逐筆確認措辭與新行為一致，不一致標 Important；cite 存在性由 `rule-hook-cite-validity.test.mjs` 機械守門，本反查為語義一致性 cooperative carrier。

> **守則 4 corollary — 撞 tier cap 時三分支評估（提 cap / 拆檔 / trim，禁硬 trim 到語意不可讀）**：Token-First 的 tier cap 是**設計參數不是物理定律**，且服從 usefulness / load-bearing clarity——當某 leaf 撞頂（近/過該檔 tier assertion），依序評估三分支，**禁**反射性硬 trim：
> 1. **拆檔**：撞頂內容可獨立成主題且過 `doc-split-and-dedup-sop.md` §決策 gate 三題（互斥分支 / 70% 常見路徑只走一部分 / 不讀它不影響當前步驟判斷）→ 拆 leaf。細節（決策 gate + 7 步 SOP）以 `doc-split-and-dedup-sop.md` 為 SSOT，本檔不複述。
> 2. **trim**：撞頂內容含**真冗餘**（守則 4 true duplication，非 leaf-self-contained 必要冗餘 / 非 cross-runtime fallback）→ trim 該冗餘段。順序見 `doc-split-and-dedup-sop.md` §Anti-rationalizations「先 trim 看是否就足」。
> 3. **提 cap**：撞頂內容是**單一主題的正當深化**（拆出去會破壞 leaf 自含 / 造成 leaf→leaf chain，即不過分支 1 的 gate）、trim 只能砍**有價值語意**（非真冗餘，即不適用分支 2）、**且距上位 tier cap 仍有 headroom**（如 `next` 3000 → `core` 7500）→ **提該檔專屬 cap**（`.devpro/scripts/lib/rule-token-budget.mjs` 的 `PER_FILE_MAX_OVERRIDE`）並在 override rationale 註明本三分支評估結果與新 bound 的 headroom 計算。
>
> **禁反例**：為守某個 bound 把剛寫、有語意價值的段落硬 trim 到自己下次都看不懂——這違背 token-first 的**目的**（token 是為了讓內容可被有效載入，不是為了讓內容無法理解）。cap 的存在是防「無節制膨脹」，不是強迫「壓縮到不可讀」；三分支評估後若結論是提 cap，就提 cap + 記 rationale，勿假裝 trim 是唯一路。

### Cache-Friendly Design

Token-First 不只看總字數，也看哪些 prefix 能跨輪復用；但只有在內容同樣可讀、可執行且保留 load-bearing clarity 時，較低 token 成本才是勝出理由。設計 rule / hook payload / command prompt 時，先讓穩定內容留在前段，變動內容延後載入。

| 區塊 | 設計要求 |
|---|---|
| `system prompt` | 放穩定 policy；不要把 per-task diff / log / issue body 混進前段 |
| 根規範檔 | 保持短索引；用 leaf 觸發載入承接細節 |
| `tools list` | 避免為少數流程全時注入大量 tool 說明；只保留常用、穩定工具 |
| `deferred-loading` | 大段範例、adapter 細節、稀有流程用 on-demand leaf |
| `mid-session 換 model` | 換 model 前重報已載入 leaf 與仍有效的假設，避免 cache/context 誤判 |
| `volatile context` | 使用者輸入、測試輸出、PR diff、日期性資料放後段；不要污染穩定 prefix |

可用 runtime 提供的 cache-read token metric 驗證是否命中；具體 metric 名 per-runtime 各異，見對應 `platform-adapters/<runtime>.md`。shared rule 禁寫單一 runtime 欄位名。

> _Anchor: cache-friendly 原則分層：shared rule 只定義穩定 prefix / deferred-loading 策略，具體 metric 與驗證路徑落在 adapter。_

### Process Steps（rule 變更時逐項執行）

1. 六守則逐項自檢，書面化於 proposal（守則 6 強制：mandatory clause 變動時 grep `pre-tool-gate.mjs` / `gh-footer-gate.mjs` / `post-tool-gate.mjs` 等對應 hook，列出 alignment 證據或明示「無 hook 影響」rationale；新增 mandatory clause 另須點名 mechanical enforcement point（hook check / test）或標 `cooperative-only` + rationale，cross-link `proposal-template.md` Pre-architect Checklist item 2）
2. token load design：比較 on-demand vs every-turn；production machine check 直接量最終 actual carrier，proposal 不承載 Token evidence
3. 列出 Others runtime（codex / IDE assistant / 純 CLI）等效執行路徑
4. cross-ref 計層：>1 層深化 → 內聯或拆 scope

### Redirect Entry / Runtime Load Pre-Read

當 touch list 含 redirect entry file（以 `.devpro/scripts/tests/multi-runtime-parity.test.mjs` 的 `REDIRECT_FILES` 為權威清單）或 runtime 載入/分發機制（如 `sync-agent-rules.mjs` 的 `STATIC_FILES` / `SYNC_DIRS`、`.claude/settings.json`、`.cursor/hooks.json`、`.codex/hooks.json`）時，設計前 **MUST** 先讀本檔守則 1（Cross-Runtime Parity）與 `.devpro/scripts/tests/multi-runtime-parity.test.mjs`，再完成 proposal / proposal-mini。

Proposal / proposal-mini 必須標註 `Parity invariant impact: 保持 / 放寬 / 收緊` 與 rationale。若影響 `multi-runtime-parity.test.mjs`，測試註解或斷言必須區分 **load-bearing invariant**（所有 redirect entry 都指向 `AGENTS.md`）與 **convenience proxy**（例如 byte-equality，可因 runtime 原生載入能力差異放寬）。

Mechanical carrier：`.devpro/scripts/tests/runtime-parity-preflight-grep.test.mjs` 驗證本段、`preflight-checklist.md`、`devpro:change`、capability spec delta 與 `multi-runtime-parity.test.mjs` 註解 anchor 存在。實際「是否已讀」屬 `cooperative-only`：讀取行為不在 repo diff 中，靠 proposal evidence 與 reviewer 檢查承載。

### Hook Event Coverage Matrix

Cross-runtime hook event availability (per architecture audit, 2026-05).
For IDE assistant runtime specifics see `platform-adapters/<runtime>.md`.

| Event | subagent CLI host | CLI agent host | IDE assistant (e.g. `.cursor/hooks.json`) |
|---|---|---|---|
| PreToolUse | ✓ | ✓ | ✓ (`preToolUse`) |
| PostToolUse | ✓ | ✓ | **✗ N/A** (architecture limit) |
| SessionStart | ✓ | ✓ | ✓ (`sessionStart`) |
| UserPromptSubmit | ✓ | ✓ | ✓ (`beforeSubmitPrompt`) |
| Stop | ✓ | ✓ | ✓ (`stop`) |

**Gap**: Some IDE assistant runtimes lack `postToolUse` event. Gates that depend on PostToolUse sentinel writes (Gate D' worktree-cd) degrade to no-op on such runtimes. Per 守則 1 "best-effort" qualification: IDE assistant session token-context is already smaller, so the statusline issue is less acute. This degradation is accepted and documented in `pre-tool-gate.mjs` Gate D' JSDoc; no re-design required.

### Workflow Persistence Layers

| 層 | 路徑 | 用途 | 生命週期 |
|---|---|---|---|
| 暫存 | `<repo>/notes/*.md` | 對話討論出但未進 OpenSpec 的待辦、AI session 中介產出 | 走 `devpro:change` 落地後**刪除該條**；全清空時刪整檔 |
| 進行中 | `openspec/changes/<name>/` | `/devpro:change` 開出的正式 change folder | spec freeze 後、首次 push/PR 前 archive；細則見 `openspec-archive-principles.md` |
| 歷史 | `openspec/changes/archive/<YYYY-MM-DD>-<name>/` | 已完成 change | 永久保留 |

**規則**：

- `notes/` 是 local-only scratch，不同 runtime 各自管理；`.gitignore` baseline entry 由 `gitignore-alignment.md` 管理；mechanical guard：`notes-untracked-guard.test.mjs` 驗 0 tracked files，誤 commit 即 fail
- 對話討論出來的待辦一律先寫 `notes/session-pending.md`（避免 conversation clear 遺失）；**不**收 session 結束報告 / status snapshot — 該類由 GitHub Discussion Session Recap 承擔（per `session-recap.md`）
- **Disposition 檢查（寫入前）**：decision-ready 議題禁無要件 defer——材料已齊 → 當下議完記結論（do／won't-do+翻案條件／cooperative-only+carrier），禁以實作成本為 defer 理由；僅缺具名輸入者可入 notes，條目帶三欄 `缺輸入:`／`trigger:`／`carrier:`（填不出缺輸入 = 該當下議）。同 paradigm：`code-review-checklist.md` Finding Disposition Discipline；mechanical carrier：`pre-tool-gate.mjs` Gate N（advisory；notes/ gitignored，hook 為唯一機械 surface）
- session-pending operational lifecycle（單一路徑契約 / 抽走處理 claim / 完成刪除射程）見 `session-pending-lifecycle.md`（本檔只留三層 table 與 disposition 寫入前檢查）。
- 跨 runtime path：用 `<repo>/notes/`，避免 `~/.claude/` 等 runtime-specific 獨家位置

### 文件拆分 SOP / Protected Anchors → `doc-split-and-dedup-sop.md`

#### ROT 設計判準（SSOT）

設計規範時即避 ROT，三維對應本檔各判準的單一出處：

| 維度 | 全名 | 設計層判準 SSOT |
|---|---|---|
| **R** | Redundant（重複）| 見 `doc-split-and-dedup-sop.md` §Split/Dedup Audit Output：dedup 三分類（true duplication / leaf-self-contained / cross-runtime fallback）；**只 true duplication 可動** |
| **O** | Obsolete（過時/死路由）| 見 `rules-consistency-checklist.md` §6.5 LM-1~LM-4（孤兒觸發點 / dead reference / 觸發詞不匹配 / 載入時機耦合）|
| **T** | Trivial（cooperative-only 低價值）| 見本檔 §Hook-or-Don't-Add 守則：marginal benefit ~0 → hook-ability matrix 評估，可升 mechanical 的升級 |

> ROT 判準的唯一 SSOT 在本設計層；audit/ingest 執行流程（Cadence / Signal / Disposition / Fan-out）見 `rule-audit-playbook.md`，只 cross-ref 本表，0 複述。

#### Skill SSOT

`.devpro/agent-skills/<group>/<skill>/SKILL.md` 是 runtime adapter，不是 domain SSOT。共用流程放最小可執行 leaf；skill 只讀 routing 所需小檔或指定段落，禁止為了 DRY 迫使常見路徑載入整份大檔。例外：skill-specific prompt schema / subagent orchestration 可留 skill 內。

## Exit Criteria

- 六守則自檢書面化於 proposal
- final actual carrier 通過 `token-budget-precheck.md` 的 objective machine validation；利用率 `>=80%` 時直接審查其 normative meaning
- cross-runtime 等效路徑列出
- cross-ref 深度 ≤1 層
- mandatory clause 變動：hook alignment 證據（grep + diff stat）已附 OR 明示「無 hook 影響」rationale（per 守則 6）
- 新增 mandatory clause：已點名 mechanical enforcement point OR 標 `cooperative-only` + rationale（per 守則 6；見 `proposal-template.md` Pre-architect Checklist item 2）

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「某 runtime 是主路徑，其他可後補」 | source repo 是 universal；後補 = 不補 |
| 「hook 比較快不用每次讀」 | 每輪付一次，N 輪後超過 on-demand 觸發成本 |
| 「兩 leaf cross-ref 比較 DRY」 | leaf 自含 > DRY；冗餘可接受 |
| 「token 等寫完再優化」 | rule 寫完就鎖；事後 trim 每輪 5–15K token |
| 「AI scratch 存 `~/.claude/projects/...`」 | CC-only 路徑，違反守則 1；改 `<repo>/notes/` |
| 「完成後留 ✅ 比較有軌跡」 | archive 已有軌跡；notes ✅ 累積增 token cost（違守則 4）|

**「兩處內容重複就是 dedup 機會」** → 先區分「違反 token-first 的真重複」vs「leaf-self-contained 必要冗餘」。Dedup audit 必經三步：(1) 讀本檔守則 3 + 4；(2) `grep -r '<待刪 phrase>' .devpro/scripts/tests/` 找隱性 leaf-self-contained 約束（例：`preflight-mix-warning-grep.test.mjs` 強制 `openspec-flow.md` 自含 `simplification.*feature` phrase）；(3) 評估每個 hotspot 是 token-first violation 或正當冗餘，後者跳過。fallback 檔（`*-fallback.md`）內容看似與主檔重複是守則 1 強制要求，**禁刪**。

## Hook-or-Don't-Add 守則

新規範提案前**必須**評估 hook-ability，cooperative-only 規範對 LLM 之 marginal benefit ~0（per chore enforce-hook-backed-rule-system-and-rationalize-ssot evidence：PR #394 加 3 段 cooperative-only 後 same-session AI 立即違反 ≥ 6 條）。

### Hook-ability Matrix（4 dimension）

| Dimension | Question | 例（hookable）| 例（cooperative-only）|
|---|---|---|---|
| **Detection surface** | 哪個 event 可觀察規則違反？ | PreToolUse Bash command / PostToolUse / Stop / archive gate | 「reviewer 應該理解 design rationale」 |
| **False positive risk** | 偵測 pattern 會否誤殺 happy path？ | regex 字面 anchor（如 `git worktree add <relative>`）| 自然語言判斷（如「merge message 是否誠實」）|
| **Mechanical anchor** | 規範可被 grep / parse 的具體字串？ | `## Why` heading / FORBIDDEN regex set | 「保持 leaf-self-contained 精神」|
| **Enforcement strength** | block / warn / cooperative? | block：明顯違規必擋 / warn：first iteration 收 evidence / cooperative：必要 escape hatch | weak：依賴 reviewer 主觀 |

### 判定流程

1. 提案新規範時，逐 dimension 評估 ≥ 1 hookable indicator
2. 4 dimension 皆有 → 設計 hook，本規範升 mechanical gate
3. 部分 hookable → 混合：核心驗證 hook，邊角情境 cooperative
4. 全 cooperative-only → **接受 marginal benefit ~0**；若仍要加，標 `[cooperative-only, weak enforcement]` 警語，並排入 next rationalization PR 重評

### Hook Gate Default-Pass

事故預防型 hook 預設放行。只有 observed payload + repo state 正向確認具體 workflow / safety / compliance 違規時才 hard-block；解析不確定、state 不可解析、或 false-positive 風險高時改用 non-blocking `additionalContext` advisory（hook 誤擋中斷開發流程，「可疑但未證實」非 block 條件）。明確 fail-closed 的 security/compliance gate 例外須在 source rule 寫明。

**豁免非靜默**：gate 因豁免/跳過放行時 MUST surface 非阻擋 advisory 說明「因 X 豁免、未經 Y 檢查」，不得 silent pass。silent 讓使用者誤以為已檢查；豁免規則（如 diff-shape）多為粗略近似、會誤判高風險案例，advisory 補上透明層。

### Hook Gate Evidence-First Design

設計/修改 hook gate 前先把 rule 分桶再選 enforcement surface，不得先寫 regex 再補例外；gate proposal 必須列出 hard-block / ask / nudge / permissions / state-backed / delete 目標桶與理由。

Hard-block 只給災難級／安全／合規／release integrity，且須由 hook 可觀察事實正向證明：command 事實來自 shell-aware segmentation/tokenization 或結構化 tool payload，不得用整條 Bash regex 猜意圖；workflow 事實優先查 git/GitHub/repo state，不得藏在 command-text inference。能用 runtime permissions 表達的 narrow destructive action 優先移 permissions ask/deny；hook 僅在 runtime 無等價能力時補 ask/nudge（已證實災難級除外）。

fail-open 條件：payload parse 失敗、repo state 不可得、session/turn relevance 不可證、或 false-positive 高 → advisory/ask 不 hard-block。marker/transcript/global state 不得觸發 hard-block，除非證明屬當前 session/turn/branch/PR。

新增 regex 的門檻是「減法」：只能用在 tokenized fact / structured field 上，且必須替換同等或更大的 legacy regex cluster；禁止用 negative lookahead 追加第 N+1 個例外。測試命名或 case 註記必須標明 `catastrophic-block`、`state-backed`、`permissions`、`ask`、`nudge`、或 `false-positive-regression`，讓回歸保留證據但不把誤擋釘死。

### Worked Example：本 chore P4 4 段全 hookable

- A handoff-cite：detection=Stop event；anchor=keyword + `<file>:<line>` regex；enforcement=block
- B issue-anchor：detection=archive gate；anchor=`## Issue Anchor Verification` heading；enforcement=block
- C token-budget：detection=archive gate；anchor=authoritative actual-carrier manifest + production objective result；enforcement=objective failure/unknown block，利用率 `>=80%` 發出 direct-carrier semantic review signal
- D worktree-abs：detection=PreToolUse Bash；anchor=`git worktree add <path>` 第 3 arg；enforcement=block

C 段反規條（「PR 已建立，待使用者 merge」）由 hook A 強制，不靠 cooperative-only phrasing。

## Rule-Anchor Guard 強度守則 → `rule-anchor-guard-strength.md`

grep-based anchor guard 的強度守則（根本極限 + polarity 同物理行 compound regex / structural 直接 includes 二分）萃取至 next-tier leaf `rule-anchor-guard-strength.md`（撞 core-cap headroom 三分支評估分支 1：可獨立成主題 → 拆檔）。

## Hook Error Message Shape

承上節「Hook-or-Don't-Add 守則」決定 hookable 後，本節規定 fail reason 字串該怎麼寫。Hook fail reason **必須**先陳述**偵測到的事實**，再列**可能成因**，最後給**修法**。

**反例**：`pre-tool-gate.mjs` Gate 2b 原始 reason 把「常見原因之一（heredoc artifact 推離 tail）」放在最顯眼位置 → AI 把 hint 當 root cause，未驗自己 commit message 是否真有 `Rules:` footer literal。

**正解結構**：

1. 先說 hook 偵測到什麼（具體事實，如「完全不含 `Rules:` 字串」vs「含 `Rules+Model` 同行但不在 tail」）
2. 再列可能成因（heredoc artifact / 中段 / 缺欄位）
3. 最後給 canonical 修法範本

**為什麼這樣設計**：error message 給「常見原因」hint 對人類使用者有導向價值，但對 AI 反而誘發 anti-rationalization（把 hint 當答案、跳過 root cause 自驗）。事實先行 → AI 必須對齊偵測到的具體狀態才能 reason，無法跳過。

**已實作參照**（採事實先行結構的 reason 字串）：
- `pre-tool-gate.mjs::checkCommitAttribution`：依 raw-text co-occurrence detection 分兩種偵測情境（缺 footer / 含 Rules+Model 但格式不符）
- `gh-footer-gate.mjs::hasFooter`：對稱實作 gh body 場景

## Example Sanitization

寫 Never / PII / output-discipline 規則的 proposal 時，AI 容易從 session 環境（userEmail、絕對路徑）抓真實值放進 example，**違反正在定義的新規則本身**（dogfood fail）。

### Canonical FORBIDDEN Regex Set

SSOT:`.devpro/scripts/lib/pii-pattern-contract.mjs`；禁複製 regex/classifier。

| 類別 | Boundary / compat | Placeholder |
|---|---|---|
| Email | email-like；`example.{com,org,net}`、`anthropic.com` allowlist | `user@example.com` / `<user-email>` |
| Unix 路徑 | case-sensitive `/Users/`、`/home/` + ASCII username 首字；`<...>` 不命中 | `/path/to/example` / `/Users/<name>/...` |
| Windows 路徑 | ASCII drive/username 首字；separator 各容 `\\`/`/`；`Users` 忽略大小寫；overlap→Windows single-hit | `C:\\Users\\<name>\\...` |
| 帳號 ID（Discord/Slack snowflake） | `\\b\\d{17,19}\\b` | `<account-id>` |
| Token / 密鑰 | 任何字面 token 字串 | `<api-key>` / `<token>` |

### How to Apply

Commit 前依 authority 掃前三類，hit → 換 placeholder（`preflight-checklist.md` 點 9）。Gate P 阻擋 `openspec/changes/<X>/{meeting-notes,brd,proposal,proposal-mini,tasks,qa-test-scope,decisions}.md` 寫入；archive gate 不阻擋（#706）。

## Verification

**Anti-Pattern**：

- ❌ subagent 委派當唯一描述（違 1）
- ❌ 「hook 已注入 X，本 leaf 不重述」（違 2）
- ❌ leaf A → B → C 才能完整執行（違 3）
- ❌ 為 DRY 拆兩 leaf 互 ref（違 3）
- ❌ 200 byte 提示塞 hook 圖快，未量輪數成本（違 4）
- ❌ fallback 寫「主路徑用 subagent；無 subagent 時自己做」（違 1）

```bash
rg -l 'Agent\(|subagent_type|Skill tool' .devpro/agent-rules/          # 守則 1
rg -l 'hook 已注入|從 hook 取得|SessionStart hook' .devpro/agent-rules/ AGENTS.md  # 守則 2
rg -c '.devpro/agent-rules/[a-z-]+\.md' .devpro/agent-rules/           # 守則 3（leaf ref，逐檔評估）
wc -c .devpro/agent-rules/*.md                                         # 守則 4（tier cap 利用率）
```
