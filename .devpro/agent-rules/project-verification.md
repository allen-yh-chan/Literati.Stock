---
name: project-verification
description: "產品驗證入口與功能地圖：建立、執行、維護及失敗分流。觸發：要求建立可交接驗證入口、執行既有產品驗證或維護過期操作指引時。"
---

# Project Verification

## Overview

把產品的真實操作與證據做成下一個 agent 可重跑的專案入口。這是產品功能驗證，不是 Devpro adoption doctor；也不以 build／health check 取代功能結果。

## When to Use

- 使用者要求建立共用產品驗證入口、功能地圖，或接手既有入口執行驗證。
- 產品改動後，使用者要求更新過期的操作指引或驗證 harness。
- 只問 consumer rules adoption 健康度時使用既有 consumer-doctor，不啟動本流程。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A；現有安全／授權閘仍適用 |
| Advisory | N/A |
| Doctrine | cooperative-only：routing、覆蓋、故障分類及證據品質須由執行者按實際產物判斷 |

### 選擇模式與入口

模式為 `setup`（建立）、`run`（執行）、`maintain`（維護）；明示模式優先。自然語言依使用者目的對應；僅要求驗證則走 run，目的不明先釐清。

先讀專案指向的 runbook、README、技術棧及現有 harness。優先復用唯一既有入口；多個候選無明確指向時確認目標，不猜。run／maintain 無入口時回報 NOT_VERIFIED 並指出 setup，不擅自改走建立。

setup 沒有既有載體時預設 `docs/verification/README.md` 和同目錄功能地圖；有既有載體就沿用，不另造平行 skill／清單。setup／maintain 在專案入口加可發現 pointer。文件與 helpers 屬專案，不寫進同步管理的 Devpro 規範目錄。

### 可執行的產品入口

從實際專案查明下列內容；交付不能留待猜的命令或 placeholder。憑證只指向取得方式，不收集或保存 secret。

| 部分 | 內容 |
|---|---|
| Launch | 冷啟動命令、必要資料／migration、可使用的 ready 訊號；短命 CLI 依既有 build／獨立 invocation 操作 |
| Doctor | 驅動前確認 instance、build／version、必要權限和資源所有權；異常後重驗，健康不代表功能通過 |
| Drive | 復用真實 harness／命令／穩定控制點，使用隔離資料；不以內部 setter 代替使用者路徑 |
| Evidence | 記輸入、動作、可觀察結果及檔案／儲存等副作用，具名保存位置與取得命令 |
| Cleanup | 只清理本次啟動／建立的 instance 和暫存資源；失敗也清理，證據保留並再次確認存在 |

功能地圖連結每個納入功能的使用者入口、前置條件、驅動方法與成功結果。setup 可先建有界範圍，但要列未映射功能；不得把單一路徑成功說成全產品覆蓋。helpers 只有實際需要時新增，須能執行並由入口列出 invocation。

### 各模式的操作與寫入邊界

| 模式 | 操作及完成條件 |
|---|---|
| setup | 查明入口／覆蓋、建立或補既有載體；親自循入口完成至少一個功能的 Launch→Doctor→Drive→Evidence→Cleanup，確認證據仍在。未實跑是 draft／NOT_VERIFIED |
| run | 依既有入口驗使用者指定範圍；未指定則驗全部 mapped features。可操作 recipe 範圍內的隔離資料及保存證據；不改產品碼、驗證文件或 helpers |
| maintain | 從契約、相關 source 及改動核對地圖，再實跑全部 mapped features；新發現的使用者入口也列入覆蓋。只修驗證文件／其自有 helpers，修改後重跑受影響流程；不修產品碼 |

維護時分流：文件／命令與已證契約不符為 **doc drift**；產品行為正確但控制方式無法完成為 **harness gap**；實際行為違反契約為 **product regression**。契約不明就標未知，不能只照目前實作改期待結果。工具／權限／環境不足具名回報；不以改產品或降低斷言換取成功。

### 結果與量測

每個功能標 `PASS`（真實結果符合）、`FAIL`（實際觀察到產品違反契約）、`NOT_VERIFIED`（未能完成，附缺口）。整體只有指定範圍全部 PASS 才能宣稱通過；混合結果逐項保留。記實際操作、證據、覆蓋／未覆蓋、文件修正與下一個安全動作，不把建議寫成已執行。

產品驗證的效能比較依 `performance-investigation.md`：核對正確輸出、成功／錯誤數、計時區間內實際完成的工作、可比設定、變異與端到端意義；不足回報 inconclusive，不判 faster／slower。單次估算須明示，不套固定重跑次數或 OS 指令，不以過載主機數字作決策；共同實驗閉環不在此重述。

## Exit Criteria

- 有唯一可發現、無 placeholder 的入口及明示功能覆蓋；只主張實際跑過的範圍。
- 模式寫入邊界、產品契約及原有授權均保留；故障分流有具體證據。
- 本次資源已清理，證據仍存在；未能驗證的功能沒有被標成 PASS。

## Common Rationalizations

| 藉口 | 回應 |
|---|---|
| 「build／doctor 綠了」 | 仍須驅動功能並查結果 |
| 「更新測試期待就能通過」 | 先判契約與故障種類；maintain 不改產品或掩蓋 regression |
| 「建立入口就算交付」 | 未親自跑通的入口是 draft |

## Verification

source 分發：`node .devpro/scripts/lint-agent-skills.mjs`。行為驗收：在隔離專案依 setup→run→maintain 操作，注入文件漂移、工具缺口、產品故障；檢查寫入範圍、觀察結果及清理後證據，不能用 anchor presence 代替。
