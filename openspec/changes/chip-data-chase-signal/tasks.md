# tasks — chip-data-chase-signal

> 每個 task 完成後在框內勾選 `[x]`。驗收條件未滿足前禁止勾選。

## A. 資料模型 + Migration + 原始 Schema

- [ ] **A1. `src/literati_stock/chip/models.py`:`InstitutionalBuysell` + `MarginTransaction` ORM**
  - 驗收:Pyright strict 0 errors;主鍵都是 `(stock_id, trade_date)`;皆 FK `ingest_raw(id)`
- [ ] **A2. `ingest/schemas/finmind_raw.py` 新增 `TaiwanStockMarginPurchaseShortSaleRow` + 登錄 `EXPECTED_FIELDS`**
  - 驗收:unit test 驗證 sample payload 解析
- [ ] **A3. Alembic `0005_add_chip_tables`(institutional + margin + indexes)**
  - 驗收:integration test `upgrade head` → 兩表存在;`downgrade -1` → 兩表消失、其他不受影響

## B. Transform services

- [ ] **B1. `src/literati_stock/chip/transform.py`:`InstitutionalTransformService.process_new()`**
  - 彙總邏輯:group by `(stock_id, date)` → foreign_net / trust_net / dealer_net(dealer 子類別 sum)/ total_net
  - 驗收:integration test 驗證 3 類型投資人 payload 正確彙總為單列;多 dealer 子類別正確合計;cursor 前進
- [ ] **B2. `MarginTransformService.process_new()`(1:1 upsert)**
  - 驗收:integration test 驗證每筆 payload row 1:1 upsert,多次重跑覆寫

## C. Signal engine 擴展

- [ ] **C1. `signal/base.py` 新增 `SignalFeatures` frozen dataclass(prices/institutional/margin);`Signal.evaluate(features, as_of)`**
  - 驗收:Pyright strict 0 errors;`VolumeSurgeRedSignal` 改用 `features.prices` 後既有測試仍全綠
- [ ] **C2. `signal/service.py` 新增 `fetch_institutional` / `fetch_margin`,`evaluate` 組裝 `SignalFeatures`**
  - 驗收:integration test:fetch_institutional / fetch_margin 於 as_of 限制下正確
- [ ] **C3. `signal/rules/institutional_chase.py`:`InstitutionalChaseWarningSignal` 類別**
  - 驗收:unit test 驗證 4 scenarios(條件全滿發訊;任一不滿不發;資料不足不發;severity 計算正確)

## D. Ingest scheduler + CLI

- [ ] **D1. Extend daily ingest 或 new `ChipIngestService`:對 watchlist fetch `TaiwanStockInstitutionalInvestorsBuySell` + `TaiwanStockMarginPurchaseShortSale`**
  - 驗收:integration test 驗證:watchlist 2 檔、mock FinMind 兩 dataset → 4 筆 ingest_raw(2 institutional + 2 margin),0 失敗
- [ ] **D2. 4 個新 scheduled jobs:`chip_ingest_institutional`(Mon-Fri 16:30)、`chip_ingest_margin`(Mon-Fri 15:30)、`institutional_transform`(每 5 分鐘)、`margin_transform`(每 5 分鐘)**
  - 驗收:unit test 驗證四個 job id 與 trigger 正確
- [ ] **D3. `literati-ingest` 新增 3 子指令:`sync-chip-today [--as-of]`、`transform-institutional`、`transform-margin`**
  - 驗收:`literati-ingest --help` 顯示三個子指令;unit test argparse 解析正確
- [ ] **D4. lifespan 加 `InstitutionalChaseWarningSignal` 到 signals list + `register_*_jobs` 註冊四個新 job**
  - 驗收:integration test `/healthz` 回 `schedules == 9`(帶 webhook)/ `== 8`(無 webhook)

## E. Notification / Discord 擴展

- [ ] **E1. `notify/templates.py` 新增色碼判定:warning signals 使用 amber `0xf0a500`;新增 `SIGNAL_LABELS_ZH['institutional_chase_warning'] = '散戶追價警訊'`**
  - 驗收:unit test 驗證 `institutional_chase_warning` embed color 為 amber;既有 `volume_surge_red` 仍為綠色

## F. QA 與收尾

- [ ] **F1. `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠**
- [ ] **F2. `uv run pyright src tests` strict 0 errors**
- [ ] **F3. `uv run ruff check` + `ruff format --check` 全綠**
- [ ] **F4. Docker smoke:`docker compose up -d --build` `/healthz` == 9;`literati-ingest sync-chip-today --as-of YYYY-MM-DD` 對真 FinMind 成功;`literati-signal backfill institutional_chase_warning --start --end` 產出合理事件數**
- [ ] **F5. `qa-test-scope.md` 寫入**
- [ ] **F6. archive + push + PR**
