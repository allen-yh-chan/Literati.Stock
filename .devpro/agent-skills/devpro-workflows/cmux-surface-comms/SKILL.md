---
name: cmux-surface-comms
description: "cmux 跨 surface／頁籤／視窗 session 溝通與交接（probe CLI 後再回答可否）。使用時機：使用者問能不能跟另一個頁籤／視窗／surface 溝通、交接給另一個 Codex／Claude／session、跨 session 交接，或明示 cmux。"
metadata:
  user-invocable: true
---

# Cmux Surface Comms

## Overview

本 skill 是 **host 上 cmux CLI** 的跨 surface 交接 recipe。Agent 不得只因自己 runtime 的 session/tool 清單沒有對方，就回答「不能和其他頁籤溝通」。

**Policy SSOT 留在 rule leaves**——同 change 內 OpenSpec 分工／tasks 狀態機仍見 `multi-agent-handoff.md`；本 skill 只覆蓋 **cmux Unix-socket CLI** 探測與 copy-execute 序列。

## When to Use

- 使用者問能否與 **另一個頁籤／視窗／surface** 溝通或交接
- 要 **交接給** 另一個 Codex／Claude／agent session
- **跨 session** 溝通／handoff
- 明示 **cmux**

## Out of scope

- `cmux new-surface --type agent-session`（未在本 skill 驗證；勿當預設路徑）
- 把整份長交接文直接 `cmux send` 進 TUI composer（見坑 1）

## Process

### 0. 先探測（防誤答「不行」）

```bash
CMUX="$(command -v cmux 2>/dev/null || true)"
if [ -z "$CMUX" ] && [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]; then
  CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"
fi
if [ -z "$CMUX" ]; then
  echo "cmux CLI not found on PATH or macOS app-bundle fallback" >&2
  # 此時才可回報本機無 cmux CLI
else
  echo "using CMUX=$CMUX"
fi
```

- `$CMUX` 非空 → 可以交接；**後續所有 cmux 呼叫一律用 `"$CMUX"`**（勿再寫裸 `cmux`，否則 fallback 路徑會假陽性）
- `$CMUX` 空 → 才可回報本機無 cmux CLI（仍可請使用者安裝／把 CLI 放進 PATH）

以 `command -v cmux` 為主；macOS app bundle 路徑僅在 `-x` 可執行時作 fallback，**不要寫死**為唯一依賴，也**不要**用 `ls` 當存在性探測。

### 1. 找目標 surface

```bash
"$CMUX" workspace list --id-format both
"$CMUX" list-pane-surfaces --workspace workspace:<n> --id-format both
```

Target 可用 UUID、short ref（`workspace:2`／`surface:4`）或 index。

**身分核對**：用 `read-screen` 看對方畫面尾行 status bar（session id／cwd／model）。cmux surface UUID **不等於** agent session id——不要用 session id 去跟 `list-pane-surfaces` UUID 比對後宣稱找不到。

### 2. 長內容寫檔，只 send 短指路

```bash
# 例：notes/tmp/handoff-<topic>.md（repo 暫存慣例；notes/ 通常 gitignored）
"$CMUX" send --surface surface:<n> '請讀 <path>，那是給你的交接。摘要：...'
```

### 3. 確認停在 composer，再送出

```bash
"$CMUX" read-screen --surface surface:<n> --lines 14
"$CMUX" send-key --surface surface:<n> Enter
"$CMUX" read-screen --surface surface:<n> --lines 20
```

畫面應出現 Working／等效狀態。

## 兩個必守坑

1. **長篇多行勿直接 `send`**：`cmux send` 把 `\n`／`\r` 當 Enter；多行會被拆成多則殘缺訊息。長文寫檔，只 send 短摘要＋路徑。
2. **`send` 不會送出**：文字只進 composer；必須 `read-screen` 確認後再 `send-key Enter`。

## Exit Criteria

- 未先探測 cmux 就不得斷言「無法跨頁籤溝通」
- 長交接落檔；短 send + `send-key Enter` 完成送出
- `new-surface` 未經驗證不得當預設

## Verification

```bash
CMUX="$(command -v cmux 2>/dev/null || true)"
[ -n "$CMUX" ] || [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]
grep -n 'CMUX=\\|command -v cmux\\|"\$CMUX"\\|send-key Enter\\|handoff-' .devpro/agent-skills/devpro-workflows/cmux-surface-comms/SKILL.md
```
