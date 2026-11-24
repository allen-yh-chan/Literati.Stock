---
name: program-planning-state
description: Consumer program-shaped work 的規劃態承載——目的地、還講不清的部分、不做的部分、卡關關係與認領判定（external-tracker / local-md 對稱）。觸發：program tracker mode 已定，需記錄或更新這四個規劃態語意時。
---
# Program 規劃態（consumer program-shaped work）
> Load-chain：本檔由 `program-tracker-mode.md` 按需載入；tracker mechanics（discovery / dashboard / completion / fail-closed）在該檔，規劃態語意在此。

### 既有 Program 的過渡（不 backfill）

既有 program（尚無下列任一新段或新欄，含 dashboard 新增的 `Blocked-by` 欄）MUST NOT 被要求一次性回填。補寫時機綁下一次 `program-tracker-mode.md` update gate（PR 前）：執行該 gate 時，若該 program 缺任一新段或新欄，MUST 當場建立（create-on-demand）再更新；本案生效前已收尾的 program 不追溯。

### Program 目的地

**external-tracker**：Parent Program Issue body MUST 含「目的地」欄，1-2 行寫清楚做到什麼狀態這個 program 就算結束。

**local-md**：`program.md` MUST 含「目的地」段，1-2 行寫清楚做到什麼狀態這個 program 就算結束。

**與 `program-level requirements` 的分工**：`program-tracker-mode.md` §Local-MD Program Tracking 既有的 `program-level requirements` 答的是**要滿足什麼**（條件清單）；本段「目的地」答的是**到什麼狀態就收工**（終止條件）。條件全部滿足不等於該收工——只有目的地能回答還要不要開下一個 phase，兩者不得互相取代。

**external-tracker**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

**local-md**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

### Program 還講不清的部分

**external-tracker**：Parent Program Issue body MUST 含「還講不清的部分」段，記錄已知會影響 program、但現在講不清的不確定點；可空。

**local-md**：`program.md` MUST 含「還講不清的部分」段，語意同上；可空。

只有不確定點本身就是「要交付什麼」或「怎樣算完成」的項目才進本段；兩者都已能一句話說清、只剩做法或整合邊界要選（即使該選擇跨多個未來 phase）者不屬本段，該選擇是當下就可以開的那個 phase 自己 `design.md` 的決策。

上列三題是**畢業門檻**，不是收容條件；能不能進本段看收容邊界。

畢業門檻（三題全過才算講清楚）：
1. 做完什麼算完成（可驗收）？
2. 觸及哪些 path / system？
3. 依賴哪些已完成 phase？

講清楚即畢業，落點只有兩處：有可出貨 diff → 落到新開 phase row 的識別欄位（local-md：dashboard `Phase` 欄；external-tracker：sub-issue title）；無可出貨 diff 的純決策 → 落到「Program 目的地」段。

`Completion summary` 於該 phase 收尾才回填，不是畢業落點。

**external-tracker**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

**local-md**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

**Completion（program 收尾時 MUST）**：本段 MUST 為空；若非空，每一條殘留項目 MUST 標明處置，僅限三選一：**畢業**（已講清楚，依上列落點規則寫入後刪除該條）、**併入不做的部分**（決定永遠不做，移入「Program 不做的部分」段）、**移交後續 program**（仍不清楚但不屬本 program，記錄接手 program key 後刪除該條）。未標處置的殘留條目 MUST 沿用既有 fail-closed（`program-tracker-mode.md` §Issue-first Program Tracking 與 §Local-MD Program Tracking 的 Fail closed 條），不新增第二套失敗模式。

### Program 不做的部分

**external-tracker**：Parent Program Issue body MUST 含「不做的部分」段，標定為 **program 層**（跨全部 phase 的永久排除），必填。

**local-md**：`program.md` MUST 含「不做的部分」段，語意同上，必填。

**層級分工（避免第四套平行概念）**：

- `design-template.md` `## Goals / Non-Goals`：design（施工圖）層 —— 單一 change 的技術設計不處理什麼。
- `ambiguity-scoring.md` 的 `## Non-goals` / `## Decision Boundaries`：change（brd）層 —— 單一 change 的需求邊界。
- `platform-migration.md` §Program Issue / Phase Tracking 的 sub-issue「非目標」欄：phase 層 —— 單一 phase 的範圍反面。
- 本段（新增）：**program 層** —— 跨全部 phase 的永久排除；前三者皆非 program 層，這正是本段補的缺口。

**不畢業**：既有 phase 若事後發現超出目的地，MUST 關閉該 phase 並在本段留一行說明＋連結；不列進完成紀錄。

**external-tracker**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

**local-md**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

### 卡關關係與認領判定

**external-tracker**：GitHub native issue dependency（`blocked_by`）為 SSOT；讀寫路徑一律 `gh api`（**非** `gh issue view`）。native dependency 任一操作不可用（讀不到或寫不進）時，MUST 無條件 fallback 到 phase sub-issue body 慣例欄位 `Blocked-by:`，值為 **phase key**（如 `P3`），MUST NOT 用 `#<n>`，避免 timeline 污染。

**local-md**：`program.md` dashboard 新增 `Blocked-by` 欄，值為 phase key 純文字；空＝無阻塞。

**認領判定（event-based，無 TTL）**：program dashboard row／sub-issue 的認領有效性比照 `session-pending-lifecycle.md` 的三序（merged / in-flight / stale）事件式判定；判定細則見該檔，本檔不重複列出。若仍保留 GitHub assignee 提及，assignee 不是 SSOT，失效判定一律以 branch/PR 存在為準。

**external-tracker**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。

**local-md**：本節條款於 `program-tracker-mode.md` 的 update gate（PR 前）與 completion 執行。
