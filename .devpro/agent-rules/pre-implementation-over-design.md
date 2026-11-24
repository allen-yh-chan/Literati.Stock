---
name: pre-implementation-over-design
description: "開工前 over-design 自檢 + preparatory refactoring 鋪路規則。觸發：開工前、實作新功能前、dp-programmer 接到委派時、dp-architect 設計階段、相容／dual-read／legacy schema。"
---

# Pre-Implementation Over-Design

## Overview

實作下去之前有兩個互補的前置自檢：(1) **Over-Design Audit**——確認設計沒有超出需求的抽象與複雜度；(2) **Preparatory Refactoring**——確認既有結構能乾淨承載即將加入的新功能，必要時先鋪路。兩者同屬「開工前」階段，是減少實作風險的紀律入口。

## When to Use

- dp-programmer 接到實作委派、寫第一行程式碼前
- dp-architect 完成 proposal 設計、送出委派前
- TL 設計 hook / script / helper 時
- 新功能難以直接塞進既有結構，懷疑需要先重構時

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for semantic execution |
| Advisory | N/A |
| Doctrine | `cooperative-only`：依現有入口由 TL／角色執行；focused tests 僅守載體與契約，不證明語意遵循。 |


跨模組設計或反覆實作摩擦時，先依 `design-reasoning.md` 核對 caller、資料與 ownership；implementer 回報具體偏差供 TL 裁決，不自行改架構。

審查修訂新增狀態、依賴或責任邊界時，沿 `design-reasoning.md` §Revision Whole-Design Check 在原處置點回看整體；不另開固定審查或重置 budget。

### Pre-Implementation Over-Design Audit

TL／implementer MUST 在每個新 proposed delta 寫入前依 `design-core.md` §Scope/Value Pre-Write Admission 核對核准範圍與直接價值；本節的簡化／鋪路不能替代擴張 scope 的授權。

**觸發**：dp-architect proposal 階段、dp-programmer 開工前、TL 設計 hook / script / helper 時。在實作下去**之前**自檢；違反任一 → 簡化或論證必要。

| Audit 項 | 觸發 | 簡化方向 |
|---|---|---|
| 重複 cache | 同份資料用 ≥ 2 個 TTL / cache layer | 合併成單一 marker / cache，或證明各層有獨立失效語意 |
| 複雜 state object | JSON state 含 ≥ 4 個欄位且不必同時讀寫 | 拆分或改用 file mtime / 環境變數 |
| 子進程 call | 跑外部 script 取已知能用內建命令取得的資料 | 用內建命令（git built-in / `gh` CLI flags）|
| Regex 解結構化資料 | sed / awk 解 git remote / JSON / 設定檔 | 用 official CLI flags（`gh --json` / `jq` / `git for-each-ref`）|
| 無價值抽象 | helper / utility / config 增加跳轉，卻未隱藏有價值的知識／政策／協定 | 移除無價值層；單一 caller 仍可保留有價值的邊界；按 `code-simplification.md` 閱讀負擔判斷 |
| Configurability 過早 | 加 env var / flag / option 但無實際變動需求 | hard-code 直到實際需求出現 |
| 多層 fallback | catch → fallback → fallback 鏈 | 直接 fail-fast，由上層決策 |
| schema／contract 改版或保留 vN-1 | 為前一版寫 dual-read／adapter／vN-1 fallback／遷移層 | 先做下方 holder test：無持有者 → 砍舊路徑／只對齊現行；有持有者 → `change-consequence-assessment.md` Compatibility／migration |

**反對藉口**：

- 「以後要擴充」→ 沒這次需求就 inline，未來真擴時再抽
- 「比較有彈性」→ 彈性是 cost，需論證 ROI（哪個情境會用到）
- 「正規做法應該這樣」→ 有正規做法但本場景不需要 = 過度設計
- 「為了保險」→ 多層保險 = 多層失效模式；fail-fast 比 fallback chain 易 debug
- 「比較完整／以後可能有人用到舊格式／先寫相容比較安全／內部 schema 也要像對外 API 一樣永遠相容」→ 無持有者＝假想使用者；成本是 token／維護／測試分叉（見 `Pre-Ship Contract Dual-Read Ban`）

**Scope stop-loss（pointer only）**：material semantic carrier group／二次 redesign／越界 boundary 的停下與 anti-gaming → `openspec-scope-change.md`；本檔不擁有該契約。

### Pre-Ship Contract Dual-Read Ban

要為「前一版」schema／contract 寫相容碼（dual-read、adapter、vN-1 fallback、遷移層）前，MUST 先判定是否存在 **真實持有者**（holder test；三條件 **只寫於此**）：

1. 已上 **production**（含 consumer 已 sync／持有該契約產物），或
2. 野外已有 **不可丟棄的 durable artifact**（例：已 seal 的 receipt／sticky／已發佈 API 呼叫端），或
3. 使用者／BRD **明示**必須相容舊版

**射程**：產品／業務 runtime 與內部控制面同一原則（例：API／Publish／引擎 IR／DB schema；packet／receipt／marker／config 契約）。

- **無持有者**（含僅開發者自測、尚未首發 PROD、greenfield 迭代）：**MUST NOT** 實作舊版雙讀／相容層；**MUST** 只對齊現行契約並刪／取代舊路徑（或 fail-closed 拒舊）。
- **有持有者**：才進入 Compatibility／migration（pointer → `change-consequence-assessment.md`）；可為 dual-read、version bump + fail-closed、或 `[BREAKING]`——本節不規定選哪種，只規定「無持有者不准開這條工」。

**刻意排除**（≠ 舊版雙讀禁令）：

- **Forward-compat**（舊 parser 忽略未知 key）不在本禁令內。
- **Trust-boundary／security／data-loss guardrails** 不可因「簡化」刪掉（沿用 Simplicity Ladder 護欄）。
- **已有持有者的 immutable legacy 唯讀**不算「無持有者多餘相容」；若舊格式從未離開開發者本機／測試，不得用「內部控制面慣例」合理化雙路徑。

他檔（consequence／ambiguity／rationalizations）**MUST** 只以本節名 pointer，**MUST NOT** 重列上方三條件全文。

### Simplicity Ladder

開工前先停在第一個成立的簡化 rung；不要用「未來擴充」跳到後面：

1. **不需要存在**：需求可刪或延後 → 不做。
2. **標準庫 / 內建命令可做**：優先用 stdlib、git/gh 官方 flag、runtime 內建能力。
3. **平台原生可做**：瀏覽器、資料庫、框架既有行為可承擔 → 不加自製層。
4. **已安裝依賴可做**：用既有依賴；新增/升級套件仍走 `third-party-packages-licensing.md`。
5. **單點最小碼可做**：優先直接實作；若明確隱藏當前的複雜度／政策／協定，可保留邊界，不等待假想重用。
6. **最後才加 abstraction / config / fallback**：需在 proposal 或 code review evidence 中說明必要性。

**不可被簡化刪除的 guardrails**：trust-boundary validation、data-loss prevention、security、accessibility、correctness checks。簡化是減少非必要表面積，不是降低安全或驗證。

### Bounded Shortcut Evidence

若選擇有已知 ceiling 的簡單做法，必須記錄三件事：`ceiling`（何時會不夠）、`upgrade trigger`（什麼訊號出現才升級）、`carrier`（proposal / PR body / code comment / issue）。只有維護者在讀局部程式碼時會誤判風險，才在 code 加短註解；一般情況放 proposal 或 PR body，避免註解噪音。

### Preparatory Refactoring（為新功能鋪路）

**向後看 vs 向前看**：`code-simplification.md` 的簡化 pass 是**向後看**——清理既有程式碼，讓讀 code 的人更快理解現狀。Preparatory refactoring 是**向前看**——為**即將加入的特定新功能**鋪路，讓功能改動本身變 trivial。兩者互補，但觸發點不同。

**核心原則**：Kent Beck「make the change easy (warning: this may be hard), then make the easy change」——先把結構調整好，使後續功能改動簡單且低風險。

**Two-Hats 紀律**：

| 帽子 | 行為特徵 | 風險 |
|---|---|---|
| 重構帽 | 只移動結構、不改行為、測試常綠 | 低（行為等價，可 rollback） |
| 加功能帽 | 改行為、新增邏輯、高風險 | 高（行為變更，需完整測試） |

**兩頂帽子不可同時戴**：邊重構邊加功能 = 兩種風險疊加，diff 難以 review、也難 rollback。Preparatory refactoring 的目標是讓你**盡量待在重構帽下**，把高風險行為變更壓到最小、最短的 commit 範圍內。

**觸發 precondition（限定避免過度觸發）**：

- **僅當**新功能難以直接塞進既有結構時觸發——非每次實作都要
- 若可乾淨加入，就直接加（Two-Hat 原則本就成立）
- 硬塞會產生耦合 / hack / 大量 diff 混雜時，先停下重構再加功能

**實作流程**：

1. 確認新功能難以乾淨加入（觸發 precondition 成立）
2. 戴上**重構帽**：只移動結構、不改行為，確保測試常綠（per `testing-and-qa.md` 安全網前提）
3. 重構 commit 獨立：`refactor: <scope>`（per `preflight-checklist.md` 點 1 延伸，refactor commit 與 feature commit **必須分開**）
4. 換上**加功能帽**：在已鋪好的結構上加新行為，diff 乾淨、範圍小
5. 功能 commit 獨立：`feat: <scope>`

**Cross-references**：

- `ai-autonomy-root-cause.md` §Root-Cause First：正交對照——二者皆「先想清楚再動」，但領域不同：修 bug 治根因，加 feature 先鋪路

## Exit Criteria

- Over-Design Audit 8 項自檢通過，或每項違反都有論證；若涉及 schema／contract 改版，已套用 `Pre-Ship Contract Dual-Read Ban` holder test
- Simplicity Ladder 已套用；若採有界 shortcut，已留下 Bounded Shortcut Evidence
- 若觸發 Preparatory Refactoring：重構帽 commit 與加功能帽 commit 已分開，且重構後測試常綠
- 無「邊重構邊加功能」混搭 diff（Two-Hats 紀律）
- 新功能改動 diff 乾淨（結構已鋪好，功能改動本身 trivial）

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「先做出來再說，之後再重構」 | 混入行為變更的重構更難 review、更難 rollback；鋪路的成本比事後解開耦合低 |
| 「這個重構不大，同 commit 沒關係」 | 兩種風險疊加讓 reviewer 難以判斷哪段是行為變更；分 commit 是 O(1) 成本，不分是 O(N) review 成本 |
| 「不需要 preparatory refactoring，直接加就好」 | 若可直接加——對，不需要；precondition 是「難以直接塞入」，不是每次都要 |
| 「沒有測試，重構也不會壞」 | 無安全網的重構是盲飛；先補 characterization test 再重構，否則停下回報 |
| 「這只是簡化，所以驗證也能省」 | trust-boundary / data-loss / security / accessibility / correctness guardrails 不是簡化候選。 |

## Verification

```bash
# Over-Design Audit：無 8 項違反（含 Pre-Ship Contract Dual-Read Ban）
# （人工自檢，確認每項 audit 通過或有論證）

rg -nF 'Pre-Ship Contract Dual-Read Ban' .devpro/agent-rules/pre-implementation-over-design.md
rg -nF 'eight over-design patterns' openspec/specs/openspec-flow/spec.md
rg -nF 'Pre-Ship Contract Dual-Read Ban' .devpro/agent-rules/change-consequence-assessment.md .devpro/agent-rules/ambiguity-scoring.md .devpro/agent-rules/ai-autonomy-rationalizations.md
node --test .devpro/scripts/tests/pre-implementation-over-design-grep.test.mjs

# Preparatory Refactoring：重構帽 commit 獨立
git log --oneline -5
# 預期看到：refactor: <scope>（獨立 commit）
# 後接：feat: <scope>（行為變更 commit）

# 重構後測試常綠（依專案約定）
# （見 testing-and-qa.md）
```
