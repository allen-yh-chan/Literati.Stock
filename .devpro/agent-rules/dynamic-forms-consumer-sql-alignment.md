---
name: dynamic-forms-consumer-sql-alignment
description: "DynamicForms consumer SQL 前置對齊：vendor bump、DLL 升級或 SQL schema error 時，依 table 盤點跨功能相依並交付 DBA prerequisites。"
---

# DynamicForms Consumer SQL Alignment

## Overview

Forms DLL/HostUi 可能依賴 consumer 漏部署的舊 schema；升級須先對齊實際基線。

## When to Use

- consumer 準備 vendor bump、DynamicForms DLL/HostUi 或入口資產升級時，在交付前讀本檔。
- DynamicForms missing column/table、status CHECK 等 SQL schema error：改 SQL 前讀本檔。
- 排除：不涉及 DynamicForms 的一般 DB 變更仍走 `database-conventions.md`；本流程不授權執行 SQL、升級套件或操作 production。

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `dynamic-forms-consumer-sql-alignment.test.mjs` 防路由／條款消失，不證明 DB 相容性 |
| Advisory | N/A |
| Doctrine | `cooperative-only`：工程師判讀跨 repo/tag 證據，DBA 核准及執行 |

### 1. 以 table 建立前置盤點

- MUST 以受影響的 `schema.table` 搜尋供應端與 consumer 的所有 SQL 目錄，不得只看 Forms 目錄；例如 `sql/add-workflow-foundation/` 也可能修改 `[DynamicForms]`。
- MUST 對照供應端目標 tag 的 EF entities、DbContext mappings 與 consumer 實際已部署 DDL；逐 table 比較 column/type/nullability/default、PK/FK/index、CHECK 定義及啟用／信任狀態，記錄證據來源與未知項。
- MUST NOT 把空的 tag-to-tag SQL diff 當成前置條件已對齊證據；依 table 追查目標 tag 完整 SQL 歷史與相依鏈，再核對 consumer 部署紀錄／DBA 提供的唯讀 metadata。
- 先列缺口／順序再選補法；漏項示例：`ContinueTokenExpiresAtUtc`、`FormIntegrationOutbox`、`Cancelled`，非通用 schema 清單。

### 2. 判斷 Forms / Workflows 邊界

Forms 擁有表單資料與 integration outbox；Workflows 擁有流程、approval/task 狀態，以事件與冪等 resume 整合。Forms outbox／cancel 前置不代表要啟用完整 Workflow；跨功能腳本只取真正依賴，含 FK／其他前置，不盲跑整包。

依目標 tag 核對 Base [ADR-002](https://github.com/devpro-tw/Devpro.MvcCore.Base/blob/main/docs/adr/002-forms-workflow-integration-contract.md) 與 integration guide；source 不複製產品 ADR。

### 3. 交付增量與可驗證證據

- MUST NOT 為升級改寫 consumer 已部署的 consolidated `01` scripts 或要求重跑；保留客戶既有資料，缺口以新的增量修補，不以重建／清表解決。
- MUST 交付 additive、idempotent prerequisite SQL，沿既有交付紀錄留下 provenance／manifest 與 verify：供應 tag/commit、受影響 table、原始相依腳本、consumer 已部署基線、採用／拆分理由、增量腳本順序及驗證結果。沿用 consumer 現有路徑與 manifest 形式，不新增通用客戶版號／目錄硬規定。
- 冪等須驗證既有物件形狀，遇到不相容定義即停止並回報；只判斷「存在就跳過」不足。SQL 檔頭、rollback 與 DDL 交付格式沿 `database-conventions.md`。
- MUST 對 CHECK 的 `Cancelled` 擴充採 explicit transaction：先驗既有資料與預期狀態集合，再移除舊約束並以 `with check` 重建／啟用，確保失敗 rollback；提交前確認 `is_disabled = 0`、`is_not_trusted = 0` 及完整允許集合，提交後 post-verify。不得只新增另一條約束而留下仍拒絕新狀態的舊 CHECK，也不得以永久停用／不信任約束繞過。
- MUST 在此升級包含 HostUi 時核對 DLL、`_content`、入口資產的 cache version／manifest 是否指向同一目標版本；依實際宿主的發布與快取機制驗證，無該資產形態則記 N/A 及證據。
- MUST 維持 DBA-only DDL；工程師交付腳本與驗證步驟，MUST NOT 因此規則自動執行 SQL 或 production 操作。

## Exit Criteria

- table／相依已對照實際基線；未知 prerequisite 未解決前不宣告可升級。
- 增量、來源／採用決策、DBA 順序、rollback 與 verify 可追溯；部署歷史及資料保留。
- CHECK 定義／狀態集合／enabled/trusted、資產版本均驗證，N/A 有證據。

## Common Rationalizations

| 藉口 | 處置 |
|---|---|
| 「沒有 SQL diff」 | 比對 table 與已部署基線，差異缺席不證明完整。 |
| 「Workflow 目錄不用管」 | 按 schema/table 與相依判定。 |

## Verification

工程師安排隔離 DB 驗證基線→增量→重跑、缺相依／形狀不相容時停止、合法新狀態可用／非法狀態被拒、CHECK trusted/enabled 與資料保留；DDL 測試由獲授權 DBA 執行。取得 DBA 回傳 consumer 唯讀 metadata／post-verify 才可關閉缺口。

source 的文字／路由回歸：`node --test .devpro/scripts/tests/dynamic-forms-consumer-sql-alignment.test.mjs`；通過不代表 consumer SQL 已部署。
