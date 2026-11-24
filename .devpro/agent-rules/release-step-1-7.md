---
name: release-step-1-7
description: Release step 1-7 recipe：組裝 release branch、測試、tag、promote。
---

# Release 流程 step 1-7

> Load-chain：本檔由 `release-sit-uat-pat-prod.md` 按需載入；entry leaf 只保留 anchor / SemVer / hotfix 決策，逐步執行 recipe 在此。

### Release 流程 step 1-7

> AI 不得在單一步驟後宣告完成；除非使用者明確要求停下，否則必須推進到本輪終點。

**Step 1：Release intent + subset handoff + optional DEV confidence gate**

1. 記 release intent：`release-to-sit`（SIT 結果即停）、`release-to-production-new`（新組裝後進 UAT/PAT/PROD）、`release-to-production-existing`（既有 artifact；一般跳 Step 2，in-scope ordinary parallel handling 先依 Step 2 parallel 判定，再進 Step 6 existing-release checklist）。

   **back-merge 涵蓋聲明（對應 Step 6A）**：intent 為 `release-to-production-new` 或 `release-to-production-existing` 時，使用者核准該 intent 的那則請求（new：approved subset 的選擇請求；existing：選定 existing release 的請求）MUST 載明：Step 6A 的 back-merge 在判定為 graph-only 時視為已涵蓋——使用者核准即同意 AI 開 PR 並以 regular merge 合進 `main`；非 graph-only 仍停下詢問。使用者可在回覆中排除；請求未載明或被排除，Step 6A 仍是 Ask First 停點。`release-to-sit` 不涉及 Step 6A，不載明。

2. New assembly 先列候選可促進單位清單（以分支為單位彙整），交由使用者/TL 選擇並記 approved subset；未批准項目不得進 `release/*`：

   **候選查詢（完整、不帶日期／`--search`；可直接執行）**：

   ```bash
   set -euo pipefail
   git fetch origin --prune --tags
   ANCHOR=<anchor production-* tag>   # detect-branch-base.mjs --anchor 的 production-tag ref
   ROUND=<YYYYMMDD>                   # 本輪預計進 production 生效日 bucket（部署時為預計上線日）
   LIMIT=5000                         # 本 repo 已逾 2800 筆 PR；不足會被下一行擋下
   PRS=$(gh pr list --state all --base main --limit "$LIMIT" \
     --json number,state,headRefName,headRefOid,isCrossRepository,milestone,mergeCommit,mergedAt)   # 不加任何 --search／日期條件
   test "$(printf '%s' "$PRS" | jq length)" -lt "$LIMIT"   # 未通過 → 放大 LIMIT 重跑；MUST NOT 接受
   UNIT_GROUPS=$(printf '%s' "$PRS" | jq -c '[.[] | select((.state=="MERGED" or .state=="OPEN")
       and (.headRefName|test("^(feature|bugfix|chore)/"))
       and (.headRefName|test("^chore/bump-v")|not))]
     | group_by(.headRefName)[] | {branch: .[0].headRefName, prs: .,
         has_merged: (map(select(.state=="MERGED")) | length > 0),
         unit_tip: (map(select(.state=="MERGED")) | (if length>0 then (max_by(.mergedAt) | .headRefOid) else null end)),
         unit_merge_commit: (map(select(.state=="MERGED")) | (if length>0 then (max_by(.mergedAt) | .mergeCommit.oid) else null end))}')
   ```

   完整性（列 14）：候選查詢 MUST NOT 帶日期或 `--search` 條件；`gh pr list` 會分頁直到 `--limit`，結果筆數 MUST 小於 `--limit` 才代表已分頁到結束、才可接受，否則放大 `LIMIT` 重跑，MUST NOT 靜默接受截斷結果（本 repo 已逾 2800 筆 PR，預設值遠不足）。touch files scope 只對候選分支另以分頁的 `gh api 'repos/{owner}/{repo}/pulls/<n>/files?per_page=100' --paginate --jq '.[].filename'`（endpoint 必須加引號：zsh 預設把未加引號的 `?` 當萬用字元，指令在 gh 執行前就報 no matches found） 補齊，筆數 MUST 等於 `gh pr view <n> --json changedFiles`，否則 fail closed（單頁 files 欄位上限 100 筆，MUST NOT 使用）。

   **兩份 inventory（依 `has_merged` 分流）**：`has_merged=false`（全 open、尚未合入 `main`）的群組只進 **milestone inventory**（供三態判定、`devpro:pre-pr` 建 PR 沿用與分支改齊使用），不跑 ancestry、不跑下方健全檢查；Step 1 輸出附註「尚未合入 `main`」（F-1-08 補充列 16）。`has_merged=true` 的群組先跑已上線判定才進 **release-candidate inventory**。

   **已上線判定（squash／rebase 安全）**：squash／rebase 併入時 unit tip（`headRefOid`）永遠不會成為 main 歷史的 ancestor，只看 unit tip 會把已上線單位永久誤判為候選；改用「unit tip 或 `mergeCommit.oid` 任一是 `$ANCHOR` 的 ancestor」。以 bash 執行（存成 script 或 `bash -c`，勿在互動 shell 貼上——is-ancestor 正常結果就含非 0，`set -e` 下會中止 shell）：

   ```bash
   # unit_released: 已上線判定（Step 1 SSOT）
   unit_released() {  # $1=unit_tip $2=unit_merge_commit $3=anchor；stdout released|unreleased；return 非 0 → fail closed
     git cat-file -e "$2^{commit}" 2>/dev/null || { echo "missing merge commit $2" >&2; return 2; }
     git merge-base --is-ancestor "$2" "$3" && rc=0 || rc=$?
     case $rc in 0) echo released; return 0;; 1) ;; *) return 2;; esac
     if git cat-file -e "$1^{commit}" 2>/dev/null; then
       git merge-base --is-ancestor "$1" "$3" && rc=0 || rc=$?
       case $rc in 0) echo released; return 0;; 1) ;; *) return 2;; esac
     fi
     echo unreleased
   }
   ```

   對每個 `has_merged=true` 群組呼叫 `unit_released "<unit_tip>" "<unit_merge_commit>" "$ANCHOR"`：`released` 不再列出；`unreleased` 進 release-candidate inventory 並跑下方健全檢查；非 0 return（缺物件或 is-ancestor 非 0/1）fail closed 交 TL。squash 單位判 `unreleased` 卻在下方 lineage／regular-merge 檢查 fail closed 屬設計內行為，交 TL。

   **分支健全檢查（依序、對 release-candidate inventory 每個群組執行，第一個不通過即停止該分支、`continue` 到下一群組——不中止整個健全檢查）**：MUST 用同一份 `$PRS`／`$UNIT_GROUPS`，MUST NOT 另以帶條件的查詢重取；以 bash 執行。逐群組取 `GROUP_PRS`：

   ```bash
   while IFS= read -r G; do
     GROUP_PRS=$(jq -c '.prs' <<<"$G")
     UNIT_TIP=$(jq -r '.unit_tip' <<<"$G")
     MC=$(jq -r '.unit_merge_commit' <<<"$G")
     BRANCH=$(jq -r '.branch' <<<"$G")
     [ "$(jq -r '.has_merged' <<<"$G")" = true ] || continue                      # milestone inventory only
     ST=$(unit_released "$UNIT_TIP" "$MC" "$ANCHOR") || { echo "$BRANCH: fail closed"; continue; }
     [ "$ST" = unreleased ] || continue                                           # 已上線，不列出

     # 1) fork
     jq -e 'all(.[]; .isCrossRepository|not)' <<<"$GROUP_PRS" >/dev/null || { echo "$BRANCH: fork"; continue; }

     # 2) lineage 與 3) regular merge（每筆 merged PR；同一迴圈一次掃描）
     LINEAGE_OK=true
     REGULAR_OK=true
     while IFS=$'\t' read -r HR PMC; do
       git merge-base --is-ancestor "$HR" "$UNIT_TIP" || LINEAGE_OK=false
       ST=$(unit_released "$HR" "$PMC" "$ANCHOR") || LINEAGE_OK=false
       [ "$ST" = released ] && LINEAGE_OK=false
       [ "$(git rev-parse "$PMC^2" 2>/dev/null)" = "$HR" ] || REGULAR_OK=false
     done < <(jq -r '.[] | select(.state=="MERGED") | [.headRefOid, .mergeCommit.oid] | @tsv' <<<"$GROUP_PRS")
     [ "$LINEAGE_OK" = true ] || { echo "$BRANCH: lineage"; continue; }
     [ "$REGULAR_OK" = true ] || { echo "$BRANCH: non-regular merge"; continue; }

     # 4) 分支存在
     git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null || { echo "$BRANCH: restore"; continue; }

     # 5) tip 一致
     [ "$(git rev-parse "origin/$BRANCH")" = "$UNIT_TIP" ] || { echo "$BRANCH: tip mismatch"; continue; }

     # 6) 三態／四態：依下表標籤
   done <<<"$UNIT_GROUPS"
   ```

   1. **fork**：任一 PR `isCrossRepository=true` → 停下交 TL，不進 subset（列 2）。
   2. **lineage**（兩個方向的停下條件各自獨立）：第一行不成立（某筆 merged PR `headRefOid` 不是 unit tip 的 ancestor）→ 停下交 TL（同名多段 lineage）；第二行 `unit_released` 對任一筆 merged PR 判定為 `released`（其 `headRefOid` 或 `mergeCommit.oid` 已是 `$ANCHOR` 的 ancestor）→ 停下交 TL（已上線分支被續用）。兩者皆不自動判斷是哪一段。舊 lineage 的 PR 不論合併多早都在完整清單內，所以跨舊截止日的同名重用也會被擋（F-1-08 補充列 17）。
   3. **regular merge（每一筆 merged PR）**：任一筆的 `<mergeCommit.oid>^2` 不等於該筆 `headRefOid`（squash／rebase）→ fail closed 交 TL；unit merge commit 亦含在內。
   4. **分支存在**：`refs/remotes/origin/<branch>` 失敗 → PROD 前分支已被刪，先停下。未取得授權時，請使用者到該分支最後一筆 PR 頁面按「Restore branch」，救回後重跑 Step 1；AI MUST NOT 自行重建。使用者明示授權 AI 代做時，MAY 以該分支最後一筆 **MERGED 且同 repo（`isCrossRepository=false`）** PR 的 `headRefOid` 建回同名分支（等同 Restore branch 按鈕；該值即上方已算好的 `$UNIT_TIP`）：

      ```bash
      # 只在使用者明示授權後執行；以 bash 執行（Windows 用 Git Bash／WSL）
      test -n "$UNIT_TIP" && test "$UNIT_TIP" != null || { echo "$BRANCH: no MERGED tip, stop"; exit 1; }
      # 精確查同一個 ref（不用分支尾名 pattern，避免 team/<branch> 被誤命中）
      gh api "repos/{owner}/{repo}/git/ref/heads/$BRANCH" >/dev/null 2>&1 && { echo "$BRANCH: ref already exists, stop"; exit 1; }
      gh api -X POST "repos/{owner}/{repo}/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$UNIT_TIP"
      ```

      Windows 沒有 bash 時：同一組動作在 Git Bash／WSL 執行。若一定要用 PowerShell，存在性檢查 MUST 看 exit code，不可寫 `if (gh api ...)`——404 仍有 stdout 輸出，會被誤判成 ref 已存在：先 `gh api "repos/{owner}/{repo}/git/ref/heads/$BRANCH" *> $null`，再 `if ($LASTEXITCODE -eq 0) { throw "ref already exists" }`，之後跑同一條 `gh api -X POST`。

      重建來源 MUST 是該群組最後一筆 MERGED、同 repo PR 的 `headRefOid`；MUST NOT 用本機分支／工作區狀態、OPEN PR、fork PR 或推測 SHA；群組無 MERGED PR 或 `$UNIT_TIP` 取不到 → fail closed 交 TL。建回後 MUST 用同一份 `$PRS`／`$UNIT_GROUPS` 重跑整個健全檢查（含第 5 項），不得只補第 4 項就放行。PROD 後依 Step 6 清理的分支在上一步已上線判定（`unit_released`）已判為已上線，不會進 release-candidate inventory，也不會走到這裡（列 1、1b）。
   5. **tip 一致**：不符 → 分支上有未進 `main` 的 commit（含 open PR 的新 commit），MUST NOT 進 subset，改走 Step 1 補充（列 12；見 `release-unselected-commit-handling.md`）。
   6. **三態／四態**：依下表標籤。

   **Step 1 四態**（依分支的 milestone 三態彙整；標籤固定四個，不增第五個）：

   | milestone 狀態 | 標籤 | 可否進 approved subset |
   |---|---|---|
   | 單一值且 ＝ `$ROUND` | 本輪 | 可（仍須通過上方健全檢查） |
   | 單一值且 ≠ `$ROUND`（含早於本輪者，附註「早於本輪」） | 之後梯次（非本輪） | 本輪不進；「早於本輪」者由 TL 依既有 Step 2 superset 規則判定納入，或以 `release-milestone-assignment.md` 的分支改齊指令改到正確梯次 |
   | 全部 null | `unassigned` | TL 以分支改齊指令指派後才可進 |
   | 混合或多值 | `conflict` | 改齊前 MUST NOT 進 |

   輸出為分支層表格：branch｜標籤｜unit tip｜PR 編號集合｜milestone｜健全檢查結果｜下一步。

   **越晚發現越貴（FR-12；在 Step 1 擋下的理由）**：切 release 前只需改齊 milestone 或重跑分支改齊指令；越晚發現處理成本越高——TL 核准時需重新核准、SIT–UAT 期間需重開 `release/*` 重 build，上 PROD 後則需經`release-hotfix-carrier-lane.md` §Hotfix release-carrier lane 的 `hotfix/revert-*` carrier 回退（freeze／build once／smoke／provenance 全套，回退結果同一 back-merge 回 `main`）；故一律在 Step 1 擋下。

   健全檢查全過且標為本輪（或依 TL 判定納入的之後梯次）的分支，approved subset MUST 記錄**核准快照**：branch、unit tip OID、貢獻 PR 編號集合（MERGED＋OPEN）、milestone；核准快照 MUST 原樣寫進 release PR description 的 approved subset 段，取代逐單位 SHA 列表（組裝前再驗，見 Step 2）。

   掛載契約（一單位只標最早目標輪、已知才掛·未知 `unassigned`·最晚 Step 1 由 TL 指派／改派、延期只改 milestone〔情境見 Step 6 改期〕）見 `release-sit-uat-pat-prod.md` §Subset selection handoff。source repo `release/v<X.Y.Z>` SemVer lane 適用同一契約：`<YYYYMMDD>`＝該 lane 的預計進 production 生效日 bucket（部署時為預計上線日），lane 名本身 MUST NOT 當 milestone。
3. **Source SemVer Release Requires Explicit Subset Selection**：`release/v<X.Y.Z>` 只是 naming lane；有限 subset 記核准快照（branch、unit tip OID、PR 集合、milestone；hotfix-subset 為核准的 tip SHA＋sticky），whole-main 必須記 approved subset = `full-main` + selected `main` HEAD SHA，否則不得推論整個 `main`。
4. DEV full validation 是 optional confidence gate：要跑則 regular merge `main` → `integration`（不得 reset --hard）並部署 DEV；略過記 `confidence-gate skip`。SIT/UAT/PAT/PROD 仍只部署 Step 3 Build once artifact。

**Step 2：建立 `release/<YYYYMMDD>-<shortSHA>[-<n>]`（new assembly only）**

建立 release branch 前檢查 committed diff whitespace：

```bash
# finite subset: before assembly
git merge-base --is-ancestor <snapshot tip OID> main
# finite subset: after assembly
node .devpro/scripts/check-committed-diff-whitespace.mjs --range "$BASE..HEAD"

# explicit full-main only
node .devpro/scripts/check-committed-diff-whitespace.mjs --release-main <selected-main-sha>
```

`--release-main <selected-main-sha>` 只適用 approved subset = `full-main`（等價 `git diff --check <latest-production-tag>..<selected-main-sha>`；起點是最新的 production tag，source 為 `production-vX.Y.Z`，consumer 為 `production-YYYYMMDD[-n]` 或 `production-YYYYMMDD-rules[-n]`，沒有就報錯）；有限 subset 不得使用。fail 回可促進單位或 `main` 修，不得在 release branch 補白。

```bash
# base: production-* tag；首次無 tag 才 main
ANCHOR_JSON=$(node .devpro/scripts/detect-branch-base.mjs --anchor)
TAG=$(printf '%s' "$ANCHOR_JSON" | jq -r 'select(.source=="production-tag") | .ref')
BASE=${TAG:-main}
SHORT_SHA=$(git rev-parse --short=7 $BASE)
DATE=<預定上線日 YYYYMMDD>  # operator-supplied planned go-live；禁取自系統時鐘

REPO_ROOT=$(git rev-parse --show-toplevel)
git worktree add "$REPO_ROOT/.worktree/release-$DATE-$SHORT_SHA" -b release/$DATE-$SHORT_SHA $BASE
cd "$REPO_ROOT/.worktree/release-$DATE-$SHORT_SHA"
```

對 Step 1 approved subset 內每條核准分支：組裝前 MUST 先重新驗證核准快照仍成立，全部通過才開始 merge；任何不同（tip 移動、多了 PR、milestone 變動、健全檢查不過）→ 該分支核准失效，重跑 Step 1（列 8c）：

```bash
git fetch origin --prune --tags     # 只 fetch 一次；比對與 merge 之間不得再 fetch
# 先對核准快照每一列全部比對，全部通過才開始 merge：
test "$(git rev-parse "origin/<branch>")" = "<snapshot tip OID>"
git merge-base --is-ancestor "<snapshot tip OID>" origin/main
# 重跑 Step 1 的完整查詢（不帶日期、筆數 < LIMIT），取該分支群組：PR 集合與 milestone MUST 等於快照，並以同一份清單重跑健全檢查
# 依核准順序，每次 merge 後立即回讀（refs/remotes 由同 repo 所有 worktree 共用，fetch 與 merge 之間的視窗仍可能被他人推新 fetch 覆蓋，故以 merge 後立即回讀收斂）：
git merge "origin/<branch>"         # consumer release/<YYYYMMDD>-<shortSHA>；source release/v* 用 git merge --no-ff "origin/<branch>"
# source（--no-ff，恆為 merge commit）：
test "$(git rev-parse HEAD^2)" = "<snapshot tip OID>"
# consumer（無 --no-ff，可能 fast-forward）：HEAD 或 HEAD^2 其一等於 snapshot tip OID
{ [ "$(git rev-parse HEAD)" = "<snapshot tip OID>" ] || [ "$(git rev-parse HEAD^2 2>/dev/null)" = "<snapshot tip OID>" ]; }
```

merge 對象固定為剛驗證的 `origin/<branch>`；`<snapshot tip OID>` 只作核對用途，不作 merge target。各 lane 既有的 `--no-ff` 與否維持原樣，只換 merge 對象。回讀不符 → 停下、不 push，該分支核准失效，重跑 Step 1。

- 首次 release（無 `production-*` tag）：從 `main` HEAD 建，跳過 merge 直接進 Step 3；subset 紀律從第二次 release 起生效。
- source SemVer `release/v<X.Y.Z>` 同樣從最近 `production-v*` tag 建，merge 已核准分支剛驗證的 `origin/<branch>`（`--no-ff`）；whole-main 需 explicit full-main evidence。
- 首次 release 與 `full-main`（selected `main` HEAD SHA）維持整體快照：此處 SHA 屬整體快照，不是單位 merge target（列 9、10）。
- 除下節具名 early-SIT provisional 例外外，並行多輪 release 時，後一輪 `release/*` MUST 從前一輪 `production-*` tag 建、或為前一輪的 **superset**；單位只標最早目標輪，MUST NOT 為後輪重新標 milestone（後輪由 superset 涵蓋）。
- PR 要寫明 release intent、candidate subset list、approved subset、每條核准分支的核准快照表（branch、unit tip OID、PR 編號集合、milestone）；每個 subset PR description **必須**含檔案接觸範圍與 merge 順序建議。
- 同日多包：若同一日切多條 release（不同預定上線日／換版包），以上線日區分分支名；目標環境（SIT/UAT/PAT）是同一 Build once artifact 的促進階段，**環境不進分支名**（記在 release PR description 的 release intent）。`-<n>`（n≥2）只表示**同一預定上線日**的第 n 包——不同上線日各用自己的 `<YYYYMMDD>`，不得因「切分支同一天」而互加 ordinal。

**Step 2 補充：merge 衝突處理原則**

> **不變式**：ordinary finite-subset 的非 production baseline 可部署內容 MUST 來自核准 whole-branch units（已 regular-merge main）與核准 lane bump；lawful assembly merge OID 不在 main 不是違規，但 MUST NOT 引入未核准 release-only patch／revert／conflict-resolution tree。single-round 及所有 scope 外 ordinary finite-subset 沿既有 structured proof／snapshot／immediate read-back 拓樸例外，不新增 parallel context 停點；first／full-main／rules／hotfix 保留各自來源契約。

> PR-to-main conflict 先見 `git-branch-naming-and-anchor.md`「PR 併入 main 衝突分流」；本節只管 `release/*`。

release 衝突禁止在 `release/*` commit 解：`git merge --abort` → 回可促進單位 merge latest production tag 解決 → PR regular merge `main` → 回 release 重跑。多 feature 互撞時先確認具名 dependency；下句 B/C 只指 dependency feature/B 與待解衝突 feature/C（不是更新路徑）：C 只 merge/recreate from B 分支，不 merge main；長命 feature/hotfix 重開則先 Anchor Sync 最新 production tag。

**Step 2 parallel 判定（只引用 entry 的 in-scope ordinary parallel handling）**

先讀 `release-sit-uat-pat-prod.md` §Parallel release evidence symbols 的符號／excluded source owners，以及 §Parallel Release Rounds Superset Ordering 的 scope／finalized／authority，再依以下順序判定；除具名 provisional 外仍須前輪 superset。原 early-SIT assembly 與新組裝都需下列 pinned proof；既有 Step 1／2 snapshot、conflict abort、origin branch merge 與立即回讀不被替代。

- **Early SIT**：owner 明確授權 `release-to-sit` 時 MAY 以 then-latest finalized baseline 組裝；MUST 記 create baseline、pending predecessor、approved scope 與 artifact 限制，維持 SIT-only，MUST NOT 以 provisional 證據取得 UAT/PAT/PROD 資格；當時必要單位 Anchor Sync 不得跳過。
- **Predecessor 撤回**：撤回／無限延後時 MUST 停止自動 update／promotion，交具名 release owner 依 planning/subset 重定 predecessor／round／scope；新核准前保持 SIT-only，不得自行丟單位或選另一前輪。
- **前輪完成**：owner MUST 選 conditional production-tag update、latest-tag reassembly 或具名 missing evidence 停點；先讀 verification leaf 的 fresh selection，clean merge 不授予升版資格。進 UAT/PAT 前須 latest baseline history/content、assembly closure、artifact/full validation、current QA 與 stage authorization 全閉合。
- **原組裝 closure**：conditional update MUST 可獨立讀回 create/effective baseline tag/OID、原 release HEAD/tree、SIT artifact/build provenance、候選清單／批准者、各 snapshot、merge 順序及 bump approval；不得補寫歷史批准、隱藏 unvalidated mutation／不明 parent/tree，缺則 genuine latest-tag reassembly 或停止。
- **Unchanged snapshots**：conditional update MUST fresh 核對 unreleased branch／tip OID／完整 PR 集合／milestone／health／origin/main ancestry 與原批准一致；任何 drift 拒絕 update，交 Step 1 重核准後 latest-tag reassembly，不偷選 new tip。仍以既有單次 fetch＋all-branch verification 及每步 read-back 組裝。
- **Scope representation**：MUST 逐一表示原核准單位仍在 candidate 或已由 latest baseline 涵蓋；後者保留 tip 與核准內容 trace，不得重掛後輪 milestone 或續用已發佈分支。scope 退出／新增或內容目的改變須 owner 核准。
- **Pinned assembly**：MUST 留每步前一步組裝 result 與核准 tip（update 為 selected tag）的 parents、snapshot、順序及 immediate read-back；actual parents/tree 必須等於 same pinned parents 在 conflict-free preview、同一可驗 merge execution context 的結果。merge label／ancestry 不合法化手改 tree、未核准 branch 或依賴，即使它在 main。
- **Replay context**：MUST 記 Git version、strategy/options、rename settings、relevant attributes/driver version/config 非敏感識別（未設 driver 記 none），原組裝／preview／actual 一致；缺失、無法重現、非決定性 driver／criss-cross 不算 proof，轉 fresh latest-tag reassembly 或停止。latest-tag reassembly 也記新 context，不替舊 proof 背書；不強制以另一份重組充當 oracle。
- **Metadata conflict**：兩輪同 K 改同 version line 為不同版本時 default 三方 merge 衝突，conditional update 對此組合不可達；MUST 用 latest-tag reassembly，由 bump owner 核定 version／metadata-only PR／fresh snapshot，不得在 release 解、取較大版本或用 bump-only snapshot 例外。
- **Update execution**：MUST 先對 pinned R0/P 算無修改性無衝突 Tpreview，完成 verification leaf content/domain 處置與操作授權後，merge selected immutable final-tag peeled OID；tag 名另記，unit target 仍 origin/<branch>。immediate read-back 核對 parents 與 Tpreview；no-op 核對原 HEAD/tree 與 P ancestry。任一不符即停止、不 push、不 build、不 promote，不手改 tree；衝突一律 `merge --abort` 後回單位修。
- **Latest-tag reassembly**：MUST 固定 fresh applicable P，保留舊 release/artifact/evidence，必要單位 Anchor Sync→regular PR 回 main→Step 1 fresh snapshot 批准後，自 P 新建 release，依核准順序 merge 剛驗的 origin/<branch>、每步回讀。hotfix re-open 優先，overlap 先 sync new tag；non-overlap 亦不得用 conditional update 免重開。latest-tag reassembly 不自動補授權、不自動保功能。
- **Carrier/version**：latest-tag reassembly MUST 用合法新 carrier，撞既有 source release/v 或 metadata 不相容先走 owner version/branch Ask First；MUST NOT force-push、reset、delete 已推歷史騰名字。conditional update 保留 branch，consumer shortSHA 仍是 immutable create-anchor hint，create/effective baseline 分欄，不追 effective P 改名；改期／ordinal 依既有規則。
- **Evidence checkpoint**：MUST 在既有 release PR approved-subset/assembly、build metadata、QA 報告持久化版本鏈後才進下一動作；merge/build／必要 evidence write/read-back 失敗記 incomplete、last successful version、已發生操作／失效項、owner/next action，MUST NOT 以部分成功或舊 pass 進下一階段。

**Step 3：Build once**

在 `release` 線 build 一次，記錄 `release/...@<SHA>` 與 artifact 識別；**同一份 artifact** 用於 SIT / UAT / PAT / PROD（唯一允許佈署來源）。

Source repo `release/v<X.Y.Z>` 組裝後，以 final range 重跑 whitespace gate（例：`--range "$PREV_TAG..HEAD"`；首次無 tag 用 `git diff --check HEAD~1..HEAD`）。

in-scope ordinary parallel handling 的 Build once 接續義務：

- **版本效力**：release HEAD 或 tree 任何變動（含同 tree 不同 HEAD）MUST 使舊 artifact 對新版本失效、僅留 historical；新版本須新 Build once、完整 artifact ID/content digest/source HEAD/tree、build log/config/env 與 dependencies／DB/config/API pairing、full assembled validation 及適用 stage evidence；不得直接複製舊 SIT/UAT/PAT approved。
- **No-op reuse**：只在 HEAD/tree、artifact digest、build configuration、dependencies、environment 與完整 provenance 全相等時 MAY reuse；仍須 content、freshness、QA 判定及具名 stage evidence 重綁，already-up-to-date／branch 同名不充分。suite×HEAD/digest 與 QA authority 依 `testing-and-qa.md`。

**Step 4：SIT / UAT / PAT（同一 artifact）**

先佈署 Step 3 產出的同一 artifact 至 SIT。

- `release-to-sit`：SIT 結果回報後停下交棒；除非使用者明確要求繼續，否則不得自行推進 UAT/PAT/PROD。
- `release-to-production-new`：SIT 通過後，用同一 artifact 依序進 UAT / PAT；UAT / PAT approved 後進 Step 6。
- `release-to-production-existing`：此步不重跑新部署；用 Step 6 existing-release checklist 驗既有 artifact 的 approval/provenance。

**Step 5：UAT / PAT 期間 bugfix**

1. 在可促進單位分支修 → PR regular merge → `main`
2. `git fetch origin --prune --tags` 後先驗 `git merge-base --is-ancestor "origin/<可促進單位分支>" origin/main`（不成立 → 停下）並核對其 tip 等於剛 merge 那筆 PR 的 `headRefOid`（不成立 → 停下）；tip／PR 集合變更即核准失效，即使 provenance 成立也一樣——**先重跑 Step 1 對更新後的分支重新核准**（不帶日期查詢、`--limit` 完整性、四態與健全檢查全部重跑）並把核准快照更新為新 tip／PR 集合，通過才在既有 `release` 上 merge 剛驗證的 `origin/<可促進單位分支>`（**禁止** `git merge main → release`）；merge 後立即回讀（同 Step 2：`--no-ff` 核對 `HEAD^2`，無 `--no-ff` 核對 `HEAD` 或 `HEAD^2` 其一）等於該 tip，不符 → 停下、不 push，該分支核准失效
3. 每次 merge 後重 build；UAT / 獨立 SIT 用新 artifact 重驗；原 artifact 失效

UAT 中途退版某單位：同一 `production` 穩定點**重開 `release`** → 依 Step 2 同一程序只 merge 剩餘核准分支 → 重 build/重驗。

**Step 6：PROD 上線**

進入 Step 6 前先確認 production path；in-scope ordinary parallel handling MUST 先完成 `release-verification-commands.md` parallel promotion pre-effect checks，下面共用 PR／tag 指令不是 race 防護。每個 merge、tag push、deployment／source effect 前均須該 leaf 的既有可驗控制，缺则不得執行該動作：

- `release-to-production-new`：UAT / PAT approved 後，promote Step 3 的同一 Build once artifact。
- `release-to-production-existing`：使用者/TL 選既有 `release/*` branch/artifact；AI 跑 existing-release checklist：branch HEAD SHA、artifact id/build metadata、Build once evidence、SIT/UAT/PAT approval/provenance、subset/full-main evidence、無新增未驗 commit。branch 已改、artifact/SHA 不一致或 provenance 不足即停，回 Step 3 rebuild/revalidate 或重開 new assembly；不得重挑 subset 或 rebuild 後直上 PROD。

```bash
set -euo pipefail
# UAT / PAT approved 後
RELEASE_BRANCH=release/<YYYYMMDD>-<shortSHA>[-<n>]
PROMOTED_PRODUCTION_TAG=production-YYYYMMDD[-<n>]
RELEASE_SHA=$(git rev-parse "$RELEASE_BRANCH^{commit}")     # immutable SHA actually selected for this promotion
git push origin "$RELEASE_BRANCH"                       # push work/release branch only
gh pr create --base production --head "$RELEASE_BRANCH" # production PR
# 完成既有 checks/review 後，透過 GitHub regular merge 該 PR
PR_JSON=$(gh pr view <production-pr-number> --json state,baseRefName,headRefName,headRefOid,mergeCommit)
test "$(printf '%s' "$PR_JSON" | jq -r '.state')" = MERGED
test "$(printf '%s' "$PR_JSON" | jq -r '.baseRefName')" = production
test "$(printf '%s' "$PR_JSON" | jq -r '.headRefName')" = "$RELEASE_BRANCH"
test "$(printf '%s' "$PR_JSON" | jq -r '.headRefOid')" = "$RELEASE_SHA"
MERGE_SHA=$(printf '%s' "$PR_JSON" | jq -r '.mergeCommit.oid')
test -n "$MERGE_SHA" && test "$MERGE_SHA" != null
git fetch origin +refs/heads/production:refs/remotes/origin/production --tags # freshly fetch origin/production
git cat-file -e "$MERGE_SHA^{commit}"
git merge-base --is-ancestor "$MERGE_SHA" origin/production
if git show-ref --verify --quiet "refs/tags/$PROMOTED_PRODUCTION_TAG"; then
  test "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")" = "$MERGE_SHA"
else
  git tag "$PROMOTED_PRODUCTION_TAG" "$MERGE_SHA"      # explicit exact merged production commit
fi
test "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")" = "$MERGE_SHA"
git push origin "refs/tags/$PROMOTED_PRODUCTION_TAG"    # push only the tag ref
```

**建分支與打 tag 可同一個 payload**：`git branch release/<date>-<sha>-<n>`（或 `git worktree add <path> -b <branch>`、`git switch -c`／`-C`／`--create`、`git checkout -b`／`-B`）與 `git tag production-<date>-<n>` 寫在同一個 Bash payload 是合法寫法；`Production Tag Ordinal-Branch Match Gate (V2)` 會辨識同一 payload 內**字面形式**的建立指令，不要求分支必須在前一次呼叫就存在。quoted 文字（commit message、`echo` 參數）、`-d`／`-D`／`-m`／`-M`、變數展開的分支名都不算建立。辨識是 payload 層級、不綁定 `cd`／`git -C` 的目標 repo；分支既不存在、payload 內也沒有可辨識的建立指令時仍會擋下並指名缺哪個分支。V2 只核對命名，分支存在不代表 tag 可以打在 production 之外。

**推送時檢查 tag 目標**：git 原生 `.devpro/scripts/hooks-git/pre-push.mjs` 對每個推送新建或更新的 `refs/tags/production-*`，把 tag 剝到 commit，要求它是本機 `refs/remotes/origin/production` 的祖先（沒有 `origin` 時改用推送的、已設定的 remote）；任一個不是就整批拒絕，訊息指回本步的 production PR 流程。hook 不 fetch：上面那行 `git fetch` 沒跑或 production 之後又前進時，合法的 tag 也會被擋，先 fetch 再推。本機沒有該 tracking ref 時以 `production target absent` 擋下。只換外部產物、沒有 repo 變更的發版開不出 production PR，tag 打在已在 `origin/production` 上的既有 commit，這個檢查照樣通過，不需例外。已在遠端、這次沒變的 tag 不會被檢查。與直推 main／production 的擋法相同，這是本機第一道：未安裝或 `git push --no-verify` 不在保證內，也不是核准的發版繞道。

**tag-only push 不是 release 的終點**：緊接執行下方 Step 6A（把 `production` 合回 `main`，適用範圍與 N/A 見 6A）。6A 的 `--require-main-ancestor` gate exit 0 之前，不得回報 release 完成，也不得以「announce」「觀察告警」「分支清理」取代它。

**Production PR-only invariant**：production ingress 固定為 push work/release branch → PR base `production` → GitHub regular merge → resolve exact merged production commit → freshly fetch `origin/production` 並驗 reachability → tag the explicit commit → push only the tag ref。選定 PR 的 PR head 必須同時符合 release branch 名（`headRefName == RELEASE_BRANCH`）與實際 pushed release SHA（`headRefOid == RELEASE_SHA`），再由該已完成且 base 為 `production` 的同一 PR 取得 `MERGE_SHA`；任何 branch/SHA/PR identity 缺失、錯配、模糊、不可解析或不在 freshly fetched `origin/production` 上即 fail closed，不得用另一張已合併 PR、local `production` merge、current `HEAD`、tip convenience 或 protected branch/tag combined push 代替。regular merge commit 仍是 production-line 時序與 rollback 邊界。

**改期（planned go-live ≠ actual go-live）**：
- Tag 打實際上線日：`production-<實際 YYYYMMDD>[-<n>]`。
- **改期不改名**：無 ordinal 時（當天第一包），release 分支可保留預定上線日名稱；V2 對無 suffix tag skip。
- **Rename Before Ordinal Tag**：若實際日需 ordinal（`production-YYYYMMDD-<n>`，n≥2），打 tag 前 MUST 先把分支 rename 為 `release/<實際 YYYYMMDD>-<shortSHA>-<n>`（HEAD SHA 不變），使既有 V2 ordinal-branch match gate 能找到對應分支；**禁**以 hook bypass 代替 rename。V2 gate 邏輯本身不改。

**延期情境**（只改 milestone、不因改期改名〔打 ordinal tag 前的改名仍依上方 Rename Before Ordinal Tag〕；改齊指令＝`release-milestone-assignment.md`；契約＝`release-sit-uat-pat-prod.md` §Subset selection handoff）：

| 情境 | milestone | release 分支 | 其他 |
|---|---|---|---|
| 整包延期 | 目標日 milestone 不存在 → 經 TL 同意 MAY 直接改原標題（PR 隨之移動）；已存在 → 逐分支跑改齊指令 | 不因改期改名（ordinal 例外見上） | 文件寫死的上線日一併更新 |
| 單一需求・未進 `release/*`（各 MERGED PR 皆未含入） | 該分支全部 MERGED＋OPEN PR 以改齊指令改掛後一梯次 | 不動 | — |
| 單一需求・已進 `release/*`（任一 MERGED PR 已含入，含只進較早 PR） | 同上；改齊指令末段只查最新 tip，須另逐筆查各 MERGED PR 的 `headRefOid` 是否在 `origin/release/*` | MUST 停下問 TL：優先從 anchor 重開 new assembly；release 上 revert 屬 release-only patch，須 TL 核准（Step 2 不變式）；已上 PROD 走 `release-hotfix-carrier-lane.md` carrier 回退 | 改到 release HEAD／tree → 依 Step 3「版本效力」重 Build once，SIT／UAT 依新 artifact 重驗 |

TL 指認的跨 repo 同版上線單位延期時 MUST 整組改掛同一梯次，不得只移其中一個 repo。

**上線前 checklist**（必須確認）：

| 項目 | 確認內容 |
|---|---|
| Artifact 正確性 | 來自 release 線 Build once，SHA 與 UAT/PAT 驗證通過一致 |
| Rollback 計畫 | 明確記錄 rollback 步驟與對應 `production-YYYYMMDD` tag |
| DB Migration | 若有：UAT 已驗、可 rollback 或已備份 |
| 監控與告警 | 關鍵指標確認；告警通道暢通 |
| 影響範圍通知 | QA、PM、oncall 已收到上線通知 |

佈署完成後至少觀察一輪告警週期（常見 15-30 分鐘）；有異常依 rollback 計畫立即回退。觀察期間不得以「等觀察結束」為由停在這裡：Step 6A 只對齊 git 歷史（graph-only 時 zero tree delta），不改 production 部署內容，可與觀察並行；6A 的 gate exit 0 之前不得回報 release 完成。

**Step 6A：tagged production ancestry completion**

本段 MUST 套用所有已建立 exact `production-*` tag 的 ordinary promotion：finite subset、`full-main`、non-subset、new/existing；只改 completion topology，不改 Step 1 assembly selection。SIT-only、no tag、first-import no-tag 記 N/A。

Step 6A 指令（Step 6 的 tag-only push 之後 MUST 立刻執行；三段：①檢查、分類、ff、push；②開 back-merge PR；③merge 後再驗）與 `graph-only`／`content-review-required`／ff-only 失敗／hotfix carrier back-merge 的轉向，見 `release-back-merge-completion.md`。**合進 `main` 是 Ask First 停點**；`--require-main-ancestor` gate exit 0 前不得回報 release 完成。

**release back-merge completion gate（部分 host 有機械 backstop，其餘只靠文字；見下表）**

機制：`production-*` tag 由 git 的 pre-push 記錄（只記該次 push 讓遠端新建或更新的 tag）、PostToolUse 把記錄綁到當前對話、Stop 時向 `origin` 查證並以 `--require-main-ancestor` 核對；promoted tag 尚未是 `origin/main` 的祖先且該回合不是合法停點時擋下回合，並指向本 Step 6A。這是防事故的 backstop，不取代 `release-back-merge-completion.md` 的三段指令與 Ask First 停點。

| host | 狀態 | 說明 |
|---|---|---|
| `platform-adapters/claude-code.md` | 機制 | pre-push 記錄 ＋ PostToolUse 綁定 ＋ Stop 阻擋 |
| `platform-adapters/codex.md` | 機制 | 同上列；前提是專案 hook 已被 Codex 信任並實際執行 |
| `platform-adapters/cursor.md` | 只靠文字 | 無 `postToolUse`，記錄無法綁定對話；`stop` 登記僅為與機制 host 對齊的 no-op |
| `platform-adapters/opencode.md` | 只靠文字 | `session.idle` 為非同步，不登記此 gate |

- 前提 1：host 已信任並實際執行專案 hook；沒執行時機制不生效，只剩本段文字。
- 前提 2：clone 已裝 pre-push（`core.hooksPath`，由 `dp-change-environment-checks.mjs` 的 `hooks-path` 或 SessionStart 補裝）；沒裝時沒有任何記錄、機制不生效，只剩本段文字。

放行不等於完成：機制可能因離線（`origin-unverified`）、合格交棒（`qualified-handoff`）、使用者延後（`BackMergeDeferredByUser: <原話摘要>`）、次數上限與迴圈防護而放行回合，這些都不代表 back-merge 已完成，完成仍只看 `--require-main-ancestor` exit 0；合進 `main` 仍是 Ask First 停點，機制本身不授權代為合併（授權只來自使用者的同意，或 Step 1 已涵蓋的 graph-only）。

**分支清理 / Notes Tmp Hygiene（Step 6 唯一觸發點）**：PROD tag pushed 且 Step 6A ancestry completion 完成後才集中清：`node .devpro/scripts/prune-merged-local.mjs`（local/remote/worktree/orphan，keep 跳過）與 `node .devpro/scripts/prune-notes-tmp.mjs` dry-run；兩者 `--exec` 須明確同意。

**Post-PROD Cleanup Decision Matrix**：兩個 dry-run 完成後，在任何 alert-observation-only stop point 之前，MUST 先以編號矩陣提供 production-shipped local/worktree 的 `node .devpro/scripts/prune-merged-local.mjs --exec`；若有 production-shipped remote 候選，另列 `node .devpro/scripts/prune-merged-local.mjs --include-remote --exec`；若有 known non-state `notes/tmp` 候選，另列 `node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of <time>`。末項 MUST 開放（`stop-point-comms.md`）。alert observation 只能接在此矩陣之後，MUST NOT 取代它。unknown tmp、state files、unshipped-mainline refs 或 dirty worktree 仍須既有更強 consent，矩陣不授權它們。詳見 `git-branch-hygiene.md`。

**Step 7：PROD 問題修復**

非緊急：`bugfix/<name>`（可促進單位）→ `main` → 跟 release 走。

緊急（hotfix／rollback／verified already-live backfill）：逐步 recipe 見 `release-hotfix-carrier-lane.md`（§Hotfix release-carrier lane、§Grandfathered legacy hotfix completion）；條款 SSOT 見 `release-hotfix-carrier-policy.md`。

**重開 release 撞檔**：可促進單位先在自身分支 merge new production tag 解衝突 → PR regular merge `main` → 才 merge 新 release；禁止 cherry-pick / merge main → release。
