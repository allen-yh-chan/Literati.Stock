## 必填

- **OpenSpec change 路徑**：`openspec/changes/<name>/`
- **tasks.md 狀態**：全部勾選完成 ✓ / 部分未完成（說明）
- **測試證據**：`dotnet test` 全綠（附執行摘要或截圖）
- **QA 文件**：`openspec/changes/<name>/qa-test-scope.md`
- **OpenSpec archive**：已在本 PR 分支完成 ✓

## 條件式欄位（適用時必須填寫，不適用則刪除該區塊）

### 新增或升級第三方套件

| 套件名稱 | 版本 | SPDX 授權 |
|---------|------|----------|
|         |      |          |

### DB Schema 變更

- **Migration 檔案路徑**：
- **Rollback 可行性**：可 rollback / 不可逆（說明原因）

### Release 線或 Production 修復

- **影響範圍**：
- **受影響環境**：DEV / SIT / UAT / PAT / PROD
- **Rollback 計畫**：

## Review Summary

- **Critical**：0 件
- **Important**：0 件
- **Suggestion**：0 件
- **已檢查**：SQL injection ✓ | PII ✓ | 授權 ✓（或 N/A）
