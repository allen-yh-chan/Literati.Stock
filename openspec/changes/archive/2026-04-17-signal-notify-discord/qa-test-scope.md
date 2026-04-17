# QA 測試範圍評估報告 — signal-notify-discord

## 基本資訊

- 需求/變更名稱:Discord webhook 通知(vertical slice 最後一哩)
- OpenSpec change:`signal-notify-discord`
- 分支:`feature/signal-notify-discord`
- Commit(QA 時):proposal 後,實作與 archive 即將 commit
- 提交人:Allen Chan
- 日期:2026-04-17

## 1) 變更範圍摘要

- **本次主要變更**
  - `NotificationChannel` Protocol(`publish_daily`)+ `SignalDispatch` Pydantic value type
  - `DiscordWebhookChannel`:httpx POST + tenacity retry(429 / 5xx)+ log 只出 host
  - `templates.build_embeds`:embed 構造(中文標籤、綠色色塊、severity 降序、前 10 檔、footer)
  - `NotificationService.publish_daily`:讀 `signal_event` 當日列 → 空 skip / 非空 dispatch
  - `notification_dispatch` scheduled cron(每日 17:50 Taipei,排在 signal_evaluation 17:45 後)
  - `literati-signal notify` CLI 子指令
  - `Settings.discord_webhook_url`(空字串 = no-op dev mode)+ lifespan 條件註冊
  - `core/logging.py` 把 `httpx` / `httpcore` 降到 WARNING(避免把 webhook URL 洩入 log)
- **涉及檔案/模組**:`src/literati_stock/notify/{__init__,base,service,templates,jobs}.py` + `channels/{__init__,discord}.py`;修改 `core/{settings,logging}.py`、`api/main.py`、`signal/cli.py`、`.env.example`、`compose.yaml`;新 tests
- **非範圍**:多訊號聚合一封訊息(目前邏輯 support,但訊號清單只有一個);通知重送 / dedup;其他 channel(LINE/Email);「無命中」報平安;個股中文名查表

## 2) 建議 QA 驗測重點

- **核心流程**
  - `Settings.discord_webhook_url=""` → lifespan 跳過 notification job;`/healthz` schedules == 2
  - 有 URL → lifespan 建 `DiscordWebhookChannel` + 註冊 `notification_dispatch`;`/healthz` schedules == 3
  - `NotificationService.publish_daily(as_of)` 讀 `signal_event` 當日列 → 空 skip channel;非空 丟 channel
  - embed 格式:title 含中文標籤 + 日期;color 綠;fields 降序 severity;最多 10 個
  - DiscordWebhookChannel 真實 POST 對 webhook URL 回 204
- **邊界情境**
  - 空 URL 建構 → ValueError(防呆)
  - 空 dispatches / 全空 events → no-op(無 HTTP 請求)
  - 429 → tenacity 退避重試 → 下一次成功即放行
  - 連續 429 → 耗盡重試 raise `DiscordNotificationError`
  - 4xx(非 429)→ 立刻 raise,不浪費重試
  - 5xx → 退避重試
  - 多 signal 但只部分有 events → 只該 signal 的 embed 出現
- **例外/錯誤情境**
  - webhook URL 形 http://... 但 host 不可達 → httpx 連線錯誤 → tenacity retry(因 5xx 分支 / connect error 設計;可擴充)
  - Discord message rate limit 誤判:Discord 官方限制 webhook 每 channel 30 messages / 60s,我們每日 1 次,遠低於此
  - Log hygiene:`DiscordWebhookChannel._webhook_host` property 只含 `discord.com`;log 字段 `webhook_host=discord.com` 不含 path/token
- **效能與並發**
  - 每日 17:50 只觸發一次,`max_instances=1`,無並發疑慮
  - HTTP timeout 10s;tenacity max_attempts=3;worst case ~30s block(acceptable)

## 3) 可能受影響模組 / 流程

- **直接受影響**:`api/main.py` lifespan 條件註冊新 job → `/healthz` schedules 因配置而不同;`signal/cli.py` 多一個子指令;`core/logging.py` 降低 httpx log level
- **間接受影響**:後續 LINE / Email channel 可複用同一 `NotificationChannel` Protocol
- **相依外部系統/服務**
  - **Discord webhook API**(新依賴)—— 穩定 API(自 2016 年版本極少變動)
  - 既有 PostgreSQL / Docker / FinMind 不變

## 4) 風險與未覆蓋項目

- **已知風險**
  - Webhook URL 是憑證;誰拿到都能往 channel 貼訊息。本 change 只在 `.env`(gitignored)和 container env 儲存,`.env.example` 留空,`core/logging.py` 降 httpx log level —— **但** 若使用者不慎把 `.env` commit,secret 會外洩。護欄:`.gitignore` 已含 `.env*`;pre-commit 的 `check-added-large-files` 並不能擋 secret,建議加 `detect-secrets` 是後續改進
  - Discord 若換 webhook URL 格式或 API → 需 rewrite(機率低)
  - 通知是「daily dispatch of today's events」,若 `signal_evaluation` job 沒跑完 17:50 之前,notification 會送 0 事件(不 spam,但可能 miss)—— 可在未來加 job 依賴鏈或重試機制
- **尚未覆蓋測試項目**
  - Discord 實際帳號 / channel 的 rate-limit 邊界
  - 生產環境 log 聚合器確認不含 webhook URL(人工抽測)
  - `check-added-large-files` 無法擋 secret commit(建議後續引入 `detect-secrets`)
- **未覆蓋原因**
  - Rate-limit 測試需與 Discord 真實互動,影響使用者 channel
- **建議後續補測**
  - 在 CI 加一個 grep check:`grep -rn "discord.com/api/webhooks/[0-9]" src tests` 必須為空
  - 加 `detect-secrets` pre-commit hook

## 5) 建議回歸測試清單

- [ ] `uv run pytest --cov=literati_stock --cov-fail-under=75` 全綠
- [ ] `uv run pyright src tests` strict 0 errors
- [ ] `uv run ruff check` + `ruff format --check` 全綠
- [ ] `uv run pre-commit run --all-files` 全綠
- [ ] `docker compose up -d --build` 起來後 `/healthz` 回 `schedules == 3`(有 URL)or `== 2`(無 URL)
- [ ] `docker compose exec app literati-signal notify --as-of YYYY-MM-DD` 對有當日 event 的日子 → HTTP 204 + Discord channel 收到 embed
- [ ] `grep -rn "discord.com/api/webhooks/[0-9]" src tests openspec` → 無命中(secret 不外洩)

## 6) 測試證據

- **執行指令與結果**
  - `uv run pytest` → **95 passed(+21 新)**
  - `uv run pyright src tests` → **0 errors, 21 warnings**(全部 APScheduler upstream stub)
  - `uv run ruff check` + `format --check` → All green
  - `docker compose up -d --build` → healthy,`/healthz` = `{"status":"ok","schedules":3}`
  - `literati-signal notify --as-of 2026-04-17` → 真實 Discord channel 收到 embed,HTTP 204 No Content
- **主要 log 關鍵字**
  - `notify.publish.sent as_of=... dispatches=1 events=1`
  - `discord.publish.start webhook_host=discord.com`(**無 path / token**)
  - `notify.publish.skipped_empty as_of=... signal_names=[...]`
- **SQL injection 檢查 ✓**:`_load_events` 用 SA 2.0 `select(...).where(...)`;Discord 僅 HTTP POST;**無 SQL 拼接**
- **PII 檢查 ✓**:Discord embed 欄位只有 stock_id 數字 + 價量(公開市場資料);**無個資**
- **Secret hygiene ✓**:webhook URL 只在 `Settings.discord_webhook_url` / `.env`(gitignored)/ container env 存在;`httpx` / `httpcore` log level 降至 WARNING;`DiscordWebhookChannel._webhook_host` 只回 host;專案 grep `grep -rn "discord.com/api/webhooks/[0-9]" src tests openspec` 無命中
- **新增依賴 ✓**:**無**;httpx / tenacity / pydantic / structlog / APScheduler 皆已核可
- **Make-vs-Buy**:手寫 channel(Option 3 of make-vs-buy.md);`discord.py` 100x 過頭、`discord-webhook` 等同 30 行自寫,詳見 make-vs-buy.md
