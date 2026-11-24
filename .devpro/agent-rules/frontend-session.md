---
name: frontend-session
description: 前端 Session 管理規範：PinAlive 保活、Idle Logout 閒置登出、跨站 Cookie/CORS 設定、Double-Injection Guard。觸發：實作任何需要 session 的前端頁面時。
---

# 前端 Session 管理規範

## Overview

所有使用 session 機制的前端網頁必須同時實作 PinAlive（保活）與 Idle Logout（閒置登出），兩者協同運作：PinAlive 定期 ping 避免後端 session 提前過期；Idle Logout 根據使用者互動事件判斷閒置，超時執行登出並清除 PinAlive interval。

任何以 Razor partial 形式注入的 session 機制**必須**具備 Server + Client 兩層 Double-Injection Guard，禁止擇一。

Web 資料存取安全（URL encode、query string PII、AJAX/fetch 後發先至、URL 參數授權繞過 / IDOR / BOLA）集中在 `security-coding.md`；本檔只管 session / Cookie / CORS mechanics。

Web 頁面主題（dark/light）與多語系的 cookie／query string 契約集中在 `frontend-theming-and-i18n.md`；本檔只管 session / Cookie / CORS mechanics。

## When to Use

- 實作任何需要登入的前端頁面（含 iframe 嵌入情境）
- 設定跨域 CORS + Cookie 時
- 導入 PinAlive 或 Idle Logout partial 時

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A |
| Advisory | N/A |
| Doctrine | `cooperative-only`: 「跨站 iframe 情境的 session cookie 層三要素（缺一不可）」等 MUST 類條款無機械 hard gate 可驗證是否被遵守；本次修改已在條文本身逐一表態明示適用範圍（session cookie，非 theme cookie），依賴 reviewer 人工核對 |

### PinAlive（Session 保活）

- 使用 `setInterval`，間隔 ≤ Session timeout 的一半，送出輕量 authenticated API（例 `GET /api/session/ping`，回 200 即可）
- 網頁關閉或使用者登出時，**必須**清除 interval
- **Iframe 例外**：iframe 內仍須持續執行 PinAlive，避免子應用 session 提前過期導致 401

### Idle Logout（閒置自動登出）

- 偵測使用者互動事件（`mousemove`、`keydown`、`click`、`scroll`、`touchstart`），有互動時重置計時器
- 閒置超過閾值（預設 10 分鐘，依安全政策調整；**禁止**寫死在程式碼）時，自動：
  1. 呼叫後端 logout API，清除 server-side session
  2. 清除本地 token / cookie
  3. 導向登入頁並顯示「因閒置過久已自動登出」
- 可選：登出前彈出倒數警告（例「您將在 60 秒後自動登出」）
- **Iframe 例外**：頁面被嵌入 parent 且 parent 已實作 idle logout 時，子應用**必須**停用本地 Idle Logout（以 `window.self !== window.top` 偵測），由 parent 統一負責。若無法確認 parent 行為，子應用**必須**維持本地 Idle Logout，禁止援引此例外規避。

### 跨站 Cookie 與 Web Session

當應用被嵌入不同網域 iframe 時，瀏覽器預設 `SameSite=Lax` 不送 session cookie，導致每次 request 被視為新 session。

**跨站 iframe 情境的 session cookie 層三要素（缺一不可）**：`SameSite=None` + `Secure` + **HTTPS**。連鎖依賴：`SameSite=None` → 必須 `Secure` → 必須 HTTPS。

**傳輸層（iframe 內 JS 對不同 origin 發 AJAX/fetch 時）**：

- `Access-Control-Allow-Credentials: true`（必須）
- `Access-Control-Allow-Origin` 必須指定明確 origin，**禁止**使用 `*`（與 `credentials: true` 互斥）
- 前端 fetch/AJAX 必須啟用憑證：`fetch(url, { credentials: 'include' })` 或 `xhr.withCredentials = true`

**ASP.NET Core 設定**：

```csharp
// CORS — 在 UseRouting 之後、UseAuthorization 之前
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowParentSite", policy =>
    {
        policy.WithOrigins("https://parent.example.com") // 禁止 AllowAnyOrigin
              .AllowCredentials()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});
app.UseCors("AllowParentSite");

// Cookie
builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.SameSite = SameSiteMode.None;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
});
// 或 Session middleware
builder.Services.AddSession(options =>
{
    options.Cookie.SameSite = SameSiteMode.None;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    options.Cookie.HttpOnly = true;
});
```

開發環境也必須使用 HTTPS（`dotnet dev-certs https --trust`）；`localhost` 豁免行為不可依賴。

### Double-Injection Guard（禁止擇一）

#### Server 端（per-request idempotency）

- 呼叫端 helper（`RenderPinAliveAsync`、`RenderIdleTimeoutLogoutAsync` 等）**必須**以 `HttpContext.Items` 紀錄「本 request 已 render」旗標，key 必須為穩定字串常數
- 第二次呼叫**必須**直接回 `HtmlString.Empty`，禁止重複輸出 `<script>`
- Flag 僅在成功 render 路徑設置；條件不成立的早退**禁止**設 flag
- 同步 wrapper 必須 delegate 到 async 版本，禁止各自複製 guard 邏輯

#### Client 端（global singleton guard）

- IIFE 入口**必須**在宣告任何 state / config / event listener **之前**檢查對應的 `window.Devpro*` 全域物件是否已存在；存在則立即 `return`
- 早退路徑禁止宣告 state、禁止註冊 event listener、禁止啟動 timer、禁止覆蓋既有全域物件
- `DebugMode = true` 時輸出 `[<機制名>] Already initialized, skipping duplicate init`；`DebugMode = false` 時禁止任何輸出
- singleton guard 必須優先執行，優先於其他情境（例 iframe 偵測）的早退

#### 兩層職責

Server guard 只能攔截「走 helper」的路徑；直接呼叫 partial、手動 `<script src>`、複製貼上 IIFE、多層 layout 等路徑會繞過 server guard。Client guard 不論進入路徑為何一定生效。兩層互補：server guard 省頻寬，client guard 任何路徑都不雙 init。

## Exit Criteria

- PinAlive interval 在登出時已清除
- Idle Logout 閾值透過設定檔或環境變數控制，未寫死在程式碼
- 跨站情境：session cookie 設定 `SameSite=None; Secure; HttpOnly`，CORS policy 有 `AllowCredentials()` 且 origin 為明確網域
- Double-Injection Guard 兩層均已實作（server `HttpContext.Items` flag + client `window.Devpro*` singleton check）

## Common Rationalizations

N/A — 純技術實作規範，無對應藉口反駁

## Verification

跨站 iframe session 檢查清單：

- [ ] 確認 session cookie 設定為 `SameSite=None; Secure; HttpOnly`
- [ ] 確認服務端與 iframe 頁面皆走 HTTPS
- [ ] 確認 CORS policy 有 `AllowCredentials()` 且 origin 為明確網域（非 `*`）
- [ ] 確認前端 fetch/AJAX 有設定 `credentials: 'include'`（或 `withCredentials = true`）
- [ ] DevTools → Network → OPTIONS preflight 回應含 `Access-Control-Allow-Credentials: true`
- [ ] DevTools → Application → Cookies 確認 cookie 被設定且被送出
- [ ] DevTools → Network → 確認 `Cookie` header 含 session ID
- [ ] 測試獨立分頁正常 + iframe 內也正常（兩情境都要過）

Double-Injection Guard 人工檢查：
- Server helper 連續呼叫兩次，第二次回 `HtmlString.Empty`（無重複 `<script>`）
- 瀏覽器 console 在 `DebugMode = true` 時輸出 `Already initialized, skipping duplicate init`
