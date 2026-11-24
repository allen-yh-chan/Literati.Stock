---
name: performance-investigation
description: "使用者回報慢、比較 benchmark 或要求效能改善時，驗有效 workload、profile、單假設量測與保留／回退。"
---

# Performance Investigation

## Overview

以真實完成的工作與端到端結果裁決效能假設。TL／implementer 共用此流程，產品驗證與測試套件只保留各自的執行 profile；不新增工具平台、套件或 CI。

## When to Use

- 使用者回報延遲、吞吐或資源問題，或準備依 benchmark 結果選方案時。
- 想以快取、並行、演算法或刪除工作來改善可觀察效能，尚未證明其價值時。
- 單純分析已有 trace 可停在診斷；沒有修補授權不改產品或 live process。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | N/A for performance judgment |
| Advisory | N/A |
| Doctrine | `cooperative-only`：workload、根因與量測可信度由實際 evidence 判斷；anchor tests 不判快慢。 |

### Measurement-Driven Optimization Loop

1. **Workload and harness**：寫明使用者工作、代表性輸入、指標與會改變決策的目標。MUST 先驗正確輸出、成功／錯誤數與計時區間內實際完成的工作，確保輸出被消費、工作未被略過；先確認 harness 能揭露差異，再固定比較方式。MUST NOT 將無效工作、全部報錯或雜訊當成改善。
2. **Canonical baseline**：使用實際產品／專案入口，在可比版本、資料、設定、暖機與負載下保留 baseline、commands、環境與原始觀察。量測窗口受外部負載干擾就等待或標 inconclusive，不用單次數字作決策；單次探索須明示限制，不設固定重跑次數。
3. **Profiler first / Critical-path ranking**：從 trace、CPU／allocation／retainer／I/O 等直接訊號追到 source hot path，按端到端可貢獻量排序。已有有效 capture 先讀，不為形式重跑；符號、配對 capture 或環境不足須限制診斷。Runtime instrumentation 僅限已授權範圍。
4. **Root-cause research**：以實際版本的 source／官方資料核對假設；不確定或 niche 時查一手依據。先評估刪除未使用工作，再考慮減少／延後、快取、並行或演算法；「少幾個 process」不自動等於根因。
5. **Bounded POC**：MUST 一次只改一個可回退假設，事前寫預期機制、觀察方式與足以改變決策的條件；保持相同 correctness、覆蓋與副作用。未成立 MUST 完整撤回該候選，記錄觀察與原因，再試下一個；不能把未知效果疊在一起。

   錯誤或副作用契約尚未核准的改變 MUST 先撤回，不能保留候選再請 owner 確認；依既有 intent lookup 分清 intended／observed。運算結果沒被使用，不代表其例外或副作用可刪；「錯誤變少」也不能自行當成相容。可獨立保留已驗證的 harness 修正，再交契約差異與下一個安全步驟。
6. **Expand only after proof / Re-measure and loop**：成立才擴大，擴大後重測同一端到端工作，核對正確性、成功／錯誤數、完成量、可比性與變異。局部改善不可相加；差異無法與雜訊區分就不判 faster／slower。
7. **Stop and handoff**：達到任務目標、可驗證假設用盡、外部條件阻塞或核准 scope／budget 到界即停止，記錄剩餘風險與下一個安全動作；不設固定迭代次數。原始觀察與每次 hypothesis／change／result／keep-or-revert 留在既有 QA／handoff，不能只寫「變快了」。

Source test-tier／full-suite 的 runner、coverage、spawn／Git profiler、量測隔離與專用 stop-loss 由 `test-performance-patterns.md` 承擔；本共用方法不改其門檻或 test cadence。

## Exit Criteria

- Harness 已確認真正完成預期工作，語意與失敗率未被犧牲。
- 每個改動有根因假設、可重讀觀察與保留／撤回理由；未成立的候選已撤回。
- 端到端比較可解釋，或明示 inconclusive／未驗證與限制；不承諾未量得的收益。

## Common Rationalizations

| 藉口 | 反駁 |
|---|---|
| 「少做事所以更快」 | 先驗完成量、結果與錯誤；漏做不是改善。 |
| 「幾個局部百分比相加」 | 以同一端到端 workload 的實測裁決。 |
| 「沒變快但先留著再試下一招」 | 撤回未成立假設，保持下一次比較可解釋。 |

## Verification

用回傳空結果卻很快的 benchmark、無改善／雜訊與正常完成工作的控制案例，核對實際 harness、commands、patch 與去留。結構檢查：`node --test .devpro/scripts/tests/poc-first-trigger-gate-grep.test.mjs`；不把它當效能或語意證明。
