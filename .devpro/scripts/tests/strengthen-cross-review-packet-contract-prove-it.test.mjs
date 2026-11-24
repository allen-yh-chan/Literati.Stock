/**
 * Prove-it for strengthen-cross-review-packet-contract (R1–R5).
 * Write-failing-first: these assertions encode the target contract.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SAME_FAMILY_FALLBACK_REASON_PREFIX,
  CROSS_MODEL_UNVERIFIED_REASON_TOKEN,
  classificationIndicatesSameFamilyFallback,
  classifySameFamilyStickyReason,
  crossModelUnverifiedDisclosure,
  primaryFamilyIsUnknown,
  sameFamilyFallbackDisclosure,
  sameFamilyFallbackWhy,
  secondReviewPacketStaticPrefix,
  stickyReasonRequiresSameFamilyFallback,
} from "../validate-second-review-packet.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const GENERIC_SAME_FAMILY_WHY =
  "different-family reviewer unavailable; same-family fallback authorized";

const CROSS_REVIEW_SKILL = repoPath(
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
);
const SECOND_REVIEW_SKILL = repoPath(
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
);
const CLI_CONTRACT = repoPath(
  ".devpro/agent-rules/code-review-cross-model-cli-contract.md",
);
const PRE_PR_DISPATCH_BLOCKS = repoPath(
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
);

test("R1 prove-it: same-family without explicit why fails closed (no generic placeholder)", () => {
  for (const sticky_verification of ["not-needed", "none", "", "  "]) {
    const retry = {
      classification: "same_family_fallback:codex-cli-unavailable",
      sticky_verification,
    };
    assert.equal(classificationIndicatesSameFamilyFallback(retry.classification), true);
    assert.equal(
      sameFamilyFallbackWhy(retry),
      null,
      `expected null why for sticky_verification=${JSON.stringify(sticky_verification)}`,
    );
    assert.throws(
      () => sameFamilyFallbackDisclosure(retry),
      /same_family_fallback_why_required/,
    );
  }
  assert.throws(
    () => sameFamilyFallbackDisclosure({
      classification: "same_family_fallback:x",
      sticky_verification: GENERIC_SAME_FAMILY_WHY,
    }),
    /same_family_fallback_why_required/,
  );
});

test("R1 prove-it: explicit sticky_verification why injects into reason lead", () => {
  const why = "preferred different-family CLI unavailable";
  const retry = {
    classification: "same_family_fallback:codex-cli-unavailable",
    sticky_verification: why,
  };
  assert.equal(sameFamilyFallbackWhy(retry), why);
  const disclosure = sameFamilyFallbackDisclosure(retry);
  assert.equal(disclosure, `${SAME_FAMILY_FALLBACK_REASON_PREFIX} ${why}`);
  assert.ok(stickyReasonRequiresSameFamilyFallback(`${disclosure}; findings ok`, retry));
  assert.equal(
    stickyReasonRequiresSameFamilyFallback(
      `${SAME_FAMILY_FALLBACK_REASON_PREFIX} wrong-why; findings ok`,
      retry,
    ),
    false,
  );

  const prefix = secondReviewPacketStaticPrefix(
    "Claude Code",
    "pr-sticky",
    "dispatch-r1-why",
    null,
    undefined,
    { retryContext: retry },
  );
  assert.match(prefix, new RegExp(`reason: ${SAME_FAMILY_FALLBACK_REASON_PREFIX} ${why}`));
});

test("R1 prove-it: unknown primary without same-family still injects cross-model-unverified", () => {
  assert.equal(primaryFamilyIsUnknown("unknown"), true);
  assert.equal(crossModelUnverifiedDisclosure("unknown"), CROSS_MODEL_UNVERIFIED_REASON_TOKEN);
  const prefix = secondReviewPacketStaticPrefix(
    "Codex",
    "pr-sticky",
    "dispatch-r1-unknown",
    null,
    undefined,
    { primaryFamily: "unknown" },
  );
  assert.match(
    prefix,
    new RegExp(`^reason: ${CROSS_MODEL_UNVERIFIED_REASON_TOKEN}; <actual-bounded-reason>$`, "m"),
  );
});

test("R2 prove-it: devpro:second-review and cli-contract name rendered done_when packet key", () => {
  const secondReview = readFileSync(SECOND_REVIEW_SKILL, "utf8");
  const cliContract = readFileSync(CLI_CONTRACT, "utf8");
  assert.match(
    secondReview,
    /done_when/,
    "devpro:second-review MUST document done_when",
  );
  assert.match(
    secondReview,
    /rendered packet|Review Data|packet.*done_when|done_when.*packet/i,
    "devpro:second-review MUST tie done_when to rendered packet / Review Data carriage",
  );
  assert.match(
    cliContract,
    /done_when/,
    "code-review-cross-model-cli-contract MUST name done_when",
  );
});

test("R1 prove-it: classifySameFamilyStickyReason why-null and why-binding (verifySticky gate)", () => {
  const whyNull = classifySameFamilyStickyReason(
    `${SAME_FAMILY_FALLBACK_REASON_PREFIX} anything`,
    {
      classification: "same_family_fallback:codex-cli-unavailable",
      sticky_verification: "not-needed",
    },
  );
  assert.deepEqual(whyNull, {
    ok: false,
    classification: "same_family_fallback_why_required",
  });

  const why = "preferred different-family CLI unavailable";
  const retry = {
    classification: "same_family_fallback:codex-cli-unavailable",
    sticky_verification: why,
  };
  assert.deepEqual(
    classifySameFamilyStickyReason(`${SAME_FAMILY_FALLBACK_REASON_PREFIX} ${why}; ok`, retry),
    { ok: true },
  );
  assert.deepEqual(
    classifySameFamilyStickyReason(
      `${SAME_FAMILY_FALLBACK_REASON_PREFIX} other-cause; ok`,
      retry,
    ),
    { ok: false, classification: "sticky_same_family_fallback_provenance_missing" },
  );
});

function assertOmitPreviousDispatchId(source, label) {
  assert.doesNotMatch(
    source,
    /previous_dispatch_id:\s*<null on first dispatch/,
    `${label}: must not teach null-on-first-dispatch`,
  );
  assert.doesNotMatch(
    source,
    /previous_dispatch_id:\s*null\b/,
    `${label}: must not teach previous_dispatch_id null literal`,
  );
  const omitHits = source.match(
    /previous_dispatch_id:\s*<omit on first dispatch[^>]*>/g,
  );
  assert.ok(
    omitHits && omitHits.length >= 1,
    `${label}: must omit previous_dispatch_id on first dispatch`,
  );
}

function assertRepoRelativeEvidenceScope(source, label, { minLines = 1 } = {}) {
  const evidenceLines = source
    .split("\n")
    .filter((line) => /^\s*evidence_scope:/.test(line));
  assert.ok(
    evidenceLines.length >= minLines,
    `${label}: must declare evidence_scope (got ${evidenceLines.length})`,
  );
  for (const line of evidenceLines) {
    assert.doesNotMatch(
      line,
      /evidence_scope:\s*<renderer packet_path/,
      `${label}: evidence_scope must not teach absolute carrier paths: ${line}`,
    );
    assert.match(
      line,
      /repo-relative|de-identified|bounded|touch-list|changed.?files|openspec\//i,
      `${label}: evidence_scope example must be repo-relative/de-identified: ${line}`,
    );
  }
  assert.match(
    source,
    /absolute paths? (belong|only).{0,80}(packet_path|observability_context_path)/i,
    `${label}: must direct absolute paths to packet/observability fields`,
  );
}

test("R3 prove-it: first-dispatch templates omit previous_dispatch_id (no null literal)", () => {
  assertOmitPreviousDispatchId(readFileSync(CROSS_REVIEW_SKILL, "utf8"), "devpro:cross-review");
  const skillOmitHits = readFileSync(CROSS_REVIEW_SKILL, "utf8").match(
    /previous_dispatch_id:\s*<omit on first dispatch[^>]*>/g,
  );
  assert.ok(skillOmitHits && skillOmitHits.length >= 2, "both canonical dispatch blocks must omit on first dispatch");
  assertOmitPreviousDispatchId(
    readFileSync(PRE_PR_DISPATCH_BLOCKS, "utf8"),
    "devpro:pre-pr subagent-dispatch-blocks",
  );
});

test("R4 prove-it: evidence_scope examples are repo-relative; absolute paths only for packet/observability", () => {
  assertRepoRelativeEvidenceScope(
    readFileSync(CROSS_REVIEW_SKILL, "utf8"),
    "devpro:cross-review",
    { minLines: 2 },
  );
  assertRepoRelativeEvidenceScope(
    readFileSync(PRE_PR_DISPATCH_BLOCKS, "utf8"),
    "devpro:pre-pr subagent-dispatch-blocks",
    { minLines: 1 },
  );
});

test("R2/R5 prove-it integration markers live in render-second-review-packet.test.mjs", () => {
  const renderTests = readFileSync(
    path.join(REPO_ROOT, ".devpro/scripts/tests/render-second-review-packet.test.mjs"),
    "utf8",
  );
  assert.match(renderTests, /R2 prove-it: handoff done_when reaches rendered packet/);
  assert.match(renderTests, /R5 prove-it: live gh headRefName wins over stale handoff pr_head_ref_name/);
});

test("R5 prove-it: live gh head preferred; handoff/live conflict is reported", async () => {
  const { __testApprovalResolutionBinding } = await import("../render-second-review-packet.mjs");
  const { resolvePrHeadRefName } = __testApprovalResolutionBinding;

  const base = {
    mode: "pr-sticky",
    target: "PR #2710",
    repository_slug: "devpro-tw/devpro-agent-rules",
  };

  const liveGh = (headRefName) => () => ({
    status: 0,
    stdout: JSON.stringify({ headRefName }),
    stderr: "",
  });

  const preferLive = resolvePrHeadRefName(
    { ...base, pr_head_ref_name: "other/stale-branch" },
    { spawnSyncImpl: liveGh("bugfix/strengthen-cross-review-packet-contract") },
  );
  assert.equal(preferLive.headRefName, "bugfix/strengthen-cross-review-packet-contract");
  assert.equal(preferLive.source, "gh");
  assert.equal(preferLive.conflict, true);

  const hermetic = resolvePrHeadRefName(
    { ...base, pr_head_ref_name: "bugfix/strengthen-cross-review-packet-contract" },
    { spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "offline" }) },
  );
  assert.equal(hermetic.headRefName, "bugfix/strengthen-cross-review-packet-contract");
  assert.equal(hermetic.source, "handoff");
  assert.equal(hermetic.conflict, false);
});
