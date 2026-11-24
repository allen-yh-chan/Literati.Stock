---
name: git-branch-naming-and-anchor
description: 分支命名、anchor 計算、可促進單位乾淨前提與分支依賴的權威規範。觸發：建分支前、決定 base、處理 feature 依賴鏈時。
---

# Git：分支命名與 Anchor

## Overview

覆蓋：pull 同步、前綴決策、anchor、可促進單位乾淨前提、分支依賴。

關鍵約束：可促進單位只含自己的 commits；從 anchor 建、`hotfix/` 從最近 `production-*` tag 建；分支名與 OpenSpec change 名一致（kebab-case）。`<name>` 一動詞一 scope／動詞白名單見 `preflight-checklist.md` 點 1–2（SSOT）。

## When to Use

- 開始新需求（建可促進單位或旁路分支）前
- 回到既有可促進單位分支繼續實作時
- 建立 `hotfix/` 旁路分支前
- 處理 feature B 依賴 feature A 的分支依賴鏈時

## Process

### 開始實作前：先 pull 同步

實作前（新分支/修 bug/回既有分支）先同步本地與 remote；**禁止**在過時 base 動工。

**強制步驟：**

1. **同步 remote refs**（不切 main、不寫 checked-out local branch）：`git fetch origin --tags`——更新 `origin/*` 與 tags；**禁用** `git fetch origin main:main --tags` 作通用開工指令（任一 worktree checkout `main` 時 Git 拒絕 fetch into checked-out branch）。更新本地 `main` 只在 `main` worktree clean 且無 divergence 時 `git pull --ff-only`；divergence 停下釐清，**禁**擅自 merge／rebase。
2. **既有可促進單位分支繼續做**：先進入該分支既有 worktree 後 `git fetch origin` 並檢查 `git status`，有新 commit 即 `git pull`；若 worktree 不存在，依下方「既有分支但 worktree 不存在」重建。**禁**在 main worktree 直接 `git checkout <branch>`。
3. **新建可促進單位分支前先驗 production ancestry**（`feature/`、`bugfix/`、`chore/`）：有合法 latest production tag 時先跑 `detect-branch-base.mjs --require-main-ancestor …`（非 0 才 `--reconciliation-status`；禁 fallback `origin/main`）。缺 tag → Evaluation order：first-import 七項 → `ancestry gate: N/A`；否則 pre-first-release 四項 → `ancestry gate: N/A (pre-first-release)`；否則 fail closed。不得捏造／推論 tag。
4. **新建可促進單位分支**：ancestry gate 通過後從 anchor 建，不從 main 建；anchor 由 `node .devpro/scripts/detect-branch-base.mjs --anchor` 計算。
5. **新建旁路分支**（`hotfix/`）：從最近 `production-*` tag 建。

**例外**：offline 工作需明說「離線狀態，base 為 `<commit>`，恢復連線後先 pull 確認」；使用者明確指示「不要 pull」時記錄，第一個 push 前提醒。

> Load-chain（缺 legal production tag 的 N/A 判定）：步驟 3 缺 tag 時 MUST 先讀 `git-branch-no-tag-ancestry-evidence.md`（first-import 七項／pre-first-release 四項證據 SSOT）；未逐項驗證 MUST NOT 記錄 `ancestry gate: N/A` 或 `ancestry gate: N/A (pre-first-release)`，兩者皆不成立 → fail closed。

### 分支前綴對照表（唯一權威）

**禁止**在 `main` / `master` / `integration` / `release/*` / `production` 上直接實作；需求開發必須走可促進單位或旁路分支。

工作分支命名：`<prefix>/<簡短說明>`，必須與 OpenSpec change 名稱一致（kebab-case），例如 `feature/add-export-retention` 對應 `openspec/changes/add-export-retention/`。僅本機 PR 驗證的命名例外見下方「本機 PR 驗證」。

> **目標輪不進分支名**：可促進單位的目標 release 輪次 MUST NOT 編碼進分支名。理由：(a) `release/<YYYYMMDD>-<shortSHA>` 的 `<shortSHA>` 在 release 時才確定，單位無法預先標到；(b) 延期會連帶要求改分支名與 OpenSpec change 名，成本高且易漂移；(c) 分支名 MUST 與 OpenSpec change 名 kebab-case 一致，塞日期會破壞該契約。改期只改 PR milestone（SSOT 與查詢見 `release-sit-uat-pat-prod.md` §Subset selection handoff 與 `release-step-1-7.md` Step 1；延期情境見同檔 Step 6 改期）。

> **不重用分支名、不收 fork PR、不支援同分支部分上線**：可促進分支 MUST NOT 重用已用過的分支名；可促進單位 MUST 由本 repo 分支發 PR，不收 fork PR；不同梯次上線的修改 MUST 開不同分支（同一分支不支援部分上線）。**重用**定義：分支已刪除、或已上線（見 `release-step-1-7.md` Step 1 `unit_released`）後，以同名建立新 lineage；在未上線的分支上繼續開 PR（三態／四態設計的主要支援情境）不算重用。違反時的偵測與停點見 `release-step-1-7.md` Step 1。

AI 自取名稱、建 worktree／分支前：**先**對照 `preflight-checklist.md` 點 1-2；僅 kebab-case 或僅語意描述**不足**。

PreToolUse Gate 11 會 hard-block 支援的 literal branch create/rename/PR head target（含 `git worktree add -b`）中非白名單動詞；dynamic shell token 不由 hook 猜值，仍須靠 preflight 自檢。

| 情境 | 分支前綴 | 基底 | 合回目標 | 走 release subset？ |
|---|---|---|---|---|
| 新功能 / 行為變更 | `feature/<name>` | **anchor** | `main` → 可被 release 挑 | ✓ |
| 修 bug（不急，跟 release 走） | `bugfix/<name>` | **anchor** | `main` → 可被 release 挑 | ✓ |
| 技術雜事（Dockerfile、CI、依賴升版、docs、repo config） | `chore/<name>` | **anchor** | `main` → 可被 release 挑 | ✓ |
| 緊急修復／verified already-live repo-missing backfill | `hotfix/<name>` | **最近 `production-*` tag（僅此）** | 經 release carrier（source `release/v*`；consumer `release/<YYYYMMDD>-<shortSHA>[-<n>]`）→`production`→tag→carrier ff＋一次 back-merge PR 回 `main`；完整 mechanics 見 `release-hotfix-carrier-policy.md`；已上線回補記錄與直合事故補救見 `release-already-live-backfill.md` | ✓（source／consumer 同構，皆經 carrier 組裝） |
| 規範同步 | `rules/<source>-v<X.Y.Z>` | 先驗 exact production tag 為 candidate `origin/main` ancestor；divergence 必須先跑 reconciliation classification，分類完成前不得宣告 bounded repair，且禁止用 `origin/main` fallback 繼續普通 sync；production anchor 留給 `release/rules-*` | `main` → `release/rules-<date>[-<n>]` → `production` | ✓（**獨立 lane，smoke only**） |

> **基底統一**：`feature/`／`bugfix/`／`chore/` 從 **anchor**；`hotfix/` 一律從最近 `production-*` tag（禁 `release/*`／`main` fallback）。無 `production-*` tag：先排除漏打／誤刪／`git fetch` 漏 `--tags`／規範引入前歷史；能補就補，確實不可能才降級 `bugfix/`（見 `release-sit-uat-pat-prod.md`「hotfix 基底固定規則」）。唯一例外：feature B 依賴 A 時從 `feature/A` 建。consumer rules 從 anchor（優先序含 `-rules`），走獨立 lane（見同檔 Rules Lane）。
>
> **`bugfix/` 一律為可促進單位**（合回 `main`，走 release subset 促進到 PROD）。需緊急修復 PROD 的修復使用 `hotfix/`（經 release carrier 進 production，見 `release-hotfix-carrier-policy.md`）。
>
> prefix 表示 promotion path/state，非作者；來源記 PR/commit/OpenSpec。not-yet-live nonurgent → promotable；defect semantics 才用 `bugfix/*`。

> **`rules/` 分支命名格式**：`<source>` 須在 `preflight-checklist.md` rules-source-whitelist marker 區塊內（初值 `agent-rules`）；版本段必須是 source repo `production` tip 對應 `production-v<X.Y.Z>` tag 正規化後的 `v<X.Y.Z>`。例：`rules/agent-rules-v6.39.0`。`rules/<source>-<YYYYMMDD>-<sha>` 已退役，`branch-naming.mjs::RULES_BRANCH_RE` 與流程檢查會拒絕。

**正常工作分支規範只承認五種前綴**：`feature/`、`bugfix/`、`chore/`、`hotfix/`、`rules/`；release 格式依上表，本機驗證另有下列 `review/pr<N>` 專用例外。**禁止** `fix/`、`bug/`、`feat/`、`refactor/`、`test/`、`docs/`、`sync/` 等其餘前綴。

> **兩層白名單**：prefix 白名單就是上面五個（加 release／review 例外）；verb 白名單（`preflight-checklist.md` marker 區塊）只約束 prefix 之後 `<verb>-<scope>` 的第一段。`fix`／`docs`／`wire` 等是 verb，不是 prefix——`docs/update-x` 仍不合法，必須寫成 `chore/docs-update-x`。

### 本機 PR 驗證

需要 checkout PR head 執行本機測試／重現時，可建立 `review/pr<N>`（`N` 為無前導零的正整數），worktree 使用 `<repo-root-abs>/.worktree/pr<N>-review`，基底為該 PR 的已確認 head SHA。純讀取 PR diff／comments 不要求建立 review worktree。此驗證用途不建立 OpenSpec change，也不套用 change／branch／worktree 三方同名；若要提交修正，另開正常工作分支並走對應流程。

`review/` namespace **僅本機**：MUST NOT push，也不得作為 PR head（含 fork-qualified head、改名 refspec、`HEAD` 指向 review checkout）。命名豁免不是 promotion/release 豁免。PreToolUse 在 create 時檢查 literal／可解析 current head；merge 時讀 GitHub actual head，git-native pre-push 依 structured refs 擋 publication，獨立於 rigor level（`off` 也不豁免）。Native hook 載入失敗時修復 hook/helper 安裝或 checkout 完整性。這些是本機防護，不能取代遠端 protection。

驗證完用 `git worktree list` 確認註冊路徑與 branch。清理先跑 `node .devpro/scripts/prune-merged-local.mjs`，具名取得刪除同意後用 `--force-delete review/pr<N>`；不依賴 PR 是否 merge 或 tip 是否已上 PROD，批次 `--exec` 不自動移除 review branch／worktree，沒有掛 worktree 的 ref 亦同。安全 dependency-link teardown 與主 checkout 不變量沿用 `git-branch-hygiene.md`「Worktree」規範。

### Worktree 規範（per change，per branch）

**粒度**：per change（per branch），**非 per agent**。同一 change 多 agent 串行交接時共用同一 worktree+分支（見 `multi-agent-handoff.md`）。

**所有在主 worktree 開/切換分支（`git checkout -b` / `git switch -c` / 既有分支 checkout）一律走 worktree，無前綴例外。** 不開分支的操作（`devpro:sync-rules` submodule 配置如 `git submodule set-branch`〔不自行 commit，`.gitmodules` diff 留 rules/ lane step 5 提交〕、純讀取、plain `git branch <name>` 只建 ref 不切換；**checkout/switch 到 protected 主線分支（`main`/`master`/`production`/`integration`）除外（回主線非開工作）**）不在此範圍，可在主 working tree 操作。已在 worktree 內不重複開。

**路徑慣例**：`<repo-root-abs>/.worktree/<change-name>`（main repo 子目錄；單數 `.worktree`；`.gitignore` baseline entry 由 `gitignore-alignment.md` 管理）。`<repo-root-abs>` = `git rev-parse --show-toplevel`；Gate D 強制絕對路徑（PR #395），且必須在 `.worktree/` 根層（Gate D 前綴檢查）。

`<repo-root-abs>` 翻譯：接受形式以 `openspec/specs/pre-tool-mechanical-gates/spec.md` Scenario `Safe shell-expansion forms pass through` 為 SSOT。

- **接受**：subshell inline `$(git rev-parse --show-toplevel)` / `$REPO_ROOT`（須同 cmd 賦值）/ 純絕對路徑
- **禁用**：自訂變數名（如 `$ROOT`，Gate D 只字面接受 `REPO_ROOT`）/ `~`（不展開）/ 純相對路徑（無 abs cd anchor）

**全部 dp-\* 委派（dp-analyst／dp-architect 亦同）一律在 change worktree 內**：pre-flight docs 亦屬 repo write，禁在 main cwd 寫（SSOT `devpro:change` 第三步）。

**標準開工序列**（與 `devpro:change` 批次同意一致；見 `git-branch-and-pr-flow.md`）：

```bash
# consumer repo 路徑；source repo 將 .devpro-agent-rules/ 前綴去掉
ANCHOR_JSON=$(node .devpro/scripts/detect-branch-base.mjs --anchor)
# canonical detection 證實 legal latest production tag 時：
node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref <production-tag> --main-ref origin/main
# genuine no-tag first import → ancestry gate: N/A
# adopted, pre-first-release（四項證據）→ ancestry gate: N/A (pre-first-release)
# 其他缺 tag → fail closed 停下
ANCHOR_SHA=$(printf '%s\n' "$ANCHOR_JSON" | jq -r .sha)
git worktree add <repo-root-abs>/.worktree/<change-name> -b <prefix>/<name> $ANCHOR_SHA
cd <repo-root-abs>/.worktree/<change-name>
pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch
git submodule update --init --recursive   # consumer 必須；source repo no-op
# 環境就緒後（nvm／Node／CLI 已就緒；見 environment-setup-nvm-nodejs-openspec.md）：
# 依技術棧安裝本 worktree 專案依賴（依賴目錄不隨 worktree 複製而來）。
# Node：package-lock.json／npm-shrinkwrap.json → npm ci；yarn.lock → yarn install --frozen-lockfile；pnpm-lock.yaml → pnpm install --frozen-lockfile（MUST NOT 對 yarn／pnpm 跑 npm ci）
# .NET（有 *.sln／*.csproj）→ dotnet restore；無棧 → N/A＋偵測依據
# MUST NOT：以 junction／symlink／hardlink 共用主 checkout（或其他 worktree）的 node_modules／NuGet 等依賴目錄
# 若目標依賴目錄已是 symlink／junction／reparse → MUST NOT npm ci／等價刪裝、MUST NOT rm -rf；改 blocked／not verified 停點
# 歷史空殼／移除前置：見 git-branch-hygiene.md「Local Worktree Hygiene」（註冊 wt 刪前拆 reparse；orphan 預設 advisory；具名復原與 .git 殘留限制見同 leaf；禁標準化 junction）
```

上列 gate command 適用於 canonical detection 已回傳合法 production tag 的普通 change；沒有 tag 時不得把空字串帶入 gate。可記 N/A 的合法無-tag 僅兩種：genuine first-import（`ancestry gate: N/A`）或 adopted pre-first-release（`ancestry gate: N/A (pre-first-release)`）；其他缺 tag 狀態一律停下釐清。

**專案依賴（環境就緒後）**：`git submodule update` 之後、第一個 implementation write 之前，MUST 依 `environment-setup-nvm-nodejs-openspec.md` 在**本 worktree**安裝專案依賴。文案義務是「**環境就緒後**」才裝——**不得**暗示可在 Node／CLI 就緒前跑 `npm ci`。依賴不隨 worktree 而來；**MUST NOT** 以 junction／symlink／hardlink 共用主 checkout（或其他 worktree）依賴目錄作為標準或建議路徑。目標依賴目錄若已是 link／reparse → **MUST NOT** `npm ci`／等價刪裝、**MUST NOT** `rm -rf` 該目錄，改走 Stop-Point `blocked`／`not verified`（見 `ai-autonomy.md`）。歷史 junction 空殼與註冊 worktree 移除前置拆法見 `git-branch-hygiene.md` Local Worktree Hygiene（本 leaf **不**重開標準化）。

Codex / hook-visible cwd 注意：`functions.exec_command.workdir`、UI 顯示 cwd、或 statusline 顯示 worktree 不等於 PreToolUse hook 可見的 cwd evidence。`git worktree add` 後下一個 Bash 必須含 literal `cd <abs-worktree>`（如上）才能清 post-creation sentinel；後續 git write 在 Codex host 一律用 `git -C <abs-worktree> ...`，且 `git add`／`git commit` 分兩次呼叫（串接會使 commit-time gate 退為 `checked=false`）。`move_agent_to_root` → `platform-adapters/cursor.md`。session 在另一個 repo 時可不寫 `cd`：`git -C <target-repo-abs> worktree add <target-repo-abs>/.worktree/<change-name> -b <prefix>/<name> <base>`，Worktree Absolute Path Gate 以 `-C`（或前面的 `cd`）指向的 repo 判定 `.worktree/`；跨 repo 寫入仍要 `DEVPRO_REPO_SCOPE_APPROVED=<repo>`（裸 repo 名；origin repo 名（小寫）與舊路徑 basename 皆可）；PR create／edit／comment 改用 `DEVPRO_CROSS_REPO_PR`（`tool-selection.md`）。

Worktree Mandatory 例外：子模組指標更新（`git -C <submodule> checkout <tag|sha>`，ref 非分支，且該路徑是 parent `.gitmodules` 已登記的 submodule path）不屬開／切分支，W1 不擋；子模組的分支 checkout／create 仍在射程內。

`detect-branch-base.mjs --anchor` 的 `.sha` 是建分支 SSOT；`.ref` 只供顯示/診斷，可能是未建立本地 ref 的 release branch 名稱，禁止拿 `.ref` 當 `git checkout` / `git switch` / `git worktree add` base。

### 動手前 anchor-divergence 自檢（touch set）

建分支後、動手寫第一行程式碼前，對 touch set 執行分歧自檢，及早偵測 anchor 落後 `origin/main` 所造成的潛在衝突。

**自檢指令（對每個 touch 檔案）：**

```bash
git diff <anchor-sha>..origin/main -- <touch-files>
```

此指令揭露兩種失敗模式：

**(a) dangling cross-reference（cooperative-only）**

本次引用的 rule section / anchor 只存在於 `origin/main`，而不存在於 anchor base；例如引用了另一未上 PROD 單位新增的 section。由於被引用的 SSOT 屬 read-but-not-touched，不會出現在 `git diff -- <touch-files>` 的視野內，**無單一機械 gate 可自動偵測**。

此半段為 **cooperative-only**：agent 在動手前人工檢視 touch set 所有引用目標的 heading/anchor 是否已存在於當前 anchor base；懷疑有 dangling reference 時停下回報，待 cross-model review 兜底。

**(b) merge conflict on the same edited line（mechanical guard）**

本次編輯的行在 `origin/main` 已被另一未上 PROD 單位改過，PR 併入時將產生 line-level 衝突。此模式可由 `git diff -- <touch-files>` 偵測到（diff 非空即有分歧）。

此半段為 **mechanical guard**（opt-in CLI，非自動 hook）：

```bash
node .devpro/scripts/detect-branch-base.mjs --touch-divergence <touch-files...>
```

回傳 per-file JSON（`file` / `divergedLines` / `clean`）；`clean: false` 的檔案代表 anchor 到 `origin/main` 之間該檔已被修改，動手前應評估是否需要 dependency 路徑或等對方上 PROD 後再建分支。

早期訊號路由進既有分流表：→ [### PR 併入 main 衝突分流](#pr-併入-main-衝突分流)（dependency / release-ordering decision point）。

**Rule-feedback Surface Matrix：**

| failure surface | carrier（SSOT 落點） | mechanical / cooperative | guard 指向 |
|---|---|---|---|
| (b) merge conflict on the same edited line | `detect-branch-base.mjs --touch-divergence` CLI mode | **mechanical**（opt-in，非 hook/pre-pr gate） | `tests/detect-branch-base.test.mjs` `--touch-divergence` 覆蓋（divergent 報出 / clean 不報） |
| (a) dangling cross-reference | `git-branch-naming-and-anchor.md` 新規範段（半段標 cooperative-only） | **cooperative-only**（read-but-not-touched SSOT 不在 touch diff 視野，無機械 gate） | 無機械 gate；由規範段 + 事後 cross-model review 兜底 |

**既有分支但 worktree 不存在**（誤刪 / 新 clone / 跨機器接手）：

```bash
git worktree list | grep <branch>          # 無命中代表 worktree 不存在
git fetch origin <branch>                  # 若 branch 只在 remote
git worktree add <repo-root-abs>/.worktree/<change-name> <branch>
cd <repo-root-abs>/.worktree/<change-name>
ls openspec/changes/<change-name>/         # 重建 worktree 後必須確認 openspec/changes/<change-name>/ 仍存在
```

**重建 worktree 後必須確認 `openspec/changes/<change-name>/` 仍存在**：worktree 內含的 OpenSpec change folder 會隨原 worktree `git worktree remove` 一併消失。重建 worktree（誤刪 / 新 clone / 跨機器接手）或因改 base 丟棄舊 worktree 後，**必須**確認對應 `openspec/changes/<change-name>/` 仍存在於新 worktree；不存在則停下補建（不得復用已 archive 的舊 folder，per `openspec-branch-routing.md`「改 base / 重建分支須新建獨立 change folder」），避免到 `devpro:pre-pr` archive gate 才發現缺 active change folder。

**禁**在 main worktree 執行 `git checkout <branch>`（main worktree 永遠在 main 分支）。

**清理**（PROD tag push 後，per `git-workflow-tracking.md`）：刪分支 / worktree **不可逆，一律須使用者明示同意**。唯一入口 `node .devpro/scripts/prune-merged-local.mjs`（dry-run）→ 取得同意後 `--exec`（由該 script 代執行 worktree remove + branch delete，含 submodule 處理；見 `git-branch-hygiene.md`）。**禁**在規則正文照抄裸 `git branch -d` / `git worktree remove` one-liner 手動執行；未取得同意前**禁**自行清理。

**Verification**：`git worktree list` · `git -C <repo-root-abs>/.worktree/<change-name> branch --show-current`

| 藉口 | 反駁 |
|---|---|
| 「in-place `git checkout` 就好」 | dirty state 污染，worktree 最低成本隔離 |
| 「source repo 無 submodule，可省」 | 規範統一；no-op 成本可忽略 |

### Anchor 判斷（機器可驗證）

優先序：(1) `git tag -l 'production-*'` 有結果 → 最近 `production-YYYYMMDD[-n]` tag（含 `-rules` 變體 `production-YYYYMMDD-rules[-n]`，以 **tag 內嵌 YYYYMMDD + 同日 suffix 序** 排序取 most recent，per `detect-branch-base.mjs`）；(2) `git branch --list 'release/*'` → `git merge-base <latest release/*> main`；(3) 都沒有 → `main` HEAD。指令：`node .devpro/scripts/detect-branch-base.mjs --anchor`

`mainAheadCommits` 僅代表 `main` 對 latest `production-*` tag 有內容差異。若 release lane 造成 `main` 有 graph-only merge commit，但 `git diff <production-tag> <main>` 為空，script 必須回傳空陣列；AI 不得因此打斷使用者詢問 dependency。

### Production ancestry repair（普通 subset / rules subset 共用）

> Load-chain（Production ancestry repair）：合法 latest consumer production tag 的 ancestry gate 非 0 時 MUST 停止普通 change／rules sync 並先讀 `git-branch-production-ancestry-repair.md`（分類指令、bounded repair branch、完成判定）；未分類 MUST NOT 宣告或建立 repair，MUST NOT fallback `origin/main`。

> **為什麼可促進單位從 anchor 建**：release/\* 會用 `git merge <單位>` 挑 subset。基底不乾淨（混入其他單位）就無法保證 subset 乾淨。
>
> **chore 不是例外**：docs/CI/Dockerfile 也要走 main → release → production。
>
> **hotfix 基底固定**：`hotfix/` 一律從最近 `production-*` tag 建以對齊線上；禁 anchor fallback（`release/*`／`main`）。無 `production-*` tag 時先排除異常；能補就補，確實不可能才降級 `bugfix/`（見 `release-sit-uat-pat-prod.md`「hotfix 基底固定規則」）。

### 可促進單位的乾淨前提

- 可促進單位分支上**只有**該單位自己的 commits（業務變更 + 規範同步 + `production-*` tag 同步 merge）
- **禁止** `merge main → 可促進單位`（會污染 subset）
- **允許** `merge <production-* tag> → 可促進單位`（同步已上線基底，不污染 subset；僅限有 `production-*` tag 時；詳見 `release-sit-uat-pat-prod.md`「Anchor Sync（長期 feature）」）
- 長期 feature（> 1-2 週）應優先拆小；無法拆時可定期 anchor sync 提前分散衝突

### PR 併入 main 衝突分流

`feature/*` / `bugfix/*` / `chore/*` PR 對 `main` 顯示 conflict 時，這不是自動 `merge main` 的理由；它是**dependency / release-ordering decision point**。AI 必須先分類衝突來源，再選路徑：

| 衝突來源 | 正確處理 |
|---|---|
| 已上 production 的變更，或此分支 anchor 已落後最新 `production-*` tag | 在本可促進單位分支 `git merge <latest production-* tag>`，解衝突後 push，PR 繼續 |
| 另一個未上 production 的可促進單位，且本分支確實依賴它 | 取得並記錄明確 dependency declaration；只 merge 該具名 dependency branch（或重建本分支於該 dependency branch），不得 merge 整個 `main`；release 必須綁定兩者 |
| 另一個未上 production 的可促進單位，但不應綁定 | 停下請使用者 / release owner 決策：先讓對方上 production、拆分/改寫、或延後本分支 |
| 衝突來源不明 | 停下並列 evidence（衝突檔、相關 commits、production tag 狀態），請使用者 / release owner 決策 |

禁止 shortcut：`git merge main`、`git pull origin main`、squash/rebase、或 cherry-pick unrelated main commits 進可促進單位。若選擇 dependency 路徑，PR description 必須寫 dependency branch / commit SHA 與「release 納入本分支時必須先納入或同時納入 dependency」。

#### 「自己的 commits」的認定範圍（明文豁免）

下列 commit 雖非業務功能本體，視為**該單位合法的一部分**，不算外來污染：

1. **規範同步 commit**（`chore: sync devpro-agent-rules (<sha>)`）：僅在 `rules/<source>-v<X.Y.Z>` lane 視為該 rules 單位自己的 commit；不得出現在 feature/bugfix/chore 歷史。
2. **單位內合法附件 commit**：`chore: simplify <scope>` 簡化 pass、測試檔（test code / `qa-test-scope.md` / prove-it）、`production-*` tag 同步 merge（`git merge <production-* tag>` 產生；僅限 `production-*` tag，merge `main` 或其他來源不在豁免內）。
3. **明確 dependency commit**：僅限 PR 併入 main 衝突分流中已由使用者 / release owner 確認的具名 dependency branch；PR 必須記錄 dependency branch / commit SHA，且 release 納入時兩者綁定。

不在此清單內的 commit 若出現在分支上（例：來自 `main` 的合併、其他 feature 的 cherry-pick、無關的 refactor），仍視為污染，須依「subset 乾淨前提」處理（`git revert -m 1` 或重新基於 anchor 建分支）。

### 分支依賴（feature B 需要 feature A）

若 B 的開發依賴尚未上 PROD 的 A：B 從 `feature/A` 建（**不**從 anchor 建）；B 的 PR 明文宣告依賴 `feature/A`；**釋出綁定** — release 納入 B 必同時納入 A（B 不得先於 A 上 PROD）；A 上 PROD 後 B 的 anchor 已被新 `production-*` tag 涵蓋，正常促進。

## Exit Criteria

- 前綴屬五種之一、與 OpenSpec change 名稱一致（kebab-case）；且該 `<name>` 通過 `preflight-checklist.md` 點 1–2
- 分支從正確基底（可促進單位 → anchor；旁路 → 最近 `production-*` tag）
- 可促進單位分支只含自己的 commits
- `git status` 乾淨

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「從 main 建分支比較快，anchor 差不多」 | anchor ≠ main HEAD；會吃進已 merge 單位污染 subset |
| 「先帶進其他 feature commit 再 revert」 | revert 會留歷史雜訊；應從乾淨 anchor 重建 |

## Verification

```bash
git branch --show-current
node .devpro/scripts/detect-branch-base.mjs --anchor
git log --oneline <anchor-sha>..HEAD
git tag --contains $(git rev-parse HEAD) | grep '^production-'
```
