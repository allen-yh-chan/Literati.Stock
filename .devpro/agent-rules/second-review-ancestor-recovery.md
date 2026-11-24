---
name: second-review-ancestor-recovery
description: "Missing/corrupt reviewer ancestor 的 TL 調查、exact-original restoration 與 blocked escalation；不新增 acceptance authority。"
---

# Reviewer Ancestor Recovery

## Overview

TL 調查既有 evidence 缺損，還原原 bytes 或交棒 blocked；不建立 acceptance authority。

## When to Use

由 `second-review-control-evidence.md` §3.4 載入：缺失／損毀 current 或 ancestor immutable evidence，或 `predecessor_reservation_missing` 涉及既有 pending marker／ancestor obligation。Owner 是 TL；只供調查／還原，不授權 marker transition。

排除：鎖競爭、binding mismatch 保留原分類；`dispatch_evidence_retiring` MUST 回到原 §3.4 owner 以 `cleanupOwnedControlEvidence({ rootDir })` 續跑，不從備份復活 committed member；corrupt retirement authority（`retirement_recovery_required`）MUST 保留 authority 並交 TL 調查，不刪 manifest。真正沒有 pending marker／ancestor obligation 的全新 lineage 仍走既有 renderer 契約。

## Process

### 1. 調查紀錄

TL 在 main-checkout `notes/reviewer-ancestor-recovery-<pr>-<dispatch>.md` 記調查（依 `session-pending-lifecycle.md` 的 main-checkout-root 契約定位）。紀錄 MUST NOT 成為 receipt、closure 或 marker-clear authority；MUST 保留原 marker 與現存 evidence，不執行 generic prune。

| 欄位 | 必填內容 |
|---|---|
| binding | `resolved_root`、`repository_slug`、`pr_number`、`head_ref_oid`、`expected_dispatch_id`、`missing_dispatch_id`、`previous_dispatch_id`；取自原診斷／marker／reservation，不猜值 |
| `searched_sources` | 原 render 使用的 root／`DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR`、其他 clone／worktree 的 root、備份及原 carrier；逐一記已查／不可存取／不存在及原因，不做全磁碟掃描 |
| `original_provenance` | 原始來源、可獨立比對的既存 digest／length、原 dispatch／repo／PR／HEAD binding；找不到記 unknown，不拿新生成檔案填空 |
| `verification` | 失敗分類、缺／壞檔案、原始證據比對、原 gate 命令及結果；raw paths／證據留 local，不貼 PR／sticky |
| `status` / `owner` / `next_action` | `investigating`、`restored-and-gate-passed` 或 `blocked-escalated`；具名責任人／下一動作及解除條件 |

先核對原 render root 與 direct predecessor；root 不同先定位原 root，不以 unrelated dispatch 湊 chain。只讀盤點，不得 clone／修改其他 repo。可驗原始副本進步驟 2；查無副本、存取受阻或來源不可驗進步驟 3。

### 2. 可還原

1. MUST 驗證來源為原始 immutable evidence，逐檔比對獨立保存的 hash／length 及原 repo／PR／HEAD／dispatch／predecessor binding；不得用候選檔自己算出的 hash 當原始來源證明。原始副本或 provenance 不足即停止、轉步驟 3。
2. TL 先列 exact root、檔案與來源、碰撞處置及原 gate 驗證方式，依既有 Ask First 取得還原寫入授權；MUST 先停止相關 writer／cleanup owner，遵守既有 lock，重驗 root／marker binding 與 retirement fence。Concurrent owner、unknown file、symlink 或 retired member 均停止，不以本程序繞過。
3. MUST 只還原已核准 root 的原始 regular-file bytes，保留原檔與來源比對紀錄；不得重新序列化、改 ID 或重建 receipt。損毀檔也須保留原 bytes，不以手寫 JSON 還原。
4. MUST 重跑原先被擋的 gate，讓既有 binding／integrity／完整 lineage／retirement 驗證判定；只有原 gate 的成功結果且原 marker 依既有規則完成處置，才可記 `restored-and-gate-passed`。單純 copy 成功、sticky PASS 或產生新 dispatch 不算恢復成功；失敗保留分類與 blocked 狀態，轉步驟 3。

### 3. 不可還原／尚不可驗證

TL MUST 記 `blocked-escalated`、已查來源、缺失或不可驗原因、具名 owner 與 next_action；MUST 保留 blocked marker 與現存 evidence。這是調查終態，不是 gate 通過；本輪找不到不等於永久不存在。

owner 由 TL 交給有原始備份／存取權的維護者（未指定則使用者）；next_action 是提供可驗原始證據後回步驟 2，或由使用者決定另開 authority 設計 change。未回覆時保持 blocked，並把此紀錄與缺口連到 main-checkout `notes/session-pending.md`，供接手者續查。

MUST NOT 刪 marker、捏造 receipt、略過 ancestor、移除 `previous_dispatch_id` 或以 fresh successor 當成恢復。新 marker transition／closure authority MUST 另案取得使用者明確核准、需求／設計、獨立審查及負面測試；本程序不提供 waiver，也不把其他既有 gate 路徑改成 restore authority。

## Exit Criteria

原 gate 驗證成功並處置原 marker，或 blocked 紀錄已連到 pending、具名 owner 與 next_action。

## Common Rationalizations

「重跑拿 PASS 就好」→ fresh successor 無法恢復原祖先；調查紀錄也不是 gate 收據。

## Verification

文字入口／程序 guard：`node --test .devpro/scripts/tests/second-review-ancestor-recovery-grep.test.mjs`。只驗文字 anchors，不證明備份可信或操作安全。

既有行為 fixture：`node --test --test-name-pattern='lineage lifetime gate retains markers for missing, corrupt and retiring ancestors with safe diagnostics' .devpro/scripts/tests/hook-post-pr-completion.test.mjs`；驗缺失／損毀／retiring 保留 marker，exact-original bytes 恢復後才由原 gate 正常處置。真實事件須留原 gate 結果，不拿 fixture PASS 代替。
