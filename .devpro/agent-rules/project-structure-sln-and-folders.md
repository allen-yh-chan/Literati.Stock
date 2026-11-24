---
name: project-structure-sln-and-folders
description: .NET 專案目錄結構規範：.sln 放置、src/ 分層、測試專案獨立目錄、範本 A/B 擇一。觸發：新建或重組 .NET 專案時。
---

# 專案目錄結構（sln + 獨立子目錄）

## Overview

本檔是 .NET 解決方案目錄結構的**權威規範**，定義 `.sln` 放置位置、每個 `.csproj` 必須獨立子目錄、範本 A（單一主專案）與範本 B（多模組 + `src/`）的結構規則，以及測試專案的擺放原則。

## When to Use

- 新建 .NET 專案或 solution 時
- 在既有 repo 新增 `.csproj`（主專案、測試專案、工具專案）時
- Review PR 涉及目錄結構或 `.sln` 變更時

**不觸發**：純程式碼修改不涉及目錄結構或 `.csproj` 新增。

## Rules

### 強制規則

1. 任何新建專案**必須**建立 solution 檔（repo 根層單一 `.sln`，檔名依團隊慣例）。
2. 每個 `.csproj` **必須**放在**獨立子目錄**內，不得多個 `.csproj` 共用同一資料夾。
3. 不得把多個 `.csproj` 混放在 repo 根層。
4. 測試專案一律**獨立 `.csproj` + 獨立目錄**，不得併入主專案目錄。
5. 新增任何 `.csproj` **必須**加入 `.sln`。
6. 同一 repo 內固定選擇範本 A 或範本 B，禁止混用兩種根層風格。
7. 跨檔案 / 跨 project 之 ownership 邊界決策**不得**以部署便利性（nginx mount / CI 已設好 / reuse 既有目錄）為依據；正確 domain 邊界優先（見 `anti-patterns-behavioral.md` §13 Convenience-Driven Boundary Placement）。

### 範本 A（單一主專案）

repo 根層放 `.sln`，主專案與測試專案各自一個目錄：

```text
repo-root/
  <ProjectName>.sln
  <ProjectName>/
    <ProjectName>.csproj
    Program.cs
  <ProjectName>.Tests/
    <ProjectName>.Tests.csproj
    UnitTest1.cs
```

### 範本 B（多模組 + src/）

solution 含多個可建置專案時，採 `src/`（與選用的 `tests/`）集中：

```text
repo-root/
  <SolutionName>.sln
  src/
    <ModuleA>/
      <ModuleA>.csproj
    <ModuleB>/
      <ModuleB>.csproj
  tests/
    <ModuleA>.Tests/
      <ModuleA>.Tests.csproj
    <ModuleB>.Tests/
      <ModuleB>.Tests.csproj
```

- repo 根層**只放** `.sln`；禁止在根層放多個 `.csproj` 或與 `src/` 並列堆疊多個模組目錄。
- 每個應用程式或類別庫一個目錄：`src/<ModuleName>/<ModuleName>.csproj`。
- 測試專案：`tests/<ModuleName>.Tests/<ModuleName>.Tests.csproj`。
- 工具/整合測試專案：`src/<ToolName>/` 或 `tests/<Name>.Tests/`，依性質選擇，一目錄一 `.csproj`。

## Examples

範本 A 與範本 B 的目錄範例已列於 Rules 段。選定範本後禁止在同一 repo 混用。

## Exit Criteria

- `.sln` 放在 repo root
- 每個 `.csproj` 在自己獨立子目錄
- 測試專案符合 `<ProjName>.Tests/` 命名
- 新建專案已將 `.csproj` 加入 `.sln`

## Verification
- `find repo-root -name "*.csproj"` 每個結果的 parent dir 應唯一（不共用目錄）
- `dotnet sln list` 列出所有 `.csproj`，數量應與 `find` 結果一致（無遺漏加入 `.sln` 的專案）
- 測試專案目錄不在任何 `src/<Module>/` 下
