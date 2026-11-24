---
name: testing-and-qa
description: TDD 循環、Bug Prove-It Pattern、專案約定測試指令對照表、QA 範圍報告；觸發：任何功能實作、bug 修復、或 PR 建立前。
---

# 測試與 QA 測試範圍評估報告

## Overview

每個 task/行為變更**必須**採 TDD（RED → GREEN → REFACTOR）；bug 修復先 Prove-It（先重現再修）。交付前產出 `qa-test-scope.md`。**Done = 程式碼 + 測試全綠 + QA 報告**。格式化工具寫入範圍 MUST touch-scoped（禁寬 glob 無聲污染 diff；SSOT `code-simplification.md` §Touch-scoped formatting／#2482）。

## When to Use

- 實作任何功能變更或 bug 修復後，準備宣告該 task 完成時
- PR 建立前的最後檢查階段
- **不觸發**：純文件修改、CI 設定調整等不涉及程式碼邏輯的變更

## Process

產品驗證入口／功能地圖的建立、執行及維護：依 AGENTS.md 對應入口載入 `project-verification.md`，使用 `devpro:project-verify`；一般單次測試不要求新增 runbook。Consumer adoption doctor 不代替產品功能驗證。

> Load-chain（DEV 驗證）：consumer repo 在 `/devpro:change` 第零步問 DEV、開 PR 前做 DEV 判定或部署驗證、寫或審查 `DEV deploy-verify:` 證據行之前 MUST 先讀 `pre-pr-dev-verification.md`（DEV 判定唯一來源，與 `.devpro/pre-pr-checks.local.md` 是否存在無關）。

### 專案約定測試指令（先辨識技術棧）

| 技術棧 | 偵測訊號 | 預設指令 |
|---|---|---|
| .NET | `*.sln` / `*.csproj` | `dotnet test` |
| Node.js | `package.json` + `test` script | `npm test`（或 `pnpm test` / `yarn test`） |
| Python | `pyproject.toml` / `pytest.ini` / `tox.ini` | `pytest`（或 `tox` / `uv run pytest`） |
| Go | `go.mod` | `go test ./...` |
| Rust | `Cargo.toml` | `cargo test` |
| 其他 | — | 讀 `README.md` / CI 檔；仍不明時詢問 |

### TDD 循環

壓力／量測測試會產生大型 evidence／log 時，在產生或入庫前 MUST 讀 `design-template.md`「大型測試證據的保存與第二審路徑」並記錄保存與審查決策；lite 可記在既有 change handoff，不要求建立 full design artifact。

1. **RED**：先寫失敗測試（若第一次就通過，測試可能沒測到正確的東西）
2. **GREEN**：最少實作讓測試通過
3. **REFACTOR**：簡化，確保仍全綠

**TDD anti-tautology**：斷言不得只鏡像實作同語（同字串／同條件抄進 expect）；須鎖可觀察行為或對外契約。與 prove-it／RED Evidence Quality 並存。

偵錯／hypothesis／命名 root cause：先具備 **red-capable／agent-runnable** 迴圈；硬閘 SSOT 見 `troubleshooting.md`（本檔不複寫閘正文）。

### RED Evidence Quality

RED 不是「測試跑紅」而已；必須確認它因預期缺口而失敗。

| 檢查 | 要求 |
|---|---|
| One behavior | 每個測試只鎖一個可觀察行為；名稱含「and」通常要拆 |
| Expected failure | failure message / assertion 指向缺少的行為，不是 typo、fixture、環境錯 |
| Real path | 優先測真實 code path；mock 只用在外部邊界不可控時 |
| Immediate pass | 第一次就 PASS → 測試未證明新行為，必須改測試或確認此 task 已無需實作 |
| Mutation landed | 以修改程式或 fixture 強制轉紅（含 revert 修正後驗 RED）時，MUST 先 diff 對照原始版本、確認改動確實落地，才可採信該紅燈；改動無聲未套用（例：取代指令沒命中）時看到的紅燈不得當 RED 證據 |
| Error instead of fail | 測試因 setup error 爆掉 → 先修測試到「正確 FAIL」，不得進 GREEN |
| shared fixture / marker-state failure | 先用 fresh fixture or isolated marker/state dir 重跑；若只在共享 state 重現，先當 fixture leak/setup gap，不得把 shared-state leakage 當作 behavior RED |

### Negative Assertion Specificity

Fail-closed／負向測例若宣稱鎖定某個 **intended failure class**（精確錯誤字串、typed reason、具名 predicate），則：

1. **Assertion**：`assert.throws`／match 必須對準該 class（exact 或 near-exact 字串，或等價 typed reason 欄）；**禁止**用可被同路徑上其他 `fail()`／rejection 滿足的 OR-union 正則當「已證明 X」。
2. **Fixture 相位**：predicate 若依賴執行階段（例：Prefer-A 在 spawn 後的 oracle-output disagreement），setup MUST 把 subject 推到該階段（例：echo／production oracle 須先在 change-base 既有且不變，再只改 validator）。停在更早的 provenance／graph／mode 拒絕＝**未**證明宣稱的 class。
3. **QA／task 驗收**：`qa-test-scope` 或 task evidence 寫「負向 fail closed」時 MUST 具名 intended failure class（字串或 reason）；只寫「oracle 相關失敗」不夠。

與上方 RED Evidence Quality「Expected failure」並存：那條擋 setup／typo 紅；本條擋「綠了但鎖錯 failure class」。

GREEN 只做讓該 RED 通過的最小變更；REFACTOR 只在測試全綠後執行，且不得增加新行為。

| 情境 | 模式 |
|---|---|
| Bug fix | **strict**：嚴禁先改 code |
| Feature（有 specs） | **standard**：先寫測試再實作 |
| 探索性 spike | **豁免**：PR 標記 `[SPIKE]`，merge 前補齊 |

### Windows spawn／dynamic import ESM

子行程內動態 `import` MUST 使用 `file://`（`pathToFileURL`／`repoFileUrl`）。Drive letter ≠ ESM path；raw abs `JSON.stringify` 進 `from …` 在 Windows 會 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（詳見 `test-performance-patterns.md`）。Windows CI matrix 非本契約 DoD。

### POC-First Trigger Gate（擴大前先驗證）

`[cooperative-only, weak enforcement]` — 靠 AI 自律；hook 難判斷「未驗證新做法」且 false-positive 高，grep test 只鎖條款文字。

**MUST 先做小範圍 POC** 當以下**兩條件皆成立**：

- (a) 該做法 / 模式 / 技術**對本 repo 未驗證**（尚無同類已驗成功的先例）；**AND**
- (b) 計畫套用範圍**≥2 處**（多檔 / 多模組 / 大範圍重構）。

兩者皆成立 → 先在**最小範圍**做 POC，產出 Verdict；唯有 `VALIDATED` 後才擴大到其餘範圍。POC 怎麼做見下方 §Spike Workflow（POC = spike，不重述步驟）。

**排除（禁過度要求 POC，任一即不強制）**：修 bug / 加欄位 / 熟悉 API 的例行變更 / 單點且可輕易回退的改動 / 已有同類驗證先例的做法。若修 bug 的根因或修法牽涉外部介接邊界，例如 API / CLI / SDK / webhook / network service / auth / file or stream I/O / process spawn，則不套用本排除，改走下方「基本功能探針 Gate」。

> 理由：未驗證做法先大規模套用，回退成本高於先 POC；先確認方向再投入規模。

### 基本功能探針 Gate（方法未證前先測真路徑）

`[cooperative-only, weak enforcement]` — 靠 AI 自律；hook 無法可靠判斷某個 probe 是否真的覆蓋目標功能，grep test 只鎖條款文字。

當變更牽涉任何外部介接邊界，例如 API / CLI / SDK / webhook / network service / auth / file or stream I/O / process spawn、host / auth / sandbox / hook / runner / process spawn 差異、串流 stdout/stderr、或其他「規範與測試可寫很多，但基本真路徑可能根本跑不起來」的功能面時，TL MUST 先做最小真路徑 probe，再擴大到 spec / tests / cross-carrier 修改。

基本功能探針要求：

1. 用最小命令、fixture、HTTP request、SDK call、CLI command、webhook payload、或 stream/file I/O sample 重現目前失敗，且必須跑在實際會使用的 runtime surface（例如需要 host auth 的 CLI 就在 host 跑，不得用 sandbox 失敗替代；對外 API 就打同等權限與同等 schema 的測試端點或 mock server，不得只驗本機字串拼裝）。
2. 用同一條真路徑驗 candidate fix，取得 `VALIDATED` / `INVALIDATED` / `PARTIAL` verdict。
3. 記錄 exact command、log path、exit code / verdict、以及「這個 probe 覆蓋哪個功能假設」。
4. probe 未通過前，MUST NOT 擴大到大批 spec、tests、docs 或 cross-carrier 同步；先回 root cause。probe 通過後，才進 OpenSpec / TDD / 測試契約更新，把已驗證的方法固定下來。

此 gate 不豁免 OpenSpec / TDD / QA；它是進入正式實作前的 spike/prove-it 防呆，用來避免把錯方法寫進規範、測試與 production code。若基本功能探針失敗，即使文字規範或 grep tests 可通過，也不得宣告方法正確。

### 臨時改環境設定的驗證（設定全程生效）

`[cooperative-only, weak enforcement]` — 靠 AI 自律；grep test 只鎖條款文字。

為了驗證而臨時改環境設定（compose override、環境變數、feature flag、設定檔）再跑測試時，測試腳本若自己重建或重啟被測服務，會默默還原設定，跑出無效的通過（實例：e2e 腳本自帶 `docker compose up -d`，沒帶到 override 就重建 container，縮小埠範圍的洩漏驗證實際跑在預設範圍上）。

1. 套用前先讀測試腳本，確認它會不會重建或重啟被測服務；會的話，把 override 放進腳本實際讀的設定來源（例如 `COMPOSE_FILE`），不要只在腳本外手動套用一次。
2. 測試前後各斷言一次：被測實例身分不變（container id／PID），生效設定值等於 override 值；把兩次斷言結果寫進驗證證據。
3. 任一斷言失敗，或證據裡沒有這兩次斷言，該次結果作廢，不得當驗收證據；修正後重跑。

### Committed-Diff Whitespace Push Gate 有效範圍

Source repo 的 `git push` / PR-create push gate 會檢查 committed diff range `origin/main...HEAD`。若 `origin/main`、effective cwd、或 git probe 不可解析，gate 保持 fail-open，但 hook 必須輸出 effective-scope advisory，包含 `checked=false`、reason、effective cwd、以及 range/base；不得靜默 pass，避免把 infra uncertainty 誤讀成 clean committed diff。

此 `checked=false`／`pass (no changed files vs <base>)` 輸出是 `design-core.md` §10（Environment-Dependent Gate Effective Scope）兩態空／未驗輸出的**實例**——base 不可解 ≠ `no applicable files`／`checked=0`；通則與自問句以 §10 為 SSOT，本段不另發明第二套。

乾淨且已完整檢查的 push 不應輸出此 advisory；有明確 trailing whitespace offender 的 committed diff 仍 hard-block。

**環境不可執行／pre-PR 測試跑不動**：走 `ai-autonomy.md` §Stop-Point「環境不可執行」專條——標 `blocked`／`not verified`，禁 junction／假綠 workaround。

**第三方 CI base 可解（pointer only）**：第三方工具（如 `pretty-quick`）若依賴 shallow clone 的 merge-base，作者／CI 前置應保證 base 可解（consumer 先例：`fetch-depth: 0`）。本 repo **不**為此重寫無關 workflow／pretty-quick 行為；見 `design-core.md` §10。

### Spike Workflow（探索性實驗）

Spike 只用於回答「是否可行 / 哪個方案可行」；它不是 production path。

| 步驟 | 要求 |
|---|---|
| Question | 把想法拆成 1-5 個可驗證 feasibility questions |
| Build | 只做最小可觀察原型；避免正式架構、套件升版、CI/CD、DB schema |
| Verdict | 產出 `VALIDATED` / `PARTIAL` / `INVALIDATED`，列 worked / did not work / recommendation |
| Boundary | Spike 產物不得直接 merge 成 production code；要進正式變更時，回到 OpenSpec + TDD |

PR 若保留 spike artifacts，必須標 `[SPIKE]` 並明示 cleanup / follow-up；正式 implementation PR 不得靠 spike 成功當作測試證據。

### Bug 修復 Prove-It Pattern（強制）

1. 先寫能**重現 bug** 的測試（修復前必須 **FAIL**）
2. 確認測試確實 FAIL
3. 寫修復碼
4. 確認測試 PASS + 既有測試無回歸

**嚴禁**先改實作再補測試。若已先改，必須 revert → 確認 RED → 重新套用修復；revert 是否真的落地，依上方 RED Evidence Quality 的 `Mutation landed` 列確認。

若已先改但 revert 成本高，最低補救是拆出 patch / stash，先寫並確認 RED，再重新套用修復；不得直接用已通過的回歸測試替代 RED 證據。

### TDD 豁免條件

免 TDD 循環，但仍須測試指令全綠：純文件（`.md`）、CI/CD workflow、DB DDL script、環境設定檔（`.env.example`）、OpenSpec 文件（`openspec/changes/` 下）。

**不得豁免**：任何修改 `*.cs`、`*.ts`、`*.js`、`*.py`、`*.go`、`*.rs` 等程式碼的變更；API 契約修改；商業邏輯修改。

### Test Contract vs Requirement Semantics

Mechanical guard tests（grep lock、projection test 等）鎖的是**當前需求語義**，不是 legacy test 所鎖的歷史意外。需求已在 rule/spec/OpenSpec 確認正確，但既有測試仍 assert 舊語義時 → **在同一 change 內 update the test contract**（含 spec delta 與 affected carrier），而非為讓舊測試過關扭曲 impl、projection 或 rule 正文。

**MUST NOT**：legacy test 不得凌駕正確需求——禁為滿足舊 assertion 而改實作或文件使語義失真。

**Intentional exception**：host projection 若有文件化 SSOT override（例：`devpro:second-review` 以 common skill + `platform-adapters/<host>.md` + `primary_family` 為準，而非預設 cite 主 host 的 projection path），測試須 exempt 或改 assert override contract，並在測試檔或 rule leaf 標記為刻意例外。

產品／通用效能比較與改善依 `performance-investigation.md`；source suite 額外保留下列 cadence 與專用 profile。

### Source Repo Test Runtime Budget

> Load-chain（test suite cadence）：選 tier、跑 `run-test-suite.mjs`（`--tier unit`／`--tier fast`／`--changed <base>`／`--tier all`）、歸類新測試的 unit／integration、新增或修改觸及 spawn（git／hook／CLI／repo scan）的測試、交 final suite 或 merge 測試證據、審查測試證據（含判定某項證據缺席是否構成 finding）之前 MUST 先讀 `test-suite-cadence.md`（test suite cadence SSOT）；未讀 MUST NOT 自行決定跑或不跑 `--tier all`。不論是否已讀，每次跑測試（含 focused RED／GREEN）MUST 回報耗時，MUST NOT 把 wall-clock 寫進驗收證據。

### Full-Suite Verdict Recipe（背景 run 取真實 verdict）

背景 task harness 跑 `node --test` 時，取得的「結果」可能是假象；MUST 用 spawnSync-internal capture 取真實 verdict，不得信任 harness 自身回報的 exit code 或裸 redirect 輸出。正常 full-suite timing 使用 `test-suite-cadence.md` 的 canonical runner；本段 raw `node --test` recipe 僅用於低階診斷或 wrapper 外的真 verdict 捕捉。

**核心 recipe**：在 child process 內用 `spawnSync` 自捕 stdout+stderr（非讓 shell redirect 接管）、加 `--test-reporter=tap`、由 node 腳本自己解析 TAP summary 並 `writeFileSync` 把 verdict（`nodeExitStatus` / `pass` / `fail` / `skipped` / `firstNotOk`）寫成獨立 JSON 檔、最後 `process.exit(r.status)` 讓真實 exit code 原樣傳出（不被包裝腳本吞掉或改寫）。

**Gate exit-code discipline**：驗 gate/lint exit code 時，gate 命令須獨立執行並直接讀 `$?`（例：`node .devpro/scripts/validate-openspec-change.mjs <change> --strict; echo $?`），禁接 pipe 後讀下游命令狀態（如 `node .devpro/scripts/validate-openspec-change.mjs <change> --strict | tail; echo $?`）。若 pass/EXIT=0 與預期矛盾（照理應擋），一律當假通過重驗，換獨立命令或最小 fixture 證明後才前進。

```js
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const r = spawnSync(
  "node",
  ["--test", "--test-reporter=tap", ".devpro/scripts/tests/"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);
const out = (r.stdout || "") + (r.stderr || "");
const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] || 0);
const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] || 0);
const skipped = Number((out.match(/^# skipped (\d+)/m) || [])[1] || 0);
const firstNotOk = (out.match(/^not ok .*$/m) || [null])[0];

writeFileSync(
  ".worktree-suite-verdict.json",
  JSON.stringify(
    { nodeExitStatus: r.status, pass, fail, skipped, firstNotOk },
    null,
    2
  )
);
process.exit(r.status);
```

三警告：

- 勿信背景 task harness 回報的 exit code：實測 harness 回報 0，但 `node --test` 真實 exit 1；假陰性方向危險（紅測被當綠燈放行）。
- 勿用裸 `> file 2>&1` redirect 取 `node --test` 結果：TAP 診斷行（`# fail` / `not ok`）與 summary 走的 stream 會被背景 harness 自身的 stdout 捕捉切開，redirect 拿不到完整輸出，關鍵 fail 訊息可能整段遺失。
- 用 spawnSync-internal capture + node 自己 `writeFileSync` verdict，讓真相不可能因 stream 被切分而遺失——verdict 檔案是 node 腳本內部直接寫出，不經過會被切斷的外層 stream。

**Evidence**：PR #1462 收尾實遇——背景 harness 回報 exit 0 兩次，但 `node --test` 真實 exit 1；`spec-eof-newline-grep` 紅測差點被當綠燈放行合併。

### Hotfix 延後補齊條款（條件式）

`hotfix/<name>` 屬緊急旁路時，允許在上線後 24h 內補齊 TDD 證據與 QA 文件，但須同時滿足：

1. 上線前已完成至少一輪 smoke（核心路徑 + hotfix 影響路徑）且有執行證據
2. PR 描述明確標註「何者延後、預計何時補齊、責任人」
3. 24h 內補齊 prove-it test / 回歸測試結果 / `qa-test-scope.md`

若不符合上述 1-3，hotfix 不得宣告完成。

### QA 測試範圍評估報告

測試全綠後，用 `## QA Test Scope Template` 產出 `openspec/changes/<name>/qa-test-scope.md`，並勾選 `tasks.md` QA 任務。需含範圍、QA 重點、影響模組、風險/未覆蓋、回歸清單。

## Exit Criteria

- 專案約定測試指令全綠，零失敗
- Bug 修復有對應 prove-it test（修復前 FAIL，修復後 PASS）
- RED 證據可說明測試為何因預期缺口失敗，而不是環境或測試錯誤
- 測試程式碼在獨立測試專案（非主應用專案）
- **測試證據為 suite×HEAD／digest 綁定**：PR body / proposal / handoff 的 pass/fail 數，MUST 引用某次 canonical suite run @ 具名 committed HEAD 的 log `digest_sha256`／summary 行（`tests=`／`pass=`／`fail=`），**不是**永恆樹屬性。tip 前進（含 tip-move whitelist finalize）後，舊 suite×HEAD 證據一律 stale——MUST 在新 HEAD 重跑或重綁，**禁止**沿用 reviewed-SHA 時代的裸 pass／fail 整數。若有 fail，先用 `git diff <base>..HEAD --name-only` 判定關聯；unrelated/pre-existing 須附根因證據。**Source-only 註記**：canonical suite 收據（`notes/qa-regression-head-<change>.json`／R6）與其 `pass`／`fail=0`／digest 形狀為 source-maintainer 義務；consumer repo 以自身「專案約定測試指令」的 suite 證據為準，pre-existing／環境型失敗依本條與 `ai-autonomy.md` §Stop-Point Next Step Contract 誠實記錄，不新增機械豁免、不得冒充綠。
- `openspec/changes/<name>/qa-test-scope.md` 已產出且完整
- `tasks.md` QA 文件任務已勾選
- hotfix 情況：若採延後補齊，需在上線後 24h 內補齊 prove-it + QA 文件並關閉待補項

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「應該不會壞，不用跑測試」 | 「應該」不是驗證，跑一次只要幾秒。 |
| 「測試太慢，先跳過」 | 慢是 CI 最佳化問題，不是跳過的理由。 |
| 「先交付，之後補測試」 | 「之後」等於永遠不補。未測試不算完成。 |
| 「bug 很明顯，直接改就好」 | 沒有重現測試 = 無法驗證確實修復、無法防回歸。 |
| 「測試紅了就算 RED」 | 紅燈原因若是 typo / fixture / env，不能證明需求缺口。 |
| 「spike 可以不寫測試」 | Spike 豁免 TDD，但 merge 前仍須補齊測試。 |
| 「剛剛跑過全綠，沿用那個數字」 | pass／fail 綁 suite×HEAD／digest；tip 前進後舊數字 stale。宣稱的計數 MUST 在最終 commit HEAD 重跑取得並帶 log digest；沿用中途／舊 tip 結果是已踩過的證據失真。 |

## Verification

依技術棧執行對應指令：

```
dotnet test          # .NET
npm test             # Node.js
pytest               # Python
go test ./...        # Go
cargo test           # Rust
```

確認 0 failures；bug fix 確認 prove-it test 在清單中且 PASS。

### Parallel release QA evidence

符號依 `release-sit-uat-pat-prod.md` §Parallel release evidence symbols；R0/R1 與各自 artifact 是更新前後版本，K/P 是 create／latest finalized baseline。

使用既有下方 QA Test Scope Template／release QA 報告，僅對 `release-sit-uat-pat-prod.md` 定義的 in-scope ordinary parallel handling 追加版本／evidence 處置；原 required stages 與完整組裝驗證不減。QA 評估者提出建議，domain owner 提供證據，專案既有 release/TL 或已被授權 QA authority 核定；本文件提角色不構成任命，缺權限來源由 release owner 確認。

- **Parallel impact**：MUST 記 R0/artifact→R1/artifact、K→P 與 P→candidate，逐項評估前後輪 functional/core/boundary/error、shared-module callers/dependencies、DB/migration/data/rollback、config、API、Web/API deployed version pair 與 integration cases、runtime/build/environment；檔案三分類只是輸入，non-overlap／diff empty 不足以 N/A 或選 smoke。缺 domain／另一 repo evidence 記 unknown，由 owner 補，不自行擴跨 repo clone/write。
- **Parallel QA authority**：MUST 對每份 evidence 記 historical retain／rerun/rebind、原 suite/case／source HEAD/artifact／log digest／environment、新版本適用範圍、理由及核定 ref；列 required／selected scope、未覆蓋 cases/risks／補測 trigger、提出者、existing named authority 身分／權限來源／批准記錄。QA／AI MUST NOT 自批縮驗或略過 required stages、production approval、full validation；未能證明不受影響就保持原 coverage，舊 pass 不直接授新 artifact 資格。
- **Review material**：MUST 只包 authorized necessary release evidence；排除 credentials、PII、unrelated repositories 與未核准內容，不得因本契約擴大 read/write/disclosure authority；大型 logs 用既有可耐久接手位置、digest、版本／環境／指令與摘要，不把短命 local file 作唯一驗收錨點。

## QA Test Scope Template

QA 測試範圍報告 **markdown template**；feature / bugfix / hotfix PR 前必填，作為 Review/Ship 驗收依據。

### When to Use

- 每次 PR 建立前，由負責人填寫並附於 PR 描述
- `devpro:pre-pr` Step 1 檢查 qa-test-scope.md 是否存在時

### Process

依下方 template 填寫，存為 `openspec/changes/<name>/qa-test-scope.md`。

### Template

````markdown
## QA 測試範圍評估

### 基本資訊

- 需求/變更名稱：
- OpenSpec change：
- 分支：
- Commit：<內容 commit 的 parent SHA>..HEAD（或 merge 後由 Recap 回填；禁止為填自身 SHA 再開 commit；**禁止**要求 `tip_head`／`tested_revision`／本欄等於「即將寫入本檔之 commit SHA」——雞生蛋；見下方 Prefer PASS）
- 提交人：
- 日期：

**Head-bound Prefer PASS（#2583）**：樹內 QA／Recap 證據可用 named **parent** SHA（MUST 為 tip ancestor）＋可機械驗證的 `parent..tip` name-only diff，當且僅當 diff ⊆ R6 bookkeeping allowlist（`openspec/changes/**`、`docs/**`、`notes/**`、`README*` 等既有集合）。**排除** `.devpro/agent-rules/**`、`**/SKILL.md`、`.devpro/scripts/**`、`**/tests/**`。此 Prefer PASS **只**適用樹內證據檔，**不適用** merge-gate sticky（`last_reviewed_sha == headRefOid` 仍為硬義務）。**MUST NOT** 以 `*.cs` 當本 repo SSOT 空-diff 例。

### 1) 變更範圍摘要

- 本次主要變更：
- 涉及檔案/模組：
- 非本次範圍（明確不處理）：

### 2) 建議 QA 驗測重點

- 核心流程：
- 邊界情境：
- 例外/錯誤情境：
- 效能或並發相關觀察點：

### 3) 可能受影響模組 / 流程

- 直接受影響：
- 間接受影響：
- 相依外部系統/服務：

### 4) 風險與未覆蓋項目

- 已知風險：
- 尚未覆蓋測試項目：
- 未覆蓋原因：
- 建議後續補測：

### 5) 建議回歸測試清單

- [ ] 回歸項目 1
- [ ] 回歸項目 2
- [ ] 回歸項目 3

### 6) 測試證據（可選）

- 測試指令與結果摘要（例 `dotnet test` / `npm test` / `pytest`）：
- 主要 log 關鍵字：
- 其他證據（截圖、檔案、連結）：

### UI smoke

- ui smoke: done|waived+reason|N/A+why
- ui smoke head: <sha>
- （若 done）頁面：<URL或路徑>；非 error-state：yes；關鍵新控件 closed OK：yes；schema/readiness：verified|waived+reason
- （若 web + done）自驗：Playwright|browser；evidence：<screenshot path(s) or log ref>
- （若 done + 主題/語系已採用）theme: dark✓ light✓；locale: <生效語系清單>
````

### UI smoke（正文 SSOT）

`ui smoke: done` 限本機或臨時 instance；在 DEV 上做的檢查只記 `DEV deploy-verify:` 行（見 `pre-pr-dev-verification.md`）。

欄位字面鎖定 **`ui smoke:`**（禁落地 `host smoke:`）。模板上的 `done|waived+reason|N/A+why` 只是**允許值集合**說明（`|` 兩側無空白）；**實填** MUST 為單一合法值：`done`、或 `waived+<非空 reason>`、或（明確非觸發時）`N/A+<非空 why>`。任何實填值仍含未解析 `|`（例把 `done|waived+reason|N/A+why` 原樣當填值）皆 **ILLEGAL**。觸發與非觸發皆 MUST 同時填 **`ui smoke head: <sha>`**（驗測或判定時的已提交 SHA，full 或 ≥7 hex），供 pre-PR／sticky dispatch 對照 currency。

- **head currency**：`ui smoke head:` 等於當前 tip SHA（或其 ≥7 hex 前綴）即有效；若已落後 tip，該 SHA MUST 是 tip 祖先、且為 `merge-base(originMain, tip)` 的嚴格後代，`reported..tip` 的每條變更路徑 MUST 通過 `isAllowedPostSmokeDeltaPath`（`.devpro/scripts/run-codex-primary-review-operator.mjs` 為允許路徑與 `evaluateAncestorOfTipCurrency` 的實作 SSOT）；任一條件不符即 stale、須重評並更新記錄。`qa-test-scope.md` 自身的提交會推進 tip，因此已提交欄位不必填入該提交自己的 SHA；後續有任何不符合允許路徑的變更時，不得沿用舊 smoke 結果。

- `E2E: 無`／「無 E2E」**MUST NOT** 豁免 `ui smoke:` 欄（兩欄正交並存）。
- PR body `## Manual Test` **MUST NOT** 替代 `qa-test-scope` 的 `ui smoke:` 記錄（Manual Test ≠ ui smoke）。
- **觸發**（任一）：user-visible UI 表面（例 `.cshtml`／`.razor`／`.tsx`／`.jsx`／`.vue`／`.css`／`.scss`／`Views/`／`Pages/`／`wwwroot/`／UI `components/`）、OpenSpec／proposal 明示 UI、或 UI 樹內 `DesignerSelect`／`RootClass`。ProductHost／HostUi 僅 dogfood 例，非唯一觸發。
- **不觸發（預設 `N/A+why` 合法）**：僅 `.devpro/agent-rules/**`、`.devpro/agent-skills/**`（非 UI）、`.devpro/scripts/**`、`openspec/**`、docs／README、CI yaml、純後端／無頁面 chrome（why 非空可覆核）。
- **Ambiguity**（是否 UI 不明）→ 當作觸發；合法僅 `done` 或 `waived+reason`；**禁止** `N/A+why`。
- **`done` 最小集**：開啟目標 UI 頁且非 error-state **AND** 關鍵新控件 closed 態可視為單一 control OK **AND** schema／readiness 已驗證或同記錄 `waived+reason`。
- **Web UI**：first PR／sticky 前 MUST Playwright 或等效 browser 自驗；evidence 記 screenshot path／log ref。Matching `same-change-dp-change-batch` 下 screenshot evidence **即足**，**MUST NOT interrupt** user 做手動 UI verify。無 matching batch 時既有 Ask First／user verify 仍適用。
- **DesignerSelect／`RootClass`（條件式；一般 UI-control 例）**：prove-it／手動核對 MUST 斷言 **單一** BEM token（一例一 class）；禁多 token 破壞 `*-menu`／hide 規則。

pre-PR／sticky FAIL CLOSED 入口見 `devpro:pre-pr` Step 1 與 `code-review-cross-model.md`（本檔不重寫閘門長文）。

### Exit Criteria

- `qa-test-scope.md` 已存在於 `openspec/changes/<name>/`
- 必填欄位無空白（基本資訊、變更範圍摘要、建議 QA 驗測重點、可能受影響模組 / 流程、風險與未覆蓋項目、建議回歸測試清單）
- `ui smoke:` 已填**單一**合法值（禁未解析 `|`；觸發／非觸發皆列此欄；**僅** `ui smoke:` 非觸發時可用 `N/A+why`）且另列 `ui smoke head: <sha>`（觸發／非觸發皆列；值域**僅** `<sha>`，**MUST NOT** 填 `N/A+why`）
- 已在 PR 描述附上連結或內容

### Usage

**何時建立**：PR 建立前，由負責人（或 dp-programmer）填寫。

**放哪裡**：貼於 PR description 末尾，或以獨立 comment 附上。

**PR 描述引用方式**：
```markdown
## QA 測試範圍
（見下方 QA 測試範圍評估 comment，或已內嵌於本 PR 描述）
```

**填寫原則**：
- 「非本次範圍」欄位必填，明確排除可防止 reviewer 誤以為遺漏。
- 「風險與未覆蓋項目」欄位誠實填寫，不得留空掩蓋已知問題。
- 測試指令結果（第 6 段）若有，貼摘要即可，不需完整 log。
- `ui smoke:` 不得留模板多選殘留；`## Manual Test` 不能代替該欄。
