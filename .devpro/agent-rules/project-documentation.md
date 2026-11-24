---
name: project-documentation
description: "架構／模組文件建立與雙向 drift 盤點。觸發：要求整理指定專案／模組文件，或比較文件與實作落差時。"
---

# Project Documentation

## Overview

為指定 repo／模組建立可追溯的現況說明，或雙向盤點文件與實作落差。預期行為由 canonical specs 擁有；本流程解釋現況、入口與流程，不另立契約，也不以靜態盤點宣稱產品驗證通過。入口為 `devpro:project-docs`。

## When to Use

- 使用者要求整理指定專案／模組的架構、責任、資料流或模組文件：`build`。
- 使用者要求檢查文件與實作落差，或找出未記錄的重要行為：`drift`。
- 功能實跑、驗證 runbook／harness 的操作性修正交給 `project-verification.md` 與 `devpro:project-verify`；adoption 健康檢查交給 consumer-doctor。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A；既有安全、授權與寫入閘仍適用 |
| Advisory | N/A |
| Doctrine | cooperative-only：證據充分度、文件語意、drift 分類及寫入邊界由執行者依實際讀取與產物判斷；結構 lint 不證明遵循 |

### 模式、範圍與權威

明示模式優先，自然語言依目的路由；模式或 repo／模組範圍不明先釐清，不默認整庫執行。先讀專案入口辨識文件；多個架構／模組文件候選且沒有唯一明確入口時，先釐清目標，不選第一個或自行合併。模式、範圍與入口已清楚就直接執行。

依 `intent-lookup-order.md` 先查指定範圍的 canonical specs，再讀相關實作、測試與文件。無 spec 時明示 `no canonical OpenSpec spec found`；從程式、測試或其他材料所得敘述標 `observed`／`inferred`，不得自動提升為 intended contract。spec 與 code 矛盾時保留兩邊證據及未知，不藉生成文件裁定正確方或改寫契約。未合併設計不當成現行契約。

### build：從模組向上整理

復用唯一明確的既有架構／模組文件入口；沒有既有載體時預設 `docs/architecture/README.md`。先查契約，再由底層模組向上彙整，不從高層猜測填滿細節。逐個納入模組整理用途、入口、介面、不變量與 owner、資料流、重要副作用、失敗路徑及驗證方式，再說明模組間關係。

重要敘述附契約連結或實際檔案／symbol 證據，區分觀察、推論、未知與未覆蓋範圍；尚未辨識的 owner 明示待指定。重跑更新原載體，不建立第二套文件；無法確認的舊敘述標待釐清，不直接以現碼覆蓋。

只更新所選架構／模組文件及必要的專案發現入口，不改產品碼、specs 或驗證 harness。若同一文件也有驗證操作段落，維持段落責任：操作性修正轉交 `project-verify maintain`，不另複製一份 runbook。

### drift：雙向盤點與報告

有 canonical spec、架構文件或相關 README 任一種即可作比較基準；全部缺少時回報「drift 未執行：無可比文件」，指向 build，不自行建檔，不套用產品驗證 PASS／FAIL。

雙向比較文件宣稱與實作觀察，也找出文件未提及的重要對外行為、資料／安全不變量、重要副作用及責任邊界；普通 helper 不要求全部文件化。依證據分類：

| 分類 | 判定與下一步 |
|---|---|
| 文件過期 | 有足夠契約／決策證據支持更新文件；指出待補段落 |
| 實作偏差 | 觀察與可適用契約不符；提出待確認／驗證的實作問題，不宣稱已證產品 regression |
| 已核准變更未反映 | 引用使用者明示決策，或含可核對核准證據的 change／PR／issue，標適用範圍與階段，再指出缺少的反映 |
| 未記錄的重要行為 | 記錄重要但未被文件涵蓋的觀察；分類後再決定補文件、修實作或保留細節，不自動視為 bug |
| 證據不足 | 契約、核准或適用性無法核對；列待釐清與需要的證據 |

active delta／issue 的存在本身不是核准證據；未生效設計不作現行契約。無 canonical OpenSpec 的專案可引用已知決策，但不能宣稱已有 canonical contract。保留 EGM 發現未記錄邏輯的能力，經上述分類才決定處置。

每項報告包含宣稱／觀察、證據、影響、owner 或待指定 owner、下一步；另列比較範圍、未覆蓋與未知。需要實跑確認者交給既有驗證流程，不輸出產品驗證 PASS。

### 寫入與交付

drift 預設只回覆 Markdown 報告；只有使用者明示要求存檔才寫報告檔，仍不修改受檢文件或程式。明示存檔而未指定位置時，預設專案自有 `docs/architecture/reports/drift-<UTC時間戳>-<短唯一碼>.md`，每次使用唯一檔名。指定位置也須是專案自有報告位置，不得寫進同步管理的 Devpro 規範／skill 目錄或 canonical specs；不合規目的地先釐清合法位置。

交付模式、範圍、實際讀取依據、建立／更新／保存位置、未覆蓋與下一步。未實跑即說明靜態盤點；不把計畫寫成已完成驗證。

## Exit Criteria

- 模式、範圍及文件入口明確，已先查契約，重要敘述可回查證據與狀態。
- build 復用原載體且只改授權文件／必要入口；驗證操作段落交由原流程。
- drift 完成雙向盤點、分類與下一步，或明示無可比文件而未執行；僅在明示存檔時寫入合法的專案報告位置。
- 未將現碼、未核准／未生效 delta 或缺文升格為契約、核准決策或產品故障。

## Common Rationalizations

| 藉口 | 回應 |
|---|---|
| 「從 code 生成就是正確設計」 | 先查 spec；現況只支持 observed／inferred，矛盾須保留 |
| 「drift 順手修一下比較快」 | 報告與修復分開；drift 不改受檢內容 |
| 「issue／delta 已存在，所以已核准」 | 必須核對明示決策、核准證據、適用範圍與階段 |
| 「每個 helper 沒寫都是 bug」 | 反向盤點聚焦重要行為；缺文先分類再決定處置 |

## Verification

分發與結構：`node .devpro/scripts/lint-agent-skills.mjs`。行為驗證使用有界專案材料覆蓋無 spec、契約矛盾、重跑、多入口、無可比文件、雙向 drift、核准證據與存檔邊界；記實際 reads／decisions／artifacts 及未測範圍，不能以 anchor presence 代替。功能實跑仍依 `project-verification.md`。
