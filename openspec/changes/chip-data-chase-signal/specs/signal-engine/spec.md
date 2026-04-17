## MODIFIED Requirements

### Requirement: Abstract Signal protocol

系統 SHALL 提供 `Signal` Protocol,定義 `name: str` 屬性、`window_days: int` 屬性、`evaluate(features: SignalFeatures, as_of: date) -> list[SignalEventOut]` 方法。`SignalFeatures` 為 frozen dataclass,欄位 `prices: Sequence[PriceRow]`、`institutional: Sequence[InstitutionalRow]`(預設空)、`margin: Sequence[MarginRow]`(預設空)。訊號實作 SHALL 為 pure function。

#### Scenario: Signal satisfies protocol

- **WHEN** `VolumeSurgeRedSignal` / `InstitutionalChaseWarningSignal` 被 type-check 作為 `Signal`
- **THEN** Pyright strict 不報錯

### Requirement: SQL-window feature computation

`SignalEvaluationService` SHALL 提供 `fetch_prices` / `fetch_institutional` / `fetch_margin` 三方法,每個回傳對應 row 類型的 `Sequence`,所有查詢以 `where trade_date <= as_of` 為 look-ahead 防禦。

#### Scenario: fetch_institutional windowed to as_of

- **WHEN** `fetch_institutional(as_of, window_days=3)`
- **THEN** `max(row.trade_date) <= as_of`;回傳涵蓋 window_days 之內可用資料

## MODIFIED Requirements (signal-notification)

### Requirement: Embed format

Embed SHALL 使用以下色碼:買訊(`volume_surge_red` 等)為綠色 `0x3ba55d`;**警訊(`institutional_chase_warning` 等)SHALL 使用金黃色 `0xf0a500`**。其他規則(排序、最多 10 檔、footer 等)維持不變。

#### Scenario: Warning signal uses amber

- **WHEN** `build_embeds` 對 `institutional_chase_warning` 構造 embed
- **THEN** `color == 0xf0a500`
