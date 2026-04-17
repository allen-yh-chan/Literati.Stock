# QA 測試範圍評估報告 — price-domain

## 基本資訊

- 需求/變更名稱:Literati.Stock 股價 domain 表 + ELT transform
- OpenSpec change:`price-domain`
- 分支:`feature/price-domain`
- Commit(QA 時):`a1db6de`(proposal 後,實作進 commit 中)
- 提交人:Allen Chan
- 日期:2026-04-17

## 1) 變更範圍摘要

- **本次主要變更**
  - `stock_price` 領域表(OHLCV + 量 + 額 + turnover + source_raw_id FK + ingested_at)
  - `ingest_cursor` bookkeeping 表(per-dataset last_raw_id)
  - Alembic migration `0002_add_price_domain`(upgrade/downgrade 完整)
  - `PriceTransformService.process_new()`:cursor-based idempotent ELT,單一 transaction
  - Scheduled `price_transform` job(每 5 分鐘,FastAPI lifespan 註冊)
  - CLI 子指令 `literati-ingest transform-prices`
- **涉及檔案/模組**
  - `src/literati_stock/price/{__init__,models,transform,jobs}.py`
  - `migrations/versions/0002_add_price_domain.py`
  - 修改 `src/literati_stock/{api/main,ingest/cli}.py`(lifespan + CLI 擴充)
  - 修改 `tests/integration/{conftest,test_api_healthz}.py`
  - 新增 `tests/unit/test_price_jobs.py`、`tests/integration/test_{price_transform,cli_transform_prices}.py`
- **非範圍**
  - 法人 / 融資 / 籌碼 domain tables(下一 change)
  - Scheduled daily price ingest job(需 stock universe 先載入)
  - 訊號計算、回測、通知
  - TimescaleDB 遷移、分區
  - 計算欄位(均量、量比)存於 `stock_price`

## 2) 建議 QA 驗測重點

- **核心流程**
  - `alembic upgrade head` 在 testcontainers 上建 `stock_price` + `ingest_cursor` 兩表(欄位正確、PK 正確、FK 正確、indexes 建立);`alembic downgrade -1` 後兩表消失、`ingest_raw` 仍在
  - `PriceTransformService.process_new()` 冷啟處理所有 `ingest_raw` 中 `dataset='TaiwanStockPrice'` 列,upsert 進 `stock_price`,cursor 前進
  - `/healthz` lifespan 啟動後回 `{"status":"ok","schedules": >=1}`(因 `price_transform` job)
  - `literati-ingest transform-prices` CLI 正確跑一次並 print JSON result
- **邊界情境**
  - Cursor 無紀錄時 fallback 到 0(冷啟)
  - 重跑立刻 no-op(沒 new raw rows)
  - 新增 raw 後只處理 diff(cursor 正確只吃新 id)
  - 同一 `(stock_id, trade_date)` 被處理兩次 → upsert 覆寫,不重複列、不違反 PK
  - Payload 非 list / 非 dict 時 log warning 並 skip,不炸
- **例外/錯誤情境**
  - `TaiwanStockPriceRow.model_validate` raise `ValidationError`(如 `stock_id` < 4 字元)時,**整個 transaction rollback**:已寫入的 `stock_price` 消失、`ingest_cursor` 不前進(下次重跑仍從相同起點)
  - 轉型過程 raise → 不破壞 `ingest_raw`(仍可重跑)
- **效能與並發**
  - `max_instances=1` 確保 `price_transform` job 不並發堆疊(重要!cursor 不支援並發寫)
  - `coalesce=True` + `misfire_grace_time=600`:scheduler 因 pause / shutdown 漏跑時只補一次
  - 單次 batch 上限 500 raw rows(可由 parameter 調整)

## 3) 可能受影響模組 / 流程

- **直接受影響**
  - `api/main.py` lifespan 多註冊一個 job → `/healthz` 的 schedules 數變 >=1
  - `ingest/cli.py` 新增 `transform-prices` 子指令(不影響 `run-once`)
- **間接受影響**
  - ingest-foundation 的 `ingest_raw` 表多了一個「讀取者」(不影響寫入路徑)
  - 後續訊號 change 將以 `stock_price` 為輸入
  - 後續法人/融資/籌碼 domain change 將複用 `ingest_cursor` 表 + `PriceTransformService` pattern
- **相依外部系統/服務**
  - 與 ingest-foundation 相同(PostgreSQL 16、Docker Desktop);**無新增第三方依賴**

## 4) 風險與未覆蓋項目

- **已知風險**
  - `PriceTransformService` 假設 `ingest_raw.payload` 是 list of dicts(FinMind 固定格式);若格式漂移,會靠 `TaiwanStockPriceRow` 強解擋住,但 schema sentinel 仍是第一道防線(ingest-foundation 已提供)
  - 若 `ingest_cursor` 被手動改錯(例如回寫過大的 id),下次 transform 會漏處理 raw — 需要運維紀律(目前靠 log 觀測)
  - `price_transform` job 與未來的「scheduled ingest job」是否會造成 cursor race condition 需在加入 scheduled ingest 時再驗(本 change 無 scheduled ingest)
- **尚未覆蓋測試項目**
  - 真實 FinMind 端對端 smoke(從 `literati-ingest run-once` → `transform-prices` → `stock_price` 查詢)
  - 大批次處理(10k+ raw rows)的效能與 batch 邊界行為
  - 多 dataset 同一時間觸發 transform 的並發行為(本 change 只一個 dataset)
- **未覆蓋原因**
  - 真實 FinMind 呼叫消耗配額,且不適合放 CI
  - 大批次 / 並發在下一個引入多 dataset 或多 job 的 change 再加
- **建議後續補測**
  - 把爆量長紅訊號 change 開工時順便寫 end-to-end smoke(ingest → transform → signal)

## 5) 建議回歸測試清單

- [ ] `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠(含 integration)
- [ ] `uv run pyright src tests` strict 0 errors
- [ ] `uv run ruff check` + `ruff format --check` 全綠
- [ ] `uv run pre-commit run --all-files` 全綠
- [ ] `alembic upgrade head` 在乾淨 DB 上成功建兩表
- [ ] `alembic downgrade -1` 後兩表消失、`ingest_raw` 不受影響
- [ ] `docker compose up -d` 後容器起來、`/healthz` 回 schedules ≥ 1
- [ ] `literati-ingest --help` 顯示 `transform-prices`

## 6) 測試證據

- **執行指令與結果**
  - `uv run pytest --cov=literati_stock`:**54 passed(+10 新),coverage 90.38%**(門檻 75%)
  - `uv run pyright src tests`:**0 errors, 9 warnings**(全部 APScheduler upstream stub)
  - `uv run ruff check src tests migrations`:All passed
  - `uv run ruff format --check`:42 files formatted
  - `uv run pre-commit run --all-files`:(待執行於 commit 時)
- **主要 log 關鍵字**
  - `price.transform.tick dataset=TaiwanStockPrice raw_rows_processed=N`
  - `price.transform.skip_non_list_payload raw_id=N`
  - `app.startup jobs=1`(原為 0)
- **SQL injection 檢查 ✓**:所有寫入透過 SQLAlchemy 2.0 `pg_insert(...).values(...)`、`on_conflict_do_update(set_=...)`;讀取透過 `select(...).where(...)`;無字串拼接 SQL
- **PII 檢查 ✓**:`stock_price` 表為公開市場交易資料(OHLCV),不含個資;`ingest_cursor` 只含 dataset 名稱與整數,無 PII
- **新增依賴 ✓**:**無新增第三方套件**(完全使用 ingest-foundation 已引入的 SQLAlchemy、Pydantic、APScheduler、structlog、asyncpg)
- **Make-vs-Buy**:適用 §3e-1 豁免(純業務邏輯 / 無對應 OSS),見 `make-vs-buy.md`
