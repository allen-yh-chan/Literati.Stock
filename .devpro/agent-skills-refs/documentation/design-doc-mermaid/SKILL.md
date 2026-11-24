---
name: design-doc-mermaid
description: >
  僅 routing metadata：Mermaid 與 design-document 圖表 workflow，產出 source-grounded、
  已驗證、可讀的圖表。使用時機：在 OpenSpec、README 或 design documentation 中建立、
  審查或更新 Mermaid 圖、architecture 圖、sequence 圖、deployment 圖，或 design-doc 視覺化內容時。
---

# Design Doc Mermaid

## Purpose

建立或審查 Mermaid/design-document 圖表作為 evidence artifact。讓圖表根基於討論中的 source，誠實驗證，除非使用者要求圖片輸出，否則避免產生額外的 generated asset churn。

## Workflow

1. 判斷圖表意圖與類型：sequence、activity、architecture、deployment、state，或 design-doc overview。若文字證據比圖表更清楚，說明理由並略過畫圖。
2. Source-grounded 輸入優先：引用圖表所依賴的 source 檔案、config、requirements、API contract 或明確聲明的假設。
3. 保持 loading type-scoped。只用與所選圖表類型相關的指引；不要為單一圖表載入或複製整棵 upstream reference tree。
4. 預設在目標 markdown 中撰寫 Mermaid。除非使用者明確要求 render 出的資產，否則不要產生 PNG/SVG 輸出。
5. Validate-before-finalize：若存在本機 Mermaid validator 或 renderer（例如 `mmdc` 或 repo script），先驗證再定稿。若無法驗證，將圖表證據標記為 `unvalidated`，不要宣稱 render 安全。
6. Readable contrast：自訂 `classDef` 或 `style` 顏色時，指定可讀的文字顏色，或保留 Mermaid 預設值。
7. 附證據交接：說明通過的驗證指令名稱，或標記為 `unvalidated` 的原因。

## Exclusions

- Do not copy `refs/design-doc-mermaid-main/SKILL.md`、upstream script、template、範例或 generated asset 到 repo 中。
- 除非使用者明確核准套件變更，否則不要新增套件依賴或 Mermaid tooling。
- 不要臆造 source 檔案、requirements、config 或聲明假設都不支持的 architecture 關係。
- No asset churn：讓 source markdown 保持為正常 deliverable。
