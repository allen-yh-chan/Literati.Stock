## Why

Literati.Stock 的核心投資理論「量先價行」依賴 FinMind 提供的台股量價、法人、融資、籌碼資料。在訊號計算、回測、API 服務之前,必須先建立**可靠、限速、有失敗追蹤、能偵測 schema drift** 的資料採集底座。本 change 不含 domain table、不含訊號邏輯,只到「外部資料能可靠落地到 PostgreSQL 運維表」為止。沒有這層基礎,後續一切建構在沙子上。

## What Changes

- 新增 Python 專案骨架(`pyproject.toml`、`uv` workspace 預備、src layout、Pyright strict)
- 新增資料採集層:`FinMindClient`(`aiolimiter` 限速 + `tenacity` 重試)、`SchemaSentinel`(欄位漂移偵測)、`RawPayloadStore` 與 `FailureRecorder`(DLQ)
- 新增排程器封裝:`IngestScheduler`(基於 `apscheduler.AsyncIOScheduler`,timezone=`Asia/Taipei`)
- 新增 FastAPI 應用骨架(`/healthz`)+ lifespan 啟動 scheduler 與 DB pool
- 新增 CLI(`literati-ingest run-once <dataset> --start --end`)用於手動觸發或單次執行
- 新增 PostgreSQL 運維表 `ingest_raw`、`ingest_failure`(由 Alembic 管理 migration)
- 新增結構化日誌(`structlog`,JSON / console 兩 mode)
- 新增 Docker 部署:multi-stage `Dockerfile` + `compose.yaml`(app + postgres:16-alpine)+ `.dockerignore`
- 新增測試環境:`testcontainers-python` PostgreSQL session-scoped fixture
- 新增 pre-commit + Ruff + Pyright + pytest 工具鏈

**非範圍**:股價/法人/融資的 domain table schema、訊號計算、回測、券商 API。皆延後另開 change。

## Capabilities

### New Capabilities

- `data-ingestion`:對外部市場資料 source(本 change 為 FinMind)的限速採集、Pydantic 強解、schema drift 偵測、失敗紀錄、排程執行、容器化部署。

### Modified Capabilities

(無 — 此為專案首個 capability)

## Impact

- **新增程式碼**:`src/literati_stock/{core,ingest,api,signal}/...` 約 600–800 行(含 tests)
- **新增依賴**:`apscheduler`、`aiolimiter`、`tenacity`、`structlog`、`pydantic`、`pydantic-settings`、`sqlalchemy[asyncio]`、`asyncpg`、`alembic`、`httpx`、`fastapi`、`uvicorn`(全 permissive license,見 `make-vs-buy.md`;FinMind 由 `httpx` 直接打 REST,不用 SDK)
- **新增基礎設施**:PostgreSQL 16(local 經 docker compose,production 同樣 Docker;雲端 PG 為未來決議)
- **新增執行環境**:Docker Desktop;production image < 300MB
- **影響的後續 change**:domain table schema、訊號引擎、回測 framework 都將以本層為輸入
