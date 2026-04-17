# QA 測試範圍評估報告 — ingest-foundation

## 基本資訊

- 需求/變更名稱:Literati.Stock 資料採集底座(FinMind + 排程 + DLQ + Docker)
- OpenSpec change:`ingest-foundation`
- 分支:`feature/ingest-foundation`
- Commit(截至 QA 時):`cc621c2`
- 提交人:Allen Chan
- 日期:2026-04-17

## 1) 變更範圍摘要

- **本次主要變更**:建立可靠、限速、有失敗追蹤、能偵測 schema drift 的資料採集底座
  - 專案骨架(uv / Pyright strict / Ruff / src layout)
  - 核心基礎設施(Settings、structlog、async DB engine、Alembic)
  - 資料庫運維表(`ingest_raw`、`ingest_failure`)
  - FinMind REST client(`aiolimiter` + `tenacity`,3 種可重試錯誤)
  - 原始 payload 的 Pydantic v2 schema(`extra='allow'`、frozen)
  - Schema drift 哨兵(`SchemaSentinel`)
  - DLQ 寫入器(`RawPayloadStore` + `FailureRecorder`)
  - 排程器 wrapper(`IngestScheduler`,Asia/Taipei timezone)
  - FastAPI app(lifespan 啟動 scheduler + DB)、`/healthz`
  - CLI(`literati-ingest run-once`)
  - Docker multi-stage image + compose stack
- **涉及檔案/模組**:
  - `src/literati_stock/{core,ingest,api,signal}/**`
  - `migrations/env.py`、`migrations/versions/0001_add_ops_tables.py`
  - `Dockerfile`、`compose.yaml`、`.dockerignore`
  - `alembic.ini`、`pyproject.toml`、`.pre-commit-config.yaml`
  - `tests/{unit,integration}/**`
- **非本次範圍(明確不處理)**:
  - 股價 / 法人 / 融資等 **domain table schema**(延後另開 change)
  - **訊號計算 / 回測 framework**
  - **券商 API**(Shioaji、Fugle)
  - **TWSE / TPEx 備援 source**(僅規劃,未實作)
  - LINE / Discord / Email 通知
  - Production deploy pipeline(CI/CD、registry、domain + TLS)

## 2) 建議 QA 驗測重點

- **核心流程**
  - `literati-ingest run-once TaiwanStockPrice --data-id 2330 --start 2025-01-02` 能把 raw payload 落到 `ingest_raw`
  - `/healthz` 回 `{"status":"ok","schedules":N}` 且隨 lifespan 啟動的 scheduler 一致
  - Alembic `upgrade head` / `downgrade base` 對應建表 / 刪表無殘留
- **邊界情境**
  - FinMind 回 HTTP 429 → 觸發 tenacity 指數退避、最多 5 次
  - FinMind 回 HTTP 200 但 body `status == 402` → 視為同一類 rate limit
  - FinMind 回 HTTP 5xx → 重試
  - `AsyncLimiter(max_rate=8, time_period=60)` 下,burst 16 個 request 實際 throughput ≤ 9/min
  - Pydantic schema 收到未宣告欄位 → `__pydantic_extra__` 保留,不丟
  - Pydantic schema 缺必填欄位 → `ValidationError` 立爆
- **例外/錯誤情境**
  - 5 次重試仍失敗 → `FinMindRateLimitError`,`FailureRecorder` 寫入 `ingest_failure` 含 traceback
  - `SchemaSentinel` 偵測欄位增/減 → raise `SchemaDriftError(added, removed)`
  - 樣本查詢 0 rows → `SentinelEmptyResponseError`(不當作 drift)
  - 未知 dataset 呼叫 sentinel → `KeyError`
  - App shutdown 時 scheduler 與 DB engine 均 dispose
- **效能或並發相關觀察點**
  - `max_instances=1` 防止同一 job 並行堆疊
  - `coalesce=True` 避免 misfire 補跑放大
  - SQLAlchemy pool `pool_pre_ping=True` 處理 stale 連線

## 3) 可能受影響模組 / 流程

- **直接受影響**:本 change 內所有新增模組(見第 1 節清單)
- **間接受影響**:
  - 後續 domain table change 將以 `IngestRaw.payload` 為資料來源
  - 訊號 / 回測 change 將依賴本層提供的 raw data + 失敗可見度
- **相依外部系統/服務**:
  - FinMind REST API(`https://api.finmindtrade.com/api/v4/data`)
  - PostgreSQL 16(本機經 `docker compose`,production 同樣 Docker)
  - Docker Desktop(dev / runtime 共用)

## 4) 風險與未覆蓋項目

- **已知風險**
  - FinMind 公開 API 的 throughput 與 response shape 未保證穩定 → 靠 `SchemaSentinel` + `extra='allow'` 緩衝
  - APScheduler v3.x 到 v4.x 將是 breaking upgrade(pin `>=3.10,<4` 規避)
  - aiolimiter 維護動能較低(仍穩定;若未來 stdlib asyncio 變動需 fork)
  - alembic env.py 在測試環境用 subprocess 呼叫 uv → 假設 uv 在 `$PATH`,CI / Docker 已驗證
- **尚未覆蓋測試項目**
  - `literati-ingest run-once` 對真實 FinMind endpoint 的 live smoke(僅 respx mock 過)
  - 在 `compose.yaml` 裡跑 scheduler 觸發真實 cron job 的 end-to-end(本 change 未註冊 domain job)
  - `ingest_raw` / `ingest_failure` 的 partition / retention(本 change 只建表,未做老化策略)
- **未覆蓋原因**
  - 真實 FinMind 呼叫會消耗配額、且不適合放 CI;手動 smoke 在 production token 到位後進行
  - 排程 end-to-end 無意義(本 change 是骨架,實際 jobs 在後續 change)
  - partition / retention 延後到資料量有觀察值才設計
- **建議後續補測**
  - domain table change 合入後,對真實 FinMind 執行一次 ingest 並驗證欄位正確
  - 排程器註冊 3+ jobs 後,觀察 24 小時 misfire / coalesce 行為
  - 人為觸發 5 次失敗 ingest,確認 `ingest_failure` 記錄完整

## 5) 建議回歸測試清單

- [ ] `uv run pytest -q` 全綠(含 integration,需 Docker)
- [ ] `uv run pyright src tests` 0 errors
- [ ] `uv run ruff check` + `uv run ruff format --check` 全綠
- [ ] `docker build -t literati-stock:dev .` 成功,image size < 300 MB
- [ ] `docker compose up -d`,30 秒內 `curl http://localhost:8000/healthz` 回 200
- [ ] `docker compose exec app literati-ingest --help` 顯示 CLI help
- [ ] `alembic upgrade head` 後 `ingest_raw`、`ingest_failure`、`alembic_version` 三表存在;`downgrade base` 後僅剩 `alembic_version`
- [ ] Pydantic schema 對真實 FinMind payload(`curl` 樣本)驗證通過

## 6) 測試證據

- **執行指令與結果(截至 commit `cc621c2`)**
  - `uv run pytest --cov=literati_stock`:**44 passed,coverage 91.48%**(門檻 75%)
  - `uv run pyright src tests`:**0 errors,4 warnings**(全部是 APScheduler upstream stub 的 `reportUnknownMemberType`,非本專案程式碼問題)
  - `uv run ruff check src tests migrations`:All checks passed
  - `uv run ruff format --check src tests migrations`:All formatted
  - `uv run pre-commit run --all-files`:8/8 hooks passed
  - `docker build -t literati-stock:dev .`:success,image size = **69,541,141 bytes ≈ 69 MB**(≪ 300 MB)
  - `docker compose up -d` + 30s wait:postgres healthy、app healthy
  - `docker compose exec app python -c "... healthz"`:`{"status":"ok","schedules":0}`
- **主要 log 關鍵字**:
  - `app.startup jobs=0` / `app.shutdown`
  - `sentinel.drift added=[...] removed=[...]`
  - `finmind.fetch.start` / `finmind.fetch.response http_status=...`
- **SQL injection 檢查**:所有 DB 寫入均透過 SQLAlchemy 2.0 `pg_insert(...).values(...)` parameterised binding;已 `grep -rn 'f".*insert\|f".*select' src/` 無命中
- **PII 檢查**:FinMind 公開市場資料(股價、法人、融資、籌碼)**不含個資**;`ingest_raw` 儲存的 raw payload 為公開數據,無 PII 洩漏風險
