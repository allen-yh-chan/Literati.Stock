---
name: load-plan
description: "列出目前 session 中已載入 vs. on-demand loadable 的 rules、commands、agents 與 hooks，並附 byte/token 估算。使用時機：使用者 invoke /devpro:load-plan，或 TL 需要 debug 哪些規則已在 context 中、哪些是 trigger-loaded。"
metadata:
  user-invocable: true
  argument-hint: "/devpro:load-plan"
---

# Devpro Load Plan

## Overview

本 skill 是 Devpro load-plan observability 流程的 routing 與操作步驟載體。用於產出一張表，列出每個 rule/command/agent/hook 來源目前是已載入還是 on-demand，並附估算 token 成本。

**Policy SSOT 留在規則 leaf——本 skill 不重複其內容。** 本 skill 是 Claude Code adapter implementation；shared capability spec 的權威定義見 `.devpro/agent-rules/observability-capabilities.md` 的 `Load-Plan Capability`。務必讀取並執行該 spec 以取得該能力的權威樣貌，而非依賴本 skill 的摘要。

## When to Use

使用者執行 `/devpro:load-plan`，或 TL 需要 debug「哪些規範已在 context / 哪些需按 trigger 讀取」時。

## Process

輸出一張 load plan 表，列出下列來源：

1. `AGENTS.md` always-loaded sections
2. `AGENTS.md` 觸發式載入索引 table 中的 leaf rules
3. `.devpro/agent-skills/*/*/SKILL.md` skill manifest
4. `.claude/agents/*.md` subagent manifest
5. `.devpro/scripts/hooks/*.mjs` hook scripts
6. runtime config：`.claude/settings.json`

每列必含：

| 欄位 | 說明 |
|---|---|
| status | `[loaded]` 或 `[on-demand: <trigger>]` |
| path | repo-relative path |
| bytes | 檔案 byte count |
| est_tokens | `Math.ceil(bytes / 3.5)` |
| why | 已載入原因或觸發條件 |

### Collection Rules

- `AGENTS.md` Core Contract / Intent / §0 摘要視為 `[loaded]`
- `AGENTS.md` 觸發式載入索引內 leaf 視為 `[on-demand: <情境欄>]`
- command 檔視為 `[on-demand: /devpro:<name>]`
- agent 檔視為 `[on-demand: subagent:<name>]`
- hook script 視為 `[on-demand: hook:<event>]`；若 event 需從 `.claude/settings.json` 解析，列出 matcher
- 找不到檔案時列 skipped row，不宣告 loaded

### Suggested Shell

可用 `wc -c`、`rg --files`、`node -e` 產生清單；輸出預計很長時，只列 top-level summary + requested detail section。

Token 估算公式固定：

```js
Math.ceil(bytes / 3.5)
```

## Output

先輸出摘要：

```text
Load Plan
- loaded: <n> files / <tokens> est tokens
- on-demand: <n> files / <tokens> est tokens
- skipped: <n> files
```

再輸出表格：

| status | path | bytes | est_tokens | why |
|---|---:|---:|---:|---|
| `[loaded]` | `AGENTS.md` | `<bytes>` | `<tokens>` | project instruction / core contract |
| `[on-demand: 修 bug/fix]` | `.devpro/agent-rules/openspec-branch-routing.md` | `<bytes>` | `<tokens>` | AGENTS.md trigger index |

## Exit Criteria

- 表格至少涵蓋 AGENTS.md、leaf rules、commands、agents、hooks
- 每列都有 `[loaded]` 或 `[on-demand: <trigger>]`
- token estimate 使用 `Math.ceil(bytes / 3.5)`
- 找不到的檔案列 skipped，不硬湊數字

## Verification

```bash
node .devpro/scripts/lint-agent-skills.mjs
```
