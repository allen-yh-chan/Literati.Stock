# Make-vs-Buy 評估 — signal-notify-discord

## 觸發判定

估 350–450 行,>200 門檻;Discord API 客戶端屬**公認領域**(成熟 OSS 充足),必須評估。

## 公認領域:Discord 客戶端 / Webhook 送訊

### 候選 1:`discord.py`

- **授權**:MIT ✓
- **維護活躍度**:GitHub stars ~15k,活躍維護,是 Discord bot 生態事實標準
- **規模指標**:~40MB 安裝、pulls aiohttp / pynacl / 多個 transitive deps
- **需求覆蓋**:**300%+** — 提供完整 bot framework(gateway、voice、slash commands、events、intents、reactions...),**100x 於我們需要的**
- **已知風險**:dependency footprint 大;bot 框架的配置心智負擔重;只用 webhook 是高射砲打蚊子

### 候選 2:`discord-webhook`

- **授權**:MIT ✓
- **維護活躍度**:~600 stars,偶發 commit;最後 release ~1 年前
- **規模指標**:~200 LOC,僅依賴 `requests`(sync)或 `httpx`(async 分支)
- **需求覆蓋**:**90%** — builder API for embeds,rate limit 處理;但 async 路徑較陽春,且封裝其實相當於自寫
- **已知風險**:小維護社群,未來 Discord API 變動可能 lag

### 候選 3:手寫(httpx POST)

- **預估**:**30–40 行**(async httpx client、embed JSON 構造、status 200/204 檢查、retry on 429 / 5xx 共用 tenacity)
- **覆蓋**:100%,量身訂做
- **代價**:Discord webhook API **非常簡單穩定**(自 2016 年變化極小);若 payload schema 改變,改動在同一檔案
- **優點**:零新增 deps、完全受控、embed 格式在此專案的 domain 內可直接命名對齊

## 建議

**手寫**(Option 3)。理由:

1. 需求是**單純 POST JSON**,不需要 bot / gateway / events — `discord.py` 是 100x 過頭
2. `discord-webhook` 的封裝等同於自寫 30 行,省不了多少
3. 專案已投入 `httpx` + `tenacity` 基建,加一個 thin channel 自然融入(complete 對稱於 ingest 的 `FinMindClient`)
4. 未來加 LINE / Email channel 時,抽象 `NotificationChannel` Protocol 用同一 pattern,不用為每個 provider 裝對應 OSS client

**採用條件**:Discord API(目前穩定 8 年)變動時 lag 風險接受;real-time metric 未來若需 slash command / interactive embeds 再重新評估引入 `discord.py`。

## License check

本 change 無新增 Python 套件。`httpx`、`tenacity`、`pydantic`、`structlog` 均為 ingest-foundation 已核可。
