## ADDED Requirements

### Requirement: Signal event persistence schema

系統 SHALL 提供 `signal_event` 表(欄位 `id bigserial primary key`、`signal_name text not null`、`stock_id text not null`、`trade_date date not null`、`severity numeric(10,4)`、`metadata jsonb`、`computed_at timestamptz default now()`),並在 `(signal_name, stock_id, trade_date)` 加 `UNIQUE` 約束,使同一訊號對同一股同一日最多記一筆。

#### Scenario: Migration creates table and unique constraint

- **WHEN** 在乾淨 DB 跑 `alembic upgrade head`
- **THEN** `signal_event` 表存在;`unique (signal_name, stock_id, trade_date)` 約束可透過 `pg_indexes` / `pg_constraint` 驗證

#### Scenario: Downgrade removes table cleanly

- **WHEN** 執行 `alembic downgrade -1`
- **THEN** `signal_event` 不存在;`stock_price` / `ingest_cursor` 不受影響

### Requirement: Abstract Signal protocol

系統 SHALL 提供 `Signal` Protocol(於 `literati_stock.signal.base`),定義 `name: str` 屬性、`window_days: int` 屬性(訊號需要的歷史滑動視窗天數)、與 `evaluate(rows: Sequence[PriceRow], as_of: date) -> list[SignalEventOut]` 方法;並 SHALL 提供 `SignalEventOut` Pydantic model(frozen,欄位 `signal_name, stock_id, trade_date, severity, metadata`)。

#### Scenario: A signal satisfies the protocol structurally

- **WHEN** `VolumeSurgeRedSignal` class 被 type-checked 作為 `Signal` 使用
- **THEN** Pyright strict 不報錯,Protocol 結構型別驗證通過

### Requirement: SQL-window feature computation

系統 SHALL 提供 `SignalEvaluationService.fetch_prices(as_of: date, window_days: int, end_date: date | None = None)`,以 SQL window function 計算 `ma_volume`(`avg(volume) over (partition by stock_id order by trade_date rows window_days-1 preceding)`),回傳 `list[PriceRow]`。計算 SHALL 於資料庫端執行,禁止於 Python 迭代累加。

#### Scenario: MA volume is populated from stock_price

- **WHEN** 對已灌入 30+ 日 `stock_price` 資料的 DB 呼叫 `fetch_prices(as_of, window_days=20)`
- **THEN** 結果中 `trade_date` 在 `as_of` 之當日列,`ma_volume` 值等於該股前 20 日(含當日)`volume` 的平均值

#### Scenario: First-days rows have partial or null MA

- **WHEN** 某股在 DB 中只有 10 筆歷史列,`window_days=20` 計算
- **THEN** PostgreSQL 的 `avg() over (rows 19 preceding)` 在前 9 筆回傳 partial avg;訊號 evaluate 時 SHALL 處理此邊界(見下方訊號規則)

### Requirement: Volume surge red signal rule

`VolumeSurgeRedSignal` SHALL 接受建構子參數 `window_days=20`、`volume_multiple=2.0`、`min_red_bar_pct=0.015`、`min_close_price=Decimal("10")`,並於 `evaluate(rows, as_of)` 對每筆 `trade_date == as_of` 之 row 套用以下全部條件後才產生事件:

1. `close >= min_close_price`
2. `(close - open) / open >= min_red_bar_pct`
3. `ma_volume is not None` 且 `rows_available >= window_days`(需足夠歷史)
4. `volume >= volume_multiple * ma_volume`

產生的 `SignalEventOut.severity` SHALL 等於 `volume / ma_volume`;`metadata` SHALL 含 `{"volume": int, "ma_volume": float, "vol_ratio": float, "red_bar_pct": float, "close": float, "open": float}`。

#### Scenario: Qualifying row fires the signal

- **GIVEN** 一檔股於 `as_of` 當日:close=120, open=110, volume=30_000_000;前 19 日 avg volume=10_000_000
- **WHEN** `VolumeSurgeRedSignal().evaluate(rows, as_of)` 被呼叫
- **THEN** 回傳一筆事件,`severity == 3.0`,`metadata.vol_ratio == 3.0`

#### Scenario: Small red bar does not fire

- **GIVEN** close=111, open=110, volume=30_000_000, ma=10_000_000(漲幅僅 0.9%)
- **WHEN** evaluate 被呼叫
- **THEN** 不回傳任何事件(漲幅未達 1.5%)

#### Scenario: Penny stock excluded

- **GIVEN** close=5, open=4.7, volume=30_000_000, ma=10_000_000
- **WHEN** evaluate 被呼叫
- **THEN** 不回傳任何事件(close < 10)

#### Scenario: Insufficient history skipped

- **GIVEN** 某股只有 5 筆歷史列,`window_days=20`
- **WHEN** evaluate 被呼叫
- **THEN** 該股不回傳事件(歷史不足)

### Requirement: Look-ahead bias defense

`SignalEvaluationService.evaluate(signal, as_of)` 與 `backfill(signal, start, end)` SHALL 保證訊號無法看到 `trade_date > as_of` 的資料。`fetch_prices` 的 SQL SHALL 顯式 `where trade_date <= as_of`;`evaluate` 被呼叫前 SHALL assert `max(rows.trade_date) <= as_of`。

#### Scenario: Future rows not fetched

- **GIVEN** DB 內有 `trade_date=2026-04-18` 的列,`as_of=2026-04-17`
- **WHEN** `fetch_prices(as_of=2026-04-17, window_days=20)` 被呼叫
- **THEN** 回傳的 rows 不含 `trade_date=2026-04-18`

### Requirement: Scheduled daily evaluation

FastAPI 應用的 lifespan SHALL 註冊 `signal_evaluation` scheduled job(每日 `17:45 Asia/Taipei`,`CronTrigger(hour=17, minute=45)`),callback SHALL 遍歷所有註冊的訊號並對「當日 Taipei 日期」呼叫 `evaluate`。job SHALL 在 `price_transform` 之後觸發(依賴:price_transform 5-min interval 確保資料已就緒)。

#### Scenario: Job is registered on startup

- **WHEN** FastAPI lifespan 啟動完成
- **THEN** `/healthz` 回報 `schedules >= 2`(price_transform + signal_evaluation)

### Requirement: Upsert semantics for replay

將 `SignalEventOut` 寫入 `signal_event` 時 SHALL 使用 `pg_insert(...).on_conflict_do_update(...)`,使重跑(參數調整後)能正確覆寫同 `(signal_name, stock_id, trade_date)` 既有列,而非重複寫入。

#### Scenario: Rerun replaces existing event

- **GIVEN** `signal_event` 表已存在 `(volume_surge_red, 2330, 2026-04-16)` 一筆,severity=2.1
- **WHEN** 以調整後的參數(`volume_multiple=1.8`)再跑一次,severity 算出 2.15
- **THEN** `signal_event` 仍只有一筆,severity=2.15,`computed_at` 更新

### Requirement: CLI evaluate and backfill subcommands

系統 SHALL 提供 `literati-signal` console script,支援 `evaluate <name> [--as-of DATE]`(預設 as_of = 今天,Asia/Taipei)與 `backfill <name> --start DATE [--end DATE]`(倒序或正序遍歷交易日,對每日跑 evaluate)。執行結束 SHALL 輸出 JSON 摘要(事件數、第一筆 / 最後一筆 trade_date)。

#### Scenario: CLI help surfaces subcommands

- **WHEN** `literati-signal --help`
- **THEN** 輸出含 `evaluate` 與 `backfill` 子指令

#### Scenario: Backfill processes multiple dates

- **GIVEN** `stock_price` 內有 5 檔 × 362 交易日的歷史資料
- **WHEN** `literati-signal backfill volume_surge_red --start 2025-01-01 --end 2025-12-31`
- **THEN** `signal_event` 新增若干列(數量依資料而定,但可能為 0 到數百);exit code 0;stdout 包含 JSON 摘要
