---
name: csharp-style-and-dry
description: C# 程式碼風格與 DRY 原則的權威規範：K&R 大括號、DRY 抽取、現代語法選用、nullable、XML doc、Build 版本注入。觸發：寫或改任何 C# 程式碼時。
---

# 程式碼風格：K&R / DRY / C# 現代語法

## Overview

本檔是 C# 程式碼風格與 DRY 原則的**權威來源**，涵蓋大括號風格、重複邏輯抽取、現代語法偏好、var 使用判準、XML 文件規範，以及 Build 版本注入規格。所有 C# 程式碼異動皆須符合本規範。

## When to Use

- 寫新 C# 程式碼時（任何 `.cs` 檔）
- 修改既有 C# 程式碼時（bug fix、重構、功能新增）
- Review C# PR 時，確認風格合規
- `.csproj` 變更涉及 XML doc 或 Build 版本設定時

**不觸發**：Python / YAML / TypeScript 等非 C# 檔案（各語言維持自身慣例）。

## Rules

### K&R 大括號（強制）

採 **K&R / 1TBS**：開頭 `{` 寫在敘述同一行結尾，`else` / `catch` / `finally` 接在前一個 `}` 之後同一行。適用 C# / Java / JavaScript / TypeScript / C / C++；Python / YAML 等無大括號語言維持該語言慣例。新增程式碼**不得**引入 Allman 大括號風格。

### 避免重複（DRY）

- **禁止**以複製貼上累積相同或近乎相同的邏輯；第二處開始就應評估抽取。語言無關 corpus-scope DRY／SSOT 見 `dry-ssot-corpus.md`；本檔不另立第二套 corpus 準則。
- 可共用行為改為共用方法、小類別、靜態輔助、extension、或獨立模組。
- 抽取以**可測試、可讀**為準：過度抽象或難讀時，寧可保留局部重複並在 review 中討論。

### 現代語法（優先使用，非強制逐條）

以 `.csproj` 的 `TargetFramework` / `LangVersion` 為準；在**可讀性不變差**的前提下偏向簡短：primary constructor、collection expressions、`required` / init、pattern matching、`switch` expression、target-typed `new`、`using` declaration、file-scoped namespace、null 條件與模式。**不為炫技壓成單行**；團隊能一眼看懂優先。

### `var` vs 顯式型別（啟發式）

判準：**讀者能否從 RHS 一眼看出型別**。

| 情境 | 偏好 |
|---|---|
| RHS 為 `new SomeType(...)` | `var` |
| target-typed `new()` | **顯式**（如 `SomeType value = new();`） |
| RHS 為已知型別的 property/method，名稱明確 | `var` |
| LINQ chain | `var` |
| RHS 為自訂方法回傳值，從名稱看不出型別 | **顯式** |
| primitive literal | **顯式**（避免型別悄悄漂移） |
| 接下來要做 `is` / pattern matching 的起手 | **顯式** |

**禁止**在 feature / bugfix PR 內順手把 `var` 改顯式（或反之）當 drive-by refactor。

### XML 文件與註解

- `///` XML doc 與 `//` 行內說明以**正體中文**為主；可保留英文：識別子、業界技術縮寫（HTTP / JWT）、須與上游契約逐字一致的字串。
- 會對外提供契約或產生 API 說明的可建置專案（函式庫、Web API、對外 NuGet 來源）**必須**在 `.csproj` 啟用 `<GenerateDocumentationFile>true</GenerateDocumentationFile>`。
- 上述專案所有 `public` 型別與成員**必須**撰寫有意義的 `/// <summary>`；非自明的參數/回傳值/例外補 `<param>` / `<returns>` / `<exception>`。
- **禁止**空白 summary、僅重複識別子名稱、或保留已淘汰邏輯的大段註解。

### Build 版本注入（強制）

所有專案在 `.csproj` build/publish 流程注入 `InformationalVersion`，規格：
- 關閉 SDK 內建 `AssemblyInformationalVersionAttribute` 自動產生。
- MSBuild `Target` 取 `GitCommitSha`（`git rev-parse --short=10 HEAD`，固定 10 碼）。
- 使用 `Exec ConsoleToMsbuild="true"`，輸出格式 `GitCommitSha=<shortSha>`。
- fallback：git 失敗時 `GitCommitSha` 維持 `unknown`，避免 build 因環境缺 git 而失敗。
- 最終格式：`InformationalVersion = $(Version)+$(GitCommitSha)`。
- 啟用 `ContinuousIntegrationBuild=true` 與 `Deterministic=true`，確保 binary 內容可重現。

## Examples

### K&R vs Allman

```csharp
// ✅ K&R（本專案）
public void Run() {
    if (condition) {
        DoWork();
    } else {
        Cancel();
    }
}

// ❌ Allman（本專案避免）
public void Run()
{
    if (condition)
    {
        DoWork();
    }
}
```

### DRY 抽取

```csharp
// ❌ 重複邏輯
var taxA = orderA.Amount * 0.1m;
var taxB = orderB.Amount * 0.1m;

// ✅ 抽取
static decimal CalcTax(decimal amount) => amount * 0.1m;
var taxA = CalcTax(orderA.Amount);
var taxB = CalcTax(orderB.Amount);
```

## Exit Criteria

- 所有新寫 C# 符合 K&R 大括號風格
- 重複邏輯已抽取或利用現有共用方法
- `var` 使用符合決策表判斷標準
- nullable 處理不使用 `!` 強制轉型

## Verification
- PR diff 中無 Allman 大括號新增
- 新增 `public` API 皆有 `/// <summary>`
- 有對外契約的 `.csproj` 含 `<GenerateDocumentationFile>true</GenerateDocumentationFile>`
- `dotnet publish` 後 `AssemblyInformationalVersion` 格式為 `{Version}+{10碼SHA}` 或 `{Version}+unknown`
