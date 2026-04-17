## Why

MVP 目前靠手動 `literati-ingest run-once` 灌資料。要真正「放生」必須:(1) 知道可抓哪些股票(stock universe);(2) 每日自動抓 watchlist 股票。此 change 補齊這兩塊後,MVP 變成 hands-free 每日自動跑:14:30 抓新 bar → 14:35 transform → 17:45 signal → 17:50 Discord 通知。

## What Changes

- 新增 `stock_universe` 表(stock_id PK, name, industry_category, market, type, is_active, in_watchlist, last_synced_at)
- 新增 Alembic `0004_add_stock_universe` migration,並 **seed** 現有 5 檔(2330/2454/2317/2412/2303)為 `in_watchlist=true`
- 擴充 `ingest/schemas/finmind_raw.py` 新增 `TaiwanStockInfoRow` + `EXPECTED_FIELDS` 登錄
- 新增 `universe/` 模組:
  - `UniverseSyncService.sync()` — 抓 FinMind `TaiwanStockInfo`、upsert 整個 universe(不動 `in_watchlist`)
  - `DailyPriceIngestService.run(trade_date)` — query `stock_universe WHERE is_active AND in_watchlist`、對每檔呼叫 FinMind `TaiwanStockPrice` 當日、寫 `ingest_raw`;共享一個 `aiolimiter` 以 respect 配額
- 新增 scheduled jobs:
  - `universe_sync` — cron 每週日 22:00 Taipei(低峰期、週末)
  - `price_ingest_daily` — cron Mon–Fri 14:30 Taipei(台股收盤 13:30 + 15 分緩衝)
- 新增 CLI 子指令:
  - `literati-ingest refresh-universe` — 手動觸發 universe sync
  - `literati-ingest sync-prices-today [--as-of DATE]` — 手動觸發 watchlist 當日價格抓取
- lifespan 註冊兩個新 job
- `.env.example` 註解補充 FinMind 配額建議(設 token 可提升至 600 req/hr)

**非範圍**:盤中 5 秒資料、法人/融資/籌碼 scheduled ingest、台股國定假日日曆處理(先讓 `day_of_week='mon-fri'` cron trigger 處理;國定假日會多抓一次空 payload,可接受)、admin UI 改 `in_watchlist`。

## Capabilities

### New Capabilities

- `stock-universe`:台股所有上市 / 上櫃股票的清單管理,附 `in_watchlist` flag 用於限定 MVP 每日自動抓取範圍。

### Modified Capabilities

- `data-ingestion`:新增「每日自動執行 TaiwanStockPrice ingest for watchlist」與「每週自動刷新 universe」的排程行為。(現有的 `data-ingestion` spec 只定義手動觸發與 rate-limited client;不動既有條目,只 ADD 新條目)

## Impact

- **新增程式碼**:`src/literati_stock/universe/{__init__,models,service,jobs}.py`(~200 行)+ migration `0004_add_stock_universe.py`(~50 行)+ CLI 擴充(~80 行)+ tests(~150 行);合計 ~480 行
- **新增依賴**:無(httpx / aiolimiter / tenacity / SA 都已有)
- **DB schema**:新增 `stock_universe` 表 + seed 5 筆 watchlist;可完整 rollback
- **API 使用量**:現有 watchlist=5 檔,每日 14:30 共 5 個 FinMind 請求 + 週日 1 個請求(TaiwanStockInfo)= **遠低於 300/hr anonymous** 配額
- **影響的後續 change**:展開 watchlist 至全市場前要評估 rate 策略(token 600/hr 或 pagination);法人/融資 ingest change 複用同一 scheduled pattern
