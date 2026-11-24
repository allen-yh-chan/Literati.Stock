---
name: frontend-theming-and-i18n
description: "Web 頁面 theme（dark/light）與 locale（多語系/i18n）偏好儲存與解析契約。觸發：新建/重建 user-visible Web 頁面時。"
---

# 前端 Theme／Locale 偏好規範

## Overview

本檔定義 Web 頁面 theme（dark/light）與 locale（多語系/i18n）偏好的儲存與解析契約：theme 值域封閉集、cookie 屬性與 FOUC 防範；locale 四段優先序、BCP-47 白名單與 `Accept-Language` 全序解析管線；以及 pre-analyst 偵測到新建 user-visible Web 頁面時，對 theme／locale 兩個維度各自判定 repo 是否已有可繼承決策、缺哪一維只問哪一維的觸發與繼承判定機制。

session / Cookie / CORS mechanics 見 `frontend-session.md`；本檔只管 theme／locale 的偏好儲存與解析契約。

## When to Use

### 觸發條件（雙獨立維度，只問未命中維度）

> 當一項需求**明示要新建或重建**一個 user-visible Web 頁面／畫面／view／route（不是對既有頁面的局部修改）時，pre-analyst **MUST** 對 **theme** 與 **locale** **兩個維度各自**判定該 repo 是否已有可繼承的決策紀錄，並**只對未命中的維度提問**：兩維皆未命中 → 兩題都問；恰一維未命中 → 只問該維；兩維皆命中 → 不問，probe 通過。**MUST NOT** 以其中一維的已繼承證據視另一維為已繼承。

**Fail-closed 不變量（逐字條文，MUST 為 grep-able anchor）**：**任一維度未命中繼承判定、且該維未取得使用者答覆 → MUST 在 `## Clarification State` 記一行 `UNRESOLVED:` → MUST NOT 呼叫 `dp-analyst`。**

### per-dimension 繼承判定（唯一載體，兩維獨立）

| 維度 | 已繼承 ⟺ 命中形狀 |
|---|---|
| theme | `openspec/changes/**/meeting-notes.md`（含 `archive/`）中，`## Clarification State` 區段內 `decisions:` 欄的**某一個 item** 逐字符合 `web-theme: <needed｜not-needed> (provenance: user)` |
| locale | 同上，prefix 改為字面 `web-locale:` |

**判定程序（MUST 依序，四階段全數通過才算命中；任一階段失敗 → 該維視為未繼承 → 照常提問）**

1. **區段階段（section-aware）**：MUST 先以 `## Clarification State` 標題界定區段——自該標題行起、至**下一個 `^## ` 行或檔尾**為止。**MUST NOT** 對整份檔案做單行比對。區段界定 MUST 重用 `.devpro/scripts/lib/clarification-contract.mjs` 的 `extractSection(md, "Clarification State")` 或與之逐字等效的程序；**MUST NOT** 另寫一份平行的區段切法。
2. **欄位階段（field-aware）**：MUST 於該區段內以 `parseBulletFields` 取出 **`decisions` 欄**的值，只在該欄值內比對。同區段內 `frontier:`／`unresolved:`／任何其他欄位的值 **MUST NOT** 被當作繼承證據。
3. **分隔符完整性階段（separator-integrity-aware）**：MUST 呼叫 `clarification-contract.mjs` **匯出**的 `hasMixedListSeparators(decisionsValue)` 檢查該 `decisions` 欄值是否已同時含 `;` 與 `|` 兩種分隔符。回傳 `true` 時，該值已是「答覆寫入義務」段落定義的既有損壞狀態，**MUST** 視為本維度**無合格命中**（不得進入下一階段、不得逕行呼叫 `splitListItems`），細節、理由與獨立於寫入端的讀取端防線說明見下方「讀取端 fail-closed」段。
4. **項目階段（item-aware）**：MUST 呼叫 `clarification-contract.mjs` **匯出**的 `splitListItems(listText)` 把 `decisions` 值切成 item——其行為即既有切分優先序：**值內含 `;` 則以 `;` 切；否則含 `|` 則以 `|` 切；兩者皆無則整個值為單一 item**——再逐一 trim、去空項後，以 `^web-theme:\s*(needed|not-needed)\s*\(provenance: user\)$`（locale 同形）**整項錨定**比對。**MUST NOT** 用 substring 包含關係代替整項錨定；**MUST NOT** 在判定指令、guard test、CE 測試或任何其他載體自造 splitter（含 `[;|]` 之類同時切兩種分隔符的寫法、或直接 `.split(";")`）。

**Fail-closed 補充條款（區段非唯一時）**：`countH2Sections(md, "Clarification State")` **≠ 1**（0 個或 ≥2 個）時，該檔 **MUST** 視為**不提供**任何繼承證據——重複區段本身已是判錯狀態，此時「哪一個區段算數」無定義；繼承判定的預設方向是**未繼承**（→ 提問），未定義即 fail-closed 倒向提問側，**MUST NOT** 任選一個區段當證據。

**Fail-closed 補充條款（`decisions` 欄重複時）**：`parseBulletFields` 回傳的 `errors` 陣列中若含 `duplicate field: decisions`（即該 `## Clarification State` 區段內出現兩個以上物理 `- decisions:` bullet 行），該欄值本身即為未定義狀態——只保留首次出現的物理行，其餘物理行連同其可能夾帶的矛盾 item **MUST** 一併視為未定義證據被無聲丟棄，該檔 **MUST** 視為**不提供**任何繼承證據，同上方「區段非唯一時」條款的 fail-closed 方向，**MUST NOT** 僅採第一個 `decisions:` 物理行的值為準。

**Fail-closed 補充條款（同一維度衝突時）**：同一維度的 `decisions:` 欄內，若同時存在整項錨定比對合格的 `needed` item 與 `not-needed` item——不論是同一個 `## Clarification State` 區段 `decisions:` 欄內的兩個 item，或分別位於兩份不同 `meeting-notes.md`（含 `archive/`）各自一個合格 item——即構成**衝突**（衝突判定不比對時序），該維度 **MUST** 視為**未繼承**，**MUST NOT** 選用 `needed` 或 `not-needed` 任一者為準，**MUST NOT** 呼叫 `dp-analyst`，照常對該維度提問。

### 答覆寫入義務（收斂的唯一耐久載體）

每一個被問的維度，其答覆（**含「不需要」**）MUST 寫成該 change `meeting-notes.md` `## Clarification State` 區段內 **`- decisions:` 那一行的值裡、以該值既有分隔符分隔的一個 item**，逐字形如（值為空或本次為首次寫入時，預設使用 `;`）：

```markdown
- decisions: D1 …… (provenance: user); web-theme: needed (provenance: user); web-locale: not-needed (provenance: user)
```

若該行既有值已為 `|` 分隔（例：`- decisions: D1 …… (provenance: user) | D2 …… (provenance: user)`），MUST 沿用 `|` 而非改寫成 `;`，逐字形如：

```markdown
- decisions: D1 …… (provenance: user) | D2 …… (provenance: user) | web-theme: needed (provenance: user)
```

**分隔符一致性**：新增 item 使用的分隔符 **MUST** 與該 `decisions:` 值目前既有分隔符相同（依 `splitListItems` 既有切分優先序：值內已含 `;` → 該值視為 `;` 分隔；否則已含 `|` → 視為 `|` 分隔）；**MUST NOT** 在既有值已用某一分隔符時插入使用另一分隔符的新 item，該混用會使 `splitListItems` 把既有 items 與新 item 誤併為單一 item，導致既有維度的繼承證據悄悄失效。

**Fail-closed 補充條款（該值已同時含兩種分隔符時）**：附加新 item 前 **MUST** 先呼叫 `clarification-contract.mjs` 匯出的 `hasMixedListSeparators(listText)` 檢查該 `decisions:` 值。回傳 `true` 時，代表該值已違反上一段「MUST NOT 混用」——這是既有損壞狀態（可能源自本條款生效前寫入、或其他缺口），優先序（視為 `;` 分隔）只決定新 item 用哪個分隔符，**不會**修復已被誤併的既有 `|` 分隔 item。此時 **MUST NOT** 逕行依優先序附加；**MUST** 停下並記為 `UNRESOLVED: mixed-separator-corruption`，**MUST NOT** 呼叫 `dp-analyst`；需先由使用者或維護者以人工方式把該值正規化成單一分隔符後，pre-analyst 才可重新判讀並續行。

**MUST NOT** 寫成 `- decisions:` 底下的縮排子 bullet（會被 `parseBulletFields` 解析成頂層欄位並觸發 `unknown field` 判錯）。每個 item 結尾 `(provenance: user|repo-fact)` 的 Provenance MUST 由既有 `validateBulletList` 的 `PROVENANCE_SUFFIX` 原生強制。答「不需要」不產生任何實作 artifact；**未寫入即視同未答**（該維持續 fail-closed）。

### 判定指令（copy-executable）

**前置條件**：本指令依賴 `clarification-contract.mjs` 已匯出 `splitListItems`。在匯出前執行會得到 `SyntaxError: The requested module … does not provide an export named 'splitListItems'`——這是**刻意**的 fail-closed 形狀：寧可 import 硬失敗，也不要退回自建 splitter 讓判定悄悄漂移。

```bash
node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countH2Sections, extractSection, parseBulletFields, splitListItems, hasMixedListSeparators }
  from "./.devpro/scripts/lib/clarification-contract.mjs";
const prefix = process.argv[1];                    // web-theme | web-locale
const re = new RegExp(`^${prefix}:\\s*(needed|not-needed)\\s*\\(provenance: user\\)$`);
const files = [];
(function walk(d){ for (const e of readdirSync(d, { withFileTypes: true })) {
  const p = join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.name === "meeting-notes.md") files.push(p);
} })("openspec/changes");
const hits = files.flatMap((f) => {
  const md = readFileSync(f, "utf8");
  if (countH2Sections(md, "Clarification State") !== 1) return [];   // CE-4 / CE-5
  const { fields, errors } = parseBulletFields(extractSection(md, "Clarification State"));
  if (errors.includes("duplicate field: decisions")) return [];   // CF-3
  if (hasMixedListSeparators(fields.decisions || "")) return [];   // pre-existing mixed-separator corruption MUST NOT be trusted as inheritance evidence
  return splitListItems(fields.decisions || "")
    .map((s) => s.trim()).filter(Boolean)
    .map((i) => i.match(re))
    .filter(Boolean)
    .map((m) => ({ file: f, value: m[1] }));   // m[1] = the captured needed/not-needed value
});
const valueSet = [...new Set(hits.map((h) => h.value))];
console.log(hits.length, "values:", valueSet.join(","));
console.log(hits.map((h) => `${h.file}: ${h.value}`).join("\n"));
' web-theme
```

同一指令對 `web-locale` 重跑一次（把結尾參數換成 `web-locale`），兩次執行各自產出獨立命中結果。**若 `values:` 命中值集合同時含 `needed` 與 `not-needed`** → 該維度為上方「Fail-closed 補充條款（同一維度衝突時）」所定義的衝突，**MUST** 視為未繼承、照常提問，**MUST NOT** 從命中清單挑一筆當答案。

**讀取端 fail-closed**：`hasMixedListSeparators(fields.decisions || "")` 為 `true` 的文件 **MUST** 視為該文件對兩個維度皆無合格命中（`return []`），**MUST NOT** 逕行呼叫 `splitListItems` 解析。理由：`splitListItems` 只依優先序切**一種**分隔符，若已混用的值恰好其中一個 `;` 分隔片段本身仍能通過整項錨定比對，該片段會被誤判為合格命中並被當作已繼承證據採信——即使整個值已是上一段「MUST NOT 混用」定義的既有損壞狀態。此為與「附加新 item 前」（上方「Fail-closed 補充條款」，寫入端）互補、獨立生效的讀取端防線：兩端分別擋寫入時延續損壞、讀取時信任損壞。

**掃描路徑為封閉集**：只掃 `openspec/changes/**/meeting-notes.md`（於 `openspec/changes/` 遞迴即同時涵蓋 active 與 `archive/` 兩層，archive 路徑為 `openspec/changes/archive/<change>/`）。**MUST NOT** 把下列任一項當作繼承證據：`.devpro/agent-rules/**` 任何規範文本（**含本 leaf 自身**）、`node_modules/**`／vendored／dependency 程式碼、說明文件或 README 中的 `prefers-color-scheme`／`Accept-Language`／語系白名單字面、以及任何 repo-wide 自由字面搜尋結果。

### CE-1 ~ CE-7 反例（MUST NOT 命中）

| # | 形態 | 判定 | 被哪一階段擋下 |
|---|---|---|---|
| CE-2 | 同形 item 位於**區段內但非 `decisions:` 欄**（例：寫進 `frontier:`） | **MUST NOT** 命中 | 階段 2（欄位） |
| CE-3 | `unresolved:` 欄含 `UNRESOLVED: web-theme: needed (provenance: user)` | **MUST NOT** 命中 | 階段 2（欄位）**與**階段 4（`^web-theme:` 整項錨定拒絕 `UNRESOLVED: ` 前綴）**兩道獨立屏障**；guard MUST 各自斷言 |
| CE-1 | 同形 bullet 位於 **`## Clarification State` 區段外**（例：`## 完整計畫` 段、引用、範例） | **MUST NOT** 命中 | 階段 1（區段） |
| CE-4 | 同一檔出現**兩個** `## Clarification State` 區段 | **MUST NOT** 命中 | 上述 fail-closed 補充條款 |
| CE-5 | 檔內**無** `## Clarification State` 區段 | **MUST NOT** 命中 | 階段 1（區段） |
| CE-6 | item 缺 `(provenance: user)` 結尾 | **MUST NOT** 命中 | 階段 4（整項錨定） |
| CE-7 | 值不在 `{needed, not-needed}` 內（例 `maybe`） | **MUST NOT** 命中 | 階段 4（整項錨定） |

### 衝突反例（needed／not-needed 矛盾，MUST NOT 視為已繼承）

獨立分節承載（`decisions.md` D23）——**MUST NOT** 併入或改名上方 `### CE-1 ~ CE-7 反例（MUST NOT 命中）`。

| # | 形態 | 判定 | 依據 |
|---|---|---|---|
| CF-1 | 同一 `## Clarification State` 區段的 `decisions:` 欄內，同時含通過整項錨定比對的 `web-theme: needed (provenance: user)` 與 `web-theme: not-needed (provenance: user)`（locale 同形） | **MUST NOT** 視為已繼承 | 上方「Fail-closed 補充條款（同一維度衝突時）」；`needed`／`not-needed` 兩值皆不得選用 |
| CF-2 | 兩份不同 `meeting-notes.md`（含 `archive/`）各自含一個合格 item，值分別為 `needed` 與 `not-needed` | **MUST NOT** 視為已繼承 | 同上；判定指令遞迴掃描整個 `openspec/changes` 樹並取聯集，衝突判定不比對檔案界限或時序 |
| CF-3 | 同一 `## Clarification State` 區段內出現**兩個以上**物理 `- decisions:` bullet 行（`parseBulletFields` 回傳 `errors` 含 `duplicate field: decisions`） | **MUST NOT** 視為已繼承 | 上方「Fail-closed 補充條款（`decisions` 欄重複時）」；只保留首次出現物理行的舊行為（未檢查 `errors`）**MUST NOT** 沿用 |

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A |
| Advisory | `.devpro/scripts/tests/web-theme-locale-probe-grep.test.mjs`（防條文字面被靜默刪除／弱化，不驗「是否遵守」）——與 `ambiguity-scoring.md` §Enforcement Metadata 同一 carrier、同一分類 |
| Doctrine | `cooperative-only`: 本 leaf 全數條款（theme cookie 屬性、locale 優先序解析管線、CE 反例判定等）無機械 hard gate 可驗證是否被遵守；probe 是否真被執行不落 repo diff |

### Theme（dark/light）

- 使用者答「需要主題切換」時，偏好 **MUST** 記於 cookie；cookie 屬性 **MUST** 為 `Secure` + `SameSite=Lax`，**MUST NOT** `HttpOnly`（前端 JS 需讀取以切換樣式）。
- 首次造訪（無 cookie）**MUST** 以 `prefers-color-scheme` 作為初始預設。
- **MUST** 防 FOUC（Flash of Unstyled Content）：SSR 讀 cookie 決定初始 class，或於 `<head>` 內以 inline script 在首次繪製前套用主題。
- **跨站 iframe 嵌入揭露**：`SameSite=Lax` 只決定 cookie 是否**自動隨 request 送出**（第三方 iframe request **MUST** 視為不送出）；**MUST NOT** 以此推論 JS `document.cookie` 是否**可讀**——third-party storage partitioning／cookie 封鎖政策（依瀏覽器，非 `SameSite` 屬性）才決定可讀性，兩者 **MUST** 分開判斷。**MUST** 依實際讀取結果回退：讀取失敗（空值／擲錯）**MUST** 與下方封閉集規則 2 的無效值走同一回退路徑（視同未設定，回退 `prefers-color-scheme`；優雅降級，非錯誤狀態）；**MUST NOT** 為了讓 iframe 情境下的偏好持久化而改用 `SameSite=None`（`session / Cookie / CORS` 的 `SameSite=None` 例外只適用 `frontend-session.md` 治理的 session／auth cookie，本檔 theme cookie 不繼承該例外）。

**值域與無效值處理（逐字條文）**：

1. theme 偏好 cookie 的值 **MUST** ∈ 封閉集 `{light, dark}`，**逐字、大小寫敏感**比對（`Light`／`DARK`／含前後空白者皆為無效值）。此字面 `{light, dark}` 為封閉集 grep anchor，**MUST NOT** 改寫成同義措辭。
2. 值不在封閉集內（含空字串、被竄改、舊版遺留值）→ **MUST** 視同 cookie 未設定，回退到初次造訪預設邏輯（`prefers-color-scheme`）；**MUST NOT** 以該無效值回寫 cookie。
3. **MUST NOT** 把 cookie 原值直接插入 DOM、class name、`style` 屬性、CSS 選擇器或任何字串樣板；**MUST** 先做封閉集比對，命中後改以**程式內常數**（而非 cookie 讀回值）驅動樣式切換。

### Locale（多語系/i18n）

優先序：query string → cookie → `Accept-Language` → fallback。每一段 **MUST** 以 BCP-47 封閉白名單驗證。

1. 解析 **MUST** 依序評估四段來源；某段**有值但未通過白名單驗證** → **MUST** 續查下一優先序來源；**MUST NOT** 因「該來源有值」即停止解析（有值 ≠ 有效值）。
1a. **四段來源（query string、cookie、`Accept-Language`、fallback）對白名單的比對 MUST 一律 case-insensitive**——`zh-TW`／`ZH-tw`／`Zh-Tw` 等大小寫變體 **MUST** 視為同一 tag；比對前 **MUST** 先正規化（統一轉小寫）再與白名單逐字比對，白名單值本身亦須以同一正規化形式登記或比對。此規則不限於 `Accept-Language` 管線階段 4（該階段的 tag 正規化是本條在該來源的一個實例，非唯一適用範圍）；query string／cookie 兩段讀到的原始 tag 值 **MUST** 套用同一正規化再驗證，**MUST NOT** 因大小寫不同而誤判為未命中白名單並錯誤跳至下一優先序來源。
2. **前三段**（query string、cookie、`Accept-Language`）皆未產出白名單命中值時才使用 fallback 語系；fallback 值本身 **MUST** 在白名單內（fallback 是鏈的終點，不是「四段皆未命中」條件式的一員——它不能以自身結果作為使用自身的前提）。
3. 全程 **MUST NOT** 把未通過驗證的值回寫 cookie 或 `<html lang>`。
4. 翻譯字串以 resource file 為 SSOT；生效語系 **MUST** 對齊到 `<html lang>`。

#### `Accept-Language` 全序解析管線（12 條，MUST 依此序執行，前一階段輸出即後一階段輸入，階段間不得回頭）

1. **切分與去空白（OWS）**：以 `,` 切為 entry；每個 entry 以 `;` 切為 tag 與參數；**每個切出的片段 MUST 先去除前後空白，再進入後續階段**。`en-US; q=0.9`、`en-US ;q=0.9` 與 `en-US;q=0.9` **MUST** 等價。**MUST NOT** 因未去空白而把合法 entry 判為畸形。
2. **形狀驗證**（在階段 1 去空白**之後**進行）：tag MUST 為 `*`，或符合 `^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$`；若帶 q 參數，MUST 符合 `^[qQ]=(0(\.\d{0,3})?|1(\.0{0,3})?)$`（對齊 RFC 9110 §12.4.2 `qvalue` ABNF `( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )`——`0*3` 允許 **零次**重複，故小數點後零位數字合法）——參數名 `q` **MUST** case-insensitive（`q`／`Q` 等價，對齊同條 `weight` ABNF 的 `( "q" / "Q" )`），僅 case 不同 **MUST NOT** 視為畸形而丟棄整筆 entry；此 case-insensitive 範圍限於參數名本身，**MUST NOT** 擴及 tag（tag 的 case-insensitive 正規化見階段 4）。**任一項不符 → MUST 忽略該 entry（整筆丟棄）；MUST NOT 因此拒絕或中止整個 header**，其餘 entry 照常解析。`q=1.`／`q=0.`（尾點、小數點後零位數字）**符合**上式，**MUST** 分別視為 `q=1`／`q=0` 生效，**MUST NOT** 與畸形輸入同一路徑丟棄；`q=.5`（缺前導 `0`）**不符**上式，**MUST** 與 `q=abc` 走同一條路徑丟棄該 entry。**參數 cardinality**：每個 entry 依 `;` 切分並經階段 1 去空白後，**MUST 恰有 1 段或 2 段**——第 1 段為 tag，若有第 2 段則該段 **MUST** 為符合上式的 q 參數。**切出 ≥3 段（例 `en;q=0.8;q=0`，同一 entry 出現兩個 `q=` 參數片段）、或第 2 段不是合法 q 參數（例 `en;charset=utf8` 的未知參數、`en;` 的空參數）→ MUST 視為整筆 entry 格式錯誤並整筆丟棄**；**MUST NOT** 取其中任何一個 q 生效（不論最先、最後或最大者），**MUST NOT** 因此中止整個 header，其餘 entry 照常解析。本檢查與逐片段形狀驗證彼此獨立——「每個片段各自合法」**MUST NOT** 使該 entry 通過本檢查。與條 8 相容：`*` 是單段 entry（1 段）落在允許區間；`*;q=0.8` 是 2 段且第 2 段合法。
3. **超範圍 q**：`q` 值域為 `[0,1]`；`q=1.5`／`q=-0.1`／`q=abc` 皆落在階段 2 的形狀驗證外 → **MUST 忽略該 entry，MUST NOT clamp**。
4. **正規化**：tag **MUST** case-insensitive 比對，統一轉小寫後才進入去重、否決集與白名單比對；白名單值同樣正規化。**完全未帶 q 參數**（依階段 2 的定義：既無 `q=` 亦無 `Q=`，非僅字面未帶小寫 `q=`）的 tag **MUST** 視為權重 `1`。
5. **去重**：同一正規化 tag 出現多次 → **MUST 取 header 內最後出現的那一筆（last-wins）**，其餘丟棄。
6. **建立否決集 V**：**去重後**（即階段 5 之後）**正規化後的權重值**恰為 `0` 的**具名** tag 構成 V（該值由階段 2 對 `q=`／`Q=` 一視同仁解析而得，非依字面小寫 `q=` 比對）；`*` 不入 V（見條 8）。
7. **排序**：V 以外、q > 0 的具名 tag 依 q 由高到低；q 相同時依去重後的 header 出現序（穩定排序）。
8. **`*` wildcard**：`*` **MUST** 視為「無偏好」——不命中任何白名單項；其 q-value **一律忽略（含 `q=0`）**，**MUST NOT** 用 `*` 排除任何白名單項。
9. **比對（`q=0` 與 Lookup 的衝突裁決在此）**：依序取排序後的每個 tag，先 exact 比對白名單；未命中則依 RFC 4647 §3.4 Lookup **逐段截去最後一個 subtag** 後重試（`zh-Hant-TW` → `zh-Hant` → `zh`）。**每一層（含 exact 層）命中白名單值 `w` 後，MUST 先套否決檢查**：`w` ∈ V → 該層視為未命中，**MUST NOT 選用**。此為**最終否決**：**MUST NOT** 被同一 header 內任何其他 tag 的截短路徑繞過，亦 **MUST NOT** 因該截短來源 tag 自身 q 較高而繞過。被否決後 **MUST 繼續截短鏈的下一層**；截短鏈耗盡則該 tag 未命中，MUST 改評估下一個 tag。否決**只作用於 `w` 這個逐字白名單值本身**，**MUST NOT** 向下傳播到以 `w` 為前綴的其他白名單值（`en;q=0` 不排除白名單值 `en-GB`）。
10. **放大方向 MUST NOT 推論**：header 給裸 primary subtag 而白名單只有更細變體時（header `zh`、白名單 `{en, zh-Hant, zh-Hans}`）**MUST** 視為未命中，續查下一優先序來源；**MUST NOT** 自行挑選任一變體。
11. **全數未命中**：所有 entry 皆被丟棄、header 缺席、或排序後無任何 tag 產出未被否決的白名單命中值 → 本來源**未命中**，MUST 依上方優先序續查下一來源（最終落到 fallback）；**MUST NOT** 就地選用被否決值或任意白名單值代替。
12. **對應的白名單撰寫義務**：若某語言要能被裸 tag 服務，白名單 **MUST** 自行納入該裸 tag（要服務 `zh` 就把 `zh` 列進白名單並指定其對應 resource）。此為**撰寫期義務**，非解析期啟發式。

#### Worked examples（每列各鎖一條規則；#9／#10 為同一條階段 2 參數 cardinality 規則的兩個實例）

| # | `Accept-Language` | 白名單 | 結果 | 依據 |
|---|---|---|---|---|
| 1 | `en-US;q=1, en;q=0` | `{en}` | **未命中** → 續查下一來源 → fallback | V={`en`}；`en-US` exact 未命中、截短得 `en` 但 `en` ∈ V 被最終否決、截短鏈耗盡；`en` 自身 q=0 不入排序 |
| 1b | `en-US;q=1, en; q=0`（參數前帶 OWS） | `{en}` | **未命中** → 續查下一來源 → fallback | 與第 1 列**必須同解**。階段 1 去空白後 `q=0` 形狀合格、`en` 正常進入 V；若省略去空白，該 entry 會在階段 2 被丟棄、V 落空而錯選 `en` |
| 1c | `en-US;q=1, en;Q=0`（大寫參數名） | `{en}` | **未命中** → 續查下一來源 → fallback | 與第 1 列**必須同解**：參數名 `q`／`Q` 等價（見階段 2），**MUST NOT** 因大寫 `Q=0` 而誤判為未帶 q 參數並預設權重 `1`，否則否決集 V 落空、`en-US` 截短會誤選中 `en` |
| 2 | `en-US;q=1, en;q=0, en-GB;q=0.5` | `{en, en-GB}` | `en-GB` | 否決不傳播到前綴族：`en-US` 這一路被否決，但 `en-GB;q=0.5` exact 命中且 `en-GB` ∉ V |
| 3 | `zh-Hant-TW;q=1, zh-Hant;q=0` | `{zh-Hant, zh}` | `zh` | 截短鏈 `zh-Hant-TW` → `zh-Hant`（∈ V，否決，**續截**）→ `zh`（命中且 ∉ V） |
| 4 | `en;q=0.9, en;q=0` | `{en}` | 未命中 → fallback | 階段 5 last-wins 取後者 `q=0` → V={`en`} |
| 5 | `en;q=0, en;q=0.9` | `{en}` | `en` | 階段 5（去重）**先於**階段 6（建 V）：last-wins 取後者 `q=0.9`，`en` 從未進入 V |
| 6 | `en;q=1.5, zh;q=0.5` | `{en, zh}` | `zh` | 階段 2/3：`q=1.5` 超範圍 → **整筆忽略**（不 clamp 成 `1`）；`zh` 正常評估 |
| 7 | `en_US;q=1, zh;q=0.5` | `{en, zh}` | `zh` | 階段 2：`en_US` 不符 tag 形狀（底線非 BCP-47 分隔符）→ 忽略該筆，**其餘 tag 不受影響** |
| 8 | `en;q=0, *` | `{en, zh}` | 未命中 → fallback | 條 8：`*` 不命中任何白名單項且其 q 一律忽略；`en` ∈ V 被否決 |
| 9 | `en;q=0.8;q=0` | `{en}` | 未命中 → 續查下一來源 → fallback | **階段 2 參數 cardinality**：該 entry 依 `;` 切出 **3 段**（>2）→ **整筆丟棄**；`en` 既未進入排序、也**未進入否決集 V**，header 無其餘 entry → 本來源未命中。**MUST NOT** 取 `q=0.8` 或 `q=0` 任一者生效 |
| 10 | `en;charset=utf8, zh;q=0.5` | `{en, zh}` | `zh` | **同一條** cardinality 規則的第二個實例：`en;charset=utf8` 的第 2 段不是合法 q 參數 → 整筆丟棄；**其餘 entry 不受影響**，`zh` 正常評估 |
| 11 | `en;q=1., zh;q=0.` | `{en, zh}` | `en` | `q=1.`／`q=0.`（尾點、小數點後零位數字）符合階段 2 修正後的形狀式，**MUST NOT** 與畸形輸入同一路徑丟棄；分別視為 `q=1`／`q=0` 生效，`zh` 因 `q=0` 進入否決集 V，`en`（`q=1`）正常排序命中 |
| 12 | `ZH-tw;q=1` | `{zh-TW, en}` | `zh-TW` | 四段來源對白名單比對一律 case-insensitive；`ZH-tw` 正規化後與白名單值 `zh-TW` 正規化後相等，`Accept-Language` 段 exact 命中，**MUST NOT** 因大小寫不同誤判未命中而續查 fallback |

#### 排除的作法（四項）

1. **超範圍 q 用 clamp（`q=-0.1` → `0`、`q=1.5` → `1`）**：**排除**。clamp 負值會把一個打字錯誤變成 `q=0`（後果最重的最終否決狀態），畸形輸入 **MUST NOT** 有能力生成最強語意。忽略整筆另與階段 2 的畸形 tag 處理合為同一條規則，少一個分支。
2. **重複 tag 用 sticky veto（只要任一筆出現 `q=0` 即永久否決，不論位置）**：**排除**。它需要兩條規則處理重複，而 last-wins 是一條規則覆蓋全部重複情形；且它讓同一個 tag 同時存在兩個有效 q 值，與 D9-a「同一狀態兩種表示」同型缺陷。
3. **放大方向取「白名單中該 primary subtag 下宣告序最前者」**：**排除**。白名單未被賦予任何「有序」語意，採用它等同新增一條無 gate 或測試守得住的不變量；條 12 的撰寫期義務可等效覆蓋，成本更低且解析保持決定性。
4. **同一 entry 內多個 `q=` 取最後一個（把 last-wins 語意延伸進 entry 之內）**：**排除**。與第 2 項同源但不同軸；`en;q=0.8;q=0` 取最後一個會讓格式錯誤的 header 生成 `q=0`（後果最重的最終否決狀態），畸形輸入 **MUST NOT** 有能力生成最強語意。

## Exit Criteria

- 需求明示新建或重建一個 user-visible Web 頁面時，theme 與 locale 兩維度 **MUST** 各自完成繼承判定（見 `## When to Use` 四階段程序）或取得使用者答覆，方可呼叫 `dp-analyst`；任一維未完成 → `## Clarification State` 已記 `UNRESOLVED:` 且未呼叫 `dp-analyst`。
- 答「需要主題切換」時，實作 **MUST** 符合本檔 theme 值域封閉集 `{light, dark}`、cookie 屬性（`Secure` + `SameSite=Lax`、**MUST NOT** `HttpOnly`）、FOUC 防範與無效值回退契約。
- 答「需要多語系」時，實作 **MUST** 符合本檔 locale 四段優先序、BCP-47 白名單驗證、`Accept-Language` 12 條全序解析管線與 `<html lang>` 對齊契約。
- 答覆（含「不需要」）**MUST** 以 `decisions:` 欄 inline item 形式寫入該 change `meeting-notes.md` `## Clarification State` 區段，逐字形如 `web-theme: needed (provenance: user)`／`web-locale: not-needed (provenance: user)`。
- 判定指令對 `web-theme`／`web-locale` 各自實跑，掃描路徑限定 `openspec/changes/**/meeting-notes.md`，**MUST NOT** 以本檔或其他規範文本、`node_modules/**`、vendored 程式碼字面作為繼承證據。

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「這只是純 CSS 微調，不算新建頁面」 | 觸發條件錨定在「新建或重建 user-visible Web 表面」，非任何檔案副檔名；純樣式微調不觸發，但若同時新建 route/view 仍須判定兩維度 |
| 「這個 repo 之前應該有人問過了」 | 繼承判定的唯一證據是 `## Clarification State` 區段內 `decisions:` 欄逐字 item；未依判定指令實跑找到命中前，**MUST NOT** 假設已繼承 |
| 「使用者沒特別提主題/語系，不用主動問」 | pre-analyst 偵測到觸發條件時 **MUST** 主動詢問，非等使用者先提 |
| 「先把頁面做完，之後再回頭確認要不要多語系」 | Fail-closed 不變量：未取得答覆前 **MUST NOT** 呼叫 `dp-analyst`，不可延後到實作階段補問 |
| 「把答案寫成 `decisions:` 底下的縮排子項目就好」 | 答覆 **MUST** 是 `decisions:` 欄內以既有分隔符（`;` 或 `|`，空值預設 `;`）分隔的 inline item；縮排子 bullet 會被 `parseBulletFields` 解析成頂層欄位並觸發 `unknown field` 判錯，等於答了也沒寫進去 |
| 「反正都寫進 `decisions:` 就好，用 `;` 還是 `|` 分隔不影響判定」 | **MUST** 與該值既有分隔符一致；混用會讓 `splitListItems` 把舊 items 與新 item 誤併為單一 item，使既有維度的繼承證據悄悄失效 |
| 「這個 legacy repo 已經有 dark mode / i18n 實作了，不用再問」 | 繼承載體只認 `## Clarification State` 的答覆紀錄，不認實作痕跡（repo-wide 字面掃描會被規範文本自身污染，見掃描路徑封閉集規則）；沒有 `web-theme:`／`web-locale:` 答覆紀錄仍須問一次，即便該次為冗餘問題 |
| 「`qa-test-scope.md` 沒填 theme/locale 驗證欄位，所以這次可以不用管」 | 該欄位是選填（SHOULD／建議），不影響 pre-analyst probe 本身是否必問；probe 的 fail-closed 義務與 qa-test-scope 欄位是否填寫無關 |

## Verification

`qa-test-scope.md` `### UI smoke` 區塊內 theme/locale 驗證欄位為**條件式選填**（`design.md` D4 裁決維持選填，不升為必填條款）：填寫者 **SHOULD**（建議）在「已答需要 theme／locale 且已採用」時記錄 `theme: dark✓ light✓；locale: <生效語系清單>`；未填不構成 archive gate 阻斷條件。

可重複執行的驗證指令：

```bash
# 十三個 anchor literal 存在性
for a in "SameSite=Lax" "HttpOnly" "prefers-color-scheme" "Accept-Language" "BCP-47" \
         "{light, dark}" "q=0" "RFC 4647" "web-theme:" "web-locale:" \
         "Clarification State" "clarification-contract.mjs" "splitListItems"; do
  grep -c -- "$a" .devpro/agent-rules/frontend-theming-and-i18n.md
done

node --test .devpro/scripts/tests/rule-anatomy.test.mjs
```

判定指令的唯一 copy-executable 副本在 `## When to Use` §判定指令；MUST 對 `web-theme` 與 `web-locale` 兩個 prefix 各自實跑一次（見該節「同一指令對 `web-locale` 重跑一次」），本節不重貼該 fence 以避免兩份副本各自漂移。
