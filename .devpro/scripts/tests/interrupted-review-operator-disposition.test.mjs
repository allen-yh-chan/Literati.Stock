import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as evidence from "../hooks/lib/second-review-control-evidence.mjs";
import { writePostPrCompletionMarker } from "../hooks/lib/post-pr-completion-state.mjs";
import { USAGE_MANIFEST_FILE } from "../lib/session-usage-manifest-contract.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identityFields = ["repository_slug", "pr_number", "head_ref_oid", "attempt_id", "dispatch_id", "previous_dispatch_id"];

async function fixture(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "interrupted-disposition-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatch = {
    schema: evidence.DISPATCH_SCHEMA,
    repository_slug: "devpro/example",
    pr_number: "17",
    head_ref_oid: "a".repeat(40),
    attempt_id: "interrupted-attempt",
    dispatch_id: "dispatch-interrupted",
    previous_dispatch_id: null,
    packet_sha256: "b".repeat(64),
    carrier_root_id: "c".repeat(64),
    paged_full_material_sha256: "d".repeat(64),
    paged_full_material_created_at: "2026-10-29T00:00:00.000Z",
    paged_full_material_expires_at: "2026-10-29T02:00:00.000Z",
  };
  await evidence.reserveDispatchRecord({ rootDir, record: dispatch });
  await evidence.claimDispatchInvocation({ rootDir, record: dispatch });
  const original = evidence.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id });
  const activity = Buffer.from('start\nexit\nstart\nexit\nstart\nexit\nstart\nexit\nstart\n');
  const record = {
    schema: "devpro-second-review-operator-disposition/v1",
    ...Object.fromEntries(identityFields.map((key) => [key, dispatch[key]])),
    outcome: "operator_abandoned_interrupted_dispatch",
    dispatch_sha256: digest(original.dispatchBytes),
    invocation_claim_sha256: digest(original.invocationClaimBytes),
    lifecycle_slot_sha256: digest(readFileSync(original.paths.lifecycleSlot)),
    packet_sha256: dispatch.packet_sha256,
    carrier_root_id: dispatch.carrier_root_id,
    paged_full_material_sha256: dispatch.paged_full_material_sha256,
    activity_prefix_bytes: activity,
    activity_prefix_length: activity.length,
    activity_prefix_sha256: digest(activity),
    lock_snapshot_sha256: "e".repeat(64),
    marker_snapshot_sha256: "f".repeat(64),
    sticky_snapshot_sha256: digest(Buffer.from("[]")),
    operator_login: "operator",
    repository_permissions_push: true,
    permission_source: "gh-api-repository",
    authorization_checked_at: "2026-10-29T03:00:00.000Z",
    pr_state: "OPEN",
    pr_merged: false,
    remote_pr_head: dispatch.head_ref_oid,
    typed_confirmation: `ABANDON interrupted second-review dispatch ${dispatch.repository_slug}#${dispatch.pr_number} head ${dispatch.head_ref_oid} attempt ${dispatch.attempt_id} dispatch ${dispatch.dispatch_id} close_unobserved fresh-full-review-only`,
    reason: "Operator abandoned interrupted invocation after five starts and four exits",
    created_at: "2026-10-29T03:01:00.000Z",
    process_spawned: true,
    process_close_observed: false,
    transport_cleanup_confirmed: false,
    scan_complete: false,
    review_authority: "none",
    successor_policy: "fresh-full-review-only",
  };
  return { rootDir, dispatch, original, record };
}

test("interrupted operator disposition preserves the claimed attempt without inventing process close", async (t) => {
  const { rootDir, dispatch, original, record } = await fixture(t);
  assert.equal(typeof evidence.writeInterruptedDispatchDisposition, "function", "bounded operator disposition writer is required");
  const result = await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  assert.equal(result.status, "created");
  assert.equal(result.record.process_close_observed, false);
  assert.equal(result.record.scan_complete, false);
  assert.equal(result.record.review_authority, "none");
  assert.equal(Object.hasOwn(result.record, "activity_prefix_bytes"), false);
  const after = evidence.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id });
  assert.deepEqual(after.operatorDisposition, result.record);
  assert.equal(after.terminal, null);
  assert.equal(after.completion, null);
  assert.deepEqual(after.dispatchBytes, original.dispatchBytes);
  assert.deepEqual(after.invocationClaimBytes, original.invocationClaimBytes);
  assert.equal(digest(readFileSync(after.paths.lifecycleSlot)), record.lifecycle_slot_sha256);
});

test("negative authority fence allows unknown ordinary dispatches and denies the exact disposed identity", async (t) => {
  const { rootDir, dispatch, record } = await fixture(t);
  const target = { rootDir, dispatchId: dispatch.dispatch_id, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid };
  assert.deepEqual(evidence.assertDispatchReviewAuthority({ ...target, dispatchId: "mock-dispatch" }), { allowed: true });
  assert.deepEqual(evidence.assertDispatchReviewAuthority(target), { allowed: true });
  assert.equal(evidence.interruptedDispatchConfirmation(dispatch), record.typed_confirmation);
  await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  assert.throws(() => evidence.assertDispatchReviewAuthority(target), /no review authority/);
  for (const mismatch of [{ repositorySlug: "other/repo" }, { prNumber: "18" }, { headRefOid: "b".repeat(40) }]) {
    assert.throws(() => evidence.assertDispatchReviewAuthority({ ...target, ...mismatch }), /target identity/);
  }
});

test("disposition publication is byte-identical idempotent and conflicting retry authority cannot replace it", async (t) => {
  const { rootDir, record } = await fixture(t);
  const results = await Promise.all([
    evidence.writeInterruptedDispatchDisposition({ rootDir, record }),
    evidence.writeInterruptedDispatchDisposition({ rootDir, record }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["created", "idempotent"]);
  const bytes = readFileSync(results[0].path);
  for (const replacement of [{ reason: "different reason" }, { operator_login: "different-operator" },
    { created_at: "2026-10-29T03:02:00.000Z" }]) {
    await assert.rejects(evidence.writeInterruptedDispatchDisposition({ rootDir, record: { ...record, ...replacement } }), /collision/);
    assert.deepEqual(readFileSync(results[0].path), bytes);
  }
});

test("exact input schema, immutable pins, activity bytes, and truthful authority flags are mandatory", async (t) => {
  const { rootDir, original, record } = await fixture(t);
  const invalid = [
    { process_spawned: false }, { process_spawned: "false" }, { invocation_claim_sha256: null },
    { process_spawned: false, invocation_claim_sha256: null, lifecycle_slot_sha256: null },
    { process_close_observed: true }, { transport_cleanup_confirmed: true },
    { scan_complete: true }, { review_authority: "PASS" }, { successor_policy: "reuse-coverage" },
    { repository_permissions_push: false }, { permission_source: "operator-self-report" },
    { remote_pr_head: "not-a-sha" }, { typed_confirmation: "ABANDON" }, { operator_login: "" },
    { pr_state: "CLOSED" }, { pr_merged: true }, { reason: "" }, { reason: "x".repeat(1025) },
    { authorization_checked_at: "invalid" }, { created_at: "2026-10-29T02:00:00.000Z" },
    { dispatch_sha256: "0".repeat(64) }, { invocation_claim_sha256: "0".repeat(64) },
    { lifecycle_slot_sha256: "0".repeat(64) }, { packet_sha256: "0".repeat(64) },
    { carrier_root_id: "0".repeat(64) }, { paged_full_material_sha256: null },
    { activity_prefix_bytes: Buffer.from("different bytes") }, { activity_prefix_length: 0 },
    { activity_prefix_sha256: "0".repeat(64) }, { lock_snapshot_sha256: "bad" },
    { marker_snapshot_sha256: "bad" }, { sticky_snapshot_sha256: "bad" }, { fake_pass: true },
    { integrity_id: "0".repeat(64) },
  ];
  for (const overrides of invalid) {
    await assert.rejects(evidence.writeInterruptedDispatchDisposition({ rootDir, record: { ...record, ...overrides } }),
      undefined, `must reject ${Object.keys(overrides).join(",")}`);
    assert.equal(existsSync(original.paths.operatorDisposition), false);
  }
  const missing = { ...record };
  delete missing.marker_snapshot_sha256;
  await assert.rejects(evidence.writeInterruptedDispatchDisposition({ rootDir, record: missing }), /field set/);
});

// Models the Codex reviewer sandbox: the gated writer reads this root but cannot create the capacity lock in it.
const readOnlyRootUnsupported = process.platform === "win32" || process.getuid?.() === 0;
function withReadOnlyRoot(rootDir, operation) {
  chmodSync(rootDir, 0o500);
  try {
    return operation();
  } finally {
    chmodSync(rootDir, 0o700);
  }
}

test("negative authority fence needs read access only while no disposition exists", { skip: readOnlyRootUnsupported }, async (t) => {
  const { rootDir, dispatch } = await fixture(t);
  const target = { rootDir, dispatchId: dispatch.dispatch_id, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid };
  assert.deepEqual(withReadOnlyRoot(rootDir, () => evidence.assertDispatchReviewAuthority(target)), { allowed: true });
  assert.deepEqual(readdirSync(rootDir).filter((name) => name.startsWith(".capacity-lock")), []);
});

test("negative authority fence does not wait on a held capacity lock while no disposition exists", async (t) => {
  const { rootDir, dispatch } = await fixture(t);
  const target = { rootDir, dispatchId: dispatch.dispatch_id, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid };
  const release = evidence.acquireCapacityLockForTest(rootDir, { waitMs: 200 });
  try {
    assert.deepEqual(evidence.assertDispatchReviewAuthority(target), { allowed: true });
  } finally {
    release();
  }
});

test("a read-only root still refuses a disposed dispatch", { skip: readOnlyRootUnsupported }, async (t) => {
  const { rootDir, dispatch, record } = await fixture(t);
  const target = { rootDir, dispatchId: dispatch.dispatch_id, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid };
  await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  withReadOnlyRoot(rootDir, () => assert.throws(() => evidence.assertDispatchReviewAuthority(target)));
});

test("a malformed retirement manifest fails the fence before the disposition check", async (t) => {
  const { rootDir, dispatch } = await fixture(t);
  const target = { rootDir, dispatchId: dispatch.dispatch_id, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid };
  writeFileSync(path.join(rootDir, ".cleanup-retirement.json"), "{");
  assert.throws(() => evidence.assertDispatchReviewAuthority(target));
});

test("known corrupt or symlinked disposition fails closed in raw, strict, and authority readers", async (t) => {
  const { rootDir, dispatch, record, original } = await fixture(t);
  const target = { rootDir, dispatchId: dispatch.dispatch_id, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid };
  const created = await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  const bytes = readFileSync(created.path);
  for (const broken of ["{", "{}\n", `${bytes.toString("utf8")} `]) {
    writeFileSync(created.path, broken);
    assert.throws(() => evidence.readDispatchEvidence(target));
    assert.throws(() => evidence.readDispatchEvidenceStrict(target));
    assert.throws(() => evidence.assertDispatchReviewAuthority(target));
  }
  rmSync(created.path);
  symlinkSync(path.join(rootDir, "missing-target"), created.path);
  assert.throws(() => evidence.readDispatchEvidence(target), /regular immutable file/);
  assert.throws(() => evidence.assertDispatchReviewAuthority(target), /regular immutable file/);
  rmSync(created.path);
  symlinkSync(original.paths.dispatch, created.path);
  assert.throws(() => evidence.readDispatchEvidenceStrict(target), /regular immutable file/);
});

test("all lifecycle writers reject an already disposed attempt", async (t) => {
  const { rootDir, dispatch, record } = await fixture(t);
  await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  const identity = Object.fromEntries(identityFields.map((key) => [key, dispatch[key]]));
  const actions = [
    () => evidence.claimDispatchInvocation({ rootDir, record: dispatch }),
    () => evidence.writeCompletionReceipt({ rootDir, record: identity }),
    () => evidence.writeTerminalReceipt({ rootDir, record: identity }),
    () => evidence.writeFaultCapsule({ rootDir, record: { ...identity, schema: evidence.FAULT_CAPSULE_SCHEMA,
      classification: "reviewer_orchestration_unknown" } }),
    () => evidence.writeConsumptionReceipt({ rootDir, record: identity }),
    () => evidence.writeReviewerModelRecord({ rootDir, record: identity }),
  ];
  for (const action of actions) await assert.rejects(action(), /operator disposition/);
});

test("competing completion or model authority and symlinked original pins block disposition", async (t) => {
  const { rootDir, dispatch, original, record } = await fixture(t);
  const companion = path.join(original.directory, USAGE_MANIFEST_FILE);
  writeFileSync(companion, "usage companion bytes\n");
  const originalBytes = readFileSync(original.paths.dispatch);
  rmSync(original.paths.dispatch);
  const displaced = path.join(rootDir, ".original-dispatch.json");
  writeFileSync(displaced, originalBytes);
  symlinkSync(displaced, original.paths.dispatch);
  await assert.rejects(evidence.writeInterruptedDispatchDisposition({ rootDir, record }), /regular immutable evidence/);
  rmSync(original.paths.dispatch);
  writeFileSync(original.paths.dispatch, originalBytes);
  // Unknown/model/terminal artifacts may not be silently filtered out of this disposition.
  const conflict = path.join(original.directory, "unexpected-evidence.json");
  writeFileSync(conflict, "{}\n");
  await assert.rejects(evidence.writeInterruptedDispatchDisposition({ rootDir, record }), /unknown artifact/);
  rmSync(conflict);
  await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  assert.equal(readFileSync(companion, "utf8"), "usage companion bytes\n");
  writeFileSync(conflict, "{}\n");
  assert.throws(() => evidence.readDispatchEvidenceStrict({ rootDir, dispatchId: dispatch.dispatch_id }), /unknown artifact/);
});

test("existing real completion, terminal, fault, or model records exclude operator disposition", async (t) => {
  for (const kind of ["completion", "terminal", "fault", "model"]) {
    await t.test(kind, async (subtest) => {
      const { rootDir, dispatch, record } = await fixture(subtest);
      const identity = Object.fromEntries(identityFields.map((key) => [key, dispatch[key]]));
      if (kind === "completion") {
        await evidence.writeCompletionReceipt({ rootDir, record: { ...identity,
          outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified",
          sticky_verdict: "PASS", sticky_last_reviewed_sha: dispatch.head_ref_oid,
          sticky_dispatch_id: dispatch.dispatch_id, sticky_comment_id: 4242,
          sticky_comment_url: `https://github.com/${dispatch.repository_slug}/pull/17#issuecomment-4242`,
          process_close_observed: true } });
      } else if (kind === "terminal") {
        await evidence.writeTerminalReceipt({ rootDir, record: { ...identity,
          outcome_group: "terminal_contract_or_cli_failure", classification: "reviewer_cli_interrupted",
          responsibility: evidence.TERMINAL_RECEIPT_RESPONSIBILITY, process_spawned: true,
          lifecycle_phase: "post_close_transport_cleaned", process_close_observed: true, transport_cleanup_confirmed: true,
          invocation_claim_sha256: record.invocation_claim_sha256 } });
      } else if (kind === "fault") {
        await evidence.writeFaultCapsule({ rootDir, record: { ...identity,
          schema: evidence.FAULT_CAPSULE_SCHEMA, classification: "reviewer_orchestration_unknown" } });
      } else {
        await evidence.writeReviewerModelRecord({ rootDir, record: { ...identity,
          reviewer_cli_family: "claude", requested_model: "opus", requested_source: "built-in-default",
          requested_source_env_var: "none", requested_kind: "alias", observed_model: "claude-opus-5",
          observed_source: "execution-stream", observed_unavailable_reason: "none", agreement: "alias-expansion-expected" } });
      }
      await assert.rejects(evidence.writeInterruptedDispatchDisposition({ rootDir, record }), /unknown artifact/);
    });
  }
});

test("disposed predecessors allow fresh same-head and exact-marker cross-head successors while preserving audit capacity", async (t) => {
  const { rootDir, dispatch, record, original } = await fixture(t);
  await evidence.writeInterruptedDispatchDisposition({ rootDir, record });
  const after = evidence.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id });
  assert.equal(after.totalBytes, original.totalBytes + after.operatorDispositionBytes.length);
  const sameHead = { ...dispatch, attempt_id: "fresh-same-head", dispatch_id: "dispatch-fresh-same-head",
    previous_dispatch_id: dispatch.dispatch_id };
  await evidence.reserveDispatchRecord({ rootDir, record: sameHead });
  const previousRoot = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = path.join(rootDir, ".markers");
  t.after(() => {
    if (previousRoot === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previousRoot;
  });
  const file = writePostPrCompletionMarker({ cwd: rootDir, repositorySlug: dispatch.repository_slug,
    prNumber: dispatch.pr_number, headRefOid: dispatch.head_ref_oid, expectedDispatchId: dispatch.dispatch_id, sessionId: "" });
  const bytes = readFileSync(file);
  const crossHead = { ...sameHead, attempt_id: "fresh-cross-head", dispatch_id: "dispatch-fresh-cross-head",
    head_ref_oid: "b".repeat(40) };
  await evidence.reserveDispatchRecord({ rootDir, record: crossHead,
    predecessorMarker: { file, snapshot: JSON.parse(bytes.toString("utf8")), sha256: digest(bytes) } });
  assert.deepEqual(readFileSync(original.paths.dispatch), original.dispatchBytes);
  const cleanup = await evidence.cleanupDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id,
    now: Date.now() + 365 * 24 * 60 * 60_000, markerInventory: () => [] });
  assert.equal(cleanup.cleaned, false);
  assert.equal(cleanup.reason, "operator-disposition-audit-retained");
  const owner = await evidence.cleanupOwnedControlEvidence({ rootDir,
    now: Date.now() + 365 * 24 * 60 * 60_000, markerInventory: () => [] });
  assert.equal(owner.cleanedDirectories, 0, "dependent successor lineage remains retained with the disposed audit");
  assert.equal(existsSync(after.paths.operatorDisposition), true);
});
