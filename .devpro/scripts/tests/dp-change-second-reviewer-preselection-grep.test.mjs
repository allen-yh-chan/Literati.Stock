/**
 * dp-change-second-reviewer-preselection-grep.test.mjs
 *
 * Locks the devpro:change dispatch anchors（preselection + R6(a) 三條款 + FR1(b)
 * sanctioned 路徑 + FR2 dispatch 提醒）across carriers. Rows 7–9 resolve
 * their spec input through `readChangeSpecWithArchiveFallback` (active change
 * delta → latest archived delta → canonical fallback), so the assertions stay
 * green before and after archive without hardcoding the active change folder
 * path (F-1-3). Active delta structural correctness is covered by the T4
 * lint trio, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";
import { readChangeSpecWithArchiveFallback } from "./lib/spec-delta-reader.mjs";

const CHANGE_NAME = "add-second-reviewer-preselection-at-dp-change";

function read(rel) {
  return readFileSync(repoPath(rel), "utf8");
}

const CARRIERS = [
  {
    label: "canonical devpro:change SKILL step-zero preselection + dispatch read",
    path: ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
    fragments: [
      "second_reviewer_family",
      "command -v claude",
      "command -v codex",
      "無 auto 預設",
      "已 dispatch 的 round 不受影響",
    ],
  },
  {
    // The design-gate dispatch read moved to the full-rigor reference (SKILL.md keeps a pointer line).
    label: "canonical devpro:change full-rigor reference dispatch read",
    path: ".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md",
    fragments: [
      "second_reviewer_family",
      "user-preselected",
      "dispatch 當下",
    ],
  },
  {
    label: "devpro:second-review common skill Reviewer Selection + dispatch-stop clause",
    path: ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
    // the dispatch-stop clause sits in the Cursor host route (references/); read the rebuilt skill
    compose: readSecondReviewSkillWithHostRoutes,
    fragments: [
      "second_reviewer_family",
      "dispatch 當下",
      "user-preselected",
      "cursor-composer",
    ],
  },
  {
    label: "platform-adapters/cursor.md dispatch-stop clause + step 2 ledger read",
    path: ".devpro/agent-rules/platform-adapters/cursor.md",
    fragments: [
      "second_reviewer_family",
      "dispatch 當下",
      "MUST NOT",
      "manual remap",
      "cross-model-unverified",
    ],
  },
  {
    label: "devpro:cross-review SKILL Override precedence",
    path: ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
    fragments: ["second_reviewer_family", "CROSS_MODEL_REVIEWER"],
  },
  {
    label: "devpro:pre-pr dispatch block open_finding_ids consistency reminder (FR2)",
    path: ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
    fragments: [
      'scope.open_finding_ids 一致性（MUST）',
    ],
  },
  {
    label: "opencode adapter sanctioned fresh re-emission path (FR1(b))",
    path: ".devpro/agent-rules/platform-adapters/opencode.md",
    fragments: [
      "sanctioned",
      "fresh re-emission",
      "a named projection spawn is always instance_mode: fresh",
      "gate 後門",
    ],
  },
];

for (const carrier of CARRIERS) {
  test(`${carrier.label} documents preselection anchors`, () => {
    const source = carrier.compose ? carrier.compose() : read(carrier.path);
    for (const fragment of carrier.fragments) {
      assert.ok(
        source.includes(fragment),
        `${carrier.label} missing required anchor: ${fragment}`,
      );
    }
  });
}

test("openspec-flow spec locks preselection requirement, helper lane, and env precedence (archive-stable)", () => {
  const spec = readChangeSpecWithArchiveFallback(
    CHANGE_NAME,
    "specs/openspec-flow/spec.md",
    "openspec/specs/openspec-flow/spec.md",
  );
  assert.ok(
    spec.includes("Second Reviewer Preselection At DP Change Start"),
    "ADDED requirement title missing",
  );
  assert.ok(spec.includes("userPreselectedReviewerFamily"), "helper second-lane anchor missing");
  assert.ok(spec.includes("CROSS_MODEL_REVIEWER"), "env precedence anchor missing");
});

test("code-review-checklist spec locks feedforward reason-only discipline (archive-stable)", () => {
  const spec = readChangeSpecWithArchiveFallback(
    CHANGE_NAME,
    "specs/code-review-checklist/spec.md",
    "openspec/specs/code-review-checklist/spec.md",
  );
  assert.ok(spec.includes("user-preselected"), "user-preselected anchor missing");
  assert.ok(spec.includes("dispatch time only"), "dispatch-time-only anchor missing");
  assert.ok(spec.includes("CROSS_MODEL_REVIEWER"), "env precedence anchor missing");
});

test("cross-runtime-parity spec locks single-carrier discovery (archive-stable)", () => {
  const spec = readChangeSpecWithArchiveFallback(
    CHANGE_NAME,
    "specs/cross-runtime-parity/spec.md",
    "openspec/specs/cross-runtime-parity/spec.md",
  );
  assert.ok(
    spec.includes("DP Change Skill Runtime Discovery Single Carrier"),
    "single-carrier requirement missing",
  );
});
