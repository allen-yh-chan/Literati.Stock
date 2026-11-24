---
name: doc-split-and-dedup-sop
description: source repo 文件拆分執行方法論（拆檔 SOP 7 步 + dedup 三分類 + Protected Anchors）。觸發：拆分/拆檔/de-bundle/dedup 審查/protected-anchor 管理（`.devpro/agent-rules/*`、`.devpro/agent-skills/*`、`AGENTS.md` 任一）。
---

# Doc Split and Dedup SOP

## Overview

本 leaf 定義 source repo 文件拆分與 dedup 審查的**執行方法論**（決策 gate + 7 步 SOP + Anti-rationalizations + Split/Dedup Audit Output + Protected Anchors）。設計層判準（6 Principles / ROT 三維 / Hook-or-Don't-Add）為 SSOT 在 `rule-design-principles.md`；本 leaf 只說明「如何執行拆分與 dedup 審查」。

## When to Use

- 考慮拆分 `.devpro/agent-rules/*.md`、`.devpro/agent-skills/*`、`AGENTS.md` 為 route-first index + leaves 前
- 審查既有拆檔或 dedup 候選時（file-role ledger 前置）
- 管理 protected anchor（壓縮、措辭精確化前確認不靜默移除錨字）

## Process

### 文件拆分 SOP（source repo 專用）

適用：拆 `.claude/agents/*`、`.devpro/agent-skills/*`、`.devpro/agent-rules/*`、`AGENTS.md` 為 route-first index + leaves。

#### 核心原則：拆檔 = 按條件載入

拆檔的目的是「按流程步驟與 index 決定**該讀哪些檔**」，而不是「分散儲存」。若拆完每次都全讀 5 個 leaf，總 token 等於原本讀一個大檔，等於沒拆。**真正省 token 的是 70% 常見路徑只走部分 leaf**。

**progressive disclosure／co-location（canonical SSOT）**：拆檔＝條件載入（progressive disclosure）——常見路徑只讀需要的 leaf；互依且常同讀的短契約可 **co-location** 留同檔，避免為了「整齊」拆成每次都全讀。三題 gate 未全 yes → 不拆。

#### 決策 gate（前置三題，全 yes 才拆）

1. 是否有互斥分支（A/B path）？
2. 70% 常見路徑是否只需要其中一部分？
3. leaf 是否能做到「不讀它也不影響當前步驟判斷」？

三題未全 yes → **不拆**，改做「單檔瘦身」（trim 冗餘段落、移 archive、改表格化）。

範例：`devpro:security-scan` 通過（local/gha 互斥，常見路徑只走一支 + reporting）。反例：`devpro:init` 每次完整執行 → 不拆。

#### 7 步執行 SOP（gate 通過後執行）

| # | 動作 | 失敗訊號 |
|---|---|---|
| 1 | grep `openspec/changes/archive/` 盤點 archived 契約欄位（如 `decisions_delta`），逐條映射到新結構 | JSON schema 欄位、archive 內 spec entry 在新檔找不到 |
| 2 | grep `openspec/specs/` 找出指向被拆檔的 capability spec MUST / SHALL clause，逐條確認新結構仍滿足 | spec.md MUST 子句 phrase 在拆後 leaf 任一處都搜不到 |
| 3 | 盤點 cross-component 禁令、cross-ref（secrets 混用、收尾條件 gating、commit 提醒） | 「禁止」「必須」整段消失 |
| 4 | POSIX 可攜性檢查：機械命令禁用 `rg`、`grep -P` 等非 POSIX 旗標，採 `grep -lq` 等共通子集 | consumer repo 沒裝 ripgrep 即斷 |
| 5 | 路由偵測碼留在 **index**，不可下沉 leaf — index 評估不到自己路由不到的 leaf | 路由 if-else 引用的變數定義在某 leaf 內 |
| 6 | 第 2 步命中的條款（指名原檔或章節皆算），所指內容拆後已不在原檔時，附 capability spec delta（`specs/<cap>/spec.md` MODIFIED Requirement 註明 source pointer change）；仍在原檔或無命中不附，PR 內文記逐條判定。chore 分類寫 proposal（lite 無 proposal 寫 PR 內文；routing/gate 變動 = 不得 chore A） | 所指內容已搬走卻未附 delta、`openspec validate --strict` fail 或 chore 類別未宣告 |
| 7 | de-bundle 把某 `§`-section 搬到 sibling 時，grep 外部 by-name 引用（`<leaf>.md §<name>` / `「<name>」段` / marker），逐一 repoint 到 holding sibling。**grep scope 非僅 agent-rules/**（recursive `-r`，勿用淺 glob——有巢狀子目錄）：掃 `scenarios/`（`contains` 斷言）·`README`·`openspec/specs/`·`.claude/`·`.devpro/agent-skills/`·`tests/`（含 read()+match 形態）；archive 歷史 cite 不掃 | 外部仍 cite 已搬 §-section（dangling ref）；evidence: PR #1171 兩輪 cross-model；PR #1179 漏掃上述 scope 致 4 類延後攔 |

#### Anti-rationalizations（拆檔藉口反駁）

**「順便拆比較整齊」**
→ 拆檔是 token 工程動作不是審美動作；過 gate 才拆。

**「leaf 自含等下次再補」**
→ 後補 = 不補；archived 契約 / spec MUST / 禁令缺失 = 已壞。

**「先拆再 trim」**
→ 順序錯。先 trim 看是否就足；trim 不足才拆，否則一定靜默掉內容。

**「PR review 會抓到」**
→ 機械測試才能保證；review 取決於 reviewer 是否還記得原檔有什麼。

#### Split/Dedup Audit Output

審查既有拆檔或 dedup 候選時，proposal 必須先輸出 **file-role ledger**，逐檔列出：檔案、routing trigger / role、split-gate rationale、duplication classification。分類只允許：`true duplication`、`leaf-self-contained`、`cross-runtime fallback`。Fallback leaf（`*-fallback.md`）預設屬 `cross-runtime fallback`；除非 audit 證明 self-contained Others-runtime path 已不需要，禁止因表面重複而合併或刪除。

### Protected Anchors

**Protected Anchors** 指編輯（壓縮、措辭精確化）時**不可靜默移除**的錨字，分三類：

| 類別 | 定義 | 舉例 |
|---|---|---|
| **grep-assertion 錨** | `.devpro/scripts/tests/*.test.mjs`（不限 grep 命名）以 REQUIRED phrase / `.includes()` / `assert.match` literal 斷言必須存在於特定 leaf 的字串 | `preflight-mix-warning-grep.test.mjs` 斷言 `openspec-flow.md` 含 `simplification.*feature` |
| **cross-ref 路徑** | leaf 互引的 `<file>.md §段名`——移除後 cross-ref 斷開，依賴方無法 routing | `rule-design-principles.md §ROT 設計判準` |
| **normative MUST/SHALL 子句** | 含 MUST / SHALL / 必須 / 禁止 的條款——措辭調整後語義必須等效 | `禁止用 negative lookahead 追加第 N+1 個例外` |

#### 機械檢查機制

採 **reverse-index from existing grep-tests**（方案 4，proposal FR-B 選型）：
- **SSOT**：`.devpro/scripts/tests/*.test.mjs` 既有 REQUIRED / `.includes()` / `assert.match` literal phrase 即為 protected anchor 清單，**不另立 manifest**（避開 manifest 漂移）；含 metacharacter 的 regex 保守跳過；僅正向存在斷言納入（`doesNotMatch` 不納）
- **偵測邏輯**：某 leaf phrase 淨移除 **且** 依賴 test 未更新 **且** 無豁免標記 → advisory fail；別檔新增不抵消、刪除不歸入
- **強度**：**soft-fail + override**——test fail 但提供豁免通道，不硬擋正當編輯
- **機械檢查 carrier**：`protected-anchor-grep.test.mjs`（advisory 語義，與既有 hard-fail grep-tests 隔離）

#### 豁免通道

移錨且依賴 test 未同步 → test fail；以下任一條件即豁免：

1. **commit message 含 `anchor-move:` 標記**（留 audit trail）
2. **同 diff 同步更新依賴 test**（test 與 leaf 一起改，無遺漏）

#### 正當移錨案例

措辭精確化（如 cross-model review 後修正）屬正當編輯，**非禁止移錨**——走豁免通道留 audit trail 即可。禁止的是「靜默移除」：壓縮時連同 protected phrase 一起刪、且未同步依賴 test、且無 `anchor-move:` 標記。

## Exit Criteria

- 拆分前：決策 gate 三題全 yes + 書面記錄於 proposal
- 7 步 SOP 已逐步執行（archived 契約 / spec MUST / 禁令 / POSIX / 路由偵測碼 / spec delta + chore 分類 / de-bundle repoint）
- de-bundle repoint：外部 by-name 引用（`<leaf>.md §<name>`）已逐一 repoint，0 dangling ref
- Protected Anchors：壓縮前已 grep-test 確認或走豁免通道（anchor-move: commit marker / 同 diff 更新依賴 test）
- file-role ledger：dedup audit 前已輸出，每檔有 classification

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「順便拆比較整齊，不需要過 gate」 | 拆檔是 token 工程動作；過 gate 才拆，gate 未過 = 白做或靜默掉內容 |
| 「Protected phrase 很小可以靜默移除」 | 靜默移除 + 未更新依賴 test = advisory fail；正當移錨走豁免通道留 trail |
| 「只是標題改法，不算 anchor-move」 | 測試以 literal phrase 匹配；措辭改變即觸發 — 走豁免通道 |
| 「表面重複就是 dedup 機會」 | 先輸出 file-role ledger；`leaf-self-contained` / `cross-runtime fallback` 重複不可刪 |
| 「先拆再更新 spec/test，review 再補」 | 後補 = 不補；7 步 SOP step 2 先確認 spec MUST，step 7 先 repoint 外部 ref |

## Verification

```bash
# 確認 doc-split-and-dedup-sop.md 存在且有兩個主段
grep -F '### 文件拆分 SOP（source repo 專用）' .devpro/agent-rules/doc-split-and-dedup-sop.md
grep -F '### Protected Anchors' .devpro/agent-rules/doc-split-and-dedup-sop.md

# 確認 rule-design-principles.md stub pointer 存在
grep -F 'doc-split-and-dedup-sop.md' .devpro/agent-rules/rule-design-principles.md

# 確認 doc-splitting-sop-guard test 讀新 leaf
grep -F 'doc-split-and-dedup-sop.md' .devpro/scripts/tests/doc-splitting-sop-guard.test.mjs
grep -F 'doc-split-and-dedup-sop.md' .devpro/scripts/tests/rule-split-audit-guard.test.mjs

# token check
node --test .devpro/scripts/tests/rule-token-budget.test.mjs

# commit 前：unit tier
node .devpro/scripts/run-test-suite.mjs --tier unit

# PR 範圍 tests（範圍 SSOT `test-suite-cadence.md`）
# commit 後執行：只讀 `main...HEAD` 已提交差異；未提交的變更選不到，分支無 commit 時退回完整 integration。governance／release 的全量要求不變
node .devpro/scripts/run-test-suite.mjs --changed main
```

## Cross-References

- **設計層判準（6 Principles / ROT 三維 / Hook-or-Don't-Add / Workflow Persistence Layers）SSOT**：`rule-design-principles.md`（本 leaf 不複述判準）
- **audit 執行流程（Cadence / Signal / Disposition / Fan-out）**：`rule-audit-playbook.md`（§Inventory → Audit 分層 引用本 leaf §Split/Dedup Audit Output）
- **ingest 方法論**：`rule-ingest-methodology.md`（§Ingest-Mapping Ledger 同構 file-role ledger）
- **Protected Anchors 機械守門**：`protected-anchor-grep.test.mjs`（advisory gate；reverse-index SSOT 見本 leaf §Protected Anchors §機械檢查機制）
