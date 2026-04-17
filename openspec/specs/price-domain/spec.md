# price-domain Specification

## Purpose
TBD - created by archiving change price-domain. Update Purpose after archive.
## Requirements
### Requirement: Typed OHLCV domain table

系統 SHALL 提供 `stock_price` 關聯表,欄位 SHALL 包含 `stock_id`、`trade_date`、`open`、`high`、`low`、`close`、`spread`、`volume`、`amount`、`turnover`、`source_raw_id`、`ingested_at`,主鍵 SHALL 為 `(stock_id, trade_date)`,以確保同一股同一交易日最多一列。

#### Scenario: Table and primary key created by migration

- **WHEN** 對 testcontainers PostgreSQL 執行 `alembic upgrade head`
- **THEN** `stock_price` 表存在,欄位集合等於上述清單,且 `(stock_id, trade_date)` 為 primary key

#### Scenario: Downgrade removes both domain and cursor tables

- **WHEN** 執行 `alembic downgrade -1`
- **THEN** `stock_price` 與 `ingest_cursor` 均不存在

### Requirement: Idempotent cursor tracking for ELT replay

系統 SHALL 提供 `ingest_cursor` 表(欄位 `dataset` primary key、`last_raw_id bigint not null default 0`、`updated_at timestamptz`),用於追蹤每個 dataset 已處理到 `ingest_raw` 的哪一筆 id。cursor 前進 SHALL 與 domain upsert 位於同一資料庫 transaction,使失敗時兩者一起 rollback。

#### Scenario: First run starts from raw id 0

- **WHEN** `ingest_cursor` 無 `TaiwanStockPrice` 列,`PriceTransformService.process_new()` 被呼叫
- **THEN** service 讀取所有 `ingest_raw` 列(`id > 0`),成功後 `ingest_cursor` 出現一筆 `dataset='TaiwanStockPrice'` 且 `last_raw_id` 等於處理過最大 id

#### Scenario: Subsequent run only processes new rows

- **WHEN** cursor 已指向 raw id N,之後新寫入 M 筆 raw,`process_new()` 再被呼叫
- **THEN** service 只讀取 id > N 的 M 筆,處理完後 cursor 前進到 N+M

#### Scenario: Transform failure rolls back cursor advance

- **WHEN** domain upsert 在過程中 raise,transaction commit 之前
- **THEN** `ingest_cursor.last_raw_id` 保持原值,已寫入的 `stock_price` 列因 rollback 消失,可重跑

### Requirement: Payload-to-domain field mapping

系統 SHALL 以 `TaiwanStockPriceRow` Pydantic schema 解析 `ingest_raw.payload` 中每一列,並依固定映射寫入 `stock_price`:`max`→`high`、`min`→`low`、`Trading_Volume`→`volume`、`Trading_money`→`amount`、`Trading_turnover`→`turnover`、其餘同名。`source_raw_id` SHALL 寫入對應 `ingest_raw.id`。

#### Scenario: Sample payload produces a correct price row

- **WHEN** `ingest_raw` 有一列 `payload=[{date,stock_id,Trading_Volume,Trading_money,open,max,min,close,spread,Trading_turnover}]`,`process_new()` 處理之
- **THEN** `stock_price` 新增一列,`high` == 原 `max`、`low` == 原 `min`、`volume` == 原 `Trading_Volume`、`amount` == 原 `Trading_money`、`turnover` == 原 `Trading_turnover`、`source_raw_id` == 該 `ingest_raw.id`

#### Scenario: Re-ingest upserts instead of duplicating

- **WHEN** 同一 `(stock_id, trade_date)` 被處理兩次(第二次是 FinMind 更正後的 payload)
- **THEN** `stock_price` 仍只有一列,數值反映最近一次 payload,不違反 PK

### Requirement: Scheduled transform job via lifespan

FastAPI 應用 SHALL 在 lifespan 啟動時,於 `IngestScheduler` 註冊 `price_transform_job`,預設每 5 分鐘觸發一次 `PriceTransformService.process_new()`,使用 scheduler 預設的 `misfire_grace_time=600`、`coalesce=True`、`max_instances=1`。

#### Scenario: Job is registered on startup

- **WHEN** FastAPI app 進入 lifespan
- **THEN** `scheduler.get_jobs()` 含一筆 `id='price_transform'` 之 job,trigger 型別為 `IntervalTrigger`

#### Scenario: /healthz reflects registered job count

- **WHEN** lifespan 啟動後 `GET /healthz`
- **THEN** 回傳 `{"status":"ok","schedules": N}`,N ≥ 1

### Requirement: Manual CLI trigger

`literati-ingest` CLI SHALL 提供 `transform-prices` 子指令,呼叫一次 `PriceTransformService.process_new()` 並回報處理筆數與 cursor 前進結果。

#### Scenario: Help surface shows the subcommand

- **WHEN** `literati-ingest --help`
- **THEN** stdout 含子指令 `transform-prices`

#### Scenario: Manual trigger processes pending raw rows

- **WHEN** `ingest_raw` 有 k 筆 `TaiwanStockPrice` 列待處理,執行 `literati-ingest transform-prices`
- **THEN** exit code == 0,`stock_price` 新增 ≥ 1 列(> 0 取決於 payload),`ingest_cursor` 前進到該批最大 raw id
