# QA 測試範圍評估報告 — chip-data-chase-signal

## 基本資訊

- 需求/變更:籌碼資料(法人 / 融資融券)domain + ELT + 新訊號(散戶追價警訊)
- OpenSpec change:`chip-data-chase-signal`
- 分支:`feature/chip-data-chase-signal`
- 日期:2026-04-17

## 1) 變更範圍摘要

- 新增 `institutional_buysell` / `margin_transaction` domain tables + alembic 0005
- 新增 `TaiwanStockMarginPurchaseShortSaleRow` schema(既有 `TaiwanStockInstitutionalInvestorsBuySellRow` 已存在)
- 新增 `InstitutionalTransformService`(aggregation by投資人類別)+ `MarginTransformService`(1:1 upsert),共用 `ingest_cursor`
- 泛化 `DailyPriceIngestService` → `DailyWatchlistIngestService(dataset=...)`;保留 `DailyPriceIngestService` 作 backward-compat 子類別
- Scheduled 4 個新 job:chip_ingest_institutional(Mon-Fri 16:30)、chip_ingest_margin(Mon-Fri 15:30)、institutional_transform(5 min)、margin_transform(5 min)
- Signal API:新增 `SignalFeatures`(prices + institutional + margin),`Signal.evaluate` signature 改為接受 features;`VolumeSurgeRedSignal` 相應改寫(只用 `features.prices`)
- 新訊號 `InstitutionalChaseWarningSignal`:法人連續 3+ 天買超 + 融資餘額 3 日增加 ≥ 5% + 股價上漲 → 散戶追價警訊
- Notification:`institutional_chase_warning` 用 amber `0xf0a500` 色塊(警訊),中文標籤「散戶追價警訊」
- CLI:`literati-ingest` 新增 `sync-chip-today` / `transform-institutional` / `transform-margin`;`literati-signal` registry 加入新訊號

## 2) QA 驗測重點

- Migration:`institutional_buysell` + `margin_transaction` 都建立 + FK to ingest_raw + indexes;`downgrade -1` 僅移除兩表
- Institutional 彙總:Foreign_Investor → foreign_net,Investment_Trust → trust_net,Dealer*/Foreign_Dealer_* → dealer_net,total_net 為三者之和
- Margin 1:1 upsert
- `SignalFeatures` 在 `VolumeSurgeRedSignal` 下仍照舊工作(向下相容)
- `InstitutionalChaseWarningSignal` 5 scenarios(全滿/各一不滿)
- `/healthz` schedules = 8(無 webhook)/ 9(有 webhook)
- Discord embed 對 `institutional_chase_warning` 用 amber;`volume_surge_red` 仍綠色

## 3) 可能受影響模組 / 流程

- `VolumeSurgeRedSignal.evaluate` signature 改變;測試、service、CLI 使用處均更新
- `DailyPriceIngestService` 現為 `DailyWatchlistIngestService` 子類別,既有 test / CLI 呼叫不動
- `api/main.py` lifespan 多 4 job + 加入 ICW signal
- `SignalEvaluationService.evaluate` 每次呼叫多 2 個 SQL query(fetch_institutional / fetch_margin);對 MVP 5 檔 × ~20 天 window scale 可忽略

## 4) 風險與未覆蓋項目

- **Signal API breaking change**:`Signal.evaluate(rows)` → `Signal.evaluate(features)`。外部無 consumer,內部所有使用處已更新。
- **Institutional 類別未覆蓋**:FinMind 可能未來新增投資人類別(如 `Foreign_Self` 或其他),`_categorize` 會歸類為 `unknown` 並 log warning。不會崩潰但資料會漏計。
- **Daily ingest rate limit**:watchlist 5 檔 × 2 datasets × 1 day = 10 calls/day,遠低於 300/hr anonymous。擴展到全市場需評估。
- **Institutional/margin backfill 未實施**:此 change 只設 daily cron;歷史資料需日後手動 `sync-chip-today --as-of 每日` 或另開 backfill change。
- **測試的 ICW signal 尚未對真實資料產出事件**:因為只有 2 天的 chip data。邏輯由 unit test 5 scenarios 保證。

## 5) 回歸測試清單

- [ ] `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠
- [ ] `uv run pyright src tests` strict 0 errors
- [ ] `uv run ruff check/format --check` 全綠
- [ ] `docker compose up -d --build` 後 `/healthz` 回 `schedules == 9`
- [ ] `literati-ingest sync-chip-today --as-of 2026-04-15` 對真 FinMind → 10 筆 ingest_raw(5 institutional + 5 margin)
- [ ] `literati-ingest transform-institutional` + `transform-margin` → domain tables 各有 5 筆
- [ ] `alembic downgrade -1` → `institutional_buysell` + `margin_transaction` 消失,其他表不動

## 6) 測試證據

- `uv run pytest` → **125 passed(+15 new)**,coverage ~87%
- `uv run pyright src tests` → **0 errors, 45 warnings**(皆 APScheduler stub)
- `uv run ruff` → All green
- **Docker smoke(真 FinMind,backdate 2026-04-15)**:
  - `/healthz` = `schedules: 9`
  - `sync-chip-today --as-of 2026-04-15` → 10 筆 raw 成功
  - `transform-institutional` → 10 upserts(FinMind 回 2 日資料);`transform-margin` → 10 upserts
  - DB:`institutional_buysell` 5 檔 × 2026-04-16 完整(2303 聯電 foreign_net +33.87M、total_net +49.74M);`margin_transaction` 5 檔 × 2026-04-16 完整
- **SQL injection ✓**:全部 SA 2.0 parameterised insert/update
- **PII ✓**:公開市場資料,無個資
- **新增依賴 ✓**:**無**
- **Make-vs-Buy**:§3e-1 豁免(純業務邏輯 + glue code)
