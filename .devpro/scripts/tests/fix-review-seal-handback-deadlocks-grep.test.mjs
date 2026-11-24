/**
 * Locks fix-review-seal-handback-deadlocks discoverability: help / devpro:pre-pr /
 * dispatch name handback→bounded→final, merge-base authority, surface equality
 * helper, open-disposition produce-side, and ban TL executor_kind hand-normalization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readChangeSpecWithArchiveFallback } from "./lib/spec-delta-reader.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const HELPER = ".devpro/scripts/review-remediation-evidence.mjs";
const CORE = ".devpro/scripts/lib/review-remediation-evidence-core.mjs";
const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";
const COST = ".devpro/agent-rules/workflow-cost-controls.md";
const AGENT = ".claude/agents/dp-reviewer.md";
const CANONICAL_SPEC = "openspec/specs/code-review-checklist/spec.md";
const CHANGE_DELTA = readChangeSpecWithArchiveFallback(
  "enforce-protected-branch-pr-only",
  "specs/code-review-checklist/spec.md",
  CANONICAL_SPEC,
);

function read(rel) {
  return readFileSync(repoPath(rel), "utf8");
}

test("help names handback→bounded→final, merge-base authority, surface helper, and produce-side schema", () => {
  const help = read(HELPER);
  assert.match(help, /handback→bounded→final/);
  assert.match(help, /full_reopen_reason=handback_authorized_bounded/);
  assert.match(help, /handback_authorized_full/);
  assert.match(help, /classify-final may reach final_ready/);
  assert.match(help, /above the automatic cap.*consumed claim bound to its exact responsibility_id and dispatch_id/);
  assert.match(help, /merge-base\(resolvedMain, HEAD\)/);
  assert.match(help, /NOT the moving origin\/main tip/);
  assert.match(help, /resolvePredecessorReceiptForSurfaceEquality/);
  assert.match(help, /open finding disposition must be null/);
  assert.match(help, /executor_kind is required/);
  assert.match(help, /MUST NOT hand-normalize executor_kind/);
});

test("core uses typed raw-capture failures and preserves produce-side surface equality", () => {
  const core = read(CORE);
  assert.match(core, /function resolvePredecessorReceiptForSurfaceEquality/);
  assert.match(core, /manifest surface_base_sha must equal predecessor receipt lineage\.head_sha/);
  assert.match(core, /function validateRawReviewerCapture[\s\S]{0,800}withSemanticFailureCode\("raw-payload-invalid"[\s\S]{0,150}validateCanonicalRawReviewerPayload/u);
  assert.match(core, /if \(entry\.state === "open"\) \{\s*if \(entry\.disposition !== null\) fail\(/u);
  assert.match(core, /if \(!Object\.hasOwn\(payload\.reviewer_identity, "executor_kind"\)\) \{\s*fail\("raw reviewer payload identity missing executor_kind"\)/u);
});

test("devpro:pre-pr and dispatch name final relay and ban TL executor_kind hand-normalization", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const skill = readPrePrSkillFullReadingOrder();
  const dispatch = read(DISPATCH);
  assert.match(skill, /handback→bounded→final/);
  assert.match(skill, /classify-final.*final_ready/);
  assert.match(skill, /MUST NOT.*手寫／手補／hand-normalize `executor_kind`|MUST NOT.*hand-normalize/);
  assert.match(dispatch, /executor_kind/);
  assert.match(dispatch, /handback→bounded→final/);
  assert.match(dispatch, /open finding disposition must be null/);
  assert.match(dispatch, /not a TL hand-normalization opportunity/);
});

test("checklist and cost controls name handback→bounded→final and merge-base surface rules", () => {
  assert.match(read(CHECKLIST), /handback→bounded→final/);
  assert.match(read(CHECKLIST), /resolvePredecessorReceiptForSurfaceEquality/);
  assert.match(read(CORE), /hasConsumedHalfStateOverrideClaim/);
  assert.match(read(COST), /handback→bounded→final/);
  assert.match(read(COST), /classify-final.*final_ready/);
});

test("Override Bridge Seals Finished Then Classify-Final Is Ready stays bounded by default", () => {
  for (const [name, source] of [
    [CANONICAL_SPEC, read(CANONICAL_SPEC)],
    ["enforce-protected-branch-pr-only code-review-checklist delta", CHANGE_DELTA],
  ]) {
    assert.match(source, /#### Scenario: Override Bridge Seals Finished Then Classify-Final Is Ready/, name);
    assert.match(source, /handback_authorized_bounded/, name);
    assert.match(source, /independently proven mandatory-full condition/, name);
  }
});

test("dp-reviewer schema says open disposition MUST be null", () => {
  assert.match(read(AGENT), /open → MUST null/);
});
