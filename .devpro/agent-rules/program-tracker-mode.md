---
name: program-tracker-mode
description: Consumer program-shaped work 的 tracker mechanics（external-tracker / local-md mode、Issue-first discovery、dashboard、completion、fail-closed）。觸發：consumer repo 需求呈 program 形狀、需 discovery/bootstrap/update Program tracker 時。
---
# Program Tracker Mode（consumer program-shaped work）
> Load-chain：本檔由 `openspec-flow-consumer.md` 按需載入；entry leaf 只保留 consumer rules-sync 防污染 + capability workflow，program tracker 細則在此。

### Program Tracker Mode（external-tracker default / local-md）

program-shaped work 的 canonical tracker 有兩個 mode；**default `external-tracker`**，使用者明確選擇才用 `local-md`。兩 mode 的 discovery / update gate / completion / fail-closed 結構一致，只換承載媒介。兩 mode 的目的地、還講不清的部分、不做的部分、卡關關係、認領判定見 `program-planning-state.md`，掛同一組 update gate / completion。

**Mode 解析（per-program presence 推斷，無顯式宣告開關）**：mode 是 **per-program**，非 repo-level；同一 consumer repo 可同時存在 external-tracker programs（Program Issue）與 local-md programs（`program.md`）。解析的對象是「**當前需求所屬的 program**」，不是「repo 是否存在任何 program.md」。

- **Discovery MUST 同時掃兩邊**：搜 active Program Issue（external 候選）+ 掃 `openspec/programs/<program-key>/program.md` active programs（local-md 候選），用 routing hints / prompt keyword / 初步 touch scope 比對找出當前需求所屬 program。
- 命中唯一 external program → 該 program 走 `external-tracker`（依下方 Issue-first Program Tracking）。
- 命中唯一 local-md program → 該 program 走 `local-md`（依下方 Local-MD Program Tracking，讀該檔 dashboard）。
- **不相關的 program.md 不得抑制 external discovery**：repo 存在與當前需求無關的 local-md program.md 時，MUST 仍搜 active Program Issue；mode 由所屬 program 決定，非由任何 program.md 的存在決定。
- **歧義即停**：同時命中多個候選、跨 external/local-md 無法判斷所屬、或多個 program.md/Issue 都疑似相關時，MUST stop and ask 使用者本 change 屬哪個 program；禁止默默推斷。
- 兩邊皆無命中且需求 program-shaped → 進 Bootstrap 選 mode（見下）。

**Bootstrap 選 mode（MUST stop and ask）**：找不到 active Program Issue 也無 `openspec/programs/` active program 但符合 program-shaped 條件時，AI MUST stop and ask before creating any tracker artifact，詢問採 `external-tracker`（GitHub Issue）或 `local-md`（repo 內 `program.md`）。使用者明確選定後才建對應 artifact；禁止默默推斷 mode。external-tracker 分支見下方 Issue-first Program Tracking；local-md 分支見下方 Local-MD Program Tracking。

### Issue-first Program Tracking

**Program-shaped 觸發條件**：符合任一項即進 gate：跨多 PR / OpenSpec changes；多 phase；跨 release / sprint / 多天；同時影響 runtime、frontend、Docker、CI、DB；有 backlog / dependency / blocker；或使用者說 migration / program / roadmap / phase / long-running。

**Discovery（planning / implementation 前 MUST）**：

1. 搜尋 active Program Issue：`is:issue label:type:program label:program:active <keywords>`；已知 key 時 SHOULD 加 `label:program:<program-key>`。
2. 讀取候選 issue 的 `## Routing Hints`：`Aliases`、`Keywords`、`Owned Paths`、`Affected Systems`。
3. 用 prompt keyword + 初步 touch scope 比對；命中時 MUST read parent issue、relevant sub-issues、blocking dependencies、Project fields（若有）。
4. 不確定是否命中時，停下問使用者「本 change 是否屬於 #<program-issue> program？」；禁止默默套用或默默跳過。

**Bootstrap**：找不到 active Program Issue 但符合 program-shaped 條件時，AI MUST stop and ask before creating external artifacts. 回覆提供證據、建議 title、program key、labels（至少 `type:program`、`program:active`、`program:<program-key>`）與 body draft；使用者明確要求後才建 issue。

**Canonical tracker**：parent Program Issue 是 live state SSOT；sub-issues 表 phase / sub-change；Project / milestone / Discussion 只作 view、release bucket、narrative。Jira / Linear 等須有 stable URL/ID、AI 可讀 CLI/API、`active|completed|superseded` lifecycle、PR/phase/archive links。一般（非 program-shaped）change 的 release-target milestone 契約（`<YYYYMMDD>`：最早目標輪、掛載與 `unassigned` 收斂）見 `release-sit-uat-pat-prod.md` §Subset selection handoff；program-shaped 的 view 用法不變。

**GitHub Issues list identity（MUST）**：native sub-issue 仍是一般 issue；title / labels MUST 讓 parent 與 phase 一眼可辨識。

- Parent title MUST 用 `Program：<short-title>`；labels MUST 含 `type:program`、`program:active`、`program:<program-key>`。
- Phase/sub-change title MUST 用 `Sub-issue：P<N>：<short-title>`；SHOULD 保持短，不把完整 program 名塞進 title。
- Phase/sub-change labels MUST 含 `type:phase`、`program:phase`、與 parent 相同的 `program:<program-key>`。
- `type:phase` 標 issue kind；`program:phase` 標 program role / filter；兩者 MUST 保留，避免型別與流程角色混用。
- `<program-key>` SHOULD 用 lowercase kebab-case（例：`program:platform-migration`），供 list filter / 歸屬辨識，不取代 native relation。
- 看 parent / 一般工作項建議 filter：`is:issue is:open -label:program:phase`；看某 program 全部項目：`is:issue is:open label:program:<program-key>`；只看某 program phase：`is:issue is:open label:program:phase label:program:<program-key>`。

**Native sub-issue relation（MUST；禁止 markdown duplicate）**：phase/sub-change MUST 透過 GitHub native sub-issue relationship 關聯 parent，不靠 markdown mention。Phase body MUST NOT 寫 parent number / mention / URL（例：`Parent Program Issue: #123`、`owner/repo#123`、GitHub issue URL），避免 parent timeline 同時出現 cross-reference 與 `added sub-issues`。歸屬看 title + labels + native relation。

**Parent dashboard（MUST）**：Parent body MUST 保留最新 phase dashboard：sub-issues、PR、OpenSpec active/archive path、狀態、風險、完成摘要。驗證資訊只放 validation evidence index（連到 phase sub-issue、PR body、OpenSpec active/archive path）；完整 phase gate / validation command output 的 SSOT 是 phase sub-issue、PR body、OpenSpec archive。最後總結看 parent body，不看 comments。Comments SHOULD 只作必要 audit log；MUST NOT 為「歷程記錄」或 routine phase completion 補重複 comment。只有 blocker、scope/order decision、重要 audit event 才寫 parent comment。

**Update gate（PR 前 MUST）**：本 phase PR 若改變 program state，PR 前 MUST update parent issue body dashboard / sub-issue / project fields，並在 PR body 連結 program issue。短命 phase branch、每 phase PR merge 前 archive OpenSpec change、release subset 原則不變。

**Deferred sibling live carrier（#2492）**：本 phase／change scope-split 並 defer 另一 phase／sibling 時，MUST 在 parent Program Issue 留下 live Backlog／phase dashboard row 或 native sub-issue（不得只寫在 closing OpenSpec change 的 Non-goals）。local-md 對等：MUST 更新 `program.md` dashboard row。非 program-shaped 則至少用 `notes/session-pending.md` H2（見 `session-pending-lifecycle.md`）。

**Completion**：最後 phase 合併時 close parent issue 或標 `program:completed` / `program:superseded`，填 completion PR 與 final archive path。後續 discovery 只搜尋 `program:active`；completed issue 不再自動命中，除非使用者明確提 issue number、要求 reopen/supersede、或本次變更會修改完成後的穩態 contract。

**Duplicate timeline recovery（SHOULD / FAIL CLOSED）**：timeline events 無法刪除；誤用 parent mention 產生多餘 cross-reference 時 SHOULD 評估重建。重建 MUST：建新 parent 複製 dashboard、移轉 native sub-issues、確認新 timeline 只有必要事件、移除舊 parent `program:active`、關閉舊 parent 並標 superseded/not planned、確保 discovery 只會命中新 parent。無法確認 active tracker 唯一性 → FAIL CLOSED。

**Boundary**：consumer repo 不得修改 `AGENTS.md` 承載 repo-specific program 規則（synced `AGENTS.md` 仍禁手改）；source repo 不得寫入 consumer-specific migration 規則。Program live state 走 Program Issue；其他 consumer 自訂規範合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。Program Issue tracking 取代任何 repo-local markdown live progress tracker；不得要求 consumer repo 只為追蹤 long-running program 建 `openspec/specs/<capability>/spec.md`。

**Fail closed**：tracker 無權限、搜尋不可用、或 issue body 缺 routing hints 且 AI 無法判斷時，停止並要求使用者提供可讀 tracker 或確認降級為單一短命 OpenSpec change。

### Local-MD Program Tracking（local-md mode）

使用者於 bootstrap 明確選 `local-md` 時適用。canonical tracker 為 `openspec/programs/<program-key>/program.md`（repo 內、版本控管）。

**program.md 內容邊界（MUST）**：只放 program-level requirements、cross-phase invariants、phase dashboard 表格。**MUST NOT** 複製 phase BRD；phase 詳細需求仍在 `openspec/changes/<phase>/brd.md`。

**Phase dashboard 表格（取代 native sub-issue）**：`program.md` MUST 含 phase dashboard 表，欄位至少：Phase、OpenSpec change path、PR、Status、Risk、Completion summary、Blocked-by。`program.md` 是唯一 live SSOT；MUST NOT 設 per-phase pointer 檔。歸屬看 dashboard row + OpenSpec change path。

**Update gate（PR 前 MUST）**：phase PR 若改變 program state，PR 前 MUST update `program.md` dashboard row（改檔 + commit），PR body MUST 連 `program.md` path。短命 phase branch、每 phase PR merge 前 archive OpenSpec change、release subset 原則不變。Deferred sibling live carrier（#2492）同 external-tracker：deferred sibling MUST 有 dashboard row，禁只留 Non-goals。

**Completion**：最後 phase 合併時，archive 整個 program 到 `openspec/programs/archive/<YYYY-MM-DD>-<program-key>/`，並在 `program.md` 標完成（status `completed` / `superseded`）。後續 discovery 不再命中已 archive program，除非使用者明確指名或本次變更修改完成後穩態 contract。

**Fail closed**：`program.md` 不可讀、缺必要 dashboard 結構、或 AI 無法判斷歸屬時，停止並要求使用者修復 `program.md` 或確認降級為單一短命 OpenSpec change。

**Boundary**：local-md 僅供 consumer repo；source repo 不適用。`program.md` 取代任何 repo-local markdown live progress tracker；不得要求 consumer repo 只為追蹤 program 建 `openspec/specs/<capability>/spec.md`。consumer repo 不得修改 `AGENTS.md` 承載 repo-specific program 規則（synced `AGENTS.md` 仍禁手改）；其他 consumer 自訂規範合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。
