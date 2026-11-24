/**
 * loop-termination-rule-anchors.test.mjs
 *
 * Locks the grep-locked prose anchors landed by
 * `strengthen-cross-review-loop-termination` (design.md D1 / D9 / D12):
 *   - post-pr-warn-repair.md         R1 WARN Decision Contract 收斂謂詞反轉
 *   - post-pr-completion-gate.md      R10 post-archive 修復落點
 *   - code-review-cross-model.md      R2 §Round Budget（cap 3 + lane 標註 + override）、R3 Path D′、
 *                                     R5 focused sticky-refresh MUST、R6 carrier class / tracked_follow_up、
 *                                     R7 fault 分流、R8 帳本紀律
 *   - openspec-quality-and-formats.md R8 cross-model round 不是 decisions trigger
 *   - testing-and-qa.md               R9 qa-test-scope Commit 欄 parent SHA
 *   - openspec-archive-redo-undo.md   R10 archived-folder in-place 編輯 carve-out
 *                                     （openspec-archive-principles.md 只留 MUST 指標）
 *
 * Test-shape rules (rule-anchor-guard-strength.md): every anchor is a same-line
 * compound regex binding the literal to its polarity token, so a later edit that
 * keeps the literal but flips the polarity (or moves the cap literal away from its
 * lane label) turns this file red. Markdown emphasis is normalized away before
 * matching so `**MUST**` and `MUST` are equivalent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Strip Markdown emphasis (`**`) but keep glob stars such as `openspec/changes/**`.
const norm = (s) => s.replace(/\/\*\*/g, "\u0000GLOB").replace(/\*\*/g, "").replace(/\u0000GLOB/g, "/**");
const read = (rel) => norm(readFileSync(path.join(ROOT, rel), "utf8"));
const lines = (rel) => read(rel).split("\n");
const only = (rel, re) => {
  const hits = lines(rel).filter((l) => re.test(l));
  assert.equal(hits.length, 1, `${rel}: expected exactly one line matching ${re}, got ${hits.length}`);
  return hits[0];
};
const has = (line, re, label) => assert.match(line, re, label);

const GATE = ".devpro/agent-rules/post-pr-completion-gate.md";
const WARN_REPAIR = ".devpro/agent-rules/post-pr-warn-repair.md";
const CROSS = ".devpro/agent-rules/code-review-cross-model.md";
const QUALITY = ".devpro/agent-rules/openspec-quality-and-formats.md";
const QA = ".devpro/agent-rules/testing-and-qa.md";
const ARCHIVE = ".devpro/agent-rules/openspec-archive-principles.md";
const ARCHIVE_REDO_UNDO = ".devpro/agent-rules/openspec-archive-redo-undo.md";
const SECOND_REVIEW_SKILL = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";

test("R1: WARN Decision Contract 選項 1 由收斂謂詞決定（round ≥2 ∧ Critical=0 ∧ 無新 rule/code finding → 接受殘留 WARN）", () => {
  const line = only(WARN_REPAIR, /^WARN Decision Contract/);
  // The entry must make the leaf mandatory for a WARN stop, so the generic merge example above it is not applied.
  const entry = only(GATE, /^> Load-chain：當 `Status: ready-with-warning`/);
  has(entry, /MUST 先讀 `post-pr-warn-repair\.md` 的 WARN Decision Contract 並依其排序選項/, "gate entry makes the leaf mandatory on a WARN stop");
  has(entry, /上方通用範例不適用/, "the generic merge example does not apply on a WARN stop");
  has(line, /選項 1 為「先修到 PASS 並重跑/, "non-converged default = fix-to-PASS");
  has(line, /round ≥2/, "round ≥2 anchor");
  has(line, /Critical=0/, "Critical=0 anchor");
  has(line, /無新 rule\/code finding/, "無新 rule/code finding anchor");
  has(line, /選項 1 MUST 是「接受殘留 WARN 風險，進入 merge 決策」/, "converged default = accept WARN");
  has(line, /change-folder-bookkeeping.*不算新 finding/, "bookkeeping findings do not count as new");
  has(line, /test-hardening Suggestion 不算新 finding/, "test-hardening suggestions do not count as new either (aligned with code-review-cross-model.md carrier class)");
  has(line, /code-review-cross-model\.md.*Round Budget/, "pointer to Round Budget");
  assert.doesNotMatch(read(GATE), /選項 1 必須是「先修到 PASS（預設）並重跑/, "old unconditional fix-to-PASS default must be gone");
});

test("R10: post-pr-completion-gate.md post-archive 修復落點 carve-out", () => {
  const line = only(GATE, /^Post-archive 修復落點/);
  has(line, /不為此 re-archive/, "no per-round re-archive");
  has(line, /不得延伸到 archived spec delta 的 body\/scenario/, "carve-out clause");
});

test("R2: §Round Budget cap 3 bound to pr-sticky lane label + override + fault-recovery exemption on one line", () => {
  only(CROSS, /^### Round Budget（pr-sticky lane）$/);
  const line = only(CROSS, /^- cap 3：/);
  has(line, /pr-sticky/, "lane label");
  has(line, /focused-sticky-refresh.*各算一輪/, "focused-sticky-refresh counts as a round");
  has(line, /fault-recovery.*不計輪/, "fault-recovery exempt");
  has(line, /review_round_budget_exhausted/, "typed code");
  has(line, /DEVPRO_REVIEW_ROUND_OVERRIDE=<PR#>:<n>/, "named override shape");
  has(line, /缺失／格式不符／PR# 不匹配一律不放行/, "fail-closed polarity");
  has(line, /環境變數存在本身不是授權證據/, "env presence is not authorization");
  has(line, /MUST NOT.*audit-only lane cap 6.*harness write-block cap 3/, "anti-DRY-merge note names both sibling lanes");
});

test("R2: counter carrier is scoped by repository and PR and survives marker unlink and expiry", () => {
  const line = only(CROSS, /^- counter 載體：/);
  has(line, /GitHub\.com repo 與 PR 號區分輪次.*`code-review-checklist` spec §Post-PR Cross-Model Review Round Budget/, "repository scope and single filename authority");
  const carrier = only("openspec/specs/code-review-checklist/spec.md", /^Round state SHALL be tracked/);
  has(carrier, /named GitHub\.com repository.*review-round-<repo-token>#<PR#>\.json/, "repository and PR filename");
  has(carrier, /no repository argument uses the legacy .*review-round-<PR#>\.json/, "legacy filename for unscoped callers");
  has(line, /不隨 marker unlink 或時間過期歸零/, "no reset on marker unlink / expiry");
  has(line, /override 只提高上限不重置/, "override raises the cap, never resets");
  has(line, /review_round_state_write_failed/, "write-failure typed code");
  has(line, /不得視為 0 續派/, "write failure is fail closed");
});

test("R2/R6: 收斂謂詞 + carrier class 條文", () => {
  const conv = only(CROSS, /^- 收斂謂詞：/);
  has(conv, /round ≥2 且 Critical=0 且相對上輪無新 rule\/code finding/, "predicate");
  has(conv, /不得為打磨 bookkeeping／test-hardening Suggestion 再派一輪/, "no polishing rounds");
  const cc = only(CROSS, /^- carrier class：/);
  for (const token of ["`rule`", "`code`", "`test`", "`change-folder-bookkeeping`"]) {
    assert.ok(cc.includes(token), `carrier class enum must list ${token}`);
  }
  has(cc, /不得單獨撐起 WARN/, "bookkeeping-only cannot sustain WARN");
  has(cc, /verdict MUST 為 PASS/, "bookkeeping-only verdict must be PASS");
  has(cc, /tracked_follow_up:/, "tracked_follow_up sink");
});

test("R6: sticky schema line declares optional tracked_follow_up and keeps missing-field valid", () => {
  const line = only(CROSS, /Schema MUST be bare lines/);
  has(line, /optional 單行 `\^tracked_follow_up:\\s\+\\S\.\*\$`/, "optional bare-line schema");
  has(line, /缺欄仍 valid，不觸發 Path C/, "backward compatibility polarity");
});

test("R3: Path D′ fresh-equivalent bullet binds whitelist, fail-closed fallback and explicit-constant whitelist", () => {
  const line = only(CROSS, /^- Path D′/);
  has(line, /fresh-equivalent/, "name");
  has(line, /`openspec\/changes\/\*\*` 與 `notes\/\*\*`/, "exactly the two whitelist prefixes");
  has(line, /只.*觸及/, "whitelist-only semantics");
  has(line, /不含.*`specs` path segment/, "specs segment exclusion (#2413 item 5)");
  has(line, /回退 Path D block/, "fallback polarity");
  has(line, /offline／rate-limit／404／非 ancestor／`files` 截斷/, "five compare failure modes");
  has(line, /零 retry/, "zero retry");
  has(line, /白名單為顯式常數/, "no consumer file may widen D′");
  has(line, /post-PR marker 判定同語意/, "marker parity");
  assert.doesNotMatch(line, /README|docs\/\*\*/, "whitelist must not silently widen to README/docs");
  // Consistency: the two other places that state the sha-equality invariant must acknowledge D′.
  assert.ok(lines(CROSS).some((l) => /fail closed as stale（Path D′ 記帳 commit 例外/.test(l)), "head-movement clause acknowledges D′");
  assert.ok(lines(CROSS).some((l) => /`last_reviewed_sha == headRefOid`（或 Path D′ fresh-equivalent）/.test(l)), "fresh-sticky clause acknowledges D′");
});

test("R5: round ≥2 focused sticky-refresh is MUST with full_scope_reason escape and typed block", () => {
  const line = only(CROSS, /^4\. TL 推新 commit 後/);
  has(line, /MUST 走 commit-range focused sticky-refresh/, "MUST polarity");
  has(line, /delta since `last_reviewed_sha`/, "delta endpoint");
  has(line, /full_scope_reason/, "escape hatch");
  has(line, /review_scope_not_minimal/, "typed code");
  assert.doesNotMatch(read(CROSS), /優先走 focused sticky-refresh/, "SHOULD wording must be gone");
});

test("R7: review infra faults are fault-recovery redispatch, never fixed inside the reviewed PR", () => {
  const line = only(CROSS, /禁止在被審 PR 內修 review 基礎設施/);
  has(line, /fault-recovery 重派/, "redispatch");
  has(line, /notes\/session-pending\.md/, "session-pending record");
  has(line, /review_scope_drift/, "advisory typed code");
});

test("R8: pr-sticky lane ledger discipline — one row per round, and cross-model round is not a decisions trigger", () => {
  const ledger = only(CROSS, /^- 帳本紀律：/);
  has(ledger, /pr-sticky lane 每輪只在 decisions\.md 加一列/, "one row per round");
  has(ledger, /只屬 design-gate audit-only lane/, "per-round ledgers scoped to audit-only lane");
  has(ledger, /不需 commit-before-dispatch/, "no commit-before-dispatch");
  has(ledger, /不寫 per-finding 條目/, "no per-finding entries");
  const trigger = only(QUALITY, /^3\. decisions 觸發點發生時/);
  has(trigger, /cross-model round 本身非此五項 trigger/, "reverse clause");
  has(trigger, /code-review-cross-model\.md.*Round Budget/, "pointer to the SSOT paragraph");
  has(trigger, /openspec-flow\.md.*Cross-Model Review Round Is Not A Decisions Trigger/, "canonical scenario cross-reference");
});

test("R9: qa-test-scope Commit template records parent SHA..HEAD and forbids self-SHA backfill commits", () => {
  const line = only(QA, /^- Commit：/);
  has(line, /parent SHA/, "parent SHA");
  has(line, /\.\.HEAD/, "range to HEAD");
  has(line, /禁止為填自身 SHA 再開 commit/, "no backfill commit");
});

test("R10: openspec-archive-redo-undo.md archived-folder in-place edit pointer keeps the carve-out reachable", () => {
  const line = only(ARCHIVE_REDO_UNDO, /post-archive review 修復/);
  has(line, /不為此 re-archive/, "no re-archive for bookkeeping fixes");
  has(line, /post-pr-completion-gate\.md.*Post-archive 修復落點/, "pointer to the carve-out SSOT paragraph");
  // The pre-existing prohibition must still stand right above it.
  assert.ok(lines(ARCHIVE_REDO_UNDO).some((l) => /禁止直改 archive spec\.md 的 `## MODIFIED`\/`## ADDED Requirements` body\/scenario/.test(l)), "spec-delta prohibition retained");
  // The entry must still route readers to the leaf that now owns both lines.
  assert.ok(lines(ARCHIVE).some((l) => l.includes("MUST 先讀 `openspec-archive-redo-undo.md`")), "entry keeps the mandatory pointer to the leaf");
});

test("D9: the three round caps stay in their own lanes (no DRY merge, no literal leakage)", () => {
  const skill = read(SECOND_REVIEW_SKILL);
  assert.match(skill, /audit round cap 6/, "audit-only lane cap 6 literal retained");
  assert.match(skill, /audit round cap 3/, "harness write-block cap 3 literal retained");
  assert.doesNotMatch(read(CROSS), /audit round cap/, "audit lane literal must not leak into the pr-sticky leaf");
  assert.doesNotMatch(skill, /pr-sticky lane cap|PR_STICKY_REVIEW_ROUND_CAP/, "pr-sticky cap must not be re-homed into the audit-only skill");
});

// A post-archive review fix that touches a rule/code/test carrier had no stated evidence
// alignment: `classify-final` reports `full_reopen_required` at the fix commit, the fix is
// not bookkeeping so the carve-out above does not cover it, and the merge-time Local-Test
// Gate only reads the exact-head receipt. The paragraph below states what the merge
// actually rests on, so the reopen output is not mistaken for an instruction.
test("post-archive carrier-fix evidence alignment: stated in the WARN repair leaf, with the merge evidence it rests on", () => {
  const line = only(WARN_REPAIR, /^Post-archive 載體修復的證據對齊/);
  has(line, /PR 開出後.*cross-model.*archive 後.*rule／code／test 載體/, "scoped to PR-open cross-model fixes on rule/code/test carriers");
  has(line, /不 re-archive、不重開 primary 六軸/, "no re-archive and no second primary full");
  has(line, /primary final evidence 仍綁 archive 後的 reviewed HEAD/, "primary final evidence stays bound to the archive head");
  has(line, /classify-final.*full_reopen_required.*預期輸出.*不是重開指令/, "the reopen output is expected, not an instruction");
  has(line, /record-regression-head.*修復 HEAD/, "exact-head receipt at the fix head");
  has(line, /current-head.*sticky/, "current-head cross-model sticky");
  has(line, /behavior.*scope.*spec delta body.*re-archive.*primary 六軸/, "behavior/scope/spec-delta change still re-archives and reopens primary");
  has(line, /test-suite-cadence\.md.*Merge evidence/, "pointer to the Merge evidence rule");
  // The bookkeeping carve-out stays a separate, single line.
  const carve = only(GATE, /^Post-archive 修復落點/);
  has(carve, /不為此 re-archive/, "bookkeeping carve-out intact");
});

test("post-archive carrier-fix evidence alignment: the FinalEvidenceRecord rule points at it instead of implying a reopen", () => {
  const line = only(".devpro/agent-rules/test-suite-cadence.md", /^- Transition\/FinalEvidenceRecord：/);
  has(line, /post-pr-warn-repair\.md.*Post-archive 載體修復的證據對齊/, "pointer from the 後續commit=>full_reopen_required rule");
  has(line, /後續commit=>`full_reopen_required`/, "the reopen rule itself is unchanged");
});

test("post-archive carrier-fix evidence alignment: the pre-pr Post-Ledger gate does not tell the reader to reopen for those fixes", () => {
  const line = only(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md", /^Archive transition equivalent時/);
  has(line, /PR 開出後 cross-model 在 archive 後指出的 rule／code／test 載體修復不適用/, "carve-out stated in the gate that classify-final's reopen reading comes from");
  has(line, /post-pr-warn-repair\.md.*Post-archive 載體修復的證據對齊/, "pointer to the SSOT paragraph");
});
