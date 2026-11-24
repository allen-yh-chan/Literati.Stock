import "./lib/isolated-control-evidence-state.mjs";
import "./lib/model-probe-fixture.mjs";
/**
 * Executable contract for the external-evaluator ticket path
 * (add-external-evaluator-second-review T3; design.md D1, D2, D5, D8).
 *
 * Fixtures use only placeholder samples for the D8 scrub cases (a
 * user-home-style path and an RFC 2606 `.invalid` email) — no real secret or
 * PII material, per proposal.md's residual-risk note.
 */

import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { withTempDir } from "./lib/tmp.mjs";
import {
  assertAttemptUnderOwnedRoot,
  assertNotLiveWrite,
  ownedCarrierRootFor,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";
import { deriveMainCheckoutNotesTmp } from "../second-reviewer-cli-recipe-contract.mjs";
import {
  readDispatchEvidence,
  readDispatchEvidenceStrict,
} from "../hooks/lib/second-review-control-evidence.mjs";
import {
  CREDENTIAL_LITERAL_RULE,
  EXTERNAL_CREDENTIAL_LITERAL_RULE,
  EXTERNAL_EVALUATOR_ACCEPT_COMMAND,
  EXTERNAL_EVALUATOR_TICKET_HEADING,
  EXTERNAL_STICKY_RESERVED_LITERAL_RULE,
  SECOND_REVIEW_FRAME_MARKER,
  secondReviewPacketStaticPrefix,
  secondReviewRulesVersion,
  validateSecondReviewPacketText,
  parseCanonicalSecondReviewPacketData,
} from "../validate-second-review-packet.mjs";
import {
  canonicalAdapterRouteProof,
  canonicalEmbeddedReviewMaterialProof,
} from "../second-review-material-contract.mjs";
import { main as acceptExternalReview } from "../accept-external-second-review.mjs";
import { externalAuditReportExample } from "../lib/external-audit-review.mjs";
import { voidExternalDispatch, getSecondReviewObservabilityContext } from "../render-second-review-packet.mjs";
import { reviewChecklistCriteriaLines } from "../lib/second-review-checklist.mjs";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { reviewRoundSidecarPath } from "../hooks/lib/review-round-budget.mjs";
import {
  runGatedStickyWrite,
  stickyWriteResultBasename,
} from "../write-second-review-sticky-gated.mjs";
import { STICKY_CREDENTIAL_LITERAL_BLOCKED } from "../lib/second-review-sticky-credential-gate.mjs";

process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const liveCanonicalCarrierRoot = path.join(path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)), "cross-review");
const canonicalHeadSha = "b".repeat(40);
// Fixed approval fields (design D2): the only values a pr-sticky handoff may carry.
const approvalContext = "none";
const canonicalReviewScope = {
  kind: "full-pr",
  pull_request_number: 456,
  head_sha: canonicalHeadSha,
};

const baseExternalHandoff = {
  mode: "pr-sticky",
  attempt: "initial",
  executor_kind: "external-evaluator",
  primary_family: "openai-codex",
  reviewer_family: "gemini",
  reviewer_tool: "Gemini CLI",
  target: "PR #456",
  head_ref_oid: canonicalHeadSha,
  repository_slug: "devpro/example",
  approval_context: approvalContext,
  approval_resolution: { status: "not-required" },
  pr_head_ref_name: "chore/amend-external-evaluator-ticket-fixture",
  scope_summary: "bounded PR review via external evaluator ticket",
  changed_files_or_touch_list: [
    ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  ],
  review_scope: canonicalReviewScope,
  review_material_carrier: "external-live-reads",
  review_material_capability: "full-pr-bounded-live-reads-v1",
  review_material_proof: canonicalAdapterRouteProof(canonicalReviewScope),
  review_material: "",
  primary_validation_evidence: "openspec validate amend-external-evaluator-ticket-fixture --strict passed",
  primary_test_evidence: "node --test targeted second-review suites passed",
  retry_context: { classification: "none", sticky_verification: "not-needed" },
  sticky_authority_snapshot: {
    repository_slug: "devpro/example",
    pr_number: 456,
    completeness: {
      status: "complete",
      pagination_exhausted: true,
      pages_fetched: 1,
    },
    query_error: null,
    comments: [],
  },
};

// D1/D9 T1 must-keep fixture only: a real runner (non-external) handoff —
// no executor_kind/reviewer_tool, an embedded-diff carrier a runner actually
// supports (unlike baseExternalHandoff's "external-live-reads", which the
// D2/D7 test above proves the runner path typed-rejects) — so its render
// actually reaches buildCredentialGateSidecarContent's non-external branch
// and publishes a real carrier sidecar JSON file to read back.
const runnerReviewMaterial = [
  "diff --git a/.devpro/agent-skills/devpro-reviews/second-review/SKILL.md b/.devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  "--- a/.devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  "+++ b/.devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
  "@@ -1 +1 @@",
  "-legacy",
  "+typed scope",
  "",
].join("\n");
const runnerHandoff = {
  ...baseExternalHandoff,
  review_scope: canonicalReviewScope,
  review_material_carrier: "embedded-diff",
  review_material_capability: "scope-bound-embedded-complete-diff-v1",
  review_material_proof: canonicalEmbeddedReviewMaterialProof(canonicalReviewScope, runnerReviewMaterial),
  review_material: runnerReviewMaterial,
  write_path: "reviewer current neutral cwd body file plus disposition-bound gh api only",
  allowed_tools: `Write,Bash(command -v gh),Bash(gh pr view:*),Bash(node ${repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs")}:*)`,
};
delete runnerHandoff.executor_kind;
delete runnerHandoff.reviewer_tool;
runnerHandoff.reviewer_family = "claude";

function render(handoff, dir, extraEnv = {}) {
  const handoffPath = path.join(dir, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(handoff), "utf8");
  const env = {
    ...process.env,
    DEVPRO_ALLOW_CLAUDE_EFFORT_STUB: "1",
    DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB: "xhigh",
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
    ...extraEnv,
  };
  const prepared = prepareOwnedCanonicalRenderer({
    fixtureDir: dir,
    repoRoot: REPO_ROOT,
    rendererPath: renderer,
  });
  assertNotLiveWrite(
    prepared.mutatedRendererPath,
    prepared.carrierRootArg,
    liveCanonicalCarrierRoot,
    renderer,
  );
  const result = spawnSync(
    process.execPath,
    [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
    { cwd: REPO_ROOT, encoding: "utf8", env },
  );
  const packetPath = result.status === 0 ? result.stdout.trim() : null;
  if (packetPath) {
    assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
  }
  const carrierDir = packetPath ? path.resolve(path.dirname(packetPath)) : null;
  return { result, packetPath, carrierDir };
}

function externalAuditHandoff(overrides = {}) {
  const handoff = {
    ...baseExternalHandoff,
    mode: "audit-only",
    target: "design",
    head_ref_oid: "none",
    scope_summary: "Review the supplied design snapshot only",
    review_material_carrier: "embedded-diff",
    review_material_complete: true,
    review_material: "Design: the caller owns cancellation and must release its subscription.",
    ...overrides,
  };
  for (const field of ["review_scope", "review_material_capability", "review_material_proof", "sticky_authority_snapshot"]) {
    delete handoff[field];
  }
  return handoff;
}

test("external audit ticket freezes material and issues without PR or runner authority", async () => {
  await withTempDir((dir) => {
    const { result, packetPath, carrierDir } = render(externalAuditHandoff(), dir);
    assert.equal(result.status, 0, result.stderr);
    const packet = readFileSync(packetPath, "utf8");
    const context = JSON.parse(readFileSync(path.join(carrierDir, "observability-context.json"), "utf8"));
    const evidence = readDispatchEvidence({ rootDir: path.join(dir, "control-evidence"), dispatchId: context.dispatch_id });
    assert.equal(context.pr_number, "none");
    assert.equal(context.projection_runner_command, null);
    assert.equal(context.reviewer_cli_recipe, null);
    assert.equal(context.sticky_write_disposition.action, "not-applicable");
    assert.equal(context.external_audit_report_path, path.join(carrierDir, "external-audit-review.json"));
    assert.match(context.review_data_sha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.dispatch.mode, "audit-only");
    assert.equal(evidence.dispatch.review_data_sha256, context.review_data_sha256);
    assert.equal(Object.keys(evidence.dispatch).some((key) => key.startsWith("sticky_")), false);
    assert.equal(evidence.invocationClaim, null);
    assert.equal(evidence.completion, null);
    assert.match(packet, /external-audit-review\.json/);
    assert.match(packet, /devpro-external-audit-review\/v1/);
    assert.match(packet, /caller owns cancellation/);
    // F-3 (PR #3357): shared PR-oriented duties stay, so the audit boundary must say it wins.
    const boundary = packet.slice(packet.indexOf("## Audit Output Boundary"), packet.indexOf("## Review Data"));
    assert.match(boundary, /overrides the PR-oriented duties above/);
    assert.match(boundary, /audit_report_file is the only structured output/);
    assert.equal(validateSecondReviewPacketText(packet).ok, true);
    const markerDir = path.join(dir, "post-pr-completion-state");
    assert.equal(existsSync(markerDir) && readdirSync(markerDir).length > 0, false);
  });
});

function writeAuditReport(carrierDir, overrides = {}) {
  const context = readContext(carrierDir);
  const report = { ...externalAuditReportExample({ repositorySlug: context.repository_slug,
    headRefOid: context.head_ref_oid, attemptId: context.attempt_id, dispatchId: context.dispatch_id,
    reviewDataSha256: context.review_data_sha256, reviewerTool: context.reviewer_tool, target: "design" }),
    reviewer_model: "gemini-2.5-pro", reason: "The supplied design assigns cancellation and cleanup to the caller.", ...overrides };
  writeFileSync(context.external_audit_report_path, JSON.stringify(report));
  return report;
}
const noGitHub = () => { throw new Error("Audit must never invoke GitHub or another subprocess"); };

test("external audit acceptance seals a mirrored receipt without GitHub and is idempotent", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(externalAuditHandoff(), dir);
    assert.equal(result.status, 0, result.stderr);
    writeAuditReport(carrierDir, { verdict: "CRITICAL", guarantee_assessment: null });
    const accepted = await acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub });
    assert.equal(accepted.status, "accepted");
    const receipt = JSON.parse(readFileSync(accepted.path));
    assert.equal(receipt.audit_verdict, "CRITICAL");
    assert.equal(receipt.process_close_observed, false);
    assert.equal(receipt.outcome, "external_evaluator_audit_accepted");
    assert.deepEqual(readFileSync(accepted.path), readFileSync(path.join(carrierDir, "completion-receipt.json")));
    assert.equal((await acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub })).status, "already_accepted");
  });
});

test("external audit missing or mismatched report stays open, then accepts a corrected report", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(externalAuditHandoff(), dir);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "external_audit_report_missing" });
    writeAuditReport(carrierDir, { review_data_sha256: "0".repeat(64) });
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "external_audit_report_binding_mismatch" });
    const context = readContext(carrierDir);
    assert.equal(readDispatchEvidence({ rootDir: context.control_evidence_root, dispatchId: context.dispatch_id }).externalClosure, null);
    writeAuditReport(carrierDir);
    assert.equal((await acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub })).status, "accepted");
  });
});

test("external audit rejects packet mutation and symlink reports before closure", async () => {
  await withTempDir(async dir => {
    const { result, packetPath, carrierDir } = render(externalAuditHandoff(), dir);
    assert.equal(result.status, 0, result.stderr);
    writeAuditReport(carrierDir);
    const original = readFileSync(packetPath);
    writeFileSync(packetPath, Buffer.concat([original, Buffer.from("\nmodified")]));
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "external_audit_report_binding_mismatch" });
    writeFileSync(packetPath, original);
    const context = readContext(carrierDir);
    const reportBytes = readFileSync(context.external_audit_report_path);
    rmSync(context.external_audit_report_path);
    writeFileSync(path.join(carrierDir, "elsewhere.json"), reportBytes);
    symlinkSync(path.join(carrierDir, "elsewhere.json"), context.external_audit_report_path);
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "external_audit_report_invalid" });
  });
});

test("external audit rejects a report carrying credential literals and leaves the closure open", async () => {
  await withTempDir(async dir => {
    const material = "Design: the client connects with password=Tr0ub4dor-3x9 and the caller owns cancellation.";
    const { result, carrierDir } = render(externalAuditHandoff({ review_material: material }), dir);
    assert.equal(result.status, 0, result.stderr);
    const context = readContext(carrierDir);
    const closure = () => readDispatchEvidence({ rootDir: context.control_evidence_root, dispatchId: context.dispatch_id }).externalClosure;
    writeAuditReport(carrierDir, { reason: "The design hard-codes Tr0ub4dor-3x9 as the connection secret." });
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "external_audit_report_invalid" });
    assert.equal(closure(), null);
    writeAuditReport(carrierDir, { reason: "The fixture sets pwd=zq81-local-only before connecting." });
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "external_audit_report_invalid" });
    assert.equal(closure(), null);
    writeAuditReport(carrierDir, { reason: "The design keeps a connection password in its material; the caller owns cancellation." });
    assert.equal((await acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub })).status, "accepted");
  });
});

test("an accepted external audit cannot be the predecessor of a real-PR dispatch", async () => {
  await withTempDir(async dir => {
    const audit = render(externalAuditHandoff(), dir);
    assert.equal(audit.result.status, 0, audit.result.stderr);
    writeAuditReport(audit.carrierDir);
    assert.equal((await acceptExternalReview({ argv: [audit.carrierDir], spawnSync: noGitHub })).status, "accepted");
    const auditContext = readContext(audit.carrierDir);
    withPendingMarker(dir, 456);
    const authorityEnv = withAuthoritativePrHead(dir, canonicalHeadSha);
    const successor = render({ ...baseExternalHandoff, previous_dispatch_id: auditContext.dispatch_id }, dir, authorityEnv);
    try {
      assert.notEqual(successor.result.status, 0);
      // Earlier layers (marker binding, audit pr_number "none") refuse this before the
      // control-evidence sticky-completion check; the spec only needs the edge refused.
      assert.match(successor.result.stderr, /^reviewer_dispatch_identity_collision:/m);
      assert.equal(successor.carrierDir, null);
    } finally {
      cleanup(successor.carrierDir);
    }
  });
});

test("external audit recovers receipt and mirror after publication failure without rereading report", async () => {
  await withTempDir(async dir => {
    const { result, carrierDir } = render(externalAuditHandoff(), dir);
    assert.equal(result.status, 0, result.stderr);
    writeAuditReport(carrierDir);
    const mirrorPath = path.join(carrierDir, "completion-receipt.json");
    writeFileSync(mirrorPath, "conflicting bytes");
    await assert.rejects(acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub }), { classification: "reviewer_dispatch_identity_collision" });
    const context = readContext(carrierDir);
    const before = readDispatchEvidenceStrict({ rootDir: context.control_evidence_root, dispatchId: context.dispatch_id });
    assert.equal(before.externalClosure.kind, "accepted");
    rmSync(mirrorPath);
    rmSync(context.external_audit_report_path);
    const recovered = await acceptExternalReview({ argv: [carrierDir], spawnSync: noGitHub });
    assert.equal(recovered.status, "already_accepted");
    assert.deepEqual(readFileSync(recovered.path), readFileSync(mirrorPath));
  });
});

test("external audits with no PR have independent capacity and bind the whole material", async () => {
  await withTempDir(async dir => {
    const first = render(externalAuditHandoff(), dir);
    const second = render(externalAuditHandoff({ review_material: "Changed design: cancellation has an explicit owner." }), dir);
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.notEqual(readContext(first.carrierDir).review_data_sha256, readContext(second.carrierDir).review_data_sha256);
    const { result, carrierDir } = render(externalAuditHandoff({ primary_family: "gemini" }), dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cross_model_family_same/);
  });
});

// ---------------------------------------------------------------------------
// fix-external-evaluator-sticky-recipe T1 prove-it (RED) support helpers
// (design.md D1-D5, D9 item 1; decisions.md D1/D2; tasks.md T1).
//
// The simulated evaluator needs a fixture "main checkout" root whose
// notes/cross-review directory IS the renderer's canonicalCarrierRoot (D2),
// so a rendered ticket's repo-relative sidecar/body lines resolve, via the
// evaluator's own injected cwd, to exactly where the renderer actually wrote
// the carrier files. `render()` above already relocates canonicalCarrierRoot
// to an owned fixture path via `prepareOwnedCanonicalRenderer`'s
// `ownedCarrierRoot`. As built (T4), design D2's containment check
// (externalCarrierRepoRelativeDir) verifies the carrier dir against
// canonicalCarrierRoot + attempt_id only — it never independently re-derives
// from `mainCheckoutRoot` (render-second-review-packet.mjs:201) — so no
// separate mainCheckoutRoot relocation is needed here.
// ---------------------------------------------------------------------------

/**
 * Like render() above, but binds canonicalCarrierRoot to
 * <mainCheckoutFixtureRoot>/notes/cross-review so the rendered ticket's
 * repo-relative lines resolve against mainCheckoutFixtureRoot exactly the way
 * a real main-checkout evaluator session would resolve them against the real
 * main checkout.
 */
function renderUnderMainCheckoutFixture(handoff, mainCheckoutFixtureRoot, extraEnv = {}) {
  const handoffPath = path.join(mainCheckoutFixtureRoot, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(handoff), "utf8");
  const env = {
    ...process.env,
    DEVPRO_ALLOW_CLAUDE_EFFORT_STUB: "1",
    DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB: "xhigh",
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(mainCheckoutFixtureRoot, "control-evidence"),
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(mainCheckoutFixtureRoot, "post-pr-completion-state"),
    ...extraEnv,
  };
  const ownedCarrierRoot = path.join(mainCheckoutFixtureRoot, "notes", "cross-review");
  const prepared = prepareOwnedCanonicalRenderer({
    fixtureDir: mainCheckoutFixtureRoot,
    repoRoot: REPO_ROOT,
    rendererPath: renderer,
    ownedCarrierRoot,
  });
  assertNotLiveWrite(
    prepared.mutatedRendererPath,
    prepared.carrierRootArg,
    liveCanonicalCarrierRoot,
    renderer,
  );
  const result = spawnSync(
    process.execPath,
    [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
    { cwd: REPO_ROOT, encoding: "utf8", env },
  );
  const packetPath = result.status === 0 ? result.stdout.trim() : null;
  if (packetPath) {
    assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
  }
  const carrierDir = packetPath ? path.resolve(path.dirname(packetPath)) : null;
  return { result, packetPath, carrierDir };
}

// Update-disposition external handoff (mirrors the existing F-03 update-target
// fixture below): a prior READY (PASS) sticky exists, so sticky_write_action
// resolves to "update" against comment id 9101 instead of "create".
function updateDispositionExternalHandoff() {
  const priorStickyBody = [
    "<!-- cross-model-second-opinion:sticky -->",
    "verdict: PASS",
    `last_reviewed_sha: ${canonicalHeadSha}`,
    "dispatch_id: prior-dispatch-t1-update",
    "reason: Prior bounded review completed.",
    `Rules: v${secondReviewRulesVersion(REPO_ROOT)} · Tool: Gemini CLI · Model: gemini-test`,
  ].join("\n");
  return {
    ...baseExternalHandoff,
    full_scope_reason: "re-verifying full-pr disposition for the T1 update-disposition fixture",
    sticky_authority_snapshot: {
      ...baseExternalHandoff.sticky_authority_snapshot,
      comments: [
        {
          id: 9101,
          node_id: "IC_kwDOExampleExternalT1Update",
          html_url: "https://github.com/devpro/example/pull/456#issuecomment-9101",
          body: priorStickyBody,
          updated_at: "2026-07-20T03:04:05Z",
        },
      ],
    },
  };
}

/** Split a rendered packet into its renderer-owned prefix and the "## External Evaluator Ticket" suffix. */
function externalTicketSuffixOf(packet) {
  const headingIndex = packet.indexOf(EXTERNAL_EVALUATOR_TICKET_HEADING);
  return { headingIndex, prefix: packet.slice(0, headingIndex), suffix: packet.slice(headingIndex) };
}

/** Extract a single-line `<fieldName>: <value>` field's value from ticket suffix text. */
function ticketFieldValue(suffix, fieldName) {
  return suffix.match(new RegExp(`\\n${fieldName}: (.+)\\n`))?.[1];
}

// Mirrors render-second-review-packet.test.mjs's withAuthoritativePrHead: a
// pending-marker binding calls assertAuthoritativePrHead (`gh pr view`)
// before it may CAS-advance the marker; stub `gh` so this stays offline.
function withAuthoritativePrHead(dir, headRefOid) {
  const binDir = path.join(dir, "mock-bin");
  const ghPath = path.join(binDir, "gh");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(ghPath, [
    "#!/bin/sh",
    "if [ \"$1\" = pr ] && [ \"$2\" = view ]; then",
    "  printf '%s\\n' \"$DEVPRO_TEST_AUTHORITATIVE_PR_HEAD\"",
    "  exit 0",
    "fi",
    "exit 64",
    "",
  ].join("\n"));
  chmodSync(ghPath, 0o700);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    DEVPRO_TEST_AUTHORITATIVE_PR_HEAD: headRefOid,
  };
}

function withPendingMarker(dir, prNumber) {
  const stateDir = path.join(dir, "post-pr-completion-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, `pending-post-pr-completion-${prNumber}.json`),
    JSON.stringify({
      prNumber: String(prNumber),
      branch: "feature/external-ticket-fixture",
      headRefName: "feature/external-ticket-fixture",
      url: `https://github.com/devpro/example/pull/${prNumber}`,
      sessionId: "external-ticket-test",
      createdAt: new Date().toISOString(),
      remindedAt: "",
      repository_slug: "",
      head_ref_oid: "",
      expected_dispatch_id: "",
    }, null, 2),
  );
  return stateDir;
}

function readContext(carrierDir) {
  return JSON.parse(readFileSync(path.join(carrierDir, "observability-context.json"), "utf8"));
}

function readNdjson(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function cleanup(carrierDir) {
  if (carrierDir && existsSync(carrierDir)) {
    rmSync(carrierDir, { recursive: true, force: true });
  }
}

// F-09: render() sets DEVPRO_POST_PR_COMPLETION_STATE_DIR in the child
// process env only; temporarily mirror it into this process's env (same
// swap-and-restore shape as render-second-review-packet.test.mjs's
// seedRoundState) so reviewRoundSidecarPath resolves the same sidecar file
// the renderer just wrote. Returns null when the sidecar does not exist yet
// (pre-render, or a run that never reserved a dispatch).
function readRoundCount(dir, prNumber) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(dir, "post-pr-completion-state");
  try {
    const file = reviewRoundSidecarPath({ prNumber, repositorySlug: baseExternalHandoff.repository_slug });
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")).round_count;
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

test("D1: external ticket renders with no child process, packet carries the External Evaluator Ticket section, and the validator accepts it", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    let packet;
    try {
      assert.equal(result.status, 0, result.stderr);
      packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.ok(packet.includes(EXTERNAL_EVALUATOR_TICKET_HEADING));
      assert.ok(packet.includes(EXTERNAL_EVALUATOR_ACCEPT_COMMAND));
      assert.ok(packet.includes(`Tool: ${baseExternalHandoff.reviewer_tool}`));
      assert.ok(packet.includes(`Rules: v${secondReviewRulesVersion(REPO_ROOT)} · Tool: ${baseExternalHandoff.reviewer_tool} · Model: <actual-model>`));
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

for (const count of [542, 1000]) {
  test(`external ticket preserves and validates all ${count} changed paths`, async () => {
    await withTempDir(async (dir) => {
      const files = Array.from({ length: count }, (_, i) => `src/path-${i}.mjs`);
      const { result, carrierDir } = render({ ...baseExternalHandoff, changed_files_or_touch_list: files }, dir);
      try {
        assert.equal(result.status, 0, result.stderr);
        const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
        const validation = validateSecondReviewPacketText(packet);
        assert.equal(validation.ok, true, validation.missing.join("\n"));
        assert.deepEqual(parseCanonicalSecondReviewPacketData(packet).changed_files_or_touch_list, files);
      } finally {
        cleanup(carrierDir);
      }
    });
  });
}

test("external ticket rejects 1001 changed paths before issuing a ticket", async () => {
  await withTempDir(async (dir) => {
    const files = Array.from({ length: 1001 }, (_, i) => `src/path-${i}.mjs`);
    const { result, packetPath } = render({ ...baseExternalHandoff, changed_files_or_touch_list: files }, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed_files_or_touch_list must contain 1\.\.1000 paths/);
    assert.equal(packetPath, null);
    assert.equal(readRoundCount(dir, 456), null);
  });
});

test("D1: activity carrier atomically contains packet_rendered then external_evaluator_ticket_issued; cli-probe-result is not-applicable and reads no probe_script", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const events = readNdjson(path.join(carrierDir, "projection-activity.ndjson"));
      assert.deepEqual(events.map((event) => event.event), [
        "packet_rendered",
        "external_evaluator_ticket_issued",
      ]);
      const probeResult = JSON.parse(readFileSync(path.join(carrierDir, "cli-probe-result.json"), "utf8"));
      assert.equal(probeResult.status, "not-applicable");
      assert.equal(Object.hasOwn(probeResult, "probe_script"), false);
      const heartbeat = JSON.parse(readFileSync(path.join(carrierDir, "heartbeat.json"), "utf8"));
      assert.equal(heartbeat.status, "external_ticket_issued");
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D1: observability context sets reviewer_cli_recipe/projection_runner_command null, carries executor_kind/primary_family/reviewer_tool, and the two-event activity contract", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const context = readContext(carrierDir);
      assert.equal(context.executor_kind, "external-evaluator");
      assert.equal(context.reviewer_cli_recipe, null);
      assert.equal(context.projection_runner_command, null);
      assert.equal(context.primary_family, "openai-codex");
      assert.equal(context.reviewer_tool, "Gemini CLI");
      assert.deepEqual(context.required_activity_events, [
        "packet_rendered",
        "external_evaluator_ticket_issued",
      ]);
      assert.equal(context.sticky_write_action, "create");
      assert.equal(context.sticky_target_comment_id, null);
      assert.match(context.sticky_snapshot_digest, /^[a-f0-9]{64}$/);
      assert.ok(!Number.isNaN(Date.parse(context.issued_at)));
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D1/D4: dispatch record carries the external binding and round budget advances", async () => {
  await withTempDir(async (dir) => {
    // F-09: this must actually read the review-round-budget sidecar, not just
    // assert dispatch-record fields — the round budget is a distinct
    // authority (reviewRoundSidecarPath) that recordRound() only advances
    // after buildSecondReviewPacket succeeds and dispatch reservation succeeds.
    assert.equal(readRoundCount(dir, 456), null, "no round sidecar must exist before any render");
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const context = readContext(carrierDir);
      const evidence = readDispatchEvidence({
        rootDir: context.control_evidence_root,
        dispatchId: context.dispatch_id,
      });
      assert.equal(evidence.dispatch.executor_kind, "external-evaluator");
      assert.equal(evidence.dispatch.reviewer_family, "gemini");
      assert.equal(evidence.dispatch.primary_family, "openai-codex");
      assert.equal(evidence.dispatch.reviewer_tool, "Gemini CLI");
      assert.equal(evidence.dispatch.sticky_write_action, "create");
      assert.equal(Object.hasOwn(evidence.dispatch, "paged_full_material_sha256"), false);
      assert.equal(readRoundCount(dir, 456), 1, "a successful external render must advance round_count by exactly 1");
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D1/D6: pending post-PR marker CAS writes executor_kind for an external dispatch", async () => {
  await withTempDir(async (dir) => {
    withPendingMarker(dir, 456);
    const { result, carrierDir } = render(
      baseExternalHandoff,
      dir,
      withAuthoritativePrHead(dir, canonicalHeadSha),
    );
    try {
      assert.equal(result.status, 0, result.stderr);
      const stateDir = path.join(dir, "post-pr-completion-state");
      const markerFile = path.join(stateDir, "pending-post-pr-completion-456.json");
      const marker = JSON.parse(readFileSync(markerFile, "utf8"));
      assert.equal(marker.executor_kind, "external-evaluator");
      const context = readContext(carrierDir);
      assert.equal(marker.expected_dispatch_id, context.dispatch_id);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D2: unresolvable primary_family is cross_model_family_unprovable", async () => {
  await withTempDir(async (dir) => {
    const handoff = { ...baseExternalHandoff, primary_family: "other" };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cross_model_family_unprovable/);
      assert.equal(existsSync(path.join(dir, "control-evidence")), false);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D2: same model-provider group as primary_family is cross_model_family_same", async () => {
  await withTempDir(async (dir) => {
    const handoff = {
      ...baseExternalHandoff,
      reviewer_family: "openai-codex",
      reviewer_tool: "Codex",
      primary_family: "codex",
    };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cross_model_family_same/);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D2: same-family issuance is allowed only with an explicit fallback authorization and forces the sticky reason lead", async () => {
  await withTempDir(async (dir) => {
    const why = "codex and claude CLIs are rate limited";
    const handoff = {
      ...baseExternalHandoff,
      reviewer_family: "openai-codex",
      reviewer_tool: "Codex",
      primary_family: "codex",
      retry_context: { classification: `same_family_fallback:${why}`, sticky_verification: why },
    };
    const { result, carrierDir, packetPath } = render(handoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(packetPath, "utf8");
      assert.match(packet, /reason lead \(same-family fallback\): the reason value MUST start with exactly `same-family fallback: codex and claude CLIs are rate limited`/);
      assert.match(packet, /This dispatch is a same-family fallback/);
      const context = JSON.parse(readFileSync(path.join(carrierDir, "observability-context.json"), "utf8"));
      assert.equal(context.same_family_disclosure, `same-family fallback: ${why}`);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D1: external declaring page_window_max_pages or reviewer_effort_ceiling is external_evaluator_field_not_applicable", async () => {
  await withTempDir(async (dir) => {
    for (const field of ["page_window_max_pages", "reviewer_effort_ceiling"]) {
      const value = field === "page_window_max_pages" ? 2 : "xhigh";
      const handoff = { ...baseExternalHandoff, [field]: value };
      const { result, carrierDir } = render(handoff, dir);
      try {
        assert.equal(result.status, 1, field);
        assert.match(result.stderr, /external_evaluator_field_not_applicable/, field);
      } finally {
        cleanup(carrierDir);
      }
    }
  });
});

test("external audit rejects a PR-shaped handoff without frozen audit material", async () => {
  await withTempDir(async (dir) => {
    const handoff = { ...baseExternalHandoff, mode: "audit-only" };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /external audit requires complete embedded material and linked_issue_context none/);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D2/D7: a runner handoff (no executor_kind) declaring gemini or external-live-reads is typed-rejected before any CLI recipe is selected", async () => {
  await withTempDir(async (dir) => {
    const { executor_kind: _executorKind, reviewer_tool: _reviewerTool, ...runnerHandoff } = baseExternalHandoff;
    {
      const { result, carrierDir } = render(runnerHandoff, dir);
      try {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /reviewer_cli_family_unsupported/);
      } finally {
        cleanup(carrierDir);
      }
    }
    {
      const handoff = { ...runnerHandoff, reviewer_family: "claude" };
      const { result, carrierDir } = render(handoff, dir);
      try {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /reviewer_cli_family_unsupported/);
      } finally {
        cleanup(carrierDir);
      }
    }
  });
});

test("D5: void requires packet-dir identity to match its dispatch reservation", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    let otherDir;
    try {
      assert.equal(result.status, 0, result.stderr);
      const context = readContext(carrierDir);
      otherDir = path.join(dir, "spoofed-packet-dir");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(
        path.join(otherDir, "observability-context.json"),
        JSON.stringify(context),
        "utf8",
      );
      await assert.rejects(
        () => voidExternalDispatch(otherDir),
        (error) => error?.classification === "reviewer_dispatch_identity_collision",
      );
    } finally {
      cleanup(carrierDir);
      if (otherDir) rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

test("D5: void writes an idempotent external_evaluator_voided terminal and a rerun stays idempotent", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const context = readContext(carrierDir);
      await voidExternalDispatch(carrierDir);
      const evidence = readDispatchEvidenceStrict({
        rootDir: context.control_evidence_root,
        dispatchId: context.dispatch_id,
      });
      assert.equal(evidence.terminal.outcome_group, "external_evaluator_closed");
      assert.equal(evidence.terminal.classification, "external_evaluator_voided");
      assert.equal(evidence.terminal.process_spawned, false);
      // Idempotent rerun must not throw.
      await voidExternalDispatch(carrierDir);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D8: a placeholder user-home path in a free-text handoff field fails closed before dispatch reservation", async () => {
  await withTempDir(async (dir) => {
    const handoff = {
      ...baseExternalHandoff,
      scope_summary: `${baseExternalHandoff.scope_summary} (see /Users/example-user/notes for context)`,
    };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /external_ticket_unsafe_value/);
      assert.doesNotMatch(result.stderr, /\/Users\/example-user/);
      assert.equal(existsSync(path.join(dir, "control-evidence")), false);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D8: a placeholder non-allowlisted email in evidence narrative fails closed before dispatch reservation", async () => {
  await withTempDir(async (dir) => {
    const handoff = {
      ...baseExternalHandoff,
      primary_test_evidence: `${baseExternalHandoff.primary_test_evidence}; contact user@example.invalid`,
    };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /external_ticket_unsafe_value/);
      assert.doesNotMatch(result.stderr, /user@example\.invalid/);
      assert.equal(existsSync(path.join(dir, "control-evidence")), false);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D8: a placeholder GitHub token in evidence narrative fails closed before dispatch reservation", async () => {
  await withTempDir(async (dir) => {
    const token = `ghp_${"a".repeat(36)}`;
    const handoff = {
      ...baseExternalHandoff,
      primary_validation_evidence: `${baseExternalHandoff.primary_validation_evidence}; token=${token}`,
    };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /external_ticket_unsafe_value/);
      assert.doesNotMatch(result.stderr, new RegExp(token));
      assert.equal(existsSync(path.join(dir, "control-evidence")), false);
    } finally {
      cleanup(carrierDir);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 continue: D8 scrub coverage across every free-text handoff-derived leaf,
// plus the packet's non-carried surfaces and a runner-path regression guard
// for writePostPrCompletionMarker (design.md D6/D8; tasks.md T3).
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Placeholder samples only (per this file's header note): a user-home path, a
// non-allowlisted email, and one representative value per D8 secret category.
const UNSAFE_VALUE_SAMPLES = [
  { label: "user-home-path", value: "/Users/example-user/notes", category: "pii:unix-users-path" },
  { label: "non-allowlisted-email", value: "user@example.invalid", category: "pii:email" },
  { label: "pem-private-key", value: "-----BEGIN PRIVATE KEY-----", category: "secret:pem_private_key" },
  { label: "github-token", value: `ghp_${"a".repeat(24)}`, category: "secret:github_token" },
  { label: "aws-access-key-id", value: `AKIA${"A".repeat(16)}`, category: "secret:aws_access_key_id" },
  { label: "slack-token", value: `xoxb-${"1".repeat(12)}`, category: "secret:slack_token" },
  { label: "authorization-bearer-header", value: `Authorization: Bearer ${"a".repeat(20)}`, category: "secret:authorization_bearer_header" },
  { label: "ai-provider-key", value: `sk-${"a".repeat(20)}`, category: "secret:ai_provider_api_key" },
  { label: "jwt", value: `eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(20)}`, category: "secret:jwt" },
];

// `approval_context` and `approval_resolution` are not in FIELD_INJECTIONS: a pr-sticky handoff may
// only carry the fixed `none` / `{"status":"not-required"}` values (design D2), so those
// two fields hold no free text and any other value is refused by assertValidHandoff before scrub.
const FIELD_INJECTIONS = [
  {
    label: "scope_summary",
    path: "review_data.scope_summary",
    apply: (value) => ({
      ...baseExternalHandoff,
      scope_summary: `${baseExternalHandoff.scope_summary} (${value})`,
    }),
  },
  {
    label: "evidence[].narrative",
    path: "review_data.evidence[0].narrative",
    apply: (value) => ({
      ...baseExternalHandoff,
      primary_validation_evidence: `${baseExternalHandoff.primary_validation_evidence} (${value})`,
    }),
  },
  {
    label: "previous_sticky",
    path: "review_data.previous_sticky",
    apply: (value) => ({
      ...baseExternalHandoff,
      previous_sticky: `prior sticky excerpt (${value})`,
    }),
  },
  {
    label: "retry_context.classification",
    path: "review_data.retry_context.classification",
    apply: (value) => ({
      ...baseExternalHandoff,
      retry_context: { ...baseExternalHandoff.retry_context, classification: `retry-detail (${value})` },
    }),
  },
  {
    label: "retry_context.sticky_verification",
    path: "review_data.retry_context.sticky_verification",
    apply: (value) => ({
      ...baseExternalHandoff,
      retry_context: { ...baseExternalHandoff.retry_context, sticky_verification: `verification-detail (${value})` },
    }),
  },
  {
    label: "changed_files_or_touch_list",
    path: `review_data.changed_files_or_touch_list[${baseExternalHandoff.changed_files_or_touch_list.length}]`,
    apply: (value) => ({
      ...baseExternalHandoff,
      changed_files_or_touch_list: [...baseExternalHandoff.changed_files_or_touch_list, value],
    }),
  },
];

// `review_scope` (kind/pull_request_number/head_sha) is walked by the same
// recursive scrub, but every leaf is either enum/numeric/hex-shaped and
// cross-validated against other handoff fields *before* scrub runs (D2/D6
// identity and full-pr-patch-probe checks) — there is no free-text leaf in it
// that can carry an injected value without first tripping an unrelated,
// earlier-firing structural error. Per this task's own escape clause, this
// bucket is intentionally not in FIELD_INJECTIONS above.

for (const field of FIELD_INJECTIONS) {
  test(`D8: ${field.label} — every unsafe-value category fails closed with field path + pattern category, never the value, before dispatch reservation`, async () => {
    await withTempDir(async (dir) => {
      for (const sample of UNSAFE_VALUE_SAMPLES) {
        const handoff = field.apply(sample.value);
        const { result, carrierDir } = render(handoff, dir);
        const label = `${field.label} / ${sample.label}`;
        try {
          assert.equal(result.status, 1, `${label}: ${result.stderr}`);
          assert.match(result.stderr, /external_ticket_unsafe_value/, label);
          assert.match(
            result.stderr,
            new RegExp(`${escapeRegExp(field.path)} \\(${escapeRegExp(sample.category)}\\)`),
            `${label}: expected field path + pattern category in: ${result.stderr}`,
          );
          assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(sample.value)), `${label}: raw value must not leak`);
          assert.equal(existsSync(path.join(dir, "control-evidence")), false, label);
        } finally {
          cleanup(carrierDir);
        }
      }
    });
  });
}

// Point 2 (serialized-payload-only match): deliberately not implemented as a
// test. JSON.stringify always separates adjacent string leaves — whether
// object properties (`","<key>":"`) or array elements (`","`) — with
// structural quote/comma characters that are neither optional in any D8
// pattern's fixed anchor tokens nor members of any of their bounded classes
// (none of the 9 patterns contain a quantified `[^"]*`/`.*`-style gap that
// could swallow `","`). Every pattern's only "gap" quantifiers are bounded
// character-class runs (e.g. `[A-Za-z0-9]{20,255}`) between literal anchors
// (`ghp_`, `AKIA`, `Authorization:` … `Bearer`, `-----BEGIN`, `eyJ` …), so a
// value split across two leaves can only complete a match if the JSON
// separator itself is drawn from the pattern's allowed class — and none of
// the 9 classes include `"`, `,`, or `:`. Given findPIIHits/findSecretHits
// already run on the exact same `data` object the structured walk visits
// (assertExternalPacketScrub scans both from one `data`), the serialized
// scan cannot observe any leaf pairing the structured walk does not already
// see. This is therefore correctly a structural no-op / defense-in-depth
// layer for the current pattern set, not a reachable extra catch — reported
// per this task's "若實際上無法構造，回報原因" clause instead of a fabricated test.

test("D8/D1: renderer-owned ticket template text (gh api recipe, footer template) is assembled after scrub and never trips it", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.match(packet, /sticky_write_exact_recipe: node \.devpro\/scripts\/write-second-review-sticky-gated\.mjs notes\/cross-review\//);
      assert.match(packet, /accept-external-second-review/);
      assert.doesNotMatch(packet, /set sidecar body_file to the absolute path/);
      assert.doesNotMatch(packet, /evaluator-owned/);
      assert.match(packet, /Rules: v[^\s·]+ · Tool: Gemini CLI · Model: <actual-model>/);
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
      // Positive control confirms these matrix-style assertions actually
      // exercise dispatch reservation, unlike every D8 failure case above.
      assert.equal(existsSync(path.join(dir, "control-evidence")), true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D1/D8: external packet.md excludes observability/control-plane paths and any tmpdir absolute path", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      for (const basename of [
        "observability-context.json",
        "heartbeat.json",
        "projection-activity.ndjson",
        "cli-probe-result.json",
        "reviewer-stdout.ndjson",
        "reviewer-stderr.log",
      ]) {
        assert.equal(packet.includes(basename), false, basename);
      }
      assert.equal(packet.includes("control_evidence_root"), false);
      assert.equal(packet.includes(dir), false, "packet must not carry the tmpdir absolute path");
      assert.equal(packet.includes(carrierDir), false, "packet must not carry the carrier dir absolute path");
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D8: a scrub failure never advances the pending post-PR marker (no CAS bind, no round advance)", async () => {
  await withTempDir(async (dir) => {
    withPendingMarker(dir, 456);
    const handoff = {
      ...baseExternalHandoff,
      primary_validation_evidence: `${baseExternalHandoff.primary_validation_evidence}; token=${`ghp_${"a".repeat(24)}`}`,
    };
    const { result, carrierDir } = render(handoff, dir, withAuthoritativePrHead(dir, canonicalHeadSha));
    try {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /external_ticket_unsafe_value/);
      const stateDir = path.join(dir, "post-pr-completion-state");
      const markerFile = path.join(stateDir, "pending-post-pr-completion-456.json");
      const marker = JSON.parse(readFileSync(markerFile, "utf8"));
      assert.equal(marker.expected_dispatch_id, "", "marker must stay unbound on a scrub failure");
      assert.equal(Object.hasOwn(marker, "executor_kind"), false);
      assert.equal(existsSync(path.join(dir, "control-evidence")), false);
      // F-09: assertExternalPacketScrub runs inside buildSecondReviewPacket, before
      // dispatch reservation; recordRound() in main() only runs after both succeed, so a
      // scrub failure must leave the round-budget sidecar absent (+0), not merely at 0.
      assert.equal(readRoundCount(dir, 456), null, "a scrub failure must never advance (or create) the round sidecar");
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D6: writePostPrCompletionMarker without executorKind writes no executor_kind key (runner-path regression guard)", async () => {
  await withTempDir(async (dir) => {
    const previousStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(dir, "post-pr-completion-state");
    try {
      const file = writePostPrCompletionMarker({
        cwd: dir,
        prNumber: "456",
        branch: "feature/external-ticket-fixture",
        url: "https://github.com/devpro/example/pull/456",
      });
      const raw = readFileSync(file, "utf8");
      assert.doesNotMatch(raw, /executor_kind/);
      const marker = JSON.parse(raw);
      assert.deepEqual(Object.keys(marker), [
        "prNumber",
        "branch",
        "headRefName",
        "url",
        "sessionId",
        ...(marker.sessionKey ? ["sessionKey", "host"] : []),
        "worktree",
        "authorityId",
        "createdAt",
        "remindedAt",
        "repo",
        "repository_slug",
        "head_ref_oid",
        "expected_dispatch_id",
      ]);
    } finally {
      if (previousStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
      else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previousStateDir;
    }
  });
});

// ---------------------------------------------------------------------------
// Primary-review fixes: F-01 (64 KiB transport guard narrowed to
// adapter-live-pr-reads), F-03 (Pre-Write Live Check re-reads PR head +
// bounded marker id-list read), F-04 (external-only static prefix), F-09
// (round-budget assertions the dispatch-record test previously skipped).
// ---------------------------------------------------------------------------

test("F-01: external ticket renders for primary claude x reviewer_family codex/openai-codex and the validator passes (adapter-live-pr-reads guard no longer trips external-live-reads)", async () => {
  await withTempDir(async (dir) => {
    for (const reviewerFamily of ["codex", "openai-codex"]) {
      const handoff = {
        ...baseExternalHandoff,
        primary_family: "claude",
        reviewer_family: reviewerFamily,
        reviewer_tool: "Codex",
      };
      const { result, carrierDir } = render(handoff, dir);
      try {
        assert.equal(result.status, 0, `${reviewerFamily}: ${result.stderr}`);
        const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
        assert.ok(packet.includes(EXTERNAL_EVALUATOR_TICKET_HEADING), reviewerFamily);
        const validation = validateSecondReviewPacketText(packet);
        assert.deepEqual(validation.missing, [], `${reviewerFamily}: ${validation.missing.join("\n")}`);
        assert.equal(validation.ok, true, reviewerFamily);
      } finally {
        cleanup(carrierDir);
      }
    }
  });
});

test("F-03: external ticket Pre-Write Live Check re-reads the current PR head and performs one bounded canonical-marker id-list read (create disposition)", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const prNumber = baseExternalHandoff.review_scope.pull_request_number;
      const repositorySlug = baseExternalHandoff.repository_slug;
      assert.ok(packet.includes("### Pre-Write Live Check"));
      assert.ok(packet.includes(
        `gh pr view ${prNumber} --repo ${repositorySlug} --json headRefOid --jq .headRefOid`,
      ));
      assert.ok(packet.includes("differs from head_ref_oid above, STOP and report to the TL"));
      assert.ok(packet.includes(
        `gh api repos/${repositorySlug}/issues/${prNumber}/comments --paginate --jq`,
      ));
      // The recipe returns one marker-comment id per line (never a bare count nor a
      // page-wrapping array — see r2-05), so the prose requiring an exact-id match for
      // update stays consistent with what the reviewer can actually read back — this is
      // the exact contradiction F-03 fixed, refined by r2-05's per-line correction.
      assert.ok(packet.includes("| .id'"));
      assert.ok(packet.includes("output MUST be empty (no lines)"));
      assert.doesNotMatch(packet, /\| length'/);
      assert.doesNotMatch(packet, /--jq '\[\.\[\]/);
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("F-03: external ticket Pre-Write Live Check binds the exact target id for an update disposition", async () => {
  await withTempDir(async (dir) => {
    const priorStickyBody = [
      "<!-- cross-model-second-opinion:sticky -->",
      "verdict: PASS",
      `last_reviewed_sha: ${canonicalHeadSha}`,
      "dispatch_id: prior-dispatch",
      "reason: Prior bounded review completed.",
      `Rules: v${secondReviewRulesVersion(REPO_ROOT)} · Tool: Gemini CLI · Model: gemini-test`,
    ].join("\n");
    const handoff = {
      ...baseExternalHandoff,
      // A prior READY (PASS) sticky for this PR requires full_scope_reason to
      // unlock full-pr scope again (review-scope-minimality gate, unrelated to F-03).
      full_scope_reason: "re-verifying full-pr disposition for the F-03 update-target fixture",
      sticky_authority_snapshot: {
        ...baseExternalHandoff.sticky_authority_snapshot,
        comments: [
          {
            id: 9001,
            node_id: "IC_kwDOExampleExternal1",
            html_url: "https://github.com/devpro/example/pull/456#issuecomment-9001",
            body: priorStickyBody,
            updated_at: "2026-07-20T03:04:05Z",
          },
        ],
      },
    };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.ok(packet.includes("sticky_write_action: update"));
      assert.ok(packet.includes("sticky_write_comment_id: 9001"));
      assert.ok(packet.includes("output MUST be exactly one line, equal to sticky_write_comment_id"));
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

// Codex pr-sticky r1 CRITICAL on PR #2895 (decision D2): on the external path
// the gated writer only guards a cooperating evaluator, so the ticket's
// credential_literal_rule must not claim the write-before gate enforces it.
// The runner prefix keeps its original rule byte for byte.
test("External ticket credential_literal_rule names the accept backstop and keeps the runner rule unchanged", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const headerStart = packet.indexOf(SECOND_REVIEW_FRAME_MARKER);
      const prefix = packet.slice(0, headerStart);
      assert.ok(prefix.includes(`- ${EXTERNAL_CREDENTIAL_LITERAL_RULE}\n`), "external prefix must carry the external credential rule");
      assert.equal(prefix.includes("write-before mechanical gate enforces this"), false);
      assert.match(EXTERNAL_CREDENTIAL_LITERAL_RULE, /^credential_literal_rule: /);
      assert.match(EXTERNAL_CREDENTIAL_LITERAL_RULE, /not a trust boundary/);
      assert.match(EXTERNAL_CREDENTIAL_LITERAL_RULE, /post-write accept check is the mechanical backstop/);
      assert.equal(validateSecondReviewPacketText(packet).ok, true);

      const reverted = `${prefix.replace(EXTERNAL_CREDENTIAL_LITERAL_RULE, CREDENTIAL_LITERAL_RULE)}${packet.slice(headerStart)}`;
      const validation = validateSecondReviewPacketText(reverted);
      assert.equal(validation.ok, false, "the runner rule wording in an external prefix must fail validation");
      assert.ok(
        validation.missing.some((message) => message.includes("external credential_literal_rule")),
        JSON.stringify(validation.missing),
      );

      const runnerPrefix = secondReviewPacketStaticPrefix("Claude Code", "pr-sticky");
      assert.ok(runnerPrefix.includes(`- ${CREDENTIAL_LITERAL_RULE}\n`), "runner prefix keeps the original rule");
      assert.equal(runnerPrefix.includes(EXTERNAL_CREDENTIAL_LITERAL_RULE), false);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("F-04: external ticket prefix omits runner-only wrapper-env/cwd/CLI-recipe phrases and states the external write mechanics", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const checklistCriteria = reviewChecklistCriteriaLines().join("\n");
      assert.ok(checklistCriteria.includes("neutral cwd"), "real shared criterion exercises the phrase collision");
      assert.ok(packet.includes(checklistCriteria));
      const operationalPacket = packet.replace(checklistCriteria, "");
      // Runner-only phrases the external prefix must never assert to an interactive
      // external-evaluator session (see validate-second-review-packet.mjs's
      // EXTERNAL_PACKET_PREFIX_FORBIDDEN_PHRASES). Bare "GH_REPO" is deliberately NOT
      // asserted here: the shared, carrier-agnostic Review Duties linked_issue_context
      // bullet legitimately ends "...or GH_REPO." in both the runner and external
      // prefixes (a prohibition on gh's implicit repo context, not a runner-only claim).
      for (const phrase of [
        "wrapper-injected GH_REPO",
        "DEVPRO_REVIEW_PR_NUMBER",
        "no-shell-env-probe",
        "neutral cwd",
        "current Codex adapter",
        "wrapper has already enumerated the complete canonical marker candidate set",
        "create exactly cross-model-second-opinion.md in the current neutral cwd",
      ]) {
        assert.equal(operationalPacket.includes(phrase), false, phrase);
      }
      assert.ok(packet.includes("gitignored notes/cross-review carrier directory of the main checkout"));
      assert.equal(packet.includes("outside the target repository working tree"), false);
      assert.ok(packet.includes("this ticket's own Review Data"));
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
      for (const phrase of ["neutral cwd", "wrapper-injected GH_REPO"]) {
        const changed = packet.replace("## Review Duties", `## Review Duties\n${phrase}`);
        const rejected = validateSecondReviewPacketText(changed);
        assert.equal(rejected.ok, false);
        assert.ok(rejected.missing.includes(
          `external evaluator packet prefix must not contain the runner-only phrase "${phrase}"`,
        ), "runner wording outside exact installation-owned criteria still fails closed");
      }
      const changedCriteria = packet.replace(checklistCriteria, checklistCriteria.replace("neutral cwd", "neutral cwd EXTRA"));
      assert.ok(validateSecondReviewPacketText(changedCriteria).missing.includes(
        'external evaluator packet prefix must not contain the runner-only phrase "neutral cwd"',
      ), "caller-modified criteria cannot gain the trusted-text exclusion");
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("F-09 (optional): external render invokes zero reviewer CLI executables (codex/claude PATH sentinel stubs)", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "cli-sentinel-bin");
    mkdirSync(binDir, { recursive: true });
    const sentinelPath = path.join(dir, "cli-invocations.log");
    for (const cliName of ["codex", "claude"]) {
      const stubPath = path.join(binDir, cliName);
      writeFileSync(stubPath, [
        "#!/bin/sh",
        `printf '%s invoked\\n' "${cliName}" >> "${sentinelPath}"`,
        "exit 0",
        "",
      ].join("\n"));
      chmodSync(stubPath, 0o700);
    }
    const { result, carrierDir } = render(baseExternalHandoff, dir, {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(sentinelPath), false, "external render must never invoke a reviewer CLI executable");
    } finally {
      cleanup(carrierDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 2 primary-review fixes: r2-01 (marker-first-line body format text),
// r2-05 (Pre-Write Live Check must emit one id per line, not one array per
// page), r2-06 (external Claude body-file recipe must not assume repo cwd).
// ---------------------------------------------------------------------------

test("F-aeesr-r2-01/r4-01: Sticky Body Format states the marker is the first physical line and the review heading plus Markdown results go after reason:", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.ok(packet.includes("### Sticky Body Format"));
      assert.ok(packet.includes(
        "MUST start with exactly this marker as its very first physical line",
      ));
      assert.ok(packet.includes(
        "write the `## Cross-Model Second Opinion Review` heading followed by your six-axis and security review results as Markdown",
      ));
      // r3-03: the old wording invited a free-form findings section between reason: and
      // the footer without naming the literals the parser counts body-wide.
      assert.equal(packet.includes("MUST be placed after the reason: line above and before the footer line below"), false);
      assert.ok(packet.includes("MUST end with exactly this footer as its final physical line"));
      // The old wording ("MUST end with exactly this footer block") described the whole
      // marker+fields+footer block as a trailing unit, which let an evaluator legally read
      // it as "put your own summary heading before this block" — exactly the defect r2-01
      // fixed (accept then rejects with sticky_marker_not_first_line).
      assert.doesNotMatch(packet, /MUST end with exactly this footer block/);
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("F-aeesr-r2-05: Pre-Write Live Check emits one canonical-marker comment id per line (not an array per page)", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const prNumber = baseExternalHandoff.review_scope.pull_request_number;
      const repositorySlug = baseExternalHandoff.repository_slug;
      const expectedRecipe = `gh api repos/${repositorySlug}/issues/${prNumber}/comments --paginate --jq '.[] | select(.body | contains("<!-- cross-model-second-opinion:sticky -->")) | .id'`;
      assert.ok(packet.includes(expectedRecipe), packet);
      // The prior array-per-page form (`--jq '[... ] | length'` or `'[... | .id]'`) prints
      // one JSON array PER `gh api --paginate` page (30 comments/page), so any PR with more
      // than one page of comments always printed multiple lines and the create/update check
      // could never match — this is exactly the defect r2-05 fixed.
      assert.doesNotMatch(packet, /--jq '\[\.\[\]/);
      assert.ok(packet.includes("create → the command's output MUST be empty (no lines)"));
      assert.ok(packet.includes("update → the command's output MUST be exactly one line, equal to sticky_write_comment_id"));
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("F-aeesr-r2-06: external ticket for reviewer_tool Claude Code uses the carrier-relative gated write recipe, not a repo-cwd-relative filename", async () => {
  await withTempDir(async (dir) => {
    const handoff = {
      ...baseExternalHandoff,
      primary_family: "codex",
      reviewer_family: "claude",
      reviewer_tool: "Claude Code",
    };
    const { result, carrierDir } = render(handoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      // PRIM-F8/F22: external sticky_write_exact_recipe is an executable repo-relative
      // gated-writer command with no <reviewer-body-file> placeholder.
      assert.equal(packet.includes("<reviewer-body-file>"), false);
      assert.match(packet, /sticky_write_exact_recipe: node \.devpro\/scripts\/write-second-review-sticky-gated\.mjs notes\/cross-review\//);
      // Old Claude Code recipe: a fixed relative filename with no cwd guidance, which the
      // ticket's own write_path rule says to write OUTSIDE the target repo working tree — an
      // interactive shell's cwd is usually the repo itself, so `gh` cannot resolve the
      // relative `@cross-model-second-opinion.md` path. This is exactly the defect r2-06 fixed.
      assert.equal(packet.includes("sticky_write_body_file: cross-model-second-opinion.md"), false);
      assert.equal(packet.includes("-F body=@cross-model-second-opinion.md"), false);
      // No absolute local path either: the validator forbids leaking a host filesystem path.
      assert.doesNotMatch(packet, /-F body=@\/\S+/);
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 3 primary-review fixes: r3-03 (reserved literals the sticky parser
// counts body-wide), r3-06 (id listing wording, body-file and created-id
// placeholder substitution).
// ---------------------------------------------------------------------------

test("F-aeesr-r3-03: ticket names the reserved sticky literals in both the prefix and the Sticky Body Format, and the validator requires them", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const suffixStart = packet.indexOf(EXTERNAL_EVALUATOR_TICKET_HEADING);
      assert.ok(suffixStart > 0);
      const prefixOccurrence = packet.indexOf(EXTERNAL_STICKY_RESERVED_LITERAL_RULE);
      assert.ok(prefixOccurrence >= 0 && prefixOccurrence < suffixStart, "prefix must carry the reserved literal rule");
      assert.ok(packet.indexOf(EXTERNAL_STICKY_RESERVED_LITERAL_RULE, suffixStart) > suffixStart, "Sticky Body Format must carry the reserved literal rule");
      for (const literal of ["`Rules:`", "`Tool:`", "`Model:`", "`verdict:`", "`reason:`", "`tracked_follow_up:`"]) {
        assert.ok(EXTERNAL_STICKY_RESERVED_LITERAL_RULE.includes(literal), literal);
      }
      assert.equal(validateSecondReviewPacketText(packet).ok, true);
      const stripped = packet.split(EXTERNAL_STICKY_RESERVED_LITERAL_RULE).join("");
      const validation = validateSecondReviewPacketText(stripped);
      assert.equal(validation.ok, false);
      assert.ok(validation.missing.some((error) => error.includes("reserved literal rule")), validation.missing.join("\n"));
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("F-aeesr-r3-06: ticket says id listing, not count, and names the created-id substitution", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.equal(/Live Check count|id count/.test(packet), false);
      assert.ok(packet.includes("canonical-marker id listing in Pre-Write Live Check"));
      assert.ok(packet.includes("Pre-Write Live Check id listing above"));
      assert.equal(packet.includes("write the fixed body file"), false);
      assert.ok(packet.includes("write_command_shape: for create or update only, from the main checkout root write the body file at sticky_write_body_file"));
      // PRIM-F22: no <reviewer-body-file> substitution; readback still names <created-id>.
      assert.equal(packet.includes("replace <reviewer-body-file>"), false);
      const substitution = "in sticky_write_readback_recipe replace <created-id> with the comment id the create write returned";
      assert.ok(packet.includes(substitution));
      const validation = validateSecondReviewPacketText(packet.replace(substitution, "no substitution named"));
      assert.equal(validation.ok, false);
      assert.ok(validation.missing.some((error) => error.includes("created-id")), validation.missing.join("\n"));
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("D1/D5: void then reissue continues lineage via previous_dispatch_id", async () => {
  await withTempDir(async (dir) => {
    withPendingMarker(dir, 456);
    const authorityEnv = withAuthoritativePrHead(dir, canonicalHeadSha);
    const first = render(baseExternalHandoff, dir, authorityEnv);
    let secondCarrierDir;
    try {
      assert.equal(first.result.status, 0, first.result.stderr);
      const firstContext = readContext(first.carrierDir);
      await voidExternalDispatch(first.carrierDir);
      const reissued = {
        ...baseExternalHandoff,
        previous_dispatch_id: firstContext.dispatch_id,
      };
      const second = render(reissued, dir, authorityEnv);
      secondCarrierDir = second.carrierDir;
      assert.equal(second.result.status, 0, second.result.stderr);
      const secondContext = readContext(secondCarrierDir);
      assert.equal(secondContext.previous_dispatch_id, firstContext.dispatch_id);
      assert.notEqual(secondContext.dispatch_id, firstContext.dispatch_id);
    } finally {
      cleanup(first.carrierDir);
      cleanup(secondCarrierDir);
    }
  });
});

// Second review r1 finding 2: a coordinated rewrite of the ticket's
// repository:/pr_number: lines and both Pre-Write Live Check commands to a
// different PR must not validate, and removing either line must not silently
// skip the live-check assertions.
test("external ticket repository/pr_number lines are bound to the sticky disposition and framed target", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.equal(validateSecondReviewPacketText(packet).ok, true);
      const prNumber = String(baseExternalHandoff.review_scope.pull_request_number);
      const repositorySlug = baseExternalHandoff.repository_slug;
      const headingIndex = packet.indexOf("## External Evaluator Ticket");
      assert.ok(headingIndex > 0);
      const prefix = packet.slice(0, headingIndex);
      const suffix = packet.slice(headingIndex);

      const otherPr = String(Number(prNumber) + 1);
      const retargeted = suffix
        .replace(`\npr_number: ${prNumber}\n`, `\npr_number: ${otherPr}\n`)
        .replace(`gh pr view ${prNumber} --repo`, `gh pr view ${otherPr} --repo`)
        .replace(`repos/${repositorySlug}/issues/${prNumber}/comments`, `repos/${repositorySlug}/issues/${otherPr}/comments`);
      assert.notEqual(retargeted, suffix);
      const retargetedValidation = validateSecondReviewPacketText(prefix + retargeted);
      assert.equal(retargetedValidation.ok, false);
      assert.ok(retargetedValidation.missing.some((error) => /must match the sticky write disposition/.test(error)),
        retargetedValidation.missing.join("\n"));
      assert.ok(retargetedValidation.missing.some((error) => /must match the framed target/.test(error)),
        retargetedValidation.missing.join("\n"));

      const otherRepo = "devpro/other-example";
      const repoRetargeted = suffix
        .replace(`\nrepository: ${repositorySlug}\n`, `\nrepository: ${otherRepo}\n`)
        .replace(`--repo ${repositorySlug} `, `--repo ${otherRepo} `)
        .replace(`repos/${repositorySlug}/issues/`, `repos/${otherRepo}/issues/`);
      assert.notEqual(repoRetargeted, suffix);
      const repoValidation = validateSecondReviewPacketText(prefix + repoRetargeted);
      assert.equal(repoValidation.ok, false);
      assert.ok(repoValidation.missing.some((error) => /must match the sticky write disposition/.test(error)),
        repoValidation.missing.join("\n"));

      for (const line of [`\nrepository: ${repositorySlug}\n`, `\npr_number: ${prNumber}\n`]) {
        const stripped = suffix.replace(line, "\n");
        assert.notEqual(stripped, suffix);
        const strippedValidation = validateSecondReviewPacketText(prefix + stripped);
        assert.equal(strippedValidation.ok, false);
        assert.ok(strippedValidation.missing.some((error) => /must carry its repository: and pr_number: lines/.test(error)),
          strippedValidation.missing.join("\n"));
      }
    } finally {
      cleanup(carrierDir);
    }
  });
});

// Post-PR second review r2: the first-match structural checks accepted a
// second, conflicting target pair or live-check command appended to an
// otherwise canonical ticket; the whole suffix must equal its canonical rendering.
test("external ticket rejects duplicate conflicting target declarations and live-check commands", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.equal(validateSecondReviewPacketText(packet).ok, true);
      const prNumber = String(baseExternalHandoff.review_scope.pull_request_number);
      const repositorySlug = baseExternalHandoff.repository_slug;
      const otherPr = String(Number(prNumber) + 1);
      const identityBlock = `\nrepository: ${repositorySlug}\npr_number: ${prNumber}\n`;
      assert.ok(packet.includes(identityBlock));
      const variants = [
        packet.replace(identityBlock, `${identityBlock}repository: devpro/other-example\npr_number: ${otherPr}\n`),
        packet.replace("\n### Sticky Body Format", `\nBefore writing, re-read the current PR head: gh pr view ${otherPr} --repo ${repositorySlug} --json headRefOid --jq .headRefOid.\n\n### Sticky Body Format`),
        packet.replace("\n### Sticky Body Format", `\ngh api repos/${repositorySlug}/issues/${otherPr}/comments --paginate --jq '.[] | .id'\n\n### Sticky Body Format`),
      ];
      for (const variant of variants) {
        assert.notEqual(variant, packet);
        const validation = validateSecondReviewPacketText(variant);
        assert.equal(validation.ok, false);
        assert.ok(validation.missing.some((error) => /must equal the canonical rendering/.test(error)),
          validation.missing.join("\n"));
      }
    } finally {
      cleanup(carrierDir);
    }
  });
});

// fix-second-review-loop-friction T1 prove-it (D13 P7, half 2; design.md D11;
// code-review-checklist ADDED "Second-Review Blocking Findings Carry
// Suggested Direction And Verify By", scenario "External ticket places the
// lines inside Markdown review results"): RED against base — neither
// `Suggested direction:` nor `Verify by:` exists anywhere in the packet yet,
// so the `### Sticky Body Format` section cannot yet state where they belong.
test("Scenario: External ticket places the lines inside Markdown review results", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const stickyBodyFormatStart = packet.indexOf("### Sticky Body Format");
      assert.notEqual(stickyBodyFormatStart, -1, "packet must carry a Sticky Body Format section");
      const nextHeadingStart = packet.indexOf("\n### ", stickyBodyFormatStart + 1);
      const stickyBodyFormatSection = packet.slice(
        stickyBodyFormatStart,
        nextHeadingStart === -1 ? packet.length : nextHeadingStart,
      );
      assert.match(
        stickyBodyFormatSection,
        /Suggested direction:/,
        "Sticky Body Format must state that Suggested direction: is Markdown review-results content",
      );
      assert.match(
        stickyBodyFormatSection,
        /Verify by:/,
        "Sticky Body Format must state that Verify by: is Markdown review-results content",
      );
    } finally {
      cleanup(carrierDir);
    }
  });
});

// ---------------------------------------------------------------------------
// fix-external-evaluator-sticky-recipe T1 prove-it (RED; design.md D1-D5, D9
// item 1; decisions.md D1/D2; tasks.md T1). Base 5d8ac9923 still renders the
// contradictory pre-fix wording D9 names as the gap: the external ticket's
// own sticky_write_exact_recipe is prose ("external-evaluator owns sticky
// write..."), not an executable repo-relative gated-writer invocation, and
// sticky_write_body_file is the literal string "evaluator-owned" rather than
// a real path — the sidecar line points at a notes/tmp/ path that does not
// exist in a real main checkout. These four tests assert the D3 target
// wording and the D4/D9 simulated-evaluator write-through; they are expected
// to fail against the current renderer/validator/writer and to turn GREEN
// once T3-T5 land.
// ---------------------------------------------------------------------------

test("Scenario: External-evaluator ticket states one repo-relative gated write recipe", async () => {
  await withTempDir(async (dir) => {
    for (const [label, handoff] of [
      ["create", baseExternalHandoff],
      ["update", updateDispositionExternalHandoff()],
    ]) {
      const mainCheckoutFixtureRoot = path.join(dir, `main-checkout-${label}`);
      mkdirSync(mainCheckoutFixtureRoot, { recursive: true });
      const { result, carrierDir } = renderUnderMainCheckoutFixture(handoff, mainCheckoutFixtureRoot);
      try {
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
        const { headingIndex, prefix, suffix } = externalTicketSuffixOf(packet);
        assert.ok(headingIndex > 0, label);
        const attemptId = path.basename(carrierDir);
        const expectedRecipeLine =
          `sticky_write_exact_recipe: node .devpro/scripts/write-second-review-sticky-gated.mjs notes/cross-review/${attemptId}/sticky-credential-gate-sidecar.json`;
        const expectedBodyFileLine =
          `sticky_write_body_file: notes/cross-review/${attemptId}/cross-model-second-opinion.md`;
        assert.ok(prefix.includes(expectedRecipeLine), `${label}: prefix must state the repo-relative gated write recipe:\n${prefix}`);
        assert.ok(suffix.includes(expectedRecipeLine), `${label}: ticket must state the same repo-relative gated write recipe:\n${suffix}`);
        assert.ok(prefix.includes(expectedBodyFileLine), `${label}: prefix must state the repo-relative body file`);
        assert.ok(suffix.includes(expectedBodyFileLine), `${label}: ticket must state the same repo-relative body file`);
        for (const phrase of [
          "do not execute the gated CLI",
          "do not execute gated CLI",
          "evaluator-owned",
          "notes/tmp/sticky-credential-gate-",
        ]) {
          assert.equal(packet.includes(phrase), false, `${label}: retired phrase "${phrase}" must not appear`);
        }
        assert.equal(packet.includes(dir), false, `${label}: packet must not carry the tmpdir absolute path`);
        assert.equal(packet.includes(mainCheckoutFixtureRoot), false, `${label}: packet must not carry the main-checkout-fixture absolute path`);
        assert.equal(packet.includes(carrierDir), false, `${label}: packet must not carry the carrier dir absolute path`);
      } finally {
        cleanup(carrierDir);
      }
    }
  });
});

test("Scenario: External-evaluator ticket routes writes through the gated writer", async () => {
  await withTempDir(async (dir) => {
    for (const [label, handoff] of [
      ["create", baseExternalHandoff],
      ["update", updateDispositionExternalHandoff()],
    ]) {
      const mainCheckoutFixtureRoot = path.join(dir, `main-checkout-${label}`);
      mkdirSync(mainCheckoutFixtureRoot, { recursive: true });
      const { result, carrierDir } = renderUnderMainCheckoutFixture(handoff, mainCheckoutFixtureRoot);
      try {
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        const attemptId = path.basename(carrierDir);
        const sidecarRelPath = `notes/cross-review/${attemptId}/sticky-credential-gate-sidecar.json`;
        const bodyRelPath = `notes/cross-review/${attemptId}/cross-model-second-opinion.md`;
        const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
        assert.ok(
          packet.includes(`sticky_write_credential_gate_sidecar: ${sidecarRelPath}`),
          `${label}: ticket must name the repo-relative carrier sidecar`,
        );
        assert.ok(
          packet.includes(`sticky_write_body_file: ${bodyRelPath}`),
          `${label}: ticket must name the repo-relative carrier body path`,
        );
        // R1: prefix and ticket each carry the stop-and-report execution rule
        // and the main-checkout working-directory line. Literals are pinned
        // here (not re-derived from stickyWriteDispositionLines) so a
        // regression back to a raw gh api fallback turns this test red.
        const executionRuleLine = "sticky_write_execution_rule: execute only this exact sticky write action via sticky_write_exact_recipe from the main checkout root; on a non-zero exit or any typed denial, stop and report to the TL and do not retry through gh api, gh pr comment, or another create primitive; TL runs accept-external-second-review after the sticky exists";
        const workingDirectoryLine = `sticky_write_working_directory: the main checkout root of this repository (the checkout that holds notes/cross-review/${attemptId}/); run the body write, sticky_write_exact_recipe, and sticky_write_readback_recipe from there`;
        const frameStart = packet.indexOf(SECOND_REVIEW_FRAME_MARKER);
        const ticketStart = packet.lastIndexOf(EXTERNAL_EVALUATOR_TICKET_HEADING);
        assert.ok(frameStart > 0 && ticketStart > frameStart, `${label}: packet must have a prefix and a ticket`);
        const prefixText = packet.slice(0, frameStart);
        const ticketText = packet.slice(ticketStart);
        for (const [where, text] of [["prefix", prefixText], ["ticket", ticketText]]) {
          for (const line of [executionRuleLine, workingDirectoryLine]) {
            assert.ok(
              text.split("\n").includes(line),
              `${label}: ${where} must contain the exact line ${JSON.stringify(line.slice(0, 40))}`,
            );
          }
        }
        // No raw write primitive anywhere in the packet: gh api with a
        // POST/PATCH method, or a command line that starts with gh pr comment.
        // Pre-Write Live Check GETs carry no method flag and stay allowed.
        for (const line of packet.split("\n")) {
          assert.doesNotMatch(
            line,
            /\bgh api\b.*(?:-X|--method)\s+(?:POST|PATCH)\b/,
            `${label}: packet must not contain a raw gh api write: ${line.slice(0, 120)}`,
          );
          assert.doesNotMatch(
            line,
            /^\s*(?:[-*]\s+|\d+\.\s+)?`?gh pr comment\b/,
            `${label}: packet must not contain a gh pr comment command line: ${line.slice(0, 120)}`,
          );
        }
        const sidecarAbsPath = path.join(mainCheckoutFixtureRoot, sidecarRelPath);
        assert.equal(
          existsSync(sidecarAbsPath),
          true,
          `${label}: path.join(<main checkout root>, <ticket sidecar path>) must exist`,
        );
        const sidecarContent = JSON.parse(readFileSync(sidecarAbsPath, "utf8"));
        assert.equal(
          sidecarContent.body_file,
          bodyRelPath,
          `${label}: carrier sidecar body_file must equal the ticket's sticky_write_body_file`,
        );
        const withoutDigest = { ...sidecarContent };
        delete withoutDigest.digest;
        const expectedDigest = createHash("sha256")
          .update(JSON.stringify(withoutDigest), "utf8")
          .digest("hex");
        assert.equal(
          sidecarContent.digest,
          expectedDigest,
          `${label}: carrier sidecar digest must be recomputable from its own bytes`,
        );
      } finally {
        cleanup(carrierDir);
      }
    }
  });
});

// D1/D9 T1 must-keep: a runner (non-external) render's own carrier sidecar
// *JSON file* keeps body_file: "cross-model-second-opinion.md" (byte-identical;
// R7 must-keep). The RECIPE-LINE half of this invariant is already pinned by
// the must-not-touch render-second-review-packet.test.mjs:1795-1796; this is
// the file-content half, which no test in that must-not-touch file asserts.
test("T1 must-keep: runner render's carrier sidecar body_file stays cross-model-second-opinion.md", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(runnerHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const sidecarPath = path.join(carrierDir, "sticky-credential-gate-sidecar.json");
      assert.equal(existsSync(sidecarPath), true, "runner render must publish its carrier sidecar");
      const sidecarContent = JSON.parse(readFileSync(sidecarPath, "utf8"));
      assert.equal(sidecarContent.body_file, "cross-model-second-opinion.md");
    } finally {
      cleanup(carrierDir);
    }
  });
});

// ---------------------------------------------------------------------------
// fix-external-evaluator-sticky-recipe T2 prove-it (RED; design.md D4, D9 item
// 2; tasks.md T2) mirror, but exercised end-to-end from the external ticket's
// own repo-relative recipe against a fixture "main checkout" root, so the
// gh spawn cwd, endpoint, and method are all asserted from the evaluator's
// point of view rather than by hand-built sidecar payloads.
// ---------------------------------------------------------------------------

test("Scenario: External evaluator writes through the ticket gated recipe and stops on denial", async () => {
  await withTempDir(async (dir) => {
    const previousCwd = process.cwd();
    const neutralCwd = path.join(dir, "evaluator-neutral-cwd");
    mkdirSync(neutralCwd, { recursive: true });
    process.chdir(neutralCwd);
    try {
      // --- shared create-disposition render: reused by the positive create
      // write and the worktree-root negative (same ticket, different cwd) ---
      const createRoot = path.join(dir, "main-checkout-create");
      mkdirSync(createRoot, { recursive: true });
      const created = renderUnderMainCheckoutFixture(baseExternalHandoff, createRoot);
      try {
        assert.equal(created.result.status, 0, created.result.stderr);
        const createdPacket = readFileSync(path.join(created.carrierDir, "packet.md"), "utf8");
        const { suffix: createdSuffix } = externalTicketSuffixOf(createdPacket);
        const createSidecarRelPath = ticketFieldValue(createdSuffix, "sticky_write_credential_gate_sidecar");
        const createBodyRelPath = ticketFieldValue(createdSuffix, "sticky_write_body_file");
        assert.ok(createSidecarRelPath, "create ticket must name a sidecar path");
        assert.ok(createBodyRelPath, "create ticket must name a body path");

        // positive: create — write the body exactly where the ticket says, then
        // execute the ticket's own recipe from the fixture main-checkout root.
        writeFileSync(
          path.join(createRoot, createBodyRelPath),
          "safe reason without secrets for the T1 simulated-evaluator gated-write fixture.\n",
          "utf8",
        );
        const createCalls = [];
        const createResult = runGatedStickyWrite({
          sidecarPath: createSidecarRelPath,
          cwd: createRoot,
          repoRoot: createRoot,
          env: { ...process.env, DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: readContext(created.carrierDir).control_evidence_root },
          spawnSyncImpl: (cmd, args, options) => {
            createCalls.push({ cmd, args, cwd: options?.cwd });
            return { status: 0, stdout: "{\"id\":5001}\n", stderr: "" };
          },
        });
        assert.equal(
          createResult.status,
          0,
          `create write must succeed via the ticket's own repo-relative recipe: ${JSON.stringify(createResult.result)}`,
        );
        assert.equal(createCalls.length, 1, "create write must call gh exactly once");
        assert.equal(createCalls[0].args[1], "repos/devpro/example/issues/456/comments", "create write endpoint");
        assert.equal(createCalls[0].args[3], "POST", "create write method");
        assert.equal(createCalls[0].cwd, createRoot, "gh must run from the injected main-checkout cwd, not process.cwd()");
        const createSidecarAbsPath = path.isAbsolute(createSidecarRelPath)
          ? createSidecarRelPath
          : path.join(createRoot, createSidecarRelPath);
        const createDispatchId = JSON.parse(readFileSync(createSidecarAbsPath, "utf8")).dispatch_id;
        const createResultPath = path.join(path.dirname(createSidecarAbsPath), stickyWriteResultBasename(createDispatchId));
        assert.equal(existsSync(createResultPath), true, "create write result file must live in the carrier directory");

        // negative: worktree root — same ticket sidecar path, resolved against
        // the real worktree instead of the fixture main-checkout root; no such
        // carrier exists there (sibling observability-context.json missing).
        let worktreeCalls = 0;
        const worktreeResult = runGatedStickyWrite({
          sidecarPath: createSidecarRelPath,
          cwd: REPO_ROOT,
          repoRoot: REPO_ROOT,
          spawnSyncImpl: () => {
            worktreeCalls += 1;
            return { status: 0, stdout: "{}", stderr: "" };
          },
        });
        assert.equal(worktreeResult.status, 1, "a worktree-root run must be rejected");
        assert.equal(worktreeResult.result.classification, "sticky_credential_gate_sidecar_invalid", "worktree-root classification");
        assert.match(
          worktreeResult.result.error,
          /sibling observability-context\.json/,
          "worktree-root rejection reason must name the missing carrier",
        );
        assert.equal(worktreeCalls, 0, "worktree-root run must not call gh");
      } finally {
        cleanup(created.carrierDir);
      }

      // --- positive: update ---
      const updateRoot = path.join(dir, "main-checkout-update");
      mkdirSync(updateRoot, { recursive: true });
      const updated = renderUnderMainCheckoutFixture(updateDispositionExternalHandoff(), updateRoot);
      try {
        assert.equal(updated.result.status, 0, updated.result.stderr);
        const packet = readFileSync(path.join(updated.carrierDir, "packet.md"), "utf8");
        const { suffix } = externalTicketSuffixOf(packet);
        const sidecarRelPath = ticketFieldValue(suffix, "sticky_write_credential_gate_sidecar");
        const bodyRelPath = ticketFieldValue(suffix, "sticky_write_body_file");
        assert.ok(sidecarRelPath, "update ticket must name a sidecar path");
        assert.ok(bodyRelPath, "update ticket must name a body path");
        writeFileSync(
          path.join(updateRoot, bodyRelPath),
          "safe reason without secrets for the T1 simulated-evaluator gated-write fixture (update).\n",
          "utf8",
        );
        const calls = [];
        const result = runGatedStickyWrite({
          sidecarPath: sidecarRelPath,
          cwd: updateRoot,
          repoRoot: updateRoot,
          env: { ...process.env, DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: readContext(updated.carrierDir).control_evidence_root },
          spawnSyncImpl: (cmd, args, options) => {
            calls.push({ cmd, args, cwd: options?.cwd });
            return { status: 0, stdout: "{\"id\":9101}\n", stderr: "" };
          },
        });
        assert.equal(
          result.status,
          0,
          `update write must succeed via the ticket's own repo-relative recipe: ${JSON.stringify(result.result)}`,
        );
        assert.equal(calls.length, 1, "update write must call gh exactly once");
        assert.equal(calls[0].args[1], "repos/devpro/example/issues/comments/9101", "update write endpoint");
        assert.equal(calls[0].args[3], "PATCH", "update write method");
      } finally {
        cleanup(updated.carrierDir);
      }

      // --- negative: body not written ---
      const noBodyRoot = path.join(dir, "main-checkout-no-body");
      mkdirSync(noBodyRoot, { recursive: true });
      const noBody = renderUnderMainCheckoutFixture(baseExternalHandoff, noBodyRoot);
      try {
        assert.equal(noBody.result.status, 0, noBody.result.stderr);
        const packet = readFileSync(path.join(noBody.carrierDir, "packet.md"), "utf8");
        const { suffix } = externalTicketSuffixOf(packet);
        const sidecarRelPath = ticketFieldValue(suffix, "sticky_write_credential_gate_sidecar");
        assert.ok(sidecarRelPath, "no-body ticket must name a sidecar path");
        let calls = 0;
        const result = runGatedStickyWrite({
          sidecarPath: sidecarRelPath,
          cwd: noBodyRoot,
          repoRoot: noBodyRoot,
          spawnSyncImpl: () => {
            calls += 1;
            return { status: 0, stdout: "{}", stderr: "" };
          },
        });
        assert.equal(result.status, 1, "a missing body must be rejected");
        assert.equal(result.result.classification, "sticky_write_body_missing", "missing-body classification");
        assert.equal(calls, 0, "missing-body run must not call gh");
      } finally {
        cleanup(noBody.carrierDir);
      }

      // --- negative: body contains a synthetic credential literal ---
      const SYNTH = "SYNTH_PWD_TEST_ONLY_ext_eval_9f21";
      const credRoot = path.join(dir, "main-checkout-cred-literal");
      mkdirSync(credRoot, { recursive: true });
      const cred = renderUnderMainCheckoutFixture(baseExternalHandoff, credRoot);
      try {
        assert.equal(cred.result.status, 0, cred.result.stderr);
        const packet = readFileSync(path.join(cred.carrierDir, "packet.md"), "utf8");
        const { suffix } = externalTicketSuffixOf(packet);
        const sidecarRelPath = ticketFieldValue(suffix, "sticky_write_credential_gate_sidecar");
        const bodyRelPath = ticketFieldValue(suffix, "sticky_write_body_file");
        assert.ok(sidecarRelPath, "cred-literal ticket must name a sidecar path");
        assert.ok(bodyRelPath, "cred-literal ticket must name a body path");
        const sidecarAbsPath = path.isAbsolute(sidecarRelPath) ? sidecarRelPath : path.join(credRoot, sidecarRelPath);
        const sidecarJson = JSON.parse(readFileSync(sidecarAbsPath, "utf8"));
        assert.deepEqual(sidecarJson.materialTexts, [], "the shape scan, not materialTexts, must be what blocks this case");
        writeFileSync(path.join(credRoot, bodyRelPath), `reason: leak Pwd=${SYNTH}\n`, "utf8");
        let calls = 0;
        const result = runGatedStickyWrite({
          sidecarPath: sidecarRelPath,
          cwd: credRoot,
          repoRoot: credRoot,
          spawnSyncImpl: () => {
            calls += 1;
            return { status: 0, stdout: "{}", stderr: "" };
          },
        });
        assert.equal(result.status, 1, "a synthetic credential literal must be rejected");
        assert.equal(result.result.classification, STICKY_CREDENTIAL_LITERAL_BLOCKED, "credential-literal classification");
        assert.equal(JSON.stringify(result.result).includes(SYNTH), false, "the synth literal must never leak into the result payload");
        assert.equal(calls, 0, "credential-literal run must not call gh");
      } finally {
        cleanup(cred.carrierDir);
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// D5 (R5): all five of these phrases are now retired wording (T5 landed);
// none of them appear in a baseline render, so the baseline-validates-ok
// assertion below actually exercises the fix, not a no-op. Injecting into
// the SUFFIX would be confounded by validateExternalEvaluatorTicketSuffix's
// existing byte-exact canonical-suffix check (any mutation there already
// fails validation for an unrelated, structural reason); injecting into the
// PREFIX isolates the targeted retired-phrase rejection this scenario
// actually tests (only substring checks apply to the external prefix today,
// no byte-exact compare).
const EXTERNAL_PACKET_RETIRED_WRITE_PHRASES_FIXTURE = [
  "do not execute the gated CLI",
  "do not execute gated CLI",
  "evaluator-owned",
  "notes/tmp/sticky-credential-gate-",
  "outside the target repository working tree",
];

test("Scenario: Retired external write wording fails validation", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.equal(validateSecondReviewPacketText(packet).ok, true, "baseline packet must validate before mutation");
      const headerStart = packet.indexOf(SECOND_REVIEW_FRAME_MARKER);
      assert.ok(headerStart > 0);
      for (const phrase of EXTERNAL_PACKET_RETIRED_WRITE_PHRASES_FIXTURE) {
        const mutated = `${packet.slice(0, headerStart)}\n${phrase}\n${packet.slice(headerStart)}`;
        const validation = validateSecondReviewPacketText(mutated);
        assert.equal(
          validation.ok,
          false,
          `retired phrase "${phrase}" must fail validation once re-injected into the packet's renderer-owned prefix`,
        );
        assert.ok(
          validation.missing.some((message) => message.includes("retired write wording") && message.includes(phrase)),
          `retired phrase "${phrase}" must fail on the retired-wording check itself: ${JSON.stringify(validation.missing)}`,
        );
      }
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("Scenario: Retired external write wording fails validation — handoff text that quotes a retired phrase still renders", async () => {
  await withTempDir(async (dir) => {
    const phrase = "outside the target repository working tree";
    for (const [label, handoff] of [
      ["scope_summary", {
        ...baseExternalHandoff,
        scope_summary: `retire the "evaluator-owned" and "${phrase}" wording from the external ticket`,
      }],
      ["same-family why", {
        ...baseExternalHandoff,
        retry_context: {
          classification: "same_family_fallback",
          sticky_verification: `different-family runner unavailable; old ticket said ${phrase}`,
        },
      }],
    ]) {
      const caseDir = path.join(dir, label.replace(/\W+/g, "-"));
      mkdirSync(caseDir, { recursive: true });
      const { result, carrierDir } = render(handoff, caseDir);
      try {
        assert.equal(result.status, 0, `${label}: handoff text quoting a retired phrase must not block the render: ${result.stderr}`);
        const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
        assert.ok(packet.includes(phrase), `${label}: the handoff text must reach the packet`);
        assert.equal(validateSecondReviewPacketText(packet).ok, true, `${label}: rendered packet must validate`);
        const headerStart = packet.indexOf(SECOND_REVIEW_FRAME_MARKER);
        const mutated = `${packet.slice(0, headerStart)}\n${phrase}\n${packet.slice(headerStart)}`;
        const validation = validateSecondReviewPacketText(mutated);
        assert.ok(
          validation.missing.some((message) => message.includes("retired write wording") && message.includes(phrase)),
          `${label}: renderer-owned text carrying the phrase must still fail: ${JSON.stringify(validation.missing)}`,
        );
      } finally {
        cleanup(carrierDir);
      }
    }
  });
});

test("gated sticky writer prints its typed failure result on stderr, not only in sticky-write-result*.json", () => {
  withTempDir((dir) => {
    const missingSidecar = path.join(dir, "absent-sidecar.json");
    const child = spawnSync(process.execPath, [repoPath(".devpro/scripts/write-second-review-sticky-gated.mjs"), missingSidecar], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
    const lines = child.stderr.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "a failed write must leave a typed result line on stderr for callers that only see exit code + stderr");
    const payload = JSON.parse(lines[lines.length - 1]);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.classification, "string");
    assert.ok(payload.classification.startsWith("sticky_"), `classification must be a typed sticky_* code, got ${payload.classification}`);
  });
});

// ---------------------------------------------------------------------------
// remove-second-review-disclosure-approval T6 (design D1/D2): with the fixed approval fields the
// renderer asks for no consent, and the PII / secret scrub (assertExternalPacketScrub) is the
// external packet scrub in front of the reservation.
// The scrub runs on the external-evaluator ticket path only, so these cases use baseExternalHandoff.
// ---------------------------------------------------------------------------

function assertScrubRefusedBeforeReservation(dir, rendered, sample, label) {
  assert.equal(rendered.result.status, 1, `${label}: ${rendered.result.stderr}`);
  assert.match(rendered.result.stderr, /external_ticket_unsafe_value/, label);
  assert.doesNotMatch(rendered.result.stderr, new RegExp(escapeRegExp(sample.value)), `${label}: raw value must not leak`);
  assert.equal(rendered.packetPath, null, `${label}: no packet may be published`);
  assert.equal(existsSync(path.join(dir, "control-evidence")), false, `${label}: no dispatch reservation`);
  assert.equal(existsSync(path.join(dir, "post-pr-completion-state")), false, `${label}: no round-budget state`);
  assert.deepEqual(readdirSync(ownedCarrierRootFor(dir)), [], `${label}: no carrier directory`);
}

function assertFixedApprovalFields(handoff) {
  assert.equal(handoff.approval_context, "none");
  assert.deepEqual(handoff.approval_resolution, { status: "not-required" });
}

test("External-evaluator scrub blocks before reservation", async () => {
  assertFixedApprovalFields(baseExternalHandoff);
  await withTempDir(async (dir) => {
    for (const sample of UNSAFE_VALUE_SAMPLES) {
      const handoff = {
        ...baseExternalHandoff,
        scope_summary: `${baseExternalHandoff.scope_summary} (${sample.value})`,
      };
      assertFixedApprovalFields(handoff);
      const rendered = render(handoff, dir);
      assertScrubRefusedBeforeReservation(dir, rendered, sample, `scope_summary / ${sample.label}`);
      assert.match(
        rendered.result.stderr,
        new RegExp(`review_data\\.scope_summary \\(${escapeRegExp(sample.category)}\\)`),
        `scope_summary / ${sample.label}: names the field path and pattern category`,
      );
    }
  });
});

test("A PII or secret hit in the evidence narrative or previous_sticky blocks dispatch before reservation", async () => {
  assertFixedApprovalFields(baseExternalHandoff);
  const pii = UNSAFE_VALUE_SAMPLES.find((sample) => sample.category === "pii:email");
  const secret = UNSAFE_VALUE_SAMPLES.find((sample) => sample.category === "secret:github_token");
  await withTempDir(async (dir) => {
    for (const [field, sample, apply] of [
      ["evidence narrative", pii, (value) => ({ ...baseExternalHandoff, primary_test_evidence: `${baseExternalHandoff.primary_test_evidence}; ${value}` })],
      ["evidence narrative", secret, (value) => ({ ...baseExternalHandoff, primary_validation_evidence: `${baseExternalHandoff.primary_validation_evidence}; ${value}` })],
      ["previous_sticky", pii, (value) => ({ ...baseExternalHandoff, previous_sticky: `prior sticky excerpt (${value})` })],
      ["previous_sticky", secret, (value) => ({ ...baseExternalHandoff, previous_sticky: `prior sticky excerpt (${value})` })],
    ]) {
      const handoff = apply(sample.value);
      assertFixedApprovalFields(handoff);
      const rendered = render(handoff, dir);
      assertScrubRefusedBeforeReservation(dir, rendered, sample, `${field} / ${sample.label}`);
    }
  });
});

test("Scrub hit still blocks dispatch with the fixed approval fields", async () => {
  await withTempDir(async (dir) => {
    // The handoff carries only the fixed none / not-required fields and nothing a consent step
    // could add; those fields do not exempt the packet from the scrub.
    const sample = UNSAFE_VALUE_SAMPLES.find((entry) => entry.category === "pii:unix-users-path");
    const handoff = {
      ...baseExternalHandoff,
      scope_summary: `${baseExternalHandoff.scope_summary} (see ${sample.value})`,
    };
    assertFixedApprovalFields(handoff);
    const rendered = render(handoff, dir);
    assertScrubRefusedBeforeReservation(dir, rendered, sample, "fixed-approval-fields handoff with a PII hit");
    // The same handoff without the hit dispatches with no consent step, so the refusal above is
    // the scrub and not the approval fields.
    await withTempDir(async (cleanDir) => {
      const clean = render(baseExternalHandoff, cleanDir);
      try {
        assert.equal(clean.result.status, 0, clean.result.stderr);
        assert.equal(existsSync(path.join(cleanDir, "control-evidence")), true, "the clean handoff reserves its dispatch");
      } finally {
        cleanup(clean.carrierDir);
      }
    });
  });
});

// --- reviewer_constraints on the external evaluator ticket ----------------------------------------
function reviewDataOfPacket(packet) {
  const marker = Buffer.from(SECOND_REVIEW_FRAME_MARKER, "utf8");
  const bytes = Buffer.from(packet, "utf8");
  const headerStart = bytes.indexOf(marker);
  assert.notEqual(headerStart, -1);
  const lengthStart = headerStart + marker.length;
  const headerEnd = bytes.indexOf(Buffer.from("\n\n", "utf8"), lengthStart);
  const length = Number(bytes.subarray(lengthStart, headerEnd).toString("utf8"));
  const payloadStart = headerEnd + 2;
  return JSON.parse(bytes.subarray(payloadStart, payloadStart + length).toString("utf8"));
}

test("External evaluator ticket carries the same constraints", async () => {
  await withTempDir(async (dir) => {
    const constraints = "\n  # Naming\n\n- Prefer early returns over nested branches.  \n- Name public methods in PascalCase.\n\n";
    const { result, carrierDir } = render({ ...baseExternalHandoff, reviewer_constraints: constraints }, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      const data = reviewDataOfPacket(packet);
      assert.equal(data.reviewer_constraints, constraints, "the ticket Review Data carries the same string unchanged");
      assert.equal(Object.keys(data).at(-1), "reviewer_constraints");
      const prefix = packet.slice(0, packet.indexOf(SECOND_REVIEW_FRAME_MARKER));
      const dutyLines = prefix.split("\n").filter((line) => line.startsWith("- Consumer-declared review criteria"));
      assert.equal(dutyLines.length, 1, "the static prefix carries the consumer-criteria duty once");
      assert.ok(dutyLines[0].includes("consumer-rules: <heading or line number in the base version>"));
      assert.equal(dutyLines[0], secondReviewPacketStaticPrefix("Claude Code", "pr-sticky").split("\n").find((line) => line.startsWith("- Consumer-declared review criteria")), "the duty is byte-identical to the runner packet duty");
      const validation = validateSecondReviewPacketText(packet);
      assert.deepEqual(validation.missing, [], validation.missing.join("\n"));
      assert.equal(validation.ok, true, "the external evaluator prefix still passes its existing prefix validation");
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("External evaluator ticket carries the same constraints — without the field the ticket Review Data has no key", async () => {
  await withTempDir(async (dir) => {
    const { result, carrierDir } = render(baseExternalHandoff, dir);
    try {
      assert.equal(result.status, 0, result.stderr);
      const packet = readFileSync(path.join(carrierDir, "packet.md"), "utf8");
      assert.equal(Object.hasOwn(reviewDataOfPacket(packet), "reviewer_constraints"), false);
      assert.equal(validateSecondReviewPacketText(packet).ok, true);
    } finally {
      cleanup(carrierDir);
    }
  });
});

test("external evaluator skips automatic model discovery entirely", async () => {
  await withTempDir(dir => {
    const context=getSecondReviewObservabilityContext(baseExternalHandoff, {packetPath:"-",env:{...process.env,DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR:path.join(dir,"evidence")},modelProbe:()=>{throw new Error("external evaluator must not probe");}});
    assert.equal(context.reviewer_cli_recipe,null);
    assert.equal(Object.hasOwn(context,"reviewer_model_selection"),false);
  });
});
