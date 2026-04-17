## Why

Vertical slice 三段(ingest → transform → signal)已在 production image 上跑通,30+ 真實 `volume_surge_red` 事件落地。最後一哩是把命中訊號**推到你手機** —— 目前唯一缺的組件。LINE Notify 已於 2025-03-31 停止服務;LINE Messaging API 須建官方 channel + bot 審核,對 MVP 是過重投資。Discord Webhook 是最輕量選擇:一個 URL、POST JSON、跨平台有手機通知。此 change 把訊號評估輸出閉環到使用者,MVP 正式可交付。

## What Changes

- 新增 `NotificationChannel` Protocol(`publish_daily(dispatches, as_of) -> None`)
- 新增 `DiscordWebhookChannel`(httpx POST Discord API 的 JSON embed)
- 新增 `NotificationService.publish_daily(as_of)`:對每個註冊訊號讀 `signal_event` 當日列,有命中才構造 embed 送出;空集合 no-op(不 spam)
- 新增 embed 格式化邏輯:標題 + 綠色色塊(爆量是買訊)+ 每股一個 field(id+名稱/vol ratio/漲幅/close)+ footer
- 新增 scheduled `notification_dispatch` cron(每日 17:50 Asia/Taipei,排在 signal_evaluation 17:45 之後)
- 新增 `DISCORD_WEBHOOK_URL` 設定(`Settings` 欄位,空字串 = dev 模式 no-op channel)
- 新增 CLI `literati-signal notify [--as-of DATE]`(手動觸發 / 測通知管道用)
- 新增 `.env.example` 的 `DISCORD_WEBHOOK_URL=`(留空,實際值存 `.env`,gitignored)
- 新增 compose.yaml 的 webhook URL pass-through

**非範圍**:多訊號各自發訊、通知重送 / 失敗補償、Discord embed 排序 / 分頁、個股名稱查表(先顯示 stock_id 數字)、其他 channel(LINE / Email / Telegram)、「zero events 報平安」訊息。

## Capabilities

### New Capabilities

- `signal-notification`:抽象化的訊號通知管線:Protocol + Discord 具體實作 + daily dispatch + empty-no-op 語意。

### Modified Capabilities

(無)

## Impact

- **新增程式碼**:`src/literati_stock/notify/{__init__,base,service,templates,jobs,cli_commands}.py` + `channels/{__init__,discord}.py`,及 tests,估 350–450 行
- **新增依賴**:**無**(全用 httpx / pydantic / structlog / SA)
- **設定**:`Settings.discord_webhook_url: str = ""`,空字串 = 不送通知;實際 URL 存 `.env`(gitignored),compose 透過 env pass-through
- **Secret handling**:webhook URL 是 **憑證**(誰拿到都能往你 channel 貼訊息),**永不寫進 commit / PR 描述 / test code / log**;log 只顯示 host(`discord.com`)
- **DB schema**:無變動
- **影響的後續 change**:其他通知 channel(LINE / Email)複用相同 `NotificationChannel` Protocol;可重送 / dedup 機制(若需要)另開 change
