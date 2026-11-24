---
name: token-frugal-io
description: token-frugal I/O SOP：shell/tool 大輸出先用最小 flag；>5K token 或 >200 行落地過濾；Read >100 行前 Pre-Read Gate；skill/slash 載入前 >5K token 模板降級。
---

# Token-Frugal I/O

## Overview

兩層規範：**指令層**先套最小 flag；**資料層**遇 >5K token 或 >200 行先落地過濾，不把 raw dump 放進 context。

> **與窮盡／對齊證據的邊界（#2494）**：本檔限縮的是**進 TL context 的展示量**；它 **MUST NOT** 被讀成「可用截斷搜尋結果當作已掃完全量副本的結論」。對齊類 chore A self-alignment 與 cross-carrier 窮盡律要求未截斷計數／全量重跑證據——見 `chore-classification.md` §對齊類 chore A 必驗、`code-review-cross-carrier.md` 窮盡律。

### Throughput-Side（轉手消費也算）

Throughput-Side 也算：`shell → TL context` 與 `shell → prompt-bundle → multi-agent → TL context` 都消耗 TL 對話歷史。把 300 行 diff 塞進 3 個 subagent prompt = 自付 3× 重複 context。

### Rule Loading Scope Order

載入範圍順序 MUST：(1) `AGENTS.md`；(2) 純文字回答不載 runtime adapter；repo/tool operation 才讀 shared contract 與 active adapter；(3) read-only inspection 停在 active adapter；(4) trigger index / Load-chain 指到的 action leaf only，且在動作前載入。**禁止** eager-load 整包 `.devpro/agent-rules/`（≈ 合規載入數十倍 context）；leaf 只在 trigger 命中時讀，不預載 sibling。

### Context load vs cognitive load

**Anchor**：`cognitive load`

把文字塞進 context（context load）≠ agent 可執行理解（cognitive load）。Throughput／Rule Loading 管前者；可執行 recipe、具名錨、短 Avoid 管後者。禁止用「再多塞一頁」假裝降低 cognitive load。

### Rule Load Ledger Gate

**價值定位**：

- ledger gate 主打**省 context window 占用 + 讀取紀律**，不是省 token 計費。
- prompt caching（見 §Cache-Aware Ordering）已把「相同 rule text 再進 context」的**邊際 token 成本**壓到 0.1×，但 cache 命中不會讓重讀**不占 window**——同一份 rule 塞兩次，window 就少一半可用空間，且長 context 本身降準確率（見本檔「為何砍 context」錨點）。
- 故對外不得把本 gate 宣稱成 token 節省（會被 cache 打臉）；其不可替代處是 window 占用與「同 session 讀過就別再讀」的機械紀律，及下方 subagent scoped 分檔（平台內建不提供）。

載入 `.devpro/agent-rules/*.md` 時，TL SHOULD 記一次 rule-load ledger；full Devpro development flow 或 token-cost reduction 變更則 MUST 記。同 session 已載入且 `git diff` 未變更的 rule leaf 不重讀。需要回報 token waste 或 Recap 時，用 `node .devpro/scripts/rule-load-ledger.mjs --files <leaf.md,...>` 產 `rule_load_bytes` / `rule_load_tokens_est`；需要 session duplicate evidence 時，用 `node .devpro/scripts/rule-load-ledger.mjs --session-record --files <leaf.md,...> --session-id "<id>" --json` 或 `--state-file <path>`。AGENTS trigger index eager-load row 預設 ≤2 refs；更多 sibling 由 entry leaf Load-chain 按需載入。

> Load-chain（session ledger 機制）：session rule-load ledger 的記錄來源、lifecycle（`reliable`／`unknown`）、duplicate full read hard block、何時可重讀、手動 `--session-reset` 與 host 診斷都在 `rule-load-ledger-internals.md`；讀 rule leaf 被 hard block 擋下、ledger 記錄異常、要手動校正或設計／審查 ledger hook 時 MUST 先讀該 leaf，平常載入 rule 不必讀。

### Fanout Payload Gate

Fanout cost = payload tokens x subagent count. 若 >2000 tokens sent to >=2 subagents，或 any same payload sent to >=3 subagents，MUST 先縮 payload：同檔案系統可讀時，給 file path + line range + task；否則只 inline needed excerpt。

### Full Devpro Flow Token Reduction Gate

要宣稱降低一個 full Devpro development flow token 成本，MUST 有 machine-observed actual baseline 與 actual after；兩者必須是 equivalent lineage-inclusive boundary，具相同 `scope`、`coverage`、`terminality`、`reconciliation`、metric support 與 evidence boundary，並涵蓋 root、descendants、external reviewer sessions。比較至少涵蓋 rule-load ledger、subagent fanout payload、review/PR packet、recap/output；預設手段仍是 no duplicate rule-load、reference-only packets、同 session evidence ledger 重用、測試/gh 大輸出落地摘要。實際比例固定報 `(actualBaseline - actualAfter) / actualBaseline`；任一邊 partial、mixed、open、unreconciled、differently bounded 或缺資料時只能標 `not-comparable`，不得產生 estimated/achieved savings claim。

**真實用量載體**：token-cost reduction 完成宣稱 MUST 引用 `report-session-token-usage.mjs --host <claude-code|codex> --session <id> --lineage`（或具可驗證 change boundary 的 `--since-change <change> --lineage`）所得 `lineage-complete` + `reconciled` actual evidence，不得只憑估算或口頭宣稱。無 provider-authoritative quantity covering all contributors時，quota impact 與 `cost_usd` 保持 `N/A` / unavailable；禁止從 token totals、本機 price table 或手動 conversion 推測 numeric quota/USD。

## When to Use

- shell 指令前
- 工具 / MCP / API 回應預估 >5K token 或 >200 行
- `gh api`、`curl`、log、metrics dump
- **Read（或等效讀檔）預估 >100 行前**（Pre-Read Gate；對稱 Pre-Edit Gate）
- **skill / slash command / agent prompt-bundle 載入前**，模板預估 >5K token（Skill / Slash Command Exception）

## Process

### Cache-Aware Ordering（prompt cache 重用層）

Context 內容**怎麼排**決定 prompt cache 命不命中；cache 讀取僅 **0.1× base input**（省 90%），是繼「少進 context」之後第二高槓桿。原則：**static prefix 在前、dynamic 在後**。

- **排序（通用原則）**：穩定內容（工具定義、系統規範、AGENTS/adapter 固定段、few-shot 範例）置頂；易變內容（時間戳、per-request 資料、incoming message）置尾。cache breakpoint 放在「最後一個跨請求不變的 block」末端，**不要**放在會變的 block。確切的 prefix 序列化順序（例如某些 provider 的 `tools → system → messages` 逐層疊加）是 provider/API-specific，依 active platform adapter 標註為準，非普世序列。
- **重用紀律**：相似前綴的請求短時間內連續送出，最大化 TTL 內命中（讀取省 90%；5min 寫入只需 1 次重讀回本）。主流 LLM 平台皆 prefix-first 命中；部分自動命中、部分需顯式 cache breakpoint（依 active adapter 標註的 runtime 機制為準）。
- **本 repo 應用**：跨 agent fanout 或長 session 時，把不變的規範/工具段放前、把本次任務 payload 放後；勿在固定段中嵌時間戳或 per-request 資料而打散快取前綴。
- **⚠️ Tokenizer 偏差**：較新世代模型可能換 tokenizer，同段固定文字最多多吃 **35% token**。本檔 `byte/3.5≈token`、`行×30` 為舊估算法，對換新 tokenizer 的模型會系統性**低估**；payload / 規範字數估算 SHOULD 預留約 35% 餘裕。

> 一手錨點（2026-06 驗證）：cache 讀取 0.1×、寫入 5min=1.25×/1h=2×、TTL 內免費刷新；新世代 tokenizer 偏差最多達 35%。具體 model/vendor 機制差異見 active platform adapter。

**主動 compact 的成本依據**：長 session 每多一個 request，就把已累積的整條長 context 再重讀一次計費（即使全 cache 命中，cache-read 仍按 0.1× base input 收費）。session 愈長、request 數愈多，cache-read 累積成本愈高——這是長 session 的主成本來源，非 output。故「任務告一段落主動 `/compact`、換議題 `/clear`」不是可有可無的整潔，而是直接壓低後續每個 request 重讀成本的手段。接續不斷鏈的作法見 `openspec-step-1-to-9.md`（tasks.md 接續載體）與 `session-recap.md`（compact 前觸發 recap）。

**Context Headroom Gate**：當 runtime / provider log / post sampling evidence 顯示 `total_usage_tokens`（或等價 usage total；`cache_read_input_tokens`，Codex host `unavailable`，見 `pre-tool-gate.mjs` Gate CH）已超過 **300,000**，下一個 user-visible update MUST 提醒 compact，且在落地 current state 前不得開始 broad exploration / multi-agent fanout。超過 **400,000** 時，除非正在不可切斷的 atomic operation（單一 command 已在跑、或立即安全修復只差最後一步），TL MUST stop before the next nontrivial tool loop：OpenSpec flow 內把續接狀態寫入 active `tasks.md` / `proposal-mini.md` Tasks；非 OpenSpec flow 寫入 gitignored `notes/session-pending.md`；然後交棒要求 `/compact`（或用 runtime 支援的 compact）。不可因 context window 尚有空間而忽略 gate；此 gate 是成本與準確率雙重保護。

Runtime auto-compact 第一層預防由 `devpro:change` startup common environment entry 執行（契約見 `environment-setup-nvm-nodejs-openspec.md`）；raw `sync-agent-rules.mjs --sync` / `--check` MUST NOT 執行此 user-local 檢查。Codex 建議 `model_auto_compact_token_limit = 400000`；500K context runtime 維持 `500000 * 80% ~= 400000`。這不取代 live headroom gate；未安裝、非互動或拒絕時，TL 仍依 300K/400K gate 提醒與交棒。

### Default Flags（指令層）

先問「只需哪幾欄？」只取所需。

| 工作 | 預設 | 禁用 |
|---|---|---|
| git diff | `--stat` / `--name-only` | 全文 diff |
| git show | `--stat` / `-- <pathspec>` / `--name-only` | 全文 diff |
| git log | `--oneline -20` | 整段 message |
| 搜尋（先 discovery）| `rg -l` / `rg --count` 先 size；`rg -n <pat> <narrowed-path>` 限定範圍；`rg -n -m <N> <pat> <single-narrowed-path>` 才算 sampling；預設帶 `--glob '!openspec/changes/archive' --glob '!.worktree' --glob '!refs'` | repo-wide raw `rg -n`（見 Exploratory Search Gate）/ repo-wide raw `rg -n -m <N>`（`-m` 是 per-file）/ `grep -r` / 掃 archive / 掃 `.worktree` / 掃 `refs/` |
| JSON/YAML | `jq '.f' file` / `yq '.f' file` | `cat` 全檔 |
| 行範圍 | `sed -n '100,200p' file` | `cat` 全檔 |
| gh | `gh ... --json <fields>` | dump 全部 |
| npm/pnpm | `--silent` | 預設 verbose |
| 整檔讀取 | >50 行先 `grep -A` / `sed -n` 縮範圍 | 整檔 Read |

通用：`NO_COLOR=1`；`curl -s`。

### Large Output（資料層）

> **為何砍 context（不只省錢，更保準確）**：長 context 會降低模型正確率，非僅成本問題。實證：**NoLiMa**（arXiv:2502.05167）32K 下 13 模型中 11 個掉到短 context baseline 的 <50%（leading model 從 ~99% 掉到 ~70%）；**RULER**（NVIDIA）顯示宣稱 128K 有效僅 32–64K；**Context Rot**（Chroma，18 模型）focused prompt 全面優於 full。落地過濾 = 同時買到「便宜」與「更準」。

觸發：>5K token 或 >200 行（byte/3.5≈token；行×30 快算）。

**Command Output Hard Gate**：預期 >200 行 / >5K token 的 command，第一次就 MUST 把完整 stdout+stderr 寫到 main-checkout `<repo-root>/notes/tmp/<topic>-*` log。對話 transcript 只放 compact summary：command、exit status、line/byte count、pass/fail counts 或 failed test names、log path。Raw excerpt 只允許用於 invocation/parser debugging，且必須 redacted、bounded ≤500 tokens。高風險命令包含 `node --test .devpro/scripts/tests/`、`node .devpro/scripts/run-test-suite.mjs --changed <base>`（runner 預設 `--stdio log` 已自動落 `notes/tmp`；`--stdio inherit` 僅限本機人工 debug）、`openspec validate --strict --all`、`gh run view --log`、external reviewer NDJSON / stream output。

1. **首選 helper**：`node .devpro/scripts/capture-command.mjs --topic <topic> -- <cmd> [args...]`；helper 會將 stdout+stderr 寫入 main-checkout `notes/tmp/<topic>.*/command.log`，印出 `command=... rc=... lines=... bytes=... log=...` compact summary，並以 child exit code 結束。OpenSpec / modern JS tooling 仍須同時遵守 active adapter 的 Node 20 first-command 規則。
2. **shell-only fallback**：只有需要 shell expansion / pipeline 時才手寫 redirect：`repo_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)"); mkdir -p "$repo_root/notes/tmp"; log=$(mktemp "$repo_root/notes/tmp/<topic>.XXXXXX"); <cmd> >"$log" 2>&1; rc=$?`。`mktemp` template MUST end with `XXXXXX`; MUST NOT append `.log` after `XXXXXX`; return-code 變數用 `rc`，禁止用 zsh readonly `status`。
3. **量體**：>200 行 stdout 進 context 前 **MUST 先 `wc -l`**（或 `wc -c`）；未量即違規
4. **過濾**：`jq` / `rg` / `awk` 取目標欄位，摘要 ≤500 token
5. **回報**：摘要 + 原始檔路徑
   - `notes/tmp` log 是短期 scratch，不是長期 evidence store；必要摘要 / PR body / Recap / handoff 已記錄後，非 `state/**` log 由 release cleanup / branch hygiene 的 `node .devpro/scripts/prune-notes-tmp.mjs` 管理（預設 60 分鐘 stale，dry-run default，`--exec --as-of <time>` 需使用者同意）。Lifecycle SSOT 見 `file-write-destinations.md`。
5. **warning-heavy（sticky）**：預期 compile 大 .NET solution 或已知 `warning-heavy` 專案的 test 命令，SHOULD 先 redirect stdout/stderr 到 main-checkout `<repo-root>/notes/tmp/<topic>-*`，再用 `rg` / `tail` / `wc -l` 看摘要，不把完整 warning dump 放進 context。**Sticky**：即使是 focused test（如 `--filter`），若**同 session 前次已產生 warning-heavy 輸出**，本條款仍適用——前次 warning 是已確認的 session 狀態，不需重跑一次才知道。

6. **Exploratory Search Gate**：**`rg` is not a large-output exception**——快工具 ≠ token-safe。exploratory / repo-wide / uncertain-scope 搜尋（典型 troubleshooting 起手）**禁止**直接 repo-wide `rg -n <pattern>` 把 raw 結果餵 context（issue #860 evidence）。first pass 用其一：
   - `rg -l <pattern> <pathspec>`：只列命中檔（file discovery，非 line output）
   - `rg --count <pattern> <pathspec>`：先 size 結果
   - `rg -n <pattern> <narrowed-pathspec>`：限定單一檔/目錄或具體檔案集合（非 repo-wide；多個 broad 目錄/root 如 `.devpro/agent-rules .devpro/scripts` 仍不夠窄）
   - `rg -n -m <N> <pattern> <single-narrowed-pathspec>`：sampling 足夠時；`-m` / `--max-count` 是 **per-file**，repo-wide 或 broad multi-path 仍可能輸出 `N × file-count` 行，不是 whole-command bound
   - `--glob` 排除 generated / `bin`/`obj` / logs / migrations / snapshots / 已知 noisy 目錄；但 unrelated exclude globs **不等於** scope narrowing，`rg -n <pattern> . --glob '!node_modules' ...` 仍是 whole-tree line output
   - **Forbidden-path default**：`openspec/changes/archive`（凍結快照，量級可達 active 數十至數百倍）、`.worktree/*`（同 repo context 重複進 prompt）、`refs/`（local-only 外部語料，可達數千檔/數百 MB）**預設排除**；除非 user/task 明指要查 archived change、某 worktree 或 refs corpus。任務只需 active changes 時 MUST 不掃 `archive` / `.worktree` / `refs/`。

   若輸出可能 >200 行 → 落地 main-checkout `notes/tmp`、`wc -l`/`wc -c` 量體、只帶 filtered summary 進 context（同上方既有規則）。

#### Session Pending Formalization Narrowing Gate

將 `notes/session-pending.md` 條目 formalize 成 OpenSpec/change 時，TL MUST 在 proposal/spec drafting 或 broad exploration 前，先從三個最小輸入開始：(1) selected pending item；(2) 明確具名 target file(s)；(3) 判定 classification/SSOT 所需的 minimum routing leaf。

第一輪禁止 repo-wide raw line-output 搜尋，例如 broad `rg -n ... .devpro .claude openspec`，也禁止先掃 `openspec/changes/archive`、`.worktree`、`refs`。first pass MUST 用 `rg -l`、`rg --count`、direct file ranges，或先把 raw output redirect 到 main-checkout `notes/tmp` 再過濾。既有 Forbidden-path default 維持不變：`openspec/changes/archive`、`.worktree`、`refs` 預設排除；只有 pending item 明確點名 archived change/spec/capability，或 path 已鎖定後，才可掃 archive/spec 快照。

此 gate 不弱化 write/git/test work 的 active adapter loading requirements；只是說 pending formalization 本身不構成 eager-load adapter siblings or cold leaves 的理由。

7. **Shell redirection / env / command substitution sandbox probe caveat**：shell redirection（`>`）、env assignment（`FOO=bar cmd`）、command substitution（`$(...)`）會改變 approval-prefix matching，**不要**把它們當成對「已知 GitHub network read」做 sandbox 探測的替代方式（例如不要用 `gh pr diff > /tmp/x` 當 sandbox probe）；需要時改用明確的 escalated command 或本地替代（如 `git diff origin/<base>...HEAD`）。

8. **Long-output test failure evidence**：預期 >200 行的驗證 gate（特別是 `node --test .devpro/scripts/tests/`）第一次就 MUST 把完整 stdout/stderr 寫到 main-checkout `notes/tmp` log，再摘 failure，不得只依賴工具回傳 stdout。Preferred pattern：`node .devpro/scripts/capture-command.mjs --topic devpro-test -- node --test .devpro/scripts/tests/`。Portable shell fallback（macOS/zsh OK）：`repo_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)"); mkdir -p "$repo_root/notes/tmp"; log=$(mktemp "$repo_root/notes/tmp/devpro-test.XXXXXX"); node --test .devpro/scripts/tests/ >"$log" 2>&1; rc=$?; lines=$(wc -l < "$log"); bytes=$(wc -c < "$log"); printf "rc=%s lines=%s bytes=%s log=%s\n" "$rc" "$lines" "$bytes" "$log"; if [ "$rc" -ne 0 ]; then rg -n "not ok|failureType|location:|error:|# fail" "$log" -C 8 || printf "no bounded failure pattern; inspect log=%s\n" "$log"; exit "$rc"; fi`。成功路徑 MUST compact summary，只報 pass/fail counts、line/byte count、log path；MUST NOT tail raw TAP on success。失敗路徑也 MUST NOT tail raw TAP；parser/debug 需要原文時才取 redacted、bounded ≤500 tokens excerpt。`mktemp` 模板 MUST 以 `XXXXXX` 結尾；MUST NOT append `.log` after `XXXXXX`；return-code 變數用 `rc`，禁止用 zsh readonly `status`。

9. **Reference-only review/handoff packets**：PR review、cross-model、subagent handoff 的 default packet 是 `file path + line range + task + acceptance`；不得 inline full diff / full PR body / full sticky body / full log。需要 PR sticky 狀態時只取 canonical fields（`verdict`、`last_reviewed_sha`、URL），不要反覆拉整段 comments body。官方 packet builder / reviewer handoff script / TL-authored packet path 若可機械檢查，MUST 加 hard gate 擋 inline full payload；若只能 cooperative-only，MUST 附 telemetry capsule：`source_lines` / `source_bytes`、`packet_lines` / `packet_bytes`、`inline_full_payloads` 或 `blocked_inline_payloads`、`reference_only: true`、引用的 file/log path。若此 packet 用於 token-cost reduction 宣稱或同 payload 送多個 agent/reviewer，宣稱 MUST 引用當次 session 的真實花費（見上方「真實用量載體」，`report-session-token-usage.mjs`），不得只憑估算或口頭宣稱。

### Pre-Read Gate（對稱 Pre-Edit Gate）

對稱於 `model-delegation.md` Universal Pre-Edit Gate。TL 執行 Read（或等效讀檔操作）預估 **>100 行**之前 **MUST** 輸出 1 行 justification：

- 需要哪幾段 / 為何整檔
- 局部需求 → `sed -n '<start>,<end>p'` / `rg -n <pattern> -C <ctx>` / `grep -A N`
- 整檔必要 → 一句話論證（review 對象、整檔 cross-ref、或小檔）

**例外**：< 100 行檔案不觸發。

反例：只要 Touch + Target State 卻 Read 194 行 proposal → 改 `rg -A 50 "## Touch|## Target"`。

### Skill / Slash Command Exception（覆蓋 skill 預設模板）

Skill / Slash Command / Agent prompt-bundle 模板若預估 **>5K token**（多 agent fanout、整 diff 餵 prompt、全檔 Read 後再 narrow）→ TL **MUST**：

1. 評估降級：單 agent、縮 scope、先過濾
2. 可降級 → 紀錄於 PR body / commit message
3. 不可降級 → 紀錄 rationale

反例：150 行單檔 diff 卻 fanout 3 agents；降級為單一 reviewer 或直接本地 review。

### Readability Before Compression

每次壓縮 rule、briefing、packet 或 action-point content 都 MUST 先做 `Readability precheck before compression`：下一個 agent 能否按順序執行、分辨分支與找到 SSOT，而不靠猜測補回被刪掉的契約。若答案是否，MUST NOT 把 load-bearing contract 壓成 `high-density unreadable single paragraph`；先刪重複與低資訊內容，既有 SSOT 則引用而不複寫（上位原則見 `design-core.md` §Useful-Context Token Efficiency）。此為每次適用之 cooperative 紀律；`token-budget-precheck.md` 另訂 ≥80% 機械 backstop，附加不取代。

若保留可執行契約後仍 `over CAP`，MUST `increase the smallest practical cap/headroom`——調整最小必要 cap（mitigation 見 `token-budget-precheck.md`）並留下 rationale/guard，不得為貼線犧牲可讀性或把 cap 增加當成恢復重複 prose 的授權。

### Filter Cookbook

```bash
jq '[.[] | select(.state=="ERROR") | {id,url,createdAt}]' file.json
jq -r '.[] | "\(.state)\t\(.title)"' file.json
jq 'length, .[:5]' file.json
rg -nC2 'ERROR' file.log
sed -n '1000,1100p' file.log
```

## CJK Output Compression

CJK 輸出預設短句高密度；保留檔名、指令、數字與結論，刪背景鋪陳。

Caveman rules：先結論；少形容；短句；長清單改表；引用只留最短 anchor；狀態更新用「動作+證據+下一步」。

Before：我會進行一些必要檢查，確認狀態是否正常。
After：先查狀態；證據用 `git status --short`。

| 場景 | 策略 |
|---|---|
| final / recap | 建議壓縮 |
| progress update | 建議壓縮 |
| review findings | 結構性壓縮 |
| design tradeoff | 建議壓縮 |
| raw command / error | 不適用 |

> _Anchor: CJK 字詞密度高，但冗詞仍會放大 context。_

## Exit Criteria

- 指令前已選最小 flag
- >5K token / 200 行輸出已落地
- 摘要 ≤500 token，附原始路徑

## Common Rationalizations

- 「先看完整 output」→ 等於放棄過濾
- 「小 chore 不用量」→ <5K 可不落地，但 >200 行先 `wc -l`
- 「進 context 後再 narrow」→ 成本已付、不可逆
- 「用 Read offset/limit」→ runtime-specific；用 `sed`
- 「`gh pr diff > /tmp/x` 加了 redirect，應該能過 sandbox」→ redirect / env assignment 改變 approval-prefix matching，仍不是安全的 sandbox probe；改用 `git diff` 本地替代
- 「順手 grep archive 比較安全」→ archive 是凍結快照、量級數十至數百倍；只需 active 時掃 archive 純浪費
- 「`rg -m 20` 已經 bounded」→ 錯；`-m` 是每檔最多 20 筆，repo-wide / broad multi-path 仍可能乘上大量檔案
- 「整包 rule 先載著不會漏」→ 依 Rule Loading Scope Order 只載 AGENTS + active adapter + trigger leaf
- 「context window 夠大，塞滿沒差」→ 錯；長 context 降準確率（NoLiMa：32K 下 11/13 模型 <50% baseline；RULER：宣稱 128K 有效僅 32–64K）。砍 context 同時省錢 + 保準確
- 「規範/payload 順序無所謂」→ 打散快取前綴使 cache 失準；static 在前、dynamic 在後才命中 0.1× 讀取
- 「token 估算用 byte/3.5 就好」→ 較新世代模型換 tokenizer 多吃達 35%；該估算法系統性低估，需預留餘裕

## Verification

**Anti-Pattern**：

- ❌ `git diff` 不加 flag 先看再決定
- ❌ `cat large.json` 在 context 裡肉眼挑欄位
- ❌ MCP 萬 token 回應直接進 context
- ❌ dump 留對話「以防萬一」
- ❌ <5K 小輸出也寫檔
- ❌ 用 `Read offset/limit` 取代 `sed -n`

**Mechanical Gate 抽查**（防線：`token-frugal-mechanical-gates.test.mjs`）：

```bash
f=.devpro/agent-rules/token-frugal-io.md
for k in "Throughput-Side" "Pre-Read Gate" "MUST 先 \`wc -l\`" "Skill / Slash Command Exception" \
  "\`rg\` is not a large-output exception" "Long-output test failure evidence" "sandbox probe caveat" \
  "Fanout Payload Gate" "Rule Load Ledger Gate" "Reference-only review/handoff packets" \
  "Rule Loading Scope Order" "openspec/changes/archive" "Forbidden-path default"; do
  grep -q "$k" "$f" && echo "OK"
done
```

```bash
ls <repo-root>/notes/tmp/    # 確認落地
wc -l <file>          # × 30 = token 上限
wc -c <file>          # / 3.5 = token 估算
```
