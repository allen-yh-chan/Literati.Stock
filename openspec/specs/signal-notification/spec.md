# signal-notification Specification

## Purpose
TBD - created by archiving change signal-notify-discord. Update Purpose after archive.
## Requirements
### Requirement: Notification channel protocol

系統 SHALL 提供 `NotificationChannel` Protocol(`literati_stock.notify.base`),定義非同步 `publish_daily(dispatches: Sequence[SignalDispatch], as_of: date) -> None` 方法,其中 `SignalDispatch` 為每個訊號與其當日事件清單的 pairing。Protocol SHALL 使結構型別相容於多個具體實作(Discord / LINE / Email 等)。

#### Scenario: A channel satisfies the protocol

- **WHEN** `DiscordWebhookChannel` 實例被 type-check 作為 `NotificationChannel`
- **THEN** Pyright strict 不報錯

### Requirement: Discord webhook channel

系統 SHALL 提供 `DiscordWebhookChannel`,接受 `webhook_url: str` 建構子參數與可注入的 `httpx.AsyncClient`,並實作 `NotificationChannel` 契約。`publish_daily` SHALL 構造 **一個** Discord embed JSON payload 並 POST 至 webhook URL;HTTP 429 或 5xx 時 SHALL 以 `tenacity` 指數退避重試最多 3 次;非重試 4xx 時 SHALL raise `DiscordNotificationError` 攜帶 status 與 body 摘要。

#### Scenario: Successful publish posts one JSON POST

- **WHEN** 對 respx-mock 的 webhook 呼叫 `publish_daily` 一批命中事件
- **THEN** 實際送出 1 次 HTTP POST;Request body 是 JSON 且含 `embeds` 欄位

#### Scenario: Empty dispatch is a no-op

- **WHEN** `publish_daily` 的 `dispatches` 為空 list 或每個 signal 的 events 為空
- **THEN** **不**發送任何 HTTP 請求

#### Scenario: 429 triggers retry

- **WHEN** Discord 回 HTTP 429,下一次 200
- **THEN** channel 退避重試,第二次成功;最終 return 正常

### Requirement: Embed format

Embed payload SHALL 含:
- `title`:含訊號中文名(如「爆量長紅」/「散戶追價警訊」)與 `as_of` 日期
- `color`:
  - 買訊(如 `volume_surge_red`)使用綠色 `0x3ba55d`
  - **警訊(如 `institutional_chase_warning`)使用金黃色 `0xf0a500`**
- `description`:命中檔數摘要
- `fields`:依 `severity` 由高到低排序最多 10 檔;`name` 為 `{stock_id}`,`value` 為 signal-specific 格式化字串
- `footer.text`:`literati-stock · signal: {signal_name}`

#### Scenario: Fields sorted by severity desc

- **GIVEN** 三檔事件,severity 2.0 / 4.1 / 3.2
- **WHEN** `publish_daily` 構造 embed
- **THEN** fields 順序為 4.1 → 3.2 → 2.0

#### Scenario: More than 10 hits are truncated

- **GIVEN** 15 檔命中
- **WHEN** embed 構造
- **THEN** fields 有前 10 檔,description 註明「+5 more」

#### Scenario: Warning signal uses amber colour

- **WHEN** `build_embeds` 對 `institutional_chase_warning` 構造 embed
- **THEN** `color == 0xf0a500`

### Requirement: Daily dispatch service

`NotificationService.publish_daily(as_of: date)` SHALL 對每個已註冊的 signal name 讀 `signal_event` 當日列(`where signal_name = ? and trade_date = ?`),組成 `SignalDispatch` 後丟給 channel;無任何 dispatch 有事件時 SHALL 完全不呼叫 channel。

#### Scenario: Reads today's events per signal

- **GIVEN** `signal_event` 有 3 筆 `volume_surge_red` / `2026-04-17` 列 + 歷史列
- **WHEN** `publish_daily(date(2026, 4, 17))`
- **THEN** channel 收到 1 個 dispatch,事件清單 == 3 筆;歷史列不包含

#### Scenario: Zero events skips channel entirely

- **GIVEN** 當日 0 筆 signal_event
- **WHEN** `publish_daily`
- **THEN** channel 的 `publish_daily` 不被呼叫 OR 收到 empty dispatch 後 no-op(Discord 無 HTTP 請求)

### Requirement: Scheduled notification dispatch

FastAPI 應用 lifespan SHALL 註冊 `notification_dispatch` 之 `CronTrigger(hour=17, minute=50, timezone=Asia/Taipei)` job,排在 `signal_evaluation`(17:45)之後;callback SHALL 呼叫 `NotificationService.publish_daily(today_taipei)`。若 `Settings.discord_webhook_url` 為空字串,lifespan SHALL 跳過註冊(dev 模式 no-op);`/healthz` schedules 數因此在有 / 無 webhook 下 不同。

#### Scenario: Job is registered when webhook url is set

- **GIVEN** `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/yyy`
- **WHEN** FastAPI lifespan 啟動
- **THEN** `scheduler.get_jobs()` 含 `id='notification_dispatch'`;`/healthz` 回 `schedules >= 3`

#### Scenario: Job is skipped when webhook url is empty

- **GIVEN** `DISCORD_WEBHOOK_URL=`(空)
- **WHEN** lifespan 啟動
- **THEN** `notification_dispatch` 不在 jobs 清單;`/healthz` 回 `schedules >= 2`(price_transform + signal_evaluation)

### Requirement: Secret hygiene

webhook URL SHALL **僅** 從 `Settings.discord_webhook_url`(env var)取得;**禁止** 寫入 source code、tests、commit、PR 描述或 log message。日誌輸出 URL 時 SHALL 只含 host(`discord.com`)。`.env.example` SHALL 含變數名但值為空;實際值 SHALL 放 `.env`(gitignored)或 container env。

#### Scenario: Logger emits host only

- **WHEN** `DiscordWebhookChannel.publish_daily` 記錄活動
- **THEN** log 欄位 `webhook_host == 'discord.com'`,**不**含 path / token

### Requirement: CLI manual trigger

`literati-signal` CLI SHALL 新增 `notify [--as-of DATE]` 子指令,手動觸發 `NotificationService.publish_daily` 用於測通知管道或補送。

#### Scenario: Help surfaces notify subcommand

- **WHEN** `literati-signal --help`
- **THEN** 輸出含 `notify`(與既有 `evaluate` / `backfill` 並列)

#### Scenario: Manual trigger sends when events exist

- **GIVEN** `signal_event` 有當日 events,`DISCORD_WEBHOOK_URL` 指向 respx mock
- **WHEN** `literati-signal notify --as-of 2026-04-17`
- **THEN** 一次 HTTP POST 命中 mock;exit code 0;stdout 含 JSON 摘要(事件數、dispatches 數)
