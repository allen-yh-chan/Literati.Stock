---
name: frontend-ui-layout
description: "UI 撰寫閘：無設計稿先 wireframe；禁 UI 單字孤立換行；agent 中文硬折行兩條。觸發：新建/重建 user-visible Web，或撰寫含硬折行的中文長段落。"
---

# Frontend UI Layout／CJK 硬折行

## Overview

本檔是 UI 版面與 agent 中文硬折行的 SSOT：(1) 無明確設計稿時的 wireframe 通過閘；(2) user-visible UI 禁止單字元孤立換行；(3) agent 撰寫中文／混排長段落硬折行時的續行禁則。theme／locale 見 `frontend-theming-and-i18n.md`；AJAX 後發先至見 `security-coding.md`。

## When to Use

- 需求**明示新建或重建** user-visible Web 頁面／畫面／view／route（與 `frontend-theming-and-i18n.md` §When to Use 同一觸發字面）時 → 套用 **Wireframe 閘**與 **UI 孤立換行**
- agent 寫入 rule／docs／OpenSpec／session-pending 等載體、對中文（或 CJK 混排）長段落做**硬折行**時 → 套用 **CJK 硬折行**兩條
- 局部改既有頁面文案／CSS 且未新建／重建整頁 → wireframe 閘不觸發；若仍改 user-visible 換行／斷行，仍套用 UI 孤立換行

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A |
| Advisory | `.devpro/scripts/tests/frontend-ui-layout-grep.test.mjs`（鎖 AGENTS／checklist／leaf MUST 字面與 mutation localization；不驗 runtime UI 像素） |
| Doctrine | `cooperative-only`: wireframe／孤立換行／CJK 硬折行結果依賴 reviewer／作者遵守；本檔無 hook hard gate |

### Wireframe 閘（擋開始實作）

當 When to Use 的「新建／重建 user-visible Web」觸發成立，且需求**未**附明確 UI/UX 設計稿、mock、或已核准的視覺規格時：

- 實作（寫 UI 碼／改 layout CSS／落地元件結構）開始前，**MUST** 先用 wireframe（線框／區塊層級草圖即可）與使用者通好資訊架構與主要互動，並取得通過。
- 通過證據 **MUST** 落在本 change 的 `meeting-notes.md` `## Clarification State` `decisions:` 內，整項錨定符合：`ui-wireframe: approved (provenance: user)`（允許同一 `decisions:` 欄以 `;` 或 `|` 與其他 item 並列；比對語意對齊 theme/locale probe 的整項錨定精神）。
- **MUST NOT** 以「先寫再說」「用預設元件頂著」略過 wireframe。
- **MUST NOT** 用本閘阻擋 `dp-analyst`／pre-analyst；本閘只擋**開始實作**。

當上述觸發成立，但需求**已**附明確設計稿／mock／已核准視覺規格時：**MUST NOT** 要求 `ui-wireframe: approved (provenance: user)` 才可開始實作；孤立換行等其餘本檔規則仍適用。

### UI 孤立換行（單字元独占一行）

對 user-visible UI 文字（標籤、標題、按鈕、段落、表頭等）：

- **MUST NOT** 出現因排版、容器寬度、或內容斷行而造成的「單一可見字元独占一行」（含單一 CJK 字或單一 Latin 字母；標點単独成行亦禁止）。
- 修法優先序：調文案／`white-space`／換行點／容器寬度；**MUST NOT** 只加裝飾性空白假裝沒斷開。

### CJK 硬折行（agent 寫作）

對中文或 CJK 混排長段落做硬折行（作者手動插入換行，而非軟性 wrap）時：

1. **續行長度**：硬折行後的下一行 **MUST NOT** 只剩一或兩個字（CJK 字元或 Latin 字母計；純空白行不適用）。
2. **續行開頭**：硬折行後的下一行 **MUST NOT** 以「符號」開頭。本檔「符號」閉集＝中日文收尾標點（`，。、；：！？）】」』》`）、破折號／省略號字形（`—` `──` `…` `⋯`）、ASCII 標點與運算符（`,.;:!?)]}%/\\|~^&*+=-`）、以及 markdown 強調標記 `*`。**不含**開頭括號（`（【「《([{`）與行內反引號開頭——該兩類在 CJK 行頭禁則裡可為合法行首。

## Exit Criteria

- [ ] 新建／重建 Web 且無設計稿時，實作前已有 meeting-notes wireframe 通過記號（見 Process）
- [ ] user-visible UI 無單字元独占一行
- [ ] 本次硬折行的中文續行無 ≤2 字、無符號開頭
- [ ] AGENTS Intent 表可經 `wireframe/孤立換行/中文硬折行/單一字換行` 觸發詞到達本檔

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「先做再給使用者看就等於 wireframe」 | 閘在開始實作前；做完再問＝已違規 |
| 「一個字換行是 CSS 問題不是規則問題」 | 規則要求結果不出現；誰改文案／CSS 都要消掉 |
| 「硬折行續行以 `**` 開頭比較好看」 | `*` 屬符號集；先斷在詞界再加強調 |
| 「theme/locale 已問過就不用 wireframe」 | 維度不同；theme／locale ≠ 版面資訊架構 |

## Verification

- [ ] AGENTS Intent 表含「先發後至／後發先至／名單切換」→ `security-coding.md`，以及 `wireframe/孤立換行/中文硬折行/單一字換行` → 本檔
- [ ] `code-review-checklist.md` 含 AJAX 後發先至與 UI layout／wireframe cooperative-only 勾稽
- [ ] `node --test .devpro/scripts/tests/frontend-ui-layout-grep.test.mjs` 全綠
- [ ] 刪除本檔任一 OPERATIVE MUST／MUST NOT 錨定行後，對應 grep assertion 變紅
