---
name: release-rules-lane
description: Consumer rules-sync 的獨立 release lane（rules/<source>-vX.Y.Z → release/rules-<date> → production-YYYYMMDD-rules、cherry-pick 單一 sync commit、smoke、rollback）。觸發：執行 consumer rules-lane release 時。
---

# Rules Lane

> Load-chain：本檔由 `release-sit-uat-pat-prod.md` 按需載入；entry leaf 只保留業務 release 決策，consumer rules-lane 細則在此。

### Overview

`rules/` 分支只適用 consumer repo 的 `.devpro-agent-rules` submodule sync，不適用 `devpro-agent-rules` source repo 自身上線。`rules/<source>-v<X.Y.Z>` 的版本段由 source `production-v<X.Y.Z>` tag 正規化而來；date+SHA rules 分支已退役。詳細命名與 anchor 規則見 `git-branch-naming-and-anchor.md`，sync 流程細節見 `rules-flow.md`。

**Consumer 自有檔案**：`AGENTS.local.md`、consumer 文件與 CI 設定即使不部署，也 MUST 走一般 date lane；MUST NOT 因其規範用途改走 rules lane。milestone 日期與既有 namespace 依 `release-sit-uat-pat-prod.md` §Subset selection handoff，不為 rules lane 新增另一組 milestone。

**首發授權邊界**：有效 pre-first-release 的 rules sync 在 main／primary submodule 對齊後完成；MUST NOT 僅因 sync batch 或 production branch 存在而自動執行以下 release recipe。first-rules-release 只在使用者另行明確要求首發 rules release 時適用，仍必須有 remote protected PR target、FIRST_BASE ancestry、smoke、exact merge tag 與 reconciliation；N/A 不豁免任何 release gate。

### 流程

```
rules/<source>-v<X.Y.Z>
  → main
  → release/rules-<YYYYMMDD>[-<n>]
  → production
  → production-YYYYMMDD-rules[-<n>] tag
```

**Disambiguation gate**：若目前 repo 是 `devpro-agent-rules` source repo，或本輪已/需 `chore/bump-v<X.Y.Z>`，MUST use SemVer 軌（`release/v<X.Y.Z>` + `production-v<X.Y.Z>`）。不得因「rules repo / rules change」字樣誤用 `release/rules-*`。
PreToolUse Gate 2h 會 block source repo 建立 `release/rules-*`；該 branch pattern 只服務 consumer rules sync。

### 建立指令（具體 shell）

**禁** fallback main：`release/rules-<YYYYMMDD>[-<n>]` 必須從最近 `production-*` tag 開，絕不從 `main` HEAD 開；否則 main 上累積的非 promoted commits 會隨 merge 一起進 production。同日第一次 rules release 不加 suffix；第二次起用 `-2`、`-3`，且 release branch suffix 必須與 production tag suffix 一致。

**首次無 tag 例外（first-rules-release）**：`git fetch origin --tags` 後若 local 與 remote **皆無任何** `production-*` tag，允許窄首發路徑——base 只能是既有 PR-capable protected remote target 的 **`origin/production` tip**。local `production` branch 只是 checkout 狀態，不能證明 GitHub PR base 存在，也不得作為 fallback。若 `origin/production` 不存在，回報 named blocker `production target absent` 並 fail closed；必須由 release/sync automation 外的 repository administration 建立 protected, pull-request-capable production base，禁止從 `main` 或 local branch 合成、建立或直接 push 缺少的 protected branch。**不**恢復 acknowledgement bypass；有任一 `production-*` tag 時行為不變（仍必須從 production-* tag 開）。

```bash
# Step 1：取最近 production-* tag（含 -rules 變體；以 detect-branch-base 為 SSOT）
ANCHOR_JSON=$(node .devpro/scripts/detect-branch-base.mjs --anchor)
TAG=$(printf '%s' "$ANCHOR_JSON" | jq -r 'select(.source=="production-tag") | .ref')

# Step 2：有 tag → 用 TAG；零 tag → first-rules-release（base＝remote origin/production tip；禁 local/main fallback）
if [ -z "$TAG" ]; then
  if git rev-parse --verify --quiet 'origin/production^{commit}' >/dev/null; then
    FIRST_BASE=origin/production
  else
    echo "production target absent: repository administration must establish a protected, pull-request-capable production base"
    exit 1
  fi
  # MUST NOT use main / origin/main as FIRST_BASE
  if ! git merge-base --is-ancestor "$FIRST_BASE" origin/main 2>/dev/null; then
    echo "abort: first-rules-release FIRST_BASE ($FIRST_BASE) must be an ancestor of origin/main"
    exit 1
  fi
  TAG="$FIRST_BASE"
  echo "first-rules-release: base=$FIRST_BASE"
fi

# Step 3：從該 base 開 release/rules-<YYYYMMDD>[-<n>] 分支
DATE=$(date +%Y%m%d)
SUFFIX="" # first rules release today; use -2, -3, ... for later same-day rules releases
# REPO_ROOT 指派與 git worktree add 必須在同一個 Bash 呼叫：PreToolUse gate 看不到前一個呼叫的變數，拆開會被擋
REPO_ROOT=$(git rev-parse --show-toplevel)
git worktree add "$REPO_ROOT/.worktree/release-rules-$DATE$SUFFIX" -b "release/rules-$DATE$SUFFIX" "$TAG"
cd "$REPO_ROOT/.worktree/release-rules-$DATE$SUFFIX"

# Step 4：只帶本批 sync commit；勿 merge 整條 rules 分支
git cherry-pick <sync-commit-sha>

# Step 5：已在 target release/production worktree；先對齊 submodule，再用同步後 root script 驗證
git status --short
git submodule update --init .devpro-agent-rules
node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync
node .devpro/scripts/sync-agent-rules.mjs --check

# Step 6：consumer rules smoke
if printf '%s' "$TAG" | grep -Eq '^production-[0-9]{8}-rules(-([2-9]|[1-9][0-9]+))?$'; then
  node .devpro/scripts/run-test-suite.mjs --changed "$TAG"
else
  node .devpro/scripts/devpro-doctor.mjs --consumer-smoke
  node --test .devpro/scripts/tests/multi-runtime-parity.test.mjs .devpro/scripts/tests/hook-pre-tool-gate-git-flow.test.mjs
fi
```

> 僅修復前既有／歷史的 main-based rules 分支作 defensive recovery 時仍適用本 Step 4：cherry-pick 取單一 sync commit；ordinary routing 遇 ancestry divergence MUST fail closed 並先依 `rules-flow.md` 完成 reconciliation classification，分類完成前不得宣告 bounded repair，且禁止用 `origin/main` bypass divergence。
> 對 production rules tag，`run-test-suite.mjs --changed "$TAG"` 是 consumer-aware smoke wrapper，會在 target worktree 重新跑 `git submodule update --init .devpro-agent-rules`、submodule `--sync`、root `--check`、consumer doctor、focused generated-tool tests；不得枚舉 source-maintainer README/OpenSpec/corpus suites。
> 若這是 consumer 第一次 rules release，最近 production anchor 可能是非 rules tag（例如 `production-YYYYMMDD` 或 source-style SemVer tag），或零 tag 時的 `FIRST_BASE=origin/production` tip。此時不要把非 rules tag／remote-tracking branch tip 丟給 `run-test-suite.mjs --changed` 當作 smoke shortcut；上方 conditional 會改直接跑 root doctor + focused generated-tool tests（root `--check` 已在 Step 5 跑過）。

#### Verification

```bash
# 確認 release 分支只含預期的 rules sync commits
git log "$TAG"..HEAD --oneline
```

預期輸出（通常 1 條，`.gitignore` managed block 已包含在 rules sync commit 內；舊版可能另有 legacy ignore commit）：

```
<sha> chore: sync devpro-agent-rules (<sha>)
```

若列出 rules sync pattern 以外的 commits，視為污染，不可繼續進 production；觸發 `rules-flow-rollback.md § Rollback SOP`。做過下方 §Carrier ancestry repair 的 carrier 改用該節的範圍核對。

consumer rules smoke pass 時，release report MUST 明列 `source-maintainer checks: N/A`。consumer repo 缺 source repo 的 `README.md` / `openspec/` corpus 不是 regression；只有 root smoke 失敗、sync/check 不一致、hook/CI 爆掉或 range 污染才是本 lane 的 failure。

Production promotion 前必須列出 exact refs 與 PR identity：`release/rules-... -> <sha>`、production PR head/base、`exact production PR merge commit -> <sha>`、`production-...-rules tag -> <same sha>`。固定順序是 push work/release branch → PR base `production` → GitHub merge → resolve exact merged production commit → freshly fetch `origin/production` 並驗 reachability → tag the explicit commit → push only the tag ref。若開場 Batch Scope Ledger 對 `push release/rules branch`、`create production PR`、`merge production PR`、`push production tag` 都明確為 `yes`，該 batch approval 可作為 production PR 與 tag-only push gate evidence；未明確涵蓋 production PR 或 production tag action（missing、`no` 或 `ask-later`）時，最終 gate 仍須再次詢問。不得 local merge/direct-push `production`，也不得 combined protected-ref/tag push。

#### Carrier ancestry repair（production tip 不在 carrier 歷史內）

**觸發**：開或 merge carrier → `production` PR 前，`origin/production` tip 不是 carrier tip 的 ancestor（常見症狀：production PR `DIRTY`，衝突落在 rules 衍生檔；carrier 上 protected-branch gate 禁 `git add`／`git commit`，無法就地解）。這和下方 §Promotion 後 ancestry reconciliation 及 `git-branch-production-ancestry-repair.md`（production tag 不在 main 歷史內、修 main）是不同觸發，本節修的是 carrier。

```bash
git fetch origin --tags
TAG="<carrier 起點的 production-* tag（上方 Step 1 的 TAG）>"
CARRIER="release/rules-<YYYYMMDD>[-<n>]"
CARRIER_TIP=$(git rev-parse "origin/$CARRIER^{commit}")
PROD_TIP=$(git rev-parse 'origin/production^{commit}')
git merge-base --is-ancestor "$PROD_TIP" "$CARRIER_TIP" && echo "no carrier repair needed"
git tag --points-at "$PROD_TIP" --list 'production-*'
git merge-base --is-ancestor "$TAG" "$PROD_TIP" && echo "carrier stale: production advanced after the carrier was cut"
```

- 第一個 `--is-ancestor` exit 0 → 不需修復，照上方順序開 production PR。
- 非 0 且列不出 `production-*` tag（production tip 未打 tag）→ fail closed，不做本修復，停下交棒（格式依 `stop-point-comms.md`）。為什麼停：production tip 沒有 tag，屬直合 production 或漏打 tag 的事故；附 `PROD_TIP` SHA 與空的 tag 清單。要你做什麼：`1. 照 release-already-live-backfill.md §3 做事故補救（先替 production tip 打事故 tag）2. 其他`。回了會怎樣：選 1 照 §3 走，補完 tag 後重跑本節偵測。
- 非 0、列得出 tag，且 `$TAG` 是 `PROD_TIP` 的 ancestor（carrier 開出來之後 production 又經合法 PR 前進）→ carrier 過時，不是違規也不做本修復，停下交棒。為什麼停：carrier 起點 `$TAG` 已不是最新的 production 狀態；附 `$TAG`、`PROD_TIP` SHA 與列出的 tag。要你做什麼：`1. 從最新 production tag 重開 carrier（回 Step 1，同日 suffix 遞增；舊 carrier 與其 production PR 的去留另問）2. 先不動 3. 其他`。回了會怎樣：選 1 回 Step 1 重做本批 cherry-pick 與 smoke；選 2 只回報停點。
- 非 0、列得出 tag，且 `$TAG` 不是 `PROD_TIP` 的 ancestor → **停下交使用者**，取得同意後才建修復分支。為什麼停：carrier 的起點 `$TAG` 不在 production 歷史內，代表 `$TAG` 的上線沒有經 production PR merge 出來，違反 `release-sit-uat-pat-prod.md` Production PR-only invariant（常見於業務發版把 `production-*` tag 直接打在 main）；附 `$TAG`、`$CARRIER`、`PROD_TIP` SHA 與列出的 tag。要你做什麼：`1. 建 carrier 修復分支並開 PR（推薦：tree 不變，只補上 production 的 merge parent）2. 不修，這次 rules release 停在 carrier、production PR 維持衝突 3. 其他`。回了會怎樣：選 1 照下方步驟做，修復 PR merge 前再問一次；選 2 只回報停點。同一則訊息提醒：本修復只讓這次 carrier 接上 production 歷史，業務發版流程要由 release owner 另行改正，否則下次 rules release 會再分岔。
- 修復分支、PR 與 merge 不在 Batch Scope Ledger 既有 action（push release/rules branch、create／merge production PR）內，ledger 的 `yes` 不能代替上面這次同意。

使用者同意後，`PROD_TIP_TAG` 取上面列出的 tag（列出多個時任取其一，指向同一 commit）：

```bash
PROD_TIP_TAG="<上面列出的 production-* tag>"
# REPO_ROOT 指派與 git worktree add 必須在同一個 Bash 呼叫
REPO_ROOT=$(git rev-parse --show-toplevel)
git worktree add "$REPO_ROOT/.worktree/fix-production-ancestry-$PROD_TIP_TAG-carrier" -b "bugfix/fix-production-ancestry-$PROD_TIP_TAG-carrier" "$CARRIER_TIP"
cd "$REPO_ROOT/.worktree/fix-production-ancestry-$PROD_TIP_TAG-carrier"
git merge --no-ff "$PROD_TIP_TAG"
# 有衝突時：只可落在 rules 衍生檔（sync 管理的路徑），以 carrier 的 submodule 重新產生後逐檔 add 再 commit
git submodule update --init .devpro-agent-rules
node .devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs --sync
git add -- <衝突的 rules 衍生檔>
git commit --no-edit
# tree 必須等於 carrier tip（zero tree delta）
git diff --quiet "$CARRIER_TIP" HEAD && echo "zero tree delta"
```

- 衝突落在 sync 管理以外的檔，或 `git diff --quiet "$CARRIER_TIP" HEAD` 非 0 → 停下：不屬本修復。尚未 commit 先 `git merge --abort`；已 commit 則不 push，本機分支留給使用者決定去留（刪除須另行同意）。為什麼停：production 上有 carrier 沒有的內容；附衝突檔清單或 `git diff --stat "$CARRIER_TIP" HEAD`。要你做什麼：`1. 這次 rules release 先停，由 release owner 決定那些內容的去留（要留就另開 change 走一般內容審查與測試，進 main 後再重做 rules release）2. 其他`。回了會怎樣：選 1 只回報停點，不再動 carrier。
- 不得用 squash、rebase、`-s ours`、patch-equivalence 或任何 bypass 取代 merge parent（與下方 reconciliation 同一禁令）。

push 修復分支後開 PR：`--base "$CARRIER"`，head＝修復分支。PR 三點 diff 為空，cross-model 由零差異 ancestry repair 豁免處理（`code-review-cross-model.md` §Zero-diff ancestry repair exemption；base 限 `main` 或 `release/rules-*`）。merge 仍須使用者同意，且只能 regular merge（squash／rebase 會丟掉 merge parent）。merge 後重新 fetch，以**當下**的 `origin/production` 檢查（不沿用修復前存的 `PROD_TIP`），兩項都成立才回到 production PR：

```bash
git fetch origin --tags
git merge-base --is-ancestor 'origin/production' "origin/$CARRIER" && git diff --quiet "$CARRIER_TIP" "origin/$CARRIER" && echo "carrier repaired"
git log "$TAG..origin/$CARRIER" --oneline --not "$PROD_TIP_TAG"
```

等待同意或 merge 期間 `origin/production` 若已前進、又不在 carrier 歷史內，不得回報 carrier repaired：以新的 production tip 從本節偵測重跑、重新分類。最後一行只應列出本批 rules sync commits、修復 merge 與它的 PR merge commit；其他 commit 視為污染，觸發 `rules-flow-rollback.md § Rollback SOP`。之後 production PR 應可 merge，照上方 production promotion 順序與下方 §Promotion 後 ancestry reconciliation 完成。

#### Promotion 後 ancestry reconciliation

Rules subset promotion 後，固定 `PROMOTED_PRODUCTION_TAG=<本次 exact production rules tag>`；任一 exact ref 無法唯一解析即 fail closed。

```bash
git fetch origin --tags
CANDIDATE_MAIN_SHA=$(git rev-parse 'origin/main^{commit}')
node .devpro/scripts/detect-branch-base.mjs --reconciliation-status --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"
```

- `graph-only` MUST 同時為 conflict-free 且 resulting merge tree 等於 candidate main tree，並保留真實 merge parent 與 zero tree delta → release-lane back-merge：當輪 `release/rules-YYYYMMDD[-n]` branch 上 `git merge --ff-only "$PROMOTED_PRODUCTION_TAG"`，push 後開 PR 回 `main` 以 regular/no-ff merge；只有此當輪 back-merge 為 exemption-eligible；MUST NOT 用 squash、rebase、`-s ours` 或 patch-equivalence 代替 ancestry。
- ff-only 失敗、release branch 已 prune、事後才發現缺口，或 `content-review-required`（MUST 走一般 content review 與 tests，且 MUST NOT 為 exemption-eligible，不得搭 graph-only back-merge）→ 轉 `git-branch-production-ancestry-repair.md`。
- reconciliation PR merge 後 MUST re-fetch `origin/main` 並重新取得 `CANDIDATE_MAIN_SHA`，再執行 `node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"`；只有 exit 0 才可回報 complete。

Gate 通過後，從 reconciled tag 建下一 rules change 的 `git diff origin/main...HEAD` 必須維持 own-change-only three-dot。

Rules Lane 對 Step 6 § 分支清理之加強要求：`production-YYYYMMDD-rules[-n]` tag pushed 後 **MUST** dry-run `node .devpro/scripts/prune-rules-lane.mjs` 並回報 local branch/worktree/ineligible（無則 `no candidates`）；未回報前不得宣告 Rules Lane release 完成。此要求只授權 dry-run；`--exec`/刪除仍須使用者同意，且不得早於 ancestry reconciliation 完成。**MUST NOT** 用 `prune-merged-local.mjs --include-unshipped-mainline` 當 rules lane 收尾（會掃到未上 production 的 `feature/*`）。

#### Cross-session merge readiness evidence

`pre-tool-gate.mjs` 不以 transcript regex 當 `gh pr merge` hard gate；state-based PR gates 負責 enforcement。merge session **MUST** surface `devpro:pre-pr` / validation evidence，且 high-output host 用 capture recipe：

```bash
openspec validate --strict --all
node .devpro/scripts/capture-command.mjs --topic openspec -- openspec validate --strict --all
```

需要 `bash -lc` 時依 `platform-adapters/codex.md` 載入 Node 20；log 預期 `Totals: <N> passed, 0 failed`，只回 rc/line+byte/log path。若為 `No items found to validate.`，改跑 `dp-reviewer` read-only readiness verdict mode；evidence MUST 含 PR number、head SHA、validation evidence/log path 與 `verdict`。這是 not cross-model sticky，不得改用 `devpro:second-review`/second-reviewer，且不得混用 exemption；需授權則進 `SubagentAuthPending`。禁 `DEVPRO_HOOK_BYPASS=1`，也不得新增 transcript `checkMergeGate` regex。

#### 不變式

**不變式**：`release/rules-<YYYYMMDD>[-<n>] ⊆`（最近 `production-*` tag **或** 合法 first-rules-release `FIRST_BASE`＝`origin/production` tip）＋該批 rules sync commits。唯一例外是 §Carrier ancestry repair：carrier 另含 `origin/production` tip exact tag 可達的 commits、修復 merge 與其 PR merge commit，且 carrier tree 不變（zero tree delta）。違反此不變式的 release 視為污染，須立即 rollback。

**Mode／exec-bit**：rules sync commit MUST 已含 synced `100755` mode（`git diff --cached --summary` 於 rules lane 驗證）。`--sync` 在 `release/*` **跳過** index `--chmod=+x`（仍可 copy 內容）以避免 stage 殘留 mode。若 release worktree 仍見 mode drift，視為 rules lane 漏帶 → **回 rules lane 補**；**禁止**在 `release/*` 開任意 `git restore`／mode-only restore 例外（`pre-tool-gate` Protected-branch restore bans 不放寬）。
### 與業務 release 區隔

- **獨立 release lane**：`release/rules-<date>[-<n>]` ≠ 一般 `release/<YYYYMMDD>-<shortSHA>`
- **獨立 production tag**：`production-YYYYMMDD-rules[-<n>]` 後綴標示 consumer rules lane release（與 `production-YYYYMMDD[-<n>]` 區分）
- **同日多次規則上線**：第一版用 `production-YYYYMMDD-rules`；第二版起用 `production-YYYYMMDD-rules-2`、`-3`，必須對應 `release/rules-YYYYMMDD-2`、`-3`
- **免 consumer 版本 bump**：規範升級不影響應用功能，不要求 consumer bump version；`bump-v<X.Y.Z>` 強制條款本 lane 豁免
- **永遠優先進 main**：若同期有 feature subset release，consumer rules lane 優先 merge；feature subset 在後從新 `production-*-rules` tag rebase

### SIT/UAT/PAT smoke only

`rules/` lane 不跑業務情境驗收，重點驗 dev tool 一致性：
- **SIT**：root `sync-agent-rules.mjs --check` pass + hook 不爆
- **UAT**：root `devpro-doctor.mjs --consumer-smoke` pass + CI workflow 不爆 + multi-runtime parity test 全綠
- **PAT**：對 archived feature branch 名跑 `pre-tool-gate.mjs` 確認無 regression（per add-rules-prefix-lane Q9 / F-Con-2）

  **前提（缺一即假綠）**
  - cwd MUST 為真實 **devpro-managed** repo（含 `.devpro/`）；否則 gate no-op／pass-through。
  - 待測 branch MUST 由實際 checkout 的 `HEAD` 決定；**禁止**用第二參數／覆寫欄假裝測某支。
  - MUST 含 **負面對照**（negative control）；未觸發預期訊號 → harness 無效，PAT **MUST NOT** 回報 PASS／「無 regression」。良性 pass-through **不足以**單獨證明 harness 有效。

  **最小可執行 recipe**（操作者填變數後照抄；唯一 SSOT＝本段）：

  ```bash
  REPO_ROOT="<release-worktree-repo-root>"
  BASE_REF="<release-branch-or-tag-or-sha>"
  ARCHIVED_BRANCH="<archived-feature-branch-name>"
  PAT_ID="$$-$(date +%Y%m%d%H%M%S)"
  WT_PATH="$REPO_ROOT/.worktree/pat-${PAT_ID}"
  CREATED_BRANCH=0
  OWNED_WT=0
  OWNED_MARKER=""
  OWNED_OID=""

  cleanup() {
    cd "$REPO_ROOT" 2>/dev/null || true
    if [ "$OWNED_WT" = "1" ] || { [ -n "$OWNED_MARKER" ] && [ -f "$OWNED_MARKER" ]; }; then
      git -C "$REPO_ROOT" worktree remove --force "$WT_PATH" 2>/dev/null || true
      [ -n "$OWNED_MARKER" ] && rm -f "$OWNED_MARKER" 2>/dev/null || true
    fi
    if [ "$CREATED_BRANCH" = "1" ] && [ -n "$OWNED_OID" ]; then
      tip="$(git -C "$REPO_ROOT" rev-parse --verify "refs/heads/$ARCHIVED_BRANCH^{commit}" 2>/dev/null || true)"
      if [ "$tip" = "$OWNED_OID" ]; then
        git -C "$REPO_ROOT" branch -D "$ARCHIVED_BRANCH" 2>/dev/null || true
      fi
    fi
  }
  trap cleanup EXIT

  test -d "$REPO_ROOT/.devpro" || { echo "PAT invalid: not devpro-managed"; exit 1; }
  test ! -e "$WT_PATH" || { echo "PAT invalid: WT_PATH collision"; exit 1; }

  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$ARCHIVED_BRANCH"; then
    git -C "$REPO_ROOT" worktree add "$WT_PATH" "$ARCHIVED_BRANCH" \
      || { echo "PAT invalid: worktree add failed"; exit 1; }
    OWNED_WT=1
    CREATED_BRANCH=0
  else
    git -C "$REPO_ROOT" worktree add "$WT_PATH" -b "$ARCHIVED_BRANCH" "$BASE_REF" \
      || { echo "PAT invalid: worktree add -b failed"; exit 1; }
    OWNED_WT=1
    CREATED_BRANCH=1
  fi

  cd "$WT_PATH" || { echo "PAT invalid: cd worktree failed"; exit 1; }
  test "$(git rev-parse --abbrev-ref HEAD)" = "$ARCHIVED_BRANCH" \
    || { echo "PAT invalid: checkout mismatch (must equal ARCHIVED_BRANCH)"; exit 1; }

  if [ "$CREATED_BRANCH" = "1" ]; then
    OWNED_OID="$(git rev-parse HEAD)" \
      || { echo "PAT invalid: cannot record owned OID"; exit 1; }
  fi

  OWNED_MARKER="$WT_PATH/.pat-owned-$PAT_ID"
  printf '%s\n' "$PAT_ID" > "$OWNED_MARKER" \
    || { echo "PAT invalid: cannot write ownership marker"; exit 1; }

  # 正向對照（不足以單獨證明 harness）
  printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git status --short"}}' \
    | node .devpro/scripts/hooks/pre-tool-gate.mjs

  # 負面對照（MUST）：structured JSON／hookSpecificOutput reason 須含 Commit attribution gate + footer
  NEG_OUT="$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m no-footer"}}' \
    | node .devpro/scripts/hooks/pre-tool-gate.mjs 2>&1 || true)"
  printf '%s' "$NEG_OUT" | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const raw = readFileSync(0, "utf8").trim();
  let obj;
  try { obj = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}\s*$/);
    if (!m) process.exit(2);
    obj = JSON.parse(m[0]);
  }
  const reason = String(
    obj?.hookSpecificOutput?.additionalContext
    ?? obj?.hookSpecificOutput?.reason
    ?? obj?.reason
    ?? JSON.stringify(obj)
  );
  if (!/Commit attribution gate/.test(reason) || !/footer/i.test(reason)) process.exit(3);
  ' || { echo "PAT invalid: negative control did not fire (structured signal missing)"; exit 1; }
  ```

  負面對照未觸發（structured 訊號缺失）→ PAT 結果 **不成立**，不得回報 PASS。

理由：rules 只改 dev tool（AI rules / hook / CI workflow），不改 runtime 行為；hotfix「SIT/UAT 可縮短不可省」精神套用到 consumer rules lane → smoke only。

### CI 失敗 rollback

若 release/rules-* merge 進 production 後發現破壞性問題（hook 把全 PR 鎖死、CI workflow 失靈），走 `hotfix/revert-rules-<date>` carrier lane（**MUST NOT** 直合 `production`，即使 carrier lane 本身被打壞也一樣，見 `rules-flow-rollback.md` §Rollback SOP「Broken carrier lane 不得旁路」）：

詳細 rollback SOP（5 步流程 + revert commit message 推薦格式）見 `rules-flow-rollback.md` § Rollback SOP。

要點：
1. `ANCHOR_TAG`＝最新 `production-*` tag（拓撲判定，兩族皆計入，非限 `production-*-rules`）；自 `ANCHOR_TAG` cut `release/rules-<YYYYMMDD>[-n]` carrier；另自同一 `ANCHOR_TAG` 建 `hotfix/revert-rules-<date>[-n]` 分支，在該分支上 `git revert -m 1 <merge>` 產生 revert unit，開 PR 向該 carrier（base＝carrier，非 `production`；**禁**在 carrier 上直接 revert）；merge 進 carrier 後，push carrier → 開 carrier 自己的 PR（head＝carrier，base `production`）→ GitHub merge → resolve exact production PR merge commit → freshly fetch `origin/production` 驗證 → tag explicit commit → push only the tag ref；再以既有 back-merge PR 流程合回 `main`
2. Rollback 後須開新 `rules/agent-rules-v<X.Y.Z>` 重做（不直接 fix-forward）
