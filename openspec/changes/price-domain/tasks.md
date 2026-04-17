# tasks — price-domain

> 每個 task 完成後在框內勾選 `[x]`。驗收條件未滿足前禁止勾選。

## A. 資料模型 + Migration

- [x] **A1. `src/literati_stock/price/models.py`:`StockPrice` 與 `IngestCursor` ORM(SQLAlchemy 2.0 `Mapped[T]`)**
  - 驗收:`StockPrice.__table__.primary_key.columns.keys() == ['stock_id', 'trade_date']`;`IngestCursor.__table__.primary_key.columns.keys() == ['dataset']`;Pyright strict 對檔案 0 errors
- [x] **A2. Alembic migration `0002_add_price_domain`(`stock_price` + `ingest_cursor` + indexes + FK to `ingest_raw.id`)**
  - 驗收:integration test 跑 `alembic upgrade head` 後兩表存在,欄位齊全;`alembic downgrade -1` 後兩表消失,`ingest_raw` 不受影響

## B. Transform service

- [x] **B1. `src/literati_stock/price/transform.py`:`PriceTransformService.process_new(batch_size: int = 500) -> TransformResult`**
  - 行為:於單一 async transaction 內讀 `ingest_cursor.last_raw_id`(fallback 0) → `select ingest_raw where dataset='TaiwanStockPrice' and id > cursor order by id limit batch_size` → 逐列用 `TaiwanStockPriceRow.model_validate` parse payload → upsert 進 `stock_price`(`on_conflict_do_update` of PK)→ update `ingest_cursor.last_raw_id = max(processed.id)` → commit
  - 驗收:unit test(mocked session + Pydantic sample)驗證 mapping 正確;integration test(testcontainers)驗證:(a) 冷啟從 cursor 0 處理全部;(b) 重跑立刻 no-op;(c) 新增 raw 後只處理 diff;(d) raise in-middle → cursor 不前進、已寫入的 stock_price 被 rollback

## C. Scheduled job + lifespan wiring

- [x] **C1. `src/literati_stock/price/jobs.py`:`register_price_jobs(app, scheduler, session_factory)` 函式,註冊 `price_transform` 每 5 分鐘 `IntervalTrigger`,callback 內部建新 session scope + 呼叫 `PriceTransformService.process_new()`**
  - 驗收:unit test 驗證 `register_price_jobs` 後 `scheduler.get_jobs()` 含 `id=='price_transform'` 的 job,trigger 為 `IntervalTrigger`,interval 為 300 秒
- [x] **C2. 修改 `src/literati_stock/api/main.py` 的 lifespan,啟動 scheduler 之前呼叫 `register_price_jobs(...)`**
  - 驗收:integration test `test_healthz_reports_schedules` 驗證 lifespan 啟動後 `/healthz` 回 `{"status":"ok","schedules": >=1}`(原先 0,現在至少 1)

## D. CLI 擴充

- [x] **D1. `src/literati_stock/ingest/cli.py` 新增 `transform-prices` 子指令,內部跑一次 `PriceTransformService.process_new()` 並 print JSON 結果**
  - 驗收:`uv run literati-ingest --help` 顯示 `transform-prices`;integration test 模擬 `ingest_raw` 中有 3 筆 TaiwanStockPrice,跑完 `stock_price` 新增 3 列、`ingest_cursor` 前進到最大 id、exit code 0

## E. QA 與收尾

- [x] **E1. `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠**
  - 驗收:exit 0;coverage 不低於既有水準(~91%)
- [x] **E2. `uv run pyright src tests` strict 無 error**
  - 驗收:exit 0
- [x] **E3. `uv run ruff check` + `ruff format --check` 全綠**
  - 驗收:exit 0
- [x] **E4. `qa-test-scope.md` 寫入 change 目錄**
  - 驗收:依 template 五段齊全
- [ ] **E5. archive + push + `gh pr create` target=main**
  - 驗收:change 已搬到 `openspec/changes/archive/`;`openspec/specs/price-domain/spec.md` 公佈;PR 描述含 Make-vs-Buy exemption 理由、SQL injection ✓、PII ✓、所有依賴無新增;PR URL 取得
