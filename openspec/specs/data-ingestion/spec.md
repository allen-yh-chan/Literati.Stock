# data-ingestion Specification

## Purpose
TBD - created by archiving change ingest-foundation. Update Purpose after archive.
## Requirements
### Requirement: Rate-limited external API client

系統 SHALL 對 FinMind API 的所有請求透過具備 client-side rate limiting 的 `FinMindClient` 進行,其限速策略 SHALL 為 token-bucket(基於 `aiolimiter.AsyncLimiter`),預設 `max_rate = 8`、`time_period = 60` 秒(對應 600 req/hr 帶 token 配額並保留 buffer)。

#### Scenario: Throughput stays within configured rate

- **WHEN** 同一 client instance 在 60 秒內被連續呼叫 16 次
- **THEN** 平均 throughput 不超過 9 req/min(允許 ±1 jitter)且每次呼叫均成功完成

#### Scenario: 429 response triggers exponential backoff retry

- **WHEN** FinMind 回應 HTTP 429
- **THEN** client 套用 `wait_exponential_jitter(initial=2, max=60)` 退避並最多重試 5 次

#### Scenario: Permanent failure raises domain error

- **WHEN** 5 次重試仍失敗
- **THEN** client raise `FinMindRateLimitError`,呼叫端可捕捉並交由 `FailureRecorder` 處理

### Requirement: Pydantic-validated raw schema parsing

所有 FinMind 回傳的資料列 SHALL 在 adapter layer 經 Pydantic v2 model(`model_config = ConfigDict(extra='allow', frozen=True)`)強解後才向下游傳遞;欄位名 SHALL 保留 SDK 原文,新增欄位 SHALL 保留於 `__pydantic_extra__` 而非丟棄,缺少必填欄位 SHALL raise `ValidationError`。

#### Scenario: Sample payload validates successfully

- **WHEN** `TaiwanStockPriceRow.model_validate(payload)` 對 FinMind 文件範例 payload 呼叫
- **THEN** 回傳合法 instance,所有預期欄位填妥

#### Scenario: Missing required field raises

- **WHEN** payload 缺少 `stock_id`
- **THEN** raise `pydantic.ValidationError`

#### Scenario: Extra field is preserved

- **WHEN** payload 含未宣告欄位 `foo`
- **THEN** `instance.__pydantic_extra__["foo"]` 等於該值

### Requirement: Schema drift detection

系統 SHALL 提供 `SchemaSentinel.check(dataset, sample_args)`,對指定 dataset 抓取一筆樣本資料並比對其欄位集合是否等於模組級宣告之 `EXPECTED_FIELDS[dataset]`;不一致時 SHALL raise `SchemaDriftError(added: set, removed: set)`。

#### Scenario: Fields match expected

- **WHEN** sample row 欄位 == `EXPECTED_FIELDS[dataset]`
- **THEN** `check()` return `None`

#### Scenario: Drift detected

- **WHEN** sample row 欄位 != `EXPECTED_FIELDS[dataset]`
- **THEN** raise `SchemaDriftError`,且 `error.added` 與 `error.removed` 為 `set` 類型,內容為差異欄位

### Requirement: Persistent raw payload and failure recording

系統 SHALL 將每次成功 ingest 的原始 payload 寫入 `ingest_raw` 表(欄位:`id, dataset, fetched_at, request_args jsonb, payload jsonb`),並將失敗 ingest 寫入 `ingest_failure` 表(欄位:`id, dataset, occurred_at, request_args jsonb, error_class, error_message, traceback, attempts`)。所有寫入 SHALL 使用 SQLAlchemy 2.0 parameterised insert,禁止字串拼接 SQL。

#### Scenario: Successful ingest persists raw payload

- **WHEN** `RawPayloadStore.record(dataset, request_args, payload)` 對 testcontainers PostgreSQL 呼叫
- **THEN** `ingest_raw` 表新增 1 筆,`ingest_failure` 不變

#### Scenario: Failed ingest records error with traceback

- **WHEN** ingest job 因 `FinMindRateLimitError` 在 5 次重試後失敗,呼叫 `FailureRecorder.record(...)`
- **THEN** `ingest_failure` 新增 1 筆,`traceback` 欄位非空,`attempts` == 5

### Requirement: Async scheduled execution in Asia/Taipei timezone

系統 SHALL 提供 `IngestScheduler` 封裝 `AsyncIOScheduler`,預設 `timezone = "Asia/Taipei"`、`misfire_grace_time = 600`、`coalesce = True`、`max_instances = 1`;暴露 `add_job(func, trigger, job_id)`、`start()`、`shutdown(wait=True)`。

#### Scenario: Job registration is observable

- **WHEN** `scheduler.add_job(func, CronTrigger(hour=14, minute=30), job_id="x")` 後呼叫 `scheduler.get_jobs()`
- **THEN** 回傳清單包含 id == "x" 之 job

#### Scenario: Defaults match policy

- **WHEN** 檢查 `IngestScheduler` 預設設定
- **THEN** `timezone` == `Asia/Taipei`、`misfire_grace_time` == 600、`coalesce` == True、`max_instances` == 1

### Requirement: HTTP health endpoint and lifespan-managed resources

系統 SHALL 提供 FastAPI 應用,在 `lifespan` 中啟動 `IngestScheduler` 與 DB engine、shutdown 時優雅關閉兩者;暴露 `GET /healthz` 回傳 `{"status": "ok", "schedules": <int>}`。

#### Scenario: Healthz responds with scheduler count

- **WHEN** app 啟動且註冊 N 個 jobs,`GET /healthz`
- **THEN** 回傳 HTTP 200 與 JSON `{"status": "ok", "schedules": N}`

#### Scenario: Lifespan tears down cleanly

- **WHEN** app shutdown
- **THEN** `scheduler.shutdown(wait=True)` 與 DB engine `dispose()` 各被呼叫一次

### Requirement: Structured logging with JSON / console modes

系統 SHALL 使用 structlog 作為日誌入口,根據 `LOG_FORMAT` 環境變數於 `json`(production)與 `console`(dev)模式間切換;每筆日誌 SHALL 含 `timestamp`、`level`、`event` 三個基本欄位,context binding 透過 `bind()` 傳遞。

#### Scenario: JSON mode emits parseable JSON

- **WHEN** `LOG_FORMAT=json` 且呼叫 `get_logger("x").info("hello", k=1)`
- **THEN** stdout 輸出可被 `json.loads` parse 且結果含 `event=="hello"`、`k==1`、`level=="info"`、`timestamp` 為 ISO8601 string

#### Scenario: Console mode is human-readable

- **WHEN** `LOG_FORMAT=console`
- **THEN** 輸出為非 JSON 的 human-readable 格式(含 ANSI color 或同等 dev-friendly 排版)

### Requirement: Containerised runtime via Docker

系統 SHALL 提供 multi-stage `Dockerfile`(builder + slim runtime,基底 `python:3.12-slim-bookworm`)及 `compose.yaml`(app + `postgres:16-alpine`,含 healthcheck 與 named volume)。Production runtime image size SHALL < 300MB,且 SHALL 以 non-root user 執行。

#### Scenario: Image build succeeds and runs CLI

- **WHEN** `docker build -t literati-stock:dev .` 後 `docker run --rm literati-stock:dev literati-ingest --help`
- **THEN** build 成功(exit 0)且 CLI help 顯示

#### Scenario: Compose stack passes healthcheck

- **WHEN** `docker compose up --build -d`,等候 30 秒
- **THEN** `docker compose exec app curl -fs http://localhost:8000/healthz` 回 HTTP 200

#### Scenario: Image size constraint

- **WHEN** 檢查 production image
- **THEN** `docker image inspect literati-stock:dev --format '{{.Size}}'` 回 < 300_000_000(300MB)
