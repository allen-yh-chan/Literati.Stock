import { readFileSync } from "node:fs";
import path from "node:path";

export const BYTES_PER_TOKEN = 3.5;

export const TIERS = Object.freeze({
  core: Object.freeze({
    files: Object.freeze(["ai-autonomy.md", "openspec-flow.md", "git-branch-and-pr-flow.md", "model-delegation.md", "release-sit-uat-pat-prod.md", "multi-agent-handoff.md", "rule-design-principles.md", "git-branch-naming-and-anchor.md", "openspec-flow-consumer.md", "release-step-1-7.md", "openspec-step-1-to-9.md", "code-review-checklist.md", "openspec-quality-and-formats.md", "anti-patterns-behavioral.md", "code-review-cross-model.md", "git-pr-template-and-merge.md", "session-recap.md", "rules-flow.md", "token-frugal-io.md", "design-core.md", "git-workflow-tracking.md", "git-branch-hygiene.md", "testing-and-qa.md", "chore-classification.md"]),
    maxTokens: 7500,
  }),
  next: Object.freeze({
    // Product verification owns three operating modes, resource/evidence lifetime and failure triage.
    // strengthen-subagent-delegation-strategy (decisions.md D15): model-delegation
    // sibling leaves — token-efficiency (~1721/3000 cap; lettered sub-checks keep
    // growing) and threads-and-caps (~1877/3000 cap; thread lifecycle + caps tables
    // moved out of the entry leaf).
    // #3172: exception-only ancestor recovery is an inventory/restoration/escalation
    // procedure, not a terse routing leaf; register in next (existing 3000 cap).
    // amend-token-tier-registration: remote-review-gateway.md is the RunnerRelay gateway
    // connection + remote-review submit contract, not a terse routing leaf; register in
    // next with a per-file cap (three-branch note at PER_FILE_MAX_OVERRIDE).
    // refactor-cross-model-review-leaf: code-review-cross-model-dispatch-mechanics.md holds
    // the script-enforced dispatch contracts split out of code-review-cross-model.md; it is
    // read on named error codes, fault-recovery or review-infra work, so next with a cap.
    files: Object.freeze(["design-reasoning.md", "release-already-live-backfill.md", "performance-investigation.md", "project-verification.md", "project-documentation.md", "test-suite-cadence.md", "consumer-pre-pr-checks.md", "pre-pr-dev-verification.md", "gitignore-alignment.md", "openspec-scope-change.md", "openspec-archive-redo-undo.md", "post-intervention-recovery-gate.md", "rules-flow-rollback.md", "rules-flow-production-continuation.md", "rule-load-ledger-internals.md", "model-delegation-active-lifecycle.md", "requirement-count-ratchet-internals.md", "environment-class2-checks.md", "session-recap-token-usage.md", "post-pr-marker-disposition.md", "post-pr-stop-hook-runtime.md", "release-hotfix-carrier-policy.md", "second-review-external-evaluator.md", "release-hotfix-carrier-lane.md", "release-back-merge-completion.md", "release-unselected-commit-handling.md", "gitattributes-alignment.md", "stop-point-comms.md", "rules-rigor-level.md", "ci-cd-integration-deployment.md", "frontend-session.md", "security-scanning.md", "csharp-style-and-dry.md", "openspec-flow-fallback.md", "code-review-checklist-fallback.md", "code-simplification.md", "file-write-destinations.md", "ambiguity-scoring.md", "codeql-execution.md", "pr-review-evidence-verification.md", "openspec-branch-routing.md", "rule-file-template.md", "preflight-checklist.md", "dev-flow-checklist.md", "test-performance-patterns.md", "database-conventions.md", "rules-consistency-checklist.md", "agents-md-maintenance.md", "troubleshooting.md", "platform-migration.md", "platform-adapter-contract.md", "pre-implementation-over-design.md", "rule-audit-playbook.md", "rule-ingest-methodology.md", "knowledge-distillation.md", "consumer-adoption.md", "model-delegation-delegation-rules.md", "model-delegation-briefing.md", "openspec-quality-doc-formats.md", "openspec-quality-advanced-patterns.md", "openspec-archive-principles.md", "code-review-cross-carrier.md", "program-tracker-mode.md", "program-planning-state.md", "release-rules-lane.md", "ai-autonomy-rationalizations.md", "observability-capabilities.md", "token-budget-precheck.md", "security-coding.md", "security-access-audit-trail.md", "doc-split-and-dedup-sop.md", "session-pending-lifecycle.md", "rule-anchor-guard-strength.md", "agent-skill-governance.md", "post-pr-completion-gate.md", "second-review-control-evidence.md", "second-review-ancestor-recovery.md", "second-review-operator-recovery.md", "proposal-template.md", "environment-setup-nvm-nodejs-openspec.md", "dry-ssot-corpus.md", "rule-self-evolution.md", "workflow-cost-controls.md", "model-delegation-token-efficiency.md", "model-delegation-threads-and-caps.md", "remote-review-gateway.md", "code-review-cross-model-dispatch-mechanics.md"]),
    maxTokens: 3000,
  }),
  small: Object.freeze({
    files: Object.freeze(["api-design-http-semantics.md", "openspec-spec-delta-pitfalls.md", "post-pr-warn-repair.md", "release-verification-commands.md", "release-milestone-assignment.md", "consumer-uninstall.md", "consumer-hook-file-maintenance.md", "change-consequence-assessment.md", "ci-setup-components.md", "project-structure-sln-and-folders.md", "rules-flow-routing.md", "third-party-packages-licensing.md", "knowledge-digest.md", "consumer-failure-playbook.md", "consumer-local-rules.md", "git-branch-no-tag-ancestry-evidence.md", "git-branch-production-ancestry-repair.md", "review-guarantee-ceiling.md", "design-template.md", "reverse-self-check.md"]),
    maxTokens: 1500,
  }),
  adapter: Object.freeze({
    files: Object.freeze(["platform-adapters/opencode.md", "platform-adapters/codex.md", "platform-adapters/codex-cli-tooling.md", "platform-adapters/codex-github-writes.md", "platform-adapters/codex-workflow-capabilities.md", "platform-adapters/codex-host-cross-review.md", "platform-adapters/cursor.md", "platform-adapters/claude-code-cross-review.md", "platform-adapters/copilot.md", "platform-adapters/gemini.md", "platform-adapters/claude-code.md", "platform-adapters/claude-code-effort-tiers.md", "platform-adapters/claude-code-capabilities.md", "platform-adapters/codex-effort-tiers.md"]),
    maxTokens: 10500,
  }),
});

export const PER_FILE_MAX_OVERRIDE = Object.freeze({
  // Governance split-dedup-review 2026-10-10, second batch (owner decision: files that
  // cannot be split under lite rigor and have no unlocked redundancy get the minimum
  // necessary cap; reasons below come from the 2026-10-10 spec/test pin survey).
  // ai-autonomy.md 10000 → 11500: measures 10900 tokens. Split not taken: the two
  // sections not named by a spec total about 841, short of the 900 needed, and Agent
  // Runtime Protection is named by the output-discipline and cross-runtime-parity specs,
  // so moving it is its own OpenSpec change. ceil((10900 + 250) / 500) * 500 = 11500.
  "ai-autonomy.md": 11500,
  // code-review-checklist.md 10000 → 10500 in strengthen-gate-threat-model-inheritance:
  // 本檔新增 R9 兩類 caveat 改寫、R11 需求錨定義務（三值 closed vocabulary、
  // referent 規則、severity 保全、TL 側具名拒收），以及 D13 對 whack-a-mole
  // 條款的第二具名例外面與 Root-Cause First 正交聲明。完整程序已依 D11 落在
  // canonical `openspec/specs/code-review-checklist/spec.md`；留在 leaf 的是
  // 兩個行為者的動作點判準，移走即讓審查者在 `:76` 讀不到判準。實測 10133 tok；
  // ceil((10133 + 250) / 500) * 500 = 10500 為最小 governed local cap。
  // owner 具名裁決提高（見 change decisions.md D5），配對的守門斷言釘值同步
  // 移動至 10500——釘值隨 cap 一起移動，才不會出現兩處互相矛盾的宣告。
  // code-review-checklist.md 10500 → 13000 in fix-review-dispatch-gaps:
  // 新增 `### Bounded Rereview Manifest Production`（manifest 欄位意義、三層
  // digest、seal-manifest／verify-manifest request 形狀）——R1 的唯一可操作載體，
  // 缺段即讓 TL 回頭逆向 test fixture（本 change 的根因）。沿用 readability over
  // threshold-fitting compression：欄位逐欄對 core 是防漂移不二法門，不可壓；
  // 段內 anchors 由本 change 的新 grep guard 綁 core 字面（本模組是 gate SSOT，
  // 依既有慣例不指名任何 test 檔；guard 身分由 change folder 記載）。
  // 實測 12324 tok（43134 B / 3.5）；ceil((12324 + 250) / 500) * 500 = 13000 為
  // 最小 governed local cap；配對守門斷言與 READABILITY_CAP_GUARDS 同步移動。
  // Governance split-dedup-review 2026-10-10, second batch (owner decision: files that
  // cannot be split under lite rigor and have no unlocked redundancy get the minimum
  // necessary cap; reasons below come from the 2026-10-10 spec/test pin survey).
  // code-review-checklist.md 13000 → 14500: measures 14225 tokens. Split not taken: the
  // paragraphs with no spec or test lock total about 1100, short of the 1225 needed, and
  // the tail sections are required to exist in this file by its spec.
  // ceil((14225 + 250) / 500) * 500 = 14500.
  // rationalize-rule-token-caps: grew to 15710 tokens (the cross-model dispatch-mechanics Load-chain line added 32); the split/trim rejection above
  //   still holds, so only the formula moves: ceil((15710 + 250) / 500) * 500 = 16000.
  "code-review-checklist.md": 16000,
  // code-review-cross-model.md 9500 → 10000 in strengthen-review-threat-model-severity:
  // 第二意見 scope 段新增 class-one severity ceiling／F-9 carve-out 判準（reviewer 動作點
  // 唯一可讀的 rule leaf 副本），實測 9565 tok（33476 B / 3.5）；
  // ceil((9565 + 250) / 500) * 500 = 10000 為最小 governed local cap。
  // 判準句的動作點可讀性不可壓（壓縮會讓 reviewer 誤讀成普遍降級）；配對的
  // READABILITY_CAP_GUARDS 斷言同步移動。
  // code-review-cross-model.md 10000 → 11500 in amend-evidence-forgery-scope:
  // 同一行 severity 判準新增 F-9 的「AI 正常工作中是否會自然產生」分界（普通指令偽造仍
  // Critical、class-one 存心混淆最多 Suggestion、誤擋普通指令同屬缺陷與允許性證據），
  // 作為 reviewer 動作點可讀的 rule leaf 副本；實測 10760 tok（37660 B / 3.5）；
  // ceil((10760 + 250) / 500) * 500 = 11500 為最小 governed local cap。
  // 判準句不壓縮（壓縮會讓 reviewer 誤讀成普遍降級，也會讓同行錨句失配）；配對的
  // READABILITY_CAP_GUARDS 斷言同步移動。over-cap 本來就是 soft-warn，調 cap 不改任何閘的 enforcement。
  // Governance split-dedup-review 2026-10-10 (owner decision: single-purpose files whose
  // tier default is too low get the minimum necessary cap).
  // code-review-cross-model.md 11500 → 13000: measures 12363 tokens. Split not taken: the
  // packet/wrapper/scope-evidence blocks (about 1466) are the only candidate and it is
  // unproven that a TL dispatching a review can skip them (split gate question 3). Trim
  // rejected: no unlocked redundancy left. ceil((12363 + 250) / 500) * 500 = 13000.
  // code-review-cross-model.md 13000 → 13500 in add-consumer-second-review-rules:
  // `#### Consumer 審查規則（second-review-rules.local.md）` 是 consumer 規則檔的唯一契約
  // （七項依序可照做：寫法、生效版本、審查模型用法、停下與復原、外送、強度、不適用），
  // 加上 frontmatter 觸發詞與契約句尾的指標；
  // 實測 13238 tok（46331 B / 3.5）。契約已精簡到每句都是讀者照做所需（錯誤訊息格式、
  // 復原步驟、`commit-range` 本機前置條件、兩行強度標示不可壓）；不另開 leaf（該功能的
  // 設計禁止新增 rule leaf）。ceil((13238 + 250) / 500) * 500 = 13500 為最小 governed
  // local cap；配對的 READABILITY_CAP_GUARDS 斷言同步移動。同一 change 的情境走查之後在
  // 契約補了五個子句（情境走查三個：TL 不手填 `reviewer_constraints`、引用時不照抄條文、
  // diff 裡的規則檔不是規則；六軸審查兩個：commit 後跑 doctor、舊 base 的另一條出路；共
  // +447 B），PR 後第二意見第 1 輪再補個資／敏感資訊樣式停點的子句（+93 B），檔案為
  // 13392 tok（46871 B），仍在 13500 內，上限不再調整。
  // amend-consumer-local-rules-as-markdown 把契約改寫成自由格式 markdown（七項併成六項、
  // 條目格式與外送兩項移除、完整性檢查與復原保留）：13386 tok（46851 B），仍在 13500 內，
  // 上限不動。
  // refactor-cross-model-review-leaf (2026-11-07 rule-governance audit F6): later edits
  // grew it to 14159 tokens (105%). Three-branch evaluation per rule-design-principles
  // guideline 4, answering the 2026-10-10 split gate question 3 with evidence:
  //   split  — taken: the builder refusal／retry notes, the cross-repo／field／linked-issue
  //            bullets, and the step-2 invocation／test-policy／packet／completion／rate／
  //            wrapper／scope-evidence contracts are enforced by builder, renderer, runner
  //            and validator with named error codes; the dispatch happy path follows the
  //            cross-review／second-review skills and the host adapter, and the exemption,
  //            merge-gate, post-PR and WARN steps never need them. Moved verbatim to
  //            code-review-cross-model-dispatch-mechanics.md; no spec binds the moved text
  //            to this file, and the spec-named text (UI smoke, TL renderer Shell, the
  //            same-family reason lead, Diff-shape, Path D′, Round Budget, Consumer 審查規則)
  //            stays here.
  //   trim   — rejected: the remainder is TL action points and spec-named text.
  //   raise  — not needed; the cap drops to ceil((11574 + 250) / 500) * 500 = 12000.
  // amend-gate-forgery-rule-for-waiver-records 12000 → 13000: the same-line severity criterion gains the
  //   closed per-pr-waiver-record-residual sentence, and the file measures 12336 tokens (43175 B / 3.5), so this
  //   change itself crosses the cap. Split rejected: the criterion must stay on the one severity line
  //   (the canonical requirement and cross-review-cli-skills-grep lock "same bullet and line"). Trim rejected:
  //   the criterion sentences are grep-locked action points and compressing them invites a reviewer to read a
  //   blanket downgrade. ceil((12336 + 250) / 500) * 500 = 13000; READABILITY_CAP_GUARDS moves in lockstep.
  "code-review-cross-model.md": 13000,
  // The 1→7 dispatch protocol and timeout policy measure 3812 tokens; the leaf is
  // already a single-trigger sibling split out of code-review-cross-model.md and its
  // steps are locked action points. ceil((3812 + 250) / 500) * 500 = 4500.
  "code-review-cross-model-cli-contract.md": 4500,
  // Script-enforced dispatch mechanics split out of code-review-cross-model.md (next
  // tier; the 3000 default is too small for the verbatim contracts):
  // ceil((4127 + 250) / 500) * 500 = 4500.
  "code-review-cross-model-dispatch-mechanics.md": 4500,
  // design-core.md 7500 → 9000 in strengthen-gate-threat-model-inheritance:
  // §11 是閘威脅模型分類的語料庫級 SSOT（兩類具名列與依性質判定的 residual、軸 B 三問、F-1…F-10
  // 具名反濫用清單）。owner directive favors readable rule text over
  // over-compression：壓縮過的判準在動作點看不懂，下游重讀與誤判的 token
  // 成本高於本節省下的。實測 8340 tok；ceil((8340 + 250) / 500) * 500 = 9000
  // 為最小 governed local cap。僅 design-core.md 取得此 headroom，其餘 core
  // tier 兄弟檔維持 7500 guard。
  // design-core.md 9000 → 10000 in amend-evidence-forgery-scope:
  // §11 F-9 列新增嚴重度分界（普通指令偽造仍 Critical、class-one 存心混淆最多 Suggestion、
  // 對稱條款與允許性證據），同列內聯不可拆；實測 9377 tok（32817 B / 3.5）；
  // ceil((9377 + 250) / 500) * 500 = 10000 為最小 governed local cap。不壓縮判準句；
  // 配對的 READABILITY_CAP_GUARDS 斷言同步移動。
  // Governance split-dedup-review 2026-10-10 (owner decision: single-purpose files whose
  // tier default is too low get the minimum necessary cap).
  // design-core.md 10000 → 10500: measures 10018 tokens, 18 over. Trim rejected: the one
  // unlocked duplicate was already removed and the rest is grep-locked classification
  // text. §7–§11 (about 6000) is splittable but is named by 5 specs and 14 tests, so it is
  // its own change; split it before any further raise. ceil((10018 + 250) / 500) * 500 = 10500.
  // rationalize-rule-token-caps (2026-11-08): the §7–§11 split asked for above was re-evaluated and the owner
  //   declined it. 11 requirements in 7 capability specs name §7, §8, §10 or §11 as living in this file
  //   (archive-tooling, pre-tool-mechanical-gates x2, output-discipline, design-core, code-review-checklist x3,
  //   openspec-flow x2, design-reasoning), so moving them needs full rigor with spec deltas, plus the AGENTS.md
  //   core-contract line, about 11 rule and skill carriers, the reviewer packet text in
  //   validate-second-review-packet.mjs and 10-12 tests. Only 10 of 497 local sessions (30 days, subagents
  //   included) loaded this file, so the cost outweighs the saving. The cap stays 10500 and the file stays
  //   over it (11056 tokens; over-cap is a soft signal). Do not reopen without new load or spec evidence.
  // rationalize-threat-model-token-caps (audit 2026-11-10): the accident-only threat model text took it to
  //   13032 tokens. That re-armed the audit, but no new load or spec evidence came with it; the owner kept
  //   the split declined and the cap at 10500.
  "design-core.md": 10500,
  "file-write-destinations.md": 5000,
  // The baseline／inventory／terminal-block／persistence-proof contract measures 3178
  // tokens with no removable prose (the `## Rules` bullets are required by the rule
  // anatomy check); ceil((3178 + 250) / 500) * 500 = 3500.
  "gitignore-alignment.md": 3500,
  // The eight-dimension table, closed disposition set and network-zone check measure
  // 1742 tokens with no removable prose; ceil((1742 + 250) / 500) * 500 = 2000.
  // rationalize-rule-token-caps: grew to 2014 tokens; the split/trim rejection above
  //   still holds, so only the formula moves: ceil((2014 + 250) / 500) * 500 = 2500.
  "change-consequence-assessment.md": 2500,
  // strengthen-subagent-delegation-strategy: the Executor 決策序 (steps 0-5) landed in
  // the entry leaf after moving the thread-lifecycle/caps tables to the sibling
  // model-delegation-threads-and-caps.md (decisions.md D15); measured 7739 tokens;
  // ceil((7739 + 250) / 500) * 500 = 8000.
  "model-delegation.md": 8000,
  // strengthen-subagent-delegation-strategy: outcome-mandatory / fresh-trigger
  // rewrite of the five role sections. Now 4161 tokens: the TL Tier／Effort Floor
  // tables are consulted whenever the TL decides whether it may do the work itself,
  // so they stay with the role sections. ceil((4161 + 250) / 500) * 500 = 4500.
  "model-delegation-delegation-rules.md": 4500,
  // strengthen-subagent-delegation-strategy: six-field admission record table;
  // measured 3225 tokens (11285 bytes / 3.5) after the round-1 duplicate-front-matter
  // repair; ceil((3225 + 250) / 500) * 500 = 3500. D34 added the conditional
  //   `parent_record_id` row (3404 tokens / 97.3%): still inside the cap, but
  //   the next expansion should split the leaf rather than raise the cap.
  // refactor-delegation-briefing-leaf: later growth reached 3555 tokens (101.6%). The
  //   dp-architect immutable dispatch block restated model-delegation.md's dp-architect
  //   dispatch action point (the entry that loads this leaf) and multi-agent-handoff.md,
  //   so it became one routing line: no new leaf, no cap change. Measured 3236 tokens
  //   (11325 bytes / 3.5); ceil((3236 + 250) / 500) * 500 = 3500.
  "model-delegation-briefing.md": 3500,
  // strengthen-subagent-delegation-strategy round-6: the same class the reviewer
  // named for workflow-cost-controls.md (F-r7-cost-controls-cap-breach-attributed-
  // out-of-scope) applies here too — this change grew the leaf from 7799 tokens at
  // the anchor (97.49% of 8000) to 8026 tokens, so the breach is self-caused, not
  // pre-existing. Three-branch: split rejected (the added fan-out/independence text
  // belongs with the cap tables it qualifies), trim rejected (both additions are
  // grep-locked operative clauses), raise taken at the minimum necessary cap
  // ceil((8026 + 250) / 500) * 500 = 8500.
  // rationalize-rule-token-caps: grew to 8610 tokens; the split/trim rejection above
  //   still holds, so only the formula moves: ceil((8610 + 250) / 500) * 500 = 9000.
  "multi-agent-handoff.md": 9000,
  // refactor-scope-change-leaf (decisions D2): after moving the requirement count ratchet
  // internals, the conditional spec delta pitfalls and the scope change sections out to
  // on-demand leaves, the entry measures 9725 tokens. Three-branch: split taken as far as
  // this change's scope allows (the Rule-feedback Surface Matrix section, about 400
  // tokens, is still splittable and was not taken because the owner chose to raise the
  // cap and other sections are out of scope); trim rejected (what the entry keeps is
  // the scope-change trigger, the mandatory pointer and the per-proposal carrier group
  // duty, so cutting it would be hard-trim-for-cap); raise taken at the minimum
  // necessary cap ceil((9725 + 250) / 500) * 500 = 10000. Next growth: split the
  // Rule-feedback Surface Matrix first instead of raising again; no bucket above the
  // formula.
  "openspec-quality-and-formats.md": 10000,
  // preflight-checklist.md 3500 → 4000 in add-already-live-backfill-record: the two
  // non-urgent already-live backfill copies (the entry paragraph and the pass-condition
  // line) each end with the one fixed lite pointer, pushing the file from 3487 to 3539
  // tokens. Trim rejected (both lines are unique-line anchors that carry load-bearing
  // normative wording); split rejected (the copies are this checklist's own pass
  // conditions). ceil((3539 + 250) / 500) * 500 = 4000.
  "preflight-checklist.md": 4000,
  // After removing the background paragraph and four same-file restatements the
  // five hard rules with their worked examples measure 4225 tokens; examples are used
  // at the same moment as the rules. ceil((4225 + 250) / 500) * 500 = 4500.
  "stop-point-comms.md": 4500,
  // Per-Session Usage Telemetry T12 Support marker pushed 6997→7032 tokens
  // (no claude-code.md-style sibling file to offload into); cap 7000→7500 via
  // the min-necessary-cap formula (decisions.md).
  "platform-adapters/codex.md": 7500,
  // amend-gate-forgery-rule-for-waiver-records: the cursor severity line gains the per-pr-waiver-record-residual
  //   pointer subset (INFO only while the open-PR checks compare the line with the answer-time record,
  //   otherwise F-9; full text in code-review-cross-model.md) and the file measures 10537 tokens
  //   (36877 B / 3.5), 37 over the adapter default. Split rejected: the subset is the same-line severity
  //   pointer the cross-review guards lock, as the batch subset already is. Trim rejected: the subset is
  //   already the shortest form that names the identifier, the condition and the F-9 fallback.
  //   ceil((10537 + 250) / 500) * 500 = 11000.
  "platform-adapters/cursor.md": 11000,
  "platform-adapters/claude-code-cross-review.md": 11500,
  // Governance split-dedup-review 2026-10-10, third batch (owner decision).
  // platform-adapters/codex-host-cross-review.md 16500 → 18500: measures 18004 tokens.
  // Split not taken: the only part large enough is the fixed system-prompt mirror (about
  // 1355), a runtime payload that a test keeps byte-equal to the reviewer CLI recipe
  // contract; removing it would change how a Codex host reads the recipe. The unlocked same-file restatements total about 285, short of the 1504
  // needed. ceil((18004 + 250) / 500) * 500 = 18500.
  "platform-adapters/codex-host-cross-review.md": 18500,
  // After dropping the duplicated `command -v gh` bullet the fault table measures 2004
  // tokens; the probe history stays here by design. ceil((2004 + 250) / 500) * 500 = 2500.
  "platform-adapters/codex-host-cross-review-troubleshooting.md": 2500,
  // ChangeContext + Ready Response growth: post-PR completion SSOT (~5629/6000)
  "post-pr-completion-gate.md": 6000,
  // update-spec-pinned-rule-caps (owner decision 2026-10-10). The token-budget-tooling spec
  // names this leaf and requires its cap to equal the formula of the measured carrier.
  // release-rules-lane.md 4500 → 5500: measures 5175 tokens. Split rejected: create,
  // verify, smoke and promotion are all walked every time a rules release is cut. Hard
  // trim rejected: the recipe is copy-pasted as written. The rollback key points (about
  // 234 tokens) are an action-point summary with a pointer to rules-flow.md, kept so the
  // leaf is self-contained; even without them the formula value stays 5500.
  // ceil((5175 + 250) / 500) * 500 = 5500; 6000 is above-formula and forbidden.
  "release-rules-lane.md": 5500,
  // Step 7 hotfix carrier recipe moved verbatim out of release-step-1-7.md; one
  // copy-execute sequence (T1–T4, tag, back-merge) plus the grandfathered completion.
  // 4311 tokens at the split; 4851 after the consumer migration self-check joined it,
  // still inside the 5000 set from ceil((4311 + 250) / 500) * 500.
  "release-hotfix-carrier-lane.md": 5000,
  // refactor-release-rule-carriers (2026-10-12): owner requires no semantic loss;
  // preserve the four actual carriers byte-for-byte and use narrow formula caps.
  // Release entry: finalized-baseline/content/approval boundaries are action-point
  // contracts, not duplicated prose. A further split has no proven common-path gain.
  // ceil((8606 + 250) / 500) * 500 = 9000.
  "release-sit-uat-pat-prod.md": 9000,
  // Seven-step recipe: hotfix/exception/back-merge leaves are already conditional;
  // the remaining snapshot, assembly, promotion and effect-time checks are coupled.
  // Do not collapse them into shorthand or move them into another always-read leaf.
  // ceil((10007 + 250) / 500) * 500 = 10500.
  "release-step-1-7.md": 10500,
  // Verification: one on-demand checkpoint recipe; content/domain, fresh selection,
  // own-merge transition and remaining effects need explicit failure boundaries.
  // ceil((1777 + 250) / 500) * 500 = 2500.
  "release-verification-commands.md": 2500,
  // Testing/QA: verdict capture and copy-execute template/acceptance instructions
  // remain self-contained; removing repeated field names would obscure how to fill it.
  // ceil((7617 + 250) / 500) * 500 = 8000.
  // rationalize-rule-token-caps: grew to 8097 tokens; the split/trim rejection above
  //   still holds, so only the formula moves: ceil((8097 + 250) / 500) * 500 = 8500.
  "testing-and-qa.md": 8500,
  // Step 1 補充 exception path moved verbatim out of release-step-1-7.md.
  // 1656 tokens; ceil((1656 + 250) / 500) * 500 = 2000.
  "release-unselected-commit-handling.md": 2000,
  "rule-audit-playbook.md": 4500,
  // #2980: after removing the two merged-PR #2927 one-shot recovery procedures the
  // full contract measured 10741 tokens; ceil((10741 + 250) / 500) * 500 = 11000.
  // refactor-second-review-operator-recovery: 19 later commits grew it to 15173 tokens
  // (138%). Three-branch evaluation per rule-design-principles guideline 4:
  //   split  — taken: the three operator-only recovery entries (legacy diagnostic
  //            closure, credential-gate receipt recovery, interrupted runner
  //            disposition) moved verbatim to second-review-operator-recovery.md;
  //            normal reviews never run them, so the doc-split decision gate passes.
  //   trim   — rejected: the remaining dispatch／terminal／evidence／gate text is the
  //            normative reviewer and merge-gate contract; hard-trim-for-cap is banned.
  //   raise  — taken for the remainder: ceil((12589 + 250) / 500) * 500 = 13000.
  "second-review-control-evidence.md": 13000,
  // Operator-only recovery entries split out of second-review-control-evidence.md
  // (next tier, 3000 default is too small for the verbatim procedures):
  // ceil((3547 + 250) / 500) * 500 = 4000.
  "second-review-operator-recovery.md": 4000,
  // #2974: the path／claim／handoff-grade contract measures 3916 tokens with no
  // removable prose; ceil((3916 + 250) / 500) * 500 = 4500.
  // rationalize-rule-token-caps: grew to 4590 tokens; the split/trim rejection above
  //   still holds, so only the formula moves: ceil((4590 + 250) / 500) * 500 = 5000.
  "session-pending-lifecycle.md": 5000,
  // refactor-suite-exclusivity-to-cadence-leaf (owner decision 2026-10-11).
  // test-performance-patterns.md 5500 → 5000: the gate／release suite exclusivity section
  // moved verbatim to test-suite-cadence.md and this file keeps a one-line pointer; it
  // measures 4587 tokens. Split rejected: the patterns are not mutually exclusive paths and
  // common spawn work needs several at once. Hard trim rejected: titles and anchored
  // pattern text are grep-locked. The token-budget-tooling spec names this leaf and
  // requires its cap to equal the formula of the measured carrier.
  // ceil((4587 + 250) / 500) * 500 = 5000; 5500 is above-formula and forbidden.
  "test-performance-patterns.md": 5000,
  "token-budget-precheck.md": 3500,
  // Governance split-dedup-review 2026-10-10 (owner decision: single-purpose files whose
  // tier default is too low get the minimum necessary cap).
  // ambiguity-scoring.md 4500 → 5500: measures 4808 tokens. Split rejected: the round
  // policy triggers on the score threshold defined in the scoring half, so neither half
  // can be skipped (split gate question 3). Trim rejected: the remaining prose is
  // branches and stop conditions locked by tests. ceil((4808 + 250) / 500) * 500 = 5500.
  "ambiguity-scoring.md": 5500,
  "security-access-audit-trail.md": 4000,
  // testing-and-qa.md had a 9000 override until its test suite cadence section moved to
  // test-suite-cadence.md. It now measures 6956 tokens; ceil((6956 + 250) / 500) * 500 = 7500
  // equals the core tier default, so the override and its guard are removed.
  // refactor-test-suite-cadence-leaf (owner decision 2026-10-11): the test suite cadence
  // section moved verbatim out of testing-and-qa.md into this Load-chain leaf, which
  // measures 4394 tokens and fits neither small (1500) nor next (3000). Splitting it in two
  // was rejected because the `--tier all` bullet refers to "本節其他明示例外" in the first
  // half and the test-governance spec names one sole SSOT for test suite cadence.
  // ceil((4394 + 250) / 500) * 500 = 5000.
  // refactor-suite-exclusivity-to-cadence-leaf (2026-10-11) added the gate／release suite
  // exclusivity section moved verbatim from test-performance-patterns.md: the rule applies
  // when a gate or release suite is run, which is this leaf's subject. It now measures
  // 4705 tokens; ceil((4705 + 250) / 500) * 500 = 5000, so the cap is unchanged.
  "test-suite-cadence.md": 5000,
  // refactor-consumer-pre-pr-checks-leaf (owner decision 2026-10-11): the consumer pre-PR
  // checks contract moved verbatim out of consumer-local-rules.md into this Load-chain
  // leaf, which measures 5533 tokens and fits neither small (1500) nor next (3000).
  // Splitting it further was rejected: the section's internal references ("下方「停點」",
  // "見「信任邊界」最後一點") point inside it and the openspec-flow spec names one section
  // as the contract SSOT. Trim rejected: the moved text must stay byte-identical.
  // ceil((5533 + 250) / 500) * 500 = 6000; 6500 is above-formula and forbidden.
  "consumer-pre-pr-checks.md": 6000,
  "database-conventions.md": 4000,
  // strengthen-gate-threat-model-inheritance round 2（`F-2b98f5031ce74a6d`）：當時實測約 3495 tokens、
  // cap 3500。內容是 §11 class two floor 六項的薄投影，語意不可再壓，故不做 trim。
  // 現為 3800 tokens：fallback 必須自足（Others runtime 不能依賴主檔載入鏈），屬單一觸發、
  // 每次全讀；ceil((3800 + 250) / 500) * 500 = 4500。兩張表的值 MUST 同步。
  "code-review-checklist-fallback.md": 4500,
  // rationalize-rule-token-caps: grew to 3864 tokens; the split/trim rejection above
  //   still holds, so only the formula moves: ceil((3864 + 250) / 500) * 500 = 4500.
  "agent-skill-governance.md": 4500,
  "program-tracker-mode.md": 3500,
  // strengthen-subagent-delegation-strategy round-6 F-r7-cost-controls-cap-breach-
  // attributed-out-of-scope: the half-state authorization-priority ladder plus the
  // evaluation-face limiting clause (decisions.md D40) grew the leaf from 2082
  // tokens at the change anchor (69.40% of the 3000 next-tier cap) to 3111 tokens
  // (10887 bytes / 3.5), so this change — not pre-existing corpus debt — put it
  // over. Three-branch evaluation per rule-design-principles guideline 4:
  //   split  — rejected: the added text is two operative clauses inside one
  //            existing bullet of §Review Remediation Cost Stop-Loss; a sibling
  //            leaf for them would break the single entry pointer the whole
  //            half-state ladder is read through.
  //   trim   — rejected: both clauses are polarity-bound and grep-locked
  //            (locked by the workflow-cost-controls grep test; this module is
  //            the gate SSOT and must not name test files); shortening either one is
  //            what produced F-r6-evaluation-face-clause-drops-new-qualifier.
  //   raise  — taken, at the minimum necessary cap:
  //            ceil((3111 + 250) / 500) * 500 = 3500.
  // Governance split-dedup-review 2026-10-10, second batch (owner decision: files that
  // cannot be split under lite rigor and have no unlocked redundancy get the minimum
  // necessary cap; reasons below come from the 2026-10-10 spec/test pin survey).
  // workflow-cost-controls.md 3500 → 5000: measures 4359 tokens. Split not taken here:
  // Stop-Loss + Review Wave Discipline (about 2826) is the splittable part, but the
  // workflow-cost-controls spec has requirements on that text and three hook messages
  // send readers to this file for it, so moving it is its own OpenSpec change; split it
  // before any further raise.
  // ceil((4359 + 250) / 500) * 500 = 5000.
  "workflow-cost-controls.md": 5000,
  // add-web-theme-locale-design-check: leaf carries design.md D5 (SSOT
  // export-channel decision + copy-executable judgment command + CE-1~7
  // table) and D9 (theme/locale verbatim clauses + Accept-Language 12-stage
  // pipeline + worked examples) transcribed near-verbatim per decisions.md
  // D12 finding #1. round 4/D13 scope-change (F9/F10/F13, T17-T19) added
  // the conflict fail-closed clause, three OPERATIVE_ANCHORS entries, and
  // the 1c worked example, pushing the leaf to 7433/26015B; T20 re-measured
  // and bumped via the D25 min-necessary-cap formula
  // ceil((7433+250)/500)*500 = 8000.
  // round 10/D37 remediation (F-W10, T31) added the delimiter-consistency
  // clause + second example fence, pushing the leaf to 8162/28564B; bumped
  // via the same min-necessary-cap formula ceil((8162+250)/500)*500 = 8500.
  // round 22/D50 remediation (F-page1/F-page16/F-page17) added the
  // hasMixedListSeparators read-side fail-closed guard clause + updated
  // judgment command, pushing the leaf to 9192/32169B; bumped via the same
  // min-necessary-cap formula ceil((9192+250)/500)*500 = 9500.
  "frontend-theming-and-i18n.md": 9500,
  // Governance split-dedup-review 2026-10-10, second batch (owner decision: files that
  // cannot be split under lite rigor and have no unlocked redundancy get the minimum
  // necessary cap; reasons below come from the 2026-10-10 spec/test pin survey).
  // proposal-template.md 3000 → 4500: measures 3979 tokens. Split not taken: the
  // movable part is about 367, short of the 979 needed, and tests require the template
  // itself to carry its headings. ceil((3979 + 250) / 500) * 500 = 4500.
  "proposal-template.md": 4500,
  // rules-rigor-level.md 3000 → 4000: measures 3394 tokens. Split not taken: the movable
  // part is about 245, short of the 394 needed. ceil((3394 + 250) / 500) * 500 = 4000.
  "rules-rigor-level.md": 4000,
  // amend-token-tier-registration (2026-11-07 rule-governance audit F2): the leaf was
  // never registered, so it ran on the small fallback at 3172/1500 tokens (211%); next
  // alone is still 106%. Three-branch evaluation per rule-design-principles guideline 4:
  //   split  — rejected: the submit path reads 個人設定 → Fail Closed → 送審入口 in order
  //            (no mutually exclusive branches), and §Fail Closed points at the alias
  //            template above it, so a split creates a leaf→leaf chain and fails the
  //            doc-split-and-dedup-sop decision gate.
  //   trim   — rejected: no true duplication; anchors are locked by the
  //            remote-review-gateway grep test.
  //   raise  — taken: ceil((3172 + 250) / 500) * 500 = 3500.
  "remote-review-gateway.md": 3500,
  // rationalize-rule-token-caps (audit 2026-11-07, item 8): these leaves had no recorded disposition
  //   and ran over their tier default. Each was checked for the doc-split-and-dedup-sop.md split gate
  //   and for lines carried elsewhere; none could go without losing load-bearing text, so each takes the cap
  //   (2026-10-10 owner decision: a single-purpose file whose tier default is too low gets it).
  // environment-setup-nvm-nodejs-openspec.md: one setup procedure (nvm, Node.js, OpenSpec, gh, Playwright) whose steps run in order; no A/B
  //   path to split and no line carried elsewhere. 3676 tokens;
  //   ceil((3676 + 250) / 500) * 500 = 4000.
  "environment-setup-nvm-nodejs-openspec.md": 4000,
  // consumer-failure-playbook.md: one symptom-to-action triage table. Its only verbatim repeats are two consumer-adoption-matrix
  //   command lines (about 47 tokens; dropping them would allow 2000) that triage readers run in place, so they stay.
  //   1793 tokens; ceil((1793 + 250) / 500) * 500 = 2500.
  "consumer-failure-playbook.md": 2500,
  // openspec-archive-principles.md: archive principles in one section (re-do/undo already routed out); its verbatim repeats
  //   (about 154 tokens, mainly one line shared with openspec-step-1-to-9.md) would leave the
  //   formula cap at 4000. 3528 tokens;
  //   ceil((3528 + 250) / 500) * 500 = 4000.
  "openspec-archive-principles.md": 4000,
  // review-guarantee-ceiling.md: one admission/verification/output contract kept in the small tier. 1718 tokens;
  //   ceil((1718 + 250) / 500) * 500 = 2000.
  "review-guarantee-ceiling.md": 2000,
  // pre-implementation-over-design.md: kickoff checks that share one trigger (before implementation starts) and are read
  //   together; no line carried elsewhere. 3287 tokens;
  //   ceil((3287 + 250) / 500) * 500 = 4000.
  "pre-implementation-over-design.md": 4000,
  // second-review-external-evaluator.md: audit-only and PR sticky are separate modes, but the audit-only section relies on the
  //   void/reissue flow written under PR sticky, so split gate question 3 fails. 3267 tokens;
  //   ceil((3267 + 250) / 500) * 500 = 4000.
  "second-review-external-evaluator.md": 4000,
  // troubleshooting.md: one debugging order with its evidence ledger and report; no line carried elsewhere. 3074 tokens;
  //   ceil((3074 + 250) / 500) * 500 = 3500.
  "troubleshooting.md": 3500,
  // rules-flow.md: 11 tokens over the core default. Its Primary-Checkout Close-out heading (about 1756
  //   tokens) also holds the sync lane's production continuation, base choice, smoke and CI N/A rules
  //   that every sync reads, and its two close-out paragraphs are kept in five carriers by a parity
  //   test, so fix-carrier-reference-drift found no split; verbatim repeats (about 40 tokens) would
  //   not change the cap. 7511 tokens; ceil((7511 + 250) / 500) * 500 = 8000.
  "rules-flow.md": 8000,
  // design-template.md: registered in TIERS.small like change-consequence-assessment.md, since next-tier 3000
  //   would exceed the formula; one template with its required sections. 1516 tokens;
  //   ceil((1516 + 250) / 500) * 500 = 2000.
  // ai-autonomy-rationalizations.md (rationalize-threat-model-token-caps, audit 2026-11-10): the accident-only
  //   threat model rows took it 44 tokens past its next default with no recorded disposition. One rationalization
  //   table read as a whole; no line carried elsewhere. 3044 tokens; ceil((3044 + 250) / 500) * 500 = 3500.
  "ai-autonomy-rationalizations.md": 3500,
  "design-template.md": 2000,
});

export const READABILITY_CAP_GUARDS = Object.freeze({
  "AGENTS.md": 10500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 ai-autonomy.md 11500（理由見該處）。
  ".devpro/agent-rules/ai-autonomy.md": 11500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 code-review-checklist.md 16000（理由見該處）。
  ".devpro/agent-rules/code-review-checklist.md": 16000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 code-review-cross-model.md 13000（理由見該處）。
  ".devpro/agent-rules/code-review-cross-model.md": 13000,
  ".devpro/agent-rules/code-review-cross-model-cli-contract.md": 4500,
  ".devpro/agent-rules/code-review-cross-model-dispatch-mechanics.md": 4500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 design-core.md 10500（理由見該處）。
  ".devpro/agent-rules/design-core.md": 10500,
  ".devpro/agent-rules/file-write-destinations.md": 5000,
  ".devpro/agent-rules/gitignore-alignment.md": 3500,
  ".devpro/agent-rules/change-consequence-assessment.md": 2500,
  ".devpro/agent-rules/model-delegation.md": 8000,
  ".devpro/agent-rules/model-delegation-delegation-rules.md": 4500,
  ".devpro/agent-rules/model-delegation-briefing.md": 3500,
  // Paired with the PER_FILE_MAX_OVERRIDE entry above; see its three-branch note.
  ".devpro/agent-rules/multi-agent-handoff.md": 9000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 openspec-quality-and-formats.md 10000（理由見該處）。
  ".devpro/agent-rules/openspec-quality-and-formats.md": 10000,
  // Paired with the PER_FILE_MAX_OVERRIDE entry above (add-already-live-backfill-record).
  ".devpro/agent-rules/preflight-checklist.md": 4000,
  ".devpro/agent-rules/stop-point-comms.md": 4500,
  // Per-Session Usage Telemetry T12 Support marker pushed 6997→7032 tokens
  // (no claude-code.md-style sibling file to offload into); cap 7000→7500 via
  // the min-necessary-cap formula (decisions.md).
  ".devpro/agent-rules/platform-adapters/codex.md": 7500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 platform-adapters/cursor.md 11000（理由見該處）。
  ".devpro/agent-rules/platform-adapters/cursor.md": 11000,
  ".devpro/agent-rules/platform-adapters/claude-code-cross-review.md": 11500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 codex-host-cross-review.md 18500（理由見該處）。
  ".devpro/agent-rules/platform-adapters/codex-host-cross-review.md": 18500,
  ".devpro/agent-rules/platform-adapters/codex-host-cross-review-troubleshooting.md": 2500,
  ".devpro/agent-rules/post-pr-completion-gate.md": 6000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 proposal-template.md 4500（理由見該處）。
  ".devpro/agent-rules/proposal-template.md": 4500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 rules-rigor-level.md 4000（理由見該處）。
  ".devpro/agent-rules/rules-rigor-level.md": 4000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 release-rules-lane.md 5500（理由見該處）。
  ".devpro/agent-rules/release-rules-lane.md": 5500,
  // Paired with the four faithful-carrier overrides above; shared tiers unchanged.
  ".devpro/agent-rules/release-sit-uat-pat-prod.md": 9000,
  ".devpro/agent-rules/release-step-1-7.md": 10500,
  ".devpro/agent-rules/release-verification-commands.md": 2500,
  ".devpro/agent-rules/testing-and-qa.md": 8500,
  ".devpro/agent-rules/release-hotfix-carrier-lane.md": 5000,
  ".devpro/agent-rules/release-unselected-commit-handling.md": 2000,
  ".devpro/agent-rules/rule-audit-playbook.md": 4500,
  ".devpro/agent-rules/git-branch-naming-and-anchor.md": 7500,
  ".devpro/agent-rules/second-review-control-evidence.md": 13000,
  ".devpro/agent-rules/second-review-operator-recovery.md": 4000,
  ".devpro/agent-rules/session-pending-lifecycle.md": 5000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 test-performance-patterns.md 5000（理由見該處）。
  ".devpro/agent-rules/test-performance-patterns.md": 5000,
  ".devpro/agent-rules/token-budget-precheck.md": 3500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 ambiguity-scoring.md 5500（理由見該處）。
  ".devpro/agent-rules/ambiguity-scoring.md": 5500,
  ".devpro/agent-rules/rule-anchor-guard-strength.md": 3000,
  ".devpro/agent-rules/security-access-audit-trail.md": 4000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 test-suite-cadence.md 5000（理由見該處）。
  ".devpro/agent-rules/test-suite-cadence.md": 5000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 consumer-pre-pr-checks.md 6000（理由見該處）。
  ".devpro/agent-rules/consumer-pre-pr-checks.md": 6000,
  ".devpro/agent-rules/database-conventions.md": 4000,
  // 配對 PER_FILE_MAX_OVERRIDE 的 code-review-checklist-fallback.md 4500（理由見該處）。
  ".devpro/agent-rules/code-review-checklist-fallback.md": 4500,
  ".devpro/agent-rules/agent-skill-governance.md": 4500,
  ".devpro/agent-rules/program-tracker-mode.md": 3500,
  // Paired with the PER_FILE_MAX_OVERRIDE entry above; see its three-branch note.
  ".devpro/agent-rules/workflow-cost-controls.md": 5000,
  ".devpro/agent-rules/frontend-theming-and-i18n.md": 9500,
  // 配對 PER_FILE_MAX_OVERRIDE 的 remote-review-gateway.md 3500（理由見該處）。
  ".devpro/agent-rules/remote-review-gateway.md": 3500,
  // Paired with the rationalize-rule-token-caps PER_FILE_MAX_OVERRIDE entries above.
  ".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md": 4000,
  ".devpro/agent-rules/consumer-failure-playbook.md": 2500,
  ".devpro/agent-rules/openspec-archive-principles.md": 4000,
  ".devpro/agent-rules/review-guarantee-ceiling.md": 2000,
  ".devpro/agent-rules/pre-implementation-over-design.md": 4000,
  ".devpro/agent-rules/second-review-external-evaluator.md": 4000,
  ".devpro/agent-rules/troubleshooting.md": 3500,
  ".devpro/agent-rules/rules-flow.md": 8000,
  ".devpro/agent-rules/design-template.md": 2000,
  // Paired with the rationalize-threat-model-token-caps PER_FILE_MAX_OVERRIDE entry above.
  ".devpro/agent-rules/ai-autonomy-rationalizations.md": 3500,
});

export function isRuleTokenCarrier(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  return normalized === "AGENTS.md" || /^\.devpro\/agent-rules\/.+\.md$/.test(normalized);
}

export function findRuleTokenTier(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  if (normalized === "AGENTS.md") {
    return Object.freeze({ name: "agents", filename: "AGENTS.md", unit: "bytes", cap: READABILITY_CAP_GUARDS["AGENTS.md"] });
  }
  if (!normalized.startsWith(".devpro/agent-rules/")) return null;
  const filename = normalized.slice(".devpro/agent-rules/".length);
  const memberships = Object.entries(TIERS).filter(([, tier]) => tier.files.includes(filename));
  const base = memberships.length === 1 ? memberships[0] : ["unregistered", TIERS.small];
  return Object.freeze({
    name: base[0],
    filename,
    unit: "tokens",
    cap: PER_FILE_MAX_OVERRIDE[filename] ?? base[1].maxTokens,
    memberships: memberships.map(([name]) => name),
  });
}

export function validateRuleTokenRegistry(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  const policy = findRuleTokenTier(normalized);
  if (policy === null) return Object.freeze({ registry: "not-applicable", guard: "not-applicable" });
  if (policy.unit === "bytes") {
    return Object.freeze({ registry: "pass", guard: READABILITY_CAP_GUARDS[normalized] === policy.cap ? "pass" : "block" });
  }
  const guard = READABILITY_CAP_GUARDS[normalized];
  const hasOverride = Object.hasOwn(PER_FILE_MAX_OVERRIDE, policy.filename);
  return Object.freeze({
    registry: policy.memberships.length <= 1 ? "pass" : "block",
    guard: guard === undefined ? (hasOverride ? "block" : "pass") : guard === policy.cap ? "pass" : "block",
  });
}

export function measureRuleTokenBudget({ cwd, manifest, readFile = readFileSync }) {
  if (!manifest || manifest.state === "unknown") {
    return freezeResult({ scope: "unknown", checked: 0, files: [], verdict: "block" });
  }
  if (manifest.state === "known-empty") {
    return freezeResult({ scope: "known-empty", checked: 0, files: [], verdict: "pass" });
  }

  const records = [];
  for (const entry of manifest.entries ?? []) {
    for (const target of objectiveTargets(entry)) {
      const policy = findRuleTokenTier(target.path);
      if (policy === null) continue;
      if (target.deleted) {
        records.push({ path: target.path, status: target.status, bytes: null, tokens: null, tier: policy.name, cap: policy.cap, utilization: null, registry: "not-applicable", guard: "not-applicable", reason: "none", verdict: "pass", semanticReview: "not-triggered" });
        continue;
      }
      try {
        const body = readFile(path.join(cwd, target.path));
        const bytes = Buffer.byteLength(body);
        const tokens = Math.ceil(bytes / BYTES_PER_TOKEN);
        const actual = policy.unit === "bytes" ? bytes : tokens;
        const integrity = validateRuleTokenRegistry(target.path);
        // Threshold exceedance alone (actual > cap / AGENTS HARD) is soft: verdict stays
        // pass and utilization may exceed 100. Definition integrity (registry/guard)
        // remains hard fail-closed; when both present, integrity wins (F1).
        const integrityBlock =
          integrity.registry === "block" || integrity.guard === "block";
        const verdict = integrityBlock ? "block" : "pass";
        records.push({
          path: target.path,
          status: target.status,
          bytes,
          tokens,
          tier: policy.name,
          cap: policy.cap,
          utilization: Number(((actual / policy.cap) * 100).toFixed(2)),
          registry: integrity.registry,
          guard: integrity.guard,
          reason: "none",
          verdict,
          semanticReview: actual / policy.cap >= 0.8 ? "required" : "not-triggered",
        });
      } catch (error) {
        records.push({ path: target.path, status: target.status, bytes: null, tokens: null, tier: policy.name, cap: policy.cap, utilization: null, registry: "unknown", guard: "unknown", reason: objectiveFailureReason(error), verdict: "block", semanticReview: "not-triggered" });
      }
    }
  }
  records.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
  return freezeResult({
    scope: records.length === 0 ? "known-empty" : "known-nonempty",
    checked: records.length,
    files: records,
    verdict: records.some((record) => record.verdict === "block") ? "block" : "pass",
  });
}

function objectiveFailureReason(error) {
  if (error instanceof TypeError) return "measurement-error:INVALID_BODY";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : null;
  if (code !== null) return `read-error:${code}`;
  return "measurement-error:UNKNOWN";
}

export function normalizeRepoPath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function objectiveTargets(entry) {
  const status = String(entry.status ?? "").toUpperCase();
  const kind = status[0];
  const oldPath = normalizeRepoPath(entry.oldPath);
  const newPath = normalizeRepoPath(entry.newPath);
  if (kind === "D") return isRuleTokenCarrier(oldPath) ? [{ path: oldPath, status, deleted: true }] : [];
  if (kind === "R" || kind === "C") {
    const targets = [];
    if (isRuleTokenCarrier(oldPath) && !isRuleTokenCarrier(newPath)) targets.push({ path: oldPath, status, deleted: true });
    if (isRuleTokenCarrier(newPath)) targets.push({ path: newPath, status, deleted: false });
    return targets;
  }
  const finalPath = newPath || oldPath;
  return isRuleTokenCarrier(finalPath) ? [{ path: finalPath, status, deleted: false }] : [];
}

function freezeResult(result) {
  for (const file of result.files) Object.freeze(file);
  Object.freeze(result.files);
  return Object.freeze(result);
}
