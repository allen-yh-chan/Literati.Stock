---
name: rule-file-template
description: "兩類文件撰寫 template：agent-rules/*.md（5W2H 骨架）、agents/*.md（職責+工作流+禁止事項）。觸發：新建任一類文件前；review 現有結構時。"
---

# Rule File Template

## Overview

本檔定義 source repo 兩類文件的撰寫格式：

| 文件類型 | 骨架 | 路徑 |
|---|---|---|
| Rule file | 5W2H（規劃 → 執行 → 評估） | `.devpro/agent-rules/*.md` |
| Agent file | 職責 + 工作流 + 禁止事項 | `.claude/agents/*.md` |

設計依據 `design-core.md`（Karpathy 4 原則 + Useful-Context Token Efficiency）與 `rule-design-principles.md`（6 Principles）；**本檔只定義格式，不重複設計原則內容**。

> Command file 類型已廢除（migrate-skill-architecture-to-dp-prefix）：`/dp:` 冒號式 command 全面廢除，first-party workflow 唯一入口為跨平台 skill（`.devpro/agent-skills/`），撰寫新 workflow 請參照既有 skill body 結構，非本檔 template。

## When to Use

- 新建任何 `.devpro/agent-rules/*.md` 前
- 新建任何 `.claude/agents/*.md` 前
- review 既有文件結構是否符合規範時

---

## Template：Rule File（agent-rules/*.md）

### Frontmatter（必填）

```yaml
---
name: <filename-without-extension>
description: "<what + when triggered，一句話，中英混可，控制在 150 字元內>"
---
```

`description` 是 AGENTS.md 觸發索引的對齊錨點，必須含：**觸發情境**（什麼時候讀它）＋**主題關鍵字**（AI 可比對）。

---

### Section 順序與 5W2H 對應

| # | Section | 5W2H | 必填 | 格式建議 |
|---|---|---|---|---|
| 1 | `## Overview` | Why | ✅ 必填 | prose ≤ 4 句；說明這條規則存在的理由與背景 |
| 2 | `## When to Use` | When / Where | ✅ 必填 | bullet list；列出觸發情境（條件式說法，如「當…時」） |
| 3 | `## Process` or `## Rules` | Who / How | ✅ 必填 | 編號步驟或決策表；**Who** 可在首句或獨立子段說明 |
| 4 | `## Exit Criteria` | How much | ✅ 必填 | bullet list；3-5 條可驗收的完成條件 |
| 5 | `## Common Rationalizations` | — | 條件必填 | 兩欄表格（合理化藉口 \| 反駁）；有已知繞過模式時才加 |
| 6 | `## Verification` | — | 條件必填 | code block；有可執行驗證指令時才加 |

`## When to Use` 的「條件式說法，如「當…時」」**至少一條觸發條件**（bullet 或等義 prose 子句皆可）MUST 能在目標行為尚未發生時判定為真；以規範自身名詞／自身動作當唯一條件（例：「當你在做 X 時就要讀 X 規範」）＝循環，不算數；純 prose（非 bullet list）的段落不因格式非 bullet 而豁免本條，等義可判定觸發條件寫成 prose 子句一樣算數。合取式子句（含「且」等連接詞）整條視為單一判定單位：僅當每個 conjunct 皆可在目標行為尚未發生時獨立判定為真，整條才算數；任一 conjunct 以目標行為已在進行中為前提，即使其他 conjunct 單獨可判定，整條仍不合格。

**條件必填規則**：

- `## Common Rationalizations`：rule 有已知「AI 或人類會想跳過」的模式時必加；純格式 / 純工具 rule 可省略
- `## Verification`：有可重複執行的 shell / test 指令可驗收時必加；純規範性文件可省略
- 選用 `## Rules`（Section 3 替代名）時，section body 必含 Process-class 結構（編號清單 / bullet / 表格），避免拿 `## Rules` 當空殼 placeholder。`rule-anatomy.test.mjs` 對標準 leaf 機械驗證此條件。

### Enforcement Metadata（新建或實質修改 leaf 必填）

新建 rule leaf，或修改既有 leaf 的 MUST / SHALL / 必須 / 禁止 類條款時，在 `## Process` 或 `## Rules` 開頭加入：

```markdown
### Enforcement Metadata

| Bucket | Carrier / rationale |
|---|---|
| Hard Gate | `<hook/script/test>` or `N/A` |
| Advisory | `<warn/nudge carrier>` or `N/A` |
| Doctrine | `cooperative-only: <why no hard carrier>` or `N/A` |
```

規則：

- Hard Gate 有值時必須是具名 carrier，不可寫「規範要求」。
- Advisory 用於 warn-only、nudge、fail-open 或 reviewer prompt。
- Doctrine 用於 process / reviewer / human judgment；若沒有 hard carrier，必須明講 `cooperative-only` rationale。
- 不批次遷移未觸及 leaf；全 corpus 可發現性由 `consumer-adoption-matrix.mjs --enforcement-map` 承接。
- **`strengthen-rule-trigger-decidability` 自身 disposition（非本節一般例外）**：本 change 新增的 A1／A2／A3 三處 mandatory clause 已在 `openspec-quality-and-formats.md` §Mandatory Clause Enforcement Map 取得具名 row（含 carrier 與 `cooperative-only` rationale），本 change 依此視同滿足本節「必填」，不另在該三處 leaf 各自新增 local `### Enforcement Metadata` block（避免同一 carrier 事實雙寫維護）。此為本 change 自身的一次性記錄，**不改變**本節「必填」對日後新建／實質修改 leaf 的一般要求——之後的 leaf 仍須依上方規則寫 local block；若某未來 change 主張同類「中央 Map 列即等效」理由，須在該 change 自身文件另行記錄與論證，不得逕引本句作為通例。

---

### Process / Rules 格式規則

| 情境 | 格式 |
|---|---|
| 有明確先後順序的步驟 | 編號清單（`1.` `2.` `3.`） |
| 互斥分支決策 | markdown 表格（條件欄 \| 動作欄） |
| 無序的禁止/允許清單 | bullet list，每條 ≤ 2 行 |
| 複雜多條件規則 | 先表格化再 prose 解釋例外 |

**禁止**：純 prose 段落無任何結構（連續 5 行以上純文字）→ 改用 bullet / 表格。

---

### 範例結構（最小可接受 rule file）

```markdown
---
name: example-rule
description: "說明 example rule 做什麼；觸發：情境 A 或情境 B 時。"
---

# Example Rule

## Overview

（為什麼這條規則存在，≤ 4 句）

## When to Use

- 情境 A 發生時
- 情境 B 發生時

## Process

1. 步驟一：做 X
2. 步驟二：確認 Y
3. 步驟三：產出 Z

## Exit Criteria

- 條件一已滿足
- 條件二已驗證
- 無殘留未處理項目
```

---

### Token Budget Tier Registration

未登記＝`small` 1500，免登記；超過才到 `.devpro/scripts/lib/rule-token-budget.mjs` `TIERS` 登記較高 tier；超出 tier cap 照 `token-budget-precheck.md` CAP 公式。

| Tier | Cap | 判準 |
|---|---|---|
| `small` | 1500 | 預設；terse routing / 單議題短規範 |
| `next` | 3000 | consolidated 多議題 rule；reviewer 軸度 SSOT；預期持續加 sub-check |
| `core` | 7500 | hot-path SSOT（`devpro:change` 必讀路由、anchor、模型委派）；需 promotion rationale |

**Rationale comment template**（登記行上方）：

```js
// <promotion-reason>: <leaf-purpose> (~<token>/<cap> cap)
"<filename>.md",
```

兩 tier 都合適時選**較緊**那個，逼迫定期 trim；僅該 leaf 是 SSOT 且預期持續成長才升上一級。

---

## Template：Agent File（agents/*.md）

Agent file 定義「誰來做」——角色邊界、工作流程、禁止跨越的行為。固定三段結構，不套 5W2H（Who 就是整份文件本身，強套其他維度只會製造空殼 section）。

### Frontmatter（必填）

```yaml
---
name: <agent-id>          # 與檔名一致
description: "<角色一句話 + 主要 capability + 禁止事項摘要>"
model: <opus|sonnet>      # 依複雜度選擇
tools:                    # 僅列此 agent 實際需要的工具
  - Read
  - Write
  # ...
---
```

### Section 順序

| # | Section | 必填 | 說明 |
|---|---|---|---|
| 1 | 角色宣告（prose，無 header） | ✅ 必填 | frontmatter 下第一段；一句話說明角色定位與核心限制 |
| 2 | `## 職責` | ✅ 必填 | bullet list；列出此 agent **可以且應該**做的具體動作 |
| 3 | `## 工作流` | ✅ 必填 | 編號步驟；從收到委派到產出結果的完整流程 |
| 4 | `## 禁止事項` | ✅ 必填 | bullet list；明確列出**絕對不做**的動作（禁止跨越的邊界） |

**格式規則**：
- `## 職責` 每條以動詞開頭（讀取 / 分析 / 寫入 / 執行 / 回報）
- `## 工作流` 步驟編號，每步驟含「做什麼 + 從哪裡取得輸入」
- `## 禁止事項` 每條以「**禁止**」開頭，說明禁止原因或應轉交對象

---

## Format Rules (Shared: Rule + Agent)

1. **Header 語言**：section header 統一用英文（`## Overview`、`## When to Use`、`## Process`、`## Exit Criteria`、`## Common Rationalizations`、`## Verification`）；內文中英混可
2. **Prose 密度**：單一句子嵌入超過 3 個獨立概念 → 拆 bullet
3. **Code block**：shell 指令、JSON schema、範例輸出一律用 fenced code block 並標語言
4. **表格欄寬**：欄 header ≤ 20 字元；欄內容 ≤ 40 字元，超出改 prose 子段說明
5. **中英術語一致性**：同一概念在同一檔案只用一種寫法（選定後統一）；禁止「可促進單位 / promotable unit / 可 promote 分支」混用

## Exit Criteria

- 新建 rule file 覆蓋全部 4 個必填 section（Overview / When to Use / Process / Exit Criteria）
- 新建或實質修改 rule leaf 時包含 Enforcement Metadata，或明確 N/A
- 新建 agent file 覆蓋全部 4 個必填部分（角色宣告 / 職責 / 工作流 / 禁止事項）
- frontmatter description 含觸發情境或角色關鍵字
- 無連續 5 行以上純 prose 段落
- rule / agent file 的 section header 為英文

## Common Rationalizations

| 合理化藉口 | 反駁 |
|---|---|
| 「這條 rule 很短，不需要完整結構」 | 結構一致性讓 AI 可預測掃描；短檔遵守成本更低 |
| 「Overview 跟 frontmatter description 重複，省一個」 | frontmatter 是索引用一句話；Overview 是 AI 讀內文時的 context 建立，用途不同 |
| 「內文都是中文，header 也用中文比較自然」 | 英文 header 讓 regex/section 掃描跨 runtime 穩定；AI 對英文 section name 的 pattern match 更準確 |
| 「Agent file 已有 frontmatter description，不需要角色宣告段」 | frontmatter 是 tool-layer 索引；角色宣告是 AI 讀內文時的 context 錨點，用途不同 |
| 「禁止事項太負面，用『不在範圍內』比較好」 | 模糊措辭讓 AI 有解釋空間；「**禁止**」是無歧義的強制訊號 |
