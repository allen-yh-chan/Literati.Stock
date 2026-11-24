---
name: pr-review-evidence-verification
description: PR review 驗證 evidence 規則：contributor 對 review 留言聲明「phrase 已存在 / contract 保留」要視為 hypothesis，必先 fetch + git show 對遠端 ref 機械驗證；reviewer finding 宣稱的觸發條件／可達路徑同樣是 hypothesis，轉述、定嚴重度或開修正分支前先驗證；並含 cross-model second reviewer 的 evidence reuse（不重跑 primary 已綠 tests）與 External Evaluator 入口（細節在 `second-review-external-evaluator.md`）。觸發：審 AI 工具 / 人類 contributor 開的 PR、處理 review thread 回覆、轉述 reviewer（含跨模型第二意見）finding 的觸發條件、收到 contributor 聲明本機未 push 之改動、cross-model second reviewer 撞 timeout / UNAVAILABLE。
---

# PR Review Evidence Verification

## Overview

審 PR（特別是 AI 工具開的 PR）時，contributor 在 review thread 回覆「X phrase 已在最新 head / contract 保留 / 對應段落沒動」要視為 **hypothesis**，不是事實。必先機械驗證遠端 ref 後再做結論——本機印象、本機 grep、未 push 的工作目錄、聲明文字都不算 evidence。

## When to Use

- 審 PR 時 contributor 在 review thread 聲明「phrase 已存在 / 段落保留 / contract 沒動」
- contributor 主張之前 round 的 finding 已修，要求 refresh re-review
- contributor 工具（AI 編輯器、IDE assistant 等）回覆中宣稱對著「最新 head」grep 過
- 跨機器/跨 worktree 的 desync 風險場景
- 轉述 reviewer（含跨模型第二意見、subagent）finding 的觸發條件，或據以定嚴重度、開修正分支（見 §Reviewer Finding 的觸發條件）
- 不觸發：純看 diff、初版 review、契約變更討論（非 evidence claim）

## Process

1. **fetch 遠端 ref**：`git fetch origin <branch>` 取得最新 remote head SHA。
2. **取 head SHA**：`gh pr view <N> --json headRefOid --jq '.headRefOid'` 或 `git rev-parse origin/<branch>`。
3. **對遠端 ref 機械 grep**：`git show <sha>:<path> | grep -n <phrase>`。`git show <sha>:<path>` 直接讀 remote ref，不依賴本機 worktree。
4. **比對 contributor 聲明與機械 evidence**：
   - 一致 → 結案，回覆確認。
   - **不一致** → contributor 聲明錯誤（hallucination 或 stale worktree）。在 reply 附**完整重現命令**（含可貼可跑的 shell 區塊）+ 你的輸出，請對方對著相同命令跑一次比對。
5. **不軟化結論**：機械 evidence 比印象優先。錯就是錯，phrase drop 該補就要補；不要為了「給 contributor 面子」軟化結論。
6. **若 contributor 工具未 push**：先要對方確認 `git log origin/<branch>..HEAD` 是否非空，再決定是 contributor desync 還是真實 drop。

## Reviewer Finding 的觸發條件

reviewer（含跨模型第二意見、subagent）在 finding 裡說「在某條件下會觸發」或「從某路徑走得到」時，這個觸發條件與可達路徑同樣是 **hypothesis**，與上方 contributor 聲明同一原則。

1. **先驗證再用**：TL 把 finding 轉述給使用者、據以定嚴重度、或據以開修正分支之前，MUST 先驗證觸發條件：從觸發點往上追實際 caller 直到入口，或實際重現。
2. **轉述時標明**：MUST 寫 `觸發條件：已驗證（<呼叫路徑或重現指令>）` 或 `觸發條件：未驗證`。
3. **未驗證不拿來決策**：標「未驗證」的 finding MUST NOT 據以定嚴重度或開修正分支；先驗證，或請使用者決定要不要在未驗證下處理。
4. **推翻就改口**：追出來的實際路徑與 reviewer 說法不同時，依實際路徑重定嚴重度，並告訴使用者原說法與差異（例：原說「連線斷掉就洩漏」，追 caller 後只有服務關閉才走得到 → 防禦性補強，不是線上事故）。

## Cross-Model Second Reviewer Evidence Reuse

Cross-model second opinion 的預設機制是 primary host spawn 異家 model 的 reviewer CLI subprocess。兩個 reviewer family 的 packet wrapper 共用 bounded liveness profile：wrapper 每 `60s` sample stdout/stderr delta，`15m` 非 terminal 時記 status checkpoint 並自動續跑，`30m` total hard cap 時 final verify/classify 後自動終止；activity heartbeat / structured progress 優先，stdout 只作 fallback，silence alone 不判 hang，health probe 同看 stderr、child-process lifecycle、final JSON 與 sticky freshness，callback/process close 才是完成訊號。Runtime 有 callback/event 時 TL 不 poll lifecycle；只有無 callback fallback 才可每 `60s` bounded poll，最多 30 次／`30m`。Interactive evaluator 不受 packet wrapper cap 約束。下列兩條規則避免 / 化解 subprocess reviewer 撞 cap 的 false timeout（**本節為 SSOT**；`code-review-cross-model.md` §Cross-Model 第二意見、§Merge Gate Enforcement 為 verdict / gate 判定的對應規則）。

### External Reviewer Execution Surface

`ReviewerSurface=host-outside` / outside execution surface only proves the execution surface (host runner, approved prefix, tool allowlist).

### (主) Second Reviewer 不重跑 primary 已綠 tests

若 second reviewer 重跑 primary 已執行的完整 test suite，review 變 long-running，極易撞 bounded subprocess cap 被誤判 timeout → 寫 `UNAVAILABLE`。

**規則**：primary reviewer 已跑且全綠的 test suite，second reviewer **不需重跑**。Second reviewer MUST 確認 primary 的 test evidence（指令、pass 數、終態），聚焦於**獨立的 code / logic / security 審查**；只有對 primary test evidence 的可信度有具體疑慮（test 未涵蓋 diff、evidence 缺失、結果可疑）時，才 scoped 重跑相關測試。此為避免 bounded subprocess timeout 的**主要**手段——讓 subprocess review 維持 bounded。

> 與本檔主題的銜接：primary 的 test evidence 仍適用上方 §Process 的機械驗證精神——「確認 evidence」指核對 primary 回報的指令 / pass 數 / 終態是否對應 diff，而非無條件採信文字聲明。

### Packet Prompt 測試執行政策（SSOT）

External reviewer packet prompt MUST include literal `## 測試執行政策` section. 該 section MUST 要求 reviewer 核對 `primary validation evidence` / `primary test evidence`，預設不得重跑 `full suite`、`budget gate`、`--changed main`／equivalent `--changed <base>` tier suite、multi-gate insurance rerun 或 broad project tests；`focused sticky-refresh` 只評估 previous sticky/findings、latest delta/range、current head SHA、current gate/test evidence。`--changed main` is not scoped rerun。只有 primary evidence 缺失、互相矛盾、結果可疑，或需要確認具體 finding 時，才可 scoped rerun 直接相關測試，且範圍 MUST 窄於整段 change-scoped suite；sticky/evidence MUST 記錄 scoped rerun 的具體疑慮。此約束面僅 second-reviewer packet／subprocess，不改 TL pre-PR `--changed main` 治理；primary `dp-reviewer` 自身對齊約束見 `code-review-checklist.md` §Primary Reviewer 測試執行政策（兩面不得互相覆蓋）。若 optional verification 被 `permission_denials` 擋下，sticky MUST NOT claim 該檢查已獨立執行。

**PR-stage integration 證據範圍**（範圍定義 SSOT：`test-suite-cadence.md`「PR-stage integration 證據範圍」）：本 PR 新增或修改的 integration tests（含被改 integration-tier sharded body 的 shard-import wrappers）仍須有全綠 primary evidence，缺了照舊可列 finding；其他 integration tests（包括未改 test 的 hook、script、`SKILL.md` 等 carrier 對應的 tests）與 `--tier all` 的證據缺席 **MUST NOT** 列為 finding。reviewer 對某個未改 test 有具體疑慮時，仍可依上段 scoped rerun 並記錄疑慮；缺證據本身不構成 finding。

### External Evaluator（審查單＋收據）

Runner subprocess timeout、目標 family 無 runner recipe、CLI 不可由 runner 呼叫，或大 PR 改選 live review 時，合規 recovery 是 External Evaluator：TL 發行審查單、另一 family 的獨立 session 自己寫回 sticky、TL 驗收收據。發行／驗收／作廢三指令、不合規情形與殘餘風險見 `second-review-external-evaluator.md`；TL 手寫 sticky 或轉貼 web chat 回覆都不合規，且 MUST 先完成 accept 才 merge。

## Exit Criteria

- 對 contributor evidence claim 已跑 `git fetch origin <branch>` + `git show <sha>:<path> | grep <phrase>`
- 機械 evidence 與 contributor 聲明一致 → 結案；不一致 → reply 已附完整重現命令 + 自己輸出
- 結論未因「給面子」軟化；phrase drop 該補就指明該補
- 轉述的 reviewer finding 都已標 `觸發條件：已驗證（…）` 或 `觸發條件：未驗證`；未驗證的沒有被拿來定嚴重度或開修正分支

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「contributor 已聲明 phrase 在，再驗證有點失禮」 | review 對象是 code 不是人；機械 evidence 是唯一語言。失禮的成本 < phrase drop 滲入 main 的成本。 |
| 「我本機 grep 也找到了」 | 本機 worktree 可能是 stale。Source of truth 是 `git show <remote-sha>:<path>`，不是 `cat <path>`。 |
| 「contributor 工具比較新，應該對 head 跑過 grep」 | AI 工具會 hallucinate grep 結果（具體案例見 `platform-adapters/cursor.md` Risk 段）。把對方輸出當事實 = 把 hallucination 當事實。 |
| 「第二意見說了觸發條件，照轉給使用者就好」 | reviewer 只看到 diff 片段，觸發情境常是推測；沒追 caller 就轉述，使用者會在錯的前提上排優先序、開分支。 |
| 「PR 已 approve，不必再驗」 | approve 是 review 結論不是 evidence；contributor 在 review thread 的 follow-up 聲明仍要驗。 |

## Verification

```bash
# 取 PR head SHA
gh pr view <N> --json headRefOid --jq '.headRefOid'

# 對遠端 ref 機械 grep
git fetch origin <branch>
SHA=$(gh pr view <N> --json headRefOid --jq '.headRefOid')
git show $SHA:<path> | grep -n '<phrase>'

# 比對：contributor 聲明 vs 機械 evidence
# 不一致 → 在 review reply 貼完整命令 + 輸出
```

## Cross-Reference

- `dp-reviewer` agent 六軸審查：本檔規範屬「軸 1 功能正確性（root-cause / contract adequacy）」evidence 機械驗證層,輔以「軸 2 可讀性與架構」——重點在驗 evidence claim,與軸 6 Release 影響無涉
- `agents-md-maintenance.md`：本檔屬規則層，AGENTS.md §9 應 link
