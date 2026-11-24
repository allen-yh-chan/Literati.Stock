---
name: third-party-packages-licensing
description: 第三方套件授權白名單（MIT/Apache/BSD/ISC）與 Make-vs-Buy 評估規則；觸發：引入或升級任何外部套件前。
---

# 第三方（免費／開源）套件授權原則

## Overview

兩個強制關卡：(1) **Make-vs-Buy 評估**（大型功能前）；(2) **授權檢查**（引入任何套件前）。決策權在使用者，AI 僅產出評估報告與建議。新增套件屬 Ask First 操作，須取得使用者明確同意。

## When to Use

- 預估實作 >200 行、>1 工作天，或屬公認領域（auth、HTTP client、序列化、PDF/Excel、rate limiter、job queue 等）→ **Make-vs-Buy 評估**
- 任何引入或升級 NuGet / npm / 其他套件管理器相依時 → **授權檢查**
- 不確定是否觸發 → **一律觸發**（做多不做少）

**豁免 Make-vs-Buy**：<50 行 utility、純業務邏輯（無對應 OSS）、`hotfix/*`、擴充既有模組

## Process

### Brownfield Onboarding Guidance Check

**觸發條件**：套件 / CLI 工具涉及 spec / config / state / multi-step workflow（非純 lib）。純 lib（lodash、ramda 等）**豁免**。

**4 步必做檢查**（評估整合前完成）：

1. **讀 README**：grep `brownfield` / `existing` / `legacy` / `migrate` / `adopt` / `init` / `onboard`，記錄命中段落
2. **跑 CLI help**：`<tool> --help` + 各 subcommand `--help`，列**所有**子命令（避免漏 onboarding 命令；OpenSpec `/opsx:onboard` 在 expanded profile）
3. **檢查 expanded / advanced / experimental 模式**：onboarding 常藏非預設 profile
4. **找不到才 invent**：PR 描述 + `decisions.md` 列已查位置（README section、`--help` 輸出）

**Anti-pattern 反例**：

- 「我憑直覺推導 Workflow X」 → 沒讀官方
- 「README 沒看到」 → 沒看完整、沒查 expanded、沒跑 `--help`
- 「以為 OpenSpec 沒提供」 → 反例：v1.3.1 有 `/opsx:onboard`（custom profile + workflows 含 onboard；README 「expanded workflow」是口語）

**Anti-pattern 偵測**：AI 提整合方案前若無 4 步證據（README grep / `--help` 輸出 / profile 探查 log），**必須**中止回 step 1。

### Make-vs-Buy 評估

於 `openspec/changes/<name>/make-vs-buy.md` 產出報告（proposal 階段，tasks.md 之前），含：

- **目標**：一句話描述要做什麼
- **候選評估**（至少 2 個 OSS + 1 個手寫）：授權（SPDX）、維護活躍度（最近 commit、last release）、規模指標（stars、dependency 數）、需求覆蓋度、已知風險
- **手寫選項**：預估行數 / 工期、覆蓋度 100%、代價（所有 edge case 自扛、永久維護）
- **建議**：採用哪個 + 理由；若建議 OSS，補 wrapper 邊界

取得使用者明確回應後才能進入 tasks.md。

### 授權檢查

採用**必須同時符合**：
1. **允許商用**（商業環境建置、散佈、託管不受禁止）
2. **不要求**將本專案以 copyleft 條款開源（寬鬆 / permissive 精神）

**允許清單**（例示）：MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC，以及法務事先核准之條款。

**禁止或須法務書面核准**：GPL、LGPL、AGPL、SSPL、EUPL 等 copyleft；授權不明或無授權聲明的相依。

**合規義務**：採用後依授權履行著作權聲明、LICENSE/NOTICE 彙整、不得移除法定聲明。

**PR 要求**：引入新套件時，PR 說明必須註明套件名稱、版本、授權識別（SPDX）。

## Exit Criteria

- 大型功能：`make-vs-buy.md` 已產出且使用者已明確選擇方向
- 所有新引入套件授權已確認在允許清單內
- PR 說明已記錄套件名稱 / 版本 / SPDX
- 新增套件已取得使用者 Ask First 同意

## Common Rationalizations

| AI 的藉口 | 反駁 |
|---|---|
| 「這個我自己寫比較快」 | 大 feature 手寫 = 踩所有 edge case + 永久維護責任。評估 1 小時 vs 維護 2 年。 |
| 「沒有現成 OSS 吧」 | 公認領域幾乎都有候選。「沒有」通常是沒搜到——先 nuget.org / npmjs.com 驗證。 |
| 「library 有點舊但能用」 | 上次 commit 2 年前 = 安全漏洞無人接手。 |
| 「先手寫，之後再換 library」 | 換成本通常比一開始就用 library 高 5-10 倍。 |
| 「授權看起來沒問題」 | 「看起來」不夠——確認 SPDX 識別符在允許清單，疑義先問法務。 |

## Verification

```bash
# 確認新套件授權（Node.js）
npx license-checker --summary

# 確認新套件授權（.NET）
dotnet-project-licenses -i .

# 手動確認
cat node_modules/<pkg>/LICENSE
```

PR 說明中確認已記錄套件名稱、版本、SPDX 識別符。
