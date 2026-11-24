---
name: second-review-control-evidence
description: "Second-review dispatch、orchestration fault、durable capsule 與 post-PR consumption SSOT。"
---

# Second-Review Control Evidence

## Overview

SSOT：reviewer 內容不是 control evidence；dispatch、terminal completion、fault 與 gate consumption 只認 bounded structured evidence。

## When to Use

- render/run second review，或 gate 處理 denial、retry、sticky、receipt、cleanup

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | renderer/validator/runner、post-PR gate、control-evidence helper 的 reservation／retirement fence／owner cleanup 與 semantic tests |
| Advisory | cross-review rule/skills、active adapter |
| Doctrine | N/A |

### Win32 v5 paged sticky support matrix (P1–P3)

On `win32`, private-carrier confidentiality for renderer-paged sticky is the named trusted-principal alternative — **not** POSIX mode bits and **not** `icacls`/SID probes:

| Gate | Meaning |
|---|---|
| P1 | Same-host principal (renderer/process owner) |
| P2 | Carrier under trusted parent / `carrier_root_id` location (`notes/cross-review`); render fail-fast when outside or parent missing |
| P3 | Outside reviewer-writable roots (recipe containment guards) |

Validate-time mode/uid skip alone is **not** the complete win32 story; render publish MUST apply P1–P3 (incl. `ensureDurableDirectory({ trustedParent })`). On non-`win32`, exact `0700`/`0600` (+ uid when available) remains enforced at trusted authorization (`permission_invalid`).

### 1. Dispatch identity

1. `pr-sticky` nonpaged/paged只接受`devpro-second-review-data/v4`/`devpro-second-review-data/v5`；`audit-only`維持`devpro-second-review-data/v3`。`reviewer_family`只接受byte-exact `claude`、`codex`、`openai-codex`，外加 material contract `REVIEWER_FAMILY_GROUPS` 所列 external-only family（見§3.1）；invalid=`reviewer_family_invalid`且在effect前停止。
2. Mode-bound frame在 `attempt` 後依序放 required `dispatch_id`、`previous_dispatch_id`、`primary_family`。ID為 trimmed non-empty ASCII、≤128 bytes；初次 predecessor=`null`，retry/rerender指向不同於 current 的 direct predecessor；resolved control-evidence root 下已無 reservation 的 predecessor 視同不存在，reserve 回 `predecessor_reservation_missing`。只有無 pending marker／ancestor obligation 的全新 lineage 確認 root 與 predecessor 真正缺失後才可省略 `previous_dispatch_id` 開新 lineage；既有 successor 的 ancestor 缺口不得以刪除欄位修補。Completion仍恰為既有五欄。

`full-pr`=`full-pr-bounded-live-reads-v1`/`gh-pr-bounded-live-v1`；`commit-range`=`commit-range-exact-compare-v1`/`gh-api-exact-compare-v1`；embedded=`scope-bound-embedded-complete-diff-v1`/`embedded-complete-diff-v1`；`gh api 'repos/{owner}/{repo}/compare/<base>...<head>'`。V5：renderer-root+immutable endpoints→`A`/byte-exact raw Git diff（`SECOND_REVIEW_GIT_RAW_DIFF_FLAGS`）；publication/authorization/effect前須`A = D = M`且caller=raw。cwd/env/caller/live≠authority。Failures=`review_material_scope_unresolvable`/`review_material_full_closure_invalid`/`spawn_or_probe_failure`。Typed `permission_denials`維持fatal precedence。Recovery=fresh dispatch/packet/proof/recipe/probe。
3. Reservation/carrier前durably建立`devpro-second-review-publication-transaction/v3`，綁identity、reservation及v3/v4 7個或v5 8個carrier。V5第八role=`devpro-second-review-paged-full-pages/v2`，綁root/identity/time/+7200s/pages/digest；public context無path。Ledger只擁有exclusive-created bytes；rollback只刪matching owned path。Publication no-replace/durable；spawn前驗證並claim。

Trusted v5：Structural parser不授權。File-backed entry在ack/activity/heartbeat/lock/probe/claim/spawn/disclosure前，以sibling context、same-FD bounded read、persisted reservation，single-read出seal。Identity錯誤=`reviewer_dispatch_identity_collision`且無reason；其後carrier錯誤=`review_material_full_carrier_binding_invalid`及一reason：`missing`、`malformed_or_noncanonical`、`root_or_basename_substitution`、`identity_mismatch`、`permission_invalid`、`lifetime_invalid`、`page_or_digest_mismatch`。只准fresh rerender。每window從seal組active-window stdin，不重讀、no-live-fallback。V4仍standalone structural、7-carrier且byte/behavior相容。
4. Packet、sidecar、terminal、sticky、capsule、receipt、marker一致綁 repo/PR/head/attempt/current dispatch。New-format sticky 的 authority set 恰為一個 canonical marker、一個 `verdict:`、一個 `last_reviewed_sha:`、一個 `dispatch_id:`、一個 `reason:` 與一個 final provenance footer（Rules/tool/model）；每欄都必須 exact-once，重複值即使逐字相同也 fail closed。Runner、post-PR gate與merge gate必須共用同一 exact-once parser/contract，不得各自接受 first-match。Legacy只在無 new-format record時可用。Marker以 `expected_dispatch_id` CAS；stale/competing update fail closed。Initial bind、same-head replacement與cross-head advance每次取得marker ownership後，都必須在同一critical section、建立reservation前向GitHub驗證authoritative `headRefOid`為格式正確且exact等於requested head；unavailable、auth失敗、malformed或mismatch時不得建立reservation或發布marker。
   Same-head marker-bound render（head未變、走expected-dispatch CAS；marker已綁或尚未綁定dispatch皆適用）在建立publication transaction、contender或任何reservation之前，必須先用與該CAS**完全同一個** identity predicate前濾這次binding plan；不得在renderer內另行複述CAS條件而讓兩份判斷漂移。Cross-head advance不受本句拘束——它的expectation取自marker自身欄位並另由§1.6.1-1.6.4的closed／operator-disposed predecessor與authoritative-head驗證涵蓋。Handoff未帶`previous_dispatch_id`、且marker的`expected_dispatch_id`所指dispatch恰有§1.6.1認可的closed／operator-disposed predecessor evidence時，才可adopt該ID為本次predecessor；帶了但與marker不符一律fail closed。Adopt必須排在前濾之前——前濾在前會拿空predecessor比對必敗，adopt形同不存在。前濾只是把注定失敗的render提早擋在零殘留位置，不取代同一critical section內的in-lock CAS與authoritative head驗證。
   `pr-sticky` sidecar須有versioned trusted `sticky_write_disposition`。Renderer以完整exact-repo/PR snapshot解析：0=`create`；1=`update`且綁REST ID、canonical URL、node ID（若有）、body SHA-256、`updated_at`；>1或無法證明完整/正確=`blocked`。Binding含repo、PR、dispatch、candidate count、snapshot digest；`audit-only`=N/A。Runner在claim/probe/spawn前重驗；missing/tampered/stale/blocked只留`process_spawned=false` evidence並要求新dispatch，不得claim、probe、spawn或write。
   Reviewer只執行revalidated action/target；不得搜尋、替換ID或fallback，`previous_sticky`僅為inert context。Post-write仍須exact-once/head/dispatch/provenance；update completion/read-back須同一ID/URL，create須證明唯一authority；drift=blocked且不補償write。
5. CAS lock使用每次 acquisition 唯一、不可重用的 contender path，並記錄可驗證的 owner token、process identity與建立時間：
   1. 建立前先掃描 contenders；fresh或owner仍存活者一律造成 conflict。
   2. 只有超過 bounded stale threshold且owner可被明確證實已死亡的**該唯一 contender**可被回收；malformed、identity ambiguous或無法完成liveness判定時先fail closed，只能由同一bounded repair protocol在取得另一個unique repair owner、重新驗證沒有live owner並保留quarantine evidence後處理，不得把「看不懂」推定為dead。
   3. 建立自己的 contender後必須再次掃描；若出現其他有效 contender，release自己並回報 conflict。
   4. Release只可解除相同 owner token 的唯一 path；禁止檢查舊 shared pathname後再 unlink該可替換 pathname。Normal release、stale recovery unlink與marker-clear unlink完成後都必須fsync各自parent directory；只在create時fsync不構成durable removal。
   5. 沒有 transaction的 crash遺留 contender不得永久封鎖 marker，但 stale cleanup也不得刪除另一個 fresh/live contender。有 transaction的 contender必須依下方 recovery契約完成確切判定後才可移除；generic cleanup不得直接回收。
6. PR head在 fault後前進時，renderer須依序完成下列轉接；不得跳步或把條件壓成推論式 shorthand：
   1. Renderer exact驗 marker的repo/PR/舊head/舊dispatch，且舊dispatch恰有一種可接續evidence：`second-review-operator-recovery.md` Interrupted runner契約的operator disposition（不宣稱closed），或下列closed predecessor：gate-owned fault consumption、runner-owned success completion（current `devpro-second-review-completion/v2`或immutable legacy `v1`），closed-terminal（runner-owned，或僅由PR #2927兩支一次性recovery script寫下的immutable operator slot／lifecycle slot衍生的pre-spawn recovery terminal `operator_abandoned_pre_spawn`／`stale_reservation_closed_pre_spawn`；後兩者免invocation claim），或external-evaluator closure（§3.1：slot `accepted`＋第四形completion、或slot `voided`＋void terminal；免claim、`process_close_observed=false`）。Runner completion須exact綁identity/integrity、固定outcome/classification、`PASS|WARN` sticky SHA/dispatch及`process_close_observed=true`；v2另綁positive REST ID與同repo/PR/ID canonical URL。Legacy v1只按原field set唯讀；不得新寫、升級或改寫。Closed-terminal須符合§2/§3。Claim單獨不得成為predecessor；renderer不得建立/修補terminal evidence。Missing、corrupt、mismatch、duplicate或互斥evidence並存皆fail closed。
   2. Renderer以 local Git `merge-base --is-ancestor <old> <new>`驗證舊 head確為新 head祖先。Verified fast-forward走既有路徑；non-fast-forward、backward、missing object或不確定 ancestry不得由此路徑放行。僅 exact per-lineage approval 可授權符合本 change contract 的 active marker／clear-obligation recovery；local ancestry只是必要條件，不等於 remote PR current head，approval 也不授權 Git graph rewrite。Approval 留言超過 `LINEAGE_APPROVAL_MAX_AGE_MS`（30 天）即不再是候選、也不計入重複；消費它的 dispatch 只保留到該期限，之後才可由一般 cleanup 回收，所以 consumed 帳本有界，且被消費的 ID 不會因回收而重新可用。
   3. Renderer須先依§1.3 durably建立common publication transaction，再為這次marker更新建立唯一contender，並在contender record內保存完全相同的`devpro-second-review-publication-transaction/v3`。Transaction須額外綁exact old repo/PR/head/dispatch marker state與new head/dispatch binding；transaction file、contender file及各自directory都必須在reservation或carrier publication前durable fsync。未完成durability不得建立reservation或寫任一carrier。
   4. 取得 contender ownership後，renderer必須重新讀 marker並確認 exact old binding仍成立。接著在同一 marker critical section內向 GitHub查詢 PR的 authoritative `headRefOid`，且結果必須是格式正確並 exact等於 requested new head。查詢 unavailable、auth失敗、格式錯誤、結果不一致或 marker已改變時全部 fail closed；只驗 local A→B ancestry不得在 remote current head其實是C時發布B。
   5. 上述條件全部成立後，renderer才可在同一critical section建立transaction內那一筆exact successor reservation。新dispatch的`previous_dispatch_id`必須直接指向marker的舊dispatch，即使head與attempt已改變。整條PR-wide lineage的repo/PR必須相同；新 reservation 的 `attempt_id` 必須不同於 direct predecessor；cross-head edge的predecessor必須是上述已關閉的terminal fault、trusted terminal completion，或獨立operator disposition（不宣稱process closed）。Helper 在 capacity lock 內要求唯一 canonical marker 的 exact repo/PR/old head/old dispatch 與 unchanged bytes 見證；任意 caller path、無 marker、過時或 mismatch 見證不得建立新 cross-head edge。鎖序維持 marker → capacity；same-head、historical reads 與 exact-byte idempotent reservation 不要求已被 CAS 推進的舊 marker 仍存在。
   6. Reservation成功後，renderer必須依transaction manifest以no-replace atomic publication寫完該schema的完整inventory（v3/v4為7個carrier；v5另含conditional `paged-full-material`共8個），並完成file與directory durability。全部carrier成功前marker必須維持exact old binding；只有全部成功後，才可用durable atomic replace把marker CAS到new head/dispatch binding。任何stale、competing或不一致狀態都不得blind overwrite。
   7. 一般錯誤、CAS失敗或owner死亡後的stale recovery都使用同一exact transaction判定。Marker已exact為new state時，須驗證matching reservation、packet與observability context仍符合manifest的exact bytes/hash，且其餘5個可由runner追加的carrier仍是regular files；全部可驗才視為committed並保留。Marker仍exact為old state，或standalone transaction尚未commit時，須先只刪除仍符合manifest exact path/bytes/hash的carrier，再於capacity/invocation-claim互斥下回收同transaction exact建立、尚未claim、沒有terminal/receipt/additional evidence且仍為matching `dispatch.json`的reservation。任何carrier或reservation已被改變都不得猜測清除。
   8. Recovery只在transaction或contender超過bounded stale threshold且owner已死亡時自動執行；successful committed verification、或exact cleanup與rollback完成後，才可移除transaction/contender。Marker既非committed也非uncommitted、或marker檔已不存在（第三狀態）時**預設**必須保留transaction並fail closed；唯一例外是呼叫端已獨立證成的orphan recovery authority，且授權來源恰為兩種：stale recovery已確認owner死亡並越過bounded stale threshold，或inline cleanup以exclusive create建立該envelope、持有其exact bytes且在unlink前重驗。授權必須由呼叫端傳入且以**列舉值**驗證（「有傳東西」不構成授權），不得在recovery內部由磁碟狀態反推——否則第三狀態本身就成了繞過CAS的後門。授權成立仍須在capacity/invocation-claim互斥下確認reservation directory不存在且manifest carrier一個都不剩，才可移除transaction；任一項殘留即還原第三狀態的fail closed，不猜測清除。transaction/root/identity/manifest/reservation無法exact驗證，或committed publication不完整時，一律fail closed。Standalone/audit-only也必須走相同transaction；不得用「沒有marker」略過crash-safe publication。Gate、generic cleanup及沒有transaction-aware recovery callback的writer都不得猜測或移除這類record。

### 2. Terminal classification

- Wrapper hard faults precedence不變；其後 confirmed current denial → `reviewer_orchestration_permission_denied`，ambiguous/partial/truncated/unmatched/unknown shape → `reviewer_orchestration_unknown`。此precedence只決定runner terminal classification與capsule保存，不得偽造／覆寫sticky或獨立決定consumer authority。Post-PR exactly-one canonical current-head marker-matching `PASS` 仍依 `post-pr-completion-gate.md` 先行；`WARN`與其他fresh sticky不得覆蓋current fault。
- Capsule closed allowlist**恰為**上述兩類；其他及未來 class default-out。擴張須同改 allowlist、canonical requirement、fixtures。
- 先讀可信 provider typed control event；禁掃 reviewer content或 completion文字。Text registry預設空；entry須有 provider/version-scoped去敏 evidence與同一 exact complete-line shape正反 fixtures。禁 substring/fuzzy/partial match。
- Result帶 bounded/redacted provenance、confidence、matcher ID、denied action/tool class。Raw line/args、secret、absolute path、review prose不得進 result/capsule/observability/sticky/output。Raw sidecar retention不變；classifier每 stream只讀≤64 KiB complete-line tail。
- Runner-owned closed-terminal receipt只接受下列versioned outcome group：`reviewer_blocking_verdict`（`CRITICAL`／`UNAVAILABLE`）、`provider_blocked`（rate-limit／authentication）、`confirmed_timeout`、`spawn_or_probe_failure`、`tool_surface_fault`、`output_safety_overflow`、`terminal_contract_or_cli_failure`；兩個互斥的操作者 recovery class 各自只能由其 immutable slot 衍生：`operator_abandoned_pre_spawn`（`abandon-pr-2927-unstarted-second-review.mjs` 的 operator slot）與 `stale_reservation_closed_pre_spawn`（`close-stale-second-review-reservation.mjs` 的 lifecycle slot）。每組只容許 canonical helper 的 stable classification；新增 group/classification必須同改 allowlist、canonical requirement與positive/negative fixtures。此receipt表達「該dispatch已可靠關閉但不構成review成功」，不把failure改寫成PASS/WARN。
- `stale_reservation_closure` / `stale_reservation_closed_pre_spawn` 只由 `close-stale-second-review-reservation.mjs` 寫下的 immutable `dispatch-lifecycle-slot.json` 衍生，`operator_abandonment` / `operator_abandoned_pre_spawn` 只由 `abandon-pr-2927-unstarted-second-review.mjs` 寫下的 operator slot 衍生；兩者都不得由 generic terminal writer 建立。兩條路徑是不同 schema、不同 challenge、不同 eligibility contract，舊 exact-head contract 不變。
- `tool_discovery_blocked`恰屬`spawn_or_probe_failure`。Runner先sanitize後於acknowledgement與dispatch identity-collision check後、sticky/scope/help/auth/reviewer工作前，只檢查logical reviewer tool的PATH first executable hit並realpath；missing、realpath失敗或bounded identifiable cmux path shape（`cmux-cli-shims` segment、cmux wrapper/app-resource identity）固定發布`process_spawned=false`、`lifecycle_phase=pre_spawn_known_terminal`、`process_close_observed=false`、`transport_cleanup_confirmed=true`、`invocation_claim_sha256=null`，不得留claim、搜尋later PATH hit、啟動受影響process或持久化resolved path。任意script與ambient env marker單獨不構成cmux proof；Win32必須用platform path/delimiter與PATHEXT順序，只接受bounded pure extension token，忽略extensionless與含separator/traversal的malformed token，只把`.COM`/`.EXE`視為direct，first existing `.BAT`/`.CMD`/其他shell-dependent candidate即exact block且不得fallback或`shell: true`。Trusted direct hit只在記憶體綁同一absolute realpath給help/auth/reviewer spawn，canonical argv與logical tool telemetry不變；path-bearing probe error/throw只保留stable generic/code且不得進result/capsule/observability/stdout/stderr/terminal receipt/returned result。
- Pre-spawn lifecycle已能確定terminal（例如spawn/probe在child建立前失敗）時，runner可發布closed-terminal receipt並固定`process_spawned=false`、`lifecycle_phase=pre_spawn_known_terminal`、`invocation_claim_sha256=null`。一旦child可能已建立，只能在process `close`已觀察且transport、descriptor與process/group cleanup都確認完成後發布，並exact綁matching invocation claim；`lifecycle_phase`恰為兩個post-close值之一——同一runner行程inline確認cleanup為`post_close_transport_cleaned`，runner已退出後才由runner-owned post-hoc對帳確認為`post_close_transport_reconciled`。兩者欄位集、schema、responsibility、exclusivity與claim binding完全相同；phase只揭露cleanup何時被確認，不得讀成較弱的record或另一種receipt class。只收到`exit`、已送termination、leader close但descendant不確定、transport仍開啟或cleanup結果不明時，均不得發布；termination-unconfirmed必須維持blocked且不是cross-head predecessor。
- `host_session_limit_stop`：dispatch/reviewer CLI回報session-limit或usage-limit已達上限時，MUST即刻停止並上報使用者；不得等 reset 後自動續跑，不得原樣重試。

### 2.1 Legacy diagnostic dispatch closure（operator-only）

**操作者關閉入口（僅 operator）**：入口指令、驗證條件與唯一成功輸出在 `second-review-operator-recovery.md` §2.1；只在退役前的診斷 attempt 缺 terminal receipt、需要操作者關閉時讀，一般審查不讀。

### Credential publication denial 的失敗終態恢復

Runner 的 `sticky_credential_literal_blocked` / `sticky_credential_literal_detected` 只在 receipt 層映射為既有 `sticky_contract_invalid`（`terminal_contract_or_cli_failure`）；外層 classification、憑證掃描與 sticky 拒絕行為保持原樣。Inline writer 仍須實際觀察 spawned/close/transport-clean，先持久化 model record，再寫失敗 receipt。

**操作者補收據入口（僅 operator）**：舊 attempt 已正常關閉卻缺 receipt 時的入口指令與條件在 `second-review-operator-recovery.md` §Credential publication denial；一般審查不讀，上段 receipt 映射在一般審查也生效。

### 3. Immutable evidence

Root：`defaultRepoStateDir("devpro-second-review-control-evidence", <installed-renderer-canonical-repository-root>)/<dispatch_id>/`，只有既有trusted host override可替換；arbitrary cwd、packet context或caller root不得改向。Record exclusive/atomic publish；只容許 identity/outcome/content相同的 idempotent reread，其餘 collision。

| Record | Schema / maximum |
|---|---|
| `dispatch.json` | dispatch binding；4 KiB；carrier 位置只以 `carrier_root_id`（carrier root 的 SHA-256）綁定，MUST NOT 寫入任何 absolute carrier path——此 record 雖已隨 reviewer 可寫面收斂不再落在該 root 內，寫 path 仍等於把 carrier 落點重新交還給 reviewer |
| `invocation-claim.json` | matching reservation的single-spawn claim；4 KiB；不是terminal evidence |
| `completion-receipt.json` | current `devpro-second-review-completion/v2`；4 KiB；mode-discriminated：pr-sticky 維持 REST sticky binding；audit-only 省略 sticky、`audit_only_verified`、非 merge-gate。v1 唯讀；不得新寫 |
| `terminal-receipt.json` | `devpro-second-review-closed-terminal/v1`；4 KiB；bounded closed class + lifecycle/cleanup confirmation |
| `operator-disposition.json` | `devpro-second-review-operator-disposition/v1`；8 KiB；已中斷且 claimed runner 的 immutable operator 處分。保留 close/cleanup/scan false，只允許 fresh full-review successor，不是 terminal 或 PASS |
| `operator-abandonment-slot.json` | `devpro-second-review-operator-abandonment/v1`；4 KiB；只適用 PR #2927 exact unstarted-dispatch recovery，綁已驗證 GitHub login/permission、PR/source/head/ref、dispatch、typed confirmation 與 `runner_not_started` attestation |
| `dispatch-lifecycle-slot.json` | `devpro-second-review-dispatch-lifecycle-slot/v1`；8 KiB；每個 runner dispatch 在 invocation claim 前爭用的 immutable lifecycle slot；僅允許 `runner_claimed` 或 PR #2927 的 `stale_reservation_closed` |
| `fault-capsule.json` | `devpro-second-review-fault-capsule/v1`；16 KiB |
| `consumption-receipt.json` | `devpro-second-review-fault-consumption/v1`；4 KiB；固定 `blocked_orchestration_fault` |
| `supersession-receipt.json` | `devpro-second-review-fault-supersession/v1`；4 KiB；`superseded_by_verified_dispatch:<dispatch_id>` |
| `reviewer-model-record.json` | `devpro-second-review-reviewer-model/v1`；4 KiB；requested／observed／agreement。寫入 MUST 嚴格早於該 dispatch 的任何 receipt 封存，故 spawn 之後、本紀錄寫成之前中止的 dispatch **合法無紀錄亦無 receipt**——「每個 spawned dispatch 恰一筆」是**順序義務**，不是無條件義務。INV-MR 僅及於**本要求生效後建立**、且 completion receipt 由 **runner 為實際 spawn 的 reviewer 行程**封存者：此時有 completion receipt 即必有本紀錄。`executor_kind: "external-evaluator"` 不 spawn（見 §3.1），其 completion receipt 由 `writeExternalCompletionReceipt` 封存，該目錄**合法**只有 completion 而無本紀錄，不在 INV-MR 射程內。未 spawn 的 dispatch MUST NOT 產生本紀錄。家族欄具名 `reviewer_cli_family`（實際跑的 CLI recipe 家族），**不**是 `dispatch.json` 的 `reviewer_family`（宣告家族）——同目錄兩個欄位值域不同，勿互代 |

Capsule含 binding/lineage、class/responsibility、redacted provenance、canonical SHA-256 ID；excerpt≤512 bytes。每 directory 的 aggregate 上限為 `MAX_DISPATCH_EVIDENCE_BYTES`，由 `readDispatchEvidence` 對辨識出的 lifecycle evidence 與 `external-closure.json` 實際位元組總和執行 `>` 檢查；slot 可共存組合及 aggregate cap 以該模組的 runtime invariant 為準，不在此複寫派生容量算式。每 PR/head 與每 repo 的位元組上限為 `MAX_BYTES_PER_PR_HEAD`、`MAX_BYTES_PER_REPOSITORY`，三者由該模組的 runtime 不變式綁定（cap×16、cap×512）。**本文件不複寫這三個數值的第二份字面**，以該模組為準——此處曾維護一份派生副本並與程式漂移。fault-capsule path 的名目最壞情況＝dispatch（內嵌的 `lineage_approval_receipt` 與 dispatch 共用同一個 4 KiB 單筆上限，不另計）＋dispatch-lifecycle-slot＋invocation-claim＋reviewer-model-record＋fault-capsule＋consumption＋supersession（後兩者為**連言**，`writeSupersessionReceipt` 硬要求 consumption 存在）＝4＋8＋4＋4＋16＋4＋4＝**44 KiB，已超出現行 cap**（程式以 `NOMINAL_FAULT_PATH_EVIDENCE_BYTES` 匯出同一算式，test 比對本段數字）；名目為單檔鬆界，非 writer 可達量；`second-review-control-evidence.test.mjs` 驗長欄位／JSON 跳脫的七檔讀回，另以非 writer fixture 驗 cap 可讀、cap＋1 拒絕且保留證據，不涵蓋任意歷史 record。超出時仍是**讀取時** `readDispatchEvidence` 拋錯，不是 spawn 前擋下。任何增加互相可共存的 record 或放寬單筆上限前 MUST 依程式實際可共存組合重算此名目最壞情況，並同步調整 `MAX_DISPATCH_EVIDENCE_BYTES` 及其鎖定的 `MAX_BYTES_PER_PR_HEAD`、`MAX_BYTES_PER_REPOSITORY`。每 PR/head≤16 dispatches；單一 active PR-wide lineage≤256 dispatches；每 repo≤512 directories。Repository cap須保留至少兩條最大 PR lineage的 headroom，避免一條合法最大 lineage耗盡整個 repository quota。容量不足在 spawn前 fail closed；不得刪 unconsumed evidence騰空間。

`terminal-receipt.json`固定包含schema、repo/PR/head/attempt/dispatch、outcome group、stable classification、responsibility、`process_spawned`、`lifecycle_phase`、`process_close_observed`、`transport_cleanup_confirmed`、matching `invocation_claim_sha256`（僅pre-spawn為null）、created time與canonical content SHA-256。它與`completion-receipt.json`、`fault-capsule.json`、`consumption-receipt.json`互斥；同一dispatch出現任何duplicate（即使內容相同）、多種terminal record、claim hash不符、欄位缺漏或integrity mismatch都fail closed。Invocation claim本身只保持in-flight；post-spawn claim只有在恰好配對一個合法terminal record後才關閉。

Runner 在 reviewer child 活躍時收到 `SIGINT`／`SIGTERM`，使用 bounded termination 並記錄 `reviewer_cli_interrupted`；只在實際觀測 close 且 transport cleanup 確認時寫 post-spawn terminal，這不是成功審查。若未觀測 close、cleanup 未確認、runner 已被強制終止或中斷不在受控階段，保留 in-flight evidence 並依原 recovery 條件 fail closed；新的 signal handling 不會補證歷史 attempt。

Capacity reservation mutex以固定的`.capacity-lock`路徑作為互斥訊號，owner record為durable `{owner_token,pid,created_at}`；staging、release、quarantine與repair candidate路徑皆為per-acquisition不可重用的unique path；repair record路徑可重建，重試撤回前須比對自己的repair token。Acquire先檢查lock path，再把完整的鎖（目錄與owner record）以一次原子動作發布，不對既有的鎖發布；live owner絕不被偷取，release必須先exact驗token再unlink並fsync parent directory；owner record已移除後release失敗時不得把空目錄搬回lock path。只有超過bounded stale threshold且pid可證實dead的exact record可回收，且必須先以該dead owner token選出unique repair owner；repair owner重新驗證後才可搬動owner證據，搬動鎖或移除證據前先把dead owner身分寫入可關聯紀錄，紀錄寫不進去就不得動鎖，不保留原record，不把任何證據搬回lock path；選舉的輸家不得執行任何回收動作，回到有界等待。已死的repair owner只能經同一個exclusive選舉接手，不得只憑年齡；repair owner存活但離開回收時必須撤回自己的repair record，撤回失敗須有界重試。malformed、token/pid/time ambiguous或liveness不明先fail closed並原樣保留證據；無法證實安全時停止等人工處理，錯誤訊息指出需人工移除的lock項目，不得以stale年齡單獨推定可刪。

`usage-manifest.json` 是 Recap 用量的 cleanup companion：`writeUsageManifest` 將同一份 merged manifest atomic 寫入 dispatch 目錄及 root 下的 `.usage-manifest-retention/<dispatch_id>.json`；讀取先用 dispatch 目錄，缺少時才 fallback 至 retained copy，探索結果依 `dispatch_id` 去重。Runner 每次已 spawn 且觀測 CLI 回傳的呼叫即累積 bounded session/source/model 與正規化 usage，不保存 stdout 或 packet；新 runner 一律寫入 v1 的 `paged_coverage`（普通單窗 planned=1），以 runner 呼叫序號綁定 session，獨立於去重後的 session rows。同 session 的多次呼叫各有 coverage，但 totals 仍只算一次；planned material windows 不限制重複頁的 invocation indices，未呼叫的早停後未來頁不產生缺漏。缺 ID／缺 row／invalid coverage／builder 或寫入失敗的具名 window gap 使 usage coverage 為 `partial`；歷史 manifest 缺 metadata 衍生 `reviewer-window-coverage-unknown` 並標 `unknown`，unknown 不當作 partial，也不追補舊證據。實際缺漏優先於 unknown；無 matching manifest 的 true-zero usage coverage 為 `complete`。Manifest rollup 與 since-change lineage 都傳遞上述具名 gaps，unknown／partial 撤回 `lineage-complete`；空 measurement roots 的原 lineage unavailable 判定不因 usage true-zero 改寫。Coverage 只涵蓋 runner 已觀測回傳的 CLI 呼叫：runner 若在呼叫中被強制終止，既有 manifest 不能證明該次未回傳呼叫的完成或用量，不以此 companion 宣稱完整 paid-session coverage。`cleanupOwnedControlEvidence` 在 capacity lock 下清除超過 30 天的 retained copy，並在副本數超過 512 時由舊至新裁切；hidden retention directory 不計入 `MAX_DISPATCHES_PER_REPOSITORY`。這不延長 dispatch 目錄的 2 小時 owner TTL；manifest companion 不阻擋 complete-directory reclaim。active marker 與未確認消費的 fault evidence 保護不變；usage 擷取、build 與寫入失敗仍 fail-open，activity 記具名 gap，不得改變 review verdict 或跳過 attempt lock release。

### 3.1 External evaluator closure（D4/D5）

`executor_kind: "external-evaluator"` dispatch 不 spawn；closure 改由 TL 側 `<dispatch>/external-closure.json` slot（`{schema, dispatch_id, kind:"accepted"|"voided", receipt_payload, closed_at}`）以與 `publishImmutable` 同構的 temp `openSync wx`＋`linkSync` 排他發布決定；slot 落地即完整內容，永不半寫，為 external closure 唯一時間權威。`accepted` 缺收據時只讀 slot `receipt_payload` 補完、不 live 重讀（避免 sticky 事後改/刪即卡死）。第四形 completion 常數：outcome `external_evaluator_sticky_accepted`、classification `external_evaluator_accepted`、`process_close_observed=false`、無 writer-clock 時間欄；void terminal：outcome group `external_evaluator_closed`、classification `external_evaluator_voided`，皆併入既有 `TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS`/`PRE_SPAWN_TERMINAL_CLASSIFICATIONS`。`readDispatchEvidenceStrict`（gate/lineage/cleanup 專用）：slot `accepted` 無 completion、`voided` 無 terminal、或不可解析 → `external_closure_incomplete` fail closed；已發布收據與由 slot 內容重建者 canonical bytes 不等 → `external_closure_receipt_mismatch` fail closed（不導向 accept，報告 TL）；writer/transition API 只用 raw read（`assertExternalSlotOwnership`），剛佔位未寫收據不被卡住。`assertStickyCompletionBinding` external 呼叫點放寬 `{verdicts:["PASS","WARN","CRITICAL","UNAVAILABLE"], processCloseObserved:false}`（四 verdict 皆可關閉 dispatch；marker 清除仍限 PASS｜WARN，見 `post-pr-completion-gate.md`）；`readDirectPredecessorEvidence`/`assertDirectPredecessor` 接受「無 claim＋external completion 或 void terminal」為已關閉 predecessor。

### 3.4 Component retirement and recovery

觸發：reader/writer/gate 的 evidence 缺損／TTL cleanup／`dispatch_evidence_retiring`／`retirement_recovery_required`。

- 回收單位是完整 bounded dependency component：canonical predecessor、supersession 與既有 retained-fault dependencies 均納入雙向 inventory。必須完成 repository inventory，逐成員保留原 TTL、caps、closure、unconsumed fault、approval/operator/stale audit 與 active-marker safeguards；fresh successor 保護整個 component，單筆 cleanup 不得繞過。
- Admission 在 capacity lock 內重讀 live markers（`pruneStale:false`），呼叫端 markers 只能增加保護。Missing/corrupt/cyclic canonical ancestry、未知 incoming evidence 或超 bound 都不授權 retirement；合法 supersession cycle 在全體 eligible 後可共同回收。
- 同 root 唯一 `.cleanup-retirement.json`（`devpro-second-review-retirement/v1`）是 bounded、immutable、root-bound、hash-pinned allowlisted inventory。它必須 durable commit 後才能刪第一個 member file；它不是 receipt、PASS、closure 或 marker-clear authority。成員 directory 真正刪除前仍占原 repository/PR-head count 與完整 inventory bytes；identity 已刪時只能用 authority 內經 hash/length exact 驗證的 immutable reservation 作 capacity attribution，不得重建或接受 evidence。
- Committed members 同時退出 evidence acceptance；raw/strict readers、新 reservation、lifecycle writers 與 gate 均遵守同一 fence。Valid plan 的 unrelated chain 可用；corrupt authority 使整個 root fail closed。實際 lineage verification 的 current 與 ancestors 必須在一個 capacity-lock snapshot 內讀取；不因此替既有 authoritative PASS 新增 receipt 要求。
- Owner 先 resume pending plan，再選新 component。只對 exact allowlisted regular files 做 hash/size verification、unlink、directory fsync／rmdir／root fsync；缺檔或缺目錄可冪等續跑。Unknown file、changed bytes、symlink、invalid/oversized authority 一律停止並保留 authority，不做 recursive force-remove。所有成員 absent 後才移除 manifest 並 fsync root。
- Zero budget 不發布／刪除；`maxInspect` 只限 seed，不省略 neighbor inventory；`maxCleanup` 計實際 directory removal。正值預算耗盡後保留 committed plan，下次 owner invocation 續跑；不延長 TTL 或提高原 bounds。正預算 owner 在共同 finalizer 恰執行一次既有 usage-retention sweep，涵蓋 pending-plan early return 與 exhausted soft deadline；掃描進度先記帳、sweep errors 隔離且可觀測，不重設預算。Zero/no-work clamps 維持零 mutation。
- 下一動作：retiring → owner 以診斷 resolved root 呼叫 `cleanupOwnedControlEvidence({ rootDir })`（`.devpro/scripts/hooks/lib/second-review-control-evidence.mjs` export）續跑；corrupt authority → 停止自動回收、保留原檔並交 TL 調查，不直接刪 manifest。Missing/corrupt current/ancestor 或 `predecessor_reservation_missing` 涉及既有 lineage → MUST 先讀 `second-review-ancestor-recovery.md`；禁 fresh successor／省略 ancestor 繞過。鎖競爭／binding mismatch 保留原分類，不附 restoration 指引。PASS 的 local-receipt exemption 不豁免 retirement fence。驗證：control-evidence／renderer／post-PR semantic tests 的 witness／component／interruption／race cases。舊 helper/process 必須先 quiesce，pending plan 完成前不得回滾成不認 fence 的版本。

### External audit closure

External `audit-only` 與 external PR 共用 `external-closure.json` CAS、accepted/voided 與 crash reconstruction。audit dispatch 帶 `mode: audit-only`／`review_data_sha256`，不帶 sticky binding。accept 離線驗證 reviewer 自寫 `external-audit-review.json` 後，receipt 用既有 v2 schema 加 `outcome: external_evaluator_audit_accepted`／`classification: external_audit_verified`／`process_close_observed: false`、材料／report digests、原始 audit verdict/tool/model；不帶 `sticky_*`、不要求 invocation claim。成功必須同步 packet-local byte-identical mirror；失敗保留 CAS，重跑從 slot 重建，不能覆寫衝突證據。這只證明接收，不證明 CLI process close 或 PASS，不提供 PR predecessor／merge gate，不建立 marker／PR round／sentinel PR capacity bucket。流程與 retry 入口：`second-review-external-evaluator.md` §一般 audit。

### 4. Gate lifecycle

0. External marker（`executor_kind: external-evaluator`）不適用本節1–3：一律經 `post-pr-completion-gate.md` external disposition，只有 `clear_policy`（`MERGED` 或 cross-model exempt）或 slot `accepted`＋第四形 receipt＋body digest 相符＋`PASS|WARN` 才清；無收據的 PASS sticky 保留 marker。
1. Consumer authority（runner marker）：normal active、relevant `MERGED`、skipped + `MERGED` 先驗 exactly-one canonical sticky `verdict: PASS`、current head、`dispatch_id == marker.expected_dispatch_id`。成立時依 `post-pr-completion-gate.md` 清matching marker，不要求completion、consumption、supersession或successor receipt；later same-dispatch fault仍保留為runner診斷。Skipped marker若PR未證 `MERGED`，仍保留marker並advisory-only。
2. Current allowlisted fault：前述authoritative PASS不成立時，gate驗 marker/binding/schema/integrity，exclusive create或 exact reread blocked receipt；保留 marker並 block。若PR snapshot已前進，gate仍須消費exact marker-bound舊head fault，但不得把這次消費當成新head成功或清marker；fast-forward與successor binding由renderer另行驗證。Missing/corrupt/tampered/mismatch fail closed。合法 cleanup後 capsule可缺，但 receipt須留相同 binding/outcome。
3. `WARN` receipt path：gate要求current dispatch已有runner-owned immutable completion receipt，且receipt exact綁marker current head/dispatch、sticky `WARN` verdict/SHA/dispatch與`process_close_observed=true`；invocation claim或fresh `WARN`單獨存在都不是terminal completion。之後為同PR bounded lineage的舊 faults驗/建 blocked receipt，再 append supersession receipt；禁改 consumption outcome。完整 chain後才清 marker。
4. Valid consumption後 capsule才可清。Marker在時，cleanup owner必須從 marker-bound current dispatch沿 canonical `previous_dispatch_id`逐一驗證完整 ancestor closure，並保護 closure內所有 same-head與older-head directories；不得只保護 current head。任一 ancestor缺失、corrupt、identity/edge不符、形成cycle或超過256 dispatch bound時，cleanup須保護全部 control evidence並 fail closed。Marker在時不可刪 receipts；清 marker後只由 owner TTL依 §3.4 component admission／retirement 清 complete chain。Generic pruner不得進 prefix；unconsumed永不按時間刪。
5. Rule/skill/adapter只消費 structured result/capsule/receipt，禁 mine reviewer text。Wrapper-local terminal control evidence MAY carry raw `activity_log_path` only inside the local wrapper/control-plane result for `projection_wrapper_terminated_mid_run` triage；PR/sticky/handoff/repo-visible summaries MUST omit raw local paths and show only classification、`attempt_id`、artifact key（例如 `activity_log`）或 redacted/repo-relative reference。Handoff只顯 class、responsibility、denied class、provenance/confidence/matcher、capsule/integrity prefix、next step；禁 local path/raw evidence。
6. 名稱符合 post-PR marker pattern但無法 stat、讀取或解析時，必須當成 unreadable unbound marker：gate維持 blocked，cleanup保護全部 control evidence。禁止把 unreadable marker當成 marker absent。

## Exit Criteria

- Mode-bound dispatch/binding一致且每dispatch至多spawn一次；two-class allowlist、empty-by-default registry與precedence有正反fixtures。
- Evidence bounded/redacted/immutable；runner marker的authoritative PASS可直接形成post-PR consumer authority，`WARN` success須有exact completion receipt/no-current-fault/完整supersession chain；external marker除 `clear_policy`（`MERGED` 或 cross-model exempt）外只憑§3.1 accepted closure收據清除；blocked receipt不改寫，active marker保護完整PR-wide ancestor closure。
- Reservation/publication遵守§1的authoritative head、transaction、schema-conditional 7/8 carriers、CAS與crash-recovery順序；不可驗證即fail closed。
- `pr-sticky` disposition經renderer與pre-spawn exact revalidation，reviewer只執行指定action/target並維持post-write continuity；`audit-only`為N/A。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「runner fault一定推翻fresh PASS」 | runner classification與consumer authority分離；只有post-PR exact current-head marker-matching `PASS`可先行，`WARN`仍受fault precedence約束 |
| 「文字很像 denied」 | 未註冊 exact shape一律 unknown |
| 「retry可沿用 evidence」 | 每次 invocation須新 reservation/lineage |
| 「reviewer可從 previous sticky 找target」 | `previous_sticky`是inert data；write authority只來自wrapper disposition |

## Verification

```bash
node --test .devpro/scripts/tests/second-review-control-evidence.test.mjs
node --test .devpro/scripts/tests/rule-token-budget.test.mjs
```

## Interrupted runner 的 operator disposition

**操作者放棄入口（僅 operator）**：放棄入口、資格、鎖序與處分紀錄 `operator_abandoned_interrupted_dispatch` 在 `second-review-operator-recovery.md` §Interrupted runner；只在 attempt 被中斷、使用者決定放棄重審，或 gate／renderer 遇到該處分時讀。下段 authority fence 在一般審查也生效。

Known disposed exact dispatch 的 sticky 無 admission authority：renderer、post-PR 與 merge PASS/WARN consumer 共用 `assertDispatchReviewAuthority`；損壞／不可讀 disposition fail closed。無 disposition 時 fence 只需讀取權限、MUST NOT 取 capacity lock：gated writer 在 reviewer 沙箱內執行，control evidence root 不在其可寫範圍；有 disposition 才走鎖內嚴格讀取，取不到鎖同樣 fail closed。正常 remote PASS 不新增 positive local receipt 義務。多 sticky 一律 blocked，不能濾除舊 comment 後挑新者；CRITICAL 維持阻擋。新 runner／lifecycle writer／gated sticky writer 拒絕 disposed attempt 追加權威；舊 binary／已送出 HTTP 無法由本機鎖撤銷，仍以唯一 sticky＋negative fence＋正常 fresh premerge snapshot 防止採信晚到結果。operator 接受的是已知中斷的有限殘餘，不能改寫成觀測到 transport close。
