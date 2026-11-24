---
name: design-reasoning
description: "跨模組設計、ownership／介面不確定、方案比較或實作摩擦時，從運作模型與 caller 推導設計並驗證回饋。"
---

# Design Reasoning

## Overview

讓設計從系統如何運作與使用者如何呼叫出發，連到實作遇到的真實限制。TL 與 architect 擁有設計判斷；implementer 提供摩擦證據。沿用現有 scope、授權、TDD、相容性與 review gate。

## When to Use

- 跨模組新增行為，或持久介面、資料／invariant ownership、共享狀態尚未確定時。
- 實作反覆需要 workaround、caller 操作內部細節，或新事實推翻設計假設時。
- 清楚的局部修改只核對受影響行為，不強制多方案、prototype 或新增設計文件。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `design-cold-read-prewrite`：只驗紀錄格式與所屬 change；其餘語意 N/A |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


先依 `rules-rigor-level.md` 選既有 carrier。預設 lite 時 MUST 以回覆／handoff 承載本方法，不因 B 分類要求 proposal.md、design.md、spec delta、tasks.md 或重新詢問升 full；只有既有明確 full 選擇才沿完整產物流程。使用者明示交付單一文件時照授權寫，不因此展開其他 full 產物。本方法新增設計步驟，不改 rigor 選擇。

### Working Model

先依 `intent-lookup-order.md` 的 specs-first 順序確認 intended contract，再追真實入口、主要資料／控制流、狀態 owner、外部依賴與失敗路徑。交付能解釋「誰在什麼時候改什麼」的模型與關鍵證據；檔案列表不是運作模型。未查明處標 unknown，不用推測補成事實。

### Historical Constraints

當變更會動到 ownership、layering 或既有取捨時，沿既有 git／PR 查找順序追原因；只查相關且已授權的來源，分開事實、推論、未知與信心。把證據轉成此次設計的 Preserve／Change／Avoid／Risk 約束；找不到歷史不能聲稱沒有理由。現有架構不是必須永久保留的結論。

### Usage Before Shape

MUST 先寫真實 caller 使用例，再推導資料、invariant、owner、型別與介面。使用例涵蓋主要操作、必要的失敗／生命週期；追 dominant access path，讓每個 invariant 有明確 owner，能推導的狀態不要手動同步。公開介面隱藏 transport、同步與政策細節；內部較豐富的實作可支撐簡單 caller，不以最少行數判設計優劣。

### Alternatives and Experiments

持久介面、ownership 或共享狀態存在實質未解選擇時，TL MUST 比較兩個結構不同、服務相同 caller 與約束的草圖；唯一可行形狀須說明排除其他方案的具體限制。已知局部修正不湊方案數。先定成功標準，再以使用例、資料流、責任邊界、閱讀負擔與風險比較；不得只換 pattern 名稱。

候選比較選一個完整基底，其他方案的局部優點只有在理由與整體驗證成立時才合併；相同方案不強迫 graft，目標不同則先修 brief。要並行產生或審查候選時，沿既有 delegation admission、授權、隔離與獨立性規則；本方法不自動授權 spawn，也不指定模型。

只有具體未知會改變決策時才做隔離 prototype：先寫要裁決的問題、觀察方式與成功／否定條件，再做最小實驗，記錄觀察、限制與選擇。Prototype 不直接當成可交付產品；依選定設計補正式實作與驗證。可由現有證據回答的問題不重做實驗；安全關鍵 runtime 假設依既有 consequence assessment 實證。

### Engineering Review Lenses

需求澄清／設計首次遇到跨模組變更、重要介面變更、ownership／共享狀態未定、反覆實作摩擦，或使用者明示要求多視角審查時，TL 在既有回覆／handoff 留一行或短表：六視角各自選用／不適用及理由。選用者記檢查對象、結論、依據；共同完成判準依 `ambiguity-scoring.md` 的 Lens Completion。無理由漏選或選後未評估不得算完成；已清楚的局部修改不強制啟動。修訂有新風險時只重看受影響視角。以下提示表只在本段維護，clarify／其他入口只引用；不固定派六個 agents、不新增 finding 配額。

| 工程視角 | 要回答的問題 |
|---|---|
| YAGNI／Contrarian | 原問題成立嗎？現有能力能否達成 outcome？哪些新增複雜度真正必要？ |
| 成本、配額與 token | 主要資源路徑與規模限制是什麼？會遇到哪個實際配額？ |
| UX／DX | 真實 caller 如何操作？錯誤是否可理解、可處理？ |
| 遷移與相容性 | 誰持有既有契約／資料？更新、回復與版本差異如何處理？ |
| 可觀測性與維運 | 如何確認實際成功、定位失敗與追查副作用？ |
| 長期維護 | 哪些狀態、依賴或責任耦合會增加維護成本？ |

舊三個需求挑戰視角仍依原觸發全數評估，不被本表取代；重疊判斷引用同一證據即可。獨立挑戰仍沿現有 delegation admission／授權；本表不自行授權 spawn。

### Design Cold Read and Implementation Handoff

有 `design.md` 的 change 在設計審查收斂、`tasks.md` 完成後，第一個實作寫入前 MUST 做冷讀。適用與否看 change 形狀（有 proposal 且有 `design.md`），不看 hook level：session 內具名的 full 進不了 hook，lite 不寫 proposal 故不做；B-mini 自行寫了 `design.md` 同樣適用。冷讀與 `dp-second-reviewer` 分開跑，不佔審查輪數。只在 scope change re-entry 重跑（第一行改回 `status: pending`）。

fresh 唯讀讀者（例 `dp-explorer`）只讀該 change 有的最終 artifact：`brd.md`、`proposal.md` 或 `proposal-mini.md`（B-mini 的任務在內）、`design.md`、`tasks.md`、spec delta，不給對話背景、ledger、審查重點、作者結論或白話卡。讀者輸出五欄白話卡、要使用者決定的事與代價、讀不懂或矛盾之處；寫不出的欄位算 finding。TL MUST 逐欄對照使用者確認過的白話卡，不一致算 finding 並記處置，再交給使用者確認。每次都停，batch approval 不涵蓋。作者自評不算冷讀。步驟見 `/devpro:change`。

紀錄寫 `openspec/changes/<change>/comprehension.md`（tracked，隨 archive 搬走）。第一行是狀態，下方放讀者原文、對照與處置：

| 第一行 | 誰寫 |
|---|---|
| `status: pending` | AI 用檔案工具寫，讀者回報後 |
| `status: user-confirmed` | 使用者在對話確認後，AI 跑 `node .devpro/scripts/confirm-design-cold-read.mjs <change> --user-answer "<原話>"` |
| `status: user-accepted-unverified` | 同上加 `--unverified`：無讀者可用或本規則上線前已開工、標「冷讀未驗證」，使用者決定繼續 |

指令在下方加 `user-answer:`（原話）與 `change:` 兩行，不需終端機或簽章。使用者還沒回答就跑或引用沒說過的話，屬偽造同意證據。Gate CR（`design-cold-read-prewrite`）只認第一行恰為放行狀態、恰一行非空 `user-answer:`、`change:` 為本 change 的紀錄，其餘擋檔案工具的實作寫入，`notes/` 與該 change 資料夾除外。舊版帶 `proof=` 的紀錄不放行，問使用者確認後依原話重跑這行。治理對象是 `workflow-and-openspec-state-integrity`。閘證明不了使用者真的回答或讀過原文，屬 `design-core.md` §11 `consent-record-residual`，不另立具名例外。「冷讀未驗證」不豁免任何既有 gate，理解缺口不自動等於 Critical。

先說清目標讀者與可讀來源。目標工程師也需要的脈絡才補文件／引用；證據在可讀範圍外或只有零 context 模型才需要時，交 TL／知識 owner 判斷，不為滿足 reader 無限補文。重要介面、資料、不變量與 owner、依賴、失敗語意及驗收須在交接時明確；未定的重要決策交 owner，不能讓 implementer 猜。局部可逆寫法仍屬 implementer 戰術決策，新事實沿 Implementation Feedback 回報。

### Revision Whole-Design Check

處理審查意見若新增狀態、依賴或改責任邊界，TL 於既有 finding 處置／over-design 檢查點回看原問題、caller、owner 與整體複雜度，留下必要性或簡化判斷。只核對修訂影響，不固定重跑完整審查，不重置 finding ID／round budget；越出原 scope 沿既有 scope gate。本項是對上游方法的適配，不宣稱 Google 保證每次修訂都會執行此檢查。

### Implementation Feedback

Implementer MUST 回報反覆同類 workaround、caller 知道內部細節、forced cast／不合法狀態或與 ownership 不符的鎖定需求，附實際 input／call site、違反假設與影響；不得靜默改 API／架構或繼續堆補丁。TL 回到運作模型、caller 與 owner 修正設計，移除被取代路徑，驗證完整選定方案；一次合理 edge case 不自動等於整體設計失敗。

超出核准範圍時 MUST 走既有 scope gate，保留能獨立完成的範圍內工作；本閉環不授權無限 redesign。MUST NOT 以尚未實作的設計案例宣稱 feedback 已驗證。

## Exit Criteria

- 既有 proposal／design／handoff 能追溯：問題、caller 使用例、資料與 ownership、選擇理由、保留約束、未解風險與下一實作步驟。
- Prototype 有可重讀的觀察；實作偏差已裁決，TDD 與真實產物驗證沿原入口完成。
- Full 的 design.md 與審查義務沿既有規範；lite 不增加必填檔案或新 gate。Gate CR 只守冷讀紀錄的存在與狀態；其餘語意執行屬 cooperative-only，anchor tests 只守載體。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「有檔案清單就懂系統」 | 要能追資料、狀態與失敗路徑。 |
| 「每題都開多模型／prototype」 | 未解且會改變決策的問題才增加工作。 |
| 「caller 彆扭就再補 adapter」 | 先核對 owner 與原使用例，偏差交 TL。 |

## Verification

以跨模組功能、簡單局部修改與實作摩擦的 fresh-context 任務核對實際讀取、使用例、決策與產物；案例未進入的階段記為未測。結構回歸：`node --test .devpro/scripts/tests/design-core-leaf.test.mjs`。
