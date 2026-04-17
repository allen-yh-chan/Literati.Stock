# tasks — stock-universe-ingest

> 每個 task 完成後在框內勾選 `[x]`。驗收條件未滿足前禁止勾選。

## A. 資料模型 + Migration

- [x] **A1. `src/literati_stock/universe/models.py`:`StockUniverse` ORM(PK=stock_id)**
  - 驗收:Pyright strict 0 errors;`StockUniverse.__table__.primary_key.columns.keys() == ['stock_id']`
- [x] **A2. `src/literati_stock/ingest/schemas/finmind_raw.py` 新增 `TaiwanStockInfoRow` + 登錄 `EXPECTED_FIELDS["TaiwanStockInfo"]`**
  - 驗收:unit test 驗證 sample payload 解析成功、extra 欄位保留、`EXPECTED_FIELDS` 新增一筆
- [x] **A3. Alembic `0004_add_stock_universe`:create table + 5 筆 seed(`2330/2454/2317/2412/2303`,`in_watchlist=true`)**
  - 驗收:integration test `upgrade head` 後 table 存在且 `select count(*) where in_watchlist == 5`;`downgrade -1` 後 table 消失、其他 4 表不受影響

## B. Services

- [x] **B1. `src/literati_stock/universe/service.py`:`UniverseSyncService` 用 `FinMindClient` fetch `TaiwanStockInfo`、pg_insert upsert 所有列、`in_watchlist` 保留不動**
  - 驗收:integration test 驗證:(a) 冷啟寫全部列、`in_watchlist=false`;(b) 手動 set 2330 `in_watchlist=true` 後再 sync,2330 仍 `in_watchlist=true`;(c) 新 stock_id 出現時 insert;(d) `last_synced_at` 每次 sync 更新
- [x] **B2. `src/literati_stock/universe/daily_ingest.py`(或 `service.py` 併存):`DailyPriceIngestService.run(trade_date)` 讀 watchlist、用共享 `AsyncLimiter` 迴圈呼叫 `FinMindClient.fetch` → 成功 `RawPayloadStore.record` / 失敗 `FailureRecorder.record`**
  - 驗收:integration test 用 respx mock + testcontainers 驗證:(a) 3 watchlist / 全成功 → `ingest_raw` +3, `ingest_failure` 0;(b) 中間 1 檔 5xx 耗盡重試 → raw +2 / failure +1,但 loop 繼續;(c) watchlist 0 檔 → 0 HTTP 請求

## C. Scheduler + CLI

- [x] **C1. `src/literati_stock/universe/jobs.py`:`register_universe_jobs`(兩個 job)**
  - 驗收:unit test 驗證 `universe_sync`(Sun 22:00 Taipei)與 `price_ingest_daily`(Mon–Fri 14:30 Taipei)都有註冊
- [x] **C2. `api/main.py` lifespan 註冊 `register_universe_jobs(...)`(放在 register_signal_jobs 後、register_notification_jobs 前)**
  - 驗收:integration test `/healthz` 回 `schedules >= 4`(無 webhook)/ `== 5`(有 webhook)
- [x] **C3. `ingest/cli.py` 新增 `refresh-universe` 與 `sync-prices-today [--as-of DATE]` 子指令**
  - 驗收:`literati-ingest --help` 含兩子指令;integration test 跑 `sync-prices-today --as-of 某日` 對 mock FinMind → `ingest_raw` 增 N 筆(N == watchlist 大小)

## D. QA 與收尾

- [x] **D1. `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠**
- [x] **D2. `uv run pyright src tests` strict 0 errors**
- [x] **D3. `uv run ruff check` + `ruff format --check` 全綠**
- [x] **D4. Docker smoke:`docker compose up -d --build` 後 `/healthz` 回 `schedules == 5`;`literati-ingest refresh-universe` 實跑對真 FinMind 成功、`stock_universe` 多出 ~2400 列且 5 檔 watchlist 保留**
- [x] **D5. `qa-test-scope.md` 寫入 change 目錄**
- [x] **D6. archive + push + PR**
