---
name: file-write-destinations
description: AI agent 寫暫存/中間/gh body/state 檔的目的地 SSOT（哪類寫哪裡）；觸發：寫 gh body / 暫存檔 / 不確定該寫哪個目錄時
---

# 寫檔目的地 SSOT（哪類檔寫哪裡）

本表是暫存／中介／gh body路徑SSOT；他檔只cross-ref。

| 目的地 | 寫什麼 | 為什麼是這裡 | gitignored |
|---|---|---|---|
| `<repo-root>/notes/tmp/<purpose>-<unique>.md` | **TL-authored gh body**（PR / issue / comment / Recap Discussion body file）+ 一般 AI session 中介產出 | **唯一** TL gh body 目的地。在 main checkout 根、**不綁 per-change worktree 生命週期**。`<purpose>-<unique>` MUST be collision-resistant（purpose + session/timestamp/PID/random suffix；change name alone is not enough），避免同 repo 多 session 互蓋；成功送出後 MUST 立即刪。generic GitHub write 的 `gh-footer-gate` 版號錨點 = **本 session 執行指令所在 repo（cwd checkout）** 的 canonical `AGENTS.md`（`origin/HEAD`→`origin/main`/`origin/master` tip 優先、workspace fallback）；該 repo 讀不到版號才退回 body-file containing-repo（同樣 tip 優先），兩者都讀不到才 skip 版號檢查（fail-open；#3437）；canonical `rules/<source>-v<X.Y.Z>` operation 則錨定經 branch/head/worktree/source 驗證的 exact rules worktree `AGENTS.md`，body carrier 位置不因此改變 | ✅（`notes/` 遞迴涵蓋） |
| `<repo>/notes/session-pending.md` | 對話討論出的待辦 / 缺口（全局，非 per-worktree） | conversation clear / compact 不丟；新 session 接續（SSOT 見 `rule-design-principles.md` §Workflow Persistence Layers） | ✅ |
| `<main-checkout-root>/notes/review-<change>-r<N>.md` | raw | 本表定路徑；persist→`code-review-checklist.md` | ✅ |
| `<main-checkout-root>/notes/review-<change>-receipt-r<N>.json` | receipt | round | ✅ |
| `<main-checkout-root>/notes/review-<change>-manifest-<purpose>-r<N>.json` | manifest | scope | ✅ |
| `<main-checkout-root>/notes/review-<change>-archive-transition-<postsha>.json` | v1 transition + inline gate logs（無 standalone log file/path） | coverage | ✅ |
| `<main-checkout-root>/notes/review-<change>-final-evidence-<head>.json` | v1 final + inline suite log（無 standalone log file/path） | readiness | ✅ |
| `<repo-root>/notes/tmp/<topic>-*` | shell output >200行/>5K token | 摘要後清；見`token-frugal-io.md` | ✅ |
| `<main-checkout-root>/notes/cross-review/<attempt_id>/` | **second-review carrier**（packet、observability-context、heartbeat、activity/stdout ndjson、stderr log、cli-probe / review-scope-probe result） | renderer 唯一合法落點。每次 initial dispatch / focused sticky-refresh / fault recovery 都必須配置 fresh `<attempt_id>` 子目錄；不得覆寫、patch、刪除或重用先前 attempt evidence，除非由 cleanup owner 依 TTL 清理。**必須在 reviewer 可寫根之外**：reviewer 可寫面現收斂為其自身 per-dispatch neutral cwd，carrier 若同處該樹下，reviewer 一次 `sed`/`cat` 重讀自己的 packet 就撞破 runner 單行上界（issue #1735）。renderer 對此邊界 fail closed（`reviewer_writable_root_carrier_collision`），與新 repo-containment 斷言互補 | ✅（`notes/` 遞迴涵蓋） |
| `<reviewer-neutral-cwd>/.cross-model-sticky-*.md` | **全 family reviewer cross-model sticky body**—— renderer exact recipe 唯一授權的 sticky body 落點；basename 由各 family 的 adapter recipe 固定（safe-mode family 用固定檔名，另一 family 自由命名；見 `platform-adapters/`）（NFR5：落點統一，family 能力剖面仍可辨識） | reviewer current neutral cwd 可達；MUST NOT 把 main-checkout metadata 當成已授權 write path。create/PATCH 後立即刪；probe/schema/log 留 wrapper scratchpad | N/A（repo 外 runner-owned neutral cwd） |
| `openspec/changes/<name>/` | 進行中 change folder | git-tracked，merge+release 後 archive（SSOT 見 `rule-design-principles.md` §Workflow Persistence Layers） | ❌（tracked） |
| `<repo-root>/notes/tmp/state/<prefix>/` | **hook state / marker**（post-merge、recap、post-pr-completion、rule-load ledger） | hook 跨 process / 跨 worktree 機器通訊 marker。base = `defaultRepoStateDir` → `resolveMainCheckoutRoot`／`defaultMainCheckoutRoot`（**B root semantics**）：成功路徑 = git common-dir 的 dirname；fail-open／timeout 不得無條件 `dirname(cwd)`——若 cwd 在 `<main>/.worktree/<leaf>` 下則 climb 到 `<main>`，並戳記 `identitySource: "fallback"`（成功為 `git-common-dir`）。**MUST NOT** 讓 state 落在 `.worktree/` 下（硬擋 `repo-state-root-under-worktree`）；禁再把 `dirname(repoStateIdentity(...))` 當唯一派生。linked worktree 共享同一 main-checkout `notes/tmp/state` | ✅（notes/ 遞迴涵蓋） |
| `/tmp/<change-name>-<filename>.draft.md` | **token 估算 dry-run mock-write**（填 Touch List 前 byte 估算） | 短命（估完即 `rm`）、不入 repo。SSOT 見 `token-budget-precheck.md` | N/A（repo 外） |
| `./codeql-results/<lang>.sarif` | **CodeQL 掃描 SARIF 輸出**（+ `sarif-report.mjs` HTML 報告） | 工具產生的掃描報告；repo-relative，gitignored（`.gitignore` managed region 含 `codeql-results/`）。SSOT 見 `codeql-execution.md` | ✅（`codeql-results/` 遞迴涵蓋） |

凡 GitHub body 寫入（issue / PR / comment / Discussion）都 MUST 遵守 `git-pr-template-and-merge.md` § `gh body 序數防誤連結（cooperative-only）`；序數與真正引用的判斷及改寫方式以該 canonical How 為準，本 leaf 不複寫。

## 禁則

TL-authored gh body **不得**寫：
- per-change worktree-internal 路徑（例如 `.pr-body.md`，已移除）——worktree 被刪即 strand body file。
- repo-external `/tmp`——cwd 讀不到版號時會失去唯一剩下的 repo 版號錨點。Reviewer sticky 不沿用 TL carrier；它只可用 renderer 固定的 per-dispatch neutral cwd（全 family 一致）。

`notes/tmp/` 是唯一 TL gh body 目的地。

## `notes/tmp/` lifecycle

`notes/tmp/`是scratch/carrier，非長期store。

- TL-authored PR / issue / comment / Recap body carrier：`gh` 成功送出後 MUST 立即刪；失敗、中斷、或忘刪的殘留由 release cleanup / branch hygiene 批次清。
- reviewer sticky body carrier：sticky create / PATCH 成功後 MUST 立即刪；全 family 皆為 neutral-cwd carrier，失敗殘留由 runner cleanup，不再有 main-checkout carrier 分支。
- logs：60分鐘TTL；transition/final evidence除外。
- batch cleanup 唯一入口：`node .devpro/scripts/prune-notes-tmp.mjs`（dry-run default，列表預設只顯示前 50 筆以避免 cleanup report 自己變大輸出；需完整清單才加 `--limit 0`）→ 使用者明確同意 cleanup 後才 `node .devpro/scripts/prune-notes-tmp.mjs --exec --as-of <time>`（照抄 dry-run 印出的指令；`--exec` 沒帶 `--as-of` 會被拒絕）。可用 `--max-age-minutes <N>` 調整 cutoff；unknown file 預設只列不刪，除非顯式 `--include-unknown`。
- 觸發點只在 release cleanup / branch hygiene flow；不得放在 Stop hook / SessionStart 自動 `--exec`。
- `notes/tmp/state/**` 永遠由各 prefix owner 管理，general `prune-notes-tmp.mjs` MUST skip。
- reviewer-writable root 的 top-level entry 數有**隱含上限**：second-review renderer 在 render 前估算該 root 單行 `ls -la` byte 量，> 32768 B 即 fail closed（`reviewer_writable_root_enumeration_overflow_risk`）——`notes/tmp` 已不在此 root 內（Codex recipe 不再持有 `--add-dir`），此上限現只約束 reviewer 自身 per-dispatch neutral cwd（spawn 當下為空，退化為回歸守衛，issue #1735 case 1 教訓保留）。**撞到此上限的補救綁在該 root 自身的 per-dispatch 生命週期**：清掉／移走累積在該 reviewer neutral cwd 的內容後重新 render——`prune-notes-tmp.mjs` 不管這個 root，別拿它當補救。final/archive-transition suite/gate logs 只存在既有 v1 inline record，MUST NOT 建立 standalone `notes/tmp` log file/path；一般 `notes/tmp` scratch 仍沿用上述 dry-run → `--exec --as-of <time>` 批次清理，burst 情境改先跑 `prune-notes-tmp.mjs --max-age-minutes 1` dry-run，同意後照抄它印出的 `--exec` 指令（`--max-age-minutes` 只收正整數，`0` 會被拒）。此上限只涵蓋 top-level 列舉，不涵蓋單檔內容讀取——該 root 內的大檔被 `cat` 仍可撞破 runner 單行上界，換 root 不改變這一點。
- `notes/cross-review/<attempt_id>/` second-review carrier：test fixture 只擁有該 test 明確註冊的 attempt root，並在 test 結束時立即刪除；production cleanup owner 為 `prune-notes-tmp.mjs`（同一 batch cleanup 入口、同一 `--max-age-minutes` cutoff，預設 60 分鐘）。carrier 移出 `notes/tmp` 只改 reviewer 可讀性，不改 ownership。Initial dispatch、focused sticky-refresh、fault recovery、rerender / retry 都必須寫入 fresh `<attempt_id>`；prior attempt directory 是 lineage evidence，除 cleanup owner 外不得覆寫或刪除。production owner 必須逐一評估 direct child，只有 exclusive ownership、canonical terminal evidence、whole-attempt cutoff 全部成立，才可 root-level 刪除並回報 `deleted`；否則保留整個 attempt、回報 `active-skipped`／`nonterminal-skipped`／`invalid-evidence-skipped`／`ttl-skipped`，再繼續下一 sibling。dry-run 不得 mutation，也不得回報 `deleted`。

## `notes/tmp/state/` prefix registry

新增或改動 `notes/tmp/state/<prefix>/` 時，必須更新本 registry 與對應 test。General tmp cleanup 不得清此表任何 prefix。

| Prefix | Owner | Purpose | TTL / cleanup trigger |
|---|---|---|---|
| `devpro-recap-state/` | `.devpro/scripts/hooks/lib/recap-utils.mjs`; `session-pending-cleanup-check.mjs` reuse | Recap / session-pending reminder dedup marker | 30 分鐘 mtime dedup；branch-head 與 `merged-*` marker 各由 `evaluateRecapState` / `evaluateMergedRecapPending` 於進入時 sweep 過期項；`session-pending-cleanup` 固定 key 檔為單一自覆寫，無界成長不成立，故無獨立 sweep |
| `devpro-recap-pending/` | `recap-utils.mjs` legacy compatibility only | ownerless legacy marker; not automatic reminder scope | legacy API retains 24h TTL; new reminder evaluators leave it untouched |
| `devpro-session-reminders/<session-key>/` | `session-reminder.mjs` / `recap-utils.mjs`; successful PostToolUse or explicit adoption | own work, dedup/lease and full hook diagnostic details | same-ID resume/compact persists; no automatic foreign adoption or 24h obligation expiry |
| `devpro-recap-in-progress/` | `.devpro/scripts/hooks/lib/recap-utils.mjs` | Recap creation lease suppressing duplicate pending reminders | 30 分鐘 lease；expired lease resumes pending behavior when no Discussion exists |
| `devpro-recap-written/` | `.devpro/scripts/hooks/lib/recap-utils.mjs` | recap-written marker: local record that Recap Discussion was written | no TTL; cleanup only manual/state reset |
| `devpro-postmerge-state/` | `pre-tool-gate.mjs` writes, `track-postmerge-workflows.mjs` clears on a confirmed query, `post-merge-check.mjs` reads and expires | reminder to query workflows after merge | remind after a short delay, expire after 1 hour |
| `devpro-post-pr-completion/` | `.devpro/scripts/hooks/lib/post-pr-completion-state.mjs`; `post-tool-gate.mjs`; `post-pr-completion-check.mjs` | Authority keyed by GitHub.com repository and PR or branch. For filenames, legacy resolution and migration, see `repo-state-identity` spec §Post-PR Marker Mutations Share A Repository And Selector. | 2 hour stale TTL for unbound authorities; cleared by post-PR completion checks / self-heal |
| `devpro-post-pr-skipped-cleanup-probe/` | `.devpro/scripts/hooks/post-pr-completion-check.mjs` | skipped post-PR marker cleanup probe throttle and bounded failure-class evidence | 60 分鐘 stale TTL；best-effort cleanup during post-PR completion checks |
| `devpro-second-review-control-evidence/<dispatch_id>/` | `.devpro/scripts/hooks/lib/second-review-control-evidence.mjs` | immutable dispatch、fault capsule、consumption/supersession receipts | 依 `second-review-control-evidence.md`；unconsumed無TTL，valid receipt + complete chain後才由owner清理 |
| `devpro-rule-load-ledger-state/` | `.devpro/scripts/hooks/lib/rule-load-session-ledger.mjs`; `.devpro/scripts/hooks/rule-load-ledger-host-diag.mjs`; SessionStart / PreToolUse hooks | session-aware rule-load duplicate ledger and bounded host payload diagnostics | no wall-clock TTL; lifecycle follows session source (`startup` reset, `compact` epoch advance, manual reset with reason) |

Hook-local state not under `notes/tmp/state/` is outside this registry until migrated; its owner script remains responsible for its lifecycle.

Control-evidence root必須由 `defaultRepoStateDir("devpro-second-review-control-evidence", cwd)/<dispatch_id>/` 派生。它不是一般 scratch；general tmp/pruner不得進入，且不得以時間刪除尚未消費的 evidence。

## Mechanical enforcement

- `pre-tool-gate.mjs` W3 Body Carrier gate 擋 `.cross-model-sticky-*` 寫進 protected root checkout 或 linked worktree root；全 family reviewer sticky body carrier 現一律位於 repo 外的 per-dispatch neutral cwd，受 renderer/validator/runner contract 管理；W3 對 gitignored `notes/tmp/` 的 carve 仍在（供既有殘留與 TL-authored body 用），改變的是不再有任何 reviewer recipe 會把 sticky body 落在那裡，carve 因此退化為回歸相容面；TL body（例如 `.pr-body`）已不在偵測範圍。
- `gh-footer-gate.mjs` footer-missing 訊息導向 `notes/tmp/`。
- `notes/` 遞迴 gitignored（`.gitignore` managed region，`gitignore-alignment.md` 管理）；`notes-untracked-guard.test.mjs` 驗 0 tracked files。

## body file two-step 紀律（所有 gh body 寫入共用）

TL-authored body file MUST 先以**獨立** Bash 呼叫（Write 工具或 `cat >`）落地，再以第二個呼叫執行 `gh`；同一 compound command 內建檔時 PreToolUse 讀檔尚不存在 → fail-closed。用**字面絕對路徑** `<repo-root>/notes/tmp/<purpose>-<unique>.md`，禁 `$(pwd)` / `$VAR` / 反引號（PreToolUse 讀檔在 shell 展開前，拿到未展開字面）。`<purpose>-<unique>` MUST include purpose + collision-resistant suffix（session id、timestamp、PID 或 random token）；change name alone is not enough，固定 basename（例如 `pr-body.md`）MUST NOT be reused across sessions。**在 linked worktree 內執行 TL write 時**，body file 實體仍在 **main-checkout**（`notes/tmp/` 由 git common-dir 解析、實體在 main-checkout root），worktree-relative 的 `notes/tmp/...` 路徑**不存在**；故字面絕對路徑必須**指向 main-checkout root**（`<main-checkout-root>/notes/tmp/<purpose>-<unique>.md`）——這**不是** vfMap cross-worktree 限制，`--body-file` 完全可用，勿誤診成只能 inline `--body`。Reviewer sticky body 的 path 則由 family recipe 固定：全 family 皆為 reviewer current neutral cwd route，MUST NOT 被改寫成未授權的 main-checkout `notes/tmp`。gh body 必含末尾單行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>` footer（含 `createDiscussion` Recap body，缺則 `gh-footer-gate` block）。若使用 strict preflight，該 invocation 是 validator-only dry run: it never executes the nested `gh` command, Exit `0` means validation passed only，且 real `gh` 必須另行執行；hook-proven shell 直接跑 real `gh`，MUST NOT manually insert this validator as an executor wrapper。`gh` 成功送出後 MUST immediately delete the body file；失敗/中斷殘留才交給該 carrier owner cleanup。vfMap 見 `ai-autonomy.md` §行為邊界；PR 見 `git-pr-template-and-merge.md`。

Rules sync PR 必須讓 operation context 在命令字串可觀測：`cd <abs-rules-worktree> && gh pr create ... --head rules/<source>-v<X.Y.Z>`；沒有 workdir 參數、又不想寫 `cd` 時，改在同一個 gh 指令前寫 `DEVPRO_PR_CHECKOUT=<abs-rules-worktree>`（字面絕對路徑，須是 git checkout，否則 fail closed）。此時 body file 仍使用 main-checkout absolute carrier，但 footer 版本改由 exact rules worktree `AGENTS.md` 驗證；current branch、`--head`、branch suffix、worktree `AGENTS.md` version 或 source whitelist 任一不一致／不可解析都 fail closed。同一 compound command 若包含多個 rules write-back，因無法逐一綁定 body 與 operation，必須拆成獨立命令。非 rules GitHub write 以本 session 執行指令所在 repo（cwd checkout）的 canonical remote tip `AGENTS.md` 為錨點，cwd 讀不到版號才退回 body-file containing-repo（#3437）。
