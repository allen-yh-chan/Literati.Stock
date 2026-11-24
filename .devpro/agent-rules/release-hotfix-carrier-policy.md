---
name: release-hotfix-carrier-policy
description: Hotfix release-carrier lane 的 normative 條款 SSOT：N1–N5 不變式、review-binding 格式、artifact 狀態機、milestone inert、verified already-live backfill、bump 起點、bugfix／hotfix 升降級、cutover／grandfather。觸發：執行或審查 hotfix／rollback／already-live backfill 上線，或需查 hotfix-review-binding 格式時。
---

# Hotfix Release-Carrier Lane Policy

> Load-chain：本檔由 `release-sit-uat-pat-prod.md` §Hotfix Release-Carrier Lane 按需載入（`post-pr-completion-gate.md` 審 hotfix PR 時亦載入 hotfix unit sticky 條）；逐步執行 recipe 在 `release-hotfix-carrier-lane.md`。一般 release 不需讀本檔；「hotfix／bump 不得直接對 production 開 PR」的禁令留在入口檔。

### Hotfix Release-Carrier Lane（SSOT）

一個 `hotfix/<name>` 單元、其版本 bump（若適用）與 rules-lane rollback 單元，一律經**同一** release-carrier lane 進 `production`（source／consumer 同構，無 repo 身分分岔）；`hotfix/*`／`chore/bump-v*` **MUST NOT** 是 base `production` 的 PR head，只有 carrier 自己的 PR 進 `production`。具體 step-by-step recipe（verifier 呼叫點、provenance block、carrier ff＋back-merge）見 `release-hotfix-carrier-lane.md` §Hotfix release-carrier lane；本節只持有下列 normative 不變式（SSOT，其他 leaf 只留 pointer）。

**N1–N5 不變式**：

- **N1**：`ANCHOR_TAG`（最近 `production-*` tag，以拓撲判定，非名稱／日期排序）不可變；hotfix、carrier、bump 皆自它建。production 前進時 MUST NOT 混用「舊 anchor」與「最新 tag」；雙條件新鮮度 gate 在 freeze/build 前與 production merge 前各驗一次：(a) 目前最新 `production-*` tag == `ANCHOR_TAG`，且 (b) `origin/production` tip == `ANCHOR_TAG` 的 exact commit；任一不符 **一律 fail closed**、自最新 tag 重切 carrier／hotfix 並重審——**不定義** production-lane lock 例外。
- **N2**：carrier MUST 先於任何 hotfix PR 存在（PR base 需已存在的 ref）。
- **N3**：carrier 建立時內容 MUST byte-identical 於 `ANCHOR_TAG`；未核准的 hotfix 內容 MUST NOT merge 進 carrier；唯一允許在 hotfix review 前 merge 進 carrier 的內容是版本 bump（metadata-only，經其專屬 bump gate；bump-first：`MC^1 == anchor_commit`）。
- **N4**：build MUST 在 freeze 後；tag MUST 在 production PR merge 後。
- **N5**：已 promotion 後若再需要新 hotfix，MUST 從最新 tag 開**新** carrier，MUST NOT 回頭改已上線的 carrier。

**review-binding**：核准 hotfix PR 時，review 者於該 PR 留言單行 `hotfix-review-binding: head=<40hex> base_ref_oid=<40hex> merge_base_sha=<40hex>`——`head`＝核准的 PR head tip SHA；`base_ref_oid`＝核准當時 carrier tip SHA；`merge_base_sha`＝`head` 與該 `base_ref_oid` 的 merge-base SHA；verifier（`pre-merge`/`merge-proof`/`pre-promote`）自該 PR 的 comments 讀這一行並比對，不採信 caller 傳入的 base；只採認受信 comment——作者對該 repo 具寫入權（`gh api repos/{owner}/{repo}/collaborators/<login>/permission` 的 `permission` 為 `admin` 或 `write`；不採 `authorAssociation`，`MEMBER`／`COLLABORATOR` 可能只有讀取權；查詢失敗視為不受信）、從未編輯（`includesCreatedEdit` 為 false）、且 PR 已 merge 時建立時間不晚於 `mergedAt`；其餘 binding 行一律忽略（既不能充當 binding、也不能造成衝突）。PR 作者本人不排除（單人維運時 TL 即 PR 作者）：binding 證明的是「具寫入權者在 merge 前記錄了核准的 base」，不證明作者以外的第二人審過。同一 `head` 缺受信 binding 或受信 binding 有多組不同值即 fail closed。張貼方式：以 `gh pr comment <n> --body-file <main-checkout-root>/notes/tmp/<unique>.md` 發一則 PR conversation comment，binding 為獨立純文字一行（不包反引號、不加 `>` 引用；其餘行只放 footer）；不得放在 `gh pr review` 的 review body（verifier 只讀 PR comments）。同一 `head` 需重新綁定時，刪除舊 binding comment 後另發新 comment（編輯過的 comment 不採認），避免多組不同值。其他 leaf 只留 pointer；`release-hotfix-carrier-lane.md` 的 copy-execute recipe 可逐字重列並指回本節。

**hotfix unit sticky（source／consumer）＋ review-binding**：每個 `hotfix/<name>` tip 恰一次有效 sticky；tip 變必須重 sticky。禁把未審兄弟 hotfix／main 合併進已 sticky 單元來「刷新」就緒（疊船）。review 時另於該 hotfix PR 留單行 `hotfix-review-binding` 留言（格式定義＝SSOT，見上方 review-binding）。merge 進 carrier（source `release/v*`；consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`）後靠 Path A＋組裝證據（見 `code-review-cross-model.md` Path A），不靠對 carrier 重跑 per-hotfix dual sticky merge-in。

**Artifact 狀態機**：`ASSEMBLED` → `FROZEN`（carrier 內容 pin 為 `CARRIER_SHA`）→ `BUILT`（build once；FROZEN 後任何 content-changing 的 carrier ref 移動使 artifact 作廢、退回 `ASSEMBLED`）→ `PROMOTED`（production PR merge、先證明 exact merge commit 在 freshly fetched `origin/production` 上，再於該 commit 建 tag）→ `BACK-MERGED`（carrier ff 到 tag，並經其自己的 back-merge PR 合回 `main`）。

**U10 milestone 為 inert**：hotfix、bump、carrier 三類 PR 皆不設 milestone；hotfix-subset 的判準恆為核准的 tip SHA＋sticky（連同 GitHub PR 記錄核對），從不是 milestone 欄位、非 milestone。誤掛或缺 milestone 皆 inert，MUST NOT 被視為阻擋條件，也 MUST NOT 被當作「未依此 lane 進行」的證據。三類 PR body 皆寫 `Release Target: N/A（hotfix lane）`。

**Verified already-live repo-missing backfill**：source／consumer 皆走上方 release-carrier lane 全套（freeze、build once、smoke、provenance），不再有「不經 release」的雙 PR 旁路。來源記在 PR/commit/OpenSpec；若內容是 not-yet-live nonurgent，仍是可促進單位，有 defect semantics 才走 `bugfix/*`。

A non-urgent already-live backfill：**source／consumer 同構**——MUST complete normal OpenSpec/pre-flight before implementation；hotfix prefix alone MUST NOT authorize freeze-break；組裝後仍至少 smoke / at least smoke。Urgency-only OpenSpec deferral and lite pre-flight remain limited to independently urgent repairs. rigor lite 時，記錄載體為 PR body 固定欄位，取代上述 OpenSpec、pre-flight、archive 與 PR 引用要求（lite 不建 proposal、不 archive）；non-urgent 的欄位仍須在實作前備妥，independently urgent 維持既有 24h，這不屬於 urgency-only 的 OpenSpec 延後。（rigor lite 的 OpenSpec／pre-flight／archive 要求改依 `release-already-live-backfill.md` §2）

hotfix-subset 的 bump 起點（一律自 carrier 的同一 `production-v*` tag，不適用 full-main 例外）見 `release-sit-uat-pat-prod.md` §SemVer 與 Bump 規則。

`bugfix/` 升級為 hotfix：從最近 `production-*` tag 新開 `hotfix/<name>`，cherry-pick 修復 commit，棄原 `bugfix/` 分支。反向降級：照對應 lane 的 hotfix 流程完成。

**Cutover／grandfather**：生效點＝該 repo 取得含本 change 規則版本後新開的 hotfix（consumer 見 `release-hotfix-carrier-lane.md` §Consumer 遷移自查）。in-flight legacy `hotfix/*`→`production` PR #1：尚未 merge → 關閉，自最新 tag 依 carrier lane 重切、新 sticky；已 merge → 完成舊 lane（tag，再開一個從 hotfix 分支到 `main` 的 PR），該 PR body 記 `grandfathered-legacy-hotfix: PR #<n>`（完整 mechanics 見 `release-hotfix-carrier-lane.md` §Grandfathered legacy hotfix completion）。不得以 bypass merge 舊 PR #1、不得把舊 PR #1 retarget 成 carrier。cutover 後已直合 `production` 者不適用本段，補救見 `release-already-live-backfill.md` §3。
