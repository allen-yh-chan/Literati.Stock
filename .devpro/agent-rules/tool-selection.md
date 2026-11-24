---
name: tool-selection
description: "GitHub 操作先用已登入的本機 gh；未安裝、未登入或前置探測無法判定時可用本人具等價閘門的 devpro-work MCP。"
---

# GitHub 工具選路

## Overview

選路只依執行者本機的認證與適用閘門證據，不用另一組權限掩蓋失敗。

## When to Use

任何 GitHub 查詢、搜尋、issue、PR、review、merge、workflow 或 git transport 操作前讀取。本規則適用各支援的開發端與 owner runtime；不改 M365、Notion、SSH 的選路。

## Process

1. 在實際執行者的隔離環境，以 `gh auth status --active --hostname github.com --json hosts` 觀察目前帳號。不得輸出 token；不得借用 host／其他 owner 的 gh 設定。
2. gh 已安裝、active account 登入有效，且目標操作有權限：MUST 優先 gh CLI，包括 read/search/write/PR/review/merge。原本的 git、footer、pre-PR、post-PR、CI 與 cross-model gates 照常。
3. executable 不存在（ENOENT）、明確未登入（有效 JSON 的 hosts 無帳號），或**尚未執行目標操作的 gh 前置探測**因舊版不支援 JSON、逾時、程序錯誤或無法解析而不能判定時，可選本人已授權的 devpro-work MCP。探測結果保留 `authentication=unknown`，不可偽稱已知未登入；MCP 仍獨立驗證原使用者與任務。MCP 不可用就回報阻擋。其他 provider 的 GitHub connector 未取得等價檢查，不因本條開放寫入；各 host 的既有寫入限制照常。
4. 明確 auth invalid、目標 repo/操作權限被拒，或已選定路徑的目標操作失敗（含網路失敗）：停止該操作，說明具體原因；MUST NOT 換到 MCP／另一帳號重試。寫入結果不明時先查結果，禁止換路徑重送。這些阻擋先於第3點的前置探測 fallback。CLI 原生權限與 Broker 權限獨立，撤銷 Broker 連線不會撤銷 gh 登入。
5. MCP 寫入前必須確認本 host 的 GitHub hook 已安裝、實際可攔截，並呼叫 `github_policy_status` 確認固定版本後端 policy artifact 可用且列出該操作。缺少、過期、不相容、逾時均拒絕寫入；不得自行提供 `allowed:true` 等證據。
6. MCP PR create/merge 使用目標 repo 的本機 checkout，保留 consumer pre-PR checks、local-test receipt 與 lineage/operator disposition。merge 前呼叫 `github_check_pr`，保留 exact repository/PR/head 的短期觀察；後端仍在真正寫入時重新收集 head、review、完整分頁與 CI，該觀察不是寫入許可。
7. MCP body/review 同樣需要本 session 的 Rules/Tool/Model footer；禁止代人發出 waiver/lineage approval。既有 branch/chore-A/Path W 豁免沿用共用判定，production 路由及 CI 不因 review 豁免而跳過。
8. 對**另一個 repo** 的 `gh pr create`／`edit`／`comment`：命令前加 `DEVPRO_CROSS_REPO_PR=<owner/repo>`，且命令明寫 target（`--repo <owner/repo>`／`-R` 或 PR URL；create 另需字面 `--head <branch>`），例：`DEVPRO_CROSS_REPO_PR=owner/repo gh pr comment 7 --repo owner/repo --body-file <abs-body-file>`。marker 與 target 都要寫字面值（`$VAR`、反引號、`*` 會被擋），只在同一個 Bash payload 有效，不涵蓋 `gh issue`、`gh api`、`gh pr review`、git write／clone（`gh pr merge`——同 repo 也算——與描述帶 waiver 的 `gh pr edit` 一律寫完整目的地：PR URL，或編號加 `--repo github.com/OWNER/REPO`（PR URL 旁再寫 `--repo` 時要寫 host 且指同一個 repo，否則擋；只寫 URL 最簡單）；描述帶 waiver 的 edit 只能在該 PR 的 checkout 執行，marker 不能代替；跨 repo merge 另需 `DEVPRO_PR_CHECKOUT`，規則見 `ai-autonomy.md` 第 6 項 Hub session 段）；另一條正解是在 target 的 checkout 內執行。`DEVPRO_HOOK_BYPASS` 不是此情境的建議路徑。明文殘留：沒寫 target 的 PR 寫入本 gate 不判定（帶 marker 則擋並要求明寫）；無 host 的 `--repo` 與目前 checkout 同 slug 時視為同 repo；`--repo`／`-R` 寫在 `gh` 與 `pr` 之間、`pr` 與動詞之間或動詞之後，本 gate 的 target 判定與 remote-only 的字面 `--repo`／`--head`、fork head 檢查都相同，但宣告 checkout 的 evidence 檢查、PR body template lint、per-PR waiver edit gate 只讀 `gh pr <verb> … --repo` 的寫法，所以 `--repo` 請寫在動詞之後；origin 是 ssh／scp 形式時，同 slug 而寫了別的 host 的 target 不判定（SSH host 無法對應 web host）。

禁止自動登入 gh、複製 OAuth/PAT、改全域 git credential helper。Skills 是操作指引；hooks 是可觀察的 client 檢查；Broker 驗證任務與遠端證據，三者不能互相替代。平台停用 hook、未載入 plugin 或無法觀察的原生工具仍屬 capability gap，AI 必須停止受影響寫入，不能把未覆蓋宣稱成 PASS。

## Exit Criteria

已選定可用路徑，適用的本機與遠端檢查都有證據；任何寫入的不確定結果尚未解除時不得重送。

## Common Rationalizations

- 「MCP 有權限就重試」：原本 gh 權限不足不是 fallback 條件。
- 「後端通過就可忽略本機」：後端看不到 consumer checks 與本機 lineage，client 義務仍保留。

## Verification

選路與共用政策入口：`.devpro/scripts/lib/github-tool-routing.mjs`、`hooks/lib/github-operation-policy.mjs`；client 入口：`hooks/github-mcp-gate.mjs`。部署協定及驗證矩陣見 [GitHub gates runbook](../../docs/github-operation-gates.md)。

```bash
node --test .devpro/scripts/tests/github-tool-routing.test.mjs .devpro/scripts/tests/github-operation-policy.test.mjs .devpro/scripts/tests/github-host-gates.test.mjs
```
