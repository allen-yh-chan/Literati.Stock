import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import * as helper from "../hooks/lib/second-review-control-evidence.mjs";
import { USAGE_MANIFEST_SCHEMA, readUsageManifest, writeUsageManifest } from "../lib/session-usage-manifest.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const markerInventory = () => [];
function usageManifest(dispatchId) {
  return { schema: USAGE_MANIFEST_SCHEMA, dispatch_id: dispatchId, attempt_id: `attempt-${dispatchId}`,
    repository_slug: "devpro/example", head_ref_oid: "a".repeat(40), mode: "audit-only",
    review_target: "design", recorded_at: new Date().toISOString(), sessions: [], gaps: [] };
}
function treeBytes(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [entry.name,
    entry.isDirectory() ? treeBytes(path.join(root, entry.name)) : readFileSync(path.join(root, entry.name)).toString("base64")]);
}
function record(id, previous = null) {
  return { schema: helper.DISPATCH_SCHEMA, repository_slug: "devpro/example", pr_number: "1658",
    head_ref_oid: "a".repeat(40), attempt_id: `attempt-${id}`, dispatch_id: id,
    previous_dispatch_id: previous, packet_sha256: "a".repeat(64), carrier_root_id: "b".repeat(64) };
}
async function fixture(operation) {
  const root = makeTempDir("dispatch-retirement-");
  try { await operation(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function age(root, id) {
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const name of readdirSync(path.join(root, id))) utimesSync(path.join(root, id, name), old, old);
}
function manifest(root, ids) {
  const plan = { schema: "devpro-second-review-retirement/v1", plan_id: "12345678-1234-4123-8123-123456789abc",
    root_identity_sha256: hash(path.resolve(root)), created_at: new Date().toISOString(),
    members: ids.sort().map((id) => ({ dispatch_id: id,
      reservation: JSON.parse(readFileSync(path.join(root, id, "dispatch.json"), "utf8")),
      reservation_sha256: hash(readFileSync(path.join(root, id, "dispatch.json"))),
      files: readdirSync(path.join(root, id)).sort().map((name) => {
        const bytes = readFileSync(path.join(root, id, name)); return { name, size: bytes.length, sha256: hash(bytes) };
      }) })) };
  writeFileSync(path.join(root, ".cleanup-retirement.json"), `${JSON.stringify(plan)}\n`);
  return plan;
}
function expiredUsage(root, now) {
  const directory = path.join(root, ".usage-manifest-retention"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "dispatch-expired-usage.json");
  writeFileSync(file, JSON.stringify(usageManifest("dispatch-expired-usage")));
  const expired = new Date(now - 31 * 24 * 3600_000); utimesSync(file, expired, expired);
  return file;
}
function exhaustedCleanup(options) {
  const originalNow = Date.now, base = originalNow(); let reads = 0;
  Date.now = () => base + (reads++ === 0 ? 0 : 2);
  try { return helper.cleanupOwnedControlEvidence({ ...options, now: base, budgetMs: 1 }); }
  finally { Date.now = originalNow; }
}
test("retirement usage sweep runs once after exhausted admission, pending recovery and inventory return", async (t) => {
  for (const mode of ["retained-prefix", "pending-plan", "pending-plan-no-inspect", "incomplete-inventory"]) await t.test(mode, async () => fixture(async (rootDir) => {
    const first = record("dispatch-retention-a"), next = record("dispatch-retention-b", first.dispatch_id);
    await helper.reserveDispatchRecord({ rootDir, record: first });
    if (mode === "retained-prefix") await helper.writeFaultCapsule({ rootDir, record: { ...first,
      schema: helper.FAULT_CAPSULE_SCHEMA, classification: "reviewer_orchestration_unknown", redacted_excerpt: "retained prefix" } });
    if (mode.startsWith("pending-plan")) await helper.reserveDispatchRecord({ rootDir, record: next });
    age(rootDir, first.dispatch_id); if (mode.startsWith("pending-plan")) {
      age(rootDir, next.dispatch_id); await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxCleanup: 1 });
    }
    if (mode === "incomplete-inventory") mkdirSync(path.join(rootDir, "dispatch-unknown-inventory"));
    const expired = expiredUsage(rootDir, Date.now());
    const run = await exhaustedCleanup({ rootDir, markerInventory, ...(mode === "pending-plan-no-inspect" ? { maxInspect: 0 } : {}) });
    assert.equal(existsSync(expired), false, mode);
    assert.equal(run.retentionCleanup.expired, 1, mode);
    assert.deepEqual(run.retentionCleanup.errors, [], mode);
    if (mode.startsWith("pending-plan")) assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), true);
    if (mode === "incomplete-inventory") assert.equal(run.results[0].reason, "incomplete-evidence");
    if (mode === "retained-prefix") for (let round = 0; round < 3; round += 1) {
      const expiredAgain = expiredUsage(rootDir, Date.now());
      assert.equal((await exhaustedCleanup({ rootDir, markerInventory })).retentionCleanup.expired, 1);
      assert.equal(existsSync(expiredAgain), false, "repeated exhausted deadlines cannot starve retention");
    }
    assert.equal(existsSync(path.join(rootDir, ".capacity-lock")), false);
  }));
});
test("retirement retention sweep errors preserve cursor, primary failure and lock release", async (t) => {
  for (const mode of ["cursor", "primary-error"]) await t.test(mode, async () => fixture(async (rootDir) => {
    const first = record("dispatch-sweep-a"), second = record("dispatch-sweep-b");
    await helper.reserveDispatchRecord({ rootDir, record: first }); await helper.reserveDispatchRecord({ rootDir, record: second });
    if (mode === "cursor") await helper.writeFaultCapsule({ rootDir, record: { ...first,
      schema: helper.FAULT_CAPSULE_SCHEMA, classification: "reviewer_orchestration_unknown", redacted_excerpt: "retained prefix" } });
    age(rootDir, first.dispatch_id); age(rootDir, second.dispatch_id);
    expiredUsage(rootDir, Date.now());
    const retentionDirectory = path.join(rootDir, ".usage-manifest-retention"), originalRead = fs.readdirSync;
    let sweeps = 0, result, caught;
    const primary = Object.assign(new Error("fixture primary failure"), { classification: "fixture_primary" });
    fs.readdirSync = (directory, ...args) => {
      if (path.resolve(directory) === retentionDirectory) { sweeps += 1; throw new Error("fixture retention failure"); }
      return originalRead(directory, ...args);
    };
    syncBuiltinESMExports();
    try {
      result = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxInspect: 1,
        retirementCheckpoint: (name) => { if (mode === "primary-error" && name === "manifest-published") throw primary; } });
    } catch (error) { caught = error; }
    finally { fs.readdirSync = originalRead; syncBuiltinESMExports(); }
    if (mode === "cursor") {
      assert.equal(caught, undefined);
      assert.equal(JSON.parse(readFileSync(path.join(rootDir, ".cleanup-scan-cursor.json"))).next_index, 1);
    } else assert.equal(caught, primary, "sweep must preserve the same primary Error instance");
    assert.equal(sweeps, 1);
    assert.deepEqual((result ?? caught).retentionCleanup.errors, [{ operation: "sweep", message: "fixture retention failure" }]);
    assert.equal(existsSync(path.join(rootDir, ".capacity-lock")), false);
  }));
});
test("retirement usage sweep preserves all no-work zero-mutation clamps", async () => {
  for (const clamp of [{ budgetMs: 0 }, { maxCleanup: 0 }, { maxInspect: 0 }]) await fixture(async (rootDir) => {
    expiredUsage(rootDir, Date.now()); const before = treeBytes(rootDir);
    await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, ...clamp });
    assert.deepEqual(treeBytes(rootDir), before);
  });
});
test("retirement pinned reservation permits unrelated capacity after identity unlink", async () => fixture(async (rootDir) => {
  const retired = record("dispatch-pinned-a"); await helper.reserveDispatchRecord({ rootDir, record: retired }); age(rootDir, retired.dispatch_id);
  const child = launch(`${childPrelude}
    await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory: () => [],
      retirementCheckpoint: (name, detail) => { if (name === 'member-fsynced' && detail.name === 'dispatch.json') process.exit(77); } });`, [rootDir]);
  const crashed = await child.closed; assert.equal(crashed.code, 77, crashed.stderr); ageDeadLock(rootDir);
  const authority = path.join(rootDir, ".cleanup-retirement.json"), bytes = readFileSync(authority), plan = JSON.parse(bytes);
  assert.equal(existsSync(path.join(rootDir, retired.dispatch_id, "dispatch.json")), false);
  assert.deepEqual(plan.members[0].reservation, retired, "authority must retain the complete immutable reservation");
  const unrelated = { ...record("dispatch-pinned-unrelated"), pr_number: "9999" };
  assert.equal((await helper.reserveDispatchRecord({ rootDir, record: unrelated })).status, "created");
  assert.deepEqual(readFileSync(authority), bytes);
  assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: retired.dispatch_id }), { classification: "dispatch_evidence_retiring" });
  await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
  assert.equal(existsSync(authority), false);
  assert.equal(existsSync(path.join(rootDir, retired.dispatch_id)), false);
}));
test("retirement pinned reservation preserves original PR/head slots until directories disappear", async () => fixture(async (rootDir) => {
  let previous = null; const retired = [];
  for (let index = 0; index < 16; index += 1) {
    const dispatch = record(`dispatch-slot-${String(index).padStart(2, "0")}`, previous);
    await helper.reserveDispatchRecord({ rootDir, record: dispatch }); age(rootDir, dispatch.dispatch_id);
    previous = dispatch.dispatch_id; retired.push(dispatch);
  }
  const interruption = new Error("slot identity unlinked");
  await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory,
    retirementCheckpoint: (name, detail) => { if (name === "member-fsynced" && detail.name === "dispatch.json") throw interruption; } }),
  (error) => error === interruption);
  assert.equal(existsSync(path.join(rootDir, retired[0].dispatch_id, "dispatch.json")), false);
  const candidate = record("dispatch-slot-refused");
  await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: candidate }),
    { classification: "reviewer_dispatch_capacity_exceeded", message: "PR/head dispatch capacity is 16" });
  assert.equal(existsSync(path.join(rootDir, candidate.dispatch_id)), false);
  for (const unrelated of [{ ...record("dispatch-slot-new-head"), head_ref_oid: "b".repeat(40) },
    { ...record("dispatch-slot-other-repository"), repository_slug: "devpro/other" }]) {
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: unrelated })).status, "created");
  }
  await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
  assert.equal((await helper.reserveDispatchRecord({ rootDir, record: candidate })).status, "created");
}));
test("retirement pinned reservation counts all original file bytes in original capacity buckets", async (t) => {
  for (const scope of ["PR/head", "repository"]) await t.test(scope, async () => fixture(async (rootDir) => {
    const first = record("dispatch-bytes-a"), second = record("dispatch-bytes-b", first.dispatch_id);
    await helper.reserveDispatchRecord({ rootDir, record: first }); await helper.reserveDispatchRecord({ rootDir, record: second });
    writeFileSync(path.join(rootDir, first.dispatch_id, "usage-manifest.json"), " ".repeat(4096));
    age(rootDir, first.dispatch_id); age(rootDir, second.dispatch_id);
    const interruption = new Error("byte identity unlinked");
    await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory,
      retirementCheckpoint: (name, detail) => { if (name === "member-fsynced" && detail.name === "dispatch.json") throw interruption; } }),
    (error) => error === interruption);
    const plan = JSON.parse(readFileSync(path.join(rootDir, ".cleanup-retirement.json")));
    const originalBytes = plan.members.flatMap((member) => member.files).reduce((total, file) => total + file.size, 0);
    const filler = record("dispatch-bytes-filler"); await helper.reserveDispatchRecord({ rootDir, record: filler });
    const fillerIdentityBytes = readFileSync(path.join(rootDir, filler.dispatch_id, "dispatch.json")).length;
    const limit = scope === "PR/head" ? 524288 : 16777216;
    // Existing identity-only capacity fallback must still count unknown legacy
    // lifecycle bytes; this puts the original retired inventory one byte over.
    const oversizedTerminal = path.join(rootDir, filler.dispatch_id, "terminal-receipt.json");
    writeFileSync(oversizedTerminal, "x".repeat(limit - originalBytes - fillerIdentityBytes + 1));
    const candidate = { ...record("dispatch-bytes-refused"), ...(scope === "repository" ? { pr_number: "9999" } : {}) };
    await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: candidate }),
      { classification: "reviewer_dispatch_capacity_exceeded", message: `${scope} evidence byte capacity is ${limit}` });
    assert.equal(existsSync(path.join(rootDir, candidate.dispatch_id)), false);
    rmSync(oversizedTerminal);
    await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
    assert.equal((await helper.reserveDispatchRecord({ rootDir, record: candidate })).status, "created");
  }));
});
test("retirement pinned reservation parser binds full identity, canonical hash and dispatch file length", async (t) => {
  for (const kind of ["missing", "field", "identity", "digest", "file-digest", "file-length", "byte-bound"]) await t.test(kind, async () => fixture(async (rootDir) => {
    const dispatch = record("dispatch-pin-invalid"); await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const plan = manifest(rootDir, [dispatch.dispatch_id]), member = plan.members[0];
    helper.assertDispatchEvidenceAvailable({ rootDir, dispatchId: "dispatch-unrelated" });
    if (kind === "missing") delete member.reservation;
    if (kind === "field") delete member.reservation.packet_sha256;
    if (kind === "identity") member.reservation.dispatch_id = "dispatch-other";
    if (kind === "digest") member.reservation.packet_sha256 = "f".repeat(64);
    if (kind === "file-digest") member.files[0].sha256 = "f".repeat(64);
    if (kind === "file-length") member.files[0].size += 1;
    if (kind === "byte-bound") {
      member.reservation.lineage_approval_receipt_id = "9001";
      member.reservation.lineage_approval_receipt = { schema: "devpro-second-review-lineage-approval/v1",
        repository_slug: dispatch.repository_slug, pr_number: dispatch.pr_number, source_state: "clear-obligation",
        old_head_ref_oid: "b".repeat(40), new_head_ref_oid: dispatch.head_ref_oid, old_dispatch_id: null,
        action: "clear", approval_comment_id: "9001", approval_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-9001",
        approver_login: "x".repeat(4096), author_association: "OWNER", repository_permission: "write",
        created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z", last_edited_at: null,
        user_content_edits_count: 0, comment_body_sha256: "c".repeat(64) };
      const bytes = Buffer.from(`${JSON.stringify(member.reservation)}\n`);
      member.reservation_sha256 = hash(bytes); Object.assign(member.files[0], { sha256: hash(bytes), size: bytes.length });
    }
    writeFileSync(path.join(rootDir, ".cleanup-retirement.json"), `${JSON.stringify(plan)}\n`); const before = treeBytes(rootDir);
    assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: "dispatch-unrelated" }), { classification: "retirement_recovery_required" });
    await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: record("dispatch-pin-new") }), { classification: "retirement_recovery_required" });
    await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory }), { classification: "retirement_recovery_required" });
    assert.deepEqual(treeBytes(rootDir), before);
  }));
});
test("retirement pinned identity never overrides changed remaining files or diagnostic fences", async () => fixture(async (rootDir) => {
  const retired = record("dispatch-pin-damaged"); await helper.reserveDispatchRecord({ rootDir, record: retired });
  writeFileSync(path.join(rootDir, retired.dispatch_id, "usage-manifest.json"), "original companion"); age(rootDir, retired.dispatch_id);
  const interruption = new Error("identity removed");
  await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory,
    retirementCheckpoint: (name, detail) => { if (name === "member-fsynced" && detail.name === "dispatch.json") throw interruption; } }),
  (error) => error === interruption);
  assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: retired.dispatch_id }), (error) => {
    assert.equal(error.classification, "dispatch_evidence_retiring");
    assert.match(error.message, /cleanupOwnedControlEvidence\(\{ rootDir \}\)/);
    assert.match(error.message, /\.devpro\/scripts\/hooks\/lib\/second-review-control-evidence\.mjs/);
    assert.match(error.message, /Preserve the pending marker and required ancestors/);
    assert.doesNotMatch(error.message, /fresh review may|omit previous_dispatch_id/);
    return true;
  });
  const companion = path.join(rootDir, retired.dispatch_id, "usage-manifest.json"), original = readFileSync(companion);
  writeFileSync(companion, "changed companion"); const before = treeBytes(rootDir);
  await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: record("dispatch-pin-unrelated") }), { classification: "retirement_recovery_required" });
  await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory }), { classification: "retirement_recovery_required" });
  assert.deepEqual(treeBytes(rootDir), before);
  writeFileSync(companion, original);
  await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
  assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
}));
test("retirement committed members fence raw, strict and writers while unrelated chain remains usable", async () => fixture(async (rootDir) => {
  const retired = record("dispatch-retired"), unrelated = record("dispatch-unrelated");
  await helper.reserveDispatchRecord({ rootDir, record: retired });
  await helper.reserveDispatchRecord({ rootDir, record: unrelated });
  manifest(rootDir, [retired.dispatch_id]);
  for (const reader of [helper.readDispatchEvidence, helper.readDispatchEvidenceStrict]) {
    assert.throws(() => reader({ rootDir, dispatchId: retired.dispatch_id }), { classification: "dispatch_evidence_retiring" });
    assert.equal(reader({ rootDir, dispatchId: unrelated.dispatch_id }).dispatch.dispatch_id, unrelated.dispatch_id);
  }
  await assert.rejects(helper.claimDispatchInvocation({ rootDir, record: retired }), { classification: "dispatch_evidence_retiring" });
  await helper.claimDispatchInvocation({ rootDir, record: unrelated });
  await assert.rejects(helper.reserveDispatchRecord({ rootDir, record: record("dispatch-next", retired.dispatch_id) }),
    { classification: "dispatch_evidence_retiring" });
}));
test("retirement corrupted authority blocks entire root and recovery keeps unknown inventory", async () => fixture(async (rootDir) => {
  const dispatch = record("dispatch-corrupt");
  await helper.reserveDispatchRecord({ rootDir, record: dispatch });
  manifest(rootDir, [dispatch.dispatch_id]);
  writeFileSync(path.join(rootDir, dispatch.dispatch_id, "unknown.json"), "unknown");
  await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory }), { classification: "retirement_recovery_required" });
  assert.ok(existsSync(path.join(rootDir, ".cleanup-retirement.json")));
  writeFileSync(path.join(rootDir, ".cleanup-retirement.json"), "{");
  assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }), { classification: "retirement_recovery_required" });
}));
test("retirement zero budget mutates nothing; maxCleanup resumes immutable plan with missing files", async () => fixture(async (rootDir) => {
  const first = record("dispatch-plan-a"), next = record("dispatch-plan-b", first.dispatch_id);
  await helper.reserveDispatchRecord({ rootDir, record: first });
  await helper.reserveDispatchRecord({ rootDir, record: next });
  age(rootDir, first.dispatch_id); age(rootDir, next.dispatch_id);
  const before = readdirSync(rootDir).sort();
  await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, budgetMs: 0 });
  assert.deepEqual(readdirSync(rootDir).sort(), before);
  const run = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxCleanup: 1 });
  assert.equal(run.cleanedDirectories, 1);
  assert.ok(existsSync(path.join(rootDir, ".cleanup-retirement.json")));
  const planBytes = readFileSync(path.join(rootDir, ".cleanup-retirement.json"));
  assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: next.dispatch_id }), { classification: "dispatch_evidence_retiring" });
  const resumed = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxCleanup: 1 });
  assert.equal(resumed.cleanedDirectories, 1);
  assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
  assert.ok(planBytes.length > 0);
}));

test("retirement exhausted positive budget persists fair seed progress past a permanent fault", async () => fixture(async (rootDir) => {
  const fault = record("dispatch-budget-00-fault");
  await helper.reserveDispatchRecord({ rootDir, record: fault });
  await helper.writeFaultCapsule({ rootDir, record: { ...fault, schema: helper.FAULT_CAPSULE_SCHEMA,
    classification: "reviewer_orchestration_unknown", redacted_excerpt: "permanent unconsumed fault" } });
  age(rootDir, fault.dispatch_id);
  const orphanIds = [];
  for (let index = 1; index <= 20; index += 1) {
    const orphan = { ...record(`dispatch-budget-${String(index).padStart(2, "0")}-orphan`), pr_number: String(1658 + index) };
    await helper.reserveDispatchRecord({ rootDir, record: orphan });
    age(rootDir, orphan.dispatch_id); orphanIds.push(orphan.dispatch_id);
  }
  const ownerNow = Date.now(), faultBytes = treeBytes(path.join(rootDir, fault.dispatch_id));
  const run = (budgetMs) => {
    const originalNow = Date.now;
    let reads = 0;
    // The deadline gets the first value; every later budget check is expired.
    // No wall-clock speed, sleeps or filesystem timing determines the result.
    Date.now = () => ownerNow + (reads++ === 0 ? 0 : 2);
    try { return helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, now: ownerNow, budgetMs }); }
    finally { Date.now = originalNow; }
};
  const untouched = treeBytes(rootDir);
  await run(0);
  assert.deepEqual(treeBytes(rootDir), untouched, "zero budget must not create a cursor, lock or plan");
  const first = await run(1);
  assert.equal(first.inspected, 1);
  assert.equal(first.scan_start_index, 0);
  assert.equal(first.last_cleanup_attempted_id, fault.dispatch_id);
  assert.equal(first.results.find((row) => row.dispatchId === fault.dispatch_id).reason, "unconsumed");
  assert.equal(first.cleanedDirectories, 0);
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, ".cleanup-scan-cursor.json"), "utf8")).next_index, 1,
    "an attempted retained seed must advance even after admission exhausted the positive budget");
  const authority = path.join(rootDir, ".cleanup-retirement.json");
  let cleaned = 0, sawPendingPlan = false;
  for (let round = 0; round < orphanIds.length * 6 + 4
    && (orphanIds.some((id) => existsSync(path.join(rootDir, id))) || existsSync(authority)); round += 1) {
    const pinnedPlan = existsSync(authority) ? readFileSync(authority) : null;
    cleaned += (await run(1)).cleanedDirectories;
    if (existsSync(authority)) {
      sawPendingPlan = true;
      if (pinnedPlan) assert.deepEqual(readFileSync(authority), pinnedPlan, "positive-budget recovery must keep the immutable plan");
    }
    assert.deepEqual(treeBytes(path.join(rootDir, fault.dispatch_id)), faultBytes, "every round preserves the live fault byte-for-byte");
  }
  assert.equal(cleaned, 20, "repeated positive invocations reclaim every unrelated eligible orphan");
  assert.equal(sawPendingPlan, true, "exhausted admission must leave a plan for bounded recovery");
  for (const id of orphanIds) assert.equal(existsSync(path.join(rootDir, id)), false, id);
  assert.equal(existsSync(authority), false);
  assert.deepEqual(treeBytes(path.join(rootDir, fault.dispatch_id)), faultBytes);
}));

test("retirement usage writer rejects member and corrupt authority before any directory or file mutation", async (t) => {
  for (const mode of ["new-manifest", "rewrite-manifest", "recreate-deleted-directory", "corrupt-authority"]) {
    await t.test(mode, async () => fixture(async (rootDir) => {
      const first = record("dispatch-usage-a"), second = record("dispatch-usage-b", first.dispatch_id);
      await helper.reserveDispatchRecord({ rootDir, record: first });
      await helper.reserveDispatchRecord({ rootDir, record: second });
      if (mode === "rewrite-manifest") writeUsageManifest({ rootDir, manifest: usageManifest(second.dispatch_id) });
      age(rootDir, first.dispatch_id); age(rootDir, second.dispatch_id);
      const committed = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxCleanup: 1 });
      assert.equal(committed.cleanedDirectories, 1);
      assert.equal(existsSync(path.join(rootDir, first.dispatch_id)), false);
      const authority = path.join(rootDir, ".cleanup-retirement.json"), authorityBytes = readFileSync(authority);
      if (mode === "corrupt-authority") writeFileSync(authority, "{");
      const before = treeBytes(rootDir);
      const target = mode === "recreate-deleted-directory" ? first.dispatch_id : second.dispatch_id;
      let blocked;
      try { writeUsageManifest({ rootDir, manifest: { ...usageManifest(target), recorded_at: "2026-10-08T00:00:00.000Z" } }); }
      catch (error) { blocked = error; }
      assert.deepEqual(treeBytes(rootDir), before, "usage writer must preserve all authority, member and retention bytes");
      assert.equal(blocked?.classification, mode === "corrupt-authority" ? "retirement_recovery_required" : "dispatch_evidence_retiring");
      if (mode === "corrupt-authority") writeFileSync(authority, authorityBytes);
      const resumed = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
      assert.equal(resumed.cleanedDirectories, 1);
      assert.equal(existsSync(path.join(rootDir, first.dispatch_id)), false);
      assert.equal(existsSync(path.join(rootDir, second.dispatch_id)), false);
      assert.equal(existsSync(authority), false);
      if (mode === "rewrite-manifest") assert.ok(readUsageManifest({ rootDir, dispatchId: second.dispatch_id }), "existing retained usage survives owner reclaim");
    }));
  }
});

test("retirement usage writer preserves unrelated manifests and owner recovery", async () => fixture(async (rootDir) => {
  const first = record("dispatch-usage-a"), second = record("dispatch-usage-b", first.dispatch_id);
  await helper.reserveDispatchRecord({ rootDir, record: first }); await helper.reserveDispatchRecord({ rootDir, record: second });
  age(rootDir, first.dispatch_id); age(rootDir, second.dispatch_id);
  await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxCleanup: 1 });
  const authority = path.join(rootDir, ".cleanup-retirement.json"), bytes = readFileSync(authority);
  const unrelated = usageManifest("dispatch-usage-unrelated");
  writeUsageManifest({ rootDir, manifest: unrelated });
  assert.deepEqual(readUsageManifest({ rootDir, dispatchId: unrelated.dispatch_id }), unrelated);
  assert.deepEqual(readFileSync(authority), bytes);
  assert.equal((await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory })).cleanedDirectories, 1);
  assert.equal(existsSync(authority), false);
  assert.deepEqual(readUsageManifest({ rootDir, dispatchId: unrelated.dispatch_id }), unrelated);
}));

// These callbacks are deterministic test barriers inside the real capacity critical section.
// Child exit skips JS finally blocks; the next owner must recover the dead PID lock.
const helperUrl = new URL("../hooks/lib/second-review-control-evidence.mjs", import.meta.url).href;
const checkpoints = ["manifest-temp-written", "manifest-temp-fsynced", "manifest-linked", "manifest-root-fsynced",
  "manifest-published", "file-unlinked", "member-fsynced", "directory-removed", "root-fsynced",
  "manifest-unlinked", "manifest-removal-fsynced"];
function ageDeadLock(root) {
  const lock = path.join(root, ".capacity-lock");
  if (existsSync(lock)) {
    const file = path.join(lock, "owner.json"), owner = JSON.parse(readFileSync(file));
    owner.created_at = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(file, `${JSON.stringify(owner)}\n`);
  }
}
function launch(source, args = []) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
    env: { ...process.env, DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(args[0] ?? "", ".markers") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed, output: () => stdout };
}
function barrier(process, name) {
  if (process.output().includes(name)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`barrier missing: ${name}`)), 15_000);
    const onData = () => { if (process.output().includes(name)) { clearTimeout(timer); process.child.stdout.off("data", onData); resolve(); } };
    process.child.stdout.on("data", onData);
    process.closed.then((result) => { if (!process.output().includes(name)) { clearTimeout(timer); reject(new Error(`early child close ${JSON.stringify(result)}`)); } });
  });
}
const childPrelude = `import * as helper from ${JSON.stringify(helperUrl)};
import { readSync, writeSync } from 'node:fs';
const rootDir = process.argv[1];
const pause = (name) => { writeSync(1, name + '\\n'); readSync(0, Buffer.alloc(1), 0, 1, null); };`;

test("retirement every durable checkpoint survives actual process interruption and resumes exact plan", async () => {
  for (const checkpoint of checkpoints) await fixture(async (rootDir) => {
    const first = record("dispatch-crash-a"), second = record("dispatch-crash-b", first.dispatch_id);
    await helper.reserveDispatchRecord({ rootDir, record: first });
    await helper.reserveDispatchRecord({ rootDir, record: second });
    age(rootDir, first.dispatch_id); age(rootDir, second.dispatch_id);
    const crashed = launch(`${childPrelude}
      await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory: () => [],
        retirementCheckpoint: (name) => { if (name === process.argv[2]) process.exit(77); } });`, [rootDir, checkpoint]);
    const crash = await crashed.closed;
    assert.equal(crash.code, 77, `${checkpoint}: ${crash.stderr}`);
    ageDeadLock(rootDir);
    const authority = path.join(rootDir, ".cleanup-retirement.json");
    const bytes = existsSync(authority) ? readFileSync(authority) : null;
    if (bytes) {
      const plan = JSON.parse(bytes);
      for (const member of plan.members) {
        assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: member.dispatch_id }),
          { classification: "dispatch_evidence_retiring" }, checkpoint);
      }
    } else if (checkpoint.startsWith("manifest-temp-")) {
      assert.ok(existsSync(path.join(rootDir, first.dispatch_id, "dispatch.json")), "temp is not deletion authority");
      assert.ok(existsSync(path.join(rootDir, second.dispatch_id, "dispatch.json")));
    }
    let seenPlan;
    await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory,
      retirementCheckpoint: () => { if (bytes && existsSync(authority)) {
        seenPlan = readFileSync(authority); assert.deepEqual(seenPlan, bytes, checkpoint);
      } } });
    assert.equal(existsSync(path.join(rootDir, first.dispatch_id)), false, checkpoint);
    assert.equal(existsSync(path.join(rootDir, second.dispatch_id)), false, checkpoint);
    assert.equal(existsSync(authority), false, checkpoint);
  });
});

test("retirement reserve-first and cleanup-first are deterministic capacity-lock process orderings", async () => {
  for (const ordering of ["reserve-first", "retire-first"]) await fixture(async (rootDir) => {
    const prior = record("dispatch-order-prior"), next = record("dispatch-order-next", prior.dispatch_id);
    await helper.reserveDispatchRecord({ rootDir, record: prior }); age(rootDir, prior.dispatch_id);
    if (ordering === "reserve-first") {
      const reservation = launch(`${childPrelude}
        helper.withDispatchEvidenceSnapshot({ rootDir }, () => {
          // reserveDispatchRecord is async only at its public boundary; its critical section is synchronous.
          const reserved = helper.reserveDispatchRecord({ rootDir, record: ${JSON.stringify(next)} });
          pause('reserved');
        });`, [rootDir]);
      await barrier(reservation, "reserved");
      const cleanup = launch(`${childPrelude}
        writeSync(1, 'cleanup-started\\n');
        const result = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory: () => [] });
        writeSync(1, JSON.stringify(result));`, [rootDir]);
      await barrier(cleanup, "cleanup-started");
      assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
      reservation.child.stdin.write("x");
      assert.equal((await reservation.closed).code, 0);
      const cleaned = await cleanup.closed;
      assert.equal(cleaned.code, 0, cleaned.stderr);
      assert.ok(existsSync(path.join(rootDir, prior.dispatch_id, "dispatch.json")));
      assert.ok(existsSync(path.join(rootDir, next.dispatch_id, "dispatch.json")));
    } else {
      const cleanup = launch(`${childPrelude}
        await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory: () => [],
          retirementCheckpoint: (name) => { if (name === 'manifest-published') pause('retired'); } });`, [rootDir]);
      await barrier(cleanup, "retired");
      const reservation = launch(`${childPrelude}
        writeSync(1, 'reservation-started\\n');
        try { await helper.reserveDispatchRecord({ rootDir, record: ${JSON.stringify(next)} }); process.exit(9); }
        catch (error) { writeSync(1, error.classification + ':' + error.message); }`, [rootDir]);
      await barrier(reservation, "reservation-started");
      cleanup.child.stdin.write("x");
      assert.equal((await cleanup.closed).code, 0);
      const reserved = await reservation.closed;
      assert.equal(reserved.code, 0, reserved.stderr);
      assert.match(reserved.stdout, /^reservation-started\nreviewer_dispatch_identity_collision:predecessor_reservation_missing:/);
      assert.equal(existsSync(path.join(rootDir, next.dispatch_id)), false);
    }
  });
});

test("retirement gate lineage snapshot holds current and ancestors against concurrent cleanup", async () => fixture(async (rootDir) => {
  const first = record("dispatch-snapshot-a"), second = record("dispatch-snapshot-b", first.dispatch_id);
  await helper.reserveDispatchRecord({ rootDir, record: first }); await helper.reserveDispatchRecord({ rootDir, record: second });
  age(rootDir, first.dispatch_id); age(rootDir, second.dispatch_id);
  const gate = launch(`${childPrelude}
    helper.withDispatchEvidenceSnapshot({ rootDir }, () => {
      helper.readDispatchEvidence({ rootDir, dispatchId: 'dispatch-snapshot-b' });
      pause('current-read');
      const ancestor = helper.readDispatchEvidence({ rootDir, dispatchId: 'dispatch-snapshot-a' });
      if (!ancestor.dispatch) process.exit(9);
      writeSync(1, 'complete-lineage\\n');
    });`, [rootDir]);
  await barrier(gate, "current-read");
  const cleanup = launch(`${childPrelude}
    writeSync(1, 'cleanup-started\\n');
    await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory: () => [] });`, [rootDir]);
  await barrier(cleanup, "cleanup-started");
  assert.ok(existsSync(path.join(rootDir, first.dispatch_id, "dispatch.json")));
  gate.child.stdin.write("x");
  const read = await gate.closed;
  assert.equal(read.code, 0, read.stderr); assert.match(read.stdout, /complete-lineage/);
  assert.equal((await cleanup.closed).code, 0);
  assert.equal(existsSync(path.join(rootDir, first.dispatch_id)), false);
  assert.equal(existsSync(path.join(rootDir, second.dispatch_id)), false);
}));

test("retirement changed, symlink and unknown recovery files preserve authority and all remaining files", async () => {
  for (const kind of ["changed", "symlink", "unknown", "directory"]) await fixture(async (rootDir) => {
    const dispatch = record("dispatch-damaged"); await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const plan = manifest(rootDir, [dispatch.dispatch_id]);
    const target = path.join(rootDir, dispatch.dispatch_id, "dispatch.json");
    if (kind === "changed") writeFileSync(target, "{}");
    if (kind === "symlink") { rmSync(target); symlinkSync(path.join(rootDir, ".cleanup-retirement.json"), target); }
    if (kind === "unknown") writeFileSync(path.join(rootDir, dispatch.dispatch_id, "unknown.json"), "{}");
    if (kind === "directory") mkdirSync(path.join(rootDir, dispatch.dispatch_id, "unexpected"));
    await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory }), { classification: "retirement_recovery_required" });
    assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, ".cleanup-retirement.json"))), plan);
    assert.ok(existsSync(target));
  });
});

test("retirement malformed, oversized, root-mismatched and identity-mismatched authority fails closed", async () => {
  for (const kind of ["root", "digest", "extra", "unsorted", "oversized", "symlink", "id", "members-bound", "files-bound"]) await fixture(async (rootDir) => {
    const dispatch = record("dispatch-authority"); await helper.reserveDispatchRecord({ rootDir, record: dispatch });
    const plan = manifest(rootDir, [dispatch.dispatch_id]);
    const authority = path.join(rootDir, ".cleanup-retirement.json");
    if (kind === "root") plan.root_identity_sha256 = "f".repeat(64);
    if (kind === "digest") plan.members[0].reservation_sha256 = "0".repeat(64);
    if (kind === "extra") plan.extra = true;
    if (kind === "unsorted") plan.members.push(plan.members[0]);
    if (kind === "members-bound") plan.members = Array.from({ length: 513 }, () => plan.members[0]);
    if (kind === "files-bound") plan.members[0].files = Array.from({ length: 17 }, () => plan.members[0].files[0]);
    if (kind === "id") {
      const target = path.join(rootDir, dispatch.dispatch_id, "dispatch.json");
      const bytes = Buffer.from(`${JSON.stringify({ ...dispatch, dispatch_id: "dispatch-other" })}\n`);
      writeFileSync(target, bytes);
      plan.members[0].reservation_sha256 = hash(bytes);
      Object.assign(plan.members[0].files[0], { sha256: hash(bytes), size: bytes.length });
    }
    writeFileSync(authority, kind === "oversized" ? " ".repeat(16_777_217) : `${JSON.stringify(plan)}\n`);
    if (kind === "symlink") { const pinned = `${authority}.saved`; renameSync(authority, pinned); symlinkSync(pinned, authority); }
    if (kind !== "id") assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }), { classification: "retirement_recovery_required" }, kind);
    await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory }), { classification: "retirement_recovery_required" }, kind);
    assert.ok(existsSync(path.join(rootDir, dispatch.dispatch_id, "dispatch.json")), kind);
    assert.ok(existsSync(authority), kind);
  });
});

test("retirement snapshot rejects async callbacks and releases locks on throw", async () => fixture(async (rootDir) => {
  await helper.reserveDispatchRecord({ rootDir, record: record("dispatch-synchronous") });
  assert.throws(() => helper.withDispatchEvidenceSnapshot({ rootDir }, async () => {}), /synchronous callback/);
  assert.throws(() => helper.withDispatchEvidenceSnapshot({ rootDir }, () => { throw new Error("callback fault"); }), /callback fault/);
  assert.equal(existsSync(path.join(rootDir, ".capacity-lock")), false);
  assert.equal(helper.readDispatchEvidence({ rootDir, dispatchId: "dispatch-synchronous" }).dispatch.dispatch_id, "dispatch-synchronous");
}));

test("retirement transitive and branched incoming successors protect the entire weak component", async () => fixture(async (rootDir) => {
  const first = record("dispatch-graph-a"), middle = record("dispatch-graph-b", first.dispatch_id),
    leaf = record("dispatch-graph-c", middle.dispatch_id), branch = record("dispatch-graph-d", first.dispatch_id);
  for (const dispatch of [first, middle, leaf, branch]) await helper.reserveDispatchRecord({ rootDir, record: dispatch });
  for (const dispatch of [first, middle, leaf]) age(rootDir, dispatch.dispatch_id);
  const retained = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxInspect: 1 });
  assert.equal(retained.cleanedDirectories, 0);
  for (const dispatch of [first, middle, leaf, branch]) assert.ok(existsSync(path.join(rootDir, dispatch.dispatch_id, "dispatch.json")));
  assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
  const standalone = await helper.cleanupDispatchEvidence({ rootDir, dispatchId: first.dispatch_id, markerInventory });
  assert.equal(standalone.reason, "owner-ttl");
  age(rootDir, branch.dispatch_id);
  assert.equal((await helper.cleanupDispatchEvidence({ rootDir, dispatchId: middle.dispatch_id, markerInventory })).reason, "owner-component-cleanup-required");
  const cleaned = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxInspect: 1 });
  assert.equal(cleaned.cleanedDirectories, 4, "one selected seed must include incoming/outgoing/transitive neighbors");
}));

test("retirement live marker supplier is reread under capacity lock and caller empty list cannot override it", async () => fixture(async (rootDir) => {
  const first = record("dispatch-marker-a"), next = record("dispatch-marker-b", first.dispatch_id);
  await helper.reserveDispatchRecord({ rootDir, record: first }); await helper.reserveDispatchRecord({ rootDir, record: next });
  age(rootDir, first.dispatch_id); age(rootDir, next.dispatch_id);
  let called = 0;
  const live = () => {
    called += 1; assert.ok(existsSync(path.join(rootDir, ".capacity-lock", "owner.json")));
    return [{ repository_slug: next.repository_slug, prNumber: next.pr_number, head_ref_oid: next.head_ref_oid, expected_dispatch_id: next.dispatch_id }];
  };
  assert.equal((await helper.cleanupOwnedControlEvidence({ rootDir, activeMarkers: [], markerInventory: live })).cleanedDirectories, 0);
  assert.equal(called, 1);
  assert.equal((await helper.cleanupDispatchEvidence({ rootDir, dispatchId: first.dispatch_id, markerInventory: live })).reason, "marker-present");
  assert.equal(called, 2);
  for (const dispatch of [first, next]) assert.ok(existsSync(path.join(rootDir, dispatch.dispatch_id, "dispatch.json")));
  const unbound = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory: () => [{ marker_unreadable: true }] });
  assert.equal(unbound.results[0].reason, "incomplete-evidence");
  assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
}));

test("retirement missing, cyclic, unknown and over-bound neighboring inventory prohibits plans", async () => {
  for (const kind of ["missing", "cycle", "unknown", "repository-bound", "lineage-bound"]) await fixture(async (rootDir) => {
    const first = record("dispatch-invalid-a"); await helper.reserveDispatchRecord({ rootDir, record: first }); age(rootDir, first.dispatch_id);
    if (kind === "missing" || kind === "cycle") {
      const broken = record("dispatch-invalid-b", kind === "missing" ? "dispatch-absent" : "dispatch-invalid-b");
      mkdirSync(path.join(rootDir, broken.dispatch_id));
      writeFileSync(path.join(rootDir, broken.dispatch_id, "dispatch.json"), `${JSON.stringify(broken)}\n`);
    }
    if (kind === "unknown") writeFileSync(path.join(rootDir, first.dispatch_id, "unknown.json"), "{}");
    if (kind === "repository-bound") for (let index = 0; index < 512; index += 1) mkdirSync(path.join(rootDir, `dispatch-bound-${index}`));
    if (kind === "lineage-bound") {
      let previous = first.dispatch_id;
      for (let index = 0; index < 256; index += 1) {
        const dispatch = record(`dispatch-depth-${String(index).padStart(3, "0")}`, previous);
        mkdirSync(path.join(rootDir, dispatch.dispatch_id));
        writeFileSync(path.join(rootDir, dispatch.dispatch_id, "dispatch.json"), `${JSON.stringify(dispatch)}\n`); age(rootDir, dispatch.dispatch_id);
        previous = dispatch.dispatch_id;
      }
    }
    if (kind === "repository-bound") await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory }), { classification: "reviewer_dispatch_capacity_exceeded" });
    else {
      const result = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
      assert.equal(result.cleanedDirectories, 0, kind); assert.equal(result.results[0].reason, "incomplete-evidence", kind);
    }
    assert.ok(existsSync(path.join(rootDir, first.dispatch_id, "dispatch.json")), kind);
    assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false, kind);
  });
});

test("retirement repository maximum inventory remains bounded and can reclaim a selected seed", async () => fixture(async (rootDir) => {
  for (let index = 0; index < helper.MAX_DISPATCHES_PER_REPOSITORY; index += 1) {
    const dispatch = { ...record(`dispatch-maximum-${String(index).padStart(3, "0")}`), pr_number: String(2000 + index) };
    mkdirSync(path.join(rootDir, dispatch.dispatch_id));
    writeFileSync(path.join(rootDir, dispatch.dispatch_id, "dispatch.json"), `${JSON.stringify(dispatch)}\n`); age(rootDir, dispatch.dispatch_id);
  }
  const result = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxInspect: 1, maxCleanup: 1 });
  assert.equal(result.scanned, 512); assert.equal(result.cleanedDirectories, 1);
  assert.equal(readdirSync(rootDir).filter((name) => name.startsWith("dispatch-")).length, 511);
}));

test("retirement fences every lifecycle writer and rollback before artifacts change", async () => fixture(async (rootDir) => {
  const retired = record("dispatch-writer-fence"), other = record("dispatch-writer-other");
  await helper.reserveDispatchRecord({ rootDir, record: retired }); await helper.reserveDispatchRecord({ rootDir, record: other });
  const authority = manifest(rootDir, [retired.dispatch_id]);
  const actions = [
    () => helper.claimDispatchInvocation({ rootDir, record: retired }),
    () => helper.writeCompletionReceipt({ rootDir, record: retired }),
    () => helper.writeTerminalReceipt({ rootDir, record: retired }),
    () => helper.writeFaultCapsule({ rootDir, record: { ...retired, schema: helper.FAULT_CAPSULE_SCHEMA, classification: "reviewer_orchestration_unknown" } }),
    () => helper.writeConsumptionReceipt({ rootDir, record: retired }),
    () => helper.writeReviewerModelRecord({ rootDir, record: retired }),
    () => helper.writeExternalClosureSlot({ rootDir, dispatchId: retired.dispatch_id, kind: "voided" }),
    () => helper.writeExternalCompletionReceipt({ rootDir, dispatchId: retired.dispatch_id }),
    () => helper.writeExternalVoidTerminalReceipt({ rootDir, dispatchId: retired.dispatch_id }),
    () => helper.writeSupersessionReceipt({ rootDir, faultDispatchId: other.dispatch_id, record: { verified_dispatch_id: retired.dispatch_id } }),
    () => helper.writeSupersessionReceipt({ rootDir, faultDispatchId: retired.dispatch_id, record: { verified_dispatch_id: other.dispatch_id } }),
  ];
  for (const action of actions) await assert.rejects(action(), { classification: "dispatch_evidence_retiring" });
  for (const action of [
    () => helper.rollbackUnclaimedDispatchReservation({ rootDir, record: retired }),
    () => helper.writeLineageApprovalTransactionAbort({ rootDir, record: retired }),
    () => helper.dispatchEvidenceNeverStarted({ rootDir, dispatchId: retired.dispatch_id }),
    () => helper.verifyDispatchReservation({ rootDir, record: retired }),
    () => helper.verifySecondReviewDispatchIdentity({ rootDir, record: retired }),
  ]) assert.throws(action, { classification: "dispatch_evidence_retiring" });
  assert.deepEqual(readdirSync(path.join(rootDir, retired.dispatch_id)), ["dispatch.json"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, ".cleanup-retirement.json"))), authority);
  // A valid unrelated reservation remains possible while visible retirement members still count against capacity.
  const fresh = record("dispatch-writer-fresh"); await helper.reserveDispatchRecord({ rootDir, record: fresh });
  assert.equal(helper.readDispatchEvidence({ rootDir, dispatchId: fresh.dispatch_id }).dispatch.dispatch_id, fresh.dispatch_id);
}));

test("retirement fresh member protects supersession cycle; eligible cycle resumes across maxCleanup and maxInspect zero", async () => fixture(async (rootDir) => {
  const fault = record("dispatch-cycle-a"), verified = record("dispatch-cycle-b", fault.dispatch_id);
  await helper.reserveDispatchRecord({ rootDir, record: fault }); await helper.claimDispatchInvocation({ rootDir, record: fault });
  const capsule = await helper.writeFaultCapsule({ rootDir, record: { ...fault, schema: helper.FAULT_CAPSULE_SCHEMA,
    classification: "reviewer_orchestration_unknown", redacted_excerpt: "bounded fixture" } });
  const consumption = await helper.writeConsumptionReceipt({ rootDir, record: { ...fault, schema: helper.FAULT_CONSUMPTION_SCHEMA,
    outcome: "blocked_orchestration_fault", capsule_integrity_id: capsule.record.integrity_id } });
  await helper.reserveDispatchRecord({ rootDir, record: verified }); await helper.claimDispatchInvocation({ rootDir, record: verified });
  await helper.writeCompletionReceipt({ rootDir, record: { ...verified, schema: helper.COMPLETION_SCHEMA,
    outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified", sticky_verdict: "WARN",
    sticky_last_reviewed_sha: verified.head_ref_oid, sticky_dispatch_id: verified.dispatch_id,
    sticky_comment_id: 4242, sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242", process_close_observed: true } });
  await helper.writeSupersessionReceipt({ rootDir, faultDispatchId: fault.dispatch_id, record: { ...verified,
    schema: helper.FAULT_SUPERSESSION_SCHEMA, fault_dispatch_id: fault.dispatch_id, verified_dispatch_id: verified.dispatch_id,
    outcome: `superseded_by_verified_dispatch:${verified.dispatch_id}`, consumption_integrity_id: consumption.record.integrity_id } });
  age(rootDir, fault.dispatch_id);
  const protectedRun = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
  assert.equal(protectedRun.cleanedDirectories, 0);
  assert.ok(existsSync(path.join(rootDir, fault.dispatch_id, "consumption-receipt.json")));
  assert.ok(existsSync(path.join(rootDir, verified.dispatch_id, "dispatch.json")));
  age(rootDir, verified.dispatch_id);
  const first = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxInspect: 1, maxCleanup: 1 });
  assert.equal(first.cleanedDirectories, 1);
  const plan = JSON.parse(readFileSync(path.join(rootDir, ".cleanup-retirement.json")));
  assert.deepEqual(plan.members.map((member) => member.dispatch_id), [fault.dispatch_id, verified.dispatch_id]);
  assert.throws(() => helper.readDispatchEvidenceStrict({ rootDir, dispatchId: verified.dispatch_id }), { classification: "dispatch_evidence_retiring" });
  const next = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, maxInspect: 0, maxCleanup: 1 });
  assert.equal(next.cleanedDirectories, 1, "maxInspect limits new candidate selection, not already committed recovery");
  assert.equal(existsSync(path.join(rootDir, fault.dispatch_id)), false);
  assert.equal(existsSync(path.join(rootDir, verified.dispatch_id)), false);
  assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
}));

test("retirement capsule-only cleanup preserves own audit and superseded component TTL protections", async () => {
  for (const mode of ["own-audit", "own-ttl", "connected-ttl", "unsuperseded", "marker"]) await fixture(async (rootDir) => {
    const fault = record("dispatch-capsule-a"), verified = record("dispatch-capsule-b", fault.dispatch_id);
    if (mode === "own-audit") {
      const createdAt = new Date().toISOString();
      fault.lineage_approval_receipt_id = "9001";
      fault.lineage_approval_receipt = { schema: "devpro-second-review-lineage-approval/v1",
        repository_slug: fault.repository_slug, pr_number: fault.pr_number, source_state: "clear-obligation",
        old_head_ref_oid: "b".repeat(40), new_head_ref_oid: fault.head_ref_oid, old_dispatch_id: null,
        action: "clear", approval_comment_id: "9001",
        approval_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-9001",
        approver_login: "repo-owner", author_association: "OWNER", repository_permission: "write",
        created_at: createdAt, updated_at: createdAt, last_edited_at: null,
        user_content_edits_count: 0, comment_body_sha256: "c".repeat(64) };
    }
    await helper.reserveDispatchRecord({ rootDir, record: fault });
    const capsule = await helper.writeFaultCapsule({ rootDir, record: { ...fault, schema: helper.FAULT_CAPSULE_SCHEMA,
      classification: "reviewer_orchestration_unknown", redacted_excerpt: "retention regression" } });
    const consumption = await helper.writeConsumptionReceipt({ rootDir, record: { ...fault,
      schema: helper.FAULT_CONSUMPTION_SCHEMA, outcome: "blocked_orchestration_fault",
      capsule_integrity_id: capsule.record.integrity_id } });
    if (!["own-audit", "unsuperseded"].includes(mode)) {
      await helper.reserveDispatchRecord({ rootDir, record: verified });
      await helper.claimDispatchInvocation({ rootDir, record: verified });
      await helper.writeCompletionReceipt({ rootDir, record: { ...verified, schema: helper.COMPLETION_SCHEMA,
        outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified", sticky_verdict: "WARN",
        sticky_last_reviewed_sha: verified.head_ref_oid, sticky_dispatch_id: verified.dispatch_id,
        sticky_comment_id: 4242, sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242", process_close_observed: true } });
      await helper.writeSupersessionReceipt({ rootDir, faultDispatchId: fault.dispatch_id, record: { ...verified,
        schema: helper.FAULT_SUPERSESSION_SCHEMA, fault_dispatch_id: fault.dispatch_id, verified_dispatch_id: verified.dispatch_id,
        outcome: `superseded_by_verified_dispatch:${verified.dispatch_id}`, consumption_integrity_id: consumption.record.integrity_id } });
    }
    if (["connected-ttl", "marker"].includes(mode)) age(rootDir, fault.dispatch_id);
    const before = readFileSync(capsule.path);
    const activeMarkers = mode === "marker" ? [{ repository_slug: fault.repository_slug, prNumber: fault.pr_number,
      head_ref_oid: verified.head_ref_oid, expected_dispatch_id: verified.dispatch_id }] : [];
    const result = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory, activeMarkers });
    const row = result.results.find((item) => item.dispatchId === fault.dispatch_id);
    if (["unsuperseded", "marker"].includes(mode)) {
      assert.equal(result.cleanedCapsules, 1, mode);
      assert.equal(existsSync(capsule.path), false, mode);
    } else {
      assert.equal(result.cleanedCapsules, 0, mode);
      assert.equal(row.reason, mode === "own-audit" ? "lineage-approval-audit-retained" : "owner-ttl", mode);
      assert.deepEqual(readFileSync(capsule.path), before, mode);
    }
    assert.equal(result.cleanedDirectories, 0, mode);
    assert.ok(existsSync(consumption.path), mode);
    assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false, mode);
  });
});

test("retirement late unbound live marker before commit is reread without marker lock inversion", async () => fixture(async (rootDir) => {
  const dispatch = record("dispatch-marker-arrival"); await helper.reserveDispatchRecord({ rootDir, record: dispatch }); age(rootDir, dispatch.dispatch_id);
  const cleanup = launch(`${childPrelude}
    await helper.cleanupOwnedControlEvidence({ rootDir,
      retirementCheckpoint: (name) => { if (name === 'admission-before-marker-read') pause('admission'); } });`, [rootDir]);
  await barrier(cleanup, "admission");
  const markerDir = path.join(rootDir, ".markers"); mkdirSync(markerDir);
  const markerFile = path.join(markerDir, "pending-post-pr-completion-1658.json");
  writeFileSync(markerFile, JSON.stringify({ prNumber: "1658", repository_slug: "devpro/example", expected_dispatch_id: "", head_ref_oid: "" }));
  cleanup.child.stdin.write("x");
  const completed = await cleanup.closed; assert.equal(completed.code, 0, completed.stderr);
  assert.ok(existsSync(path.join(rootDir, dispatch.dispatch_id, "dispatch.json")));
  assert.equal(existsSync(path.join(rootDir, ".cleanup-retirement.json")), false);
  assert.ok(existsSync(markerFile));
}));

test("retirement authority bytes are pinned through each recovery chunk", async () => fixture(async (rootDir) => {
  const dispatch = record("dispatch-authority-change"); await helper.reserveDispatchRecord({ rootDir, record: dispatch });
  age(rootDir, dispatch.dispatch_id);
  const companion = path.join(rootDir, dispatch.dispatch_id, "usage-manifest.json");
  writeFileSync(companion, "{}"); age(rootDir, dispatch.dispatch_id);
  let changed = false;
  await assert.rejects(helper.cleanupOwnedControlEvidence({ rootDir, markerInventory,
    retirementCheckpoint: (name) => {
      if (!changed && name === "member-fsynced") {
        changed = true; writeFileSync(path.join(rootDir, ".cleanup-retirement.json"), "{");
      }
    } }), { classification: "retirement_recovery_required" });
  assert.equal(changed, true);
  assert.ok(existsSync(companion), "corrupt authority must stop before the next file deletion");
  assert.equal(readFileSync(path.join(rootDir, ".cleanup-retirement.json"), "utf8"), "{");
  assert.throws(() => helper.readDispatchEvidence({ rootDir, dispatchId: dispatch.dispatch_id }), { classification: "retirement_recovery_required" });
}));

test("retirement retains the existing unsuperseded-fault successful-scope predicate without protecting unrelated orphans", async () => fixture(async (rootDir) => {
  const fault = record("dispatch-scope-fault"), completed = { ...fault, dispatch_id: "dispatch-scope-completed" },
    orphan = { ...fault, dispatch_id: "dispatch-scope-orphan" };
  for (const dispatch of [fault, completed, orphan]) await helper.reserveDispatchRecord({ rootDir, record: dispatch });
  await helper.claimDispatchInvocation({ rootDir, record: fault });
  await helper.writeFaultCapsule({ rootDir, record: { ...fault, schema: helper.FAULT_CAPSULE_SCHEMA,
    classification: "reviewer_orchestration_unknown" } });
  await helper.claimDispatchInvocation({ rootDir, record: completed });
  await helper.writeCompletionReceipt({ rootDir, record: { ...completed, schema: helper.COMPLETION_SCHEMA,
    outcome: "reviewer_process_closed_and_sticky_verified", classification: "sticky_verified", sticky_verdict: "PASS",
    sticky_last_reviewed_sha: completed.head_ref_oid, sticky_dispatch_id: completed.dispatch_id,
    sticky_comment_id: 4242, sticky_comment_url: "https://github.com/devpro/example/pull/1658#issuecomment-4242", process_close_observed: true } });
  for (const dispatch of [fault, completed, orphan]) age(rootDir, dispatch.dispatch_id);
  const run = await helper.cleanupOwnedControlEvidence({ rootDir, markerInventory });
  assert.equal(run.cleanedDirectories, 1);
  assert.ok(existsSync(path.join(rootDir, fault.dispatch_id, "dispatch.json")));
  assert.ok(existsSync(path.join(rootDir, completed.dispatch_id, "dispatch.json")));
  assert.equal(existsSync(path.join(rootDir, orphan.dispatch_id)), false);
}));
