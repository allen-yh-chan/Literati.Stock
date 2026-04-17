## Why

單一訊號(爆量長紅)只看價量是片面的。真正「量先價行」的教科書型訊號 —— 如「**法人買超 + 融資同步增加 = 散戶追價警訊**」—— 需要籌碼資料(institutional / margin)與價量交叉驗證。此 change 同時(a) 引入 institutional 與 margin 兩個 domain 資料表 + ELT pipeline,(b) 擴展 signal API 讓訊號可存取多個資料面,(c) 交付第 2 個 production signal `institutional_chase_warning`。完成後每日 Discord 推播會同時出現爆量長紅(買訊)與 散戶追價警訊(高風險訊號),signal 厚度顯著提升。

## What Changes

- 新增 domain tables
  - `institutional_buysell(stock_id, trade_date, foreign_net, trust_net, dealer_net, total_net, source_raw_id, ingested_at)` — 每 (stock, date) 彙總三類法人淨買賣
  - `margin_transaction(stock_id, trade_date, margin_purchase_buy/sell, margin_today/yesterday_balance, short_sale_buy/sell, short_today/yesterday_balance, source_raw_id, ingested_at)` — 融資融券每日餘額 + 進出
- Alembic `0005_add_chip_tables`
- 新增 Pydantic 原始 schemas:`TaiwanStockMarginPurchaseShortSaleRow` + 更新 `EXPECTED_FIELDS`(institutional 已有)
- 新增 Transform services:
  - `InstitutionalTransformService.process_new()` — 讀 ingest_raw(dataset=TaiwanStockInstitutionalInvestorsBuySell)、Python 端 group by (stock, date) 將 3-5 列投資人類別彙總為一列、upsert
  - `MarginTransformService.process_new()` — 標準 1:1 upsert
  - 兩者都用 `ingest_cursor` 的 `dataset` 為 key,與既有 `PriceTransformService` 相同 pattern
- 擴充 `DailyIngestService`(原 `DailyPriceIngestService` 泛化 / 或新增 parallel service):每日 14:30 處理價格,15:30 處理融資,16:30 處理法人(台股公布時間錯開)
- 擴展 Signal engine:
  - 新增 `SignalFeatures` frozen dataclass(`prices`, `institutional`, `margin`)
  - `Signal.evaluate` 改接受 `SignalFeatures`(**breaking change**,但只有一個既有實作 VolumeSurgeRedSignal 要調整)
  - `SignalEvaluationService.fetch_*` 多兩組(`fetch_institutional`, `fetch_margin`)
- 新增 `InstitutionalChaseWarningSignal`(簡稱 ICW):
  - 條件:過去 3 交易日法人淨買連續為正 AND 融資餘額連續 2+ 天增加
  - severity = `margin_today_balance / margin_balance_3d_ago`(追漲強度)
- `literati-signal evaluate/backfill/notify` 註冊 ICW;Discord 用金黃色 `#f0a500` 色塊(**警訊**,非買訊)

**非範圍**:集保張數分布(shareholding)表、盤中 5 秒資料、signal parameter sweep、台股假日日曆、多投資人類別細分(Foreign 再分外資自營 vs 外資代理等)。

## Capabilities

### New Capabilities

- `chip-data`:籌碼資料(法人、融資融券)的 domain table + ELT transform + 排程 ingest。

### Modified Capabilities

- `signal-engine`:`Signal.evaluate` 契約由 `Sequence[PriceRow]` 擴為 `SignalFeatures`(多資料面);既有 `VolumeSurgeRedSignal` 同步調整(僅用 `features.prices`)。
- `signal-notification`:新增 `institutional_chase_warning` 的中文標籤(「散戶追價警訊」)與警告色 embed。
- `data-ingestion`:`DailyIngestService` 支援多 dataset,`ingest_cursor` 新增兩個 dataset key。

## Impact

- **新增程式碼**:~800 行(含 tests)。domain tables / transforms / signal / 測試
- **新增依賴**:無
- **DB schema**:新增 2 張表 + FK 到 `ingest_raw`;可完整 rollback
- **Signal API breaking**:`VolumeSurgeRedSignal.evaluate` signature 調整。測試需跟著改。外部(如未來其他 consumer)無,因 API 只供 `SignalEvaluationService` 使用。
