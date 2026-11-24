/**
 * Behavioral contract for R8 cross-carrier remediation closure.
 *
 * A reviewer still discovers semantic variants. Once an open finding has been
 * classified as cross-carrier, the next dispatch is mechanical: every author-
 * declared fixed literal is replayed against current-HEAD tracked regular text
 * blobs and every hit must have one closed disposition.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as evidence from "../review-remediation-evidence.mjs";
import { writeRegressionHeadRecord } from "../lib/regression-head-record.mjs";
import { VALID_BRD_FIXTURE } from "./lib/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE_REVIEW_GATE = path.resolve(HERE, "../pre-pr-archive-gate.mjs");
const EVIDENCE_CLI = path.resolve(HERE, "../review-remediation-evidence.mjs");
const LITERAL = "5→3→2→0 [x].*";

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function write(repoRoot, relativePath, body) {
  const target = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function commitAll(repoRoot, message) {
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "--quiet", "-m", message]);
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

function proposal() {
  return [
    "---",
    "risk_classes: [state/invariant, write]",
    "---",
    "",
    "# Proposal: closure fixture",
    "",
    "## Capabilities",
    "",
    "### Modified Capabilities",
    "",
    "- `risk-fixture`: exact closure fixture.",
    "",
    "## Section 1: Target State (Done When)",
    "",
    "1. Preserve exact review authority.",
    "",
    "## Section 2: Touch",
    "",
    "| 檔案 | 類別 | 動作 | Requirement |",
    "|---|---|---|---|",
    "| `src/review-target.mjs` | code | modify | R1 |",
    "| `openspec/specs/risk-fixture/spec.md` | spec | modify | R1 |",
    "",
    "不動清單：",
    "",
    "- `docs/history.md`",
    "",
    "## Section 3: Tasks",
    "",
    "1. Prove the closure fixture.",
    "",
    "## Consequence Assessment",
    "",
    "| Dimension | Consequence |",
    "|---|---|",
    "| Security/trust/privacy/data | Fail closed before dispatch. |",
    "| Material negatives/non-goals | Do not infer undeclared synonyms. |",
    "",
    "## Risk Classes and Material Negatives",
    "",
    "- `state/invariant`: dispatch authority must be reproducible.",
    "- `write`: closure publication is durable.",
    "",
    "## Migration Notes",
    "",
    "No migration.",
    "",
    "## Named-Definition Corpus-Grep Evidence",
    "",
    "```json",
    JSON.stringify({
      status: "none",
      reason: "fixture: no new named definitions",
    }, null, 2),
    "```",
    "",
  ].join("\n");
}

function setup() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "cross-carrier-closure-"));
  git(repoRoot, ["init", "--quiet", "--initial-branch=main"]);
  git(repoRoot, ["config", "user.name", "Closure Fixture"]);
  git(repoRoot, ["config", "user.email", "closure@example.invalid"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  git(repoRoot, ["config", "core.autocrlf", "false"]);
  write(repoRoot, ".gitignore", "notes/\n");
  write(repoRoot, "src/review-target.mjs", `export const stale = ${JSON.stringify(LITERAL)};\n`);
  write(repoRoot, "docs/history.md", `Rejected historical example: ${LITERAL}\n`);
  write(repoRoot, "tests/quoted.md", `Quoted evidence fixture: ${LITERAL}\n`);
  write(repoRoot, ".devpro/scripts/pre-pr-archive-gate.mjs", "// source identity sentinel\n");
  write(repoRoot, ".devpro/agent-rules/rule-audit-playbook.md", "# source identity sentinel\n");
  const mainSha = commitAll(repoRoot, "baseline");
  git(repoRoot, ["update-ref", "refs/remotes/origin/main", mainSha]);
  git(repoRoot, ["checkout", "--quiet", "-b", "chore/cross-carrier-closure"]);
  const changeId = "cross-carrier-closure";
  write(repoRoot, `openspec/changes/${changeId}/proposal.md`, proposal());
  write(repoRoot, `openspec/changes/${changeId}/brd.md`, VALID_BRD_FIXTURE);
  write(repoRoot, `openspec/changes/${changeId}/design.md`, [
    "# Design: closure fixture", "", "## Decisions", "", "### D1 — Exact replay", "",
    "Replay declared fixed literals.", "", "## Test Log", "", "fixture", "",
  ].join("\n"));
  write(repoRoot, `openspec/changes/${changeId}/specs/risk-fixture/spec.md`, [
    "# risk-fixture Delta", "", "## MODIFIED Requirements", "", "### Requirement: Risk Shape Carrier", "",
    "The fixture SHALL preserve exact authority.", "", "#### Scenario: Fixture remains deterministic", "",
    "- **WHEN** the helper compiles risk shape", "- **THEN** selected sections determine the digest", "",
  ].join("\n"));
  // Canonical twin so --pre-review content lints (requirement-mode / body-wrap) can pass
  // before the R8 closure assertion under test.
  write(repoRoot, "openspec/specs/risk-fixture/spec.md", [
    "### Requirement: Risk Shape Carrier", "",
    "The fixture SHALL preserve exact authority.", "", "#### Scenario: Fixture remains deterministic", "",
    "- **WHEN** the helper compiles risk shape", "- **THEN** selected sections determine the digest", "",
  ].join("\n"));
  const headSha = commitAll(repoRoot, "add closure change");

  const dispatch = evidence.classifyBoundedRereview({
    repoRoot,
    changeId,
    previousReceiptRef: null,
    repairDeltaManifestRef: null,
    dependencyClosureManifestRef: null,
    predecessorMatches: [],
  });
  assert.equal(dispatch.route, "full");
  const finding = {
    finding_id: "F-CROSS-01",
    state: "open",
    disposition: null,
    observation: {
      axis: "1",
      severity: "Important",
      carrier: "src/review-target.mjs",
      anchor: LITERAL,
      detail: "The stale sequence remains live across carriers.",
      evidence: ["src/review-target.mjs", "docs/history.md"],
    },
  };
  const reviewerPayload = {
    dispatch_id: dispatch.dispatch_id,
    change_id: changeId,
    responsibility_id: "primary-review",
    reviewer_identity: { role: "dp-reviewer", executor_kind: "tl-direct" },
    review_authority: { kind: "tl-direct-review" },
    output_evidence: null,
    review_mode: "full",
    round_number: 1,
    bounded_rereview_count: 0,
    lineage: {
      base_sha: mainSha,
      merge_base_sha: mainSha,
      head_sha: headSha,
      previous_receipt_ref: null,
      initial_full_receipt_digest_sha256: null,
    },
    scope: {
      risk_shape_digest_sha256: dispatch.risk_shape_digest_sha256,
      risk_shape_digest_alg: dispatch.risk_shape_digest_alg ?? "behavior-risk-v1",
      open_finding_ids: [finding.finding_id],
      repair_delta_manifest_ref: null,
      dependency_closure_manifest_ref: null,
    },
    findings: [finding],
    verdict: "partial",
  };
  const payloadPath = path.join(repoRoot, ".reviewer-output.json");
  const rawReviewerPayload = {
    ...reviewerPayload,
    review_authority: null,
    output_evidence: null,
  };
  writeFileSync(payloadPath, `${evidence.canonicalJsonV1(rawReviewerPayload)}\n`);
  const rawRef = evidence.captureReviewerOutput({
    repoRoot,
    changeId,
    roundNumber: reviewerPayload.round_number,
    dispatchId: reviewerPayload.dispatch_id,
    payloadPath,
  });
  rmSync(payloadPath);
  reviewerPayload.output_evidence = {
    raw_payload_ref: rawRef,
    raw_payload_sha256: rawRef.digest_sha256,
    verdict_open_set_sha256: createHash("sha256").update(evidence.canonicalJsonV1({
      verdict: reviewerPayload.verdict,
      open_finding_ids: reviewerPayload.scope.open_finding_ids,
    })).digest("hex"),
  };
  const receipt = evidence.sealReviewRoundReceipt({ repoRoot, changeId, reviewerPayload });
  const observationHash = receipt.receipt.observation_hashes[0].observation_hash_sha256;
  const findings = [{
    finding_id: finding.finding_id,
    expected_observation_hash_sha256: observationHash,
    classification: "cross-carrier",
    rationale: "The finding names one invariant repeated in live and historical carriers.",
    semantic_invariant: "The acceptance fixture never uses the rejected zero-streak sequence.",
    search_literals: [LITERAL],
    matches: [
      { path: "docs/history.md", literal: LITERAL, occurrence_count: 1, disposition: "historical-rejected" },
      { path: "src/review-target.mjs", literal: LITERAL, occurrence_count: 1, disposition: "aligned" },
      { path: "tests/quoted.md", literal: LITERAL, occurrence_count: 1, disposition: "quoted-in-evidence" },
    ],
  }];
  return { repoRoot, changeId, receipt, findings, headSha, changeBaseRef: mainSha };
}

function cleanup(fixture) {
  rmSync(fixture.repoRoot, { recursive: true, force: true });
}

const PASS_SUITE_EVIDENCE = { status: "pass", fail: 0, digest_sha256: "c".repeat(64) };
test("seal and verify exact current-HEAD literal coverage, including regex metacharacters as fixed text", () => {
  const fixture = setup();
  try {
    const sealed = evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    assert.equal(sealed.closure.payload.seal_head_sha, fixture.headSha);
    assert.equal(sealed.closure.payload.result, "pass");
    assert.deepEqual(
      evidence.verifyCrossCarrierClosure({ repoRoot: fixture.repoRoot, closureRef: sealed.ref }).closure,
      sealed.closure,
    );
    assert.deepEqual(evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    }), {
      ok: true,
      status: "verified",
      change: fixture.changeId,
      source_round_number: 1,
      target_round_number: 2,
      closure_ref: sealed.ref,
    });
    write(fixture.repoRoot, "docs/unrelated.md", "No declared literal here.\n");
    commitAll(fixture.repoRoot, "unrelated head movement");
    assert.deepEqual(
      evidence.verifyCrossCarrierClosure({ repoRoot: fixture.repoRoot, closureRef: sealed.ref }).closure,
      sealed.closure,
      "seal HEAD is provenance; unrelated descendant commits do not require closure churn",
    );
    assert.throws(() => evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    }), /already covers current HEAD|redundant successor/i);
  } finally {
    cleanup(fixture);
  }
});

test("not-applicable closes an exact open finding with rationale and no invented search authority", () => {
  const fixture = setup();
  try {
    const findings = [{
      finding_id: fixture.findings[0].finding_id,
      expected_observation_hash_sha256: fixture.findings[0].expected_observation_hash_sha256,
      classification: "not-applicable",
      rationale: "The reviewer finding is local to one carrier and has no repeated semantic assertion.",
      semantic_invariant: null,
      search_literals: [],
      matches: [],
    }];
    const sealed = evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings,
    });
    assert.equal(sealed.closure.payload.findings[0].classification, "not-applicable");
    assert.equal(evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    }).status, "verified");
  } finally {
    cleanup(fixture);
  }
});

test("seal and verify commands use request-file transport and return a consumable durable ref", () => {
  const fixture = setup();
  try {
    const sealRequest = path.join(fixture.repoRoot, "seal-request.json");
    writeFileSync(sealRequest, JSON.stringify({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    }));
    const sealed = spawnSync(process.execPath, [
      EVIDENCE_CLI,
      "seal-cross-carrier-closure",
      "--request",
      sealRequest,
    ], { encoding: "utf8" });
    assert.equal(sealed.status, 0, sealed.stderr);
    const result = JSON.parse(sealed.stdout);
    assert.match(result.ref.path, /cross-carrier-closure-r2-[0-9a-f]{40}\.json$/u);

    const verifyRequest = path.join(fixture.repoRoot, "verify-request.json");
    writeFileSync(verifyRequest, JSON.stringify({ repoRoot: fixture.repoRoot, closureRef: result.ref }));
    const verified = spawnSync(process.execPath, [
      EVIDENCE_CLI,
      "verify-cross-carrier-closure",
      "--request",
      verifyRequest,
    ], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout).closure, result.closure);
  } finally {
    cleanup(fixture);
  }
});

test("seal fails closed on an undeclared hit or a declared nonexistent hit", async (t) => {
  for (const mutation of ["missing-hit", "invented-hit"]) {
    await t.test(mutation, () => {
      const fixture = setup();
      try {
        const findings = structuredClone(fixture.findings);
        if (mutation === "missing-hit") findings[0].matches.pop();
        else findings[0].matches.push({
          path: "docs/absent.md",
          literal: LITERAL,
          occurrence_count: 1,
          disposition: "aligned",
        });
        assert.throws(() => evidence.sealCrossCarrierClosure({
          repoRoot: fixture.repoRoot,
          changeId: fixture.changeId,
          sourceReceiptRef: fixture.receipt.ref,
          findings,
        }), /coverage|match|hit/i);
      } finally {
        cleanup(fixture);
      }
    });
  }
});

test("seal exact-covers the source receipt open finding IDs and observation hashes", async (t) => {
  for (const mutation of ["omitted-finding", "wrong-observation-hash"]) {
    await t.test(mutation, () => {
      const fixture = setup();
      try {
        const findings = structuredClone(fixture.findings);
        if (mutation === "omitted-finding") findings.pop();
        else findings[0].expected_observation_hash_sha256 = "f".repeat(64);
        assert.throws(() => evidence.sealCrossCarrierClosure({
          repoRoot: fixture.repoRoot,
          changeId: fixture.changeId,
          sourceReceiptRef: fixture.receipt.ref,
          findings,
        }), /finding|hash|1\.\.128/i);
      } finally {
        cleanup(fixture);
      }
    });
  }
});

test("verification replays current HEAD and rejects a newly introduced occurrence", () => {
  const fixture = setup();
  try {
    const sealed = evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    write(fixture.repoRoot, "docs/new-live-copy.md", `New copy: ${LITERAL}\n`);
    commitAll(fixture.repoRoot, "introduce a new carrier hit");
    assert.throws(
      () => evidence.verifyCrossCarrierClosure({ repoRoot: fixture.repoRoot, closureRef: sealed.ref }),
      /coverage|current HEAD|match|hit/i,
    );
    const current = evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    });
    assert.equal(current.ok, false);
    assert.equal(current.status, "missing-current-closure");
  } finally {
    cleanup(fixture);
  }
});

test("current closure discovery rejects a symlink candidate before reading outside notes", (t) => {
  const fixture = setup();
  const outside = mkdtempSync(path.join(os.tmpdir(), "cross-carrier-outside-"));
  try {
    evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "outside sentinel\n");
    const candidate = path.join(
      fixture.repoRoot,
      "notes",
      `review-${fixture.changeId}-cross-carrier-closure-r2-${"f".repeat(40)}.json`,
    );
    try {
      symlinkSync(outside, candidate, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const current = evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    });
    assert.equal(current.status, "invalid-closure");
    assert.match(current.reason, /resolves outside repo root|target-not-regular-file/);
    assert.equal(readFileSync(sentinel, "utf8"), "outside sentinel\n");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup(fixture);
  }
});

// Scenario: Oversized closure candidate keeps its cause
test("current closure discovery rejects an oversized candidate before parsing it", () => {
  const fixture = setup();
  try {
    evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    const candidate = path.join(
      fixture.repoRoot,
      "notes",
      `review-${fixture.changeId}-cross-carrier-closure-r2-${"f".repeat(40)}.json`,
    );
    writeFileSync(candidate, "");
    truncateSync(candidate, 32 * 1024 * 1024 + 1);
    const current = evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    });
    assert.equal(current.status, "invalid-closure");
    assert.match(current.reason, /target-oversize/);
  } finally {
    cleanup(fixture);
  }
});

test("current closure discovery rejects excess matching candidates before reading any candidate", () => {
  const fixture = setup();
  try {
    evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    for (let index = 0; index < 64; index += 1) {
      const suffix = index.toString(16).padStart(40, "0");
      writeFileSync(path.join(
        fixture.repoRoot,
        "notes",
        `review-${fixture.changeId}-cross-carrier-closure-r2-${suffix}.json`,
      ), "");
    }
    const current = evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    });
    assert.equal(current.status, "invalid-closure");
    assert.match(current.reason, /candidate count exceeds 64/);
  } finally {
    cleanup(fixture);
  }
});

// R8 (fix-merge-gate-regression-currency D13): a tip-freeze Gate A∧B rebase
// after a partial receipt rewrites the reviewed head. Main advances, the branch
// is rebased onto it, and the closure is sealed at the rebased HEAD.
function rebaseOntoAdvancedMain(fixture) {
  git(fixture.repoRoot, ["checkout", "--quiet", "main"]);
  write(fixture.repoRoot, "docs/main-advance.md", "Main moved after the partial review.\n");
  const advancedMain = commitAll(fixture.repoRoot, "main advances");
  git(fixture.repoRoot, ["update-ref", "refs/remotes/origin/main", advancedMain]);
  git(fixture.repoRoot, ["checkout", "--quiet", "chore/cross-carrier-closure"]);
  git(fixture.repoRoot, ["rebase", "--quiet", "main"]);
  return git(fixture.repoRoot, ["rev-parse", "HEAD"]);
}

test("closure seals and verifies after a forward rebase re-anchor, and the next round is still full", () => {
  const fixture = setup();
  try {
    const rebasedHead = rebaseOntoAdvancedMain(fixture);
    assert.notEqual(rebasedHead, fixture.headSha);
    const sealed = evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    assert.equal(sealed.closure.payload.seal_head_sha, rebasedHead);
    assert.deepEqual(evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    }), {
      ok: true,
      status: "verified",
      change: fixture.changeId,
      source_round_number: 1,
      target_round_number: 2,
      closure_ref: sealed.ref,
    });
    const next = evidence.classifyBoundedRereview({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      previousReceiptRef: fixture.receipt.ref,
      repairDeltaManifestRef: null,
      dependencyClosureManifestRef: null,
      predecessorMatches: [{
        finding_id: fixture.findings[0].finding_id,
        expected_observation_hash_sha256: fixture.findings[0].expected_observation_hash_sha256,
      }],
    });
    assert.equal(next.route, "full");
    assert.equal(next.full_reopen_reason, "git_lineage_changed");
  } finally {
    cleanup(fixture);
  }
});

test("a closure sealed before a forward rebase re-anchor is stale, not invalid, and a reseal at the new HEAD verifies", () => {
  const fixture = setup();
  try {
    const before = evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    const rebasedHead = rebaseOntoAdvancedMain(fixture);
    const stale = evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    });
    assert.equal(stale.status, "missing-current-closure", JSON.stringify(stale));
    const resealed = evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    assert.equal(resealed.closure.payload.seal_head_sha, rebasedHead);
    assert.notEqual(resealed.ref.path, before.ref.path);
    assert.deepEqual(evidence.verifyCurrentCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
    }).closure_ref, resealed.ref);
  } finally {
    cleanup(fixture);
  }
});

test("closure still fails closed when the seal head history does not contain the receipt merge-base", () => {
  const fixture = setup();
  try {
    // Same tree, new root commit: neither the reviewed head nor the receipt's
    // merge_base_sha is an ancestor of the seal head.
    git(fixture.repoRoot, ["checkout", "--quiet", "--orphan", "chore/unrelated-history"]);
    commitAll(fixture.repoRoot, "unrelated root with the same tree");
    assert.throws(() => evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    }), /cross-carrier closure seal HEAD does not descend from the reviewed HEAD, and its history does not contain the receipt merge-base/);
  } finally {
    cleanup(fixture);
  }
});

test("--pre-review blocks an open receipt without closure and passes after current closure is sealed", () => {
  const fixture = setup();
  try {
    writeRegressionHeadRecord({
      cwd: fixture.repoRoot,
      change: fixture.changeId,
      headSha: fixture.headSha,
      branch: "chore/cross-carrier-closure",
      suiteEvidence: PASS_SUITE_EVIDENCE,
    });
    const runGate = () => spawnSync(
      process.execPath,
      [PRE_REVIEW_GATE, fixture.repoRoot, "--pre-review", "--change-base-ref", fixture.changeBaseRef],
      {
        encoding: "utf8",
        env: { ...process.env, DEVPRO_DIFF_ACTIVE_CHANGES: fixture.changeId },
      },
    );
    const blocked = runGate();
    assert.equal(blocked.status, 1, `${blocked.stdout}\n${blocked.stderr}`);
    assert.match(blocked.stderr, /cross-carrier remediation closure/i);

    evidence.sealCrossCarrierClosure({
      repoRoot: fixture.repoRoot,
      changeId: fixture.changeId,
      sourceReceiptRef: fixture.receipt.ref,
      findings: fixture.findings,
    });
    const passed = runGate();
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    assert.match(passed.stdout, /Cross-carrier remediation closure asserted/i);
  } finally {
    cleanup(fixture);
  }
});
