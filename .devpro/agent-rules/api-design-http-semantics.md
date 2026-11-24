---
name: api-design-http-semantics
description: HTTP status code 設計原則：protocol-level vs application state 分層，防止 SLB/monitoring 誤判。觸發：實作或修改任何 HTTP endpoint 的 status code 邏輯時、設計 health check / keep-alive / heartbeat 端點時。
---

# API 設計：HTTP 語意分層

## Overview

**HTTP status code 反映「server 是否能處理此 request」，而非「application／domain state 是什麼」**。

| 抽象層 | 用什麼表達 | 範例 |
|---|---|---|
| Server 是否健康／endpoint 是否存在／request 是否合法 | HTTP status code（200／4xx／5xx） | 500 = server 炸了；404 = route 不存在；400 = request 格式錯 |
| Application／domain state（user 是否登入、token 是否有效、order 是否存在等） | Response body 欄位 | `{ authenticated: false }`、`{ tokenExpired: true }` |

## When to Use

- 實作或修改任何 HTTP endpoint 的 status code 邏輯時
- Code review 看到 endpoint 回 4xx / 5xx 時
- 設計 keep-alive、heartbeat、polling、health check 端點時

## Process

實作 endpoint 回 4xx／5xx 之前，**必須**自問三題：

1. **SLB / monitoring / log alerter 看到這個 status code 會不會做出錯誤決策？**（誤標 server 不健康、false alert、阻斷流量、觸發 auto-restart）
2. **這個 endpoint 是否可能被用作 health check？** keep-alive、heartbeat、polling、ping 類 endpoint **必須**永遠回 200，application state 透過 body 表達。
3. **這個 status code 對 caller 而言是不是 protocol-level 訊號？** 401／403 適用於使用者**主動存取受保護資源**時，不適用於 background polling 回報「使用者狀態變了」。

任一題答案「會誤判」或「該 endpoint 用於 health check」或「不是 protocol-level 訊號」→ **禁止**回該 status code，改用 200 + body 欄位。

### 反例（禁止）

- `POST /Home/PinAlive`（keep-alive）因「user 未登入」回 401 → SLB 誤判 server 不健康、流量被切走
- `GET /api/orders/{id}` 找不到資料回 404 → monitoring 無法區分「URL typo」vs「資料真的沒了」；若使用，**必須**在 PR 描述註明取捨；更乾淨設計是 200 + `{ found: false }`
- validation error 混用 422 vs 400 → 讓 monitoring 複雜化；**選一個**並全 repo 一致

### 允許用 4xx／5xx 的情境

- 真正的 protocol-level 錯誤：URL typo（404）、method not allowed（405）、server 真的炸了（500／503）
- 使用者主動存取受保護 resource（403）
- rate limit（429 是 protocol-level「請放慢」）

## Exit Criteria

- 每一個 4xx / 5xx 回應都有明確的「protocol-level 失敗」理由
- 受影響的 SLB / monitoring / log alerter 不會因為新加的 status code 做出錯誤決策
- PR 描述中已記錄「HTTP status 設計理由」（若有 4xx / 5xx）

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「401 比較直觀，client 一看就懂」 | 直觀的對象是寫 endpoint 的人，不是監控 endpoint 的 SLB。後者的決策不可逆（切流量、auto-restart）。 |
| 「SLB 會配對應的 health check endpoint」 | 部署環境會變、別人會接手。endpoint 語意應 self-contained，不應依賴外部設定補救。 |
| 「業界普遍用 401 表示未登入」 | 適用情境是 session-based protected resource access，background polling endpoint 不在此情境內。 |

## Verification

```
# PR 描述有無 HTTP status 設計理由
grep -i "http status\|4xx\|5xx\|status code" <pr-description>

# 人工檢查項
# - keep-alive / heartbeat / polling endpoint 是否永遠回 200？
# - body 是否帶有 application state 欄位（authenticated、found 等）？
# - PR 說明是否記錄 status code 設計取捨？
```
