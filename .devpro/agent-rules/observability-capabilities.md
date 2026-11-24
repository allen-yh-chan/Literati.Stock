---
name: observability-capabilities
description: Observability capability specs：load-plan、edit-time syntax validation、user-invocable command/skill、reasoning depth control、pre-commit cross-review reminder、per-session usage telemetry。觸發：新增/修改 adapter observability 能力時。
---

# Observability Capabilities

## Overview

本檔只定義 capability spec；runtime-specific implementation 寫在 `platform-adapters/<runtime>.md`。新增 capability 時，shared spec 保持 vendor-neutral；adapter 必須列出支援狀態、fallback、驗證路徑。

**Canonical adapter registry**（與 `vendor-leak-regression.test.mjs` 同步維護）：

- `platform-adapters/claude-code.md`
- `platform-adapters/codex.md`
- `platform-adapters/codex-host-cross-review.md`
- `platform-adapters/copilot.md`
- `platform-adapters/cursor.md`
- `platform-adapters/gemini.md`

## When to Use

- 新增或修改 runtime observability 能力
- 寫 adapter capability matrix / fallback 描述
- 設計 hook、command、reasoning depth、pre-commit reminder 等跨 runtime 能力

## Process

### Capability: Load-Plan Capability

Runtime SHOULD 提供方式列出本 session 已載入與可能 on-demand 載入的 rule / command / agent / hook。輸出至少含：file path、byte/token estimate、why-loaded。狀態標記：

| 標記 | 意義 |
|---|---|
| `[loaded]` | 已確認在當前 context 或 runtime manifest 中 |
| `[on-demand: <trigger>]` | 需特定 trigger 才讀取 |

Token estimate 使用 `Math.ceil(bytes / 3.5)`。不支援 manifest 的 runtime，TL 在 session 開始或 debug 時手動列出 loaded / on-demand 清單。

### Bounded Prime / Cold-Start Context

Cold-start loading 是 Load-Plan 情境，非無限掃 repo。新／陌生 repo 先讀：

1. 根指令：`AGENTS.md` / runtime adapter / 使用者指定檔
2. 專案入口：`README.md` 前段 / docs index
3. 當前 change：active `openspec/changes/<name>/`（若有）

輸出短摘要：專案目的、主要 rule/command surface、目前 change、下一步。禁把 `~/.claude`、`~/.hermes`、runtime-local cache 當 shared rule 路徑。範圍見 `token-frugal-io.md` § Rule Loading Scope Order、Forbidden-path default。

### Capability: Edit-Time Syntax Validation

Runtime SHOULD 在檔案 edit 後對 `.sh` / `.json` / `.mjs` / `.py` 做 quick syntax validation。Validation 是 observability backstop，不替代 full test suite。

| 條件 | 要求 |
|---|---|
| syntax check 可執行 | fail-open warn，不擋 edit |
| checker 不存在 / timeout | 記錄 skipped reason，不宣告 syntax clean |
| runtime 無 hook surface | adapter 寫 partial support + manual command fallback |

### Capability: User-Invocable Command/Skill Capability

Runtime SHOULD 提供 user-invocable 入口，讓使用者顯式呼叫 reusable workflow。入口可為 slash command、command palette、named prompt、或自然語言觸發，但 adapter 必須說明 manifest / discovery path。

最低要求：

- 至少 1 種 user-invocable form 或明確 partial support reason
- load-plan 能列出入口名稱與載入條件
- 不把 TL-only subagent 誤寫成 user-invocable command

### Capability: Reasoning Depth Control

Runtime SHOULD 提供 reasoning depth control；機制可為 CLI flag、slash command、API parameter、IDE selector、或 config。Adapter MUST 說明支援狀態與預設 tier。

| 場景 | 建議 |
|---|---|
| 短 task / low-risk mechanical | lower tier |
| architecture / RCA / review | higher tier |
| long agentic run | avoid max-like overthinking unless explicitly needed |

若 mapping 只是 heuristic，adapter MUST 標 `partial support` 並寫 verification path。

### Capability: Pre-commit Cross-Review Reminder

Runtime SHOULD 在 commit 前提示是否需要 cross-review；此能力 MUST fail-open，不阻擋 commit。提醒條件 MUST reuse 既有 cross-review SSOT / helper，不得在 hook 內重新發明豁免規則。

最低要求：

- exempt branch / exempt diff shape silent
- non-exempt branch prints actionable reminder
- exit code remains 0
- adapter 寫 full / partial / not applicable 與 fallback

### Capability: Per-Session Usage Telemetry

Runtime SHOULD 提供方式回報單一 session 的真實 token／花費用量（host 直接回報，非估算），供收尾 Recap 記錄使用。輸出至少含：時間點、角色、項目、耗時、token 花費（`input` / `output` / `cache_read` / `cache_creation`）。

Runtime 的 lineage projection MUST 輸出 `devpro-lineage-usage-report/v1`，並將 `lookup`、`scope`、`coverage`、`terminality`、`reconciliation` 五個 claim dimensions 分開。Canonical identity 是 `host:session_id`；逐 metric 守恆式固定為 `root + unique descendants + unique external reviewers = lineage_inclusive`，另列 `root_sessions`、`descendant_sessions`、`external_reviewer_sessions`、`dispatch_rows`、`spawn_events`、`claims` 與 named `gaps`。重複 dispatch 或 edge 不得重複計入同一 identity。

Discovery MUST 有 file、byte、node、depth、time-window bounds；cycle、collision、unresolved/read failure、cap hit、unknown relationship 或 open/unknown terminality皆保留 partial evidence並具名降級，不得補零或宣稱 `lineage-complete|final|reconciled`。Host adapter只投影可觀測 evidence；不足時回 `partial|unknown|unavailable` 或 named gap，跨 runtime parity比較 outcome/degradation，不要求相同私有 layout。輸出不得含 raw local path、email/account marker、secret 或 transcript body。

| 標記 | 意義 |
|---|---|
| `fully implemented` | Runtime 有可讀的 session-scoped usage 來源，可產出上述明細 |
| `not applicable, <reason>` | Runtime 未對外暴露可讀的真實用量資料；對應 Recap 寫法為 `source: N/A: <reason>` |

不支援的 runtime MUST NOT 印估算值或 `0` 冒充真實花費；缺席一律具名理由，不得靜默。

## Exit Criteria

- 每個 capability 在 canonical 6 adapters 皆有支援標記
- 支援標籤限：`官方確認` / `fully implemented` / `partial support, <reason>` / `not applicable, <fallback>`
- shared spec 不含 runtime brand 或 model name；具體值只在 adapter
- 裸 TODO 不得預填於 adapter

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「這個 runtime 應該支援，先寫 TODO」 | 禁裸 TODO 預填於 adapter（M16 原則）；應寫 partial support + verification path：明確說明「Support: partial support」並列出 fallback 或 manual verification 路徑 |
| 「先只寫主 runtime」 | capability spec 必須列 canonical adapters；漏列會造成 false parity |
| 「hook 會提醒，所以 rule 不必寫」 | hook 是加速層；capability spec 仍需可讀 fallback |

## Verification

```bash
grep -cE "Load-Plan Capability|Edit-Time Syntax Validation|User-Invocable Command/Skill|Reasoning Depth Control|Pre-commit Cross-Review Reminder|Per-Session Usage Telemetry" .devpro/agent-rules/observability-capabilities.md
wc -c .devpro/agent-rules/observability-capabilities.md
```
