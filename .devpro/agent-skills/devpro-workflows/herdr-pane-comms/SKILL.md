---
name: herdr-pane-comms
description: "herdr 跨 pane／terminal／agent session 溝通與交接（先探測舊版 herdr CLI＋HERDR_ENV 與 Herdr app 的 hc＋HC_TERMINAL_SOCKET，再回答可否）。使用時機：使用者明示 herdr／Herdr／hc，或人已在 herdr pane／Herdr terminal 內並要求跟另一個 pane／terminal／agent／session 溝通、交接。不因「開個 pane 比較方便」自發使用。"
metadata:
  user-invocable: true
---

# Herdr Pane Comms

## Overview

本 skill 是 **host 上 herdr 系列 CLI** 的跨 session 交接 recipe，與 `cmux-surface-comms` 並列為可選傳輸工具。herdr 有兩種形態，訊號與指令都不同：

| 形態 | CLI | 在其內的訊號 | 目標單位 |
|---|---|---|---|
| 舊版 herdr（TUI） | `herdr` | `HERDR_ENV=1` | pane／agent |
| Herdr app（`herdr-core`） | `hc` | `HC_TERMINAL_SOCKET` 有值 | terminal（`t7` 這類位址） |

**Policy SSOT 留在 rule leaves**——同 change 的持久交接資訊仍寫進 `tasks.md`（git + `tasks.md` 是唯一共享狀態，見 `multi-agent-handoff.md`）；是否該委派見 `model-delegation.md`。本 skill 只覆蓋探測、觸發分流與 devpro 專屬守則。

**指令語法 SSOT 是已安裝的 binary**：兩者都在 1.0 前，本 skill 不抄指令細節；以 `herdr --help`（及 herdr 隨附的 `herdr` skill）或 `hc --help`、`hc <command> --help` 為準。

## When to Use

- 使用者**明示 herdr**（含 Herdr app、`hc`）→ 用本 skill
- 使用者要求跨 session 溝通／交接但**沒指名工具** → 先跑步驟 0：任一形態成立就用本 skill；兩者皆不成立才改走 `cmux-surface-comms` 的探測
- 其餘情況（只是覺得開個 pane 或平行處理會方便）→ **不得使用**

第二種情況是有意比 herdr 隨附 skill 多開的觸發（上游只接受明示 herdr）；使用者已明確要求跨 session 溝通，不屬自發使用。

## Out of scope

- `herdr integration install`／`uninstall`：會改使用者全域 agent 設定（Codex 的 `hooks = true` 卸載後不還原），屬 Ask First，本 skill 不代為執行
- 把 herdr／Herdr app 的 pane／terminal／agent 狀態當 review 或 merge gate 證據；不得接進 second-review dispatch
- `herdr server stop`、`hc server stop|restart`、`hc update`；關閉、`hc kill`／`hc rm` 非自己建立的 workspace／tab／pane／terminal

## Process

### 0. 先探測（防誤答「不行」，也防在 herdr 外亂控）

兩種形態都要探測，**任一成立**就在 herdr 內，不得回報「不在 herdr 內」。

POSIX shell：

```bash
command -v herdr >/dev/null 2>&1 && test "${HERDR_ENV:-}" = 1 && echo "herdr: usable" || echo "herdr: not usable here"
command -v hc >/dev/null 2>&1 && test -n "${HC_TERMINAL_SOCKET:-}" && echo "hc: usable" || echo "hc: not usable here"
```

PowerShell：

```powershell
[bool]((Get-Command herdr -ErrorAction SilentlyContinue) -and ($env:HERDR_ENV -eq '1'))
[bool]((Get-Command hc -ErrorAction SilentlyContinue) -and $env:HC_TERMINAL_SOCKET)
```

cmd：

```bat
where herdr >nul 2>nul && if "%HERDR_ENV%"=="1" (echo herdr: usable) else (echo herdr: not usable here)
where hc >nul 2>nul && if defined HC_TERMINAL_SOCKET (echo hc: usable) else (echo hc: not usable here)
```

cmd 那兩行在找不到 CLI 時不輸出任何字，無輸出一律視為該形態不可用。

- `herdr` 那行成立 → 用舊版 herdr 指令；`hc` 那行成立 → 用 Herdr app 指令；兩者都成立時以使用者指名的為準，未指名先問
- 只在兩者**皆不成立**時才回報「不在 herdr pane／Herdr terminal 內」，改走 `cmux-surface-comms` 探測；連 cmux 也沒有才可回報本機無跨 session 工具
- 只查到 CLI 但訊號不成立（例：Herdr app 裡 `herdr agent list` 回 `server_not_running`）不代表沒有 herdr，先跑完另一行
- 不在 herdr 內時**不得**從外部操作使用者正在看的 herdr session

### 1. 找目標

舊版 herdr：

```bash
herdr agent list
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
```

不要跑裸 `herdr`（會啟動 TUI）。

Herdr app：

```bash
hc ls
hc get <t>
```

不要跑裸 `hc`（會進入挑選並 attach）。

- ID、位址與 agent 名稱一律取自 JSON 回傳，不從畫面順序推測
- **辨識 Herdr app 目標看 `hc get <t>` 的 `foreground.cwd`／`foreground.argv`**，不看 `hc ls` 的 `cwd`：後者是 terminal 起始 shell 的目錄，之後在 shell 裡 `cd` 再開 agent 不會更新；`where` 是 Herdr 介面上的 space／tab 名稱，不是路徑
- 自己是哪個 terminal：`HC_TERMINAL_ID`；交叉核對時 `hc get <t>` 的 `foreground.pid` 會等於自己 shell 的 `$PPID`

### 2. 送出交接

- 同 change 的持久交接內容先寫進 `tasks.md` 並 commit
- 需要補充的長內容寫到 `notes/tmp/handoff-<topic>.md`，訊息裡給**絕對路徑**；這個檔只是**一次性傳話**，不是狀態，對方不得依賴它恢復工作
- 對方在另一台機器（`--machine`／`hc` 的 `machine/t7` 位址）或讀不到該路徑時，本機檔案到不了：改放進對方讀得到的已 commit 載體（同 change 即 `tasks.md`），或把內容直接寫進訊息
- 送出前先讀畫面確認對方**停在輸入框**：舊版 `herdr agent read <target> --source visible`；Herdr app `hc read <t>`（預設只印目前畫面）。舊版 herdr 會把首次啟動的信任／hooks 審核等對話框回報成 `idle`，此時送出的文字會被對話框吃掉
- 送出（一次送達，不需另補 Enter）：
  - 舊版：`herdr agent prompt <target> '<短摘要＋路徑>' --wait --timeout <ms>`
  - Herdr app：`hc send <t> '<短摘要＋路徑>' --wait --timeout <秒>`（單位是秒，不是毫秒）；不得加 `--force`，它會在對方 blocked 時照打，可能替對方回答對話框

### 3. 等待之後一定要核對

`--wait`／`herdr agent wait`／`hc wait` 都只是**喚醒訊號**：舊版的 wait 不綁定這一次請求，對方先前的工作結束或轉為等待輸入都會讓它返回；`hc send --wait` 雖綁定這次 send 開始的 turn，turn 結束也不等於工作完成。返回後 MUST：

1. 看狀態：`herdr agent get <target>`／`hc get <t>`；`blocked` 表示對方在等核准或提問，先讀再決定
2. 讀對方實際回覆：`herdr agent read <target> --source recent-unwrapped --lines <n>`／`hc read <t> --lines <n>`
3. 以 git 與 `tasks.md` 的成果判定是否完成

## 必守坑

1. **wait 返回不等於完成**：見步驟 3。
2. **timeout 或 stalled 不代表沒送達**：先讀對方畫面確認，不得直接重送同一則訊息。
3. **狀態會延遲、對話框會偽裝成 idle**：送 `prompt`／`send-keys`／`hc send`／`hc keys` 前先讀畫面確認對方真的在等那個輸入，不得只憑 `agent_status` 或 `hc` 的 `status`；舊版對方 `blocked` 時 `agent read --lines <n>` 會失敗，改用 `--source visible`。對方的核准／信任對話框由使用者決定，不代按。
4. **不搶焦點、不動別人的 pane／terminal**：舊版背景工作加 `--no-focus`；只關自己建立的 pane／terminal（ownership 規則見 `ai-autonomy.md`）。

## Exit Criteria

- 未先探測 `herdr`＋`HERDR_ENV` 與 `hc`＋`HC_TERMINAL_SOCKET` 兩種形態就不得斷言可或不可
- Herdr app 目標以 `foreground.cwd`／`foreground.pid` 辨識，不以 `hc ls` 的 `cwd` 辨識
- 持久交接在 `tasks.md`；交接檔僅為一次性傳話
- 宣稱對方完成前已讀回覆並核對 git／`tasks.md`

## Verification

```bash
grep -n 'HERDR_ENV\|HC_TERMINAL_SOCKET\|command -v herdr\|command -v hc\|Get-Command h\|where h\|foreground\.cwd\|tasks.md\|喚醒訊號\|integration install' .devpro/agent-skills/devpro-workflows/herdr-pane-comms/SKILL.md
```
