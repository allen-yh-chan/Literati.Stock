# Make-vs-Buy 評估 — signal-volume-surge

## 觸發判定

估 500–650 行,超過 §3e-1 行數門檻。須評估。

## 豁免主張

依 `third-party-packages-licensing.md`「Make-vs-Buy 評估」之**豁免條款**:

> 純業務邏輯(無對應 OSS 的領域)

本 change 之核心是:

1. **「量先價行」投資理論的具體規則**(爆量長紅):台股投資人特定的 heuristic,不是通用的「rule engine」問題。沒有現成 OSS 套件實作此規則。
2. **`stock_price` → `signal_event` 的 ETL wrapper**:SQL window function + 類別封裝,~50 行模板。
3. **Signal Protocol / Strategy pattern**:十多行 Python abstractions,標準 DI pattern,非 OSS 領域。

**不屬於**以下公認 OSS 領域:
- 技術分析指標庫(如 TA-Lib / pandas-ta):我們**不使用他們**,因為:
  - 「爆量長紅」不是 TA-Lib 裡的標準指標(這是我們的客製規則,組合了均量、量比、紅 K 實體 3 個概念)
  - TA-Lib C 依賴包裝麻煩;目前 SQL window function 就足夠
  - MVP 只需 MA(volume),後續若需要 RSI / MACD / Bollinger 等標準指標**才**評估引入 TA-Lib / pandas-ta
- 回測框架(vectorbt / backtesting.py / backtrader):本 change **不做回測**,只有 `backfill` 把歷史訊號寫 DB。真正的 walk-forward analysis、drawdown 統計、交易模擬等是下一個 change,屆時會寫獨立 Make-vs-Buy

## 結論

本 change 適用 §3e-1 豁免,**純業務邏輯 + 框架自建**,不需 OSS 候選評估。

未來議程(觸發正式 Make-vs-Buy 的時機):
- 加入 >5 個標準技術指標(RSI / MACD / Bollinger 等)→ 評估 TA-Lib / pandas-ta
- 開始做真實回測(收益率、drawdown、Sharpe ratio)→ 評估 vectorbt / backtesting.py / backtrader
