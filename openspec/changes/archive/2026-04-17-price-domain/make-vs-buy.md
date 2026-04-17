# Make-vs-Buy 評估 — price-domain

## 觸發判定

變更預估 400–500 行,超過 §3e-1 行數門檻(>200)。須評估。

## 豁免主張

依 `third-party-packages-licensing.md`「Make-vs-Buy 評估」之**豁免條款**:

> 純業務邏輯(無對應 OSS 的領域,例:特定產品的計費規則、workflow 節點判定)

本 change 的核心是:

1. **FinMind payload → 台股 OHLCV domain table** 的 field mapping(`max`→`high`、`min`→`low`、`Trading_Volume`→`volume` 等)
2. **ingest_cursor 模式**的 idempotent replay 小封裝(讀 cursor → 讀新 raw → upsert domain → advance cursor,~30 行業務邏輯)

以上兩者皆為**台股 + FinMind 特定**的業務邏輯,無對應通用 OSS 套件:

- 「FinMind payload 解析」不是公認領域(non-TW-equity audience ≈ 0)
- 「table-specific ETL transform」是 Airflow / Dagster 的應用場景,但我們**已選 APScheduler 為排程器**(ingest-foundation Make-vs-Buy 決議),不為單一 transform job 引入全套 orchestrator
- 「cursor-based idempotent replay」是 30 行 SQL + Python 的業務代碼,非可替換的 OSS 單元

## 結論

本 change 適用 §3e-1 豁免,**直接手寫,不需 OSS 候選評估**。

如果未來 transform pipeline 擴張到 10+ datasets 或多層次 (raw → staging → mart → analytics),再評估引入 **dbt** / **SQLMesh** / **Dagster** 等 ELT orchestrator。屆時寫一份正式 Make-vs-Buy。
