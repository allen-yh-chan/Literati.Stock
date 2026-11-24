---
name: code-review-checklist
description: PR 六軸審查清單：功能正確性、可讀性、安全、測試充分性、工作目錄乾淨度、Release 影響。觸發：PR 建立後、請求 approve 前。
---

# Code Review 審查清單

## Overview

PR 建立後、請求 approve 前，AI 或人類審核者**必須**依六軸逐一檢查。Severity 分級：**Critical**（runtime 錯誤／資料損毀／安全漏洞）與 **Important**（可讀性差／缺測試／契約漂移）皆必須修完才能 approve／seal（in-scope／未標 `requirement_scope` 者 Critical=0∧Important=0；禁以 `tracked-follow-up`／`defer-with-owner-trigger` 關閉；範圍外例外見 R11）；**Suggestion**（命名／風格）可 disposition，不擋 seal。

> **Scope caveat — 閘威脅模型依治理對象二分**（SSOT `design-core.md` §11）：**流程遵循類**閘只有對**自然指令**的 false-positive／false-negative 算 **Critical**；只靠**對抗性 shell 等價寫法**才繞得過的 bypass **最多 Suggestion**，不適用下方 whack-a-mole→Critical。**安全合規產出類**（§11 floor 六項）維持 fail-closed + Critical；未列入兩表者依治理對象性質判定（治理產品安全或合規產出者歸此類，其餘歸流程遵循類，主張此類者須指出保護的產出）。閘與審查防 AI 的不小心，不防存心偽造（§11 原則）；此類維持 adversarial。fail open／closed 另依不確定性種類：解讀自然動作不確定→fail open+advisory 是設計決定；證據缺漏或格式不完整→fail closed。
> **Requirement anchoring（R11）**——SSOT `openspec/specs/code-review-checklist/spec.md`。審查前 MUST 先寫「**本包目的＝**…；done_when 共 N 條」；每條 finding 標 exactly one `requirement_scope`（`in-scope`／`out-of-requirement`／`scope-unresolved`）並具名 referent——**無 referent 的標註無效**。`out-of-requirement`／`scope-unresolved` MUST NOT 進本包 Critical／Important 分級（後者須註明需 TL 裁示），改記待辦且**原 severity 標註 MUST 原樣保留**（`requirement_scope` 與 `severity` 正交、互不改寫；**MUST NOT** 因 `scope-unresolved` 強制改寫為 Suggestion）。恆 in-scope：class-two 缺陷／overclaim／spec↔code 矛盾。scope 判定先於下方 Defer 濾網。收據側（SSOT spec § Requirement Scope Seal Disposition）：`out-of-requirement` 的 Critical／Important 可 `tracked-follow-up` 關閉；`scope-unresolved` 另需 TL 於 `decisions.md` `## Scope Rulings` 綁 finding、observation hash、round、`proposal_sha256`（`git show <HEAD>:openspec/changes/<change>/<proposal carrier> | shasum -a 256`）的裁示，且先於派工 commit；`defer-with-owner-trigger` 永不關閉；T4 commit 須同時刪改受影響裁示。TL 側：**審查者提出 ≠ 需求成立**，拒收 **MUST 具名拒收**並記待辦。

**decisions.md 讀取指引**：reviewer 先讀 diff 形成獨立判斷，再讀 `openspec/changes/<name>/decisions.md`（若存在）比對。理由不足以解釋設計選擇 → 標為 Important。Reviewer **MUST** 依實際行為與影響、既有 severity／閘威脅模型分級；**MUST NOT** 僅因 proposal／decisions 記載而降級或豁免 Critical／Important finding。

## When to Use

- PR 建立後、請求 approve 前（必觸發）
- AI 完成實作後的自查

**Load-chain**：Evidence claim／reviewer finding 觸發條件→`pr-review-evidence-verification.md`（cooperative-only；AGENTS+grep guard）。

### 路由分流

「審查 PR」預設走六軸自審；cross-model 第二意見是 specific 動作，非泛審查預設。

| 情境 | 動作 |
|---|---|
| AI 自查、approve 前例行審查 | 依下方六軸逐軸檢查，完成後 approve |
| human reviewer 審查別人開的 PR，要求 AI 協助草稿／代發 | invoke `devpro:pr-review`（`.devpro/agent-skills/devpro-reviews/pr-review/SKILL.md`）；泛稱 review 的自審預設不變 |
| 收到 merge gate block 提示（`invoke /devpro:cross-review`）、或需要跨模型第二意見並寫回 PR sticky comment | invoke `/devpro:cross-review <PR#>`（詳見下方 Cross-Model Second Opinion 節） |

> **注意**：上述為「審查 PR」的**路由落點**（六軸自審為入口預設）。但 cross-model 第二意見本身仍是 feature/bugfix/chore B PR **merge 前的 default-on 強制 gate**（見下方 §Cross-Model 第二意見），非可選——「路由落點」與「merge gate 強制性」是兩個 scope，勿混淆。

## Process

### Enforcement Metadata

本表限定 reviewer guarantee-ceiling design admission；其他 sub-check 沿既有 carrier。Packet 傳輸邊界的 fail-closed carrier 見 `review-guarantee-ceiling.md` 的 metadata。

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for design-admission semantics |
| Advisory | `second-review-checklist.mjs` 把 owned criteria 帶入 packet |
| Doctrine | `cooperative-only`：新 obligation 的 consumer／相容性由 TL／reviewer 核對 |

### Local Deep Review（PR 前 / staged diff）

PR 未建立、或 commit/push 前自查時，先用本段速查 staged/current diff；不取代下方六軸與 cross-model gate。

| 維度 | 檢查 |
|---|---|
| Security | secrets、SQL/command injection、PII/log/querystring、auth/authz 邊界 |
| Performance | N+1、阻塞 I/O、重複計算、明顯 memory / async misuse |
| Maintainability | 既有風格、命名、dead code、debug output、未使用 import |
| Test/QA | RED 證據、相關測試、QA scope 是否對應 touch list |

**Trajectory sanity（條件式）**：PR 涉及 agent workflow、tool invocation、external reviewer CLI、hook orchestration、或 cross-model review 時，reviewer 檢查可得 transcript / log / sticky / test evidence：repeated failed commands、wrong execution surface、unsafe retry、permission/schema fault、budget exhaustion、`error_max_turns` / max-turns。Final diff 正確不會抵消危險 trajectory；若該 path 可能造成資料損壞、安全暴露、merge-gate bypass、或 user-visible wasted time，依風險標 Important/Critical。

輸出只列 findings，不做 rewrite 建議；Critical 必須是真阻擋問題。若 diff 牽涉 `.devpro/agent-rules`、hooks、commands、agents，特別檢查是否改變規則/gate 卻未更新 OpenSpec 或測試。

#### 送 Cross-Review 前自驗清單

cross-review（送外部模型）是**最後一道確認**，不是第一道抓錯。送審前先逐項自驗，低級錯（canon 不一致 / 橡皮圖章 test / proposal 說謊 / cite 錯）攔在送審前，省 cross-review 輪次。**本清單為索引，規則內容見各 SSOT，不在此複寫：**

- **內部一致性**：同一概念（canon 句 / 術語）在 leaf / 範例 / proposal 逐字一致 → `rules-consistency-checklist.md`
- **負向測試**：新增的 grep / 機械 test 有負向 case（破壞被守的內容 → test 必 FAIL），非橡皮圖章 → `testing-and-qa.md`
- **proposal 不 overclaim**：proposal 聲稱的（如「已加負向測試」）在 diff / 檔案中真的存在 → 上方軸 2 overclaim sub-check
- **cite 正確**：引用的 `<file>:<line>` / evidence claim 機械驗證為真 → `pr-review-evidence-verification.md`

### 1. 功能正確性

- 若變更 diagnostic／logging：確認問題再次發生時可用安全且有用的 correlation／context 診斷；資料安全依 `security-coding.md`，不一律要求 try/catch 或 plaintext log。
- 若變更 UI markup／attribute：檢查 submit、Enter、event、TypeScript binding 與 caller 行為；prototype 是脈絡，非契約權威。
- 所有審查的缺材料情境：缺可選材料不自動列 Important，severity 依實際影響與 scope；必需證據與 gate 不因此豁免。
- 若 PR 含 proposal / specs：變更是否符合 OpenSpec change 的 touch list 與 target state 描述？若無 proposal（lite／chore/ 前綴車道）：PR description 是否清楚陳述目的、影響範圍與驗收條件，PR file scope `git diff <target-base-ref>...HEAD --name-only`（三點；或等價 merge-base→HEAD diff）結果與描述一致？
- **Task 完成宣稱 vs checkbox+證據一致 sub-check**：PR 含 full proposal/tasks 或 B-mini proposal-mini 時，reviewer **必須**逐條比對「proposal/PR body 宣稱完成的 task」與 canonical task-ledger artifact（full=`tasks.md`；B-mini=`proposal-mini.md`）的**實際 checkbox 狀態**：每個宣稱完成者必須 `- [x]`（非 `- [ ]`）**且**帶結構性證據 anchor（`[Req: R#]` + 一行 `驗收:`/acceptance 句），空打勾（勾但無證據）或宣稱完成但 checkbox 仍未勾 = 不一致，標 **Important**。這是 §Cross-Review 前自驗清單「proposal 不 overclaim」在 task 執行狀態上的對應軸——防記憶驅動「宣稱 all done 但沒回勾／回勾無證據」（本 session PR #1430 即漏此軸，靠異家族 cross-model 才抓到）。機械面由 `lint-proposal-tasks-checked.mjs`（pre-archive）+ `pre-pr-archive-gate.mjs` check (o)（post-archive）雙閘負責；本軸補人工語意對照（宣稱 vs 實際）。SSOT：`openspec-quality-and-formats.md` §Tasks.md 品質要求「執行迴路」。
- **Spec↔Code Behavioral Consistency sub-check（cooperative-only）**：PR 觸及 `openspec/specs/<cap>/spec.md` 時，reviewer **必須**對 PR scope 內每個受影響 `#### Scenario:` 的 WHEN/THEN 行為契約，逐條核對 code 實作行為是否吻合。**spec 描述 A、code 實作 B、且 PR 的 proposal / proposal-mini / decisions 未載此差異** → 標 **Important**（附 spec scenario 引用 + 偏離的 code `file:line`）。與上方 proposal-claim 類 sub-check（touch-list / target-state 符合、task 完成宣稱、overclaim）的差別：那些拿「**proposal 的宣稱**」當比對源，本軸拿「**spec 的行為契約**」當 current behavior 的 source of truth（per `openspec-flow.md` Intent Lookup Order）逐條驗 code。**已載明的差異本身不標**（僅免「偏離」finding；**MUST NOT** 因 proposal／decisions 記載或 spec↔code 自洽而降級／豁免 correctness/security 缺陷，仍依既有 severity／閘威脅模型分級）。純語意判斷、**不要求外部工具、無 mechanical hook gate**（「spec 說 A / code 做 B」無零誤判機械 anchor）。**分級預設 Important，不因單純偏離就升 Critical**（Critical 仍留給 correctness/security 缺陷）。適用 `dp-reviewer` 與 `devpro:second-review`——second reviewer 的 renderer 每次動態讀本 checklist 進 packet，故改本軸即同時涵蓋兩者，無需改 agent 檔。理由：現行軸都以 proposal 宣稱為比對源，缺一條直接盯 spec↔code 行為一致的原則；「spec 與碼一起錯但內部自洽」正是 same-family model 集體漏接的盲區，異家族 cross-model 才易抓到。SSOT：`openspec/specs/code-review-checklist/spec.md` §Spec↔Code Behavioral Consistency Sub-check。
- **Scenario Omission Disclosure sub-check（cooperative-only）**：PR 新增／修改 spec-delta requirement（`### Requirement:` 於 `## ADDED`／`## MODIFIED Requirements` 下；archive 前在 active delta `openspec/changes/<name>/specs/<cap>/spec.md`，archive 後在 archived delta `openspec/changes/archive/<YYYYMMDD>-<name>/specs/<cap>/spec.md` ＋ promoted canonical `openspec/specs/<cap>/spec.md`——本 repo archive 先於 push/PR，正常 PR 形狀即後者；`devpro:second-review` 於 archive 後審查，**MUST NOT** 因 active 路徑不存在而略過本 sub-check）時，reviewer **必須**檢查該 requirement 的 `#### Scenario:` 區塊：除 happy path 外，**明顯的主要 error／邊界／negative 路徑**是否已寫成 scenario，或在 PR 的 proposal／proposal-mini 明列「刻意不涵蓋＋理由」。**存在明顯主要 error/邊界路徑、既未寫成 scenario、proposal／proposal-mini 亦未宣告刻意省略**（即無聲省略）→ 標 **Important**（附 requirement 名 + 缺漏路徑）。本軸只驗「**有無無聲省略（涵蓋範圍是否明講）**」、**不判客觀完整度**——比照 Notes Disposition 閘「只驗有無明講、不判品質」：已寫成 scenario 或已宣告省略即放行，不追問「寫得夠不夠齊」；requirement 若本無明顯 error/邊界路徑（純宣告式）亦不標。與上方 §Spec↔Code sub-check 的差別：那條驗「既有 scenario ↔ code 行為吻合」，本軸驗「requirement 自身的 error/邊界 scenario 是否**存在或被宣告省略**」；與 `scenarios` capability §Enforcement Carrier Scenario Coverage 的差別：那治理獨立 `scenarios/scenario-*.md` narrative 檔，本軸治理 spec-delta requirement **內部**的 `#### Scenario:` 區塊。純語意判斷、**不要求外部工具、無 mechanical hook gate**（「哪些 error 路徑算主要」需語意判斷，無零誤判機械 anchor；upstream `openspec validate --strict` 只強制每 requirement ≥1 scenario，不驗涵蓋面）。**分級預設 Important**（Critical 仍留給 correctness/security 缺陷）。適用 `dp-reviewer` 與 `devpro:second-review`（後者由 renderer 動態讀同一 checklist 進 packet，無需改 agent 檔）。作者側前饋（寫入當下「涵蓋或宣告」）見 `openspec-quality-and-formats.md` §Writing Spec Deltas「scenario 涵蓋面宣告」。SSOT：`openspec/specs/code-review-checklist/spec.md` §Scenario Omission Disclosure Sub-check。
- **Resource Lifecycle / Memory Leak sub-check（cooperative-only）**：PR 觸及**資源生命週期相關 code**（`IDisposable` / `IAsyncDisposable` 型別、file / stream / DB connection / socket / handle、C# event `+=` 訂閱、可無界成長的 collection / cache）時，reviewer **必須**查資源是否正確釋放：(a) `IDisposable` 未包 `using` / 未 `Dispose()`；(b) connection / stream / handle 開了未關（例外路徑亦須關）；(c) event handler `+=` 無對應 `-=`（訂閱者無法 GC）；(d) collection / cache 一直塞無清除策略（無界成長）。命中且無釋放/解除/上界 → 標 **Important**（附 `file:line`）。純語意判斷、**不要求外部工具、無 mechanical hook gate**（資源生命週期跨 method / 跨檔，無零誤判機械 anchor）。**分級預設 Important，不因單純未釋放就升 Critical**（Critical 仍留給 correctness/security 缺陷；除非洩漏明確造成 DoS / 服務崩潰之 correctness 失效）。適用 `dp-reviewer` 與 `devpro:second-review`（動態 cat 同一 checklist，無需改 agent 檔）。理由：現行六軸「安全」軸是資安（SQLi/PII/憑證/授權），**不含資源生命週期**；memory / resource leak 原為明文盲區，只靠 reviewer 通用判斷側面覆蓋、易漏。SSOT：`openspec/specs/code-review-checklist/spec.md` §Resource Lifecycle Leak Sub-check。
- **Reviewer Live Output-Line Bound sub-check**：下列 65,536／65,537 界限是 second-review wrapper 的契約；ordinary-primary review runner（`.devpro/scripts/lib/opencode-primary-review.mjs`）的 stdout 單行另依 `openspec/specs/code-review-checklist/spec.md` §Ordinary-Primary Review Runner Bounds Its Stdout Lines Separately 核對（stdout 恰 524,288 raw UTF-8 bytes 接受、第 524,289 byte fail closed；stderr 仍是 65,536／65,537），審該 runner 時以該 requirement 的 stdout 數字取代下列 stdout 的 65,536／65,537，其餘 fail closed 與 no-truncate 要求不變，thinking carrier 例外只屬 wrapper。PR 觸及 reviewer CLI runner、wrapper、stdout/stderr line accumulator、或 terminal classification 時，reviewer **必須**核對generic/tool/result/completion/mixed/unknown stdout與所有stderr：單一 live line恰為 **65,536 raw UTF-8 bytes必須接受**；第 **65,537 byte必須fail closed** 為 `reviewer_output_line_too_large`，立即啟動bounded termination，不得truncate-and-continue。唯一封閉例外是thinking-capable reviewer-family stdout在64 KiB前已可辨識的thinking或signature-delta candidate：thinking與signature各可進固定 **1,048,576-byte** carrier，但完整JSON parse後必須strict thinking-only或signature-only（exact own-key-set）才可discard；malformed、mixed、non-thinking、non-signature、unknown或超cap仍fail closed。Discard不得進tool、terminal、completion、findings、sticky或review authority，control telemetry不得含thinking text；raw bytes仍先寫既有sidecar。任一漏邊界、authority leakage或讓unsafe oversized line繼續執行 → 標 **Important**；若可造成merge-gate bypass、wrapper OOM或reviewer descendant失控，依影響升 **Critical**。測試證據須包含generic/stderr 64 KiB matrix、observed thinking positives、strict closure negatives、bounded termination與raw sidecar retention；只測generic accumulator不足以證明production routing。SSOT：`openspec/specs/cross-runtime-parity/spec.md` §Cross-runtime second reviewer timeout cadence is aligned（「Both hosts reject duplicate init and oversized live lines」scenario）與 §Canonical Second-Review Packet Template。
> Load-chain（Reviewer Durable Terminal Authority）：完整 schema 與 allowlist 載入 `second-review-control-evidence.md`。

- **Reviewer Durable Terminal Authority sub-check**：PR 觸及 second-review dispatch lineage、terminal receipt、sticky parser、marker/capacity mutex或cleanup時，reviewer **必須**依 `second-review-control-evidence.md` 驗：cross-head predecessor恰為gate-consumed fault、runner-owned verified success、closed-terminal（runner-owned，或`second-review-control-evidence.md` §2 所列 operator slot／lifecycle slot衍生的pre-spawn recovery terminal）、external accepted completion或external voided terminal五種互斥closed evidence（external兩形需配對closure slot、免invocation claim）；另可接受該SSOT的獨立operator disposition作fresh full-pr predecessor，不宣稱close、不抹除findings，完整重審義務須穿過失敗retry保留。invocation claim與termination-unconfirmed單獨仍in-flight。Closed-terminal只能在pre-spawn已知terminal，或post-close且transport/process-group cleanup確認後發布；sticky authority欄位exact-once；live／ambiguous mutex owner不得被stale recovery偷取；normal release、stale recovery與marker clear unlink後皆fsync parent。任何missing/corrupt/duplicate/multi-terminal evidence、first-match sticky、claim-only advance或未確認cleanup即關閉 → 至少 **Important**；可繞過merge gate或遺留descendant時升 **Critical**。完整schema與allowlist只由`second-review-control-evidence.md`持有，本checklist不另建平行SSOT。
- **Reviewer Host-Surface Preflight sub-check**：PR 觸及 external reviewer projection／probe／spawn時，reviewer **必須**驗renderer-owned canonical recipe含family exact `auth_preflight`，且runner只在help flags通過後、neutral cwd／claim／spawn前用相同inherited environment直接執行；只有exact success可保留`flags_supported`。restricted-HOME、nonzero、timeout、overflow、malformed、logged-out或ambiguous evidence必須pre-spawn fail closed為`reviewer_host_surface_unverified`，不得誤報真正auth failure；raw auth output、excerpt、hash、identity、token、path不得進artifact。Sidecar/env/allowlist/workdir/sandbox probe/output keyword不得當capability proof。漏任一機械界限標 **Important**；可錯誤dispatch或洩漏credential/identity evidence時升 **Critical**。
> Load-chain（Cross-Carrier Assertion Consistency）：完整 sub-check（cooperative-only、窮盡律、語義不變量）見 `code-review-cross-carrier.md`。
- **Cross-Carrier Assertion Consistency sub-check（cooperative-only）**：PR 改跨 carrier 語意斷言時載入上列 sibling 執行完整核對；軸 1 經 pointer 到達。SSOT：`openspec/specs/openspec-flow/spec.md` §Cross-Carrier Assertion Synchronization。
- 邊界條件與例外路徑是否處理？有無邏輯遺漏（只處理 happy path）？
- **Root-cause adequacy（非 trivial fix）sub-check**：PR 改 ≥ 5 行 enforcement 路徑（hook / gate / regex / 規則 phrase）→ 驗 PR description / proposal 是否 articulate root cause（非僅 symptom），對應 `troubleshooting.md` Debug Report 五欄。surface fix 標 Important；明顯 whack-a-mole（同類未一併處理）標 Critical。豁免：trivial typo / formatting / chore A（對齊類除外，per `chore-classification.md`）。**兩個具名例外面**：(1) **流程遵循類**閘（見 Scope caveat）的「同類問題」若是**對抗性 shell 等價 bypass**（AI 正常不產生），未一併窮舉**不算** whack-a-mole-Critical——enumeration 無窮、收斂無意義，標 Suggestion／deferred；對自然指令的誤擋／漏接同類未修仍 Critical。(2) **R11 面**：「同類」落在本包 done_when 未聲稱涵蓋的載體上 → `out-of-requirement`＋`tracked-follow-up`＋owner。判準：不一併處理時，某條**已聲稱成立**的 done_when 是否出現已知假陽性／假陰性——是則仍 Critical，**R11 不豁免**。Root-Cause First 與 R11 **正交**：articulate root cause ＋ 列同類清單是**無條件義務**，R11 全不豁免；只有「當場一併修」的範圍以 done_when 為界，界外具名記待辦。Per `ai-autonomy-root-cause.md` §Root-Cause First。
- **Regex 字元類 / boundary sub-check**：PR 改 regex 字元類 / whitespace 量詞 / anchor → 逐一驗被加/移除的成員（`\s` 含 `\n\r\t`，動它即動 newline 命令邊界）、配 `\n`/`\r` 分隔測試、斷言可觀測；對自然指令誤擋/漏接 = Critical。SSOT：`anti-patterns-behavioral.md` §14。
- **SQL Index Coverage sub-check（cooperative-only）**：PR (a) 新增/修改 `sql/**` 的 `create table`；(b) 新增/修改 `sql/**` 的 `create index`；或 (c) 同時觸及 `sql/**` 與 repository/DbContext query code 時，reviewer **必須**核對 `database-conventions.md` §Index 設計要求的盤點是否存在且與 diff 自洽：index 是否標註對應程式使用點，或「無需 index」是否附原因。**reviewer 只核對盤點存在與自洽，不要求重新推導 live schema 現有 index**（DDL 散在歷次 change 的 `sql/` 且由 DBA 套用，非 diff 可得資訊）。缺盤點 → 標 **Important**（附 `file:line`；盤點缺席常無明確 file:line 可附時，改指出缺漏載體——script 檔頭或 PR 描述）；盤點存在但與 diff 不自洽（例如引用的程式方法不存在於 diff、或 index 欄位組合與所引查詢述詞對不上）→ 同樣標 **Important**（附盤點聲稱 vs 實際 diff 的矛盾之處）。**分級預設 Important，不因查詢運行於 hot-path 或高流量路徑就升 Critical**（Critical 仍留給 correctness/security 缺陷；此 sub-check 治的是效能盤點缺席，非 correctness/security 缺陷本身）；盤點顯示建了無使用點的 index（預防性 index）→ 標 **Suggestion**，但 correctness-bearing index 與 FK 支援 index 不誤標（兩者豁免依據不同，分類判準見 `database-conventions.md` §Index 設計要求）。純語意判斷、**不要求外部工具、無 mechanical hook gate**（盤點存在性可能跨 script/PR 描述，無零誤判機械 anchor）。適用 `dp-reviewer` 與 `devpro:second-review`（後者由 renderer 動態讀同一 checklist 進 packet，無需改 agent 檔）。規範內容本身 SSOT 仍為 `database-conventions.md` §Index 設計要求；本條只補 reviewer checklist 覆蓋面。SSOT：`openspec/specs/code-review-checklist/spec.md` §SQL Index Coverage Sub-check。
- **證據**：專案約定測試指令全綠、新增或修改的測試覆蓋變更範圍

> Load-chain（reviewer 保證上限）：保證上限、finding 分類或必填輸出設計，載入 `review-guarantee-ceiling.md` 的 `Review Admission Checklist`；新 review 評估輸出／TL consumer 接收，載入同檔 `Review Output Contract`；本行只作 pointer。

### 2. 可讀性與架構

- 大括號是否符合 K&R？閱讀負擔、共享 invariant／知識與重構等價依 `code-simplification.md` 判斷，不以相似次數直接判違反 DRY。
- C# 現代語法是否合理使用（primary constructor、pattern matching 等）？
- 公開 API 是否有文件註解（.NET `/// <summary>`、TSDoc / JSDoc、Python docstring，正體中文）？
- **Smell／判斷啟發式（選性；交叉 Fowler；不重寫六軸）**：長函式／重複邏輯／過深巢狀／名稱與行為不符 → 標 Suggestion 或 Important；勿把 smell alone 當 confirmed root cause（偵錯硬閘見 `troubleshooting.md`）。
- **SSOT-drift sub-check（rule body 變更專用）**：PR 觸及 `.devpro/agent-rules/**/*.md`，**對新增 rule body** 抽 anchor 字串（regex literal / placeholder / verb 集合 / row label），**跨 repo grep**；hit ≥ 2 檔 → 標 **Important**。豁免 `*-fallback.md`（per `rule-design-principles.md` 守則 1）。
- **When to Use Trigger Decidability sub-check（rule body 變更專用；cooperative-only）**：PR 新增或修改 `.devpro/agent-rules/*.md` 的 `## When to Use` 段落時，reviewer **必須**核對其中至少一條觸發條件是否符合 `rule-file-template.md` §Section 順序與 5W2H 對應「目標行為尚未發生時可判定為真」條款：以規範自身名詞／動作當唯一條件（循環）不算數；合取式子句任一 conjunct 以目標行為已在進行中為前提，即使其他 conjunct 單獨可判定，整條仍不合格。命中違反 → 標 **Important**。純語意判斷、**不要求外部工具、無 mechanical hook gate**（「是否循環」屬語意判斷，無零誤判機械 anchor，per `design-core/spec.md` §Mechanical Tests Must Not Regex-Judge Materiality）。適用 `dp-reviewer` 與 `devpro:second-review`（後者由 renderer 動態讀同一 checklist 進 packet，無需改 agent 檔）。SSOT：`.devpro/agent-rules/rule-file-template.md` §Section 順序與 5W2H 對應。
- **NEW named／新具名定義 corpus-grep（任何 PR）**：任何 PR 新增 NEW named／新具名定義 MUST 做 corpus grep 並留證據（範圍＋結果／命中；非 self 命中須 disposition；cite `dry-ssot-corpus.md`）；禁 silent small-diff 豁免。
- **Promote-class drift sweep sub-check（status/phase label promote）**：當 PR 升 status / phase label（如 describe-only→executable、Phase 1→2 或其他**跨 SSOT 鎖死**之狀態同步），reviewer 須對舊 label 字面 grep 掃 (a) `openspec/specs/**/spec.md`、(b) `.devpro/agent-rules/**/*.md`、(c) `.claude/agents/*.md` 與 `.claude/commands/**/*.md`；touch list 外命中 ≥ 1 → **Important**。豁免 `openspec/changes/archive/**`。判定由 reviewer 語意判斷，鎖定跨 SSOT label drift 而非 chore-level 對齊類（README ↔ CHANGELOG 等）；無 mechanical gate。理由：proposer 自陳 touch list 不足以發現別檔的 SHALL/MUST 鎖死舊用詞（PR #700 漏 2 件即此類）。
- **Promoted-spec normative overclaim sub-check（cooperative-only）**：當 PR 包含 `openspec archive` promote canonical spec（即 `openspec/specs/<cap>/spec.md` 在 touch list 內被新增或修改）時，reviewer 對 promoted spec 中的每一個 SHALL/MUST 動詞逐句與**同 PR 的 proposal/decisions 中已知限制**比對；若 spec 宣稱「SHALL 自動觸發」或「SHALL fire on threshold」但 proposal/decisions 明示「無自動閾值」或「cooperative-only」，則矛盾標 **Important**。本 sub-check 全憑 PR 內既有資訊人工判斷，**不要求外部工具**。Rationale（標 cooperative-only 之原因）：normative overclaim 無零誤判機械 anchor——同一個 SHALL 動詞在不同 context 可以是正確的，無法用 literal grep 區分；只有 reviewer 對照 proposal 語義才能判斷是否矛盾。Mechanical 面由 `pre-pr-archive-gate.mjs` check (n) 負責（placeholder 殘留），本 sub-check 補 normative 內容層的缺口。
- **SQL Keyword Casing Convention sub-check（cooperative-only）**：PR 觸及 SQL script 檔案、fenced ` ```sql ` 範例、或 host language 字串常數內嵌的 SQL 時，reviewer **必須**核對 SQL 關鍵字（clause、資料型別、內建函式、`null`/`not null`）大小寫是否符合 `database-conventions.md` §SQL 關鍵字大小寫慣例（皆小寫；`@@` 開頭系統變數/函式保持全大寫）。命中偏離 → 標 **Suggestion**（風格，不阻擋）；identifier（table/column/constraint 命名）與 prose 說明文字中提及的關鍵字不受本 sub-check 約束。純語意判斷、**不要求外部工具、無 mechanical hook gate**。適用 `dp-reviewer` 與 `devpro:second-review`（後者由 renderer 動態讀同一 checklist 進 packet，無需改 agent 檔）。規範內容本身 SSOT 仍為 `database-conventions.md`；本條只補 reviewer checklist 覆蓋面。SSOT：`openspec/specs/code-review-checklist/spec.md` §SQL Keyword Casing Convention Sub-check。
- **證據**：無 build warning、符合既有程式碼慣例

### 3. 安全

- Query string 是否含 PII？SQL 是否全部 parameterized？
- EF Core 是否誤用 `.FromSqlRaw()` 搭配字串插值？
- Log / 錯誤訊息是否洩漏憑證或 PII？
- **AJAX/fetch 後發先至（cooperative-only）**：diff 觸及搜尋／filter／pagination／typeahead／detail reload／名單或 context 切換等重複發 AJAX/fetch 的流程時，是否具備 latest-only 防線（`AbortController`／sequence id／response 比對目前 context）？缺則 Important。SSOT：`security-coding.md` §AJAX/fetch 後發先至。
- **證據**：PR 說明中明確記錄「已檢查 SQL injection」與「已檢查 PII 曝露」

> Load-chain（存取稽核軌跡 Sub-check，cooperative-only，預設 Important）：client context（Client IP／來源 Port／User-Agent 等）欄位與披露規則見 `security-access-audit-trail.md`。
- **存取稽核軌跡 Sub-check（cooperative-only）**：PR 觸及 client context（Client IP／Peer IP／來源 Port／User-Agent）擷取邏輯、或稽核儲存設計時載入上列 sibling 執行完整核對。SSOT：`openspec/specs/code-review-checklist/spec.md` §Client Context Access Audit Trail Sub-check。

### Primary Reviewer 測試執行政策

Primary `dp-reviewer` 評估軸 4（測試充分性）時，預設**禁止自主執行測試套件／build**。TL／`devpro:pre-pr` 派工前已以 `--changed main`／`--pre-review`（或專案約定等價指令）取得全綠 evidence；reviewer MUST 核對委派 prompt／收據中的 test evidence（指令、pass 數、終態）與 diff／測試檔涵蓋來判定，不得為「保險」重跑 `full suite`、`budget gate`、`--changed main`／equivalent `--changed <base>` tier suite、或多 gate insurance rerun。`--changed main` is not scoped rerun。只有對 evidence 可信度有具體疑慮（缺失、互相矛盾、結果可疑、需確認具體 finding）時，才可 scoped 重跑直接相關測試，且範圍 MUST 窄於整段 change-scoped suite；findings／報告 MUST 記錄 scoped rerun 的具體疑慮。此約束面僅 primary `dp-reviewer` subagent；**不改** TL pre-PR `--changed main`／`--pre-review` 治理。Second-reviewer 對齊見 `pr-review-evidence-verification.md` §(主) Second Reviewer 不重跑 primary 已綠 tests（約束面不同，不得互相覆蓋）。

**PR-stage integration 證據範圍**（範圍定義 SSOT：`test-suite-cadence.md`「PR-stage integration 證據範圍」）：本 PR 新增或修改的 integration tests（含被改 integration-tier sharded body 的 shard-import wrappers）仍須有全綠 primary evidence，缺了照舊可列 finding；其他 integration tests（包括未改 test 的 hook、script、`SKILL.md` 等 carrier 對應的 tests）與 `--tier all` 的證據缺席 **MUST NOT** 列為 finding。reviewer 對某個未改 test 有具體疑慮時，仍可依上段 scoped rerun 並記錄疑慮；缺證據本身不構成 finding。

### 4. 測試充分性

- 新增行為是否有對應 unit test？bug 修復是否有先寫失敗測試再修？
- 測試程式碼是否位於獨立測試專案（per `testing-and-qa.md` Exit Criteria）？
- `qa-test-scope.md` 是否已產出且內容完整（變更範圍、驗測重點、風險、回歸清單）？B-mini 例外：檢查 `proposal-mini.md` `Tasks` 段 task outline 與 grep/test assertion evidence。
- **Negative Assertion Specificity sub-check（cooperative-only）**：diff 新增／修改 fail-closed 負向測例（`assert.throws`／error-match／typed-reason 斷言）且 claim 鎖定某個具名 predicate 時，reviewer **必須**核對：(a) 斷言是否對準 **intended failure class**（非跨多個 failure class 的 OR-union）；(b) fixture 是否到達該 predicate 的執行相位（例：Prefer-A output disagreement 須 change-base 已有不變 oracle）。命中假綠形狀 → 標 **Important**。SSOT：`testing-and-qa.md` §Negative Assertion Specificity。
- **條件式（一般 UI）**：若 diff 觸及 `DesignerSelect` `RootClass`，prove-it／手動核對是否鎖 **單一** BEM token（禁多 token；非 Host-only）？漏則 Important（行為破壞可升 Critical）。詳見 `testing-and-qa.md` §UI smoke。
- **UI layout／wireframe（cooperative-only）**：新建／重建 user-visible Web 且無設計稿時，實作前是否有 `ui-wireframe: approved (provenance: user)`？user-visible 文案是否出現單字元独占一行？漏則 Important。SSOT：`frontend-ui-layout.md`。
- **證據**：測試指令全綠、`qa-test-scope.md` 路徑；B-mini 則為 `proposal-mini.md` + grep/test assertion evidence 路徑

### 5. 工作目錄乾淨度

- `git status` 是否有 AI 工作過程中產生的臨時檔案殘留（偵錯腳本、暫存輸出、探索性測試檔、temp 目錄等）？
- **證據**：`git status` 無非預期的 untracked files

### Cross-Platform（條件式）

- 若 diff 涉及 `.claude/settings.json` hook commands、`.devpro/scripts/**` `.sh` 檔、或 rule file 範例中的 inline shell command：驗證 pattern 在 macOS / Linux / Windows（cmd + PowerShell）皆可執行
- Flag POSIX-only built-ins（`test -f`、`[ -f`、`find . -name`）— 改寫為 Node.js APIs；目錄 fsync 屬 syscall 語意非 built-in，需 win32 no-op＋揭露
- Hook / Node script 解析使用者或 payload 提供的路徑時，MUST 同時接受 Windows（`C:\...` / `C:/...`）與 Git Bash POSIX 驅動器形式（`/c/...`）；解析失敗 MUST 與「解析出錯誤分支」分開表述，不得印 `非 main branch ((none))`
- **證據**：hook commands 無 POSIX-only built-in；`cross-platform-hook-commands.test.mjs`、`directory-fsync-portability.test.mjs` 全綠

### 6. Release 影響（條件式）

- 新增第三方套件：授權是否為允許清單內（MIT/Apache-2.0/BSD/ISC）？PR 是否註明 SPDX？
- 涉及 DB schema 變更：`sql/<change-name>/` 是否包含對應 SQL script？路徑是否無 `sql/feature/` 等 branch-type 前綴？每個 script 是否有 `-- [ROLLBACK]` 區段？命名是否符合 `<序號>_<描述>.sql`？
- 涉及 API 契約變更：是否為 breaking change？若是，PR 描述標記 `[BREAKING]`
- 版號影響評估：屬 Breaking / Minor / Patch 哪一級？結論為「不需要 bump」也須明確說明理由

### 審查輸出格式

```
## Review Summary
- **Critical**: 0 件
- **Important**: 1 件（描述）
- **Suggestion**: 2 件（描述）
- **已檢查**: SQL injection ✓ | PII ✓ | 授權 ✓（或 N/A）
```

`design-core.md` §11 的 `batch-scope-record-residual` 對照：primary 僅記為非阻擋觀察，**MUST NOT** 列為 Suggestion／Important／Critical；例外的封閉範圍與自我適用限制仍照 SSOT，不擴及其他偽造證據。

`design-core.md` §11 的 `per-pr-waiver-record-residual` 對照：前提成立時，primary 只記為不阻擋的觀察，**MUST NOT** 升為 Suggestion／Important／Critical；前提不成立、矛盾證據或其他偽造照 F-9，自我適用限制照 SSOT。

> **TL 單 context fallback**（dp-reviewer 不可用 / Others runtime 主路徑）：詳見 `.devpro/agent-rules/code-review-checklist-fallback.md`

### Bounded Six-Axis Rereview Cadence

Stable final tree MUST 完整跑一次六軸；committed active precedes archive。Bounded scope=open finding IDs+repair delta (`repair-delta`)+immutable dependency-closure；ReviewRoundReceipt binds previous_receipt_digest_sha256+initial_full_receipt_digest_sha256。
Invalid receipt/lineage/risk/closure or repair/closure exception=>full; content-comparison incomplete=>non-PASS+disposition; out-of-manifest/new Critical=>record as a full reopen observation, then classifier-issued `route=full` dispatch (unrecorded observation=>`record_observation_required`).
**Wording repair**：count<3 時，上一輪新提的 finding 全是 Suggestion，且本輪 risk shape 只動到它們 `fix-now` 指到的地方（有 `carrier` 是 `design.md` 的 → design `## Decisions` 內文；`carrier` 是 `proposal.md` 且 `anchor` 出現在該列原文的 → 那一列安全義務），classifier 給 bounded `wording_repair_bounded`（count+1）；risk class、requirement tuple、Touch 列、D 編號增刪或未點名的安全列仍 full。TL 把授權的 finding ID 交給 reviewer；reviewer 判斷不只是措辭時記 `postDispatchDiscovery=wording_repair_substantive` 走 full。canonical：`openspec/specs/code-review-checklist/spec.md` Wording Repair 段。
`bounded_rereview_count` monotonic；0..2 bounded+1；count=3 或 stall 可收斂 → `convergence_recovery` focused bounded（非預設 handback）。下一輪仍 gate 住且無綁定上一 recovery `dispatch_id` 的 per-id disposition → `recovery_disposition_required`（非 handback、不要求 unlock）。真 handback 僅 `handbackCause` ∈ `requirement_conflict`｜`irreversible_high_risk`｜`reviewer_unrecoverable`；其後 exact single-use override 在沒有獨立 full-reopen condition 時換恰一次 manifest-bound `route=bounded`／`handback_authorized_bounded` 並 count+1。只有 Git/risk/trust/new-Critical 等既有 mandatory-full condition 成立時，handback override 才可得 `route=full`／`handback_authorized_full`。可收斂路徑正常下一步是同 thread focused recovery，不是 unlock；blocking=0＋其餘 gate → `final_ready` 無 override。具名 **窄 handback→bounded→final** 僅例外路徑。`change_base_sha`／receipt `base_sha` 對齊 merge-base(resolvedMain, HEAD)，不是 moving main tip（rebase 選用）。有 predecessor receipt 時 `surface_base_sha` MUST === predecessor `lineage.head_sha`（seal-manifest 產端拒；`resolvePredecessorReceiptForSurfaceEquality`）。open finding `disposition` MUST null（capture 前移）；`reviewer_identity.executor_kind` 必滿，TL MUST NOT 手補。Any receipt in-scope／unlabeled Critical=`fix-now`|`non-issue-with-evidence`；兩者共同綁 current receipt HEAD+stable finding ID+current observation hash+carrier+anchor+unique evidence；in-scope／unlabeled Important=`fix-now`|`non-issue-with-evidence`（disposition-only；bound-HEAD carrier proof 仍僅 Critical）；tracked/defer **不得**關閉 in-scope／unlabeled Critical／Important（範圍外見 R11）。新 finding 只有可追到 repair delta／dependency closure 或具 direct proof 的 Critical 才進本 change，其他 Important/Suggestion disposition+follow-up，不擴張當輪 scope。Transition=>`direct|archive_transition`/no second full；else full reopen。savings/consumer causal effect unknown。Consequence：`change-consequence-assessment.md`。

**等同 forward re-anchor**：舊 base 是新 base 的 ancestor、兩輪 `behavior-risk-v1` digest 相同，且完整 tracked Git tree 除既有 Path D′ whitelist 內非 executable 的 regular `.md` bookkeeping（`openspec/changes/`、`notes/`，排除任何 `specs` segment）外，所有 path／mode／object 相同，才可保留 bounded。未知或任何 code／rule／spec／test／config／submodule 變更仍 full；`range-diff` 只作人工輔證。兩張本輪 sealed manifest 的 `change_base_sha` 綁新 merge-base、`surface_base_sha` 仍精確綁 predecessor HEAD（此證明才容許非 ancestor）；classifier／seal／historical verify 共用物件證明，count 正常 +1、finding 結轉與其他 full 條件照舊。仍須 current HEAD 的 reviewer 複審；不授權 rebase／force-push、不豁免 post-PR sticky freshness。舊 HEAD／base 物件缺失（prune 或 fresh clone 未含）時，先恢復 exact recorded Git objects 再驗證；不可用 range-diff 推測等同。

**Successor `findings[]` 組成與必帶集合（SSOT；dispatch 範本、`dp-reviewer.md`、pre-PR skill 只引用不重定義）**：`lineage.previous_receipt_ref` 非 null 才適用（round 1 與 `missing_predecessor_seal` bootstrap 跳過），不分 `review_mode` 與授權原因。
- 必帶：successor 的 `findings[]` MUST 含 predecessor 的必帶集合與本輪新 finding。必帶集合＝predecessor `scope.open_finding_ids` 全部＋predecessor 每筆 `state: closed`、`severity: Critical` 的 finding；closed Critical 只有兩個例外：以 TL scope ruling 關閉者（`scope-unresolved`＋`tracked-follow-up`，關閉由該收據的 chain walk 保存）MAY 省略，closed historical post-hoc authority 的 successor 不檢查 closed Critical 部分；open 部分無例外。
- 可省：更早已 closed 的其他 finding MAY 省略（chain walk 在其出現的收據逐張重驗，`classify-bounded` 路由不變）。
- 可重帶：被省略者 MAY 重帶，檢查只要求包含、不拒絕超集合；照帶的 closed Critical 須在本輪 HEAD 通過 carrier／anchor／evidence 綁定；scope ruling 關閉的 Critical 預設省略，重帶須由 TL 在該輪 bound HEAD 補一筆綁本輪 `round_number` 的新裁示，否則 capture 經 `closedBlockingDispositionProblem` 回 `raw-payload-invalid`。
- 重帶舊 ID 要 reopen 就寫 `state: open`、`disposition: null`；reopen 的 blocking finding 不算 stall progress。
- full 輪也不豁免：full 輪 MUST 沿用 predecessor 必帶集合的 `finding_id`（已修記 closed＋`fix-now`／`non-issue-with-evidence`，未修維持 open，新發現的不同問題才發新 ID）；MUST NOT 對同一件事另發新 ID 取代舊 ID。
- observation：帶入的 finding MUST 帶完整 observation，不截短、不摘要、不以 `finding_id`／hash 取代；主體沒變預設逐字沿用，只改兩類欄位：(a) 關閉契約要求者（closed Critical 的 `evidence` 改裸 path、`anchor` 改修復後仍存在於 `carrier` 的 literal），(b) 同一主體在本輪 HEAD 位置已移動時的 `carrier`／`anchor`／`evidence`；closed finding 的 `severity` 保留原值；`scope-unresolved` 轉 closed 那輪 observation 全部欄位 MUST 與上一張收據逐字相同（TL 裁示綁 observation hash）；主體換了就是另一個 finding：原 ID 照帶另立處置，新主體發新 ID。無跨輪 observation／hash 相等的機械檢查。
- 漏帶：producer 端 capture（發布前，零發布）、build、seal fail closed，回 `predecessor-finding-omitted`（`reviewer-payload-check`）；reviewer 補齊後重產 payload，TL MUST NOT 手補或改寫；`verify-receipt` 與已封存的鏈不回溯。

`bounded_rereview_count > 3` 的 receipt：seal 與 chain walk MUST 驗證本輪要麼有已消耗的 exact-once `review-dispatch` override claim（真 `handback_authorized_*`），要麼 chain walk 證明 classify 簽發的 `convergence_recovery`；偽造／改標仍 fail closed。

### 小修與 bounded 複審範圍

**Suggestion-only 複審範圍**：in-scope、trivial-fixable Suggestion MUST 依既有 `fix-now` 在同一 change／PR 直接修；MUST NOT 僅因它是 Suggestion 而要求另開 change 或改成預設 follow-up。非 trivial／擴 scope 的處置仍依 Finding Disposition Discipline。

**複審材料起點**：`route=bounded` 的 TL MUST 用 sealed repair-delta 的 `surface_base_sha`（predecessor receipt HEAD）到 `candidate_head_sha` 之 fresh diff hunks、必要上下文與 sealed dependency closure 準備材料；MUST NOT 以整份 Touch／整個 PR diff／changed file 的未改動區塊取代此次修正範圍。Manifest 的完整檔案雜湊與完整性檢查不變；縮小的是人工閱讀與判斷面，不是機械驗證面。Reviewer 可讀修正 hunks 的必要上下文；額外 caller／callee／對應 spec 和 test MUST 已列在 sealed dependency closure，不能只靠「可追溯到 delta」擴大未封存 surface，不因同檔其他區塊可見而重掃已審內容；represented axes 隨修正而定，不補未涉及的六軸。

**範圍升級**：修復後 TL 先跑 `classify-bounded`，MUST 傳入 current sealed manifests 並依結果派工；既有 mandatory-full condition 優先，不因 Suggestion 而豁免，MUST NOT 手改結果為 bounded。`open_finding_ids` 空陣列合法，不能為取得窄審而偽造 open finding；修過的 closed Suggestion 可作對照材料，receipt predecessor 必帶集合仍依既有契約。發現 out-of-manifest／new Critical 時先記 finding 與 observation 交 classifier，不在 reviewer 端擴寫 manifest 或自行全面重審。

### Bounded Rereview Manifest Production

`route=bounded` 的 `repair_delta_manifest_ref`／`dependency_closure_manifest_ref` 是 TL 產出、`seal-manifest` 封存的 durable ref；schema 固定 `devpro.review-remediation.manifest/v1`（`purpose` 的 exact enum 是 `repair-delta | dependency-closure | content-comparison`；`content-comparison` 同 schema，只換 `purpose`）。下列欄位與 digest 逐欄對 core `validateManifestRecord`／`sealReviewManifest`；`node .devpro/scripts/review-remediation-evidence.mjs --help` 為輔助入口。

- `validator`：`{id,version,source_path,source_digest_sha256,provenance,independent_evidence}`——`source_digest_sha256`＝`source_path` 於 `candidate_head_sha` 的 tree bytes sha256；`validator.provenance` 的 exact enum 是 `pre-existing-trusted | independently-verified-same-change`（`pre-existing-trusted` 要求 validator source 在 `change_base_sha`…`candidate_head_sha` 間未變且 `independent_evidence` 為 `null`；`independently-verified-same-change` MUST 帶 structured `independent_evidence`）。欄位皆自陳式（值由作者具名），判定以 core 為準。
- `normalization`：`{id,version,rules_digest_sha256}`（自陳式）。
- `lineage`：`{change_base_sha,surface_base_sha,candidate_head_sha}`——`change_base_sha`＝`merge-base(resolvedMain, HEAD)`（不是 moving main tip）。有 predecessor receipt 時 `surface_base_sha` 的等值要求**不在此重述**：規範 SSOT 為 `pre-pr/SKILL.md` §manifest lineage（`seal-manifest` 產端拒）。
- `hash` 的 exact 值：`algorithm`＝`sha256`、`canonicalization`＝`canonical-json-v1`。
- `inputs`：`{count,root_digest_sha256,entries[]}`；entry＝`{id,path,digest_sha256}`——`digest_sha256`＝該檔於 `candidate_head_sha` 的 tree bytes sha256；`root_digest_sha256`＝`sha256Hex(canonicalJsonV1(entries))`；`count`＝entries 長度。
- `coverage`：`{expected_count,processed_count,complete,unknown_inputs[],omitted_inputs[]}`。
- `dependency_edges`：`[{from,to,kind}]`——端點 MUST 為 entry id；`dependency_edges[].kind` 的 exact enum 是 `import | reference | generated-from | registry | symlink | test-maps-to`。
- `exceptions`：`[{id,detail}]`；`errors`：string[]；`result` 的 exact enum 是 `pass | exceptions | partial | error`（`pass` 需 coverage 完整、無 exceptions／errors）。
- 三層 digest 各司其職：entry 級＝該檔 `candidate_head_sha` tree bytes sha256；`inputs.root_digest_sha256`＝`sha256Hex(canonicalJsonV1(entries))`；`manifest_digest_sha256` 由 seal 推導（`sha256Hex(canonicalJsonV1(record without digest))`），產端 MUST NOT 自帶。
- 封存：`node .devpro/scripts/review-remediation-evidence.mjs seal-manifest --request <json>`——request `{repoRoot,changeId,roundNumber,manifest,previousReceiptRef?}`；輸出 ref `{path,digest_sha256}`。`path` MUST 恰為 `review-<change>-manifest-<purpose>-r<N>.json`（notes root 相對、**不帶** `notes/` 前綴；`classify-bounded` 以 `refOwnedByChange` 對此 `manifestFileName` 逐字比對，加 `notes/` 前綴即在讀檔前以 `manifest ref has cross-change or stale ownership` fail closed）；carrier 落點 `<main-checkout-root>/notes/review-<change>-manifest-<purpose>-r<N>.json`（`file-write-destinations.md`）。`seal-manifest` 另要求整個工作區已 commit（忽略檔除外）否則拒封，此為專屬前置條件；`current` 驗證仍只看相關 paths：`candidate_head_sha` MUST 等於現 HEAD、相關 paths 乾淨（dirty／untracked 即拒）。
- 驗證：`node .devpro/scripts/review-remediation-evidence.mjs verify-manifest --request <json>`——request `{repoRoot,manifestRef,verificationMode}`（`verificationMode` **必填**；`historical`（core 預設語意）／`current`）。
- 本段只文件化既有判定——MUST NOT 被讀成放寬或收窄任何 gate／fail-closed 判準；歧義以 core `validateManifestRecord`／`sealReviewManifest` 與 `--help` 為準。

### Six-Axis Review Report Persistence

`<main-checkout-root>/notes/review-<change>-r<N>.md`是mutable raw，不是immutable receipt；路徑見`file-write-destinations.md`。TL收JSON後MUST 第一個動作落盤原文；缺檔MUST NOT 假裝 bounded rereview、MUST NOT 由摘要重建。
回覆後ID MAY作raw-only optional `transport_invocation_id`；不得猜或進helper/auth/provenance/authority。receipt_payload bind三欄→helper seal ReviewRoundReceipt。

### Finding Disposition Discipline（含 Suggestion）

每條 finding（**含 Suggestion**）MUST 標 exactly one closed disposition token：

| Token | 中文語意 |
|---|---|
| `fix-now` | 當場修（預設：in-scope、低成本、無 scope creep → 同一 PR 修） |
| `tracked-follow-up` | 開 issue／有 owner 的 follow-up（擴 scope／需獨立設計 → 建有編號+owner issue，PR body 引裸 `#N`） |
| `defer-with-owner-trigger` | deferred+理由（須 owner+trigger；禁 trivial-fixable） |
| `non-issue-with-evidence` | 確認非問題並記證據 |

**PASS Suggestion／`tracked_follow_up` durable carrier**：canonical 落點為 gitignored `<main-checkout-root>/notes/review-<change>-r<N>.md`（`.gitignore` 的 `notes/`，**不在** reviewed git tree）。標 `non-issue-with-evidence` 時 MUST 寫入該檔；MUST NOT `git add notes/`；tracked tree 保持 clean 且 exact-HEAD 不變。`fix-now`（含 freeze 攔下的真 QA 漂移）才可 commit reviewed tree。

**MUST NOT silent drop**：禁止把 in-scope 低成本 finding 寫進 PR body 散文「待 follow-up」不開 issue/不指 owner（孤兒項，見 `rules-consistency-checklist.md` §6.5）。「不阻擋 merge」≠「可以不修」。

> **Defer 前置濾網（trivial-fixable → 禁 defer）**：標 `defer-with-owner-trigger` 前先判此 finding 是否**當下可了結**。若 **trivial-fixable**（改掉只需數行、無 scope creep）或當下即可判為 **non-issue**（reviewer 自己已確認非問題 / 措辭準確 / 來源一致）→ **MUST 當場了結**（`fix-now`，或 `non-issue-with-evidence`），**禁 defer**。`defer-with-owner-trigger` 僅留給「需獨立設計／跨 change scope／有實質成本／缺具名輸入」之 finding；**reviewer 標的 defer 不是不動手的授權**——附理由 ≠ 可 defer 舉手之勞。**停損 nuance**：「當場了結」≠「無限雕琢」——對 **0-current-trigger 的 latent 邊界**，若反覆 over/under-correct 到第 N 輪（N≥3）仍在打磨，改記 `tracked-follow-up` + 停損（判準：(a) 現有 case 觸發嗎？(b) 修法 validated 嗎？(c) 修退化還是加新防護？——三者決定當場修 vs 停損）。同 paradigm：`ai-autonomy.md` Ask First 前置濾網、`rule-design-principles.md` Disposition 檢查；共根 **「決策當下了結，禁以省事為由外推或後推」**。

**Bounded rereview 新 finding 處置**：本輪新 finding 追得到 repair delta／dependency closure 且 `requirement_scope: in-scope` 時，Critical／Important 照既有 open＋null；trivial-fixable Suggestion MUST 標 closed＋`fix-now`（TL 同 PR 修）或 `non-issue-with-evidence`，MUST NOT 以 `tracked-follow-up` 或 `defer-with-owner-trigger` 關閉（唯一例外：上方停損 nuance，須附 issue `#N`）。追不到／非 in-scope 依上方 R11、新 finding 規則與本表。TL bounded prompt MUST NOT 另給衝突處置。

## Exit Criteria

- 六軸逐一完成（條件式軸說明為何不適用）
- Critical 件數為 0（範圍外已關閉者見 R11）
- in-scope／未標的 Important 件數為 0（禁以 `tracked-follow-up`／`defer-with-owner-trigger` 關閉 Important／Critical 後宣稱可 seal／approve）
- 每條 finding（含 Suggestion）已依 Finding Disposition Discipline 標四詞閉集之一（無 PR-body 孤兒 follow-up／silent drop）
- 審查摘要已輸出

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「這次改動很小，不需要跑全部測試」 | 改動小不代表影響小；「應該不會有問題」不是驗證。跑一次只要幾秒。 |
| 「安全軸這次不適用，沒有 SQL」 | 沒有 SQL 的 PR 仍可能有 PII 洩漏；每一軸都必須明確勾選或說明排除理由。 |
| 「decisions.md 不存在，所以設計說明不重要」 | decisions.md 不存在不視為缺陷，但 diff 中無法解釋的設計選擇仍須標為 Important。 |
| 「Suggestion 不阻擋，記 PR body 之後再處理」 | 「不阻擋 merge」≠「可以不修」；in-scope 低成本 Suggestion 預設 `fix-now`，延後須 `tracked-follow-up`（有 owner 的 issue）。 |
| 「rereview 已三輪，Critical 可先 merge」 | Critical=0 才 merge-ready；safety reopen 優先於 ≤3 cap；禁 silent drop。 |

## Verification

```
# 測試全綠
# （依專案執行對應指令，見 testing-and-qa.md「專案約定測試指令」）

# 工作目錄乾淨
git status

# qa-test-scope.md 存在
ls openspec/changes/<change-name>/qa-test-scope.md

# SQL script 存在（若涉及 DB 變更）
ls sql/<change-name>/
```

## Cross-Model 第二意見
> Load-chain（Cross-Model 第二意見）：gate（devpro:pre-pr Step 5.5、devpro:cross-review、merge gate）及 reviewer-produced findings／review packet／sticky write-back 契約的完整 SSOT 見 `code-review-cross-model.md`；rationale 冷檔見 `code-review-cross-model-rationale.md`；外部 reviewer CLI 呼叫前的 1→7 有序協定與 timeout policy 見 `code-review-cross-model-cli-contract.md`；具名錯誤碼或 fault-recovery 時的派審機制契約見 `code-review-cross-model-dispatch-mechanics.md`；不 spawn runner 時的 External Evaluator 審查單＋收據見 `second-review-external-evaluator.md`。

**ui smoke（MUST pointer）**：user-visible UI 觸發時，sticky／`/devpro:cross-review`／Step 5.5 前缺合法 `ui smoke:`＋`ui smoke head:`，或 head currency 不符合 `testing-and-qa.md` §UI smoke → FAIL CLOSED（詳 `code-review-cross-model.md` §UI smoke prerequisite）。不得把 sticky 進度當完成。

Review/merge-gate 檢查時必須同時確認 `checkCrossModelMergeGate`、sticky comment + `last_reviewed_sha` freshness，以及 gate success 後的 next-step handoff。Reviewer CLI 無額度（所有仍可用 reviewer family 都 auth 成功、但 invocation 因額度失敗）時的合法階梯見 `code-review-cross-model.md` §失效 Fallback 的 `quota-unavailable`：同家族 fallback sticky（Path F）、或 `UNAVAILABLE` sticky＋Path U／Path W；`DEVPRO_HOOK_BYPASS=1` 不是 sanctioned 解除路徑。`PASS/WARN`、`PASS|WARN`、skip/exempt 只是 gate progress，不是 terminal response；最終回報必須接 `post-pr-completion-gate.md` Ready Response Next-Step Contract，列出 `CurrentIntent`、`NextAction`、`AskFirstPending`、owner、next action、success condition。若 next action 是 user-owned merge authorization 或其他 Ask First，必須用 stop-point numbered options；若 owner=TL 且 batch approval / existing authorization 已覆蓋，TL 必須繼續 `NextAction`，不得停在 verdict/skipped/exempt。
