---
name: ai-autonomy-root-cause
description: Root-Cause First 原則——修問題前必先 articulate root cause，禁 surface fix；3 個 anti-pattern + 反駁。觸發：修 bug / 改 hook·gate·規則 phrase / debug 前。
---

# Root-Cause First

> Load-chain：本檔由 `ai-autonomy.md` 按需載入；entry leaf 只保留行為邊界與十句自檢，root-cause 判準與 anti-pattern 在此。

### Root-Cause First（禁止 surface fix）

**規則**：修問題前必先 articulate root cause；若 root cause 未明，**禁止**動 enforcement 路徑（hook / gate / 規則 phrase）。Diagnostic-first（先加 logging / test 取 evidence）優先於 fix-first。

**適用範圍（無例外）**：
- source repo 與 consumer repo 皆遵守
- 規範變更（`.devpro/agent-rules/*.md`）與程式變更（`*.mjs` / `*.cs` etc.）皆遵守

**3 個 anti-pattern（任一觸發即視為 surface fix）**：

| Anti-pattern | 描述 | 反證做法 |
|---|---|---|
| **挖東牆補西牆** | 修 A 處 phrase / 條件不檢查同類問題的 framework 完整性（whack-a-mole） | 列出「同類問題還有哪些 case 會犯」，一併修 |
| **改 A 壞 B** | 修 A 不檢查改動對 B 的影響（regression） | 反向 reasoning：列「這個改可能影響的其他點」+ regression test 覆蓋 |
| **Symptom-driven fix** | 看到 symptom 直接動 enforcement（hook / regex / gate）不查 root cause 在哪一層 | Diagnostic infra 先（logging / instrumentation），等 evidence 再決定修哪層 |

**Common Rationalizations（AI 的藉口）**：

| 藉口 | 反駁 |
|---|---|
| 「這次只擋這個 case 就好，下次有再說」 | whack-a-mole；framework gap 不修 → 同類問題會 silent recur，每次成本 ≥ 一次性根因修正 |
| 「root cause 不確定但先擋著比較安全」 | enforcement 鎖錯層 → 後續修需 revert + redo；diagnostic infra 先取 evidence 風險低 100x |
| 「補 A 段範例反正不影響 B 段」 | SSOT 範例本身就是規則，A 範例不 dogfood 新規則 = AI 照抄 A 自繞過 B（PR #423 evidence） |

**驗證**：dp-reviewer 軸 1 sub-check「Root-cause adequacy」會驗本 PR 是否 articulate root cause；surface fix 標 Important，scope 顯著時升 Critical。
