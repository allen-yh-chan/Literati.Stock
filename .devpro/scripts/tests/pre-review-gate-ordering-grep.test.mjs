/**
 * strengthen-subagent-delegation-strategy T38: the R12 mechanical-gate ordering
 * clauses are grep-locked in their carriers.
 *
 * T38 claimed "grep anchor test 鎖住兩處" while no such test existed — the rule
 * text sat in prose with no mechanical carrier, which is the exact failure mode
 * R12 exists to close. This file makes the claim true and additionally locks the
 * D38 root-cause clause (archive commit is a pure move, so deferring a fix to it
 * is not a legal disposition).
 *
 * Anchors are deliberately count-free (heading literals, relative position, last
 * item literal): the pre-review list grew 7 -> 9 -> 10 across three remediation
 * rounds, so any hard-coded item count is a self-inflicted stale anchor (D38).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readChangeSpecWithArchiveFallback } from "./lib/spec-delta-reader.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

// Pre-review (第三點零步段) and Step 3 body live in references/full-review-and-archive.md;
// assert on the full-rigor reading order rebuilt from SKILL.md + that reference.
const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const STEPS = ".devpro/agent-rules/openspec-step-1-to-9.md";
// The disposition below lives in this change's MODIFIED delta until
// `openspec archive` renames that file under `openspec/changes/archive/` and
// promotes its body into the canonical spec. Neither path is a valid anchor on
// both sides of that transition: before the archive the canonical spec does not
// carry the scenario yet, and after it the active-change path does not exist at
// all. A guard pinned to either one goes red the moment its own change is
// archived -- the same self-inflicted stale anchor this file's header warns
// about for counts, one level up at the path. So resolve to whichever carrier
// holds the disposition right now.
const ACTIVE_DELTA =
  "openspec/changes/strengthen-subagent-delegation-strategy/specs/code-review-checklist/spec.md";
const CANONICAL_SPEC = "openspec/specs/code-review-checklist/spec.md";
const ARCHIVE_TRANSITION_SCENARIO =
  "#### Scenario: Hook-Written Change-Folder Carriers Ride The Archive Transition";

const PRE_REVIEW_HEADING = "### 第三點零步段：Pre-review 機械掃描";
const SIX_AXIS_HEADING = "### 第三步：Six-Axis Review";
const ARCHIVE_HEADING = "### 第三點六步段：Spec Freeze Archive + Archive Gate Check（必過）";
const STEP7_HEADING = "### Step 7 Archive change";
const STEP8_HEADING = "### Step 8 一次 push";

function readCarrier(relativePath) {
  return readFileSync(repoPath(relativePath), "utf8");
}

// Returns the carrier that currently states the archive-transition disposition,
// preferring the pre-archive delta so the guard reads this change's own words
// while they are still authorable. A miss on both is a hard failure, never a
// skip: a guard that quietly stops asserting once its carrier moves is worse
// than no guard, because the suite stays green while the disposition is gone.
function resolveDispositionCarrier() {
  for (const candidate of [ACTIVE_DELTA, CANONICAL_SPEC]) {
    let content;
    try {
      content = readCarrier(candidate);
    } catch (error) {
      // Absence is the only condition this loop is allowed to walk past: before
      // the archive the canonical spec has no such scenario, after it the active
      // path is gone. Anything else -- EACCES, EISDIR, a truncated read -- means
      // the carrier is there but unreadable, and swallowing it would silently
      // fall through to the other copy and report a green that never asserted
      // against the carrier under review. That window is reachable: a half
      // reverted archive leaves the active folder in place while canonical
      // already carries the promoted body.
      if (error?.code !== "ENOENT") throw error;
      continue;
    }
    if (content.includes(ARCHIVE_TRANSITION_SCENARIO)) return { carrier: candidate, content };
  }
  return assert.fail(
    `neither ${ACTIVE_DELTA} nor ${CANONICAL_SPEC} carries "${ARCHIVE_TRANSITION_SCENARIO}" -- the archive-transition disposition has lost its carrier`,
  );
}

function onlyIndexOf(content, needle, label) {
  const first = content.indexOf(needle);
  assert.ok(first >= 0, `${label} missing anchor: ${needle}`);
  assert.equal(content.indexOf(needle, first + 1), -1, `${label} anchor is not unique: ${needle}`);
  return first;
}

// The delta scenario is the last block in its file, so there is no closing
// heading to hand `between`. Terminate on the next markdown heading of level
// 2-4 (a structural boundary, not a prose word) and fall through to EOF.
function scenarioBlock(content, heading, label) {
  const start = onlyIndexOf(content, heading, label);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n#{2,4} /u);
  return heading + (next === -1 ? rest : rest.slice(0, next));
}

function between(content, startHeading, endHeading, label) {
  const start = onlyIndexOf(content, startHeading, label);
  const end = content.indexOf(endHeading, start);
  assert.ok(end > start, `${label} missing closing heading ${endHeading} after ${startHeading}`);
  return content.slice(start, end);
}

test("devpro:pre-pr pre-review scan precedes the Six-Axis Review step", () => {
  const skill = readPrePrSkillFullReadingOrder();
  const preReviewAt = onlyIndexOf(skill, PRE_REVIEW_HEADING, SKILL);
  const sixAxisAt = onlyIndexOf(skill, SIX_AXIS_HEADING, SKILL);
  assert.ok(
    preReviewAt < sixAxisAt,
    `${SKILL}: pre-review scan must sit before ${SIX_AXIS_HEADING} — reviewer dispatch is the last step before archive`,
  );
});

// archive-tooling MODIFIED scenario title lock (Pre-Review Mechanical Gate Runs Active
// Content Lints Before Dispatch). Expanded RED/GREEN executable coverage lives in
// pre-pr-archive-gate-pre-review.test.mjs; this grep keeps the scenario title from
// drifting out of the active delta / canonical without a carrier.
test("archive-tooling carries Pre-Review Mechanical Gate Runs Active Content Lints Before Dispatch", () => {
  const canonical = "openspec/specs/archive-tooling/spec.md";
  const title = "#### Scenario: Pre-Review Mechanical Gate Runs Active Content Lints Before Dispatch";
  const delta = readChangeSpecWithArchiveFallback(
    "enforce-protected-branch-pr-only",
    "specs/archive-tooling/spec.md",
    canonical,
  );
  assert.ok(
    delta.includes(title),
    `active-or-archived enforce-protected-branch-pr-only archive-tooling delta missing scenario title: ${title}`,
  );
  assert.ok(
    readCarrier(canonical).includes(title),
    `${canonical} missing scenario title: ${title}`,
  );
});


test("devpro:pre-pr pre-review list ends with the scenario walkthrough scope item", () => {
  const section = between(readPrePrSkillFullReadingOrder(), PRE_REVIEW_HEADING, SIX_AXIS_HEADING, SKILL);
  const numbered = section.split("\n").filter((line) => /^\d+\. /u.test(line));
  assert.ok(numbered.length > 0, `${SKILL}: pre-review section has no numbered gate list`);
  assert.match(
    numbered[numbered.length - 1],
    /Scenario walkthrough disposition 與待派工樹一致/u,
    `${SKILL}: the last pre-review item must stay the scenario walkthrough scope check`,
  );
});

test("devpro:pre-pr pre-review mechanically runs all eight content lints before Six-Axis Review", () => {
  const section = between(readPrePrSkillFullReadingOrder(), PRE_REVIEW_HEADING, SIX_AXIS_HEADING, SKILL);
  const lintIds = [
    "lint-delta-requirement-mode",
    "lint-modified-scenario-preservation",
    "lint-delta-body-canonical-wrap",
    "lint-proposal-tasks-checked",
    "lint-proposal-touch-self-path",
    "lint-proposal-touch-coverage",
    "lint-requirement-count-ratchet",
    "lint-delta-spec-citations",
  ];
  for (const id of lintIds) {
    assert.ok(section.includes(id), `${SKILL}: pre-review section missing content lint ${id}`);
  }
  assert.match(
    section,
    /--pre-review --change-base-ref/u,
    `${SKILL}: pre-review must name --pre-review --change-base-ref as the eight-lint executor`,
  );
  // Polarity: forbid an affirmative dual-track recipe. Naming the anti-pattern
  // inside a MUST NOT sentence is allowed.
  assert.ok(
    section.includes("MUST NOT") && section.includes("雙軌"),
    `${SKILL}: must forbid a parallel manual content-lint track`,
  );
  assert.doesNotMatch(
    section,
    /^\d+\.\s+`node \.devpro\/scripts\/lint-delta-requirement-mode\.mjs/mu,
    `${SKILL}: must not list lint-delta-requirement-mode as a separate numbered manual step`,
  );
  const sixAxisAt = onlyIndexOf(readPrePrSkillFullReadingOrder(), SIX_AXIS_HEADING, SKILL);
  const skill = readPrePrSkillFullReadingOrder();
  for (const id of lintIds) {
    const at = skill.indexOf(id);
    assert.ok(at >= 0 && at < sixAxisAt, `${SKILL}: ${id} must appear before ${SIX_AXIS_HEADING}`);
  }
});

test("openspec-step-1-to-9 Step 7 fixes the disposition for a gate that reddens after the receipt is sealed", () => {
  const step7 = between(readCarrier(STEPS), STEP7_HEADING, STEP8_HEADING, STEPS);
  for (const anchor of [
    "receipt 封存後才紅的機械閘",
    "撤掉本機 archive commit",
    "把修復落在 reviewed HEAD **之前**",
  ]) {
    assert.ok(step7.includes(anchor), `${STEPS} Step 7 missing recovery anchor: ${anchor}`);
  }
  // The remaining two clauses are polarity-sensitive: their entire normative force
  // sits in the immediately preceding **MUST NOT**. A bare includes() stays green
  // when the polarity is flipped to MAY, so bind marker and object adjacently on the
  // same physical line (rule-anchor-guard-strength.md, polarity-sensitive anchors).
  for (const prohibition of [
    /\*\*MUST NOT\*\* 在 reviewed HEAD 之後補 commit 硬過 archive transition/u,
    /\*\*MUST NOT\*\* 為過閘空 commit/u,
  ]) {
    assert.match(
      step7,
      prohibition,
      `${STEPS} Step 7: prohibition lost its **MUST NOT** polarity: ${prohibition}`,
    );
  }
});

// D38 root cause: before this clause landed, the byte-invariance of the archive
// commit lived only in review-remediation-evidence-core.mjs. Nothing in the rule
// corpus contradicted "defer the fix to the archive commit", so this change
// wrote that unexecutable disposition into four separate decisions.
test("openspec-step-1-to-9 Step 7 states why deferring a fix to the archive commit is not a legal disposition", () => {
  const steps = readCarrier(STEPS);
  const step7 = between(steps, STEP7_HEADING, STEP8_HEADING, STEPS);
  for (const anchor of [
    "「延後到 archive commit 再 backfill」不是合法處置",
    "deriveActiveArchiveMapping",
    "archive transition mapping is missing or duplicate",
    "archive transition byte/mode/OID mapping mismatch",
    "admission-records/",
    "override-ledger/",
  ]) {
    assert.ok(step7.includes(anchor), `${STEPS} Step 7 missing root-cause anchor: ${anchor}`);
  }
  assert.ok(
    step7.indexOf("receipt 封存後才紅的機械閘") < step7.indexOf("「延後到 archive commit 再 backfill」不是合法處置"),
    `${STEPS} Step 7: the root-cause clause must follow the recovery clause it is the symmetric face of`,
  );
  // Set equality, not superset: a rule that advertises a third hook-carrier
  // prefix the implementation does not assert against teaches a disposition the
  // gate refuses — the D38 shape. Test 5 pins the implementation literal and
  // only guards the opposite direction.
  //
  // The window is the whole Step 7 section, not a clause delimited by a prose
  // word. A prose terminator closes at its first occurrence, so a third
  // prefix advertised anywhere after it escaped this assertion entirely (mutation
  // M5 stayed 5/5 green). `rule-anchor-guard-strength.md` §錨點作用域守則 1 accepts
  // only structural terminators — here STEP8_HEADING, already bound by between().
  const named = new Set([...step7.matchAll(/`([A-Za-z0-9_-]+)\/`/gu)].map((m) => m[1]));
  assert.deepStrictEqual(
    [...named].sort(),
    ["admission-records", "override-ledger"],
    `${STEPS} Step 7: hook-carrier prefixes named anywhere in the section must equal ARCHIVE_TRANSITION_UNTRACKED_PREFIXES exactly`,
  );
});

// The post-archive carve-out is the only exception to the clause locked above, so
// its boundary is polarity-sensitive in both directions: pure bookkeeping backfill
// MAY land after archive, a factual/behavioural correction MUST NOT. Mutation M6
// inverted exactly that sentence and the suite stayed 5/5 green, so bind both
// halves inside one contiguous literal rather than asserting each word separately.
test("openspec-step-1-to-9 Step 7 bounds the post-archive carve-out by correction kind, not by carrier", () => {
  const steps = readCarrier(STEPS);
  const step7 = between(steps, STEP7_HEADING, STEP8_HEADING, STEPS);
  for (const anchor of [
    "但別把它反向讀成「archive 後一律不能補」",
    "不得延伸到 archived spec delta 的 body/scenario",
    "此出口的界線是**修正的性質，不是載體**",
  ]) {
    assert.ok(step7.includes(anchor), `${STEPS} Step 7 missing post-archive carve-out anchor: ${anchor}`);
  }
  assert.match(
    step7,
    /純記帳回填（[^）]*）落在哪個載體都可以，事實性或行為性修正則一律要落在 reviewed HEAD 之前/u,
    `${STEPS} Step 7: the carve-out lost the polarity binding between 記帳回填 and 事實性／行為性修正`,
  );
});

// These two prefixes are no longer an escape hatch in
// deriveActiveArchiveMapping — they are an absence assertion (PR #2473
// cross-model Critical). If the rule text and the implementation drift, the
// rule teaches a disposition the gate rejects — the same shape D38 was opened
// for. Pin the constant line verbatim, and pin that no exemption-shaped
// identifier survives anywhere in the module.
test("the archive transition untracked-prefix assertion named in the rule matches the implementation", () => {
  const core = readCarrier(".devpro/scripts/lib/review-remediation-evidence-core.mjs");
  assert.ok(
    core.includes("const ARCHIVE_TRANSITION_UNTRACKED_PREFIXES = /^(?:admission-records|override-ledger)\\//u;"),
    "review-remediation-evidence-core.mjs: ARCHIVE_TRANSITION_UNTRACKED_PREFIXES changed shape — resync openspec-step-1-to-9.md Step 7",
  );
  assert.ok(
    !core.includes("ARCHIVE_TRANSITION_EXEMPT"),
    "review-remediation-evidence-core.mjs: the blanket ARCHIVE_TRANSITION_EXEMPT carve-out must not come back — the prefixes are gitignored, so the tracked inventory is empty by construction",
  );
});
// `pre-pr/SKILL.md` carries the same disposition as `openspec-step-1-to-9.md`
// Step 7, but only the latter was anchored — so the skill could drift back to
// teaching a blanket exemption while every test stayed green (dp-programmer
// raised this while implementing the PR #2473 cross-model Critical fix). Bind
// the skill side with the same two-part shape: the polarity-bearing literal,
// and set equality on the prefixes it names.
test("devpro:pre-pr Step 3 timing clause states the untracked assertion, not an exemption", () => {
  const section = between(readPrePrSkillFullReadingOrder(), SIX_AXIS_HEADING, ARCHIVE_HEADING, SKILL);
  for (const anchor of [
    "**不是**對兩者豁免 exact mapping",
    "不得被追蹤",
    "fail closed",
    "untrack",
    "admission-records/",
    "override-ledger/",
  ]) {
    assert.ok(section.includes(anchor), `${SKILL} Step 3 timing clause missing anchor: ${anchor}`);
  }
  // Polarity guard: the retired wording must not come back in its affirmative
  // form. `豁免 exact mapping` survives above only because `**不是**對` negates
  // it, so assert the negation is what precedes it rather than banning the
  // phrase outright.
  const exemptAt = section.indexOf("豁免 exact mapping");
  assert.ok(
    exemptAt > 0 && section.slice(0, exemptAt).endsWith("**不是**對兩者"),
    `${SKILL} Step 3: \`豁免 exact mapping\` must appear only inside its negation`,
  );
  // Same set-equality reasoning as the Step 7 guard: a third prefix advertised
  // here but not asserted against in the module teaches a disposition the gate
  // refuses. Structural terminator (ARCHIVE_HEADING), not a prose word.
  const named = new Set([...section.matchAll(/`([A-Za-z0-9_-]+)\/`/gu)].map((m) => m[1]));
  assert.deepStrictEqual(
    [...named].sort(),
    ["admission-records", "override-ledger"],
    `${SKILL} Step 3: hook-carrier prefixes named in the timing clause must equal ARCHIVE_TRANSITION_UNTRACKED_PREFIXES exactly`,
  );
});

// The third and most normative carrier of the same disposition: this change's
// own MODIFIED spec delta. Re-archiving promotes it into canonical spec, so a
// delta that still mandates the blanket exemption would permanently enshrine
// the hole the code fix closed — while every lint stays green, because no lint
// compares delta prose polarity against the implementation (PR #2473 r19
// Critical `F-r19-spec-delta-exemption-polarity`). Bind the scenario body with
// the same two-part shape used for the rule leaf and the skill: the
// polarity-bearing literals, and set equality on the prefixes it names.
test("the code-review-checklist spec delta states the untracked assertion, not an exemption", () => {
  const { carrier, content } = resolveDispositionCarrier();
  const scenario = scenarioBlock(content, ARCHIVE_TRANSITION_SCENARIO, carrier);
  for (const anchor of [
    "empty by construction",
    "MUST each assert zero tracked paths",
    "fail closed",
    "untrack remedy",
    "`admission-records/`",
    "`override-ledger/`",
  ]) {
    assert.ok(scenario.includes(anchor), `${carrier} scenario missing anchor: ${anchor}`);
  }
  // Polarity guard. `exemption` survives only inside the sentence forbidding
  // the assertion from being softened back into one; the retired affirmative
  // ("MUST exempt exactly those two") and the byte-identical-move escape hatch
  // must not come back in any form.
  for (const retired of [
    "MUST exempt",
    "MUST move byte-identically",
    "MUST NOT require a second full six-axis review",
  ]) {
    assert.ok(!scenario.includes(retired), `${carrier} scenario: retired exemption wording came back: ${retired}`);
  }
  const exemptionAt = scenario.indexOf("exemption");
  assert.ok(
    exemptionAt > 0 && scenario.slice(0, exemptionAt).endsWith("MUST NOT be softened into an "),
    `${carrier} scenario: \`exemption\` must appear only inside its prohibition`,
  );
  // Same set-equality reasoning as the other two guards: a third prefix named
  // in the promoted spec but not asserted against in the module teaches a
  // disposition the gate refuses.
  const named = new Set([...scenario.matchAll(/`([A-Za-z0-9_-]+)\/`/gu)].map((m) => m[1]));
  assert.deepStrictEqual(
    [...named].sort(),
    ["admission-records", "override-ledger"],
    `${carrier} scenario: hook-carrier prefixes must equal ARCHIVE_TRANSITION_UNTRACKED_PREFIXES exactly`,
  );
});
