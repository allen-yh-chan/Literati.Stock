---
name: security-access-audit-trail
description: 業務系統需保留客戶端裝置存取稽核軌跡（金管會等法遵調閱要求）以支援事後查得出「誰、何時、從哪個來源、用什麼裝置、做了什麼」時觸發。
---

# 存取稽核軌跡規範

## Overview

本檔規範**存取稽核軌跡**（access audit trail）：業務系統為滿足法遵調閱要求，須保留的客戶端存取紀錄——事後可查得出「某時間、某帳號、從哪個 Client IP 與來源 Port、用什麼裝置（User-Agent），做了什麼」。

**明文區辨**：本檔的「存取稽核軌跡」指**安全存取稽核**，與 corpus 既有的 process/review audit trail（例如 code review 的 sticky comment、`doc-split-and-dedup-sop.md` 的 `anchor-move:` 標記等**流程／審查稽核軌跡**）是**不同概念**。兩者字面相近但用途、內容、保存要求完全不同，讀到「audit trail」時 MUST 先判斷是哪一種，不得混用。

存取稽核軌跡與應用程式 log 是兩種不同載體：應用程式 log 服務可觀測性，`security-coding.md` 規定其**不得**含 PII；存取稽核軌跡服務法遵調閱，本檔規定其**必須**含 client context（屬 PII），須獨立儲存、存取受控。差異在儲存載體與存取控管，非「PII 能否出現」單一維度。

## When to Use

- 業務系統設計或實作任何需要事後可稽核「誰、何時、從哪個來源、用什麼裝置、做了什麼」的存取紀錄時
- 新增或修改記錄 Client IP / User-Agent / 來源 Port 等 client context 的擷取邏輯時
- 系統前方存在 CDN / WAF / SLB 等 TLS 終結點，需判斷客戶端來源埠應從何處取得時
- Code review 遇到 client context 相關欄位、稽核儲存設計、或稽核記錄寫入失敗處理邏輯時
- 撰寫或審查涉及本規範的 OpenSpec change（proposal / proposal-mini）之法遵宣告段落時

## Process

### 必備欄位契約表

存取稽核軌跡至少須擷取並保存以下欄位：

| 欄位 | 用途與要求 |
|---|---|
| 時間戳 | 事件發生時刻，須為 UTC 或明確標示時區；伺服器須 NTP 同步，避免多節點時間漂移致稽核序列錯亂 |
| Client IP | 客戶端來源 IP；須 IPv6 相容，欄位型別建議 `nvarchar(45)`；經 trusted proxy 解析後的 derived client IP |
| Peer IP | 與應用程式建立 TCP 連線的直接對端 IP（可能是 proxy／CDN／WAF，或客戶端本身）；與 Client IP 分開保存，避免信任邊界誤判時遺失原始連線資訊 |
| 來源 Port | 客戶端連線的來源埠；擷取規則見下節「擷取點與 XFF 信任邊界」 |
| User-Agent | 客戶端裝置／瀏覽器識別字串；須有明確截斷上限，**禁止**靜默截斷——截斷時須記錄「已截斷」旗標，不得讓截斷值被誤讀為完整原值 |
| 主體 | 執行動作的帳號／使用者識別（可用內部不可逆 ID，對齊 `security-coding.md` 的 query string 個資保護慣例） |
| 事件 | 被稽核的動作本身（如登入、資料異動、關鍵查詢），須可對應回業務語意，不得只記 HTTP method + path |

### 擷取點與 XFF 信任邊界

當 TLS 在 CDN / WAF / SLB 等邊緣節點終結時，應用程式看到的連線資訊已不是客戶端的原始連線：

- `Connection.RemotePort`（或等價 socket 層來源埠 API）拿到的是**邊緣節點與應用程式之間**那段連線的 ephemeral port，非客戶端來源埠。
- `X-Forwarded-Port` 依業界慣例傳遞**伺服器端埠**（server port），同樣非客戶端來源埠。
- 因此：**MUST NOT 以 RemotePort 或 X-Forwarded-Port 作為客戶端來源埠**。

合法取得客戶端來源埠的路徑僅有兩條，擇一或並用：

1. **邊緣側擷取**：由 CDN / WAF / SLB 在其終結 TLS 的節點自行擷取客戶端來源埠並記錄（該節點是唯一實際觀察到客戶端 TCP 連線的位置）。
2. 邊緣以 **RFC 7239** 的 **`Forwarded`** header 傳遞客戶端連線，例如 `Forwarded: for="<client-ip>:<source-port>"`——`for` 的 `host:port` 即客戶端 IP 與來源埠。應用程式解析此 header，不得退回用 `RemotePort` 或 `X-Forwarded-Port`。

`X-Forwarded-For` 慣例上帶客戶端 IP，但**客戶端可偽造**此 header。因此：

- **必須**設定 trusted proxy 清單（`KnownProxies` / `KnownNetworks` 或框架等價機制），只信任來自已知代理節點的 `X-Forwarded-For` / `Forwarded` 值。
- **必須**同時保留 derived client IP（Client IP 欄位）與 direct peer IP（Peer IP 欄位），缺一即無法於信任邊界誤判時追溯原始連線。

只驗證「來源 peer 在 trusted proxy 清單內」還不夠：客戶端可預先在請求裡塞入偽造的 `Forwarded` / `X-Forwarded-For` 值，若 trusted 邊緣節點只是把自己的 hop **附加**在既有 header 尾端而未驗證或剝除原始內容，應用程式後續仍可能選到攻擊者偽造的 `for=` 值，稽核紀錄的來源證據就此被污染。因此：

- 邊緣節點**必須在轉發前剝除或覆寫**任何非自己產生的 `Forwarded` / `X-Forwarded-For` hop，只留下自己實際觀察到的連線值；**不得**對客戶端可控的原始 header 內容做無驗證的原樣保留或附加。
- 多層代理鏈情境下，hop selection **必須採由右至左**（rightmost-hop-first）演算法：從 header 最右側開始逐一比對，落在 trusted proxy 清單內就繼續往左跳過，一旦遇到第一個不在清單內的 hop 即停止並以該 hop 為客戶端值；**必須**設定有限的 `ForwardLimit`（跳躍上限），避免無界迴圈或被超長鏈路撐爆。
- Header 格式解析失敗（非預期分隔符、超出長度上限、非法字元等）**必須 fail-closed**：拒絕該值、回退為邊緣節點直接觀察到的 Peer IP/Port，並標記明確的降級／不可信旗標，**不得**靜默接受格式異常內容當作合法客戶端值。

### 儲存與存取控管

- 存取稽核儲存 **MUST** 獨立於應用程式 log（不同資料表或資料庫），不得混放。
- 存取稽核儲存 **MUST** append-only：只能新增紀錄，不得事後修改或刪除已寫入的稽核記錄。
- 調閱存取稽核紀錄 **MUST** 具名授權，且調閱動作本身 **MUST** 留下軌跡。
- 對外顯示（如客服後台、報表）**MUST** 預設遮罩 client context 欄位，僅在具名授權情境下解遮罩。
- 儲存結構須支援「時間區間 + IP」查詢索引，以滿足典型稽核調閱需求。

### 宣告式法遵四項

每個實作存取稽核軌跡的 change **MUST** 在其 proposal / proposal-mini 明講以下四項：

1. **適用法源**
2. **事件範圍**（哪些動作需要被稽核）
3. **保存期限**
4. **稽核寫入失敗時的行為**（fail-closed／降級／其他，擇一並附理由）

Reviewer **只驗**這四項是否**皆有明講**，**不判斷宣告內容對錯**——法源、事件範圍、保存期限與失敗處理策略因客戶、業務、司法管轄而異，本規範不代替使用者或法遵單位做決定。四項均已明講即滿足本節要求；缺任一項即宣告不完整。

### 披露禁令

Client context 的**真實值**（真實 Client IP、真實 User-Agent 等）**MUST NOT** 出現在 repo artifact／PR body／commit message／external reviewer packet 之中。任何說明或範例只能使用 placeholder，例如 `<client-ip>`、`<user-agent>`：

```
稽核紀錄範例（僅示意欄位形狀，非真實資料）：
時間戳=2026-01-01T00:00:00Z, Client IP=<client-ip>, Peer IP=<peer-ip>,
來源 Port=<source-port>, User-Agent=<user-agent>, 主體=<account-id>, 事件=<event-name>
```

**誠實的限制聲明**：anchor test 只驗證「範例確實使用 placeholder 字面」，**無法**偵測文件或 PR 中是否**同時**混入真實 client context 值——這需要對「非保留值」做負向偵測，機械上做不到或成本過高，本規範不建置也不宣稱建置。真正防線是 reviewer 依對應 spec 的 negative scenario 人工核對，非依賴 anchor test。

## Exit Criteria

- 六段標準 anatomy（Overview / When to Use / Process / Exit Criteria / Common Rationalizations / Verification）齊備
- 必備欄位契約表七個欄位名稱（時間戳、Client IP、Peer IP、來源 Port、User-Agent、主體、事件）逐項可 grep 命中
- 擷取點與 XFF 信任邊界三個 anchor 片語（`MUST NOT 以 RemotePort 或 X-Forwarded-Port 作為客戶端來源埠`、`RFC 7239`、`Forwarded`、`邊緣側擷取`）逐項命中
- Header 改寫與 hop selection 三個 anchor 片語（`必須在轉發前剝除或覆寫`、`由右至左`、`ForwardLimit`、`必須 fail-closed`）逐項命中，防止「trusted proxy 清單」被誤讀為只驗 peer 來源即足夠
- 宣告式法遵四項（法源、事件範圍、保存期限、稽核寫入失敗時的行為）齊備，且措辭未暗示任何顆粒度下限
- 披露禁令段落齊備，且誠實聲明 anchor test 的限制（不得宣稱 anchor test 為披露防護的機械兜底）
- 本檔已明文對照存取稽核軌跡與 process/review audit trail 為不同概念

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「`RemotePort` 就是客戶端 port，直接用就好」 | TLS 終結在 CDN/WAF/SLB 時，`RemotePort` 是應用程式與邊緣節點間連線的 ephemeral port，非客戶端來源埠；混用即從一開始記錯欄位。 |
| 「有記 IP 就夠了，Port 不重要」 | NAT/CGNAT 環境下同一 IP 後方有多個客戶端，須靠 Port 區分；欄位契約表是最低必備集合，非可選清單，少記一項即不合規。 |
| 「`X-Forwarded-For` 拿到的 IP 一定準」 | 該 header 客戶端可偽造；未設 trusted proxy 清單就直接信任，等同讓攻擊者偽造稽核紀錄來源 IP。 |
| 「設了 trusted proxy 清單、來源 peer 在清單內就夠了」 | 只驗 peer 來源不夠：若邊緣節點只是把自己的 hop 附加在客戶端預先塞入的 header 尾端而未剝除／覆寫原始內容，攻擊者偽造的 `for=` 值仍會被保留下來；必須邊緣節點主動剝除／覆寫、且用由右至左 hop selection，才能排除客戶端可控的偽造前綴。 |
| 「稽核記錄放在應用程式 log 裡比較省事」 | 稽核儲存與應用程式 log 用途不同，混放會讓 DMZ 對外服務的 log 含 PII，違反 `security-coding.md` 規範。 |
| 「法源／保存期限先寫個大概，之後再補」 | 規範要求「有明講」而非「寫多細」；模糊帶過等於沒宣告，reviewer 會判定宣告不完整。 |
| 「範例用了 placeholder，這份文件就沒有洩漏風險了」 | Placeholder 測試只驗範例本身無真實值，**不能**證明文件或 PR 別處未夾帶真實值；披露防線是 reviewer 人工核對，非此 anchor test。 |

## Verification

```bash
# 欄位契約表七個欄位逐項命中
grep -c "時間戳" .devpro/agent-rules/security-access-audit-trail.md
grep -c "Client IP" .devpro/agent-rules/security-access-audit-trail.md
grep -c "Peer IP" .devpro/agent-rules/security-access-audit-trail.md
grep -c "來源 Port" .devpro/agent-rules/security-access-audit-trail.md
grep -c "User-Agent" .devpro/agent-rules/security-access-audit-trail.md
grep -c "主體" .devpro/agent-rules/security-access-audit-trail.md
grep -c "事件" .devpro/agent-rules/security-access-audit-trail.md

# 擷取點與 XFF 信任邊界關鍵片語
grep -F "MUST NOT 以 RemotePort 或 X-Forwarded-Port 作為客戶端來源埠" .devpro/agent-rules/security-access-audit-trail.md
grep -F "RFC 7239" .devpro/agent-rules/security-access-audit-trail.md
grep -F "Forwarded" .devpro/agent-rules/security-access-audit-trail.md
grep -F "邊緣側擷取" .devpro/agent-rules/security-access-audit-trail.md

# Header 改寫與 hop selection 關鍵片語
grep -F "必須在轉發前剝除或覆寫" .devpro/agent-rules/security-access-audit-trail.md
grep -F "由右至左" .devpro/agent-rules/security-access-audit-trail.md
grep -F "ForwardLimit" .devpro/agent-rules/security-access-audit-trail.md
grep -F "必須 fail-closed" .devpro/agent-rules/security-access-audit-trail.md

# 披露禁令 placeholder 範例
grep -F "<client-ip>" .devpro/agent-rules/security-access-audit-trail.md
grep -F "<user-agent>" .devpro/agent-rules/security-access-audit-trail.md

# 區辨術語存在
grep -F "存取稽核軌跡" .devpro/agent-rules/security-access-audit-trail.md
```
