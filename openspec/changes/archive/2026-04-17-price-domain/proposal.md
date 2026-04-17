## Why

`ingest-foundation` lands raw FinMind payloads into `ingest_raw` as JSONB. The core investment thesis "量先價行" requires typed, queryable OHLCV over 2400+ Taiwan equities across many years with volume-aware window functions (5-day / 20-day MA, volume ratio). JSONB in a single audit table is not structured for that workload. This change introduces the first domain table (`stock_price`) and the ELT transform path that keeps the raw table as replay source-of-truth.

## What Changes

- Add `stock_price` domain table(PK `(stock_id, trade_date)`;OHLCV + spread + amount + turnover + `source_raw_id` FK audit)
- Add `ingest_cursor` bookkeeping table(`dataset` PK, `last_raw_id`, `updated_at`)
- Add Alembic migration for both tables
- Add `PriceTransformService`:讀 `ingest_raw` 新列 → Pydantic parse → upsert `stock_price` → advance cursor(transaction atomic)
- Add scheduled `price_transform_job`(FastAPI lifespan 註冊;每 5 分鐘)
- Add CLI sub-command `literati-ingest transform-prices`(手動觸發 / 回補)
- Add unit + integration tests(覆蓋 idempotency、cursor 前進、payload 解析、空批次 no-op)

**非範圍**(明確不處理):
- 法人、融資、籌碼、盤中 5 秒資料 domain tables(下個 change)
- Scheduled daily price ingest job(需要 stock universe,下個 change)
- 訊號計算、回測、通知
- TimescaleDB 遷移、分區
- 計算欄位(均量、量比)存於 `stock_price`(query-time window function 即可)

## Capabilities

### New Capabilities

- `price-domain`:把 `ingest_raw` 的 FinMind `TaiwanStockPrice` payload 轉成 typed `stock_price` 領域表,附 cursor-based idempotent replay 能力。

### Modified Capabilities

(無)

## Impact

- **新增程式碼**:`src/literati_stock/price/{__init__,models,transform,cli_commands,jobs}.py` + 對應 tests,估 400–500 行
- **新增依賴**:無(完全重用 ingest-foundation 已引入的 SQLAlchemy / Pydantic / APScheduler / structlog / asyncpg)
- **DB Schema 變更**:新增兩張表(`stock_price`、`ingest_cursor`),可完整 `alembic downgrade` rollback
- **影響的後續 change**:訊號引擎以 `stock_price` 為輸入;法人/融資/籌碼 change 將複用 `PriceTransformService` 的 pattern + `ingest_cursor` 機制
