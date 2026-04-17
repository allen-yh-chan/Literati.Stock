## ADDED Requirements

### Requirement: Stock universe table

系統 SHALL 提供 `stock_universe` 表,欄位含 `stock_id text primary key`、`name text not null`、`industry_category text`、`market text not null`(值 `twse` 或 `tpex`)、`type text not null default 'stock'`、`is_active bool not null default true`、`in_watchlist bool not null default false`、`last_synced_at timestamptz not null default now()`。Migration SHALL seed 5 筆 MVP watchlist 初始列(stock_id ∈ `{2330, 2454, 2317, 2412, 2303}`、`in_watchlist=true`);seed 用 `ON CONFLICT DO NOTHING`,不覆寫已有列。

#### Scenario: Migration creates table with expected schema

- **WHEN** `alembic upgrade head` 對乾淨 DB 執行
- **THEN** `stock_universe` 存在,主鍵 `stock_id`,`in_watchlist` 預設 `false`

#### Scenario: Seed inserts 5 watchlist rows

- **WHEN** migration 首次執行
- **THEN** `select count(*) from stock_universe where in_watchlist` 為 5

#### Scenario: Downgrade removes table

- **WHEN** `alembic downgrade -1`
- **THEN** `stock_universe` 不存在;其他表(`stock_price`/`ingest_raw`/`ingest_cursor`/`signal_event`)不受影響

### Requirement: Universe sync service

系統 SHALL 提供 `UniverseSyncService.sync()`,呼叫 FinMind `TaiwanStockInfo` dataset、以 `TaiwanStockInfoRow` Pydantic 強解、upsert `stock_universe`(key=`stock_id`),並**不動** `in_watchlist` 欄位(保留使用者手動設定)。每列寫入 SHALL 更新 `last_synced_at = now()` 與來自 FinMind 的 `name`/`industry_category`/`market`/`type`/`is_active`。

#### Scenario: Existing watchlist flag preserved across sync

- **GIVEN** `stock_universe` 已有 `2330` 且 `in_watchlist=true`
- **WHEN** `sync()` 執行(FinMind 回 2330 當然 active)
- **THEN** `2330` row 的 `in_watchlist` 仍為 `true`;`name` / `industry_category` 被更新

#### Scenario: New stocks inserted with default watchlist false

- **GIVEN** `stock_universe` 無 `6505`,FinMind 回 6505 資料
- **WHEN** `sync()` 執行
- **THEN** `6505` 被 insert,`in_watchlist` 預設 `false`

### Requirement: Daily watchlist price ingest

系統 SHALL 提供 `DailyPriceIngestService.run(trade_date: date)`,先 `select stock_id from stock_universe where is_active AND in_watchlist`,對每檔透過既有 `FinMindClient.fetch("TaiwanStockPrice", ...)` 抓 `trade_date` 當日(`start_date == end_date == trade_date`),成功則透過既有 `RawPayloadStore.record` 寫 `ingest_raw`,失敗則透過既有 `FailureRecorder` 寫 `ingest_failure`。配額共用:整個 loop 共用 **一個** `AsyncLimiter` instance。

#### Scenario: All watchlist stocks fetched for the given date

- **GIVEN** `stock_universe` 有 3 檔 `in_watchlist=true`
- **WHEN** `run(date(2026, 4, 17))` 呼叫、FinMind 每檔回正常 payload
- **THEN** `ingest_raw` 新增 3 筆 `dataset='TaiwanStockPrice'` 列,`fetched_at` 落在最近 1 分鐘

#### Scenario: Per-stock failure recorded, loop continues

- **GIVEN** 3 檔 watchlist,第 2 檔 FinMind 回 5xx 用完重試
- **WHEN** `run` 執行
- **THEN** `ingest_raw` 有 2 筆、`ingest_failure` 有 1 筆;第 3 檔仍被處理

#### Scenario: No watchlist → no API call

- **GIVEN** `stock_universe` 無任何 `in_watchlist=true` 列
- **WHEN** `run(today)` 執行
- **THEN** FinMind 0 次請求,`ingest_raw` 不變

### Requirement: Scheduled cron jobs

FastAPI lifespan SHALL 註冊兩個新 scheduled job:
- `universe_sync` — `CronTrigger(day_of_week='sun', hour=22, minute=0, timezone=Asia/Taipei)`
- `price_ingest_daily` — `CronTrigger(day_of_week='mon-fri', hour=14, minute=30, timezone=Asia/Taipei)`

兩者皆沿用 `IngestScheduler` 預設(`misfire_grace_time=600`、`coalesce=True`、`max_instances=1`)。

#### Scenario: Healthz reports registered schedules

- **WHEN** FastAPI lifespan 啟動(含 `DISCORD_WEBHOOK_URL` 設定)
- **THEN** `/healthz` 回 `schedules == 5`(price_transform / signal_evaluation / notification_dispatch / universe_sync / price_ingest_daily)

### Requirement: CLI subcommands

`literati-ingest` CLI SHALL 新增:
- `refresh-universe` — 一次性呼叫 `UniverseSyncService.sync()`,stdout 印 JSON 摘要(`synced_rows`)
- `sync-prices-today [--as-of DATE]` — 呼叫 `DailyPriceIngestService.run(as_of or today_taipei)`,stdout 印 JSON 摘要(`stocks_attempted`、`raw_rows_written`、`failures_recorded`)

#### Scenario: Help surfaces both subcommands

- **WHEN** `literati-ingest --help`
- **THEN** 輸出含 `refresh-universe` 與 `sync-prices-today`

#### Scenario: sync-prices-today writes per-stock raw rows

- **GIVEN** `stock_universe` 有 2 檔 watchlist,FinMind 端正常回 payload
- **WHEN** `literati-ingest sync-prices-today --as-of 2026-04-17`
- **THEN** exit 0,JSON 回 `stocks_attempted=2`、`raw_rows_written=2`、`failures_recorded=0`
