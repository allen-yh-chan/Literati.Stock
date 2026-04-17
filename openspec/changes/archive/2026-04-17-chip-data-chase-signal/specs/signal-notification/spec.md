## MODIFIED Requirements

### Requirement: Embed format

Embed payload SHALL 含:
- `title`:含訊號中文名(如「爆量長紅」/「散戶追價警訊」)與 `as_of` 日期
- `color`:
  - 買訊(如 `volume_surge_red`)使用綠色 `0x3ba55d`
  - **警訊(如 `institutional_chase_warning`)使用金黃色 `0xf0a500`**
- `description`:命中檔數摘要
- `fields`:依 `severity` 由高到低排序最多 10 檔;`name` 為 `{stock_id}`,`value` 為 signal-specific 格式化字串
- `footer.text`:`literati-stock · signal: {signal_name}`

#### Scenario: Fields sorted by severity desc

- **GIVEN** 三檔事件,severity 2.0 / 4.1 / 3.2
- **WHEN** `publish_daily` 構造 embed
- **THEN** fields 順序為 4.1 → 3.2 → 2.0

#### Scenario: More than 10 hits are truncated

- **GIVEN** 15 檔命中
- **WHEN** embed 構造
- **THEN** fields 有前 10 檔,description 註明「+5 more」

#### Scenario: Warning signal uses amber colour

- **WHEN** `build_embeds` 對 `institutional_chase_warning` 構造 embed
- **THEN** `color == 0xf0a500`
