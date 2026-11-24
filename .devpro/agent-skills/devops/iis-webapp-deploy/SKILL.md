---
name: iis-webapp-deploy
description: "把 .NET／IIS 應用部署到既有站台（Framework 4.x、.NET Core、Blazor WASM）：探明站台、備份、打包上傳、停 pool、同步檔案、起站驗證、必要時回退。使用時機：要換版或修好 bug 後上到 IIS 站台、部署失敗要回退，或問「這台 IIS 上的應用怎麼換版」。"
---

# IIS 應用部署（通用）

適用任何既有 IIS 站台；專案若有自己的部署腳本（例如 `deploy-<app>.ps1`），**優先跑腳本**，這頁只補它沒涵蓋的通用步驟。

## 什麼時候可以部署

同時成立才動：

- 要上的版本已建置完成、測試綠、commit／tag 明確。
- 目標站台與**目前線上版本**已知，且回退點存在。
- 目標站台沒有人正在部署（同一站同時只允許一個部署）。

不成立就停：版本不明、測試沒過、站台正在換版、或只是「先上看看」。

## 遠端存取

- 一律 SSH 到**有權限的 admin target**（公司 demo 是 `Port 20222`），用本人憑證；不留存、不改 ssh config。
- 需要多行 PowerShell 時用 `ssh_powershell_execute`（單一 `-EncodedCommand`）；`ssh_execute` 只跑單行。

## 步驟

1. **探明目標**
   - `appcmd list site`／`list app`／`list apppool`：找站台、應用路徑與 app pool 名稱。
   - 讀目前 `physicalPath` 與 worker 載入的版本字串，寫下來當回退點。
2. **備份**
   - 至少保留目前 `bin\`、`Web.config`／`appsettings*.json` 與站台 `physicalPath`。
   - 專案已有釋出目錄（`Releases\<release>`）時，回退點就是上一版目錄，不必再複製。
3. **打包與上傳**
   - 本機把 publish 輸出壓成一個 zip（避免逐檔上傳導致版本不一致）。
   - `ssh_upload_file` 分段上傳到 target 的暫存目錄（>2 MiB 自動分段；最後一段 `offset` 要接續）。
   - 在 target 用 `Expand-Archive` 解到 staging；解壓後比對檔案數，不符就停。
4. **停站（避免鎖檔）**
   - 先 `Stop-WebAppPool <pool>`，輪詢到 `Stopped`。
   - `appcmd list wp` 找該 pool 的 worker PID，必要時 `Stop-Process -Force`；只停這個 pool，不要 `iisreset`（整機會中斷其他站）。
5. **同步檔案**
   - 專案有部署腳本 → 跑它（例如 `.\deploy-<app>.ps1 -SourceDir <staging>`）。
   - 沒有腳本 → `robocopy <staging> <physicalPath> /MIR /R:2 /W:2`；`/MIR` 會刪掉目標多出來的檔案，確認 staging 是完整內容再用。
   - Blazor WASM 注意：`_framework` 必須整包同步，只換部分 `.wasm` 會讓 `blazor.boot.json` 的雜湊對不上、瀏覽器卡在載入畫面。
6. **起站與驗證**
   - `Start-WebAppPool`，等站台回應。
   - 驗證不能只看 200：健康檢查端點、一個會觸發實際邏輯的 smoke、Application 錯誤數為 0、載入的版本字串等於要上的版本。
7. **回退（失敗時）**
   - 停 pool → 還原備份（或把 vdir 指回上一版目錄）→ 起站 → 重跑同一組驗證。
   - 回退後回報 `rolled back`，不要宣稱部署成功。

## 失敗與停損

- 結果不明（SSH 斷線、輸出截斷）：先讀站台與 pool 現況，**不要重送**同一個切換或覆蓋指令。
- pool 停不下來、檔案仍被鎖：找出 worker PID 再處理；不要整機重啟。
- 磁碟不足、來源檔案數異常、版本字串不符：停下回報，不要硬上。
- 需要改 `appsettings*.json`／憑證時：先問，不要順手覆蓋。

## 回報

- 站台、pool、版本字串、上傳與部署時間、驗證結果（健康檢查／smoke／錯誤數）、回退點。
- 未驗證的項目要寫出原因；不要把「health 200」當成部署成功。
