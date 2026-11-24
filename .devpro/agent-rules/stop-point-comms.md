---
name: stop-point-comms
description: Stop-Point 溝通契約：AI 停下把球交回使用者時，回應結尾必含交棒區塊（三要素 + 編號選項〔末項為開放項，`3.其他` 可兼任〕 + 術語配白話）；凌駕所有 stop 點。
---

# Stop-Point 溝通契約

## Overview

**橫切契約**，凌駕所有 stop 點（verb 不合、working tree 髒、ambiguity 過高、pre-flight FAIL、cross-model CRITICAL、測試紅、需授權…）：規定 AI 停下等使用者時**回應該長什麼樣**，不改任何既有規則的觸發條件。

## When to Use

AI 中止流程、把球交回使用者的**任何**時刻，不分原因、不分流程階段。只要這一輪結束時球在使用者手上，本契約即適用。

## Process

### Final-response self-check

寫最後回覆前先判：本 turn 結束後球在誰手上？若是使用者，或正文 / adapter footer 出現 `AskFirstPending`、等待授權、cross-repo PR 停點（builder `pr_repository_mismatch`）、open PR / not merged（PR 已開但尚未 merge）、awaiting merge-review、merge / PR 決策等 user-owned pause，最後一段必須套本契約；若 owner=AI / reviewer / automation / third party 且 AI 會繼續，不要製造選項或重問已核准事項。hook / systemMessage 裡的 agent-facing next step 不是使用者交棒。Matching Ledger 例外（SSOT `ai-autonomy.md` Matching Batch Approval Ledger；禁抄 YAML）：matching ledger 覆蓋下一步 git/PR write 且不在 `excludes` 時 owner=AI，MUST 續跑，MUST NOT 製造編號選項；已覆蓋 write 的 `AskFirstPending` 不得當 user-owned pause。

### Merge Ask First / post-PR Ready Response（pointer-only）

當 Final-response self-check 判定 **Owner=user**，且本 turn 是 **merge Ask First** 或 **post-PR Ready Response** 時，交棒區塊最小骨架還 MUST 依序含 `ChangeContext:` 然後 `ManualTest:`。欄位正文與階梯 SSOT 是 `post-pr-completion-gate.md` §Ready Response Next-Step Contract；本檔只 pointer，禁止複寫完整 ChangeContext／ManualTest 正文。

MUST NOT 把 `ChangeContext:`／`ManualTest:` 套到每一個 stop-point（clarification、dirty WT、pre-PR 且非 merge Ask First 等）。

### 硬規則（1–5）

任何 stop 點，回應**最後**必須是一個明確的「交棒區塊」，滿足以下規則，缺一即違規：

**1. 三要素（缺一不可）**

| 要素 | 內容 | 為何非要 |
|---|---|---|
| **為什麼停**（state） | 一句話講清卡在哪，講現象、不丟術語代碼 | 使用者分得清「在等我」vs「卡死了」 |
| **要你做什麼**（ask） | 使用者該回什麼，給到可直接照做的程度 | 使用者知道球在他手上、且知道怎麼回 |
| **回了會怎樣**（next） | 使用者回應後 AI 接著做什麼 | 使用者知道回應代價小，不卡死 |

**禁止**：停下卻不交棒（只描述問題、不講使用者要做什麼）＝流程中斷＝違規。

**2. 問法匹配真實分岔數（選項一律編號，數量匹配分岔）**

選項一律**編號（1/2/3…）**讓使用者回一個數字，不准只列詞讓他打字。但**選項數量必須匹配真實分岔，不硬湊**——先判斷下一步形狀：

- **單一確定動作**（下一步是流程已定義的事，絕大多數情況）→ `1.是 2.否 3.其他`，**不**湊平行選項。
- **真有多條實質不同的路**（如 working tree 髒：stash／discard／帶著走）→ 才列多個編號選項。

**禁止**：把「要不要照走」的是非決定膨脹成多選項選單（增加負擔，違背契約初衷）。開放型問題才用文字提問。

**禁止外包 AI-actionable 收尾**：gate 全過且下一步是流程定義的 AI-actionable 收尾（如 regular merge / post-merge cleanup）時，不把它列成「使用者去做」的選項；若 Ask First 仍需確認，問「是否授權 AI 執行 <具名動作>」。

**宣稱數一致**：散文若報選項數（「兩條路」「三個選項」），該數**必須等於實際編號項數，末項開放項也算一項**。例：給 `1.是 2.否 3.其他` 就是「三個選項」，不是「兩條路」。不確定就**別報數字**，讓編號自己說話。報錯數＝描述與選項不符＝違規。

**編號不被渲染器接續**：終端機的 markdown 渲染器會把同一則訊息裡**後面的有序清單接續前一組的編號**（前面有一組 1–4，後面的選項 1/2/3 會顯示成 5/6/7），使用者照畫面回的數字就對不上你寫的選項。MUST：單題時，整則訊息只放**一組**有序清單，就是選項本身（行首 `N.`）；事實、摘要、步驟、決策項等其他並列資訊一律改用無序符號（`-`）。多問題並列時，各題選項寫成**行內** `Q1-1.`／`Q2-1.` 形式，整則訊息的行首 `N.` 有序清單為**零組**，回覆照「Q1-1 Q2-2」。發出前掃一次：單題的行首 `N.` 有序清單組數不是 1、或多題不是 0 → 重排。

**3. 末項是開放項（開放出口）**

每組選項的**最後一項必須是開放項**——選它＝AI 不再丟選項，直接轉自由對話。**固定的是「末項＝開放出口」這個語意，不是某句台詞，也不要求它是獨立於其他選項的額外一項**：只要末項本身就邀請自由輸入即可。因此 `1.是 2.否 3.其他` 這種已含 `3.其他` 的形狀，`3.其他` 本身就是合格的開放出口，**不必再額外加一個獨立「逃生口」項**（再加＝重複，違反輸出紀律 §簡潔）；只有當末項是封閉具體動作（如 `1.stash 2.discard`）時，才需補一個開放項收尾。開放項可用標準句「**以上都不是 / 我想直接跟你說**」（下方第一個範例逐字用），其他情境換等價自然講法、意思等同即可。多子問題並列時整組末尾給一個總開放出口。末項開放項是強制保險，防封閉選項漏掉真實情況。

**4. 術語配白話（不判斷新手/舊手）**

**不要**猜使用者是新手還是舊手（用詞跟懂不懂不對應、猜錯會一路黏住、無法驗證）。一律同一種寫法：三要素用人話講；技術詞（worktree、stash、anchor、merge、spec…）**第一次**出現時緊接括號補白話，例 `stash（先把改動收起來、可還原）`，同回應重複可不再註解。

**5. 選項呈現契約（提案確認）**

停下交棒／clarification 給使用者選時，**MUST** 走 **提案確認**主路徑：AI 先 draft 白話問題＋白話編號選項（可含推薦），再請使用者確認或改選。

- **MUST**：問題用白話；每個選項用白話（可另附術語，但白話先到）。
- **MUST**：若有推薦項，推薦理由**寫在該選項旁**（同一選項文字內），讓使用者一眼看到「選這個為什麼好」。
- **禁止**：作文題主路徑（逼使用者先寫長文需求／開放作文才給選項）。
- **禁止**：獨立空標籤「為什麼有推薦」（只有標籤、旁邊沒有白話理由＝違規）。
- **合法例（白話卡）**：五欄白話卡（使用者故事／現在／引擎／做成後你會看到／不該被整包丟掉的）＋「請確認或改」依路徑出現：lite 全分類與 full 初判 A／B-mini 在 `/devpro:change` 第零步與授權題同則分區；full＋B 在 pre-analyst 訪談後；手動 chore A 在第一次 git 動作確認訊息（政策 SSOT `ambiguity-scoring.md` §Operator usage probe）；這是提案確認產物形狀，不是作文題。
- **分區**：同一則訊息可並列 **git／batch 授權題**（1/2/3）與 **需求白話卡**，但兩者必須分區、各自可回；**禁止**併成「授權＋四題需求作文」單題。

### 呈現層 ↔ 內容骨架對應（三要素承載五欄）

上面「硬規則（1–5）」是本檔的職責：規定交棒區塊**讀起來**該長什麼樣（呈現層 SSOT）。交棒**內容上**必須帶哪些結構化資訊（element model 骨架層）**不歸本檔管**——**其唯一權威定義是 `ai-autonomy.md §Stop-Point Next Step Contract` 的「五項」（目前狀態 / 阻塞依賴 / 下一個 AI-actionable step / owner / continuation）**。本檔只給呈現層如何承載它的對應表。

三要素是那五項 element 的**白話呈現投影**，不是另一套契約。對應關係：

| ai-autonomy.md 五項（內容骨架，SSOT）| 由哪個呈現要素承載 |
|---|---|
| 目前狀態 + 阻塞/依賴 | → **為什麼停**（state） |
| owner + continuation | → **回了會怎樣**（next） |
| 下一個 AI-actionable step | → **回了會怎樣**（next）＋以**編號選項**呈現（見規則 2）|

用白話寫出的三要素只要**實質涵蓋 `ai-autonomy.md` 五項的資訊**即合格，不要求逐欄貼標籤字面。

### Clarification / cap-hit stop（pointer-only）

pre-analyst clarification 的 round／cap／trigger／`cap_resolution`／terminal／write-back 規則 → `.devpro/agent-rules/ambiguity-scoring.md`（本檔只規定交棒**呈現**；不複寫 working-cap／absolute-max／trigger 正文）。cap-hit 或 frontier 未決停下時，仍套本契約規則 1–4＋規則 5（選項呈現契約）呈現選項：尚未用過 absolute-max extension（`round < 4` 且 `extension_used=false`）時可含 extend／split／carry-gaps／abort；**post-round-4**（已 `round=4`／`extension_used=true`）**MUST NOT** 再呈 extend——僅 split／carry-gaps／abort。

### 通吃範例

**單一確定動作 → 1.是 2.否 3.其他**（最常見；下一步是流程已定義的事，不湊選項）。例（測試綠+archive 完成，下一步照標準 commit→push→開 PR）：「為什麼停：實作完、測試綠，下一步照標準要推上 GitHub 開 PR。要你做什麼（回數字）→ **1.** 是，照標準往下（推薦：測試已綠、照既有流程最省來回） **2.** 否，先停著 **3.** 其他。回了會怎樣：回 1 我做到 PR ready、外向動作前再確認；回 2 我等你；回 3 我聽你說。」Matching Ledger 例外：matching ledger 覆蓋下一步 commit／push／PR（`local_commit`／`first_push`／`pre_pr_gate`／`pr_create_update` 且不在 `excludes`）時上例不適用——owner=AI，MUST 續跑，MUST NOT 製造 `1.是 2.否 3.其他`（SSOT `ai-autonomy.md` Matching Ledger）。

**例：規則 5 提案確認（推薦理由在選項旁）**——「為什麼停：開 change 前要先鎖互動形狀。要你做什麼（回數字）→ **1.** AI 先給建議選項、你確認或改選（推薦：比作文題快、也比較不會漏條件） **2.** 你先寫完整需求長文再給我整理 **3.** 其他。回了會怎樣：回 1 我依提案確認主路徑繼續；回 2／3 我聽你的。」（注意：**禁止**另起空標籤「為什麼有推薦」。）

**例：規則 5 白話卡＋授權分區**——「為什麼停：batch scope 與用法確認可同則訊息但須分區。要你做什麼 → **授權** **1.** batch approval（推薦） **2.** stepwise **3.** 其他。**需求卡**（請確認或改）：使用者故事：…／現在：…／引擎：…／做成後你會看到：…／不該被整包丟掉的：…。回了會怎樣：回授權數字＋『卡 OK』或改某一欄；**禁止**把授權與四題需求作文併成一題。」

**例：`devpro:change` branch verb 不在白名單**（兩條實質路 + 開放項收尾；末項由 `3.其他` 兼任，不另起獨立項）

> 我先停一下 ✋
> **為什麼停**：開分支前，我得幫你這次的動作取一個「動作名稱（branch verb，分支用的動詞）」做歸類，但你說的「禁止（ban）」不在我能用的清單裡。
> **要你做什麼**：這次比較接近哪個（回數字就好）→ **1.** 強制/落實某個規則（enforce） **2.** 加強現有的東西（strengthen） **3.** 以上都不是 / 我想直接跟你說。
> **回了會怎樣**：你回 1 或 2，我立刻接著開分支、進下一步，不用重講需求；回 3 我就聽你講你想做什麼。

**例：選項全是封閉具體動作 → 才補一個開放項收尾**（如 working tree 髒，真三岔路、每項都是具體動作）：「→ **1.** stash **2.** discard **3.** 帶進這次工作 **4.** 我不確定 / 直接跟你說」——前三項皆封閉動作、無一邀請自由輸入，故末項補開放項 **4.**。**多問題並列**（如 ambiguity）：每題各自編號、選項寫成行內 `Q1-1.`（見規則 2「編號不被渲染器接續」；回「Q1-1 Q2-2」），整組末尾給一個總開放出口（回「聊」），不必每題各加。

## Exit Criteria

- 停下等使用者時含三要素（為什麼停 / 要你做什麼 / 回了會怎樣）；選項已編號、末項為開放項（`3.其他` 可兼任，不必另起獨立逃生口）；技術詞首現配白話；有選項時走提案確認主路徑（禁作文題主路徑），推薦理由在選項旁（禁空標籤「為什麼有推薦」）。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「這個停下很明顯，不用講下一步」 | 對 AI 明顯 ≠ 對使用者明顯；他看不到流程狀態，須主動廣播。 |
| 「測試綠了所以要問 1.是 2.否 3.其他」 | Matching ledger 已覆蓋下一步 git/PR write 時 owner=AI，MUST 續跑，禁製造編號選項。SSOT：`ai-autonomy.md` Matching Ledger。 |
| 「使用者是工程師，講術語就好」 | 不判斷新舊手；術語首現一律配白話，懂的人只多看幾字。 |
| 「選項已涵蓋所有情況」 | 封閉選項常漏掉真實情況；末項必須是開放項當保險。 |
| 「已有 `3.其他` 了，還要再加一個逃生口才保險」 | 不用。`3.其他` 本身就是開放出口，已滿足「末項＝開放項」；再加獨立逃生口＝重複（padding）。只有末項是封閉具體動作時才補開放項。 |
| 「每個停下都要 ChangeContext／ManualTest」 | 否。只在 Owner=user 且 merge Ask First／post-PR Ready Response；clarification、dirty WT、pre-PR 非 merge Ask First 不套。正文 SSOT 在 `post-pr-completion-gate.md`。 |

## Cross-References

- `post-pr-completion-gate.md` §Ready Response Next-Step Contract（ChangeContext／ManualTest SSOT）
- `ai-autonomy.md` §Stop-Point Next Step Contract（五項內容骨架 SSOT）

## Verification

```bash
F=.devpro/agent-rules/stop-point-comms.md
for k in 為什麼停 要你做什麼 回了會怎樣 開放項 術語配白話; do grep -q "$k" "$F" || echo "MISSING $k"; done
grep -q "停下交回使用者必附交棒" AGENTS.md && grep -q "stop-point-comms" AGENTS.md
```

機械 enforcement：`stop-point-comms-grep.test.mjs`（含末項開放項語意 + 段落範圍斷言）。
