---
name: openspec-archive-redo-undo
description: 已 archive 之後要重做或復原時的流程：Pre-merge Archive Re-do（含 active-missing continuation）、Undo-Archive Preserve Checklist（SSOT）與 check (h) 歷史資料補齊例外。觸發：PR 未 merge 而要改已 archive 的 spec delta、要 undo archive commit（`git reset`／`revert` archive promote）、或 post-merge 同 named change continuation 時。
---

# OpenSpec Archive Re-do 與 Undo

> Load-chain：本檔由 `openspec-archive-principles.md` 的 Pre-merge Archive Re-do 路由段按需載入；首次 archive 不需讀本檔。Re-do 流程、Undo-Archive Preserve Checklist 與 check (h) 例外的權威內容在本檔。

**Pre-merge Archive Re-do / pre-merge re-archive**：
- PR 未 merge 且 spec deltas 因 reviewer feedback 或 `scope-change` 改動時，**禁止**直改 archive spec.md 的 `## MODIFIED`/`## ADDED Requirements` body/scenario。
- 此流程必須維持 same branch/change/PR；requirement scope change先依`openspec-scope-change.md`重跑`dp-analyst -> dp-architect`，B-mini不得bypass；micro-tweak只有不改spec delta/behavior/gate/workflow/merge semantics才可不走re-archive。
- 預設 Procedure：(1) `git revert <archive-commit>` 還原 active folder (2) 更新 active artifacts/decisions trigger `reviewer-rejection` 或 `scope-change` (3) `openspec archive <name> -y` (4) `git push`。
- 若 archive commit 同時 bundled implementation、直接 revert 會撤銷同 change 其他已驗證工作，且 active folder 已不存在，MUST 改走 active-missing continuation：先驗證 source archive完整、destination active不存在、無未知dirty overlap，記錄source tree SHA與relative byte manifest；再以 byte-preserving move 把整個archive folder重建為同名active folder並獨立commit，驗證前後bytes相等後才更新artifacts/deltas與re-archive。
- 任一前置、byte equality或CLI promotion結果不確定即FAIL CLOSED。
- 非spec-delta可直改archive；spec.md首個`## `前的preamble可直改。post-archive review 修復（記帳類）亦直改、不為此 re-archive，carve-out 見 `post-pr-completion-gate.md` §Post-archive 修復落點。
- Gate：check (h)阻擋archive內spec.md drift（preamble-only不計）；check (i)比對`#### Scenario:`標題，未宣告移除→block（`## Removed Scenarios`於proposal/decisions/tasks，issue #722）。

**Undo-Archive Preserve Checklist**（SSOT；undo archive commit／`git reset`／`revert` archive promote 前 MUST 執行。`devpro:pre-pr` 與其他 carrier 只准一句祈使＋pointer，**禁止**複製本 checklist）：

1. **Authority carriers** — 頂層只有兩個：`admission-records/`（**含其下** `codex-reviewer-intents/`；intents 不是頂層第三目錄）與 `override-ledger/`。這些多為 gitignored／worktree-local 權威鏈；**untracked != disposable**。
2. **Expected residue** — 在**無 path collision**時，`git reset --hard`／`revert` **通常不會**移除 gitignored 檔；dated archive leftover（例如 `openspec/changes/archive/<YYYY-MM-DD>-<name>/admission-records/`）是預期行為，不是 undo 失敗證據。**例外／collision**：若 reset／revert 目標會把某個路徑建成 **tracked file**（或其它 tracked 形狀）而蓋掉同路徑上既有的 **untracked／ignored 目錄樹**（例如目標 commit 把 `notes` track 成檔案、工作樹卻有 ignored 的 `notes/…`），該次 reset／revert **可以刪掉**那些 ignored 內容——gitignore alone 不能保證存活。
3. **Preserve-first（條件式備份）** — 預設拆兩步：**（a）毀滅前** — reset／revert archive commit **之前**先做 verified backup（或把 carriers 暫存到不會被該次 reset／clean 刪掉的位置）；**（b）還原後** — undo 完成、active change folder 已還原後，再把 carriers 搬回該 active folder（或從 verified backup 還原進去）。搬回後 MUST 刪除清空的 dated archive 殼目錄（`openspec/changes/archive/<YYYY-MM-DD>-<name>/`）：它只要還在，`classify-bounded`（`resolveRiskChangeRoot`）就因 active 與 archived authority 並存回 `change_folder_invalid`。備份預設路徑（避開易被掃掉的 `tmp`）：`notes/undo-archive-authority-backup/<change-id>-<iso>/`（必須在 managed-gitignored `notes/` 下；不得用 tracked path）。選 in-repo `notes/` 前 MUST 檢查 reset／revert／clean 目標是否會與該備份路徑 **collision**（含 tracked file 名與 ignored 目錄同名、或 pathspec 直接覆蓋）。**當毀滅目標會蓋到備份路徑**：禁止只靠 in-repo `notes/` 備份。Pathspec 收窄 **僅**適用於 `git clean`（及同類支援 pathspec 的 clean）；對 repo-root `git clean -xdf` 等，MUST (i) 收窄 clean pathspec 排除備份路徑，或 (ii) 把 verified backup 放到 **repository 之外**。對 `notes/`／備份目錄的 `rm -rf`：MUST 避開該路徑或改放 repository 之外。對會造成上述 collision、且會蓋到 in-repo 備份路徑的 `git reset --hard`／`revert`：MUST 把 verified backup 放到 **repository 之外**（仍 untracked、不 commit）；**MUST NOT** 宣稱收窄 hard-reset pathspec 是有效 recovery（`git reset --hard` 無法與 pathspec narrowing 配對）。`notes/` 僅在已確認無 collision、且毀滅目標不含該路徑時當預設。
4. **Destruction gate** — 以 carrier **存在**為準（不鎖 dated path／單一指令）。對「含有或可能含有上述 carriers」的任何路徑，執行會移除 ignored／untracked 的指令之前 MUST 先 inventory。明列至少：`rm -rf`、`git clean -x*`（`-xd`／`-xdf`／`-ffdx` 等）、以及不帶 `-x` 但會刪 untracked dir 的 `git clean -d`／`-fd`。
5. **Destruction 例外** — 僅當 (A) inventory 證明 carriers 不存在，或 (B) verified backup 存在（存在、非空、inventory 相符、且位於 reset／clean 目標路徑之外，並遵守 item 3 條件）。**明示使用者授權對 (A)(B) 兩分支都必填**；僅 inventory-absent 不足以授權刪除。
6. **若已毀損** — 視為 authority destroyed → 必須 fresh full reopen。MUST NOT rebuild／backfill／forge admission records／claims／intents 假裝舊鏈還在。MUST NOT 宣稱先前 receipts 仍是 seal-final／lineage 權威。
7. **Dead-receipt quarantine**（散文 only；本契約不改 `latestReceipt` 選取邏輯）— reopen 後把 higher-round 死 receipts 從 flat `notes/` root 移到 `notes/quarantine-dead-receipts/<change-id>/`。現況依據：`.devpro/scripts/lib/review-remediation-evidence-core.mjs` 的 `listReceiptCandidates` 對 `notesRoot` 做**非遞迴** `readdirSync`（只看 root 檔名），故子目錄 quarantine 在掃描外。不得與 item 3 備份路徑重疊。quarantine ≠ 刪 authority 檔。若要改 receipt scan code → 另開 change。

Check (h)另有一個**只供歷史資料補齊辨識、不是author workflow授權**的窄例外：只有single-parent commit、archive path在parent已存在、path status恰為`M`、恰一個pure-add hunk，且新增內容恰為一個完整`## MODIFIED Requirements` Requirement block（最多一個相鄰空白行），該title在parent不存在、在post archive與同commit canonical各自唯一，且兩邊raw bytes完全相同時，才不把該commit計為archive-only。Git讀取、UTF-8、唯一性、完整性或同SHA canonical驗證任一失敗，MUST回落為archive-only；正常行為變更仍一律走reopen/re-archive，禁止以此classifier合理化直改archive。
