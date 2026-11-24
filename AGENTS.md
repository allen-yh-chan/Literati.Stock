# AI Agent 規範

版本：7.18.0

> **載入宣告**：見 `platform-adapter-contract.md` identity/格式；footer 共用。

## Core Contract
三 Immutable：**MUST/MUST NOT/FAIL CLOSED**（必做/禁止/不確定·衝突·高風險時停下交回）；通用 `ai-autonomy.md`；差異 active adapter
閘只防 AI 不小心、不防故意（產品安全與合規除外）；分類見 `design-core.md` §11
## Intent 速查
> 主線六階段:討論(pending記/claim)→OpenSpec→實作→pre-PR→PR→post-PR(清pending/Recap)；勾稽見下表 dev-flow-checklist
|意圖/情境|入口|
|---|---|
|功能|`openspec-flow.md`|
|修 bug/fix (含 defect)|`openspec-branch-routing.md` §Step 0 + `openspec-flow.md`|
|準備 PR|`git-branch-and-pr-flow.md`|
|上線|`release-sit-uat-pat-prod.md`|
|sync|`rules-flow.md`|
|DB/SQL編碼·建表index|`database-conventions.md`|
|掃描|`security-scanning.md`|
|審查 PR|`code-review-checklist.md`|
> cwd/repo：業務變更在業務repo；跨repo易誤。
## 0. AI 自主行動原則
### 動手前十句自檢

1. **追溯性**：變更/步驟能追溯本次請求或 rule？不能 → stop；沒有現況差異（code/rule）＝ no-op
2. **複雜度**：太複雜？禁「未來擴充」合理化
3. **假設**：腦補→先問
4. **委派**：先證明 bounded responsibility 的隔離效益高於 context transfer／duplicate read／協調成本；≥2 步非判斷性／≥2 檔案僅是 task-shape 訊號，不單獨授權 spawn；委派時明示 runtime-native minimum-sufficient context mode（SSOT `model-delegation.md`）
5. **環境**：dirty/main落後/submodule dirty → reconcile
6. **repo scope**：跨 repo 讀 OK；clone/branch/edit/commit 先具名同意
7. **bash cwd / platform**：write 前讀 active adapter；git write 前先 `pwd && git rev-parse --abbrev-ref HEAD`
8. **Think Before Coding**：先複述理解+假設；改檔前答現況/改法/效證+確認；多解釋先問
9. **Usability-First**：value 優先，成本 tie-break；禁 effort/交差偽裝 value；code/rule/doc/test須防同錯且action point會讀會用；新建產物須留可發現入口/觸發/下一動作/驗證/排除邊界供接手者遵循
10. **一致性掃描**：改散落多處同一事實（值/契約/邏輯/術語/symbol，code/doc 同）→ grep 全副本改齊；host/context 派生值不寫死（第1條追溯性對稱面＝防改漏）。窮盡律見 `code-review-cross-carrier.md`（entry `code-review-checklist.md` pointer）；換 symbol 見 `anti-patterns-behavioral.md` §15

十題任一不通過 → 停下列 state/blocker/next step/owner。command 不豁免；git/工具邊界照授權範圍。
### 輸出紀律（每次回應）
- **簡潔**：回應長度匹配決策資訊密度；禁前言重述／filler／padding；問句置末。
- **memory**：可規範化內容沉澱為共享規範（source 走 chore；consumer 提 PR），不留 per-agent memory（跨 agent 不繼承）；個人偏好／session 暫存可留。
- **語言**：使用者未指定時，產出預設正體中文（專有名詞／技術 token／footer／identifier／branch 名維持英文）；細節見 `ai-autonomy.md`。
### Always
OpenSpec先於碼(A免)｜task驗收才勾｜TDD｜全綠才PR｜PR 記 SQLi/PII｜CI 終態回報｜Recap｜停下交回使用者必附交棒(為何停／做什麼:選項編號且數量匹配分岔,確定動作即1是2否3其他;末項須開放項,3.其他即可兼任／下一步;格式見 `stop-point-comms.md`,五項骨架見 `ai-autonomy.md` §Stop-Point Next Step Contract)
### Ask First / Never
Ask First：SSOT 見 `ai-autonomy.md` §Ask First；入口只提醒 git／套件增升／版本檔／CI/CD／版號 bump 先問（高頻子集，非全部）；`devpro:*` skill 一次同意
Never：SSOT 見 `ai-autonomy.md` §Never；入口只留高風險錨點（子集，非全部）：禁直推 main｜SQL 拼接｜PII 入 querystring｜email/路徑 入 repo｜未核准 copyleft｜破壞性 merge
細節見 `ai-autonomy.md`（含入口錨點取捨準則）
## 觸發式載入索引
leaf→`.devpro/agent-rules/<leaf>`；餘照路徑。若 root 有 `AGENTS.local.md`→先讀（additive-only，不可放寬）。Consumer：feat/bug→OpenSpec；PR→pre-pr；sync→doctor/smoke；fail→playbook。三禁：禁main/prod改、禁rules-sync污染feature、PR前測試/archive/security/PII/SQL。
|情境|讀取|
|---|---|
|停下等使用者／交棒|`stop-point-comms.md`|
|合理化/跳規|`ai-autonomy-rationalizations.md` §Common Rationalizations|
|維護 AGENTS.md|`agents-md-maintenance.md`|
|設計 rule/hook/cmd/agent/skill|`design-core.md`|
|跨模組設計／介面／ownership／候選方案／實作摩擦|`design-reasoning.md`|
|reviewer 保證上限／finding 分類義務|`review-guarantee-ceiling.md`|
|拆分/拆檔/dedup/de-bundle/protected-anchor|`doc-split-and-dedup-sop.md`|
|寫/改鎖規則的 grep anchor test|`rule-anchor-guard-strength.md`|
|審查/盤點/rationalize|`rule-audit-playbook.md`|
|自演/收斂|`rule-self-evolution.md`|
|ingest 外部 reference|`rule-ingest-methodology.md`|
|digest/proposal|`knowledge-digest.md`|
|distill/蒸餾/KB優化|`knowledge-distillation.md`|
|stdout>200/讀>100/skill·slash>5K|`token-frugal-io.md`|
|status/next-step／多步高成本／最短判定鏈|`workflow-cost-controls.md`|
|新專案/.nvmrc|`environment-setup-nvm-nodejs-openspec.md`|
|`.gitignore`/`.gitattributes` 對齊|`gitignore-alignment.md`|
|gh body/tmp|`file-write-destinations.md`|
|CI/CD|`ci-setup-components.md`|
|bug/fix/Others|`openspec-branch-routing.md`+`openspec-flow.md`|
|功能/行為|`openspec-flow.md`|
|全程勾稽/主線防漏步|`dev-flow-checklist.md`|
|OpenSpec/tasks/quality|`openspec-step-1-to-9.md`|
|Chore/pre-flight|`chore-classification.md`+`preflight-checklist.md`|
|TDD/QA|`testing-and-qa.md`|
|產品驗證入口／功能地圖／維護驗證 runbook|`project-verification.md`＋`/devpro:project-verify`|
|架構／模組文件整理／文件與實作 drift|`project-documentation.md`＋`/devpro:project-docs`|
|spawn 測試·效能|`test-performance-patterns.md`|
|寫 C# code/風格/DRY|`csharp-style-and-dry.md`|
|.NET新建/重組|`project-structure-sln-and-folders.md`|
|抽象/防禦/複雜|`anti-patterns-examples.md`+`code-simplification.md`|
|over-design/refactor|`pre-implementation-over-design.md`|
|DB/SQL/web資料安全/PII/log·存取稽核/貼出輸出·憑證遮蔽/非同步/AJAX/fetch/先發後至/後發先至/名單切換|`security-coding.md`|
|套件|`third-party-packages-licensing.md`|
|SQL Server 字串↔binary·建表index|`database-conventions.md`|
|DynamicForms consumer vendor bump／DLL 升級／SQL schema error|`dynamic-forms-consumer-sql-alignment.md`|
|branch/worktree|`git-branch-naming-and-anchor.md`+`branch-terminology-glossary.md`|
|準備 PR/push|`git-branch-and-pr-flow.md`+`code-review-checklist.md`|
|多 agent/subagent|`multi-agent-handoff.md`|
|委派/executor 決策序/continue/fresh/fork/admission 六欄/thread 換手|`model-delegation.md`|
|PR review/thread/evidence/cross-review/PR 後 completion|`code-review-checklist.md`+`post-pr-completion-gate.md`|
|source repo release|`release-sit-uat-pat-prod.md`|
|回補／同步已上線／已直合 production 補救|`release-already-live-backfill.md`|
|Session Recap|`session-recap.md`|
|pending/claim/並行|`session-pending-lifecycle.md`|
|CodeQL/prompt|`security-scanning.md`+`codeql-execution.md`|
|模糊/待確認|`ambiguity-scoring.md`＋`/devpro:clarify`（explore／pre-analyst recipe）|
|既有行為/current behavior/系統功能設計/system feature design/current design/intended behavior/current contract/現況設計/預期行為|`intent-lookup-order.md`|
|流程說詞/lexicon|`devpro-context-language.md`|
|consumer rules sync|`rules-flow.md`+`rules-flow-routing.md`|
|GitHub/gh/MCP 選路|`tool-selection.md`|
|adapter/runtime|`platform-adapter-contract.md`|
|obs|`observability-capabilities.md`|
|遠端審查/RunnerRelay/Hermes/`rr`/gateway 連線|`remote-review-gateway.md`|
|遷移|`platform-migration.md`|
|HTTP/status|`api-design-http-semantics.md`|
|E2E|`ci-cd-integration-deployment.md`|
|frontend/Web 主題/dark-light/多語系/i18n|`frontend-session.md`+`frontend-theming-and-i18n.md`|
|frontend/UI wireframe/孤立換行/中文硬折行/單一字換行|`frontend-ui-layout.md`|
|consumer/rules lane/Program Issue/doctor/smoke/fail|`consumer-adoption.md`|
|consumer overlay／local rules|`consumer-local-rules.md`|
|效能慢／benchmark 比較／量測改善|`performance-investigation.md`|
|測試失敗/偵錯|`troubleshooting.md`|
|失敗分流|`ai-autonomy.md`|
|PR/merge/push追workflow|`git-workflow-tracking.md`|
|branch清理/commit檢查|`git-branch-hygiene.md`|
|rigor/token|`rules-rigor-level.md`|
|DRY/SSOT corpus／新具名定義／copy-execute 模板|`dry-ssot-corpus.md`|
|反向自檢／宣告完成前／Recap 三行|`reverse-self-check.md`|
|consequence／副作用評估|`change-consequence-assessment.md`|
---
## 7. PROD 問題修復
bugfix/hotfix：`production-*`（無tag→bugfix）；合 main；production 只經 release carrier；回補已上線→`release-already-live-backfill.md`；SIT/UAT可縮不省→`release-sit-uat-pat-prod.md`
## 8. 同步作業
source release：source repo SemVer release → `release-sit-uat-pat-prod.md`；consumer sync → `rules-flow-routing.md` + `rules-flow.md`；consumer production rules lane / PR DIRTY recovery → `release-rules-lane.md`。禁在 AGENTS.md 複寫 branch/base/cherry-pick 細則。
## 9. Session 收尾 Gate
Recap/follow-up見 `session-recap.md`；累積收斂見 `rule-self-evolution.md`。AGENTS提醒：Recap→`devpro-tw/devpro-agent-rules` Discussions（位置固定，不列位置選項）、session-pending 是待追蹤缺口暫存、CI 終態需回報。
