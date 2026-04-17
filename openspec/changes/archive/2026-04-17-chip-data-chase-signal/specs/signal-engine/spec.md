## MODIFIED Requirements

### Requirement: Abstract Signal protocol

系統 SHALL 提供 `Signal` Protocol,定義 `name: str` 屬性、`window_days: int` 屬性、`evaluate(features: SignalFeatures, as_of: date) -> list[SignalEventOut]` 方法。`SignalFeatures` 為 frozen dataclass,欄位 `prices: Sequence[PriceRow]`、`institutional: Sequence[InstitutionalRow]`(預設空)、`margin: Sequence[MarginRow]`(預設空)。訊號實作 SHALL 為 pure function — 不執行 I/O、不讀未來資料;`evaluate` 接收的所有 rows 的 `trade_date` SHALL 被服務層保證 `<= as_of`。

#### Scenario: Signal satisfies protocol

- **WHEN** `VolumeSurgeRedSignal` / `InstitutionalChaseWarningSignal` 被 type-check 作為 `Signal`
- **THEN** Pyright strict 不報錯

### Requirement: SQL-window feature computation

`SignalEvaluationService` SHALL 提供 `fetch_prices` / `fetch_institutional` / `fetch_margin` 三方法,每個回傳對應 row 類型的 `Sequence`,所有查詢以 `where trade_date <= as_of` 為 look-ahead 防禦。`fetch_prices` 回傳 `PriceRow`(含 `ma_volume` 由 SQL window function 計算);`fetch_institutional` 回傳 `InstitutionalRow`(含 `foreign_net`/`trust_net`/`dealer_net`/`total_net`);`fetch_margin` 回傳 `MarginRow`(含今日/昨日 balance)。

#### Scenario: fetch methods are windowed to as_of

- **WHEN** `fetch_institutional(as_of, window_days=3)` / `fetch_margin(as_of, window_days=3)`
- **THEN** `max(row.trade_date) <= as_of`;回傳涵蓋 window_days 之內可用資料

## ADDED Requirements

### Requirement: Institutional chase warning signal

`InstitutionalChaseWarningSignal`(name=`institutional_chase_warning`, window_days=5) SHALL 在下列條件全部成立時對某 `(stock_id, as_of)` 發出事件:

1. `features.institutional` 在 as_of 當日與前 2 個交易日**連續 3 日皆 `total_net > 0`**(法人連續 3 天淨買超)
2. `features.margin.margin_today_balance` 相較 `window_days // 2` 個交易日前 `margin_today_balance` 增加超過 `min_margin_growth_pct`(預設 5%)
3. `features.prices.close` 在 as_of 相較 `window_days // 2` 個交易日前 `close` **為正**(納入此條件因為「散戶追價」須伴隨實際上漲)

`severity = today_margin_balance / earlier_margin_balance`;`metadata` SHALL 含 `margin_growth_ratio`、`price_change_pct`、`institutional_streak_days`、`window_days`。

#### Scenario: All conditions met fires signal

- **GIVEN** 股 2330、as_of=2026-04-17、過去 3 日 total_net 皆 > 0、margin balance 由 100k→115k(+15%)、close 3 日漲 12%
- **WHEN** signal evaluate
- **THEN** 1 event 回傳,severity ≈ 1.15,metadata 含 margin_growth_ratio ≈ 1.15、price_change_pct > 0

#### Scenario: Institutional sells one day skips

- **GIVEN** 3 日中有 1 日 total_net < 0
- **WHEN** evaluate
- **THEN** 不發事件

#### Scenario: Margin balance stale skips

- **GIVEN** 3 日前 balance == 今日 balance(growth ratio == 1.0)
- **WHEN** evaluate
- **THEN** 不發事件(追價條件不成立)

#### Scenario: Data incomplete skips

- **GIVEN** 某股只有 2 日 institutional 資料(不足 min_institutional_days=3)
- **WHEN** evaluate
- **THEN** 不發事件(資料不足)

#### Scenario: Price down skips

- **GIVEN** 價格 3 日下跌
- **WHEN** evaluate
- **THEN** 不發事件
