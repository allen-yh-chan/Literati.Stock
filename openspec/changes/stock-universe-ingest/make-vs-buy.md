# Make-vs-Buy 評估 — stock-universe-ingest

## 觸發判定

估 400–500 行。超過 §3e-1 行數門檻。評估。

## 豁免主張

本 change 的核心組件:

1. **`stock_universe` 表與 `TaiwanStockInfo` ETL** — 台股特定 schema 與 FinMind 特定 payload 的映射。無對應 OSS。
2. **Daily price ingest loop** — 讀 watchlist → 呼叫既有 `FinMindClient.fetch`(已 rate-limited + retried)→ 寫 `ingest_raw`(已有 `RawPayloadStore`)。整體只是 glue,不引入新能力。
3. **Scheduled cron** — APScheduler 的使用,ingest-foundation change 已決議。

無涉以下公認 OSS 領域:
- 台股日曆 / 交易日判定(未來若要精細處理國定假日,可評估 `pandas_market_calendars` / `exchange_calendars`,本 change 用 `mon-fri` cron trigger 即夠)
- 股票資料庫 SDK:FinMind 已是資料庫,TaiwanStockInfo 就是台股清單的來源

適用 §3e-1 **純業務邏輯 / glue code 豁免**,直接手寫。

## License check

無新增第三方套件。既有 deps(httpx、aiolimiter、tenacity、SQLAlchemy、APScheduler、structlog)已於先前 change 核可。

## 未來觸發正式 Make-vs-Buy 的時機

- 展開 watchlist 到全市場(~2400 檔)需要 rate-limit-aware pagination 或並行 → 可能引入 orchestrator(Prefect / Dagster / dbt)
- 國定假日 / 非 Mon-Fri 交易日的精細判定 → `pandas_market_calendars` / `exchange_calendars`
