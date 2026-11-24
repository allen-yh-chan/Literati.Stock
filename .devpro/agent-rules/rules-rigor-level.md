---
name: rules-rigor-level
description: "三級 rigor 開關（預設 lite）、升 full 的判斷與使用者授權、precedence、4 條底線。觸發：啟動 change、選擇或變更 rigor 時。"
---

# Rules Rigor Level

## Overview

未設定時以 lite 開始工作；full 由使用者明確選擇。開關須同時貫穿 **advisory**（AI 是否載入 OpenSpec/六軸等流程）與 **enforcement**（hook 是否 fire）兩層，只改其一是假開關。4 條底線檢查（3 安全 + 1 compliance）在任何級別都 fire——降的是流程重量，不是安全。

## When to Use

- 工程師做小改、判斷 full-rigor 流程的 token 成本不划算時
- 想讓某 session / consumer repo 預設跑輕量或純 AI 模式時

## Process

### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `.devpro/scripts/hooks/run-hook.mjs`（解析級別 + 底線 gate-id 白名單 + 非底線 no-op）；`sync-agent-rules-e.test.mjs`（守 source 不擁有 reserved consumer basenames：`rules.config`／`AGENTS.local.md`／`pre-pr-checks.local.md`／`second-review-rules.local.md`） |
| Advisory | `session-start.mjs` level-conditional 注入（off→`msgLean`／lite→`msgLite`／full→`msg`） |
| Doctrine | `cooperative-only`：SessionStart 於 lite 宣告豁免為行為 cue（AI 不強制 OpenSpec）；lite/off 下「是否主動跑 OpenSpec/六軸/Recap」仍由 AI 自律，無 hard carrier 強制跳過 OpenSpec |

### 旗標與 precedence

旗標 `DEVPRO_AGENT_RULES_LEVEL`，值 `full | lite | off`，預設 `lite`。解析 precedence（高→低）：

1. 環境變數 `DEVPRO_AGENT_RULES_LEVEL`（per-shell，工程師個人，不留 repo 痕跡）
2. consumer repo `.devpro/rules.config`（consumer 自身 commit）
3. 內建預設 `lite`

**`.devpro/rules.config` 格式契約**：`key=value`（每行一對）；key 名 `agent_rules_level`；未知 key 忽略；重複行採 first-match-wins。設定檔不存在、沒有該 key、空檔或只有註解 → 預設 `lite`；裸值被忽略。明確設定非法值／空值、設定檔存在但無法讀取 → hooks 採 `full` 保護（`source: config, valid: false`）。沒有有效 env override 時，repo root 無法解析或不是目錄 → 同樣採保護（`source: repository, valid: false`）。這些無效來源都不代表使用者已授權 full 流程，AI 必須先處理設定問題。正式 caller 不傳 `cwd` 時按安裝位置找 repo root；測試/API 的 `cwd` 是明確 repo-root override，不是任意子目錄搜尋起點。

### 升 full：判斷與授權

此節為 rigor 升級 SSOT。`A / B-mini / B` 是變更形狀，`full / lite / off` 是流程重量；**B 不自動授權 full**。首次讀需求及 `devpro:change` 在分類／建立 full artifacts／dispatch 前 MUST 先解析目前級別及來源（`resolveRigorSelection`），並套用本節。

1. 未設定從 lite 開始。使用者已明確選擇的 full（有效 env/config 或本 session 的具名指示）可沿用，不重問；新 session 不繼承另一 session 的口頭同意。AI MUST NOT 為了滿足 B 分類而自行改 env/config 為 full。
2. 升級提案 MUST 指出具體 repo 事實、lite 缺少而本次確實需要的產物／獨立判斷，以及新增成本。跨多檔、B 分類、改 hook／rule 或一般回歸測試本身，都不足以作為理由。可用 lite 完成就繼續 lite；真有不能在 lite 完成的必要工作，先完成不依賴升級的工作，再提出具體提案。
3. 從 lite/off 升 full，MUST 在執行 full 流程前取得使用者明確同意；問題依 `stop-point-comms.md` 說明來源與理由、提供保留目前級別／升 full／其他。`Implement the plan`、git/PR batch approval、bounded subagent launch、沉默與超時，MUST NOT 當作 rigor 升級同意；除非被核准的計畫已明列本次升 full 的範圍與原因。
4. 同意後記錄 named change、原級別、目標 full、理由與使用者決定至既有 change evidence（lite 用既有 handoff／session checkpoint；同意後可記入 full startup evidence，不得由 AI 自寫 ledger 倒推授權）；以核准範圍執行。使用者拒絕／未回答時保留原級別；若有必要工作無法完成，精確交棒，不擅自升級。

`evaluateRigorUpgrade` 是可測的判斷檢查：缺理由或缺 user approval 均拒絕，設定錯誤要求先修。它 **不是授權收據**；`userApproved` 只能來自實際使用者指示，不能由 AI 寫入的檔案推定。授權追溯與 AI 流程選擇為 `cooperative-only`；resolver／hook 級別、來源與安全保護由程式測試守住。

### 三級行為矩陣

| 行為 / hook | full | lite | off |
|---|---|---|---|
| 底線檢查（4 條：3 安全 + 1 compliance） | fire | fire | fire |
| `gh-footer-gate`（GitHub 文字 provenance／brand-leak compliance） | fire | fire | fire |
| 測試綠燈要求 | 要 | 要 | 工程師自負 |
| 載入宣告 + cooperative 規範（含 SQL 提醒） | 有 | 有 | 無 |
| advisory/nudge hook | fire | no-op | no-op |
| `stop-handoff-cite`（hard-block） | fire | no-op | no-op |
| `post-pr-completion-check`（hard-block） | fire | fire | 只檢查本 session 在其他 GitHub repo 的已識別未結紀錄 |
| `release-back-merge-check`（hard-block） | fire | fire | 只檢查本 session 已連結到其他 repo 的未結紀錄 |
| OpenSpec / pre-flight / 六軸 / simplify / Recap / multi-agent 委派 | 走 | 免 | 免 |
| 五欄白話卡（需求驅動 change 第一個實作寫入前確認；lite 免 clarify 仍出卡） | 走 | 走 | 免 |
| Consumer Pre-PR Checks（`.devpro/pre-pr-checks.local.md`，consumer 專用；source 不適用；Gate 4c 驗適用性與證據格式並對照豁免紀錄，執行契約見 `consumer-pre-pr-checks.md`） | 走 | 走 | 工程師自負 |
| Pre-PR DEV 驗證（consumer 專用，與該檔是否存在無關；source 不適用；Gate 4c 驗證據行格式並對照豁免紀錄，見 `pre-pr-dev-verification.md`） | 走 | 走 | 工程師自負 |
| `cross-model-sticky-merge-review`（STATE_BACKED） | fire | fire | no-op（skip） |
| `design-cold-read-prewrite`（STATE_BACKED；看 change 形狀：有 proposal＋design.md 才擋，lite 無 proposal 即放行） | fire | fire | no-op（skip） |
| P2 creation-time named-def lookup（`dry-ssot-corpus.md`） | keep | keep | 免 |
| P3 review-time NEW named-def corpus-grep（軸 2） | keep | degrade | 免 |

> P2 lite=keep；P3 lite=degrade（不是 exempt，不是預設 full-only）。lite 免完整六軸時，若 PR 新增具名定義仍做軸 2 此 sub-check（corpus grep + 一行證據）。
>
> lite 不寫 OpenSpec proposal，批次授權載體改為 change 資料夾內一行、不進 git 的 `openspec/changes/<change-name>/lite-scope.md`（與 full 的 `## Batch Approval Ledger` 對稱，綁 change＋branch、無有效期；只在使用者選 batch 後寫，stepwise 不寫，格式與寫入規則見 `/devpro:change` skill lite 段）；`cross-model-sticky-merge-review` 仍 fire，builder 用 `--lite`，不讀 rigor level，見 `code-review-cross-model.md` §Initial handoff builder。lite 只免寫 proposal，不免歸檔：資料夾已有 `proposal.md`／`proposal-mini.md` 即非 lite，pre-PR 仍須 `openspec archive`；只含 `lite-scope.md` 才免。
>
> advisory/nudge hook 指：`commit-soft-nudge` / `recap-check` / `post-merge-check` / `session-pending-cleanup-check` / `user-prompt-gate`。`gh-footer-gate` 屬文字產出的 compliance carrier，任何級別都執行。

### 底線檢查（off 也不可 no-op）

使用者只需理解 4 條底線檢查：

1. **禁直推 main / protected branch** — 安全
2. **禁 PII 入 querystring** — 安全
3. **禁 email / 絕對路徑入 repo** — 安全
4. **禁 AI 工具品牌標記（co-author / generated-by attribution）入 commit／PR／issue 文字，GitHub 文字須保留規定 provenance footer** — compliance，off 仍 fire

維護者實作映射如下；README 不暴露 gate-id，避免把實作細節變成使用者 mental model。

| 使用者底線檢查 | gate-id |
|---|---|
| 禁直推 main / protected branch | `protected-branch-write`、`protected-branch-uncertain-cwd`、`protected-branch-file-write`（只擋保護分支上的本地寫入，不擋 push 目的地；直推見下方註） |
| 禁 PII 入 querystring | `openspec-doc-pii` |
| 禁 email / 絕對路徑入 repo | `openspec-doc-pii` |
| commit／PR／issue attribution 與 provenance compliance | `commit-attribution-brand-leak`（git）；`gh-footer-gate.mjs`（GitHub） |

> **直推 main／production**：由 git 原生 `.devpro/scripts/hooks-git/pre-push.mjs` 擋，不在上表 gate-id 之列，也不是第五個 gate 層級的底線；它不讀 rigor level（off 也擋）、也不讀 `DEVPRO_HOOK_BYPASS`，但僅本機第一道，`git push --no-verify` 或未安裝即可跳過；`master`／`integration`／`release/*` 的直推本機 hook 層沒有機械攔阻（pre-push hook 只認 `main`／`production`；遠端分支保護由 repo 設定決定，本機無法確認），只靠 AI 自律（`ai-autonomy.md` §Never）。同一個 hook 也擋目標不在 `origin/production` 上的 `production-*` tag 推送（見 `release-step-1-7.md` Step 6），同樣不讀 rigor level 與 `DEVPRO_HOOK_BYPASS`。

> **不在底線**：`force-push`（破壞性歷史改寫，工程師主動降級時自負）與 `stop-handoff-cite` 在 off 時 no-op。兩個 workflow-completion Stop hook 在 off 時只處理矩陣所列的跨 repo 未結紀錄。**SQL 拼接**目前 0 hook 實作（broad grep 確認），歸 cooperative 層——lite 仍載入規範有提醒，**off 下無任何 hook 防護，工程師自負**。誠實宣告，不謊稱有防線。

### off ≠ DEVPRO_HOOK_BYPASS

兩旗標正交：`off` 仍 fire 4 條底線檢查；`DEVPRO_HOOK_BYPASS=1`（per-command，`lib/hook-bypass.mjs`）連 PreToolUse 的底線 gate 都跳（git 原生 pre-push hook 不讀它；能跳過 pre-push 的是 `git push --no-verify`）。off = 會話級流程降級，bypass = 單次命令全 PreToolUse gate 豁免。

### Reserved consumer basenames 不被 sync 覆蓋的真 invariant

充要條件是「**source repo 永不擁有 reserved consumer basename**（含 `.devpro/rules.config`、root `AGENTS.local.md`、`.devpro/pre-pr-checks.local.md` 與 `.devpro/second-review-rules.local.md`）+ `sync-agent-rules.mjs` 是 source-driven walk（`walkSourceFiles`）不鏡像刪除 consumer extras」。常見誤解是以為「只要放在 submodule 之外就安全」——因果不成立：真關鍵是 source 不擁有此 basename，故 consumer 即使把 `rules.config` 放 `.devpro/` 下、或在 root 放 `AGENTS.local.md`、或在 `.devpro/` 放 `second-review-rules.local.md` 或 `pre-pr-checks.local.md` 也安全。`sync-agent-rules-e.test.mjs` 把此條件升為機械守門。Synced／衍生 `AGENTS.md` 仍禁手改；內容型自訂合法出口＝root `AGENTS.local.md`（additive-only；見 `consumer-local-rules.md`）。

## Exit Criteria

- 級別解析依 precedence（env > consumer config > 內建 lite）得單一 resolved level，區分明確 full 與非法設定的 full 保護
- 任何級別下 4 條底線檢查皆 fire（off 不例外）
- lite/off 下非底線 hook 依矩陣 no-op，且白名單漏列底線 gate-id 時 prove-it 測試轉紅
- off 下 SQL 拼接無 hook 防護一事於本 leaf 與 proposal 誠實載明

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「off 了就連禁推 main 也別擋，純 AND tool 嘛」 | 底線是 ~0 token 機械檢查、擋不可逆災難；降流程重量 ≠ 拆安全鎖 |
| 「config 放在 submodule 之外就不被 sync 覆蓋」 | 真 invariant 是 source 不擁有 reserved consumer basename（`rules.config`、`AGENTS.local.md`、`pre-pr-checks.local.md`、`second-review-rules.local.md`）；sync 是 source-driven walk 不鏡像刪除 |
| 「off 跟 BYPASS 一樣都是關 hook」 | off 仍 fire 底線；bypass 連 PreToolUse 底線 gate 都跳（git 原生 pre-push hook 不讀它）。兩者語意正交，勿混用 |

## Verification

```sh
# 級別解析 + 底線白名單 reverse prove-it（含「白名單漏底線 gate-id → 轉紅」斷言）
node --test .devpro/scripts/tests/rules-rigor-level.test.mjs
# source 永不擁有 reserved consumer basenames（rules.config / AGENTS.local.md / pre-pr-checks.local.md / second-review-rules.local.md；機械守門，防誤納 sync 清單）
node --test .devpro/scripts/tests/sync-agent-rules-e.test.mjs
# session-start level-conditional 注入不破 parity eval 沙箱
node --test .devpro/scripts/tests/hook-payload-sync.test.mjs
# 「放錯位置才被覆蓋」之誤述不得復活（Node API，跨平台；pattern 由片段組合避免本檔自我命中）
node -e "const fs=require('node:fs');const p='submodule '+'外才安全';process.exit(fs.readFileSync('.devpro/agent-rules/rules-rigor-level.md','utf8').includes(p)?1:0)"
```
