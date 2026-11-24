---
name: release-verification-commands
description: Release 上線後的核對指令：PROD tag、production merge、bump PR、release artifact SHA、hotfix carrier back-merge、release ⊆ main（finite subset 以 structured approved-subset evidence 為主要判準）與 explicit full-main。觸發：release 組裝後或上 PROD 後要核對結果時。
---

# Release Verification Commands

> Load-chain：本檔由 `release-sit-uat-pat-prod.md` §Verification 按需載入；release 規則、Exit Criteria 與 approved subset 定義留在該檔。未到核對階段不必讀本檔。

## Verification

### Parallel reassembly／promotion 核對

先依 `release-sit-uat-pat-prod.md` §Parallel release evidence symbols 解析 K/P/Q/R0/R1/Tpreview/R/T/M/N；本節只適用該 entry 定義的 in-scope ordinary parallel handling；使用既有 release PR approved-subset/assembly、build metadata 與 QA 報告，記 create/effective tag/OID、R0→R1 HEAD/tree、artifact/digest、批准者、expected/actual parents/tree/context、diff/domain 處置、full validation／stage／incomplete refs。先完成該 action 的持久 checkpoint 再續下一步；詳細組裝順序依 `release-step-1-7.md`。

- **Content/domain**：MUST 完整處置 K→P baseline diff 與 P→candidate diff（deletion、rewrite、rename、binary、migration、config 皆含）；各 candidate 差異追核准單位，每個新上線功能標保留或具名替換／移除，附 PR/snapshot、理由、功能 owner／release approval 與 QA 影響。ancestry、clean tree／merge MUST NOT 當功能／DB／跨 repo 相容證明；未閉合不得 promote。
- **替換/移除**：MUST 由核准單位承載且 affected functional owner 與 release approver 明認；release-only deletion 事後在 ledger 標 intentional MUST NOT 合法化。意外 revert／覆寫回單位修→regular PR main→Step 1 fresh approval→latest-tag reassembly，不在 release 手改。
- **Fresh selection**：MUST 在前輪完成、組裝前、續 UAT/PAT 與 production PR merge 前重取 latest finalized P 與 fresh production tip Q；merge 前 Q=P。Q 前進而 tag／completion 未閉合，或 P 已變，即停止並由 production owner 補 closure，再回 Step 2 重判／重驗；不忽略同 tree ingress，也不以 tag sort 判 completed。
- **Promotion candidate**：MUST pin Q/R/P/T、artifact digest/source R/T、scope/stage approvals；Q 在 R ancestry 且 conflict-free regular production preview tree=T 才可合併。不同／不可算／需手解即不得 merge，回 update/reassembly 驗證；不得臨時 build production tree 取代已驗 artifact。tree equality 仍不證 domain 安全。
- **Pre-effect control**：MUST 記既有可驗 server expected-base/head 或強制序列 candidate-revalidation 的實際機制／範圍／結果，使 same Q/R 及 tree/artifact 核對持續覆蓋 merge 與剩餘 tag／deploy／source publication effects，或每個 effect 有 atomic expected state 拒絕控制；final fetch、口頭不動、head-only --match-head-commit、local HEAD guard／postdetect 都不合格。latest-tag reassembly不修 base race；缺合格機制即不得 merge/deploy，由 owner 補 existing capability 或另取具名調整授權，不新增 lock／GitHub設定。
- **Own merge transition**：MUST 由同一 MERGED PR 驗 base=production、head name／OID=R，取 exact M 並 fresh fetch 驗 reachability、actual parents=Q/R、M tree=T、deployment artifact source R/T；任一錯配停止剩餘 tag／deploy，保留已 merge 真實狀態，不改寫歷史。成功時 expected tip 由 Q 轉 M、own tag exact M，不再套舊 P/Q equality 誤拒自己的合法 merge。
- **Remaining effects**：tag／實際 deploy 前 MUST fresh read production/tags 與 effect protection，expected M 若被無關 N／latest baseline 前進替換，停止剩餘 tag/deployment／source effects，保留 partial M/N 與 owner/next action，回 fresh baseline 重判／重驗；M reachable 不得將舊包部署成 rollback N。control 只鎖 merge 不夠；effect 已完成後的正常後續輪次不追溯否定本次歷史，Step 6A ancestry 仍獨立完成。
- **Lane seam**：in-scope source SemVer／consumer date MUST 經 regular production PR，tag exact M、M tree=T；R/M OID 可不同。production→main back-merge 只完成 ancestry，MUST NOT 要 main 等於 artifact tree 或藉此推 whole-main approval；finite subset 可排除 main 其他需求。

下列通用指令的 sort／log 僅供候選查找；不替代上述 completion、content/domain、artifact 或 effect-time proof。


```bash
# 確認最新 PROD tag
git tag -l 'production-*' | sort | tail -5

# 確認 production 分支最近 merge
git log production --oneline -5

# 確認 bump PR 狀態
gh pr view <bump-pr-number> --json state,mergedAt

# 確認 release artifact SHA 一致
git log release/<YYYYMMDD>-<shortSHA> --oneline -3

# 確認 hotfix carrier back-merge 已完成
gh pr list --head hotfix/<name> --state merged
node .devpro/scripts/hotfix-carrier-verify.mjs post-promote --tag <tag> --carrier <carrier> --carrier-sha <sha> --anchor-commit <sha> --production-pr <n> --provenance-sha256 <pre-promote 回報的 digest> --back-merge-pr <m>

# 確認 release ⊆ main（finite subset 以 structured approved-subset evidence 為主要判準）
# - candidate subset list
# - approved branches（核准快照；下列 <approved-sha> 為該分支核准快照的 unit tip OID，只作核對用途，不是 merge target）
# - each approved SHA exists on main before release assembly
git merge-base --is-ancestor <approved-sha> main
# - each approved SHA is contained by the assembled release branch
git branch --contains <approved-sha> release/<YYYYMMDD>-<shortSHA>
# Do not use commit-level 拓撲判準 such as `git log release --not main`
# or `git log main..release` as primary proof; assembly merge commits can make
# those non-empty even when every approved SHA is valid.

# full-main only:
# approved subset = full-main
# selected main HEAD SHA = <selected-main-sha>
git diff --stat <selected-main-sha> release/<YYYYMMDD>-<shortSHA>
# expect empty for explicit full-main; do not use this as finite-subset proof
```
