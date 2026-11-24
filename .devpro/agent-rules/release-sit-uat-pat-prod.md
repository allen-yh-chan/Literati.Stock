---
name: release-sit-uat-pat-prod
description: Release/promote 七步流程：optional DEV confidence gate、release subset、Build once、SIT terminal、UAT/PAT/PROD、existing release promotion、hotfix release-carrier lane（source／consumer 同構）。觸發：release/promote/上線/發佈，或 bump PR merge 後接 step 2-7。
---

# 上線/促進流程（SIT / UAT / PAT / PROD）

## Overview

分支節奏：**可促進單位（`feature/*`、`bugfix/*`、`chore/*`）→ `main` → [optional `integration` / DEV confidence gate] → `release/*` → SIT terminal 或 UAT/PAT/PROD → push release branch → PR base `production` → GitHub merge**。

- **Hotfix release-carrier lane（source／consumer 同構）**：`hotfix/*` 是可審查單元（sticky 綁 tip）；進 `production` **唯一**經同一 release-carrier lane——source `release/v*`、consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`、consumer-rules rollback `release/rules-<YYYYMMDD>[-<n>]`——組裝剛驗證的核准單元。**禁** `hotfix/*`／`chore/bump-v*` 直合 `production`，source 與 consumer 皆同構、無 repo 身分分岔。詳見 `release-hotfix-carrier-policy.md`與 `release-hotfix-carrier-lane.md`。

**分支角色**

| 分支 | 角色 |
|---|---|
| `main` | 整合完成的可促進單位集散地；長期分支 |
| `integration` | optional full-validation confidence baseline（DEV 佈署依據）；只有 release 負責人/TL 要求 DEV confidence round 時使用；**僅**接收 `git merge main` |
| `release/<YYYYMMDD>-<shortSHA>[-<n>]`（`<YYYYMMDD>`＝預定上線日〔命名時〕；改期後值可與實際 `production-YYYYMMDD` 分歧，見 Step 6；7-hex；source SemVer 可用 `release/v<X.Y.Z>` naming lane）| Build once artifact 來源；new assembly 時承載核准 subset；existing promotion 時承載已驗證 release |
| `production` | 線上穩定版本；**source 與 consumer** 都只透過 work/release branch 的 GitHub PR merge 前進 |
| `production-YYYYMMDD[-<n>]` | 上線日期 tag，打在 freshly verified exact production PR merge commit 上 |
| `hotfix/<name>` | PROD 緊急修復或 verified already-live repo-missing backfill；**source／consumer 同構**——經 release-carrier 組裝（禁直合 `production`），tag 後 carrier ff＋一次 back-merge PR 回 `main` |

> 可促進單位的最早目標 release 輪次以 GitHub milestone 記錄於其 PR（`milestone: <YYYYMMDD>`）；SSOT、掛載時機與 `unassigned` 收斂見 §Subset selection handoff。

**三句話核心語意**

1. **`integration`**：optional DEV confidence gate（HEAD），不是 release gate 或日常開發線。
2. **`release`**：SIT/UAT/PAT/PROD 的 Build once artifact 來源；new assembly **僅**從 `production-*` tag 建（首次例外），可為新核准 subset，也可為既有已驗證 release。
3. **`production`**：線上穩定版本，以上線日期 tag 追溯。

**佈署鐵律**

- DEV（full validation，如本輪有跑）→ **只佈署 `integration` HEAD**（禁止繞過改依 `main` SHA 或手動 build）；未跑時記錄 `confidence-gate skip`，不得記為 release gate skip
- SIT / UAT / PAT / PROD → **只佈署** `release/*` Build once 的**同一 artifact**（禁用 `integration`、`main`、手動 build）
- 兩套環境時：DEV 依 optional `integration` HEAD；SIT 與 UAT/PAT/PROD 同依 `release` artifact
- pre-PR 的 DEV branch-build 驗證（`pre-pr-dev-verification.md`）是本節之外的獨立 lane：`integration` 仍只收 `main` merge；release-time DEV 仍只佈署 `integration` HEAD，SIT／UAT／PAT／PROD 仍只驗 `release/*` 的同一 Build once artifact，DEV 結果不得當 SIT／UAT 證據

**禁止清單**

- `merge main → 可促進單位`（污染 subset）
- `merge integration → release`（subset 改吃 integration 整合）
- `feature/ → integration` 直接 merge
- 從 `integration` 開 `release/*`
- Squash / Rebase merge（feature → main）— canonical: `git-pr-template-and-merge.md`「合併策略」+ `pre-tool-gate.mjs` Gate 2c
- 凍結期間自行破凍

> 進入 release/promote 時，source/consumer repo **都先讀本檔**。source repo 用 SemVer 軌：`release/v<X.Y.Z>` → `production-v<X.Y.Z>`；consumer rules sync 才用 Rules Lane。

## When to Use

- 使用者表達「release / promote / 上線 / 發佈穩定版」
- 使用者表達「release 到客戶端 SIT」→ `release-to-sit`
- 使用者表達「上 production / promote to production」且要新挑 subset → `release-to-production-new`
- 使用者表達「從既有 release 上 production」→ `release-to-production-existing`
- `chore/bump-v<X.Y.Z>` PR merge 後需立即接 step 2-7
- release 負責人/TL 要求 optional DEV full-validation confidence round
- hotfix 緊急 PROD 修復
- **不觸發**：純開發、feature PR、日常 merge main 操作

## Process

### Release intent / entry path

進入 release/promote 時先確認並記錄 release intent：

| intent | 何時使用 | 流程終點 |
|---|---|---|
| `release-to-sit` | 客戶端 SIT 佈署，只要求本輪 subset 到 SIT | Subset selection handoff → optional DEV confidence gate（可略）→ `release/*` → Build once → SIT；SIT 結果回報後停下交棒 |
| `release-to-production-new` | 新挑 subset 並一路 promote 到 production | 與 `release-to-sit` 相同的新組裝 path，SIT 後續接 UAT/PAT/PROD approval、Step 6 與 Step 6A（tag 後合回 `main`；gate exit 0 才是本輪終點）；Step 1 的 intent 請求須載明 graph-only back-merge 的涵蓋（`release-step-1-7.md` Step 1） |
| `release-to-production-existing` | 從既有已驗證 `release/*` branch/artifact 上 production | 選定 existing release → 驗 branch HEAD SHA、artifact id、Build once evidence、approval/provenance、無未驗 release-branch change → Step 6 與 Step 6A；除非 release branch 改動或 provenance 無法驗證，否則不得重挑 subset 或 rebuild；選定請求須載明 graph-only back-merge 的涵蓋（`release-step-1-7.md` Step 1） |
| hotfix | PROD 緊急修復 | sticky 單元 → cut carrier 自 `ANCHOR_TAG`（source `release/v*`；consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`）→ bump-first（若適用）組裝；**禁**直合 production，source／consumer 同構。詳見 `release-hotfix-carrier-policy.md` |

**Subset selection handoff / candidate subset list**（new assembly paths 必做）：列出 anchor 之後尚未上 production 的候選可促進分支，至少含 branch、unit tip OID、PR/merge 狀態、touch files scope、dependency/merge order、風險或阻擋點；交由使用者/TL 選擇並記錄 approved subset（含每條分支的核准快照：branch、unit tip OID、貢獻 PR 編號集合、milestone，見 `release-milestone-assignment.md` 分支改齊指令與 `release-step-1-7.md` Step 1/2）。未核准分支不得進 `release/*`。

**Release bucket milestone（可促進單位最早目標輪的 SSOT）**：可促進單位（`feature/*`、`bugfix/*`、`chore/*`）的最早目標 release 輪次 MUST 以 GitHub milestone `milestone: <YYYYMMDD>`（預計生效日 bucket，部署變更為預計上線日、非 `release/*` 分支全名）記錄於其 PR；一個單位 MUST 只掛一個 milestone（其最早目標輪），並行多輪下 MUST NOT 為後輪重複標記（後輪由 superset 涵蓋，見 `release-step-1-7.md` Step 2）。掛載時機：目標梯次已知時才掛，未知時維持 `unassigned`，最晚由 release 負責人／TL 在 Step 1 指派；release 負責人／TL MAY 改派；延期 MUST 只改 milestone，分支名與 OpenSpec change 名 MUST NOT 編碼目標輪、MUST NOT 為改期而改名（延期情境：整包／單一需求／跨 repo 同版，見 `release-step-1-7.md` Step 6 改期）。判定範圍是一條可促進分支的全部 `MERGED`＋`OPEN` PR（不含 closed-unmerged）：全部未掛 → `unassigned`；全部掛同一值 → 該梯次；有掛有未掛，或出現兩個以上不同值 → `conflict`，改齊前 MUST NOT 進 approved subset。未掛 milestone 的已合併可促進分支記為 `unassigned`，MUST 由 TL 指派後才可進 approved subset。可直接執行的候選查詢契約見 `release-step-1-7.md` Step 1。

**非部署變更**：consumer 自有規範、文件或 CI 設定即使不部署，只要必須進 `production` 才供後續分支使用，milestone MUST 取預計進 `production` 生效日；會部署的單位仍取預計上線日。目標日期未知時 MUST 維持 `unassigned`，最晚 Step 1 由 TL 指派；MUST NOT 新增狀態或獨立 milestone 命名空間。Consumer 自有檔案走普通 release，rules lane 僅處理 submodule sync（見 `release-rules-lane.md`）；可隨業務同輪納入 approved subset；MUST NOT 僅因非部署就要求單獨 release，若要提前促進仍由使用者／TL 明確選 subset。非部署不豁免既有 subset／驗證／production PR gates。

**Source SemVer Release Requires Explicit Subset Selection**：source repo 的 `release/v<X.Y.Z>` 只是 SemVer naming lane，不等於「整個 `main`」。`chore/bump-v<X.Y.Z>` PR 必須從同一最近 `production-v*` tag 開，與本輪 `release/v<X.Y.Z>` 同基底，普通 subset 不得從 current `main` 開：metadata-only 的 PR diff 仍可能把未選中的 main ancestry 帶入 release；但 `release/v<X.Y.Z>` new assembly 仍必須先完成 candidate subset list → approved subset。若使用者/TL 明確選擇 whole-main release，approval 必須寫成 approved subset = `full-main` 並記錄 selected `main` HEAD SHA；否則不得推論整個 `main`，只能 merge 已核准分支（approved branches；核准快照，見上）剛驗證的 `origin/<branch>`。

### Parallel Release Rounds Superset Ordering

範圍：**in-scope ordinary parallel handling** 是已有 production baseline 與前輪的 ordinary finite-subset 原 early-SIT 組裝、後續 conditional production-tag update／latest-tag reassembly 及 resulting promotion；新增 finalization／parent/tree/context／P/Q/effect 停點排除首次、單輪、explicit full-main、rules lane、hotfix carrier。這不縮窄原 superset ordering／earliest-round milestone 義務；hotfix 觸發 ordinary 後輪重開時先 obey 原 lane，再驗重組 ordinary 後輪。

### Parallel release evidence symbols

Symbols：K=create baseline（後輪開立時 production tag 的 peeled commit）；P=latest finalized production tag 的 peeled commit；Q=fresh production tip；R0/R1=更新前／後 release HEAD（各自記 tree）；Tpreview=pinned parents 的 conflict-free preview tree；R/T=獲批准且 artifact 綁定的候選 release HEAD/tree；M=本輪 production PR 的 exact merge commit（parents Q/R、tree T）；N=本輪 effects 完成前的無關 production ingress。tag 名與 peeled commit 分欄；單字母僅是此證據記法，路徑名固定用 conditional production-tag update／latest-tag reassembly。

Excluded sources：first-release 從 main HEAD 的整體快照及 explicit full-main 的 selected main HEAD SHA，沿 canonical `openspec-flow` 的 Approved Branch Snapshot And Whole-Branch Assembly／Source SemVer Release Requires Explicit Subset Selection 與 `release-step-1-7.md` Step 2；rules lane 沿 canonical `rules-flow` 的 Release Rules Branch Base From Production Tag／Rules Lane Release Cherry-Picks Sync Commits Only 與 `release-rules-lane.md`，只帶該 batch sync commits；hotfix 沿 canonical `source-hotfix-semver-assemble` 的 Hotfix Reaches Production Only Through A Frozen Release Carrier 與 `release-hotfix-carrier-policy.md`／`release-hotfix-carrier-lane.md`，只含 pinned production baseline 加已批准 carrier PR units／lane bump，tag 後 back-merge main。這些來源約束承接原 broad every-commit assertion，不新增 parallel proof gate 或 hotfix main-first 義務。

Finalized：**finalized production baseline** MUST 有 fresh remote tag peeled 至 exact production PR merge M、production reachability、適用部署／發布成功、既有 completion（含適用 Step 6A main ancestry）及 durable approved provenance；tag presence／SemVer/date sort 不能替代前輪完成。

Latest：MUST 依 completed lane/round order 與完成證據選 latest finalized baseline；`detect-branch-base --anchor`／version-sort 只給 mechanical candidate。證據矛盾、輪次不可比較或 production ingress 未閉合時 MUST 停止 selection，由 production owner 補 closure。

兩條路徑的唯一詞義：**conditional production-tag update** 保留既有後輪 release，在原組裝 closure、unchanged snapshots、content/function impact、相容 metadata、conflict-free preview 與操作授權成立後，merge selected immutable finalized tag；**latest-tag reassembly** 保留舊 carrier／evidence 為歷史，必要 Anchor Sync→PR-main→fresh snapshot／version approval 後自 applicable finalized tag 建合法新 release。Admission 與執行見 `release-step-1-7.md` Step 2 的 parallel 判定，freshness／promotion 核對見 `release-verification-commands.md`，QA 見 `testing-and-qa.md` §Parallel release QA evidence。

Authority：MUST NOT 以 design approval、subset approval 或 SIT approval 替代 early SIT、update 操作或縮短 QA scope 的具名授權；缺哪項就拒絕該動作，由既有有權 owner 補 scoped permission，QA executor／AI 不得自批縮驗。

### Anchor 判斷規則

**可促進單位**（`feature/`、`bugfix/`、`chore/`）從 anchor 建：

```
anchor =
  優先序 1：git tag -l 'production-*' 有結果 → 最近一個 production-YYYYMMDD[-n] tag
  優先序 2：否則 git branch --list 'release/*' 有結果 → git merge-base <最近一條 release/*> main
  優先序 3：否則（純早期開發）→ main HEAD
```

機器判定：`node .devpro/scripts/detect-branch-base.mjs --anchor`；in-scope ordinary parallel handling 的結果只作 candidate，finalized selection 依上節。

**hotfix 基底固定規則**：`hotfix/` 一律從「最近 `production-*` tag」建立，**不得**套用上述 fallback 到 `release/*` 或 `main`。若目前無任何 `production-*` tag：先排除「漏打 / 誤刪 / `git fetch` 漏 `--tags` / 規範引入前歷史」等異常（能補/同步 tag 即補）；確實不可能（首次 release 期、無歷史可補）才降級 `bugfix/` 可促進單位流程。

### SemVer 與 Bump 規則

版本欄位（`hotfix-carrier-verify.mjs` 讀取本清單；Go 以 tag 為版本、無版本檔）：
<!-- version-metadata-files:start -->
- `Directory.Build.props` — .NET
- `*.csproj` — .NET
- `package.json` — Node
- `pyproject.toml` — Python
- `Cargo.toml` — Rust
- `AGENTS.md` — source-only：頂部 `版本：`
<!-- version-metadata-files:end -->

上方清單是 Metadata-only bump gate「version-file diff scope」所指的**同一份** SSOT；不另造第二份清單。

**Bump 鐵律**

- 版號 bump **必須**走獨立 `chore/bump-v<X.Y.Z>` 分支與 PR，**不得**塞進 feature/bugfix PR
- `chore/bump-v<X.Y.Z>` PR **必須**含實際版號異動（舊值 → 新值，且新值 = 分支名 `<X.Y.Z>`）；禁止 no-op bump
- **Metadata-only bump gate**：bump PR 只驗命名、SemVer 級別、version-file diff scope、實際版號變更、分支/檔案版本一致；不得要求在 bump PR 上跑完整專案測試
- 併入 `release/*` 前**必須先完成** bump PR merge（bump **禁**直合 `production`；source／consumer 皆然）；若本輪執行 optional DEV confidence gate，併入 `integration` 前也必須先完成 bump PR merge
- 須 bump 時：先建議版號並取得明確確認後才改版號欄位
- **SemVer 級別看完整範圍**：建議版號前 MUST 列出「上一個版本錨點 → 本版要發佈的內容」之間的完整 commit／PR 清單，依其中最高級別判定 MAJOR／MINOR／PATCH，MUST NOT 只看本輪工作。錨點是最近的 `production-v*`／版本 tag；沒有 tag 時，用版號檔上次變更版號的 commit（例：`git log -S"<目前版號>" -- <版號檔>`）。本版內容：整份 main 或沒有 release 分支流程時是 bump 起點的 main；subset release 是核准 subset 的全部分支（bump 分支從 tag 開，tag 到 bump 起點是空的，不能拿來判）。給使用者版號選項時附上這份清單與各項分類（實例：consumer 只算本輪 bugfix 建議 PATCH，漏了上一版之後已進 main 的新 Web API，應為 MINOR）。
- **Release assembled test gate**：完整專案測試 / build 在 release branch 組裝完成後執行。Source repo：`release/v<X.Y.Z>` 依上方 subset 規則組裝後跑。consumer repo：`release/*` merge 核准 subset + bump 後跑。測試對象不是 bump branch。

**Bump 觸發時機（固定順序，時機 1 為必須）**

1. subset 確認後、`release/*` 建立前（**必須**）：consumer subset release 從 anchor（本輪 release 的 base，通常最近 `production-*` tag）開 `chore/bump-v<X.Y.Z>`；**source SemVer** bump PR **必須**從最近 `production-v*` tag 開（與本輪 `release/v*` 同 tag；**禁**從 current `main` 開 bump 以免夾帶未選 main），且 bump **只**進 `release/v*`（**禁** bump→production）（full-main 與 hotfix-subset 的 bump 起點見本節末段；首次無 tag 例外依既有規則）。完整測試移到 release branch 組裝後
2. ❌ 禁止在 feature PR 內 bump；❌ 禁止在 `release/*` 上直接 bump；❌ 禁止 hotfix 內包 bump；❌ 禁止 `chore/bump-v*` 或 `hotfix/*` 直合 `production`（source／consumer 皆然）

source repo SemVer bump PR 預設自本輪 `release/v*` 的同一 `production-v*` tag 開；只有普通 release 已明確核准 `full-main` 並固定 selected `main` HEAD SHA 時，才可由該 SHA 開 bump。hotfix-subset 的 bump 一律自 carrier 的同一 `production-v*` tag 開，不適用 full-main 例外。

### Release 流程 step 1-7

> Load-chain（逐步執行 recipe）：step 1-7 見 `release-step-1-7.md`；hotfix carrier lane 見 `release-hotfix-carrier-lane.md`（normative 條款見 `release-hotfix-carrier-policy.md`）；Step 1 tip 不一致的例外路徑見 `release-unselected-commit-handling.md`；Step 6A back-merge 指令見 `release-back-merge-completion.md`；milestone 分支改齊指令見 `release-milestone-assignment.md`；上線後核對指令見 `release-verification-commands.md`

### Hotfix vs Bugfix

| | `bugfix/<name>` | `hotfix/<name>`（source SemVer） | `hotfix/<name>`（consumer） |
|---|---|---|---|
| 類型 | 可促進單位 | PROD 緊急修復或 verified already-live backfill（經 carrier 組裝） | 同左，經 carrier 組裝（source／consumer 同構） |
| 緊急程度 / 狀態 | not-yet-live nonurgent；不急，跟 release 走 | 緊急修復，或 verified already-live repo-missing backfill | 同左（consumer lane） |
| 合回目標 | `main` → release subset → PROD | carrier（`release/v*`）→ `production` → tag → carrier ff＋一次 back-merge PR → `main` | carrier（`release/<YYYYMMDD>-<shortSHA>[-<n>]`）→ `production` → tag → carrier ff＋一次 back-merge PR → `main`（同構；見 `release-hotfix-carrier-lane.md`） |
| 從何建 | anchor | 最近 `production-v*`（僅此） | 最近 `production-*` date／rules tag（僅此） |
| SIT/UAT 驗證 | 經 release 驗證鏈 | 組裝後；smoke 可縮不可省 | 組裝後；smoke 可縮不可省（同構） |
| 經 `release/*` carrier | 是 | **是**（唯一進 production） | **是**（唯一進 production；本 change 遷移自舊 dual-PR recovery） |

### Hotfix Release-Carrier Lane

進 `production` 的禁令見 Overview 與下方 Production PR-only invariant；hotfix、bump、carrier 三類 PR 不設 milestone，缺或誤掛皆 inert、不是阻擋條件。Normative 條款（N1–N5、review-binding、artifact 狀態機、already-live backfill、bump 起點、cutover／grandfather）SSOT 見 `release-hotfix-carrier-policy.md`；逐步 recipe 見 `release-hotfix-carrier-lane.md`。

### 凍結期破凍規則

凍結期間（已啟動 `integration`/DEV confidence round 並刻意凍結 main 對齊點）出現新修復需求：

| 破凍（立刻 merge main → integration） | 等下一輪 |
|---|---|
| 本輪必過項目 fail（blocker）| 非本輪 subset 的 feature 問題 |
| 安全性問題（SQL injection、PII、授權繞過）| 風格 / 可讀性改善 |
| 資料損壞風險（migration bug、race condition）| 非 blocker 的 UI 調整 |
| 阻擋所有驗測進行（環境層 bug、認證斷）| 小範圍 bug 且有 workaround |
| 法遵 / 合規強制項 | optional improvement、refactor |

**判斷責任**：破凍**必須**由 release 負責人或 tech lead 明確拍板；AI 只能提出分類建議，不得自行破凍。若使用者在對話中明確自述為 release 負責人 / tech lead，其拍板視同有效授權。

破凍後義務：
1. 原可促進單位分支修 → PR → main
2. 若本輪仍要維持 DEV confidence gate，Release 負責人在 `integration` 上執行新一輪 `merge main`；PR 描述記錄「破凍原因 + 對應 main SHA」
3. DEV / 單套環境依新 `integration` HEAD 重佈署；**本輪之前已跑過的驗證項目須重跑**

### `integration` 治理補充

- `integration` **僅允許** `git merge main`（或 merge 已在 `main` 歷史的 commit）更新；禁止 reset --hard、快轉等
- `integration` 是 optional confidence gate，不是 release branch 的前置硬門檻；`release-to-sit` 與 `release-to-production-new` 可在記錄 `confidence-gate skip` 後直接走 `release/*` 組裝
- 禁止 `feature/<name>` → `integration` 直接 merge
- 禁止在 `integration` 上常態堆業務 commit
- `integration` 不保證可上線或穩定；禁止以「全量已過」為由將 `integration` 佈署至 UAT/PAT/PROD
- **凍結語意**：本輪開始並對齊後，可刻意不再 merge main，使 DEV 所驗內容不受 main 後續新 commit 影響；`main` 仍可持續合入其他 work

### Anchor Sync（長期 feature）

可促進單位以 `git merge <production-* tag>` 追上 PROD 進度：

```bash
git fetch origin --tags
git merge <latest production-* tag>   # 例 production-20260401
```

**觸發條件**：

- **必須**（hard rule）：可促進單位即將進入下一輪 `release/*`，且其 anchor（建立時的 `production-*` tag）已**非**最新 `production-*` tag → **必須**在 `git merge <可促進單位> → release/*` **之前**完成 anchor sync
- **建議**：可促進單位跨過一輪以上 release，或 PR review 期間出現新 `production-*` tag → 主動 anchor sync 避免最後才撞衝突

**目的**：將衝突解決前置到 feature branch，避免 release 線上發生衝突（守住「release ⊆ main」不變式，見 Step 2 補充）。

**限制**：**僅限** `production-*` tag；禁止 merge `main`、`integration`、其他 feature 或非 `production-*` tag 的 ref。

### Source Repo 共用流程附註

source SemVer：`chore/bump-v<X.Y.Z>` → main → approved subset/full-main selection → `release/v<X.Y.Z>` → production → `production-v<X.Y.Z>`；bump PR merge 後**立即接 Step 2-7**。

**Source repo SemVer release 骨架**：

1. `VERSION=<X.Y.Z>`；`PREV_TAG=$(git tag --list 'production-v*' --sort=-version:refname | head -1)`；`REPO_ROOT=$(git rev-parse --show-toplevel)`
2. 先完成 candidate subset list 並取得 approved subset。有限 subset 時，對每條核准分支留下核准快照（branch、unit tip OID、貢獻 PR 編號集合、milestone；hotfix-subset 用核准的 tip SHA＋sticky 綁定），組裝後用 final `--range "$PREV_TAG..HEAD"` 檢查；只有 approved subset = `full-main` 且記錄 selected `main` HEAD SHA 時，建 release worktree 前才跑 `node .devpro/scripts/check-committed-diff-whitespace.mjs --release-main <selected-main-sha>`。
   - committed-diff whitespace 防線已前移至 push-time PreToolUse hook（`checkCommittedDiffWhitespacePush`）。
   - 若 whitespace gate 假紅且 path 屬 source-declared／synced `.devpro`（source `.gitattributes` 已有 path-scoped `whitespace=` 例外）：**MUST NOT** hand-edit synced `.devpro` 削 trailing space 與 `sync-agent-rules.mjs --check` 對打；應 rerun `--sync` 讓 derived managed attributes 生效，或回報 source 缺例外。細節見 `gitattributes-alignment.md`。
3. `git worktree add "$REPO_ROOT/.worktree/release-v$VERSION" -b release/v$VERSION "${PREV_TAG:-main}"`
4. 有 `PREV_TAG`：release WT 依核准順序、組裝前先 fetch 並重新驗證每條核准分支的快照仍成立，再依序 `git merge --no-ff "origin/<branch>"`（hotfix carrier 走獨立 lane，見 `release-hotfix-carrier-lane.md`，不適用本骨架）；explicit full-main 才可 merge selected `main` HEAD SHA；首次無 tag 可跳過
5. release WT 跑 `node .devpro/scripts/run-test-suite.mjs --tier all`、`openspec validate --strict --all`、`node .devpro/scripts/pre-pr-archive-gate.mjs`、`node .devpro/scripts/check-committed-diff-whitespace.mjs --range "$PREV_TAG..HEAD"`（首次無 tag 改用 `git diff --check HEAD~1..HEAD`），再 push `release/v$VERSION`
6. Push `release/v$VERSION`，建立 base=`production` 的 PR，通過既有 gates 後透過 GitHub regular merge；resolve 該 PR 的 exact merged production commit 為 `MERGE_SHA`，freshly fetch `origin/production` 與 tags，驗證 `MERGE_SHA` 可解析且 reachable，並以 `git show "$MERGE_SHA:AGENTS.md"` 確認 `版本：$VERSION`。接著 `git tag production-v$VERSION "$MERGE_SHA"`，驗 peeled tag 等於 `MERGE_SHA`，最後 `git push origin refs/tags/production-v$VERSION`，push only the tag ref。禁 local production merge、current-HEAD tag、pre-merge tag 或 combined protected-ref/tag push。

**Production PR-only invariant**：所有 applicable ordinary、source SemVer、consumer date、hotfix 與 rollback production path 都必須 push work/release branch → PR base `production` → GitHub merge → exact merged production commit → freshly fetch `origin/production` 驗證 → tag the explicit commit → push only the tag ref。hotfix、其 version bump 與 rollback 單元進 `production` 的 PR head 恆為 release carrier；`hotfix/*` work branch 只以 PR 進 carrier，不得當 base `production` 的 PR head。

禁從 main 直接開 `release/v<X.Y.Z>`（首次無 tag 例外）；release 必須保留「previous production tag → explicit approved subset merge」組裝 evidence。`release/v<X.Y.Z>` 上 `git merge main` 預設禁止；若選 whole-main，必須先有 approved subset = `full-main`、selected `main` HEAD SHA 與 explicit bypass evidence。

## Rules Lane

> Load-chain（consumer rules-sync）：獨立 release lane 細則見 `release-rules-lane.md`

## Exit Criteria

- `production-v<X.Y.Z>` tag（或 `production-YYYYMMDD[-<n>]` / `production-YYYYMMDD-rules[-n]` tag）已建立在 freshly verified exact production PR merge commit 上
- `production` 分支已透過 GitHub PR merge 對應 work/release branch（freshly fetched `origin/production` 可驗 reachability）
- 所有 tagged ordinary promotion 的 exact production tag 已是 freshly fetched candidate `main` ancestor；SIT-only／no-tag／first-import no-tag 為 N/A
- Step 6 cleanup report 已執行 `node .devpro/scripts/prune-merged-local.mjs` 與 `node .devpro/scripts/prune-notes-tmp.mjs` dry-run，最終回報列出候選分支 / worktree / orphaned 摘要與 stale notes/tmp 摘要（或 no candidates）；`--exec` 仍需使用者明確同意。任何 alert-observation-only stop point 前，MUST 先給出 `Post-PROD Cleanup Decision Matrix`：production-shipped local/worktree 用 `node .devpro/scripts/prune-merged-local.mjs --exec`；有 production-shipped remote 候選時另列 `node .devpro/scripts/prune-merged-local.mjs --include-remote --exec`；有 known non-state `notes/tmp` 候選時另列 `node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of <time>`；末項開放。alert observation 只能跟在矩陣後，不得取代它；unknown tmp、state files、unshipped-mainline refs 與 dirty worktree 仍適用既有更強 consent。
- hotfix 情況：carrier→production tag 後已 `hotfix-carrier-verify.mjs post-promote --back-merge-pr` 驗證通過；grandfathered legacy hotfix 見 `release-hotfix-carrier-lane.md` §Grandfathered legacy hotfix completion
- consumer 可 sync 新版（source repo 情境：`AGENTS.md` 版號已 bump 並反映在 tag）
- 上線後告警觀察期已完成，無異常或已完成 rollback

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「凍結期可以破例，我判斷算 blocker」 | AI 無破凍授權；必須由 release 負責人或 tech lead 明確拍板後才可推進。 |
| 「先 push 等使用者拍板 → step 完成了」 | 單一步驟不算 release 完成；除非使用者明確要停，否則必須推進到本輪終點。 |
| 「全量驗證通過了，直接把 integration 佈署上 UAT/PROD 更快」 | `integration` ≠ release artifact；UAT/PAT/PROD 只允許 `release` 線 Build once 的同一 artifact。 |
| 「跳過 PAT 直接進 PROD，UAT 已經通過了」 | 各環境是獨立 gate；跳過等於繞過合規促進鏈，須使用者明確授權才可縮短。 |
| 「bump 塞進 feature PR 方便追蹤」 | 混入 bump 會讓 cherry-pick 帶入版號變更、模糊 review 焦點；bump 必須走獨立 `chore/bump-v<X.Y.Z>` PR。 |
| 「hotfix 只 merge production，main 等之後再說」 | source／consumer 同構：須經 carrier 組裝、tag 後 carrier ff＋back-merge PR 回 `main`，缺 back-merge PR（`MERGED`）即未完成。 |
| 「production PR 合併、tag 推完了，release 完成」 | 一般 release 的終點是 Step 6A：promoted tag 已是 freshly fetched `main` 的祖先（`--require-main-ancestor` exit 0）；缺 back-merge PR（`MERGED`）即未完成，與 hotfix 同。「announce」「觀察告警」「分支清理」都不能取代它。 |
| 「Stop 沒擋，所以 back-merge 已完成或可以不做」 | 該 Stop 閘門只在 `platform-adapters/claude-code.md`／`platform-adapters/codex.md` 的 host 且前提成立時運作（前提：host 已信任並實際執行專案 hook、clone 已裝 pre-push），其餘 host（`platform-adapters/cursor.md`、`platform-adapters/opencode.md`）只靠文字；Stop 放行不等於完成（離線、合格交棒、使用者延後、次數上限都會放行），完成只看 Step 6A 的 `--require-main-ancestor` exit 0。 |
| 「release 上 merge 衝突，直接在 release 解掉比較快」 | release 必須是 main 的子集；在 release 上獨立解衝突會讓該行程式碼在 main 不存在，下次重開 release 即遺失。衝突一律退回 feature branch 解（見 Step 2 補充「release ⊆ main」不變式）。 |

## Verification

上線後核對指令（PROD tag、production merge、bump PR、release artifact SHA、hotfix carrier back-merge、release ⊆ main 與 full-main）見 `release-verification-commands.md`；finite subset 以 structured approved-subset evidence 為主要判準，不用 commit-level 拓撲判準；in-scope ordinary parallel handling 在原組裝／更新前、續 UAT/PAT 前與 production merge／tag／effect 前 MUST 讀該 leaf 的 parallel 核對，不能只跑本檔共用 source 骨架。
