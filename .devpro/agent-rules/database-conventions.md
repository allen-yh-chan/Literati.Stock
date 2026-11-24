---
name: database-conventions
description: DB-first 規則：禁止 EF Core Migrations，所有 DDL 由 DBA 執行；SQL script 產出要求、存放位置、rollback 區段、依程式使用建 index 之要求。觸發：實作涉及 DB schema 新增、修改、刪除（含新建 table 之 index 設計）時；以及使用 SQL Server 對字串做加密/壓縮/雜湊/binary roundtrip（`ENCRYPTBYPASSPHRASE`/`COMPRESS`/`HASHBYTES`、`VARBINARY`↔`NVARCHAR` 互轉）需明確定義文字編碼時。
---

# 資料庫慣例：DB-first + SQL Script 交付

## Overview

程式對資料庫的執行權限有限（僅 DML：SELECT / INSERT / UPDATE / DELETE），**所有 DDL 變更由 DBA 執行**。EF Core 當作 ORM 使用（query + persistence），不管 schema lifecycle。Model / DbContext 更新方式：DBA 執行 SQL script 變更 schema → 手動更新 C# entity class 與 `OnModelCreating`。

## When to Use

- DynamicForms consumer vendor bump／DLL 升級／SQL schema error：先讀 `dynamic-forms-consumer-sql-alignment.md`，再交付 SQL 前置條件。
- 實作涉及資料庫 schema 新增、修改、刪除（table、column、index、constraint、stored procedure、view 等）
- OpenSpec change 的 touch list 包含資料庫相關變更
- 使用 SQL Server `ENCRYPTBYPASSPHRASE`/`DECRYPTBYPASSPHRASE`、`COMPRESS`/`DECOMPRESS`、`HASHBYTES`，或 `VARBINARY(MAX)` ↔ `NVARCHAR(MAX)` 互轉、或需 SQL 端直接 select / `JSON_QUERY` 明文字串的加解密資料時（涉及 C# payload bytes 與 SQL 字串編碼對齊，見下方「SQL Server 字串 ↔ Binary 轉換編碼」段）

## Process

### 禁止事項

| 禁止 | 原因 |
|---|---|
| `dotnet ef migrations add` / `dotnet ef database update` | 程式無 DDL 權限 |
| `DbContext.Database.Migrate()` / `Database.EnsureCreated()` | 同上 |
| `Data/Migrations/` 目錄 | 不使用 EF Core Migrations |
| 程式碼內嵌 DDL（`CREATE`/`ALTER`/`DROP`）| DDL 只在 SQL script 中，由 DBA 執行 |

### SQL Script 產出要求

每個涉及 DB schema 變更的 task，**必須**產出對應的 SQL script：

- **存放位置**：`sql/<change-name>/`（與 `openspec/changes/<change-name>/` 對應）。`<change-name>` = OpenSpec change 邏輯名（同 `openspec/changes/<change-name>/` basename；archive 時去掉日期前綴），**≠** 完整 git branch（禁把 `feature/<change-name>`／`bugfix/...`／`hotfix/...`／`chore/...` 整段當目錄鍵）
- **禁止 branch-type nest**：MUST NOT 在 `sql/` 下巢狀 `feature/`／`bugfix/`／`hotfix/`／`chore/`（禁例：`sql/feature/<change-name>/`）
- **reuse／碰撞**：因 `sql/` 於 archive 後持續保留，MUST NOT 對**新** change 復用既有 `sql/<name>/`；同 change continuum 才可追加 `<序號>_<描述>.sql`；新語意 → 新 unique change-name（因而新 `sql/<change-name>/`）
- **命名規則**：`<序號>_<描述>.sql`（例：`01_create_audit_log_table.sql`）
- **每個 script 須包含**：檔頭註解（用途、相依 script、預期影響的 table）、Forward DDL、Rollback DDL（`-- [ROLLBACK]` 區段標記，供 DBA 手動執行）
- **冪等設計**（建議）：使用 `IF NOT EXISTS` / `IF EXISTS`，避免重複執行報錯

### Index 設計要求

新建 table、或本次 change 讓程式對既有 table 新增查詢路徑時，SQL script **必須**依程式實際查詢建立對應 index，禁止只交付 PK。

- **必建範圍**：程式 `where`／`join`／`order by` 述詞欄位（多欄查詢用複合 index，欄位順序：等值（=）述詞欄位在前，其次為 range 述詞／order by 欄位；同類欄位之間再依選擇性排序——等值欄位放前段可讓 range/排序欄位維持 seek，若依選擇性排列導致高選擇性 range 欄位排在等值欄位前，會使 seek 退化）；以及 **FK 欄位**——SQL Server 建 FK 約束時只要求**被參照端**（通常是 parent 的 PK）已有既存 unique/PK index，本身不為被參照端額外建 index；對**參照端**（child table 的 FK 欄位本身）則完全不建 index。FK 欄位的使用點不需程式明確查詢即成立：parent table 刪除一列、或更新被參照欄位值時，SQL Server 必須檢查 child table 有無列參照它，缺 index 即對 child table 全表掃描，此為 FK 約束存在本身隱含的效能需求。
- **可追溯**：每個 index 對應的程式使用點**必須**寫在 script 檔頭註解或 PR 描述其中之一（例：`-- IX_AuditLog_UserId_Timestamp ← AuditLogRepository.GetByUserAndRange`；FK 欄位可註明所屬約束，例：`-- IX_Orders_CustomerId ← FK_Orders_Customers cascade check`），供 reviewer 核對。
- **禁預防性 index**：本次 change 找不到可指認使用點者禁止建立（見 `pre-implementation-over-design.md` 過度設計原則）；日後有實際使用情境再由該次 change 補建。FK 欄位依上述理由視為已有使用點，不落入本條禁列。**本條僅管查詢效能導向 index；unique index 等執行 business invariant 的 correctness-bearing index 不受此限**（FK 支援 index 本身是效能考量，非正確性機制——FK 約束的正確性不依賴參照端是否有 index，只依賴被參照端的既有 unique/PK index）。
- **無需 index 時**：純寫入或僅按 PK 單筆存取，**必須**在 PR 描述一句交代盤點結論與原因，不得沉默略過。
- 既有 table 新增查詢路徑時同規則適用，於同一 change 產 `<序號>_add_index_<描述>.sql`（含 `-- [ROLLBACK]` 區段）。本條為作者義務，`code-review-checklist.md` 軸 1 的 reviewer sub-check 僅在 PR 同時觸及 `sql/**` 時觸發（只改 query code、未改 sql script 的 PR 無 reviewer 機械把關，作者仍須自律盤點）。

### SQL 關鍵字大小寫慣例

SQL script 與 fenced SQL 範例中的關鍵字（clause 如 `select`/`from`/`where`、資料型別如 `bigint`/`nvarchar`/`datetime2`、內建函式、`null`/`not null` 等保留字）**必須**全部小寫；系統變數/函式（`@@` 開頭，如 `@@ROWCOUNT`）**必須**保持全大寫。Table/column/constraint 等識別字（identifier）大小寫依現有命名規則，不受本慣例影響。本慣例同樣適用於 C# 等 host language 字串常數內嵌的 SQL（例如 `security-coding.md` 的 parameterized query 範例）。（本慣例為使用者明確指定；SSMS/T-SQL 傳統慣例多為關鍵字全大寫，本 repo 刻意採相反慣例，非工具預設。）

> 用法範例：`select @@ROWCOUNT as affected` — clause 小寫，`@@ROWCOUNT` 大寫。

> SQL 關鍵字（含 clause、型別、函式）在 prose 說明文字中提及時（例如下方「編碼語意對照」表格的 `NVARCHAR`、`CONVERT`、`HASHBYTES`，或本節上方「冪等設計」提到的 `IF NOT EXISTS`/`IF EXISTS`）不受本慣例約束，維持原有大小寫；本慣例只管 SQL script 檔案、fenced SQL 範例，以及 host language 字串常數內嵌的 SQL。

### SQL Script 範例

```sql
-- 用途：建立 AuditLog 資料表
-- 相依：無
-- 影響：新增 dbo.AuditLog table

if not exists (select * from sys.tables where name = 'AuditLog')
begin
    create table dbo.AuditLog (
        Id          bigint identity(1,1) not null,
        Timestamp   datetime2(7)         not null,
        UserId      nvarchar(128)        null,
        Action      nvarchar(256)        not null,
        constraint PK_AuditLog primary key clustered (Id)
    );
    create index IX_AuditLog_Timestamp on dbo.AuditLog (Timestamp);
end;

-- [ROLLBACK]
-- drop index if exists IX_AuditLog_Timestamp on dbo.AuditLog;
-- drop table if exists dbo.AuditLog;
```

### SQL Server 字串 ↔ Binary 轉換編碼

使用 SQL Server 對字串做加密、壓縮、雜湊、binary roundtrip 或 JSON 投影時，**必須明確定義文字編碼**，**禁止**假設 SQL 會自動以 UTF-8 解讀 bytes。

#### 編碼語意對照

| 端 | 機制 | 編碼語意 |
|---|---|---|
| SQL Server | `NVARCHAR` / `CONVERT(NVARCHAR(MAX), varbinary)` | **UTF-16LE** |
| SQL Server | `VARCHAR` / `CONVERT(VARCHAR(MAX), varbinary)` | code page（依 collation，非 Unicode）|
| .NET (C#) | `Encoding.Unicode` | **UTF-16LE** |
| .NET (C#) | `Encoding.UTF8` | UTF-8 |

> SQL Server 的 `NVARCHAR` 一律是 UTF-16LE（與 collation 無關）；`VARCHAR` 才依 collation code page。`.NET Encoding.Unicode` 就是 UTF-16LE（命名易誤會：`Encoding.Unicode` ≠ UTF-8）。

#### 判斷規則

- 若 SQL 端會用 `NVARCHAR` / `CONVERT(NVARCHAR(MAX), varbinary)` 直接還原字串 → C# 端 payload bytes **必須**使用 `Encoding.Unicode`（UTF-16LE）。
- 若 C# 端維持 `Encoding.UTF8` payload → SQL 端**必須**有明確的 UTF-8 decode 路徑（`CONVERT(NVARCHAR(MAX), varbinary)` 不可用於 UTF-8 bytes，因 `NVARCHAR` 一律以 UTF-16LE 解讀；SQL Server 2019+ 可改用帶 `_UTF8` collation 的 `VARCHAR` 路徑），**禁止** `Encoding.UTF8` payload 直接 `CONVERT(NVARCHAR(MAX), varbinary)`。
- **失敗症狀**：`DECOMPRESS(DECRYPTBYPASSPHRASE(...))` 能還原 bytes，但 `CONVERT(NVARCHAR(MAX), @plainBytes)` 把 UTF-8 bytes 誤當 UTF-16LE → **中文必亂碼**；ASCII-only 測試可能因 SQL 端走了其他 decode 路徑或長度湊巧而未暴露問題，**故「英文 render 正常」不代表編碼正確** → 形成「加解密成功、解壓成功，但中文解不出來」的假象（issue #853 evidence：consumer `Devpro.MvcCore.Performa360` commit `4c3e3d0d` UTF-8 payload → `7334d09e` 改 UTF-16LE）。

#### Migration direction 命名

需同時支援新舊格式時，讀取端**必須**明確做格式/編碼 fallback，且 **migration direction 命名清楚**（例：`old-utf8-to-new-utf16` vs `new-to-new`），**禁止**把「外層格式轉換（如加上 SQL 相容外殼）」與「同格式 payload 重寫（如改內部文字編碼）」混在同一次變更而不分方向。

#### 測試要求

測試**必須**包含**中文 roundtrip**（不可只用 ASCII / 英文），且至少驗證雙向：

1. C# encrypt → SQL `DECRYPTBYPASSPHRASE` / `DECOMPRESS` / `CONVERT(NVARCHAR(MAX), ...)` 還原，中文正確。
2. SQL `ENCRYPTBYPASSPHRASE` → C# decrypt，中文正確。

### 專案結構

```
<repo-root>/
├── sql/
│   └── <change-name>/
│       ├── 01_create_xxx.sql
│       └── 02_add_index_xxx.sql
└── openspec/changes/<change-name>/
```

`sql/` 目錄在 PR merge 後持續保留（不隨 OpenSpec archive 清除），作為 schema 變更的歷史記錄。結構圖中的 `<change-name>` 同上＝OpenSpec 邏輯名（≠ branch）；禁 `sql/feature/...` 等 nest；reuse 規則見上方「存放位置」。

## Exit Criteria

- `sql/<change-name>/` 包含對應 SQL script（命名符合 `<序號>_<描述>.sql`；路徑無 `sql/feature/` 等 branch-type nest）
- 每個 script 含 `-- [ROLLBACK]` 區段
- PR 描述列出 SQL scripts 清單與執行順序
- `tasks.md` 涉及 DB 變更的 task 驗收條件包含「SQL script 已產出且含 rollback 區段」
- 涉及新 table 或新增查詢路徑之 change，index 盤點已記錄（index ↔ 程式使用點對應，或「無需 index」＋原因）

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「英文測得過就沒問題」 | SQL `NVARCHAR` = UTF-16LE；`Encoding.UTF8` payload 的英文/符號剛好可讀，中文必亂碼。測試**必須**含中文 roundtrip，不可只用 ASCII。 |

## Verification

```
# SQL script 存在且命名正確
ls sql/<change-name>/

# rollback 區段存在
grep -l "\-\- \[ROLLBACK\]" sql/<change-name>/*.sql

# 確認無 EF Migrations 產出
ls src/*/Data/Migrations/ 2>/dev/null && echo "VIOLATION" || echo "OK"
```
