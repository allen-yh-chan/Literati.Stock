---
name: security-coding
description: Web 資料存取 / SQL injection / PII / 憑證外洩防護規範；觸發：任何涉及網頁資料載入、URL/query 參數、資料庫操作、使用者資料傳遞、或設定檔 commit 的實作與 code review 時。
---

# 安全編碼規範

## Overview

本檔是網頁開發安全性的 SSOT，涵蓋：(1) URL / query string / AJAX/fetch 資料存取安全；(2) Query string 禁止 PII；(3) SQL 必須參數化；(4) 設定檔含敏感資料須使用者知情；(5) AI 貼出命令／輸出／擷取物前遮蔽憑證。AI 的責任是**確保使用者知情**，而不是替使用者做決定。PR 說明必須明確記錄「已檢查 SQL injection」與「已檢查 PII」。

## When to Use

- 任何涉及資料庫查詢的實作（新增/修改 SQL、ORM 呼叫）
- 任何 API endpoint 傳遞使用者資料時
- 任何網頁端 AJAX/fetch、typeahead、搜尋、filter、pagination、detail reload、或 route/query 參數帶資料識別時
- 應用程式 log／錯誤訊息含使用者資料時
- 存取稽核軌跡設計或實作時
- Commit 前偵測到 `appsettings*.json`、`.env*`、`secrets.*` 等設定檔時
- AI 貼出命令、輸出或擷取物到回覆、PR／issue／Discussion body、Debug Report 或 evidence log 時（見 §Agent 輸出憑證遮蔽）
- Code review 掃描 SQL injection / PII / IDOR / BOLA / authz 邊界風險時

## Process

### Query String 個資保護

- **禁止**在 query string 傳遞 PII（姓名、身分證、電話、email、生日、地址、帳號、密碼、API 金鑰、token、session ID）
- 傳遞使用者識別時，**只允許**使用不可逆的內部 ID（DB 自增 ID 或 UUID）
- 應用程式 log：DMZ 對外服務不得含 PII；任何環境不得含密碼、密鑰、token 等憑證
- 存取稽核軌跡：**必須**含 client context（Client IP／來源 Port／User-Agent 等），且獨立儲存、存取受控

Load-chain：存取稽核軌跡完整欄位契約與擷取規則見 `security-access-audit-trail.md`。

> **See also**：AI 寫入 repo artifact（commit message / PR body / docs / code comment）時，禁含 session 環境 context（user email / 本機絕對路徑）— 見 `ai-autonomy.md` §Never。

### 外部參數 URL 編碼

- 對外部第三方來源的非敏感參數（第三方識別碼、非敏感回呼帶入值等）放進 URL / query string / HTTP 請求路徑或參數前，**必須** URL encode。
- **不可假設**外部來源字串為 ASCII-safe / 不含特殊字元——特殊字元（如 `+ / = & % 空白` 等）未編碼會破壞 query 結構或被中途解析錯誤；「以往沒出問題」只是因為過去輸入剛好不含特殊字元，不是安全保證。
- C# 實作指引：query string 值用 `Uri.EscapeDataString(value)`（component-level，會編碼 `&`/`=`/`+` 等保留字元）；表單/整體可用 `System.Web.HttpUtility.UrlEncode`。注意 `Uri.EscapeUriString` 已過時、不要用。

URL 編碼**不豁免**上述 query string 的 PII／憑證禁令；以下範例只使用非敏感的 `providerCode` 與 `callbackRef`。

```csharp
// ❌ 禁止：直接字串拼接未編碼
var url = $"https://api.example.com/pay?source={providerCode}&ref={callbackRef}";

// ✅ 必須：用 Uri.EscapeDataString 編碼每個參數值
var url = $"https://api.example.com/pay"
        + $"?source={Uri.EscapeDataString(providerCode)}"
        + $"&ref={Uri.EscapeDataString(callbackRef)}";
```

### Web 資料存取安全

網頁端把 URL / route / query 參數交給 API 時，前端只能做 UX 與 selection；安全邊界必須在後端 per-request 驗證。`frontend-session.md` 僅管 session / Cookie / CORS mechanics；本段是 Web 資料安全 SSOT。

#### AJAX/fetch 後發先至

- 搜尋、filter、pagination、typeahead、detail reload、tenant / user / context switch 等會重複發 AJAX/fetch 的流程，**必須**處理後發先至：舊 request 的 response 不得覆蓋較新的 query / filter / page / tenant / context UI state。
- Debounce / throttle **應該**用於高頻輸入以減少 request 數量，但它不是完整防線；只要仍可能同時存在多個 in-flight request，就仍須做 latest-only guard。
- 可接受防線：`AbortController` 取消舊 request、遞增 request sequence id / latest token、或 response 回來時比對目前 query / filter / page / tenant / context，不一致即 discard。
- Loading / error state 也受同一規則約束；舊 request 後到的 error 不得把新 request 已成功的畫面改成錯誤狀態。

#### URL 參數不可作授權依據

- URL route / query string 中的 `id`、`userId`、`tenantId`、`customerId`、`orderId` 等只能當選擇條件，**不能**當授權依據。
- 後端 API 每次 request 都必須從 authenticated session / claims / token 取得目前使用者與 tenant，並在查詢或回傳前檢查 object-level authorization（owner / tenant / ACL / role scope）。
- 禁止只用 URL 參數直接查資料後回傳。使用者 A 手動改 URL 查使用者 B 的 object id 時，API 必須拒絕或回傳不含資料的結果；HTTP status / body 語意依 `api-design-http-semantics.md`。
- 前端 route guard、隱藏按鈕、disabled control、menu filtering 只算 UX guard，不是安全邊界，不能取代後端 object-level authorization。
- UUID / 難猜 id 不是授權；不可把「不好猜」當成 IDOR / BOLA 防護。

### SQL Injection 防護

**必須**使用 parameterized query 或 prepared statement：

```csharp
// ❌ 禁止
var sql = $"select * from Users where Name = '{name}'";

// ✅ 必須
var sql = "select * from Users where Name = @Name";
cmd.Parameters.AddWithValue("@Name", name);
```

ORM（如 Entity Framework）：**禁止**直接插入外部輸入至 `.FromSqlRaw()`；改用 `.FromSqlInterpolated()` 或明確參數化。

動態 ORDER BY 欄位**必須**白名單驗證：

```csharp
var allowedColumns = new HashSet<string> { "CreatedAt", "Amount", "Status" };
if (!allowedColumns.Contains(userInput)) throw new ArgumentException("Invalid sort column");
```

### 設定檔敏感資料提醒

偵測到 staging 中含 `Password`、`ConnectionString`、`ApiKey`、`Token`、`Secret`、`PrivateKey` 等關鍵字的設定檔，須主動告知並詢問是否加入 `.gitignore`。使用者確認刻意 commit 後不再阻擋。PR 說明需一行註記含敏感欄位的設定檔。這些 repo-specific sensitive patterns 不屬於 `gitignore-alignment.md` 的全域 baseline。

### Agent 輸出憑證遮蔽

`cooperative-only`（無 hook 掃描對外文字中的憑證；靠 agent 執行與 review 抽查）。適用於 AI 在回覆、PR／issue／Discussion body、Debug Report、evidence log 或 review packet 中貼出命令、輸出或擷取物（HAR、log dump、request trace）：

- 貼出前 MUST 將密碼、API 金鑰、token、session ID、cookie、私鑰等憑證值改寫為 `<REDACTED>`；對外文字一經送出就可能被快取或索引，事後刪改收不回。
- 重現迴圈與診斷命令 MUST 以環境變數傳遞憑證（命令中只出現 `$VAR` 名稱），不得把憑證值寫進命令字串。
- 擷取物只引用帶有診斷訊號的行；auth header、cookie 與帶憑證的 query string 不整段貼出。
- 遮蔽後不足以診斷時，MUST 停下說明缺的是哪一段並請使用者協助，MUST NOT 改貼原值。

## Exit Criteria

- 所有 DB 查詢已使用參數化（無字串拼接 SQL）
- Query string 無 PII 欄位
- Web AJAX/fetch 對後發先至有 debounce/throttle 加 latest-only guard（或等價防線）
- API 對 URL / route / query object id 做後端 object-level authorization，未只依賴前端 route guard
- 應用程式 log 無 PII / 憑證
- 貼出的命令／輸出／擷取物已遮蔽憑證
- 存取稽核軌跡已含必備 client context 欄位且獨立儲存、存取受控
- 設定檔 commit 前已完成知情確認
- PR 說明記錄「已檢查 SQL injection」與「已檢查 PII」
- 外部第三方參數進 URL / query string 前已 URL encode（未假設 ASCII-safe）

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「不會被濫用，只是內部工具」 | 內部工具同樣是攻擊目標，injection 風險與使用情境無關。 |
| 「就一行 SQL 拼接，不會有問題」 | 一行拼接就夠注入。參數化不麻煩，沒理由跳過。 |
| 「PII 只是 email，不算敏感」 | Email 是 GDPR/個資法明確保護的 PII，query string 傳遞會留在 log 與瀏覽器歷程。 |
| 「先交付，review 時再處理」 | 安全問題不是風格問題，不等 review——寫的當下就修。 |
| 「這個第三方參數以前都沒問題，不用 encode」 | 「以前沒問題」只代表過去輸入無特殊字元；金鑰/識別值含 `+ / = %` 等字元未編碼即破壞 URL。寫的當下就 encode。 |
| 「有 debounce 就不會後發先至」 | Debounce 只降低 request 頻率，不保證網路回應順序；仍要 abort / sequence id / context match。 |
| 「前端 route guard 已擋住了」 | 前端 guard 只是 UX；使用者可手改 URL 或直接打 API，後端必須做 object-level authorization。 |
| 「id 是 UUID 很難猜」 | 難猜不是授權；拿到或外洩任一 id 後仍會形成 IDOR / BOLA。 |

## Verification

```bash
# 掃描 SQL 拼接
grep -rn "FromSqlRaw\s*(\$\|\".*{" --include="*.cs" .
grep -rn "sql\s*=.*\$\"" --include="*.cs" .

# 掃描 query string PII
grep -rn "queryString\|QueryString\|query\[" --include="*.cs" . | grep -i "email\|name\|phone\|password"

# 掃描可能未編碼就拼接外部值進 URL 的風險
grep -rn "\$\".*https\?://.*{" --include="*.cs" .
grep -rn "queryString\s*+=\s*\|url\s*+=\s*\|path\s*+=\s*" --include="*.cs" . | grep -v "EscapeDataString\|UrlEncode"

# 掃描 AJAX/fetch 高頻資料載入是否有後發先至防線
grep -rn "fetch(\|\\.ajax\|XMLHttpRequest\|axios" --include="*.js" --include="*.ts" --include="*.tsx" .
grep -rn "AbortController\|debounce\|throttle\|requestId\|sequence\|latest" --include="*.js" --include="*.ts" --include="*.tsx" .

# 掃描 URL object id 查詢是否有後端授權檢查
grep -rn "userId\|tenantId\|customerId\|orderId\|FromRoute\|FromQuery" --include="*.cs" .
grep -rn "Authorize\|HasAccess\|CanAccess\|TenantId\|OwnerId\|ACL\|Policy" --include="*.cs" .
```
