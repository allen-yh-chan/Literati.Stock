---
name: review-guarantee-ceiling
description: "Reviewer 保證上限：端到端設計準入、評估輸出與具名 consumer；防漏填誤用。"
---

# Reviewer 保證上限與評估

## Overview

本契約把保證上限落在 reviewer 輸出及 TL／workflow 的處置。威脅模型是防止漏填、填錯與漏處理；不加入防蓄意偽造的機制。

## When to Use

設計或審查 reviewer handoff 的保證上限、finding 分類、必填輸出或下游處置時載入。入口：`design-core.md` 與 `code-review-checklist.md`；normative SSOT：`openspec/specs/code-review-checklist/spec.md` 的 `Review Guarantee-Ceiling Design Admission` 與 `Review Guarantee Assessment Transport And Consumption`。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | shared assessment reader；primary capture／seal／convergence、runner、external accept 驗欄位／binding／unresolved |
| Advisory | 新 primary 必填的 TL CLI invocation／acceptance；above-ceiling 裁示與 prose finding 集合核對（cooperative；漏跑 CLI 無機械攔阻） |
| Doctrine | `cooperative-only`：TL／reviewer 判斷路徑覆蓋與 consumer 語意，沒有機械 oracle |

完整 dispatch inventory、逐路徑五項對照及 TL 退回設計動作在 canonical requirement；本 leaf 的 schema 說明是 canonical requirement 的執行／傳輸投影；normative schema owner 只有 spec，不能自立契約。

### Review Admission Checklist

- **Reviewer guarantee-ceiling design admission**：變更宣稱導入新 reviewer 保證上限／finding 分類義務時，MUST 逐條追出 affected dispatch 的 input transport、required output field/location/value、reviewed-target binding、具名 consumer/action、activation/compatibility 與正負驗證；缺任何一項 MUST 退回設計後才可實作該義務。
- **Existing-owner reuse**：MUST 先核對 `requirement_scope`、`design-core.md` 的 threat-model classification 與 seal disposition 的既有 owner，再說明新分類的必要差異；MUST NOT 把 pr-sticky/audit-only validator 宣稱為 primary coverage。
- **Review floor retained**：author-declared ceiling MUST NOT 豁免產品安全／合規、overclaim 或 spec↔code 矛盾的既有審查義務；missing／ambiguous assessment MUST NOT 默認為 within-ceiling 或 PASS。

### Verification Boundary

`review-guarantee-ceiling-contract.test.mjs` 實際呼叫 renderer 的 `reviewChecklistCriteriaLines()`，驗 owned criteria 被帶入及缺檔／缺邊界拒絕。`review-guarantee-assessment.test.mjs` 與 primary／external 的整合案例驗實際 reader 和 consumer 拒絕；不證明 inventory 窮盡或分類／裁示語意正確。路徑變動時由設計／review 更新 canonical inventory 及 producer-consumer 對照；仍由既有 runner／receipt／post-PR authorities 決定 runtime readiness。

### Review Output Contract

- **Assessment output（新 dispatch）**：每個 finding 都要評估，無 findings 用空陣列。JSON object 恰四鍵：`schema: "devpro.review-guarantee-assessment/v1"`、`reviewed_target`（實際 reviewed HEAD；無 SHA 的 audit 用 exact target）、`dispatch_id`（exact handoff ID；無 dispatch authority 用 `none`）、`assessments`。每項恰四鍵：`finding_id`、`guarantee_ceiling`（具名既有 owner、承諾機械檢查／cooperative 判斷及其限制）、`classification`（exact `within-ceiling`／`above-ceiling`／`unresolved`）、`rationale`；字串非空且無頭尾空白，IDs 不重複並覆蓋全部 structured finding IDs。分類與 severity／requirement_scope 正交，禁把超出上限直接當 out-of-requirement。
- **Output location**：primary full／bounded／TL-direct 的 exact raw v3 JSON 加頂層 `guarantee_assessment` object，禁改 observation 或附 Markdown。普通 prose／second-review 使用一個 exact `## Guarantee Assessment` heading，下一行一個 json fence、內放上述 object。新 context 的 PASS/WARN completion `reason` 與 pr-sticky body footer 前必填相同 section；renderer 的 unconditional output contract 直接傳遞，不依 admission trigger。CRITICAL 保留原blocking分類，MAY 附實際評估；UNAVAILABLE/fault 不要求、不製造評估。Paged 用本窗 findings 的 `summary_id`，其餘用 report 自己穩定的 ID。native／external 的 PASS/WARN sticky 順序同為單行 reason、optional tracked_follow_up、恰一個 assessment section、provenance footer；external evaluator 同樣放 sticky body；historical context 無旗標／receipt 無 metadata 保留舊契約。新 primary producer／consumer 同批更新才啟用。
- **Consumer action**：missing／格式或 binding 錯→重產；`unresolved`→先澄清，不接受 PASS/WARN／readiness；`within-ceiling`→既有 finding 處置；`above-ceiling`→TL 核對具名 owner 並記有理由的 disposition，才進 readiness。禁自動降 severity／close／豁免 review floor。上限判定及 TL 裁示是 cooperative，沒有機械語意 oracle。

## Exit Criteria

每條 affected path 都有可執行的 producer→output→consumer 對照、missing／unknown 的處置與相容性，review floor 不變，才可開始新 obligation 的實作；新 review 的評估由對應 consumer 接收、TL 完成需裁示項，才可進 readiness。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| packet validator 會擋，所以全路徑都覆蓋 | primary／ordinary／external 的 consumer 另有契約，須逐路徑核對 |
| 把 guarantee_ceiling 傳進 prompt 就完成了 | required output／reader／處置缺一即退回設計 |

## Verification

```bash
node --test .devpro/scripts/tests/review-guarantee-ceiling-contract.test.mjs .devpro/scripts/tests/review-guarantee-assessment.test.mjs
node .devpro/scripts/review-guarantee-assessment.mjs --receipt <actual-receipt>
# 普通 report：<report> --target <exact-target> --dispatch <exact-id-or-none> [--finding-id <id>]
```
