/**
 * second-review-material-contract.test.mjs
 *
 * T1 Contract SSOT prove-it: D2 reviewer family closed set + family groups,
 * D9 page-window ceiling, and cross-carrier consistency of the
 * `external-live-reads` carrier token across its three independent copies
 * (contract / renderer / validator). See openspec/changes/
 * add-external-evaluator-second-review/design.md D2, D3, D9.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_REVIEWER_CLIS,
  CANONICAL_REVIEWER_FAMILY_TOKENS,
  ReviewerCliContractError,
  REVIEWER_FAMILY_GROUPS,
  REVIEW_MATERIAL_CARRIERS,
  SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES,
  SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING,
  SECOND_REVIEW_PR_SCHEMA_VERSION,
  ReviewerFamilyContractError,
  canonicalAdapterRouteProof,
  resolveCanonicalReviewerFamily,
  resolveReviewerCli,
  reviewerTransportEmbedsCompleteOutputPerLine,
  validatePrStickyReviewMaterialContract,
} from "../second-review-material-contract.mjs";
import { readSourceFile } from "./lib/read.mjs";

// F-01: minimal valid v4 pr-sticky row for direct validatePrStickyReviewMaterialContract
// unit calls, isolated from the full-handoff fixtures owned by
// validate-second-review-packet.test.mjs (not in this responsibility's touch list). Only
// exercises the fields validatePrStickyReviewMaterialContract itself reads/requires exact
// keys for; every other V4 top-level key is a cheap stub the function never inspects.
function minimalLiveRow({ carrier, reviewerFamily, primaryFamily = reviewerFamily }) {
  const scope = { kind: "full-pr", pull_request_number: 1717, head_sha: "a".repeat(40) };
  return {
    schema_version: SECOND_REVIEW_PR_SCHEMA_VERSION,
    mode: "pr-sticky",
    attempt: "initial",
    dispatch_id: "11111111-1111-4111-8111-111111111111",
    previous_dispatch_id: null,
    primary_family: primaryFamily,
    reviewer_family: reviewerFamily,
    target: "PR #1717",
    head_ref_oid: scope.head_sha,
    approval_context: "none",
    approval_resolution: { status: "not-required" },
    review_scope: scope,
    scope_summary: "full PR review",
    changed_files_or_touch_list: ["a.txt"],
    review_material_carrier: carrier,
    review_material_capability: "full-pr-bounded-live-reads-v1",
    review_material_proof: canonicalAdapterRouteProof(scope),
    review_material: "",
    previous_sticky: null,
    retry_context: null,
    linked_issue_context: "not_applicable",
    primary_verdict: null,
    evidence: null,
  };
}

test("F-01: external-live-reads never trips the codex-exec 64 KiB transport guard (fix under test)", () => {
  // The guard is adapter-live-pr-reads-specific: an interactive external-evaluator
  // session has no runner CLI spawn and no 64 KiB complete-line bound, so it must stay
  // clean for codex/openai-codex reviewer_family — this is the exact defect F-01 fixed
  // (the pre-fix `else` branch tripped this guard for external-live-reads too, blocking a
  // Claude primary from ever issuing an external ticket to reviewer_family codex/openai-codex).
  for (const reviewerFamily of ["codex", "openai-codex"]) {
    const row = minimalLiveRow({ carrier: "external-live-reads", reviewerFamily, primaryFamily: "claude" });
    assert.deepEqual(
      validatePrStickyReviewMaterialContract(row),
      [],
      `claude primary x reviewer_family ${reviewerFamily} on external-live-reads must be a valid row`,
    );
  }
});

test("F-01: adapter-live-pr-reads still rejects codex/openai-codex with the 64 KiB transport guard (unchanged runner behavior)", () => {
  for (const reviewerFamily of ["codex", "openai-codex"]) {
    const row = minimalLiveRow({ carrier: "adapter-live-pr-reads", reviewerFamily, primaryFamily: "claude" });
    const errors = validatePrStickyReviewMaterialContract(row);
    assert.ok(
      errors.some((message) => /renderer-owned packet route/.test(message)
        && /codex exec --json|per-command output|64 KiB/.test(message)),
      `${reviewerFamily} + adapter-live-pr-reads must still fail closed; got ${JSON.stringify(errors)}`,
    );
  }
  // Claude stays valid on adapter-live-pr-reads (unaffected #1728 baseline).
  const claudeRow = minimalLiveRow({ carrier: "adapter-live-pr-reads", reviewerFamily: "claude" });
  assert.deepEqual(validatePrStickyReviewMaterialContract(claudeRow), []);
});

test("D2: canonicalReviewerFamilies closed set adds gemini as external-only, no other", () => {
  assert.deepEqual(
    [...CANONICAL_REVIEWER_FAMILY_TOKENS].sort(),
    ["claude", "codex", "deepseek", "gemini", "openai-codex"].sort(),
  );
  assert.ok(!CANONICAL_REVIEWER_FAMILY_TOKENS.includes("other"));

  const gemini = resolveCanonicalReviewerFamily("gemini");
  assert.equal(gemini.token, "gemini");
  assert.equal(gemini.tool, "Gemini CLI");
  // Deliberately not "claude" or "codex": no runner CLI recipe branch may select it.
  assert.equal(gemini.cli_family, "external");
  assert.equal(gemini.embeds_complete_output_per_line, false);
  assert.equal(reviewerTransportEmbedsCompleteOutputPerLine("gemini"), false);
});

test("D2: REVIEWER_FAMILY_GROUPS is the exact frozen family-group table, no other", () => {
  assert.deepEqual(REVIEWER_FAMILY_GROUPS, {
    claude: "anthropic",
    codex: "openai",
    "openai-codex": "openai",
    gemini: "google",
    deepseek: "deepseek",
  });
  assert.ok(Object.isFrozen(REVIEWER_FAMILY_GROUPS));
  assert.ok(!Object.hasOwn(REVIEWER_FAMILY_GROUPS, "other"));
  // Every canonical reviewer family token must resolve to a group (no orphan).
  for (const token of CANONICAL_REVIEWER_FAMILY_TOKENS) {
    assert.ok(Object.hasOwn(REVIEWER_FAMILY_GROUPS, token), `missing group for ${token}`);
  }
  // codex and openai-codex are provably the same group (used for cross_model_family_same).
  assert.equal(REVIEWER_FAMILY_GROUPS.codex, REVIEWER_FAMILY_GROUPS["openai-codex"]);
});

test("OpenCode: deepseek is a verified family reachable only through the opencode CLI", () => {
  const deepseek = resolveCanonicalReviewerFamily("deepseek");
  assert.equal(deepseek.cli_family, "opencode");
  assert.equal(deepseek.tool, "OpenCode");
  // OpenCode --format json events embed whole tool outputs per line, so the wrapper-embedded
  // diff is mandatory (same reason as Codex), never live reads.
  assert.equal(reviewerTransportEmbedsCompleteOutputPerLine("deepseek"), true);
  assert.equal(REVIEWER_FAMILY_GROUPS.deepseek, "deepseek");
  assert.notEqual(REVIEWER_FAMILY_GROUPS.deepseek, REVIEWER_FAMILY_GROUPS.claude);
  assert.notEqual(REVIEWER_FAMILY_GROUPS.deepseek, REVIEWER_FAMILY_GROUPS.codex);
});

test("OpenCode: reviewer_cli is a separate axis; omission keeps the legacy per-family resolver", () => {
  assert.deepEqual([...CANONICAL_REVIEWER_CLIS], ["claude", "codex", "opencode"]);
  assert.equal(resolveReviewerCli("claude"), "claude");
  assert.equal(resolveReviewerCli("codex"), "codex");
  assert.equal(resolveReviewerCli("openai-codex"), "codex");
  assert.equal(resolveReviewerCli("deepseek"), "opencode");
  assert.equal(resolveReviewerCli("deepseek", "opencode"), "opencode");
  assert.equal(resolveReviewerCli("claude", "claude"), "claude");
});

test("OpenCode: reviewer_cli rejects unknown values and unverified family/CLI pairings", () => {
  for (const bad of ["OpenCode", " opencode", "gemini", "", null, 1]) {
    assert.throws(() => resolveReviewerCli("deepseek", bad), (error) => {
      assert.ok(error instanceof ReviewerCliContractError);
      assert.equal(error.classification, "reviewer_cli_invalid");
      return true;
    });
  }
  // No free pairing: a CLI may run only the families it is verified for.
  for (const [family, cli] of [["claude", "opencode"], ["codex", "opencode"], ["deepseek", "claude"], ["deepseek", "codex"]]) {
    assert.throws(() => resolveReviewerCli(family, cli), (error) => {
      assert.equal(error.classification, "reviewer_cli_family_mismatch");
      return true;
    });
  }
  // gemini stays external-evaluator-only: it has no runner CLI to pair with.
  assert.throws(() => resolveReviewerCli("gemini", "opencode"), ReviewerCliContractError);
  assert.throws(() => resolveReviewerCli("other"), ReviewerFamilyContractError);
});

test("D2: ReviewerFamilyContractError message stays byte-derived from the closed set (no stale copy)", () => {
  assert.throws(
    () => resolveCanonicalReviewerFamily("other"),
    (error) => {
      assert.ok(error instanceof ReviewerFamilyContractError);
      assert.equal(error.classification, "reviewer_family_invalid");
      for (const token of CANONICAL_REVIEWER_FAMILY_TOKENS) {
        assert.ok(error.message.includes(token), `message missing ${token}: ${error.message}`);
      }
      return true;
    },
  );
});

test("D9: SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES default is unchanged; ceiling is 4", () => {
  assert.equal(SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES, 1);
  assert.equal(SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING, 4);
});

test("D1: contract REVIEW_MATERIAL_CARRIERS includes external-live-reads", () => {
  assert.ok(REVIEW_MATERIAL_CARRIERS.includes("external-live-reads"));
  assert.ok(Object.isFrozen(REVIEW_MATERIAL_CARRIERS));
});

function extractAllowedCarriersLiteral(source, filename) {
  const match = source.match(/const allowedCarriers = new Set\(\[([^\]]*)\]\);/);
  assert.ok(match, `${filename} must declare a literal allowedCarriers Set`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
}

test("D1: renderer and validator carrier whitelists are independent copies that both carry external-live-reads", () => {
  const rendererSource = readSourceFile(".devpro/scripts/render-second-review-packet.mjs");
  const validatorSource = readSourceFile(".devpro/scripts/validate-second-review-packet.mjs");
  const rendererCarriers = extractAllowedCarriersLiteral(rendererSource, "render-second-review-packet.mjs");
  const validatorCarriers = extractAllowedCarriersLiteral(validatorSource, "validate-second-review-packet.mjs");

  assert.deepEqual([...rendererCarriers].sort(), [...validatorCarriers].sort());
  assert.ok(rendererCarriers.includes("external-live-reads"));
  assert.ok(validatorCarriers.includes("external-live-reads"));

  // Cross-carrier invariant (AGENTS.md §10): the input-facing whitelists (renderer,
  // validator) are the contract's carrier closure minus the renderer-derived-only
  // "renderer-paged-snapshot" carrier, which is never an accepted handoff input.
  const contractInputCarriers = REVIEW_MATERIAL_CARRIERS.filter(
    (carrier) => carrier !== "renderer-paged-snapshot",
  );
  assert.deepEqual([...rendererCarriers].sort(), [...contractInputCarriers].sort());
});
