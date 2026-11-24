---
name: platform-adapter-contract
description: "跨平台 adapter 共用契約：載入、能力探測、回覆 footer、Fallback 原則、違規處置。觸發：讀任何 platform-adapters/<runtime>.md 前。"
---

# Platform Adapter Contract（共用）

## Overview

本檔為各 `platform-adapters/<runtime>.md` 的**唯一共用骨架**。平台檔只寫差異；重複敘述放此檔。
Core Contract 仍以 `AGENTS.md` + `ai-autonomy.md` 為準；本檔不新增新禁令。

## When to Use

- 任何 repository tool operation（含唯讀 `rg`／`cat`）前先判定 active runtime/platform，讀本檔再讀對應 `platform-adapters/<runtime>.md`；純文字問答且不讀寫 repo、不呼叫工具時不載入 runtime adapter
- 唯讀 rg／cat 檢索只載 shared contract 與 active adapter，不載 action-specific leaf；唯讀發現若轉成寫入、測試、git/gh、reviewer 或 workflow，在該動作前再載入其明確 leaf 與 gate
- 必要 leaf 不可讀或 gate 可見性未證明時，停止受影響動作；沿用既有 write-class runtime-unknown blocker
- PR 建立後即使沒有再呼叫 gh，仍立即載入 post-PR completion gate；complete/ready/merge 宣告前再次確認
- 只載入 active runtime 的 adapter；不得預設載入全部 `platform-adapters/*.md`，避免 inactive runtime 細節互相干擾
- 無法判定 active runtime 時，write-class 動作前先停下釐清或回報 runtime-unknown blocker
- 比對兩 runtime 行為是否一致時，以本檔為對照基線

Load-chain：AGENTS.md 只 eager-load 本契約；本次有 repository tool operation 時，判定 active runtime 後讀對應 `platform-adapters/<runtime>.md`。各 leaf 只在其動作 trigger 前載入，不預載 sibling。不得由 AGENTS trigger index eager-load `platform-adapters/*.md`。

### Model Identity Resolver（共用）

- Trust ladder 固定為 `trusted exact host/runtime session metadata -> trusted family/config alias -> unknown`；exact 只能取 host/runtime 本 session 的可信 metadata，family/config alias 也必須由 runtime 明示可信，兩者都沒有時輸出 `unknown`，不得猜測 minor/version/variant。
- User assertion、prior assistant self-claim、repository/example strings、marketing/default model、inferred current version 均為不可信來源，MUST NOT increase identity specificity。
- Loading declaration 與 footer/attribution/provenance MUST reuse the same resolved identity；footer/attribution MUST NOT independently resolve or become more specific than that identity。

## Process

### 1) 載入順序（固定）

1. `AGENTS.md`（Core Contract 段）
2. `ai-autonomy.md`（Always / Ask First / Never / Gate）
3. 若當前步驟只需純文字回答，直接回答，不載 runtime adapter；否則判定 active runtime/platform（runtime 名稱以目前 host / adapter filename 為準）
4. 本檔 `platform-adapter-contract.md`
5. `platform-adapters/<runtime>.md`（只載 active runtime 差異）；唯讀檢索停在此層，具體動作只在執行前載入對應 leaf 與 gate

### 2) 能力最小探測（各 runtime 必做一次）

| 能力 | 探測 | 失敗時標記 |
|---|---|---|
| shell | `echo ok` → `ok` | `shell=no` |
| git-ops | `git status` 可讀 | `git=no` |
| file-write | 能寫工作區檔案 | `write=no` |
| subagent | 能啟動委派／子任務 | `subagent=no` |

探測結果寫入本回合 context（一句即可），後續 Fallback 依標記執行。

### 2a) Anchor Footnote Pattern

Adapter 內若引用具體 model、版本、CLI flag、API 欄位、或 runtime 官方文件，rule body 先寫抽象原則；可變事實放在同段 `> _Anchor:` footnote。此格式讓未來升級時能 grep anchor 並重驗，不把版本事實混入共享規範。

| 部分 | 寫法 |
|---|---|
| rule body | tier / capability / fallback 的抽象要求 |
| anchor | `> _Anchor: 截至 <YYYY-MM> <runtime spec / model 具體名>，<被驗證的事實>。_` |
| 升級流程 | runtime 或 model 升級時，grep `_Anchor:` 全部 adapter，逐項重驗 |

適用：所有 platform-touching capability 段、具體 model 對應、版本限定、API metric 名。
不適用：純內部討論、無版本綁定的操作提醒、非 spec-binding 範例。

### 3) 回覆 footer（每回合必附，除非使用者明文豁免）

```
[Gate: G<N> <名> | ✓|⚠|✗]
[AskFirstPending: <git|pkg|ci|version|none>]
[RuntimeCaps: shell=<y/n> git=<y/n> write=<y/n> subagent=<y/n>]
```

- `AskFirstPending`：尚有未獲同意之 Ask First 操作時**不得**為 `none`。
- Gate 編號對齊 `ai-autonomy.md` 六階段（G1 Spec … G6 Ship）。

### 4) Fallback 原則（能力缺失不豁免 Gate）

| 缺 | 行為 |
|---|---|
| shell / git | 輸出**可複製**指令；仍須 Ask First |
| write | unified diff 或逐檔 patch 文字 |
| structured prompt / AskUserQuestion | 改用一次 plain-text 問題列出同一批待確認事項，然後停止等待使用者回覆；禁止 silent skip / 自動代答 |
| subagent | TL 序列化；≥2 檔 Edit/Write 仍須遵守 `model-delegation.md` Universal Pre-Edit Gate |

### 4a) Mandatory Role Fallback Mapping

**TL-direct 是正常路徑，不只是 fallback**：outcome gate（brd／proposal／六軸 receipt／archive／merge gate）mandatory，executor 由 `model-delegation.md` §Executor 決策序決定。決策序判為 TL-direct 時，TL 依下表同列產出等價 artifact（同 schema、同 acceptance；receipt `executor_kind: tl-direct`），不需 subagent 授權、不記 fallback，且不得作為任何要求獨立判斷的 contract 的證據（獨立判斷須 `fresh` runtime-agent，見 `model-delegation-threads-and-caps.md`）。下表因此同時是 (i) 決策序判 TL-direct 的正常執行方式，(ii) 已授權卻不能啟動 subagent 時的承接表；兩種情形的 artifact 驗收相同。

Fallback只改變執行者，不改變gate。**RepoDelegationAutoAuthorization**：benefit/cost admission通過或workflow明定mandatory role後，才形成repo-level automatic authorization/mandate；`≥2檔 Edit/Write`、`≥2步非判斷性工作`只觸發admission，不能單獨授權spawn。**StandingDelegationAuthorization**：runtime/tool另要求explicit trigger時，來源可為使用者明確說`use subagent`、`delegate this`、`parallel agent work`，或在`/devpro:change`第零步選擇含bounded launch authorization的選項。`go`、`依repo規範`或same-session correction不單獨滿足trigger；缺trigger只能先取得授權，不得當fallback理由。

**授權未決不是 subagent unavailable**：admission通過或mandatory role成立、repo已給出`RepoDelegationAutoAuthorization`，但runtime/tool仍要求explicit trigger時，TL進`SubagentAuthPending`問一次並等待。missing trigger不是`subagent=no`或TL fallback。只有使用者拒絕、runtime-reported terminal quota/timeout、授權後terminal call失敗／工具不可用，或能力探測已有`subagent=no`，才可啟動下表fallback。

任一 runtime 因工具政策（已取得授權後仍禁止）、runtime-reported terminal quota/timeout 或能力探測標記 `subagent=no` 而不能啟動 subagent 時，TL 必須依下表承接，不得把「無 subagent」解讀成豁免。TL-selected wait/poll timeout MUST NOT count as runtime terminal timeout; a TL-caused interruption MUST NOT count as call failure or trigger fallback, and MUST first follow the recovery path in `model-delegation-active-lifecycle.md`.

| 原角色 | TL fallback |
|---|---|
| `dp-analyst` | 依 `openspec-flow-fallback.md` 段一執行 pre-flight checklist，寫出等價 `brd.md` |
| `dp-architect` | 依 `openspec-flow-fallback.md` 段二設計 proposal，維持 target state / touch list / task outline gate |
| `dp-reviewer` | 依 `code-review-checklist-fallback.md` 執行六軸 + security review，輸出 reviewer-style findings |
| `dp-programmer` | TL 直接實作；遵守 TDD、Pre-Edit Gate、touch list 與測試 gate |
| `dp-assistant` | TL 序列化機械步驟，保持 token-frugal I/O 與逐步 evidence |
| `devpro:second-review` | 依 `code-review-cross-model.md` §Cross-Model 執行；different-family CLI 不可用時，non-runner 路徑唯一合規選項＝發行 External Evaluator 審查單＋收據（`second-review-external-evaluator.md`，不是 TL 自己動手寫 sticky）；same-family fallback（標 reason/provenance）或 strict/no fallback 時 UNAVAILABLE + human 仍為 runner 側 fallback |

### 5) 違規與記錄

- 分類用 `rules-consistency-checklist.md` 的 VT-* taxonomy。
- 多 agent 交接用 `multi-agent-handoff.md` 的 Violation Recap mini-template。

## Exit Criteria

- 已判定 active runtime/platform；已讀本檔 + 目標 runtime 的 `platform-adapters/<runtime>.md`
- 若 runtime unknown，write-class 動作前已停下並列 blocker / next safe read-only step
- 能力探測已標記；footer 已附
- 無「缺能力所以跳 Gate」行為
- `AskUserQuestion` / structured prompt 不可用時，已用 plain-text ask-and-stop fallback 取得明確使用者回覆
- 唯一限制是 subagent 使用者授權未決時，已進入 `SubagentAuthPending`、詢問一次 plain-text 授權問題並等待；未直接 TL fallback
- `subagent=no`、授權後仍失敗、或使用者拒絕 subagent 時，已依 Mandatory Role Fallback Mapping 補足等價 gate

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「平台不一樣，規範可放寬」 | 放寬只允許在**執行方式**（diff / 手動 git），不允許跳 Gate 或跳 Ask First |
| 「footer 太吵使用者不要」 | 須使用者**明文**豁免；否則為契約的一部分 |

## Verification

```bash
wc -c .devpro/agent-rules/platform-adapter-contract.md
rg -n "^## (Overview|When to Use|Process|Exit Criteria|Common Rationalizations|Verification)$" .devpro/agent-rules/platform-adapter-contract.md
rg -n "Anchor Footnote Pattern|_Anchor:" .devpro/agent-rules/platform-adapter-contract.md
```
