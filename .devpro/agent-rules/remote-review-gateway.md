---
name: remote-review-gateway
description: 遠端審查（Hermes）經 RunnerRelay SSH gateway 的連線契約：共用事實進 repo、每位使用者自己的 gateway 帳號留在 repo 外，未設定或連不上即 fail closed 交棒。觸發：遠端審查、RunnerRelay、Hermes、`rr` 指令、demo gateway 連線時。
---

# Remote Review Gateway

## Overview

遠端審查的入口是 RunnerRelay SSH gateway。host／port／`rr` 用法是全員共用事實，寫在本檔；gateway 帳號與金鑰是每位使用者各自的，只放使用者自己的 `~/.ssh/config`，不進 repo。

## When to Use

觸發：要把審查送到遠端（Hermes）、使用 `rr`、或驗證 gateway 連線。不觸發：本機審查（照 `second-review` skill）；部署與改 Hermes 設定（不在本檔授權範圍）。

## Rules

### 在 Hermes 等共用代理的 run 裡不適用

當這個 agent 本身跑在 Hermes（或其他共用代理）的 run 裡，工作 prompt 已經指定連線方式與身分（多數情況是該代理自己的服務帳號，例如 `hermes-agent`），照 prompt 給的方式連線即可：

- 本檔的個人 `~/.ssh/config` alias、gateway 帳號與「沒設定就問使用者」**不適用**；不要因為自己的環境沒有 `devpro-runnerrelay` alias 就停下。
- 這條只放寬「怎麼連」，**MUST NOT** 一併放寬 `MUST NOT`：仍然不得輸入密碼、不得 `StrictHostKeyChecking no`、不得為連線失敗放寬 firewall／TLS／auth／權限、不得輸出 `.env` 或 key 值。
- 反過來，若你確認自己不在代理的 run 裡（是本機開發者身分），就不再適用本節，照下面的個人設定做。

### 共用事實

- gateway：`demo.devpro.com.tw`，port **20222**。只此一條通道；**MUST NOT** 試其他 port。
- `rr` 是 gateway 上的指令，不是本機指令；經 ssh 執行，慣用 alias 形式 `ssh devpro-runnerrelay rr <子命令>`。尚未設 alias 時，可改用帶 `IdentitiesOnly=yes`、`BatchMode=yes`、`StrictHostKeyChecking=yes` 的完整 ssh 指令（帳號與金鑰位置取自使用者本人給的輸入）；沒設 alias 本身不是停點。子命令不加引號、不含 shell 特殊字元（cmd.exe 不認單引號）；長 payload 走 stdin。
- 兩種登入形式：登入名稱只填 `<principal>` 是 catalog，只能跑 `rr` 子命令（`targets`／`doctor`／`bridges`／`wiki`／`skill`／`download` 等固定集合，沒有送審類子命令）；登入名稱填 `<principal>+devpro-demo-01` 是 target shell，指令由 target 的 Windows shell 解讀，身分是 target 上設定的 Windows 帳號，不是 gateway principal，也不是 `hermes-agent`。target 的 sshd 轉送政策以 target wiki 為準，**MUST NOT** 為了轉送而放寬。
- 先讀 `rr skill` 再選 target；target 為 `devpro-demo-01`；`rr targets --json` 的陣列鍵是 `items`；**MUST NOT** 傾印全部 target metadata。
- RunnerRelay 負責傳輸／API；唯一多做的一件事是替 `hermes review submit` 簽發建立者 proof（見送審入口）。審查 worker、git／worktree 寫入與遠端審查 CLI 的執行身分一律是 Hermes 的 `hermes-agent` 服務帳號，不是提交者的 gateway 帳號；**MUST NOT** 宣稱能防管理員的 ACL 隔離。

### 個人設定（repo 外，每位使用者各自一次）

alias 固定兩個，寫在使用者自己的 ssh config：`devpro-runnerrelay`（catalog，跑 `rr`）與 `devpro-runnerrelay-demo`（target shell，只在需要 target shell 時才用）。位置：macOS／Linux／Git Bash 是 `~/.ssh/config`，Windows 是 `%USERPROFILE%\.ssh\config`（內建 OpenSSH client 讀同一份）。尖括號內自行替換，帳號由管理員核發；`IdentityFile` 可寫 `~/.ssh/<key>`（Windows OpenSSH 同樣展開 `~`）：

```
Host devpro-runnerrelay
  HostName demo.devpro.com.tw
  Port 20222
  User <your-gateway-user>
  IdentityFile <your-private-key>
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  ConnectTimeout 10

Host devpro-runnerrelay-demo
  HostName demo.devpro.com.tw
  Port 20222
  User <your-gateway-user>+devpro-demo-01
  IdentityFile <your-private-key>
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  ConnectTimeout 10
```

**何時寫入**：只在首次設定寫一次；之後每次使用只做唯讀檢查，不再動這個檔。

1. 檢查（離線、不連線）：`ssh -G devpro-runnerrelay`，輸出含 `hostname demo.devpro.com.tw` 與 `port 20222` 才算已設定（沒設定時會回 `hostname devpro-runnerrelay`、`port 22`）。找不到 `ssh` 指令一樣視為未就緒（Windows 需使用者自行啟用 OpenSSH Client）。
2. 未設定 → 先看使用者是否已在對話、交接檔或其給的指令中提供自己的帳號與金鑰位置（有就直接用於本次連線，不再追問）；都沒有才依 Fail Closed 交棒請使用者提供。**MUST NOT** 未經同意自行寫入 ssh config；使用者明確同意後，才可把上方區塊**追加**到該檔（檔案不存在則建立；已有同名 `Host` 區塊 → 不覆寫，交棒）。
3. 追加後跑驗證指令；失敗就移除剛追加的區塊並交棒。第二個 alias 僅在需要 target shell 時才驗證（`ssh devpro-runnerrelay-demo hostname`，唯讀）。

**Windows 注意**：

- 寫檔用 Write／Edit 工具；**MUST NOT** 用 Windows PowerShell 5.1 的 `>`／`>>`／`Out-File` 預設編碼（UTF-16／BOM 會讓 ssh 讀不到設定）。
- ssh 報 `UNPROTECTED PRIVATE KEY FILE` 或 `Bad owner or permissions` → 停下交棒，由使用者收斂金鑰檔 ACL；AI 不代改金鑰檔權限，也不用選項繞過檢查。

**MUST NOT** 猜帳號、從他人設定或歷史複製帳號／金鑰路徑；**MUST NOT** 把 `User`、`IdentityFile` 的實際值寫進 repo、PR、log、sticky、交接檔、request payload 或 evidence。

驗證：`ssh devpro-runnerrelay rr targets --json`；`items` 含 `devpro-demo-01` 才算通。

### Fail Closed

沒有已設定的 alias 且使用者也沒給直連 ssh 參數（帳號與金鑰位置）、認證失敗、timeout、host key 不符、`items` 不含 `devpro-demo-01` 任一項 ＝ 遠端審查 **unavailable**：停下交棒，附上方 alias 範本與「設定好後重跑」；是否改走本機審查由使用者決定。

- 遠端路徑 **MUST NOT** 改用任何本機 reviewer CLI 探測或 fallback，**MUST NOT** 由 Hermes 自行給 verdict。
- **MUST NOT**：輸入密碼、`StrictHostKeyChecking no`、為連線失敗放寬 firewall／TLS／auth／權限、輸出 Hermes `.env` 或任何 key 值。
- 交棒格式見 `stop-point-comms.md`。

### 邊界

wiki write、部署、改 Hermes／IIS／服務設定，各需使用者另行具體授權；本檔只授權連線與唯讀查詢。

### 送審入口（開發者端）

`node .devpro/scripts/run-remote-review.mjs`（`submit`／`status`／`result`／`cancel`／`purge`）經上面的 target-shell alias 呼叫遠端 review bridge；`submit` 走 Gateway 自有 verb（見下），其餘子命令經 demo server 上管理員安裝的 bridge wrapper `C:\ProgramData\Devpro\Hermes\Home\scripts\remote-review\review-bridge.cmd`（client 內建為預設，不必設定；可用 `DEVPRO_REMOTE_REVIEW_BRIDGE_COMMAND` 覆寫）。已推送的 head 免上傳，未推送的 head 改以 Git bundle 上傳（另需 `DEVPRO_REMOTE_REVIEW_STAGING_PATH`）。

- `submit` 以 `ssh -T`（無 PTY）執行恰好 `hermes review submit`，請求 JSON 單行走 stdin（上限 262145 bytes）；多一個字，或用換行、Unicode 空白分隔，都不是這個 verb，會被當一般指令轉送。stderr 的 `request id:` 是診斷，不是失敗。**MUST NOT** 為了繞過錯誤改回直接呼叫 bridge 的 `submit`（那條路徑不帶 proof；已升級的 bridge 對沒有 proof 的 `submit` 直接回 `gateway_proof_required`，不記建立者）。
- 建立者：Gateway 對這份請求簽 proof，bridge 驗證後才記錄；回到本機的只有不透明代號 `creator_ref`（16 位小寫 hex），submit 摘要與回條都帶它。`null` 表示「沒有記錄建立者」（伺服器尚未升級到要求 proof 的版本，或該 request_id 在要求 proof 之前就已建立），不是失敗，**MUST NOT** 補填或推測。它是代號不是匿名（Gateway ID 可被猜），建立者是 Gateway SSH ID、不一定是個人；原值只存在伺服器端。偽造需要 Gateway 簽章金鑰或換掉信任檔，proof 被保存所以偽造可被發現、但無法防抹除，**MUST NOT** 宣稱 ACL 隔離。
- 失敗與 bridge 同形 `{"error":{"code","message"}}`：exit 2、3 是送出前的拒絕（例如 `gateway_review_unavailable`＝該 target 尚未設定 review profile，找管理員，不是重試能解）；exit 4–6（例如 `gateway_result_unknown`）可能已送出，用同一個 `--request-id` 重試，bridge 冪等。
- `status`／`result`／`cancel`／`purge` 不帶建立者 proof，bridge 也不核對誰是建立者：能登入 target shell 的人，只要知道 request id，就能查、取消或清除任何請求。client 只對本機留有紀錄的 id 動作，那是防呆，不是權限邊界，**MUST NOT** 宣稱只有建立者能取消或清除。
- 只支援 `dp-reviewer` 的 `ordinary-primary` 與 `dp-second-reviewer` 的 `audit-only`；`pr-sticky` 遠端**拒絕**（`mode_not_supported_remote`），不降級成別的模式。
- 目前已安裝的遠端 worker 只實作 `ordinary-primary`；`audit-only` 會以 `mode_not_supported` 失敗，同樣不降級、不換成別的審查者。
- `--base` 必須是 `--head` 的祖先（目標分支的 merge-base）；不是祖先時遠端回 `base_not_ancestor`，不會審一份反向的 diff。
- 已 commit 的 base／head 才送；有未 commit 的 tracked 變更即 `target_dirty` not-ready，**MUST NOT** 代為 stash、commit 或捨棄。
- 本機 repo 是 shallow clone 時，repo binding 只計 commit 物件確實沒有 parent 的根；一個真根都看不到即 `target_unresolved`（先 `git fetch --unshallow`）。仍有被截斷隱藏的真根時，worker 會回 `repo_binding_mismatch`，同樣先補完歷史，不可放寬比對。
- `result` 必須通過既有 reader 與「本機 HEAD、tracked 檔自送出後未變」檢查才算數；回條 `sealed_admission: false`，**MUST NOT** 當成 runtime sealed admission 或 merge-gate 憑證，也 **MUST NOT** 重鑄成本機 sealed control evidence。
- bridge 或 Gateway 的 `hermes review submit` 尚未部署或未設定（`gateway_review_unavailable`，或該指令被當一般指令轉送後失敗），或 `review-bridge.cmd` 沒裝（其餘四個子命令回 `transport_failed`）即 unavailable：依 Fail Closed 停下交棒。

## Exit Criteria

- 已連到 `demo.devpro.com.tw` port 20222，且 `rr targets --json` 的 `items` 含 `devpro-demo-01`：alias 形式以 `ssh -G devpro-runnerrelay` 顯示 host 與 port，再跑 `ssh devpro-runnerrelay rr targets --json`；未設 alias 時改用共用事實所述的完整 ssh 指令（同 host、同 port）跑同一個 `rr targets --json`。
- 未達成者已依 Fail Closed 停下交棒；沒有任何帳號、金鑰路徑或 key 值進入 repo、PR、log、sticky、交接檔或 evidence。

## Common Rationalizations

| 藉口 | 現實 |
|---|---|
| 「連不上就先用本機 reviewer CLI 代審一份」 | 遠端審查 unavailable 就是 unavailable；是否改走本機由使用者決定，不由 AI 默默改路。 |
| 「把 gateway 帳號寫進 rule，大家複製就能用」 | 每位使用者帳號不同；repo 只放 placeholder，真值留在各人的 ssh config。 |
| 「連線失敗，放寬 firewall／host key／權限試試」 | 連線失敗是交棒訊號，不是授權放寬安全設定。 |

## Verification

```bash
node .devpro/scripts/tests/remote-review-gateway-grep.test.mjs
ssh -G devpro-runnerrelay
ssh devpro-runnerrelay rr targets --json
```
