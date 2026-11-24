---
name: post-intervention-recovery-gate
description: 對故障中的 runtime／process／environment 做過 recovery intervention 之後、宣稱復原之前的驗證閘：重跑 current original exact case、填 `Recovery Verification` 四欄、staleness／self-run boundary／recovered-ready gate／insufficient evidence／failure disposition／non-evidence。觸發：restart、relaunch、reconnect、reload、reconfigure 或等價介入後，要宣稱 recovered／ready、結束 troubleshooting 或請使用者重試時。
---

# Post-Intervention Recovery Gate

> Load-chain：本檔由 `troubleshooting.md` 的 Load-chain（Post-Intervention Exact-Case Recovery Gate）行與 `platform-adapters/cursor.md` Turn-end checklist 第 0 步按需載入；只是偵錯、尚未對 runtime／process／environment 做 recovery intervention 時不需讀本檔。偵錯順序、Evidence Ledger 與 Debug Report 留在 `troubleshooting.md`。

### Post-Intervention Exact-Case Recovery Gate

agent 對故障中的 runtime／process／environment 做 restart、relaunch、reconnect、reload、reconfigure 或等價 recovery intervention 後，在宣稱 recovered／ready、結束 troubleshooting 或要求使用者重試前，MUST 先把狀態轉為 `verification_pending`，並執行下列正向 recipe：

1. 以同一 URL／endpoint／input／操作重跑造成回報的 current original exact case；只驗原始 failure surface，不擴張成無關的全域 E2E。
2. 從本輪實際結果填寫 `Recovery Verification` 四欄；若 request 重現 crash／error，同步回到 investigating／blocked。
3. 只有 current exact case 成功且 request 後 runtime 維持 stable，才可把 `recovery_status` 升為 recovered／ready；否則依下列 disposition 回報替代 evidence、缺口與 next owner。

`Recovery Verification`：

| 欄位 | 本輪 evidence |
|---|---|
| `exact_case` | 實際重跑的原始 surface，或 unavailable 原因 |
| `user_visible_result` | 使用者可見的成功／失敗結果，或無法觀察的限制 |
| `post_request_stability` | `stable`／`failed`／`unavailable`，並附直接 evidence |
| `recovery_status` | `recovered`／`ready`／`blocked`／`unverified` |

**Staleness**：每次新的 recovery intervention 都 MUST 使先前 recovery evidence stale；舊 success、先前 request 或 intervention 前結果不得解鎖本輪狀態。

**Self-run boundary**：在 existing authority/tool boundaries 內，agent MUST 自行重跑 current original exact case，MUST NOT bypass Ask First/Never；需要新權限、secret、destructive、未授權 cross-repo write 或其他 Ask First 動作時停下，不得以本 gate 擴權。

**Recovered/ready gate**：current original exact case、user-visible result 與 post-request stability 缺一時，agent MUST NOT 宣稱 recovered/ready；三者均為本輪成功且 stable 的直接 evidence 時才可升狀態。

**Insufficient evidence**：process alive、PID、listener／port、restart exit 0 或 started log 可作替代診斷 signal，但單獨或組合都 MUST NOT 作為 recovered/ready 的充分 evidence。

**Failure disposition**：exact case `failed` 或再現 crash/error 時 MUST 保持 investigating/blocked；因既有 authority/tool boundary `unavailable` 時 MUST 保持 blocked/unverified，並列替代 signal、缺失 evidence 與 next owner。

**Non-evidence**：同對話 reminder、先前承諾、口頭「已驗證」或 user retry 要求 MUST NOT 作為 current evidence，也不得把 agent-runnable exact case 外包給使用者。
