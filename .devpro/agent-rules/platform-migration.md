---
name: platform-migration
description: "平台遷移相容性工程（涵蓋 runtime/framework 升版、Docker 化、CI-CD wiring）；觸發：migration、runtime/framework upgrade、containerization、遷移、升版、容器化。"
---

# Platform Migration

## Overview

[cooperative-only, weak enforcement] Migration 預設是相容性工程：升平台但維持 legacy-visible behavior，不重寫、不順手現代化、不修非阻塞 warning、不改 UI/deployment contract。runtime/framework/Docker/CI-CD 跨 repo gate；無 hook 兜底。

## When to Use

- runtime upgrade（.NET / Node / JVM 主版本升級）；frontend framework migration
- containerization（Docker 化）；reverse proxy / session / cookie contract 變更
- CI/CD wiring changes（pipeline、secret injection、environment matrix 調整）
- multi-phase migration program（第一個 PR 前需 program tracker + Program base branch + phase dashboard）

不觸發：純 hotfix、styling cleanup、單一 dependency patch（不涉及 runtime 或 deployment contract）。

## Process

### Migration Invariants

**Compatibility Contract：** migration phase 先證明「舊行為不變」；若要改 behavior，需另開 change、取得使用者確認並附驗證證據。
**7 條不可變項（migration PR 不得改變）：** API request/response shape；route/redirect/guard/menu/權限；session/captcha/cookie/antiforgery/idle timeout；success/error/validation/loading/disabled/empty/fallback state；iframe/download/upload/proxy/WCF-REST/config key；Razor/static asset/`.securejs`/MIME/publish/Docker/cache-busting；mock 不得宣告 integration parity。
**需另開 change（禁止混入 migration PR）：**

| 情境 | 原因 |
|---|---|
| 修 warning 改 null/exception/JSON/async timing | 改 legacy-visible behavior |
| 清理 template 改錯誤訊息/disabled state/欄位文字 | UI behavior delta |
| UI 現代化改流程/預設值/格式 | 超出 migration scope |
| 容器化改 cookie/TLS/DataProtection/file path | deployment contract 變更 |
| 降 bundle size 改 route loading/guard/service lifecycle | 改 runtime behavior |

**Phase Gate — proposal / PR body / phase issue 必須回答：** 保證哪些 legacy behavior 不變？是否刻意改 legacy-visible behavior？若有，使用者確認與驗證證據？哪些只完成 local smoke，仍需 SIT/UAT/integration？未回答視為 phase 未就緒。
### Warning Fix Policy

Warning 不是修正授權；消 warning 若改 control flow、null/exception、serialization、async timing 或 UI state，風險通常高於保留 warning。

| 分類 | 處理方式 |
|---|---|
| Build error | 必修（阻擋 build/test/publish）|
| Migration blocker warning | 可修，但需記錄 |
| Security finding | 另開 issue / phase |
| Legacy warning | 記錄，不修 |
| Style / cleanup warning | 不修 |

**禁修 7 類：** null/empty string 判斷；exception catch/rethrow/swallow；JSON casing/null omission/date-time/number；async/loading/disabled/error finally flow；Razor/Angular template fallback；session/cookie/antiforgery/captcha/auth/guard；SQL/API/WCF request mapping。
**同 phase 可修的 4 條件：** 阻擋本 phase build/test/publish/container gate；最小必要變更；測試或 smoke 證明 behavior 不變；PR body 列 warning、理由、證據。保留紀錄：在 phase issue/PR body 記錄類型、不修理由、何時另開。
### UI Parity Checklist

畫面「有出來」不等於 UI parity；錯誤訊息、validation、disabled/loading、menu/guard、iframe/report/download 不一致，都是 regression。

**Route 基本資訊（每 route）：** legacy/新平台 path；guard/role；backend endpoints；upstream/report/iframe；LocalVisualReview 覆蓋；仍需 integration 項目。
**Visual / Interaction 10 條：**
- 頁面/區塊標題/欄位 label/按鈕文字一致；必填/disabled/readonly/預設值/placeholder 行為一致。
- 日期/金額/卡號遮罩/狀態文字/格式一致；查詢/清除/重設/返回/匯出/上傳/下載/列印/開報表行為一致。
- loading/exporting/submitting 狀態成功/失敗後恢復可操作；backend error message 原樣顯示，不被 generic error 覆蓋。
- validation error 顯示位置/觸發時機/阻擋行為一致；empty result/no permission/not logged in/session expired fallback 一致。
- menu visibility 與直接輸入 URL 的 guard behavior 一致；iframe/report URL/query parameter/popup/download behavior 一致。

**LocalVisualReview 可驗（3）：** route 初始畫面；mock login/session/captcha/antiforgery；fixture-backed table/form/iframe。**不可宣告 parity（5）：** live WCF/REST；report server；production proxy/TLS/cookie；real certificate/key；browser download parity。Mock 標出覆蓋/未覆蓋；不得在 frontend service 改寫 same-origin `/api`。
**PR Evidence：** route checklist；測試指令與結果；LocalVisualReview / browser smoke 證據；未覆蓋且需 SIT/UAT 項目。
### Deployment Contract Inventory

（第一個 migration PR 前完成；contract 不是 implementation detail；任一層變更可能造成 regression；local smoke ≠ integration parity）

| 層 | 必盤點項目 |
|---|---|
| L1 Razor / Static | Razor entry；JS/CSS entry；`.securejs`；MIME；cache-busting；legacy fallback |
| L2 Build / Publish | build cmd；publish 必須/不得存在的檔案；post-process；source map/lazy chunk |
| L3 Docker | build cmd；runtime image；expose port；ASP.NET Core env；DataProtection key ring；volume/mount |
| L4 Proxy / Session | public path；upstream；forwarded headers；cookie domain；Secure/SameSite/HttpOnly；antiforgery；XSRF |
| L5 External Deps | WCF/REST；report server；certificate/key；upload/download/template path；OS-specific asset |
| L6 CI/CD | build/test/publish gate 順序與失敗策略；secret injection；environment matrix；runner contract；rollback path |

**Evidence Gate（每層需標示）：** unit/static assertion；local smoke（ASP.NET Core/Docker/proxy）；LocalVisualReview；integration environment（SIT/UAT）；production evidence。

### Program Issue / Phase Tracking

tracker medium 依 `program-tracker-mode.md` Program Tracker Mode（由 `openspec-flow-consumer.md` 按需載入）；local-md 下 Program issue→`program.md`、sub-issue→dashboard row。本節僅補 migration-specific 欄位。
**Migration-specific 欄位：** 交付語言；branch strategy；retrospective/下次前置限制；驗證索引（SIT/UAT、LocalVisualReview、integration test）。**Program base branch：** multi-phase platform migration 第一個 PR 前建立長期 in-progress canonical branch（例：`feature/<program-name>`）；phase branch 從它切出並 PR 回它，未完成 migration state 不得直壓 `main` 或綁住 BAU release。**Dashboard：** Phase；Sub-issue；PR；OpenSpec path；Status；Risk；Completion summary；Blocked-by（local-md）。**Sub-issue：** 階段範圍；非目標；交付內容；驗證；決策限制；PR/commit/archive path。
**更新時機（4）：** 第一個 PR/phase branch 前確認 parent、Program base、sub-issue；PR 前更新 phase row/sub-issue/PR body 互連；merge 後回填 commit/archive/驗證摘要/剩餘風險；收尾前關閉或 defer open risk。
**禁止（4）：** comment-only phase completion；local smoke 當 production readiness；無 sub-issue/phase row 啟動多階段 PR；phase PR 混入 cleanup/warning fix/UI redesign/package。

## Exit Criteria

- Compatibility Contract、Program base branch、Phase Gate 4 題已在第一個 phase 前界定。
- Migration-blocking warning 已修並附驗證證據；保留的 warning 已記錄理由。
- UI Parity Checklist 每個 route slice 完成，LocalVisualReview 邊界未宣告為 integration parity。
- 6 層 Deployment Contract Inventory 完成，每層標示 Evidence Gate。
- Program issue + phase dashboard 建立，phase PR merge 後已回填驗證摘要與剩餘風險。
- 無 migration PR 混入不可變項以外的 behavior 變更（若有：已另開 change 且獲使用者確認）。

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「順手修 warning 只是改命名，不影響行為」 | warning 常連帶改 null/async flow；須符合 4 條件 |
| 「template 簡化讓程式碼更乾淨」 | 可能改 disabled state/錯誤訊息；需另開 change |
| 「LocalVisualReview 已跑過，parity 完成」 | 不可宣告 integration parity；live upstream/proxy 未驗 |
| 「Docker 只是換 runtime，不影響行為」 | DataProtection/cookie domain/TLS 均為 deployment contract |
| 「Program tracking 等 PR 後再補」 | parent/Program base/sub-issue/phase row 必須在第一個 PR 前存在 |
| 「phase 直接從 main 切比較單純」 | multi-phase migration 要用 Program base branch 隔離未完成狀態與 BAU release |
| 「local smoke 跑過了，可直接上 SIT」 | local smoke ≠ integration environment（Evidence Gate 不同層）|
| 「framework 換版時 UI 調整是不可避免的」 | UI 調整屬 behavior delta；須另開 change 並獲確認 |
| 「Security warning 很嚴重，應馬上在 migration PR 修」 | 須另開 phase；混入可能掩蓋 regression |

## Verification

```bash
# H3 章節標題（預期：5）
grep -cE '^### (Migration Invariants|Warning Fix Policy|UI Parity Checklist|Deployment Contract Inventory|Program Issue)' \
  <path/to/.devpro/agent-rules/platform-migration.md>
# PII / 絕對路徑（預期：0）；cross-ref leaf（預期：各 ≥ 1 hit）
grep -cE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|/Users/[a-z]' <path/to/.devpro/agent-rules/platform-migration.md>
grep -E 'openspec-flow|openspec-flow-consumer|chore-classification|code-simplification|preflight-checklist|token-budget-precheck|ci-cd-integration-deployment' \
  <path/to/.devpro/agent-rules/platform-migration.md>
```

## Cross-References

- `openspec-flow.md` — OpenSpec flow
- `openspec-flow-consumer.md` — Program Issue SSOT（issue-first、sub-issue、PR 連結）
- `chore-classification.md` — migration change 屬 chore B
- `code-simplification.md` — 禁止以「簡化」為由合併 behavior delta
- `preflight-checklist.md` — 動工前 pre-flight
- `token-budget-precheck.md` — leaf token cap
- `ci-cd-integration-deployment.md` — L6 CI/CD 詳細規範
