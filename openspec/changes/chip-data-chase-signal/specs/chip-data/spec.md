## ADDED Requirements

### Requirement: Institutional buy-sell domain table

系統 SHALL 提供 `institutional_buysell` 表,欄位 `stock_id text`、`trade_date date`、`foreign_net bigint`、`trust_net bigint`、`dealer_net bigint`、`total_net bigint`、`source_raw_id bigint FK ingest_raw(id)`、`ingested_at timestamptz`;主鍵 `(stock_id, trade_date)`。`foreign_net`/`trust_net` 為對應投資人類別的 `buy - sell`;`dealer_net` 為所有 dealer 類別(Dealer、Dealer_self、Dealer_Hedging 等)之總和;`total_net = foreign_net + trust_net + dealer_net`。

#### Scenario: Migration creates table

- **WHEN** `alembic upgrade head` 對乾淨 DB 執行
- **THEN** `institutional_buysell` 存在,主鍵 `(stock_id, trade_date)`

#### Scenario: Downgrade removes institutional table

- **WHEN** `alembic downgrade -1`(從 0005 回到 0004)
- **THEN** `institutional_buysell` 不存在;其他表不受影響

### Requirement: Margin transaction domain table

系統 SHALL 提供 `margin_transaction` 表,欄位 `stock_id`、`trade_date`、`margin_purchase_buy/sell bigint`、`margin_today_balance bigint`、`margin_yesterday_balance bigint`、`short_sale_buy/sell bigint`、`short_today_balance bigint`、`short_yesterday_balance bigint`、`source_raw_id`、`ingested_at`;主鍵 `(stock_id, trade_date)`。

#### Scenario: Migration creates margin table

- **WHEN** `alembic upgrade head`
- **THEN** `margin_transaction` 存在

### Requirement: Institutional transform aggregates investor types

系統 SHALL 提供 `InstitutionalTransformService.process_new()`,讀取 `ingest_raw(dataset='TaiwanStockInstitutionalInvestorsBuySell')`,Python 端依 `(stock_id, date)` group,將各投資人類別(`Foreign_Investor` / `Investment_Trust` / 其他含 `Dealer` 前綴者)彙總成一列、upsert `institutional_buysell`。與 `PriceTransformService` 一樣使用 `ingest_cursor` 以 dataset 為 key 保證 idempotent replay,且整個批次於一個 transaction 內完成。

#### Scenario: Three investor-type rows merge into one

- **GIVEN** `ingest_raw` 有 1 筆 payload 含 3 個 row(Foreign_Investor、Investment_Trust、Dealer,分別 buy/sell)
- **WHEN** `process_new()` 執行
- **THEN** `institutional_buysell` 新增 1 列,`foreign_net / trust_net / dealer_net` 分別為對應類別的 `buy - sell`,`total_net` 為三者之和

#### Scenario: Multiple dealer subtypes are summed

- **GIVEN** payload 含 `Dealer`、`Dealer_self`、`Dealer_Hedging` 三個 dealer 子類別
- **WHEN** transform 執行
- **THEN** `dealer_net = sum of (buy-sell) across all dealer subtypes`

#### Scenario: Cursor advances once per batch

- **WHEN** batch 中有 k 個 `ingest_raw` 列
- **THEN** `ingest_cursor.last_raw_id` 前進到批次最大 raw id,失敗時整批 rollback

### Requirement: Margin transform one-to-one

系統 SHALL 提供 `MarginTransformService.process_new()`,讀取 `ingest_raw(dataset='TaiwanStockMarginPurchaseShortSale')`,每筆 payload row 以 `TaiwanStockMarginPurchaseShortSaleRow` Pydantic 強解,1:1 upsert 進 `margin_transaction`。

#### Scenario: One payload row → one domain row

- **GIVEN** `ingest_raw` 有 1 筆 payload(1 股、1 日的融資融券)
- **WHEN** `process_new()` 執行
- **THEN** `margin_transaction` 新增 1 列,對應 today/yesterday balances

#### Scenario: Re-run upserts on conflict

- **WHEN** 同 `(stock_id, trade_date)` 再跑一次
- **THEN** 表只有 1 列,值更新為最新

### Requirement: Scheduled chip ingest and transform jobs

FastAPI lifespan SHALL 註冊下列 scheduled jobs:
- `chip_ingest_institutional` — Mon-Fri 16:30 Asia/Taipei(台股盤後法人公布時間之後),對 watchlist 各檔呼叫 FinMind `TaiwanStockInstitutionalInvestorsBuySell` 當日 → `ingest_raw`
- `chip_ingest_margin` — Mon-Fri 15:30 Asia/Taipei,對 watchlist 各檔呼叫 FinMind `TaiwanStockMarginPurchaseShortSale` 當日 → `ingest_raw`
- `institutional_transform` — 每 5 分鐘,呼叫 `InstitutionalTransformService.process_new()`
- `margin_transform` — 每 5 分鐘,呼叫 `MarginTransformService.process_new()`

#### Scenario: Healthz after chip jobs

- **WHEN** lifespan 啟動且 `DISCORD_WEBHOOK_URL` 已設
- **THEN** `/healthz` 回 `schedules == 9`(既有 5 + 新增 4:institutional ingest、margin ingest、institutional transform、margin transform)

### Requirement: CLI subcommands for chip datasets

`literati-ingest` SHALL 新增 `sync-chip-today [--as-of DATE]` 手動觸發 watchlist 當日的 institutional + margin 兩 dataset ingest;`literati-ingest` SHALL 新增 `transform-institutional` 與 `transform-margin` 兩個子指令手動觸發 transform。

#### Scenario: Sync-chip-today writes raws for both datasets

- **GIVEN** watchlist 2 檔
- **WHEN** `literati-ingest sync-chip-today --as-of 2026-04-17` 對 mock FinMind
- **THEN** `ingest_raw` 新增 4 筆(2 institutional + 2 margin),exit 0

## MODIFIED Requirements

### Requirement: Abstract Signal protocol

系統 SHALL 提供 `Signal` Protocol(於 `literati_stock.signal.base`),定義 `name: str` 屬性、`window_days: int` 屬性、與 `evaluate(features: SignalFeatures, as_of: date) -> list[SignalEventOut]` 方法;並 SHALL 提供 `SignalEventOut` Pydantic model(frozen,欄位 `signal_name, stock_id, trade_date, severity, metadata`)。

系統 SHALL 提供 `SignalFeatures` frozen dataclass,欄位:
- `prices: Sequence[PriceRow]`
- `institutional: Sequence[InstitutionalRow]`(空序列為預設)
- `margin: Sequence[MarginRow]`(空序列為預設)

訊號實作 SHALL 為 pure function — 不執行 I/O、不讀未來資料;`evaluate` 接收的所有 rows 的 `trade_date` SHALL 被服務層保證 `<= as_of`。

#### Scenario: A signal satisfies the protocol structurally

- **WHEN** `VolumeSurgeRedSignal` 或 `InstitutionalChaseWarningSignal` 被 type-check 作為 `Signal`
- **THEN** Pyright strict 不報錯

### Requirement: SQL-window feature computation

系統 SHALL 提供 `SignalEvaluationService.fetch_prices(as_of, window_days)` 回傳價量 `PriceRow`(含 `ma_volume`);以及 `fetch_institutional(as_of, window_days)` 回傳 `InstitutionalRow`(含 `foreign_net`/`trust_net`/`dealer_net`/`total_net`);以及 `fetch_margin(as_of, window_days)` 回傳 `MarginRow`(含今日/昨日 balance)。三者皆 `where trade_date <= as_of`,look-ahead 防禦內建。

#### Scenario: Fetch methods return windowed data up to as_of

- **WHEN** `fetch_institutional(as_of=2026-04-17, window_days=3)`
- **THEN** 結果最大 `trade_date == 2026-04-17`,`trade_date` 皆 `>= 2026-04-14`(視資料;容忍歷史 > window_days 範圍)

## ADDED Requirements (signal-engine cont.)

### Requirement: Institutional chase warning signal

`InstitutionalChaseWarningSignal`(name=`institutional_chase_warning`, window_days=5) SHALL 在下列條件全部成立時對某 `(stock_id, as_of)` 發出事件:

1. `institutional.total_net` 在 as_of 當日與前 2 個交易日**連續 3 日皆為正**(法人連續 3 天淨買超)
2. `margin.margin_today_balance` 相較 3 個交易日前 `margin_today_balance` 增加超過 `min_margin_growth_pct`(預設 5%)
3. `prices.close` 在 as_of 的漲幅(close 相對 as_of 前 3 日 close)**為正**(納入此條件因為「散戶追價」須伴隨實際上漲)

`severity = margin_today_balance / margin_balance_3d_ago`;`metadata` SHALL 含 institutional 3 日 total_net、margin 3 日 balance、price change pct。

#### Scenario: All conditions met fires signal

- **GIVEN** 股 2330、as_of=2026-04-17、過去 3 日 total_net 皆 > 0、margin balance 由 10k→12k(+20%)、close 3 日漲 5%
- **WHEN** signal evaluate
- **THEN** 1 event 回傳,severity ≈ 1.2,metadata 含三日 net、balance、漲幅

#### Scenario: Institutional sells one day skips

- **GIVEN** 3 日中有 1 日 total_net < 0
- **WHEN** evaluate
- **THEN** 不發事件

#### Scenario: Margin balance stale skips

- **GIVEN** 3 日前 balance == 今日 balance
- **WHEN** evaluate
- **THEN** 不發事件(追價條件不成立)

#### Scenario: Data incomplete skips

- **GIVEN** 某股只有 2 日 institutional 資料(不足 window)
- **WHEN** evaluate
- **THEN** 不發事件(資料不足)

## MODIFIED Requirements (signal-notification)

### Requirement: Embed format

Embed payload SHALL 含:
- `title`:含訊號中文名(如「爆量長紅」/「散戶追價警訊」)與 `as_of` 日期
- `color`:
  - 買訊(如 `volume_surge_red`)使用綠色 `0x3ba55d`
  - **警訊(如 `institutional_chase_warning`)SHALL 使用金黃色 `0xf0a500`**
- `description`:命中檔數摘要
- `fields`:依 `severity` 由高到低排序最多 10 檔,`name` 為 `{stock_id}`,`value` 為 signal-specific 格式化字串
- `footer.text`:`literati-stock · signal: {signal_name}`

#### Scenario: Warning signal uses golden colour

- **WHEN** `build_embeds` 構造 `institutional_chase_warning` 的 embed
- **THEN** `color == 0xf0a500`(金黃警告色)

#### Scenario: Buy signal retains green

- **WHEN** 構造 `volume_surge_red` 的 embed
- **THEN** `color == 0x3ba55d`(綠色)
