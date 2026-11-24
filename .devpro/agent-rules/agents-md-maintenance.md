---
name: agents-md-maintenance
description: AGENTS.md 維護規則：何時重產、SemVer 版號管理、Session Hook 連動、Scenario 同步。觸發：.devpro/agent-rules/*.md 任何變更、新增/移除 slash command、規則行為/路由邏輯變更時。
---

# AGENTS.md 維護指示

## Overview

AGENTS.md 由 AI 根據 `.devpro/agent-rules/*.md` 壓縮產生。採**雙層架構**：§0 為永遠載入的核心規則（行為邊界、Anti-Rationalization、Red Flags）；其餘階段以觸發式載入指示 AI 在進入該階段前讀取對應 `.devpro/agent-rules/*.md` 完整版。目標讀者是 AI，不是人——只保留指令，移除背景說明、「為什麼」、流程圖。壓縮目標是提高 AI 可執行性；有用且 load-bearing 的 clarity > token，無用／低訊息密度內容 = 浪費 token。

## When to Use

- `.devpro/agent-rules/*.md` 有任何變更（含 typo／排版）→ commit 前必須重產
- 新增／移除／改名 `devpro:*` skill → 同步更新 `.devpro/scripts/hooks/session-start.mjs`
- 規則行為或路由邏輯變更 → 同步維護 `scenarios/scenario-*.md`
- 不觸發：純問答、閱讀 code、無產出 artifact 的討論

## Process

### 改 AGENTS.md / payload 前置連動 checklist

改 AGENTS.md 或 `session-start.mjs` payload 前，逐項確認：

1. **AGENTS.md size**：軟上限 6500B、HARD 10500B（`agents-md-size.test.mjs` soft-warn／governance；ordinary path 不因 HARD alone fail closed）
2. **SessionStart payload size**：≤ 1000B static pointer（`hook-payload-sync.test.mjs` byte budget 斷言）
3. 改動後三個 sync/parity 測試必須全綠：
   - `agents-md-section0-sync.test.mjs`（十句自檢 10-item count + topic order）
   - `hook-payload-sync.test.mjs`（AGENTS.md SSOT 存在 + SessionStart pointer-only + payload byte budget）
   - `hook-session-start.test.mjs`（SessionStart 動態提醒保留，且不複製 AGENTS.md 長段）
4. 改自檢清單或輸出紀律 bullet 時，只改 AGENTS.md / `ai-autonomy.md` 對應 SSOT；`session-start.mjs` payload 保持 pointer-only，不同步複製長段

### §0 雙層 sync

AGENTS.md §0 是 always-loaded 摘要；`ai-autonomy.md` §Process 是完整 SSOT。兩者不是可獨立演進的兩份規則。

- AGENTS.md §0「動手前十句自檢」每項只保留 1-line reminder
- `ai-autonomy.md` §Process 保留完整條文、例外、anchor 與驗證理由
- 兩檔清單的項目數、順序、主題 MUST 一致；目前固定為 10 項
- 修改任一檔的自檢清單時，必須同步另一檔並跑 `agents-md-section0-sync.test.mjs`
- `session-start.mjs` 不再 mirror 本清單；它只指向 AGENTS.md，避免 runtime bootstrap 重複載入
- 新增第 11 項前先通過 `design-core.md` Usability-First 與 token budget，不得只因「規則更完整」而加

### 重新產生步驟

1. 讀取所有 `.devpro/agent-rules/*.md` 最新內容
2. 依產生規則重新產生 AGENTS.md（保留既有 §0 與觸發式載入 entries 結構；依 `.devpro/agent-rules/*.md` 的新增／刪除／改名增刪對應 entries）
3. 跑 `node .devpro/scripts/run-test-suite.mjs --tier unit` 全綠（commit 後再跑 `node .devpro/scripts/run-test-suite.mjs --changed main`，見 Exit Criteria）；若 bytes 接近軟上限（~6500 bytes），優先壓縮**低訊息密度**文字再重跑；新增／還原 trigger synonym 時不得為省 bytes 刪掉既有 routing synonym。Ordinary path **MUST NOT** hard-trim-for-cap 有價值／load-bearing 語意；超過 HARD 時 tests／PR soft-warn（`cap-pressure=over`），remediation 屬 governance accepted finding（必要時調 cap + rationale）
4. 展示變更摘要給使用者確認（含當前行數與差異）

### 產生規則

- **祈使句**：用「必須」「禁止」「先做 X 再做 Y」「STOP — 先讀取」
- **觸發式載入 header 格式**：§0 用 `## 0.`；其餘用 `### <描述>（§<N>）`（全形括號，禁止半形）
- **編號**：`§3`/`§3c`/`§3e-1`；多 section 用 ` + ` 分隔；同主題遞增，獨立主題用下一主號，禁止跳號
- **大小 cap**：軟上限 **~6500 bytes**（advisory：優先壓縮低訊息密度文字）、硬上限 **10500 bytes**（`agents-md-size.test.mjs` soft-warn／governance；ordinary test/PR 不因 HARD alone fail closed）
- **context pointer（canonical SSOT）**：AGENTS／觸發索引條目寫「讀 X 再寫／再做」——具名 leaf／檔路徑，禁口號式「注意相關文件」。Avoid：把整包 leaf 正文塞進 AGENTS。
- **leading words**：觸發列／description 前綴用可掃描 leading words（動詞＋主題），讓 agent 掃 index 即可命中；禁曖昧散文開頭。
- **Protected Anchors（overlay）**：觸發索引 preamble 的 `AGENTS.local.md`／additive-only／不可放寬 散文 pointer，以及索引列 `consumer-local-rules.md`，壓縮時**不可靜默移除**（類別與豁免見 `doc-split-and-dedup-sop.md` §Protected Anchors）。Synced `AGENTS.md` 仍禁 consumer 手改；自訂內容合法出口＝root `AGENTS.local.md`（見 `consumer-local-rules.md`）。

### SemVer 版號規則

版號**只能**由 promotion commit（`chore(release): bump v<X.Y.Z>`）變更，其餘 commit 禁止碰。

- **MAJOR**：破壞性變更（刪 section、改行為邊界語意、改觸發載入契約、改既有 slash command 行為）
- **MINOR**：新增功能（新 `.devpro/agent-rules/*.md`、新行為邊界條目、新觸發情境、新 slash command）
- **PATCH**：不改語意的修正（錯別字、語句澄清、排版、搬移不改指令含義）

Bump 與 release 流程見 `.devpro/agent-rules/rules-flow.md`「Source Repo Release」。

### Session Hook 連動

新增/移除/改名 `devpro:*` skill、或修改行為邊界速查時，**必須**在 commit 前同步更新 `.devpro/scripts/hooks/session-start.mjs`。

### 4-Layer 職責分離

維護 AGENTS.md、`devpro:*` skills、`dp-*` agents、hooks 時，先判斷能力屬於哪一層；不要為了架構整齊把 workflow 搬到不適合的 runtime surface。

| Layer | 職責 | 邊界 |
|---|---|---|
| MCP | 外部系統連接與資料讀寫管道 | per-runtime config，不是規則本體 |
| Skills | 使用者可顯式呼叫的 reusable workflow | 內容 SSOT 在 `.devpro/agent-skills/<group>/<skill>/`；`.claude/skills/devpro`／`.agents/skills/devpro` 兩條 entry 以 symlink 指向 catalog root `.devpro/agent-skills`（`.cursor/skills` 已退役，擁有 `.cursor/` 的 runtime 經此兩 root 發現），由 skill 名稱（如 `/devpro:change`）或自然語言觸發（禁放 catalog skill 的副本；consumer 自建 skill 可放 `.claude/skills/<own-name>`，見 `agent-skill-governance.md`） |
| Subagents | TL 依任務派出的角色化 worker | TL-invocable，不是 user-invocable command |
| Hooks | 自動 guard / reminder / marker | 加速層；失效時仍須能靠 leaf rules 完成 |

Commands vs Subagents 的界線：使用者直接呼叫的是 Commands+Skills；TL 為了完成任務拆派的是 Subagents。現有 7 logical command groups：`change`、`pre-pr/cross-review`、`init`、`load-plan`、`security-scan`、`setup-ci`、`sync-rules`。

**F6 8-cap** 只適用 model-invocable skills 的 recall 限制；user-invocable commands **不適用**。若未來真的新增 model-invocable skill catalog，另開 cap / eval 規則，不在 AGENTS.md 維護規則中偷渡。

> _Anchor: 截至 2026-05 reference repo skills audit，約 20 skills 中多數以 `disable-model-invocation: true` 避免進入 model recall set；因此 F6 8-cap 不套用 user-invocable commands。_

### Source release 與 consumer sync 索引統一規則

`devpro-agent-rules` source repo release 與 consumer rules sync 是兩個入口，AGENTS.md 維護時必須保持分流：
- **source repo release**：指向 `release-sit-uat-pat-prod.md` Source Repo / SemVer release
- **consumer rules sync**：指向 `rules-flow.md` 與 `release-sit-uat-pat-prod.md` Rules Lane
- 修改 `rules-flow.md` / Rules Lane / Source Repo release 段時，須同步檢查 AGENTS.md 入口是否仍區分 source 與 consumer

### Scenario 維護時機

`scenarios/scenario-*.md` **必須**在規則行為/路由邏輯變更時同步維護。判定基準：改動是否使既有 scenario 的 Rule Walkthrough、Negative Checks、或 Assertions 失效 → 會則必須同步修。純措辭/typo/排版（不改流程邏輯）免改。

## Exit Criteria

- `node .devpro/scripts/run-test-suite.mjs --changed main` 全綠（範圍 SSOT `test-suite-cadence.md`；commit 後執行：它讀 `main...HEAD` 的已提交差異，未提交的變更不會被選到，分支尚無 commit 時會退回完整 integration；commit 前先跑 `--tier unit`。governance／release 的全量要求不變）
- `wc -c AGENTS.md` HARD 10500 bytes 為 soft-warn／governance 觀測口（`agents-md-size.test.mjs`；ordinary path 不因 HARD alone fail closed；軟上限 ~6500 bytes 為壓縮提示）
- 變更摘要已展示給使用者確認
- slash command 變更已同步 `session-start.mjs`
- 路由邏輯變更已同步對應 `scenario-*.md`

## Common Rationalizations

N/A — 技術規範類，無對應藉口。

## Verification

```
# 大小檢查（HARD 10500 soft-warn／governance；軟上限 ~6500；wc -l 僅供參考）
wc -c AGENTS.md
wc -l AGENTS.md

# 測試全綠（commit 後執行；commit 前跑 --tier unit）
node .devpro/scripts/run-test-suite.mjs --changed main

# 觸發式載入 entry 格式確認（全形括號）
grep "（§" AGENTS.md | head -20
```
