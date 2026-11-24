---
name: second-review-operator-recovery
description: "Second-review 出錯後操作者明示執行的三個恢復入口：legacy 診斷關閉、credential gate 補收據、中斷 runner 放棄處分；不新增 acceptance authority。"
---

# Second-Review Operator Recovery

## Overview

三個只由操作者明示執行的恢復入口，hook、renderer、gate 或 scheduler 不得自動呼叫。正常審查的 dispatch、終態分類、證據與 gate 契約仍以 `second-review-control-evidence.md` 為 SSOT；本檔只持有這三個入口的條件與輸出。

## When to Use

由 `second-review-control-evidence.md` 對應段落的指引行載入，一般審查不讀：

- §2.1：退役前的 `page_window_full_scan: true` 診斷 attempt 只留下 `blocked/page_window_full_scan_final_no_sticky`，沒有 terminal receipt。
- §Credential publication denial：舊 attempt 已正常關閉並完成 cleanup，卻因 credential gate 分類缺口沒有 receipt。
- §Interrupted runner：attempt 被中斷、使用者明示放棄該 attempt 的審查權威，或 gate／renderer 遇到 `operator_abandoned_interrupted_dispatch` predecessor。

## Process

### 2.1 Legacy diagnostic dispatch closure（operator-only）

退役前已跑完的 `page_window_full_scan: true` 診斷 attempt 可能只留下 `blocked/page_window_full_scan_final_no_sticky`，沒有 terminal receipt；此時不得直接 regenerate 或改 evidence。操作者明確執行 `node .devpro/scripts/run-second-reviewer-projection.mjs --reconcile-legacy-diagnostic-scan <observability-context.json>`；此路徑不是掃描模式或自動 recovery，不能由 hook、renderer、gate 或 scheduler 呼叫。

- MUST 驗證 named context 的 self path 與 canonical carrier sibling paths、absolute evidence root、canonical dispatch/predecessor IDs、pr-sticky paged legacy shape；repo/PR/head/attempt/dispatch/predecessor 與 carrier_root_id 必須 exact 比對 immutable reservation，且 matching invocation claim digest 必須等於唯一 claimed activity event。歷史 runner 會原地推進 packet.md，故其 final bytes 可不同於 reservation 的初始 packet_sha256；只在此關閉路徑以 reservation 已綁的 full-material SHA-256、created/expires metadata、identity/root、manifest hash 與全部 page digests 驗 immutable full-material carrier，再用共用 material validator 驗 final frame、prior checkpoint/findings ledger、每窗 page indices/width 與 window count。初始 packet_sha256 原樣保留，禁止以可變 context width/count 或當前 packet hash 取代 immutable pin。不要求今日 execution prompt/recipe 或尚未過期的 full-material TTL；這只授權關閉，絕不授權 reviewer spawn 或重用 material。
- MUST 驗證無 completion/terminal/capsule/consumption/supersession/external closure；K started = K exited = pinned manifest 推導的 `page_window_count` ≥2，逐一交替且 PID 唯一；K 個 live-gate、K−1 個 advance 的 index/count/findings_windows 與 close/next-start 時序必須一致，final gate 須 exact legacy classification、phase final、scan_complete=true；每窗 exit code 0 且 spawned/close/transport cleanup 皆 true；每個 attributed event 與 CLI event 的 attempt identity 必須相符。Heartbeat 必須 exact 綁本 attempt/dispatch、blocked/舊分類、sticky failed 且 sticky_comment_id=null。缺檔、截斷、非 regular file 或不確定皆 fail closed。
- MUST 驗 attempt lock 不存在或 owner 可證實 dead，且 supported host 的所有 PGID probe 皆 ESRCH；live/EPERM/unknown/unsupported 均拒絕。Live sticky authority 恰一則且 dispatch 等於 `previous_dispatch_id`、last_reviewed_sha 等於舊 context head；pending marker 依 named evidence root sibling 與既有 `postPrCompletionDir` producer 設定（含 override）逐一 point-read；任一路徑若存在都須 exact 綁 repo/PR/head/本 dispatch，malformed 或 foreign marker 皆拒絕。Evidence root 僅取 named context、不用 ambient override，並維持 §3 immutable identity/root 綁定；寫入前重驗已讀 carrier/marker bytes 與 lock，變動即 blocked。
- 唯一成功輸出為既有 v1 closed-terminal 的 `outcome_group: diagnostic_scan_closed`、`classification: legacy_diagnostic_scan_closed`、`lifecycle_phase: post_close_transport_reconciled`，保留既有 spawned/close/cleanup/claim digest 義務與 exclusive create。MUST NOT 寫 completion、sticky、清除/推進 marker 或提供 merge readiness；它只解除 closed-predecessor blocker。一般 runner 仍拒絕舊旗標，既有 transport reconcile 仍限單一未清理 transport；成功後才以正常 renderer 產生 fresh dispatch。

驗證：runner native 14-window fixture 的 renderer before/after 與逐條負向、race/collision；shared strict evidence reader + consumer enum guards。先升級共享 reader/writer/consumer 再由操作者執行；consumer state/evidence 的實際關閉須獨立具名授權。

### Credential publication denial 的失敗終態恢復

若舊 attempt 已正常關閉並完成 cleanup，卻因上述分類缺口沒有 receipt，操作者可明確執行 `node .devpro/scripts/run-second-reviewer-projection.mjs --reconcile-credential-gate-terminal <observability-context.json>`。此入口只收單一具名 pr-sticky attempt，不得由 hook、renderer、gate 或 scheduler 自動呼叫；不適用 transport 未清理、legacy scan、interrupted 或 external evaluator。

- 同一 context 的 canonical sibling paths、初始 material/reservation、claim digest、model selection/observed agreement、activity 與 heartbeat 必須精確綁定。要求唯一且依序 claim/start/exit、code 0、spawn/close/cleanup confirmed，heartbeat 保留上述 credential failure、同 PR/expected head、無 sticky/comment/verdict；early denial 的 sticky dispatch ID 可為 null。
- 原 owner 必須 absent/dead，所有已知 reviewer PID/PGID 必須以 signal 0 證明 absent；不確定即拒絕。不得存在 completion、fault capsule、consumption、supersession、operator disposition/abandonment 或 external closure。
- 可信 gh REST 讀回必須證明 repo push permission、PR OPEN/unmerged、base/head 為同一目標 repo，當前 head 為原 head 或經 exact compare 驗證的 fast-forward；完整 comments snapshot 不得有任何 canonical sticky。任何既有 sticky 均交還正常審查流程，不從內容推導成功。
- 發布前重讀 carrier/evidence/marker snapshots、typed evidence、owner 與 live authority，變動即 blocked。只以既有 immutable writer 新增原 dispatch 的 `sticky_contract_invalid`、`post_close_transport_reconciled` 失敗收據；保留原證據，activity 只追加標準 terminal event。完全相符的既有收據可 byte-identical 讀回，不再寫入；其他收據 collision。
- 不啟動 reviewer、不寫 sticky/completion、不修改或清除 marker、不授予 PASS/WARN 或 merge readiness。恢復後由操作者接續正常 renderer 的 fresh full-PR review。測試入口：runner fixtures 的 `credential gate recovery` 與 `closed native runner retains`；既有 transport/legacy recovery 負向與 automated-carrier guard 必須保持綠燈。

### Interrupted runner 的 operator disposition

`abandon-interrupted-second-review.mjs <observability-context.json> --dry-run`（判定可否放棄並印出 challenge）→ `... --confirm <exact challenge> --reason <operator statement>` 是唯一推薦 operator 入口；context 相對路徑以 main checkout 解析。schema／欄位／exclusive writer 與 negative authority fence 的 SSOT 在 `second-review-control-evidence.mjs`。`interruptedDispatchConfirmation(dispatch)` 由原 immutable reservation 產生完整 repo／PR／head／attempt／dispatch challenge；`interruptedDispatchRecoveryHint(attemptId)` 是 renderer／runner 拒絕訊息共用的指路文字，只指路、不判定資格；evidence 顯示已 close 或讀不到時不出現。死在 claim 之前（有 dead lock、沒有 invocation claim）的 attempt 走同一入口，處分記 `process_spawned: false`、claim 與 lifecycle slot 為 `null`，之後不能再 claim；死在兩窗之間（已啟動的程序都有 close）也可放棄。沒有 claim 也沒有 lock 表示 runner 沒跑過，入口會指回它的 `projection_runner_command`。先有使用者針對該 attempt 的明示放棄決定，AI 才可代執行；使用者針對該 PR 說「刪除重審」即算數、不必再問，只限當次、不是長期授權；challenge 由 AI 照抄 dry-run 輸出，使用者不用打。登入權限、AI 自寫紀錄或 dry-run eligible 都不取代使用者裁定。

入口只支援 same-repository OPEN PR、原 claimed runner、無 completion／terminal／fault／model authority、恰一個未觀測 close 的 invocation；所有已知 PID/PGID 與原 runner lock owner 當下 absent。PR head 須等於原 dispatch head，或經 `git merge-base --is-ancestor` 證明由其 fast-forward（與 renderer 同一判準；處分的 `remote_pr_head` 記實際 head）；改寫歷史或無法驗證皆 blocked。完整 GitHub snapshot 須無 canonical sticky，或恰一則可解析且綁在其他 dispatch 的 sticky；該則不改動，其 findings 與 merge gate 判定照舊。live／unknown owner、資料損壞、權限不符皆 blocked。綁在被中斷 dispatch 的 sticky、不明或多 sticky 必須另行處置，不能用 abandonment 抹除 findings。CLI 核對原 claim、carrier root 與完整材料 pin；legacy paged mutable packet 不冒充原 reserved packet hash。材料過期只作歷史證據，不授權重用執行。

鎖序為原 post-PR marker → capacity/lifecycle；鎖內重驗 exact binding、activity／owner snapshot、GitHub head／push permission／完整 sticky，再 exclusive durable publish 處分。原 claim、lifecycle slot、runner attempt lock、packet、activity、材料及 usage manifest 全部保留；不得刪鎖、rename 舊 carrier、補造 close receipt。處分 pin 原 dispatch/claim/lifecycle digest、原 packet/carrier/material pins、觀測 activity prefix length＋digest、lock/marker/sticky snapshot、operator login/permission/checktime/明示裁定及理由；不持久化 raw activity payload。相同 immutable authority 可 idempotent 讀回，衝突不得覆寫。cleanup 必須保留此 audit 及 dependency lineage，容量按實際處分 bytes 計。

`operator_abandoned_interrupted_dispatch` 保留 `process_spawned=true`、`process_close_observed=false`、`transport_cleanup_confirmed=false`、`scan_complete=false`、`review_authority=none`、`successor_policy=fresh-full-review-only`。這是 operator-disposed predecessor，不是 closed predecessor；與 completion／terminal／fault 等權威互斥，不能自行清 marker。renderer 得循正常 publication/CAS 建 fresh attempt/dispatch，精確指向 disposed predecessor；scope 必須 full-pr，由第1窗完整重審，不拼接舊 coverage。此完整重審義務沿 bounded lineage 穿過失敗 retry 保留，直到 fresh successor 有可信 completion 或 exact canonical READY sticky；僅建立 full-pr reservation 不算履行。WARN lineage 亦承認此 disposed edge，current review 的 completion 義務不變。

處分不授權 waiver、憑證撤銷或假收據，也不能宣稱可撤銷舊 writer 已送出的 HTTP。Known disposed sticky、duplicate 或 Critical 仍 blocked，不能自動刪 comment。

## Exit Criteria

- 每個入口只在操作者明示執行時跑，條件不確定即 blocked。
- 成功輸出不寫 completion 或 sticky、不清 marker、不授予 PASS／WARN 或 merge readiness；後續一律由正常 renderer 建 fresh dispatch。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「dry-run 顯示 eligible，可以直接放棄」 | 先要使用者針對該 attempt 的明示放棄決定；登入權限、AI 自寫紀錄或 dry-run eligible 都不取代使用者裁定 |
| 「恢復成功就能 merge」 | 三個入口都不授予 PASS／WARN 或 merge readiness；之後由正常 renderer 建 fresh dispatch 重審 |
| 「讓 hook 或 scheduler 自動跑恢復比較省事」 | 入口只由操作者明示執行，不得由 hook、renderer、gate 或 scheduler 自動呼叫 |

## Verification

```bash
node --test .devpro/scripts/tests/second-review-operator-recovery-grep.test.mjs
node --test .devpro/scripts/tests/run-second-reviewer-projection-reconcile.test.mjs
```

grep test 只驗文字入口與指引；入口行為由上列與各段「驗證」「測試入口」所指的 fixtures 驗。
