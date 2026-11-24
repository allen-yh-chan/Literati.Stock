/**
 * T7 prove-it (strengthen-admission-binding-portability design D7／D8):
 * the consumer-side effective-root resolver, the main-cwd receipt round trip,
 * the `execution_root_head` attestation, and the telemetry reader's binding
 * priority.
 *
 * The fixture is a real main checkout plus a real linked
 * `.worktree/<change_id>` whose change folder is already archived — the shape
 * the post-archive cross-review window has. Every consumer call below is made
 * from the MAIN checkout; the resolver MUST reach the binding worktree's
 * records, and the worktree-removed window MUST fall back to the caller root's
 * archive location rather than fail closed.
 *
 * Test titles use the delta scenario titles verbatim
 * (`Main-Rooted Consumer Round Trip Reaches The Binding Worktree`,
 * `Declared-Path Receipt Attests The Binding Root Head`,
 * `Unresolved Binding Leaves Review And Verify Unsealable`,
 * `Declared-Path Advisory Is Not Mint And Not Independence Evidence`);
 * the twin-candidate and scan-fault regressions extend the first scenario's
 * "MUST still fail closed" clause for the graceful consumer surfaces
 * (cross-model CM-3), and the T8 lineage reader's closed reason-token set is
 * asserted here because the reader is the same exact-one binding consumer this
 * file exercises.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

import { repoPath } from "./lib/repo-root.mjs";
import { writeAdmissionRecord } from "../hooks/lib/admission-record.mjs";
import { ADMISSION_RECORDS_REASONS, loadAdmissionRecords } from "../lib/session-usage-lineage.mjs";

const HELPER_PATH = repoPath(".devpro/scripts/review-remediation-evidence.mjs");
const helper = await import(pathToFileURL(HELPER_PATH).href);

const CHANGE = "strengthen-main-cwd-round-trip";
const DIRECT_CHANGE = "strengthen-main-cwd-direct-seal";
const ARCHIVE_ENTRY = `2026-01-01-${CHANGE}`;
const DIRECT_ARCHIVE_ENTRY = `2026-01-01-${DIRECT_CHANGE}`;

let shared;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

function write(repoRoot, relativePath, contents) {
  const target = path.join(repoRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commitAll(repoRoot, message) {
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-qm", message]);
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

function fullRiskProposal() {
  return [
    "---",
    "risk_classes: [state/invariant, write]",
    "---",
    "",
    "# Proposal: fixture",
    "",
    "## Capabilities",
    "",
    "### Modified Capabilities",
    "",
    "- `risk-fixture`: exact compiler fixture.",
    "",
    "## Section 1: Target State (Done When)",
    "",
    "1. Preserve the exact review authority.",
    "",
    "## Section 2: Touch",
    "",
    "| 檔案 | 類別 | 動作 | Requirement |",
    "|---|---|---|---|",
    "| `src/review-target.mjs` | code | modify | R1 |",
    "",
    "不動清單：",
    "",
    "- `src/second-target.mjs`",
    "",
    "## Section 3: Tasks",
    "",
    "1. Prove the fixture.",
    "",
    "## Consequence Assessment",
    "",
    "| Dimension | Consequence |",
    "|---|---|",
    "| Security/trust/privacy/data | Fail closed before dispatch. |",
    "| Material negatives/non-goals | Do not accept caller-provided authority. |",
    "",
    "## Risk Classes and Material Negatives",
    "",
    "- `state/invariant`: dispatch authority must be reproducible.",
    "- `write`: receipt publication is durable.",
    "",
    "## Migration Notes",
    "",
    "migration note v1",
    "",
  ].join("\n");
}

function fullRiskDesign() {
  return [
    "# Design: fixture",
    "",
    "## Decisions",
    "",
    "### D1 — Exact authority",
    "",
    "Derive authority from exact selected sections.",
    "",
    "### D2 — Durable binding",
    "",
    "Bind the logical dispatch to current Git state.",
    "",
    "## Test Log",
    "",
    "test log v1",
    "",
  ].join("\n");
}

function riskDeltaSpec() {
  return [
    "# risk-fixture Delta",
    "",
    "## MODIFIED Requirements",
    "",
    "### Requirement: Risk Shape Carrier",
    "",
    "The fixture SHALL preserve exact authority.",
    "",
    "#### Scenario: Fixture remains deterministic",
    "",
    "- **WHEN** the helper compiles risk shape",
    "- **THEN** selected sections determine the digest",
    "",
  ].join("\n");
}

function writeFullRiskChange(repoRoot, changeId) {
  const folder = `openspec/changes/${changeId}`;
  write(repoRoot, `${folder}/proposal.md`, fullRiskProposal());
  write(repoRoot, `${folder}/design.md`, fullRiskDesign());
  write(repoRoot, `${folder}/specs/risk-fixture/spec.md`, riskDeltaSpec());
  return folder;
}

function receiptPayload({ changeId, baseSha, headSha, dispatchId, riskDigest, executionRootHead }) {
  return {
    change_id: changeId,
    responsibility_id: "primary-review",
    dispatch_id: dispatchId,
    reviewer_identity: { role: "dp-reviewer", executor_kind: "runtime-agent" },
    review_authority: null,
    output_evidence: null,
    review_mode: "full",
    round_number: 1,
    bounded_rereview_count: 0,
    lineage: {
      base_sha: baseSha,
      merge_base_sha: baseSha,
      head_sha: headSha,
      previous_receipt_ref: null,
      initial_full_receipt_digest_sha256: null,
    },
    scope: {
      risk_shape_digest_sha256: riskDigest,
      risk_shape_digest_alg: "behavior-risk-v1",
      open_finding_ids: [],
      repair_delta_manifest_ref: null,
      dependency_closure_manifest_ref: null,
    },
    findings: [],
    verdict: "finished",
    ...(executionRootHead === undefined ? {} : { execution_root_head: executionRootHead }),
  };
}

function writeRawPayload({ repoRoot, payload }) {
  const rawPayload = structuredClone(payload);
  rawPayload.review_authority = null;
  rawPayload.output_evidence = null;
  const rawBytes = Buffer.from(`${helper.canonicalJsonV1(rawPayload)}\n`, "utf8");
  const rawPath = path.join(repoRoot, `.raw-${payload.dispatch_id}.bin`);
  writeFileSync(rawPath, rawBytes);
  return rawPath;
}

function notesRoot(repoRoot) {
  const commonDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.join(path.dirname(commonDir), "notes");
}

function receiptNames(repoRoot, prefix) {
  const root = notesRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith(prefix));
}

function initialDispatch(repoRoot, changeId) {
  return helper.classifyBoundedRereview({
    repoRoot,
    changeId,
    previousReceiptRef: null,
    repairDeltaManifestRef: null,
    dependencyClosureManifestRef: null,
    predecessorMatches: [],
  });
}

before(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "main-cwd-round-trip-"));
  const mainRoot = path.join(root, "main-checkout");
  mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "main"]);
  // A later `reset --hard` rewrites the tree; with a host-wide core.autocrlf=true the rewritten bytes
  // would no longer equal the committed blobs this fixture pins.
  git(mainRoot, ["config", "core.autocrlf", "false"]);
  write(mainRoot, ".gitignore", ".worktree/\nopenspec/changes/**/admission-records/\n");
  write(mainRoot, "src/review-target.mjs", "export const target = 1;\n");
  const seed = commitAll(mainRoot, "seed");
  git(mainRoot, ["update-ref", "refs/remotes/origin/main", seed]);

  // A real linked worktree whose change folder is ALREADY archived — the
  // post-archive cross-review window.
  const worktreeRaw = path.join(mainRoot, ".worktree", CHANGE);
  mkdirSync(path.dirname(worktreeRaw), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${CHANGE}`, worktreeRaw, "HEAD"]);
  const worktreeRoot = realpathSync(worktreeRaw);
  writeFullRiskChange(worktreeRoot, CHANGE);
  git(worktreeRoot, ["add", "-A"]);
  git(worktreeRoot, ["commit", "-qm", "change folder"]);
  mkdirSync(path.join(worktreeRoot, "openspec", "changes", "archive"), { recursive: true });
  git(worktreeRoot, ["mv", `openspec/changes/${CHANGE}`, `openspec/changes/archive/${ARCHIVE_ENTRY}`]);
  git(worktreeRoot, ["commit", "-qm", "archive change folder"]);
  const headSha = git(worktreeRoot, ["rev-parse", "HEAD"]);

  const record = writeAdmissionRecord({
    cwd: worktreeRoot,
    host: "opencode",
    prompt: "main-cwd round trip fixture",
    fields: {
      objective: "independent-judgment",
      responsibility_id: "primary-review",
      instance_mode: "fresh",
      evidence_scope: "local diff",
      return_and_stop: "return findings and stop",
      role: "dp-reviewer",
    },
    roleBinding: "host-verified",
  });
  assert.equal(record.ok, true, record.code);
  assert.equal(record.bindingRoot, worktreeRoot, "the record must land in the binding worktree");

  // A second change with its own archived folder, used by the direct-seal
  // case: a successful seal is single-use per logical dispatch, so the direct
  // caller-root seam needs its own change identity — the first change's
  // receipt filename is already taken by the round-trip seal above.
  const directWorktreeRaw = path.join(mainRoot, ".worktree", DIRECT_CHANGE);
  mkdirSync(path.dirname(directWorktreeRaw), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${DIRECT_CHANGE}`, directWorktreeRaw, "HEAD"]);
  const directWorktreeRoot = realpathSync(directWorktreeRaw);
  writeFullRiskChange(directWorktreeRoot, DIRECT_CHANGE);
  git(directWorktreeRoot, ["add", "-A"]);
  git(directWorktreeRoot, ["commit", "-qm", "direct change folder"]);
  mkdirSync(path.join(directWorktreeRoot, "openspec", "changes", "archive"), { recursive: true });
  git(directWorktreeRoot, ["mv", `openspec/changes/${DIRECT_CHANGE}`, `openspec/changes/archive/${DIRECT_ARCHIVE_ENTRY}`]);
  git(directWorktreeRoot, ["commit", "-qm", "direct archive change folder"]);
  const directHeadSha = git(directWorktreeRoot, ["rev-parse", "HEAD"]);

  shared = {
    root,
    mainRoot,
    worktreeRoot,
    headSha,
    seed,
    record,
    archiveDir: path.join(worktreeRoot, "openspec", "changes", "archive", ARCHIVE_ENTRY),
    directWorktreeRoot,
    directHeadSha,
  };
});

after(() => {
  if (shared) rmSync(shared.root, { recursive: true, force: true });
});

test("Main-Rooted Consumer Round Trip Reaches The Binding Worktree", () => {
  const { mainRoot, worktreeRoot, headSha, seed, record } = shared;
  // The declared-path pre-resolution helper returns the binding worktree root
  // even when invoked from the main checkout.
  const dispatch = initialDispatch(worktreeRoot, CHANGE);
  assert.equal(dispatch.route, "full");
  assert.equal(dispatch.round_number, 1);
  const payload = receiptPayload({
    changeId: CHANGE,
    baseSha: seed,
    headSha,
    dispatchId: dispatch.dispatch_id,
    riskDigest: dispatch.risk_shape_digest_sha256,
    executionRootHead: headSha,
  });

  // capture → build → seal, all issued from the main checkout.
  const payloadPath = writeRawPayload({ repoRoot: mainRoot, payload });
  const rawPayloadRef = helper.captureReviewerOutput({
    repoRoot: mainRoot,
    changeId: CHANGE,
    roundNumber: 1,
    dispatchId: dispatch.dispatch_id,
    payloadPath,
  });
  const built = helper.buildReviewRoundReceiptRequest({
    repoRoot: mainRoot,
    changeId: CHANGE,
    rawPayloadRef,
    admissionRecordId: record.record_id,
  });
  assert.equal(built.repoRoot, worktreeRoot, "the builder MUST substitute the resolved binding root for the caller root");
  const sealed = helper.sealReviewRoundReceipt(built);

  // The durable claim and the record live under the binding worktree's
  // archived change folder, never under the main checkout.
  const recordsDir = path.join(worktreeRoot, "openspec", "changes", "archive", ARCHIVE_ENTRY, "admission-records");
  assert.equal(existsSync(path.join(recordsDir, `${record.record_id}.json`)), true);
  assert.equal(existsSync(path.join(recordsDir, `${record.record_id}.claim`, "consumed.json")), true);
  assert.equal(existsSync(path.join(mainRoot, "openspec", "changes")), false, "nothing may land in the main checkout");

  const verified = helper.verifyReviewRoundReceipt({
    repoRoot: mainRoot,
    receiptRef: sealed.ref,
    requireIndependence: true,
  });
  assert.equal(verified.executor_attribution, "runtime-agent");
  assert.equal(verified.receipt.reviewer_payload.execution_root_head, headSha);

  // T-3-6 disclosure boundary: no absolute binding path is persisted into the
  // record, the receipt payload, or the lineage telemetry.
  const recordBytes = readFileSync(path.join(recordsDir, `${record.record_id}.json`), "utf8");
  const receiptBytes = readFileSync(path.join(notesRoot(mainRoot), sealed.ref.path), "utf8");
  assert.equal(recordBytes.includes(worktreeRoot), false, "the record MUST NOT carry the absolute binding root");
  assert.equal(receiptBytes.includes(worktreeRoot), false, "the receipt payload MUST NOT carry the absolute binding path");
  const lineage = loadAdmissionRecords({ repoRoot: mainRoot, changeName: CHANGE });
  assert.equal(lineage.available, true, "telemetry reads the binding worktree first");
  assert.equal(JSON.stringify(lineage).includes(worktreeRoot), false, "telemetry records carry no absolute path");
  assert.equal(Object.hasOwn(lineage.records[0], "execution_root"), false, "execution_root is an input contract, never persisted");
  shared.sealed = sealed;
  shared.rawPayloadRef = rawPayloadRef;
});

// Review F-r1-2: the direct seal shape the CLI accepts (caller root = the main
// checkout, explicit changeId, optional `bindingRoot` pin) MUST resolve the
// binding root once and then claim and publish on it — never on the caller
// root. Before the seal seam shared the prepare-resolved root, this shape read
// the record at the main root, failed as `admission-record-unreadable`, and
// remapped that fault to the misleading `admission-record-consumed`.
test("Direct Seal From The Main Checkout Claims And Publishes On The Binding Root", () => {
  const { mainRoot, directWorktreeRoot, directHeadSha, seed } = shared;
  const directRecord = writeAdmissionRecord({
    cwd: directWorktreeRoot,
    host: "opencode",
    prompt: "direct seal fixture",
    fields: {
      objective: "independent-judgment",
      responsibility_id: "primary-review",
      instance_mode: "fresh",
      evidence_scope: "local diff",
      return_and_stop: "return findings and stop",
      role: "dp-reviewer",
    },
    roleBinding: "host-verified",
  });
  assert.equal(directRecord.ok, true, directRecord.code);
  assert.equal(directRecord.bindingRoot, directWorktreeRoot, "the direct-record fixture must bind the worktree");

  const dispatch = initialDispatch(directWorktreeRoot, DIRECT_CHANGE);
  const payload = receiptPayload({
    changeId: DIRECT_CHANGE,
    baseSha: seed,
    headSha: directHeadSha,
    dispatchId: dispatch.dispatch_id,
    riskDigest: dispatch.risk_shape_digest_sha256,
    executionRootHead: directHeadSha,
  });
  const payloadPath = writeRawPayload({ repoRoot: mainRoot, payload });
  const rawPayloadRef = helper.captureReviewerOutput({
    repoRoot: mainRoot,
    changeId: DIRECT_CHANGE,
    roundNumber: 1,
    dispatchId: dispatch.dispatch_id,
    payloadPath,
  });
  // The builder request already carries the resolved binding root; the direct
  // seal re-roots the caller to the main checkout and pins the binding worktree.
  const built = helper.buildReviewRoundReceiptRequest({
    repoRoot: mainRoot,
    changeId: DIRECT_CHANGE,
    rawPayloadRef,
    admissionRecordId: directRecord.record_id,
  });
  assert.equal(built.repoRoot, directWorktreeRoot, "the builder resolves the binding root");
  const sealed = helper.sealReviewRoundReceipt({
    ...built,
    repoRoot: mainRoot,
    bindingRoot: directWorktreeRoot,
  });

  // The irreversible claim and the receipt publication land on the binding
  // worktree's archived change folder; the main checkout stays untouched.
  const recordsDir = path.join(directWorktreeRoot, "openspec", "changes", "archive", DIRECT_ARCHIVE_ENTRY, "admission-records");
  assert.equal(existsSync(path.join(recordsDir, `${directRecord.record_id}.json`)), true);
  assert.equal(existsSync(path.join(recordsDir, `${directRecord.record_id}.claim`, "consumed.json")), true);
  assert.equal(existsSync(path.join(mainRoot, "openspec", "changes")), false, "nothing may land in the main checkout");
  const verified = helper.verifyReviewRoundReceipt({ repoRoot: mainRoot, receiptRef: sealed.ref, requireIndependence: true });
  assert.equal(verified.executor_attribution, "runtime-agent");
});

// The subagent-behavioral-contract sibling scenario title (verbatim):
// `Runtime-Agent Receipt Attests The Binding Root Head` — a review／verify
// payload sealed on a new `executor_kind: runtime-agent` receipt MUST carry
// `execution_root_head` equal to the resolved binding root HEAD, and a missing
// value on any new seal MUST fail closed the same way.
test("Declared-Path Receipt Attests The Binding Root Head", () => {
  const { mainRoot, worktreeRoot, headSha, seed, record } = shared;
  const dispatch = initialDispatch(worktreeRoot, CHANGE);
  const base = {
    changeId: CHANGE,
    baseSha: seed,
    headSha,
    riskDigest: dispatch.risk_shape_digest_sha256,
  };
  const receiptsBefore = receiptNames(mainRoot, `review-${CHANGE}-receipt-r1-`).length;

  // A missing `execution_root_head` on a new runtime-agent seal fails closed
  // with the existing `receipt-authority-changed`; nothing is published. The
  // synthetic dispatch id keeps this variant's raw carrier distinct (the
  // refusal fires before any logical-dispatch check).
  const missingDispatch = "a".repeat(64);
  const missingPath = writeRawPayload({
    repoRoot: mainRoot,
    payload: receiptPayload({ ...base, dispatchId: missingDispatch }),
  });
  const missingRef = helper.captureReviewerOutput({
    repoRoot: mainRoot, changeId: CHANGE, roundNumber: 1, dispatchId: missingDispatch, payloadPath: missingPath,
  });
  assert.throws(
    () => helper.buildReviewRoundReceiptRequest({
      repoRoot: mainRoot, changeId: CHANGE, rawPayloadRef: missingRef, admissionRecordId: record.record_id,
    }),
    /receipt-authority-changed/,
    "a new runtime-agent seal without execution_root_head MUST fail closed",
  );

  // A value that differs from the admission record head_sha fails closed the
  // same way, and the comparison is against the record, not the caller root.
  const driftedDispatch = "b".repeat(64);
  const driftedPath = writeRawPayload({
    repoRoot: mainRoot,
    payload: receiptPayload({ ...base, dispatchId: driftedDispatch, executionRootHead: "f".repeat(40) }),
  });
  const driftedRef = helper.captureReviewerOutput({
    repoRoot: mainRoot, changeId: CHANGE, roundNumber: 1, dispatchId: driftedDispatch, payloadPath: driftedPath,
  });
  assert.throws(
    () => helper.buildReviewRoundReceiptRequest({
      repoRoot: mainRoot, changeId: CHANGE, rawPayloadRef: driftedRef, admissionRecordId: record.record_id,
    }),
    /receipt-authority-changed/,
    "an execution_root_head that differs from the record head_sha MUST fail closed",
  );
  assert.equal(
    receiptNames(mainRoot, `review-${CHANGE}-receipt-r1-`).length,
    receiptsBefore,
    "both refusals must publish no receipt",
  );

  // Historical tolerance stays structural: the canonical key list does not
  // require the key, so a payload that predates it remains readable — the
  // conditional extension is what this change adds.
  const source = readFileSync(repoPath(".devpro/scripts/lib/review-remediation-evidence-core.mjs"), "utf8");
  assert.match(
    source,
    /REVIEWER_PAYLOAD_V3_KEYS,\s*\.\.\.\(Object\.hasOwn\(payload, "execution_root_head"\) \? \["execution_root_head"\] : \[\]\),/u,
    "execution_root_head must stay a conditional key (present ⇒ validated, absent ⇒ historical)",
  );
});

test("Unresolved Binding Leaves Review And Verify Unsealable", () => {
  const { mainRoot, headSha, seed, worktreeRoot, record } = shared;
  // The advisory shape (design D5): a dispatch that resolved no binding writes
  // no admission record, so no receipt may be sealed from it — the receipt gate
  // fails closed with zero publication and the advisory stays non-sealable.
  const dispatch = initialDispatch(worktreeRoot, CHANGE);
  const orphanRecordId = "00000000-0000-4000-8000-000000000000";
  const orphanDispatch = "c".repeat(64);
  const payloadPath = writeRawPayload({
    repoRoot: mainRoot,
    payload: receiptPayload({
      changeId: CHANGE,
      baseSha: seed,
      headSha,
      dispatchId: orphanDispatch,
      riskDigest: dispatch.risk_shape_digest_sha256,
      executionRootHead: headSha,
    }),
  });
  const rawPayloadRef = helper.captureReviewerOutput({
    repoRoot: mainRoot, changeId: CHANGE, roundNumber: 1, dispatchId: orphanDispatch, payloadPath,
  });
  const target = path.join(notesRoot(mainRoot), `review-${CHANGE}-receipt-r1-${orphanDispatch}.json`);
  assert.equal(existsSync(target), false);
  // Negative-assertion specificity (F-r2-2): the build path collapses a missing
  // record to this exact closed code at `deriveRuntimeAdmissionAuthorityRefs`,
  // so the assertion pins the intended rejection cause instead of an OR-union.
  assert.throws(
    () => helper.buildReviewRoundReceiptRequest({
      repoRoot: mainRoot, changeId: CHANGE, rawPayloadRef, admissionRecordId: orphanRecordId,
    }),
    /receipt-identity-authority-mismatch/u,
    "a round whose admission record was never written MUST NOT seal",
  );
  assert.equal(existsSync(target), false, "no receipt and no independence evidence may result");

  // A receipt cannot borrow another round's or another change's record: the
  // record id resolves against the receipt's own change id, and the sealed
  // round already consumed its record for this change. The pinned string is the
  // actual uniqueness-scan rejection for this path (F-r2-2).
  assert.throws(
    () => helper.buildReviewRoundReceiptRequest({
      repoRoot: mainRoot, changeId: CHANGE, rawPayloadRef, admissionRecordId: record.record_id,
    }),
    /admission record already evidences another receipt in this change/u,
    "borrowing the sealed round's record must not mint another receipt",
  );
});

// Cross-model CM-3 (`resolveConsumerBindingOrCaller` used to keep the caller
// root on *any* resolution fault). The subagent-behavioral-contract scenario
// `Main-Rooted Consumer Round Trip Reaches The Binding Worktree` admits the
// caller-root fallback only for the zero-candidate window — "two or more
// candidates, a scan fault, an unresolvable common-dir, or neither location
// holding a locatable change directory MUST still fail closed".
test("Main-Rooted Consumer Round Trip Reaches The Binding Worktree: twin candidates fail closed instead of the caller root", () => {
  const { mainRoot, sealed } = shared;
  // Baseline: the single live binding worktree serves the read.
  assert.equal(
    helper.verifyCurrentCrossCarrierClosure({ repoRoot: mainRoot, changeId: CHANGE }).status,
    "not-required",
    "the fixture baseline resolves the binding worktree before the twin exists",
  );

  // A real second linked worktree naming the same `.worktree/<id>` segment with
  // its own active change folder breaks exact-one: every consumer surface that
  // resolves the binding MUST propagate the ambiguity, never read the caller
  // root's notes as if one candidate had resolved.
  const twinRaw = path.join(mainRoot, "nested", ".worktree", CHANGE);
  mkdirSync(path.dirname(twinRaw), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${CHANGE}-twin`, twinRaw, "HEAD"]);
  const twinRoot = realpathSync(twinRaw);
  mkdirSync(path.join(twinRoot, "openspec", "changes", CHANGE), { recursive: true });
  try {
    assert.throws(
      () => helper.verifyCurrentCrossCarrierClosure({ repoRoot: mainRoot, changeId: CHANGE }),
      /change-worktree-ambiguous/u,
      "the current-closure projection must fail closed under a twin binding, not fall back to the caller root",
    );
    assert.throws(
      () => helper.sealCrossCarrierClosure({
        repoRoot: mainRoot,
        changeId: CHANGE,
        sourceReceiptRef: sealed.ref,
        findings: [],
      }),
      /change-worktree-ambiguous/u,
      "the closure seal must fail closed under a twin binding, not publish from the caller root",
    );
    const readiness = helper.classifyFinalReadiness({ repoRoot: mainRoot, changeId: CHANGE });
    assert.equal(readiness.final_ready, false);
    assert.equal(readiness.route, "full_reopen_required");
    assert.equal(
      readiness.review_lineage_valid,
      false,
      "readiness must not report caller-root lineage as valid under a twin binding",
    );
  } finally {
    git(mainRoot, ["worktree", "remove", "--force", twinRoot]);
  }

  // The fault clears with the twin: the same surface resolves the binding again.
  assert.equal(
    helper.verifyCurrentCrossCarrierClosure({ repoRoot: mainRoot, changeId: CHANGE }).status,
    "not-required",
    "removing the twin restores the single-candidate resolution",
  );
});

test("Main-Rooted Consumer Round Trip Reaches The Binding Worktree: a scan fault fails closed instead of the caller root", () => {
  const { mainRoot, sealed } = shared;
  // A registered linked worktree whose directory is gone but whose entry is
  // still enumerated (removal without `git worktree remove`): the porcelain
  // scan cannot canonicalize every candidate, so the resolution is a scan
  // fault — a broken workspace, not an absent binding — and MUST NOT be served
  // from the caller root.
  const prunedRaw = path.join(mainRoot, ".worktree", `${CHANGE}-pruned`);
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${CHANGE}-pruned`, prunedRaw, "HEAD"]);
  rmSync(prunedRaw, { recursive: true, force: true });
  try {
    assert.throws(
      () => helper.verifyCurrentCrossCarrierClosure({ repoRoot: mainRoot, changeId: CHANGE }),
      /intent-scan-failed/u,
      "the current-closure projection must fail closed on a scan fault, not fall back to the caller root",
    );
    assert.throws(
      () => helper.sealCrossCarrierClosure({
        repoRoot: mainRoot,
        changeId: CHANGE,
        sourceReceiptRef: sealed.ref,
        findings: [],
      }),
      /intent-scan-failed/u,
      "the closure seal must fail closed on a scan fault, not publish from the caller root",
    );
    const readiness = helper.classifyFinalReadiness({ repoRoot: mainRoot, changeId: CHANGE });
    assert.equal(readiness.final_ready, false);
    assert.equal(readiness.route, "full_reopen_required");
    assert.equal(
      readiness.review_lineage_valid,
      false,
      "readiness must not report caller-root lineage as valid on a scan fault",
    );
  } finally {
    git(mainRoot, ["worktree", "prune"]);
  }
});

test("Declared-Path Advisory Is Not Mint And Not Independence Evidence", () => {
  const { mainRoot } = shared;
  // The non-review advisory lane mints nothing, so it can never satisfy
  // requireIndependence: the receipt gate rejects a receipt that borrows no
  // real record, and an advisory-only path leaves no sealable authority behind.
  const advisoryRecords = loadAdmissionRecords({ repoRoot: mainRoot, changeName: "strengthen-advisory-unresolved" });
  assert.equal(advisoryRecords.available, false);
  assert.equal(ADMISSION_RECORDS_REASONS.includes(advisoryRecords.reason), true);
  assert.throws(
    () => helper.verifyReviewRoundReceipt({
      repoRoot: mainRoot,
      receiptRef: { path: `review-strengthen-advisory-unresolved-receipt-r1-${"a".repeat(64)}.json`, digest_sha256: "b".repeat(64) },
      requireIndependence: true,
    }),
    /change-worktree-required/u,
    "a receipt backed by no admission record can never verify as independent",
  );
});

test("Main-Rooted Consumer Round Trip: a removed worktree falls back to the caller root's archive and fails closed when neither location holds the change", () => {
  const { mainRoot, worktreeRoot, headSha, sealed } = shared;
  // The merge-shaped window: main advances to the reviewed head, the records
  // travel with the archived change folder, and the worktree is removed.
  git(mainRoot, ["reset", "--hard", headSha]);
  const archiveRecords = path.join(mainRoot, "openspec", "changes", "archive", ARCHIVE_ENTRY, "admission-records");
  cpSync(
    path.join(worktreeRoot, "openspec", "changes", "archive", ARCHIVE_ENTRY, "admission-records"),
    archiveRecords,
    { recursive: true },
  );
  git(mainRoot, ["worktree", "remove", "--force", worktreeRoot]);
  assert.equal(existsSync(worktreeRoot), false, "the binding worktree must actually be gone");

  // Zero candidates + the caller root's archive location → fall back, not fail closed.
  const verified = helper.verifyReviewRoundReceipt({ repoRoot: mainRoot, receiptRef: sealed.ref, requireIndependence: true });
  assert.equal(verified.executor_attribution, "runtime-agent");
  const lineage = loadAdmissionRecords({ repoRoot: mainRoot, changeName: CHANGE });
  assert.equal(lineage.available, true, "the removed-worktree window keeps reading the caller root's archive");

  // Neither location holds a locatable change directory → fail closed.
  rmSync(path.join(mainRoot, "openspec", "changes", "archive", ARCHIVE_ENTRY), { recursive: true, force: true });
  assert.throws(
    () => helper.verifyReviewRoundReceipt({ repoRoot: mainRoot, receiptRef: sealed.ref, requireIndependence: true }),
    /change-worktree-required/,
    "neither the binding worktree nor the caller root may locate the change → fail closed",
  );
  const unavailable = loadAdmissionRecords({ repoRoot: mainRoot, changeName: CHANGE });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "binding-unresolved", "the closed reason token names the unresolved binding");
  assert.equal(
    ADMISSION_RECORDS_REASONS.every((reason) => typeof reason === "string" && reason.length > 0),
    true,
    "the reason set is a closed token list",
  );
  assert.equal(
    ADMISSION_RECORDS_REASONS.includes(unavailable.reason),
    true,
    "every unavailable reason stays inside the closed token set",
  );
});

// strengthen-review-receipt-carry-forward-compaction F-rrcf-r1-01: the carry-forward
// check reads the immediate predecessor receipt at capture time. A runtime-agent
// predecessor is validated against its admission record, which lives under the
// binding worktree, so a capture issued from the main checkout MUST resolve the
// binding root before reading it -- exactly as build and seal already do.
test("Main-Rooted Consumer Round Trip Reaches The Binding Worktree: a round 2 capture from the main checkout root reads its runtime-agent predecessor through the binding worktree", () => {
  const { mainRoot, seed } = shared;
  const changeId = "strengthen-main-cwd-successor";
  const raw = path.join(mainRoot, ".worktree", changeId);
  mkdirSync(path.dirname(raw), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${changeId}`, raw, "HEAD"]);
  const worktreeRoot = realpathSync(raw);
  writeFullRiskChange(worktreeRoot, changeId);
  const headSha = commitAll(worktreeRoot, "successor change folder");
  const admission = (prompt) => {
    const record = writeAdmissionRecord({
      cwd: worktreeRoot,
      host: "opencode",
      prompt,
      fields: {
        objective: "independent-judgment",
        responsibility_id: "primary-review",
        instance_mode: "fresh",
        evidence_scope: "local diff",
        return_and_stop: "return findings and stop",
        role: "dp-reviewer",
      },
      roleBinding: "host-verified",
    });
    assert.equal(record.ok, true, record.code);
    return record;
  };
  const openFinding = {
    finding_id: "F-001",
    state: "open",
    disposition: null,
    observation: {
      axis: "1",
      severity: "Important",
      carrier: "src/review-target.mjs",
      anchor: "target",
      detail: "an open predecessor finding the successor must carry",
      evidence: ["src/review-target.mjs#target"],
    },
  };

  // Round 1: runtime-agent, one open finding, captured, built and sealed from the main checkout.
  const roundOneDispatch = initialDispatch(worktreeRoot, changeId);
  const roundOne = receiptPayload({
    changeId, baseSha: seed, headSha, dispatchId: roundOneDispatch.dispatch_id,
    riskDigest: roundOneDispatch.risk_shape_digest_sha256, executionRootHead: headSha,
  });
  roundOne.findings = [structuredClone(openFinding)];
  roundOne.scope.open_finding_ids = ["F-001"];
  roundOne.verdict = "partial";
  const roundOneRef = helper.captureReviewerOutput({
    repoRoot: mainRoot, changeId, roundNumber: 1, dispatchId: roundOneDispatch.dispatch_id,
    payloadPath: writeRawPayload({ repoRoot: mainRoot, payload: roundOne }),
  });
  const recordOne = admission("successor fixture round one");
  const sealedOne = helper.sealReviewRoundReceipt(helper.buildReviewRoundReceiptRequest({
    repoRoot: mainRoot, changeId, rawPayloadRef: roundOneRef, admissionRecordId: recordOne.record_id,
  }));

  // Round 2: a full successor that carries F-001, captured from the MAIN checkout root.
  const roundTwoDispatch = helper.classifyBoundedRereview({
    repoRoot: worktreeRoot,
    changeId,
    previousReceiptRef: sealedOne.ref,
    repairDeltaManifestRef: null,
    dependencyClosureManifestRef: null,
    predecessorMatches: [],
    postDispatchDiscovery: "new_critical",
    observationRecorded: true,
  });
  assert.equal(roundTwoDispatch.route, "full");
  assert.equal(roundTwoDispatch.round_number, 2);
  const roundTwo = receiptPayload({
    changeId, baseSha: seed, headSha, dispatchId: roundTwoDispatch.dispatch_id,
    riskDigest: roundTwoDispatch.risk_shape_digest_sha256, executionRootHead: headSha,
  });
  roundTwo.round_number = 2;
  roundTwo.lineage.previous_receipt_ref = sealedOne.ref;
  roundTwo.lineage.initial_full_receipt_digest_sha256 = sealedOne.ref.digest_sha256;
  roundTwo.findings = [structuredClone(openFinding)];
  roundTwo.scope.open_finding_ids = ["F-001"];
  roundTwo.verdict = "partial";
  const roundTwoPath = writeRawPayload({ repoRoot: mainRoot, payload: roundTwo });
  const captureFromMain = () => helper.captureReviewerOutput({
    repoRoot: mainRoot, changeId, roundNumber: 2, dispatchId: roundTwoDispatch.dispatch_id, payloadPath: roundTwoPath,
  });
  const roundTwoRef = captureFromMain();
  assert.equal(
    existsSync(path.join(notesRoot(mainRoot), roundTwoRef.path)),
    true,
    "the legal successor is published from the main checkout root, exactly as from the binding worktree",
  );

  // The rest of the round trip from the main checkout still works on the published raw.
  const recordTwo = admission("successor fixture round two");
  const sealedTwo = helper.sealReviewRoundReceipt(helper.buildReviewRoundReceiptRequest({
    repoRoot: mainRoot, changeId, rawPayloadRef: roundTwoRef, admissionRecordId: recordTwo.record_id,
  }));
  assert.equal(
    helper.verifyReviewRoundReceipt({ repoRoot: mainRoot, receiptRef: sealedTwo.ref, requireIndependence: true }).executor_attribution,
    "runtime-agent",
  );
});
