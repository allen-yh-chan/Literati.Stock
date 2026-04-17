## ADDED Requirements

### Requirement: Institutional buy-sell domain table

系統 SHALL 提供 `institutional_buysell` 表,欄位 `stock_id text`、`trade_date date`、`foreign_net bigint`、`trust_net bigint`、`dealer_net bigint`、`total_net bigint`、`source_raw_id bigint FK ingest_raw(id)`、`ingested_at timestamptz`;主鍵 `(stock_id, trade_date)`。`foreign_net`/`trust_net` 為對應投資人類別的 `buy - sell`;`dealer_net` 為所有 dealer 類別(Dealer、Dealer_self、Dealer_Hedging 等)之總和;`total_net = foreign_net + trust_net + dealer_net`。

#### Scenario: Migration creates table

- **WHEN** `alembic upgrade head` 對乾淨 DB 執行
- **THEN** `institutional_buysell` 存在,主鍵 `(stock_id, trade_date)`

#### Scenario: Downgrade removes institutional table

- **WHEN** `alembic downgrade -1`(從 0005 回到 0004)
- **THEN** `institutional_buysell` 不存在;其他表不受影響

### Requirement: Margin transaction domain table

系統 SHALL 提供 `margin_transaction` 表,欄位 `stock_id`、`trade_date`、`margin_purchase_buy/sell bigint`、`margin_today_balance bigint`、`margin_yesterday_balance bigint`、`short_sale_buy/sell bigint`、`short_today_balance bigint`、`short_yesterday_balance bigint`、`source_raw_id`、`ingested_at`;主鍵 `(stock_id, trade_date)`。

#### Scenario: Migration creates margin table

- **WHEN** `alembic upgrade head`
- **THEN** `margin_transaction` 存在

### Requirement: Institutional transform aggregates investor types

系統 SHALL 提供 `InstitutionalTransformService.process_new()`,讀取 `ingest_raw(dataset='TaiwanStockInstitutionalInvestorsBuySell')`,Python 端依 `(stock_id, date)` group,將各投資人類別(`Foreign_Investor` / `Investment_Trust` / 其他含 `Dealer` 前綴者)彙總成一列、upsert `institutional_buysell`。與 `PriceTransformService` 一樣使用 `ingest_cursor` 以 dataset 為 key 保證 idempotent replay,且整個批次於一個 transaction 內完成。

#### Scenario: Three investor-type rows merge into one

- **GIVEN** `ingest_raw` 有 1 筆 payload 含 3 個 row(Foreign_Investor、Investment_Trust、Dealer,分別 buy/sell)
- **WHEN** `process_new()` 執行
- **THEN** `institutional_buysell` 新增 1 列,`foreign_net / trust_net / dealer_net` 分別為對應類別的 `buy - sell`,`total_net` 為三者之和

#### Scenario: Multiple dealer subtypes are summed

- **GIVEN** payload 含 `Dealer`、`Dealer_self`、`Dealer_Hedging` 三個 dealer 子類別
- **WHEN** transform 執行
- **THEN** `dealer_net = sum of (buy-sell) across all dealer subtypes`

#### Scenario: Cursor advances once per batch

- **WHEN** batch 中有 k 個 `ingest_raw` 列
- **THEN** `ingest_cursor.last_raw_id` 前進到批次最大 raw id,失敗時整批 rollback

### Requirement: Margin transform one-to-one

系統 SHALL 提供 `MarginTransformService.process_new()`,讀取 `ingest_raw(dataset='TaiwanStockMarginPurchaseShortSale')`,每筆 payload row 以 `TaiwanStockMarginPurchaseShortSaleRow` Pydantic 強解,1:1 upsert 進 `margin_transaction`。

#### Scenario: One payload row → one domain row

- **GIVEN** `ingest_raw` 有 1 筆 payload(1 股、1 日的融資融券)
- **WHEN** `process_new()` 執行
- **THEN** `margin_transaction` 新增 1 列,對應 today/yesterday balances

#### Scenario: Re-run upserts on conflict

- **WHEN** 同 `(stock_id, trade_date)` 再跑一次
- **THEN** 表只有 1 列,值更新為最新

### Requirement: Scheduled chip ingest and transform jobs

FastAPI lifespan SHALL 註冊下列 scheduled jobs:
- `chip_ingest_institutional` — Mon-Fri 16:30 Asia/Taipei(台股盤後法人公布時間之後),對 watchlist 各檔呼叫 FinMind `TaiwanStockInstitutionalInvestorsBuySell` 當日 → `ingest_raw`
- `chip_ingest_margin` — Mon-Fri 15:30 Asia/Taipei,對 watchlist 各檔呼叫 FinMind `TaiwanStockMarginPurchaseShortSale` 當日 → `ingest_raw`
- `institutional_transform` — 每 5 分鐘,呼叫 `InstitutionalTransformService.process_new()`
- `margin_transform` — 每 5 分鐘,呼叫 `MarginTransformService.process_new()`

#### Scenario: Healthz after chip jobs

- **WHEN** lifespan 啟動且 `DISCORD_WEBHOOK_URL` 已設
- **THEN** `/healthz` 回 `schedules == 9`(既有 5 + 新增 4:institutional ingest、margin ingest、institutional transform、margin transform)

### Requirement: CLI subcommands for chip datasets

`literati-ingest` SHALL 新增 `sync-chip-today [--as-of DATE]` 手動觸發 watchlist 當日的 institutional + margin 兩 dataset ingest;`literati-ingest` SHALL 新增 `transform-institutional` 與 `transform-margin` 兩個子指令手動觸發 transform。

#### Scenario: Sync-chip-today writes raws for both datasets

- **GIVEN** watchlist 2 檔
- **WHEN** `literati-ingest sync-chip-today --as-of 2026-04-17` 對 mock FinMind
- **THEN** `ingest_raw` 新增 4 筆(2 institutional + 2 margin),exit 0
