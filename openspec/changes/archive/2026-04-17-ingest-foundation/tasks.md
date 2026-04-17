# tasks — ingest-foundation

> 每個 task 完成後在框內勾選 `[x]`。驗收條件未滿足前禁止勾選。

## A. 專案骨架 + 工具鏈

- [x] **A1. 寫 `pyproject.toml`(project 元資料 + runtime deps + `[dependency-groups]` + 所有 tool 設定區塊)**
  - 驗收:`uv sync --no-dev --no-group test --no-group notebook --no-group research` 成功;`uv sync` 含 dev + test;`uv run python -c "import literati_stock"` 不報錯;含 `[tool.pyright]`、`[tool.ruff]`、`[tool.pytest.ini_options]`、`[tool.coverage.*]`、`[tool.uv]`
- [x] **A2. 寫 `.python-version`(`3.12`)**
  - 驗收:`uv run python --version` 顯示 `Python 3.12.x`
- [x] **A3. 建 src layout 骨架(`src/literati_stock/{core,ingest,signal,api}/__init__.py`)**
  - 驗收:`uv run python -c "from literati_stock import core, ingest, signal, api"` 不報錯
- [x] **A4. `.env.example` 列出所有 env vars(`DATABASE_URL`、`FINMIND_TOKEN`、`LOG_LEVEL`、`LOG_FORMAT`、`SCHEDULER_TIMEZONE`),每個有 inline 註解**
  - 驗收:檔案存在;`grep -c "^[A-Z_]*=" .env.example` ≥ 5
- [x] **A5. `.pre-commit-config.yaml`:ruff + ruff-format + check-toml + check-yaml + trailing-whitespace + check-added-large-files**
  - 驗收:`uv run pre-commit install` 成功;`uv run pre-commit run --all-files` 全綠

## B. 核心基礎設施

- [x] **B1. `core/settings.py`:`Settings(BaseSettings)` 從 env + `.env` 載入,frozen,全 typed**
  - 驗收:unit test 驗證:必填欄位 missing 時 `pytest.raises(ValidationError)`;能正確從 `.env.test` 載入;`Settings()` instance 為 immutable(`frozen=True`)
- [x] **B2. `core/logging.py`:structlog bootstrap;`LOG_FORMAT=json`(prod)/`console`(dev)兩 mode**
  - 驗收:unit test 驗證:`get_logger("x").info("hello", k=1)` json mode 輸出可被 `json.loads` parse 且含 `event`/`level`/`timestamp`/`k` keys;console mode 為 human-readable
- [x] **B3. `ingest/db.py`:`create_async_engine` + `async_sessionmaker` factory,connection string 從 Settings**
  - 驗收:integration test 在 testcontainers PG 上 `async with AsyncSessionLocal() as s: await s.execute(text("select 1"))` 取得 1

## C. 資料庫運維表

- [x] **C1. `ingest/models.py`:SQLAlchemy 2.0 `DeclarativeBase` + `IngestRaw`(id, dataset, fetched_at, request_args jsonb, payload jsonb)+ `IngestFailure`(id, dataset, occurred_at, request_args jsonb, error_class, error_message, traceback text, attempts int)**
  - 驗收:每欄位有 `Mapped[T]` 型別宣告;Pyright strict 對該檔無 error
- [x] **C2. Alembic 設定(`alembic.ini` + `migrations/env.py` async + `script_location`)+ 第一個 migration `add_ops_tables`**
  - 驗收:integration test 跑 `alembic upgrade head` 後 `pg_class` 含兩張表;再跑 `alembic downgrade base` 後兩表消失

## D. FinMind client(限速 + 重試)

- [x] **D1. `ingest/schemas/finmind_raw.py`:`TaiwanStockPriceRow`(欄位名保留 SDK 原文)Pydantic v2 model with `model_config = ConfigDict(extra='allow', frozen=True)`**
  - 驗收:unit test 驗證:對 README 範例 payload `model_validate` 成功;missing `stock_id` 時 raise `ValidationError`;傳入額外欄位 `foo='bar'` 後 `.__pydantic_extra__["foo"] == "bar"`
- [x] **D2. `ingest/clients/finmind.py`:`FinMindClient` 注入 `AsyncLimiter` + `tenacity` decorator + structlog;exposed `async fetch(dataset, **params)`**
  - 驗收:unit test 用 `respx`(已加 dev dep)mock FinMind base URL,驗證:(a) 在 `max_rate=8, time_period=60` 下,連續 16 calls 平均 throughput ≤ 9/min;(b) 429 response 觸發 `wait_exponential_jitter` 退避 + 最多 5 次嘗試;(c) 5 次後 raise `FinMindRateLimitError`
  - **SQL 檢查**:無 DB 操作;**PII 檢查**:純市場資料 endpoint,無個資

## E. Schema sentinel

- [x] **E1. `ingest/sentinel.py`:`SchemaSentinel.check(dataset, sample_args)`,抓一筆樣本後 assert keys == 預期常數**
  - 驗收:unit test 用 mock client 驗證:(a) keys == 預期 → return None;(b) keys != 預期 → raise `SchemaDriftError(added: set, removed: set)`;預期欄位常數宣告於模組頂部 `EXPECTED_FIELDS: dict[str, frozenset[str]]`

## F. DLQ writer

- [x] **F1. `ingest/storage.py`:`RawPayloadStore.record(dataset, request_args, payload)` 與 `FailureRecorder.record(dataset, request_args, exc, attempts)`**
  - 驗收:integration test(testcontainers PG)驗證:(a) 成功 ingest 寫入 1 筆 `ingest_raw`、0 筆 `ingest_failure`;(b) 失敗 ingest 寫入 0 筆 raw、1 筆 failure 且 `traceback` 欄位非空、`attempts` 欄位等於實際嘗試次數
  - **SQL 檢查**:全部用 `pg_insert(...).values(...)` parameterised,grep `f".*select|insert"` 無命中;**PII 檢查**:同 D2

## G. Scheduler

- [x] **G1. `ingest/scheduler.py`:`IngestScheduler` 包 `AsyncIOScheduler`,提供 `add_job(func, trigger, job_id)`、`start()`、`shutdown(wait=True)`,默認 `timezone='Asia/Taipei'`、`misfire_grace_time=600`、`coalesce=True`、`max_instances=1`**
  - 驗收:unit test 驗證:`add_job` 後 `get_jobs()` 含 job_id;options 預設值 introspect 正確;timezone 為 Asia/Taipei

## H. FastAPI app + CLI

- [x] **H1. `api/main.py`:`FastAPI(lifespan=...)`;lifespan 啟動 `IngestScheduler` + DB pool warmup;`/healthz` endpoint 回 `{status: "ok", schedules: N}`**
  - 驗收:`uv run uvicorn literati_stock.api.main:app` 啟動;`curl localhost:8000/healthz` 200 + JSON 含 `status` 與 `schedules`;unit test 用 `httpx.AsyncClient(transport=ASGITransport(app=app))` 驗證 lifespan startup/shutdown 各被呼叫一次
- [x] **H2. `ingest/cli.py`:`literati-ingest` CLI(typer 或純 argparse,我選 argparse 避免新依賴);子指令 `run-once <dataset> --start <date> --end <date>`**
  - 驗收:`uv run literati-ingest --help` 顯示子指令;integration test 用 mock FinMind 跑 `run-once TaiwanStockPrice --start 2025-01-02 --end 2025-01-02` 後 `ingest_raw` 表新增 1 筆

## I. 測試環境

- [x] **I1. `tests/conftest.py`:testcontainers `PostgresContainer` session-scoped fixture + 自動 alembic upgrade head + 每個 test function teardown rollback**
  - 驗收:`uv run pytest tests/integration -v` 啟一個 PG container、跑所有 integration test 全綠、teardown 後 `docker ps` 無殘留 container

## J. Docker

- [x] **J1. multi-stage `Dockerfile`(builder stage:`python:3.12-slim-bookworm` + 安裝 uv + `uv sync --frozen --no-dev --no-group test --no-group notebook --no-group research`;runtime stage:`python:3.12-slim-bookworm` + copy `.venv` + copy `src` + non-root user + `ENTRYPOINT ["uvicorn","literati_stock.api.main:app","--host","0.0.0.0","--port","8000"]`)**
  - 驗收:`docker build -t literati-stock:dev .` 成功;`docker image inspect literati-stock:dev --format '{{.Size}}'` < 300000000(300MB);`docker run --rm literati-stock:dev literati-ingest --help` 顯示 CLI help
- [x] **J2. `compose.yaml`(`app` 服務 + `postgres:16-alpine` 服務 with volume + healthcheck);`.dockerignore`(排除 `.venv`、`__pycache__`、`.pytest_cache`、`.git`、`tests`、`notebooks`、`docs` 等)**
  - 驗收:`docker compose up --build -d` 啟動兩 service;30 秒內 `docker compose exec app curl -fs http://localhost:8000/healthz` 回 200;`docker compose down -v` 乾淨清除 volume

## K. QA 與收尾

- [x] **K1. 跑專案約定測試指令 `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠**
  - 驗收:exit 0;coverage report 顯示總 ≥ 75%
- [x] **K2. `uv run pyright src tests` strict 無 error**
  - 驗收:exit 0;允許 `# pyright: reportUnknownMemberType=false` 僅出現於 `src/literati_stock/ingest/clients/finmind.py`(adapter layer 唯一豁免處)
- [x] **K3. `uv run ruff check src tests` 與 `uv run ruff format --check src tests` 全綠**
  - 驗收:exit 0
- [x] **K4. 寫 `qa-test-scope.md`(依 `testing-and-qa.md` 模板)**
  - 驗收:含「測試目標、覆蓋情境、未覆蓋風險、執行指令、結果」五段;放在 `openspec/changes/ingest-foundation/qa-test-scope.md`
- [x] **K5. `/opsx:archive ingest-foundation`,git push,`gh pr create`(target=main)**
  - 驗收:`openspec/changes/ingest-foundation/` 已搬到 `openspec/changes/archive/<timestamp>-ingest-foundation/`(或同等);PR 描述含「Make-vs-Buy 結論」「License 表」「SQL injection 已檢查:N/A or 已用 parameterised query」「PII 已檢查:無 PII(公開市場資料)」「Docker compose up 結果」;PR URL 取得
