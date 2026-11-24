---
name: platform-adapter-opencode
description: "OpenCode：CLI project plugin ↔ shared runner；Desktop unsupported/unverified。觸發：OpenCode CLI 內實作、devpro skill 或 `dp-*` agent 前；不綁 Desktop。"
---

# Platform Adapter：OpenCode

## Overview

先讀 `platform-adapter-contract.md`，再讀本檔。
本檔只處理 OpenCode 特有風險與載體路徑，**不重寫** `AGENTS.md` 與 leaf rules。能力真值以契約探測 + `RuntimeCaps` 為準。

## When to Use

- 在 OpenCode CLI 內改碼、跑流程、或使用 `dp-*` roles／devpro skills 前
- **不要**在未證實前把本檔套用到 OpenCode Desktop

> _Anchor: 截至 2026-09 本機 `opencode2 v0.0.0-beta-19425` 實測：`opencode2 --version` 於 isolated HOME 可跑（static、無 bootstrap）；`debug config`（含 repo `.opencode` sources）／`debug agents`（七 dp-* `mode: subagent`）以 **user HOME** 執行——fresh isolated HOME 下 background service 無法啟動（實測 124s `Timed out waiting for the background service to start`），debug 查詢屬 read-only、user config side effects **未斷言**；`debug agents` 在 service (re)start／cold attach 後呈分階段目錄（`[]` → 僅 built-ins → 含七 dp-*），offline smoke **MUST** poll 至七 dp-* 就緒（見 `opencode-cli-smoke.test.mjs`）不得把單次 exit-0 空清單當投影失敗。plugin `.js` auto-discover 且 V2 loader schema acceptance 為 worktree session log 證據（`loading plugin` 後 0 筆 `failed to load plugin`）。V1 live re-verification 未跑（本機無 V1 `opencode` binary）——V1 相容以 docs-authoritative dual export 為據，已出貨 1.18.x consumer 可自行驗證；V1 binary 存在與否都不構成 V1 face 驗證。_

## CLI vs Desktop

| Surface | Status | Evidence |
|---|---|---|
| OpenCode CLI | supported（本 repo carriers + offline smoke） | `.opencode/plugins/devpro-hooks.js` auto-discover；shared `run-hook.mjs --host=opencode` |
| OpenCode Desktop | **unsupported**／**unverified** | MUST NOT 用 CLI success 外推 Desktop hook dispatch |

Desktop 在 doctor／smoke 報告中必須保留 `unsupported`／`unverified` 字面；禁止靜默當成功。

## Plugin entry

- Source-owned bridge：`.opencode/plugins/devpro-hooks.js`（MUST 為 `.js`／`.ts`；僅 `.mjs` 不會被 auto-discover）
- **Dual export（V1＋V2 同一檔）**：default export 是 object——`server()` 承接 V1 face（回傳既有 hook-key 物件）；`setup(ctx)` 承接 V2 face（`permission.evaluate`／event stream／prompt／`tool.execute.after`／`skill.transform` 註冊）。V1 live re-verification 未跑；版本實測見下方 `_Anchor:`
- **V2 skill 註冊契約**：`ctx.skill.transform` 的註冊 payload MUST 為 repository-locked key set `{id, name, description, path, content}`（`path` 為 host-required、綁 SSOT `SKILL.md` 路徑；host schema 另有 optional `autoinvoke` 等、本 repo 不送；legacy `location` 欄位名已淘汰）。缺 `path` 會被 host schema 拒（`SchemaError`）並停用整個 plugin（PR #2768 實證）。契約由 `opencode-skill-discovery.test.mjs` 的 exact key set 斷言＋repo-wide residue guard 機械鎖定。
- Policy SSOT：`.devpro/scripts/hooks/run-hook.mjs` + gates；plugin 只做 event normalize／spawn／decision 轉譯；rules 來源預設 repo `.devpro`，明確設 `DEVPRO_RULES_ROOT` 才整組改讀 `<root>/scripts/hooks/`；該處缺 `run-hook.mjs` 或 `github-mcp-tools` 載入失敗 → 整組不可用，不執行任何 gate、GitHub 寫入被拒（解析序 SSOT `anti-patterns-behavioral.md` §12；測試 `opencode-rules-root.test.mjs`）
- Host marker：`--host=opencode`
- **Tool permission parity**：V1 `TOOL_PROTOCOL`／V2 action→gate 表只列 Devpro 明確治理的操作；未映射工具與 action（含其他 MCP、native helper、自訂工具；devpro-work GitHub 已映射）一律 pass-through，不依 MCP catalog、命名底線或逐工具白名單判定。pass-through 只表示不額外拒絕，不可改寫 host deny 或把 ask 升級為 allow；V1 Stop lock、V2 ownership／Stop barrier 仍先執行，已映射的操作仍跑原本 shared gates。
- **Live dogfood**：核對實際載入的 plugin path／指紋；worktree session 可能載入 parent checkout plugin，須以隔離 fixture 驗證修復版，不得僅憑 cwd 宣稱已載入。以真實 MCP 及自訂工具的 permission assertion 驗證 pass-through，並區分 host 原生拒絕、Devpro 明確 block 與 browser attachment；不要只用合成 evaluate 事件宣稱工具已實際執行。
- **JS runtime spawn**：OpenCode 把 `process.execPath` 設成 **opencode 本體**（不是 Node）。plugin MUST 經 `resolveNodeExecutable()`（`DEVPRO_NODE_PATH` → PATH `node` → 常見路徑）再 `spawn` `run-hook.mjs`；禁直接 `spawnSync(process.execPath, [run-hook…])`（會印 CLI help、把 help 灌進 deny／reminder）
- **chat.message parts**：禁 push 缺 `id`／`sessionID`／`messageID` 的裸 `{type,text}`（OpenCode SchemaError → session 損壞）；reminder 只走 `client.tui.showToast`，admission handoff 走 `tool.execute.after`
- Hard-gate polarity：與其他 host profile 一致——只有 hook stdout 的明確擋下決定（任何 exit status）才 tool deny；runner 失敗（逾時、工作目錄不見、spawn 失敗或例外、stdout 無法解析或無法辨識、非 0 且 stdout 無可辨識判定）一律 fail-open，並為每個失敗 gate 記一行固定詞彙診斷（V1 走 toast 與 reminderSink，V2 走 plugin log；不進 model 可見輸出）；hook 檔不存在為靜默 pass（無診斷，各 host 相同）。tombstone、已映射操作缺必要 payload、V2 無法解析 repo 仍 fail closed（不是 runner 失敗）；V2 面 deny 走 `permission.evaluate`（唯一 documented deny 面）；V1 面 typed `permission.ask` 同契約但 host reachability 未重驗（V1 live re-verification 未跑）
- Idle：`session.idle` → Stop／recap state + reminder；idle callback **不是**同步 Stop-block；僅 Stop gate 明確擋下才鎖 session（後續 deny：V2 `permission.evaluate`、V1 **tool.execute.before**，`permission.ask` 僅在 host 呼叫 typed hook 時補強），該輪無明確擋下即解鎖；runner 失敗只記診斷、不鎖
- release back-merge completion gate：只靠文字（`session.idle` 非同步，plugin 不登記）；規則見 `release-step-1-7.md` Step 6A。
- Built-in tool map：含 `bash`／`shell`／`edit`／`write`／`read`／`task`／`grep`／`glob`／`webfetch`／`todowrite`／`skill`／`apply_patch`／`question`／`websearch`；未列工具保留 host 權限。本表依 V1 tool name 錨定；V2 依 permission action 映射，實際 patch 工具以 `edit` action 進 shared gate，不能只按工具名字推斷 action。

> _Anchor: 截至 2026-09 `opencode2 v0.0.0-beta-19425` loader 實測：dual-export default object（`setup(ctx)`）被 schema 接受並印 `loading plugin`（worktree session log，其後 0 筆 `failed to load plugin`）；V1 function default export 會被 `SchemaError(Expected object at ["default"])` 拒絕。`.mjs`-only 不 auto-discover（V1 既有限制沿用）；上方 Built-in tool map 依 V1 錨定、V2 未重驗本表。V1 live re-verification 未跑。_

## Skill path

- Discovery SSOT：repo `.agents/skills`（既有 symlink → `.devpro/agent-skills`）
- Plugin `config` 可把 `skills.paths` 指到 `.agents/skills`（idempotent）
- **禁止**：`.opencode/skills/**` 正文、`OPENCODE.md`、source-owned `.opencode/command/**` 假 projection

## Seven role projections

- Path：`.opencode/agent/dp-*.md`（frontmatter `mode: subagent`）
- Semantic SSOT：`.devpro/scripts/subagent-behavioral-contracts.mjs`
- `task` → PreToolUse `Task` → spawn admission（未授權／malformed fail closed）

**dp-reviewer thread 續作（capture 修正）sanctioned 路徑**：OpenCode host 無 gate 承認的 dp-reviewer 續作載體——`task`（含 sessionID 續作）一律映射 PreToolUse `Task` → named-projection fresh spawn 分類，宣告 `instance_mode: continue` 會被 gate 拒（「a named projection spawn is always instance_mode: fresh」）。capture 被拒的 dp-reviewer payload 修正以 **fresh re-emission 為 sanctioned 修正路徑**：以全新 `task` call（不帶續作形狀、admission 六欄 `instance_mode: fresh`）重派 reviewer，每輪 fresh re-emission 各寫一筆 admission record。gate 機械強制面不變：宣告 `instance_mode: continue` 仍被拒；帶 sessionID 的續作形狀 gate 可觀察性無 live 實證（不視為 evidence-grade 前提），本契約不承認其為 sanctioned 續作（該形狀屬 TL 規則義務，不得宣稱 gate 已擋）；TL MUST NOT 以 sessionID 續作 `task` 同時宣告 `instance_mode: fresh` 來偽裝 fresh spawn——本 sanctioned 路徑是 fresh spawn 修正流程，不是 gate 後門。
- **admission binding（宣告路徑；session cwd 不再是條件）**：spawn admission 的 binding 不再由 spawn cwd 單獨決定——session cwd 非 `.worktree/<change-id>` 時走宣告路徑（全 host 一等公民）：六欄之外在 `return_and_stop` 與 `role` 之間帶 conditional `change_id`＋全 role `execution_root`，由唯讀 helper `node .devpro/scripts/resolve-admission-binding.mjs <change_id> --json` 預解析（A1 trusted `responsibility_id` 前綴／A3 `evidence_scope`／`return_and_stop` 段為替代來源，讀序 A2＞A1＞A3；A3 僅在 cwd 未解出 id 且 A2／A1 皆缺時單獨成立）；binding 由同 common-dir exact-one `.worktree/<change_id>` 決定（四 host 同一 resolver／同一封閉碼群），record 落 binding worktree。OpenCode `task` tool 仍**無 cwd/workdir 參數**、subagent 繼承 session working directory，但這**不再**是 dp-* Task 委派的 gate 限制：**`session_move`／另開 worktree-rooted session 不是 gate 條件**（成功 move 仍可作執行面優選、非唯一）。review／verify 無任何可解宣告時仍 `change-worktree-required` fail closed；其餘 role 為非靜默 `binding-unresolved` advisory、不 mint、不得作 independence 證據。child 讀寫 MUST 以 `execution_root` 的絕對路徑／`git -C` 進行（`working_directory` 為執行面工具，非 binding authority）；宣告 id 僅 lookup key，非合規證據。

## Hook cwd assumption

OpenCode CLI project plugin 提供 tool／permission surfaces。Protected-branch／git write 仍須留下 `pwd`、`git rev-parse --abbrev-ref HEAD`；不可假設 Desktop 或未載入 plugin 的 session 有同等攔截。worktree git 寫入一律用 `git -C <abs-worktree>` 單一形，且 `git add` 與 `git commit` MUST 分兩次 Bash 呼叫（同一 payload 串 add＋commit 會讓 commit-time EOF re-stage gate 落入 `checked=false`）。

## Tool Routing（與 Claude／Codex 對齊）

OpenCode 的廣域 hook 收到的工具／permission action 比 Devpro 治理範圍廣。與 Claude／Codex 的 shared pre-tool dispatch 一樣，只對明確映射的操作執行對應 gates；未映射不代表違規，不得因名稱陌生而一律 deny，也不需要逐一批准新的 MCP server 或工具名稱。

- **保留 host authority**：未映射工具保留 host 原生 allow／ask／deny；pass-through 不替代 host 授權，也不宣稱工具已執行成功。
- **保留治理範圍**：shell／read／write／edit／subagent 等已映射操作仍照既有 payload 契約執行 gates；已映射 write／edit 缺 proposal、multi-resource 無法逐一綁定、V2 ownership 無法解析等仍 fail closed。V1 Stop lock 與 V2 ownership／Stop barrier 先於 action 路由。
- **區分未知 event**：未支援的 hook event 仍標 unsupported／unverified，不得把它算成 hook dispatch 驗證成功；這與已支援 hook 上未映射工具的 pass-through 不同。
- **Browser**：OpenCode 2.2.5 內建 browser 工具需 Desktop 連接同一 session；未連接導致工具清單缺失，不靠 Devpro 工具白名單修復。此操作驗證不代表 Desktop hook dispatch 已獲支援。
- **Runner failure**：仍依共用 fail-open 契約記診斷，與工具是否映射無關。

## Load-Plan Capability

**Support**: partial support, OpenCode exposes agents／skills via project files and `opencode debug skill`／`debug agent`; no full machine-readable always-on load plan is assumed. Fallback: list `.opencode/agent/`、`.agents/skills/`、AGENTS.md trigger index before multi-step work.

## Edit-Time Syntax Validation

**Support**: partial support, `tool.execute.after` may map to shared post-tool validation when registered; otherwise manually run `bash -n`、`node --check`、JSON parse、`python3 -m py_compile` before claiming syntax-clean.

## Pre-commit Cross-Review Reminder

**Support**: partial support, shared Stop／idle reminder path via plugin → `recap-check.mjs`; Desktop unsupported／unverified. Fallback：commit／PR 前手動判斷 cross-review 豁免並視需要跑 `@cross-review`。

## User-Invocable Command/Skill Capability

**Support**: fully implemented via `.agents/skills` discovery（OpenCode lists catalog skills from that path by bare id; TUI invokes a skill as an `@<id>` mention, e.g. `@cross-review`, so skill ids do not collide with built-in `/` commands such as `/init`; headless `opencode run` names the skill id in the prompt）. MUST NOT invent `.opencode/command` or `.opencode/skills` content trees as source-owned carriers.

## Cache-Friendly Design Metric

**Support**: not applicable, Recap 記 source: N/A: host does not expose a stable cache-read metric for repo-local sessions

## Reasoning Depth Control

**Support**: partial support, model selector may exist but no repo-stable reasoning-effort flag is assumed. Mapping heuristic 未驗證：mechanical edits use default／fast；design／review／RCA 用 strongest visible model；若無 selector → `reasoning-depth unavailable`。Shared effort rank 見 `model-delegation-delegation-rules.md` §TL Effort Floor。

## Per-Session Usage Telemetry

**Support**: not applicable, Recap 記 source: N/A: host does not expose usage data

## Native Subagent Capability

**Support**: official native support for project agents under `.opencode/agent/*.md`（`mode: subagent`）. Devpro dp-* files are runtime projections；role SSOT remains shared contracts + Claude body where cited. Live probe：confirm agents visible、admission fields present for named dp-* Task dispatch、plugin loaded.

## Cross-Model Second Opinion Adapter

OpenCode CLI 有 plugin → shared pre-tool-gate 路徑，但 cross-model sticky 仍依 `code-review-checklist.md`／host reviewer CLI。Desktop **unsupported／unverified**，不得宣稱 Desktop 已攔截 merge。

1. PR 建立後依豁免清單判斷；預設需 cross-model review
2. 未豁免 → `@cross-review`（或 host equivalent）寫 sticky `<!-- cross-model-second-opinion:sticky -->`
3. Merge 前確認 sticky `verdict`／`last_reviewed_sha`；CLI plugin 可攔截 shell／bash 面，Desktop 不保證

**External evaluator 入口**：reviewer CLI 不可用時，除了寫 `UNAVAILABLE`，TL 可改發行 External Evaluator 審查單（`render-second-review-packet.mjs` 帶 `executor_kind: "external-evaluator"`），交由另一 family 的獨立 session live 讀 PR 並自寫 sticky，TL 再跑 `accept-external-second-review.mjs <packet-dir>` 驗收；撤回改跑 `render-second-review-packet.mjs --void-external-dispatch <packet-dir>`；同 family 僅在使用者明確授權時以 `--allow-same-family <why>` 發行（sticky 需 `same-family fallback: <why>` lead，accept 驗），完整契約見 `second-review-external-evaluator.md`（審查單＋收據）。footer `Tool:` token SSOT 見 `second-review-sticky-authority.mjs` `STICKY_PROVENANCE_TOOL_TOKENS`。

**pr-sticky handoff builder 的 `--primary-family` 注入**：本 host 無固定 primary model，值 MUST 取自 trusted-session 證據，不是 host 名稱。session 的 model 屬 deepseek family 時注入 `--primary-family deepseek`（builder 寫出 handoff `primary_family: deepseek`；未指定 `--preferred-reviewer` 時預設 reviewer 為 `codex`，要指定 different-family 時明示 `--preferred-reviewer claude` 或 `codex`）。**禁止**因 builder 過去只收 `codex`／`claude` 就把本 host 假冒成 `claude` 或 `codex`。沒有 trusted-session primary 證據時，pr-sticky 沿用下段的 `primary_family: unknown` 規則：注入 `--primary-family unknown`（builder 預設 reviewer `codex`），sticky `reason:` 由 renderer 標 `cross-model-unverified`，**MUST NOT** 宣稱 cross-model family diversity。`--primary-family` 閉集是 `codex`／`claude`／`deepseek`／`unknown`，與 renderer 接受的 primary family 集合一致。

**OpenCode design-gate default（design-only；非 pr-sticky cross-model credit）**：OpenCode 無固定 primary model。無 trusted-session primary evidence 時，第一次 persist 的 `## Design-Author Identity` MUST 使用 `identity: unknown`、`provenance: unknown`（host-unproven；**禁止**假貼 `claude`＋`family-alias`）；design audit-only handoff 使用 `primary_family: unknown`、預設 `reviewer_family: codex`（或 ledger／`$CROSS_MODEL_REVIEWER` 預選）。`evaluateDesignReviewIndependence` 回 `host_primary_unproven`（執行獨立），**禁止**標 `same-family fallback`、**禁止**宣稱 family diversity；pr-sticky 在 primary 未證明時 MUST 用 `primary_family: unknown` + sticky `cross-model-unverified`。**若本 session 已有 trusted-session primary evidence，MUST NOT** 把 Design-Author 自降為 `unknown`/`unknown` 以略過 same-family 記帳——host-unproven 僅限無 trusted-session primary 時。Helper／scenario SSOT：`design-review-independence-identity.mjs` 與 `openspec-flow` Design Artifact Second-Review Gate。

## Rigor Level（DEVPRO_AGENT_RULES_LEVEL）

本 runtime 讀取與其他 runtime 相同的旗標 `DEVPRO_AGENT_RULES_LEVEL`（值 `full|lite|off`，預設 `lite`）及相同的 consumer `.devpro/rules.config`，precedence 一致（env > config > 內建 lite）。禁止使用任何 runtime-specific 旗標別名。以 shell 環境變數設定：`export DEVPRO_AGENT_RULES_LEVEL=lite` 後啟動 OpenCode CLI。詳見 `rules-rigor-level.md`。

## Exit Criteria

- 已讀 `platform-adapter-contract.md` + 本檔
- 已區分 CLI supported vs Desktop unsupported／unverified
- plugin `.js` 可發現；skills 走 `.agents/skills`；七 role 投影存在
- 未授權／malformed Task admission fail closed

## Verification

```bash
rg -n "unsupported|unverified|\\.agents/skills|devpro-hooks\\.js" .devpro/agent-rules/platform-adapters/opencode.md
test -f .opencode/plugins/devpro-hooks.js
test ! -e .opencode/skills
test ! -e OPENCODE.md
node --test .devpro/scripts/tests/platform-brand-isolation-grep.test.mjs
```

## Reviewer model and effort

本節適用各 host 呼叫 OpenCode reviewer；只讀本節不代表切換 active host adapter。模型與 effort 規範 owner 是 `code-review-cross-model.md`，實作共用入口為 `.devpro/scripts/lib/opencode-model-probe.mjs`。

OpenCode v2 在 render 用 bounded `opencode api model.list --standalone` 取得目錄；DeepSeek 依 generation、同 generation 的 Pro/Flash capability tier 排序，禁固定舊 ID。目錄缺失、未知 tier、同級歧義或最高模型不支援固定的原生 `max` 均 fail closed。選定的原生 variant 用 `--model provider/model#variant` 傳入；runner 必須核對每一 assistant turn 的 session export，並在 `projection_opencode_session_verified` 留下 requested/observed variant。

> _Anchor: 2026-11，OpenCode v2 用 `provider/model#variant`；DeepSeek 官方 `xhigh` 實際映射為 `high`，原生最高為 `max`。本 recipe 固定使用原生 `max`；不得用 `xhigh`／`high` 代替，也不在每次審查重問 effort。相反的 effort override 會在探測前拒絕，證據必須如實標示 `max`。能力排名依官方 V4.1 Flash 超過 V4 Pro 的說明；同 generation 才比較 Pro/Flash tier。官方來源：[模型](https://api-docs.deepseek.com/news/news260910/)、[effort](https://api-docs.deepseek.com/guides/thinking_mode/)。_

Dogfood：先驗 inventory 與不支援 effort 的 pre-spawn refusal，再經 canonical render/runner 驗同一 model/variant 的實際 exported evidence；inventory、argv 或請求回音本身都不是完成證據。
