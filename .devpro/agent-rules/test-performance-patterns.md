---
name: test-performance-patterns
description: source repo 測試效能優化 SSOT——四 pattern（昂貴 fixture 整檔共用／多斷言合併單次 spawn／能 import 就別 spawn／源碼熱點迴圈內 per-item spawn 改一次 batch）+ CPU-bound 反拆檔說明；觸發：新增/修改觸及 spawn 的測試、full suite 超預算優化。
---

# Test Performance Patterns（source repo）

## Overview

此 suite 成本**極度集中在少數重-spawn 檔**：驅動因子是**每個 test 各自 fork 真 git/node/hook 子行程**（真 `git init/commit/merge`、實跑整個 CLI/hook），不是 test 總數。慢檔每 test spawn 十餘次、快檔近 0。唯一有效方向是**消滅 spawn 本身**（下方四 pattern）。這些檔多屬 integration tier，本檔用於**降低 integration tier 成本**（tier-aware 時機見 `test-suite-cadence.md`）。

## When to Use

- 新增/修改觸及 spawn（git repo/worktree fixture、hook spawn、Node process spawn、repo scan）的 source repo 測試時——`test-suite-cadence.md` 要求作者先讀本檔
- integration tier 或 full suite report-only 耗時偏高、或單檔 delta >5s 時的優化入手點

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for performance judgment |
| Advisory | N/A |
| Doctrine | `cooperative-only`：source profile 以實際量測裁決；anchor tests 不判效能成效。 |

### (a) 昂貴 fixture 整檔共用一次

git repo/worktree/template：per-test `mkdtemp + git init + 複製檔案` → `before()` 建模板，case 用 `cpSync` copy/reuse。只有真 per-run side effect 才 per-case 重建；shared fixture / marker-state failure 先用 fresh fixture or isolated marker/state dir 複核。

```js
// BEFORE：每個 test 各做一次完整 git init（5 次真 git spawn）
function setupMainRepo() {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir }); // +config×2 +add +commit
  return dir;
}
// AFTER：建一次模板，之後用 cpSync 快速複製（git init 只跑一次）
function setupMainRepo() {
  mainRepoTemplate ??= createMainRepoTemplate(); // 一次性
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  cpSync(mainRepoTemplate, dir, { recursive: true }); // 快速 fs copy，非 git spawn
  return dir;
}
```

**⚠️ cpSync-of-`.git` 並行反噬**：cpSync 複製**已 commit 的 repo** 會遞迴複製整個 `.git`（數十～數百小檔）。單獨量看似快（~108ms vs git-init 5-spawn ~435ms），**但 full-tier 檔級並行下**（~9 檔同時狂複製 `.git` 小檔）fs metadata I/O 爭用爆炸——實測 integration tier 66s→**315s**（4.8× 迴歸）。**邊界**：cpSync 只在「fixture 昂貴成本是複製大量業務檔案」（如整棵 rules tree）時淨賺；fixture 只是「git init 近空 repo」則**保留 `git init`**（init 空 repo 比複製其 `.git` 省，且不觸發並行爭用）。

### (b) 多斷言合併到單次 spawn

相鄰、對同一 repo 狀態做不同面向斷言的 test → `before()` 跑一次 spawn，各 `it()` 只讀共用結果做 assert。**test 數與斷言數不變**（coverage 保住），只是共用同一次昂貴 spawn。

```js
// BEFORE：兩個 it() 各自 spawn 同樣的 CLI（重複昂貴 spawn）
it("exits 0", () => { const r = spawnSync("node", [s], { cwd }); assert.equal(r.status, 0); });
it("no branch -d", () => { const r = spawnSync("node", [s], { cwd }); // 重複 spawn
  assert.doesNotMatch(r.stdout, /git branch -d/); });
// AFTER：共用一次 spawn，斷言全保留
before(() => { result = spawnSync("node", [s], { cwd }); });
it("exits 0", () => assert.equal(result.status, 0));
it("no branch -d", () => assert.doesNotMatch(result.stdout, /git branch -d/));
```

### (c) 能 import 就別 spawn 整腳本

只驗**純函式邏輯**（如對 JSON payload 的判斷）的 test → 直接 `import` 該函式 in-process 呼叫，省掉 `spawnSync` + `mkdtemp`。**但**凡斷言 process contract（exit code、真 stdout、marker 副作用、真 git state）者**必須保留 spawn**——這些是 in-process 呼叫證明不了的。

為此，被測腳本應把邏輯抽成可 export 的函式（如 `pre-tool-gate.mjs` 的 `evaluatePreToolUsePayload`），並用 `import.meta.url === \`file://${process.argv[1]}\`` guard 包住 CLI 執行，讓測試能 import 而不觸發 CLI。

**Windows ESM 約束**：子程序／動態 `import` 的 module 字串 MUST 是 `file://` URL（用 `pathToFileURL(abs).href` 或測試 helper `repoFileUrl(rel)`）。Windows drive letter（如 `C:`）**不是** ESM file path——`JSON.stringify(absPath)` / raw `C:\…` 會觸發 `ERR_UNSUPPORTED_ESM_URL_SCHEME`；POSIX CI 看不見此洞。

### (d) 源碼熱點：迴圈內 per-item spawn 改一次 batch

**最大槓桿不在測試檔、在被測源碼**。當被測 CLI/腳本在迴圈裡 per-item spawn 子行程（每刪一檔一次 `git ls-files`、每分支一次 `git rev-parse`），測試每跑一次該 CLI 就把這些 spawn 全付一遍——測試 spawn N 次 CLI × CLI 內部 spawn M 次 = N×M 次 fork。改源碼把迴圈內 per-item 查詢換成**迴圈前一次 snapshot + 記憶體查表**，N×M 塌成 N×1。

```js
// BEFORE（源碼）：每刪一檔 spawn 一次 git（一次 uninstall 350+ 次）
for (const relPath of relPaths) {
  const tracked = runGit(`ls-files --error-unmatch -- "${relPath}"`, { cwd });
  if (tracked) runGitStrict(["rm", "--cached", "--", relPath], { cwd });
}
// AFTER：一次 snapshot（argv 陣列、非 shell 字串）+ Set 查表，350+ → 1 spawn
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean)
);
for (const relPath of relPaths) {
  if (tracked.has(normalizeRelPath(relPath))) runGitStrict(["rm", "--cached", "--", relPath], { cwd });
}
```

**判斷可否 batch**：只有「每次查詢彼此獨立、不依賴前一次結果」才可 snapshot；語意逐個的操作（`git branch -d`、逐 tip `merge-base --is-ancestor`）不可 batch。**量體決定成效**：CPU-bound suite 砍 350+ 次（O(檔案數)）才在 real time 露訊號；砍數十次的迴圈對 wall-clock 近無感（實測 removeConsumerFile 350+→1 使全 suite 207→73s；prune/detect 數十次同類 batch 無可測增益，不值維護面）。fail-open 須與原 probe 一致（snapshot 失敗回空 Set）。

### (e) 拆巨檔降關鍵路徑（僅限長尾序列化，先量 effective parallelism）

拆檔**能否**降 wall-clock，取決於瓶頸是「總 CPU 工作量」還是「單檔關鍵路徑」——**動手前先量 effective parallelism**：`effective = 全 tier (user+sys CPU) ÷ (real × 可用核數)` 的分子分母，或更直接 `全 tier (user+sys) ÷ real` = 實際平行倍率。

- **CPU 飽和**（實際平行倍率 ≈ 核數−1，node --test 預設 concurrency）：所有核心都在跑，拆檔只把同樣的 CPU 工作搬到別檔，總 wall-clock 不降。此時唯一有效是 (a)/(b)/(c)/(d) **消滅 spawn**。
- **長尾序列化**（實際平行倍率 ≪ 核數−1，例如 10 核只測到 3x）：核心大量閒置在等**單一巨檔**跑完尾巴——因為 node --test 只在**檔級**平行，一個巨檔獨佔關鍵路徑，其餘檔早已跑完。此時**把最大檔拆成數個均衡的獨立檔**，各檔一個 process（獨立 global state = 零 race）平行跑，關鍵路徑 wall 直接下降。

實測（integration tier，10 核）：tier user+sys=348s、real=113s → 實際平行僅 **3.08x**（≪ concurrency=9）= 長尾序列化。把最大單檔拆成 2 個均衡檔平行 → 關鍵路徑 66→41.5s。**前提是各檔真正獨立**（不共享 mutable global/fixture）；同檔內 `it()` 平行會 race，故用檔級拆分而非 `--test-concurrency`。coverage 守恆。

**倍率不降≠可再拆**：判準是單檔獨大；各檔扁平再拆只搬工作。實測拆完最大檔後再拆次大檔（變快）但 tier real/user+sys 未變，長尾消失即停，轉 (a)-(d) 或認不可行。

**排程重排非解方**：重排無效，含依實測重建全 tier 清單（A/B −4.6/−1.5s＜15.5s 變異）。下限＝tier(user+sys)÷實際平行倍率。

**spawn-overhead-bound（勿再找演算法熱點）**：tier CPU 93% 是 process creation（實測 21.7k spawns×~19ms），`sys`>`user`；CLI profile self-time 53% 落在 `spawnSync`，自身僅 ~2ms。kernel fork 爭用使平行倍率封頂 ~4x，故只有降 **spawn 總數**才降 wall：再降 20% 需砍 26%（~5.6k）spawn，只剩「減少 CLI 呼叫次數」＝砍 coverage（使用者決策）。無損項：同 process 內重覆查 invariant（repo root／common dir）→ memoize per cwd，只快取成功值以保 fail-open。

**熱點檔案缺席 priority list（MUST 補登，非重排）**：`INTERLEAVED_INTEGRATION_TEST_PRIORITY` 是 allowlist——不在清單內的檔案 priority=∞，排到 133 檔佇列尾端才起跑。若某檔 standalone wall time 顯著獨大（該檔本身即決定 tier 總 wall time：tier real ≈ 該檔 duration + 排隊延遲），該檔 MUST 依實測 duration 登記進清單。這是**針對性補登**，與上方「排程重排非解方」的**全清單重排**是兩件事——全清單重排已證實是 noise（±15s 變異蓋過訊號），但漏未登記的單一巨檔仍會造成可測、可修的排程劣化（實測案例：兩個未登記檔案的排隊延遲 + 自身 duration ≈ 整個 tier wall time 的來源）。拆檔後的新 shard 同樣要登記，順序依各 shard 實測 duration。

新 `GROUP_RANGES` shard family：每個非 `core` group MUST 有 wrapper 入口檔（主檔 stem + kebab group 名、設 `DEVPRO_*_TEST_GROUP`、import 主檔、manifest `integration`）。`run-test-suite.test.mjs` 發現家族並 iterate keys；新增 group 卻沒 stub 時該 range 在每個 process 都 silently skip，grouped-count 仍綠。禁止把單一家族硬編碼 wrapper list 當成覆蓋。

### git-bound 檔的補充手法（review-evidence family 實測）

先量再選：`GIT_TRACE2_EVENT=<dir>` 數 git 啟動；子行程 CPU profile 看 `fsync` 佔比。

- **歷史 commit fixture**：用 `git init` + `objects/info/alternates` 指向 source object store + sparse cone，不用 `git clone --shared` 完整 checkout（tier 內單測 162s→30s）。fixture 會寫入的路徑 MUST 在 cone 內，否則 `git add -A` 拒絕；改 fixture 後以 `--test-name-pattern` 跑**整個 family**，單跑部分 shard 會漏。
- **in-process git 事實快取**：`tests/lib/immutable-git-fact-memo.mjs` 只記成功結果。不可變類（repo 不變量、全 OID 的 object-store 查詢）整個 process 有效；ref 類（HEAD／show-ref／worktree list）在本 process 啟動任何非唯讀 git 查詢的子行程時全丟。`status`／工作樹 diff MUST NOT 快取。新增形狀須以 `DEVPRO_TEST_GIT_FACT_MEMO=verify` 跑整個 family 且 stale 0 筆。
- **fixture fsync shim（macOS）**：Node fsync 在 macOS 是 F_FULLFSYNC，全機排隊（renderer 子行程 366ms 中 171ms；tier real 436s→346s）。`run-test-suite.mjs` 預載 `tests/lib/fixture-fsync-shim.cjs` 把 flush 換成 fd 檢查；非 macOS 不生效，`DEVPRO_TEST_FIXTURE_FSYNC=real` 還原。durability 故障測試 MUST 走 `fsOps` 注入，不得依賴真實 flush 失敗。
- **focused 量測**：直接 `node --test` 不經 runner 的 `frontDeveloperGitOnPath()`，macOS 上每次 git 多付 xcrun shim 成本；A/B 須 `PATH="$(dirname "$(xcrun -f git)"):$PATH"`，否則與 tier 數字不可比。

## Measurement-Driven Optimization Loop

共用方法依 `performance-investigation.md`；本節只擁有 source test-suite 專用 profile：

1. **Canonical baseline**：正式 `run-test-suite.mjs` 跑完整目標 tier／full-suite；可比安靜窗口，保留 command、exit、test counts、`real/user/sys` 與 named logs。Cadence 與 correctness evidence 仍由 `test-suite-cadence.md` 決定。
2. **Source profiler**：量 process spawn、等待、Git／filesystem I/O、CPU／effective parallelism 與各 family 占比；按整體 critical path 裁決，不預設減 Git／Node process 就有效。
3. **Coverage-preserving POC**：事前宣告能改變決策的最低端到端收益，保留 test／assertion／process lifecycle 與語意；驗證前不批次擴到多個 family。局部 POC 的改善**不可相加**，以整體 runner 實測裁決。
4. **Source stop-loss**：連續兩個局部 POC 無法產生事前宣告的端到端實質改善就停止 micro-optimization，改評估架構／執行邊界或記錄 feasibility 結論；不是通用產品工作的固定迭代門檻。
5. **handoff-grade evidence**：既有 QA 留 baseline／after、spawn／I/O 觀測、根因假設、POC disposition 與下一問題或停止理由；共同 keep/revert 與量測判準不在此重述。

## Exit Criteria

- 優化後 test 數與斷言數不減（coverage 不變）、0 fail
- focused timing + 最終狀態 tier 或 full-suite `real` time 由 runner 輸出（report-only，無固定預算門檻；紅 suite 仍 fail）

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「拆成多個小檔就會平行變快」 | **先量實際平行倍率**（tier user+sys ÷ real）：CPU 飽和走 (a)-(d) 消滅 spawn；長尾序列化才拆最大檔，判準見 (e)。不量就拆是賭博。 |
| 「用 `--experimental-test-isolation=none` 共享行程省冷啟動」 | **反而變慢**（10 檔 10.9→18.9s，慢 73%）。node --test **檔級隔離 = 檔級平行**：拿掉隔離＝全檔序列化進單一行程，犧牲的平行遠大於省下的冷啟動；且共享 global state 會 race/deadlock，還需 node 22（本 repo 鎖 node 20）。**已封死，勿重測。**自製 worker-pool 同理更慢（66→72s）。 |
| 「每個 test 重建 fixture 比較乾淨」 | 只有斷言真 per-run side effect 才需隔離；其餘共用模板 + cpSync，乾淨與快可兼得。 |
| 「in-process 測不出真實行為」 | 純函式邏輯 import 即可證；process contract 本就規定保留 spawn，兩者不衝突。 |

## 量測隔離（wall-clock 前置）

CPU-bound suite 的 `real` 對機器負載極敏感：同 90 檔測得 66s / 100s / 111s / 159s，僅因並行 session + 防毒/索引背景程序。**量 wall-clock 做決策前先確認機器安靜**：

- `uptime` 看 load average；`ps aux | sort -nrk 3 | head` 找吃 CPU 程序。load ≈ 或超過核數即過載，`real` 不可信。
- `pgrep -fl "node --test|run-test-suite"` 找殘留/並行 process。**別砍不是自己啟的**（`ps -o ppid` 追來源）。
- 過載時 **CPU time 也失真**（E-core 遷移，實測 user 180→198s，+10%）：無替代指標，只能等安靜重測。

> gate／release 級套件的同 repo exclusivity（正確性要求；量測安靜 ≠ exclusivity）見 `test-suite-cadence.md` §Gate／release 級套件：同 repo exclusivity。

## Verification

- `node .devpro/scripts/check-suite-runtime-budget.mjs`（實跑 canonical suite 量 wall-clock real time；report-only 不 block，僅紅 suite exit 1）
- `node --test .devpro/scripts/tests/poc-first-trigger-gate-grep.test.mjs`（鎖本檔四 pattern 錨點字串 + gate 存在性斷言）
- exclusivity MUST 錨點：`Gate／release 級套件：同 repo exclusivity` 段在 `test-suite-cadence.md`；本檔只留指標（上一行的 `poc-first-trigger-gate-grep.test.mjs` 鎖兩邊）
