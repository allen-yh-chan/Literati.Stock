# QA 測試範圍評估報告 — stock-universe-ingest

## 基本資訊

- 需求/變更名稱:Stock universe + scheduled daily price ingest(MVP hands-free 最後一塊)
- OpenSpec change:`stock-universe-ingest`
- 分支:`feature/stock-universe-ingest`
- Commit(QA 時):proposal + 實作即將 commit
- 日期:2026-04-17

## 1) 變更範圍摘要

- **新增**:`stock_universe` 表(stock_id PK、watchlist 標記、is_active、last_synced_at)、`TaiwanStockInfoRow` Pydantic、alembic 0004 含 5 筆 seed(2330/2454/2317/2412/2303)、`UniverseSyncService`、`DailyPriceIngestService`、`register_universe_jobs`(週日 22:00 sync + Mon-Fri 14:30 ingest)、CLI `refresh-universe` + `sync-prices-today`
- **修改**:`FinMindClient.fetch` data_id / start_date 改為 optional(TaiwanStockInfo 不需要)、`api/main.py` lifespan 註冊兩個新 job
- **非範圍**:國定假日判定、法人/融資/籌碼 scheduled ingest、全市場(~2400 檔)rate-limit 策略

## 2) QA 驗測重點

- **核心流程**
  - Migration `upgrade head` → `stock_universe` + index + 5 筆 seed watchlist
  - `UniverseSyncService.sync()` 對真實 FinMind 回傳 4081 raw rows → 3042 unique stocks upserted,watchlist 保留
  - `DailyPriceIngestService.run(today)` 對 5 watchlist stocks 寫 5 筆 `ingest_raw`
  - `/healthz` = 4(無 webhook)/ 5(有 webhook)
  - CLI 兩子指令正常運作
- **邊界情境**
  - FinMind 回傳無效 row(`date="None"`)→ 跳過 + warning,不中斷同步
  - `sync()` 先把所有 `is_active=false` 再 upsert 命中者 → 下市股自動 flip
  - `in_watchlist` 在 sync 中**不被覆寫**
  - Daily ingest 某檔 FinMind 持續失敗 → `FailureRecorder` 記錄,loop 繼續處理下一檔
  - Watchlist 為空 → 0 API 請求,0 row 寫入,service 回 0

## 3) 可能受影響模組 / 流程

- **直接受影響**:`api/main.py` lifespan 多 2 個 job;`FinMindClient.fetch` signature 放寬 optional 參數(backward-compat,既有呼叫不變)
- **間接受影響**:下一個「法人/融資/籌碼 scheduled ingest」 change 會複用 `stock_universe` watchlist 過濾
- **相依外部系統**:FinMind `/api/v4/data` endpoint(新加 TaiwanStockInfo dataset 使用)

## 4) 風險與未覆蓋項目

- **已知風險**
  - 國定假日:cron `day_of_week='mon-fri'` 無法偵測台股特殊休市(如春節、二二八),當日會送空 payload。影響不大(ingest_raw 多幾筆空 list)但浪費 API 配額。**建議**後續以 `exchange_calendars` / `pandas_market_calendars` 改進
  - FinMind 資料延遲:14:30 啟動 ingest 時 FinMind 不一定已發布當日資料 —— 可能抓到空 list,5 分鐘後 price_transform 也是 no-op。實務上 FinMind 當日資料通常 ~14:00 後即更新
  - 下市股處理邊界:某 stock_id 若在 FinMind 短暫消失又出現,is_active 會 false→true 跳動 —— 正確但可能噪音,`in_watchlist` 保留不動
  - 配額:5 檔 daily = 5 request/day,遠低於 300/hr anonymous。未來擴展 watchlist 或加 chip data 時需重評
- **尚未覆蓋測試項目**
  - 真實週末 / 週間 scheduler 運作(需等排程點)
  - 大 universe(全台股)手動 set watchlist 並 daily ingest 的 rate-limit 實測
  - TaiwanStockInfo 分頁(目前 4081 rows 單一回應;未來 FinMind 若加 pagination 要更新)

## 5) 建議回歸測試清單

- [ ] `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠
- [ ] `uv run pyright src tests` strict 0 errors
- [ ] `uv run ruff check` + `format --check` 全綠
- [ ] `docker compose up -d --build` 後 `/healthz` 回 `schedules == 5`
- [ ] `literati-ingest refresh-universe` 對真實 FinMind 返回 3000+ unique_stocks_upserted,5 筆 in_watchlist 保留
- [ ] `literati-ingest sync-prices-today --as-of YYYY-MM-DD` 對 5 watchlist 寫入 5 筆 `ingest_raw`,0 失敗
- [ ] `alembic downgrade -1` 後 `stock_universe` 消失,其他 4 表不變

## 6) 測試證據

- `uv run pytest` → **110 passed(+15 新)**,coverage 87.05%
- `uv run pyright src tests` → **0 errors, 32 warnings**(全 APScheduler stub)
- `uv run ruff check` / `format --check` → All green
- **Docker smoke(真 FinMind)**:
  - `refresh-universe` → **4081 raw → 3042 unique**(32 筆 date='None' 跳過);`select market, count(*)` 顯示 1557 twse + 1114 tpex + 371 emerging;`in_watchlist=true` 仍為 5
  - `sync-prices-today --as-of 2026-04-17` → **stocks_attempted=5, raw_rows_written=5, failures_recorded=0**
  - `/healthz` = `{"status":"ok","schedules":5}`
- **SQL injection ✓**:所有 DB 操作用 SA 2.0 `select/pg_insert/update`;無字串拼接
- **PII ✓**:TaiwanStockInfo/TaiwanStockPrice 為公開市場資料,無個資
- **新增依賴 ✓**:**無**
- **Make-vs-Buy ✓**:§3e-1 豁免(純業務邏輯 / glue code)
