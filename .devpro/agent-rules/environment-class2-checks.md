---
name: environment-class2-checks
description: 環境 diagnostics 三分類，以及 devpro:change 共同 class ② 環境檢查入口（dp-change-environment-checks.mjs）各 stage 的判定與寫入行為：core.hooksPath、core.symlinks、runtime auto-compact 建議值與確認、GitHub merge policy、fail-open 條件、submodule.recurse 選項。觸發：入口提示確認、回報 skipped／risk／blocked，或新增／審查環境 diagnostic 時。
---

# Environment Class ② Checks

> Load-chain：本檔由 `environment-setup-nvm-nodejs-openspec.md` Process step 8 按需載入；執行指令、stage 排序、`openspec-cli` blocked 規則、class ② 的執行時機與回報格式留在該檔。入口全部 quiet 通過、未提示確認時不必讀本檔。

### Diagnostics 三分類

環境 diagnostics 依 delivery/reachability 分三類：class ① 是可由 versioned output 或 submodule 交付的狀態，只由 raw rules sync/check 處理；class ② 是 user、machine、clone-local 或 external-service 狀態，MUST 在 `devpro:change` startup 的共同入口執行，且 raw `sync-agent-rules.mjs --sync` / `--check` MUST NOT query、prompt 或 write；class ③ 是 rules lane workflow state，只由 `devpro:sync-rules` 處理。新增 raw-sync diagnostic 必須先留下 class 與 owner 證據，不能因為「與 repo 有關」就默認歸 class ①。

### 入口各 stage 行為

- clone-local `info/exclude`：只在確認目標 repo 尚未導入 Devpro 時檢查。缺少 Devpro 本機排除項時，列出擬追加的規則，說明所有 worktree 共用此檔，並在使用者回 `y/yes` 後追加。沒有互動輸入、拒絕、身分不明或目標無法安全讀寫時，回報 risk，保留原檔。排除項以 `dp-change-environment-checks.mjs` 的 `LOCAL_EXCLUDE_PATTERNS` 為準。
- clone-local `core.hooksPath`：unset／owned（含 owned-stale／legacy relative）→ 用 argv-form git 寫入 main worktree 的 absolute `.devpro/scripts/hooks-git`；foreign／husky 保留 hooksPath，以最內層包含 discovery hook 的 registered worktree index 確認 untracked，才自動 chain deletion guard；tracked hook（含 index 有記錄但工作檔刪除）MUST NOT 自動改寫或建立 backup。helper 僅接受 LF、去除空行／shell comment 後只有一條 repo-relative `exec node .devpro/scripts/hooks-git/pre-push.mjs` 或 `exec .devpro/scripts/hooks-git/pre-push`（可帶 `"$@"` 或前導 `./`）且目前執行 worktree 的 target 是 regular file 的委派；ordinary hook 與 extensionless target 還須 executable，ordinary hook 須 `#!/bin/sh`。成立才 compliant；複合／條件式／其他格式、缺 target 或 tracking 無法確認均 risk 且不寫檔，手動指引為 `exec node .devpro/scripts/hooks-git/pre-push.mjs "$@"`，由 consumer 自行整合既有 hook 邏輯（保留複合邏輯時窄版判定仍 risk）。若 tracked hook 含舊 chain marker，先比對 Git index、目前 hook 與 `.devpro-wrapped` backup，保留原始邏輯後手動還原 intended tracked hook，再移除 obsolete backup；helper 不自動還原／清理。tracking 無法確認時先核對 destination worktree 與 index 存取，再重試；不得執行任意 consumer hook 來探測。owned-absolute 已正確則 no-op；無法 discovery/write／越界 destination 則明確 risk 並繼續（不得為 chain 失敗而覆寫 foreign hooksPath）
- clone-local `core.symlinks`：先在該 repo 檔案系統的 disposable 目錄 probe relative directory symlink（與 skill discovery 同型別），驗證 link 型別、directory target 與 realpath，finally 清理；建立、準備、驗證或清理失敗須保留 phase／error code（不回傳 raw error／絕對路徑），且不得把失敗 object 當 truthy 能力證據。prepare 失敗指向 repo 路徑／存取權限；create 的 EPERM／EACCES 指向 symlink privilege／目的目錄權限，Windows 可引導 Developer Mode 或 Create symbolic links 權限但不斷言唯一根因；ENOSYS／ENOTSUP／EOPNOTSUPP 指向檔案系統／share 支援；其他錯誤保留 code 並引導 storage／target 排查，cleanup 失敗指出本輪殘留 disposable 目錄。修復後重跑 startup，再 --sync 建立並驗證真正入口；capable 且 config 非 `true` 才用 argv-form `git config core.symlinks true` 修復；已 `true` 則 no-op；OS incapable 永不設 `true`（risk continue）。native probe 的 Developer Mode／config reminder 僅用於 create 的 EPERM／EACCES，其他 phase／code 不給 Developer Mode 建議；legacy boolean-false 注入保留一般提醒。Windows Developer Mode（或等價 OS symlink 能力）**不會**回頭改寫既有 clone 的 `core.symlinks`；具能力後需手動設 true 或重跑 `devpro:change`，再 `--sync`
- PATH 找得到 `claude` 時，檢查目前 shell 對應 profile（zsh/bash/Windows PowerShell）的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 是否已等於新建議值（WINDOW=500000、PCT=80、effective=400000，三者分開命名，禁把 effective 報成 WINDOW）；缺設定、高於或低於新建議皆提示並印 current vs recommended 對照表，使用者回 `y/yes` 才寫入
- PATH 找得到 `codex` 時，檢查 `~/.codex/config.toml` 的 `model_auto_compact_token_limit` 是否已等於建議值 400000；缺設定、高於或低於新建議皆提示並印 current vs recommended 對照表，使用者回 `y/yes` 才寫入
- skip/risk（含非互動 stdin）MUST 印上述對照表；`skipped-without-table is not environment-complete`。非互動時另印 `real TTY via devpro:change startup`；`/devpro:init` 只報告、MUST NOT write HOME auto-compact
- session confirmation equals y/yes：同一 session 已確認套用建議值（含「兩項都改」）即等於本 prompt 的 `y/yes`；superseded comments MUST NOT reopen Ask First；寫入常數仍是 WINDOW=500000、PCT=80、Codex 400000
- GitHub merge policy：只 query 一次 typed settings；merge commit 已啟用且 squash/rebase 已關閉才是 quiet compliant，否則只有 ADMIN + interactive stdin + 明確 `y/yes` 才以一個 atomic argv-form edit 啟用 merge commit 並停用 squash/rebase；失敗不可洩漏 raw payload、stderr 或 token
- runtime 未安裝、shell 不支援、非互動 stdin、使用者拒絕、或個人設定檔不可安全讀寫 → 全部 fail-open，列 skipped/風險但不使 environment setup 失敗
- 不由入口檢查或寫入、使用者自行決定：consumer 其他 clone（cloud routine、同事、另一台電腦）`git pull` 後 `.devpro-agent-rules` 會停在舊 commit（`git submodule status` 開頭 `+`）；`git config --local submodule.recurse true` 讓之後的 `git pull` 自動對齊已初始化的 submodule，未初始化（`-`）的仍須 `git submodule update --init .devpro-agent-rules`。它也改變該 clone 的 `checkout`／`pull`／`reset`／`switch` 對 submodule 的行為，所以入口不代寫；對齊檢查見 `devpro-doctor.mjs` 的 `submodule checkout` 與 `git-workflow-tracking.md` §Post-merge Local Sync
