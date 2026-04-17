# tasks — signal-notify-discord

> 每個 task 完成後在框內勾選 `[x]`。驗收條件未滿足前禁止勾選。

## A. Settings + secret wiring

- [x] **A1. `Settings.discord_webhook_url: str = ""` 加進 `core/settings.py`**
  - 驗收:unit test 驗證預設空、env 可覆寫、pyright strict 0 errors
- [x] **A2. `.env.example` 新增 `DISCORD_WEBHOOK_URL=`(空值 + 註解說明來源)**
  - 驗收:`grep DISCORD_WEBHOOK_URL .env.example` 命中
- [x] **A3. `compose.yaml` 把 `DISCORD_WEBHOOK_URL: ${DISCORD_WEBHOOK_URL:-}` 加進 app service 的 environment**
  - 驗收:`docker compose config` 顯示該 env 變數

## B. Notification abstractions

- [x] **B1. `src/literati_stock/notify/base.py`:`SignalDispatch` frozen Pydantic + `NotificationChannel` Protocol(`publish_daily` async)**
  - 驗收:Pyright strict 0 errors;unit test 驗證 `SignalDispatch` 欄位;Protocol 結構型別相容於 `DiscordWebhookChannel`

## C. Discord channel

- [x] **C1. `src/literati_stock/notify/channels/discord.py`:`DiscordWebhookChannel` + `DiscordNotificationError`;tenacity retry on 429 / 5xx 最多 3 次;log 只出 host**
  - 驗收:unit test(respx mock)驗證:(a) 正常 POST 成功;(b) 429→200 重試成功;(c) 連續 429 耗盡 → raise;(d) 400 立刻 raise 不重試;(e) log 中無 webhook path 或 token 出現(grep captured logs)
- [x] **C2. `src/literati_stock/notify/templates.py`:embed 構造器(title + 綠色 + fields 依 severity 由高到低 + 最多 10 檔 + footer)**
  - 驗收:unit test 驗證:(a) 排序正確;(b) 超過 10 檔截斷並 description 註明;(c) 空 dispatch → 回 None(channel 不送);(d) 欄位格式精確比對字串

## D. Service + scheduler + CLI

- [x] **D1. `src/literati_stock/notify/service.py`:`NotificationService` 接受 `session_factory` + `channel` + 已註冊 signal names;`publish_daily(as_of)` 讀 `signal_event` where trade_date == as_of and signal_name in names;空 → no-op;否則 `channel.publish_daily(...)`**
  - 驗收:integration test(testcontainers,灌 3 筆當日事件 + 1 筆歷史事件 + 1 筆別 signal),驗證:(a) channel 收到 1 個 dispatch + 3 個事件;(b) 歷史事件不在其中;(c) 空資料時 channel.publish_daily 不被呼叫
- [x] **D2. `src/literati_stock/notify/jobs.py`:`register_notification_jobs(scheduler, session_factory, signal_names, channel)`;`CronTrigger(hour=17, minute=50, timezone=Asia/Taipei)`**
  - 驗收:unit test 驗證 job id `notification_dispatch`、trigger 17:50 Asia/Taipei
- [x] **D3. 修改 `api/main.py` lifespan,settings.discord_webhook_url 非空時建立 channel 並註冊 job;空 skip**
  - 驗收:integration test(2 個 sub-test):(a) 帶 URL → `/healthz` schedules == 3;(b) 不帶 URL → schedules == 2
- [x] **D4. `literati-signal` CLI 新增 `notify [--as-of DATE]` 子指令**
  - 驗收:`literati-signal --help` 顯示;unit test argparse 解析正確

## E. QA 與收尾

- [x] **E1. `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠**
- [x] **E2. `uv run pyright src tests` strict 0 errors**
- [x] **E3. `uv run ruff check` + `ruff format --check` 全綠**
- [x] **E4. `qa-test-scope.md` 寫入 change 目錄**
- [x] **E5. archive + push + PR(target=main;PR 描述:Make-vs-Buy 手寫理由、SQL injection ✓、PII ✓、secret hygiene ✓、無新增套件)**
