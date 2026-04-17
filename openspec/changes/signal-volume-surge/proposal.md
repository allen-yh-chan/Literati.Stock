## Why

`stock_price` domain(price-domain change)落地後,已具備計算訊號所需的 OHLCV 輸入。此 change 把「量先價行」的第一個訊號 —— **爆量長紅** —— 實作成可用類別 + 可排程 + 可回測的 production pipeline,一次確立整個訊號引擎的骨架(Signal Protocol、SignalEvent schema、SignalEvaluationService、backtest-vs-live 共用邏輯)。未來其餘 4 個訊號(量增價平、底部縮量打底、價漲量縮、法人買超+融資追價)只需新增一個 `Signal` 子類別即可複用整個骨架。

## What Changes

- 新增 `signal_event` 表(PK `id`;`unique (signal_name, stock_id, trade_date)`;severity + jsonb metadata)
- 新增 Alembic migration `0003_add_signal_event`
- 新增 `Signal` Protocol + `SignalEventOut` Pydantic output model + `PriceRow` 輸入資料結構
- 新增 `VolumeSurgeRedSignal` 類別(爆量長紅規則,參數全部 parameterizable)
- 新增 `SignalEvaluationService`:從 `stock_price` 以 SQL window function 計 N 日均量 → 跑訊號 → upsert `signal_event`;暴露 `evaluate(signal, as_of)` 與 `backfill(signal, start, end)` 兩方法
- 新增 scheduled `signal_evaluation_job`(每日 17:45 Taipei,排在 price_transform 之後,跑註冊過的所有訊號)
- 新增 `literati-signal` CLI:`evaluate <name> [--as-of DATE]`、`backfill <name> --start DATE [--end DATE]`
- 新增 `pyproject.toml` 的 `literati-signal` console_script 與 pandas 之外的無新增依賴

**非範圍**:其他 4 個訊號、回測 framework(只有 backfill 到 DB;完整 walk-forward analysis 留待 `backtest` change)、通知(下一個 change)、排名 / 排行 endpoint(留待 API change)。

## Capabilities

### New Capabilities

- `signal-engine`:抽象化的訊號評估管線:從 `stock_price` 帶滑動視窗特徵的讀取、Signal Protocol 的執行、`signal_event` 的 upsert。第一個具體訊號為「爆量長紅」(`volume_surge_red`)。

### Modified Capabilities

(無)

## Impact

- **新增程式碼**:`src/literati_stock/signal/{__init__,base,models,service,jobs,cli}.py` + `rules/{__init__,volume_surge_red}.py`,及對應 tests,估 500–650 行
- **新增依賴**:無(完全複用 SA 2.0 SQL window function、Pydantic、APScheduler、structlog)
- **DB Schema**:新增 `signal_event` 表,可完整 `alembic downgrade`
- **影響的後續 change**:其他 4 個訊號只新增 `Signal` 子類別 + 註冊即可;通知 change 以 `signal_event` 為輸入;回測 change 以 `SignalEvaluationService.backfill` + 統計報表 layer 擴張
