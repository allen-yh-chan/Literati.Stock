# Make-vs-Buy 評估 — ingest-foundation

## 目標

建立台股資料採集基礎層:排程器(scheduler)、FinMind 限速 client(rate limiter + retry)、schema drift 哨兵、DLQ 失敗紀錄表。本 change 預估 600–900 行,跨 4 個公認領域,須依 AGENTS.md §3e-1 強制評估。

範圍**排除**:股價/法人/融資等 domain table schema(留待議題 3 決議後另開 change)、訊號計算、API endpoint。本 change 只到「資料能可靠落地到 PostgreSQL `ingest_raw` + `ingest_failure` 兩張運維表」為止。

---

## 公認領域 #1:Scheduler / Job queue

### 候選 1:APScheduler 3.x

- **授權**:MIT(✓ 允許清單)
- **維護活躍度**:GitHub stars ~5.5k、PyPI 月下載 ~70M、3.x 系列持續 backport patches、4.0 beta 開發中
- **規模指標**:~7 個 transitive deps(tzlocal、pytz、six 等),wheel < 500KB
- **需求覆蓋**:**95%** — `AsyncIOScheduler` 原生 async、`CronTrigger`/`IntervalTrigger`、PostgreSQL jobstore(restart 後 job 不掉)、`misfire_grace_time`、`coalesce`、`max_instances` 全有。**缺**:web UI(MVP 不需要)
- **已知風險**:v4.0 beta 是 async-first 大重構,API 不向下相容;**鎖 `>=3.10,<4` 規避**。v3 仍接受 backport,目前無 CVE。

### 候選 2:Prefect 3.x

- **授權**:Apache-2.0(✓ 允許清單)
- **維護活躍度**:GitHub stars ~17k、Prefect Inc 商業支援、2024 v3 重寫
- **規模指標**:30+ transitive deps、需額外 Prefect server + worker 拓撲(本機 SQLite 也能跑,但 production 要 PostgreSQL + worker process)
- **需求覆蓋**:**100%+** — 完整 workflow orchestration、dashboard、retry/schedule 圖形化、flow run history
- **已知風險**:對 MVP 是 over-engineering;新增 ops surface(extra process、extra DB);僅用排程 = 高射砲打蚊子。未來若要 backtest pipeline orchestration 才有顯著價值

### 候選 3:手寫 asyncio loop + croniter

- **預估**:250–350 行(scheduler core + cron parsing 委由 croniter + jitter + persistence + misfire 處理 + shutdown clean)
- **覆蓋**:100%(量身訂做)
- **代價**:永久維護 cron edge case(DST、leap year、misfire 補跑邏輯)、crash 後 restart 重排邏輯自己扛、未來想加 dashboard 又要重做。croniter 本身仍要 import(BSD-2-Clause ✓)

### 建議

**APScheduler 3.x(`>=3.10,<4`)**。理由:

1. 規模適配 MVP(零 ops surface,跑在 FastAPI lifespan)
2. Prefect 是天然升級路徑 — APScheduler 的 job function 是 plain `async def`,日後升 Prefect 只需要改 scheduler bootstrap,job 本體不動
3. 手寫節省 deps 但要承擔 cron edge case + persistence 的長期成本,不划算

**Wrapper 邊界**:在 `literati_stock/ingest/scheduler.py` 暴露 `IngestScheduler` 類,封裝 `AsyncIOScheduler` 設定(timezone、jobstore、executor),job 函式透過 decorator 註冊。日後換 Prefect 只動此檔。

---

## 公認領域 #2:Rate limiter(client-side throttle)

### 候選 1:aiolimiter

- **授權**:MIT(✓)
- **維護活躍度**:last release 2023-09,issue tracker 安靜(功能單一、bug 少);GitHub stars ~480
- **規模指標**:<500 LOC,**零非 stdlib deps**
- **需求覆蓋**:**100%** — `AsyncLimiter(max_rate, time_period)` async context manager API,leaky-bucket 演算法,正合 FinMind「N req per period」配額模型
- **已知風險**:維護動能低 → 未來若 stdlib `asyncio` 變動可能需 fork。但 codebase 小,fork 成本可控

### 候選 2:asyncio-throttle

- **授權**:MIT(✓)
- **維護活躍度**:last release 2021,維護者響應慢
- **規模指標**:<200 LOC,零外部 deps
- **需求覆蓋**:**85%** — sliding window 算法(非 leaky bucket),burst 行為與 FinMind 配額對位較不直覺;API 較陽春
- **已知風險**:基本停止維護

### 候選 3:手寫 token bucket

- **預估**:60–100 行(`asyncio.Lock` + token counter + refill task + context manager)
- **覆蓋**:100%
- **代價**:取消、shutdown clean、jitter、accuracy under high concurrency 等邊界情境需自己測;不複雜但會分散測試重心

### 建議

**aiolimiter**。維護風險可控(codebase 小到能在 1 天內 fork 維護),功能對位 FinMind 配額最準確。手寫是次選 fallback,但會讓 ingest module 多 100 行非業務代碼。

**Wrapper 邊界**:`AsyncLimiter` 直接注入 `FinMindClient` 的 constructor,不另外抽象;若將來換實作,改動範圍 = 一個檔案的 import + constructor。

---

## 公認領域 #3:Retry / backoff

### 候選 1:tenacity

- **授權**:Apache-2.0(✓)
- **維護活躍度**:GitHub stars ~7k、2024 仍持續發布、jd.com 維護
- **規模指標**:~3k LOC,純 Python,**零外部 deps**
- **需求覆蓋**:**100%** — sync + async decorator、`wait_exponential_jitter`、`retry_if_exception_type`、`stop_after_attempt`/`stop_after_delay`、custom callbacks
- **已知風險**:API 偶有 deprecation 但都有 warning + 多版本 grace period

### 候選 2:backoff

- **授權**:MIT(✓)
- **維護活躍度**:last release 2022-08,接近停滯
- **規模指標**:~1k LOC
- **需求覆蓋**:**85%** — 缺 `stop_after_delay`、custom retry condition 較弱
- **已知風險**:維護動能低

### 候選 3:手寫 async retry decorator

- **預估**:50–80 行(async wrapper + exponential + jitter + max attempts + retry-on-exception)
- **覆蓋**:80% — 缺 retry-on-result、retry-on-condition 等進階模式;將來要支援會重寫
- **代價**:測試 surface 增加,且不 handle 的 edge case(例如 task 取消時 backoff sleep 還在跑)需逐一補

### 建議

**tenacity**。是 Python 重試領域 de-facto standard,license 友善、維護活躍、覆蓋完整。手寫的「省掉一個依賴」效益不抵自行維護成本。

---

## 公認領域 #4:Structured logging

### 候選 1:structlog

- **授權**:Apache-2.0 OR MIT(dual ✓)
- **維護活躍度**:GitHub stars ~3.7k、Hynek Schlawack 主導、2024 持續發布
- **規模指標**:~3k LOC,**零必要 deps**(可選 colorama 等)
- **需求覆蓋**:**100%** — `bind()` / `unbind()` context propagation、JSON renderer、async-safe、與 stdlib logging 可整合
- **已知風險**:processor chain 概念有學習曲線;但只設定一次,日常 API 直觀

### 候選 2:loguru

- **授權**:MIT(✓)
- **維護活躍度**:GitHub stars ~19k、活躍
- **規模指標**:~6k LOC
- **需求覆蓋**:**85%** — 介面像「強化版 logging」,結構化要靠 patcher 補,context binding 沒 structlog 直覺
- **已知風險**:全域單例設計(`from loguru import logger`)與 DI/test isolation 衝突,測試替換 logger 較痛

### 候選 3:純 stdlib `logging` + `python-json-logger`

- **預估**:40–60 行(JSON formatter + context filter + handler 設定)
- **覆蓋**:80% — 缺 `bind()` 等 context API;要用 `LogRecord` factory 或 `extra=` 自己補
- **代價**:寫法囉嗦、context propagation across async tasks 麻煩、ingest pipeline 多 worker 場景容易漏字段

### 建議

**structlog**。ingest pipeline 內 `bind(stock_id=..., dataset=..., trace_id=...)` 然後一路向下傳遞的場景,structlog 的 context binding API 是天然 fit。loguru 的全域單例對未來 testing 是負擔。

---

## 總建議(待你拍板)

| 領域 | 採用 | 替代 fallback | 預估覆蓋本 change 行數 |
|---|---|---|---|
| Scheduler | **APScheduler 3.x**(MIT) | 手寫(若你想壓 deps) | scheduler.py ~80 行 wrapper |
| Rate limiter | **aiolimiter**(MIT) | 手寫 token bucket | 直接用,~5 行整合 |
| Retry | **tenacity**(Apache-2.0) | (no fallback) | decorator ~5 行/處 |
| Logging | **structlog**(Apache-2.0/MIT) | 純 stdlib + json-logger | bootstrap ~30 行 |

**全部採 Buy 路線,本 change 預估 600–800 行(實作 + tests),工期 2-3 個工作天**。手寫合計可省 ~3-4 個 deps,但會增加 400+ 行 utility code 與長期維護責任 — 不划算。

---

## 範圍補充(使用者後加要求)

- **Runtime = Docker Desktop**:本 change 必須產出可用 `docker compose up` 啟動的 dev stack(app + PostgreSQL),production image 為 multi-stage Dockerfile(uv-based builder + slim runtime)。增加產物:`Dockerfile`、`compose.yaml`、`.dockerignore`、`.env.example`。預估 +80–120 行。

## License 驗證結果(§3e)

全部已對 PyPI / GitHub LICENSE 比對完成。

| 套件 | License | 結論 |
|---|---|---|
| apscheduler | MIT | ✓ |
| aiolimiter | MIT | ✓ |
| tenacity | Apache-2.0 | ✓ |
| structlog | MIT OR Apache-2.0 (dual) | ✓ |
| finmind | **Apache-2.0**(GitHub LICENSE 確認) | ✓ |
| asyncpg | Apache-2.0 | ✓ |
| pydantic / pydantic-settings | MIT | ✓ |
| sqlalchemy / alembic | MIT | ✓ |
| httpx | BSD-3-Clause | ✓ |
| hatchling | **MIT**(GitHub LICENSE 確認) | ✓ |
| ruff / pyright / pre-commit | MIT | ✓ |
| pytest / pytest-cov / pytest-mock | MIT | ✓ |
| pytest-asyncio / freezegun / testcontainers | Apache-2.0 | ✓ |
| structlog 之鄰:python-json-logger(若需要) | BSD-2-Clause | ✓ |
| **hypothesis** | **MPL-2.0**(weak copyleft,非允許清單) | **本 change 不採用**(test-only 且非必需,日後 property-test 需求出現再徵詢核准) |

全部直接相依套件均為 permissive license,符合 §3e。

## 已決議(2026-04-17)

1. ✅ 4 個 Buy 候選全部採用(APScheduler / aiolimiter / tenacity / structlog)
2. ✅ 範圍僅含運維表(`ingest_raw` + `ingest_failure`),domain table 延後另開 change
3. ✅ License 全綠;hypothesis 暫不引入
4. ✅ Runtime = Docker Desktop(Dockerfile + compose.yaml + .dockerignore)
