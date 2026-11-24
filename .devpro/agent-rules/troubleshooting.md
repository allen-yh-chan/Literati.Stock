---
name: troubleshooting
description: 偵錯強制順序（log → refs → unit/e2e → 其他）與 state detection 設計步驟；觸發：自家程式測試不通過、非預期行為、使用者回報問題或貼出錯誤訊息時。
---

# Troubleshooting（偵錯優先順序）

## Overview

排查問題**必須**依固定順序取得資訊，禁止顛倒或跳過。順序：**1) Log → 2) Refs → 3) Unit/E2E 閉環 → 4) 其他**。根因未明確前禁止大改程式或架構。偵錯既有 bug 走強制順序；設計新的 state detection 邏輯走「寫條件前強制步驟」。

Root-cause debugging 採 6 步短閉環：Capture → Isolate → Hypothesize → Test → Fix → Verify。非 trivial 問題交付時必須能用一句話說明 root cause，並列出證據與驗證方式。

## When to Use

- 自家程式 runtime 錯誤、測試不通過、非預期行為時
- 使用者回報問題或貼出錯誤訊息時

> build / CI/CD pipeline 失敗是世界共通的工程偵錯（讀 build/CI log、查版本、重跑），AI 已具備，不需本規範教；本 leaf 聚焦「自家程式」的偵錯紀律與 state detection 設計。底層方法（log→refs→測試閉環、root-cause 6 步）仍可套用於任何偵錯場景。

## Process

效能異常先保留本節診斷證據；準備量測比較或做改善時依 `performance-investigation.md` 的有效 workload 與假設閉環，不用未核對的速度數字作修補理由。

### 強制順序

**1) Log（最優先）**

必須先取得並閱讀與本次情境直接相關的 log：應用程式 log、Web server、容器、**CI job log**、DB 診斷、瀏覽器 DevTools（Console / Network）。**禁止**在未讀 log（或確認無可讀 log）之前，憑臆測大改程式或架構。

**2) Refs（次優先）**

有 log 上下文後，查：官方文件、framework/SDK **release notes**（對齊當前版本）、API 參考、stack trace 指向的型別/方法文件、專案 README/ADR、**開源上游原始碼**（對齊 lockfile 所指 revision）。**禁止**跳過版本對應文件而以未核對的二手來源為唯一依據。

**3) Unit / E2E 測試閉環**

執行專案約定測試指令（依 `testing-and-qa.md` 表），以**失敗重現 → 修正 → 重跑**閉環偵錯，直至相關測試通過。**禁止**未重跑受影響測試即宣告修復完成。

**4) 其他（最後）**

程式碼追蹤、手動最小重現、逐步刪減、社群搜尋等，須在 1/2/3 已執行且有結論（或已記錄「已嘗試但不可得」）後，再作為主要推進方式。

**CLI／helper 看似卡關時**：在宣稱「無法達成」或深入 static reading 之前，MUST 先用最小合法輸入實測一次（含允許值域邊界如 `null`、required key 但 value 可為 null）。範例：`classify-bounded` 的 `repairDeltaManifestRef`／`dependencyClosureManifestRef` 是 required key、允許 `null`，但 null 只證明輸入合法，null refs 不是 route 探測；rereview 路由判定前先封 manifests（首輪 `previousReceiptRef: null` 兩份 refs MUST 為 `null`）。禁止把「讀程式碼推論出的限制」當成「已驗證過的限制」。

### Root-Cause Debugging 6 步

用於 bug、測試/build/runtime/CI 失敗、效能異常。每步都要有證據，禁止跳到 Fix。

| Step | 要求 |
|---|---|
| Capture | 完整錯誤、stack trace、重現步驟、時間點、相關 log |
| Isolate | 縮小到模組 / 函式 / 邊界；跨系統標出壞資料起點 |
| Hypothesize | 列 1-3 個可能根因，每個都可被工具或測試驗證 |
| Test | 用最小重現、相關測試、log 或版本 refs 驗證假設 |
| Fix | 只做根因最小修復，禁止順手重構無關區域 |
| Verify | 重跑相關測試；若無法測試重現，記錄替代驗證理由 |

測試失敗若呈現 shared fixture / marker-state failure，先用 fresh fixture or isolated marker/state dir 重跑並隔離 state leakage；只在共享狀態重現者先歸為 fixture/setup gap，不得直接命名為產品或 rule behavior root cause。

### Exact-Case Evidence Ledger

**Anchor**：`Evidence Ledger` / `exact-case`

#### 觸發閾值

回報含任一具體 case 識別（error code / endpoint+method / ID / URL / timestamp / data key）→ 命名 root cause **前** MUST 產 Ledger。

**不觸發**：純編譯錯（`bad option: --test` / `build error` 無具體 case）、typo fix、無具體 case 識別的抽象問題描述——避免 over-process。

#### 四要件

1. **Observed facts**：exact error code / endpoint+method / IDs / timestamps / data keys（直接從回報取值；禁止憑記憶 paraphrase）
   - 範例：`HTTP <code> on <method> /<resource>/<field>`；`<data-key>` 欄位值 `<placeholder>`；timestamp `<ts>`
2. **Exact-case reproduction target**：選一種可觀察的重現路徑（service method / endpoint / E2E / DB query / log slice / payload decode path），以重現**同一個 case** 為目標，不是重現「類似問題」
3. **Hypotheses 1-3**：每個假設附一條可執行的 falsification command 或 test
   - 範例：`hypothesis: <resource> validator rejects <field> when <condition>` → `falsification: call /<resource>/validate with payload {<field>: <test-value>} and assert HTTP <expected-code>`
4. **Evidence result**：每個 hypothesis 標記 `confirmed` / `falsified` / `unavailable`（含 unavailable 原因）

#### Ban：static code smell 只能當 hypothesis

exact-case 重現或直接 payload/log evidence **前**，static code smell（「看起來這段邏輯有問題」/ 「這個 pattern 不對」）**只能當 hypothesis 1-3 之一，不能當 root cause**。命名 root cause 需要 confirmed evidence。

#### Red-capable／agent-runnable loop gate

**Anchor**：`red-capable` / `agent-runnable`

在推進未驗證 hypothesis、或命名 **confirmed root cause** 之前，MUST 先有 tight **red-capable／agent-runnable** 迴圈＝可重現失敗的命令／測試／最小 harness（agent 可再跑），非口頭「看起來壞了」。無此迴圈 → **MUST NOT** 把僅敘述性 hypothesis 當成可命名 confirmed root cause 的通過路徑，也 **MUST NOT** 無迴圈推進 hypothesis。本閘疊加 Exact-Case Evidence Ledger；**不取代** exact-case／禁 smell→root-cause。

Checklist 欄位（Debug Report／Evidence Ledger 可記；名稱可 grep）：

| 欄位 | 含義 |
|---|---|
| `loop_command` | 可再跑的失敗命令／測試／harness |
| `loop_red_capable` | 該命令是否再現失敗（red） |
| `loop_agent_runnable` | agent 是否可在授權邊界內再執行 |

`agent-runnable` 的「一條命令」預設＝本機測試／既有 script／只讀診斷；越界（secrets／destructive／未授權 cross_repo／未核准網路外洩）須遵守 `ai-autonomy.md` Ask First／Never——本閘不另發明 command allowlist。

> Load-chain（Post-Intervention Exact-Case Recovery Gate）：對故障中的 runtime／process／environment 做 restart、relaunch、reconnect、reload、reconfigure 或等價 recovery intervention 後，在宣稱 recovered／ready、結束 troubleshooting 或要求使用者重試前，MUST 先讀並執行 `post-intervention-recovery-gate.md`；`Recovery Verification` 四欄與各項 disposition 都在該 leaf，本檔不複寫。

### Debug Report（非 trivial 必填）

交付修復或回報 blocked 時至少包含：

- **Issue**：一句話描述症狀
- **Root Cause**：實際根因，不只描述表面錯誤
- **Evidence**：log / test / diff / ref 的具體證據；若回報含具體 case 識別，須含 exact-case evidence（或明示為何 exact-case evidence unavailable）；貼出的命令／輸出／擷取物先遮蔽憑證（`security-coding.md` §Agent 輸出憑證遮蔽）
- **Fix**：最小修正範圍
- **Verification**：跑了哪些測試或替代驗證

### 寫 state detection 條件前的強制步驟

當需要偵測「state X 已發生」（session 死亡、token 過期、權限變更、資料失效）時：

1. **列舉**：grep 所有會製造 state X 的程式碼入口（寫入點、action/service/middleware）
2. **心算**：對每個入口，模擬執行後所有相關欄位的值（含相依欄位、cookie、session）
3. **驗證**：條件在每個入口執行後是否會 fire；任一路徑不 fire → 條件設計錯誤
4. 任一步驟未完成 → **禁止**交付該條件

## Exit Criteria

- 根因已明確記錄（一句話說明是什麼導致問題）
- 非 trivial 問題已產出 Debug Report 五欄摘要
- 修復已套用且相關測試通過（專案約定測試指令全綠）
- 若無法在測試層重現，已記錄原因與替代驗證方式
- 偵錯過程已記錄：log 結果、查了哪些 refs、跑了哪些測試

## Cross-review harness `gh` write-block

當 harness classifier 擋下 `gh` write 導致 `pr-sticky` 無法發佈 sticky 時，**不得**把 `audit-only` 升格為 merge gate 證據。完整降級 SOP（audit-only cap 3、manual sticky `provenance: manual-publish audit-only`、使用者 terminal 發佈、merge gate remains unsatisfied 直到 verified `pr-sticky` 或 explicit user waiver）見 `.devpro/agent-skills/devpro-reviews/second-review/SKILL.md` §Harness write-block degrade path；PR workflow 驗證段見 `devpro:cross-review` skill §5。

**Path W / stale post-PR**：merge／post-PR 提示 stale waiver，或 merge 與 post-PR 對 stale UNAVAILABLE 的行為不一致時，見 `post-pr-marker-disposition.md` §Path W／stale waiver 排錯。

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「不用看 log，我知道是什麼問題」 | 直覺不是證據，log 才是。1 分鐘讀 log 避免 30 分鐘猜測。 |
| 「文件可以跳過，直接看 code」 | 版本差異是常見根因；跳過 release notes 可能白查 code 半小時。 |
| 「先改再跑測試」 | 改了什麼 → 跑測試 → 看結果，是正確順序；猜了改 → 猜了改是浪費。 |
| 「state detection 條件 80% 情況 cover 就夠」 | 20% 靜默失效 = 使用者卡死且無錯誤訊息，等不到 bug report。 |
| 「我讀過那段 code，知道邏輯」 | 讀過 ≠ 心算每條路徑。寫條件前必須逐路徑驗證。 |

## Verification

```bash
# 確認 log 已讀（CI job log 範例）
gh run view <run-id> --log

# 確認測試閉環
dotnet test   # 或 npm test / pytest / go test ./...

# 確認根因記錄（偵錯紀錄應含以下內容）
# - 嘗試的 log 來源與關鍵訊息
# - 查閱的 refs 與版本
# - 重現測試名稱與結果
# - Debug Report 五欄摘要（非 trivial 問題）
```

讀取 log 和 refs 時，確認不含 PII / 密碼 / token（見 `security-coding.md`）。
