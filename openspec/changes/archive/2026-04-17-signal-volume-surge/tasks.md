# tasks — signal-volume-surge

> 每個 task 完成後在框內勾選 `[x]`。驗收條件未滿足前禁止勾選。

## A. 資料模型 + Migration

- [x] **A1. `src/literati_stock/signal/models.py`:`SignalEvent` ORM(Mapped[T],`unique (signal_name, stock_id, trade_date)` 約束)**
  - 驗收:Pyright strict 無 error;`SignalEvent.__table_args__` 含 UniqueConstraint
- [x] **A2. Alembic `0003_add_signal_event`(含索引 `(trade_date desc)` 與 `(stock_id, trade_date desc)`)**
  - 驗收:integration test 跑 `upgrade head` → 表與約束都在;`downgrade -1` → 表消失、`stock_price` / `ingest_cursor` 不受影響

## B. Signal 抽象

- [x] **B1. `src/literati_stock/signal/base.py`:`PriceRow`(frozen dataclass 或 Pydantic)+ `SignalEventOut` Pydantic(frozen)+ `Signal` Protocol(`name, window_days, evaluate`)**
  - 驗收:Pyright strict 無 error;unit test 驗證 `SignalEventOut` 正確序列化、`Signal` Protocol 結構型別檢查

## C. 爆量長紅規則

- [x] **C1. `src/literati_stock/signal/rules/volume_surge_red.py`:`VolumeSurgeRedSignal` 類別,參數 `window_days=20`、`volume_multiple=2.0`、`min_red_bar_pct=0.015`、`min_close_price=Decimal("10")`**
  - 驗收:unit test 驗證:(a) 滿足全條件 → 發 1 筆 + severity 正確;(b) 漲幅不足 → skip;(c) close < 10 → skip;(d) ma_volume None → skip;(e) 量比不到 → skip;(f) 非 as_of 日期的 row → skip

## D. Service

- [x] **D1. `src/literati_stock/signal/service.py`:`SignalEvaluationService` 含 `fetch_prices(as_of, window_days, end_date)` 回 `list[PriceRow]`(SQL window function 計 ma_volume)、`evaluate(signal, as_of)` 抓取 + 跑 + upsert、`backfill(signal, start, end)` 遍歷交易日**
  - 驗收:integration test(testcontainers + 已灌資料)驗證:(a) fetch_prices 回正確 ma_volume(對 Python 手算對照);(b) look-ahead 防禦 `where trade_date <= as_of` 實際生效;(c) evaluate 寫 `signal_event` + 重跑 upsert 覆寫;(d) backfill 處理多日

## E. Scheduler + CLI + lifespan

- [x] **E1. `src/literati_stock/signal/jobs.py`:`register_signal_jobs(scheduler, session_factory, signals=[...])`,每日 17:45 Taipei cron**
  - 驗收:unit test 驗證 job id=`signal_evaluation`、trigger 是 `CronTrigger`、hour=17、minute=45、timezone=Asia/Taipei
- [x] **E2. 修改 `src/literati_stock/api/main.py` lifespan,register_price_jobs 之後 register_signal_jobs**
  - 驗收:integration test `/healthz` 回 `schedules >= 2`
- [x] **E3. `src/literati_stock/signal/cli.py`:`literati-signal` CLI(`evaluate`、`backfill`)+ `pyproject.toml` 新增 `literati-signal` console_script**
  - 驗收:`uv sync` 後 `uv run literati-signal --help` 顯示兩子指令;integration test 跑 `backfill volume_surge_red --start X --end Y` 之後 `signal_event` 增加若干列,exit code 0

## F. QA 與收尾

- [x] **F1. `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠**
- [x] **F2. `uv run pyright src tests` strict 無 error**
- [x] **F3. `uv run ruff check` + `ruff format --check` 全綠**
- [x] **F4. `qa-test-scope.md` 寫入 change 目錄(五段齊全)**
- [x] **F5. archive + push + PR(target=main;PR 描述含 Make-vs-Buy exemption 理由、SQL injection ✓、PII ✓、無新增套件)**
