# QA 測試範圍評估報告 — signal-volume-surge

## 基本資訊

- 需求/變更名稱:訊號引擎骨架 + 爆量長紅訊號
- OpenSpec change:`signal-volume-surge`
- 分支:`feature/signal-volume-surge`
- Commit(QA 時):proposal 後,實作與 archive 即將 commit
- 提交人:Allen Chan
- 日期:2026-04-17

## 1) 變更範圍摘要

- **本次主要變更**
  - `Signal` Protocol(`name`、`window_days`、`evaluate` 三元素)+ `PriceRow` dataclass + `SignalEventOut` Pydantic
  - `VolumeSurgeRedSignal`(frozen dataclass,參數 parameterizable)
  - `SignalEvaluationService`(SQL window function 計 ma_volume、look-ahead 防禦、evaluate / backfill、pg_insert upsert)
  - `signal_event` 表 + alembic 0003 migration
  - 每日 17:45 Taipei scheduled `signal_evaluation` cron job
  - `literati-signal evaluate` / `backfill` CLI
- **涉及檔案/模組**:`src/literati_stock/signal/{__init__,base,models,service,jobs,cli}.py`、`rules/{__init__,volume_surge_red}.py`、`migrations/versions/0003_add_signal_event.py`、修改 `api/main.py` + `pyproject.toml`、新增 tests
- **非範圍**:其他 4 個訊號、真正的回測 framework(只做 backfill 到 DB)、通知、排名 API

## 2) 建議 QA 驗測重點

- **核心流程**
  - `alembic upgrade head` → `signal_event` 表 + unique constraint + 2 indexes 都建立
  - `SignalEvaluationService.fetch_prices(as_of, 20)` 在 PG 端用 `avg() OVER (ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)` 計算 ma_volume
  - `evaluate(signal, as_of)` 成功時寫 `signal_event`,重跑時 upsert 覆寫
  - `backfill(signal, start, end)` 遍歷存在資料的交易日
  - `/healthz` 回 `schedules >= 2`(price_transform + signal_evaluation)
  - `literati-signal` CLI 兩子指令可用
- **邊界情境**
  - `open == 0` 或負值 → skip(無法算 red_bar_pct)
  - `ma_volume is None`(歷史不足)→ skip
  - `close < min_close_price`(仙股)→ skip
  - `(close - open) / open < min_red_bar_pct` → skip
  - `volume < volume_multiple * ma_volume` → skip
  - 非 `as_of` 日期的 row → skip
  - 同 `(signal_name, stock_id, trade_date)` 重跑 → upsert 覆寫
  - Backfill 起日 > 終日 → raise ValueError
- **例外/錯誤情境**
  - fetch_prices 意外回傳 `trade_date > as_of` → raise RuntimeError(look-ahead 二次防禦)
  - CLI 接不存在的 signal 名字 → SystemExit with hint
- **效能與並發**
  - SQL 端計算 ma_volume(非 Python 迴圈),對 1810 rows × 5 檔資料集秒級完成
  - `max_instances=1` 確保 signal_evaluation job 不並發堆疊

## 3) 可能受影響模組 / 流程

- **直接受影響**:`api/main.py` lifespan 多註冊一個 job → `/healthz` 的 schedules 增至 >=2;`pyproject.toml` 多一個 console_script
- **間接受影響**:通知 change 未來以 `signal_event` 為輸入;其他 4 個訊號各自新增 `Signal` 子類別即可
- **相依外部系統/服務**:同前(PostgreSQL 16、Docker Desktop);**無新增第三方依賴**

## 4) 風險與未覆蓋項目

- **已知風險**
  - Decimal 與 float 的精度界面:`volume_multiple: float` / `min_red_bar_pct: float` 轉 Decimal 用 `Decimal(str(...))`,避免 float 精度噪音
  - Protocol 與 `@dataclass(frozen=True)` 的讀寫語意:已用 `@property` 在 Protocol 表達 read-only 契約,滿足 frozen dataclass
  - 真實 FinMind 回來的 `ingest_raw` payload 若有 corrupted row,transform 已會 rollback(price-domain 的守備),所以 `stock_price` 永遠一致 — 但 signal 仍可能因部分回補資料而 emit 不穩定結果;靠 upsert + cursor replay 修正
- **尚未覆蓋測試項目**
  - 真實世界 production 資料的 smoke(需要實跑 `literati-signal backfill` 對灌好的 5 檔 × 18 個月資料)
  - 多訊號並行註冊的整合測試(目前只有 VolumeSurgeRedSignal 一個)
  - 對 `stop / restart` 時 signal_evaluation job 的 misfire 行為
- **未覆蓋原因**
  - Smoke 需人工 kickoff + 觀察;留給 PR merge 後手動跑
  - 多訊號整合留待第二個訊號被實作時
- **建議後續補測**
  - 對實際灌入的 5 檔 18 個月資料手動跑 `literati-signal backfill volume_surge_red --start 2024-11-01 --end 2026-04-17`,檢查輸出 JSON 的 events_emitted 是否合理

## 5) 建議回歸測試清單

- [ ] `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠(含 integration)
- [ ] `uv run pyright src tests` strict 0 errors
- [ ] `uv run ruff check` + `ruff format --check` 全綠
- [ ] `uv run pre-commit run --all-files` 全綠
- [ ] `alembic upgrade head` → `signal_event` + 兩 indexes + unique constraint 都在
- [ ] `alembic downgrade -1` → 該表消失,`stock_price` / `ingest_cursor` / `ingest_raw` 不受影響
- [ ] `docker compose up -d` 起來後 `/healthz` 回 `schedules >= 2`
- [ ] `docker compose exec app literati-signal --help` 顯示 `evaluate` + `backfill` 子指令
- [ ] 灌好資料後 `literati-signal backfill volume_surge_red --start 2024-11-01 --end 2026-04-17` 輸出 events_emitted > 0 且與手算對照一致

## 6) 測試證據

- **執行指令與結果**
  - `uv run pytest --cov=literati_stock` → **74 passed(+20 新),coverage 86.67%**(門檻 75%)
  - `uv run pyright src tests` → **0 errors, 15 warnings**(全部 APScheduler upstream stub)
  - `uv run ruff check src tests migrations` → All passed
  - `uv run ruff format --check` → 46 files formatted
- **主要 log 關鍵字**
  - `signal.evaluate signal=volume_surge_red as_of=... rows_considered=N events_emitted=M`
  - `app.startup jobs=2`(price_transform + signal_evaluation)
- **SQL injection 檢查 ✓**:`fetch_prices` 用 SA 2.0 `select(...).where(...)`;`backfill` 用 `select(distinct(...)).where(...)`;`_upsert_events` 用 `pg_insert(...).values(rows)` + `on_conflict_do_update(set_=...)`;**無字串拼接**
- **PII 檢查 ✓**:`signal_event.metadata` 只含數值 metadata(close、volume、ma_volume 等公開市場資料);**無個資**
- **新增套件 ✓**:**無**;完全複用 SA 2.0 / APScheduler / Pydantic / structlog / asyncpg
- **Make-vs-Buy**:§3e-1 豁免(純業務邏輯 + domain-specific rule);詳見 `make-vs-buy.md`
