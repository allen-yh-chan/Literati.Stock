# Make-vs-Buy — chip-data-chase-signal

## 觸發判定

估 ~800 LOC,超過 §3e-1 門檻。評估。

## 豁免主張

本 change 的每一個技術元件都已在先前 change 決議為「手寫(business logic / glue)」:

- ETL transform pattern(Python 端 group-by + pg_insert upsert)—— 與 `PriceTransformService` 完全相同 pattern
- APScheduler cron job 新增 —— 與既有 universe / signal / notification jobs 完全相同
- FinMind client 呼叫 —— 重用既有 `FinMindClient`
- Signal 策略類別 —— 重用既有 Protocol + dataclass 模式
- `SignalFeatures` 容器 —— 10 行 frozen dataclass,無 OSS 對應(這是 domain-specific 資料結構,非 generic rule engine)

不觸及公認領域(auth / HTTP client / rate limit / serialization / job queue / template engine 等)。

適用 §3e-1 **純業務邏輯 + glue code 豁免**。

## License check

無新增第三方套件。既有 deps 均核可。

## 未來觸發時機

- Shareholding(集保張數)或盤中 5 秒資料時:資料量與計算可能需要 TimescaleDB 或 aggregation orchestrator → 屆時再正式評估。
- 多訊號 backtest parameter sweep 時:可能引入 `vectorbt` 或 `backtesting.py`(議題 5 的正式評估)。
