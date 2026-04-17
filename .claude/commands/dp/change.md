---
description: "開始新需求：建可促進單位分支（feature/bugfix/chore）+ OpenSpec change（AGENTS.md §2）"
---

STOP — 先用讀檔工具讀取 `AGENTS.md` 全文，確認行為邊界與本次相關章節。

接著讀取以下兩份文件：
1. `agent-rules/openspec-flow.md` 全文（consumer repo 路徑為 `.devpro-agent-rules/agent-rules/openspec-flow.md`）
2. `agent-rules/sync-devpro-agent-rules.md` 全文（consumer repo 路徑為 `.devpro-agent-rules/agent-rules/sync-devpro-agent-rules.md`）

讀完後，根據參數決定 change 名稱：
- 若 $ARGUMENTS 已提供具體名稱（如 `add-export-retention`）：直接使用
- 若 $ARGUMENTS 是需求描述（如「匯出功能加上保留期限設定」）：AI 自行轉為 kebab-case 名稱
- 若 $ARGUMENTS 為空：詢問使用者需求內容，再由 AI 命名

依 openspec-flow.md 的「OpenSpec + Branch checklist」逐步執行。**使用者 invoke `/dp:change` 即視為對本 command 內定義之標準 git 序列的一次性同意**（見 `agent-rules/git-branch-and-pr-flow.md`「Slash command 批次同意」），AI 不需逐步再問；偏離標準序列才重新徵詢。重點：
- **前置檢查**：`git status --porcelain` — 若有 uncommitted/untracked 變更（除 `.devpro-agent-rules`/`AGENTS.md`），停下問使用者（stash / commit / discard / 帶著 WIP 進新分支），不可擅自決定
- 步驟 0：`git fetch origin main:main --tags`（不 checkout main，不從 main 建分支）
- 步驟 0a：`git submodule update --init --remote .devpro-agent-rules`（僅更新工作副本，先不 commit；確保 0b/0c 用最新 script）
- 步驟 0b-0c：掃描可刪除分支（跳過 keep 清單）、計算 anchor
- 步驟 1：依需求類型選前綴（feature/bugfix/chore/hotfix）與基底（anchor 或 production-* tag）
- 步驟 1b：建完分支後收尾 submodule 同步 commit（依 sync-devpro-agent-rules.md 標準同步流程 step 2-4），message 為 `chore: sync devpro-agent-rules (<short-sha>)`

依「tasks.md 品質要求」建立 tasks，並依「驗證證據」確認完成。

**禁止**：在建立 OpenSpec change 前寫任何實作程式碼。
